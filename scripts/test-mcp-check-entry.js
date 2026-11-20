#!/usr/bin/env node
/**
 * test-mcp-check-entry.js — v3.89.0. POST /api/mcp/install/check-entry and
 * src/brain/mcp-check-entry.js: "Check entry" starts the EXACT command an
 * agent app's config file names — a command taken from ANOTHER APP'S FILE —
 * so this suite exists to prove that nothing else can ever be run.
 *
 *   §1 vetEntry — the rule (docs/dev/decisions-app.md § Security): only this
 *      app's own launcher with no args, or an ABSOLUTE node whose args are
 *      exactly THIS install's mcp/server.js [+ --domains-path <abs>]. Refused,
 *      without running: a bare or relative command, any other binary (sh,
 *      python, a node renamed), a node flag (-e, --require, --inspect), a
 *      different copy of server.js, extra arguments, a missing launch file;
 *   §2 the child's environment: an allow-list plus CURATOR_MCP_VIA=self-test,
 *      the entry's own `env` NEVER (NODE_OPTIONS is code execution);
 *   §3 the runner, for real: it starts this repo's bridge with the vetted
 *      argv, answers "starts · N tools", and turns a crash and a hang into
 *      plain words — the child killed after, stdout capped;
 *   §4 the route: the install gate (Origin required, same port, macOS and
 *      Windows only), a body of exactly {id} from INSTALL_IDS (a path, a
 *      command or an entry in the body → 400), the command read from the
 *      file the SERVER resolves, one check in flight, and a refusal reported
 *      without starting anything;
 *   §5 the status's two new labels: lastStartedAt and entryWrittenAt.
 * OFFLINE: it spawns only this repo's own node and mcp/server.js, against a
 * temp folder. The real user's config files are fingerprinted before and after.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, chmodSync, symlinkSync, copyFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { fingerprintReal, changedSince } from './test-helpers/real-mcp-configs.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
const ok = (label, cond, detail) => { if (cond) { passed++; console.log('  ✓ ' + label); } else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + String(detail).slice(0, 400) : '')); } };
const section = (t) => console.log('\n' + t);

/** desktop/node_modules' Electron binary (or CURATOR_TEST_ELECTRON_BIN), or null. */
function electronBinary() {
  if (process.env.CURATOR_TEST_ELECTRON_BIN) return process.env.CURATOR_TEST_ELECTRON_BIN;
  try {
    const dir = path.join(ROOT, 'desktop', 'node_modules', 'electron');
    const rel = readFileSync(path.join(dir, 'path.txt'), 'utf8').trim();
    const bin = path.join(dir, 'dist', rel);
    return existsSync(bin) ? bin : null;
  } catch { return null; }
}

const REAL_BEFORE = fingerprintReal();
const TMP = realpathSync(mkdtempSync(path.join(tmpdir(), 'curator-mcpinst-check-')));
const HOME = path.join(TMP, 'home');
const UD = path.join(TMP, 'ud');
const DOM = path.join(TMP, 'domains');
const BIN = path.join(TMP, 'bin');
for (const d of [HOME, UD, DOM, BIN]) mkdirSync(d, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = UD;
process.env.CURATOR_TEST_DOMAINS_DIR = DOM;
process.env.CURATOR_TEST_MCP_LAUNCHER_DIR = BIN;
process.env.CURATOR_TEST_LOG_DIR = path.join(UD, 'logs');

const C = await import('../src/brain/mcp-check-entry.js');
const { __setDomainsDirOverride } = await import('../src/brain/config.js');
__setDomainsDirOverride(DOM);
const M = await import('../src/brain/mcp-install.js');
const R = await import('../src/routes/mcp-install.js');
const { getMcpLauncherPath, getMcpServerPath } = await import('../src/brain/mcp-launcher.js');
const express = (await import('express')).default;
M.__setHomeOverride(HOME);
M.__setPlatformOverride('darwin');
R.__setDetectDeps({ appsDirs: [], runPs: async () => '', runShell: async () => '' });

const NODE = process.execPath;
const SERVER = getMcpServerPath();
const LAUNCHER = getMcpLauncherPath();
writeFileSync(LAUNCHER, '#!/bin/sh\nexec "' + NODE + '" "' + SERVER + '" "$@"\n'); chmodSync(LAUNCHER, 0o755);
const CTX = { platform: 'darwin', launcherPath: LAUNCHER, serverPath: SERVER };

try {
  section('§1 vetEntry — only The Curator’s own bridge may be started');
  {
    const good = C.vetEntry({ command: NODE, args: [SERVER, '--domains-path', DOM] }, CTX);
    ok('node + this install’s server + --domains-path <abs> → may start', good.ok && good.shape === 'node' && good.args.length === 3);
    ok('node + this install’s server alone → may start', C.vetEntry({ command: NODE, args: [SERVER] }, CTX).ok);
    ok('this app’s own launcher, no args → may start', C.vetEntry({ command: LAUNCHER, args: [] }, CTX).shape === 'launcher');
    ok('…args absent counts as none', C.vetEntry({ command: LAUNCHER }, CTX).ok);
    const refuse = (label, entry, code) => {
      const v = C.vetEntry(entry, CTX);
      ok(label + ' → refused (' + (code || 'any') + ')', !v.ok && (!code || v.code === code) && typeof v.message === 'string' && v.message.length > 10, JSON.stringify(v));
    };
    refuse('a bare "node"', { command: 'node', args: [SERVER] }, 'not_allowed');
    refuse('a relative command', { command: './node', args: [SERVER] }, 'not_allowed');
    refuse('npx', { command: 'npx', args: ['-y', 'my-curator'] }, 'not_allowed');
    refuse('/bin/sh -c', { command: '/bin/sh', args: ['-c', 'echo pwned'] }, 'not_allowed');
    const fakeNode = path.join(BIN, 'python3'); copyFileSync(NODE, fakeNode); chmodSync(fakeNode, 0o755);
    refuse('a real node binary under another name', { command: fakeNode, args: [SERVER] }, 'not_allowed');
    const sneaky = path.join(BIN, 'node'); symlinkSync('/bin/sh', sneaky);
    refuse('a file NAMED node that resolves to /bin/sh', { command: sneaky, args: ['-c', 'echo pwned'] }, 'not_allowed');
    refuse('node -e', { command: NODE, args: ['-e', 'process.exit(0)'] }, 'not_allowed');
    refuse('node --require before the server', { command: NODE, args: ['--require', '/tmp/x.js', SERVER] }, 'not_allowed');
    refuse('node --inspect after the server', { command: NODE, args: [SERVER, '--inspect'] }, 'not_allowed');
    refuse('a relative --domains-path', { command: NODE, args: [SERVER, '--domains-path', 'rel'] }, 'not_allowed');
    refuse('an extra argument', { command: NODE, args: [SERVER, '--domains-path', DOM, '--x'] }, 'not_allowed');
    const other = path.join(TMP, 'other', 'mcp', 'server.js'); mkdirSync(path.dirname(other), { recursive: true }); writeFileSync(other, 'process.exit(0)');
    refuse('another copy of mcp/server.js', { command: NODE, args: [other] }, 'other_install');
    refuse('a missing server script (the v3.88.1 case)', { command: NODE, args: [path.join(TMP, 'gone', 'mcp', 'server.js')] }, 'launch_file_missing');
    refuse('a missing node', { command: path.join(TMP, 'gone', 'node'), args: [SERVER] }, 'launch_file_missing');
    refuse('the launcher with arguments', { command: LAUNCHER, args: ['--x'] }, 'not_allowed');
    refuse('args that are not a list of strings', { command: NODE, args: [SERVER, 7] }, 'not_allowed');
    refuse('a NUL in the command', { command: NODE + '\0', args: [SERVER] }, 'not_allowed');
    refuse('no entry at all', null, 'no_entry');
    const win = C.vetEntry({ command: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\x\\mcp\\server.js'] }, { ...CTX, platform: 'win32' }, {
      realpath: (p) => p, stat: () => ({ isFile: () => true }) });
    ok('Windows: node.exe with ANOTHER server.js is still refused (other_install)', !win.ok && win.code === 'other_install');
    const winOk = C.vetEntry({ command: 'C:\\Program Files\\nodejs\\NODE.EXE', args: ['C:\\App\\mcp\\server.js'] }, { platform: 'win32', launcherPath: null, serverPath: 'c:\\app\\mcp\\server.js' }, {
      realpath: (p) => p, stat: () => ({ isFile: () => true }) });
    ok('Windows: node.exe (any case) with THIS server (case-insensitive path) → may start', winOk.ok);
  }

  section('§2 the child’s environment');
  {
    const env = C.checkEnv({ PATH: '/bin', HOME: '/h', NODE_OPTIONS: '--require /evil.js', GEMINI_API_KEY: 'k', CURATOR_TEST_USER_DATA_DIR: '/ud', DYLD_INSERT_LIBRARIES: '/x' });
    ok('PATH and HOME pass; NODE_OPTIONS, DYLD_*, API keys do not', env.PATH === '/bin' && env.HOME === '/h' && !('NODE_OPTIONS' in env) && !('DYLD_INSERT_LIBRARIES' in env) && !('GEMINI_API_KEY' in env));
    ok('an isolated test keeps its isolation in the child', env.CURATOR_TEST_USER_DATA_DIR === '/ud');
    ok('CURATOR_MCP_VIA=self-test, so a check never counts as an agent session', env.CURATOR_MCP_VIA === 'self-test');
    let seen = null;
    await C.runEntryCheck({ command: NODE, args: [SERVER] }, { execFile: (cmd, args, opts) => { seen = { cmd, args, opts }; throw Object.assign(new Error('x'), { code: 'ENOENT' }); } });
    ok('execFile gets the argv as a list, shell:false, a timeout and a maxBuffer', seen && seen.cmd === NODE && Array.isArray(seen.args) && seen.opts.shell === false
      && seen.opts.timeout === C.CHECK_TIMEOUT_MS && seen.opts.maxBuffer === C.STDOUT_CAP);
    ok('…and the environment is the allow-list, never an entry’s own env', seen && seen.opts.env.CURATOR_MCP_VIA === 'self-test' && !('NODE_OPTIONS' in seen.opts.env));
  }

  section('§3 the runner, for real');
  {
    const r = await C.runEntryCheck(C.vetEntry({ command: NODE, args: [SERVER, '--domains-path', DOM] }, CTX));
    ok('this repo’s bridge starts and lists its tools', r.starts === true && Number.isInteger(r.toolCount) && r.toolCount >= 20, JSON.stringify(r));
    const viaL = await C.runEntryCheck(C.vetEntry({ command: LAUNCHER, args: [] }, CTX));
    ok('…and through the launcher', viaL.starts === true, JSON.stringify(viaL));
    const crash = path.join(TMP, 'crash.js'); writeFileSync(crash, 'console.error("Error: Cannot find module \'x\'"); process.exit(3);');
    const c = await C.runEntryCheck({ command: NODE, args: [crash] });
    ok('a crash on start: "stopped before it answered (exit code 3)", with the stderr line', !c.starts && /exit code 3/.test(c.message) && /Cannot find module/.test(c.message), c.message);
    const hang = path.join(TMP, 'hang.js'); writeFileSync(hang, 'setInterval(() => {}, 1000);');
    const t0 = Date.now();
    const h = await C.runEntryCheck({ command: NODE, args: [hang] }, { timeoutMs: 800 });
    ok('a hang: "did not answer within …", bounded by the timeout', !h.starts && /did not answer within/.test(h.message) && Date.now() - t0 < 4000, h.message);
    const flood = path.join(TMP, 'flood.js'); writeFileSync(flood, 'const s="x".repeat(1<<20); setInterval(()=>process.stdout.write(s),1);');
    const f = await C.runEntryCheck({ command: NODE, args: [flood] }, { timeoutMs: 1500 });
    ok('a flood of stdout is capped and ends the run, never the server', !f.starts && typeof f.message === 'string');
  }

  section('§4 the route');
  {
    const app = express(); app.use(express.json()); app.use('/api/mcp/install', R.default);
    const server = app.listen(0, '127.0.0.1'); await new Promise((r) => server.once('listening', r));
    const PORT = server.address().port; const ORIGIN = `http://127.0.0.1:${PORT}`;
    const call = async (body, origin = ORIGIN) => {
      const headers = { 'content-type': 'application/json' }; if (origin) headers.Origin = origin;
      const res = await fetch(`http://127.0.0.1:${PORT}/api/mcp/install/check-entry`, { method: 'POST', headers, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    };
    const CD = path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    mkdirSync(path.dirname(CD), { recursive: true });
    const write = (entry) => writeFileSync(CD, JSON.stringify({ mcpServers: { other: { command: '/bin/sh', args: ['-c', 'touch ' + path.join(TMP, 'PWNED')] }, 'my-curator': entry } }, null, 2));
    write({ command: NODE, args: [SERVER, '--domains-path', DOM] });
    ok('no Origin → 403', (await call({ id: 'claude-desktop' }, null)).status === 403);
    ok('a foreign Origin → 403', (await call({ id: 'claude-desktop' }, 'https://evil.example')).status === 403);
    ok('another port’s loopback Origin → 403', (await call({ id: 'claude-desktop' }, `http://127.0.0.1:${PORT + 1}`)).status === 403);
    for (const [label, body] of [['a path', { id: 'claude-desktop', path: CD }], ['a command', { id: 'claude-desktop', command: '/bin/sh' }],
      ['an entry', { id: 'claude-desktop', entry: { command: '/bin/sh' } }], ['an unknown id', { id: 'zed' }], ['no id', {}], ['an array', [1]]]) {
      const r = await call(body);
      ok('a body with ' + label + ' → 400 bad_request', r.status === 400 && r.body.reason === 'bad_request', JSON.stringify(r));
    }
    const r1 = await call({ id: 'claude-desktop' });
    ok('a good entry: 200, it starts, with its tool count', r1.status === 200 && r1.body.results.length === 1 && r1.body.results[0].starts === true && r1.body.results[0].toolCount >= 20, JSON.stringify(r1.body));
    ok('…the file is named as the person sees it (~/…)', /^~\/Library\/Application Support\/Claude\/claude_desktop_config\.json$/.test(r1.body.results[0].file));
    ok('…and ONLY our entry ran: the other server’s command was never started', !(await import('node:fs')).existsSync(path.join(TMP, 'PWNED')));
    write({ command: '/bin/sh', args: ['-c', 'touch ' + path.join(TMP, 'PWNED2')] });
    let ran = false; R.__setCheckRunner(async () => { ran = true; return { starts: true }; });
    const r2 = await call({ id: 'claude-desktop' });
    ok('an entry naming /bin/sh: refused in words, NOTHING started', r2.status === 200 && r2.body.results[0].ran === false && r2.body.results[0].code === 'not_allowed' && !ran
      && !(await import('node:fs')).existsSync(path.join(TMP, 'PWNED2')), JSON.stringify(r2.body));
    write({ command: NODE, args: [path.join(TMP, 'gone', 'mcp', 'server.js')] });
    const r3 = await call({ id: 'claude-desktop' });
    ok('an entry whose server is gone: "no longer on this Mac", nothing started', r3.body.results[0].code === 'launch_file_missing' && /no longer on this Mac/.test(r3.body.results[0].message) && !ran);
    ok('…and the missing file rides in `path` (v3.90.0), so the page names it without reading the sentence',
      r3.body.results[0].path === path.join(TMP, 'gone', 'mcp', 'server.js'), JSON.stringify(r3.body.results[0]));
    ok('…while a refusal with no file names no `path`', !('path' in r2.body.results[0]));
    R.__setCheckRunner(null);
    writeFileSync(CD, JSON.stringify({ mcpServers: { other: {} } }));
    const r4 = await call({ id: 'claude-desktop' });
    ok('a file with no entry: said so, nothing started', r4.status === 200 && r4.body.results.length === 0 && /has no my-curator entry/.test(r4.body.message));
    R.__setCheckInFlight(true);
    ok('one check in flight → 409 busy', (await call({ id: 'claude-desktop' })).status === 409);
    R.__setCheckInFlight(false);
    M.__setPlatformOverride('linux');
    ok('Linux → 409 platform_unsupported (the install gate)', (await call({ id: 'claude-desktop' })).body.reason === 'platform_unsupported');
    M.__setPlatformOverride('darwin');
    server.close();
  }

  section('§6 shape (c): the Windows app’s own exe as Node (owner-approved 2026-11-20)');
  {
    // An in-memory Windows disk: each key is a LOWER-CASED path (Windows folds
    // case) → its true-case realpath and its file id. `link` aliases share a
    // file id (a hard link); `alias` resolves to another path (8.3, junction).
    const EXE = 'C:\\Users\\Ziga Novak\\AppData\\Local\\Programs\\The Curator\\The Curator.exe';
    const SRV = 'C:\\Users\\Ziga Novak\\AppData\\Local\\Programs\\The Curator\\resources\\app\\mcp\\server.js';
    const OTHER_EXE = 'D:\\Portable\\The Curator\\The Curator.exe';
    const OTHER_SRV = 'D:\\Portable\\The Curator\\resources\\app\\mcp\\server.js';
    const HARDLINK = 'C:\\Users\\Ziga Novak\\Desktop\\The Curator.exe';
    const SHORT = 'C:\\Users\\ZIGANO~1\\AppData\\Local\\Programs\\THECUR~1\\The Curator.exe';
    const disk = new Map();
    const put = (p, real, ino) => disk.set(p.toLowerCase(), { real, ino });
    put(EXE, EXE, 101n); put(SRV, SRV, 102n); put(OTHER_EXE, OTHER_EXE, 201n); put(OTHER_SRV, OTHER_SRV, 202n);
    put(HARDLINK, HARDLINK, 101n);          // the SAME file as EXE, at another path
    put(SHORT, EXE, 101n);                  // an 8.3 spelling of EXE
    // A junction to the install folder: canonical-looking, SAME file id, SAME
    // realpath — only the literal spelling tells it apart.
    const JEXE = 'C:\\Users\\Ziga Novak\\Links\\The Curator\\The Curator.exe';
    const JSRV = 'C:\\Users\\Ziga Novak\\Links\\The Curator\\resources\\app\\mcp\\server.js';
    put(JEXE, EXE, 101n); put(JSRV, SRV, 102n);
    const deps = {
      realpath: (p) => { const e = disk.get(String(p).toLowerCase()); if (!e) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return e.real; },
      stat: (p) => { const e = disk.get(String(p).toLowerCase()); if (!e) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return { isFile: () => true, ino: e.ino, dev: 7n }; },
    };
    const CTXC = { platform: 'win32', launcherPath: null, serverPath: SRV, appExecPath: EXE };
    const ENV = { ELECTRON_RUN_AS_NODE: '1' };
    const good = { command: EXE, args: [SRV], env: ENV };
    const v = C.vetEntry(good, CTXC, deps);
    ok('this exe + this server.js + env ELECTRON_RUN_AS_NODE=1 → may start, shape app-binary', v.ok && v.shape === 'app-binary', JSON.stringify(v));
    ok('…and what will run is OUR two strings, not the entry’s', v.command === EXE && v.args.length === 1 && v.args[0] === SRV);
    const lower = C.vetEntry({ command: EXE.toLowerCase(), args: [SRV.toUpperCase()], env: ENV }, CTXC, deps);
    ok('the same paths in another case → may start (Windows folds case), still running OUR spelling', lower.ok && lower.command === EXE && lower.args[0] === SRV, JSON.stringify(lower));
    const refuse = (label, entry, code, ctx = CTXC, d = deps, re = null) => {
      const r = C.vetEntry(entry, ctx, d);
      ok(label + ' → refused (' + (code || 'any') + ')', !r.ok && (!code || r.code === code) && typeof r.message === 'string' && r.message.length > 10
        && (!re || re.test(r.message)), JSON.stringify(r));
      return r;
    };
    refuse('no env at all (Claude Desktop would open a second copy of the app)', { command: EXE, args: [SRV] }, 'not_allowed', CTXC, deps, /ELECTRON_RUN_AS_NODE/);
    refuse('ELECTRON_RUN_AS_NODE="0"', { ...good, env: { ELECTRON_RUN_AS_NODE: '0' } }, 'not_allowed');
    refuse('ELECTRON_RUN_AS_NODE as the number 1', { ...good, env: { ELECTRON_RUN_AS_NODE: 1 } }, 'not_allowed');
    refuse('env as an array', { ...good, env: ['ELECTRON_RUN_AS_NODE=1'] }, 'not_allowed');
    const nodeOpts = refuse('an extra NODE_OPTIONS in the entry’s env', { ...good, env: { ...ENV, NODE_OPTIONS: '--require C:\\evil.js' } }, 'not_allowed', CTXC, deps, /NODE_OPTIONS/);
    ok('…the refusal names the variable but never its value', !/evil/.test(nodeOpts.message));
    refuse('an extra innocent-looking variable too', { ...good, env: { ...ENV, FOO: 'bar' } }, 'not_allowed', CTXC, deps, /FOO/);
    refuse('no arguments', { command: EXE, args: [], env: ENV }, 'not_allowed');
    refuse('-e before the server', { command: EXE, args: ['-e', 'require("child_process")'], env: ENV }, 'not_allowed');
    refuse('--inspect after the server', { command: EXE, args: [SRV, '--inspect'], env: ENV }, 'not_allowed');
    refuse('--domains-path (the app never writes one here)', { command: EXE, args: [SRV, '--domains-path', 'C:\\x'], env: ENV }, 'not_allowed');
    refuse('another install’s server.js', { command: EXE, args: [OTHER_SRV], env: ENV }, 'other_install');
    refuse('a different install’s The Curator.exe', { command: OTHER_EXE, args: [OTHER_SRV], env: ENV }, 'other_install');
    refuse('…even with THIS install’s server.js', { command: OTHER_EXE, args: [SRV], env: ENV }, 'other_install');
    refuse('a hard link to this very exe at another path', { command: HARDLINK, args: [SRV], env: ENV }, 'other_install');
    refuse('this exe through a junction (same file, same realpath, another spelling)', { command: JEXE, args: [SRV], env: ENV }, 'other_install');
    refuse('this server.js through a junction', { command: EXE, args: [JSRV], env: ENV }, 'other_install');
    refuse('an 8.3 short name of this exe (resolves to it)', { command: SHORT, args: [SRV], env: ENV }, 'not_allowed', CTXC, deps, /short/);
    refuse('a UNC spelling', { command: '\\\\localhost\\C$\\Users\\Ziga Novak\\AppData\\Local\\Programs\\The Curator\\The Curator.exe', args: [SRV], env: ENV }, 'not_allowed');
    refuse('a \\\\?\\ device spelling', { command: '\\\\?\\' + EXE, args: [SRV], env: ENV }, 'not_allowed');
    refuse('forward slashes', { command: EXE.replace(/\\/g, '/'), args: [SRV], env: ENV }, 'not_allowed');
    refuse('a folder name with a trailing dot', { command: EXE.replace('\\The Curator\\', '\\The Curator.\\'), args: [SRV], env: ENV }, 'not_allowed');
    refuse('a doubled backslash', { command: EXE.replace('\\Programs\\', '\\Programs\\\\'), args: [SRV], env: ENV }, 'not_allowed');
    refuse('a .. step that lands on this exe', { command: EXE.replace('\\The Curator\\', '\\The Curator\\..\\The Curator\\'), args: [SRV], env: ENV }, 'not_allowed');
    refuse('the exe name with a trailing dot (Windows strips it)', { command: EXE + '.', args: [SRV], env: ENV }, 'not_allowed');
    refuse('the exe name with a trailing space', { command: EXE + ' ', args: [SRV], env: ENV }, 'not_allowed');
    refuse('an alternate data stream of the exe', { command: EXE + ':evil', args: [SRV], env: ENV }, 'not_allowed');
    refuse('the server.js as an 8.3 name', { command: EXE, args: [SRV.replace('\\resources\\', '\\RESOUR~1\\')], env: ENV }, 'not_allowed');
    refuse('the server.js with forward slashes', { command: EXE, args: [SRV.replace(/\\/g, '/')], env: ENV }, 'not_allowed');
    // NTFS per-folder case sensitivity: `the curator.exe` is ANOTHER file there.
    const csDeps = { ...deps, stat: (p) => (p === EXE.toLowerCase() ? { isFile: () => true, ino: 999n, dev: 7n } : deps.stat(p)) };
    refuse('a case-variant that is a DIFFERENT file (case-sensitive folder)', { command: EXE.toLowerCase(), args: [SRV], env: ENV }, 'other_install', CTXC, csDeps);
    const zeroDeps = { ...deps, stat: (p) => ({ ...deps.stat(p), ino: 0n }) };
    refuse('a file system with no file ids (identity unprovable)', good, 'other_install', CTXC, zeroDeps);
    const devDeps = { ...deps, stat: (p) => (p === EXE.toLowerCase() ? { ...deps.stat(p), dev: 8n } : deps.stat(p)) };
    refuse('same file id on another volume', { ...good, command: EXE.toLowerCase() }, 'other_install', CTXC, devDeps);
    const goneDeps = { ...deps, stat: (p) => { if (String(p).toLowerCase() === EXE.toLowerCase() && goneDeps.gone) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return deps.stat(p); } };
    goneDeps.gone = true;
    refuse('this exe missing on disk', good, 'launch_file_missing', CTXC, goneDeps);
    refuse('our own exe path on a network share (no entry can match)', good, 'not_allowed', { ...CTXC, appExecPath: '\\\\srv\\apps\\The Curator.exe' });
    refuse('shape (c) is never offered off Windows', good, 'not_allowed', { ...CTXC, platform: 'darwin' });
    refuse('…nor on Windows without appExecPath (the repo / browser install)', good, 'not_allowed', { platform: 'win32', launcherPath: null, serverPath: SRV });
    // The launcher shape is OFF in the Windows app: a file at the launcher path is never run.
    const LCH = 'C:\\Users\\Ziga Novak\\AppData\\Local\\TheCurator\\bin\\my-curator-mcp';
    put(LCH, LCH, 301n);
    ok('CONTROL: with no appExecPath that launcher file IS the launcher shape', C.vetEntry({ command: LCH, args: [] }, { platform: 'win32', launcherPath: LCH, serverPath: SRV }, deps).shape === 'launcher');
    refuse('…but with appExecPath set, an entry naming the launcher path is refused', { command: LCH, args: [] }, 'not_allowed', { ...CTXC, launcherPath: LCH });
    // Shape (b) still works in the Windows app (node.exe + this server.js).
    const NODEW = 'C:\\Program Files\\nodejs\\node.exe'; put(NODEW, NODEW, 401n);
    ok('shape (b) is unchanged beside (c): node.exe + this server.js may start', C.vetEntry({ command: NODEW, args: [SRV] }, CTXC, deps).shape === 'node');

    section('§6b winPathProblem — the one canonical spelling');
    for (const [p, want] of [
      [EXE, null], ['C:\\a\\b.exe', null], ['c:\\x y\\ž.js', null],
      ['C:\\a\\B~1\\b.exe', 'short'], ['C:\\a\\b~1.exe', 'short'], ['\\\\server\\share\\b.exe', 'drive'], ['\\\\?\\C:\\b.exe', 'drive'],
      ['\\\\.\\pipe\\x', 'drive'], ['C:b.exe', 'drive'], ['b.exe', 'drive'], ['C:\\a/b.exe', 'forward'], ['C:\\a\\\\b.exe', 'empty'],
      ['C:\\a\\', 'empty'], ['C:\\a\\.\\b.exe', 'relative'], ['C:\\a\\..\\b.exe', 'relative'], ['C:\\a.\\b.exe', 'dot'], ['C:\\a \\b.exe', 'dot'],
      ['C:\\a\\b.exe:s', 'character'], ['C:\\a\\b?.exe', 'character'], ['C:\\a\\NUL.exe', 'device'], ['C:\\a\\com1', 'device'], ['C:\\a\\b\u0001.exe', 'control'], ['', 'not a path'],
    ]) {
      const got = C.winPathProblem(p);
      ok(`${JSON.stringify(p)} → ${want === null ? 'canonical' : 'refused (' + want + ')'}`, want === null ? got === null : (typeof got === 'string' && got.includes(want)), String(got));
    }

    section('§6c the runner sets ELECTRON_RUN_AS_NODE ITSELF, only for shape (c)');
    const saved = { e: process.env.ELECTRON_RUN_AS_NODE, n: process.env.NODE_OPTIONS };
    process.env.ELECTRON_RUN_AS_NODE = 'planted';
    process.env.NODE_OPTIONS = '--require C:\\evil.js';
    let seen = null;
    const capture = (cmd, args, opts) => { seen = { cmd, args, opts }; throw Object.assign(new Error('x'), { code: 'ENOENT' }); };
    await C.runEntryCheck(v, { execFile: capture });
    ok('app-binary: the child gets ELECTRON_RUN_AS_NODE=1 (the constant, not this process’s "planted")', seen && seen.opts.env.ELECTRON_RUN_AS_NODE === '1');
    ok('…and still no NODE_OPTIONS, and the self-test marker', seen && !('NODE_OPTIONS' in seen.opts.env) && seen.opts.env.CURATOR_MCP_VIA === 'self-test');
    ok('…argv is ours, shell:false', seen && seen.cmd === EXE && seen.args[0] === SRV && seen.opts.shell === false);
    await C.runEntryCheck({ command: NODE, args: [SERVER], shape: 'node' }, { execFile: capture });
    ok('shape node: NO ELECTRON_RUN_AS_NODE reaches the child, even with one in this process', seen && !('ELECTRON_RUN_AS_NODE' in seen.opts.env));
    await C.runEntryCheck({ command: LAUNCHER, args: [], shape: 'launcher' }, { execFile: capture });
    ok('shape launcher: none either', seen && !('ELECTRON_RUN_AS_NODE' in seen.opts.env));
    if (saved.e === undefined) delete process.env.ELECTRON_RUN_AS_NODE; else process.env.ELECTRON_RUN_AS_NODE = saved.e;
    if (saved.n === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = saved.n;
    ok('the entry’s frozen constant cannot be widened at a call site', Object.isFrozen(C.APP_BINARY_CHILD_ENV));

    // The real Electron binary (desktop/node_modules), when this machine has
    // one: the app-binary shape answers MCP as Node. On a Mac the binary is
    // Electron.app's; the shape is only offered on Windows, so the runner is
    // driven directly here and the route end to end in test-mcp-install-windows.js.
    const ELECTRON = electronBinary();
    if (ELECTRON) {
      const r = await C.runEntryCheck({ command: ELECTRON, args: [SERVER], shape: 'app-binary' }, { timeoutMs: 20000 });
      ok(`the real Electron binary, run by the checker as app-binary, starts My Curator and lists its tools (${path.basename(ELECTRON)})`, r.starts === true && r.toolCount >= 20, JSON.stringify(r));
    } else {
      console.log('  · no Electron binary here (desktop/node_modules not installed): the real-binary run is proved on the windows CI job');
    }
  }

  section('§5 the status’s new labels');
  {
    const rows = [{ harness: 'claude-desktop', file: '/a', action: 'install', at: '2026-10-30T10:00:00Z' },
      { harness: 'claude-desktop', file: '/a', action: 'remove', at: '2026-10-31T10:00:00Z' },
      { harness: 'claude-desktop', file: '/a', action: 'update', at: '2026-10-31T09:00:00Z' },
      { harness: 'cursor', file: '/c', action: 'install', at: '2026-11-01T10:00:00Z' },
      { harness: 'claude-desktop', file: '/elsewhere', action: 'install', at: '2026-11-01T11:00:00Z' }];
    ok('entryWrittenAt: the newest install/update of THIS app on ITS files', R.entryWrittenAtFor(rows, 'claude-desktop', [{ file: '/a' }]) === '2026-10-31T09:00:00Z');
    ok('…null when The Curator never wrote it', R.entryWrittenAtFor(rows, 'antigravity', [{ file: '/g' }]) === null);
    writeFileSync(path.join(UD, '.mcp-usage.jsonl'), [
      JSON.stringify({ ts: '2026-10-30T10:00:00.000Z', ev: 'session', sid: 'aaaaaaaaaaaa', client: 'claude-desktop' }),
      JSON.stringify({ ts: '2026-10-30T10:09:00.000Z', tool: 'list_domains', ok: true, refused: false, ms: 3, sid: 'aaaaaaaaaaaa' }),
    ].join('\n') + '\n');
    const st = await R.buildStatus();
    const cd = st.tools.find((t) => t.id === 'claude-desktop');
    ok('lastStartedAt is the session’s first line; usedAt its last', cd && cd.lastStartedAt === '2026-10-30T10:00:00.000Z' && cd.usedAt === '2026-10-30T10:09:00.000Z', JSON.stringify(cd && { s: cd.lastStartedAt, u: cd.usedAt }));
    ok('checkEntry is offered only where the file holds an entry', cd && cd.checkEntry === false);
  }
} finally {
  rmSync(TMP, { recursive: true, force: true });
  const moved = changedSince(REAL_BEFORE);
  ok('the REAL user’s config files were not written', moved.length === 0, JSON.stringify(moved));
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
