/**
 * test-next-cost-honesty.js — OFFLINE suite for three COST-HONESTY defects.
 *
 * No network, no API key, no server, no browser, no spend.
 *
 * This app's stated principle is that every token-spending action shows its
 * cost before it runs, and this project has already shipped a budget cap that
 * was completely inert while reporting that it was working (v3.3.0). A number
 * that misstates money is a first-class defect here, so each of the three is
 * driven BEHAVIOURALLY against the real functions, in both directions.
 *
 * ── WHAT THIS SUITE ACTUALLY COVERS ─────────────────────────────────────
 *
 * DEFECT 1 — a cancelled/failed batch item's spend was never counted, while
 * `spendIsEstimated: false` asserted the total was measured.
 *
 *   DEFECT 1b, found by a later audit and fixed here: the single flag then
 *   meant TWO CONTRADICTORY THINGS. `chargeForItem`'s unpriced-model branch
 *   charges a share of `estimate.usdHigh` — which is NOT a bound and was
 *   measured at 66.8% of actual on Anthropic, i.e. it can read ~50% ABOVE
 *   real spend — while `chargePartialSpend` charges a MEASURED but
 *   incomplete total. Both set one flag, and both consumers then lied about
 *   one of the two cases: /next's readout rendered `at least $X` for an
 *   estimate share (a floor that does not exist), and the budget-pause
 *   message called a measured partial "estimated, not measured". Split into
 *   `spendIsEstimated` (approx.) and `spendIsLowerBound` (at least), with
 *   the renderer's precedence EXECUTED over all four combinations (§6) and
 *   a CLASS invariant that every spend flag reaches toWire's allow-list —
 *   because deleting that one line was the single mutation of this fix that
 *   nothing caught.
 *   COVERED behaviourally (§2, §3): `chargePartialSpend` executed from the
 *     REAL src/brain/ingest-queue.js module surface (__testing), on measured
 *     usage, on zero-call usage, on an unpriced model, and on junk; and the
 *     measured/estimated flag in every one of those cases.
 *   COVERED behaviourally (§4): `makeUsageAccumulator`'s new `forward` seam
 *     from the REAL src/brain/ingest.js — including that a THROWING observer
 *     cannot break accumulation, which is the property that keeps bookkeeping
 *     from failing an ingest.
 *   COVERED as source guards, stated as such (§5): that all three non-return
 *     settle paths in processItemInner call chargePartialSpend, that the
 *     accumulator is declared where the catch can reach it, and that
 *     `onUsage` is actually passed to the ingest call.
 *   NOT COVERED: a real end-to-end cancelled ingest against a live provider.
 *     That costs real money; the seam is proven here offline instead, and the
 *     wiring is proven by source guard. Stated, not implied.
 *
 * DEFECT 2 — a paid action rendered `$0.0000`.
 *   COVERED behaviourally (§1): formatUsdHonest across the full range, with
 *     an explicit sweep proving NO non-zero input can render as `$0.0000`,
 *     and that every value which already rendered correctly is unchanged
 *     byte-for-byte from the old formatter.
 *   COVERED behaviourally (§1): domains.js's own formatUsd + costReadout,
 *     extracted from the real source, so the fix is proven at the call site
 *     the defect was reported against and not only in the shared module.
 *   COVERED as source guards (§6): both import sites, and that neither view
 *     has re-grown a local `toFixed(4)` dollar formatter.
 *   NOT FIXED, and asserted as a KNOWN GAP (§6): formatUsdRange and
 *     computeQueueSpentLabel in shared/ingest-queue-logic.js carry the same
 *     defect and are byte-pinned to the frozen shipping bundle. The suite
 *     pins that they are STILL DEFECTIVE, so the day the pin is lifted this
 *     assertion fails and points at them rather than the gap being forgotten.
 *
 * DEFECT 3 — a completed, PAID semantic-duplicate scan was discarded by one
 * rail click, forcing a re-scan and a second charge.
 *   COVERED behaviourally (§7): disarmSemanticScan and
 *     shouldKeepSemanticScanOnReload from the real domains.js — the paid pair
 *     list survives a same-domain remount, the previewed set is EMPTY after
 *     it (raw read, not "a later check refuses"), and a domain change does
 *     NOT keep it. Both directions.
 *   COVERED behaviourally (§7): resetDomainScopedHealthState, so the
 *     keepSemanticScan opt-in is proven to be the thing that spares the scan.
 *   COVERED as source guards (§8): the teardown no longer nulls the scan, and
 *     the re-entry call site passes the guarded flag.
 *   NOT COVERED: rendering, and the real browser click path. Browser-only.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { formatUsdHonest } from '../src/public/next/shared/format-usd.js';
import { __testing as queueTesting } from '../src/brain/ingest-queue.js';
import { makeUsageAccumulator } from '../src/brain/ingest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const DOMAINS_PATH = path.join(ROOT, 'src/public/next/views/domains.js');
const INGEST_VIEW_PATH = path.join(ROOT, 'src/public/next/views/ingest.js');
const QUEUE_PATH = path.join(ROOT, 'src/brain/ingest-queue.js');
const BRAIN_INGEST_PATH = path.join(ROOT, 'src/brain/ingest.js');
const SHARED_LOGIC_PATH = path.join(ROOT, 'src/public/next/shared/ingest-queue-logic.js');

const domainsSrc = readFileSync(DOMAINS_PATH, 'utf8');
const ingestViewSrc = readFileSync(INGEST_VIEW_PATH, 'utf8');
const queueSrc = readFileSync(QUEUE_PATH, 'utf8');
const brainIngestSrc = readFileSync(BRAIN_INGEST_PATH, 'utf8');
const sharedLogicSrc = readFileSync(SHARED_LOGIC_PATH, 'utf8');

// ── Comment stripping for the source guards ─────────────────────────────
// Every source guard below has to run against CODE. These files' own
// comments QUOTE the strings being asserted (this fix's comments say
// "$0.0000" and "state.semanticScan = null" while explaining why they are
// gone), so a guard run against raw text would be reading a comment — this
// repo's named failure shape, "a check that stopped reaching the thing it
// protects".
//
// ORDER IS LOAD-BEARING: whole-line // comments go FIRST. These files
// contain `/*` and `*/` inside line comments (regex snippets, doc prose);
// strip blocks first and one of those opens a fake block comment that runs
// on until the next `*/`, swallowing real code. assertStrippedSane is the
// tripwire for exactly that.
function stripComments(src) {
  return src
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}
function assertStrippedSane(stripped, label, mustContain) {
  for (const needle of mustContain) {
    if (!stripped.includes(needle)) {
      throw new Error(`stripComments over-reached on ${label}: "${needle}" is gone from the stripped code`);
    }
  }
  return stripped;
}

// STRUCTURAL anchors only. Deliberately disjoint from anything an assertion
// below also checks: a sanity anchor that overlaps an assertion makes the
// mutation for that assertion throw before a single test runs, which is a
// red for the wrong reason and proves nothing (mutation-found lesson,
// recorded in test-next-onboarding.js's own §anchors comment).
const domainsCode = assertStrippedSane(stripComments(domainsSrc), 'domains.js', [
  'function resetDomainScopedHealthState(opts) {',
  'function costReadout(est,',
  'registerView(\'domains\', {',
]);
const ingestViewCode = assertStrippedSane(stripComments(ingestViewSrc), 'views/ingest.js', [
  'function renderQueueDoneSummary(job) {',
]);
const queueCode = assertStrippedSane(stripComments(queueSrc), 'ingest-queue.js', [
  'function chargeForItem(job, item) {',
  'async function processItemInner(jobId, itemIdx, ingestFileImpl) {',
]);
const brainIngestCode = assertStrippedSane(stripComments(brainIngestSrc), 'brain/ingest.js', [
  'export function makeUsageAccumulator(',
]);
const sharedLogicCode = assertStrippedSane(stripComments(sharedLogicSrc), 'ingest-queue-logic.js', [
  'function formatUsdRange(',
  'function computeQueueSpentLabel(',
]);

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(actual, expected, label) {
  ok(actual === expected, `${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}
function section(t) { console.log(`\n${t}`); }

// ── Extract functions from the real source ──────────────────────────────
// Brace-matched so nested braces in a body cannot truncate the extraction.
// A missing name THROWS rather than silently testing nothing.
function extractFunction(src, name, label = 'source') {
  const marker = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ${name}\\s*\\(`);
  const m = marker.exec(src);
  if (!m) throw new Error(`extractFunction: "${name}" not found in ${label}`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);

  // Skip the PARAMETER LIST before hunting for the body brace — a
  // destructured parameter (`{ compact = false } = {}`) would otherwise
  // latch the brace matcher onto the parameter pattern and "end" the
  // function at the closing paren. costReadout has exactly that shape.
  let p = src.indexOf('(', start);
  if (p === -1) throw new Error(`extractFunction: "${name}" has no parameter list`);
  let parenDepth = 0;
  for (; p < src.length; p++) {
    if (src[p] === '(') parenDepth++;
    else if (src[p] === ')') { parenDepth--; if (parenDepth === 0) { p++; break; } }
  }
  let i = src.indexOf('{', p);
  if (i === -1) throw new Error(`extractFunction: "${name}" has no body`);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const extracted = src.slice(start, i);
  // Desync tripwire: a truncated extraction must fail LOUDLY here rather
  // than later as a confusing SyntaxError out of new Function().
  if (!/\n\}$/.test(extracted)) {
    throw new Error(`extractFunction: "${name}" extraction does not end at a top-level closing brace — the matcher desynced`);
  }
  return extracted;
}

// ── The domains.js sandbox ──────────────────────────────────────────────
// The four functions under test are pure or touch only `state`, so they run
// standalone. formatUsdHonest is injected because the real module imports
// it — injecting the REAL one (not a stub) is what makes §1's call-site
// assertions mean anything.
const DOMAINS_FNS = [
  'formatUsd',
  'costReadout',
  'resetDomainScopedHealthState',
  'disarmSemanticScan',
  'shouldKeepSemanticScanOnReload',
];

let domainsSandbox;
try {
  domainsSandbox = new Function(
    'formatUsdHonest',
    'let state = {};\n' +
    DOMAINS_FNS.map((n) => extractFunction(domainsSrc, n, 'domains.js')).join('\n\n') + '\n' +
    `return { ${DOMAINS_FNS.join(', ')},
       __state: () => state, __setState: (s) => { state = s; } };`
  )(formatUsdHonest);
} catch (err) {
  console.log('FATAL: could not build the domains.js sandbox — ' + err.message);
  process.exit(1);
}

const {
  formatUsd, costReadout, resetDomainScopedHealthState,
  disarmSemanticScan, shouldKeepSemanticScanOnReload,
} = domainsSandbox;

const { chargePartialSpend, chargeForItem } = queueTesting;

// The exact pre-fix formatter, kept verbatim as the ORACLE for "every value
// that already rendered correctly still renders identically". Without this,
// a fix could quietly change every price in the app and the suite would
// only notice the handful of values it happened to hardcode.
function legacyFormatUsd(n) {
  if (typeof n !== 'number' || Number.isNaN(n)) return null;
  return n < 0.01 ? '$' + n.toFixed(4) : '$' + n.toFixed(2);
}

// ═══════════════════════════════════════════════════════════════════════
section('1. DEFECT 2 — a non-zero cost can never render as $0.0000');
// ═══════════════════════════════════════════════════════════════════════

// The values the brief names explicitly.
eq(formatUsdHonest(0), '$0.00', 'exactly 0 reads as zero');
eq(formatUsdHonest(0.00001), '< $0.0001', '0.00001 (would have been $0.0000)');
eq(formatUsdHonest(0.00005), '$0.0001', '0.00005 — the first value toFixed(4) does not round away');
eq(formatUsdHonest(0.0001), '$0.0001', '0.0001');
eq(formatUsdHonest(0.5), '$0.50', '0.5');

// The reported estimate from the live Health quick-maintenance button.
eq(formatUsdHonest(0.00010701), '$0.0001', 'the reported estimatedUsd renders as a real charge');
// The reported semantic-scan cost.
eq(formatUsdHonest(0.0040), '$0.0040', 'a semantic-scan cost keeps its 4dp precision');

// Boundary either side of the rounding cliff.
eq(formatUsdHonest(0.000049999), '< $0.0001', 'just below the cliff');
eq(formatUsdHonest(0.0099), '$0.0099', 'just below the 2dp switch');
eq(formatUsdHonest(0.01), '$0.01', 'exactly at the 2dp switch');

// No figure to report -> null, so callers hide the readout (every existing
// caller already null-checks; changing that contract would make cost text
// appear where there is no cost).
eq(formatUsdHonest(null), null, 'null -> null');
eq(formatUsdHonest(undefined), null, 'undefined -> null');
eq(formatUsdHonest(NaN), null, 'NaN -> null');
eq(formatUsdHonest('0.5'), null, 'a numeric STRING -> null (not coerced)');
eq(formatUsdHonest(Infinity), null, 'Infinity -> null');
eq(formatUsdHonest(-Infinity), null, '-Infinity -> null');

// THE HEADLINE PROPERTY, swept rather than spot-checked. A hardcoded list of
// examples is exactly how a formatter defect survives: the defect lives in
// the values nobody thought to type.
{
  let renderedZero = null;
  let nullOnRealNumber = null;
  const probes = [];
  // Dense sweep through the region that used to lie, plus decades either side.
  for (let e = -12; e <= 3; e++) {
    for (const m of [1, 1.7, 2.5, 3.3, 4.9, 5, 5.1, 6.6, 7, 8.8, 9.99]) {
      probes.push(m * Math.pow(10, e));
    }
  }
  // And every 4dp/2dp grid point in the sub-cent band, where the cliff is.
  for (let i = 1; i <= 2000; i++) probes.push(i / 1e6);
  for (const v of probes) {
    if (!Number.isFinite(v) || v === 0) continue;
    const out = formatUsdHonest(v);
    if (out === null) { nullOnRealNumber = v; break; }
    if (/^\$0\.0*0$/.test(out)) { renderedZero = v; break; }
  }
  ok(renderedZero === null,
     `no non-zero value in ${probes.length} probes renders as an all-zero dollar figure` +
     (renderedZero === null ? '' : ` — ${renderedZero} rendered as ${formatUsdHonest(renderedZero)}`));
  ok(nullOnRealNumber === null,
     'every finite non-zero probe produces a figure (none silently became null)');
}

// NON-REGRESSION: the fix must change ONLY the values that were lying.
{
  let changed = [];
  const probes = [];
  for (let i = 1; i <= 3000; i++) probes.push(i / 1e5);   // 0.00001 .. 0.03
  for (let i = 1; i <= 500; i++) probes.push(i / 100);    // 0.01 .. 5.00
  for (const v of probes) {
    const legacy = legacyFormatUsd(v);
    const now = formatUsdHonest(v);
    // The legacy output was a LIE exactly when it was all-zero on a non-zero
    // input. Everywhere else it must be preserved byte-for-byte.
    const legacyWasALie = /^\$0\.0*0$/.test(legacy);
    if (!legacyWasALie && legacy !== now) changed.push({ v, legacy, now });
  }
  ok(changed.length === 0,
     `every value the old formatter rendered honestly is unchanged byte-for-byte (${probes.length} probes)` +
     (changed.length === 0 ? '' : ` — first drift: ${JSON.stringify(changed[0])}`));
  // And prove the oracle can actually disagree, so "0 drift" means something.
  ok(legacyFormatUsd(0.00001) === '$0.0000' && formatUsdHonest(0.00001) !== '$0.0000',
     'the legacy oracle DOES produce $0.0000 on a non-zero input (so the comparison above is live)');
}

// ── The real call site the defect was reported against ──────────────────
// domains.js's own formatUsd, extracted from source. Proving the shared
// module in isolation would not prove the button is fixed.
eq(formatUsd(0.00001), '< $0.0001', "domains.js formatUsd: 0.00001 is not '$0.0000'");
eq(formatUsd(0.00010701), '$0.0001', 'domains.js formatUsd: the reported estimate');
eq(formatUsd(0), '$0.00', 'domains.js formatUsd: genuine zero');
eq(formatUsd(NaN), null, 'domains.js formatUsd: NaN -> null (caller hides the readout)');

// costReadout is what the quick-maintenance BADGE actually calls.
eq(costReadout({ estimatedUsd: 0.00001, priceKnown: true, costNote: null }, { compact: true }),
   '< $0.0001', 'quick-action badge on a sub-$0.00005 charge does not read as free');
eq(costReadout({ estimatedUsd: 0.00010701, priceKnown: true, costNote: null }, { compact: true }),
   '$0.0001', 'quick-action badge on the reported estimate');
eq(costReadout({ estimatedUsd: 0, priceKnown: true, costNote: null }, { compact: true }),
   '$0.00', 'a genuinely free action still reads as free');
eq(costReadout({ estimatedUsd: null, priceKnown: false, costNote: 'Cost estimate unavailable — no published price for model "x".' }, { compact: true }),
   'cost unknown', 'an UNPRICED model still reports unknown, not a fabricated zero');
eq(costReadout(null), null, 'no estimate -> null');
eq(costReadout({ error: 'boom' }), null, 'an errored estimate -> null');

// ═══════════════════════════════════════════════════════════════════════
section('2. DEFECT 1 — chargePartialSpend attributes MEASURED partial spend');
// ═══════════════════════════════════════════════════════════════════════

// A job shaped like a real manifest. gemini-2.5-flash-lite is the pinned
// default and has a published price, so the "real" branch is reachable.
function jobFixture(over) {
  return Object.assign({
    items: [
      { idx: 0, status: 'done', name: 'a.md' },
      { idx: 1, status: 'cancelled', name: 'b.md' },
    ],
    spentUsd: 0,
    spendIsEstimated: false,
    spendIsLowerBound: false,
    budgetUsd: null,
    estimate: { usdLow: 0.004, usdHigh: 0.02 },
  }, over || {});
}
function usage(over) {
  return Object.assign({
    calls: 10, inputTokens: 400000, outputTokens: 20000,
    cachedReadTokens: 0, cacheWriteTokens: 0,
    provider: 'gemini', model: 'gemini-2.5-flash-lite',
  }, over || {});
}

// ── The exact reported scenario ──────────────────────────────────────────
// A 2-file batch. Item 1 completed and charged $0.009368. Item 2 was
// cancelled at Phase-2 batch 9 of 11, having run 1 outline call + 9 batch
// calls. Pre-fix: charged 0, spentUsd frozen at 0.009368, flag still false.
{
  const job = jobFixture({ spentUsd: 0.009368 });
  const item = job.items[1];
  const totals = usage({ calls: 10 });
  const charge = chargePartialSpend(job, item, totals);
  ok(charge > 0, 'a cancelled item that made 10 provider calls is charged MORE THAN ZERO');
  ok(Number.isFinite(charge), 'the charge is a finite number');
  eq(job.spendIsLowerBound, true,
     'and the total is NO LONGER claimed to be exact (the in-flight call at the abort is unmeasurable)');
  // THE SECOND DEFECT ON THIS LINE: it used to set spendIsEstimated, the flag
  // for a model with NO PUBLISHED PRICE charged a share of estimate.usdHigh.
  // Every dollar counted here was MEASURED — llm.js reported it for a
  // completed call — so "estimated, not measured" was false, and the UI drew
  // the same "at least" prefix over an estimate share that can read ~50%
  // ABOVE real spend (usdHigh measured at 66.8% of actual on Anthropic).
  eq(job.spendIsEstimated, false,
     'and it is NOT flagged as ESTIMATED — a measured partial is a floor, not an approximation');

  // Cross-check against chargeForItem on the same usage: the partial charge
  // must be the REAL measured cost, not an estimate share.
  const measured = chargeForItem(jobFixture(), { tokenUsage: totals });
  ok(Math.abs(charge - measured) < 1e-12,
     'the amount charged is the real measured cost of those calls, not an estimate share');
  ok(measured > 0.001,
     `10 calls / 400k in / 20k out is a material charge, not noise (got ${measured.toFixed(6)})`);
}

// ── calls === 0: charge NOTHING, and do not touch the flag ───────────────
// This is not a guess. Zero COMPLETED provider calls means zero was billed:
// a cancel before Phase 1, an unextractable PDF, a too-short source. Routing
// this through chargeForItem would take its fallback branch and charge a FULL
// file's share for a file that spent nothing, AND flip the flag for no reason.
{
  const job = jobFixture();
  eq(chargePartialSpend(job, job.items[1], usage({ calls: 0 })), 0,
     'zero completed calls -> charged 0');
  eq(job.spendIsEstimated, false,
     'zero completed calls -> the measured/estimated flag is untouched (nothing was unmeasurable)');
  eq(job.spendIsLowerBound, false,
     'zero completed calls -> the lower-bound flag is untouched too');
}
{
  // The REALISTIC shape: a cancel (or an unextractable PDF) before any
  // provider call leaves a FRESH accumulator — this is the literal object
  // the queue hands to chargePartialSpend in that case, taken from the real
  // makeUsageAccumulator rather than hand-rolled.
  const job = jobFixture();
  const fresh = makeUsageAccumulator().totals;
  eq(fresh.calls, 0, 'precondition: a fresh accumulator reports zero calls');
  eq(chargePartialSpend(job, job.items[1], fresh), 0,
     'a fresh (never-fired) accumulator -> charged 0');
  eq(job.spendIsEstimated, false,
     'a fresh accumulator -> flag untouched (this is the cancel-before-Phase-1 case)');
  eq(job.spendIsLowerBound, false,
     'a fresh accumulator -> the lower-bound flag is untouched too');
}
{
  // Prove the contrast is real: the same job, via chargeForItem's fallback,
  // WOULD have charged a full share and flipped the flag.
  const job = jobFixture();
  const fallback = chargeForItem(job, { tokenUsage: null });
  ok(fallback > 0 && job.spendIsEstimated === true,
     'control: chargeForItem on absent usage DOES charge an estimate share and flip the flag (so the branch above matters)');
  eq(job.spendIsLowerBound, false,
     'control: a COMPLETED item charged an estimate share is NOT a lower bound — the two flags are independent, not aliases');
}

// ── calls > 0 but the model has no published price ───────────────────────
{
  const job = jobFixture();
  const charge = chargePartialSpend(job, job.items[1], usage({ model: 'no-such-model-xyz' }));
  ok(charge > 0, 'an unpriced model still charges (the estimate share) rather than silently 0');
  eq(job.spendIsEstimated, true, 'and is reported as estimated');
  eq(job.spendIsLowerBound, true,
     'AND as a lower bound — an unpriced PARTIAL is both approximate and incomplete, so both flags set (the renderer resolves the precedence)');
}
{
  // Same, with no usdHigh to fall back on: charge degrades to 0 but the flag
  // still tells the truth about the figure.
  const job = jobFixture({ estimate: null });
  const charge = chargePartialSpend(job, job.items[1], usage({ model: 'no-such-model-xyz' }));
  eq(charge, 0, 'unpriced model AND no estimate -> 0 (no number is invented)');
  eq(job.spendIsEstimated, true, 'but the total is flagged as not-measured');
  eq(job.spendIsLowerBound, true, 'and as incomplete');
}

// ── Junk / defensive input ───────────────────────────────────────────────
{
  for (const bad of [null, undefined, {}, { calls: null }, { calls: NaN }, { calls: 'ten' }, { calls: -3 }, { calls: Infinity }]) {
    const job = jobFixture();
    const charge = chargePartialSpend(job, job.items[1], bad);
    ok(charge === 0 && job.spendIsEstimated === false && job.spendIsLowerBound === false,
       `junk totals ${JSON.stringify(bad)} -> charge 0, BOTH flags untouched`);
  }
}

// ── The caller must not be mutated ───────────────────────────────────────
// The transient path leaves the item `pending` for a full retry; a tokenUsage
// stamped on it there would be double-counted against the retry's own charge.
{
  const job = jobFixture();
  const item = job.items[1];
  chargePartialSpend(job, item, usage());
  eq(item.tokenUsage, undefined,
     'chargePartialSpend does not stamp tokenUsage on the item it was handed');
}

// ═══════════════════════════════════════════════════════════════════════
section('3. DEFECT 1 — a fully-completed batch is still reported as MEASURED');
// ═══════════════════════════════════════════════════════════════════════
// The fix must not downgrade every batch to "estimated". Only a batch
// containing a genuinely interrupted item — the batch whose total cannot be
// known — loses the exact claim.
{
  const job = jobFixture({ items: [{ idx: 0, status: 'done', name: 'a.md' }] });
  const charge = chargeForItem(job, { tokenUsage: usage() });
  ok(charge > 0, 'a completed item charges its measured cost');
  eq(job.spendIsEstimated, false, 'and a batch of only completed items stays MEASURED');
  eq(job.spendIsLowerBound, false, '...and is not flagged as a lower bound either');
}

// ═══════════════════════════════════════════════════════════════════════
section('4. DEFECT 1 — the makeUsageAccumulator forward seam');
// ═══════════════════════════════════════════════════════════════════════
// This is the mechanism that makes partial spend observable at all:
// result.tokenUsage only exists when an ingest RETURNS, so a cancel took
// every already-billed call with it.
{
  const seen = [];
  const acc = makeUsageAccumulator((u) => seen.push(u));
  const frame = { inputTokens: 100, outputTokens: 10, cachedReadTokens: 5, cacheWriteTokens: 1, provider: 'gemini', model: 'gemini-2.5-flash-lite' };
  acc.onUsage(frame);
  acc.onUsage(frame);
  eq(seen.length, 2, 'the forward observer sees every completed provider call');
  eq(seen[0], frame, 'and receives the payload unchanged (same object)');
  eq(acc.totals.calls, 2, 'the internal totals still accumulate');
  eq(acc.totals.inputTokens, 200, 'input tokens summed');
  eq(acc.totals.outputTokens, 20, 'output tokens summed');
  eq(acc.totals.cachedReadTokens, 10, 'cached-read tokens summed');
  eq(acc.totals.cacheWriteTokens, 2, 'cache-write tokens summed');
  eq(acc.totals.model, 'gemini-2.5-flash-lite', 'model recorded');
}
{
  // Back-compat: every pre-existing caller passes nothing.
  const acc = makeUsageAccumulator();
  acc.onUsage({ inputTokens: 7, model: 'm' });
  eq(acc.totals.calls, 1, 'no observer -> accumulation is unchanged');
  eq(acc.totals.inputTokens, 7, 'no observer -> totals still correct');
}
{
  // THE IMPORTANT ONE. Bookkeeping must never be able to fail an ingest, so
  // a throwing observer is swallowed AND accumulation continues.
  const acc = makeUsageAccumulator(() => { throw new Error('observer exploded'); });
  let threw = false;
  try { acc.onUsage({ inputTokens: 5, model: 'm' }); } catch { threw = true; }
  ok(!threw, 'a THROWING forward observer does not propagate out of onUsage');
  eq(acc.totals.inputTokens, 5, 'and the totals were still recorded before it threw');
  try { acc.onUsage({ inputTokens: 5, model: 'm' }); } catch { /* ignore */ }
  eq(acc.totals.calls, 2, 'a throwing observer does not stop later calls being counted');
}
{
  // A non-function forward must be ignored, not called.
  for (const bad of [null, undefined, 0, 'nope', {}, []]) {
    const acc = makeUsageAccumulator(bad);
    let threw = false;
    try { acc.onUsage({ inputTokens: 1, model: 'm' }); } catch { threw = true; }
    ok(!threw && acc.totals.calls === 1, `a non-function forward (${JSON.stringify(bad)}) is ignored safely`);
  }
}

// ═══════════════════════════════════════════════════════════════════════
section('5. DEFECT 1 — wiring (SOURCE GUARDS, stated as such)');
// ═══════════════════════════════════════════════════════════════════════
// These prove the call sites exist and are placed correctly. They do NOT
// prove the runtime behaviour of a real cancelled ingest — that needs a paid
// live run and is named in this file's header as not covered.
{
  const inner = extractFunction(queueCode, 'processItemInner', 'ingest-queue.js');

  ok(/const itemUsage = makeUsageAccumulator\(\);/.test(inner),
     'processItemInner builds a per-item usage accumulator');

  // Placement is the whole point: the accumulator must be declared OUTSIDE
  // the try whose catch reads it, or the cancelled/failed paths cannot see
  // it. Proven positionally against the outer `try {`, not by eyeball.
  const accIdx = inner.indexOf('const itemUsage = makeUsageAccumulator();');
  const tryIdx = inner.indexOf('\n  try {');
  ok(accIdx !== -1 && tryIdx !== -1 && accIdx < tryIdx,
     'the accumulator is declared BEFORE the outer try, so the catch can read it');

  ok(/onUsage: itemUsage\.onUsage/.test(inner),
     'and it is actually passed to the ingest call as opts.onUsage');

  // All THREE non-return settle paths must charge. One fixed and two left is
  // this repo's most-repeated failure shape (a guard applied to a route
  // rather than to a class).
  const chargeCalls = inner.match(/chargePartialSpend\(j, it, itemUsage\.totals\)/g) || [];
  eq(chargeCalls.length, 3,
     'all THREE non-return settle paths charge partial spend (cancelled, transient-pause, failed)');

  // The cancelled and failed paths additionally stamp the measured partial on
  // the item so the wire stops reporting tokenUsage: null for a file that
  // made real calls. The transient path deliberately does NOT (the item goes
  // back to pending for a full retry).
  const stamps = inner.match(/it\.tokenUsage = itemUsage\.totals\.calls > 0 \? itemUsage\.totals : null;/g) || [];
  eq(stamps.length, 2,
     'exactly two paths stamp the partial usage on the item (cancelled + failed, NOT the pending retry)');
}
{
  ok(/makeUsageAccumulator,/.test(queueCode.slice(0, queueCode.indexOf("} from './ingest.js';") + 32)),
     'ingest-queue.js imports makeUsageAccumulator from the real ingest module');
  ok(/makeUsageAccumulator\(\s*\n?\s*\(opts && typeof opts\.onUsage === 'function'\) \? opts\.onUsage : null/.test(brainIngestCode),
     'ingestFile threads opts.onUsage into its accumulator');
}

// ═══════════════════════════════════════════════════════════════════════
section('6. DEFECT 2 — one formatter, and the gap that could not be closed');
// ═══════════════════════════════════════════════════════════════════════
ok(/^import \{ formatUsdHonest \} from '\.\.\/shared\/format-usd\.js';$/m.test(domainsCode),
   'views/domains.js imports the shared formatter');
ok(/^import \{ formatUsdHonest \} from '\.\.\/shared\/format-usd\.js';$/m.test(ingestViewCode),
   'views/ingest.js imports the shared formatter');

// Neither view may re-grow a local 4dp dollar formatter. This is the
// "enumerate the class, do not patch one site" guard.
for (const [label, code] of [['views/domains.js', domainsCode], ['views/ingest.js', ingestViewCode]]) {
  ok(!/\$['"]\s*\+\s*[A-Za-z_.$[\]]+\.toFixed\(4\)/.test(code) && !/toFixed\(4\)\s*\)?\s*[:;]/.test(code.replace(/\(n \/ 1024\)\.toFixed\(1\)/g, '')),
     `${label} has no local '$' + x.toFixed(4) dollar formatter left`);
}
ok(!/toFixed\(4\)/.test(domainsCode), 'views/domains.js contains no toFixed(4) at all');
ok(!/toFixed\(4\)/.test(ingestViewCode), 'views/ingest.js contains no toFixed(4) at all');

// The KNOWN GAP, asserted rather than remembered. These two are byte-pinned
// to src/public/app.js (the frozen shipping bundle) by
// test-next-ingest-logic-drift.js, so they could not be fixed here. Pinning
// that they are STILL defective means the day the pin is lifted, this
// assertion fails and names them — instead of the gap being forgotten.
ok(/toFixed\(4\)/.test(sharedLogicCode),
   'KNOWN GAP: shared/ingest-queue-logic.js still uses toFixed(4) — byte-pinned to the frozen shipping bundle, see format-usd.js header');
{
  // And prove the gap is a REAL defect, not a theoretical one, by executing
  // the byte-pinned functions from the real source.
  const pinned = new Function(
    extractFunction(sharedLogicSrc, 'formatUsdRange', 'ingest-queue-logic.js') + '\n' +
    extractFunction(sharedLogicSrc, 'computeQueueSpentLabel', 'ingest-queue-logic.js') + '\n' +
    'return { formatUsdRange, computeQueueSpentLabel };'
  )();
  ok(/\$0\.0000/.test(String(pinned.formatUsdRange(0.00001, 0.00002))),
     'KNOWN GAP is real: formatUsdRange(0.00001, …) does render $0.0000');
  eq(pinned.computeQueueSpentLabel(0.00001, true), '$0.0000 spent',
     'KNOWN GAP is real: computeQueueSpentLabel(0.00001, terminal) does render $0.0000 spent');
}

// The done-summary readout must consume BOTH flags — before this fix nothing
// in the /next tree read either, so a lower-bound figure was presented as
// exact; and then, once it read one, it drew "at least" over an estimate
// share that can read ABOVE real spend.
{
  const doneSummary = extractFunction(ingestViewCode, 'renderQueueDoneSummary', 'views/ingest.js');
  ok(/job\.spendIsEstimated === true/.test(doneSummary),
     'the batch done-summary reads spendIsEstimated');
  ok(/job\.spendIsLowerBound === true/.test(doneSummary),
     '...and spendIsLowerBound, which is the flag the "at least" claim actually belongs to');
  ok(/'at least '/.test(doneSummary), 'it can qualify a figure as a lower bound');
  ok(/'approx\. '/.test(doneSummary),
     '...and separately as an approximation, because an estimate share is not a floor');
  ok(/formatUsdHonest\(spentUsd\)/.test(doneSummary),
     'and renders the figure through the honest formatter');

  // ── THE PRECEDENCE, EXECUTED ─────────────────────────────────────────
  // A source guard proves both strings are present; it cannot prove which
  // one a given job gets. Extract the real expression and run it over all
  // four flag combinations.
  const qualifierSrc = doneSummary.match(/const spentQualifier =[\s\S]*?;\n/);
  ok(!!qualifierSrc, 'the qualifier expression is extractable from the real source');
  if (qualifierSrc) {
    const pick = new Function('job', 'spentFigure',
      qualifierSrc[0] + 'return spentQualifier;');
    eq(pick({ spendIsEstimated: false, spendIsLowerBound: false }, '$0.0500'), '',
       'measured + complete -> no qualifier at all (the figure is exact)');
    eq(pick({ spendIsEstimated: false, spendIsLowerBound: true }, '$0.0500'), 'at least ',
       'MEASURED PARTIAL -> "at least" (every counted dollar was billed; only the in-flight call is missing)');
    eq(pick({ spendIsEstimated: true, spendIsLowerBound: false }, '$0.0500'), 'approx. ',
       'ESTIMATE SHARE -> "approx.", NOT "at least" — usdHigh is not a bound and can read ~50% above real spend');
    eq(pick({ spendIsEstimated: true, spendIsLowerBound: true }, '$0.0500'), 'approx. ',
       'BOTH (an unpriced partial) -> "approx." wins; asserting a floor over a possibly-inflated number is the reading we must never produce');
    eq(pick({ spendIsEstimated: true, spendIsLowerBound: true }, null), '',
       'no figure -> no qualifier (a bare "approx." with an em-dash would be nonsense)');
    // Defensive: a job object from an older manifest has neither field.
    eq(pick({}, '$0.0500'), '', 'a job predating both flags renders unqualified, not crashed');
    eq(pick(null, '$0.0500'), '', 'a null job renders unqualified, not crashed');
  }
}

// ── THE WIRE ALLOW-LIST: A FLAG THE UI NEVER RECEIVES IS DEAD DATA ───────
// CHASED, not reported as coverage. Deleting `spendIsLowerBound` from
// toWire's allow-list left this suite at 154/0 and test-ingest-queue at
// 343/0 — the server would compute the flag correctly, the renderer would
// read it correctly, and the qualifier would simply never appear, silently.
// That is v3.6.1 finding 5's exact shape ("six new API fields were DEAD
// DATA"), and it is the one mutation of this fix that nothing caught.
//
// So the invariant is CLASS-level rather than a spot-check on one name:
// toWire is an explicit allow-list (v3.3.0 — it used to be a `...rest`
// spread that leaked a 48 MB manifest), which means every job-level spend
// flag must be added to it BY HAND. Enumerate them from the source and
// require each one to be forwarded, so the next flag cannot be dead either.
{
  const flagNames = new Set();
  // Both the declaration site in createJob and every assignment site.
  for (const m of queueCode.matchAll(/\bjob\.(spend[A-Za-z0-9_]*)\s*=/g)) flagNames.add(m[1]);
  for (const m of queueCode.matchAll(/^\s{4}(spend[A-Za-z0-9_]*):\s*(?:false|true|0)\s*,/gm)) flagNames.add(m[1]);
  flagNames.delete('spentUsd'); // not a flag, and forwarded as wireNum

  ok(flagNames.size >= 2,
     `ANTI-VACUITY — the enumerator finds the spend flags in ingest-queue.js (found ${flagNames.size}: ${[...flagNames].join(', ')})`);
  ok(flagNames.has('spendIsEstimated') && flagNames.has('spendIsLowerBound'),
     '...including both of the ones this fix is about');

  const toWireSrc = extractFunction(queueSrc, 'toWire', 'ingest-queue.js');
  for (const name of flagNames) {
    ok(new RegExp(`\\b${name}:\\s*wireBool\\(job\\.${name}\\)`).test(toWireSrc),
       `CLASS INVARIANT — toWire forwards job.${name} to the UI. toWire is an explicit `
       + 'allow-list, so a flag the server computes but never sends is dead data: the '
       + 'readout silently loses its qualifier.');
  }
  // Negative control: the detector can fail.
  ok(!/\bspendIsNotAThing:\s*wireBool/.test(toWireSrc),
     'NEGATIVE CONTROL — the forwarding check does not pass for a name toWire does not carry');
}

// ── STICKINESS, and the docblock claim that was FALSE ────────────────────
// chargePartialSpend's docblock used to assert "a batch in which every item
// ran to completion still reports spendIsEstimated: false". The transient-429
// path charges the partial and returns the item to `pending` for a FULL
// retry, so a batch that paused on a 503 and then finished perfectly kept the
// flag, and nothing reset it.
//
// The DOCBLOCK was corrected, not the behaviour, and this pins the choice:
// the flags describe the cumulative spentUsd, not the current item. The
// pre-429 partial charge is in that total and is incomplete; resetting on a
// later success would assert exactness over a total that still contains an
// unmeasurable component. Sticky is correct — so it is asserted, not left to
// a comment.
{
  const job = jobFixture();
  chargePartialSpend(job, job.items[1], usage({ calls: 3 }));   // the 429'd attempt
  eq(job.spendIsLowerBound, true, 'a transient-paused item marks the total incomplete');
  // …and now the retry completes perfectly, as does every other item.
  const more = chargeForItem(job, { tokenUsage: usage() });
  ok(more > 0, 'the retry charges its own full measured cost on top');
  eq(job.spendIsLowerBound, true,
     'STICKY — a later fully-successful item does NOT clear the flag. The unmeasurable '
     + 'pre-429 call is still inside spentUsd, so the total never becomes exact again.');
  eq(job.spendIsEstimated, false,
     '...and the estimate flag was never set by that path, so it stays false');
}
{
  // The docblock must not re-assert the false claim.
  ok(!/every\s+item\s+ran\s+to\s+completion\s+still\s+reports\s+`?spendIsEstimated:\s*false`?/
      .test(queueSrc),
     'the corrected docblock no longer claims a fully-completed batch always reports false '
     + '(it does not, on the transient-429 path)');
  ok(/STICKINESS/.test(queueSrc),
     '...and states the stickiness rule explicitly instead');
}

// ═══════════════════════════════════════════════════════════════════════
section('7. DEFECT 3 — a paid scan survives a remount; the gate does not');
// ═══════════════════════════════════════════════════════════════════════

function scanFixture(slug, previewedKeys) {
  const pairs = [
    { keepFolder: 'concepts', keepSlug: 'alpha', removeFolder: 'concepts', removeSlug: 'alpha-2', confidence: 'high', status: null },
    { keepFolder: 'entities', keepSlug: 'beta', removeFolder: 'entities', removeSlug: 'beta-2', confidence: 'high', status: null },
  ];
  return {
    slug,
    pairs,
    cost: 0.0040,
    previewed: new Set(previewedKeys || []),
    preview: { key: 'concepts/alpha::concepts/alpha-2', data: { keepPath: 'x' } },
  };
}

// ── disarmSemanticScan: keeps the PAID data, empties the GATE ────────────
{
  const scan = scanFixture('articles', ['concepts/alpha::concepts/alpha-2']);
  const out = disarmSemanticScan(scan);
  ok(out === scan, 'disarmSemanticScan returns the same scan object (nothing is rebuilt or lost)');
  eq(out.pairs.length, 2, 'THE PAID DATA SURVIVES: the pair list is intact');
  eq(out.cost, 0.0040, 'the recorded cost survives');
  eq(out.slug, 'articles', 'the domain stamp survives (LAYER 2 still has something to check)');
  eq(out.previewed.size, 0,
     'THE GATE IS RE-ARMED: the previewed set is EMPTY (raw read, not "a later check refuses")');
  eq(out.preview, null, 'any open preview is dropped');
}
{
  // Both directions: prove the fixture really did carry a previewed key, so
  // "empty afterwards" means something.
  const scan = scanFixture('articles', ['concepts/alpha::concepts/alpha-2', 'entities/beta::entities/beta-2']);
  eq(scan.previewed.size, 2, 'precondition: two previewed keys are stored');
  disarmSemanticScan(scan);
  eq(scan.previewed.size, 0, 'after disarm: zero');
}
{
  // Defensive: a scan whose previewed field is not a Set must still come back
  // with an empty Set, not a passthrough of whatever was there.
  const scan = { slug: 'articles', pairs: [], previewed: ['leftover'], preview: null };
  const out = disarmSemanticScan(scan);
  ok(out.previewed instanceof Set && out.previewed.size === 0,
     'a non-Set previewed field is replaced with an empty Set, never passed through');
}
eq(disarmSemanticScan(null), null, 'no scan -> null');
eq(disarmSemanticScan(undefined), null, 'undefined -> null');
eq(disarmSemanticScan('nope'), null, 'a non-object -> null');

// ── shouldKeepSemanticScanOnReload: same domain keeps, any change clears ──
eq(shouldKeepSemanticScanOnReload(scanFixture('articles'), 'articles'), true,
   'SAME domain -> the paid scan is kept across the remount');
eq(shouldKeepSemanticScanOnReload(scanFixture('articles'), 'business'), false,
   'DIFFERENT domain -> NOT kept (v3.7.0: a set surviving a domain change could authorise a merge on another domain\'s pair)');
eq(shouldKeepSemanticScanOnReload(null, 'articles'), false, 'no scan -> nothing to keep');
eq(shouldKeepSemanticScanOnReload(scanFixture('articles'), null), false,
   'no active slug (e.g. the domain was deleted) -> not kept');
eq(shouldKeepSemanticScanOnReload(scanFixture('articles'), ''), false, 'empty slug -> not kept');
eq(shouldKeepSemanticScanOnReload(scanFixture(undefined), undefined), false,
   'an unstamped scan cannot match an absent slug (no undefined === undefined loophole)');
eq(shouldKeepSemanticScanOnReload('nope', 'articles'), false, 'a non-object scan -> not kept');

// ── resetDomainScopedHealthState: the opt-in is what spares the scan ──────
{
  domainsSandbox.__setState({ estimates: { a: 1 }, pendingPlan: { p: 1 }, semanticScan: scanFixture('articles'), dismissedRecords: [1] });
  resetDomainScopedHealthState();
  eq(domainsSandbox.__state().semanticScan, null,
     'no opts -> the scan is cleared (a real rescan / domain switch / batch merge invalidates it)');
  eq(domainsSandbox.__state().pendingPlan, null, 'and the pending plan always goes');
}
{
  const scan = scanFixture('articles');
  domainsSandbox.__setState({ estimates: {}, pendingPlan: null, semanticScan: scan, dismissedRecords: null });
  resetDomainScopedHealthState({ keepSemanticScan: true });
  eq(domainsSandbox.__state().semanticScan, scan,
     'keepSemanticScan: true -> the paid scan survives the health reload');
}
{
  const scan = scanFixture('articles');
  domainsSandbox.__setState({ estimates: {}, pendingPlan: null, semanticScan: scan, dismissedRecords: null });
  resetDomainScopedHealthState({ keepSemanticScan: false });
  eq(domainsSandbox.__state().semanticScan, null,
     'keepSemanticScan: false -> cleared (the flag is read, not merely present)');
}

// ── The whole round trip, composed the way the view composes it ──────────
{
  // Scan on 'articles', preview one pair, leave the view, come back.
  const scan = scanFixture('articles', ['concepts/alpha::concepts/alpha-2']);
  domainsSandbox.__setState({ estimates: {}, pendingPlan: null, semanticScan: scan, dismissedRecords: null, activeSlug: 'articles' });

  // 1. teardown on unmount
  disarmSemanticScan(domainsSandbox.__state().semanticScan);
  // 2. re-entry: loadDomainsList resolves activeSlug, then loadHealth
  const st = domainsSandbox.__state();
  resetDomainScopedHealthState({ keepSemanticScan: shouldKeepSemanticScanOnReload(st.semanticScan, st.activeSlug) });

  // Read defensively. A mutation that breaks the keep-path leaves this null,
  // and a null deref would ABORT the run — no tally, later sections never
  // executed. A test that dies mid-way is a worse signal than one that fails
  // cleanly, so each property is asserted through an optional read.
  const after = domainsSandbox.__state().semanticScan;
  ok(!!after && Array.isArray(after.pairs) && after.pairs.length === 2,
     'ROUND TRIP, same domain: the 8-pair-equivalent paid result is STILL THERE — no re-scan, no second charge');
  eq(after && after.previewed ? after.previewed.size : 'no-scan', 0,
     'ROUND TRIP: and the destructive gate is re-armed (re-previewing is free)');
  eq(after ? after.preview : 'no-scan', null,
     'ROUND TRIP: no stale preview is presented as current');
}
{
  // Same trip, but the user comes back to a DIFFERENT domain.
  const scan = scanFixture('articles', ['concepts/alpha::concepts/alpha-2']);
  domainsSandbox.__setState({ estimates: {}, pendingPlan: null, semanticScan: scan, dismissedRecords: null, activeSlug: 'business' });
  disarmSemanticScan(domainsSandbox.__state().semanticScan);
  const st = domainsSandbox.__state();
  resetDomainScopedHealthState({ keepSemanticScan: shouldKeepSemanticScanOnReload(st.semanticScan, st.activeSlug) });
  eq(domainsSandbox.__state().semanticScan, null,
     "ROUND TRIP, domain changed: the other domain's pairs are GONE, not merely refused");
}

// ═══════════════════════════════════════════════════════════════════════
section('8. DEFECT 3 — wiring (SOURCE GUARDS, stated as such)');
// ═══════════════════════════════════════════════════════════════════════
{
  // The teardown must no longer null the scan outright — that is what threw
  // the paid result away on a rail click.
  const teardownRegion = domainsCode.slice(domainsCode.indexOf("registerView('domains', {"));
  ok(/disarmSemanticScan\(state\.semanticScan\);/.test(teardownRegion),
     'the unmount teardown disarms the scan instead of destroying it');
  ok(!/state\.semanticScan = null;/.test(teardownRegion),
     'and no longer sets state.semanticScan = null');
  // The other two dangerous carry-overs must STILL be destroyed: they close
  // over (or were built from) a specific scan run.
  ok(/state\.confirm = null;/.test(teardownRegion), 'state.confirm is still destroyed on unmount');
  ok(/state\.pendingPlan = null;/.test(teardownRegion), 'state.pendingPlan is still destroyed on unmount');
  ok(/state\.lifecycle = null;/.test(teardownRegion), 'state.lifecycle is still destroyed on unmount');
}
{
  ok(/keepSemanticScan: shouldKeepSemanticScanOnReload\(state\.semanticScan, state\.activeSlug\)/.test(domainsCode),
     're-entry passes the guarded keepSemanticScan flag to loadHealth');
  // And it is evaluated INSIDE loadDomainsList, after activeSlug is resolved
  // — a vanished domain must re-take the clearing path.
  const loadList = extractFunction(domainsCode, 'loadDomainsList', 'domains.js');
  ok(/shouldKeepSemanticScanOnReload/.test(loadList),
     'the guard is evaluated inside loadDomainsList, after state.activeSlug has been resolved');
  const slugFixIdx = loadList.indexOf('state.activeSlug = state.domains.length');
  const guardIdx = loadList.indexOf('shouldKeepSemanticScanOnReload');
  ok(slugFixIdx !== -1 && guardIdx !== -1 && slugFixIdx < guardIdx,
     'and it is evaluated AFTER the line that can reassign state.activeSlug');
}
{
  // A domain rename/delete must still clear the scan explicitly — the
  // pre-existing LAYER 1 sites are untouched by this fix.
  ok(/state\.semanticScan && state\.semanticScan\.slug === oldSlug\) state\.semanticScan = null/.test(domainsCode),
     'a RENAME still clears the scan for the old slug');
  ok(/state\.semanticScan && state\.semanticScan\.slug === slug\) state\.semanticScan = null/.test(domainsCode),
     'a DELETE still clears the scan for that slug');
}

// ═══════════════════════════════════════════════════════════════════════
console.log('\n────────────────────────────────────────────────────────────');
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed === 0) console.log('✅ All cost-honesty offline assertions green');
process.exit(failed === 0 ? 0 : 1);
