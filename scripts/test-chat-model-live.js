/**
 * test-chat-model-live.js — LIVE suite for the per-chat model (provider) selector.
 *
 * Proves on REAL keys that:
 *   - getProviderInfo(override) resolves to the requested provider + its default
 *     model (this IS the routing callLLM uses),
 *   - a real generateText call routed to EACH provider via the override returns
 *     a valid answer (both key paths function through the new plumbing),
 *   - a garbage override falls back to the global active provider and still works.
 *
 * Needs BOTH keys (the selector only appears with both); self-skips otherwise.
 */

import dotenv from 'dotenv';
dotenv.config();

import { generateText, getProviderInfo, getDefaultModel } from '../src/brain/llm.js';
import { getEffectiveKey } from '../src/brain/config.js';

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

(async () => {
  const haveGemini = !!getEffectiveKey('gemini');
  const haveAnthropic = !!getEffectiveKey('anthropic');
  if (!haveGemini || !haveAnthropic) {
    console.log(`⏭  SKIP: need BOTH keys (gemini=${haveGemini}, anthropic=${haveAnthropic}).`);
    process.exit(0);
  }

  console.log('Routing resolution (real keys present):');
  const g = getProviderInfo('gemini');
  ok(g.provider === 'gemini' && g.model === getDefaultModel('gemini'),
    `getProviderInfo('gemini') → gemini · ${g.model}`);
  const a = getProviderInfo('anthropic');
  ok(a.provider === 'anthropic' && a.model === getDefaultModel('anthropic'),
    `getProviderInfo('anthropic') → anthropic · ${a.model}`);

  console.log('\nEnd-to-end — each override actually answers:');
  const ask = (provider) => generateText(
    'You are a connectivity test. Reply with exactly the word OK.',
    'Reply now.', 16, 'text', null, { provider });

  const rg = await ask('gemini');
  ok(typeof rg === 'string' && rg.trim().length > 0, 'override → gemini returns a non-empty answer');

  const ra = await ask('anthropic');
  ok(typeof ra === 'string' && ra.trim().length > 0, 'override → anthropic returns a non-empty answer');

  // v3.82.0: claude-haiku-5-5 is offered for chat. The per-call MODEL override
  // must reach it for real — and be SERVED by it, not silently demoted to the
  // provider default (the allow-list falls back without throwing, so a
  // non-empty answer alone would pass on Haiku 4.5).
  console.log('\nPer-call model — claude-haiku-5-5 (chat-only):');
  const served55 = [];
  const r55 = await generateText(
    'You are a connectivity test. Reply with exactly the word OK.', 'Reply now.', 1024, 'text', null,
    { provider: 'anthropic', model: 'claude-haiku-5-5', onUsage: (u) => served55.push(u && u.model) });
  ok(typeof r55 === 'string' && r55.trim().length > 0, 'model override → claude-haiku-5-5 returns a non-empty answer');
  ok(served55.length > 0 && served55.every(m => m === 'claude-haiku-5-5'),
    `the call was SERVED by claude-haiku-5-5, not a fallback (served: ${served55.join(', ') || 'none'})`);

  // Garbage override → falls back to the global active provider (still works).
  const rf = await ask('nonsense-provider');
  ok(typeof rf === 'string' && rf.trim().length > 0, 'garbage override falls back to the global provider and works');

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Passed: ${passed}   Failed: ${failed}`);
  if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
  console.log('✅ Live chat-model (provider override) assertions green');
})();
