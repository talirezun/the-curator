#!/usr/bin/env node
/**
 * test-wiki-list.js — OFFLINE suite for GET /api/wiki/:domain/list and its
 * data source, listWikiInventory() in src/brain/wiki-read.js.
 *
 * WHY THIS ENDPOINT EXISTS: `/next` has no wiki-browse surface at all, and
 * neither existing read is the right shape for one. `GET /:domain`
 * (readWikiPages) reads the FULL CONTENT of every page — 14 MB on the real
 * `articles` domain. `GET /:domain/page` opens exactly one already-known
 * page. Browsing "what pages exist" needs neither: a readdir-only inventory
 * the client can filter/search in memory, fetching full content only for
 * whatever gets opened.
 *
 * THE LOAD-BEARING DESIGN DECISION this suite exists to pin: the inventory
 * is built from health.js's `listMd` — imported, not copied — rather than a
 * fresh readdir. A naive readdir would list pages `GET /:domain/page` then
 * refuses with a 400 (a directory literally named `x.md`, a symlink
 * escaping the wiki, a dangling symlink), and two independently-written
 * inventories is the exact shape of the v3.2.0 CRITICAL (two hand-maintained
 * copies of a path guard, one of which could delete files outside the
 * wiki). §1-§4 below prove set equality between this endpoint's output and
 * (a) `listMd` called directly (independent of listWikiInventory's own
 * code) and (b) what `GET /:domain/page` will actually open.
 *
 * §5 proves the endpoint never reads file CONTENT (only readdir/lstat) —
 * behaviourally, via an unreadable file that would throw if `readFile` were
 * ever attempted on it, not via a source-level claim.
 *
 * §6 is the security section: path-traversal vectors against the `:domain`
 * route param, driven over REAL HTTP against the real mounted router (not a
 * mocked req/res), using Node's raw `http.request` — `fetch()` and curl both
 * normalise `..` out of a URL path client-side before the request is ever
 * sent, which would make a traversal test pass for the wrong reason (the
 * vector never reached the server). `http.request({path: '...'})` sends the
 * literal string.
 *
 * §7 is the truncation-cap boundary, proven against REAL files on disk (not
 * a mocked array) at exactly MAX_LIST_ENTRIES and MAX_LIST_ENTRIES + 1.
 *
 * Isolated via CURATOR_TEST_USER_DATA_DIR + CURATOR_TEST_DOMAINS_DIR, set
 * BEFORE any app module is imported (never process.env.DOMAINS_PATH — see
 * CLAUDE.md's "Active Development Decisions": that var loses to a
 * configured domainsPath and would silently no-op on a real install).
 *
 * Run with:  node scripts/test-wiki-list.js
 * Exit code 0 if all green; non-zero on any failure.
 */
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, chmodSync,
  readdirSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import http from 'http';

// ── Isolation FIRST — before any app module is imported ─────────────────
const TMP = mkdtempSync(path.join(tmpdir(), 'curator-wikilist-'));
const TMP_USER = path.join(TMP, 'userdata');
const TMP_DOMAINS = path.join(TMP, 'domains');
for (const d of [TMP_USER, TMP_DOMAINS]) mkdirSync(d, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = TMP_USER;
process.env.CURATOR_TEST_DOMAINS_DIR = TMP_DOMAINS;
delete process.env.DOMAINS_PATH;

const { listWikiInventory, MAX_LIST_ENTRIES } = await import('../src/brain/wiki-read.js');
const { getWikiPage } = await import('../src/brain/wiki-read.js');
const { listMd } = await import('../src/brain/health.js');
const { default: wikiRouter } = await import('../src/routes/wiki.js');
const { default: express } = await import('express');

// ── Harness ─────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];
function ok(label) { passed++; console.log(`  ✓ ${label}`); }
function bad(label, err) { failed++; failures.push({ label, err }); console.log(`  ✗ ${label}`); if (err) console.log(`    └─ ${err}`); }
function assert(cond, label, err) { cond ? ok(label) : bad(label, err || 'assertion failed'); }
function section(name) { console.log(`\n── ${name} ──`); }

function domainDir(domain) { return path.join(TMP_DOMAINS, domain); }
function wikiDir(domain) { return path.join(domainDir(domain), 'wiki'); }
function writePageFile(domain, relPath, content) {
  const abs = path.join(wikiDir(domain), relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  return abs;
}
function makeDomain(domain) {
  mkdirSync(domainDir(domain), { recursive: true });
  writeFileSync(path.join(domainDir(domain), 'CLAUDE.md'), '# schema\n', 'utf8');
  for (const f of ['entities', 'concepts', 'summaries']) {
    mkdirSync(path.join(wikiDir(domain), f), { recursive: true });
  }
}

// Minimal HTTP request helper that sends the RAW path string with no URL
// normalisation — see the module docblock's §6 note on why fetch()/curl are
// unsuitable for a `..`-in-path traversal test.
function rawGet(port, rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

try {
  // ═══════════════════════════════════════════════════════════════════════
  section('1. Basic contract — shape, fields, sort order');
  // ═══════════════════════════════════════════════════════════════════════
  makeDomain('basic');
  writePageFile('basic', 'entities/tali-rezun.md', '---\ntags: [type/entity]\n---\n# Tali Rezun\nbody\n');
  writePageFile('basic', 'entities/openai.md', '---\ntags: [type/entity]\n---\n# OpenAI\nbody\n');
  writePageFile('basic', 'concepts/rag.md', '---\ntags: [type/concept]\n---\n# RAG\nbody\n');
  writePageFile('basic', 'summaries/some-article-2026-01-01-abcd.md',
    '---\ntags: [type/summary]\nsource: x.pdf\n---\n# Some Article\nbody\n');
  // index.md / log.md live at wiki root, not inside a canonical folder —
  // must never appear in the list.
  writePageFile('basic', 'index.md', '# index\n');
  writePageFile('basic', 'log.md', '# log\n');

  const r1 = await listWikiInventory('basic');
  assert(r1.domain === 'basic', '#1: response carries the domain');
  assert(Array.isArray(r1.entries), '#2: entries is an array');
  assert(r1.entries.length === 4, `#3: exactly the 4 canonical pages listed (got ${r1.entries.length})`);
  assert(r1.count === 4 && r1.total === 4 && r1.truncated === false,
    '#4: count/total/truncated all correct on a small domain');

  for (const e of r1.entries) {
    const keys = Object.keys(e).sort();
    assert(JSON.stringify(keys) === JSON.stringify(['folder', 'path', 'slug', 'title']),
      `#5: entry for ${e.path} carries exactly {slug, folder, path, title} (got ${JSON.stringify(keys)})`);
  }

  const paths = r1.entries.map(e => e.path);
  assert(!paths.includes('index.md') && !paths.includes('log.md'),
    '#6: index.md and log.md never appear (they are not inside a canonical folder)');
  const sorted = [...paths].sort((a, b) => a.localeCompare(b));
  assert(JSON.stringify(paths) === JSON.stringify(sorted), '#7: entries are sorted by path');

  const rag = r1.entries.find(e => e.slug === 'rag');
  assert(!!rag && rag.folder === 'concepts' && rag.path === 'concepts/rag.md',
    '#8: a concept entry carries the exact path GET :domain/page expects (folder/slug.md, no leading slash)');

  // ═══════════════════════════════════════════════════════════════════════
  section('2. Title is SLUG-derived, never content-derived (the documented trade-off)');
  // ═══════════════════════════════════════════════════════════════════════
  makeDomain('titles');
  writePageFile('titles', 'entities/some-slug.md', 'Some Slug');
  writePageFile('titles', 'entities/frontmatter-title.md',
    '---\ntitle: A Completely Different Real Title\ntags: [type/entity]\n---\n# Ignored Heading Too\nbody\n');

  const r2 = await listWikiInventory('titles');
  const plain = r2.entries.find(e => e.slug === 'some-slug');
  assert(plain && plain.title === 'Some Slug', `#1: 'some-slug' humanises to 'Some Slug' (got ${plain && plain.title})`);

  const withFm = r2.entries.find(e => e.slug === 'frontmatter-title');
  assert(withFm && withFm.title === 'Frontmatter Title',
    `#2: the SLUG-derived title is shown ('Frontmatter Title'), NOT the frontmatter title or the # heading — the documented trade-off (got "${withFm && withFm.title}")`);

  // Confirm what /page WOULD say, to make the trade-off concrete rather than
  // asserted in prose only: opening the page shows the REAL title.
  const opened = await getWikiPage('titles', 'entities/frontmatter-title.md');
  assert(opened.title === 'A Completely Different Real Title',
    `#3: GET :domain/page on the SAME file reports the real frontmatter title — confirming the list/page title mismatch is real and intentional, not a bug (got "${opened.title}")`);

  // ═══════════════════════════════════════════════════════════════════════
  section('3. Exclusions — a directory named "x.md" is not a page');
  // ═══════════════════════════════════════════════════════════════════════
  makeDomain('excl');
  writePageFile('excl', 'entities/real.md', '# Real\n');
  mkdirSync(path.join(wikiDir('excl'), 'entities', 'dirnamed.md'), { recursive: true });

  const r3 = await listWikiInventory('excl');
  assert(r3.entries.length === 1 && r3.entries[0].slug === 'real',
    `#1: a directory literally named "dirnamed.md" is excluded (got ${JSON.stringify(r3.entries.map(e => e.slug))})`);

  // ═══════════════════════════════════════════════════════════════════════
  section('4. A nested page is openable but NOT in the browse list (documented asymmetry)');
  // ═══════════════════════════════════════════════════════════════════════
  makeDomain('nested');
  writePageFile('nested', 'entities/top.md', '# Top\n');
  writePageFile('nested', 'entities/sub/inner.md', '# Inner\n');

  const r4 = await listWikiInventory('nested');
  assert(r4.entries.length === 1 && r4.entries[0].slug === 'top',
    `#1: only the depth-1 page is listed — listMd is a SHALLOW readdir, matching health.js's own canonical inventory (got ${JSON.stringify(r4.entries.map(e => e.path))})`);

  // The asymmetry, made concrete rather than just asserted: GET :domain/page
  // CAN still open the nested file directly (getWikiPage has no depth
  // restriction) — it is readable, just not part of the canonical browse
  // inventory. This mirrors the SAME resolvableTarget:false precedent this
  // module already documents for backlinks on nested pages.
  let nestedOpenErr = null;
  let nestedOpened = null;
  try { nestedOpened = await getWikiPage('nested', 'entities/sub/inner.md'); }
  catch (e) { nestedOpenErr = e; }
  assert(!nestedOpenErr && nestedOpened && nestedOpened.resolvableTarget === false,
    '#2: the nested page opens fine via GET :domain/page (200) with resolvableTarget:false — readable, just outside the canonical inventory this list reflects');

  // ═══════════════════════════════════════════════════════════════════════
  section('5. Symlinks — escaping refused, dangling refused, in-bounds alias kept');
  // ═══════════════════════════════════════════════════════════════════════
  makeDomain('symlinks');
  writePageFile('symlinks', 'entities/openai.md', '# OpenAI\n');
  const secretOutside = path.join(TMP, 'secret-outside.md');
  writeFileSync(secretOutside, 'TOP SECRET CONTENT THAT MUST NEVER APPEAR', 'utf8');
  symlinkSync(secretOutside, path.join(wikiDir('symlinks'), 'entities', 'escaping-link.md'));
  symlinkSync(
    path.join(wikiDir('symlinks'), 'entities', 'openai.md'),
    path.join(wikiDir('symlinks'), 'entities', 'openai-alias.md'),
  );
  symlinkSync(
    path.join(TMP, 'does-not-exist-anywhere.md'),
    path.join(wikiDir('symlinks'), 'entities', 'dangling-link.md'),
  );

  const r5 = await listWikiInventory('symlinks');
  const slugs5 = r5.entries.map(e => e.slug).sort();
  assert(slugs5.join(',') === 'openai,openai-alias', `#1: escaping + dangling symlinks excluded, in-bounds alias kept (got ${slugs5.join(',')})`);
  assert(!JSON.stringify(r5).includes('TOP SECRET'),
    '#2: the escaping symlink\'s target content never appears anywhere in the response (readdir-only — content is never read)');

  // Confirm the alias really does open (it is a legitimate in-wiki page),
  // and that the escaping/dangling links are refused by /page too — so the
  // list and the reader agree in BOTH directions on these hostile shapes.
  // Identity comes from the FILESYSTEM (realpath), not the request string —
  // canonicalRelPath's own documented contract (v3.2.0 audit M5). Opening
  // the alias therefore resolves to the file it POINTS AT ("openai"), not
  // the symlink's own name — expected, not a bug in this endpoint.
  const aliasOpened = await getWikiPage('symlinks', 'entities/openai-alias.md');
  assert(aliasOpened && aliasOpened.slug === 'openai' && aliasOpened.path === 'entities/openai.md',
    `#3: the in-bounds alias opens via GET :domain/page and resolves to its REAL on-disk target (got slug=${aliasOpened && aliasOpened.slug})`);
  let escOk = true;
  try { await getWikiPage('symlinks', 'entities/escaping-link.md'); } catch (e) { escOk = e.status === 400; }
  assert(escOk, '#4: the escaping symlink is refused (400) by GET :domain/page — consistent with its exclusion from the list');
  let dangOk = true;
  try { await getWikiPage('symlinks', 'entities/dangling-link.md'); } catch (e) { dangOk = e.status === 400; }
  assert(dangOk, '#5: the dangling symlink is refused (400) by GET :domain/page — consistent with its exclusion from the list');

  // ═══════════════════════════════════════════════════════════════════════
  section('6. SET EQUALITY — independent dumb cross-check against listMd itself');
  // ═══════════════════════════════════════════════════════════════════════
  // Deliberately calls listMd directly, bypassing listWikiInventory's own
  // code entirely, so this proves listWikiInventory does not silently add,
  // drop, or rename anything beyond what listMd itself already decided —
  // the exact independence CLAUDE.md's "a clever test cannot catch its own
  // desync" lesson calls for.
  makeDomain('setequal');
  writePageFile('setequal', 'entities/a.md', '# A\n');
  writePageFile('setequal', 'entities/b.md', '# B\n');
  writePageFile('setequal', 'concepts/c.md', '# C\n');
  writePageFile('setequal', 'concepts/d.md', '# D\n');
  writePageFile('setequal', 'summaries/e-2026-01-01-aaaa.md', '# E\n');
  mkdirSync(path.join(wikiDir('setequal'), 'entities', 'ghost-dir.md'), { recursive: true });
  symlinkSync(path.join(TMP, 'nowhere.md'), path.join(wikiDir('setequal'), 'concepts', 'dangling.md'));

  const dumbSet = new Set();
  for (const folder of ['entities', 'concepts', 'summaries']) {
    const files = await listMd(wikiDir('setequal'), folder);
    for (const f of files) dumbSet.add(`${folder}/${f}`);
  }
  const r6 = await listWikiInventory('setequal');
  const endpointSet = new Set(r6.entries.map(e => e.path));

  const onlyInDumb = [...dumbSet].filter(x => !endpointSet.has(x));
  const onlyInEndpoint = [...endpointSet].filter(x => !dumbSet.has(x));
  assert(onlyInDumb.length === 0 && onlyInEndpoint.length === 0,
    `#1: exact set equality between listMd-direct and the endpoint (missing from endpoint: ${JSON.stringify(onlyInDumb)}; extra in endpoint: ${JSON.stringify(onlyInEndpoint)})`);
  assert(dumbSet.size === 5, `#2: sanity — the dumb set itself has exactly the 5 legitimate pages, confirming the fixture excluded the ghost dir + dangling symlink the same way listMd's own suite expects (got ${dumbSet.size})`);

  // Reverse direction: every entry this endpoint returns really does open
  // via GET :domain/page (nothing listed that the reader would then refuse
  // — the specific failure mode a naive readdir would have produced).
  for (const e of r6.entries) {
    let openErr = null;
    try { await getWikiPage('setequal', e.path); } catch (err) { openErr = err; }
    assert(!openErr, `#3: listed entry ${e.path} opens via GET :domain/page without error`, openErr && openErr.message);
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('7. NO CONTENT READ — behavioural proof, not a source-level claim');
  // ═══════════════════════════════════════════════════════════════════════
  // An unreadable file (chmod 000) is still perfectly listable via readdir —
  // but readFile() on it throws EACCES. If listWikiInventory ever tried to
  // read this file's content it would either throw (uncaught) or the file
  // would be silently dropped by an error handler; either way it would NOT
  // show up correctly with a slug-derived title the way it does here.
  makeDomain('noread');
  const unreadablePath = writePageFile('noread', 'entities/locked.md', '# Locked\nbody\n');
  writePageFile('noread', 'entities/normal.md', '# Normal\n');
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (isRoot) {
    ok('#1 skipped: running as root — chmod 000 does not block root reads, so this proof would be meaningless here');
  } else {
    chmodSync(unreadablePath, 0o000);
    let threw = null;
    let r7 = null;
    try { r7 = await listWikiInventory('noread'); } catch (e) { threw = e; }
    chmodSync(unreadablePath, 0o644); // restore before any assertion can short-circuit cleanup
    assert(!threw, '#1: listWikiInventory does not throw on a chmod-000 (unreadable) page — proving it never attempts readFile()', threw && threw.message);
    const locked = r7 && r7.entries.find(e => e.slug === 'locked');
    assert(!!locked && locked.title === 'Locked',
      '#2: the unreadable file is still listed with a correct slug-derived title — readdir-only, content genuinely never touched');
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('8. Real cap boundary — MAX_LIST_ENTRIES vs MAX_LIST_ENTRIES + 1 on disk');
  // ═══════════════════════════════════════════════════════════════════════
  makeDomain('capexact');
  const capDir = path.join(wikiDir('capexact'), 'entities');
  for (let i = 0; i < MAX_LIST_ENTRIES; i++) {
    writeFileSync(path.join(capDir, `p${i}.md`), '# x\n', 'utf8');
  }
  const rCapExact = await listWikiInventory('capexact');
  assert(rCapExact.total === MAX_LIST_ENTRIES && rCapExact.count === MAX_LIST_ENTRIES && rCapExact.truncated === false,
    `#1: exactly MAX_LIST_ENTRIES (${MAX_LIST_ENTRIES}) real files → NOT truncated (got total=${rCapExact.total}, count=${rCapExact.count}, truncated=${rCapExact.truncated})`);
  assert(rCapExact.entries.length === MAX_LIST_ENTRIES, '#2: entries array itself has exactly the cap length');

  writeFileSync(path.join(capDir, `p_over.md`), '# over\n', 'utf8');
  const rCapOver = await listWikiInventory('capexact');
  assert(rCapOver.total === MAX_LIST_ENTRIES + 1 && rCapOver.count === MAX_LIST_ENTRIES && rCapOver.truncated === true,
    `#3: MAX_LIST_ENTRIES + 1 real files → truncated:true, count capped, total reports the real (uncapped) number (got total=${rCapOver.total}, count=${rCapOver.count}, truncated=${rCapOver.truncated})`);
  assert(rCapOver.entries.length === MAX_LIST_ENTRIES, '#4: entries array is capped even though total is not');

  // ═══════════════════════════════════════════════════════════════════════
  section('9. Unknown domain — function-level 404 contract (matches getWikiPage)');
  // ═══════════════════════════════════════════════════════════════════════
  let unknownErr = null;
  try { await listWikiInventory('this-domain-does-not-exist'); } catch (e) { unknownErr = e; }
  assert(unknownErr && unknownErr.status === 404, '#1: an unknown domain throws with .status === 404, matching getWikiPage\'s own convention');

  // ═══════════════════════════════════════════════════════════════════════
  section('10. ROUTE-LEVEL — real HTTP against the real mounted router');
  // ═══════════════════════════════════════════════════════════════════════
  makeDomain('routetest');
  writePageFile('routetest', 'entities/hello.md', '# Hello\n');

  const app = express();
  app.use('/api/wiki', wikiRouter);
  const httpServer = http.createServer(app);
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const port = httpServer.address().port;

  const good = await rawGet(port, '/api/wiki/routetest/list');
  assert(good.status === 200, `#1: a real domain returns 200 over HTTP (got ${good.status})`);
  const goodBody = JSON.parse(good.body);
  assert(goodBody.entries.length === 1 && goodBody.entries[0].slug === 'hello',
    '#2: the HTTP response carries the real fixture entry');

  const missing = await rawGet(port, '/api/wiki/nope-not-a-domain/list');
  assert(missing.status === 404, `#3: an unknown domain returns 404 over HTTP (got ${missing.status})`);

  // Path-traversal vectors against :domain — sent as the LITERAL raw string
  // (http.request does not URL-normalise `..` the way fetch()/curl do; see
  // the module docblock). listDomains() only ever returns real directory
  // names from a readdir, so none of these can ever coincide with a real
  // domain — this is the SAME boundary GET :domain/page already relies on
  // (getWikiPage itself performs no domain validation; the route does),
  // so this route does not introduce a second, differently-shaped
  // containment check for the domain segment.
  const traversalVectors = [
    '/api/wiki/../list',                          // literal ".." as :domain
    '/api/wiki/../../etc/list',                   // multi-segment escape attempt
    '/api/wiki/..%2f..%2fetc/list',                // encoded slash inside the segment
    '/api/wiki/%2e%2e/list',                       // encoded ".."
    '/api/wiki/....//list',                        // repeated-dot bypass attempt
    '/api/wiki/testdom%00evil/list',               // embedded null byte
  ];
  for (const v of traversalVectors) {
    const res = await rawGet(port, v);
    assert(res.status === 404, `#4: traversal vector ${JSON.stringify(v)} refused with 404 (got ${res.status})`, res.body.slice(0, 200));
  }

  // #5 — a GENUINE escape target, not just a non-existent path. Every
  // traversal vector above resolves to a NON-existent directory, so it is
  // technically possible for a 404 to come from listWikiInventory's own
  // existsSync check rather than from the route's listDomains() membership
  // guard — a mutation run during this task's verification confirmed this
  // exact ambiguity: deleting the route guard left #1-#4 above still green,
  // because listWikiInventory happened to 404 on its own for every one of
  // those specific paths. This assertion closes that gap: a real sibling
  // directory OUTSIDE domains/, containing a real wiki/entities/*.md page,
  // that DOES exist on disk at the path `../escape-target` resolves to. If
  // the route's domain-membership guard is ever removed, this is the
  // assertion that goes red — it was mutation-proven live: with the guard
  // deleted, this exact request returned 200 with the escape target's real
  // page content (`entities/leaked.md`, title "Leaked").
  const escapeRoot = path.join(TMP, 'escape-target');
  mkdirSync(path.join(escapeRoot, 'wiki', 'entities'), { recursive: true });
  writeFileSync(path.join(escapeRoot, 'wiki', 'entities', 'leaked.md'), '# Leaked\n', 'utf8');
  // TMP_DOMAINS is a direct child of TMP, so "../escape-target" from inside
  // it resolves exactly to escapeRoot — path.join(getDomainsDir(), domain,
  // 'wiki') in wikiPath() confirms this is the real resolution wiki-read.js
  // itself would perform.
  assert(path.dirname(TMP_DOMAINS) === TMP, 'fixture sanity: TMP_DOMAINS is a direct child of TMP (required for the "../escape-target" math below to be correct)');
  const escapeRes = await rawGet(port, '/api/wiki/..%2Fescape-target/list');
  assert(escapeRes.status === 404, `#5: a domain string resolving to a REAL directory OUTSIDE domains/ is still refused with 404, not the leaked content (got ${escapeRes.status}: ${escapeRes.body.slice(0, 200)})`);
  assert(!escapeRes.body.includes('leaked'), '#6: the leaked page\'s slug never appears in the response body under any status code');

  await new Promise((resolve) => httpServer.close(resolve));

} catch (err) {
  bad('unexpected throw during test run', err.stack || err.message || err);
} finally {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\n  Total: ${passed + failed}   Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) {
  for (const { label, err } of failures) console.log(`  ✗ ${label}${err ? ` — ${err}` : ''}`);
  process.exit(1);
}
console.log('\nAll wiki-list tests green.');
process.exit(0);
