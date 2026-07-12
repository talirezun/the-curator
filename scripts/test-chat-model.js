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

// ── 3. Key-gated honouring — a key-backed override IS honoured ──────────────
// Config-independent: we set BOTH keys in this process's env so both providers
// definitely have a usable key regardless of the machine's config/env state.
// (The "keyless provider → fall back to global" branch can't be forced
// deterministically here — gemini/anthropic may both be keyed — so it's covered
// by the invalid-input cases above + the live garbage-fallback assertion.)
section('3. normalizeChatProvider / getProviderInfo honour a key-backed override');
{
  const savedG = process.env.GEMINI_API_KEY;
  const savedA = process.env.ANTHROPIC_API_KEY;
  try {
    process.env.GEMINI_API_KEY = 'dummy-gemini-key';
    process.env.ANTHROPIC_API_KEY = 'dummy-anthropic-key';
    eq(normalizeChatProvider('gemini'), 'gemini', 'gemini honoured when key present');
    eq(normalizeChatProvider('anthropic'), 'anthropic', 'anthropic honoured when key present');
    eq(getProviderInfo('gemini').provider, 'gemini', 'getProviderInfo(gemini) → gemini');
    eq(getProviderInfo('gemini').model, 'gemini-2.5-flash-lite', 'gemini override resolves the provider default model');
    eq(getProviderInfo('anthropic').provider, 'anthropic', 'getProviderInfo(anthropic) → anthropic');
    eq(getProviderInfo('anthropic').model, 'claude-haiku-4-5', 'anthropic override resolves the provider default model');
  } finally {
    if (savedG === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = savedG;
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
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All chat-model (provider selector) offline assertions green');
