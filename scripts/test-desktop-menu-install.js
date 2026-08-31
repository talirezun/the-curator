/**
 * test-desktop-menu-install.js — OFFLINE guard for `desktop/lib/update-client.js`.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  THE DEFECT THIS SUITE EXISTS FOR, AND WHY IT NEEDS A DIFFERENT KIND OF   ║
 * ║  ASSERTION THAN THE ONE THAT MISSED IT.                                   ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * v3.33.0 shipped an in-app updater and a "Check for Updates…" menu in the
 * same release, built by two agents. The engine worked. The menu still told
 * the user "This build does not install updates by itself" and opened a web
 * page — TRUE of v3.31.0, when it was written, and false from the moment the
 * engine landed beside it. It survived two more releases and the maintainer
 * met it on the shipped v3.35.0.
 *
 * `test-desktop-menu.js` was green throughout, and it even asserted that
 * sentence was present. THAT IS THE LESSON: a guard that checks a string is
 * there cannot notice that the string has become a lie. It can only notice
 * that somebody deleted it.
 *
 * So nothing in this file asserts a sentence in isolation. Every assertion is
 * about what the shell DOES: which requests it issues, in which order, what it
 * does with each answer, and what it never does.
 *
 * ── METHOD ──────────────────────────────────────────────────────────────────
 *
 * `runInstall` is EXECUTED end to end. The SSE stream is a real
 * `ReadableStream` inside a real `Response`, decoded by the real `TextDecoder`
 * in the module under test; the progress events are the shapes
 * `src/routes/config.js` really sends. What is faked is exactly one thing:
 * `fetch`. Every request it receives is recorded, so the assertions are about
 * observed traffic rather than about source text.
 *
 * ── SECTIONS ────────────────────────────────────────────────────────────────
 *   §0  positive control — the module really loaded
 *   §1  the four endpoint constants are routes that REALLY EXIST
 *   §2  normaliseUpdaterProbe — and "we could not ask" as a third value
 *   §3  parseSseFrames — chopped at every byte boundary
 *   §4  updateMenuLabel — one label per phase, and percent:null as its own fact
 *   §5  THE FIX, EXECUTED — the menu downloads and installs
 *   §6  every refusal, relayed rather than re-authored
 *   §7  a refused SWAP is "downloaded", not "failed"
 *   §8  applyOnly — no second 140 MB download
 *   §9  the menu is rebuilt ~100 times, not ~550
 *   §10 source discipline — no comparator, no path, no token
 *   §11 a tripwire against reaching the real network
 *
 * ── NOT ENFORCED, stated rather than implied away ───────────────────────────
 *
 *  - `desktop/main.js` IS NOT EXECUTED, here or anywhere. Electron is
 *    deliberately not an offline-suite dependency, so the four lines of wiring
 *    that live there — two `dialog.showMessageBox` calls, `applyMenu()`, and
 *    holding the label in a variable — are covered only by the source scan in
 *    `test-desktop-menu.js` §11. Nothing in this repository has ever rendered
 *    that dialog or clicked that menu item automatically.
 *  - NO HTTP SERVER RUNS. The route's behaviour is transcribed from
 *    `src/routes/config.js` (its status codes, its SSE frames, its refusal
 *    bodies) and §1 pins the URLs to it, but the two halves have never been
 *    connected to each other by this suite. An `installerUpdateApply` that
 *    changed its event names would red §1 only if it also changed a route
 *    path.
 *  - NO UPDATE HAS EVER BEEN INSTALLED BY THIS FILE. It proves the shell asks
 *    for one correctly. `test-desktop-update.js` proves the engine performs
 *    one; `test-desktop-update-macos.js` proves the macOS tools do their part.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DESKTOP = path.join(ROOT, 'desktop');

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${label}`); }
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${label}\n      expected ${b}\n      got      ${a}`); }
}
function section(t) { console.log(`\n${t}`); }
function read(p) { return readFileSync(p, 'utf8'); }

/** Comments stripped so a line of PROSE about a rule can never satisfy the
 *  rule. Same helper, same reason, as test-desktop-menu.js. */
function stripJsComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e === -1 ? n : e + 2; continue; }
    if (c === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); i = e === -1 ? n : e; continue; }
    if (c === '\'' || c === '"' || c === '`') {
      const q = c; out += c; i++;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        out += src[i];
        if (src[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

const client = await import(path.join(DESKTOP, 'lib', 'update-client.js'));
const verdictMod = await import(path.join(DESKTOP, 'lib', 'update-verdict.js'));

// ═══════════════════════════════════════════════════════════════════════════
section('§0 positive control — the module really loaded');
// ═══════════════════════════════════════════════════════════════════════════
ok(typeof client.runInstall === 'function', 'runInstall is a function');
ok(typeof client.updateMenuLabel === 'function', 'updateMenuLabel is a function');
ok(typeof client.parseSseFrames === 'function', 'parseSseFrames is a function');
ok(typeof client.normaliseUpdaterProbe === 'function', 'normaliseUpdaterProbe is a function');
ok(typeof client.fetchUpdaterProbe === 'function', 'fetchUpdaterProbe is a function');

// ═══════════════════════════════════════════════════════════════════════════
section('§1 the endpoint constants are routes that REALLY EXIST');
// ═══════════════════════════════════════════════════════════════════════════
// A typo in one of these is a 404 the user meets as "the update could not
// start" — a failure with no cause visible anywhere. So each one is pinned to
// `src/routes/config.js` by reading it, the same cross-file technique
// lib/menu.js uses for RELEASES_URL.
{
  const routes = read(path.join(ROOT, 'src', 'routes', 'config.js'));
  ok(routes.length > 100000, `CONTROL — the route file really loaded (${routes.length} chars)`);

  // The router is mounted at /api/config, so the registered paths are the
  // constants with that prefix removed.
  // The string searched for is DERIVED FROM THE CONSTANT, never typed beside
  // it — otherwise a typo in the constant would leave the hand-written literal
  // matching happily and the pin would prove nothing.
  const PREFIX = '/api/config';
  const cases = [
    [client.UPDATE_CHECK_PATH, 'get'],
    [client.UPDATE_PROGRESS_PATH, 'get'],
    [client.UPDATE_STAGE_PATH, 'post'],
    [client.UPDATE_APPLY_PATH, 'post'],
  ];
  for (const [constant, verb] of cases) {
    ok(constant.startsWith(`${PREFIX}/`), `${constant} is under ${PREFIX}, which is where this router is mounted`);
    const registration = `router.${verb}('${constant.slice(PREFIX.length)}'`;
    ok(routes.includes(registration),
       `  and ${constant} names a route REALLY REGISTERED in src/routes/config.js (${registration}…)`);
  }
  // CONTROLS, both directions: a path that does not exist is not found, and a
  // path that exists under the WRONG verb is not found either.
  ok(!routes.includes("router.post('/update-check'"),
     'CONTROL — an existing path under the wrong verb is NOT matched, so the check reads the verb');
  ok(!routes.includes("router.post('/update-apply'"),
     'CONTROL — a plausible-but-wrong path is not matched, so the check reads the path');

  // The one this module must NOT know about.
  const src = stripJsComments(read(path.join(DESKTOP, 'lib', 'update-client.js')));
  ok(!/desktop-host|prepareUpdate|installUpdate/.test(src),
     'THE ARCHITECTURAL CLAIM, AS A GREP: this module never names the engine hooks — it drives the ROUTE, so the server keeps its one job record and Settings can see the same download');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2 normaliseUpdaterProbe — and "we could not ask" as a THIRD value');
// ═══════════════════════════════════════════════════════════════════════════
// "there is no updater" and "we could not find out" are different facts and
// must never share a value — the rule this project records for the cost path
// and for `percent`. They happen to lead to the same dialog, which is the
// fail-safe direction, but the value that reaches it is distinguishable.
{
  const N = client.normaliseUpdaterProbe;
  eq(N({ ok: true, updaterAttached: true, job: null }), { attached: true, jobState: null, jobVersion: null },
     'an attached updater with no job');
  eq(N({ ok: true, updaterAttached: false, job: null }), { attached: false, jobState: null, jobVersion: null },
     'a build with no updater says FALSE');
  for (const junk of [null, undefined, {}, { ok: false }, [], 'no', { ok: true }]) {
    const r = N(junk);
    ok(r.attached === null || r.attached === false,
       `an unusable probe (${JSON.stringify(junk)}) never reports attached:true`);
  }
  eq(N(null).attached, null, 'a probe that did not answer at all is NULL, not false');
  eq(N({ ok: true }).attached, false, 'CONTROL — but a probe that DID answer and said nothing about a hook is false, not null');

  eq(N({ ok: true, updaterAttached: true, job: { state: 'running', version: '3.35.0' } }),
     { attached: true, jobState: 'running', jobVersion: '3.35.0' }, 'a running job is carried through with its version');
  for (const bad of ['queued', '', null, 42, 'RUNNING']) {
    eq(N({ ok: true, updaterAttached: true, job: { state: bad } }).jobState, null,
       `an unrecognised job state (${JSON.stringify(bad)}) is dropped rather than passed to a switch that has no arm for it`);
  }
  // The state list is the route's. Pinned, so a new state added there cannot
  // be silently ignored here forever.
  {
    const routes = read(path.join(ROOT, 'src', 'routes', 'config.js'));
    for (const s of client.JOB_STATES) {
      ok(routes.includes(`'${s}'`), `job state "${s}" appears in src/routes/config.js`);
    }
    ok(!routes.includes("state: 'queued'"), 'CONTROL — a state this suite invented is NOT in the route file');
  }
  // A token must never appear, even if a future route leaked one.
  eq(N({ ok: true, updaterAttached: true, job: { state: 'staged', version: '3.35.0', token: 'secret' } }).token, undefined,
     'a token in the payload is not carried into the normalised record — the allow-list shape, applied on the way in too');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3 parseSseFrames — chopped at EVERY byte boundary');
// ═══════════════════════════════════════════════════════════════════════════
// The interesting failure is a frame split across two network reads, which a
// test feeding one whole string cannot see. So the same stream is re-fed one
// character at a time and the same events must come out.
{
  const P = client.parseSseFrames;
  const wire =
    'event: progress\ndata: {"type":"progress","phase":"downloading","receivedBytes":100,"totalBytes":1000,"percent":10}\n\n' +
    'event: progress\ndata: {"type":"progress","phase":"downloading","receivedBytes":900,"totalBytes":1000,"percent":90}\n\n' +
    'event: staged\ndata: {"type":"staged","version":"3.35.0","prerelease":false,"warning":null}\n\n';

  const whole = P(wire);
  eq(whole.events.length, 3, 'three frames come out of the whole stream');
  eq(whole.events.map((e) => e.type), ['progress', 'progress', 'staged'], 'in order, with their types');
  eq(whole.rest, '', 'and nothing is left over');

  // One character at a time.
  let buf = '';
  const drip = [];
  for (const ch of wire) {
    buf += ch;
    const r = P(buf);
    buf = r.rest;
    drip.push(...r.events);
  }
  eq(drip.length, 3, 'the SAME three frames come out when the stream arrives one character at a time');
  eq(JSON.stringify(drip), JSON.stringify(whole.events), 'and they are identical events, not merely the same count');

  // Partial frames are held, never emitted half-parsed.
  const partial = P('event: progress\ndata: {"phase":"downl');
  eq(partial.events.length, 0, 'an incomplete frame yields no events');
  ok(partial.rest.length > 0, '  and is held in `rest` for the next read');

  // Malformed payloads are skipped, not thrown on. This is remote input.
  eq(P('event: progress\ndata: not json\n\n').events.length, 0, 'an unparseable payload is skipped rather than throwing');
  eq(P('event: progress\n\n').events.length, 0, 'a frame with no data line yields nothing');
  eq(P('data: {"a":1}\n\n').events[0].type, 'message', 'a frame with no event line defaults to "message" rather than crashing');
  for (const junk of [null, undefined, 42, {}, []]) {
    let threw = false;
    try { P(junk); } catch { threw = true; }
    ok(!threw, `parseSseFrames(${JSON.stringify(junk)}) degrades instead of throwing`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4 updateMenuLabel — one label per phase, and percent:null as a fact');
// ═══════════════════════════════════════════════════════════════════════════
{
  const L = client.updateMenuLabel;
  const PHASES = ['resolving', 'downloading', 'verifying', 'staging', 'installing'];
  const labels = PHASES.map((phase) => L({ phase }));
  ok(new Set(labels).size === PHASES.length,
     `every phase gets a DISTINCT label (${labels.join(' | ')}) — a display that says the same thing for three different stages is not a display`);
  for (const l of labels) {
    ok(typeof l === 'string' && l.length > 0, `"${l}" is a real string`);
    ok(l.endsWith('…') || /%|MB/.test(l), `"${l}" reads as an operation in progress`);
  }

  eq(L({ phase: 'downloading', receivedBytes: 60129542, totalBytes: 143654912, percent: 41.86 }),
     'Downloading Update… 41%', 'a known percentage is shown, floored to a whole number so the label changes at most 101 times');

  // `percent: null` — never a number — is the route's own rule when the total
  // is unknown. A bar at 0% is a different claim from a bar that cannot know.
  const unknown = L({ phase: 'downloading', receivedBytes: 60129542, totalBytes: null, percent: null });
  ok(!/%/.test(unknown), 'an unknown total NEVER renders a percentage');
  ok(/MB/.test(unknown), '  it renders the bytes that ARE known instead');
  eq(unknown, 'Downloading Update… 57 MB', '  as megabytes, because nobody reads 60,129,542');
  eq(L({ phase: 'downloading', receivedBytes: 3355443, totalBytes: null, percent: null }), 'Downloading Update… 3.2 MB',
     'and one decimal below 10 MB, where a whole number would sit on "3 MB" for a long time');
  eq(L({ phase: 'downloading', receivedBytes: 0, totalBytes: null, percent: null }), client.INSTALL_LABEL_START,
     'zero bytes and no total is the plain starting label, not "0 MB"');

  // Out-of-range and junk. The route clamps, but this is still remote input.
  eq(L({ phase: 'downloading', percent: 250 }), 'Downloading Update… 100%', 'a percentage over 100 is clamped');
  eq(L({ phase: 'downloading', percent: -5 }), 'Downloading Update… 0%', 'and under 0');
  eq(L({ phase: 'downloading', percent: NaN, receivedBytes: 0 }), client.INSTALL_LABEL_START, 'NaN never reaches the label');
  for (const junk of [null, undefined, {}, { phase: 'wat' }, 42, 'downloading', []]) {
    const l = L(junk);
    ok(typeof l === 'string' && l.length > 0 && !/undefined|NaN|null/.test(l),
       `a junk job (${JSON.stringify(junk)}) still produces a readable label ("${l}")`);
    eq(l, client.UPDATE_LABEL_PENDING,
       `  and it is the neutral pending label, NOT "${client.INSTALL_LABEL_START}" — a phase we cannot describe must not be reported as a download`);
  }
  ok(!/download/i.test(client.UPDATE_LABEL_PENDING),
     'the pending label says nothing about downloading — main.js shows it between the click and the first progress record, and an apply-only run downloads nothing at all');
  ok(client.UPDATE_LABEL_PENDING !== client.INSTALL_LABEL_START,
     'CONTROL — the two labels are genuinely different strings');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5 THE FIX, EXECUTED — the menu downloads and installs');
// ═══════════════════════════════════════════════════════════════════════════
// This is the section the old design could not have passed. It does not look
// at a sentence. It records every HTTP request the shell issues and asserts
// that clicking the button in the dialog results in a DOWNLOAD and a SWAP.

/** A fake fetch that records everything and answers from a script. */
function recorder(handlers) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    calls.push({ url: String(url), method });
    for (const [match, respond] of handlers) {
      if (String(url).endsWith(match) && (!respond.method || respond.method === method)) {
        return respond.fn(String(url), init);
      }
    }
    throw new Error(`unscripted request: ${method} ${url}`);
  };
  return { impl, calls };
}

/** A real Response carrying a real ReadableStream of real SSE bytes. */
function sseResponse(frames, { chunkSize = 17 } = {}) {
  const text = frames.map((f) => `event: ${f.type}\ndata: ${JSON.stringify(f.data)}\n\n`).join('');
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream({
    start(controller) {
      // Deliberately chopped mid-frame — the real network does not respect
      // frame boundaries, and neither does this.
      for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const HAPPY_FRAMES = [
  { type: 'progress', data: { type: 'progress', phase: 'resolving', receivedBytes: 0, totalBytes: null, percent: null } },
  { type: 'progress', data: { type: 'progress', phase: 'downloading', receivedBytes: 0, totalBytes: 143654912, percent: 0 } },
  { type: 'progress', data: { type: 'progress', phase: 'downloading', receivedBytes: 71827456, totalBytes: 143654912, percent: 50 } },
  { type: 'progress', data: { type: 'progress', phase: 'verifying', receivedBytes: 143654912, totalBytes: 143654912, percent: 100 } },
  { type: 'progress', data: { type: 'progress', phase: 'staging', receivedBytes: 0, totalBytes: null, percent: null } },
  { type: 'staged', data: { type: 'staged', version: '3.35.0', prerelease: false, warning: null } },
];

{
  let applyRejected = 0;
  const rec = recorder([
    ['/api/config/update', { method: 'POST', fn: () => sseResponse(HAPPY_FRAMES) }],
    // The process going away mid-request is what the real apply looks like on
    // success: the swap helper takes over and the server is gone before it can
    // answer. Reproduced here as the rejection `fetch` really produces.
    ['/api/config/update/apply', { method: 'POST', fn: () => { applyRejected++; throw new TypeError('fetch failed'); } }],
  ]);
  const labels = [];
  const out = await client.runInstall('http://127.0.0.1:52341', { onLabel: (l) => labels.push(l) }, { fetchImpl: rec.impl });

  // ── The traffic. This IS the fix. ────────────────────────────────────────
  eq(rec.calls.map((c) => `${c.method} ${c.url.replace('http://127.0.0.1:52341', '')}`),
     ['POST /api/config/update', 'POST /api/config/update/apply'],
     'THE FIX: choosing the update from the menu issues a POST that DOWNLOADS and then a POST that INSTALLS — the two requests Settings ▸ General issues, in the same order');
  ok(!rec.calls.some((c) => c.method === 'GET'),
     'and nothing on this path merely READS — the old behaviour issued no POST at all, which is exactly the defect');

  eq(out.ok, true, 'the run reports success');
  eq(out.installing, true, '  and reports that an install is under way');
  eq(out.version, '3.35.0', '  naming the version the SERVER said was staged, not one computed here');

  // The apply request's connection dying IS the success case: the swap
  // happened and the process is going away underneath it. Counted, not
  // asserted with a bare `true` — the success above must be attributable to
  // the rejection actually having happened.
  eq(applyRejected, 1,
     'the apply request really did reject, and the run STILL reports success — a dead connection there means the swap took and the app is quitting');

  // ── The labels, in order, all five phases. ──────────────────────────────
  ok(labels.length >= 5, `the menu was relabelled through the run (${labels.length} times)`);
  eq(labels[0], 'Finding the Update…', 'the first label is the resolving phase');
  ok(labels.includes('Downloading Update… 50%'), 'a real percentage from the server reached the menu item');
  ok(labels.includes('Checking the Download…'), 'so did the verifying phase');
  ok(labels.includes('Preparing the Update…'), 'and the staging phase');
  eq(labels[labels.length - 1], 'Installing Update…', 'and the LAST label is the swap — the menu never stops moving before the app does');
  ok(new Set(labels).size === labels.length, 'no label was emitted twice in a row — the callback fires only on a change');
}

// A callback that throws must not be able to break an update. Same rule the
// engine applies to `onProgress`: the UI is not load-bearing.
{
  const rec = recorder([
    ['/api/config/update', { method: 'POST', fn: () => sseResponse(HAPPY_FRAMES) }],
    ['/api/config/update/apply', { method: 'POST', fn: () => jsonResponse(200, { ok: true, relaunching: true, version: '3.35.0' }) }],
  ]);
  const out = await client.runInstall('http://127.0.0.1:52341', {
    onLabel: () => { throw new Error('the menu blew up'); },
  }, { fetchImpl: rec.impl });
  eq(out.ok, true, 'a label callback that THROWS on every call does not stop the update');
  eq(rec.calls.length, 2, '  both requests were still made');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§6 every refusal is RELAYED, never re-authored');
// ═══════════════════════════════════════════════════════════════════════════
// The route and the engine own 36 named failure reasons and their sentences,
// each written by the side that knows what happened and each naming the fix.
// This module writes exactly two sentences of its own, both for cases the
// server could not describe because it never answered.
{
  const REFUSALS = [
    [409, { error: 'The Curator is busy ingesting a source. Try again when it finishes.', hint: 'Wait for the ingest to finish.', reason: 'write-in-flight' }, 'a write in flight'],
    [409, { error: 'An update is already being applied.', reason: 'already-running' }, 'an update already running'],
    [501, { error: 'This build of The Curator has no built-in updater attached, so it cannot install an update for itself.', hint: 'Download the installer from the release page and run it — it replaces this copy.', reason: 'no-updater', releasesPageUrl: 'https://github.com/talirezun/the-curator/releases' }, 'no engine attached'],
  ];
  for (const [status, body, label] of REFUSALS) {
    const rec = recorder([['/api/config/update', { method: 'POST', fn: () => jsonResponse(status, body) }]]);
    const out = await client.runInstall('http://x', {}, { fetchImpl: rec.impl });
    eq(out.ok, false, `${label} (HTTP ${status}): the run reports failure`);
    eq(out.error, body.error, `  and the SERVER's sentence is relayed byte for byte, not re-written here`);
    eq(out.reason, body.reason, `  with its reason code, for branching and logs`);
    if (body.hint) eq(out.hint, body.hint, `  and its hint, which is the actionable half`);
    if (body.releasesPageUrl) eq(out.releasesPageUrl, body.releasesPageUrl, '  and the page it named');
    eq(out.staged, false, '  nothing is staged — the download never started');
    eq(rec.calls.length, 1, '  and NO apply was attempted after a refused start');
  }

  // An `error` event mid-stream. This is how every engine failure arrives.
  const engineErrors = [
    { reason: 'digest-mismatch', error: 'The downloaded file does not match the checksum GitHub publishes for it, so it was discarded rather than installed.' },
    { reason: 'app-translocation', error: 'macOS is running The Curator from a temporary read-only copy, so it cannot replace itself. Move The Curator to your Applications folder, reopen it, and try again.' },
    { reason: 'install-dir-not-writable', error: 'The folder The Curator is installed in cannot be written to, so the update cannot be put in place.', hint: null },
  ];
  for (const e of engineErrors) {
    const rec = recorder([['/api/config/update', { method: 'POST', fn: () => sseResponse([
      { type: 'progress', data: { phase: 'downloading', receivedBytes: 1, totalBytes: 10, percent: 10 } },
      { type: 'error', data: { type: 'error', ...e } },
    ]) }]]);
    const out = await client.runInstall('http://x', {}, { fetchImpl: rec.impl });
    eq(out.ok, false, `an engine error (${e.reason}) ends the run`);
    eq(out.error, e.error, `  with the engine's own sentence, which already names the fix`);
    eq(rec.calls.length, 1, `  and NO apply is attempted — nothing was staged`);
  }

  // Sentences this module DOES author, and only where the server said nothing.
  {
    const rec = recorder([['/api/config/update', { method: 'POST', fn: () => { throw new TypeError('fetch failed'); } }]]);
    const out = await client.runInstall('http://x', {}, { fetchImpl: rec.impl });
    eq(out.ok, false, 'a server that cannot be reached at all is a failure');
    eq(out.error, client.CLIENT_UNREACHABLE, '  with the one sentence this module owns for it');
    ok(/Nothing on this Mac was changed/i.test(out.error), '  which says the thing that is always true here');
  }
  {
    // The stream ends with neither `staged` nor `error` — the server hung up.
    const rec = recorder([['/api/config/update', { method: 'POST', fn: () => sseResponse([
      { type: 'progress', data: { phase: 'downloading', receivedBytes: 1, totalBytes: 100, percent: 1 } },
    ]) }]]);
    const out = await client.runInstall('http://x', {}, { fetchImpl: rec.impl });
    eq(out.ok, false, 'a stream that ends with no verdict is a failure, not a silent success');
    eq(out.reason, 'interrupted', '  reported as its own thing rather than left on a label that will never move again');
    eq(rec.calls.length, 1, '  and no apply is attempted on a download that did not finish');
  }
  {
    // A refusal body that cannot be read at all still produces a sentence.
    const rec = recorder([['/api/config/update', { method: 'POST', fn: () => new Response('<html>502</html>', { status: 502 }) }]]);
    const out = await client.runInstall('http://x', {}, { fetchImpl: rec.impl });
    eq(out.ok, false, 'an unreadable refusal body is still a failure');
    ok(/502/.test(out.error), '  and the status reaches the sentence, so the failure is not anonymous');
    ok(!/undefined|null/.test(out.error), '  without rendering "undefined"');
  }
  // ── THE STREAM IS RELEASED ON THE EARLY RETURN ─────────────────────────
  // Found by mutation: deleting `reader.cancel()` from the `finally` was GREEN,
  // because on the happy path the stream is already drained and cancelling a
  // drained stream is a no-op. The case that matters is the EARLY RETURN — an
  // `error` event arriving with bytes still to come — where the socket would
  // otherwise stay open until garbage collection. `ReadableStream`'s own
  // `cancel` callback is what can see it, so the assertion drives that.
  {
    let cancelled = 0;
    let pulled = 0;
    const text =
      'event: error\ndata: {"type":"error","reason":"digest-mismatch","error":"bad checksum"}\n\n' +
      'event: progress\ndata: {"phase":"downloading","receivedBytes":1,"totalBytes":2,"percent":50}\n\n';
    const bytes = new TextEncoder().encode(text);
    const stream = new ReadableStream({
      pull(controller) {
        // One byte at a time and NEVER closed, so the stream still has more to
        // give when the error frame is parsed — the real mid-download shape.
        controller.enqueue(bytes.slice(pulled, pulled + 1));
        pulled++;
        if (pulled > bytes.length) controller.enqueue(new TextEncoder().encode('\n'));
      },
      cancel() { cancelled++; },
    });
    const rec = recorder([['/api/config/update', { method: 'POST', fn: () => new Response(stream, { status: 200 }) }]]);
    const out = await client.runInstall('http://x', {}, { fetchImpl: rec.impl });
    eq(out.ok, false, 'an error frame arriving mid-stream ends the run');
    eq(cancelled, 1,
       'and the stream is CANCELLED on that early return — the reader is released rather than left holding a socket that still had bytes to give');
    ok(pulled < bytes.length + 8, `CONTROL — the stream was still mid-flight when it was cancelled (${pulled} of ${bytes.length} bytes pulled), so this is the early-return case and not a drained one`);
  }

  // Unrecognised SSE event types must not derail a client of a stream it does
  // not own — a future keep-alive frame is not a failure.
  {
    const rec = recorder([
      ['/api/config/update', { method: 'POST', fn: () => sseResponse([
        { type: 'heartbeat', data: { type: 'heartbeat' } },
        ...HAPPY_FRAMES,
      ]) }],
      ['/api/config/update/apply', { method: 'POST', fn: () => jsonResponse(200, { ok: true }) }],
    ]);
    const out = await client.runInstall('http://x', {}, { fetchImpl: rec.impl });
    eq(out.ok, true, 'an unknown event type is ignored rather than treated as a failure');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('§7 a refused SWAP is "downloaded", not "failed"');
// ═══════════════════════════════════════════════════════════════════════════
// THE GUARD WORKING, NOT FAILING. `POST /update/apply` re-checks
// hasActiveWrites() at the moment of the swap, so an ingest started during the
// download is not truncated. 140 MB of verified application is on disk and one
// click away, and saying "the update failed" there would be false.
{
  const applyRefusal = {
    error: 'The Curator is writing to your knowledge base right now. Wait for it to finish, then install the update.',
    hint: 'Wait for the ingest to finish, then install the update.',
    reason: 'writes-in-progress',
    releasesPageUrl: 'https://github.com/talirezun/the-curator/releases',
  };
  const rec = recorder([
    ['/api/config/update', { method: 'POST', fn: () => sseResponse(HAPPY_FRAMES) }],
    ['/api/config/update/apply', { method: 'POST', fn: () => jsonResponse(409, applyRefusal) }],
  ]);
  const out = await client.runInstall('http://x', {}, { fetchImpl: rec.impl });
  eq(out.ok, false, 'the run did not finish');
  eq(out.staged, true, 'BUT it reports STAGED — the bytes are downloaded and verified, and only the swap was refused');
  eq(out.version, '3.35.0', '  and it still knows which version is sitting there');
  eq(out.error, applyRefusal.error, '  with the server\'s own sentence');
  eq(rec.calls.length, 2, '  both requests happened');

  // And the dialog built from it offers to FINISH rather than to start over.
  const dialog = verdictMod.describeInstallOutcome(out);
  eq(dialog.action, { type: 'install-staged' },
     'the dialog built from that outcome offers to finish the staged update, not to download it again');
  ok(!/failed/i.test(dialog.message), '  and does not call a completed, verified download a failure');

  // ANTI-VACUITY: the non-staged path must reach a different offer, or the
  // `staged` flag is not being read.
  const failedOut = await client.runInstall('http://x', {}, {
    fetchImpl: recorder([['/api/config/update', { method: 'POST', fn: () => sseResponse([{ type: 'error', data: { reason: 'digest-mismatch', error: 'bad checksum' } }]) }]]).impl,
  });
  eq(failedOut.staged, false, 'CONTROL — a failure BEFORE staging reports staged:false');
  ok(verdictMod.describeInstallOutcome(failedOut).action.type === 'open-url',
     '  and its dialog offers the releases page instead, so the two outcomes genuinely differ');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§8 applyOnly — no second 140 MB download');
// ═══════════════════════════════════════════════════════════════════════════
{
  const rec = recorder([
    ['/api/config/update', { method: 'POST', fn: () => { throw new Error('THE DOWNLOAD MUST NOT BE STARTED AGAIN'); } }],
    ['/api/config/update/apply', { method: 'POST', fn: () => jsonResponse(200, { ok: true, relaunching: true, version: '3.35.0' }) }],
  ]);
  const labels = [];
  const out = await client.runInstall('http://x', { applyOnly: true, onLabel: (l) => labels.push(l) }, { fetchImpl: rec.impl });
  eq(out.ok, true, 'applyOnly finishes a staged update');
  eq(rec.calls.map((c) => c.url), ['http://x/api/config/update/apply'],
     'and issues ONLY the apply request — the staging POST is never made, so a build already verified on disk is not downloaded twice');
  eq(labels, ['Installing Update…'], 'the menu says installing, and nothing about downloading');

  // ── WHICH ACTIONS MEAN "SKIP THE DOWNLOAD" ──────────────────────────────
  // Found by mutation: with this decision written as a literal in main.js's
  // retry loop, flipping it — so that clicking Install Now re-downloads 140 MB
  // already verified on disk — was GREEN, because main.js cannot be executed.
  // It lives here now, and is driven against the REAL actions the two dialog
  // builders produce rather than against strings typed here.
  {
    const A = client.applyOnlyForAction;
    const fromCheck = verdictMod.describeUpdate({
      current: '3.34.0', latest: '3.35.0', comparable: true, updateAvailable: true, updateStyle: 'download-installer',
    }, { attached: true, jobState: 'staged', jobVersion: '3.35.0' }).action;
    const fromFailure = verdictMod.describeInstallOutcome({ ok: false, staged: true, error: 'busy', version: '3.35.0' }).action;
    const fresh = verdictMod.describeUpdate({
      current: '3.34.0', latest: '3.35.0', comparable: true, updateAvailable: true, updateStyle: 'download-installer',
    }, { attached: true, jobState: null }).action;

    eq(A(fromCheck), true, 'the action from a dialog that found a STAGED job skips the download');
    eq(A(fromFailure), true, 'and so does the action from a refused swap — the same bundle is still on disk');
    eq(A(fresh), false, 'CONTROL — but the ordinary "an update is available" action does NOT skip it, or nothing would ever be downloaded');
    for (const junk of [null, undefined, {}, 'install-staged', { type: 'open-url' }, { type: 'install' }, []]) {
      eq(A(junk), false, `a malformed or unrelated action (${JSON.stringify(junk)}) starts from the top — the fail-safe direction is a download nobody needed, never a swap of something never verified`);
    }
  }

  // The retry after a write-in-flight refusal is the same call, and it can be
  // refused again without anything going wrong.
  const rec2 = recorder([['/api/config/update/apply', { method: 'POST', fn: () => jsonResponse(409, { error: 'still busy', reason: 'write-in-flight' }) }]]);
  const out2 = await client.runInstall('http://x', { applyOnly: true }, { fetchImpl: rec2.impl });
  eq(out2.staged, true, 'a refused retry still reports staged, so the offer to finish stays on the table');
  eq(out2.error, 'still busy', '  with the current refusal, not a cached one');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§9 the menu is rebuilt ~100 times, not ~550');
// ═══════════════════════════════════════════════════════════════════════════
// The engine emits a progress record every 256 KB — about 550 over a 140 MB
// download. Rebuilding the whole application menu 550 times to show a number
// that mostly did not change is work nobody asked for, so the label carries a
// WHOLE percent and the callback fires only when the string differs. Driven
// with 550 REAL events rather than argued from the comment above.
{
  const TOTAL = 143654912;
  const STEP = 256 * 1024;
  const frames = [];
  for (let received = 0; received <= TOTAL; received += STEP) {
    frames.push({ type: 'progress', data: { phase: 'downloading', receivedBytes: received, totalBytes: TOTAL, percent: (received / TOTAL) * 100 } });
  }
  frames.push({ type: 'staged', data: { type: 'staged', version: '3.35.0' } });
  ok(frames.length > 500, `CONTROL — ${frames.length} progress events were really generated, which is the real emission rate`);

  const rec = recorder([
    ['/api/config/update', { method: 'POST', fn: () => sseResponse(frames, { chunkSize: 4096 }) }],
    ['/api/config/update/apply', { method: 'POST', fn: () => jsonResponse(200, { ok: true }) }],
  ]);
  const labels = [];
  const out = await client.runInstall('http://x', { onLabel: (l) => labels.push(l) }, { fetchImpl: rec.impl });
  eq(out.ok, true, 'the run succeeds');
  ok(labels.length <= 103, `${frames.length} progress events produced only ${labels.length} menu rebuilds — at most one per whole percent, plus the installing label`);
  ok(labels.length >= 90, `  and it is not collapsing to nothing either (${labels.length}) — the label really does track the download`);
  ok(new Set(labels).size === labels.length, 'every emitted label is different from the one before it');
  ok(labels.includes('Downloading Update… 0%') && labels.includes('Downloading Update… 99%'),
     'the whole range is covered, from the first percent to the last');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§10 source discipline — no comparator, no path, no token');
// ═══════════════════════════════════════════════════════════════════════════
{
  const src = stripJsComments(read(path.join(DESKTOP, 'lib', 'update-client.js')));
  ok(src.length > 2000, `CONTROL — comment stripping left real code (${src.length} chars)`);
  ok(!/THE DEFECT THIS FILE CLOSES/.test(src), 'CONTROL — the prose really is gone');

  ok(!/compareSemver|semver|localeCompare/.test(src),
     'NO VERSION COMPARATOR. The route read the release list and already decided; a second answer to "what is newest" is how two surfaces come to disagree');
  ok(!/\bnode:fs\b|require\(.fs.\)|readFile|writeFile|existsSync/.test(src),
     'the client touches no filesystem — it asks the server, which is the only side that may');
  ok(!/child_process|execFile|spawn/.test(src),
     'and runs no subprocess');
  ok(!/\btoken\b/.test(src),
     'THE TOKEN NEVER APPEARS HERE. It is the engine\'s handle on a staged bundle and is deliberately absent from the route\'s own wire allow-list; a shell that held one would be a second place it could leak from');
  ok(!/stagedPath|targetPath|installDir|Applications/.test(src),
     'and no filesystem path of any kind — `installUpdate` takes an opaque token and never a path, which is the security property that makes it safe to reach from a renderer');
  ok(!/from 'electron'|require\('electron'\)/.test(src),
     'no Electron import, which is what lets this suite EXECUTE the module rather than grep it');
  ok(!/\.\.\/src\/|from '\.\.\//.test(src),
     'and nothing from src/, for the same reason');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§11 a tripwire against reaching the real network');
// ═══════════════════════════════════════════════════════════════════════════
// v3.30.0 recorded an OFFLINE suite in this repo that made a REAL network call
// because an assertion passing `{fetchImpl: null}` fell through to the global.
// This is that lesson, kept.
{
  const realFetch = globalThis.fetch;
  let escaped = 0;
  globalThis.fetch = () => { escaped++; throw new Error('TRIPWIRE: a §11 assertion escaped to the real network'); };
  try {
    for (const deps of [{ fetchImpl: null }, { fetchImpl: undefined }, { fetchImpl: 'nope' }, { fetchImpl: 0 }]) {
      const out = await client.runInstall('http://127.0.0.1:1', {}, deps);
      eq(out.ok, false, `runInstall with ${JSON.stringify(deps)} refuses rather than reaching for the global fetch`);
      eq(out.error, client.CLIENT_UNREACHABLE, '  with the unreachable sentence');
    }
    for (const bad of ['', null, undefined, 0]) {
      const out = await client.runInstall(bad, {}, { fetchImpl: async () => jsonResponse(200, { ok: true }) });
      eq(out.ok, false, `an unusable baseUrl (${JSON.stringify(bad)}) refuses rather than fetching a relative path`);
    }

    // ── THE applyOnly PATH IS THE DANGEROUS ONE, AND IT WAS UNCOVERED ──────
    // Found by mutation: deleting the entry guard in `runInstallInner` came
    // back GREEN, because on the STAGING path an unusable fetch throws and the
    // inner catch returns the same refusal — the guard is redundant there.
    //
    // On the applyOnly path it is not redundant at all. The apply request
    // REJECTING is the success signal (the app is quitting under it), so an
    // unusable fetch would sail through that catch and report an installed
    // update that never happened — a menu item that said it was done while the
    // app carried on running the old version.
    for (const deps of [{ fetchImpl: null }, { fetchImpl: undefined }, { fetchImpl: 'nope' }]) {
      const out = await client.runInstall('http://127.0.0.1:1', { applyOnly: true }, deps);
      eq(out.ok, false,
         `applyOnly with ${JSON.stringify(deps)}: an unusable fetch is a REFUSAL, never a success — on this path a rejected request means "the app is quitting", so an unreachable client must be stopped before it gets there`);
      eq(out.error, client.CLIENT_UNREACHABLE, '  with the unreachable sentence, not a claim that an update was installed');
    }
    for (const bad of ['', null, undefined]) {
      const out = await client.runInstall(bad, { applyOnly: true }, { fetchImpl: async () => { throw new TypeError('fetch failed'); } });
      eq(out.ok, false, `applyOnly with an unusable baseUrl (${JSON.stringify(bad)}) is a refusal too, for the same reason`);
    }
    const probe = await client.fetchUpdaterProbe('http://127.0.0.1:1', { fetchImpl: null });
    eq(probe.attached, null, 'fetchUpdaterProbe with a named-but-unusable fetch reports "we could not ask", never "no updater"');

    ok(escaped === 0, `CONTROL — no assertion in §11 touched the real network (${escaped} escapes)`);
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log(`\n  ────────────────────────────────────────`);
console.log(`  Passed: ${passed}   Failed: ${failed}`);
console.log(`  ────────────────────────────────────────\n`);
process.exit(failed === 0 ? 0 : 1);
