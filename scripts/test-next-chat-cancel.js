/**
 * test-next-chat-cancel.js — OFFLINE suite for STOPPING a chat turn
 * (src/public/next/views/chat.js).
 *
 * No network, no API key, no server, no browser, no LLM call. The real, live
 * functions (`sendCurrentMessage`, `cancelCurrentSend`, `restoreDraft`,
 * `cancelNoticeHtml`, `composerPrimaryButtonHtml`, `renderComposerBusy`,
 * `wireComposerPrimaryButton`, and the view's real TEARDOWN closure) are
 * extracted from source by brace-matching and executed standalone with
 * `new Function` — the technique scripts/test-next-composer-model.js and
 * scripts/test-next-provider-rows.js use for browser-side code.
 *
 * ── WHY THIS SURFACE EXISTS ──────────────────────────────────────────────
 * Chat was the only long-running LLM surface in the app with no way to stop a
 * turn. A turn can legitimately run for MINUTES (measured: 186s to first byte
 * on one OpenRouter model) and end in a rate-limit error, and until now the
 * composer's only control was a DISABLED spinner — a button that acknowledges
 * it is busy and offers no way out.
 *
 * ── THE CONSTRAINT THAT SHAPES EVERYTHING BELOW ──────────────────────────
 * ONLY AN EXPLICIT CLICK ON STOP MAY ABORT THE FETCH. Not the view teardown,
 * not `onEnter`, not a conversation or domain switch, not any cleanup path.
 * This is not stylistic. An abandoned turn is NOT wasted today: the server
 * writes the conversation to disk after the model returns, so navigating away
 * and coming back still gets you the answer — only the LIVE RENDER is dropped.
 * Wiring the AbortController to teardown would therefore convert "navigate
 * away while you wait" into "silently destroy the paid answer you were waiting
 * for", which is strictly worse than the behaviour it replaced and is
 * unrecoverable. §6 pins this BY EXECUTION.
 *
 * ── WHAT IS ASSERTED, AND HOW ────────────────────────────────────────────
 * Everything below DRIVES the real extracted functions against a fake DOM and
 * a fetch spy, and asserts on what would actually go over the wire and what
 * actually lands in state. Nothing here greps the source for the shape of a
 * fix — a test that proves a line of source exists proves nothing about what
 * it does (CLAUDE.md, v3.0.17). The two source scans that DO exist (§6b, §9b)
 * are CLASS invariants over the whole file, are labelled as scans, and each
 * sits beside an executed assertion rather than standing in for one.
 *
 *   §0  Harness self-check — `ok()` can actually fail, and the sandbox
 *       resolves every binding it needs.
 *   §1  The primary button: Send vs Stop.
 *   §2  The busy repaint — and that Stop is never `disabled`.
 *   §3  The click dispatch: idle sends, busy stops.
 *   §4  A stopped turn, end to end, by execution.
 *   §5  Abort detected from the SIGNAL, not the error's name.
 *   §6  NO TEARDOWN PATH CAN ABORT.
 *   §7  A stop that is no longer on screen renders nothing.
 *   §8  A cancelled FIRST message leaves no phantom conversation.
 *   §9  The notice is a fact, not an error — and is escaped.
 *   §10 STOPPING A STREAMED TURN. With `stream: true` the abort no longer
 *       lands in `res.json()` — it surfaces out of a `reader.read()` inside
 *       shared/sse.js's generator, a different call stack with a different
 *       rejection. Everything §4-§8 guarantee is re-proven there rather than
 *       assumed to carry over, plus: the JSON fallback is still real, a
 *       truncated stream is a failure rather than a blank answer, and the
 *       `.abort(` count is still one now that a second async teardown path
 *       exists.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSseFrames } from '../src/public/next/shared/sse.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHAT_PATH = path.join(ROOT, 'src/public/next/views/chat.js');
const CSS_PATH = path.join(ROOT, 'src/public/next/views/chat.css');
const chatSrc = readFileSync(CHAT_PATH, 'utf8');
const cssSrc = readFileSync(CSS_PATH, 'utf8');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function section(t) { console.log(`\n${t}`); }

// ── Extraction (brace-matched; a desync fails LOUDLY, never silently) ─────
function extractFunction(src, name) {
  const marker = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ${name}\\s*\\(`);
  const m = marker.exec(src);
  if (!m) throw new Error(`extractFunction: "${name}" not found in chat.js`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  let p = src.indexOf('(', start);
  let parenDepth = 0;
  for (; p < src.length; p++) {
    if (src[p] === '(') parenDepth++;
    else if (src[p] === ')') { parenDepth--; if (parenDepth === 0) { p++; break; } }
  }
  let i = src.indexOf('{', p);
  if (i === -1) throw new Error(`extractFunction: "${name}" has no body`);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const extracted = src.slice(start, i).replace(/^export\s+/, '');
  if (!/\n\}$/.test(extracted)) {
    throw new Error(`extractFunction: "${name}" extraction desynced — did not end at a top-level closing brace`);
  }
  return extracted;
}

/** Brace-match an arbitrary block starting at a literal opener. */
function extractBlockAt(src, opener, label) {
  const start = src.indexOf(opener);
  if (start === -1) throw new Error(`extractBlockAt: "${label}" opener not found`);
  let depth = 0, i = src.indexOf('{', start);
  if (i === -1) throw new Error(`extractBlockAt: "${label}" has no body`);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

// The real shell escaper's contract, reproduced faithfully. Deliberately NOT a
// pass-through: §9's positive control proves that a value reaching markup
// UNESCAPED would be observable, so a green there is not vacuous.
function escapeHtmlStub(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const iconStub = (name, size) => `<svg data-icon="${name}" width="${size}"></svg>`;

// ── A fake DOM, only as deep as this surface actually reaches ─────────────
function makeEl(id) {
  return {
    id, value: '', disabled: false, innerHTML: '', className: '', style: {},
    _outer: '', _listeners: [], _focused: 0,
    set outerHTML(v) { this._outer = v; },
    get outerHTML() { return this._outer; },
    addEventListener(type, fn) { this._listeners.push({ type, fn }); },
    focus() { this._focused++; },
    click() { this._listeners.filter(l => l.type === 'click').forEach(l => l.fn({})); },
  };
}
function makeDoc(ids) {
  const els = new Map();
  for (const id of ids) els.set(id, makeEl(id));
  return {
    els,
    getElementById: (id) => els.get(id) || null,
    querySelectorAll: () => [],
  };
}

/**
 * A fetch spy that honours an AbortSignal the way the platform does.
 *
 * ── THE FIXTURE HAD TO GROW A REAL BODY WHEN STREAMING LANDED ────────────
 * It used to return `{ ok, json }` and nothing else — no `headers`, no `body`.
 * That was fine while the send path only ever called `res.json()`. The moment
 * it reads `res.headers.get('content-type')` and `res.body.getReader()`, a
 * fixture without them does not test a fallback, it throws a TypeError — and
 * most of the ~40 assertions that would have died are about CANCELLATION, not
 * about streaming. So every response now carries real headers, and the SSE
 * modes carry a real `ReadableStream`.
 *
 * The JSON modes are KEPT, and are not legacy: a route that does not stream
 * answers with `application/json`, and the client degrading to the original
 * path is a shipping behaviour with its own assertions (§10a).
 *
 * `mode`:
 *   'hang'       — never settles on its own; only an abort ends it.
 *   'bodyHang'   — RESOLVES headers immediately, then `res.json()` hangs. This
 *                  is where a slow turn's time actually goes (fetch resolves on
 *                  HEADERS), and it is the case v3.15.0 measured going wrong.
 *   'ok'         — resolves with `payload` as JSON.
 *   'sse'        — a real event-stream. `payload` is an array of frame objects,
 *                  enqueued in order, then the stream closes.
 *   'sseHang'    — emits `payload`'s frames and then STAYS OPEN. This is the
 *                  shape a real slow turn has while it is still generating,
 *                  and it is where a Stop actually lands.
 */
function makeHeaders(contentType) {
  return { get: (name) => (String(name).toLowerCase() === 'content-type' ? contentType : null) };
}

function makeFetch(mode, payload) {
  const calls = [];
  const fetchImpl = (url, opts) => {
    const signal = opts && opts.signal;
    calls.push({ url, opts, signal, method: opts && opts.method, body: opts && opts.body });
    const abortErr = () => { const e = new Error('The operation was aborted.'); e.name = 'AbortError'; return e; };

    if (mode === 'sse' || mode === 'sseHang') {
      const frames = Array.isArray(payload) ? payload : [];
      const enc = new TextEncoder();
      let cancelled = 0;
      const stream = new ReadableStream({
        start(controller) {
          for (const f of frames) controller.enqueue(enc.encode('data: ' + JSON.stringify(f) + '\n\n'));
          if (mode === 'sse') { controller.close(); return; }
          // 'sseHang': still generating. An abort must be what ends it — the
          // same discipline as 'hang', but landing inside the READ rather than
          // inside `res.json()`.
          if (signal) signal.addEventListener('abort', () => { try { controller.error(abortErr()); } catch { /* already closed */ } });
        },
        cancel() { cancelled++; },
      });
      return Promise.resolve({
        ok: true,
        headers: makeHeaders('text/event-stream; charset=utf-8'),
        body: stream,
        json: async () => { throw new Error('json() must not be called on a streamed response'); },
        _cancelled: () => cancelled,
      });
    }
    if (mode === 'ok') {
      return Promise.resolve({ ok: true, headers: makeHeaders('application/json'), json: async () => payload });
    }
    if (mode === 'bodyHang') {
      return Promise.resolve({
        ok: true,
        headers: makeHeaders('application/json'),
        json: () => new Promise((_res, rej) => {
          // DELIBERATELY NOT an AbortError. v3.15.0 measured an abort landing
          // in a JSON handler and being TRANSLATED into a different error,
          // invisible to a name test — the consequence there being that a
          // cancelled call got retried. If the code under test only looked at
          // `err.name`, this case would go undetected. §5 is this case.
          if (signal) signal.addEventListener('abort', () => rej(new SyntaxError('Unexpected end of JSON input')));
        }),
      });
    }
    return new Promise((_res, rej) => {
      if (signal) signal.addEventListener('abort', () => rej(abortErr()));
    });
  };
  return { calls, fetchImpl };
}

/**
 * Build a sandbox holding the REAL send/cancel machinery, wired to a fake DOM
 * and an injected fetch. Everything the extracted code closes over is a
 * parameter, so nothing here can silently read the real module's state.
 */
function makeSandbox(opts = {}) {
  const doc = makeDoc(['chat-input', 'chat-send-btn']);
  const { calls, fetchImpl } = makeFetch(opts.mode || 'hang', opts.payload);
  const rendered = { thread: 0, threadOpts: [], composerBusy: [], shell: 0, sidebar: 0 };
  const state = {
    sending: false,
    activeDomain: opts.domain || 'articles',
    activeConversationId: opts.conversationId === undefined ? 'conv-1' : opts.conversationId,
    thread: opts.thread || [],
    cancelNotice: null,
    responseStyle: 'balanced',
    modelProvider: null,
    chatModel: null,
    searchQuery: '',
    domains: [],
    selectToken: 0,
  };
  const clock = { started: 0, stopped: 0 };
  const loadCalls = [];

  const paints = [];
  const src =
    'let myMountToken = 1;\n' +
    'let sendAbort = null;\n' +
    'let sendStream = null;\n' +
    extractFunction(chatSrc, 'sendCurrentMessage') + '\n' +
    // The REAL stream consumer, driving the REAL shared/sse.js reader (imported
    // above, not stubbed) — so what is asserted below is the frame parsing that
    // actually ships, including how an abort lands inside it.
    extractFunction(chatSrc, 'consumeChatStream') + '\n' +
    extractFunction(chatSrc, 'cancelCurrentSend') + '\n' +
    extractFunction(chatSrc, 'restoreDraft') + '\n' +
    extractFunction(chatSrc, 'cancelNoticeHtml') + '\n' +
    extractFunction(chatSrc, 'composerPrimaryButtonHtml') + '\n' +
    extractFunction(chatSrc, 'renderComposerBusy') + '\n' +
    extractFunction(chatSrc, 'wireComposerPrimaryButton') + '\n' +
    // The REAL focusComposer, not a stub: it is what the `finally` calls, and
    // "focus comes back after a stop" is one of the properties under test.
    extractFunction(chatSrc, 'focusComposer') + '\n' +
    extractFunction(chatSrc, 'renderComposerHtml') + '\n' +
    'return {\n' +
    '  renderComposerHtml,\n' +
    '  sendCurrentMessage, cancelCurrentSend, restoreDraft, cancelNoticeHtml,\n' +
    '  composerPrimaryButtonHtml, renderComposerBusy, wireComposerPrimaryButton,\n' +
    '  peekAbort: () => sendAbort,\n' +
    '  setAbort: (v) => { sendAbort = v; },\n' +
    '  peekStream: () => sendStream,\n' +
    // The real teardown closure, lifted verbatim out of onEnter and returned
    // so §6 can EXECUTE it rather than read it.
    '  teardown: ' + extractBlockAt(chatSrc, 'return () => {', 'onEnter teardown').replace(/^return /, '') + ',\n' +
    '};';

  const api = new Function(
    'document', 'state', 'fetch', 'isCurrentMount', 'startSendClock', 'stopSendClock',
    'autosize', 'renderThreadOnly', 'renderShell',
    'loadDomainConversations', 'bumpMessageCountForTurn', 'renderSidebarConversationsOnly',
    'escapeHtml', 'icon', 'AbortController', 'bootGate', 'cancelSearchTimer', 'escHandler',
    'closeAllListboxes', 'closeBrowseDialog', 'closeConfirmIfOpen',
    'readSseFrames', 'schedulePaintStream',
    src
  )(
    doc, state, fetchImpl,
    (t) => (opts.isCurrentMount === undefined ? true : opts.isCurrentMount(t)),
    () => { clock.started++; }, () => { clock.stopped++; },
    () => {}, (t, o) => { rendered.thread++; rendered.threadOpts.push(o || null); },
    () => { rendered.shell++; },
    async (...a) => { loadCalls.push(a); }, () => {}, () => { rendered.sidebar++; },
    escapeHtmlStub, iconStub, AbortController,
    null, () => {}, null, () => {}, () => {}, () => {},
    // The REAL reader, so an abort landing inside frame parsing is exercised
    // rather than modelled. The paint is a spy: this suite owns cancellation,
    // not rendering — test-next-chat-streaming.js drives the real painter.
    readSseFrames, (t) => { paints.push(t); },
  );

  return { api, doc, state, calls, clock, rendered, loadCalls, paints };
}

const tick = () => new Promise(r => setTimeout(r, 0));


// ═════════════════════════════════════════════════════════════════════════
section('§0  HARNESS SELF-CHECK — a suite that cannot fail proves nothing');
// ═════════════════════════════════════════════════════════════════════════
// CLAUDE.md v3.18.0 records this repo shipping five real defects to production
// while a suite reported "1982 passed, 0 failed, exit 0" — and records the fix
// for one of those causes REPRODUCING the same cause inside itself, because two
// suites disagreed about `ok()`'s argument order and a reversed signature made
// every literal assertion pass unconditionally. So `ok()` is proven to have a
// failing direction, here, every run.
{
  const before = { p: passed, f: failed };
  ok(true, 'control: ok() records a pass');
  const passMoved = passed === before.p + 1 && failed === before.f;
  // Drive the FALSE direction without polluting the tally.
  const realLog = console.log; console.log = () => {};
  ok(false, 'internal: this assertion is EXPECTED to fail');
  console.log = realLog;
  const failMoved = failed === before.f + 1;
  failed = before.f; passed = before.p + 1;   // restore the tally
  ok(passMoved && failMoved,
    'control: ok() has a real FAILING direction — the argument order is (cond, label), not reversed');
}
{
  // Binding resolution by EXECUTION. A scanner that reads CALLS is blind to a
  // bare identifier READ, and an extracted function whose closure lost a
  // binding dies with a ReferenceError mid-suite while everything before it
  // reported green (measured in test-next-composer-model.js §0b).
  let sandboxErr = null;
  try {
    const s = makeSandbox();
    s.api.composerPrimaryButtonHtml(false);
    s.api.composerPrimaryButtonHtml(true);
    s.api.cancelNoticeHtml();
    s.api.cancelCurrentSend();          // safe with nothing in flight
    s.api.renderComposerBusy(false, 1);
    s.api.wireComposerPrimaryButton();
    s.api.teardown();
  } catch (e) { sandboxErr = e; }
  ok(sandboxErr === null,
    'every extracted function resolves its bindings and runs' + (sandboxErr ? ` — ${sandboxErr.message}` : ''));
}
{
  // AND `sendCurrentMessage` ITSELF, ALL THE WAY THROUGH ITS `finally`.
  //
  // MEASURED, NOT ANTICIPATED: the smoke-check above passed while
  // `sendCurrentMessage` was missing a `focusComposer` binding, because that
  // call lives in the `finally` and nothing above had ever driven the function
  // to completion. §3 then died mid-suite with a raw ReferenceError after 27
  // green assertions — red for the wrong reason, and with no tally. Every exit
  // path is now walked here, before any section depends on one.
  const paths = [
    ['success', async () => {
      const s = makeSandbox({ mode: 'ok', payload: { answer: 'a', conversationId: 'conv-1', citations: [] } });
      s.doc.getElementById('chat-input').value = 'q';
      await s.api.sendCurrentMessage();
    }],
    ['error', async () => {
      const s = makeSandbox({ mode: 'ok', payload: null });
      s.doc.getElementById('chat-input').value = 'q';
      await s.api.sendCurrentMessage();
    }],
    ['cancel', async () => {
      const s = makeSandbox();
      s.doc.getElementById('chat-input').value = 'q';
      const p = s.api.sendCurrentMessage();
      await tick();
      s.api.cancelCurrentSend();
      await p;
    }],
  ];
  for (const [name, run] of paths) {
    let err = null;
    try { await run(); } catch (e) { err = e; }
    ok(err === null, `sendCurrentMessage completes its ${name} path with every binding resolved` +
      (err ? ` — ${err.name}: ${err.message}` : ''));
  }
}


// ═════════════════════════════════════════════════════════════════════════
section('§1  THE PRIMARY BUTTON — Send, or Stop');
// ═════════════════════════════════════════════════════════════════════════
{
  const s = makeSandbox();
  const idle = s.api.composerPrimaryButtonHtml(false);
  const busy = s.api.composerPrimaryButtonHtml(true);

  ok(/id="chat-send-btn"/.test(idle) && /id="chat-send-btn"/.test(busy),
    'ONE element in both states — same id, so a repaint cannot leave two live buttons');
  ok(/aria-label="Send"/.test(idle), 'idle: announced as Send');
  ok(/aria-label="Stop"/.test(busy), 'busy: announced as Stop — not a Send button wearing a square');
  ok(!/aria-label="Send"/.test(busy), 'busy: does NOT still announce Send');
  ok(/chat-send-btn-stop/.test(busy) && !/chat-send-btn-stop/.test(idle),
    'busy carries its own class, idle does not');
  ok(/title="Stop this answer"/.test(busy), 'busy: the tooltip says what the click does');

  // THE DEFECT THIS WHOLE CHANGE REMOVES. A `disabled` attribute here is the
  // pre-change behaviour — a control that acknowledges a minutes-long wait and
  // offers no way out.
  ok(!/disabled/.test(busy), 'busy is NOT disabled — it is the one control that must be clickable');
  ok(!/<span class="chat-spinner">/.test(busy), 'the disabled spinner is gone from the button');

  ok(/chat-stop-glyph/.test(busy), 'busy renders the CSS square');
  ok(/aria-hidden="true"/.test(busy), 'the glyph is hidden from assistive tech — the aria-label carries the meaning');
  ok(/data-icon="send"/.test(idle), 'idle still renders the real send icon');
  // `icon()` answers an unknown name with a console error and a missing-icon
  // placeholder, and app.js (which owns ICON_BODY) is not this view's file.
  ok(!/data-icon="stop"/.test(busy) && !/data-icon="square"/.test(busy),
    'busy does NOT call icon() with a name app.js does not define');
}
{
  // The builder is the ONLY producer. Two copies of "what does this button look
  // like now" is how a repaint silently drops a control — and the control it
  // would drop here is the only way to stop a paid call.
  // ENFORCED: no second hand-built `chat-send-btn` element anywhere in the file.
  // NOT ENFORCED (source scan): a copy built under a different class name.
  const literals = chatSrc.match(/'<button class="chat-send-btn/g) || [];
  ok(literals.length === 1,
    `exactly one place builds this button (found ${literals.length})`);
  const builder = extractFunction(chatSrc, 'composerPrimaryButtonHtml');
  ok(/<button class="chat-send-btn/.test(builder), 'and that place is composerPrimaryButtonHtml');
}


// ═════════════════════════════════════════════════════════════════════════
section('§2  THE BUSY REPAINT — executed against a real element');
// ═════════════════════════════════════════════════════════════════════════
{
  const s = makeSandbox();
  const btn = s.doc.getElementById('chat-send-btn');
  const ta = s.doc.getElementById('chat-input');

  s.api.renderComposerBusy(true, 1);
  ok(btn.disabled === false, 'busy: the button is left ENABLED (this is the fix)');
  ok(/aria-label="Stop"/.test(btn.outerHTML), 'busy: the element is rewritten to the Stop button');
  ok(ta.disabled === true, 'busy: the textarea is disabled, exactly as before this change');

  s.api.renderComposerBusy(false, 1);
  ok(btn.disabled === false && /aria-label="Send"/.test(btn.outerHTML), 'idle: back to Send, enabled');
  ok(ta.disabled === false, 'idle: the textarea is usable again');
}
{
  // outerHTML replacement DROPS the element's listeners with it. If the repaint
  // did not re-bind, the button would be a live-looking control bound to
  // nothing — the inert-control defect this repo has recorded twice, arriving
  // through a new door.
  const s = makeSandbox();
  const btn = s.doc.getElementById('chat-send-btn');
  const before = btn._listeners.length;
  s.api.renderComposerBusy(true, 1);
  ok(btn._listeners.length === before + 1,
    'the repaint RE-BINDS the click handler it just replaced');
}
{
  // The mount guard on this function is pre-existing and load-bearing (it
  // reaches into the DOM directly, bypassing setMain's guard). Proven still
  // live rather than assumed.
  const s = makeSandbox({ isCurrentMount: () => false });
  const ta = s.doc.getElementById('chat-input');
  s.api.renderComposerBusy(true, 1);
  ok(ta.disabled === false, 'control: a dead mount still paints nothing (the H1 guard survives)');
}


{
  // ── THE MID-TURN FULL REPAINT ────────────────────────────────────────
  // `selectConversation`, `switchDomain` and `startNewChat` all call
  // renderShell, which rebuilds the whole composer from scratch — and any of
  // them can happen WHILE a turn is in flight. Before this change the composer
  // always came back as an enabled Send that `sendCurrentMessage` then silently
  // refused: the inert-control defect, on the app's most-used surface.
  const s = makeSandbox();
  const active = { slug: 'articles', displayName: 'Articles', pageCount: 10 };

  s.state.sending = false;
  const idle = s.api.renderComposerHtml(active);
  ok(/aria-label="Send"/.test(idle), 'a full repaint while idle paints Send');
  ok(!/<textarea[^>]*disabled/.test(idle), 'and an enabled textarea');

  s.state.sending = true;
  const busy = s.api.renderComposerHtml(active);
  ok(/aria-label="Stop"/.test(busy),
    'a full repaint MID-TURN paints Stop — the turn stays stoppable across a conversation switch');
  ok(!/aria-label="Send"/.test(busy), 'and does NOT paint an inert Send the send path would silently refuse');
  ok(/<textarea[^>]*disabled/.test(busy), 'and the textarea comes back disabled, matching the live state');
}


// ═════════════════════════════════════════════════════════════════════════
section('§3  THE CLICK DISPATCH — one button, two jobs');
// ═════════════════════════════════════════════════════════════════════════
{
  const s = makeSandbox();
  const btn = s.doc.getElementById('chat-send-btn');
  const ta = s.doc.getElementById('chat-input');
  ta.value = 'hello';
  s.api.wireComposerPrimaryButton();

  s.state.sending = false;
  btn.click();
  await tick();
  ok(s.calls.length === 1, 'idle: a click SENDS');

  // A turn is now in flight. The same element, the same listener.
  ok(s.state.sending === true, 'control: the send really is in flight');
  const ctrl = s.api.peekAbort();
  ok(ctrl && ctrl.controller instanceof AbortController, 'and an abort handle was recorded for it');
  ok(ctrl.controller.signal.aborted === false, 'control: not aborted yet');

  btn.click();
  await tick();
  ok(s.calls.length === 1, 'busy: a click does NOT start a second turn');
  ok(ctrl.controller.signal.aborted === true, 'busy: a click ABORTS the turn in flight');
}
{
  // ⌘/Ctrl+Enter is a SEND shortcut and deliberately does not become a hidden
  // cancel shortcut. Nothing to assert by execution beyond the dispatch above —
  // recorded here so the absence is a decision, not an omission.
  const wire = extractFunction(chatSrc, 'wireComposer');
  ok(/metaKey \|\| e\.ctrlKey/.test(wire) && !/cancelCurrentSend/.test(wire),
    'the keyboard shortcut still only ever sends — stopping is a deliberate, visible click');
}


// ═════════════════════════════════════════════════════════════════════════
section('§4  A STOPPED TURN, END TO END');
// ═════════════════════════════════════════════════════════════════════════
{
  const s = makeSandbox({ thread: [{ role: 'assistant', content: 'earlier answer' }] });
  const ta = s.doc.getElementById('chat-input');
  ta.value = '  what does my wiki say about RAG?  ';

  const p = s.api.sendCurrentMessage();
  await tick();

  // What actually goes over the wire.
  ok(s.calls.length === 1, 'one request went out');
  ok(s.calls[0].signal instanceof AbortSignal, 'the request CARRIES an AbortSignal — this is what cancels the server work');
  ok(s.calls[0].method === 'POST', 'control: it is the real POST, not a stubbed shape');
  ok(JSON.parse(s.calls[0].body).message === 'what does my wiki say about RAG?',
    'control: the trimmed message really was sent');
  ok(s.state.thread.length === 2 && s.state.thread[1].role === 'user',
    'the optimistic user bubble is on screen while it runs');
  ok(ta.value === '', 'and the composer was cleared, as before');
  ok(s.clock.started === 1, 'the elapsed clock started');

  s.api.cancelCurrentSend();
  await p;

  ok(s.state.sending === false, 'STOP: the send-lock is released');
  ok(s.clock.stopped >= 1, 'STOP: the elapsed clock is stopped — no timer outlives its turn');
  ok(s.api.peekAbort() === null, 'STOP: the abort record is cleared, so nothing dangles');
  ok(s.doc.getElementById('chat-input').disabled === false, 'STOP: the composer is usable again');
  ok(s.doc.getElementById('chat-input')._focused > 0, 'STOP: focus returns to the composer');

  // NOTHING PERSISTED SERVER-SIDE, so nothing may be left claiming otherwise.
  ok(s.state.thread.length === 1, 'STOP: the optimistic user bubble is REMOVED — the server saved nothing');
  ok(s.state.thread[0].content === 'earlier answer', 'and the real history before it is untouched');
  ok(!s.state.thread.some(m => m.error), 'STOP: NO error message is pushed — a cancel is a normal outcome');

  ok(ta.value === 'what does my wiki say about RAG?', 'STOP: the typed message is back in the composer, not lost');
  ok(s.state.cancelNotice && /Stopped/.test(s.state.cancelNotice.text), 'STOP: a notice is recorded');
  ok(/back in the composer/.test(s.state.cancelNotice.text),
    'and the notice states the restore that actually happened');
}
{
  // The notice must describe what HAPPENED, never what was intended. If the
  // composer is not empty the draft is not clobbered — so the sentence must not
  // promise a restore.
  const s = makeSandbox();
  s.doc.getElementById('chat-input').value = 'a newer draft';
  const text = s.api.restoreDraft('the stopped message');
  ok(s.doc.getElementById('chat-input').value === 'a newer draft',
    'a non-empty composer is NEVER clobbered by the restore');
  ok(!/back in the composer/.test(text), 'and the notice does not claim a restore that did not happen');
  ok(/Stopped/.test(text) && /Nothing was saved/.test(text), 'it still states both facts that are true');
}
{
  const s = makeSandbox();
  const text = s.api.restoreDraft('recovered');
  ok(s.doc.getElementById('chat-input').value === 'recovered', 'an empty composer DOES get the message back');
  ok(/back in the composer/.test(text), 'and the notice says so');
}
{
  // A new turn supersedes the old notice — "stopped" and "thinking" must never
  // be on screen together.
  const s = makeSandbox();
  s.state.cancelNotice = { text: 'Stopped. Nothing was saved.' };
  s.doc.getElementById('chat-input').value = 'next question';
  s.api.sendCurrentMessage();
  await tick();
  ok(s.state.cancelNotice === null, 'starting a new turn clears the previous Stop notice');
  ok(s.state.sending === true, 'control: that turn really did start');
}


// ═════════════════════════════════════════════════════════════════════════
section('§5  DETECTED FROM THE SIGNAL, NOT THE ERROR NAME');
// ═════════════════════════════════════════════════════════════════════════
// fetch resolves on HEADERS, so on a slow turn the remaining minutes are spent
// inside `res.json()`. v3.15.0 measured an abort landing there being TRANSLATED
// into a different error, invisible to a name test — and the consequence was
// that a cancelled call got retried. Here the same mistake would render a
// DANGER-RED "Unexpected end of JSON input" for something the user did on
// purpose. The fixture rejects with a SyntaxError, never an AbortError.
{
  const s = makeSandbox({ mode: 'bodyHang' });
  s.doc.getElementById('chat-input').value = 'ask';
  const p = s.api.sendCurrentMessage();
  await tick();
  const ctrl = s.api.peekAbort().controller;
  s.api.cancelCurrentSend();
  await p;

  ok(ctrl.signal.aborted === true, 'control: the fixture really did abort during the BODY read');
  ok(!s.state.thread.some(m => m.error),
    'an abort translated into a SyntaxError is STILL recognised as a stop, not rendered as an error');
  ok(s.state.cancelNotice !== null, 'and it produces the ordinary Stop notice');
  ok(s.state.thread.length === 0, 'and still removes the unsaved user bubble');
}
{
  // The other direction: a GENUINE failure must still be an error. Without this
  // the section above could be satisfied by code that swallows everything.
  const s = makeSandbox({ mode: 'ok', payload: null });
  s.doc.getElementById('chat-input').value = 'ask';
  // `json()` resolves to null -> the real code throws on `data.error` access.
  await s.api.sendCurrentMessage();
  ok(s.state.thread.some(m => m.error),
    'POSITIVE CONTROL: a real failure is still rendered as an error');
  ok(s.state.cancelNotice === null, 'and produces no Stop notice');
}


// ═════════════════════════════════════════════════════════════════════════
section('§6  NO TEARDOWN PATH CAN ABORT  ★ the constraint');
// ═════════════════════════════════════════════════════════════════════════
// A turn can run for minutes and people navigate away while they wait. An
// abandoned turn is NOT wasted: the server writes the conversation after the
// model returns, so the answer is recovered by re-opening it — only the live
// render is dropped. Aborting on teardown would destroy a paid answer instead.
{
  const s = makeSandbox();
  s.doc.getElementById('chat-input').value = 'a long question';
  s.api.sendCurrentMessage();
  await tick();
  const ctrl = s.api.peekAbort().controller;
  ok(ctrl.signal.aborted === false, 'control: a turn is genuinely in flight');

  // THE REAL TEARDOWN CLOSURE, lifted verbatim out of onEnter and EXECUTED.
  s.api.teardown();
  await tick();

  ok(ctrl.signal.aborted === false,
    '★ tearing the view down mid-flight does NOT abort the request');
  ok(s.calls.length === 1 && s.calls[0].signal.aborted === false,
    '★ and the in-flight request itself is still un-aborted — the turn survives navigation');
  ok(s.api.peekAbort() !== null,
    'the abort handle also SURVIVES teardown, so the turn stays stoppable if the user returns');

  // And Stop still works afterwards — the capability was not merely left
  // unused, it was left intact.
  s.api.cancelCurrentSend();
  ok(ctrl.signal.aborted === true, 'an explicit Stop after a teardown still aborts');
}
{
  // §6b — CLASS INVARIANT over the whole file.
  // ENFORCED: `.abort(` appears at exactly one call site, inside
  // `cancelCurrentSend`. That catches an abort added to the teardown, to
  // onEnter, to switchDomain, to selectConversation, or anywhere else — not
  // just the paths §6a happens to execute.
  // NOT ENFORCED, and said plainly: this is a SOURCE scan. It cannot see an
  // abort reached through an alias (`const a = c.abort; a()`), nor one issued
  // from another module. That is why §6a EXECUTES the teardown rather than
  // trusting this. The pair is the guarantee, not either half.
  const sites = [...chatSrc.matchAll(/\.abort\s*\(/g)];
  ok(sites.length === 1, `exactly one .abort( call site in chat.js (found ${sites.length})`);
  const cancelFn = extractFunction(chatSrc, 'cancelCurrentSend');
  ok(/\.abort\s*\(/.test(cancelFn), 'and it is inside cancelCurrentSend — the Stop button is its only caller');

  const teardown = extractBlockAt(chatSrc, 'return () => {', 'onEnter teardown');
  ok(!/abort/i.test(teardown), 'the teardown block mentions abort nowhere at all');
  ok(/closeAllListboxes\(\)/.test(teardown), 'control: the extracted block really is the teardown');
}


// ═════════════════════════════════════════════════════════════════════════
section('§7  A STOP THAT IS NO LONGER ON SCREEN RENDERS NOTHING');
// ═════════════════════════════════════════════════════════════════════════
// The composer stays live during the call, so the user can switch conversation
// mid-turn and still reach Stop. The abort must happen (that is what they
// asked for) — but restoring the draft into a DIFFERENT conversation's composer
// would arm the wrong thread with someone else's message.
{
  const s = makeSandbox({ conversationId: 'conv-1' });
  const ta = s.doc.getElementById('chat-input');
  ta.value = 'a question about conversation one';
  const p = s.api.sendCurrentMessage();
  await tick();
  const ctrl = s.api.peekAbort().controller;

  s.state.activeConversationId = 'conv-2';       // the user moved on
  s.state.thread = [{ role: 'assistant', content: 'conv-2 history' }];
  ta.value = '';

  s.api.cancelCurrentSend();
  await p;

  ok(ctrl.signal.aborted === true, 'the abort still happens — stopping the spend is what was asked for');
  ok(s.state.cancelNotice === null, 'but NO notice is painted into the conversation now on screen');
  ok(ta.value === '', 'and the other conversation\'s composer is NOT armed with the stopped message');
  ok(s.state.thread.length === 1 && s.state.thread[0].content === 'conv-2 history',
    'and the thread now on screen is untouched');
  ok(s.state.sending === false && s.api.peekAbort() === null, 'the turn still unwinds cleanly');
}
{
  // Same rule across a REMOUNT.
  let live = true;
  const s = makeSandbox({ isCurrentMount: () => live });
  s.doc.getElementById('chat-input').value = 'q';
  const p = s.api.sendCurrentMessage();
  await tick();
  live = false;                                  // a different mount now owns the screen
  s.api.cancelCurrentSend();
  await p;
  ok(s.state.cancelNotice === null, 'a stop resolving on a dead mount paints no notice');
  ok(s.state.sending === false, 'but the send-lock is still released — it must never stick true');
}


// ═════════════════════════════════════════════════════════════════════════
section('§8  A CANCELLED FIRST MESSAGE LEAVES NO PHANTOM');
// ═════════════════════════════════════════════════════════════════════════
// Stopping the very first message of a brand-new conversation must not leave a
// sidebar row, or an activeConversationId, pointing at something that was never
// written. `writeConversation` runs only after the model returns.
{
  const s = makeSandbox({ conversationId: null, thread: [] });
  const ta = s.doc.getElementById('chat-input');
  ta.value = 'the very first message';
  const p = s.api.sendCurrentMessage();
  await tick();
  ok(s.state.thread.length === 1, 'control: the optimistic bubble was shown');

  s.api.cancelCurrentSend();
  await p;

  ok(s.state.activeConversationId === null,
    'no conversation id is adopted — nothing was created on disk');
  ok(s.state.thread.length === 0, 'the thread is empty again, matching the (absent) file');
  ok(s.loadCalls.length === 0,
    'the sidebar is NOT refreshed into showing a row for a conversation that does not exist');
  ok(s.rendered.sidebar === 0, 'and no sidebar row was patched in either');
  ok(ta.value === 'the very first message', 'the message is recoverable from the composer');
}
{
  // POSITIVE CONTROL. Without this, §8 could be satisfied by a send path that
  // never creates conversations at all.
  const s = makeSandbox({
    mode: 'ok', conversationId: null, thread: [],
    payload: { answer: 'hi', conversationId: 'new-id', isNew: true, citations: [] },
  });
  s.doc.getElementById('chat-input').value = 'first';
  await s.api.sendCurrentMessage();
  ok(s.state.activeConversationId === 'new-id',
    'POSITIVE CONTROL: a turn allowed to FINISH does adopt the new conversation');
  ok(s.loadCalls.length === 1, 'and does refresh the sidebar to show its new row');
}


// ═════════════════════════════════════════════════════════════════════════
section('§9  THE NOTICE IS A FACT, NOT AN ERROR');
// ═════════════════════════════════════════════════════════════════════════
{
  const s = makeSandbox();
  ok(s.api.cancelNoticeHtml() === '', 'no notice, no markup');
  s.state.cancelNotice = { text: '' };
  ok(s.api.cancelNoticeHtml() === '', 'an empty notice renders nothing rather than an empty box');

  s.state.cancelNotice = { text: 'Stopped. Nothing was saved.' };
  const html = s.api.cancelNoticeHtml();
  ok(/chat-stopped-note/.test(html), 'it renders in its own class');
  ok(/role="status"/.test(html), 'announced politely to assistive tech — it is information, not an alert');
  ok(!/role="alert"/.test(html), 'and NOT as an alert');
  ok(!/data-icon=/.test(html), 'no icon — the v3.13.2 rule: state the fact, do not decorate it');
  ok(!/chat-msg-error|danger/.test(html), 'and none of the danger-red error treatment');
  ok(!/chat-msg\b/.test(html), 'not dressed as a message either — nothing was persisted');
}
{
  // The text is escaped. It is app-authored today, but the rule this file lives
  // by is escape-first at the boundary, not "audit every producer forever".
  const s = makeSandbox();
  s.state.cancelNotice = { text: '<img src=x onerror=alert(1)>' };
  const html = s.api.cancelNoticeHtml();
  ok(!/<img/.test(html), 'the notice text is escaped');
  ok(/&lt;img/.test(html), 'POSITIVE CONTROL: the payload really did reach the markup, escaped');
}
{
  // §9b — the notice must actually be RENDERED, in BOTH thread branches. A
  // notice computed and never painted is the dead-data shape CLAUDE.md records
  // this repo shipping repeatedly (v3.9.0 finding 7, v3.17.1 finding 3).
  // ENFORCED: both call sites exist in renderThreadOnly, one of them inside the
  // empty-thread early return — which is the branch a stopped FIRST message
  // lands in, and therefore the one most likely to be forgotten.
  // NOT ENFORCED (source scan): that either call site is reachable at runtime.
  const fn = extractFunction(chatSrc, 'renderThreadOnly');
  const sites = [...fn.matchAll(/cancelNoticeHtml\(\)/g)];
  ok(sites.length === 2, `renderThreadOnly paints the notice in both branches (found ${sites.length})`);
  const earlyReturn = fn.slice(0, fn.indexOf('    return;'));
  ok(/cancelNoticeHtml\(\)/.test(earlyReturn),
    'including the EMPTY-THREAD branch — where a stopped first message ends up');
}
{
  // The styling is recessed, not danger. Checked against the stylesheet rather
  // than assumed: an undefined custom property fails SILENTLY (the whole
  // declaration becomes invalid), which is how this repo shipped a whole
  // unstyled component once.
  const rule = /\.chat-stopped-note\s*\{([^}]*)\}/.exec(cssSrc);
  ok(rule !== null, 'the notice has a rule in chat.css');
  // --text-2, NOT --text-3. Measured in a real browser: --text-3 puts this note
  // at 4.38:1 (dark) / 4.00:1 (light), under the 4.5:1 AA floor — and this
  // sentence is the only thing on screen saying where the user's message went,
  // so it has to be readable. Same finding, same answer, as v3.17.1.
  ok(/var\(--text-2\)/.test(rule[1]), 'the notice text is --text-2, which measures over the AA floor');
  ok(!/var\(--text-3\)/.test(rule[1]), 'and NOT --text-3, which measured 4.38:1 / 4.00:1 — under AA');
  ok(!/danger|--attention/.test(rule[1]), 'not the danger or attention palette');
  const stop = /\.chat-send-btn-stop\s*\{([^}]*)\}/.exec(cssSrc);
  ok(stop !== null && !/danger/.test(stop[1]),
    'and the Stop button is not danger-red either — stopping your own answer is normal');
  ok(/\.chat-stop-glyph\s*\{/.test(cssSrc), 'the CSS square the button relies on really exists');
}


// ═════════════════════════════════════════════════════════════════════════
section('§10  STOPPING A STREAMED TURN  ★ the abort now lands somewhere else');
// ═════════════════════════════════════════════════════════════════════════
// Every section above drives the JSON path, where an abort surfaces out of
// `res.json()`. On a streamed turn it surfaces out of a `reader.read()` inside
// shared/sse.js's generator instead — a different call stack, a different
// rejection, and a `finally` that cancels the reader on the way out. The
// guarantee has to be re-proven there, not assumed to carry over.
{
  // §10a — the fallback is real, not theoretical. A route that answers with
  // JSON is still served by the original path, byte-for-byte.
  const s = makeSandbox({
    mode: 'ok',
    payload: { answer: 'from the json path', conversationId: 'conv-1', citations: [] },
  });
  s.doc.getElementById('chat-input').value = 'q';
  await s.api.sendCurrentMessage();
  ok(JSON.parse(s.calls[0].body).stream === true, 'the request ASKS for a stream');
  ok(s.state.thread.some(m => m.content === 'from the json path'),
    '§10a but a JSON response is still answered by the original path — the ask is not a version check');
  ok(s.paints.length === 0, 'and nothing was painted as a stream');
}
{
  // §10b — a complete streamed turn lands in the thread from `done`, and the
  // deltas that preceded it leave no trace in `state.thread`.
  const s = makeSandbox({
    mode: 'sse',
    payload: [
      { type: 'reasoning', text: 'weighing sources' },
      { type: 'content', text: 'The answer is ' },
      { type: 'content', text: 'forty-two.' },
      { type: 'done', answer: 'The answer is forty-two.', conversationId: 'conv-1', citations: ['entities/x.md'] },
    ],
  });
  s.doc.getElementById('chat-input').value = 'q';
  await s.api.sendCurrentMessage();
  const answers = s.state.thread.filter(m => m.role === 'assistant');
  ok(answers.length === 1, '§10b exactly ONE assistant entry — the deltas were never thread entries');
  ok(answers[0].content === 'The answer is forty-two.', 'and it is `done.answer`, verbatim');
  ok(s.paints.length > 0, 'control: the deltas really did drive paints');
  ok(s.state.sending === false && s.api.peekAbort() === null && s.api.peekStream() === null,
    'and the turn unwound cleanly — no dangling abort handle, no dangling buffers');
}
{
  // §10c ★ — STOP, MID-STREAM, AFTER TEXT HAS ALREADY ARRIVED ON SCREEN.
  // This is the case with the most to go wrong: there is visible content, and
  // none of it was persisted. The thread must come back byte-identical to
  // before the send.
  const s = makeSandbox({
    mode: 'sseHang',
    thread: [{ role: 'assistant', content: 'earlier answer' }],
    payload: [
      { type: 'reasoning', text: 'I should check the wiki first' },
      { type: 'content', text: 'Partial ans' },
    ],
  });
  const ta = s.doc.getElementById('chat-input');
  ta.value = 'what does my wiki say?';
  const p = s.api.sendCurrentMessage();
  await tick(); await tick();

  const rec = s.api.peekStream();
  ok(!!rec && rec.seen === true, 'control: deltas really did arrive before the Stop');
  ok(rec.reasoning === 'I should check the wiki first', 'control: the reasoning buffer filled');
  ok(rec.content === 'Partial ans', 'control: a partial answer was on screen');
  const ctrl = s.api.peekAbort().controller;

  s.api.cancelCurrentSend();
  await p;

  ok(ctrl.signal.aborted === true, '★ Stop aborts a streamed turn — the abort lands inside the READ');
  ok(!s.state.thread.some(m => m.error),
    '★ an abort surfacing out of the SSE reader is a STOP, not an error');
  ok(s.state.thread.length === 1 && s.state.thread[0].content === 'earlier answer',
    '★ the thread is byte-identical to before the send — no user bubble, no partial answer');
  ok(!JSON.stringify(s.state.thread).includes('Partial ans'),
    '★ and the partial text that WAS on screen is nowhere in the persisted thread');
  ok(ta.value === 'what does my wiki say?', 'the draft is handed back');
  ok(s.state.cancelNotice !== null, 'and the ordinary Stop notice is recorded');
  ok(s.api.peekStream() === null, 'the stream buffers are released');
  ok(s.state.sending === false, 'and the send-lock is released');
}
{
  // §10d — a stream that simply STOPS (no `done`, no `error`) is a failure.
  // Returning something falsy here would push a blank assistant bubble and
  // persist the silence as if it were a reply.
  const s = makeSandbox({
    mode: 'sse',
    payload: [{ type: 'content', text: 'half an ans' }],
  });
  s.doc.getElementById('chat-input').value = 'q';
  await s.api.sendCurrentMessage();
  const errs = s.state.thread.filter(m => m.error);
  ok(errs.length === 1, '§10d a truncated stream is reported as a failure');
  ok(/closed before the answer/.test(errs[0].error), 'and the message says what happened');
  ok(!s.state.thread.some(m => m.role === 'assistant' && m.content === 'half an ans'),
    'and the half-answer is NOT persisted as if it were the reply');
}
{
  // §10e — an `error` frame carries the server's own message through.
  const s = makeSandbox({
    mode: 'sse',
    payload: [{ type: 'error', message: 'Rate limited. Please wait 5 seconds.' }],
  });
  s.doc.getElementById('chat-input').value = 'q';
  await s.api.sendCurrentMessage();
  ok(s.state.thread.some(m => m.error === 'Rate limited. Please wait 5 seconds.'),
    '§10e an error frame becomes the rendered failure, with the server\'s wording intact');
}
{
  // §10f — the SEND render is the one that forces a scroll. Everything else
  // follows the reader; pressing Send is a deliberate act whose result the
  // user is waiting for.
  const s = makeSandbox({ mode: 'hang' });
  s.doc.getElementById('chat-input').value = 'q';
  s.api.sendCurrentMessage();
  await tick();
  ok(s.rendered.threadOpts[0] && s.rendered.threadOpts[0].stick === true,
    '§10f the send\'s own render forces a scroll to the bottom');
  s.api.cancelCurrentSend();
}
{
  // §10g — CLASS SCAN, labelled as one. `reader.cancel()` inside shared/sse.js
  // is NOT an abort, and adding a real one anywhere would break the guarantee
  // §6 exists for. The count must stay at one even now that a second async
  // teardown path (the stream reader) exists.
  const sites = [...chatSrc.matchAll(/\.abort\s*\(/g)];
  ok(sites.length === 1, `§10g still exactly one .abort( call site with streaming landed (found ${sites.length})`);
  const consume = extractFunction(chatSrc, 'consumeChatStream');
  ok(!/abort/i.test(consume), 'the stream consumer mentions abort nowhere — it only ever propagates one');
}

// ═════════════════════════════════════════════════════════════════════════
console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) {
  console.log('❌ chat-cancel assertions FAILED');
  process.exit(1);
}
console.log('✅ All chat-cancel assertions green');
