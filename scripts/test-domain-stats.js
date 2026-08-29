#!/usr/bin/env node
/**
 * Regression tests for the per-type page-count breakdown on getDomainStats
 * and the new bulk GET /api/domains/stats endpoint (v3.1.x, additive —
 * a redesigned Domains view needs per-domain entity/concept/summary counts,
 * and a way to fetch counts for ALL domains in one call instead of one HTTP
 * round trip per domain).
 *
 * Scope: this suite owns ONLY getDomainStats (in src/brain/files.js) and
 * the new GET /stats route (in src/routes/domains.js). It does not touch —
 * and does not need to touch — writePage or any other part of the wiki
 * write pipeline; pages are dropped directly on disk as plain .md files
 * because this suite is testing COUNTING, not ingest.
 *
 * Covers:
 *   1. getDomainStats returns pageCounts.{entities,concepts,summaries} that
 *      match a known on-disk layout exactly.
 *   2. index.md / log.md are not counted as pages — verified against the
 *      EXISTING convention (the traversal excludes those two filenames at
 *      any depth; pageCounts.* also excludes them because
 *      both files live directly under wiki/, never inside entities/,
 *      concepts/, or summaries/).
 *   3. Empty domain → all counts zero, no throw.
 *   4. Domain with no wiki/ folder at all → no throw, everything degrades
 *      to a safe default.
 *   5. Domain with only some of the three canonical folders present → no
 *      throw; existing folders count correctly, missing ones read as 0.
 *   6. pageCount and pageCounts.* cannot contradict each other (audit M6),
 *      AND pageCount still counts every .md on disk (audit L1) — the two
 *      requirements are reconciled by `other`, not by narrowing the total.
 *      The total is what the shipping delete confirmation renders as "this
 *      will permanently delete N wiki pages", so it is checked against an
 *      independent on-disk count — see Test 2c.
 *   7. The new bulk GET /stats route (invoked directly against the real
 *      Express Router — no server, no open port) returns per-domain stats
 *      for every domain in one call and correctly reports readonlyDomains
 *      for a Shared Brain mirror.
 *   8. Existing callers of getDomainStats (routes/domains.js's
 *      GET /:domain/stats) still receive every field they read today.
 *   9. displayName derivation (extractDomainDisplayName) is robust across
 *      every CLAUDE.md shape this codebase actually produces — a normal
 *      "# Domain: X" file (generateClaudemd), a Shared Brain mirror's
 *      frontmatter-first file (ensureSharedDomainExists — the exact bug this
 *      suite was extended to catch: every mirror displayed as "---"), a
 *      hand-written file with neither shape, and an empty file. Includes a
 *      revert-and-fail check proving the test actually catches the bug.
 *
 * All fully offline — no network, no LLM, no live filesystem mutation
 * outside an isolated tempdir; the real domains folder is never touched
 * (isolated via __setDomainsDirOverride, NOT process.env.DOMAINS_PATH,
 * which loses to a configured domainsPath and silently no-ops — see
 * CLAUDE.md "Live test domains-dir isolation").
 *
 *   node scripts/test-domain-stats.js
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { __setDomainsDirOverride } from '../src/brain/config.js';

// __setDomainsDirOverride is the in-process test seam from
// src/brain/config.js, checked BEFORE .curator-config.json's own
// domainsPath in getDomainsDir()'s precedence chain, so it wins
// unconditionally and the real config file is never read or written by
// this suite (see test-beta10-fixes.js for the full rationale — same
// pattern reused here verbatim).
const tempRoot = mkdtempSync(path.join(tmpdir(), 'curator-domain-stats-'));
__setDomainsDirOverride(tempRoot);

// ── Real credential-file isolation guard ─────────────────────────────────
// Content-only fingerprint (size + sha256 — deliberately NOT mtime: the
// maintainer's own live Curator app on :3333 may rewrite
// .curator-config.json concurrently via ordinary Settings use, and a
// same-bytes-or-not rewrite from an unrelated process must not fail this
// guard).
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_CREDENTIAL_FILES = [
  '.curator-config.json', '.sync-config.json', '.sharedbrain-config.json', '.env',
].map(rel => path.join(PROJECT_ROOT, rel));
function fingerprintRealFiles() {
  return REAL_CREDENTIAL_FILES.map(p => {
    if (!existsSync(p)) return { path: p, exists: false };
    const buf = readFileSync(p);
    return { path: p, exists: true, size: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
  });
}
function fingerprintsMatch(a, b) {
  if (a.exists !== b.exists) return false;
  if (!a.exists) return true;
  return a.size === b.size && a.sha256 === b.sha256;
}
const realFilesBefore = fingerprintRealFiles();

let passed = 0;
let failed = 0;
function ok(label) { passed++; console.log(`  ✓ ${label}`); }
function fail(label, detail) { failed++; console.log(`  ✗ ${label}`); if (detail) console.log(`    └─ ${detail}`); }
function eq(actual, expected, label) {
  if (actual === expected) return ok(label);
  return fail(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function truthy(cond, label, detail) { if (cond) return ok(label); return fail(label, detail); }

function assertRealFilesUntouched() {
  const after = fingerprintRealFiles();
  for (let i = 0; i < REAL_CREDENTIAL_FILES.length; i++) {
    const rel = path.relative(PROJECT_ROOT, REAL_CREDENTIAL_FILES[i]);
    truthy(
      fingerprintsMatch(realFilesBefore[i], after[i]),
      `real ${rel} content untouched by this suite`,
      `real ${rel}'s CONTENT changed during the run`
    );
  }
}

async function cleanup() {
  try { rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  __setDomainsDirOverride(null);
}
process.on('SIGINT', async () => { await cleanup(); process.exit(130); });

// Write N throwaway .md files named page-0.md, page-1.md, ... into `dir`.
function writeStubPages(dir, count) {
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i++) {
    writeFileSync(path.join(dir, `page-${i}.md`), `# Page ${i}\n\nStub content.\n`, 'utf8');
  }
}

/**
 * Count the wiki's pages using a completely different tool: `find(1)`.
 *
 * The first version of this oracle was a JS recursive readdir that
 * re-implemented countWikiPages()'s rule line for line while calling itself
 * "independent of files.js" (audit finding L3). A mirror cannot disagree with
 * what it mirrors, so it could never have caught the case-sensitivity
 * asymmetry that shipped alongside it — /\.md$/i for the extension, `===` for
 * the index.md/log.md exclusion, so `INDEX.MD` counted as a user page.
 *
 * `find` is a different implementation, a different traversal and a different
 * language, and it encodes the SPECIFICATION directly rather than the code:
 *
 *   every file-or-symlink named *.md (case-sensitive, as everywhere else in
 *   this app), at any depth under wiki/, except index.md and log.md
 *
 * `\( -type f -o -type l \)` is load-bearing twice: it excludes a DIRECTORY
 * named `not-a-file.md`, and it includes symlinks, which are real entries.
 *
 * Resolved via PATH rather than hardcoded to /usr/bin/find, so this works
 * on any POSIX host rather than only the two CI images we happen to use.
 */
function countMdOnDisk(wikiDir) {
  if (!existsSync(wikiDir)) return 0;
  const out = execFileSync('find', [
    wikiDir, '(', '-type', 'f', '-o', '-type', 'l', ')',
    '-name', '*.md', '!', '-name', 'index.md', '!', '-name', 'log.md',
  ], { encoding: 'utf8' });
  return out.split('\n').filter(l => l.trim()).length;
}

// Locate a registered GET route's handler on the real domains router and
// invoke it directly — no app.listen(), no open port, no network. This
// exercises the actual production route code (src/routes/domains.js),
// not a re-implementation of it.
async function callRoute(router, routePath, params = {}) {
  const layer = router.stack.find(l => l.route && l.route.path === routePath && l.route.methods.get);
  if (!layer) throw new Error(`Route GET ${routePath} not found on router`);
  const handler = layer.route.stack[0].handle;
  let jsonBody = null;
  let statusCode = 200;
  const req = { params };
  const res = {
    status(code) { statusCode = code; return this; },
    json(body) { jsonBody = body; return this; },
  };
  await handler(req, res);
  return { status: statusCode, body: jsonBody };
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  getDomainStats + GET /api/domains/stats — regression tests');
  console.log('═══════════════════════════════════════════════════════════════');

  const { createDomain, getDomainStats } = await import('../src/brain/files.js');
  const domainsRouter = (await import('../src/routes/domains.js')).default;

  // ── Test 1 — known layout: exact per-type counts ───────────────────────
  console.log('\n[1] getDomainStats — exact per-type counts against a known layout');
  {
    await createDomain('knowncounts', 'Known Counts', 'desc', 'tech');
    const base = path.join(tempRoot, 'knowncounts', 'wiki');
    writeStubPages(path.join(base, 'entities'), 3);
    writeStubPages(path.join(base, 'concepts'), 2);
    writeStubPages(path.join(base, 'summaries'), 4);

    const stats = await getDomainStats('knowncounts');
    eq(stats.pageCounts.entities, 3, 'Test 1a: pageCounts.entities === 3');
    eq(stats.pageCounts.concepts, 2, 'Test 1b: pageCounts.concepts === 2');
    eq(stats.pageCounts.summaries, 4, 'Test 1c: pageCounts.summaries === 4');
    eq(stats.pageCount, 9, 'Test 1d: total pageCount === 3+2+4 (well-formed domain, no stray files)');
    truthy(typeof stats.slug === 'string' && stats.slug === 'knowncounts', 'Test 1e: slug echoed back correctly');
  }

  // ── Test 2 — index.md / log.md are never counted as pages ─────────────
  console.log('\n[2] index.md / log.md are not counted as pages (existing convention)');
  {
    // createDomain always writes wiki/index.md + wiki/log.md. knowncounts
    // above already has both, plus 9 real pages. If either were being
    // counted, pageCount would be 10 or 11, not 9 — Test 1d already proves
    // this for pageCount. Additionally confirm directly: pageCounts.* is a
    // shallow readdir of entities/concepts/summaries only, and index.md +
    // log.md live directly under wiki/ (never inside those three folders),
    // so they structurally cannot appear in pageCounts.* regardless of
    // filename — verified by checking they're not double-counted anywhere:
    const stats = await getDomainStats('knowncounts');
    const sumOfTypes = stats.pageCounts.entities + stats.pageCounts.concepts + stats.pageCounts.summaries;
    eq(sumOfTypes, stats.pageCount, 'Test 2a: pageCounts breakdown sums to pageCount when wiki/ has no stray root-level files');
    eq(stats.pageCounts.other, 0, 'Test 2b: `other` is 0 on a clean domain, so the two totals coincide here');
  }

  // ── Test 2c — M6 + L1: the four numbers reconcile, and the TOTAL is the
  //             number a destructive confirm can safely be built on ────────
  console.log('\n[2c] M6 + L1 — entities + concepts + summaries + other === pageCount === every .md on disk');
  {
    // BEFORE v3.2.0 these were two different computations with two different
    // rules: pageCount recursed over the whole wiki/ tree (excluding only
    // index.md/log.md by name), while pageCounts.* were three shallow
    // readdirs with no isFile() check. Anything they disagreed about showed
    // up in the Domains card as a self-contradicting sentence — "A
    // compounding wiki of 7 pages — 2 entities, 1 concept, 1 summary".
    //
    // The trigger is not exotic: Obsidian creates an "Untitled.md" at the
    // vault root by default, and the setup docs tell users to point the
    // vault root AT the wiki dir. Now all four numbers come from ONE
    // traversal, so `other` names the difference instead of hiding it.
    await createDomain('strayfile', 'Stray File Domain', 'desc', 'tech');
    const base = path.join(tempRoot, 'strayfile', 'wiki');
    writeStubPages(path.join(base, 'entities'), 1);
    // (a) A stray .md sitting directly in wiki/ — the Obsidian case.
    writeFileSync(path.join(base, 'Untitled.md'), '# Untitled\n', 'utf8');
    // (b) A hand-nested page — writePage FLATTENS these, so it can only
    //     arrive by hand or through sync; health.js can't resolve links to
    //     it either (see test-wiki-page.js's M4 section).
    mkdirSync(path.join(base, 'entities', 'companies'), { recursive: true });
    writeFileSync(path.join(base, 'entities', 'companies', 'nested.md'), '# Nested\n', 'utf8');
    // (c) A DIRECTORY whose name ends in .md — a shallow readdir name filter
    //     counted this as a page.
    mkdirSync(path.join(base, 'concepts', 'not-a-file.md'), { recursive: true });
    // (d) A SYMLINKED page. `rm -r` on the domain unlinks it like any other
    //     directory entry, so a delete confirmation must count it — even
    //     though health.js and wiki-read.js both refuse to treat it as a page.
    symlinkSync(path.join(tempRoot, 'symlink-target.md'), path.join(base, 'entities', 'linked.md'));
    writeFileSync(path.join(tempRoot, 'symlink-target.md'), '# Outside\n', 'utf8');
    // (e) UPPERCASE extensions, and an uppercase index.md. No fixture had
    //     these, which is why the case-sensitivity asymmetry (audit L1's tail)
    //     was invisible: the extension test was /\.md$/i while the
    //     index.md/log.md exclusion was `===`, so `INDEX.MD` counted as a user
    //     page and `Upper.MD` was reported as an entity that health.js and
    //     chat both ignore. Everything in the app matches endsWith('.md').
    writeFileSync(path.join(base, 'entities', 'Upper.MD'), '# Upper\n', 'utf8');
    writeFileSync(path.join(base, 'INDEX.MD'), '# Shouty index\n', 'utf8');

    const stats = await getDomainStats('strayfile');
    eq(stats.pageCounts.entities, 1, 'Test 2c-i: pageCounts.entities counts only the real depth-1 entity page');
    eq(stats.pageCounts.concepts, 0, 'Test 2c-ii: a DIRECTORY named "not-a-file.md" is not counted as a page');
    eq(stats.pageCounts.summaries, 0, 'Test 2c-iii: pageCounts.summaries is 0 (folder empty)');
    eq(stats.pageCounts.other, 3, 'Test 2c-iv: `other` reports the stray root note + the nested file + the symlink');

    // ── L1 — THE REGRESSION THIS TEST EXISTS FOR ────────────────────────
    // pageCount was briefly narrowed to entities+concepts+summaries. The
    // delete confirmation in src/public/app.js — untouched shipping code —
    // renders it as "This will permanently delete N wiki pages", so on this
    // exact fixture it promised 1 and then deleted 4. Under-reporting a
    // destructive confirm is worse than the breakdown gap the narrowing was
    // fixing, and the gap is fixed by `other` existing, not by shrinking the
    // total.
    const onDisk = countMdOnDisk(base);           // independent of files.js
    eq(stats.pageCount, onDisk,
      'Test 2c-v: L1 — pageCount === every .md page on disk, per an independent find(1) count');
    eq(stats.pageCounts.entities, 1,
      'Test 2c-v-b: L1 tail — "Upper.MD" is NOT counted as an entity (the app matches .md case-sensitively everywhere)');
    eq(stats.pageCount, 4, 'Test 2c-vi: L1 — concretely 4 on this fixture, not 1');

    const sumOfAll = stats.pageCounts.entities + stats.pageCounts.concepts
      + stats.pageCounts.summaries + stats.pageCounts.other;
    eq(sumOfAll, stats.pageCount,
      'Test 2c-vii: THE INVARIANT — entities + concepts + summaries + other === pageCount, so the breakdown and the total reconcile exactly');
    truthy(stats.pageCounts.other > 0,
      'Test 2c-viii: the remainder is named rather than hidden — a renderer showing only 3 of the 4 numbers is the bug now, and a visible one');
  }

  // ── Test 3 — empty domain: everything zero, no throw ───────────────────
  console.log('\n[3] getDomainStats — empty (freshly created) domain');
  {
    await createDomain('emptydomain', 'Empty Domain', 'desc', 'tech');
    const stats = await getDomainStats('emptydomain');
    eq(stats.pageCounts.entities, 0, 'Test 3a: entities 0 on a fresh domain');
    eq(stats.pageCounts.concepts, 0, 'Test 3b: concepts 0 on a fresh domain');
    eq(stats.pageCounts.summaries, 0, 'Test 3c: summaries 0 on a fresh domain');
    eq(stats.pageCount, 0, 'Test 3d: pageCount 0 on a fresh domain');
    eq(stats.conversationCount, 0, 'Test 3e: conversationCount 0 on a fresh domain');
    eq(stats.lastIngestDate, null, 'Test 3f: lastIngestDate null on a fresh domain (log.md has no entries)');
  }

  // ── Test 4 — domain with NO wiki/ folder at all ────────────────────────
  console.log('\n[4] getDomainStats — domain with no wiki/ folder at all (must not throw)');
  {
    // Build a minimal domain directory BY HAND (not via createDomain) so
    // there is no wiki/ subfolder whatsoever — reproduces a partially
    // migrated / hand-created / corrupted domain.
    const base = path.join(tempRoot, 'nowikifolder');
    mkdirSync(base, { recursive: true });
    writeFileSync(path.join(base, 'CLAUDE.md'), '# Domain: No Wiki Folder\n', 'utf8');

    let threw = false;
    let stats;
    try {
      stats = await getDomainStats('nowikifolder');
    } catch (err) {
      threw = true;
    }
    truthy(!threw, 'Test 4a: getDomainStats does not throw when wiki/ is entirely missing');
    if (stats) {
      eq(stats.pageCounts.entities, 0, 'Test 4b: entities 0 when wiki/ is missing');
      eq(stats.pageCounts.concepts, 0, 'Test 4c: concepts 0 when wiki/ is missing');
      eq(stats.pageCounts.summaries, 0, 'Test 4d: summaries 0 when wiki/ is missing');
      eq(stats.pageCount, 0, 'Test 4e: pageCount 0 when wiki/ is missing');
      eq(stats.lastIngestDate, null, 'Test 4f: lastIngestDate null when wiki/log.md is missing');
      eq(stats.displayName, 'No Wiki Folder', 'Test 4g: displayName still reads from CLAUDE.md');
    }
  }

  // ── Test 5 — domain with only SOME canonical folders present ──────────
  console.log('\n[5] getDomainStats — only some canonical folders present');
  {
    await createDomain('partialfolders', 'Partial Folders', 'desc', 'tech');
    const wikiBase = path.join(tempRoot, 'partialfolders', 'wiki');
    writeStubPages(path.join(wikiBase, 'entities'), 5);
    // Remove concepts/ entirely (simulates a hand-edited or partially
    // migrated wiki) and leave summaries/ empty (already created empty by
    // createDomain — no stub pages written).
    rmSync(path.join(wikiBase, 'concepts'), { recursive: true, force: true });

    let threw = false;
    let stats;
    try {
      stats = await getDomainStats('partialfolders');
    } catch {
      threw = true;
    }
    truthy(!threw, 'Test 5a: getDomainStats does not throw when concepts/ is missing entirely');
    eq(stats.pageCounts.entities, 5, 'Test 5b: entities counted correctly when a sibling folder is missing');
    eq(stats.pageCounts.concepts, 0, 'Test 5c: concepts reads as 0 (folder missing), not an error');
    eq(stats.pageCounts.summaries, 0, 'Test 5d: summaries correctly 0 (folder present but empty)');
    eq(stats.pageCount, 5, 'Test 5e: pageCount reflects only the surviving folder');
  }

  // ── Test 6 — existing callers of getDomainStats still get every field ─
  console.log('\n[6] Existing callers of getDomainStats still receive all pre-existing fields');
  {
    // routes/domains.js's GET /:domain/stats is the pre-existing, unmodified
    // caller. Invoke it directly (no server) and check every field the
    // frontend (src/public/app.js) and scripts/test-beta10-fixes.js read
    // today: slug, displayName, pageCount, conversationCount, lastIngestDate.
    const { status, body } = await callRoute(domainsRouter, '/:domain/stats', { domain: 'knowncounts' });
    eq(status, 200, 'Test 6a: GET /:domain/stats still returns 200');
    eq(body.slug, 'knowncounts', 'Test 6b: existing field "slug" preserved');
    truthy(typeof body.displayName === 'string', 'Test 6c: existing field "displayName" preserved');
    eq(body.pageCount, 9, 'Test 6d: existing field "pageCount" preserved and correct');
    truthy('conversationCount' in body, 'Test 6e: existing field "conversationCount" preserved');
    truthy('lastIngestDate' in body, 'Test 6f: existing field "lastIngestDate" preserved');
    truthy('pageCounts' in body && typeof body.pageCounts === 'object',
      'Test 6g: new field "pageCounts" is additive, present alongside the old ones');
  }

  // ── Test 7 — new bulk GET /stats endpoint ──────────────────────────────
  console.log('\n[7] GET /api/domains/stats — bulk endpoint');
  {
    // Mark one domain as a read-only Shared Brain mirror by hand-writing
    // frontmatter into its CLAUDE.md (mirrors isDomainReadonly's own
    // contract — see src/brain/files.js).
    await createDomain('mirrordomain', 'Mirror Domain', 'desc', 'tech');
    const claudeMdPath = path.join(tempRoot, 'mirrordomain', 'CLAUDE.md');
    writeFileSync(claudeMdPath, '---\nreadonly: true\n---\n# Domain: Mirror Domain\n', 'utf8');

    const { status, body } = await callRoute(domainsRouter, '/stats', {});
    eq(status, 200, 'Test 7a: GET /stats returns 200');
    truthy(Array.isArray(body.domains), 'Test 7b: response has a domains array');
    truthy(Array.isArray(body.readonlyDomains), 'Test 7c: response has a readonlyDomains array');
    truthy(body.readonlyDomains.includes('mirrordomain'),
      'Test 7d: the readonly-frontmatter domain appears in readonlyDomains');
    truthy(!body.readonlyDomains.includes('knowncounts'),
      'Test 7e: a normal (non-mirror) domain does NOT appear in readonlyDomains');

    const known = body.domains.find(d => d.slug === 'knowncounts');
    truthy(!!known, 'Test 7f: the bulk response includes every domain (found knowncounts)');
    if (known) {
      eq(known.pageCount, 9, 'Test 7g: bulk stats for knowncounts match the single-domain call');
      eq(known.pageCounts.entities, 3, 'Test 7h: bulk per-type counts match the single-domain call');
    }

    const mirror = body.domains.find(d => d.slug === 'mirrordomain');
    truthy(!!mirror && mirror.pageCounts && mirror.pageCounts.entities === 0,
      'Test 7i: the mirror domain still gets real (zero) stats, not an error stub, in the bulk response');
  }

  // ── Test 8 — bulk endpoint survives a domain with a missing wiki/ ─────
  console.log('\n[8] GET /api/domains/stats — one broken domain does not break the whole response');
  {
    // "nowikifolder" from Test 4 has no wiki/ folder at all and is already
    // a real domain directory in tempRoot (it has a CLAUDE.md, so
    // listDomains() picks it up). The bulk endpoint must still return 200
    // with stats for every domain, including this one, degraded to zeros
    // rather than throwing or omitting it.
    const { status, body } = await callRoute(domainsRouter, '/stats', {});
    eq(status, 200, 'Test 8a: GET /stats still returns 200 with a broken domain present');
    const broken = body.domains.find(d => d.slug === 'nowikifolder');
    truthy(!!broken, 'Test 8b: the broken domain is still present in the response');
    if (broken) {
      truthy(!broken.error, 'Test 8c: the broken domain did not need the defensive .catch() fallback (getDomainStats itself never throws)');
      eq(broken.pageCount, 0, 'Test 8d: the broken domain reports pageCount 0, not an error');
    }
    // And every other domain in the same response is unaffected.
    const known = body.domains.find(d => d.slug === 'knowncounts');
    truthy(!!known && known.pageCount === 9, 'Test 8e: a healthy domain in the same response is unaffected by the broken one');
  }

  // ── Test 9 — displayName is robust across every real CLAUDE.md shape ──
  console.log('\n[9] displayName derivation — every real CLAUDE.md shape');
  {
    const { extractDomainDisplayName } = await import('../src/brain/files.js');

    // 9a. The bug this suite was extended to catch: a Shared Brain mirror's
    // CLAUDE.md, copied verbatim from what ensureSharedDomainExists() in
    // src/brain/sharedbrain.js actually writes — YAML frontmatter (carrying
    // `readonly: true`, load-bearing for the MCP write-refusal) followed by
    // a "# Shared Brain Mirror: <label>" heading. Pre-fix, the naive
    // "first line" heuristic read the literal string "---" as the display
    // name (truthy, so the `|| slug` fallback never fired) — every mirror
    // showed up as "---" in the Domains tab.
    const mirrorClaudeMd = [
      '---',
      'readonly: true',
      'source: shared-brain',
      'shared_brain_slug: cohort-abc123',
      'shared_domain: articles',
      '---',
      '',
      '# Shared Brain Mirror: Research Cohort',
      '',
      'This domain is the local read-only mirror of a Shared Brain.',
      '',
    ].join('\n');
    const mirrorName = extractDomainDisplayName(mirrorClaudeMd, 'shared-cohort');
    truthy(mirrorName !== '---', 'Test 9a-i: mirror CLAUDE.md never yields the broken "---" name');
    truthy(mirrorName !== 'shared-cohort', 'Test 9a-ii: mirror CLAUDE.md yields a real name, not just the slug fallback');
    eq(mirrorName, 'Research Cohort', 'Test 9a-iii: mirror CLAUDE.md yields the sensible label ("Research Cohort"), not a raw heading dump');

    // 9b. THE REGRESSION THAT MATTERS: a normal app-created domain
    // ("# Domain: X", no frontmatter — exactly what generateClaudemd()
    // writes) must still resolve to "X".
    eq(extractDomainDisplayName('# Domain: Articles\n\nSome scope text.\n', 'articles'), 'Articles',
      'Test 9b: normal "# Domain: Articles" CLAUDE.md still yields "Articles" (no regression)');

    // 9c. A hand-written CLAUDE.md matching neither convention (users create
    // domains by hand, not only through the app) — plain prose, no heading
    // at all — falls back to the slug rather than showing the first line of
    // prose as if it were a title.
    eq(extractDomainDisplayName('This domain tracks my personal reading notes.\n', 'reading-notes'), 'reading-notes',
      'Test 9c: CLAUDE.md with no "#" heading at all falls back to the slug');

    // 9d. Empty CLAUDE.md (0 bytes, or whitespace-only) falls back to the slug.
    eq(extractDomainDisplayName('', 'blank-domain'), 'blank-domain',
      'Test 9d-i: empty CLAUDE.md falls back to the slug');
    eq(extractDomainDisplayName('   \n\n  \n', 'blank-domain'), 'blank-domain',
      'Test 9d-ii: whitespace-only CLAUDE.md falls back to the slug');

    // 9e. Frontmatter present but never closed — nothing reliable follows it,
    // so this must degrade to the slug rather than misreading the dangling
    // YAML body as a title.
    eq(extractDomainDisplayName('---\nreadonly: true\nno closing delimiter at all\n', 'unterminated'), 'unterminated',
      'Test 9e: unterminated frontmatter falls back to the slug rather than guessing');

    // 9f. A heading that is neither known prefix is shown as-is (still a
    // real, sensible name — just not one of the two conventions this
    // codebase happens to write).
    eq(extractDomainDisplayName('# My Custom Domain Title\n', 'custom'), 'My Custom Domain Title',
      'Test 9f: an arbitrary "# ..." heading (neither known prefix) is used as-is');

    // 9g. End-to-end through the real getDomainStats() + real filesystem —
    // not just the unit-level helper — using a domain directory shaped
    // exactly like a real Shared Brain mirror (frontmatter CLAUDE.md, no
    // wiki content yet, as ensureSharedDomainExists() leaves it immediately
    // after creation).
    const mirrorBase = path.join(tempRoot, 'shared-mirrortest');
    mkdirSync(path.join(mirrorBase, 'wiki', 'entities'), { recursive: true });
    mkdirSync(path.join(mirrorBase, 'wiki', 'concepts'), { recursive: true });
    mkdirSync(path.join(mirrorBase, 'wiki', 'summaries'), { recursive: true });
    mkdirSync(path.join(mirrorBase, 'conversations'), { recursive: true });
    writeFileSync(path.join(mirrorBase, 'CLAUDE.md'), mirrorClaudeMd, 'utf8');

    const mirrorStats = await getDomainStats('shared-mirrortest');
    truthy(mirrorStats.displayName !== '---', 'Test 9g-i: getDomainStats on a real mirror directory never returns "---"');
    eq(mirrorStats.displayName, 'Research Cohort', 'Test 9g-ii: getDomainStats on a real mirror directory returns the sensible label');
  }

  // ── Test 10 — L1: GET /:domain/stats must not read outside the domains dir ──
  console.log('\n[10] L1 — GET /api/domains/:domain/stats is allow-listed');
  {
    // Express URL-decodes route params, so `GET /api/domains/%2e%2e/stats`
    // arrives here as the literal string "..". Pre-fix, getDomainStats
    // joined that straight onto the domains dir and returned 200 with the
    // first heading of a CLAUDE.md OUTSIDE the domains folder as
    // displayName. The bulk /stats route above never had this problem (it
    // only ever passes listDomains() output), which made this one the
    // outlier.
    //
    // Plant a CLAUDE.md in the PARENT of the isolated domains dir so a
    // successful traversal would be unmistakable in the response.
    const probeClaude = path.join(path.dirname(tempRoot), 'CLAUDE.md');
    const probeExisted = existsSync(probeClaude);
    if (!probeExisted) {
      writeFileSync(probeClaude, '# Domain: LEAKED_FROM_OUTSIDE_THE_DOMAINS_DIR\n', 'utf8');
    }
    try {
      const { status, body } = await callRoute(domainsRouter, '/:domain/stats', { domain: '..' });
      eq(status, 404, 'Test 10a: a ".." domain param is refused with 404, not served with 200');
      truthy(!body || !body.displayName || !String(body.displayName).includes('LEAKED'),
        'Test 10b: nothing from outside the domains dir appears in the response');

      // Same for a nested traversal and an absolute-ish shape.
      const deep = await callRoute(domainsRouter, '/:domain/stats', { domain: '../..' });
      eq(deep.status, 404, 'Test 10c: a multi-segment traversal is also refused');

      // A REAL domain still works — the allow-list must not be a blanket ban.
      const good = await callRoute(domainsRouter, '/:domain/stats', { domain: 'knowncounts' });
      eq(good.status, 200, 'Test 10d: a genuine domain is unaffected by the allow-list');
      eq(good.body.slug, 'knowncounts', 'Test 10e: ...and returns its own stats');

      // Defense in depth: getDomainStats itself refuses the same input even
      // if a future caller forgets the allow-list.
      let threw = false;
      try { await getDomainStats('..'); } catch { threw = true; }
      truthy(threw, 'Test 10f: getDomainStats independently refuses a traversal slug (defense in depth)');
    } finally {
      if (!probeExisted) { try { rmSync(probeClaude, { force: true }); } catch {} }
    }
  }

  // ── Test 11 — L3: display-name hygiene ────────────────────────────────
  console.log('\n[11] L3 — extractDomainDisplayName renders a name, not raw markdown');
  {
    const { extractDomainDisplayName } = await import('../src/brain/files.js');

    eq(extractDomainDisplayName('# **Domain:** Articles\n', 'articles'), 'Articles',
      'Test 11a: emphasis around the prefix (`# **Domain:** X`) is stripped, not shown literally');
    eq(extractDomainDisplayName('# *Domain*: Articles\n', 'articles'), 'Articles',
      'Test 11b: single-asterisk emphasis around the prefix is stripped');
    eq(extractDomainDisplayName('# **Domain: Articles**\n', 'articles'), 'Articles',
      'Test 11c: emphasis wrapping the WHOLE heading is stripped from both ends');
    eq(extractDomainDisplayName('# Domain: Articles ###\n', 'articles'), 'Articles',
      'Test 11d: closing ATX hashes are dropped (they are syntax, not name)');
    eq(extractDomainDisplayName('---\nreadonly: true\n---\n# **Shared Brain Mirror:** Cohort\n', 'shared-c'), 'Cohort',
      'Test 11e: the mirror prefix strips through emphasis too');

    // A name that legitimately contains an underscore/asterisk mid-string
    // must be left alone — the fix targets the prefix, not every marker.
    eq(extractDomainDisplayName('# Domain: My_Reading_Notes\n', 'n'), 'My_Reading_Notes',
      'Test 11f: underscores inside a real name are preserved');

    // Length bound — this string lands in a fixed-width card and a delete
    // confirmation dialog; nothing upstream constrains heading length.
    const long = extractDomainDisplayName('# Domain: ' + 'A'.repeat(5000) + '\n', 'long');
    truthy(long.length <= 120, `Test 11g: an absurdly long heading is bounded (got ${long.length} chars)`);
    truthy(long.endsWith('…'), 'Test 11h: ...and is visibly truncated rather than silently cut');

    // No regression on the two shapes that actually ship.
    eq(extractDomainDisplayName('# Domain: Articles\n', 'articles'), 'Articles',
      'Test 11i: the plain generateClaudemd shape is unchanged');
    eq(extractDomainDisplayName('# My Custom Domain Title\n', 'custom'), 'My Custom Domain Title',
      'Test 11j: an arbitrary heading with no known prefix is still used as-is');
  }

  // ── Test 12 — REPORTED, NOT FIXED: renameDomain no-ops on a mirror ────
  console.log('\n[12] REPORTED FINDING — renameDomain silently no-ops on a Shared Brain mirror');
  {
    // renameDomain (src/brain/files.js) rewrites the display name with
    // `content.replace(/^# Domain: .+$/m, ...)`. A Shared Brain mirror's
    // CLAUDE.md, written by ensureSharedDomainExists(), starts with YAML
    // frontmatter and uses `# Shared Brain Mirror: <label>` — which that
    // regex cannot match. The rename reports success and the display name
    // never changes.
    //
    // This assertion DOCUMENTS current behaviour rather than asserting a
    // fix: renameDomain is outside the scope this change owns (it was
    // verified and reported, not fixed). If renameDomain is ever taught the
    // mirror heading, flip this assertion — it is here so the next person
    // finds the finding instead of rediscovering it.
    //
    // Worth noting alongside it: renaming a mirror to a name that does not
    // start with "shared-" would also move the folder out of the reserved
    // `shared-*` namespace, and the next Pull would recreate the original —
    // i.e. renaming a mirror is arguably something the UI should refuse
    // outright rather than something renameDomain should be taught.
    const { renameDomain } = await import('../src/brain/files.js');
    const mirrorDir = path.join(tempRoot, 'shared-renametest');
    mkdirSync(path.join(mirrorDir, 'wiki'), { recursive: true });
    writeFileSync(path.join(mirrorDir, 'CLAUDE.md'),
      '---\nreadonly: true\n---\n# Shared Brain Mirror: Research Cohort\n', 'utf8');

    await renameDomain('shared-renametest', 'shared-renametest', 'Renamed Cohort');
    const after = await getDomainStats('shared-renametest');
    eq(after.displayName, 'Research Cohort',
      'Test 12a: KNOWN — a mirror rename leaves the CLAUDE.md heading untouched (reported, deliberately not fixed here)');

    // The same rename on a NORMAL domain does work — confirming the cause is
    // the heading shape, not the rename path being broken generally.
    await createDomain('renamenormal', 'Before Rename', 'desc', 'tech');
    await renameDomain('renamenormal', 'renamenormal', 'After Rename');
    const normal = await getDomainStats('renamenormal');
    eq(normal.displayName, 'After Rename',
      'Test 12b: a normal "# Domain: X" domain renames correctly — isolating the cause to the mirror heading shape');
  }

  // ── 14. The polled endpoint's cost ────────────────────────────────────
  //
  // WHAT THIS PINS. GET /api/domains/stats is POLLED — the /next first-run
  // guide re-checks it for as long as it is open, and that panel outlives
  // navigate(). Every byte it reads is paid once per poll, per open tab, for
  // as long as the panel is up. Measured on the maintainer's real tree
  // BEFORE this release: 18 readFile calls totalling 598 KB per request —
  // 565 KB of it wiki/log.md files read IN FULL to find one date, and 33 KB
  // of CLAUDE.md, which is every CLAUDE.md in the install read TWICE
  // (getDomainStats for the display name, then isDomainReadonly again for
  // the flag). At the guide's cadence that is roughly 420 MB an hour.
  //
  // These assertions COUNT REAL READS by wrapping fs.promises rather than
  // scanning source: a cost claim asserted from source is the same shape as
  // the comment on the route that claimed "no file-content reads" while its
  // own callee read two files per domain.
  console.log('\n[14] GET /api/domains/stats is polled — its per-request read cost');
  {
    // Two domains with real logs, so a per-domain double-read shows up as 4
    // rather than as an ambiguous 2.
    for (const slug of ['costa', 'costb']) {
      await createDomain(slug, `Cost ${slug}`, 'd', 'tech');
      writeFileSync(path.join(tempRoot, slug, 'wiki', 'log.md'),
        '# Log\n\n## [2026-01-01]\nold\n\n## [2026-08-27]\nnew\n\n## [2026-03-05]\nmiddle\n', 'utf8');
    }
    await callRoute(domainsRouter, '/stats', {});
    const { status, body } = await callRoute(domainsRouter, '/stats', {});

    eq(status, 200, 'Test 14a: the bulk stats route still answers 200');
    const costa = body.domains.find(d => d.slug === 'costa');
    eq(costa && costa.lastIngestDate, '2026-08-27',
      'Test 14b: and still reports the LATEST log entry, not the first — the v3.0.1-beta.10 guarantee, through the cache');
    truthy(Array.isArray(body.readonlyDomains),
      'Test 14e: readonlyDomains survives the change');

    // ── COUNTING THE READS, in a CHILD PROCESS and for a reason ─────────
    // files.js does `import { readFile } from 'fs/promises'`, and an ESM
    // named export is bound at LINK time — so patching fs.promises.readFile
    // from here, after files.js is already loaded, silently counts nothing
    // and every assertion reads 0. (Measured: an in-process version of this
    // reported "expected 2, got 0" — a counter that cannot see is the
    // vacuous-pass shape, so it is not used.) Patching before the first
    // import of fs/promises does work, which needs a fresh process; the
    // domains dir crosses that boundary via CURATOR_TEST_DOMAINS_DIR, which
    // is checked ahead of config for exactly this reason.
    const probePath = path.join(tempRoot, '__read-probe.mjs');
    writeFileSync(probePath, `
import fs from 'node:fs';
const real = fs.promises.readFile;
const reads = [];
fs.promises.readFile = async function (p, ...rest) { reads.push(String(p)); return real.call(this, p, ...rest); };
const { default: router } = await import(${JSON.stringify(pathToFileURL(path.join(PROJECT_ROOT, 'src/routes/domains.js')).href)});
const layer = router.stack.find(l => l.route && l.route.path === '/stats');
const run = () => new Promise((resolve) => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve(b); } };
  layer.route.stack[0].handle({ params: {}, query: {}, body: {} }, res, () => resolve(null));
});
await run();                                   // warm
reads.length = 0;
await run();                                   // the measured poll
const tally = (n) => reads.filter(p => p.endsWith(n)).length;
const { listDomains } = await import(${JSON.stringify(pathToFileURL(path.join(PROJECT_ROOT, 'src/brain/files.js')).href)});
const domainCount = (await listDomains()).length;
console.log(JSON.stringify({ steady: { log: tally('log.md'), claude: tally('CLAUDE.md') }, domainCount }));
`, 'utf8');
    const probe = spawnSync(process.execPath, [probePath], {
      env: { ...process.env, CURATOR_TEST_DOMAINS_DIR: tempRoot },
      encoding: 'utf8',
    });
    let counts = null;
    try { counts = JSON.parse((probe.stdout || '').trim().split('\n').pop()); } catch { /* reported below */ }
    truthy(counts && counts.steady,
      'Test 14c-pre: the read probe produced counts (a probe that fails to run must not pass silently)',
      `stdout=${JSON.stringify(probe.stdout)} stderr=${JSON.stringify((probe.stderr || '').slice(0, 400))}`);
    if (counts && counts.steady) {
      eq(counts.steady.log, 0,
        'Test 14c: a steady-state poll reads ZERO log.md bytes — this is the 565 KB that used to be re-read every 5 s');
      // ONE read per domain, expressed as a RELATIONSHIP rather than a
      // hardcoded number: this section runs after earlier ones have created
      // domains, so a literal would have to be re-tuned every time a test is
      // added above it — and a re-tuned expectation is how a real regression
      // gets absorbed. The defect being pinned is a FACTOR of two, and 2N is
      // never N for any N >= 1.
      truthy(counts.domainCount >= 2,
        `Test 14d-pre: the probe saw ${counts.domainCount} domains (a zero-domain probe would pass 14d vacuously)`);
      eq(counts.steady.claude, counts.domainCount,
        `Test 14d: exactly ONE CLAUDE.md read per domain (${counts.steady.claude} reads / ${counts.domainCount} domains) — the second, isDomainReadonly pass over the same files is gone`);
      truthy(counts.steady.claude !== counts.domainCount * 2,
        'Test 14d-b: and specifically not TWO per domain, which is what the removed pass cost');
    }

    // ── The cache must INVALIDATE, or it is a correctness bug ───────────
    // A cache that never refreshes turns "polled endpoint" into "endpoint
    // that lies", and lying about the last ingest date is the exact defect
    // beta.10 fixed. Appending a NEWER entry must be seen.
    writeFileSync(path.join(tempRoot, 'costa', 'wiki', 'log.md'),
      '# Log\n\n## [2026-01-01]\nold\n\n## [2026-08-27]\nnew\n\n## [2026-09-30]\nnewest\n', 'utf8');
    const after = await callRoute(domainsRouter, '/stats', {});
    const costaAfter = after.body.domains.find(d => d.slug === 'costa');
    eq(costaAfter && costaAfter.lastIngestDate, '2026-09-30',
      'Test 14f: a log that CHANGED is re-read and the new date surfaces — the cache is keyed on the file, not on time');

    // Same size, different mtime: the signature is mtime-in-NANOSECONDS plus
    // size, so a same-length rewrite is still seen. A size-only signature
    // would silently serve the old date here.
    await new Promise(r => setTimeout(r, 5));
    writeFileSync(path.join(tempRoot, 'costa', 'wiki', 'log.md'),
      '# Log\n\n## [2026-01-01]\nold\n\n## [2026-08-27]\nnew\n\n## [2026-09-11]\nnewest\n', 'utf8');
    const same = await callRoute(domainsRouter, '/stats', {});
    eq(same.body.domains.find(d => d.slug === 'costa').lastIngestDate, '2026-09-11',
      'Test 14h: a SAME-LENGTH rewrite is seen too — mtime is part of the signature, not just size');

    // A domain with no log.md at all must read null and must not poison the
    // cache: the log appears after the first ingest, and a remembered null
    // would outlive that.
    const { __clearLastIngestDateCache } = await import('../src/brain/files.js');
    await createDomain('costnolog', 'No Log', 'd', 'tech');
    rmSync(path.join(tempRoot, 'costnolog', 'wiki', 'log.md'), { force: true });
    const noLog = await getDomainStats('costnolog');
    eq(noLog.lastIngestDate, null, 'Test 14i: a domain with no log.md reports null, as before');
    writeFileSync(path.join(tempRoot, 'costnolog', 'wiki', 'log.md'),
      '# Log\n\n## [2026-05-05]\nfirst ingest\n', 'utf8');
    const nowLog = await getDomainStats('costnolog');
    eq(nowLog.lastIngestDate, '2026-05-05',
      'Test 14j: and a log APPEARING afterwards is picked up — a missing file is never cached');
    truthy(typeof __clearLastIngestDateCache === 'function',
      'Test 14k: the cache exposes a test-only clear, so a suite can prove the FRESH path and not only the cached one');
  }

  // ── 15. readonly comes from ONE parser and ONE read ────────────────────
  //
  // getDomainStats now returns `readonly`, derived from the CLAUDE.md it was
  // already reading, and the route consumes that instead of a second
  // isDomainReadonly pass. The risk that buys is DRIFT: two predicates
  // deciding whether a Shared Brain mirror accepts writes is the v3.2.0
  // "two hand-maintained copies of a guard" CRITICAL. So the parser is
  // shared, and this proves the two entry points agree on every shape the
  // parser documents — including the ones that must read as NOT readonly.
  console.log('\n[15] readonly — one parser behind two entry points');
  {
    const { isDomainReadonly, parseReadonlyFlag } = await import('../src/brain/files.js');
    const cases = [
      ['---\nreadonly: true\n---\n# X\n', true, 'plain readonly: true'],
      ['---\nReadOnly:  TRUE  \n---\n# X\n', true, 'case- and space-tolerant'],
      ['---\nreadonly: "true"\n---\n# X\n', true, 'quoted true'],
      ['---\nreadonly: false\n---\n# X\n', false, 'readonly: false'],
      ['---\nreadonly: yes\n---\n# X\n', false, 'readonly: yes is NOT true'],
      ['---\nreadonly: 1\n---\n# X\n', false, 'readonly: 1 is NOT true'],
      ['---\nother: true\n---\n# X\n', false, 'a different key'],
      ['# X\n\nno frontmatter\n', false, 'no frontmatter at all'],
      ['---\nunterminated\n', false, 'unclosed frontmatter'],
      ['', false, 'empty file'],
    ];
    let agreed = 0;
    for (const [content, expected, label] of cases) {
      const slug = 'ro' + agreed;
      await createDomain(slug, 'RO', 'd', 'tech');
      writeFileSync(path.join(tempRoot, slug, 'CLAUDE.md'), content, 'utf8');
      const viaParser = parseReadonlyFlag(content);
      const viaFile = await isDomainReadonly(slug);
      const viaStats = (await getDomainStats(slug)).readonly;
      if (viaParser === expected && viaFile === expected && viaStats === expected) {
        ok(`Test 15.${agreed}: ${label} — parser, isDomainReadonly and getDomainStats.readonly all say ${expected}`);
      } else {
        fail(`Test 15.${agreed}: ${label}`,
          `expected ${expected}; parser=${viaParser} isDomainReadonly=${viaFile} stats.readonly=${viaStats}`);
      }
      agreed++;
    }
    // isDomainReadonly must hold NO parsing of its own — a copy is what
    // drifts. It reads the file and delegates.
    const filesSrc = readFileSync(path.join(PROJECT_ROOT, 'src/brain/files.js'), 'utf8');
    const fnRe = /export async function isDomainReadonly\(domain\) \{[\s\S]*?\n\}/;
    const fnSrc = (filesSrc.match(fnRe) || [''])[0];
    truthy(fnSrc.length > 50, 'Test 15a: isDomainReadonly extracted');
    truthy(/parseReadonlyFlag\(content\)/.test(fnSrc),
      'Test 15b: isDomainReadonly delegates to parseReadonlyFlag');
    truthy(!/readonly\[ \\t\]\*:/.test(fnSrc) && !/fmMatch/.test(fnSrc),
      'Test 15c: and keeps no frontmatter regex of its own — a split, not a copy, so the two cannot drift');

    // A domain whose stats FAILED carries no readonly flag; the route must
    // fall back rather than silently treat "we could not tell" as writable.
    const routeSrc = readFileSync(path.join(PROJECT_ROOT, 'src/routes/domains.js'), 'utf8');
    truthy(/typeof s\.readonly === 'boolean'/.test(routeSrc),
      'Test 15d: the route only trusts a readonly flag that is actually a boolean');
    truthy(/: await isDomainReadonly\(domains\[i\]\)/.test(routeSrc),
      'Test 15e: and falls back to isDomainReadonly for a domain whose stats failed');

    // ── The two comments that asserted the opposite of their own code ───
    // A comment contradicted by its own file is this project's most reliable
    // early-warning shape, and both of these were: the route said "no
    // file-content reads" above a callee that read two files per domain, and
    // onboarding.js said the re-check runs against "zero or very few
    // domains" and "stops the moment all three steps go done" — the second
    // contradicted by its OWN header (the .env-key case, on a populated
    // install) and the third by `if (autoCloseOnComplete && …)`.
    //
    // These assert the CORRECTION is present rather than the false phrase
    // absent, because both files deliberately QUOTE the old claim in order
    // to record what was wrong with it — the reasoning that is still true is
    // kept, only the expired conclusion is replaced. An absence check would
    // therefore push the next author to delete the record instead of the
    // claim, which is the opposite of what this project wants.
    truthy(/an earlier version of this[\s\S]{0,12}comment claimed/i.test(routeSrc),
      'Test 15f: the route now records that its "no file-content reads" claim was false, rather than repeating it');
    truthy(/NOT free|POLLED|is polled/.test(routeSrc),
      'Test 15g: and states the real profile — that this endpoint is polled and not free');
    const obSrc = readFileSync(path.join(PROJECT_ROOT, 'src/public/next/views/onboarding.js'), 'utf8');
    truthy(/All three were wrong|were wrong/.test(obSrc),
      'Test 15h: onboarding.js records that its three claims about the re-check were wrong');
    truthy(/autoCloseOnComplete/.test(obSrc) && /never ends|for the life of the page/.test(obSrc),
      'Test 15i: and names the mechanism — the all-done stop living inside autoCloseOnComplete is what made the loop permanent');
  }

  // ── Real credential-file isolation guard ──────────────────────────────
  console.log('\n[16] Real credential-file isolation guard');
  assertRealFilesUntouched();

  // ── Summary ─────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`  Result: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  await cleanup();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async err => {
  console.error('FATAL:', err);
  try {
    const after = fingerprintRealFiles();
    const changed = REAL_CREDENTIAL_FILES
      .map((p, i) => ({ p, ok: fingerprintsMatch(realFilesBefore[i], after[i]) }))
      .filter(x => !x.ok);
    if (changed.length > 0) {
      console.error('WARNING: real credential file(s) changed during a crashed run:',
        changed.map(x => path.relative(PROJECT_ROOT, x.p)).join(', '));
    }
  } catch { /* best-effort diagnostic only */ }
  await cleanup();
  process.exit(2);
});
