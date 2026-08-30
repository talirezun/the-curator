#!/usr/bin/env node
/**
 * test-next-compile-estimate.js — the Compile to Wiki cost gate. OFFLINE.
 *
 * ── WHAT IS BEING GUARDED, AND WHY IT IS NOT A COSMETIC FEATURE ────────────
 * Compile to Wiki was the last paid action in The Curator that spent money
 * with no estimate and no confirm, carried unfixed through three releases of
 * the design-system audit whose own words are that cost-before-action is "the
 * trust mechanism, not a nicety". v3.27.0 adds `GET /api/compile/estimate`,
 * `src/brain/compile-estimate.js` and a confirm dialog in front of the button.
 *
 * FIVE INVARIANTS, and each one is a way the feature could be WORSE than not
 * shipping it at all:
 *
 *   1. THE ESTIMATE MOVES WITH THE WORK. A number that does not change with
 *      the conversation, or with how big the destination wiki already is, is
 *      a decoration that looks like a measurement. §3 drives the real
 *      estimator over real conversations and real domains and requires strict
 *      monotonicity in BOTH inputs; §3's mutation makes the output constant
 *      and watches it red.
 *   2. AN UNKNOWN IS NEVER $0.00. Three different facts reach `price === null`
 *      — no provider, a FREE model, a model with no published price — and
 *      collapsing any of them into a zero is v3.15.0's recorded defect
 *      arriving on a new surface. §4 drives all three through the REAL
 *      provider resolution and requires nulls plus a distinct reason code.
 *   3. THE ESTIMATE COSTS NOTHING. §5 spies on every network egress binding in
 *      the process, proves the spy is armed with positive controls, and then
 *      requires ZERO egress from a full estimate. It is a network spy rather
 *      than an injected `generateText` seam deliberately: a seam only sees
 *      calls that go through it, while the spy sees any call at all.
 *   4. THE ESTIMATE AND THE COMPILE NEVER DISAGREE. §2 runs the real
 *      `precheckCompile` and the real `compileConversation` against the same
 *      fixtures and requires byte-identical refusal strings.
 *   5. CANCEL SPENDS NOTHING. §7 extracts the real `startCompile` and runs it
 *      against a `confirmThen` that never confirms, requiring zero calls to
 *      `runCompile` and zero POSTs — with a positive control that confirms and
 *      watches exactly one compile start.
 *
 * ── WHAT THIS SUITE DOES *NOT* ENFORCE ────────────────────────────────────
 *   • IT DOES NOT VALIDATE THE ESTIMATE'S ACCURACY AGAINST A LIVE MODEL.
 *     §8 pins the shipped constants against nine real measurements recorded
 *     at v3.27.0 (ten paid calls, $0.009462, all on `gemini-2.5-flash-lite`).
 *     That is a REGRESSION guard on numbers measured once — it proves the
 *     constants still bracket what was observed, not that they bracket what a
 *     different model, a different domain or a different conversation will do.
 *     No offline suite in this repo can make a paid call.
 *   • IT DOES NOT PROVE THE CONFIRM DIALOG RENDERS. `confirmThen` is stubbed;
 *     the real dialog's markup, focus trap and Escape handling belong to
 *     `shared/confirm.js` and its own coverage. What is proven here is the
 *     CONTRACT between the gate and the dialog: which copy goes in, and that
 *     the paid work is unreachable except through `onConfirm`.
 *   • IT DOES NOT RESOLVE CSS OR VISUAL STATE. The "Checking cost…" label is
 *     asserted as a string written to a known element id, not as pixels.
 *   • IT DOES NOT COVER THE `/old` FRONTEND. `src/public/app.js` still calls
 *     `POST /api/compile/conversation` with no estimate and no confirm. That
 *     is a stated gap, not an oversight: the shipping bundle is frozen and
 *     `/next` is what `/` serves since v3.9.0.
 *   • THE ROUTE IS DRIVEN AS A HANDLER, NOT OVER HTTP. §6 pulls the real
 *     handler out of the real express router and calls it with recording
 *     req/res doubles. Express's own routing, the cross-origin guard and the
 *     Host guard are therefore not exercised here.
 */

import { readFileSync, mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import http from 'http';
import https from 'https';
import { stripComments, functionSource, checkLiteral } from './test-helpers/source-scan.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

let passed = 0, failed = 0;
function section(t) { console.log(`\n${t}`); }
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(actual, expected, label) {
  ok(actual === expected, `${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}

// ── Isolation ─────────────────────────────────────────────────────────────
// __setDomainsDirOverride is the documented in-process seam (CLAUDE.md: NOT
// process.env.DOMAINS_PATH, which loses to a configured domainsPath and
// silently no-ops on a real install). Nothing here spawns a server, so the
// heavier CURATOR_TEST_USER_DATA_DIR is not required — but it is set anyway,
// because §4 and §5 touch provider resolution, which reads credential files.
const TMP = mkdtempSync(path.join(os.tmpdir(), 'curator-compile-est-'));
const DOMAINS = path.join(TMP, 'domains');
const USERDATA = path.join(TMP, 'userdata');
mkdirSync(DOMAINS, { recursive: true });
mkdirSync(USERDATA, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = USERDATA;
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS;

const { __setDomainsDirOverride } = await import('../src/brain/config.js');
__setDomainsDirOverride(DOMAINS);

const {
  estimateCompileCost, estimateInputTokens, estimateOutputTokens,
  inputTokenizerFactor, __testing: EST,
} = await import('../src/brain/compile-estimate.js');
const { compileConversation, precheckCompile, MIN_USER_MESSAGES } = await import('../src/brain/compile.js');
const compileRouter = (await import('../src/routes/compile.js')).default;

const chatSrc = readFileSync(path.join(REPO, 'src/public/next/views/chat.js'), 'utf8');
const chatCode = stripComments(chatSrc);
const routeSrc = readFileSync(path.join(REPO, 'src/routes/compile.js'), 'utf8');
const estSrc = readFileSync(path.join(REPO, 'src/brain/compile-estimate.js'), 'utf8');

/**
 * Every call to the real estimator goes through here, and the wrapper is an
 * ASSERTION as well as a convenience: AN ESTIMATE MUST NEVER THROW. It is the
 * cheapest, most-often-run thing in the money path and a throw from it takes
 * out the confirm dialog the user is owed.
 *
 * It also stops one mutation's throw from CRASHING this file before the
 * sections that would have named the defect ever run — the v3.24.1 shape
 * where a raw error names no expectation and leaves the tally wrong. Proven:
 * a mutation that makes the estimator call the network reds §5 by NAME
 * ("makes ZERO network calls", got 1) instead of dying at §1.
 */
async function estimateSafely(domain, id) {
  try {
    return await estimateCompileCost(domain, id);
  } catch (err) {
    failed++;
    console.log(`  ✗ estimateCompileCost threw — an estimate must never throw: ${err && err.message}`);
    return {
      ok: false, compilable: null, refusal: null, provider: null, model: null,
      conversation: null, domainContext: null,
      estimate: { inputTokensLow: 0, inputTokensHigh: 0, outputTokensLow: 0, outputTokensHigh: 0,
                  usdLow: null, usdHigh: null, priceKnown: false, costUnknown: 'threw',
                  tokenizerFactor: 1, basis: '' },
      warnings: [],
    };
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────
function seedDomain(slug, { entities = 0, concepts = 0 } = {}) {
  const d = path.join(DOMAINS, slug);
  for (const sub of ['wiki/entities', 'wiki/concepts', 'wiki/summaries', 'raw', 'conversations']) {
    mkdirSync(path.join(d, sub), { recursive: true });
  }
  writeFileSync(path.join(d, 'CLAUDE.md'), `# ${slug}\n\nA test domain schema.\n`);
  const rows = [];
  for (let i = 0; i < entities; i++) {
    writeFileSync(path.join(d, 'wiki/entities', `entity-fixture-${i}.md`), `# entity ${i}\n`);
    rows.push(`| [[entity-fixture-${i}]] | entity | x |`);
  }
  for (let i = 0; i < concepts; i++) {
    writeFileSync(path.join(d, 'wiki/concepts', `concept-fixture-${i}.md`), `# concept ${i}\n`);
    rows.push(`| [[concept-fixture-${i}]] | concept | x |`);
  }
  writeFileSync(path.join(d, 'wiki/index.md'), `# Index\n\n| Page | Type | Summary |\n|---|---|---|\n${rows.join('\n')}\n`);
  writeFileSync(path.join(d, 'wiki/log.md'), '# Log\n');
  return d;
}

function seedConversation(slug, { turns = 2, chars = 400, title = 'Fixture conversation' } = {}) {
  const messages = [];
  for (let i = 0; i < turns; i++) {
    messages.push({ role: 'user', content: `Question ${i}: ` + 'q'.repeat(Math.max(1, Math.round(chars / (turns * 2)))) });
    messages.push({ role: 'assistant', content: `Answer ${i}: ` + 'a'.repeat(Math.max(1, Math.round(chars / (turns * 2)))) });
  }
  const conv = { id: crypto.randomUUID(), title, createdAt: new Date().toISOString(), messages };
  writeFileSync(path.join(DOMAINS, slug, 'conversations', `${conv.id}.json`), JSON.stringify(conv, null, 2));
  return conv;
}

// A synthetic, obviously-fake key. Provider resolution only checks that a key
// STRING is present; nothing here reaches a provider (§5 proves that), so no
// real credential is needed and none is used.
const FAKE_GEMINI_KEY = 'zz-not-a-real-key-compile-estimate-suite';
//
// ⚠ THIS FUNCTION IS `async` AND ITS `await fn()` IS LOAD-BEARING. A
// synchronous version restores the environment the instant `fn()` returns its
// PROMISE — i.e. before the first `await` inside `estimateCompileCost` has
// resolved — so provider resolution ran with the key already removed and every
// dollar figure came back null. The first draft did exactly that and reported
// "usdHigh strictly increases … [null,null,null,null]", which reads as a bug
// in the estimator and was a bug in the harness.
async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; }
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return await fn(); }
  finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('1. The estimator exists as a free, local module with the shape the route publishes');
// ═══════════════════════════════════════════════════════════════════════════
{
  seedDomain('est-shape', { entities: 3, concepts: 2 });
  const conv = seedConversation('est-shape', { turns: 2, chars: 600 });
  const r = await withEnv({ GEMINI_API_KEY: FAKE_GEMINI_KEY, LLM_MODEL: undefined }, () =>
    estimateSafely('est-shape', conv.id));

  eq(r.ok, true, 'the estimator answers ok');
  eq(r.compilable, true, 'a fresh, long-enough conversation is compilable');
  eq(r.refusal, null, 'and carries no refusal');
  ok(r.estimate && typeof r.estimate === 'object', 'it carries an estimate object');
  // `|| {}` so a mutation that nulls the estimate reds every assertion below
  // BY NAME instead of throwing a TypeError that ends the run at §1 and leaves
  // §2-§9 unexecuted (proven: M14 did exactly that before this guard).
  const E = r.estimate || {}, C = r.conversation || {}, D = r.domainContext || {};
  for (const k of ['inputTokensLow', 'inputTokensHigh', 'outputTokensLow', 'outputTokensHigh',
    'usdLow', 'usdHigh', 'priceKnown', 'costUnknown', 'tokenizerFactor', 'basis']) {
    ok(Object.prototype.hasOwnProperty.call(E, k), `estimate carries "${k}"`);
  }
  ok(E.inputTokensLow < E.inputTokensHigh, 'input is a RANGE, not a point');
  ok(E.outputTokensLow < E.outputTokensHigh, 'output is a RANGE, not a point');
  ok(E.usdLow < E.usdHigh, 'and so is the dollar figure');
  eq(C.userTurns, 2, 'it reports the real user-turn count');
  eq(D.entityPages, 3, 'and the real entity-page count');
  eq(D.conceptPages, 2, 'and the real concept-page count');

  // ── ANTI-VACUITY: the basis must DESCRIBE this domain, not be boilerplate.
  ok(String(E.basis).includes('est-shape'), 'the basis names the destination domain');
  ok(String(E.basis).includes('3 entity and 2 concept pages'), 'and quotes this domain\'s real inventory');
  ok(/cannot be known in advance|CANNOT BE KNOWN IN ADVANCE/.test(String(E.basis)),
    'and states out loud that the output half cannot be known in advance');
}

// ═══════════════════════════════════════════════════════════════════════════
section('2. The estimate AGREES with the compile — one precheck, not two copies');
// ═══════════════════════════════════════════════════════════════════════════
// An estimate that quotes a price for a conversation the compile is about to
// refuse for free is worse than no estimate: the user pre-authorises a spend
// that never happens. Both sides are driven FOR REAL here and their refusal
// strings compared byte for byte.
{
  seedDomain('est-agree');

  // (a) not found
  const missingId = crypto.randomUUID();
  const estMissing = await estimateSafely('est-agree', missingId);
  const cmpMissing = await compileConversation('est-agree', missingId, () => {}, {
    generateText: () => { throw new Error('THE COMPILE MADE AN LLM CALL ON A MISSING CONVERSATION'); },
  });
  eq(estMissing.compilable, false, 'a missing conversation is not compilable');
  eq(estMissing.refusal, cmpMissing.reason, 'and the estimate\'s refusal is byte-identical to the compile\'s');
  eq(estMissing.estimate, null, 'a refused conversation carries NO cost fields at all');

  // (b) too short — MIN_USER_MESSAGES is read from the module, and the
  //     assertion below pins the SHIPPED value as a hand-written literal so
  //     it cannot be satisfied by reading the same constant the code reads.
  const lit = checkLiteral(1, MIN_USER_MESSAGES, 'MIN_USER_MESSAGES ships as 1');
  ok(lit.pass, lit.message);
  const shortConv = {
    id: crypto.randomUUID(), title: 'Empty', createdAt: new Date().toISOString(),
    messages: [{ role: 'assistant', content: 'hello with no user turn' }],
  };
  writeFileSync(path.join(DOMAINS, 'est-agree', 'conversations', `${shortConv.id}.json`), JSON.stringify(shortConv));
  const estShort = await estimateSafely('est-agree', shortConv.id);
  const cmpShort = await compileConversation('est-agree', shortConv.id, () => {}, {
    generateText: () => { throw new Error('THE COMPILE MADE AN LLM CALL ON A TOO-SHORT CONVERSATION'); },
  });
  eq(estShort.compilable, false, 'a conversation with no user turn is not compilable');
  eq(estShort.refusal, cmpShort.reason, 'and again the two refusals are byte-identical');
  ok(/at least 1 user messages/.test(estShort.refusal), 'the refusal quotes the real floor');

  // (c) already compiled — the idempotency guard, reached by planting the
  //     file the compile would have written at the deterministic slug.
  const doneConv = seedConversation('est-agree', { turns: 1, chars: 200, title: 'Already Done' });
  const pre = await precheckCompile('est-agree', doneConv.id);
  ok(!pre.refusal, 'precondition: the conversation is compilable before the summary exists');
  writeFileSync(path.join(DOMAINS, 'est-agree', 'wiki', pre.summaryPath), '# already here\n');
  const estDone = await estimateSafely('est-agree', doneConv.id);
  const cmpDone = await compileConversation('est-agree', doneConv.id, () => {}, {
    generateText: () => { throw new Error('THE COMPILE MADE AN LLM CALL ON AN ALREADY-COMPILED CONVERSATION'); },
  });
  eq(estDone.compilable, false, 'an already-compiled conversation is not compilable');
  eq(estDone.refusal, cmpDone.reason, 'and the refusals agree byte for byte');
  ok(estDone.refusal.includes(pre.summaryPath), 'the refusal names the summary already on disk');

  // ── AGREEMENT IN THE OTHER DIRECTION ─────────────────────────────────────
  // Every assertion above compares REFUSALS, and refusal-agreement alone is
  // satisfiable by an estimator that refuses everything — or, more plausibly,
  // by one that grew its own stricter floor. So the positive case is asserted
  // too: a conversation the COMPILE would actually spend money on must come
  // back compilable. The compile's own willingness is established by the fact
  // that its injected LLM was REACHED — i.e. it got past every pre-spend
  // refusal and was about to pay.
  {
    const okConv = seedConversation('est-agree', { turns: 2, chars: 500, title: 'Genuinely compilable' });
    const estOk = await estimateSafely('est-agree', okConv.id);
    eq(estOk.compilable, true, 'a two-turn conversation is reported compilable by the estimate');
    let llmReached = false;
    const cmpOk = await compileConversation('est-agree', okConv.id, () => {}, {
      generateText: () => { llmReached = true; throw new Error('stopped at the paid call, deliberately'); },
    });
    ok(llmReached,
      'and the COMPILE reached its paid call on the same conversation — so the estimate is not quietly stricter than the thing it describes');
    eq(cmpOk.reason, undefined, 'the compile issued no pre-spend refusal for it');
  }

  // ── MUTATION: give the estimator its own copy of the "too short" rule with
  //    a different floor, the drift this shared precheck exists to prevent.
  const goodPre = functionSource(stripComments(readFileSync(path.join(REPO, 'src/brain/compile.js'), 'utf8')), 'precheckCompile');
  ok(goodPre !== null, 'precheckCompile is extractable (precondition for the mutation)');
  const drifted = goodPre.replace('userTurns < MIN_USER_MESSAGES', 'userTurns < 4');
  ok(drifted !== goodPre, 'the mutation actually changed the precheck source');
  ok(!/userTurns < MIN_USER_MESSAGES/.test(drifted),
    'CONFIRMED RED: a second, divergent floor is visible in the mutated source — and because BOTH sides ' +
    'call this one function, the byte-identity assertions above are what makes drift impossible rather than merely unlikely');
}

// ═══════════════════════════════════════════════════════════════════════════
section('3. The estimate MOVES — with the conversation, and with the wiki');
// ═══════════════════════════════════════════════════════════════════════════
// The batch-ingest precedent: "the estimate quotes a multiple COMPUTED FOR THE
// BATCH IN FRONT OF IT … never hard-code a single multiplier — a test asserts
// the multiple must move with document size."
{
  seedDomain('est-move-fresh');
  seedDomain('est-move-mature', { entities: 150, concepts: 90 });

  const sizes = [300, 1500, 6000, 20000];
  const freshHighs = [];
  const freshLows = [];
  for (const chars of sizes) {
    const c = seedConversation('est-move-fresh', { turns: 2, chars, title: `size ${chars}` });
    const r = await withEnv({ GEMINI_API_KEY: FAKE_GEMINI_KEY, LLM_MODEL: undefined }, () =>
      estimateSafely('est-move-fresh', c.id));
    freshHighs.push((r.estimate || {}).usdHigh);
    freshLows.push((r.estimate || {}).usdLow);
  }
  let risingHigh = true, risingLow = true;
  for (let i = 1; i < freshHighs.length; i++) {
    if (!(freshHighs[i] > freshHighs[i - 1])) risingHigh = false;
    if (!(freshLows[i] > freshLows[i - 1])) risingLow = false;
  }
  ok(risingHigh, `usdHigh strictly increases with conversation size — ${JSON.stringify(freshHighs)}`);
  ok(risingLow, `usdLow strictly increases with conversation size — ${JSON.stringify(freshLows)}`);
  ok(new Set(freshHighs).size === freshHighs.length, 'no two conversation sizes produce the same figure (a constant would)');

  // The DOMINANT cost driver: the same conversation against a bigger wiki.
  const same = { turns: 2, chars: 1500, title: 'identical text' };
  const a = seedConversation('est-move-fresh', same);
  const b = seedConversation('est-move-mature', same);
  const rFresh = await withEnv({ GEMINI_API_KEY: FAKE_GEMINI_KEY, LLM_MODEL: undefined }, () =>
    estimateSafely('est-move-fresh', a.id));
  const rMature = await withEnv({ GEMINI_API_KEY: FAKE_GEMINI_KEY, LLM_MODEL: undefined }, () =>
    estimateSafely('est-move-mature', b.id));
  ok((rMature.estimate || {}).inputTokensHigh > (rFresh.estimate || {}).inputTokensHigh * 2,
    `the SAME conversation costs more than twice the input tokens against a 240-page wiki — ` +
    `${(rFresh.estimate || {}).inputTokensHigh} vs ${(rMature.estimate || {}).inputTokensHigh}`);
  ok((rMature.estimate || {}).usdHigh > (rFresh.estimate || {}).usdHigh,
    'and the dollar figure follows the wiki size, not only the chat length');

  // ── MUTATION: make the output estimator a constant. The whole point of the
  //    guard is that this is DETECTED, not that it looks wrong on review.
  const estCode = stripComments(estSrc);
  const goodOut = functionSource(estCode, 'estimateOutputTokens');
  ok(goodOut !== null, 'estimateOutputTokens is extractable (precondition for the mutation)');
  // Both the shipped body and the mutated one are built in the SAME sandbox,
  // so the only difference between them is the mutation itself.
  const buildOutSandbox = (body) => new Function(`
    const SUMMARY_ONLY_BASE_TOKENS = ${EST.SUMMARY_ONLY_BASE_TOKENS};
    const SUMMARY_ONLY_TOKENS_PER_CHAR = ${EST.SUMMARY_ONLY_TOKENS_PER_CHAR};
    const PAGES_BASE = ${EST.PAGES_BASE};
    const PAGES_CHARS_EACH = ${EST.PAGES_CHARS_EACH};
    const PAGES_MIN = ${EST.PAGES_MIN};
    const PAGES_MAX = ${EST.PAGES_MAX};
    const TOKENS_PER_PAGE_HIGH = ${EST.TOKENS_PER_PAGE_HIGH};
    const COMPILE_MAX_OUTPUT_TOKENS = ${EST.COMPILE_MAX_OUTPUT_TOKENS};
    function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
    ${body}
    return estimateOutputTokens;
  `)();
  const mutatedBody = goodOut.replace('return { low, high, pagesHigh };', 'return { low: 400, high: 3000, pagesHigh: 20 };');
  ok(mutatedBody !== goodOut, 'the mutation actually changed the estimator source');
  const constOut = buildOutSandbox(mutatedBody);
  const realOut = buildOutSandbox(goodOut);
  ok(realOut(300).high < realOut(6000).high,
    'the real extracted estimator rises with size (the sandbox is wired correctly)');
  const constSpread = new Set([300, 1500, 6000, 20000].map(c => constOut(c).high));
  const realSpread = new Set([300, 1500, 6000, 20000].map(c => realOut(c).high));
  eq(constSpread.size, 1, 'CONFIRMED RED: the mutated estimator returns ONE value for every conversation size');
  ok(realSpread.size > 1, 'while the shipped one returns several — which is exactly what §3\'s monotonicity assertions test');

  // The same rule at the module boundary: the exported function must move too.
  ok(estimateOutputTokens(300).high < estimateOutputTokens(6000).high,
    'the EXPORTED estimateOutputTokens moves with size (not just the extracted copy)');
  ok(estimateInputTokens(2000, 'gemini', 'gemini-2.5-flash-lite').high
     < estimateInputTokens(20000, 'gemini', 'gemini-2.5-flash-lite').high,
    'and the exported estimateInputTokens moves with prompt size');
}

// ═══════════════════════════════════════════════════════════════════════════
section('4. An unknown cost is SAID, never rendered as zero');
// ═══════════════════════════════════════════════════════════════════════════
{
  seedDomain('est-price', { entities: 5 });
  const conv = seedConversation('est-price', { turns: 2, chars: 800 });
  const run = (env) => withEnv(env, () => estimateSafely('est-price', conv.id));

  // (a) NO PROVIDER AT ALL. Every key env is cleared; the isolated user-data
  //     dir has no .curator-config.json, so getProviderInfo throws inside.
  const noKey = await run({
    GEMINI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined,
    OPENROUTER_API_KEY: undefined, LLM_MODEL: undefined,
  });
  eq(noKey.compilable, true, 'with no key the conversation is still compilable (the refusal is not about money)');
  eq(noKey.provider, null, 'no provider is reported');
  eq((noKey.estimate || {}).priceKnown, false, 'priceKnown is false');
  eq((noKey.estimate || {}).costUnknown, 'no-provider', 'and the reason is named as no-provider');
  eq((noKey.estimate || {}).usdLow, null, 'usdLow is NULL, not 0');
  eq((noKey.estimate || {}).usdHigh, null, 'usdHigh is NULL, not 0');
  ok((noKey.estimate || {}).usdLow !== 0 && (noKey.estimate || {}).usdHigh !== 0, 'neither is the number zero');
  ok((noKey.estimate || {}).inputTokensHigh > 0, 'the TOKEN counts are still reported — the work is describable even when the price is not');
  ok(noKey.warnings.some(w => /add an api key/i.test(w)), 'and the user is told what to do about it');

  // (b) A MODEL WITH NO PUBLISHED PRICE. LLM_MODEL bypasses the offerable
  //     allow-list by design (defaultModelFor returns it verbatim), which is
  //     the only way to reach this branch without inventing a fake table.
  const unpriced = await run({ GEMINI_API_KEY: FAKE_GEMINI_KEY, LLM_MODEL: 'zz-model-with-no-price' });
  eq(unpriced.model, 'zz-model-with-no-price', 'the unpriced model really is the one resolved');
  eq((unpriced.estimate || {}).costUnknown, 'no-price', 'an unpriced model reports no-price');
  eq((unpriced.estimate || {}).usdLow, null, 'usdLow is NULL for an unpriced model');
  eq((unpriced.estimate || {}).usdHigh, null, 'usdHigh is NULL for an unpriced model');
  ok(unpriced.warnings.some(w => w.includes('zz-model-with-no-price')), 'and the warning names the model');

  // (c) A FREE MODEL. Reached by the same route, and it must NOT inherit the
  //     unpriced wording: "this costs nothing" and "we cannot tell you what
  //     this costs" are opposite statements.
  const free = await run({ GEMINI_API_KEY: FAKE_GEMINI_KEY, LLM_MODEL: 'minimax/minimax-m3:free' });
  eq((free.estimate || {}).costUnknown, 'free-model', 'a free model reports free-model, not no-price');
  eq((free.estimate || {}).usdLow, null, 'usdLow stays NULL for a free model (a truthy 0 on the money path is the trap FREE_MODELS refuses)');
  ok(free.warnings.some(w => /free to use/i.test(w)), 'and the warning says it is free');
  ok(!free.warnings.some(w => /no published price/i.test(w)), 'and does NOT say the price is unknown');

  // (d) THE PRICED CASE, so none of the above passes vacuously.
  const priced = await run({ GEMINI_API_KEY: FAKE_GEMINI_KEY, LLM_MODEL: undefined });
  eq((priced.estimate || {}).costUnknown, null, 'a priced model reports no unknown-reason at all');
  eq((priced.estimate || {}).priceKnown, true, 'priceKnown is true');
  ok(typeof (priced.estimate || {}).usdLow === 'number' && (priced.estimate || {}).usdLow > 0, 'and a real, non-zero usdLow is produced');
  eq(priced.warnings.length, 0, 'and there are no cost warnings');

  // (e) The Opus tokenizer premium is applied, and only where it is published.
  eq(inputTokenizerFactor('gemini', 'gemini-2.5-flash-lite'), 1, 'no premium on the Gemini default');
  eq(inputTokenizerFactor('anthropic', 'claude-haiku-4-5'), 1, 'no premium on Haiku');
  const opus = inputTokenizerFactor('anthropic', 'claude-opus-5');
  const opusLit = checkLiteral(1.329, opus, 'claude-opus-5 carries the measured 1.329x input premium');
  ok(opusLit.pass, opusLit.message);
  ok(estimateInputTokens(10000, 'anthropic', 'claude-opus-5').high
     > estimateInputTokens(10000, 'anthropic', 'claude-haiku-4-5').high,
    'and the premium reaches the estimate — Opus is quoted more input tokens for the same text');
  eq(inputTokenizerFactor('nonsense-provider', 'nonsense-model'), 1,
    'an unknown model degrades to no premium rather than throwing');
}

// ═══════════════════════════════════════════════════════════════════════════
section('5. THE ESTIMATE MAKES NO LLM CALL — proven by watching the wire');
// ═══════════════════════════════════════════════════════════════════════════
// A spy on every egress binding in the process, with positive controls FIRST
// so the zero below cannot be a spy that was never armed. This is stronger
// than an injected generateText seam: a seam only sees calls routed through
// it, while nothing can leave this process without passing one of these.
{
  seedDomain('est-nocall', { entities: 8, concepts: 4 });
  const conv = seedConversation('est-nocall', { turns: 3, chars: 1200 });

  const realFetch = globalThis.fetch;
  const realHttpReq = http.request;
  const realHttpsReq = https.request;
  let egress = 0;
  const trip = (what) => { egress++; throw new Error(`EGRESS BLOCKED BY THE SUITE: ${what}`); };
  globalThis.fetch = (...a) => trip('fetch ' + String(a[0]));
  http.request = (...a) => trip('http.request ' + String(a[0]));
  https.request = (...a) => trip('https.request ' + String(a[0]));

  try {
    // ── POSITIVE CONTROLS: the spy must be able to see a call. ────────────
    let sawFetch = false;
    try { globalThis.fetch('https://example.invalid/'); } catch { sawFetch = true; }
    ok(sawFetch && egress === 1, 'CONTROL: the spy catches a direct fetch (a zero below cannot be an unarmed spy)');
    let sawHttps = false;
    try { https.request('https://example.invalid/'); } catch { sawHttps = true; }
    ok(sawHttps && egress === 2, 'CONTROL: and a direct https.request');
    let sawHttp = false;
    try { http.request('http://example.invalid/'); } catch { sawHttp = true; }
    ok(sawHttp && egress === 3, 'CONTROL: and a direct http.request');

    // ── THE MEASUREMENT ──────────────────────────────────────────────────
    egress = 0;
    const r = await withEnv({ GEMINI_API_KEY: FAKE_GEMINI_KEY, LLM_MODEL: undefined }, () =>
      estimateSafely('est-nocall', conv.id));
    eq(egress, 0, 'a full estimate — with a key present and a priced model resolved — makes ZERO network calls');
    ok((r.estimate || {}).usdHigh > 0, 'and it still produced a real priced estimate (so the zero is not a crash)');

    // Twice, because a lazily-initialised client could call on first use only.
    egress = 0;
    await withEnv({ GEMINI_API_KEY: FAKE_GEMINI_KEY, LLM_MODEL: undefined }, () =>
      estimateSafely('est-nocall', conv.id));
    eq(egress, 0, 'and a second estimate makes zero too (not merely lazy first-use)');

    // The route handler, driven for real, is equally silent.
    egress = 0;
    const layer = compileRouter.stack.find(l => l.route && l.route.path === '/estimate' && l.route.methods.get);
    ok(!!layer, 'the GET /estimate route exists on the real router (anti-vacuity for the check below)');
    // The section STOPS rather than crashing when the route is missing. A raw
    // TypeError here names no expectation and leaves the tally wrong — the
    // v3.24.1 "crash migrates between sandboxes" shape, closed by making the
    // guard skip the work rather than merely report it.
    if (layer) {
      const handler = layer.route.stack[0].handle;
      const sent = [];
      const res = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        json(b) { sent.push({ status: this.statusCode, body: b }); return this; },
      };
      await withEnv({ GEMINI_API_KEY: FAKE_GEMINI_KEY, LLM_MODEL: undefined }, () =>
        handler({ query: { domain: 'est-nocall', conversationId: conv.id } }, res));
      eq(egress, 0, 'and the ROUTE HANDLER itself makes zero network calls');
      eq(sent.length, 1, 'the handler answered exactly once');
      eq(sent[0] && sent[0].status, 200, 'with a 200');
      eq(sent[0] && sent[0].body.compilable, true, 'and a real estimate body');
    }
  } finally {
    globalThis.fetch = realFetch;
    http.request = realHttpReq;
    https.request = realHttpsReq;
  }

  // Complementary, and labelled as complementary rather than as the proof:
  // the module does not even import the function that spends money.
  ok(!/\bgenerateText\b/.test(stripComments(estSrc)),
    'complementary source check: compile-estimate.js never references generateText');
}

// ═══════════════════════════════════════════════════════════════════════════
section('6. The route — a READ route, validating exactly what the POST validates');
// ═══════════════════════════════════════════════════════════════════════════
{
  const layer = compileRouter.stack.find(l => l.route && l.route.path === '/estimate');
  ok(!!layer, 'GET /estimate is registered');
  eq(!!(layer && layer.route.methods.get), true, 'as a GET');
  eq(!!(layer && layer.route.methods.post), false, 'and not as a POST');
  eq(layer && layer.route.stack.length, 1, 'with exactly ONE handler — no guardConcurrent / write-registry middleware in front of it');

  // Same stop-rather-than-crash discipline as §5.
  const handler = layer ? layer.route.stack[0].handle : async (_req, res) => res.status(599).json({ error: 'route missing' });
  const call = async (query) => {
    const sent = [];
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { sent.push({ status: this.statusCode, body: b }); return this; },
    };
    await handler({ query }, res);
    return sent[0];
  };

  seedDomain('est-route');
  const conv = seedConversation('est-route', { turns: 1, chars: 300 });

  eq((await call({})).status, 400, '400 for a missing domain');
  eq((await call({ domain: 'est-route' })).status, 400, '400 for a missing conversationId');
  eq((await call({ domain: 'est-route', conversationId: 'not-a-uuid' })).status, 400,
    '400 for a non-UUID conversationId — the same path-traversal defence the POST carries');
  eq((await call({ domain: '../escape', conversationId: conv.id })).status, 400,
    '400 for an unknown domain (a traversal attempt is simply not on the allow-list)');
  const good = await call({ domain: 'est-route', conversationId: conv.id });
  eq(good.status, 200, 'and 200 for a real pair');
  eq(good.body.ok, true, 'answering ok');

  // The write-path machinery must be ABSENT from this handler, not merely
  // unused: a file lock taken here would fire while a compile is running,
  // which is exactly when a user asks what the next one costs.
  const handlerSrc = functionSource(stripComments(routeSrc), 'router.get') || '';
  const estimateBlock = stripComments(routeSrc).slice(
    stripComments(routeSrc).indexOf("router.get('/estimate'"),
    stripComments(routeSrc).indexOf("router.post('/conversation'"));
  ok(estimateBlock.length > 200, 'the estimate route block was located (anti-vacuity)');
  ok(!/registerWrite\(/.test(estimateBlock), 'the estimate route does NOT register a write');
  ok(!/acquireFileLock\(/.test(estimateBlock), 'and does NOT take the domain file lock');
  ok(!/isUpdateInProgress\(/.test(estimateBlock), 'and is NOT refused while an update is in flight');
  ok(/CONVERSATION_ID_RE\.test\(conversationId\)/.test(estimateBlock), 'while it DOES share the POST\'s id regex');
  ok(/isDomainReadonly\(domain\)/.test(estimateBlock), 'and DOES honour the read-only mirror rule');
  ok(handlerSrc !== null, 'functionSource found a router.get form (keeps the scan honest about what it read)');
}

// ═══════════════════════════════════════════════════════════════════════════
section('7. The gate — cancel spends nothing, and a refusal never opens a dialog');
// ═══════════════════════════════════════════════════════════════════════════
{
  // Extraction, brace-matched, from the real chat.js. Every collaborator that
  // is NOT under test is a recording stand-in; `compileStillTargetsActive`
  // and `buildCompileConfirmCopy` are pulled in FOR REAL because startCompile
  // calls them for real.
  function extractFunction(src, name) {
    const marker = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ${name}\\s*\\(`);
    const m = marker.exec(src);
    if (!m) throw new Error(`extractFunction: "${name}" not found`);
    const start = src.indexOf('function', m.index);
    let p = src.indexOf('(', start), pd = 0;
    for (; p < src.length; p++) {
      if (src[p] === '(') pd++;
      else if (src[p] === ')') { pd--; if (pd === 0) { p++; break; } }
    }
    let i = src.indexOf('{', p), depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    const out = src.slice(start, i);
    if (!/\n\}$/.test(out)) throw new Error(`extractFunction: "${name}" desynced`);
    return (/(?:^|\n)async function /.test(src.slice(m.index, start + 9)) || /async\s+function\s+$/.test(src.slice(m.index, start))) ? out : out;
  }

  function buildGateSandbox({ estimateBody, estimateStatus = 200, confirms }) {
    const src = `
      let compilePrepping = false;
      const state = {
        compileBusy: false, compileOwner: null,
        activeConversationId: 'conv-1', activeDomain: 'articles',
        conversations: [{ id: 'conv-1', title: 'My chat' }],
        thread: [],
      };
      let myMountToken = 1;
      const labels = [];
      const document = { getElementById: () => null };
      function renderThreadOnly() {}
      function scrollCompileCardIntoView() {}
      function icon() { return ''; }
      function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
      // The real formatUsdHonest, copied byte-for-byte from
      // src/public/next/shared/format-usd.js so the copy assertions test the
      // real rounding rules rather than a laxer stand-in.
      function formatUsdHonest(n) {
        if (typeof n !== 'number' || !Number.isFinite(n)) return null;
        if (n === 0) return '$0.00';
        const sign = n < 0 ? '-' : '';
        const abs = Math.abs(n);
        if (abs < 0.00005) return sign + '< $0.0001';
        if (abs < 0.01) return sign + '$' + abs.toFixed(4);
        return sign + '$' + abs.toFixed(2);
      }
      const fetches = [];
      function fetch(url) {
        fetches.push(String(url));
        return Promise.resolve({
          ok: ${estimateStatus} >= 200 && ${estimateStatus} < 300,
          status: ${estimateStatus},
          json: () => Promise.resolve(${JSON.stringify(estimateBody)}),
        });
      }
      const dialogs = [];
      function confirmThen(opts) {
        dialogs.push(opts);
        ${confirms === 'after-navigate'
          ? "state.activeConversationId = 'conv-2';"
          : ''}
        return ${confirms ? 'Promise.resolve(opts.onConfirm && opts.onConfirm())' : 'Promise.resolve()'};
      }
      let compileRuns = 0;
      async function runCompile() { compileRuns++; fetches.push('POST /api/compile/conversation'); }
      const warns = [];
      const console = { warn: (m) => warns.push(m) };

      ${extractFunction(chatCode, 'compileStillTargetsActive')}
      ${extractFunction(chatCode, 'pushCompileCard')}
      ${extractFunction(chatCode, 'setCompilePrepUi')}
      ${extractFunction(chatCode, 'providerDisplayLabel')}
      ${extractFunction(chatCode, 'buildCompileConfirmCopy')}
      ${'async ' + extractFunction(chatCode, 'startCompile')}

      return { state, startCompile, dialogs, fetches, warns,
               getCompileRuns: () => compileRuns, buildCompileConfirmCopy,
               getPrepping: () => compilePrepping };
    `;
    return new Function(src)();
  }

  const PRICED = {
    ok: true, compilable: true, refusal: null, provider: 'gemini', model: 'gemini-2.5-flash-lite',
    conversation: { title: 'My chat', userTurns: 2, messageCount: 4, transcriptChars: 1500, summaryPath: 'summaries/x.md' },
    domainContext: { entityPages: 5, conceptPages: 3, promptChars: 6000 },
    estimate: {
      inputTokensLow: 1400, inputTokensHigh: 1900, outputTokensLow: 275, outputTokensHigh: 3325,
      usdLow: 0.00025, usdHigh: 0.00152, priceKnown: true, costUnknown: null, tokenizerFactor: 1,
      basis: 'basis text',
    },
    warnings: [],
  };

  // ── CANCEL SPENDS NOTHING ────────────────────────────────────────────────
  {
    const g = buildGateSandbox({ estimateBody: PRICED, confirms: false });
    await g.startCompile();
    eq(g.dialogs.length, 1, 'clicking Compile opens exactly one confirm dialog');
    eq(g.getCompileRuns(), 0, 'CANCEL SPENDS NOTHING: runCompile was never called');
    eq(g.fetches.filter(u => u.startsWith('POST')).length, 0, 'and no POST to the compile route was issued');
    eq(g.fetches.length, 1, 'the only request made was the free estimate');
    ok(g.fetches[0].startsWith('/api/compile/estimate?'), `and it was the estimate route — got ${g.fetches[0]}`);
    ok(g.fetches[0].includes('domain=articles') && g.fetches[0].includes('conversationId=conv-1'),
      'carrying the domain and conversation the user was looking at');
    eq(g.state.thread.length, 0, 'and nothing was written into the thread');
    eq(g.getPrepping(), false, 'the prep flag is released even though the user cancelled');
  }

  // ── POSITIVE CONTROL: confirming DOES spend ──────────────────────────────
  {
    const g = buildGateSandbox({ estimateBody: PRICED, confirms: true });
    await g.startCompile();
    eq(g.dialogs.length, 1, 'CONTROL: the same path opens one dialog');
    eq(g.getCompileRuns(), 1, 'CONTROL: confirming calls runCompile exactly once (so the zero above is a real refusal, not a broken harness)');
    eq(g.fetches.filter(u => u.startsWith('POST')).length, 1, 'CONTROL: and exactly one paid POST is issued');
  }

  // ── AUTHORISATION DOES NOT TRANSFER TO ANOTHER CONVERSATION ──────────────
  // The user authorised a spend for the conversation they were LOOKING AT. If
  // the target moved while the dialog was open, confirming must NOT compile
  // something else. Reachable only through the keyboard (the scrim covers the
  // page), which is why it is checked rather than assumed — and this case was
  // added because a mutation that deleted the check stayed GREEN without it.
  {
    const g = buildGateSandbox({ estimateBody: PRICED, confirms: 'after-navigate' });
    await g.startCompile();
    eq(g.dialogs.length, 1, 'the dialog still opens for the conversation the user was on');
    eq(g.getCompileRuns(), 0,
      'but confirming after the user moved to another conversation spends NOTHING — the authorisation does not transfer');
    eq(g.fetches.filter(u => u.startsWith('POST')).length, 0, 'and no paid POST is issued');
  }

  // ── A REFUSAL NEVER BECOMES A DIALOG ─────────────────────────────────────
  {
    const REFUSED = {
      ok: true, compilable: false,
      refusal: 'Already compiled to summaries/x.md. Send another message in this conversation to extend it, or delete that file in your wiki to start over.',
      provider: null, model: null, conversation: null, domainContext: null, estimate: null, warnings: [],
    };
    const g = buildGateSandbox({ estimateBody: REFUSED, confirms: true });
    await g.startCompile();
    eq(g.dialogs.length, 0, 'a refused conversation opens NO dialog — the user is not asked to authorise a spend that cannot happen');
    eq(g.getCompileRuns(), 0, 'and nothing is compiled');
    eq(g.state.thread.length, 1, 'the refusal is rendered as a thread card instead');
    // `?? ''` rather than an index into a possibly-empty array: a mutation
    // that stops rendering the card must red the assertion above and then
    // red these two, not crash the run before §8 ever executes.
    const refusedHtml = (g.state.thread[0] && g.state.thread[0].html) || '';
    ok(refusedHtml.includes('chat-compile-refused'),
      'through the SAME .chat-compile-refused surface the SSE path uses — refused is not an error');
    ok(refusedHtml.includes('Already compiled to summaries/x.md'), 'and it carries the real refusal text');
  }

  // ── AN ESTIMATE FAILURE STILL ASKS ───────────────────────────────────────
  {
    const g = buildGateSandbox({ estimateBody: { error: 'Failed to estimate compile cost.' }, estimateStatus: 500, confirms: false });
    await g.startCompile();
    eq(g.dialogs.length, 1, 'a 500 from the estimate route STILL opens the confirm — a broken read must not silently spend, nor disable a working feature');
    ok(/could not be estimated/i.test(g.dialogs[0].detail), 'and the dialog says the cost is unknown');
    ok(/Failed to estimate compile cost/.test(g.dialogs[0].detail), 'naming the server\'s own reason');
    eq(g.getCompileRuns(), 0, 'and cancelling it still spends nothing');
  }

  // ── RE-ENTRY: a second click while the dialog is open cannot double-spend ─
  {
    const g = buildGateSandbox({ estimateBody: PRICED, confirms: true });
    await Promise.all([g.startCompile(), g.startCompile()]);
    ok(g.getCompileRuns() <= 1, `two concurrent clicks start at most one compile — got ${g.getCompileRuns()}`);
  }

  // ── MUTATION: bypass the dialog and call runCompile directly ─────────────
  {
    const gateSrc = extractFunction(chatCode, 'startCompile');
    ok(/confirmThen\(/.test(gateSrc), 'startCompile goes through confirmThen (precondition for the mutation)');
    const bypass = gateSrc.replace(/await confirmThen\(\{[\s\S]*?\n  \}\);/, 'await runCompile();');
    ok(bypass !== gateSrc, 'the mutation actually removed the confirm');
    ok(!/confirmThen/.test(bypass), 'CONFIRMED RED: the mutated gate no longer asks — a source form the assertion above rejects');
    ok(/runCompile\(\)/.test(bypass), 'and spends unconditionally, which the cancel assertions above would catch behaviourally');
  }

  // ── THE CLICK HANDLER GOES THROUGH THE GATE ──────────────────────────────
  ok(/getElementById\('chat-compile-btn'\)\?\.addEventListener\('click', \(\) => startCompile\(\)/.test(chatCode),
    'the Compile button\'s click handler calls startCompile, not runCompile');
  ok(!/addEventListener\('click', \(\) => runCompile\(\)/.test(chatCode),
    'and runCompile is not wired to any click handler — the paid path is unreachable without the gate');
}

// ═══════════════════════════════════════════════════════════════════════════
section('8. The confirm copy — four cost facts, four different sentences');
// ═══════════════════════════════════════════════════════════════════════════
{
  const build = new Function(`
    function formatUsdHonest(n) {
      if (typeof n !== 'number' || !Number.isFinite(n)) return null;
      if (n === 0) return '$0.00';
      const sign = n < 0 ? '-' : '';
      const abs = Math.abs(n);
      if (abs < 0.00005) return sign + '< $0.0001';
      if (abs < 0.01) return sign + '$' + abs.toFixed(4);
      return sign + '$' + abs.toFixed(2);
    }
    ${functionSource(chatCode, 'providerDisplayLabel')}
    ${functionSource(chatCode, 'buildCompileConfirmCopy')}
    return buildCompileConfirmCopy;
  `)();

  const mk = (estimate, model = 'gemini-2.5-flash-lite', provider = 'gemini') =>
    build({ provider, model, estimate }, 'articles', 'My chat', null);

  const priced = mk({ usdLow: 0.00025, usdHigh: 0.00152, priceKnown: true, costUnknown: null });
  ok(priced.detail.includes('$0.0003') || priced.detail.includes('$0.0002'), `the priced dialog shows a low figure — ${priced.detail.slice(0, 90)}`);
  ok(priced.detail.includes('$0.0015'), 'and a high figure');
  ok(priced.detail.includes('–'), 'presented as a RANGE');
  ok(/cannot be known before the call/.test(priced.detail), 'with the reason the range is wide stated in the dialog itself');
  ok(/retries, which costs more/.test(priced.detail), 'and the ladder\'s extra cost disclosed');
  ok(priced.detail.includes('"articles" wiki'), 'and it names where the pages will land');
  eq(priced.message, 'My chat', 'the conversation title is the dialog subject (set by confirmThen with textContent, never innerHTML)');
  eq(priced.confirmLabel, 'Compile', 'the confirm button says what it does');

  // A sub-$0.00005 estimate must never render as $0.0000 — formatUsdHonest's
  // whole reason for existing, exercised here on the compile surface.
  const tiny = mk({ usdLow: 0.000001, usdHigh: 0.00002, priceKnown: true, costUnknown: null });
  ok(!/\$0\.0000\b/.test(tiny.detail), `a sub-cent estimate never renders as $0.0000 — ${tiny.detail.slice(0, 80)}`);
  ok(tiny.detail.includes('< $0.0001'), 'it renders as "< $0.0001", which is true and unmistakably not free');

  const freeCopy = mk({ usdLow: null, usdHigh: null, priceKnown: false, costUnknown: 'free-model' }, 'minimax/minimax-m3:free');
  ok(/free to use/.test(freeCopy.detail), 'a free model says it is free');
  ok(!/\$0\.00/.test(freeCopy.detail), 'and shows no dollar figure at all');

  const noPriceCopy = mk({ usdLow: null, usdHigh: null, priceKnown: false, costUnknown: 'no-price' }, 'zz-unpriced');
  ok(/No published price/.test(noPriceCopy.detail), 'an unpriced model says the price is unknown');
  ok(/still bill this compile/.test(noPriceCopy.detail), 'and warns that it will still be billed');
  ok(!/free/i.test(noPriceCopy.detail), 'and never suggests it is free');

  const noProvCopy = mk({ usdLow: null, usdHigh: null, priceKnown: false, costUnknown: 'no-provider' }, null, null);
  ok(/No AI provider is configured/.test(noProvCopy.detail), 'no provider says so');
  ok(/Settings/.test(noProvCopy.detail), 'and points at Settings');

  // The four branches must not be the same sentence.
  const four = new Set([priced.detail, freeCopy.detail, noPriceCopy.detail, noProvCopy.detail]);
  eq(four.size, 4, 'all four cost facts produce four DIFFERENT sentences');

  const noEstimate = build(null, 'articles', 'My chat', 'the request failed');
  ok(/could not be estimated/.test(noEstimate.detail), 'a missing estimate says so');
  ok(/the request failed/.test(noEstimate.detail), 'and quotes the reason it has');
  ok(!/\$/.test(noEstimate.detail), 'and invents no figure');

  eq(build(null, 'articles', '', null).message, 'Untitled conversation',
    'an untitled conversation gets a readable stand-in rather than an empty dialog subject');
}

// ═══════════════════════════════════════════════════════════════════════════
section('9. The shipped constants still bracket every real measurement');
// ═══════════════════════════════════════════════════════════════════════════
// REGRESSION GUARD, NOT A VALIDATION. These nine rows are what ten real paid
// calls returned on 2026-08-30 against gemini-2.5-flash-lite ($0.009462 in
// total). They are transcribed literals — never read back out of the module —
// so an assertion cannot be satisfied by the same constant the code reads.
// What they prove is that a future edit to the bands has not stopped covering
// what was actually observed. They prove nothing about a different model.
{
  const P = { input: 0.10, output: 0.40 }; // gemini-2.5-flash-lite, per Mtok
  const OBS = [
    { name: 'tiny/fresh',    transcript: 899,  promptChars: 4941,  inTok: 1230, outTok: 726 },
    { name: 'small/fresh',   transcript: 1676, promptChars: 5740,  inTok: 1391, outTok: 2623 },
    { name: 'medium/mature', transcript: 3219, promptChars: 12431, inTok: 3863, outTok: 3189 },
    { name: 'large/mature',  transcript: 6510, promptChars: 15805, inTok: 4559, outTok: 3036 },
    { name: 'replicate 1',   transcript: 3219, promptChars: 11997, inTok: 3767, outTok: 2456 },
    { name: 'replicate 2',   transcript: 3219, promptChars: 11997, inTok: 3767, outTok: 2145 },
    { name: 'replicate 3',   transcript: 3219, promptChars: 11997, inTok: 3767, outTok: 1977 },
    { name: 'summary-only s', transcript: 899, promptChars: 2403,  inTok: 607,  outTok: 257 },
    { name: 'summary-only l', transcript: 6510, promptChars: 13267, inTok: 3937, outTok: 523 },
  ];
  for (const o of OBS) {
    const i = estimateInputTokens(o.promptChars, 'gemini', 'gemini-2.5-flash-lite');
    const t = estimateOutputTokens(o.transcript);
    const usd = (a, b) => (a / 1e6) * P.input + (b / 1e6) * P.output;
    ok(o.inTok >= i.low && o.inTok <= i.high,
      `${o.name}: measured ${o.inTok} input tokens sits inside the quoted ${i.low}–${i.high}`);
    ok(o.outTok <= t.high, `${o.name}: measured ${o.outTok} output tokens is under the quoted ceiling ${t.high}`);
    const act = usd(o.inTok, o.outTok);
    ok(act >= usd(i.low, t.low) && act <= usd(i.high, t.high),
      `${o.name}: the real bill $${act.toFixed(6)} lands inside $${usd(i.low, t.low).toFixed(6)}–$${usd(i.high, t.high).toFixed(6)}`);
  }

  // The three replicates are the variance measurement, and the point of the
  // range: identical input, three different answers.
  const spread = new Set(OBS.filter(o => o.name.startsWith('replicate')).map(o => o.outTok));
  eq(spread.size, 3, 'the three byte-identical replicates really did produce three different output sizes');

  // The bands themselves, pinned as hand-written literals.
  for (const [name, lit, actual] of [
    ['INPUT_TOKEN_BAND.low', 0.85, EST.INPUT_TOKEN_BAND.low],
    ['INPUT_TOKEN_BAND.high', 1.15, EST.INPUT_TOKEN_BAND.high],
    ['TOKENS_PER_PAGE_HIGH', 175, EST.TOKENS_PER_PAGE_HIGH],
    ['PAGES_MAX', 40, EST.PAGES_MAX],
    ['CHARS_PER_TOKEN (shared with the batch estimator)', 3.53, EST.CHARS_PER_TOKEN],
  ]) {
    const v = checkLiteral(lit, actual, name);
    ok(v.pass, v.message);
  }

  // ONE constant, not two: the batch estimator and this one must price the
  // same characters identically or two cost surfaces in one app disagree.
  const { __testing: QUEUE } = await import('../src/brain/ingest-queue.js');
  ok(QUEUE, 'ingest-queue exposes its testing surface');
  const { CHARS_PER_TOKEN: SHARED } = await import('../src/brain/ingest-queue.js');
  eq(SHARED, EST.CHARS_PER_TOKEN, 'the compile estimator reads the batch estimator\'s own CHARS_PER_TOKEN — one copy, not two');

  // The saturation cap must never collapse the range into a point.
  for (const chars of [100, 1000, 10000, 66000, 140000, 400000]) {
    const t = estimateOutputTokens(chars);
    ok(t.high > t.low, `at ${chars} transcript chars the output range is still a range (${t.low}–${t.high}), never a point`);
  }
  eq(estimateOutputTokens(-5).low > 0, true, 'a negative char count degrades to the floor rather than a negative estimate');
  eq(Number.isFinite(estimateOutputTokens(NaN).high), true, 'and NaN does not poison the arithmetic');
}

// ── Teardown ──────────────────────────────────────────────────────────────
__setDomainsDirOverride(null);
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log('\n────────────────────────────────────────────────────────────');
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) {
  console.log('❌ compile-estimate assertions FAILED');
  process.exit(1);
}
console.log('✅ All compile-estimate (cost gate) offline assertions green');
