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
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, chmodSync, symlinkSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { fingerprintReal, changedSince } from './test-helpers/real-mcp-configs.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
const ok = (label, cond, detail) => { if (cond) { passed++; console.log('  ✓ ' + label); } else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + String(detail).slice(0, 400) : '')); } };
const section = (t) => console.log('\n' + t);

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
