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
  __testing as healthAiTesting,
} from '../src/brain/health-ai.js';

const { estimateUsdCost, costFields } = healthAiTesting;
const { DEFAULTS, FALLBACK_CHAINS, MODEL_PRICES_USD_PER_MTOK } = llmTesting;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const HEALTH_AI_SRC = path.join(ROOT, 'src', 'brain', 'health-ai.js');
const APP_JS_SRC = path.join(ROOT, 'src', 'public', 'app.js');
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
    const expectedUsd = price.input * 1 + price.output * 1; // 1 MTOK in + 1 MTOK out
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
  const appJsSrc = readFileSync(APP_JS_SRC, 'utf8');
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
  ok(/obj\.costNote/.test(appJsSrc),
    'app.js formatHealthCost() actually reads obj.costNote (not just mentions it in a comment)');
  ok(/est\.costNote/.test(nextDomainsSrc),
    'next/views/domains.js costReadout() actually reads est.costNote (not just mentions it in a comment)');

  // The doc must still name the one real, deliberate gap (the /next compact
  // badge) rather than implying total coverage — a doc that overclaims is
  // exactly the same defect class as one that underclaims.
  ok(/compact.*cost unknown|cost unknown.*compact/is.test(doc),
    'ai-health.md documents the deliberate /next compact-badge "cost unknown" exception');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All health-ai pricing (shared-source) offline assertions green');
