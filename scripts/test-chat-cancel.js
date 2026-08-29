/**
 * test-chat-cancel.js — OFFLINE suite for chat cancellation.
 *
 * Chat was the last long-running LLM surface in the app with no way to stop it.
 * The abort plumbing has existed in llm.js since v3.4.0 (built for the
 * batch-ingest queue): makeAbortError / isAbortError / normalizeSignal /
 * throwIfAborted / an abortable sleep() / generateText's `opts.signal`. Chat
 * simply never handed it a signal, so a turn that entered the 429 ladder waited
 * out up to three minutes of backoff (parseRetryDelay defaults to 60_000 ms per
 * attempt when the provider sends no hint) and then failed, with no Stop.
 *
 * ── WHAT THIS SUITE DRIVES ──────────────────────────────────────────────────
 * The REAL sendMessage and the REAL express router, against a REAL HTTP server
 * and REAL fetch. The only thing faked is the provider SDK, injected through
 * llm.js's existing `__setAnthropicClientFactory` seam — the same one
 * test-chat-model.js uses. No new production seam was added to sendMessage for
 * testing: v3.13.2 records an agent threading an `opts.generateText` into
 * sendMessage and then DELETING it on finding this seam already existed.
 *
 * That choice is what makes §1 meaningful. The fake is handed the options
 * object callAnthropic passes to `client.messages.stream(body, { signal })`, so
 * "the signal arrived" is observed at the SDK boundary — the far end of the
 * thread — rather than asserted about a line of source. A test that proves a
 * line exists proves nothing about what it renders (v3.0.17).
 *
 * ── THE ASSERTION THAT MATTERS MOST ─────────────────────────────────────────
 * §3/§4: a cancelled turn leaves the conversation file BYTE-IDENTICAL, and a
 * cancelled FIRST turn leaves NO file at all. Asserted on a sha256 of the bytes
 * and on a directory listing, not on the absence of an exception.
 *
 * ── AND THE ONE THAT PROTECTS THE OPPOSITE USER ─────────────────────────────
 * §7: a turn nobody is watching must still be persisted. In the SPA, moving to
 * another conversation or another section does NOT close the HTTP connection,
 * so the turn keeps running and must be on disk when the user comes back. §7
 * issues a real request, drops interest WITHOUT aborting, and asserts the
 * answer reached the file. §6 is its sibling: a NORMAL completion must never
 * abort anything, which is the regression the whole `writableEnded` guard
 * exists to prevent.
 *
 * ── ENFORCED / NOT ENFORCED ─────────────────────────────────────────────────
 * ENFORCED: the signal reaches the SDK; the no-signal path still reaches it
 * with no signal; abort during an in-flight call; abort during the 429 backoff
 * (with an ABSOLUTE time ceiling, never a ratio — v3.8.0 deleted ratio
 * assertions here after they flaked at 73% under load); conversation bytes
 * unchanged on cancel; no file created on a cancelled first turn; a real
 * client disconnect aborts; a real normal completion does not; an unwatched
 * turn persists; ordinary errors still reach the client; assertKnownDomain
 * still runs before any provider call.
 *
 * NOT ENFORCED: the browser half. Whether views/chat.js aborts its fetch on a
 * Stop press and, critically, whether it REFRAINS from aborting on view
 * teardown, is invisible from here — this route treats a closed connection as
 * intent, so the frontend is the sole author of that intent. Also not enforced:
 * that the provider stops billing (an AbortSignal is client-side; llm.js says
 * so itself), and the real network behaviour of a half-open or wedged socket.
 */

import express from 'express';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync,
         existsSync, writeFileSync as writeFile } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { __setAnthropicClientFactory, isAbortError, ABORT_MESSAGE } from '../src/brain/llm.js';
import { __setDomainsDirOverride } from '../src/brain/config.js';
import { sendMessage } from '../src/brain/chat.js';
import chatRouter from '../src/routes/chat.js';

let passed = 0, failed = 0;
function ok(cond, label) {
  // Argument order is (condition, label) — the same as every sibling suite.
  // A reversed signature makes every literal assertion pass unconditionally,
  // which is a failure mode this repo has actually shipped, so §9 runs a
  // positive control proving this helper can still go red.
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function section(t) { console.log(`\n${t}`); }
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

// ── Fixture ────────────────────────────────────────────────────────────────
const DOMAIN = 'zzchatcancel';
const tmpUD  = mkdtempSync(path.join(os.tmpdir(), 'curator-cc-ud-'));
const tmpDom = mkdtempSync(path.join(os.tmpdir(), 'curator-cc-dom-'));
const convDir = path.join(tmpDom, DOMAIN, 'conversations');

// The fake SDK's observation log. `sdkOpts` is the options object
// callAnthropic hands to client.messages.stream(body, { signal }) — the far end
// of the thread this release adds.
let sdkCalls = [];
let behaviour = null; // set per-test

function abortErrLikeUndici() {
  // Shaped like what undici/the SDK actually raises: a raw AbortError with no
  // curatorAborted tag. That is the harder case — it proves llm.js's name-based
  // arm of isAbortError is what catches it, not our own tag.
  const e = new Error('This operation was aborted');
  e.name = 'AbortError';
  return e;
}

function installFakeSdk() {
  __setAnthropicClientFactory(() => ({
    messages: {
      stream: (body, options) => {
        const signal = options && options.signal;
        sdkCalls.push({ model: body.model, sawOptions: options !== undefined,
                        hasSignal: !!signal, abortedAtCall: signal ? signal.aborted : null });
        return {
          finalMessage: () => behaviour(signal),
        };
      },
    },
  }));
}

// Default behaviour: answer immediately, recording whether the signal was
// aborted at the moment we produced the answer.
let lastAbortedAtAnswer = null;
function answerNow(signal) {
  lastAbortedAtAnswer = signal ? signal.aborted : null;
  return Promise.resolve({
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'ANSWER-TOKEN. [source: entities/foo.md]' }],
    usage: { input_tokens: 11, output_tokens: 7 },
  });
}

// The shape of a slow provider call: resolves only when the signal fires.
//
// With NO signal it rejects quickly with a distinctive non-abort error rather
// than hanging. That is deliberate and it is about MUTATION TESTING: if the
// signal thread is removed, this must produce a readable BEHAVIOURAL failure
// ("the error is not a cancellation") instead of a suite that hangs until the
// runner's timeout kills it — a timeout is red for the wrong reason and tells
// you nothing about which guard broke.
function hangUntilAborted(signal) {
  return new Promise((_resolve, reject) => {
    if (signal && signal.aborted) { reject(abortErrLikeUndici()); return; }
    if (!signal) {
      setTimeout(() => reject(new Error('zz-NO-SIGNAL-REACHED-THE-SDK')), 50);
      return;
    }
    signal.addEventListener('abort', () => reject(abortErrLikeUndici()), { once: true });
  });
}

// A 429 with no Retry-After hint. parseRetryDelay then defaults to 60_000 ms,
// so generateText enters an abortable sleep(60000) — the reported symptom.
function throw429() {
  const e = new Error('429 Too Many Requests');
  return Promise.reject(e);
}

function seedDomain() {
  mkdirSync(path.join(tmpDom, DOMAIN, 'wiki', 'entities'), { recursive: true });
  mkdirSync(convDir, { recursive: true });
  writeFile(path.join(tmpDom, DOMAIN, 'CLAUDE.md'), '# zzchatcancel schema\n');
  writeFile(path.join(tmpDom, DOMAIN, 'wiki', 'entities', 'foo.md'),
    '---\ntype: entity\n---\n# Foo\n\n## Key Facts\n- Foo is a thing.\n');
}

const CONV_ID = '11111111-2222-4333-8444-555555555555';
function seedConversation() {
  const conv = {
    id: CONV_ID, title: 'Existing thread', createdAt: '2026-01-01T00:00:00.000Z',
    domain: DOMAIN,
    messages: [
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer', citations: [] },
    ],
  };
  const p = path.join(convDir, `${CONV_ID}.json`);
  writeFile(p, JSON.stringify(conv, null, 2));
  return p;
}
const convPath = () => path.join(convDir, `${CONV_ID}.json`);
const convFiles = () => (existsSync(convDir) ? readdirSync(convDir).filter(f => f.endsWith('.json')) : []);

// ── Deadlines ──────────────────────────────────────────────────────────────
// Every wait in this suite is bounded. Under mutation a broken guard can leave
// the route never answering at all, and an unbounded await turns that into a
// HUNG suite killed by the runner's timeout — red for the wrong reason, and
// silent about which guard broke. These convert a hang into a named assertion.
const DEADLINE_MS = 8000; // ~20x the slowest deliberate delay in this file (350ms)

async function fetchWithDeadline(url, init = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), DEADLINE_MS);
  try {
    const res = await fetch(url, { ...init, signal: ac.signal });
    const body = await res.json();
    return { ok: true, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: {}, timedOut: err && err.name === 'AbortError' };
  } finally { clearTimeout(timer); }
}

// Resolve to a sentinel rather than hang, so "it never escaped" is an assertion.
function withDeadline(promise, ms, sentinel) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(sentinel), ms)),
  ]);
}

// ── Route harness: the REAL router on a minimal app, matching server.js ─────
function startServer() {
  const app = express();
  app.use(express.json({ limit: '50mb' })); // same as src/server.js:73
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

  // ── 1. The signal reaches the provider SDK ────────────────────────────────
  section('1. The signal is threaded all the way to the SDK');
  {
    sdkCalls = []; behaviour = answerNow;
    const ac = new AbortController();
    await sendMessage(DOMAIN, null, 'What is foo?', { signal: ac.signal });
    ok(sdkCalls.length === 1, 'exactly one provider call was made');
    ok(sdkCalls[0].hasSignal === true,
       'the SDK received a signal object — the thread reaches the far end, not just the first line');
    ok(sdkCalls[0].abortedAtCall === false,
       'and it was not already aborted when the call was dispatched');
  }

  // ── 2. The no-signal path is unchanged ────────────────────────────────────
  section('2. A caller that passes no signal is on the pre-cancellation path');
  {
    sdkCalls = []; behaviour = answerNow;
    const r = await sendMessage(DOMAIN, null, 'What is foo?');
    ok(sdkCalls.length === 1, 'one provider call');
    ok(sdkCalls[0].sawOptions === false,
       'the SDK was invoked with NO options argument at all — callAnthropic takes its '
       + 'no-signal branch, so the transport sees byte-identical arguments to before');
    ok(sdkCalls[0].hasSignal === false, 'and therefore no signal');
    ok(typeof r.answer === 'string' && r.answer.includes('ANSWER-TOKEN'),
       'the answer still comes back normally');
    // Explicitly: an EXPLICIT undefined must normalise the same way, because
    // the route always passes the key. (normalizeSignal duck-types.)
    sdkCalls = [];
    await sendMessage(DOMAIN, null, 'What is foo?', { signal: undefined });
    ok(sdkCalls[0].sawOptions === false,
       'an explicit `signal: undefined` normalises to the same no-signal branch');
    // And a non-signal value must not be mistaken for one.
    sdkCalls = [];
    await sendMessage(DOMAIN, null, 'What is foo?', { signal: 'not-a-signal' });
    ok(sdkCalls[0].sawOptions === false,
       'a garbage signal value is refused by normalizeSignal, not passed to the SDK');
  }

  // ── 3. A cancelled turn leaves an EXISTING conversation byte-identical ────
  section('3. Cancel leaves an existing conversation file BYTE-IDENTICAL');
  {
    const p = seedConversation();
    const before = readFileSync(p);
    const beforeSha = sha(before);
    sdkCalls = []; behaviour = hangUntilAborted;

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 40);
    let threw = null;
    // Bounded, like every wait here: if the signal never reaches the SDK this
    // call never settles, and an unbounded await would hang the suite instead
    // of naming the guard that broke.
    const HUNG = Symbol('never-settled');
    const settled3 = await withDeadline(
      sendMessage(DOMAIN, CONV_ID, 'a question that will be cancelled', { signal: ac.signal })
        .then((r) => r, (e) => { threw = e; return e; }),
      8000, HUNG);

    ok(settled3 !== HUNG, 'the cancelled call settled rather than hanging');
    ok(threw !== null, 'the cancelled turn threw rather than returning a result');
    ok(isAbortError(threw), 'and the error is classified as a cancellation');
    ok(threw && threw.message === ABORT_MESSAGE,
       'normalised to llm.js ABORT_MESSAGE, so callers get ONE shape');
    const after = readFileSync(p);
    ok(sha(after) === beforeSha,
       `THE HEADLINE ASSERTION: conversation bytes unchanged (sha ${beforeSha.slice(0, 12)}…)`);
    ok(after.length === before.length, 'byte length unchanged too');
    const parsed = JSON.parse(after.toString('utf8'));
    ok(parsed.messages.length === 2,
       'no half-turn was appended — not even the user message with no answer');
    ok(!after.toString('utf8').includes('cancelled'),
       'the cancelled user message is nowhere in the file');
  }

  // ── 4. A cancelled FIRST turn creates NO file ─────────────────────────────
  section('4. Cancel on a NEW conversation leaves no file behind');
  {
    rmSync(convDir, { recursive: true, force: true });
    mkdirSync(convDir, { recursive: true });
    ok(convFiles().length === 0, 'precondition: the conversations directory is empty');

    sdkCalls = []; behaviour = hangUntilAborted;
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 40);
    let threw = null;
    const HUNG4 = Symbol('never-settled');
    const settled4 = await withDeadline(
      sendMessage(DOMAIN, null, 'first message, cancelled', { signal: ac.signal })
        .then((r) => r, (e) => { threw = e; return e; }),
      8000, HUNG4);
    ok(settled4 !== HUNG4, 'the cancelled first turn settled rather than hanging');
    ok(isAbortError(threw), 'the cancelled first turn threw a cancellation');
    ok(convFiles().length === 0,
       'and NO conversation file was created — a cancelled first turn leaves no trace');
  }

  // ── 5. Cancel escapes the retry backoff, which is the reported symptom ────
  section('5. Cancel escapes the 429 backoff instead of serving it out');
  {
    sdkCalls = []; behaviour = throw429;
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 120);
    const t0 = Date.now();
    let threw = null;
    // Bounded at 10s against a 60s FIRST backoff: if the abortable sleep is
    // lost, this resolves to the sentinel and the assertions below go red in
    // ten seconds with a readable reason, instead of the suite sitting through
    // 3 x 60s of backoff it is supposed to prove we escape.
    const STUCK = Symbol('still-in-backoff');
    const outcome = await withDeadline(
      sendMessage(DOMAIN, null, 'rate limited', { signal: ac.signal })
        .then((r) => r, (e) => { threw = e; return e; }),
      10_000, STUCK);
    const elapsed = Date.now() - t0;

    ok(outcome !== STUCK, 'the call settled instead of sitting out the backoff');
    ok(isAbortError(threw), 'the cancel wins over the 429 classifier and is not retried');
    // ABSOLUTE ceiling, never a ratio. parseRetryDelay finds no hint in
    // "429 Too Many Requests" and returns its 60_000 ms default, so the
    // un-cancellable version of this waits a full minute on the FIRST retry
    // alone. 5s against 60s is a 12x margin — wide enough that it cannot flake
    // on a loaded machine, tight enough that losing the abortable sleep()
    // reds it. (v3.8.0 deleted timing RATIO assertions in this repo after
    // measuring 73% flake under load; absolute ceilings were what survived.)
    ok(elapsed < 5000,
       `and it returned in ${elapsed}ms, not the 60000ms backoff it was sitting in`);
    ok(sdkCalls.length === 1,
       'exactly one provider call was made — the cancel stopped the ladder, it did not walk it');
  }

  // ── 6. A NORMAL completion must never abort ───────────────────────────────
  // This is the regression the whole `writableEnded` guard exists to prevent:
  // res.on('close') fires on a healthy request too (measured, 25/25), so a
  // naive `res.on('close', abort)` would cancel every successful chat turn.
  section('6. ROUTE — a normal completed request aborts nothing');
  {
    rmSync(convDir, { recursive: true, force: true });
    mkdirSync(convDir, { recursive: true });
    sdkCalls = []; lastAbortedAtAnswer = null;
    behaviour = (signal) => new Promise((resolve) => {
      setTimeout(() => resolve(answerNow(signal)), 80);
    });

    const server = await startServer();
    const port = server.address().port;
    const res = await fetchWithDeadline(`http://127.0.0.1:${port}/api/chat/${DOMAIN}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'a normal question' }),
    });
    const body = res.body;
    // Let any post-response close event land before we read the flag.
    await new Promise(r => setTimeout(r, 120));

    ok(res.ok === true, 'the route ANSWERED a normal request (did not hang)');
    ok(res.status === 200, 'the request returned 200');
    ok(typeof body.answer === 'string' && body.answer.includes('ANSWER-TOKEN'),
       'and carried the answer');
    ok(lastAbortedAtAnswer === false,
       'the signal was NOT aborted when the provider answered');
    ok(sdkCalls[0] && sdkCalls[0].abortedAtCall === false,
       'nor when the call was dispatched');
    ok(convFiles().length === 1, 'the conversation was written');
    server.close();
  }

  // ── 7. THE COORDINATOR'S CONSTRAINT: an unwatched turn still persists ─────
  // In the SPA, navigating to another conversation or another section does NOT
  // close the connection — the fetch stays in flight. Simulated faithfully:
  // issue a real request and simply never read it while it runs.
  section('7. ROUTE — a turn nobody is watching still completes AND is persisted');
  {
    rmSync(convDir, { recursive: true, force: true });
    mkdirSync(convDir, { recursive: true });
    sdkCalls = []; lastAbortedAtAnswer = null;
    let answeredAt = 0;
    behaviour = (signal) => new Promise((resolve) => {
      setTimeout(() => { answeredAt = Date.now(); resolve(answerNow(signal)); }, 350);
    });

    const server = await startServer();
    const port = server.address().port;
    // Fire and DO NOT await, DO NOT abort — the reader has walked away.
    const pending = fetch(`http://127.0.0.1:${port}/api/chat/${DOMAIN}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'question asked then abandoned' }),
    });
    let settled = false;
    pending.then(() => { settled = true; }, () => { settled = true; });

    // Wait past the provider answer + the write, without touching the response.
    await new Promise(r => setTimeout(r, 900));

    ok(answeredAt > 0, 'the provider call ran to completion with nobody watching');
    ok(lastAbortedAtAnswer === false,
       'the signal was NEVER aborted — an open-but-idle connection is not a disconnect');
    const files = convFiles();
    ok(files.length === 1, 'the conversation file EXISTS on disk');
    const saved = files.length === 1
      ? JSON.parse(readFileSync(path.join(convDir, files[0]), 'utf8'))
      : { messages: [] };
    ok(saved.messages.length === 2,
       'it holds the full turn: the user message and the assistant answer');
    ok(saved.messages.some(m => m.role === 'assistant' && String(m.content).includes('ANSWER-TOKEN')),
       'THE CONSTRAINT: the answer itself is persisted and will be there on return');
    ok(settled === true, 'and the HTTP response was in fact delivered, not left hanging');

    // Drain so the socket closes cleanly before the next section. Bounded: if
    // the response never comes, `settled` above has already reported it.
    await withDeadline(pending.then((r) => r.json()).catch(() => null), 3000, null);
    server.close();
  }

  // ── 7b. A cancel arriving AFTER the answer must not discard it ────────────
  // The narrow race the persistence rule in chat.js exists for. Made
  // deterministic rather than timed: the fake aborts the signal itself, in the
  // same tick it produces the answer, so by the time sendMessage resumes the
  // signal IS aborted and generateText has ALREADY returned. The money is
  // spent and the answer exists; throwing it away would be a second loss on
  // top of the one the user was trying to avoid.
  section('7b. A cancel landing after the provider answered still persists the turn');
  {
    rmSync(convDir, { recursive: true, force: true });
    mkdirSync(convDir, { recursive: true });
    sdkCalls = [];
    const ac = new AbortController();
    behaviour = (signal) => {
      ac.abort();                      // cancel lands now…
      return answerNow(signal);        // …but the answer is already in hand
    };

    let result = null, threw = null;
    const HUNG7B = Symbol('never-settled');
    const settled7b = await withDeadline(
      sendMessage(DOMAIN, null, 'answered then cancelled', { signal: ac.signal })
        .then((r) => { result = r; return r; }, (e) => { threw = e; return e; }),
      8000, HUNG7B);

    ok(settled7b !== HUNG7B, 'the call settled rather than hanging');
    ok(threw === null, 'sendMessage did not throw — generateText had already returned');
    ok(ac.signal.aborted === true, 'precondition: the signal really was aborted');
    ok(result !== null && String(result.answer).includes('ANSWER-TOKEN'),
       'the answer was returned to the caller');
    const files7b = convFiles();
    ok(files7b.length === 1, 'and the conversation was still WRITTEN');
    const saved7b = files7b.length === 1
      ? JSON.parse(readFileSync(path.join(convDir, files7b[0]), 'utf8'))
      : { messages: [] };
    ok(saved7b.messages.some(m => m.role === 'assistant' && String(m.content).includes('ANSWER-TOKEN')),
       'THE RULE: generateText returned, so the turn persists whatever the signal says');
  }

  // ── 8. A real client disconnect DOES cancel ───────────────────────────────
  section('8. ROUTE — a real client disconnect cancels the in-flight turn');
  {
    rmSync(convDir, { recursive: true, force: true });
    mkdirSync(convDir, { recursive: true });
    sdkCalls = []; lastAbortedAtAnswer = null;
    let sdkSawAbort = false;
    behaviour = (signal) => new Promise((_resolve, reject) => {
      if (!signal) return; // would hang; §1 already proves a signal arrives
      signal.addEventListener('abort', () => {
        sdkSawAbort = true;
        reject(abortErrLikeUndici());
      }, { once: true });
    });

    const server = await startServer();
    const port = server.address().port;
    // A cancel is not an incident. Capture stderr for the whole exchange so
    // "we did not stack-trace the user's Stop" is an ASSERTION rather than an
    // impression from reading the handler — the route has three ways to reach
    // console.error and only one of them may fire here (none).
    const errLines = [];
    const realErr = console.error;
    console.error = (...a) => { errLines.push(a.map(String).join(' ')); };
    const ac = new AbortController();
    let fetchErr = null;
    const p = fetch(`http://127.0.0.1:${port}/api/chat/${DOMAIN}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'question the user stops' }),
      signal: ac.signal,
    }).catch((e) => { fetchErr = e; });
    setTimeout(() => ac.abort(), 120);
    await p;
    await new Promise(r => setTimeout(r, 400));
    console.error = realErr;

    ok(fetchErr !== null && fetchErr.name === 'AbortError',
       'the client fetch aborted');
    ok(errLines.length === 0,
       `a cancel is NOT logged as an unexpected error (stderr lines: ${errLines.length})`);
    ok(sdkSawAbort === true,
       'THE FEATURE: the closed connection propagated all the way to the provider SDK');
    ok(convFiles().length === 0,
       'and nothing was persisted — no half-turn from a cancelled request');
    server.close();
  }

  // ── 8b. A NON-abort failure arriving after the client left ────────────────
  // The case that makes the catch-side clientGone check load-bearing rather
  // than decorative. The provider here IGNORES the signal and fails on its own
  // a moment after the user has gone — so the error is NOT a cancellation and
  // falls past the isAbortError branch. Without the clientGone return it would
  // be stack-traced as an unexpected incident for a request the user
  // deliberately stopped, which is how a log stops being read.
  section('8b. A non-cancel failure after the client left is not logged as an incident');
  {
    rmSync(convDir, { recursive: true, force: true });
    mkdirSync(convDir, { recursive: true });
    sdkCalls = [];
    // Deliberately signal-blind: this models a provider that fails for its own
    // reasons while our cancel is in flight.
    behaviour = () => new Promise((_res, rej) => {
      setTimeout(() => rej(new Error('zz-provider-died-after-user-left')), 250);
    });

    const server = await startServer();
    const port = server.address().port;
    const errLines = [];
    const realErr = console.error;
    console.error = (...a) => { errLines.push(a.map(String).join(' ')); };
    const ac = new AbortController();
    const p8b = fetch(`http://127.0.0.1:${port}/api/chat/${DOMAIN}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'stopped, then the provider died' }),
      signal: ac.signal,
    }).catch(() => {});
    setTimeout(() => ac.abort(), 100);
    await p8b;
    await new Promise(r => setTimeout(r, 600)); // past the 250ms rejection
    console.error = realErr;

    ok(errLines.length === 0,
       `a failure arriving after the client left is not stack-traced (stderr lines: ${errLines.length}`
       + `${errLines.length ? ' — first: ' + errLines[0].slice(0, 60) : ''})`);
    ok(convFiles().length === 0, 'and nothing was persisted');
    server.close();
  }

  // ── 9. Errors still reach the client; the guard swallows only cancels ─────
  section('9. ROUTE — ordinary failures are still reported, and the domain guard still runs first');
  {
    rmSync(convDir, { recursive: true, force: true });
    mkdirSync(convDir, { recursive: true });
    const server = await startServer();
    const port = server.address().port;

    // (a) A genuine provider failure, client still connected. stderr is captured
    // both to assert the log still happens (the pair to §8's "a cancel does
    // not") and to keep an expected stack trace out of this suite's output.
    sdkCalls = [];
    behaviour = () => Promise.reject(new Error('zz-provider-exploded'));
    const errLines = [];
    const realErr = console.error;
    console.error = (...a) => { errLines.push(a.map(String).join(' ')); };
    const r1 = await fetchWithDeadline(`http://127.0.0.1:${port}/api/chat/${DOMAIN}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'boom' }),
    });
    const b1 = r1.body;
    console.error = realErr;
    ok(r1.status === 500, 'a real provider failure is still a 500, not silently swallowed');
    ok(typeof b1.error === 'string' && b1.error.includes('zz-provider-exploded'),
       'and the message still reaches the client');
    ok(errLines.some(l => l.includes('Chat error')),
       'and it IS still logged to stderr — the cancel guard swallows cancels, not failures');

    // (b) The domain guard still runs BEFORE anything reaches the provider.
    sdkCalls = [];
    behaviour = answerNow;
    const r2 = await fetchWithDeadline(`http://127.0.0.1:${port}/api/chat/zz-no-such-domain`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    });
    ok(r2.status === 404, 'an unknown domain is still refused with 404');
    ok(sdkCalls.length === 0,
       'and assertKnownDomain still runs FIRST — no provider call was made');

    // (c) A missing message is still a 400, ahead of everything.
    const r3 = await fetchWithDeadline(`http://127.0.0.1:${port}/api/chat/${DOMAIN}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    ok(r3.status === 400, 'a missing message is still a 400');

    // (d) An AbortError raised by the SDK itself while the client is STILL
    // CONNECTED. Nothing in this route can cause it (the controller is
    // per-request and only the close handler fires it), so it means an SDK
    // internal timeout. The client is still waiting, so it must be answered:
    // returning silently would hang the browser forever.
    sdkCalls = [];
    behaviour = () => Promise.reject(abortErrLikeUndici());
    const errLines2 = [];
    const realErr2 = console.error;
    console.error = (...a) => { errLines2.push(a.map(String).join(' ')); };
    const r4 = await fetchWithDeadline(`http://127.0.0.1:${port}/api/chat/${DOMAIN}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'sdk aborts on its own' }),
    });
    const b4 = r4.body;
    console.error = realErr2;
    ok(r4.status === 500,
       'an SDK-raised abort on a CONNECTED client still gets a response, not a hang');
    ok(typeof b4.error === 'string' && b4.error.length > 0,
       'and it carries a message rather than an empty body');
    ok(errLines2.length === 0,
       'without a stack trace — ABORT_MESSAGE is already a finished sentence');
    server.close();
  }

  // ── 10. Positive control: this harness can actually go red ────────────────
  // Every section above reports green when the feature works, and a suite whose
  // ok() had rotted into always-true would look identical. This drives the REAL
  // ok() — not a copy of it — on a known-false and a known-true condition, and
  // requires the ✗/✓ marker AND the counter to move the right way for each. A
  // REVERSED (label, cond) signature therefore reds this section, which is the
  // exact hazard v3.18.0 records shipping inside the fix for that hazard.
  //
  // ok()'s output is captured rather than printed, because run-tests.js judges
  // a suite failed on any line beginning with "✗" — a control that printed one
  // would fail the whole build to prove it can fail.
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
    const markedFail = lines.some(l => l.includes('\u2717') && l.includes('CONTROL-FALSE'));
    const markedPass = lines.some(l => l.includes('\u2713') && l.includes('CONTROL-TRUE'));
    const countedFail = failed === beforeFailed + 1;
    const countedPass = passed === beforePassed + 1;
    // Absorb the deliberate failure so the control cannot fail the suite.
    failed = beforeFailed; passed = beforePassed;

    ok(markedFail && countedFail,
       'a FALSE condition is marked failed and increments the failure count');
    ok(markedPass && countedPass,
       'a TRUE condition is marked passed and increments the pass count — so a '
       + 'reversed (label, cond) signature would red this section, not pass silently');
    ok(sha(Buffer.from('a')) !== sha(Buffer.from('b')),
       'and the sha256 comparator §3 relies on distinguishes different bytes');
  }
}

// ── Temp-dir cleanup, including on the paths a `finally` never reaches ─────
// v3.9.1 found 37,353 stale temp directories in this repo, from suites whose
// cleanup lived only in a normal exit path. A `finally` around main() does not
// run if the process dies without settling — which is exactly what happened
// while mutation-testing this suite: one mutation left an await unsettled and
// node exited 13 with the fixture still on disk. So cleanup is idempotent and
// ALSO registered on 'exit', where only synchronous work is possible.
//
// The path guard is the v3.9.1 one: refuse to remove anything that is not
// exactly one segment below the OS tempdir.
let cleanedUp = false;
function cleanupTmp() {
  if (cleanedUp) return;
  cleanedUp = true;
  for (const d of [tmpUD, tmpDom]) {
    try {
      if (d && path.dirname(d) === os.tmpdir()) rmSync(d, { recursive: true, force: true });
    } catch { /* best effort — never mask a real failure with a cleanup error */ }
  }
}
process.on('exit', cleanupTmp);
// 'exit' does NOT fire for a signal-terminated process, so the two catchable
// signals are handled explicitly. SIGKILL is deliberately NOT claimed: nothing
// can run on it, and the runner's timeout weapon is SIGKILL — so a suite killed
// by the aggregator's timeout WILL leave its two fixture directories behind.
// Stated rather than implied away.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { cleanupTmp(); process.exit(130); });
}

let exitCode = 0;
try {
  await main();
} catch (err) {
  failed++;
  console.log(`  ✗ SUITE CRASHED: ${err && err.stack ? err.stack : err}`);
} finally {
  __setAnthropicClientFactory(null);
  __setDomainsDirOverride(null);
  delete process.env.CURATOR_TEST_USER_DATA_DIR;
  cleanupTmp();
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); exitCode = 1; }
else { console.log('✅ All chat-cancellation offline assertions green'); }
process.exit(exitCode);
