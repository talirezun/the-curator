/**
 * test-github-read-token.js — OFFLINE suite for the GitHub READ-ONLY token
 * (v3.65.2): its writer in src/brain/config.js, its four routes in
 * src/routes/config.js, its block in Settings → Knowledge base, and the
 * self-clearing requestSettingsSection/consumeSettingsSection pair in app.js.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 * Since v3.63.0 the Documents "Mirror from GitHub" panel told the user to add
 * a read-only token in Settings, and nothing in the app wrote one. The read
 * side (`readGitHubReadToken('config')` in github-read-client.js) has always
 * looked for `githubReadToken` in .curator-config.json; this suite pins the
 * writer to that reader, byte for byte, and pins the one property a credential
 * field must have above all others: the VALUE never leaves the server again.
 *
 * ── ISOLATION ────────────────────────────────────────────────────────────
 * CURATOR_TEST_USER_DATA_DIR is set BEFORE any app module is imported, so
 * every config read and write lands in a tempdir; §1 asserts the resolved
 * path really is inside it. The real .curator-config.json of this checkout
 * (and the packaged app's, if one exists) is fingerprinted by sha256 + size
 * — never mtime — before and after the run.
 *
 * NO NETWORK. `globalThis.fetch` is wrapped: any request to api.github.com is
 * answered by a fake that records it; anything else (this suite's own calls
 * to its in-process server on 127.0.0.1) passes through. A request to any
 * OTHER non-loopback host fails the suite.
 *
 * The synthetic tokens are assembled at runtime from fragments so no literal
 * credential shape sits in this file (the pre-commit secret scan).
 */

import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── Fingerprint the real credential files BEFORE anything is imported ─────
const REAL_CONFIGS = [
  path.join(ROOT, '.curator-config.json'),
  path.join(homedir(), 'Library', 'Application Support', 'The Curator', '.curator-config.json'),
];
function fingerprint(f) {
  if (!existsSync(f)) return 'absent';
  const b = readFileSync(f);
  return createHash('sha256').update(b).digest('hex') + ':' + b.length;
}
const realBefore = REAL_CONFIGS.map(fingerprint);

const TMP = mkdtempSync(path.join(tmpdir(), 'curator-ghtoken-'));
process.env.CURATOR_TEST_USER_DATA_DIR = TMP;
process.env.CURATOR_TEST_DOMAINS_DIR = path.join(TMP, 'domains');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label); }
}
function eq(a, b, label) {
  const same = JSON.stringify(a) === JSON.stringify(b);
  ok(same, label + (same ? '' : ` (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`));
}
function section(t) { console.log('\n' + t); }

// Synthetic values, built from fragments (see the header).
const PAT = 'github_' + 'pat_';
const CLASSIC = 'gh' + 'p_';
const FINE = PAT + '11FAKE0000' + 'SYNTHETIC_' + 'x'.repeat(40) + 'ab12';
const FINE2 = PAT + '22FAKE0000' + 'OTHERONE__' + 'y'.repeat(40) + 'cd34';
const CLASSICTOK = CLASSIC + 'FAKE' + 'Z'.repeat(28) + 'ef56';
const ATTACKER = CLASSIC + 'EVIL' + 'Q'.repeat(28) + 'zz99';

const { getCuratorConfigFile } = await import('../src/brain/paths.js');
const config = await import('../src/brain/config.js');
const ghc = await import('../src/brain/github-read-client.js');
const CONFIG_FILE = getCuratorConfigFile();

// ═══════════════════════════════════════════════════════════════════════════
section('§1  Isolation — every config read and write lands in the tempdir');
ok(CONFIG_FILE.startsWith(TMP + path.sep), 'the resolved .curator-config.json is inside the tempdir');
ok(!REAL_CONFIGS.includes(CONFIG_FILE), 'and it is not the real one');

// ═══════════════════════════════════════════════════════════════════════════
section('§2  One key name, typed twice, pinned equal');
eq(config.__GITHUB_READ_TOKEN_FIELD, ghc.GITHUB_READ_TOKEN_KEY,
  'config.js writes the key github-read-client.js reads — a drift here would save a token nothing uses');

// ═══════════════════════════════════════════════════════════════════════════
section('§3  The writer — shape, 0600, status never carries the value');
{
  rmSync(CONFIG_FILE, { force: true });
  eq(config.getGithubReadTokenStatus(), { present: false, last4: null, kind: null }, 'no file → not present');

  const st = config.setGithubReadToken('  ' + FINE + '\n');
  eq(st, { present: true, last4: 'ab12', kind: 'fine-grained' }, 'a fine-grained token saves; status is presence + last4 + kind');
  ok(!JSON.stringify(st).includes(FINE.slice(0, 20)), 'the returned status carries no part of the value beyond last4');
  const mode = statSync(CONFIG_FILE).mode & 0o777;
  eq(mode.toString(8), '600', 'the config file is written 0600');
  const onDisk = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  eq(onDisk.githubReadToken, FINE, 'stored TRIMMED under githubReadToken');
  const read = ghc.readGitHubReadToken('config');
  ok(read.ok === true && read.token === FINE && read.source === 'config',
    'EXECUTED: the real reader (readGitHubReadToken) finds exactly the saved token');

  eq(config.setGithubReadToken(CLASSICTOK), { present: true, last4: 'ef56', kind: 'classic' }, 'a classic token saves too, as kind "classic"');
  eq(config.githubTokenKind(FINE), 'fine-grained', 'githubTokenKind: fine-grained by prefix');

  const BAD = [
    ['', 'empty'],
    [PAT + 'short', 'too short'],
    ['gh' + 'o_' + 'A'.repeat(36), 'an OAuth token (gho_)'],
    [PAT + 'abc def' + 'x'.repeat(30), 'a space inside'],
    ['••••••••ab12', 'the masked display value'],
    [PAT + 'x'.repeat(30) + '…', 'an ellipsis'],
    [PAT + 'x'.repeat(260), 'absurdly long'],
    [123, 'a number'],
    [null, 'null'],
  ];
  const before = readFileSync(CONFIG_FILE);
  for (const [v, label] of BAD) {
    let err = null;
    try { config.setGithubReadToken(v); } catch (e) { err = e; }
    ok(err && err.code === 'invalid_token', `refused: ${label} → code invalid_token`);
    if (err && typeof v === 'string' && v.length >= 6) {
      ok(!err.message.includes(v.trim().slice(0, 12)), `…and the thrown message carries no part of it (${label})`);
    }
  }
  ok(Buffer.compare(before, readFileSync(CONFIG_FILE)) === 0, 'no refused save touched the file');

  // An unparseable config must not be REPLACED by a token write — it holds
  // the API keys.
  writeFileSync(CONFIG_FILE, '{ "geminiApiKey": "k", BROKEN');
  const broken = readFileSync(CONFIG_FILE);
  let e2 = null;
  try { config.setGithubReadToken(FINE); } catch (e) { e2 = e; }
  ok(e2 && e2.code === 'config_unreadable', 'an unparseable config is refused (config_unreadable), not overwritten');
  ok(Buffer.compare(broken, readFileSync(CONFIG_FILE)) === 0, '…and its bytes are exactly as they were');
  let e3 = null;
  try { config.clearGithubReadToken(); } catch (e) { e3 = e; }
  ok(e3 && e3.code === 'config_unreadable' && Buffer.compare(broken, readFileSync(CONFIG_FILE)) === 0,
    'clear refuses the same way and leaves the bytes alone');

  // clear: removes ONE key, every other value identical.
  const others = { geminiApiKey: 'AI-not-real', anthropicApiKey: '', activeProvider: 'gemini', domainsPath: '/x/y', ui: { a: 1 } };
  writeFileSync(CONFIG_FILE, JSON.stringify({ ...others, githubReadToken: FINE }, null, 2) + '\n');
  eq(config.clearGithubReadToken(), { present: false, last4: null, kind: null }, 'clear → not present');
  const after = readFileSync(CONFIG_FILE, 'utf8');
  eq(JSON.parse(after), others, 'every other key survives with the same value');
  eq(after, JSON.stringify(others, null, 2) + '\n', '…byte-identical to the file with that one key removed');
  ok(!('githubReadToken' in JSON.parse(after)), 'the key is REMOVED, not blanked');

  const settled = readFileSync(CONFIG_FILE);
  const m0 = statSync(CONFIG_FILE).mtimeMs;
  config.clearGithubReadToken();
  ok(Buffer.compare(settled, readFileSync(CONFIG_FILE)) === 0 && statSync(CONFIG_FILE).mtimeMs === m0,
    'clearing when no token is saved does not rewrite the file');
  rmSync(CONFIG_FILE, { force: true });
  config.clearGithubReadToken();
  ok(!existsSync(CONFIG_FILE), 'clearing on a fresh install creates no config file');
}

// ═══════════════════════════════════════════════════════════════════════════
// The in-process server, and the network fence.
const realFetch = globalThis.fetch;
const ghCalls = [];
let ghHandler = null;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith('https://api.github.com/')) {
    ghCalls.push({ url: u, method: init.method, auth: init.headers && init.headers.Authorization });
    if (!ghHandler) throw new Error('unexpected GitHub call');
    return ghHandler(u, init);
  }
  if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(u)) throw new Error('NETWORK FENCE: ' + u);
  return realFetch(url, init);
};
function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const express = (await import('express')).default;
const configRouter = (await import('../src/routes/config.js')).default;
const { registerWrite } = await import('../src/brain/write-registry.js');
const app = express();
app.use(express.json());
app.use('/api/config', configRouter);
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const BASE = `http://127.0.0.1:${server.address().port}/api/config/github-read-token`;
async function call(method, suffix = '', body) {
  const res = await fetch(BASE + suffix, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, text, json };
}
const noValue = (text, v) => !text.includes(v) && !text.includes(v.slice(0, 16));

try {
  // ═════════════════════════════════════════════════════════════════════════
  section('§4  The routes — GET/PUT/DELETE');
  {
    rmSync(CONFIG_FILE, { force: true });
    let r = await call('GET');
    eq([r.status, r.json], [200, { ok: true, present: false, last4: null, kind: null }], 'GET with nothing saved');

    writeFileSync(CONFIG_FILE, JSON.stringify({ geminiApiKey: 'AI-not-real', defaultDomain: 'alpha' }, null, 2) + '\n');
    r = await call('PUT', '', { token: FINE });
    eq([r.status, r.json], [200, { ok: true, present: true, last4: 'ab12', kind: 'fine-grained' }], 'PUT a fine-grained token');
    ok(noValue(r.text, FINE), 'the PUT response body carries no part of the value');
    eq((statSync(CONFIG_FILE).mode & 0o777).toString(8), '600', 'after a route write the file is 0600');

    r = await call('GET');
    eq(r.json, { ok: true, present: true, last4: 'ab12', kind: 'fine-grained' }, 'GET returns presence, last4 and kind');
    ok(noValue(r.text, FINE), 'the GET body carries no part of the value');

    for (const [body, label] of [
      [{ token: PAT + 'nope' }, 'too short'],
      [{ token: 'gh' + 'o_' + 'A'.repeat(36) }, 'an OAuth token'],
      [{ token: '••••ab12' }, 'the masked value'],
      [{ token: 42 }, 'a number'],
      [{}, 'no token field'],
    ]) {
      const b = await call('PUT', '', body);
      ok(b.status === 400 && b.json && b.json.code === 'invalid_token' && b.json.ok === false, `PUT refuses ${label} → 400 invalid_token`);
      if (typeof body.token === 'string') ok(noValue(b.text, body.token), `…and does not echo it (${label})`);
    }
    r = await call('GET');
    eq(r.json.last4, 'ab12', 'a refused PUT left the saved token in place');

    // A write in flight: PUT and DELETE are refused through conflictResponse.
    const release = registerWrite('alpha', 'ingest');
    const blocked = await call('PUT', '', { token: FINE2 });
    const blockedDel = await call('DELETE');
    release();
    ok(blocked.status === 409 && blockedDel.status === 409, 'mid-write: PUT and DELETE are refused 409 (guardConcurrent)');
    ok(noValue(blocked.text, FINE2), '…and the refusal does not echo the value');
    eq((await call('GET')).json.last4, 'ab12', '…and nothing moved');

    r = await call('PUT', '', { token: CLASSICTOK });
    eq(r.json, { ok: true, present: true, last4: 'ef56', kind: 'classic' }, 'PUT a classic token → kind classic');

    const beforeDel = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    r = await call('DELETE');
    eq([r.status, r.json], [200, { ok: true, present: false }], 'DELETE → present:false');
    const afterDel = readFileSync(CONFIG_FILE, 'utf8');
    delete beforeDel.githubReadToken;
    eq(afterDel, JSON.stringify(beforeDel, null, 2) + '\n', 'DELETE leaves every other key byte-identical');
    eq((await call('GET')).json, { ok: true, present: false, last4: null, kind: null }, 'GET after DELETE');
  }

  // ═════════════════════════════════════════════════════════════════════════
  section('§5  POST …/test — one read with the STORED token, fake GitHub');
  {
    const SHA = 'a'.repeat(39) + 'b';
    ghCalls.length = 0;
    ghHandler = () => jsonResponse(200, { sha: SHA });
    let r = await call('POST', '/test', { remote: 'octo/docs', ref: 'main' });
    eq([r.status, r.json && r.json.code], [400, 'no_token'], 'no token stored → 400 no_token');
    eq(ghCalls.length, 0, '…and GitHub is not called');
    ok(/Settings/.test(r.json.message) && /\.curator-config\.json/.test(r.json.message), '…and the message names where the token belongs');

    await call('PUT', '', { token: FINE });

    r = await call('POST', '/test', { remote: 'not a repo!!' });
    eq([r.status, r.json.code], [400, 'invalid_remote'], 'a malformed repository → 400 invalid_remote');
    r = await call('POST', '/test', { remote: 'octo/docs', ref: '../etc' });
    eq([r.status, r.json.code], [400, 'invalid_ref'], 'a malformed ref → 400 invalid_ref');
    eq(ghCalls.length, 0, 'neither refusal reached GitHub');

    // Success, ref named: exactly ONE GET, with the stored token as Bearer.
    ghCalls.length = 0;
    ghHandler = (u) => (u.endsWith('/repos/octo/docs/commits/main') ? jsonResponse(200, { sha: SHA }) : jsonResponse(500, {}));
    r = await call('POST', '/test', { remote: 'https://github.com/octo/docs.git', ref: 'main', token: ATTACKER });
    eq([r.status, r.json], [200, { ok: true, repo: 'octo/docs', ref: 'main', sha: SHA, requests: 1 }], 'success with a named ref');
    eq(ghCalls.length, 1, 'ONE request to GitHub');
    eq(ghCalls[0].method, 'GET', 'and it is a GET');
    eq(ghCalls[0].auth, 'Bearer ' + FINE, 'it used the STORED token — a token in the request body is not read');
    ok(noValue(r.text, FINE), 'the response carries no part of the value');

    // Success with no ref: the default branch is resolved, then read.
    ghCalls.length = 0;
    ghHandler = (u) => {
      if (u.endsWith('/repos/octo/docs')) return jsonResponse(200, { default_branch: 'trunk' });
      if (u.endsWith('/repos/octo/docs/commits/trunk')) return jsonResponse(200, { sha: SHA });
      return jsonResponse(500, {});
    };
    r = await call('POST', '/test', { remote: 'octo/docs' });
    eq(r.json, { ok: true, repo: 'octo/docs', ref: 'trunk', sha: SHA, requests: 2 }, 'no ref → the default branch is resolved (2 GETs, stated)');

    // 401 — and GitHub (or a proxy) ECHOING the token back.
    ghCalls.length = 0;
    ghHandler = () => jsonResponse(401, { message: 'Bad credentials for ' + FINE });
    r = await call('POST', '/test', { remote: 'octo/docs', ref: 'main' });
    ok(r.status === 200 && r.json.ok === false && r.json.code === 'unauthorised', '401 → ok:false, code unauthorised');
    ok(/\.curator-config\.json/.test(r.json.message), '…the message names the token’s SOURCE');
    ok(noValue(r.text, FINE), '…and never its value, even when the upstream echoed it');
    eq(ghCalls.length, 1, '…a 4xx is not retried');

    ghHandler = () => jsonResponse(404, { message: 'Not Found' });
    r = await call('POST', '/test', { remote: 'git@github.com:octo/private.git', ref: 'main' });
    ok(r.json.ok === false && r.json.code === 'not_found' && r.json.repo === 'octo/private', '404 → ok:false, code not_found, repo named');
    ok(/cannot see this repository/.test(r.json.message) && noValue(r.text, FINE), '…says why a fine-grained token answers 404, without the value');

    ok(ghCalls.every((c) => c.method === 'GET'), 'every request this suite saw GitHub receive was a GET');
  }
} finally {
  ghHandler = null;
  await new Promise((r) => server.close(r));
  globalThis.fetch = realFetch;
}

// ═══════════════════════════════════════════════════════════════════════════
// Frontend — lifted and EXECUTED, never grepped for presence.
function extractFrom(source, re, name) {
  const m = re.exec(source);
  if (!m) throw new Error(`extract: "${name}" not found`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  let i = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return source.slice(start, i).replace(/^export\s+/, '');
}
const fnRe = (n) => new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ${n}\\s*\\(`);

section('§6  app.js — requestSettingsSection / consumeSettingsSection self-clear');
{
  const appSrc = readFileSync(path.join(ROOT, 'src/public/next/app.js'), 'utf8');
  const decl = /let _pendingSettingsSectionRequest = null;/.exec(appSrc);
  ok(!!decl, 'the pending slot is declared once, null');
  const body = [
    'let _pendingSettingsSectionRequest = null;',
    extractFrom(appSrc, fnRe('requestSettingsSection'), 'requestSettingsSection'),
    extractFrom(appSrc, fnRe('consumeSettingsSection'), 'consumeSettingsSection'),
    'return { requestSettingsSection, consumeSettingsSection };',
  ].join('\n');
  const P = new Function(body)();
  eq(P.consumeSettingsSection(), null, 'nothing requested → null');
  P.requestSettingsSection('  storage ');
  eq(P.consumeSettingsSection(), 'storage', 'a request is consumed, trimmed');
  eq(P.consumeSettingsSection(), null, '…ONCE — the second consume is null (self-clearing)');
  P.requestSettingsSection('storage');
  P.requestSettingsSection('');
  eq(P.consumeSettingsSection(), null, 'a falsy request clears a pending one');
  P.requestSettingsSection(42);
  eq(P.consumeSettingsSection(), null, 'a non-string is not a request');
}

const setSrc = readFileSync(path.join(ROOT, 'src/public/next/views/settings.js'), 'utf8');

section('§7  settings.js onEnter — lands on the requested section, once');
{
  const m = /\n {2}onEnter\(mountToken\) \{/.exec(setSrc);
  ok(!!m, 'onEnter is found');
  let i = setSrc.indexOf('{', m.index), depth = 0;
  const from = i;
  for (; i < setSrc.length; i++) {
    if (setSrc[i] === '{') depth++;
    else if (setSrc[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const onEnterBody = setSrc.slice(from, i);
  const SECTIONS = [['general', 'General'], ['providers', 'Providers'], ['storage', 'Knowledge base'], ['mcp', 'MCP'], ['health', 'Health']];
  function drive(pending) {
    const rec = { renders: [], loads: [] };
    let slot = pending;
    const deps = {
      freshState: () => ({ section: SECTIONS[0][0] }),
      consumeSettingsSection: () => { const v = slot; slot = null; return v; },
      SECTION_TITLES: Object.fromEntries(SECTIONS),
      SETTINGS_SECTIONS: SECTIONS,
      createLoadingGate: () => ({ cancel() {} }),
      setInterval: undefined, clearInterval: undefined,
      tickMcpAges: () => {}, MCP_AGE_TICK_MS: 1000,
      scheduleUsagePoll: () => {}, stopUsagePoll: () => {},
      loadVersion: () => Promise.resolve(),
      prefetchOtherSections: () => {},
      reportAsyncMountFailure: () => {},
      isCurrentMount: () => true,
      onWriteGateChange: () => () => {},
      closeAllListboxes: () => {}, closeConfirmIfOpen: () => {}, closeMcpWizardIfOpen: () => {},
    };
    const names = Object.keys(deps);
    const f = new Function(...names, 'rec', `
      let state, myMountToken, sectionLoads, lastSidebarHtml, lastMainHtml, loadGate, ageTimer = null, unsubscribeWriteGate = null;
      function render() { rec.renders.push(state.section); }
      function ensureSectionData(s) { rec.loads.push(s); return Promise.resolve(); }
      const o = { onEnter(mountToken) ${onEnterBody} };
      return { onEnter: o.onEnter, get state() { return state; } };`);
    const v = f(...names.map((n) => deps[n]), rec);
    v.onEnter(7);
    return { rec, state: v.state, left: slot };
  }
  let d = drive('storage');
  eq(d.rec.renders[0], 'storage', 'EXECUTED: a pending "storage" request → the FIRST paint is Knowledge base');
  ok(d.rec.loads.includes('storage'), '…and its data is loaded directly, not left to the idle prefetch');
  eq(d.left, null, '…and the request was consumed');
  d = drive(null);
  eq(d.rec.renders[0], 'general', 'no request → the default section, as always');
  d = drive('__proto__');
  eq(d.rec.renders[0], 'general', 'an id Settings does not know → the default section (fails safe)');
}

section('§8  The Knowledge base block — rendered for real');
{
  const { renderMonitor } = await import('../src/public/next/shared/monitor.js');
  const escapeHtml = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  // v3.71.1: settings.js's local infoMark is gone; the REAL shared explainer
  // kit (import-free, headless) is injected as `explainerMark`.
  const { explainerMark, explainerHtml } = await import('../src/public/next/shared/explainer.js');
  const { EXPLAINERS } = await import('../src/public/next/shared/explainers.js');
  const code = [
    extractFrom(setSrc, fnRe('settingsBlock'), 'settingsBlock'),
    extractFrom(setSrc, fnRe('renderGithubTokenTest'), 'renderGithubTokenTest'),
    extractFrom(setSrc, fnRe('renderGithubReadToken'), 'renderGithubReadToken'),
    'return renderGithubReadToken;',
  ].join('\n');
  const mk = new Function('state', 'escapeHtml', 'icon', 'explainerMark', 'renderMonitor', code);
  const base = () => ({
    ghToken: { present: false, last4: null, kind: null }, ghTokenLoadError: null, ghTokenEditing: false,
    ghTokenValue: '', ghTokenBusy: null, ghTokenActionError: null, ghTokenRepo: '', ghTokenTestBusy: false, ghTokenTest: null,
  });
  const render = (st) => mk(st, escapeHtml, () => '<svg class="i"></svg>', explainerMark, renderMonitor)();

  let st = base();
  let h = render(st);
  ok(/No token saved/.test(h), 'without a token: "No token saved"');
  ok(/id="gh-token-edit"[^>]*>Add token</.test(h), '…the one action is "Add token"');
  ok(!/gh-token-disconnect/.test(h) && !/gh-token-test"/.test(h), '…no Disconnect and no Test (nothing to act on)');
  ok(/settings-block-storage-github-token/.test(h) && /GitHub read-only token/.test(h), 'the block is a settingsBlock titled "GitHub read-only token"');
  // v3.71.1: the ⓘ is the `settings.github-token` explainer — byte-equal,
  // under the unchanged panel id — whose steps visual carries the creation
  // steps. "Resource owner" and the why-not-classic sentence moved to the
  // user guide section the explainer's card opens (asserted below).
  ok(h.includes(explainerMark('settings-block-info-storage-github-token', 'settings.github-token').panel)
     && h.includes('aria-label="' + EXPLAINERS['settings.github-token'].label + '"'),
    'the ⓘ panel IS the settings.github-token explainer (byte-equal, id unchanged)');
  const xh = explainerHtml('settings.github-token');
  const steps = ((xh.match(/<ol class="xp-steps">([\s\S]*?)<\/ol>/) || [])[1] || '').match(/<li>/g) || [];
  eq(steps.length, 4, 'the ⓘ carries the four creation steps');
  ok(/Fine-grained tokens/.test(h) && /Contents: Read-only/.test(h) && /Only select repositories/.test(h) && /expiry/.test(h),
    '…each step is there (token type, repository access, the one permission, expiry)');
  {
    const ug = readFileSync(path.join(ROOT, 'docs/user-guide.md'), 'utf8');
    const at = ug.indexOf('\n#### GitHub read-only token\n');
    const sec = at >= 0 ? ug.slice(at, ug.indexOf('\n#', at + 5)) : '';
    ok(/\*\*Resource owner\*\*/.test(sec) && /classic token/.test(sec) && /`repo` scope/.test(sec)
       && /Personal Sync's own token/.test(sec),
      '…and the guide section it links to keeps the resource-owner step and the why-not-classic reasoning');
  }
  ok(/class="tx-vh-panel"[^>]*hidden/.test(h), 'the steps are behind the ⓘ (a hidden panel), not inline');

  st = base(); st.ghToken = { present: true, last4: 'ab12', kind: 'fine-grained' };
  h = render(st);
  ok(h.includes('Saved · ends in …ab12 · fine-grained'), 'with a token: "Saved · ends in …ab12 · fine-grained"');
  ok(/id="gh-token-disconnect"/.test(h) && />Replace token</.test(h), '…Disconnect and "Replace token"');
  ok(/id="gh-token-repo"/.test(h) && /id="gh-token-test"/.test(h), '…and a Test with a repository field');
  // The Test is the CARD'S SECOND ROW, not a bare field under it (the
  // orchestrator's screen review): measured on the rendered markup by taking
  // the card's own balanced <div> and looking inside it.
  const cardOf = (html) => {
    const start = html.indexOf('<div class="provider-row-list cur-group">');
    if (start < 0) return '';
    const re = /<\/?div\b[^>]*>/g; re.lastIndex = start;
    let depth = 0, m;
    while ((m = re.exec(html))) {
      depth += m[0][1] === '/' ? -1 : 1;
      if (depth === 0) return html.slice(start, re.lastIndex);
    }
    return '';
  };
  let card = cardOf(h);
  ok(/class="provider-row gh-token-test-row"/.test(card) && /id="gh-token-repo"/.test(card) && /id="gh-token-test"/.test(card),
    'the Test row sits INSIDE the card, as a provider-row');
  ok(/<span class="provider-name">Test<\/span>/.test(card) && /One read of a repository/.test(card), '…labelled on the first row\u2019s anatomy');
  ok(/class="btn btn-secondary btn-xs" id="gh-token-test"/.test(card), '…with a real secondary button, the Replace token rung');
  ok(!/id="gh-token-repo"/.test(h.slice(h.indexOf(card) + card.length)), 'nothing of the Test renders below the card');
  ok(!/data-gh-token-caution/.test(h), 'a fine-grained token carries no caution');

  st.ghToken.kind = 'classic';
  h = render(st);
  ok(/data-gh-token-caution/.test(h) && /every\s+repository this account owns/.test(h), 'a classic token carries the caution…');
  ok(!/<details/.test(h), '…and nothing in the block sits behind a chevron');
  ok(h.indexOf('data-gh-token-caution') > h.indexOf('class="settings-block-body"'), '…inside the block body, not behind the ⓘ');

  st = base(); st.ghTokenEditing = true; st.ghTokenValue = FINE;
  h = render(st);
  ok(/<input type="password"[^>]*id="gh-token-input"[^>]*autocomplete="off"/.test(h), 'editing: a password input, autocomplete off');
  ok(!/id="gh-token-input"[^>]*value=/.test(h), '…with NO value= attribute');
  ok(!h.includes(FINE) && !h.includes(FINE.slice(0, 16)), 'a typed value sitting in state never reaches the markup');

  st = base(); st.ghToken = { present: true, last4: 'ab12', kind: 'fine-grained' };
  st.ghTokenTest = { ok: true, repo: 'octo/docs', ref: 'main', sha: 'abcdef1234' + '0'.repeat(30) };
  h = render(st);
  ok(/cur-mon/.test(h) && /Token reads this repository/.test(h) && /octo\/docs/.test(h) && /abcdef1/.test(h),
    'a passing test renders as a MONITOR: head, repository, ref, short commit');
  card = cardOf(h);
  ok(/cur-mon/.test(card) && /Token reads this repository/.test(card), '…and the monitor sits INSIDE the card');
  st.ghTokenTest = { ok: false, code: 'unauthorised', repo: 'octo/docs', message: 'GitHub refused the token from .curator-config.json with 401.' };
  h = render(st);
  ok(/Test failed/.test(h) && /GitHub refused the token from \.curator-config\.json/.test(h), 'a failing test: the route’s message, verbatim, as the monitor’s loud line');

  st = base(); st.ghToken = null; st.ghTokenLoadError = 'Could not read whether a GitHub token is saved.';
  h = render(st);
  ok(/Could not read whether a GitHub token is saved/.test(h) && !/gh-token-edit/.test(h), 'a status that could not be read says so rather than offering "Add token"');

  st = base(); st.ghToken = { present: true, last4: 'ab12', kind: 'fine-grained' }; st.ghTokenActionError = 'boom';
  h = render(st);
  ok(/settings-inline-error[^>]*>boom</.test(h), 'a failed save/disconnect is shown inline, unfolded');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§9  The real credential files were not touched');
eq(REAL_CONFIGS.map(fingerprint), realBefore, 'sha256 + size of every real .curator-config.json unchanged');
rmSync(TMP, { recursive: true, force: true });

console.log(`\n${'='.repeat(60)}\nPassed: ${passed}   Failed: ${failed}\n${'='.repeat(60)}`);
process.exit(failed ? 1 : 0);
