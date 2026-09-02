#!/usr/bin/env node
/**
 * test-qualify-record-guard.js — OFFLINE proof that a SHORT model test can no
 * longer destroy a LONG one.
 *
 * Run:  node scripts/test-qualify-record-guard.js
 * Exit: 0 if all green, 1 on any failure. No network, no API key, no spend, no
 *       server. Every user-data path is redirected to a tempdir before any app
 *       module is imported.
 *
 * ── THE DEFECT (R5 of the 2026-09-02 router audit) ──────────────────────────
 *
 * `POST /api/config/openrouter/qualify` accepts a `runs` field and clamps it to
 * `[1, QUALIFY_DEFAULT_RUNS]`. The qualification store keeps exactly ONE record
 * per model id (`_localQualifications.set`). And `isPassingRecord` requires
 * `runsCompleted >= QUALIFY_MIN_RUNS`, which is 9.
 *
 * So `{"model": "…", "runs": 3}` spent real money on a measurement that could
 * never qualify anything AND overwrote a stored 9-run pass — silently demoting
 * a model out of the build lane. The user paid twice: once for the nine runs,
 * once for the three that erased them.
 *
 * ── WHY THE FIX IS A STORE GUARD AND NOT A 400 ON SHORT RUNS ────────────────
 *
 * Both were available. Refusing `runs < QUALIFY_MIN_RUNS` would contradict the
 * contract the feature is built on, which `src/brain/openrouter-qualify.js`
 * states in its own words: *"FEWER RUNS ARE RECORDED BUT QUALIFY NOTHING. A
 * 2-run record is a real measurement of something … and is displayed honestly
 * with its run count; it simply does not satisfy `isPassingRecord`."* §1 below
 * asserts that sentence is still in the module, so this suite reds if the
 * contract it reasoned from is ever changed underneath it.
 *
 * The rule shipped instead is one sentence: **a stored PASSING record is never
 * replaced by one with FEWER completed runs.** Stated in RUN COUNTS rather than
 * in outcomes, so a full-length run reporting a DEFECT still lands (§4) —
 * demotion on real evidence has to stay possible, or the guard would protect a
 * model from being found broken.
 *
 * ── WHAT IS DRIVEN, AND WHAT IS NOT ─────────────────────────────────────────
 *
 * DRIVEN FOR REAL: `storeQualification` from `src/routes/config.js`, against the
 * REAL `llm.js` store, the REAL `isPassingRecord`, and the REAL
 * `isLocallyQualified` build-lane gate — so every assertion is about what a user
 * would see next, not about a copy of the rule written here.
 *
 * NOT DRIVEN: the HTTP round trip. Reaching the handler needs a live OpenRouter
 * key and up to an hour of real model calls, so no request is made and the SSE
 * `stored` frame is never observed. §5 closes that gap STRUCTURALLY instead: the
 * handler's only store call is `storeQualification`, and
 * `recordLocalQualification` appears nowhere else in the routes file — so there
 * is no second door back to the unguarded store. That is a claim about the call
 * graph, which is what a source scan can honestly support; it is not a claim
 * that the frame was seen.
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// ── ISOLATION FIRST, BEFORE ANY MODULE THAT READS USER DATA ────────────────
// Both variables, never just the domains one: `CURATOR_TEST_DOMAINS_DIR` alone
// leaves the process resolving the REAL `.curator-config.json`, and with it the
// real API keys. Set before the dynamic imports below.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'curator-qualguard-'));
process.env.CURATOR_TEST_USER_DATA_DIR = TMP;
process.env.CURATOR_TEST_DOMAINS_DIR = path.join(TMP, 'domains');
fs.mkdirSync(process.env.CURATOR_TEST_DOMAINS_DIR, { recursive: true });
fs.writeFileSync(
  path.join(TMP, '.curator-config.json'),
  JSON.stringify({ openrouterApiKey: 'k'.repeat(40), activeProvider: 'openrouter' }),
  { mode: 0o600 },
);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

// ── THE REAL CREDENTIAL FILES ARE FINGERPRINTED, NOT TRUSTED ───────────────
// sha256 + size + existence only. NEVER mtime: the maintainer's live app
// rewrites config during an ordinary Settings action, and an mtime comparison
// turns that into a false "isolation is broken" — the v3.0.16 misattribution.
const GUARDED = ['.curator-config.json', '.sync-config.json', '.sharedbrain-config.json', '.env'];
function fingerprint() {
  const out = {};
  for (const f of GUARDED) {
    const p = path.join(ROOT, f);
    try {
      const buf = fs.readFileSync(p);
      out[f] = createHash('sha256').update(buf).digest('hex') + ':' + buf.length;
    } catch { out[f] = 'absent'; }
  }
  return out;
}
const FP_BEFORE = fingerprint();

const llm = await import('../src/brain/llm.js');
const cfgRoute = await import('../src/routes/config.js');
const qualify = await import('../src/brain/openrouter-qualify.js');

const { storeQualification } = cfgRoute;
const { QUALIFY_MIN_RUNS, isPassingRecord } = llm;

let passed = 0, failed = 0;
const failures = [];
function ok(cond, label) {
  cond ? (passed++, console.log(`  ✓ ${label}`)) : (failed++, failures.push(label), console.log(`  ✗ ${label}`));
}
function section(t) { console.log(`\n${t}`); }

const MODEL = 'z-ai/glm-4.7';
const spec = (id, over = {}) => Object.assign({
  id, label: id, suitability: 'chat-only', maxOutput: 131072, contextWindow: 204800,
  thinks: false, tokenizerFactor: 1, note: 'admitted from the live catalogue',
  price: { input: 0.5, output: 2 },
}, over);
/** A clean, PASSING nine-run record unless overridden. */
const record = (over = {}) => Object.assign({
  version: 1, provider: 'openrouter', modelId: MODEL, domain: 'articles',
  measuredAt: '2026-09-02T10:00:00.000Z', outcome: 'NO_DEFECT_FOUND',
  runsCompleted: 9, runsAttempted: 9,
  counts: { raw: 9, repaired: 0, unrepairable: 0, unusable: 0, notMeasured: 0, failed: 0 },
  aborted: null, cancelled: false,
}, over);
const shortRecord = (n, over = {}) => record(Object.assign({
  runsCompleted: n, runsAttempted: n,
  counts: { raw: n, repaired: 0, unrepairable: 0, unusable: 0, notMeasured: 0, failed: 0 },
}, over));

/** Put the model in the catalogue so the build-lane gate can actually fire. */
function reset() {
  llm.clearLocalQualifications();
  llm.setOpenRouterCatalogue([spec(MODEL)]);
}

// ─────────────────────────────────────────────────────────────────────────────
section('0. The premises this whole file reasons from');
// Each of these was true when the fix was written. If one stops being true the
// fix is arguing from something that is no longer there, and this suite says so
// rather than continuing to pass over a changed contract.
// ─────────────────────────────────────────────────────────────────────────────

ok(QUALIFY_MIN_RUNS === 9, `QUALIFY_MIN_RUNS is 9 (got ${QUALIFY_MIN_RUNS})`);
ok(typeof storeQualification === 'function',
  'routes/config.js exports storeQualification — the decision is reachable without an HTTP round trip');
reset();
ok(isPassingRecord(record()) === true,
  'CONTROL: a clean 9-run record passes, so "a passing record is protected" is not vacuous');
ok(isPassingRecord(shortRecord(3)) === false,
  `CONTROL: a 3-run record does NOT pass — it can never qualify anything, whatever it measured`);
ok(qualify.QUALIFY_DEFAULT_RUNS >= QUALIFY_MIN_RUNS,
  'the default run count is at least the qualifying minimum, so the ordinary path is unaffected by this guard');

// The contract the fix chose NOT to break. Read out of the module rather than
// paraphrased, so a rewording there reds this rather than silently invalidating
// the argument in this file's header.
{
  const src = fs.readFileSync(path.join(ROOT, 'src/brain/openrouter-qualify.js'), 'utf8');
  ok(/FEWER RUNS ARE RECORDED BUT QUALIFY NOTHING/.test(src),
    'openrouter-qualify.js still states "FEWER RUNS ARE RECORDED BUT QUALIFY NOTHING" — the reason a 400 was refused');
  ok(!/xxx-this-string-is-not-in-the-module/.test(src),
    'CONTROL: …and the same scan can report an absence, so the assertion above is a real read');
}

// ─────────────────────────────────────────────────────────────────────────────
section('1. THE DEFECT — a short test must not erase a long one');
// ─────────────────────────────────────────────────────────────────────────────

reset();
storeQualification(record());
ok(llm.isLocallyQualified('openrouter', MODEL) === true,
  'CONTROL: after a clean 9-run test the model IS in the build lane');
ok(llm.getLocalQualification(MODEL).runsCompleted === 9,
  'CONTROL: …and the stored record is the 9-run one');

const refused = storeQualification(shortRecord(3));
ok(refused && refused.stored === false,
  'a 3-run result is NOT stored over the 9-run pass');
ok(refused && refused.keptExisting === true && refused.existingRuns === 9,
  '…and the refusal says WHAT was kept, rather than reporting a bare false');
ok(typeof refused.reason === 'string' && /9-run/.test(refused.reason) && /3-run/.test(refused.reason),
  `…naming both counts, so the caller can act on it ("${refused && refused.reason}")`);
ok(new RegExp(String(QUALIFY_MIN_RUNS) + '-run test').test(refused.reason),
  '…and telling the caller the run count that WOULD change the stored result, derived from QUALIFY_MIN_RUNS');

// THE CONSEQUENCE, which is the part that actually mattered.
ok(llm.getLocalQualification(MODEL).runsCompleted === 9,
  'the STORE still holds the 9-run record — the evidence the user paid for survives');
ok(isPassingRecord(llm.getLocalQualification(MODEL)) === true,
  '…it still passes');
ok(llm.isLocallyQualified('openrouter', MODEL) === true,
  '…and the model is STILL in the build lane, which is what a user would have lost');

// ─────────────────────────────────────────────────────────────────────────────
section('2. …and the guard is narrow — it protects a pass, not the store');
// A guard that refused every replacement would be worse than the defect: it
// would freeze the first result a model ever recorded.
// ─────────────────────────────────────────────────────────────────────────────

reset();
const firstShort = storeQualification(shortRecord(3));
ok(firstShort && firstShort.stored === true,
  'with NOTHING stored, a 3-run result IS recorded — the "short runs are recorded" contract is intact');
ok(llm.getLocalQualification(MODEL).runsCompleted === 3,
  '…and it is what the store now holds');
ok(llm.isLocallyQualified('openrouter', MODEL) === false,
  '…while still qualifying nothing, exactly as before');

const shorterOverShort = storeQualification(shortRecord(2));
ok(shorterOverShort && shorterOverShort.stored === true,
  'a 2-run result replaces a 3-run one when the stored record does NOT pass — nothing worth protecting is there');
ok(llm.getLocalQualification(MODEL).runsCompleted === 2, '…and the store follows');

reset();
storeQualification(shortRecord(3));
const promote = storeQualification(record());
ok(promote && promote.stored === true, 'a full 9-run pass replaces a short record');
ok(llm.isLocallyQualified('openrouter', MODEL) === true, '…and promotes the model into the build lane');

// ─────────────────────────────────────────────────────────────────────────────
section('3. A LATER PASS still replaces an earlier one');
// Same length, newer evidence. Blocking this would pin a stale measurement.
// ─────────────────────────────────────────────────────────────────────────────

reset();
storeQualification(record({ measuredAt: '2026-09-01T00:00:00.000Z' }));
const newer = storeQualification(record({ measuredAt: '2026-09-02T00:00:00.000Z' }));
ok(newer && newer.stored === true, 'a second 9-run pass is stored');
ok(llm.getLocalQualification(MODEL).measuredAt === '2026-09-02T00:00:00.000Z',
  '…and the store holds the NEWER measurement, not the first one');

// A LONGER run over a pass, in case the cap is ever raised.
reset();
storeQualification(record());
const longer = storeQualification(record({ runsCompleted: 12, runsAttempted: 12,
  counts: { raw: 12, repaired: 0, unrepairable: 0, unusable: 0, notMeasured: 0, failed: 0 } }));
ok(longer && longer.stored === true && llm.getLocalQualification(MODEL).runsCompleted === 12,
  'a LONGER run replaces a passing one — the rule is "fewer", not "different"');

// ─────────────────────────────────────────────────────────────────────────────
section('4. DEMOTION ON REAL EVIDENCE IS STILL POSSIBLE');
// This is the arm that decides between "fewer runs" and "does not pass" as the
// rule. Written in outcomes, a 9-run DEFECT report would be refused, and the
// guard would be protecting a model from being found broken — inverting the
// asymmetry the whole feature rests on.
// ─────────────────────────────────────────────────────────────────────────────

reset();
storeQualification(record());
ok(llm.isLocallyQualified('openrouter', MODEL) === true, 'CONTROL: qualified first');
const defect = storeQualification(record({
  outcome: 'DEFECT_OBSERVED',
  counts: { raw: 0, repaired: 0, unrepairable: 9, unusable: 0, notMeasured: 0, failed: 0 },
}));
ok(defect && defect.stored === true,
  'a FULL-LENGTH run that finds a defect IS stored over a pass');
ok(llm.isLocallyQualified('openrouter', MODEL) === false,
  '…and demotes the model out of the build lane, which is the point');

// A short run that finds a defect is still refused: three runs cannot establish
// a defect any more than they can establish a pass, and the stored evidence is
// longer.
reset();
storeQualification(record());
const shortDefect = storeQualification(shortRecord(3, {
  outcome: 'DEFECT_OBSERVED',
  counts: { raw: 0, repaired: 0, unrepairable: 3, unusable: 0, notMeasured: 0, failed: 0 },
}));
ok(shortDefect && shortDefect.stored === false,
  'a SHORT run that finds a defect is refused too — the rule is about run count, so it cuts both ways');
ok(llm.isLocallyQualified('openrouter', MODEL) === true,
  '…and the model keeps its lane, because nothing longer has contradicted the pass');

// ── Degenerate inputs never reach the store as a silent success ────────────
reset();
storeQualification(record());
for (const bad of [null, undefined, {}, { modelId: MODEL }, { modelId: MODEL, runsCompleted: 'nine' }]) {
  const r = storeQualification(bad);
  ok(r && r.stored === false,
    `a malformed record (${JSON.stringify(bad)}) is refused rather than stored`);
}
ok(llm.getLocalQualification(MODEL).runsCompleted === 9,
  '…and none of them disturbed the stored pass');

// A record for a DIFFERENT model is unaffected by this model's stored pass.
reset();
storeQualification(record());
const other = storeQualification(shortRecord(3, { modelId: 'zz/other-model' }));
ok(other && other.stored === true,
  'a short record for a DIFFERENT model still stores — the guard is per model id, not global');
ok(llm.getLocalQualification(MODEL).runsCompleted === 9,
  '…and the protected model is untouched');

// ─────────────────────────────────────────────────────────────────────────────
section('5. THERE IS NO SECOND DOOR — the routes file has one store call');
// STRUCTURAL, and labelled as such: no HTTP request is made anywhere in this
// file, so this is a claim about the call graph rather than about a served
// response. It is the part a source scan can honestly support.
// ─────────────────────────────────────────────────────────────────────────────

{
  const { stripComments, functionSource, callSiteCount } =
    await import('./test-helpers/source-scan.js');
  const raw = fs.readFileSync(path.join(ROOT, 'src/routes/config.js'), 'utf8');
  const src = stripComments(raw);

  const directCalls = (src.match(/llmModule\.recordLocalQualification\s*\(/g) || []).length;
  ok(directCalls === 1,
    `\`recordLocalQualification\` is called exactly once in routes/config.js (${directCalls}) — inside the guard`);
  const guardBody = stripComments(functionSource(raw, 'storeQualification') || '');
  ok(/llmModule\.recordLocalQualification\s*\(/.test(guardBody),
    '…and that one call site is INSIDE storeQualification, not beside it');
  ok(callSiteCount(raw, 'storeQualification') >= 1,
    'CONTROL: the scanner can find calls to storeQualification, so the counts above are real reads');
  ok(!/xxNoSuchFunctionxx\s*\(/.test(src),
    'CONTROL: …and reports zero for a name that is not there');

  // The guard actually reads the two things it claims to.
  ok(/getLocalQualification/.test(guardBody) && /isPassingRecord/.test(guardBody),
    'storeQualification reads the EXISTING record and the REAL pass predicate — it does not re-derive either');
  ok(/runsCompleted/.test(guardBody),
    '…and compares run counts, which is what makes the demotion arm in §4 reachable');
}

// ─────────────────────────────────────────────────────────────────────────────
section('6. Isolation held');
// ─────────────────────────────────────────────────────────────────────────────

const FP_AFTER = fingerprint();
for (const f of GUARDED) {
  ok(FP_BEFORE[f] === FP_AFTER[f], `the real ${f} is byte-identical before and after (${FP_AFTER[f].slice(0, 16)}…)`);
}
ok(fs.existsSync(path.join(TMP, '.curator-config.json')),
  'CONTROL: the ISOLATED config exists, so the fingerprints above are not comparing four absences');

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }

console.log('\n────────────────────────────────────────────────────────────');
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('All qualification-record guard assertions green.');
process.exit(0);
