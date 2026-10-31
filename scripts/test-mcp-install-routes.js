#!/usr/bin/env node
/**
 * test-mcp-install-routes.js — OFFLINE. The HTTP surface of v3.85.0's
 * installer (src/routes/mcp-install.js):
 *
 *   §R  the router on a loopback express app in THIS process, with the module
 *       seams (fake home, platform, detector probes, injected IO): the Origin
 *       gate (missing → 403, foreign → 403), non-macOS → 409, the body
 *       allow-list (a path, an entry, an unknown key or id → 400), plan →
 *       apply → status `connected`, token single-use and expiry, one apply in
 *       flight, config_changed between plan and apply, a backup that throws,
 *       Remove and Restore, and usedAt as a LABEL only (a usage log changes
 *       `usedAt` and nothing else).
 *   §X  the REAL src/server.js spawned with CURATOR_TEST_USER_DATA_DIR,
 *       CURATOR_TEST_DOMAINS_DIR, CURATOR_TEST_MCP_LAUNCHER_DIR and a fake
 *       HOME (CURATOR_TEST_INSTALL_HOME): the router is mounted, GET status →
 *       plan → apply → status connected → remove, end to end; and a
 *       no-Origin POST that the GLOBAL guard would let through is 403 here.
 *   §W  `POST /api/mcp/write-config` and its module are untouched, and nothing
 *       under mcp/ imports the installer.
 *
 * The REAL config files are fingerprinted before and after.
 */
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fingerprintReal, changedSince } from './test-helpers/real-mcp-configs.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
let failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); }
}
const eq = (label, a, b) => ok(label, Object.is(a, b), `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
const section = (t) => console.log('\n' + t);

const REAL_BEFORE = fingerprintReal();
const TMP = realpathSync(mkdtempSync(path.join(tmpdir(), 'curator-mcpinst-routes-')));
const HOME = path.join(TMP, 'home');
const UD = path.join(TMP, 'ud');
const DOM = path.join(TMP, 'domains');
const BIN = path.join(TMP, 'bin');
const APPS = path.join(TMP, 'Applications');
for (const d of [HOME, UD, DOM, BIN, APPS]) mkdirSync(d, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = UD;
process.env.CURATOR_TEST_DOMAINS_DIR = DOM;
process.env.CURATOR_TEST_MCP_LAUNCHER_DIR = BIN;
process.env.CURATOR_TEST_LOG_DIR = path.join(UD, 'logs');

const { __setDomainsDirOverride } = await import('../src/brain/config.js');
__setDomainsDirOverride(DOM);
const M = await import('../src/brain/mcp-install.js');
const R = await import('../src/routes/mcp-install.js');
const express = (await import('express')).default;

M.__setHomeOverride(HOME);
M.__setPlatformOverride('darwin');
let psText = '';
R.__setDetectDeps({ appsDirs: [APPS], runPs: async () => psText, runShell: async () => '' });

const CU = path.join(HOME, '.cursor', 'mcp.json');
const CD = path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
const AG = path.join(HOME, '.gemini', 'config', 'mcp_config.json');
const OTHER = { command: 'npx', args: ['-y', 'other'], env: { API_KEY: 'sk-PLANTED-ROUTES' } };
function put(p, text) { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, text); }
const backups = (f) => readdirSync(path.dirname(f)).filter((n) => n.includes('.curator-backup-'));

const app = express();
app.use(express.json());
app.use('/api/mcp/install', R.default);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const PORT = server.address().port;
const ORIGIN = `http://127.0.0.1:${PORT}`;

async function call(method, url, body, { origin = ORIGIN, port = PORT } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (origin) headers.Origin = origin;
  const res = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let json = null; try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, body: json || {} };
}
const tool = (st, id) => st.tools.find((t) => t.id === id);

try {
  section('§R0 — status, read-only');
  {
    put(CU, JSON.stringify({ mcpServers: { other: OTHER } }, null, 2));
    mkdirSync(path.join(APPS, 'Claude.app'));
    psText = '  101 /Applications/Cursor.app/Contents/MacOS/Cursor\n  102 /System/Library/CoreServices/CursorUIViewService.app/Contents/MacOS/CursorUIViewService\n';
    const before = readFileSync(CU, 'utf8');
    const s = await call('GET', '/api/mcp/install/status', undefined, { origin: null });
    eq('GET /status 200 with no Origin (it is a read)', s.status, 200);
    eq('platform darwin, writable', `${s.body.platform}/${s.body.writable}`, 'darwin/true');
    const cu = tool(s.body, 'cursor');
    ok('Cursor: not-installed, detected by its config, running (main bundle path)', cu && cu.status === 'not-installed' && cu.detected.by === 'config' && cu.running.checked && cu.running.running);
    ok('files[] carries the absolute path AND the ~ display', cu.files[0].file === CU && cu.files[0].display === '~/.cursor/mcp.json');
    ok('restorable is a boolean (false before any write)', cu.restorable === false);
    const cd = tool(s.body, 'claude-desktop');
    ok('Claude Desktop: detected by app, NOT running (CursorUIViewService does not count for anyone)', cd && cd.detected.by === 'app' && cd.running.running === false);
    ok('Claude Desktop gets the quit-first hint', /quit it first|Quit Claude Desktop first/i.test(cd.restartHint));
    ok('Antigravity (nothing on disk) is in notFound', s.body.notFound.some((n) => n.id === 'antigravity'));
    ok('a manual snippet is offered for every MCP tool (Copy)', ['cursor', 'claude-code', 'codex'].every((id) => typeof s.body.manualSnippets[id] === 'string'));
    ok('no other server\'s value leaves the status', !JSON.stringify(s.body).includes('sk-PLANTED'));
    eq('status wrote nothing', readFileSync(CU, 'utf8'), before);
    ok('...and no manifest exists', !existsSync(path.join(UD, '.mcp-installs.json')));
  }

  section('§R1 — the gate');
  {
    const body = { action: 'install', ids: ['cursor'] };
    const miss = await call('POST', '/api/mcp/install/plan', body, { origin: null });
    ok('missing Origin → 403 origin_required', miss.status === 403 && miss.body.reason === 'origin_required');
    const evil = await call('POST', '/api/mcp/install/plan', body, { origin: 'https://evil.example' });
    ok('foreign Origin → 403 origin_refused', evil.status === 403 && evil.body.reason === 'origin_refused');
    const wrongPort = await call('POST', '/api/mcp/install/plan', body, { origin: `http://127.0.0.1:${PORT + 1}` });
    ok('a loopback Origin on ANOTHER port → 403', wrongPort.status === 403);
    const lh = await call('POST', '/api/mcp/install/plan', body, { origin: `http://localhost:${PORT}` });
    eq('http://localhost:<port> is accepted', lh.status, 200);
    const missApply = await call('POST', '/api/mcp/install/apply', { token: lh.body.token }, { origin: null });
    ok('apply without Origin → 403 too', missApply.status === 403);
    for (const [name, b] of [
      ['a path in the body', { action: 'install', ids: ['cursor'], path: CU }],
      ['an entry in the body', { action: 'install', ids: ['cursor'], entry: { command: '/bin/sh' } }],
      ['an unknown id', { action: 'install', ids: ['../../etc'] }],
      ['a cli tool', { action: 'install', ids: ['claude-code'] }],
      ['an unknown action', { action: 'delete', ids: ['cursor'] }],
      ['no ids', { action: 'install', ids: [] }],
      ['ids not an array', { action: 'install', ids: 'cursor' }],
      ['a body that is an array', [1]],
    ]) {
      const r = await call('POST', '/api/mcp/install/plan', b);
      ok(`${name} → 400 bad_request`, r.status === 400 && r.body.reason === 'bad_request', String(r.status));
    }
    const extraApply = await call('POST', '/api/mcp/install/apply', { token: lh.body.token, file: CU });
    ok('apply with an extra key → 400', extraApply.status === 400);
    M.__setPlatformOverride('linux');
    const lin = await call('POST', '/api/mcp/install/plan', body);
    ok('non-macOS → 409 platform_unsupported', lin.status === 409 && lin.body.reason === 'platform_unsupported');
    const linStatus = await call('GET', '/api/mcp/install/status');
    ok('...and on non-macOS every row is manual, writable false', linStatus.body.writable === false && linStatus.body.tools.every((t) => t.status === 'manual'));
    M.__setPlatformOverride('darwin');
    ok('the file is still untouched after every refusal', !readFileSync(CU, 'utf8').includes('my-curator'));
  }

  section('§R2 — plan → apply → connected; token single-use');
  let cursorBackup = null;
  {
    const p = await call('POST', '/api/mcp/install/plan', { action: 'install', ids: ['cursor', 'claude-desktop'] });
    eq('plan 200', p.status, 200);
    ok('plan has a 48-hex token and an expiry', /^[0-9a-f]{48}$/.test(p.body.token) && Date.parse(p.body.expiresAt) > Date.now());
    const it = p.body.items.find((i) => i.id === 'cursor');
    ok('item: file (display), action add, entryText, preserved names, backupWillBe, basis', it.file === '~/.cursor/mcp.json' && it.action === 'add' && JSON.parse(it.entryText).type === 'stdio' && it.preserved.join() === 'other' && /curator-backup-/.test(it.backupWillBe) && /^[0-9a-f]{64}$/.test(it.basis));
    ok('the plan carries no absolute path and no other server\'s value', !JSON.stringify(p.body).includes(HOME) && !JSON.stringify(p.body).includes('sk-PLANTED'));
    ok('planning wrote nothing', !readFileSync(CU, 'utf8').includes('my-curator') && !existsSync(CD));
    const a = await call('POST', '/api/mcp/install/apply', { token: p.body.token });
    eq('apply 200', a.status, 200);
    const rc = a.body.results.find((r) => r.id === 'cursor');
    const rd = a.body.results.find((r) => r.id === 'claude-desktop');
    ok('Cursor written, backup named, restart line', rc.outcome === 'written' && /curator-backup-/.test(rc.backup) && rc.restart === 'Quit and reopen Cursor');
    ok('Claude Desktop created (detected by app)', rd.outcome === 'created' && !rd.backup);
    cursorBackup = rc.backup;
    const again = await call('POST', '/api/mcp/install/apply', { token: p.body.token });
    ok('the same token again → 409 token_invalid (single use)', again.status === 409 && again.body.reason === 'token_invalid');
    const s = await call('GET', '/api/mcp/install/status');
    ok('Cursor and Claude Desktop now `connected`', tool(s.body, 'cursor').status === 'connected' && tool(s.body, 'claude-desktop').status === 'connected');
    ok('Cursor is restorable now', tool(s.body, 'cursor').restorable === true);
    const idem = await call('POST', '/api/mcp/install/plan', { action: 'install', ids: ['cursor'] });
    const idemA = await call('POST', '/api/mcp/install/apply', { token: idem.body.token });
    ok('a second install is `unchanged`, no new backup', idemA.body.results[0].outcome === 'unchanged' && backups(CU).length === 1);
  }

  section('§R3 — expiry, busy, config_changed, backup failure');
  {
    const p = await call('POST', '/api/mcp/install/plan', { action: 'remove', ids: ['cursor'] });
    R.__expireAllTokens();
    const a = await call('POST', '/api/mcp/install/apply', { token: p.body.token });
    ok('an expired token → 409 token_expired', a.status === 409 && a.body.reason === 'token_expired');
    const a2 = await call('POST', '/api/mcp/install/apply', { token: p.body.token });
    ok('...and it is gone after that (token_invalid)', a2.body.reason === 'token_invalid');

    const p2 = await call('POST', '/api/mcp/install/plan', { action: 'remove', ids: ['cursor'] });
    R.__setApplyInFlight(true);
    const busy = await call('POST', '/api/mcp/install/apply', { token: p2.body.token });
    R.__setApplyInFlight(false);
    ok('one apply in flight → 409 busy', busy.status === 409 && busy.body.reason === 'busy');

    const p3 = await call('POST', '/api/mcp/install/plan', { action: 'remove', ids: ['cursor'] });
    const edited = readFileSync(CU, 'utf8').replace('"other"', '"other2"');
    writeFileSync(CU, edited);
    const a3 = await call('POST', '/api/mcp/install/apply', { token: p3.body.token });
    ok('a file edited between plan and apply → config_changed, nothing written', a3.body.results[0].outcome === 'refused' && a3.body.results[0].reason === 'config_changed' && readFileSync(CU, 'utf8') === edited);

    const p4 = await call('POST', '/api/mcp/install/plan', { action: 'remove', ids: ['cursor'] });
    R.__setInstallIO({ ...M.defaultIO(), writeExclusive: () => { throw Object.assign(new Error('nope'), { code: 'EACCES' }); } });
    const a4 = await call('POST', '/api/mcp/install/apply', { token: p4.body.token });
    R.__setInstallIO(null);
    ok('a backup that throws → refused backup_failed (200, per item), file byte-identical', a4.status === 200 && a4.body.results[0].reason === 'backup_failed' && readFileSync(CU, 'utf8') === edited);

    put(AG, '{ // comment\n "mcpServers": {} }');
    const s = await call('GET', '/api/mcp/install/status');
    const ag = tool(s.body, 'antigravity');
    ok('a JSONC Antigravity file → cant-read with a reason, no 500', s.status === 200 && ag.status === 'cant-read' && ag.reason.code === 'jsonc');
    const p5 = await call('POST', '/api/mcp/install/plan', { action: 'install', ids: ['antigravity', 'cursor'] });
    ok('planning a cant-read tool alongside a good one: per-item refusal, 200', p5.status === 200 && p5.body.items.find((i) => i.id === 'antigravity').refused.reason === 'jsonc');
  }

  section('§R4 — Remove, then Restore refused after an edit');
  {
    const p = await call('POST', '/api/mcp/install/plan', { action: 'remove', ids: ['cursor'] });
    const a = await call('POST', '/api/mcp/install/apply', { token: p.body.token });
    ok('remove written', a.body.results[0].outcome === 'written' && !JSON.parse(readFileSync(CU, 'utf8')).mcpServers['my-curator']);
    const s = await call('GET', '/api/mcp/install/status');
    eq('Cursor back to not-installed', tool(s.body, 'cursor').status, 'not-installed');
    ok('restorable right after the remove (the file is what the remove left)', tool(s.body, 'cursor').restorable === true);
    writeFileSync(CU, readFileSync(CU, 'utf8') + '\n');
    const r = await call('POST', '/api/mcp/install/plan', { action: 'restore', ids: ['cursor'] });
    ok('restore after a later edit → refused changed_since', r.body.items[0].refused && r.body.items[0].refused.reason === 'changed_since');
    const s2 = await call('GET', '/api/mcp/install/status');
    eq('...and status says restorable: false', tool(s2.body, 'cursor').restorable, false);
  }

  section('§R5 — usedAt is a LABEL: a usage log changes nothing else');
  {
    const strip = (b) => JSON.stringify(b.tools.map((t) => ({ ...t, usedAt: null })));
    const before = await call('GET', '/api/mcp/install/status');
    const sid = 'abcdef012345';
    writeFileSync(path.join(UD, '.mcp-usage.jsonl'), [
      JSON.stringify({ ts: '2026-10-30T10:00:00.000Z', ev: 'session', sid, client: 'claude-desktop' }),
      JSON.stringify({ ts: '2026-10-30T10:05:00.000Z', tool: 'list_domains', domain: null, ok: true, refused: false, ms: 3, sid }),
    ].join('\n') + '\n');
    const after = await call('GET', '/api/mcp/install/status');
    eq('Claude Desktop gains usedAt from its canonical client id', tool(after.body, 'claude-desktop').usedAt, '2026-10-30T10:05:00.000Z');
    eq('every status, offer and field other than usedAt is identical', strip(after.body), strip(before.body));
  }

  section('§X — the REAL server, fake HOME');
  {
    const xh = path.join(TMP, 'xhome');
    const xud = path.join(TMP, 'xud');
    mkdirSync(xud, { recursive: true });
    put(path.join(xh, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'o' } } }, null, 2) + '\n');
    const port = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
    const child = spawn(process.execPath, [path.join(ROOT, 'src/server.js')], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), CURATOR_NO_OPEN: '1', CURATOR_TEST_USER_DATA_DIR: xud, CURATOR_TEST_DOMAINS_DIR: DOM,
        CURATOR_TEST_LOG_DIR: path.join(xud, 'logs'), CURATOR_TEST_MCP_LAUNCHER_DIR: BIN, CURATOR_TEST_INSTALL_HOME: xh,
        CURATOR_TEST_INSTALL_PLATFORM: 'darwin', CURATOR_TEST_INSTALL_APPS_DIR: path.join(TMP, 'noapps') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    try {
      let st = null;
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline && child.exitCode === null) {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/api/mcp/install/status`);
          let j = null; try { j = await r.json(); } catch { /* HTML */ }
          if (r.status) { st = j; break; }
        } catch { /* not yet */ }
        await new Promise((r) => setTimeout(r, 100));
      }
      ok('the router is mounted on the real server (JSON, not the SPA)', st && Array.isArray(st.tools), out.split('\n').slice(0, 4).join(' | '));
      ok('status: Cursor not-installed under the fake HOME', st && tool(st, 'cursor')?.status === 'not-installed');
      const opt = { origin: `http://127.0.0.1:${port}`, port };
      const noOrigin = await call('POST', '/api/mcp/install/plan', { action: 'install', ids: ['cursor'] }, { origin: null, port });
      ok('no Origin → 403 here (the global guard alone would let it through)', noOrigin.status === 403 && noOrigin.body.reason === 'origin_required');
      const p = await call('POST', '/api/mcp/install/plan', { action: 'install', ids: ['cursor'] }, opt);
      const a = await call('POST', '/api/mcp/install/apply', { token: p.body.token }, opt);
      ok('plan → apply written on the real server', a.status === 200 && a.body.results[0].outcome === 'written');
      const s2 = await call('GET', '/api/mcp/install/status', undefined, opt);
      eq('status turns connected', tool(s2.body, 'cursor').status, 'connected');
      const rp = await call('POST', '/api/mcp/install/plan', { action: 'remove', ids: ['cursor'] }, opt);
      const ra = await call('POST', '/api/mcp/install/apply', { token: rp.body.token }, opt);
      ok('remove written', ra.body.results[0].outcome === 'written');
      const final = JSON.parse(readFileSync(path.join(xh, '.cursor', 'mcp.json'), 'utf8'));
      ok('only the other server is left', JSON.stringify(final) === JSON.stringify({ mcpServers: { other: { command: 'o' } } }));
      ok('the manifest landed in the child\'s user data', existsSync(path.join(xud, '.mcp-installs.json')));
    } finally {
      child.kill('SIGTERM');
    }
  }

  section('§W — write-config untouched; mcp/ does not import the installer');
  {
    const src = readFileSync(path.join(ROOT, 'src/routes/mcp.js'), 'utf8');
    ok('routes/mcp.js does not import the installer (write-config is not delegated)', !src.includes('mcp-install'));
    ok('write-config still keeps its .bak and response shape', src.includes("const backupPath = io.configPath + '.bak';") && src.includes('preserved_servers'));
    const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []));
    const offenders = walk(path.join(ROOT, 'mcp')).filter((f) => /mcp-install|harness-detect/.test(readFileSync(f, 'utf8')));
    eq('no file under mcp/ imports mcp-install or harness-detect', offenders.length, 0);
    for (const f of ['src/brain/mcp-install.js', 'src/brain/harness-detect.js']) {
      ok(`${f} never writes to stdout`, !/console\.(log|info)\(|process\.stdout/.test(readFileSync(path.join(ROOT, f), 'utf8')));
    }
  }
} finally {
  server.close();
  M.__setHomeOverride(null);
  M.__setPlatformOverride(null);
  R.__setDetectDeps(null);
  const moved = changedSince(REAL_BEFORE);
  ok('the REAL user\'s config files were not written', moved.length === 0, moved.join(', '));
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
