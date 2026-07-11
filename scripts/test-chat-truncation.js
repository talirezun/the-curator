/**
 * test-chat-truncation.js — OFFLINE suite for the v3.0.7 chat-truncation fix.
 *
 * Bug reported from the field: a long Chat question hit Gemini's 4096-token
 * output cap and surfaced the INGEST-specific error message
 *   "…split the source into smaller parts (e.g. by chapter) and ingest each
 *    separately… the Phase 2 batch size in src/brain/ingest.js may need tuning."
 * — nonsensical for a chat question (no source, no ingest, no Phase 2).
 *
 * Two real defects, both fixed:
 *   1. The MAX_TOKENS guard in llm.js is a SHARED chokepoint (chat, query,
 *      health-AI, shared-brain, compile, ingest) but carried ingest-only advice.
 *   2. Text mode HARD-FAILED on truncation instead of returning the useful
 *      partial answer.
 *
 * This suite is deterministic + free (no network): it unit-tests the exported
 * `handleOutputTokenLimit` helper, verifies `isOutputTokenLimit` still matches
 * the new JSON-mode throw (load-bearing for ingest/compile fallbacks), and adds
 * source-level guards so the ingest vocabulary can't creep back into llm.js and
 * the chat/query caps can't silently regress to 4096.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { handleOutputTokenLimit } from '../src/brain/llm.js';
import { isOutputTokenLimit } from '../src/brain/ingest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function section(t) { console.log(`\n${t}`); }

const INGEST_VOCAB = [
  /Phase 2 batch size/i,
  /by chapter/i,
  /split the source/i,
  /ingest each/i,
  /src\/brain\/ingest\.js/i,
];

// ── 1. JSON mode → throws, keeps the isOutputTokenLimit phrase, drops ingest advice
section('1. handleOutputTokenLimit — JSON mode throws a context-neutral error');
{
  let thrown = null;
  try {
    handleOutputTokenLimit('Gemini', 4096, 'json', '{"partial": tru');
  } catch (e) { thrown = e; }
  ok(thrown instanceof Error, 'JSON mode throws');
  ok(/output token limit/i.test(thrown?.message || ''),
    'message still contains "output token limit" (isOutputTokenLimit depends on it)');
  ok(isOutputTokenLimit(thrown), 'isOutputTokenLimit(err) === true → ingest/compile ladders still fire');
  for (const re of INGEST_VOCAB) {
    ok(!re.test(thrown?.message || ''), `message does NOT contain ingest vocabulary: ${re}`);
  }
  ok(/Gemini/.test(thrown?.message || ''), 'names the provider (Gemini)');

  // Anthropic side names Claude
  let thrown2 = null;
  try { handleOutputTokenLimit('Claude', 64000, 'json', ''); } catch (e) { thrown2 = e; }
  ok(/Claude/.test(thrown2?.message || '') && /64000/.test(thrown2?.message || ''),
    'Claude JSON throw names provider + the (clamped) budget');
}

// ── 2. Text mode → returns partial + note, never throws
section('2. handleOutputTokenLimit — text mode returns partial answer + note');
{
  const partial = 'Here is my analysis of the three topic ideas. The first one, The Content Context,';
  let res, threw = false;
  try { res = handleOutputTokenLimit('Gemini', 8192, 'text', partial); }
  catch { threw = true; }
  ok(!threw, 'text mode does NOT throw');
  ok(typeof res === 'string' && res.startsWith(partial.trimEnd()),
    'returns the partial answer verbatim (leading content preserved)');
  ok(/cut off/i.test(res) && /length limit/i.test(res),
    'appends a clear human-readable truncation note');
  ok(/8192/.test(res), 'note mentions the actual token budget');
  for (const re of INGEST_VOCAB) {
    ok(!re.test(res), `text-mode note does NOT contain ingest vocabulary: ${re}`);
  }
  ok(!isOutputTokenLimit({ message: res }),
    'the returned text is NOT mistaken for an output-token-limit error (no "output token limit" phrase)');
}

// ── 3. Text mode edge cases — empty / non-string partial
section('3. handleOutputTokenLimit — text mode is defensive about the partial');
{
  const rEmpty = handleOutputTokenLimit('Claude', 4096, 'text', '');
  ok(typeof rEmpty === 'string' && rEmpty.trim().length > 0,
    'empty partial → still returns a non-empty note (user sees SOMETHING, not a crash)');

  const rNull = handleOutputTokenLimit('Claude', 4096, 'text', null);
  ok(typeof rNull === 'string' && /cut off/i.test(rNull),
    'null partial → coerced to "" and note still returned');

  const rUndef = handleOutputTokenLimit('Gemini', 4096, 'text', undefined);
  ok(typeof rUndef === 'string' && rUndef.length > 0,
    'undefined partial → note returned');
}

// ── 4. Source-level guards on llm.js — the shared guard stays clean
section('4. Source guard — llm.js MAX_TOKENS handling routes through the helper');
{
  const src = readFileSync(path.join(ROOT, 'src/brain/llm.js'), 'utf8');
  ok(/export function handleOutputTokenLimit/.test(src),
    'handleOutputTokenLimit is exported');
  ok(/responseFormat === 'json'/.test(src),
    'helper branches on responseFormat');
  // Both provider branches must delegate to the helper (no inline throw with ingest text)
  const geminiUses = /handleOutputTokenLimit\('Gemini'/.test(src);
  const claudeUses = /handleOutputTokenLimit\('Claude'/.test(src);
  ok(geminiUses, 'Gemini branch delegates to handleOutputTokenLimit');
  ok(claudeUses, 'Anthropic branch delegates to handleOutputTokenLimit');
  // The old ingest-specific ERROR TEXT must be GONE from llm.js (the doc-comment
  // describing what the helper no longer does may still mention the phrase, so
  // we target the removed active error sentences precisely).
  ok(!/may need tuning/.test(src),
    'llm.js no longer throws "…Phase 2 batch size…may need tuning"');
  ok(!/split the source into smaller parts/.test(src),
    'llm.js no longer says "split the source into smaller parts"');
}

// ── 5. Source-level guards on the callers — caps bumped to 8192
section('5. Source guard — chat.js + query.js request 8192 (not 4096)');
{
  const chatSrc = readFileSync(path.join(ROOT, 'src/brain/chat.js'), 'utf8');
  ok(/generateText\(schema, prompt, 8192\)/.test(chatSrc),
    'chat.js requests 8192 output tokens');
  ok(!/generateText\(schema, prompt, 4096\)/.test(chatSrc),
    'chat.js no longer requests 4096');

  const querySrc = readFileSync(path.join(ROOT, 'src/brain/query.js'), 'utf8');
  ok(/generateText\(schema, userPrompt, 8192\)/.test(querySrc),
    'query.js requests 8192 output tokens');
}

// ── Summary ───────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All chat-truncation offline assertions green');
