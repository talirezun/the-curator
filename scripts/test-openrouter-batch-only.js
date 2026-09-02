#!/usr/bin/env node
/**
 * Offline test for the `not_batch_only` eligibility rule, driven at CATALOGUE
 * SCALE through the REAL pipeline.
 *
 * Run:  node scripts/test-openrouter-batch-only.js
 * Exit: 0 if all green. No network, no API key, no clock read (the clock is
 *       injected), no user-data path touched.
 *
 * ── WHY THIS SUITE EXISTS AS A SEPARATE FILE ────────────────────────────────
 *
 * Every existing OpenRouter suite runs against a hand-cut fixture of 26 records
 * (eligibility) or 6 (sync). Production runs against ~421. The defect this rule
 * fixes lived in exactly that gap, and so did the earlier "cheapest badge on a
 * non-cheapest model" defect: both are properties of the WHOLE list — how many
 * dead rows there are, and where they land once sorted — and neither is visible
 * in a corpus small enough to read.
 *
 * So this file pins a real snapshot and runs the four real stages over it:
 *
 *   filterCatalogue → buildOpenRouterCatalogue → setOpenRouterCatalogue
 *                   → listOfferableModels
 *
 * Nothing is re-implemented here. The only thing this file constructs is the
 * COUNTERFACTUAL arm (§4), and it is built by wrapping the real filter rather
 * than by copying it.
 *
 * ── THE FIXTURE ─────────────────────────────────────────────────────────────
 *
 * `scripts/test-fixtures/openrouter-catalogue-2026-09-02.json` — all 421
 * records of a live `GET /api/v1/models` response, fetched 2026-09-02, in the
 * API's own order, reduced to the fields the two consumers read (`id`, `name`,
 * `created`, `context_length`, `architecture.output_modalities`, `pricing`,
 * `top_provider`, `supported_parameters`, `expiration_date`, `reasoning`,
 * `alias_target`). `description` and `benchmarks` alone are ~420 KB and neither
 * is read; §0 proves the reduction is not load-bearing by asserting the funnel
 * still has every stage live.
 *
 * ⚠ THIS FIXTURE IS A SNAPSHOT, AND ABSOLUTE LIVE COUNTS ARE NOT ASSERTED
 * ANYWHERE ABOUT THE LIVE CATALOGUE. The numbers below are properties OF THE
 * FIXTURE — reproducible forever, because the file is pinned. What they are
 * evidence FOR is the shape of the defect on a real catalogue; they are not a
 * prediction about OpenRouter's roadmap.
 *
 * ── THE MEASURED DEFECT (this fixture, clock injected at 2026-09-02T00:00Z) ──
 *
 *   BEFORE (rule absent):  421 → 219 eligible → 217 specs → 213 admitted
 *                              → 218 picker rows, 57 of them `:batch`
 *   AFTER  (rule present): 421 → 162 eligible → 160 specs → 156 admitted
 *                              → 161 picker rows, 0 of them `:batch`
 *
 * Every one of those deltas is 57, and 57 is the number of `:batch` records
 * that pass every OTHER rule. That identity is what §4 asserts — not the
 * literals, which are asserted separately in §5 so a drift in either shows up
 * as a different failure from a break in the reasoning.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  filterCatalogue,
  evaluateModel,
  checkNotBatchOnly,
  REASON_CODES,
  RULE_ORDER,
} from '../src/brain/openrouter-eligibility.js';
import { buildOpenRouterCatalogue } from '../src/brain/openrouter-adapter.js';
import { setOpenRouterCatalogue, listOfferableModels } from '../src/brain/llm.js';

let passed = 0, failed = 0;
const failures = [];
function ok(cond, label) {
  cond ? (passed++, console.log(`  ✓ ${label}`)) : (failed++, failures.push(label), console.log(`  ✗ ${label}`));
}
function section(t) { console.log(`\n${t}`); }

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'test-fixtures', 'openrouter-catalogue-2026-09-02.json');
const RECORDS = JSON.parse(readFileSync(FIXTURE, 'utf8')).data;

/** Injected so the expiry rule is LIVE — the shipped default cannot reject without one. */
const SNAPSHOT_DAY = new Date('2026-09-02T00:00:00Z');
const OPTS = { now: SNAPSHOT_DAY };

const isBatchId = id => /:batch$/.test(String(id));
/**
 * SEPARATE from `isBatchId` on purpose. `RECORDS.filter(isBatchId)` compiles,
 * runs, and returns an EMPTY array — `String(record)` is "[object Object]" —
 * so every "no :batch record does X" assertion downstream would pass
 * vacuously. That happened while writing this file and was caught only because
 * a neighbouring count disagreed; the two names now make the mistake unspellable.
 */
const isBatchRecord = r => isBatchId(r && r.id);
const byId = id => RECORDS.find(r => r.id === id);
/** The rule a record is ATTRIBUTED to by the cascade: its first failure in RULE_ORDER. */
const firstFailingRule = ev => RULE_ORDER.find(rule => ev.reasons.some(x => x.rule === rule)) || null;

// ─────────────────────────────────────────────────────────────────────────────
section('0. Fixture integrity — the corpus can actually exercise this rule');
// Without these, every "no :batch reaches the picker" assertion below would be
// satisfied vacuously by a corpus containing no :batch record at all.
// ─────────────────────────────────────────────────────────────────────────────

ok(Array.isArray(RECORDS) && RECORDS.length === 421,
  `the pinned snapshot carries 421 records (got ${RECORDS.length})`);
const batchRecords = RECORDS.filter(isBatchRecord);
ok(batchRecords.length === 66,
  `⟨POSITIVE CONTROL⟩ the snapshot contains 66 :batch records (got ${batchRecords.length})`);
ok(RECORDS.some(r => /:free$/.test(String(r.id))),
  '⟨POSITIVE CONTROL⟩ …and at least one :free id, so "only :batch is refused" is a real distinction');
ok(batchRecords.every(r => RECORDS.some(x => x.id === String(r.id).replace(/:batch$/, ''))),
  '⟨POSITIVE CONTROL⟩ every :batch record has its usable twin present in the same snapshot');

// The reduction must not have removed anything load-bearing. If it had, stages
// would go quiet — so assert every stage that should reject still does.
const run = filterCatalogue(RECORDS, OPTS);
const stage = name => run.funnel.find(f => f.rule === name);
for (const name of RULE_ORDER) {
  if (name === 'text_output') continue; // opt-in, off by default — asserted below instead
  ok(stage(name) && stage(name).lost > 0,
    `⟨NON-VACUITY⟩ stage ${name} still rejects at least one record on the REDUCED fixture`);
}
ok(stage('text_output').lost === 0,
  '…and text_output, which is opt-in and off by default, rejects none');

// ─────────────────────────────────────────────────────────────────────────────
section('1. The paired control — the :batch record is refused, its TWIN is not');
// A rule that rejected both would be worse than the defect it fixes: it would
// hide a working model. This is the assertion that says the rule is surgical.
// ─────────────────────────────────────────────────────────────────────────────

const BATCH_ID = 'google/gemini-2.5-flash-lite:batch';
const TWIN_ID = 'google/gemini-2.5-flash-lite';
const batchRec = byId(BATCH_ID);
const twinRec = byId(TWIN_ID);
ok(!!batchRec && !!twinRec, 'both halves of the pair are in the fixture, verbatim');

// The pair differs in EXACTLY three fields — this is why no capability rule
// catches it, and it is asserted rather than asserted-in-prose.
const differing = [...new Set([...Object.keys(batchRec), ...Object.keys(twinRec)])]
  .filter(k => JSON.stringify(batchRec[k]) !== JSON.stringify(twinRec[k])).sort();
ok(JSON.stringify(differing) === JSON.stringify(['id', 'name', 'pricing']),
  `the pair differs in exactly id, name and pricing (got ${JSON.stringify(differing)})`);
ok(Number(batchRec.pricing.prompt) < Number(twinRec.pricing.prompt),
  '…and the batch variant is CHEAPER, which is why cheapest-first floats it to the top');

const evBatch = evaluateModel(batchRec, OPTS);
const evTwin = evaluateModel(twinRec, OPTS);
ok(evBatch.eligible === false, 'the :batch record is INELIGIBLE');
ok(evTwin.eligible === true, '⟨PAIRED CONTROL⟩ its twin is ELIGIBLE — the rule does not hide a working model');
ok(evBatch.reasons.length > 0 && evBatch.reasons.every(r => r.rule === 'not_batch_only'),
  '…and the batch record fails ONLY not_batch_only — no other rule is doing the work');
ok(evBatch.reasons.every(r => r.code === REASON_CODES.BATCH_ONLY_ENDPOINT),
  '…with the BATCH_ONLY_ENDPOINT code on every one of them');
ok(evBatch.facts.batchOnly.idSuffix === true && evBatch.facts.batchOnly.nameSuffix === true,
  'both signals are reported as facts on the real record');
ok(evTwin.facts.batchOnly.idSuffix === false && evTwin.facts.batchOnly.nameSuffix === false,
  '…and neither fires on the twin');

// ─────────────────────────────────────────────────────────────────────────────
section('2. The two signals are independent, and neither over-reaches');
// ─────────────────────────────────────────────────────────────────────────────

const idOnly = checkNotBatchOnly({ id: 'vendor/model:batch', name: 'Vendor: Model' });
ok(idOnly.pass === false && idOnly.facts.idSuffix === true && idOnly.facts.nameSuffix === false,
  'the id suffix rejects ALONE, with no marker in the name');
ok(idOnly.reasons.length === 1 && idOnly.reasons[0].detail.signal === 'id-suffix',
  '…reporting exactly which signal fired');

const nameOnly = checkNotBatchOnly({ id: 'vendor/model-b', name: 'Vendor: Model (batch)' });
ok(nameOnly.pass === false && nameOnly.facts.nameSuffix === true && nameOnly.facts.idSuffix === false,
  'the name suffix rejects ALONE — the cross-check is not decorative');
ok(nameOnly.reasons.length === 1 && nameOnly.reasons[0].detail.signal === 'name-suffix',
  '…reporting exactly which signal fired');

ok(checkNotBatchOnly({ id: 'vendor/model:free', name: 'Vendor: Model (free)' }).pass === true,
  ':free is NOT refused — the marker is the exact segment `batch`, not a colon');
ok(checkNotBatchOnly({ id: 'vendor/model:batch-preview', name: 'V: M' }).pass === true,
  ':batch-preview is NOT refused — the id match is anchored to the end of the segment');
ok(checkNotBatchOnly({ id: 'vendor/batch-model', name: 'Batch Model' }).pass === true,
  'a model merely NAMED for batching is not refused — the name match needs the trailing "(batch)"');
ok(checkNotBatchOnly({ id: 'v/m', name: 'V: M (batch) preview' }).pass === true,
  '…and "(batch)" mid-name does not fire either');
ok(checkNotBatchOnly({ id: 'v/m', name: 'V: M (BATCH)' }).pass === false,
  'the name match is case-insensitive');
ok(checkNotBatchOnly({ id: 'v/m', name: 'V: M (batch)  ' }).pass === false,
  '…and tolerates trailing whitespace, which the catalogue has elsewhere');
ok(checkNotBatchOnly(null).pass === true && checkNotBatchOnly({}).pass === true,
  'a malformed or empty record does not reject HERE — RECORD_MALFORMED is evaluateModel\'s job');

// ─────────────────────────────────────────────────────────────────────────────
section('3. On the full snapshot the rule catches every :batch id and nothing else');
// ─────────────────────────────────────────────────────────────────────────────

const batchStage = stage('not_batch_only');
// NAMED, not assumed. Deleting `not_batch_only` from RULE_ORDER leaves `stage()`
// returning undefined, and every assertion below then dies on a bare property
// read — a RED for the wrong reason, which this repo has recorded as its own
// recurring shape. Asserted first so that mutation reports itself in words.
ok(!!batchStage, 'the funnel HAS a not_batch_only stage — the rule is in RULE_ORDER at all');
const SAFE_STAGE = batchStage || { lost: -1, lostIds: [] };
ok(SAFE_STAGE.lostIds.every(isBatchId),
  'every id attributed to the not_batch_only stage is a :batch id — no collateral');
ok(batchRecords.length > 0 && batchRecords.every(r => evaluateModel(r, OPTS).eligible === false),
  'no :batch record anywhere in the snapshot survives as eligible');
ok(run.eligible.length > 0 && run.eligible.every(ev => !isBatchId(ev.id)),
  '…stated the other way round, from the eligible set');
// The stage loses 64 rather than 66 because the cascade attributes to the FIRST
// failing rule and two :batch records already fail an earlier one. Asserted so
// the two numbers can never be read as a discrepancy.
ok(SAFE_STAGE.lost === 64,
  `the stage itself loses 64 (got ${SAFE_STAGE.lost}) — 2 of the 66 fail an EARLIER rule and are attributed there`);
const batchIdx = RULE_ORDER.indexOf('not_batch_only');
const attributedEarlier = batchRecords.filter(r =>
  RULE_ORDER.indexOf(firstFailingRule(evaluateModel(r, OPTS))) < batchIdx);
ok(attributedEarlier.length === 2 && SAFE_STAGE.lost + attributedEarlier.length === batchRecords.length,
  `…and exactly 2 :batch records are attributed to an EARLIER rule (both fail json_mode), so 64 + 2 = ${batchRecords.length}`);
ok(attributedEarlier.every(r => firstFailingRule(evaluateModel(r, OPTS)) === 'json_mode'),
  '…naming that earlier rule rather than leaving it as "some other rule"');

// ─────────────────────────────────────────────────────────────────────────────
section('4. THE COUNTERFACTUAL — the whole pipeline, with and without the rule');
// The "before" arm is built by WRAPPING the real filter and re-admitting every
// model whose ONLY rejections came from this rule. It is therefore the real
// module minus one rule, not a second implementation of eligibility.
// ─────────────────────────────────────────────────────────────────────────────

const ruleAbsent = {
  filterCatalogue(records, opts) {
    const report = filterCatalogue(records, opts);
    const readmit = report.rejected.filter(ev =>
      ev.reasons.length > 0 && ev.reasons.every(r => r.rule === 'not_batch_only'));
    const readmitted = new Set(readmit);
    return {
      ...report,
      eligible: [...report.eligible, ...readmit],
      rejected: report.rejected.filter(ev => !readmitted.has(ev)),
    };
  },
};

/** Drive all four real stages and report what the picker would show. */
function pipeline(eligibilityModule) {
  const built = buildOpenRouterCatalogue(RECORDS, {
    eligibility: OPTS,
    ...(eligibilityModule ? { eligibilityModule } : {}),
  });
  // setOpenRouterCatalogue reports per-entry refusals on stderr; silence them so
  // a 400-record run does not bury the assertions. Restored immediately.
  const realError = console.error;
  console.error = () => {};
  let admitted;
  try { admitted = setOpenRouterCatalogue(built.specs); } finally { console.error = realError; }
  const rows = listOfferableModels('openrouter');
  return {
    eligible: built.eligible,
    specs: built.specs.length,
    admitted: admitted.admitted,
    rows: rows.length,
    batchRows: rows.filter(r => isBatchId(r.id)).length,
    ids: rows.map(r => r.id),
  };
}

const before = pipeline(ruleAbsent);
const after = pipeline(null);
console.log(`     BEFORE  eligible ${before.eligible} · specs ${before.specs} · admitted ${before.admitted} · rows ${before.rows} (${before.batchRows} batch)`);
console.log(`     AFTER   eligible ${after.eligible} · specs ${after.specs} · admitted ${after.admitted} · rows ${after.rows} (${after.batchRows} batch)`);

ok(before.batchRows > 0,
  `⟨POSITIVE CONTROL⟩ without the rule, :batch rows DO reach the picker (${before.batchRows}) — the "after" assertion is not vacuous`);
ok(after.batchRows === 0, 'WITH the rule, ZERO :batch ids reach the picker');

// The identity the whole fix rests on: the drop at every layer is exactly the
// number of :batch records that passed every OTHER rule.
const eligibleBatch = before.eligible - after.eligible;
// Counted independently of the pipeline: a :batch record "passes every other
// rule" exactly when its ONLY reasons come from this one.
const passEveryOtherRule = batchRecords.filter(r => {
  const rs = evaluateModel(r, OPTS).reasons;
  return rs.length > 0 && rs.every(x => x.rule === 'not_batch_only');
}).length;
ok(passEveryOtherRule > 0 && eligibleBatch === passEveryOtherRule,
  `the eligible count drops by EXACTLY the number of :batch records that pass every other rule (${passEveryOtherRule})`);
ok(before.eligible - after.eligible === eligibleBatch
  && before.specs - after.specs === eligibleBatch
  && before.admitted - after.admitted === eligibleBatch
  && before.rows - after.rows === eligibleBatch,
  `…and the SAME number is lost at every layer — eligible, specs, admitted and picker rows (${eligibleBatch})`);
ok(before.batchRows === eligibleBatch,
  '…which is also exactly how many dead rows the picker was showing');

// Nothing that is not a :batch id may differ between the two arms.
const removed = before.ids.filter(id => !after.ids.includes(id));
const added = after.ids.filter(id => !before.ids.includes(id));
ok(added.length === 0, 'the rule ADDS no row to the picker');
ok(removed.length === eligibleBatch && removed.every(isBatchId),
  'every row the rule removes is a :batch id, and no other row moves out');
ok(after.ids.includes(TWIN_ID),
  `⟨PAIRED CONTROL⟩ the twin ${TWIN_ID} is still in the picker after the rule runs`);

// The severity claim, measured rather than asserted: half price + cheapest-first
// put dead rows near the TOP, which is where a user looks first.
const firstBatchPos = before.ids.findIndex(isBatchId);
const batchInTop40 = before.ids.slice(0, 40).filter(isBatchId).length;
console.log(`     BEFORE: first :batch row at position ${firstBatchPos + 1}; ${batchInTop40} of the top 40 are dead`);
ok(firstBatchPos >= 0 && firstBatchPos < 20,
  `the first dead row sat inside the first 20 of the cheapest-first list (position ${firstBatchPos + 1})`);
ok(batchInTop40 > 0, '…and the top 40 contained dead rows');

// ─────────────────────────────────────────────────────────────────────────────
section('5. The pinned figures, so a drift shows up as its own failure');
// Separate from §4 on purpose: §4 asserts the REASONING (the deltas agree), this
// asserts the MEASUREMENT. A change that breaks one and not the other is a
// different fault from a change that breaks both.
// ─────────────────────────────────────────────────────────────────────────────

// ── RE-MEASURED AT v3.45.0, AND THE MOVE IS THE CONTEXT FLOOR, NOT THIS RULE ─
// Every figure here rose when the single 200,000 context floor was replaced by a
// per-lane pair (admission 32,768 / build 131,072). More records clear the gate,
// so more records reach this rule — INCLUDING three more `:batch` ids, which is
// why the dead-row count is 60 rather than 57. The batch rule itself is
// unchanged, and §4 above still proves the SAME number is lost at every layer,
// which is the reasoning; these are the readings taken on 2026-09-02.
ok(before.eligible === 278 && after.eligible === 218,
  `eligible 278 → 218 on this snapshot (got ${before.eligible} → ${after.eligible})`);
ok(before.rows === 276 && after.rows === 216,
  `picker rows 276 → 216 on this snapshot (got ${before.rows} → ${after.rows})`);
ok(eligibleBatch === 60, `60 dead rows removed (got ${eligibleBatch})`);

console.log('\n────────────────────────────────────────────────────────────');
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('All batch-only eligibility assertions green.');
