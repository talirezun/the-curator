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

// v3.62.0 (P1-10). `goToChatScoped` MOVED out of views/domains.js into
// shared/chat-scope.js when the Project-context view gained the same door:
// two hand-written copies of a three-rule ritual (record, then navigate;
// exactly one navigate; a real slug) is what v3.7.0 deleted. §11 below is
// UNCHANGED in what it asserts — the ritual is the subject, not the file the
// ritual happens to live in — and it is still EXECUTED, in the same sandbox,
// against the same recorded `navigate` and `shell`. It is lifted from here
// instead. The wrapper's own edge cases (a padded slug, a no-slug call, and a
// tree walk refusing a second copy in any view) are driven in
// scripts/test-next-domain-request.js §6.
const CHAT_SCOPE_SRC = readFileSync(
  path.join(REPO, 'src/public/next/shared/chat-scope.js'), 'utf8');

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
  // `export` is accepted and then STRIPPED (it is a SyntaxError inside
  // `new Function`), because since v3.62.0 one of the names below is lifted
  // out of a shared MODULE rather than out of the view. The error names the
  // source it actually searched, so a desync in either file says which.
  const marker = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ${name}\\s*\\(`);
  const m = marker.exec(source);
  if (!m) {
    throw new Error(`extractFunction: "${name}" not found in `
      + (source === src ? 'domains.js' : 'the source it was asked for'));
  }
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
  return extracted.replace(/^export\s+/, '');
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
  'deleteConfirmMatches',
  'selectDomain',
  // Lifted from shared/chat-scope.js, not from domains.js — see the
  // CHAT_SCOPE_SRC note above. It is in this list because the sandbox's
  // `navigate` and `shell` are the collaborators §11 records against, and
  // moving the drive outside would mean a second set of spies.
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
// v3.48.0: selectDomain also re-asks for the domain's PROJECTS (agent memory
// is kept per project inside a domain). Stubbed and RECORDED rather than
// silently swallowed, so a change that stopped re-asking is visible here.
function loadProjects(slug, token) { (calls.loadProjects = calls.loadProjects || []).push({ slug, token }); return Promise.resolve(); }
// v3.49.0: selectDomain also re-asks for the domain's PAGE LIST. The browser
// used to sit behind a "Browse pages" button and load only on demand, which
// is how a power user ended up unable to find his own wiki; it is now loaded
// with the domain, like the projects above. Stubbed and RECORDED for the same
// reason: a change that stopped re-asking must be visible here rather than
// silently swallowed.
function loadBrowse(slug, token) { (calls.loadBrowse = calls.loadBrowse || []).push({ slug, token }); return Promise.resolve(); }
function navigate(name) { calls.navigate.push(name); calls.order.push('nav'); }
function reportAsyncActionFailure(err) { calls.asyncFailures = (calls.asyncFailures || 0) + 1; void err; }
const shell = { requestChatScope: (s) => { calls.chatScope.push(s); calls.order.push('scope'); } };
// v3.72.1 (F1): the Delete confirm re-reads its domain's stats when it opens.
// Answered here from the sandbox's own list, synchronously-resolved, so the
// page-count assertions below read the FRESH-read path; the stale-row case is
// scripts/test-domains-true-numbers.js §3.
function isCurrentMount() { return true; }
function refreshDomainFigures(slug) {
  const row = (state.domains || []).find((d) => d.slug === slug);
  return Promise.resolve(row || null);
}
// v3.73.0: GET …/delete-preview, answered from a per-test table the suite
// sets through __setPreview (null = unreadable, the default).
let previewFor = {};
function loadDeletePreview(slug) {
  return Promise.resolve(Object.prototype.hasOwnProperty.call(previewFor, slug) ? previewFor[slug] : null);
}
`;

let sandbox;
try {
  sandbox = new Function(
    PREAMBLE +
    CONSTS.map((c) => extractConst(src, c)).join('\n') + '\n' +
    FNS.map((n) => extractFunction(
      n === 'goToChatScoped' ? CHAT_SCOPE_SRC : src, n)).join('\n\n') + '\n' +
    `return { ${FNS.join(', ')}, ${CONSTS.join(', ')},
       __state: () => state,
       __setState: (s) => { state = s; },
       __calls: () => calls,
       __resetCalls: () => { calls.render = 0; calls.loadHealth.length = 0; calls.navigate.length = 0; calls.chatScope.length = 0; calls.order.length = 0; },
       __setEscape: (fn) => { escapeHtml = fn; },
       __setShell: (s) => { Object.keys(shell).forEach(k => delete shell[k]); Object.assign(shell, s); },
       __setPreview: (m) => { previewFor = m || {}; } };`
  )();
} catch (err) {
  console.log('FATAL: could not build the sandbox from domains.js — ' + err.message);
  process.exit(1);
}

const {
  validateDomainForm, createRequestBody, applyRenameResult, applyDeleteResult,
  classifyDomainError, openLifecycle, closeLifecycle, renderLifecycleCard, deleteConfirmMatches, __setPreview,
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
// v3.72.1 (F1): the count is the one READ when the card opened — let that
// read land (the sandbox answers it from its own list) before rendering.
await new Promise((r) => setTimeout(r, 0));
html = renderLifecycleCard();
ok(html.includes('7 pages'),
   'the delete card quotes pageCount (7) — the RECURSIVE total, so it cannot promise 4 and delete 7 (v3.2.0 L1)');
ok(html.includes('domains/alpha/'), 'it names the folder being removed');
// v3.73.0: it is no longer irreversible — the folder is MOVED to the trash —
// and the card must say so rather than keep the old "cannot be undone".
ok(/moved to The Curator’s trash/.test(html) && /not erased/.test(html) && !html.includes('cannot be undone'),
   'it says the domain goes to the trash, recoverable — and no longer claims it cannot be undone');
// pageCounts.entities+concepts+summaries would be 6, not 7 — pin that the
// narrowed number is NOT the one being shown.
ok(!html.includes('6 pages'), 'it does NOT quote the narrowed entities+concepts+summaries subtotal');

console.log('\n=== 7b. v3.73.0 — the TYPED confirmation gates the Delete button ===');
{
  __setState(freshState());
  openLifecycle('delete', { slug: 'alpha', displayName: 'Alpha' });
  await new Promise((r) => setTimeout(r, 0));
  const f = __state().lifecycle;
  ok(f.confirmText === '', 'the confirmation starts EMPTY — nothing is pre-filled');
  let card = renderLifecycleCard();
  ok(/id="dm-lc-submit" disabled/.test(card), 'the Delete button starts DISABLED');
  ok(/id="dm-lc-confirm"/.test(card), 'the card carries the confirmation input');
  ok(/Type <span class="mono">alpha<\/span> to confirm/.test(card),
     'the label prints the exact word to type — the SLUG, the thing that is deleted');
  for (const wrong of ['alph', 'Alpha', 'ALPHA', ' alpha', 'alpha ', 'alpha\n', 'domains/alpha']) {
    f.confirmText = wrong;
    ok(!deleteConfirmMatches(f) && /id="dm-lc-submit" disabled/.test(renderLifecycleCard()),
       'still disabled for ' + JSON.stringify(wrong) + ' — exact match only (no trim, no case-folding, not the display name)');
  }
  f.confirmText = 'alpha';
  card = renderLifecycleCard();
  ok(deleteConfirmMatches(f) && !/id="dm-lc-submit" disabled/.test(card),
     'ENABLED once the input equals the slug exactly');
  f.busy = true;
  ok(/id="dm-lc-submit" disabled/.test(renderLifecycleCard()), 'and disabled again while the delete is in flight');
  f.busy = false;
  ok(/Delete domain</.test(card) && !/Delete permanently/.test(card),
     'the button no longer says "permanently" — the delete is recoverable now');
}

console.log('\n=== 7c. v3.73.0 — the confirm states everything that goes, from the preview ===');
{
  __setPreview({ alpha: {
    slug: 'alpha', pageCount: 7, projects: 3, conversationCount: 12, rawSources: 40,
    trashDir: '/tmp/ud/.curator-trash', syncConfigured: true,
  } });
  __setState(freshState());
  openLifecycle('delete', { slug: 'alpha', displayName: 'Alpha' });
  await new Promise((r) => setTimeout(r, 0));
  const card = renderLifecycleCard();
  ok(card.includes('all 7 pages in it'), 'pages, from the fresh read');
  ok(card.includes('the Memory of 3 projects'), 'projects with Memory, from the preview');
  ok(card.includes('12 saved conversations'), 'conversations, from the preview');
  ok(card.includes('40 raw source files'), 'raw sources, from the preview');
  ok(/never sent to GitHub Sync/.test(card), 'and that raw sources are not in any Sync backup — what the incident lost');
  ok(card.includes('/tmp/ud/.curator-trash/domains/'), 'it names the trash folder the domain goes to');
  ok(/GitHub Sync is on/.test(card), 'Sync configured → it says the delete still propagates');

  __setPreview({ alpha: { slug: 'alpha', pageCount: 7, projects: 0, conversationCount: 0, rawSources: 0, trashDir: '/t', syncConfigured: false } });
  __setState(freshState());
  openLifecycle('delete', { slug: 'alpha', displayName: 'Alpha' });
  await new Promise((r) => setTimeout(r, 0));
  const zero = renderLifecycleCard();
  ok(!/\b0 (raw|saved|project)/.test(zero) && !/never sent to GitHub Sync/.test(zero) && !/GitHub Sync is on/.test(zero),
     'zero counts are not listed, and no Sync sentence without Sync');

  // A preview answered for a DIFFERENT domain (a stale response) is ignored.
  __setPreview({ alpha: { slug: 'beta', projects: 99, conversationCount: 99, rawSources: 99, trashDir: '/x' } });
  __setState(freshState());
  openLifecycle('delete', { slug: 'alpha', displayName: 'Alpha' });
  await new Promise((r) => setTimeout(r, 0));
  ok(__state().lifecycle.preview === null && !renderLifecycleCard().includes('99'),
     'a preview naming another domain is discarded, not quoted');
  __setPreview({});
}

console.log('\n=== 7d. v3.73.0 — runDeleteDomain SENDS the confirmation, and never without it ===');
{
  // runDeleteDomain lifted into its own sandbox with every collaborator
  // stubbed and RECORDED, so the request it makes is read off the call, not
  // off the source.
  const RUN_FNS = ['deleteConfirmMatches', 'deleteDomainOutcome', 'runDeleteDomain'];
  const mk = new Function('stubs', `
    let state = stubs.state; let myMountToken = 1;
    const { fetchJSON, beginDomainWrite, applyDeleteResult, classifyDomainError, reloadAfterLifecycleChange,
            revealMessage, render, isCurrentMount } = stubs;
    ${RUN_FNS.map((n) => extractFunction(src, n)).join('\n\n')}
    return { runDeleteDomain };`);
  const fetches = [];
  let fetchReply = { deleted: true, trashPath: '/tmp/ud/.curator-trash/domains/alpha--2026-09-25T10-00-00Z', syncWarning: true };
  const stubs = {
    state: { lifecycle: null, banner: null },
    fetchJSON: async (url, opts) => { fetches.push({ url, opts }); return fetchReply; },
    beginDomainWrite: () => () => {},
    applyDeleteResult: () => {},
    classifyDomainError: (e) => ({ error: e.message, refusal: null }),
    reloadAfterLifecycleChange: async () => {},
    revealMessage: () => {}, render: () => {}, isCurrentMount: () => true,
  };
  const { runDeleteDomain } = mk(stubs);

  stubs.state.lifecycle = { mode: 'delete', slug: 'alpha', displayName: 'Alpha', confirmText: 'Alpha', busy: false };
  await runDeleteDomain();
  ok(fetches.length === 0, 'a confirmation that does not match sends NO request at all');

  stubs.state.lifecycle.confirmText = 'alpha';
  await runDeleteDomain();
  ok(fetches.length === 1 && fetches[0].opts.method === 'DELETE' && fetches[0].url === '/api/domains/alpha',
     'a matching confirmation sends exactly one DELETE to the domain');
  let sent = null;
  try { sent = JSON.parse(fetches[0].opts.body); } catch { /* reported below */ }
  ok(sent && sent.confirm === 'alpha' && /json/i.test(String(fetches[0].opts.headers && fetches[0].opts.headers['Content-Type'])),
     'the typed word travels in the JSON body as `confirm` — the route re-checks it');
  ok(stubs.state.banner === null && stubs.state.lifecycleOutcome && stubs.state.lifecycleOutcome.tone === 'success',
     'the outcome goes in its own top slot (lifecycleOutcome), not state.banner — which renders deep in Health, off screen');
  const banner = stubs.state.lifecycleOutcome && stubs.state.lifecycleOutcome.text;
  ok(banner && banner.includes('/tmp/ud/.curator-trash/domains/alpha--2026-09-25T10-00-00Z'),
     'the success banner names WHERE the domain went (the server’s trashPath)');
  ok(banner && /moved to The Curator’s trash/.test(banner), 'and says it was MOVED to the trash, not erased');
  ok(banner && /To restore it/.test(banner) && /rename it alpha/.test(banner), 'and how to restore it');
  ok(banner && /propagates to GitHub/.test(banner), 'and, with Sync on, that the deletion still reaches GitHub');
}

{
  __setState(freshState({ lifecycleOutcome: { tone: 'success', text: 'Deleted x' } }));
  openLifecycle('create');
  ok(__state().lifecycleOutcome === null, 'opening the next lifecycle form clears the previous delete outcome');
  __setState(freshState({ activeSlug: 'alpha', lifecycleOutcome: { tone: 'success', text: 'Deleted x' } }));
  selectDomain('beta');
  ok(__state().lifecycleOutcome === null, 'switching domains clears it too');
}

console.log('\n=== 7e. v3.73.0 — typing flips the LIVE button, with no repaint ===');
{
  const els = {};
  const mkEl = (id, extra) => (els[id] = Object.assign({ id, value: '', disabled: false, handlers: {},
    addEventListener(t, fn) { (this.handlers[t] = this.handlers[t] || []).push(fn); } }, extra || {}));
  mkEl('dm-lc-confirm'); mkEl('dm-lc-submit', { disabled: true }); mkEl('dm-lc-cancel');
  const doc = { getElementById: (id) => els[id] || null, querySelectorAll: () => [] };
  let renders = 0;
  const mk = new Function('stubs', `
    let state = stubs.state; let myMountToken = 1; const document = stubs.document;
    const render = stubs.render; const closeLifecycle = () => {}; const reportAsyncActionFailure = () => {};
    const runCreateDomain = () => {}, runRenameDomain = () => {}, runDeleteDomain = () => {};
    ${['deleteConfirmMatches', 'bindLifecycleListeners'].map((n) => extractFunction(src, n)).join('\n\n')}
    return { bindLifecycleListeners };`);
  const st = { lifecycle: { mode: 'delete', slug: 'alpha', displayName: 'Alpha', confirmText: '', busy: false } };
  mk({ state: st, document: doc, render: () => { renders++; } }).bindLifecycleListeners();
  const type = (v) => { els['dm-lc-confirm'].value = v; (els['dm-lc-confirm'].handlers.input || []).forEach((h) => h()); };
  ok((els['dm-lc-confirm'].handlers.input || []).length === 1, 'the confirmation input has exactly one input handler');
  type('alph');
  ok(els['dm-lc-submit'].disabled === true && st.lifecycle.confirmText === 'alph', 'a partial word leaves the live button disabled');
  type('alpha');
  ok(els['dm-lc-submit'].disabled === false, 'the exact slug enables the live button');
  type('alphas');
  ok(els['dm-lc-submit'].disabled === true, 'typing past it disables it again');
  ok(renders === 0, 'no repaint on a keystroke — a repaint would rebuild the input and lose the caret');
}

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
ok(!/localStorage\.(set|get)Item\(\s*'curator-next-chat/.test(src + CHAT_SCOPE_SRC),
   'the two dead chat-handoff localStorage keys are GONE from BOTH files — a key nothing reads still survives a reload and hijacks a later Chat entry');
ok(!/function requestChatFirstRun/.test(src + CHAT_SCOPE_SRC), 'requestChatFirstRun is deleted, not merely unused');
ok(/shell\.requestChatScope\(clean\)/.test(CHAT_SCOPE_SRC),
   'the handoff calls app.js’s requestChatScope — on the CLEANED slug, because v3.62.0 guards the no-slug hazard inside the wrapper rather than at each producer');
ok(/from '\.\.\/shared\/chat-scope\.js'/.test(src) && !/function goToChatScoped/.test(src),
   '…and views/domains.js imports it rather than declaring a second copy');
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
// v3.50.0 appended `?include=memory` — the memory facet's count has to be
// right on the first paint. The ROUTE is what this pins, so the pattern stops
// at the path and the query is asserted separately below rather than being
// baked into one brittle literal.
ok(/'\/api\/wiki\/' \+ encodeURIComponent\(slug\) \+ '\/list/.test(listSrc),
   'the page list comes from GET /api/wiki/:domain/list (Agent D’s readdir-only endpoint), not the 14 MB whole-domain route');
ok(/\/list\?include=memory/.test(listSrc),
   '…and asks that endpoint for the domain’s MEMORY pages too, in the same round trip');
ok(/b\.truncated = !!data\.truncated/.test(listSrc), 'the endpoint’s truncated flag is read, not ignored');
ok(/renderBrowsePanel/.test(src) && /dm-browse-note dm-quick-note-busy/.test(src),
   'a truncated listing is SHOWN as incomplete rather than silently presented as the whole domain');

console.log('\n' + '='.repeat(60));
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ /next domain lifecycle contract holds');
