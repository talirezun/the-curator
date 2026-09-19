#!/usr/bin/env node
/**
 * test-next-domain-request.js — OFFLINE. The CONSUMING half of the shell's
 * domain handoff (v3.62.0, P1-9), and the lifted chat-scope wrapper (P1-10).
 *
 * ── WHY A SUITE, AND WHY THESE TWO TOGETHER ───────────────────────────────
 *
 * `app.js` records a one-shot request that says "open Domains on THIS domain",
 * and `scripts/test-next-shell-rail.js` §9 executes the recording half. This
 * file executes the other end — the two lines in `views/domains.js`'s
 * `onEnter` and the verification inside `loadDomainsList`'s commit — because
 * the failure mode is invisible from either side alone:
 *
 *   `state` in views/domains.js is MODULE-SCOPED and deliberately survives
 *   leaving the view. `loadDomainsList` resolves the active domain with
 *
 *       if (!state.activeSlug || !state.domains.some(d => d.slug === ...))
 *         state.activeSlug = state.domains.length ? state.domains[0].slug : null;
 *
 *   so a request applied AFTER that line loses to the previous visit's domain,
 *   and on a first visit to `state.domains[0]` — which is alphabetical and has
 *   no relationship to what the user pressed. The button still navigates, the
 *   screen still paints, and it is simply about the wrong domain. Nothing
 *   throws, nothing logs, and a source scan proving the call site EXISTS
 *   proves nothing at all about whether it runs early enough (v3.0.17's rule).
 *
 * So both functions are EXECUTED, out of the real file, with a real
 * `consumeDomainRequest` from the real `app.js` wired between them.
 *
 * P1-10 rides along because it is the same handoff pattern one module over:
 * `goToChatScoped` moved out of this view into `shared/chat-scope.js` so the
 * Context view could press the same door, and the three rules it encodes
 * (record, then navigate; exactly one navigate; a real slug) are the whole
 * reason it is a module rather than four lines typed twice.
 *
 * ── NOT ENFORCED, stated rather than implied ──────────────────────────────
 *   • No DOM and no rendering. `render` is a counter; what the screen looks
 *     like afterwards is other suites' subject.
 *   • The request's PRODUCERS are not here — views/memory.js's doors are
 *     package A's, and `requestDomain`'s own semantics are shell-rail §9.
 *   • `navigate()` is not executed; the ARGUMENT it is handed is asserted.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'src/public/next/app.js');
const DOMAINS = path.join(ROOT, 'src/public/next/views/domains.js');
const CHAT_SCOPE = path.join(ROOT, 'src/public/next/shared/chat-scope.js');

let passed = 0; let failed = 0;
function ok(cond, label, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail === undefined ? '' : ` — ${detail}`}`); }
}
function eq(actual, expected, label) {
  ok(actual === expected, `${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}
function section(t) { console.log(`\n${t}`); }

const appJs = readFileSync(APP, 'utf8');
const domainsJs = readFileSync(DOMAINS, 'utf8');
const chatScopeJs = readFileSync(CHAT_SCOPE, 'utf8');

// ── Extraction, brace-matched, throwing on a desync ───────────────────────
// Copied in shape from test-next-shell-rail.js, which states the rule: a
// missing name must THROW rather than silently test nothing.
function extractFunction(src, name, label) {
  const marker = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ${name}\\s*\\(`);
  const m = marker.exec(src);
  if (!m) throw new Error(`extractFunction: "${name}" not found in ${label}`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  let i = src.indexOf('{', src.indexOf(')', src.indexOf('(', start)));
  // Re-find the body brace properly: walk the parameter list first.
  let p = src.indexOf('(', start); let parens = 0;
  for (; p < src.length; p++) {
    if (src[p] === '(') parens++;
    else if (src[p] === ')') { parens--; if (parens === 0) { p++; break; } }
  }
  i = src.indexOf('{', p);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const out = src.slice(start, i);
  if (!/\n?\}$/.test(out)) throw new Error(`extractFunction: "${name}" desynced in ${label}`);
  return out.replace(/^export\s+/, '');
}

/**
 * `onEnter` is a METHOD on the object literal `registerView('domains', {…})`
 * takes, so the function extractor above cannot see it. Lifted by the same
 * brace-matching rule and re-wrapped as a declaration — the BODY is what is
 * under test, and the body is byte-for-byte what ships.
 */
function extractOnEnter(src) {
  const m = /\n\s{2}onEnter\(mountToken\) \{/.exec(src);
  if (!m) throw new Error('extractOnEnter: the registerView("domains") onEnter shape moved');
  let i = src.indexOf('{', m.index + m[0].length - 1);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const body = src.slice(src.indexOf('{', m.index) + 1, i - 1);
  if (!/consumeDomainRequest\(\)/.test(body)) {
    throw new Error('extractOnEnter: the extracted body does not contain the consume — desynced');
  }
  return `function onEnter(mountToken) {${body}}`;
}

// The REAL recorder, executed rather than stubbed: what this suite proves is
// that the two halves fit, and a stub in the middle would prove they fit a
// stub. No DOM is touched by either function.
const shellBox = new Function(`
  ${extractFunction(appJs, 'requestDomain', 'app.js')}
  ${extractFunction(appJs, 'consumeDomainRequest', 'app.js')}
  let _pendingDomainRequest = null;
  const NEW_PROJECT_REASON = ${JSON.stringify(
    (/export const NEW_PROJECT_REASON = '([^']+)';/.exec(appJs) || [])[1] || null,
  )};
  return { requestDomain, consumeDomainRequest, NEW_PROJECT_REASON };
`)();

// ── The collaborators. Everything injected and RECORDED. ──────────────────
const PREAMBLE = `
let state = {};
let myMountToken = 1;
let loadGate = null;
let arrivalRequest = null;
const calls = { render: 0, fetched: [], loadedHealth: [], loadedBrowse: [],
                loadedProjects: [], warned: [] };
let mounted = true;
let fetchResponder = () => ({ domains: [], readonlyDomains: [] });
const console = { warn: (...a) => calls.warned.push(a.join(' ')),
                  error: (...a) => calls.warned.push(a.join(' ')),
                  log: () => {} };
function render() { calls.render++; }
function isCurrentMount() { return mounted; }
function reportAsyncMountFailure() {}
function reportAsyncActionFailure() {}
function createLoadingGate(o) {
  return { begin() {}, cancel() {}, __onChange: o && o.onChange, cancelled: false };
}
function settleGate(gate, fn) { fn(); }
function gatedLoader() { return ''; }
function loadUiState() { return Promise.resolve({}); }
function disarmSemanticScan() {}
function shouldKeepSemanticScanOnReload() { return false; }
function shouldKeepHealthOnReload() { return false; }
async function fetchJSON(url) { calls.fetched.push(url); return fetchResponder(url); }
async function loadHealth(slug) { calls.loadedHealth.push(slug); }
async function loadBrowse(slug) { calls.loadedBrowse.push(slug); }
async function loadProjects(slug) { calls.loadedProjects.push(slug); }
async function loadKnowledgeBase() {}
const PROJECT_BRIEF_TEMPLATE = 'TEMPLATE';
function freshChooser() { return { ownership: null }; }
`;

let box;
try {
  box = new Function('consumeDomainRequest', 'NEW_PROJECT_REASON', `
    ${PREAMBLE}
    ${extractFunction(domainsJs, 'loadDomainsList', 'views/domains.js')}
    ${extractFunction(domainsJs, 'freshProjectLifecycle', 'views/domains.js')}
    ${extractOnEnter(domainsJs)}
    return { loadDomainsList, onEnter,
             __state: () => state, __setState: (s) => { state = s; },
             __calls: () => calls,
             __reset: () => { calls.render = 0; calls.fetched.length = 0;
               calls.loadedHealth.length = 0; calls.loadedBrowse.length = 0;
               calls.loadedProjects.length = 0; calls.warned.length = 0; },
             __setFetch: (fn) => { fetchResponder = fn; } };
  `)(shellBox.consumeDomainRequest, shellBox.NEW_PROJECT_REASON);
} catch (err) {
  console.log(`  ✗ FATAL: could not build the sandbox from views/domains.js — ${err.message}`);
  process.exit(1);
}

const { loadDomainsList, onEnter, __state, __setState, __calls, __reset, __setFetch } = box;

/** The shape `loadDomainsList` expects on `state`, minus whatever a case sets. */
function freshState(over) {
  return {
    domains: [], readonlySet: new Set(), activeSlug: null, loaded: false,
    loadError: null, healthLoading: false, aiAvailable: false, aiProvider: null,
    aiModel: null, semanticScan: null, health: null, healthSlug: null,
    projectLc: null, cache: null, ...(over || {}),
  };
}

/** Three domains, alphabetical — so `domains[0]` is a DIFFERENT answer. */
const THREE = [{ slug: 'alpha' }, { slug: 'beta' }, { slug: 'gamma' }];
function serveThree(url) {
  if (url === '/api/domains/stats') return { domains: THREE, readonlyDomains: [] };
  return { available: false };
}

/**
 * Let `onEnter`'s own unawaited `loadDomainsList` run to completion.
 *
 * It is deliberately NOT awaited by the view (a mount must not block on a
 * fetch), and every collaborator in this sandbox settles synchronously, so a
 * couple of macrotask turns drains it. Awaiting a SECOND call instead would
 * run the shipped function twice per mount and make every count assertion
 * below off by one — which is how the first draft of this file read.
 */
async function drain() {
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
}

/** One full mount, exactly as the shell performs it: onEnter, then settle. */
async function mount(over) {
  __reset();
  __setState(freshState(over));
  __setFetch(serveThree);
  onEnter(7);
  await drain();
  return __state();
}

console.log('test-next-domain-request.js — the domain handoff, both ends\n');

// ═════════════════════════════════════════════════════════════════════════
section('§1  Extraction sanity — everything below is vacuous without this');
// ═════════════════════════════════════════════════════════════════════════
ok(typeof loadDomainsList === 'function' && typeof onEnter === 'function',
  'both halves extracted from the real views/domains.js');
ok(typeof shellBox.consumeDomainRequest === 'function' && shellBox.NEW_PROJECT_REASON === 'new-project',
  `the REAL recorder is wired in (NEW_PROJECT_REASON = ${JSON.stringify(shellBox.NEW_PROJECT_REASON)})`);
{
  // CONTROL: with no request pending, the ordinary arrival must still work —
  // otherwise every assertion below could be passing because the sandbox is
  // broken in a way that happens to look like the feature.
  const st = await mount();
  eq(st.activeSlug, 'alpha', 'CONTROL: no request pending → the ordinary first-row fallback still runs');
  eq(st.loaded, true, 'CONTROL: …and the load actually completed');
  eq(__calls().loadedHealth.length, 1, 'CONTROL: …and the downstream loads were reached');
}

// ═════════════════════════════════════════════════════════════════════════
section('§2  A request is HONOURED, and it beats every fallback it has to beat');
// ═════════════════════════════════════════════════════════════════════════
{
  shellBox.requestDomain('gamma');
  const st = await mount();
  eq(st.activeSlug, 'gamma', 'a request opens the domain it names, not domains[0]');
  eq(__calls().loadedHealth[0], 'gamma', '…and the downstream loads are asked about THAT domain');
  eq(__calls().loadedBrowse[0], 'gamma', '…the page list too');
  eq(__calls().loadedProjects[0], 'gamma', '…and the project list too');
}
{
  // THE STALE-LIST CASE, which is the common one: `state` is module-scoped
  // and survives leaving the view, so a returning visitor arrives with last
  // visit's `activeSlug` AND last visit's `domains` already populated. The
  // guard in the commit is `!state.domains.some(...)`, so a stale-but-VALID
  // slug passes it — the request has to have been applied before that point
  // or it loses silently.
  shellBox.requestDomain('gamma');
  __reset();
  __setState(freshState({ activeSlug: 'beta', domains: THREE, loaded: true }));
  __setFetch(serveThree);
  onEnter(7);
  eq(__state().activeSlug, 'gamma',
    'the slug is applied SYNCHRONOUSLY in onEnter — before any await, so a cached list cannot win');
  await drain();
  eq(__state().activeSlug, 'gamma', '…and it survives the commit that would otherwise have kept `beta`');
}
{
  // THE OTHER HALF OF THE SAME PROPERTY: without a request, a stale valid
  // slug is KEPT. If this went to domains[0] the assertion above would be
  // passing for the wrong reason.
  __reset();
  __setState(freshState({ activeSlug: 'beta', domains: THREE, loaded: true }));
  __setFetch(serveThree);
  onEnter(7);
  await drain();
  eq(__state().activeSlug, 'beta',
    'CONTROL: with no request, a stale VALID slug is kept — so §2 is about the request, not about clearing');
}

// ═════════════════════════════════════════════════════════════════════════
section('§3  SPENT ONCE — a second mount is an ordinary arrival');
// ═════════════════════════════════════════════════════════════════════════
{
  shellBox.requestDomain('gamma');
  await mount();
  const second = await mount({ activeSlug: null, domains: [] });
  eq(second.activeSlug, 'alpha',
    'the SECOND mount falls back normally — a request cannot re-apply itself an hour later');
}
{
  // AND THE CARRIER ACROSS THE await IS CLEARED TOO, not merely the shell's
  // copy. `onEnter` consumes once and hands the request to a module variable;
  // `loadDomainsList` runs again on this view for a Reload and for the
  // knowledge-folder undo, so a carrier that is never spent would re-apply the
  // request's SIDE EFFECTS on every later load of the same mount.
  //
  // The slug alone cannot show this — it is re-derived from the list every
  // time and lands on the same answer either way. The two things that CAN are
  // the create form and the warning, so both are asked.
  shellBox.requestDomain('gamma', { reason: shellBox.NEW_PROJECT_REASON });
  __reset();
  __setState(freshState());
  __setFetch(serveThree);
  onEnter(7);
  await drain();
  ok(__state().projectLc && __state().projectLc.mode === 'create',
    'PRECONDITION: the first load opened the form');
  __state().projectLc = null;
  await loadDomainsList(7);
  eq(__state().projectLc, null,
    'a second loadDomainsList within one mount does NOT re-open the form — the carrier is spent');

  shellBox.requestDomain('does-not-exist');
  __reset();
  __setState(freshState());
  __setFetch(serveThree);
  onEnter(7);
  await drain();
  const warnsAfterOne = __calls().warned.length;
  eq(warnsAfterOne, 1, 'PRECONDITION: the first load warned exactly once');
  await loadDomainsList(7);
  eq(__calls().warned.length, 1,
    '…and a second load warns no further, because there is no request left to miss');
}

// ═════════════════════════════════════════════════════════════════════════
section('§4  AN UNKNOWN SLUG falls back to today’s behaviour, and SAYS SO');
// ═════════════════════════════════════════════════════════════════════════
{
  shellBox.requestDomain('does-not-exist');
  const st = await mount();
  eq(st.activeSlug, 'alpha', 'a slug this install does not have falls back to the first row — never a throw');
  eq(st.loaded, true, '…and the view still finishes loading');
  const warned = __calls().warned.join('\n');
  ok(/does-not-exist/.test(warned), 'the miss is DISCLOSED on the console, naming the slug that was asked for', warned);
  ok(/alpha/.test(warned), '…and naming where it landed instead', warned);
}
{
  // A HIT MUST NOT WARN, or the warning means nothing.
  shellBox.requestDomain('beta');
  await mount();
  eq(__calls().warned.length, 0, 'CONTROL: an honoured request warns about nothing');
}
{
  // The no-domains install: nothing to fall back TO, and still no throw.
  shellBox.requestDomain('anything');
  __reset();
  __setState(freshState());
  __setFetch(() => ({ domains: [], readonlyDomains: [] }));
  onEnter(7);
  await drain();
  eq(__state().activeSlug, null, 'an install with no domains resolves to null rather than throwing');
  ok(/nothing/.test(__calls().warned.join('\n')),
    '…and the warning says so rather than naming an undefined slug', __calls().warned.join('\n'));
}

// ═════════════════════════════════════════════════════════════════════════
section('§5  `reason` — the pointer opens the form, and only on the one word');
// ═════════════════════════════════════════════════════════════════════════
{
  shellBox.requestDomain('gamma', { reason: shellBox.NEW_PROJECT_REASON });
  const st = await mount();
  eq(st.activeSlug, 'gamma', 'the pointer still lands on the named domain');
  ok(st.projectLc && st.projectLc.mode === 'create', 'and the create form is open', JSON.stringify(st.projectLc));
  eq(st.projectLc && st.projectLc.slug, 'gamma', '…targeting the requested domain, not domains[0]');
}
{
  shellBox.requestDomain('gamma', { openCreate: true });
  const st = await mount();
  ok(st.projectLc && st.projectLc.mode === 'create',
    'the {openCreate: true} shorthand reaches the same place, because the shell normalises it');
}
{
  shellBox.requestDomain('gamma', { reason: 'some-other-word' });
  const st = await mount();
  eq(st.projectLc, null, 'a reason the consumer has not learned opens nothing — an arrival never fails on a word');
}
{
  shellBox.requestDomain('gamma');
  const st = await mount();
  eq(st.projectLc, null, 'CONTROL: a plain request opens no form');
}
{
  // A FORM ON A DOMAIN THAT IS NOT THERE would be the worst outcome of the
  // two features meeting: the create POST targets `form.slug`.
  shellBox.requestDomain('does-not-exist', { reason: shellBox.NEW_PROJECT_REASON });
  const st = await mount();
  eq(st.activeSlug, 'alpha', 'an unknown slug with the pointer reason still falls back');
  eq(st.projectLc, null, '…and NO form is opened on the domain it fell back to');
}

// ═════════════════════════════════════════════════════════════════════════
section('§6  THE LIFTED CHAT-SCOPE WRAPPER (P1-10) — one module, three rules');
// ═════════════════════════════════════════════════════════════════════════
{
  const order = [];
  const scopeBox = new Function('navigate', 'shell', 'console', `
    ${extractFunction(chatScopeJs, 'goToChatScoped', 'shared/chat-scope.js')}
    return { goToChatScoped };
  `);
  const build = (requestChatScope) => {
    order.length = 0;
    return scopeBox(
      (v) => order.push(['navigate', v]),
      requestChatScope ? { requestChatScope: (s) => order.push(['request', s]) } : {},
      { warn: (m) => order.push(['warn', String(m)]) },
    ).goToChatScoped;
  };

  let go = build(true);
  go('articles');
  eq(JSON.stringify(order), JSON.stringify([['request', 'articles'], ['navigate', 'chat']]),
    'RULE 1+2: the scope is RECORDED first and navigate() is called exactly once');

  go = build(true);
  go('  articles  ');
  eq(order[0] && order[0][1], 'articles', 'a padded slug is trimmed before it is recorded');

  go = build(true);
  go();
  ok(order.some((e) => e[0] === 'warn'), 'RULE 3: no slug warns…', JSON.stringify(order));
  ok(!order.some((e) => e[0] === 'request'),
    '…and records NOTHING, rather than a request that scopes nothing', JSON.stringify(order));
  eq(order.filter((e) => e[0] === 'navigate').length, 1,
    '…while still opening Chat exactly once — the button is not dead');

  go = build(true);
  go('');
  ok(!order.some((e) => e[0] === 'request'), 'an empty string is the same case as no argument');

  // THE DEGRADATION CONTRACT, lifted verbatim from views/domains.js: a shell
  // that does not export the recorder must warn loudly and still navigate.
  go = build(false);
  go('articles');
  ok(order.some((e) => e[0] === 'warn' && /requestChatScope/.test(e[1])),
    'a missing app.js export warns LOUDLY…', JSON.stringify(order));
  eq(order.filter((e) => e[0] === 'navigate').length, 1, '…and Chat still opens, unscoped');
}
{
  // THE POINT OF LIFTING IT: one producer, not two. A second hand-written
  // copy in either view re-opens all three rules.
  ok(!/function goToChatScoped/.test(domainsJs),
    'views/domains.js no longer declares its own copy');
  ok(/from '\.\.\/shared\/chat-scope\.js'/.test(domainsJs),
    '…it imports the lifted one');
  const views = path.join(ROOT, 'src/public/next/views');
  const { readdirSync } = await import('node:fs');
  const offenders = readdirSync(views).filter((f) => f.endsWith('.js'))
    .filter((f) => /function goToChatScoped/.test(readFileSync(path.join(views, f), 'utf8')));
  eq(offenders.length, 0,
    `NO view declares a goToChatScoped of its own (found: ${JSON.stringify(offenders)})`);
  // CONTROL: the walker must be able to SEE a declaration, or the line above
  // passes for free.
  ok(/function goToChatScoped/.test(chatScopeJs),
    'CONTROL: the same probe finds the one real declaration, in shared/chat-scope.js');
}

console.log('\n────────────────────────────────────────────────────────────');
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed === 0) console.log('✅ The domain handoff holds at both ends');
process.exit(failed > 0 ? 1 : 0);
