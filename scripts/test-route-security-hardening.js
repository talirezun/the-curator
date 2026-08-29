/**
 * test-route-security-hardening.js — OFFLINE suite for five confirmed findings,
 * every one of them reproduced against a running app by an adversarial auditor
 * before it was fixed.
 *
 *   §1 The chat routes validate `:domain`. THREE OF FOUR DID NOT, so a decoded
 *      `..%2f` segment reached `path.join(getDomainsDir(), domain, …)` and read
 *      a conversations directory outside the tree. Written as a CLASS invariant
 *      over every route the router registers, so a route added later without the
 *      guard goes red without anyone remembering to extend a list.
 *   §2 `listConversations` is a READ and creates nothing. It called
 *      `mkdir(recursive)` first, and cross-origin GETs are exempt from the CSRF
 *      guard by design, so any web page could make the app create directories.
 *   §3 A 500 from a chat route carries no absolute path.
 *   §4 `POST /api-keys/build-model` reports the truth about whether the pin it
 *      just wrote is in force. With `LLM_MODEL` set it replied `inert: false`
 *      while `effectiveModel` in the same body was a different model — on a
 *      surface that decides spend.
 *   §5 …and a 500 from that route carries no absolute path either.
 *   §6 The catalogue-persistence stderr line carries no absolute path. It is
 *      reached from a BOOT-TIME auto-sync now, i.e. with nobody watching, into
 *      the log users paste into bug reports.
 *   §7 The runtime OpenRouter catalogue admits an id at most ONCE, and never one
 *      that collides with a built-in model id.
 *
 * ── HOW THESE ASSERTIONS ARE BUILT (an audit of this repo's suites found ~30
 *    decorative guards with four root causes; none is reproduced here) ────────
 *  - Nothing here is a source-text scan, so no comment can satisfy any of it.
 *    Every section drives real exported functions or real express handlers.
 *  - Expected values are not read from the constant the code reads. §7's
 *    built-in id is ENUMERATED from the real table — but what is asserted is
 *    behaviour (refused / absent / price unchanged), never equality with the
 *    table.
 *  - §1 asserts a CALL SITE by construction: it pulls handlers out of the live
 *    router rather than importing anything, so a guard present in the file but
 *    not wired into a route cannot pass.
 *  - Several sections carry an explicit NON-VACUITY CONTROL proving the
 *    fixture can actually fail — §1's traversal is shown to be REAL at the
 *    brain layer, so the route's refusal is doing the work.
 */

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ── Isolation FIRST, before any app module is imported ──────────────────────
// BOTH env vars: CURATOR_TEST_DOMAINS_DIR redirects only domains/, while
// CURATOR_TEST_USER_DATA_DIR redirects the four credential locations. §4-§6
// write config and a catalogue sidecar, so without the second one this suite
// would edit the developer's real .curator-config.json.
const TMP = mkdtempSync(path.join(tmpdir(), 'curator-route-sec-'));
const TMP_USER = path.join(TMP, 'userdata');
const TMP_DOMAINS = path.join(TMP, 'domains');
for (const d of [TMP_USER, TMP_DOMAINS]) mkdirSync(d, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = TMP_USER;
process.env.CURATOR_TEST_DOMAINS_DIR = TMP_DOMAINS;
delete process.env.DOMAINS_PATH;
delete process.env.LLM_MODEL;

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(a, b, label) { ok(a === b, `${label} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`); }
function section(t) { console.log(`\n${t}`); }

// The tally is emitted from an exit handler too, so a throw partway through is
// reported as an ABORT rather than as a small, reassuring red count.
let COMPLETED = false;
process.on('exit', () => {
  if (COMPLETED) return;
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Passed: ${passed}   Failed: ${failed === 0 ? 1 : failed}`);
  console.log('❌ ABORTED before the end — the counts above are a LOWER BOUND');
});

// sha256 + size + existence ONLY, never mtime: the maintainer's live app
// rewrites .curator-config.json during ordinary Settings use, and an
// mtime-sensitive guard flakes as a false "isolation is broken".
const REAL_FILES = ['.curator-config.json', '.sync-config.json', '.sharedbrain-config.json']
  .map(f => path.join(ROOT, f));
function fingerprint() {
  return REAL_FILES.map(f => {
    if (!existsSync(f)) return `${path.basename(f)}:absent`;
    const buf = readFileSync(f);
    return `${path.basename(f)}:${buf.length}:${createHash('sha256').update(buf).digest('hex')}`;
  }).join('|');
}
const FINGERPRINT_BEFORE = fingerprint();

// A multi-segment absolute path, POSIX or Windows.
//
// DELIBERATELY NOT a `/Users/` or `/home/` test. Temp directories live under
// NEITHER on any platform this suite runs on (macOS `/var/folders/…`, Linux
// `/tmp/…`), so such a test could never go red here whatever the scrubber did —
// an assertion that cannot fail is worse than no assertion. This one CAN: it
// fires on the raw message and not on the scrubbed `'.../basename'` form, and
// mutating the scrub away turns it red.
const ABS_PATH_RE = /(?:^|[\s'"`(])(?:\/|[A-Za-z]:\\)[^\s'"`)]+[\/\\][^\s'"`)]+/;

console.log('test-route-security-hardening.js — five confirmed findings, guarded behaviourally\n');

const files = await import(path.join(ROOT, 'src/brain/files.js'));
const { listConversations } = files;

/** Make `slug` a REAL domain: listDomains() filters on the CLAUDE.md schema. */
function makeDomain(slug) {
  const base = path.join(TMP_DOMAINS, slug);
  mkdirSync(path.join(base, 'conversations'), { recursive: true });
  writeFileSync(path.join(base, 'CLAUDE.md'), `# ${slug}\n`);
  return base;
}
function uuidN(n) { return String(n).padStart(8, '0') + '-0000-4000-8000-000000000000'; }
function writeConv(dir, n, title, messages) {
  const id = uuidN(n);
  writeFileSync(path.join(dir, id + '.json'), JSON.stringify({
    id, title, createdAt: new Date(2026, 0, 1, 12, 0, n).toISOString(), messages,
  }));
  return id;
}

// ═══════════════════════════════════════════════════════════════════════════
section('§1 — every chat route validates :domain (CLASS invariant, real handlers)');

const REAL_DOMAIN = 'legit';
makeDomain(REAL_DOMAIN);
const REAL_CONV = writeConv(path.join(TMP_DOMAINS, REAL_DOMAIN, 'conversations'), 1,
  'A normal thread', [{ role: 'user', content: 'hello there' }]);

// The victim: a conversations directory OUTSIDE the domains root, holding a
// distinctive string. `conversationsPath('../outside')` resolves straight to it.
const OUTSIDE = path.join(TMP, 'outside');
mkdirSync(path.join(OUTSIDE, 'conversations'), { recursive: true });
writeConv(path.join(OUTSIDE, 'conversations'), 9, 'Private notes',
  [{ role: 'user', content: 'CANARY-OUTSIDE-THE-DOMAINS-ROOT' }]);

// ── NON-VACUITY CONTROL ────────────────────────────────────────────────────
// The traversal is REAL at the brain layer — path.join collapses the `..` and
// listConversations happily reads the victim directory, including matching on
// its message bodies. Without this control, §1's refusals could be passing
// because the fixture is unreachable rather than because the guard works.
{
  const leaked = await listConversations('../outside', { q: 'canary-outside' });
  eq(leaked.length, 1,
    'CONTROL: the traversal genuinely reaches outside the domains root at the brain layer — so the route guard below is what stops it');
  eq(leaked[0].matchField, 'message',
    'CONTROL: …and `?q=` turns the listing into an oracle over MESSAGE BODIES of files it should never have read');
}

const chatRouter = (await import(path.join(ROOT, 'src/routes/chat.js'))).default;

/** Every (method, path) the chat router actually registers. */
function registeredRoutes(router) {
  const out = [];
  for (const layer of router.stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) {
      if (!layer.route.methods[method]) continue;
      // The LAST handler is the route's own; anything before it is middleware.
      const stack = layer.route.stack;
      out.push({ method, path: layer.route.path, handle: stack[stack.length - 1].handle });
    }
  }
  return out;
}
const CHAT_ROUTES = registeredRoutes(chatRouter);
ok(CHAT_ROUTES.length >= 4,
  `the router registers at least the four known chat routes (found ${CHAT_ROUTES.length}) — the class below is enumerated from this, never hardcoded`);

/** Drive one handler with a fake req/res and resolve what it answered. */
function drive(route, { domain, id, query = {}, body = { message: 'hi' } }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { done({ statusCode: this.statusCode, body: b }); },
      // The real `res` express hands a handler is an http.ServerResponse, i.e.
      // an EventEmitter — `res.on('finish'|'close', …)` is ordinary middleware
      // vocabulary. This double omitted it, so the moment a handler registered
      // a lifecycle listener EVERY assertion below reported `statusCode: -2`
      // (the harness's "the handler threw" sentinel) instead of the 404 the
      // route really produces. That reads exactly like a traversal refusal
      // having stopped being deliverable, which is far more alarming than the
      // truth: an incomplete stand-in. Verified against a RUNNING server with
      // raw sockets (so nothing normalises the path client-side) — every one
      // of the hostile POSTs below answers `HTTP/1.1 404 Not Found` with no
      // leak, and a real domain still answers 200.
      //
      // Deliberately RECORD-ONLY: handlers are stored and never fired, because
      // nothing in THIS suite is about the connection lifecycle. Its subject is
      // refusal semantics, and every status/leak assertion is byte-unchanged.
      _handlers: Object.create(null),
      on(evt, fn) { (this._handlers[evt] ||= []).push(fn); return this; },
      once(evt, fn) { return this.on(evt, fn); },
      removeListener() { return this; },
      get writableEnded() { return settled; },
    };
    const req = { params: { domain, id }, query, body };
    try {
      const r = route.handle(req, res, (err) => done({ statusCode: -1, body: { next: String(err || 'next()') } }));
      if (r && typeof r.catch === 'function') r.catch((err) => done({ statusCode: -2, body: { threw: String(err && err.message) } }));
    } catch (err) {
      done({ statusCode: -2, body: { threw: String(err && err.message) } });
    }
  });
}

// The hostile inputs. `../outside` is what express hands the handler for the
// reproduced `GET /api/chat/..%2foutside`; the others are shapes a name-based
// allow-list must also refuse.
const HOSTILE = ['../outside', '..', '../../etc', '/etc', 'no-such-domain', '', '.'];
for (const route of CHAT_ROUTES) {
  const label = `${route.method.toUpperCase()} ${route.path}`;
  for (const domain of HOSTILE) {
    const r = await drive(route, { domain, id: uuidN(9), query: { q: 'canary-outside' } });
    ok(r.statusCode === 404,
      `${label} refuses domain ${JSON.stringify(domain)} with 404 (got ${r.statusCode})`);
    const serialised = JSON.stringify(r.body || {});
    ok(!/CANARY-OUTSIDE/i.test(serialised) && !/conversations/i.test(serialised.replace(/Invalid conversationId/gi, '')),
      `${label} returns nothing derived from ${JSON.stringify(domain)} — no listing, no leak`);
  }
}

// POSITIVE CONTROL: the guard refuses, it does not simply break the routes.
{
  const list = CHAT_ROUTES.find(r => r.method === 'get' && r.path === '/:domain');
  const r = await drive(list, { domain: REAL_DOMAIN });
  eq(r.statusCode, 200, 'CONTROL: a REAL domain still lists normally through the same guard');
  eq(r.body.conversations.length, 1, 'CONTROL: …and returns its conversation');

  const read = CHAT_ROUTES.find(r => r.method === 'get' && r.path === '/:domain/:id');
  const rr = await drive(read, { domain: REAL_DOMAIN, id: REAL_CONV });
  eq(rr.statusCode, 200, 'CONTROL: a real conversation still reads');

  // The domain guard runs BEFORE the id regex, so nothing is built from an
  // unvalidated domain — not even a path that is then discarded.
  const bad = await drive(read, { domain: '../outside', id: 'not-a-uuid' });
  eq(bad.statusCode, 404,
    'an unknown domain is refused with 404 even when the id is ALSO invalid — the domain is checked first');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2 — listConversations is a READ: it creates nothing');

{
  const ghost = path.join(TMP_DOMAINS, 'never-existed');
  ok(!existsSync(ghost), 'precondition: the domain directory does not exist');
  const rows = await listConversations('never-existed');
  eq(rows.length, 0, 'a missing conversations directory reads as EMPTY');
  ok(!existsSync(ghost),
    'THE FIX: …and the directory is STILL absent — the read created nothing (it used to mkdir recursively, reachable by any cross-origin GET)');

  // Deep path: `mkdir(recursive)` made every missing parent, so the damage was
  // not limited to one directory.
  const deep = path.join(TMP_DOMAINS, 'a', 'b', 'c');
  await listConversations(path.join('a', 'b', 'c'));
  ok(!existsSync(deep), 'nor does it create a chain of missing parent directories');

  // "We could not look" must never be served as "there is nothing": only ENOENT
  // reads as empty.
  // A SPACE in the name is deliberate: the scrubber's first implementation
  // stopped at the first space and echoed the rest verbatim — the user's name
  // and their whole cloud-storage layout survived a function whose stated
  // purpose was hiding exactly that, and its test only used space-free paths.
  // §3 reads this same fixture back through the real route.
  const blocked = 'blocked dom';
  makeDomain(blocked);
  rmSync(path.join(TMP_DOMAINS, blocked, 'conversations'), { recursive: true });
  writeFileSync(path.join(TMP_DOMAINS, blocked, 'conversations'), 'not a directory');
  let threw = null;
  try { await listConversations(blocked); } catch (err) { threw = err; }
  ok(threw !== null,
    'a conversations path that is a FILE still THROWS — the ENOENT arm is a targeted "nothing here", not a blanket catch');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3 — a 500 from a chat route carries no absolute path');

{
  // Reuses §2's ENOTDIR fixture, but through the real HTTP handler: readdir
  // throws `ENOTDIR: not a directory, scandir '<absolute path>'`.
  const list = CHAT_ROUTES.find(r => r.method === 'get' && r.path === '/:domain');
  const r = await drive(list, { domain: 'blocked dom' });
  eq(r.statusCode, 500, 'the failure surfaces as a 500, not as a silent empty list');
  const msg = String(r.body && r.body.error);
  ok(msg.length > 0, 'and it carries a message');
  ok(!msg.includes(TMP),
    `THE FIX: the absolute path is gone from the 500 body — on a real install that is the user's home directory (body: ${JSON.stringify(msg).slice(0, 120)})`);
  ok(!ABS_PATH_RE.test(msg), 'and no multi-segment absolute path of ANY shape survives');
  ok(!msg.includes('blocked dom'),
    'including the space-containing DIRECTORY name — the scrubber does not stop at the first space, which is the bug its own first version shipped');
  ok(msg.includes('conversations'),
    'the BASENAME survives — the scrubber keeps the half that helps a bug report, it does not blank the message');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4 — POST /api-keys/build-model reports whether the pin is actually in force');

const llm = await import(path.join(ROOT, 'src/brain/llm.js'));
const config = await import(path.join(ROOT, 'src/brain/config.js'));
const configRouter = (await import(path.join(ROOT, 'src/routes/config.js'))).default;
const CONFIG_ROUTES = registeredRoutes(configRouter);
const buildModelRoute = CONFIG_ROUTES.find(r => r.method === 'post' && r.path === '/api-keys/build-model');
const apiKeysRoute = CONFIG_ROUTES.find(r => r.method === 'get' && r.path === '/api-keys');
ok(!!buildModelRoute, 'POST /api-keys/build-model is registered');
ok(!!apiKeysRoute, 'GET /api-keys is registered (the READ surface this must agree with)');

/** Drive a config route with a JSON body. */
function driveBody(route, body) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { done({ statusCode: this.statusCode, body: b }); },
      // The real `res` express hands a handler is an http.ServerResponse, i.e.
      // an EventEmitter — `res.on('finish'|'close', …)` is ordinary middleware
      // vocabulary. This double omitted it, so the moment a handler registered
      // a lifecycle listener EVERY assertion below reported `statusCode: -2`
      // (the harness's "the handler threw" sentinel) instead of the 404 the
      // route really produces. That reads exactly like a traversal refusal
      // having stopped being deliverable, which is far more alarming than the
      // truth: an incomplete stand-in. Verified against a RUNNING server with
      // raw sockets (so nothing normalises the path client-side) — every one
      // of the hostile POSTs below answers `HTTP/1.1 404 Not Found` with no
      // leak, and a real domain still answers 200.
      //
      // Deliberately RECORD-ONLY: handlers are stored and never fired, because
      // nothing in THIS suite is about the connection lifecycle. Its subject is
      // refusal semantics, and every status/leak assertion is byte-unchanged.
      _handlers: Object.create(null),
      on(evt, fn) { (this._handlers[evt] ||= []).push(fn); return this; },
      once(evt, fn) { return this.on(evt, fn); },
      removeListener() { return this; },
      get writableEnded() { return settled; },
    };
    try {
      const r = route.handle({ params: {}, query: {}, body }, res, () => done({ statusCode: -1, body: null }));
      if (r && typeof r.catch === 'function') r.catch((e) => done({ statusCode: -2, body: { threw: String(e && e.message) } }));
    } catch (e) { done({ statusCode: -2, body: { threw: String(e && e.message) } }); }
  });
}

// A build-lane model for a provider, taken from the REAL catalogue. Enumerated,
// never hardcoded — but what is asserted below is behaviour, not equality with
// this table, so this cannot become "the expected value read from the same
// constant the code reads".
const PROVIDER = 'anthropic';
const buildLane = (llm.OFFERABLE_MODELS[PROVIDER] || []).filter(m => m && llm.isBuildLaneModel(PROVIDER, m.id));
// `getDefaultModel` with nothing stored and no LLM_MODEL IS the provider
// default — read through the resolver rather than a table, so this stays true
// if DEFAULTS moves.
const PROVIDER_DEFAULT = llm.getDefaultModel(PROVIDER);
const PIN = buildLane.find(m => m.id !== PROVIDER_DEFAULT) || buildLane[0];
ok(!!PIN, 'the real catalogue offers a build-lane model to pin');
ok(PIN && PIN.id !== PROVIDER_DEFAULT,
  'and it is NOT the provider default — otherwise "effectiveModel equals the pin" would hold for the wrong reason');

// Deliberately NOT credential-shaped. `sk-ant-…` would match the pre-commit
// secret hook's own pattern, and allow-listing our own fixture is how a repo
// teaches the next person to allow-list (the v3.15.0 precedent, where two test
// agents refused exactly that). The key gate here reads truthiness only.
config.setApiKeys({ anthropicApiKey: 'zz-synthetic-anthropic-key-not-a-real-credential' });
config.setActiveProvider(PROVIDER);

// (a) The control: no env override, so the pin governs.
{
  delete process.env.LLM_MODEL;
  const r = await driveBody(buildModelRoute, { provider: PROVIDER, model: PIN.id });
  eq(r.statusCode, 200, 'CONTROL: pinning a build-lane model succeeds');
  eq(r.body.selectedModel, PIN.id, 'CONTROL: the pin is stored');
  eq(r.body.effectiveModel, PIN.id, 'CONTROL: and it is what the app will actually use');
  eq(r.body.inert, false, 'CONTROL: so the route reports it as IN FORCE');
  eq(r.body.inertReason, null, 'CONTROL: with no reason to give');
}

// (b) THE FINDING: LLM_MODEL outranks the stored pin (documented precedence:
//     per-call > LLM_MODEL > stored > DEFAULTS), so the pin is NOT in force.
{
  const FOREIGN = llm.getDefaultModel('gemini');           // a Gemini id, under anthropic
  ok(typeof FOREIGN === 'string' && FOREIGN !== PIN.id, 'the override id is a real, different model id');
  process.env.LLM_MODEL = FOREIGN;
  const r = await driveBody(buildModelRoute, { provider: PROVIDER, model: PIN.id });
  eq(r.statusCode, 200, 'the write still succeeds — the precedence is unchanged, only the report is');
  eq(r.body.selectedModel, PIN.id, 'the pin still lands');
  eq(r.body.effectiveModel, FOREIGN, 'and llm.js will actually use the env override');
  ok(r.body.effectiveModel !== r.body.selectedModel,
    'so the body itself already contradicts a claim that the pin is honoured');
  eq(r.body.inert, true,
    'THE FIX: the route reports the pin as NOT in force — it used to answer `inert: false` beside those two disagreeing fields');
  eq(r.body.inertReason, 'model-overridden', 'and names which of the two failure modes it is');

  // CROSS-SURFACE: the READ side already knew. `GET /api-keys` computes
  // `buildModel.selectedHonoured` with exactly these semantics, so the two
  // surfaces answering the same question differently was the real defect.
  const g = await driveBody(apiKeysRoute, {});
  eq(g.statusCode, 200, 'GET /api-keys answers');
  eq(g.body.buildModel.source, 'env', 'the READ surface reports the env override as the source…');
  eq(g.body.buildModel.selectedHonoured, false, '…and that the stored pick is NOT honoured');
  eq(g.body.buildModel.selectedHonoured, !r.body.inert,
    'THE INVARIANT: the write surface’s `inert` is exactly the negation of the read surface’s `selectedHonoured` — one fact, one answer');
  delete process.env.LLM_MODEL;
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5 — a 500 from the build-model route carries no absolute path');

{
  // A SYMLINK where the config file goes: writeFileAtomicSync refuses to write
  // through one (v3.0.1-beta.20) with a message naming the ABSOLUTE target.
  // Deterministic, and independent of who the process is running as — a chmod
  // fixture would silently stop reproducing under root.
  const CONFIG_FILE = path.join(TMP_USER, '.curator-config.json');
  const REAL_TARGET = path.join(TMP, 'real-config.json');
  const saved = readFileSync(CONFIG_FILE, 'utf8');
  writeFileSync(REAL_TARGET, saved);
  rmSync(CONFIG_FILE);
  symlinkSync(REAL_TARGET, CONFIG_FILE);

  const r = await driveBody(buildModelRoute, { provider: PROVIDER, model: PIN.id });
  eq(r.statusCode, 500, 'precondition: the write genuinely fails, so there is a 500 body to inspect');
  const msg = String(r.body && r.body.error);
  ok(/symlink/i.test(msg), 'precondition: and it is the symlink refusal, whose message embeds the absolute target');
  ok(!msg.includes(TMP),
    `THE FIX: the absolute path is gone from the 500 body (body: ${JSON.stringify(msg).slice(0, 120)})`);
  ok(!ABS_PATH_RE.test(msg), 'and no multi-segment absolute path of ANY shape survives');
  ok(msg.includes('.curator-config.json'), 'the basename survives, so the message still says WHICH file');

  rmSync(CONFIG_FILE);
  writeFileSync(CONFIG_FILE, saved);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§6 — the catalogue-persistence log carries no absolute path');

{
  // Same symlink device on the sidecar. This line is reached from the boot-time
  // auto-sync, so it fires unattended into the log users paste into bug reports.
  const SIDECAR = path.join(TMP_USER, '.openrouter-catalogue.json');
  if (existsSync(SIDECAR)) rmSync(SIDECAR);
  symlinkSync(path.join(TMP, 'sidecar-target.json'), SIDECAR);

  function goodRecord(id, over = {}) {
    return {
      id, name: `Label for ${id}`, created: 1700000000,
      architecture: { input_modalities: ['text'], output_modalities: ['text'], modality: 'text->text' },
      pricing: { prompt: '0.0000001', completion: '0.0000004' },
      context_length: 1000000,
      top_provider: { max_completion_tokens: 65536, context_length: 1000000, is_moderated: false },
      supported_parameters: ['response_format', 'structured_outputs', 'max_tokens', 'temperature'],
      ...over,
    };
  }
  const fetchOf = (body) => async () => ({ ok: true, status: 200, json: async () => body });

  const captured = [];
  const realErr = console.error;
  console.error = (...a) => { captured.push(a.map(String).join(' ')); };
  let syncResult = null, syncErr = null;
  try { syncResult = await llm.syncOpenRouterCatalogue({ fetchImpl: fetchOf({ data: [goodRecord('zzsec-a/good')] }) }); }
  catch (e) { syncErr = e; }
  console.error = realErr;

  ok(syncErr === null, `the sync itself still succeeds — a failed PERSIST must never fail a sync that already worked${syncErr ? ` (threw ${syncErr.message})` : ''}`);
  eq(syncResult && syncResult.persisted, false, 'precondition: persistence genuinely failed, so the log line was emitted');
  const line = captured.find(l => l.includes('could not persist the OpenRouter catalogue'));
  ok(!!line, `precondition: the persistence-failure line was logged (captured ${captured.length} stderr line(s))`);
  ok(line && /symlink/i.test(line), 'precondition: and it embeds the symlink refusal, which names the absolute target');
  ok(line && !line.includes(TMP),
    `THE FIX: the absolute path is gone from the unattended log line (line: ${JSON.stringify(String(line)).slice(0, 130)})`);
  ok(line && !ABS_PATH_RE.test(line), 'and no multi-segment absolute path of ANY shape survives');
  ok(line && line.includes('.openrouter-catalogue.json'), 'the basename survives, so the line still says which file');

  rmSync(SIDECAR);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§7 — the runtime catalogue admits an id at most once, and never a built-in id');

{
  /** A minimal admissible dynamic spec, built the way the adapter builds them. */
  // The shape is NOT hand-invented: it is what the real
  // `buildOpenRouterCatalogue` emits for an eligible record, so a change to the
  // admission contract makes this fixture stop being admissible (loudly, via the
  // `admitted` counts below) rather than silently testing a shape production
  // never produces.
  function spec(id, over = {}) {
    return {
      id, label: `Label ${id}`, suitability: 'chat-only', thinks: false,
      tokenizerFactor: 1, maxOutput: 65536, createdUnixSec: 1700000000,
      contextLength: 1000000, price: { input: 0.1, output: 0.4 },
      note: 'Listed by OpenRouter’s public catalogue. Chat only — never measured against The Curator’s ingest prompt.',
      ...over,
    };
  }
  // Non-vacuity: one lone well-formed spec must be admitted, or every "admitted
  // === 1" below could be passing because nothing is admissible at all.
  llm.setOpenRouterCatalogue([]);
  eq(llm.setOpenRouterCatalogue([spec('zzsec-probe/one')]).admitted, 1,
    'CONTROL: a single well-formed spec IS admitted — so the counts below measure the dedupe, not an inadmissible fixture');

  // (a) DUPLICATES. Two specs, one id.
  llm.setOpenRouterCatalogue([]);
  const dup = llm.setOpenRouterCatalogue([spec('zzsec-dup/same'), spec('zzsec-dup/same', { label: 'Second copy' })]);
  eq(dup.admitted, 1, 'THE FIX: a repeated id is admitted ONCE');
  eq(dup.refused, 1, 'and the second occurrence is counted as refused, not silently dropped');
  const listed = llm.listOfferableModels('openrouter').filter(m => m.id === 'zzsec-dup/same');
  eq(listed.length, 1,
    'so the picker renders it once — two entries used to render two rows for one model, with the price registry describing only the last');
  eq(listed[0] && listed[0].label, 'Label zzsec-dup/same',
    'and the FIRST occurrence is the survivor — the one findOfferableModel().find() was already resolving, so nothing changes about which model a user gets');

  // (b) COLLISION WITH A BUILT-IN ID. Enumerated from the real tables; the
  //     assertions are behavioural (refused / absent / price unchanged), so
  //     this is not an expectation read out of the constant under test.
  const builtIns = [];
  for (const p of ['gemini', 'anthropic']) for (const e of (llm.OFFERABLE_MODELS[p] || [])) builtIns.push({ provider: p, id: e.id });
  ok(builtIns.length > 0, 'the static tables carry built-in ids to collide with');
  const victim = builtIns[0];
  const priceBefore = JSON.stringify(llm.getModelPrice(victim.id));

  llm.setOpenRouterCatalogue([]);
  const clash = llm.setOpenRouterCatalogue([spec(victim.id), spec('zzsec-ok/fine')]);
  eq(clash.admitted, 1, `THE FIX: a spec claiming the built-in id "${victim.id}" is not admitted…`);
  eq(clash.refused, 1, '…and is counted as refused');
  ok(!llm.listOfferableModels('openrouter').some(m => m.id === victim.id),
    'it is absent from the OpenRouter offer list — an id is a KEY, and getModelPrice/isFreeModel/chargeForItem are not provider-scoped');
  ok(llm.listOfferableModels('openrouter').some(m => m.id === 'zzsec-ok/fine'),
    'CONTROL: refusal is per-entry — the well-formed sibling in the same batch is still admitted');
  eq(JSON.stringify(llm.getModelPrice(victim.id)), priceBefore,
    'and the built-in model’s price is untouched by the attempt');

  // (c) OpenRouter's OWN static ids stay SUPERSEDED, not refused. The provider
  //     of course lists the models we hand-measured; that is not a failure and
  //     folding it into `refused` would report our own defaults as rejected.
  const orStatic = (llm.OFFERABLE_MODELS.openrouter || [])[0];
  if (orStatic) {
    llm.setOpenRouterCatalogue([]);
    const sup = llm.setOpenRouterCatalogue([spec(orStatic.id)]);
    eq(sup.superseded, 1, 'an OpenRouter static id is SUPERSEDED (the better entry is already on offer)…');
    eq(sup.refused, 0, '…and is NOT counted as a refusal');
  } else {
    ok(false, 'expected at least one hand-measured OpenRouter entry to exercise the superseded path');
  }

  llm.setOpenRouterCatalogue([]);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§8 — isolation held');

eq(fingerprint(), FINGERPRINT_BEFORE,
  'the real .curator-config.json / .sync-config.json / .sharedbrain-config.json are byte-identical (sha256 + size, never mtime)');
ok(!existsSync(path.join(ROOT, 'domains', 'legit')),
  'nothing was written into the repository’s own domains/ folder');

COMPLETED = true;
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) process.exitCode = 1;
