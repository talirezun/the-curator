#!/usr/bin/env node
/**
 * test-openrouter-qualify.js — OFFLINE proof for on-wiki model qualification:
 * the measurement engine (`src/brain/openrouter-qualify.js`), the THIRD BUILD
 * LANE it feeds (`src/brain/llm.js`), and the honesty rules both are built on.
 *
 * Run:  node scripts/test-openrouter-qualify.js
 * Exit: 0 if all green, 1 on any failure. No network, no API key, no spend.
 *       Every user-data path is redirected to a tempdir before llm.js is
 *       imported, so the maintainer's real `.curator-config.json` is never read
 *       and never written.
 *
 * ── WHAT THIS FILE IS ACTUALLY GUARDING ─────────────────────────────────────
 *
 * The feature's whole value rests on being able to tell a WORKING model from a
 * BROKEN one, and there are two ways to build it that quietly cannot:
 *
 *   TRAP 1 — measuring through `parseJSON` alone. It tries raw parse, then
 *   fence-strip, then `jsonrepair`, and returns no provenance — so every model
 *   that ever succeeds records as clean and the measurement is a constant.
 *   §1 asserts that raw and repaired are ACTUALLY DISTINGUISHED, not merely
 *   that each classifies as something.
 *
 *   TRAP 2 — treating "it parsed" as "it worked". `jsonrepair` turns the bare
 *   text `not json at all` into the truthy STRING "not json at all". §2 drives
 *   the REAL production gate (`usablePageArray`) over inputs that parse and are
 *   still useless.
 *
 * The case of record throughout is `z-ai/glm-4.7`: 204,800 context, 131,072
 * output ceiling, JSON mode advertised, a real price, no alias, no expiry, and
 * FAST (38 s). It passes every structural filter this app has, and nine live
 * runs against the real outline prompt returned JSON neither `JSON.parse` nor
 * `jsonrepair` could recover — 9 times out of 9. §7 reproduces that shape
 * offline and asserts it is refused.
 *
 * ── FOR EVERY ASSERTION: WHAT INPUT WOULD MAKE THIS FAIL? ───────────────────
 * This repo has shipped six guards in one session that could not fail — a money
 * mirror whose fixture zeroed the branch carrying the bug, an ordering
 * assertion over an accidentally-sorted corpus, an assertion of the form
 * `f(x) === f(x)`. So every section here that could be vacuous carries an
 * explicit CONTROL: an input proving the check can report a failure. They are
 * labelled `control:` and are not decoration — remove one and the section it
 * guards can silently become a tautology.
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// ── ISOLATION FIRST, BEFORE ANY MODULE THAT READS USER DATA ─────────────────
// Both variables, never just the domains one: `CURATOR_TEST_DOMAINS_DIR` alone
// still leaves the process resolving the REAL `.curator-config.json` (and with
// it the real API keys and GitHub PAT). Set before the dynamic imports below,
// because `paths.js` resolves per call but a module that reads at import time
// would already have looked.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'curator-qualify-test-'));
process.env.CURATOR_TEST_USER_DATA_DIR = TMP;
process.env.CURATOR_TEST_DOMAINS_DIR = path.join(TMP, 'domains');
fs.mkdirSync(process.env.CURATOR_TEST_DOMAINS_DIR, { recursive: true });
fs.writeFileSync(
  path.join(TMP, '.curator-config.json'),
  JSON.stringify({ openrouterApiKey: 'k'.repeat(40), activeProvider: 'openrouter' }),
  { mode: 0o600 },
);

const q = await import('../src/brain/openrouter-qualify.js');
const llm = await import('../src/brain/llm.js');
const cfg = await import('../src/brain/config.js');

const {
  classifyResponse, readUsage, budgetBurn, classifyProbeError,
  summariseRuns, isPassingRecord, estimateQualification, projectRemainingMs,
  qualifyModel, isCancelledError, QUALIFY_MIN_RUNS,
} = q;

let passed = 0, failed = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { passed++; } else { failed++; failures.push(label); console.log(`  ✗ ${label}`); }
}
const eq = (a, b, label) => ok(a === b, `${label} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`);
function section(t) { console.log(`\n${t}`); }

// A catalogue entry shaped exactly like one the live sync admits.
const spec = (id, over = {}) => Object.assign({
  id, label: id, suitability: 'chat-only', maxOutput: 131072, contextWindow: 204800,
  thinks: false, tokenizerFactor: 1, note: 'admitted from the live catalogue',
  price: { input: 0.5, output: 2 },
}, over);

const GLM = 'z-ai/glm-4.7';

const record = (over = {}) => Object.assign({
  version: 1, provider: 'openrouter', modelId: GLM, domain: 'articles',
  measuredAt: '2026-08-28T10:00:00.000Z', outcome: 'NO_DEFECT_FOUND',
  runsCompleted: 9, runsAttempted: 9,
  counts: { raw: 9, repaired: 0, unrepairable: 0, unusable: 0, notMeasured: 0, failed: 0 },
  aborted: null, cancelled: false,
}, over);

// ═════════════════════════════════════════════════════════════════════════════
section('1. TRAP 1 — raw and repaired must actually be told apart');

const BARE = '{"pages":[{"path":"concepts/a.md","summary":"x"},{"path":"entities/b.md"}]}';
const c1 = classifyResponse(BARE);
eq(c1.parseClass, 'raw', 'bare JSON classifies as raw');
eq(c1.usable, true, 'bare JSON is usable');
eq(c1.pageCount, 2, 'bare JSON reports 2 pages');

const FENCED = '```json\n' + BARE + '\n```';
const c2 = classifyResponse(FENCED);
eq(c2.parseClass, 'repaired', 'fenced JSON classifies as repaired, NOT raw');
eq(c2.usable, true, 'fenced JSON is still usable — `repaired` is not a failure');

// CONTROL. This is the assertion that stops §1 being a tautology: if the two
// ever collapse to the same value the classifier has become a constant and
// every jsonRaw figure the feature reports is a lie.
ok(c1.parseClass !== c2.parseClass,
  'control: raw and repaired are genuinely different values, so the axis is not a constant');

eq(classifyResponse('{{{ not json').parseClass, 'unrepairable', 'garbage classifies as unrepairable');
eq(classifyResponse('').parseClass, 'unrepairable', 'empty text classifies as unrepairable');
eq(classifyResponse(null).usable, false, 'a null response is not usable');

section('2. TRAP 2 — "parses" is not "usable"');

// jsonrepair makes this the truthy STRING "not json at all". Whatever it
// classifies as, `usable` MUST be false — the real gate decides, not the parse.
const c4 = classifyResponse('not json at all');
eq(c4.usable, false, 'bare prose is NOT usable even though jsonrepair "fixes" it');
ok(c4.parseClass === 'repaired' || c4.parseClass === 'raw',
  'control: bare prose really does get PAST the parser — so `usable` is what refused it, not the parse');

const c5 = classifyResponse('{"pages":[]}');
eq(c5.parseClass, 'raw', 'an empty pages array parses raw…');
eq(c5.usable, false, '…and is still NOT usable');
eq(classifyResponse('{"pages":[{"summary":"no path"}]}').usable, false, 'pages with no `path` is not usable');
eq(classifyResponse('{"pages":"a string"}').usable, false, 'pages as a string is not usable');
eq(classifyResponse('{"pages":[{"path":""}]}').usable, false, 'pages with an empty path is not usable');

section('3. readUsage — a missing figure is null, NEVER 0');

const u0 = readUsage(undefined);
eq(u0.inputTokens, null, 'absent usage block -> inputTokens null');
eq(u0.reportedCostUsd, null, 'absent usage block -> cost null, not 0');
// The distinction this repo collapsed in eight places: `0` is truthy in an
// object test, falsy in arithmetic, and renders as "$0.00".
const u1 = readUsage({ prompt_tokens: 100, completion_tokens: 0, cost: 0 });
eq(u1.outputTokens, 0, 'a REPORTED zero stays 0 — it is a measurement');
eq(u1.reportedCostUsd, 0, 'a REPORTED zero cost stays 0');
ok(u0.reportedCostUsd !== u1.reportedCostUsd,
  'control: "not reported" and "reported as zero" are different values');
eq(readUsage({ cost: 'free' }).reportedCostUsd, null, 'a non-numeric cost is null, never coerced');

section('4. budgetBurn — fires on the expensive shape, and does not over-fire');

const B = 24576;
eq(budgetBurn({ finishReason: 'length', outputTokens: B, usable: false, textLen: 0, reasoningTokens: B }),
  'reasoning', 'full budget + no visible text -> reasoning burn');
eq(budgetBurn({ finishReason: 'length', outputTokens: B, usable: false, textLen: 40000, reasoningTokens: null }),
  'truncation', 'full budget + lots of visible text -> truncation, NOT an over-claimed reasoning diagnosis');
eq(budgetBurn({ finishReason: 'stop', outputTokens: 900, usable: true, textLen: 4000 }),
  null, 'control: a healthy run is not a burn');
eq(budgetBurn({ finishReason: 'length', outputTokens: B, usable: true, textLen: 40000 }),
  null, 'control: usable output is never a burn, even at the ceiling');
eq(budgetBurn({ finishReason: 'stop', outputTokens: 900, usable: false, textLen: 20 }),
  null, 'a small unusable answer is a plain failure, not a burn');

section('5. classifyProbeError — a rate limit is neither a defect nor a pass');

eq(classifyProbeError({ status: 429 }).errorClass, 'RATE_LIMITED', '429 by numeric status');
eq(classifyProbeError({ code: 'OPENROUTER_RATE_LIMIT' }).errorClass, 'RATE_LIMITED', '429 by adapter code');
// Structural, never a substring: this repo's own `/\b429\b/` once matched its
// own prose about "429 characters of text".
eq(classifyProbeError(new Error('yielded only 429 characters of text')).errorClass, 'UNKNOWN_ERROR',
  'control: the digits 429 in a MESSAGE are not a rate limit');
eq(classifyProbeError({ status: 503 }).errorClass, 'UNKNOWN_ERROR', 'a 503 is not a rate limit');
ok(classifyProbeError({ message: 'x'.repeat(9999) }).errorMessage.length <= 300, 'error text is bounded');

section('6. summariseRuns — the decision rule of record');

const run = (over = {}) => Object.assign({
  outcome: 'COMPLETED', parseClass: 'raw', usable: true, pageCount: 20,
  latencyMs: 40000, reportedCostUsd: 0.004, cachedTokens: null,
}, over);

const clean = summariseRuns(Array.from({ length: 9 }, () => run()), { modelId: GLM, domain: 'articles', measuredAt: 'now', runsRequested: 9 });
eq(clean.outcome, 'NO_DEFECT_FOUND', '9 clean runs -> NO_DEFECT_FOUND');
eq(clean.counts.raw, 9, '…9 raw');
eq(clean.pages.median, 20, '…median pages reported');
ok(clean.latencyMs.mean === 40000, '…mean latency reported as a first-class fact');
// THE WORD "verified" MUST NEVER APPEAR. It is the one claim this feature is
// forbidden from making, and a grep is the only guard that survives a rewrite.
ok(!JSON.stringify(clean).toLowerCase().includes('verified'),
  'the record never contains the word "verified"');
ok(!JSON.stringify(clean).toLowerCase().includes('passed'),
  'the record never claims the model "passed"');

// The glm-4.7 shape.
const glm = summariseRuns(Array.from({ length: 9 }, () => run({ parseClass: 'unrepairable', usable: false, pageCount: null })),
  { modelId: GLM, domain: 'articles', measuredAt: 'now' });
eq(glm.outcome, 'DEFECT_OBSERVED', '9 of 9 unrepairable -> DEFECT_OBSERVED');
eq(glm.counts.unrepairable, 9, '…counted as unrepairable');
eq(glm.counts.unusable, 0, 'control: unrepairable runs are NOT double-counted as unusable');

// Parsed-but-unusable is its OWN defect and must not hide inside `unrepairable`.
const dud = summariseRuns([run(), run({ parseClass: 'raw', usable: false, pageCount: 0 })], { modelId: GLM, domain: 'd', measuredAt: 'now' });
eq(dud.counts.unusable, 1, 'a run that parsed raw but planned nothing counts as unusable');
eq(dud.counts.unrepairable, 0, '…and NOT as unrepairable');
eq(dud.outcome, 'DEFECT_OBSERVED', 'one unusable run is enough to observe a defect');

// `repaired` is NOT a defect — the shipping Anthropic default depends on it.
const rep = summariseRuns(Array.from({ length: 9 }, (_, i) => run(i < 3 ? { parseClass: 'repaired' } : {})), { modelId: GLM, domain: 'd', measuredAt: 'now' });
eq(rep.outcome, 'NO_DEFECT_FOUND', '3 repaired of 9 is still NO_DEFECT_FOUND');
eq(rep.counts.repaired, 3, '…and repaired is reported, not hidden');

eq(summariseRuns([run({ outcome: 'NOT_MEASURED', errorClass: 'RATE_LIMITED' })], { aborted: 'NOT_MEASURED_RATE_LIMITED', modelId: GLM, domain: 'd', measuredAt: 'now' }).outcome,
  'NOT_MEASURED', 'a rate-limit abort is NOT_MEASURED — never a defect, never a pass');
eq(summariseRuns([], { cancelled: true, modelId: GLM, domain: 'd', measuredAt: 'now' }).outcome,
  'CANCELLED', 'a cancelled run has its own outcome');
eq(summariseRuns([run({ outcome: 'FAILED', usable: false })], { modelId: GLM, domain: 'd', measuredAt: 'now' }).outcome,
  'DEFECT_OBSERVED', 'an outright call failure is a defect finding');

// SPEND is tri-state.
eq(summariseRuns([run({ reportedCostUsd: null })], { modelId: GLM, domain: 'd', measuredAt: 'now' }).spendUsd, null,
  'no reported cost -> spendUsd null, NEVER 0');
eq(summariseRuns([run({ reportedCostUsd: 0 })], { modelId: GLM, domain: 'd', measuredAt: 'now' }).spendUsd, 0,
  'a reported zero (a free model) -> spendUsd 0, which is the truth');
eq(summariseRuns([run(), run({ reportedCostUsd: null })], { modelId: GLM, domain: 'd', measuredAt: 'now' }).spendComplete, false,
  'a partially-reported total is flagged as incomplete');
eq(summariseRuns([run({ cachedTokens: 70000 })], { modelId: GLM, domain: 'd', measuredAt: 'now' }).spendIsLowerBound, true,
  'an upstream cache hit marks the spend a FLOOR — a probe repeats one prompt where an ingest cannot');

section('7. isPassingRecord — every refusal direction');

ok(isPassingRecord(record()), 'a clean 9-run record passes');
ok(!isPassingRecord(record({ runsCompleted: 8 })), `${QUALIFY_MIN_RUNS - 1} runs is not enough`);
ok(!isPassingRecord(record({ counts: { unrepairable: 1, unusable: 0, failed: 0 } })), 'one unrepairable refuses');
ok(!isPassingRecord(record({ counts: { unrepairable: 0, unusable: 1, failed: 0 } })), 'one unusable refuses');
ok(!isPassingRecord(record({ counts: { unrepairable: 0, unusable: 0, failed: 1 } })), 'one failed call refuses');
ok(!isPassingRecord(record({ outcome: 'DEFECT_OBSERVED' })), 'a defect outcome refuses');
ok(!isPassingRecord(record({ aborted: 'ABORTED_REASONING_BURN' })), 'an abort refuses');
ok(!isPassingRecord(record({ cancelled: true })), 'a cancelled run refuses');
ok(!isPassingRecord(record({ domain: '' })), 'a record with no domain refuses — scope is not optional');
ok(!isPassingRecord(record({ measuredAt: '' })), 'a record with no date refuses');
// The file is local and hand-editable, so shape validity is the part we CAN check.
ok(!isPassingRecord(record({ counts: { unrepairable: '0', unusable: 0, failed: 0 } })), 'a count hand-edited to a STRING refuses');
ok(!isPassingRecord(record({ counts: {} })), 'missing counts refuse');
ok(!isPassingRecord(record({ runsCompleted: NaN })), 'a NaN run count refuses');
for (const bad of [null, undefined, 0, '', 'yes', [], 42]) {
  ok(!isPassingRecord(bad), `control: ${JSON.stringify(bad) ?? String(bad)} is not a passing record`);
}

section('8. estimateQualification — free, priced and unknown are three states');

const prompt = { promptChars: 341005 };
const free = estimateQualification({ prompt, runs: 9, modelId: 'x/y:free', isFree: true, price: null });
eq(free.cost.kind, 'free', 'a free model reports kind "free"');
eq(free.cost.usd, 0, '…with an exact zero, because that is the truth');

// THE ORDERING BUG THIS GUARDS: getModelPrice returns null for a free model BY
// DESIGN, so reading price first reports every free model as "cost unknown" —
// v3.15.0's Health spend button, where the one model whose cost is known
// exactly was the one labelled unknown.
const unknown = estimateQualification({ prompt, runs: 9, modelId: 'x/y', isFree: false, price: null });
eq(unknown.cost.kind, 'unknown', 'no price posture -> kind "unknown"');
eq(unknown.cost.usd, null, '…and usd null, NEVER 0');
ok(unknown.cost.usd !== free.cost.usd,
  'control: "we have no price" and "it is free" are DIFFERENT values, not both zero');

const priced = estimateQualification({ prompt, runs: 9, modelId: 'x/y', isFree: false, price: { input: 0.5, output: 2 } });
eq(priced.cost.kind, 'priced', 'a priced model reports kind "priced"');
ok(priced.cost.usd > 0, '…with a real figure');
// TIME LEADS. The confirm must be able to say "up to about an hour".
ok(priced.time.slowestSeconds >= 9 * 382, 'the slow end of the time range reflects the slowest model measured (382 s/call)');
ok(priced.time.fastestSeconds <= 9 * 53, 'the fast end reflects the fastest measured (38 s/call)');
ok(priced.time.slowestSeconds / priced.time.fastestSeconds > 5,
  'control: the quoted time band is genuinely WIDE — a narrow band would be a prediction we cannot make');
eq(priced.minRunsToQualify, QUALIFY_MIN_RUNS, 'the estimate states how many runs are needed');

eq(projectRemainingMs([40000, 42000], 7), Math.round((41000 + 1500) * 7), 'the running projection is derived from measured latency');
eq(projectRemainingMs([], 7), null, 'no measurements yet -> no projection, never a guess');
eq(projectRemainingMs([40000], 0), null, 'nothing left to run -> no projection');

// ═════════════════════════════════════════════════════════════════════════════
section('9. qualifyModel — driven end-to-end with an INJECTED transport and clock');

// A fake transport and a fake clock, so the whole ladder runs offline and free.
function fakeCaller(script) {
  let i = 0;
  return async () => {
    const step = script[Math.min(i++, script.length - 1)];
    if (step.throw) throw step.throw;
    return step;
  };
}
let t = 0;
const fakeNow = () => (t += 41000);
const P = { systemPrompt: 's', userPrompt: 'u', maxTokens: 24576, promptChars: 341005, promptSha256: 'abc', sourceName: 'src.md' };
const usable = { text: BARE, model: GLM, finishReason: 'stop', usage: { prompt_tokens: 85000, completion_tokens: 900, cost: 0.004 } };

{
  t = 0;
  const events = [];
  const { record: r } = await qualifyModel({
    modelId: GLM, domain: 'articles', runs: 9, prompt: P, spacingMs: 0,
    callModel: fakeCaller([usable]), now: fakeNow, onProgress: e => events.push(e.type),
  });
  eq(r.outcome, 'NO_DEFECT_FOUND', 'nine usable answers -> NO_DEFECT_FOUND');
  eq(r.runsCompleted, 9, '…nine completed runs');
  ok(isPassingRecord(r), '…and the record qualifies');
  eq(r.domain, 'articles', 'the record is stamped with WHICH wiki');
  ok(typeof r.measuredAt === 'string' && r.measuredAt.length > 0, '…and WHEN');
  eq(events.filter(e => e === 'run').length, 9, 'one progress event per run');
  eq(events[0], 'start', 'the stream opens with `start`');
  eq(events[events.length - 1], 'done', 'the stream closes with `done`');
}

{
  // THE glm-4.7 SHAPE, offline: every structural signal healthy, the JSON
  // unrecoverable. This is the case the whole feature exists to catch.
  t = 0;
  const { record: r } = await qualifyModel({
    modelId: GLM, domain: 'articles', runs: 9, prompt: P, spacingMs: 0,
    // THE REAL RECORDED SHAPE: a DROPPED OBJECT KEY. `jsonrepair` cannot fix it
    // because repair would have to INVENT `"path":`. Verified against the real
    // parseJSON — an earlier draft of this fixture (`{"path" "a.md"`) was
    // repaired into a perfectly usable page, which is exactly why `repaired` is
    // not a defect and why a fixture has to be checked rather than assumed.
    callModel: fakeCaller([{ text: '{"pages":[{ "concepts/knowledge-graph.md", "summary": "x" }]}', model: GLM, finishReason: 'stop', usage: { completion_tokens: 900, cost: 0.004 } }]),
    now: fakeNow,
  });
  eq(r.outcome, 'DEFECT_OBSERVED', 'unrecoverable JSON 9/9 -> DEFECT_OBSERVED');
  eq(r.counts.unrepairable, 9, '…all nine counted');
  ok(!isPassingRecord(r), '…and the record does NOT qualify');
}

{
  // A rate-limited model must not be recorded as broken.
  t = 0;
  const err429 = Object.assign(new Error('rate limited'), { status: 429 });
  const { record: r } = await qualifyModel({
    modelId: GLM, domain: 'articles', runs: 9, prompt: P, spacingMs: 0,
    callModel: fakeCaller([{ throw: err429 }]), now: fakeNow,
  });
  eq(r.outcome, 'NOT_MEASURED', 'three consecutive 429s -> NOT_MEASURED');
  eq(r.aborted, 'NOT_MEASURED_RATE_LIMITED', '…with the reason recorded');
  eq(r.runsAttempted, 3, '…and it stops rather than burning nine attempts on a wall');
  ok(!isPassingRecord(r), '…and it does NOT qualify');
}

{
  // The nex-n2-mini shape: the entire budget on hidden reasoning, nothing back.
  t = 0;
  const { record: r } = await qualifyModel({
    modelId: 'burner/x', domain: 'articles', runs: 9, prompt: P, spacingMs: 0,
    callModel: fakeCaller([{ text: '', model: 'burner/x', finishReason: 'length', usage: { completion_tokens: 24576, completion_tokens_details: { reasoning_tokens: 24576 } } }]),
    now: fakeNow,
  });
  eq(r.aborted, 'ABORTED_REASONING_BURN', 'reasoning burn aborts with POSITIVE evidence, not a guess');
  eq(r.runsAttempted, 3, '…after three runs, not nine');
  eq(r.outcome, 'DEFECT_OBSERVED', '…and it is a defect finding');
}

{
  // CANCEL. Must settle as CANCELLED and never as a model failure.
  t = 0;
  const ac = new AbortController();
  let n = 0;
  const { record: r } = await qualifyModel({
    modelId: GLM, domain: 'articles', runs: 9, prompt: P, spacingMs: 0, signal: ac.signal, now: fakeNow,
    callModel: async () => {
      if (++n === 3) { ac.abort(); throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }
      return usable;
    },
  });
  eq(r.cancelled, true, 'an abort mid-flight settles as cancelled');
  eq(r.outcome, 'CANCELLED', '…with its own outcome');
  eq(r.counts.failed, 0, 'control: a cancelled call is NOT recorded as a model failure');
  ok(!isPassingRecord(r), '…and never qualifies');
}
// CONTROL for the fixture above: a MISSING COLON is repairable and yields a
// usable page, so §9's DEFECT_OBSERVED cannot be coming from "any malformed
// text fails". Only genuinely unrecoverable output does.
{
  const near = classifyResponse('{"pages":[{"path" "concepts/a.md"');
  eq(near.parseClass, 'repaired', 'control: a missing colon IS repaired…');
  eq(near.usable, true, '…into a usable page — so the defect fixture is not just "malformed text"');
}

ok(isCancelledError({ name: 'AbortError' }), 'an AbortError is recognised as a cancel');
ok(isCancelledError({ code: 'QUALIFY_CANCELLED' }), 'our own cancel code is recognised');
ok(!isCancelledError(new Error('boom')), 'control: an ordinary error is NOT a cancel');

// ═════════════════════════════════════════════════════════════════════════════
section('10. THE THIRD BUILD LANE — llm.js');

llm.setOpenRouterCatalogue([spec(GLM)]);
llm.clearLocalQualifications();

eq(llm.isOfferableModel('openrouter', GLM), true, 'the fetched model is offerable (chat)');
eq(llm.isBuildLaneModel('openrouter', GLM), false, 'with no record it is NOT in the build lane');

llm.recordLocalQualification(record({ runsCompleted: 2, counts: { raw: 2, repaired: 0, unrepairable: 0, unusable: 0, notMeasured: 0, failed: 0 } }));
eq(llm.isBuildLaneModel('openrouter', GLM), false, `a ${QUALIFY_MIN_RUNS - 7}-run record does NOT promote it`);

llm.recordLocalQualification(record());
eq(llm.isLocallyQualified('openrouter', GLM), true, 'a clean 9-run record locally qualifies it');
eq(llm.isBuildLaneModel('openrouter', GLM), true, '…and THAT is what puts it in the build lane');

// THE POINT OF THE THIRD STATE: the wire fact stays chat-only, so the UI can
// tell "we measured this" apart from "you measured this".
const entry = llm.listOfferableModels('openrouter').find(m => m.id === GLM);
eq(entry.suitability, 'chat-only', 'a locally-qualified model still reports suitability chat-only on the wire');
eq(entry.jsonRaw, null, '…and still reports jsonRaw null — WE have not measured it');

// The pin now actually GOVERNS. Storing a selection that llm.js then discards
// would be the stored-but-inert shape: "your choice" on screen, a different
// model doing the work, and a different price.
cfg.setSelectedModel('openrouter', GLM);
eq(llm.getDefaultModel('openrouter'), GLM, 'the pin GOVERNS — getDefaultModel resolves the qualified model');
eq(llm.getProviderInfo().model, GLM, '…and so does getProviderInfo, which is what ingest actually calls');

llm.recordLocalQualification(record({ outcome: 'DEFECT_OBSERVED', counts: { raw: 0, repaired: 0, unrepairable: 9, unusable: 0, notMeasured: 0, failed: 0 } }));
eq(llm.isBuildLaneModel('openrouter', GLM), false, 'a defect record demotes it again');
ok(llm.getDefaultModel('openrouter') !== GLM, '…and the resolved model falls back rather than staying pinned');

section('11. Invalidation on catalogue exit — void, but not destroyed');

llm.recordLocalQualification(record());
eq(llm.isBuildLaneModel('openrouter', GLM), true, 'qualified again');
llm.setOpenRouterCatalogue([]);
eq(llm.isLocallyQualified('openrouter', GLM), false, 'leaving the eligible catalogue voids the qualification IMMEDIATELY');
eq(llm.isBuildLaneModel('openrouter', GLM), false, '…and it leaves the build lane with it');
ok(llm.getLocalQualification(GLM) !== null,
  'the EVIDENCE survives — a measurement cost the user real money and up to an hour, and is not destroyed by a short catalogue fetch');
llm.setOpenRouterCatalogue([spec(GLM)]);
eq(llm.isBuildLaneModel('openrouter', GLM), true, 'and it is restored when the model returns, without a re-run');

section('12. A local run may FILL A GAP, never OVERTURN our own negative finding');

// gemini-3.5-flash-lite is chat-only with jsonRaw FALSE: nine live runs found
// unrepairable JSON in 2 of them. A user who gets nine clean runs on their own
// wiki has sampled the other 78%, not refuted it.
const gem = llm.listOfferableModels('gemini').find(m => m.jsonRaw === false);
ok(!!gem, 'control: there IS a hand-measured chat-only model with jsonRaw false to attack');
llm.recordLocalQualification(record({ modelId: gem.id }));
eq(llm.isLocallyQualified('gemini', gem.id), false, 'a local record cannot qualify a NON-OpenRouter model');
eq(llm.isBuildLaneModel('gemini', gem.id), false, `…and ${gem.id} stays out of the build lane`);

// ── THE SAME RULE INSIDE OPENROUTER ────────────────────────────────────────
// `jsonRaw === null` is llm.js's own marker for "no measurement is recorded on
// this entry". Every entry the live mapper produces today carries null, so the
// clause looks inert — but `defineOfferableModel` PERMITS a chat-only entry to
// carry a boolean, and a future mapper reading `supported_parameters` off the
// provider is exactly the tempting mistake `docs/model-lifecycle.md` warns
// about ("metadata says a model ACCEPTS JSON mode; it cannot say the JSON
// PARSES"). If such an entry ever declares `jsonRaw: false`, a user's nine
// clean runs must not silently overturn it — nine clean runs are consistent
// with the same model failing 2 in 9.
//
// This is the assertion that makes that clause load-bearing rather than
// decorative: without it, dropping the check leaves the whole suite green.
{
  const MEASURED = 'measured/chat-only';
  llm.setOpenRouterCatalogue([spec(MEASURED, { jsonRaw: false })]);
  const e = llm.listOfferableModels('openrouter').find(m => m.id === MEASURED);
  ok(!!e && e.jsonRaw === false,
    'control: a chat-only OpenRouter entry CAN carry a measured jsonRaw:false — the shape is reachable');
  llm.recordLocalQualification(record({ modelId: MEASURED }));
  eq(llm.isLocallyQualified('openrouter', MEASURED), false,
    'a clean 9-run local record does NOT overturn a recorded jsonRaw:false verdict');
  eq(llm.isBuildLaneModel('openrouter', MEASURED), false,
    '…and the model stays out of the build lane');
  // CONTROL: the identical entry WITHOUT the recorded verdict does qualify, so
  // the refusal above is the jsonRaw clause and not something else.
  const UNMEASURED = 'unmeasured/chat-only';
  llm.setOpenRouterCatalogue([spec(UNMEASURED)]);
  llm.recordLocalQualification(record({ modelId: UNMEASURED }));
  eq(llm.isLocallyQualified('openrouter', UNMEASURED), true,
    'control: the identical entry with NO recorded verdict DOES qualify — so the clause is what refused, not the record');
}

llm.setOpenRouterCatalogue([spec(GLM)]);
llm.recordLocalQualification(record());
eq(llm.isLocallyQualified('openrouter', 'not/in-catalogue'), false, 'an id we do not offer never qualifies');
eq(llm.isLocallyQualified('openrouter', '__proto__'), false, 'a prototype-shaped id never qualifies');
eq(llm.isLocallyQualified('openrouter', 'constructor'), false, 'neither does `constructor`');
eq(llm.isLocallyQualified('anthropic', GLM), false, 'the predicate is OpenRouter-only');
eq(llm.isBuildLaneModel('openrouter', null), false, 'a null id fails closed');

section('13. THE TWO PRE-EXISTING chat-only LAYERS ARE STILL INDEPENDENTLY LOAD-BEARING');

// Both layers exist to stop a FETCHED entry reaching the build lane, and the
// third-lane change must not have weakened either. They are proven SEPARATELY
// here, because "the feature still works" would pass with one of them gone.
//
// LAYER 1 — defineOfferableModel({dynamic:true}) refuses a non-chat-only spec.
{
  let threw = null;
  try {
    llm.__testing.defineOfferableModel('openrouter', spec('layer/one', { suitability: 'general', jsonRaw: true }), { dynamic: true });
  } catch (e) { threw = e; }
  ok(!!threw, 'LAYER 1 fires: a dynamic spec declaring a BUILD-lane suitability is refused at the factory');
  ok(threw && /chat-only/.test(String(threw.message)),
    '…and the refusal names the rule, so a builder that mis-declares finds out why');
  // CONTROL: the same spec as chat-only is admitted, so layer 1 is not simply
  // refusing everything.
  let ok2 = true;
  try { llm.__testing.defineOfferableModel('openrouter', spec('layer/one'), { dynamic: true }); } catch { ok2 = false; }
  ok(ok2, 'control: the identical spec IS admitted as chat-only — layer 1 refuses the declaration, not the model');
}

// LAYER 2 — setOpenRouterCatalogue re-checks the BUILT entry, so it holds even
// if a future refactor changes HOW the factory decides a lane.
{
  const r = llm.setOpenRouterCatalogue([spec('layer/two', { suitability: 'general', jsonRaw: true })]);
  eq(r.admitted, 0, 'LAYER 2 fires: a build-lane spec is not admitted to the runtime catalogue');
  eq(r.refused, 1, '…it is counted as refused, not silently coerced');
  eq(llm.isBuildLaneModel('openrouter', 'layer/two'), false, '…and it never reaches the build lane');
  const r2 = llm.setOpenRouterCatalogue([spec('layer/two')]);
  eq(r2.admitted, 1, 'control: the identical spec as chat-only IS admitted — layer 2 is not refusing everything');
}

// AND the third lane cannot be reached by the catalogue itself: only by a
// stored record, which the catalogue cannot write.
llm.setOpenRouterCatalogue([spec(GLM)]);
llm.clearLocalQualifications();
eq(llm.isBuildLaneModel('openrouter', GLM), false,
  'with the catalogue re-synced and the records cleared, nothing fetched is in the build lane');

section('14. Persistence — a hand-edited file must not be able to promote a model');

llm.recordLocalQualification(record());
const file = path.join(TMP, '.openrouter-qualifications.json');
ok(fs.existsSync(file), 'the record is persisted beside the catalogue, in user data');
ok(!fs.existsSync(path.join(process.env.CURATOR_TEST_DOMAINS_DIR, '.openrouter-qualifications.json')),
  'control: it is NOT written into domains/ — that folder is Personal Sync\'s git work-tree');

llm.clearLocalQualifications();
eq(llm.isBuildLaneModel('openrouter', GLM), false, 'cleared');
fs.writeFileSync(file, JSON.stringify({ version: 1, records: [record()] }));
const restored = llm.restoreLocalQualifications();
eq(restored.restored, true, 'a persisted record is re-admitted at boot');
eq(llm.isBuildLaneModel('openrouter', GLM), true, '…and grants the lane again');

// Malformed input degrades to "not qualified", never to a throw at boot. Tested
// from the BOOT state (nothing loaded), because that is the only state in which
// restore actually runs.
for (const bad of ['{', '{"records":"x"}', '{"version":1,"records":[{"modelId":123}]}', '']) {
  llm.clearLocalQualifications();
  fs.writeFileSync(file, bad);
  let threw = false;
  try { llm.restoreLocalQualifications(); } catch { threw = true; }
  ok(!threw, `a corrupt qualifications file (${JSON.stringify(bad).slice(0, 24)}…) does not throw at boot`);
  eq(llm.isBuildLaneModel('openrouter', GLM), false, '…and grants nothing');
}

// DELIBERATE, and asserted so it is not "fixed" later: an unreadable file does
// not DESTROY records already in memory. Same posture as a failed catalogue
// sync leaving the previous catalogue intact — losing a measurement the user
// paid an hour for, because one read failed, is the worse of the two outcomes.
fs.writeFileSync(file, JSON.stringify({ version: 1, records: [record()] }));
llm.restoreLocalQualifications();
eq(llm.isBuildLaneModel('openrouter', GLM), true, 'loaded');
fs.writeFileSync(file, 'not json');
llm.restoreLocalQualifications();
eq(llm.isBuildLaneModel('openrouter', GLM), true,
  'a later unreadable read leaves the already-loaded record intact rather than discarding it');

// The most important hand-edit: claiming a pass for a model WE measured as bad.
fs.writeFileSync(file, JSON.stringify({ version: 1, records: [record({ modelId: gem.id })] }));
llm.restoreLocalQualifications();
eq(llm.isBuildLaneModel('gemini', gem.id), false,
  'a hand-written record cannot promote a model WE measured and found unfit');

section('15. THE UI STRINGS — the honesty rules are IN the rendered output');

// The rules this feature is built on live in prose that a user reads, so they
// are asserted against the REAL rendered HTML rather than against the record.
// The two renderers are lifted out of settings.js by brace-matching and
// EXECUTED — a source grep would pass over a function that is never called, and
// this repo has shipped exactly that.
function lift(src, name) {
  const at = src.indexOf('function ' + name + '(');
  if (at === -1) throw new Error('could not locate ' + name);
  let i = src.indexOf('{', at), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(at, j + 1);
  }
  throw new Error('unbalanced braces in ' + name);
}
const settingsSrc = fs.readFileSync(new URL('../src/public/next/views/settings.js', import.meta.url), 'utf8');
// v3.16.0 — `formatSyncedAt` is LIFTED, not injected as a stub, so this suite
// exercises the real humaniser the view actually uses. It arrived when the model
// row's date stamp stopped rendering a raw ISO string, and its absence here did
// NOT fail this suite — it CRASHED it with a bare `ReferenceError`, so every
// assertion after the lift never ran. That is the v3.14.0 `FN_NAMES` blind spot:
// a hardcoded lift list goes blind the moment the lifted function gains a new
// dependency, and a crash is not a failure. The try/catch below converts that
// class into a NAMED assertion, so the next new dependency is reported rather
// than silently ending the run.
/**
 * A top-level `const NAME = <one expression>;` out of settings.js.
 *
 * `lift` above brace-matches and therefore cannot take a const with no body.
 * LIFTED rather than re-declared here for the reason the docblock above gives
 * for formatSyncedAt: a literal copied into this file keeps every assertion
 * green after the module renames the id, and the id is what revealInMain
 * scrolls to — so a stale copy here would hide a confirm panel that has become
 * unreachable.
 */
function liftConst(src, name) {
  const re = new RegExp(`(?:^|\\n)(?:export\\s+)?const ${name} = [^\\n;]*;`);
  const m = re.exec(src);
  if (!m) throw new Error(`liftConst: "${name}" not found in settings.js`);
  return m[0].trim().replace(/^export\s+/, '');
}
/**
 * The same, for a const whose value is a multi-line OBJECT literal.
 *
 * `liftConst` above is deliberately one-line-only, and a `[^\n;]*` regex cannot
 * be widened to cover an object without also swallowing whatever follows it.
 * Brace-matched instead, which is the same technique `lift` uses for a function
 * body. Lifted rather than re-declared here for the reason stated throughout
 * this file: a copy in this suite keeps every assertion green after the module
 * changes a value.
 */
function liftObjectConst(src, name) {
  const re = new RegExp(`(?:^|\\n)(?:export\\s+)?const ${name} = \\{`);
  const m = re.exec(src);
  if (!m) throw new Error(`liftObjectConst: "${name}" not found in settings.js`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  let i = src.indexOf('{', m.index), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  if (depth !== 0) throw new Error(`liftObjectConst: "${name}" never closed — the brace match desynced`);
  return src.slice(start, i + 1).trim().replace(/^export\s+/, '') + ';';
}
let ui;
try {
ui = new Function('escapeHtml', 'formatIsoDay', 'formatUsdHonest',
  liftConst(settingsSrc, 'QUALIFY_CONFIRM_ID') + '\n' +
  // The measured per-model latency baseline renderQualification quotes, and the
  // own-property lookup that reads it. Both LIFTED: the table's values are what
  // the rendered sentence prints, so a copy here would assert this file agrees
  // with itself.
  liftObjectConst(settingsSrc, 'MEASURED_CALL_SECONDS') + '\n' +
  lift(settingsSrc, 'measuredCallSeconds') + '\n' +
  lift(settingsSrc, 'formatSyncedAt') + '\n' +
  lift(settingsSrc, 'formatTokenCount') + '\n' +
  lift(settingsSrc, 'formatDuration') + '\n' +
  lift(settingsSrc, 'renderQualification') + '\n' +
  lift(settingsSrc, 'renderQualifyPanel') + '\n' +
  'return { renderQualification, renderQualifyPanel, formatDuration, QUALIFY_CONFIRM_ID, measuredCallSeconds, MEASURED_CALL_SECONDS };'
)(
  str => String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  iso => String(iso).slice(0, 10),
  n => (typeof n === 'number' && Number.isFinite(n)) ? (n === 0 ? '$0.00' : (Math.abs(n) < 0.01 ? '$' + n.toFixed(4) : '$' + n.toFixed(2))) : null,
);
} catch (err) {
  ok(false, '§0 GUARD: the lifted view functions must CONSTRUCT — a missing dependency in the ' +
    'hardcoded lift list crashes this suite instead of failing it, so every later assertion ' +
    'silently never runs (' + (err && err.message) + ')');
  ui = { renderQualification: () => '', renderQualifyPanel: () => '', formatDuration: () => '' };
}
// ── AND THEY MUST CONSTRUCT *AND RUN* ────────────────────────────────────────
// FOUND THE HARD WAY, 2026-09-02: the guard above catches a dependency missing
// at CONSTRUCTION, and `new Function` resolves nothing at construction time — so
// a helper the lift list forgot only throws when the function is CALLED, which
// happened twelve lines below the guard and killed the run with a bare
// ReferenceError. Construction is not the boundary; the first call is. This
// smoke call moves the boundary to where it belongs, and it renders a record
// carrying EVERY optional block (pages, latency, spend) so a dependency reached
// only from one conditional branch is still exercised.
try {
  ui.renderQualification(Object.assign(record(), {
    qualifies: true, stillOffered: true,
    pages: { median: 23, min: 14, max: 36, n: 9 },
    latencyMs: { mean: 41000, min: 38000, max: 44000, n: 9 },
    spendUsd: 0.0687, spendComplete: true, spendIsLowerBound: false,
    sourceName: 'report.md',
  }), 9, 'upstage/solar-pro4');
  ok(true, '§0 GUARD: the lifted view functions also RUN — every binding they reach resolves');
} catch (err) {
  ok(false, '§0 GUARD: a lifted view function CONSTRUCTED but threw when called — the lift list ' +
    'is missing a dependency reached at call time (' + (err && err.message) + ')');
  ui = { renderQualification: () => '', renderQualifyPanel: () => '', formatDuration: () => '' };
}

const cleanHtml = ui.renderQualification(Object.assign(record(), {
  qualifies: true, stillOffered: true,
  pages: { median: 23, min: 14, max: 36, n: 9 },
  latencyMs: { mean: 41000, min: 38000, max: 44000, n: 9 },
  spendUsd: 0.0687, spendComplete: true, spendIsLowerBound: false,
  sourceName: 'report.md',
  // The BASELINE model id, third argument since 2026-09-02. It used to be a
  // literal "about 53 s" inside the sentence, untied to any model — so a bump of
  // DEFAULTS.openrouter would have left this panel attributing one model's
  // timing to another. Passing the real shipping default here means the
  // assertion below reads the same table the module does.
}), 9, llm.getDefaultModel('openrouter'));

// THE FORBIDDEN WORDS. This is the claim the feature may not make, and a grep
// over rendered output is the only guard that survives a rewrite of the prose.
ok(!/verified/i.test(cleanHtml), 'the rendered result never says "verified"');
ok(!/\bguarantee[sd]?\b/i.test(cleanHtml.replace(/not a guarantee/i, '')), 'it never claims a guarantee');
ok(!/\bbetter than\b|\brecommend/i.test(cleanHtml),
  'it makes no COMPARATIVE claim — that is the judgement a machine may not write');
ok(/No defect found/.test(cleanHtml), 'the strongest phrase it uses is "no defect found"');
// THE RULE OF THREE, ON SCREEN.
ok(/screen, not a guarantee/i.test(cleanHtml), 'the caveat is rendered, not merely commented');
ok(/33%/.test(cleanHtml), '…and states the actual bound for 9 runs (~33%)');
// SCOPE.
// Scoped to the STAMP ELEMENT, not to the whole blob. An earlier version
// searched the entire HTML, and the domain also appears in the headline — so
// deleting the stamp left the assertion green. Mutation-proven after the fix.
{
  const m = cleanHtml.match(/<p class="model-qual-stamp">([\s\S]*?)<\/p>/);
  ok(!!m, 'the render carries a dedicated scope stamp element');
  const stamp = m ? m[1] : '';
  // v3.16.0: the stamp no longer renders a RAW ISO string — that was a defect
  // found in the live end-to-end pass, where every other date on the screen was
  // humanised and this one was not. The assertion therefore pins the INTENT
  // (which wiki, and when) plus the fix, rather than the old literal. It is
  // deliberately TIMEZONE-SAFE: `formatSyncedAt` reads local getDate/getMonth,
  // so asserting a specific day would pass on the author's machine and fail in
  // another zone — v3.14.0's recorded lesson. Year + month-name + domain is
  // stable everywhere, and the no-raw-ISO check is what actually guards the fix.
  ok(/articles/.test(stamp),
    'the STAMP carries WHICH wiki — a measurement is never a global claim');
  ok(/\b2026\b/.test(stamp) && /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/.test(stamp),
    'the STAMP carries WHEN, humanised (month name + year), not a machine timestamp');
  ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(stamp),
    'the STAMP does NOT render a raw ISO timestamp — the defect the live pass found');
  ok(/report\.md/.test(stamp), '…and which source document');
}
// LATENCY IS A HEADLINE FACT.
ok(/per call/.test(cleanHtml), 'latency is rendered as a first-class fact');
// …beside the shipping default. DERIVED from the module's own table, not
// pinned: a literal 53 here would keep this green after DEFAULTS.openrouter
// moved to a model with a different measured mean, which is the exact defect
// the third argument exists to prevent.
{
  const shippedId = llm.getDefaultModel('openrouter');
  const baseline = ui.measuredCallSeconds(shippedId);
  ok(baseline !== null,
    `CONTROL: the shipping OpenRouter default (${shippedId}) HAS a measured mean (${baseline} s), so the assertion below is not vacuous`);
  ok(new RegExp('averages about ' + baseline + ' s').test(cleanHtml),
    '…beside the shipping default, so the reader can judge it');
  ok(cleanHtml.includes(shippedId),
    '…and the baseline NAMES the model it belongs to, rather than an unfalsifiable "the model this app ships"');
  ok(Object.prototype.hasOwnProperty.call(ui.MEASURED_CALL_SECONDS, shippedId),
    '…read out of the module\'s own measured table, so a DEFAULTS bump to an untimed model drops the clause instead of lying');
}
ok(/23 pages/.test(cleanHtml), 'median pages planned is rendered');
ok(/9 raw/.test(cleanHtml) && /0 unrepairable/.test(cleanHtml), 'the raw/repaired/unrepairable split is rendered');

const defectHtml = ui.renderQualification(Object.assign(record({
  outcome: 'DEFECT_OBSERVED',
  counts: { raw: 0, repaired: 0, unrepairable: 9, unusable: 0, notMeasured: 0, failed: 0 },
}), { qualifies: false, stillOffered: true, pages: {}, latencyMs: {} }), 9);
ok(/could not be repaired/.test(defectHtml), 'a defect result NAMES what went wrong');
ok(!/screen, not a guarantee/i.test(defectHtml),
  'control: the rule-of-three caveat is NOT attached to a defect result — a defect was OBSERVED, which is the stronger claim');

const shortHtml = ui.renderQualification(Object.assign(record({ runsCompleted: 3 }), { qualifies: false, stillOffered: true, pages: {}, latencyMs: {} }), 9);
ok(/only 3 of the 9 runs/.test(shortHtml), 'a clean-but-short result says WHICH bar it missed, rather than reading as an unexplained refusal');

const staleHtml = ui.renderQualification(Object.assign(record(), { qualifies: false, stillOffered: false, pages: {}, latencyMs: {} }), 9);
ok(/no longer in your synced model list/.test(staleHtml), 'a voided measurement says why');
ok(/kept here rather than deleted/.test(staleHtml), '…and that the evidence was not destroyed');

// MONEY, THE TRI-STATE, IN THE RENDERED CONFIRM.
const confirmUnknown = ui.renderQualifyPanel({ modelId: 'a/b', phase: 'confirm', estimate: { runs: 9, domain: 'articles', promptChars: 341005, cost: { kind: 'unknown', usd: null }, time: { fastestSeconds: 342, slowestSeconds: 3438, note: 'n' } } }, 9);
ok(/cannot be estimated/.test(confirmUnknown), 'an unpriced model says the cost cannot be estimated');
ok(!/\$0\.00/.test(confirmUnknown), '…and NEVER renders $0.00 — the fact-and-its-absence collapse');
const confirmFree = ui.renderQualifyPanel({ modelId: 'a/b', phase: 'confirm', estimate: { runs: 9, domain: 'articles', promptChars: 341005, cost: { kind: 'free' }, time: { fastestSeconds: 342, slowestSeconds: 3438, note: 'n' } } }, 9);
ok(/costs nothing/.test(confirmFree), 'a FREE model says it costs nothing — the one case where zero is the truth');
ok(confirmUnknown !== confirmFree, 'control: "unpriced" and "free" render DIFFERENTLY');
// TIME LEADS.
ok(confirmFree.indexOf('Time:') < confirmFree.indexOf('costs nothing'),
  'TIME is stated BEFORE money — it is the binding constraint (6 to 57 minutes against $0.08-$0.38)');
ok(/57 minutes|<strong>Time: roughly 6 to 57/.test(confirmFree.replace(/\s+/g, ' ')) || /to 57 minutes/.test(confirmFree),
  'the confirm quotes the slow end honestly rather than an optimistic single figure');

// XSS. Every value originates in llm.js but arrives over HTTP, and a model id
// is a third party's string.
const evil = ui.renderQualification(Object.assign(record({ domain: '<img src=x onerror=alert(1)>', modelId: '"><script>' }), { qualifies: true, stillOffered: true, pages: {}, latencyMs: {}, sourceName: '<b>x</b>' }), 9);
ok(!/<img|<script|<b>/.test(evil), 'every interpolated value is escaped — a hostile domain name cannot inject markup');
ok(/&lt;img/.test(evil), 'control: the hostile value IS present, escaped — the check above is not passing because the value vanished');

// ═════════════════════════════════════════════════════════════════════════════
console.log(`\n${'─'.repeat(60)}`);
// ── §GUARD  THE QUOTED TIME RANGE MUST BOUND THE WORST CASE ────────────────
// This constant is what the confirm dialog leads with. Changing it from 382 to
// 600 broke NOTHING — nothing pinned it, so it could drift back silently. 600 s
// is the adapter's ENFORCED per-call ceiling, a true bound rather than a sampled
// maximum: two calls in the measurement session hit it (one at 988 s of wall
// clock) while the slowest call that SUCCEEDED was 382 s. An estimate built only
// from successes is optimistic exactly where the user most needs it not to be.
// `>=` rather than `===` so the ceiling can rise without a false red.
// NOTE ON WHERE THIS LIVES: it must sit ABOVE the summary print. A first draft
// appended it after `process.exit(1)`, where it never ran and silently added
// nothing — the same mistake recorded in this repo's own handoff notes.
{
  const { fast, slow } = q.QUALIFY_OBSERVED_CALL_SECONDS;
  ok(Number.isFinite(fast) && Number.isFinite(slow), 'the quoted time range is two real numbers');
  ok(slow >= 600,
    'the quoted UPPER bound is at least the adapter per-call ceiling (600 s) — an estimate built ' +
    'only from calls that SUCCEEDED under-quotes the case the user most needs quoted (got ' + slow + ')');
  ok(fast > 0 && fast < slow, 'the quoted range is ordered and positive');
}

console.log(`Passed: ${passed}   Failed: ${failed}`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
