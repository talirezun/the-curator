/**
 * test-next-chat-scope-follow.js — OFFLINE suite for WHERE A CHAT QUESTION
 * GOES when the conversation list is filtered to a domain (v3.81.2).
 *
 * ── THE REPORT (2026-10, reproduced by the orchestrator) ─────────────────
 * Chat's sidebar dropdown ("Show conversations from", `domainFilterCfg`) only
 * filtered the LIST; it never changed `state.activeDomain`. "New chat" kept the
 * active domain, and the send posts to `/api/chat/<state.activeDomain>`. So a
 * user set the list to NewsRadar, pressed New chat, asked — and the question
 * went to Curation, into a conversation the filtered list then hid.
 *
 * ── WHAT THIS SUITE HOLDS ────────────────────────────────────────────────
 *   §0  Harness self-check — ok() can fail; every lifted function resolves.
 *   §1  New chat FOLLOWS the filter, through the REAL sendCurrentMessage: the
 *       POST goes to the filter's domain. Control: "All domains" keeps the
 *       active domain.
 *   §2  A filter change with NO conversation open moves the empty new chat
 *       (and repaints the main column); "All domains" moves nothing.
 *   §3  An OPEN conversation is never re-scoped by the filter — an opened
 *       one, or a new one whose first question is in flight.
 *   §4  The scope line ("Open chat is in ‹A› · New chat in ‹B›"): when it
 *       appears and disappears, the RECORDED identity slot on each name (never
 *       the list position), and its button — wired through the REAL wirePane —
 *       starts a new chat in the filter's domain.
 *   §5  The composer's Domain pill moves a SET filter with it (so the next New
 *       chat does not undo the pick); "All domains" is left alone; a mirror
 *       pick clears the filter (a mirror holds no conversations).
 *   §6  Boot: a handoff ("Ask this domain") moves the filter to the handed
 *       domain; with no handoff the empty chat starts where the filter points.
 *   §7  The model menu's foot line and the Settings ⓘ say the pick is
 *       remembered.
 *
 * No network, no API key, no server, no browser, no LLM call. The functions
 * under test are lifted out of src/public/next/views/chat.js by brace-matching
 * and EXECUTED; views/chat-list.js and shared/sidebar.js are imported REAL.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as LIST from '../src/public/next/views/chat-list.js';
import { identitySlotClass } from '../src/public/next/shared/sidebar.js';
import { modelMenuFootHtml } from '../src/public/next/shared/model-row.js';
import { EXPLAINERS } from '../src/public/next/shared/explainers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chatSrc = readFileSync(path.join(ROOT, 'src/public/next/views/chat.js'), 'utf8');

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

// ── Fixture ──────────────────────────────────────────────────────────────
// The RECORDED identity slots deliberately differ from the list positions
// (curation is index 0 but slot 7; newsradar index 1, slot 3), so a dot
// painted from the position cannot pass §4.
const DOMAINS = [
  { slug: 'curation', displayName: 'Curation', identitySlot: 7 },
  { slug: 'newsradar', displayName: 'NewsRadar', identitySlot: 3 },
  { slug: 'shared-team', displayName: 'Team (shared)', identitySlot: 5, readonly: true },
];

// A tiny element: listeners, a value, focus. Nodes are created per id from the
// markup that was actually rendered, so a handler wired to an id the renderer
// never emitted cannot be fired.
function makeEl(id) {
  return {
    id, value: '', style: {}, scrollHeight: 40, _listeners: [], _focus: 0,
    addEventListener(t, f) { this._listeners.push({ t, f }); },
    focus() { this._focus++; },
    click() { this._listeners.filter((l) => l.t === 'click').forEach((l) => l.f({ stopPropagation() {} })); },
  };
}
function rootFromHtml(html) {
  const els = new Map();
  for (const m of String(html).matchAll(/\bid="([a-z0-9-]+)"/g)) els.set(m[1], makeEl(m[1]));
  return {
    els,
    querySelector: (sel) => (sel.startsWith('#') ? els.get(sel.slice(1)) || null : null),
    querySelectorAll: () => [],
  };
}

function makeSandbox(over = {}) {
  const store = new Map(Object.entries(over.storage || {}));
  const localStorageStub = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
  };
  const state = Object.assign({
    booted: true,
    domains: DOMAINS.map((d) => Object.assign({}, d)),
    activeDomain: 'curation',
    activeConversationId: null,
    thread: [],
    sending: false,
    conversations: [],
    domainFilter: null,
    listTotal: 0, listUnreadable: [],
    searchQuery: '', searchTimer: null,
    selectedConvKeys: new Set(), selectMode: false, bulkNotice: null,
    cancelNotice: null, loadError: null,
    answeringConvId: null, answeringDomain: null,
    responseStyle: 'balanced', modelProvider: null, chatModel: null,
    activeProject: null, activeProjectScope: null, activeProjectFrom: 'pin',
    projectRows: [], projectsFor: null, projectsState: 'idle', projectsFetchedAt: 0,
    projectLastUsed: null, projectKnowledge: null,
  }, over.state || {});

  const composer = makeEl('chat-input');
  const doc = { getElementById: (id) => (id === 'chat-input' ? composer : null), querySelector: () => null };
  const calls = { fetch: [], load: [], renderShell: 0, renderMain: 0, projects: [], pins: [] };
  const fetchImpl = (url, opts) => {
    calls.fetch.push({ url, method: opts && opts.method, body: opts && opts.body });
    if (typeof over.fetch === 'function') return over.fetch(url, opts);
    return new Promise(() => {});   // hangs: the URL is what is under test
  };

  const src =
    'let myMountToken = 1;\n' +
    'let sendAbort = null;\n' +
    'let sendStream = null;\n' +
    extractConst(chatSrc, 'LS_DOMAIN') + '\n' +
    extractFunction(chatSrc, 'adoptActiveDomain') + '\n' +
    extractFunction(chatSrc, 'restorePinnedProject') + '\n' +
    extractFunction(chatSrc, 'switchDomain') + '\n' +
    extractFunction(chatSrc, 'conversationOpen') + '\n' +
    extractFunction(chatSrc, 'canHoldConversations') + '\n' +
    extractFunction(chatSrc, 'newChatDomain') + '\n' +
    extractFunction(chatSrc, 'followFilterTo') + '\n' +
    extractFunction(chatSrc, 'startNewChat') + '\n' +
    extractFunction(chatSrc, 'focusComposer') + '\n' +
    extractFunction(chatSrc, 'autosize') + '\n' +
    extractFunction(chatSrc, 'listCtx') + '\n' +
    extractFunction(chatSrc, 'domainFilterCfg') + '\n' +
    extractFunction(chatSrc, 'wirePane') + '\n' +
    extractFunction(chatSrc, 'sendCurrentMessage') + '\n' +
    extractFunction(chatSrc, 'resolveBootDomain') + '\n' +
    extractFunction(chatSrc, 'boot') + '\n' +
    'return { adoptActiveDomain, switchDomain, conversationOpen, newChatDomain, startNewChat,\n' +
    '  listCtx, domainFilterCfg, wirePane, sendCurrentMessage, boot };';

  const api = new Function(
    'document', 'state', 'fetch', 'localStorage', 'isCurrentMount',
    'renderShell', 'renderMain', 'loadConversationList', 'loadProjectsForDomain',
    'readPinnedProjects', 'patchProjectPicker', 'ensureProjectKnowledge', 'writePinnedProject',
    'reportAsyncActionFailure', 'escapeHtml', 'identitySlotClass', 'filterAskRowHtml',
    'wireConversationPane', 'convKey', 'renderListboxHtml', 'mountListbox', 'tickAgesNow',
    'selectConversation', 'deleteConversationRow', 'deleteSelectedConversations',
    'renderSidebarConversationsOnly', 'askFilterTextInNewChat',
    'startSendClock', 'renderThreadOnly', 'renderComposerBusy', 'AbortController', 'applyApiKeys',
    src,
  )(
    doc, state, fetchImpl, localStorageStub, () => true,
    () => { calls.renderShell++; },
    () => { calls.renderMain++; },
    (token, opts) => { calls.load.push({ opts, filter: state.domainFilter, active: state.activeDomain }); return Promise.resolve(); },
    (slug) => { calls.projects.push(slug); return Promise.resolve(); },
    () => ({}), () => {}, () => Promise.resolve(), (d, p) => { calls.pins.push([d, p]); },
    (e) => { throw e; },
    escapeHtmlStub, identitySlotClass, () => '',
    LIST.wireConversationPane, LIST.convKey,
    () => '<span data-lb-stub></span>', () => null, () => 0,
    () => Promise.resolve(), () => Promise.resolve(), () => Promise.resolve(),
    () => {}, () => {},
    () => {}, () => {}, () => {}, AbortController, () => {},
  );
  return { api, state, calls, composer, store };
}

/** Type a question and press Send, through the REAL sendCurrentMessage. */
function ask(s, text) {
  s.composer.value = text;
  s.api.sendCurrentMessage();   // not awaited: the fetch hangs by design
  const post = s.calls.fetch.filter((c) => c.method === 'POST').pop();
  return post ? post.url : null;
}

// ═════════════════════════════════════════════════════════════════════════
section('§0  Harness self-check');
// ═════════════════════════════════════════════════════════════════════════
{
  const before = { p: passed, f: failed };
  const realLog = console.log; console.log = () => {};
  ok(false, 'internal: EXPECTED to fail');
  console.log = realLog;
  const failMoved = failed === before.f + 1;
  failed = before.f;
  ok(failMoved, 'control: ok() has a real failing direction');

  let err = null;
  try {
    const s = makeSandbox();
    s.api.listCtx(); s.api.domainFilterCfg(); s.api.newChatDomain(); s.api.conversationOpen();
    s.api.startNewChat();
    ask(s, 'probe');
  } catch (e) { err = e; }
  ok(err === null, 'every lifted function resolves its bindings and runs' + (err ? ' — ' + err.message : ''));

  // CONTROL — the reported defect is reproducible in this harness: with the
  // filter set but NOT read, a question asked from an opened Curation chat
  // goes to Curation. (A send in the open conversation is correct; §1 is
  // about the NEW chat.)
  const s = makeSandbox({ state: { domainFilter: 'newsradar', activeConversationId: 'c1', thread: [{ role: 'user', content: 'x' }] } });
  eq(ask(s, 'follow-up'), '/api/chat/curation', 'control: a follow-up in the OPEN Curation chat still posts to Curation');
}

// ═════════════════════════════════════════════════════════════════════════
section('§1  New chat FOLLOWS the list filter — the POST goes to the filter\'s domain');
// ═════════════════════════════════════════════════════════════════════════
{
  // Robin's path: a Curation conversation is open, the list is set to
  // NewsRadar, New chat is pressed, a question is asked.
  const s = makeSandbox({ state: { activeConversationId: 'c1', thread: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }] } });
  s.api.domainFilterCfg().onChange('newsradar');
  eq(s.state.activeDomain, 'curation', 'setting the filter leaves the OPEN Curation chat where it is');
  s.api.startNewChat();
  eq(s.state.activeDomain, 'newsradar', 'New chat adopts the filter\'s domain');
  eq(s.state.activeConversationId, null, '…as an empty new chat');
  eq(s.store.get('curator-next-chat-domain'), 'newsradar', '…and remembers it as the chat domain, like any domain change');
  ok(s.calls.projects.includes('newsradar'), '…and reads NewsRadar\'s projects (the project belongs to the domain)');
  eq(ask(s, 'What is new in AI?'), '/api/chat/newsradar', 'the question POSTs to /api/chat/newsradar');

  // Control: "All domains" keeps the active domain.
  const all = makeSandbox({ state: { activeConversationId: 'c1', thread: [{ role: 'user', content: 'q' }] } });
  all.api.startNewChat();
  eq(all.state.activeDomain, 'curation', 'control: with "All domains", New chat keeps the active domain');
  eq(ask(all, 'q2'), '/api/chat/curation', 'control: …and the POST goes there');

  // A filter value that cannot hold conversations (a read-only mirror, or a
  // domain since deleted) is never adopted.
  const mirror = makeSandbox({ state: { domainFilter: 'shared-team' } });
  mirror.api.startNewChat();
  eq(mirror.state.activeDomain, 'curation', 'a mirror slug in the filter is never adopted by New chat');
  const gone = makeSandbox({ state: { domainFilter: 'deleted-domain' } });
  gone.api.startNewChat();
  eq(gone.state.activeDomain, 'curation', 'nor is a domain that no longer exists');
}

// ═════════════════════════════════════════════════════════════════════════
section('§2  Filter change with NO conversation open moves the empty new chat');
// ═════════════════════════════════════════════════════════════════════════
{
  const s = makeSandbox();
  s.api.domainFilterCfg().onChange('newsradar');
  eq(s.state.domainFilter, 'newsradar', 'the filter is set');
  eq(s.state.activeDomain, 'newsradar', 'the empty new chat moved to the filter\'s domain');
  eq(s.calls.renderMain, 1, 'the main column (composer, header) is repainted once');
  eq(s.calls.load.length, 1, 'the list is reloaded once…');
  ok(s.calls.load[0].opts && s.calls.load[0].opts.sidebarOnly === true, '…as a sidebar-only repaint');
  eq(ask(s, 'q'), '/api/chat/newsradar', 'and the next question POSTs to /api/chat/newsradar');

  const back = makeSandbox({ state: { domainFilter: 'newsradar', activeDomain: 'newsradar' } });
  back.api.domainFilterCfg().onChange('');
  eq(back.state.domainFilter, null, '"All domains" clears the filter');
  eq(back.state.activeDomain, 'newsradar', '…and moves no domain (there is nothing to follow)');
  eq(back.calls.renderMain, 0, '…and repaints no main column');
}

// ═════════════════════════════════════════════════════════════════════════
section('§3  An OPEN conversation is never re-scoped by the filter');
// ═════════════════════════════════════════════════════════════════════════
{
  const opened = makeSandbox({ state: { activeConversationId: 'c1', thread: [{ role: 'user', content: 'q' }] } });
  opened.api.domainFilterCfg().onChange('newsradar');
  eq(opened.state.activeDomain, 'curation', 'an opened conversation stays in its domain');
  eq(opened.state.activeConversationId, 'c1', '…and stays open');
  eq(opened.calls.renderMain, 0, '…and the main column is not repainted');
  eq(ask(opened, 'follow-up'), '/api/chat/curation', '…and its follow-up still POSTs to its own domain');

  // A NEW chat whose first question is in flight has no id yet — but it is a
  // conversation on screen, and moving it would split one question from its answer.
  const inflight = makeSandbox({ state: { thread: [{ role: 'user', content: 'first' }], sending: true } });
  inflight.api.domainFilterCfg().onChange('newsradar');
  eq(inflight.state.activeDomain, 'curation', 'a new chat with its first question in flight is not moved');

  const sendingOnly = makeSandbox({ state: { sending: true } });
  ok(sendingOnly.api.conversationOpen() === true, 'conversationOpen() counts a turn in flight even before the thread paints');
  ok(makeSandbox().api.conversationOpen() === false, 'control: an empty new chat is not "open"');
}

// ═════════════════════════════════════════════════════════════════════════
section('§4  The scope line: "Open chat is in ‹A› · New chat in ‹B›"');
// ═════════════════════════════════════════════════════════════════════════
{
  const s = makeSandbox({ state: { activeConversationId: 'c1', thread: [{ role: 'user', content: 'q' }], domainFilter: 'newsradar' } });
  const html = LIST.conversationPaneHtml(s.api.listCtx());
  const line = (/<div class="sidebar-hint chat-list-scope"[\s\S]*?<\/button><\/div>/.exec(html) || [''])[0];
  ok(!!line, 'the line is in the pane when a Curation chat is open under a NewsRadar filter');
  const text = line.replace(/<[^>]+>/g, '');
  eq(text, 'Open chat is in Curation · New chat in NewsRadar', 'it reads, in words');
  ok(/Open chat is in <span class="cur-sb-dot cur-sb-dot-7"/.test(line), 'Curation carries its RECORDED slot (7), not its list position');
  ok(/New chat in <span class="cur-sb-dot cur-sb-dot-3"/.test(line), 'NewsRadar carries its RECORDED slot (3)');
  ok(/<button type="button" class="btn btn-ghost btn-xs chat-scope-new" id="chat-scope-new">New chat in /.test(line),
    'the second half is a button — the list head\'s own ghost xs button, no new component');
  ok(/role="status"/.test(line), 'the line is a status (it appears without the user acting on it)');
  ok(html.indexOf('chat-list-scope') > html.indexOf('chat-list-head') && html.indexOf('chat-list-scope') < html.indexOf('chat-conv-list'),
    'it sits in the list head, above the list');

  // …and is NOT there otherwise.
  const none = (st) => !/chat-list-scope/.test(LIST.conversationPaneHtml(makeSandbox({ state: st }).api.listCtx()));
  ok(none({ activeConversationId: 'c1', thread: [{ role: 'user', content: 'q' }], domainFilter: 'curation' }), 'absent when the filter IS the open chat\'s domain');
  ok(none({ activeConversationId: 'c1', thread: [{ role: 'user', content: 'q' }], domainFilter: null }), 'absent under "All domains"');
  ok(none({ domainFilter: 'newsradar' }), 'absent with no conversation open (New chat goes to the filter anyway)');
  // No slot recorded → no dot, never a guessed one.
  const noSlot = makeSandbox({ state: { activeConversationId: 'c1', thread: [{ role: 'user', content: 'q' }], domainFilter: 'newsradar',
    domains: [{ slug: 'curation', displayName: 'Curation' }, { slug: 'newsradar', displayName: 'NewsRadar' }] } });
  ok(!/cur-sb-dot/.test(LIST.scopeNoteHtml(noSlot.api.listCtx())), 'a domain with no recorded slot gets no dot');
  ok(/&lt;b&gt;/.test(LIST.scopeNoteHtml({ conversationOpen: true, activeDomain: 'a', domainFilter: 'b',
    domains: [{ slug: 'a', displayName: '<b>' }, { slug: 'b', displayName: 'B' }] })), 'a domain name is escaped');

  // The button, through the REAL wirePane: a new chat in the filter's domain,
  // and the line is gone on the next paint.
  const root = rootFromHtml(html);
  s.api.wirePane(root);
  const btn = root.querySelector('#chat-scope-new');
  ok(!!btn && btn._listeners.some((l) => l.t === 'click'), 'the real wirePane binds the button');
  btn.click();
  eq(s.state.activeDomain, 'newsradar', 'pressing it starts a chat in NewsRadar');
  eq(s.state.activeConversationId, null, '…a new, empty one');
  ok(!/chat-list-scope/.test(LIST.conversationPaneHtml(s.api.listCtx())), '…and the line is gone');
  eq(ask(s, 'q'), '/api/chat/newsradar', '…and the question POSTs to NewsRadar');
}

// ═════════════════════════════════════════════════════════════════════════
section('§5  The composer\'s Domain pill moves a SET filter with it');
// ═════════════════════════════════════════════════════════════════════════
{
  // The guide's own path: pick a domain in the pill, then press New chat. If
  // the filter stayed on the old domain, New chat (which follows the filter)
  // would undo the pick.
  const s = makeSandbox({ state: { domainFilter: 'curation', activeConversationId: 'c1', thread: [{ role: 'user', content: 'q' }] } });
  s.api.switchDomain('newsradar');
  eq(s.state.activeDomain, 'newsradar', 'the pill starts a new chat in NewsRadar');
  eq(s.state.domainFilter, 'newsradar', 'the filter follows the pick');
  eq(s.calls.load.length, 1, 'the list reloads once for the new filter');
  s.api.startNewChat();
  eq(s.state.activeDomain, 'newsradar', 'and a New chat afterwards stays in NewsRadar');

  const all = makeSandbox({ state: { domainFilter: null } });
  all.api.switchDomain('newsradar');
  eq(all.state.domainFilter, null, '"All domains" is left alone');
  eq(all.calls.load.length, 0, '…and the list (already spanning every domain) is not reloaded');

  const mirror = makeSandbox({ state: { domainFilter: 'curation' } });
  mirror.api.switchDomain('shared-team');
  eq(mirror.state.activeDomain, 'shared-team', 'a mirror can still be asked from the pill');
  eq(mirror.state.domainFilter, null, '…and the filter clears (a mirror holds no conversations to list)');
}

// ═════════════════════════════════════════════════════════════════════════
section('§6  Boot: the filter and the domain agree on arrival');
// ═════════════════════════════════════════════════════════════════════════
{
  const domainsFetch = (url) => Promise.resolve({
    json: async () => (String(url).startsWith('/api/domains/stats') ? { domains: DOMAINS } : {}),
  });

  // "Ask this domain" on Curation, with the list left on NewsRadar.
  const handoff = makeSandbox({ fetch: domainsFetch, state: { booted: false, domains: [], activeDomain: null, domainFilter: 'newsradar' } });
  await handoff.api.boot(1, { slug: 'curation' });
  eq(handoff.state.activeDomain, 'curation', 'a handoff lands in the handed domain');
  eq(handoff.state.domainFilter, 'curation', 'the filter follows the handoff');
  handoff.api.startNewChat();
  eq(handoff.state.activeDomain, 'curation', '…so New chat does not undo it');

  // No handoff: the saved domain is Curation, the list is on NewsRadar.
  const plain = makeSandbox({ fetch: domainsFetch, storage: { 'curator-next-chat-domain': 'curation' },
    state: { booted: false, domains: [], activeDomain: null, domainFilter: 'newsradar' } });
  await plain.api.boot(1, null);
  eq(plain.state.activeDomain, 'newsradar', 'with no handoff the chat starts where the filter points');
  eq(plain.calls.load[0] && plain.calls.load[0].active, 'newsradar', '…before the list loads and auto-opens a conversation there');

  // A filter on a domain that is gone is dropped, not followed.
  const stale = makeSandbox({ fetch: domainsFetch, storage: { 'curator-next-chat-domain': 'curation' },
    state: { booted: false, domains: [], activeDomain: null, domainFilter: 'deleted-domain' } });
  await stale.api.boot(1, null);
  eq(stale.state.domainFilter, null, 'a filter naming a domain that no longer exists is cleared');
  eq(stale.state.activeDomain, 'curation', '…and the saved domain stands');
}

// ═════════════════════════════════════════════════════════════════════════
section('§7  The model pick is said to be remembered');
// ═════════════════════════════════════════════════════════════════════════
{
  const foot = modelMenuFootHtml({});
  ok(/Your pick is remembered for every new chat on this computer/.test(foot), 'the composer model menu\'s foot line says so');
  const pts = (EXPLAINERS['settings.chat'].points || []).map((p) => p.text).join(' ');
  ok(/remembers your pick for every new chat on this computer/.test(pts), 'the Settings › Chat ⓘ says so');
}

console.log(`\n${'─'.repeat(60)}\nPassed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ chat scope-follow assertions failed'); process.exit(1); }
console.log('✅ All chat scope-follow assertions green');
