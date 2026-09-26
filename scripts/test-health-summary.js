#!/usr/bin/env node
/**
 * test-health-summary.js — OFFLINE suite for the persisted last Wiki health
 * scan per domain (v3.77, src/brain/health-summary.js).
 *
 * THE DEFECT: scan results lived only in the Domains view's session state, so
 * after a restart every unopened domain showed "Health not checked yet".
 *
 *   §1 the store — record, read, count parity with the view, a newer scan is
 *      never overwritten by an older one, forget on delete, move on rename,
 *      the file lives in the user-data dir and NOT under domains/
 *   §2 stale — a log.md change after the scan serves `stale: true`
 *   §3 RESTART — a separate child process (a fresh module graph, nothing in
 *      memory) reads the entry a scan in this process recorded
 *   §4 the routes over real HTTP — GET /api/health/:d records, GET
 *      /api/domains/stats and /:d/stats serve `health`
 *   §5 the view — domainHealthBadgeHtml's stale wording and
 *      seedHealthSummaries' precedence, lifted from the real source
 *
 * Isolated via CURATOR_TEST_USER_DATA_DIR + CURATOR_TEST_DOMAINS_DIR, set
 * before any app module is imported.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const USER_DIR = mkdtempSync(path.join(os.tmpdir(), 'curator-hsum-user-'));
const DOMAINS_DIR = mkdtempSync(path.join(os.tmpdir(), 'curator-hsum-domains-'));
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DIR;
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS_DIR;
delete process.env.DOMAINS_PATH;

const { __setDomainsDirOverride } = await import(path.join(REPO, 'src/brain/config.js'));
__setDomainsDirOverride(DOMAINS_DIR);
const hs = await import(path.join(REPO, 'src/brain/health-summary.js'));
const { getHealthSummaryPath } = await import(path.join(REPO, 'src/brain/paths.js'));
const { scanWiki } = await import(path.join(REPO, 'src/brain/health.js'));
const { formatAge } = await import(path.join(REPO, 'src/public/next/shared/age.js'));

let passed = 0, failed = 0;
function ok(cond, label, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
}
function section(t) { console.log(`\n── ${t}`); }

function makeDomain(slug, pages) {
  const w = path.join(DOMAINS_DIR, slug, 'wiki');
  for (const f of ['entities', 'concepts', 'summaries']) mkdirSync(path.join(w, f), { recursive: true });
  writeFileSync(path.join(DOMAINS_DIR, slug, 'CLAUDE.md'), `# ${slug}\n`);
  writeFileSync(path.join(w, 'index.md'), '# Index\n');
  writeFileSync(path.join(w, 'log.md'), '# Log\n\n## [2026-09-20] ingest | first\n');
  for (const [rel, body] of Object.entries(pages)) writeFileSync(path.join(w, rel), body);
}
const logOf = (slug) => path.join(DOMAINS_DIR, slug, 'wiki', 'log.md');

// Two orphans + one broken link in 'alpha'; 'beta' is clean-ish.
makeDomain('alpha', {
  'entities/a.md': '---\ntags: [type/entity]\n---\n# A\n\nLinks to [[missing-page]].\n',
  'entities/b.md': '---\ntags: [type/entity]\n---\n# B\n',
});
makeDomain('beta', { 'entities/c.md': '---\ntags: [type/entity]\n---\n# C\n' });

const SRC = readFileSync(path.join(REPO, 'src/public/next/views/domains.js'), 'utf8');
function lift(name) {
  const m = SRC.match(new RegExp(`\\n((?:async )?function ${name}\\()`));
  if (!m) throw new Error('lift: no function ' + name);
  const start = m.index + 1;
  return SRC.slice(start, SRC.indexOf('\n}', start) + 2);
}
function liftConst(name) {
  const m = SRC.match(new RegExp(`\\nconst ${name} = \\[[\\s\\S]*?\\];\\n`));
  if (!m) throw new Error('liftConst: no const ' + name);
  return m[0];
}

// ═══════════════════════════════════════════════════════════════════════════
section('1. The store');
{
  const report = await scanWiki('alpha');
  // The view's own count, lifted from the real source — a dumb cross-check
  // that the server's HEALTH_ISSUE_KEYS are the view's HEALTH_CATEGORIES.
  const { totalOpenIssues } = new Function(liftConst('HEALTH_CATEGORIES') + lift('totalOpenIssues') + '\nreturn { totalOpenIssues };')();
  ok(hs.countOpenIssues(report) === totalOpenIssues(report) && totalOpenIssues(report) > 0,
    `1.1 the server's count equals the Domains view's own totalOpenIssues on a real scan (${hs.countOpenIssues(report)})`);

  ok(Object.keys(await hs.readHealthSummaries(['alpha', 'beta'])).length === 0, '1.2 nothing recorded yet → no entries (never a guessed "0 issues")');
  await hs.recordHealthSummary('alpha', report);
  const got = (await hs.readHealthSummaries(['alpha', 'beta']));
  ok(got.alpha && got.alpha.count === totalOpenIssues(report) && got.alpha.scannedAt === report.scannedAt && got.alpha.stale === false,
    '1.3 a recorded scan is served with its count, its own scannedAt and stale:false', JSON.stringify(got.alpha));
  ok(!('beta' in got), '1.4 an unscanned domain has no entry');

  const file = getHealthSummaryPath();
  ok(existsSync(file) && file.startsWith(USER_DIR + path.sep), '1.5 the file is in the user-data dir', file);
  ok(!file.startsWith(DOMAINS_DIR) && !readdirSync(DOMAINS_DIR, { recursive: true }).some((f) => String(f).includes('health-summary')),
    '1.6 …and nothing was written under domains/ (Personal Sync\'s work-tree)');

  // An older report never overwrites a newer one (a scan-cache hit carries
  // its original scannedAt).
  await hs.recordHealthSummary('alpha', { ...report, scannedAt: '2020-01-01T00:00:00.000Z', brokenLinks: [] });
  ok((await hs.readHealthSummaries(['alpha'])).alpha.scannedAt === report.scannedAt, '1.7 an older scan does not replace a newer one');

  // Concurrent records do not drop each other.
  const rb = await scanWiki('beta');
  await Promise.all([hs.recordHealthSummary('beta', rb), hs.recordHealthSummary('alpha', report)]);
  const both = await hs.readHealthSummaries(['alpha', 'beta']);
  ok(both.alpha && both.beta, '1.8 two scans recorded together both survive');

  await hs.renameHealthSummary('beta', 'beta2');
  let r = JSON.parse(readFileSync(file, 'utf8'));
  ok(!r.beta && r.beta2 && r.beta2.count === hs.countOpenIssues(rb), '1.9 a rename moves the entry to the new slug');
  await hs.forgetHealthSummary('beta2');
  r = JSON.parse(readFileSync(file, 'utf8'));
  ok(!r.beta2 && r.alpha, '1.10 a delete forgets only that domain');
  await hs.recordHealthSummary('../escape', report);
  ok(!JSON.parse(readFileSync(file, 'utf8'))['../escape'], '1.11 a non-slug key is refused');
  await hs.recordHealthSummary('beta', rb);
}

// ═══════════════════════════════════════════════════════════════════════════
section('2. Stale — the wiki changed after the scan');
{
  ok((await hs.readHealthSummaries(['alpha'])).alpha.stale === false, '2.1 CONTROL — unchanged wiki, not stale');
  appendFileSync(logOf('alpha'), '\n## [2026-09-26] ingest | second\n');
  const a = (await hs.readHealthSummaries(['alpha', 'beta']));
  ok(a.alpha.stale === true, '2.2 an ingest (log.md appended) after the scan → stale:true');
  ok(a.beta.stale === false, '2.3 …and only that domain');
  // Only log.md changed, so scanWiki's cache (log.md is outside its
  // signature) answers with the ORIGINAL scannedAt — equal, not older, so it
  // must still be recorded and clear the stale flag.
  const hit = await scanWiki('alpha');
  await hs.recordHealthSummary('alpha', hit);
  ok((await hs.readHealthSummaries(['alpha'])).alpha.stale === false, '2.4 a rescan clears it, even when the scan cache answered with the original scannedAt');
  // A real ingest also writes pages: a cache miss, a newer scannedAt.
  writeFileSync(path.join(DOMAINS_DIR, 'alpha', 'wiki', 'entities', 'd.md'), '# D\n\n[[a]]\n');
  appendFileSync(logOf('alpha'), '\n## [2026-09-26] ingest | third\n');
  ok((await hs.readHealthSummaries(['alpha'])).alpha.stale === true, '2.5 an ingest that writes pages → stale');
  const miss = await scanWiki('alpha');
  await hs.recordHealthSummary('alpha', miss);
  const after = (await hs.readHealthSummaries(['alpha'])).alpha;
  ok(after.stale === false && after.scannedAt === miss.scannedAt && after.count === hs.countOpenIssues(miss),
    '2.6 …and its rescan records the new count and time', JSON.stringify(after));
}

// ═══════════════════════════════════════════════════════════════════════════
section('3. RESTART — a fresh process reads what this one recorded');
{
  const code = `
    const { __setDomainsDirOverride } = await import(${JSON.stringify(pathToFileURL(path.join(REPO, 'src/brain/config.js')).href)});
    __setDomainsDirOverride(${JSON.stringify(DOMAINS_DIR)});
    const hs = await import(${JSON.stringify(pathToFileURL(path.join(REPO, 'src/brain/health-summary.js')).href)});
    process.stderr.write(JSON.stringify(await hs.readHealthSummaries(['alpha','beta','gamma'])));`;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env }, encoding: 'utf8' });
  let seen = null;
  try { seen = JSON.parse(res.stderr); } catch { seen = null; }
  ok(seen && seen.alpha && seen.beta && !seen.gamma && seen.alpha.stale === false,
    '3.1 a new process (nothing in memory) serves both domains\' last scans — the restart case', res.stderr.slice(0, 300));
}

// ═══════════════════════════════════════════════════════════════════════════
section('4. The routes, over real HTTP');
{
  const { default: express } = await import('express');
  const { default: healthRouter } = await import(path.join(REPO, 'src/routes/health.js'));
  const { default: domainsRouter } = await import(path.join(REPO, 'src/routes/domains.js'));
  const app = express();
  app.use(express.json());
  app.use('/api/health', healthRouter);
  app.use('/api/domains', domainsRouter);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const port = server.address().port;
  const get = (p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b) }));
    }).on('error', reject);
  });
  try {
    makeDomain('gamma', { 'entities/g.md': '# G\n\n[[nowhere]]\n' });
    let st = await get('/api/domains/stats');
    const g0 = st.body.domains.find((d) => d.slug === 'gamma');
    ok(g0 && g0.health === null, '4.1 an unscanned domain\'s row carries health:null');
    const scan = await get('/api/health/gamma');
    ok(scan.status === 200, '4.2 the scan route answers');
    st = await get('/api/domains/stats');
    const g1 = st.body.domains.find((d) => d.slug === 'gamma');
    ok(g1 && g1.health && g1.health.count === hs.countOpenIssues(scan.body) && g1.health.scannedAt === scan.body.scannedAt && g1.health.stale === false,
      '4.3 after GET /api/health/gamma the stats row carries that scan', JSON.stringify(g1 && g1.health));
    appendFileSync(logOf('gamma'), '\n## [2026-09-26] compile | x\n');
    const one = await get('/api/domains/gamma/stats');
    ok(one.body.health && one.body.health.stale === true, '4.4 the one-domain stats route serves it too, stale after a write');
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('5. The view — the badge and the seed');
{
  const { domainHealthBadgeHtml, seedHealthSummaries } = new Function('formatAge',
    lift('domainHealthBadgeHtml') + '\n' + lift('seedHealthSummaries') + '\nreturn { domainHealthBadgeHtml, seedHealthSummaries };')(formatAge);
  const now = Date.parse('2026-09-26T12:00:00Z');
  const twoDays = '2026-09-24T12:00:00Z';
  const fresh = domainHealthBadgeHtml({ count: 4, scannedAt: twoDays, stale: false }, now, false);
  ok(/dm-row-attn/.test(fresh) && /4 open health issues, checked 2 days ago/.test(fresh), '5.1 a fresh persisted scan shows its count and "checked 2 days ago"', fresh);
  const stale = domainHealthBadgeHtml({ count: 4, scannedAt: twoDays, stale: true }, now, false);
  ok(/dm-row-unscanned-dot/.test(stale) && !/dm-row-attn/.test(stale) && !/4 open/.test(stale),
    '5.2 a STALE scan never shows its count — the hollow ring', stale);
  ok(/Health checked 2 days ago, before the wiki last changed/.test(stale), '5.3 …and says it was checked before the wiki last changed', stale);
  const none = domainHealthBadgeHtml(undefined, now, false);
  ok(/not checked yet/.test(none), '5.4 CONTROL — no entry still reads "not checked yet"');

  const summary = { a: { count: 1, scannedAt: '2026-09-26T11:00:00Z' } };
  seedHealthSummaries(summary, [
    { slug: 'a', health: { count: 9, scannedAt: '2026-09-26T10:00:00Z', stale: false } },
    { slug: 'b', health: { count: 2, scannedAt: twoDays, stale: true } },
    { slug: 'c', health: null },
  ]);
  ok(summary.a.count === 1, '5.5 a strictly newer session scan is kept over the server\'s older one');
  ok(summary.b && summary.b.count === 2 && summary.b.stale === true, '5.6 an unopened domain is seeded from the server, stale flag and all');
  ok(!('c' in summary), '5.7 health:null seeds nothing (stays "not checked")');
  const s2 = { a: { count: 1, scannedAt: '2026-09-26T10:00:00Z' } };
  seedHealthSummaries(s2, [{ slug: 'a', health: { count: 1, scannedAt: '2026-09-26T10:00:00Z', stale: true } }]);
  ok(s2.a.stale === true, '5.8 the SAME scan, now stale on the server, is marked stale in the session');
  ok(/seedHealthSummaries\(state\.healthSummary, nextRows\)/.test(lift('loadDomainsList')), '5.9 the list load seeds from the rows');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
