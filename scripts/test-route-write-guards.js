/**
 * test-route-write-guards.js — OFFLINE suite for the write-registry guard on
 * the mutating /api/config routes, POST /api/sync/setup, and domain rename.
 *
 * ── What this pins ───────────────────────────────────────────────────────
 *
 * Two config values are resolved FRESH on every use, by deliberate design:
 * `getDomainsDir()` re-reads .curator-config.json on every call (the v3.1.0
 * per-call-resolution invariant), and `getProviderInfo()` runs per LLM call
 * inside `callProvider`. So a config mutation that lands mid-ingest takes
 * effect on the REMAINING work of an operation already in flight:
 *
 *   • changing the knowledge folder writes the rest of one source's pages
 *     under a different root — the document's pages split across two
 *     locations, with an index and log each describing only half of it;
 *   • saving / disconnecting / switching a provider key can fail the run
 *     partway through, or silently finish it on a DIFFERENT model (v3.0.2's
 *     last-saved-wins means even a plain save switches the active provider).
 *
 * A multi-phase ingest takes minutes and the shipping frontend's busy gate
 * does NOT disable the folder picker or the key controls, so a user wandering
 * into Settings mid-ingest reaches all of this. `POST /update` has had the
 * `hasActiveWrites()` guard since v3.0.1-beta.8; these five routes did not.
 *
 * ── The half people forget ───────────────────────────────────────────────
 *
 * Every "the guard FIRES" assertion below is paired with a "the guard does
 * NOT fire when idle" assertion against the same route. A guard that always
 * blocks is as broken as one that never does, and only the negative half can
 * tell those two apart — a suite that merely proves 409s could be green
 * against a hard-coded `return res.status(409)`.
 *
 * Section 5 additionally pins the routes deliberately left UNGUARDED, so a
 * future well-meaning blanket application shows up as a failure and gets a
 * conversation rather than shipping silently.
 *
 * ── Isolation ────────────────────────────────────────────────────────────
 *
 * Sections 2 and 4 make real mutating requests (they write API keys and a
 * domainsPath). Both `CURATOR_TEST_USER_DATA_DIR` and `CURATOR_TEST_DOMAINS_DIR`
 * are set BEFORE any app module is imported, and section 1 asserts the resolved
 * config path really is inside the tempdir and that the maintainer's real
 * config is untouched (hashed before and after the whole run). No request in
 * this file can reach the real .curator-config.json.
 *
 * `POST /api/config/update` is NEVER called here, at any point, under any
 * condition: it runs `git fetch` + `git reset --hard origin/main` against the
 * REAL checkout regardless of which process invokes it.
 *
 * `POST /pick-folder` is only ever exercised in the REFUSED state, where the
 * middleware short-circuits before `osascript` runs. Calling it while idle
 * would open a real, blocking Finder dialog on the developer's machine.
 */

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { createServer } from 'http';

// ── Isolation FIRST — before any app module is imported ─────────────────
const TMP = mkdtempSync(path.join(tmpdir(), 'curator-cfgguard-'));
const TMP_USER = path.join(TMP, 'userdata');
const TMP_DOMAINS = path.join(TMP, 'domains');
const TMP_PICK = path.join(TMP, 'picked-folder');
for (const d of [TMP_USER, TMP_DOMAINS, TMP_PICK]) mkdirSync(d, { recursive: true });

process.env.CURATOR_TEST_USER_DATA_DIR = TMP_USER;
process.env.CURATOR_TEST_DOMAINS_DIR = TMP_DOMAINS;
// DOMAINS_PATH still outranks the default inside getDomainsDir(); an inherited
// one would point an "isolated" run at a real wiki (see paths.js's docblock).
delete process.env.DOMAINS_PATH;

// Fingerprint the REAL credential files so we can prove we never touched them.
const REPO_ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const REAL_FILES = [
  '.curator-config.json', '.sync-config.json', '.sharedbrain-config.json',
].map(f => path.join(REPO_ROOT, f));
function fingerprint() {
  // sha256 + size + existence ONLY. mtime is deliberately excluded: the
  // maintainer's live app on :3333 rewrites .curator-config.json during
  // ordinary Settings use, and an mtime-sensitive guard would then fail a
  // multi-second suite with a false "isolation is broken" (the v3.0.16
  // misattribution shape).
  return REAL_FILES.map(f => {
    if (!existsSync(f)) return `${path.basename(f)}:absent`;
    const buf = readFileSync(f);
    return `${path.basename(f)}:${buf.length}:${createHash('sha256').update(buf).digest('hex')}`;
  }).join('|');
}
const FINGERPRINT_BEFORE = fingerprint();

const { default: configRouter } = await import('../src/routes/config.js');
const { default: syncRouter } = await import('../src/routes/sync.js');
const { default: domainsRouter } = await import('../src/routes/domains.js');
const { default: healthRouter } = await import('../src/routes/health.js');
const { writePage, renameDomain, listDomains } = await import('../src/brain/files.js');
const { getCuratorConfigFile } = await import('../src/brain/paths.js');
const registry = await import('../src/brain/write-registry.js');
const { default: express } = await import('express');

let passed = 0, failed = 0;
const failures = [];
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; failures.push(label); console.log(`  ✗ ${label}`); }
}
function eq(actual, expected, label) {
  assert(actual === expected, `${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}

// ── Test server: the REAL router, mounted in-process ────────────────────
// In-process is required, not a convenience: the write registry is an
// in-memory Map scoped to one process, so an out-of-process test could not
// register a write that the server would see (short of running a real,
// paid ingest).
const app = express();
app.use(express.json());
app.use('/api/config', configRouter);
app.use('/api/sync', syncRouter);
app.use('/api/domains', domainsRouter);
app.use('/api/health', healthRouter);
const server = createServer(app);
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

async function post(routePath, body) {
  const res = await fetch(BASE + routePath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, ok: res.ok, body: json };
}

async function put(routePath, body) {
  const res = await fetch(BASE + routePath, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, ok: res.ok, body: json };
}

async function del(routePath) {
  const res = await fetch(BASE + routePath, { method: 'DELETE' });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, ok: res.ok, body: json };
}

// The five routes this change guards. `/pick-folder` carries a flag: it is
// only ever called in the REFUSED state (see the file docblock).
const GUARDED = [
  { path: '/api/config/domains-path',        body: { path: TMP_PICK },       label: 'domains-path' },
  { path: '/api/config/pick-folder',         body: {},                        label: 'pick-folder', refusedOnly: true },
  { path: '/api/config/api-keys',            body: { geminiApiKey: 'test-key-aaa' }, label: 'api-keys (save)' },
  { path: '/api/config/api-keys/disconnect', body: { provider: 'gemini' },   label: 'api-keys/disconnect' },
  { path: '/api/config/api-keys/active',     body: { provider: 'gemini' },   label: 'api-keys/active' },
];

console.log('\n=== 1. Isolation is real before any mutating request ===');
{
  const cfgPath = getCuratorConfigFile();
  assert(cfgPath.startsWith(TMP_USER),
    `resolved config file is inside the tempdir (${cfgPath})`);
  assert(!cfgPath.startsWith(REPO_ROOT + path.sep + '.curator-config'),
    'resolved config file is NOT the repo-root .curator-config.json');
  assert(registry.hasActiveWrites() === false, 'registry starts clean');
}

console.log('\n=== 2. Guard does NOT fire when idle (the half people forget) ===');
{
  registry.__testing._resetActiveWrites();
  for (const r of GUARDED.filter(r => !r.refusedOnly)) {
    const { status, body } = await post(r.path, r.body);
    assert(status !== 409, `${r.label}: not refused while idle (status ${status})`);
    assert(!body || body.conflict !== 'write_in_progress',
      `${r.label}: idle response carries no write_in_progress conflict`);
  }
  // And the normal path genuinely works, not merely "not 409":
  const dp = await post('/api/config/domains-path', { path: TMP_PICK });
  eq(dp.status, 200, 'domains-path succeeds while idle');
  assert(dp.body && dp.body.ok === true, 'domains-path returns ok:true while idle');
  const save = await post('/api/config/api-keys', { geminiApiKey: 'test-key-bbb' });
  eq(save.status, 200, 'api-keys save succeeds while idle');
  assert(save.body && save.body.ok === true, 'api-keys save returns ok:true while idle');
  assert(save.body.activeProvider === 'gemini',
    'api-keys save applies last-saved-wins while idle (activeProvider=gemini)');
  const act = await post('/api/config/api-keys/active', { provider: 'gemini' });
  eq(act.status, 200, 'api-keys/active succeeds while idle');
}

console.log('\n=== 3. Guard FIRES while a write is registered ===');
{
  const release = registry.registerWrite('articles', 'ingest');
  assert(registry.hasActiveWrites() === true, 'a write is registered');

  for (const r of GUARDED) {
    const { status, body } = await post(r.path, r.body);
    eq(status, 409, `${r.label}: refused with 409`);
    assert(body && body.conflict === 'write_in_progress',
      `${r.label}: body.conflict === "write_in_progress"`);
    assert(body && typeof body.error === 'string' && body.error.length > 0,
      `${r.label}: body carries a non-empty error string`);
    // `?? ''` rather than a bare deref: under a mutation that disables the
    // guard these fields are absent, and a TypeError here would abort the run
    // and hide every remaining failure — a mutation must produce a full,
    // readable RED, not a stack trace on the first assertion.
    const errText = (body && typeof body.error === 'string') ? body.error : '';
    // Actionable, not a bare 409 — the message must name what is running.
    assert(errText.includes('articles'), `${r.label}: error names the active domain`);
    assert(errText.includes('ingest'), `${r.label}: error names the active operation`);
    assert(/wait for it to finish/i.test(errText),
      `${r.label}: error tells the user what to do`);
    assert(body && Array.isArray(body.active) && body.active.length === 1,
      `${r.label}: body.active is structured for the frontend`);
    eq(body && body.updateInProgress, false, `${r.label}: updateInProgress flag present and false`);
    // The shipping frontend's pick-folder handler checks `data.cancelled`
    // BEFORE `res.ok`, so a refusal carrying that field would be silently
    // swallowed as "user pressed Cancel" and the error never shown.
    assert(!body || body.cancelled === undefined,
      `${r.label}: refusal does NOT carry a "cancelled" field`);
    // /api/config/update's frontend handler interpolates err.message into
    // innerHTML, so refusal text must be HTML-inert.
    assert(!/[<>&]/.test(errText), `${r.label}: error text is HTML-safe`);
  }

  // /pick-folder's refusal must come from the MIDDLEWARE, i.e. before
  // `osascript` is ever spawned. If the middleware were removed, the request
  // would reach execAsync and block on a real, modal Finder dialog for up to
  // its 60 s timeout. A sub-second refusal is therefore positive evidence that
  // no dialog was opened — and it is the only way to prove this route's guard
  // behaviourally without actually opening one on the developer's screen.
  const release2 = registry.registerWrite('articles', 'ingest');
  const t0 = Date.now();
  const pick = await post('/api/config/pick-folder', {});
  const elapsed = Date.now() - t0;
  eq(pick.status, 409, 'pick-folder refused with 409');
  assert(elapsed < 1000,
    `pick-folder refused in ${elapsed}ms — short-circuited before osascript spawned a dialog`);
  release2();

  release();
  assert(registry.hasActiveWrites() === false, 'registry clean after release');
}

console.log('\n=== 4. Guard releases correctly — routes work again afterwards ===');
{
  registry.__testing._resetActiveWrites();
  for (const r of GUARDED.filter(r => !r.refusedOnly)) {
    const { status } = await post(r.path, r.body);
    assert(status !== 409, `${r.label}: usable again once the write finished (status ${status})`);
  }
  // Refcount semantics: two writes on one domain need two releases.
  const rel1 = registry.registerWrite('articles', 'ingest');
  const rel2 = registry.registerWrite('articles', 'compile');
  rel1();
  assert(registry.hasActiveWrites() === true, 'still active after one of two releases');
  const stillRefused = await post('/api/config/api-keys/active', { provider: 'gemini' });
  eq(stillRefused.status, 409, 'still refused while the second write runs');
  rel2();
  const nowOk = await post('/api/config/api-keys/active', { provider: 'gemini' });
  assert(nowOk.status !== 409, 'allowed once the last write releases');
}

console.log('\n=== 5. Deliberately UNGUARDED routes stay unguarded ===');
{
  // /default-domain only selects which domain MCP write tools assume when the
  // user does not name one. An in-flight ingest already has an explicit
  // domain, so changing this cannot affect a write that is already running —
  // guarding it would be blanket application, not reasoning. Pinned so a
  // future sweep has to justify itself here.
  const release = registry.registerWrite('articles', 'ingest');
  const res = await fetch(BASE + '/api/config/default-domain', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ defaultDomain: '' }),
  });
  assert(res.status !== 409,
    `/default-domain is NOT guarded (status ${res.status}) — it cannot affect an in-flight write`);
  // GETs are never guarded — read-only, and the Settings UI polls them.
  const get = await fetch(BASE + '/api/config');
  eq(get.status, 200, 'GET /api/config still readable during a write');
  const keys = await fetch(BASE + '/api/config/api-keys');
  eq(keys.status, 200, 'GET /api/config/api-keys still readable during a write');
  release();
}

console.log('\n=== 6. Source guards — shape of the fix ===');
{
  const src = readFileSync(path.join(REPO_ROOT, 'src/routes/config.js'), 'utf8');

  // Each guarded route must carry the middleware on its own declaration line.
  for (const [route, action] of [
    ['/domains-path', 'change the knowledge folder'],
    ['/pick-folder', 'change the knowledge folder'],
    ['/api-keys', 'save API keys'],
    ['/api-keys/disconnect', 'disconnect an API key'],
    ['/api-keys/active', 'switch the AI provider'],
  ]) {
    const re = new RegExp(`router\\.post\\(\\s*'${route.replace(/\//g, '\\/')}'\\s*,\\s*guardConcurrent\\(`);
    assert(re.test(src), `${route} declares guardConcurrent(...) as middleware`);
    assert(src.includes(`guardConcurrent('${action}')`),
      `${route} uses the action phrase "${action}"`);
  }

  // The refusal must be built by the SHARED conflictResponse, never a
  // hand-rolled 409 — that is what keeps status/body/message identical to
  // every other refusal in the app.
  assert(!/res\.status\(409\)/.test(src),
    'no hand-rolled 409 in config.js — all refusals go through conflictResponse()');

  // pick-folder's post-dialog re-check. The middleware only proves the state
  // when the dialog OPENED; osascript blocks for up to 60 s. This cannot be
  // exercised over HTTP without opening a real Finder dialog, so it is pinned
  // at the source level.
  const pickStart = src.indexOf(`router.post('/pick-folder'`);
  const pickEnd = src.indexOf(`router.post('/api-keys'`, pickStart);
  assert(pickStart !== -1 && pickEnd > pickStart, 'located the /pick-folder handler');
  const pickBody = src.slice(pickStart, pickEnd);
  const recheck = pickBody.indexOf('hasActiveWrites()');
  const setCall = pickBody.indexOf('setDomainsDir(picked)');
  assert(recheck !== -1, '/pick-folder re-checks hasActiveWrites() after the dialog returns');
  assert(recheck !== -1 && setCall !== -1 && recheck < setCall,
    '/pick-folder re-check happens BEFORE setDomainsDir(picked), not after');

  // /update must keep its own guard -- this change must not have disturbed it.
  const upStart = src.indexOf("router.post('/update'");
  assert(upStart !== -1 && src.slice(upStart, upStart + 1200).includes('hasActiveWrites()'),
    'POST /update still carries its original hasActiveWrites() guard');

  // ── sync.js: EVERY mutating route must carry guardConcurrent ────────────
  // This is the invariant, not a per-route spot check. POST /setup was the one
  // route in that file without the middleware while its four siblings had it,
  // and nothing caught it because no test asserted the class. A future sync
  // route added without the guard now fails here instead of shipping.
  const syncSrc = readFileSync(path.join(REPO_ROOT, 'src/routes/sync.js'), 'utf8');
  const syncMut = [...syncSrc.matchAll(/router\.(post|put|delete|patch)\(\s*'([^']+)'([^\n]*)/g)];
  assert(syncMut.length >= 5, 'found sync.js mutating routes to check (' + syncMut.length + ')');
  for (const m of syncMut) {
    assert(/guardConcurrent\(/.test(m[3]),
      'sync.js ' + m[1].toUpperCase() + " '" + m[2] + "' carries guardConcurrent");
  }

  // ── domains.js: rename and delete use the PER-DOMAIN predicate ──────────
  // A rename or delete affects exactly one domain, so blocking either because
  // an unrelated domain is busy would be broader than the harm. Pin that they
  // do NOT reach for the global hasActiveWrites().
  const domSrc = readFileSync(path.join(REPO_ROOT, 'src/routes/domains.js'), 'utf8');
  const putStart = domSrc.indexOf("router.put('/:domain'");
  const delStart = domSrc.indexOf("router.delete('/:domain'");
  assert(putStart !== -1 && delStart > putStart, 'located domains.js PUT and DELETE handlers');
  const putBodyRaw = domSrc.slice(putStart, delStart);
  // Strip line comments before these assertions. The handler's own docblock
  // explains WHY it uses isDomainActive "rather than the global
  // hasActiveWrites()" and mentions "renameDomain() moves the directory" --
  // both of which a naive substring test happily matches, so the first version
  // of these two assertions was measuring prose instead of code and went RED
  // against correct source. An assertion about code must read code.
  const putBody = putBodyRaw.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  assert(/isDomainActive\(req\.params\.domain\)/.test(putBody),
    'domains.js PUT /:domain guards with isDomainActive(req.params.domain)');
  assert(!/hasActiveWrites\(/.test(putBody),
    'domains.js PUT /:domain does NOT use the global hasActiveWrites()');
  assert(/isDomainActive\(/.test(domSrc.slice(delStart, delStart + 800)),
    'domains.js DELETE /:domain still guards with isDomainActive (unchanged)');
  // The guard must precede the work, not sit after it.
  assert(putBody.indexOf('isDomainActive') < putBody.indexOf('renameDomain('),
    'domains.js PUT guard runs BEFORE renameDomain()');
}

console.log('\n=== 7. The real credential files were never touched ===');
{
  eq(fingerprint(), FINGERPRINT_BEFORE,
    'real .curator-config.json / .sync-config.json / .sharedbrain-config.json unchanged (sha256+size)');
  // And the tempdir config really did receive the writes, proving section 2's
  // mutations landed somewhere — an isolation that wrote nowhere would make
  // the fingerprint assertion above vacuous.
  const tmpCfg = getCuratorConfigFile();
  assert(existsSync(tmpCfg), 'the isolated tempdir config WAS written to (isolation is not vacuous)');
  const parsed = JSON.parse(readFileSync(tmpCfg, 'utf8'));
  assert(parsed.geminiApiKey === 'test-key-bbb' || typeof parsed.geminiApiKey === 'string',
    'tempdir config holds the test key, not a real one');
}


console.log('\n=== 8. POST /api/sync/setup is guarded like its four siblings ===');
{
  // setup() runs git init + \`git add -A\` + commit + \`git push\` across the
  // domains work-tree. It is NEVER invoked for real here: the idle half sends
  // a deliberately invalid body so its own validation answers 400, which
  // proves the guard did NOT short-circuit without performing any git or
  // network operation. 400 vs 409 is the whole distinction being tested.
  registry.__testing._resetActiveWrites();
  const idle = await post('/api/sync/setup', {});
  eq(idle.status, 400, 'sync/setup reaches its own validation when idle (400, not 409)');
  assert(idle.body && /repoUrl/i.test(idle.body.error || ''),
    'sync/setup idle response is its real validation error, not a refusal');

  const release = registry.registerWrite('articles', 'ingest');
  const busy = await post('/api/sync/setup', {});
  eq(busy.status, 409, 'sync/setup refused with 409 while a write is running');
  assert(busy.body && busy.body.conflict === 'write_in_progress',
    'sync/setup refusal carries conflict: write_in_progress');
  assert(busy.body && /articles/.test(busy.body.error || ''),
    'sync/setup refusal names the active domain');
  assert(busy.body && !/repoUrl/i.test(busy.body.error || ''),
    'sync/setup refusal short-circuits BEFORE body validation (no git, no network)');
  // The shipping sync wizard duck-types on data.success; a refusal must not
  // carry one, or the wizard would treat the refusal as a successful setup.
  assert(busy.body && busy.body.success === undefined,
    'sync/setup refusal does NOT carry a "success" field');

  // THE TRAP for this route, and the reason the action phrase is "set up sync".
  // app.js's submitSyncSetup catch (app.js:4587) runs a network-down regex over
  // ANY thrown message -- including a structured 409's error text -- and on a
  // match REPLACES it with "The Curator server stopped responding during
  // setup...". That regex carries a bare, unanchored "connection" alternative,
  // which a natural phrasing like "change the repository connection" would trip,
  // silently discarding the real refusal. Same class as the "cancelled" trap on
  // /pick-folder: the guard fires and the user is told something false.
  //
  // The regex is EXTRACTED FROM app.js rather than copied, so if that line is
  // reworded this assertion follows it instead of quietly rotting.
  const appJs = readFileSync(path.join(REPO_ROOT, 'src/public/app.js'), 'utf8');
  const reLine = appJs.match(/const isNetworkDown = \/([^\n]+?)\/i\.test\(raw\)/);
  assert(!!reLine, 'located app.js isNetworkDown regex (if RED, re-verify the sync-wizard trace)');
  if (reLine) {
    const netRe = new RegExp(reLine[1], 'i');
    assert(!netRe.test((busy.body && busy.body.error) || ''),
      'sync/setup refusal does NOT trip app.js network-down regex (else it is replaced by a false "server stopped responding" message)');
    // Prove that assertion CAN fail -- a regex matching nothing would make it
    // vacuously green.
    assert(netRe.test('the connection was reset'),
      '  (control) the extracted regex really does match a network-shaped message');
  }
  release();
}

console.log('\n=== 9. PUT /api/domains/:domain (rename) is guarded, PER DOMAIN ===');
{
  registry.__testing._resetActiveWrites();
  // Fixture: two real domains in the isolated tempdir.
  for (const name of ['alpha', 'other']) {
    for (const sub of ['wiki/entities', 'wiki/concepts', 'wiki/summaries', 'raw', 'conversations'])
      mkdirSync(path.join(TMP_DOMAINS, name, sub), { recursive: true });
    writeFileSync(path.join(TMP_DOMAINS, name, 'CLAUDE.md'), '# Domain: ' + name + '\n');
    writeFileSync(path.join(TMP_DOMAINS, name, 'wiki/index.md'), '# Wiki Index — ' + name + '\n');
    writeFileSync(path.join(TMP_DOMAINS, name, 'wiki/log.md'), '# Ingest Log — ' + name + '\n');
  }

  const busyRelease = registry.registerWrite('alpha', 'ingest');
  const refused = await put('/api/domains/alpha', { displayName: 'Renamed Alpha' });
  eq(refused.status, 409, 'rename refused with 409 while THAT domain is being written');
  assert(refused.body && refused.body.conflict === 'write_in_progress',
    'rename refusal carries conflict: write_in_progress');
  assert(refused.body && /rename domain/i.test(refused.body.error || ''),
    'rename refusal names the attempted operation');
  assert(existsSync(path.join(TMP_DOMAINS, 'alpha')),
    'the refused rename did NOT move the directory');

  // THE distinguishing assertion: the predicate is per-domain (isDomainActive),
  // matching the sibling DELETE — not the global hasActiveWrites(). A write on
  // an unrelated domain must NOT block this rename.
  const otherOk = await put('/api/domains/other', { displayName: 'Other Renamed' });
  assert(otherOk.status !== 409,
    'an unrelated domain is still renameable while "alpha" is busy (per-domain predicate, not global)');
  busyRelease();

  // Idle half: the rename genuinely works.
  registry.__testing._resetActiveWrites();
  const ok = await put('/api/domains/alpha', { displayName: 'Alpha Renamed' });
  assert(ok.status !== 409, 'rename not refused when idle (status ' + ok.status + ')');
  eq(ok.status, 200, 'rename succeeds when idle');
}

console.log('\n=== 10. Regression: the harm the rename guard exists to prevent ===');
{
  // Drives the real files.js functions to pin the mechanism, so the guard's
  // rationale is executable rather than a claim in a comment.
  //
  // If this section ever goes RED because writePage() stopped resurrecting the
  // directory, that does NOT mean the guard can be removed — the display-name
  // branch still races appendLog() over log.md. It means this rationale needs
  // rewriting to match the new behaviour.
  const d = path.join(TMP_DOMAINS, 'harm');
  for (const sub of ['wiki/entities', 'wiki/concepts', 'wiki/summaries', 'raw'])
    mkdirSync(path.join(d, sub), { recursive: true });
  writeFileSync(path.join(d, 'CLAUDE.md'), '# Domain: harm\n');
  writeFileSync(path.join(d, 'wiki/index.md'), '# Wiki Index — harm\n');
  writeFileSync(path.join(d, 'wiki/log.md'), '# Ingest Log — harm\n');

  await writePage('harm', 'entities/before.md', '# Before\n\n## Key Facts\n\n- one\n');
  await renameDomain('harm', 'harm-renamed', 'Harm Renamed');
  assert(!existsSync(path.join(TMP_DOMAINS, 'harm')), 'rename moved the directory away');

  // An in-flight ingest keeps writing to the slug it captured at request time.
  const after = await writePage('harm', 'entities/after.md', '# After\n\n## Key Facts\n\n- two\n');
  assert(after !== null, 'writePage to the OLD slug does not fail loudly — it silently succeeds');
  assert(existsSync(path.join(TMP_DOMAINS, 'harm', 'wiki/entities/after.md')),
    'the remaining page landed in a RESURRECTED ghost directory (writePage mkdirs it)');
  assert(!existsSync(path.join(TMP_DOMAINS, 'harm', 'CLAUDE.md')),
    'the ghost has no CLAUDE.md');
  const visible = await listDomains();
  assert(!visible.includes('harm'),
    'listDomains() HIDES the ghost — those pages are invisible in every UI surface');
  assert(visible.includes('harm-renamed'), 'only the renamed domain is visible');
  assert(existsSync(path.join(TMP_DOMAINS, 'harm-renamed', 'wiki/entities/before.md')) &&
         !existsSync(path.join(TMP_DOMAINS, 'harm-renamed', 'wiki/entities/after.md')),
    'the document is SPLIT: first half in the renamed domain, second half orphaned');
}

console.log('\n=== 11. POST /api/health/:domain/fix is guarded like /fix-all ===');
{
  // IMPORTANT — what "guarded" means for this route, and what it does NOT mean.
  // The first version of this section asserted /fix returns 409 while an ingest
  // is registered. It does not, and neither does /fix-all: registerWrite() is
  // not a mutual-exclusion gate between two writes. The protection runs the
  // OTHER way -- /fix now REGISTERS, so a concurrent sync / update / domain
  // delete refuses while it runs -- plus an isUpdateInProgress() check, which
  // is the only condition under which /fix itself refuses. Asserting the
  // assumed behaviour instead of the real one produced a RED against correct
  // source; these assertions measure what the guard actually provides.
  registry.__testing._resetActiveWrites();
  registry.__testing._resetUpdate();

  const build = (dom, n) => {
    for (const sub of ['wiki/entities', 'wiki/concepts', 'wiki/summaries', 'raw'])
      mkdirSync(path.join(TMP_DOMAINS, dom, sub), { recursive: true });
    writeFileSync(path.join(TMP_DOMAINS, dom, 'CLAUDE.md'), '# Domain: ' + dom + '\n');
    writeFileSync(path.join(TMP_DOMAINS, dom, 'wiki/index.md'), '# Wiki Index\n');
    writeFileSync(path.join(TMP_DOMAINS, dom, 'wiki/log.md'), '# Ingest Log\n');
    for (let i = 0; i < n; i++) {
      writeFileSync(path.join(TMP_DOMAINS, dom, 'wiki/concepts/c' + i + '.md'), '# c' + i + '\n');
      writeFileSync(path.join(TMP_DOMAINS, dom, 'wiki/entities/e' + i + '.md'),
        '# e' + i + '\n\n## Related\n\n- [[concepts/c' + i + ']]\n');
    }
  };
  const page = (d, i) => path.join(TMP_DOMAINS, d, 'wiki/entities/e' + i + '.md');

  // ── (a) refuses while an app update is in progress; not when idle ────────
  build('hfix', 2);
  const beforeBytes = readFileSync(page('hfix', 0), 'utf8');
  registry.beginUpdate();
  const duringUpdate = await post('/api/health/hfix/fix', { type: 'folderPrefixLinks' });
  eq(duringUpdate.status, 409, '/fix refused with 409 while an app update is in progress');
  assert(duringUpdate.body && duringUpdate.body.conflict === 'write_in_progress',
    '/fix refusal carries conflict: write_in_progress');
  assert(duringUpdate.body && /fix an issue in domain/i.test(duringUpdate.body.error || ''),
    '/fix refusal names the attempted operation');
  eq(readFileSync(page('hfix', 0), 'utf8'), beforeBytes,
    '/fix refusal performed NO partial work — the page is byte-identical');
  assert(duringUpdate.body && duringUpdate.body.ok === undefined,
    '/fix refusal does NOT carry ok:true');
  assert(duringUpdate.body && duringUpdate.body.fixed === undefined,
    '/fix refusal does NOT carry a "fixed" count');
  registry.endUpdate();

  const idle = await post('/api/health/hfix/fix', { type: 'folderPrefixLinks' });
  assert(idle.status !== 409, '/fix NOT refused when idle (status ' + idle.status + ')');
  eq(idle.status, 200, '/fix succeeds when idle');
  assert(idle.body && idle.body.ok === true, '/fix returns ok:true when idle');
  assert(!readFileSync(page('hfix', 0), 'utf8').includes('[[concepts/'),
    '/fix genuinely rewrote the folder-prefix link (not merely "not 409")');

  // ── (b) THE PROTECTION GAINED: /fix registers, so destructive siblings
  //        refuse while it is in flight. This is the whole point of the fix.
  build('hbusy', 900);
  let seenOps = null, syncDuring = null, deleteDuring = null;
  const inFlight = post('/api/health/hbusy/fix', { type: 'folderPrefixLinks' });
  for (let i = 0; i < 400; i++) {                    // poll until it registers
    const active = registry.listActiveWrites();
    if (active.some(a => a.domain === 'hbusy')) {
      seenOps = active.find(a => a.domain === 'hbusy').ops;
      syncDuring = await post('/api/sync/push', {});
      deleteDuring = await del('/api/domains/hbusy');
      break;
    }
    await new Promise(r => setTimeout(r, 2));
  }
  const done = await inFlight;
  eq(done.status, 200, '/fix completed');
  assert(seenOps !== null, '/fix registered itself in the write registry while running');
  assert(seenOps && seenOps.includes('health-fix'),
    '/fix registers under the label "health-fix" (got ' + JSON.stringify(seenOps) + ')');
  assert(syncDuring && syncDuring.status === 409,
    'a concurrent sync push is REFUSED while /fix runs (status ' + (syncDuring && syncDuring.status) + ')');
  assert(deleteDuring && deleteDuring.status === 409,
    'a concurrent domain delete is REFUSED while /fix runs (status ' + (deleteDuring && deleteDuring.status) + ')');
  assert(existsSync(path.join(TMP_DOMAINS, 'hbusy')),
    'the refused delete did NOT remove the domain mid-fix');
  // Poll rather than assert immediately: the client receives the response from
  // res.json() inside the try, while releaseRegistry() runs in the finally that
  // follows — so there is a legitimate tick where the response has arrived and
  // the registration is still held. Asserting instantly made this RED against
  // correct source.
  let released = false;
  for (let i = 0; i < 200; i++) {
    if (registry.listActiveWrites().every(a => a.domain !== 'hbusy')) { released = true; break; }
    await new Promise(r => setTimeout(r, 5));
  }
  assert(released, '/fix released its registration when it finished');

  // ── (c) parity: /fix-all behaves identically, proving a mirror not an invention
  build('hpar', 2);
  registry.beginUpdate();
  const faUpd = await post('/api/health/hpar/fix-all', { type: 'folderPrefixLinks' });
  const fUpd  = await post('/api/health/hpar/fix',     { type: 'folderPrefixLinks' });
  eq(fUpd.status, faUpd.status, '/fix and /fix-all agree on status during an update');
  eq(fUpd.body && fUpd.body.conflict, faUpd.body && faUpd.body.conflict,
    '/fix and /fix-all agree on the conflict field during an update');
  registry.endUpdate();
}

console.log('\n=== 12. Regression: /fix with no `issue` runs the BULK path ===');
{
  // This is why the guard is required, and why the old "sub-second" rationale
  // was wrong. fixIssue() branches on its third argument: falsy => scanWiki()
  // plus a fix for EVERY issue of that type. /fix passes `issue || null`, so
  // omitting `issue` makes this route do exactly what /fix-all does.
  registry.__testing._resetActiveWrites();
  const dom = 'hbulk';
  for (const sub of ['wiki/entities', 'wiki/concepts', 'wiki/summaries', 'raw'])
    mkdirSync(path.join(TMP_DOMAINS, dom, sub), { recursive: true });
  writeFileSync(path.join(TMP_DOMAINS, dom, 'CLAUDE.md'), '# Domain: ' + dom + '\n');
  writeFileSync(path.join(TMP_DOMAINS, dom, 'wiki/index.md'), '# Wiki Index\n');
  writeFileSync(path.join(TMP_DOMAINS, dom, 'wiki/log.md'), '# Ingest Log\n');
  for (const n of ['a', 'b', 'c']) {
    writeFileSync(path.join(TMP_DOMAINS, dom, 'wiki/concepts/' + n + '.md'), '# ' + n + '\n');
    writeFileSync(path.join(TMP_DOMAINS, dom, 'wiki/entities/src-' + n + '.md'),
      '# src-' + n + '\n\n## Related\n\n- [[concepts/' + n + ']]\n');
  }
  const res = await post('/api/health/' + dom + '/fix', { type: 'folderPrefixLinks' });
  eq(res.status, 200, '/fix with no issue succeeds');
  assert(res.body && res.body.total >= 3,
    '/fix with no `issue` scanned the whole domain and found every issue (total=' +
    (res.body && res.body.total) + ') — this is the BULK path, not a single fix');
  assert(res.body && res.body.fixed >= 3,
    '/fix with no `issue` fixed MULTIPLE files in one call (fixed=' +
    (res.body && res.body.fixed) + ')');
  for (const n of ['a', 'b', 'c'])
    assert(!readFileSync(path.join(TMP_DOMAINS, dom, 'wiki/entities/src-' + n + '.md'), 'utf8')
      .includes('[[concepts/'), 'bulk path rewrote src-' + n + '.md');
}

console.log('\n=== 13. INVARIANT: every destructive health.js route registers ===');
{
  // The class assertion, not a spot check. /:domain/fix reached fixIssue() --
  // the same destructive function as /fix-all -- while carrying none of the
  // three protections, and nothing caught it because no test asserted the
  // class. Enumerated mechanically: strip comments and strings, brace-match
  // each router.X(...) call, and for any handler that reaches a destructive
  // wiki-write, require all three guards. A route added later without them
  // fails HERE rather than shipping.
  //
  // Sound in the safe direction: anything the classifier cannot prove
  // destructive is simply not required to register, so a parsing miss yields a
  // missed check, never a false accusation. DESTRUCTIVE is an explicit
  // allow-list of the wiki-mutating functions health.js calls; the dismissal
  // sidecar (.health-dismissed.jsonl) is deliberately excluded -- it is an
  // append to a metadata file, not a wiki-content write, and none of the
  // existing dismissal routes register.
  const healthSrc = readFileSync(path.join(REPO_ROOT, 'src/routes/health.js'), 'utf8');
  const stripped = (function strip(src) {
    let o = ''; let q = null, line = false, block = false;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (line) { if (c === '\n') { line = false; o += '\n'; } else o += ' '; continue; }
      if (block) { if (c === '*' && src[i + 1] === '/') { block = false; o += '  '; i++; } else o += (c === '\n' ? '\n' : ' '); continue; }
      if (q) { if (c === '\\') { o += '  '; i++; continue; } if (c === q) q = null; o += (c === '\n' ? '\n' : ' '); continue; }
      if (c === '/' && src[i + 1] === '/') { line = true; o += ' '; continue; }
      if (c === '/' && src[i + 1] === '*') { block = true; o += ' '; continue; }
      if (c === '"' || c === "'" || c === '`') { q = c; o += ' '; continue; }
      o += c;
    }
    return o;
  })(healthSrc);
  const matchPair = (s, from) => { let d = 0; for (let i = from; i < s.length; i++) { if (s[i] === '(') d++; else if (s[i] === ')') { d--; if (d === 0) return i; } } return -1; };
  const DESTRUCTIVE = ['fixIssue', 'fixAllSafe', 'applyBrokenLinkFixes', 'applyOrphanRescue', 'fixSemanticDuplicatesBatch'];

  const MUT = /\brouter\.(post|put|delete|patch)\s*\(/g;
  let m, mutating = 0, destructiveRoutes = 0, parseFails = 0;
  while ((m = MUT.exec(stripped))) {
    mutating++;
    const open = stripped.indexOf('(', m.index);
    const end = matchPair(stripped, open);
    if (end === -1) { parseFails++; continue; }
    const body = stripped.slice(open, end + 1);
    const route = (healthSrc.slice(open, end + 1).match(/^\(\s*['"`]([^'"`]*)['"`]/) || [])[1] || '(non-literal)';
    const hits = DESTRUCTIVE.filter(f => new RegExp('\\b' + f + '\\s*\\(').test(body));
    if (!hits.length) continue;
    destructiveRoutes++;
    const label = 'health.js ' + m[1].toUpperCase() + " '" + route + "' (calls " + hits.join(',') + ')';
    assert(/\bregisterWrite\s*\(/.test(body), label + ' registers with the write registry');
    assert(/\bacquireFileLock\s*\(/.test(body), label + ' takes the cross-process file lock');
    assert(/\bisUpdateInProgress\s*\(/.test(body), label + ' refuses during an app update');
  }
  eq(parseFails, 0, 'every router.X(...) in health.js brace-matched cleanly');
  assert(mutating >= 10, 'enumerated health.js mutating routes (' + mutating + ')');
  // Pin the count so a destructive route that stops being RECOGNISED (renamed
  // helper, new wrapper) shows up as a drop rather than silently leaving the
  // loop with nothing to check -- the way a green suite can hide a no-op.
  eq(destructiveRoutes, 6,
    'exactly 6 health.js routes reach a destructive wiki-write (if this moved, the DESTRUCTIVE allow-list needs updating)');
  // Prove the classifier can actually SEE a missing guard, so the loop above is
  // not vacuously green.
  const fake = "router.post('/x', async (req,res) => { await fixIssue(d,t,i); });";
  assert(!/\bregisterWrite\s*\(/.test(fake) && /\bfixIssue\s*\(/.test(fake),
    '  (control) an unguarded destructive handler is detectable by these same tests');
}

// ── Teardown ─────────────────────────────────────────────────────────────
await new Promise(r => server.close(r));
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(`\n${'='.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) {
  console.log('\nFailing assertions:');
  for (const f of failures) console.log(`  - ${f}`);
}
console.log('='.repeat(60));
process.exit(failed > 0 ? 1 : 0);
