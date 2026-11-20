#!/usr/bin/env node
/**
 * The Windows packaged app's identity: where its user data lives, what marks
 * it as a bundle, and what it may do to itself. Offline, no network, no key,
 * writes only under os.tmpdir().
 *
 * WHY THIS SUITE EXISTS. A Windows NSIS install (`%LOCALAPPDATA%\Programs\The
 * Curator\resources\app`) has no `.app/Contents` in its path, so before this
 * work it resolved as a REPO install: every user-data path (the wiki, the API
 * keys, the Personal Sync repo) landed INSIDE the program folder. On macOS that
 * mistake is loud (the bundle is read-only); on Windows the per-user install
 * folder is writable, so it is silent — and the next update or an uninstall
 * deletes the program folder with the user's second brain in it. The fix is
 * the packager's marker `.curator-bundle` (written by the Windows afterPack,
 * a later package) plus the win32 arm in paths.js tested here.
 *
 *   §1  macOS and repo mode are BYTE-IDENTICAL to v3.99.3 (f6d89e4): every
 *       resolver, run in child processes from real `git archive` trees, from
 *       the baseline paths.js and from this one, on four layouts
 *   §2  a simulated win32 bundle (marker present) resolves EVERY user-data
 *       getter — enumerated from the module's exports, not a list — outside
 *       APP_ROOT, inside %LOCALAPPDATA%\TheCurator\App, while logs, the update
 *       work dir and the instance registry's root stay at the shared root
 *   §3  on win32 the marker is the ONLY signal: nothing is inferred
 *   §4  the marker never exists in the repo, and nothing outside the packager
 *       (desktop/) or this module names it — install.ps1 and scripts/windows
 *       included
 *   §5  platform-aware capabilities: `mcpLaunchStyle: 'app-binary'` on a win32
 *       bundle only; every record exhaustive; the git path OFF and the
 *       installer path ON for every bundle
 *
 * What only a real Windows machine can prove is listed at the end of the run
 * (a simulated host is not a Windows filesystem).
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(actual, expected, label) {
  ok(actual === expected, `${label}${actual === expected ? '' : `\n        expected: ${expected}\n        actual:   ${actual}`}`);
}
function section(t) { console.log(`\n${t}`); }
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// A child must never inherit a seam that would short-circuit the resolution
// under test, nor a DOMAINS_PATH.
const CLEAN_ENV = { ...process.env };
for (const k of ['CURATOR_TEST_USER_DATA_DIR', 'CURATOR_TEST_DOMAINS_DIR', 'CURATOR_TEST_LOG_DIR',
  'CURATOR_TEST_MCP_LAUNCHER_DIR', 'CURATOR_TEST_INSTANCE_DIR', 'DOMAINS_PATH', 'LOCALAPPDATA']) delete CLEAN_ENV[k];

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'curator-paths-win32-')));

// ═══════════════════════════════════════════════════════════════════════════
section('§1  macOS and repo mode — byte-identical to the v3.99.3 baseline');
// ═══════════════════════════════════════════════════════════════════════════

// The baseline is a FIXED commit, not HEAD: once this change is committed,
// HEAD-vs-working-tree compares the file with itself. CI's full-suite job
// checks out full history (test.yml) so the commit is reachable.
const BASELINE = 'f6d89e4';
let baselineSrc = null;
try {
  baselineSrc = execFileSync('git', ['-C', ROOT, 'show', `${BASELINE}:src/brain/paths.js`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch { /* reported below */ }
ok(typeof baselineSrc === 'string' && baselineSrc.includes('export function getUserDataDir'),
  `the v3.99.3 baseline paths.js is readable from git (${BASELINE}) — a shallow clone would make §1 vacuous, so it fails instead`);
const workSrc = read('src/brain/paths.js');
ok(baselineSrc !== workSrc, 'PRECONDITION: the working paths.js differs from the baseline (so the comparison below is a real one)');

let archive = null;
function materialise(dest, pathsSrc) {
  fs.mkdirSync(dest, { recursive: true });
  if (!archive) archive = path.join(TMP, 'tree.tar');
  if (!fs.existsSync(archive)) execFileSync('git', ['-C', ROOT, 'archive', '-o', archive, 'HEAD']);
  execFileSync('tar', ['-x', '-f', archive, '-C', dest]);
  fs.writeFileSync(path.join(dest, 'src', 'brain', 'paths.js'), pathsSrc);
  return dest;
}

// Every resolver the baseline exports, on the real host. The win32 rows
// exercise the EXPLICIT-argument form (reachable on any host and unchanged).
const PROBE = (file) => `
  import * as p from ${JSON.stringify(file)};
  const W = { platform: 'win32', env: { LOCALAPPDATA: 'C:\\\\Users\\\\Ana\\\\AppData\\\\Local' }, homedir: 'C:\\\\Users\\\\Ana' };
  const out = {
    APP_ROOT: p.APP_ROOT, isRepo: p.isRepoInstall(), isBundle: p.isBundleInstall(),
    userData: p.getUserDataDir(), state: p.getUserDataDirState(), exists: p.userDataDirExists(),
    appSupport: p.getAppSupportDir(), appSupportWin: p.getAppSupportDir(W),
    appSupportWinNoEnv: p.getAppSupportDir({ ...W, env: {} }),
    logs: p.getLogsDir(), logsWin: p.getLogsDir(W), launcher: p.getMcpLauncherDir(),
    joined: p.userDataPath('a', 'b'), app: p.appPath('x', 'y'),
    creds: p.getCredentialFiles(),
    consts: [p.APP_SUPPORT_DIR_NAME, p.APP_LOGS_DIR_NAME, p.BUNDLE_MARKER_FILE, p.WINDOWS_APP_DIR_NAME],
  };
  for (const k of ['getCuratorConfigFile','getSyncConfigFile','getSyncGitDir','getSharedBrainConfigFile',
    'getDefaultDomainsDir','getIngestQueueDir','getMcpUsageLogPath','getMcpInstallManifestPath','getHookLogPath',
    'getHealthSummaryPath','getDuplicateChecksDir','getHealthUndoDir','getRecentNewPagesDir','getDuplicateJobsDir',
    'getTrashDir']) out[k] = p[k]();
  process.stdout.write(JSON.stringify(out));
`;
function runProbe(appRoot, home) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', PROBE(pathToFileURL(path.join(appRoot, 'src/brain/paths.js')).href)],
    { env: { ...CLEAN_ENV, HOME: home }, encoding: 'utf8' });
  return { stdout: r.stdout, stderr: r.stderr.replace(/\n.*ExperimentalWarning.*\n?/g, '\n'), status: r.status };
}

const LAYOUTS = [
  ['checkout',         ['checkout'],                              t => fs.mkdirSync(path.join(t, '.git'))],
  ['no .git (ZIP)',    ['zip'],                                   () => {}],
  ['macOS .app',       ['The Curator.app', 'Contents', 'Resources', 'app'], () => {}],
  ['marker, any path', ['marked'],                                t => fs.writeFileSync(path.join(t, '.curator-bundle'), '')],
];

// ── win32 HOST: the bundle arm changed ON PURPOSE in this release ───────────
// (owner decisions) On win32 only the `.curator-bundle` marker makes a bundle
// (a `<X>.app\Contents` path never does), and a win32 bundle's user data lives
// in <appSupport>\App rather than <appSupport>. So on a win32 host the two
// bundle layouts cannot be byte-identical to v3.99.3; they are asserted for the
// NEW behaviour instead, and every resolver the bundle arm does not touch is
// still compared byte-for-byte. darwin/linux hosts never reach this code.
const UNTOUCHED_KEYS = ['APP_ROOT', 'appSupport', 'appSupportWin', 'appSupportWinNoEnv', 'logs', 'logsWin', 'launcher', 'consts'];
const DATA_KEYS = ['userData', 'joined', 'getCuratorConfigFile', 'getSyncConfigFile', 'getSyncGitDir', 'getSharedBrainConfigFile',
  'getDefaultDomainsDir', 'getIngestQueueDir', 'getMcpUsageLogPath', 'getMcpInstallManifestPath', 'getHookLogPath',
  'getHealthSummaryPath', 'getDuplicateChecksDir', 'getHealthUndoDir', 'getRecentNewPagesDir', 'getDuplicateJobsDir', 'getTrashDir'];
/** baseline/work: parsed probe outputs of a marker bundle on win32. Returns the list of mismatches (empty = intended behaviour). */
function win32MarkerBundleProblems(b, w) {
  const bad = [];
  const j = JSON.stringify;
  for (const k of UNTOUCHED_KEYS) if (j(b[k]) !== j(w[k])) bad.push(`${k} changed: ${j(b[k])} -> ${j(w[k])}`);
  if (!(w.isBundle === true && w.isRepo === false)) bad.push('work is not a bundle');
  if (b.userData !== b.appSupport) bad.push('PRECONDITION: baseline user data should be the app-support root');
  const want = path.win32.join(w.appSupport, 'App');
  if (w.userData !== want) bad.push(`userData ${w.userData} !== ${want}`);
  const re = (v) => (typeof v === 'string' && v.toLowerCase().startsWith(b.userData.toLowerCase() + '\\'))
    ? want + v.slice(b.userData.length) : (v === b.userData ? want : v);
  for (const k of DATA_KEYS) if (re(b[k]) !== w[k]) bad.push(`${k}: expected ${re(b[k])} got ${w[k]}`);
  if (j(b.creds.map(c => [c.rel, re(c.abs)])) !== j(w.creds.map(c => [c.rel, c.abs]))) bad.push('credential list differs beyond the App relocation');
  return bad;
}
/** baseline/work: parsed probe outputs of a `.app\Contents` path with NO marker on win32. */
function win32AppShapedProblems(b, w, workStderr) {
  const bad = [];
  const j = JSON.stringify;
  for (const k of UNTOUCHED_KEYS) if (j(b[k]) !== j(w[k])) bad.push(`${k} changed: ${j(b[k])} -> ${j(w[k])}`);
  if (b.isBundle !== true) bad.push('PRECONDITION: v3.99.3 read this layout as a bundle');
  if (!(w.isBundle === false && w.isRepo === true)) bad.push('work still reads it as a bundle');
  if (w.userData !== w.APP_ROOT) bad.push(`userData ${w.userData} !== APP_ROOT ${w.APP_ROOT}`);
  if (/packaged app/.test(workStderr)) bad.push('work announced a bundle relocation on stderr');
  return bad;
}
if (baselineSrc) {
  for (const [label, segs, prep] of LAYOUTS) {
    const outs = [];
    for (const [which, src] of [['baseline', baselineSrc], ['work', workSrc]]) {
      // The SAME absolute tree path for both revisions (APP_ROOT is in the
      // output), rebuilt from scratch, with a fresh HOME at the same path.
      const base = path.join(TMP, 'l1', label.replace(/\W+/g, '-'));
      fs.rmSync(base, { recursive: true, force: true });
      const tree = materialise(path.join(base, ...segs), src);
      prep(tree);
      const home = path.join(base, 'home');
      fs.mkdirSync(home, { recursive: true });
      const r = runProbe(tree, home);
      outs.push(r);
      if (which === 'work' && r.status !== 0) console.log(r.stderr);
    }
    ok(outs[0].status === 0 && outs[1].status === 0, `${label}: both revisions ran`);
    const bundleArmChanged = process.platform === 'win32' && (label === 'macOS .app' || label === 'marker, any path');
    const parsed = JSON.parse(outs[1].stdout || '{}');
    if (!bundleArmChanged) {
      eq(outs[1].stdout, outs[0].stdout, `${label}: every resolver's output is byte-identical to v3.99.3 (${process.platform})`);
      eq(outs[1].stderr, outs[0].stderr, `${label}: the stderr notice is byte-identical too`);
      if (label === 'checkout') ok(parsed.isRepo === true && parsed.userData === parsed.APP_ROOT, '  └─ CONTROL: this layout really is repo mode');
      if (label === 'macOS .app') ok(parsed.isBundle === true, '  └─ CONTROL: this layout really is a bundle (the comparison covers the bundle arm)');
    } else {
      // Intended release change on a real win32 host (see the helpers above).
      console.log(`  · ${label}: win32 HOST — asserting the NEW bundle arm, not byte-identity to v3.99.3 (resolvers the arm does not touch are still compared exactly)`);
      const base = JSON.parse(outs[0].stdout || '{}');
      const problems = label === 'macOS .app'
        ? win32AppShapedProblems(base, parsed, outs[1].stderr)
        : win32MarkerBundleProblems(base, parsed);
      ok(problems.length === 0, `${label}: win32 behaviour is the intended new one${problems.length ? '\n        ' + problems.join('\n        ') : ''}`);
    }
  }
}
// The comparison must be able to fail: a one-character darwin change is seen.
if (baselineSrc && process.platform === 'win32') {
  console.log("  · CONTROL (darwin `.app/Contents` mutation) skipped on a win32 HOST: the bundle arm there ignores that heuristic by design, so the mutation would change nothing");
} else if (baselineSrc) {
  const mutated = workSrc.replace("parts[i + 1] === 'Contents'", "parts[i + 1] === 'contents'");
  ok(mutated !== workSrc, 'CONTROL precondition: the planted mutation applies');
  const base = path.join(TMP, 'l1-control');
  const tree = materialise(path.join(base, 'The Curator.app', 'Contents', 'Resources', 'app'), mutated);
  fs.mkdirSync(path.join(base, 'home'), { recursive: true });
  const r = runProbe(tree, path.join(base, 'home'));
  ok(!JSON.parse(r.stdout).isBundle, 'CONTROL: a planted darwin regression changes the probe output (so §1 is not vacuous)');
}

// CONTROL (every host): the two win32-host comparisons above can fail. Recorded
// outputs shaped like a real win32 probe, then mutated one fact at a time.
{
  const L = 'C:\\Users\\Ana\\AppData\\Local\\TheCurator';
  const mk = (ud, extra = {}) => ({
    APP_ROOT: 'D:\\t\\marked', isRepo: false, isBundle: true, userData: ud, appSupport: L, appSupportWin: L, appSupportWinNoEnv: L,
    logs: L + '\\logs', logsWin: L + '\\logs', launcher: L + '\\bin', consts: ['a'], joined: ud + '\\a\\b',
    getTrashDir: ud + '\\.trash', creds: [{ rel: '.curator-config.json', abs: ud + '\\.curator-config.json' }, { rel: '.env', abs: 'D:\\t\\marked\\.env' }],
    ...extra,
  });
  const keys = DATA_KEYS.filter(k => !['userData', 'joined', 'getTrashDir'].includes(k));
  const fill = (o) => { for (const k of keys) o[k] = o.userData + '\\' + k; return o; };
  const b = fill(mk(L)), good = fill(mk(L + '\\App'));
  ok(win32MarkerBundleProblems(b, good).length === 0, 'CONTROL: recorded intended win32 marker-bundle output passes the comparison');
  const bad1 = fill(mk(L)); // not relocated
  ok(win32MarkerBundleProblems(b, bad1).length > 0, 'CONTROL: a win32 bundle whose data is NOT under \\\\App is flagged');
  const bad2 = fill(mk(L + '\\App')); bad2.logs = L + '\\App\\logs';
  ok(win32MarkerBundleProblems(b, bad2).length > 0, 'CONTROL: logs moving off the shared root is flagged');
  const bad3 = fill(mk(L + '\\App')); bad3.getTrashDir = L + '\\.trash';
  ok(win32MarkerBundleProblems(b, bad3).length > 0, 'CONTROL: one data getter left outside \\\\App is flagged');
  const bad4 = fill(mk(L + '\\App')); bad4.isBundle = false;
  ok(win32MarkerBundleProblems(b, bad4).length > 0, 'CONTROL: the marker no longer making a bundle is flagged');
  const ab = mk(L, { APP_ROOT: 'D:\\t\\The Curator.app\\Contents\\Resources\\app' });
  const aw = mk('D:\\t\\The Curator.app\\Contents\\Resources\\app', { APP_ROOT: ab.APP_ROOT, isBundle: false, isRepo: true });
  ok(win32AppShapedProblems(ab, aw, '').length === 0, 'CONTROL: recorded intended win32 `.app` (repo mode) output passes the comparison');
  ok(win32AppShapedProblems(ab, { ...aw, isBundle: true, isRepo: false }, '').length > 0, 'CONTROL: `.app` still read as a bundle on win32 is flagged');
  ok(win32AppShapedProblems(ab, { ...aw, userData: L }, '').length > 0, 'CONTROL: `.app` user data outside APP_ROOT is flagged');
  ok(win32AppShapedProblems(ab, aw, '[The Curator] Running as a packaged app').length > 0, 'CONTROL: a bundle notice for a `.app` path on win32 is flagged');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2  A Windows bundle resolves every user-data path OUTSIDE the program folder');
// ═══════════════════════════════════════════════════════════════════════════

// A simulated host, in a CHILD process so no seam in this process can leak.
// The values are the realistic ones: a per-user NSIS install with a space and
// a non-ASCII letter in the user name.
const WIN_LOCAL = 'C:\\Users\\Ana Müller\\AppData\\Local';
const WIN_HOME = 'C:\\Users\\Ana Müller';
const WIN_APP_ROOT = WIN_LOCAL + '\\Programs\\The Curator\\resources\\app';

function winProbe(opts = {}) {
  const host = {
    platform: opts.platform || 'win32',
    appRoot: opts.appRoot || WIN_APP_ROOT,
    env: opts.env || { LOCALAPPDATA: WIN_LOCAL },
    homedir: opts.homedir || WIN_HOME,
    marker: opts.marker !== undefined ? opts.marker : true,
  };
  const script = `
    import * as p from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'src/brain/paths.js')).href)};
    import * as im from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'src/brain/install-mode.js')).href)};
    const H = ${JSON.stringify(host)};
    const mkdirs = [], existsAsked = [];
    const sep = H.platform === 'win32' ? '\\\\' : '/';
    p.__setHostForTest({ platform: H.platform, appRoot: H.appRoot, env: H.env, homedir: H.homedir,
      exists: (f) => { existsAsked.push(f); return H.marker && f === H.appRoot + sep + '.curator-bundle'; },
      mkdir: (d, o) => mkdirs.push({ d, mode: o && o.mode }) });
    const getters = {};
    for (const [name, fn] of Object.entries(p)) {
      if (typeof fn !== 'function' || !/^get/.test(name) || fn.length !== 0) continue;
      const v = fn();
      if (typeof v === 'string') getters[name] = v;
    }
    const out = {
      platform: p.getPlatform(), isBundle: p.isBundleInstall(), isRepo: p.isRepoInstall(),
      userData: p.getUserDataDir(), appSupport: p.getAppSupportDir(), bundleData: p.getBundleUserDataDir(),
      logs: p.getLogsDir(), launcher: p.getMcpLauncherDir(), creds: p.getCredentialFiles(),
      joined: p.userDataPath('domains', 'work'), app: p.appPath('mcp', 'server.js'),
      mode: im.getInstallMode(), caps: im.getCapabilities(), described: im.describeInstall(),
      getters, mkdirs, existsAsked,
    };
    p.__setHostForTest(null);
    out.restored = { platform: p.getPlatform(), userData: p.getUserDataDir() };
    process.stdout.write(JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script],
    { env: { ...CLEAN_ENV }, encoding: 'utf8', cwd: TMP });
  if (r.status !== 0) { console.log(r.stderr); return null; }
  return { ...JSON.parse(r.stdout), stderr: r.stderr };
}

/** Case-insensitive, separator-aware "is `child` at or under `parent`" — NTFS semantics. */
function winInside(child, parent) {
  const rel = path.win32.relative(parent.toLowerCase(), child.toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !path.win32.isAbsolute(rel));
}
ok(winInside('C:\\A\\b\\c', 'c:\\a') && !winInside('C:\\A2', 'C:\\A') && winInside('C:\\A', 'C:\\A'),
  'CONTROL: the containment helper is case-insensitive and segment-exact');

const SHARED_ROOT = WIN_LOCAL + '\\TheCurator';
const APP_DATA = SHARED_ROOT + '\\App';
const w = winProbe();
ok(!!w, 'the simulated win32 probe ran');
if (w) {
  eq(w.platform, 'win32', 'the simulated host reports win32');
  ok(w.isBundle === true && w.isRepo === false, 'with the marker at APP_ROOT, a Windows install is a BUNDLE');
  eq(w.userData, APP_DATA, 'user data lives in %LOCALAPPDATA%\\TheCurator\\App (owner decision D1)');
  eq(w.bundleData, APP_DATA, 'getBundleUserDataDir() names the same folder');
  eq(w.appSupport, SHARED_ROOT, 'getAppSupportDir() stays the SHARED root %LOCALAPPDATA%\\TheCurator');
  eq(w.logs, SHARED_ROOT + '\\logs', 'logs\\ stays at the shared root (beside install.ps1\'s server.log)');
  ok(!winInside(w.userData, SHARED_ROOT + '\\runtime'), 'user data is not inside install.ps1\'s runtime\\ folder');
  ok(w.userData !== SHARED_ROOT,
    'user data is NOT the shared root — "delete %LOCALAPPDATA%\\TheCurator\\runtime" or the browser install can never sit beside the app\'s wiki');
  ok(!winInside(w.userData, WIN_APP_ROOT) && !winInside(WIN_APP_ROOT, w.userData),
    'the data dir and the program folder are disjoint (neither contains the other)');

  // EVERY zero-argument string getter the module exports — enumerated, so a
  // getter added later is covered without anyone remembering this list.
  const NOT_USER_DATA = new Set(['getPlatform', 'getAppSupportDir', 'getBundleUserDataDir', 'getLogsDir', 'getMcpLauncherDir',
    'getUserDataDirState']);
  const dataGetters = Object.entries(w.getters).filter(([n]) => !NOT_USER_DATA.has(n));
  ok(dataGetters.length >= 16, `enumerated ${dataGetters.length} user-data getters from the module's exports (anti-vacuity: at least the 16 known today)`);
  for (const name of ['getUserDataDir', 'getCuratorConfigFile', 'getSyncConfigFile', 'getSyncGitDir', 'getSharedBrainConfigFile',
    'getDefaultDomainsDir', 'getTrashDir', 'getHealthUndoDir', 'getIngestQueueDir']) {
    ok(Object.hasOwn(w.getters, name), `  └─ the enumeration includes ${name}`);
  }
  for (const [name, v] of dataGetters) {
    ok(!winInside(v, WIN_APP_ROOT) && winInside(v, APP_DATA),
      `${name}() → outside the program folder, inside TheCurator\\App (${v.slice(SHARED_ROOT.length) || v})`);
  }
  ok(!/\//.test(Object.values(w.getters).join('')), 'every resolved path uses Windows separators only');
  eq(w.joined, APP_DATA + '\\domains\\work', 'userDataPath() joins onto the App folder');
  eq(w.app, WIN_APP_ROOT + '\\mcp\\server.js', 'appPath() stays on the CODE root (the install folder)');

  // The startup chmod sweep list: every credential follows the data dir;
  // only the developer-only .env stays with the code, exactly as on macOS.
  for (const c of w.creds) {
    if (c.rel === '.env') eq(c.abs, WIN_APP_ROOT + '\\.env', 'credential sweep: .env stays on the code root (dotenv, never written by the app)');
    else ok(winInside(c.abs, APP_DATA) && !winInside(c.abs, WIN_APP_ROOT), `credential sweep: ${c.rel} is in TheCurator\\App`);
  }

  // The data dir is created (a bundle has nowhere else to write), once, 0700,
  // and NOTHING is created inside the program folder.
  eq(w.mkdirs.length, 1, 'exactly one directory is created');
  eq(w.mkdirs[0] && w.mkdirs[0].d, APP_DATA, '  └─ and it is the App data folder');
  eq(w.mkdirs[0] && w.mkdirs[0].mode, 0o700, '  └─ with mode 0700 (a no-op on NTFS; %LOCALAPPDATA%\'s per-user ACL is the protection)');
  ok(w.mkdirs.every(m => !winInside(m.d, WIN_APP_ROOT)), 'nothing is created inside the program folder');
  ok(/packaged app/.test(w.stderr) && w.stderr.includes(APP_DATA), 'the relocation is announced on stderr, naming the App folder');

  // The seam undoes itself completely.
  eq(w.restored.platform, process.platform, 'clearing the simulated host restores the real platform');
  ok(w.restored.userData === ROOT || w.restored.userData === path.resolve(ROOT),
    'clearing the simulated host restores the real resolution (this checkout, repo mode)');
}

// LOCALAPPDATA missing or not absolute: the per-user fallback, still outside.
for (const [label, env] of [['unset', {}], ['relative', { LOCALAPPDATA: 'AppData\\Local' }], ['forward-slash', { LOCALAPPDATA: 'C:/x' }]]) {
  const v = winProbe({ env });
  eq(v && v.userData, WIN_HOME + '\\AppData\\Local\\TheCurator\\App',
    `LOCALAPPDATA ${label}: falls back to <home>\\AppData\\Local\\TheCurator\\App`);
}

// The instance registry and the update work dir are rooted at
// getAppSupportDir() by their own modules (instance-probe.js, desktop/main.js);
// this suite pins only that the root they read is the SHARED one. See the
// report for instance-probe's isolation comparison, which is not this file's.

// ═══════════════════════════════════════════════════════════════════════════
section('§3  On Windows the marker is the ONLY bundle signal');
// ═══════════════════════════════════════════════════════════════════════════

const noMarker = winProbe({ marker: false });
ok(noMarker && noMarker.isBundle === false, 'win32 without the marker is NOT a bundle (no layout is ever inferred)');
eq(noMarker && noMarker.mode, 'repo', '  └─ install mode "repo" (the browser install, install.ps1, keeps today\'s behaviour)');
eq(noMarker && noMarker.mkdirs.length, 0, '  └─ and repo mode creates nothing');
ok(noMarker && noMarker.existsAsked.length > 0 && [...new Set(noMarker.existsAsked)].join("|") === WIN_APP_ROOT + "\\.curator-bundle",
  "  └─ the ONLY filesystem question asked is \"is the marker at APP_ROOT?\"");

const appShaped = winProbe({ marker: false, appRoot: 'C:\\Apps\\The Curator.app\\Contents\\Resources\\app' });
ok(appShaped && appShaped.isBundle === false,
  'win32: even a `<X>.app\\Contents` path without the marker is NOT a bundle (the macOS heuristic is never applied on Windows)');
const nsisLike = winProbe({ marker: false, appRoot: WIN_LOCAL + '\\Programs\\The Curator\\resources\\app' });
ok(nsisLike && nsisLike.isBundle === false,
  'win32: the NSIS install path itself proves nothing — only the packager\'s marker does (which is why the Windows afterPack MUST write it)');

// The seam's darwin arm agrees with the real child-process probe of §1.
const mac = winProbe({ platform: 'darwin', appRoot: '/Applications/The Curator.app/Contents/Resources/app',
  env: {}, homedir: '/Users/ana', marker: false });
ok(mac && mac.isBundle === true, 'CROSS-CHECK: the simulated darwin host still infers a bundle from `.app/Contents`');
eq(mac && mac.userData, '/Users/ana/Library/Application Support/The Curator', '  └─ with user data in Application Support, unchanged');
eq(mac && mac.caps.mcpLaunchStyle, 'launcher-script', '  └─ and the macOS launcher-script MCP style, unchanged');

// ═══════════════════════════════════════════════════════════════════════════
section('§4  The marker never exists in the repo, and nothing but the packager names it');
// ═══════════════════════════════════════════════════════════════════════════

const tracked = execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
ok(tracked.length > 500, `listed ${tracked.length} tracked files (anti-vacuity)`);
ok(!tracked.some(f => path.posix.basename(f) === '.curator-bundle'), 'no tracked file is named .curator-bundle');
ok(!fs.existsSync(path.join(ROOT, '.curator-bundle')), 'this checkout has no .curator-bundle at its root');
const paths = await import(pathToFileURL(path.join(ROOT, 'src/brain/paths.js')).href);
eq(paths.isBundleInstall(), false, 'so THIS checkout is a repo install');
eq(paths.BUNDLE_MARKER_FILE, '.curator-bundle', 'the marker name is the agreed constant');

// Who may mention it. The packager (desktop/) writes it; paths.js reads it;
// tests and docs talk about it. Anything else — install.ps1, install.sh,
// scripts/windows/*, scripts/build-app.sh, src/, mcp/, bin/ — naming it is a
// way for a CHECKOUT or the browser install to declare itself a bundle and
// relocate a live wiki (the catastrophic direction, paths.js's docblock).
const MAY_NAME = (f) => f === 'src/brain/paths.js'
  || f.startsWith('desktop/')
  || /^scripts\/test-[^/]+\.(?:js|mjs)$/.test(f)
  || f.startsWith('docs/') || f.endsWith('.md');
const MARKER_RE = /curator-bundle|BUNDLE_MARKER_FILE/;
function offenders(files, readFile) {
  return files.filter(f => !MAY_NAME(f)).filter(f => {
    let s; try { s = readFile(f); } catch { return false; }
    return MARKER_RE.test(s);
  });
}
const readTracked = f => fs.readFileSync(path.join(ROOT, f), 'latin1');
const found = offenders(tracked, readTracked);
eq(found.join(', '), '', 'no file outside desktop/, paths.js, tests and docs names the marker');
for (const must of ['install.ps1', 'install.sh', 'scripts/build-app.sh']) {
  ok(tracked.includes(must) && !MAY_NAME(must), `  └─ ${must} is tracked and IN scope of that scan`);
}
const winScripts = tracked.filter(f => f.startsWith('scripts/windows/'));
ok(winScripts.length >= 3 && winScripts.every(f => !MAY_NAME(f)), `  └─ scripts/windows/* (${winScripts.length} files) are in scope too`);
// CONTROL: the scan really fires on a planted mention, in each risky place.
for (const planted of ['install.ps1', 'scripts/windows/curator-common.ps1', 'src/brain/sync.js']) {
  const hit = offenders([planted], f => (f === planted ? "New-Item (Join-Path $root '.curator-bundle')" : readTracked(f)));
  eq(hit.join(','), planted, `CONTROL: a planted marker write in ${planted} is caught`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5  Capabilities are platform-aware, complete, and only the Windows bundle differs');
// ═══════════════════════════════════════════════════════════════════════════

const im = await import(pathToFileURL(path.join(ROOT, 'src/brain/install-mode.js')).href);
const KEYS = ['canSelfUpdateViaGit', 'canRunNpmInstall', 'canRebuildAppleScriptApp', 'canWriteBesideCode',
  'mcpLaunchStyle', 'restartStyle', 'updateStyle', 'folderPickerStyle'];
const records = im.listCapabilityRecords();
ok(records.length >= 3, `listed ${records.length} capability records (repo, bundle, bundle@win32)`);
for (const r of records) {
  const tag = `${r.mode}${r.platform ? '@' + r.platform : ''}`;
  eq(Object.keys(r.caps).sort().join(','), [...KEYS].sort().join(','), `${tag} carries every capability key and no others`);
  ok(Object.isFrozen(r.caps), `${tag} is frozen`);
  if (r.mode === 'bundle') {
    eq(r.caps.canSelfUpdateViaGit, false, `${tag}: the git self-update path is OFF`);
    eq(r.caps.updateStyle, 'download-installer', `${tag}: the installer update path is ON`);
  }
}

// Transcribed, never read back from the module.
const WIN_BUNDLE = { canSelfUpdateViaGit: false, canRunNpmInstall: false, canRebuildAppleScriptApp: false,
  canWriteBesideCode: false, mcpLaunchStyle: 'app-binary', restartStyle: 'app-relaunch',
  updateStyle: 'download-installer', folderPickerStyle: 'native-dialog' };
eq(JSON.stringify(im.getCapabilities('bundle', 'win32')), JSON.stringify(WIN_BUNDLE),
  'bundle on win32 is exactly the transcribed record (mcpLaunchStyle: app-binary)');
const diff = KEYS.filter(k => im.getCapabilities('bundle', 'win32')[k] !== im.getCapabilities('bundle', 'darwin')[k]);
eq(diff.join(','), 'mcpLaunchStyle', 'the Windows bundle differs from the macOS bundle in mcpLaunchStyle ONLY');
eq(im.getCapabilities('bundle', 'darwin').mcpLaunchStyle, 'launcher-script', 'bundle on darwin keeps launcher-script');
eq(im.getCapabilities('bundle', 'linux').mcpLaunchStyle, 'launcher-script', 'bundle on linux keeps launcher-script');
ok(im.getCapabilities('repo', 'win32') === im.getCapabilities('repo', 'darwin'),
  'repo on win32 is the SAME record as on darwin (the browser install keeps node-script)');
for (const odd of ['freebsd', '__proto__', 'constructor', 'hasOwnProperty', '', undefined]) {
  ok(im.getCapabilities('bundle', odd) === im.getCapabilities('bundle', 'darwin'),
    `an unknown platform ${JSON.stringify(odd)} gets the base bundle record (no prototype lookup)`);
}
for (const proto of ['constructor', '__proto__', 'toString']) {
  let threw = null;
  try { im.getCapabilities(proto, 'win32'); } catch (e) { threw = e; }
  ok(threw && /unknown install mode/.test(threw.message), `a prototype key as the MODE (${proto}) throws, never returns Object's members`);
}
eq(im.describeInstall('bundle', 'win32').capabilities.mcpLaunchStyle, 'app-binary', 'describeInstall honours the platform');
eq(im.getCapabilities('bundle').mcpLaunchStyle, process.platform === 'win32' ? 'app-binary' : 'launcher-script',
  'with no platform argument, the real host platform is used');
if (w) {
  eq(w.mode, 'bundle', 'simulated win32 bundle: getInstallMode() is "bundle"');
  eq(JSON.stringify(w.caps), JSON.stringify(WIN_BUNDLE), 'simulated win32 bundle: getCapabilities() defaults to the win32 record');
  eq(w.described.capabilities.mcpLaunchStyle, 'app-binary', 'simulated win32 bundle: describeInstall() (GET /api/version) reports app-binary');
}
eq(noMarker && noMarker.caps.mcpLaunchStyle, 'node-script', 'simulated win32 WITHOUT the marker: node-script, unchanged');

// ── Cleanup + report ────────────────────────────────────────────────────────
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log('\nNot provable here (a simulated host is not Windows): the marker present in the real');
console.log('NSIS payload and unpacked tree; %LOCALAPPDATA% on a real account (OneDrive, non-ASCII');
console.log('names); the data folder surviving an update and an uninstall. These are CI/PC checks.');
console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ Windows bundle identity assertions green');
