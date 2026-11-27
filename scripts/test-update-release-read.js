/**
 * test-update-release-read.js — OFFLINE guard for reading GitHub's release
 * list (v4.2.2).
 *
 * ── WHY THIS SUITE EXISTS ───────────────────────────────────────────────────
 *
 * The owner, 2026-11-27: the Mac app said "Couldn't check for updates — the
 * response was not in the expected form", and a retry worked. Three facts made
 * that sentence possible:
 *
 *   1. the release list was requested 30 releases at a time, and every release
 *      from v4.1.0 on carries 35 assets (the GPL source of the bundled MinGit),
 *      so the body measured 663,656 bytes uncompressed;
 *   2. ONE `AbortSignal.timeout(8000)` bounded the headers AND the body read;
 *   3. a body cut off by it made `response.json()` throw, and that was reported
 *      as a WRONG SHAPE ("not in the expected form") rather than as a network
 *      failure that says try again.
 *
 * Both readers — the route's `installerUpdateCheck()` (Settings and the menu
 * bar's Check for Updates) and the desktop resolver `resolveInstallerRelease()`
 * (the in-app install) — now go through ONE exported read,
 * `fetchReleaseList()` in src/routes/config.js. This suite drives all three
 * with a fake fetch that honours the abort signal it is given, the way undici
 * does, and never touches the network (a tripwire replaces globalThis.fetch).
 *
 * ── SECTIONS ────────────────────────────────────────────────────────────────
 *   §0  the modules load; the tripwire is armed
 *   §1  fetchReleaseList: a slow body, a slow answer, the SEPARATE body budget,
 *       a truncated body, a dropped connection, a body that is not JSON, a
 *       parsed body of the wrong shape (still 'shape'), Cancel, the budget
 *       surviving a caller's signal
 *   §1b the same read over REAL undici and a 127.0.0.1 server: a stalled body,
 *       a cut connection, a slow-but-within-budget body
 *   §2  the route: each failure's reason and sentence, through the real handler
 *   §3  the desktop resolver: the same failures, through the real module
 *   §4  the page of 10: non-installable releases on top, every platform and
 *       arch, and the honest answer when the page holds no installer
 *   §5  real user data untouched
 *
 * Mutation-proven: see the v4.2.2 row in CLAUDE.md.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.log(`  ✗ ${msg}`); }
}
function eq(a, b, msg) {
  const pass = JSON.stringify(a) === JSON.stringify(b);
  ok(pass, pass ? msg : `${msg}  (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`);
}
function section(t) { console.log(`\n${t}`); }

// ── isolation: never the real user data ─────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'curator-release-read-'));
fs.mkdirSync(path.join(TMP, 'userdata'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'domains'), { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = path.join(TMP, 'userdata');
process.env.CURATOR_TEST_DOMAINS_DIR = path.join(TMP, 'domains');
process.env.CURATOR_NO_OPEN = '1';
delete process.env.DOMAINS_PATH;

const REAL_FILES = ['.curator-config.json', '.sync-config.json', '.sharedbrain-config.json']
  .map((f) => path.join(ROOT, f));
function fingerprint() {
  return REAL_FILES.map((f) => {
    if (!fs.existsSync(f)) return `${path.basename(f)}:absent`;
    const buf = fs.readFileSync(f);
    return `${path.basename(f)}:${buf.length}:${createHash('sha256').update(buf).digest('hex')}`;
  }).join('|');
}
const fpBefore = fingerprint();

// ── the tripwire: an offline suite must never reach the real network ────────
const realFetch = globalThis.fetch;
let escaped = 0;
globalThis.fetch = async () => { escaped++; throw new Error('ESCAPED TO THE REAL NETWORK'); };

section('§0 the modules load');
let cfg, release, installMode;
try {
  cfg = await import(pathToFileURL(path.join(ROOT, 'src', 'routes', 'config.js')).href);
  release = await import(pathToFileURL(path.join(ROOT, 'desktop', 'lib', 'update-release.js')).href);
  installMode = await import(pathToFileURL(path.join(ROOT, 'src', 'brain', 'install-mode.js')).href);
  ok(typeof cfg.fetchReleaseList === 'function', 'src/routes/config.js exports fetchReleaseList');
  ok(typeof release.resolveInstallerRelease === 'function', 'desktop/lib/update-release.js exports resolveInstallerRelease');
} catch (err) {
  ok(false, `a module under test failed to load: ${err && err.message}`);
  console.log(`\nPassed: ${passed}   Failed: ${failed}`);
  globalThis.fetch = realFetch;
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
}
ok(cfg.RELEASES_BODY_TIMEOUT_MS > cfg.RELEASES_TIMEOUT_MS,
  `the body budget (${cfg.RELEASES_BODY_TIMEOUT_MS} ms) is longer than the answer budget (${cfg.RELEASES_TIMEOUT_MS} ms)`);
ok(cfg.RELEASES_TIMEOUT_MS + cfg.RELEASES_BODY_TIMEOUT_MS <= 30000,
  'and the two together stay bounded (at most 30 s)');

// ── fakes ───────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Resolves after `ms`, or rejects with the signal's reason the moment it
// aborts — exactly what undici does to a pending fetch or body read.
function abortable(signal, ms, value) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(signal.reason);
    const t = setTimeout(() => (typeof value === 'function' ? (() => { try { resolve(value()); } catch (e) { reject(e); } })() : resolve(value)), ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
  });
}
/** A fetch whose answer takes `headersMs` and whose body takes `bodyMs`. */
function timedFetch({ headersMs = 0, bodyMs = 0, payload = [], status = 200, seen = null } = {}) {
  return async (url, init) => {
    if (seen) seen.push({ url, init });
    const signal = init && init.signal;
    await abortable(signal, headersMs, null);
    return {
      ok: status >= 200 && status < 300, status, headers: new Map(),
      json: () => abortable(signal, bodyMs, () => (typeof payload === 'function' ? payload() : payload)),
    };
  };
}
const okBody = (jsonImpl) => async () => ({ ok: true, status: 200, headers: new Map(), json: jsonImpl });

// Fixture releases, shaped like the real ones (2026-11-27): six installer
// names plus the GPL sources.
const SOURCES = ['bash-5.3.015-2.src.tar.gz', 'git-for-windows-2.56.1.windows.1-source.tar.gz',
  'mingw-w64-git-2.56.1.1-1.src.tar.gz', 'sed-4.9-1.src.tar.zst'];
let assetId = 0;
function asset(name) {
  assetId++;
  return {
    name, size: 1000 + assetId, digest: `sha256:${createHash('sha256').update(name).digest('hex')}`,
    browser_download_url: `https://github.com/talirezun/the-curator/releases/download/x/${name}`,
  };
}
function rel(v, { mac = true, win = true, draft = false, prerelease = false, sources = true } = {}) {
  const names = [];
  if (sources) names.push(...SOURCES);
  if (mac) names.push(`TheCurator-${v}-arm64-AppleSilicon.dmg`, `TheCurator-${v}-x64-Intel.dmg`,
    'TheCurator-Mac-AppleSilicon.dmg', 'TheCurator-Mac-Intel.dmg');
  if (win) names.push(`TheCurator-${v}-x64-Windows-Setup.exe`, 'TheCurator-Windows-Setup.exe');
  return {
    tag_name: `v${v}`, name: `v${v}`, draft, prerelease,
    html_url: `https://github.com/talirezun/the-curator/releases/tag/v${v}`,
    published_at: '2026-11-27T08:40:42Z', assets: names.map(asset),
  };
}

const T = { headersMs: 60, bodyMs: 200 }; // test budgets; production is 8 s + 15 s

// ═══════════════════════════════════════════════════════════════════════════
section('§1 fetchReleaseList — the one read');
// ═══════════════════════════════════════════════════════════════════════════
{
  const r = await cfg.fetchReleaseList(timedFetch({ headersMs: 0, bodyMs: 5000, payload: [rel('4.2.1')] }), T);
  eq([r.ok, r.kind], [false, 'body'], 'a body slower than its budget is a BODY failure (the owner\'s case), not a shape');
}
{
  const t0 = Date.now();
  await cfg.fetchReleaseList(timedFetch({ headersMs: 0, bodyMs: 5000 }), T);
  const took = Date.now() - t0;
  ok(took < 2000, `and the body budget really stops it (${took} ms, budget ${T.bodyMs} ms, body would take 5000 ms)`);
}
{
  const r = await cfg.fetchReleaseList(timedFetch({ headersMs: 5000 }), T);
  eq([r.ok, r.kind], [false, 'network'], 'an answer slower than its budget is a NETWORK failure: GitHub was never heard from');
}
{
  // The SEPARATE budget. Headers at 30 ms, body at 30 + 120 = 150 ms total:
  // more than the 60 ms answer budget, less than the 200 ms body budget. With
  // one budget over both (the pre-v4.2.2 shape) this read is cut off.
  const r = await cfg.fetchReleaseList(timedFetch({ headersMs: 30, bodyMs: 120, payload: [rel('4.2.1')] }), T);
  eq(r.ok, true, 'a body that takes LONGER than the answer budget but within its own budget is read in full');
  ok(r.ok && Array.isArray(r.payload) && r.payload[0].tag_name === 'v4.2.1', 'and the payload is the release list');
}
{
  const truncated = JSON.stringify([rel('4.2.1')]).slice(0, 700);
  const r = await cfg.fetchReleaseList(okBody(async () => JSON.parse(truncated)), T);
  eq([r.ok, r.kind], [false, 'body'], 'a truncated JSON body (SyntaxError) is a body failure, not a shape');
}
{
  const r = await cfg.fetchReleaseList(okBody(async () => { throw new TypeError('terminated'); }), T);
  eq([r.ok, r.kind], [false, 'body'], 'a connection dropped mid-body (undici\'s TypeError "terminated") is a body failure');
}
{
  const r = await cfg.fetchReleaseList(okBody(async () => { throw new DOMException('aborted', 'AbortError'); }), T);
  eq([r.ok, r.kind], [false, 'body'], 'an AbortError during the body read is a body failure');
}
{
  const r = await cfg.fetchReleaseList(okBody(async () => JSON.parse('<html>captive portal</html>')), T);
  eq([r.ok, r.kind], [false, 'body'], 'a body that is not JSON at all is a body failure too (nothing parsed)');
}
{
  const r = await cfg.fetchReleaseList(okBody(async () => ({ message: 'Not Found' })), T);
  eq([r.ok, r.kind], [false, 'shape'], 'a body that PARSED and is not an array is still a SHAPE failure');
}
{
  const r = await cfg.fetchReleaseList(okBody(async () => null), T);
  eq([r.ok, r.kind], [false, 'shape'], 'a body that parsed to null is a shape failure');
}
{
  const r = await cfg.fetchReleaseList(async () => ({ ok: false, status: 403, headers: new Map() }), T);
  eq([r.ok, r.kind, r.response && r.response.status], [false, 'http', 403], 'a non-2xx answer is http, with the response carried');
}
{
  const r = await cfg.fetchReleaseList(async () => { throw new Error('ENOTFOUND'); }, T);
  eq([r.ok, r.kind], [false, 'network'], 'a fetch that throws is network');
}
{
  const r = await cfg.fetchReleaseList(async () => null, T);
  eq([r.ok, r.kind], [false, 'http'], 'a fetch resolving to nothing degrades to http, never a throw');
}
{
  // Cancel (the desktop updater's caller signal) during the body.
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 20);
  const r = await cfg.fetchReleaseList(timedFetch({ bodyMs: 5000 }), { ...T, bodyMs: 5000, signal: ctl.signal });
  eq([r.ok, r.kind], [false, 'body'], 'a caller\'s Cancel during the body stops the read');
}
{
  // A caller's signal must never REPLACE the budget (update-release.js's
  // recorded lesson): with a live, never-aborted caller signal the body budget
  // still fires.
  const ctl = new AbortController();
  const t0 = Date.now();
  const r = await cfg.fetchReleaseList(timedFetch({ bodyMs: 5000 }), { ...T, signal: ctl.signal });
  eq([r.ok, r.kind], [false, 'body'], 'with a caller signal that never aborts, the body budget still bounds the read');
  ok(Date.now() - t0 < 2000, 'and it fires at the budget, not at the body\'s 5 s');
}
{
  const seen = [];
  await cfg.fetchReleaseList(timedFetch({ seen }), T);
  eq(seen.length, 1, 'one request per read');
  eq(seen[0] && seen[0].url, cfg.RELEASES_API_URL, 'to the route\'s one URL');
  ok(seen[0] && seen[0].init.signal && typeof seen[0].init.signal.aborted === 'boolean', 'with an abort signal');
  eq(seen[0] && seen[0].init.headers['User-Agent'], cfg.RELEASES_USER_AGENT, 'and the fixed User-Agent');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§1b the same read over REAL undici and a local server');
// ═══════════════════════════════════════════════════════════════════════════
// The fakes above model undici; this proves the model. A server on 127.0.0.1
// sends its headers at once and then misbehaves in the body. The read is
// pointed at it by a fetchImpl that swaps the URL and keeps everything else
// (the signal included) — the real network is never reached.
{
  const http = await import('node:http');
  const BODY = JSON.stringify([rel('4.2.1')]);
  const server = http.createServer((req, res) => {
    const mode = new URL(req.url, 'http://x').searchParams.get('mode');
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(BODY) });
    if (mode === 'stall') { res.write(BODY.slice(0, 200)); return; }                    // never finishes
    if (mode === 'cut') { res.write(BODY.slice(0, 200)); setTimeout(() => req.socket.destroy(), 20); return; }
    if (mode === 'slow') { res.write(BODY.slice(0, 200)); setTimeout(() => res.end(BODY.slice(200)), 120); return; }
    res.end(BODY);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const local = (mode) => (url, init) => realFetch(`http://127.0.0.1:${port}/?mode=${mode}`, init);
  try {
    const t0 = Date.now();
    const stall = await cfg.fetchReleaseList(local('stall'), T);
    eq([stall.ok, stall.kind], [false, 'body'], 'real undici: a body that stalls after the headers is a body failure');
    ok(Date.now() - t0 < 2000, 'and the body budget really aborts a real stream');
    const cut = await cfg.fetchReleaseList(local('cut'), T);
    eq([cut.ok, cut.kind], [false, 'body'], 'real undici: a connection cut mid-body is a body failure');
    const slow = await cfg.fetchReleaseList(local('slow'), T);
    eq(slow.ok, true, 'real undici: a body slower than the answer budget, within its own, is read in full');
    const whole = await cfg.fetchReleaseList(local('ok'), T);
    ok(whole.ok && whole.payload[0].tag_name === 'v4.2.1', 'real undici: a whole body parses (CONTROL)');
  } finally {
    server.closeAllConnections && server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2 the route — GET /api/config/update-check in bundle mode');
// ═══════════════════════════════════════════════════════════════════════════
const BUNDLE_CAPS = installMode.getCapabilities('bundle');
function fakeRes() {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}
async function routeCheck(fetchImpl, platform = 'darwin', timeouts = T) {
  const res = fakeRes();
  await cfg.updateCheckHandler({}, res, {
    caps: BUNDLE_CAPS, fetch: fetchImpl, platform, releaseTimeouts: timeouts,
    execAsync: async () => { throw new Error('the installer arm must not run git'); },
  });
  return { status: res.statusCode, body: res.body };
}
{
  const r = await routeCheck(timedFetch({ bodyMs: 5000, payload: [rel('99.0.0')] }));
  eq(r.status, 502, 'a body that timed out is a 502');
  eq(r.body.reason, 'download-interrupted', 'with its own reason, download-interrupted');
  ok(/try again/i.test(r.body.error), 'and a sentence that says try again');
  ok(!/expected form/i.test(r.body.error), 'never "not in the expected form" (the owner\'s sentence)');
  ok(r.body.updateAvailable === undefined, 'and no updateAvailable, so it can never read as up to date');
}
{
  const truncated = JSON.stringify([rel('99.0.0')]).slice(0, 500);
  const r = await routeCheck(okBody(async () => JSON.parse(truncated)));
  eq(r.body.reason, 'download-interrupted', 'a truncated body is download-interrupted through the route');
}
{
  const r = await routeCheck(okBody(async () => { throw new TypeError('terminated'); }));
  eq(r.body.reason, 'download-interrupted', 'a dropped connection is download-interrupted through the route');
}
{
  const r = await routeCheck(okBody(async () => ({ message: 'Not Found' })));
  eq(r.body.reason, 'unexpected-response', 'a parsed body of the wrong shape is STILL unexpected-response');
  ok(/expected form/i.test(r.body.error), 'and keeps its own sentence');
}
{
  const r = await routeCheck(timedFetch({ headersMs: 5000 }));
  eq(r.body.reason, 'unreachable', 'an answer that never came is unreachable');
}
{
  const r = await routeCheck(timedFetch({ headersMs: 30, bodyMs: 120, payload: [rel('99.0.0')] }));
  eq([r.status, r.body.latest, r.body.updateAvailable], [200, '99.0.0', true],
    'a slow-but-within-budget body gives a real answer through the route');
}
{
  const msgs = new Set(['network', 'body', 'shape'].map((k) => cfg.classifyReleaseFailure(k).body.error));
  eq(msgs.size, 3, 'network, body and shape each have their own sentence');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3 the desktop resolver — resolveInstallerRelease');
// ═══════════════════════════════════════════════════════════════════════════
const resolve = (fetchImpl, extra = {}) => release.resolveInstallerRelease({
  configModule: cfg, fetchImpl, currentVersion: '4.2.1', arch: 'arm64', platform: 'darwin',
  releaseTimeouts: T, ...extra,
});
{
  const r = await resolve(timedFetch({ bodyMs: 5000, payload: [rel('99.0.0')] }));
  eq(r.reason, 'network-unreachable', 'a body that timed out is network-unreachable (says try again)');
  ok(r.reason !== 'unexpected-response', 'never unexpected-response');
}
{
  const truncated = JSON.stringify([rel('99.0.0')]).slice(0, 500);
  eq((await resolve(okBody(async () => JSON.parse(truncated)))).reason, 'network-unreachable',
    'a truncated body is network-unreachable');
}
{
  eq((await resolve(okBody(async () => ({ message: 'Not Found' })))).reason, 'unexpected-response',
    'a parsed body of the wrong shape is STILL unexpected-response');
}
{
  eq((await resolve(async () => ({ ok: false, status: 500, headers: new Map() }))).reason, 'github-error',
    'a 500 is github-error');
}
{
  const r = await resolve(timedFetch({ headersMs: 30, bodyMs: 120, payload: [rel('99.0.0')] }));
  eq([r.ok, r.version], [true, '99.0.0'], 'a slow-but-within-budget body resolves the release');
}
{
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 20);
  const r = await resolve(timedFetch({ bodyMs: 5000, payload: [rel('99.0.0')] }), { signal: ctl.signal, releaseTimeouts: { headersMs: 60, bodyMs: 5000 } });
  eq(r.reason, 'network-unreachable', 'Cancel during the body is a named failure, not a hang');
}
{
  const noRead = { pickInstallableRelease: cfg.pickInstallableRelease, decideInstallerUpdate: cfg.decideInstallerUpdate };
  eq((await release.resolveInstallerRelease({ configModule: noRead, fetchImpl: timedFetch(), currentVersion: '4.2.1', arch: 'arm64' })).reason,
    'unexpected-response', 'a config module without fetchReleaseList refuses by name');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4 the page of 10');
// ═══════════════════════════════════════════════════════════════════════════
{
  const u = new URL(cfg.RELEASES_API_URL);
  eq(u.searchParams.get('per_page'), '10', 'the release list is requested 10 at a time');
  eq([...u.searchParams.keys()], ['per_page'], 'and the page size is the only query parameter');
}
// The newest-created first, as GitHub lists them. On top: a release whose Mac
// job failed (Windows only), one whose Windows job failed (Mac only), one with
// only sources, a draft (invisible unauthenticated, filtered anyway), then the
// last good release.
const MIXED = [
  rel('4.3.3', { mac: false }),
  rel('4.3.2', { win: false }),
  rel('4.3.1', { mac: false, win: false }),
  rel('4.3.0', { draft: true }),
  rel('4.2.1'),
  rel('4.2.0'), rel('4.1.2'), rel('4.1.1'), rel('4.1.0'), rel('4.0.1'),
];
eq(MIXED.length, 10, 'CONTROL: the fixture is one page of 10');
for (const [platform, arch, want, assetRe] of [
  ['darwin', 'arm64', '4.3.2', /4\.3\.2-arm64-AppleSilicon\.dmg$/],
  ['darwin', 'x64', '4.3.2', /4\.3\.2-x64-Intel\.dmg$/],
  ['win32', 'x64', '4.3.3', /4\.3\.3-x64-Windows-Setup\.exe$/],
]) {
  const pick = cfg.pickInstallableRelease(MIXED, { platform });
  eq(pick && pick.version, want, `${platform}: the picker skips the releases with no ${platform === 'win32' ? 'EXE' : 'DMG'} and names v${want}`);
  const r = await release.resolveInstallerRelease({ configModule: cfg, fetchImpl: timedFetch({ payload: MIXED }),
    currentVersion: '4.2.1', arch, platform, releaseTimeouts: T });
  ok(r.ok && r.version === want && assetRe.test(r.asset.name),
    `${platform} ${arch}: the in-app updater downloads ${r.ok ? r.asset.name : r.reason}`);
  const c = await routeCheck(timedFetch({ payload: MIXED }), platform);
  eq([c.body.latest, c.body.updateAvailable], [want, true], `${platform}: Settings names the same release`);
}
{
  // Nine non-installable entries on top: the tenth still answers.
  const page = [
    ...Array.from({ length: 9 }, (_, i) => rel(`5.0.${9 - i}`, { mac: false, win: false })),
    rel('4.2.1'),
  ];
  eq(page.length, 10, 'CONTROL: nine releases with no installer above the last good one, one page');
  eq(cfg.pickInstallableRelease(page, { platform: 'darwin' }).version, '4.2.1', 'darwin still finds the last good release at position 10');
  eq(cfg.pickInstallableRelease(page, { platform: 'win32' }).version, '4.2.1', 'win32 too');
}
{
  // The page holds no installer for this platform: the honest answer is "no
  // installable build", never an older version passed off as the newest.
  const page = Array.from({ length: 10 }, (_, i) => rel(`5.0.${10 - i}`, { win: false }));
  const c = await routeCheck(timedFetch({ payload: page }), 'win32');
  eq([c.status, c.body.noInstallableRelease, c.body.updateAvailable], [200, true, false],
    'ten Mac-only releases on Windows: no installable build, nothing offered');
  ok(c.body.error === undefined && c.body.latest === null, 'and no version is invented');
}
{
  // The real asset count (35 per release from v4.1.0) does not change a pick.
  const real = rel('4.2.1');
  for (let i = 0; i < 25; i++) real.assets.push(asset(`extra-source-${i}.src.tar.zst`));
  ok(real.assets.length >= 35, `CONTROL: a release with ${real.assets.length} assets`);
  eq(cfg.pickInstallableRelease([real], { platform: 'win32' }).version, '4.2.1', 'a 35-asset release is picked on Windows');
  eq(cfg.pickInstallableRelease([real], { platform: 'darwin' }).version, '4.2.1', 'and on a Mac');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5 real user data untouched; no network');
// ═══════════════════════════════════════════════════════════════════════════
globalThis.fetch = realFetch;
eq(escaped, 0, 'no assertion reached the real network');
eq(fingerprint(), fpBefore, 'the real credential files are byte-identical after the run');
fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\nPassed: ${passed}   Failed: ${failed}`);
process.exit(failed ? 1 : 0);
