/**
 * Shared Brain — Synthesis Pipeline
 *
 * Applies the merge rules from spec Part 7 to turn many fellows' contributions
 * into one synthesized collective page per topic. Runs server-side: admin
 * triggers it manually (Phase 4 UI button) or weekly via a scheduler.
 *
 * Merge rules (Decisions 2-6 binding):
 *   Rule 1 — Union merge of new_facts. Exact-string dedup. Jaccard >= 0.5
 *            but < 1.0 flags a contradiction candidate, then Rule 3 resolves.
 *   Rule 2 — Link union for new_links. removed_links applied as
 *            "union minus" (link drops if any contributor removed it and
 *            no contributor re-added it in this cycle).
 *   Rule 3 — Targeted LLM call ONLY for Jaccard-flagged pairs. Input is just
 *            the two strings + page title. Output: unified | both | keep_a |
 *            keep_b. "both" → emit ⚠️ CONFLICTING SOURCES marker.
 *   Rule 4 — ## Provenance section listing all contributor IDs (Decision 6a
 *            default: UUIDs, not names).
 *   Rule 5 — Rebuild index.md from all collective pages after synthesis.
 *
 * Pipeline guarantees:
 *   - Idempotent re-run: synthesis re-running over the same contributions
 *     produces the same output.
 *   - Conservative on LLM failure: if the conflict-resolution LLM call
 *     throws, both contradictory facts are emitted with the ⚠️ marker.
 *     We never silently drop a contributor's input.
 *   - Cost-bounded: the LLM is invoked at most once per detected contradiction
 *     pair per page per synthesis cycle. Rules 1+2+4+5 are pure JS, zero
 *     LLM cost.
 *   - All diagnostics via console.error (this module is imported by mcp/* in
 *     Phase 4; stdout reserved for MCP JSON-RPC).
 */

import { generateText } from './llm.js';
import { parseJSON } from './ingest.js';
import { jaccardSimilarity } from './sharedbrain-delta.js';
import { createStorageAdapter } from './sharedbrain-storage-factory.js';
import { patchSharedBrain } from './sharedbrain-config.js';

// ── Constants ──────────────────────────────────────────────────────────────

/** Jaccard threshold below which two facts are considered independent. */
const JACCARD_INDEPENDENT_THRESHOLD = 0.5;

/** The literal marker phrase. Health-scannable in Phase 4+. */
const CONFLICT_MARKER = '⚠️ CONFLICTING SOURCES — review needed:';

/** Number of UUID chars to show in Provenance attribution (full UUID is overkill). */
const PROVENANCE_UUID_DISPLAY_LEN = 8;

/** Limit on contradiction pairs per page per synthesis cycle (cost guard). */
const MAX_CONTRADICTION_PAIRS_PER_PAGE = 10;

// ── Pure helpers — parsing existing pages ──────────────────────────────────

/**
 * Extract the first H1 line as the page title. Returns "Untitled" if none.
 */
export function extractTitleFromContent(content) {
  if (typeof content !== 'string') return 'Untitled';
  const m = content.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : 'Untitled';
}

/**
 * Strip YAML frontmatter from a page, returning the body only.
 * Tolerant of LF / CRLF and missing closing fence.
 */
export function stripFrontmatter(content) {
  if (typeof content !== 'string') return '';
  const m = content.match(/^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/);
  return m ? content.slice(m[0].length) : content;
}

/**
 * Extract bullet lines from a section by name. Returns an array of bullet
 * texts (without the leading "- "). Stops at the next H2 (## ...) or EOF.
 * Tolerant of mixed bullet markers (-, *) and indentation.
 */
export function extractSectionBullets(content, sectionName) {
  if (typeof content !== 'string') return [];
  const escName = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^##\\s+${escName}\\s*$`, 'mi');
  const m = content.match(re);
  if (!m) return [];
  const start = m.index + m[0].length;
  const rest = content.slice(start);
  // Stop at next H2 or EOF
  const nextH2 = rest.match(/^##\s+/m);
  const section = nextH2 ? rest.slice(0, nextH2.index) : rest;
  const bullets = [];
  for (const line of section.split(/\r?\n/)) {
    const lm = line.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (lm) bullets.push(lm[1]);
  }
  return bullets;
}

/**
 * Extract contributor UUIDs from an existing ## Provenance section.
 * Looks for the "Contributors: ..." line. Returns deduped UUIDs.
 */
export function extractProvenanceContributors(content) {
  if (typeof content !== 'string') return [];
  const sectionRe = /^##\s+Provenance\s*$/mi;
  const m = content.match(sectionRe);
  if (!m) return [];
  const after = content.slice(m.index + m[0].length);
  const nextH2 = after.match(/^##\s+/m);
  const sectionBody = nextH2 ? after.slice(0, nextH2.index) : after;
  const cm = sectionBody.match(/^[\s-*]*Contributors:\s*(.+?)\s*$/mi);
  if (!cm) return [];
  // Parse comma-separated tokens; tolerate "Name (uuid-short)" too.
  return Array.from(new Set(
    cm[1]
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      // If the token has parens, treat the parenthesised part as the canonical id
      .map(s => {
        const pm = s.match(/\(([^)]+)\)\s*$/);
        return pm ? pm[1].trim() : s;
      })
  ));
}

// ── Pure helpers — merging ─────────────────────────────────────────────────

/**
 * Group all deltas (across many contributions) by their target page path.
 * Returns Map<pagePath, [{delta, contributorId}, ...]>.
 *
 * @param {Array<{fellowId, payload}>} contributions
 */
export function groupDeltasByPage(contributions) {
  const grouped = new Map();
  for (const { fellowId, payload } of contributions) {
    if (!payload || !Array.isArray(payload.deltas)) continue;
    const contributorId = payload.fellow_id || fellowId;
    for (const delta of payload.deltas) {
      if (!delta || typeof delta.path !== 'string') continue;
      const arr = grouped.get(delta.path) || [];
      arr.push({ delta, contributorId });
      grouped.set(delta.path, arr);
    }
  }
  return grouped;
}

/**
 * Apply Rule 1 + Rule 3: union new_facts across all contributions for one page,
 * detecting contradiction candidates via Jaccard and resolving them via a
 * targeted LLM call.
 *
 * The result is an array of fact strings ready for the page body. Resolved
 * contradictions appear as a single unified bullet; unresolved ones appear
 * as a CONFLICT_MARKER + nested bullets.
 *
 * Conservative on LLM failure (Decision 4): falls back to "both" — emit the
 * conflict marker rather than silently dropping a contributor's input.
 *
 * @param {string} pageTitle
 * @param {string[]} existingFacts             Facts already in the collective page
 * @param {Array<{contributorId, facts: string[]}>} newContributions
 * @param {Function} llmFn                      Conflict-resolution LLM
 * @param {Function} shortenId                  contributorId → display id (for marker)
 * @returns {Promise<{ unifiedFacts: string[], conflicts: number }>}
 */
export async function mergeFactsForPage(pageTitle, existingFacts, newContributions, llmFn, shortenId) {
  // Build the candidate pool: existing facts + all new contributions.
  // We track who contributed each fact (existing facts are attributed to "prior").
  // Defense in depth (v3.0.2): stored contribution payloads are a
  // TRUST BOUNDARY — any contributor with repo write access can hand-craft
  // them, and a buggy client / corrupted write can produce non-string facts.
  // A single non-string here used to throw out of the whole synthesis run
  // (`c.text.trim()` below), permanently re-poisoning every future run.
  // Skip anything that isn't a non-empty string.
  const candidates = [];
  for (const f of existingFacts) {
    if (typeof f === 'string' && f.trim()) candidates.push({ text: f, source: 'prior' });
  }
  for (const { contributorId, facts } of newContributions) {
    for (const f of facts) {
      if (typeof f === 'string' && f.trim()) candidates.push({ text: f, source: contributorId });
    }
  }

  // Stage 1: deduplicate exact-string matches (post-trim, case-insensitive).
  const seen = new Map(); // normalised text → original candidate
  for (const c of candidates) {
    const key = c.text.trim().toLowerCase();
    if (!key) continue;
    if (!seen.has(key)) seen.set(key, c);
  }
  const deduped = [...seen.values()];

  // Stage 2: pairwise Jaccard scan for contradiction candidates.
  // O(N²) per page — fine because contributions are bounded per page per cycle.
  // We pair only NEW-VS-EXISTING and NEW-VS-NEW (within this cycle). prior-vs-prior
  // already passed scrutiny in previous cycles.
  const flaggedPairs = []; // {a: candidate, b: candidate, sim: number}
  for (let i = 0; i < deduped.length; i++) {
    if (flaggedPairs.length >= MAX_CONTRADICTION_PAIRS_PER_PAGE) break;
    for (let j = i + 1; j < deduped.length; j++) {
      const a = deduped[i];
      const b = deduped[j];
      // Skip if both are prior (already resolved in previous cycles).
      if (a.source === 'prior' && b.source === 'prior') continue;
      const sim = jaccardSimilarity(a.text, b.text);
      if (sim >= JACCARD_INDEPENDENT_THRESHOLD && sim < 1.0) {
        flaggedPairs.push({ a, b, sim });
        if (flaggedPairs.length >= MAX_CONTRADICTION_PAIRS_PER_PAGE) break;
      }
    }
  }

  // Stage 3: for each flagged pair, ask LLM to resolve. Build a set of facts
  // to drop and a set of conflict-marker strings to add.
  const toDrop = new Set();    // text values that get replaced by unified or removed
  const conflictMarkers = [];  // multiline strings to insert into the result
  let resolvedConflicts = 0;

  for (const { a, b } of flaggedPairs) {
    // If either one has already been marked for dropping by an earlier pair,
    // skip — don't double-process.
    if (toDrop.has(a.text) || toDrop.has(b.text)) continue;

    const verdict = await resolveContradiction(pageTitle, a.text, b.text, llmFn);
    if (verdict.resolution === 'unified' && Array.isArray(verdict.result) && verdict.result.length > 0) {
      // Replace both with the unified version: drop both originals, add the unified.
      toDrop.add(a.text);
      toDrop.add(b.text);
      // The new unified text is appended via this synthetic candidate later.
      deduped.push({ text: verdict.result[0], source: 'synthesized' });
      resolvedConflicts++;
    } else if (verdict.resolution === 'keep_a') {
      toDrop.add(b.text);
      resolvedConflicts++;
    } else if (verdict.resolution === 'keep_b') {
      toDrop.add(a.text);
      resolvedConflicts++;
    } else {
      // 'both' (default fallback): emit the marker, drop both from the flat list
      // since they'll appear inside the marker block. The attribution shows
      // the contributor id shortened — shortenId owns the entire display form
      // (e.g. "aaaa1111" or "Alice (aaaa1111)" if name attribution is on).
      toDrop.add(a.text);
      toDrop.add(b.text);
      const aId = a.source === 'prior' || a.source === 'synthesized' ? a.source : shortenId(a.source);
      const bId = b.source === 'prior' || b.source === 'synthesized' ? b.source : shortenId(b.source);
      const block = [
        `${CONFLICT_MARKER}`,
        `  - ${a.text} *(per ${aId})*`,
        `  - ${b.text} *(per ${bId})*`,
      ].join('\n');
      conflictMarkers.push(block);
    }
  }

  // Stage 4: assemble the final fact list, preserving order.
  const unifiedFacts = [];
  for (const c of deduped) {
    if (toDrop.has(c.text)) continue;
    unifiedFacts.push(c.text);
  }
  // Append the conflict markers as separate "bullet entries". The composer
  // will render them differently.
  for (const marker of conflictMarkers) {
    unifiedFacts.push(marker);
  }

  return { unifiedFacts, conflicts: conflictMarkers.length };
}

/**
 * Targeted LLM call to resolve a flagged contradiction pair. Conservative
 * fallback: on any error, returns `{ resolution: 'both' }` so we emit the
 * marker rather than guessing.
 */
async function resolveContradiction(pageTitle, factA, factB, llmFn) {
  const system = `You are a knowledge-graph editor resolving a potentially conflicting pair ` +
    `of facts about the same topic. Be precise and conservative.`;

  const user = [
    `Two contributors report potentially conflicting information:`,
    `Contributor A: "${factA}"`,
    `Contributor B: "${factB}"`,
    `Topic: ${pageTitle}`,
    ``,
    `Decide:`,
    `- If these are the SAME fact stated differently → produce ONE unified statement.`,
    `- If these are GENUINELY CONTRADICTORY (different values for the same property) → output BOTH.`,
    `- If one is clearly more specific or recent → keep the more specific/recent one.`,
    ``,
    `Respond ONLY with JSON, no markdown fences:`,
    `{ "resolution": "unified"|"both"|"keep_a"|"keep_b", "result": ["..."] }`,
  ].join('\n');

  try {
    const raw = await llmFn(system, user, 1024);
    const parsed = parseJSON(raw);
    if (!parsed || typeof parsed !== 'object') throw new Error('non-object response');
    const resolution = parsed.resolution;
    if (!['unified', 'both', 'keep_a', 'keep_b'].includes(resolution)) {
      throw new Error(`unknown resolution "${resolution}"`);
    }
    return {
      resolution,
      result: Array.isArray(parsed.result) ? parsed.result : [],
    };
  } catch (err) {
    console.error(`[sharedbrain-synthesis] LLM conflict resolution failed: ${err.message} — emitting CONFLICT_MARKER`);
    return { resolution: 'both', result: [] };
  }
}

/**
 * Rule 2 — link union/intersection.
 * Returns the merged link list:
 *   - All new_links from all contributors are unioned with existing links.
 *   - removed_links from any contributor are subtracted UNLESS the same
 *     link appears in any contributor's new_links this cycle. (Spirit:
 *     "if any contributor re-added it, treat that as overriding the
 *     remove" — no need to track per-contributor link history.)
 *
 * @param {string[]} existingLinks
 * @param {Array<{addedLinks: string[], removedLinks: string[]}>} contributions
 * @returns {string[]} deduplicated, sorted
 */
export function mergeLinksForPage(existingLinks, contributions) {
  // Track three sets separately so we can apply the "remove unless re-added" rule.
  const result = new Set();
  const newAdds = new Set();
  const newRemoves = new Set();

  for (const l of existingLinks) {
    if (typeof l === 'string' && l) result.add(l);
  }
  for (const { addedLinks, removedLinks } of contributions) {
    for (const l of addedLinks || []) {
      if (typeof l === 'string' && l) {
        result.add(l);
        newAdds.add(l);
      }
    }
    for (const l of removedLinks || []) {
      if (typeof l === 'string' && l) newRemoves.add(l);
    }
  }
  // Drop each removed link UNLESS a contributor re-added it this cycle.
  for (const l of newRemoves) {
    if (!newAdds.has(l)) result.delete(l);
  }
  return [...result].sort();
}

/** Rule 4 — build the ## Provenance section body. */
export function buildProvenanceSection(contributorIds, lastSynthesizedIso, shortenId) {
  const dedupedShort = [...new Set(contributorIds.map(id => shortenId(id)))].sort();
  return [
    '## Provenance',
    '',
    '<!-- DO NOT EDIT — auto-generated by Shared Brain synthesis -->',
    `- Last synthesized: ${lastSynthesizedIso}`,
    `- Contributors: ${dedupedShort.join(', ') || '(none)'}`,
    '',
  ].join('\n');
}

/**
 * Compose a synthesized collective page from merged components.
 *
 * @param {object} parts
 * @param {string} parts.title
 * @param {string} parts.type            'entity' | 'concept' | 'summary' | 'unknown'
 * @param {string[]} parts.keyFacts
 * @param {string[]} parts.relatedLinks
 * @param {string} parts.provenanceSection
 * @param {string} parts.lastSynthesizedIso
 */
export function composeCollectivePage(parts) {
  const { title, type, keyFacts, relatedLinks, provenanceSection, lastSynthesizedIso } = parts;
  const lines = [];

  // YAML frontmatter — minimal, auto-managed
  lines.push('---');
  lines.push(`title: ${jsonSafe(title)}`);
  if (type) lines.push(`type: ${type}`);
  lines.push(`last_synthesized: ${lastSynthesizedIso}`);
  lines.push(`source: shared-brain-synthesis`);
  lines.push('---');
  lines.push('');

  // Title
  lines.push(`# ${title}`);
  lines.push('');

  // Key Facts section
  if (keyFacts.length > 0) {
    lines.push('## Key Facts');
    lines.push('');
    for (const fact of keyFacts) {
      // If the fact contains the conflict marker, it's a multi-line block.
      if (fact.startsWith(CONFLICT_MARKER)) {
        lines.push(`- ${fact}`);
      } else {
        lines.push(`- ${fact}`);
      }
    }
    lines.push('');
  }

  // Related section
  if (relatedLinks.length > 0) {
    lines.push('## Related');
    lines.push('');
    for (const slug of relatedLinks) {
      lines.push(`- [[${slug}]]`);
    }
    lines.push('');
  }

  // Provenance section
  lines.push(provenanceSection.trimEnd());
  lines.push('');

  return lines.join('\n');
}

/** Escape a string for safe one-line YAML value. */
function jsonSafe(s) {
  if (typeof s !== 'string') return '""';
  if (/[:#\n"]/.test(s)) return JSON.stringify(s);
  return s;
}

/** Default short-id: first 8 hex chars of UUID. */
function defaultShortenId(id) {
  if (typeof id !== 'string') return 'unknown';
  return id.replace(/-/g, '').slice(0, PROVENANCE_UUID_DISPLAY_LEN);
}

// ── Index rebuild (Rule 5) ─────────────────────────────────────────────────

/**
 * Rebuild collective/<domain>/wiki/index.md from the list of all collective pages.
 * Format mirrors the Curator's own index.md.
 *
 * @param {object} adapter
 * @param {string} sharedDomain
 * @param {string} domainLabel  Display name for the heading
 * @param {string} todayIso     YYYY-MM-DD
 */
async function rebuildIndex(adapter, sharedDomain, domainLabel, todayIso) {
  const allPages = await adapter.listPages(sharedDomain);
  // Filter out index.md and log.md themselves
  const wikiPages = allPages.filter(p => p !== 'index.md' && p !== 'log.md');
  // Sort: entities then concepts then summaries, alphabetical within each
  wikiPages.sort();

  const lines = [
    `# Wiki Index — ${domainLabel} (Collective Brain)`,
    `Last synthesized: ${todayIso}`,
    '',
    '| Page | Type | Title |',
    '|------|------|-------|',
  ];
  for (const p of wikiPages) {
    let type = 'unknown';
    if (p.startsWith('entities/'))  type = 'entity';
    else if (p.startsWith('concepts/'))  type = 'concept';
    else if (p.startsWith('summaries/')) type = 'summary';

    // Best-effort title: try to read the page and extract H1. Skip on read failure.
    let title = p.replace(/^(entities|concepts|summaries)\//, '').replace(/\.md$/, '');
    try {
      const content = await adapter.readPage(sharedDomain, p);
      if (content) {
        const t = extractTitleFromContent(content);
        if (t && t !== 'Untitled') title = t;
      }
    } catch { /* keep filename-derived title */ }
    // Sanitize against pipe injection
    title = title.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
    lines.push(`| ${p} | ${type} | ${title} |`);
  }
  return lines.join('\n') + '\n';
}

// ── Main entry point ───────────────────────────────────────────────────────

/**
 * Run synthesis over all unprocessed contributions for one shared domain.
 *
 * @param {object} connection  Full connection (with adapter credentials)
 * @param {object} [opts]
 * @param {Function} [opts.llmFn]        Conflict-resolution LLM override (test)
 * @param {Function} [opts.patchFn]      patchSharedBrain override (test)
 * @param {Function} [opts.now]          () => Date (test)
 * @param {Function} [opts.shortenId]    contributorId → display id (test)
 * @param {Function} [opts.onProgress]   (stage, message, meta?) => void
 * @returns {Promise<{ ok, processed_contributions, pages_written, conflicts, error? }>}
 */
export async function runLocalSynthesis(connection, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const patchFn    = opts.patchFn    || patchSharedBrain;
  const nowFn      = opts.now        || (() => new Date());
  const shortenId  = opts.shortenId  || defaultShortenId;

  // Validation
  if (!connection || typeof connection !== 'object') {
    return { ok: false, error: 'runLocalSynthesis: connection is required' };
  }
  if (!connection.shared_domain) {
    return { ok: false, error: 'runLocalSynthesis: connection.shared_domain is required' };
  }
  if (!connection.enabled) {
    return { ok: false, error: 'runLocalSynthesis: connection is disabled' };
  }

  const llmFn = opts.llmFn || ((system, user, maxTokens) => generateText(system, user, maxTokens, 'json'));

  // Build adapter
  let adapter;
  try {
    adapter = createStorageAdapter(connection);
  } catch (err) {
    return { ok: false, error: `runLocalSynthesis: adapter init failed: ${err.message}` };
  }

  // Load last-synthesis state
  let lastSynthesisIso = null;
  try {
    const state = await adapter.readMeta('state.last-synthesis');
    if (state && typeof state.at === 'string') lastSynthesisIso = state.at;
  } catch { /* missing state → first synthesis */ }

  // Load all contributions since last synthesis
  onProgress('info', `Loading contributions since ${lastSynthesisIso || 'beginning'}...`);
  let contributions;
  try {
    contributions = await adapter.listContributionsSince(lastSynthesisIso);
  } catch (err) {
    return { ok: false, error: `runLocalSynthesis: listContributionsSince failed: ${err.message}` };
  }

  if (contributions.length === 0) {
    onProgress('info', 'No new contributions to synthesize.');
    return { ok: true, processed_contributions: 0, pages_written: 0, conflicts: 0 };
  }

  // Group deltas by page path
  const grouped = groupDeltasByPage(contributions);
  onProgress('info', `Processing ${grouped.size} page${grouped.size !== 1 ? 's' : ''} from ${contributions.length} contribution${contributions.length !== 1 ? 's' : ''}...`);

  const nowDate = nowFn();
  const nowIso = nowDate.toISOString();

  let pagesWritten = 0;
  let pagesFailed = 0;
  let totalConflicts = 0;
  const writtenPaths = [];

  // Process each page in deterministic order (sorted by path)
  const sortedPaths = [...grouped.keys()].sort();
  for (const pagePath of sortedPaths) {
    const entries = grouped.get(pagePath);
    onProgress('progress', `Synthesizing ${pagePath} (${entries.length} contribution${entries.length !== 1 ? 's' : ''})`);

    // v3.0.2: the whole per-page body is guarded so one malformed
    // contribution (hand-crafted payload, corrupted JSON, adapter hiccup)
    // degrades to a skipped page instead of aborting the entire synthesis
    // run. Before this guard, an exception here escaped runLocalSynthesis
    // and — because state.last-synthesis only advances at the end — the
    // poisoned contribution was re-listed on EVERY future run, bricking
    // synthesis until an admin manually deleted the file.
    try {

    // Load existing collective page (may not exist on first synthesis)
    let existingContent;
    try { existingContent = await adapter.readPage(connection.shared_domain, pagePath); }
    catch { existingContent = null; }

    const existingBody = existingContent ? stripFrontmatter(existingContent) : '';
    const existingTitle = existingContent ? extractTitleFromContent(existingContent) : null;
    const existingFacts = existingContent ? extractSectionBullets(existingBody, 'Key Facts') : [];
    const existingLinks = existingContent ? extractSectionBullets(existingBody, 'Related')
        .map(s => s.match(/\[\[([^\]]+)\]\]/)?.[1])
        .filter(Boolean) : [];
    const existingContributors = existingContent ? extractProvenanceContributors(existingBody) : [];

    // Determine page type and title
    let type = 'unknown';
    if (pagePath.startsWith('entities/'))  type = 'entity';
    else if (pagePath.startsWith('concepts/'))  type = 'concept';
    else if (pagePath.startsWith('summaries/')) type = 'summary';

    // Title: first non-empty delta.title wins, falling back to existing.
    let title = existingTitle;
    for (const { delta } of entries) {
      if (delta.title && typeof delta.title === 'string' && delta.title.trim()) {
        title = delta.title.trim();
        break;
      }
    }
    if (!title) title = pagePath.split('/').pop().replace(/\.md$/, '');

    // Merge facts (Rule 1 + Rule 3). Non-string entries are dropped at the
    // trust boundary — stored payloads may not have come from our delta module.
    const newContributions = entries.map(({ delta, contributorId }) => ({
      contributorId,
      facts: Array.isArray(delta.new_facts)
        ? delta.new_facts.filter(f => typeof f === 'string' && f.trim())
        : [],
    }));
    const { unifiedFacts, conflicts } = await mergeFactsForPage(
      title, existingFacts, newContributions, llmFn, shortenId
    );
    totalConflicts += conflicts;

    // Merge links (Rule 2)
    const linkContribs = entries.map(({ delta }) => ({
      addedLinks: Array.isArray(delta.new_links) ? delta.new_links : [],
      removedLinks: Array.isArray(delta.removed_links) ? delta.removed_links : [],
    }));
    const mergedLinks = mergeLinksForPage(existingLinks, linkContribs);

    // Build Provenance (Rule 4)
    const allContributors = [
      ...existingContributors.map(id => id),         // already-short ids if from existing page
      ...entries.map(e => e.contributorId),          // full UUIDs from this cycle
    ];
    const provenanceSection = buildProvenanceSection(allContributors, nowIso, shortenId);

    // Compose final page
    const finalContent = composeCollectivePage({
      title, type,
      keyFacts: unifiedFacts,
      relatedLinks: mergedLinks,
      provenanceSection,
      lastSynthesizedIso: nowIso,
    });

    // Write back to collective storage
    try {
      await adapter.writePage(connection.shared_domain, pagePath, finalContent);
      pagesWritten++;
      writtenPaths.push(pagePath);
    } catch (err) {
      pagesFailed++;
      console.error(`[sharedbrain-synthesis] writePage failed for "${pagePath}": ${err.message}`);
      onProgress('warn', `${pagePath}: write to collective storage failed — ${err.message}`);
    }

    } catch (err) {
      // Per-page guard (see comment at the top of the loop). Surface the
      // failure loudly but keep going — other pages must still synthesize.
      pagesFailed++;
      console.error(`[sharedbrain-synthesis] page "${pagePath}" failed to synthesize: ${err.message}`);
      onProgress('warn', `${pagePath}: skipped this cycle — ${err.message}`);
    }
  }

  // Rule 5 — rebuild index.md
  onProgress('info', 'Rebuilding collective index.md...');
  try {
    const idx = await rebuildIndex(
      adapter,
      connection.shared_domain,
      connection.shared_domain_display_name || connection.shared_domain,
      nowIso.slice(0, 10)
    );
    await adapter.writePage(connection.shared_domain, 'index.md', idx);
  } catch (err) {
    console.error(`[sharedbrain-synthesis] index rebuild failed: ${err.message}`);
  }

  // Update last-synthesis state
  try {
    const prevState = await adapter.readMeta('state.last-synthesis');
    const runNumber = (prevState && typeof prevState.run_number === 'number') ? prevState.run_number + 1 : 1;
    await adapter.writeMeta('state.last-synthesis', {
      at: nowIso,
      run_number: runNumber,
      pages_written: pagesWritten,
      conflicts: totalConflicts,
      processed_contributions: contributions.length,
    });
  } catch (err) {
    console.error(`[sharedbrain-synthesis] failed to write last-synthesis meta: ${err.message}`);
  }

  // Update connection state (last_synthesis_at for visibility in UI later)
  patchFn(connection.id, { last_synthesis_at: nowIso });

  const summary = `Synthesis complete: ${pagesWritten} page${pagesWritten !== 1 ? 's' : ''} written from ${contributions.length} contribution${contributions.length !== 1 ? 's' : ''}` +
    (totalConflicts > 0 ? `, ${totalConflicts} unresolved contradiction${totalConflicts !== 1 ? 's' : ''} flagged` : '') +
    (pagesFailed > 0 ? `, ${pagesFailed} page${pagesFailed !== 1 ? 's' : ''} failed (see warnings)` : '');
  onProgress('done', summary, {
    processed_contributions: contributions.length,
    pages_written: pagesWritten,
    pages_failed: pagesFailed,
    conflicts: totalConflicts,
  });

  return {
    ok: true,
    processed_contributions: contributions.length,
    pages_written: pagesWritten,
    pages_failed: pagesFailed,
    conflicts: totalConflicts,
  };
}

// Exposed for testing
export const __testing = {
  CONFLICT_MARKER,
  JACCARD_INDEPENDENT_THRESHOLD,
  MAX_CONTRADICTION_PAIRS_PER_PAGE,
  defaultShortenId,
  resolveContradiction,
  rebuildIndex,
};
