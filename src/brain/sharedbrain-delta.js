// This file is licensed under the Curator Enterprise License — NOT MIT.
// Free for personal, educational, evaluation, development and testing use,
// and for production use of the GitHub-backed Shared Brain (free forever).
// Other organizational production use will require a license key once keys
// exist — until then it is free too (grace clause). Each release's version of
// this file converts to MIT two years after that release was published.
// See LICENSES/LICENSE-ENTERPRISE.txt and LICENSES/ENTERPRISE-FILES.txt.
/**
 * Shared Brain — Delta pre-processing
 *
 * Turns a changed wiki page into a compact `DeltaSummary` — the unit of
 * contribution to the Shared Brain.
 *
 *   Raw page (~500–2,000 tokens) → DeltaSummary (~200–400 tokens)
 *
 * Why pre-process instead of pushing raw pages:
 *   - Cost scales with change volume, not corpus size — a 10,000-page wiki
 *     costs the same to synthesize as a 100-page one if the weekly change
 *     rate is similar.
 *   - Less raw content leaves the contributor's machine (privacy posture).
 *   - The synthesis pipeline operates on structured signals, not prose.
 *
 * Decisions (binding per docs/shared-brain-design.md):
 *   - Decision 2 (OQ 0.2): cross-domain links are STRIPPED at delta-generation
 *     time. `new_links` only contains slugs that exist in the contributed
 *     domain's own wiki. Cross-domain references survive in prose as facts.
 *   - Decision 3 (OQ 0.3): LLM failures don't abort the whole push. The
 *     caller (pushDomain in sharedbrain.js) decides what to do with the
 *     returned `{ ok: false, error }` and queues for retry. This module
 *     never throws on LLM failure — it returns a structured failure object.
 *   - Decision 4 (OQ 0.4): `jaccardSimilarity` lives here. It is exported
 *     for the synthesis pipeline (Phase 2E) to use when detecting candidate
 *     contradictions. Not used by push itself.
 *
 * Module discipline:
 *   - Pure functions where possible. No side effects from delta generation
 *     (no filesystem, no config writes).
 *   - All logs use console.error (stderr) per the v2.5.3 MCP-stdout rule.
 *     This module is imported by mcp/* in Phase 4+, so stdout must stay
 *     reserved for the MCP JSON-RPC stream.
 */

import { generateText } from './llm.js';
import { parseJSON } from './ingest.js';

// ── Constants ───────────────────────────────────────────────────────────────

const MAX_NEW_FACTS    = 100;
const MAX_STABLE_FACTS = 200;
const MAX_KEY_ENTITIES = 50;
const MAX_LINK_FIELD   = 200;
const MAX_FACT_CHARS   = 500;

/** English stop words for Jaccard tokenisation. Conservative, ~50 entries. */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'was', 'were', 'are', 'be', 'been', 'being',
  'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'into',
  'and', 'or', 'but', 'nor', 'so', 'yet',
  'as', 'if', 'then', 'than', 'that', 'this', 'these', 'those',
  'it', 'its', 'they', 'them', 'their', 'theirs',
  'he', 'she', 'his', 'her', 'hers', 'him',
  'we', 'our', 'us', 'ours',
  'you', 'your', 'yours',
  'i', 'me', 'my', 'mine',
  'do', 'does', 'did', 'done',
  'has', 'have', 'had',
  'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might', 'must',
  'not', 'no',
  's', 't', 'd', 'll', 're', 've', 'm',
]);

// ── Helpers (pure) ─────────────────────────────────────────────────────────

/** Extract the page title from its first `# ` heading. Returns "Untitled" if none. */
export function extractTitle(content) {
  if (typeof content !== 'string') return 'Untitled';
  const m = content.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : 'Untitled';
}

/** Extract all `[[slug]]` wikilinks from content. Strips folder prefixes. */
export function extractWikilinks(content) {
  if (typeof content !== 'string') return [];
  return Array.from(
    content.matchAll(/\[\[([^\]]+)\]\]/g),
    m => m[1].replace(/^(entities|concepts|summaries)\//, '').trim()
  ).filter(Boolean);
}

/** Classify a wiki page by its path prefix. */
export function classifyPage(pagePath) {
  if (typeof pagePath !== 'string') return 'unknown';
  if (pagePath.startsWith('entities/'))  return 'entity';
  if (pagePath.startsWith('concepts/'))  return 'concept';
  if (pagePath.startsWith('summaries/')) return 'summary';
  return 'unknown';
}

/**
 * Strip wikilinks that don't resolve in the contributed domain.
 *
 * Decision 2 (binding): the LLM is also instructed not to produce cross-domain
 * links, but this filter is the safety net. Slug normalisation matches
 * writePage's Pass B (case-insensitive, hyphen-normalised) so `[[Tali Rezun]]`
 * pointing at `entities/tali-rezun.md` works.
 *
 * @param {string[]} links            Slugs (without brackets) to validate.
 * @param {string[]} domainPagePaths  All page paths in the contributed domain,
 *                                    e.g. ["entities/foo.md", "concepts/bar.md"].
 * @returns {string[]} Filtered slugs that resolve.
 */
export function filterToDomainLinks(links, domainPagePaths) {
  if (!Array.isArray(links) || links.length === 0) return [];
  if (!Array.isArray(domainPagePaths) || domainPagePaths.length === 0) return [];

  // Build set of normalised slugs (hyphen-collapsed, lowercased) for matching.
  const normalise = slug => slug
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/\.md$/, '');

  const validNormalisedSlugs = new Set(
    domainPagePaths.map(p =>
      normalise(p.replace(/^(entities|concepts|summaries)\//, ''))
    )
  );

  // Dedup against the normalised form so case-only variants collapse.
  // Output preserves the first-seen case of the link.
  const seen = new Set();
  const out = [];
  for (const link of links) {
    if (typeof link !== 'string' || !link) continue;
    const cleaned = link.replace(/^(entities|concepts|summaries)\//, '').trim();
    if (!cleaned) continue;
    const normalised = normalise(cleaned);
    if (!validNormalisedSlugs.has(normalised)) continue;
    if (seen.has(normalised)) continue;
    seen.add(normalised);
    out.push(cleaned);
  }
  return out;
}

// ── Jaccard similarity (for Phase 2E synthesis) ────────────────────────────

/** Tokenise a fact-bullet for Jaccard comparison. Lowercase, strip punct, drop stop-words. */
export function tokenize(s) {
  if (typeof s !== 'string') return [];
  return s
    .toLowerCase()
    .replace(/[^\w\s'-]/g, ' ')  // keep word chars + apostrophe + hyphen
    .split(/\s+/)
    .filter(t => t && !STOP_WORDS.has(t) && t.length > 1);
}

/**
 * Jaccard similarity between two strings.
 *
 * Used by Phase 2E synthesis to detect candidate contradictions (Decision 4):
 *   - 1.0           → exact (token-set) duplicate, drop one
 *   - 0.5 ≤ s < 1.0 → candidate contradiction, send to LLM resolution
 *   - s < 0.5       → independent facts, keep both
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} 0.0 to 1.0
 */
export function jaccardSimilarity(a, b) {
  const tokA = new Set(tokenize(a));
  const tokB = new Set(tokenize(b));
  if (tokA.size === 0 && tokB.size === 0) return 1.0; // both empty → identical
  if (tokA.size === 0 || tokB.size === 0) return 0.0;
  let intersect = 0;
  for (const t of tokA) if (tokB.has(t)) intersect++;
  const unionSize = tokA.size + tokB.size - intersect;
  return intersect / unionSize;
}

// ── DeltaSummary generation ────────────────────────────────────────────────

/**
 * Build the LLM prompt for delta extraction.
 * @returns {{ system: string, user: string }}  Two-string shape matching generateText().
 */
export function buildDeltaPrompt(pagePath, pageType, currentContent, priorContent, isNew) {
  const system = `You are pre-processing a wiki page for contribution to a Shared Brain. ` +
    `Extract a structured delta — the changes and key content for collective synthesis. ` +
    `Be precise and concise. Every string under 500 characters.`;

  const versionsBlock = priorContent
    ? `PRIOR VERSION:\n${priorContent}\n\nCURRENT VERSION:\n${currentContent}`
    : `CONTENT (new page):\n${currentContent}`;

  const user = [
    `PAGE PATH: ${pagePath}`,
    `PAGE TYPE: ${pageType}`,
    `IS NEW PAGE: ${isNew}`,
    '',
    versionsBlock,
    '',
    'Extract the following:',
    '- title: the display title of this page',
    '- new_facts: bullet point facts that are NEW or CHANGED vs prior version (all key facts if new page)',
    '- stable_facts: bullet point facts UNCHANGED from prior (omit if new page)',
    '- new_links: wikilink slugs (no brackets, no folder prefix) that were ADDED — only slugs in THIS DOMAIN',
    '- removed_links: wikilink slugs that were REMOVED',
    '- key_entities: up to 10 most important entity slugs referenced on this page',
    '',
    'IMPORTANT: Only include wikilinks to pages in the SAME DOMAIN as this page.',
    'Do not include links to personal domains, external sources, or cross-domain references.',
    '',
    'Respond ONLY with valid JSON, no markdown fences:',
    '{',
    '  "title": "...",',
    '  "new_facts": ["...", "..."],',
    '  "stable_facts": ["...", "..."],',
    '  "new_links": ["slug-one", "slug-two"],',
    '  "removed_links": [],',
    '  "key_entities": ["entity-one", "entity-two"]',
    '}',
  ].join('\n');

  return { system, user };
}

/**
 * Build a fallback DeltaSummary when the LLM fails to produce parseable output.
 *
 * Decision 3 (binding): the push orchestration may choose to either skip
 * this page (preferred) or push the fallback (less preferred). This function
 * just constructs the fallback; the decision lives in sharedbrain.js.
 */
export function buildFallbackDelta(pagePath, pageType, currentContent, fellowId, fellowDisplayName, nowIso) {
  return {
    path: pagePath,
    type: pageType,
    title: extractTitle(currentContent),
    new_facts: [],
    stable_facts: [],
    new_links: extractWikilinks(currentContent),  // unfiltered — caller may discard
    removed_links: [],
    key_entities: [],
    contributor_name: fellowDisplayName,
    contributor_id: fellowId,
    last_modified: nowIso || new Date().toISOString(),
    full_content_fallback: currentContent,
  };
}

/**
 * Generate a DeltaSummary for one changed wiki page using the local LLM.
 *
 * On LLM failure (parse error, quota, network) this function does NOT throw.
 * It returns `{ ok: false, error: <message>, fallback: <DeltaSummary> }` so
 * the caller can decide between (a) skip the page and queue for retry,
 * (b) push the fallback with `full_content_fallback` set. Per Decision 3
 * we recommend (a) — the caller increments pending_retry[pagePath].
 *
 * @param {object}   args
 * @param {string}   args.pagePath           Relative path, e.g. "concepts/foo.md"
 * @param {string}   args.currentContent     Current file content
 * @param {string|null} args.priorContent    Content at last_push_at, or null if new
 * @param {string}   args.fellowId
 * @param {string}   args.fellowDisplayName
 * @param {string[]} args.domainPagePaths    All page paths in the contributed domain
 * @param {object}   [args.options]
 * @param {Function} [args.options.llmFn]    Override LLM call (test injection).
 *                                           Signature: (system, user, maxTokens) => Promise<string>
 * @param {Function} [args.options.now]      Returns Date object — for deterministic test timestamps
 * @returns {Promise<{ ok: boolean, delta?: object, error?: string, fallback?: object }>}
 */
export async function generateDeltaSummary(args) {
  const {
    pagePath, currentContent, priorContent,
    fellowId, fellowDisplayName, domainPagePaths,
    options = {},
  } = args;

  if (typeof pagePath !== 'string' || !pagePath) {
    return { ok: false, error: 'pagePath is required' };
  }
  if (typeof currentContent !== 'string') {
    return { ok: false, error: 'currentContent must be a string' };
  }
  if (typeof fellowId !== 'string' || !fellowId) {
    return { ok: false, error: 'fellowId is required' };
  }
  if (typeof fellowDisplayName !== 'string') {
    return { ok: false, error: 'fellowDisplayName must be a string' };
  }
  if (!Array.isArray(domainPagePaths)) {
    return { ok: false, error: 'domainPagePaths must be an array' };
  }

  const llmFn = options.llmFn || ((system, user, maxTokens) => generateText(system, user, maxTokens, 'json'));
  const nowFn = options.now || (() => new Date());

  const isNew = priorContent === null || priorContent === undefined;
  const pageType = classifyPage(pagePath);

  const { system, user } = buildDeltaPrompt(pagePath, pageType, currentContent, priorContent, isNew);

  let raw;
  try {
    raw = await llmFn(system, user, 4096);
  } catch (err) {
    console.error(`[sharedbrain-delta] LLM call failed for ${pagePath}: ${err.message}`);
    return {
      ok: false,
      error: `LLM call failed: ${err.message}`,
      fallback: buildFallbackDelta(pagePath, pageType, currentContent, fellowId, fellowDisplayName, nowFn().toISOString()),
    };
  }

  let parsed;
  try {
    parsed = parseJSON(raw);
    if (!parsed || typeof parsed !== 'object') throw new Error('LLM returned non-object');
  } catch (err) {
    console.error(`[sharedbrain-delta] LLM parse failed for ${pagePath}: ${err.message}`);
    return {
      ok: false,
      error: `LLM parse failed: ${err.message}`,
      fallback: buildFallbackDelta(pagePath, pageType, currentContent, fellowId, fellowDisplayName, nowFn().toISOString()),
    };
  }

  // Path validation — refuse if LLM tried to write a different path.
  if (parsed.path && parsed.path !== pagePath) {
    console.error(`[sharedbrain-delta] LLM returned wrong path "${parsed.path}" for input "${pagePath}" — using input path`);
  }

  // Filter cross-domain links (Decision 2 — strict, hard filter).
  const safeNewLinks     = filterToDomainLinks(parsed.new_links     || [], domainPagePaths).slice(0, MAX_LINK_FIELD);
  const safeRemovedLinks = filterToDomainLinks(parsed.removed_links || [], domainPagePaths).slice(0, MAX_LINK_FIELD);

  // Cap each fact at MAX_FACT_CHARS and cap array sizes.
  const cap = s => (typeof s === 'string' ? s.slice(0, MAX_FACT_CHARS) : '');
  const arr = (a, max) => Array.isArray(a) ? a.map(cap).filter(Boolean).slice(0, max) : [];

  const delta = {
    path: pagePath,
    type: pageType,
    title: typeof parsed.title === 'string' && parsed.title.trim()
      ? parsed.title.trim()
      : extractTitle(currentContent),
    new_facts:     arr(parsed.new_facts,     MAX_NEW_FACTS),
    stable_facts:  arr(parsed.stable_facts,  MAX_STABLE_FACTS),
    new_links:     safeNewLinks,
    removed_links: safeRemovedLinks,
    key_entities:  arr(parsed.key_entities,  MAX_KEY_ENTITIES),
    contributor_name: fellowDisplayName,
    contributor_id: fellowId,
    last_modified: nowFn().toISOString(),
    full_content_fallback: null,
  };

  return { ok: true, delta };
}

// Test surface — internals exposed for the battle-test script.
export const __testing = {
  STOP_WORDS, MAX_NEW_FACTS, MAX_STABLE_FACTS, MAX_KEY_ENTITIES, MAX_LINK_FIELD, MAX_FACT_CHARS,
};
