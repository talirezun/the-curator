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
  const re = new RegExp(`(?:^|\\n)const ${name} = [\\s\\S]*?;[ \\t]*(?://[^\\n]*)?\\n`);
  const m = re.exec(source);
  if (!m) throw new Error(`extractConst: "${name}" not found in domains.js`);
  return m[0].trim();
}

const FNS = [
  'activeProjects',
  'loadProjects',
  'renderProjectRow',
  'renderProjectsPanel',
  'renderProjectLifecycleCard',
  'openProjectLifecycle',
  'closeProjectLifecycle',
  'classifyProjectError',
  'runProjectAction',
  'copyProjectMarker',
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

let sandbox;
try {
  sandbox = new Function(
    PREAMBLE +
    extractConst(SRC, 'PROJECT_BRIEF_TEMPLATE') + '\n' +
    extractConst(SRC, 'GIT_UNDO_WARN') + '\n' +
    FNS.map((n) => extractFunction(SRC, n)).join('\n\n') + '\n' +
    `return { ${FNS.join(', ')}, PROJECT_BRIEF_TEMPLATE,
       __state: () => state, __setState: (s) => { state = s; },
       __calls: () => calls,
       __reset: () => { calls.render = 0; calls.fetch.length = 0; calls.gates.length = 0;
         calls.clipboard.length = 0; calls.asyncFailures = 0; calls.revealed.length = 0; },
       __setFetch: (fn) => { fetchResponder = fn; },
       __setDocument: (d) => { document = d; },
       __setRenderImpl: (fn) => { renderImpl = fn; },
       __setClipboard: (v) => { clipboardOk = v; },
       __setMounted: (v) => { mounted = v; } };`
  )();
} catch (err) {
  console.log('FATAL: could not build the sandbox from domains.js -- ' + err.message);
  process.exit(1);
}

const {
  activeProjects, loadProjects, renderProjectRow, renderProjectsPanel,
  renderProjectLifecycleCard, openProjectLifecycle, closeProjectLifecycle,
  classifyProjectError, runProjectAction, copyProjectMarker, bindProjectListeners,
  PROJECT_BRIEF_TEMPLATE,
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
    markerCopied: null,
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
  eq('...and the outcome is recorded', __state().markerCopied.ok, true);
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
  eq('a refusal is recorded as a failure', __state().markerCopied.ok, false);
  eq('...and keeps the line', __state().markerCopied.line, 'alpha/lumina');
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

// ── Done ─────────────────────────────────────────────────────────────────

console.log('\n' + '-'.repeat(60));
console.log('Passed: ' + passed + '   Failed: ' + failed);
if (failed === 0) console.log('All Domains-view project assertions green');
else console.log(failed + ' Domains-view project assertion(s) failed');
process.exit(failed === 0 ? 0 : 1);
