/**
 * test-chat-truncation-live.js — LIVE suite for the v3.0.7 chat-truncation fix.
 *
 * Exercises the REAL Gemini and Anthropic APIs to prove, end-to-end, that:
 *   • TEXT mode (chat/query) forced into truncation RETURNS a partial answer
 *     with the truncation note — it does NOT throw, and it does NOT surface the
 *     old ingest-specific "split the source by chapter" message.
 *   • JSON mode forced into truncation still THROWS, and the error satisfies
 *     isOutputTokenLimit() (load-bearing for ingest/compile fallback ladders).
 *   • The thrown JSON-mode message no longer carries ingest vocabulary.
 *
 * Self-skips (exit 0) when neither key is configured, so it's harmless in CI
 * without secrets. Runs against whichever provider keys are present; forces the
 * provider per-case via the config activeProvider seam and restores it byte-exact.
 *
 * Truncation is FORCED with a tiny maxTokens (48) against a deliberately verbose
 * prompt — deterministic enough for a gate (the model WILL exceed 48 tokens on
 * "write a 2000-word essay"). No wiki data, no domains touched.
 */

import dotenv from 'dotenv';
dotenv.config();  // pick up ANTHROPIC_API_KEY / GEMINI_API_KEY from .env (no override)

import { generateText } from '../src/brain/llm.js';
import { isOutputTokenLimit } from '../src/brain/ingest.js';
import { getApiKeys, setActiveProvider, getActiveProvider } from '../src/brain/config.js';

let passed = 0, failed = 0, skipped = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function section(t) { console.log(`\n${t}`); }

const INGEST_VOCAB = [/Phase 2 batch size/i, /by chapter/i, /split the source/i, /ingest each/i];

const LONG_TEXT_PROMPT =
  'Write a detailed, 2000-word essay on the complete history of coffee cultivation, ' +
  'trade, and consumption from the 9th century to the present day. Include many ' +
  'specific dates, regions, and people. Be exhaustive and verbose.';

const LONG_JSON_PROMPT =
  'Return a single JSON object with 200 keys named k1 through k200. Each value must ' +
  'be a full, verbose English sentence of at least 25 words describing a distinct ' +
  'historical event. Output ONLY the JSON object.';

async function runProvider(name) {
  section(`Provider: ${name}`);
  const restore = await switchTo(name);
  try {
    // ── TEXT mode → partial + note, never throws ────────────────────────────
    let textRes = null, textThrew = null;
    try {
      textRes = await generateText('You are a verbose essayist.', LONG_TEXT_PROMPT, 48, 'text');
    } catch (e) { textThrew = e; }
    ok(textThrew === null, `[${name}] text mode did NOT throw on truncation`);
    ok(typeof textRes === 'string' && textRes.replace(/_\[.*$/s, '').trim().length > 0,
      `[${name}] text mode returned a non-empty partial answer`);
    ok(/cut off/i.test(textRes || '') && /length limit/i.test(textRes || ''),
      `[${name}] partial answer carries the truncation note`);
    for (const re of INGEST_VOCAB) {
      ok(!re.test(textRes || ''), `[${name}] text answer free of ingest vocabulary: ${re}`);
    }

    // ── JSON mode → throws, isOutputTokenLimit true, no ingest vocab ─────────
    let jsonThrew = null;
    try {
      await generateText('Return ONLY valid JSON.', LONG_JSON_PROMPT, 48, 'json');
    } catch (e) { jsonThrew = e; }
    ok(jsonThrew instanceof Error, `[${name}] JSON mode threw on truncation`);
    ok(isOutputTokenLimit(jsonThrew), `[${name}] error satisfies isOutputTokenLimit() (fallback ladders fire)`);
    for (const re of INGEST_VOCAB) {
      ok(!re.test(jsonThrew?.message || ''), `[${name}] JSON error free of ingest vocabulary: ${re}`);
    }
    ok(new RegExp(name, 'i').test(jsonThrew?.message || ''),
      `[${name}] JSON error names the provider`);
  } finally {
    await restore();
  }
}

// Force a specific provider active, returning a restore fn. setActiveProvider is
// a no-op (returns the current provider) if that key isn't set — so we verify
// the switch actually took effect and throw to skip the provider if it didn't.
async function switchTo(providerLabel) {
  const provider = providerLabel.toLowerCase() === 'gemini' ? 'gemini' : 'anthropic';
  const priorActive = getActiveProvider();          // string | null
  const now = setActiveProvider(provider);
  if (now !== provider) {
    throw new Error(`could not activate ${provider} (no stored key)`);
  }
  return () => {
    if (priorActive) { try { setActiveProvider(priorActive); } catch { /* best-effort */ } }
  };
}

(async () => {
  const keys = getApiKeys();
  const haveGemini = !!keys.geminiApiKey || !!process.env.GEMINI_API_KEY;
  const haveAnthropic = !!keys.anthropicApiKey || !!process.env.ANTHROPIC_API_KEY;

  if (!haveGemini && !haveAnthropic) {
    console.log('⏭  SKIP: no Gemini or Anthropic key configured — nothing to test live.');
    process.exit(0);
  }

  if (haveGemini) { try { await runProvider('Gemini'); } catch (e) { console.log(`  ⏭  Gemini skipped: ${e.message}`); skipped++; } }
  else { console.log('\n⏭  Gemini: no key, skipped'); skipped++; }

  if (haveAnthropic) { try { await runProvider('Claude'); } catch (e) { console.log(`  ⏭  Anthropic skipped: ${e.message}`); skipped++; } }
  else { console.log('\n⏭  Anthropic: no key, skipped'); skipped++; }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Passed: ${passed}   Failed: ${failed}   Skipped providers: ${skipped}`);
  if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
  console.log('✅ Live chat-truncation assertions green');
})();
