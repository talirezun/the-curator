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
import { generateText } from './llm.js';

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
