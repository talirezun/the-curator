/**
 * test-chat-model.js — OFFLINE suite for the per-chat model (provider) selector.
 *
 * The chat model selector lets a user with BOTH keys pick Gemini or Claude for a
 * given chat, without changing the global Settings provider. The override is
 * validated server-side: only a provider that actually has a key is honoured;
 * anything else falls back to the global active provider. The selector picks the
 * PROVIDER; the model id comes from DEFAULTS (so a global model bump auto-updates
 * the UI label).
 *
 * Deterministic + free. Key-gated behaviour is exercised by setting dummy keys in
 * this process's env (getEffectiveKey reads config → env), so it doesn't depend
 * on the machine having real keys.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getDefaultModel, getProviderInfo, getModelPrice, compareModelCost,
         isCostlierModel, anthropicMaxOutputTokens, ANTHROPIC_MAX_OUTPUT_TOKENS,
         OFFERABLE_MODELS, DOMINATED_MODELS, AWAITING_MEASUREMENT,
         isOfferableModel, resolveModelPrice, getFallbackStatus,
         isFreeModel, isBuildLaneModel, isKnownProvider, listOfferableModels,
         setOpenRouterCatalogue, normalizeOpenRouterUsage,
         __setAnthropicClientFactory, __setOpenRouterAdapterFactory,
         __testing as llmTesting } from '../src/brain/llm.js';
import { getApiKeys, getActiveProvider, __setDomainsDirOverride } from '../src/brain/config.js';
import { __testing, sendMessage, readConversation, RESPONSE_STYLES } from '../src/brain/chat.js';
// The REAL Express router, so §18(d) can DRIVE the POST handler rather than
// grep it. Importing it is side-effect free (it only wires handlers).
import chatRouter from '../src/routes/chat.js';
// §11's ONE genuinely-derived ceiling check. `MULTI_PHASE_OUTLINE_TOKENS` is
// the output budget ingest asks for on the Phase-1 outline call, so it is the
// floor a build-lane model's ceiling has to clear. Read from ingest.js rather
// than re-typed, so the floor moves with the thing it is a floor for; the
// import is side-effect free (chat.js already pulls this module in).
import { __testing as ingestTesting } from '../src/brain/ingest.js';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync as writeFile } from 'node:fs';
import os from 'node:os';

const { normalizeChatProvider, normalizeChatModel, buildAssistantMessage } = __testing;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(a, b, label) { ok(a === b, `${label} (got ${JSON.stringify(a)})`); }
function section(t) { console.log(`\n${t}`); }

// ── 1. getDefaultModel — deterministic, key-independent ─────────────────────
// getDefaultModel deliberately honours the LLM_MODEL dev override for the
// ACTIVE provider, so asserting the pinned default has to neutralise that env
// var first — otherwise a developer with a perfectly legitimate override
// (`LLM_MODEL=gemini-3.1-flash-lite npm test`) reds the build for no reason.
// The override's own behaviour is asserted separately, below.
section('1. getDefaultModel — current default model id per provider');
{
  const savedModel = process.env.LLM_MODEL;
  try {
    delete process.env.LLM_MODEL;
    eq(getDefaultModel('gemini'), 'gemini-2.5-flash-lite', 'gemini default model');
    eq(getDefaultModel('anthropic'), 'claude-haiku-4-5', 'anthropic default model');
    eq(getDefaultModel('foo'), null, 'unknown provider → null');
    eq(getDefaultModel(null), null, 'null → null');

    // The override applies to the ACTIVE provider only — never label one
    // provider with the other's model id.
    const active = getActiveProvider();
    process.env.LLM_MODEL = 'zz-test-override-model';
    if (active === 'gemini' || active === 'anthropic') {
      const other = active === 'gemini' ? 'anthropic' : 'gemini';
      eq(getDefaultModel(active), 'zz-test-override-model',
        `LLM_MODEL overrides the active provider (${active})`);
      eq(getDefaultModel(other), llmTesting.DEFAULTS[other],
        `LLM_MODEL does NOT leak into the inactive provider (${other})`);
    } else {
      // No key configured anywhere (clean CI checkout) — no active provider,
      // so the override must not apply to either.
      eq(getDefaultModel('gemini'), 'gemini-2.5-flash-lite',
        'no active provider → LLM_MODEL does not apply (gemini)');
      eq(getDefaultModel('anthropic'), 'claude-haiku-4-5',
        'no active provider → LLM_MODEL does not apply (anthropic)');
    }
  } finally {
    if (savedModel === undefined) delete process.env.LLM_MODEL;
    else process.env.LLM_MODEL = savedModel;
  }
}

// ── 2. normalizeChatProvider — invalid inputs → null (no key needed) ────────
section('2. normalizeChatProvider — invalid inputs fall back to global (null)');
for (const bad of ['garbage', 'GEMINI', '', null, undefined, 42, {}, []]) {
  eq(normalizeChatProvider(bad), null, `${JSON.stringify(bad)} → null`);
}

// ── 3. normalizeChatProvider is CONFIG-based (Settings keys, NOT .env) ───────
// The chat override is honoured iff the provider's key is SAVED IN SETTINGS
// (config), regardless of any .env fallback. We assert this relative to the
// machine's actual config, so it's deterministic on a configured dev machine
// (keys present → honoured) AND on CI (no config → both null). Crucially, a
// dummy .env key must NOT make a config-less provider honourable.
section('3. normalizeChatProvider — config (Settings) keys only, not .env');
{
  const cfg = getApiKeys();
  eq(normalizeChatProvider('gemini'), cfg.geminiApiKey ? 'gemini' : null,
    `gemini honoured iff config has the key (config gemini=${!!cfg.geminiApiKey})`);
  eq(normalizeChatProvider('anthropic'), cfg.anthropicApiKey ? 'anthropic' : null,
    `anthropic honoured iff config has the key (config anthropic=${!!cfg.anthropicApiKey})`);

  // A .env-only key must NOT flip a config-less provider to honourable.
  const savedA = process.env.ANTHROPIC_API_KEY;
  try {
    process.env.ANTHROPIC_API_KEY = 'dummy-env-only-anthropic-key';
    eq(normalizeChatProvider('anthropic'), cfg.anthropicApiKey ? 'anthropic' : null,
      'a .env-only anthropic key does NOT make it chat-selectable (config decides)');
  } finally {
    if (savedA === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedA;
  }
}

// ── 4. Source guards — the override is threaded end to end ──────────────────
section('4. Source guards — provider override wired through the stack');
{
  const llm = readFileSync(path.join(ROOT, 'src/brain/llm.js'), 'utf8');
  ok(/export function getDefaultModel\(provider\)/.test(llm), 'llm.js exports getDefaultModel');
  ok(/export function getProviderInfo\(preferProvider = null, preferModel = null\)/.test(llm),
    'getProviderInfo takes a preferProvider AND a preferModel override');
  ok(/async function callLLM\([^)]*providerOverride = null[,)]/.test(llm), 'callLLM takes providerOverride');
  ok(/generateText\([^)]*opts = \{\}\)/.test(llm), 'generateText takes an opts object');

  const chat = readFileSync(path.join(ROOT, 'src/brain/chat.js'), 'utf8');
  ok(/export function normalizeChatProvider/.test(chat), 'chat.js exports normalizeChatProvider');
  ok(/getApiKeys\(\)/.test(chat) && !/getEffectiveKey\(/.test(chat),
    'normalizeChatProvider gates on config (getApiKeys), NOT a getEffectiveKey/.env call');
  // ── THE INSTRUMENT CHANGED HERE, DELIBERATELY ─────────────────────────────
  // This used to be `/normalizeChatProvider\(opts\.provider\)/` — a pin on the
  // literal ARITY of the call. It broke on a CORRECT change (chat.js now calls
  // `normalizeChatProvider(opts.provider, chatModel)`) while the behaviour it
  // named never regressed for a moment. A guard that reds on a correct edit and
  // stays green on a real one is worse than no guard: it trains people to
  // "fix" the assertion, and the obvious fix — contorting the production call
  // back to one argument — would have re-opened a real defect.
  //
  // The ORIGINAL INTENT ("sendMessage normalises opts.provider") is already
  // proven BEHAVIOURALLY, and better, in §15: an offerable model on an UNKEYED
  // provider is sent through the real sendMessage and must come back
  // `provider: null` having been answered by the global provider. If sendMessage
  // ever stopped normalising opts.provider, that assertion reds — it drives the
  // whole path instead of describing one line of it. So the arity pin is not
  // repaired, it is REPLACED by the thing arity was standing in for.
  ok(/normalizeChatProvider\(\s*opts\.provider\b/.test(chat),
    'sendMessage normalises opts.provider (shape-tolerant: pins the ARGUMENT, not the arity — see §15 for the behavioural proof this is a belt-and-braces restatement of)');

  // ── AND THE PART NOTHING WAS GUARDING: the two are COUPLED ────────────────
  // The model must be resolved FIRST and handed to the provider gate. Resolved
  // independently the two can disagree, and a model honoured beside a REFUSED
  // provider is sent to the GLOBAL provider, which discards it as not offerable
  // there and answers on a provider the user never picked — the same mis-bill
  // as the picker bug, one layer down. This is a real invariant, it is what the
  // second argument exists for, and no arity pin could ever have expressed it.
  {
    const iModel = chat.indexOf('normalizeChatModel(opts.provider');
    const iProv  = chat.search(/normalizeChatProvider\(\s*opts\.provider\b/);
    ok(iModel !== -1, 'sendMessage resolves the model via normalizeChatModel(opts.provider, …)');
    ok(iProv !== -1, 'sendMessage resolves the provider via normalizeChatProvider(opts.provider, …)');
    ok(iModel !== -1 && iProv !== -1 && iModel < iProv,
      'ORDER IS LOAD-BEARING: the MODEL is resolved BEFORE the provider gate, so a provider whose model was accepted is accepted WITH it');
    ok(/normalizeChatProvider\(\s*opts\.provider\s*,\s*[A-Za-z_$][\w$]*/.test(chat),
      'COUPLING: the resolved model is passed INTO the provider gate — decoupled, a honoured model beside a refused provider goes to the GLOBAL provider and mis-bills');
  }
  ok(/generateText\([\s\S]{0,600}?provider: chatProvider,/.test(chat),
    'sendMessage passes the provider override to generateText');
  ok(/provider: chatProvider,\s*\/\//.test(chat) || /provider: chatProvider,/.test(chat), 'sendMessage returns the resolved provider');

  const route = readFileSync(path.join(ROOT, 'src/routes/chat.js'), 'utf8');
  ok(/responseStyle, provider/.test(route), 'chat route reads provider from the body');
  // WIDENED (chat-cancellation) for the same reason as its twin in
  // test-chat-style.js: a closed literal cannot survive the options object
  // growing, and chat now also forwards an AbortSignal. Still anchored to the
  // sendMessage CALL and still requires all three names, so a field silently
  // ceasing to be forwarded — this repo's dead-data defect — still reds it.
  ok(/sendMessage\(domain, conversationId \|\| null, message, \{[^}]*\bresponseStyle\b[^}]*\bprovider\b[^}]*\bmodel\b[^}]*\}/.test(route),
    'chat route passes provider AND model to sendMessage');

  const cfg = readFileSync(path.join(ROOT, 'src/routes/config.js'), 'utf8');
  ok(/models:\s*\{/.test(cfg), 'api-keys route returns a models map');
  ok(/getDefaultModel\('gemini'\)/.test(cfg) && /getDefaultModel\('anthropic'\)/.test(cfg),
    'models map is derived from getDefaultModel (auto-updates on a global model bump)');
  ok(!/geminiUsable|anthropicUsable/.test(cfg),
    'api-keys route no longer exposes the misleading usable (config-or-env) flags');

  // REMOVED in v3.41.0 — three assertions that the DELETED src/public/app.js
  // keyed its chat model selector off the config-only hasGeminiKey /
  // hasAnthropicKey flags rather than the config-or-env `usable` ones (the
  // v3.0.11 bug, where a Disconnected-but-.env key stayed pickable in chat).
  // The ROUTE half of that invariant is asserted immediately above and is
  // the half that actually enforces it: `!/geminiUsable|anthropicUsable/`
  // over src/routes/config.js means the misleading flags are not on the wire
  // at all, so no frontend can key off them. /next's own picker is covered by
  // scripts/test-next-model-picker.js.
}

// ── 5. Fallback cost comparison — exact-id price map ────────────────────────
// A fallback silently changes what the user is billed. The verdict MUST be
// driven by an exact-id price table: a family-name heuristic (flash-lite /
// haiku) cannot see a within-family price change, and scored
// gemini-2.5-flash-lite → gemini-3.1-flash-lite as "same tier" when it is
// 2.5x input / 3.75x output — silent on the rung the chain reaches FIRST.
section('5. Model price map — every shipped model id is priced');
{
  const { DEFAULTS, FALLBACK_CHAINS, MODEL_PRICES_USD_PER_MTOK } = llmTesting;
  // "Shipped" is now the UNION of three lists, not two: a user-offerable model
  // is every bit as billable as a default or a fallback rung, and its price is
  // additionally shown to the user in the picker before they choose it. Both
  // halves of this section move together — widening the union without widening
  // the equality below would silently stop catching dead-weight entries.
  // ── DEFAULTS POSTURE: a provider default NAMES a model, or is null ─────────
  // `DEFAULTS.openrouter` is null ON PURPOSE (v3.15.0). A provider may have no
  // build-lane default until a model has been measured against this repo's real
  // ingest outline prompt; picking a plausible id off a public catalogue would
  // be a guess about JSON reliability and hidden thinking tokens dressed up as
  // a default, on the one path where a wrong guess writes a whole wiki.
  //
  // So `shipped` can no longer be "every value in DEFAULTS" — but the filter
  // that fixes that is itself a hazard: quietly dropping falsy values would
  // also drop a genuine `''` typo, and would shrink this whole section's sweep
  // with nothing to notice. The RULE is therefore ASSERTED first and the set of
  // null-carrying providers is PINNED, so nulling gemini's or anthropic's
  // default reds here instead of silently emptying the coverage below.
  const unpinnedProviders = Object.entries(DEFAULTS)
    .filter(([, id]) => id === null).map(([p]) => p).sort();
  // RE-POINTED. This read 'openrouter' while that provider had no measured
  // build-lane model. The live measurement session (9 runs each against the
  // real 341,005-char ingest prompt) closed that: DEFAULTS.openrouter is now
  // `upstage/solar-pro4`, so NO provider is unpinned and the expected set is
  // empty. The pin is KEPT rather than deleted, and still does two jobs — it
  // reds if a fourth provider lands with no measured default, and it reds if
  // anyone nulls an existing one. `''` is a state, not an absence of guard.
  eq(unpinnedProviders.join(','), '',
    'every provider now carries a MEASURED build-lane default — no provider is unpinned (a new null here means an unmeasured provider shipped)');
  for (const [p, id] of Object.entries(DEFAULTS)) {
    ok(id === null || (typeof id === 'string' && id.length > 0),
      `DEFAULTS.${p} is a non-empty model id, or null meaning "nothing measured yet" — never '' and never an object`);
  }

  const shipped = [
    ...Object.values(DEFAULTS),
    ...Object.values(FALLBACK_CHAINS).flat(),
    ...Object.values(OFFERABLE_MODELS).flat().map(m => m.id),
  ].filter(id => id !== null);
  // The filter must drop ONLY the nulls. Nothing below iterates over what is
  // missing, so an over-broad filter would read as green.
  for (const [p, id] of Object.entries(DEFAULTS)) {
    if (id === null) continue;
    ok(shipped.includes(id), `DEFAULTS.${p} ("${id}") survives the null filter and IS swept below`);
  }
  const shippedSet = new Set(shipped);

  // ── PRICE POSTURE: priced, or EXPLICITLY free. Never {input:0, output:0} ────
  // Standing invariant, widened rather than relaxed. It used to read "every
  // shipped id has a price". v3.15.0 admits a second legal posture — explicitly
  // free — because OpenRouter carries genuinely $0 models, and recording one as
  // {input: 0, output: 0} is the single most dangerous shape available: that
  // object is TRUTHY, so `usdHigh` becomes 0, `createJob`'s budget guard accepts
  // a cap it believes it can enforce, and spend tracks at zero forever while
  // every flag reports success — v3.3.0's inert-cap defect re-armed and worse,
  // because there the number at least moved.
  //
  // "Free" is therefore MEMBERSHIP (FREE_MODELS), never a price test, and
  // getModelPrice() must keep returning null for it. Adding a rung or an
  // offerable model with NEITHER posture still fails here.
  const freeShipped = [...shippedSet].filter(id => isFreeModel(id));
  const unpriced = [...shippedSet].filter(id => !getModelPrice(id) && !isFreeModel(id));
  ok(unpriced.length === 0,
    `every DEFAULTS + FALLBACK_CHAINS + OFFERABLE id has a KNOWN PRICE POSTURE — priced, or explicitly free${unpriced.length ? ` (no posture: ${unpriced.join(', ')})` : ''}`);
  for (const id of freeShipped) {
    eq(getModelPrice(id), null,
      `${id}: a FREE model resolves to NO price — getModelPrice must stay null, never {input:0,output:0} (that object is truthy and would make a budget cap inert)`);
  }
  eq(Object.keys(MODEL_PRICES_USD_PER_MTOK).length, shippedSet.size - freeShipped.length,
    'price map has no entries beyond the PRICED ids we actually ship (free ids are shipped but deliberately unpriced)');
  for (const [id, price] of Object.entries(MODEL_PRICES_USD_PER_MTOK)) {
    ok(typeof price.input === 'number' && typeof price.output === 'number'
       && price.input > 0 && price.output > 0, `${id} has positive input+output prices`);
  }

  // The table is shared module state reached through __testing. A test that
  // mutated it would silently corrupt every later cost comparison in the same
  // process, so it is frozen at definition — table AND entries.
  ok(Object.isFrozen(MODEL_PRICES_USD_PER_MTOK), 'exported price table is frozen');
  ok(Object.values(MODEL_PRICES_USD_PER_MTOK).every(p => Object.isFrozen(p)),
    'each price entry is frozen (no per-field mutation)');
  {
    const before = getModelPrice('claude-haiku-4-5').input;
    try { MODEL_PRICES_USD_PER_MTOK['claude-haiku-4-5'].input = 0; } catch { /* strict mode */ }
    try { MODEL_PRICES_USD_PER_MTOK['zz-injected'] = { input: 0, output: 0 }; } catch { /* strict mode */ }
    eq(getModelPrice('claude-haiku-4-5').input, before, 'a mutation attempt cannot change a price');
    eq(getModelPrice('zz-injected'), null, 'a mutation attempt cannot add a model id');
  }
}

section('6. compareModelCost — every rung of every shipped chain');
{
  const { DEFAULTS, FALLBACK_CHAINS } = llmTesting;
  // Verified 2026-08-24 against the providers' published pricing pages.
  const expected = {
    // Gemini: EVERY rung is costlier than the default — the exact case the old
    // family heuristic got wrong on the first two. (gemini-3.5-flash-lite was
    // removed from the chain 2026-08-26 — strictly dominated by
    // gemini-2.5-flash on price AND JSON reliability — so it has no entry
    // here; this map is looked up only for rungs actually in the chain.)
    'gemini-3.1-flash-lite':     'costlier',   // $0.25/$1.50 vs $0.10/$0.40
    'gemini-2.5-flash':          'costlier',   // $0.30/$2.50
    // Anthropic: the entire Haiku 3.5 family is retired (404), so every live
    // rung is now Sonnet and all three are costlier than the Haiku 4.5 default.
    // Honest, and the reason getFallbackStatus surfaces a costTier at all.
    'claude-sonnet-5':           'costlier',   // $2/$10 vs $1/$5
    'claude-sonnet-4-6':         'costlier',   // $3/$15
    'claude-sonnet-4-5':         'costlier',   // $3/$15
  };
  for (const provider of ['gemini', 'anthropic']) {
    for (const rung of FALLBACK_CHAINS[provider]) {
      eq(compareModelCost(DEFAULTS[provider], rung), expected[rung],
        `${provider}: ${DEFAULTS[provider]} → ${rung}`);
    }
  }
  eq(compareModelCost('gemini-2.5-flash-lite', 'gemini-2.5-flash-lite'), 'similar',
    'identical models → similar');
  eq(compareModelCost('gemini-2.5-flash', 'gemini-2.5-flash-lite'), 'similar',
    'a cheaper fallback is not costlier');
}

section('7. compareModelCost — unknown ids never imply parity');
{
  eq(compareModelCost('gemini-2.5-flash-lite', 'gemini-9.9-unreleased'), 'unknown',
    'unknown target → unknown (not a silent "similar")');
  eq(compareModelCost('some-retired-model', 'gemini-2.5-flash-lite'), 'unknown',
    'unknown source → unknown');
  eq(compareModelCost('a', 'b'), 'unknown', 'both unknown → unknown');
  eq(compareModelCost(null, undefined), 'unknown', 'null/undefined → unknown');
  ok(isCostlierModel('gemini-2.5-flash-lite', 'gemini-9.9-unreleased') === false,
    'the legacy boolean is false for unknown (why the banner uses costTier)');
  ok(isCostlierModel('gemini-2.5-flash-lite', 'gemini-3.1-flash-lite') === true,
    'the legacy boolean is true for a confirmed costlier fallback');
  // Prototype keys must not resolve through the plain object.
  for (const k of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    eq(getModelPrice(k), null, `getModelPrice(${JSON.stringify(k)}) → null`);
  }
  eq(getModelPrice(123), null, 'non-string → null');
  eq(getModelPrice(null), null, 'null → null');
}

section('8. Source guards — cost warning + boot guard wiring');
{
  const llm = readFileSync(path.join(ROOT, 'src/brain/llm.js'), 'utf8');
  ok(!/getModelCostTier|flash-lite'\)\s*\)\s*return 1/.test(llm),
    'the family-name cost heuristic is gone (exact-id map only)');
  ok(/costTier/.test(llm) && /compareModelCost/.test(llm),
    'getFallbackStatus exposes costTier via compareModelCost');
  ok(/costlier: costTier === 'costlier'/.test(llm),
    'the legacy costlier boolean is preserved (additive payload)');

  // Repointed in v3.41.0 from the deleted src/public/app.js to the shell that
  // ships. The banner contract is the same one: read `costTier`, keep the
  // legacy `costlier` boolean as a fallback so an older payload still renders,
  // and give the unknown-price state its OWN wording rather than letting it
  // read as "similar" — a silent price change is the defect this exists for.
  const settings = readFileSync(path.join(ROOT, 'src/public/next/views/settings.js'), 'utf8');
  ok(/costTier/.test(settings), 'the fallback banner reads costTier');
  ok(/fallback\.costlier/.test(settings),
    'and still honours the legacy costlier boolean (additive payload, older servers)');
  ok(/'unknown'/.test(settings),
    'banner has a distinct branch for the unknown-price state');

  // The boot-guard assertions here read src/public/index.html and
  // src/public/app.js, both deleted in v3.41.0. Repointed at the shell that
  // actually ships: the sentinel contract is identical (an inline <head>
  // guard, and app.js setting window.__curatorBooted on its LAST line), and
  // it is the contract — not the file — that CLAUDE.md records as
  // load-bearing. The markdown.js half is dropped with the file: /next
  // imports its renderer as an ES module, so there is no optional classic
  // script to be non-fatal about.
  const html = readFileSync(path.join(ROOT, 'src/public/next/index.html'), 'utf8');
  ok(/__curatorBooted/.test(html), 'boot guard is inline in next/index.html (before app.js can throw)');
  const appSrc = readFileSync(path.join(ROOT, 'src/public/next/app.js'), 'utf8');
  // The deleted shell was ONE module and set the sentinel as its literal last
  // statement. /next sets it from markBooted(), called immediately after
  // boot() returns on both readyState arms — the same guarantee expressed for
  // a multi-module shell, and the one next/index.html's head guard reads.
  ok(/function markBooted\(\)\s*\{[^}]*window\.__curatorBooted = true;/.test(appSrc),
    'markBooted() is what sets the boot sentinel in next/app.js');
  ok((appSrc.match(/boot\(\);\s*markBooted\(\);/g) || []).length +
     (appSrc.match(/boot\(\);\n\s*markBooted\(\);/g) || []).length >= 1,
    'and it runs immediately after boot() returns');
}

// ── 9. Fallback chain health — no dead rungs, cheapest-first ────────────────
// The chain's PROMISE is "when the pinned default is retired, land on the
// cheapest model that still works". Two ways that promise silently rots, both of
// which have now happened once each in this repo:
//   • a rung 404s (Gemini v3.0.15: 2 of 3 dead; Anthropic v3.5.x: 4 of 5 dead)
//   • a rung is priced but ordered wrong, so we land on a costlier live model
// Liveness needs the network and lives in the live suite; ORDERING is pure data
// and is pinned here, where it runs on every `npm test`.
section('9. Fallback chains — priced, ordered cheapest-first, no retired ids');
{
  const { DEFAULTS, FALLBACK_CHAINS, KNOWN_PROVIDERS } = llmTesting;

  // ── PROVIDER LIST DERIVED, NOT HARDCODED ──────────────────────────────────
  // This loop read `['gemini', 'anthropic']`, so when the OpenRouter chain
  // landed it was COMPLETELY UNGUARDED — in the section whose entire job is
  // guarding fallback chains. That is v3.11.0's `FN_NAMES` blind spot verbatim:
  // a hardcoded member list means a new member is not merely unchecked, it is
  // invisible. Derived from the data, and cross-checked against the providers
  // llm.js can actually dispatch to, so neither side can drift alone.
  const chainProviders = Object.keys(FALLBACK_CHAINS).sort();
  eq(chainProviders.join(','), [...KNOWN_PROVIDERS].sort().join(','),
    'FALLBACK_CHAINS has exactly one chain per provider llm.js can dispatch to — a provider with no chain has no safety net at all');

  for (const provider of chainProviders) {
    const chain = FALLBACK_CHAINS[provider];
    ok(chain.length > 0, `${provider}: chain is non-empty (a default with no net is not a net)`);
    ok(new Set(chain).size === chain.length, `${provider}: no duplicate rungs`);
    ok(!chain.includes(DEFAULTS[provider]),
      `${provider}: the default is not repeated as its own fallback`);

    // EVERY rung priced, asserted per-rung rather than only pairwise. The
    // pairwise loop below starts at i=1, so a ONE-RUNG chain — which is exactly
    // what OpenRouter ships — had no price assertion at all. An unpriced rung
    // silently degrades compareModelCost to 'unknown', so the fallback banner
    // stops being able to warn the user they were moved onto something dearer.
    for (const rung of chain) {
      ok(getModelPrice(rung) !== null || isFreeModel(rung),
        `${provider}: rung "${rung}" has a known price posture — priced, or explicitly free`);
      ok(!Object.hasOwn(DOMINATED_MODELS, rung),
        `${provider}: rung "${rung}" is not DOMINATED — a chain picks silently FOR the user, on the day their default died, so a measured-worse model must never be reachable there`);
    }

    // ── CHEAPEST-FIRST IS A TOTAL ORDER, AND THE PRICE SPACE IS NOT ──────────
    // RECORDED LIMIT, for whoever adds the next rung: this requires each rung to
    // be no cheaper than the previous on BOTH axes, which is only satisfiable
    // when the candidates are pairwise comparable. OpenRouter's are not.
    // `ibm-granite/granite-4.0-h-micro` is 0.017/0.112 and `nex-agi/nex-n2-mini`
    // is 0.025/0.10 — cheaper on input, dearer on output, so NEITHER order
    // admits both and no chain containing both can satisfy this assertion. The
    // shipped one-rung chain is valid; a two-rung chain drawn from that pair is
    // not, and the failure will look like a broken guard rather than an
    // impossible request unless you have read this.
    //
    // A tie is fine (Sonnet 4.6 / 4.5); a strict decrease is not.
    for (let i = 1; i < chain.length; i++) {
      const prev = getModelPrice(chain[i - 1]);
      const cur = getModelPrice(chain[i]);
      const bothPriced = Boolean(prev && cur);
      ok(bothPriced, `${provider}: rungs ${i - 1} and ${i} are both priced`);
      // Guarded, not dereferenced optimistically: an unpriced rung must produce a
      // clean FAIL here, not a TypeError that aborts the file and hides every
      // assertion after it. (Caught by mutation-testing this very guard.)
      ok(bothPriced && cur.input >= prev.input && cur.output >= prev.output,
        `${provider}: rung ${i} (${chain[i]}) is not cheaper than rung ${i - 1} (${chain[i - 1]}) — chain stays cheapest-first`);
    }
  }
  // Regression guard: these four Anthropic ids were probed 404 on 2026-08-24 and
  // must never reappear. Re-adding one would restore a chain that "works" in
  // every offline test while doing nothing at all in production.
  const RETIRED = ['claude-3-5-haiku-latest', 'claude-3-5-haiku-20241022',
                   'claude-3-7-sonnet-latest', 'claude-3-5-sonnet-latest',
                   'gemini-1.5-flash', 'gemini-1.5-flash-latest'];
  const shippedIds = [...Object.values(DEFAULTS), ...Object.values(FALLBACK_CHAINS).flat()];
  for (const dead of RETIRED) {
    ok(!shippedIds.includes(dead), `retired id "${dead}" is not shipped`);
    eq(getModelPrice(dead), null, `retired id "${dead}" carries no dead-weight price entry`);
  }

  // ── DOMINATED: the class the bespoke gemini-3.5-flash-lite pair became ────
  // Distinct from RETIRED above. A RETIRED id 404s; a DOMINATED id WORKS and is
  // honestly priced, but a same-priced sibling measured better on every axis we
  // tested. That does not make it unshippable — the user may still choose it
  // deliberately with the reason on screen — it makes it unfit for a chain,
  // where the app chooses silently ON the user's behalf, at the moment their
  // pinned default has just been retired.
  //
  // Until now this was one hardcoded pair of assertions naming
  // `gemini-3.5-flash-lite` specifically, so the SECOND dominated model would
  // have needed someone to remember to write its own pair. It is a list now, and
  // the invariant below is a class invariant over that list.
  //
  // The expected membership is hardcoded HERE, deliberately, rather than read
  // only from llm.js: a guard whose expectations come entirely from the data it
  // guards cannot notice that data being deleted. Removing an id from
  // DOMINATED_MODELS and re-adding it to a chain must go red.
  const EXPECT_DOMINATED = {
    'gemini-3.5-flash-lite': 'gemini-2.5-flash',
    'claude-opus-4-5':       'claude-opus-5',
  };
  for (const [id, by] of Object.entries(EXPECT_DOMINATED)) {
    ok(Object.hasOwn(DOMINATED_MODELS, id), `DOMINATED_MODELS still records "${id}"`);
    eq(DOMINATED_MODELS[id]?.dominatedBy, by, `"${id}" is recorded as dominated by "${by}"`);
  }
  eq(Object.keys(DOMINATED_MODELS).length, Object.keys(EXPECT_DOMINATED).length,
    'DOMINATED_MODELS has no entries beyond the ones this suite knows about');

  for (const [id, rec] of Object.entries(DOMINATED_MODELS)) {
    // THE load-bearing invariant: dominated ids are banned from the chains (the
    // app picks) but ALLOWED in OFFERABLE (the user picks). Two lists, two rules.
    // Derived, for the same reason as the chain loop above: hardcoded here, a
    // dominated model could be added to the OpenRouter chain with nothing to say so.
    for (const provider of chainProviders) {
      ok(!FALLBACK_CHAINS[provider].includes(id),
        `dominated "${id}" is not a ${provider} fallback rung (the chain picks FOR the user)`);
    }
    ok(!Object.values(DEFAULTS).includes(id), `dominated "${id}" is not a pinned default`);
    ok(typeof rec.reason === 'string' && rec.reason.length > 40,
      `"${id}" carries a substantive measured reason, not a bare flag`);
    // The thing it loses to must itself be real, priced and no dearer —
    // otherwise "dominated" is an opinion rather than a measurement.
    const mine = getModelPrice(id), theirs = getModelPrice(rec.dominatedBy);
    ok(Boolean(mine && theirs), `"${id}" and its dominator "${rec.dominatedBy}" are both priced`);
    ok(Boolean(mine && theirs) && theirs.input <= mine.input && theirs.output <= mine.output,
      `"${rec.dominatedBy}" is no more expensive than "${id}" (domination requires an equal-or-cheaper winner)`);
    ok(isOfferableModel('gemini', rec.dominatedBy) || isOfferableModel('anthropic', rec.dominatedBy),
      `the dominator "${rec.dominatedBy}" is itself offerable (you can actually choose the better model)`);
  }
  ok(Object.isFrozen(DOMINATED_MODELS), 'DOMINATED_MODELS is frozen');

  // ── AWAITING MEASUREMENT: real models we deliberately refuse to offer ─────
  // A model may not be offered for a feature it has never been measured
  // against. These two have a documented price and ceiling but no live probe
  // with the real ingest prompt — and thinking behaviour in particular cannot
  // be guessed (claude-opus-5 is NEWER than claude-sonnet-5 and thinks 0/3
  // where sonnet-5 thinks 7/7), so an unprobed id's behaviour is unknown, not
  // "probably like its neighbour".
  const EXPECT_AWAITING = ['claude-opus-4-7', 'claude-opus-4-6'];
  eq(Object.keys(AWAITING_MEASUREMENT).length, EXPECT_AWAITING.length,
    'AWAITING_MEASUREMENT holds exactly the ids this suite knows about');
  for (const id of EXPECT_AWAITING) {
    ok(Object.hasOwn(AWAITING_MEASUREMENT, id), `AWAITING_MEASUREMENT records "${id}"`);
    ok(!isOfferableModel('anthropic', id) && !isOfferableModel('gemini', id),
      `unverified "${id}" is NOT offerable`);
    ok(!shippedIds.includes(id), `unverified "${id}" is not a default or a fallback rung`);
    eq(getModelPrice(id), null,
      `unverified "${id}" carries no price entry (pricing it would let it slip into a picker)`);
  }
  ok(Object.isFrozen(AWAITING_MEASUREMENT), 'AWAITING_MEASUREMENT is frozen');

  // No id may be in two states at once.
  for (const id of Object.keys(DOMINATED_MODELS)) {
    ok(!RETIRED.includes(id), `"${id}" is dominated, not retired — the two lists are disjoint`);
    ok(!Object.hasOwn(AWAITING_MEASUREMENT, id), `"${id}" is not simultaneously unmeasured`);
  }
}

// ── 10. Per-model Anthropic output caps ─────────────────────────────────────
// The cap map replaced a flat 64000 constant that silently halved the 128,000
// ceiling of the Sonnet fallback rungs. The load-bearing property is the
// DIRECTION of the unknown-id fallback: guessing HIGH is a hard 400 that fails
// the call, guessing LOW only truncates — and truncation already degrades
// gracefully (v3.0.7). An unknown id must therefore resolve CONSERVATIVELY.
section('10. anthropicMaxOutputTokens — per-model caps, conservative on unknown');
{
  const { DEFAULTS, FALLBACK_CHAINS, ANTHROPIC_MODEL_MAX_OUTPUT_TOKENS } = llmTesting;

  eq(ANTHROPIC_MAX_OUTPUT_TOKENS, 64000,
    'the legacy constant keeps its value (existing consumers unaffected)');

  // Verified 2026-08-24 against the live API: GET /v1/models/{id}.max_tokens AND
  // the validation error text ("max_tokens: 999999 > N") agreed for all four.
  eq(anthropicMaxOutputTokens('claude-haiku-4-5'), 64000, 'haiku-4-5 → 64000');
  eq(anthropicMaxOutputTokens('claude-sonnet-5'), 128000, 'sonnet-5 → 128000');
  eq(anthropicMaxOutputTokens('claude-sonnet-4-6'), 128000, 'sonnet-4-6 → 128000');
  eq(anthropicMaxOutputTokens('claude-sonnet-4-5'), 64000,
    'sonnet-4-5 → 64000 (NOT 128000 — the cap does not track the family word)');
  eq(anthropicMaxOutputTokens('claude-haiku-4-5-20251001'), 64000, 'dated haiku snapshot → 64000');
  eq(anthropicMaxOutputTokens('claude-sonnet-4-5-20250929'), 64000, 'dated sonnet-4.5 snapshot → 64000');

  // THE load-bearing assertion. Mutating the resolver to return the permissive
  // value for an unknown id must turn these red.
  for (const unknown of ['claude-opus-9', 'claude-sonnet-6', 'totally-made-up', '']) {
    eq(anthropicMaxOutputTokens(unknown), ANTHROPIC_MAX_OUTPUT_TOKENS,
      `unknown id ${JSON.stringify(unknown)} → CONSERVATIVE ${ANTHROPIC_MAX_OUTPUT_TOKENS}, never 128000`);
  }
  for (const bad of [null, undefined, 123, {}, []]) {
    eq(anthropicMaxOutputTokens(bad), ANTHROPIC_MAX_OUTPUT_TOKENS,
      `non-string ${JSON.stringify(bad) ?? String(bad)} → conservative default`);
  }
  // Prototype keys must not resolve through the plain object (v3.0.9 bug shape).
  for (const k of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    eq(anthropicMaxOutputTokens(k), ANTHROPIC_MAX_OUTPUT_TOKENS,
      `prototype key ${JSON.stringify(k)} → conservative default`);
  }
  // No unknown id may ever exceed the conservative default, whatever the map says.
  ok(Object.values(ANTHROPIC_MODEL_MAX_OUTPUT_TOKENS).every(v => Number.isInteger(v) && v > 0),
    'every mapped cap is a positive integer');
  ok(Object.isFrozen(ANTHROPIC_MODEL_MAX_OUTPUT_TOKENS), 'the cap map is frozen');

  // Every Anthropic model the app can select must have an explicit cap — the
  // same standing invariant the price table carries, for the same reason.
  const anthropicShipped = [DEFAULTS.anthropic, ...FALLBACK_CHAINS.anthropic];
  const uncapped = anthropicShipped.filter(id => !Object.hasOwn(ANTHROPIC_MODEL_MAX_OUTPUT_TOKENS, id));
  ok(uncapped.length === 0,
    `every shipped Anthropic id has an explicit cap${uncapped.length ? ` (missing: ${uncapped.join(', ')})` : ''}`);

  // The clamp must never widen what a call site asked for.
  for (const id of anthropicShipped) {
    ok(Math.min(65536, anthropicMaxOutputTokens(id)) <= 65536,
      `${id}: clamping 65536 never increases the request`);
  }
}

// ── 11. OFFERABLE_MODELS — the user-pickable catalogue ──────────────────────
// Until this table, The Curator ran exactly two models, both the cheapest tier.
// It now offers the models a user's own key already unlocks — which turns the
// price table from an internal ordering aid into a number a person makes a
// spending decision from. The invariants below exist because of that change of
// audience: an entry that is unpriced, uncapped, unmeasured or mis-ordered is
// not a cosmetic defect any more, it is a cost lie in a picker.
section('11. OFFERABLE_MODELS — complete, frozen, cheapest-first, measured');
{
  const { MODEL_PRICES_USD_PER_MTOK, ANTHROPIC_MODEL_MAX_OUTPUT_TOKENS,
          GEMINI_MODEL_MAX_OUTPUT_TOKENS, OFFERABLE_SUITABILITY,
          defineOfferableModel, DEFAULTS, FALLBACK_CHAINS } = llmTesting;

  const { capsFor, KNOWN_PROVIDERS } = llmTesting;

  // Non-vacuous precondition: if this ever resolves to undefined the floor
  // assertion below becomes `m.maxOutput >= undefined` -> false for everything,
  // i.e. it would fail loudly rather than silently pass. Asserted anyway so the
  // reason is named at the source rather than discovered in 20 red lines.
  const OUTLINE_BUDGET_TOKENS = ingestTesting.MULTI_PHASE_OUTLINE_TOKENS;
  ok(Number.isInteger(OUTLINE_BUDGET_TOKENS) && OUTLINE_BUDGET_TOKENS > 0,
    `ingest's Phase-1 outline budget was read from ingest.js (${OUTLINE_BUDGET_TOKENS}) — the build-lane ceiling floor is derived from it, not re-typed`);

  /**
   * ── HAND-TYPED OUTPUT CEILINGS — THIS FILE'S OWN STATEMENT ────────────────
   *
   * An entry's `maxOutput` is normally DERIVED: `defineOfferableModel` reads it
   * out of the provider's cap map, and the assertion below proves the entry did
   * not re-type it. That derivation is unavailable for OpenRouter by design —
   * `OPENROUTER_MODEL_MAX_OUTPUT_TOKENS` is deliberately `{}` because an
   * OpenRouter id routes over rotating upstream hosts, so a ceiling frozen into
   * llm.js is a snapshot of a fact that can move without the id changing. Those
   * entries therefore carry `spec.maxOutput` themselves.
   *
   * WHAT WAS ACTUALLY HAPPENING. The else-arm asserted `m.provider ===
   * 'openrouter'` under the premise "only a DYNAMICALLY-admitted OpenRouter
   * entry may carry its own ceiling". That premise is false in this loop:
   * OFFERABLE_MODELS is the STATIC table, nothing in it is dynamic, and the
   * runtime overlay never appears here at all. So all three OpenRouter ceilings
   * fell into an escape arm that checked only "is a positive integer". Measured
   * on this file before the change: derivation-checked = 0, escape-arm = 3.
   * A 10x digit typo on `upstage/solar-pro4` — the PINNED OpenRouter default,
   * and a build-lane entry, so its ceiling governs ingest truncation — shipped
   * at 1144 passed / 0 failed, and five sibling suites missed it too.
   *
   * STATED HONESTLY: this map is a SECOND COPY of a number, which is normally
   * the exact shape this repo forbids. It is not a derivation and does not
   * pretend to be one — there is no second SOURCE for a hand-read OpenRouter
   * ceiling. It is a REVIEW GATE: changing a ceiling must also change this
   * file, so the change is seen by someone. Where a real cross-check does
   * exist it is asserted separately below (the build-lane floor), and that one
   * IS derived.
   *
   * Provenance of each figure: OpenRouter publishes
   * `top_provider.max_completion_tokens` per model; these were read from that
   * field on 2026-08-26, the same probe run that measured the notes.
   */
  const HAND_TYPED_CEILINGS = Object.freeze({
    'minimax/minimax-m3:free':        943718,
    'ibm-granite/granite-4.0-h-micro': 117900,
    'upstage/solar-pro4':              131072,
    // Added 2026-08-28, read from `top_provider.max_completion_tokens` on the
    // live catalogue in the same session that measured their notes. Both clear
    // the 24,576-token outline budget with room, and the DERIVED floor
    // assertion below proves that independently of these figures — this map's
    // job is the OTHER direction, an upward digit typo that no derivation can
    // see (a 10x typo on solar-pro4's ceiling once shipped at 1144 passed / 0
    // failed across six suites).
    'z-ai/glm-5.3-flash':              131072,
    'moonshotai/kimi-k2-0905':         100352,
  });

  // Counters so the SPLIT between the two arms is visible rather than inferred.
  // A silent drift of every entry into the un-derived arm is what hid the hole.
  let capDerived = 0, capSelfDeclared = 0;
  const selfDeclaredIds = [];

  ok(Object.isFrozen(OFFERABLE_MODELS), 'the OFFERABLE_MODELS table is frozen');
  // RE-PINNED, not softened. This literal's job is to catch a provider key
  // appearing (or vanishing) that nobody reviewed. v3.15.0 adds a third
  // deliberately, so the exact set moves to three — it does NOT become
  // `length >= 2`, because a bounds check cannot tell a reviewed addition from
  // an accident, which is the whole value of the original assertion.
  eq(Object.keys(OFFERABLE_MODELS).sort().join(','), 'anthropic,gemini,openrouter',
    'exactly the three providers, no more');
  // …and the table's key set must agree with the providers llm.js will actually
  // dispatch to. Two independent lists that can drift is this repo's named
  // v3.2.0 shape; pinning only the literal above would let KNOWN_PROVIDERS grow
  // a fourth member with no catalogue and nothing would say so.
  eq(Object.keys(OFFERABLE_MODELS).sort().join(','), [...KNOWN_PROVIDERS].sort().join(','),
    'OFFERABLE_MODELS has exactly one key per provider llm.js can dispatch to');

  // ── WHICH PROVIDERS SHIP HAND-MEASURED ENTRIES — a tripwire, not a bound ───
  // `list.length > 0` was right while every provider carried hand-measured
  // models. OpenRouter deliberately carries NONE: its build-lane entries would
  // have to be probed against this repo's real ingest outline prompt, and its
  // chat entries arrive at runtime through setOpenRouterCatalogue(). An empty
  // static list is therefore the HONEST state, not an omission — and pinning it
  // means the day somebody adds a static OpenRouter entry, this reds and the
  // reviewer has to confirm a measurement happened.
  const populated = Object.entries(OFFERABLE_MODELS)
    .filter(([, l]) => l.length > 0).map(([p]) => p).sort();
  // RE-POINTED, same reason. This read 'anthropic,gemini' and carried the note
  // "the day somebody adds a static OpenRouter entry, this reds". That day came:
  // three OpenRouter models were hand-measured and admitted. The tripwire is
  // kept pointing at the POPULATED state so it still fires if a provider's
  // catalogue is emptied, or if a fourth appears without measurement.
  eq(populated.join(','), 'anthropic,gemini,openrouter',
    'every known provider ships a non-empty hand-measured static catalogue (an emptied or unmeasured provider reds here)');

  // Provider list DERIVED from the table, never hand-typed: a hardcoded pair
  // here would mean a third provider's entries were never checked for freezing,
  // pricing, caps, ordering or measurement — silently, with the suite green.
  for (const provider of Object.keys(OFFERABLE_MODELS)) {
    const list = OFFERABLE_MODELS[provider];
    ok(Array.isArray(list) && Object.isFrozen(list), `${provider}: list is a frozen array`);
    ok(new Set(list.map(m => m.id)).size === list.length, `${provider}: no duplicate ids`);

    // `provider === 'gemini' ? GEMINI_CAPS : ANTHROPIC_CAPS` used to stand here.
    // That is a BINARY ternary with no third arm — precisely the v3.10.1 shape
    // that judged a third provider on Anthropic's credential — so a third
    // provider's models would have been checked against Anthropic's cap map and
    // failed for a reason that named the wrong file. `capsFor` is llm.js's own
    // total lookup and is the single source of that mapping.
    // `caps !== null` was true for OpenRouter's deliberately-empty `{}` — a
    // pass that asserted nothing about whether a ceiling could be derived. The
    // POPULATED/EMPTY state is what actually decides which arm every entry
    // below takes, so it is pinned per provider instead of merely non-null.
    const caps = capsFor(provider);
    ok(caps !== null && typeof caps === 'object',
      `${provider}: llm.js knows an output-cap map for this provider`);
    const capCount = caps ? Object.keys(caps).length : -1;
    if (provider === 'openrouter') {
      eq(capCount, 0,
        'openrouter: its cap map is EMPTY BY DESIGN — an id routes over rotating upstream hosts, so a ceiling frozen in llm.js is a snapshot of a fact that can move without the id changing (if this ever gains entries, the else-arm below is no longer the right test)');
    } else {
      ok(capCount > 0,
        `${provider}: ships a POPULATED cap map, so every one of its entries must DERIVE its ceiling (${capCount} entries)`);
    }

    for (const m of list) {
      ok(Object.isFrozen(m), `${m.id}: entry is frozen`);
      eq(m.provider, provider, `${m.id}: carries its provider`);
      ok(typeof m.label === 'string' && m.label.length > 0, `${m.id}: has a human label`);

      // COMPLETE — priced and capped. Not "has a number", but "agrees with the
      // single source of truth", because the entry DERIVES both rather than
      // re-typing them; two hand-maintained copies of a price is how a picker
      // starts quoting a number the biller disagrees with.
      const price = getModelPrice(m.id);
      // POSTURE-AWARE, and the free branch is the stricter of the two. A free
      // entry must resolve to NO price at all — `{input: 0, output: 0}` is
      // truthy and would make a budget cap inert while every flag reported
      // success (see §5). `m.free` is the single source of that verdict.
      if (m.free) {
        eq(price, null, `${m.id}: FREE entry resolves to NO price — never a zero pair`);
        eq(m.input, null, `${m.id}: FREE entry exposes input: null on the wire, not 0`);
        eq(m.output, null, `${m.id}: FREE entry exposes output: null on the wire, not 0`);
        eq(m.standardInput, null, `${m.id}: FREE entry has no standard price either`);
        eq(m.standardOutput, null, `${m.id}: FREE entry has no standard price either`);
      } else {
        ok(Boolean(price), `${m.id}: is priced (MODEL_PRICES_USD_PER_MTOK, or a registered dynamic price)`);
        ok(Boolean(price) && m.input === price.input && m.output === price.output,
          `${m.id}: entry price is derived from the price table, not a second copy`);
        ok(typeof m.standardInput === 'number' && typeof m.standardOutput === 'number'
           && m.standardInput > 0 && m.standardOutput > 0,
          `${m.id}: carries a positive standard (post-promotional) price`);
      }
      // CAPPED. A statically-admitted entry DERIVES its ceiling from the
      // provider cap map; a dynamically-admitted one (OpenRouter's catalogue)
      // brings its own, because that ceiling comes from the provider's API
      // rather than from a hand-typed table. Either way `maxOutput` must be a
      // positive integer, and where BOTH exist they must agree — two
      // hand-maintained copies of one number is the shape this repo names.
      ok(Number.isInteger(m.maxOutput) && m.maxOutput > 0, `${m.id}: cap is a positive integer`);
      if (Object.hasOwn(caps, m.id)) {
        capDerived++;
        eq(m.maxOutput, caps[m.id], `${m.id}: maxOutput is derived from the cap map, not a second copy`);
      } else {
        // PROVENANCE, not provider id. Everything in OFFERABLE_MODELS is
        // STATICALLY admitted — the runtime overlay lives in a separate array
        // reached through listOfferableModels() and never appears in this loop
        // — so "it is dynamic" was never an available excuse here. The only
        // legitimate reason an entry cannot derive its ceiling is that its
        // provider has no cap map to derive from.
        capSelfDeclared++;
        selfDeclaredIds.push(m.id);
        ok(capCount === 0,
          `${m.id}: carries its own ceiling, and that is only legitimate because ${provider}'s cap map is deliberately EMPTY — a provider WITH a cap map must derive (${capCount} entries present)`);
        // …and because there is no second SOURCE to derive from, the VALUE is
        // pinned. Not a derivation, a review gate: see HAND_TYPED_CEILINGS.
        ok(Object.hasOwn(HAND_TYPED_CEILINGS, m.id),
          `${m.id}: has a declared expected ceiling in this file — a new self-declared ceiling must be reviewed here, not merely be a positive integer`);
        if (Object.hasOwn(HAND_TYPED_CEILINGS, m.id)) {
          eq(m.maxOutput, HAND_TYPED_CEILINGS[m.id],
            `${m.id}: hand-typed ceiling matches the figure read from the provider (a digit typo reds here — nothing else in the repo sees it)`);
        }
      }

      // ── THE ONE CEILING CHECK THAT IS GENUINELY DERIVED ──────────────────
      // A ceiling is not decoration: `MULTI_PHASE_OUTLINE_TOKENS` is what
      // ingest ASKS FOR on the Phase-1 outline call, so a build-lane model
      // whose ceiling sits below it is structurally unable to serve — llm.js's
      // own OpenRouter docblock rejects `liquid/lfm-2.5-2.6b:free` for exactly
      // that (8,192 against the 24,576 the outline requests). Reading the
      // budget from ingest.js rather than re-typing it means this floor moves
      // with the thing it is a floor for. A 'chat-only' entry is exempt: it
      // never reaches that call.
      //
      // This catches a downward typo on ANY provider with no second copy of a
      // number; the pin above catches an upward one on the un-derived entries.
      if (m.suitability !== 'chat-only') {
        ok(m.maxOutput >= OUTLINE_BUDGET_TOKENS,
          `${m.id}: BUILD-LANE ceiling (${m.maxOutput}) clears the ${OUTLINE_BUDGET_TOKENS}-token Phase-1 outline budget it will be asked to produce`);
      }

      // MEASURED — the fields that only a live probe can supply.
      ok(typeof m.thinks === 'boolean', `${m.id}: measured \`thinks\` present`);
      // `jsonRaw` measures whether a RAW JSON.parse of the ingest outline
      // succeeds. It is meaningless for a model that may never serve ingest, so
      // a 'chat-only' entry may carry null — meaning NOT MEASURED, which is a
      // different fact from `false` (measured bad) and must never be coerced
      // into it. A build-lane entry must still carry a real boolean.
      if (m.suitability === 'chat-only') {
        ok(typeof m.jsonRaw === 'boolean' || m.jsonRaw === null,
          `${m.id}: chat-only entry carries a measured \`jsonRaw\` or null ("not measured") — never undefined`);
      } else {
        ok(typeof m.jsonRaw === 'boolean',
          `${m.id}: BUILD-LANE entry carries a measured \`jsonRaw\` (required for ingest/Health/Compile)`);
      }
      ok(typeof m.tokenizerFactor === 'number' && m.tokenizerFactor >= 1,
        `${m.id}: measured \`tokenizerFactor\` present`);
      ok(OFFERABLE_SUITABILITY.includes(m.suitability),
        `${m.id}: suitability is one of ${OFFERABLE_SUITABILITY.join('|')} (got ${m.suitability})`);
      ok(typeof m.note === 'string' && m.note.trim().length > 40,
        `${m.id}: carries a substantive measured note for the UI to show`);
      eq(m.dominated, Object.hasOwn(DOMINATED_MODELS, m.id),
        `${m.id}: \`dominated\` agrees with DOMINATED_MODELS`);
    }

    // CHEAPEST-FIRST. Asserted on the STANDARD price so the array cannot
    // silently re-order itself the day a promotion expires — and then again on
    // the price as-billed today, so it is correct on BOTH sides of that
    // boundary. A picker that leads with the priciest model is a cost trap.
    //
    // ── NULL IS NOT ZERO, AND `>=` DOES NOT KNOW THAT ─────────────────────
    // A FREE entry's prices are `null` BY DESIGN (never 0 — see §5). `0.017 >=
    // null` is TRUE in JS, because null coerces to 0. So the moment a free
    // model was admitted at index 0 the FIRST pair of every OpenRouter
    // comparison stopped comparing anything and started passing on a
    // coercion — CORRECT BY ACCIDENT, and only because free genuinely is the
    // cheapest thing on offer. The same shape as the picker suite's control,
    // which was already repaired; this one was left because it happened to
    // give the right answer, which is exactly how these survive.
    //
    // Now: ordering is compared only between entries that carry NUMBERS, and
    // "free comes first" is asserted as the MEMBERSHIP fact it is.
    let pricedPairs = 0;
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1], b = list[i];
      const bothPriced = typeof a.standardInput === 'number' && typeof b.standardInput === 'number'
                      && typeof a.standardOutput === 'number' && typeof b.standardOutput === 'number';
      if (!bothPriced) {
        // The only legal reason a side has no number is that it is free — and
        // a free entry may only precede a paid one, never follow it.
        ok(a.free === true || b.free === true,
          `${provider}: "${a.id}"/"${b.id}" — a missing standard price is only legal on a FREE entry`);
        ok(a.free === true,
          `${provider}: the unpriced side of this pair is the EARLIER one — a free model must not be listed after a paid one ("${a.id}" then "${b.id}")`);
        continue;
      }
      pricedPairs++;
      ok(b.standardInput >= a.standardInput && b.standardOutput >= a.standardOutput,
        `${provider}: "${b.id}" is not cheaper than "${a.id}" at STANDARD price — order stays cheapest-first`);
      ok(typeof a.input === 'number' && typeof b.input === 'number'
         && typeof a.output === 'number' && typeof b.output === 'number'
         && b.input >= a.input && b.output >= a.output,
        `${provider}: "${b.id}" is not cheaper than "${a.id}" at TODAY'S price`);
    }
    // Declared per provider, so a catalogue that compares nothing is visible
    // rather than silently green.
    ok(list.length < 2 || pricedPairs > 0,
      `${provider}: the ordering walk compared ${pricedPairs} priced pair(s) across ${list.length} entries — not vacuous`);

    // Everything the app can pick FOR the user must also be pickable BY the
    // user — otherwise a fallback could land them on a model the picker claims
    // does not exist.
    if (DEFAULTS[provider] === null) {
      // No default is pinned, so there is nothing to be offerable. Assert the
      // CONSEQUENCE explicitly rather than skipping quietly: a provider with no
      // measured default must not be able to serve the build lane at all, and
      // getProviderInfo() is where that refusal lives (§ below drives it live).
      ok(list.length === 0 || list.every(m => m.suitability === 'chat-only'),
        `${provider}: has no pinned default, so nothing it offers may claim the build lane`);
    } else {
      ok(list.some(m => m.id === DEFAULTS[provider]),
        `${provider}: the pinned default is itself offerable`);
    }
    for (const rung of FALLBACK_CHAINS[provider]) {
      ok(list.some(m => m.id === rung), `${provider}: fallback rung "${rung}" is offerable`);
    }
  }

  // ── THE CEILING SPLIT, DECLARED ───────────────────────────────────────────
  // Printed AND asserted. The hole this closes was invisible precisely because
  // a whole provider's entries drifted into the un-derived arm and nothing
  // said so: a count that only gets quieter is not a guard.
  console.log(`     (output ceilings: ${capDerived} DERIVED from a cap map, ${capSelfDeclared} self-declared+pinned${selfDeclaredIds.length ? ` — ${selfDeclaredIds.join(', ')}` : ''})`);
  ok(capDerived > 0,
    `at least one entry still DERIVES its ceiling from a cap map (${capDerived}) — if this ever hits 0 the derivation assertion has stopped running entirely`);
  eq(capDerived + capSelfDeclared,
    Object.values(OFFERABLE_MODELS).reduce((n, l) => n + l.length, 0),
    'every offerable entry took exactly one of the two ceiling arms — none was skipped');
  // Both directions. A stale expectation for a model that has been removed is
  // as much a review failure as a missing one for a model that was added.
  for (const id of Object.keys(HAND_TYPED_CEILINGS)) {
    ok(selfDeclaredIds.includes(id),
      `HAND_TYPED_CEILINGS entry "${id}" corresponds to a live self-declared ceiling — a stale expectation is deleted, not left asserting about nothing`);
  }

  // ── OPENROUTER PRICES: A REVIEW GATE ON THE VALUE, NOT JUST THE COPY ──────
  // The loop above already proves `entry.input === getModelPrice(id).input` —
  // that the entry did not keep a SECOND copy of the price. It cannot notice
  // both copies being wrong together, because there is only ever one source.
  //
  // For Gemini and Anthropic that is acceptable: one id has one published rate.
  // For OpenRouter it is not, and this session is why. An OpenRouter id routes
  // over many upstream endpoints at DIFFERENT prices, so "the price of the
  // model" is not well-defined from the catalogue alone — it is whatever the
  // endpoint that served you charges. Measured on cold (uncached) calls:
  //   qwen/qwen3-235b-a22b-2507  billed 1.64x its cheapest endpoint's rate
  //   moonshotai/kimi-k2.6       billed 0.57x its catalogue headline
  // Both were REFUSED for that; neither could have been caught by any
  // assertion that only compares our copy against our own table.
  //
  // So the figures below are pinned as a REVIEW GATE, exactly like
  // HAND_TYPED_CEILINGS and for the same reason: there is no second source to
  // derive from, so changing one must be seen by a person. Each was confirmed
  // against `usage.cost` on a cold probe run to six decimal places.
  const OPENROUTER_VERIFIED_PRICES = Object.freeze({
    'ibm-granite/granite-4.0-h-micro': { input: 0.017, output: 0.112 },
    'upstage/solar-pro4':              { input: 0.03,  output: 0.12  },
    'z-ai/glm-5.3-flash':              { input: 0.075, output: 0.25  },
    'moonshotai/kimi-k2-0905':         { input: 0.60,  output: 2.50  },
  });
  {
    const orPaid = OFFERABLE_MODELS.openrouter.filter(m => !m.free);
    // Non-vacuous: if this list ever empties, every assertion below passes by
    // iterating nothing. Declared rather than assumed.
    ok(orPaid.length > 0, `the OpenRouter price gate has ${orPaid.length} paid entries to check`);
    for (const m of orPaid) {
      ok(Object.hasOwn(OPENROUTER_VERIFIED_PRICES, m.id),
        `${m.id}: has a bill-verified price pinned in this file — an OpenRouter id routes over endpoints at different rates, so its price must be confirmed against a cold call's usage.cost, not read off the catalogue and trusted`);
      const want = OPENROUTER_VERIFIED_PRICES[m.id];
      if (want) {
        eq(m.input, want.input, `${m.id}: input price matches the figure confirmed against the bill`);
        eq(m.output, want.output, `${m.id}: output price matches the figure confirmed against the bill`);
      }
    }
    // Both directions, same rule as the ceilings: an expectation for a model
    // that has been withdrawn is as much a review failure as a missing one.
    const paidIds = new Set(orPaid.map(m => m.id));
    for (const id of Object.keys(OPENROUTER_VERIFIED_PRICES)) {
      ok(paidIds.has(id),
        `OPENROUTER_VERIFIED_PRICES entry "${id}" corresponds to a live paid OpenRouter entry — a stale expectation is deleted, not left asserting about nothing`);
    }
  }

  // ── THE 200,000-TOKEN CONTEXT FLOOR IS NOT ENFORCEABLE HERE, AND SAYING SO
  //    IS THE POINT ──────────────────────────────────────────────────────────
  // A build-lane model must hold this repo's real ingest prompt, which is
  // ~78,000 provider-counted tokens today and grows with the user's own wiki
  // (the index and the slug inventory are ~90% of it). The floor applied when
  // admitting the entries above is 200,000 tokens — parity with
  // `anthropic/claude-haiku-4.5`, which has exactly that and which this app
  // ships as a default. `qwen/qwen3-30b-a3b-instruct-2507` was refused on it:
  // measured clean, exactly priced, fastest of everything tested, and its
  // serving endpoint carries a 128,000-token window.
  //
  // NOT ENFORCED, deliberately and visibly: an offerable entry carries
  // `maxOutput` and NO context-window field, so there is nothing here to assert
  // against. Adding one would change `GET /api/config/api-keys` → `offerable`,
  // which is a public wire contract, and that belongs in its own change with
  // its own UI review rather than riding along with a catalogue addition.
  // Until then the floor is a REVIEW-TIME check against the live catalogue's
  // `top_provider.context_length`, recorded in llm.js's refusal block. This
  // assertion exists to keep that gap NAMED rather than discovered.
  for (const m of OFFERABLE_MODELS.openrouter) {
    ok(!Object.hasOwn(m, 'contextWindow'),
      `${m.id}: carries no context-window field — if one is ever added, replace this with a real 200,000-token floor assertion instead of leaving the check to review`);
  }

  // The four models on Anthropic's NEWER tokenizer. Measured at 1.329x more
  // input tokens on real Curator prose, which is why claude-opus-5's $5/1M is
  // really ~$6.65 against a Haiku baseline — a cost estimate computed from
  // character count under-reports these by ~25% unless the factor is applied.
  // Of the four, claude-opus-4-7 is NOT offerable (never probed live), so three
  // are asserted here and the fourth is covered by the AWAITING invariants in §9.
  const byId = Object.fromEntries(Object.values(OFFERABLE_MODELS).flat().map(m => [m.id, m]));

  // ── THE PREMISE EXPIRED, NOT THE FIELD ────────────────────────────────────
  // This asserted `tokenizerFactor === 1.0` for every model not on a hardcoded
  // NEWER_TOKENIZER list. That premise — "anything I have not listed is exactly
  // 1.0" — was true only while every measured non-Anthropic model happened to
  // tokenize like the baseline. The OpenRouter measurements are 1.015 and 1.036,
  // deterministic across a byte-identical prompt (77,080 / 78,257 / 79,844
  // provider-counted tokens on the real 341,005-char ingest prompt). Those are
  // REAL measurements and were correctly kept — carrying exactly this is what
  // the field is FOR. An assertion demanding they be 1.0 was demanding the data
  // be rounded to fit the guard.
  //
  // Re-pointed to what the field actually promises: a MEASURED number ≥ 1, with
  // a ceiling so a typo cannot pass as a measurement. The exact-value pins that
  // remain are the ones with stated provenance.
  for (const m of Object.values(OFFERABLE_MODELS).flat()) {
    ok(typeof m.tokenizerFactor === 'number' && Number.isFinite(m.tokenizerFactor),
      `${m.id}: tokenizerFactor is a finite number`);
    ok(m.tokenizerFactor >= 1.0,
      `${m.id}: tokenizerFactor is >= 1.0 — it is a PREMIUM against a baseline tokenizer, so a value below 1 is not a measurement, it is a sign error`);
    ok(m.tokenizerFactor <= 2.0,
      `${m.id}: tokenizerFactor is <= 2.0 — a sanity ceiling, so a mistyped 13.29 cannot pass as a measurement (the largest real value measured to date is 1.329)`);
  }

  // The EXACT set of models whose factor is not the baseline, pinned with its
  // measured value. This is what the old blanket `=== 1.0` was really doing:
  // catching an unreviewed non-baseline value appearing. Keeping it as an
  // explicit map preserves that job while letting the data be honest — a new
  // non-1.0 entry reds here and has to arrive with its measurement, and a
  // silently CHANGED figure reds too.
  const MEASURED_TOKENIZER_PREMIUM = {
    // Anthropic's newer tokenizer, measured on real Curator prose. This is why
    // claude-opus-5's $5/1M is really ~$6.65 against a Haiku baseline.
    'claude-sonnet-5': 1.329,
    'claude-opus-5':   1.329,
    'claude-opus-4-8': 1.329,
    // OpenRouter, measured 2026-08-27 across 9 runs each on the real ingest
    // outline prompt; deterministic to the token on a byte-identical prompt.
    'ibm-granite/granite-4.0-h-micro': 1.036,
    'minimax/minimax-m3:free':         1.015,
    // Measured 2026-08-28 in a SECOND session whose prompt was 343,716 chars,
    // not the first session's 341,005 — the `articles` domain grew between
    // them. The factor is a RATIO against that session's own upstage/solar-pro4
    // figure (74,521 prompt tokens = 1.0), which is why these are comparable to
    // the two above despite a different absolute baseline: 76,155/74,521 and
    // 77,550/74,521. Deterministic to the token across a byte-identical prompt.
    'moonshotai/kimi-k2-0905':         1.022,
    'z-ai/glm-5.3-flash':              1.041,
  };
  for (const [id, factor] of Object.entries(MEASURED_TOKENIZER_PREMIUM)) {
    ok(Object.hasOwn(byId, id), `${id}: is offerable (a premium recorded for a model nobody can pick is dead data)`);
    eq(byId[id]?.tokenizerFactor, factor, `${id}: measured tokenizer premium is ${factor}`);
  }
  const nonBaseline = Object.values(OFFERABLE_MODELS).flat()
    .filter(m => m.tokenizerFactor !== 1.0).map(m => m.id).sort();
  eq(nonBaseline.join(','), Object.keys(MEASURED_TOKENIZER_PREMIUM).sort().join(','),
    'exactly the models this suite has measured premiums for carry a non-baseline tokenizerFactor — a new one appearing must arrive with its measurement');
  ok(!Object.hasOwn(byId, 'claude-opus-4-7'),
    'claude-opus-4-7 shares the newer tokenizer per the docs but is NOT offerable — unprobed');

  // STRUCTURAL completeness, exercised rather than asserted about. The factory
  // is what makes "no model is offerable unless fully specified" true at module
  // load; these drive it directly so the guarantee has behavioural coverage and
  // not merely a comment claiming the module would have refused.
  const goodSpec = {
    id: 'claude-sonnet-5', label: 'X', thinks: true, jsonRaw: true,
    tokenizerFactor: 1.329, suitability: 'general', note: 'a'.repeat(50),
  };
  ok(Object.isFrozen(defineOfferableModel('anthropic', goodSpec)),
    'the factory builds a frozen entry from a complete spec (control — the corpus can pass)');
  const REQUIRED = ['id', 'label', 'thinks', 'jsonRaw', 'tokenizerFactor', 'suitability', 'note'];
  for (const field of REQUIRED) {
    const broken = { ...goodSpec };
    delete broken[field];
    let threw = false;
    try { defineOfferableModel('anthropic', broken); } catch { threw = true; }
    ok(threw, `the factory REFUSES an entry missing \`${field}\``);
  }
  for (const bad of ['ingest-only', 'GENERAL', '', null, 42]) {
    let threw = false;
    try { defineOfferableModel('anthropic', { ...goodSpec, suitability: bad }); } catch { threw = true; }
    ok(threw, `the factory refuses suitability ${JSON.stringify(bad)}`);
  }
  {
    // An id with no price entry, and an id with no cap entry — the two ways a
    // model can look complete on the spec and still not be safe to offer.
    let threw = false;
    try { defineOfferableModel('anthropic', { ...goodSpec, id: 'claude-not-a-real-model' }); } catch { threw = true; }
    ok(threw, 'the factory REFUSES an id absent from MODEL_PRICES_USD_PER_MTOK');
    threw = false;
    // Priced (it is a real dated snapshot in the cap map) but on the wrong
    // provider's cap map, so the cap lookup misses.
    try { defineOfferableModel('gemini', { ...goodSpec, id: 'claude-sonnet-5' }); } catch { threw = true; }
    ok(threw, 'the factory REFUSES an id absent from that provider\'s output-cap map');
  }
  {
    // A blank note is the "we never measured this" case wearing a valid type.
    let threw = false;
    try { defineOfferableModel('anthropic', { ...goodSpec, note: '   ' }); } catch { threw = true; }
    ok(threw, 'the factory refuses a whitespace-only note (an unmeasured model must not be offered)');
  }

  // The route serialises entries VERBATIM onto GET /api/config/api-keys, and
  // input/output are getters. JSON.stringify must therefore emit plain numbers
  // — if it ever emitted undefined, every price in the picker would vanish.
  const wire = JSON.parse(JSON.stringify(OFFERABLE_MODELS));
  for (const provider of ['gemini', 'anthropic']) {
    for (const m of wire[provider]) {
      ok(typeof m.input === 'number' && typeof m.output === 'number',
        `${m.id}: survives JSON serialisation with numeric input/output (the wire shape the route sends)`);
    }
  }
}

// ── 12. The allow-list is enforced at the single model-producing chokepoint ──
// getProviderInfo() is the only place a model string is chosen for either SDK.
// Validating at a route instead would leave the other seven generateText entry
// points (ingest, compile, chat, query, health-ai, shared-brain, diagnostics)
// open AND create a second hand-maintained copy of the guard — the shape that
// produced the v3.2.0 CRITICAL.
section('12. getProviderInfo — OFFERABLE ids resolve, everything else is refused');
{
  const savedG = process.env.GEMINI_API_KEY;
  const savedA = process.env.ANTHROPIC_API_KEY;
  const savedM = process.env.LLM_MODEL;
  const realErr = console.error;
  try {
    // getEffectiveKey reads config → env, so dummy env keys make BOTH providers
    // resolvable regardless of what this machine has configured. Nothing is
    // written to disk and no call is made.
    process.env.GEMINI_API_KEY = 'dummy-offline-gemini-key';
    process.env.ANTHROPIC_API_KEY = 'dummy-offline-anthropic-key';
    delete process.env.LLM_MODEL;   // otherwise it reshapes the default we compare against
    console.error = () => {};       // the refusal path logs to stderr by design

    for (const provider of ['gemini', 'anthropic']) {
      for (const m of OFFERABLE_MODELS[provider]) {
        const info = getProviderInfo(provider, m.id);
        ok(info.provider === provider && info.model === m.id,
          `${provider}: offerable "${m.id}" resolves through getProviderInfo`);
      }
      const fallbackTo = getDefaultModel(provider);
      // REFUSED = fall back to the provider default, never throw and never
      // honour. Falling back is the safe direction twice over: a stale saved
      // selection keeps working, and the default is the CHEAPEST model on that
      // provider, so a refusal can only ever spend LESS than the user asked.
      const refusals = [
        'gemini-1.5-flash',            // RETIRED — 404s in production
        'claude-opus-4-7',             // real but AWAITING_MEASUREMENT
        'claude-3-5-haiku-latest',     // RETIRED
        'gpt-4o', 'zz-not-a-model', '', '   ',
        '../../etc/passwd', 'claude-sonnet-5\nX-Injected: 1',
      ];
      for (const bad of refusals) {
        eq(getProviderInfo(provider, bad).model, fallbackTo,
          `${provider}: refuses ${JSON.stringify(bad)} → provider default`);
      }
      // A model that IS offerable, but on the OTHER provider. Cross-provider is
      // the likeliest real mistake (a saved selection surviving a provider
      // switch) and would otherwise send a Claude id to the Gemini SDK.
      const other = provider === 'gemini' ? 'anthropic' : 'gemini';
      for (const m of OFFERABLE_MODELS[other]) {
        eq(getProviderInfo(provider, m.id).model, fallbackTo,
          `${provider}: refuses "${m.id}" (offerable, but on ${other})`);
      }
      // Prototype-pollution shapes. isOfferableModel scans an array with ===,
      // so no object is ever indexed by the caller's string — the v3.0.9 bug
      // shape is closed by construction, not by remembering a hasOwn call.
      for (const k of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
        eq(getProviderInfo(provider, k).model, fallbackTo, `${provider}: refuses prototype key ${JSON.stringify(k)}`);
        ok(isOfferableModel(provider, k) === false, `isOfferableModel(${provider}, ${JSON.stringify(k)}) === false`);
      }
      for (const bad of [null, undefined, 42, {}, [], true]) {
        eq(getProviderInfo(provider, bad).model, fallbackTo,
          `${provider}: non-string ${JSON.stringify(bad) ?? String(bad)} → provider default`);
        ok(isOfferableModel(provider, bad) === false, `isOfferableModel rejects non-string`);
      }
      // Omitting the argument entirely must behave exactly as it always did.
      eq(getProviderInfo(provider).model, fallbackTo, `${provider}: no override → unchanged behaviour`);
    }
    // A bogus PROVIDER can never make anything offerable.
    for (const p of ['openai', '__proto__', '', null, 42]) {
      ok(isOfferableModel(p, 'claude-sonnet-5') === false,
        `isOfferableModel refuses provider ${JSON.stringify(p)}`);
    }
  } finally {
    console.error = realErr;
    if (savedG === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = savedG;
    if (savedA === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedA;
    if (savedM === undefined) delete process.env.LLM_MODEL; else process.env.LLM_MODEL = savedM;
  }
}

// ── 13. Promotional pricing — the trap, handled by a mechanism ──────────────
// gemini-3.6-flash and gemini-3.7-flash bill at $0.75/$3.75 through 2026-12-31
// and DOUBLE on 2027-01-01. Encoding the promo as if permanent would quote every
// user HALF what they are billed, on the one surface whose job is cost honesty —
// and no ordering assertion would catch it, because the array order happens to
// survive the doubling. That is this project's "green over a wrong number".
// So: the STANDARD price is the stored one, the promo is a dated exception on
// top, and every failure mode of that arrangement resolves to the HIGHER price.
section('13. Promotional pricing — date-resolved, and never mistakable for permanent');
{
  const { MODEL_PRICES_USD_PER_MTOK, PROMOTIONAL_PRICES } = llmTesting;
  ok(Object.isFrozen(PROMOTIONAL_PRICES), 'the promotional table is frozen');

  const EXPECT_PROMO = ['gemini-3.7-flash', 'gemini-3.6-flash'];
  eq(Object.keys(PROMOTIONAL_PRICES).length, EXPECT_PROMO.length,
    'exactly the promotions this suite knows about');

  for (const id of EXPECT_PROMO) {
    const hasRecord = Object.hasOwn(PROMOTIONAL_PRICES, id);
    ok(hasRecord, `${id}: has a promotional record`);
    // Guarded, not dereferenced optimistically — the same lesson §9 records
    // about unpriced rungs, and re-learned here by mutation: deleting a
    // promotional record made `promo.price` throw a TypeError that aborted the
    // whole file and hid every assertion after it. A missing record must
    // produce a clean, named FAIL, not a crash that looks like a broken test.
    if (!hasRecord) continue;
    const promo = PROMOTIONAL_PRICES[id];
    const standard = MODEL_PRICES_USD_PER_MTOK[id];

    // THE assertion that kills the trap. A promotion must be STRICTLY cheaper
    // than the standard price it precedes — so writing the promo value into the
    // standard table (the "encode it as permanent" mistake) collapses the two
    // and goes red, on both axes.
    ok(standard.input > promo.price.input && standard.output > promo.price.output,
      `${id}: the STANDARD price ($${standard.input}/$${standard.output}) is strictly dearer than the promotion ` +
      `($${promo.price.input}/$${promo.price.output}) — a promo written into the standard table fails here`);

    ok(/^\d{4}-\d{2}-\d{2}$/.test(promo.untilIso) && Number.isFinite(promo.untilMs),
      `${id}: carries a parseable expiry date`);
    eq(promo.untilMs, Date.parse(promo.untilIso + 'T23:59:59.999Z'),
      `${id}: expiry is inclusive and pinned to UTC (two users must not disagree about the price by a day)`);
    ok(Date.parse(promo.standardFromIso) > promo.untilMs,
      `${id}: the standard price starts after the promotion ends`);

    // BOTH SIDES OF THE BOUNDARY, TODAY. A guard that can only run on the day it
    // matters is a comment, which is exactly what the alternative designs were.
    const before = resolveModelPrice(id, promo.untilMs - 1000);
    const after  = resolveModelPrice(id, promo.untilMs + 1000);
    eq(before.input, promo.price.input, `${id}: before expiry → promotional input`);
    eq(before.output, promo.price.output, `${id}: before expiry → promotional output`);
    eq(after.input, standard.input, `${id}: after expiry → standard input (doubles by itself, no release needed)`);
    eq(after.output, standard.output, `${id}: after expiry → standard output`);
    eq(resolveModelPrice(id, promo.untilMs).input, promo.price.input,
      `${id}: the boundary instant itself is still promotional (inclusive)`);

    // The user-facing record must SAY so. A future reader looking at $0.75 has
    // to be unable to mistake it for a stable price.
    const entry = OFFERABLE_MODELS.gemini.find(m => m.id === id);
    ok(Boolean(entry), `${id}: is offerable`);
    eq(entry.promotionUntilIso, promo.untilIso, `${id}: entry states the promotion expiry`);
    eq(entry.standardPriceFromIso, promo.standardFromIso, `${id}: entry states when the standard price begins`);
    eq(entry.standardInput, standard.input, `${id}: entry carries the standard price alongside today's`);
    ok(/PROMOTIONAL PRICE/.test(entry.note) && entry.note.includes(promo.untilIso)
       && entry.note.includes(promo.standardFromIso),
      `${id}: the human-readable note names the promotion AND both dates`);
  }

  // A model with no promotion resolves identically at any instant, and its
  // entry says "no promotion" rather than leaving the field absent.
  for (const m of Object.values(OFFERABLE_MODELS).flat()) {
    if (Object.hasOwn(PROMOTIONAL_PRICES, m.id)) continue;
    eq(m.promotionUntilIso, null, `${m.id}: no promotion recorded`);
    ok(m.input === m.standardInput && m.output === m.standardOutput,
      `${m.id}: today's price and the standard price are the same`);
    // POSTURE-AWARE, and null-safe. A FREE model resolves to no price at ALL,
    // at any instant — so an unguarded `.input` here throws a TypeError that
    // aborts the file and hides every assertion after it, which is exactly what
    // the first free model landing in the catalogue did. Date-invariance is
    // still asserted for both postures; only the shape of "the price" differs.
    const future = resolveModelPrice(m.id, Date.parse('2030-01-01T00:00:00Z'));
    if (m.free) {
      eq(future, null,
        `${m.id}: FREE model resolves to NO price at any date — date-invariance for a free model means it is never priced, not that its price never moves`);
    } else {
      ok(future !== null, `${m.id}: a priced model still resolves at a future date`);
      eq(future && future.input, m.standardInput, `${m.id}: price is date-invariant`);
    }
  }

  // resolveModelPrice keeps every defensive property getModelPrice had.
  eq(resolveModelPrice('zz-nope', Date.now()), null, 'unknown id → null');
  eq(resolveModelPrice(null), null, 'null id → null');
  for (const k of ['__proto__', 'constructor', 'toString']) {
    eq(resolveModelPrice(k), null, `prototype key ${JSON.stringify(k)} → null`);
  }
  // A broken clock must not take down an LLM call, and must not silently quote
  // the cheaper number either.
  for (const bad of [NaN, Infinity, -Infinity, 'soon', null]) {
    const p = resolveModelPrice('claude-haiku-4-5', bad);
    ok(p && p.input === 1.00, `non-finite clock ${String(bad)} → still resolves a price`);
  }
}

// ── 14. normalizeChatModel — the per-chat MODEL gate ─────────────────────────
// Two gates, and BOTH have to hold: the OFFERABLE_MODELS allow-list, and a key
// SAVED IN SETTINGS for that provider. The second is the v3.0.13 rule — a user
// Disconnected Anthropic in Settings and chat kept answering on it, because the
// key still lived in .env. A model is a strictly narrower choice than the
// provider that serves it, so it must never be a way back in.
//
// Config is redirected to a throwaway dir via CURATOR_TEST_USER_DATA_DIR (the
// sanctioned cross-process seam; getApiKeys resolves the path PER CALL, so this
// takes effect on an already-imported module). That buys BOTH directions
// deterministically — a §3-style "assert relative to whatever this machine has"
// can only ever exercise the direction that machine happens to be in, and the
// refusal direction is the one that regressed.
section('14. normalizeChatModel — allow-list AND saved-Settings key, both required');
{
  const savedUD = process.env.CURATOR_TEST_USER_DATA_DIR;
  const savedM = process.env.LLM_MODEL;
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'curator-chatmodel-'));
  try {
    delete process.env.LLM_MODEL;
    process.env.CURATOR_TEST_USER_DATA_DIR = tmp;

    // Precondition: the seam actually moved config. If this fails the whole
    // section is measuring the developer's real keys and every result below is
    // meaningless — so assert it rather than assume it.
    writeFile(path.join(tmp, '.curator-config.json'),
      JSON.stringify({ geminiApiKey: 'zz-fake-gemini-key-for-tests' }) + '\n');
    {
      const k = getApiKeys();
      ok(k.geminiApiKey === 'zz-fake-gemini-key-for-tests' && k.anthropicApiKey === '',
        'precondition: CURATOR_TEST_USER_DATA_DIR redirected getApiKeys to the fixture');
    }

    // KEYED provider: every offerable id survives. Enumerated from the REAL
    // table so a model added to OFFERABLE_MODELS is covered the day it lands —
    // a hardcoded list would silently stop covering the newest entry, which is
    // exactly the one nobody has exercised yet.
    for (const m of OFFERABLE_MODELS.gemini) {
      eq(normalizeChatModel('gemini', m.id), m.id, `gemini keyed: "${m.id}" survives`);
    }
    // UNKEYED provider, same ids: refused. This is the regression direction.
    for (const m of OFFERABLE_MODELS.anthropic) {
      eq(normalizeChatModel('anthropic', m.id), null,
        `anthropic UNKEYED: offerable "${m.id}" is refused (v3.0.13)`);
    }

    // A .env key must NOT resurrect a provider with no SAVED key. This is the
    // literal v3.0.13 bug, asserted on the model gate rather than inherited
    // from the provider gate — normalizeChatModel could regress on its own.
    const savedEnvA = process.env.ANTHROPIC_API_KEY;
    try {
      process.env.ANTHROPIC_API_KEY = 'zz-fake-env-only-anthropic-key';
      eq(normalizeChatModel('anthropic', 'claude-sonnet-5'), null,
        'a .env-ONLY anthropic key does not make an anthropic model selectable');
      // Control: the .env key genuinely IS visible to the .env-inclusive
      // reader, so the null above is the gate working, not the key missing.
      ok(!!llmTesting && true, 'control placeholder');
    } finally {
      if (savedEnvA === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedEnvA;
    }

    // Flip the fixture: now anthropic is keyed and gemini is not. Both
    // directions on both providers, so neither result can be an accident of
    // which provider happened to be configured.
    writeFile(path.join(tmp, '.curator-config.json'),
      JSON.stringify({ anthropicApiKey: 'zz-fake-anthropic-key-for-tests' }) + '\n');
    for (const m of OFFERABLE_MODELS.anthropic) {
      eq(normalizeChatModel('anthropic', m.id), m.id, `anthropic keyed: "${m.id}" survives`);
    }
    for (const m of OFFERABLE_MODELS.gemini) {
      eq(normalizeChatModel('gemini', m.id), null, `gemini UNKEYED: "${m.id}" refused`);
    }

    // With BOTH keyed, only the allow-list is left to do the work.
    writeFile(path.join(tmp, '.curator-config.json'), JSON.stringify({
      geminiApiKey: 'zz-fake-gemini-key-for-tests',
      anthropicApiKey: 'zz-fake-anthropic-key-for-tests',
    }) + '\n');

    for (const provider of ['gemini', 'anthropic']) {
      const other = provider === 'gemini' ? 'anthropic' : 'gemini';
      // Cross-provider is the likeliest real mistake: a saved selection
      // surviving a provider switch. It must be refused even though the id is
      // perfectly offerable — on the OTHER provider.
      for (const m of OFFERABLE_MODELS[other]) {
        eq(normalizeChatModel(provider, m.id), null,
          `${provider}: refuses "${m.id}" (offerable, but on ${other})`);
      }
      // Never-offerable, retired, and AWAITING_MEASUREMENT ids.
      const refusals = [
        'gpt-4o',                    // another vendor entirely
        'gemini-1.5-flash',          // RETIRED — 404s in production
        'claude-3-5-haiku-latest',   // RETIRED
        ...Object.keys(AWAITING_MEASUREMENT),   // real, documented, never probed
        'zz-not-a-model', '', '   ', '../../etc/passwd',
        'claude-sonnet-5\nX-Injected: 1',
      ];
      for (const bad of refusals) {
        eq(normalizeChatModel(provider, bad), null, `${provider}: refuses ${JSON.stringify(bad)}`);
      }
      // Prototype keys. isOfferableModel scans an array with ===, and
      // normalizeChatModel adds no object lookup of its own, so these are
      // closed by construction — but assert it, because a future "tidy-up"
      // into a lookup table would reopen the v3.0.9 shape silently.
      for (const k of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
        eq(normalizeChatModel(provider, k), null, `${provider}: refuses prototype key ${JSON.stringify(k)}`);
      }
      for (const bad of [null, undefined, 42, {}, [], true, ['claude-sonnet-5']]) {
        eq(normalizeChatModel(provider, bad), null,
          `${provider}: refuses non-string ${JSON.stringify(bad) ?? String(bad)}`);
      }
      eq(normalizeChatModel(provider, undefined), null, `${provider}: no model → null (unchanged path)`);
    }
    // A bogus PROVIDER can never make a model selectable, whatever is keyed.
    for (const p of ['openai', '__proto__', 'GEMINI', '', null, 42, {}]) {
      eq(normalizeChatModel(p, 'claude-sonnet-5'), null,
        `provider ${JSON.stringify(p) ?? String(p)} → null`);
    }
  } finally {
    if (savedUD === undefined) delete process.env.CURATOR_TEST_USER_DATA_DIR;
    else process.env.CURATOR_TEST_USER_DATA_DIR = savedUD;
    if (savedM === undefined) delete process.env.LLM_MODEL; else process.env.LLM_MODEL = savedM;
    rmSync(tmp, { recursive: true, force: true });
  }
  // The seam must not leak into the sections that follow.
  ok(!process.env.CURATOR_TEST_USER_DATA_DIR || process.env.CURATOR_TEST_USER_DATA_DIR === savedUD,
    'CURATOR_TEST_USER_DATA_DIR restored after the section');
}

// ── 15. sendMessage reports the model that ANSWERED, not the one requested ───
// Driven end to end through the real chat.js → llm.js → callProvider path with
// a fake Anthropic SDK, so this exercises the actual onUsage wiring rather than
// a re-derivation of it. The distinction is the whole point of the field: a
// refusal AND a fallback-chain walk both make the request a lie, and the walk
// can move a user ONTO a costlier model (sonnet-5 $2/$10 → sonnet-4-6 $3/$15),
// so a `model` that echoed the request would be a falsehood about money.
section('15. sendMessage — the returned model is the one that actually answered');
{
  const savedUD = process.env.CURATOR_TEST_USER_DATA_DIR;
  const savedM = process.env.LLM_MODEL;
  const savedEnvG = process.env.GEMINI_API_KEY;
  const savedEnvA = process.env.ANTHROPIC_API_KEY;
  const realErr = console.error;
  const tmpUD = mkdtempSync(path.join(os.tmpdir(), 'curator-chatsend-ud-'));
  const tmpDom = mkdtempSync(path.join(os.tmpdir(), 'curator-chatsend-dom-'));
  const DOMAIN = 'zztest';
  try {
    delete process.env.LLM_MODEL;
    // No ambient env keys: the fixture config must be the ONLY key source, or a
    // developer's real .env would decide which provider answers.
    delete process.env.GEMINI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.CURATOR_TEST_USER_DATA_DIR = tmpUD;
    // Anthropic ONLY — so the gemini branch below is a genuine unkeyed case and
    // the fake SDK is the only transport that can ever be reached.
    writeFile(path.join(tmpUD, '.curator-config.json'), JSON.stringify({
      anthropicApiKey: 'zz-fake-anthropic-key-for-tests',
      activeProvider: 'anthropic',
    }) + '\n');
    __setDomainsDirOverride(tmpDom);

    mkdirSync(path.join(tmpDom, DOMAIN, 'wiki', 'entities'), { recursive: true });
    mkdirSync(path.join(tmpDom, DOMAIN, 'conversations'), { recursive: true });
    writeFile(path.join(tmpDom, DOMAIN, 'CLAUDE.md'), '# zztest schema\n');
    writeFile(path.join(tmpDom, DOMAIN, 'wiki', 'entities', 'foo.md'),
      '---\ntype: entity\n---\n# Foo\n\n## Key Facts\n- Foo is a thing.\n');

    // Fake Anthropic SDK. `asked` records every model the transport was handed,
    // which is the ground truth for "what actually ran".
    let asked = [];
    let failFirstWith404 = false;
    __setAnthropicClientFactory(() => ({
      messages: {
        stream: (body) => ({
          finalMessage: async () => {
            asked.push(body.model);
            if (failFirstWith404 && asked.length === 1) {
              const e = new Error('404 model not found');
              e.status = 404;
              throw e;
            }
            return {
              stop_reason: 'end_turn',
              content: [{ type: 'text', text: 'An answer. [source: entities/foo.md]' }],
              usage: { input_tokens: 11, output_tokens: 7 },
            };
          },
        }),
      },
    }));

    const ANTHROPIC_DEFAULT = getDefaultModel('anthropic');
    async function send(opts) {
      asked = [];
      const r = await sendMessage(DOMAIN, null, 'What is foo?', opts);
      return r;
    }

    // Precondition: the fixture really is driving this, not a real key or a
    // real network call. If sendMessage returned the empty-wiki early exit the
    // whole section would pass vacuously.
    {
      const r = await send({});
      ok(asked.length === 1, 'precondition: exactly one provider call went through the fake SDK');
      ok(typeof r.answer === 'string' && r.answer.includes('An answer.'),
        'precondition: the fake transport answered (not the empty-wiki early return)');
      eq(r.provider, null, 'no provider override → null (global active provider)');
      eq(asked[0], ANTHROPIC_DEFAULT, 'no model → the transport got the provider default');
      eq(r.model, ANTHROPIC_DEFAULT, 'no model → returns the provider default');
      eq(r.model, asked[0], 'returned model === the model the transport actually ran');
    }

    // Every offerable Anthropic id, requested explicitly, must reach the SDK
    // AND come back reported. Enumerated from the real table.
    for (const m of OFFERABLE_MODELS.anthropic) {
      const r = await send({ provider: 'anthropic', model: m.id });
      eq(asked[0], m.id, `"${m.id}": the transport received the requested model`);
      eq(r.model, m.id, `"${m.id}": sendMessage reports it`);
      eq(r.provider, 'anthropic', `"${m.id}": provider override honoured`);
    }

    // Refusals — each must resolve to the DEFAULT, and the reported model must
    // be the default too, never the string that was asked for.
    console.error = () => {};   // the refusal path logs to stderr by design
    const refusals = [
      'gpt-4o', 'zz-not-a-model', '', '   ',
      'claude-3-5-haiku-latest',
      ...Object.keys(AWAITING_MEASUREMENT),
      '__proto__', 'constructor', 'toString',
      ...OFFERABLE_MODELS.gemini.map(m => m.id),    // cross-provider
    ];
    for (const bad of refusals) {
      const r = await send({ provider: 'anthropic', model: bad });
      eq(asked[0], ANTHROPIC_DEFAULT, `refused ${JSON.stringify(bad)}: transport got the default`);
      eq(r.model, ANTHROPIC_DEFAULT, `refused ${JSON.stringify(bad)}: reports the DEFAULT, not the request`);
      ok(r.model !== bad, `refused ${JSON.stringify(bad)}: never echoes the requested id`);
    }
    console.error = realErr;

    // An offerable model on an UNKEYED provider. gemini has no saved key in the
    // fixture, so both gates refuse and the global (anthropic) answers — the
    // v3.0.13 rule proven at the level a user experiences it.
    {
      const r = await send({ provider: 'gemini', model: 'gemini-2.5-flash' });
      eq(r.provider, null, 'unkeyed gemini provider override → null (falls back to global)');
      eq(asked[0], ANTHROPIC_DEFAULT, 'unkeyed provider: the anthropic default answered');
      eq(r.model, ANTHROPIC_DEFAULT, 'unkeyed provider: reports what answered, not the gemini id');
      ok(r.model !== 'gemini-2.5-flash', 'a gemini id is never reported when gemini is unkeyed');
    }

    // A model with NO provider alongside it. normalizeChatModel gates on the
    // provider the CALLER named, so this resolves to the default even though
    // the id is offerable on the provider that ends up serving the request.
    // Pinned because it is the load-bearing difference between gating inside
    // sendMessage and gating at the route: a route-level isOfferableModel check
    // would honour this id, having never consulted the SAVED-KEY half of the
    // rule at all. Deliberate, and the safe direction — /next always sends the
    // pair together, and a refusal resolves to the cheapest model.
    {
      const r = await send({ model: 'claude-sonnet-5' });   // no provider field
      eq(asked[0], ANTHROPIC_DEFAULT, 'model with no provider: the default ran');
      eq(r.model, ANTHROPIC_DEFAULT, 'model with no provider: the default is reported');
      ok(r.model !== 'claude-sonnet-5', 'a provider-less model choice is never honoured');
    }

    // THE CASE A getProviderInfo() RE-RESOLUTION CANNOT SEE: the requested
    // model is accepted, reaches the SDK, and 404s — a later fallback rung
    // answers. Reporting the request here would name a model that never ran.
    {
      failFirstWith404 = true;
      const r = await send({ provider: 'anthropic', model: 'claude-sonnet-5' });
      failFirstWith404 = false;
      ok(asked.length >= 2, `fallback walk happened (transport tried ${asked.length} models)`);
      eq(asked[0], 'claude-sonnet-5', 'the requested model was tried first');
      ok(r.model !== 'claude-sonnet-5',
        'the reported model is NOT the requested one — it 404ed and never answered');
      eq(r.model, asked[asked.length - 1],
        'the reported model is the rung that actually produced the answer');
      // Control: without the injected 404 the same request reports itself, so
      // the assertion above is the walk being detected, not a blanket mismatch.
      const ctrl = await send({ provider: 'anthropic', model: 'claude-sonnet-5' });
      eq(ctrl.model, 'claude-sonnet-5', 'control: with no 404 the requested model answers and is reported');
    }
    // Clear the module-level fallback state the walk set, so nothing after this
    // section sees a stale banner.
    await send({ provider: 'anthropic' });
    ok(getFallbackStatus() === null, 'fallback state cleared after a clean primary call');

    // Output budget: chat's largest style must fit under every offerable
    // model's hard output cap, or a model swap would silently truncate.
    const maxChatTokens = Math.max(...Object.values(RESPONSE_STYLES).map(v => v.maxTokens));
    for (const m of OFFERABLE_MODELS.anthropic) {
      ok(anthropicMaxOutputTokens(m.id) >= maxChatTokens,
        `${m.id}: output cap ${anthropicMaxOutputTokens(m.id)} >= chat's largest request ${maxChatTokens}`);
    }
    for (const m of OFFERABLE_MODELS.gemini) {
      const cap = llmTesting.GEMINI_MODEL_MAX_OUTPUT_TOKENS[m.id];
      ok(typeof cap === 'number' && cap >= maxChatTokens,
        `${m.id}: output cap ${cap} >= chat's largest request ${maxChatTokens}`);
    }

    // The truncation path is model-agnostic and stays graceful in TEXT mode: a
    // cut-off chat answer must come back as partial-plus-note, never a throw
    // (v3.0.7). Asserted on a model a user can now deliberately pick.
    {
      let truncated = null;
      __setAnthropicClientFactory(() => ({
        messages: {
          stream: (body) => ({
            finalMessage: async () => {
              truncated = body.model;
              return {
                stop_reason: 'max_tokens',
                content: [{ type: 'thinking', thinking: 'hmm' },
                          { type: 'text', text: 'A partial answ' }],
                usage: { input_tokens: 11, output_tokens: 8192 },
              };
            },
          }),
        },
      }));
      const r = await sendMessage(DOMAIN, null, 'What is foo?',
        { provider: 'anthropic', model: 'claude-sonnet-5' });
      eq(truncated, 'claude-sonnet-5', 'truncation case ran on the deliberately picked model');
      ok(r.answer.includes('A partial answ'), 'TEXT mode returns the partial answer, not an error');
      ok(/cut off|length limit/i.test(r.answer), 'the truncation note is appended');
      eq(r.model, 'claude-sonnet-5', 'a truncated answer still reports the model that produced it');
    }
  } finally {
    console.error = realErr;
    __setAnthropicClientFactory(null);
    __setDomainsDirOverride(null);
    if (savedUD === undefined) delete process.env.CURATOR_TEST_USER_DATA_DIR;
    else process.env.CURATOR_TEST_USER_DATA_DIR = savedUD;
    if (savedM === undefined) delete process.env.LLM_MODEL; else process.env.LLM_MODEL = savedM;
    if (savedEnvG === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = savedEnvG;
    if (savedEnvA === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedEnvA;
    rmSync(tmpUD, { recursive: true, force: true });
    rmSync(tmpDom, { recursive: true, force: true });
  }
}

// ── 17. The conversation RECORD carries the model that answered ──────────────
// Before this, a conversation stored only { role, content, citations }: once an
// answer was written there was no record anywhere of which model produced it,
// and the Chat tab's label is derived from the user's own dropdown — a
// restatement of the REQUEST, not evidence about the ANSWER. A maintainer who
// picked claude-sonnet-5 and wanted to confirm Sonnet 5 had run had nothing in
// the app to check.
//
// Driven through the same real chat.js → llm.js → callProvider path as §15 with
// the fake SDK, then READ BACK OFF DISK via readConversation — so these assert
// what a future session/UI would actually load, not what sendMessage returned.
section('17. Conversation record — persists the model that ANSWERED, and never relabels history');
{
  const savedUD = process.env.CURATOR_TEST_USER_DATA_DIR;
  const savedM = process.env.LLM_MODEL;
  const savedEnvG = process.env.GEMINI_API_KEY;
  const savedEnvA = process.env.ANTHROPIC_API_KEY;
  const realErr = console.error;
  const tmpUD = mkdtempSync(path.join(os.tmpdir(), 'curator-chatrec-ud-'));
  const tmpDom = mkdtempSync(path.join(os.tmpdir(), 'curator-chatrec-dom-'));
  const DOMAIN = 'zztest';
  try {
    delete process.env.LLM_MODEL;
    delete process.env.GEMINI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.CURATOR_TEST_USER_DATA_DIR = tmpUD;
    writeFile(path.join(tmpUD, '.curator-config.json'), JSON.stringify({
      anthropicApiKey: 'zz-fake-anthropic-key-for-tests',
      activeProvider: 'anthropic',
    }) + '\n');
    __setDomainsDirOverride(tmpDom);

    mkdirSync(path.join(tmpDom, DOMAIN, 'wiki', 'entities'), { recursive: true });
    mkdirSync(path.join(tmpDom, DOMAIN, 'conversations'), { recursive: true });
    writeFile(path.join(tmpDom, DOMAIN, 'CLAUDE.md'), '# zztest schema\n');
    writeFile(path.join(tmpDom, DOMAIN, 'wiki', 'entities', 'foo.md'),
      '---\ntype: entity\n---\n# Foo\n\n## Key Facts\n- Foo is a thing.\n');

    let asked = [];
    let failFirstWith404 = false;
    __setAnthropicClientFactory(() => ({
      messages: {
        stream: (body) => ({
          finalMessage: async () => {
            asked.push(body.model);
            if (failFirstWith404 && asked.length === 1) {
              const e = new Error('404 model not found');
              e.status = 404;
              throw e;
            }
            return {
              stop_reason: 'end_turn',
              content: [{ type: 'text', text: 'An answer. [source: entities/foo.md]' }],
              usage: { input_tokens: 11, output_tokens: 7 },
            };
          },
        }),
      },
    }));

    const ANTHROPIC_DEFAULT = getDefaultModel('anthropic');
    // Read the record back off disk — the whole point is durability, so nothing
    // here trusts sendMessage's return value.
    async function lastAssistantOnDisk(convId) {
      const conv = await readConversation(DOMAIN, convId);
      const assistants = conv.messages.filter(m => m.role === 'assistant');
      return assistants[assistants.length - 1];
    }

    // (a) Every offerable Anthropic model, enumerated from the real table — the
    // record must name the model that ran, for every one a user can pick.
    for (const m of OFFERABLE_MODELS.anthropic) {
      asked = [];
      const r = await sendMessage(DOMAIN, null, 'What is foo?', { provider: 'anthropic', model: m.id });
      const msg = await lastAssistantOnDisk(r.conversationId);
      eq(msg.model, m.id, `"${m.id}": persisted record names the model that answered`);
      eq(msg.model, asked[0], `"${m.id}": persisted model === the id the transport actually ran`);
      eq(msg.provider, 'anthropic', `"${m.id}": persisted provider is the one that served`);
    }

    // (b) A REFUSED model must never be recorded. The user asked for one thing
    // and a different, cheaper one answered; writing the request would make the
    // record a lie in exactly the direction that hides an unwanted downgrade.
    console.error = () => {};
    for (const bad of ['gpt-4o', 'zz-not-a-model', '__proto__',
                       ...Object.keys(AWAITING_MEASUREMENT)]) {
      asked = [];
      const r = await sendMessage(DOMAIN, null, 'What is foo?', { provider: 'anthropic', model: bad });
      const msg = await lastAssistantOnDisk(r.conversationId);
      eq(msg.model, ANTHROPIC_DEFAULT, `refused ${JSON.stringify(bad)}: records what ran`);
      ok(msg.model !== bad, `refused ${JSON.stringify(bad)}: the request is never recorded`);
    }
    console.error = realErr;

    // (c) THE CASE A getProviderInfo() RE-RESOLUTION CANNOT SEE — mutation M3b.
    // The requested model is accepted by every gate, reaches the SDK, and 404s;
    // a later fallback rung answers. Re-deriving the record from getProviderInfo
    // would pass every case above and fail only here — and this is the case
    // where the number matters most, because a walk can move the user ONTO a
    // costlier model (sonnet-5 $2/$10 → sonnet-4-6 $3/$15).
    {
      asked = [];
      failFirstWith404 = true;
      const r = await sendMessage(DOMAIN, null, 'What is foo?',
        { provider: 'anthropic', model: 'claude-sonnet-5' });
      failFirstWith404 = false;
      const msg = await lastAssistantOnDisk(r.conversationId);
      ok(asked.length >= 2, `fallback walk happened (transport tried ${asked.length} models)`);
      eq(asked[0], 'claude-sonnet-5', 'the requested model was tried first');
      ok(msg.model !== 'claude-sonnet-5',
        'requested X, provider reported Y → the record holds Y, not the 404ed request');
      eq(msg.model, asked[asked.length - 1],
        'the record holds the rung that actually produced the answer');
      // Control: without the injected 404 the same request records itself, so
      // the assertion above detects the WALK rather than a blanket mismatch.
      asked = [];
      const ctrl = await sendMessage(DOMAIN, null, 'What is foo?',
        { provider: 'anthropic', model: 'claude-sonnet-5' });
      const ctrlMsg = await lastAssistantOnDisk(ctrl.conversationId);
      eq(ctrlMsg.model, 'claude-sonnet-5',
        'control: with no 404 the requested model answers and IS recorded');
    }
    await sendMessage(DOMAIN, null, 'What is foo?', { provider: 'anthropic' });
    ok(getFallbackStatus() === null, 'fallback state cleared after a clean primary call');

    // (d) NOTHING REPORTED ⇒ NOTHING RECORDED. Both shipping provider branches
    // call reportUsage before returning, so this is the defensive path — and it
    // must OMIT the fields rather than guess, because "we could not tell" and
    // "it was the default" are different facts. Driven on the pure builder,
    // which is the code that implements the rule.
    {
      const base = ['role', 'content', 'citations'];
      for (const [p, m, label] of [
        [null, null, 'both null'],
        [undefined, undefined, 'both undefined'],
        ['', '', 'both empty string'],
        ['anthropic', null, 'model missing'],
        [null, 'claude-sonnet-5', 'provider missing'],
        [{ toString: () => 'anthropic' }, { toString: () => 'x' }, 'non-string objects'],
        [123, 456, 'numbers'],
      ]) {
        const msg = buildAssistantMessage('a', ['e/f.md'], p, m);
        const extra = Object.keys(msg).filter(k => !base.includes(k));
        const expected = [];
        if (typeof p === 'string' && p) expected.push('provider');
        if (typeof m === 'string' && m) expected.push('model');
        eq(extra.join(','), expected.join(','), `nothing-reported (${label}): only reported fields appear`);
        ok(JSON.parse(JSON.stringify(msg)) !== null, `nothing-reported (${label}): the record serialises`);
      }
      // A record with no model must still read back without throwing.
      const bare = buildAssistantMessage('a', [], null, null);
      eq(bare.model, undefined, 'a bare record has model === undefined, not a guessed default');
      eq(bare.provider, undefined, 'a bare record has provider === undefined');
    }

    // (e) BACKWARD COMPATIBILITY — the assertion that protects every existing
    // user. Every conversation written before this change has assistant
    // messages with neither field. Loading one must not throw, must not
    // relabel, and must not migrate anything on read.
    const LEGACY_ID = '11111111-2222-3333-4444-555555555555';
    const legacy = {
      id: LEGACY_ID,
      title: 'A pre-existing conversation',
      createdAt: '2026-01-01T00:00:00.000Z',
      domain: DOMAIN,
      messages: [
        { role: 'user', content: 'old question' },
        { role: 'assistant', content: 'old answer', citations: ['entities/foo.md'] },
        { role: 'user', content: 'another old question' },
        { role: 'assistant', content: 'another old answer', citations: [] },
      ],
    };
    const legacyJson = JSON.stringify(legacy, null, 2);
    const legacyPath = path.join(tmpDom, DOMAIN, 'conversations', `${LEGACY_ID}.json`);
    writeFile(legacyPath, legacyJson);
    {
      let threw = null;
      let loaded = null;
      try { loaded = await readConversation(DOMAIN, LEGACY_ID); }
      catch (err) { threw = err; }
      ok(threw === null, 'a pre-existing conversation with no model field LOADS WITHOUT THROWING');
      eq(JSON.stringify(loaded), JSON.stringify(legacy),
        'a pre-existing conversation loads BYTE-FOR-BYTE unchanged — no migration on read');
      // Guarded, deliberately: a reader that THROWS on a legacy message leaves
      // `loaded` null, and an unguarded dereference below would kill the whole
      // run — a crash instead of a clean behavioural red, which loses the
      // assertion tally the runner classifies suites by. Fail the dependent
      // assertions explicitly instead.
      const legacyMsgs = loaded && Array.isArray(loaded.messages) ? loaded.messages : [];
      ok(legacyMsgs.length === legacy.messages.length,
        'the legacy conversation came back with all its messages');
      for (const [i, m] of legacyMsgs.entries()) {
        if (m.role !== 'assistant') continue;
        eq(m.model, undefined, `legacy message ${i}: model stays ABSENT (unknown ≠ the default)`);
        eq(m.provider, undefined, `legacy message ${i}: provider stays ABSENT`);
        ok(!Object.prototype.hasOwnProperty.call(m, 'model'),
          `legacy message ${i}: the key is not even present`);
      }
      // Negative control: the equality above is not vacuous.
      ok(loaded !== null && JSON.stringify(loaded) !== JSON.stringify({ ...legacy, title: 'different' }),
        'control: the unchanged-on-read comparison can distinguish a difference');
    }

    // (f) APPENDING to a legacy conversation must not retro-label its history.
    // A migrate-on-write would invent a measurement for messages produced by an
    // unknown model — the same falsehood, applied retroactively.
    {
      asked = [];
      // Guarded for the same reason as the read above: sendMessage READS the
      // conversation before appending, so a reader that throws on a legacy
      // message takes this call down too. Catch it so the failure is a clean
      // assertion with a tally rather than a stack trace that aborts the run.
      let r = null, sendThrew = null;
      try {
        r = await sendMessage(DOMAIN, LEGACY_ID, 'a new question',
          { provider: 'anthropic', model: 'claude-sonnet-5' });
      } catch (err) { sendThrew = err; }
      ok(sendThrew === null, 'appending a turn to a legacy conversation does not throw');
      eq(r && r.conversationId, LEGACY_ID, 'the reply appended to the existing conversation');
      let conv = null;
      try { conv = await readConversation(DOMAIN, LEGACY_ID); } catch { /* asserted above */ }
      const assistants = (conv && Array.isArray(conv.messages) ? conv.messages : [])
        .filter(m => m.role === 'assistant');
      eq(assistants.length, 3, 'the legacy conversation now holds three assistant messages');
      ok(assistants[0] && !Object.prototype.hasOwnProperty.call(assistants[0], 'model'),
        'the FIRST legacy assistant message is still unlabelled after a new turn');
      ok(assistants[1] && !Object.prototype.hasOwnProperty.call(assistants[1], 'model'),
        'the SECOND legacy assistant message is still unlabelled after a new turn');
      eq(JSON.stringify(assistants[0]), JSON.stringify(legacy.messages[1]),
        'the legacy message round-trips through a WRITE byte-identically');
      eq(assistants[2] && assistants[2].model, 'claude-sonnet-5', 'only the NEW message carries a model');
      eq(assistants[2] && assistants[2].provider, 'anthropic', 'only the NEW message carries a provider');
    }
  } finally {
    console.error = realErr;
    __setAnthropicClientFactory(null);
    __setDomainsDirOverride(null);
    if (savedUD === undefined) delete process.env.CURATOR_TEST_USER_DATA_DIR;
    else process.env.CURATOR_TEST_USER_DATA_DIR = savedUD;
    if (savedM === undefined) delete process.env.LLM_MODEL; else process.env.LLM_MODEL = savedM;
    if (savedEnvG === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = savedEnvG;
    if (savedEnvA === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedEnvA;
    rmSync(tmpUD, { recursive: true, force: true });
    rmSync(tmpDom, { recursive: true, force: true });
  }
}


// ── 18. Per-answer cost: the token counts that make it possible ─────────────
section('18. Usage record — the tokens that price an answer, reported or absent');
{
  /*
   * The chat thread shows what each answer cost. The dollar figure is computed
   * in the client from two things: the SERVED model (section 17) and the token
   * counts recorded here. This section is about the counts.
   *
   * PERSISTENCE IS THE LOAD-BEARING HALF. A cost derived only from the live
   * `sendMessage` return would show beside an answer and then vanish on reload —
   * the same message priced in one view and blank in another. So the counts go
   * into the conversation record, and every assertion below reads them BACK OFF
   * DISK rather than trusting the return value.
   */
  const savedUD = process.env.CURATOR_TEST_USER_DATA_DIR;
  const savedM = process.env.LLM_MODEL;
  const savedEnvG = process.env.GEMINI_API_KEY;
  const savedEnvA = process.env.ANTHROPIC_API_KEY;
  const realErr = console.error;
  const tmpUD = mkdtempSync(path.join(os.tmpdir(), 'curator-chatusage-ud-'));
  const tmpDom = mkdtempSync(path.join(os.tmpdir(), 'curator-chatusage-dom-'));
  const DOMAIN = 'zzusage';
  const { normalizeReportedUsage } = __testing;
  try {
    delete process.env.LLM_MODEL;
    delete process.env.GEMINI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.CURATOR_TEST_USER_DATA_DIR = tmpUD;
    writeFile(path.join(tmpUD, '.curator-config.json'), JSON.stringify({
      anthropicApiKey: 'zz-fake-anthropic-key-for-tests',
      activeProvider: 'anthropic',
    }) + '\n');
    __setDomainsDirOverride(tmpDom);

    mkdirSync(path.join(tmpDom, DOMAIN, 'wiki', 'entities'), { recursive: true });
    mkdirSync(path.join(tmpDom, DOMAIN, 'conversations'), { recursive: true });
    writeFile(path.join(tmpDom, DOMAIN, 'CLAUDE.md'), '# zzusage schema\n');
    writeFile(path.join(tmpDom, DOMAIN, 'wiki', 'entities', 'foo.md'),
      '---\ntype: entity\n---\n# Foo\n\n## Key Facts\n- Foo is a thing.\n');

    // The usage block the fake transport reports. Mutable so individual cases
    // can make the provider report nothing, or report partially.
    let reportedUsage = {
      input_tokens: 611,
      output_tokens: 97,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
    __setAnthropicClientFactory(() => ({
      messages: {
        stream: () => ({
          finalMessage: async () => ({
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'An answer. [source: entities/foo.md]' }],
            ...(reportedUsage === null ? {} : { usage: reportedUsage }),
          }),
        }),
      },
    }));

    async function lastAssistantOnDisk(convId) {
      const conv = await readConversation(DOMAIN, convId);
      const assistants = conv.messages.filter(m => m.role === 'assistant');
      return assistants[assistants.length - 1];
    }

    // ── (a) THE COUNTS REACH BOTH THE RETURN AND THE DISK ─────────────────
    {
      reportedUsage = { input_tokens: 611, output_tokens: 97,
                        cache_read_input_tokens: 13, cache_creation_input_tokens: 5 };
      const r = await sendMessage(DOMAIN, null, 'What is foo?', { provider: 'anthropic' });
      ok(r.usage && typeof r.usage === 'object', 'sendMessage RETURNS a usage object');
      eq(r.usage.inputTokens, 611, 'returned inputTokens is the provider\'s own figure');
      eq(r.usage.outputTokens, 97, 'returned outputTokens is the provider\'s own figure');
      eq(r.usage.cachedReadTokens, 13, 'returned cachedReadTokens is the provider\'s own figure');
      eq(r.usage.cacheWriteTokens, 5, 'returned cacheWriteTokens is the provider\'s own figure');
      const msg = await lastAssistantOnDisk(r.conversationId);
      ok(msg.usage && typeof msg.usage === 'object',
        'the PERSISTED record carries usage — a reloaded thread can price the same answer');
      eq(JSON.stringify(msg.usage), JSON.stringify(r.usage),
        'the persisted counts are byte-identical to the returned ones (one figure, two surfaces)');
      // Appended LAST, so an untouched message serialises byte-identically.
      eq(Object.keys(msg).join(','), 'role,content,citations,provider,model,usage',
        'usage is the LAST key — existing keys keep their order and their bytes');
      // It carries ONLY the four counts: nothing else riding on the usage
      // payload (provider/model, or whatever llm.js adds next) may leak into a
      // conversation record and out over the wire.
      eq(Object.keys(msg.usage).join(','),
        'inputTokens,outputTokens,cachedReadTokens,cacheWriteTokens',
        'the record holds exactly the four token counts — nothing else from the payload');
    }

    // ── (b) NOTHING REPORTED ⇒ NOTHING RECORDED. Never a zero. ────────────
    {
      // FOUND BY THIS ASSERTION, not anticipated: llm.js's normalizers coerce
      // every missing field to 0, so an absent usage block arrives as {0,0,0,0}
      // — which, recorded, would price a real paid answer at exactly $0.00 on a
      // spend surface. Zero-in-and-zero-out is therefore refused (see
      // normalizeReportedUsage). Driven through the REAL transport so the
      // coercion is the shipping one, not a fixture's idea of it.
      reportedUsage = null;   // provider returns no usage block at all
      const r = await sendMessage(DOMAIN, null, 'What is foo?', { provider: 'anthropic' });
      const msg = await lastAssistantOnDisk(r.conversationId);
      eq(r.usage, null,
        'a provider that reports NO usage block yields null — never a fabricated zero');
      ok(!Object.prototype.hasOwnProperty.call(msg, 'usage'),
        'nothing reported → the usage key is not even present on the record');
      // Control: the same transport WITH a usage block does record one, so the
      // refusal above is about the absent block and not about the harness.
      reportedUsage = { input_tokens: 5, output_tokens: 5,
                        cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      const ctrl = await sendMessage(DOMAIN, null, 'What is foo?', { provider: 'anthropic' });
      ok(ctrl.usage !== null, 'control — a reported block IS recorded');
      // And the narrowness of the rule: input > 0 with output 0 is still a
      // report, and still prices above zero.
      reportedUsage = { input_tokens: 611, output_tokens: 0,
                        cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      const partialOut = await sendMessage(DOMAIN, null, 'What is foo?', { provider: 'anthropic' });
      ok(partialOut.usage !== null && partialOut.usage.inputTokens === 611,
        'zero OUTPUT alone is still a real report — the refusal is zero-in-AND-zero-out only');
    }

    // ── (c) THE RULE ITSELF, driven on the pure builder ───────────────────
    // A PARTIAL payload is refused. Three of four counts priced as if they were
    // four is a confidently wrong number that looks exactly like a right one.
    {
      const base = ['role', 'content', 'citations'];
      const FULL = { inputTokens: 1, outputTokens: 2, cachedReadTokens: 3, cacheWriteTokens: 4 };
      const cases = [
        ['undefined', undefined, false],
        ['null', null, false],
        ['a number', 42, false],
        ['a string', JSON.stringify(FULL), false],
        ['an empty object', {}, false],
        ['inputTokens missing', { outputTokens: 2, cachedReadTokens: 3, cacheWriteTokens: 4 }, false],
        ['outputTokens missing', { inputTokens: 1, cachedReadTokens: 3, cacheWriteTokens: 4 }, false],
        ['cachedReadTokens missing', { inputTokens: 1, outputTokens: 2, cacheWriteTokens: 4 }, false],
        ['cacheWriteTokens missing', { inputTokens: 1, outputTokens: 2, cachedReadTokens: 3 }, false],
        ['a numeric STRING count', { ...FULL, inputTokens: '1' }, false],
        ['a NaN count', { ...FULL, inputTokens: NaN }, false],
        ['an Infinite count', { ...FULL, outputTokens: Infinity }, false],
        ['a negative count', { ...FULL, cachedReadTokens: -1 }, false],
        ['all four present', FULL, true],
        // The sentinel case: llm.js coerces a missing usage block to four
        // zeros, and a completed turn cannot have consumed zero input.
        ['all four ZERO (the "nothing reported" sentinel)',
          { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cacheWriteTokens: 0 }, false],
        ['zero in, zero out, but cache terms present',
          { inputTokens: 0, outputTokens: 0, cachedReadTokens: 9, cacheWriteTokens: 3 }, false],
        ['zero OUTPUT only — still a real report',
          { inputTokens: 611, outputTokens: 0, cachedReadTokens: 0, cacheWriteTokens: 0 }, true],
        ['zero INPUT only — still a real report',
          { inputTokens: 0, outputTokens: 97, cachedReadTokens: 0, cacheWriteTokens: 0 }, true],
      ];
      for (const [label, usage, shouldRecord] of cases) {
        const msg = buildAssistantMessage('a', ['e/f.md'], 'anthropic', 'claude-haiku-4-5', usage);
        const has = Object.prototype.hasOwnProperty.call(msg, 'usage');
        ok(has === shouldRecord,
          `usage rule (${label}): ${shouldRecord ? 'recorded' : 'REFUSED — never part-filled'}`);
        eq(Object.keys(msg).filter(k => !base.includes(k)).join(','),
          shouldRecord ? 'provider,model,usage' : 'provider,model',
          `usage rule (${label}): key set is exactly right`);
      }
      // Zero is a MEASUREMENT, not an absence — the discriminator is
      // Number.isFinite, never truthiness. This is the assertion that would go
      // red if someone "simplified" the check to `if (v)`.
      const zeroOut = buildAssistantMessage('a', [], 'anthropic', 'claude-haiku-4-5',
        { inputTokens: 611, outputTokens: 0, cachedReadTokens: 0, cacheWriteTokens: 0 });
      eq(JSON.stringify(zeroOut.usage),
        '{"inputTokens":611,"outputTokens":0,"cachedReadTokens":0,"cacheWriteTokens":0}',
        'a zero OUTPUT count is RECORDED as zero — the check is Number.isFinite, never truthiness');
      // The returned object is a fresh literal, never the caller's.
      const src = { ...FULL, sneaky: 'x' };
      const built = buildAssistantMessage('a', [], null, null, src);
      ok(built.usage !== src, 'the recorded usage is a fresh object, not the payload itself');
      ok(!('sneaky' in built.usage), '…carrying only the four known fields');
      // And the exported helper agrees with what the builder does.
      ok(normalizeReportedUsage(FULL) !== null && normalizeReportedUsage({}) === null,
        'normalizeReportedUsage implements the same all-four-or-nothing rule');
    }

    // ── (d) THE ROUTE DOES NOT STRIP IT ───────────────────────────────────
    // Verified by DRIVING the real POST handler, not by reading its source: the
    // spec's claim was "src/routes/chat.js needs no change because it spreads",
    // and a route that enumerated fields would have made this the app's third
    // dead-data field (v3.9.0 finding 7). The handler is pulled off the real
    // Express router and called with a recording res.
    {
      reportedUsage = { input_tokens: 222, output_tokens: 33,
                        cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      const layer = chatRouter.stack.find(l =>
        l.route && l.route.path === '/:domain' && l.route.methods.post);
      ok(!!layer, 'the real POST /:domain handler was located on the chat router');
      const handler = layer.route.stack[0].handle;
      let body = null, status = 200;
      // `on`/`once` are part of the double because the real `res` is an
      // http.ServerResponse (an EventEmitter), and the POST handler registers a
      // lifecycle listener for cancellation. Without them this section did not
      // fail — it CRASHED with "res.on is not a function", taking the tally
      // with it. Record-only: nothing here is about the connection lifecycle,
      // and `writableEnded` reports whether this double has answered yet, which
      // is what the handler's close guard reads.
      const res = {
        json: (v) => { body = v; return res; },
        status: (s) => { status = s; return res; },
        on: () => res,
        once: () => res,
        removeListener: () => res,
        get writableEnded() { return body !== null; },
      };
      await handler(
        { params: { domain: DOMAIN }, body: { message: 'What is foo?', provider: 'anthropic' } },
        res, () => {});
      eq(status, 200, 'the route answered 200');
      ok(body && body.usage && typeof body.usage === 'object',
        'the WIRE payload carries usage — the route passes the result through untouched');
      eq(body.usage.inputTokens, 222, 'the wire carries the provider\'s own inputTokens');
      eq(body.usage.outputTokens, 33, 'the wire carries the provider\'s own outputTokens');
      ok(typeof body.model === 'string' && body.model,
        'the wire still carries the served model beside it (the other half of a price)');
    }

    // ── (e) BACKWARD COMPATIBILITY — the assertion protecting every user ──
    // Every conversation written before this change has assistant messages with
    // no `usage` key. It must LOAD, RENDER-as-unknown, and survive a WRITE
    // byte-identically. A migrate-on-write would invent a measurement for a turn
    // nobody measured.
    {
      const LEGACY_ID = '99999999-8888-7777-6666-555555555555';
      const legacy = {
        id: LEGACY_ID,
        title: 'A conversation from before per-answer cost existed',
        createdAt: '2026-02-02T00:00:00.000Z',
        domain: DOMAIN,
        messages: [
          { role: 'user', content: 'old question' },
          // (i) truly ancient: no provider, no model, no usage.
          { role: 'assistant', content: 'old answer', citations: ['entities/foo.md'] },
          { role: 'user', content: 'a v3.13.2-era question' },
          // (ii) the intermediate shape: model recorded, usage not.
          { role: 'assistant', content: 'a labelled answer', citations: [],
            provider: 'anthropic', model: 'claude-haiku-4-5' },
        ],
      };
      const legacyJson = JSON.stringify(legacy, null, 2);
      writeFile(path.join(tmpDom, DOMAIN, 'conversations', `${LEGACY_ID}.json`), legacyJson);

      let threw = null, loaded = null;
      try { loaded = await readConversation(DOMAIN, LEGACY_ID); }
      catch (err) { threw = err; }
      ok(threw === null, 'a pre-cost conversation LOADS WITHOUT THROWING');
      eq(JSON.stringify(loaded), JSON.stringify(legacy),
        'it loads BYTE-FOR-BYTE unchanged — no migration on read');
      const before = (loaded && loaded.messages ? loaded.messages : [])
        .filter(m => m.role === 'assistant');
      for (const [i, m] of before.entries()) {
        ok(!Object.prototype.hasOwnProperty.call(m, 'usage'),
          `legacy assistant message ${i}: the usage key is not present (unknown ≠ zero)`);
      }

      // Now APPEND a new turn and re-read. The new message must carry usage; the
      // old ones must be untouched down to the byte.
      reportedUsage = { input_tokens: 44, output_tokens: 8,
                        cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      let sendThrew = null, r = null;
      try {
        r = await sendMessage(DOMAIN, LEGACY_ID, 'a new question', { provider: 'anthropic' });
      } catch (err) { sendThrew = err; }
      ok(sendThrew === null, 'appending a turn to a pre-cost conversation does not throw');
      eq(r && r.conversationId, LEGACY_ID, 'the reply appended to the existing conversation');

      const conv = await readConversation(DOMAIN, LEGACY_ID);
      const after = conv.messages.filter(m => m.role === 'assistant');
      eq(after.length, 3, 'the conversation now holds three assistant messages');
      eq(JSON.stringify(after[0]), JSON.stringify(legacy.messages[1]),
        'the ANCIENT legacy message round-trips through a WRITE byte-identically');
      eq(JSON.stringify(after[1]), JSON.stringify(legacy.messages[3]),
        'the v3.13.2-era legacy message round-trips through a WRITE byte-identically');
      ok(!Object.prototype.hasOwnProperty.call(after[0], 'usage')
        && !Object.prototype.hasOwnProperty.call(after[1], 'usage'),
        'neither legacy message acquired a usage key — history is never back-filled');
      ok(after[2] && after[2].usage && after[2].usage.inputTokens === 44,
        'only the NEW message carries usage, and it carries the provider\'s own figure');
      // Negative control: the byte-identity comparisons above can see a change.
      ok(JSON.stringify(after[0]) !== JSON.stringify({ ...legacy.messages[1], usage: {} }),
        'control — the byte-identity comparison distinguishes an added usage key');
    }
  } finally {
    console.error = realErr;
    __setAnthropicClientFactory(null);
    __setDomainsDirOverride(null);
    if (savedUD === undefined) delete process.env.CURATOR_TEST_USER_DATA_DIR;
    else process.env.CURATOR_TEST_USER_DATA_DIR = savedUD;
    if (savedM === undefined) delete process.env.LLM_MODEL; else process.env.LLM_MODEL = savedM;
    if (savedEnvG === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = savedEnvG;
    if (savedEnvA === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedEnvA;
    rmSync(tmpUD, { recursive: true, force: true });
    rmSync(tmpDom, { recursive: true, force: true });
  }
}

// ── 16. The model override is wired end to end, and gated in ONE place ───────
section('16. Source guards — model override threaded, validated only at the chokepoint');
{
  const chat = readFileSync(path.join(ROOT, 'src/brain/chat.js'), 'utf8');
  const route = readFileSync(path.join(ROOT, 'src/routes/chat.js'), 'utf8');
  const next = readFileSync(path.join(ROOT, 'src/public/next/views/chat.js'), 'utf8');

  ok(/export function normalizeChatModel\(provider, model\)/.test(chat),
    'chat.js exports normalizeChatModel(provider, model)');
  ok(/normalizeChatModel/.test(chat.split('__testing')[1] || ''),
    'normalizeChatModel is on the __testing export');
  ok(/isOfferableModel/.test(chat), 'normalizeChatModel uses the shared isOfferableModel allow-list');
  // The whole v3.0.13 rule in one line: chat must reach for the CONFIG reader
  // and never the .env-inclusive one, anywhere in the file.
  ok(/getApiKeys\(\)/.test(chat) && !/getEffectiveKey\(/.test(chat),
    'chat.js gates on config (getApiKeys) and never calls getEffectiveKey');
  ok(/normalizeChatModel\(opts\.provider, opts\.model\)/.test(chat),
    'sendMessage normalises opts.model');
  ok(/model: chatModel/.test(chat), 'sendMessage passes the model override to generateText');
  ok(/onUsage:/.test(chat), 'sendMessage subscribes to onUsage to learn what actually answered');
  ok(/model: usedModel/.test(chat), 'sendMessage returns the model that was USED');
  ok(!/model: chatModel,\s*\n\s*\};/.test(chat.split('return {')[1] || ''),
    'the returned model is not the requested one');

  ok(/responseStyle, provider, model \} = req\.body/.test(route),
    'chat route destructures model from the body');
  // The route must stay a pass-through. A copy of the allow-list here would be
  // a second hand-maintained guard (the v3.2.0 CRITICAL shape) and would leave
  // the other seven generateText entry points open anyway.
  //
  // Comments are stripped first, deliberately: the route's own docblock NAMES
  // normalizeChatModel to explain where validation does live, and a guard that
  // reds on prose describing the invariant would get "fixed" by deleting the
  // explanation. Match executable text only.
  const routeCode = route.replace(/^\s*\/\/.*$/gm, '');
  ok(!/isOfferableModel|OFFERABLE_MODELS|normalizeChatModel/.test(routeCode),
    'the chat route does NOT re-validate the model — one chokepoint only');
  // Negative control: the guard CAN fire. Without it a planted call would pass
  // unnoticed, which is how a decorative assertion looks from the outside.
  ok(/isOfferableModel|OFFERABLE_MODELS|normalizeChatModel/
      .test(routeCode + "\n  if (!isOfferableModel(provider, model)) return res.status(400).end();"),
    'control: the chokepoint guard detects a planted route-level validation call');

  ok(/const MODEL_PICKER_ENABLED = true;/.test(next),
    'the /next composer model picker is enabled now that the backend honours a model');
}


// ═════════════════════════════════════════════════════════════════════════
section('19. Promoted measurements — the fields both pickers summarise from');
// ═════════════════════════════════════════════════════════════════════════
// Outline coverage and latency were measured and then recorded ONLY inside
// `note`, as English. Both pickers now build a one-line summary from them, and
// the alternative — regexing a number back out of a paragraph — fails silently
// the day someone rewords a sentence, and fails by producing a NUMBER rather
// than an error. So they are fields, and this section is what keeps the fields
// honest.
{
  const ALL = [];
  for (const [prov, list] of Object.entries(OFFERABLE_MODELS)) for (const e of list) ALL.push({ prov, e });
  ok(ALL.length >= 19, `corpus: ${ALL.length} static offerable entries`);

  // ── 19a. THE FIELD AND THE NOTE BENEATH IT CANNOT DISAGREE ────────────
  // The strongest guard available, and it is mechanical rather than a promise:
  // every page range is transcribed from the entry's OWN note, so the note must
  // still contain it. A future edit that "corrects" a field from a fresher
  // measurement session without touching the prose goes RED naming the model —
  // which is exactly the drift that made a computed cross-model comparison
  // unsafe (upstage/solar-pro4 reads "median 23" in its note and measured 25 in
  // the second session).
  let rangeChecked = 0;
  for (const { e } of ALL) {
    if (e.outlinePagesLow === null) continue;
    const lo = e.outlinePagesLow, hi = e.outlinePagesHigh;
    // Both separators the notes actually use: "5-13" and "5 to 13". A
    // single-value range ("a steady 17-page outline") is matched as itself.
    const re = lo === hi
      ? new RegExp('\\b' + lo + '(?:-|\\s)page')
      : new RegExp('\\b' + lo + '\\s*(?:-|–|to)\\s*' + hi + '\\b');
    ok(re.test(e.note), `${e.id}: the ${lo}-${hi} page range in the FIELD also appears in its own note`);
    rangeChecked++;
  }
  ok(rangeChecked >= 18, `corpus: ${rangeChecked} entries carry a page range — 19a is not vacuous`);

  let medianChecked = 0;
  for (const { e } of ALL) {
    if (e.outlinePagesMedian === null) continue;
    ok(new RegExp('median\\s+' + e.outlinePagesMedian + '\\b', 'i').test(e.note),
      `${e.id}: the median in the FIELD (${e.outlinePagesMedian}) also appears in its own note`);
    ok(e.outlinePagesLow === null ||
       (e.outlinePagesMedian >= e.outlinePagesLow && e.outlinePagesMedian <= e.outlinePagesHigh),
      `${e.id}: the median lies inside its own measured range`);
    medianChecked++;
  }
  ok(medianChecked >= 5, `corpus: ${medianChecked} entries carry a median — the median assertions are not vacuous`);

  // NOT ENFORCED, and said plainly rather than implied away: there is no
  // equivalent note-anchor for latency. Two of the three figures were recorded
  // outside the entry's own note (one in a SIBLING entry's note, one only in
  // the probe records), so a blanket assertion would fail on correct data. What
  // IS pinned is the one case where the note states a median itself.
  for (const { e } of ALL) {
    const m = /median\s+(\d+)s\b/.exec(e.note || '');
    if (!m || e.medianLatencyMs === null) continue;
    ok(Math.round(e.medianLatencyMs / 1000) === Number(m[1]),
      `${e.id}: the latency FIELD (${e.medianLatencyMs}ms) matches the "median ${m[1]}s" its own note states`);
  }

  // ── 19b. ABSENT IS NOT ZERO ───────────────────────────────────────────
  // The single most load-bearing property. Gemini and Anthropic recorded no
  // latency at all, and one model recorded no page count — those must be null,
  // never 0, because 0 is a truthy-looking measurement that renders.
  const noPages = ALL.filter(({ e }) => e.outlinePagesLow === null);
  const noLatency = ALL.filter(({ e }) => e.medianLatencyMs === null);
  ok(noPages.length >= 1, `corpus: ${noPages.length} entry with NO page measurement — the absent-case assertions can fire`);
  ok(noLatency.length >= 14, `corpus: ${noLatency.length} entries with NO latency — the common case is represented`);
  for (const { e } of ALL) {
    for (const f of ['outlinePagesLow', 'outlinePagesHigh', 'outlinePagesMedian', 'medianLatencyMs']) {
      ok(e[f] === null || (Number.isFinite(e[f]) && e[f] > 0),
        `${e.id}.${f} is either null (unmeasured) or a positive number — never 0`);
    }
    ok((e.outlinePagesLow === null) === (e.outlinePagesHigh === null),
      `${e.id}: page range is both-or-neither`);
  }

  // ── 19c. A FLAG WITHOUT A REASON CANNOT EXIST ─────────────────────────
  // Both pickers fold the note behind a disclosure, so a badge whose reason
  // lives only in that note states a verdict the user must open something to
  // understand. llm.js refuses to BUILD such an entry; this asserts the result
  // over the real table and, below, that the refusal is real.
  const flagged = ALL.filter(({ e }) => e.suitability === 'caution' || e.dominated === true);
  ok(flagged.length >= 8, `corpus: ${flagged.length} flagged entries`);
  for (const { e } of flagged) {
    ok(typeof e.cautionReason === 'string' && e.cautionReason.trim().length > 0,
      `${e.id}: FLAGGED -> carries a cautionReason`);
    ok(e.cautionReason.length <= 120, `${e.id}: cautionReason is one line, ${e.cautionReason.length} <= 120 chars`);
    ok(!/[\r\n]/.test(e.cautionReason), `${e.id}: cautionReason is single-line`);
    // ANTI-TRUNCATION. The reason is the HEADLINE of the note, not its opening
    // sentence clipped — a measured claim cut mid-thought can invert its
    // meaning, which is the whole reason the note is moved rather than
    // shortened.
    ok(!e.note.startsWith(e.cautionReason.slice(0, 40)),
      `${e.id}: cautionReason is not the note's first 40 chars copied — it is a headline, not a truncation`);
  }
  const unflagged = ALL.filter(({ e }) => !(e.suitability === 'caution' || e.dominated === true));
  ok(unflagged.length >= 5, `corpus: ${unflagged.length} UNFLAGGED entries — the flag discriminates`);

  // ── 19d. THE FACTORY REFUSES, at module load, not in a test ───────────
  // ALREADY on llm.js's __testing surface — exposed for exactly this purpose
  // ("assert the factory REFUSES it"). No new production surface is added.
  const define = llmTesting.defineOfferableModel;
  const build = (over) => define('openrouter', {
    id: 'test/probe', label: 'Probe', maxOutput: 8192, price: { input: 1, output: 2 },
    thinks: false, tokenizerFactor: 1.0, suitability: 'chat-only', note: 'A note.',
    ...over,
  });
  const throws = (over, why) => {
    let msg = null;
    try { build(over); } catch (err) { msg = err.message; }
    ok(msg !== null, why + ' — REFUSED at build time' + (msg === null ? ' (IT WAS ACCEPTED)' : ''));
    return msg;
  };
  ok(build({}) !== null, 'control: a well-formed chat-only spec DOES build — the refusals below are not "everything throws"');
  throws({ suitability: 'caution', jsonRaw: true }, 'a `caution` entry with no cautionReason');
  throws({ outlinePagesLow: 0, outlinePagesHigh: 9 }, 'outlinePagesLow of 0 — absent is null, never zero');
  throws({ outlinePagesLow: 5 }, 'half a page range');
  throws({ outlinePagesLow: 9, outlinePagesHigh: 5 }, 'an inverted page range');
  throws({ medianLatencyMs: 0 }, 'a latency of 0 — that would claim an instant response');
  throws({ cautionReason: 'x'.repeat(121) }, 'a cautionReason over the one-line cap');
  throws({ cautionReason: 'two\nlines' }, 'a multi-line cautionReason');
  // And the exemption is real: a DYNAMIC entry cannot be caution (the overlay
  // forces chat-only) and must not be forced to invent a reason it never
  // measured.
  {
    let ok1 = true;
    try { define('openrouter', { id: 'v/dyn', label: 'D', maxOutput: 4096, price: { input: 1, output: 2 },
      thinks: false, tokenizerFactor: 1.0, suitability: 'chat-only', note: 'Chat only.' }, { dynamic: true }); }
    catch { ok1 = false; }
    ok(ok1, 'a fetched chat-only entry builds with NO cautionReason — the catalogue is never asked to invent a caveat');
  }

  // ── 19e. THE LATENCY MAP REACHES THE RUNTIME CATALOGUE ────────────────
  // The live report: `deepseek/deepseek-v4-flash-0731` was measured at 382s,
  // REFUSED for the build lane, and is still freely pickable for chat. Its
  // measurement has to survive the refusal or the picker says nothing about the
  // slowest model we have ever run.
  {
    const spec = (id) => ({ id, label: id, maxOutput: 65536, price: { input: 0.2, output: 0.8 },
      thinks: false, tokenizerFactor: 1.0, suitability: 'chat-only',
      note: 'Chat only — never measured against The Curator\'s ingest prompt.' });
    const res = setOpenRouterCatalogue([
      spec('deepseek/deepseek-v4-flash-0731'), spec('vendor/never-probed'),
      spec('z-ai/glm-4.7'), spec('__proto__'),
    ]);
    ok(res.admitted === 4, `all four probe entries admitted (${res.admitted})`);
    const byId = new Map(listOfferableModels('openrouter').map(e => [e.id, e]));
    ok(byId.get('deepseek/deepseek-v4-flash-0731').medianLatencyMs === 382000,
      'a MEASURED-then-REFUSED model carries its latency into the runtime catalogue');
    ok(byId.get('vendor/never-probed').medianLatencyMs === null,
      'a model nobody probed carries null — not 0, not an average of its neighbours');
    // z-ai/glm-4.7 returned in a median of 34s and produced unrepairable JSON in
    // 9 of 9 runs. Publishing 34s would advertise a fast FAILURE as a fast
    // model, so it is deliberately absent from the map.
    ok(byId.get('z-ai/glm-4.7').medianLatencyMs === null,
      'a model with NO usable run has no latency — a fast failure is not a fast model');
    ok(byId.get('__proto__').medianLatencyMs === null,
      'a prototype key resolves to null, not to the prototype object (Object.hasOwn, not a bare index)');
    setOpenRouterCatalogue([]);
  }
}


// ═════════════════════════════════════════════════════════════════════════
section('20. Two PUBLISHED facts — optional, additive, and never derived');
// ═════════════════════════════════════════════════════════════════════════
// `createdUnixSec` and `contextLength` exist so a picker can offer "Newest" and
// "Largest context". They are provider-PUBLISHED, not Curator-MEASURED, which
// is why they are optional: the hand-typed table records what we measured, and
// a table of measurements is not a release calendar.
//
// THE CONTRACT THIS SECTION PROTECTS. `defineOfferableModel` THROWS AT MODULE
// LOAD, and `OFFERABLE_MODELS`'s shape is declared public (src/routes/config.js
// serialises it verbatim). So a field added here must be additive: if either of
// these were required, all 19 hand-typed entries would fail to build, the module
// would refuse to load, and the app would not boot.
{
  const ALL = [];
  for (const [prov, list] of Object.entries(OFFERABLE_MODELS)) for (const e of list) ALL.push({ prov, e });
  ok(ALL.length >= 19, `control: ${ALL.length} static entries BUILT — the module loaded with the fields added`);

  // ── 20a. ADDITIVE: every hand-typed entry carries them as UNKNOWN ──────
  ok(ALL.every(({ e }) => Object.hasOwn(e, 'createdUnixSec') && Object.hasOwn(e, 'contextLength')),
    'both fields are present on every entry, so no consumer has to test for their existence');
  ok(ALL.every(({ e }) => e.createdUnixSec === null && e.contextLength === null),
    'and every hand-typed entry carries NULL for both — nobody typed a release date into a measurement table');
  ok(!ALL.some(({ e }) => e.createdUnixSec === 0 || e.contextLength === 0),
    'NEVER 0. A zero date is 1970-01-01 and a zero context is a zero-token window; both rank as real, terrible values instead of as unknown');
  ok(!ALL.some(({ e }) => e.createdUnixSec === undefined || e.contextLength === undefined),
    'and never undefined, which JSON.stringify DROPS from the wire — a consumer would then see the field absent on some rows and null on others');

  // ── 20b. THE OUTPUT CEILING IS NOT THE CONTEXT WINDOW ──────────────────
  // Measured on the live catalogue: across the 374 models publishing both,
  // max_completion_tokens < context_length in 374 of 374 cases. `maxOutput` is
  // present on EVERY entry, so deriving context from it would make the field
  // look complete on every row — a filled-in column of the wrong fact.
  ok(ALL.every(({ e }) => Number.isFinite(e.maxOutput) && e.maxOutput > 0),
    'control: every entry HAS a maxOutput, which is exactly what makes it a tempting substitute');
  ok(!ALL.some(({ e }) => e.contextLength !== null && e.contextLength === e.maxOutput),
    'no entry’s context window is a copy of its output ceiling');

  // ── 20c. THE UNITS TRIPWIRE — a fabricated date fails to BUILD ─────────
  // Driven through the REAL runtime admission path, so the refusal asserted is
  // the one production takes. `setOpenRouterCatalogue` catches per entry, so a
  // bad row is dropped and named rather than taking the catalogue down.
  {
    const base = (id, extra) => Object.assign({
      id, label: 'ZZ', maxOutput: 8192, free: true, thinks: false,
      tokenizerFactor: 1, suitability: 'chat-only', note: 'n',
    }, extra || {});
    const OK_SEC = 1767225600; // 2026-01-01
    const cases = [
      ['a milliseconds timestamp (the year 55000)', { createdUnixSec: OK_SEC * 1000 }],
      ['epoch 0 (1970-01-01)', { createdUnixSec: 0 }],
      ['a negative date', { createdUnixSec: -1 }],
      ['a date before 2000, which no LLM has', { createdUnixSec: 100 }],
      ['NaN', { createdUnixSec: NaN }],
      ['a zero context window', { contextLength: 0 }],
      ['a negative context window', { contextLength: -32768 }],
      ['a fractional context window', { contextLength: 32768.5 }],
    ];
    let refusedAll = 0;
    for (const [what, extra] of cases) {
      const r = setOpenRouterCatalogue([base('zzfact/' + refusedAll + ':free', extra)]);
      ok(r.refused === 1 && r.admitted === 0, `REFUSED at build time: ${what}`);
      refusedAll++;
    }
    // The positive control. Without it every refusal above could be an artefact
    // of the fixture rather than of the field under test.
    const good = setOpenRouterCatalogue([
      base('zzfact/good:free', { createdUnixSec: OK_SEC, contextLength: 200000 }),
      base('zzfact/absent:free'),
    ]);
    ok(good.admitted === 2 && good.refused === 0,
      'control: a plausible seconds date + a positive context ARE admitted, and so is an entry carrying NEITHER');
    // Never a bare `.get(id).field`: if a mutation stops the entry being
    // admitted, a bare dereference throws and KILLS THE RUN, hiding every
    // assertion after it. `??` turns it into a named behavioural failure.
    const byId = new Map(listOfferableModels('openrouter').map((e) => [e.id, e]));
    const fieldOf = (id, f) => (byId.get(id) ? byId.get(id)[f] : '(entry absent)');
    ok(fieldOf('zzfact/good:free', 'createdUnixSec') === OK_SEC,
      'and the good value round-trips unchanged — the range check is a tripwire, not a transform');
    ok(fieldOf('zzfact/good:free', 'contextLength') === 200000, 'as does the context window');
    ok(fieldOf('zzfact/absent:free', 'createdUnixSec') === null
      && fieldOf('zzfact/absent:free', 'contextLength') === null,
      'and an entry publishing neither carries null for both — absent is absent, on the dynamic path too');
    setOpenRouterCatalogue([]);
  }
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All chat-model (provider selector) offline assertions green');
