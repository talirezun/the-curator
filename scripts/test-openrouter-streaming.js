#!/usr/bin/env node
/**
 * test-openrouter-streaming.js — OFFLINE suite for SSE streaming in
 * `src/brain/openrouter-adapter.js`.
 *
 * NO NETWORK. NO CREDENTIAL. Every assertion drives the REAL
 * `createChatCompletion` with an injected `fetchImpl` returning a synthetic SSE
 * body, so what is exercised is the shipped transport rather than a
 * re-implementation of it living in this file.
 *
 * ── WHAT THIS EXISTS TO CATCH ────────────────────────────────────────────────
 *
 * 1. THE NON-STREAMING PATH CHANGING AT ALL (§1). Chat is the only streaming
 *    caller. Ingest, Health, compile and Shared Brain all go through this same
 *    method non-streaming, and a wiki is written from what it returns. So the
 *    headline assertion is not "streaming works" — it is that the request body
 *    is BYTE-IDENTICAL and the result shape is unchanged when `stream` is
 *    absent. A diff proven by serialisation, not by reading the code.
 *
 * 2. REASONING LEAKING INTO THE ANSWER (§3). `delta.reasoning` is the model's
 *    scratchpad. Concatenating it would produce a chat answer, and on other
 *    paths a WIKI PAGE, containing the model thinking out loud — a silent
 *    correctness failure that every transport-level test would still pass. The
 *    assertion is on the returned text, not on the callback.
 *
 * 3. EMPTY-STRING CONTENT DURING THE REASONING PHASE (§3b). MEASURED on the
 *    wire 2026-08-30: on `z-ai/glm-5.3-flash`, 110 of 130 frames carried
 *    `content`, `reasoning`, `reasoning_details` and `role` TOGETHER — i.e.
 *    `content` was present and EMPTY for the whole reasoning phase. A parser
 *    keyed on the key existing rather than the string being non-empty emits
 *    ~110 empty content deltas before the answer starts, which on a UI that
 *    switches state on first content is the whole bug.
 *
 * 4. A CANCEL BECOMING A RETRY (§7). Under SSE the body IS the call. If a
 *    mid-body abort is classified as a transport failure it is invisible to
 *    llm.js's `isAbortError()` and gets RETRIED — a call the user just
 *    cancelled, billed again. v3.15.0 measured this exact defect on the
 *    non-streaming path (abort at 1,999 ms, body finished at 39,653 ms, billed);
 *    streaming widens the window from "most of the call" to "all of it".
 *
 * 5. A FAILED GENERATION HANDED BACK AS AN ANSWER (§6). A 200 can carry a
 *    top-level `error` frame, a `finish_reason: "error"`, or a
 *    `choices[0].error` riding a perfectly benign `"stop"`. All three must
 *    throw. They are inherited from `parseChatCompletion` rather than
 *    re-implemented, and §6 proves the inheritance actually reaches the
 *    streaming path.
 *
 * 6. THE TWO MODES DRIFTING (§8). Streaming and non-streaming must return the
 *    same keys with the same types for the same logical completion. Asserted by
 *    deep equality between the two, not by inspection.
 *
 * ── NOT ENFORCED, stated rather than implied away ────────────────────────────
 *   • SSE multi-line `data:` fields (spec-legal continuation) are NOT
 *     reassembled: each `data:` line is treated as one JSON payload, which is
 *     what every OpenAI-compatible server sends and what was observed live. A
 *     server that split one JSON object across two `data:` lines would have
 *     both halves counted as malformed frames and skipped — degrading, not
 *     crashing, but degrading.
 *   • Nothing here proves the LIVE endpoint still emits `delta.reasoning`. That
 *     is a wire fact measured by hand; a provider renaming it would leave this
 *     suite green while reasoning stopped reaching the UI.
 */

import { OpenRouterAdapter, OpenRouterError } from '../src/brain/openrouter-adapter.js';

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(actual, expected, label) {
  const same = Object.is(actual, expected);
  ok(same, same ? label : `${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}
function section(t) { console.log(`\n${t}`); }

/**
 * A SUITE THAT ABORTS REPORTS NOTHING, AND NOTHING LOOKS LIKE GREEN.
 * `run-tests.js` judges by exit code AND by scanning output for a failure
 * tally. A mid-run throw satisfies neither cleanly, so completion is asserted.
 */
let COMPLETED = false;
process.on('exit', () => {
  if (!COMPLETED && failed === 0) {
    console.log('  ✗ SUITE DID NOT REACH THE END — treat this run as FAILED');
    console.log('\nPassed: ' + passed + '   Failed: 1');
    process.exitCode = 1;
  }
});

function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every(k => deepEqual(a[k], b[k]));
}

const KEY = 'sk-or-v1-' + '0'.repeat(64); // assembled deliberately: see .githooks/pre-commit

// ── Test doubles ─────────────────────────────────────────────────────────────

/** A Response-like whose body is an async-iterable of Uint8Array. */
function sseResponse(chunks, { status = 200, headers = {}, throwAfter = null, onChunk = null } = {}) {
  const enc = new TextEncoder();
  async function* gen() {
    let i = 0;
    for (const c of chunks) {
      if (throwAfter !== null && i === throwAfter) throw throwAfter_error();
      if (onChunk) await onChunk(i);
      yield enc.encode(c);
      i++;
    }
    if (throwAfter !== null && i === throwAfter) throw throwAfter_error();
  }
  let _err = null;
  function throwAfter_error() { return _err || Object.assign(new Error('stream aborted'), { name: 'AbortError' }); }
  const res = {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n) => headers[String(n).toLowerCase()] ?? null },
    body: gen(),
    json: async () => { throw new Error('json() must not be called on a streaming response'); },
    setStreamError(e) { _err = e; },
  };
  return res;
}

/** Same, but the body only exposes getReader() — the polyfill / browser shape. */
function sseResponseReaderOnly(chunks, { status = 200, headers = {} } = {}) {
  const enc = new TextEncoder();
  let i = 0;
  const res = {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n) => headers[String(n).toLowerCase()] ?? null },
    body: {
      getReader() {
        return {
          async read() {
            if (i >= chunks.length) return { value: undefined, done: true };
            return { value: enc.encode(chunks[i++]), done: false };
          },
        };
      },
    },
    json: async () => { throw new Error('json() must not be called on a streaming response'); },
  };
  return res;
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n) => headers[String(n).toLowerCase()] ?? null },
    json: async () => body,
  };
}

/** `data: {...}\n\n`, exactly as OpenRouter frames it. */
const frame = (o) => `data: ${JSON.stringify(o)}\n\n`;
const chunk = (delta, extra = {}) => ({
  id: 'gen-TEST-1', object: 'chat.completion.chunk', created: 1, model: 'z-ai/glm-5.3-flash',
  provider: 'Relace', choices: [{ index: 0, delta, finish_reason: null, native_finish_reason: null }],
  ...extra,
});

const USAGE = {
  prompt_tokens: 23, completion_tokens: 372, total_tokens: 395, cost: 0.000094725,
  completion_tokens_details: { reasoning_tokens: 370 },
};

/** The final chunk as MEASURED: finish_reason AND usage on the same frame. */
const finalChunk = (reason = 'stop') => ({
  id: 'gen-TEST-1', object: 'chat.completion.chunk', created: 1, model: 'z-ai/glm-5.3-flash',
  provider: 'Relace',
  choices: [{ index: 0, delta: { content: '', role: 'assistant' }, finish_reason: reason, native_finish_reason: reason }],
  usage: USAGE,
});

function makeAdapter(fetchImpl, extra = {}) {
  return new OpenRouterAdapter({ apiKey: KEY, fetchImpl, ...extra });
}

/** Capture the request the adapter actually put on the wire. */
function capturing(makeRes) {
  const seen = [];
  const fn = async (url, init) => { seen.push({ url, init, body: JSON.parse(init.body) }); return makeRes(); };
  fn.seen = seen;
  return fn;
}

const ARGS = { model: 'z-ai/glm-5.3-flash', systemPrompt: 'sys', userPrompt: 'hi', maxTokens: 400 };

// ═════════════════════════════════════════════════════════════════════════════
section('§1  THE NON-STREAMING PATH IS UNCHANGED — the property everything else rests on');

{
  const a = makeAdapter(async () => jsonResponse({}));
  const plain = a._buildBody({ ...ARGS, responseFormat: 'text' });
  const explicitFalse = a._buildBody({ ...ARGS, responseFormat: 'text', stream: false });
  const undef = a._buildBody({ ...ARGS, responseFormat: 'text', stream: undefined });
  eq(JSON.stringify(plain), JSON.stringify(explicitFalse),
    'BYTE-IDENTICAL: a body built with no `stream` key serialises exactly as one built with stream:false');
  eq(JSON.stringify(plain), JSON.stringify(undef),
    'BYTE-IDENTICAL: stream:undefined serialises exactly as no `stream` at all');
  ok(!('stream' in plain), 'a non-streaming body carries NO `stream` key (absent, not false)');
  ok(!('stream_options' in plain) && !('stream_options' in a._buildBody({ ...ARGS, stream: true })),
    'NEITHER body sends `stream_options` — deprecated no-op, and usage arrives without it (measured)');

  const streamed = a._buildBody({ ...ARGS, responseFormat: 'json', stream: true });
  eq(streamed.stream, true, 'a streaming body carries stream:true');
  ok(deepEqual(streamed.provider, { allow_fallbacks: false, require_parameters: true }),
    'the provider block SURVIVES on a streaming body — without it OpenRouter substitutes an upstream and silently drops response_format');
  ok(deepEqual(streamed.response_format, { type: 'json_object' }),
    'response_format survives on a streaming body');
  ok(streamed.provider != null && !('data_collection' in streamed.provider),
    'data_collection is NOT sent — it 404s free models, and a 404 walks the fallback chain');
  ok(!('models' in streamed), 'no `models` array — that would enable silent MODEL substitution');
}

{
  // Drive the real non-streaming path end to end and pin the exact result shape.
  const f = capturing(() => jsonResponse({
    id: 'gen-NS', model: 'z-ai/glm-5.3-flash', usage: USAGE,
    choices: [{ index: 0, message: { role: 'assistant', content: 'A wikilink is a link.' }, finish_reason: 'stop' }],
  }));
  const res = await makeAdapter(f).createChatCompletion({ ...ARGS, responseFormat: 'text' });
  ok(!('stream' in f.seen[0].body), 'a call made with no `stream` argument puts NO stream key on the wire');
  eq(res.text, 'A wikilink is a link.', 'non-streaming returns the message content');
  eq(res.model, 'z-ai/glm-5.3-flash', 'non-streaming reports the RESOLVED model from the body');
  eq(res.finishReason, 'stop', 'non-streaming reports finish_reason');
  eq(res.generationId, 'gen-NS', 'non-streaming falls back to body.id for generationId');
  ok(deepEqual(Object.keys(res).sort(),
    ['finishReason', 'generationId', 'model', 'providerName', 'text', 'usage']),
    'the non-streaming result key set is exactly {text, model, finishReason, usage, providerName, generationId}');
}

// ═════════════════════════════════════════════════════════════════════════════
section('§2  A CONTENT-ONLY STREAM — the kimi-k2-0905 shape (zero reasoning tokens)');

{
  const deltas = [];
  const f = capturing(() => sseResponse([
    ': OPENROUTER PROCESSING\n\n',
    frame(chunk({ role: 'assistant', content: 'A ' })),
    frame(chunk({ content: 'wikilink' })),
    frame(chunk({ content: ' is a link.' })),
    frame(finalChunk('stop')),
    'data: [DONE]\n\n',
  ]));
  const res = await makeAdapter(f).createChatCompletion({
    ...ARGS, responseFormat: 'text', stream: true, onDelta: (d) => deltas.push(d),
  });
  eq(f.seen[0].body.stream, true, 'the streaming call actually sent stream:true');
  eq(res.text, 'A wikilink is a link.', 'the accumulated text is the concatenation of the content deltas');
  eq(deltas.length, 3, 'exactly three deltas were emitted — one per NON-EMPTY content chunk');
  ok(deltas.every(d => d.type === 'content'), 'every delta on a content-only stream is type "content"');
  ok(deltas.every(d => typeof d.text === 'string' && d.text.length > 0), 'no empty delta is ever emitted');
  eq(deltas.map(d => d.text).join(''), res.text, 'the deltas the caller saw reconstruct exactly the text that was returned');
  eq(res.finishReason, 'stop', 'finish_reason survives the stream');
  eq(res.model, 'z-ai/glm-5.3-flash', 'the resolved model is read from the chunks');
  eq(res.generationId, 'gen-TEST-1', 'generationId comes from the chunk id');
  ok(deepEqual(res.usage, USAGE), 'usage is captured from the final chunk — the one that ALSO carries finish_reason');
  eq(res.usage && res.usage.cost, 0.000094725, 'the cost figure survives verbatim (it is what a spend line prints)');
}

{
  const deltas = [], warns = [];
  const res = await makeAdapter(async () => sseResponse([
    ': OPENROUTER PROCESSING\n\n', ': OPENROUTER PROCESSING\n\n',
    frame(chunk({ content: 'x' })), frame(finalChunk()), 'data: [DONE]\n\n',
  ]), { onWarn: (m) => warns.push(m) }).createChatCompletion({ ...ARGS, stream: true, onDelta: (d) => deltas.push(d) });
  eq(deltas.length, 1, 'SSE COMMENT keepalives (": OPENROUTER PROCESSING") emit no deltas and are not frames');
  eq(warns.length, 0, 'a keepalive is a COMMENT, not a malformed frame — 6 of them arrived on one measured live call, so mis-parsing them warns once per call forever');
  eq(res.text, 'x', 'the answer is unaffected by keepalives');
}

// ═════════════════════════════════════════════════════════════════════════════
section('§3  REASONING IS SURFACED LIVE AND NEVER ENTERS THE ANSWER');

{
  const deltas = [];
  const res = await makeAdapter(async () => sseResponse([
    frame(chunk({ role: 'assistant', content: '', reasoning: 'The ', reasoning_details: [{ type: 'x' }] })),
    frame(chunk({ content: '', reasoning: 'user asks…', reasoning_details: [{ type: 'x' }] })),
    frame(chunk({ content: 'A wikilink' })),
    frame(chunk({ content: ' is a link.' })),
    frame(finalChunk()),
    'data: [DONE]\n\n',
  ])).createChatCompletion({ ...ARGS, stream: true, onDelta: (d) => deltas.push(d) });

  eq(res.text, 'A wikilink is a link.', 'THE RETURNED TEXT IS CONTENT ONLY — reasoning is never concatenated');
  ok(!res.text.includes('The '), 'no reasoning fragment appears anywhere in the returned text');
  ok(!res.text.includes('user asks'), 'no second reasoning fragment appears in the returned text');
  eq(deltas.filter(d => d.type === 'reasoning').length, 2, 'both reasoning deltas WERE surfaced to the caller');
  eq(deltas.filter(d => d.type === 'content').length, 2, 'both content deltas were surfaced to the caller');
  eq(deltas[0].type, 'reasoning', 'reasoning arrives FIRST — that is the whole point on a reasoning model');
  eq(deltas.map(d => d.type).join(','), 'reasoning,reasoning,content,content',
    'the caller sees the true ordering: reasoning, then content');
}

section('§3b  content:"" ALONGSIDE reasoning — the measured glm-5.3-flash frame shape');

{
  const deltas = [];
  // 110 of 130 live frames carried content,reasoning,reasoning_details,role.
  const many = [];
  for (let i = 0; i < 110; i++) many.push(frame(chunk({ content: '', reasoning: 'r', reasoning_details: [], role: 'assistant' })));
  many.push(frame(chunk({ content: 'answer' })), frame(finalChunk()), 'data: [DONE]\n\n');
  const res = await makeAdapter(async () => sseResponse(many))
    .createChatCompletion({ ...ARGS, stream: true, onDelta: (d) => deltas.push(d) });
  eq(deltas.filter(d => d.type === 'content').length, 1,
    'EXACTLY ONE content delta from 111 frames — the 110 present-but-EMPTY content fields emit nothing');
  // NOTE, recorded rather than implied: the non-empty rule is enforced TWICE —
  // in the frame handler and again in emit(). Removing EITHER alone leaves this
  // assertion green, because the other still holds; only the PAIRED mutation
  // reds it. That is defence in depth, not two guards each independently
  // load-bearing, and it is stated here so nobody reads this assertion as
  // proving more than it does.
  eq(deltas.filter(d => d.type === 'reasoning').length, 110, 'all 110 reasoning deltas were surfaced');
  eq(res.text, 'answer', 'the answer is not polluted by 110 empty-content frames');
}

section('§3c  reasoning_content — the OpenAI-compatible spelling, for a repointed baseUrl');

{
  const deltas = [];
  const res = await makeAdapter(async () => sseResponse([
    frame(chunk({ reasoning_content: 'thinking…' })),
    frame(chunk({ content: 'done' })),
    frame(finalChunk()), 'data: [DONE]\n\n',
  ])).createChatCompletion({ ...ARGS, stream: true, onDelta: (d) => deltas.push(d) });
  eq(deltas.filter(d => d.type === 'reasoning').length, 1, 'delta.reasoning_content is read as reasoning (LM Studio / DeepSeek spelling)');
  eq(res.text, 'done', 'reasoning_content is likewise never concatenated into the answer');
}

// ═════════════════════════════════════════════════════════════════════════════
section('§4  A MALFORMED FRAME IS SKIPPED, NOT FATAL — a stream is a partial result');

{
  const warns = [];
  const deltas = [];
  const res = await makeAdapter(async () => sseResponse([
    frame(chunk({ content: 'before ' })),
    'data: {"choices":[{"delta":{"content":"tru\n\n',      // truncated JSON
    'data: not json at all\n\n',
    frame(chunk({ content: 'after' })),
    frame(finalChunk()), 'data: [DONE]\n\n',
  ]), { onWarn: (m) => warns.push(m) }).createChatCompletion({
    ...ARGS, stream: true, onDelta: (d) => deltas.push(d),
  });
  eq(res.text, 'before after', 'the frames either side of two malformed frames still arrive — nothing is thrown away');
  eq(deltas.length, 2, 'a malformed frame emits no delta');
  eq(res.finishReason, 'stop', 'the stream still completes normally after malformed frames');
  eq(warns.length, 1, 'exactly one warning is raised for the malformed frames, not one per frame');
  ok(/skipped 2 unparseable frames/.test(warns[0]), 'the warning states HOW MANY frames were skipped');
  ok(/incomplete/.test(warns[0]), 'the warning says the answer may be incomplete rather than implying success');
}

{
  // A throwing onWarn must not break the call either — same contract as _warn.
  const res = await makeAdapter(async () => sseResponse([
    'data: {oops\n\n', frame(chunk({ content: 'ok' })), frame(finalChunk()), 'data: [DONE]\n\n',
  ]), { onWarn: () => { throw new Error('boom'); } }).createChatCompletion({ ...ARGS, stream: true });
  eq(res.text, 'ok', 'a THROWING onWarn cannot break a stream that had a malformed frame');
}

// ═════════════════════════════════════════════════════════════════════════════
section('§5  [DONE], TRAILING BYTES AND CHUNK BOUNDARIES');

{
  const deltas = [];
  const res = await makeAdapter(async () => sseResponse([
    frame(chunk({ content: 'a' })),
    'data: [DONE]\n\n',
    frame(chunk({ content: 'SHOULD-NOT-APPEAR' })),
  ])).createChatCompletion({ ...ARGS, stream: true, onDelta: (d) => deltas.push(d) });
  eq(res.text, 'a', 'frames arriving AFTER [DONE] are ignored');
  eq(deltas.length, 1, 'no delta is emitted for a post-[DONE] frame');
}

{
  // One JSON frame split across three network chunks, mid-token — the case a
  // line-buffered parser exists for.
  const whole = frame(chunk({ content: 'split-ok' }));
  const res = await makeAdapter(async () => sseResponse([
    whole.slice(0, 12), whole.slice(12, 30), whole.slice(30),
    frame(finalChunk()), 'data: [DONE]\n\n',
  ])).createChatCompletion({ ...ARGS, stream: true });
  eq(res.text, 'split-ok', 'a frame split across three network chunks is reassembled');
}

{
  const res = await makeAdapter(async () => sseResponse([
    frame(chunk({ content: 'x' })).replace(/\n\n$/, '\r\n\r\n'),
    frame(finalChunk()).replace(/\n\n$/, '\r\n\r\n'),
  ])).createChatCompletion({ ...ARGS, stream: true });
  eq(res.text, 'x', 'CRLF line endings are handled');
}

{
  // Server closes without a trailing newline on the last line.
  const res = await makeAdapter(async () => sseResponse([
    `data: ${JSON.stringify(chunk({ content: 'tail' }))}`,
  ])).createChatCompletion({ ...ARGS, stream: true });
  eq(res.text, 'tail', 'a final line with NO trailing newline is still parsed (decoder flush + tail handling)');
}

{
  // Multi-byte character split across the chunk boundary.
  const bytes = new TextEncoder().encode(frame(chunk({ content: '→ok' })));
  const enc = { ok: true, status: 200, headers: { get: () => null },
    body: (async function* () { yield bytes.slice(0, 40); yield bytes.slice(40); })() };
  const res = await makeAdapter(async () => enc).createChatCompletion({ ...ARGS, stream: true });
  ok(res.text.includes('→ok'), 'a multi-byte UTF-8 character split across network chunks is decoded intact');
}

{
  const res = await makeAdapter(async () => sseResponseReaderOnly([
    frame(chunk({ content: 'reader' })), frame(finalChunk()), 'data: [DONE]\n\n',
  ])).createChatCompletion({ ...ARGS, stream: true });
  eq(res.text, 'reader', 'a body exposing only getReader() (no async iterator) is read correctly');
}

// ═════════════════════════════════════════════════════════════════════════════
section('§6  A FAILED GENERATION MUST THROW — all three 200-with-error shapes');

async function throws(fn, label, check) {
  try { await fn(); ok(false, `${label} — DID NOT THROW`); return null; }
  catch (e) { ok(check ? check(e) : true, label); return e; }
}

await throws(
  () => makeAdapter(async () => sseResponse([
    frame(chunk({ content: 'partial ' })),
    'data: {"error":{"code":502,"message":"upstream died"}}\n\n',
    'data: [DONE]\n\n',
  ])).createChatCompletion({ ...ARGS, stream: true }),
  'a TOP-LEVEL error frame throws rather than returning the partial text',
  (e) => e instanceof OpenRouterError && /in-band failure/.test(e.message) && e.status === 502);

await throws(
  () => makeAdapter(async () => sseResponse([
    frame(chunk({ content: 'partial' })), frame(finalChunk('error')), 'data: [DONE]\n\n',
  ])).createChatCompletion({ ...ARGS, stream: true }),
  'finish_reason "error" throws — a failed generation is never handed back as a truncated answer',
  (e) => e instanceof OpenRouterError);

await throws(
  () => makeAdapter(async () => sseResponse([
    frame(chunk({ content: 'partial' })),
    frame({ id: 'g', model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop', error: { code: 500, message: 'died' } }] }),
    'data: [DONE]\n\n',
  ])).createChatCompletion({ ...ARGS, stream: true }),
  'a choices[0].error riding a BENIGN "stop" still throws — the second measured shape',
  (e) => e instanceof OpenRouterError);

{
  const e = await throws(
    () => makeAdapter(async () => sseResponse([
      `data: {"error":{"code":500,"message":"key ${KEY} leaked"}}\n\n`,
    ])).createChatCompletion({ ...ARGS, stream: true }),
    'an in-band error echoing the API key is redacted',
    () => true);
  ok(e && !e.message.includes(KEY), 'THE LIVE API KEY NEVER SURVIVES INTO A STREAMING ERROR MESSAGE');
  ok(e && !/sk-or-v1-0000/.test(e.message), 'not even a prefix of the key survives');
}

{
  // finish_reason "length" is NOT an error — llm.js routes it to the
  // output-token-limit ladder, and that only works if it reaches llm.js intact.
  const res = await makeAdapter(async () => sseResponse([
    frame(chunk({ content: 'cut off' })), frame(finalChunk('length')), 'data: [DONE]\n\n',
  ])).createChatCompletion({ ...ARGS, stream: true });
  eq(res.finishReason, 'length', 'finish_reason "length" passes through unchanged so llm.js can fire the truncation ladder');
  eq(res.text, 'cut off', 'the partial text is preserved on a length truncation — the ladders need it');
}

section('§6b  A NON-SSE BODY ON A 200 — an error document served to a streaming request');

{
  const e = await throws(
    () => makeAdapter(async () => sseResponse([
      '{"error":{"code":429,"message":"Rate limit exceeded: free-models-per-min."}}',
    ])).createChatCompletion({ ...ARGS, stream: true }),
    'a whole-JSON error body on a 200 (no `data:` prefix at all) throws through the in-band path',
    (e) => e instanceof OpenRouterError && /Rate limit exceeded/.test(e.message));
  ok(e && e.status === 429, 'the provider-supplied code reaches .status so llm.js can classify it');
}

await throws(
  () => makeAdapter(async () => sseResponse(['this is not json and not sse']))
    .createChatCompletion({ ...ARGS, stream: true }),
  'a body that is neither SSE nor JSON is OPENROUTER_BAD_RESPONSE, not a silent empty answer',
  (e) => e instanceof OpenRouterError && e.code === 'OPENROUTER_BAD_RESPONSE');

{
  // ── THE CASE THAT MAKES THE COMMENT-SKIP LOAD-BEARING ────────────────────
  // Keepalives arrive FIRST (measured: 6 of them on one live glm call, sent
  // while OpenRouter routes), and only then does the upstream fail with a
  // whole-JSON body. If ": OPENROUTER PROCESSING" is not recognised as an SSE
  // COMMENT it is captured as part of that body, the JSON stops parsing, and a
  // precise rate-limit error degrades into "non-JSON response body" — the user
  // is told the response was garbage instead of being told they were throttled.
  const e = await throws(
    () => makeAdapter(async () => sseResponse([
      ': OPENROUTER PROCESSING\n\n',
      ': OPENROUTER PROCESSING\n\n',
      '{"error":{"code":429,"message":"Rate limit exceeded: free-models-per-min."}}',
    ])).createChatCompletion({ ...ARGS, stream: true }),
    'keepalives followed by a non-SSE JSON error body still throw',
    () => true);
  ok(e && /Rate limit exceeded/.test(e.message),
    'KEEPALIVES ARE COMMENTS: they do not contaminate the non-SSE error body, so the real upstream reason survives');
  eq(e && e.status, 429, 'and the provider code still reaches .status through the keepalives');
}

await throws(
  () => makeAdapter(async () => ({ ok: true, status: 200, headers: { get: () => null }, body: null }))
    .createChatCompletion({ ...ARGS, stream: true }),
  'a 200 with a null body is OPENROUTER_BAD_RESPONSE',
  (e) => e instanceof OpenRouterError && e.code === 'OPENROUTER_BAD_RESPONSE');

{
  // An HTTP error still arrives as an ordinary JSON body, so _throwForStatus is
  // untouched by streaming. Proven, not assumed.
  const e = await throws(
    () => makeAdapter(async () => jsonResponse({ error: { message: 'nope' } }, { status: 401 }))
      .createChatCompletion({ ...ARGS, stream: true }),
    'an HTTP 401 on a STREAMING request still goes through _throwForStatus',
    (e) => e instanceof OpenRouterError && e.status === 401 && /rejected the API key/.test(e.message));
  ok(e && /HTTP 401/.test(e.message), 'the 401 message shape is unchanged by streaming');
}

// ═════════════════════════════════════════════════════════════════════════════
section('§7  CANCEL — under SSE the body IS the call, so this is the whole guarantee');

{
  const controller = new AbortController();
  const f = async () => sseResponse(
    [frame(chunk({ content: 'a' })), frame(chunk({ content: 'b' })), frame(chunk({ content: 'c' }))],
    { throwAfter: 2, onChunk: (i) => { if (i === 1) controller.abort(); } },
  );
  const e = await throws(
    () => makeAdapter(f).createChatCompletion({ ...ARGS, stream: true, signal: controller.signal }),
    'a mid-body abort throws',
    () => true);
  eq(e && e.name, 'AbortError', 'a mid-body cancel surfaces as an AbortError — the name llm.js isAbortError() tests');
  eq(e && e.curatorAborted, true, 'it also carries curatorAborted, so the duck-typed test matches too');
  ok(e && !(e instanceof OpenRouterError), 'it is NOT an OpenRouterError — an OPENROUTER_NETWORK cancel would be RETRIED');
  ok(e && !/OPENROUTER/.test(String(e.code || '')), 'no OpenRouter error code is attached to a cancel');
}

{
  // THE HARD CASE: the stream throws something with NO abort marker at all,
  // while the caller's signal is aborted. The signal is the discriminator.
  const controller = new AbortController();
  const f = async () => {
    const r = sseResponse([frame(chunk({ content: 'a' })), frame(chunk({ content: 'b' }))],
      { throwAfter: 1, onChunk: (i) => { if (i === 0) controller.abort(); } });
    r.setStreamError(Object.assign(new Error('socket hang up'), { name: 'Error', code: 'ECONNRESET' }));
    return r;
  };
  const e = await throws(
    () => makeAdapter(f).createChatCompletion({ ...ARGS, stream: true, signal: controller.signal }),
    'a cancel that reaches us as a bare socket error still throws',
    () => true);
  eq(e && e.name, 'AbortError',
    'A CANCEL WEARING A NETWORK ERROR IS STILL A CANCEL — the CALLER SIGNAL decides, never the error name');
}

{
  // …and the mirror image: a genuine network drop with NO cancel must NOT be
  // reported as a cancel, or a real transport failure stops being retried.
  const f = async () => {
    const r = sseResponse([frame(chunk({ content: 'a' })), frame(chunk({ content: 'b' }))], { throwAfter: 1 });
    r.setStreamError(Object.assign(new Error('socket hang up'), { name: 'Error' }));
    return r;
  };
  const e = await throws(
    () => makeAdapter(f).createChatCompletion({ ...ARGS, stream: true }),
    'a mid-body network drop with NO cancel throws',
    () => true);
  ok(e instanceof OpenRouterError, 'a genuine mid-body drop stays an OpenRouterError (retryable), not a fake cancel');
  eq(e && e.name !== 'AbortError', true, 'it is NOT reported as an abort');
}

{
  // THE TIMEOUT REACHES THE BODY PHASE AT ALL — the v3.15.0 fix, re-proven for
  // SSE. `timeoutMs` is armed by `linkSignals` and torn down by `link.dispose()`
  // in the outer `finally`; if that finally were ever narrowed back onto the
  // fetch, the link would be disposed before the first chunk and this would
  // hang instead of erroring. The stream throws a NON-abort error here so the
  // classifier reaches its `linkSignal.aborted` arm (see the parity block below
  // for why that matters).
  const f = async () => {
    const r = sseResponse([frame(chunk({ content: 'a' })), frame(chunk({ content: 'b' }))], { throwAfter: 1,
      onChunk: async (i) => { if (i === 0) await new Promise(r2 => setTimeout(r2, 60)); } });
    r.setStreamError(Object.assign(new Error('socket closed'), { name: 'Error' }));
    return r;
  };
  const e = await throws(
    () => makeAdapter(f, { timeoutMs: 20 }).createChatCompletion({ ...ARGS, stream: true }),
    'a body-phase timeout throws');
  ok(e instanceof OpenRouterError && e.code === 'OPENROUTER_NETWORK',
    'a body-phase timeout is OPENROUTER_NETWORK and stays retryable');
  ok(e && /did not finish the body within 20 ms/.test(e.message),
    'the timeout message names the BODY phase — proving timeoutMs is ALIVE AFTER HEADERS under SSE, the v3.15.0 fix');
}

section('§7b  A PRE-EXISTING CLASSIFIER PROPERTY, PINNED AS PARITY RATHER THAN "FIXED"');

{
  // ── FOUND WHILE WRITING THIS SUITE, AND DELIBERATELY NOT CHANGED ──────────
  // `classifyTransportFailure` tests `err.name === 'AbortError'` BEFORE it tests
  // `linkSignal.aborted`. A real fetch/stream abort carries name 'AbortError'
  // WHOEVER aborted it, so a TIMEOUT — where only the link signal fired and the
  // caller never cancelled — is classified as 'cancelled' and surfaces as an
  // AbortError. The "did not finish the body within N ms" message above is
  // therefore reachable only when the stream reports the failure as something
  // other than an abort.
  //
  // Consequence, stated rather than implied away: a body-phase timeout is NOT
  // retried, because llm.js's isAbortError() sees an abort. That may or may not
  // be the behaviour anyone wants — but it is the behaviour that SHIPPED, it
  // lives in a function the non-streaming path shares, and this release's whole
  // property is that non-streaming does not move. So it is pinned as PARITY:
  // both modes must do the same thing. If it is ever changed, it must change
  // for both, and this assertion is where that conversation starts.
  const abortErr = () => Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });

  const nonStreaming = await throws(
    () => makeAdapter(async () => ({
      ok: true, status: 200, headers: { get: () => null },
      json: async () => { await new Promise(r => setTimeout(r, 60)); throw abortErr(); },
    }), { timeoutMs: 20 }).createChatCompletion({ ...ARGS }),
    'the NON-streaming path throws on a timeout whose error is an AbortError');

  const streaming = await throws(
    () => makeAdapter(async () => {
      const r = sseResponse([frame(chunk({ content: 'a' })), frame(chunk({ content: 'b' }))], { throwAfter: 1,
        onChunk: async (i) => { if (i === 0) await new Promise(r2 => setTimeout(r2, 60)); } });
      r.setStreamError(abortErr());
      return r;
    }, { timeoutMs: 20 }).createChatCompletion({ ...ARGS, stream: true }),
    'the STREAMING path throws on a timeout whose error is an AbortError');

  eq(nonStreaming && nonStreaming.name, 'AbortError',
    'PRE-EXISTING: on the non-streaming path an AbortError-shaped timeout is reported as a CANCEL');
  eq(streaming && streaming.name, nonStreaming && nonStreaming.name,
    'PARITY: streaming classifies that identical case identically — streaming did not change the rule');
  eq(streaming && streaming.message, nonStreaming && nonStreaming.message,
    'PARITY: the two modes produce the SAME message for that case, so no new vocabulary was introduced');
}

// ═════════════════════════════════════════════════════════════════════════════
section('§8  THE TWO MODES RETURN THE SAME OBJECT — asserted, not inspected');

{
  const nonStream = await makeAdapter(async () => jsonResponse({
    id: 'gen-TEST-1', model: 'z-ai/glm-5.3-flash', usage: USAGE,
    choices: [{ index: 0, message: { role: 'assistant', content: 'A wikilink is a link.' }, finish_reason: 'stop' }],
  })).createChatCompletion({ ...ARGS });

  const streamed = await makeAdapter(async () => sseResponse([
    ': OPENROUTER PROCESSING\n\n',
    frame(chunk({ role: 'assistant', content: '', reasoning: 'thinking' })),
    frame(chunk({ content: 'A wikilink' })),
    frame(chunk({ content: ' is a link.' })),
    frame(finalChunk('stop')),
    'data: [DONE]\n\n',
  ])).createChatCompletion({ ...ARGS, stream: true });

  ok(deepEqual(Object.keys(nonStream).sort(), Object.keys(streamed).sort()),
    'streaming and non-streaming return the SAME KEY SET');
  ok(deepEqual(nonStream, streamed),
    'STREAMING AND NON-STREAMING RETURN A DEEP-EQUAL OBJECT for the same logical completion — the consumer needs no branch');
  for (const k of Object.keys(nonStream)) {
    eq(typeof streamed[k], typeof nonStream[k], `field "${k}" has the same TYPE in both modes`);
  }
}

{
  // Absent values must be null in both modes, never undefined — llm.js does
  // `res.model || model`, and a missing key that reads as undefined would sail
  // through while a shape change went unnoticed.
  const streamed = await makeAdapter(async () => sseResponse([
    'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
  ])).createChatCompletion({ ...ARGS, stream: true });
  eq(streamed.model, null, 'a stream that never states a model reports model:null (not undefined)');
  eq(streamed.usage, null, 'a stream with no usage frame reports usage:null');
  eq(streamed.finishReason, null, 'a stream with no finish_reason reports finishReason:null');
  eq(streamed.generationId, null, 'a stream with no id reports generationId:null');
  eq(streamed.providerName, null, 'providerName is null when the x-provider-name header is absent — as in production');
  eq(streamed.text, 'x', 'the text still arrives');
}

{
  // providerName must come from the SAME source in both modes. Every streaming
  // chunk carries a top-level `provider` (measured: "Relace", "Novita") and it
  // is deliberately NOT read, because the non-streaming path does not read
  // body.provider either — reading it here would make chat and ingest disagree
  // about the provider for the same model.
  const streamed = await makeAdapter(async () => sseResponse(
    [frame(chunk({ content: 'x' })), frame(finalChunk())],
    { headers: { 'x-provider-name': 'Relace' } },
  )).createChatCompletion({ ...ARGS, stream: true });
  eq(streamed.providerName, 'Relace', 'providerName is read from the HEADER in streaming, exactly as non-streaming does');

  const noHeader = await makeAdapter(async () => sseResponse([frame(chunk({ content: 'x' })), frame(finalChunk())]))
    .createChatCompletion({ ...ARGS, stream: true });
  eq(noHeader.providerName, null,
    'the top-level `provider` field on every chunk is NOT used — doing so would make streaming disagree with non-streaming');
}

// ═════════════════════════════════════════════════════════════════════════════
section('§9  A CALLER CALLBACK CAN NEVER BREAK THE CALL');

{
  let calls = 0;
  const res = await makeAdapter(async () => sseResponse([
    frame(chunk({ content: 'a' })), frame(chunk({ content: 'b' })), frame(finalChunk()), 'data: [DONE]\n\n',
  ])).createChatCompletion({
    ...ARGS, stream: true, onDelta: () => { calls++; throw new Error('consumer exploded'); },
  });
  eq(res.text, 'ab', 'A THROWING onDelta DOES NOT BREAK THE CALL — same contract as _warn and reportUsage');
  eq(calls, 2, 'and it is still called for every delta after it throws');
}

{
  const res = await makeAdapter(async () => sseResponse([
    frame(chunk({ content: 'a' })), frame(finalChunk()), 'data: [DONE]\n\n',
  ])).createChatCompletion({ ...ARGS, stream: true });
  eq(res.text, 'a', 'stream:true with NO onDelta at all works — the callback is optional');
}

{
  const res = await makeAdapter(async () => sseResponse([
    frame(chunk({ content: 'a' })), frame(finalChunk()), 'data: [DONE]\n\n',
  ])).createChatCompletion({ ...ARGS, stream: true, onDelta: 'not a function' });
  eq(res.text, 'a', 'a non-function onDelta is ignored rather than throwing');
}

// ═════════════════════════════════════════════════════════════════════════════
section('§10  DEFENSIVE FRAME SHAPES — a provider is not obliged to be tidy');

{
  const deltas = [];
  const res = await makeAdapter(async () => sseResponse([
    'data: {"choices":[]}\n\n',
    'data: {"choices":null}\n\n',
    'data: {}\n\n',
    'data: null\n\n',
    'data: "a bare string"\n\n',
    'data: {"choices":[{"delta":null}]}\n\n',
    'data: {"choices":[{"delta":{"content":123}}]}\n\n',
    'data: {"choices":[{"delta":{"reasoning":{"nested":"object"}}}]}\n\n',
    frame(chunk({ content: 'survived' })),
    frame(finalChunk()), 'data: [DONE]\n\n',
  ])).createChatCompletion({ ...ARGS, stream: true, onDelta: (d) => deltas.push(d) });
  eq(res.text, 'survived', 'eight malformed-but-parseable frame shapes are stepped over without throwing');
  eq(deltas.length, 1, 'a non-string content and a non-string reasoning emit NO delta');
  ok(deltas.every(d => typeof d.text === 'string'), 'every emitted delta carries a string');
}

// ═════════════════════════════════════════════════════════════════════════════
section('§11  THE STREAMING BRANCH IS ONLY TAKEN WHEN ASKED');

{
  const f = capturing(() => jsonResponse({
    id: 'g', model: 'm', choices: [{ index: 0, message: { content: 'plain' }, finish_reason: 'stop' }],
  }));
  const a = makeAdapter(f);
  await a.createChatCompletion({ ...ARGS });
  await a.createChatCompletion({ ...ARGS, stream: false });
  await a.createChatCompletion({ ...ARGS, stream: 'true' });   // truthy but not === true
  await a.createChatCompletion({ ...ARGS, stream: 1 });
  ok(f.seen.every(s => !('stream' in s.body)),
    'stream is opted into by STRICT true only — a truthy string or 1 does not silently start streaming a JSON parse');
  eq(f.seen.length, 4, 'all four calls went through the non-streaming path');
}

// ═════════════════════════════════════════════════════════════════════════════
console.log(`\n${'─'.repeat(60)}`);
COMPLETED = true;
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All OpenRouter streaming assertions green');
