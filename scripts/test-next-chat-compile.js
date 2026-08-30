/**
 * test-next-chat-compile.js — OFFLINE suite for two /next gaps closed in
 * this release:
 *
 *   (1) The Domains -> Chat scope-handoff API (src/public/next/app.js):
 *       requestChatScope(slug) / consumeChatScopeRequest(). Domains' "Ask
 *       this domain" affordance needs to tell the NEXT Chat mount which
 *       domain to scope to, across a navigate() call — module state,
 *       deliberately not localStorage (a stale key would silently hijack a
 *       LATER, unrelated Chat mount). THE decisive property:
 *       consumeChatScopeRequest() clears what it returns, so a SECOND call
 *       with no new request in between returns nothing pending. A test that
 *       only checked the first call would pass with that invariant fully
 *       broken — see §1's own comment.
 *
 *       consumeChatScopeRequest() also returns `firstRun`, part of the
 *       function's frozen contract — still tested here at the app.js unit
 *       level in §1, since the function genuinely computes it and the
 *       shape must not silently drift. But NOTHING in src/public/next/
 *       produces firstRun:true today (Domains creates domains directly
 *       via openLifecycle('create') now, not by handing off to Chat), and
 *       chat.js has no consumer for it — see resolveBootDomain()'s own
 *       comment in chat.js, and §5/§6 below, which prove the dead
 *       consumer path was actually removed rather than merely stopped
 *       being called.
 *
 *   (2) Compile to Wiki in the /next Chat view (src/public/next/views/
 *       chat.js) — POST /api/compile/conversation had no call site anywhere
 *       in /next; cutover without it loses the ability to save a
 *       conversation to the wiki. Ported from src/public/app.js's Compile
 *       section (v3.0.14/v3.0.1-beta.27), preserving every invariant that
 *       shipped release earned the hard way: `refused` is a normal outcome
 *       (not an error), pre-flight failures are HTTP JSON while a file-lock
 *       conflict is an in-stream SSE `error` frame, `warnings[]` is the
 *       only degraded-compile signal, and the outcome card must never grow
 *       its own max-height/overflow/flex-shrink (the fixed-panel bug that
 *       invariant exists to prevent) while still surviving a mid-compile
 *       conversation/domain switch without misfiling.
 *
 * Rendering itself (DOM writes, scroll, click wiring) is NOT covered here —
 * same boundary every test-next-*.js suite draws (see test-next-mcp-wizard.js's
 * own header comment): it is browser-only and checked by direct in-app
 * verification, not this offline suite. What IS covered, behaviourally, by
 * extracting the real functions from the real source files and running
 * them standalone (no DOM, no server, no network):
 *   - requestChatScope/consumeChatScopeRequest's full state machine,
 *     including the second-call-returns-nothing property, mutation-proven.
 *   - resolveBootDomain() — chat.js's pure scope-handoff decision — across
 *     every combination of {no domains, matching request, stale/unknown
 *     request, no request}, including a two-mount simulation proving a
 *     stale request cannot resurrect itself on a later mount. It does not
 *     read or return `firstRun` at all — see §2's own comment.
 *   - compileStillTargetsActive() — the mid-compile-switch guard —
 *     mutation-proven.
 *   - buildCompileOutcomeHtml()/formatBytesChat() — the change-list HTML,
 *     including that every server/user-derived string in it is escaped.
 *   - updateCompileButtonBusy() (§6b) — driven against a fake `state` and a
 *     fake `document`, proving only the run that HOLDS the compile lock may
 *     publish or release it. This is the durable form of an audit finding:
 *     onEnter used to clear state.compileBusy on every mount, so navigating
 *     away from Chat and back during the 15-45s LLM call re-enabled the
 *     button and a second click fired a SECOND paid, destructive compile —
 *     which the route then answered with "manually delete .write-lock and
 *     retry", i.e. advice to remove the only cross-process guard while the
 *     first compile was still writing.
 *   - scrollCompileCardIntoView() (§6c) — driven against fake rects,
 *     proving the card comes to rest BELOW the opaque sticky `.chat-scopebar`
 *     rather than underneath it (measured live at 1440x892: bar 0->55,
 *     `.chat-compile-note` 8->45, the degradation warning fully hidden), and
 *     that the bar's height is MEASURED, not hardcoded.
 * Everything else (event wiring, SSE framing, CSS structure, the route's
 * own HTTP/SSE split) is checked with source-level guards against the REAL
 * files below — stated as such, not implied as behavioural coverage. §6d
 * (the outcome card is gated on conversation+domain, never on mount
 * identity) and §6e (state.compileLabel is gone) are explicitly in that
 * source-guard category: renderCompileOutcome is a nested arrow closure, not
 * an extractable named function.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const APP_PATH = path.join(ROOT, 'src/public/next/app.js');
const CHAT_PATH = path.join(ROOT, 'src/public/next/views/chat.js');
const CHAT_CSS_PATH = path.join(ROOT, 'src/public/next/views/chat.css');
const COMPILE_ROUTE_PATH = path.join(ROOT, 'src/routes/compile.js');
const NEXT_INDEX_PATH = path.join(ROOT, 'src/public/next/index.html');

const app = readFileSync(APP_PATH, 'utf8');
const chat = readFileSync(CHAT_PATH, 'utf8');
const chatCss = readFileSync(CHAT_CSS_PATH, 'utf8');
const compileRoute = readFileSync(COMPILE_ROUTE_PATH, 'utf8');
const nextIndex = readFileSync(NEXT_INDEX_PATH, 'utf8');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(a, b, label) {
  ok(a === b, `${label} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`);
}
function section(t) { console.log(`\n${t}`); }

// ── Comment stripping for source-level (absence/ordering) guards ─────────
// Same rationale and same conservative shape as test-next-mcp-wizard.js's
// stripComments: this file's own subjects are heavily commented, including
// comments that quote the very strings some guards assert about — running
// an absence/ordering check against raw text would let a comment satisfy
// (or accidentally defeat) it instead of real code. Strips /* */ blocks and
// whole-line // comments only; never trims an end-of-line comment (that
// needs a real lexer, and the safe failure direction for an ABSENCE check
// is to leave too much in, never too little).
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
const appCode = assertStrippedSane(stripComments(app), 'app.js',
  ['export function requestChatScope(slug)', 'export function consumeChatScopeRequest()']);
const chatCode = assertStrippedSane(stripComments(chat), 'chat.js',
  ['function resolveBootDomain(', 'function compileStillTargetsActive(', 'async function runCompile()']);

// ── Extraction: real brace-matching, same as test-next-mcp-wizard.js ─────
// (duplicated here rather than shared — every test-next-*.js file in this
// repo re-implements its own extractor; see that file's own header for why
// a shared "if a name goes missing this THROWS rather than silently testing
// nothing" contract matters more than DRY between test files.)
function extractFunction(src, name) {
  // `(?:export\s+)?` — app.js's chat-scope handoff pair is exported;
  // chat.js's own pure helpers are not. Both shapes must match, and the
  // extraction still starts at "function", not "export", so the sandbox
  // never has to strip a lone `export` keyword (illegal outside a module).
  const marker = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ${name}\\s*\\(`);
  const m = marker.exec(src);
  if (!m) throw new Error(`extractFunction: "${name}" not found`);
  const functionKwIdx = src.indexOf('function', m.index);
  const start = functionKwIdx;
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

// `let _pendingChatScopeRequest = null; // ...` — a single line, extracted
// (not hand-copied) so a future change to the initializer is picked up.
function extractLet(src, name) {
  const re = new RegExp(`(?:^|\\n)let ${name} = [^\\n]*\\n`);
  const m = re.exec(src);
  if (!m) throw new Error(`extractLet: "${name}" not found`);
  return m[0].trim();
}

// ── Sandboxes ──────────────────────────────────────────────────────────

// app.js's chat-scope handoff pair — genuinely stateful (they share
// `_pendingChatScopeRequest`), so both are built into ONE sandbox that
// exposes both functions closing over the same variable, plus a peek/reset
// helper for the mutation-proof section.
function buildScopeHandoffSandbox(appSrc) {
  const src =
    extractLet(appSrc, '_pendingChatScopeRequest') + '\n' +
    extractFunction(appSrc, 'requestChatScope') + '\n\n' +
    extractFunction(appSrc, 'consumeChatScopeRequest') + '\n' +
    'return { requestChatScope, consumeChatScopeRequest, __peek: () => _pendingChatScopeRequest };';
  return new Function(src)();
}

// chat.js's pure helpers. `resolveBootDomain` and `compileStillTargetsActive`
// have no dependencies on anything else in the file (no `state`, no DOM, no
// other chat.js function) — verified by reading them; extracting each alone
// is sufficient and keeps this sandbox minimal.
function buildChatPureSandbox(chatSrc) {
  const src =
    extractFunction(chatSrc, 'resolveBootDomain') + '\n\n' +
    extractFunction(chatSrc, 'compileStillTargetsActive') + '\n' +
    'return { resolveBootDomain, compileStillTargetsActive };';
  return new Function(src)();
}

// buildCompileOutcomeHtml/formatBytesChat call escapeHtml()/icon(), both
// imported from app.js — stubbed here rather than pulled in whole, matching
// test-chat-markdown.js's precedent for this file's sibling renderer.
// escapeHtml's stub is byte-for-byte app.js's real implementation (copied,
// not reinvented) specifically so the XSS-escaping assertions below are
// testing the real escaping rules, not a laxer stand-in.
function buildCompileHtmlSandbox(chatSrc) {
  const escapeHtmlStub = `
    function escapeHtml(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
      ));
    }
    function icon(name) { return '<svg data-icon="' + name + '"></svg>'; }
  `;
  const src =
    escapeHtmlStub + '\n' +
    extractFunction(chatSrc, 'formatBytesChat') + '\n\n' +
    extractFunction(chatSrc, 'buildCompileOutcomeHtml') + '\n' +
    'return { formatBytesChat, buildCompileOutcomeHtml };';
  return new Function(src)();
}

const { requestChatScope, consumeChatScopeRequest, __peek } = buildScopeHandoffSandbox(app);
const { resolveBootDomain, compileStillTargetsActive } = buildChatPureSandbox(chat);
const { formatBytesChat, buildCompileOutcomeHtml } = buildCompileHtmlSandbox(chat);

// ═════════════════════════════════════════════════════════════════════════
section('1. requestChatScope()/consumeChatScopeRequest() — the handoff state machine');
// ═════════════════════════════════════════════════════════════════════════
{
  // Nothing pending yet (module-fresh sandbox for this section).
  eq(JSON.stringify(consumeChatScopeRequest()), JSON.stringify({ slug: null, firstRun: false }),
    'no request pending -> {slug:null, firstRun:false} (the "mount normally" case)');

  requestChatScope('projects');
  const first = consumeChatScopeRequest();
  eq(first.slug, 'projects', 'a real slug is carried through');
  eq(first.firstRun, false, 'and firstRun is false for a real-slug request');

  // ── THE decisive proof ────────────────────────────────────────────────
  // Consuming must CLEAR. A test that only checked the line above (the
  // first call applies the request) would pass even if consume never
  // cleared anything — this second call, with NO new request in between,
  // is what actually exercises the clearing behaviour. If it failed to
  // clear, every LATER, unrelated Chat mount would silently re-scope to
  // "projects" forever.
  const second = consumeChatScopeRequest();
  eq(JSON.stringify(second), JSON.stringify({ slug: null, firstRun: false }),
    'SECOND consume (no new request in between) returns NOTHING pending — the request does not resurrect itself');

  // First-run: no argument, or any falsy/non-string value, all mean the
  // same thing — "the user wants to create a domain from Chat", not scope
  // to an existing one.
  requestChatScope();
  eq(JSON.stringify(consumeChatScopeRequest()), JSON.stringify({ slug: null, firstRun: true }),
    'requestChatScope() with no argument -> firstRun:true, slug:null');

  requestChatScope(null);
  eq(JSON.stringify(consumeChatScopeRequest()), JSON.stringify({ slug: null, firstRun: true }),
    'requestChatScope(null) -> firstRun:true');

  requestChatScope('');
  eq(JSON.stringify(consumeChatScopeRequest()), JSON.stringify({ slug: null, firstRun: true }),
    'requestChatScope(\'\') -> firstRun:true (empty string is falsy)');

  requestChatScope(42);
  eq(JSON.stringify(consumeChatScopeRequest()), JSON.stringify({ slug: null, firstRun: true }),
    'requestChatScope(42) (non-string) -> firstRun:true (defensive — never crashes, never carries a non-string slug forward)');

  // Last-write-wins: two requests before a single consume — only the LATER
  // one survives, matching how a real double-click on "Ask this domain"
  // for two different domains in quick succession should behave.
  requestChatScope('a');
  requestChatScope('b');
  eq(consumeChatScopeRequest().slug, 'b', 'a second request before any consume replaces the first, not accumulates');

  // ── Mutation proof: consume WITHOUT clearing ──────────────────────────
  // Reproduces the exact bug the "decisive proof" above exists to catch:
  // if the clearing statement were removed, the SECOND call would still
  // return the first request instead of {slug:null, firstRun:false}.
  const goodConsumeSrc = extractFunction(app, 'consumeChatScopeRequest');
  ok(goodConsumeSrc.includes('_pendingChatScopeRequest = null;'),
    'baseline extraction contains the clearing statement (precondition for the mutation below)');
  const brokenConsumeSrc = goodConsumeSrc.replace('_pendingChatScopeRequest = null;\n  ', '');
  ok(brokenConsumeSrc !== goodConsumeSrc, 'the mutation actually changed the source text');

  const brokenSandbox = new Function(
    extractLet(app, '_pendingChatScopeRequest') + '\n' +
    extractFunction(app, 'requestChatScope') + '\n\n' +
    brokenConsumeSrc + '\n' +
    'return { requestChatScope, consumeChatScopeRequest };'
  )();
  brokenSandbox.requestChatScope('stale-domain');
  const brokenFirst = brokenSandbox.consumeChatScopeRequest();
  const brokenSecond = brokenSandbox.consumeChatScopeRequest();
  eq(brokenFirst.slug, 'stale-domain', 'broken sandbox: first consume still applies the request (unaffected by the mutation)');
  eq(brokenSecond.slug, 'stale-domain',
    'CONFIRMED RED: without the clear, the SECOND consume resurrects the same stale request — exactly the hijack this API exists to prevent');

  // Restore: re-extract from the UNMODIFIED source and confirm the real
  // pair still clears correctly.
  requestChatScope('c');
  consumeChatScopeRequest();
  eq(JSON.stringify(consumeChatScopeRequest()), JSON.stringify({ slug: null, firstRun: false }),
    'RESTORED: the real consumeChatScopeRequest still clears on the second call');
  eq(goodConsumeSrc, extractFunction(app, 'consumeChatScopeRequest'),
    'the source on disk was never touched by this mutation test (re-extraction is byte-identical)');
}

// ═════════════════════════════════════════════════════════════════════════
section('2. resolveBootDomain() — the scope-handoff decision inside boot()');
// ═════════════════════════════════════════════════════════════════════════
{
  const domains = [{ slug: 'articles' }, { slug: 'projects' }, { slug: 'health' }];

  // resolveBootDomain() does NOT read or return `firstRun` — Chat no longer
  // has a first-run consumer (see chat.js's own comment on the function,
  // and §5/§6 below, which prove the dead consumer path was removed, not
  // merely stopped being called). Its return shape is exactly
  // {activeDomain, appliedScopeSlug}.
  const noDomains = resolveBootDomain([], { slug: null }, null);
  eq(noDomains.activeDomain, null, 'no domains at all -> activeDomain null');
  ok(!('firstRun' in noDomains), 'the return object does not carry a firstRun key at all');

  const scoped = resolveBootDomain(domains, { slug: 'projects' }, 'articles');
  eq(scoped.activeDomain, 'projects', 'a request naming an EXISTING domain wins over the saved one');
  eq(scoped.appliedScopeSlug, true, 'and is flagged as an applied scope (so boot() knows to persist it)');

  const staleRequest = resolveBootDomain(domains, { slug: 'deleted-domain' }, 'health');
  eq(staleRequest.activeDomain, 'health', 'a request naming a domain that no longer exists falls back to the saved domain, not silently to nothing');
  eq(staleRequest.appliedScopeSlug, false, 'and is NOT flagged as an applied scope — nothing from the request was actually used');

  const noRequestSavedValid = resolveBootDomain(domains, { slug: null }, 'health');
  eq(noRequestSavedValid.activeDomain, 'health', 'no request at all -> falls back to the saved domain');
  eq(noRequestSavedValid.appliedScopeSlug, false, 'not an applied scope');

  const noRequestNoSaved = resolveBootDomain(domains, { slug: null }, null);
  eq(noRequestNoSaved.activeDomain, 'articles', 'no request AND no saved domain -> falls back to the FIRST domain');

  const noRequestArg = resolveBootDomain(domains, null, 'projects');
  eq(noRequestArg.activeDomain, 'projects', 'resolveBootDomain(domains, null, saved) does not throw and behaves as "no request"');

  // A REAL request object from consumeChatScopeRequest() still carries
  // `firstRun` (the contract field — see §1) even though nothing produces
  // it as true today. resolveBootDomain() must tolerate that extra key
  // without acting on it: a firstRun:true request with a real slug behaves
  // IDENTICALLY to the same request with firstRun:false, and a firstRun:true
  // request with NO slug behaves identically to no request at all. This is
  // the assertion that would catch a future edit accidentally reviving a
  // firstRun branch inside this function without a matching consumer.
  const ignoredTrue = resolveBootDomain(domains, { slug: 'health', firstRun: true }, 'articles');
  const ignoredFalse = resolveBootDomain(domains, { slug: 'health', firstRun: false }, 'articles');
  eq(JSON.stringify(ignoredTrue), JSON.stringify(ignoredFalse),
    'a firstRun:true request behaves identically to firstRun:false — the field is present on the contract object but has no effect here');
  const ignoredTrueNoSlug = resolveBootDomain(domains, { slug: null, firstRun: true }, 'health');
  eq(ignoredTrueNoSlug.activeDomain, 'health', 'firstRun:true with no slug still just falls through to the saved domain — no special "create" branch fires');
  eq(ignoredTrueNoSlug.appliedScopeSlug, false, 'and is not treated as an applied scope');

  const nonArrayDomains = resolveBootDomain('not-an-array', { slug: 'x' }, 'y');
  eq(nonArrayDomains.activeDomain, null, 'a non-array domains argument is treated as empty, not a throw');

  // ── THE SECOND-MOUNT integration proof ────────────────────────────────
  // Simulates the full pipeline across two mounts using the REAL
  // consumeChatScopeRequest() from §1's sandbox, not a hand-built stub:
  //   mount 1: Domains called requestChatScope('projects'); boot() consumes
  //            it, scopes to 'projects', and (per chat.js's own boot()) that
  //            becomes the new saved/localStorage domain.
  //   (user manually switches to 'health' via the scope pills — simulated
  //   here by just updating what "saved" is, exactly like switchDomain()
  //   in chat.js does to LS_DOMAIN)
  //   mount 2: NO new request was made. consumeChatScopeRequest() must
  //            return {slug:null, firstRun:false} (proven directly in §1),
  //            and resolveBootDomain() must therefore fall through to the
  //            SAVED domain ('health') — never back to 'projects', the
  //            mount-1 request that has already been consumed.
  requestChatScope('projects');
  const mount1Req = consumeChatScopeRequest();
  const mount1 = resolveBootDomain(domains, mount1Req, null);
  eq(mount1.activeDomain, 'projects', 'mount 1 scopes to the requested domain');
  let saved = mount1.appliedScopeSlug ? mount1.activeDomain : null;

  saved = 'health'; // the user's own subsequent, unrelated domain switch

  const mount2Req = consumeChatScopeRequest(); // no new request was made
  eq(JSON.stringify(mount2Req), JSON.stringify({ slug: null, firstRun: false }),
    'mount 2: nothing pending (confirms §1s property holds across this integration path too)');
  const mount2 = resolveBootDomain(domains, mount2Req, saved);
  eq(mount2.activeDomain, 'health', 'mount 2 uses the SAVED domain (the user\'s real last action) — NOT a resurrection of mount 1\'s "projects" request');
}

// ═════════════════════════════════════════════════════════════════════════
section('3. compileStillTargetsActive() — the mid-compile-switch guard');
// ═════════════════════════════════════════════════════════════════════════
{
  ok(compileStillTargetsActive('conv-1', 'conv-1', 'articles', 'articles') === true,
    'same conversation + same domain -> still relevant');
  ok(compileStillTargetsActive('conv-2', 'conv-1', 'articles', 'articles') === false,
    'user switched to a DIFFERENT conversation mid-compile -> not relevant');
  ok(compileStillTargetsActive('conv-1', 'conv-1', 'projects', 'articles') === false,
    'user switched to a DIFFERENT domain mid-compile -> not relevant');
  ok(compileStillTargetsActive(null, 'conv-1', 'articles', 'articles') === false,
    'user started a New chat mid-compile (activeConversationId -> null) -> not relevant');
  ok(compileStillTargetsActive('conv-1', 'conv-1', null, 'articles') === false,
    'defensive: a null active domain never matches a real compileDomain');

  // ── Mutation proof ─────────────────────────────────────────────────────
  const goodSrc = extractFunction(chat, 'compileStillTargetsActive');
  ok(goodSrc !== null, 'baseline extraction succeeded');
  const brokenSrc = goodSrc.replace(
    /return activeConversationId === compileConvId && activeDomain === compileDomain;/,
    'return true;'
  );
  ok(brokenSrc !== goodSrc, 'the mutation actually changed the source text');
  const brokenFn = new Function(`${brokenSrc}\nreturn compileStillTargetsActive;`)();
  let threw = false;
  let brokenResult;
  try { brokenResult = brokenFn('conv-2', 'conv-1', 'articles', 'articles'); } catch { threw = true; }
  ok(!threw, 'the mutated function runs without throwing (a red here would be a crash, not the intended behavioural failure)');
  eq(brokenResult, true,
    'CONFIRMED RED: the mutated guard would let a compile for conv-1 land its card on conv-2 — exactly the misfiled-card bug this function exists to prevent');

  const restoredFn = new Function(`${goodSrc}\nreturn compileStillTargetsActive;`)();
  eq(restoredFn('conv-2', 'conv-1', 'articles', 'articles'), false, 'RESTORED: the real guard correctly refuses the mismatched case again');
  eq(goodSrc, extractFunction(chat, 'compileStillTargetsActive'),
    'the source on disk was never touched by this mutation test (re-extraction is byte-identical)');
}

// ═════════════════════════════════════════════════════════════════════════
section('4. buildCompileOutcomeHtml()/formatBytesChat() — the change-list card body');
// ═════════════════════════════════════════════════════════════════════════
{
  eq(formatBytesChat(500), '500 B', 'formatBytesChat: sub-1024 renders as bytes');
  eq(formatBytesChat(2048), '2.0 KB', 'formatBytesChat: 1024+ renders as KB');
  eq(formatBytesChat(null), '', 'formatBytesChat: null -> empty string, not "null"');
  eq(formatBytesChat(undefined), '', 'formatBytesChat: undefined -> empty string');

  const created = [{ canonPath: 'entities/foo.md', status: 'created', bytesAfter: 1200 }];
  const updated = [{ canonPath: 'concepts/bar.md', status: 'updated', bytesBefore: 400, bytesAfter: 900, bulletsAdded: 3, sectionsChanged: ['Key Facts', 'Related'] }];
  const unchanged = [{ canonPath: 'summaries/baz.md', status: 'unchanged' }];

  const full = buildCompileOutcomeHtml('My Conversation', [...created, ...updated, ...unchanged], []);
  ok(full.includes('chat-compile-change-created'), 'created pages get the created section class');
  ok(full.includes('chat-compile-change-updated'), 'updated pages get the updated section class');
  ok(full.includes('chat-compile-change-unchanged'), 'unchanged pages get a summary note');
  ok(!full.includes('chat-compile-change-empty'), 'the empty-state message does NOT render when pages were actually written');
  ok(full.includes('entities/foo.md'), 'created page path is present');
  ok(full.includes('concepts/bar.md'), 'updated page path is present');
  ok(full.includes('+<span class="mono">3</span> bullet'), 'bulletsAdded detail renders for an updated page');
  ok(full.includes('Key Facts, Related'), 'sectionsChanged is rendered');
  ok(full.includes('Compiled to wiki: My Conversation'), 'the title is rendered');

  const empty = buildCompileOutcomeHtml('Nothing New', [], []);
  ok(empty.includes('chat-compile-change-empty'), 'no created/updated pages -> the empty-state message renders');
  ok(!empty.includes('chat-compile-change-created') && !empty.includes('chat-compile-change-updated'),
    'and neither section renders when there is nothing in it');

  const withWarnings = buildCompileOutcomeHtml('Big Thread', created, ['Compiled a concise version — the conversation was too large for a full extraction.']);
  ok(withWarnings.includes('chat-compile-note'), 'a non-empty warnings[] renders the degradation note');
  ok(withWarnings.includes('too large for a full extraction'), 'and carries the actual warning text');
  const withoutWarnings = buildCompileOutcomeHtml('Small Thread', created, []);
  ok(!withoutWarnings.includes('chat-compile-note'), 'an empty warnings[] renders NO note — a clean compile must not look degraded');

  // ── XSS / escaping — every server- or user-derived string this function
  //    interpolates must be escaped, since it flows straight into innerHTML
  //    via renderThreadOnly's `role === 'compile'` branch. ──────────────────
  const evilTitle = buildCompileOutcomeHtml('<script>alert(1)</script>', [], []);
  ok(!evilTitle.includes('<script>alert(1)</script>'), 'a malicious conversation title is escaped, not injected raw');
  ok(evilTitle.includes('&lt;script&gt;'), 'and the escaped form is present');

  const evilPath = buildCompileOutcomeHtml('t', [{ canonPath: '"><img src=x onerror=alert(1)>', status: 'created', bytesAfter: 10 }], []);
  ok(!evilPath.includes('<img src=x onerror=alert(1)>'), 'a malicious canonPath is escaped');

  const evilSections = buildCompileOutcomeHtml('t', [{ canonPath: 'a.md', status: 'updated', bulletsAdded: 1, sectionsChanged: ['<b>x</b>'], bytesBefore: 1, bytesAfter: 2 }], []);
  ok(!evilSections.includes('<b>x</b>'), 'sectionsChanged entries are escaped');

  const evilWarning = buildCompileOutcomeHtml('t', [], ['<img src=x onerror=alert(1)>']);
  ok(!evilWarning.includes('<img src=x onerror=alert(1)>'), 'a warning string is escaped');

  // Defensive inputs.
  const defensiveNullChanges = buildCompileOutcomeHtml('t', null, null);
  ok(defensiveNullChanges.includes('chat-compile-change-empty'), 'null changes/warnings do not throw and render the empty state');
  const defensiveNoCanonPath = buildCompileOutcomeHtml('t', [{ status: 'created', bytesAfter: 1 }], []);
  ok(!/undefined/.test(defensiveNoCanonPath), 'a change record missing canonPath never renders the literal string "undefined"');
}

// ═════════════════════════════════════════════════════════════════════════
section('5. Source-level guards — app.js (chat scope handoff)');
// ═════════════════════════════════════════════════════════════════════════
{
  ok(/let _pendingChatScopeRequest = null;/.test(appCode),
    'the pending request is MODULE state, not localStorage (grep confirms no localStorage key exists for it)');
  ok(!/localStorage[\s\S]{0,80}[Cc]hatScope/.test(appCode) && !/[Cc]hatScope[\s\S]{0,80}localStorage/.test(appCode),
    'no localStorage key is used anywhere near the scope-handoff functions — module state only');
  ok(/export function requestChatScope\(slug\)/.test(appCode), 'requestChatScope has the frozen one-argument signature');
  ok(/export function consumeChatScopeRequest\(\)/.test(appCode), 'consumeChatScopeRequest takes no arguments');
}

// ═════════════════════════════════════════════════════════════════════════
section('6. Source-level guards — chat.js wiring (onEnter, renderMain ordering)');
// ═════════════════════════════════════════════════════════════════════════
{
  // onEnter's own body — extracted by brace-matching from its literal start
  // (it's a method shorthand inside registerView('chat', {...}), not a
  // top-level `function` declaration, so extractFunction's regex can't find
  // it by name; a small local brace-matcher does the same job from a
  // known start index).
  function extractFromMarker(src, marker) {
    const idx = src.indexOf(marker);
    if (idx === -1) throw new Error(`extractFromMarker: "${marker}" not found`);
    let i = src.indexOf('{', idx);
    let depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    return src.slice(idx, i);
  }
  const onEnterBody = extractFromMarker(chatCode, 'onEnter(mountToken) {');

  ok(!/async onEnter/.test(chatCode), 'onEnter is not declared async — it is fully synchronous end to end');
  ok(!/onEnter\([^)]*\)\s*\{[\s\S]*?\bawait\b/.test(onEnterBody),
    'onEnter\'s own body contains no `await` — consumeChatScopeRequest() cannot race a faster second navigate() to the same view');

  const consumeIdx = onEnterBody.indexOf('consumeChatScopeRequest()');
  const bootIdx = onEnterBody.indexOf('boot(mountToken');
  ok(consumeIdx > -1 && bootIdx > -1 && consumeIdx < bootIdx,
    'consumeChatScopeRequest() is called BEFORE boot() is invoked, inside onEnter');

  // ── Which flags onEnter may reset, and which it must NOT ───────────────
  //
  // `state.sending` IS reset here, unconditionally: it drives the trailing
  // "thinking…" bubble, and every render the in-flight send would make is
  // isCurrentMount-gated, so nothing else will ever repaint that bubble away
  // on a fresh mount. Clearing it costs nothing (the abandoned send's reply
  // is dropped by its own stillRelevant check).
  //
  // `state.compileBusy` (and compilePct/compileOwner) must NOT be reset here.
  // It is a LOCK on a paid, destructive write whose lifetime is the RUN, not
  // the mount: runCompile's `finally` releases it unconditionally and the
  // fetch is never aborted on teardown, so nothing on-mount needs to clear
  // it — and clearing it re-enabled the button under a live compile
  // (src/brain/compile.js emits progress(20) then nothing until progress(85),
  // so the re-enabled window is essentially the whole 15-45s LLM call). The
  // second click that opened produced a SECOND paid compile, whose route
  // answered "manually delete <domains>/<d>/.write-lock and retry" — advice
  // that removes the only cross-process guard while the first compile is
  // still writing. Reproduced live in the browser before this fix.
  //
  // HOW "ungated" IS MEASURED — and why the previous version of this check
  // could never fail. It used a proxy: "the immediately preceding non-blank
  // line must not end by opening a brace". `if (!state.sending) state.compileBusy
  // = false;` is a one-line gate with no preceding brace at all, so the proxy
  // passed on the exact shape it existed to catch (auditor-reproduced: the
  // suite stayed 126/126 green with the flag fully gated). Replaced with a
  // computed brace depth: onEnter's own body brace puts top-level statements
  // at depth 1, and ANY conditional/block wrapper — one-line or not — puts
  // them at 2 or more. Mutation-proven in both directions below.
  function statementDepth(body, statement) {
    const idx = body.indexOf(statement);
    if (idx === -1) return -1;
    let depth = 0;
    for (let i = 0; i < idx; i++) {
      if (body[i] === '{') depth++;
      else if (body[i] === '}') depth--;
    }
    return depth;
  }

  eq(statementDepth(onEnterBody, 'state.sending = false;'), 1,
    'onEnter resets state.sending at the TOP LEVEL of its body (depth 1) — unconditionally, not inside any if/block');

  for (const forbidden of ['state.compileBusy', 'state.compilePct', 'state.compileOwner']) {
    ok(!onEnterBody.includes(forbidden),
      `onEnter never touches ${forbidden} — the compile lock belongs to the RUN, not the mount`);
  }

  // ── Mutation proofs for both directions, on COPIES of the real body ─────
  // (a) gate the sending reset behind a one-line `if` — the exact shape the
  //     old proxy could not see — and confirm the depth check goes RED.
  const gatedBody = onEnterBody.replace(
    'state.sending = false;',
    'if (!state.compileBusy) { state.sending = false; }'
  );
  ok(gatedBody !== onEnterBody, 'mutation (a) actually changed the body text');
  eq(statementDepth(gatedBody, 'state.sending = false;'), 2,
    'CONFIRMED RED (a): a one-line-gated reset measures at depth 2, so the depth check catches what the old "preceding line" proxy could not');

  // (b) re-introduce the compileBusy reset and confirm the negative
  //     assertions above go RED — a negative regex is trivially easy to
  //     write so it can never match anything, so it is proven here to
  //     actually fire against the removed shape.
  const resetBody = onEnterBody.replace(
    'state.sending = false;',
    'state.sending = false;\n    state.compileBusy = false;\n    state.compilePct = 0;'
  );
  ok(resetBody.includes('state.compileBusy'),
    'CONFIRMED RED (b1): the negative assertion detects a re-introduced state.compileBusy reset');
  ok(resetBody.includes('state.compilePct'),
    'CONFIRMED RED (b2): same for state.compilePct');

  // RESTORED: the real body on disk still passes both, re-extracted rather
  // than trusting the in-memory value the mutations were derived from.
  const reExtracted = extractFromMarker(stripComments(readFileSync(CHAT_PATH, 'utf8')), 'onEnter(mountToken) {');
  eq(statementDepth(reExtracted, 'state.sending = false;'), 1,
    'RESTORED: re-read from disk, the real onEnter still resets state.sending at depth 1');
  ok(!reExtracted.includes('state.compileBusy'),
    'RESTORED: re-read from disk, the real onEnter still never touches state.compileBusy');

  // Chat's zero-domain empty state must route to a genuinely working
  // domain-creation surface. Chat has none of its own (see §5b) — the
  // route is Domains' rail item, whose own empty state now creates
  // domains for real via openLifecycle('create'). This is source-guarded
  // here (renderMain builds the button + wires it to navigate('domains'));
  // §5b below proves there is no leftover dead consumer competing with it,
  // and the live-browser check in this release's own report walks the
  // route end to end (offline text can't click a button in another view's
  // file, which this suite is not allowed to touch anyway).
  const renderMainSrc = extractFunction(chatCode, 'renderMain');
  ok(/state\.domains\.length === 0/.test(renderMainSrc), 'renderMain still has its zero-domains branch');
  ok(/Chat needs at least one domain to talk to\. Create one in Domains/.test(renderMainSrc),
    'and its copy honestly says domain creation happens in Domains (not here)');
  ok(/id="chat-goto-domains"/.test(renderMainSrc) && /navigate\('domains'\)/.test(chatCode),
    'the empty-state button is wired to navigate(\'domains\')');

  // renderThreadOnly must handle the synthetic compile-card role BEFORE the
  // user-message branch (both are just ordering within one `.map()`, but a
  // reviewer reordering branches could otherwise accidentally let a
  // `role: 'compile'` item fall through and render as a user bubble).
  const renderThreadOnlySrc = extractFunction(chatCode, 'renderThreadOnly');
  const compileRoleIdx = renderThreadOnlySrc.indexOf("m.role === 'compile'");
  const userRoleIdx = renderThreadOnlySrc.indexOf("m.role === 'user'");
  ok(compileRoleIdx > -1 && userRoleIdx > -1 && compileRoleIdx < userRoleIdx,
    "renderThreadOnly checks role === 'compile' before role === 'user'");
}

// ═════════════════════════════════════════════════════════════════════════
section('5b. The dead first-run panel is actually GONE, not just unreferenced');
// ═════════════════════════════════════════════════════════════════════════
// A cross-agent collision (Agent A wired Domains' "+ New domain" straight to
// its own openLifecycle('create') modal, a real create-domain UI Domains did
// not have before) made Chat's first-run panel — state.firstRun/
// firstRunBusy/firstRunError, renderFirstRunPanel(), submitFirstRunDomain(),
// its POST /api/domains, and its .chat-firstrun-* CSS — permanently
// unreachable: nothing anywhere calls requestChatScope() with no slug, which
// was the only way state.firstRun could ever become true. Rather than leave
// it "unreferenced but present" (dead code with a comment claiming it is
// reachable is worse than no code — a future reader has no way to tell
// "intentionally dormant" from "someone forgot to wire it up"), it was
// deleted outright. These are NEGATIVE assertions — they exist to catch a
// future re-introduction. A negative regex assertion is easy to write so it
// can never fail (a typo in the pattern passes forever) — the mutation
// check at the end of this section reproduces the removed shape in a COPY
// of the real source and confirms these exact assertions go RED against
// it, so this section is proven to detect the thing it exists to catch,
// not just to always say yes.
{
  ok(!/state\.firstRun/.test(chatCode), 'chat.js never assigns/reads state.firstRun anywhere');
  ok(!/renderFirstRunPanel/.test(chatCode), 'renderFirstRunPanel no longer exists');
  ok(!/submitFirstRunDomain/.test(chatCode), 'submitFirstRunDomain no longer exists');
  ok(!/chat-firstrun/.test(chatCode), 'no chat-firstrun-* class is referenced in chat.js');
  ok(!/chat-firstrun/.test(chatCss), 'no .chat-firstrun-* rule remains in chat.css');

  // ── RETIRED: the `emptyCard` ban. Recorded, not quietly deleted. ─────────
  //
  // This line used to read `ok(!/emptyCard/.test(chatCode), …)` — a permanent
  // ban on chat.js importing the SHARED empty state, used as a PROXY for "the
  // deleted first-run panel has not come back", on the grounds that the panel
  // was emptyCard's only caller here.
  //
  // The proxy outlived the thing it proxied for. `emptyCard` is app.js's one
  // empty state; Ingest, Domains, Shared Brain and the memory view all render
  // it, and chat.js now renders it too — for its zero-domain branch, as part of
  // moving that branch's sentence out of a `<div class="view-body">` floating
  // under the <h1>. A blanket ban on a general-purpose shared component, on one
  // file, forever, because a since-deleted feature once used it, would force
  // the next author to hand-roll a second empty state instead. That is the
  // duplication this repo keeps paying for, bought with a guard.
  //
  // NOTHING IS LOST, and that is checked rather than claimed. Every real
  // invariant the ban stood in for is pinned INDEPENDENTLY in this same block:
  // `state.firstRun`, `renderFirstRunPanel`, `submitFirstRunDomain` and
  // `.chat-firstrun-*` are each named above, and the load-bearing one — exactly
  // one POST /api/domains call site in /next, and NOT in chat.js — is
  // mechanical and enumerates the tree from disk. What replaces the ban is its
  // POSITIVE form, which the ban could never state: the zero-domain state must
  // go through the shared component, so a chat-local copy of an empty state is
  // a regression this section still sees.
  // Scoped to renderMain's ZERO-DOMAIN branch rather than to the file, and
  // that scoping is a correction the guard made to itself on its first run. A
  // file-wide ban on `chat-empty-*` classes went RED against `.chat-empty` /
  // `.chat-empty-title` / `.chat-empty-body`, which already exist and are a
  // DIFFERENT surface: the empty THREAD ("Ask <domain> anything", rendered
  // inside #chat-thread for a conversation with no messages yet). "This
  // conversation is new" and "this install has no domains at all" are not the
  // same empty state and must not be collapsed into one assertion.
  const renderMainForEmpty = extractFunction(chatCode, 'renderMain');
  ok(/state\.domains\.length === 0[\s\S]{0,400}?emptyCard\(\{/.test(renderMainForEmpty),
    "renderMain's zero-domain branch renders the SHARED empty state (app.js emptyCard), not a chat-local copy");

  // Exactly one POST /api/domains call site in the whole /next tree, and it
  // is NOT in chat.js — Domains' openLifecycle('create') is the only
  // domain-creation surface. This is the mechanical form of the exact grep
  // the orchestrator used to find this collision; pinned here so a second
  // create-domain path anywhere in /next fails this suite immediately
  // rather than needing a human to notice it again.
  const NEXT_DIR = path.join(ROOT, 'src/public/next');
  function listJsFiles(dir) {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...listJsFiles(p));
      else if (entry.name.endsWith('.js')) out.push(p);
    }
    return out;
  }
  let postDomainsSites = 0;
  const postDomainsFiles = [];
  for (const f of listJsFiles(NEXT_DIR)) {
    const s = readFileSync(f, 'utf8');
    // A POST create call site: fetch/fetchJSON('/api/domains' with a
    // trailing quote/backtick (not '/api/domains/...') AND method: 'POST'
    // within a short window after it.
    const re = /fetch(?:JSON)?\(\s*['"`]\/api\/domains['"`][\s\S]{0,200}?method:\s*['"`]POST['"`]/g;
    const matches = s.match(re) || [];
    if (matches.length) { postDomainsSites += matches.length; postDomainsFiles.push(path.relative(ROOT, f) + ` (${matches.length})`); }
  }
  eq(postDomainsSites, 1, `exactly one POST /api/domains call site in src/public/next/ — found: ${JSON.stringify(postDomainsFiles)}`);
  ok(!postDomainsFiles.some((f) => f.startsWith('src/public/next/views/chat.js')),
    'and it is NOT in chat.js — Domains (openLifecycle(\'create\')) is the only domain-creation surface');

  // ── Mutation proof: re-introduce the removed shape in a COPY, confirm RED ──
  // Reproduces the minimal signature of the dead code this section's
  // negative assertions exist to catch — not a byte-for-byte restore of the
  // deleted panel (this suite never writes to disk and holds no such copy),
  // but the exact tokens each assertion above greps for, so each one is
  // proven to actually fire rather than being a pattern that happens to
  // never match anything.
  const mutatedChatCode = chatCode +
    '\nstate.firstRun = true;\nfunction renderFirstRunPanel(token) { return token; }\n' +
    'function submitFirstRunDomain() { return emptyCard({}); }\n' +
    "document.getElementById('x').className = 'chat-firstrun-form';\n";
  ok(/state\.firstRun/.test(mutatedChatCode), 'CONFIRMED RED (state.firstRun): the mutated copy trips the assertion the real source passes');
  ok(/renderFirstRunPanel/.test(mutatedChatCode), 'CONFIRMED RED (renderFirstRunPanel): same');
  ok(/submitFirstRunDomain/.test(mutatedChatCode), 'CONFIRMED RED (submitFirstRunDomain): same');
  ok(/chat-firstrun/.test(mutatedChatCode), 'CONFIRMED RED (chat-firstrun class): same');
  // The two assertions that REPLACED the retired emptyCard ban get controls of
  // their own, in both directions — a positive assertion is just as capable of
  // never being able to fail as a negative one.
  ok(!/state\.domains\.length === 0[\s\S]{0,400}?emptyCard\(\{/
    .test(renderMainForEmpty.replace(/emptyCard\(\{/g, "'<div class=\"chat-zero-domain\">' + ({")),
    'CONFIRMED RED (shared empty state): a copy whose zero-domain branch hand-rolls its own card trips the positive assertion');

  const mutatedChatCss = chatCss + '\n.chat-firstrun-form { color: red; }\n';
  ok(/chat-firstrun/.test(mutatedChatCss), 'CONFIRMED RED (chat.css): the mutated copy trips the CSS assertion the real stylesheet passes');

  const mutatedNextTree = { 'views/chat.js': readFileSync(CHAT_PATH, 'utf8') + "\nfetch('/api/domains', { method: 'POST' });\n" };
  const mutatedMatches = (mutatedNextTree['views/chat.js'].match(/fetch(?:JSON)?\(\s*['"`]\/api\/domains['"`][\s\S]{0,200}?method:\s*['"`]POST['"`]/g) || []).length;
  ok(mutatedMatches >= 1, 'CONFIRMED RED (second POST /api/domains site): a synthetic second create call site in a copy of chat.js is detected by the same regex used above');

  // The real files, unmutated, still pass every one of the same checks —
  // restated here explicitly rather than just trusting the assertions
  // earlier in this section, since a copy-paste error in the mutation
  // block above could otherwise silently validate nothing.
  ok(!/state\.firstRun/.test(chatCode) && !/renderFirstRunPanel/.test(chatCode) &&
     !/submitFirstRunDomain/.test(chatCode) && !/chat-firstrun/.test(chatCode) &&
     /emptyCard\(\{/.test(chatCode),
    'RESTORED (conceptually — the real source was never touched by the mutations above): the real chat.js still passes every one of these checks');
  ok(!/chat-firstrun/.test(chatCss), 'and the real chat.css still passes its check');
}

// ═════════════════════════════════════════════════════════════════════════
section('6b. updateCompileButtonBusy() — the compile lock is owned by the RUN');
// ═════════════════════════════════════════════════════════════════════════
// BEHAVIOURAL, not a source guard: the real function is extracted and driven
// against a fake `state` and a fake `document`, both of which it is the only
// consumer of. The property under test is "only the run that currently holds
// the lock may publish lock state" — which is what makes onEnter's removed
// reset structurally impossible to re-create in a different disguise.
{
  function buildCompileLockSandbox(chatSrc) {
    const src = `
      const state = { compileBusy: false, compilePct: 0, compileOwner: null };
      const els = {
        'chat-compile-btn': { disabled: false },
        'chat-compile-btn-label': { textContent: 'Compile to Wiki' },
      };
      const document = { getElementById: (id) => els[id] || null };
    ` +
      extractFunction(chatSrc, 'updateCompileButtonBusy') + '\n' +
      'return { state, els, updateCompileButtonBusy };';
    return new Function(src)();
  }

  const lock = buildCompileLockSandbox(chat);
  const btn = lock.els['chat-compile-btn'];
  const lbl = lock.els['chat-compile-btn-label'];

  // Run 1 claims the lock the way runCompile does (a plain assignment,
  // synchronous with its own guard) and then publishes.
  lock.state.compileOwner = 1;
  lock.updateCompileButtonBusy(1, true, 0);
  eq(lock.state.compileBusy, true, 'the owner may publish busy=true');
  eq(btn.disabled, true, 'and the live button is disabled');
  eq(lbl.textContent, 'Compiling… 0%', 'and the label shows the compiling state');

  lock.updateCompileButtonBusy(1, true, 42);
  eq(lock.state.compilePct, 42, 'the owner may publish progress');
  eq(lbl.textContent, 'Compiling… 42%', 'and the label tracks it');

  // A NON-owner publishes nothing at all — neither progress nor a release.
  lock.updateCompileButtonBusy(99, true, 90);
  eq(lock.state.compilePct, 42, 'a foreign token cannot publish progress');
  lock.updateCompileButtonBusy(99, false, 0);
  eq(lock.state.compileBusy, true, 'a foreign token cannot RELEASE the lock');
  eq(btn.disabled, true, 'and the button stays disabled');

  // ── THE scenario the token exists for ──────────────────────────────────
  // Reproduce the class of failure that produced this finding: something
  // clears the lock out from under a live run (that was onEnter, but the
  // shape is "any external clear"), a SECOND run claims it, and then the
  // FIRST run's `finally` fires. Without an owner check, run 1's release
  // re-enables the button while run 2 is still mid-flight — a second
  // re-enabled window, in the same place, with the same harm. With it, run
  // 1's release is refused and only run 2 can end run 2.
  lock.state.compileBusy = false;      // the external clear
  lock.state.compileOwner = 2;         // run 2 claims
  lock.updateCompileButtonBusy(2, true, 5);
  eq(lock.state.compileBusy, true, 'run 2 holds the lock');
  lock.updateCompileButtonBusy(1, false, 0); // run 1's stale finally
  eq(lock.state.compileBusy, true, "run 1's stale release does NOT unlock run 2's compile");
  eq(lock.state.compileOwner, 2, 'and does not clear the owner either');
  eq(btn.disabled, true, 'the button stays disabled through run 1\'s stale release');

  // Run 2 ends its own run: lock released, owner cleared so the NEXT run can
  // claim (a token that stayed set would deadlock every future compile).
  lock.updateCompileButtonBusy(2, false, 0);
  eq(lock.state.compileBusy, false, 'the owner CAN release its own lock');
  eq(lock.state.compileOwner, null, 'and the owner slot is cleared for the next run');
  eq(lock.state.compilePct, 0, 'and pct resets on release');
  eq(btn.disabled, false, 're-enabling the button');
  eq(lbl.textContent, 'Compile to Wiki', 'and restoring the idle label');

  // Absent DOM (user is on another view mid-compile): state still publishes,
  // nothing throws.
  const headless = new Function(`
    const state = { compileBusy: false, compilePct: 0, compileOwner: 7 };
    const document = { getElementById: () => null };
    ${extractFunction(chat, 'updateCompileButtonBusy')}
    return { state, updateCompileButtonBusy };
  `)();
  let threwHeadless = false;
  try { headless.updateCompileButtonBusy(7, true, 20); } catch { threwHeadless = true; }
  ok(!threwHeadless, 'with no button in the DOM at all (another view is mounted) it is a no-op, not a throw');
  eq(headless.state.compileBusy, true, 'and state is still published so a later full render reflects it');

  // ── Mutation proof: remove the ownership guard ─────────────────────────
  const goodBusySrc = extractFunction(chat, 'updateCompileButtonBusy');
  ok(goodBusySrc.includes('if (owner !== state.compileOwner) return;'),
    'baseline extraction contains the ownership guard (precondition for the mutation)');
  const brokenBusySrc = goodBusySrc.replace('if (owner !== state.compileOwner) return;\n', '');
  ok(brokenBusySrc !== goodBusySrc, 'the mutation actually changed the source text');
  const brokenLock = new Function(`
    const state = { compileBusy: false, compilePct: 0, compileOwner: 2 };
    const els = { 'chat-compile-btn': { disabled: true }, 'chat-compile-btn-label': { textContent: 'Compiling… 5%' } };
    const document = { getElementById: (id) => els[id] || null };
    ${brokenBusySrc}
    return { state, els, updateCompileButtonBusy };
  `)();
  brokenLock.state.compileBusy = true;
  let brokenThrew = false;
  try { brokenLock.updateCompileButtonBusy(1, false, 0); } catch { brokenThrew = true; }
  ok(!brokenThrew, 'the mutated function runs without throwing (a red here would be a crash, not the intended behavioural failure)');
  eq(brokenLock.state.compileBusy, false,
    "CONFIRMED RED: without the guard, run 1's stale release unlocks run 2's live compile");
  eq(brokenLock.els['chat-compile-btn'].disabled, false,
    'CONFIRMED RED: and re-enables the button mid-flight — the second-paid-compile window, reopened');

  eq(goodBusySrc, extractFunction(chat, 'updateCompileButtonBusy'),
    'the source on disk was never touched by this mutation test (re-extraction is byte-identical)');
}

// ═════════════════════════════════════════════════════════════════════════
section('6c. scrollCompileCardIntoView() — the card lands BELOW the sticky bar');
// ═════════════════════════════════════════════════════════════════════════
// BEHAVIOURAL. `.chat-scopebar` is `position: sticky; top: 0` with an OPAQUE
// background (asserted in §8 below), so it covers the top of #main's
// scrollport. Landing the card at that scrollport's own top hid its first
// rows — measured live at 1440x892 on a 30-change card: bar 0->55,
// `.chat-compile-note` (the ONLY degraded-compile signal) 8->45, entirely
// underneath. The bar's height is measured at call time, never hardcoded:
// it wraps and grows with the number of scope pills.
{
  function buildScrollSandbox(fnSrc) {
    return new Function(`
      let host = null;
      function setup(cfg) {
        const bar = cfg.barHeight == null ? null
          : { getBoundingClientRect: () => ({ height: cfg.barHeight }) };
        host = {
          scrollTop: cfg.scrollTop || 0,
          getBoundingClientRect: () => ({ top: cfg.hostTop }),
          querySelector: (sel) => (sel === '.chat-scopebar' ? bar : null),
        };
        return { host, card: { getBoundingClientRect: () => ({ top: cfg.cardTop }) } };
      }
      const document = { getElementById: (id) => (id === 'main' ? host : null) };
      ${fnSrc}
      return { setup, scrollCompileCardIntoView };
    `)();
  }

  const GOOD = extractFunction(chat, 'scrollCompileCardIntoView');
  const sb = buildScrollSandbox(GOOD);

  // The live-measured geometry: #main's rect top 92, the bar 55 tall, a card
  // starting 500px down the viewport.
  const { host, card } = sb.setup({ hostTop: 92, cardTop: 500, barHeight: 55, scrollTop: 0 });
  sb.scrollCompileCardIntoView(card);
  // After scrolling by `host.scrollTop`, the card's top relative to the
  // scrollport is its old offset minus the scroll delta.
  const restingTop = (500 - 92) - host.scrollTop;
  eq(restingTop, 63, 'the card comes to rest 63px into the scrollport (55px bar + the 8px gap)');
  ok(restingTop > 55, 'which is BELOW the bar\'s bottom edge — the card\'s first row is visible, not covered');

  // A taller bar (scope pills wrapped onto a second line) must push the card
  // further, which a hardcoded constant could not do.
  const tall = sb.setup({ hostTop: 92, cardTop: 500, barHeight: 96, scrollTop: 0 });
  sb.scrollCompileCardIntoView(tall.card);
  eq((500 - 92) - tall.host.scrollTop, 104, 'a 96px-tall bar pushes the resting position to 104 — the height is measured, not assumed');

  ok(!/\b55\b/.test(GOOD), 'the function contains no hardcoded bar height');
  ok(/getBoundingClientRect\(\)\.height/.test(GOOD), 'it measures the bar with getBoundingClientRect().height');

  // Defensive: no bar in the DOM at all -> 0, same arithmetic as before, no
  // throw. (Reachable in principle if the scopebar is ever restructured.)
  const noBar = sb.setup({ hostTop: 92, cardTop: 500, barHeight: null, scrollTop: 0 });
  let threwNoBar = false;
  try { sb.scrollCompileCardIntoView(noBar.card); } catch { threwNoBar = true; }
  ok(!threwNoBar, 'a missing .chat-scopebar does not throw');
  eq((500 - 92) - noBar.host.scrollTop, 8, 'it degrades to the plain 8px inset rather than refusing to scroll');

  // ── Mutation proof: drop the bar subtraction (the pre-fix arithmetic) ───
  const brokenScrollSrc = GOOD.replace(' - barHeight - 8;', ' - 8;');
  ok(brokenScrollSrc !== GOOD, 'the mutation actually changed the source text');
  const brokenSb = buildScrollSandbox(brokenScrollSrc);
  const broken = brokenSb.setup({ hostTop: 92, cardTop: 500, barHeight: 55, scrollTop: 0 });
  let brokenScrollThrew = false;
  try { brokenSb.scrollCompileCardIntoView(broken.card); } catch { brokenScrollThrew = true; }
  ok(!brokenScrollThrew, 'the mutated function runs without throwing (a red here would be a crash, not the intended behavioural failure)');
  const brokenRestingTop = (500 - 92) - broken.host.scrollTop;
  eq(brokenRestingTop, 8, 'CONFIRMED RED: without the subtraction the card rests 8px into the scrollport');
  ok(brokenRestingTop < 55,
    'CONFIRMED RED: which is UNDER the 55px opaque sticky bar — reproducing the hidden degradation warning exactly');

  eq(GOOD, extractFunction(chat, 'scrollCompileCardIntoView'),
    'the source on disk was never touched by this mutation test (re-extraction is byte-identical)');
}

// ═════════════════════════════════════════════════════════════════════════
section('6d. The outcome card is gated on CONTEXT, not on mount identity');
// ═════════════════════════════════════════════════════════════════════════
// A successful, paid compile must still show its card when the user merely
// glanced at another view and came back to the SAME domain and SAME
// conversation. compileStillTargetsActive already covers both documented
// harms (§3); an isCurrentMount check in front of it additionally suppressed
// the card on any remount, leaving a console.warn as the only trace. Source-
// level: the closure is a nested arrow function, not a named function, so it
// cannot be extracted and driven the way §6b/§6c drive theirs — stated as a
// source guard, not implied as behavioural coverage. The live-browser proof
// is in this release's own report.
{
  const runCompileSrc = extractFunction(chatCode, 'runCompile');
  const gateStart = runCompileSrc.indexOf('const renderCompileOutcome = (html) => {');
  ok(gateStart > -1, 'renderCompileOutcome is present as a closure inside runCompile');
  const gateEnd = runCompileSrc.indexOf('state.thread.push(', gateStart);
  ok(gateEnd > gateStart, 'and pushes the card into state.thread');
  const gateBody = runCompileSrc.slice(gateStart, gateEnd);

  ok(!/isCurrentMount/.test(gateBody),
    'the outcome gate contains NO isCurrentMount check — a remount to the same conversation must not swallow a successful compile\'s card');
  ok(/compileStillTargetsActive\(state\.activeConversationId, compileConvId, state\.activeDomain, compileDomain\)/.test(gateBody),
    'compileStillTargetsActive IS the gate — conversation + domain identity, the two documented harms');

  // The render must target the mount that is on screen NOW, not the token
  // captured at click time — otherwise renderThreadOnly's own isCurrentMount
  // check drops the paint and the card sits in state.thread unpainted.
  ok(/renderThreadOnly\(liveToken\)/.test(runCompileSrc) && /const liveToken = myMountToken;/.test(runCompileSrc),
    'the card is painted with the LIVE mount token, so it appears on the mount the user is actually looking at');

  // ...while the state.domains refresh KEEPS its click-time isCurrentMount
  // check: that one writes module state, which a dead mount must not do.
  const refreshIdx = runCompileSrc.indexOf("fetch('/api/domains/stats')");
  ok(refreshIdx > -1, 'the best-effort domains refresh is still present');
  const refreshBlock = runCompileSrc.slice(refreshIdx, refreshIdx + 260);
  ok(/isCurrentMount\(mountToken\)/.test(refreshBlock),
    'and it still guards its state.domains write with the click-time isCurrentMount(mountToken)');
  ok(/const mountToken = myMountToken;/.test(runCompileSrc),
    'mountToken is captured before any await (this file\'s H1 rule), for that one use');

  // ── Mutation proof: both negative assertions above are proven to fire ───
  const gateWithMount = gateBody.replace(
    'if (!compileStillTargetsActive',
    'if (!isCurrentMount(mountToken)) return false;\n    if (!compileStillTargetsActive'
  );
  ok(gateWithMount !== gateBody, 'the mutation actually changed the gate text');
  ok(/isCurrentMount/.test(gateWithMount),
    'CONFIRMED RED: a re-introduced isCurrentMount check in the gate is detected by the assertion above');
  const refreshWithoutMount = refreshBlock.replace(/isCurrentMount\(mountToken\)/, 'true');
  ok(!/isCurrentMount\(mountToken\)/.test(refreshWithoutMount),
    'CONFIRMED RED: dropping the check from the domains refresh is detected too');
}

// ═════════════════════════════════════════════════════════════════════════
section('6e. state.compileLabel is gone — no field written by two places and read by none');
// ═════════════════════════════════════════════════════════════════════════
// Every SSE `progress`/`wait` frame's `message` used to be threaded through
// updateCompileButtonBusy into state.compileLabel and read by NOTHING — two
// docblocks claimed renderMain read it; renderMain never did. Both the live
// fast path and renderCompileButtonHtml render the identical "Compiling… NN%"
// string. Deleted rather than rendered: surfacing the message honestly means
// the shipping app's shape (a real progress ROW with its own label element),
// not a state field kept on the chance someone renders it. These are NEGATIVE
// assertions, so the mutation below proves they can fire.
{
  ok(!/compileLabel/.test(chatCode), 'no compileLabel identifier survives anywhere in chat.js code');

  const busySrc = extractFunction(chatCode, 'updateCompileButtonBusy');
  ok(/function updateCompileButtonBusy\(owner, busy, pct\)/.test(busySrc),
    'updateCompileButtonBusy takes (owner, busy, pct) — no label parameter left to drop on the floor');

  // Every call site passes exactly three arguments, the first being `owner`.
  // Lookbehind excludes the declaration itself, whose parameter list also
  // begins `(owner, ` — without it this counted 4 and the assertion was
  // measuring the wrong thing.
  const callSites = (chatCode.match(/(?<!function )updateCompileButtonBusy\(owner, [^)]*\)/g) || []);
  eq(callSites.length, 3, `all three updateCompileButtonBusy call sites pass owner first — found: ${JSON.stringify(callSites)}`);

  // renderCompileButtonHtml and the live fast path must produce the SAME
  // label text, which is why there was nothing for a label field to add.
  const renderBtnSrc = extractFunction(chatCode, 'renderCompileButtonHtml');
  ok(/'Compiling… ' \+ Math\.round\(state\.compilePct \|\| 0\) \+ '%'/.test(renderBtnSrc),
    'renderCompileButtonHtml builds "Compiling… NN%" from state.compilePct');
  ok(/'Compiling… ' \+ Math\.round\(pct \|\| 0\) \+ '%'/.test(busySrc),
    'and the live fast path builds the identical string from its pct argument');

  const mutatedLabel = chatCode + "\nstate.compileLabel = 'x';\n";
  ok(/compileLabel/.test(mutatedLabel),
    'CONFIRMED RED: a re-introduced compileLabel is detected by the assertion above');
}

// ═════════════════════════════════════════════════════════════════════════
section('7. Source-level guards — runCompile() event handling (refused vs error vs done)');
// ═════════════════════════════════════════════════════════════════════════
{
  const runCompileSrc = extractFunction(chatCode, 'runCompile');

  // `refused` renders via the neutral/attention class, NEVER the danger
  // one — it is a normal outcome (conversation too short), not an error.
  ok(/refused[\s\S]{0,120}chat-compile-refused/.test(runCompileSrc),
    'a `refused` SSE event renders via .chat-compile-refused');
  ok(!/refused[\s\S]{0,120}chat-compile-error/.test(runCompileSrc),
    'and NEVER via .chat-compile-error — refused is not an error');

  // Pre-flight (HTTP) vs in-stream (SSE) error handling — checked BEFORE
  // reading the stream, and never `(await r.json())` inside a `throw`
  // (the class of bug fixed at four sites in v3.6.0: a non-JSON body makes
  // that pattern throw "Unexpected token '<'" instead of the real message).
  ok(/if \(!res\.ok && res\.status !== 200\)/.test(runCompileSrc),
    'pre-flight HTTP failures are checked before the stream is ever read');
  ok(!/throw new Error\(\s*\(?\s*await/.test(runCompileSrc),
    'no `(await ...)` sits directly inside a `throw new Error(...)` call');
  ok(/try \{ const j = await res\.json\(\); errMsg = j\.error \|\| errMsg; \} catch/.test(runCompileSrc),
    'the pre-flight JSON parse is wrapped in its own try/catch, with a safe fallback message');

  // `errored` (the in-stream `error` event) is checked and thrown BEFORE
  // `refused`/`final` are inspected — an error must win over a stale
  // leftover refusal/done from the same stream.
  const erroredIdx = runCompileSrc.indexOf('if (errored) throw');
  const refusedIdx = runCompileSrc.indexOf('if (refused)');
  ok(erroredIdx > -1 && refusedIdx > -1 && erroredIdx < refusedIdx, '`errored` is checked before `refused`');

  ok(/warnings/.test(runCompileSrc), 'the done handler reads warnings[] from the result');
  ok(/buildCompileOutcomeHtml\(final\.title, changes, warnings\)/.test(runCompileSrc),
    'warnings are threaded into the outcome card, not silently dropped');
}

// ═════════════════════════════════════════════════════════════════════════
section('8. Source-level guards — the CSS card invariant (v3.0.14 port)');
// ═════════════════════════════════════════════════════════════════════════
{
  // Extract the .chat-compile-card { ... } rule block itself (the FIRST
  // such block — this is the only place that selector is defined).
  function extractCssBlock(css, selector) {
    const idx = css.indexOf(selector);
    if (idx === -1) throw new Error(`extractCssBlock: "${selector}" not found in chat.css`);
    const open = css.indexOf('{', idx);
    const close = css.indexOf('}', open);
    if (open === -1 || close === -1) throw new Error(`extractCssBlock: "${selector}" has no body`);
    return css.slice(open, close + 1);
  }

  const cardBlock = extractCssBlock(chatCss, '.chat-compile-card {');
  ok(!/max-height/.test(cardBlock), '.chat-compile-card carries NO max-height');
  ok(!/overflow/.test(cardBlock), '.chat-compile-card carries NO overflow of any kind');
  ok(!/flex-shrink/.test(cardBlock), '.chat-compile-card carries NO flex-shrink');

  const summaryBlock = extractCssBlock(chatCss, '.chat-compile-change-summary {');
  ok(/overflow-x:\s*auto/.test(summaryBlock),
    'horizontal containment instead lives on the INNER .chat-compile-change-summary block');

  // The --scrim trap (test-css-tokens.js baselines it at exactly one
  // reference, in shell.css) — chat.css must not add a second one.
  ok(!/var\(--scrim/.test(chatCss), 'chat.css does not reference var(--scrim) (would break the single-baselined-reference invariant)');

  // Tone check: refused is attention-colored, error is danger-colored —
  // never swapped, never the same.
  const refusedBlock = extractCssBlock(chatCss, '.chat-compile-refused {');
  const errorBlock = extractCssBlock(chatCss, '.chat-compile-error {');
  ok(/--attention/.test(refusedBlock) && !/--danger/.test(refusedBlock),
    '.chat-compile-refused uses the attention/neutral palette, not danger');
  ok(/--danger/.test(errorBlock) && !/--attention/.test(errorBlock),
    '.chat-compile-error uses the danger palette');

  // chat.css is already <link>ed by next/index.html — a NEW stylesheet
  // would be invisible to the browser and to test-css-tokens.js §5 (house
  // rule C4). Confirm this suite did not have to add one.
  ok(/<link rel="stylesheet" href="\/next\/views\/chat\.css">/.test(nextIndex),
    'chat.css is linked from next/index.html (no new stylesheet was needed for this work)');
}

// ═════════════════════════════════════════════════════════════════════════
section('9. Source-level guards — src/routes/compile.js contract (unchanged, verified live)');
// ═════════════════════════════════════════════════════════════════════════
{
  // Pins the exact contract this suite's chat.js integration assumes, so a
  // future edit to the route that silently changes it fails HERE rather
  // than only showing up as a confusing frontend bug.
  ok(/if \(!domain\) return res\.status\(400\)/.test(compileRoute), '400 for a missing domain');
  ok(/if \(!conversationId\) return res\.status\(400\)/.test(compileRoute), '400 for a missing conversationId');
  ok(/CONVERSATION_ID_RE\.test\(conversationId\)/.test(compileRoute), '400 for a non-UUID conversationId');
  ok(/if \(!domains\.includes\(domain\)\)/.test(compileRoute), '400 for an unknown domain');
  ok(/isDomainReadonly\(domain\)/.test(compileRoute), '400 for a read-only Shared Brain mirror');
  ok(/isUpdateInProgress\(\)/.test(compileRoute), '409 while an app update is in progress');

  // The file-lock failure happens AFTER the SSE headers are already sent
  // (res.flushHeaders() has run), so it can ONLY be an in-stream `error`
  // event, never an HTTP status — confirmed by checking flushHeaders()
  // occurs textually before the lock-failure emit.
  const flushIdx = compileRoute.indexOf('res.flushHeaders()');
  const lockFailIdx = compileRoute.indexOf("emit({\n      type: 'error'");
  ok(flushIdx > -1 && lockFailIdx > -1 && flushIdx < lockFailIdx,
    'the file-lock failure is emitted AFTER flushHeaders() — it is an SSE frame, not an HTTP status');
  ok(!/releaseFileLock[\s\S]{0,40}res\.status\(/.test(compileRoute),
    'no res.status(...) call sits near the file-lock failure path');
}

// ═════════════════════════════════════════════════════════════════════════
section('10. Behavioural mutation proof — runCompile()\'s guard+claim (the untested half of the owner-token fix)');
// ═════════════════════════════════════════════════════════════════════════
// §6b proves the RELEASE half of the owner-token invariant: a token that
// does not match the current holder cannot publish or release
// (updateCompileButtonBusy's own `if (owner !== state.compileOwner) return;`
// guard, driven directly). Nothing anywhere in this suite drove the CLAIM
// half — that runCompile() actually mints a fresh, monotonic token per run
// with no gap between the guard and the claim for a second click to sneak
// through. A re-audit found two mutations that reopen the original bug
// (HIGH-1: a stale run's finally could release a LIVE run's lock,
// re-enabling the button under a still-running paid, destructive compile)
// while every one of the 184 assertions above stayed green.
//
// Both are proven here BEHAVIOURALLY, by extracting and actually RUNNING
// the real runCompile() — not a hand-rolled stand-in of its guard logic —
// against a controllable fake `fetch` whose resolve/reject the test drives
// directly, and a synchronous two-call harness that reproduces a real
// double-click (no `await` inserted by the TEST between the two calls;
// only the mutation under test may insert one inside the source).
{
  // `compileStillTargetsActive` and `updateCompileButtonBusy` are pulled in
  // for real (both independently proven correct in §3/§6b) because
  // runCompile calls them for real; everything else runCompile touches but
  // this test does not care about (DOM, rendering) is a no-op stand-in.
  function buildRunCompileSandbox(chatSrc, runCompileSrc) {
    const src = `
      let compileRunSeq = 0;
      const state = {
        compileBusy: false, compilePct: 0, compileOwner: null,
        activeConversationId: 'conv-1', activeDomain: 'articles',
        thread: [], domains: [],
      };
      let myMountToken = 1;
      function isCurrentMount(t) { return t === myMountToken; }
      const document = { getElementById: () => null };
      function renderThreadOnly() {}
      function scrollCompileCardIntoView() {}
      function icon() { return ''; }
      function escapeHtml(s) { return String(s == null ? '' : s); }
      function buildCompileOutcomeHtml() { return '<ok>'; }
      ${extractFunction(chatSrc, 'compileStillTargetsActive')}
      ${extractFunction(chatSrc, 'updateCompileButtonBusy')}

      // A controllable network stand-in: every call is recorded with its
      // own resolve/reject, so the test decides exactly when (and whether)
      // each in-flight compile's request settles — never a real fetch.
      const fetchCalls = [];
      function fetch() {
        let resolveFn, rejectFn;
        const p = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });
        fetchCalls.push({ resolve: resolveFn, reject: rejectFn });
        return p;
      }

      // extractFunction's marker regex allows an optional \`async\` prefix
      // to LOCATE the function, but its extraction always starts at the
      // literal string "function" — so the returned text is missing the
      // \`async\` keyword runCompile actually has (harmless for every
      // OTHER section here, which only pattern-match the extracted text;
      // fatal here, since this sandbox actually evaluates and runs it).
      ${runCompileSrc.startsWith('async ') ? runCompileSrc : 'async ' + runCompileSrc}

      return { state, runCompile, fetchCalls, getRunSeq: () => compileRunSeq };
    `;
    return new Function(src)();
  }

  const goodRunCompileSrc = extractFunction(chat, 'runCompile');

  // ── Mutation A: the owner token is hardcoded ───────────────────────────
  // Reopens the exact scenario §6b's own fixture stages (a stale run's
  // finally releasing a live run's lock) — but driven here through the
  // REAL minting line, not a token the test sets by hand.
  ok(goodRunCompileSrc.includes('const owner = ++compileRunSeq;'),
    'baseline extraction mints the owner from the monotonic sequence (precondition for the mutation)');
  const constantOwnerSrc = goodRunCompileSrc.replace('const owner = ++compileRunSeq;', 'const owner = 1;');
  ok(constantOwnerSrc !== goodRunCompileSrc, 'mutation A actually changed the source text');

  async function proveStaleFinallyCannotReleaseALiveRun(runCompileSrc) {
    const sb = buildRunCompileSandbox(chat, runCompileSrc);

    // Run 1: claims the lock for real, then suspends on its own network call.
    const p1 = sb.runCompile();
    eq(sb.fetchCalls.length, 1, 'run 1 reaches its network call synchronously (setup precondition)');
    // Guard, not an assumption: if this precondition is ever false (e.g. an
    // unrelated source change adds a real await before the network call),
    // report it as the failed assertion above and stop — never let a broken
    // setup fall through into `fetchCalls[0].reject()` on `undefined` and
    // crash the whole run. A crash proves nothing; a failed assertion does.
    if (sb.fetchCalls.length !== 1) {
      return { run1Owner: 'setup-failed', run2Owner: 'setup-failed', run2SurvivedRun1sRelease: false };
    }
    const run1Owner = sb.state.compileOwner;

    // The external clear this scenario stages — see §6b's own fixture and
    // comment for the precedent: something resets the lock while run 1 is
    // still genuinely in flight, and a second, real compile starts.
    sb.state.compileBusy = false;
    sb.state.compileOwner = null;
    const p2 = sb.runCompile();
    eq(sb.fetchCalls.length, 2, 'run 2 also reaches its network call synchronously (setup precondition)');
    if (sb.fetchCalls.length !== 2) {
      sb.fetchCalls[0].reject(new Error('cleanup'));
      await p1.catch(() => {});
      return { run1Owner, run2Owner: 'setup-failed', run2SurvivedRun1sRelease: false };
    }
    const run2Owner = sb.state.compileOwner;

    // Run 1 now fails — its `finally` fires while run 2 is still genuinely
    // busy (run 2's own fetch has not settled).
    sb.fetchCalls[0].reject(new Error('network down'));
    await p1;

    const run2SurvivedRun1sRelease = sb.state.compileBusy === true && sb.state.compileOwner === run2Owner;

    // Let run 2 finish too so nothing is left pending.
    sb.fetchCalls[1].reject(new Error('cleanup'));
    await p2.catch(() => {});

    return { run1Owner, run2Owner, run2SurvivedRun1sRelease };
  }

  const goodResult = await proveStaleFinallyCannotReleaseALiveRun(goodRunCompileSrc);
  ok(goodResult.run1Owner !== goodResult.run2Owner,
    'with the real sequence, run 1 and run 2 mint DIFFERENT owner tokens');
  ok(goodResult.run2SurvivedRun1sRelease,
    "and run 1's stale finally cannot release run 2's still-live lock — the button stays correctly disabled");

  const mutatedResult = await proveStaleFinallyCannotReleaseALiveRun(constantOwnerSrc);
  eq(mutatedResult.run1Owner, mutatedResult.run2Owner,
    'CONFIRMED RED precondition: the hardcoded token makes run 1 and run 2 indistinguishable');
  ok(!mutatedResult.run2SurvivedRun1sRelease,
    "CONFIRMED RED: run 1's stale finally releases run 2's still-live lock — the button re-enables mid-compile, HIGH-1 reopened");

  eq(goodRunCompileSrc, extractFunction(chat, 'runCompile'),
    'mutation A never touched the source on disk (re-extraction is byte-identical)');

  // ── Mutation B: an await inserted between the guard and the claim ──────
  // Reproduces v3.3.0's own recorded CRITICAL shape verbatim: "the claim
  // was read, then awaits ran, then it was set."
  ok(goodRunCompileSrc.includes('state.compileOwner = owner;'),
    'baseline extraction claims the lock via a plain, synchronous assignment (precondition for the mutation)');
  const racyClaimSrc = goodRunCompileSrc.replace(
    'state.compileOwner = owner;',
    'await Promise.resolve();\n    state.compileOwner = owner;'
  );
  ok(racyClaimSrc !== goodRunCompileSrc, 'mutation B actually changed the source text');

  function fireTwoSynchronousClicks(runCompileSrc) {
    const sb = buildRunCompileSandbox(chat, runCompileSrc);
    // Fired back-to-back with no `await` in between anywhere in THIS test
    // — a real double-click on the button, and exactly what the guard
    // exists to refuse without relying on the DOM element being disabled.
    const p1 = sb.runCompile();
    const p2 = sb.runCompile();
    return { sb, p1, p2 };
  }

  const good = fireTwoSynchronousClicks(goodRunCompileSrc);
  eq(good.sb.getRunSeq(), 1,
    'with no await between the guard and the claim, a second synchronous click never mints a second token');
  eq(good.sb.fetchCalls.length, 1, 'and never issues a second, paid network call');
  // Defensive, not an assumption (see proveStaleFinallyCannotReleaseALiveRun's
  // own comment): only settle/await what actually exists, so a failed
  // precondition above reports as the failed assertion, never a crash.
  if (good.sb.fetchCalls[0]) {
    good.sb.fetchCalls[0].reject(new Error('cleanup'));
    await good.p1;
  }
  await good.p2; // refused synchronously by the guard; already settled

  const racy = fireTwoSynchronousClicks(racyClaimSrc);
  eq(racy.sb.getRunSeq(), 2,
    'CONFIRMED RED: with an await inserted before the claim, BOTH synchronous clicks pass the guard and mint a token');
  // Flush one microtask tick so both suspended calls resume past the
  // injected await and reach their own (now real) network call.
  await Promise.resolve();
  eq(racy.sb.fetchCalls.length, 2,
    'CONFIRMED RED: and both go on to issue a real, paid network call — the v3.3.0 double-ingest shape, reproduced');
  if (racy.sb.fetchCalls[0]) racy.sb.fetchCalls[0].reject(new Error('cleanup'));
  if (racy.sb.fetchCalls[1]) racy.sb.fetchCalls[1].reject(new Error('cleanup'));
  await Promise.allSettled([racy.p1, racy.p2]);

  eq(goodRunCompileSrc, extractFunction(chat, 'runCompile'),
    'mutation B never touched the source on disk (re-extraction is byte-identical)');
}

// ─────────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All next-chat-compile (scope handoff + Compile to Wiki) offline assertions green');
