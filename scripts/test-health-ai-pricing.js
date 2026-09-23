/**
 * test-health-ai-pricing.js — OFFLINE suite for AI Health cost-estimate pricing.
 *
 * BACKGROUND (v3.6.1 recorded follow-up): src/brain/health-ai.js used to keep
 * its OWN hand-maintained 3-entry price table (`MODEL_PRICING`), synced by
 * hand against the authoritative `MODEL_PRICES_USD_PER_MTOK` in
 * src/brain/llm.js. It had gone ~25% stale on the Gemini default
 * (health-ai's 0.075/0.30 vs llm.js's current 0.10/0.40) and had ZERO
 * entries for any of the five FALLBACK_CHAINS rungs or for
 * claude-sonnet-4-5 (the model this project's own CLAUDE.md documents
 * opting into via `LLM_MODEL`) — so pricing any of those active models
 * silently produced `estimatedUsd: null`, which two of the four app.js
 * cost-readout call sites render as an EMPTY STRING (no number, no "cost
 * unknown" message — nothing).
 *
 * The fix removed the second table entirely: health-ai.js now calls
 * `getModelPrice()`, exported by llm.js, which reads the SAME
 * `MODEL_PRICES_USD_PER_MTOK` object that drives every other cost surface
 * in the app (the fallback-chain cost-tier banner, the chat-model-cost
 * comparison, llm.js's own offline price-coverage invariant).
 *
 * THIS SUITE IS DELIBERATELY NOT A NUMBERS-MATCH SNAPSHOT TEST. Asserting
 * "0.10 === 0.10" against a value hardcoded in this file would stay green
 * forever even if a future change re-synced two independent copies by hand
 * instead of removing the second one — the exact failure mode this suite
 * exists to catch. Every price expectation below is DERIVED from llm.js's
 * live exported table at test-run time (via `getModelPrice`, imported from
 * llm.js, never re-typed here), so a future price change in llm.js with no
 * matching change in health-ai.js — because health-ai.js keeps its own
 * table again — makes this suite fail the moment that drift is introduced,
 * not only today. Section 1 additionally pins the STRUCTURAL shape of the
 * fix at the source-text level, so reintroducing a second table (even a
 * dead, unused one) is caught even before it could possibly cause a numeric
 * mismatch.
 */

import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getModelPrice, __testing as llmTesting } from '../src/brain/llm.js';
import { __setUserDataDirOverride } from '../src/brain/paths.js';
import { __setDomainsDirOverride } from '../src/brain/config.js';
import {
  estimateBrokenLinkFix,
  estimateOrphanRescue,
  estimateSemanticDuplicateScan,
  planBrokenLinkFixes,
  planOrphanRescue,
  scanSemanticDuplicates,
  describeHealthRun,
  __testing as healthAiTesting,
} from '../src/brain/health-ai.js';
import healthRouter from '../src/routes/health.js';
import { spentFromUsage } from '../src/brain/ai-run.js';
import { makeUsageAccumulator } from '../src/brain/ingest.js';

const { estimateUsdCost, costFields } = healthAiTesting;
const { DEFAULTS, FALLBACK_CHAINS, MODEL_PRICES_USD_PER_MTOK } = llmTesting;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const HEALTH_AI_SRC = path.join(ROOT, 'src', 'brain', 'health-ai.js');
const NEXT_DOMAINS_SRC = path.join(ROOT, 'src', 'public', 'next', 'views', 'domains.js');
const AI_HEALTH_DOC = path.join(ROOT, 'docs', 'ai-health.md');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(a, b, label) { ok(a === b, `${label} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`); }
function section(t) { console.log(`\n${t}`); }

// ── 1. Source-level structural guard ─────────────────────────────────────────
// Pins the SHAPE of the fix, independent of any numeric value: no second price
// table exists in the source at all, the shared accessor is imported, and
// every one of the six known cost-payload call sites routes through the one
// shared `costFields()` helper rather than reconstructing its own
// `estimatedUsd: estimateUsdCost(...)` inline (which is exactly how the old
// code let the numeric field and any future honesty signal drift
// independently at each call site).
section('1. Source-level guard — exactly one price table, reachable everywhere');
{
  const src = readFileSync(HEALTH_AI_SRC, 'utf8');
  ok(!/\bMODEL_PRICING\b/.test(src),
    'the old MODEL_PRICING identifier is gone from health-ai.js entirely');
  ok(/import\s*\{[^}]*\bgetModelPrice\b[^}]*\}\s*from\s*['"]\.\/llm\.js['"]/.test(src),
    'getModelPrice is imported from ./llm.js');
  const callSiteCount = (src.match(/\.\.\.costFields\(/g) || []).length;
  eq(callSiteCount, 6, 'all 6 known cost-payload call sites spread ...costFields(...)');
  // No stray hardcoded per-1M-token literal near a model id — a loose regex
  // on purpose (this is a smell check, not exhaustive), catching a partial
  // revert that re-adds numbers without re-adding the MODEL_PRICING name.
  ok(!/'gemini-2\.5-flash-lite':\s*\{\s*input:\s*0\.075/.test(src),
    'the specific stale Gemini-default price pair is not hardcoded in source');
}

// ── 2. Shared-source invariant — derived from the LIVE llm.js table ────────
section("2. Shared-source invariant — health-ai matches llm.js's LIVE table for every shipped id");
{
  // ── DEFAULTS POSTURE: a provider default names a model, OR is null ─────────
  // `DEFAULTS.openrouter` is null ON PURPOSE (v3.15.0). A provider may have no
  // build-lane default until a model has been measured against this repo's real
  // ingest outline prompt; inventing a plausible id off a public catalogue would
  // be a guess about JSON reliability dressed up as a default, on the one path
  // where a wrong guess writes a whole wiki. So the sweep below is no longer
  // "every value in DEFAULTS" — it is every value that NAMES a model.
  //
  // The rule is ASSERTED, not accidentally satisfied by a filter. The set of
  // providers carrying null is PINNED: nulling gemini's or anthropic's default
  // would otherwise silently shrink this coverage sweep and leave the section
  // green over a shipped model nobody priced. That is the failure mode the
  // filter itself introduces, so it is closed in the same breath.
  const unpinned = Object.entries(DEFAULTS).filter(([, id]) => id === null).map(([p]) => p).sort();
  // RE-POINTED: OpenRouter now has a measured build-lane default
  // (`upstage/solar-pro4`, 9/9 raw JSON on the real ingest prompt), so no
  // provider is unpinned. The pin is kept — it reds if a fourth provider lands
  // unmeasured, and it reds if an existing default is nulled.
  eq(unpinned.join(','), '',
    'every provider carries a MEASURED build-lane default — no provider is unpinned');
  for (const [p, id] of Object.entries(DEFAULTS)) {
    ok(id === null || (typeof id === 'string' && id.length > 0),
      `DEFAULTS.${p} is a non-empty model id, or null meaning "nothing measured yet" — never '' and never an object`);
  }

  const shipped = [...Object.values(DEFAULTS), ...Object.values(FALLBACK_CHAINS).flat()]
    .filter(id => id !== null);
  ok(shipped.length > 0, 'fixture sanity: DEFAULTS + FALLBACK_CHAINS is non-empty');
  // The filter must drop ONLY the nulls. An over-broad filter would shrink the
  // sweep silently — no assertion below iterates over what is missing, so it
  // would read as green. Closed by checking every id that should have survived.
  for (const [p, id] of Object.entries(DEFAULTS)) {
    if (id === null) continue;
    ok(shipped.includes(id), `DEFAULTS.${p} ("${id}") survives the null filter and IS swept below`);
  }
  for (const id of new Set(shipped)) {
    const price = getModelPrice(id); // read live from llm.js, never re-typed here
    ok(price, `fixture sanity: llm.js currently prices "${id}"`);
    if (!price) continue;
    // ── THE ASSOCIATION MUST MATCH THE IMPLEMENTATION'S, EXACTLY ──────────
    // This read `price.input * 1 + price.output * 1` and compared it to
    // `estimateUsdCost`, which computes
    // `(inputTokens * p.input + outputTokens * p.output) / 1_000_000`. Those are
    // the same value in arithmetic and NOT the same double: at $0.09/$0.36 the
    // first yields 0.44999999999999996 and the second 0.45, and `eq` is exact.
    // It agreed for every price this table had ever held and stopped agreeing
    // the day one changed — a latent fragility in the TEST, not a defect in the
    // code, and it would have read as a real pricing disagreement.
    // Re-deriving through the same expression keeps this an assertion about the
    // TABLE (does health-ai read llm.js's number) rather than about float
    // association, which is what it was always meant to say.
    const expectedUsd = (1_000_000 * price.input + 1_000_000 * price.output) / 1_000_000;
    const got = estimateUsdCost('irrelevant-provider-arg', id, 1_000_000, 1_000_000);
    eq(got, expectedUsd, `health-ai prices "${id}" identically to llm.js's live table`);
  }
}

// ── 3. Every id in llm.js's table resolves through health-ai — no blanks ────
section('3. Every id llm.js prices resolves through health-ai — none silently blank');
{
  for (const id of Object.keys(MODEL_PRICES_USD_PER_MTOK)) {
    ok(estimateUsdCost('x', id, 1000, 1000) !== null,
      `${id}: health-ai returns a numeric estimate, not null`);
  }
}

// ── 4. Regression guard — the stale ~25%-low Gemini-default numbers are gone ─
section('4. Regression guard — stale ~25%-low Gemini-default pricing cannot come back silently');
{
  const staleUsd = 1_000_000 * 0.075 + 1_000_000 * 0.30; // the OLD hardcoded table
  const got = estimateUsdCost('gemini', 'gemini-2.5-flash-lite', 1_000_000, 1_000_000);
  ok(got !== staleUsd, `gemini-2.5-flash-lite no longer prices at the old stale rate ($${staleUsd})`);
  const live = getModelPrice('gemini-2.5-flash-lite');
  eq(got, live.input * 1_000_000 / 1_000_000 * 1 + live.output * 1_000_000 / 1_000_000 * 1,
    'gemini-2.5-flash-lite prices at the CURRENT llm.js rate (whatever that is today)');
}

// ── 5. Previously-uncovered models now price ─────────────────────────────────
// These four ids (the current fallback-chain surface plus the documented
// LLM_MODEL=claude-sonnet-4-5 opt-in) were ABSENT from health-ai's old
// 3-entry table. This is the literal "shows nothing at all after a
// fallback-chain walk" defect: getProviderInfo() can return any of these as
// the active model id (via the automatic 404 fallback walk recording a
// different requested/using pair, or via a user pinning one directly through
// LLM_MODEL — both surface identically to health-ai as `model`), and none of
// them existed in the old local table.
//
// `gemini-3.5-flash-lite` was on this list until 2026-08-26, when it was
// REMOVED from FALLBACK_CHAINS.gemini in llm.js (strictly dominated by
// gemini-2.5-flash — same price, worse JSON reliability; see the removal note
// above that chain). It no longer ships, so llm.js correctly returns no price
// for it and asserting one here would fail for the right reason — do not
// re-add it to this list without also re-adding the chain rung + its price.
section('5. Fallback-chain rungs + claude-sonnet-4-5 — the specific "shows nothing" models');
{
  const previouslyMissing = [
    'gemini-3.1-flash-lite',
    'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-sonnet-4-5',
  ];
  for (const id of previouslyMissing) {
    ok(getModelPrice(id), `fixture sanity: llm.js prices "${id}"`);
    ok(estimateUsdCost('x', id, 1000, 1000) !== null,
      `${id}: was unpriced (null) in health-ai's old table, now resolves to a number`);
  }
}

// ── 6. costFields — the honest-unavailable signal ────────────────────────────
section('6. costFields — additive honesty signal, unchanged estimatedUsd contract');
{
  const known = costFields('gemini', 'gemini-2.5-flash-lite', 1000, 1000);
  eq(known.priceKnown, true, 'known model: priceKnown true');
  ok(typeof known.estimatedUsd === 'number' && known.estimatedUsd >= 0,
    'known model: estimatedUsd is a non-negative number');
  eq(known.costNote, null, 'known model: costNote is null');

  const unknown = costFields('gemini', 'totally-unlisted-model-xyz', 1000, 1000);
  eq(unknown.priceKnown, false, 'unknown model: priceKnown false');
  eq(unknown.estimatedUsd, null, 'unknown model: estimatedUsd stays null (pre-existing contract unchanged)');
  ok(typeof unknown.costNote === 'string' && unknown.costNote.includes('totally-unlisted-model-xyz'),
    'unknown model: costNote is a string naming the unpriced model');

  // A consumer that only ever checked `estimatedUsd != null` (the pre-existing
  // contract) must keep working byte-identically — priceKnown/costNote are
  // pure additions, never a replacement.
  eq(costFields('gemini', 'gemini-2.5-flash-lite', 1000, 1000).estimatedUsd,
    estimateUsdCost('gemini', 'gemini-2.5-flash-lite', 1000, 1000),
    'costFields.estimatedUsd matches a bare estimateUsdCost call — no behavioural change to the numeric field');
}

// ── 7. estimateUsdCost defensive inputs ──────────────────────────────────────
section('7. estimateUsdCost — defensive inputs');
{
  eq(estimateUsdCost('gemini', null, 1000, 1000), null, 'null model id → null');
  eq(estimateUsdCost('gemini', undefined, 1000, 1000), null, 'undefined model id → null');
  eq(estimateUsdCost('gemini', '', 1000, 1000), null, 'empty-string model id → null');
  eq(estimateUsdCost('gemini', '__proto__', 1000, 1000), null,
    'prototype-key model id → null, not inherited garbage (getModelPrice uses Object.hasOwn)');
  eq(estimateUsdCost('gemini', 'constructor', 1000, 1000), null,
    'prototype-key model id ("constructor") → null');
  eq(estimateUsdCost('gemini', 'gemini-2.5-flash-lite', 0, 0), 0,
    'zero tokens → zero cost, not null (distinct from "unpriced")');
}

// ── 8. End-to-end — the real estimate call sites carry the honesty fields ───
// Isolates BOTH user-data (credentials) and domains in tempdirs via the
// sanctioned in-process test seams, so this never reads or writes the real
// machine's .curator-config.json or wiki. Estimate functions make no LLM
// calls (only scanWiki + directory listings), so a dummy key is sufficient.
section('8. End-to-end — estimateBrokenLinkFix / estimateOrphanRescue / estimateSemanticDuplicateScan');
{
  const tmpUserData = mkdtempSync(path.join(tmpdir(), 'curator-test-hai-pricing-userdata-'));
  const tmpDomains = mkdtempSync(path.join(tmpdir(), 'curator-test-hai-pricing-domains-'));
  const savedLlmModel = process.env.LLM_MODEL;
  __setUserDataDirOverride(tmpUserData);
  __setDomainsDirOverride(tmpDomains);
  try {
    delete process.env.LLM_MODEL; // start clean regardless of the ambient shell
    writeFileSync(path.join(tmpUserData, '.curator-config.json'), JSON.stringify({
      geminiApiKey: 'zz-test-dummy-key-not-a-real-credential',
      activeProvider: 'gemini',
    }));

    const domain = 'zztest-health-ai-pricing';
    const wikiDir = path.join(tmpDomains, domain, 'wiki');
    for (const sub of ['entities', 'concepts', 'summaries']) {
      mkdirSync(path.join(wikiDir, sub), { recursive: true });
    }
    writeFileSync(path.join(tmpDomains, domain, 'CLAUDE.md'), '# test domain\n');
    writeFileSync(
      path.join(wikiDir, 'entities', 'alice.md'),
      '# Alice\n\nSees [[bob-nonexistent]] who was never created.\n'
    );

    // 8a. Default (priced) model — every estimate carries the new honesty
    // fields alongside the pre-existing numeric/provider/model fields.
    const blEst = await estimateBrokenLinkFix(domain);
    ok('priceKnown' in blEst, 'estimateBrokenLinkFix: result carries priceKnown');
    ok('costNote' in blEst, 'estimateBrokenLinkFix: result carries costNote');
    eq(blEst.provider, 'gemini', 'estimateBrokenLinkFix: resolves the configured provider');
    eq(blEst.priceKnown, true, 'estimateBrokenLinkFix: default model is priced');
    eq(blEst.costNote, null, 'estimateBrokenLinkFix: no costNote when priced');
    ok(typeof blEst.estimatedUsd === 'number', 'estimateBrokenLinkFix: estimatedUsd is a number');

    const orphEst = await estimateOrphanRescue(domain);
    ok('priceKnown' in orphEst, 'estimateOrphanRescue: result carries priceKnown');
    ok('costNote' in orphEst, 'estimateOrphanRescue: result carries costNote');
    eq(orphEst.priceKnown, true, 'estimateOrphanRescue: default model is priced');

    const semEst = await estimateSemanticDuplicateScan(domain);
    ok('priceKnown' in semEst, 'estimateSemanticDuplicateScan: result carries priceKnown');
    ok('costNote' in semEst, 'estimateSemanticDuplicateScan: result carries costNote');
    eq(semEst.priceKnown, true, 'estimateSemanticDuplicateScan: default model is priced');

    // 8b. An unpriced active model (the real-world trigger: an LLM_MODEL
    // override — the same mechanism CLAUDE.md documents for opting into
    // claude-sonnet-4-5, just pointed at a genuinely unlisted id here) must
    // produce an HONEST unavailable signal at the real call-site boundary,
    // not just inside the private costFields() helper.
    process.env.LLM_MODEL = 'zz-genuinely-unpriced-model-id';
    const blEst2 = await estimateBrokenLinkFix(domain);
    eq(blEst2.priceKnown, false,
      'estimateBrokenLinkFix under an unpriced LLM_MODEL override: priceKnown false');
    eq(blEst2.estimatedUsd, null,
      'estimateBrokenLinkFix under an unpriced LLM_MODEL override: estimatedUsd null (never a wrong number)');
    ok(typeof blEst2.costNote === 'string' && blEst2.costNote.length > 0,
      'estimateBrokenLinkFix under an unpriced LLM_MODEL override: costNote is a non-empty string');

    const orphEst2 = await estimateOrphanRescue(domain);
    eq(orphEst2.priceKnown, false,
      'estimateOrphanRescue under an unpriced LLM_MODEL override: priceKnown false');
    eq(orphEst2.estimatedUsd, null,
      'estimateOrphanRescue under an unpriced LLM_MODEL override: estimatedUsd null');

    const semEst2 = await estimateSemanticDuplicateScan(domain);
    eq(semEst2.priceKnown, false,
      'estimateSemanticDuplicateScan under an unpriced LLM_MODEL override: priceKnown false');
    eq(semEst2.estimatedUsd, null,
      'estimateSemanticDuplicateScan under an unpriced LLM_MODEL override: estimatedUsd null');
  } finally {
    if (savedLlmModel === undefined) delete process.env.LLM_MODEL;
    else process.env.LLM_MODEL = savedLlmModel;
    __setUserDataDirOverride(null);
    __setDomainsDirOverride(null);
    rmSync(tmpUserData, { recursive: true, force: true });
    rmSync(tmpDomains, { recursive: true, force: true });
  }
}

// ── 9. Doc-drift guard — costNote is documented as wired, not as a future TODO ─
// v3.6.2 found (and fixed) a real doc-drift instance: health-ai.js's costFields()
// docblock and docs/ai-health.md both claimed "no current UI reads
// priceKnown/costNote" / "the post-run readouts do not yet read costNote"
// AT THE SAME TIME app.js's formatHealthCost() and next/views/domains.js's
// costReadout() were already reading it — a cross-agent collision where one
// agent documented a gap the other agent had concurrently closed. This
// section pins the corrected claim at the source-text level so the stale
// "not wired up yet" language cannot silently return, and so the docs
// cannot silently drift back out of sync with the actual consumers.
section('9. Doc-drift guard — costNote consumers exist and stale "not wired" claims are gone');
{
  const healthAiSrc = readFileSync(HEALTH_AI_SRC, 'utf8');
  const nextDomainsSrc = readFileSync(NEXT_DOMAINS_SRC, 'utf8');
  const doc = readFileSync(AI_HEALTH_DOC, 'utf8');

  // The specific stale claims (health-ai.js's own docblock).
  ok(!/no current UI reads/.test(healthAiSrc),
    'health-ai.js docblock no longer claims "no current UI reads" priceKnown/costNote');
  ok(!/not-yet-done change/.test(healthAiSrc),
    'health-ai.js docblock no longer defers wiring app.js to costNote as a "not-yet-done change"');

  // The specific stale claims (docs/ai-health.md prose).
  ok(!/do not yet read `priceKnown`\/`costNote`/.test(doc),
    'ai-health.md no longer claims the post-run readouts "do not yet read" priceKnown/costNote');
  ok(!/currently render nothing in that same case/.test(doc),
    'ai-health.md no longer claims the post-run readouts "currently render nothing"');

  // The claims are true only if the consumers actually exist in source —
  // an actual property access, not merely a comment mentioning the field
  // name (both files' explanatory comments legitimately say "costNote" too,
  // so this checks the ACCESS expressions the real implementations use).
  // Until v3.41.0 there were TWO consumers to check — src/public/app.js's
  // formatHealthCost() and this one. That shell is deleted, so /next's
  // costReadout() is the only renderer of this field left, and the only one
  // this assertion can name.
  ok(/est\.costNote/.test(nextDomainsSrc),
    'next/views/domains.js costReadout() actually reads est.costNote (not just mentions it in a comment)');

  // The doc must still name the one real, deliberate gap (the /next compact
  // badge) rather than implying total coverage — a doc that overclaims is
  // exactly the same defect class as one that underclaims.
  ok(/compact.*cost unknown|cost unknown.*compact/is.test(doc),
    'ai-health.md documents the deliberate /next compact-badge "cost unknown" exception');
}

// ── 10–12. v3.67.0 — the run line and the actual cost (ADDITIVE ONLY) ─────
// Every Health estimate route gains `runsOn` (describeRun's shape), and every
// plan/scan's `done` event gains `spent` (spentFromUsage's). Nothing existing
// moves: each route's body minus `runsOn` must equal what the route sent
// before — `{ok:true, ...estimate}` — key for key and value for value.
{
  const tmpUserData = mkdtempSync(path.join(tmpdir(), 'curator-test-hai-run-userdata-'));
  const tmpDomains = mkdtempSync(path.join(tmpdir(), 'curator-test-hai-run-domains-'));
  const saved = {};
  for (const k of ['LLM_MODEL', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY']) { saved[k] = process.env[k]; delete process.env[k]; }
  __setUserDataDirOverride(tmpUserData);
  __setDomainsDirOverride(tmpDomains);
  const CFG = path.join(tmpUserData, '.curator-config.json');
  const withKey = () => writeFileSync(CFG, JSON.stringify({ geminiApiKey: 'zz-test-dummy-key-not-a-real-credential', activeProvider: 'gemini' }));
  const withoutKey = () => writeFileSync(CFG, JSON.stringify({}));
  const route = (method, p) => {
    const layer = healthRouter.stack.find(l => l.route && l.route.path === p && l.route.methods[method]);
    return layer ? layer.route.stack[0].handle : null;
  };
  const call = async (method, p, params = {}) => {
    const h = route(method, p);
    const sent = [];
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { sent.push({ status: this.statusCode, body: b }); return this; } };
    if (!h) return { status: 0, body: {} };
    await h({ params, query: {}, body: {} }, res);
    return sent[0] || { status: 0, body: {} };
  };
  const without = (o, k) => { const c = { ...o }; delete c[k]; return c; };
  const close = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-6;
  try {
    withKey();
    const domain = 'zztest-health-ai-run';
    const wikiDir = path.join(tmpDomains, domain, 'wiki');
    for (const sub of ['entities', 'concepts', 'summaries']) mkdirSync(path.join(wikiDir, sub), { recursive: true });
    writeFileSync(path.join(tmpDomains, domain, 'CLAUDE.md'), '# test domain\n');
    writeFileSync(path.join(wikiDir, 'entities', 'alice.md'), '# Alice\n\nSees [[zz-quantum-flux-capacitor]], never written.\n');
    // 13 orphans → TWO orphan-rescue batches (batch size 12), so `spent` must SUM.
    for (let i = 0; i < 13; i++) writeFileSync(path.join(wikiDir, 'entities', `lonely-${i}.md`), `# Lonely ${i}\n\nNobody links here.\n`);
    writeFileSync(path.join(wikiDir, 'concepts', 'machine-learning.md'), '# Machine learning\n\nLearning from data.\n');
    writeFileSync(path.join(wikiDir, 'concepts', 'machine-learning-systems.md'), '# Machine learning systems\n\nSystems that learn.\n');

    section('10. v3.67.0 — every Health estimate route carries runsOn, and nothing else changed');
    const cases = [
      { p: '/:domain/broken-links/estimate', kind: 'brokenLinks', direct: () => estimateBrokenLinkFix(domain), extra: {} },
      { p: '/:domain/orphans/estimate', kind: 'orphans', direct: () => estimateOrphanRescue(domain), extra: {} },
      { p: '/:domain/semantic-dupes/estimate', kind: 'semanticDupes', direct: () => estimateSemanticDuplicateScan(domain, 500), extra: { costCeilingTokens: 50_000 } },
    ];
    const SPLIT = healthAiTesting.HEALTH_TOKEN_SPLIT || {};
    for (const c of cases) {
      const r = await call('get', c.p, { domain });
      const est = await c.direct();
      const expectedOld = { ok: true, ...est, ...c.extra };
      eq(r.status, 200, `${c.p}: 200, unchanged`);
      ok(JSON.stringify(without(r.body, 'runsOn')) === JSON.stringify(expectedOld),
        `${c.p}: the body minus runsOn is BYTE-identical to {ok:true, ...estimate${c.extra.costCeilingTokens ? ', costCeilingTokens' : ''}} — no existing field changed`);
      const R = r.body.runsOn || {};
      ok(R.job === 'wiki-health' && R.jobLabel === 'Wiki health' && R.needsKey === false, `${c.p}: runsOn is the wiki-health run line`);
      const split = SPLIT[c.kind] || {};
      eq(R.inputTokensLow, Math.round(est.estimatedTokens * split.input), `${c.p}: runsOn input is the estimate's own ${split.input} share`);
      eq(R.inputTokensLow, R.inputTokensHigh, `${c.p}: a POINT, as Health estimates always were`);
      eq(R.outputTokensLow, Math.round(est.estimatedTokens * split.output), `${c.p}: runsOn output is the estimate's own ${split.output} share`);
      ok(close(R.usdHigh, est.estimatedUsd) && close(R.usdLow, est.estimatedUsd),
        `${c.p}: runsOn's dollar figure is the confirm's estimatedUsd (${R.usdHigh} vs ${est.estimatedUsd})`);
    }
    // The split is ONE table, read by the estimates too (a second copy would drift).
    const src = readFileSync(HEALTH_AI_SRC, 'utf8');
    ok(!/estimatedTokens \* 0\.(6|85|9)\b/.test(src), 'no estimate keeps its own literal split — HEALTH_TOKEN_SPLIT is the one table');

    // Unpriced: runs, says so, carries no dollar field.
    process.env.LLM_MODEL = 'zz-genuinely-unpriced-model-id';
    const ru = (await call('get', '/:domain/broken-links/estimate', { domain })).body.runsOn || {};
    eq(ru.costNote, 'price-not-published', 'unpriced model: runsOn.costNote price-not-published');
    ok(!('usdLow' in ru) && !('usdHigh' in ru), 'unpriced model: runsOn has no usd fields — absent, never $0');
    delete process.env.LLM_MODEL;

    // ai-available: the resting-state no-key source (contract §1.13).
    const av = await call('get', '/ai-available');
    eq(Object.keys(av.body).join(','), 'available,provider,model,runsOn', 'ai-available with a key: the old keys, plus runsOn');
    ok(av.body.available === true && av.body.runsOn.needsKey === false && av.body.runsOn.model === av.body.model,
      'ai-available with a key: runsOn names the same model');
    ok(!('inputTokens' in av.body.runsOn) && !('usdHigh' in av.body.runsOn), 'ai-available: runsOn carries no token or dollar figures');
    withoutKey();
    const av2 = await call('get', '/ai-available');
    eq(Object.keys(av2.body).join(','), 'available,reason,runsOn', 'ai-available with NO key: the old keys, plus runsOn');
    eq(av2.body.available, false, 'with no key: available false, unchanged');
    ok(/^No LLM API key found\./.test(av2.body.reason || ''), 'with no key: reason is the real no-key throw, unchanged');
    eq(JSON.stringify(av2.body.runsOn), JSON.stringify({ job: 'wiki-health', jobLabel: 'Wiki health', needsKey: true }),
      'with no key: runsOn is exactly {job, jobLabel, needsKey:true}');
    const noKeyEst = await call('get', '/:domain/broken-links/estimate', { domain });
    eq(noKeyEst.status, 400, 'with no key: the estimate route still answers 400 — status codes unchanged');
    ok(!('runsOn' in noKeyEst.body), 'and its 400 body is unchanged (no runsOn grafted onto an error)');
    withKey();

    section('11. v3.67.0 — every Health plan and scan reports what it actually cost (spent)');
    const MODEL = { provider: 'gemini', model: 'gemini-2.5-flash-lite' };
    const fakeLLM = (reply, usagePerCall, { throwAfter = false } = {}) => {
      const seen = [];
      const fn = async (_s, _u, _m, _f, _w, opts = {}) => {
        const u = { ...usagePerCall[seen.length % usagePerCall.length], ...MODEL };
        seen.push(u);
        if (opts && typeof opts.onUsage === 'function') opts.onUsage(u);
        if (throwAfter) throw new Error('simulated parse-level failure after billing');
        return reply;
      };
      fn.seen = seen;
      return fn;
    };
    const expectedSpent = (usages) => { const acc = makeUsageAccumulator(); for (const u of usages) acc.onUsage(u); return spentFromUsage(acc.totals); };
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    // (a) orphan rescue: two batches, two different usages → spent is the SUM.
    {
      const events = [];
      const llm = fakeLLM('{"results":[]}', [{ inputTokens: 4000, outputTokens: 120 }, { inputTokens: 700, outputTokens: 30 }]);
      const out = await planOrphanRescue(domain, { generateText: llm }, (e) => events.push(e));
      const done = events.find(e => e.type === 'done') || {};
      eq(llm.seen.length, 2, 'orphan rescue: precondition — 13 orphans make TWO LLM calls');
      ok(same(done.spent, expectedSpent(llm.seen)), 'orphan rescue: done.spent equals spentFromUsage of BOTH calls accumulated');
      eq(done.spent && done.spent.inputTokens, 4700, 'orphan rescue: spent sums the batches (4000 + 700), not the last one alone');
      ok(same(out.spent, done.spent), 'orphan rescue: the return value carries the same spent');
      eq(Object.keys(done).join(','), 'type,plan,summary,cost,spent', 'orphan rescue: done keeps plan/summary/cost, plus spent');
      eq(Object.keys(done.cost || {}).join(','), 'provider,model,inputTokens,outputTokens,estimatedUsd,priceKnown,costNote',
        'orphan rescue: the pre-existing cost object is unchanged');
    }
    // (b) broken links: a call that BILLED and then failed still counts.
    {
      const events = [];
      const llm = fakeLLM('not json', [{ inputTokens: 2500, outputTokens: 60 }], { throwAfter: true });
      await planBrokenLinkFixes(domain, { generateText: llm }, (e) => events.push(e));
      const done = events.find(e => e.type === 'done') || {};
      ok(events.some(e => e.type === 'batch-error'), 'broken links: precondition — the batch errored');
      ok(same(done.spent, expectedSpent(llm.seen)) && done.spent.calls === 1,
        'broken links: a batch that billed and then failed is still in spent — money spent is money spent');
      eq(Object.keys(done).join(','), 'type,plan,summary,cost,spent', 'broken links: done keeps plan/summary/cost, plus spent');
    }
    // (c) semantic scan.
    {
      const events = [];
      const llm = fakeLLM('{"results":[]}', [{ inputTokens: 1800, outputTokens: 90, cachedReadTokens: 0, cacheWriteTokens: 0 }]);
      await scanSemanticDuplicates(domain, { maxPairs: 500, costCeilingTokens: 1_000_000, generateText: llm }, (e) => events.push(e));
      const done = events.find(e => e.type === 'done') || {};
      ok(llm.seen.length >= 1, `semantic scan: precondition — it made ${llm.seen.length} call(s)`);
      ok(same(done.spent, expectedSpent(llm.seen)), 'semantic scan: done.spent equals spentFromUsage of its calls');
      eq(Object.keys(done).join(','), 'type,pairs,cost,spent', 'semantic scan: done keeps pairs/cost, plus spent');
      ok(typeof done.spent.usd === 'number' && done.spent.model === 'gemini-2.5-flash-lite', 'semantic scan: spent is priced on the model that billed');
    }
    // (d) no call at all → spent is the nothing-ran shape, usd null (never $0).
    {
      const emptyDomain = 'zztest-health-ai-run-empty';
      for (const sub of ['entities', 'concepts', 'summaries']) mkdirSync(path.join(tmpDomains, emptyDomain, 'wiki', sub), { recursive: true });
      writeFileSync(path.join(tmpDomains, emptyDomain, 'CLAUDE.md'), '# empty\n');
      const llm = fakeLLM('{"results":[]}', [{ inputTokens: 1, outputTokens: 1 }]);
      const out = await planOrphanRescue(emptyDomain, { generateText: llm }, () => {});
      ok(llm.seen.length === 0 && out.spent && out.spent.calls === 0 && out.spent.usd === null && out.spent.model === null,
        'no orphans → no call → spent.calls 0, model null, usd null (the renderer prints nothing, never "$0.00")');
    }

    section('12. v3.67.0 — the production routes pass NO seam (the plan/scan routes still call the real LLM)');
    {
      const rsrc = readFileSync(path.join(ROOT, 'src', 'routes', 'health.js'), 'utf8');
      ok(/planBrokenLinkFixes\(req\.params\.domain, \{\}, send\)/.test(rsrc), 'the broken-links plan route passes {} — no generateText seam reaches production');
      ok(/planOrphanRescue\(req\.params\.domain, \{\}, send\)/.test(rsrc), 'the orphan plan route passes {}');
      ok(!/generateText\s*:/.test(rsrc), 'routes/health.js names no generateText option anywhere');
      const d = await describeHealthRun('not-a-kind', 1000);
      ok(d.job === 'wiki-health' && !('inputTokens' in d), 'describeHealthRun: an unknown kind describes the model with no figures');
      const p = await describeHealthRun('__proto__', 1000);
      ok(!('inputTokens' in p), 'describeHealthRun: an inherited key is not a kind (own-property check)');
    }
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    __setUserDataDirOverride(null);
    __setDomainsDirOverride(null);
    rmSync(tmpUserData, { recursive: true, force: true });
    rmSync(tmpDomains, { recursive: true, force: true });
  }
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All health-ai pricing (shared-source) offline assertions green');
