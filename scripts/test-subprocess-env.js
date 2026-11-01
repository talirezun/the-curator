/**
 * test-subprocess-env.js — OFFLINE. v3.87.0: the subprocesses a Windows
 * one-line install starts (git, npm, the browser, the restart replacement),
 * and the macOS behaviour proven UNCHANGED.
 *
 *   §1  macOS / Linux PATH is BYTE-IDENTICAL to the pre-v3.87.0 expression,
 *       transcribed here as a literal (never read back out of the file under
 *       test), on synthetic inputs AND on this machine's live process.
 *   §2  Windows PATH: ';'-joined, node folder first, no POSIX folders, the
 *       existing key's spelling kept, never a Path/PATH pair in the child env.
 *   §3  Browser open per platform, argv only; CURATOR_NO_OPEN always wins.
 *   §4  The real /api/restart handler (extracted, compiled against fakes):
 *       spawn options identical off Windows, windowsHide on Windows.
 *   §5  The updater (the REAL updateHandler through its deps seam — nothing
 *       runs): build-app.sh off Windows only, and its exec env IS the helper's.
 *   §6  The folder pickers refuse on Windows without running osascript.
 *   §7  The two reveal routes are macOS-only.
 *
 * Isolation: CURATOR_TEST_USER_DATA_DIR, CURATOR_TEST_DOMAINS_DIR and
 * CURATOR_TEST_LOG_DIR point at fresh tempdirs before any app module loads.
 * No real exec, spawn, dialog or Finder window happens anywhere in this file.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curator-subproc-env-'));
process.env.CURATOR_TEST_USER_DATA_DIR = path.join(tmp, 'user');
process.env.CURATOR_TEST_DOMAINS_DIR = path.join(tmp, 'domains');
process.env.CURATOR_TEST_LOG_DIR = path.join(tmp, 'logs');
for (const d of ['user', 'domains', 'logs']) fs.mkdirSync(path.join(tmp, d), { recursive: true });

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(a, b, label) {
  const same = JSON.stringify(a) === JSON.stringify(b);
  ok(same, same ? label : `${label}\n      expected ${JSON.stringify(b)}\n      actual   ${JSON.stringify(a)}`);
}
function section(t) { console.log(`\n${t}`); }

const se = await import(path.join(ROOT, 'src/brain/subprocess-env.js'));

// ── The pre-v3.87.0 expression, TRANSCRIBED (sync.js:107-112 and
//    config.js:258-268 at v3.86.0 built exactly this, with `path` = posix). ──
function legacyPath(execPath, envPATH) {
  return [
    path.posix.dirname(execPath), '/usr/local/bin', '/opt/homebrew/bin',
    '/usr/bin', '/bin', '/usr/sbin', '/sbin',
    envPATH || '',
  ].filter(Boolean).join(':');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§1  macOS and Linux: the PATH string is byte-identical to v3.86.0');
// ═══════════════════════════════════════════════════════════════════════════
const POSIX_CASES = [
  { execPath: '/usr/local/bin/node', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
  { execPath: '/opt/homebrew/Cellar/node/22.1.0/bin/node', PATH: '' },
  { execPath: '/Users/a b/.nvm/versions/node/v22/bin/node', PATH: undefined },
  { execPath: '/x/node', PATH: '/x:/y:C:odd' },
];
for (const platform of ['darwin', 'linux']) {
  for (const c of POSIX_CASES) {
    const env = c.PATH === undefined ? { HOME: '/h' } : { HOME: '/h', PATH: c.PATH };
    const got = se.buildSubprocessPath({ platform, env, execPath: c.execPath });
    eq(got, legacyPath(c.execPath, c.PATH), `${platform}: PATH for ${c.execPath} / ${JSON.stringify(c.PATH)}`);
    eq(se.buildSubprocessEnv({ platform, env, execPath: c.execPath }), { ...env, PATH: legacyPath(c.execPath, c.PATH) },
      `${platform}: the env is { ...env, PATH } exactly`);
  }
}
// The live process — what sync.js and config.js actually build on this Mac.
if (process.platform !== 'win32') {
  eq(se.buildSubprocessPath(), legacyPath(process.execPath, process.env.PATH),
    'LIVE: on this machine the default PATH is byte-identical to the v3.86.0 expression');
  const liveEnv = se.buildSubprocessEnv();
  eq(Object.keys(liveEnv).sort(), Object.keys({ ...process.env, PATH: '' }).sort(),
    'LIVE: the env carries exactly the inherited keys (plus PATH)');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2  Windows: delimiter, no POSIX folders, one PATH key with its own spelling');
// ═══════════════════════════════════════════════════════════════════════════
const WIN_NODE = 'C:\\Users\\Ana Žagar\\AppData\\Local\\TheCurator\\runtime\\node\\node.exe';
const WIN_NODE_DIR = 'C:\\Users\\Ana Žagar\\AppData\\Local\\TheCurator\\runtime\\node';
{
  const env = { Path: 'C:\\Windows\\system32;C:\\Windows', SystemRoot: 'C:\\Windows', Foo: 'bar' };
  const p = se.buildSubprocessPath({ platform: 'win32', env, execPath: WIN_NODE });
  eq(p, `${WIN_NODE_DIR};C:\\Windows\\system32;C:\\Windows`, 'win32: node folder first, then the inherited Path, joined with ";"');
  ok(!/\/usr|\/bin|\/sbin|homebrew/.test(p), 'win32: no POSIX folder is added');
  eq(p.split(';').length, 3, 'win32: splitting on ";" gives the three real entries (":" would have split C:\\ apart)');
  const e = se.buildSubprocessEnv({ platform: 'win32', env, execPath: WIN_NODE });
  const pathKeys = Object.keys(e).filter((k) => k.toUpperCase() === 'PATH');
  eq(pathKeys, ['Path'], 'win32: the child env has ONE path key, spelled "Path" as inherited');
  eq(e.Path, p, 'win32: and it carries the built value');
  eq([e.Foo, e.SystemRoot], ['bar', 'C:\\Windows'], 'win32: every other variable is kept');
  eq(env.Path, 'C:\\Windows\\system32;C:\\Windows', 'win32: the caller\'s env object is not mutated');
}
{
  // A plain object (not Windows' case-insensitive process.env) can hold both.
  const env = { Path: 'C:\\a', PATH: 'C:\\b', X: '1' };
  const e = se.buildSubprocessEnv({ platform: 'win32', env, execPath: WIN_NODE });
  eq(Object.keys(e).filter((k) => k.toUpperCase() === 'PATH'), ['Path'], 'win32: a Path/PATH pair collapses to the first spelling');
  eq(e.Path, `${WIN_NODE_DIR};C:\\a`, 'win32: ...whose value is the one extended');
}
{
  const e = se.buildSubprocessEnv({ platform: 'win32', env: { PATH: 'C:\\only' }, execPath: WIN_NODE });
  eq(Object.keys(e), ['PATH'], 'win32: an env spelled "PATH" keeps "PATH" (no second "Path")');
  const none = se.buildSubprocessEnv({ platform: 'win32', env: { X: '1' }, execPath: WIN_NODE });
  eq(none, { X: '1', Path: WIN_NODE_DIR }, 'win32: no PATH at all → one "Path" with the node folder');
}
eq(se.pathKeyOf({ Path: 'x' }, 'darwin'), 'PATH', 'off Windows the key is always "PATH"');

// ═══════════════════════════════════════════════════════════════════════════
section('§3  Browser open: per platform, argv only, CURATOR_NO_OPEN wins');
// ═══════════════════════════════════════════════════════════════════════════
const URL_ = 'http://localhost:3333';
eq(se.planBrowserOpen({ url: URL_, platform: 'darwin', env: {} }), { file: 'open', args: [URL_] }, 'darwin: open <url>');
eq(se.planBrowserOpen({ url: URL_, platform: 'linux', env: {} }), { file: 'xdg-open', args: [URL_] }, 'linux: xdg-open <url>');
{
  const w = se.planBrowserOpen({ url: URL_, platform: 'win32', env: { SystemRoot: 'D:\\Win' } });
  eq(w && w.file, 'D:\\Win\\System32\\rundll32.exe', 'win32: rundll32 by ABSOLUTE path under %SystemRoot% (no cmd.exe)');
  eq(w && w.args, ['url.dll,FileProtocolHandler', URL_], 'win32: the URL is one argv element');
  eq(w && w.options && w.options.windowsHide, true, 'win32: hidden');
  const fallback = se.planBrowserOpen({ url: URL_, platform: 'win32', env: {} });
  eq(fallback && fallback.file, 'C:\\Windows\\System32\\rundll32.exe', 'win32: no SystemRoot → C:\\Windows');
}
for (const platform of ['darwin', 'win32', 'linux']) {
  eq(se.planBrowserOpen({ url: URL_, platform, env: { CURATOR_NO_OPEN: '1' } }), null, `${platform}: CURATOR_NO_OPEN wins`);
  eq(se.planBrowserOpen({ url: 'http://localhost:3333&calc', platform, env: {} }), null, `${platform}: a URL that is not localhost:<digits> is not opened`);
}
eq(se.planBrowserOpen({ url: URL_, platform: 'aix', env: {} }), null, 'an unknown platform opens nothing');

// ═══════════════════════════════════════════════════════════════════════════
section('§4  Restart spawn options');
// ═══════════════════════════════════════════════════════════════════════════
// The REAL `/api/restart` handler, brace-extracted from src/server.js (the
// method test-install-mode.js §5c uses) and compiled against fakes, so the
// platform can be driven. Nothing is spawned and nothing exits.
function braceSlice(src, fromIdx) {
  let i = src.indexOf('{', fromIdx), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(fromIdx, i + 1); }
  }
  return null;
}
const serverSrc = fs.readFileSync(path.join(ROOT, 'src/server.js'), 'utf8');
const restartAt = serverSrc.indexOf("app.post('/api/restart'");
const restartBody = restartAt === -1 ? null : braceSlice(serverSrc, serverSrc.indexOf('(_req, res) => {', restartAt));
ok(!!restartBody, 'extracted the /api/restart handler from src/server.js');
function runRestart(platform, env) {
  const spawns = [];
  // eslint-disable-next-line no-new-func
  const make = new Function(
    'hasActiveWrites', 'conflictResponse', 'logInfo', 'logWarn', 'logError',
    'spawn', 'path', 'PROJECT_ROOT', 'process', 'server', 'setTimeout', 'planRestart',
    `return function restartRoute(_req, res) ${restartBody.slice(restartBody.indexOf('{'))};`,
  );
  const fn = make(
    () => false, () => ({}), () => {}, () => {}, () => {},
    (bin, args, opts) => { spawns.push({ bin, args, opts }); return { unref() {} }; },
    { join: (...p) => p.join('/') }, '/APP',
    { execPath: '/opt/node', env, platform, exit: () => {} },
    { closeAllConnections() {}, close() {} },
    (cb) => { cb(); return 0; },
    () => ({ ok: true, style: 'respawn-node', body: { ok: true, restarting: true } }),
  );
  fn({}, fakeRes());
  return spawns;
}
{
  const env = { PATH: '/usr/bin', A: '1' };
  // The literal src/server.js passed at v3.86.0, transcribed.
  const legacy = { cwd: '/APP', detached: true, stdio: 'ignore', env: { ...env, CURATOR_NO_OPEN: '1' } };
  for (const platform of ['darwin', 'linux']) {
    const s = runRestart(platform, env);
    eq(s.length, 1, `${platform}: one replacement spawned`);
    eq(s[0] && s[0].opts, legacy, `${platform}: spawn options identical to the v3.86.0 literal`);
    ok(s[0] && !('windowsHide' in s[0].opts), `${platform}: no windowsHide key`);
  }
  const wenv = { Path: 'C:\\rt\\node;C:\\rt\\git\\cmd;C:\\Windows', LOCALAPPDATA: 'C:\\L' };
  const w = runRestart('win32', wenv)[0];
  eq(w && [w.bin, w.args[0]], ['/opt/node', '/APP/src/server.js'], 'win32: process.execPath with the server entry');
  eq(w && [w.opts.windowsHide, w.opts.detached, w.opts.stdio], [true, true, 'ignore'], 'win32: hidden, detached, stdio ignored');
  eq(w && w.opts.env, { ...wenv, CURATOR_NO_OPEN: '1' }, 'win32: the env (with the private runtime PATH) is kept, plus CURATOR_NO_OPEN');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5  The updater: build-app.sh off Windows only; exec env is the helper\'s');
// ═══════════════════════════════════════════════════════════════════════════
const configRoute = await import(path.join(ROOT, 'src/routes/config.js'));
function fakeRes() {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}
async function runUpdate(platform) {
  const calls = [];
  const execAsync = async (cmd, opts) => {
    calls.push({ cmd, env: opts && opts.env });
    if (/rev-parse/.test(cmd)) return { stdout: 'abc1234def\n', stderr: '' };
    return { stdout: '', stderr: '' };
  };
  const res = fakeRes();
  const deps = {
    caps: { canSelfUpdateViaGit: true, canRunNpmInstall: true, updateStyle: 'git-pull' },
    execAsync, releaseRef: { channel: 'stable', branch: 'main' },
  };
  if (platform) deps.platform = platform;
  await configRoute.updateHandler({}, res, deps);
  return { calls, res };
}
const EXPECTED_COMMON = [
  'git --version', 'git fetch origin main', 'git rev-parse HEAD',
  'git reset --hard origin/main', 'git rev-parse HEAD',
  'npm install --silent --no-audit --no-fund',
];
{
  const mac = await runUpdate('darwin');
  eq(mac.calls.map((c) => c.cmd), [...EXPECTED_COMMON, 'bash scripts/build-app.sh'], 'darwin: the seven commands, build-app.sh last');
  eq(mac.res.body && mac.res.body.ok, true, 'darwin: ok');
  const win = await runUpdate('win32');
  eq(win.calls.map((c) => c.cmd), EXPECTED_COMMON, 'win32: the same six, and NO build-app.sh');
  eq([win.res.statusCode, win.res.body && win.res.body.ok, win.res.body && win.res.body.restarting], [200, true, true],
    'win32: the update still succeeds and asks for the restart');
  const dflt = await runUpdate(null);
  if (process.platform !== 'win32') {
    eq(dflt.calls.length, 7, 'no platform injected: this Mac runs build-app.sh as before');
  }
  ok(mac.calls.every((c) => c.env && c.env.PATH === se.buildSubprocessPath()),
    'every updater command runs with the PATH subprocess-env.js builds (config.js uses the helper)');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§6  Folder pickers on Windows: a clear refusal, no osascript');
// ═══════════════════════════════════════════════════════════════════════════
async function runPick(handler, platform, body = {}) {
  let execs = 0, set = 0;
  const res = fakeRes();
  const deps = {
    caps: { folderPickerStyle: 'osascript' },
    execAsync: async () => { execs++; return { stdout: '/Users/x/kb\n', stderr: '' }; },
    existsSync: () => true,
    hasActiveWrites: () => false,
    setDomainsDir: () => { set++; },
    pickFolderHook: null,
  };
  if (platform) deps.platform = platform;
  await handler({ body }, res, deps);
  return { res, execs, set };
}
{
  const w = await runPick(configRoute.pickFolderHandler, 'win32');
  eq(w.res.statusCode, 501, 'pick-folder win32: 501 (domains.js renders it as "cannot open a folder picker")');
  eq(w.execs, 0, 'pick-folder win32: osascript is never run');
  eq(w.set, 0, 'pick-folder win32: the knowledge folder is not changed');
  ok(!('cancelled' in (w.res.body || {})), 'pick-folder win32: no `cancelled` field (the frontend reads that first)');
  ok(/DOMAINS_PATH/.test(w.res.body.error) && /\.env/.test(w.res.body.error),
    'pick-folder win32: `error` itself carries the remedy (Settings shows only that field)');
  const m = await runPick(configRoute.pickFolderHandler, 'darwin');
  eq([m.res.statusCode, m.execs, m.set, m.res.body && m.res.body.path], [200, 1, 1, '/Users/x/kb'],
    'pick-folder darwin CONTROL: osascript runs once and the folder is applied, as before');
  const pw = await runPick(configRoute.pickPathHandler, 'win32', { prompt: 'foundations' });
  eq([pw.res.statusCode, pw.res.body.reason, pw.execs], [501, 'no-dialog', 0], 'pick-path win32: the no-dialog fact, nothing run');
  const pm = await runPick(configRoute.pickPathHandler, 'darwin', { prompt: 'foundations' });
  eq([pm.res.statusCode, pm.res.body.ok, pm.execs], [200, true, 1], 'pick-path darwin CONTROL: unchanged');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§7  Reveal routes are macOS-only');
// ═══════════════════════════════════════════════════════════════════════════
const mcpRoute = await import(path.join(ROOT, 'src/routes/mcp.js'));
const diagRoute = await import(path.join(ROOT, 'src/routes/diagnostics.js'));
async function runReveal(handler, platform) {
  const spawned = [];
  const res = fakeRes();
  const fakeExecFile = (file, args, cb) => { spawned.push([file, ...args]); cb(null); };
  await new Promise((resolve) => {
    const orig = res.json;
    res.json = (b) => { orig(b); resolve(); return res; };
    handler({}, res, { platform, execFile: fakeExecFile });
  });
  return { res, spawned };
}
for (const [name, handler] of [['reveal-config', mcpRoute.revealConfigHandler], ['reveal-log', diagRoute.revealLogHandler]]) {
  ok(typeof handler === 'function', `${name}: handler exported`);
  for (const platform of ['win32', 'linux']) {
    const r = await runReveal(handler, platform);
    eq([r.res.statusCode, r.spawned.length, r.res.body.ok], [501, 0, false], `${name} ${platform}: 501 and nothing spawned`);
    ok(/only supported on macOS/.test(r.res.body.error || ''), `${name} ${platform}: says so in words`);
  }
  const d = await runReveal(handler, 'darwin');
  eq([d.res.statusCode, d.spawned.length, d.spawned[0] && d.spawned[0][0]], [200, 1, 'open'], `${name} darwin CONTROL: open runs once`);
}
{
  const r = await runReveal(diagRoute.revealLogHandler, 'win32');
  ok(typeof r.res.body.path === 'string' && r.res.body.error.includes(r.res.body.path),
    'reveal-log win32: the refusal names the log file so it can be opened by hand');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
