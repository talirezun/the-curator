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
  ok(/export function getProviderInfo\(preferProvider = null\)/.test(llm), 'getProviderInfo takes a preferProvider override');
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
  const shipped = [
    ...Object.values(DEFAULTS),
    ...Object.values(FALLBACK_CHAINS).flat(),
  ];
  // Standing invariant: adding a fallback rung without its price must FAIL here
  // rather than silently downgrade that rung's cost warning to 'unknown'.
  const unpriced = shipped.filter(id => !getModelPrice(id));
  ok(unpriced.length === 0,
    `every DEFAULTS + FALLBACK_CHAINS id has a price${unpriced.length ? ` (missing: ${unpriced.join(', ')})` : ''}`);
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

  // Regression guard, distinct from RETIRED above: `gemini-3.5-flash-lite`
  // was removed 2026-08-26 not because it 404s (it doesn't — it's live) but
  // because it is STRICTLY DOMINATED by gemini-2.5-flash: identical price
  // ($0.30/$2.50 on both) while measurably less reliable (2 of 9 live probes
  // against the real ingest outline prompt produced JSON neither JSON.parse
  // nor jsonrepair could fix — a dropped object key, finishReason STOP, not
  // truncation) and no wider outline coverage than its neighbours. Re-adding
  // it as a rung with NO price would already fail the length/coverage
  // invariants above; this assertion additionally catches the case where
  // someone re-adds BOTH the rung and a price without re-reading why it was
  // pulled — nothing else in this file would object to that on its own.
  ok(!shippedIds.includes('gemini-3.5-flash-lite'),
    'gemini-3.5-flash-lite (dominated by gemini-2.5-flash — not re-added without re-measuring) is not shipped');
  eq(getModelPrice('gemini-3.5-flash-lite'), null,
    'gemini-3.5-flash-lite carries no dead-weight price entry');
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

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All chat-model (provider selector) offline assertions green');
