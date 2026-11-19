#!/usr/bin/env node
/**
 * test-sharedbrain-replace-token.js — OFFLINE. Shared Brain "Replace token"
 * (v3.99.2).
 *
 * THE DEFECT. When GitHub rejected a Shared Brain connection's GitHub token,
 * there was no way to give it a new one: a member was told "Leave this Shared
 * Brain and re-join with your invite", an admin "+ Set up another and run the
 * setup again" — and the app REFUSES a second connection to the same brain
 * (connectionClash). An independent audit proved that end to end.
 *
 * WHAT IS PROVED HERE, over REAL HTTP: the real server (src/server.js) is
 * spawned, isolated (CURATOR_TEST_USER_DATA_DIR, CURATOR_TEST_DOMAINS_DIR,
 * CURATOR_NO_OPEN), and talks to a FAKE GitHub API on 127.0.0.1 through the
 * loopback-only test seam CURATOR_TEST_GITHUB_API (sharedbrain-storage-factory).
 *   §1  the seam: honoured only for a plain-http loopback origin.
 *   §2  every refusal (missing, not a token, rejected 401, no access 403/404,
 *       read-only for a pushing connection, rate limited, GitHub 5xx,
 *       unreachable, a folder-backed brain, a save that cannot be written)
 *       answers its code and leaves .sharedbrain-config.json sha256-identical;
 *       an unknown or malformed id is 404/400; the cross-origin guard refuses
 *       a foreign Origin before GitHub is asked; a running write is a 409.
 *   §3  success, admin: only github_pat changed — the file is byte-identical
 *       to the old one with the old token swapped for the new — 0600; id,
 *       fellow_id, admin_token, read_only unchanged; the members read and a
 *       Pull that follow carry the NEW token to GitHub.
 *   §4  success, read-only member: a read-only token is enough for a
 *       Pull-only connection, and the flag is not changed.
 *   §5  the token is in no response, no server output, no log file; a token
 *       GitHub echoes back is scrubbed from the detail.
 *   §6  the view: the panel opens on a rejected verdict and on an action's
 *       github-token-rejected error, not on another code, closes for the
 *       rejection Cancel dismissed and reopens for the next; the input has no
 *       value attribute; the handler clears the token from state and the field
 *       before the request and keeps only the plain refusal.
 *   §7  the real credential files of this checkout were never touched.
 *
 * Tokens are assembled from parts (the pre-commit secret guard).
 * Run: node scripts/test-sharedbrain-replace-token.js
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import net from 'net';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
const failures = [];
function ok(cond, label, extra) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; failures.push(label); console.log(`  ✗ ${label}${extra !== undefined ? `\n        ${typeof extra === 'string' ? extra : JSON.stringify(extra)}` : ''}`); }
}
function section(t) { console.log(`\n${t}`); }
setTimeout(() => { console.log('  ✗ watchdog: the suite did not finish in 100 s'); process.exit(1); }, 100_000).unref();

function extractFunction(src, name, where) {
  const m = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ${name}\\s*\\(`).exec(src);
  if (!m) throw new Error(`extractFunction: "${name}" not found in ${where}`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  let i = src.indexOf('(', start);
  let pd = 0;
  for (; i < src.length; i++) { if (src[i] === '(') pd++; else if (src[i] === ')') { pd--; if (pd === 0) { i++; break; } } }
  i = src.indexOf('{', i);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const out = src.slice(start, i);
  if (!/\n\}$/.test(out)) throw new Error(`extractFunction: "${name}" desynced in ${where}`);
  return out.replace(/^export\s+/, '');
}

async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

// ── Isolation ─────────────────────────────────────────────────────────────
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'curator-sbtoken-')));
const TMP_USER = path.join(TMP, 'userdata');
const TMP_DOMAINS = path.join(TMP, 'domains');
const LOG_DIR = path.join(TMP_USER, 'logs');
fs.mkdirSync(TMP_USER, { recursive: true });
fs.mkdirSync(path.join(TMP_DOMAINS, 'research', 'wiki', 'entities'), { recursive: true });
fs.writeFileSync(path.join(TMP_DOMAINS, 'research', 'CLAUDE.md'), 'schema\n');
fs.writeFileSync(path.join(TMP_DOMAINS, 'research', 'wiki', 'index.md'), '# Index\n');
fs.writeFileSync(path.join(TMP_USER, '.curator-config.json'), JSON.stringify({ sharedBrainEnabled: true }, null, 2));
const SB_FILE = path.join(TMP_USER, '.sharedbrain-config.json');

const REAL_FILES = ['.curator-config.json', '.sync-config.json', '.sharedbrain-config.json'].map((f) => path.join(ROOT, f));
const fingerprintReal = () => REAL_FILES.map((f) => (fs.existsSync(f)
  ? `${path.basename(f)}:${createHash('sha256').update(fs.readFileSync(f)).digest('hex')}` : `${path.basename(f)}:absent`)).join('|');
const realBefore = fingerprintReal();
const sha = (f) => (fs.existsSync(f) ? createHash('sha256').update(fs.readFileSync(f)).digest('hex') : 'absent');

// Synthetic tokens, assembled from parts.
const P = 'gh' + 'p_';
const T = (tag, ch) => P + tag + ch.repeat(33);
const OLD = T('old', 'A');          // the stored token; GitHub now rejects it
const NEW = T('new', 'B');          // accepted, can write
const BAD = T('bad', 'C');          // 401
const NOACC = T('nac', 'D');        // 404
const FORB = T('frb', 'E');         // 403, not a rate limit
const RO = T('rdo', 'F');           // accepted, read-only
const LIMIT = T('lim', 'G');        // 403 with the rate limit exhausted
const BOOM = T('bom', 'H');         // 500
const DROP = T('drp', 'J');         // the connection is dropped (unreachable)
const HEX = 'abcdef0123456789abcdef0123456789abcd' + 'ef01';   // a classic 40-hex token, which GitHub echoes back (401)
const NEW2 = T('nw2', 'K');         // accepted, can write (the read-only member)
const ALL = [OLD, NEW, BAD, NOACC, FORB, RO, LIMIT, BOOM, DROP, HEX, NEW2];
const leaks = (text) => ALL.filter((t) => String(text).includes(t));

// ── The fake GitHub API ───────────────────────────────────────────────────
const fake = { log: [], hold: null };
const ghServer = http.createServer((req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  fake.log.push({ method: req.method, url: req.url, token });
  const json = (status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
  if (token === DROP) { req.socket.destroy(); return; }
  if (token === OLD || token === BAD) return json(401, { message: 'Bad credentials' });
  if (token === HEX) return json(401, { message: 'Bad credentials for ' + HEX });
  if (token === NOACC) return json(404, { message: 'Not Found' });
  if (token === FORB) return json(403, { message: 'Resource not accessible by personal access token' });
  if (token === LIMIT) return json(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1' });
  if (token === BOOM) return json(500, { message: 'Server Error' });
  const okToken = token === NEW || token === RO || token === NEW2;
  if (!okToken) return json(401, { message: 'Bad credentials' });
  const u = new URL(req.url, 'http://x');
  if (/^\/repos\/[^/]+\/[^/]+$/.test(u.pathname)) {
    const [, , owner, name] = u.pathname.split('/');
    return json(200, { full_name: owner + '/' + name, private: true, default_branch: 'main', permissions: { pull: true, push: token !== RO, admin: false } });
  }
  if (/\/git\/trees\//.test(u.pathname)) {
    const answer = () => json(200, { sha: 'f'.repeat(40), tree: [], truncated: false });
    if (fake.hold) { fake.hold.push(answer); return; }
    return answer();
  }
  return json(404, { message: 'Not Found' });
});
await new Promise((r) => ghServer.listen(0, '127.0.0.1', r));
const GH_BASE = `http://127.0.0.1:${ghServer.address().port}`;

// ── The real server ───────────────────────────────────────────────────────
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
let serverOut = '';
const server = spawn(process.execPath, [path.join(ROOT, 'src/server.js')], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), CURATOR_NO_OPEN: '1', CURATOR_TEST_USER_DATA_DIR: TMP_USER,
    CURATOR_TEST_DOMAINS_DIR: TMP_DOMAINS, CURATOR_TEST_LOG_DIR: LOG_DIR,
    CURATOR_TEST_MCP_LAUNCHER_DIR: path.join(TMP_USER, 'bin'), CURATOR_TEST_GITHUB_API: GH_BASE,
    DOMAINS_PATH: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (c) => { serverOut += c; });
server.stderr.on('data', (c) => { serverOut += c; });

function request(method, p, body, headers = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method,
      headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => {
      let t = ''; res.on('data', (d) => { t += d; });
      res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch { /* SSE or text */ } resolve({ status: res.statusCode, text: t, json: j }); });
    });
    r.on('error', (e) => resolve({ status: 0, text: String(e), json: null }));
    if (data) r.write(data);
    r.end();
  });
}
const responses = [];
const post = async (p, body, headers) => { const r = await request('POST', p, body, headers); responses.push(r.text); return r; };

try {
  for (let i = 0; i < 100; i++) {
    const r = await request('GET', '/api/sharedbrain/feature-flag');
    if (r.status === 200) break;
    await new Promise((res) => setTimeout(res, 100));
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§1  The test seam is loopback-only');
  // ═══════════════════════════════════════════════════════════════════════
  {
    const { testGithubApiBase } = await import('../src/brain/sharedbrain-storage-factory.js');
    const was = process.env.CURATOR_TEST_GITHUB_API;
    const at = (v) => { if (v === undefined) delete process.env.CURATOR_TEST_GITHUB_API; else process.env.CURATOR_TEST_GITHUB_API = v; return testGithubApiBase(); };
    ok(at(undefined) === null, 'unset: null (production uses api.github.com)');
    ok(at('http://127.0.0.1:9') === 'http://127.0.0.1:9', 'a plain-http loopback origin is honoured');
    for (const v of ['https://127.0.0.1:9', 'http://example.com', 'http://127.0.0.1:9/path', 'http://user:pw@127.0.0.1:9', 'not a url', 'http://10.0.0.1']) {
      ok(at(v) === null, `ignored: ${v}`);
    }
    if (was === undefined) delete process.env.CURATOR_TEST_GITHUB_API; else process.env.CURATOR_TEST_GITHUB_API = was;
  }

  // ── Seed: an admin's connection, a read-only member's, a folder brain ──
  const ADMIN_TOKEN = 'sbat_' + 'Z'.repeat(40);
  const saveConn = async (c) => (await post('/api/sharedbrain/save', { connection: c })).json;
  const adminSaved = await saveConn({
    label: 'Cohort', storage_type: 'github', github_repo_owner: 'acme', github_repo_name: 'cohort-brain',
    github_pat: OLD, github_branch: 'main', fellow_display_name: 'A', shared_domain: 'work', shared_brain_slug: 'cohort',
    local_domains: ['research'], attribute_by_name: false, read_only: false, admin_token: ADMIN_TOKEN,
    data_handling_terms: 'contributor_retains', enabled: true,
  });
  const roSaved = await saveConn({
    label: 'Readers', storage_type: 'github', github_repo_owner: 'acme', github_repo_name: 'readers',
    github_pat: OLD, fellow_display_name: 'B', shared_domain: 'notes', shared_brain_slug: 'readers',
    local_domains: [], read_only: true, enabled: true,
  });
  const localSaved = await saveConn({
    label: 'Folder', storage_type: 'local', local_storage_path: path.join(TMP, 'folder-brain'),
    fellow_display_name: 'C', shared_domain: 'x', shared_brain_slug: 'folder', local_domains: [], enabled: true,
  });
  const ADMIN_ID = adminSaved && adminSaved.connection && adminSaved.connection.id;
  const RO_ID = roSaved && roSaved.connection && roSaved.connection.id;
  const LOCAL_ID = localSaved && localSaved.connection && localSaved.connection.id;
  ok(!!ADMIN_ID && !!RO_ID && !!LOCAL_ID, 'control: three connections saved through the real /save', { adminSaved, roSaved, localSaved });
  fs.chmodSync(SB_FILE, 0o600);
  const stored = () => JSON.parse(fs.readFileSync(SB_FILE, 'utf8')).connections;

  // ═══════════════════════════════════════════════════════════════════════
  section('§2  Every refusal changes nothing');
  // ═══════════════════════════════════════════════════════════════════════
  const refuse = async (label, id, body, wantStatus, wantCode, headers) => {
    const before = sha(SB_FILE);
    const r = await post(`/api/sharedbrain/${id}/token`, body, headers);
    ok(r.status === wantStatus && (!wantCode || (r.json && r.json.code === wantCode)),
      `${label}: ${wantStatus}${wantCode ? ' ' + wantCode : ''}`, { status: r.status, body: r.json || r.text });
    ok(sha(SB_FILE) === before, `${label}: .sharedbrain-config.json is sha256-identical`);
    ok(leaks(r.text).length === 0, `${label}: no token in the response`, leaks(r.text));
    return r;
  };
  {
    const n0 = fake.log.length;
    await refuse('foreign Origin', ADMIN_ID, { token: NEW }, 403, null, { Origin: 'http://evil.example' });
    ok(fake.log.length === n0, 'foreign Origin: GitHub was never asked');
  }
  await refuse('missing token', ADMIN_ID, {}, 400, 'sharedbrain-token-missing');
  await refuse('blank token', ADMIN_ID, { token: '   ' }, 400, 'sharedbrain-token-missing');
  await refuse('not a token', ADMIN_ID, { token: 'my password is hunter2' }, 400, 'sharedbrain-token-invalid');
  await refuse('a masked display value', ADMIN_ID, { token: OLD.slice(0, 8) + '…' }, 400, 'sharedbrain-token-invalid');
  const rej = await refuse('rejected (401)', ADMIN_ID, { token: BAD }, 400, 'sharedbrain-new-token-rejected');
  ok(rej.json && /didn’t accept the new token/.test(rej.json.error) && /Nothing was changed/.test(rej.json.error)
    && /→ 401: Bad credentials/.test(rej.json.detail || ''), 'rejected: the plain sentence, GitHub\'s own answer as the detail', rej.json);
  const na = await refuse('no access (404)', ADMIN_ID, { token: NOACC }, 400, 'sharedbrain-new-token-no-access');
  ok(na.json && na.json.error.includes('acme/cohort-brain'), 'no access: names the repository', na.json);
  await refuse('no access (403, not a rate limit)', ADMIN_ID, { token: FORB }, 400, 'sharedbrain-new-token-no-access');
  const roR = await refuse('read-only token for an admin (who pushes)', ADMIN_ID, { token: RO }, 400, 'sharedbrain-new-token-read-only');
  ok(roR.json && /Read and write/.test(roR.json.error), 'read-only: says what the token needs', roR.json);
  await refuse('rate limited', ADMIN_ID, { token: LIMIT }, 503, 'sharedbrain-token-check-rate-limited');
  await refuse('GitHub 5xx', ADMIN_ID, { token: BOOM }, 502, 'sharedbrain-token-check-failed');
  await refuse('GitHub unreachable', ADMIN_ID, { token: DROP }, 502, 'sharedbrain-token-check-offline');
  await refuse('a folder-backed brain', LOCAL_ID, { token: NEW }, 409, 'sharedbrain-token-not-github');
  await refuse('unknown id', '00000000-0000-4000-8000-000000000000', { token: NEW }, 404, null);
  await refuse('malformed id', 'not-a-uuid', { token: NEW }, 400, null);
  {
    const echo = await refuse('a token GitHub echoes back', ADMIN_ID, { token: HEX }, 400, 'sharedbrain-new-token-rejected');
    ok(echo.json && typeof echo.json.detail === 'string' && echo.json.detail.includes('***') && !echo.json.detail.includes(HEX),
      'the echoed token is scrubbed from the detail', echo.json);
  }
  // A save that cannot be written: the user-data folder is read-only, so the
  // atomic write's temp file cannot be created. The check has passed.
  {
    fs.chmodSync(TMP_USER, 0o500);
    try {
      const sf = await refuse('the save cannot be written', ADMIN_ID, { token: NEW }, 500, 'sharedbrain-token-save-failed');
      ok(sf.json && /works, but The Curator couldn’t save it/.test(sf.json.error), 'save failed: says the token works and nothing was changed', sf.json);
    } finally { fs.chmodSync(TMP_USER, 0o700); }
  }
  // A running write (a Pull held mid-tree by the fake): refused with 409.
  {
    fake.hold = [];
    // The read-only connection's token is still OLD (rejected), so pull with the
    // admin connection is not possible either; give the hold a reachable read:
    // the members read uses the stored token, so use a Pull on a connection
    // whose stored token works — saved here for the purpose, removed after.
    const tmpSaved = await saveConn({
      label: 'Busy', storage_type: 'github', github_repo_owner: 'acme', github_repo_name: 'busy',
      github_pat: NEW, fellow_display_name: 'D', shared_domain: 'busy', shared_brain_slug: 'busy',
      local_domains: [], read_only: true, enabled: true,
    });
    const BUSY_ID = tmpSaved.connection.id;
    const pullDone = request('POST', `/api/sharedbrain/${BUSY_ID}/pull`, {});
    for (let i = 0; i < 50 && fake.hold.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    ok(fake.hold.length > 0, 'control: a Pull is in flight, held at GitHub');
    await refuse('while a Pull is writing', ADMIN_ID, { token: NEW }, 409, null);
    const held = fake.hold; fake.hold = null; held.forEach((f) => f());
    await pullDone;
    await request('DELETE', `/api/sharedbrain/${BUSY_ID}`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§3  Success (admin): only the token changes');
  // ═══════════════════════════════════════════════════════════════════════
  {
    const beforeText = fs.readFileSync(SB_FILE, 'utf8');
    const beforeConn = stored().find((c) => c.id === ADMIN_ID);
    const r = await post(`/api/sharedbrain/${ADMIN_ID}/token`, { token: '  ' + NEW + '\n' });
    ok(r.status === 200 && r.json && r.json.replaced === true && r.json.repo === 'acme/cohort-brain', 'POST /:id/token answers replaced', r.json);
    ok(leaks(r.text).length === 0, 'the success carries no token', r.text);
    const afterText = fs.readFileSync(SB_FILE, 'utf8');
    // The expected file: the old one, parsed, with ONLY this connection's
    // github_pat swapped (the read-only member's OLD token must stay), written
    // the way the app writes it — and the control that the old file is
    // exactly in that form, so the comparison below is byte-for-byte.
    const beforeObj = JSON.parse(beforeText);
    ok(JSON.stringify(beforeObj, null, 2) + '\n' === beforeText, 'control: the stored file is in the app’s own canonical form');
    const want = JSON.stringify({ ...beforeObj, connections: beforeObj.connections.map((c) => (c.id === ADMIN_ID ? { ...c, github_pat: NEW } : c)) }, null, 2) + '\n';
    ok(want !== beforeText && afterText === want, 'the file is byte-identical apart from this connection’s token');
    ok((fs.statSync(SB_FILE).mode & 0o777) === 0o600, 'the file is 0600', (fs.statSync(SB_FILE).mode & 0o777).toString(8));
    const after = stored().find((c) => c.id === ADMIN_ID);
    ok(after.github_pat === NEW, 'the new token is stored');
    for (const k of ['id', 'fellow_id', 'admin_token', 'read_only', 'shared_domain', 'shared_brain_slug', 'github_repo_owner', 'github_repo_name', 'local_domains']) {
      ok(JSON.stringify(after[k]) === JSON.stringify(beforeConn[k]), `unchanged: ${k}`);
    }
    ok(stored().find((c) => c.id === RO_ID).github_pat === OLD, 'the other connection keeps its own token');
    const list = await request('GET', '/api/sharedbrain/list');
    ok(leaks(list.text).every((t) => t !== NEW), 'the list never shows the new token whole');

    const n0 = fake.log.length;
    const mem = await request('GET', `/api/sharedbrain/${ADMIN_ID}/members`);
    const used = fake.log.slice(n0).map((e) => e.token);
    ok(mem.status === 200 && used.length > 0 && used.every((t) => t === NEW), 'the members read that follows carries the NEW token', { status: mem.status, used: used.map((t) => t.slice(0, 7)) });
    const n1 = fake.log.length;
    const pull = await request('POST', `/api/sharedbrain/${ADMIN_ID}/pull`, {});
    const pulled = fake.log.slice(n1).map((e) => e.token);
    ok(/"type":"done"/.test(pull.text) && pulled.length > 0 && pulled.every((t) => t === NEW), 'a Pull that follows carries the NEW token, and finishes', { pulled: pulled.map((t) => t.slice(0, 7)), text: pull.text.slice(-300) });
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§4  Success (read-only member): reading is enough, the flag stays');
  // ═══════════════════════════════════════════════════════════════════════
  {
    const r = await post(`/api/sharedbrain/${RO_ID}/token`, { token: RO });
    ok(r.status === 200 && r.json && r.json.replaced === true, 'a read-only token is accepted for a Pull-only membership', r.json);
    const after = stored().find((c) => c.id === RO_ID);
    ok(after.github_pat === RO && after.read_only === true, 'stored, and read_only is unchanged');
    const r2 = await post(`/api/sharedbrain/${RO_ID}/token`, { token: NEW2 });
    ok(r2.status === 200 && stored().find((c) => c.id === RO_ID).read_only === true, 'a write token is accepted too, and read_only is still unchanged (no promotion here)');
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§4b A read-only member who wants to contribute: what the refusal says is what works');
  // ═══════════════════════════════════════════════════════════════════════
  // The push refusal used to say "re-run the Join wizard", which is refused
  // while connected. Walk the person's real path over the real routes: the
  // refusal, Replace token (does not help), joining again while connected
  // (refused), Leave, join again with a write token (a new member), Push and
  // Pull work, and the mirror left behind is reused.
  {
    const ro = stored().find((c) => c.id === RO_ID);
    const OLD_FELLOW = ro.fellow_id;
    // A Pull first, so a mirror domain exists to be left behind.
    const p0 = await request('POST', `/api/sharedbrain/${RO_ID}/pull`, {});
    ok(/"type":"done"/.test(p0.text) && fs.existsSync(path.join(TMP_DOMAINS, 'shared-readers', 'CLAUDE.md')),
      'control: a read-only member can Pull, and the mirror shared-readers exists', p0.text.slice(-300));

    const pushRefused = async (label) => {
      const before = sha(SB_FILE);
      const n0 = fake.log.length;
      const r = await post(`/api/sharedbrain/${RO_ID}/push`, { local_domain: 'research' });
      ok(r.status === 400 && fake.log.length === n0 && sha(SB_FILE) === before,
        `${label}: Push is refused before GitHub is asked, and the config is unchanged`, { status: r.status, body: r.json });
      return (r.json && r.json.error) || '';
    };
    const said = await pushRefused('read-only (stored token can write)');
    ok(/is read-only/.test(said) && /nothing was sent/.test(said), 'the refusal says what happened and that nothing was sent', said);
    ok(/Leave this Shared Brain/.test(said) && /join again with the same invite/.test(said) && /Contents: Read and write/.test(said),
      'the refusal names the step that works: a write token, Leave this Shared Brain, join again', said);
    ok(/Replace token can’t change that/.test(said), 'the refusal says Replace token is not the way', said);
    ok(/new member/.test(said) && /never pushed anything/.test(said), 'the refusal says what it costs: a new member identity, nothing left behind', said);
    ok(!/re-run|Join wizard/i.test(said), 'the refusal no longer advises re-running the Join wizard', said);

    // Replace token with a write token (done in §4) did not promote the
    // connection: Push is still refused. That is why the sentence says so.
    ok(ro.github_pat === NEW2 && ro.read_only === true, 'control: this connection already holds a write token (§4)');

    // A read-only connection can never have contributed: synthesis is
    // refused too, so no write ever reached the brain under OLD_FELLOW.
    const syn = await post(`/api/sharedbrain/${RO_ID}/synthesize`, {});
    ok(syn.status === 400 && /read-only/.test((syn.json && syn.json.error) || ''), 'synthesis is refused for the read-only connection too', syn.json);

    // Joining again while connected: refused, early and at the write.
    const brain = { storage_type: 'github', github_repo_owner: 'acme', github_repo_name: 'readers', shared_domain: 'notes', shared_brain_slug: 'readers' };
    const clash = await post('/api/sharedbrain/check-clash', brain);
    ok(clash.status === 200 && clash.json && clash.json.ok === false && clash.json.kind === 'identity',
      'the wizard’s early check refuses joining again while connected', clash.json);
    const fresh = { ...brain, label: 'Readers', github_pat: NEW2, github_branch: 'main', fellow_display_name: 'B',
      local_domains: ['research'], read_only: false, enabled: true, data_handling_terms: 'contributor_retains' };
    const beforeDup = sha(SB_FILE);
    const dup = await post('/api/sharedbrain/save', { connection: { ...fresh } });
    ok(dup.status === 400 && /already connected to that shared brain/.test((dup.json && dup.json.error) || '') && sha(SB_FILE) === beforeDup,
      'saving a second connection to the same brain is refused and changes nothing', dup.json);

    // Leave, then join again with a write token.
    const left = await request('DELETE', `/api/sharedbrain/${RO_ID}`);
    ok(left.status === 200 && !stored().some((c) => c.id === RO_ID), 'Leave this Shared Brain removes the connection');
    ok(fs.existsSync(path.join(TMP_DOMAINS, 'shared-readers', 'CLAUDE.md')), 'the mirror domain stays on this computer');
    const clash2 = await post('/api/sharedbrain/check-clash', brain);
    ok(clash2.json && clash2.json.ok === true, 'after leaving, the wizard’s check lets the person join again', clash2.json);
    const joined = await post('/api/sharedbrain/save', { connection: { ...fresh } });
    const NEW_ID = joined.json && joined.json.connection && joined.json.connection.id;
    const nc = stored().find((c) => c.id === NEW_ID);
    ok(joined.status === 200 && nc && nc.read_only === false, 'joining again with a write token saves a contributor connection', joined.json);
    ok(nc && nc.fellow_id && nc.fellow_id !== OLD_FELLOW, 'it is a NEW member identity (a new fellow_id), as the refusal says', { old: OLD_FELLOW, now: nc && nc.fellow_id });

    const pu = await request('POST', `/api/sharedbrain/${NEW_ID}/push`, { local_domain: 'research' });
    ok(pu.status === 200 && !/is read-only/.test(pu.text), 'Push is no longer refused as read-only', { status: pu.status, text: pu.text.slice(0, 300) });
    const p1 = await request('POST', `/api/sharedbrain/${NEW_ID}/pull`, {});
    ok(/"type":"done"/.test(p1.text) && !/Refusing to pull/.test(p1.text), 'a Pull reuses the mirror the old membership left behind', p1.text.slice(-300));
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§5  The token is never echoed, printed or logged');
  // ═══════════════════════════════════════════════════════════════════════
  {
    ok(responses.every((t) => leaks(t).length === 0), 'no response carried any token', responses.filter((t) => leaks(t).length));
    ok(leaks(serverOut).length === 0, 'the server printed no token', leaks(serverOut));
    const logText = fs.existsSync(LOG_DIR) ? fs.readdirSync(LOG_DIR).map((f) => fs.readFileSync(path.join(LOG_DIR, f), 'utf8')).join('\n') : '';
    ok(leaks(logText).length === 0, 'curator.log holds no token', leaks(logText));
  }
} finally {
  try { server.kill('SIGKILL'); } catch { /* gone */ }
  await new Promise((r) => ghServer.close(r));
  ghServer.closeAllConnections?.();
}

// ═══════════════════════════════════════════════════════════════════════════
section('§6  The view');
// ═══════════════════════════════════════════════════════════════════════════
{
  await import('./test-helpers/net-globals.js');
  const viewSrc = fs.readFileSync(path.join(ROOT, 'src/public/next/views/shared.js'), 'utf8');
  const appSrc = fs.readFileSync(path.join(ROOT, 'src/public/next/app.js'), 'utf8');
  const { rememberErrorDetail, plainError } = await import('../src/public/next/shared/net.js');
  const FNS = ['tokenCheckApplies', 'freshTokenForm', 'tokenRejectionKey', 'sbTokenPanelOpen', 'renderReplaceToken', 'classifyTokenCheck', 'onReplaceSharedBrainToken'];
  const env = { fetchCalls: [], input: null, renders: 0, answer: null };
  const box = new Function('env',
    extractFunction(appSrc, 'escapeHtml', 'app.js') + '\n' +
    'let cards = {}; let conns = [];\n' +
    'function ensureCard(id) { return cards[id] || (cards[id] = { message: null, error: false, tokenCheck: null, tokenForm: freshTokenForm() }); }\n' +
    'function findConnection(id) { return conns.find((c) => c.id === id) || null; }\n' +
    'function render() { env.renders++; }\n' +
    'function isCurrentMount() { return true; }\n' +
    'const document = { getElementById: (id) => (env.input && id === env.input.id ? env.input : null) };\n' +
    'async function fetch(url, init) { env.fetchCalls.push({ url, init, inputAtSend: env.input ? env.input.value : null, stateAtSend: ensureCard(env.connId).tokenForm.token }); return env.answer(); }\n' +
    FNS.map((n) => extractFunction(viewSrc, n, 'views/shared.js')).join('\n') + '\n' +
    'return { ' + FNS.join(', ') + ', ensureCard, setConns: (c) => { conns = c; } };')(env);

  const gh = { id: 'c1', storage_type: 'github', github_repo_owner: 'acme', github_repo_name: 'cohort-brain' };
  const card = box.ensureCard('c1');
  ok(box.sbTokenPanelOpen(gh, card) === false, 'a quiet card: the panel is closed');
  ok(/data-sb-action="token-replace-open">Replace token</.test(box.renderReplaceToken(gh, card, true)), '…with one Replace token button where an opener belongs');
  ok(box.renderReplaceToken(gh, card, false) === '', '…and nothing where only an open panel belongs');
  ok(box.renderReplaceToken({ ...gh, storage_type: 'local' }, card, true) === '', 'a folder-backed brain: no control at all');

  card.tokenCheck = box.classifyTokenCheck({ ok: false, error: 'x', detail: 'GitHub GET tree:main → 401: Bad credentials', code: 'github-token-rejected', repoLabel: 'acme/cohort-brain' });
  ok(card.tokenCheck.kind === 'rejected' && /Replace token below/.test(card.tokenCheck.message) && !/re-join|Leave this/.test(card.tokenCheck.message),
    'the rejected verdict names Replace token, not Leave and re-join', card.tokenCheck.message);
  ok(box.sbTokenPanelOpen(gh, card) === true, 'a rejected verdict OPENS the panel');
  const html = box.renderReplaceToken(gh, card, false);
  ok(/id="sb-token-replace-c1"/.test(html) && /id="sb-token-input-c1"/.test(html) && /data-sb-action="token-replace-save"/.test(html), 'the open panel: the field and Check and save');
  ok(!/<input[^>]*value=/.test(html), 'the token input has NO value attribute');
  ok(/Contents: Read and write/.test(html) && /acme\/cohort-brain/.test(html), 'a pushing connection is told what the token needs, for which repository');
  ok(/admin token stays/.test(box.renderReplaceToken({ ...gh, has_admin_token: true }, card, false)), 'an admin is told the admin token stays');
  ok(/read-only membership/.test(box.renderReplaceToken({ ...gh, read_only: true }, card, false)), 'a read-only member is told reading is enough');

  // Cancel dismisses THIS rejection only.
  card.tokenForm = { ...box.freshTokenForm(), dismissedKey: box.tokenRejectionKey(card) };
  ok(box.sbTokenPanelOpen(gh, card) === false, 'Cancel closes it for this rejection');
  card.tokenCheck = null;
  card.error = true;
  card.message = 'Error: ' + plainError({ type: 'error', message: 'pullCollective: GitHub GET git/trees/main → 401: Bad credentials' });
  rememberErrorDetail(card.message, 'x', 'github-token-rejected');
  ok(box.sbTokenPanelOpen(gh, card) === true, 'a Pull refused with github-token-rejected (a raw frame, classified in the browser) opens it again');
  const other = box.ensureCard('c2');
  other.error = true;
  other.message = 'Error: ' + plainError({ type: 'error', message: 'GitHub GET git/trees/main → 503: down' });
  ok(box.sbTokenPanelOpen({ ...gh, id: 'c2' }, other) === false, 'CONTROL: another failure does not open it');

  // The handler.
  box.setConns([gh]);
  env.connId = 'c1';
  env.input = { id: 'sb-token-input-c1', value: '  ' + NEW + ' ' };
  card.tokenForm = { ...box.freshTokenForm(), open: true, token: NEW };
  env.answer = async () => ({ ok: false, status: 400, json: async () => ({ error: 'GitHub didn’t accept the new token. Nothing was changed.', detail: 'GitHub GET repos/acme/x → 401', code: 'sharedbrain-new-token-rejected' }) });
  await box.onReplaceSharedBrainToken(1, 'c1');
  const sent = env.fetchCalls[0];
  ok(sent && sent.url === '/api/sharedbrain/c1/token' && sent.init.method === 'POST' && JSON.parse(sent.init.body).token === NEW,
    'the handler POSTs the trimmed token in the body, never the URL', sent && sent.url);
  ok(sent && sent.inputAtSend === '' && sent.stateAtSend === '', 'the field and the state were cleared BEFORE the request');
  ok(card.tokenForm.error && /didn’t accept/.test(card.tokenForm.error) && card.tokenForm.code === 'sharedbrain-new-token-rejected'
    && card.tokenForm.detail === 'GitHub GET repos/acme/x → 401' && card.tokenForm.open === true && card.tokenForm.token === '',
    'a refusal: the plain sentence, detail and code stay; the token does not', card.tokenForm);
  ok(!JSON.stringify(card).includes(NEW), 'no token anywhere in the card state');
  const errHtml = box.renderReplaceToken(gh, card, false);
  ok(/Technical detail \(for support\)/.test(errHtml) && /code: sharedbrain-new-token-rejected/.test(errHtml), 'the refusal renders with its support line and code', errHtml);

  env.input.value = NEW;
  env.answer = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, replaced: true, repo: 'acme/cohort-brain' }) });
  card.tokenCheck = { kind: 'rejected', message: 'old' };
  await box.onReplaceSharedBrainToken(1, 'c1');
  ok(card.tokenForm.open === false && !card.tokenForm.error && card.tokenCheck === null && card.error === false
    && /Token replaced/.test(card.message), 'success: the panel closes, the stale verdict goes, the card says so', { form: card.tokenForm, msg: card.message });
  ok(box.sbTokenPanelOpen(gh, card) === false, '…and the panel stays closed');

  env.input.value = '';
  env.fetchCalls.length = 0;
  await box.onReplaceSharedBrainToken(1, 'c1');
  ok(env.fetchCalls.length === 0 && /Paste the new token/.test(card.tokenForm.error || ''), 'an empty field asks first and sends nothing');
}

section('§7  The real credential files were never touched');
ok(fingerprintReal() === realBefore, 'the checkout’s own .curator-config.json / .sync-config.json / .sharedbrain-config.json are unchanged');
try { fs.chmodSync(TMP_USER, 0o700); fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) {
  console.log('❌ FAILURES');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('✅ A Shared Brain token can be replaced in place, and nothing else changes');
process.exit(0);
