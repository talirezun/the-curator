/**
 * test-chat-streaming.js — OFFLINE suite for the SERVER half of chat streaming.
 *
 * Chat was a single non-streaming POST: time-to-first-byte EQUALLED total, so a
 * slow model produced minutes of dead air (v3.21.0 made that wait legible; it
 * could not make it shorter). llm.js gained `opts.onDelta` in the wave before
 * this one. This release threads it through sendMessage and gives the route an
 * SSE mode.
 *
 * ── WHAT THIS SUITE DRIVES ──────────────────────────────────────────────────
 * The REAL sendMessage and the REAL express router, over a REAL HTTP server and
 * REAL fetch. The only thing faked is the provider SDK, injected through
 * llm.js's existing `__setAnthropicClientFactory` seam.
 *
 * That seam is used DELIBERATELY IN PREFERENCE TO A FAKE `generateText`. A
 * generateText double would stub out the very module that owns the delta
 * contract — makeDeltaEmitter's empty-delta drop, the commit-at-first-delta
 * marker, handleOutputTokenLimit's return-the-partial behaviour — and would
 * therefore assert only that this file forwards a callback it invented the
 * shape of. It would also mean adding a production seam to sendMessage for a
 * test, which v3.13.2 records an agent doing and then DELETING on finding this
 * seam already existed. Everything below runs the real llm.js.
 *
 * ── THE ASSERTION THAT MATTERS MOST ─────────────────────────────────────────
 * §3: the streamed deltas are a PREVIEW of the return value, not a second
 * result. It is pinned in the one case where the two visibly DIFFER — an answer
 * containing a catalogue-echo blob, where stripCatalogueEcho runs on the return
 * value and never on the deltas. A consumer that appends the return value to
 * its draft both doubles the answer and keeps the un-stripped text. This is the
 * contract generateText's docblock states and, until this suite, nothing
 * enforced anywhere.
 *
 * ── AND THE ONE THAT PROTECTS EVERY EXISTING CALLER ─────────────────────────
 * §1: without `stream: true` this route is byte-for-byte what it was. `/old`
 * (src/public/app.js) POSTs here and reads `await res.json()`, and
 * test-chat-cancel.js does the same across ~40 assertions. §1 checks the
 * response AND the SDK-side request object, so "unchanged" covers the transport
 * and not merely the body.
 *
 * ── ENFORCED / NOT ENFORCED ─────────────────────────────────────────────────
 * ENFORCED: the JSON path is unchanged (body, content-type, and no delta
 * listeners attached); `stream` is honoured only on a strict `=== true`; SSE
 * frame sequence, shape and the bare-`data:` dialect; deltas are a preview of
 * the authoritative return value; reasoning frames appear when the provider
 * sends them and are absent when it does not, and never enter the answer; every
 * validation refusal arrives as a real status code with NO frame; a mid-stream
 * failure arrives as an in-band 200 error frame with absolute paths scrubbed; a
 * mid-stream cancel aborts the provider call; and — the persistence decision —
 * deltas already on screen followed by a throw persist NOTHING.
 *
 * NOT ENFORCED: the browser half (a separate agent owns views/chat.js), so
 * whether the consumer actually REPLACES rather than appends is invisible from
 * here — this suite proves the two strings differ, not what a client does with
 * them. Also not enforced: that `res.end()` is inside a `finally` rather than
 * duplicated at each exit (a structural fact with no observable difference on
 * the paths reachable here), real-network backpressure on a slow reader, and
 * anything about Gemini's or OpenRouter's delta transports — only Anthropic's
 * has a seam in this repo.
 */

import express from 'express';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync,
         existsSync, writeFileSync as writeFile } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { __setAnthropicClientFactory } from '../src/brain/llm.js';
import { __setDomainsDirOverride } from '../src/brain/config.js';
import chatRouter from '../src/routes/chat.js';

let passed = 0, failed = 0;
function ok(cond, label) {
  // Argument order is (condition, label) — the same as every sibling suite. A
  // reversed signature makes every literal assertion pass unconditionally, so
  // §9 runs a positive control proving this helper can still go red.
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function section(t) { console.log(`\n${t}`); }
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const tick = () => new Promise((r) => setTimeout(r, 1));
// Every parse of a response body goes through this. A mutation that makes an
// endpoint answer with the WRONG content type must produce a named assertion,
// not a TypeError that aborts the file and hides every later section.
const safeJson = (t) => { try { return JSON.parse(t); } catch { return null; } };

// ── Fixture ────────────────────────────────────────────────────────────────
const DOMAIN = 'zzchatstream';
const tmpUD  = mkdtempSync(path.join(os.tmpdir(), 'curator-cs-ud-'));
const tmpDom = mkdtempSync(path.join(os.tmpdir(), 'curator-cs-dom-'));
const convDir = path.join(tmpDom, DOMAIN, 'conversations');

// ── The fake SDK ───────────────────────────────────────────────────────────
//
// callAnthropic does `client.messages.stream(body, {signal})`, attaches
// `.on('text')` / `.on('thinking')` ONLY when the caller is streaming, then
// awaits `.finalMessage()`. So `onAttached` below is a direct observation of
// whether llm.js built a delta emitter at all — which is what §1 needs, and is
// strictly stronger than reading the HTTP response, because it sees the
// decision rather than its consequence.
let sdkCalls = [];
let behaviour = null;   // (ctx) => Promise<Message>

function installFakeSdk() {
  __setAnthropicClientFactory(() => ({
    messages: {
      stream: (body, options) => {
        const signal = options && options.signal;
        const listeners = { text: [], thinking: [] };
        const call = { body, signal, onAttached: false, listeners };
        sdkCalls.push(call);
        return {
          on(evt, cb) {
            call.onAttached = true;
            if (!listeners[evt]) listeners[evt] = [];
            listeners[evt].push(cb);
            return this;
          },
          finalMessage: () => behaviour(call),
        };
      },
    },
  }));
}

const fire = (call, evt, text) => (call.listeners[evt] || []).forEach((cb) => cb(text));

function message(text, extra = {}) {
  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text }],
    usage: { input_tokens: 11, output_tokens: 7 },
    ...extra,
  };
}

// Emit `pieces` as text deltas (with a real tick between each, so the route's
// res.write actually reaches the socket in order), then return the assembled
// message. This is the shape a real streaming provider produces.
function streamPieces(pieces, { thinking = [] } = {}) {
  return async (call) => {
    for (const t of thinking) { fire(call, 'thinking', t); await tick(); }
    for (const p of pieces) { fire(call, 'text', p); await tick(); }
    return message(pieces.join(''));
  };
}

// Emit some deltas, THEN fail. The case streaming introduces and the
// persistence rule had never faced: bytes already on the user's screen.
function streamThenThrow(pieces, err) {
  return async (call) => {
    for (const p of pieces) { fire(call, 'text', p); await tick(); }
    throw err;
  };
}

let abortObserved = false;
function streamThenHangUntilAborted(pieces) {
  return async (call) => {
    for (const p of pieces) { fire(call, 'text', p); await tick(); }
    return new Promise((_res, reject) => {
      const boom = () => {
        abortObserved = true;
        const e = new Error('This operation was aborted');
        e.name = 'AbortError';   // raw undici shape, no curatorAborted tag
        reject(e);
      };
      if (!call.signal) {
        // Never hang: a removed signal thread must produce a readable
        // BEHAVIOURAL failure, not a suite killed by the runner's timeout.
        setTimeout(() => reject(new Error('zz-NO-SIGNAL-REACHED-THE-SDK')), 50);
        return;
      }
      if (call.signal.aborted) return boom();
      call.signal.addEventListener('abort', boom, { once: true });
    });
  };
}

function seedDomain() {
  mkdirSync(path.join(tmpDom, DOMAIN, 'wiki', 'entities'), { recursive: true });
  mkdirSync(convDir, { recursive: true });
  writeFile(path.join(tmpDom, DOMAIN, 'CLAUDE.md'), '# zzchatstream schema\n');
  writeFile(path.join(tmpDom, DOMAIN, 'wiki', 'entities', 'foo.md'),
    '---\ntype: entity\n---\n# Foo\n\n## Key Facts\n- Foo is a thing.\n');
}

const CONV_ID = '11111111-2222-4333-8444-555555555555';
function seedConversation() {
  writeFile(path.join(convDir, `${CONV_ID}.json`), JSON.stringify({
    id: CONV_ID, title: 'Existing thread', createdAt: '2026-01-01T00:00:00.000Z',
    domain: DOMAIN,
    messages: [
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer', citations: [] },
    ],
  }, null, 2));
  return path.join(convDir, `${CONV_ID}.json`);
}
const convFiles = () => (existsSync(convDir) ? readdirSync(convDir).filter(f => f.endsWith('.json')) : []);

// ── Deadlines ──────────────────────────────────────────────────────────────
// Under mutation a broken guard can leave the route never answering. An
// unbounded await turns that into a HUNG suite killed by the runner — red for
// the wrong reason and silent about which guard broke. These convert a hang
// into a named assertion.
const DEADLINE_MS = 8000;

// Parse an SSE body written in the ingest/compile dialect: a bare `data:` line
// carrying a JSON payload with its own `type` key, frames separated by a blank
// line. Returns BOTH the parsed frames and the raw text, because "there are no
// `event:` lines" is an assertion about the raw bytes.
function parseFrames(raw) {
  const frames = [];
  for (const block of raw.split('\n\n')) {
    const line = block.split('\n').find((l) => l.startsWith('data: '));
    if (!line) continue;
    try { frames.push(JSON.parse(line.slice(6))); } catch { frames.push({ type: '__unparseable__', raw: line }); }
  }
  return frames;
}

async function post(url, body, init = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), DEADLINE_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
      ...init,
    });
    const text = await res.text();
    return { status: res.status, ctype: res.headers.get('content-type') || '', text };
  } catch (err) {
    return { status: 0, ctype: '', text: '', failed: true, name: err && err.name };
  } finally { clearTimeout(timer); }
}

function withDeadline(promise, ms, sentinel) {
  return Promise.race([promise, new Promise((r) => setTimeout(() => r(sentinel), ms))]);
}

function startServer() {
  const app = express();
  app.use(express.json({ limit: '50mb' })); // same as src/server.js
  app.use('/api/chat', chatRouter);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  // No ambient keys: the fixture config must be the ONLY key source, or a
  // developer's real .env would decide which provider answers and the fake
  // transport would never be reached.
  delete process.env.LLM_MODEL;
  delete process.env.GEMINI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  process.env.CURATOR_TEST_USER_DATA_DIR = tmpUD;
  writeFile(path.join(tmpUD, '.curator-config.json'), JSON.stringify({
    anthropicApiKey: 'zz-fake-anthropic-key-for-tests',
    activeProvider: 'anthropic',
  }) + '\n');
  __setDomainsDirOverride(tmpDom);
  seedDomain();
  installFakeSdk();

  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}/api/chat/${DOMAIN}`;

  // ── 1. The non-streaming path is UNCHANGED ────────────────────────────────
  section('1. Without `stream: true` the route answers exactly as it always has');
  {
    sdkCalls = []; behaviour = streamPieces(['Hello ', 'world.']);
    const r = await post(base, { message: 'What is foo?' });
    ok(r.status === 200, 'a plain POST still returns 200');
    ok(r.ctype.includes('application/json'), `content-type is still JSON (got "${r.ctype}")`);
    let body = null;
    try { body = JSON.parse(r.text); } catch { /* leave null */ }
    ok(body !== null, 'the body still parses as a single JSON object — what /old and test-chat-cancel.js read');
    ok(body && body.answer === 'Hello world.', 'the answer is the full assembled text');
    ok(body && typeof body.conversationId === 'string', 'the result still carries conversationId');
    ok(!r.text.startsWith('data: '), 'the body is NOT an SSE frame');
    ok(sdkCalls.length === 1, 'exactly one provider call was made');
    ok(sdkCalls[0].onAttached === false,
       'NO delta listeners were attached to the SDK stream — llm.js built no emitter, so the transport is untouched');
  }
  {
    // The strictness matters: anything ambiguous must land on the SAFE default,
    // never flip the content type out from under a caller who did not ask.
    for (const [label, value] of [['the string "true"', 'true'], ['the number 1', 1], ['an object', {}]]) {
      sdkCalls = []; behaviour = streamPieces(['x']);
      const r = await post(base, { message: 'What is foo?', stream: value });
      ok(r.ctype.includes('application/json'), `${label} does NOT stream — a truthy value is not \`=== true\``);
      ok(sdkCalls.length === 1 && sdkCalls[0].onAttached === false,
         `${label} attaches no delta listeners either`);
    }
  }
  {
    // "Unchanged" has to cover the REQUEST, not just the response. Same body to
    // the SDK on both paths means streaming altered nothing the model sees.
    sdkCalls = []; behaviour = streamPieces(['same']);
    await post(base, { message: 'identical question' });
    const plain = sdkCalls[0].body;
    sdkCalls = []; behaviour = streamPieces(['same']);
    await post(base, { message: 'identical question', stream: true });
    const streamed = sdkCalls[0].body;
    ok(JSON.stringify(plain) === JSON.stringify(streamed),
       'the request body handed to the SDK is byte-identical with and without streaming');
    ok(plain.model === streamed.model && plain.max_tokens === streamed.max_tokens,
       'same model and same max_tokens on both paths');
  }

  // ── 2. The SSE frame sequence and dialect ────────────────────────────────
  section('2. With `stream: true` the route speaks SSE, in this app\'s bare-`data:` dialect');
  {
    sdkCalls = []; behaviour = streamPieces(['The ', 'quick ', 'brown fox.']);
    const r = await post(base, { message: 'What is foo?', stream: true });
    ok(r.status === 200, 'streaming responds 200');
    ok(r.ctype.includes('text/event-stream'), `content-type is text/event-stream (got "${r.ctype}")`);
    ok(sdkCalls.length === 1 && sdkCalls[0].onAttached === true,
       'delta listeners WERE attached to the SDK stream');

    // Deliberately NO `event:` lines. This app carries two SSE dialects;
    // routes/health.js and routes/config.js write `event: <type>`, while
    // ingest/compile/ingest-queue/sharedbrain write a bare `data:` with a
    // `type` key. Chat's sibling is compile. Mixing them makes an `onmessage`
    // handler silently receive nothing.
    ok(!/^event:/m.test(r.text), 'the raw body contains NO `event:` lines — it follows compile, not health');
    ok(r.text.includes('data: '), 'frames are written as `data: <json>`');
    ok(r.text.endsWith('\n\n'), 'the last frame is terminated with a blank line');

    const frames = parseFrames(r.text);
    ok(frames.every((f) => f.type !== '__unparseable__'), 'every frame parses as JSON');
    const content = frames.filter((f) => f.type === 'content');
    ok(content.length === 3, `three content frames arrived (got ${content.length})`);
    ok(content.length > 0 && content.map((f) => f.text).join('') === 'The quick brown fox.',
       'the content frames, concatenated in arrival order, are the answer');
    ok(frames.length > 0 && frames[frames.length - 1].type === 'done', 'the LAST frame is `done`');
    ok(frames.filter((f) => f.type === 'done').length === 1, 'exactly one `done` frame');
    ok(frames.indexOf(frames.find((f) => f.type === 'done')) === frames.length - 1 &&
       content.every((f) => frames.indexOf(f) < frames.length - 1),
       'every content frame arrived BEFORE `done`');
    ok(frames.every((f) => f.type === 'content' || f.type === 'reasoning' || f.type === 'done' || f.type === 'error'),
       'no frame carries a type outside the documented contract');
    ok(content.every((f) => typeof f.text === 'string' && f.text.length > 0),
       'no empty delta reached the wire — llm.js drops those, and that drop is what keeps the retry ladder armed');
    ok(content.every((f) => Object.keys(f).sort().join(',') === 'text,type'),
       'a delta frame carries exactly {type, text} and nothing else');
  }

  // ── 3. Deltas are a PREVIEW of the return value, never a second result ────
  section('3. The return value is authoritative; the deltas are a preview of it');
  {
    sdkCalls = []; behaviour = streamPieces(['alpha ', 'beta ', 'gamma']);
    const r = await post(base, { message: 'What is foo?', stream: true });
    const frames = parseFrames(r.text);
    const drafted = frames.filter((f) => f.type === 'content').map((f) => f.text).join('');
    const done = frames.find((f) => f.type === 'done');
    ok(done && done.answer === 'alpha beta gamma', 'the `done` frame carries the complete answer');
    // GUARDED. An unguarded `done.answer` when a mutation removes the done
    // frame throws a TypeError that aborts the whole file and HIDES every
    // later assertion — the v3.12.0 shape, and it happened here under M6
    // before this guard existed.
    ok(!!done && drafted === done.answer,
       'on a clean answer the draft EQUALS the authoritative answer — replacing is a no-op, appending would double it');
  }
  {
    // The case where they visibly DIFFER, which is what makes "replace, never
    // append" a correctness rule rather than a style note. stripCatalogueEcho
    // runs ONCE, on the whole answer, AFTER the call returns — it cannot be
    // made incremental, so the deltas are necessarily pre-strip.
    const echo = 'Here you go. summaries/a.md concepts/b.md entities/c.md concepts/d.md entities/e.md';
    sdkCalls = []; behaviour = streamPieces([echo]);
    const r = await post(base, { message: 'list everything', stream: true });
    const frames = parseFrames(r.text);
    const drafted = frames.filter((f) => f.type === 'content').map((f) => f.text).join('');
    const done = frames.find((f) => f.type === 'done');
    ok(drafted === echo, 'the streamed draft carries the raw, UN-stripped catalogue-echo blob');
    ok(done && done.answer !== drafted,
       'the authoritative answer DIFFERS from the draft — stripCatalogueEcho ran on the return value only');
    ok(done && !/entities\/e\.md/.test(done.answer),
       'the catalogue-echo run is absent from the authoritative answer');
    ok(done && done.answer.startsWith('Here you go.'),
       'the prose around the stripped run survives');
    // If a consumer appended instead of replacing it would end up with the
    // stripped text glued onto the unstripped draft — the exact doubling the
    // contract exists to prevent. Stated as a fact about these two strings.
    ok((drafted + (done ? done.answer : '')).length > (done ? done.answer.length : 0),
       'appending would produce a longer string than the answer — i.e. a visibly doubled turn');
  }
  {
    // Citations are extracted from the CLEANED answer, once, at the end — the
    // other thing that cannot be made incremental.
    sdkCalls = []; behaviour = streamPieces(['See ', '[source: entities/foo.md]', ' for more.']);
    const r = await post(base, { message: 'cite something', stream: true });
    const done = parseFrames(r.text).find((f) => f.type === 'done');
    ok(done && Array.isArray(done.citations) && done.citations.length === 1,
       'citations were extracted for the streamed turn');
    ok(done && done.citations[0] === 'entities/foo.md', 'and they name the cited page');
  }

  // ── 4. Reasoning frames ──────────────────────────────────────────────────
  section('4. Reasoning is surfaced live when the provider sends it, and never enters the answer');
  {
    sdkCalls = []; behaviour = streamPieces(['The answer.'], { thinking: ['Let me ', 'think.'] });
    const r = await post(base, { message: 'What is foo?', stream: true });
    const frames = parseFrames(r.text);
    const reasoning = frames.filter((f) => f.type === 'reasoning');
    ok(reasoning.length === 2, `two reasoning frames arrived (got ${reasoning.length})`);
    ok(reasoning.map((f) => f.text).join('') === 'Let me think.', 'they carry the scratchpad text');
    const done = frames.find((f) => f.type === 'done');
    ok(done && done.answer === 'The answer.',
       'the answer contains ONLY content — splicing deliberation into it would write a model\'s scratchpad into a wiki page');
    ok(reasoning.length > 0 && frames.indexOf(reasoning[0]) < frames.findIndex((f) => f.type === 'content'),
       'reasoning arrived before the first content frame — which is the dead air it exists to fill');
  }
  {
    // MEASURED UPSTREAM, and the honest half of the feature: Anthropic returns
    // deliberation ENCRYPTED (`delta.thinking` empty, signature only) and the
    // pinned Gemini SDK cannot do it at all, so reasoning is OpenRouter-only in
    // practice today. Nothing here may assume a reasoning frame ever arrives.
    sdkCalls = []; behaviour = streamPieces(['Just content.']);
    const r = await post(base, { message: 'What is foo?', stream: true });
    const frames = parseFrames(r.text);
    ok(frames.filter((f) => f.type === 'reasoning').length === 0,
       'a provider that sends no reasoning produces ZERO reasoning frames — the turn is still complete');
    ok(frames.length > 0 && frames[frames.length - 1].type === 'done', 'and still terminates with `done`');
  }
  {
    // The empty-thinking shape Anthropic actually produces. It must reach the
    // wire as nothing at all: an empty delta shows the user nothing AND commits
    // the attempt, disabling the retry ladder for zero benefit.
    sdkCalls = []; behaviour = streamPieces(['Content.'], { thinking: ['', ''] });
    const r = await post(base, { message: 'What is foo?', stream: true });
    const frames = parseFrames(r.text);
    ok(frames.filter((f) => f.type === 'reasoning').length === 0,
       'empty thinking deltas (Anthropic\'s real shape) produce no frames at all');
  }

  // ── 5. Every refusal happens BEFORE the headers go out ───────────────────
  section('5. Validation refusals arrive as real status codes, never as frames');
  {
    sdkCalls = [];
    const r = await post(base, { stream: true });   // no message
    ok(r.status === 400, `a missing message is still a 400 under stream:true (got ${r.status})`);
    ok(r.ctype.includes('application/json'), 'and it is JSON, not an event stream');
    ok(!r.text.includes('data: '), 'no SSE frame was written');
    ok(safeJson(r.text) && safeJson(r.text).error === 'message is required', 'the error body is unchanged');
    ok(sdkCalls.length === 0, 'no provider call was made');
  }
  {
    sdkCalls = [];
    const url = `http://127.0.0.1:${server.address().port}/api/chat/zz-no-such-domain`;
    const r = await post(url, { message: 'hi', stream: true });
    ok(r.status === 404, `an unknown domain is still a 404 under stream:true (got ${r.status})`);
    ok(r.ctype.includes('application/json'), 'and it is JSON, not an event stream');
    ok(!r.text.includes('data: '), 'no SSE frame was written');
    ok(sdkCalls.length === 0, 'assertKnownDomain still runs before any provider call');
  }

  // ── 6. A mid-stream failure is an in-band frame, and it is SCRUBBED ──────
  section('6. After the headers are out, every failure is a 200 + an in-band error frame');
  {
    const leaky = new Error("ENOENT: no such file or directory, open '/Users/alice smith/Google Drive/wiki/log.md'");
    sdkCalls = []; behaviour = streamThenThrow(['partial ', 'text '], leaky);
    const r = await post(base, { message: 'What is foo?', stream: true });
    ok(r.status === 200, 'the response is 200 — there is no status code left to send after flushHeaders()');
    ok(r.ctype.includes('text/event-stream'), 'and it is still an event stream');
    const frames = parseFrames(r.text);
    const err = frames.find((f) => f.type === 'error');
    ok(!!err, 'an `error` frame was emitted');
    ok(!!err && typeof err.message === 'string' && err.message.length > 0, 'it carries a message');
    ok(!frames.some((f) => f.type === 'done'), 'and NO `done` frame — a failed turn never reports success');
    ok(frames.filter((f) => f.type === 'content').length === 2,
       'the deltas that had already been sent are still on the wire');

    // The divergence from ingest/compile, which both emit a raw err.message.
    ok(!!err && !err.message.includes('/Users/alice smith'),
       'the absolute path is SCRUBBED out of the frame — the user\'s home directory does not reach the wire');
    ok(!!err && !err.message.includes('Google Drive'),
       'and neither does their cloud-storage layout — the space-bridged half scrubPaths exists for');
    ok(!!err && err.message.includes('log.md'), 'the basename survives, which is the half that helps');
  }
  {
    // The same failure on the JSON path must still be a 500 with a JSON body —
    // one policy, two surfaces, which is why errorText is shared.
    const leaky = new Error("ENOENT: no such file or directory, open '/Users/alice smith/Google Drive/wiki/log.md'");
    sdkCalls = []; behaviour = streamThenThrow([], leaky);
    const r = await post(base, { message: 'What is foo?' });
    ok(r.status === 500, 'the non-streaming path still returns 500 for the same failure');
    const body = safeJson(r.text) || {};
    ok(typeof body.error === 'string' && !body.error.includes('/Users/alice smith') && body.error.includes('log.md'),
       'and its body is scrubbed identically — the two surfaces share one disclosure policy');
  }

  // ── 7. The `done` frame is the whole result, un-enumerated ───────────────
  section('7. The `done` frame carries the full sendMessage result');
  {
    sdkCalls = []; behaviour = streamPieces(['Answer.']);
    const streamed = await post(base, { message: 'a fixed question', stream: true });
    const done = parseFrames(streamed.text).find((f) => f.type === 'done');

    sdkCalls = []; behaviour = streamPieces(['Answer.']);
    const plain = JSON.parse((await post(base, { message: 'a fixed question' })).text);

    ok(!!done, 'a done frame was emitted at all — every assertion below dereferences it');
    const doneKeys = Object.keys(done || {}).filter((k) => k !== 'type').sort();
    const plainKeys = Object.keys(plain).sort();
    ok(doneKeys.join(',') === plainKeys.join(','),
       `the done frame's fields are exactly the JSON result's fields (done: ${doneKeys.join(',')})`);
    ok(!plainKeys.includes('type'),
       'the result carries no field named `type` — one would clobber the frame\'s own discriminator and hang the consumer');
    ok(!!done && done.usage && done.usage.inputTokens === 11 && done.usage.outputTokens === 7,
       'usage reached the frame — the field that would otherwise have been the next dead-data field');
    ok(!!done && typeof done.model === 'string' && done.model.length > 0,
       'the model that ANSWERED reached the frame');
    ok(!!done && done.responseStyle === plain.responseStyle && done.isNew === plain.isNew,
       'the remaining scalar fields agree between the two surfaces');
  }

  // ── 8. Cancellation still works under SSE ────────────────────────────────
  section('8. A mid-stream cancel still aborts the provider call');
  {
    const convPath = seedConversation();
    const before = sha(readFileSync(convPath));
    sdkCalls = []; abortObserved = false;
    behaviour = streamThenHangUntilAborted(['visible ', 'text ']);

    // Read until the first content frame has genuinely arrived, THEN abort —
    // so this exercises "the user pressed Stop after seeing text", which is the
    // case streaming introduces.
    const ac = new AbortController();
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'What is foo?', conversationId: CONV_ID, stream: true }),
      signal: ac.signal,
    });
    ok(res.status === 200 && (res.headers.get('content-type') || '').includes('text/event-stream'),
       'the stream opened');

    // BOUNDED, and the bound is not decoration. Under a mutation that stops
    // deltas being emitted at all, an unbounded `reader.read()` never resolves
    // and this suite HANGS until the runner's 2-minute timeout kills it — red
    // for the wrong reason and silent about which guard broke. Measured: the
    // first draft of this loop did exactly that under M1.
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let seen = '';
    const readDeadline = Date.now() + DEADLINE_MS;
    while (!seen.includes('"type":"content"') && Date.now() < readDeadline) {
      const chunk = await withDeadline(reader.read(), 500, { value: undefined, done: false });
      if (chunk.done) break;
      if (chunk.value) seen += dec.decode(chunk.value, { stream: true });
    }
    ok(seen.includes('"type":"content"'), 'a content frame reached the client before the cancel');
    ac.abort();
    try { await reader.cancel(); } catch { /* already aborted */ }

    const observed = await withDeadline(
      (async () => { while (!abortObserved) await tick(); return 'aborted'; })(),
      DEADLINE_MS, 'NEVER-ABORTED');
    ok(observed === 'aborted',
       'the disconnect reached the provider call and aborted it — `writableEnded` still discriminates under SSE');

    await new Promise((r) => setTimeout(r, 60)); // let the handler settle
    ok(sha(readFileSync(convPath)) === before,
       'the conversation file is BYTE-IDENTICAL — a cancelled streaming turn persists nothing');
  }

  // ── 9. THE PERSISTENCE DECISION ──────────────────────────────────────────
  section('9. Deltas already on screen + a throw ⇒ NOTHING is persisted');
  {
    // The rule streaming did not change: threw ⇒ nothing persisted. The
    // accumulated deltas have not been through stripCatalogueEcho and no
    // citation has been extracted from them, so persisting them would put a
    // message shaped unlike every other message into the history that seeds
    // the NEXT prompt.
    const convPath = seedConversation();
    const before = sha(readFileSync(convPath));
    sdkCalls = [];
    behaviour = streamThenThrow(['half an ', 'answer'], new Error('zz-provider-died-midstream'));
    const r = await post(base, { message: 'What is foo?', conversationId: CONV_ID, stream: true });
    const frames = parseFrames(r.text);
    ok(frames.filter((f) => f.type === 'content').length === 2,
       'two deltas were genuinely delivered to the client first — this is the new case, not the old one');
    ok(frames.some((f) => f.type === 'error'), 'and the turn ended in an error frame');
    ok(sha(readFileSync(convPath)) === before,
       'the conversation file is BYTE-IDENTICAL — the streamed partial was NOT saved');
    const conv = JSON.parse(readFileSync(convPath, 'utf8'));
    ok(conv.messages.length === 2, 'the history still holds exactly the two pre-existing messages');
    ok(!JSON.stringify(conv).includes('half an'),
       'no fragment of the streamed draft is anywhere in the file');
  }
  {
    // The first-turn shape: a throw after deltas must leave NO file, exactly as
    // a throw before deltas does.
    for (const f of convFiles()) rmSync(path.join(convDir, f));
    sdkCalls = [];
    behaviour = streamThenThrow(['orphan text'], new Error('zz-provider-died-midstream'));
    await post(base, { message: 'brand new thread', stream: true });
    ok(convFiles().length === 0,
       'a cancelled/failed FIRST streaming turn creates no conversation file at all');
  }
  {
    // The counterpart, so §9 is not just "nothing ever persists": a turn that
    // RETURNS is persisted, streaming or not — including the truncation case,
    // which returns (partial + note) rather than throwing and therefore lands
    // on disk through the ordinary path.
    for (const f of convFiles()) rmSync(path.join(convDir, f));
    sdkCalls = []; behaviour = streamPieces(['A complete ', 'streamed answer.']);
    const r = await post(base, { message: 'a real question', stream: true });
    const done = parseFrames(r.text).find((f) => f.type === 'done');
    ok(convFiles().length === 1, 'a SUCCESSFUL streaming turn does persist');
    const conv = JSON.parse(readFileSync(path.join(convDir, convFiles()[0]), 'utf8'));
    ok(conv.messages.length === 2 && conv.messages[1].content === 'A complete streamed answer.',
       'and it persists the AUTHORITATIVE answer, assembled once, not the delta fragments');
    ok(done && done.conversationId === conv.id, 'the done frame names the conversation that was written');
  }

  // ── 10. Positive control ─────────────────────────────────────────────────
  // ok()'s output is CAPTURED rather than printed, because run-tests.js judges a
  // suite failed on any line beginning with "✗" — a control that printed one
  // would fail the whole build to prove it can fail. (Measured: it does. The
  // first draft of this section exited 0 and the runner still reported the
  // suite as failed, which is the v3.3.0 output-scan shape.)
  section('10. Positive control — ok() still detects a false condition');
  {
    const beforeFailed = failed, beforePassed = passed;
    const lines = [];
    const realLog = console.log;
    console.log = (...a) => { lines.push(a.map(String).join(' ')); };
    try {
      ok(1 === 2, 'CONTROL-FALSE');
      ok(1 === 1, 'CONTROL-TRUE');
    } finally { console.log = realLog; }
    const markedFail = lines.some((l) => l.includes('✗') && l.includes('CONTROL-FALSE'));
    const markedPass = lines.some((l) => l.includes('✓') && l.includes('CONTROL-TRUE'));
    const countedFail = failed === beforeFailed + 1;
    const countedPass = passed === beforePassed + 1;
    // Absorb the deliberate failure so the control cannot fail the suite.
    failed = beforeFailed; passed = beforePassed;

    ok(markedFail && countedFail, 'a FALSE condition is marked failed and increments the failure count');
    ok(markedPass && countedPass,
       'a TRUE condition is marked passed and increments the pass count — so a reversed (label, cond) signature would red this section, not pass silently');
    ok(sha(Buffer.from('a')) !== sha(Buffer.from('b')),
       'and the sha256 comparator §8/§9 rely on distinguishes different bytes');
  }

  server.close();
}

main()
  .catch((err) => { console.error(err); failed++; })
  .finally(() => {
    try { rmSync(tmpUD, { recursive: true, force: true }); } catch { /* best effort */ }
    try { rmSync(tmpDom, { recursive: true, force: true }); } catch { /* best effort */ }
    console.log('\n────────────────────────────────────────────────────────────');
    console.log(`Passed: ${passed}   Failed: ${failed}`);
    if (failed === 0) console.log('✅ All chat-streaming offline assertions green');
    else console.log('❌ Some chat-streaming assertions FAILED');
    process.exit(failed === 0 ? 0 : 1);
  });
