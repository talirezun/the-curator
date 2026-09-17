#!/usr/bin/env node
/**
 * scripts/test-health-scan-cache.js — OFFLINE
 *
 * The `scanWiki` signature cache (v3.57.0, WP4).
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * Measured on an isolated copy of the maintainer's real 3,447-page `articles`
 * wiki: `GET /api/health/:domain` -> `scanWiki` took 733-920ms on every call —
 * it re-reads every page from disk every time, and the Domains view re-runs
 * it on every mount and every domain switch. `scanWiki(domain, opts)` now
 * keeps a per-wikiDir `{signature, result}` cache, modelled on
 * `logDateCache` in files.js: the key is a cheap hash of `relpath:mtimeNs:
 * size` over every file the scan actually reads, so there is no invalidation
 * LOGIC to get wrong — a changed file changes its stat, which changes the
 * hash, which misses. Measured warm-hit cost on the same 3,447-page corpus:
 * ~30-40ms end to end (from ~800ms cold) — see the WP4 final report for the
 * full before/after table; that corpus is not fixtured here because a
 * 3,400-file tree is exactly the kind of large, slow setup an OFFLINE suite
 * must not carry (npm test must stay fast and free). What IS carried here is
 * every BEHAVIOURAL claim the cache makes, proven against small synthetic
 * wikis: a hit is byte-identical to the scan that produced it; a miss is
 * forced by every kind of change `scanWikiUncached` can observe (a page
 * edited, added or deleted; `.health-dismissed.jsonl` edited); a cache entry
 * can never be corrupted by a caller mutating what it was handed; the bound
 * evicts the OLDEST domain, not a random one; and two overlapping scans of
 * one domain never corrupt each other's entry.
 *
 * ── WHY THE ASSERTIONS ARE SHAPED THE WAY THEY ARE ──────────────────────────
 *
 * "Was this a hit or a miss" is never asked directly — there is no exported
 * flag or counter for it, and adding one would mean adding a new export to
 * health.js, which means adding it to scripts/test-wiki-page.js §8c's pinned
 * export-surface enumeration (a file this change does not otherwise need to
 * touch — see the docblock above `computeWikiSignature` in health.js).
 * Instead, every "this must be a miss" claim is proven the way a user would
 * actually notice a stale cache: the wiki changed, so the REPORT'S CONTENT
 * must change to match (a new broken link appears, an orphan disappears,
 * `counts.entities` grows) — behavioural proof, not implementation detail,
 * per this repo's own rule ("assert behaviour, not the presence of a line of
 * source", CLAUDE.md v3.0.17). The one place a content-level signal is not
 * available — proving the LRU bound evicts the OLDEST entry rather than an
 * arbitrary one — falls back to `scannedAt`: a miss stamps a fresh
 * timestamp, a hit reuses the original, and `sleep(2)` between the fill and
 * the re-check guarantees the two are distinguishable regardless of host
 * clock resolution.
 *
 * `HEALTH_SCAN_CACHE_MAX` (8 in health.js) is not exported for the same
 * export-surface reason, so section G hardcodes 9 (= 8 + 1) scans to force
 * exactly one eviction; if that constant ever changes, this section's count
 * needs updating alongside it — a comment at the section marks the coupling.
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, appendFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const { __setDomainsDirOverride } = await import(path.join(REPO, 'src/brain/config.js'));
const { scanWiki } = await import(path.join(REPO, 'src/brain/health.js'));
const { addDismissal } = await import(path.join(REPO, 'src/brain/health-dismissed.js'));

let passed = 0;
let failed = 0;
function assert(cond, label, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
}
function section(t) { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 68 - t.length))}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Order-sensitive deep-equality is fine here: every report compared is built
// by the SAME code path (the object literal at the end of scanWikiUncached),
// so key order can never differ between the two sides of a comparison.
function deepEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

/** A report with `scannedAt` removed, for comparing MISS vs MISS/HIT content
 *  across calls that are legitimately allowed to disagree on timestamp. */
function withoutScannedAt(report) {
  const { scannedAt, ...rest } = report;
  return rest;
}

// ── Fixture plumbing (same shape as test-health-merge-links.js) ────────────
const ROOT = mkdtempSync(path.join(os.tmpdir(), 'curator-health-cache-'));
__setDomainsDirOverride(ROOT);

function page(title, type, related = '') {
  return `---
type: ${type}
tags: [type/${type}]
---

# ${title}

## Key Facts

- a fact about ${title}

## Related

${related}`;
}

function mkDomain(name, files) {
  const wiki = path.join(ROOT, name, 'wiki');
  for (const f of ['entities', 'concepts', 'summaries']) {
    mkdirSync(path.join(wiki, f), { recursive: true });
  }
  writeFileSync(path.join(ROOT, name, 'CLAUDE.md'), '# schema\n');
  writeFileSync(path.join(wiki, 'index.md'), '# Index\n');
  writeFileSync(path.join(wiki, 'log.md'), '# Log\n');
  for (const [rel, body] of Object.entries(files)) {
    writeFileSync(path.join(wiki, rel), body);
  }
  return wiki;
}

// ═══════════════════════════════════════════════════════════════════════════
section('A. A repeat scan of an unchanged wiki is a byte-identical HIT');
// ═══════════════════════════════════════════════════════════════════════════
{
  mkDomain('cache-basic', {
    'entities/alpha.md': page('Alpha', 'entity', '- [[beta]]\n'),
    'entities/beta.md': page('Beta', 'entity'),
    'concepts/gamma.md': page('Gamma', 'concept'),
    'summaries/paper.md': page('Paper', 'summary', '- [[alpha]]\n'),
  });

  const r1 = await scanWiki('cache-basic');
  assert(r1.counts.entities === 2 && r1.counts.concepts === 1 && r1.counts.summaries === 1,
    'A.1 PRECONDITION — the fixture scans as expected', JSON.stringify(r1.counts));
  assert(r1.brokenLinks.length === 0, 'A.2 PRECONDITION — zero broken links to start');

  await sleep(2); // so a wrongly-fresh scan would be CATCHABLE by its scannedAt
  const r2 = await scanWiki('cache-basic');
  assert(deepEqual(r1, r2),
    'A.3 a second scan of an UNCHANGED wiki is byte-identical to the first, INCLUDING scannedAt — proof of a genuine hit reusing the original scan, not a fresh one that happens to agree',
    `r1=${JSON.stringify(r1)}\n      r2=${JSON.stringify(r2)}`);

  const r3 = await scanWiki('cache-basic', { noCache: true });
  assert(deepEqual(withoutScannedAt(r1), withoutScannedAt(r3)),
    'A.4 opts.noCache forces a genuinely fresh scan whose CONTENT still matches the cached truth (only scannedAt may legitimately differ)',
    `r1=${JSON.stringify(withoutScannedAt(r1))}\n      r3=${JSON.stringify(withoutScannedAt(r3))}`);
  assert(typeof r3.scannedAt === 'string' && r3.scannedAt !== r1.scannedAt,
    'A.5 …and noCache really did re-stamp scannedAt rather than silently reading the cache anyway');

  const r4 = await scanWiki('cache-basic');
  assert(deepEqual(r1, r4),
    'A.6 …and a normal call right after the noCache bypass is STILL a hit on the pre-existing cache entry (noCache did not clobber it)');
}

// ═══════════════════════════════════════════════════════════════════════════
section('B. A cache entry cannot be corrupted by what a caller does to its copy');
// ═══════════════════════════════════════════════════════════════════════════
{
  mkDomain('cache-mutate-safety', {
    'entities/one.md': page('One', 'entity', '- [[two]]\n'),
    'entities/two.md': page('Two', 'entity'),
  });

  const r1 = await scanWiki('cache-mutate-safety');
  // Sabotage the object the caller was handed, the way a careless consumer
  // (or `enforceSizeLimit`'s trimming, or a future UI sort) might.
  r1.counts.entities = 999999;
  r1.brokenLinks.push({ sourceFile: 'nowhere', linkText: 'planted', suggestedTarget: null });
  r1.domain = 'SABOTAGED';

  const r2 = await scanWiki('cache-mutate-safety');
  assert(r2.counts.entities === 2,
    'B.1 mutating a PREVIOUS caller\'s counts does not leak into the next call', JSON.stringify(r2.counts));
  assert(r2.brokenLinks.length === 0,
    'B.2 …nor does a planted array element', JSON.stringify(r2.brokenLinks));
  assert(r2.domain === 'cache-mutate-safety',
    'B.3 …nor does overwriting a scalar field', r2.domain);

  // And the reverse direction: mutating what THIS call returned must not
  // reach back into the cache either.
  r2.counts.entities = -1;
  const r3 = await scanWiki('cache-mutate-safety');
  assert(r3.counts.entities === 2,
    'B.4 …and mutating THIS call\'s own return value does not poison the entry for the NEXT caller either', JSON.stringify(r3.counts));
}

// ═══════════════════════════════════════════════════════════════════════════
section('C. Editing an existing page forces a miss, and the fresh result then stabilises into its own hit');
// ═══════════════════════════════════════════════════════════════════════════
{
  const wiki = mkDomain('cache-edit', {
    'entities/one.md': page('One', 'entity'),
  });

  const before = await scanWiki('cache-edit');
  assert(before.brokenLinks.length === 0, 'C.1 PRECONDITION — no broken links yet');

  writeFileSync(path.join(wiki, 'entities/one.md'),
    page('One', 'entity', '- [[ghost-page]]\n'));

  const afterEdit = await scanWiki('cache-edit');
  assert(afterEdit.brokenLinks.length === 1 && afterEdit.brokenLinks[0].linkText === 'ghost-page',
    'C.2 THE MISS — the edited content is reflected: the new broken link appears, proving this was not a stale hit',
    JSON.stringify(afterEdit.brokenLinks));

  const afterEditAgain = await scanWiki('cache-edit');
  assert(deepEqual(afterEdit, afterEditAgain),
    'C.3 …and immediately re-scanning the now-unchanged wiki is a genuine hit on the NEW state (not stuck re-scanning, not stuck on the OLD state)');
}

// ═══════════════════════════════════════════════════════════════════════════
section('D. Deleting a page forces a miss (a link that resolved now cannot)');
// ═══════════════════════════════════════════════════════════════════════════
{
  const wiki = mkDomain('cache-delete', {
    'entities/keep.md': page('Keep', 'entity', '- [[doomed]]\n'),
    'entities/doomed.md': page('Doomed', 'entity'),
  });

  const before = await scanWiki('cache-delete');
  assert(before.brokenLinks.length === 0 && before.counts.entities === 2,
    'D.1 PRECONDITION — both pages exist and the link resolves', JSON.stringify(before));

  rmSync(path.join(wiki, 'entities/doomed.md'));

  const after = await scanWiki('cache-delete');
  assert(after.counts.entities === 1,
    'D.2 THE MISS — the deleted page is gone from the count', JSON.stringify(after.counts));
  assert(after.brokenLinks.some((b) => b.linkText === 'doomed'),
    'D.3 …and the link that used to resolve is now reported broken — proof this is a fresh read of the current disk state, not a cached one from before the delete',
    JSON.stringify(after.brokenLinks));
}

// ═══════════════════════════════════════════════════════════════════════════
section('E. Adding a page forces a miss (the new page is counted and appears as an orphan)');
// ═══════════════════════════════════════════════════════════════════════════
{
  const wiki = mkDomain('cache-add', {
    'entities/existing.md': page('Existing', 'entity'),
  });

  const before = await scanWiki('cache-add');
  assert(before.counts.entities === 1, 'E.1 PRECONDITION — one entity to start');

  writeFileSync(path.join(wiki, 'entities/newcomer.md'), page('Newcomer', 'entity'));

  const after = await scanWiki('cache-add');
  assert(after.counts.entities === 2,
    'E.2 THE MISS — the new file is counted', JSON.stringify(after.counts));
  assert(after.orphans.some((o) => o.slug === 'newcomer'),
    'E.3 …and it appears as an orphan (zero incoming links) — a stale cache would show neither',
    JSON.stringify(after.orphans));
}

// ═══════════════════════════════════════════════════════════════════════════
section('F. Editing .health-dismissed.jsonl forces a miss, independent of every wiki page');
// ═══════════════════════════════════════════════════════════════════════════
{
  mkDomain('cache-dismiss', {
    'entities/lonely.md': page('Lonely', 'entity'),
  });

  const before = await scanWiki('cache-dismiss');
  assert(before.orphans.length === 1 && before.orphans[0].slug === 'lonely',
    'F.1 PRECONDITION — the orphan is visible and undismissed', JSON.stringify(before.orphans));
  assert(before.counts.dismissed === 0, 'F.2 PRECONDITION — nothing dismissed yet');

  // Real API, not a hand-rolled JSONL line — see the docblock on why.
  const dismissResult = await addDismissal('cache-dismiss', 'orphans', before.orphans[0]);
  assert(dismissResult.ok, 'F.3 the dismissal itself was recorded', JSON.stringify(dismissResult));

  const after = await scanWiki('cache-dismiss');
  assert(after.orphans.length === 0,
    'F.4 THE MISS — the dismissed orphan no longer appears, even though NO WIKI PAGE changed (only .health-dismissed.jsonl did)',
    JSON.stringify(after.orphans));
  assert(after.counts.dismissed === 1,
    'F.5 …and the dismissed count reflects it', JSON.stringify(after.counts));

  const afterAgain = await scanWiki('cache-dismiss');
  assert(deepEqual(after, afterAgain),
    'F.6 …and the new (post-dismissal) state is itself now a stable hit');
}

// ═══════════════════════════════════════════════════════════════════════════
section('G. The bound evicts the OLDEST domain, not an arbitrary one');
// ═══════════════════════════════════════════════════════════════════════════
// HEALTH_SCAN_CACHE_MAX is 8 in health.js and is NOT exported (adding an
// export here means adding it to test-wiki-page.js's pinned export-surface
// enumeration too — see the file docblock). 9 = 8 + 1 forces exactly one
// eviction. If the constant changes, this count must change with it.
{
  const NAMES = Array.from({ length: 9 }, (_, i) => `cache-evict-${i}`);
  const scannedAtByName = new Map();

  for (const name of NAMES) {
    mkDomain(name, { 'entities/only.md': page('Only', 'entity') });
    const r = await scanWiki(name);
    scannedAtByName.set(name, r.scannedAt);
    await sleep(2); // guarantee distinct scannedAt across all 9, and vs. the re-checks below
  }

  const oldest = NAMES[0];
  const newest = NAMES[NAMES.length - 1];

  const oldestAgain = await scanWiki(oldest);
  assert(oldestAgain.scannedAt !== scannedAtByName.get(oldest),
    'G.1 the OLDEST domain (first scanned) was evicted — re-scanning it produced a FRESH scannedAt, not the original one',
    `original=${scannedAtByName.get(oldest)} now=${oldestAgain.scannedAt}`);

  const newestAgain = await scanWiki(newest);
  assert(newestAgain.scannedAt === scannedAtByName.get(newest),
    'G.2 …while the MOST RECENTLY scanned domain is still cached (its scannedAt is unchanged) — proof this is real LRU/FIFO eviction and not the whole cache going cold',
    `original=${scannedAtByName.get(newest)} now=${newestAgain.scannedAt}`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('H. Two overlapping scans of the same domain never corrupt the cache entry');
// ═══════════════════════════════════════════════════════════════════════════
{
  mkDomain('cache-concurrent', {
    'entities/a.md': page('A', 'entity', '- [[b]]\n'),
    'entities/b.md': page('B', 'entity'),
    'concepts/c.md': page('C', 'concept'),
  });

  const [r1, r2] = await Promise.all([scanWiki('cache-concurrent'), scanWiki('cache-concurrent')]);
  assert(deepEqual(withoutScannedAt(r1), withoutScannedAt(r2)),
    'H.1 two concurrent scans of the same never-before-seen domain both return CORRECT, equal-by-content reports (no partial/garbled state from the race)',
    `r1=${JSON.stringify(withoutScannedAt(r1))}\n      r2=${JSON.stringify(withoutScannedAt(r2))}`);
  assert(r1.counts.entities === 2 && r1.counts.concepts === 1,
    'H.2 …and the content is actually right, not just mutually consistent', JSON.stringify(r1.counts));

  const r3 = await scanWiki('cache-concurrent');
  assert(r3.counts.entities === 2 && r3.counts.concepts === 1 && Array.isArray(r3.brokenLinks),
    'H.3 …and the cache entry the race left behind is sane: a normal call afterwards returns a well-formed report',
    JSON.stringify(r3));
}

// ── Cleanup ──────────────────────────────────────────────────────────────
try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
__setDomainsDirOverride(null);

console.log(`\nPassed: ${passed}   Failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
