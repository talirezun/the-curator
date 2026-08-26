/**
 * test-anthropic-content-blocks.js — OFFLINE suite for Anthropic response-text
 * extraction. Deterministic, free, no network.
 *
 * WHAT BROKE (v3.9.1, P0). Both extraction sites in `callProvider` read
 * `message.content[0].text`. A `thinking` block carries `.thinking`, never
 * `.text`, so the moment a model put one first, `content[0].text` was
 * `undefined` and EVERY Anthropic call threw "Claude returned no text content".
 * The `stop_reason: 'max_tokens'` branch degraded the same way, handing
 * `handleOutputTokenLimit` an EMPTY partial — a cut-off but useful chat answer
 * arrived as nothing but the truncation note.
 *
 * WHY IT MATTERED MORE THAN "one model misbehaves". `claude-sonnet-5` is
 * FALLBACK_CHAINS.anthropic[0]. The chain's entire promise is to keep users
 * working the day the pinned default is retired — rung 1 was dead on arrival,
 * so the safety net failed at exactly the moment it is needed. Same shape as
 * v3.6.0, where 4 of 5 Anthropic rungs were 404.
 *
 * WHY IT WENT UNCAUGHT, AND WHAT THAT DEMANDS OF THIS FILE. The Curator never
 * sends a `thinking` parameter. On Sonnet 5 omitting it runs ADAPTIVE thinking
 * (the model decides per-prompt); on `claude-sonnet-4-6` and `claude-haiku-4-5`
 * omitting it means no thinking at all. So the failure is PROMPT-DEPENDENT: a
 * trivial `Return {"ok":true}` probe returns [text] and passes green, while a
 * real ingest-shaped prompt returns [thinking, text] and throws. Measured, 3
 * trials each: sonnet-5 [thinking,text] 3/3; sonnet-4-6 [text] 3/3;
 * haiku-4-5 [text] 3/3.
 *
 * A case list would re-create that blind spot — it can only ever contain the
 * shapes we already thought of, and the shipping bug was precisely a shape
 * nobody enumerated. §2 therefore asserts the CLASS INVARIANT over generated
 * content arrays: for ANY content array, the extracted text equals the
 * concatenation of its text-typed blocks, independent of position, count, and
 * whatever else is interleaved.
 *
 * §3 drives the REAL generateText → callLLM → callProvider path (retry loop and
 * fallback chain included) against synthetic finalMessage() shapes, through the
 * test-only `__setAnthropicClientFactory` seam. Nothing here touches the
 * network, spends money, or reads the developer's real config.
 *
 * THE ASSERTION THAT WOULD HAVE GONE RED ON THE SHIPPING CODE is labelled
 * inline with [RED-ON-SHIPPING] — there are several, and §3's
 * "[thinking, text] via the real generateText path" is the headline one.
 */

// Isolate credential resolution BEFORE anything reads it. getUserDataDir() and
// getEffectiveKey() both resolve per call, so setting this here is sufficient
// even though ES imports are hoisted above the module body.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

process.env.CURATOR_TEST_USER_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'curator-anthropic-blocks-'));
// A dummy key is enough: the client constructor is replaced by the seam, so the
// value is never sent anywhere. getEffectiveKey reads config → env, and the
// isolated (empty) user-data dir above guarantees only this env var is found.
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-a-real-key';
// LLM_MODEL would override the model id getProviderInfo resolves, making the
// model-dependent assertions depend on the developer's shell.
delete process.env.LLM_MODEL;

const { generateText, extractAnthropicText, __setAnthropicClientFactory,
        handleOutputTokenLimit, normalizeAnthropicUsage } =
  await import('../src/brain/llm.js');
const { isOutputTokenLimit } = await import('../src/brain/ingest.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(a, b, label) { ok(a === b, `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function section(t) { console.log(`\n${t}`); }

// ── Block factories: the real shapes, from the Anthropic content union ──────
const T  = text => ({ type: 'text', text });
// Thinking blocks carry `.thinking`, NOT `.text`. On Sonnet 5 the default
// display is "omitted", so `.thinking` is an empty string while the block is
// still present — which is exactly why `content[0].text` was undefined.
const TH = (thinking = '') => ({ type: 'thinking', thinking, signature: 'sig' });
const TU = () => ({ type: 'tool_use', id: 'toolu_1', name: 'x', input: {} });
const RT = () => ({ type: 'redacted_thinking', data: 'encrypted' });
const FB = () => ({ type: 'fallback', from: { model: 'a' }, to: { model: 'b' } });

/** Build a fake Anthropic client whose stream(...).finalMessage() yields `msg`. */
function fakeClient(msg, capture = {}) {
  return () => ({
    messages: {
      stream(body) {
        capture.body = body;
        return { finalMessage: async () => msg };
      },
    },
  });
}
const message = (content, extra = {}) => ({
  stop_reason: 'end_turn', model: 'claude-sonnet-5',
  usage: { input_tokens: 10, output_tokens: 20 },
  content, ...extra,
});

/** Run the REAL generateText against a synthetic Anthropic response. */
async function viaRealPath(msg, { responseFormat = 'text', opts = {} } = {}) {
  const capture = {};
  __setAnthropicClientFactory(fakeClient(msg, capture));
  try {
    const out = await generateText('sys', 'user', 4096, responseFormat, null,
      { provider: 'anthropic', ...opts });
    return { ok: true, out, capture };
  } catch (err) {
    return { ok: false, err, capture };
  } finally {
    __setAnthropicClientFactory(null);
  }
}

// ── 1. extractAnthropicText — the contract, shape by shape ──────────────────
section('1. extractAnthropicText — text found regardless of position; absence is null');
{
  eq(extractAnthropicText([T('hello')]), 'hello', '[text] → the text');
  // [RED-ON-SHIPPING] the whole defect, at the unit level.
  eq(extractAnthropicText([TH(), T('answer')]), 'answer',
    '[RED-ON-SHIPPING] [thinking, text] → the TEXT, not undefined');
  eq(extractAnthropicText([TH('reasoning...'), T('answer')]), 'answer',
    '[thinking with visible summary, text] → still the text');
  eq(extractAnthropicText([T('a'), TH(), T('b')]), 'ab',
    'text blocks split around a thinking block are rejoined');
  eq(extractAnthropicText([T('a'), T('b')]), 'ab',
    '[RED-ON-SHIPPING] [text, text] → BOTH concatenated (citations split replies this way)');
  eq(extractAnthropicText([T('{"a":1'), FB(), T(',"b":2}')]), '{"a":1,"b":2}',
    'a fallback block between text blocks does not truncate the JSON');

  // Absence must stay a hard failure, not a silent empty string.
  eq(extractAnthropicText([]), null, '[] → null (no text block at all)');
  eq(extractAnthropicText([TH()]), null, '[thinking] only → null → caller throws');
  eq(extractAnthropicText([TU()]), null, '[tool_use] only → null → caller throws');
  eq(extractAnthropicText([RT(), TU()]), null, '[redacted_thinking, tool_use] → null');
  eq(extractAnthropicText(null), null, 'null content → null');
  eq(extractAnthropicText(undefined), null, 'undefined content → null');
  eq(extractAnthropicText('not an array'), null, 'non-array content → null');

  // A present-but-empty text block is a genuine (odd) model output, NOT an
  // absence — and the pre-fix code returned '' for it too. Preserved.
  eq(extractAnthropicText([T('')]), '', '[text:""] → "" (present, empty) — not null');
  eq(extractAnthropicText([TH(), T('')]), '', '[thinking, text:""] → "" — not null');

  // Malformed members must be skipped, never crash the chokepoint.
  eq(extractAnthropicText([null, undefined, T('x')]), 'x', 'null/undefined members skipped');
  eq(extractAnthropicText([{ type: 'text' }, T('x')]), 'x', 'text block with no .text skipped');
  eq(extractAnthropicText([{ type: 'text', text: 42 }, T('x')]), 'x', 'non-string .text skipped');
  // Matching is on the documented discriminant, not on "has a .text string" —
  // a future block type carrying .text must not be spliced into the answer.
  eq(extractAnthropicText([{ type: 'future_block', text: 'LEAK' }, T('real')]), 'real',
    'a non-text block carrying a .text field is NOT spliced into the answer');
}

// ── 2. THE CLASS INVARIANT — position independence, over generated arrays ────
// Not a case list. A case list can only hold shapes we already thought of, and
// the shipping bug was exactly a shape nobody enumerated. This asserts the
// property itself over a deterministic sweep of ~2000 generated arrays.
section('2. CLASS INVARIANT — extracted text === concat of text-typed blocks, any position');
{
  // Deterministic PRNG so a failure reproduces exactly (mulberry32).
  let seed = 0x9e3779b9;
  const rnd = () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const NON_TEXT = [TH, TU, RT, FB, () => null, () => ({ type: 'image' })];

  let violations = 0, sawMultiText = 0, sawTextNotFirst = 0, sawNoText = 0;
  const TRIALS = 2000;
  for (let i = 0; i < TRIALS; i++) {
    const len = Math.floor(rnd() * 6);          // 0..5 blocks
    const content = [];
    const expectedParts = [];
    for (let j = 0; j < len; j++) {
      if (rnd() < 0.4) {
        const s = `t${i}_${j}`;
        content.push(T(s));
        expectedParts.push(s);
      } else {
        content.push(NON_TEXT[Math.floor(rnd() * NON_TEXT.length)]());
      }
    }
    const expected = expectedParts.length === 0 ? null : expectedParts.join('');
    const actual = extractAnthropicText(content);
    if (actual !== expected) { violations++; if (violations === 1) console.log(`     first violation: ${JSON.stringify(content)}`); }
    if (expectedParts.length > 1) sawMultiText++;
    if (expectedParts.length > 0 && content[0]?.type !== 'text') sawTextNotFirst++;
    if (expectedParts.length === 0 && content.length > 0) sawNoText++;
  }
  eq(violations, 0, `invariant holds across ${TRIALS} generated content arrays`);
  // Coverage proof — a green above is meaningless if the corpus never actually
  // produced the interesting shapes. This is the control that the sweep CAN fail.
  ok(sawMultiText > 100, `corpus exercised multi-text arrays (${sawMultiText} of ${TRIALS})`);
  ok(sawTextNotFirst > 100,
    `[RED-ON-SHIPPING] corpus exercised text-not-first arrays (${sawTextNotFirst} of ${TRIALS})`);
  ok(sawNoText > 100, `corpus exercised no-text-block arrays (${sawNoText} of ${TRIALS})`);

  // Permutation form of the same property, stated directly: shuffling the
  // non-text blocks around a single text block must never change the answer.
  const answer = T('THE ANSWER');
  const decoys = [TH(), TU(), RT(), FB()];
  let permViolations = 0;
  for (let pos = 0; pos <= decoys.length; pos++) {
    const content = [...decoys.slice(0, pos), answer, ...decoys.slice(pos)];
    if (extractAnthropicText(content) !== 'THE ANSWER') permViolations++;
  }
  eq(permViolations, 0, 'the text block is found at every one of its 5 possible positions');
}

// ── 3. THE REAL PATH — generateText → callLLM → callProvider ────────────────
// §1/§2 test the helper. This tests that callProvider actually USES it, which
// is the property that regressed. Asserting a helper in isolation while the
// call site still indexes [0] is exactly how a green suite ships a broken app.
section('3. Real generateText path against synthetic finalMessage() shapes');
{
  let r = await viaRealPath(message([T('plain answer')]));
  ok(r.ok && r.out === 'plain answer', '[text] → returned unchanged (the common path is untouched)');

  r = await viaRealPath(message([TH(), T('{"pages":[]}')]), { responseFormat: 'json' });
  ok(r.ok && r.out === '{"pages":[]}',
    '[RED-ON-SHIPPING] [thinking, text] through the REAL path → the JSON body, not a throw');

  r = await viaRealPath(message([T('part one '), T('part two')]));
  ok(r.ok && r.out === 'part one part two',
    '[RED-ON-SHIPPING] [text, text] through the REAL path → both, not just the first');

  // The defensive error must survive: absence is still a hard failure.
  r = await viaRealPath(message([TU()]));
  ok(!r.ok && /returned no text content/.test(r.err.message),
    '[tool_use] only → still throws "returned no text content"');
  r = await viaRealPath(message([TH()]));
  ok(!r.ok && /returned no text content/.test(r.err.message),
    '[thinking] only, no text → still throws (not a silent empty string)');
  r = await viaRealPath(message([]));
  ok(!r.ok && /returned no text content/.test(r.err.message),
    '[] → still throws');

  // Never turn a real failure into a silent success.
  r = await viaRealPath(message([TU()]));
  ok(!r.ok && r.out === undefined, 'a text-free response never returns "" as if it succeeded');

  // The request body is unchanged by this fix — no `thinking` parameter is sent
  // (which is WHY Sonnet 5 runs adaptive), and none is added here.
  r = await viaRealPath(message([TH(), T('x')]));
  ok(r.capture.body && !('thinking' in r.capture.body),
    'request body still sends no `thinking` parameter (behaviour unchanged)');
  ok(r.capture.body?.max_tokens === 4096, 'max_tokens still threaded through unchanged');
}

// ── 4. max_tokens truncation — the partial must be the TEXT, not '' ─────────
section('4. stop_reason:max_tokens — partial recovered from a non-first text block');
{
  const truncated = content => message(content, { stop_reason: 'max_tokens' });

  // TEXT mode: the partial answer is the whole point of the v3.0.7 graceful
  // degradation. First-block indexing silently discarded it.
  let r = await viaRealPath(truncated([TH(), T('a partial prose answer')]));
  ok(r.ok && r.out.startsWith('a partial prose answer'),
    '[RED-ON-SHIPPING] text mode: partial is the TEXT block, not an empty string');
  ok(r.ok && /cut off because it reached the response length limit/.test(r.out),
    'text mode: truncation note still appended');

  r = await viaRealPath(truncated([T('one '), TH(), T('two')]));
  ok(r.ok && r.out.startsWith('one two'), 'text mode: split partials rejoined');

  // JSON mode still throws, and the ladders still fire — §5 pins that contract.
  r = await viaRealPath(truncated([TH(), T('{"pages":[')]), { responseFormat: 'json' });
  ok(!r.ok, 'json mode: still throws on truncation');
  ok(!r.ok && /output token limit/.test(r.err.message),
    'json mode: message still contains the literal phrase "output token limit"');

  // Absence during truncation degrades to '' rather than throwing the
  // "no text content" error — the pre-fix behaviour for that shape, preserved.
  r = await viaRealPath(truncated([TH()]));
  ok(r.ok && /cut off because it reached the response length limit/.test(r.out),
    'text mode, no text block: still degrades to the note (no "no text content" throw)');
}

// ── 5. The isOutputTokenLimit contract — ingest/compile ladders still fire ───
// ingest.js's Phase-2 page-by-page fallback, its single-pass→multi-phase switch,
// and compile.js's full→concise→summary-only ladder ALL key on this predicate
// matching the thrown message. If this breaks, those ladders silently stop
// recovering and a large document fails outright.
section('5. isOutputTokenLimit still matches the JSON-mode throw after the change');
{
  const r = await viaRealPath(
    message([TH(), T('{"pages":[')], { stop_reason: 'max_tokens' }),
    { responseFormat: 'json' });
  ok(!r.ok, 'json truncation throws');
  ok(!r.ok && isOutputTokenLimit(r.err),
    'isOutputTokenLimit(err) === true → ingest + compile fallback ladders still recover');
  ok(!r.ok && !/by chapter|Phase 2 batch size|split the source/.test(r.err.message),
    'message stays context-neutral (no ingest-specific advice at the shared chokepoint)');

  // Control: the helper itself is unchanged, so its direct contract still holds.
  let threw = null;
  try { handleOutputTokenLimit('Claude', 4096, 'json', 'partial'); } catch (e) { threw = e; }
  ok(threw && isOutputTokenLimit(threw), 'handleOutputTokenLimit json contract unchanged');

  // Negative control — proves the predicate can say NO, so the greens above are
  // not a predicate that returns true for everything.
  ok(!isOutputTokenLimit(new Error('some other failure')),
    'control: isOutputTokenLimit is false for an unrelated error');
}

// ── 6. Usage reporting is unaffected — and is a PASSTHROUGH ─────────────────
// Recorded, not changed (that is the orchestrator's call): outputTokens is a
// straight rename of the API's output_tokens. Thinking tokens are billed as
// output tokens and the API counts them there, so a thinking-heavy call is
// charged correctly by whatever reads this — but the split between "reasoning"
// and "answer" is NOT observable here. See the release notes.
section('6. onUsage still fires once per completed call, unchanged by the fix');
{
  const seen = [];
  const r = await viaRealPath(message([TH(), T('ok')], {
    usage: { input_tokens: 111, output_tokens: 222,
             cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
  }), { opts: { onUsage: u => seen.push(u) } });
  ok(r.ok, 'call succeeds');
  eq(seen.length, 1, 'onUsage fired exactly once');
  eq(seen[0]?.outputTokens, 222, 'outputTokens is a passthrough of the API value');
  eq(seen[0]?.inputTokens, 111, 'inputTokens unchanged');
  eq(seen[0]?.provider, 'anthropic', 'provider tagged');

  // Usage is reported BEFORE the truncation check — a truncated call ran and
  // was billed, so it must still be metered.
  const seen2 = [];
  await viaRealPath(message([TH(), T('cut')], {
    stop_reason: 'max_tokens', usage: { input_tokens: 5, output_tokens: 6 },
  }), { opts: { onUsage: u => seen2.push(u) } });
  eq(seen2.length, 1, 'a truncated call is still metered');

  // A throwing callback must never break the call (the v3.0.4 onWarn rule).
  const r3 = await viaRealPath(message([TH(), T('fine')]),
    { opts: { onUsage: () => { throw new Error('boom'); } } });
  ok(r3.ok && r3.out === 'fine', 'a throwing onUsage callback cannot break the call');

  eq(normalizeAnthropicUsage({ output_tokens: 9 }).outputTokens, 9,
    'normalizeAnthropicUsage unchanged');
}

// ── 7. Source guards — ONE implementation, and no first-block indexing left ──
// Two hand-maintained copies of a guard is what produced the v3.2.0 CRITICAL,
// and here it would be worse: a fix applied to the normal return while the
// max_tokens branch kept indexing [0] would leave truncated answers empty —
// the reported case closed while the purpose stayed broken.
section('7. Source guards — single extraction implementation in llm.js');
{
  const src = readFileSync(path.join(ROOT, 'src/brain/llm.js'), 'utf8');
  const calls = (src.match(/extractAnthropicText\(/g) || []).length;
  ok(calls >= 3, `extractAnthropicText is defined once and called at both sites (${calls} refs)`);

  // Scan CODE lines only. The docblock above extractAnthropicText quotes the bug
  // as `content[0].text`, and a naive whole-file scan matched its own
  // explanation — a guard reporting a defect that is not there, which is the
  // same class of mis-scan as a guard reporting green over one that is.
  //
  // The filter drops only lines whose FIRST non-whitespace character opens or
  // continues a comment. It deliberately does NOT strip trailing `//` comments
  // from code lines: doing that needs string-awareness (this file contains URLs
  // with `//`), and getting it wrong would make the scan silently BLIND. Leaving
  // them in errs toward a false positive, never a false negative.
  // NOT ENFORCED: `content[0]` written inside a trailing comment on a code line
  // still trips this. That is the intended direction of the trade.
  const codeOnly = src.split('\n')
    .filter(line => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join('\n');
  const FIRST_BLOCK_INDEX = /content\s*\??\.?\s*\[\s*0\s*\]/;
  ok(!FIRST_BLOCK_INDEX.test(codeOnly),
    'no `content[0]` indexing remains in llm.js CODE');
  // Negative control: prove the detector can fail. Without this, the green above
  // is equally consistent with a regex that never matches anything.
  ok(FIRST_BLOCK_INDEX.test('  const b = message.content[0];'),
    'control: the detector DOES fire on a reintroduced `content[0]`');
  ok(FIRST_BLOCK_INDEX.test('  const b = message?.content?.[0];'),
    'control: the detector also fires on the optional-chained form');
  // The filter — not the regex — is what spares the docblock. Test the filter.
  const filt = text => text.split('\n').filter(l => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
  eq(filt(' * we used to read `content[0].text` here').trim(), '',
    'control: the filter removes a pure-comment line, so the docblock is not scanned');
  ok(FIRST_BLOCK_INDEX.test(filt('  const b = message.content[0]; // real code')),
    'control: the filter KEEPS a code line, so a real reintroduction is still caught');
  ok(!/firstBlock/.test(src), 'the `firstBlock` variable is gone from llm.js');
  // The seam must be inert in production: no module-level snapshot, and the
  // override must default to null.
  ok(/_anthropicClientFactoryOverride\s*=\s*null/.test(src),
    'the test-only client seam defaults to null (inert in production)');
  ok(/_anthropicClientFactoryOverride\s*\?/.test(src),
    'the seam is resolved per call, not snapshotted at module load');
}

console.log(`\nPassed: ${passed}   Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
