#!/usr/bin/env node
/**
 * test-health-index-rebuild.js — v3.83.0 (CONTRACT §3, §7 P1).
 *
 * Health's index.md check and rebuild, end to end over the REAL health router
 * mounted on an Express app (port 0), against a synthetic LARGE fixture in a
 * temp dir: 3,500 pages (600 entities / 2,800 concepts / 100 summaries), 50
 * summary/concept slug collisions, a ~450 KB index with ~800 rows, 40 stale
 * rows, 1 duplicate, 3 repointable rows, 2 leading-space file names, an alias
 * row, a row without its trailing pipe, and non-ASCII slugs.
 *
 * Pinned:
 *   §1 scan — indexDrift equals an INDEPENDENT count (readdir + regex, not the
 *      parser); [] on a fully indexed domain; [] + counts.indexCheck 'mirror'
 *      on a read-only mirror; countOpenIssues counts it as ONE.
 *   §2 plan is READ-ONLY — every file in the domain fingerprinted before/after.
 *   §3 apply with the plan's basis writes the rebuilt text; every page appears
 *      exactly once (counted by regex); a rescan WITH the cache on is clean.
 *   §4 a page or index edit between plan and apply → 409 INDEX_PLAN_STALE,
 *      index.md byte-identical; the date alone never makes a plan stale.
 *   §5 indexDrift is NOT auto-fixable: fixIssue throws, /fix 400s, /fix-all-safe
 *      and fixAllSafe leave index.md byte-identical.
 *   §6 route guards: mirror 400 (both), update in progress 409, file lock 409,
 *      missing / non-hex basis 400, a symlinked index.md 409 INDEX_UNREADABLE
 *      with the outside file byte-identical.
 *
 * Isolation: CURATOR_TEST_USER_DATA_DIR + CURATOR_TEST_DOMAINS_DIR set before
 * any src/ import, then __setDomainsDirOverride. Never touches real domains/.
 */

import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync, existsSync, statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

let passed = 0, failed = 0;
const failures = [];
function ok(cond, label, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; failures.push(label); console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + String(detail).slice(0, 500) : ''}`); }
}
const sha = (b) => createHash('sha256').update(b).digest('hex');

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'curator-index-rebuild-'));
const USER_DATA = path.join(TMP_ROOT, 'userdata');
const DOMAINS = path.join(TMP_ROOT, 'domains');
mkdirSync(USER_DATA, { recursive: true });
mkdirSync(DOMAINS, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DATA;
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS;
process.env.CURATOR_TEST_INSTANCE_DIR = path.join(TMP_ROOT, 'instances');

const { __setDomainsDirOverride } = await import('../src/brain/config.js');
__setDomainsDirOverride(DOMAINS);
const health = await import('../src/brain/health.js');
const { countOpenIssues } = await import('../src/brain/health-summary.js');
const wikiIndex = await import('../src/brain/wiki-index.js');
const registry = await import('../src/brain/write-registry.js');
const { default: healthRouter } = await import('../src/routes/health.js');
const { default: express } = await import('express');

const app = express();
app.use(express.json());
app.use('/api/health', healthRouter);
const server = createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
async function post(p, body) {
  const res = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  let json = null; try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body: json };
}
async function get(p) {
  const res = await fetch(BASE + p);
  let json = null; try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body: json };
}

const realErr = console.error, realWarn = console.warn;
const quiet = () => { console.error = () => {}; console.warn = () => {}; };
const loud = () => { console.error = realErr; console.warn = realWarn; };

function mkDomain(name, schema = `# Domain: ${name}\n`) {
  const dd = path.join(DOMAINS, name);
  for (const d of ['wiki/entities', 'wiki/concepts', 'wiki/summaries', 'raw']) mkdirSync(path.join(dd, d), { recursive: true });
  writeFileSync(path.join(dd, 'CLAUDE.md'), schema, 'utf8');
  writeFileSync(path.join(dd, 'wiki', 'log.md'), '# Log\n', 'utf8');
  const wiki = path.join(dd, 'wiki');
  return {
    name, dir: dd, wiki,
    put: (rel, body) => writeFileSync(path.join(wiki, rel), body, 'utf8'),
    read: (rel) => readFileSync(path.join(wiki, rel), 'utf8'),
  };
}
/** sha of every file under a directory, by relative path — the read-only proof. */
function fingerprintTree(root) {
  const out = {};
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(root, p)] = sha(readFileSync(p)) + ':' + statSync(p).mtimeMs;
    }
  };
  walk(root);
  return out;
}
const pageBody = (title, sentence) => `---\ntype: x\ntags: [type/x]\n---\n# ${title}\n\n${sentence}\n\n## Key Facts\n- a fact\n`;

// ── The large synthetic fixture ───────────────────────────────────────────
const L = mkDomain('large', '# Domain: Large Synthetic\n');
const desc = (i) => `Synthetic description number ${i} — ` + 'lorem ipsum dolor sit amet consectetur '.repeat(13).trim();
const entities = [], concepts = [], summaries = [];
for (let i = 0; i < 598; i++) entities.push(`ent-${String(i).padStart(4, '0')}.md`);
entities.push('café-crème.md', 'zürich-lab.md');                         // non-ASCII
for (let i = 0; i < 2798; i++) concepts.push(`con-${String(i).padStart(4, '0')}.md`);
concepts.push(' leading-space-a.md', ' leading-space-b.md');              // unlinkable
for (let i = 0; i < 50; i++) summaries.push(`con-${String(i).padStart(4, '0')}.md`);   // 50 collisions with concepts
for (let i = 0; i < 50; i++) summaries.push(`src-${String(i).padStart(4, '0')}.md`);
for (const f of entities) L.put('entities/' + f, pageBody(f.slice(0, -3), `The entity ${f.slice(0, -3)} is a test page.`));
for (const f of concepts) L.put('concepts/' + f, pageBody(f.slice(0, -3), `The concept ${f.slice(0, -3)} is a test idea.`));
for (const f of summaries) L.put('summaries/' + f, pageBody(`Source ${f.slice(0, -3)}`, 'A summary.'));

const rows = [];
for (let i = 0; i < 300; i++) rows.push(`| [[ent-${String(i).padStart(4, '0')}]] | entity | ${desc(rows.length)} |`);
rows.push('| [[café-crème]] | entity | Café crème, kept as written |');
rows.push('| [[zürich-lab]] | company | a type cell the rebuild corrects |');
for (let i = 0; i < 400; i++) rows.push(`| [[con-${String(i).padStart(4, '0')}]] | concept | ${desc(rows.length)} |`);
for (let i = 0; i < 50; i++) rows.push(`| [[summaries/src-${String(i).padStart(4, '0')}]] | summary | ${desc(rows.length)} |`);
for (let i = 0; i < 40; i++) rows.push(`| [[stale-${i}]] | concept | gone ${i} |`);
rows.push(`| [[ent-0000]] | entity | a DUPLICATE row — first one wins |`);
// 3 repointable: bare [[x]] where only summaries/x exists → none, so add three summary-only slugs
for (let i = 0; i < 3; i++) {
  const s = `only-summary-${i}.md`;
  summaries.push(s);
  L.put('summaries/' + s, pageBody(`Only Summary ${i}`, 'Summary only.'));
  rows.push(`| [[only-summary-${i}]] | summary | repointed, kept ${i} |`);
}
rows.push('| [[con-0500|An alias]] | concept | aliased row |');
rows.push('| [[con-0501]] | concept | no trailing pipe');
const INDEX_TEXT = '# Wiki Index — Large Synthetic\nLast updated: 2025-05-04\n\n| Page | Type | Summary |\n|---|---|---|\n' + rows.join('\n') + '\n';
L.put('index.md', INDEX_TEXT);

/**
 * DUMB, independent count of what the index covers — readdir + one regex, no
 * wiki-index.js. The Health rule: [[summaries/x]] → summaries/x.md; bare [[x]]
 * → entities/x.md, else concepts/x.md, else (repoint) summaries/x.md.
 */
function dumbCoverage(wiki, indexText) {
  const list = (f) => readdirSync(path.join(wiki, f)).filter((n) => n.endsWith('.md'));
  const ent = new Set(list('entities')), con = new Set(list('concepts')), sum = new Set(list('summaries'));
  const linkable = (n) => n === n.trim();
  const all = new Set([
    ...[...ent].filter(linkable).map((n) => 'entities/' + n),
    ...[...con].filter(linkable).filter((n) => !ent.has(n)).map((n) => 'concepts/' + n),
    ...[...sum].filter(linkable).map((n) => 'summaries/' + n),
  ]);
  const covered = new Set();
  let stale = 0, dup = 0, repoint = 0;
  for (const m of indexText.matchAll(/^\|\s*\[\[([^\]|#]+)[^\]]*\]\]/gm)) {
    const t = m[1].trim().normalize('NFC');
    let p = null, rp = false;
    if (t.startsWith('summaries/')) p = sum.has(t.slice(10) + '.md') ? t + '.md' : null;
    else if (ent.has(t + '.md')) p = 'entities/' + t + '.md';
    else if (con.has(t + '.md')) p = 'concepts/' + t + '.md';
    else if (sum.has(t + '.md')) { p = 'summaries/' + t + '.md'; rp = true; }
    if (!p) { stale++; continue; }
    if (covered.has(p)) { dup++; continue; }
    covered.add(p);
    if (rp) repoint++;
  }
  const missing = [...all].filter((p) => !covered.has(p));
  return { missing: missing.length, stale, dup, repoint, total: all.size };
}

try {
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n§1  scan — indexDrift on the large fixture equals an independent count');
  const dumb = dumbCoverage(L.wiki, INDEX_TEXT);
  ok(Buffer.byteLength(INDEX_TEXT) > 400_000 && rows.length > 790,
    `PRECONDITION — the fixture index is large (${Buffer.byteLength(INDEX_TEXT)} B, ${rows.length} rows)`);
  ok(dumb.stale === 40 && dumb.dup === 1 && dumb.repoint === 3,
    'PRECONDITION — the dumb counter sees 40 stale, 1 duplicate, 3 repointable', JSON.stringify(dumb));
  const scanRes = await get('/api/health/large');
  const drift = scanRes.body && scanRes.body.indexDrift;
  ok(scanRes.status === 200 && Array.isArray(drift) && drift.length === 1, 'GET /api/health/large carries one indexDrift row', JSON.stringify(drift));
  const d0 = drift && drift[0] || {};
  ok(d0.missing === dumb.missing, `★ missing = ${d0.missing} equals the independent count ${dumb.missing}`);
  ok(d0.stale === 40 && d0.duplicates === 1 && d0.repointable === 3,
    '★ stale / duplicates / repointable equal the independent count', JSON.stringify(d0));
  ok(d0.missingByFolder && d0.missingByFolder.summaries === 50 && d0.missingByFolder.entities + d0.missingByFolder.concepts + 50 === d0.missing,
    'missingByFolder adds up (the 50 colliding summaries are missing as SUMMARIES — canonical path, not basename)', JSON.stringify(d0.missingByFolder));
  ok(d0.unlinkable === 2 && d0.indexExists === true && d0.indexBytes === Buffer.byteLength(INDEX_TEXT),
    'the two leading-space files are counted as unlinkable, not missing; indexBytes is the file size', JSON.stringify(d0));
  ok(Array.isArray(d0.sampleMissing) && d0.sampleMissing.length === 10 && d0.sampleStale.length === 10
    && d0.sampleStale[0] === '[[stale-0]]', 'samples are capped at 10; stale samples in document order');
  ok(scanRes.body.counts.indexRows === rows.length, 'counts.indexRows is the number of page rows', scanRes.body.counts.indexRows);
  ok(countOpenIssues(scanRes.body) === countOpenIssues({ ...scanRes.body, indexDrift: [] }) + 1,
    'countOpenIssues counts the indexDrift row as exactly ONE open issue');

  {
    const F = mkDomain('fully');
    F.put('entities/a.md', pageBody('A', 'A.'));
    F.put('summaries/s.md', pageBody('S', 'S.'));
    F.put('index.md', '# Wiki Index — fully\n\n| Page | Type | Summary |\n|---|---|---|\n| [[a]] | company | type cell differs — never a drift row |\n| [[summaries/s]] | summary | s |\n');
    const r = await health.scanWiki('fully');
    ok(Array.isArray(r.indexDrift) && r.indexDrift.length === 0 && r.counts.indexRows === 2,
      'a fully indexed domain → indexDrift [] (a type-cell difference alone raises no row)', JSON.stringify(r.indexDrift));
  }
  {
    const E = mkDomain('empty-no-index');
    const r = await health.scanWiki('empty-no-index');
    ok(r.indexDrift.length === 0, 'an empty domain with no index.md → no drift');
  }
  const M = mkDomain('shared-mirror', '---\nreadonly: true\n---\n# Domain: Mirror\n');
  M.put('entities/m.md', pageBody('M', 'M.'));
  M.put('index.md', '# Wiki Index — Mirror (Shared Brain Mirror)\n');
  {
    const r = await health.scanWiki('shared-mirror');
    ok(r.indexDrift.length === 0 && r.counts.indexCheck === 'mirror' && !('indexRows' in r.counts),
      '★ a read-only mirror → indexDrift [] and counts.indexCheck "mirror" (its stub index is never maintained)', JSON.stringify(r.counts));
    const again = await health.scanWiki('shared-mirror');
    ok(again.indexDrift.length === 0 && again.counts.indexCheck === 'mirror', '…on a cache HIT too');
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n§2  plan is READ-ONLY');
  const fpBefore = fingerprintTree(L.dir);
  const t0 = Date.now();
  const planRes = await post('/api/health/large/index/plan');
  const planMs = Date.now() - t0;
  ok(planRes.status === 200 && planRes.body.ok === true && /^[0-9a-f]{64}$/.test(planRes.body.basis),
    `POST /index/plan → 200 with a hex basis (${planMs} ms on 3,500 pages)`, JSON.stringify(planRes.body).slice(0, 300));
  const fpAfter = fingerprintTree(L.dir);
  ok(JSON.stringify(fpBefore) === JSON.stringify(fpAfter), '★ every file in the domain is byte-identical (and untouched) after the plan');
  const S = planRes.body.summary || {};
  ok(S.add === dumb.missing && S.removeStale === 40 && S.mergeDuplicates === 1 && S.repoint === 3,
    'the plan summary agrees with the scan and the independent count', JSON.stringify(S));
  ok(S.unlinkable === 2 && S.aliasesDropped === 1 && S.typeCellsCorrected === 1,
    'the plan counts unlinkable files, the dropped alias and the corrected type cells', JSON.stringify(S));
  ok(planRes.body.nothingToDo === false && !('text' in planRes.body), 'nothingToDo is false, and the plan never sends index text');
  ok(Array.isArray(planRes.body.samples.unlinkable) && planRes.body.samples.unlinkable.includes('concepts/ leading-space-a.md'),
    'the unlinkable file names are listed by name in the samples');

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n§3  apply writes the rebuilt index; every page appears exactly once');
  // Expected text, composed independently of the route from the same disk state.
  const inventory = await wikiIndex.readPageInventory('large');
  const cov = wikiIndex.indexCoverage(wikiIndex.parseIndex(INDEX_TEXT), inventory);
  const derived = new Map(cov.missing.map((p) => [p, wikiIndex.deriveDescription(L.read(p), p)]));
  const applyRes = await post('/api/health/large/index/apply', { basis: planRes.body.basis });
  ok(applyRes.status === 200 && applyRes.body.ok === true && applyRes.body.written === true,
    'POST /index/apply with the plan\'s basis → 200 written:true', JSON.stringify(applyRes.body).slice(0, 300));
  const after = L.read('index.md');
  const today = (after.match(/^Last updated: (.*)$/m) || [])[1];
  const expected = wikiIndex.rebuildIndexText(INDEX_TEXT, inventory, derived, { today, displayName: 'Large Synthetic' }).text;
  ok(after === expected, '★ index.md is exactly the rebuild composed from the disk state');
  // Dumb cross-check: every linkable page appears exactly once, counted by regex.
  const counts = new Map();
  for (const m of after.matchAll(/^\| \[\[([^\]]+)\]\] \| (entity|concept|summary) \|/gm)) {
    const key = (m[2] === 'summary' ? '' : m[2] === 'entity' ? 'entities/' : 'concepts/') + m[1] + '.md';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const once = [...counts.values()].every((n) => n === 1);
  ok(once && counts.size === dumb.total, `★ every page has exactly one row (${counts.size} rows for ${dumb.total} linkable pages)`);
  ok(!after.includes('[[stale-') && !after.includes('leading-space') && after.includes('| [[café-crème]] | entity | Café crème, kept as written |'),
    'stale rows gone, unlinkable files left out, an existing description kept byte-for-byte');
  ok(after.includes('| [[summaries/only-summary-0]] | summary | repointed, kept 0 |'), 'a repointed row keeps its description');
  ok(after.includes('| [[con-0500]] | concept | aliased row |') && after.includes('| [[con-0501]] | concept | no trailing pipe |'),
    'the alias is dropped and the pipe-less row is normalised, descriptions kept');
  ok(/## Summaries[\s\S]*## Entities[\s\S]*## Concepts/.test(after) && after.endsWith('\n') && !after.endsWith('\n\n'),
    'three sections in order; ends with exactly one newline');
  ok(applyRes.body.summary.bytesAfter === Buffer.byteLength(after), 'summary.bytesAfter is the written size');
  const rescan = await get('/api/health/large');
  ok(rescan.body.indexDrift.length === 0 && rescan.body.counts.indexRows === dumb.total,
    '★ a rescan through the route (cache ON) reports no drift — index.md is in the scan signature', JSON.stringify(rescan.body.indexDrift));
  const replan = await post('/api/health/large/index/plan');
  ok(replan.body.nothingToDo === true, 'a fresh plan has nothing to do');
  const reapply = await post('/api/health/large/index/apply', { basis: planRes.body.basis });
  ok(reapply.status === 409 && reapply.body.code === 'INDEX_PLAN_STALE', 'the OLD basis is stale now (the index changed)');
  const sameApply = await post('/api/health/large/index/apply', { basis: replan.body.basis });
  ok(sameApply.status === 200 && sameApply.body.written === false && L.read('index.md') === after,
    'applying a nothing-to-do plan writes nothing');
  ok(wikiIndex.rebuildIndexText(after, inventory, new Map(), { today }).text === after,
    'IDEMPOTENT — rebuilding the rebuilt index gives the same bytes');

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n§4  a change between plan and apply → 409 INDEX_PLAN_STALE, nothing written');
  {
    const P = mkDomain('stale-check');
    P.put('entities/a.md', pageBody('A', 'A is here.'));
    P.put('entities/b.md', pageBody('B', 'B is here.'));
    P.put('index.md', '# Wiki Index — stale-check\nLast updated: 2025-01-01\n\n| Page | Type | Summary |\n|---|---|---|\n| [[a]] | entity | a |\n');
    const p1 = await post('/api/health/stale-check/index/plan');
    P.put('entities/c.md', pageBody('C', 'C arrived after the preview.'));    // a page edit
    const before = P.read('index.md');
    const a1 = await post('/api/health/stale-check/index/apply', { basis: p1.body.basis });
    ok(a1.status === 409 && a1.body.code === 'INDEX_PLAN_STALE'
      && a1.body.error === 'The wiki changed after this preview, so nothing was written. Preview the rebuild again.',
      '★ a page added after the preview → 409 INDEX_PLAN_STALE with the user sentence', JSON.stringify(a1.body));
    ok(P.read('index.md') === before, '…and index.md is byte-identical');
    const p2 = await post('/api/health/stale-check/index/plan');
    P.put('index.md', before + '| [[b]] | entity | someone else wrote this |\n');   // an index edit
    const a2 = await post('/api/health/stale-check/index/apply', { basis: p2.body.basis });
    ok(a2.status === 409 && a2.body.code === 'INDEX_PLAN_STALE', 'an index.md edit after the preview → stale too');
    // The date alone never makes a preview stale (23:59 → 00:01).
    const p3 = await health.planIndexRebuild('stale-check', { today: '2026-01-01' });
    const a3 = await health.applyIndexRebuild('stale-check', p3.basis, { today: '2026-01-02' });
    ok(a3.written === true && /^Last updated: 2026-01-02$/m.test(P.read('index.md')),
      'a preview made yesterday applies today (the basis blanks the date) and stamps today');
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n§5  indexDrift is NOT auto-fixable — no fix path reaches index.md');
  {
    const X = mkDomain('nofix');
    X.put('entities/e.md', pageBody('E', 'E.'));
    X.put('concepts/c.md', pageBody('C', 'See [[concepts/e]].'));
    X.put('index.md', '# Wiki Index — nofix\n\n| Page | Type | Summary |\n|---|---|---|\n');
    const before = X.read('index.md');
    ok(!health.AUTO_FIXABLE.has('indexDrift'), 'AUTO_FIXABLE does not contain indexDrift');
    let threw = false;
    try { await health.fixIssue('nofix', 'indexDrift', null); } catch { threw = true; }
    ok(threw, 'fixIssue("indexDrift") throws (review-only to the fix dispatcher)');
    const f = await post('/api/health/nofix/fix', { type: 'indexDrift' });
    ok(f.status === 400, 'POST /fix {type:"indexDrift"} → 400');
    const fa = await post('/api/health/nofix/fix-all', { type: 'indexDrift' });
    ok(fa.status === 400, 'POST /fix-all {type:"indexDrift"} → 400');
    const fas = await post('/api/health/nofix/fix-all-safe');
    ok(fas.status === 200 && X.read('index.md') === before, '★ /fix-all-safe on a drifting domain leaves index.md byte-identical');
    await health.fixAllSafe('nofix');
    ok(X.read('index.md') === before, 'fixAllSafe directly: index.md byte-identical');
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n§6  route guards');
  {
    quiet();
    const mPlan = await post('/api/health/shared-mirror/index/plan');
    const mApply = await post('/api/health/shared-mirror/index/apply', { basis: 'a'.repeat(64) });
    loud();
    ok(mPlan.status === 400 && /read-only Shared Brain mirror/.test(mPlan.body.error), 'mirror → /index/plan 400 with the steer');
    ok(mApply.status === 400 && /read-only Shared Brain mirror/.test(mApply.body.error), 'mirror → /index/apply 400 with the steer');
    ok(M.read('index.md') === '# Wiki Index — Mirror (Shared Brain Mirror)\n', 'the mirror index is byte-identical');

    const G = mkDomain('guards');
    G.put('entities/g.md', pageBody('G', 'G.'));
    G.put('index.md', '# Wiki Index — guards\n');
    const before = G.read('index.md');
    const plan = await post('/api/health/guards/index/plan');
    const noBasis = await post('/api/health/guards/index/apply', {});
    ok(noBasis.status === 400, 'missing basis → 400');
    const badBasis = await post('/api/health/guards/index/apply', { basis: 'not-hex' });
    ok(badBasis.status === 400, 'non-hex basis → 400');
    const textBasis = await post('/api/health/guards/index/apply', { basis: plan.body.basis, text: '# injected\n' });
    ok(textBasis.status === 200 && !G.read('index.md').includes('injected'),
      '★ client-supplied text is ignored: the server writes only what it composed');
    G.put('index.md', before);
    const plan2 = await post('/api/health/guards/index/plan');

    registry.beginUpdate();
    const upd = await post('/api/health/guards/index/apply', { basis: plan2.body.basis });
    registry.endUpdate();
    ok(upd.status === 409 && upd.body.conflict === 'write_in_progress', 'update in progress → 409', JSON.stringify(upd.body));
    ok(G.read('index.md') === before, '…nothing written');

    writeFileSync(path.join(G.dir, '.write-lock'), JSON.stringify({ pid: process.pid, op: 'mcp:compile_to_wiki', startedAt: Date.now(), hostname: 'test' }));
    const locked = await post('/api/health/guards/index/apply', { basis: plan2.body.basis });
    rmSync(path.join(G.dir, '.write-lock'));
    ok(locked.status === 409 && locked.body.conflict === 'file_lock', 'file lock held → 409 file_lock', JSON.stringify(locked.body));
    ok(G.read('index.md') === before, '…nothing written');
    ok(!registry.hasActiveWrites(), 'no write registration leaked');

    // A real symlink out of the wiki.
    const Y = mkDomain('symidx');
    Y.put('entities/y.md', pageBody('Y', 'Y.'));
    const outside = path.join(TMP_ROOT, 'outside-index.md');
    writeFileSync(outside, '# Outside\n\nsecret-line\n', 'utf8');
    symlinkSync(outside, path.join(Y.wiki, 'index.md'));
    const sp = await post('/api/health/symidx/index/plan');
    ok(sp.status === 409 && sp.body.code === 'INDEX_UNREADABLE' && !JSON.stringify(sp.body).includes('secret-line'),
      '★ a symlinked index.md → plan 409 INDEX_UNREADABLE, no outside bytes in the reply', JSON.stringify(sp.body));
    const sa = await post('/api/health/symidx/index/apply', { basis: 'b'.repeat(64) });
    ok(sa.status === 409 && sa.body.code === 'INDEX_UNREADABLE', 'apply → 409 INDEX_UNREADABLE');
    ok(readFileSync(outside, 'utf8') === '# Outside\n\nsecret-line\n', 'the outside file is byte-identical');
  }
} finally {
  loud();
  await new Promise((r) => server.close(r));
  __setDomainsDirOverride(null);
  rmSync(TMP_ROOT, { recursive: true, force: true });
}

console.log(`\nPassed: ${passed}   Failed: ${failed}`);
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
