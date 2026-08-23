#!/usr/bin/env node
/**
 * Offline battle test for src/brain/wiki-read.js — the per-page wiki reader
 * that backs GET /api/wiki/:domain/page (the citation-chip reader panel's
 * data source).
 *
 * Covers:
 *   1. Reading a single page (frontmatter, title, body) without touching the
 *      rest of the domain.
 *   2. Backlinks — computed with EXACTLY the same "does this [[link]] point
 *      here" rule health.js's scanWiki() uses (bare links resolve only
 *      against entities/concepts; summaries always need the folder prefix;
 *      a non-canonical folder-prefixed link to an entity/concept still
 *      counts, matching health.js's own quirk).
 *   3. Error cases: unknown domain, unknown page, no-frontmatter page,
 *      zero-backlink (orphan) page, read-only shared-* mirror (reads must
 *      still work).
 *   4. Path-traversal defenses at both layers (normaliseRequestedPath +
 *      resolveInsideWiki), at least three distinct attack shapes.
 *   5. Backlink cache invalidation — add a page, edit a page in place — both
 *      must be reflected on the next read (correctness over staleness).
 *
 * Isolated via __setDomainsDirOverride (never process.env.DOMAINS_PATH — see
 * CLAUDE.md's "Active Development Decisions": the env var loses to a
 * configured domainsPath and would silently no-op on a real install).
 *
 * Run with:  node scripts/test-wiki-page.js
 * Exit code 0 if all green; non-zero on any failure.
 */
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { __setDomainsDirOverride } from '../src/brain/config.js';
import { isDomainReadonly } from '../src/brain/files.js';
import {
  getWikiPage,
  getBacklinks,
  normaliseRequestedPath,
  resolveInsideWiki,
  linkPointsToPage,
  parseFrontmatter,
  deriveTitle,
  __clearWikiReadCache,
} from '../src/brain/wiki-read.js';

// ── Harness ─────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];
function ok(label) { passed++; console.log(`  ✓ ${label}`); }
function bad(label, err) { failed++; failures.push({ label, err }); console.log(`  ✗ ${label}`); if (err) console.log(`    └─ ${err}`); }
function assert(cond, label, err) { cond ? ok(label) : bad(label, err || 'assertion failed'); }
async function assertThrowsStatus(fn, expectedStatus, label) {
  try {
    await fn();
    bad(label, `expected a throw with status ${expectedStatus}, got none`);
  } catch (err) {
    if (err && err.status === expectedStatus) ok(label);
    else bad(label, `threw, but status was ${err && err.status} (message: ${err && err.message})`);
  }
}
function section(name) { console.log(`\n── ${name} ──`); }

const work = mkdtempSync(path.join(tmpdir(), 'wiki-page-test-'));
const domainsDir = path.join(work, 'domains');

function wikiDirFor(domain) {
  return path.join(domainsDir, domain, 'wiki');
}
function writePageFile(domain, relPath, content) {
  const abs = path.join(wikiDirFor(domain), relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  return abs;
}

try {
  __setDomainsDirOverride(domainsDir);

  // ── Fixture domain: "articles" ─────────────────────────────────────────
  // entities/tali-rezun.md   — links to concepts/curator.md and
  //                             summaries/my-article.md (correct [[summaries/x]] form)
  // concepts/curator.md      — links back to tali-rezun via a BARE link
  // summaries/my-article.md — links to tali-rezun via a BARE link (entities mentioned)
  // entities/via-prefix.md  — links to tali-rezun via the NON-canonical
  //                             `[[entities/tali-rezun]]` folder-prefixed form —
  //                             health.js counts this as an existing link
  //                             (flagged separately as a style issue, but not
  //                             broken) — backlinks must match that exactly.
  // entities/bare-to-summary.md — links to the SUMMARY via a BARE
  //                             `[[my-article]]` (no summaries/ prefix) — per
  //                             wiki convention this must NOT resolve, so it
  //                             must NOT appear as a backlink of the summary.
  // entities/unrelated.md   — links to nothing relevant; must never appear.
  // entities/orphan.md      — no incoming links at all.

  writePageFile('articles', 'entities/tali-rezun.md',
    '---\ntags: [type/entity]\n---\n' +
    '# Tali Rezun\n\n## Related\n- [[curator]]\n- [[summaries/my-article]]\n');

  writePageFile('articles', 'concepts/curator.md',
    '---\ntags: [type/concept]\n---\n' +
    '# The Curator\n\n## Related\n- [[tali-rezun]]\n');

  writePageFile('articles', 'summaries/my-article.md',
    '---\ntags: [type/summary]\nsource: my-article.pdf\n---\n' +
    '# My Article\n\n## Entities Mentioned\n- [[tali-rezun]]\n');

  writePageFile('articles', 'entities/via-prefix.md',
    '---\ntags: [type/entity]\n---\n' +
    '# Via Prefix\n\nSee also [[entities/tali-rezun]] for background.\n');

  writePageFile('articles', 'entities/bare-to-summary.md',
    '---\ntags: [type/entity]\n---\n' +
    '# Bare To Summary\n\nThis wrongly writes [[my-article]] without the summaries/ prefix.\n');

  writePageFile('articles', 'entities/unrelated.md',
    '---\ntags: [type/entity]\n---\n' +
    '# Unrelated\n\nNo links to anyone relevant here, just [[unrelated-2]].\n');
  writePageFile('articles', 'entities/unrelated-2.md',
    '---\ntags: [type/entity]\n---\n# Unrelated 2\n');

  writePageFile('articles', 'entities/orphan.md',
    '---\ntags: [type/entity]\n---\n# Orphan\n\nNothing links here.\n');

  // A page with NO frontmatter at all (hand-crafted, bypassing writePage).
  writePageFile('articles', 'concepts/no-frontmatter.md',
    '# No Frontmatter\n\nJust prose, no YAML block, and a link to [[orphan]].\n');

  // App-managed root files — must be excluded from both the page-read
  // surface (folder check) and the backlink scan (index.md/log.md).
  writeFileSync(path.join(wikiDirFor('articles'), 'index.md'), '# Index\n\n[[tali-rezun]]\n');
  writeFileSync(path.join(wikiDirFor('articles'), 'log.md'), '## [2026-01-01]\ningested something\n');

  // ── 1. Single-page read ─────────────────────────────────────────────────
  section('1. Single-page read');
  {
    const page = await getWikiPage('articles', 'entities/tali-rezun.md');
    assert(page.domain === 'articles', 'domain echoed');
    assert(page.path === 'entities/tali-rezun.md', 'path echoed');
    assert(page.folder === 'entities', 'folder resolved');
    assert(page.slug === 'tali-rezun', 'slug resolved');
    assert(page.title === 'Tali Rezun', `title from first heading (got "${page.title}")`);
    assert(page.type === 'entity', 'type falls back to folder-derived value');
    assert(Array.isArray(page.frontmatter.tags) && page.frontmatter.tags.includes('type/entity'), 'frontmatter.tags parsed');
    assert(page.body.includes('## Related'), 'body is the raw markdown body (frontmatter stripped)');
    assert(!page.body.startsWith('---'), 'frontmatter block not leaked into body');
  }

  // Path without .md extension is accepted.
  {
    const page = await getWikiPage('articles', 'entities/tali-rezun');
    assert(page.slug === 'tali-rezun', 'extension-less path accepted');
  }

  // Summary page uses the summaries/ convention.
  {
    const page = await getWikiPage('articles', 'summaries/my-article.md');
    assert(page.folder === 'summaries', 'summary folder resolved');
    assert(page.type === 'summary', 'summary type resolved');
    assert(page.frontmatter.source === 'my-article.pdf', 'summary source field parsed');
  }

  // ── 2. No-frontmatter page ───────────────────────────────────────────────
  section('2. Page with no frontmatter');
  {
    const page = await getWikiPage('articles', 'concepts/no-frontmatter.md');
    assert(Object.keys(page.frontmatter).length === 0, 'frontmatter is an empty object, not a throw');
    assert(page.title === 'No Frontmatter', 'title still derives from the first heading');
    assert(page.body.includes('Just prose'), 'body is the whole raw content when there is no frontmatter block');
  }

  // ── 3. Backlinks — parity with health.js's link-resolution rules ───────
  section('3. Backlinks (health.js parity)');
  {
    const talBacklinks = await getBacklinks('articles', 'entities', 'tali-rezun');
    const paths = talBacklinks.map(b => b.path).sort();
    assert(paths.includes('concepts/curator.md'), 'bare [[tali-rezun]] link counted as a backlink');
    assert(paths.includes('summaries/my-article.md'), 'summary linking bare [[tali-rezun]] counted');
    assert(paths.includes('entities/via-prefix.md'),
      'non-canonical [[entities/tali-rezun]] folder-prefixed link STILL counts (matches health.js\'s own quirk)');
    assert(!paths.includes('entities/unrelated.md'), 'unrelated page is not a backlink');
    assert(!paths.includes('index.md') && !paths.includes('log.md'), 'index.md/log.md excluded from the scan entirely');
    const curatorEntry = talBacklinks.find(b => b.path === 'concepts/curator.md');
    assert(curatorEntry && curatorEntry.title === 'The Curator', 'backlink entries carry the source page\'s title');
    assert(curatorEntry && curatorEntry.folder === 'concepts', 'backlink entries carry the source page\'s folder');
  }

  {
    // The convention asymmetry: bare links resolve to entities/concepts only.
    const summaryBacklinks = await getBacklinks('articles', 'summaries', 'my-article');
    const paths = summaryBacklinks.map(b => b.path);
    assert(paths.includes('entities/tali-rezun.md'), 'correct [[summaries/my-article]] form counted');
    assert(!paths.includes('entities/bare-to-summary.md'),
      'BARE [[my-article]] (missing the summaries/ prefix) must NOT resolve to the summary — matches health.js exactly');
  }

  {
    const orphanBacklinks = await getBacklinks('articles', 'entities', 'orphan');
    // orphan.md itself has no incoming [[orphan]] link EXCEPT the hand-crafted
    // no-frontmatter concept page, which deliberately links to it.
    const paths = orphanBacklinks.map(b => b.path);
    assert(paths.includes('concepts/no-frontmatter.md'), 'a page with no frontmatter can still be a valid backlink SOURCE');
  }

  {
    const unrelated2Backlinks = await getBacklinks('articles', 'entities', 'unrelated-2');
    assert(unrelated2Backlinks.length === 1 && unrelated2Backlinks[0].path === 'entities/unrelated.md',
      'a genuinely single-backlink page returns exactly that one entry');
  }

  {
    const page = await getWikiPage('articles', 'entities/orphan.md');
    // via getWikiPage, orphan.md DOES have a backlink from the no-frontmatter page.
    assert(page.backlinks.length >= 1, 'getWikiPage() surfaces backlinks inline with the page');
  }

  // Truly zero-backlink page.
  writePageFile('articles', 'entities/truly-alone.md', '---\ntags: [type/entity]\n---\n# Truly Alone\n');
  {
    const page = await getWikiPage('articles', 'entities/truly-alone.md');
    assert(Array.isArray(page.backlinks) && page.backlinks.length === 0, 'a page with zero backlinks returns an empty array, not null/undefined');
  }

  // linkPointsToPage direct unit checks (the resolver health.js parity hinges on).
  assert(linkPointsToPage('tali-rezun', 'entities', 'tali-rezun') === true, 'linkPointsToPage: bare match');
  assert(linkPointsToPage('tali-rezun', 'summaries', 'tali-rezun') === false, 'linkPointsToPage: bare never matches summaries');
  assert(linkPointsToPage('summaries/foo', 'summaries', 'foo') === true, 'linkPointsToPage: prefixed exact match');
  assert(linkPointsToPage('summaries/foo', 'entities', 'foo') === false, 'linkPointsToPage: prefixed folder mismatch rejected');
  assert(linkPointsToPage('entities/foo', 'entities', 'foo') === true, 'linkPointsToPage: non-canonical entities/ prefix still resolves');

  // ── 4. Error cases ───────────────────────────────────────────────────────
  section('4. Error cases');
  await assertThrowsStatus(() => getWikiPage('does-not-exist', 'entities/foo.md'), 404, 'unknown domain → 404');
  await assertThrowsStatus(() => getWikiPage('articles', 'entities/nope-not-a-real-page.md'), 404, 'unknown page → 404');
  await assertThrowsStatus(() => getWikiPage('articles', undefined), 400, 'missing path → 400');
  await assertThrowsStatus(() => getWikiPage('articles', ''), 400, 'empty path → 400');
  await assertThrowsStatus(() => getWikiPage('articles', 'log.md'), 400, 'index.md/log.md are not readable pages via this endpoint (400)');
  await assertThrowsStatus(() => getWikiPage('articles', 'not-a-canonical-folder/foo.md'), 400, 'non-canonical folder → 400');

  // ── 5. Read-only shared-* mirror: reads must still work ─────────────────
  section('5. Read-only mirror domain');
  {
    const mirrorDomainDir = path.join(domainsDir, 'shared-cohort');
    mkdirSync(mirrorDomainDir, { recursive: true });
    writeFileSync(path.join(mirrorDomainDir, 'CLAUDE.md'), '---\nreadonly: true\n---\n# Shared cohort mirror\n');
    writePageFile('shared-cohort', 'entities/collective-fact.md',
      '---\ntags: [type/entity]\n---\n# Collective Fact\n\nSynthesised from contributors.\n');

    const isRO = await isDomainReadonly('shared-cohort');
    assert(isRO === true, 'isDomainReadonly correctly identifies the mirror');

    const page = await getWikiPage('shared-cohort', 'entities/collective-fact.md');
    assert(page.title === 'Collective Fact', 'reading a page on a read-only mirror succeeds (only writes are refused elsewhere)');
  }

  // ── 6. Path traversal (>= 3 distinct attack shapes) ─────────────────────
  section('6. Path traversal defenses');

  assert(normaliseRequestedPath('../../../etc/passwd') === null, 'traversal #1: leading ../ segments rejected by normaliseRequestedPath');
  assert(normaliseRequestedPath('/etc/passwd') === null, 'traversal #2: absolute unix path rejected by normaliseRequestedPath');
  assert(normaliseRequestedPath('entities/../../../outside.md') === null, 'traversal #3: embedded ../ segment rejected by normaliseRequestedPath');
  assert(normaliseRequestedPath('C:\\Windows\\System32') === null, 'traversal #4: windows drive-letter / backslash form rejected');
  assert(normaliseRequestedPath('entities/foo\0.md') === null, 'traversal #5: embedded NUL byte rejected');

  // Defense-in-depth: resolveInsideWiki must independently refuse escape
  // even if a caller bypassed normaliseRequestedPath entirely (the module
  // docblock's "do not rely on validation happening upstream" requirement).
  {
    const wikiDir = wikiDirFor('articles');
    assert(resolveInsideWiki(wikiDir, '../../../etc/passwd') === null, 'traversal #6: resolveInsideWiki independently refuses ../ escape');
    assert(resolveInsideWiki(wikiDir, '/etc/passwd') === null, 'traversal #7: resolveInsideWiki independently refuses absolute paths');
    assert(resolveInsideWiki(wikiDir, 'entities/tali-rezun.md') !== null, 'resolveInsideWiki still accepts a genuine in-bounds path');
  }

  await assertThrowsStatus(() => getWikiPage('articles', '../../../etc/passwd'), 400, 'end-to-end: getWikiPage refuses a traversal payload with 400, not a filesystem error');
  await assertThrowsStatus(() => getWikiPage('articles', '/etc/passwd'), 400, 'end-to-end: absolute-path payload refused with 400');

  // ── 7. Cache invalidation — correctness over staleness ──────────────────
  section('7. Backlink cache invalidation');
  {
    // Baseline: fresh page, no backlinks yet.
    writePageFile('articles', 'concepts/freshly-added.md', '---\ntags: [type/concept]\n---\n# Freshly Added\n');
    __clearWikiReadCache('articles');
    let backlinks = await getBacklinks('articles', 'concepts', 'freshly-added');
    assert(backlinks.length === 0, 'new page starts with zero backlinks (cache primed)');

    // Add a NEW page linking to it — file COUNT changes, must be picked up
    // without any manual cache-clear (this is the real-world "just ingested
    // something" case the module docblock calls out).
    writePageFile('articles', 'entities/newly-linking.md',
      '---\ntags: [type/entity]\n---\n# Newly Linking\n\nSee [[freshly-added]].\n');
    backlinks = await getBacklinks('articles', 'concepts', 'freshly-added');
    assert(backlinks.some(b => b.path === 'entities/newly-linking.md'),
      'adding a new linking page is picked up on the very next read (no stale cache)');

    // Edit an EXISTING file in place (same file count, content changes) —
    // remove the link. Force the mtime forward explicitly so the test does
    // not depend on filesystem mtime clock granularity.
    const abs = path.join(wikiDirFor('articles'), 'entities/newly-linking.md');
    writeFileSync(abs, '---\ntags: [type/entity]\n---\n# Newly Linking\n\nNo longer links to anything.\n');
    const future = new Date(Date.now() + 5000);
    utimesSync(abs, future, future);

    backlinks = await getBacklinks('articles', 'concepts', 'freshly-added');
    assert(!backlinks.some(b => b.path === 'entities/newly-linking.md'),
      'editing an existing page IN PLACE (file count unchanged) still invalidates the cache via mtime');
  }

} catch (err) {
  bad('unexpected throw during test run', err.stack || err.message || err);
} finally {
  __setDomainsDirOverride(null);
  __clearWikiReadCache();
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n  Total: ${passed + failed}   Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) {
  for (const { label, err } of failures) console.log(`  ✗ ${label}${err ? ` — ${err}` : ''}`);
  process.exit(1);
}
console.log('\nAll wiki-page tests green.');
process.exit(0);
