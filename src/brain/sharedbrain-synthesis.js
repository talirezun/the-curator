// This file is licensed under the Curator Enterprise License — NOT MIT.
// Free for personal, educational, evaluation, development and testing use,
// and for production use of the GitHub-backed Shared Brain (free forever).
// Other organizational production use will require a license key once keys
// exist — until then it is free too (grace clause). Each release's version of
// this file converts to MIT two years after that release was published.
// See LICENSES/LICENSE-ENTERPRISE.txt and LICENSES/ENTERPRISE-FILES.txt.
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
import { jaccardSimilarity, tokenize } from './sharedbrain-delta.js';
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

/**
 * Clock-skew allowance for the processed-submission watermark (v3.0.3).
 * Contributions are listed from (watermark − this window) and deduplicated
 * against `processed_ids`, so a contributor whose clock is behind the
 * watermark by up to this much can never be silently skipped.
 */
const SKEW_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Server-side caps applied to fellow-supplied strings at the synthesis trust
 * boundary (v3.0.3). Slightly above the delta module's client-side caps —
 * the client caps are courtesy; these are the enforcement.
 */
const SERVER_MAX_FACT_CHARS  = 600;
const SERVER_MAX_TITLE_CHARS = 200;
const SERVER_MAX_LINK_CHARS  = 200;

/**
 * Soft ceiling on facts per collective page. We deliberately do NOT evict
 * (dropping a contributor's fact silently would violate the conservation
 * invariant) — we warn the admin so they can split/curate the page before
 * it approaches the storage backend's 1 MB file ceiling.
 */
const FACTS_PER_PAGE_SOFT_CAP = 500;

/**
 * Sanitize a fellow-supplied FACT/TITLE string (v3.0.3). Stored contribution
 * payloads are a trust boundary — a fact containing "\n## Provenance" could
 * inject a forged Provenance section (revoke evasion / short-ID spoofing),
 * and "\n## X" would truncate other fellows' facts on the next cycle
 * (extractSectionBullets stops at the next H2). Newline removal is the
 * load-bearing part; the length cap is belt-and-braces.
 */
export function sanitizeFellowText(s, maxLen = SERVER_MAX_FACT_CHARS) {
  if (typeof s !== 'string') return '';
  return s.replace(/[\r\n]+/g, ' ').trim().slice(0, maxLen);
}

/**
 * Validate a fellow-supplied wikilink slug (v3.0.3). Links are rendered
 * inside `[[${slug}]]` — brackets/pipes/newlines would break out of the
 * link syntax and inject arbitrary markdown.
 */
export function isSafeLinkSlug(l) {
  return typeof l === 'string' &&
    l.length > 0 &&
    l.length <= SERVER_MAX_LINK_CHARS &&
    !/[\[\]|\r\n]/.test(l);
}

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
    const top = line.match(/^[-*]\s+(.+?)\s*$/);
    if (top) { bullets.push(top[1]); continue; }
    const nested = line.match(/^\s+[-*]\s+(.+?)\s*$/);
    if (nested) {
      // v3.0.3: a CONFLICTING SOURCES block is ONE multi-line bullet — the
      // marker line plus its indented children. Pre-fix, the children came
      // back as separate facts with baked-in "(per …)" suffixes, so each
      // cycle stacked degenerate markers and burned LLM calls re-flagging
      // them. Reconstitute the block so it round-trips byte-stable.
      const prev = bullets.length ? bullets[bullets.length - 1] : null;
      if (prev !== null && prev.startsWith(CONFLICT_MARKER)) {
        bullets[bullets.length - 1] = prev + '\n  - ' + nested[1];
      } else {
        bullets.push(nested[1]); // pre-existing behaviour for ordinary nested bullets
      }
    }
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
    // v3.0.3 (trust boundary): the storage-path-derived fellowId wins over
    // the fellow-controlled payload field — a hand-crafted payload could
    // otherwise attribute its facts to a victim's UUID (and manipulate
    // which pages the victim's GDPR revocation deletes).
    const contributorId = fellowId || payload.fellow_id;
    if (fellowId && payload.fellow_id && payload.fellow_id !== fellowId) {
      console.error(`[sharedbrain-synthesis] fellow_id mismatch: payload claims "${payload.fellow_id}" but was stored under "${fellowId}" — using the storage path`);
    }
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
  // O(N²) per page. v3.0.3: token sets are memoized per candidate BEFORE the
  // pair loop — the previous per-pair re-tokenisation made the scan
  // O(N² × tokenize) which turned into minutes of CPU on fact-heavy hub
  // pages. The set-based Jaccard below is numerically identical to
  // jaccardSimilarity(a.text, b.text).
  const tokenSets = deduped.map(c => new Set(tokenize(c.text)));
  const jaccardFromSets = (A, B) => {
    if (A.size === 0 && B.size === 0) return 1;
    if (A.size === 0 || B.size === 0) return 0;
    let inter = 0;
    const [small, large] = A.size <= B.size ? [A, B] : [B, A];
    for (const t of small) if (large.has(t)) inter++;
    return inter / (A.size + B.size - inter);
  };
  const flaggedPairs = []; // {a: candidate, b: candidate, sim: number}
  for (let i = 0; i < deduped.length; i++) {
    if (flaggedPairs.length >= MAX_CONTRADICTION_PAIRS_PER_PAGE) break;
    for (let j = i + 1; j < deduped.length; j++) {
      const a = deduped[i];
      const b = deduped[j];
      // Skip if both are prior (already resolved in previous cycles).
      if (a.source === 'prior' && b.source === 'prior') continue;
      const sim = jaccardFromSets(tokenSets[i], tokenSets[j]);
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
      // Conflict-marker blocks are multi-line strings that already carry
      // their own "\n  - child" structure — `- ${fact}` renders both plain
      // facts and blocks correctly (and round-trips through the
      // marker-aware extractSectionBullets, v3.0.3).
      lines.push(`- ${fact}`);
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
    adapter = createStorageAdapter(connection, { onWarn: (msg) => onProgress('warn', msg) });
  } catch (err) {
    return { ok: false, error: `runLocalSynthesis: adapter init failed: ${err.message}` };
  }

  // v3.0.3: refuse to synthesize while a revocation is in progress (or was
  // interrupted). Synthesizing mid-revoke could re-create pages from data
  // the revoke is in the middle of erasing. The revoke orchestrator itself
  // passes allowDuringRevocation to run its own rebuild step.
  if (!opts.allowDuringRevocation) {
    try {
      const marker = await adapter.readMeta('state.revocation-in-progress');
      if (marker && marker.active === true) {
        return {
          ok: false,
          error: 'A contributor revocation is in progress or was interrupted before completing. ' +
                 'Re-run the revocation to finish the erasure, then synthesize.',
        };
      }
    } catch { /* unreadable marker → proceed */ }
  }

  // ── Load last-synthesis state (v3.0.3 processed-submission tracking) ────
  //
  // Pre-v3.0.3, "new" contributions were those with contributed_at (the
  // CONTRIBUTOR's wall clock) newer than state.at (the ADMIN's wall clock).
  // A contributor whose clock ran behind, or a push landing during a
  // synthesis run, was silently skipped FOREVER. Now:
  //   - `watermark` = max contributed_at over fully-processed submissions
  //     (derived from contribution stamps, never the admin clock);
  //   - contributions are listed from (watermark − SKEW_WINDOW) and
  //     deduplicated against `processed_ids`;
  //   - a submission is marked processed ONLY when every page it touches
  //     was written successfully — failed pages leave their submissions
  //     unprocessed and they retry next run (fixes the consumed-on-failure
  //     data loss).
  // Back-compat: old state files have only `at` — used as the initial
  // watermark (one-time reprocessing of the last skew-window is idempotent).
  let prevState = null;
  if (opts.stateOverride !== undefined) {
    // v3.0.6 (found by the 5.1 live revoke E2E): the revoke orchestrator
    // resets state.last-synthesis and immediately re-runs synthesis — but
    // GitHub's contents API is only eventually consistent, so this read
    // served the STALE pre-reset state (old watermark + processed_ids),
    // the rebuild dedup'd every surviving contribution as "already
    // processed", and the revoke deleted pages WITHOUT rebuilding them
    // while reporting success. The orchestrator now hands its reset state
    // in directly, removing the read-after-write dependency entirely.
    prevState = opts.stateOverride;
  } else {
    try { prevState = await adapter.readMeta('state.last-synthesis'); } catch { /* first synthesis */ }
  }
  // If the state carries a `watermark` key at all (v3.0.3+ writer), trust it
  // even when null (null = "nothing fully processed yet — list everything").
  // Only legacy states (pre-v3.0.3, no watermark key) fall back to `at`.
  const watermarkIso = (prevState && 'watermark' in prevState)
    ? (typeof prevState.watermark === 'string' ? prevState.watermark : null)
    : (prevState && typeof prevState.at === 'string' ? prevState.at : null);
  const processedIds = new Set(
    prevState && Array.isArray(prevState.processed_ids)
      ? prevState.processed_ids.filter(id => typeof id === 'string')
      : []
  );

  const watermarkMs = watermarkIso ? Date.parse(watermarkIso) : NaN;
  const sinceIso = Number.isFinite(watermarkMs)
    ? new Date(Math.max(0, watermarkMs - SKEW_WINDOW_MS)).toISOString()
    : null;

  onProgress('info', `Loading contributions since ${sinceIso || 'beginning'}...`);
  let listed;
  try {
    listed = await adapter.listContributionsSince(sinceIso);
  } catch (err) {
    return { ok: false, error: `runLocalSynthesis: listContributionsSince failed: ${err.message}` };
  }

  // Filter: drop already-processed submissions and (v3.0.3, trust boundary)
  // contributions targeting a DIFFERENT shared domain — a repo can host
  // multiple domains, and pre-fix everything was synthesized into this
  // connection's domain regardless of payload.domain.
  const contributions = [];
  const foreignIds = []; // conclusively not-ours → tracked as processed
  for (const c of listed) {
    if (processedIds.has(c.submissionId)) continue;
    const payloadDomain = c.payload ? c.payload.domain : undefined;
    if (payloadDomain !== connection.shared_domain) {
      onProgress('warn', `Skipping contribution ${c.submissionId.slice(0, 8)}… — targets domain "${payloadDomain || '(none)'}", not "${connection.shared_domain}".`);
      foreignIds.push(c.submissionId);
      continue;
    }
    contributions.push(c);
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
  const failedPages = new Set(); // v3.0.3 — drives processed-submission tracking
  const conflictPages = [];      // v3.0.4 (M17) — pages with unresolved contradictions

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

    // Load existing collective page (may not exist on first synthesis).
    // v3.0.3: adapters signal "missing" by returning null — a THROW here is
    // a real error (rate limit, network, or FILE_TOO_LARGE past the 1 MB
    // GitHub ceiling) and must NOT be treated as "page doesn't exist":
    // pre-fix, an oversized page's accumulated facts were silently
    // discarded and replaced by a from-scratch compose. Let the throw reach
    // the per-page guard → page marked failed → its submissions stay
    // unprocessed and retry next run.
    const existingContent = await adapter.readPage(connection.shared_domain, pagePath);

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
    // Sanitized (v3.0.3) — the title lands in `# ${title}` and the YAML
    // frontmatter; a newline would inject markdown structure.
    let title = existingTitle;
    for (const { delta } of entries) {
      if (delta.title && typeof delta.title === 'string' && delta.title.trim()) {
        title = sanitizeFellowText(delta.title, SERVER_MAX_TITLE_CHARS);
        break;
      }
    }
    if (!title) title = pagePath.split('/').pop().replace(/\.md$/, '');

    // Merge facts (Rule 1 + Rule 3). Sanitized at the trust boundary
    // (v3.0.3): non-strings dropped, newlines flattened (blocks Provenance
    // forgery + section truncation — see sanitizeFellowText), server-side
    // length cap enforced.
    const newContributions = entries.map(({ delta, contributorId }) => ({
      contributorId,
      facts: Array.isArray(delta.new_facts)
        ? delta.new_facts.map(f => sanitizeFellowText(f)).filter(Boolean)
        : [],
    }));
    const { unifiedFacts, conflicts } = await mergeFactsForPage(
      title, existingFacts, newContributions, llmFn, shortenId
    );
    totalConflicts += conflicts;
    if (conflicts > 0) conflictPages.push(pagePath);
    if (unifiedFacts.length > FACTS_PER_PAGE_SOFT_CAP) {
      // Deliberately warn-not-evict: silently dropping a contributor's fact
      // would violate the conservation invariant. The admin should split or
      // curate the page before it approaches the backend's 1 MB file cap.
      onProgress('warn', `${pagePath}: ${unifiedFacts.length} accumulated facts (soft cap ${FACTS_PER_PAGE_SOFT_CAP}) — consider splitting this page; very large pages will eventually hit the storage backend's 1 MB file limit.`);
    }

    // Merge links (Rule 2). Link slugs render inside [[...]] — validate the
    // shape so a crafted slug can't break out of the wikilink (v3.0.3).
    const linkContribs = entries.map(({ delta }) => ({
      addedLinks: Array.isArray(delta.new_links) ? delta.new_links.filter(isSafeLinkSlug) : [],
      removedLinks: Array.isArray(delta.removed_links) ? delta.removed_links.filter(isSafeLinkSlug) : [],
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
      failedPages.add(pagePath);
      console.error(`[sharedbrain-synthesis] writePage failed for "${pagePath}": ${err.message}`);
      onProgress('warn', `${pagePath}: write to collective storage failed — ${err.message}`);
    }

    } catch (err) {
      // Per-page guard (see comment at the top of the loop). Surface the
      // failure loudly but keep going — other pages must still synthesize.
      pagesFailed++;
      failedPages.add(pagePath);
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

  // ── Update last-synthesis state (v3.0.3 processed-submission tracking) ──
  // A submission counts as processed ONLY if none of its target pages
  // failed this run. Failed pages leave their submissions unprocessed so
  // the facts are re-synthesized next run instead of being consumed by a
  // partial failure. Deltas with invalid paths contribute nothing, so they
  // don't block processing.
  const nowProcessed = contributions.filter(c =>
    !(Array.isArray(c.payload.deltas) ? c.payload.deltas : []).some(
      d => d && typeof d.path === 'string' && failedPages.has(d.path)
    )
  );

  // New watermark. Two rules, in order:
  //   1. Advance to the max clamped contributed_at across processed
  //      submissions (future-dated / unparseable stamps never advance it —
  //      M8 — they'd otherwise skip everyone else's honest contributions).
  //   2. INVARIANT — never advance so far that an UNPROCESSED submission
  //      falls out of the next listing window (watermark − SKEW_WINDOW):
  //      a failed submission must stay listable until it processes, even
  //      if much newer submissions processed fine this run.
  const nowProcessedSet = new Set(nowProcessed.map(c => c.submissionId));
  let newWatermarkMs = Number.isFinite(watermarkMs) ? watermarkMs : 0;
  const nowMs = nowDate.getTime();
  for (const c of nowProcessed) {
    const t = Date.parse(c.payload.contributed_at);
    if (Number.isFinite(t)) newWatermarkMs = Math.max(newWatermarkMs, Math.min(t, nowMs));
  }
  for (const c of contributions) {
    if (nowProcessedSet.has(c.submissionId)) continue;
    const t = Date.parse(c.payload.contributed_at);
    if (Number.isFinite(t)) {
      // Keep this unprocessed submission inside the window with a 1-minute
      // safety margin. (Unparseable stamps are always re-listed by the
      // adapters, so they can't be lost to the window.)
      newWatermarkMs = Math.min(newWatermarkMs, Math.min(t, nowMs) + SKEW_WINDOW_MS - 60_000);
    }
  }

  // processed_ids: (previous ∩ still-listed) ∪ newly processed ∪ foreign.
  // Anything no longer returned by the window-filtered listing is either
  // older than the window (excluded by the since-filter forever) or deleted
  // — safe to drop, which keeps the set bounded to one skew-window.
  const listedIds = new Set(listed.map(c => c.submissionId));
  const newProcessedIds = [
    ...[...processedIds].filter(id => listedIds.has(id)),
    ...nowProcessed.map(c => c.submissionId),
    ...foreignIds,
  ];

  try {
    const runNumber = (prevState && typeof prevState.run_number === 'number') ? prevState.run_number + 1 : 1;
    await adapter.writeMeta('state.last-synthesis', {
      at: nowIso, // kept for display + back-compat with older readers
      // null = nothing fully processed yet → next run lists everything.
      // (Readers check for the KEY's presence, so null never falls back to `at`.)
      watermark: newWatermarkMs > 0 ? new Date(newWatermarkMs).toISOString() : null,
      processed_ids: newProcessedIds,
      run_number: runNumber,
      pages_written: pagesWritten,
      pages_failed: pagesFailed,
      conflicts: totalConflicts,
      processed_contributions: nowProcessed.length,
    });
  } catch (err) {
    console.error(`[sharedbrain-synthesis] failed to write last-synthesis meta: ${err.message}`);
  }

  // Update connection state (last_synthesis_at for visibility in UI later)
  patchFn(connection.id, { last_synthesis_at: nowIso });

  const conflictPagesText = conflictPages.length > 0
    ? ` in ${conflictPages.slice(0, 5).join(', ')}${conflictPages.length > 5 ? ` (+${conflictPages.length - 5} more)` : ''}`
    : '';
  const summary = `Synthesis complete: ${pagesWritten} page${pagesWritten !== 1 ? 's' : ''} written from ${contributions.length} contribution${contributions.length !== 1 ? 's' : ''}` +
    (totalConflicts > 0 ? `, ${totalConflicts} unresolved contradiction${totalConflicts !== 1 ? 's' : ''} flagged${conflictPagesText}` : '') +
    (pagesFailed > 0 ? `, ${pagesFailed} page${pagesFailed !== 1 ? 's' : ''} failed (see warnings)` : '');
  onProgress('done', summary, {
    processed_contributions: contributions.length,
    pages_written: pagesWritten,
    pages_failed: pagesFailed,
    conflicts: totalConflicts,
    conflict_pages: conflictPages,
  });

  return {
    ok: true,
    processed_contributions: contributions.length,
    pages_written: pagesWritten,
    pages_failed: pagesFailed,
    conflicts: totalConflicts,
    // v3.0.4 (M17): which pages carry ⚠️ CONFLICTING SOURCES markers this
    // run — additive, so the UI can point the admin at the affected pages.
    conflict_pages: conflictPages,
  };
}

// Exposed for testing
export const __testing = {
  CONFLICT_MARKER,
  JACCARD_INDEPENDENT_THRESHOLD,
  MAX_CONTRADICTION_PAIRS_PER_PAGE,
  SKEW_WINDOW_MS,
  FACTS_PER_PAGE_SOFT_CAP,
  SERVER_MAX_FACT_CHARS,
  defaultShortenId,
  resolveContradiction,
  rebuildIndex,
};
