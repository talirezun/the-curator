#!/usr/bin/env node
/**
 * test-mcp-install-safety.js — v4.1.2. The MCP install and Check entry fixes
 * from the 2026-11-26 setup-flows audit, each as behaviour:
 *
 *   §M1  Check entry runs node ONLY when it is the node this app runs on.
 *        A shell script whose FILE is named `node` (the audit's C8 repro) is
 *        refused and never started, through vetEntry and through the real
 *        route; a symlink to our own node still runs; a COPY of node does not.
 *   §M2  Restore original after a Remove is not offered (it would put the
 *        Curator entry back under the words "the original settings file"),
 *        and after a Restore a second Restore is "nothing to put back", never
 *        an untrue "has changed since".
 *   §M3  The install preview shows the entry that is WRITTEN (keys the user
 *        added to our old entry included), and an update does not say "Adds:".
 *   §M7  The retired wizard routes POST /api/mcp/write-config and
 *        GET /api/mcp/claude-full-config are gone: 404, the Claude Desktop
 *        config in the (fake) home byte-identical, no other server's secret
 *        in any reply.
 *   §M9  A child that ignores SIGTERM is killed (SIGKILL) after the timeout.
 *   §W2  (revised at integration) The skill zip is served on every platform, so the link is drawn on each; was: never drawn as a
 *        download link on Windows or Linux by the MCP bridge views.
 *
 * OFFLINE. Isolated: a fake HOME (set BEFORE any import, so routes/mcp.js's
 * Claude config path is inside it), CURATOR_TEST_USER_DATA_DIR,
 * CURATOR_TEST_DOMAINS_DIR, CURATOR_NO_OPEN; the real MCP configs are
 * fingerprinted before and after.
 */
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fingerprintReal, changedSince } from './test-helpers/real-mcp-configs.js';

let passed = 0;
let failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); }
}
const eq = (label, a, b) => ok(label, Object.is(a, b), `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
const section = (t) => console.log('\n' + t);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const REAL_BEFORE = fingerprintReal();
const TMP = realpathSync(mkdtempSync(path.join(tmpdir(), 'curator-mcpinst-safety-')));
const HOME = path.join(TMP, 'home');
const UD = path.join(TMP, 'ud');
const DOM = path.join(TMP, 'domains');
const BIN = path.join(TMP, 'bin');
for (const d of [HOME, UD, DOM, BIN]) mkdirSync(d, { recursive: true });
const REAL_HOME = process.env.HOME;
process.env.HOME = HOME;
process.env.CURATOR_TEST_USER_DATA_DIR = UD;
process.env.CURATOR_TEST_DOMAINS_DIR = DOM;
process.env.CURATOR_TEST_MCP_LAUNCHER_DIR = BIN;
process.env.CURATOR_TEST_LOG_DIR = path.join(UD, 'logs');
process.env.CURATOR_NO_OPEN = '1';

const { __setDomainsDirOverride } = await import('../src/brain/config.js');
__setDomainsDirOverride(DOM);
const C = await import('../src/brain/mcp-check-entry.js');
const M = await import('../src/brain/mcp-install.js');
const R = await import('../src/routes/mcp-install.js');
const RM = await import('../src/routes/mcp.js');
const V = await import('../src/public/next/views/mcp-install.js');
const { getMcpServerPath, getMcpLauncherPath } = await import('../src/brain/mcp-launcher.js');
const express = (await import('express')).default;

M.__setHomeOverride(HOME);
M.__setPlatformOverride('darwin');
R.__setDetectDeps({ appsDirs: [], runPs: async () => '', runShell: async () => '' });

const NODE = process.execPath;
const SERVER = getMcpServerPath();
const CU = path.join(HOME, '.cursor', 'mcp.json');
const CD = path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
const OTHER = { command: 'npx', args: ['-y', 'other'], env: { GITHUB_TOKEN: 'sk-PLANTED-SAFETY-ghp' } };
function put(p, text) { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, text); }
const MARK = path.join(TMP, 'MARKER');

const app = express();
app.use(express.json());
app.use('/api/mcp/install', R.default);
app.use('/api/mcp', RM.default);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const PORT = server.address().port;
const ORIGIN = `http://127.0.0.1:${PORT}`;
async function call(method, url, body, { origin = ORIGIN } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (origin) headers.Origin = origin;
  const res = await fetch(`http://127.0.0.1:${PORT}${url}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* none */ }
  return { status: res.status, body: json || {}, text };
}
const tool = (st, id) => st.tools.find((t) => t.id === id);

try {
  section('§M1 — Check entry runs node only when it is the node this app runs on');
  {
    const CTX = { platform: 'darwin', launcherPath: getMcpLauncherPath(), serverPath: SERVER, nodePath: NODE };
    // The audit's C8: a REGULAR FILE named node, a shell script, + this install's server.js.
    const evilDir = path.join(HOME, 'evil');
    mkdirSync(evilDir, { recursive: true });
    const fake = path.join(evilDir, 'node');
    writeFileSync(fake, `#!/bin/sh\necho ran > ${JSON.stringify(MARK)}\nexit 0\n`); chmodSync(fake, 0o755);
    const v1 = C.vetEntry({ command: fake, args: [SERVER] }, CTX);
    ok('a shell script FILE named node + this server.js → refused', !v1.ok && v1.code === 'not_allowed', JSON.stringify(v1));
    ok('…and the refusal says why in words', !v1.ok && /node The Curator runs on/.test(v1.message), v1.message);
    const v2 = C.vetEntry({ command: fake, args: [SERVER, '--domains-path', DOM] }, CTX);
    ok('…the same with --domains-path → refused', !v2.ok);
    // A COPY of the real node binary, named node: a real node, but not ours.
    const copyDir = path.join(TMP, 'copy');
    mkdirSync(copyDir, { recursive: true });
    const copied = path.join(copyDir, 'node');
    copyFileSync(NODE, copied); chmodSync(copied, 0o755);
    const v3 = C.vetEntry({ command: copied, args: [SERVER] }, CTX);
    ok('a COPY of node at another path → refused (it is not the node this app runs on)', !v3.ok && v3.code === 'not_allowed', JSON.stringify(v3));
    // A symlink to THIS node (Homebrew's /opt/homebrew/bin/node → Cellar shape).
    const linkDir = path.join(TMP, 'brew', 'bin');
    mkdirSync(linkDir, { recursive: true });
    const linked = path.join(linkDir, 'node');
    symlinkSync(NODE, linked);
    const v4 = C.vetEntry({ command: linked, args: [SERVER, '--domains-path', DOM] }, CTX);
    ok('CONTROL: a symlink named node that resolves to THIS node → may start', v4.ok && v4.shape === 'node', JSON.stringify(v4));
    const v5 = C.vetEntry({ command: NODE, args: [SERVER, '--domains-path', DOM] }, CTX);
    ok('CONTROL: the entry the installer writes (process.execPath + server.js + --domains-path) → may start', v5.ok && v5.shape === 'node', JSON.stringify(v5));
    const v6 = C.vetEntry({ command: NODE, args: [SERVER] }, { ...CTX, nodePath: undefined });
    ok('no nodePath in the context (the Mac app: it writes the launcher) → shape (b) is off, refused', !v6.ok && v6.code === 'not_allowed', JSON.stringify(v6));
    ok('CONTROL: the launcher shape is unaffected', (() => {
      writeFileSync(CTX.launcherPath, '#!/bin/sh\nexit 0\n'); chmodSync(CTX.launcherPath, 0o755);
      return C.vetEntry({ command: CTX.launcherPath, args: [] }, CTX).shape === 'launcher';
    })());
    // Windows (string-level disk): the browser install's node.exe.
    const WNODE = 'C:\\Program Files\\nodejs\\node.exe';
    const WSRV = 'C:\\Users\\Ana\\the-curator\\mcp\\server.js';
    const EVILW = 'C:\\Users\\Ana\\evil\\node.exe';
    const disk = new Map([[WNODE.toLowerCase(), { real: WNODE, ino: 11n }], [WSRV.toLowerCase(), { real: WSRV, ino: 12n }], [EVILW.toLowerCase(), { real: EVILW, ino: 13n }]]);
    const deps = {
      realpath: (p) => { const e = disk.get(String(p).toLowerCase()); if (!e) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return e.real; },
      stat: (p) => { const e = disk.get(String(p).toLowerCase()); if (!e) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return { isFile: () => true, ino: e.ino, dev: 7n }; },
    };
    const WCTX = { platform: 'win32', launcherPath: null, serverPath: WSRV, nodePath: WNODE };
    const w1 = C.vetEntry({ command: EVILW, args: [WSRV] }, WCTX, deps);
    ok('Windows: a node.exe that is not this app\'s node + this server.js → refused', !w1.ok && w1.code === 'not_allowed', JSON.stringify(w1));
    const w2 = C.vetEntry({ command: WNODE.toUpperCase(), args: [WSRV] }, WCTX, deps);
    ok('CONTROL Windows: this app\'s node.exe (any case) + this server.js → may start', w2.ok && w2.shape === 'node', JSON.stringify(w2));

    // Through the REAL route: the cursor file names the fake node.
    put(CU, JSON.stringify({ mcpServers: { other: OTHER, 'my-curator': { command: fake, args: [SERVER] } } }, null, 2));
    rmSync(MARK, { force: true });
    const r = await call('POST', '/api/mcp/install/check-entry', { id: 'cursor' });
    const row = r.body.results && r.body.results[0];
    ok('route: the fake node is refused, not run', r.status === 200 && row && row.ran === false && row.code === 'not_allowed', JSON.stringify(r.body));
    ok('route: …and the script never ran (no marker)', !existsSync(MARK));
    put(CU, JSON.stringify({ mcpServers: { other: OTHER, 'my-curator': { command: copied, args: [SERVER] } } }, null, 2));
    const r2 = await call('POST', '/api/mcp/install/check-entry', { id: 'cursor' });
    ok('route: a copied node is refused too', r2.body.results && r2.body.results[0].ran === false, JSON.stringify(r2.body));
    // CONTROL through the route: the entry Install for me writes is vetted OK
    // (a stub runner, so no child starts; the vetting is real).
    let ranWith = null;
    R.__setCheckRunner(async (vet) => { ranWith = vet; return { starts: true, toolCount: 24, durationMs: 1 }; });
    try {
      put(CU, JSON.stringify({ mcpServers: { other: OTHER, 'my-curator': { command: NODE, args: [SERVER, '--domains-path', DOM] } } }, null, 2));
      const r3 = await call('POST', '/api/mcp/install/check-entry', { id: 'cursor' });
      ok('route CONTROL: this app\'s own node entry is handed to the runner (repo mode passes nodePath)',
        r3.body.results && r3.body.results[0].ran === true && ranWith && ranWith.command === NODE, JSON.stringify(r3.body));
    } finally { R.__setCheckRunner(null); }
  }

  section('§M2 — Restore original after a Remove or a Restore');
  {
    put(CU, JSON.stringify({ mcpServers: { other: OTHER } }, null, 2));
    const install = async () => {
      const p = await call('POST', '/api/mcp/install/plan', { action: 'install', ids: ['cursor'] });
      return call('POST', '/api/mcp/install/apply', { token: p.body.token });
    };
    const act = async (action) => {
      const p = await call('POST', '/api/mcp/install/plan', { action, ids: ['cursor'] });
      const a = p.body.token ? await call('POST', '/api/mcp/install/apply', { token: p.body.token }) : null;
      return { p, a };
    };
    const i1 = await install();
    eq('install written', i1.body.results[0].outcome, 'written');
    let s = await call('GET', '/api/mcp/install/status');
    ok('CONTROL: right after an install, Restore original IS offered', tool(s.body, 'cursor').restorable === true);
    const rm = await act('remove');
    eq('remove written', rm.a.body.results[0].outcome, 'written');
    ok('…the entry is gone', !JSON.parse(readFileSync(CU, 'utf8')).mcpServers['my-curator']);
    s = await call('GET', '/api/mcp/install/status');
    eq('after a Remove, Restore original is NOT offered', tool(s.body, 'cursor').restorable, false);
    const afterRemove = readFileSync(CU);
    const rs = await act('restore');
    const it = rs.p.body.items[0];
    ok('a Restore planned anyway is "nothing to do", not a refusal', it.action === 'none' && !it.refused, JSON.stringify(it));
    ok('…and applying it leaves the file byte-identical (no Curator entry put back)', Buffer.compare(readFileSync(CU), afterRemove) === 0
      && !JSON.parse(readFileSync(CU, 'utf8')).mcpServers['my-curator']);
    // install → restore → restore again.
    await install();
    const r1 = await act('restore');
    eq('CONTROL: a Restore right after an install is written', r1.a && r1.a.body.results[0].outcome, 'written');
    ok('…and puts the file back without our entry', !JSON.parse(readFileSync(CU, 'utf8')).mcpServers['my-curator']);
    s = await call('GET', '/api/mcp/install/status');
    eq('after a Restore, Restore original is NOT offered again', tool(s.body, 'cursor').restorable, false);
    const r2 = await act('restore');
    const it2 = r2.p.body.items[0];
    ok('a second Restore is "nothing to do", never an untrue "has changed since"', it2.action === 'none' && !it2.refused, JSON.stringify(it2));
    // An edit after the install still refuses changed_since (unchanged rule).
    await install();
    writeFileSync(CU, readFileSync(CU, 'utf8') + '\n');
    const r3 = await act('restore');
    ok('CONTROL: an edit after our install still refuses changed_since', r3.p.body.items[0].refused && r3.p.body.items[0].refused.reason === 'changed_since', JSON.stringify(r3.p.body.items[0]));
    // Pure: the newest row decides.
    const rowI = { harness: 'cursor', file: CU, action: 'install', shaAfter: 'A', backup: CU + '.curator-backup-1' };
    const rowR = { harness: 'cursor', file: CU, action: 'remove', shaAfter: 'B', backup: CU + '.curator-backup-2' };
    ok('restoreCandidate: newest row a remove → not eligible, no row (nothing to put back)', (() => { const c = M.restoreCandidate([rowI, rowR], 'cursor', CU, 'B'); return !c.eligible && c.row === null; })());
    ok('restoreCandidate CONTROL: newest row an install → eligible', M.restoreCandidate([rowR, rowI], 'cursor', CU, 'A').eligible === true);
  }

  section('§M3 — the preview shows the entry that is written');
  {
    put(CU, JSON.stringify({ mcpServers: { other: OTHER, 'my-curator': { command: '/old/node', args: ['/old/server.js'], env: { NODE_OPTIONS: '--require /x.js' }, disabled: true } } }, null, 2));
    const p = await call('POST', '/api/mcp/install/plan', { action: 'install', ids: ['cursor'] });
    const item = p.body.items[0];
    eq('an existing my-curator entry is an update', item.action, 'update');
    ok('the plan names the keys the update keeps from the old entry', Array.isArray(item.kept) && item.kept.includes('env') && item.kept.includes('disabled'), JSON.stringify(item.kept));
    ok('…without echoing a kept value (an env may hold a secret)', !item.entryText.includes('/x.js'));
    const html = V.renderPlanCard({ action: 'install', items: [item] }, [], false);
    ok('an update is not worded "Adds:"', !/<p>Adds:<\/p>/.test(html) && /Changes the My Curator setup to:/.test(html), html.slice(0, 400));
    ok('…and the preview SHOWS the kept keys by name', /data-mcpi-kept>Also keeps what was added to the old setup: env, disabled\.</.test(html) && !html.includes('/x.js'));
    const a = await call('POST', '/api/mcp/install/apply', { token: p.body.token });
    eq('the plan applies', a.body.results[0].outcome, 'written');
    const written = JSON.parse(readFileSync(CU, 'utf8')).mcpServers['my-curator'];
    ok('…and what it kept is what the preview named', written.env && written.env.NODE_OPTIONS === '--require /x.js' && written.disabled === true);
    put(CU, JSON.stringify({ mcpServers: { other: OTHER } }, null, 2));
    const p2 = await call('POST', '/api/mcp/install/plan', { action: 'install', ids: ['cursor'] });
    const html2 = V.renderPlanCard({ action: 'install', items: [p2.body.items[0]] }, [], false);
    ok('CONTROL: a new entry still reads "Adds:", with no kept line', /<p>Adds:<\/p>/.test(html2) && !/data-mcpi-kept/.test(html2));
  }

  section('§M7 — the retired wizard routes are gone');
  {
    const claudeText = JSON.stringify({ mcpServers: { github: OTHER, big: { command: 'x', args: [], env: { N: 12345678901234567890 } } } }, null, 2);
    put(CD, claudeText);
    chmodSync(CD, 0o644);
    const g = await call('GET', '/api/mcp/claude-full-config', undefined, { origin: null });
    eq('GET /api/mcp/claude-full-config → 404', g.status, 404);
    ok('…and no other server\'s secret is in the reply', !g.text.includes('sk-PLANTED-SAFETY'));
    const w = await call('POST', '/api/mcp/write-config', {}, { origin: null });
    eq('POST /api/mcp/write-config (no Origin) → 404', w.status, 404);
    const w2 = await call('POST', '/api/mcp/write-config', {});
    eq('POST /api/mcp/write-config (same Origin) → 404', w2.status, 404);
    ok('…Claude Desktop\'s config is byte-identical and still 0644', readFileSync(CD, 'utf8') === claudeText && (spawnSync('stat', ['-f', '%Lp', CD]).stdout.toString().trim() === '644'));
    ok('…and no .bak was made', !existsSync(CD + '.bak'));
    ok('the writer is not exported any more', typeof RM.writeConfigHandler === 'undefined' && typeof RM.planConfigWrite === 'undefined' && typeof RM.buildFullConfigPayload === 'undefined');
    const snip = await call('GET', '/api/mcp/claude-config', undefined, { origin: null });
    ok('CONTROL: GET /api/mcp/claude-config (our own entry, no file read) still answers', snip.status === 200 && snip.body.mcpServers && snip.body.mcpServers['my-curator'] && !snip.text.includes('sk-PLANTED'));
  }

  section('§M9 — a child that ignores SIGTERM is killed');
  {
    const pidFile = path.join(TMP, 'pid');
    const t0 = Date.now();
    const out = await C.runEntryCheck({ command: '/bin/sh', args: ['-c', `trap '' TERM; echo $$ > ${JSON.stringify(pidFile)}; while :; do sleep 0.1; done`], shape: 'node' },
      { timeoutMs: 400, env: { PATH: process.env.PATH } });
    ok('the check answers at the timeout', out.starts === false && Date.now() - t0 < 3000, JSON.stringify(out));
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) { await delay(100); try { process.kill(pid, 0); } catch { alive = false; } }
    ok('…and the child that ignored SIGTERM is gone within 4 s', !alive, `pid ${pid}`);
    if (alive) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  }

  section('§W2 — the skill-zip link is drawn on every platform (the route serves the zip on each: test-win-setup-check.js W2)');
  {
    const machine = { skillsShipped: true, raw: { skills: [{ skill: 'my-curator', apps: [{ id: 'claude-code', label: 'Claude Code', kind: 'folder', state: 'outdated', dir: '/h/.claude/skills/my-curator' }] }] } };
    const zip = /\/api\/setup\/skills\/my-curator\.zip/;
    for (const plat of ['win32', 'linux', 'darwin']) {
      const h = V.renderSkills(machine, { platform: plat });
      ok(`${plat}: Skills draws the zip link`, zip.test(h), h.slice(0, 300));
      ok(`${plat}: …and never tells the person to copy a folder out of the install`, !/Copy the my-curator folder/.test(h));
      const hh = { id: 'claude-code', label: 'Claude Code', skills: { state: 'fix', installed: [{ skill: 'my-curator', match: false, differs: ['SKILL.md'], dir: '/h/.claude/skills/my-curator' }] } };
      const ww = V.machineWarnings(hh, { platform: plat });
      ok(`${plat}: the out-of-date skill warning carries the link and says Download`, ww.length === 1 && ww[0].acts.some((a) => zip.test(a)) && /^Download/.test(ww[0].strong), JSON.stringify(ww));
      const setupFix = V.machineWarnings({ id: 'claude-code', label: 'Claude Code', toFix: [{ kind: 'skill', text: 'x', fixes: [{ kind: 'download-skill', skill: 'my-curator' }] }] }, { platform: plat });
      ok(`${plat}: a Setup-check download fix draws its link`, setupFix.length === 1 && setupFix[0].acts.some((a) => zip.test(a)), JSON.stringify(setupFix));
      const model = { id: 'claude-code', label: 'Claude Code', status: 'connected', platform: plat, tool: { skill: { reason: 'outdated', skills: ['my-curator'] } } };
      const items = V.nextStepItems([model]).filter((x) => x.key === 'skill');
      ok(`${plat}: the Next step skill item draws the link`, items.length === 1 && zip.test(items[0].actsHtml || '') && /Download the new version/.test(items[0].html), JSON.stringify(items));
    }
    const unshipped = V.renderSkills({ ...machine, skillsShipped: false }, { platform: 'win32' });
    ok('CONTROL: an install that ships no skills draws no zip link (the route answers 404 there)', !zip.test(unshipped));
    const evil = V.machineWarnings({ id: 'x', label: 'X', toFix: [{ kind: 'skill', text: 'x', fixes: [{ kind: 'download-skill', skill: '../../etc', href: 'https://evil.example/x.zip' }] }] }, { platform: 'win32' });
    ok('CONTROL: only this app\'s own zip route is linked; a payload href is never followed', !/evil\.example|\.\.\//.test(JSON.stringify(evil)), JSON.stringify(evil));
  }
  section('§W11 — Settings › Providers: "0600" is not said on Windows');
  {
    const SRC = readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src/public/next/views/settings.js'), 'utf8');
    const start = SRC.indexOf("((typeof browserPlatform === 'function' && browserPlatform() === 'win32')\n        ? '<span>Keys live in");
    const end = SRC.indexOf("never sent anywhere except the provider you call.</span>'", start);
    const expr = start > 0 && end > start ? SRC.slice(start, SRC.indexOf(') +', SRC.indexOf("at 0600 on this machine", start)) + 1) : null;
    const words = (p) => expr && new Function(...(p === undefined ? [] : ['browserPlatform']), 'return ' + expr + ';')(...(p === undefined ? [] : [() => p]));
    ok('the note is found in settings.js', !!expr);
    ok('win32: no "0600" (chmod protects nothing there), names the user folder', expr && !/0600/.test(words('win32')) && /user folder on this PC/.test(words('win32')), String(words('win32')));
    ok('CONTROL darwin and no platform: the 0600 sentence, unchanged', expr && /at 0600 on this machine/.test(words('darwin')) && words(undefined) === words('darwin'));
  }
} finally {
  server.close();
  process.env.HOME = REAL_HOME;
  const changed = changedSince(REAL_BEFORE);
  ok('the real MCP config files were not touched', changed.length === 0, JSON.stringify(changed));
  rmSync(TMP, { recursive: true, force: true });
}

console.log(`\nPassed: ${passed}   Failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
