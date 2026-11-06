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
import { createHash } from 'crypto';
import path from 'path';
import { jsonrepair } from 'jsonrepair';
import { wikiPath } from './files.js';
import { generateText, getProviderInfo, getModelPrice, isFreeModel, estimateRates, TIER_ESTIMATE_MARGIN } from './llm.js';
import { findSemanticCandidatePairs, candidatePairsTouching, SEMANTIC_DUPE_DEFAULT_CAP, scanWiki, listMd } from './health.js';
import { loadRecentNewPages, pruneRecentNewPages } from './recent-new-pages.js';
import { loadDismissed, filterDismissed, keyForIssue } from './health-dismissed.js';
import {
  loadDuplicateChecks, saveDuplicateChecks, pairKey, openingsHash, pageOpening, isSpellingVariant, isMergeableSlug, nameRelation,
} from './duplicate-checks.js';
// v3.67.0: one estimate shape and one actual shape for every AI job. The
// accumulator is the ingest pipeline's own (src/brain/ingest.js), so a Health
// run and an ingest are summed and priced by the same code.
import { makeUsageAccumulator, isOutputTokenLimit } from './ingest.js';
import { DEFAULT_AI_HEALTH } from './config.js';

// src/brain/ai-run.js is reached at CALL TIME, never by a static import.
// This module sits inside ingest.js's own import subtree
// (ingest.js → raw-store.js → wiki-read.js → health.js → health-ai.js), and a
// static import of ai-run.js would pull compile-estimate.js → ingest-queue.js
// into that subtree; ingest-queue.js reads ingest.js's `__testing` while
// evaluating, so every process whose first import is ingest.js would crash
// ("Cannot access 'ingestTesting' before initialization") — measured on this
// branch before the fix. test-next-compile-estimate §11 pins it by loading
// each module on the cycle as the first import of a fresh process.
let aiRunModule = null;
async function aiRun() {
  if (!aiRunModule) aiRunModule = await import('./ai-run.js');
  return aiRunModule;
}

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
export const EST_TOKENS_PER_PAIR = 400; // rough input+output budget per pair in a batch

/**
 * How each Health estimate splits its one token figure into input and output
 * (v3.67.0: named once, read by the three estimates AND by `describeHealthRun`,
 * so the run line under a button and the confirm's `estimatedUsd` price the
 * same split). The values are the ones the three estimates always used.
 */
const HEALTH_TOKEN_SPLIT = Object.freeze({
  semanticDupes: Object.freeze({ input: 0.6, output: 0.4 }),
  brokenLinks:   Object.freeze({ input: 0.85, output: 0.15 }),
  orphans:       Object.freeze({ input: 0.9, output: 0.1 }),
});

/**
 * The run line for a Health estimate (v3.67.0, ADDITIVE beside the existing
 * estimatedTokens / estimatedUsd / priceKnown / costNote fields, which keep
 * their contracts). A POINT, as the Health estimates always were: low = high.
 * `kind` is a HEALTH_TOKEN_SPLIT key; anything else (or a non-count
 * `estimatedTokens`) describes the model with no token figures — the
 * resting-state shape `GET /api/health/ai-available` also returns.
 */
export async function describeHealthRun(kind, estimatedTokens) {
  const { describeRun } = await aiRun();
  const split = Object.hasOwn(HEALTH_TOKEN_SPLIT, kind) ? HEALTH_TOKEN_SPLIT[kind] : null;
  if (!split || typeof estimatedTokens !== 'number' || !Number.isFinite(estimatedTokens) || estimatedTokens < 0) {
    return describeRun({ job: 'wiki-health' });
  }
  const input = Math.round(estimatedTokens * split.input);
  const output = Math.round(estimatedTokens * split.output);
  return describeRun({
    job: 'wiki-health',
    inputTokensLow: input, inputTokensHigh: input,
    outputTokensLow: output, outputTokensHigh: output,
  });
}

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
  if (!getModelPrice(model)) return null;
  // TIERED PRICE (2026-10-08): these are token totals across a scan's calls
  // with no per-call prompt sizes, so a tiered model (claude-haiku-5-5) is
  // quoted at its UPPER tier — llm.js's `estimateRates` with an unknown prompt
  // size. A flat model's rate is unchanged. The figure a finished scan reports
  // (`spent`) is priced per call by `priceUsageUsd` and is never this.
  const p = estimateRates(model, null);
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
 * ── THREE STATES, BECAUSE TWO FORCED THIS FUNCTION TO LIE ────────────────────
 *
 * FREE IS A KNOWN PRICE, NOT A MISSING ONE. `getModelPrice()` returns null for
 * a free model BY DESIGN (see FREE_MODELS in llm.js: a free model is recorded
 * by MEMBERSHIP, never as `{input: 0, output: 0}`, precisely so a budget guard
 * can never mistake "known to be free" for a truthy zero it must enforce). So
 * `estimateUsdCost` returned null and the single `=== null` branch below filed
 * free under "we have no idea what this costs".
 *
 * MEASURED, with the free model active: the FREE and UNPRICED payloads were
 * BYTE-IDENTICAL in all three fields, so Health's primary action button read
 * "Fix 1 broken link · cost unknown" and both confirm dialogs read "no
 * published price for model minimax/minimax-m3:free" — a false statement, the
 * price is published and it is zero. Settings and the chat composer both say
 * "free" for the same model, so three surfaces carried two vocabularies about
 * spend, directly under a line promising every AI action shows its cost before
 * it runs. It is also backwards: "unknown" is alarming on a PAID model, while
 * free is the one case where the cost is known EXACTLY.
 *
 * Resolved BEFORE the price lookup, and keyed on `isFreeModel()` — llm.js's
 * authoritative membership test — never on a price of 0 and never on the
 * `:free` id suffix. That mirrors `formatLivePrice` in next/views/chat.js,
 * whose docblock records why both shortcuts are unsafe (a router id and two
 * audio models are zero-priced without being free), and it is the same ordering
 * `compareModelCost` and `chargeForItem` already use for the same reason.
 *
 * `estimatedUsd` STAYS `null` for a free model — it is deliberately NOT 0.
 * `formatHealthCost` in the FROZEN src/public/app.js renders any number via
 * `toFixed(4)`, so a 0 would print `$0.0000` (verified against the real
 * function; scripts/test-health-cost-readouts.js §2 pins that rendering). That
 * is the exact string src/public/next/shared/format-usd.js exists to prevent,
 * because a reader cannot tell it from a real charge that rounded away. Free is
 * said in words, never as a dollar figure.
 *
 * The free case is therefore `{estimatedUsd: null, priceKnown: true}` — a
 * combination that could not previously occur, and the one a new reader must
 * handle: a null estimate no longer implies the price is unknown. It needs no
 * new field, which is deliberate; a field nothing reads is this repo's named
 * dead-data shape. The existing tri-state already distinguishes all three
 * cases, because a priced model always yields a number and an unpriced one
 * always yields `priceKnown: false`.
 *
 * @returns {{estimatedUsd: number|null, priceKnown: boolean, costNote: string|null}}
 */
function costFields(provider, model, inputTokens, outputTokens) {
  // Ahead of the price lookup: membership is the authority over any figure a
  // table might hold for a free id. See the docblock above.
  if (isFreeModel(model)) {
    return {
      estimatedUsd: null,
      priceKnown: true,
      costNote: `Free — no charge for model "${model}".`,
    };
  }
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
 * The instructions for judging a batch. Module constants because an answer is
 * only good for the instructions that produced it: their hash is part of what a
 * remembered answer is bound to, so changing them re-checks the pairs answered
 * under the old ones without anybody having to remember a version.
 *
 * WHY A RELATION, NOT YES/NO. Asked "is this a duplicate?", Flash Lite accepted
 * 217 of 500 real pairs and 765 of 2,000. On 100 sampled pairs, against Opus 5.5
 * as a reference at 30 "same": yes/no gave 61-68 "same" (31-38 extra, 0 missed);
 * this prompt gave 19-25 on Flash Lite (4-6 extra, 9-17 missed, 20 flips between
 * two runs) and 32 on Haiku 5.5 (6 extra, 4 missed). Naming the difference first
 * is the point: the system text is the measured one, verbatim.
 */
const SEMANTIC_SYSTEM_PROMPT = `You are auditing a personal knowledge wiki for pages that should be merged because they are the SAME page written twice. For each candidate pair, classify how the two pages relate:
- "same": the same subject. Deleting one and pointing its links to the other would lose nothing a reader would miss.
- "part": one is a part, aspect, subtopic, use or example of the other.
- "version": one is a specific version, edition or product of the other, or a person/company and their website or product.
- "overlap": different subjects that share a theme or several words.
- "different": unrelated.
Two pages about a shared theme are NOT "same", even when their names and openings are similar. Choose "same" only when you could not name a difference in subject. When unsure, choose "overlap".
Respond with ONLY valid JSON.`;
const SEMANTIC_REPLY_FORMAT =
  `{"results":[{"index":N,"difference":"the difference in subject in a few words, or none","relation":"same|part|version|overlap|different"}]}\n` +
  `Only when relation is "same", also give "canonicalSlug" (the slug to keep: prefer the more descriptive, readable ` +
  `form, e.g. "retrieval-augmented-generation" over "rag", "neural-networks" over "neural-network", full name over ` +
  `acronym), "confidence" ("high" = unambiguous, "medium" = some doubt, "low" = speculative) and "rationale" (one short sentence).`;
const SEMANTIC_PROMPT_ID = createHash('sha256').update(SEMANTIC_SYSTEM_PROMPT).update(SEMANTIC_REPLY_FORMAT).digest('hex').slice(0, 16);
// Haiku overflowed 2,048 on a batch of 20, which fails the whole batch. 6,000 was measured to fit.
const SEMANTIC_MAX_OUTPUT_TOKENS = 6000;
const SEMANTIC_RELATIONS = new Set(['same', 'part', 'version', 'overlap', 'different']);
const SEMANTIC_MAX_SPLITS = 2;

/**
 * Which side a "same" keeps. The model's choice when it names a side, with or
 * without a folder, in brackets or with .md. Models also invent a third name
 * (measured: a pair re-sent and paid for on three scans in a row because of it),
 * and that is still an answer, so the default is deterministic: the longer
 * opening, then the longer slug, then side A. Preview shows it and Flip changes it.
 */
function semanticKeepSlug(canonical, info) {
  const name = String(canonical || '').trim()
    .replace(/^\[+|\]+$/g, '')
    .replace(/\.md$/i, '')
    .replace(/^(entities|concepts)\//, '');
  if (name === info.slugA || name === info.slugB) return name;
  if (info.sampleA.length !== info.sampleB.length) return info.sampleA.length > info.sampleB.length ? info.slugA : info.slugB;
  if (info.slugA.length !== info.slugB.length) return info.slugA.length > info.slugB.length ? info.slugA : info.slugB;
  return info.slugA;
}

/**
 * The live candidate list, with the last answer kept for one domain.
 *
 * The list is a pure function of the page NAMES and the dismissals, and it takes
 * ~15 s of wall clock on a 3,300-page domain. With remembered answers it is asked
 * for far more often (the estimate, then the scan, then coverage after a merge and
 * on returning to the page), so it is worth not re-deriving when neither input
 * moved. One entry, so a large domain's list is the most this ever holds.
 *
 * AFTER A MERGE IT DOES NOT START AGAIN. When pages have only gone (a merge, here or
 * from another process, or a delete in Obsidian), the pairs touching them are taken
 * out of the kept list. That list EQUALS a full pass, order included, because:
 *   - whether a pair is a candidate and its score depend on those two names only
 *     (tokenizeSlug, candidatePairScore, jaroWinkler, the two shape tests), with no
 *     document frequency or other whole-domain figure;
 *   - each pass adds pairs by rising index, and removing a page keeps the others'
 *     relative order, so a stable sort breaks ties the same way;
 *   - dismissals are applied to the ranked list last, in both routes.
 * scripts/test-duplicate-job.js checks this against a full pass over thousands of
 * pages. Any new page goes the slow way: nothing is known about its pairs. So
 * `estimated` is false on either route, and `figuresFrom` says which it was.
 * `checkedPairs` can still fall by more than the removed pairs: a merge changes the
 * kept page's opening, and answers bound to the old opening no longer apply. That
 * is re-read from disk every time, never derived.
 */
let candidateMemo = null;
let candidateFullPasses = 0;

function removalOnly(memo, entities, concepts) {
  const now = new Set([...entities.map((f) => `entities/${f.slice(0, -3)}`), ...concepts.map((f) => `concepts/${f.slice(0, -3)}`)]);
  for (const page of now) if (!memo.pages.has(page)) return null;
  const gone = new Set();
  for (const page of memo.pages) if (!now.has(page)) gone.add(page);
  return { now, gone };
}

async function liveCandidates(domain, { reconcile = false } = {}) {
  const wikiDir = wikiPath(domain);
  if (!existsSync(wikiDir)) throw new Error(`No wiki found for domain: ${domain}`);
  const [entities, concepts, dismissed] = await Promise.all([
    listMd(wikiDir, 'entities'), listMd(wikiDir, 'concepts'), loadDismissed(domain),
  ]);
  const sig = createHash('sha256')
    .update(JSON.stringify([[...entities].sort(), [...concepts].sort(), [...dismissed.keys].sort()]))
    .digest('hex');
  const memo = candidateMemo && candidateMemo.domain === domain ? candidateMemo : null;
  // A reconcile only repeats the pass when the list on hand was derived: asking for
  // it on every panel open would make each open as slow as the worst case.
  const mustRecount = reconcile && memo && memo.figuresFrom === 'memo-filtered';
  if (memo && !mustRecount) {
    if (memo.sig === sig) return memo.result;
    const change = removalOnly(memo, entities, concepts);
    if (change) {
      const ranked = change.gone.size === 0 ? memo.ranked : memo.ranked.filter((p) =>
        !change.gone.has(`${p.folderA}/${p.slugA}`) && !change.gone.has(`${p.folderB}/${p.slugB}`));
      const filtered = filterDismissed(ranked, 'semanticDupe', dismissed.keys);
      const result = {
        pageCount: entities.length + concepts.length,
        pairs: filtered.kept,
        truncated: false,
        totalCandidates: filtered.kept.length,
        dismissed: filtered.dismissed,
      };
      candidateMemo = { domain, sig, result, ranked, pages: change.now, figuresFrom: 'memo-filtered' };
      return result;
    }
  }
  candidateFullPasses++;
  const { ranked, ...result } = await findSemanticCandidatePairs(domain, Number.MAX_SAFE_INTEGER, { includeRanked: true });
  const pages = new Set([...entities.map((f) => `entities/${f.slice(0, -3)}`), ...concepts.map((f) => `concepts/${f.slice(0, -3)}`)]);
  candidateMemo = { domain, sig, result, ranked, pages, figuresFrom: 'full-pass' };
  return result;
}

/** Where the list on hand came from, for the coverage a route reports. */
function candidateFigures(domain) {
  const from = candidateMemo && candidateMemo.domain === domain ? candidateMemo.figuresFrom : 'full-pass';
  return { figuresFrom: from, estimated: false };
}

/** Reads each page's opening once per pass. A page that cannot be read has an empty opening. */
function openingReader(wikiDir) {
  const cache = new Map();
  return async (folder, slug) => {
    const key = `${folder}/${slug}`;
    if (cache.has(key)) return cache.get(key);
    let text = '';
    try { text = pageOpening(await readFile(path.join(wikiDir, folder, slug + '.md'), 'utf8')); }
    catch { text = ''; }
    cache.set(key, text);
    return text;
  };
}

function coverageFields(total, checked, remembered, maxPairs) {
  const left = Math.max(0, total - checked);
  return {
    totalPairs: total, checkedPairs: checked, leftPairs: left,
    nextPairs: Math.min(left, maxPairs), rememberedPairs: remembered,
  };
}

/** A remembered `yes`, in the shape a scan reports a pair. Null when it no longer names this pair's two pages. */
function pairFromRecord(rec, p) {
  const a = `${p.folderA}/${p.slugA}`;
  const b = `${p.folderB}/${p.slugB}`;
  const keepIsA = rec.keep === a && rec.remove === b;
  const keepIsB = rec.keep === b && rec.remove === a;
  if (!keepIsA && !keepIsB) return null;
  const keep = keepIsA ? { slug: p.slugA, folder: p.folderA } : { slug: p.slugB, folder: p.folderB };
  const remove = keepIsA ? { slug: p.slugB, folder: p.folderB } : { slug: p.slugA, folder: p.folderA };
  return {
    keepSlug: keep.slug, keepFolder: keep.folder,
    removeSlug: remove.slug, removeFolder: remove.folder,
    confidence: rec.confidence,
    rationale: typeof rec.rationale === 'string' && rec.rationale ? rec.rationale : 'No rationale provided.',
    spellingVariant: isSpellingVariant(keep.slug, remove.slug),
    nameRelation: nameRelation(keep.slug, remove.slug),
    remembered: true,
  };
}

/** Whether a remembered answer still applies to this pair: same model, instructions and openings. */
async function answerApplies(rec, p, info, readOpening) {
  if (!rec || !info || rec.provider !== info.provider || rec.model !== info.model || rec.prompt !== SEMANTIC_PROMPT_ID) return false;
  const [a, b] = await Promise.all([readOpening(p.folderA, p.slugA), readOpening(p.folderB, p.slugB)]);
  if (rec.openings !== openingsHash(p.folderA, p.slugA, a, p.folderB, p.slugB, b)) return false;
  return rec.verdict !== 'yes' || pairFromRecord(rec, p) !== null;
}

/**
 * Pairs touching a page a recent ingest created go first; each side keeps its own
 * order, so spelling variants still lead among the new pairs. An empty or lost record
 * returns the list as it came. The pages and pairs it reports are read off the
 * unanswered LIVE list, so a page that was deleted or merged cannot be counted.
 */
function newPagesFirst(toCheck, recorded) {
  if (recorded.size === 0) return { ordered: toCheck, recentNewPages: { pages: 0, pairs: 0 } };
  const first = [];
  const rest = [];
  const pages = new Set();
  for (const p of toCheck) {
    const a = `${p.folderA}/${p.slugA}`;
    const b = `${p.folderB}/${p.slugB}`;
    const isA = recorded.has(a);
    const isB = recorded.has(b);
    if (isA) pages.add(a);
    if (isB) pages.add(b);
    (isA || isB ? first : rest).push(p);
  }
  return { ordered: first.concat(rest), recentNewPages: { pages: pages.size, pairs: first.length } };
}

/**
 * What an ingest's result says about the pages it just created: how many have a
 * candidate pair not answered yet. No provider call and no write. Null when no page
 * was created or a comparison could not run on this domain; `comparable: 0` when
 * pages were created and none has a pair (a batch adds these up, so it needs the
 * pages either way).
 *
 * @param {string} domain
 * @param {string[]} pageKeys — the created pages, as 'concepts/slug' / 'entities/slug'
 * @returns {Promise<{newPages:number, comparable:number, pairs:number}|null>}
 */
export async function newPagesToCompare(domain, pageKeys) {
  if (!Array.isArray(pageKeys) || pageKeys.length === 0) return null;
  const candidates = await candidatePairsTouching(domain, pageKeys);
  if (!candidates) return null;
  let info = null;
  try { info = getProviderInfo(); } catch { info = null; }
  const checks = await loadDuplicateChecks(domain);
  const readOpening = openingReader(wikiPath(domain));
  const wanted = new Set(pageKeys);
  const pages = new Set();
  let pairs = 0;
  for (const p of candidates) {
    const rec = checks.get(pairKey(p.folderA, p.slugA, p.folderB, p.slugB));
    if (await answerApplies(rec, p, info, readOpening)) continue;
    pairs++;
    for (const page of [`${p.folderA}/${p.slugA}`, `${p.folderB}/${p.slugB}`]) if (wanted.has(page)) pages.add(page);
  }
  return { newPages: pageKeys.length, comparable: pages.size, pairs };
}

/**
 * Sort the live pairs into already answered and still to check. This is the one
 * layer that knows about remembered answers and recently created pages;
 * findSemanticCandidatePairs stays free of both. No provider call and no write.
 */
async function planSemanticScan(domain, maxPairs, readOpening, candidateOpts) {
  const { pairs: live, pageCount } = await liveCandidates(domain, candidateOpts);
  let info = null;
  try { info = getProviderInfo(); } catch { info = null; }
  const checks = await loadDuplicateChecks(domain);
  const toCheck = [];
  const remembered = [];
  let checked = 0;
  let work = 0;
  for (const p of live) {
    const rec = checks.get(pairKey(p.folderA, p.slugA, p.folderB, p.slugB));
    const applies = await answerApplies(rec, p, info, readOpening);
    if (applies && rec.verdict === 'yes') remembered.push(pairFromRecord(rec, p));
    if (applies) checked++; else toCheck.push(p);
    if (++work >= 2000) { work = 0; await new Promise((resolve) => setImmediate(resolve)); }
  }
  const { ordered, recentNewPages } = newPagesFirst(toCheck, await loadRecentNewPages(domain));
  return { live, pageCount, toCheck: ordered, remembered, checked, send: ordered.slice(0, maxPairs), recentNewPages, info };
}

/**
 * The remembered pairs alone, with NO candidate pass: what the panel shows at once
 * when you come back to a domain, because deriving the list takes ~15 s on a large
 * one. Only pairs whose answer still applies and that are not dismissed.
 */
export async function semanticRememberedPairs(domain) {
  const checks = await loadDuplicateChecks(domain);
  if (checks.size === 0) return { hasChecks: false, pairs: [] };
  let info = null;
  try { info = getProviderInfo(); } catch { return { hasChecks: false, pairs: [] }; }
  const wikiDir = wikiPath(domain);
  const readOpening = openingReader(wikiDir);
  const { keys } = await loadDismissed(domain);
  const pairs = [];
  for (const [key, rec] of checks) {
    if (rec.verdict !== 'yes' || rec.provider !== info.provider || rec.model !== info.model || rec.prompt !== SEMANTIC_PROMPT_ID) continue;
    const [a, b] = key.split('||').map((side) => {
      const at = side.indexOf('/');
      return { folder: side.slice(0, at), slug: side.slice(at + 1) };
    });
    if (![a, b].every((p) => (p.folder === 'entities' || p.folder === 'concepts') && isMergeableSlug(p.slug)
      && existsSync(path.join(wikiDir, p.folder, p.slug + '.md')))) continue;
    const p = { folderA: a.folder, slugA: a.slug, folderB: b.folder, slugB: b.slug };
    if (filterDismissed([p], 'semanticDupe', keys).kept.length === 0) continue;
    const [oa, ob] = await Promise.all([readOpening(a.folder, a.slug), readOpening(b.folder, b.slug)]);
    if (rec.openings !== openingsHash(a.folder, a.slug, oa, b.folder, b.slug, ob)) continue;
    const pair = pairFromRecord(rec, p);
    if (pair) pairs.push(pair);
  }
  return { hasChecks: true, pairs };
}

/**
 * Coverage and the remembered pairs, for the panel to open with after a reload.
 * Free: no provider call, and with nothing remembered it answers without even
 * deriving the candidate list, so a domain nobody has scanned costs one file read.
 */
export async function semanticScanStatus(domain, maxPairs = SEMANTIC_DUPE_DEFAULT_CAP, { reconcile = false } = {}) {
  const checks = await loadDuplicateChecks(domain);
  if (checks.size === 0) return { hasChecks: false };
  const plan = await planSemanticScan(domain, maxPairs, openingReader(wikiPath(domain)), { reconcile });
  if (!plan.info) return { hasChecks: false }; // no provider: nothing can be said to apply
  return {
    hasChecks: true,
    pairs: plan.remembered,
    ...coverageFields(plan.live.length, plan.checked, plan.remembered.length, maxPairs),
    recentNewPages: plan.recentNewPages,
    ...candidateFigures(domain),
  };
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
  const plan = await planSemanticScan(domain, maxPairs, openingReader(wikiPath(domain)));
  // Only the pairs that will really be sent are priced. `candidatePairs` keeps
  // its meaning (what this scan sends); `totalCandidates` is every live pair.
  const estimatedTokens = plan.send.length * EST_TOKENS_PER_PAIR;
  const { provider, model } = getProviderInfo();
  // Rough 60/40 input/output split
  return {
    pageCount: plan.pageCount,
    candidatePairs: plan.send.length,
    totalCandidates: plan.live.length,
    truncated: plan.toCheck.length > maxPairs,
    ...coverageFields(plan.live.length, plan.checked, plan.remembered.length, maxPairs),
    recentNewPages: plan.recentNewPages,
    ...candidateFigures(domain),
    estimatedTokens,
    ...costFields(provider, model, estimatedTokens * HEALTH_TOKEN_SPLIT.semanticDupes.input, estimatedTokens * HEALTH_TOKEN_SPLIT.semanticDupes.output),
    provider,
    model,
  };
}

/**
 * Tokens one pair costs, for the "Compare all remaining" estimate. The per-run
 * estimate above keeps its 400 (a ceiling's budget, and pinned as such); a whole
 * pass needs a figure that can sit beside a stop at 120%.
 *
 * gemini-2.5-flash-lite: $0.046 per 1,000 pairs is the v3.91.0 measurement (a full
 * pass of 36,332 pairs, about $1.70). The split is derived, not measured: a batch of
 * 20 sends two openings of at most 500 characters per pair (about 280 tokens with
 * its share of the instructions), and the output is what the dollars leave over.
 * claude-haiku-5-5: about 450 tokens per pair is measured (v3.91.0, "10-15% low"
 * against 400); its split is assumed.
 * Everything else is unmeasured: Haiku's figure, the larger of the two, is used and
 * the estimate says `rateBasis: 'assumed'`.
 */
const COMPARE_PAIR_TOKENS = Object.freeze({
  'gemini-2.5-flash-lite': Object.freeze({ input: 280, output: 45, basis: 'measured' }),
  'claude-haiku-5-5': Object.freeze({ input: 290, output: 160, basis: 'measured-tokens' }),
});
const COMPARE_PAIR_TOKENS_DEFAULT = Object.freeze({ input: 290, output: 160, basis: 'assumed' });
/** Measured on Flash Lite at v3.91.0 (36,332 pairs in about 100 minutes). Stated as assumed for any other model. */
const COMPARE_SECONDS_PER_PAIR = 0.165;

/**
 * The confirm for "Compare all remaining": every pair not yet answered, in tokens,
 * dollars and time. No provider call and no write.
 *
 * PRICE. Per call, a batch's prompt is about 6,000 tokens and is known in advance, so
 * a tiered model is quoted at the tier that prompt really falls in (through
 * `estimateRates`, with its margin), and never at a flat rate. A free model has
 * `estimatedUsd: null` and `priceKnown: true`, and an unpriced one `priceKnown: false`,
 * as on every other estimate. Those two are confirmed in tokens instead.
 *
 * A FALLBACK. This figure is for the model configured now, and says so. If that model
 * is unavailable the chain moves forward to a newer model that usually costs more
 * (2.5x in and 3.75x out for Flash Lite's first rung), so the estimate would be low.
 * Nothing here pretends otherwise: `fallbackNote` is shown with it, the job prices
 * each call at the model that really answered, reports `answeredBy`, and the stop at
 * 120% is of dollars billed, so a dearer rung stops the job early and says why.
 */
export async function estimateCompareAll(domain) {
  const plan = await planSemanticScan(domain, Number.MAX_SAFE_INTEGER, openingReader(wikiPath(domain)));
  const { provider, model } = getProviderInfo();
  const pairs = plan.toCheck.length;
  const rate = COMPARE_PAIR_TOKENS[model] || COMPARE_PAIR_TOKENS_DEFAULT;
  const inputTokens = pairs * rate.input;
  const outputTokens = pairs * rate.output;
  const promptBound = SEMANTIC_BATCH_SIZE * rate.input * TIER_ESTIMATE_MARGIN;
  let cost;
  if (isFreeModel(model)) {
    cost = costFields(provider, model, inputTokens, outputTokens);
  } else {
    const r = estimateRates(model, promptBound);
    cost = r
      ? { estimatedUsd: (inputTokens * r.input + outputTokens * r.output) / 1_000_000, priceKnown: true, costNote: null }
      : costFields(provider, model, inputTokens, outputTokens);
  }
  return {
    pageCount: plan.pageCount,
    pairs,
    batches: Math.ceil(pairs / SEMANTIC_BATCH_SIZE),
    ...coverageFields(plan.live.length, plan.checked, plan.remembered.length, pairs),
    recentNewPages: plan.recentNewPages,
    ...candidateFigures(domain),
    estimatedTokens: inputTokens + outputTokens,
    ...cost,
    estimatedSeconds: Math.ceil(pairs * COMPARE_SECONDS_PER_PAIR),
    rateBasis: rate.basis,
    timeBasis: model === 'gemini-2.5-flash-lite' ? 'measured' : 'assumed',
    provider,
    model,
    fallbackNote: 'Priced on this model. If it is unavailable the app may answer on a newer model that costs more; the job counts what is really billed and stops at your limit.',
  };
}

/**
 * Run the real semantic-duplicate scan. Yields progress events through
 * `onEvent({type, ...})` so the HTTP layer can forward them over SSE.
 *
 * Event shapes:
 *   { type: 'start', candidatePairs, batches, ...coverage } — `candidatePairs` is what will be SENT
 *   { type: 'progress', processed, total, found }
 *   { type: 'pair', pair }                       — one duplicate pair, new or remembered
 *   { type: 'done', pairs, cost, spent, failedPairs, ...coverage } — final summary (`spent` v3.67.0)
 *
 * `coverage` is {totalPairs, checkedPairs, leftPairs, nextPairs, rememberedPairs}.
 * A pair already answered for these two openings by this model is not sent
 * again; a remembered `yes` comes back free. Nothing to send: no provider call.
 *
 * The LLM is asked, per batch, to judge each pair as duplicate / not-duplicate
 * and pick the canonical slug. Low-confidence and non-duplicate verdicts are
 * filtered out; only medium+high duplicates survive to the UI.
 *
 * NO WIKI WRITES. Application is through POST /api/health/:domain/fix with
 * type: 'semanticDupe'. The one write is the machine-local record of the
 * answers, outside domains/, saved after EACH batch so a scan that dies keeps
 * what it paid for (src/brain/duplicate-checks.js).
 */
export async function scanSemanticDuplicates(domain, opts = {}, onEvent = () => {}) {
  // The ceiling's default is config's own (v3.72.1) — every production caller
  // passes the user's setting, and a second literal here is how the two
  // defaults came to disagree in the first place.
  const { maxPairs = SEMANTIC_DUPE_DEFAULT_CAP, costCeilingTokens = DEFAULT_AI_HEALTH.costCeilingTokens } = opts;
  // v3.67.0: `opts.generateText` is a TEST-ONLY seam (the compile.js
  // precedent; null in production, where the routes pass `{}`), and every
  // provider call reports into one accumulator so the done event can say
  // what the run actually cost. `opts.onUsage` is forwarded when given.
  const llm = typeof opts.generateText === 'function' ? opts.generateText : generateText;
  const usage = makeUsageAccumulator(typeof opts.onUsage === 'function' ? opts.onUsage : null);
  // The compare-all job's two additions. `shouldStop` is asked before EVERY provider
  // call, a split's halves included, and it ends the run cleanly: what is saved stays
  // saved. `liveWiki` is for a run long enough for the wiki to change under it: it
  // drops pairs whose page has gone before paying for them, and reads openings fresh
  // for each batch rather than remembering them from when the run began.
  const shouldStop = typeof opts.shouldStop === 'function' ? opts.shouldStop : null;
  let stopped = false;

  const wikiDir = wikiPath(domain);
  if (!existsSync(wikiDir)) throw new Error(`No wiki found for domain: ${domain}`);

  let readOpening = openingReader(wikiDir);
  const plan = await planSemanticScan(domain, maxPairs, readOpening);
  const candidatePairs = plan.send;

  // Hard ceiling: abort before any LLM call if we'd exceed the user's budget.
  // Counts only what will really be sent.
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

  const totalPairs = plan.live.length;
  const rememberedPairs = plan.remembered.length;
  let checkedPairs = plan.checked;
  let failedPairs = 0;

  onEvent({
    type: 'start', candidatePairs: candidatePairs.length, batches: batches.length,
    ...coverageFields(totalPairs, checkedPairs, rememberedPairs, maxPairs),
    recentNewPages: plan.recentNewPages,
  });

  // A scan is the one place that already saves beside the wiki: drop any recorded
  // page that has since been deleted or merged. Never fails a scan.
  await pruneRecentNewPages(domain, wikiDir);

  // Listed again, at no cost, so a found pair neither vanishes nor flips between runs.
  const acceptedPairs = [];
  for (const pair of plan.remembered) {
    acceptedPairs.push(pair);
    onEvent({ type: 'pair', pair });
  }

  let processed = 0;
  let totalInputChars = 0;
  let totalOutputChars = 0;

  const systemPrompt = SEMANTIC_SYSTEM_PROMPT;

  // One call. A reply the scan cannot use, or one cut off at the output limit, may
  // simply have been too long or unlucky, so that batch is split in half and each
  // half tried, at most SEMANTIC_MAX_SPLITS levels deep. Measured: 6 of 125 real
  // batches failed this way, costing 20 pairs each. An auth, quota, rate-limit or
  // network error is not about this batch, so it fails as it always did. Every
  // call reports into the same accumulator, so retries are in what the run spent.
  const judgeBatch = async (batch, bi, depth) => {
    if (stopped || (shouldStop && shouldStop())) { stopped = true; return; }
    const batchInfo = [];
    for (let i = 0; i < batch.length; i++) {
      const p = batch[i];
      const [sampleA, sampleB] = await Promise.all([
        readOpening(p.folderA, p.slugA),
        readOpening(p.folderB, p.slugB),
      ]);
      batchInfo.push({
        index: i,
        slugA: p.slugA, folderA: p.folderA, sampleA,
        slugB: p.slugB, folderB: p.folderB, sampleB,
      });
    }

    const userPrompt =
      `Judge each of these ${batch.length} candidate pairs. Return JSON:\n` +
      SEMANTIC_REPLY_FORMAT + `\n\n` +
      `PAIRS:\n` +
      batchInfo.map(b =>
        `--- PAIR ${b.index} ---\n` +
        `A: [${b.folderA}/${b.slugA}]\n${b.sampleA || '(empty)'}\n\n` +
        `B: [${b.folderB}/${b.slugB}]\n${b.sampleB || '(empty)'}\n`
      ).join('\n');

    totalInputChars += systemPrompt.length + userPrompt.length;

    let raw, parsed;
    let replied = false;
    try {
      raw = await llm(systemPrompt, userPrompt, SEMANTIC_MAX_OUTPUT_TOKENS, 'json', null, { onUsage: usage.onUsage });
      replied = true;
      totalOutputChars += (raw || '').length;
      parsed = parseJSON(raw);
      // jsonrepair turns prose into a JSON string, so "it parsed" is no answer.
      if (!parsed || !Array.isArray(parsed.results)) throw new Error('The AI reply was not in the expected shape.');
    } catch (err) {
      if ((replied || isOutputTokenLimit(err)) && depth < SEMANTIC_MAX_SPLITS && batch.length > 1) {
        const mid = Math.ceil(batch.length / 2);
        await judgeBatch(batch.slice(0, mid), bi, depth + 1);
        await judgeBatch(batch.slice(mid), bi, depth + 1);
        return;
      }
      failedPairs += batch.length;
      onEvent({ type: 'batch-error', batch: bi, error: err.message });
      return;
    }

    // parseJSON is lenient: its output is validated here, never truth-tested.
    // A valid index with a valid relation always remembers something, so a pair
    // the model has answered can never come back and be paid for again. What
    // stays unchecked: a failed call, an index missing from the reply, or a
    // relation that is not one of the five.
    if (!plan.info) plan.info = getProviderInfo();
    const now = new Date().toISOString();
    const answered = new Map();
    const seenIndex = new Set();
    for (const r of parsed.results) {
      if (!r || typeof r !== 'object') continue;
      const idx = Number(r.index);
      if (!Number.isInteger(idx) || idx < 0 || idx >= batch.length || seenIndex.has(idx)) continue;
      const relation = typeof r.relation === 'string' ? r.relation.trim().toLowerCase() : '';
      if (!SEMANTIC_RELATIONS.has(relation)) continue;
      seenIndex.add(idx);
      const given = String(r.confidence || '').trim().toLowerCase();
      const pair = batch[idx];
      const info = batchInfo[idx];
      const record = {
        provider: plan.info.provider, model: plan.info.model, prompt: SEMANTIC_PROMPT_ID,
        openings: openingsHash(pair.folderA, pair.slugA, info.sampleA, pair.folderB, pair.slugB, info.sampleB),
        at: now,
      };
      const key = pairKey(pair.folderA, pair.slugA, pair.folderB, pair.slugB);
      if (relation !== 'same' || given === 'low') {
        answered.set(key, { ...record, verdict: 'no' });
        continue;
      }
      // A "same" with no usable confidence is listed for a Preview, never for the batch.
      const conf = given === 'high' ? 'high' : 'medium';
      const keepSlug = semanticKeepSlug(r.canonicalSlug, info);
      const keepFolder = keepSlug === pair.slugA ? pair.folderA : pair.folderB;
      const removeSlug = keepSlug === pair.slugA ? pair.slugB : pair.slugA;
      const removeFolder = keepSlug === pair.slugA ? pair.folderB : pair.folderA;
      const rationale = String(r.rationale || r.difference || '').trim() || 'No rationale provided.';
      answered.set(key, {
        ...record, verdict: 'yes',
        keep: `${keepFolder}/${keepSlug}`, remove: `${removeFolder}/${removeSlug}`,
        confidence: conf, rationale: rationale.slice(0, 500),
      });
      const accepted = {
        keepSlug, keepFolder,
        removeSlug, removeFolder,
        confidence: conf,
        rationale,
        spellingVariant: isSpellingVariant(keepSlug, removeSlug),
        nameRelation: nameRelation(keepSlug, removeSlug),
        remembered: false,
      };
      acceptedPairs.push(accepted);
      onEvent({ type: 'pair', pair: accepted });
    }

    // BEFORE the progress event: an interrupted scan keeps what it paid for.
    await saveDuplicateChecks(domain, answered);
    checkedPairs += answered.size;
  };

  for (let bi = 0; bi < batches.length; bi++) {
    // Here as well as before each call: a batch whose pages have all gone makes no call.
    if (shouldStop && shouldStop()) { stopped = true; break; }
    let batch = batches[bi];
    if (opts.liveWiki) {
      readOpening = openingReader(wikiDir);
      batch = batch.filter((p) => existsSync(path.join(wikiDir, p.folderA, p.slugA + '.md')) && existsSync(path.join(wikiDir, p.folderB, p.slugB + '.md')));
    }
    if (batch.length) await judgeBatch(batch, bi, 0);
    if (stopped) break;
    processed += batches[bi].length;
    onEvent({ type: 'progress', processed, total: candidatePairs.length, found: acceptedPairs.length, checkedPairs });
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
  // `cost` is unchanged (chars ÷ 4, kept for every existing reader); `spent`
  // (v3.67.0) is the provider-reported figure, in the one actual shape.
  const spent = (await aiRun()).spentFromUsage(usage.totals);
  const coverage = coverageFields(totalPairs, checkedPairs, rememberedPairs, maxPairs);
  const ended = stopped ? { stopped: true } : {};
  onEvent({ type: 'done', pairs: acceptedPairs, cost, spent, failedPairs, ...coverage, ...ended });
  return { pairs: acceptedPairs, cost, spent, failedPairs, ...coverage, ...ended };
}

/**
 * Open pairs grouped by the pages they share, for one decision per family. READ-ONLY:
 * no provider call and no write, and it derives no candidate list.
 *
 * A~B AND B~C DO NOT PROVE A~C. A family is only "these pages are connected by
 * answers", so every statement about a page and the page that stays is looked up for
 * that exact pair and is one of:
 *   'same' / 'different'  the AI compared these two, and that answer still applies
 *   'stale'               it answered once, but about other openings or on another model
 *   'kept-both'           the user decided to keep these two
 *   'never'               the AI never compared them
 * `suggestedStay` is the page with the most open pairs, then the page the AI named as
 * the keeper most often, then the first by name. It decides nothing.
 */
export async function semanticFamilies(domain, { stay = null } = {}) {
  const wikiDir = wikiPath(domain);
  if (!existsSync(wikiDir)) throw new Error(`No wiki found for domain: ${domain}`);
  const { pairs } = await semanticRememberedPairs(domain);
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(x) !== root) { const next = parent.get(x); parent.set(x, root); x = next; }
    return root;
  };
  const degree = new Map();
  const keeper = new Map();
  for (const p of pairs) {
    const k = `${p.keepFolder}/${p.keepSlug}`;
    const r = `${p.removeFolder}/${p.removeSlug}`;
    parent.set(find(k), find(r));
    degree.set(k, (degree.get(k) || 0) + 1);
    degree.set(r, (degree.get(r) || 0) + 1);
    keeper.set(k, (keeper.get(k) || 0) + 1);
  }
  const groups = new Map();
  for (const page of parent.keys()) {
    const root = find(page);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(page);
  }

  const info = (() => { try { return getProviderInfo(); } catch { return null; } })();
  const checks = await loadDuplicateChecks(domain);
  const { keys: dismissedKeys } = await loadDismissed(domain);
  const readOpening = openingReader(wikiDir);
  const split = (page) => { const at = page.indexOf('/'); return { folder: page.slice(0, at), slug: page.slice(at + 1) }; };

  const between = async (x, y) => {
    const a = split(x);
    const b = split(y);
    if (dismissedKeys.has(keyForIssue('semanticDupe', { folderA: a.folder, slugA: a.slug, folderB: b.folder, slugB: b.slug }))) {
      return { compared: 'kept-both' };
    }
    const rec = checks.get(pairKey(a.folder, a.slug, b.folder, b.slug));
    if (!rec) return { compared: 'never' };
    const [oa, ob] = await Promise.all([readOpening(a.folder, a.slug), readOpening(b.folder, b.slug)]);
    const applies = info && rec.provider === info.provider && rec.model === info.model && rec.prompt === SEMANTIC_PROMPT_ID
      && rec.openings === openingsHash(a.folder, a.slug, oa, b.folder, b.slug, ob);
    if (!applies) return { compared: 'stale' };
    if (rec.verdict !== 'yes') return { compared: 'different' };
    return { compared: 'same', confidence: rec.confidence, rationale: rec.rationale || 'No rationale provided.' };
  };

  const families = [];
  for (const pagesOf of groups.values()) {
    const pagesSorted = [...pagesOf].sort();
    const suggestedStay = [...pagesSorted].sort((x, y) =>
      (degree.get(y) - degree.get(x)) || ((keeper.get(y) || 0) - (keeper.get(x) || 0)) || (x < y ? -1 : 1))[0];
    const stays = stay && pagesSorted.includes(stay) ? stay : suggestedStay;
    const pages = [];
    for (const page of pagesSorted) {
      const { folder, slug } = split(page);
      pages.push({
        page, folder, slug,
        opening: await readOpening(folder, slug),
        ...(page === stays ? { stays: true } : { ...(await between(page, stays)), nameRelation: nameRelation(slug, split(stays).slug) }),
      });
    }
    const inFamily = new Set(pagesOf);
    const openPairs = pairs.filter((p) => inFamily.has(`${p.keepFolder}/${p.keepSlug}`)).length;
    families.push({ size: pages.length, openPairs, suggestedStay, stays, pages });
  }
  families.sort((a, b) => (b.size - a.size) || (a.suggestedStay < b.suggestedStay ? -1 : 1));
  return { families, openPairs: pairs.length };
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

// ── Polarity / version discriminators (v3.9.1) ──────────────────────────────
//
// `isLexicalVariant` below is a TOKEN-COUNT filter, not a semantic one. For two
// slugs of n tokens sharing k, Jaccard is k/(2n−k), so "differ by exactly one
// token" is accepted whenever n ≥ 3 and "differ by two" whenever n ≥ 6 —
// REGARDLESS OF WHICH token differs. Versions and negations are the two token
// classes where a single differing token flips the MEANING rather than shading
// it, so they are refused up front, before either branch runs.
//
// Measured examples that used to be accepted (see test §2b/§2c):
//   claude-sonnet-4.5 → claude-sonnet-3.5   J=0.500  (the dot is deleted by
//                                                     slugify, so 4.5 → "45")
//   q1-2025-results   → q1-2024-results     J=0.500
//   data-retained     → data-not-retained   SUBSET   (no threshold reaches it)
// A wrong retarget is a factually wrong edge in a wiki about AI models. A false
// REJECT only strips the brackets and keeps the readable text, so the two error
// directions are not remotely symmetric and these gates lean hard toward refuse.

/** A token carrying a digit is a version/number, not a synonym: 4, 45, 2025, q1, v3, 4o. */
const hasDigit = (t) => /\d/.test(t);

// Standalone negation words. `un` and `dis` are deliberately ABSENT: English
// does not hyphenate them ("unsafe", "disabled" are ONE token, handled by the
// morphological rule below), so a bare `un` token is far more likely to be the
// United Nations than a negation. `in` is absent for the opposite reason — it is
// a preposition ("ai-in-medicine") and would false-reject constantly.
const NEGATION_MARKERS = new Set(['not', 'non', 'no', 'never', 'without', 'anti']);

// Morphological negation: `secure` vs `insecure`, `valid` vs `invalid`,
// `deterministic` vs `nondeterministic`. A RULE, not a list, so it generalises.
// `de` is excluded on purpose — `debug`/`bug`, `design`/`sign`, `deploy`/`ploy`
// are not negations, and a gate whose comment claims "negation" must not quietly
// be doing something else.
const NEGATION_PREFIXES = ['un', 'non', 'in', 'im', 'ir', 'il', 'dis', 'anti'];
const MIN_NEGATION_STEM = 4;

// Polarity pairs morphology cannot derive. Deliberately short and evidence-shaped;
// it is NOT a complete antonym dictionary and is not claimed to be (see the
// NOT ENFORCED block on isLexicalVariant).
const POLARITY_PAIRS = [
  ['enabled', 'disabled'], ['enable', 'disable'], ['allow', 'deny'],
  ['allowed', 'blocked'], ['include', 'exclude'], ['included', 'excluded'],
  ['on', 'off'], ['true', 'false'], ['open', 'closed'], ['before', 'after'],
  ['pre', 'post'], ['input', 'output'], ['read', 'write'],
  ['public', 'private'], ['local', 'remote'], ['sync', 'async'],
  ['success', 'failure'], ['added', 'removed'], ['retained', 'deleted'],
];
const POLARITY_PAIR_KEYS = new Set(POLARITY_PAIRS.map(([x, y]) => [x, y].sort().join('|')));

function isMorphologicalNegation(stem, candidate) {
  if (stem.length < MIN_NEGATION_STEM) return false;
  return NEGATION_PREFIXES.some(p => candidate === p + stem);
}

/**
 * True when the two token lists differ on a VERSION or a POLARITY token — i.e.
 * they name opposite or differently-numbered things, however much other
 * vocabulary they share. Compares only the symmetric difference: a version or a
 * negation present on BOTH sides is shared context, not a discriminator.
 */
function differsOnVersionOrPolarity(aTok, bTok) {
  const aSet = new Set(aTok), bSet = new Set(bTok);
  const onlyA = aTok.filter(t => !bSet.has(t));
  const onlyB = bTok.filter(t => !aSet.has(t));
  if (onlyA.some(hasDigit) || onlyB.some(hasDigit)) return true;
  if (onlyA.some(t => NEGATION_MARKERS.has(t)) || onlyB.some(t => NEGATION_MARKERS.has(t))) return true;
  for (const x of onlyA) {
    for (const y of onlyB) {
      if (isMorphologicalNegation(x, y) || isMorphologicalNegation(y, x)) return true;
      if (POLARITY_PAIR_KEYS.has([x, y].sort().join('|'))) return true;
    }
  }
  return false;
}

/**
 * Lexical-variant gate (v3.0.1-beta.16, hardened v3.9.1). The LLM happily maps a
 * generic broken link to the "nearest" page even when it's a DIFFERENT concept
 * (e.g. "context-window" → "agent-memory", "big-data" → "ai-and-weather-…").
 * Those create wrong graph edges — worse than a broken link. We only ACCEPT an
 * AI retarget when the broken slug and the target slug share enough word-level
 * evidence to be the SAME thing (a spelling/ordering variant, an acronym
 * expansion that overlaps, or one being a token-subset of the other, like
 * "iot" ⊂ "iot-and-ai"). Anything weaker falls through to "strip" — which is
 * exactly the user's chosen behaviour for genuinely-missing pages.
 *
 * ENFORCED — a retarget is refused when:
 *   • the slugs differ on a token containing a DIGIT (version/year/number), so
 *     claude-sonnet-4.5 → claude-sonnet-3.5 and q1-2025 → q1-2024 cannot pass;
 *   • the slugs differ on a negation marker, a morphological negation
 *     (`secure`/`insecure`), or a listed polarity pair (`input`/`output`), so
 *     data-retained → data-not-retained cannot pass — including via the SUBSET
 *     branch, which no threshold change can reach;
 *   • one side is a token-subset of the other but that side is a single generic
 *     token under 3 chars. This was the v3.0.1-beta.17 "M4" guard; it was
 *     DECORATIVE for eight releases because it merely skipped the subset branch
 *     and the Jaccard line below then accepted anyway at exactly 0.5 whenever
 *     the other slug had two tokens (`whisper-ai` → `ai`, `ml` → `ml-ops`). A
 *     subset relation is now DECIDED here and never falls through.
 *
 * NOT ENFORCED — say which half is guarded, or the next reviewer stops looking:
 *   • A SPECIFIC concept retargeted onto its GENERIC PARENT still passes, and is
 *     the DOMINANT real-world failure — measured at 33 of 57 gate-approved
 *     targets across the maintainer's six domains: [[agent-memory]] → `memory`,
 *     [[human-amplification]] → `human`, [[pilot-light-model]] → `model`. These
 *     are subset relations with a ≥3-char parent token, and the SAME shape as
 *     `iot` ⊂ `iot-and-ai`, which this suite asserts as a legitimate PASS.
 *     Narrowing it changes intended semantics and is a product decision, not a
 *     bug fix; the known cases are listed in test-beta16-broken-links.js §2e.
 *   • A punctuation-vs-hyphen version variant (`claude-sonnet-4.5` →
 *     `claude-sonnet-4-5`, the CORRECT retarget) is refused too: slugify deletes
 *     the dot, so the version tokens read "45" vs "4","5" and the digit rule
 *     cannot tell a rewrite from a change. It strips instead — the safe
 *     direction, but it does mean the gate cannot repair that link.
 *   • POLARITY_PAIRS is not a complete antonym dictionary, and never will be.
 *
 * Returns true if `targetSlug` is a plausible same-thing variant of `brokenSlug`.
 */
export function isLexicalVariant(brokenSlug, targetSlug) {
  const a = slugifyText(String(brokenSlug || '').replace(/^summaries\//, ''));
  const b = slugifyText(String(targetSlug || '').replace(/^summaries\//, ''));
  if (!a || !b) return false;
  if (a === b) return true;
  const aTok = a.split('-').filter(Boolean);
  const bTok = b.split('-').filter(Boolean);
  if (!aTok.length || !bTok.length) return false;
  // Pre-gate, ahead of BOTH branches: a version or polarity difference means
  // these are different things no matter how much vocabulary they share.
  if (differsOnVersionOrPolarity(aTok, bTok)) return false;
  const aSet = new Set(aTok), bSet = new Set(bTok);
  // One side is a token-subset of the other: "iot" ⊂ "iot-and-ai",
  // "software-development-efficiency" ⊂ "...-enhancement", reorderings, etc.
  // BUT a single SHORT generic token must not match a much longer slug — "ai" ⊂
  // "ai-and-weather-forecasting" is a different concept, not a variant. Require a
  // 1-token subset side to be ≥3 chars (keeps "iot"/"mcp"/"gpt", rejects "ai"/"ml").
  const subsetOk = (subTok) => subTok.length >= 2 || (subTok[0] && subTok[0].length >= 3);
  const aIsSubset = aTok.every(t => bSet.has(t));
  const bIsSubset = bTok.every(t => aSet.has(t));
  if (aIsSubset || bIsSubset) {
    // A subset relation DECIDES the verdict. Returning here rather than falling
    // through is the whole of the M4 fix: the old code skipped the branch when
    // subsetOk refused and let Jaccard say yes anyway.
    if (aIsSubset && subsetOk(aTok)) return true;
    if (bIsSubset && subsetOk(bTok)) return true;
    return false;
  }
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
export function buildLinkResolver(entitySlugs, conceptSlugs, summarySlugs) {
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
    ...costFields(provider, model, estimatedTokens * HEALTH_TOKEN_SPLIT.brokenLinks.input, estimatedTokens * HEALTH_TOKEN_SPLIT.brokenLinks.output),
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
 *   { type: 'done', plan, summary, cost, spent }   (`spent` v3.67.0: spentFromUsage)
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
  // v3.67.0: `opts.generateText` is a TEST-ONLY seam (the compile.js
  // precedent; null in production, where the routes pass `{}`), and every
  // provider call reports into one accumulator so the done event can say
  // what the run actually cost. `opts.onUsage` is forwarded when given.
  const llm = typeof opts.generateText === 'function' ? opts.generateText : generateText;
  const usage = makeUsageAccumulator(typeof opts.onUsage === 'function' ? opts.onUsage : null);
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
      const raw = await llm(systemPrompt, userPrompt, 4096, 'json', null, { onUsage: usage.onUsage });
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

  const spent = (await aiRun()).spentFromUsage(usage.totals);   // v3.67.0, additive beside `cost`
  onEvent({ type: 'done', plan, summary, cost, spent });
  return { plan, summary, cost, spent };
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
    ...costFields(provider, model, estimatedTokens * HEALTH_TOKEN_SPLIT.orphans.input, estimatedTokens * HEALTH_TOKEN_SPLIT.orphans.output),
    provider, model,
  };
}

/**
 * Plan a bulk orphan rescue. Streams progress via onEvent for SSE.
 *
 * Event shapes:
 *   { type: 'start', orphans, batches }
 *   { type: 'progress', processed, total }
 *   { type: 'done', plan, summary, cost, spent }   (`spent` v3.67.0: spentFromUsage)
 *
 * Each plan entry: { orphanSlug, orphanPath, orphanType, target, description, confidence }
 * Orphans the AI finds no genuine home for are NOT in the plan (left for manual review).
 */
export async function planOrphanRescue(domain, opts = {}, onEvent = () => {}) {
  const { costCeilingTokens = 1_500_000 } = opts;
  // v3.67.0: `opts.generateText` is a TEST-ONLY seam (the compile.js
  // precedent; null in production, where the routes pass `{}`), and every
  // provider call reports into one accumulator so the done event can say
  // what the run actually cost. `opts.onUsage` is forwarded when given.
  const llm = typeof opts.generateText === 'function' ? opts.generateText : generateText;
  const usage = makeUsageAccumulator(typeof opts.onUsage === 'function' ? opts.onUsage : null);
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
      return { slug: o.slug, type: o.type, path: o.path, excerpt: pageOpening(content).slice(0, ORPHAN_RESCUE_EXCERPT) };
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
      const raw = await llm(systemPrompt, userPrompt, 4096, 'json', null, { onUsage: usage.onUsage });
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

  const spent = (await aiRun()).spentFromUsage(usage.totals);   // v3.67.0, additive beside `cost`
  onEvent({ type: 'done', plan, summary, cost, spent });
  return { plan, summary, cost, spent };
}

// Exposed for unit testing the pure broken-link-fix helpers (v3.0.1-beta.16+).
export const __testing = {
  isLexicalVariant,
  buildLinkResolver,
  groupBrokenLinks,
  slugifyText,
  estimateUsdCost,
  costFields,
  HEALTH_TOKEN_SPLIT,
  liveCandidates,
  candidateFullPasses: () => candidateFullPasses,
  forgetCandidateMemo: () => { candidateMemo = null; },
};
