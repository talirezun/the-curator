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
import { getDefaultModel, getProviderInfo } from '../src/brain/llm.js';
import { getApiKeys } from '../src/brain/config.js';
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
section('1. getDefaultModel — current default model id per provider');
eq(getDefaultModel('gemini'), 'gemini-2.5-flash-lite', 'gemini default model');
eq(getDefaultModel('anthropic'), 'claude-haiku-4-5', 'anthropic default model');
eq(getDefaultModel('foo'), null, 'unknown provider → null');
eq(getDefaultModel(null), null, 'null → null');

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
  ok(/async function callLLM\([^)]*providerOverride = null\)/.test(llm), 'callLLM takes providerOverride');
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

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All chat-model (provider selector) offline assertions green');
