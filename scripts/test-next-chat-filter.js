/**
 * test-next-chat-filter.js — OFFLINE suite for the Chat sidebar's conversation
 * FILTER and its "Ask this in a new chat" escape hatch
 * (src/public/next/views/chat.js).
 *
 * No network, no API key, no server, no browser, no LLM call. The REAL
 * `renderSidebar`, `wireConversationPane`, `askFilterTextInNewChat`,
 * `clearConversationFilter`, `startNewChat` and the field's own keydown handler
 * are extracted by brace-matching and EXECUTED against a fake DOM — the
 * technique scripts/test-next-chat-streaming.js and
 * scripts/test-next-chat-cancel.js use for browser-side code. Nothing here is
 * asserted by reading source text except where a section says so.
 *
 * ── THE DEFECT THIS SUITE EXISTS FOR ─────────────────────────────────────
 * A power user typed questions into the sidebar's search box three times, once
 * in a live demo, and waited for an answer. `startNewChat` already calls
 * `focusComposer()`, so the caret was never in there by accident: the cause is
 * that a full-bleed field sitting directly under the sidebar's primary button,
 * with a placeholder ending in an ellipsis ("Search conversations…") that
 * echoes the composer's own ("Ask Articles…"), IS the most typeable-looking
 * thing on that column.
 *
 * The fix has two halves and this suite covers both:
 *   · the field READS as a filter — "Filter conversations", no ellipsis, the
 *     magnifier inside it, the kit's sunken-field treatment at --hit-min;
 *   · and for the reader who has ALREADY typed a question into it, the empty
 *     state offers to move that text where it belongs, rather than answering
 *     "No conversations match “how do we stage the rollout”." and stopping.
 *
 *   §0  Harness self-check — ok() can fail, and every binding resolves.
 *   §1  The field: label, no ellipsis, the icon inside the wrap, aria-label.
 *   §2  looksLikeAnAsk / filterAskOffered — when the offer is made, and when
 *       it deliberately is not.
 *   §3  Taking the offer: the text MOVES into a focused composer, in a new
 *       chat, with the filter cleared and the list refetched. Driven through
 *       the real click handler wired by the real wireConversationPane.
 *   §4  Enter in the field does the same thing, and is gated on the SAME
 *       predicate the row is — so a keypress inside the debounce window
 *       cannot open a chat on a filter that was about to match.
 *   §5  Escape clears the filter and NOTHING else.
 *   §6  SOURCE GUARD: the sunken-field treatment in chat.css.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHAT_JS = path.join(ROOT, 'src/public/next/views/chat.js');
const CHAT_CSS = path.join(ROOT, 'src/public/next/views/chat.css');
const chatSrc = readFileSync(CHAT_JS, 'utf8');
const chatCss = readFileSync(CHAT_CSS, 'utf8');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(a, b, label) {
  ok(a === b, `${label} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`);
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
function extractConst(src, name) {
  const re = new RegExp(`(?:^|\\n)const ${name} = [^\\n]*\\n`);
  const m = re.exec(src);
  if (!m) throw new Error(`extractConst: "${name}" not found`);
  return m[0].trim();
}
function escapeHtmlStub(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
}
/** The body of one CSS rule, by exact selector. */
function declForBody(css, selector) {
  const re = new RegExp('(?:^|\\})\\s*' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}');
  const m = re.exec(stripComments(css));
  return m ? m[1] : '';
}

// ─────────────────────────────────────────────────────────────────────────
// The fake DOM. It models the two properties these assertions need: which ids
// the rendered markup declares, and what the handlers bound to them do when
// fired. Elements are created lazily per id and REUSED, so a listener bound in
// one render is reachable from a click in the next — the identity §3 and §4
// depend on. `_ensureFromHtml` registers only ids that really appear in the
// markup the view produced, so a handler wired to an id the renderer never
// emitted cannot be exercised here.
// ─────────────────────────────────────────────────────────────────────────
function makeEl(id) {
  return {
    id, value: '', disabled: false, checked: false, indeterminate: false,
    style: {}, scrollHeight: 40, selectionStart: 0, selectionEnd: 0,
    _listeners: [], _focusCount: 0,
    addEventListener(t, f) { this._listeners.push({ t, f }); },
    focus() { this._focusCount++; this._doc && (this._doc.focused = this); },
    fire(type, evt = {}) {
      const e = Object.assign({ type, preventDefault() { e.defaultPrevented = true; }, defaultPrevented: false, target: this }, evt);
      this._listeners.filter((l) => l.t === type).forEach((l) => l.f(e));
      return e;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}
function makeDoc() {
  const els = new Map();
  const doc = {
    els, focused: null, sidebarHtml: '', paneHtml: '',
    _ensure(id) {
      if (!els.has(id)) { const el = makeEl(id); el._doc = doc; els.set(id, el); }
      return els.get(id);
    },
    /** Register an element for every id the rendered markup actually declares. */
    _ensureFromHtml(html) {
      const re = /\bid="([a-z0-9-]+)"/g;
      let m;
      const seen = new Set();
      while ((m = re.exec(html))) { seen.add(m[1]); doc._ensure(m[1]); }
      // Ids that vanished from the markup must vanish from the document too,
      // or a stale node would keep answering getElementById after the render
      // that removed it — the exact false green a cached fake DOM invites.
      for (const id of [...els.keys()]) {
        if (!seen.has(id) && id !== 'chat-input') els.delete(id);
      }
    },
    getElementById: (id) => els.get(id) || null,
    querySelector(sel) {
      if (sel === '.chat-conv-pane') return doc._pane;
      return null;
    },
    querySelectorAll: () => [],
  };
  // The composer lives in the MAIN column, which renderSidebar never paints;
  // it is registered up front because focusComposer() and
  // askFilterTextInNewChat() legitimately reach across to it.
  doc._ensure('chat-input');
  doc._pane = Object.assign(makeEl('.chat-conv-pane'), {
    querySelector: (sel) => (sel.startsWith('#') ? doc.getElementById(sel.slice(1)) : null),
    querySelectorAll: () => [],
    set innerHTML(v) { doc.paneHtml = String(v); doc._ensureFromHtml(v); },
    get innerHTML() { return doc.paneHtml; },
  });
  doc._pane._doc = doc;
  return doc;
}

function freshState(over = {}) {
  return Object.assign({
    booted: true,
    domains: [{ slug: 'articles', displayName: 'Articles', pageCount: 12 }],
    activeDomain: 'articles',
    activeConversationId: 'conv-1',
    conversations: [],
    thread: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }],
    searchQuery: '',
    searchTimer: null,
    selectedConvIds: new Set(),
    bulkNotice: null,
    cancelNotice: null,
    loadError: null,
  }, over);
}

function makeSandbox(over = {}) {
  const doc = makeDoc();
  const state = freshState(over);
  const calls = { setSidebar: [], renderShell: [], load: [], navigate: [], schedule: 0 };

  const src =
    'let myMountToken = 1;\n' +
    extractConst(chatSrc, 'FILTER_ASK_MIN_WORDS') + '\n' +
    extractFunction(chatSrc, 'cancelSearchTimer') + '\n' +
    extractFunction(chatSrc, 'looksLikeAnAsk') + '\n' +
    extractFunction(chatSrc, 'filterAskOffered') + '\n' +
    extractFunction(chatSrc, 'filterAskRowHtml') + '\n' +
    extractFunction(chatSrc, 'clearConversationFilter') + '\n' +
    extractFunction(chatSrc, 'askFilterTextInNewChat') + '\n' +
    extractFunction(chatSrc, 'startNewChat') + '\n' +
    extractFunction(chatSrc, 'focusComposer') + '\n' +
    extractFunction(chatSrc, 'autosize') + '\n' +
    extractFunction(chatSrc, 'isSameLocalDay') + '\n' +
    extractFunction(chatSrc, 'matchHint') + '\n' +
    extractFunction(chatSrc, 'conversationRowHtml') + '\n' +
    extractFunction(chatSrc, 'conversationListHtml') + '\n' +
    extractFunction(chatSrc, 'bulkBarHtml') + '\n' +
    extractFunction(chatSrc, 'bulkNoticeHtml') + '\n' +
    extractFunction(chatSrc, 'conversationPaneHtml') + '\n' +
    extractFunction(chatSrc, 'wireConvRows') + '\n' +
    extractFunction(chatSrc, 'wireConversationPane') + '\n' +
    extractFunction(chatSrc, 'renderSidebar') + '\n' +
    extractFunction(chatSrc, 'renderSidebarConversationsOnly') + '\n' +
    extractConst(chatSrc, 'MESSAGES_PER_TURN') + '\n' +
    'return { renderSidebar, renderSidebarConversationsOnly, looksLikeAnAsk, ' +
    'filterAskOffered, filterAskRowHtml, askFilterTextInNewChat, ' +
    'clearConversationFilter, conversationPaneHtml, FILTER_ASK_MIN_WORDS };';

  const api = new Function(
    'document', 'state', 'isCurrentMount', 'setSidebar', 'escapeHtml', 'icon',
    'renderViewHeader', 'renderShell', 'loadDomainConversations',
    'scheduleConversationSearch', 'deleteConversationRow', 'deleteSelectedConversations',
    'selectConversation', 'reportAsyncActionFailure', 'navigate', 'MESSAGES_PER_TURN_UNUSED',
    src
  )(
    doc, state,
    () => true,
    (html) => { calls.setSidebar.push(html); doc.sidebarHtml = html; doc._ensureFromHtml(html); },
    escapeHtmlStub,
    (n) => '<span class="icon-stub" data-icon="' + n + '"></span>',
    () => '<header class="view-header-stub"></header>',
    () => { calls.renderShell.push(true); },
    (domain, token, opts) => { calls.load.push({ domain, opts }); return Promise.resolve(); },
    () => { calls.schedule++; },
    () => {}, () => {}, () => Promise.resolve(),
    (e) => { throw e; },
    (v) => { calls.navigate.push(v); },
    null,
  );

  return { doc, state, calls, api };
}

/** Render the sidebar and hand back the field, the pane and the ask button. */
function mount(over = {}) {
  const s = makeSandbox(over);
  s.api.renderSidebar(1);
  s.field = s.doc.getElementById('chat-search-input');
  s.ask = s.doc.getElementById('chat-filter-ask');
  s.composer = s.doc.getElementById('chat-input');
  s.html = s.doc.sidebarHtml;
  return s;
}

// ═════════════════════════════════════════════════════════════════════════
section('§0 — Harness self-check');
// ═════════════════════════════════════════════════════════════════════════
{
  let sawFail = false;
  const realOk = ok;
  // eslint-disable-next-line no-func-assign
  ok = (c) => { if (!c) sawFail = true; };
  ok(false, 'probe');
  // eslint-disable-next-line no-func-assign
  ok = realOk;
  ok(sawFail, 'control: ok() can fail — the assertions below are not decorative');

  const s = mount();
  ok(typeof s.html === 'string' && s.html.includes('chat-search-wrap'),
    'the REAL renderSidebar produced markup through setSidebar');
  ok(!!s.field, 'the filter field is a node the fake document actually registered');
  ok(s.field._listeners.some((l) => l.t === 'input'), 'the real input handler is bound to it');
  ok(s.field._listeners.some((l) => l.t === 'keydown'), 'and so is the real keydown handler');
  // The fake document must not hand back a node the renderer never emitted.
  ok(s.doc.getElementById('chat-filter-ask') === null,
    'control: with no filter typed, there is no ask row and the document says so');
}

// ═════════════════════════════════════════════════════════════════════════
section('§1 — The field reads as a FILTER, not as a place to write a message');
// ═════════════════════════════════════════════════════════════════════════
{
  const { html } = mount();
  ok(/placeholder="Filter conversations"/.test(html),
    'the placeholder is "Filter conversations" — a verb about a list, not about a corpus');
  ok(!/Search conversations/.test(html),
    '…and the old label is gone, not merely joined');
  ok(!/placeholder="Filter conversations…"/.test(html) && !/placeholder="[^"]*…"/.test(html),
    'no ellipsis: an ellipsis promises the sentence continues, which is what the composer\'s placeholder does say');
  ok(/aria-label="Filter conversations"/.test(html),
    'it carries an aria-label — the only visible label is a placeholder, which assistive tech may ignore');

  // The magnifier is INSIDE the field's wrap, i.e. it can be positioned over
  // the field rather than sitting beside it as a separate glyph.
  const wrap = /<div class="chat-search-wrap">([\s\S]*?)<\/div>/.exec(html);
  ok(!!wrap, 'the field is inside .chat-search-wrap');
  ok(/data-icon="search"/.test(wrap[1]), '…together with the search icon');
  ok(wrap[1].indexOf('data-icon="search"') < wrap[1].indexOf('chat-search-input'),
    '…and the icon precedes the input, so it overlays the field\'s leading padding');

  // The composer's own placeholder is untouched — the two must read
  // differently, and this is the half that is allowed to sound like writing.
  ok(/'Ask ' \+ \(active\.displayName \|\| active\.slug\) \+ '…'/.test(chatSrc),
    'CONTROL: the composer still says "Ask <domain>…" — the contrast is the point, so only one of the two moved');
}

// ═════════════════════════════════════════════════════════════════════════
section('§2 — When the offer is made, and when it deliberately is not');
// ═════════════════════════════════════════════════════════════════════════
{
  const s = makeSandbox();
  const { looksLikeAnAsk, filterAskOffered, filterAskRowHtml, FILTER_ASK_MIN_WORDS } = s.api;

  eq(FILTER_ASK_MIN_WORDS, 4, 'the word threshold is a named constant, not a literal in the predicate');
  ok(looksLikeAnAsk('how do we stage the rollout'), 'six words reads as an ask');
  ok(looksLikeAnAsk('what is the plan'), 'exactly four words reads as an ask (the boundary is inclusive)');
  ok(!looksLikeAnAsk('large PDF ingest'), 'three words is still a plausible filter needle');
  ok(!looksLikeAnAsk('graphql'), 'one word is a needle');
  ok(looksLikeAnAsk('why?'), 'a single word ending in "?" is unambiguous');
  ok(looksLikeAnAsk('   what now?   '), 'surrounding whitespace does not hide the question mark');
  ok(!looksLikeAnAsk(''), 'empty text is not an ask');
  ok(!looksLikeAnAsk('   '), 'whitespace-only text is not an ask');
  ok(!looksLikeAnAsk(null) && !looksLikeAnAsk(undefined), 'a missing value is not an ask and does not throw');
  ok(!looksLikeAnAsk('a  b  c'), 'runs of whitespace are not counted as extra words');

  // filterAskOffered composes that with the state of the world.
  s.state.searchQuery = 'how do we stage the rollout';
  s.state.conversations = [];
  ok(filterAskOffered(), 'a five-word filter that matched nothing offers the escape hatch');
  ok(filterAskRowHtml().includes('id="chat-filter-ask"'), '…and the row is rendered');
  ok(filterAskRowHtml().includes('Ask this in a new chat'), '…with the label that says what it does');

  s.state.conversations = [{ id: 'a', title: 'A', createdAt: '2020-01-01T00:00:00.000Z', messageCount: 1 }];
  ok(!filterAskOffered(), 'the SAME text with a match does not offer it — the filter worked, there is nothing to rescue');
  eq(filterAskRowHtml(), '', '…and renders nothing');

  s.state.conversations = [];
  s.state.searchQuery = 'graphql';
  ok(!filterAskOffered(), 'a one-word miss does not offer it — that is an ordinary empty filter result');
  eq(filterAskRowHtml(), '', '…and renders nothing');

  s.state.searchQuery = 'how do we stage the rollout';
  s.state.loadError = 'Could not load conversations for this domain (boom).';
  ok(!filterAskOffered(), 'a load error is not a miss — the filter may well have matched and we could not fetch it');
  s.state.loadError = null;
  s.state.domains = [];
  ok(!filterAskOffered(), 'with no domains there is nothing to start a chat in');
  s.state.domains = [{ slug: 'articles' }];

  // The row really reaches the rendered pane, not just the builder.
  const live = mount({ searchQuery: 'how do we stage the rollout', conversations: [] });
  ok(/id="chat-filter-ask"/.test(live.html), 'the row appears in the markup renderSidebar actually emits');
  ok(live.html.indexOf('No conversations match') < live.html.indexOf('chat-filter-ask'),
    '…below the empty-state sentence it is answering');
  ok(!/Ask this in a new chat/.test(mount({ searchQuery: 'graphql', conversations: [] }).html),
    'and a one-word miss emits no row in the real render either');
}

// ═════════════════════════════════════════════════════════════════════════
section('§3 — Taking the offer moves the text into a focused composer');
// ═════════════════════════════════════════════════════════════════════════
{
  const TEXT = 'how do we stage the rollout';
  const s = mount({ searchQuery: TEXT, conversations: [] });
  ok(!!s.ask, 'the ask row exists (precondition)');
  ok(s.ask._listeners.some((l) => l.t === 'click'),
    'and the REAL wireConversationPane bound a click handler to it');

  const beforeShells = s.calls.renderShell.length;
  s.ask.fire('click');

  eq(s.state.thread.length, 0, 'a NEW chat: the thread is empty');
  ok(Array.isArray(s.state.thread), '…and is still an array, not a null');
  eq(s.state.activeConversationId, null, '…with no active conversation');
  eq(s.state.cancelNotice, null, '…and no notice carried over from the thread just left');
  ok(s.calls.renderShell.length > beforeShells, '…and the shell repainted');

  eq(s.composer.value, TEXT, 'the typed text is now the composer\'s value, character for character');
  ok(s.composer._focusCount > 0, 'the composer is focused');
  ok(s.doc.focused === s.composer, '…and it is the composer that holds focus, not the filter field');
  eq(s.field._focusCount, 0, '…which never took focus at all');
  eq(s.composer.selectionEnd, TEXT.length, 'the caret sits at the end of the text, ready to continue');
  ok(typeof s.composer.style.height === 'string' && s.composer.style.height.endsWith('px'),
    'the composer was autosized to the text it just received');

  eq(s.state.searchQuery, '', 'the text MOVED: the filter no longer holds it');
  const last = s.calls.load[s.calls.load.length - 1];
  ok(!!last, 'the conversation list was refetched');
  eq(last.opts.q, '', '…with no query, so the sidebar stops claiming this domain is empty');
  eq(last.opts.sidebarOnly, true, '…and only the sidebar repaints — the new chat stays on screen');

  // It does NOT send. The user aimed at the wrong control; spending money on
  // that keystroke would be the second surprise in a row.
  ok(!/askFilterTextInNewChat[\s\S]{0,1200}?sendCurrentMessage\(/.test(chatSrc),
    'the offer never sends the message itself');
}

// ═════════════════════════════════════════════════════════════════════════
section('§4 — Enter does the same thing, on the same condition');
// ═════════════════════════════════════════════════════════════════════════
{
  const TEXT = 'what is the current rollout plan';
  const s = mount({ searchQuery: TEXT, conversations: [] });
  const e = s.field.fire('keydown', { key: 'Enter' });
  ok(e.defaultPrevented, 'Enter in the field is consumed rather than left to the browser');
  eq(s.composer.value, TEXT, 'the text landed in the composer');
  eq(s.state.thread.length, 0, 'in a new, empty chat');
  eq(s.state.searchQuery, '', 'and left the filter');

  // THE GATE. The row's condition includes "nothing matched", which is only
  // known once the debounced refetch has answered. An Enter typed inside that
  // 220 ms window — while state.conversations still holds the PREVIOUS
  // answer — must fall through, or the user loses a filter that was about to
  // match something.
  const mid = mount({
    searchQuery: TEXT,
    conversations: [{ id: 'a', title: 'Rollout plan', createdAt: '2020-01-01T00:00:00.000Z', messageCount: 3 }],
  });
  const before = { thread: mid.state.thread.length, q: mid.state.searchQuery, value: mid.composer.value };
  const e2 = mid.field.fire('keydown', { key: 'Enter' });
  ok(!e2.defaultPrevented, 'Enter with matches on screen is NOT consumed');
  eq(mid.state.thread.length, before.thread, '…the open thread is untouched');
  eq(mid.state.searchQuery, before.q, '…the filter is untouched');
  eq(mid.composer.value, before.value, '…and nothing was written into the composer');

  const short = mount({ searchQuery: 'graphql', conversations: [] });
  const e3 = short.field.fire('keydown', { key: 'Enter' });
  ok(!e3.defaultPrevented, 'Enter on a one-word miss is not consumed either');
  eq(short.composer.value, '', '…and writes nothing');

  // Ordinary typing is unaffected.
  const typing = mount({ searchQuery: 'ro', conversations: [] });
  const e4 = typing.field.fire('keydown', { key: 'o' });
  ok(!e4.defaultPrevented, 'an ordinary character keydown is left entirely alone');
}

// ═════════════════════════════════════════════════════════════════════════
section('§5 — Escape clears the filter and nothing else');
// ═════════════════════════════════════════════════════════════════════════
{
  const s = mount({ searchQuery: 'how do we stage the rollout', conversations: [] });
  s.field.value = 'how do we stage the rollout';
  s.state.activeConversationId = 'conv-1';
  s.state.thread = [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }];
  const composerBefore = s.composer.value;

  const e = s.field.fire('keydown', { key: 'Escape' });
  ok(e.defaultPrevented, 'Escape is consumed');
  eq(s.state.searchQuery, '', 'the filter is cleared in state');
  eq(s.field.value, '', '…and in the field the user is looking at');
  const last = s.calls.load[s.calls.load.length - 1];
  ok(!!last && last.opts.sidebarOnly === true && last.opts.q === '',
    'the unfiltered list is refetched, sidebar only');

  // Escape is a repaint, not a navigation.
  eq(s.state.activeConversationId, 'conv-1', 'the open conversation stays open');
  eq(s.state.thread.length, 2, '…with its thread intact');
  eq(s.composer.value, composerBefore, '…and nothing is written into the composer');

  // An Escape on an already-empty filter is a no-op rather than a wasted fetch.
  const empty = mount({ searchQuery: '', conversations: [] });
  const loadsBefore = empty.calls.load.length;
  const e2 = empty.field.fire('keydown', { key: 'Escape' });
  ok(!e2.defaultPrevented, 'Escape on an empty filter is not consumed — nothing to clear');
  eq(empty.calls.load.length, loadsBefore, '…and fires no request');
}

// ═════════════════════════════════════════════════════════════════════════
section('§6 — SOURCE GUARD: the field takes the kit’s sunken treatment');
// ═════════════════════════════════════════════════════════════════════════
{
  /* Not extractable behaviourally — a computed height needs a layout engine.
     Asserted against the kit's own field recipe, which tokens/material.css
     states in as many words: "A FIELD IS THE INVERSION — a sunken well — and
     that inversion is most of what tells a user which control they can type
     in." views/settings.css's .provider-replace-input is the shipped instance
     of it and is the CONTROL below. */
  const field = declForBody(chatCss, '.chat-search-input');
  ok(/height:\s*var\(--hit-min\)/.test(field),
    'the field is exactly --hit-min tall — the compact step this kit has, and not one pixel under the floor sections 10/11 of test-next-views-kit.js hold');
  ok(!/height:\s*30px/.test(field), '…and the old 30px literal is gone');
  ok(/background:\s*var\(--surface-inset\)/.test(field), 'it sits on --surface-inset');
  ok(/box-shadow:\s*var\(--gloss-well\)/.test(field), '…with the sunken well, which is what makes it read as a field');
  ok(/border:\s*1px solid var\(--control-edge\)/.test(field),
    '…and --control-edge at rest, not the 1.2:1 --border it had');

  const focus = declForBody(chatCss, '.chat-search-input:focus');
  ok(/border-color:\s*var\(--accent\)/.test(focus) && /var\(--ring-focus\)/.test(focus),
    'focus moves the border AND adds the ring — two signals, as on the settings field');

  const settingsCss = readFileSync(path.join(ROOT, 'src/public/next/views/settings.css'), 'utf8');
  const control = declForBody(settingsCss, '.provider-replace-input');
  ok(/box-shadow:\s*var\(--gloss-well\)/.test(control) && /background:\s*var\(--surface-inset\)/.test(control),
    'CONTROL: .provider-replace-input takes the same three tokens, so this is the kit\'s field and not a new invention');

  // The ask row is a control with a real target and no hand cursor (the
  // shell's rule for chrome since v3.44.0).
  const askRule = declForBody(chatCss, '.chat-filter-ask');
  ok(/min-height:\s*var\(--hit-min\)/.test(askRule), 'the ask row is at least --hit-min tall');
  ok(/cursor:\s*default/.test(askRule) && /user-select:\s*none/.test(askRule),
    '…and is chrome: no hand cursor, not drag-selectable');
  ok(/\.chat-filter-ask:active\b/.test(stripComments(chatCss)),
    '…and acknowledges a press');
  ok(/prefers-reduced-motion[\s\S]*?\.chat-filter-ask:active/.test(stripComments(chatCss)),
    '…with its own reduced-motion escape, like every other press in this file');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All chat filter assertions green');
