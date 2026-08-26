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
         isOfferableModel, resolveModelPrice,
         __testing as llmTesting } from '../src/brain/llm.js';
import { getApiKeys, getActiveProvider } from '../src/brain/config.js';
import { __testing } from '../src/brain/chat.js';

const { normalizeChatProvider } = __testing;
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
  ok(/normalizeChatProvider\(opts\.provider\)/.test(chat), 'sendMessage normalises opts.provider');
  ok(/\{ provider: chatProvider \}/.test(chat), 'sendMessage passes the provider override to generateText');
  ok(/provider: chatProvider,\s*\/\//.test(chat) || /provider: chatProvider,/.test(chat), 'sendMessage returns the resolved provider');

  const route = readFileSync(path.join(ROOT, 'src/routes/chat.js'), 'utf8');
  ok(/responseStyle, provider/.test(route), 'chat route reads provider from the body');
  ok(/\{ responseStyle, provider \}/.test(route), 'chat route passes provider to sendMessage');

  const cfg = readFileSync(path.join(ROOT, 'src/routes/config.js'), 'utf8');
  ok(/models:\s*\{/.test(cfg), 'api-keys route returns a models map');
  ok(/getDefaultModel\('gemini'\)/.test(cfg) && /getDefaultModel\('anthropic'\)/.test(cfg),
    'models map is derived from getDefaultModel (auto-updates on a global model bump)');
  ok(!/geminiUsable|anthropicUsable/.test(cfg),
    'api-keys route no longer exposes the misleading usable (config-or-env) flags');

  const app = readFileSync(path.join(ROOT, 'src/public/app.js'), 'utf8');
  ok(/if \(data\.hasGeminiKey\) providers\.push/.test(app) && /if \(data\.hasAnthropicKey\) providers\.push/.test(app),
    'chat model selector availability keys off config-based hasXKey (Settings)');
  ok(!/geminiUsable|anthropicUsable/.test(app),
    'chat model selector no longer relies on the usable (config-or-env) flags');
  ok(/renderFallbackBanner\(data\.fallback\);[\s\S]{0,500}initChatModelSelector\(\)/.test(app),
    'loadApiKeyStatus re-inits the chat model selector so a Settings key change reflects immediately');
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
  const shipped = [
    ...Object.values(DEFAULTS),
    ...Object.values(FALLBACK_CHAINS).flat(),
    ...Object.values(OFFERABLE_MODELS).flat().map(m => m.id),
  ];
  // Standing invariant: adding a fallback rung or an offerable model without its
  // price must FAIL here rather than silently downgrade that model's cost
  // warning to 'unknown' — or, worse now, render a blank price in the picker.
  const unpriced = shipped.filter(id => !getModelPrice(id));
  ok(unpriced.length === 0,
    `every DEFAULTS + FALLBACK_CHAINS + OFFERABLE id has a price${unpriced.length ? ` (missing: ${unpriced.join(', ')})` : ''}`);
  ok(Object.keys(MODEL_PRICES_USD_PER_MTOK).length === new Set(shipped).size,
    'price map has no entries beyond the ids we actually ship');
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

  const app = readFileSync(path.join(ROOT, 'src/public/app.js'), 'utf8');
  ok(/fallback\.costTier \|\| \(fallback\.costlier \? 'costlier' : 'similar'\)/.test(app),
    'banner drives off costTier, falling back to the legacy boolean');
  ok(/costTier === 'unknown'/.test(app),
    'banner has a distinct wording for the unknown-price state');
  ok(/settings-fallback-cost/.test(app), 'cost note is rendered in its own styled span');

  const html = readFileSync(path.join(ROOT, 'src/public/index.html'), 'utf8');
  ok(/__curatorBooted/.test(html), 'boot guard is inline in index.html (before app.js can throw)');
  ok(/\/app\\.js/.test(html) && !/\(app\|markdown\)/.test(html),
    'boot guard treats ONLY app.js as load-bearing (markdown.js has a designed fallback)');
  const appSrc = readFileSync(path.join(ROOT, 'src/public/app.js'), 'utf8');
  ok(/typeof window\.renderChatMarkdown === 'function'/.test(appSrc),
    'app.js still guards renderChatMarkdown — the reason markdown.js is not fatal');
  ok(/window\.__curatorBooted = true;\s*$/.test(appSrc.trimEnd() + '\n'),
    'the boot sentinel is the last statement in app.js');
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
  const { DEFAULTS, FALLBACK_CHAINS } = llmTesting;
  for (const provider of ['gemini', 'anthropic']) {
    const chain = FALLBACK_CHAINS[provider];
    ok(chain.length > 0, `${provider}: chain is non-empty (a default with no net is not a net)`);
    ok(new Set(chain).size === chain.length, `${provider}: no duplicate rungs`);
    ok(!chain.includes(DEFAULTS[provider]),
      `${provider}: the default is not repeated as its own fallback`);

    // Cheapest-first, comparing on the same basis compareModelCost uses. A tie
    // is fine (Sonnet 4.6 / 4.5); a strict decrease is not.
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
    for (const provider of ['gemini', 'anthropic']) {
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

  ok(Object.isFrozen(OFFERABLE_MODELS), 'the OFFERABLE_MODELS table is frozen');
  eq(Object.keys(OFFERABLE_MODELS).sort().join(','), 'anthropic,gemini',
    'exactly the two providers, no more');

  for (const provider of ['gemini', 'anthropic']) {
    const list = OFFERABLE_MODELS[provider];
    ok(Array.isArray(list) && Object.isFrozen(list), `${provider}: list is a frozen array`);
    ok(list.length > 0, `${provider}: at least one offerable model`);
    ok(new Set(list.map(m => m.id)).size === list.length, `${provider}: no duplicate ids`);

    const caps = provider === 'gemini' ? GEMINI_MODEL_MAX_OUTPUT_TOKENS : ANTHROPIC_MODEL_MAX_OUTPUT_TOKENS;

    for (const m of list) {
      ok(Object.isFrozen(m), `${m.id}: entry is frozen`);
      eq(m.provider, provider, `${m.id}: carries its provider`);
      ok(typeof m.label === 'string' && m.label.length > 0, `${m.id}: has a human label`);

      // COMPLETE — priced and capped. Not "has a number", but "agrees with the
      // single source of truth", because the entry DERIVES both rather than
      // re-typing them; two hand-maintained copies of a price is how a picker
      // starts quoting a number the biller disagrees with.
      const price = getModelPrice(m.id);
      ok(Boolean(price), `${m.id}: is priced in MODEL_PRICES_USD_PER_MTOK`);
      ok(Boolean(price) && m.input === price.input && m.output === price.output,
        `${m.id}: entry price is derived from the price table, not a second copy`);
      ok(typeof m.standardInput === 'number' && typeof m.standardOutput === 'number'
         && m.standardInput > 0 && m.standardOutput > 0,
        `${m.id}: carries a positive standard (post-promotional) price`);
      ok(Object.hasOwn(caps, m.id), `${m.id}: is capped in the provider output-cap map`);
      eq(m.maxOutput, caps[m.id], `${m.id}: maxOutput is derived from the cap map`);
      ok(Number.isInteger(m.maxOutput) && m.maxOutput > 0, `${m.id}: cap is a positive integer`);

      // MEASURED — the fields that only a live probe can supply.
      ok(typeof m.thinks === 'boolean', `${m.id}: measured \`thinks\` present`);
      ok(typeof m.jsonRaw === 'boolean', `${m.id}: measured \`jsonRaw\` present`);
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
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1], b = list[i];
      ok(b.standardInput >= a.standardInput && b.standardOutput >= a.standardOutput,
        `${provider}: "${b.id}" is not cheaper than "${a.id}" at STANDARD price — order stays cheapest-first`);
      ok(b.input >= a.input && b.output >= a.output,
        `${provider}: "${b.id}" is not cheaper than "${a.id}" at TODAY'S price`);
    }

    // Everything the app can pick FOR the user must also be pickable BY the
    // user — otherwise a fallback could land them on a model the picker claims
    // does not exist.
    ok(list.some(m => m.id === DEFAULTS[provider]),
      `${provider}: the pinned default is itself offerable`);
    for (const rung of FALLBACK_CHAINS[provider]) {
      ok(list.some(m => m.id === rung), `${provider}: fallback rung "${rung}" is offerable`);
    }
  }

  // The four models on Anthropic's NEWER tokenizer. Measured at 1.329x more
  // input tokens on real Curator prose, which is why claude-opus-5's $5/1M is
  // really ~$6.65 against a Haiku baseline — a cost estimate computed from
  // character count under-reports these by ~25% unless the factor is applied.
  // Of the four, claude-opus-4-7 is NOT offerable (never probed live), so three
  // are asserted here and the fourth is covered by the AWAITING invariants in §9.
  const NEWER_TOKENIZER = ['claude-sonnet-5', 'claude-opus-5', 'claude-opus-4-8'];
  const byId = Object.fromEntries(Object.values(OFFERABLE_MODELS).flat().map(m => [m.id, m]));
  for (const id of NEWER_TOKENIZER) {
    eq(byId[id]?.tokenizerFactor, 1.329, `${id}: newer-tokenizer factor is 1.329, not 1.0`);
  }
  for (const m of Object.values(OFFERABLE_MODELS).flat()) {
    if (!NEWER_TOKENIZER.includes(m.id)) {
      eq(m.tokenizerFactor, 1.0, `${m.id}: baseline tokenizer factor 1.0`);
    }
  }
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
    eq(resolveModelPrice(m.id, Date.parse('2030-01-01T00:00:00Z')).input, m.standardInput,
      `${m.id}: price is date-invariant`);
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

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All chat-model (provider selector) offline assertions green');
