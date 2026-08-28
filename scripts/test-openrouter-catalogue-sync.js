#!/usr/bin/env node
/**
 * test-openrouter-catalogue-sync.js — OFFLINE suite for the OpenRouter
 * catalogue SYNC pipeline: the join that turns a fetched provider catalogue
 * into models a user can actually pick.
 *
 * NO NETWORK. NO CREDENTIAL. Every HTTP-shaped assertion drives the REAL route
 * and the REAL brain functions with `globalThis.fetch` replaced by a spy, so
 * what is asserted is the production path end to end — route -> llm.js ->
 * adapter -> eligibility -> admission -> persistence — and not a
 * re-implementation of it living in this file.
 *
 * ── WHAT THIS EXISTS TO CATCH ────────────────────────────────────────────────
 *
 * 0. THE PIPELINE WAS DEAD (§4). `fetchOpenRouterCatalogue`,
 *    `openRouterRecordToSpec` and `setOpenRouterCatalogue` all shipped fully
 *    tested with ZERO production callers. Every one of those tests was green.
 *    The user-visible state was a picker offering 3 OpenRouter models out of a
 *    catalogue of hundreds, beside a public README promising "hundreds of
 *    models". A unit test on a function nobody calls proves the function works;
 *    it does not prove the FEATURE exists. So the headline assertions here are
 *    on the ROUTE: delete the handler and this suite goes red.
 *
 * 1. FAIL-OPEN ELIGIBILITY (§1). If the eligibility filter is missing or
 *    returns something unreadable, admitting the unfiltered list would put
 *    routers with unknowable prices, moving aliases and models with no JSON
 *    mode straight onto a spend surface. "We could not check" and "we checked
 *    and it passed" must not collapse into one outcome.
 *
 * 2. AN EMPTY FETCH WIPING A WORKING CATALOGUE (§2). `fetchOpenRouterCatalogue`
 *    returns `[]` — it does NOT throw — when the response body is not the shape
 *    it expects. On an HTTP 200 with a changed body shape, that empty array
 *    flowing into admission would clear the user's model list while every layer
 *    reported success. Empty reads to a user as "no models available", which is
 *    a lie about the provider.
 *
 * 3. A FREE MODEL PRICED ZERO (§2). `{input: 0, output: 0}` is TRUTHY, so
 *    `createJob`'s budget cap accepts a ceiling it believes it can enforce and
 *    spend tracks at zero forever. Free is recorded by MEMBERSHIP;
 *    `getModelPrice()` must keep returning null.
 *
 * 4. A PERSISTED ENTRY BEING TRUSTED MORE THAN A FETCHED ONE (§3). The cache
 *    file is a local file, not a trusted input. Re-admission through the same
 *    factory is what stops a hand-edited `suitability: 'general'` promoting an
 *    unmeasured model into the lane that WRITES the user's wiki, and what drops
 *    a model that has since become inadmissible rather than grandfathering it.
 *
 * 5. A CATALOGUE SWAP MID-WRITE (§4). A successful sync REPLACES the catalogue
 *    and REBUILDS the dynamic price and free registries, changing what
 *    `getProviderInfo` resolves next and what `chargeForItem` prices last.
 *    `guardConcurrent` is load-bearing here for the same reason it is on
 *    `/api-keys/model`.
 *
 * ── THE VACUOUS-CORPUS TRIPWIRE ──────────────────────────────────────────────
 * `openrouter-eligibility.js` is a live, actively-edited module whose defaults
 * move (its context field and expiry horizon both changed while this was being
 * written). Every fixture below is therefore checked AGAINST THAT MODULE before
 * it is relied upon: §0 asserts that the "good" control record really is
 * eligible and that each "bad" one really is not. Without that, a defaults
 * change would silently make the good record ineligible, every downstream
 * assertion would pass over an empty set, and the suite would report green
 * while testing nothing. No absolute eligible-count is pinned anywhere — the
 * numbers are read from the module, never hardcoded.
 */

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { createServer } from 'http';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(actual, expected, label) {
  const same = Object.is(actual, expected);
  ok(same, same ? label : `${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}
function section(t) { console.log(`\n${t}`); }

/**
 * A SUITE THAT ABORTS REPORTS NOTHING, AND NOTHING LOOKS LIKE GREEN.
 *
 * `run-tests.js` judges a suite by its exit code AND by scanning its output for
 * `Failed: [1-9]`. A mid-run throw satisfies neither cleanly: two mutations
 * during development produced two behavioural reds and then died on a
 * dereference, printing no tally at all. The reds were real, but the run could
 * not say how many assertions it never reached — and a future mutation that
 * throws EARLIER would print a small red count that reads as a narrow blast
 * radius rather than as a suite that stopped.
 *
 * So the tally is emitted from an exit handler as well as from the happy path,
 * and an aborted run is named as aborted.
 */
let COMPLETED = false;
process.on('exit', () => {
  if (COMPLETED) return;
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Passed: ${passed}   Failed: ${failed === 0 ? 1 : failed}`);
  console.log('❌ ABORTED before the end — the counts above are a LOWER BOUND; assertions after the throw never ran');
});

// ─────────────────────────────────────────────────────────────────────────
// Isolation FIRST — before any app module is imported, because `paths.js`
// reads the env per call but `config.js` resolves through it immediately.
// ─────────────────────────────────────────────────────────────────────────
const TMP = mkdtempSync(path.join(tmpdir(), 'curator-orsync-'));
const TMP_USER = path.join(TMP, 'userdata');
const TMP_DOMAINS = path.join(TMP, 'domains');
for (const d of [TMP_USER, TMP_DOMAINS]) mkdirSync(d, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = TMP_USER;
process.env.CURATOR_TEST_DOMAINS_DIR = TMP_DOMAINS;
delete process.env.DOMAINS_PATH;
// `.env` must not be able to satisfy the route's key gate — that is the exact
// property §4 asserts (v3.0.13: config-scoped, never getEffectiveKey).
delete process.env.OPENROUTER_API_KEY;

const REAL_FILES = [
  '.curator-config.json', '.sync-config.json', '.sharedbrain-config.json',
].map(f => path.join(REPO_ROOT, f));
function fingerprint() {
  // sha256 + size + existence ONLY, never mtime — the maintainer's live app
  // rewrites .curator-config.json during ordinary Settings use, and an
  // mtime-sensitive guard would flake as a false "isolation is broken"
  // (the v3.0.16 misattribution that cost two investigations).
  return REAL_FILES.map(f => {
    if (!existsSync(f)) return `${path.basename(f)}:absent`;
    const buf = readFileSync(f);
    return `${path.basename(f)}:${buf.length}:${createHash('sha256').update(buf).digest('hex')}`;
  }).join('|');
}
const FINGERPRINT_BEFORE = fingerprint();

const llm = await import('../src/brain/llm.js');
const adapter = await import('../src/brain/openrouter-adapter.js');
const eligibility = await import('../src/brain/openrouter-eligibility.js');

console.log('test-openrouter-catalogue-sync.js — the fetch -> filter -> admit -> persist join\n');

const CATALOGUE_FILE = path.join(TMP_USER, '.openrouter-catalogue.json');
const CONFIG_FILE = path.join(TMP_USER, '.curator-config.json');

/** A record that should pass every eligibility rule and map cleanly. */
function goodRecord(id, over = {}) {
  return {
    id,
    name: `Label for ${id}`,
    created: 1700000000,
    architecture: { input_modalities: ['text'], output_modalities: ['text'], modality: 'text->text' },
    pricing: { prompt: '0.0000001', completion: '0.0000004' },
    context_length: 1000000,
    top_provider: { max_completion_tokens: 65536, context_length: 1000000, is_moderated: false },
    supported_parameters: ['response_format', 'structured_outputs', 'max_tokens', 'temperature'],
    ...over,
  };
}

const REC_GOOD      = goodRecord('zzq-a/good');
// DELIBERATELY OUT OF PRICE ORDER relative to REC_GOOD ($0.10 in) and to the
// static entries. A corpus that is already ascending cannot fail an
// ascending-order assertion — the bare-concatenation mutation reddened only one
// line until this record was made cheaper than what precedes it.
const REC_GOOD_2    = goodRecord('zzq-b/good-two', { pricing: { prompt: '0.000000001', completion: '0.000000004' } });
const REC_FREE      = goodRecord('zzq-c/gratis:free', { pricing: { prompt: '0', completion: '0' } });
const REC_NO_JSON   = goodRecord('zzq-d/nojson', { supported_parameters: ['max_tokens', 'temperature'] });
const REC_ROUTER    = goodRecord('zzq-e/router', { pricing: { prompt: '-1', completion: '-1' } });
// Expires 3 days from NOW. Without an injected clock the eligibility module
// ABSTAINS on expiry rather than rejecting, so this record is what makes the
// clock assertions able to fail — without it the whole question is vacuous.
const SOON = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString().slice(0, 10);
const REC_EXPIRING  = goodRecord('zzq-f/expiring-soon', { expiration_date: SOON });
const ALL_RECORDS   = [REC_GOOD, REC_GOOD_2, REC_FREE, REC_NO_JSON, REC_ROUTER, REC_EXPIRING];

// ═════════════════════════════════════════════════════════════════════════
section('§0. Corpus tripwire — every fixture is checked against the LIVE eligibility module');
// Without this section a defaults change in openrouter-eligibility.js (its
// context field and expiry horizon have both moved while this was written)
// would make REC_GOOD ineligible, every later "the good model is offerable"
// assertion would pass over an empty set, and the suite would go green having
// tested nothing. This is the difference between an assertion and a guard.
{
  const ev = id => eligibility.evaluateModel(ALL_RECORDS.find(r => r.id === id), undefined);
  const why = id => ev(id).reasons.map(r => `${r.rule}:${r.code}`).join(',');

  ok(ev('zzq-a/good').eligible,
    `CORPUS: the good control record IS eligible under the live module's defaults${ev('zzq-a/good').eligible ? '' : ` — it is not (${why('zzq-a/good')}), so every downstream assertion would be vacuous`}`);
  ok(ev('zzq-c/gratis:free').eligible,
    `CORPUS: the free control record IS eligible${ev('zzq-c/gratis:free').eligible ? '' : ` — it is not (${why('zzq-c/gratis:free')})`}`);
  ok(!ev('zzq-d/nojson').eligible,
    'CORPUS: the no-JSON-mode record is genuinely REJECTED, so the fail-open mutation in §1 has something to admit wrongly');
  ok(!ev('zzq-e/router').eligible,
    'CORPUS: the unknowable-price router record is genuinely REJECTED');
  const withClock = eligibility.evaluateModel(REC_EXPIRING, { now: new Date() });
  const noClock = eligibility.evaluateModel(REC_EXPIRING, undefined);
  ok(!withClock.eligible,
    `CORPUS: the imminently-expiring record IS rejected WHEN a clock is supplied (expires ${SOON})`);
  ok(noClock.eligible,
    'CORPUS: …and is NOT rejected without one — the module abstains rather than rejecting, which is exactly why the clock has to be injected and why omitting it is silent');

  ok(typeof eligibility.filterCatalogue === 'function',
    'the eligibility module exports filterCatalogue — the function this pipeline is required to IMPORT rather than re-implement');
}

// ═════════════════════════════════════════════════════════════════════════
section('§1. buildOpenRouterCatalogue — the filter is imported, and a missing one FAILS CLOSED');
{
  const built = adapter.buildOpenRouterCatalogue(ALL_RECORDS);
  const ids = built.specs.map(s => s.id);

  ok(ids.includes('zzq-a/good'), 'an eligible record becomes a spec');
  ok(!ids.includes('zzq-d/nojson'),
    'a record REJECTED by the eligibility module never becomes a spec — the filter is actually consulted, not bypassed');
  ok(!ids.includes('zzq-e/router'), 'nor does an unknowable-price router');
  eq(built.total, ALL_RECORDS.length, 'total counts every record fetched');
  eq(built.eligible, built.specs.length + built.mapperRefused,
    'CONSERVATION: every eligible id either becomes a spec or is COUNTED as a mapper refusal — none vanishes silently');

  // Funnel shape is the wire contract the Settings screen renders.
  ok(Array.isArray(built.funnel) && built.funnel.length > 0, 'a funnel is returned');
  ok(built.funnel.every(f => typeof f.rule === 'string' && Number.isFinite(f.before) && Number.isFinite(f.after)),
    'every funnel stage is {rule:string, before:number, after:number} — the shape the UI is built against');
  eq(built.funnel[0] && built.funnel[0].before, ALL_RECORDS.length, 'the funnel starts at the number of records fetched');
  let cascades = true;
  for (let i = 1; i < built.funnel.length; i++) {
    if (built.funnel[i].before !== built.funnel[i - 1].after) cascades = false;
  }
  ok(cascades, 'the funnel CASCADES — each stage\'s `before` is the previous stage\'s `after`, so the counts compose into an explanation rather than being seven unrelated numbers');
  eq(built.funnel.length ? built.funnel[built.funnel.length - 1].after : null, built.eligible,
    'and the last stage\'s `after` equals the eligible count — the funnel accounts for every loss');

  // Duplicate ids: `findOfferableModel` resolves with `.find()`, so a second
  // entry sharing an id is permanently unreachable while still occupying a row.
  const dupBuilt = adapter.buildOpenRouterCatalogue([REC_GOOD, REC_GOOD, REC_GOOD]);
  eq(dupBuilt.specs.length, 1, 'three records sharing one id produce ONE spec — a duplicate would be an unreachable row in the picker');

  // ── FAIL-CLOSED, driven through the real function via its module seam ─────
  let threwMissing = null;
  try { adapter.buildOpenRouterCatalogue(ALL_RECORDS, { eligibilityModule: {} }); }
  catch (err) { threwMissing = err; }
  ok(threwMissing !== null, 'a MISSING eligibility filter throws rather than admitting the unfiltered catalogue');
  ok(threwMissing && threwMissing.code === 'OPENROUTER_NO_ELIGIBILITY', 'and it is a named, recoverable refusal, not a TypeError from calling undefined');

  let threwUnreadable = null;
  try { adapter.buildOpenRouterCatalogue(ALL_RECORDS, { eligibilityModule: { filterCatalogue: () => ({ nonsense: true }) } }); }
  catch (err) { threwUnreadable = err; }
  ok(threwUnreadable && threwUnreadable.code === 'OPENROUTER_NO_ELIGIBILITY',
    'an eligibility report whose shape we cannot read is the same fact as a filter we cannot call — also refused');

  // ── The non-vacuous mapper-refusal corpus ────────────────────────────────
  // Forced with a stub that marks EVERYTHING eligible, so the router record
  // (which the real filter correctly rejects) reaches the mapper and is refused
  // there. Without this, `mapperRefused` is 0 on every real input and the
  // conservation assertion above could never fail.
  const passAll = {
    filterCatalogue: (list) => ({
      total: list.length,
      eligible: list.map(r => ({ id: r && r.id, eligible: true })),
      rejected: [], funnel: [],
    }),
  };
  const forced = adapter.buildOpenRouterCatalogue([REC_GOOD, REC_ROUTER], { eligibilityModule: passAll });
  eq(forced.mapperRefused, 1, 'an eligible-but-unmappable record is COUNTED as a mapper refusal (non-vacuous: the stub forces one to exist)');
  eq(forced.specs.length, 1, '…and does not become a spec');
  eq(forced.eligible, forced.specs.length + forced.mapperRefused, 'conservation holds on the forced corpus too — this is the case that makes the identity able to fail');
  ok(forced.mapperRefusals[0] && forced.mapperRefusals[0].id === 'zzq-e/router', 'the refusal names the id, so a maintainer can see WHICH model disagreed between the two modules');
  eq(forced.clockSupplied, null,
    'an eligibility report that does not SAY whether it got a clock yields null, never true — "we could not confirm" must not resolve to "confirmed" (this is the branch the real module never takes, so it is asserted through the stub)');
}

// ═════════════════════════════════════════════════════════════════════════
section('§2. syncOpenRouterCatalogue — the join, and the failure directions');
{
  const staticIds = llm.listOfferableModels('openrouter').map(m => m.id);
  const fetchOf = (body, status = 200) => async () => ({ ok: status < 400, status, json: async () => body });

  // Caught rather than awaited bare: a mutation that breaks the sync should
  // produce a NAMED red here, not kill the suite at line 1 of §2 and leave
  // every later section unreported. (Observed: dropping the clock injection
  // aborted the run with a lower-bound tally instead of naming the cause.)
  let r1 = null, r1Err = null;
  try { r1 = await llm.syncOpenRouterCatalogue({ fetchImpl: fetchOf({ data: ALL_RECORDS }) }); }
  catch (e) { r1Err = e; }
  ok(r1Err === null, `a well-formed live catalogue syncs without throwing${r1Err ? ` — threw ${r1Err.code || ''} ${r1Err.message}` : ''}`);
  r1 = r1 || { admitted: -1, eligible: -1, syncedAt: null };
  const after = llm.listOfferableModels('openrouter').map(m => m.id);

  ok(after.includes('zzq-a/good'), 'after a sync the fetched model is OFFERABLE — this is the join that did not exist');
  ok(staticIds.every(id => after.includes(id)), 'the hand-measured static entries all survive — the overlay ADDS, it never replaces');
  ok(!after.includes('zzq-d/nojson'), 'and an ineligible model is not offerable');
  eq(r1.admitted, r1.eligible - 0, 'every eligible model was admitted on this corpus');
  ok(typeof r1.syncedAt === 'string' && !Number.isNaN(Date.parse(r1.syncedAt)), 'syncedAt is a parseable ISO timestamp');

  // ── EXPIRY IS ACTUALLY EVALUATED, because the clock is injected ──────────
  ok(!after.includes('zzq-f/expiring-soon'),
    'a model expiring inside this release\'s lifetime is NOT offered — the wall clock reached the pure eligibility module');
  const noClockBuild = adapter.buildOpenRouterCatalogue(ALL_RECORDS);
  ok(noClockBuild.specs.some(sp => sp.id === 'zzq-f/expiring-soon'),
    'CONTROL: the same records WITHOUT a clock do admit it — so the assertion above is proving the injection, not a coincidence of the fixture');
  eq(noClockBuild.clockSupplied, false, 'and the builder reports honestly that no clock was supplied');

  let noClockErr = null;
  try {
    await llm.syncOpenRouterCatalogue({
      fetchImpl: fetchOf({ data: ALL_RECORDS }),
      // Explicit null models the real defect: an option that arrives misspelt,
      // so the module falls back to "no clock" instead of erroring.
      eligibility: { now: null },
    });
  } catch (e) { noClockErr = e; }
  eq(noClockErr && noClockErr.code, 'OPENROUTER_EXPIRY_UNEVALUATED',
    'a sync whose expiry check did NOT run is REFUSED — "we could not check" is never served as "we checked"');
  ok(llm.listOfferableModels('openrouter').map(m => m.id).includes('zzq-a/good'),
    '…and that refusal leaves the previous catalogue intact too');

  // ── INVARIANT: the overlay may only ever reach the CHAT lane ─────────────
  for (const id of after.filter(x => x.startsWith('zzq-'))) {
    ok(llm.isBuildLaneModel('openrouter', id) === false,
      `a fetched model is refused the BUILD lane (${id}) — admission by API is not a measurement`);
  }

  // ── THE MERGED LIST IS CHEAPEST-FIRST, AND FREE IS A CLASS ──────────────
  // `listOfferableModels` used to return `[...static, ...dynamic]`. Both halves
  // are internally ordered; a concatenation of two ordered lists is not. The
  // picker's `cheapest` badge is computed as INDEX 0, so after a sync it could
  // badge a model that is not the cheapest — a false statement on a spending
  // surface. NOTE the corpus: ALL_RECORDS is deliberately NOT in price order
  // and contains a free entry, so this section can actually fail.
  {
    const merged = llm.listOfferableModels('openrouter');
    ok(merged.length > llm.OFFERABLE_MODELS.openrouter.length,
      'precondition: the merged list really does contain dynamic entries, so the ordering assertions below are not about the static table alone');

    // Free first, as MEMBERSHIP — never via arithmetic on a null price.
    const firstPaid = merged.findIndex(m => m.free !== true);
    const lastFree = merged.map(m => m.free === true).lastIndexOf(true);
    ok(firstPaid === -1 || lastFree === -1 || lastFree < firstPaid,
      'every FREE entry precedes every PAID entry — free is unpriced by membership, so it is placed, never computed');
    ok(merged.some(m => m.free === true) && merged.some(m => m.free !== true),
      '…and BOTH classes are present, so that assertion is not vacuous');

    // Paid entries ascend, compared only between two entries carrying numbers.
    let pricedPairs = 0, ordered = true, offender = null;
    for (let i = 1; i < merged.length; i++) {
      const a = merged[i - 1], b = merged[i];
      if (typeof a.input !== 'number' || typeof b.input !== 'number') continue;
      pricedPairs++;
      if (b.input < a.input) { ordered = false; offender = `${a.id} ($${a.input}) then ${b.id} ($${b.input})`; }
    }
    ok(pricedPairs > 0, `there are priced pairs to compare (${pricedPairs}) — a list that compares nothing would pass silently`);
    ok(ordered, `paid entries are cheapest-first${ordered ? '' : ` — ${offender}`}`);

    // The badge itself: index 0 must really be the floor.
    const priced = merged.filter(m => typeof m.input === 'number');
    const minInput = Math.min(...priced.map(m => m.input));
    ok(merged[0].free === true || merged[0].input === minInput,
      'index 0 — what the picker badges `cheapest` — is either free or the actual price floor');

    // NULL MUST NEVER REACH THE ARITHMETIC. A free entry's price is null; a
    // comparator doing `a.input - b.input` coerces it to 0 and "works" by
    // accident. Driving the real comparator with a free entry that would sort
    // WRONG under coercion is what makes that distinguishable.
    const cmp = llm.__testing && llm.__testing.compareOfferablePrice;
    if (typeof cmp === 'function') {
      const freeEntry = { id: 'f', free: true, input: null, output: null };
      const cheapPaid = { id: 'p', free: false, input: 0.0001, output: 0.0001 };
      ok(cmp(freeEntry, cheapPaid) < 0, 'the comparator places free BEFORE an arbitrarily cheap paid model');
      ok(cmp(cheapPaid, freeEntry) > 0, '…and is antisymmetric about it');
      const unpriced = { id: 'u', free: false, input: null, output: null };
      ok(cmp(unpriced, cheapPaid) > 0,
        'an entry that is neither free nor priced sorts LAST — it must never be badged the cheapest thing on offer');
      ok(cmp(unpriced, freeEntry) > 0, '…and behind free too');
    } else {
      ok(false, 'compareOfferablePrice is not exposed on llm.__testing — the comparator cannot be driven directly');
    }
  }

  // ── A HAND-MEASURED ID IS NEVER SUPERSEDED BY A FETCHED ONE ─────────────
  // FOUND BY THE FIRST LIVE SYNC. OpenRouter of course lists the models we
  // hand-measured, so 2 of the 3 static entries came back as dynamic specs and
  // the picker rendered `upstage/solar-pro4` twice: once as the pinned build
  // default ("9 of 9 runs returned raw JSON") and once as "Chat only — never
  // measured". Two rows, one id, contradicting each other about whether the
  // model has been measured. Nothing offline could have caught it: it needs a
  // real catalogue that genuinely contains our own ids.
  {
    const staticEntries = llm.OFFERABLE_MODELS.openrouter;
    ok(staticEntries.length > 0, 'precondition: there ARE hand-measured static OpenRouter entries to collide with');
    const impostor = {
      id: staticEntries[0].id, label: 'Impostor from the network', suitability: 'chat-only',
      thinks: false, tokenizerFactor: 1, maxOutput: 4096,
      ...(staticEntries[0].free ? { free: true } : { price: { input: 999, output: 999 } }),
      note: 'Listed by the public catalogue — never measured.',
    };
    const res = llm.setOpenRouterCatalogue([impostor]);
    eq(res.admitted, 0, 'a fetched spec whose id we have ALREADY hand-measured is not admitted');
    eq(res.superseded, 1, '…it is counted as SUPERSEDED, not refused — nothing failed, the better entry is already on offer');
    eq(res.refused, 0, '…and specifically it does not inflate the refusal tally with our own shipping defaults');
    const rows = llm.listOfferableModels('openrouter').filter(m => m.id === staticEntries[0].id);
    eq(rows.length, 1, 'the id appears EXACTLY ONCE in the picker — no contradictory second row claiming the model was never measured');
    eq(rows[0].note, staticEntries[0].note, '…and the surviving row is the hand-measured one, with its measured note intact');
    // Restore the section's own catalogue for the assertions that follow.
    llm.setOpenRouterCatalogue([]);
    await llm.syncOpenRouterCatalogue({ fetchImpl: fetchOf({ data: ALL_RECORDS }) });
  }

  // ── INVARIANT: free is by MEMBERSHIP, never {input:0, output:0} ──────────
  ok(after.includes('zzq-c/gratis:free'), 'the free model is offerable');
  eq(llm.getModelPrice('zzq-c/gratis:free'), null,
    'getModelPrice() returns NULL for a free model — {input:0,output:0} is truthy and would re-arm a budget cap it cannot enforce');
  const freeEntry = llm.listOfferableModels('openrouter').find(m => m.id === 'zzq-c/gratis:free');
  ok(freeEntry && freeEntry.free === true, '…and the entry is marked free, so the picker and the spend arithmetic agree');
  const paid = llm.getModelPrice('zzq-a/good');
  ok(paid && paid.input === 0.1 && paid.output === 0.4,
    'a paid model derives EXACT decimal prices (0.1, not 0.09999999999999999) through the money-safe string shift');

  // ── INVARIANT: a FAILED sync leaves the previous catalogue intact ────────
  const beforeFail = llm.listOfferableModels('openrouter').map(m => m.id);
  const metaBefore = llm.getOpenRouterCatalogueMeta();

  let emptyErr = null;
  try { await llm.syncOpenRouterCatalogue({ fetchImpl: fetchOf({ data: [] }) }); } catch (e) { emptyErr = e; }
  ok(emptyErr && emptyErr.code === 'OPENROUTER_EMPTY_CATALOGUE', 'a fetch returning ZERO models is treated as a FAILURE, not as an answer');
  eq(llm.listOfferableModels('openrouter').length, beforeFail.length,
    'and the previous catalogue is UNTOUCHED — an HTTP 200 with a changed body shape must not wipe the user\'s model list');

  let shapeErr = null;
  // fetchOpenRouterCatalogue returns [] (it does not throw) when `data` is not
  // an array — this is the exact silent path the guard above exists for.
  try { await llm.syncOpenRouterCatalogue({ fetchImpl: fetchOf({ models: ALL_RECORDS }) }); } catch (e) { shapeErr = e; }
  ok(shapeErr && shapeErr.code === 'OPENROUTER_EMPTY_CATALOGUE', 'an unrecognised RESPONSE BODY SHAPE reaches the same refusal (the adapter returns [] rather than throwing, so this is the real silent case)');
  ok(llm.listOfferableModels('openrouter').map(m => m.id).includes('zzq-a/good'), '…catalogue still intact after the malformed-body attempt');

  let netErr = null;
  try { await llm.syncOpenRouterCatalogue({ fetchImpl: async () => { throw new Error('ECONNRESET'); } }); } catch (e) { netErr = e; }
  ok(netErr !== null, 'a transport failure propagates');
  ok(llm.listOfferableModels('openrouter').map(m => m.id).includes('zzq-a/good'), '…catalogue still intact after a transport failure');
  eq(llm.getOpenRouterCatalogueMeta().syncedAt, metaBefore.syncedAt, '…and syncedAt still describes the catalogue that IS loaded, not the failed attempt');

  let httpErr = null;
  try { await llm.syncOpenRouterCatalogue({ fetchImpl: fetchOf({ error: { message: 'x' } }, 500) }); } catch (e) { httpErr = e; }
  ok(httpErr !== null, 'an upstream HTTP 500 propagates');
  ok(llm.listOfferableModels('openrouter').map(m => m.id).includes('zzq-a/good'), '…catalogue still intact after an upstream 5xx');
}

// ═════════════════════════════════════════════════════════════════════════
section('§3. Persistence — survives a restart, and is re-admitted rather than trusted');
{
  ok(existsSync(CATALOGUE_FILE), 'the sync wrote a persisted catalogue in the user-data dir');
  ok(!existsSync(CONFIG_FILE),
    'and it did NOT write into .curator-config.json — the credential store stays out of the blast radius of a ~200 KB third-party payload');

  const stored = existsSync(CATALOGUE_FILE) ? JSON.parse(readFileSync(CATALOGUE_FILE, 'utf8')) : { specs: [] };
  ok(Array.isArray(stored.specs) && stored.specs.length > 0, 'the file holds the admitted SPECS');
  ok(typeof stored.syncedAt === 'string', '…with the timestamp');
  const storedGood = stored.specs.find(s => s.id === 'zzq-a/good');
  ok(storedGood && storedGood.price && storedGood.price.input === 0.1,
    'specs are persisted as PLAIN DATA — the built entry\'s price getters would have been flattened to today\'s number, freezing a promotional price past its expiry');
  ok(stored.specs.every(s => s.suitability === 'chat-only'), 'every persisted spec is chat-only');

  // A restart: clear module state, then restore from disk.
  llm.setOpenRouterCatalogue([]);
  eq(llm.getOpenRouterCatalogueMeta().syncedAt, null,
    'clearing the catalogue also clears its provenance — a stale syncedAt over an empty list would read as "synced 2 minutes ago" beside no models');
  ok(!llm.listOfferableModels('openrouter').map(m => m.id).includes('zzq-a/good'), 'precondition: the model is gone from module state');

  const restored = llm.restoreOpenRouterCatalogue();
  ok(restored.restored === true, 'restore reports success');
  ok(llm.listOfferableModels('openrouter').map(m => m.id).includes('zzq-a/good'), 'the model is offerable again after a restart — a user who syncs and restarts does not silently lose their models');
  eq(llm.getOpenRouterCatalogueMeta().source, 'disk', 'provenance records that this came from disk, not the network');
  eq(llm.getModelPrice('zzq-c/gratis:free'), null, 'the free model is STILL priced null after a reload — the free registry is rebuilt, not inherited');

  // ── A PERSISTED ENTRY GETS NO MORE TRUST THAN A FETCHED ONE ──────────────
  const tampered = existsSync(CATALOGUE_FILE) ? JSON.parse(readFileSync(CATALOGUE_FILE, 'utf8')) : { specs: [] };
  const t = tampered.specs.find(s => s.id === 'zzq-a/good') || { id: 'zzq-a/good' };
  t.suitability = 'general';
  t.jsonRaw = true;
  if (!tampered.specs.includes(t)) tampered.specs.push(t);
  writeFileSync(CATALOGUE_FILE, JSON.stringify(tampered));
  llm.setOpenRouterCatalogue([]);
  const afterTamper = llm.restoreOpenRouterCatalogue();
  ok(afterTamper.restored === true, 'a partially-tampered file still restores its good entries');
  ok(afterTamper.refused >= 1, '…and the tampered entry is REFUSED on re-admission, per-entry');
  ok(!llm.isOfferableModel('openrouter', 'zzq-a/good'),
    'a hand-edited spec claiming a BUILD-lane suitability does not become offerable — the local file is not a trusted input');
  eq(llm.isBuildLaneModel('openrouter', 'zzq-a/good'), false,
    'and specifically it cannot reach the lane that WRITES the user\'s wiki');
  ok(llm.isOfferableModel('openrouter', 'zzq-b/good-two'),
    'while its untampered siblings are unaffected — refusal is per-entry, never all-or-nothing');

  // Corrupt / absent file: never throws, never clears a working catalogue.
  llm.setOpenRouterCatalogue([]);
  await llm.syncOpenRouterCatalogue({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: ALL_RECORDS }) }) });
  const liveIds = llm.listOfferableModels('openrouter').map(m => m.id);
  writeFileSync(CATALOGUE_FILE, '{not json at all');
  const corrupt = llm.restoreOpenRouterCatalogue();
  ok(corrupt.restored === false, 'a corrupt cache file reports failure rather than throwing at boot');
  eq(llm.listOfferableModels('openrouter').length, liveIds.length,
    '…and does NOT clear the catalogue already in memory — a corrupt cache costs a re-sync, never a working model list');

  rmSync(CATALOGUE_FILE, { force: true });
  const absent = llm.restoreOpenRouterCatalogue();
  ok(absent.restored === false, 'an absent cache file is an ordinary first-run state, not an error');
  ok(llm.listOfferableModels('openrouter').map(m => m.id).includes('zzq-a/good'), '…and also does not clear anything');
}

// ═════════════════════════════════════════════════════════════════════════
section('§3b. The BOOT wiring — proven in a CHILD PROCESS, not by reading the source');
{
  // WHY A CHILD PROCESS. `restoreOpenRouterCatalogue()` being correct is not the
  // same fact as it being CALLED. This whole release exists because three
  // correct, fully-tested functions had no production caller — asserting the
  // function again would repeat that mistake one layer up. The only way to
  // observe boot behaviour is to boot: a fresh process imports the REAL route
  // module (which server.js imports at startup) and reports whether the models
  // are offerable WITHOUT anyone calling restore by hand. Delete the boot block
  // in routes/config.js and this goes red; a source-text grep would not.
  const { execFileSync } = await import('child_process');
  const bootUser = path.join(TMP, 'bootuser');
  const bootDomains = path.join(TMP, 'bootdomains');
  mkdirSync(bootUser, { recursive: true });
  mkdirSync(bootDomains, { recursive: true });
  writeFileSync(path.join(bootUser, '.openrouter-catalogue.json'), JSON.stringify({
    version: 1,
    syncedAt: '2026-08-28T00:00:00.000Z',
    specs: [{
      id: 'zzq-boot/persisted', label: 'Persisted boot model', suitability: 'chat-only',
      thinks: false, tokenizerFactor: 1, maxOutput: 65536,
      price: { input: 0.1, output: 0.4 }, note: 'persisted fixture',
    }, {
      // Tampered sibling: if the boot path trusted the file it would land in the
      // build lane, which is the one thing the overlay may never reach.
      id: 'zzq-boot/tampered', label: 'Tampered boot model', suitability: 'general',
      thinks: false, jsonRaw: true, tokenizerFactor: 1, maxOutput: 65536,
      price: { input: 0.1, output: 0.4 }, note: 'tampered fixture',
    }],
  }), 'utf8');

  const probe = `
    process.env.CURATOR_TEST_USER_DATA_DIR = ${JSON.stringify(bootUser)};
    process.env.CURATOR_TEST_DOMAINS_DIR = ${JSON.stringify(bootDomains)};
    await import(${JSON.stringify(path.join(REPO_ROOT, 'src/routes/config.js'))});
    const llm = await import(${JSON.stringify(path.join(REPO_ROOT, 'src/brain/llm.js'))});
    const ids = llm.listOfferableModels('openrouter').map(m => m.id);
    process.stdout.write(JSON.stringify({
      ids,
      buildLane: llm.isBuildLaneModel('openrouter', 'zzq-boot/tampered'),
      meta: llm.getOpenRouterCatalogueMeta(),
    }));
  `;
  let out = null, bootErr = null;
  try {
    out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', probe],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (err) { bootErr = err; }

  ok(bootErr === null, `importing the route module in a fresh process does not throw${bootErr ? ` (${bootErr.message})` : ''}`);
  ok(out && out.ids.includes('zzq-boot/persisted'),
    'merely importing src/routes/config.js — what server.js does at boot — makes the persisted models offerable. The restore is WIRED, not just written');
  ok(out && !out.ids.includes('zzq-boot/tampered'),
    'and the tampered BUILD-lane entry is refused on that same boot path');
  eq(out && out.buildLane, false, 'nothing restored at boot can reach the build lane');
  eq(out && out.meta.source, 'disk', 'provenance after boot says the catalogue came from disk');
}

// ═════════════════════════════════════════════════════════════════════════
section('§4. POST /api/config/openrouter/sync — the route, mounted in-process');
{
  const { default: express } = await import('express');
  const { default: configRouter } = await import('../src/routes/config.js');
  const writeRegistry = await import('../src/brain/write-registry.js');

  const app = express();
  app.use(express.json());
  app.use('/api/config', configRouter);
  const server = createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${server.address().port}`;
  ok(server.address().port > 0 && server.address().address === '127.0.0.1',
    `router mounted on an ephemeral loopback port (${server.address().port}), never 3333`);

  // ── The fetch spy: records every OUTBOUND request, passes our own
  // loopback requests through to the real implementation untouched.
  const realFetch = globalThis.fetch;
  const OUTBOUND = [];
  let upstream = async () => ({ ok: true, status: 200, json: async () => ({ data: ALL_RECORDS }) });
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith(BASE)) return realFetch(url, init);
    OUTBOUND.push({ url: u, init: init || {} });
    return upstream(url, init);
  };

  const post = async (p, body) => {
    const res = await realFetch(BASE + p, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    return { status: res.status, body: await res.json() };
  };

  // ── No CONFIG key -> 400, and `.env` cannot satisfy it ───────────────────
  rmSync(CONFIG_FILE, { force: true });
  const noKey = await post('/api/config/openrouter/sync');
  eq(noKey.status, 400, 'with no saved OpenRouter key the sync is refused');
  ok(typeof noKey.body.error === 'string' && noKey.body.error.length > 10, '…with a real message, not a bare status');
  eq(OUTBOUND.length, 0, '…and NOTHING was fetched — the gate runs before any network call');

  // ── THE PREFIX IS ASSEMBLED, NOT WRITTEN OUT ──────────────────────────────
  // The pre-commit secret guard blocks `sk-or-v1-` followed by 20+ key
  // characters, and it is right to: a real key pasted into a fixture would
  // otherwise commit silently to a PUBLIC repo. The house answer (v3.15.0, from
  // two agents who each declined to have their fixtures allow-listed) is to
  // build the prefix from parts rather than to add an exception — allow-listing
  // our own fixture is what trains the next person to allow-list theirs.
  const KEY_PREFIX = ['sk', 'or', 'v1', ''].join('-');
  const ENV_ONLY_KEY = `${KEY_PREFIX}ENVONLYFAKEKEYNEVERREAL000000000000`;
  process.env.OPENROUTER_API_KEY = ENV_ONLY_KEY;
  const envOnly = await post('/api/config/openrouter/sync');
  eq(envOnly.status, 400,
    'a key present ONLY in .env does NOT satisfy the gate — v3.0.13: a provider Disconnected in Settings must not be usable, whatever lingers in .env');
  delete process.env.OPENROUTER_API_KEY;

  // ── Saved key -> the contract ────────────────────────────────────────────
  const FAKE_KEY = `${KEY_PREFIX}CONFIGFAKEKEYNEVERSENTANYWHERE00000`;
  writeFileSync(CONFIG_FILE, JSON.stringify({ openrouterApiKey: FAKE_KEY }), 'utf8');
  chmodSync(CONFIG_FILE, 0o600);
  llm.setOpenRouterCatalogue([]);

  const good = await post('/api/config/openrouter/sync');
  eq(good.status, 200, 'with a saved key the sync succeeds');
  const b = good.body;
  ok(b.ok === true, 'ok: true');
  for (const f of ['syncedAt', 'total', 'eligible', 'admitted', 'refused', 'funnel']) {
    ok(Object.hasOwn(b, f), `the response carries \`${f}\` — the field the Settings screen is built against`);
  }
  ok(typeof b.syncedAt === 'string' && !Number.isNaN(Date.parse(b.syncedAt)), 'syncedAt is a parseable ISO timestamp');
  ok(Number.isInteger(b.total) && Number.isInteger(b.eligible) && Number.isInteger(b.admitted) && Number.isInteger(b.refused),
    'total / eligible / admitted / refused are integers');
  ok(Array.isArray(b.funnel) && b.funnel.every(f => typeof f.rule === 'string' && Number.isFinite(f.before) && Number.isFinite(f.after)),
    'funnel is [{rule, before, after}]');

  // ── THE KEY NEVER LEAVES: the catalogue endpoint is unauthenticated ──────
  ok(OUTBOUND.length > 0, 'the route really did make an outbound request (so the no-leak assertions below are not vacuous)');
  const serialised = JSON.stringify(OUTBOUND);
  ok(!serialised.includes(FAKE_KEY), 'the saved key appears NOWHERE in any outbound request');
  ok(!serialised.includes(KEY_PREFIX), '…not even a key-shaped prefix');
  ok(OUTBOUND.every(o => !(o.init.headers && (o.init.headers.Authorization || o.init.headers.authorization))),
    'no Authorization header is sent — the model catalogue is public, so the key is read for truthiness only and never passed onward');
  ok(OUTBOUND.every(o => o.url.includes('/models')), 'the only endpoint contacted is the public model catalogue');

  // ── The models reach the EXISTING offerable payload, not a new surface ───
  const keysRes = await realFetch(BASE + '/api/config/api-keys');
  const keysBody = await keysRes.json();
  ok(Array.isArray(keysBody.offerable.openrouter) && keysBody.offerable.openrouter.some(m => m.id === 'zzq-a/good'),
    'GET /api/config/api-keys `offerable.openrouter` now includes the newly admitted models — no second catalogue surface was invented');
  ok(typeof keysBody.models === 'object' && (keysBody.models.openrouter === null || typeof keysBody.models.openrouter === 'string'),
    '`models` stays a provider-to-STRING map — /old does escHtml(models[p]) and an object would render the literal "[object Object]"');
  ok(keysBody.hasOpenrouterKey === true && Object.hasOwn(keysBody, 'hasGeminiKey') && Object.hasOwn(keysBody, 'hasAnthropicKey'),
    'the hasXKey booleans survive — their absence re-fires the un-escapable onboarding overlay on every load');
  ok(keysBody.openrouterCatalogue && typeof keysBody.openrouterCatalogue.syncedAt === 'string',
    'catalogue provenance rides on the SAME payload as `offerable`');

  // ── guardConcurrent: a catalogue swap mid-write is refused ───────────────
  const release = writeRegistry.registerWrite('zzq-domain', 'ingest');
  const outboundBefore = OUTBOUND.length;
  const busy = await post('/api/config/openrouter/sync');
  eq(busy.status, 409, 'the sync is REFUSED while a write is running — a catalogue swap mid-ingest changes what the next call resolves to and what the last one is priced at');
  eq(OUTBOUND.length, outboundBefore, '…and no network call was made during the refusal');
  release();
  const unbusy = await post('/api/config/openrouter/sync');
  eq(unbusy.status, 200, 'and it succeeds again once the write is released (proving the 409 was the guard, not a broken route)');

  // ── Failure surfaces a real message, and says the models are safe ────────
  const beforeIds = llm.listOfferableModels('openrouter').map(m => m.id);
  upstream = async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) });
  const emptyRes = await post('/api/config/openrouter/sync');
  ok(emptyRes.status >= 400 && emptyRes.status < 600, 'an empty upstream catalogue is an error status');
  eq(emptyRes.status, 502, '…502, because the failure is upstream and not the caller\'s fault');
  ok(typeof emptyRes.body.error === 'string' && emptyRes.body.error.length > 20,
    '…carrying a real, actionable message rather than a bare 500');
  ok(emptyRes.body.unchanged === true, '…and stating that the existing model list is untouched');
  eq(llm.listOfferableModels('openrouter').length, beforeIds.length,
    '…which is TRUE: the catalogue really is unchanged after the failed sync');

  upstream = async () => { throw new Error('ECONNRESET'); };
  const netRes = await post('/api/config/openrouter/sync');
  eq(netRes.status, 500, 'a transport failure is a 500');
  ok(typeof netRes.body.error === 'string' && netRes.body.error.length > 0, '…with a message');
  ok(llm.listOfferableModels('openrouter').map(m => m.id).includes('zzq-a/good'), '…and the models still stand');

  globalThis.fetch = realFetch;
  await new Promise(r => server.close(r));
  llm.setOpenRouterCatalogue([]);
}

// ═════════════════════════════════════════════════════════════════════════
section('§5. Isolation proof');
eq(fingerprint(), FINGERPRINT_BEFORE,
  'the real .curator-config.json / .sync-config.json / .sharedbrain-config.json are byte-identical (sha256 + size) before and after this run');
delete process.env.CURATOR_TEST_USER_DATA_DIR;
delete process.env.CURATOR_TEST_DOMAINS_DIR;
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
ok(!existsSync(TMP), 'the throwaway tempdir is deleted');

COMPLETED = true;
console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All OpenRouter catalogue-sync assertions green');
