/**
 * src/brain/health-ai.js
 *
 * AI-assisted Wiki Health suggestions.
 *
 * This module is strictly READ-ONLY. It proposes fixes — never applies them.
 * Application is always routed through the existing /api/health/:domain/fix
 * endpoint (src/routes/health.js) + fixIssue() in src/brain/health.js, so the
 * AI layer cannot corrupt the wiki even if the LLM returns nonsense.
 *
 * Phase 1 (v2.4.3) — suggestBrokenLinkTarget(domain, issue)
 *   Given a broken [[wikilink]] that the algorithmic resolver could not match,
 *   show the LLM the source page's context + the domain's slug inventory and
 *   ask it to pick the most likely intended target (or say "no good target").
 *
 * Provider-agnostic: calls generateText() from llm.js, which dispatches to
 * whichever provider the user has configured (Gemini or Anthropic) with the
 * full fallback-chain safety net.
 */
import { readFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { jsonrepair } from 'jsonrepair';
import { wikiPath } from './files.js';
import { generateText, getProviderInfo, getModelPrice } from './llm.js';
import { findSemanticCandidatePairs, SEMANTIC_DUPE_DEFAULT_CAP, scanWiki } from './health.js';

// Excerpt window around the broken link — ~4 KB total (≈800 words). Large
// enough to give the model paragraph-level context, small enough that a
// hub page (tens of KB) doesn't explode the prompt.
const EXCERPT_BEFORE = 2000;
const EXCERPT_AFTER  = 2000;

/**
 * Parse a JSON response from the LLM, tolerating the common failure modes.
 * Mirrors parseJSON() in src/brain/ingest.js — intentionally duplicated so
 * this module has no cross-file private coupling.
 */
function parseJSON(raw) {
  try { return JSON.parse(raw); } catch {}
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch {}
  }
  const braceMatch = raw.match(/\{[\s\S]*\}/);
  const candidate = braceMatch ? braceMatch[0] : raw;
  if (braceMatch) {
    try { return JSON.parse(candidate); } catch {}
  }
  try { return JSON.parse(jsonrepair(candidate)); }
  catch (err) {
    throw new Error(`AI response was not valid JSON: ${err.message.slice(0, 120)}`);
  }
}

async function listSlugs(dir) {
  try {
    return (await readdir(dir))
      .filter(f => f.endsWith('.md'))
      .map(f => f.slice(0, -3));
  } catch { return []; }
}

/**
 * Extract ~4 KB of text around the first occurrence of the broken link.
 * Falls back to the start of the document if the link itself has already
 * been stripped (shouldn't happen, but be defensive).
 */
function extractExcerpt(content, linkText) {
  const needle = `[[${linkText}]]`;
  const idx = content.indexOf(needle);
  if (idx === -1) {
    return content.slice(0, EXCERPT_BEFORE + EXCERPT_AFTER);
  }
  const start = Math.max(0, idx - EXCERPT_BEFORE);
  const end   = Math.min(content.length, idx + needle.length + EXCERPT_AFTER);
  const prefix = start > 0 ? '…\n' : '';
  const suffix = end < content.length ? '\n…' : '';
  return prefix + content.slice(start, end) + suffix;
}

/**
 * Propose a target slug for a broken link using the LLM.
 *
 * @param {string} domain
 * @param {object} issue           — { sourceFile, linkText, suggestedTarget? }
 * @returns {Promise<{target: string|null, rationale: string, confidence: 'high'|'medium'|'low'}>}
 *
 * Guarantees:
 *   - `target`, if non-null, is a slug that exists on disk (entities/, concepts/,
 *     or summaries/ — summaries are returned as "summaries/<slug>").
 *   - If the LLM invents an unknown slug, it is coerced to `target: null` with
 *     `confidence: 'low'` and the rationale records the rejection.
 *   - If the LLM answers "no good target", `target` is null and the UI MUST
 *     NOT offer an Apply button (docs/ai-health.md).
 *   - No filesystem writes. Ever.
 */
export async function suggestBrokenLinkTarget(domain, issue) {
  if (!issue || !issue.sourceFile || !issue.linkText) {
    throw new Error('Invalid issue: sourceFile and linkText are required');
  }

  const wikiDir = wikiPath(domain);
  if (!existsSync(wikiDir)) {
    throw new Error(`No wiki found for domain: ${domain}`);
  }

  // Build the slug inventory — full list, no truncation. Even a 2000-page
  // domain adds only ~15 KB to the prompt (≈3–4k tokens on Flash Lite / Haiku).
  const [entitySlugs, conceptSlugs, summarySlugs] = await Promise.all([
    listSlugs(path.join(wikiDir, 'entities')),
    listSlugs(path.join(wikiDir, 'concepts')),
    listSlugs(path.join(wikiDir, 'summaries')),
  ]);

  // Deduplicated validity set — what the AI is allowed to return.
  const validTargets = new Set([
    ...entitySlugs,
    ...conceptSlugs,
    ...summarySlugs.map(s => `summaries/${s}`),
  ]);

  // Read source page for context excerpt
  const sourceFullPath = path.join(wikiDir, issue.sourceFile);
  if (!existsSync(sourceFullPath)) {
    throw new Error(`Source page not found: ${issue.sourceFile}`);
  }
  const sourceContent = await readFile(sourceFullPath, 'utf8');
  const excerpt = extractExcerpt(sourceContent, issue.linkText);

  const systemPrompt =
    `You are helping maintain a personal knowledge wiki. Your job is to identify ` +
    `the most likely intended target of a broken [[wikilink]], given the page's ` +
    `context and an inventory of known page slugs.\n\n` +
    `RULES:\n` +
    `1. The "target" field MUST be a slug that appears in the provided inventory, ` +
    `or null if no inventory entry is a good fit.\n` +
    `2. Entity/concept slugs are bare (e.g. "rag"). Summary slugs are prefixed ` +
    `with "summaries/" (e.g. "summaries/the-paper-title").\n` +
    `3. Do NOT invent new slugs. Do NOT suggest creating new pages — if nothing ` +
    `fits, return null and explain briefly in the rationale.\n` +
    `4. Set confidence honestly: "high" = clear semantic match from context; ` +
    `"medium" = plausible but ambiguous; "low" = weak signal or guess.\n` +
    `5. Respond with ONLY valid JSON. No markdown fences, no prose outside JSON.`;

  const inventoryBlock = [
    'ENTITIES:',
    entitySlugs.length ? entitySlugs.join(', ') : '(none)',
    '',
    'CONCEPTS:',
    conceptSlugs.length ? conceptSlugs.join(', ') : '(none)',
    '',
    'SUMMARIES:',
    summarySlugs.length ? summarySlugs.map(s => `summaries/${s}`).join(', ') : '(none)',
  ].join('\n');

  const userPrompt =
    `A broken wikilink [[${issue.linkText}]] was found in the source page ` +
    `"${issue.sourceFile}". Your task: pick the most likely intended target ` +
    `from the inventory below, or return null.\n\n` +
    `SOURCE PAGE EXCERPT (around the broken link):\n` +
    `----------------------------------------\n${excerpt}\n----------------------------------------\n\n` +
    `SLUG INVENTORY:\n` +
    `----------------------------------------\n${inventoryBlock}\n----------------------------------------\n\n` +
    `Respond as JSON:\n` +
    `{"target": "<slug-or-null>", "rationale": "<one short sentence>", ` +
    `"confidence": "high"|"medium"|"low"}`;

  const raw = await generateText(systemPrompt, userPrompt, 512, 'json');
  const parsed = parseJSON(raw);

  // Normalise shape
  let target = parsed.target;
  if (target === 'null' || target === '') target = null;
  const rationale = String(parsed.rationale || '').trim() || 'No rationale provided.';
  let confidence = String(parsed.confidence || 'low').toLowerCase();
  if (!['high', 'medium', 'low'].includes(confidence)) confidence = 'low';

  // Validate target exists — reject hallucinated slugs
  if (target) {
    const bare = target.startsWith('summaries/') ? target : target.replace(/^(entities|concepts)\//, '');
    const lookupKey = target.startsWith('summaries/') ? target : bare;
    if (!validTargets.has(lookupKey)) {
      return {
        target: null,
        rationale: `AI proposed "${target}" but no such page exists. Original rationale: ${rationale}`,
        confidence: 'low',
      };
    }
    // Canonicalise — strip entities/ or concepts/ folder prefix since links use bare slugs
    target = lookupKey;
  }

  return { target: target || null, rationale, confidence };
}

// ── Phase 2 (v2.4.4) — Orphan rescue ────────────────────────────────────────

const MAX_ORPHAN_CANDIDATES = 5;
const ORPHAN_DESCRIPTION_MAX = 140;

/**
 * Propose up to 5 existing pages that should link to an orphan.
 *
 * An orphan is an entity or concept page with zero incoming links. This
 * function asks the LLM, given the orphan's content and an inventory of
 * entity/concept slugs, which existing pages would naturally reference it.
 *
 * Design choices (see docs/ai-health.md § Orphan rescue for rationale):
 *   - Summaries are NEVER valid rescue targets — the wiki convention is that
 *     summaries reference entities during ingest, not the other way around.
 *     We intentionally omit summaries from the candidate inventory.
 *   - The orphan itself is excluded from its own candidate list (prevents
 *     self-reference hallucinations).
 *   - Candidate count is clamped to 5 regardless of what the LLM returns.
 *   - Each `description` is trimmed to 140 chars after the LLM returns.
 *
 * @param {string} domain
 * @param {object} issue    — { path, type, slug }  (one orphan row from scan)
 * @returns {Promise<{candidates: Array<{target, description, confidence, rationale}>}>}
 *
 * Guarantees:
 *   - Every `target` in the returned array is a slug that exists on disk in
 *     entities/ or concepts/ (never summaries/).
 *   - Hallucinated slugs are filtered out before the caller sees them.
 *   - No filesystem writes.
 */
export async function suggestOrphanHomes(domain, issue) {
  if (!issue || !issue.slug || !issue.path) {
    throw new Error('Invalid orphan issue: slug and path are required');
  }

  const wikiDir = wikiPath(domain);
  if (!existsSync(wikiDir)) {
    throw new Error(`No wiki found for domain: ${domain}`);
  }

  // Inventory — entities + concepts only (summaries intentionally excluded).
  const [entitySlugs, conceptSlugs] = await Promise.all([
    listSlugs(path.join(wikiDir, 'entities')),
    listSlugs(path.join(wikiDir, 'concepts')),
  ]);

  // Exclude the orphan itself from candidate eligibility
  const orphanSlug = issue.slug;
  const validTargets = new Set(
    [...entitySlugs, ...conceptSlugs].filter(s => s !== orphanSlug)
  );

  // Read orphan body (same 4 KB cap as broken-link excerpt — orphan pages
  // are usually short, so this rarely truncates)
  const orphanFullPath = path.join(wikiDir, issue.path);
  if (!existsSync(orphanFullPath)) {
    throw new Error(`Orphan page not found: ${issue.path}`);
  }
  const orphanContent = await readFile(orphanFullPath, 'utf8');
  const orphanExcerpt = orphanContent.length > (EXCERPT_BEFORE + EXCERPT_AFTER)
    ? orphanContent.slice(0, EXCERPT_BEFORE + EXCERPT_AFTER) + '\n…'
    : orphanContent;

  const systemPrompt =
    `You are helping maintain a personal knowledge wiki. Your job is to find ` +
    `existing pages that should reference an "orphan" page (a page with zero ` +
    `incoming wikilinks). You read the orphan's content plus an inventory of ` +
    `other page slugs, and suggest 1-5 pages that would naturally link to it.\n\n` +
    `RULES:\n` +
    `1. Each "target" MUST be a slug that appears in the provided inventory. ` +
    `Do NOT invent slugs.\n` +
    `2. Only propose pages that have a genuine conceptual relationship to the ` +
    `orphan — do not add weak or generic links.\n` +
    `3. Never suggest the orphan page itself as its own target.\n` +
    `4. For each suggestion, provide a short (max ~15 words) description that ` +
    `will become the bullet text. This should describe why the target page is ` +
    `related to the orphan, written from the target page's perspective.\n` +
    `5. Set confidence honestly: "high" = clear conceptual link from context; ` +
    `"medium" = reasonable association; "low" = speculative or weak signal.\n` +
    `6. Return 1-5 candidates max (fewer is fine; return an empty list if ` +
    `nothing genuinely fits).\n` +
    `7. Respond with ONLY valid JSON. No markdown fences, no prose outside JSON.`;

  const inventoryBlock = [
    'ENTITIES:',
    entitySlugs.length ? entitySlugs.filter(s => s !== orphanSlug).join(', ') : '(none)',
    '',
    'CONCEPTS:',
    conceptSlugs.length ? conceptSlugs.filter(s => s !== orphanSlug).join(', ') : '(none)',
  ].join('\n');

  const userPrompt =
    `ORPHAN PAGE: ${issue.path} (slug: "${orphanSlug}")\n\n` +
    `ORPHAN PAGE CONTENT:\n` +
    `----------------------------------------\n${orphanExcerpt}\n----------------------------------------\n\n` +
    `SLUG INVENTORY (entities + concepts only; summaries are NOT valid targets):\n` +
    `----------------------------------------\n${inventoryBlock}\n----------------------------------------\n\n` +
    `Propose 1-5 existing pages that should link TO this orphan. Respond as JSON:\n` +
    `{"candidates": [\n` +
    `  {"target": "<slug>", "description": "<≤15 words>", ` +
    `"confidence": "high"|"medium"|"low", "rationale": "<one short sentence>"},\n` +
    `  ...\n` +
    `]}`;

  const raw = await generateText(systemPrompt, userPrompt, 1024, 'json');
  const parsed = parseJSON(raw);

  const incoming = Array.isArray(parsed.candidates) ? parsed.candidates : [];
  const seen = new Set();
  const candidates = [];

  for (const c of incoming) {
    if (candidates.length >= MAX_ORPHAN_CANDIDATES) break;
    if (!c || typeof c !== 'object') continue;

    // Normalise target: strip any entities/ or concepts/ prefix the LLM may add
    let target = String(c.target || '').trim();
    if (!target) continue;
    target = target.replace(/^(entities|concepts)\//, '');

    if (target === orphanSlug) continue;          // self-reference guard
    if (!validTargets.has(target)) continue;      // hallucination guard
    if (seen.has(target)) continue;               // dedup
    seen.add(target);

    let description = String(c.description || '').replace(/\s+/g, ' ').trim();
    if (description.length > ORPHAN_DESCRIPTION_MAX) {
      description = description.slice(0, ORPHAN_DESCRIPTION_MAX - 1).trimEnd() + '…';
    }

    let confidence = String(c.confidence || 'low').toLowerCase();
    if (!['high', 'medium', 'low'].includes(confidence)) confidence = 'low';

    const rationale = String(c.rationale || '').trim() || 'No rationale provided.';

    candidates.push({ target, description, confidence, rationale });
  }

  return { candidates };
}

// ── Phase 3 (v2.4.5) — Semantic near-duplicate detection ────────────────────

const SEMANTIC_BATCH_SIZE = 20;
const FIRST_PARA_MAX = 500;     // per-page content sample sent to the LLM
const EST_TOKENS_PER_PAIR = 400; // rough input+output budget per pair in a batch

/**
 * USD cost for a call, priced from llm.js's `MODEL_PRICES_USD_PER_MTOK` via
 * its exported `getModelPrice()` accessor — the single authoritative price
 * table for the whole app (it also drives the fallback-chain cost-tier
 * comparison and carries an offline invariant that every DEFAULTS/
 * FALLBACK_CHAINS model id is priced).
 *
 * This module used to keep its OWN 3-entry copy here ("keeping them in-file
 * avoids a separate pricing table that drifts silently" — which is exactly
 * backwards: a second hand-maintained copy IS the drift). It had gone ~25%
 * stale on the Gemini default (0.075/0.30 vs the current 0.10/0.40) and had
 * no entry at all for any of the five FALLBACK_CHAINS rungs or for
 * claude-sonnet-4-5 — the model this project's own CLAUDE.md documents
 * opting into via `LLM_MODEL`. Any of those active models made
 * `estimateUsdCost` return `null`, which two of the four cost-readout call
 * sites in app.js render as `''` — an empty string, not even a "cost
 * unknown" placeholder. Importing the shared accessor fixes both the stale
 * numbers and the missing coverage in one move, and makes a second copy
 * structurally impossible to reintroduce by accident.
 *
 * @param {string} provider - unused; kept in the signature so this stays a
 *   drop-in replacement for the six existing call sites (all of which
 *   already have `provider` in scope from `getProviderInfo()`).
 */
function estimateUsdCost(provider, model, inputTokens, outputTokens) {
  const p = getModelPrice(model);
  if (!p) return null;
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

/**
 * Cluster of cost fields for a cost/estimate payload. `estimatedUsd` keeps
 * its exact pre-existing contract (`number|null`) so nothing that already
 * checks `!= null` breaks. `priceKnown`/`costNote` are ADDITIVE — a consumer
 * that wants to show an honest "cost estimate unavailable" message instead
 * of silently rendering nothing can key off `priceKnown === false` without
 * this module changing what `estimatedUsd` means.
 *
 * `costNote` IS the wired-up signal. Both frontends' cost-readout helpers
 * (`formatHealthCost` in src/public/app.js, `costReadout` in
 * src/public/next/views/domains.js) render it verbatim on every pre-run
 * confirm dialog and every post-run "planning cost" readout whenever
 * `estimatedUsd` is null — see docs/ai-health.md for the one deliberate
 * exception (the `/next` quick-action button badge is too narrow for a full
 * sentence and shows a short "cost unknown" instead).
 *
 * `priceKnown` itself has NO current reader anywhere in the app — every
 * consumer keys off `costNote`'s truthiness instead (`typeof …costNote ===
 * 'string' && …costNote`), which is sufficient on its own. The boolean is
 * kept as a structured, unambiguous alternative for a future consumer that
 * wants a plain true/false rather than parsing prose (e.g. an API client,
 * or a UI that wants to render an icon instead of a sentence) — not because
 * anything reads it today.
 *
 * @returns {{estimatedUsd: number|null, priceKnown: boolean, costNote: string|null}}
 */
function costFields(provider, model, inputTokens, outputTokens) {
  const estimatedUsd = estimateUsdCost(provider, model, inputTokens, outputTokens);
  if (estimatedUsd === null) {
    return {
      estimatedUsd: null,
      priceKnown: false,
      costNote: `Cost estimate unavailable — no published price for model "${model}".`,
    };
  }
  return { estimatedUsd, priceKnown: true, costNote: null };
}

/**
 * Extract the first ~500 chars of prose from a wiki page, skipping YAML
 * frontmatter and the title line. Small samples are enough for the LLM to
 * judge whether two pages describe the same concept.
 */
function firstParagraph(content) {
  let body = content;
  // Strip frontmatter
  if (body.startsWith('---')) {
    const closeIdx = body.indexOf('\n---', 3);
    if (closeIdx !== -1) body = body.slice(closeIdx + 4).trimStart();
  }
  // Strip the title line
  body = body.replace(/^#\s+.*\n/, '').trimStart();
  return body.slice(0, FIRST_PARA_MAX).replace(/\s+/g, ' ').trim();
}

/**
 * Estimate the cost of a semantic-duplicate scan WITHOUT making any LLM
 * calls. Used by the UI to show a confirm dialog before the user pays for
 * the real scan.
 *
 * @param {string} domain
 * @param {number} maxPairs — cap on candidate pairs (default 500)
 * @returns {Promise<{pageCount, candidatePairs, totalCandidates, truncated, estimatedTokens, estimatedUsd, provider, model}>}
 */
export async function estimateSemanticDuplicateScan(domain, maxPairs = SEMANTIC_DUPE_DEFAULT_CAP) {
  const { pairs, pageCount, truncated, totalCandidates } =
    await findSemanticCandidatePairs(domain, maxPairs);
  const estimatedTokens = pairs.length * EST_TOKENS_PER_PAIR;
  const { provider, model } = getProviderInfo();
  // Rough 60/40 input/output split
  return {
    pageCount,
    candidatePairs: pairs.length,
    totalCandidates,
    truncated,
    estimatedTokens,
    ...costFields(provider, model, estimatedTokens * 0.6, estimatedTokens * 0.4),
    provider,
    model,
  };
}

/**
 * Run the real semantic-duplicate scan. Yields progress events through
 * `onEvent({type, ...})` so the HTTP layer can forward them over SSE.
 *
 * Event shapes:
 *   { type: 'start', candidatePairs, batches }
 *   { type: 'progress', processed, total, found }
 *   { type: 'pair', pair }                       — one accepted duplicate pair
 *   { type: 'done', pairs, cost }                — final summary
 *
 * The LLM is asked, per batch, to judge each pair as duplicate / not-duplicate
 * and pick the canonical slug. Low-confidence and non-duplicate verdicts are
 * filtered out; only medium+high duplicates survive to the UI.
 *
 * NO FILESYSTEM WRITES. Application is through POST /api/health/:domain/fix
 * with type: 'semanticDupe'.
 */
export async function scanSemanticDuplicates(domain, opts = {}, onEvent = () => {}) {
  const { maxPairs = SEMANTIC_DUPE_DEFAULT_CAP, costCeilingTokens = 50_000 } = opts;

  const wikiDir = wikiPath(domain);
  if (!existsSync(wikiDir)) throw new Error(`No wiki found for domain: ${domain}`);

  const { pairs: candidatePairs } = await findSemanticCandidatePairs(domain, maxPairs);

  // Hard ceiling: abort before any LLM call if we'd exceed the user's budget
  const estimatedTokens = candidatePairs.length * EST_TOKENS_PER_PAIR;
  if (estimatedTokens > costCeilingTokens) {
    const err = new Error(
      `Estimated ${estimatedTokens.toLocaleString()} tokens exceeds your ` +
      `AI Health cost ceiling of ${costCeilingTokens.toLocaleString()}. ` +
      `Raise the ceiling in Settings, lower the candidate cap, or split the domain.`
    );
    err.code = 'OVER_COST_CEILING';
    throw err;
  }

  const batches = [];
  for (let i = 0; i < candidatePairs.length; i += SEMANTIC_BATCH_SIZE) {
    batches.push(candidatePairs.slice(i, i + SEMANTIC_BATCH_SIZE));
  }

  onEvent({ type: 'start', candidatePairs: candidatePairs.length, batches: batches.length });

  // Pre-load first-paragraph samples for every slug we'll mention in prompts,
  // to avoid re-reading the same file multiple times.
  const sampleCache = new Map();
  async function getSample(folder, slug) {
    const key = `${folder}/${slug}`;
    if (sampleCache.has(key)) return sampleCache.get(key);
    const full = path.join(wikiDir, folder, slug + '.md');
    if (!existsSync(full)) { sampleCache.set(key, ''); return ''; }
    const content = await readFile(full, 'utf8');
    const sample = firstParagraph(content);
    sampleCache.set(key, sample);
    return sample;
  }

  const acceptedPairs = [];
  let processed = 0;
  let totalInputChars = 0;
  let totalOutputChars = 0;

  const systemPrompt =
    `You are auditing a personal knowledge wiki for semantic duplicate pages — ` +
    `pages that describe the same concept under different slugs (e.g. "rag" vs ` +
    `"retrieval-augmented-generation", or "email" vs "e-mail"). You read a batch of ` +
    `candidate pairs, each with both pages' slug + title + first paragraph, and ` +
    `decide whether they are true duplicates.\n\n` +
    `RULES:\n` +
    `1. A pair is a duplicate ONLY if both pages describe the SAME underlying ` +
    `concept/entity. Related-but-distinct pages (e.g. "gpt-4" vs "gpt-4-turbo") ` +
    `are NOT duplicates.\n` +
    `2. For duplicates, pick the canonical slug — prefer the more descriptive, ` +
    `readable form (e.g. "retrieval-augmented-generation" over "rag"; ` +
    `"neural-networks" over "neural-network"; full name over acronym).\n` +
    `3. Set confidence honestly: "high" = unambiguous same concept; ` +
    `"medium" = likely but some doubt; "low" = speculative.\n` +
    `4. If unsure, mark as non-duplicate. Precision over recall — a missed dupe ` +
    `is cheap; a wrong merge is expensive.\n` +
    `5. Respond with ONLY valid JSON. No markdown fences, no prose outside JSON.`;

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    const batchInfo = [];
    for (let i = 0; i < batch.length; i++) {
      const p = batch[i];
      const [sampleA, sampleB] = await Promise.all([
        getSample(p.folderA, p.slugA),
        getSample(p.folderB, p.slugB),
      ]);
      batchInfo.push({
        index: i,
        slugA: p.slugA, folderA: p.folderA, sampleA,
        slugB: p.slugB, folderB: p.folderB, sampleB,
      });
    }

    const userPrompt =
      `Judge each of these ${batch.length} candidate pairs. Return JSON:\n` +
      `{"results": [{"index": N, "isDuplicate": bool, "canonicalSlug": "slug-or-null", ` +
      `"confidence": "high"|"medium"|"low", "rationale": "one short sentence"}, ...]}\n\n` +
      `PAIRS:\n` +
      batchInfo.map(b =>
        `--- PAIR ${b.index} ---\n` +
        `A: [${b.folderA}/${b.slugA}]\n${b.sampleA || '(empty)'}\n\n` +
        `B: [${b.folderB}/${b.slugB}]\n${b.sampleB || '(empty)'}\n`
      ).join('\n');

    totalInputChars += systemPrompt.length + userPrompt.length;

    let raw, parsed;
    try {
      raw = await generateText(systemPrompt, userPrompt, 2048, 'json');
      totalOutputChars += (raw || '').length;
      parsed = parseJSON(raw);
    } catch (err) {
      onEvent({ type: 'batch-error', batch: bi, error: err.message });
      processed += batch.length;
      onEvent({ type: 'progress', processed, total: candidatePairs.length, found: acceptedPairs.length });
      continue;
    }

    const results = Array.isArray(parsed.results) ? parsed.results : [];
    for (const r of results) {
      if (!r || typeof r !== 'object') continue;
      if (!r.isDuplicate) continue;
      const conf = String(r.confidence || 'low').toLowerCase();
      if (conf === 'low') continue;   // require at least medium confidence
      const idx = Number(r.index);
      if (!Number.isInteger(idx) || idx < 0 || idx >= batch.length) continue;
      const pair = batch[idx];
      const canonical = String(r.canonicalSlug || '').trim().replace(/^(entities|concepts)\//, '');
      if (canonical !== pair.slugA && canonical !== pair.slugB) continue; // must match one side
      const keepSlug = canonical;
      const keepFolder = keepSlug === pair.slugA ? pair.folderA : pair.folderB;
      const removeSlug = keepSlug === pair.slugA ? pair.slugB : pair.slugA;
      const removeFolder = keepSlug === pair.slugA ? pair.folderB : pair.folderA;
      const accepted = {
        keepSlug, keepFolder,
        removeSlug, removeFolder,
        confidence: conf,
        rationale: String(r.rationale || '').trim() || 'No rationale provided.',
      };
      acceptedPairs.push(accepted);
      onEvent({ type: 'pair', pair: accepted });
    }

    processed += batch.length;
    onEvent({ type: 'progress', processed, total: candidatePairs.length, found: acceptedPairs.length });
  }

  // Rough token ≈ 4 chars. Good enough for a user-facing "you spent $X" readout.
  const approxInputTokens = Math.round(totalInputChars / 4);
  const approxOutputTokens = Math.round(totalOutputChars / 4);
  const { provider, model } = getProviderInfo();

  const cost = {
    provider, model,
    inputTokens: approxInputTokens,
    outputTokens: approxOutputTokens,
    ...costFields(provider, model, approxInputTokens, approxOutputTokens),
  };
  onEvent({ type: 'done', pairs: acceptedPairs, cost });
  return { pairs: acceptedPairs, cost };
}

// ── Phase 4 (v3.0.1-beta.16) — Bulk AI broken-link resolution ───────────────
//
// A mature domain can accumulate hundreds of broken [[wikilinks]] — the LLM
// references a page during ingest that was never created, or uses a slug
// variant ("rezun-tali" for "tali-rezun", "artificial intelligence" with a
// space). Fixing them one Ask-AI click at a time is impractical at 1000+.
//
// This is a two-tier batch resolver, mirroring the semantic-dupe scan's
// architecture (estimate → SSE plan → apply through a single chokepoint):
//   1. DETERMINISTIC pre-pass (free, no LLM): slugify spaces, strip `.md`,
//      strip folder/honorific/article prefixes, hyphen-normalise — and match
//      against the on-disk slug inventory. Catches the pure-formatting cases.
//   2. AI pass (batched): the remaining UNIQUE broken targets are sent to the
//      LLM with the slug inventory; it maps each to an existing slug or null.
//      A null (no real match) becomes a "strip the brackets" action.
//
// READ-ONLY — this module only PLANS. Application is `applyBrokenLinkFixes` in
// health.js, behind the write-lock, so the AI layer can never corrupt the wiki.

// The slug inventory (re-sent in every batch, since LLM calls are stateless) is
// the dominant token cost, so we use LARGE batches to minimise the number of
// inventory resends. At 100 targets/call a 3000-slug domain needs ~6 calls.
const BROKEN_LINK_BATCH_SIZE = 100;      // unique targets per LLM call
const EST_TOKENS_PER_BROKEN_TARGET = 60; // rough input+output budget per AI-resolved target

const TITLE_PREFIX_RE   = /^(dr|mr|ms|mrs|prof|professor|the)\.?-/;
const ARTICLE_PREFIX_RE = /^(the|a|an)-/;

function slugifyText(t) {
  return String(t || '')
    .replace(/\.md$/i, '')
    .toLowerCase()
    .replace(/[^\w\s/-]/g, '')
    .replace(/_/g, '-')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Lexical-variant gate (v3.0.1-beta.16). The LLM happily maps a generic broken
 * link to the "nearest" page even when it's a DIFFERENT concept (e.g.
 * "context-window" → "agent-memory", "big-data" → "ai-and-weather-forecasting").
 * Those create wrong graph edges — worse than a broken link. We only ACCEPT an
 * AI retarget when the broken slug and the target slug share enough word-level
 * evidence to be the SAME thing (a spelling/ordering variant, an acronym
 * expansion that overlaps, or one being a token-subset of the other, like
 * "iot" ⊂ "iot-and-ai"). Anything weaker falls through to "strip" — which is
 * exactly the user's chosen behaviour for genuinely-missing pages.
 *
 * Returns true if `targetSlug` is a plausible same-thing variant of `brokenSlug`.
 */
function isLexicalVariant(brokenSlug, targetSlug) {
  const a = slugifyText(String(brokenSlug || '').replace(/^summaries\//, ''));
  const b = slugifyText(String(targetSlug || '').replace(/^summaries\//, ''));
  if (!a || !b) return false;
  if (a === b) return true;
  const aTok = a.split('-').filter(Boolean);
  const bTok = b.split('-').filter(Boolean);
  if (!aTok.length || !bTok.length) return false;
  const aSet = new Set(aTok), bSet = new Set(bTok);
  // One side is a token-subset of the other: "iot" ⊂ "iot-and-ai",
  // "software-development-efficiency" ⊂ "...-enhancement", reorderings, etc.
  // BUT a single SHORT generic token must not match a much longer slug — "ai" ⊂
  // "ai-and-weather-forecasting" is a different concept, not a variant. Require a
  // 1-token subset side to be ≥3 chars (keeps "iot"/"mcp"/"gpt", rejects "ai"/"ml").
  const subsetOk = (subTok) => subTok.length >= 2 || (subTok[0] && subTok[0].length >= 3);
  if (aTok.every(t => bSet.has(t)) && subsetOk(aTok)) return true;
  if (bTok.every(t => aSet.has(t)) && subsetOk(bTok)) return true;
  // Otherwise require substantial token overlap (Jaccard ≥ 0.5).
  const inter = aTok.filter(t => bSet.has(t)).length;
  const union = new Set([...aTok, ...bTok]).size;
  return union > 0 && inter / union >= 0.5;
}

/**
 * Build a deterministic broken-link resolver closure over the on-disk slug
 * inventory. Mirrors writePage's Pass A/B/C so a link the write pipeline would
 * have normalised on a fresh ingest is resolved here for an existing wiki.
 * Returns a slug (bare, or "summaries/<slug>") or null.
 */
function buildLinkResolver(entitySlugs, conceptSlugs, summarySlugs) {
  const exact = new Set([...entitySlugs, ...conceptSlugs]);   // bare entity/concept slugs
  const summarySet = new Set(summarySlugs);
  const norm = s => s.replace(ARTICLE_PREFIX_RE, '').replace(/-/g, '').toLowerCase();
  const normMap = new Map();
  for (const s of [...entitySlugs, ...conceptSlugs]) { const k = norm(s); if (!normMap.has(k)) normMap.set(k, s); }
  for (const s of summarySlugs) { const k = norm(s); if (!normMap.has(k)) normMap.set(k, `summaries/${s}`); }
  const slugify = t => t
    .replace(/\.md$/i, '')
    .toLowerCase()
    .replace(/[^\w\s/-]/g, '')
    .replace(/_/g, '-')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return function resolve(linkText) {
    let raw = String(linkText || '').trim().replace(/\.md$/i, '');
    // Summary-prefixed link
    if (/^summaries\//i.test(raw)) {
      const slug = slugify(raw.slice('summaries/'.length));
      if (summarySet.has(slug)) return `summaries/${slug}`;
      const k = norm(slug);
      if (normMap.has(k) && normMap.get(k).startsWith('summaries/')) return normMap.get(k);
      return null;
    }
    raw = raw.replace(/^(entities|concepts)\//i, '');
    const s = slugify(raw);
    if (!s) return null;
    if (exact.has(s)) return s;
    if (summarySet.has(s)) return `summaries/${s}`;
    const stripped = s.replace(TITLE_PREFIX_RE, '');
    if (stripped !== s && exact.has(stripped)) return stripped;
    const k = norm(s);
    if (normMap.has(k)) return normMap.get(k);
    return null;
  };
}

/**
 * Group the scan's broken-link occurrences by unique linkText, recording the
 * occurrence count and the (deduped, capped) set of source files for context.
 */
function groupBrokenLinks(brokenLinks) {
  const byText = new Map();
  for (const issue of brokenLinks) {
    const t = issue.linkText;
    if (!t) continue;
    let g = byText.get(t);
    if (!g) { g = { linkText: t, occurrences: 0, sourceFiles: [] }; byText.set(t, g); }
    g.occurrences++;
    if (g.sourceFiles.length < 5 && !g.sourceFiles.includes(issue.sourceFile)) g.sourceFiles.push(issue.sourceFile);
  }
  return [...byText.values()];
}

async function loadInventory(wikiDir) {
  const [entitySlugs, conceptSlugs, summarySlugs] = await Promise.all([
    listSlugs(path.join(wikiDir, 'entities')),
    listSlugs(path.join(wikiDir, 'concepts')),
    listSlugs(path.join(wikiDir, 'summaries')),
  ]);
  return { entitySlugs, conceptSlugs, summarySlugs };
}

/**
 * Estimate a bulk broken-link fix WITHOUT any LLM call. Powers the confirm
 * dialog: how many unique targets, how many resolve for free, how many need
 * the AI, and the rough token/USD cost of the AI portion.
 */
export async function estimateBrokenLinkFix(domain) {
  const wikiDir = wikiPath(domain);
  if (!existsSync(wikiDir)) throw new Error(`No wiki found for domain: ${domain}`);

  const report = await scanWiki(domain);
  const groups = groupBrokenLinks(report.brokenLinks || []);
  const { entitySlugs, conceptSlugs, summarySlugs } = await loadInventory(wikiDir);
  const resolve = buildLinkResolver(entitySlugs, conceptSlugs, summarySlugs);

  let deterministic = 0;
  const needAi = [];
  for (const g of groups) {
    if (resolve(g.linkText)) deterministic++;
    else needAi.push(g);
  }

  const estimatedTokens = needAi.length * EST_TOKENS_PER_BROKEN_TARGET
    + Math.ceil(needAi.length / BROKEN_LINK_BATCH_SIZE) * Math.round((entitySlugs.length + conceptSlugs.length + summarySlugs.length) * 6); // inventory resent per batch
  const { provider, model } = getProviderInfo();

  return {
    totalOccurrences: (report.brokenLinks || []).length,
    uniqueTargets: groups.length,
    resolveFree: deterministic,
    needAi: needAi.length,
    inventorySize: entitySlugs.length + conceptSlugs.length + summarySlugs.length,
    estimatedTokens,
    ...costFields(provider, model, estimatedTokens * 0.85, estimatedTokens * 0.15),
    provider,
    model,
  };
}

/**
 * Plan a bulk broken-link fix. Runs the deterministic pre-pass, then batches
 * the remainder through the LLM. Streams progress via onEvent for SSE.
 *
 * Event shapes:
 *   { type: 'start', uniqueTargets, needAi, batches }
 *   { type: 'progress', processed, total }
 *   { type: 'done', plan, summary, cost }
 *
 * Each plan entry:
 *   { linkText, action: 'retarget'|'strip', target: slug|null,
 *     occurrences, sourceFiles, confidence, source: 'deterministic'|'ai' }
 *
 * NO FILESYSTEM WRITES. Apply via applyBrokenLinkFixes (health.js).
 */
export async function planBrokenLinkFixes(domain, opts = {}, onEvent = () => {}) {
  // Generous default — the inventory resend makes the token count look big, but
  // at Gemini Flash Lite rates even ~300k tokens is ~$0.03. The ceiling exists
  // only to stop a truly pathological domain (tens of thousands of slugs) from
  // silently running up cost; the user sees the dollar estimate before confirming.
  const { costCeilingTokens = 750_000 } = opts;
  const wikiDir = wikiPath(domain);
  if (!existsSync(wikiDir)) throw new Error(`No wiki found for domain: ${domain}`);

  const report = await scanWiki(domain);
  const groups = groupBrokenLinks(report.brokenLinks || []);
  const { entitySlugs, conceptSlugs, summarySlugs } = await loadInventory(wikiDir);
  const validTargets = new Set([
    ...entitySlugs, ...conceptSlugs, ...summarySlugs.map(s => `summaries/${s}`),
  ]);
  const resolve = buildLinkResolver(entitySlugs, conceptSlugs, summarySlugs);

  const plan = [];
  const aiGroups = [];
  for (const g of groups) {
    const det = resolve(g.linkText);
    if (det) {
      plan.push({ linkText: g.linkText, action: 'retarget', target: det, occurrences: g.occurrences, sourceFiles: g.sourceFiles, confidence: 'high', source: 'deterministic' });
    } else {
      aiGroups.push(g);
    }
  }

  // Cost ceiling guard before any LLM call.
  const estTokens = aiGroups.length * EST_TOKENS_PER_BROKEN_TARGET
    + Math.ceil(aiGroups.length / BROKEN_LINK_BATCH_SIZE) * Math.round(validTargets.size * 6);
  if (estTokens > costCeilingTokens) {
    const err = new Error(
      `Estimated ${estTokens.toLocaleString()} tokens exceeds the broken-link-fix ceiling of ` +
      `${costCeilingTokens.toLocaleString()}. The domain has an unusually large slug inventory or ` +
      `broken-link count. Try fixing structural issues first, or contact the maintainer to raise the cap.`
    );
    err.code = 'OVER_COST_CEILING';
    throw err;
  }

  const batches = [];
  for (let i = 0; i < aiGroups.length; i += BROKEN_LINK_BATCH_SIZE) batches.push(aiGroups.slice(i, i + BROKEN_LINK_BATCH_SIZE));

  onEvent({ type: 'start', uniqueTargets: groups.length, needAi: aiGroups.length, batches: batches.length });

  const inventoryBlock = [
    'ENTITIES:', entitySlugs.length ? entitySlugs.join(', ') : '(none)', '',
    'CONCEPTS:', conceptSlugs.length ? conceptSlugs.join(', ') : '(none)', '',
    'SUMMARIES:', summarySlugs.length ? summarySlugs.map(s => `summaries/${s}`).join(', ') : '(none)',
  ].join('\n');

  const systemPrompt =
    `You repair broken [[wikilinks]] in a personal knowledge wiki. For each broken ` +
    `link target, decide which EXISTING page (from the inventory) the writer most ` +
    `likely meant, or null if no inventory page is a genuine match.\n\n` +
    `RULES:\n` +
    `1. "target" MUST be a slug from the inventory, or null. NEVER invent a slug.\n` +
    `2. Entity/concept slugs are bare (e.g. "tali-rezun"). Summary slugs are ` +
    `prefixed "summaries/<slug>".\n` +
    `3. Be CONSERVATIVE. Only map a broken link to a page when it names the SAME ` +
    `thing — a spelling/formatting variant, word reordering, acronym, or near-exact ` +
    `synonym. The broken link and the target should share words. Examples:\n` +
    `   • "rezun-tali" → "tali-rezun" (same person, reordered) ✓\n` +
    `   • "iot" → "iot-and-ai" (same topic) ✓\n` +
    `   • "context-window" → "agent-memory" ✗ (DIFFERENT concepts — return null)\n` +
    `   • "big-data" → "ai-and-weather-forecasting" ✗ (unrelated — return null)\n` +
    `   • "healthcare" with only an "ai-in-medicine" page ✗ (no real "healthcare" ` +
    `page exists — return null; the link will be removed, which is correct)\n` +
    `If the broken link is a general topic the writer mentioned but never wrote a ` +
    `page for, return null. A removed link is BETTER than a wrong connection.\n` +
    `4. confidence: "high" = clearly the same page; "medium" = probable; ` +
    `"low" = weak. Prefer null over a low-confidence guess.\n` +
    `5. Respond with ONLY valid JSON. No markdown fences.`;

  let processed = 0;
  let totalInputChars = 0, totalOutputChars = 0;

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    const userPrompt =
      `Map each broken link target to an existing page slug, or null.\n\n` +
      `BROKEN TARGETS:\n` +
      batch.map((g, i) => `${i}: "${g.linkText}"${g.sourceFiles.length ? ` (seen in: ${g.sourceFiles[0]})` : ''}`).join('\n') +
      `\n\nSLUG INVENTORY:\n----------------------------------------\n${inventoryBlock}\n----------------------------------------\n\n` +
      `Return JSON: {"results":[{"index":N,"target":"<slug-or-null>","confidence":"high"|"medium"|"low"}, ...]}`;

    totalInputChars += systemPrompt.length + userPrompt.length;

    let parsed = null;
    let batchFailed = false;
    try {
      const raw = await generateText(systemPrompt, userPrompt, 4096, 'json');
      totalOutputChars += (raw || '').length;
      parsed = parseJSON(raw);
    } catch (err) {
      onEvent({ type: 'batch-error', batch: bi, error: err.message });
      batchFailed = true;
    }

    // On a transient LLM/parse error, LEAVE these links untouched rather than
    // defaulting them all to "strip" — a flaky network must never bias the plan
    // toward deleting brackets (audit L3). They stay broken for a later re-run.
    if (batchFailed) {
      processed += batch.length;
      onEvent({ type: 'progress', processed, total: aiGroups.length });
      continue;
    }

    const results = (parsed && Array.isArray(parsed.results)) ? parsed.results : [];
    const byIndex = new Map();
    for (const r of results) {
      if (!r || typeof r !== 'object') continue;
      const idx = Number(r.index);
      if (Number.isInteger(idx) && idx >= 0 && idx < batch.length) byIndex.set(idx, r);
    }

    for (let i = 0; i < batch.length; i++) {
      const g = batch[i];
      const r = byIndex.get(i);
      let target = r ? String(r.target ?? '').trim() : '';
      if (target === 'null' || target === '') target = null;
      let confidence = r ? String(r.confidence || 'low').toLowerCase() : 'low';
      if (!['high', 'medium', 'low'].includes(confidence)) confidence = 'low';

      // Validate the AI's target against the on-disk inventory — reject hallucinations.
      if (target) {
        const bare = target.startsWith('summaries/') ? target : target.replace(/^(entities|concepts)\//, '');
        if (!validTargets.has(bare)) target = null;
        else target = bare;
      }

      // Lexical-variant gate: only retarget when the broken link and the target
      // are demonstrably the SAME thing. The LLM over-reaches on generic terms
      // (mapping a missing concept to a loosely-related page); those must strip,
      // not retarget — which is the user's chosen behaviour for missing pages.
      if (target && !isLexicalVariant(g.linkText, target)) {
        target = null;
      }

      if (target) {
        plan.push({ linkText: g.linkText, action: 'retarget', target, occurrences: g.occurrences, sourceFiles: g.sourceFiles, confidence, source: 'ai' });
      } else {
        // No real same-page match — the user chose: remove the brackets (keep the text).
        plan.push({ linkText: g.linkText, action: 'strip', target: null, occurrences: g.occurrences, sourceFiles: g.sourceFiles, confidence, source: 'ai' });
      }
    }

    processed += batch.length;
    onEvent({ type: 'progress', processed, total: aiGroups.length });
  }

  const summary = {
    retarget: plan.filter(p => p.action === 'retarget').length,
    strip: plan.filter(p => p.action === 'strip').length,
    retargetOccurrences: plan.filter(p => p.action === 'retarget').reduce((n, p) => n + p.occurrences, 0),
    stripOccurrences: plan.filter(p => p.action === 'strip').reduce((n, p) => n + p.occurrences, 0),
    deterministic: plan.filter(p => p.source === 'deterministic').length,
    ai: plan.filter(p => p.source === 'ai').length,
  };

  const approxInputTokens = Math.round(totalInputChars / 4);
  const approxOutputTokens = Math.round(totalOutputChars / 4);
  const { provider, model } = getProviderInfo();
  const cost = {
    provider, model,
    inputTokens: approxInputTokens,
    outputTokens: approxOutputTokens,
    ...costFields(provider, model, approxInputTokens, approxOutputTokens),
  };

  onEvent({ type: 'done', plan, summary, cost });
  return { plan, summary, cost };
}

// ── Phase 5 (v3.0.1-beta.17) — Bulk AI orphan rescue ─────────────────────────
//
// An orphan is an entity/concept page with zero incoming links. The per-orphan
// "Ask AI" button (Phase 2) is fine for a handful, but a mature domain can have
// hundreds. This batches the same judgement: for each orphan, the LLM picks the
// ONE existing page that should most naturally link to it (a "home"), plus a
// short relationship description. Apply injects `- [[orphan]] — desc` into that
// home's Related section (via injectRelatedLink), giving the orphan an incoming
// link so it drops off the orphan list. Summaries are never homes (wiki
// convention — summaries reference entities at ingest, not retroactively).
//
// READ-ONLY planning; application is applyOrphanRescue in health.js.

const ORPHAN_RESCUE_BATCH_SIZE = 12;   // orphans per LLM call (each carries an excerpt)
const ORPHAN_RESCUE_EXCERPT = 600;     // chars of orphan body sent for context

export async function estimateOrphanRescue(domain) {
  const wikiDir = wikiPath(domain);
  if (!existsSync(wikiDir)) throw new Error(`No wiki found for domain: ${domain}`);
  const report = await scanWiki(domain);
  const orphans = report.orphans || [];
  const [entitySlugs, conceptSlugs] = await Promise.all([
    listSlugs(path.join(wikiDir, 'entities')),
    listSlugs(path.join(wikiDir, 'concepts')),
  ]);
  const inventorySize = entitySlugs.length + conceptSlugs.length;
  const estimatedTokens = Math.ceil(orphans.length / ORPHAN_RESCUE_BATCH_SIZE) * (inventorySize * 6)
    + orphans.length * (ORPHAN_RESCUE_EXCERPT / 4 + 40);
  const { provider, model } = getProviderInfo();
  return {
    orphanCount: orphans.length,
    inventorySize,
    estimatedTokens,
    ...costFields(provider, model, estimatedTokens * 0.9, estimatedTokens * 0.1),
    provider, model,
  };
}

/**
 * Plan a bulk orphan rescue. Streams progress via onEvent for SSE.
 *
 * Event shapes:
 *   { type: 'start', orphans, batches }
 *   { type: 'progress', processed, total }
 *   { type: 'done', plan, summary, cost }
 *
 * Each plan entry: { orphanSlug, orphanPath, orphanType, target, description, confidence }
 * Orphans the AI finds no genuine home for are NOT in the plan (left for manual review).
 */
export async function planOrphanRescue(domain, opts = {}, onEvent = () => {}) {
  const { costCeilingTokens = 1_500_000 } = opts;
  const wikiDir = wikiPath(domain);
  if (!existsSync(wikiDir)) throw new Error(`No wiki found for domain: ${domain}`);

  const report = await scanWiki(domain);
  const orphans = report.orphans || [];
  const [entitySlugs, conceptSlugs] = await Promise.all([
    listSlugs(path.join(wikiDir, 'entities')),
    listSlugs(path.join(wikiDir, 'concepts')),
  ]);
  const validTargets = new Set([...entitySlugs, ...conceptSlugs]);
  const inventoryBlock = [
    'ENTITIES:', entitySlugs.length ? entitySlugs.join(', ') : '(none)', '',
    'CONCEPTS:', conceptSlugs.length ? conceptSlugs.join(', ') : '(none)',
  ].join('\n');

  const estTokens = Math.ceil(orphans.length / ORPHAN_RESCUE_BATCH_SIZE) * (validTargets.size * 6)
    + orphans.length * (ORPHAN_RESCUE_EXCERPT / 4 + 40);
  if (estTokens > costCeilingTokens) {
    const err = new Error(
      `Estimated ${estTokens.toLocaleString()} tokens exceeds the orphan-rescue ceiling of ` +
      `${costCeilingTokens.toLocaleString()}. The domain has an unusually large slug inventory or orphan count.`
    );
    err.code = 'OVER_COST_CEILING';
    throw err;
  }

  const batches = [];
  for (let i = 0; i < orphans.length; i += ORPHAN_RESCUE_BATCH_SIZE) batches.push(orphans.slice(i, i + ORPHAN_RESCUE_BATCH_SIZE));

  onEvent({ type: 'start', orphans: orphans.length, batches: batches.length });

  const systemPrompt =
    `You maintain a personal knowledge wiki. An "orphan" is a page with zero incoming ` +
    `links. For each orphan, choose the ONE existing page (from the inventory) that ` +
    `should most naturally link TO it, and write a short relationship description that ` +
    `will become a bullet on that page.\n\n` +
    `RULES:\n` +
    `1. "home" MUST be a slug from the inventory, or null if NOTHING genuinely relates. ` +
    `NEVER invent a slug, and NEVER pick the orphan itself.\n` +
    `2. Entity/concept slugs are bare (e.g. "tali-rezun"). Summaries are NOT valid homes.\n` +
    `3. Only choose a home with a GENUINE conceptual relationship. A loose topical ` +
    `association is not enough — return null instead. A wrong link is worse than an ` +
    `orphan left for manual review.\n` +
    `4. "description" (≤15 words) reads from the home page's perspective, explaining why ` +
    `it relates to the orphan.\n` +
    `5. confidence: "high" = clear relationship; "medium" = reasonable; "low" = weak ` +
    `(prefer null over low).\n` +
    `6. Respond with ONLY valid JSON. No markdown fences.`;

  const plan = [];
  let processed = 0, totalInputChars = 0, totalOutputChars = 0;

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    const infos = await Promise.all(batch.map(async (o) => {
      let content = '';
      try { content = await readFile(path.join(wikiDir, o.path), 'utf8'); } catch { /* unreadable */ }
      return { slug: o.slug, type: o.type, path: o.path, excerpt: firstParagraph(content).slice(0, ORPHAN_RESCUE_EXCERPT) };
    }));

    const userPrompt =
      `For each orphan, pick the best home page (or null). Return JSON:\n` +
      `{"results":[{"index":N,"home":"<slug-or-null>","description":"<≤15 words>","confidence":"high"|"medium"|"low"}, ...]}\n\n` +
      `ORPHANS:\n` +
      infos.map((o, i) => `--- ORPHAN ${i} [${o.type}/${o.slug}] ---\n${o.excerpt || '(empty page)'}`).join('\n\n') +
      `\n\nSLUG INVENTORY (entities + concepts only — summaries are NOT valid homes):\n` +
      `----------------------------------------\n${inventoryBlock}\n----------------------------------------`;

    totalInputChars += systemPrompt.length + userPrompt.length;

    let parsed = null;
    try {
      const raw = await generateText(systemPrompt, userPrompt, 4096, 'json');
      totalOutputChars += (raw || '').length;
      parsed = parseJSON(raw);
    } catch (err) {
      onEvent({ type: 'batch-error', batch: bi, error: err.message });
    }

    const results = (parsed && Array.isArray(parsed.results)) ? parsed.results : [];
    const byIndex = new Map();
    for (const r of results) {
      if (!r || typeof r !== 'object') continue;
      const idx = Number(r.index);
      if (Number.isInteger(idx) && idx >= 0 && idx < batch.length) byIndex.set(idx, r);
    }

    for (let i = 0; i < batch.length; i++) {
      const o = batch[i];
      const r = byIndex.get(i);
      if (!r) continue;
      let home = String(r.home ?? '').trim().replace(/^(entities|concepts)\//, '');
      if (home === 'null' || home === '') continue;
      let confidence = String(r.confidence || 'low').toLowerCase();
      if (!['high', 'medium', 'low'].includes(confidence)) confidence = 'low';
      if (confidence === 'low') continue;                 // require medium+
      if (!validTargets.has(home)) continue;              // reject hallucination
      if (home === o.slug) continue;                      // no self-link
      let description = String(r.description || '').replace(/\s+/g, ' ').trim().slice(0, 140);
      plan.push({ orphanSlug: o.slug, orphanPath: o.path, orphanType: o.type, target: home, description, confidence });
    }

    processed += batch.length;
    onEvent({ type: 'progress', processed, total: orphans.length });
  }

  const summary = {
    rescuable: plan.length,
    noHome: orphans.length - plan.length,
    orphans: orphans.length,
  };
  const approxInputTokens = Math.round(totalInputChars / 4);
  const approxOutputTokens = Math.round(totalOutputChars / 4);
  const { provider, model } = getProviderInfo();
  const cost = {
    provider, model,
    inputTokens: approxInputTokens,
    outputTokens: approxOutputTokens,
    ...costFields(provider, model, approxInputTokens, approxOutputTokens),
  };

  onEvent({ type: 'done', plan, summary, cost });
  return { plan, summary, cost };
}

// Exposed for unit testing the pure broken-link-fix helpers (v3.0.1-beta.16+).
export const __testing = {
  isLexicalVariant,
  buildLinkResolver,
  groupBrokenLinks,
  slugifyText,
  estimateUsdCost,
  costFields,
};
