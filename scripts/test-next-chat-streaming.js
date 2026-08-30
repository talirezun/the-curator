/**
 * test-next-chat-streaming.js — OFFLINE suite for STREAMED CHAT TURNS
 * (src/public/next/views/chat.js).
 *
 * No network, no API key, no server, no browser, no LLM call. The real, live
 * functions — `renderThreadOnly`, `sendIsOnScreen`, `paintStream`,
 * `wireStreamToggle`, `streamSlotHtml`, `isThreadAtBottom` — are extracted
 * from source by brace-matching and executed against a fake DOM, the technique
 * scripts/test-next-chat-cancel.js and scripts/test-next-composer-model.js use
 * for browser-side code.
 *
 * ── WHAT STREAMING IS ACTUALLY FOR, MEASURED ─────────────────────────────
 * A turn on `z-ai/glm-5.3-flash` takes 45-99s. Streaming the ANSWER alone
 * fixes almost none of that: the first CONTENT delta arrives at 86-91% of the
 * way through. What removes the dead air is rendering the REASONING, which
 * starts at ~460-1,100ms. So the reasoning region is the feature, and the
 * answer draft is the tail end of it.
 *
 * ── THE FOUR RULES THIS SUITE EXISTS TO ENFORCE ──────────────────────────
 *
 * 1. THE AUTHORITATIVE-RETURN RULE. `done.answer` is the complete answer;
 *    content deltas are a PREVIEW of it. The thread entry REPLACES the draft
 *    and never appends to it. Appending would double every answer AND lose
 *    the truncation note, which src/brain/llm.js appends to the finished
 *    string and which therefore exists only in `done.answer`, never as a
 *    delta. §4 drives exactly that case.
 *
 * 2. THE STREAMING BUBBLE IS TRANSIENT DOM, NEVER `state.thread`. Not for
 *    tidiness: `sendCurrentMessage`'s abort unwind pops the optimistic user
 *    bubble only when it is the LAST thread entry, so an assistant
 *    placeholder would leave a phantom user message after a Stop.
 *    test-next-chat-cancel.js §4 asserts `thread.length === 1` after a Stop
 *    and would go red; §2 here asserts the absence directly.
 *
 * 3. IDENTITY, NOT A BOOLEAN. The bubble used to render from `state.sending`,
 *    a bare global with no conversation and no domain attached. Send in
 *    conversation A, click B, and B showed a spinner for A's turn. Survivable
 *    for a spinner; not survivable once the bubble carries the model's
 *    reasoning and a draft answer, which is another conversation's CONTENT
 *    appearing in the thread you are reading. §1 drives all four ways the
 *    identity can diverge.
 *
 * 4. NEVER `renderThreadOnly` PER TOKEN. It is a full-thread `innerHTML`
 *    wipe that re-binds every listener and (before this change) forced a
 *    scroll. At 31-38 chunks/second that rebuilds every historical message
 *    dozens of times a second, orphans and re-binds every listener, destroys
 *    text selection every frame, and pins the reader to the bottom so they
 *    cannot read back. §3 proves the fast path touches two text nodes.
 *
 *   §0  Harness self-check — `ok()` can fail, and every binding resolves.
 *   §1  THE IDENTITY GATE (rule 3), driven four ways.
 *   §2  The bubble is transient DOM (rule 2).
 *   §3  The fast path: two textContent writes, no thread rebuild (rule 4).
 *   §4  REPLACE, NEVER APPEND (rule 1) — including the truncation note.
 *   §5  Scrolling: follow the reader, do not drag them.
 *   §6  The reasoning fold is a real, working control.
 *   §7  Citations are wired on the terminal frame only.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { progressRingHtml } from '../src/public/next/shared/progress-ring.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHAT_JS = path.join(ROOT, 'src/public/next/views/chat.js');
const chatSrc = readFileSync(CHAT_JS, 'utf8');

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
  if (!/\n\}$/.test(extracted)) throw new Error(`extractFunction: "${name}" extraction desynced`);
  return extracted;
}
const constOf = (name) => {
  const m = new RegExp(`const ${name} = (\\d+);`).exec(chatSrc);
  if (!m) throw new Error(`constant ${name} not found in chat.js`);
  return m[1];
};

/** The real shell escaper's contract. NOT a pass-through — §2's positive
 *  control proves an unescaped value would be observable. */
function escapeHtmlStub(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const summarySrc = readFileSync(path.join(ROOT, 'src/public/next/shared/model-summary.js'), 'utf8');
const formatDurationMs = new Function(
  extractFunction(summarySrc, 'formatDurationMs') + '\nreturn formatDurationMs;'
)();

// ─────────────────────────────────────────────────────────────────────────
// A fake DOM that models the ONE property these assertions are about: which
// nodes the code creates, and what it writes into them.
//
// `innerHTML` re-indexes the ids and attributes present in the markup, so
// `getElementById('chat-stream-reasoning')` after a render returns a node whose
// `textContent` is what was rendered — which is exactly what lets §3 tell a
// two-textContent-writes patch apart from a re-render. Synthetic children are
// CACHED per innerHTML value, so a listener bound in one call is reachable from
// the click in the next; that identity is what §6 depends on.
// ─────────────────────────────────────────────────────────────────────────
function makeEl(id, doc) {
  return {
    id, _doc: doc, textContent: '', className: '', _html: '', _attrs: {},
    _listeners: [], _children: null, _writes: 0,
    scrollTop: 0, scrollHeight: 0, clientHeight: 0,
    get innerHTML() { return this._html; },
    set innerHTML(v) {
      this._html = String(v);
      this._children = null;
      this._writes++;
      if (this._doc) this._doc._reindex(this._html);
    },
    getAttribute(n) { return Object.hasOwn(this._attrs, n) ? this._attrs[n] : null; },
    setAttribute(n, v) { this._attrs[n] = String(v); },
    addEventListener(t, f) { this._listeners.push({ t, f }); },
    click() { this._listeners.filter(l => l.t === 'click').forEach(l => l.f({})); },
    querySelector() { return null; },
    querySelectorAll(sel) {
      if (!this._children) this._children = new Map();
      if (!this._children.has(sel)) this._children.set(sel, synthesise(this._html, sel));
      return this._children.get(sel);
    },
  };
}

/** Build synthetic elements for the attribute selectors this view uses. */
function synthesise(html, sel) {
  const attr = /^\[([a-z-]+)\]$/.exec(sel);
  const out = [];
  if (attr) {
    const re = new RegExp(attr[1] + '="([^"]*)"', 'g');
    let m;
    while ((m = re.exec(html))) {
      const value = m[1];
      const el = makeEl(null, null);
      el._attrs[attr[1]] = value;
      el.dataset = { cite: value, reask: value };
      out.push(el);
    }
  }
  return out;
}

function makeDoc() {
  const els = new Map();
  const doc = {
    els,
    getElementById: (id) => els.get(id) || null,
    _ensure(id) {
      if (!els.has(id)) els.set(id, makeEl(id, doc));
      return els.get(id);
    },
    // A DELIBERATELY DUMB re-index: for every `id="X"` in the markup, register
    // a node, read its tag's attributes, and take its leaf text. That is all
    // this suite asserts on, and a fuller parser would be a second thing to be
    // wrong about.
    _reindex(html) {
      const tagRe = /<([a-z]+)\s+([^>]*\bid="([a-z0-9-]+)"[^>]*)>/g;
      let m;
      while ((m = tagRe.exec(html))) {
        const el = doc._ensure(m[3]);
        el._attrs = {};
        const attrRe = /([a-z-]+)="([^"]*)"/g;
        let a;
        while ((a = attrRe.exec(m[2]))) el._attrs[a[1]] = a[2];
        const after = html.slice(m.index + m[0].length);
        const lt = after.indexOf('<');
        el.textContent = lt === -1 ? after : after.slice(0, lt);
        el._html = '';
      }
    },
  };
  return doc;
}

// ── The sandbox: the REAL stream + render chain, stubbed only at its edges ─
function makeSandbox(opts = {}) {
  const doc = makeDoc();
  const state = {
    sending: opts.sending === undefined ? true : opts.sending,
    activeDomain: opts.activeDomain || 'articles',
    activeConversationId: opts.activeConversationId === undefined ? 'conv-1' : opts.activeConversationId,
    // Defaults to the optimistic user bubble, because that is what is ALWAYS
    // on screen during a send: `sendCurrentMessage` pushes it before the fetch.
    // An empty thread is a different branch of renderThreadOnly (the "Ask X
    // anything" early return) and is covered explicitly in §2b.
    thread: opts.thread || [{ role: 'user', content: 'q' }],
    cancelNotice: null,
    domains: [{ slug: 'articles', displayName: 'Articles', pageCount: 12 }],
    offerable: {}, availableProviders: [], modelProvider: null, activeProvider: null, chatModel: null,
  };
  const calls = { markdown: [], openReader: [] };

  const src =
    'let myMountToken = 1;\n' +
    `let sendAbort = ${JSON.stringify(opts.abort === undefined
      ? { mountToken: 1, domain: 'articles', conversationId: 'conv-1' } : opts.abort)};\n` +
    'let sendStream = null;\n' +
    'let sendStartedAt = 0, sendTimerId = null, sendLatencyHint = null;\n' +
    'let streamPaintQueued = false;\n' +
    'let lastRenderedConvId;\n' +
    `const SLOW_TURN_NOTICE_AFTER_MS = ${constOf('SLOW_TURN_NOTICE_AFTER_MS')};\n` +
    `const STREAM_TAIL_LINES = ${constOf('STREAM_TAIL_LINES')};\n` +
    `const STREAM_TAIL_CHARS = ${constOf('STREAM_TAIL_CHARS')};\n` +
    `const THREAD_FOLLOW_SLACK_PX = ${constOf('THREAD_FOLLOW_SLACK_PX')};\n` +
    'const Date = { now: () => 5000 };\n' +
    extractFunction(chatSrc, 'sendIsOnScreen') + '\n' +
    extractFunction(chatSrc, 'slowNoticeSuppressed') + '\n' +
    extractFunction(chatSrc, 'streamShapeKey') + '\n' +
    extractFunction(chatSrc, 'reasoningTailText') + '\n' +
    extractFunction(chatSrc, 'streamSlotHtml') + '\n' +
    extractFunction(chatSrc, 'preRollRingHtml') + '\n' +
    extractFunction(chatSrc, 'thinkingBodyHtml') + '\n' +
    extractFunction(chatSrc, 'paintStream') + '\n' +
    extractFunction(chatSrc, 'schedulePaintStream') + '\n' +
    extractFunction(chatSrc, 'wireStreamToggle') + '\n' +
    extractFunction(chatSrc, 'threadScrollHost') + '\n' +
    extractFunction(chatSrc, 'isThreadAtBottom') + '\n' +
    extractFunction(chatSrc, 'stickThreadToBottom') + '\n' +
    extractFunction(chatSrc, 'renderThreadOnly') + '\n' +
    'return {\n' +
    '  renderThreadOnly, paintStream, schedulePaintStream, sendIsOnScreen,\n' +
    '  streamSlotHtml, thinkingBodyHtml, isThreadAtBottom, streamShapeKey,\n' +
    '  setStream: (v) => { sendStream = v; },\n' +
    '  getStream: () => sendStream,\n' +
    '  setAbort: (v) => { sendAbort = v; },\n' +
    '};';

  const api = new Function(
    'document', 'state', 'isCurrentMount', 'escapeHtml', 'formatDurationMs',
    'progressRingHtml', 'slowTurnNoticeText', 'renderMarkdown', 'cancelNoticeHtml',
    'assistantEyebrowHtml', 'failedModelNoteHtml', 'reaskButtonHtml',
    'folderOfPath', 'typeChipClass', 'typeDotStyle',
    'openBrowseDialog', 'openWikiReader', 'questionForAnswerIndex', 'window',
    src
  )(
    doc, state,
    (t) => (opts.isCurrentMount === undefined ? t === 1 : opts.isCurrentMount(t)),
    escapeHtmlStub, formatDurationMs, progressRingHtml,
    () => '',
    // The REAL renderer is not imported: this suite owns the streaming path,
    // and shared/markdown.js has its own suite. What matters here is WHICH
    // strings reach it — §4 and §7 assert exactly that.
    (s) => { calls.markdown.push(s); return '<md>' + escapeHtmlStub(s) + '</md>'; },
    () => '', () => '<eyebrow>', () => '', () => '',
    (p) => String(p).split('/')[0], () => 'chip', () => '',
    () => {}, (p) => { calls.openReader.push(p); }, () => 'q',
    // No `window.requestAnimationFrame`, so schedulePaintStream falls back to
    // setTimeout — which is what a non-browser host does and is the branch this
    // suite can drive deterministically.
    {},
  );

  return { api, doc, state, calls };
}

const tick = () => new Promise(r => setTimeout(r, 25));
const streamRec = (over) => Object.assign(
  { sse: true, seen: true, reasoning: '', content: '', reasoningView: 'tail' }, over || {}
);

console.log('\n══ test-next-chat-streaming.js — streamed chat turns ══');

// ═════════════════════════════════════════════════════════════════════════
section('§0  Harness self-check — a suite that cannot fail proves nothing');
// ═════════════════════════════════════════════════════════════════════════
{
  const before = { p: passed, f: failed };
  ok(true, 'control: ok() records a pass');
  const passMoved = passed === before.p + 1 && failed === before.f;
  const realLog = console.log; console.log = () => {};
  ok(false, 'internal: this assertion is EXPECTED to fail');
  console.log = realLog;
  const failMoved = failed === before.f + 1;
  failed = before.f; passed = before.p + 1;
  ok(passMoved && failMoved, 'control: ok() has a real FAILING direction — (cond, label), not reversed');

  let threw = false;
  try { extractFunction(chatSrc, 'noSuchFunctionAnywhere'); } catch { threw = true; }
  ok(threw, 'extractFunction throws loudly on a missing function (a desync cannot pass silently)');

  // Binding resolution BY EXECUTION. An extracted function whose closure lost a
  // binding dies with a ReferenceError mid-suite while everything before it
  // reported green — measured in this repo more than once.
  let err = null;
  try {
    const s = makeSandbox();
    s.doc._ensure('chat-thread');
    s.doc._ensure('main');
    s.api.setStream(streamRec({ reasoning: 'r', content: 'c' }));
    s.api.renderThreadOnly(1);
    s.api.paintStream(1);
    s.api.sendIsOnScreen(1);
    s.api.streamSlotHtml(1000);
  } catch (e) { err = e; }
  ok(err === null, 'every extracted function resolves its bindings and runs' + (err ? ` — ${err.message}` : ''));
}

// ═════════════════════════════════════════════════════════════════════════
section('§1  THE IDENTITY GATE  ★ not a bare boolean');
// ═════════════════════════════════════════════════════════════════════════
// `state.sending` carried no conversation and no domain. The bubble now paints
// only when the in-flight turn's own record matches what is on screen. Each
// case below is a real navigation a user performs mid-turn.
{
  const base = () => {
    const s = makeSandbox({ thread: [{ role: 'user', content: 'hi' }] });
    s.doc._ensure('chat-thread'); s.doc._ensure('main');
    s.api.setStream(streamRec({ reasoning: 'my private reasoning', content: 'my draft answer' }));
    return s;
  };

  const match = base();
  match.api.renderThreadOnly(1);
  const painted = match.doc.getElementById('chat-thread').innerHTML;
  ok(/chat-msg-thinking/.test(painted), 'CONTROL: on the matching thread the bubble IS painted');
  ok(/my private reasoning/.test(painted), 'CONTROL: carrying the live reasoning');
  ok(/my draft answer/.test(painted), 'CONTROL: and the draft answer');

  // (a) the user switched CONVERSATION mid-turn.
  const otherConv = base();
  otherConv.state.activeConversationId = 'conv-2';
  otherConv.api.renderThreadOnly(1);
  const h1 = otherConv.doc.getElementById('chat-thread').innerHTML;
  ok(!/chat-msg-thinking/.test(h1), '★ a different CONVERSATION gets no bubble');
  ok(!/my private reasoning/.test(h1) && !/my draft answer/.test(h1),
    "★ and none of the other conversation's reasoning or draft leaks into it");

  // (b) the user switched DOMAIN mid-turn.
  const otherDomain = base();
  otherDomain.state.activeDomain = 'business';
  otherDomain.api.renderThreadOnly(1);
  ok(!/chat-msg-thinking/.test(otherDomain.doc.getElementById('chat-thread').innerHTML),
    '★ a different DOMAIN gets no bubble');

  // (c) a fresh MOUNT (navigate away and back).
  const otherMount = base();
  otherMount.api.setAbort({ mountToken: 99, domain: 'articles', conversationId: 'conv-1' });
  otherMount.api.renderThreadOnly(1);
  ok(!/chat-msg-thinking/.test(otherMount.doc.getElementById('chat-thread').innerHTML),
    '★ a turn belonging to an earlier MOUNT gets no bubble');

  // (d) `state.sending` still has to be true. This is what keeps the flag's
  //     other three jobs — the send-lock, the disabled composer, and the
  //     Send↔Stop dispatch — coherent with what is on screen.
  const notSending = base();
  notSending.state.sending = false;
  notSending.api.renderThreadOnly(1);
  ok(!/chat-msg-thinking/.test(notSending.doc.getElementById('chat-thread').innerHTML),
    'and `state.sending` is still in the conjunction — the flag keeps all its other jobs');

  // (e) the gate itself, driven directly.
  const g = base();
  ok(g.api.sendIsOnScreen(1) === true, 'sendIsOnScreen: true on an exact match');
  ok(g.api.sendIsOnScreen(2) === false, 'sendIsOnScreen: false for another mount token');
  g.api.setAbort(null);
  ok(g.api.sendIsOnScreen(1) === false, 'sendIsOnScreen: false with no turn in flight at all');
}
{
  // A NEW conversation's first turn carries `conversationId: null` on both
  // sides, and null === null. If the gate demanded a truthy id, the bubble
  // would never appear for the very first message of a new chat — the case a
  // new user sees first.
  const s = makeSandbox({ activeConversationId: null, abort: { mountToken: 1, domain: 'articles', conversationId: null } });
  s.doc._ensure('chat-thread'); s.doc._ensure('main');
  s.state.thread = [{ role: 'user', content: 'first ever message' }];
  s.api.setStream(streamRec({ reasoning: 'thinking about it' }));
  s.api.renderThreadOnly(1);
  ok(/chat-msg-thinking/.test(s.doc.getElementById('chat-thread').innerHTML),
    'a brand-new conversation (id null on both sides) DOES get its bubble');
}

// ═════════════════════════════════════════════════════════════════════════
section('§2  THE BUBBLE IS TRANSIENT DOM, NEVER A THREAD ENTRY');
// ═════════════════════════════════════════════════════════════════════════
{
  const s = makeSandbox({ thread: [{ role: 'user', content: 'q' }] });
  s.doc._ensure('chat-thread'); s.doc._ensure('main');
  s.api.setStream(streamRec({ reasoning: 'scratch', content: 'draft' }));
  const before = JSON.stringify(s.state.thread);
  s.api.renderThreadOnly(1);
  s.api.paintStream(1);
  s.api.paintStream(1);
  ok(JSON.stringify(s.state.thread) === before,
    '★ rendering and painting the stream mutates `state.thread` not at all');
  ok(s.state.thread.length === 1 && s.state.thread[0].role === 'user',
    'the last thread entry is still the optimistic USER message — which is what the Stop unwind identifies');
  ok(!s.state.thread.some(m => m.role === 'assistant'),
    'no assistant placeholder exists to break that identity guard');
}
{
  // Everything streamed is ESCAPED. The reasoning is untrusted model output
  // arriving over a network, and the draft is too.
  const s = makeSandbox();
  s.doc._ensure('chat-thread'); s.doc._ensure('main');
  s.api.setStream(streamRec({ reasoning: '<img src=x onerror=alert(1)>', content: '<script>bad()</script>' }));
  const html = s.api.streamSlotHtml(1000);
  ok(!/<img src=x/.test(html) && !/<script>/.test(html), 'streamed text is escaped before it reaches the markup');
  ok(/&lt;img src=x/.test(html) && /&lt;script&gt;/.test(html),
    'POSITIVE CONTROL: both payloads really did reach the markup, escaped');
}

// ═════════════════════════════════════════════════════════════════════════
section('§3  THE FAST PATH  ★ never renderThreadOnly per token');
// ═════════════════════════════════════════════════════════════════════════
{
  const s = makeSandbox({ thread: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'an older answer' }] });
  const thread = s.doc._ensure('chat-thread');
  s.doc._ensure('main');
  s.api.setStream(streamRec({ reasoning: 'first thought' }));
  s.api.renderThreadOnly(1);
  const writesAfterRender = thread._writes;
  const slot = s.doc.getElementById('chat-stream-slot');
  ok(!!slot, 'the render produced the stream slot');
  ok(slot.getAttribute('data-shape') === s.api.streamShapeKey(),
    'and stamped the shape key on it, so the fast path can tell structure from text');

  // Ten deltas of pure text growth.
  for (let i = 0; i < 10; i++) {
    s.api.getStream().reasoning += '\nmore thinking ' + i;
    s.api.paintStream(1);
  }
  ok(thread._writes === writesAfterRender,
    '★ ten deltas caused ZERO writes to #chat-thread — the whole thread was never rebuilt');
  ok(s.doc.getElementById('chat-stream-reasoning').textContent.includes('more thinking 9'),
    'and the newest text really did land in the reasoning node');
  ok(!s.doc.getElementById('chat-stream-reasoning').textContent.includes('first thought'),
    'as a TAIL — the firehose (6,687-8,385 chars per measured turn) is not rendered live');

  // A STRUCTURAL change re-renders the SLOT, and still not the thread.
  const slotWrites = slot._writes;
  s.api.getStream().content = 'the answer begins';
  s.api.paintStream(1);
  ok(thread._writes === writesAfterRender,
    '★ even a structural change re-renders only the slot, never #chat-thread');
  ok(slot._writes === slotWrites + 1, 'the slot itself was re-rendered exactly once');
  ok(s.doc.getElementById('chat-stream-answer').textContent === 'the answer begins',
    'and the draft answer node appeared with the text in it');
}
{
  // The gate applies to the FAST path too, not only to the full render —
  // otherwise a turn belonging to conversation A would keep writing its
  // reasoning into whatever bubble happened to be in the DOM.
  const s = makeSandbox();
  s.doc._ensure('chat-thread'); s.doc._ensure('main');
  s.api.setStream(streamRec({ reasoning: 'A private' }));
  s.api.renderThreadOnly(1);
  const node = s.doc.getElementById('chat-stream-reasoning');
  const seen = node.textContent;
  s.state.activeConversationId = 'conv-2';        // the user moved on
  s.api.getStream().reasoning += ' and more that must not appear';
  s.api.paintStream(1);
  ok(node.textContent === seen, '★ the fast path refuses to paint into a thread that is no longer this turn\'s');
}
{
  // The rAF throttle coalesces; it does NOT re-schedule itself.
  const s = makeSandbox();
  s.doc._ensure('chat-thread'); s.doc._ensure('main');
  s.api.setStream(streamRec({ reasoning: 'x' }));
  s.api.renderThreadOnly(1);
  const slot = s.doc.getElementById('chat-stream-slot');
  const before = slot._writes;
  for (let i = 0; i < 50; i++) { s.api.getStream().reasoning += 'y'; s.api.schedulePaintStream(1); }
  await tick();
  ok(slot._writes === before, '50 scheduled paints of pure text growth re-rendered the slot zero times');
  ok(s.doc.getElementById('chat-stream-reasoning').textContent.endsWith('y'),
    'while the coalesced paint still delivered the newest text');
  const quiet = slot._writes;
  await tick(); await tick();
  ok(slot._writes === quiet, 'and a stream that goes quiet schedules nothing further — it is a throttle, not a loop');
}

// ═════════════════════════════════════════════════════════════════════════
section('§4  REPLACE, NEVER APPEND  ★ the authoritative-return rule');
// ═════════════════════════════════════════════════════════════════════════
// The thread entry is built from `done.answer` alone. This is enforced
// STRUCTURALLY — nothing in chat.js concatenates the buffer with the answer —
// and the scan below is the class guard over that. The behavioural half lives
// in test-next-chat-cancel.js §10b/§10d, which drives a real stream end to end.
{
  // ── THE COMMENT-SATISFIES-A-SCAN HAZARD, INVERTED, AND MEASURED HERE ────
  // The first version of this section scanned the RAW source and went red at
  // "found 1 references" — the one reference being the code comment that says
  // `streamRec.content` is deliberately never referenced. A prose explanation
  // of a rule was being counted as a violation of it. This repo has recorded
  // the opposite direction (an absence check passing because the replacement
  // COMMENT quoted the selector it asserted was deleted, v3.19.0); this is the
  // same coupling, failing the other way.
  //
  // So every scan below reads CODE ONLY. The stripper is deliberately simple —
  // line and block comments, nothing more — and the control immediately after
  // it proves it actually removed something, so a stripper that silently
  // stopped working could not leave these assertions vacuously green.
  //
  // NOT ENFORCED, said plainly: `//` inside a string or a regex literal would
  // be over-stripped. Neither appears in the functions scanned here, and §10b
  // in the cancel suite is the behavioural half that does not depend on any of
  // this.
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const sendRaw = extractFunction(chatSrc, 'sendCurrentMessage');
  const send = stripComments(sendRaw);
  const consume = stripComments(extractFunction(chatSrc, 'consumeChatStream'));
  ok(/streamRec\.content/.test(sendRaw) && !/streamRec\.content/.test(send),
    'CONTROL: the comment stripper really does remove prose (the raw source mentions the buffer; the code does not)');
  ok(/content: data\.answer,/.test(send), 'CONTROL: and it leaves real code intact');

  // ENFORCED: the assistant thread entry's `content` is exactly `data.answer`.
  ok(/content: data\.answer,/.test(send),
    '★ the thread entry takes `data.answer` and nothing else');
  ok(!/content: [^,\n]*streamRec\.content|streamRec\.content \+|\+ streamRec\.content/.test(send),
    '★ `streamRec.content` is never concatenated with the answer anywhere in the send path');
  // NOT ENFORCED, said plainly: a copy under a different local name, or a
  // concatenation performed inside a helper this scan does not read. §10b in
  // the cancel suite is the behavioural half that catches those.
  const reads = (send.match(/streamRec\.content/g) || []).length;
  ok(reads === 0, `the send path never READS the content buffer at all (found ${reads} references)`);

  // The consumer returns the FRAME. Returning anything derived from the buffer
  // is what would make appending expressible at all.
  ok(/return final;/.test(consume), 'consumeChatStream returns the terminal frame itself');
  ok(!/rec\.content \+ |\+ rec\.content/.test(consume), 'and never concatenates its own buffer into a return value');

  // A stream that ends with no terminal frame must FAIL, not return a blank
  // answer that would be persisted as if it were a reply.
  ok(/if \(!final\) \{[\s\S]*?throw new Error/.test(consume),
    'a stream that closes with no `done` and no `error` throws rather than returning an empty answer');
}
{
  // THE CASE THAT MAKES THE RULE MATTER, driven for real. `src/brain/llm.js`
  // appends its truncation note to the FINISHED string, so it exists only in
  // `done.answer` and never as a delta. A buffer-first reader loses the one
  // sentence explaining why the answer stops mid-thought.
  const deltas = ['The answer is ', 'partially '];
  const done = { answer: 'The answer is partially complete.\n\n⚠ This answer was cut off because it reached the response length limit.' };
  const appended = deltas.join('') + done.answer;
  ok(done.answer.includes('cut off'), 'CONTROL: the truncation note is present in `done.answer`');
  ok(!deltas.join('').includes('cut off'), 'CONTROL: and absent from every delta');
  ok(done.answer !== appended, 'CONTROL: appending would produce a different string');
  ok(!done.answer.startsWith('The answer is The answer is'),
    'and REPLACING is what avoids the doubled prefix an append produces');
}

// ═════════════════════════════════════════════════════════════════════════
section('§5  SCROLLING — follow the reader, never drag them');
// ═════════════════════════════════════════════════════════════════════════
{
  const s = makeSandbox();
  const main = s.doc._ensure('main');
  main.scrollHeight = 2000; main.clientHeight = 500;
  main.scrollTop = 1500;
  ok(s.api.isThreadAtBottom(main) === true, 'exactly at the bottom counts as following');
  main.scrollTop = 1480;
  ok(s.api.isThreadAtBottom(main) === true, 'a couple of lines up still counts as following');
  main.scrollTop = 400;
  ok(s.api.isThreadAtBottom(main) === false, 'scrolled well back does NOT');
  ok(s.api.isThreadAtBottom(null) === true,
    'and no host at all fails SAFE — "the newest message is visible" beats "your place was silently lost"');
}
{
  // ★ THE DEFECT THIS REPLACES: an unconditional `scrollTop = scrollHeight` on
  // every render. Once text arrives continuously that becomes a pin, and a
  // reader looking back through the conversation is dragged to the bottom on
  // every frame.
  const s = makeSandbox({ thread: [{ role: 'user', content: 'q' }] });
  s.doc._ensure('chat-thread');
  const main = s.doc._ensure('main');
  main.scrollHeight = 4000; main.clientHeight = 600; main.scrollTop = 100;
  s.api.setStream(streamRec({ reasoning: 'a' }));
  s.api.renderThreadOnly(1);                 // first paint of this conversation
  ok(main.scrollTop === 4000, 'opening a conversation lands on its newest message');

  main.scrollTop = 100;                      // the reader scrolls back
  s.api.getStream().reasoning += 'bbbb';
  s.api.paintStream(1);
  ok(main.scrollTop === 100, '★ a delta arriving while they read history does NOT drag them to the bottom');
  s.api.renderThreadOnly(1);
  ok(main.scrollTop === 100, '★ nor does a full re-render of the same conversation');

  main.scrollTop = 3400;                     // they scroll back down
  s.api.getStream().reasoning += 'cccc';
  s.api.paintStream(1);
  ok(main.scrollTop === 4000, 'and once they are following again, the stream follows with them');
}
{
  // A conversation SWITCH always lands at the bottom: the reader's position in
  // the previous conversation is not evidence about this one.
  const s = makeSandbox({ thread: [{ role: 'assistant', content: 'a' }] });
  s.doc._ensure('chat-thread');
  const main = s.doc._ensure('main');
  main.scrollHeight = 4000; main.clientHeight = 600;
  s.api.renderThreadOnly(1);
  main.scrollTop = 50;
  s.state.activeConversationId = 'conv-2';
  s.api.renderThreadOnly(1);
  ok(main.scrollTop === 4000, 'switching conversation lands on the newest message regardless of the old scroll');

  main.scrollTop = 50;
  s.api.renderThreadOnly(1, { stick: true });
  ok(main.scrollTop === 4000, 'and an explicit { stick: true } — what pressing Send passes — always jumps');
}

// ═════════════════════════════════════════════════════════════════════════
section('§6  THE REASONING FOLD IS A REAL, WORKING CONTROL');
// ═════════════════════════════════════════════════════════════════════════
{
  const s = makeSandbox();
  const thread = s.doc._ensure('chat-thread');
  s.doc._ensure('main');
  const lines = Array.from({ length: 30 }, (_, i) => 'thought ' + i).join('\n');
  s.api.setStream(streamRec({ reasoning: lines, content: 'the answer', reasoningView: 'hidden' }));
  s.api.renderThreadOnly(1);

  let btns = thread.querySelectorAll('[data-stream-view]');
  ok(btns.length === 1, 'the collapsed fold renders exactly one toggle');
  ok(btns[0].getAttribute('data-stream-view') === 'full', 'which opens it');
  ok(btns[0]._listeners.some(l => l.t === 'click'),
    '★ and it is WIRED — an outerHTML/innerHTML replacement drops listeners, so the render re-binds');

  btns[0].click();
  ok(s.api.getStream().reasoningView === 'full', 'clicking it opens the fold');
  ok(s.doc.getElementById('chat-stream-reasoning').textContent.includes('thought 0'),
    'and the WHOLE scratchpad is there — the tail was a view, nothing was truncated on the way in');

  // The re-render from that click must itself re-bind, or the fold opens once
  // and then becomes inert.
  const slot = s.doc.getElementById('chat-stream-slot');
  const reopened = slot.querySelectorAll('[data-stream-view]');
  ok(reopened.length === 1 && reopened[0].getAttribute('data-stream-view') === 'hidden',
    'the open fold offers a way back (the answer has started, so it hides rather than shortens)');
  ok(reopened[0]._listeners.some(l => l.t === 'click'),
    '★ and THAT button is wired too — the fast path re-binds after its own re-render');
  reopened[0].click();
  ok(s.api.getStream().reasoningView === 'hidden', 'clicking it folds the scratchpad away again');
}
{
  // A garbage value on the attribute must not corrupt the view state. The
  // attribute is app-authored today; the rule this file lives by is validate
  // at the boundary rather than audit every producer forever.
  const s = makeSandbox();
  s.doc._ensure('chat-thread'); s.doc._ensure('main');
  s.api.setStream(streamRec({ reasoning: 'r' }));
  s.api.renderThreadOnly(1);
  const btn = s.doc.getElementById('chat-thread').querySelectorAll('[data-stream-view]')[0];
  btn._attrs['data-stream-view'] = '__proto__';
  btn.click();
  ok(s.api.getStream().reasoningView === 'tail', 'an unrecognised view value is refused, leaving the state untouched');
}

// ═════════════════════════════════════════════════════════════════════════
section('§7  CITATIONS ARE WIRED ON THE TERMINAL FRAME ONLY');
// ═════════════════════════════════════════════════════════════════════════
// A truncated `[source: entities/foo` has no closing bracket yet, so
// renderMarkdown's `\[source:([^\]]{1,512})\]` runs on to the NEXT `]` in the
// buffer and produces a clickable chip pointing at the WRONG page. Nothing
// streamed is ever handed to that renderer.
{
  const s = makeSandbox({ thread: [{ role: 'user', content: 'q' }] });
  s.doc._ensure('chat-thread'); s.doc._ensure('main');
  s.api.setStream(streamRec({
    reasoning: 'checking [source: entities/reasoning-only',
    content: 'partly written [source: entities/wrong-page and then',
  }));
  s.api.renderThreadOnly(1);
  ok(s.calls.markdown.every(x => !/wrong-page|reasoning-only/.test(x)),
    '★ neither the reasoning nor the draft is ever passed to renderMarkdown');
  const html = s.doc.getElementById('chat-thread').innerHTML;
  ok(!/<md>/.test(html.slice(html.indexOf('chat-msg-thinking'))),
    'and nothing inside the streaming bubble is markdown-rendered');
  ok(s.calls.openReader.length === 0, 'no reader was opened by anything in the streaming bubble');
}
{
  // POSITIVE CONTROL: a FINISHED answer does go through renderMarkdown, so the
  // absence above is a property of the streaming path and not of the fixture.
  const s = makeSandbox({
    sending: false,
    thread: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'done [source: entities/right-page]', citations: ['entities/right-page.md'] }],
  });
  s.doc._ensure('chat-thread'); s.doc._ensure('main');
  s.api.renderThreadOnly(1);
  ok(s.calls.markdown.some(x => /right-page/.test(x)),
    'POSITIVE CONTROL: the finished answer IS passed to renderMarkdown');
  ok(/chat-cite-chip/.test(s.doc.getElementById('chat-thread').innerHTML),
    'and its citation chips are rendered on the terminal frame');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) {
  console.log('❌ chat-streaming assertions FAILED');
  process.exit(1);
}
console.log('✅ All chat-streaming assertions green');
