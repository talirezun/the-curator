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
  'function conversationRowHtml(', 'function pruneSelection(', 'function switchDomain(',
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

// ── Sandbox over views/chat.js's pure sidebar helpers ────────────────────
// `state` is injected; escapeHtml is the REAL one lifted out of app.js (so
// the escaping assertions test what actually ships, not a stand-in);
// isSameLocalDay is the real one from chat.js; icon() is a stub because it
// only ever contributes an <svg> this suite does not assert on.
function buildSidebarSandbox() {
  const src =
    'const state = __state;\n' +
    extractFunction(appSrc, 'escapeHtml') + '\n' +
    extractFunction(chatView, 'isSameLocalDay') + '\n' +
    'function icon(n, s) { return "<svg data-icon=\\"" + n + "\\"></svg>"; }\n' +
    extractConst(chatView, 'MESSAGES_PER_TURN') + '\n' +
    extractFunction(chatView, 'matchHint') + '\n' +
    extractFunction(chatView, 'conversationRowHtml') + '\n' +
    extractFunction(chatView, 'conversationListHtml') + '\n' +
    extractFunction(chatView, 'bulkBarHtml') + '\n' +
    extractFunction(chatView, 'bulkNoticeHtml') + '\n' +
    extractFunction(chatView, 'conversationPaneHtml') + '\n' +
    extractFunction(chatView, 'pruneSelection') + '\n' +
    extractFunction(chatView, 'bumpMessageCountForTurn') + '\n' +
    'return { matchHint, conversationRowHtml, conversationListHtml, bulkBarHtml, ' +
    'bulkNoticeHtml, conversationPaneHtml, pruneSelection, bumpMessageCountForTurn, ' +
    'MESSAGES_PER_TURN };';
  return new Function('__state', src);
}
const makeSidebar = buildSidebarSandbox();

function freshState(over = {}) {
  return Object.assign({
    domains: [{ slug: 'demo' }],
    conversations: [],
    activeConversationId: null,
    searchQuery: '',
    selectedConvIds: new Set(),
    bulkNotice: null,
    loadError: null,
  }, over);
}

// ═════════════════════════════════════════════════════════════════════════
section('§1 — listConversations(domain, {q}) and matchConversation (REAL files.js, real tempdir)');

const files = await import(path.join(ROOT, 'src/brain/files.js'));
const { listConversations, matchConversation, CONVERSATION_SEARCH_MAX_CHARS, conversationsPath } = files;

const DOMAIN = 'searchdemo';
const convDir = conversationsPath(DOMAIN);
mkdirSync(convDir, { recursive: true });
// The CLAUDE.md schema is what makes a directory a DOMAIN (listDomains filters
// on it, so ghost folders left by a sync deletion are not domains). §2 drives
// the real GET /api/chat/:domain handler, which now refuses a name that is not
// on that allow-list — the guard that closes the `..%2f` traversal — so the
// fixture has to be a real domain rather than a bare directory.
writeFileSync(path.join(path.dirname(convDir), 'CLAUDE.md'), '# searchdemo\n');
function uuidN(n) { return String(n).padStart(8, '0') + '-0000-4000-8000-000000000000'; }
function writeConv(n, title, messages, createdAt) {
  const id = uuidN(n);
  writeFileSync(path.join(convDir, id + '.json'), JSON.stringify({
    id, title, createdAt: createdAt || new Date(2026, 0, 1, 12, 0, n).toISOString(),
    domain: DOMAIN, messages,
  }));
  return id;
}
// (1) title carries the needle, bodies do not.
const ID_TITLE = writeConv(1, 'Kubernetes rollout plan', [
  { role: 'user', content: 'how do we stage this' },
  { role: 'assistant', content: 'stage it in three waves' },
]);
// (2) THE DECISIVE ONE — the needle appears only in the LAST message, and the
// title is a plausible truncated opening line that does not contain it.
const ID_BODY = writeConv(2, 'What is the best way to structure the ingest pi…', [
  { role: 'user', content: 'What is the best way to structure the ingest pipeline for large PDFs' },
  { role: 'assistant', content: 'Batch the phases.' },
  { role: 'user', content: 'and what about GRAPHQL for the read side' },
]);
// (3) matches nothing.
const ID_NONE = writeConv(3, 'Weekly review', [
  { role: 'user', content: 'summarise the week' },
]);
// (4) malformed messages array + a non-string content — must not throw.
writeConv(4, 'Odd shapes', [{ role: 'user' }, { role: 'assistant', content: { not: 'a string' } }]);
// (5) genuinely malformed JSON — the pre-existing skip path must still hold.
writeFileSync(path.join(convDir, uuidN(5) + '.json'), '{ this is not json');

const all = await listConversations(DOMAIN);
eq(all.length, 4, 'no query → every well-formed conversation (malformed file skipped)');
ok(all.every(c => !('matchField' in c)), 'unfiltered rows carry NO matchField (there is no match to explain)');
ok(all.every(c => typeof c.messageCount === 'number'), 'unfiltered rows carry a numeric messageCount');

const byTitle = await listConversations(DOMAIN, { q: 'kubernetes' });
eq(byTitle.length, 1, 'title match found (case-insensitive: query "kubernetes" vs title "Kubernetes")');
eq(byTitle[0].id, ID_TITLE, 'title match returns the right conversation');
eq(byTitle[0].matchField, 'title', 'a title match reports matchField "title"');

const byBody = await listConversations(DOMAIN, { q: 'graphql' });
eq(byBody.length, 1, 'THE FIX: a needle only in the LAST message is found — unreachable when search was title-only');
eq(byBody[0].id, ID_BODY, 'body match returns the right conversation');
eq(byBody[0].matchField, 'message', 'a body match reports matchField "message"');
eq(byBody[0].messageCount, 3, 'messageCount is the conversation length, NOT the number of matching messages');

eq((await listConversations(DOMAIN, { q: 'GRAPHQL' })).length, 1, 'uppercase query matches lowercase body');
eq((await listConversations(DOMAIN, { q: 'zzz-no-such-thing' })).length, 0, 'a miss returns an empty list, not everything');
eq((await listConversations(DOMAIN, { q: '   ' })).length, 4, 'a whitespace-only query is NO filter (not a filter matching nothing)');
eq((await listConversations(DOMAIN, { q: '' })).length, 4, 'an empty query is no filter');
eq((await listConversations(DOMAIN, {})).length, 4, 'an absent q is no filter');
// These inputs are the ones that can THROW rather than mis-filter (`42.slice`
// / `[].trim` are not functions), so they go through a catching wrapper: a
// suite that dies on the first bad input reports a red for the wrong reason
// and hides every assertion after it.
async function listOrThrew(opts) {
  try { return await listConversations(DOMAIN, opts); }
  catch (err) { return { threw: String(err && err.message).slice(0, 80) }; }
}
{
  const r = await listOrThrew({ q: null });
  eq(Array.isArray(r) ? r.length : r, 4, 'a null q is no filter');
  const r2 = await listOrThrew({ q: 42 });
  eq(Array.isArray(r2) ? r2.length : r2, 4, 'a non-string q is no filter and does not throw (never coerced into a needle)');
  const r3 = await listOrThrew({ q: ['a', 'b'] });
  eq(Array.isArray(r3) ? r3.length : r3, 4, 'an ARRAY q — what express hands over for ?q=a&q=b — is no filter and does not throw');
  const r4 = await listOrThrew({ q: { toString() { return 'kubernetes'; } } });
  eq(Array.isArray(r4) ? r4.length : r4, 4, 'an object that stringifies to a real needle is still not a needle');
}

// Truncation is DECISIVE only where the first CONVERSATION_SEARCH_MAX_CHARS
// of the query are present in the haystack and the tail is not: a shorter
// prefix is a LESS restrictive needle, so the truncated query matches while
// the full one cannot. Constructed exactly that way rather than asserted
// about a query that would have missed either way.
writeConv(6, 'Long body', [{ role: 'user', content: 'A'.repeat(CONVERSATION_SEARCH_MAX_CHARS + 50) }]);
const overLong = 'A'.repeat(CONVERSATION_SEARCH_MAX_CHARS) + 'B'.repeat(60);
eq((await listConversations(DOMAIN, { q: overLong })).length, 1,
  'an over-long query is TRUNCATED to the cap and still matches — the failure direction is a superset, never a false empty');
eq((await listConversations(DOMAIN, { q: 'A'.repeat(CONVERSATION_SEARCH_MAX_CHARS) + 'B' })).length, 1,
  'one character past the cap is already discarded (the bound is the cap, not "roughly the cap")');
eq((await listConversations(DOMAIN, { q: 'A'.repeat(CONVERSATION_SEARCH_MAX_CHARS - 1) + 'B' })).length, 0,
  'a query INSIDE the cap is honoured in full — truncation is a bound, not a blanket prefix match');
ok((await listConversations(DOMAIN, { q: 'q'.repeat(500000) })).length === 0,
  'a half-megabyte query neither throws nor is scanned in full');
ok(CONVERSATION_SEARCH_MAX_CHARS > 0 && CONVERSATION_SEARCH_MAX_CHARS <= 1000, 'the search cap is a real bound');

const sorted = await listConversations(DOMAIN, { q: 'the' });
ok(sorted.length >= 2, 'a common word matches several conversations');
ok(new Date(sorted[0].createdAt) >= new Date(sorted[sorted.length - 1].createdAt),
  'filtered results keep the newest-first ordering');

// matchConversation directly — including the shapes that must not throw.
eq(matchConversation({ title: 'abc', messages: [] }, 'abc'), 'title', 'matchConversation: title hit');
eq(matchConversation({ title: 'abc', messages: [{ content: 'zed' }] }, 'zed'), 'message', 'matchConversation: body hit');
eq(matchConversation({ title: 'abc', messages: [] }, 'nope'), null, 'matchConversation: miss returns null');
eq(matchConversation({ title: 'abc' }, ''), null, 'matchConversation: an empty needle never matches (no filter is decided upstream)');
eq(matchConversation(null, 'x'), null, 'matchConversation: a null conversation does not throw');
eq(matchConversation({ title: 7, messages: 'nope' }, 'x'), null, 'matchConversation: non-string title / non-array messages do not throw');
eq(matchConversation({ messages: [{ content: null }, { content: 'hit' }] }, 'hit'), 'message',
  'matchConversation: a null message body does not stop the scan reaching a later one');
ok(matchConversation({ title: 'x', messages: [{ content: 'x' }] }, 'x') === 'title',
  'title is checked before bodies (the cheap case wins)');

// ═════════════════════════════════════════════════════════════════════════
section('§2 — GET /api/chat/:domain honours ?q= (the REAL route handler)');

// Derived from §1's fixtures rather than hardcoded, so adding a fixture up
// there cannot silently make this section assert about the wrong number.
const TOTAL_CONVS = (await listConversations(DOMAIN)).length;

const routerMod = await import(path.join(ROOT, 'src/routes/chat.js'));
const router = routerMod.default;
const listLayer = router.stack.find(l => l.route && l.route.path === '/:domain' && l.route.methods.get);
ok(!!listLayer, 'the list route is registered at GET /:domain');
const listHandler = listLayer.route.stack[0].handle;

async function callList(query) {
  return await new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(body) { resolve({ statusCode: this.statusCode, body }); },
    };
    listHandler({ params: { domain: DOMAIN }, query }, res, () => resolve({ statusCode: 0, body: null }));
  });
}

const r1 = await callList({});
eq(r1.statusCode, 200, 'no q → 200');
eq(r1.body.conversations.length, TOTAL_CONVS, 'no q → the full list');
const r2 = await callList({ q: 'graphql' });
eq(r2.body.conversations.length, 1, 'q reaches listConversations and filters on message bodies');
eq(r2.body.conversations[0].matchField, 'message', 'matchField survives to the wire');
// express delivers a repeated parameter as an ARRAY. `[].slice()` returns an
// array and `.trim` is not a function on it, so an unguarded route turns a
// malformed URL into a 500 — executed, not reasoned about.
const r3 = await callList({ q: ['a', 'b'] });
eq(r3.statusCode, 200, 'a REPEATED ?q=a&q=b (an array) does not 500');
eq(r3.body.conversations.length, TOTAL_CONVS, 'a repeated q is treated as no query at all');
const r4 = await callList({ q: undefined });
eq(r4.statusCode, 200, 'an absent q does not 500');

// ═════════════════════════════════════════════════════════════════════════
section('§3 — bumpMessageCountForTurn: the sidebar count moves on the turn that wrote it');

{
  const st = freshState({ conversations: [{ id: 'a', messageCount: 4 }, { id: 'b', messageCount: 0 }] });
  const S = makeSidebar(st);
  eq(S.MESSAGES_PER_TURN, 2, 'one completed turn appends two messages');

  S.bumpMessageCountForTurn('a');
  eq(st.conversations[0].messageCount, 6, 'THE FIX: the row for the answered conversation advances by one turn');
  eq(st.conversations[1].messageCount, 0, 'no other row is touched');
  S.bumpMessageCountForTurn('a');
  eq(st.conversations[0].messageCount, 8, 'a second turn advances it again');

  // The empty-wiki reply: sendMessage returns prose with conversationId null
  // and writes NOTHING. It lands in this same branch.
  S.bumpMessageCountForTurn(null);
  S.bumpMessageCountForTurn(undefined);
  S.bumpMessageCountForTurn('');
  eq(st.conversations[0].messageCount, 8,
    'a reply carrying NO conversationId (nothing was persisted) never advances a count');

  S.bumpMessageCountForTurn('not-in-the-list');
  eq(st.conversations.length, 2, 'an id that is not on screen invents no row');

  st.conversations.push({ id: 'c' });                 // no messageCount at all
  st.conversations.push({ id: 'd', messageCount: 'x' }); // wrong type
  S.bumpMessageCountForTurn('c');
  S.bumpMessageCountForTurn('d');
  eq(st.conversations[2].messageCount, undefined, 'a row with no count is left alone, never given "NaN"');
  eq(st.conversations[3].messageCount, 'x', 'a non-numeric count is left alone, never string-concatenated');
}

// ═════════════════════════════════════════════════════════════════════════
section('§4 — pruneSelection: a ticked id can never outlive the row it names');

{
  const st = freshState({
    conversations: [{ id: 'a' }, { id: 'b' }],
    selectedConvIds: new Set(['a', 'b', 'ghost']),
  });
  const S = makeSidebar(st);
  S.pruneSelection();
  eq(st.selectedConvIds.size, 2, 'an id absent from the list is dropped');
  ok(st.selectedConvIds.has('a') && st.selectedConvIds.has('b'), 'ids still on screen are KEPT (a refresh must not discard the user\u2019s ticks)');
  ok(!st.selectedConvIds.has('ghost'), 'the vanished id is gone — a bulk delete cannot reach a row the user cannot see');

  st.conversations = [];
  S.pruneSelection();
  eq(st.selectedConvIds.size, 0, 'an emptied list (a failed load, a filtering search) empties the selection');

  const st2 = freshState({ conversations: [{ id: 'a' }] });
  const S2 = makeSidebar(st2);
  S2.pruneSelection();
  eq(st2.selectedConvIds.size, 0, 'an empty selection stays empty and does not throw');
}

// ═════════════════════════════════════════════════════════════════════════
section('§5 — the ONE shared row/list/bulk builder, executed');

{
  const st = freshState({
    conversations: [
      { id: 'a', title: 'First thread', createdAt: '2020-01-01T00:00:00.000Z', messageCount: 1 },
      { id: 'b', title: 'Second thread', createdAt: '2020-01-01T00:00:00.000Z', messageCount: 12, matchField: 'message' },
    ],
  });
  const S = makeSidebar(st);

  const rowA = S.conversationRowHtml(st.conversations[0]);
  ok(rowA.includes('data-conv-check="a"'), 'every row carries a selection checkbox');
  ok(rowA.includes('type="checkbox"'), 'the checkbox is a real input, not a styled div');
  ok(!rowA.includes(' checked'), 'an unselected row renders unchecked');
  ok(rowA.includes('aria-label="Select First thread"'), 'the checkbox names the conversation it selects');
  ok(rowA.includes('1 message<'), 'a single-message row is not pluralised');
  ok(!rowA.includes('matched in'), 'a row with no matchField carries no hint');
  ok(rowA.includes('data-conv-select="a"'), 'the row still opens the conversation');
  ok(rowA.includes('data-conv-delete="a"'), 'the per-row delete survived the refactor');

  const rowB = S.conversationRowHtml(st.conversations[1]);
  ok(rowB.includes('12 messages'), 'a multi-message row is pluralised');
  ok(rowB.includes('matched in a message'),
    'a body-only match SAYS SO — otherwise the row looks unrelated to what was typed');

  st.selectedConvIds.add('a');
  const rowSel = S.conversationRowHtml(st.conversations[0]);
  ok(rowSel.includes(' checked'), 'a selected row renders checked');
  ok(rowSel.includes('chat-conv-row selected') || /class="chat-conv-row[^"]*\sselected/.test(rowSel),
    'a selected row is marked for styling');
  st.selectedConvIds.clear();

  // Escaping, through the REAL escapeHtml.
  const nasty = S.conversationRowHtml({
    id: '"><script>x</script>', title: '<img src=x onerror=alert(1)>', messageCount: 2, matchField: 'message',
  });
  ok(!nasty.includes('<script>'), 'a hostile conversation id cannot break out of an attribute');
  ok(!nasty.includes('<img src=x'), 'a hostile title cannot inject an element');
  ok(nasty.includes('&lt;img'), 'the hostile title is rendered as escaped text');

  // matchHint compares with === against the single value the server sends.
  eq(S.matchHint({ matchField: 'message' }), ' · matched in a message', 'matchHint: message');
  eq(S.matchHint({ matchField: 'title' }), '', 'matchHint: a title match needs no hint — the word is visible in the title');
  eq(S.matchHint({}), '', 'matchHint: absent field → no hint');
  eq(S.matchHint({ matchField: '<b>x</b>' }), '', 'matchHint: an unexpected value produces NOTHING, never echoed markup');
  eq(S.matchHint({ matchField: 'constructor' }), '', 'matchHint: a prototype key is not a hint');
}

{
  // THE DECISIVE SEARCH PROPERTY: with a query active, a conversation whose
  // TITLE does not contain it must still render — the server matched it on a
  // message body, and a client-side predicate on top would throw away exactly
  // the rows the whole fix exists to surface.
  const st = freshState({
    searchQuery: 'graphql',
    conversations: [{ id: 'b', title: 'Ingest pipeline for large PDFs', createdAt: '2020-01-01T00:00:00.000Z', messageCount: 3, matchField: 'message' }],
  });
  const S = makeSidebar(st);
  const html = S.conversationListHtml();
  ok(html.includes('Ingest pipeline'),
    'a server-matched row whose TITLE lacks the query is still rendered (no client-side re-filtering)');
  ok(!html.includes('No conversations match'), 'and it is not reported as no match');

  st.conversations = [];
  ok(S.conversationListHtml().includes('No conversations match'), 'an empty filtered list says the query matched nothing');
  ok(S.conversationListHtml().includes('graphql'), 'and quotes the query back');
  st.searchQuery = '';
  ok(S.conversationListHtml().includes('No conversations yet'), 'an empty unfiltered list says the domain is empty instead');
  ok(S.conversationListHtml().includes('<') , 'the empty state is markup, not a bare string');

  st.searchQuery = '<img src=x>';
  st.conversations = [];
  ok(!S.conversationListHtml().includes('<img src=x>'), 'the echoed query is escaped');

  st.searchQuery = '';
  st.loadError = 'boom <b>';
  ok(S.conversationListHtml().includes('chat-sidebar-error'), 'a load error renders the error state');
  ok(!S.conversationListHtml().includes('<b>'), 'and escapes it');
  st.loadError = null;
  st.domains = [];
  eq(S.conversationListHtml(), '', 'with no domains the list is empty rather than claiming anything');
}

{
  const st = freshState({ conversations: [{ id: 'a', title: 'A', createdAt: '2020-01-01T00:00:00.000Z', messageCount: 1 }, { id: 'b', title: 'B', createdAt: '2020-01-01T00:00:00.000Z', messageCount: 1 }] });
  const S = makeSidebar(st);

  let bar = S.bulkBarHtml();
  ok(bar.includes('Select all'), 'select-all is offered before anything is ticked (discoverable without guessing)');
  ok(bar.includes('id="chat-bulk-all"'), 'select-all is a real checkbox');
  ok(!bar.includes('chat-bulk-delete'), 'the destructive control is ABSENT while nothing is selected');
  ok(!bar.includes('chat-bulk-clear'), 'so is clear-selection');

  st.selectedConvIds.add('a');
  bar = S.bulkBarHtml();
  ok(bar.includes('1 selected'), 'the bar states the count');
  ok(bar.includes('chat-bulk-delete'), 'delete appears once something is selected');
  ok(bar.includes('chat-bulk-clear'), 'so does clear');
  ok(bar.includes('Delete 1 selected conversation"'), 'the delete control names the count for assistive tech, singular');
  ok(!/id="chat-bulk-all"[^>]*checked/.test(bar), 'select-all is not checked on a partial selection');

  st.selectedConvIds.add('b');
  bar = S.bulkBarHtml();
  ok(bar.includes('2 selected'), 'the count follows the selection');
  ok(bar.includes('Delete 2 selected conversations"'), 'plural in the assistive label');
  ok(/id="chat-bulk-all"[^>]*checked/.test(bar), 'select-all is checked when everything is selected');

  st.conversations = [];
  st.selectedConvIds.clear();
  eq(S.bulkBarHtml(), '', 'no conversations → no bulk strip at all');
  st.conversations = [{ id: 'a' }];
  st.loadError = 'x';
  eq(S.bulkBarHtml(), '', 'a load error → no bulk strip (nothing trustworthy to act on)');
  st.loadError = null;
  st.domains = [];
  eq(S.bulkBarHtml(), '', 'no domains → no bulk strip');
}

{
  const st = freshState();
  const S = makeSidebar(st);
  eq(S.bulkNoticeHtml(), '', 'no notice → nothing rendered');
  st.bulkNotice = { text: 'Deleted 3 conversations.', tone: 'ok' };
  ok(S.bulkNoticeHtml().includes('Deleted 3 conversations.'), 'a success notice reports the real number');
  ok(!S.bulkNoticeHtml().includes('error'), 'a success notice is not styled as an error');
  st.bulkNotice = { text: 'Deleted 1 of 3. 2 could not be deleted', tone: 'error' };
  ok(S.bulkNoticeHtml().includes('chat-bulk-notice error'), 'a partial failure IS styled as an error');
  st.bulkNotice = { text: '<b>x</b>', tone: 'ok' };
  ok(!S.bulkNoticeHtml().includes('<b>'), 'the notice text is escaped');
  st.bulkNotice = { tone: 'ok' };
  eq(S.bulkNoticeHtml(), '', 'a notice with no text renders nothing rather than an empty box');
}

{
  const st = freshState({ conversations: [{ id: 'a', title: 'A', createdAt: '2020-01-01T00:00:00.000Z', messageCount: 1 }] });
  const S = makeSidebar(st);
  const pane = S.conversationPaneHtml();
  ok(pane.includes('chat-bulk-bar'), 'the pane contains the bulk strip');
  ok(pane.includes('chat-conv-list'), 'and the list');
  ok(pane.indexOf('chat-bulk-bar') < pane.indexOf('chat-conv-list'), 'the strip renders above the list');
}

// ═════════════════════════════════════════════════════════════════════════
section('§6 — SOURCE GUARD: the row markup and list grouping exist exactly ONCE');

{
  // These were two hand-maintained copies (renderSidebar and
  // renderSidebarConversationsOnly), which is how a change lands in one
  // render path and silently not the other. Counted over comment-stripped
  // code so the prose describing the old duplication cannot satisfy it.
  const rowMarkers = (chatViewCode.match(/data-conv-select="/g) || []).length;
  eq(rowMarkers, 1, 'the conversation-row markup is built in exactly one place');
  const deleteMarkers = (chatViewCode.match(/data-conv-delete="/g) || []).length;
  eq(deleteMarkers, 1, 'the per-row delete button is built in exactly one place');
  const groupMarkers = (chatViewCode.match(/'TODAY'/g) || []).length;
  eq(groupMarkers, 1, 'the TODAY/EARLIER grouping is built in exactly one place');
  const emptyMarkers = (chatViewCode.match(/No conversations match/g) || []).length;
  eq(emptyMarkers, 1, 'the empty-search state is worded in exactly one place');

  // The client-side title-only predicate is GONE, not merely unused. This is
  // the assertion that fails if someone "restores" filtering on top of the
  // server's answer and silently re-hides every body match.
  ok(!/state\.conversations\.filter\(\s*c\s*=>\s*\(c\.title/.test(chatViewCode),
    'the client-side title-only search predicate no longer exists');
  ok(!chatViewCode.includes('.title || \'\').toLowerCase().includes(query)'),
    'no title-lowercase-includes filter survives anywhere in the view');

  ok(/renderSidebarConversationsOnly\([^)]*\)\s*\{[\s\S]{0,400}?conversationPaneHtml\(\)/.test(chatViewCode),
    'the light re-render uses the SAME pane builder as the full render');
  ok(/wireConversationPane/.test(chatViewCode), 'one shared wiring function exists');
  eq((chatViewCode.match(/function wireConversationPane\(/g) || []).length, 1,
    'and it is defined once');
}

// ═════════════════════════════════════════════════════════════════════════
section('§7 — SOURCE GUARD: a domain switch lands on an empty new chat');

{
  const switchSrc = extractFunction(chatViewCode, 'switchDomain');
  ok(/autoSelectMostRecent:\s*false/.test(switchSrc),
    'switchDomain does NOT auto-select the most recent conversation');
  ok(!/autoSelectMostRecent:\s*true/.test(switchSrc),
    'and nothing in it re-enables auto-select');
  ok(/state\.activeConversationId = null/.test(switchSrc), 'it clears the active conversation');
  ok(/selectedConvIds\.clear\(\)/.test(switchSrc), 'and the selection, which is per-domain');
  ok(/cancelSearchTimer\(\)/.test(switchSrc), 'and cancels a pending search that belongs to the old domain');

  // Cold boot still restores the most recent thread — the user has not asked
  // for anything there, so restoring is a default rather than an override.
  const bootSrc = extractFunction(chatViewCode, 'boot');
  ok(/autoSelectMostRecent:\s*true/.test(bootSrc), 'boot() still auto-selects the most recent conversation');
}

// ═════════════════════════════════════════════════════════════════════════
section('§8 — SOURCE GUARD: MESSAGES_PER_TURN agrees with what the server writes');

{
  // The sidebar count is patched locally, so this constant is the ONLY thing
  // tying it to the file on disk. Count the pushes in the real brain module.
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
  ok(/q:\s*state\.searchQuery/.test(chatViewCode), 'the refetch sends the query to the server');
  const scheduleSrc = extractFunction(chatViewCode, 'scheduleConversationSearch');
  ok(/cancelSearchTimer\(\)/.test(scheduleSrc), 'a new keystroke supersedes the pending timer rather than stacking one');
  ok(/isCurrentMount\(mountToken\)/.test(scheduleSrc), 'and the fired callback refuses to act on a dead mount');

  // Every REFRESH of an existing list carries the active query, or a send or
  // a delete would silently drop the filter while the search box still shows
  // its text. Two call sites are deliberately exempt and are excluded BY
  // NAME rather than by the assertion being loosened: boot() has no query to
  // carry yet, and switchDomain has just RESET searchQuery to '' three lines
  // above its own call, so passing it would be passing a blank.
  const loadCalls = chatViewCode.match(/loadDomainConversations\([^;]*?\);/gs) || [];
  const switchSrcForCalls = extractFunction(chatViewCode, 'switchDomain');
  const bootSrcForCalls = extractFunction(chatViewCode, 'boot');
  const refreshCalls = loadCalls.filter(c => !switchSrcForCalls.includes(c) && !bootSrcForCalls.includes(c));
  ok(refreshCalls.length >= 3, `there are several list REFRESH call sites (found ${refreshCalls.length})`);
  ok(refreshCalls.every(c => /q:\s*state\.searchQuery/.test(c)),
    'every list refresh (send, single delete, bulk delete, search) passes the active search query');
  ok(/state\.searchQuery = '';/.test(switchSrcForCalls),
    'and switchDomain is exempt because it clears the query itself');
}

// ═════════════════════════════════════════════════════════════════════════
section('§10 — SOURCE GUARD: the scope bar\u2019s scrollbar');

{
  const bar = chatCss.slice(chatCss.indexOf('.chat-scopebar {'), chatCss.indexOf('.chat-scope-eyebrow'));
  ok(/overflow-x:\s*auto/.test(bar), 'the scope bar still scrolls horizontally');
  ok(/scrollbar-width:\s*none/.test(bar), 'the scrollbar is hidden for Firefox and modern Chromium');
  ok(/\.chat-scopebar::-webkit-scrollbar\s*\{[^}]*display:\s*none/.test(chatCss),
    'and for Safari / older Chromium');
  // The rejected alternative: a sized webkit scrollbar takes LAYOUT space
  // rather than overlaying, so it would permanently grow this bar and push
  // the thread down on every machine.
  ok(!/\.chat-scopebar::-webkit-scrollbar\s*\{[^}]*height:/.test(chatCss),
    'no sized ::-webkit-scrollbar — that form shifts layout on every machine');
  ok(!/overflow-x:\s*hidden/.test(bar), 'scrolling is preserved, not removed');
}

// ── Cleanup ─────────────────────────────────────────────────────────────
rmSync(TMP, { recursive: true, force: true });

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All chat sidebar assertions green');
