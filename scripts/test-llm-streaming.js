/**
 * test-llm-streaming.js — OFFLINE suite for `generateText`'s `opts.onDelta`.
 * Deterministic, free, no network, no real credentials.
 *
 * WHY THIS FEATURE EXISTS. Chat is a single non-streaming POST, so
 * time-to-first-byte EQUALS total time and the user watches a spinner for
 * minutes. Measured on `z-ai/glm-5.3-flash`: reasoning deltas begin at ~1.1 s
 * while content deltas do not begin until 38-58 s of a 45-63 s call — so it is
 * the model's REASONING, not its answer, that is the thing capable of removing
 * the dead air.
 *
 * WHAT MAKES IT DANGEROUS, AND WHAT THIS FILE IS REALLY GUARDING.
 *
 *   (1) `generateText` is the ONE chokepoint every LLM call in this app passes
 *       through — ingest, compile, health-ai, query, diagnostics, sharedbrain,
 *       chat. EXACTLY ONE of those streams. (Enumerate the consumers rather
 *       than trusting a count here: compile.js reaches it as
 *       `opts.generateText || generateText` and calls it through a local, so a
 *       grep for `generateText(` under-counts by at least one.) So the headline property is not
 *       "streaming works", it is "NOTHING CHANGES WHEN onDelta IS ABSENT", and
 *       §2 asserts that at the level of the object the transport actually
 *       receives, not by reading the source and agreeing with it.
 *
 *   (2) COMMIT-AT-FIRST-DELTA. The retry ladder in `generateText` (up to
 *       MAX_RETRIES attempts) and the fallback walk in `callLLM` (up to every
 *       rung of FALLBACK_CHAINS) both WRAP the provider call. That is correct
 *       while nothing has been shown to the user — an attempt that failed
 *       produced no output, so replacing it costs nothing. Streaming destroys
 *       that premise: retrying after a delta appends a SECOND model's tokens to
 *       a FIRST model's half-sentence, silently, with a green result and a cost
 *       line naming one model. §4 proves both readers of that rule fire, and —
 *       more importantly — §4c/§4d prove the ladders are STILL INTACT when the
 *       failure lands before the first delta, which is the common case and the
 *       case the ladders were built for.
 *
 *   (3) REASONING MUST NEVER REACH THE RETURN VALUE. It is the model's
 *       scratchpad. The return value is what gets written into a wiki page.
 *
 * WHAT THIS FILE CANNOT REACH, STATED RATHER THAN IMPLIED AWAY. There is no
 * injectable client seam for Gemini — `new GoogleGenerativeAI(...)` is
 * constructed directly in `callProvider`, unlike Anthropic
 * (`__setAnthropicClientFactory`) and OpenRouter
 * (`__setOpenRouterAdapterFactory`). So the Gemini transport split is covered
 * here by SOURCE GUARDS ONLY (§7), which are weaker than execution, and the
 * real proof for that provider is the live run recorded in the release notes.
 * Two of three providers are driven end-to-end.
 *
 * Assertions that would have gone RED on the pre-streaming code are labelled
 * [NEW-CONTRACT]; assertions that pin behaviour which must NOT have changed are
 * labelled [UNCHANGED].
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Isolate credential resolution BEFORE anything reads it — getUserDataDir() and
// getEffectiveKey() both resolve per call, so an env var set here is honoured
// even though ES imports hoist above the module body. Without this the suite
// would read the developer's real .curator-config.json.
process.env.CURATOR_TEST_USER_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'curator-llm-streaming-'));
// Dummy keys. Both client constructors are replaced by test seams, so no value
// here is ever sent anywhere; they exist only so getEffectiveKey resolves.
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-a-real-key';
process.env.OPENROUTER_API_KEY = 'sk-or-v1-test-not-a-real-key';
// LLM_MODEL would override the model getProviderInfo resolves, making the
// model-dependent assertions depend on the developer's shell.
delete process.env.LLM_MODEL;

const { generateText, __setAnthropicClientFactory, __setOpenRouterAdapterFactory,
        isAbortError, makeAbortError, ABORT_MESSAGE, __testing } =
  await import('../src/brain/llm.js');
const { makeDeltaEmitter, MAX_RETRIES, FALLBACK_CHAINS } = __testing;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LLM_SRC = readFileSync(path.join(__dirname, '..', 'src', 'brain', 'llm.js'), 'utf8');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(a, b, label) { ok(a === b, `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function section(t) { console.log(`\n${t}`); }

// ── Doubles ─────────────────────────────────────────────────────────────────

/**
 * Anthropic client double. `script` is called once per attempt and returns
 * `{deltas?, message?, throws?}`; `log` records every call so a test can assert
 * on HOW MANY provider calls actually happened, which is the ground truth for
 * "did the ladder run".
 *
 * `emitOn` mirrors the real MessageStream contract: listeners registered with
 * `.on('text'|'thinking', ...)` are invoked while `.finalMessage()` is awaited.
 * A double for a NON-streaming expectation deliberately omits `.on` entirely —
 * see §2a, where its absence is the assertion.
 */
function anthropicDouble(script, log) {
  return () => ({
    messages: {
      stream(body) {
        const call = { body, model: body.model, onCalls: [] };
        log.calls.push(call);
        const step = script(log.calls.length, call);
        const listeners = { text: [], thinking: [] };
        return {
          on(event, fn) { call.onCalls.push(event); (listeners[event] ||= []).push(fn); return this; },
          async finalMessage() {
            for (const d of (step.deltas || [])) {
              for (const fn of (listeners[d.event] || [])) fn(d.text, d.text);
            }
            if (step.throws) throw step.throws;
            return step.message;
          },
        };
      },
    },
  });
}

/** A double with NO `.on` at all — proves the non-streaming path never reaches it. */
function anthropicBareDouble(message, log) {
  return () => ({
    messages: {
      stream(body) {
        log.calls.push({ body, model: body.model });
        return { finalMessage: async () => message };
      },
    },
  });
}

const msg = (content, extra = {}) => ({
  stop_reason: 'end_turn', model: 'claude-haiku-4-5',
  usage: { input_tokens: 10, output_tokens: 20 },
  content, ...extra,
});
const T = text => ({ type: 'text', text });
const TH = thinking => ({ type: 'thinking', thinking, signature: 'sig' });

function err(message, props = {}) { return Object.assign(new Error(message), props); }
const E404 = () => err('404 model not found', { status: 404 });
const E503 = () => err('503 Service Unavailable: the model is overloaded', { status: 503 });

/** Run the REAL generateText against a double, capturing deltas and outcome. */
async function run(factorySetter, factory, { opts = {}, responseFormat = 'text' } = {}) {
  const deltas = [];
  factorySetter(factory);
  try {
    const out = await generateText('sys', 'user', 4096, responseFormat, null, opts);
    return { ok: true, out, deltas };
  } catch (e) {
    return { ok: false, err: e, deltas };
  } finally {
    factorySetter(null);
  }
}
/** Collector shaped like the public onDelta contract. */
function collector() {
  const seen = [];
  const fn = (d) => seen.push(d);
  fn.seen = seen;
  fn.content = () => seen.filter(d => d.type === 'content').map(d => d.text).join('');
  fn.reasoning = () => seen.filter(d => d.type === 'reasoning').map(d => d.text).join('');
  return fn;
}

// ═══════════════════════════════════════════════════════════════════════════
section('1. makeDeltaEmitter — the four contracts, driven directly');
{
  eq(makeDeltaEmitter(null, { emitted: false }), null, 'no callback ⇒ no emitter (this is what makes every branch inert)');
  eq(makeDeltaEmitter('not a function', null), null, 'a non-function callback is refused, not coerced');

  // Empty and malformed deltas are dropped BEFORE they can commit anything.
  // This matters: an empty delta shows the user nothing, so committing on it
  // would forfeit a retry that is still free to take.
  for (const bad of [undefined, null, {}, { text: null }, { text: 42 }, { type: 'content', text: '' }]) {
    const c = { emitted: false }; const seen = [];
    makeDeltaEmitter(d => seen.push(d), c)(bad);
    ok(seen.length === 0 && c.emitted === false,
      `empty/malformed delta ${JSON.stringify(bad)} is dropped and commits nothing`);
  }

  // Type is normalised to EXACTLY two values so a caller's switch cannot meet a
  // third. Anything not literally 'reasoning' is content — the fail-safe
  // direction, since mislabelling content as reasoning could HIDE answer text.
  for (const [given, want] of [['reasoning', 'reasoning'], ['content', 'content'],
                               ['thinking', 'content'], [undefined, 'content'],
                               [null, 'content'], ['REASONING', 'content'], [7, 'content']]) {
    const seen = [];
    makeDeltaEmitter(d => seen.push(d), null)({ type: given, text: 'x' });
    eq(seen[0]?.type, want, `type ${JSON.stringify(given)} normalises`);
  }
  const shape = [];
  makeDeltaEmitter(d => shape.push(Object.keys(d).sort().join(',')), null)({ type: 'reasoning', text: 'r', extra: 1 });
  eq(shape[0], 'text,type', 'the callback sees exactly {type,text} — no provider field leaks through');

  // COMMIT BEFORE CALLBACK. If it were set after, a throwing renderer would
  // leave `emitted` false and the ladder would run a SECOND model whose tokens
  // land on top of whatever the first already put on screen.
  {
    const c = { emitted: false };
    const e = makeDeltaEmitter(() => { throw new Error('renderer exploded'); }, c);
    let threw = false;
    try { e({ type: 'content', text: 'hi' }); } catch { threw = true; }
    ok(!threw, 'a throwing onDelta does not propagate — same rule as reportUsage');
    ok(c.emitted === true, 'the commit marker is set even though the callback threw');
  }
  {
    // Order proven positively: the callback observes a marker that is ALREADY set.
    const c = { emitted: false }; let seenAtCallTime = null;
    makeDeltaEmitter(() => { seenAtCallTime = c.emitted; }, c)({ type: 'content', text: 'hi' });
    ok(seenAtCallTime === true, 'the marker is set BEFORE the callback runs, not after');
  }
  {
    const e = makeDeltaEmitter(() => {}, null);
    let threw = false;
    try { e({ type: 'content', text: 'hi' }); } catch { threw = true; }
    ok(!threw, 'a null commit marker is tolerated (the emitter is usable without one)');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('2. onDelta ABSENT ⇒ the transport is byte-identical (the headline property)');
{
  // 2a — Anthropic. The double has NO `.on` method at all. If the non-streaming
  // path ever reached for one, this call would throw "stream.on is not a
  // function". Absence IS the assertion, and it is also why the several
  // existing suites whose doubles return a bare {finalMessage} still pass.
  const log = { calls: [] };
  const r = await run(__setAnthropicClientFactory, anthropicBareDouble(msg([T('plain')]), log),
    { opts: { provider: 'anthropic' } });
  ok(r.ok, '[UNCHANGED] a double with no .on completes — the listeners are never attached');
  eq(r.out, 'plain', '[UNCHANGED] returns the text');
  eq(log.calls.length, 1, '[UNCHANGED] exactly one provider call');

  // 2b — the REQUEST BODY is identical with and without onDelta. Streaming
  // changes transport, not payload: no cache_control shift, no extra field.
  const noStream = { calls: [] }, withStream = { calls: [] };
  await run(__setAnthropicClientFactory,
    anthropicDouble(() => ({ message: msg([T('a')]) }), noStream), { opts: { provider: 'anthropic' } });
  await run(__setAnthropicClientFactory,
    anthropicDouble(() => ({ message: msg([T('a')]) }), withStream),
    { opts: { provider: 'anthropic', onDelta: collector() } });
  eq(JSON.stringify(noStream.calls[0].body), JSON.stringify(withStream.calls[0].body),
    '[UNCHANGED] the Anthropic request body is byte-identical with and without onDelta');
  eq(noStream.calls[0].onCalls.length, 0, '[UNCHANGED] no listener registered when onDelta is absent');
  eq(withStream.calls[0].onCalls.sort().join(','), 'text,thinking',
    '[NEW-CONTRACT] both listeners registered when onDelta is present');

  // 2c — OpenRouter. The params object handed to the adapter must gain NO keys
  // when not streaming, so the adapter (another module, another agent's clock)
  // sees exactly what it has always seen.
  const seenParams = [];
  const orDouble = () => ({
    createChatCompletion: async (p) => {
      seenParams.push(p);
      if (p.onDelta) { p.onDelta({ type: 'reasoning', text: 'think ' }); p.onDelta({ type: 'content', text: 'ans' }); }
      return { text: 'ans', finishReason: 'stop', model: 'x/y', usage: {} };
    },
  });
  const rA = await run(__setOpenRouterAdapterFactory, orDouble, { opts: { provider: 'openrouter' } });
  ok(rA.ok, '[UNCHANGED] OpenRouter call succeeds with no onDelta');
  eq(Object.keys(seenParams[0]).sort().join(','),
    'maxTokens,model,responseFormat,signal,systemPrompt,userPrompt',
    '[UNCHANGED] adapter params gain NO stream/onDelta keys when not streaming');
  ok(!('stream' in seenParams[0]), '[UNCHANGED] `stream` is absent, not present-and-false');

  const col = collector();
  const rB = await run(__setOpenRouterAdapterFactory, orDouble, { opts: { provider: 'openrouter', onDelta: col } });
  ok(rB.ok, 'OpenRouter streaming call succeeds');
  eq(seenParams[1].stream, true, '[NEW-CONTRACT] `stream: true` is passed through to the adapter');
  eq(typeof seenParams[1].onDelta, 'function', '[NEW-CONTRACT] `onDelta` is passed through to the adapter');
  eq(col.reasoning(), 'think ', '[NEW-CONTRACT] adapter reasoning deltas reach the caller');
  eq(col.content(), 'ans', '[NEW-CONTRACT] adapter content deltas reach the caller');
  eq(rB.out, 'ans', '[NEW-CONTRACT] the RETURN value is content only — reasoning is not appended');
}

// ═══════════════════════════════════════════════════════════════════════════
section('3. Reasoning is streamed live and NEVER enters the return value');
{
  const col = collector();
  const log = { calls: [] };
  const r = await run(__setAnthropicClientFactory, anthropicDouble(() => ({
    deltas: [
      { event: 'thinking', text: 'Let me ' }, { event: 'thinking', text: 'consider…' },
      { event: 'text', text: 'The answer ' }, { event: 'text', text: 'is 42.' },
    ],
    message: msg([TH('Let me consider…'), T('The answer is 42.')]),
  }), log), { opts: { provider: 'anthropic', onDelta: col } });

  ok(r.ok, 'call succeeds');
  eq(col.reasoning(), 'Let me consider…', '[NEW-CONTRACT] thinking deltas arrive typed as reasoning');
  eq(col.content(), 'The answer is 42.', '[NEW-CONTRACT] text deltas arrive typed as content');
  eq(r.out, 'The answer is 42.',
    '[NEW-CONTRACT] the returned string is the ANSWER ONLY — the scratchpad is not in it');
  ok(!r.out.includes('Let me consider'),
    '[NEW-CONTRACT] no fragment of the reasoning survives into the value written to a wiki page');
  eq(col.content(), r.out,
    'concatenated content deltas equal the return value — a caller can safely REPLACE its draft');
  // The exclusion is structural, not enforced: extractAnthropicText matches on
  // type === 'text', so a thinking block cannot be admitted by any path.
  ok(/block\.type === 'text'/.test(LLM_SRC),
    'extractAnthropicText still discriminates on type === \'text\' (structural exclusion)');
}

// ═══════════════════════════════════════════════════════════════════════════
section('4. COMMIT-AT-FIRST-DELTA — both readers, and the ladders still intact');
{
  // 4a — generateText's reader. A 503 AFTER a delta must not buy a retry.
  {
    const col = collector(); const log = { calls: [] };
    const t0 = Date.now();
    const r = await run(__setAnthropicClientFactory, anthropicDouble(() => ({
      deltas: [{ event: 'text', text: 'Half a sen' }], throws: E503(),
    }), log), { opts: { provider: 'anthropic', onDelta: col } });
    const ms = Date.now() - t0;

    ok(!r.ok, 'the error surfaces');
    eq(log.calls.length, 1, '[NEW-CONTRACT] EXACTLY ONE provider call — a committed 503 is not retried');
    ok(ms < 1500, `[NEW-CONTRACT] returned in ${ms}ms — it did not serve the 3s backoff`);
    ok(/Service Unavailable/.test(r.err.message),
      '[NEW-CONTRACT] the RAW provider error is rethrown, not the friendly ladder-exhausted wording');
    ok(!/temporarily overloaded/i.test(r.err.message),
      'the "we retried and it kept failing" message is NOT used — the ladder deliberately did not run');
    ok(r.err.curatorTransient !== 'service_unavailable',
      'no curatorTransient tag: the batch queue must not pause a batch over a call we chose not to retry');
    eq(col.content(), 'Half a sen', 'the partial the user already saw is not retracted');
  }

  // 4b — callLLM's reader. A 404 AFTER a delta must not walk the fallback
  // chain. This is the worse of the two to be missing: a walk changes MODEL, so
  // the answer would change voice mid-sentence and _activeFallback would then
  // name the wrong model as the one that served.
  {
    const col = collector(); const log = { calls: [] };
    const r = await run(__setAnthropicClientFactory, anthropicDouble(() => ({
      deltas: [{ event: 'text', text: 'Once upon' }], throws: E404(),
    }), log), { opts: { provider: 'anthropic', onDelta: col } });

    ok(!r.ok, 'the error surfaces');
    eq(log.calls.length, 1, '[NEW-CONTRACT] EXACTLY ONE model attempted — the chain is not walked');
    eq(new Set(log.calls.map(c => c.model)).size, 1, 'only one distinct model id ever reached the transport');
    ok(FALLBACK_CHAINS.anthropic.length > 0,
      'control: the Anthropic chain is non-empty, so "one call" is a refusal to walk, not an empty chain');
  }

  // 4c — THE LADDER IS STILL THERE. A 404 BEFORE any delta still walks.
  {
    const col = collector(); const log = { calls: [] };
    const r = await run(__setAnthropicClientFactory, anthropicDouble((n) => (
      n === 1 ? { throws: E404() }
              : { deltas: [{ event: 'text', text: 'from the fallback' }], message: msg([T('from the fallback')]) }
    ), log), { opts: { provider: 'anthropic', onDelta: col } });

    ok(r.ok, '[UNCHANGED] a 404 before the first delta still recovers');
    eq(log.calls.length, 2, '[UNCHANGED] the fallback chain WAS walked — commit-at-first-delta did not over-fire');
    ok(log.calls[0].model !== log.calls[1].model, '[UNCHANGED] a genuinely different model served');
    eq(r.out, 'from the fallback', 'the answer comes from the rung that succeeded');
    eq(col.content(), 'from the fallback', 'only the surviving attempt streamed anything');
  }

  // 4d — and the RETRY ladder is still there. A 503 before any delta still
  // retries. This costs one real 3s backoff and is worth it: it is the only
  // assertion separating "the gate works" from "the gate is stuck on".
  {
    const col = collector(); const log = { calls: [] };
    const t0 = Date.now();
    const r = await run(__setAnthropicClientFactory, anthropicDouble((n) => (
      n === 1 ? { throws: E503() }
              : { deltas: [{ event: 'text', text: 'second try' }], message: msg([T('second try')]) }
    ), log), { opts: { provider: 'anthropic', onDelta: col } });
    const ms = Date.now() - t0;

    ok(r.ok, '[UNCHANGED] a 503 before the first delta still retries and recovers');
    eq(log.calls.length, 2, '[UNCHANGED] the retry ladder ran');
    ok(ms >= 2500, `[UNCHANGED] it served the real backoff (${ms}ms) — the ladder is genuine, not short-circuited`);
    ok(MAX_RETRIES > 1, 'control: MAX_RETRIES leaves room for a retry, so 2 calls is the ladder and not a fluke');
  }

  // 4e — THE PRODUCTION ANTHROPIC SHAPE, measured live and counter-intuitive.
  // On claude-sonnet-5 with an ingest-shaped prompt the model DOES return a
  // thinking block and the SDK DOES fire `thinking` — but `delta.thinking` is
  // the EMPTY STRING (the block carries only a signature; Anthropic returns the
  // deliberation encrypted). 4/4 live runs: content blocks ["thinking","text"],
  // reasoning deltas received 0.
  //
  // That makes the empty-drop load-bearing rather than defensive. Without it,
  // every such call would emit a `{type:'reasoning', text:''}` — showing the
  // user nothing, and COMMITTING the call, which silently disables the retry
  // ladder and the fallback walk on the app's most-used Anthropic path.
  {
    const col = collector(); const log = { calls: [] };
    const r = await run(__setAnthropicClientFactory, anthropicDouble((n) => (
      n === 1 ? { deltas: [{ event: 'thinking', text: '' }], throws: E404() }
              : { deltas: [{ event: 'thinking', text: '' }, { event: 'text', text: 'ok' }],
                  message: msg([T('ok')]) }
    ), log), { opts: { provider: 'anthropic', onDelta: col } });

    ok(r.ok, 'an EMPTY Anthropic thinking delta does not commit — the ladder still recovered a 404');
    eq(log.calls.length, 2, 'the fallback walk ran, exactly as it does without streaming');
    eq(col.seen.length, 1, 'and the caller was never woken with an empty reasoning delta');
    eq(col.reasoning(), '', 'no reasoning text is fabricated for a signature-only thinking block');
    eq(r.out, 'ok', 'the answer is unaffected');
  }

  // 4f — the gate is per-generateText-call, not sticky across calls. A marker
  // that leaked between calls would silently disable the ladder app-wide.
  {
    const log = { calls: [] };
    const r = await run(__setAnthropicClientFactory, anthropicDouble((n) => (
      n === 1 ? { throws: E404() } : { message: msg([T('recovered')]) }
    ), log), { opts: { provider: 'anthropic' } });
    ok(r.ok && log.calls.length === 2,
      '[UNCHANGED] a later call with no onDelta still walks — the marker did not leak across calls');
  }

  // 4h — a non-streaming call is untouched by the gate even when it fails.
  {
    const log = { calls: [] };
    const r = await run(__setAnthropicClientFactory, anthropicDouble(() => ({ throws: E404() }), log),
      { opts: { provider: 'anthropic' } });
    ok(!r.ok, 'a 404 on every rung still fails');
    ok(log.calls.length === 1 + FALLBACK_CHAINS.anthropic.filter(m => m !== log.calls[0].model).length,
      `[UNCHANGED] every rung was tried (${log.calls.length} calls) — the gate is inert without onDelta`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('5. A throwing onDelta cannot break the call, through the REAL path');
{
  const log = { calls: [] };
  const r = await run(__setAnthropicClientFactory, anthropicDouble(() => ({
    deltas: [{ event: 'thinking', text: 'r' }, { event: 'text', text: 'answer' }],
    message: msg([T('answer')]),
  }), log), {
    opts: { provider: 'anthropic', onDelta: () => { throw new Error('renderer exploded'); } },
  });
  ok(r.ok, 'the call still succeeds when every delta callback throws');
  eq(r.out, 'answer', 'and still returns the full answer — deltas are a preview, not the answer');
  eq(log.calls.length, 1, 'and it was NOT retried: a delta that was handed over counts as committed');
}

// ═══════════════════════════════════════════════════════════════════════════
section('6. ABORT still beats every other classifier, including the commit gate');
{
  // A cancel arriving AFTER deltas must still normalise to the tagged abort
  // error every caller keys on. If the commit gate were checked first it would
  // rethrow the raw error and `isAbortError` would be the only thing that still
  // worked — chat's cancel path keys on ABORT_MESSAGE too.
  {
    const col = collector(); const log = { calls: [] };
    const r = await run(__setAnthropicClientFactory, anthropicDouble(() => ({
      deltas: [{ event: 'text', text: 'partial' }], throws: makeAbortError(),
    }), log), { opts: { provider: 'anthropic', onDelta: col } });

    ok(!r.ok, 'the abort surfaces as an error');
    ok(isAbortError(r.err), '[NEW-CONTRACT] a cancel mid-stream is still the TAGGED abort error');
    eq(r.err.message, ABORT_MESSAGE, 'and carries the canonical abort message');
    eq(log.calls.length, 1, 'and no retry or chain walk followed the cancel');
  }
  // A raw SDK AbortError (name only, no tag) mid-stream classifies the same way.
  {
    const log = { calls: [] };
    const r = await run(__setAnthropicClientFactory, anthropicDouble(() => ({
      deltas: [{ event: 'text', text: 'p' }], throws: err('The operation was aborted', { name: 'AbortError' }),
    }), log), { opts: { provider: 'anthropic', onDelta: collector() } });
    ok(isAbortError(r.err), 'an untagged SDK AbortError mid-stream is normalised too');
    eq(r.err.message, ABORT_MESSAGE, 'to our canonical message, not the SDK wording');
  }
  // An aborted signal turns even an unrelated error into an abort.
  {
    const ctl = new AbortController();
    const log = { calls: [] };
    const r = await run(__setAnthropicClientFactory, anthropicDouble(() => {
      ctl.abort();
      return { deltas: [{ event: 'text', text: 'p' }], throws: E503() };
    }, log), { opts: { provider: 'anthropic', onDelta: collector(), signal: ctl.signal } });
    ok(isAbortError(r.err), 'signal.aborted wins over the commit gate AND over the 503 classifier');
    eq(log.calls.length, 1, 'no retry after a cancel');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('7. Truncation under streaming — the note reaches the user via the return value');
{
  // The partial has ALREADY been streamed. handleOutputTokenLimit returns that
  // same partial PLUS the note, so a caller that REPLACES its draft with the
  // return value shows the note with no second channel to wire. This assertion
  // is what makes "the return value is authoritative and complete" testable.
  {
    const col = collector();
    const r = await run(__setAnthropicClientFactory, anthropicDouble(() => ({
      deltas: [{ event: 'text', text: 'A long answer that got cut' }],
      message: msg([T('A long answer that got cut')], { stop_reason: 'max_tokens' }),
    }), { calls: [] }), { opts: { provider: 'anthropic', onDelta: col } });

    ok(r.ok, 'text mode still DEGRADES rather than failing');
    ok(r.out.startsWith(col.content()),
      '[NEW-CONTRACT] the return value BEGINS with exactly what was streamed — a replace is seamless');
    ok(/cut off because it reached the response length limit/.test(r.out),
      '[NEW-CONTRACT] the truncation note is carried by the ordinary return value');
    ok(r.out.length > col.content().length, 'the return value is a superset of the stream, never a subset');
  }
  // JSON mode still THROWS with the literal phrase ingest.js and compile.js
  // key their recovery ladders on. Streaming must not turn a structured
  // truncation into a silently-accepted partial.
  {
    const r = await run(__setAnthropicClientFactory, anthropicDouble(() => ({
      deltas: [{ event: 'text', text: '{"pages":[' }],
      message: msg([T('{"pages":[')], { stop_reason: 'max_tokens' }),
    }), { calls: [] }), { opts: { provider: 'anthropic', onDelta: collector() }, responseFormat: 'json' });

    ok(!r.ok, '[UNCHANGED] json mode still throws on truncation');
    ok(/output token limit/i.test(r.err.message),
      '[UNCHANGED] the literal "output token limit" survives — ingest/compile ladders still fire');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('8. Source guards — ordering, and the Gemini branch this suite cannot execute');
{
  // Position of the commit gate inside each function body, asserted as an
  // ORDER rather than as presence: a gate that sits after a classifier is
  // present and useless. Bodies are sliced so the two functions are checked
  // independently — a single file-wide regex is satisfied by a line in the
  // OTHER function, which is one of this repo's recorded decorative-guard
  // shapes.
  function body(name) {
    const i = LLM_SRC.indexOf(`async function ${name}(`);
    ok(i > 0, `control: ${name} was located in the source`);
    return LLM_SRC.slice(i, i + 14000);
  }
  for (const [fn, abortNeedle, classifier] of [
    ['generateText', 'isAbortError(err) || (signal && signal.aborted)', 'const deterministic = isDeterministicProviderError(err)'],
    ['callLLM', 'isAbortError(err) || (opts.signal && opts.signal.aborted)', 'if (isDeterministicProviderError(err)) throw err'],
  ]) {
    const b = body(fn);
    const iAbort = b.indexOf(abortNeedle);
    const iCommit = b.search(/if \((?:opts\.)?streamCommit && (?:opts\.)?streamCommit\.emitted\) throw err;/);
    const iClass = b.indexOf(classifier);
    ok(iAbort > 0 && iCommit > 0 && iClass > 0, `control: all three markers found in ${fn}`);
    ok(iAbort < iCommit, `${fn}: ABORT is classified before the commit gate`);
    ok(iCommit < iClass, `${fn}: the commit gate precedes every other classifier`);
  }

  // Gemini: no injectable client seam exists, so this is source-only and the
  // real proof is the live run. Both arms must be present and distinct.
  const gem = LLM_SRC.slice(LLM_SRC.indexOf("if (provider === 'gemini')"), LLM_SRC.indexOf("if (provider === 'openrouter')"));
  ok(/if \(emit\) \{/.test(gem), 'Gemini has a two-arm transport split on `emit`');
  ok(/geminiModel\.generateContentStream\(geminiRequest, \{ signal \}\)/.test(gem)
     && /geminiModel\.generateContentStream\(geminiRequest\)/.test(gem),
    'the streaming arm keeps the signal/no-signal split (an undefined signal would change the SDK call)');
  ok(/geminiModel\.generateContent\(geminiRequest, \{ signal \}\)/.test(gem)
     && /geminiModel\.generateContent\(geminiRequest\)/.test(gem),
    '[UNCHANGED] the NON-streaming arm still calls generateContent, not the stream API');
  ok(/aggregated\.catch\(\(\) => \{\}\)/.test(gem),
    'the aggregate promise gets a parked rejection handler (no unhandled rejection if the loop throws first)');
  ok(/result = \{ response: await aggregated \}/.test(gem),
    'the streaming arm rebuilds the `{response}` shape the code below already reads');
  // Control: the detector can tell the arms apart, so the two assertions above
  // are not both satisfied by the same substring.
  ok(gem.indexOf('generateContentStream(') !== gem.indexOf('generateContent('),
    'control: the two call names are distinguishable in the source');

  // The commit marker must be an OBJECT shared by reference. A boolean would be
  // invisible to callLLM, which is the reader that stops a chain walk.
  ok(/const streamCommit = onDelta \? \{ emitted: false \} : null;/.test(LLM_SRC),
    'the marker is a shared mutable object, not a local boolean');
  ok(/onDelta,\n    streamCommit,/.test(LLM_SRC), 'and it is threaded into callOpts by reference');
}

console.log(`\nPassed: ${passed}   Failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
