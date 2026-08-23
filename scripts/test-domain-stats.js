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
 *      EXISTING convention (pageCount's recursive scan explicitly excludes
 *      those two filenames; pageCounts.* naturally excludes them because
 *      both files live directly under wiki/, never inside entities/,
 *      concepts/, or summaries/).
 *   3. Empty domain → all counts zero, no throw.
 *   4. Domain with no wiki/ folder at all → no throw, everything degrades
 *      to a safe default.
 *   5. Domain with only some of the three canonical folders present → no
 *      throw; existing folders count correctly, missing ones read as 0.
 *   6. A pre-existing behavioural quirk of pageCount (recursive over the
 *      whole wiki/ tree) vs pageCounts.* (shallow, three folders only) is
 *      demonstrated and reported, not silently "fixed" — see Test 2b.
 *   7. The new bulk GET /stats route (invoked directly against the real
 *      Express Router — no server, no open port) returns per-domain stats
 *      for every domain in one call and correctly reports readonlyDomains
 *      for a Shared Brain mirror.
 *   8. Existing callers of getDomainStats (routes/domains.js's
 *      GET /:domain/stats) still receive every field they read today.
 *
 * All fully offline — no network, no LLM, no live filesystem mutation
 * outside an isolated tempdir; the real domains folder is never touched
 * (isolated via __setDomainsDirOverride, NOT process.env.DOMAINS_PATH,
 * which loses to a configured domainsPath and silently no-ops — see
 * CLAUDE.md "Live test domains-dir isolation").
 *
 *   node scripts/test-domain-stats.js
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
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
  }

  // ── Test 2b — a real, pre-existing behavioural quirk (reported, not fixed) ──
  console.log('\n[2b] KNOWN QUIRK — pageCount (recursive) vs pageCounts.* (shallow, 3 folders) can diverge');
  {
    // pageCount's countMd() recurses over the ENTIRE wiki/ tree and excludes
    // only files literally named index.md or log.md, wherever they appear.
    // pageCounts.entities/concepts/summaries only ever readdir their own
    // canonical folder. A stray .md file dropped anywhere else under wiki/
    // (wiki/ root itself, or a non-canonical subfolder a user created by
    // hand outside the app) is counted by pageCount but NOT by pageCounts.*.
    // This is pre-existing pageCount behaviour, unmodified by this task —
    // flagging it here rather than silently changing pageCount's semantics,
    // per the task's instruction to report inconsistencies rather than fix
    // them silently.
    await createDomain('strayfile', 'Stray File Domain', 'desc', 'tech');
    const base = path.join(tempRoot, 'strayfile', 'wiki');
    writeStubPages(path.join(base, 'entities'), 1);
    // A stray .md file sitting directly in wiki/ (not index.md/log.md, not
    // inside any canonical folder) — e.g. a manually-dropped note.
    writeFileSync(path.join(base, 'stray-note.md'), '# Stray\n', 'utf8');

    const stats = await getDomainStats('strayfile');
    eq(stats.pageCounts.entities, 1, 'Test 2b-i: pageCounts.entities ignores the stray root-level file');
    eq(stats.pageCounts.concepts, 0, 'Test 2b-ii: pageCounts.concepts is 0 (folder empty)');
    eq(stats.pageCounts.summaries, 0, 'Test 2b-iii: pageCounts.summaries is 0 (folder empty)');
    eq(stats.pageCount, 2, 'Test 2b-iv: pageCount DOES count the stray file (1 entity + 1 stray = 2)');
    const sumOfTypes = stats.pageCounts.entities + stats.pageCounts.concepts + stats.pageCounts.summaries;
    truthy(sumOfTypes !== stats.pageCount,
      'Test 2b-v: confirms the divergence exists (sum of pageCounts.* !== pageCount) — documented quirk, not a bug introduced here');
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

  // ── Real credential-file isolation guard ──────────────────────────────
  console.log('\n[9] Real credential-file isolation guard');
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
