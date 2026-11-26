/**
 * test-config-durability.js — OFFLINE suite for the damaged-settings-file rule
 * (v4.1.2, audit findings O2 and B2).
 *
 * ── WHAT IT PINS ────────────────────────────────────────────────────────────
 * Before v4.1.2 an unreadable .curator-config.json read as `{}` and an
 * unreadable .sharedbrain-config.json as `{connections: []}`, and the NEXT
 * ordinary write put that over the file: every API key, the knowledge-folder
 * pointer and the GitHub read token (O2 — dismissing the setup guide was
 * enough), or every Shared Brain connection's PAT and shown-once admin token
 * (B2). No copy, no message. The rule now, for both files:
 *
 *   • MISSING, or EMPTY / whitespace-only → exactly as before (first run).
 *   • DAMAGED (unreadable, not JSON, wrong shape) → reads still answer
 *     "nothing configured" and never throw; a 0600 byte-for-byte copy is kept
 *     beside it once per distinct content; ONE stderr line per content per
 *     process and nothing on stdout; EVERY write refused with code
 *     `config_unreadable`; the damaged bytes never change.
 *   • Setting it aside is a separate explicit act, which verifies the copy
 *     before removing the live file.
 *
 * §9 drives the real POST /api/config/ui-state and /api/config/api-keys
 * routes (the audit's repro: the guide's X, then a key save). §10 spawns the
 * real MCP server over stdio with BOTH files damaged: it must start, answer,
 * and keep its stdout pure JSON-RPC.
 *
 * ── ISOLATION ────────────────────────────────────────────────────────────
 * CURATOR_TEST_USER_DATA_DIR / CURATOR_TEST_DOMAINS_DIR / HOME are tempdirs
 * set BEFORE any app module is imported; CURATOR_NO_OPEN is set. The real
 * credential files of this checkout and of the packaged app are fingerprinted
 * by sha256 + size before and after. No network, no LLM call.
 */

import {
  mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, rmSync, mkdirSync, readdirSync, chmodSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const REAL_FILES = [
  path.join(ROOT, '.curator-config.json'),
  path.join(ROOT, '.sharedbrain-config.json'),
  path.join(homedir(), 'Library', 'Application Support', 'The Curator', '.curator-config.json'),
  path.join(homedir(), 'Library', 'Application Support', 'The Curator', '.sharedbrain-config.json'),
];
const sha = (b) => createHash('sha256').update(b).digest('hex');
const fingerprint = (f) => (existsSync(f) ? sha(readFileSync(f)) + ':' + statSync(f).size : 'absent');
const realBefore = REAL_FILES.map(fingerprint);

const TMP = mkdtempSync(path.join(tmpdir(), 'curator-cfgdur-'));
const USER_DATA = path.join(TMP, 'userdata');
const DOMAINS = path.join(TMP, 'domains');
const HOME = path.join(TMP, 'home');
for (const d of [USER_DATA, DOMAINS, HOME]) mkdirSync(d, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DATA;
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS;
process.env.HOME = HOME;
process.env.CURATOR_NO_OPEN = '1';
for (const k of ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY']) delete process.env[k];

let passed = 0, failed = 0;
// The suite prints through the REAL stdout writer, so its own lines are never
// mistaken for module output while stdout is being captured.
const realStdoutWrite = process.stdout.write.bind(process.stdout);
const print = (s) => realStdoutWrite(s + '\n');
function ok(cond, label, detail) {
  if (cond) { passed++; print('  ✓ ' + label); }
  else { failed++; print('  ✗ ' + label + (detail ? `\n      ${detail}` : '')); }
}
const section = (t) => print('\n' + t);

// Capture stderr lines and stdout writes made by the modules under test.
const stderrLines = [];
const origError = console.error;
console.error = (...a) => { stderrLines.push(a.join(' ')); };
const stdoutWrites = [];
const origStdoutWrite = process.stdout.write.bind(process.stdout);
let captureStdout = false;
process.stdout.write = (chunk, ...rest) => {
  if (captureStdout) { stdoutWrites.push(String(chunk)); return true; }
  return origStdoutWrite(chunk, ...rest);
};

const config = await import('../src/brain/config.js');
const sbc = await import('../src/brain/sharedbrain-config.js');
const paths = await import('../src/brain/paths.js');

const CFG = paths.getCuratorConfigFile();
const SBC = paths.getSharedBrainConfigFile();
ok(CFG.startsWith(USER_DATA + path.sep) && SBC.startsWith(USER_DATA + path.sep), '§0 both settings files resolve inside the test tempdir', `${CFG} ${SBC}`);

const copiesOf = (file) => readdirSync(path.dirname(file)).filter((n) => n.startsWith(path.basename(file) + '.unreadable-'));
const mode = (f) => statSync(f).mode & 0o777;
const isWin = process.platform === 'win32';
function clean() {
  for (const n of readdirSync(USER_DATA)) rmSync(path.join(USER_DATA, n), { recursive: true, force: true });
  stderrLines.length = 0;
}
function refused(fn) {
  try { fn(); return null; } catch (e) { return e; }
}

const KEYS = {
  geminiApiKey: 'AIza' + 'x'.repeat(35), anthropicApiKey: 'sk-ant-' + 'y'.repeat(40),
  domainsPath: DOMAINS, activeProvider: 'gemini', githubReadToken: 'github_pat_' + 'z'.repeat(70),
};
const BROKEN = JSON.stringify(KEYS, null, 2).replace('"activeProvider"', '"activeProvider" BROKEN');

// ── §1 Missing file: first run, unchanged ──────────────────────────────────
section('§1 A missing .curator-config.json behaves exactly as before');
clean();
{
  ok(config.getConfigFileStatus().state === 'missing', 'status says missing');
  const { state } = config.setUiState({ onboardingDismissed: '1' });
  ok(state.onboardingDismissed === '1', 'the first write creates the file');
  ok(JSON.parse(readFileSync(CFG, 'utf8')).ui.onboardingDismissed === '1', '…with the value on disk');
  if (!isWin) ok(mode(CFG) === 0o600, '…at mode 0600', mode(CFG).toString(8));
  ok(copiesOf(CFG).length === 0 && stderrLines.length === 0, 'no copy, no message');
}

// ── §2 Empty file: treated as missing ──────────────────────────────────────
section('§2 An empty or whitespace-only file holds nothing, so it is not "damaged"');
for (const body of ['', '  \n\t\n']) {
  clean();
  writeFileSync(CFG, body);
  ok(config.getConfigFileStatus().state === 'missing', `status missing for ${JSON.stringify(body)}`);
  config.setUiState({ onboardingDismissed: '1' });
  ok(JSON.parse(readFileSync(CFG, 'utf8')).ui.onboardingDismissed === '1', '…and a write goes through');
  ok(copiesOf(CFG).length === 0, '…with no copy');
}

// ── §3 Unparseable: every writer refuses, bytes untouched, one copy ────────
section('§3 An unparseable .curator-config.json is never overwritten');
clean();
{
  writeFileSync(CFG, BROKEN);
  const before = readFileSync(CFG);
  captureStdout = true;
  // Reads: never throw, answer "nothing configured".
  let readErr = null;
  try {
    for (let i = 0; i < 25; i++) {
      config.getConfig(); config.getApiKeys(); config.getDomainsDir(); config.getUiState();
      config.getActiveProvider(); config.getGithubReadTokenStatus(); config.getContextWindowSettings();
    }
  } catch (e) { readErr = e; }
  ok(!readErr, 'reads never throw', readErr && readErr.stack);
  ok(!config.getApiKeys().geminiApiKey, 'reads answer "no key" (unchanged from before)');

  const writers = {
    'setUiState (the guide\'s X)': () => config.setUiState({ onboardingDismissed: '1' }),
    setApiKeys: () => config.setApiKeys({ geminiApiKey: 'AIza' + 'q'.repeat(35) }),
    clearApiKey: () => config.clearApiKey('gemini'),
    setDomainsDir: () => config.setDomainsDir(DOMAINS),
    setDefaultDomain: () => config.setDefaultDomain(null),
    setSharedBrainEnabled: () => config.setSharedBrainEnabled(true),
    setSetupTools: () => config.setSetupTools(['claude-code']),
    setSelectedModel: () => config.setSelectedModel('gemini', 'gemini-x'),
    addModelMigrationNotes: () => config.addModelMigrationNotes([{ lane: 'build', provider: 'gemini', from: 'a', to: 'b', at: new Date().toISOString(), text: 't' }]),
    setAiHealthSettings: () => config.setAiHealthSettings({ costCeilingTokens: 100000 }),
    setBackgroundMode: () => config.setBackgroundMode(config.backgroundModeNames()[0]),
    setGithubReadToken: () => config.setGithubReadToken('github_pat_' + 'w'.repeat(70)),
  };
  for (const [name, fn] of Object.entries(writers)) {
    const e = refused(fn);
    ok(e && e.code === 'config_unreadable', `${name} is refused with code config_unreadable`, e ? e.message : 'it WROTE');
    ok(Buffer.compare(before, readFileSync(CFG)) === 0, `…and the file is byte-identical after ${name}`);
  }
  // A writer with nothing to change on an empty read never writes at all.
  config.dismissModelMigrationNotes();
  ok(Buffer.compare(before, readFileSync(CFG)) === 0, 'dismissModelMigrationNotes (nothing to dismiss) leaves the file alone');
  const cw = config.setContextWindowSettings({ contextWindowTokens: null });
  ok(cw.ok === false && cw.reason === 'config_unreadable', 'setContextWindowSettings refuses (its own reason, as before)');
  captureStdout = false;

  const copies = copiesOf(CFG);
  ok(copies.length === 1, 'exactly ONE copy is kept, however many reads and writes', copies.join(','));
  const copyAbs = path.join(USER_DATA, copies[0] || 'none');
  ok(copies[0] === `.curator-config.json.unreadable-${sha(before).slice(0, 12)}`, 'the copy is named by its content hash', copies[0]);
  ok(existsSync(copyAbs) && Buffer.compare(readFileSync(copyAbs), before) === 0, 'the copy is byte-for-byte the damaged file');
  if (!isWin) ok(existsSync(copyAbs) && mode(copyAbs) === 0o600, 'the copy is 0600');
  ok(!copyAbs.startsWith(DOMAINS), 'the copy is outside the knowledge folder');
  const lines = stderrLines.filter((l) => l.includes('.curator-config.json'));
  ok(lines.length === 1, 'ONE stderr line for the damaged content, not one per read', String(lines.length));
  ok(lines[0] && /could not be read/.test(lines[0]) && lines[0].includes(copies[0]), '…which names the problem and the copy', lines[0]);
  ok(!lines.join('').includes(KEYS.geminiApiKey.slice(0, 12)), '…and carries none of the file\'s content');
  ok(stdoutWrites.length === 0, 'nothing reached stdout', stdoutWrites.join('|').slice(0, 200));

  const e = refused(() => config.setUiState({ onboardingDismissed: '1' }));
  ok(e && /\.curator-config\.json/.test(e.message) && e.message.includes(copies[0]) && !e.message.includes(USER_DATA),
    'the refusal names the file and the copy by basename, never an absolute path', e && e.message);
  ok(e && !e.message.includes(KEYS.geminiApiKey.slice(0, 12)), '…and no part of the file\'s content');

  const st = config.getConfigFileStatus();
  ok(st.state === 'damaged' && st.reason === 'parse' && st.backup === copies[0] && st.file === '.curator-config.json',
    'getConfigFileStatus reports damaged / parse / the copy', JSON.stringify(st));

  // A second, different damage gets its own copy (the first is kept).
  writeFileSync(CFG, BROKEN + ' more');
  config.getConfig();
  ok(copiesOf(CFG).length === 2 && existsSync(copyAbs), 'a different damaged content gets a second copy; the first stays');
}

// ── §4 Parsed, but not a settings object ───────────────────────────────────
section('§4 JSON of the wrong shape is damaged too (null used to crash every getter)');
for (const body of ['null', '[1,2]', '"text"', '42']) {
  clean();
  writeFileSync(CFG, body);
  let e = null;
  try { config.getConfig(); config.getDomainsDir(); config.getApiKeys(); config.getUiState(); } catch (x) { e = x; }
  ok(!e, `reads never throw for ${body}`, e && e.message);
  const w = refused(() => config.setUiState({ onboardingDismissed: '1' }));
  ok(w && w.code === 'config_unreadable' && readFileSync(CFG, 'utf8') === body, `…a write is refused and ${body} is untouched`);
  ok(config.getConfigFileStatus().reason === 'shape', '…status reason is shape');
}

// ── §5 A byte-order mark is read, not refused ──────────────────────────────
section('§5 A file saved with a UTF-8 BOM (Notepad) is read');
clean();
{
  writeFileSync(CFG, '﻿' + JSON.stringify({ geminiApiKey: KEYS.geminiApiKey, domainsPath: DOMAINS }));
  ok(config.getApiKeys().geminiApiKey === KEYS.geminiApiKey, 'the key is read through the BOM');
  config.setUiState({ onboardingDismissed: '1' });
  const j = JSON.parse(readFileSync(CFG, 'utf8'));
  ok(j.geminiApiKey === KEYS.geminiApiKey && j.domainsPath === DOMAINS && j.ui.onboardingDismissed === '1', 'a write keeps every key');
}

// ── §6 Present but unreadable ──────────────────────────────────────────────
section('§6 A file that exists but cannot be opened refuses writes');
clean();
if (!isWin && process.getuid && process.getuid() !== 0) {
  writeFileSync(CFG, JSON.stringify(KEYS));
  chmodSync(CFG, 0o000);
  const st = config.getConfigFileStatus();
  ok(st.state === 'damaged' && st.reason === 'read' && st.backup === null, 'status damaged / read / no copy possible', JSON.stringify(st));
  const e = refused(() => config.setUiState({ onboardingDismissed: '1' }));
  ok(e && e.code === 'config_unreadable', 'a write is refused');
  const sa = config.setAsideDamagedConfig();
  ok(sa.setAside === false && sa.reason === 'unreadable_bytes', 'set-aside refuses: nothing could be kept, so nothing is removed');
  chmodSync(CFG, 0o600);
  ok(JSON.parse(readFileSync(CFG, 'utf8')).geminiApiKey === KEYS.geminiApiKey, 'the file is intact');
} else {
  ok(true, '(skipped: running as root or on Windows, where mode 000 does not block a read)');
}

// ── §7 Status and the explicit set-aside ───────────────────────────────────
section('§7 Set aside: copy verified first, then the live file goes, then a fresh start');
clean();
{
  writeFileSync(CFG, JSON.stringify(KEYS));
  ok(config.setAsideDamagedConfig().reason === 'not_damaged', 'a healthy file is never set aside');
  writeFileSync(CFG, BROKEN);
  const before = readFileSync(CFG);
  // The copy's place is taken by something that is not a copy: set-aside must
  // check what it kept, and refuse rather than remove the only good bytes.
  const blocker = path.join(USER_DATA, `.curator-config.json.unreadable-${sha(before).slice(0, 12)}`);
  mkdirSync(blocker);
  const blocked = config.setAsideDamagedConfig();
  ok(blocked.setAside === false && blocked.reason === 'copy_failed' && existsSync(CFG)
    && Buffer.compare(before, readFileSync(CFG)) === 0, 'a copy that cannot be verified stops the set-aside; the file stays', JSON.stringify(blocked));
  rmSync(blocker, { recursive: true });
  const r = config.setAsideDamagedConfig();
  ok(r.setAside === true && !existsSync(CFG), 'the damaged file is set aside', JSON.stringify(r));
  ok(Buffer.compare(readFileSync(path.join(USER_DATA, r.backup)), before) === 0, 'its copy holds every byte');
  config.setUiState({ onboardingDismissed: '1' });
  ok(JSON.parse(readFileSync(CFG, 'utf8')).ui.onboardingDismissed === '1', 'the next write starts a fresh file');
  ok(config.setAsideDamagedConfig().reason === 'not_damaged', 'set-aside on the fresh file does nothing');
}

// ── §8 .sharedbrain-config.json (B2) ───────────────────────────────────────
section('§8 A damaged .sharedbrain-config.json is never overwritten');
const uuid = () => sbc.newUuid();
const conn = (slug) => ({
  id: uuid(), label: `Brain ${slug}`, storage_type: 'local', local_storage_path: path.join(TMP, 'store-' + slug),
  fellow_id: uuid(), fellow_display_name: 'Test', shared_domain: slug, shared_brain_slug: slug, local_domains: [],
  admin_token: 'adm-' + slug + '-' + 'a'.repeat(30),
});
clean();
{
  ok(sbc.getSharedBrainConfigFileStatus().state === 'missing', 'missing at first');
  const a = conn('alpha'), b = conn('beta');
  sbc.saveSharedBrain(a); sbc.saveSharedBrain(b);
  ok(sbc.getSharedBrains().length === 2, 'a missing file is created on first save, as before');
  if (!isWin) ok(mode(SBC) === 0o600, '…at 0600');

  const good = readFileSync(SBC, 'utf8');
  writeFileSync(SBC, good.slice(0, good.length - 20));   // truncated
  const before = readFileSync(SBC);
  captureStdout = true;
  let e0 = null;
  try { for (let i = 0; i < 10; i++) { sbc.getSharedBrains(); sbc.getSharedBrainWithToken(a.id); } } catch (x) { e0 = x; }
  ok(!e0 && sbc.getSharedBrains().length === 0, 'reads answer "no connections" and never throw');
  const ops = {
    'save a new connection': () => sbc.saveSharedBrain(conn('gamma')),
    'remove': () => sbc.removeSharedBrain(a.id),
    'patch': () => sbc.patchSharedBrain(a.id, { last_push_at: 'x' }),
    'replace a token': () => sbc.replaceSharedBrainPat(a.id, 'p'.repeat(30)),
  };
  for (const [name, fn] of Object.entries(ops)) {
    const e = refused(fn);
    // remove/patch on an empty read find nothing and do not write at all;
    // the property that matters is that no path writes over the file.
    ok(Buffer.compare(before, readFileSync(SBC)) === 0, `${name}: the file is byte-identical`, e && e.message);
  }
  const es = refused(() => sbc.saveSharedBrain(conn('gamma')));
  ok(es && es.code === 'config_unreadable' && /Shared Brain connections file/.test(es.message), 'a save is refused with config_unreadable', es && es.message);
  captureStdout = false;
  ok(stdoutWrites.length === 0, 'nothing reached stdout');
  const copies = copiesOf(SBC);
  ok(copies.length === 1 && Buffer.compare(readFileSync(path.join(USER_DATA, copies[0])), before) === 0, 'one byte-for-byte copy is kept');
  if (!isWin) ok(copies.length === 1 && mode(path.join(USER_DATA, copies[0])) === 0o600, '…at 0600');
  ok(stderrLines.filter((l) => l.includes('.sharedbrain-config.json')).length === 1, 'one stderr line');
  ok(!stderrLines.join('').includes('adm-alpha'), '…carrying no token');
  const st = sbc.getSharedBrainConfigFileStatus();
  ok(st.state === 'damaged' && st.reason === 'parse' && st.backup === copies[0], 'status reports it', JSON.stringify(st));

  const r = sbc.setAsideDamagedSharedBrainConfig();
  ok(r.setAside && !existsSync(SBC), 'set aside on request');
  sbc.saveSharedBrain(conn('delta'));
  ok(sbc.getSharedBrains().length === 1, 'and the next save starts fresh');
}
for (const body of ['{"connections": {}}', '{"links": []}', '{"connections": [null]}', '[]', 'null']) {
  clean();
  writeFileSync(SBC, body);
  let e = null;
  try { sbc.getSharedBrains(); sbc.getSharedBrainWithToken(uuid()); } catch (x) { e = x; }
  ok(!e, `reads never throw for ${body}`, e && e.message);
  const w = refused(() => sbc.saveSharedBrain(conn('eps')));
  ok(w && w.code === 'config_unreadable' && readFileSync(SBC, 'utf8') === body, `…a save is refused and ${body} is untouched`, w && w.message);
}
for (const body of ['{}', '', '\n']) {
  clean();
  writeFileSync(SBC, body);
  sbc.saveSharedBrain(conn('zeta'));
  ok(sbc.getSharedBrains().length === 1, `${JSON.stringify(body)} holds nothing, so a save goes through`);
}

// ── §9 Over HTTP: the audit's repro ────────────────────────────────────────
section('§9 Over the real routes: the guide\'s X and a key save leave the file alone');
clean();
{
  const express = (await import('express')).default;
  const router = (await import('../src/routes/config.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/config', router);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    writeFileSync(CFG, BROKEN);
    const before = readFileSync(CFG);
    const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const r1 = await post('/api/config/ui-state', { onboardingDismissed: '1' });
    const j1 = await r1.json();
    ok(r1.status >= 400 && /could not be read/.test(j1.error || j1.message || ''), 'POST /ui-state answers with the refusal', `${r1.status} ${JSON.stringify(j1)}`);
    ok(Buffer.compare(before, readFileSync(CFG)) === 0, '…and the file is byte-identical');
    const r2 = await post('/api/config/api-keys', { geminiApiKey: 'AIza' + 'n'.repeat(35) });
    const j2 = await r2.json();
    ok(r2.status >= 400 && /could not be read/.test(j2.error || j2.message || ''), 'POST /api-keys answers with the refusal', `${r2.status} ${JSON.stringify(j2)}`);
    ok(Buffer.compare(before, readFileSync(CFG)) === 0, '…and every key in the file survives');
    const g = await fetch(base + '/api/config/api-keys');
    ok(g.status === 200, 'GET /api-keys still answers (reads never throw)');
  } finally {
    server.close();
  }
}

// ── §10 The MCP starts and answers with both files damaged ─────────────────
section('§10 The MCP server starts, answers, and keeps stdout clean with both files damaged');
clean();
{
  writeFileSync(CFG, BROKEN);
  writeFileSync(SBC, '{"connections": [ BROKEN');
  const cfgBefore = readFileSync(CFG), sbcBefore = readFileSync(SBC);
  const child = spawn(process.execPath, [path.join(ROOT, 'mcp/server.js')], {
    env: { ...process.env, CURATOR_TEST_DOMAINS_DIR: DOMAINS, CURATOR_TEST_USER_DATA_DIR: USER_DATA, HOME },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '', err = '';
  const nonJson = [];
  let id = 0;
  const waiting = new Map();
  child.stderr.on('data', (c) => { err += c; });
  child.stdout.on('data', (c) => {
    out += c.toString();
    let nl;
    while ((nl = out.indexOf('\n')) >= 0) {
      const line = out.slice(0, nl); out = out.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { nonJson.push(line); continue; }
      if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const myId = ++id;
    const t = setTimeout(() => reject(new Error('MCP timeout on ' + method + '\n' + err.slice(-500))), 30000);
    waiting.set(myId, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
  });
  try {
    const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'cfg-durability', version: '1' } });
    ok(init.result && init.result.serverInfo, 'initialize answers');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const res = await rpc('tools/call', { name: 'list_domains', arguments: {} });
    ok(res.result && !res.error, 'list_domains answers', JSON.stringify(res).slice(0, 300));
    ok(nonJson.length === 0, 'every stdout line is JSON-RPC', nonJson.join('|').slice(0, 300));
    ok(child.exitCode === null, 'the server is still running');
  } catch (e) {
    ok(false, 'the MCP conversation completed', e.message);
  } finally {
    child.kill();
  }
  ok(Buffer.compare(cfgBefore, readFileSync(CFG)) === 0 && Buffer.compare(sbcBefore, readFileSync(SBC)) === 0, 'neither damaged file changed');
}

// ── Done ───────────────────────────────────────────────────────────────────
console.error = origError;
process.stdout.write = origStdoutWrite;
const realAfter = REAL_FILES.map(fingerprint);
ok(realAfter.every((v, i) => v === realBefore[i]), 'the real credential files are byte-identical to before the run');
rmSync(TMP, { recursive: true, force: true });
print(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
