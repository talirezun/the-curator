/**
 * test-next-domain-lifecycle.js — OFFLINE guard on /next's domain
 * create / rename / delete flow (src/public/next/views/domains.js).
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 *
 * Until this release every /api/domains call in /next was a bare GET: the
 * redesign had no way to create, rename or delete a domain at all, so
 * cutover would have shipped a version where users lost three working
 * features. The routes themselves are old and unchanged — what is new is the
 * client, and the client is where these three semantics are easy to get
 * wrong:
 *
 *   1. POST /api/domains returns **201**, not 200.
 *   2. The slug is **server-generated**. A client that sends its own is
 *      ignored today and wrong the first time two names collide.
 *   3. On rename, **newSlug can EQUAL oldSlug** (routes/domains.js:138, the
 *      display-name-only branch). Code that assumes the slug moved re-keys
 *      its state to a slug that does not exist, and every subsequent call
 *      404s on a domain that is sitting right there under its old name.
 *      BOTH branches are tested below, because only testing the interesting
 *      one is how the boring one ships broken.
 *
 * And one behaviour that is not a semantic but a scar: PUT and DELETE both
 * 409 when the domain has an active write. v3.6.0's finding 7 was a refused
 * destructive write that rendered NOTHING — the button just reset, the user
 * read that as "my click didn't register", and clicked the destructive
 * action again. §6 asserts the refusal reaches a visible surface carrying
 * the server's own sentence, and §7 asserts it is not merely mixed in with
 * ordinary errors.
 *
 * ── Method ───────────────────────────────────────────────────────────────
 *
 * The pure functions are extracted from the real source with a brace-matched
 * extractor and evaluated via `new Function` — the pattern established by
 * scripts/test-next-mcp-wizard.js and test-ingest-queue-frontend.js. A
 * missing name THROWS rather than silently testing nothing.
 *
 * ── NOT ENFORCED (stated rather than implied) ────────────────────────────
 *
 *   • No server is started and no HTTP call is made. This pins the request
 *     SHAPES and the state transitions, not the server's replies.
 *   • The sandbox supplies its own `escapeHtml`; §8 proves the render path
 *     calls it (with a sentinel escaper), not that app.js's implementation
 *     is correct — that is test-css-tokens.js's and app.js's own business.
 *   • Nothing here checks Agent-owned files other than domains.js.
 */

import { readFileSync } from 'fs';
import path from 'path';

const REPO = path.resolve(new URL('..', import.meta.url).pathname);
const SRC = path.join(REPO, 'src/public/next/views/domains.js');
const src = readFileSync(SRC, 'utf8');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

// ── Extraction ───────────────────────────────────────────────────────────
// Brace-matched, parameter-list-aware (a destructured parameter would
// otherwise latch the matcher onto the wrong brace), and it THROWS on a
// missing name or a desynced match rather than returning something the
// sandbox will fail on later with a bare SyntaxError.
function extractFunction(source, name) {
  const marker = new RegExp(`(?:^|\\n)(?:async\\s+)?function ${name}\\s*\\(`);
  const m = marker.exec(source);
  if (!m) throw new Error(`extractFunction: "${name}" not found in domains.js`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  let p = source.indexOf('(', start);
  if (p === -1) throw new Error(`extractFunction: "${name}" has no parameter list`);
  let parenDepth = 0;
  for (; p < source.length; p++) {
    if (source[p] === '(') parenDepth++;
    else if (source[p] === ')') { parenDepth--; if (parenDepth === 0) { p++; break; } }
  }
  let i = source.indexOf('{', p);
  if (i === -1) throw new Error(`extractFunction: "${name}" has no body`);
  let depth = 0;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const extracted = source.slice(start, i);
  const singleLine = !extracted.includes('\n');
  if (!singleLine && !/\n\}$/.test(extracted)) {
    throw new Error(`extractFunction: "${name}" does not end at a top-level closing brace — the matcher desynced`);
  }
  return extracted;
}

function extractConst(source, name) {
  const re = new RegExp(`(?:^|\\n)const ${name} = [\\s\\S]*?;[ \\t]*(?://[^\\n]*)?\\n`);
  const m = re.exec(source);
  if (!m) throw new Error(`extractConst: "${name}" not found in domains.js`);
  const extracted = m[0].trim();
  if (/\bfunction\s/.test(extracted)) {
    throw new Error(`extractConst: "${name}" extraction swallowed a function — the terminator desynced`);
  }
  return extracted;
}

const FNS = [
  'validateDomainForm',
  'createRequestBody',
  'applyRenameResult',
  'applyDeleteResult',
  'classifyDomainError',
  'openLifecycle',
  'closeLifecycle',
  'renderLifecycleCard',
  'selectDomain',
  'goToChatScoped',
  'filterBrowseEntries',
  'activeBrowse',
  'activeSemanticScan',
];
const CONSTS = ['DOMAIN_TEMPLATES', 'DOMAIN_TEMPLATE_VALUES', 'BROWSE_FOLDERS', 'BROWSE_RENDER_CAP'];

const PREAMBLE = `
let state = {};
let myMountToken = 1;
const calls = { render: 0, loadHealth: [], navigate: [], chatScope: [], order: [] };
let escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
function icon() { return ''; }
function pluralize(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }
function render() { calls.render++; }
function loadHealth(slug, token, opts) { calls.loadHealth.push({ slug, token, opts }); return Promise.resolve(); }
function navigate(name) { calls.navigate.push(name); calls.order.push('nav'); }
function reportAsyncActionFailure(err) { calls.asyncFailures = (calls.asyncFailures || 0) + 1; void err; }
const shell = { requestChatScope: (s) => { calls.chatScope.push(s); calls.order.push('scope'); } };
`;

let sandbox;
try {
  sandbox = new Function(
    PREAMBLE +
    CONSTS.map((c) => extractConst(src, c)).join('\n') + '\n' +
    FNS.map((n) => extractFunction(src, n)).join('\n\n') + '\n' +
    `return { ${FNS.join(', ')}, ${CONSTS.join(', ')},
       __state: () => state,
       __setState: (s) => { state = s; },
       __calls: () => calls,
       __resetCalls: () => { calls.render = 0; calls.loadHealth.length = 0; calls.navigate.length = 0; calls.chatScope.length = 0; calls.order.length = 0; },
       __setEscape: (fn) => { escapeHtml = fn; },
       __setShell: (s) => { Object.keys(shell).forEach(k => delete shell[k]); Object.assign(shell, s); } };`
  )();
} catch (err) {
  console.log('FATAL: could not build the sandbox from domains.js — ' + err.message);
  process.exit(1);
}

const {
  validateDomainForm, createRequestBody, applyRenameResult, applyDeleteResult,
  classifyDomainError, openLifecycle, closeLifecycle, renderLifecycleCard,
  selectDomain, goToChatScoped, filterBrowseEntries,
  DOMAIN_TEMPLATE_VALUES, BROWSE_RENDER_CAP,
  __setState, __state, __calls, __resetCalls, __setEscape, __setShell,
} = sandbox;

function freshState(over) {
  return Object.assign({
    loaded: true,
    domains: [
      { slug: 'alpha', displayName: 'Alpha', pageCount: 7, pageCounts: { entities: 3, concepts: 2, summaries: 1, other: 1 } },
      { slug: 'beta', displayName: 'Beta', pageCount: 2, pageCounts: { entities: 1, concepts: 1, summaries: 0, other: 0 } },
    ],
    readonlySet: new Set(),
    activeSlug: 'alpha',
    health: null, healthLoading: false, healthError: null, healthSummary: {},
    aiAvailable: false, estimates: {},
    expandedGroups: new Set(), dismissedRecords: null,
    confirm: null, busyKey: null, banner: null,
    pendingPlan: null, semanticScan: null, lifecycle: null, browse: null,
  }, over || {});
}

console.log('\n=== 1. Form validation mirrors the two server 400s ===');
__setState(freshState());
ok(validateDomainForm({ displayName: '' }).ok === false, 'empty display name is refused');
ok(validateDomainForm({ displayName: '   ' }).ok === false, 'whitespace-only display name is refused');
ok(validateDomainForm({ displayName: 'Articles' }).ok === true, 'a plain name is accepted');
ok(validateDomainForm({ displayName: 'Articles', template: 'tech' }).ok === true, 'a valid template is accepted');
ok(validateDomainForm({ displayName: 'Articles', template: 'nope' }).ok === false, 'an unknown template is refused before the round trip');
ok(validateDomainForm({ displayName: 'x'.repeat(400) }).ok === false, 'an absurdly long name is refused');
ok(typeof validateDomainForm({ displayName: '' }).error === 'string' && validateDomainForm({ displayName: '' }).error.length > 0,
   'a refusal always carries a message — a silently-disabled form is not an explanation');
ok(DOMAIN_TEMPLATE_VALUES.length === 4 &&
   ['tech', 'business', 'personal', 'generic'].every((t) => DOMAIN_TEMPLATE_VALUES.includes(t)),
   'the client template list is exactly the server validTemplates set (routes/domains.js:88)');

console.log('\n=== 2. The create body never carries a client-computed slug ===');
const body = createRequestBody({ displayName: '  Machine Learning  ', description: '  notes  ', template: 'tech' });
ok(!('slug' in body), 'POST body has NO slug key — the server generates it (generateUniqueSlug)');
ok(body.displayName === 'Machine Learning', 'displayName is trimmed');
ok(body.description === 'notes', 'description is trimmed');
ok(body.template === 'tech', 'template is passed through');
ok(createRequestBody({ displayName: 'X' }).template === 'generic', 'template defaults to generic when unset');
ok(Object.keys(body).sort().join(',') === 'description,displayName,template',
   'the body has exactly the three documented fields and nothing else');

console.log('\n=== 3. Rename — BOTH branches, re-keyed off the RESPONSE ===');
// Branch A: the slug genuinely changes.
__setState(freshState({
  activeSlug: 'alpha',
  healthSummary: { alpha: 4, beta: 1 },
  semanticScan: { slug: 'alpha', pairs: [], previewed: new Set(['k']), preview: null },
  browse: { slug: 'alpha', entries: [], filter: '', folder: 'all' },
}));
let r = applyRenameResult({ oldSlug: 'alpha', newSlug: 'alpha-2', displayName: 'Alpha Two', syncWarning: true });
ok(r.slugChanged === true, 'A: a changed slug is reported as changed');
ok(r.slug === 'alpha-2', 'A: the slug to keep using is the SERVER-supplied newSlug');
ok(__state().activeSlug === 'alpha-2', 'A: activeSlug follows the response');
ok(__state().healthSummary['alpha-2'] === 4 && !('alpha' in __state().healthSummary),
   'A: the health summary MOVES rather than duplicating (a stale row would keep painting an attention dot)');
ok(__state().semanticScan === null, 'A: a scan stamped with the old slug is dropped');
ok(__state().browse === null, 'A: a page list stamped with the old slug is dropped');
ok(r.message.includes('alpha-2') && r.message.includes('alpha'), 'A: the message names both folder names');

// Branch B: display name only — newSlug === oldSlug. The boring branch.
__setState(freshState({
  activeSlug: 'alpha',
  healthSummary: { alpha: 4 },
  semanticScan: { slug: 'alpha', pairs: [], previewed: new Set(['k']), preview: null },
  browse: { slug: 'alpha', entries: [], filter: '', folder: 'all' },
}));
r = applyRenameResult({ oldSlug: 'alpha', newSlug: 'alpha', displayName: 'Alpha Renamed', syncWarning: false });
ok(r.slugChanged === false, 'B: an unchanged slug is reported as unchanged');
ok(r.slug === 'alpha', 'B: the slug to keep using is still alpha');
ok(__state().activeSlug === 'alpha', 'B: activeSlug is NOT re-pointed at a slug that does not exist');
ok(__state().healthSummary.alpha === 4, 'B: the health summary is left in place');
ok(__state().semanticScan !== null, 'B: the scan for this still-existing domain survives a display-name-only rename');
ok(__state().browse !== null, 'B: the page list for this still-existing domain survives too');
ok(r.message.includes('stays'), 'B: the message says the folder did not move');
// The failure this branch exists to prevent, stated as an assertion:
ok(__state().domains.some((d) => d.slug === __state().activeSlug),
   'B: activeSlug still names a domain that exists — assuming the slug changed is what makes every later call 404');

console.log('\n=== 4. Delete drops every reference to the removed domain ===');
__setState(freshState({
  activeSlug: 'alpha',
  healthSummary: { alpha: 4, beta: 1 },
  readonlySet: new Set(['alpha']),
  health: { counts: {} },
  semanticScan: { slug: 'alpha', pairs: [], previewed: new Set(), preview: null },
  browse: { slug: 'alpha', entries: [], filter: '', folder: 'all' },
}));
const del = applyDeleteResult('alpha');
ok(__state().domains.length === 1 && __state().domains[0].slug === 'beta', 'the domain is removed from the list');
ok(!('alpha' in __state().healthSummary), 'its health summary is dropped');
ok(!__state().readonlySet.has('alpha'), 'its readonly flag is dropped');
ok(__state().semanticScan === null && __state().browse === null, 'its scan and page list are dropped');
ok(__state().activeSlug === 'beta' && del.nextSlug === 'beta', 'a surviving domain becomes active');
ok(__state().health === null, 'the stale health report for the deleted domain is cleared');
__setState(freshState({ domains: [{ slug: 'only', displayName: 'Only', pageCount: 1 }], activeSlug: 'only' }));
applyDeleteResult('only');
ok(__state().activeSlug === null, 'deleting the last domain leaves no active slug (rather than a dangling one)');

console.log('\n=== 5. A 409 is a REFUSAL, not a failure ===');
const conflictErr = Object.assign(new Error('Cannot delete domain "alpha" while a write operation is running: alpha (ingest). Please wait for it to finish, then try again.'),
  { status: 409, body: { conflict: 'write_in_progress' } });
let c = classifyDomainError(conflictErr);
ok(c.refusal === conflictErr.message, 'a 409 becomes a refusal carrying the SERVER’s own sentence, unaltered');
ok(c.error === null, 'a 409 is not also reported as an error');
c = classifyDomainError(Object.assign(new Error('Domain not found'), { status: 404 }));
ok(c.refusal === null && c.error === 'Domain not found', 'a 404 is an ordinary error, not a refusal');
c = classifyDomainError(Object.assign(new Error('boom'), { status: 500 }));
ok(c.refusal === null && c.error === 'boom', 'a 500 is an ordinary error');
// A body-only conflict marker (no status) still counts — the shape the
// write-registry actually emits is what matters, not only the number.
c = classifyDomainError(Object.assign(new Error('busy'), { body: { conflict: 'file_lock' } }));
ok(c.refusal === 'busy', 'a conflict marker in the body is honoured even without a 409 status');
// Negative control: the detector CAN report "not a refusal".
ok(classifyDomainError(new Error('plain')).refusal === null,
   'negative control — a plain Error is NOT classified as a refusal (the detector can distinguish)');

console.log('\n=== 6. The refusal renders on a visible surface ===');
__setState(freshState());
openLifecycle('delete', { slug: 'alpha', displayName: 'Alpha' });
__state().lifecycle.refusal = 'Cannot delete domain "alpha" while a write operation is running: alpha (ingest).';
let html = renderLifecycleCard();
ok(html.includes('dm-lc-refusal'), 'the delete card renders a dedicated refusal block');
ok(html.includes('Cannot delete domain'), 'the refusal block contains the server’s explanation');
ok(html.includes('Not done'), 'the refusal says the operation did NOT happen — the thing a reset button never says');
ok(!html.includes('dm-lc-error'), 'a refusal is NOT also rendered as a generic error');
// It must be in the card the user is already looking at, above the buttons —
// not a status line elsewhere on the page that an overlay or a scroll can hide.
ok(html.indexOf('dm-lc-refusal') < html.indexOf('dm-lc-actions'),
   'the refusal is rendered ABOVE the action buttons, inside the same card');
ok(!/class="[^"]*scrim/.test(html) && !html.includes('position:fixed'),
   'the lifecycle card opens no overlay — v3.6.0 finding 7 was a refusal rendered underneath one');

console.log('\n=== 6b. …and so does an ordinary error ===');
__state().lifecycle.refusal = null;
__state().lifecycle.error = 'Domain not found';
html = renderLifecycleCard();
ok(html.includes('dm-lc-error') && html.includes('Domain not found'), 'an error renders its own block with its own message');
ok(!html.includes('dm-lc-refusal'), 'an error is not dressed up as a refusal');

console.log('\n=== 7. Delete confirmation states the page count ===');
__setState(freshState());
openLifecycle('delete', { slug: 'alpha', displayName: 'Alpha' });
html = renderLifecycleCard();
ok(html.includes('7 pages'),
   'the delete card quotes pageCount (7) — the RECURSIVE total, so it cannot promise 4 and delete 7 (v3.2.0 L1)');
ok(html.includes('domains/alpha/'), 'it names the folder being removed');
ok(html.includes('cannot be undone'), 'it says the deletion is irreversible');
// pageCounts.entities+concepts+summaries would be 6, not 7 — pin that the
// narrowed number is NOT the one being shown.
ok(!html.includes('6 pages'), 'it does NOT quote the narrowed entities+concepts+summaries subtotal');

console.log('\n=== 8. User-controlled strings are escaped at every sink ===');
__setEscape((s) => 'ESC[' + String(s) + ']');
__setState(freshState({ domains: [{ slug: 'x', displayName: 'x', pageCount: 1 }] }));
openLifecycle('delete', { slug: '<img src=x onerror=1>', displayName: '<script>alert(1)</script>' });
__state().lifecycle.refusal = '<b>refusal</b>';
html = renderLifecycleCard();
ok(html.includes('ESC[<script>alert(1)</script>]'), 'delete: the display name goes through escapeHtml');
ok(html.includes('ESC[<img src=x onerror=1>]'), 'delete: the slug goes through escapeHtml');
ok(html.includes('ESC[<b>refusal</b>]'), 'delete: the refusal text goes through escapeHtml');
ok(!/<script>alert\(1\)<\/script>/.test(html.replace(/ESC\[[^\]]*\]/g, '')),
   'delete: no unescaped copy of the hostile name survives anywhere in the markup');
openLifecycle('rename', { slug: '<i>s</i>', displayName: '"><b>n</b>' });
__state().lifecycle.error = '<u>err</u>';
html = renderLifecycleCard();
ok(html.includes('ESC["><b>n</b>]') && html.includes('ESC[<i>s</i>]') && html.includes('ESC[<u>err</u>]'),
   'rename: name, slug and error all go through escapeHtml (the value lands in a value="" attribute)');
openLifecycle('create');
__state().lifecycle.displayName = '"><script>';
__state().lifecycle.description = '</input>';
html = renderLifecycleCard();
ok(html.includes('ESC["><script>]') && html.includes('ESC[</input>]'),
   'create: both text inputs escape their current value before it re-enters the markup');
__setEscape((s) => String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])));

console.log('\n=== 9. A form for one domain cannot survive a switch to another ===');
__setState(freshState());
openLifecycle('delete', { slug: 'alpha', displayName: 'Alpha' });
ok(__state().lifecycle !== null, 'precondition: a delete form is open for alpha');
__resetCalls();
selectDomain('beta');
ok(__state().lifecycle === null,
   'switching domains clears the lifecycle form — an armed "Delete alpha?" card must not sit above beta');
ok(__state().browse === null, 'switching domains clears the page list too (it belongs to the old domain)');
ok(__state().activeSlug === 'beta', 'the switch happened');
ok(__calls().loadHealth.length === 1 && __calls().loadHealth[0].slug === 'beta', 'the new domain is rescanned');
// The second, independent layer: the run* functions target lifecycle.slug,
// never state.activeSlug — so even a form that somehow survived could not
// act on the domain that happens to be selected now.
for (const fn of ['runRenameDomain', 'runDeleteDomain']) {
  const body2 = extractFunction(src, fn);
  ok(/const target = form\.slug;/.test(body2),
     `${fn} targets form.slug (the domain the form was opened for), not state.activeSlug`);
  ok(!/encodeURIComponent\(state\.activeSlug\)/.test(body2),
     `${fn} never builds its URL from state.activeSlug`);
}

console.log('\n=== 10. Write-gate + refusal wiring (source-level) ===');
const createSrc = extractFunction(src, 'runCreateDomain');
const renameSrc = extractFunction(src, 'runRenameDomain');
const deleteSrc = extractFunction(src, 'runDeleteDomain');
ok(/fetchJSON\('\/api\/domains',[\s\S]*method: 'POST'/.test(createSrc), 'create POSTs to /api/domains');
ok(/method: 'PUT'/.test(renameSrc) && /'\/api\/domains\/' \+ encodeURIComponent\(target\)/.test(renameSrc),
   'rename PUTs to /api/domains/:domain with an encoded slug');
ok(/method: 'DELETE'/.test(deleteSrc) && /'\/api\/domains\/' \+ encodeURIComponent\(target\)/.test(deleteSrc),
   'delete DELETEs /api/domains/:domain with an encoded slug');
ok(!/POST[\s\S]*slug:/.test(createSrc), 'create never puts a slug in its request');
for (const [name, body3] of [['rename', renameSrc], ['delete', deleteSrc]]) {
  ok(/beginDomainWrite\(target, '/.test(body3), `${name} registers a shell-wide write gate on the target domain`);
  const fin = body3.slice(body3.lastIndexOf('} finally {'));
  ok(/releaseGate\(\);/.test(fin), `${name} releases that gate in its finally — unconditionally`);
}
// A create makes no domain busy (the domain does not exist yet), so it
// deliberately does NOT take the gate. Pin that, so "add it everywhere" is
// a deliberate change rather than a drive-by.
ok(!/beginDomainWrite/.test(createSrc), 'create does NOT take a write gate — there is no existing domain to make busy');
for (const [name, body4] of [['create', createSrc], ['rename', renameSrc], ['delete', deleteSrc]]) {
  ok(/classifyDomainError\(err\)/.test(body4), `${name} routes its failure through the refusal classifier`);
  ok(/state\.lifecycle\.refusal = c\.refusal/.test(body4), `${name} surfaces the refusal on the form the user is looking at`);
  ok(/const token = myMountToken;/.test(body4), `${name} captures the mount token before its first await`);
  ok(/if \(!isCurrentMount\(token\)\) return;/.test(body4), `${name} re-checks the mount after awaiting`);
}
// The success path must not be reported through the failure path.
for (const [name, body5] of [['create', createSrc], ['rename', renameSrc], ['delete', deleteSrc]]) {
  ok(/if \(succeeded\) await reloadAfterLifecycleChange\(token\);/.test(body5),
     `${name} reloads AFTER the try — a stale-list failure must not be reported as "your domain was not created"`);
}

console.log('\n=== 11. Chat handoff goes through the shell, not localStorage ===');
ok(!/localStorage\.(set|get)Item\(\s*'curator-next-chat/.test(src),
   'the two dead chat-handoff localStorage keys are GONE — a key nothing reads still survives a reload and hijacks a later Chat entry');
ok(!/function requestChatFirstRun/.test(src), 'requestChatFirstRun is deleted, not merely unused');
ok(/shell\.requestChatScope\(slug\)/.test(src), 'the handoff calls app.js’s requestChatScope');
__setState(freshState());
__resetCalls();
goToChatScoped('alpha');
ok(__calls().chatScope.length === 1 && __calls().chatScope[0] === 'alpha', 'the selected slug is handed to the shell');
ok(__calls().order.join('>') === 'scope>nav',
   'the scope is RECORDED before the navigation — chat.js consumes it synchronously inside onEnter, which navigate() invokes');
// VERIFIED against app.js: requestChatScope only RECORDS the request; it
// does not navigate. So this call site must — and exactly once, because
// navigate() re-mounts even for the current view while
// consumeChatScopeRequest() clears on read, so a second call would find
// nothing pending and silently drop the scope.
ok(__calls().navigate.length === 1 && __calls().navigate[0] === 'chat',
   '…and Chat is opened exactly once (recorded first, navigated second)');
// Degradation: a missing export must be loud and still usable, never a dead button.
__setShell({});
__resetCalls();
const realWarn = console.warn;
let warned = 0;
console.warn = () => { warned++; };
goToChatScoped('alpha');
console.warn = realWarn;
ok(warned === 1, 'a missing shell export warns loudly on the console');
ok(__calls().navigate.length === 1 && __calls().navigate[0] === 'chat',
   '…and still opens Chat (unscoped) rather than leaving a dead button');
__setShell({ requestChatScope: (s) => { __calls().chatScope.push(s); __calls().order.push('scope'); } });

console.log('\n=== 12. Page-list filtering (wiki browse panel) ===');
const entries = [
  { slug: 'openai', folder: 'entities', path: 'entities/openai.md', title: 'Openai' },
  { slug: 'rag', folder: 'concepts', path: 'concepts/rag.md', title: 'Rag' },
  { slug: 'open-source', folder: 'concepts', path: 'concepts/open-source.md', title: 'Open Source' },
  { slug: 'a-report', folder: 'summaries', path: 'summaries/a-report.md', title: 'A Report' },
];
ok(filterBrowseEntries(entries, '', 'all').length === 4, 'no filter, all folders → everything');
ok(filterBrowseEntries(entries, '', 'concepts').length === 2, 'folder tab narrows to that folder');
ok(filterBrowseEntries(entries, 'open', 'all').length === 2, 'the text filter matches substrings of the slug');
ok(filterBrowseEntries(entries, 'OPEN', 'all').length === 2, 'the text filter is case-insensitive');
ok(filterBrowseEntries(entries, 'open', 'entities').length === 1, 'text filter and folder tab compose');
ok(filterBrowseEntries(entries, 'zzz', 'all').length === 0, 'a filter matching nothing returns nothing (negative control)');
ok(filterBrowseEntries(entries, 'A Report', 'all').length === 1, 'the title is searched as well as the slug');
ok(typeof BROWSE_RENDER_CAP === 'number' && BROWSE_RENDER_CAP > 0, 'the render cap is a real number — ~3,300 rows are not painted at once');
const listSrc = extractFunction(src, 'loadBrowse');
ok(/'\/api\/wiki\/' \+ encodeURIComponent\(slug\) \+ '\/list'/.test(listSrc),
   'the page list comes from GET /api/wiki/:domain/list (Agent D’s readdir-only endpoint), not the 14 MB whole-domain route');
ok(/b\.truncated = !!data\.truncated/.test(listSrc), 'the endpoint’s truncated flag is read, not ignored');
ok(/renderBrowsePanel/.test(src) && /dm-browse-note dm-quick-note-busy/.test(src),
   'a truncated listing is SHOWN as incomplete rather than silently presented as the whole domain');

console.log('\n' + '='.repeat(60));
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ /next domain lifecycle contract holds');
