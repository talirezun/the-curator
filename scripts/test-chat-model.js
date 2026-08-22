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
         isCostlierModel, __testing as llmTesting } from '../src/brain/llm.js';
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
  // Verified 2026-08-22 against the providers' published pricing pages.
  const expected = {
    // Gemini: EVERY rung is costlier than the default — the exact case the old
    // family heuristic got wrong on the first two.
    'gemini-3.1-flash-lite':     'costlier',   // $0.25/$1.50 vs $0.10/$0.40
    'gemini-3.5-flash-lite':     'costlier',   // $0.30/$2.50
    'gemini-2.5-flash':          'costlier',   // $0.30/$2.50
    // Anthropic: Haiku 3.5 is genuinely CHEAPER than Haiku 4.5 — must not warn.
    'claude-3-5-haiku-latest':   'similar',    // $0.80/$4 vs $1/$5
    'claude-3-5-haiku-20241022': 'similar',
    'claude-sonnet-4-5':         'costlier',   // $3/$15
    'claude-3-7-sonnet-latest':  'costlier',
    'claude-3-5-sonnet-latest':  'costlier',
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

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All chat-model (provider selector) offline assertions green');
