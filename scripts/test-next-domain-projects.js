#!/usr/bin/env node
/**
 * test-next-domain-projects.js — OFFLINE suite. No network, no API key, no LLM.
 *
 * Guards the v3.48.0 "Projects in this domain" sub-section of the /next
 * Domains view (src/public/next/views/domains.js) — the list, the create /
 * rename / delete lifecycle, the typed delete confirmation, and the
 * `.curator-project` marker line.
 *
 * EVERYTHING HERE DRIVES REAL CODE. The functions are lifted out of live
 * source by brace-matching and executed with `new Function` against injected
 * collaborators — the technique test-next-domain-lifecycle.js and
 * test-next-memory-view.js use, and for the reason this repo keeps
 * re-learning: a test that proves a line of source exists proves nothing
 * about what it does.
 *
 * ── ENFORCED ─────────────────────────────────────────────────────────────
 *  · THE LIST IS SLUG-STAMPED. `state` in that view is module-scoped and
 *    survives leaving the view, so a list rendered under a DIFFERENT domain's
 *    heading is a real hazard — and this list carries a Delete button, so the
 *    consequence is not cosmetic. `activeProjects()` is the only reader, and
 *    it refuses a stale stamp.
 *  · DELETE IS GATED ON AN EXACT TYPED MATCH: the button is disabled until
 *    the typed text equals the project name, the request carries it, and the
 *    route re-checks it independently (see test-next-memory-projects.js).
 *  · AND THE CONFIRMATION CAN BE TYPED AT ALL (S9). The gate was always
 *    right; the only way a user had of moving the value was not. See S9's
 *    own block for the defect and for why S4 stayed green throughout.
 *  · THE CREATE CONTROL BELONGS TO THE GROUP (S10). It is the group's LAST
 *    row, inside the same `.cur-group`, and there is exactly one of it; the
 *    create form takes that row's place when it opens. Asserted over a parsed
 *    TREE, because the substring assertions above cannot express containment
 *    — which is precisely how it shipped floating below the card.
 *  · EVERY STATE OF THE PANEL RENDERS SOMETHING — loading, failed, empty,
 *    read-only, and "this server is too old". A section that vanishes when it
 *    has nothing to show is indistinguishable from one that failed.
 *  · THE PILL IS A PLAIN WORD, and it states the FACT ("Standing brief" /
 *    "No brief yet"), never a status vocabulary (`configured`, `not set`).
 *  · A FACT AND ITS ABSENCE STAY DISTINGUISHABLE: a project with no saves
 *    reads "no saves yet", never an age.
 *  · ESCAPING: a hostile project name cannot break out of the attribute the
 *    click handlers read it back from.
 *  · THE ACTIONS TARGET THE FORM'S OWN SLUG, never `state.activeSlug` — the
 *    same two-layer discipline the domain lifecycle uses, so a form that
 *    somehow survived a domain switch still cannot act on the wrong domain.
 *  · A FAILED ACTION IS CLASSIFIED: a 4xx is a REFUSAL (rendered as "the
 *    server refused this"), anything else is an error.
 *  · THE SHELL-WIDE WRITE GATE IS RELEASED UNCONDITIONALLY, including when
 *    the mount is stale — a leaked gate disables Sync's buttons forever.
 *
 * ── NOT ENFORCED (named, not implied away) ───────────────────────────────
 *  · S1-S8 have no DOM: `render` is a spy and markup is asserted as strings.
 *    S9 is the exception and says so — it builds a DOM MODEL (not jsdom; this
 *    repo ships zero devDeps) and dispatches real `input` events at the
 *    shipped `bindProjectListeners`, because the v3.48.0 defect it guards was
 *    invisible to every string assertion above it. It is still a model:
 *    layout, contrast, the two themes and what Chromium does with a focused
 *    node removed mid-edit are the orchestrator's Electron pass.
 *  · The route's own guards are covered by test-next-memory-projects.js.
 *    This file asserts what the VIEW sends and shows.
 *  · `navigator.clipboard` is injected, so this proves what the copy handler
 *    does with a success and with a refusal — not that any real browser
 *    permits the write.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = readFileSync(join(ROOT, 'src/public/next/views/domains.js'), 'utf8');
const CSS = readFileSync(join(ROOT, 'src/public/next/views/domains.css'), 'utf8');

let passed = 0;
let failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  ok ' + label); }
  else { failed++; console.log('  FAIL ' + label + (detail ? ' -- ' + detail : '')); }
}
function eq(label, actual, expected) {
  ok(label, Object.is(actual, expected), 'got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected));
}
function section(t) { console.log('\n' + t); }

// ── Extraction ───────────────────────────────────────────────────────────
// Brace-matched, parameter-list-aware, and it THROWS on a missing name or a
// desynced match rather than handing the sandbox something that fails later
// as a bare SyntaxError.
function extractFunction(source, name) {
  const marker = new RegExp(`(?:^|\\n)(?:async\\s+)?function ${name}\\s*\\(`);
  const m = marker.exec(source);
  if (!m) throw new Error(`extractFunction: "${name}" not found in domains.js`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  let p = source.indexOf('(', start);
  let parenDepth = 0;
  for (; p < source.length; p++) {
    if (source[p] === '(') parenDepth++;
    else if (source[p] === ')') { parenDepth--; if (parenDepth === 0) { p++; break; } }
  }
  let i = source.indexOf('{', p);
  let depth = 0;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const extracted = source.slice(start, i);
  if (extracted.includes('\n') && !/\n\}$/.test(extracted)) {
    throw new Error(`extractFunction: "${name}" desynced`);
  }
  return extracted;
}

function extractConst(source, name) {
  // `=\\s` rather than `= `: a long string const puts its first fragment on the
  // NEXT line, and requiring a space after the `=` made those invisible to
  // this matcher -- which throws rather than returning a partial, so it was
  // found immediately and could never have been silent.
  const re = new RegExp(`(?:^|\\n)const ${name} =\\s[\\s\\S]*?;[ \\t]*(?://[^\\n]*)?\\n`);
  const m = re.exec(source);
  if (!m) throw new Error(`extractConst: "${name}" not found in domains.js`);
  return m[0].trim();
}

const FNS = [
  'activeProjects',
  // v3.50.0. The section's explanatory paragraph moved behind an ⓘ mark (the
  // maintainer asked for it "like the domain header's"), and renderProjectsPanel
  // builds that mark through this helper. LIFTED, never stubbed — S12b asserts
  // the fold really CARRIES the paragraph, and a stub would let an empty panel
  // pass that assertion.
  'infoMark',
  // v3.58.0. Each copy control carries its own ⓘ now, and the DOM id for it
  // is built here -- slug plus row index, so two names that slugify alike
  // cannot ship duplicate ids (v3.54.0's renderViewHeader collision).
  'projInfoId',
  'loadProjects',
  'renderProjectRow',
  'renderProjectsPanel',
  'renderProjectLifecycleCard',
  'openProjectLifecycle',
  'closeProjectLifecycle',
  'classifyProjectError',
  'runProjectAction',
  'copyProjectMarker',
  // v3.52.0. Both copy buttons share one body, so the marker path now runs
  // through it too; lifted, never stubbed, or S13 would be asserting a copy of
  // the code rather than the code.
  'copyProjectAgentInstructions',
  'copyForProject',
  'renderCopyOutcome',
  // v3.61.0. The create form asks where a project's canonical documents come
  // from, and this is the field that asks it — LIFTED rather than stubbed
  // because S5b asserts the ⓘ really CARRIES the definition, and a stub would
  // let an empty field pass that assertion.
  'foundationsField',
  'bindProjectListeners',
];

// The collaborators. Every one is injected and RECORDED, so an assertion can
// be made about what the shipped code asked for rather than about what it
// looks like.
const PREAMBLE = `
let state = {};
let myMountToken = 1;
const calls = { render: 0, fetch: [], gates: [], clipboard: [], asyncFailures: 0, revealed: [] };
let clipboardOk = true;
let mounted = true;
let fetchResponder = () => ({ ok: true });
const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
function icon() { return ''; }
let renderImpl = null;
function render() { calls.render++; if (renderImpl) renderImpl(); }
// The view reaches for a real document. Every section but S9 runs against
// this inert stand-in (nothing they call touches it); S9 swaps in a real DOM
// model and drives the shipped listeners against it.
let document = { getElementById: () => null, querySelectorAll: () => [] };
function isCurrentMount() { return mounted; }
function reportAsyncActionFailure() { calls.asyncFailures++; }
function revealMessage(sel) { calls.revealed.push(sel); }
function relTime(iso) { return 'REL(' + iso + ')'; }
function renderStatus(o) { return '<div class="tx-status tx-status-' + o.state + '">' +
  escapeHtml(o.title) + ' ' + escapeHtml(o.detail || '') + '</div>'; }
function renderDescription(t) { return '<p class="tx-desc">' + escapeHtml(t) + '</p>'; }
function renderBadge(o) { return '<span class="tx-badge tx-badge-' + o.tone + '">' + escapeHtml(o.label) + '</span>'; }
function beginDomainWrite(slug, op) { calls.gates.push({ slug, op, released: false });
  const i = calls.gates.length - 1; return () => { calls.gates[i].released = true; }; }
async function fetchJSON(url, opts) {
  calls.fetch.push({ url, opts });
  const r = fetchResponder(url, opts);
  if (r && r.throwStatus) { const e = new Error(r.message || 'boom'); e.status = r.throwStatus; throw e; }
  if (r && r.throwPlain) { throw new Error(r.message || 'network down'); }
  return r;
}
const navigator = { clipboard: { writeText: async (t) => {
  if (!clipboardOk) throw new Error('denied');
  calls.clipboard.push(t);
} } };
`;

// The REAL shared helper, injected rather than stubbed: this suite's marker
// assertions must keep passing against the same function the browser runs, and
// a stub here would let a broken import in the view pass unnoticed.
const { composeAgentInstructions, COPY_SUCCESS_BANNER } =
  await import('../src/public/next/shared/agent-instructions.js');
// ── THE OWNERSHIP CHOOSER, THE REAL ONE (v3.61.0) ─────────────────────────
// shared/foundations-init.js takes NO imports (the same contract shared/text.js
// carries), so the real module runs in Node and is imported rather than
// stubbed. That is what makes S6's assertions about the create BODY real: the
// object that crosses the wire is built by `chooserBody`, and a stub here would
// let this suite assert a shape the browser never sends.
const {
  freshChooser, chooserBody, chooserOutcomeWords, renderFoundationsChooser,
  bindFoundationsChooser, renderRefusedList, SKELETON_SLUGS,
} = await import('../src/public/next/shared/foundations-init.js');

let sandbox;
try {
  sandbox = new Function(
    'composeAgentInstructions', 'COPY_SUCCESS_BANNER',
    'freshChooser', 'chooserBody', 'chooserOutcomeWords', 'renderFoundationsChooser',
    'bindFoundationsChooser', 'renderRefusedList', 'SKELETON_SLUGS', 'infoMark2',
    PREAMBLE +
    extractConst(SRC, 'PROJECT_BRIEF_TEMPLATE') + '\n' +
    extractConst(SRC, 'GIT_UNDO_WARN') + '\n' +
    // The three ⓘ texts. LIFTED, never re-typed: S12b asserts the words a
    // user reads, and a copy here would assert a copy.
    extractConst(SRC, 'MARKER_INFO_TEXT') + '\n' +
    extractConst(SRC, 'AGENT_INFO_TEXT') + '\n' +
    extractConst(SRC, 'PROJECTS_INFO_HTML') + '\n' +
    // v3.61.0 — the documents field's own ⓘ. LIFTED for the same reason the
    // three above are: S5b asserts the words a user reads about where a
    // project's canonical documents come from, and a copy here would assert a
    // copy. It is the one place the "a plain folder works as a mirror source"
    // fact is stated in the app.
    extractConst(SRC, 'FOUNDATIONS_INFO_HTML') + '\n' +
    FNS.map((n) => extractFunction(SRC, n)).join('\n\n') + '\n' +
    `return { ${FNS.join(', ')}, PROJECT_BRIEF_TEMPLATE,
       MARKER_INFO_TEXT, AGENT_INFO_TEXT, PROJECTS_INFO_HTML, FOUNDATIONS_INFO_HTML,
       __state: () => state, __setState: (s) => { state = s; },
       __calls: () => calls,
       __reset: () => { calls.render = 0; calls.fetch.length = 0; calls.gates.length = 0;
         calls.clipboard.length = 0; calls.asyncFailures = 0; calls.revealed.length = 0; },
       __setFetch: (fn) => { fetchResponder = fn; },
       __setDocument: (d) => { document = d; },
       __setRenderImpl: (fn) => { renderImpl = fn; },
       __setClipboard: (v) => { clipboardOk = v; },
       __setMounted: (v) => { mounted = v; } };`
  )(composeAgentInstructions, COPY_SUCCESS_BANNER,
    freshChooser, chooserBody, chooserOutcomeWords, renderFoundationsChooser,
    bindFoundationsChooser, renderRefusedList, SKELETON_SLUGS, null);
} catch (err) {
  console.log('FATAL: could not build the sandbox from domains.js -- ' + err.message);
  process.exit(1);
}

const {
  activeProjects, loadProjects, renderProjectRow, renderProjectsPanel,
  renderProjectLifecycleCard, openProjectLifecycle, closeProjectLifecycle,
  classifyProjectError, runProjectAction, copyProjectMarker, bindProjectListeners,
  copyProjectAgentInstructions, renderCopyOutcome, projInfoId, infoMark,
  foundationsField,
  PROJECT_BRIEF_TEMPLATE, MARKER_INFO_TEXT, AGENT_INFO_TEXT, PROJECTS_INFO_HTML,
  FOUNDATIONS_INFO_HTML,
  __state, __setState, __calls, __reset, __setFetch, __setClipboard, __setMounted,
  __setDocument, __setRenderImpl,
} = sandbox;

const ROW = (over) => ({
  domain: 'alpha', project: 'lumina', isDefaultProject: false, hasBrief: true,
  lastWriteAt: '2026-09-06T12:00:00.000Z', writtenAt: '2026-09-06T12:00:00.000Z',
  newestScope: 'main', ...over,
});

function freshState(over) {
  return {
    activeSlug: 'alpha',
    projects: { slug: 'alpha', loading: false, error: null, rows: [ROW()], truncated: false, canWrite: true, readonly: false },
    projectLc: null,
    copied: null,
    banner: null,
    ...over,
  };
}

// ═════════════════════════════════════════════════════════════════════════
section('S1 -- The list is SLUG-STAMPED (layer 2 of the domain-scoping guard)');
// ═════════════════════════════════════════════════════════════════════════
//
// `state` in this view is module-scoped and survives leaving the view, so an
// unstamped list can be rendered under a DIFFERENT domain's heading. This one
// carries a Delete button, so the consequence is not cosmetic.

{
  __setState(freshState());
  ok('a matching stamp is readable', activeProjects() !== null);
  __setState(freshState({ activeSlug: 'beta' }));
  eq('a list loaded for ANOTHER domain is refused, not rendered under this one', activeProjects(), null);
  __setState(freshState({ projects: null }));
  eq('nothing loaded reads as null, never as an empty list', activeProjects(), null);
  __setState(freshState({ activeSlug: null }));
  eq('no active domain reads as null', activeProjects(), null);
}

// ═════════════════════════════════════════════════════════════════════════
section('S2 -- loadProjects');
// ═════════════════════════════════════════════════════════════════════════

{
  __setState(freshState({ projects: null }));
  __reset();
  __setFetch(() => ({ ok: true, projects: [ROW(), ROW({ project: 'two' })], truncated: true, canWrite: true, readonly: false }));
  await loadProjects('alpha', 1);
  const st = __state();
  eq('the list endpoint is asked for exactly this domain', __calls().fetch[0].url, '/api/memory/alpha/projects');
  ok('...as a plain GET, with no request init at all', __calls().fetch[0].opts === undefined);
  eq('the rows land', st.projects.rows.length, 2);
  eq('...stamped with the domain they were loaded for', st.projects.slug, 'alpha');
  eq('...carrying the server truncation flag', st.projects.truncated, true);
  eq('...and the server capability, not a guess', st.projects.canWrite, true);
  ok('the pane painted twice: the skeleton, then the result', __calls().render >= 2);
}
{
  // A FAILED LOAD IS A STATE, NOT A BLANK. The section still renders, saying
  // what went wrong -- a section that vanishes on failure is indistinguishable
  // from a domain with no projects.
  __setState(freshState({ projects: null }));
  __setFetch(() => ({ throwStatus: 500, message: 'the disk went away' }));
  await loadProjects('alpha', 1);
  eq('a failure is recorded as an error, not as an empty list', __state().projects.error, 'the disk went away');
  eq('...and never as rows', __state().projects.rows.length, 0);
  eq('...and never as a write capability', __state().projects.canWrite, false);
}
{
  // A RESPONSE THAT LANDS AFTER THE USER SWITCHED DOMAIN IS DROPPED.
  //
  // ASSERTED ON `loading`, AND THAT IS THE WHOLE ASSERTION. The first draft
  // checked `state.projects.slug !== 'beta'` -- which is TRUE either way,
  // because the write it was trying to catch stamps the row with the slug the
  // load was STARTED for. The mutation that removes the slug half of the
  // post-await guard survived it, fully green. What actually distinguishes
  // the two is whether the loading placeholder loadProjects set at entry was
  // REPLACED: with the guard it is untouched, without it the stale rows land.
  __setState(freshState({ projects: null }));
  __setFetch(() => { __state().activeSlug = 'beta'; return { ok: true, projects: [ROW()] }; });
  await loadProjects('alpha', 1);
  ok('a reply for the previous domain leaves the pane exactly as it was',
    __state().projects && __state().projects.loading === true,
    JSON.stringify(__state().projects));
  ok('...so the previous domain rows never land', !__state().projects.rows.length);
}
{
  // THE SAME, ON THE FAILURE PATH. An error message is a write too, and one
  // belonging to a domain nobody is looking at any more.
  __setState(freshState({ projects: null }));
  __setFetch(() => { __state().activeSlug = 'beta'; return { throwStatus: 500, message: 'stale error' }; });
  await loadProjects('alpha', 1);
  ok('a FAILURE for the previous domain does not paint its error under the new one',
    __state().projects && __state().projects.loading === true && __state().projects.error === null,
    JSON.stringify(__state().projects));
}
{
  // ...and so is a reply that lands after the view was unmounted.
  __setState(freshState({ projects: null }));
  __setMounted(false);
  __setFetch(() => ({ ok: true, projects: [ROW()] }));
  await loadProjects('alpha', 1);
  ok('a reply that lands after a teardown is not applied',
    __state().projects && __state().projects.loading === true,
    JSON.stringify(__state().projects));
  __setMounted(true);
}
{
  // A MALFORMED BODY DEGRADES, never throws: this endpoint's shape is a
  // contract with a server that may be older than this view.
  __setState(freshState({ projects: null }));
  __setFetch(() => ({ ok: true }));
  await loadProjects('alpha', 1);
  eq('a body with no projects array reads as no projects', __state().projects.rows.length, 0);
  eq('...and not as an error', __state().projects.error, null);
}

// ═════════════════════════════════════════════════════════════════════════
section('S3 -- The row: what it says, and what it never says');
// ═════════════════════════════════════════════════════════════════════════

{
  const html = renderProjectRow(ROW(), true);
  ok('the project name is on the row', html.includes('lumina'));
  // THE PILL IS A PLAIN WORD stating the FACT, never a status vocabulary.
  ok('a project with a brief wears a plain-word pill', html.includes('Standing brief'));
  ok('...and never a status vocabulary',
    !/configured|not set|active\b|enabled/i.test(html), html);
  ok('the newest work-stream is named in the words the model uses',
    html.includes('newest work-stream main') && !/\bscope\b/.test(html), html);
  ok('the last save is an age, through the shared formatter',
    html.includes('REL(2026-09-06T12:00:00.000Z)'));

  const none = renderProjectRow(ROW({ hasBrief: false, lastWriteAt: null, writtenAt: null, newestScope: null }), true);
  ok('a project with no brief says so in plain words', none.includes('No brief yet'));
  // A FACT AND ITS ABSENCE STAY DISTINGUISHABLE. "no saves yet" is a real
  // answer; rendering it as an age would be a confident lie.
  ok('a project with nothing saved says "no saves yet", never an age',
    none.includes('no saves yet') && !none.includes('REL('), none);

  // THE AGENT'S CLOCK WINS WHERE THERE IS ONE. `lastWriteAt` is mtime, which
  // git rewrites on checkout, so a project synced from another machine would
  // otherwise date to the moment of the pull.
  const synced = renderProjectRow(ROW({ lastWriteAt: '2026-09-07T00:00:00.000Z', writtenAt: '2026-09-01T00:00:00.000Z' }), true);
  ok('the agent own clock is preferred over the file timestamp',
    synced.includes('REL(2026-09-01T00:00:00.000Z)'), synced);

  // THE DOMAIN'S OWN PROJECT. `isDefaultProject` is the STORE's own field name
  // (the router's contract called it `isLegacyDefault`, which asserted a
  // migration that does not exist — the state root is where a domain's own
  // project lives permanently).
  const own = renderProjectRow(ROW({ isDefaultProject: true }), true);
  ok('the domain own project is marked as such', own.includes('own project'), own);
  // It can be neither renamed nor deleted -- the store refuses both by name --
  // so the row must not offer either control even on a WRITABLE domain, and
  // must say why rather than leaving a gap.
  ok('...and offers neither Rename nor Delete, even though the domain is writable',
    !own.includes('data-proj-rename') && !own.includes('data-proj-delete'), own);
  ok('...and says why the two controls are absent',
    own.includes('cannot be renamed or deleted'), own);
  ok('...while the marker line is still copyable', own.includes('data-proj-marker'));
  // CONTROL: the same row without the flag DOES offer them, so the assertion
  // above is about the flag and not about the row shape.
  ok('CONTROL: a named project on the same domain still offers both',
    renderProjectRow(ROW({ isDefaultProject: false }), true).includes('data-proj-rename'));
}
{
  const writable = renderProjectRow(ROW(), true);
  const readonly = renderProjectRow(ROW(), false);
  ok('a writable row offers Rename and Delete',
    writable.includes('data-proj-rename') && writable.includes('data-proj-delete'));
  ok('a NON-writable row offers neither -- a control whose only outcome is a refusal is worse than none',
    !readonly.includes('data-proj-rename') && !readonly.includes('data-proj-delete'));
  ok('...but the marker line is still copyable, because reading is not writing',
    readonly.includes('data-proj-marker'));
}
{
  // ESCAPING. The click handlers read the project name back OUT of these
  // attributes, so a name that escapes one is a name that runs as markup.
  const XSS = '<img src=x onerror=alert(1)>';
  const ATTR = '" onmouseover="alert(1)';
  const a = renderProjectRow(ROW({ project: XSS }), true);
  ok('a hostile project name is escaped in the row text', !a.includes('<img src=x'));
  const b = renderProjectRow(ROW({ project: ATTR }), true);
  ok('...and cannot break out of the data attribute the handler reads it from',
    !/data-proj-delete="[^"]*"\s+onmouseover/.test(b), b);
  const c = renderProjectRow(ROW({ newestScope: XSS }), true);
  ok('a hostile work-stream name is escaped too', !c.includes('<img src=x'));
}

// ═════════════════════════════════════════════════════════════════════════
section('S4 -- The panel renders SOMETHING in every state');
// ═════════════════════════════════════════════════════════════════════════

{
  __setState(freshState({ projects: { slug: 'alpha', loading: true, rows: [], canWrite: false, readonly: false } }));
  const loading = renderProjectsPanel(false);
  ok('LOADING renders a shape-matched skeleton, not the word "Loading"',
    loading.includes('cur-skeleton') && !/Loading/.test(loading));
  ok('...inside the inset grouped list, so the section keeps its shape',
    loading.includes('cur-group'));

  __setState(freshState({ projects: { slug: 'alpha', loading: false, error: 'EACCES', rows: [], canWrite: false, readonly: false } }));
  ok('FAILED says what went wrong rather than vanishing',
    renderProjectsPanel(false).includes('EACCES'));

  __setState(freshState({ projects: { slug: 'alpha', loading: false, error: null, rows: [], canWrite: true, readonly: false } }));
  const empty = renderProjectsPanel(false);
  ok('EMPTY explains what a project is instead of showing an empty box',
    empty.includes('No projects yet') && /agents keep their/i.test(empty));
  ok('...and still offers the create control', empty.includes('dm-proj-new-btn'));

  __setState(freshState({ projects: { slug: 'alpha', loading: false, error: null, rows: [ROW()], truncated: false, canWrite: false, readonly: true } }));
  const mirror = renderProjectsPanel(true);
  ok('a READ-ONLY MIRROR says why it offers no controls', /read-only Shared Brain mirror/i.test(mirror));
  ok('...and really offers none', !mirror.includes('dm-proj-new-btn'));

  __setState(freshState({ projects: { slug: 'alpha', loading: false, error: null, rows: [ROW()], truncated: false, canWrite: false, readonly: false } }));
  const old = renderProjectsPanel(false);
  ok('a server too OLD to write projects says so, rather than showing dead buttons',
    /Update The Curator/i.test(old) && !old.includes('dm-proj-new-btn'));

  __setState(freshState({ projects: { slug: 'alpha', loading: false, error: null, rows: [ROW()], truncated: true, canWrite: true, readonly: false } }));
  const trunc = renderProjectsPanel(false);
  ok('TRUNCATION is stated, and says the rest is still readable by agents',
    /Showing the newest/.test(trunc) && /still readable by your agents/.test(trunc));
}
{
  // THE SECTION IS PRESENT EVEN WHEN THE STAMP IS STALE -- it renders the
  // loading shape rather than another domain's projects.
  __setState(freshState({ activeSlug: 'beta' }));
  const stale = renderProjectsPanel(false);
  ok('a stale stamp renders the skeleton, never the other domain rows',
    stale.includes('cur-skeleton') && !stale.includes('lumina'), stale.slice(0, 200));
}

// ═════════════════════════════════════════════════════════════════════════
section('S5 -- The lifecycle card, and the typed delete confirmation');
// ═════════════════════════════════════════════════════════════════════════

{
  __setState(freshState());
  eq('no form renders nothing at all', renderProjectLifecycleCard(), '');

  openProjectLifecycle('create');
  const create = renderProjectLifecycleCard();
  ok('CREATE offers a name and a brief', create.includes('dm-proj-name') && create.includes('dm-proj-brief'));
  ok('...seeded with the starting template', create.includes('Firm decisions'));
  ok('...whose four headings are the ones the store renders',
    ['## Standing brief', '## Firm decisions', '## Working model', '## Pointers to depth']
      .every((h) => PROJECT_BRIEF_TEMPLATE.includes(h)), PROJECT_BRIEF_TEMPLATE);
  ok('...and which says out loud that more headings are fine',
    /not a schema/i.test(PROJECT_BRIEF_TEMPLATE), PROJECT_BRIEF_TEMPLATE);
  ok('...and says the brief is optional', /optional/i.test(create));
  ok('...and says saving REPLACES rather than adds', /replaces the whole document/i.test(create));

  openProjectLifecycle('rename', 'lumina');
  const rename = renderProjectLifecycleCard();
  ok('RENAME is pre-filled with the current name', rename.includes('value="lumina"'));
  ok('...and warns that a marker file has to be updated by hand',
    /\.curator-project/.test(rename));
  ok('RENAME does NOT restate the documents question — the store sets an ownership ONCE, '
    + 'so the question has exactly one right moment and a rename is not it',
  !rename.includes('data-fnd-init='), rename.slice(0, 300));
  openProjectLifecycle('delete', 'lumina');
  ok('...and neither does DELETE', !renderProjectLifecycleCard().includes('data-fnd-init='));
}

// ═════════════════════════════════════════════════════════════════════════
section('S5b -- WHERE THE PROJECT\'S CANONICAL DOCUMENTS COME FROM (v3.61.0)');
// ═════════════════════════════════════════════════════════════════════════
//
// The create form asks the question tier 0 can only be asked once: does The
// Curator keep these documents, or are they mirrored from a folder on this
// computer? Driven through the SHIPPED `foundationsField` and the SHIPPED
// shared chooser, so what is asserted here is what a person sees.
{
  __setState(freshState());
  openProjectLifecycle('create');
  const create = renderProjectLifecycleCard();

  ok('CREATE asks where the documents live', create.includes('data-fnd-init="dm-proj-fnd"'),
    create.slice(0, 400));
  ok('...with both answers on screen at once rather than in a dropdown — you want to '
    + 'read both halves before deciding',
  create.includes('data-fnd-own="curator"') && create.includes('data-fnd-own="repo"'));
  ok('...plus "decide later", which only makes sense HERE: the Foundations block in '
    + 'Agent memory IS the later', create.includes('data-fnd-own="later"'));
  ok('...defaulting to the answer that works with no preconditions',
    /data-fnd-own="curator" aria-pressed="true"/.test(create), create.slice(0, 1400));
  ok('...BELOW the brief, because the brief is what YOU tell an agent and these are what '
    + 'the PROJECT tells it',
  create.indexOf('dm-proj-brief') < create.indexOf('data-fnd-init='));

  // THE LEDE IS AN INSTRUCTION AT EIGHT VISIBLE WORDS. The definition of a
  // canonical document, the mechanism of a mirror and the fact that the answer
  // is set once are all behind the ⓘ — the design system's §3 rule.
  {
    const lede = /<p class="tx-desc">([^<]*)<\/p>/.exec(create.slice(create.indexOf('dm-proj-fnd-head')));
    ok('the documents field carries a lede at all', !!lede, create.slice(0, 200));
    const words = lede ? lede[1].trim().split(/\s+/).filter(Boolean).length : 99;
    ok('...of 13 visible words or fewer (design-system §3)', words <= 13,
      words + ' words: ' + (lede ? lede[1] : ''));
    ok('...and it is an INSTRUCTION, never a definition',
      lede && !/is a |are the |means /.test(lede[1]), lede ? lede[1] : '');
  }
  ok('the field carries an ⓘ mark', create.includes('dm-proj-fnd-info'), create.slice(0, 600));
  ok('...whose panel ships CLOSED', /id="dm-proj-fnd-info"[^>]*hidden/.test(create), create.slice(0, 2000));

  // WHAT THE ⓘ HAS TO CARRY. Each of these is a DEFINITION or a MECHANISM,
  // which is what puts it behind the mark rather than in the lede — and the
  // last one is the answer to "will this work on my project?", which is the
  // question a person with a plain folder and no git actually has.
  ok('the ⓘ defines what a canonical document is', /architecture, the decisions/i.test(FOUNDATIONS_INFO_HTML));
  ok('...says a mirror is a BYTE copy with a recorded commit and a compared checksum',
    /byte-for-byte/i.test(FOUNDATIONS_INFO_HTML) && /checksum/i.test(FOUNDATIONS_INFO_HTML));
  ok('...says a plain folder with no version control works as a source, and that the source '
    + 'line then shows no commit (D21)',
  /NOT have to be a git repository/i.test(FOUNDATIONS_INFO_HTML)
    && /no commit beside it/i.test(FOUNDATIONS_INFO_HTML), FOUNDATIONS_INFO_HTML.slice(0, 400));
  ok('...says what a SKELETON is — a prompt, not prose', /prompts instead of prose/i.test(FOUNDATIONS_INFO_HTML));
  ok('...says nothing is uploaded when a file is chosen from disk',
    /Nothing is uploaded/i.test(FOUNDATIONS_INFO_HTML));
  ok('...and says the answer is given ONCE, which is the fact that makes the timing matter',
    /answered once/i.test(FOUNDATIONS_INFO_HTML) && /refuses a change/i.test(FOUNDATIONS_INFO_HTML));
  ok('the ⓘ is the ONLY place any of that is said — the card body carries no second copy',
    !/byte-for-byte/i.test(create.replace(FOUNDATIONS_INFO_HTML, '')),
    'a definition escaped the fold');

  // THE MIRROR ARM: a path, a scan, and a way to name a file the scan missed.
  __state().projectLc.foundations.ownership = 'repo';
  const mirror = renderProjectLifecycleCard();
  ok('the mirror arm asks for a repository root', mirror.includes('id="dm-proj-fnd-root"'));
  ok('...with the scan DISABLED until a path is typed — a control that cannot work is worse '
    + 'than no control', /id="dm-proj-fnd-scan"[^>]* disabled/.test(mirror), mirror.slice(0, 2400));
  ok('...and a typed path for a file the scan missed (D21)',
    mirror.includes('id="dm-proj-fnd-extra"'), mirror.slice(0, 3000));
  ok('...with the seven roles as option buttons, never a native <select> (v3.18.0 purged those)',
    /data-fnd-extra-role="architecture"/.test(mirror) && !/<select/.test(mirror));

  __state().projectLc.foundations.repoRoot = '/Users/x/code/proj';
  ok('a typed path ARMS the scan', !/id="dm-proj-fnd-scan"[^>]* disabled/
    .test(renderProjectLifecycleCard()));

  // THE SCAN'S CANDIDATES, with the document's own first heading beside the
  // path (D21) and a refused row that says why.
  __state().projectLc.foundations.candidates = [
    { path: 'docs/architecture.md', bytes: 4096, suggestedRole: 'architecture',
      firstHeading: 'How the pieces fit' },
    { path: 'docs/huge.md', bytes: 900000, suggestedRole: 'other', tooLarge: true },
  ];
  __state().projectLc.foundations.picks = { 'docs/architecture.md': true };
  const scanned = renderProjectLifecycleCard();
  ok('a candidate row shows the path', scanned.includes('docs/architecture.md'));
  ok('...and the document\'s OWN first heading beside it, which is what distinguishes '
    + '01-intro.md from 02-arch.md', scanned.includes('How the pieces fit'), scanned.slice(0, 200));
  ok('...and its suggested role', /data-fnd-role-open="docs\/architecture\.md"/.test(scanned));
  ok('a file over the per-document cap is DISABLED with the reason on its own row, '
    + 'never silently dropped',
  /data-fnd-cand="docs\/huge\.md"[^>]* disabled/.test(scanned)
    && /per-document cap/.test(scanned), scanned.slice(0, 200));

  // THE CURATOR ARM: the seed tick and the optional files from disk (D18).
  __state().projectLc.foundations.ownership = 'curator';
  const cur = renderProjectLifecycleCard();
  ok('the curator arm offers the four skeletons, ticked',
    /id="dm-proj-fnd-seed"[^>]* checked/.test(cur), cur.slice(0, 2400));
  ok('...naming all four so the owner knows what lands',
    /Architecture, Decisions, Conventions, Roadmap/.test(cur));
  ok('...and a MULTI file picker wearing the kit\'s button, never a native file control',
    /class="btn btn-secondary btn-xs fnd-init-file"/.test(cur)
    && /id="dm-proj-fnd-files"[^>]*multiple/.test(cur), cur.slice(0, 2600));
  ok('...with the input visually hidden rather than styled, because a native file button '
    + 'cannot be styled at all', /id="dm-proj-fnd-files"/.test(cur)
    && /class="visually-hidden" id="dm-proj-fnd-files"/.test(cur));
  ok('...and it says out loud that nothing is uploaded until the project is created',
    /nothing is uploaded until you create the project/i.test(cur));
}
{
  // THE TYPED CONFIRMATION. The route enforces it independently, so this is
  // not the only thing standing between a click and the loss -- but a button
  // that is live before the box matches is a button people click.
  __setState(freshState());
  openProjectLifecycle('delete', 'lumina');
  const f = __state().projectLc;

  const empty = renderProjectLifecycleCard();
  ok('the delete button starts DISABLED', /id="dm-proj-submit" disabled/.test(empty), empty);
  ok('...and the card says what is destroyed, in the model words',
    /work-stream handoff/.test(empty) && /journal/.test(empty));
  ok('...and that the wiki is NOT touched', /wiki in this domain is NOT touched/i.test(empty));
  ok('...and that there is no in-app undo', /no Undo button/i.test(empty));

  f.confirmText = 'lumin';
  ok('a PREFIX does not arm it', /id="dm-proj-submit" disabled/.test(renderProjectLifecycleCard()));
  f.confirmText = 'LUMINA';
  ok('a case-different name does not arm it', /id="dm-proj-submit" disabled/.test(renderProjectLifecycleCard()));
  f.confirmText = ' lumina ';
  ok('a padded name does not arm it', /id="dm-proj-submit" disabled/.test(renderProjectLifecycleCard()));
  f.confirmText = 'lumina';
  ok('an EXACT match arms it', !/id="dm-proj-submit" disabled/.test(renderProjectLifecycleCard()));
}
{
  __setState(freshState());
  openProjectLifecycle('delete', '<img src=x onerror=alert(1)>');
  ok('a hostile project name is escaped in the confirmation card',
    !renderProjectLifecycleCard().includes('<img src=x'));
}
{
  __setState(freshState());
  openProjectLifecycle('create');
  __state().projectLc.busy = true;
  const busy = renderProjectLifecycleCard();
  ok('while busy, every control is disabled', (busy.match(/ disabled/g) || []).length >= 4, busy);
  __state().projectLc.busy = false;
  __state().projectLc.refusal = 'that name is reserved';
  ok('a REFUSAL is rendered as the server refusing, not as a crash',
    renderProjectLifecycleCard().includes('dm-lc-refusal'));
  __state().projectLc.refusal = null;
  __state().projectLc.error = 'network down';
  ok('an ERROR is rendered in the error style', renderProjectLifecycleCard().includes('dm-lc-error'));
}
{
  __setState(freshState());
  openProjectLifecycle('rename', 'lumina');
  eq('the form carries the domain it was opened on', __state().projectLc.slug, 'alpha');
  closeProjectLifecycle();
  eq('closing drops it entirely', __state().projectLc, null);
}

// ═════════════════════════════════════════════════════════════════════════
section('S6 -- The actions: what the view actually sends');
// ═════════════════════════════════════════════════════════════════════════

{
  __setState(freshState());
  __reset();
  openProjectLifecycle('create');
  __state().projectLc.name = 'newthing';
  __state().projectLc.brief = '## Standing brief\n\nhello';
  __setFetch(() => ({ ok: true }));
  await runProjectAction();
  const req = __calls().fetch.find((c) => c.opts);
  eq('create POSTs to the projects endpoint', req.url, '/api/memory/alpha/projects');
  eq('...as a POST', req.opts.method, 'POST');
  eq('...carrying the name', JSON.parse(req.opts.body).project, 'newthing');
  eq('...and the brief', JSON.parse(req.opts.body).brief, '## Standing brief\n\nhello');
  eq('the form closes on success', __state().projectLc, null);
  ok('...a banner names what happened', /Created project/.test(__state().banner.text));
  ok('...and the list is RE-READ rather than patched in place',
    __calls().fetch.some((c) => !c.opts && c.url === '/api/memory/alpha/projects'));
  ok('the shell-wide write gate was taken and released',
    __calls().gates.length === 1 && __calls().gates[0].released === true);
}
{
  // ── THE CREATE BODY, FIELD BY FIELD, WITH THE DOCUMENTS CHOICE ─────────
  //
  // `foundations` rides with the create rather than going in a second request,
  // because a project whose brief was written and whose ownership was not is a
  // half-made project the user has to finish somewhere else. The route answers
  // `ok: true` with `foundationsError` if tier 0 fails AFTER the brief lands —
  // never a 5xx and never a rollback.
  __setState(freshState());
  __reset();
  openProjectLifecycle('create');
  __state().projectLc.name = 'curated';
  __setFetch(() => ({ ok: true, seeded: ['architecture.md', 'decisions.md', 'conventions.md', 'roadmap.md'] }));
  await runProjectAction();
  {
    const body = JSON.parse(__calls().fetch.find((c) => c.opts).opts.body);
    // READ THROUGH A GUARD. A mutation that drops the `foundations` key entirely must RED on
    // the first assertion rather than crashing on a property of undefined — a crash reads
    // like a pass in a summary line, which is the v3.11.0 shape this repo has recorded twice.
    const fnd = body.foundations || {};
    eq('the default arm sends the CURATOR ownership', fnd.ownership, 'curator');
    ok('...and NOT a seed flag, because true is the server\'s own default and re-stating '
      + 'a default is one more thing to disagree about',
    'foundations' in body && !('seed' in fnd), JSON.stringify(body.foundations));
    ok('...and no repoRoot, which the route refuses on the curator arm',
      'foundations' in body && !('repoRoot' in fnd));
    ok('the banner reports what the SERVER did, not what was asked',
      /4 skeletons seeded/.test(String((__state().banner || {}).text)),
      String((__state().banner || {}).text));
  }
}
{
  // UNTICKING THE SEED IS THE ONE THING THAT TRAVELS, because it is the one
  // departure from the server's default.
  __setState(freshState());
  __reset();
  openProjectLifecycle('create');
  __state().projectLc.name = 'bare';
  __state().projectLc.foundations.seed = false;
  __setFetch(() => ({ ok: true, seeded: [] }));
  await runProjectAction();
  const body = JSON.parse(__calls().fetch.find((c) => c.opts).opts.body);
  eq('seed: false crosses', (body.foundations || {}).seed, false);
}
{
  // THE MIRROR ARM: the root, trimmed, and the ticked files with their roles.
  __setState(freshState());
  __reset();
  openProjectLifecycle('create');
  const f = __state().projectLc;
  f.name = 'mirrored';
  f.foundations.ownership = 'repo';
  f.foundations.repoRoot = '  /Users/x/code/proj  ';
  f.foundations.candidates = [
    { path: 'docs/architecture.md', bytes: 10, suggestedRole: 'architecture' },
    { path: 'docs/style.md', bytes: 10, suggestedRole: 'conventions' },
    { path: 'docs/huge.md', bytes: 900000, suggestedRole: 'other', tooLarge: true },
  ];
  f.foundations.picks = { 'docs/architecture.md': true, 'docs/huge.md': true };
  f.foundations.roles = { 'docs/architecture.md': 'guide' };
  // D21: a path the scan never found, typed by hand, with its own role.
  f.foundations.extras = [{ path: './notes/decisions.md', role: 'decisions' }];
  __setFetch(() => ({ ok: true, refresh: { added: ['architecture.md', 'decisions.md'], refreshed: [], missing: [], refused: [] } }));
  await runProjectAction();
  const body = JSON.parse(__calls().fetch.find((c) => c.opts).opts.body);
  eq('the mirror arm sends the REPO ownership', (body.foundations || {}).ownership, 'repo');
  eq('...the root, trimmed', (body.foundations || {}).repoRoot, '/Users/x/code/proj');
  eq('...the ticked files with the role the user chose over the one the scan suggested, '
    + 'PLUS the path typed by hand — and NOT the one over the per-document cap',
  JSON.stringify((body.foundations || {}).files),
  JSON.stringify([{ path: 'docs/architecture.md', role: 'guide' },
    { path: 'notes/decisions.md', role: 'decisions' }]));
  ok('the banner reports the mirror',
    /2 documents mirrored/.test(String((__state().banner || {}).text)),
    String((__state().banner || {}).text));
}
{
  // DECIDE LATER SENDS NO KEY AT ALL, not `{ownership: 'later'}`: the route's
  // body is an allow-list and "later" is a fourth ownership the store has
  // never heard of. A project with no manifest is exactly the state the
  // Agent-memory chooser exists to resolve.
  __setState(freshState());
  __reset();
  openProjectLifecycle('create');
  __state().projectLc.name = 'undecided';
  __state().projectLc.foundations.ownership = 'later';
  __setFetch(() => ({ ok: true }));
  await runProjectAction();
  const body = JSON.parse(__calls().fetch.find((c) => c.opts).opts.body);
  ok('"decide later" sends no `foundations` key whatsoever', !('foundations' in body),
    JSON.stringify(body));
  eq('...and the banner says so rather than claiming something was set up',
    /decide later/.test(String((__state().banner || {}).text)), true);
}
{
  // A TIER-0 FAILURE IS DISCLOSED ON ITS OWN LINE, never appended to the
  // success sentence and never folded (v3.16.1): the project exists, its brief
  // is written, and the documents were not set up.
  __setState(freshState());
  __reset();
  openProjectLifecycle('create');
  __state().projectLc.name = 'partly';
  __setFetch(() => ({ ok: true, seeded: [],
    foundationsError: { reason: 'repo-unreachable', message: 'that folder is not on this computer' } }));
  await runProjectAction();
  ok('the create still SUCCEEDS — the form closes and the project exists',
    __state().projectLc === null);
  ok('...the banner drops out of the success tone', (__state().banner || {}).tone === 'info',
    String((__state().banner || {}).tone));
  {
    const d = String((__state().banner || {}).detail);
    ok('...and carries the reason on a SECOND line rather than in the sentence',
      /not set up/.test(d) && /not on this computer/.test(d), d);
    ok('...naming where to finish the job', /Agent memory/.test(d));
  }
}
{
  // ── FILES FROM DISK: ONE PUT EACH, AFTER THE CREATE (D18) ──────────────
  __setState(freshState());
  __reset();
  openProjectLifecycle('create');
  const f = __state().projectLc;
  f.name = 'imported';
  f.foundations.imports = [
    { name: 'Architecture.md', size: 20, slug: 'architecture.md', role: 'architecture',
      title: 'Architecture', text: '# Architecture\n\nreal words', error: null },
    { name: 'notes.md', size: 10, slug: 'notes.md', role: 'other', title: 'Notes',
      text: 'stuff', error: null },
    // A refused entry is carried in the list so the owner can see it, and it
    // must never be PUT.
    { name: 'giant.md', size: 900000, slug: 'giant.md', role: 'other', title: 'Giant',
      text: '', error: 'is 879 KB, over the 512 KB per-document cap — not read' },
  ];
  __setFetch((url, opts) => (opts && opts.method === 'PUT' ? { ok: true } : { ok: true, seeded: ['architecture.md', 'decisions.md', 'conventions.md', 'roadmap.md'] }));
  await runProjectAction();
  const puts = __calls().fetch.filter((c) => c.opts && c.opts.method === 'PUT');
  eq('each usable file becomes ONE PUT', puts.length, 2);
  const put0 = puts[0] ? JSON.parse(puts[0].opts.body) : {};
  ok('...at its own slug under the new project',
    !!puts[0] && puts[0].url === '/api/memory/alpha/imported/foundations/architecture.md',
    puts[0] ? puts[0].url : '<no PUT>');
  eq('...carrying the text byte for byte', put0.text, '# Architecture\n\nreal words');
  eq('...the title derived from the document\'s own first heading', put0.title, 'Architecture');
  eq('...and the role derived from the file name', put0.role, 'architecture');
  ok('a file that was REFUSED before it was read is never PUT',
    !puts.some((p) => p.url.includes('giant.md')), JSON.stringify(puts.map((p) => p.url)));
  ok('the PUTs come AFTER the create, because they are documents IN a project that has to exist',
    __calls().fetch.findIndex((c) => c.opts && c.opts.method === 'POST')
      < __calls().fetch.findIndex((c) => c.opts && c.opts.method === 'PUT'));
  ok('the banner reports the import',
    /2 documents imported/.test(String((__state().banner || {}).text)),
    String((__state().banner || {}).text));
  // AN IMPORT THAT LANDS ON A SEEDED SLUG REPLACES THE SEED, and the banner
  // says which — otherwise the owner is left to work out which of the two won.
  ok('...and says which skeleton an import replaced',
    /1 skeleton replaced by an imported file \(architecture\.md\)/
      .test(String((__state().banner || {}).text)),
    String((__state().banner || {}).text));
}
{
  // A FAILED IMPORT NEVER FAILS THE CREATE. The project exists and its brief is
  // written; a document that did not land is reported by name on the second
  // line, and the owner can add it again from Agent memory. Refusing the whole
  // outcome for it would be v3.32.0's shape one level up.
  __setState(freshState());
  __reset();
  openProjectLifecycle('create');
  const f = __state().projectLc;
  f.name = 'halfway';
  f.foundations.imports = [
    { name: 'a.md', size: 10, slug: 'a.md', role: 'other', title: 'A', text: 'x', error: null },
  ];
  __setFetch((url, opts) => (opts && opts.method === 'PUT'
    ? { throwStatus: 400, message: 'no_manifest' }
    : { ok: true, seeded: [] }));
  await runProjectAction();
  ok('the create still succeeded', __state().projectLc === null && !!__state().banner);
  {
    const d = String((__state().banner || {}).detail);
    ok('...and the failed document is named on the second line',
      /a\.md/.test(d) && /could not be saved/.test(d), d);
  }
}
{
  // AN EMPTY BRIEF IS SENT AS ABSENT, not as an empty string: an empty string
  // is a brief the user wrote nothing in, and the store would create the file.
  __setState(freshState());
  __reset();
  openProjectLifecycle('create');
  __state().projectLc.name = 'nobrief';
  __state().projectLc.brief = '   \n  ';
  __setFetch(() => ({ ok: true }));
  await runProjectAction();
  const body = JSON.parse(__calls().fetch.find((c) => c.opts).opts.body);
  ok('a whitespace-only brief is sent as no brief at all', !('brief' in body), JSON.stringify(body));
}
{
  __setState(freshState());
  __reset();
  openProjectLifecycle('rename', 'lumina');
  __state().projectLc.name = 'lumina-2';
  __setFetch(() => ({ ok: true }));
  await runProjectAction();
  const req = __calls().fetch.find((c) => c.opts);
  eq('rename PATCHes the project endpoint', req.url, '/api/memory/alpha/projects/lumina');
  eq('...as a PATCH', req.opts.method, 'PATCH');
  eq('...carrying only the new name', JSON.stringify(JSON.parse(req.opts.body)), '{"rename":"lumina-2"}');
}
{
  __setState(freshState());
  __reset();
  openProjectLifecycle('delete', 'lumina');
  __state().projectLc.confirmText = 'lumina';
  __setFetch(() => ({ ok: true }));
  await runProjectAction();
  const req = __calls().fetch.find((c) => c.opts);
  eq('delete DELETEs the project endpoint', req.url, '/api/memory/alpha/projects/lumina');
  eq('...as a DELETE', req.opts.method, 'DELETE');
  // THE TYPED CONFIRMATION IS SENT, not merely checked in the view: the route
  // refuses without it, so a client that skipped the box deletes nothing.
  eq('...carrying the typed confirmation', JSON.parse(req.opts.body).confirm, 'lumina');
}
{
  // THE ACTION TARGETS THE FORM'S OWN SLUG, never state.activeSlug. Layer two
  // of the same discipline the domain lifecycle uses: a form that somehow
  // survived a domain switch still cannot act on the wrong domain.
  __setState(freshState());
  __reset();
  openProjectLifecycle('rename', 'lumina');
  __state().projectLc.name = 'x';
  __state().activeSlug = 'beta';          // the user switched underneath it
  __setFetch(() => ({ ok: true }));
  await runProjectAction();
  ok('the request still names the domain the FORM was opened on',
    __calls().fetch.find((c) => c.opts).url.startsWith('/api/memory/alpha/'),
    __calls().fetch.find((c) => c.opts).url);
}
{
  // A REFUSAL KEEPS THE FORM OPEN WITH THE REASON. The alternative -- closing
  // it -- destroys what the user typed and tells them nothing.
  __setState(freshState());
  __reset();
  openProjectLifecycle('create');
  __state().projectLc.name = 'projects';
  __setFetch(() => ({ throwStatus: 400, message: '"projects" is reserved' }));
  await runProjectAction();
  ok('the form stays open', __state().projectLc !== null);
  eq('...showing the refusal', __state().projectLc.refusal, '"projects" is reserved');
  eq('...and not as an error', __state().projectLc.error, null);
  eq('...with the typed name intact', __state().projectLc.name, 'projects');
  eq('...and the busy flag cleared', __state().projectLc.busy, false);
  ok('...and the message is scrolled into view', __calls().revealed.length === 1);
  ok('the write gate is released even on a refusal',
    __calls().gates.length === 1 && __calls().gates[0].released === true);
}
{
  // A 5xx or a network drop is an ERROR, not a refusal: the user cannot act
  // on it by changing their input.
  __setState(freshState());
  __reset();
  openProjectLifecycle('create');
  __state().projectLc.name = 'ok-name';
  __setFetch(() => ({ throwStatus: 500, message: 'disk on fire' }));
  await runProjectAction();
  eq('a 500 renders as an error', __state().projectLc.error, 'disk on fire');
  eq('...never as a refusal', __state().projectLc.refusal, null);

  __setState(freshState());
  __reset();
  openProjectLifecycle('create');
  __state().projectLc.name = 'ok-name';
  __setFetch(() => ({ throwPlain: true, message: 'network down' }));
  await runProjectAction();
  eq('a network drop renders as an error too', __state().projectLc.error, 'network down');
}
{
  // THE GATE IS RELEASED EVEN WHEN THE MOUNT IS STALE. A leaked shell-wide
  // write gate disables Sync's buttons for the life of the page.
  __setState(freshState());
  __reset();
  openProjectLifecycle('create');
  __state().projectLc.name = 'x';
  __setFetch(() => { __setMounted(false); return { ok: true }; });
  await runProjectAction();
  ok('a stale mount still releases the write gate',
    __calls().gates.length === 1 && __calls().gates[0].released === true);
  __setMounted(true);
}
{
  __setState(freshState());
  __reset();
  openProjectLifecycle('create');
  __state().projectLc.name = '   ';
  await runProjectAction();
  eq('an empty name is refused locally, before any request', __calls().fetch.length, 0);
  ok('...with a reason on the form', /name/i.test(__state().projectLc.error));

  __setState(freshState());
  __reset();
  openProjectLifecycle('create');
  __state().projectLc.name = 'x';
  __state().projectLc.busy = true;
  await runProjectAction();
  eq('a second submit while one is in flight issues no request', __calls().fetch.length, 0);
}
{
  eq('a 4xx is a refusal', classifyProjectError({ status: 403, message: 'nope' }).refusal, 'nope');
  eq('...and carries no error', classifyProjectError({ status: 403, message: 'nope' }).error, null);
  eq('a 500 is an error', classifyProjectError({ status: 500, message: 'boom' }).error, 'boom');
  eq('...and carries no refusal', classifyProjectError({ status: 500, message: 'boom' }).refusal, null);
  eq('an error with no status at all is an error', classifyProjectError(new Error('offline')).error, 'offline');
  ok('a missing message never renders as "undefined"',
    !/undefined/.test(String(classifyProjectError({}).error)));
}

// ═════════════════════════════════════════════════════════════════════════
section('S7 -- The .curator-project marker line');
// ═════════════════════════════════════════════════════════════════════════
//
// An agent starting in a repository reads this file and knows which project to
// resume instead of guessing or asking. It is a SKILL-level convention -- no
// server code reads it -- so the only thing the app owes it is the EXACT line.

{
  __setState(freshState());
  __reset();
  __setClipboard(true);
  await copyProjectMarker('lumina');
  eq('the copied line is exactly domain/project', __calls().clipboard[0], 'alpha/lumina');
  eq('...and the outcome is recorded', __state().copied.ok, true);
  const panel = renderProjectsPanel(false);
  ok('the confirmation names the file it goes in', panel.includes('.curator-project'));
}
{
  // A REFUSED CLIPBOARD PRINTS THE LINE. navigator.clipboard is unavailable on
  // a non-secure origin and can be denied outright; a button that silently
  // does nothing is worse than one that tells you what to type.
  __setState(freshState());
  __reset();
  __setClipboard(false);
  await copyProjectMarker('lumina');
  eq('a refusal is recorded as a failure', __state().copied.ok, false);
  eq('...and keeps the line', __state().copied.text, 'alpha/lumina');
  const panel = renderProjectsPanel(false);
  ok('...which is shown, so the user can type it', panel.includes('alpha/lumina'));
  __setClipboard(true);
}

// ═════════════════════════════════════════════════════════════════════════
section('S8 -- Placement and styling contracts');
// ═════════════════════════════════════════════════════════════════════════

{
  // AN INSET GROUPED LIST, from the kit -- not a stack of cards. shell.css's
  // own block says why: a card whose rows are separated by a hairline inset to
  // the label's x-offset is a macOS settings group; a gap between bordered
  // cards is a web form.
  __setState(freshState());
  const panel = renderProjectsPanel(false);
  ok('the section uses the kit inset group', panel.includes('class="cur-group"'));
  ok('...with the kit own row and label classes',
    panel.includes('cur-group-row') && panel.includes('cur-group-label'));
  ok('...under a group caption', panel.includes('cur-group-title'));
  // The kit owns the card and the separator; this view must not re-describe
  // them, or the two descriptions drift.
  ok('domains.css does NOT redeclare the group card or its separator',
    !/^\.cur-group\s*\{/m.test(CSS) && !/^\.cur-group-row\s*\+/m.test(CSS), 'a local copy of a kit rule');
}
{
  // The panel sits ABOVE Health and Browse: a project is a fact about the
  // domain itself, the same kind as its page counts, while Health and the
  // page browser are about the wiki's contents.
  const renderMain = extractFunction(SRC, 'renderMain');
  const iStats = renderMain.indexOf('renderStatCards(');
  const iProj = renderMain.indexOf('renderProjectsPanel(');
  const iHealth = renderMain.indexOf('renderHealthPanel(');
  ok('the Projects section renders after the stat cards and before Health',
    iStats > 0 && iProj > iStats && iHealth > iProj, [iStats, iProj, iHealth].join(','));
  ok('...and its listeners are bound', /bindProjectListeners\(\)/.test(renderMain));
}
{
  // The list is cleared on a domain switch, both layers. Layer 1 is the reset
  // in selectDomain; layer 2 is the stamp asserted in S1. Each is checked
  // separately, because two guards that mask each other are two guards nobody
  // is testing.
  const selectDomain = extractFunction(SRC, 'selectDomain');
  ok('LAYER 1: a domain switch clears the project list and any open form',
    /state\.projects = null/.test(selectDomain) && /state\.projectLc = null/.test(selectDomain),
    selectDomain);
  ok('...and re-asks for the new domain projects', /loadProjects\(/.test(selectDomain));
}

// ═════════════════════════════════════════════════════════════════════════
section('S9 -- THE TYPED DELETE CONFIRMATION CAN ACTUALLY BE TYPED (real DOM)');
// ═════════════════════════════════════════════════════════════════════════
//
// ── THE DEFECT, found by driving the real Electron app ───────────────────
// The delete confirmation could not be completed. `#dm-proj-confirm`'s input
// handler called render(), and render() replaces `#view-root`'s innerHTML —
// so the input the user was typing into was DESTROYED by the first
// character. `document.activeElement` fell back to <body>, every later
// keystroke went nowhere, the typed text never reached the project name, the
// button never enabled, and a project could not be deleted from the app at
// all.
//
// ── WHY EVERY ASSERTION ABOVE STAYED GREEN ───────────────────────────────
// S4 asserts the button's disabled attribute for a GIVEN `f.confirmText`, by
// calling the renderer with state already set. That is a statement about the
// gate, and the gate was never broken — what was broken was the only way a
// user has of moving `f.confirmText`. Nothing in this file had a DOM, so
// nothing could dispatch a keystroke. This section is the behavioural half:
// a DOM model, the SHIPPED bindProjectListeners, and real `input` events.
//
// NOT ENFORCED: this is a model, not Chromium. It cannot prove what a real
// browser does with a focused node that is removed mid-edit; it proves the
// view no longer removes it. §9d is the anti-vacuity control that the model
// really would destroy the node if the code repainted.

function makeDom() {
  let idSeq = 0;
  let activeElement = null;

  const unescape = (v) => String(v)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&');

  function el(tag, attrs) {
    const node = {
      __id: ++idSeq,
      tagName: String(tag).toUpperCase(),
      attrs: attrs || {},
      children: [],
      parentNode: null,
      _listeners: Object.create(null),
      value: attrs && attrs.value !== undefined ? unescape(attrs.value) : '',
      disabled: !!(attrs && Object.prototype.hasOwnProperty.call(attrs, 'disabled')),
      get id() { return node.attrs.id || ''; },
      get dataset() {
        const d = {};
        for (const k of Object.keys(node.attrs)) {
          if (k.startsWith('data-')) {
            d[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = unescape(node.attrs[k]);
          }
        }
        return d;
      },
      descendants() { return node.children.flatMap((c) => [c, ...c.descendants()]); },
      // The setter a real innerHTML write is: every descendant is detached,
      // and focus goes with them. Without the focus half this suite would
      // report "the keystroke landed" about a node the browser had thrown
      // away.
      set innerHTML(html) {
        const detach = (n) => { n.parentNode = null; n.children.forEach(detach); };
        if (activeElement && node.descendants().includes(activeElement)) activeElement = null;
        node.children.forEach(detach);
        node.children = parseHtml(String(html), node);
      },
      addEventListener(type, fn) { (node._listeners[type] = node._listeners[type] || []).push(fn); },
      focus() { activeElement = node; },
    };
    return node;
  }

  function parseHtml(html, parent) {
    const roots = [];
    const stack = [{ node: parent, list: roots }];
    const re = /<\/?([a-zA-Z0-9]+)((?:\s+[a-zA-Z0-9:_-]+(?:="[^"]*")?)*)\s*\/?>/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      if (m[0][1] === '/') { if (stack.length > 1) stack.pop(); continue; }
      const attrs = {};
      const ar = /([a-zA-Z0-9:_-]+)(?:="([^"]*)")?/g;
      let a;
      while ((a = ar.exec(m[2])) !== null) { if (a[1]) attrs[a[1]] = a[2] === undefined ? '' : a[2]; }
      const node = el(m[1], attrs);
      const top = stack[stack.length - 1];
      node.parentNode = top.node;
      top.list.push(node);
      if (top.node) top.node.children = top.list;
      const selfClosing = /\/>$/.test(m[0]) || /^(input|img|br|hr|meta|link)$/i.test(m[1]);
      if (!selfClosing) stack.push({ node, list: node.children });
    }
    return roots;
  }

  function matches(node, sel) {
    if (sel.startsWith('#')) return node.attrs.id === sel.slice(1);
    if (sel.startsWith('[') && sel.endsWith(']')) {
      return Object.prototype.hasOwnProperty.call(node.attrs, sel.slice(1, -1));
    }
    return node.tagName === sel.toUpperCase();
  }

  function dispatch(target, type) {
    const e = { type, target, preventDefault() {}, stopPropagation() {} };
    let n = target;
    while (n) {
      (n._listeners[type] || []).slice().forEach((fn) => fn(e));
      n = n.parentNode;
    }
    return e;
  }

  const body = el('body', {});
  const viewRoot = el('div', { id: 'view-root' });
  viewRoot.parentNode = body;
  body.children.push(viewRoot);

  return {
    viewRoot,
    dispatch,
    get activeElement() { return activeElement; },
    document: {
      getElementById: (id) => body.descendants().find((d) => d.attrs.id === id) || null,
      querySelectorAll: (sel) => body.descendants().filter((d) => matches(d, sel)),
    },
  };
}

/**
 * ONE KEYSTROKE, the way a browser delivers one: to whatever currently has
 * focus. Returns false when the character was LOST — which is exactly what
 * the defect did to every character after the first, and is the reason this
 * routes through activeElement rather than re-finding the input by id.
 */
function typeChar(dom, ch) {
  const el = dom.activeElement;
  if (!el || el.tagName !== 'INPUT') return false;
  el.value += ch;
  dom.dispatch(el, 'input');
  return true;
}

/** Mount the delete panel: paint, wire the SHIPPED listeners, focus the box. */
function mountDeletePanel(dom, project) {
  __setState(freshState({
    projects: {
      slug: 'alpha', loading: false, error: null,
      rows: [ROW({ project })], truncated: false, canWrite: true, readonly: false,
    },
    projectLc: { mode: 'delete', slug: 'alpha', project, name: '', brief: '', confirmText: '', busy: false, refusal: null, error: null },
  }));
  const repaint = () => {
    dom.viewRoot.innerHTML = renderProjectLifecycleCard();
    bindProjectListeners();
  };
  __setDocument(dom.document);
  __setRenderImpl(repaint);
  __reset();
  repaint();
  const input = dom.document.getElementById('dm-proj-confirm');
  if (input) input.focus();
  return { input, repaint };
}

{
  const dom = makeDom();
  const { input } = mountDeletePanel(dom, 'lumina');

  // §9a CONTROLS. Without these the section could pass over a panel that was
  // never painted or a focus model that never moved.
  ok('CONTROL -- the real markup parsed and the confirmation input exists', !!input);
  ok('CONTROL -- ...and it starts focused, as the user typing into it requires',
    dom.activeElement === input);
  const btn0 = dom.document.getElementById('dm-proj-submit');
  ok('CONTROL -- the Delete button exists and starts disabled on an empty box',
    !!btn0 && btn0.disabled === true);

  // §9b THE ASSERTION THE DEFECT FAILS. Two characters, delivered to whatever
  // has focus.
  const first = typeChar(dom, 'l');
  const second = typeChar(dom, 'u');
  ok('the FIRST keystroke reaches the input', first);
  ok('the SECOND keystroke reaches the input too -- the defect lost every character after the first', second);
  const still = dom.document.getElementById('dm-proj-confirm');
  ok('the input is the SAME NODE OBJECT after two keystrokes -- it was never rebuilt',
    still === input, still ? 'node #' + still.__id + ' vs #' + input.__id : 'gone');
  ok('...and it still has focus, so there is no caret to restore',
    dom.activeElement === input);
  eq('...carrying BOTH characters', still && still.value, 'lu');
  eq('...and state agrees with the box', __state().projectLc.confirmText, 'lu');
  eq('NO REPAINT AT ALL while typing -- the repaint was the defect, not the fix',
    __calls().render, 0);

  // §9c THE GATE OPENS EXACTLY ON THE FULL NAME, driven by real keystrokes on
  // the live node rather than by setting state and re-rendering.
  const gate = () => dom.document.getElementById('dm-proj-submit').disabled;
  ok('a partial name leaves Delete disabled', gate() === true);
  for (const ch of 'min') typeChar(dom, ch);
  eq('PRECONDITION -- one character short', __state().projectLc.confirmText, 'lumin');
  ok('...still disabled', gate() === true);
  typeChar(dom, 'a');
  eq('the box now holds the exact project name', __state().projectLc.confirmText, 'lumina');
  ok('DELETE ENABLES on the exact match -- the button the user could never reach',
    gate() === false);
  typeChar(dom, 'x');
  ok('...and disables again on one character too many, so the gate is an equality and not a prefix',
    gate() === true);
  ok('the input survived the whole sequence as one node',
    dom.document.getElementById('dm-proj-confirm') === input);
}
{
  // §9d ANTI-VACUITY. The claim in §9b is that the node SURVIVES, and it is
  // worth nothing unless a repaint really would destroy it in this model.
  // Painting the panel again by hand must produce a DIFFERENT node object and
  // drop focus -- which is precisely what render() did on every keystroke.
  const dom = makeDom();
  const { input, repaint } = mountDeletePanel(dom, 'lumina');
  typeChar(dom, 'l');
  repaint();
  const after = dom.document.getElementById('dm-proj-confirm');
  ok('CONTROL -- a repaint really does replace the input with a different node',
    !!after && after !== input);
  ok('CONTROL -- ...and focus is lost with it, so a keystroke after one would be dropped',
    dom.activeElement === null);
  ok('CONTROL -- ...which typeChar reports as a lost character',
    typeChar(dom, 'u') === false);
  eq('CONTROL -- the repainted box is re-seeded from state, so state is what survives a repaint',
    after && after.value, 'l');
}
{
  // §9e A BUSY FORM STAYS DISABLED. The handler applies the same predicate the
  // renderer does, so a keystroke arriving mid-delete cannot enable the button
  // the renderer had just disabled.
  const dom = makeDom();
  mountDeletePanel(dom, 'lumina');
  for (const ch of 'lumina') typeChar(dom, ch);
  ok('PRECONDITION -- enabled on the exact match',
    dom.document.getElementById('dm-proj-submit').disabled === false);
  __state().projectLc.busy = true;
  // The box still holds the EXACT name, so the equality half of the predicate
  // is satisfied and only `busy` can keep the button shut. Anything less than
  // this would pass with the busy half deleted.
  const box = dom.document.getElementById('dm-proj-confirm');
  dom.dispatch(box, 'input');
  eq('PRECONDITION -- the typed text still matches exactly', __state().projectLc.confirmText, 'lumina');
  ok('a keystroke while the delete is IN FLIGHT still leaves the button disabled -- the handler applies the whole predicate the renderer does, not just the name match',
    dom.document.getElementById('dm-proj-submit').disabled === true);
}

// ═════════════════════════════════════════════════════════════════════════
section('S10 -- THE CREATE CONTROL BELONGS TO THE GROUP (real tree)');
// ═════════════════════════════════════════════════════════════════════════
//
// ── THE DEFECT, reported by the maintainer from a screenshot ─────────────
// The rows rendered correctly as an inset group, and "New project" floated
// BELOW the card on its own -- outside any container, "just thrown
// somewhere". It was a `.btn` in a `<div class="dm-projects-actions">`
// SIBLING of the group, so nothing in the markup said the control acted on
// the list above it.
//
// ── WHY NOTHING ABOVE CAUGHT IT ──────────────────────────────────────────
// S4 asserts `panel.includes('dm-proj-new-btn')` and S8 asserts
// `panel.includes('class="cur-group"')`. Both are SUBSTRING questions, and a
// substring cannot express containment: the button was present, the group was
// present, and the button was outside the group. This section parses the
// panel into a real tree -- the same parser S9 drives listeners against --
// and asks the structural question instead.
//
// NOT ENFORCED: a tree is not a layout. That the row LOOKS like the rows
// above it -- the hairline above it, the hover band, the 40px height -- is
// the orchestrator's rendered pass; what is enforced here is the containment
// the screenshot showed was missing, plus the CSS contract the row needs.

const hasClass = (n, c) => String(n.attrs.class || '').split(/\s+/).filter(Boolean).includes(c);
const isInside = (node, ancestor) => {
  for (let n = node && node.parentNode; n; n = n.parentNode) if (n === ancestor) return true;
  return false;
};
/** Parse a rendered panel into a real tree, using S9's own parser. */
function parsePanel(html) {
  const dom = makeDom();
  dom.viewRoot.innerHTML = html;
  const all = dom.viewRoot.descendants();
  const groups = all.filter((n) => hasClass(n, 'cur-group'));
  return {
    dom,
    all,
    groups,
    group: groups[0] || null,
    byId: (id) => all.filter((n) => n.attrs.id === id),
  };
}

const WRITABLE = () => freshState({
  projects: {
    slug: 'alpha', loading: false, error: null,
    rows: [ROW({ project: 'lumina' }), ROW({ project: 'field-notes' }), ROW({ project: 'curator' })],
    truncated: false, canWrite: true, readonly: false,
  },
});

{
  __setState(WRITABLE());
  const t = parsePanel(renderProjectsPanel(false));

  // CONTROLS FIRST. Every assertion below is about a node's position in a
  // tree, and all of them pass trivially against a tree that failed to parse.
  ok('CONTROL -- the panel parsed into a tree with exactly one inset group',
    t.groups.length === 1, 'found ' + t.groups.length);
  ok('CONTROL -- the group really holds the three project rows',
    t.group && t.group.children.filter((n) => hasClass(n, 'dm-proj-row')).length === 3,
    t.group ? String(t.group.children.length) : 'no group');

  const btns = t.byId('dm-proj-new-btn');
  eq('there is EXACTLY ONE New project control in the panel', btns.length, 1);

  const btn = btns[0];
  ok('the New project control is a DESCENDANT of the Projects group -- the reported defect',
    !!btn && isInside(btn, t.group));
  ok('...and it is a ROW of that group, not a button parked inside one',
    !!btn && hasClass(btn, 'cur-group-row'), btn ? btn.attrs.class : 'gone');
  ok('...a real <button>, so it is reachable by keyboard and announced as an action',
    !!btn && btn.tagName === 'BUTTON' && btn.attrs.type === 'button');
  const last = t.group && t.group.children[t.group.children.length - 1];
  ok('...and it is the LAST child of the group, so the group reads rows-then-action',
    !!btn && last === btn, last ? last.tagName + '.' + last.attrs.class : 'group empty');
  ok('...carrying a leading + glyph and the label as separate spans',
    !!btn && btn.children.some((c) => hasClass(c, 'dm-proj-footer-icon'))
          && btn.children.some((c) => hasClass(c, 'dm-proj-footer-label')));

  // AND NOTHING IS LEFT OUTSIDE. The old wrapper is gone by name, so a
  // half-applied revert that re-added the sibling div would be caught even if
  // the button itself stayed inside.
  ok('the orphan action wrapper is gone from the view', !renderProjectsPanel(false).includes('dm-projects-actions'));
  ok('...and from the stylesheet, so no dead rule survives it', !CSS.includes('dm-projects-actions'));
}
{
  // THE FOOTER IS STILL LAST WHEN THE LIST IS TRUNCATED. The truncation note
  // is itself a row, and it must sit ABOVE the action rather than after it.
  const s = WRITABLE();
  s.projects.truncated = true;
  __setState(s);
  const t = parsePanel(renderProjectsPanel(false));
  const btn = t.byId('dm-proj-new-btn')[0];
  ok('with a truncation note present, the action is still the last row',
    !!btn && t.group.children[t.group.children.length - 1] === btn);
  ok('...and the note is inside the group too, above it',
    t.group.children.length === 5);
}
{
  // THE EMPTY STATE. A domain with no projects is the one where the create
  // control matters most, and it is the state most likely to be special-cased
  // into a different shape.
  __setState(freshState({ projects: { slug: 'alpha', loading: false, error: null, rows: [], canWrite: true, readonly: false } }));
  const t = parsePanel(renderProjectsPanel(false));
  const btn = t.byId('dm-proj-new-btn')[0];
  ok('EMPTY -- the create control is inside the group here too',
    !!btn && isInside(btn, t.group) && t.group.children[t.group.children.length - 1] === btn);
}
{
  // THE CREATE FORM TAKES THE FOOTER ROW'S PLACE. A form that opened BELOW
  // the card would re-create the same orphan one step further down.
  __setState(WRITABLE());
  openProjectLifecycle('create');
  const t = parsePanel(renderProjectsPanel(false));

  eq('CREATE OPEN -- the footer button is gone, replaced rather than duplicated',
    t.byId('dm-proj-new-btn').length, 0);
  const name = t.byId('dm-proj-name')[0];
  const submit = t.byId('dm-proj-submit')[0];
  eq('...and the form is rendered exactly once, so its ids are unique',
    t.byId('dm-proj-submit').length, 1);
  ok('the create form is INSIDE the group', !!name && isInside(name, t.group));
  ok('...its submit button too', !!submit && isInside(submit, t.group));
  ok('...in the group’s last row, where the control it replaced was',
    hasClass(t.group.children[t.group.children.length - 1], 'dm-proj-form-row'));
}
{
  // ANTI-VACUITY, and the deliberate asymmetry. Rename and delete are opened
  // from a ROW's own controls, and their cards stay BELOW the group so the row
  // being acted on is still on screen. That also proves `isInside` can say no:
  // if it could not, every assertion above would pass over any tree at all.
  __setState(WRITABLE());
  openProjectLifecycle('rename', 'lumina');
  const t = parsePanel(renderProjectsPanel(false));
  const submit = t.byId('dm-proj-submit')[0];
  ok('CONTROL -- the RENAME card renders outside the group, and isInside says so',
    !!submit && !isInside(submit, t.group));
  ok('...and the footer row is still there, because rename did not consume it',
    t.byId('dm-proj-new-btn').length === 1);

  __setState(WRITABLE());
  openProjectLifecycle('delete', 'lumina');
  const d = parsePanel(renderProjectsPanel(false));
  ok('CONTROL -- the DELETE card renders outside the group too',
    !isInside(d.byId('dm-proj-confirm')[0], d.group));
}
{
  // ── THE HEADER IS AN EYEBROW AND A MARK, AND NOTHING BETWEEN THEM AND THE
  //    GROUP (v3.58.0). v3.50.0 moved a four-line paragraph behind the ⓘ and
  //    kept one sentence visible, indented to the eyebrow's x-axis so it read
  //    as the group's caption rather than as text that had fallen between the
  //    two. The maintainer's verdict on that survivor was that it STILL read
  //    as a loose sentence -- the same complaint, one size smaller -- and
  //    v3.22.0 already records why rewording never fixes it: THE CONTAINER
  //    WAS THE PROBLEM, NOT THE WORDING. So the sentence is behind the mark,
  //    which is the control that exists to hold it.
  __setState(WRITABLE());
  const t = parsePanel(renderProjectsPanel(false));
  const head = t.all.find((n) => hasClass(n, 'dm-proj-head'));
  const eyebrow = t.all.find((n) => hasClass(n, 'cur-group-title'));
  ok('the eyebrow and the ⓘ mark are wrapped in ONE header block',
    !!head && !!eyebrow && isInside(eyebrow, head));
  const mark = head && t.all.find((n) => n.attrs['data-tx-info'] !== undefined && isInside(n, head));
  ok('...and the mark is in that header, beside the eyebrow', !!mark);
  const section = t.all.find((n) => hasClass(n, 'dm-projects'));
  ok('CONTROL -- the header and the group are siblings under the section',
    !!section && section.children.includes(head) && section.children.includes(t.group));
  ok('...and the header comes first', section
    && section.children.indexOf(head) < section.children.indexOf(t.group));

  // THE LOOSE SENTENCE IS GONE, from the tree AND from the stylesheet.
  ok('no caption renders between the eyebrow and the group',
    !t.all.some((n) => hasClass(n, 'dm-proj-caption')), 'a .dm-proj-caption is still rendered');
  const stripped = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  ok('...and domains.css no longer carries a rule placing one',
    !/\.dm-proj-caption/.test(stripped), 'a .dm-proj-caption rule survives');
  ok('CONTROL -- the comment stripper leaves real rules alone, so the check above can fail',
    /\.dm-proj-head\s*\{/.test(stripped));

  // NOTHING A READER NEEDED WAS DELETED. The definition moved INTO the fold,
  // and it is the first thing there -- which is the assertion that stops
  // "remove the lede" turning into "remove the explanation".
  const panelId = mark && mark.attrs['data-tx-info'];
  const panel = panelId && t.all.find((n) => n.attrs.id === panelId);
  // Read off the RAW HTML rather than the node: makeDom() parses TAGS only and
  // throws text away, so `panel.textContent` does not exist here. The panel's
  // own markup is sliced out by id, which is still an assertion about where
  // the sentence went rather than about the string existing somewhere.
  const rawPanel = (() => {
    const html = renderProjectsPanel(false);
    const at = html.indexOf('id="' + panelId + '"');
    return at === -1 ? '' : html.slice(at, html.indexOf('</div>', at));
  })();
  ok('...and the definition survives inside the fold',
    /A domain is one compounding wiki/.test(rawPanel), rawPanel.slice(0, 80));
  ok('...which still ships CLOSED, so nothing is on screen that was not before',
    panel && panel.attrs.hidden !== undefined);
}
{
  // ── EACH COPY CONTROL CARRIES ITS OWN ⓘ (v3.58.0) ──────────────────────
  // Reported by the maintainer about the app he builds: "I do not know what
  // Copy marker line is." Two ghost buttons both reading "Copy", with nothing
  // saying what lands on the clipboard or where it goes.
  __setState(WRITABLE());
  const t = parsePanel(renderProjectRow(ROW(), true, 0));
  const marks = t.all.filter((n) => n.attrs['data-tx-info'] !== undefined);
  eq('the row carries TWO ⓘ marks, one per copy control', marks.length, 2);
  const panels = t.all.filter((n) => hasClass(n, 'tx-vh-panel'));
  eq('...and two panels to match', panels.length, 2);
  ok('every panel ships hidden', panels.every((q) => q.attrs.hidden !== undefined));
  ok('...and every mark points at one that exists, with the -btn id convention',
    marks.every((m) => {
      const id = m.attrs['data-tx-info'];
      return m.attrs.id === id + '-btn' && m.attrs['aria-controls'] === id
        && m.attrs['aria-expanded'] === 'false'
        && panels.some((q) => q.attrs.id === id);
    }), marks.map((m) => m.attrs.id).join(', '));

  // THE MARK SITS WITH ITS CONTROL; THE PANEL DROPS BELOW THE ROW. A block
  // panel inside `.cur-group-control` -- a `flex: none` strip -- would be
  // squeezed in beside the buttons.
  const controls = t.all.find((n) => hasClass(n, 'cur-group-control'));
  ok('CONTROL -- the row has a control strip', !!controls);
  ok('both marks sit inside it, beside the buttons they explain',
    marks.every((m) => isInside(m, controls)));
  const wrap = t.all.find((n) => hasClass(n, 'dm-proj-info-panels'));
  ok('...and both panels sit in a wrapper OUTSIDE it', !!wrap
    && panels.every((q) => isInside(q, wrap)) && !isInside(wrap, controls));
  const wrapRule = /\.dm-proj-info-panels\s*\{([^}]*)\}/.exec(CSS);
  ok('...which domains.css gives a full-width flex basis, so it takes its own line',
    wrapRule && /flex:\s*0\s+0\s+100%/.test(wrapRule[1]), wrapRule && wrapRule[1]);
  ok('...and the row wraps, or that basis would do nothing',
    /\.dm-proj-row\s*\{[^}]*flex-wrap:\s*wrap/.test(CSS.replace(/\/\*[\s\S]*?\*\//g, '')));

  // THE IDS ARE UNIQUE ACROSS ROWS. A duplicate DOM id makes
  // getElementById return the first match, which is v3.54.0's
  // renderViewHeader collision -- one panel permanently unreachable.
  const two = parsePanel(renderProjectRow(ROW({ project: 'a_b' }), true, 0)
    + renderProjectRow(ROW({ project: 'a-b' }), true, 1));
  const ids = two.all.filter((n) => hasClass(n, 'tx-vh-panel')).map((n) => n.attrs.id);
  eq('two rows whose names SLUGIFY ALIKE still emit four panels', ids.length, 4);
  eq('...with four distinct ids', new Set(ids).size, 4, ids.join(', '));
  // ANTI-VACUITY: the slug really does collide, so the index is what saved it.
  eq('CONTROL -- the two names do slugify to the same stem',
    projInfoId('marker', 'a_b', 0).replace(/-0$/, ''),
    projInfoId('marker', 'a-b', 1).replace(/-1$/, ''));
  // AND A HOSTILE NAME CANNOT REACH THE ATTRIBUTE.
  const hostile = renderProjectRow(ROW({ project: '"><img onerror=x>' }), true, 0);
  ok('a hostile project name cannot escape through an ⓘ id',
    !/<img onerror/.test(hostile), hostile.slice(0, 200));
}
{
  // ── THE `{html: true}` LICENCE IS `=== true`, NEVER TRUTHY ──────────────
  // v3.58.0 gave this view's local infoMark the same opt-out shared/text.js's
  // renderInfoMark carries, because the PROJECTS fold is two labelled
  // paragraphs. The licence is for markup written in the view; a stray
  // string, a 1, or an options object built from a query must not switch
  // escaping off. Driven through the SHIPPED helper.
  const FRAG = '<b>bold</b>';
  const esc = infoMark('x', 'l', FRAG);
  ok('the DEFAULT escapes -- markup arrives as text',
    esc.panel.includes('&lt;b&gt;') && !esc.panel.includes('<b>'), esc.panel);
  const raw = infoMark('x', 'l', FRAG, { html: true });
  ok('...and `{html: true}` renders it', raw.panel.includes('<b>bold</b>'), raw.panel);
  for (const truthy of ['yes', 1, {}, [], 'true']) {
    const out = infoMark('x', 'l', FRAG, { html: truthy });
    ok('a truthy-but-not-true `html: ' + JSON.stringify(truthy) + '` still ESCAPES',
      out.panel.includes('&lt;b&gt;') && !out.panel.includes('<b>'), out.panel);
  }
  ok('no opts at all escapes too', infoMark('x', 'l', FRAG, undefined).panel.includes('&lt;b&gt;'));
  // AND THE ONE SITE THAT USES IT PASSES THE LITERAL.
  ok('renderProjectsPanel opts in with the literal `true`, not a variable',
    /infoMark\('dm-proj-info',[^)]*\{ html: true \}\)/.test(SRC), 'the call site no longer reads `{ html: true }`');
}
{
  // THE ROW'S CSS CONTRACT. The tree says the button is a row; these say the
  // row behaves like one -- the states come from the kit's own tokens, the
  // <button> chrome is off, and the pointer is the app's chrome pointer.
  const rule = /\.dm-proj-footer\s*\{([^}]*)\}/.exec(CSS);
  ok('CONTROL -- domains.css carries a .dm-proj-footer rule', !!rule);
  const body = rule ? rule[1] : '';
  ok('the row is full width, so the whole band is the target', /width:\s*100%/.test(body));
  ok('...with the <button> chrome removed rather than fought',
    /border:\s*0/.test(body) && /background:\s*none/.test(body) && /text-align:\s*left/.test(body));
  ok('...and `cursor: default`, which is what this app’s chrome uses',
    /cursor:\s*default/.test(body));
  ok('hover and press come from the kit surface tokens, not from new colours',
    /\.dm-proj-footer:hover\s*\{[^}]*var\(--surface-hover\)/.test(CSS)
    && /\.dm-proj-footer:active\s*\{[^}]*var\(--surface-active\)/.test(CSS));
  // THE HIT TARGET. macOS's default control target is 28pt and --hit-min
  // names it; the row's own minimum is the kit's 40. This asserts the FLOOR
  // is inherited rather than re-declared, because a local min-height here
  // could only make the band SMALLER than the rows above it.
  ok('the row declares no min-height of its own -- the kit’s 40px stands',
    !/min-height/.test(body), body);
  const shell = readFileSync(join(ROOT, 'src/public/next/shell.css'), 'utf8');
  const rowRule = /\n\.cur-group-row\s*\{([^}]*)\}/.exec(shell);
  const minPx = rowRule && /min-height:\s*(\d+)px/.exec(rowRule[1]);
  ok('...and that inherited minimum clears the 28px hit target',
    !!minPx && Number(minPx[1]) >= 28, minPx ? minPx[1] + 'px' : 'not found');
  // Inside `overflow: hidden`, an outset ring on the LAST row is clipped.
  ok('the focus ring is drawn INSIDE the row, because the group clips',
    /\.dm-proj-footer:focus-visible\s*\{[^}]*inset[^}]*\}/.test(CSS));
  ok('CONTROL -- the group really does clip, which is why the ring is inset',
    /\n\.cur-group\s*\{[^}]*overflow:\s*hidden/.test(shell));
}

// ── Done ─────────────────────────────────────────────────────────────────

console.log('\n' + '-'.repeat(60));
console.log('Passed: ' + passed + '   Failed: ' + failed);
if (failed === 0) console.log('All Domains-view project assertions green');
else console.log(failed + ' Domains-view project assertion(s) failed');
process.exit(failed === 0 ? 0 : 1);
