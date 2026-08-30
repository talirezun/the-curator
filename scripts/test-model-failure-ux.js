#!/usr/bin/env node
/**
 * MODEL-FAILURE UX — offline guards for what a user sees when a model fails.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE REPORT. A free OpenRouter model was picked in chat, the turn was waited
 * out, and the answer that arrived was a full-width wall of red text:
 *   "if the models fail it is not app's fault, just app needs to handle it
 *    correctly and not just fail silently... The worst way is the user now
 *    waits for an answer and then it gets a screen with a big error."
 *
 * FIVE DEFECTS SIT UNDER THAT REPORT, and this suite guards each one:
 *
 *   1. INGEST VOCABULARY IN A SHARED CHOKEPOINT. `buildRateLimitMessage` told a
 *      user who had run ONE chat turn that "a bulk operation such as a large
 *      ingest can reach them even on a paid plan". Exactly the class v3.0.7
 *      fixed for the output-token guard — a message rendered by every caller
 *      must be context-neutral — with the 429 path missed.
 *
 *   2. THE LADDER WAS INVISIBLE ON THE ONE PATH THAT WAITS LONGEST. The 503
 *      message says it already retried; the 429 message said nothing, so the
 *      user was never told the wait was not idle.
 *
 *   3. THE TWO MESSAGES COUNTED THE SAME LADDER DIFFERENTLY. 503 said "4
 *      times" as a hand-typed literal; there are 4 ATTEMPTS and 3 RETRIES.
 *      Both now derive from `MAX_RETRIES`, which is why §2 pins the number.
 *
 *   4. A STRUCTURED Retry-After WITH ZERO CONSUMERS — the real correctness
 *      bug, and the biggest one. `openrouter-adapter.js` reads the upstream's
 *      `Retry-After` header and sets `err.retryAfterSeconds`. `parseRetryDelay`
 *      read only Gemini's two MESSAGE forms, so an OpenRouter 429 fell to the
 *      60 s default — three times over. §4's positive control MEASURES that the
 *      OpenRouter message alone really is unrecognised, so the finding is
 *      evidenced rather than asserted.
 *
 *   5. THE PRESENTATION. ~450 characters of provider prose in `--danger-text`
 *      at 14.5px answer size, full bleed, with no way forward.
 *
 * EVERYTHING HERE DRIVES THE REAL CODE. The messages are the shipped builders;
 * the delay resolution is the shipped `parseRetryDelay`; the failure markup is
 * produced by executing the shipped `renderThreadOnly` against a fake document.
 * A guard that exercises a paraphrase of the call site is the decorative shape
 * this repo has now recorded several times.
 *
 * ── NOT ENFORCED, stated rather than implied away ──────────────────────────
 *   - No LIVE 429 is provoked from any provider (that would cost real money and
 *     require deliberately abusing an account), so the OpenRouter header→delay
 *     path is proven from the adapter's own producer line and from the shipped
 *     consumer, NOT from a captured wire response.
 *   - Anthropic's SDK is NOT proven to populate `err.headers['retry-after']`.
 *     `retryAfterSecondsFromHeaders` is proven CORRECT for both header shapes;
 *     whether that SDK supplies one is unmeasured, and it is inert if not.
 *   - The 60 s sleep ceiling is asserted by EVALUATING the real delay
 *     expression lifted out of `generateText` (§5), not by waiting out a real
 *     backoff.
 *   - Rendering, layout and colour CONTRAST are not measurable in Node; they
 *     were measured in a real browser and the numbers live in chat.css.
 *   - §11's THREE 429 SHAPES come from a live wire capture on 2026-08-29 and
 *     were NOT re-measured by this suite or by the session that wrote it.
 *     Re-confirming them means deliberately tripping a free-tier cap (~21 rapid
 *     requests), which was declined on quota grounds. A cheap zero-token probe
 *     was run instead and established one useful negative: an OpenRouter 4xx
 *     that is NOT a 429 carries no `x-ratelimit-*` headers at all, so these
 *     headers cannot be observed without provoking the rate limit itself.
 *     The design is written to be INERT rather than wrong if the capture is
 *     ever wrong about the ENCODING: a seconds-encoded or relative value fails
 *     the sanity bound and falls to the unchanged 60 s default (asserted below).
 */

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CHAT_JS = path.join(ROOT, 'src/public/next/views/chat.js');
const CHAT_CSS = path.join(ROOT, 'src/public/next/views/chat.css');
const LLM_JS = path.join(ROOT, 'src/brain/llm.js');

const chatSrc = readFileSync(CHAT_JS, 'utf8');
const cssSrc = readFileSync(CHAT_CSS, 'utf8');
const llmSrc = readFileSync(LLM_JS, 'utf8');

let passed = 0, failed = 0;
function ok(cond, label, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
}
function eq(actual, expected, label) {
  ok(actual === expected, label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function section(t) { console.log(`\n${t}`); }

// ── Extraction (brace-matched; a desync throws rather than silently truncating).
function extractFunction(src, name, where) {
  const marker = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ${name}\\s*\\(`);
  const m = marker.exec(src);
  if (!m) throw new Error(`extractFunction: "${name}" not found in ${where}`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  let p = src.indexOf('(', start), depth = 0;
  for (; p < src.length; p++) {
    if (src[p] === '(') depth++;
    else if (src[p] === ')') { depth--; if (depth === 0) { p++; break; } }
  }
  let i = src.indexOf('{', p); depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const out = src.slice(start, i).replace(/^export\s+/, '');
  if (!/\n\}$/.test(out)) throw new Error(`extractFunction: "${name}" desynced in ${where}`);
  return out;
}

const T = (await import('../src/brain/llm.js')).__testing;
const { isTransientLlmError } = await import('../src/brain/sharedbrain.js');
const { hasTransientMarker } = await import('../scripts/ci-flake.js');
const { classifyTransientError } = await import('../src/brain/ingest-queue.js');
const { isOutputTokenLimit } = await import('../src/brain/ingest.js');

const PROVIDERS = [['gemini', 'Gemini'], ['anthropic', 'Claude'], ['openrouter', 'OpenRouter'], [null, 'AI provider']];

// ═════════════════════════════════════════════════════════════════════════
section('§1  THE 429 MESSAGE IS CONTEXT-NEUTRAL (the reported vocabulary leak)');
// ═════════════════════════════════════════════════════════════════════════
{
  // The exact clause that shipped, kept verbatim as the POSITIVE CONTROL. A
  // detector that has never been shown to fire is the shape this repo keeps
  // finding: without this line, deleting the regex leaves §1 green.
  const SHIPPED_LEAK =
    'Limits differ by provider and by the tier your account is on, and a ' +
    'bulk operation such as a large ingest can reach them even on a paid plan. ';
  const LEAK_RE = /\bingest\b|\bbulk operation\b|Phase 2|\bby chapter\b|\bthe PDF\b|batch size/i;

  ok(LEAK_RE.test(SHIPPED_LEAK),
    'POSITIVE CONTROL: the detector fires on the clause that actually shipped');

  for (const [id, name] of PROVIDERS) {
    const rate = T.buildRateLimitMessage(name, id, 30);
    const label = id ?? 'unknown-provider';
    ok(!LEAK_RE.test(rate), `the ${label} 429 message carries NO ingest vocabulary`, `got: ${rate}`);
    // The FACT under the removed clause is worth keeping — a paid account has
    // limits too — and it was measured (v3.18.0: 18 consecutive 429s on a PAID
    // model). Losing it while removing the ingest framing would be a downgrade.
    ok(/paid account has them too/.test(rate),
      `…while keeping the measured point that a ${label} paid account has limits too`);
  }

  // The 503 message never had the leak and must not acquire one.
  for (const [id, name] of PROVIDERS) {
    ok(!LEAK_RE.test(T.buildServiceUnavailableMessage(name, id)),
      `the ${id ?? 'unknown-provider'} 503 message carries no ingest vocabulary either`);
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('§2  BOTH MESSAGES DISCLOSE THE SAME LADDER, WITH THE SAME NUMBER');
// ═════════════════════════════════════════════════════════════════════════
{
  // The number is asserted as a LITERAL, not recomputed from MAX_RETRIES. An
  // expectation read from the same constant the code reads passes whatever the
  // constant becomes — v3.18.0 named that as a root cause of assertions that
  // could not fail. Pinning 4 here means changing the ladder reds this suite
  // with a reason, which is the correct outcome for a claim made to users.
  eq(T.MAX_RETRIES, 4, 'the ladder makes 4 attempts (1 initial + 3 retries)');

  for (const [id, name] of PROVIDERS) {
    const label = id ?? 'unknown-provider';
    const rate = T.buildRateLimitMessage(name, id, 30);
    const svc = T.buildServiceUnavailableMessage(name, id);
    ok(/already retried 3 times/.test(rate),
      `the ${label} 429 message says the ladder already ran, and says 3 — not 4`, `got: ${rate}`);
    ok(/already retried 3 times/.test(svc),
      `the ${label} 503 message agrees: 3 retries, not the "4" it shipped`, `got: ${svc}`);
    ok(!/retried 4 times/.test(rate) && !/retried 4 times/.test(svc),
      `…and neither ${label} message still says "retried 4 times" (4 is ATTEMPTS, not retries)`);
    // ~40s is TRUE for the 503 ladder (3s+9s+27s, measured 39,010 ms) and FALSE
    // for the 429 ladder, whose waits come from the provider's hint and default
    // to 60s each. Copying the sentence across would have been a fabrication.
    ok(/~40 seconds/.test(svc), `the ${label} 503 message keeps its measured ~40 seconds`);
    ok(!/40 seconds/.test(rate),
      `…and the ${label} 429 message does NOT claim ~40s, which would be false there`, `got: ${rate}`);
  }

  // Both sentences derive from ONE constant, so they cannot drift again.
  const rateSrc = extractFunction(llmSrc, 'buildRateLimitMessage', 'llm.js');
  const svcSrc = extractFunction(llmSrc, 'buildServiceUnavailableMessage', 'llm.js');
  ok(/MAX_RETRIES/.test(rateSrc), 'the 429 builder derives its count from MAX_RETRIES');
  ok(/MAX_RETRIES/.test(svcSrc), 'the 503 builder derives its count from MAX_RETRIES');
}

// ═════════════════════════════════════════════════════════════════════════
section('§3  "1 seconds" — the plural that shipped on the figure users act on');
// ═════════════════════════════════════════════════════════════════════════
{
  ok(/wait 1 second and/.test(T.buildRateLimitMessage('Gemini', 'gemini', 1)),
    'a 1-second wait reads "1 second"');
  ok(/wait 2 seconds and/.test(T.buildRateLimitMessage('Gemini', 'gemini', 2)),
    'a 2-second wait reads "2 seconds"');
  ok(/wait 0 seconds and/.test(T.buildRateLimitMessage('Gemini', 'gemini', 0)),
    'and zero is plural too, which is the English rule the bug got wrong in one direction only');
}

// ═════════════════════════════════════════════════════════════════════════
section('§4  parseRetryDelay HONOURS A STRUCTURED Retry-After (the dead field)');
// ═════════════════════════════════════════════════════════════════════════
{
  // ── THE MEASUREMENT THAT MAKES THIS A CORRECTNESS BUG, NOT A PREFERENCE ──
  // This is the exact message shape `openrouter-adapter.js` throws on a 429.
  // Fed to the OLD implementation (message patterns only) it matches neither
  // Gemini form and falls to the 60 s default. Asserted here against a
  // FRESHLY-BUILT copy of the old behaviour so the claim is evidenced, not
  // recalled — and so the finding survives in the record after the fix.
  const OPENROUTER_429 = 'OpenRouter chat → HTTP 429 (rate limit): rate limited upstream';
  const legacyParse = (msg) => {
    const a = msg.match(/"retryDelay"\s*:\s*"([\d.]+)s"/);
    if (a) return Math.ceil(parseFloat(a[1]) * 1000);
    const b = msg.match(/retry in ([\d.]+)s/i);
    if (b) return Math.ceil(parseFloat(b[1]) * 1000);
    return 60_000;
  };
  eq(legacyParse('429 {"retryDelay":"27s"}'), 27_000,
    'CONTROL: the message-only reader really does read Gemini\'s structured hint');
  eq(legacyParse(OPENROUTER_429), 60_000,
    'MEASURED: an OpenRouter 429 message matches NEITHER Gemini form, so the message-only ' +
    'reader returns its 60s default — three times over, for every OpenRouter rate limit');

  // The producer really does exist and really is structured. One producer, and
  // before this change, zero consumers.
  const adapterSrc = readFileSync(path.join(ROOT, 'src/brain/openrouter-adapter.js'), 'utf8');
  ok(/e\.retryAfterSeconds = Number\(retryAfter\)/.test(adapterSrc),
    'the adapter sets err.retryAfterSeconds from the upstream Retry-After header');

  // And the shipped consumer now reads it.
  eq(T.parseRetryDelay({ message: OPENROUTER_429, retryAfterSeconds: 2 }), 2_000,
    'THE FIX: a structured Retry-After of 2s yields 2000ms, not the 60000ms default');
  eq(T.parseRetryDelay({ message: OPENROUTER_429 }), 60_000,
    '…and with no hint in any form the 60s default is UNCHANGED (existing suites depend on it)');

  // Precedence: stated beats parsed beats invented.
  eq(T.parseRetryDelay({ message: 'retry in 30s', retryAfterSeconds: 3 }), 3_000,
    'a provider-STATED delay outranks one parsed out of its prose');
  eq(T.parseRetryDelay({ message: '429 {"retryDelay":"27.5s"}' }), 27_500,
    'Gemini\'s structured message form still works');
  eq(T.parseRetryDelay({ message: 'Please retry in 12s' }), 12_000,
    'Gemini\'s plain-text message form still works');
  eq(T.parseRetryDelay({ message: '429', retryAfterSeconds: 0 }), 0,
    'a stated ZERO is honoured, not treated as absent — 0 is a real answer');

  // Both header shapes an SDK might hand us.
  eq(T.parseRetryDelay({ message: '429', headers: new Headers({ 'retry-after': '7' }) }), 7_000,
    'a WHATWG Headers carrying retry-after is read');
  eq(T.parseRetryDelay({ message: '429', headers: { 'retry-after': '9' } }), 9_000,
    'a plain lower-cased headers object is read too');

  // Garbage must fall through to the default, never coerce.
  for (const bad of [null, undefined, NaN, Infinity, -1, 'soon', {}, []]) {
    eq(T.parseRetryDelay({ message: '429', retryAfterSeconds: bad }), 60_000,
      `a retryAfterSeconds of ${JSON.stringify(bad) ?? String(bad)} falls through to the default`);
  }
  // An HTTP-date Retry-After is deliberately NOT parsed; it must not coerce.
  eq(T.parseRetryDelay({ message: '429', headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' } }), 60_000,
    'an HTTP-date Retry-After is refused rather than guessed at');
  eq(T.retryAfterSecondsFromHeaders(null), null, 'a null headers object yields null, never a number');
  eq(T.retryAfterSecondsFromHeaders({ get() { throw new Error('boom'); } }), null,
    'a headers object whose get() throws yields null rather than taking the call down');
  // Prototype keys must not be readable as a header (the v3.0.9 shape).
  eq(T.retryAfterSecondsFromHeaders({}), null, 'a bare object with no own retry-after yields null');
}

// ═════════════════════════════════════════════════════════════════════════
section('§5  THE SLEEP IS BOUNDED; THE REPORTED FIGURE IS NOT');
// ═════════════════════════════════════════════════════════════════════════
{
  // Honouring an unbounded Retry-After became reachable only once §4 landed:
  // a `Retry-After: 3600` would otherwise put a chat turn to sleep for an hour,
  // three times. The ceiling matches the one the 503 path already used, so the
  // worst case is exactly what it was before — never worse.
  eq(T.MAX_RETRY_SLEEP_MS, 60_000, 'the ceiling is the 60s the 503 ladder already used');

  // DRIVEN, not scanned: the real delay expression is lifted out of the shipped
  // generateText and evaluated. A regex over this line would pass on a comment.
  const genSrc = extractFunction(llmSrc, 'generateText', 'llm.js');
  const m = /const delayMs = rateLimited\s*\n\s*\?([\s\S]*?);\n/.exec(genSrc);
  ok(m !== null, 'the delay expression was located in the shipped generateText');
  const delayFor = new Function('rateLimited', 'attempt', 'err', 'parseRetryDelay', 'MAX_RETRY_SLEEP_MS',
    `return rateLimited ?${m[1]};`);
  const call = (secs) => delayFor(true, 1, { retryAfterSeconds: secs }, T.parseRetryDelay, T.MAX_RETRY_SLEEP_MS);

  eq(call(2), 2_000, 'a 2s hint sleeps 2s — the short hint is honoured in full');
  eq(call(3600), 60_000, 'a 3600s hint sleeps at most 60s — an hour-long chat hang is unreachable');
  eq(delayFor(false, 3, {}, T.parseRetryDelay, T.MAX_RETRY_SLEEP_MS), 27_000,
    'the 503 arm is untouched: attempt 3 still backs off 27s');
  eq(delayFor(false, 9, {}, T.parseRetryDelay, T.MAX_RETRY_SLEEP_MS), 60_000,
    '…and still tops out at the same ceiling');

  // THE HONESTY HALF. The clamp is on the SLEEP only. The message quotes what
  // the PROVIDER asked for, so clamping the rendered number would print a wait
  // nobody requested — on the one line a rate-limited user acts on.
  eq(T.parseRetryDelay({ message: '429', retryAfterSeconds: 300 }), 300_000,
    'parseRetryDelay itself returns the provider\'s real 300s — unclamped');
  ok(/wait 300 seconds/.test(T.buildRateLimitMessage('OpenRouter', 'openrouter', 300)),
    '…so the message can quote 300s even though we only slept 60');
}

// ═════════════════════════════════════════════════════════════════════════
section('§6  CLASSIFICATION IS UNAFFECTED BY EVERY WORD CHANGED');
// ═════════════════════════════════════════════════════════════════════════
{
  // These messages are read as TEXT by five classifiers across four files.
  // Rewording a diagnosis clause breaks a recovery path with nothing else
  // failing — the batch queue would stop PAUSING on a rate limit and would
  // instead fail 30 files one by one against a provider that has said stop.
  for (const [id, name] of PROVIDERS) {
    const label = id ?? 'unknown-provider';
    const rate = T.buildRateLimitMessage(name, id, 30);
    const svc = T.buildServiceUnavailableMessage(name, id);

    ok(T.is429({ message: rate }), `is429 still fires on the ${label} 429 message`);
    ok(!T.is503({ message: rate }), `…and the ${label} 429 message did NOT acquire a 503 token`);
    ok(T.is503({ message: svc }), `is503 still fires on the ${label} 503 message`);
    ok(isTransientLlmError(rate) && isTransientLlmError(svc),
      `sharedbrain's strike-counter guard still spares both ${label} messages`);
    ok(hasTransientMarker(rate) && hasTransientMarker(svc),
      `ci-flake still reads both ${label} messages as a provider outage`);
    eq(classifyTransientError(new Error(`Ingest failed: ${rate}`)), 'rate_limit',
      `the queue still PAUSES the batch on a wrapped ${label} 429`);
    eq(classifyTransientError(new Error(`Ingest failed: ${svc}`)), 'service_unavailable',
      `the queue still classifies a wrapped ${label} 503`);
    ok(rate.includes('(HTTP 429)'), `the ${label} 429 message keeps the literal "(HTTP 429)"`);
    ok(svc.includes('(HTTP 503)'), `the ${label} 503 message keeps the literal "(HTTP 503)"`);
    ok(svc.includes('temporarily overloaded'), `the ${label} 503 message keeps "temporarily overloaded"`);
    // isOutputTokenLimit keys on a phrase, and gates ingest/compile's fallback
    // ladders. Neither transient message may ever satisfy it.
    ok(!isOutputTokenLimit(new Error(rate)) && !isOutputTokenLimit(new Error(svc)),
      `neither ${label} message is mistaken for an output-token limit`);
  }
  // The load-time census in llm.js proves the adapter's neutraliser still
  // describes these classifiers. It throws at import; reaching here proves it.
  ok(true, 'llm.js\'s load-time RETRY_CLASSIFIER_TOKENS / MODEL_NOT_FOUND_CLAUSES census still passes');
}

// ═════════════════════════════════════════════════════════════════════════
section('§7  THE FAILURE RENDERS RECESSED, WITH A WAY FORWARD (real markup)');
// ═════════════════════════════════════════════════════════════════════════

// Executes the SHIPPED renderThreadOnly against a fake document and reads back
// what it actually wrote. Driving the real call site is the point: a guard that
// exercises `failedModelNoteHtml` alone would stay green if the error branch
// never called it, which is exactly how the re-ask control came to be absent.
function makeThreadRenderer(state) {
  const el = { innerHTML: '', querySelectorAll: () => [], querySelector: () => null, getAttribute: () => null, setAttribute: () => {} };
  const doc = { getElementById: (id) => (id === 'chat-thread' ? el : null) };
  const src =
    'const state = stateRef;\n' +
    // Joined the bindings when chat turns began STREAMING. renderThreadOnly now
    // decides its scroll from the reader's position rather than jumping
    // unconditionally, and gates the in-flight bubble on an identity match
    // instead of a bare `state.sending`. The real helpers are extracted rather
    // than stubbed — with no `#main` element in this fake document the scroll
    // resolves to a no-op, which is the correct behaviour here and keeps this
    // suite's subject (the FAILURE markup) unchanged.
    'let sendAbort = null, sendStream = null, lastRenderedConvId;\n' +
    'const THREAD_FOLLOW_SLACK_PX = ' +
      (/const THREAD_FOLLOW_SLACK_PX = (\d+);/.exec(chatSrc) || [])[1] + ';\n' +
    extractFunction(chatSrc, 'sendIsOnScreen', 'chat.js') + '\n' +
    extractFunction(chatSrc, 'threadScrollHost', 'chat.js') + '\n' +
    extractFunction(chatSrc, 'isThreadAtBottom', 'chat.js') + '\n' +
    extractFunction(chatSrc, 'stickThreadToBottom', 'chat.js') + '\n' +
    extractFunction(chatSrc, 'wireStreamToggle', 'chat.js') + '\n' +
    extractFunction(chatSrc, 'offerableEntries', 'chat.js') + '\n' +
    extractFunction(chatSrc, 'resolveChatModel', 'chat.js') + '\n' +
    extractFunction(chatSrc, 'slowTurnNoticeText', 'chat.js') + '\n' +
    extractFunction(chatSrc, 'failedModelNoteHtml', 'chat.js') + '\n' +
    extractFunction(chatSrc, 'questionForAnswerIndex', 'chat.js') + '\n' +
    extractFunction(chatSrc, 'composerShowsModelPicker', 'chat.js') + '\n' +
    extractFunction(chatSrc, 'reaskButtonHtml', 'chat.js') + '\n' +
    extractFunction(chatSrc, 'renderThreadOnly', 'chat.js') + '\n' +
    'return () => renderThreadOnly(1);';
  const run = new Function(
    'stateRef', 'document', 'isCurrentMount', 'escapeHtml', 'icon', 'renderMarkdown',
    'assistantEyebrowHtml', 'cancelNoticeHtml', 'thinkingBodyHtml', 'folderOfPath',
    'typeChipClass', 'typeDotStyle', 'openWikiReader', 'openBrowseDialog',
    'formatDurationMs', 'MODEL_PICKER_ENABLED',
    src,
  )(
    state, doc, () => true,
    (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    (n) => `<svg data-icon="${n}"></svg>`,
    (s) => `<p>${s}</p>`,
    () => '<div class="chat-msg-eyebrow mono">THE CURATOR</div>',
    () => '', () => '', () => 'entities', () => '', () => '',
    () => {}, () => {}, (ms) => `${Math.round(ms / 1000)}s`, true,
  );
  run();
  return el.innerHTML;
}

const FREE_ENTRY = { id: 'google/gemma-4-26b-a4b:free', label: 'Gemma 4 26B A4B (free)', free: true };
const PAID_ENTRY = { id: 'anthropic/claude-haiku-4-5', label: 'Haiku 4.5', input: 1, output: 5 };
const baseState = (over) => Object.assign({
  thread: [], sending: false, domains: [], activeDomain: 'zz',
  offerable: { openrouter: [FREE_ENTRY, PAID_ENTRY] },
  availableProviders: ['openrouter'], providerOnlyProviders: [],
  chatModel: null, modelProvider: null, activeProvider: 'openrouter', models: {},
}, over);

const RATE_MSG = T.buildRateLimitMessage('OpenRouter', 'openrouter', 30);

{
  const html = makeThreadRenderer(baseState({
    thread: [
      { role: 'user', content: 'what does my wiki say about RAG?' },
      { role: 'assistant', content: '', error: RATE_MSG, requestedModel: FREE_ENTRY.id },
    ],
  }));

  // THE RED WALL IS GONE. `.chat-answer` is 14.5px body copy and the CSS painted
  // it entirely --danger-text; the message now renders in its own recessed,
  // width-capped block.
  ok(!/chat-msg-error[^"]*"[\s\S]*?class="chat-answer"/.test(html),
    'the failure no longer renders through .chat-answer (14.5px body copy)');
  ok(/class="chat-error-note"/.test(html), 'it renders in its own recessed block');
  ok(/class="chat-error-detail"/.test(html), '…with the provider message in the detail class');
  ok(/role="status"/.test(html), 'announced politely — the user is already watching this spot');
  ok(!/role="alert"/.test(html), '…and NOT assertively, which would interrupt a screen reader mid-sentence');
  ok(!/data-icon="alertCircle"/.test(html),
    'no alert icon — the v3.13.2 rule: state the fact, do not decorate it');

  // THE WAY FORWARD. v3.18.0's control, reused rather than reinvented.
  ok(/data-reask="1"/.test(html),
    'the failed turn offers "ask again with another model", pointed at its own index');
  ok(/Ask again with another model/.test(html), '…with the same wording a successful answer uses');

  // The provider's own message still reaches the user in full — the fix is
  // presentation, never truncation. A cut-off remedy link is worse than none.
  ok(html.includes('(HTTP 429)'), 'the provider message is rendered, not summarised away');
  ok(html.includes('https://openrouter.ai/docs/api-reference/limits'),
    '…including the remedy link, in full');
}

// ═════════════════════════════════════════════════════════════════════════
section('§8  THE FREE-MODEL FACT: ONE SENTENCE, ONE OWNER, NO INVENTED FIGURE');
// ═════════════════════════════════════════════════════════════════════════
{
  const html = makeThreadRenderer(baseState({
    thread: [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '', error: RATE_MSG, requestedModel: FREE_ENTRY.id },
    ],
  }));
  ok(/class="chat-error-context"/.test(html), 'a FREE model gets the shared-pool context sentence');
  ok(html.includes('Gemma 4 26B A4B (free)'), '…naming the model that was actually asked');
  ok(/share one pool of capacity/.test(html), '…and stating the measured mechanism');
  ok(/8 of 8[\s\S]*?0 of 8/.test(html), '…with the figures v3.15.0 actually measured');

  // THE HARD RULE. v3.15.0 records this project declining to print free-tier
  // request caps because they could not be verified, and v3.18.0 measured 18
  // consecutive 429s on a PAID model. Any "N requests per day" here would be
  // both unverifiable and wrong exactly when it is read.
  ok(!/\d+\s*(requests?|calls?)\s*(per|\/)\s*(day|minute|hour|min)/i.test(html),
    'NO invented rate-limit figure anywhere in the failure surface');
  ok(!/free tier allows|free tier is limited to/i.test(html),
    '…and no unverifiable free-tier cap claim');

  // ONE OWNER. The waiting surface and the failure surface must never disagree
  // about a measured claim, so the failure note is built by the SAME function
  // the thinking bubble uses. Proven by equality, not by reading the source.
  const bubbleText = new Function('formatDurationMs',
    extractFunction(chatSrc, 'slowTurnNoticeText', 'chat.js') + '\nreturn slowTurnNoticeText;',
  )((ms) => `${Math.round(ms / 1000)}s`)({ label: FREE_ENTRY.label, free: true });
  ok(bubbleText.length > 0, 'CONTROL: the shared builder really produces a sentence for a free model');
  ok(html.includes(bubbleText.replace(/&/g, '&amp;')),
    'the sentence rendered at FAILURE is byte-identical to the one shown while WAITING');

  // Absence rules. A guess here would relabel a failure with a model that never
  // saw it — the v3.13.2 bug, about reliability instead of price.
  // THE COMPOSER IS LIVE DURING AND AFTER A TURN, so this fixture deliberately
  // arms it with a FREE model while the failed message records none. A renderer
  // that reaches for `state.chatModel` produces the free note here and looks
  // completely correct — that is the v3.13.2 relabelling bug, about reliability
  // instead of price. THIS ASSERTION WAS FIRST WRITTEN WITH `chatModel: null`
  // AND COULD NOT FAIL: the mutation that re-introduces the fallback passed
  // 154/0. The fixture, not the wording, is what makes it bite.
  const noModel = makeThreadRenderer(baseState({
    chatModel: FREE_ENTRY.id, modelProvider: 'openrouter',
    thread: [{ role: 'user', content: 'q' }, { role: 'assistant', content: '', error: RATE_MSG }],
  }));
  ok(!/chat-error-context/.test(noModel),
    'a failure with NO recorded model says nothing about the model — even with a FREE model ' +
    'sitting in the composer right now, which is the material a guess would be made from');
  // POSITIVE CONTROL: the same state, with the model actually RECORDED, does
  // render the note — so the assertion above is measuring the recording rule,
  // not a renderer that never emits anything.
  const recorded = makeThreadRenderer(baseState({
    chatModel: FREE_ENTRY.id, modelProvider: 'openrouter',
    thread: [{ role: 'user', content: 'q' },
      { role: 'assistant', content: '', error: RATE_MSG, requestedModel: FREE_ENTRY.id }],
  }));
  ok(/chat-error-context/.test(recorded),
    'POSITIVE CONTROL: with the model RECORDED on the message, the same fixture does render the note');
  const paid = makeThreadRenderer(baseState({
    thread: [{ role: 'user', content: 'q' },
      { role: 'assistant', content: '', error: RATE_MSG, requestedModel: PAID_ENTRY.id }],
  }));
  ok(!/chat-error-context/.test(paid), 'a PAID model gets no free-model note');
  const unknown = makeThreadRenderer(baseState({
    thread: [{ role: 'user', content: 'q' },
      { role: 'assistant', content: '', error: RATE_MSG, requestedModel: 'not/in-catalogue' }],
  }));
  ok(!/chat-error-context/.test(unknown), 'a model absent from the live catalogue gets no note either');

  // The send path must RECORD the model, or every assertion above is unreachable
  // in production while staying green here.
  const sendSrc = extractFunction(chatSrc, 'sendCurrentMessage', 'chat.js');
  const errPush = /state\.thread\.push\(\{[\s\S]{0,400}?error: err\.message,[\s\S]{0,200}?\}\)/.exec(sendSrc);
  ok(errPush !== null && /requestedModel: requestedModelAtSend/.test(errPush[0]),
    'the error path records requestedModel, captured at SEND time');
}

// ═════════════════════════════════════════════════════════════════════════
section('§9  ESCAPING — the failure surface is a boundary like any other');
// ═════════════════════════════════════════════════════════════════════════
{
  const XSS = '<img src=x onerror=alert(1)>';
  const html = makeThreadRenderer(baseState({
    thread: [{ role: 'user', content: 'q' },
      { role: 'assistant', content: '', error: XSS, requestedModel: FREE_ENTRY.id }],
  }));
  ok(!/<img src=x/.test(html), 'a hostile provider message is escaped');
  ok(/&lt;img src=x/.test(html), 'POSITIVE CONTROL: the payload really reached the markup, escaped');

  const hostile = { id: 'evil/model', label: XSS, free: true };
  const html2 = makeThreadRenderer(baseState({
    offerable: { openrouter: [hostile] },
    thread: [{ role: 'user', content: 'q' },
      { role: 'assistant', content: '', error: 'boom', requestedModel: 'evil/model' }],
  }));
  ok(!/<img src=x/.test(html2), 'a hostile MODEL LABEL is escaped in the free-model note too');
  ok(/&lt;img src=x/.test(html2), 'POSITIVE CONTROL: that payload reached the markup as well');
}

// ═════════════════════════════════════════════════════════════════════════
section('§10  THE STYLING IS RECESSED, AND ITS TOKENS EXIST');
// ═════════════════════════════════════════════════════════════════════════
{
  // An undefined custom property fails SILENTLY at computed-value time — the
  // whole declaration is dropped. test-css-tokens.js guards definition
  // repo-wide; this guards the INTENT of these three rules.
  const rule = (sel) => {
    const m = new RegExp(`\\${sel}\\s*\\{([^}]*)\\}`).exec(cssSrc);
    return m ? m[1] : null;
  };
  const note = rule('.chat-error-note');
  const detail = rule('.chat-error-detail');
  const ctx = rule('.chat-error-context');
  ok(note !== null && detail !== null && ctx !== null, 'all three failure rules exist in chat.css');

  ok(/max-width:\s*62ch/.test(note),
    'the failure block is width-capped at 62ch — it can never span the column again');
  ok(/border-left:\s*2px solid var\(--danger\)/.test(note),
    'the failure is marked by ONE 2px rule');

  // The COPY is never danger-red. That is the whole reported defect: ~450
  // characters of alarm-coloured prose.
  for (const [name, body] of [['detail', detail], ['context', ctx]]) {
    ok(!/--danger/.test(body), `the ${name} TEXT is not painted from the danger palette`);
    ok(/var\(--text-2\)/.test(body),
      `the ${name} text is --text-2, measured above the 4.5:1 AA floor in both themes`);
    ok(!/var\(--text-3\)/.test(body),
      `…and NOT --text-3, which this view already measured under AA at 4.38 / 4.00`);
  }
  ok(/font-size:\s*var\(--text-sm\)/.test(detail),
    'the message is stepped down from 14.5px answer size to --text-sm');
  ok(!/animation/.test(note + detail + ctx),
    'no animation — nothing enters or leaves, so there is nothing to neutralise for reduced motion');

  // The rule the defect lived in is GONE, not merely overridden.
  //
  // COMMENTS STRIPPED FIRST, and the reason is instructive: the replacement
  // block QUOTES the deleted rule to explain what it replaced, so a scan over
  // raw CSS finds the old selector in prose and reports it still present. The
  // v3.18.0 hazard — a scan a comment can satisfy — inverted: here a comment
  // defeats an ABSENCE check. Caught by this assertion failing on the first run.
  const cssCode = cssSrc.replace(/\/\*[\s\S]*?\*\//g, '');
  ok(/chat-error-note/.test(cssCode),
    'CONTROL: stripping comments left the real rules intact, so the check below is not vacuous');
  ok(!/\.chat-msg-error\s+\.chat-answer\s*\{[^}]*--danger-text/.test(cssCode),
    'the old `.chat-msg-error .chat-answer { color: var(--danger-text) }` rule is deleted');
}

// ═════════════════════════════════════════════════════════════════════════
section('§11  THE OTHER TWO 429 SHAPES — the one the report was actually on');
// ═════════════════════════════════════════════════════════════════════════
{
  // ── THE MEASUREMENT ────────────────────────────────────────────────────────
  // Captured live 2026-08-29 from one key in one session. OpenRouter does not
  // answer a 429 one way; it answers three ways, and the shipped fix reached
  // one of them:
  //
  //   A  z-ai/glm-5.2:free      retry-after: 5                    → FIXED
  //   B  google/gemma-4-*:free  x-ratelimit-{limit,remaining,reset}
  //                             reset = ABSOLUTE epoch MILLISECONDS
  //                             body: "Rate limit exceeded: free-models-per-min."
  //   C  google/gemma-4-31b-it:free   no rate-limit headers at all
  //
  // The maintainer's ORIGINAL report was on a Gemma free model — shape B. So
  // the honest hint was on the wire and still fell to the 60 s default, three
  // times over: ~180 s of silence, which is the whole of the complaint.
  const NOW = 1_756_000_000_000;   // fixed clock; nothing here reads the real one
  const OR_429 = 'OpenRouter chat → HTTP 429 (rate limit): rate limited upstream';

  // POSITIVE CONTROL, and it is the finding: shape B carries no Retry-After in
  // any form, so every rung that existed before this change declines it.
  const shapeB = { message: OR_429, rateLimitResetMs: NOW + 5_000 };
  eq(T.retryAfterSecondsFromHeaders(shapeB.headers), null,
    'MEASURED: shape B carries no retry-after header — the Retry-After reader has nothing to read');
  eq(T.parseRetryDelay({ message: OR_429 }, NOW), 60_000,
    'CONTROL: with the reset stamp REMOVED, shape B is exactly the 60s default it used to get');

  // THE FIX.
  eq(T.parseRetryDelay(shapeB, NOW), 5_000,
    'THE FIX: a reset stamp 5s in the future yields 5000ms, not the 60000ms default');

  // Shape C must be untouched — there is nothing to read, and inventing one
  // would be strictly worse than the default we already had.
  eq(T.parseRetryDelay({ message: OR_429 }, NOW), 60_000,
    'shape C (no rate-limit headers at all) still gets the unchanged 60s default');

  // ── PRECEDENCE: the clock-derived value may only ever replace the INVENTED
  // one. It must never displace a duration the provider stated, in any form.
  eq(T.parseRetryDelay({ message: OR_429, retryAfterSeconds: 3, rateLimitResetMs: NOW + 9_000 }, NOW), 3_000,
    'a stated Retry-After outranks the reset stamp — a duration beats an arithmetic result');
  eq(T.parseRetryDelay({ message: '429', headers: { 'retry-after': '4' }, rateLimitResetMs: NOW + 9_000 }, NOW), 4_000,
    '…and so does a Retry-After read from headers');
  eq(T.parseRetryDelay({ message: 'Please retry in 8s', rateLimitResetMs: NOW + 9_000 }, NOW), 8_000,
    'even Gemini\'s PROSE form outranks it: stated-in-text is still clock-free, the stamp is not');
  eq(T.parseRetryDelay({ message: '429 {"retryDelay":"7s"}', rateLimitResetMs: NOW + 9_000 }, NOW), 7_000,
    '…as does Gemini\'s structured message form');

  // ── THE SANITY BOUND, driven directly so the boundary is visible. At exactly
  // 60s the ACCEPTED value and the DEFAULT are both 60000, so parseRetryDelay
  // alone cannot tell them apart — which is why the rung is exported and
  // exercised on its own here. A test that could not distinguish the two would
  // pass whether or not the bound existed.
  const R = T.retryDelayFromResetStamp;
  eq(R({ rateLimitResetMs: NOW + 1 }, NOW), 1, '1ms in the future is accepted — the bound is not a floor in disguise');
  eq(R({ rateLimitResetMs: NOW + 60_000 }, NOW), 60_000, 'exactly the ceiling is ACCEPTED (inclusive)');
  eq(R({ rateLimitResetMs: NOW + 60_001 }, NOW), null, 'one millisecond over the ceiling is REFUSED, not clamped');
  eq(R({ rateLimitResetMs: NOW }, NOW), null, 'a reset of exactly now is refused — a 429 just happened, so it cannot be trusted');
  eq(R({ rateLimitResetMs: NOW - 1 }, NOW), null, 'a reset in the past is refused');

  // ── SKEWED CLOCK, both directions. This is the rung's whole risk: it is the
  // only one whose answer depends on the local machine agreeing with the
  // provider. Both skews must land on the UNCHANGED default, costing the user
  // nothing they were not already paying.
  const DAY = 86_400_000;
  eq(T.parseRetryDelay({ message: OR_429, rateLimitResetMs: NOW + 5_000 }, NOW + 365 * DAY), 60_000,
    'CLOCK A YEAR FAST: the reset lands in the past, so it is refused and the 60s default stands');
  eq(T.parseRetryDelay({ message: OR_429, rateLimitResetMs: NOW + 5_000 }, NOW - 365 * DAY), 60_000,
    'CLOCK A YEAR SLOW: the delta is ~a year, far over the ceiling, so it is refused — never a year-long sleep');
  ok(R({ rateLimitResetMs: NOW + 5_000 }, NOW - 365 * DAY) === null,
    '…and the rung itself returns null there rather than a clamped figure we would then PRINT');

  // ── OTHER PLAUSIBLE ENCODINGS FAIL SAFE WITHOUT A SPECIAL CASE. If a provider
  // ever sends seconds, or a relative duration, the delta against a ~1.7e12
  // epoch is hugely negative — refused, never misread as a 55-year wait.
  eq(R({ rateLimitResetMs: Math.floor(NOW / 1000) }, NOW), null,
    'a SECONDS-encoded reset is refused, not misread (delta is hugely negative)');
  eq(R({ rateLimitResetMs: 5_000 }, NOW), null,
    'a RELATIVE duration sent in the absolute field is refused too');

  // Garbage must never coerce. `Number.isFinite` is the gate, not truthiness.
  for (const bad of [null, undefined, NaN, Infinity, -Infinity, '5000', {}, [], true]) {
    eq(R({ rateLimitResetMs: bad }, NOW), null,
      `a rateLimitResetMs of ${JSON.stringify(bad) ?? String(bad)} yields null, never a coerced number`);
  }
  eq(R({}, NOW), null, 'an error with no reset stamp yields null');
  eq(R(null, NOW), null, 'a null error yields null rather than throwing');

  // `now` is DEFAULTED, so no production call site changed. Proven by calling
  // the shipped signature with one argument, as generateText does.
  const soon = { message: OR_429, rateLimitResetMs: Date.now() + 10_000 };
  const live = T.parseRetryDelay(soon);
  ok(live > 8_000 && live <= 10_000,
    'parseRetryDelay(err) with NO clock argument still reads the stamp against the real Date.now()');

  // ── THE PRODUCER. The adapter must actually read all three headers off the
  // wire and attach them RAW — a consumer with no producer is the same
  // dead-data shape from the other end.
  const adapterSrc = readFileSync(path.join(ROOT, 'src/brain/openrouter-adapter.js'), 'utf8');
  for (const h of ['x-ratelimit-reset', 'x-ratelimit-limit', 'x-ratelimit-remaining']) {
    ok(new RegExp(`readNumericHeader\\(res\\.headers, '${h}'\\)`).test(adapterSrc),
      `the adapter reads ${h} off the 429 response`);
  }
  ok(/e\.rateLimitResetMs = resetMs/.test(adapterSrc),
    'the adapter attaches the reset stamp to the error — the carrier that actually reaches the user');

  // RAW, not pre-derived. If the adapter collapsed the stamp into
  // `retryAfterSeconds` the clock-dependent guess would become indistinguishable
  // from a provider-stated fact, defeating the precedence above.
  ok(!/retryAfterSeconds\s*=\s*[^;]*resetMs/.test(adapterSrc),
    'the adapter does NOT collapse the reset stamp into retryAfterSeconds — the two ranks stay distinct');

  // ── readNumericHeader: absent and zero must stay distinguishable. Number('')
  // is 0, and a 0 here is a real, actionable figure.
  const A = (await import('../src/brain/openrouter-adapter.js')).__testing;
  eq(A.readNumericHeader({ 'x-ratelimit-remaining': '0' }, 'x-ratelimit-remaining'), 0,
    'a header of "0" reads as the NUMBER 0 — a real figure, not absence');
  eq(A.readNumericHeader({}, 'x-ratelimit-remaining'), null, 'an absent header reads as null, never 0');
  for (const bad of ['', '   ', 'soon', '1e5', '20 per minute']) {
    eq(A.readNumericHeader({ 'x-ratelimit-limit': bad }, 'x-ratelimit-limit'), null,
      `a header of ${JSON.stringify(bad)} is refused rather than coerced`);
  }
  eq(A.readNumericHeader(new Headers({ 'x-ratelimit-limit': '20' }), 'x-ratelimit-limit'), 20,
    'a WHATWG Headers is read too, matching the shape readHeader already accepts');
}

// ═════════════════════════════════════════════════════════════════════════
section('§12  THE REAL LIMIT IS REPORTED — because it is now REPORTABLE');
// ═════════════════════════════════════════════════════════════════════════
{
  // v3.15.0 refused to print a rate-limit figure because OpenRouter's docs
  // render that table as JS components and it came through EMPTY — the project
  // had never verified a number. That reasoning stands. What changed is the
  // PREMISE: on shape B the provider states it per-request, on the 429 itself.
  // A reported fact about this exact call is not an invented one.
  const D = T.describeReportedLimit;

  eq(D(20, 0), 'OpenRouter reported a limit of 20 on this response.',
    'the measured figure is repeated verbatim and attributed');
  eq(D(20, 3), 'OpenRouter reported a limit of 20 with 3 remaining on this response.',
    'a NON-zero remaining is kept — being refused with quota left says another limit was hit');
  eq(D(20, 0), D(20, null),
    'a ZERO remaining is suppressed: on a 429 it is the definition of the error, so it carries no information');

  // ABSENCE IS NEVER A FIGURE. This is the whole discipline.
  for (const absent of [null, undefined, NaN, Infinity, '20', {}, []]) {
    eq(D(absent, 5), '', `a limit of ${JSON.stringify(absent) ?? String(absent)} renders NOTHING — never a default`);
  }

  // NO INVENTED WINDOW AND NO INVENTED TIER. The header is a bare number; only
  // the upstream's own prose names the window, and it already reaches the user
  // as `detail`. v3.18.0 measured 18 consecutive 429s on a PAID model, so a
  // "free tier" lead was wrong exactly when the user needed it right.
  const INVENTED = /per minute|per-minute|per day|per second|\/min|\bfree tier\b|\bfree-tier\b|\bpaid tier\b/i;
  ok(INVENTED.test('capped at 20 requests per minute on the free tier'),
    'POSITIVE CONTROL: the detector fires on the claim that actually shipped in v3.15.0');
  for (const [l, r] of [[20, 0], [20, 3], [1, 0], [0, 0]]) {
    ok(!INVENTED.test(D(l, r)), `the reported sentence (${l}/${r}) invents no window and no tier`);
  }

  // ONE DEFINITION, TWO CONSUMERS. A second copy of a claim about a NUMBER
  // would not diverge visibly, it would diverge in what it asserts.
  const adapterSrc = readFileSync(path.join(ROOT, 'src/brain/openrouter-adapter.js'), 'utf8');
  ok(/export function describeReportedLimit/.test(adapterSrc),
    'the sentence is defined exactly once, in the adapter that knows what the headers mean');
  ok(/describeReportedLimit,/.test(llmSrc.slice(0, llmSrc.indexOf("} from './openrouter-adapter.js'"))),
    'llm.js IMPORTS it rather than keeping a second copy');
  ok(!/reported a limit of/.test(llmSrc),
    'the literal sentence appears NOWHERE in llm.js — proving the import is the only source');

  // ── IT REACHES THE USER. The adapter's `_warn` is a no-op on every production
  // path (nothing passes `onWarn` to `new OpenRouterAdapter`), so a figure that
  // stopped there would be measured, attached and read by nobody. MEASURED, not
  // assumed: the construction site carries no callback.
  const ctor = /new OpenRouterAdapter\(\{ apiKey \}\)/.exec(llmSrc);
  ok(ctor !== null,
    'MEASURED: llm.js builds the adapter with apiKey alone — no onWarn, so _warn reaches nobody');

  const withLimit = T.buildRateLimitMessage('OpenRouter', 'openrouter', 5, { limit: 20, remaining: 0 });
  ok(/OpenRouter reported a limit of 20 on this response\./.test(withLimit),
    'THE FIX: the figure reaches the message a rate-limited user actually reads');
  ok(withLimit.indexOf('reported a limit') < withLimit.indexOf('documented at'),
    '…and precedes the docs link, because a figure just stated outranks a page to go and read');

  // BYTE-IDENTICAL WHEN NOTHING WAS REPORTED. Every provider and every call that
  // sent no header must produce exactly the message that shipped.
  for (const [id, name] of PROVIDERS) {
    const base = T.buildRateLimitMessage(name, id, 30);
    const label = id ?? 'unknown-provider';
    eq(T.buildRateLimitMessage(name, id, 30, undefined), base,
      `the ${label} message is byte-identical with no limits argument at all`);
    eq(T.buildRateLimitMessage(name, id, 30, {}), base,
      `…and with an EMPTY limits object — absence never renders a partial sentence`);
    eq(T.buildRateLimitMessage(name, id, 30, { limit: null, remaining: null }), base,
      `…and with explicit nulls`);
    ok(!/reported a limit/.test(base),
      `the ${label} message says nothing about a limit it was never told`);
  }

  // The provider name is threaded, so nothing here is OpenRouter-specific.
  ok(/Gemini reported a limit of 9 on this response\./.test(
    T.buildRateLimitMessage('Gemini', 'gemini', 5, { limit: 9 })),
    'the sentence names whichever provider reported it — Gemini would render identically');

  // THE FIGURES ARE FORWARDED FROM THE RAW ERROR. A builder that accepts them
  // and a call site that never passes them is the dead-data shape from the
  // other end — this repo has shipped it several times.
  const genSrc = extractFunction(llmSrc, 'generateText', 'llm.js');
  ok(/limit:\s*err\?\.rateLimitLimit/.test(genSrc) && /remaining:\s*err\?\.rateLimitRemaining/.test(genSrc),
    'generateText forwards both figures off the raw provider error into the message');

  // ── CLASSIFICATION IS UNCHANGED BY THE NEW SENTENCE. It is added to a message
  // five classifiers across four files read as TEXT.
  const withBoth = T.buildRateLimitMessage('OpenRouter', 'openrouter', 5, { limit: 20, remaining: 3 });
  for (const [label, msg] of [['limit-only', withLimit], ['limit+remaining', withBoth]]) {
    ok(T.is429({ message: msg }), `is429 still fires on the ${label} message`);
    ok(!T.is503({ message: msg }), `…and the ${label} message acquired NO 503 token`);
    ok(!isOutputTokenLimit({ message: msg }),
      `…and the word "limit" did NOT make it read as an output-token limit`);
    eq(classifyTransientError(new Error(`Ingest failed: ${msg}`)), 'rate_limit',
      `the queue still PAUSES the batch on a wrapped ${label} message`);
    // Takes a STRING, not an error object — matching how §6 calls it. Passing
    // `{ message }` here made this assertion fail on the BASE message too, i.e.
    // it was measuring the CALL SHAPE, not the classifier. Caught by the suite
    // going red on first run, which is the right outcome; the code was fine.
    ok(isTransientLlmError(msg), `sharedbrain still treats the ${label} message as transient`);
    ok(hasTransientMarker(msg), `the CI gate still reads the ${label} message as a provider blip`);
    ok(msg.includes('(HTTP 429)'), `the ${label} message keeps the literal "(HTTP 429)"`);
  }
}

// ═════════════════════════════════════════════════════════════════════════
console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ model-failure UX assertions FAILED'); process.exit(1); }
console.log('✅ All model-failure UX assertions green');
