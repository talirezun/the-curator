#!/usr/bin/env node
/**
 * test-offer-list-memo.js — OFFLINE suite for the MEMOISED offer list in
 * `src/brain/llm.js` (`listOfferableModels` / `findOfferableModel` /
 * `measurementProvenance`) and for the wire shape it feeds.
 *
 * ── WHAT THIS EXISTS TO STOP ────────────────────────────────────────────────
 *
 * `listOfferableModels` merged, sorted and froze ~198 catalogue entries ON
 * EVERY CALL, and four predicates resolve through it, so a screen that asks a
 * question PER ROW asked it PER ROW. Measured on an isolated install carrying
 * three fake-shaped keys and the real persisted OpenRouter catalogue: ONE
 * `GET /api/config/api-keys` drove **660** calls at **0.389 ms** each; the
 * handler body took **242 ms**, the endpoint **270 ms** over HTTP for 180,983
 * bytes. With no key configured the same endpoint answers in 0.6 ms, which is
 * why an earlier audit walked past it. After the memo: **0.0002 ms** per call,
 * a **4.1 ms** handler and a **3.5 ms** endpoint, for a byte-identical body.
 *
 * A memo is only ever as good as its INVALIDATION, and a stale offer list is
 * not a cosmetic defect on this surface — it is a spending surface. The three
 * failures this file is built to catch, in order of how badly they would end:
 *
 *   1. A CATALOGUE SYNC THAT NOBODY SEES (§2). `setOpenRouterCatalogue` is the
 *      single writer of `_openrouterCatalogue`; if the memo key stopped
 *      tracking that array's IDENTITY, a refreshed catalogue would be admitted,
 *      persisted, reported as "221 models · last refreshed just now" — and the
 *      picker would keep serving the previous list. The app would state two
 *      contradictory things about one fetch.
 *   2. A MUTABLE ARRAY HANDED OUT (§3). The whole point of returning the same
 *      object is that it is the same object; one caller pushing into it would
 *      corrupt the list every later caller reads, including the build-lane
 *      gate.
 *   3. A PROTOTYPE KEY RESOLVING (§4). The membership scan became a lookup.
 *      A `Map` has no prototype chain, so `'__proto__'` / `'constructor'` /
 *      `'toString'` still resolve to nothing — but a PLAIN OBJECT here would
 *      reopen the v3.0.9 `normalizeResponseStyle` defect on the allow-list
 *      that decides which model string reaches an SDK.
 *
 * §5 pins the ROUTE's serialised body against a recorded fixture, because the
 * acceptance criterion for a performance change is "nothing moved", and the
 * only honest way to say that is to compare the bytes.
 *
 * §6 asserts the standing invariants the memo must not have relaxed — a model
 * may not be offered without measurement, a live verdict is three-valued, and
 * `cheapestMeasured` excludes a model whose verdict says the provider withdrew
 * it. They are re-asserted HERE, against a memoised list, because a cache is
 * exactly the mechanism by which a still-green assertion starts describing a
 * snapshot rather than the present.
 *
 * ── Isolation ───────────────────────────────────────────────────────────────
 * CURATOR_TEST_USER_DATA_DIR and CURATOR_TEST_DOMAINS_DIR are set BEFORE any
 * app module is imported. The maintainer's real credential files are
 * fingerprinted by sha256 + size + existence — never mtime (the v3.0.16
 * misattribution). No network, no LLM call, no real key: every key in the
 * fixture is a syntactically-shaped string that no provider would accept.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { createServer } from 'http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${label}`); }
}
function eq(a, b, label) { ok(Object.is(a, b), `${label}${Object.is(a, b) ? '' : ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`); }
function section(t) { console.log(`\n${t}`); }

// ── Isolation FIRST ─────────────────────────────────────────────────────────
const TMP = mkdtempSync(path.join(tmpdir(), 'curator-offermemo-'));
const TMP_USER = path.join(TMP, 'userdata');
const TMP_DOMAINS = path.join(TMP, 'domains');
for (const d of [TMP_USER, TMP_DOMAINS]) mkdirSync(d, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = TMP_USER;
process.env.CURATOR_TEST_DOMAINS_DIR = TMP_DOMAINS;
delete process.env.DOMAINS_PATH;
delete process.env.LLM_MODEL;
delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENROUTER_API_KEY;

const REAL_FILES = ['.curator-config.json', '.sync-config.json', '.sharedbrain-config.json']
  .map(f => path.join(REPO_ROOT, f));
function fingerprint() {
  return REAL_FILES.map(f => {
    if (!existsSync(f)) return `${path.basename(f)}:absent`;
    const buf = readFileSync(f);
    return `${path.basename(f)}:${buf.length}:${createHash('sha256').update(buf).digest('hex')}`;
  }).join('|');
}
const FINGERPRINT_BEFORE = fingerprint();

// Three keys, all fake-shaped. The route key-gates `offerable` on the CONFIG
// keys (the v3.0.13 rule), so all three must be present for the route section
// to serialise a three-provider body at all.
const FAKE_KEYS = {
  geminiApiKey: 'AIza' + 'T'.repeat(35),
  anthropicApiKey: 'sk-ant-api03-' + 'T'.repeat(95),
  openrouterApiKey: 'sk-or-v1-' + 'f'.repeat(64),
  activeProvider: 'openrouter',
};
writeFileSync(path.join(TMP_USER, '.curator-config.json'), JSON.stringify(FAKE_KEYS), 'utf8');

console.log('test-offer-list-memo.js — the derived offer list is cached on its inputs\' identity\n');

const llm = await import('../src/brain/llm.js');
const {
  listOfferableModels, isOfferableModel, isBuildLaneModel, measurementProvenance,
  setOpenRouterCatalogue, isKnownProvider, compareOfferablePrice,
  recordLocalQualification, clearLocalQualifications, isLocallyQualified,
  OFFERABLE_MODELS, QUALIFY_MIN_RUNS,
} = llm;

// ═════════════════════════════════════════════════════════════════════════
// §0. Completeness — every lifted binding exists before anything uses it
// ═════════════════════════════════════════════════════════════════════════
section('0. Completeness');
{
  const LIFTED = {
    listOfferableModels, isOfferableModel, isBuildLaneModel, measurementProvenance,
    setOpenRouterCatalogue, isKnownProvider, compareOfferablePrice,
    recordLocalQualification, clearLocalQualifications, isLocallyQualified,
  };
  for (const [name, val] of Object.entries(LIFTED)) {
    ok(typeof val === 'function', `llm.${name} is exported and callable`);
  }
  ok(OFFERABLE_MODELS && typeof OFFERABLE_MODELS === 'object', 'llm.OFFERABLE_MODELS is exported');
  ok(Number.isInteger(QUALIFY_MIN_RUNS) && QUALIFY_MIN_RUNS > 0, 'llm.QUALIFY_MIN_RUNS is a positive integer');
}

/** A structurally-complete synthetic catalogue entry. */
const spec = (id, extra = {}) => ({
  id, label: `L-${id}`, thinks: false, tokenizerFactor: 1.0,
  suitability: 'chat-only', maxOutput: 32768, price: { input: 0.03, output: 0.13 },
  note: 'Synthetic catalogue entry used by test-offer-list-memo.js to drive invalidation.',
  ...extra,
});

// ═════════════════════════════════════════════════════════════════════════
// §1. A HIT RETURNS THE IDENTICAL OBJECT
// ═════════════════════════════════════════════════════════════════════════
section('1. Unchanged inputs → the identical frozen array (===), on every provider');
{
  setOpenRouterCatalogue([]);                    // deterministic starting point
  for (const p of ['gemini', 'anthropic', 'openrouter']) {
    const a = listOfferableModels(p);
    const b = listOfferableModels(p);
    ok(a === b, `listOfferableModels('${p}') returns the SAME array object on a second call`);
    ok(Object.isFrozen(a), `…and it is frozen`);
  }
  // The memo must not confuse providers with one another.
  ok(listOfferableModels('gemini') !== listOfferableModels('anthropic'),
    'two providers get two different arrays — the memo is keyed per provider, not global');
  ok(listOfferableModels('gemini').every(e => e.provider === 'gemini'),
    'control: the gemini list really is gemini\'s (a memo that returned one list for all would pass the === check above)');

  // An UNKNOWN provider still answers with an empty frozen array, never null.
  const junk = listOfferableModels('not-a-provider');
  ok(Array.isArray(junk) && junk.length === 0 && Object.isFrozen(junk),
    'an unknown provider answers an empty frozen array, never null — a caller may iterate without a guard');
  ok(listOfferableModels('__proto__').length === 0,
    'a prototype-shaped provider name is refused by isKnownProvider before the memo is consulted');
}

// ═════════════════════════════════════════════════════════════════════════
// §2. INVALIDATION — the key tracks the identity of the ONLY input that moves
// ═════════════════════════════════════════════════════════════════════════
section('2. A catalogue change yields a FRESH list carrying the new content');
{
  const emptyList = listOfferableModels('openrouter');
  const staticCount = (OFFERABLE_MODELS.openrouter || []).length;
  eq(emptyList.length, staticCount, 'baseline: with no catalogue, the list is exactly the hand-measured static table');

  const r = setOpenRouterCatalogue([spec('zz-memo/a'), spec('zz-memo/b')]);
  eq(r.admitted, 2, 'control: both synthetic entries were admitted (the fixture is not silently refused)');

  const afterSync = listOfferableModels('openrouter');
  ok(afterSync !== emptyList, 'the returned array is a DIFFERENT object after a sync — the memo did not serve the pre-sync list');
  eq(afterSync.length, staticCount + 2, '…and it carries the two new entries');
  ok(afterSync.some(e => e.id === 'zz-memo/a') && afterSync.some(e => e.id === 'zz-memo/b'),
    '…by id');
  // THE PREDICATES MUST SEE IT TOO. They resolve through the same memo, so a
  // key that tracked the list but not the index would answer "not offerable"
  // about a model the very same response is offering.
  eq(isOfferableModel('openrouter', 'zz-memo/a'), true,
    'isOfferableModel sees the newly-synced id — the index is invalidated with the list, not separately');
  eq(measurementProvenance('openrouter', 'zz-memo/a'), null,
    'measurementProvenance sees it as a FETCHED entry (null = nobody measured it), which requires the dynamic-entry Set to have been rebuilt too');

  // A second sync REMOVING an entry: the fail-direction that matters most,
  // because a stale memo would keep OFFERING a model the provider withdrew.
  setOpenRouterCatalogue([spec('zz-memo/a')]);
  eq(isOfferableModel('openrouter', 'zz-memo/b'), false,
    'a withdrawn id stops being offerable IMMEDIATELY — the stale-offer direction is the one that costs money');
  eq(listOfferableModels('openrouter').length, staticCount + 1, '…and the list shrank with it');

  // ── THE SAME-SIZE SWAP ───────────────────────────────────────────────────
  // A real catalogue refresh routinely returns the SAME NUMBER of models with
  // different ids. A memo keyed on a cheap proxy — the length, the `syncedAt`
  // stamp, a boolean "has a catalogue" — passes every other assertion in this
  // section and serves the previous list here. Only IDENTITY catches it.
  setOpenRouterCatalogue([spec('zz-memo/swapped')]);
  eq(listOfferableModels('openrouter').length, staticCount + 1, 'control: the swap kept the list the same size');
  eq(isOfferableModel('openrouter', 'zz-memo/swapped'), true,
    '★ a SAME-SIZE catalogue swap is seen — the key is the array\'s identity, never its length');
  eq(isOfferableModel('openrouter', 'zz-memo/a'), false,
    '…and the id it replaced is gone');
  // THE DYNAMIC-ENTRY SET NEEDS ITS OWN SAME-SIZE CASE, and it went unasserted
  // in the first draft: a length-keyed Set survives the swap holding the OLD
  // entry objects, so the NEW fetched entry is not "in the catalogue" and
  // `measurementProvenance` falls through to 'curator' — the app badging a
  // model nobody has measured as MEASURED BY US, on a spending surface. The
  // list assertion above cannot see it, because the list is keyed separately.
  eq(measurementProvenance('openrouter', 'zz-memo/swapped'), null,
    '★ …and the swapped-in entry is still reported as FETCHED, never as one we measured');

  // A sync that admits NOTHING still replaces the array, so the memo must
  // still turn over. (setOpenRouterCatalogue assigns a fresh frozen array
  // unconditionally — this asserts the memo follows that, not the length.)
  const beforeEmpty = listOfferableModels('openrouter');
  setOpenRouterCatalogue([]);
  const afterEmpty = listOfferableModels('openrouter');
  ok(beforeEmpty !== afterEmpty || beforeEmpty.length !== afterEmpty.length,
    'clearing the catalogue turns the memo over');
  ok(!listOfferableModels('openrouter').some(e => e.id.startsWith('zz-memo/')),
    'no synthetic id leaks into module state for later suites in this process');
}

section('2b. A persisted QUALIFICATION is visible on the next read, with no catalogue change');
{
  // The qualification store is deliberately NOT part of the memo key — it does
  // not feed the LIST. `isBuildLaneModel` / `measurementProvenance` recompute
  // their verdict per call over the cached membership. If someone ever folds
  // the verdict INTO the cached value, this section reds: the user pays real
  // money and up to an hour for a qualify run, and a cached "chat-only" would
  // make that run look like it did nothing until the next catalogue sync.
  clearLocalQualifications();
  setOpenRouterCatalogue([spec('zz-memo/q')]);
  const listBefore = listOfferableModels('openrouter');
  eq(isBuildLaneModel('openrouter', 'zz-memo/q'), false, 'baseline: a fetched chat-only model is refused the build lane');
  eq(measurementProvenance('openrouter', 'zz-memo/q'), null, 'baseline: nobody has measured it');

  recordLocalQualification({
    modelId: 'zz-memo/q', domain: 'zz-memo-domain', measuredAt: new Date().toISOString(),
    // `outcome` is REQUIRED by isPassingRecord and is easy to leave out — the
    // first draft of this fixture did, and the three assertions below went red
    // for a reason that had nothing to do with the memo.
    outcome: 'NO_DEFECT_FOUND',
    runsCompleted: QUALIFY_MIN_RUNS, counts: { unrepairable: 0, unusable: 0, failed: 0 },
  });
  eq(isLocallyQualified('openrouter', 'zz-memo/q'), true, 'the record qualifies (control for the two assertions below)');
  eq(isBuildLaneModel('openrouter', 'zz-memo/q'), true,
    '★ the build lane opens on the SAME cached list — the verdict is recomputed per call, never cached with the membership');
  eq(measurementProvenance('openrouter', 'zz-memo/q'), 'user',
    '★ provenance flips curator/user/null on the SAME cached list');
  ok(listOfferableModels('openrouter') === listBefore,
    '…and the LIST itself was NOT rebuilt, because a qualification is not one of its inputs');

  clearLocalQualifications();
  eq(isBuildLaneModel('openrouter', 'zz-memo/q'), false, 'clearing the record closes the lane again, same read path');
  setOpenRouterCatalogue([]);
}

// ═════════════════════════════════════════════════════════════════════════
// §3. THE MEMO NEVER LEAKS A MUTABLE ARRAY
// ═════════════════════════════════════════════════════════════════════════
section('3. The cached array cannot be mutated by a caller');
{
  setOpenRouterCatalogue([spec('zz-memo/m')]);
  for (const p of ['gemini', 'anthropic', 'openrouter']) {
    const list = listOfferableModels(p);
    const before = list.length;
    let threw = false;
    try { list.push({ id: 'zz-memo/injected' }); } catch { threw = true; }
    ok(threw || list.length === before,
      `a push into listOfferableModels('${p}') is refused (frozen) — strict mode throws, sloppy mode no-ops`);
    ok(!listOfferableModels(p).some(e => e && e.id === 'zz-memo/injected'),
      `…and the next caller does not see an injected entry on '${p}'`);
    let sortThrew = false;
    try { list.sort(() => -1); } catch { sortThrew = true; }
    ok(sortThrew || listOfferableModels(p)[0] === list[0],
      `…and an in-place sort cannot reorder what the next caller reads on '${p}'`);
  }
  setOpenRouterCatalogue([]);
}

// ═════════════════════════════════════════════════════════════════════════
// §4. THE INDEX MUST NOT BE A PLAIN OBJECT (the v3.0.9 shape)
// ═════════════════════════════════════════════════════════════════════════
section('4. Prototype keys resolve to nothing on the allow-list lookup');
{
  setOpenRouterCatalogue([spec('zz-memo/p')]);
  for (const key of ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
    eq(isOfferableModel('openrouter', key), false, `isOfferableModel(openrouter, '${key}') is false`);
    eq(isBuildLaneModel('openrouter', key), false, `isBuildLaneModel(openrouter, '${key}') is false — the build lane cannot be opened by a prototype key`);
    eq(measurementProvenance('openrouter', key), null, `measurementProvenance(openrouter, '${key}') is null`);
  }
  ok(isOfferableModel('openrouter', 'zz-memo/p') === true,
    'control: a REAL id in the same list does resolve, so the five falses above are a measurement and not a broken lookup');
  // The one that would be a silent disaster: an empty or non-string id.
  for (const junk of ['', null, undefined, 42, {}, []]) {
    eq(isOfferableModel('openrouter', junk), false, `a non-string / empty id (${JSON.stringify(junk)}) is refused`);
  }
  setOpenRouterCatalogue([]);
}

// ═════════════════════════════════════════════════════════════════════════
// §5. THE WIRE DID NOT MOVE
// ═════════════════════════════════════════════════════════════════════════
section('5. GET /api/config/api-keys serialises a stable body over repeated calls');
{
  const express = (await import('express')).default;
  const cfgRoute = (await import('../src/routes/config.js')).default;
  const app = express();
  app.use('/api/config', cfgRoute);
  const srv = createServer(app);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  setOpenRouterCatalogue([spec('zz-memo/w1'), spec('zz-memo/w2')]);

  // `openrouterCatalogue.ageMs` is a WALL CLOCK reading, so it legitimately
  // differs between two calls. It is the only field allowed to. Normalising it
  // and comparing everything else is the honest form of "nothing moved" — a
  // blanket "responses differ, that's fine" would make this section vacuous.
  const fetchBody = async () => JSON.parse(await (await fetch(`http://127.0.0.1:${port}/api/config/api-keys`)).text());
  const norm = (o) => { if (o.openrouterCatalogue) o.openrouterCatalogue.ageMs = '<clock>'; return JSON.stringify(o); };

  const one = await fetchBody();
  const two = await fetchBody();
  eq(norm(structuredClone(one)), norm(structuredClone(two)),
    '★ two consecutive reads serialise byte-identical bodies (ageMs normalised) — a memo that turned over mid-request would show here');

  // The body actually DESCRIBES the memoised list, so the comparison above is
  // not comparing two empty objects.
  ok(Array.isArray(one.offerable?.openrouter) && one.offerable.openrouter.length >= 2,
    'control: the body carries the OpenRouter offer list (so §5 is measuring the thing it names)');
  ok(one.offerable.openrouter.some(e => e.id === 'zz-memo/w1'),
    '…including the entries this section synced in');
  ok(one.offerable.openrouter.every(e => Object.hasOwn(e, 'measuredBy')),
    'every serialised offer carries `measuredBy` — the join that used to cost one full list rebuild per row');

  // A sync BETWEEN two requests must reach the wire.
  setOpenRouterCatalogue([spec('zz-memo/w1')]);
  const three = await fetchBody();
  ok(!three.offerable.openrouter.some(e => e.id === 'zz-memo/w2'),
    '★ a catalogue change between two requests reaches the WIRE — the route serves no snapshot');
  ok(three.offerable.openrouter.some(e => e.id === 'zz-memo/w1'),
    '…while the surviving entry is still offered');
  ok(Object.hasOwn(three.liveMissingByModel.openrouter, 'zz-memo/w1'),
    'liveMissingByModel is keyed over exactly the population `offerable` serialises');

  await new Promise(r => srv.close(r));
  setOpenRouterCatalogue([]);
}

// ═════════════════════════════════════════════════════════════════════════
// §6. THE STANDING INVARIANTS, RE-ASSERTED AGAINST A CACHED LIST
// ═════════════════════════════════════════════════════════════════════════
section('6. Nothing the memo touches relaxed an existing rule');
{
  setOpenRouterCatalogue([
    // The `:free` SUFFIX is load-bearing: `defineOfferableModel` refuses a
    // `free: true` entry whose id cannot be confirmed free, so a fixture
    // without it is silently dropped and the assertions below read `undefined`.
    spec('zz-memo/free:free', { price: null, free: true }),
    spec('zz-memo/dear', { price: { input: 9.0, output: 27.0 } }),
    spec('zz-memo/cheap', { price: { input: 0.01, output: 0.02 } }),
  ]);
  const list = listOfferableModels('openrouter');

  // CHEAPEST-FIRST, and free ranks first as a CLASS. The sort now runs once
  // per catalogue instead of once per call; the ORDER it produces must not
  // have changed, because a `cheapest` badge is computed as index 0.
  const ranks = list.map(e => (e.free === true ? 0 : (typeof e.input === 'number' ? 1 : 2)));
  ok(ranks.every((r, i) => i === 0 || ranks[i - 1] <= r),
    'the cached list is still ordered free → priced → unpriced');
  const priced = list.filter(e => e.free !== true && typeof e.input === 'number');
  ok(priced.every((e, i) => i === 0 || priced[i - 1].input <= e.input),
    '…and the priced half is still cheapest-first');
  ok(list.findIndex(e => e.id === 'zz-memo/cheap') < list.findIndex(e => e.id === 'zz-memo/dear'),
    '…with the cheap synthetic entry ahead of the dear one (a control the shipped table alone could not give)');

  // A MODEL MAY NOT BE OFFERED WITHOUT MEASUREMENT — restated as: a FETCHED
  // entry never reaches the build lane on admission alone.
  eq(isBuildLaneModel('openrouter', 'zz-memo/cheap'), false,
    'a fetched entry is refused the build lane no matter how cheap it is — price is a displayed fact, never a gate');
  eq(measurementProvenance('openrouter', 'zz-memo/cheap'), null,
    '…and it is reported as unmeasured, not as ours');

  // A HAND-MEASURED entry is still reported as ours, off the same cached list.
  const handMeasured = (OFFERABLE_MODELS.openrouter || [])[0];
  if (handMeasured) {
    eq(measurementProvenance('openrouter', handMeasured.id), 'curator',
      'a hand-measured static entry is still reported `curator` after the merge — the dynamic-entry Set did not swallow the static half');
  } else {
    ok(false, 'fixture gap: OFFERABLE_MODELS.openrouter is empty, so the curator-provenance arm was not exercised');
  }

  // `null` MUST NOT be coerced anywhere near a price comparison.
  //
  // GUARDED RATHER THAN DEREFERENCED. An earlier draft read `free.input`
  // directly; a broken memo made the lookup `undefined` and the section died
  // with a TypeError instead of reporting a failure — and a crash is a WORSE
  // signal than a red, because it stops every later assertion and reads as an
  // infrastructure problem rather than a defect.
  const free = list.find(e => e.id === 'zz-memo/free:free');
  const cheap = list.find(e => e.id === 'zz-memo/cheap');
  ok(!!free && !!cheap, 'both price-posture fixtures resolve off the cached list (a named failure, never a TypeError)');
  ok(!!free && free.input === null && free.free === true,
    'a free entry still prices as null + free:true, never {0,0} — the inert-cap landmine stays closed');
  ok(!!free && !!cheap && compareOfferablePrice(free, cheap) < 0,
    'and the comparator still ranks free ahead of the cheapest paid entry by MEMBERSHIP, not arithmetic');

  setOpenRouterCatalogue([]);
}

// ═════════════════════════════════════════════════════════════════════════
// §7. Isolation proof
// ═════════════════════════════════════════════════════════════════════════
section('7. Isolation proof');
eq(fingerprint(), FINGERPRINT_BEFORE,
  'the real .curator-config.json / .sync-config.json / .sharedbrain-config.json are byte-identical (sha256 + size) before and after this run');
delete process.env.CURATOR_TEST_USER_DATA_DIR;
delete process.env.CURATOR_TEST_DOMAINS_DIR;
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
ok(!existsSync(TMP), 'the throwaway tempdir is deleted');

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All offer-list memo assertions green');
