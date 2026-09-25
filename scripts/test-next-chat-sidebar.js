/**
 * test-next-chat-sidebar.js — OFFLINE suite for the Chat sidebar work:
 * conversation search that reaches message bodies, a live message count,
 * multi-select delete, and the domain-switch landing state.
 *
 * WHAT IS COVERED BEHAVIOURALLY (real code executed, no server, no network,
 * no DOM — the same boundary every other test-next-*.js suite draws):
 *
 *   §1  matchConversation + listConversations(domain, {q}) — the REAL
 *       functions from src/brain/files.js, against a REAL conversations
 *       directory in an isolated tempdir. The decisive case is a
 *       conversation whose TITLE does not contain the query and whose LAST
 *       message does: before this, search was title-only and a title is the
 *       first user message truncated at 57 chars, so everything said after
 *       the opening line of a thread was unreachable.
 *   §2  GET /api/chat/:domain's own handler, pulled out of the real express
 *       router and driven with fake req/res — including `?q=a&q=b`, which
 *       express delivers as an ARRAY. That is the one shape that can turn a
 *       malformed URL into a 500 (`[].trim` is not a function), so it is
 *       executed rather than reasoned about.
 *   §3  bumpMessageCountForTurn + MESSAGES_PER_TURN, extracted from
 *       views/chat.js and run against a fake state — including the
 *       empty-wiki reply, which reaches the same code path carrying
 *       `conversationId: null` and must NOT advance a count for a turn the
 *       server never wrote to disk.
 *   §4  pruneSelection — the invariant that makes bulk delete safe: a
 *       ticked id that is no longer in the rendered list is dropped, so a
 *       selection can never outlive the rows it names.
 *   §5  The one shared row/list/bulk-bar builder, executed: checkbox state,
 *       aria-labels, the match hint, the bulk bar's count and select-all
 *       label, and escaping of every server-derived string (driven through
 *       app.js's REAL escapeHtml). Includes the property that a row whose
 *       title does not contain the active query is still RENDERED — i.e.
 *       the client no longer second-guesses the server's filter.
 *
 * WHAT IS A SOURCE GUARD, stated as such rather than implied as coverage
 * (these subjects touch the DOM, timers or another module's internals and
 * are not extractable):
 *   §6  Single-copy: the row markup and the list grouping exist ONCE. They
 *       were two hand-maintained copies (renderSidebar and
 *       renderSidebarConversationsOnly), which is how a change lands in one
 *       render path and not the other.
 *   §7  switchDomain passes autoSelectMostRecent:false while boot() still
 *       passes true.
 *   §8  MESSAGES_PER_TURN agrees with the number of messages sendMessage
 *       actually appends in src/brain/chat.js. This is the guard that stops
 *       the sidebar drifting from the file on disk.
 *   §9  Timer hygiene — the debounced search timer is cancelled on teardown
 *       and on a domain switch.
 *   §10 chat.css: the scope bar's scrollbar is hidden in both engines, and
 *       does NOT use the layout-shifting `::-webkit-scrollbar { height }`
 *       form.
 */

import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ── Isolation, before anything imports a brain module ───────────────────
// BOTH env vars, deliberately: CURATOR_TEST_DOMAINS_DIR redirects only
// domains/, while CURATOR_TEST_USER_DATA_DIR redirects the four credential
// locations. Without the second one this suite would run against the
// developer's real .curator-config.json and .sync-config.json.
const TMP = mkdtempSync(path.join(tmpdir(), 'curator-chat-sidebar-'));
process.env.CURATOR_TEST_USER_DATA_DIR = path.join(TMP, 'userdata');
process.env.CURATOR_TEST_DOMAINS_DIR = path.join(TMP, 'domains');
mkdirSync(process.env.CURATOR_TEST_USER_DATA_DIR, { recursive: true });
mkdirSync(process.env.CURATOR_TEST_DOMAINS_DIR, { recursive: true });

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(a, b, label) {
  ok(a === b, `${label} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`);
}
function section(t) { console.log(`\n${t}`); }

// ── Comment stripping for source-level guards ───────────────────────────
// Same conservative shape as test-next-chat-compile.js's: this file's
// subjects carry comments that quote the very strings some guards assert
// about, so an absence/count check over raw text could be satisfied (or
// defeated) by prose. Strips /* */ blocks and whole-line // comments only.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}
function assertStrippedSane(stripped, label, mustContain) {
  for (const needle of mustContain) {
    if (!stripped.includes(needle)) {
      throw new Error(`stripComments over-reached on ${label}: "${needle}" is gone from the stripped code`);
    }
  }
  return stripped;
}

const CHAT_VIEW_PATH = path.join(ROOT, 'src/public/next/views/chat.js');
const CHAT_CSS_PATH = path.join(ROOT, 'src/public/next/views/chat.css');
const APP_PATH = path.join(ROOT, 'src/public/next/app.js');
const BRAIN_CHAT_PATH = path.join(ROOT, 'src/brain/chat.js');
const ROUTE_PATH = path.join(ROOT, 'src/routes/chat.js');

const chatView = readFileSync(CHAT_VIEW_PATH, 'utf8');
const chatCss = readFileSync(CHAT_CSS_PATH, 'utf8');
const appSrc = readFileSync(APP_PATH, 'utf8');
const brainChat = readFileSync(BRAIN_CHAT_PATH, 'utf8');
const routeSrc = readFileSync(ROUTE_PATH, 'utf8');

const chatViewCode = assertStrippedSane(stripComments(chatView), 'views/chat.js', [
  'function conversationListUrl(', 'function pruneSelection(', 'function switchDomain(',
]);
const brainChatCode = assertStrippedSane(stripComments(brainChat), 'brain/chat.js', [
  'conversation.messages.push(',
]);

// ── Extraction: real brace matching (same contract as its siblings — a
// missing name THROWS rather than silently testing nothing) ─────────────
function extractFunction(src, name) {
  const marker = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ${name}\\s*\\(`);
  const m = marker.exec(src);
  if (!m) throw new Error(`extractFunction: "${name}" not found`);
  const start = src.indexOf('function', m.index);
  let p = src.indexOf('(', start);
  if (p === -1) throw new Error(`extractFunction: "${name}" has no parameter list`);
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
  const extracted = src.slice(start, i);
  if (!/\n\}$/.test(extracted)) {
    throw new Error(`extractFunction: "${name}" extraction does not end at a top-level closing brace — the matcher desynced`);
  }
  return extracted;
}
function extractConst(src, name) {
  const re = new RegExp(`(?:^|\\n)const ${name} = [^\\n]*\\n`);
  const m = re.exec(src);
  if (!m) throw new Error(`extractConst: "${name}" not found`);
  return m[0].trim();
}

// ── Sandbox over views/chat.js's state helpers ───────────────────────────
// v3.72.0 (P3): the ROW, the LIST, the SELECT MODE'S BAR and the notice are
// views/chat-list.js's now — a DOM-free module, so §5 IMPORTS the real one
// rather than lifting functions into a sandbox. What stays extracted from
// chat.js is the state half: the per-turn row patch and the selection prune.
function buildSidebarSandbox() {
  const src =
    'const state = __state;\n' +
    'function convKey(d, id) { return String(d || "") + "/" + String(id || ""); }\n' +
    extractConst(chatView, 'MESSAGES_PER_TURN') + '\n' +
    extractFunction(chatView, 'pruneSelection') + '\n' +
    extractFunction(chatView, 'bumpMessageCountForTurn') + '\n' +
    'return { pruneSelection, bumpMessageCountForTurn, MESSAGES_PER_TURN };';
  return new Function('__state', src);
}
const makeSidebar = buildSidebarSandbox();
const LIST = await import('../src/public/next/views/chat-list.js');

function freshState(over = {}) {
  return Object.assign({
    domains: [{ slug: 'demo' }],
    activeDomain: 'demo',
    conversations: [],
    activeConversationId: null,
    searchQuery: '',
    selectedConvKeys: new Set(),
    bulkNotice: null,
    loadError: null,
  }, over);
}

// ═════════════════════════════════════════════════════════════════════════
section('§3 — bumpMessageCountForTurn: the row moves on the turn that wrote it');

{
  // The SAME id in another domain sits FIRST, so a patch that matched on the
  // id alone would hit it — mutation M16 (P3 report) was green until it did.
  const st = freshState({ conversations: [
    { id: 'a', domain: 'other', messageCount: 10 },
    { id: 'a', domain: 'demo', messageCount: 4 },
    { id: 'b', domain: 'demo', messageCount: 0 },
  ] });
  const S = makeSidebar(st);
  eq(S.MESSAGES_PER_TURN, 2, 'one completed turn appends two messages');

  S.bumpMessageCountForTurn('a', 'demo');
  eq(st.conversations[1].messageCount, 6, 'THE FIX: the row for the answered conversation advances by one turn');
  eq(st.conversations[2].messageCount, 0, 'no other row is touched');
  eq(st.conversations[0].messageCount, 10, '★ nor the SAME id in another domain — ids are unique only per domain (v3.72.0 all-domains list)');
  S.bumpMessageCountForTurn('a', 'demo');
  eq(st.conversations[1].messageCount, 8, 'a second turn advances it again');

  S.bumpMessageCountForTurn(null, 'demo');
  S.bumpMessageCountForTurn(undefined, 'demo');
  S.bumpMessageCountForTurn('', 'demo');
  eq(st.conversations[1].messageCount, 8,
    'a reply carrying NO conversationId (nothing was persisted) never advances a count');

  S.bumpMessageCountForTurn('not-in-the-list', 'demo');
  eq(st.conversations.length, 3, 'an id that is not on screen invents no row');

  st.conversations.push({ id: 'c', domain: 'demo' });
  st.conversations.push({ id: 'd', domain: 'demo', messageCount: 'x' });
  S.bumpMessageCountForTurn('c', 'demo');
  S.bumpMessageCountForTurn('d', 'demo');
  eq(st.conversations[3].messageCount, undefined, 'a row with no count is left alone, never given "NaN"');
  eq(st.conversations[4].messageCount, 'x', 'a non-numeric count is left alone, never string-concatenated');

  // v3.72.0 (P1 facts): the turn's `updatedAt` makes the row LAST USED now,
  // so it moves to the top — the server's own order, applied locally — and
  // its recorded project becomes the row's.
  S.bumpMessageCountForTurn('b', 'demo', { updatedAt: '2026-09-25T10:00:00.000Z', project: 'curator' });
  eq(st.conversations[0].id + '@' + st.conversations[0].domain, 'b@demo', '★ a turn with a real updatedAt moves its row to the top');
  eq(st.conversations[0].updatedAt, '2026-09-25T10:00:00.000Z', '…and the row carries it, so its age and group are last use');
  eq(st.conversations[0].lastProject, 'curator', '★ the turn\'s recorded project becomes the row\'s project mark');
  S.bumpMessageCountForTurn('b', 'demo', { updatedAt: 'not-a-date', project: 'x'.repeat(65) });
  eq(st.conversations[0].updatedAt, '2026-09-25T10:00:00.000Z', 'a malformed updatedAt changes nothing');
  eq(st.conversations[0].lastProject, 'curator', 'a project name over 64 characters is not taken (the server drops it too)');
  S.bumpMessageCountForTurn('b', 'demo', { project: null });
  eq(st.conversations[0].lastProject, null, 'a turn that recorded NO project says so (null), so the mark goes');
  S.bumpMessageCountForTurn('b', 'demo', {});
  eq(st.conversations[0].lastProject, null, 'and a server that sent no `project` key changes nothing');
}

// ═════════════════════════════════════════════════════════════════════════
section('§4 — pruneSelection: a ticked row can never outlive the row it names');

{
  const st = freshState({
    conversations: [{ id: 'a', domain: 'demo' }, { id: 'b', domain: 'demo' }],
    selectedConvKeys: new Set(['demo/a', 'demo/b', 'demo/ghost', 'other/a']),
  });
  const S = makeSidebar(st);
  S.pruneSelection();
  eq(st.selectedConvKeys.size, 2, 'a key absent from the list is dropped');
  ok(st.selectedConvKeys.has('demo/a') && st.selectedConvKeys.has('demo/b'), 'keys still on screen are KEPT');
  ok(!st.selectedConvKeys.has('other/a'), '★ the same id in ANOTHER domain is a different row, and it is not on screen');

  st.conversations = [];
  S.pruneSelection();
  eq(st.selectedConvKeys.size, 0, 'an emptied list (a failed load, a filtering search) empties the selection');
}

// ═════════════════════════════════════════════════════════════════════════
section('§5 — the ONE row/list/bulk builder (views/chat-list.js), executed');

{
  const NOW = Date.parse('2026-09-25T15:00:00');
  const ctx = (over = {}) => Object.assign({
    domains: [{ slug: 'demo', displayName: 'Demo' }, { slug: 'biz', displayName: 'Business' }],
    activeDomain: 'demo', activeConversationId: null, conversations: [],
    selectMode: false, selectedKeys: new Set(), searchQuery: '', loadError: null, now: NOW,
  }, over);
  const A = { id: 'a', domain: 'demo', title: 'First thread', createdAt: '2020-01-01T00:00:00.000Z', messageCount: 1 };
  const B = { id: 'b', domain: 'biz', title: 'Second thread', createdAt: '2020-01-01T00:00:00.000Z', messageCount: 12, matchField: 'message' };

  const rowA = LIST.conversationRowHtml(A, ctx());
  ok(rowA.includes('class="cur-sb-row'), '★ the row IS the one sidebar component (renderSidebarRow)');
  ok(rowA.includes('1 message<'), 'a single-message row is not pluralised');
  ok(!rowA.includes('matched in'), 'a row with no matchField carries no hint');
  ok(rowA.includes('data-conv-select="a"') && rowA.includes('data-conv-domain="demo"'),
    'the row opens the conversation, naming its OWN domain');
  ok(rowA.includes('data-conv-delete="a"') && /class="row-act chat-conv-act"/.test(rowA),
    '★ the per-row delete is the ONE row action (.row-act), visible at rest');
  ok(!rowA.includes('type="checkbox"'), '★ no checkbox at rest — selection is a MODE (M3)');
  const rowB = LIST.conversationRowHtml(B, ctx());
  ok(rowB.includes('12 messages'), 'a multi-message row is pluralised');
  ok(rowB.includes('matched in a message'), 'a row that matched in a body says so, so the match is not a mystery');
  ok(/cur-sb-dot cur-sb-dot-2/.test(rowB) && /cur-sb-dot cur-sb-dot-1/.test(rowA),
    '★ each row carries ITS domain\'s identity dot, from the install\'s domain index');
  ok(rowB.includes('>Business'), '…and the domain in words, so colour is never the only carrier');

  const sel = ctx({ selectMode: true, selectedKeys: new Set(['demo/a']) });
  const rowSel = LIST.conversationRowHtml(A, sel);
  ok(rowSel.includes('data-conv-check="demo/a"') && rowSel.includes(' checked'), 'in Select mode a ticked row renders checked');
  ok(rowSel.includes('aria-label="Select First thread"'), 'the checkbox names the conversation it selects');
  ok(/class="chat-conv-item selected"/.test(rowSel), 'and the item is marked selected');

  const nasty = LIST.conversationRowHtml({ id: '"><script>x</script>', domain: 'demo', title: '<img src=x onerror=1>', messageCount: 1 }, sel);
  ok(!nasty.includes('<script>'), 'a hostile conversation id cannot break out of an attribute');
  ok(!nasty.includes('<img src=x'), 'a hostile title cannot inject an element');
  ok(nasty.includes('&lt;img'), 'the hostile title is rendered as escaped text');

  // THE CLIENT DOES NOT SECOND-GUESS THE SERVER'S FILTER.
  const html = LIST.conversationListHtml(ctx({ conversations: [{ id: 'x', domain: 'demo', title: 'Ingest pipeline', createdAt: '2020-01-01T00:00:00.000Z', messageCount: 2, matchField: 'message' }], searchQuery: 'graphql' }));
  ok(html.includes('Ingest pipeline'), 'a row the SERVER matched on a message body is rendered even though its title lacks the query');
  ok(!html.includes('No conversations match'), 'and it is not reported as no match');
  ok(LIST.conversationListHtml(ctx({ searchQuery: 'graphql' })).includes('No conversations match “graphql”'),
    'an empty filtered list says the query matched nothing, quoting it');
  ok(LIST.conversationListHtml(ctx()).includes('No conversations yet.'), 'an empty unfiltered list says so');
  ok(LIST.conversationListHtml(ctx({ domainFilter: 'biz' })).includes('No conversations in Business yet.'),
    'a domain-filtered empty list names the domain');
  ok(!LIST.conversationListHtml(ctx({ searchQuery: '<img src=x>' })).includes('<img src=x>'), 'the echoed query is escaped');
  const err = LIST.conversationListHtml(ctx({ loadError: 'boom <b>' }));
  ok(err.includes('chat-sidebar-error') && !err.includes('<b>'), 'a load error renders the escaped error state');

  // SELECT MODE'S BAR (M3): Select all · N selected · Delete N · Done.
  const two = [A, B];
  ok(LIST.selectBarHtml(ctx({ conversations: two })) === '', 'no bar outside Select mode');
  let bar = LIST.selectBarHtml(ctx({ conversations: two, selectMode: true }));
  ok(bar.includes('Select all') && bar.includes('id="chat-bulk-all"'), 'Select all is a real checkbox, offered first');
  ok(/id="chat-bulk-delete" disabled/.test(bar), 'Delete is present but DISABLED while nothing is ticked');
  ok(bar.includes('id="chat-select-done"'), 'and Done leaves the mode');
  bar = LIST.selectBarHtml(ctx({ conversations: two, selectMode: true, selectedKeys: new Set(['demo/a']) }));
  ok(bar.includes('1 selected') && bar.includes('>Delete 1<'), 'the bar states the count, and Delete names it');
  ok(bar.includes('Delete 1 selected conversation"'), 'the delete control names the count for assistive tech, singular');
  ok(!/btn-danger/.test(bar), '★ Delete is NEUTRAL — red belongs to the confirm alone (M3)');
  bar = LIST.selectBarHtml(ctx({ conversations: two, selectMode: true, selectedKeys: new Set(['demo/a', 'biz/b']) }));
  ok(bar.includes('2 selected') && bar.includes('Delete 2 selected conversations"'), 'plural, across TWO domains');
  ok(/id="chat-bulk-all" checked/.test(bar), 'select-all is checked when everything is selected');

  ok(LIST.bulkNoticeHtml({ text: 'Deleted 3 conversations.', tone: 'ok' }).includes('Deleted 3 conversations.'), 'a success notice reports the real number');
  ok(LIST.bulkNoticeHtml({ text: 'x', tone: 'error' }).includes('chat-bulk-notice error'), 'a partial failure IS styled as an error');
  ok(!LIST.bulkNoticeHtml({ text: '<b>x</b>' }).includes('<b>'), 'the notice text is escaped');

  const pane = LIST.conversationPaneHtml(ctx({ conversations: two, selectMode: true }));
  ok(pane.indexOf('chat-bulk-bar') < pane.indexOf('chat-conv-list'), 'the bar renders above the list');
  ok(/class="chat-conv-list row-select-mode"/.test(pane),
    '★ Select mode hides the per-row trash through row-action.css\'s ONE rule (.row-select-mode .row-act)');
  ok(!/row-select-mode/.test(LIST.conversationPaneHtml(ctx({ conversations: two }))), 'and only in Select mode');
}

// ═════════════════════════════════════════════════════════════════════════
section('§6 — SOURCE GUARD: the row markup and list grouping exist exactly ONCE');

{
  ok(!/function conversationRowHtml\(/.test(chatViewCode) && !/function conversationListHtml\(/.test(chatViewCode),
    'views/chat.js builds NO row and NO list of its own — views/chat-list.js is the one copy');
  ok(/import \{[^}]*conversationPaneHtml[^}]*\} from '\.\/chat-list\.js'/.test(chatViewCode),
    'chat.js imports the pane builder from views/chat-list.js');
  ok(/renderSidebarConversationsOnly\([^)]*\)\s*\{[\s\S]{0,400}?conversationPaneBody\(\)/.test(chatViewCode),
    'the light re-render reuses the same pane builder');
  ok(/function renderSidebar\([\s\S]{0,6000}?conversationPaneBody\(\)/.test(chatViewCode),
    'and so does the full render');
  ok(!/state\.conversations\.filter\(\s*c\s*=>\s*\(c\.title/.test(chatViewCode),
    'no client-side title filter survives — the server owns the search');
}

// ═════════════════════════════════════════════════════════════════════════
section('§7 — SOURCE GUARD: a domain pick starts a new chat there; boot restores');

{
  // v3.72.0 (M2): the composer's domain pill. A conversation lives in ONE
  // domain, so picking another can never re-scope the thread: it starts a
  // NEW chat there. The list spans every domain, so nothing in it resets.
  const switchSrc = extractFunction(chatViewCode, 'switchDomain');
  ok(/state\.activeConversationId = null/.test(switchSrc) && /state\.thread = \[\]/.test(switchSrc),
    'switchDomain lands on an empty new chat');
  ok(/adoptActiveDomain\(slug/.test(switchSrc), 'and makes that domain active through the ONE domain-change path');
  ok(!/loadConversationList\(/.test(switchSrc), '…without reloading a list that already spans every domain');
  ok(!/selectedConvKeys\.clear\(\)/.test(switchSrc), '…or throwing away a selection that is not per-domain any more');
  const bootSrc = extractFunction(chatViewCode, 'boot');
  ok(/autoSelectMostRecent:\s*true/.test(bootSrc), 'boot() still auto-selects the most recent conversation');
  const listSrc = extractFunction(chatViewCode, 'loadConversationList');
  ok(/\(c\.domain \|\| state\.activeDomain\) === state\.activeDomain/.test(listSrc),
    '…in the ACTIVE domain — a handoff that said "ask Articles" lands in Articles, not in a newer thread elsewhere');
}

// ═════════════════════════════════════════════════════════════════════════
section('§8 — SOURCE GUARD: MESSAGES_PER_TURN agrees with what the server writes');

{
  const pushes = (brainChatCode.match(/conversation\.messages\.push\(/g) || []).length;
  eq(pushes, 2, 'src/brain/chat.js appends exactly two messages per completed turn');
  const S = makeSidebar(freshState());
  eq(S.MESSAGES_PER_TURN, pushes,
    'MESSAGES_PER_TURN equals the number the server actually writes (change one, this goes red)');
  ok(brainChatCode.includes('await writeConversation(domain, conversation);'),
    'and those pushes are followed by the write that persists them');
}

// ═════════════════════════════════════════════════════════════════════════
section('§9 — SOURCE GUARD: timer hygiene and the debounced refetch');

{
  ok(/function cancelSearchTimer\(\)/.test(chatViewCode), 'the search timer has a single cancel point');
  ok(/return \(\) => \{[\s\S]{0,900}?cancelSearchTimer\(\)/.test(chatViewCode),
    'the teardown cancels the debounced search timer');
  ok(/scheduleConversationSearch\(myMountToken\)/.test(chatViewCode),
    'typing schedules a debounced refetch rather than filtering in place');
  const scheduleSrc = extractFunction(chatViewCode, 'scheduleConversationSearch');
  ok(/cancelSearchTimer\(\)/.test(scheduleSrc), 'a new keystroke supersedes the pending timer rather than stacking one');
  ok(/isCurrentMount\(mountToken\)/.test(scheduleSrc), 'and the fired callback refuses to act on a dead mount');

  // Every REFRESH of an existing list carries the active query. boot() is
  // exempt by NAME: it has no query to carry yet.
  const loadCalls = chatViewCode.match(/loadConversationList\([^;]*?\);/gs) || [];
  const bootSrcForCalls = extractFunction(chatViewCode, 'boot');
  const refreshCalls = loadCalls.filter(c => !bootSrcForCalls.includes(c));
  ok(refreshCalls.length >= 5, `there are several list REFRESH call sites (found ${refreshCalls.length})`);
  ok(refreshCalls.every(c => /q:\s*state\.searchQuery/.test(c)),
    'every list refresh (send, single delete, bulk delete, search, the domain filter) passes the active search query');
  // The URL builder, executed: the list and the filter each reach the right route.
  const urlOf = new Function(extractConst(chatView, 'LIST_LIMIT') + '\n' +
    extractFunction(chatViewCode, 'conversationListUrl') + '\nreturn conversationListUrl;')();
  eq(urlOf(null, ''), '/api/chat?limit=500', '★ all domains → GET /api/chat (every non-mirror domain, with its true total)');
  eq(urlOf(null, ' rag eval '), '/api/chat?limit=500&q=rag%20eval', '…with the search, trimmed and encoded');
  eq(urlOf('biz', ''), '/api/chat/biz', '★ one domain → GET /api/chat/:domain, the route that lists one domain in full');
  eq(urlOf('a/b', 'x&y'), '/api/chat/a%2Fb?q=x%26y', 'the slug and the query are encoded');
}

// ═════════════════════════════════════════════════════════════════════════
section('§10 — the scope bar is GONE (v3.72.0, M2) and nothing restyles it');

{
  ok(!/\.chat-scopebar\b/.test(stripComments(chatCss)),
    'chat.css carries no .chat-scopebar rule — the domain and project moved to the composer, Compile to the header');
  ok(!/chat-scopebar|chat-scope-pill/.test(chatViewCode), 'and chat.js emits neither the bar nor its pills');
}

// ═════════════════════════════════════════════════════════════════════════
section('§11 — SOURCE GUARD: the zero-domain state states its case ONCE');
// ═════════════════════════════════════════════════════════════════════════
//
// With no domains, the sidebar said "No domains exist yet — nothing to chat
// with." while the centre pane's empty card said the same thing — BOTH ON
// SCREEN AT ONCE. That is the duplicated-copy class v3.20.0 deleted 712
// characters of, whose sharpest instance was Shared Brain's sidebar and
// centre sharing 160 characters verbatim while both were visible.
//
// THE CENTRE COPY IS THE ONE THAT SURVIVES, and this section pins the
// direction rather than merely the deletion — a guard that only checks the
// sidebar string is gone stays green if someone later deletes the centre one
// too and leaves the user with an unexplained disabled button.
{
  const src = stripComments(chatView);

  ok(!/class="sidebar-hint">No domains exist yet/.test(src),
    'the sidebar no longer restates what the centre pane already says');
  // NOT `/nothing to chat with/i` — that phrase is also the CENTRE card's
  // title ("Nothing to chat with yet"), which is the copy that survives. The
  // first draft of this assertion used it and went red on the legitimate
  // half, which is the guard doing its job on its own author.
  ok(!/No domains exist yet/.test(src),
    '…and the sentence is gone, not merely re-dressed in a different class');

  // The surviving half, asserted as PRESENT. It says the same fact AND what
  // to do about it, next to the button that does it.
  ok(/Chat needs at least one domain to talk to\. Create one in Domains\./.test(src),
    'the centre empty card still states the fact — the half that also acts');
  ok(/id="chat-goto-domains"/.test(src),
    '…and still carries the control that resolves it');
  ok(/Nothing to chat with yet/.test(src),
    '…under a title, so the empty state is not a bare button');

  // The sidebar is left with a header and a disabled New chat. That is not an
  // unexplained dead control — its reason is in the dominant region beside the
  // fix — and it is what views/ingest.js already renders in the same state.
  const ingest = readFileSync(path.join(ROOT, 'src/public/next/views/ingest.js'), 'utf8');
  ok(/const listBlock = state\.domains\.length\s*\?/.test(stripComments(ingest)),
    'CONTROL: ingest.js renders an EMPTY sidebar block in the same zero-domain state, so this is the house shape');
  ok(/newChatBtn\.disabled = true/.test(src),
    'the New chat button is still disabled with no domains — the cut removed copy, not the guard');
}

// ── Cleanup ─────────────────────────────────────────────────────────────
rmSync(TMP, { recursive: true, force: true });

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All chat sidebar assertions green');
