/**
 * test-linux-folder-picker.js — OFFLINE (v3.88.2). "Use existing folder" on Linux.
 *
 * Pins src/brain/linux-folder-dialog.js and its wiring into pick-folder and
 * pick-path: zenity → kdialog → yad by absolute path, argv only (no shell),
 * skipped with no display, a ten-minute timeout that kills the child and reads
 * as a cancel, UTF-8 paths, cancel = exit 1 with no output, no tool → the 501
 * `no-dialog` shape, never the macOS hint off darwin, darwin/win32 unchanged.
 * No dialog opens anywhere: execFile is faked; §2's child is a tiny script.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'curator-linuxpick-')));
process.env.CURATOR_TEST_USER_DATA_DIR = path.join(tmp, 'user');
process.env.CURATOR_TEST_DOMAINS_DIR = path.join(tmp, 'domains');
process.env.CURATOR_TEST_LOG_DIR = path.join(tmp, 'logs');
for (const d of ['user', 'domains', 'logs']) fs.mkdirSync(path.join(tmp, d), { recursive: true });

let passed = 0, failed = 0;
function ok(cond, label) { if (cond) { passed++; console.log(`  ✓ ${label}`); } else { failed++; console.log(`  ✗ ${label}`); } }
function eq(a, b, label) {
  const same = JSON.stringify(a) === JSON.stringify(b);
  ok(same, same ? label : `${label}\n      expected ${JSON.stringify(b)}\n      actual   ${JSON.stringify(a)}`);
}
function section(t) { console.log(`\n${t}`); }
function fakeRes() {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

const lfd = await import(path.join(ROOT, 'src/brain/linux-folder-dialog.js'));
const configRoute = await import(path.join(ROOT, 'src/routes/config.js'));

const ENV = { DISPLAY: ':0', PATH: '/usr/bin' };
const NO_MSG = 'This computer has no folder dialog The Curator can open — paste the folder\'s full path instead.';
// fake execFile: answers per tool basename.
function fakeExec(answers) {
  const calls = [];
  const fn = (file, args, opts, cb) => {
    calls.push({ file, args, opts });
    const a = answers[path.basename(file)] || {};
    setImmediate(() => cb(a.err || null, a.stdout || '', a.stderr || ''));
    return {};
  };
  fn.calls = calls;
  return fn;
}
const finder = (have) => (n) => (have.includes(n) ? '/usr/bin/' + n : null);
const run = (answers, have, extra = {}) => {
  const ex = fakeExec(answers);
  return lfd.pickFolderLinux({ prompt: 'Select your Knowledge Base folder:' },
    { execFile: ex, env: ENV, findOnPath: finder(have), home: '/home/ana', ...extra })
    .then((r) => ({ r, ex }));
};
const exit = (code, extra = {}) => Object.assign(new Error('exit ' + code), { code }, extra);

section('§1  zenity, kdialog, yad: argv, order, results');
{
  const ZP = '/home/Žiga/Znanje — wiki';
  const a = await run({ zenity: { stdout: ZP + '\n' } }, ['zenity', 'kdialog', 'yad']);
  eq(a.r, { kind: 'picked', path: ZP }, 'zenity found and picked: the non-ASCII path survives, trailing newline trimmed');
  eq(a.ex.calls.length, 1, 'only zenity ran');
  eq([a.ex.calls[0].file, a.ex.calls[0].args],
    ['/usr/bin/zenity', ['--file-selection', '--directory', '--title=Select your Knowledge Base folder:']],
    'zenity: absolute path, argv array');
  ok(!a.ex.calls[0].opts.shell, 'no shell');
  eq([a.ex.calls[0].opts.timeout, a.ex.calls[0].opts.killSignal, a.ex.calls[0].opts.encoding],
    [600000, 'SIGKILL', 'utf8'], 'ten-minute timeout, SIGKILL, utf8');

  const c = await run({ zenity: { err: exit(1) } }, ['zenity', 'kdialog']);
  eq(c.r, { kind: 'cancelled' }, 'zenity cancel (exit 1, no output) → cancelled');
  eq(c.ex.calls.length, 1, 'a cancel does not fall through to the next tool');

  const k = await run({ kdialog: { stdout: '/home/ana/kb\n' } }, ['kdialog', 'yad']);
  eq(k.r, { kind: 'picked', path: '/home/ana/kb' }, 'zenity absent, kdialog picked');
  eq(k.ex.calls[0].args, ['--getexistingdirectory', '/home/ana', '--title', 'Select your Knowledge Base folder:'],
    'kdialog argv: --getexistingdirectory <home> --title <prompt>');

  const y = await run({ yad: { stdout: '/srv/kb\n' } }, ['yad']);
  eq([y.r, y.ex.calls[0].args], [{ kind: 'picked', path: '/srv/kb' }, ['--file-selection', '--directory', '--title=Select your Knowledge Base folder:']],
    'only yad present: yad picked, its argv');

  const sk = await run({ zenity: { err: exit('ENOENT') }, kdialog: { stdout: '/k\n' } }, ['zenity', 'kdialog']);
  eq([sk.r.kind, sk.ex.calls.length], ['picked', 2], 'a tool that cannot start (ENOENT) is skipped for the next');

  const none = await run({}, []);
  eq([none.r, none.ex.calls.length], [{ kind: 'unavailable', message: NO_MSG }, 0], 'no tool on PATH → unavailable, nothing spawned');

  const nd = await run({ zenity: { stdout: '/x\n' } }, ['zenity'], { env: { PATH: '/usr/bin' } });
  eq([nd.r.kind, nd.ex.calls.length], ['unavailable', 0], 'no DISPLAY and no WAYLAND_DISPLAY → no spawn');
  const wl = await run({ zenity: { stdout: '/x\n' } }, ['zenity'], { env: { WAYLAND_DISPLAY: 'wayland-0', PATH: '/usr/bin' } });
  eq(wl.r.kind, 'picked', 'WAYLAND_DISPLAY alone is enough');

  const bad = await run({ zenity: { err: exit(1), stderr: 'Gtk-WARNING: cannot open display: ' } }, ['zenity']);
  eq(bad.r.kind, 'failed', 'exit 1 with "cannot open display" is a failure, not a cancel');
  const odd = await run({ zenity: { err: exit(5), stderr: 'broke' } }, ['zenity']);
  eq(odd.r, { kind: 'failed', message: 'broke' }, 'another exit code → failed with its stderr');
  const to = await run({ zenity: { err: exit(null, { killed: true }) } }, ['zenity']);
  eq(to.r, { kind: 'cancelled', timedOut: true }, 'a killed (timed-out) child reads as a cancel');
}

section('§2  A REAL timeout kill, and a real PATH lookup');
{
  const bin = path.join(tmp, 'bin'); fs.mkdirSync(bin);
  const fake = path.join(bin, 'zenity');
  fs.writeFileSync(fake, `#!${process.execPath}\nsetTimeout(()=>{}, 60000);\n`); fs.chmodSync(fake, 0o755);
  const t0 = Date.now();
  const r = await lfd.pickFolderLinux({ prompt: 'p' }, { env: ENV, findOnPath: () => null, timeoutMs: 300 });
  eq(r.kind, 'unavailable', 'CONTROL: nothing found → unavailable');
  const r2 = await lfd.pickFolderLinux({ prompt: 'p' }, { env: ENV, findOnPath: (n) => (n === 'zenity' ? fake : null), timeoutMs: 300 });
  eq(r2, { kind: 'cancelled', timedOut: true }, 'a real child left open is killed by the timeout and read as a cancel');
  ok(Date.now() - t0 < 10000, 'the kill was prompt (not a 60 s wait)');

  eq(lfd.findOnPath('zenity', bin), fake, 'findOnPath: an absolute PATH entry holding an executable file');
  const here = process.cwd();
  process.chdir(tmp); // so 'bin', './bin' and '' REALLY resolve to the planted binary
  eq(lfd.findOnPath('zenity', ['', '.', 'bin', './bin'].join(path.delimiter)), null, 'findOnPath: empty and relative entries are never searched (even when they would resolve to a planted binary)');
  process.chdir(here);
  const noexec = path.join(bin, 'yad'); fs.writeFileSync(noexec, 'x'); fs.chmodSync(noexec, 0o644);
  eq(lfd.findOnPath('yad', bin), null, 'findOnPath: a non-executable file is skipped');
  fs.mkdirSync(path.join(bin, 'kdialog'));
  eq(lfd.findOnPath('kdialog', bin), null, 'findOnPath: a directory is skipped');
}

section('§3  The routes on linux (and darwin / win32 unchanged)');
async function pick(handler, platform, lin, extra = {}, body = {}) {
  const log = { exec: 0, set: [], lin: [], win: [] };
  const res = fakeRes();
  const deps = {
    caps: { folderPickerStyle: 'osascript' },
    execAsync: async () => { log.exec++; return { stdout: '/Users/x/kb\n', stderr: '' }; },
    existsSync: () => true, hasActiveWrites: () => false,
    setDomainsDir: (p) => { log.set.push(p); },
    pickFolderHook: null, platform,
    pickFolderWin32: async (o) => { log.win.push(o); return { kind: 'picked', path: 'C:\\w' }; },
    ...extra,
  };
  if (lin !== undefined) deps.pickFolderLinux = async (o) => { log.lin.push(o); return lin; };
  await handler({ body }, res, deps);
  return { res, log };
}
{
  const P = '/home/Ana Žagar/my wiki';
  const a = await pick(configRoute.pickFolderHandler, 'linux', { kind: 'picked', path: P + '\n' });
  eq([a.res.statusCode, a.res.body, a.log.set, a.log.exec], [200, { ok: true, path: P }, [P], 0], 'pick-folder linux: applied through accept(); osascript never runs');
  eq(a.log.lin[0].prompt, 'Select your Knowledge Base folder:', 'pick-folder linux: the server\'s own prompt');
  const gone = await pick(configRoute.pickFolderHandler, 'linux', { kind: 'picked', path: P }, { existsSync: () => false });
  eq([gone.res.statusCode, gone.log.set.length], [400, 0], 'pick-folder linux: a missing folder → 400, nothing applied');
  const busy = await pick(configRoute.pickFolderHandler, 'linux', { kind: 'picked', path: P }, { hasActiveWrites: () => true });
  eq([busy.res.statusCode, busy.log.set.length], [409, 0], 'pick-folder linux: a write in flight → 409');
  const c = await pick(configRoute.pickFolderHandler, 'linux', { kind: 'cancelled' });
  eq(c.res.body, { cancelled: true }, 'pick-folder linux: cancel');
  const un = await pick(configRoute.pickFolderHandler, 'linux', { kind: 'unavailable', message: 'x' });
  eq([un.res.statusCode, un.res.body.reason, un.res.body.error], [501, 'no-dialog', NO_MSG], 'pick-folder linux: no dialog → 501 no-dialog with the paste message');
  const fl = await pick(configRoute.pickFolderHandler, 'linux', { kind: 'failed', message: 'boom' });
  eq([fl.res.statusCode, fl.res.body.reason, fl.res.body.error], [500, 'failed', 'boom'], 'pick-folder linux: failure → 500');

  const pp = await pick(configRoute.pickPathHandler, 'linux', { kind: 'picked', path: P }, {}, { prompt: 'foundations' });
  eq([pp.res.body, pp.log.set.length, pp.log.lin[0].prompt], [{ ok: true, path: P }, 0, 'Choose the folder that holds this project’s documents:'], 'pick-path linux: only the path, nothing applied, prompt is a server literal');
  const ev = await pick(configRoute.pickPathHandler, 'linux', { kind: 'cancelled' }, {}, { prompt: '--x"; rm -rf /' });
  eq([ev.res.body, ev.log.lin[0].prompt], [{ ok: false, reason: 'cancelled' }, 'Choose a folder:'], 'pick-path linux: client text never reaches the dialog; cancel');
  const pu = await pick(configRoute.pickPathHandler, 'linux', { kind: 'unavailable' });
  eq([pu.res.statusCode, pu.res.body.reason, pu.res.body.message], [501, 'no-dialog', NO_MSG], 'pick-path linux: 501 no-dialog');
  const pf = await pick(configRoute.pickPathHandler, 'linux', { kind: 'failed', message: 'bad' });
  eq([pf.res.statusCode, pf.res.body.reason], [500, 'failed'], 'pick-path linux: failed');

  for (const r of [un, fl, pu, pf, c]) {
    ok(!/System Settings|Privacy|macOS|osascript/i.test(JSON.stringify(r.res.body)), 'no macOS text in a linux answer');
  }

  const d = await pick(configRoute.pickFolderHandler, 'darwin', { kind: 'picked', path: 'NEVER' });
  eq([d.res.body, d.log.exec, d.log.lin.length, d.log.win.length], [{ ok: true, path: '/Users/x/kb' }, 1, 0, 0], 'pick-folder darwin: osascript, unchanged');
  const dp = await pick(configRoute.pickPathHandler, 'darwin', { kind: 'picked', path: 'NEVER' }, {}, { prompt: 'foundations' });
  eq([dp.res.body, dp.log.exec, dp.log.lin.length], [{ ok: true, path: '/Users/x/kb' }, 1, 0], 'pick-path darwin: unchanged');
  const dm = await pick(configRoute.pickFolderHandler, 'darwin', undefined, { execAsync: async () => { throw Object.assign(new Error('e'), { code: 2, stderr: 'weird' }); } });
  ok(/System Settings > Privacy/.test(dm.res.body.hint || ''), 'darwin keeps its macOS hint');
  const w = await pick(configRoute.pickFolderHandler, 'win32', { kind: 'NEVER' });
  eq([w.res.body, w.log.win.length, w.log.lin.length, w.log.set], [{ ok: true, path: 'C:\\w' }, 1, 0, ['C:\\w']], 'pick-folder win32: the Windows dialog, unchanged');
  const wp = await pick(configRoute.pickPathHandler, 'win32', { kind: 'NEVER' });
  eq([wp.res.body, wp.log.lin.length], [{ ok: true, path: 'C:\\w' }, 0], 'pick-path win32: unchanged');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
