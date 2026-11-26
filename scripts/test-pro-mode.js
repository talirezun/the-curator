#!/usr/bin/env node
/**
 * test-pro-mode.js — the app-wide Pro switch (v4.2, build contract 2026-11-26).
 *
 *   §1  the stored field: `.curator-config.json` → `uiDetail`, through the
 *       REAL config.js against an isolated user-data dir. Lenient read (absent,
 *       unknown, prototype keys, a damaged file → 'simple'), strict write
 *       (anything else refused, bytes unchanged), every other key kept, a
 *       damaged file refused with config_unreadable and left byte-identical.
 *   §2  the two routes on the REAL src/server.js (spawned, isolated, fake HOME,
 *       CURATOR_NO_OPEN): GET never fails; POST takes EXACTLY one body shape;
 *       400 invalid-ui-detail for every other; 409 config_unreadable over a
 *       damaged file; the cross-origin and Host guards apply.
 *   §3  shared/pro.js, driven with a fake DOM, fetch and storage: initPro()
 *       paints <html data-pro> SYNCHRONOUSLY from the mirror (before its first
 *       await — the "before first paint" property), fail-safe OFF, reconciles
 *       with the server, a press made while the read is in flight wins;
 *       setPro posts exactly the contract body, notifies once, reverts and
 *       toasts on failure; onProChange unsubscribes; proAttr and
 *       moreInProLine markup; the delegated switch and door clicks.
 *   §4  the wiring a browser runs: pro.css's one rule, index.html links it,
 *       boot() calls initPro() before it paints anything, the rail draws the
 *       switch directly above Settings, Settings › General draws the same one.
 *
 * No network beyond 127.0.0.1, no API key, nothing outside a tempdir.
 */
import {
  mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, rmSync, mkdirSync, readdirSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The real settings files must be untouched by this suite: fingerprinted now,
// compared at the end.
const REAL_FILES = [
  path.join(ROOT, '.curator-config.json'),
  path.join(homedir(), 'Library', 'Application Support', 'The Curator', '.curator-config.json'),
];
const sha = (b) => createHash('sha256').update(b).digest('hex');
const fingerprint = (f) => (existsSync(f) ? sha(readFileSync(f)) + ':' + statSync(f).size : 'absent');
const realBefore = REAL_FILES.map(fingerprint);

const TMP = mkdtempSync(path.join(tmpdir(), 'curator-pro-'));
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
function ok(cond, label, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (detail !== undefined ? `\n      ${String(detail).slice(0, 600)}` : '')); }
}
const section = (t) => console.log('\n' + t);

// config.js reports a damaged file on stderr once; keep the suite's output clean.
const origError = console.error;
const stderrLines = [];
console.error = (...a) => { stderrLines.push(a.join(' ')); };

const config = await import('../src/brain/config.js');
const paths = await import('../src/brain/paths.js');
const CFG = paths.getCuratorConfigFile();
ok(CFG.startsWith(USER_DATA + path.sep), '§0 the settings file resolves inside the test tempdir', CFG);

function clean() {
  for (const n of readdirSync(USER_DATA)) rmSync(path.join(USER_DATA, n), { recursive: true, force: true });
}
const KEYS = {
  geminiApiKey: 'AIza' + 'x'.repeat(35), anthropicApiKey: 'sk-ant-' + 'y'.repeat(40),
  domainsPath: DOMAINS, activeProvider: 'gemini', backgroundMode: 'tray', ui: { onboardingDismissed: '1' },
};
const BROKEN = JSON.stringify(KEYS, null, 2).replace('"activeProvider"', '"activeProvider" BROKEN');

// ════════════════════════════════════════════════════════════════════════
section('§1 the stored field (src/brain/config.js)');
{
  // 1a — the resolver, a truth table. Prototype keys are the case a plain
  // object table would get wrong.
  const table = [
    [undefined, 'simple'], [null, 'simple'], ['simple', 'simple'], ['pro', 'pro'], ['Pro', 'simple'],
    ['PRO', 'simple'], [' pro', 'simple'], ['on', 'simple'], [true, 'simple'], [1, 'simple'], [{}, 'simple'],
    [['pro'], 'simple'], ['__proto__', 'simple'], ['constructor', 'simple'], ['toString', 'simple'],
    ['hasOwnProperty', 'simple'], ['expert', 'simple'],
  ];
  const wrong = table.filter(([raw, want]) => config.resolveUiDetail(raw) !== want);
  ok(!wrong.length, `resolveUiDetail: ${table.length} inputs, only the literal 'pro' reads as pro`, JSON.stringify(wrong));
  ok(JSON.stringify(config.uiDetailNames()) === JSON.stringify(['simple', 'pro']), "the names are exactly 'simple' and 'pro'");

  // 1b — a missing file reads simple, and the first write creates it.
  clean();
  ok(!existsSync(CFG) && config.getUiDetail() === 'simple', 'no settings file → simple');
  let r = config.setUiDetail('pro');
  ok(r.ok && r.uiDetail === 'pro' && config.getUiDetail() === 'pro', "setUiDetail('pro') → stored and read back", JSON.stringify(r));
  ok(JSON.parse(readFileSync(CFG, 'utf8')).uiDetail === 'pro', 'the file holds uiDetail: "pro" at the top level');
  if (process.platform !== 'win32') ok((statSync(CFG).mode & 0o777) === 0o600, 'the file is written 0600');

  // 1c — every other key survives a write, both directions.
  clean();
  writeFileSync(CFG, JSON.stringify(KEYS, null, 2) + '\n');
  config.setUiDetail('pro');
  let back = JSON.parse(readFileSync(CFG, 'utf8'));
  const { uiDetail, ...rest } = back;
  ok(uiDetail === 'pro' && JSON.stringify(rest) === JSON.stringify(KEYS), 'turning Pro on keeps every API key, the folder, backgroundMode and ui.*', JSON.stringify(back));
  config.setUiDetail('simple');
  back = JSON.parse(readFileSync(CFG, 'utf8'));
  ok(back.uiDetail === 'simple' && back.geminiApiKey === KEYS.geminiApiKey && back.ui.onboardingDismissed === '1', 'and so does turning it off again');
  ok(config.getUiState().onboardingDismissed === '1', 'ui.* is not touched (a top-level field, not a ui-state one)');

  // 1d — strict write: refused, named, and the bytes do not move.
  config.setUiDetail('pro');
  const before = sha(readFileSync(CFG));
  const bad = ['Pro', 'on', '', ' pro', '__proto__', 'constructor', null, undefined, true, 1, {}, ['pro']];
  const accepted = bad.filter((v) => config.setUiDetail(v).ok);
  const r2 = config.setUiDetail('expert');
  ok(!accepted.length, `${bad.length} invalid values are all refused`, JSON.stringify(accepted));
  ok(r2.ok === false && r2.reason === 'invalid_value' && r2.uiDetail === 'pro', 'a refusal names invalid_value and reports the value still in force', JSON.stringify(r2));
  ok(sha(readFileSync(CFG)) === before, 'and the file is byte-identical after all of them');

  // 1e — a value a newer build wrote reads simple (lenient read), and is kept on disk.
  clean();
  writeFileSync(CFG, JSON.stringify({ ...KEYS, uiDetail: 'expert' }, null, 2) + '\n');
  ok(config.getUiDetail() === 'simple', "a value this build does not know ('expert') reads as simple");

  // 1f — a damaged file: reads simple, the write is refused with config_unreadable, nothing moves.
  clean();
  writeFileSync(CFG, BROKEN);
  const dmgBefore = sha(readFileSync(CFG));
  ok(config.getUiDetail() === 'simple', 'a damaged settings file reads as simple (never throws)');
  let err = null;
  try { config.setUiDetail('pro'); } catch (e) { err = e; }
  ok(err && err.code === 'config_unreadable', 'setUiDetail over a damaged file throws config_unreadable', err && err.message);
  ok(sha(readFileSync(CFG)) === dmgBefore, 'and the damaged file is byte-identical (every API key in it survives)');
  err = null;
  try { config.setUiDetail('simple'); } catch (e) { err = e; }
  ok(err && err.code === 'config_unreadable', "even writing the value it already reads ('simple') is refused, never answered \"saved\"");
}

// ════════════════════════════════════════════════════════════════════════
section('§2 the routes on the real server');
{
  const xud = path.join(TMP, 'xud');
  mkdirSync(xud, { recursive: true });
  const XCFG = path.join(xud, '.curator-config.json');
  const port = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const child = spawn(process.execPath, [path.join(ROOT, 'src/server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), CURATOR_NO_OPEN: '1', CURATOR_TEST_USER_DATA_DIR: xud,
      CURATOR_TEST_DOMAINS_DIR: DOMAINS, CURATOR_TEST_LOG_DIR: path.join(xud, 'logs'), HOME },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  const ORIGIN = `http://127.0.0.1:${port}`;
  async function call(method, body, { origin = ORIGIN, host, raw } = {}) {
    const headers = { Accept: 'application/json' };
    if (origin) headers.Origin = origin;
    if (host) headers.Host = host;
    if (body !== undefined || raw !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`http://127.0.0.1:${port}/api/config/ui-detail`, {
      method, headers, body: raw !== undefined ? raw : (body === undefined ? undefined : JSON.stringify(body)),
    });
    let j = null; try { j = await res.json(); } catch { j = null; }
    return { status: res.status, body: j };
  }
  try {
    let up = null;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline && child.exitCode === null) {
      try { up = await call('GET'); if (up.status) break; } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    ok(up && up.status === 200 && up.body && up.body.uiDetail === 'simple', 'GET on a fresh install → 200 {"uiDetail":"simple"}', JSON.stringify(up) + ' | ' + out.split('\n').slice(0, 3).join(' | '));
    ok(up && JSON.stringify(Object.keys(up.body || {})) === '["uiDetail"]', 'the GET body is exactly {uiDetail}');

    const on = await call('POST', { uiDetail: 'pro' });
    ok(on.status === 200 && JSON.stringify(on.body) === '{"uiDetail":"pro"}', 'POST {"uiDetail":"pro"} → 200 {"uiDetail":"pro"}', JSON.stringify(on));
    const g2 = await call('GET');
    ok(g2.body && g2.body.uiDetail === 'pro', 'GET then reads pro');
    ok(existsSync(XCFG) && JSON.parse(readFileSync(XCFG, 'utf8')).uiDetail === 'pro', "and it is in THIS server's .curator-config.json");

    const stored = sha(readFileSync(XCFG));
    const badBodies = [
      [{ uiDetail: 'Pro' }, 'a wrong-case value'], [{ uiDetail: 'on' }, 'another word'], [{ uiDetail: true }, 'a boolean'],
      [{ uiDetail: null }, 'null'], [{}, 'an empty object'], [{ uiDetail: 'pro', extra: 1 }, 'an extra key'],
      [{ value: 'pro' }, 'the wrong key'], [['pro'], 'an array'], [{ uiDetail: ['pro'] }, 'an array value'],
      [{ __proto__: { uiDetail: 'pro' } }, 'a value only on the prototype'],
    ];
    for (const [b, what] of badBodies) {
      const r = await call('POST', b);
      ok(r.status === 400 && r.body && r.body.code === 'invalid-ui-detail', `400 invalid-ui-detail for ${what}`, JSON.stringify(r));
    }
    const rawStr = await call('POST', undefined, { raw: '"pro"' });
    ok(rawStr.status === 400, 'a bare JSON string body is refused (400)', JSON.stringify(rawStr));
    ok(sha(readFileSync(XCFG)) === stored, 'no refused body changed the file');

    const evil = await call('POST', { uiDetail: 'simple' }, { origin: 'http://evil.example' });
    ok(evil.status === 403, 'a foreign Origin is refused 403 (the cross-origin guard applies)', JSON.stringify(evil));
    const wrongPort = await call('POST', { uiDetail: 'simple' }, { origin: `http://127.0.0.1:${port + 1}` });
    ok(wrongPort.status === 403, 'a loopback Origin on another port is refused too');
    // fetch() may not set Host (a forbidden header), so this one is raw http.
    const badHost = await new Promise((resolve) => {
      const rq = http.request({ host: '127.0.0.1', port, path: '/api/config/ui-detail', method: 'GET',
        headers: { Host: 'attacker.example' } }, (rs) => { rs.resume(); resolve({ status: rs.statusCode }); });
      rq.on('error', (e) => resolve({ status: 0, error: e.message }));
      rq.end();
    });
    ok(badHost.status === 403, 'a foreign Host header is refused 403 on the GET (DNS-rebinding guard)', JSON.stringify(badHost));
    ok(sha(readFileSync(XCFG)) === stored, 'still pro on disk after the refused cross-origin write');

    const off = await call('POST', { uiDetail: 'simple' });
    ok(off.status === 200 && off.body.uiDetail === 'simple' && (await call('GET')).body.uiDetail === 'simple', 'POST simple → off again, read back');

    // A damaged file: GET still answers simple; POST is 409 config_unreadable; bytes unchanged.
    writeFileSync(XCFG, BROKEN);
    const dmg = sha(readFileSync(XCFG));
    const gd = await call('GET');
    ok(gd.status === 200 && gd.body && gd.body.uiDetail === 'simple', 'GET over a damaged file → 200 simple (it never fails)', JSON.stringify(gd));
    const pd = await call('POST', { uiDetail: 'pro' });
    ok(pd.status === 409 && pd.body && pd.body.code === 'config_unreadable', 'POST over a damaged file → 409 config_unreadable', JSON.stringify(pd));
    ok(pd.body && typeof pd.body.error === 'string' && !pd.body.error.includes(xud), 'its sentence names no absolute path');
    ok(sha(readFileSync(XCFG)) === dmg, 'and the damaged file is byte-identical');
  } finally {
    child.kill('SIGTERM');
  }
}

// ════════════════════════════════════════════════════════════════════════
section('§3 shared/pro.js, driven with a fake DOM');
const P = await import('../src/public/next/shared/pro.js');

/** A DOM just big enough for pro.js: attributes, closest(), a click listener, a toast body. */
function fakeEl(tag, attrs = {}, parent = null) {
  const a = new Map(Object.entries(attrs));
  const el = {
    tag, parentElement: parent, isConnected: true, id: attrs.id || '', children: [], textContent: '',
    getAttribute: (k) => (a.has(k) ? a.get(k) : null),
    setAttribute: (k, v) => { a.set(k, String(v)); if (k === 'id') el.id = String(v); },
    hasAttribute: (k) => a.has(k),
    closest(sel) {
      const alts = sel.split(',').map((s) => s.trim());
      for (let n = el; n; n = n.parentElement) {
        for (const s of alts) {
          const m = /^\[([\w-]+)\]$/.exec(s);
          if (m && n.hasAttribute(m[1])) return n;
          if (s === n.tag) return n;
        }
      }
      return null;
    },
    getBoundingClientRect: () => ({ top: el._top || 0 }),
    focus() { doc.activeElement = el; },
    querySelector: () => null,
    appendChild(c) { el.children.push(c); c.parentElement = el; return c; },
  };
  return el;
}
let doc;
function makeEnv({ mirror, lsThrows = false, fetchImpl } = {}) {
  const root = fakeEl('html');
  const switches = [];
  const listeners = [];
  const toasts = [];
  const store = new Map(mirror === undefined ? [] : [['curator-next-pro', mirror]]);
  const toastBody = fakeEl('div');
  doc = {
    documentElement: root,
    body: fakeEl('body'),
    activeElement: null,
    scrollingElement: { scrollTop: 0 },
    querySelectorAll: (sel) => (sel === '[data-pro-switch]' ? switches : []),
    querySelector: (sel) => (sel.includes('pro-mode-on') && toasts.some((t) => t.key === 'pro-mode-on') ? toastBody : null),
    getElementById: () => null,
    addEventListener: (type, fn) => listeners.push({ type, fn }),
    createElement: (tag) => fakeEl(tag),
  };
  toastBody.querySelector = (sel) => toastBody.children.find((c) => sel === '[data-pro-undo]' && c.hasAttribute('data-pro-undo')) || null;
  const calls = [];
  const env = {
    document: doc,
    window: { getComputedStyle: () => ({ overflowY: 'visible' }) },
    localStorage: lsThrows
      ? { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } }
      : { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    fetch: async (url, init = {}) => { calls.push({ url, init }); return fetchImpl(url, init, calls.length); },
    toast: (o) => { toasts.push(o); return o.key; },
    dismissToast: (k) => { const i = toasts.findIndex((t) => t.key === k); if (i >= 0) toasts.splice(i, 1); return i >= 0; },
    requestAnimationFrame: (fn) => fn(),
  };
  P.__resetPro();
  P.__setProEnv(env);
  return { root, switches, listeners, toasts, store, calls, toastBody,
    click: (target) => listeners.filter((l) => l.type === 'click').forEach((l) => l.fn({ target, preventDefault() {} })) };
}
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const tick = () => new Promise((r) => setTimeout(r, 0));

{
  // 3a — the first paint comes from the mirror, synchronously.
  let release;
  const gate = new Promise((r) => { release = r; });
  let E = makeEnv({ mirror: 'on', fetchImpl: async () => { await gate; return json(200, { uiDetail: 'pro' }); } });
  const p = P.initPro();
  ok(E.root.getAttribute('data-pro') === 'on', 'initPro() sets <html data-pro="on"> from the mirror BEFORE its first await (no wrong first frame)');
  ok(P.isPro() === true, 'isPro() is already true synchronously');
  const again = P.initPro();
  release(); await p; await again;
  ok(E.calls.length === 1, 'a second initPro() does not read again (once per page)', E.calls.length);

  E = makeEnv({ fetchImpl: async () => json(200, { uiDetail: 'simple' }) });
  P.initPro();
  ok(E.root.getAttribute('data-pro') === 'off' && P.isPro() === false, 'no mirror → off on the first paint (the fail-safe direction)');
  E = makeEnv({ lsThrows: true, fetchImpl: async () => json(200, { uiDetail: 'simple' }) });
  let threw = false;
  try { P.initPro(); } catch { threw = true; }
  ok(!threw && E.root.getAttribute('data-pro') === 'off', 'a throwing localStorage → off, and initPro does not throw');

  // 3b — the server wins on load; listeners hear it once.
  E = makeEnv({ fetchImpl: async () => json(200, { uiDetail: 'pro' }) });
  const heard = [];
  P.onProChange((v) => heard.push(v));
  await P.initPro();
  ok(P.isPro() === true && E.root.getAttribute('data-pro') === 'on', 'the server says pro → on after the read lands');
  ok(JSON.stringify(heard) === '[true]', 'the listener is told exactly once', JSON.stringify(heard));
  ok(E.store.get('curator-next-pro') === 'on', 'and the mirror is updated for the next first paint');
  ok(E.calls[0].url === '/api/config/ui-detail' && !E.calls[0].init.method, 'initPro reads GET /api/config/ui-detail');

  // 3c — a failed read keeps the mirror's answer.
  E = makeEnv({ mirror: 'on', fetchImpl: async () => { throw new Error('offline'); } });
  await P.initPro();
  ok(P.isPro() === true, 'a failed GET keeps the mirror (on)');
  E = makeEnv({ fetchImpl: async () => json(200, '<html>') });
  await P.initPro();
  ok(P.isPro() === false, 'a junk GET body changes nothing (off stays off)');

  // 3d — a press while the first read is in flight wins over the read.
  let releaseRead;
  const readGate = new Promise((r) => { releaseRead = r; });
  E = makeEnv({ fetchImpl: async (url, init) => (init.method === 'POST'
    ? json(200, { uiDetail: 'pro' })
    : (await readGate, json(200, { uiDetail: 'simple' }))) });
  const initP = P.initPro();
  await P.setPro(true);
  releaseRead(); await initP;
  ok(P.isPro() === true, "a press made while the boot read was in flight is not undone by the read's older answer");

  // 3e — setPro: the contract body, the screen first, then the server.
  E = makeEnv({ fetchImpl: async (u, i) => json(200, { uiDetail: i.method === 'POST' ? JSON.parse(i.body).uiDetail : 'simple' }) });
  await P.initPro();
  const sw = fakeEl('button', { 'data-pro-switch': '', 'aria-checked': 'false' });
  E.switches.push(sw);
  const seen = [];
  const un = P.onProChange((v) => seen.push(v));
  const sp = P.setPro(true);
  ok(E.root.getAttribute('data-pro') === 'on' && sw.getAttribute('aria-checked') === 'true', 'setPro(true) flips <html data-pro> and every switch at once, before the request returns');
  ok(JSON.stringify(seen) === '[true]', 'listeners are told before the request returns, once');
  await sp;
  const post = E.calls.find((c) => c.init.method === 'POST');
  ok(post && post.url === '/api/config/ui-detail' && post.init.body === '{"uiDetail":"pro"}', 'POST body is exactly {"uiDetail":"pro"}', post && post.init.body);
  await P.setPro(true);
  ok(JSON.stringify(seen) === '[true]', 'pressing for the state already in force notifies nobody');
  un();
  await P.setPro(false);
  ok(JSON.stringify(seen) === '[true]', 'an unsubscribed listener hears nothing');
  ok(E.calls.filter((c) => c.init.method === 'POST').pop().init.body === '{"uiDetail":"simple"}', 'setPro(false) posts {"uiDetail":"simple"}');

  // 3f — a failed save reverts and toasts.
  for (const [what, impl] of [
    ['a 409 config_unreadable', async (u, i) => (i.method === 'POST' ? json(409, { code: 'config_unreadable', error: 'Your settings file could not be read, so nothing was saved.' }) : json(200, { uiDetail: 'simple' }))],
    ['a network failure', async (u, i) => { if (i.method === 'POST') throw new Error('Failed to fetch'); return json(200, { uiDetail: 'simple' }); }],
    ['a 200 whose body is not the contract', async (u, i) => (i.method === 'POST' ? json(200, { ok: true }) : json(200, { uiDetail: 'simple' }))],
  ]) {
    E = makeEnv({ fetchImpl: impl });
    await P.initPro();
    const sw2 = fakeEl('button', { 'data-pro-switch': '', 'aria-checked': 'false' });
    E.switches.push(sw2);
    const log = [];
    P.onProChange((v) => log.push(v));
    const res = await P.setPro(true);
    ok(res === false && P.isPro() === false && E.root.getAttribute('data-pro') === 'off' && sw2.getAttribute('aria-checked') === 'false',
      `${what}: the switch reverts to off`);
    ok(JSON.stringify(log) === '[true,false]', `${what}: listeners hear on, then the revert`, JSON.stringify(log));
    ok(E.toasts.length === 1 && /still off/i.test(E.toasts[0].title) && E.toasts[0].tone === 'attention', `${what}: one toast says Pro is still off`, JSON.stringify(E.toasts));
  }

  // 3g — markup.
  ok(P.proAttr() === ' data-detail="pro"', "proAttr() is exactly ' data-detail=\"pro\"'");
  const door = P.moreInProLine('every check per <harness>');
  ok(/data-pro-more/.test(door) && /More in Pro: every check per &lt;harness&gt;/.test(door) && !/<harness>/.test(door), 'moreInProLine names what is behind it, escaped', door);
  ok(/class="btn btn-ghost btn-xs pro-more-btn"/.test(door) && /<p class="pro-more">/.test(door), 'the door is a quiet ghost button in a .pro-more line');
  P.__resetPro(); P.__setProEnv({});
  const s0 = P.proSwitchHtml({ id: 'x-sw' });
  ok(/role="switch"/.test(s0) && /aria-checked="false"/.test(s0) && /aria-label="Pro"/.test(s0) && /class="cur-switch"/.test(s0) && /<span class="cur-switch-knob"><\/span>/.test(s0),
    'proSwitchHtml: the shared cur-switch, role="switch", aria-checked, named "Pro"', s0);
  ok(s0.includes('title="' + P.PRO_TOOLTIP.replace(/—/g, '—') + '"') && P.PRO_TOOLTIP === 'Pro shows every detail and control. Free — nothing is removed.', 'its tooltip is the contract sentence');
  ok(!/id="/.test(P.proSwitchHtml({ id: '"><script>' })), 'an unsafe id is dropped, never interpolated');

  // 3h — the delegated clicks: a switch toggles, a door turns Pro on with Undo.
  E = makeEnv({ fetchImpl: async (u, i) => json(200, { uiDetail: i.method === 'POST' ? JSON.parse(i.body).uiDetail : 'simple' }) });
  await P.initPro();
  ok(E.listeners.filter((l) => l.type === 'click').length === 1, 'initPro installs ONE delegated click listener');
  const host = fakeEl('div', { 'data-pro-toggle': '' });
  const cap = fakeEl('span', {}, host);
  E.click(cap); await tick();
  ok(P.isPro() === true, "a click on the rail item's caption (inside [data-pro-toggle]) turns Pro on");
  const swb = fakeEl('button', { 'data-pro-switch': '' }, host);
  E.click(swb); await tick();
  ok(P.isPro() === false, 'a click on the switch itself turns it off (one toggle, not two)');
  const disabled = fakeEl('button', { 'data-pro-switch': '', disabled: '' });
  E.click(disabled); await tick();
  ok(P.isPro() === false, 'a disabled switch does nothing');
  const section1 = fakeEl('section', { id: 'sec-a' });
  const line = fakeEl('p', {}, section1);
  const btn = fakeEl('button', { 'data-pro-more': '' }, line);
  doc.activeElement = btn;
  E.click(btn); await tick(); await tick();
  ok(P.isPro() === true, 'the "More in Pro" door turns Pro on');
  ok(E.toasts.some((t) => t.key === 'pro-mode-on' && t.title === 'Pro is on'), 'and shows the toast "Pro is on"');
  const undo = E.toastBody.children.find((c) => c.hasAttribute('data-pro-undo'));
  ok(undo && undo.textContent === 'Undo' && undo.getAttribute('type') === 'button', 'the toast carries a real Undo button');
  ok(doc.activeElement === section1 && section1.getAttribute('tabindex') === '-1', 'focus moves to the section the door closed (never left on body)');
  E.click(undo); await tick(); await tick();
  ok(P.isPro() === false && !E.toasts.some((t) => t.key === 'pro-mode-on'), 'Undo turns Pro off and closes the toast');
}

// ════════════════════════════════════════════════════════════════════════
section('§4 the wiring a browser runs');
{
  const css = readFileSync(path.join(ROOT, 'src/public/next/shared/pro.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  ok(/html:not\(\[data-pro="on"\]\) \[data-detail="pro"\] \{ display: none !important; \}/.test(css), 'pro.css holds the contract rule verbatim');
  const html = readFileSync(path.join(ROOT, 'src/public/next/index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  ok(/<link rel="stylesheet" href="\/next\/shared\/pro\.css">/.test(html), 'index.html links shared/pro.css');

  const app = readFileSync(path.join(ROOT, 'src/public/next/app.js'), 'utf8');
  const m = /\nfunction boot\(\) \{([\s\S]*?)\n\}\n/.exec(app);
  const boot = m ? m[1].replace(/\/\/.*$/gm, '') : '';
  const iInit = boot.indexOf('initPro()');
  const firsts = ['applyFontScale(', 'applyTheme(', 'renderRail()', 'navigate('].map((s) => boot.indexOf(s));
  ok(iInit > -1 && firsts.every((i) => i > iInit), 'boot() calls initPro() before it applies the theme, builds the rail or mounts a view', JSON.stringify({ iInit, firsts }));
  ok(!/await\s+initPro/.test(boot) && /try \{ initPro\(\); \} catch/.test(boot), 'not awaited, and contained (boot() must reach markBooted())');

  // The rail, rendered by the REAL renderRail() over a recording DOM: the
  // switch sits directly above Settings.
  const fnSrc = (name) => {
    const i = app.search(new RegExp('\\n(?:export )?function ' + name + '\\('));
    let j = app.indexOf('{', app.indexOf('(', i)), d = 0;
    for (; j < app.length; j++) { if (app[j] === '{') d++; else if (app[j] === '}') { d--; if (d === 0) { j++; break; } } }
    return app.slice(i, j).replace(/^\n?export /, '\n');
  };
  const constSrc = (name) => { const r = new RegExp('\\nconst ' + name + ' = [\\s\\S]*?;\\n').exec(app); return r ? r[0] : ''; };
  let railHtml = '';
  const box = new Function('__env', `
    const { document, icon, syncBadgeTitle, syncBadgeMarkup, renderThemeToggleIcon, renderRailActive,
            applySyncBadge, toggleTheme, navigate, state, proSwitchHtml, PRO_TOOLTIP, sidebarDrawer } = __env;
    let _syncPendingCount = 0;
    ${['NAV_VIEWS', 'HOSTED_VIEWS', 'FOOTER_VIEWS', 'ALL_VIEWS', 'RAIL_DIVIDER_AFTER', 'HOME_VIEW', 'VIEW_META'].map(constSrc).join('\n')}
    ${fnSrc('escapeHtml')}
    ${fnSrc('renderRail')}
    return renderRail;`);
  const P2 = P;
  for (const on of [false, true]) {
    P2.__resetPro();
    P2.__setProEnv({ fetch: async () => json(200, { uiDetail: 'pro' }), localStorage: { getItem: () => null, setItem() {} }, document: { documentElement: fakeEl('html'), querySelectorAll: () => [], addEventListener() {} } });
    if (on) await P2.setPro(true);
    const rail = { set innerHTML(v) { railHtml = v; }, get innerHTML() { return railHtml; }, querySelectorAll: () => [] };
    const render = box({
      document: { getElementById: (id) => (id === 'rail' ? rail : { addEventListener() {} }), querySelectorAll: () => [] },
      icon: (n) => `<svg data-icon="${n}"></svg>`, syncBadgeTitle: () => 'Sync', syncBadgeMarkup: () => '',
      renderThemeToggleIcon() {}, renderRailActive() {}, applySyncBadge() {}, toggleTheme() {}, navigate() {},
      state: { theme: 'dark', view: 'domains' }, proSwitchHtml: P2.proSwitchHtml, PRO_TOOLTIP: P2.PRO_TOOLTIP, sidebarDrawer: () => null,
    });
    render();
    const iSync = railHtml.indexOf('data-view="sync"');
    const iPro = railHtml.indexOf('class="rail-pro"');
    const iSettings = railHtml.indexOf('data-view="settings"');
    ok(iSync > -1 && iSync < iPro && iPro < iSettings, `rail (${on ? 'Pro on' : 'Pro off'}): the Pro item sits between Sync and Settings — directly above Settings`, JSON.stringify({ iSync, iPro, iSettings }));
    const between = railHtml.slice(iPro, iSettings);
    ok(new RegExp('role="switch"[^>]*aria-checked="' + on + '"').test(between) && /aria-label="Pro"/.test(between) && />Pro<\/span>/.test(between) && /data-pro-toggle/.test(between),
      `rail (${on ? 'Pro on' : 'Pro off'}): role="switch", aria-checked="${on}", named "Pro", captioned "Pro"`, between);
  }

  const settings = readFileSync(path.join(ROOT, 'src/public/next/views/settings.js'), 'utf8');
  const gen = /\nfunction renderGeneral\(\) \{[\s\S]*?\n\}\n/.exec(settings);
  ok(gen && /renderProMode\(\)/.test(gen[0].replace(/\/\/.*$/gm, '')), 'Settings › General renders the Pro block');
  const pm = /\nfunction renderProMode\(\) \{[\s\S]*?\n\}\n/.exec(settings);
  ok(pm && /proSwitchHtml\(\{ id: 'settings-pro-switch' \}\)/.test(pm[0]) && /'Pro mode'/.test(pm[0]), '…with the same proSwitchHtml switch, under the heading "Pro mode"');
}

console.error = origError;
const realAfter = REAL_FILES.map(fingerprint);
ok(JSON.stringify(realAfter) === JSON.stringify(realBefore), 'the real settings files were not touched');
rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
