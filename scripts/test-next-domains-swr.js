/**
 * test-next-domains-swr.js — OFFLINE suite, zero dependencies, no network.
 *
 * Guards the Domains view's STALE-WHILE-REVALIDATE behaviour: the per-domain
 * session cache, the reserved card heights, and the two things that must not
 * be traded away to get them.
 *
 * ── THE DEFECT THIS EXISTS TO STOP COMING BACK ───────────────────────────
 *
 * Reported from production on a 3,445-page `articles` wiki: "when I enter the
 * Domains section, the wiki that is there blinks at the beginning, like it's
 * refreshing; when I move between domains, the wiki and the whole data on the
 * right side loads and blinks — it's fast but it loads like it's having a
 * problem loading."
 *
 * Measured in a real browser over CDP before anything was changed (1440x900,
 * a rAF sampler on `.dm-browse-card.getBoundingClientRect().height` plus a
 * MutationObserver counting `#view-root` child replacements):
 *
 *   ENTERING    the card painted FULL at 16 ms out of the state this module
 *               keeps across a view change, sat there, and then collapsed
 *               585 px -> 26 px at 834 ms and came back at 844 ms. The
 *               lateness was the ordering: loadBrowse ran after
 *               `await loadHealth`, and GET /api/health/:domain is an
 *               uncached whole-tree scan (753-788 ms, measured three times).
 *   SWITCHING   26 px for ~60 ms — a 521-559 px collapse and re-expansion —
 *               and 7 `#view-root` replacements per switch.
 *
 * After: 0 px of browse-card movement on a cached switch and on entry, 38 px
 * on a first (cold) visit to a domain, and 3 replacements on a cached switch.
 *
 * ── THE TWO THINGS THAT MUST NOT BE TRADED AWAY ──────────────────────────
 *
 * A cache on this screen is dangerous in two specific ways, and both are
 * asserted below rather than argued for:
 *
 *   (1) DOMAIN A'S PAGES MUST NEVER APPEAR UNDER DOMAIN B'S HEADING. The
 *       cache is a THIRD copy of data that is already slug-stamped twice, so
 *       it is keyed by slug, only read for that slug, and what it seeds is
 *       re-stamped — and activeBrowse()/activeProjects() still refuse a
 *       mismatch at RENDER time, independently. §4 drives that.
 *   (2) THE DESTRUCTIVE FORMS MUST STILL DIE ON A SWITCH. state.lifecycle
 *       and state.projectLc carry a target slug and a Delete button. §6
 *       drives a switch with both open and asserts they are gone.
 *
 * ── HOW IT TESTS ─────────────────────────────────────────────────────────
 *
 * By EXECUTING the shipped functions — lifted out of views/domains.js with a
 * brace matcher and run through `new Function` with their collaborators
 * injected and RECORDED — never by regexing the source. A test that proves a
 * line exists proves nothing about what it does (v3.0.17).
 *
 * ── ENFORCED ─────────────────────────────────────────────────────────────
 *  §0 POSITIVE CONTROLS — ok() takes the condition first, the extractor lifts
 *     real source, and a missing collaborator becomes a NAMED failure instead
 *     of a ReferenceError crash that reads like a pass.
 *  §1 A CACHE HIT PAINTS CONTENT, NOT A LOADING STATE, and still revalidates
 *     in the background.
 *  §2 AN IDENTICAL REVALIDATION REPAINTS NOTHING — zero render() calls, and
 *     it does not settle a gate it never began.
 *  §3 A DIFFERENT PAYLOAD REPAINTS EXACTLY ONCE, and the new rows are what
 *     lands.
 *  §4 A RESPONSE FOR A DOMAIN THE USER HAS LEFT IS DROPPED — at the write
 *     AND at the render, the two layers checked separately.
 *  §5 THE LOADING CARD IS NEVER A ZERO-HEIGHT COLLAPSE: aria-busy always,
 *     the recorded reserve as a min-height whenever one exists, and
 *     captureCardReserve records a real card's height while refusing to read
 *     a placeholder (which would ratchet the reserve to nothing).
 *  §6 A SWITCH STILL KILLS THE DESTRUCTIVE FORMS, the banner and the confirm.
 *  §7 settleGate IS STILL REACHED on both mid-fetch early-return paths, and
 *     is NOT called on the silent-revalidation path that never began a gate.
 *
 * ── NOT ENFORCED (named, not implied away) ───────────────────────────────
 *  · Nothing here measures real rendering. The pixel figures above come from
 *    a browser and are not reproducible in Node; this suite pins the
 *    MECHANISM that produced them (no blanking, no repaint, a min-height
 *    emitted) and not the pixels.
 *  · The health report is deliberately NOT cached across a switch —
 *    scripts/test-next-loading-gate.js §7b pins "a domain SWITCH takes the
 *    clearing path" as a safety property, and this change keeps it. Only the
 *    health card's HEIGHT is reserved, which §5 covers.
 *  · `state.cache` is unbounded for the life of the page. A user with fifty
 *    domains who visits all of them holds fifty page lists in memory. Not
 *    capped, and not measured.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// v3.71.0 (G3): BROWSE_EYEBROW now carries its own ⓘ, `PAGES_INFO`, a module
// const computed from the real kit — injected the same way every other
// free identifier this sandbox's PREAMBLE cannot see is.
import { explainerMark } from '../src/public/next/shared/explainer.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(ROOT, 'src/public/next/views/domains.js'), 'utf8');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed++;
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(actual, expected, label) {
  ok(actual === expected, `${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function section(t) { console.log(`\n${t}`); }
function callOrFail(label, thunk) {
  try { return thunk(); } catch (err) {
    ok(false, `${label} — THREW instead of running: ${err && err.message}`);
    return null;
  }
}

// ── The lifter, same shape and same loudness as its siblings ──────────────
function extractFunction(source, name) {
  const marker = new RegExp(`(?:^|\\n)(?:async\\s+)?function ${name}\\s*\\(`);
  const m = marker.exec(source);
  if (!m) throw new Error(`extractFunction: "${name}" not found in domains.js`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  let p = source.indexOf('(', start), parenDepth = 0;
  for (; p < source.length; p++) {
    if (source[p] === '(') parenDepth++;
    else if (source[p] === ')') { parenDepth--; if (parenDepth === 0) { p++; break; } }
  }
  let i = source.indexOf('{', p), depth = 0;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const extracted = source.slice(start, i);
  if (extracted.includes('\n') && !/\n\}$/.test(extracted)) {
    throw new Error(`extractFunction: "${name}" does not end at a top-level closing brace — the matcher desynced`);
  }
  return extracted;
}
function extractConstText(source, name) {
  const re = new RegExp(`(?:^|\\n)const ${name} = [^\\n]*;`);
  const m = re.exec(source);
  if (!m) throw new Error(`extractConstText: "${name}" not found as a single-line const in domains.js`);
  return m[0].trim();
}
function extractConstArray(source, name) {
  const re = new RegExp(`(?:^|\\n)const ${name} = \\[`);
  const m = re.exec(source);
  if (!m) throw new Error(`extractConstArray: "${name}" not found in domains.js`);
  let i = source.indexOf('[', m.index), depth = 0;
  for (; i < source.length; i++) {
    if (source[i] === '[') depth++;
    else if (source[i] === ']') { depth--; if (depth === 0) { i++; break; } }
  }
  return source.slice(m.index, source.indexOf(';', i) + 1).trim();
}

// ── The sandbox ──────────────────────────────────────────────────────────
// Every collaborator is injected and recorded, so an assertion can be made
// about what the shipped code ASKED FOR rather than about what it looks like.
const PREAMBLE = `
let state = {};
let myMountToken = 1;
let mounted = true;
const calls = { render: 0, renderSidebar: 0, renderMain: 0, fetch: [], gateBegin: 0, gateSettle: 0, health: [], asyncFailures: 0 };
let fetchResponder = () => ({ entries: [], memory: [] });
function render() { calls.render++; }
// v3.58.0. The REAL render() is lifted (see FNS) so the ⓘ capture/restore
// around the swap can be DRIVEN rather than read. Its two collaborators are
// recorders, and swapDom is what a real setMain() is from this function's
// point of view: the nodes it captured from are gone and new ones have taken
// their place.
let swapDom = null;
function renderSidebar() { calls.renderSidebar++; }
function renderMain() { calls.renderMain++; if (swapDom) document = swapDom; }
function isCurrentMount() { return mounted; }
function reportAsyncActionFailure() { calls.asyncFailures++; }
const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
function icon() { return ''; }
function renderDescription(t) { return '<p class="tx-desc">' + escapeHtml(t) + '</p>'; }
function renderStatus(o) { return '<div class="tx-status tx-status-' + o.state + '">' + escapeHtml(o.title) + '</div>'; }
// The REAL gate is not built here: what matters is the COUNTED begin/settle
// contract (loading-gate.js's own doc calls it counted, not boolean), and a
// gate that is begun without being settled — or settled without being begun —
// is the defect this records.
const loadGate = { begin() { calls.gateBegin++; }, get visible() { return false; } };
function settleGate(gate, apply) { calls.gateSettle++; if (typeof apply === 'function') apply(); }
function gatedLoader(gate, label, cls) { return (gate && gate.visible) ? ('<div class="' + cls + '">' + label + '</div>') : ''; }
async function fetchJSON(url) {
  calls.fetch.push(url);
  const r = fetchResponder(url);
  if (r && r.__throw) throw new Error(r.__throw);
  return r;
}
function loadHealth(slug, token, opts) { calls.health.push({ slug, token, opts }); return Promise.resolve(); }
let document = { querySelector: () => null, getElementById: () => null, querySelectorAll: () => [] };
`;

const FNS = [
  'activeBrowse', 'activeProjects',
  'browseSignature',
  'filterBrowseEntries', 'filterMemoryEntries', 'browseMatches', 'browseWindow',
  'browseRowHtml', 'memoryRowHtml', 'browseMoreHtml', 'browseNoteHtml',
  'renderBrowsePanel',
  'loadBrowse', 'loadProjects',
  'selectDomain',
  'captureCardReserve',
  // v3.58.0. An open ⓘ fold must survive a full repaint -- v3.53.1's finding,
  // fixed for Settings there and for Agent memory in v3.54.0, and never
  // reached this view until the OVERVIEW figures started re-rendering the
  // column from a click.
  'captureOpenInfoPanels', 'restoreOpenInfoPanels',
  'shouldKeepHealthOnReload', 'healthSection', 'healthScanLabel',
];

let box;
try {
  box = new Function(
    'explainerMark',
    PREAMBLE +
    extractConstText(SRC, 'PAGES_INFO') + '\n' +
    extractConstText(SRC, 'HEALTH_INFO') + '\n' +
    extractConstText(SRC, 'BROWSE_EYEBROW') + '\n' +
    extractConstText(SRC, 'BROWSE_RENDER_CAP') + '\n' +
    extractConstText(SRC, 'RESERVE_MIN_PX') + '\n' +
    extractConstText(SRC, 'RESERVE_MAX_PX') + '\n' +
    extractConstArray(SRC, 'BROWSE_FOLDERS') + '\n' +
    'let reserveCapturedThisTask = false;\n' +
    FNS.map((n) => extractFunction(SRC, n)).join('\n\n') + '\n' +
    // THE SHIPPED render(), UNDER A SECOND NAME. Every other section here
    // counts calls to the stub above, so lifting this one by its own name
    // would shadow the counter and silently zero six assertions -- which is
    // what the first cut did, and what its reds said. Only the declaration's
    // name is rewritten; the body is byte-for-byte the shipped one.
    (() => {
      const src = extractFunction(SRC, 'render');
      if (!/^function render\(token\) \{/.test(src)) {
        throw new Error('render() no longer has the shape this rename assumes');
      }
      return src.replace('function render(token) {', 'function realRender(token) {');
    })() + '\n' +
    // The health placeholder is the ONE branch of renderHealthPanel this
    // suite exercises (§5). Lifting the whole function would drag in a dozen
    // collaborators none of which that branch reaches, so the branch is
    // lifted whole and the rest of the function is left to its own suites.
    `
function healthPlaceholder(domain) {
  const usable = shouldKeepHealthOnReload(state.health, state.healthSlug, domain.slug);
  if (state.healthLoading && !usable) {
${(() => {
  const fn = extractFunction(SRC, 'renderHealthPanel');
  const i = fn.indexOf('const reserve = state.reserve && state.reserve.health;');
  if (i < 0) throw new Error('renderHealthPanel: the health reserve line is gone — this suite lifts the branch by it');
  const j = fn.indexOf('  }', i);
  return fn.slice(i, j);
})()}
  }
  return null;
}
` +
    `return { ${FNS.join(', ')}, healthPlaceholder, realRender, BROWSE_RENDER_CAP, RESERVE_MIN_PX, RESERVE_MAX_PX,
       __state: () => state, __setState: (s) => { state = s; },
       __calls: () => calls,
       __reset: () => { calls.render = 0; calls.fetch.length = 0; calls.gateBegin = 0;
                        calls.gateSettle = 0; calls.health.length = 0; calls.asyncFailures = 0; },
       __setFetch: (fn) => { fetchResponder = fn; },
       __setDocument: (d) => { document = d; },
       __setMounted: (v) => { mounted = v; },
       __setSwapDom: (d) => { swapDom = d; },
       __resetTaskFlag: () => { reserveCapturedThisTask = false; } };`
  )(explainerMark);
} catch (err) {
  console.log('FATAL: could not build the SWR sandbox from domains.js -- ' + err.message);
  process.exit(1);
}

const {
  loadBrowse, loadProjects, selectDomain, renderBrowsePanel, activeBrowse, activeProjects,
  browseSignature, captureCardReserve, healthPlaceholder, BROWSE_RENDER_CAP,
  captureOpenInfoPanels, restoreOpenInfoPanels, realRender,
  __state, __setState, __calls, __reset, __setFetch, __setDocument, __setMounted, __resetTaskFlag,
  __setSwapDom,
} = box;

const ENTRY = (slug, folder = 'concepts') => ({ slug, folder, path: folder + '/' + slug + '.md', title: slug });
const PAGES = (n, prefix = 'p') => {
  const out = [];
  for (let i = 0; i < n; i++) out.push(ENTRY(prefix + i));
  return out;
};

/** A state object shaped like the live one, with the cache empty unless given. */
function freshState(over) {
  return {
    loaded: true, activeSlug: 'alpha', domains: [{ slug: 'alpha' }, { slug: 'beta' }],
    readonlySet: new Set(), browse: null, projects: null, cache: Object.create(null),
    reserve: null, reveal: null, health: null, healthSlug: null, healthLoading: false,
    healthError: null, healthStale: false, healthSummary: {}, expandedGroups: new Set(),
    lifecycle: null, projectLc: null, confirm: null, banner: null, copied: null,
    semanticScan: null, estimates: {}, pendingPlan: null, dismissedRecords: null,
    ...over,
  };
}

/** Fill the cache for `slug` the way a completed loadBrowse/loadProjects would. */
async function warm(slug, entries, rows) {
  const st = __state();
  st.activeSlug = slug;
  st.browse = null;
  st.projects = null;
  __setFetch((url) => (url.includes('/api/wiki/')
    ? { entries, memory: [], truncated: false, memoryTruncated: false }
    : { projects: rows, truncated: false, canWrite: true, readonly: false }));
  await loadBrowse(slug, 1);
  await loadProjects(slug, 1);
}

// ═════════════════════════════════════════════════════════════════════════
section('§0  POSITIVE CONTROLS — this harness can actually fail');
// ═════════════════════════════════════════════════════════════════════════
{
  let p = 0, f = 0;
  const probe = (cond) => { if (cond) p++; else f++; };
  probe(true); probe(false);
  ok(p === 1 && f === 1, 'ok(cond, label) takes the CONDITION first — a reversed signature would pass everything');

  const lifted = extractFunction(SRC, 'loadBrowse');
  ok(lifted.length > 800 && lifted.startsWith('async function loadBrowse'),
     `the extractor lifts real source (${lifted.length} chars) — an empty lift would make every section below vacuous`);

  const before = failed;
  const realLog = console.log;
  console.log = () => {};
  callOrFail('control', () => { throw new Error('DELIBERATE'); });
  console.log = realLog;
  const fired = failed === before + 1;
  failed = before;
  ok(fired, 'callOrFail turns a throw into a NAMED failure — the crash-instead-of-red shape');

  // The signature must be a real function of its input, or §2 and §3 would
  // both be measuring the same constant.
  ok(browseSignature([ENTRY('a')], [], false, false) !== browseSignature([ENTRY('b')], [], false, false),
     'browseSignature distinguishes two different lists (anti-vacuity for §2/§3)');
  ok(browseSignature([ENTRY('a')], [], false, false) === browseSignature([ENTRY('a')], [], false, false),
     '...and returns the SAME value for the same list');
  ok(browseSignature([ENTRY('a')], [], false, false) !== browseSignature([ENTRY('a')], [], true, false),
     '...and does not ignore the truncation flag, which the card renders');
}

// ═════════════════════════════════════════════════════════════════════════
section('§1  A CACHE HIT PAINTS CONTENT, NOT A LOADING STATE');
// ═════════════════════════════════════════════════════════════════════════
{
  __setState(freshState());
  await warm('alpha', PAGES(200, 'a'), [{ project: 'one' }]);
  await warm('beta', PAGES(5, 'b'), [{ project: 'two' }]);

  // Now switch BACK to alpha, which is cached.
  __reset();
  __setState(Object.assign(__state(), { activeSlug: 'beta' }));
  __setFetch((url) => (url.includes('/api/wiki/')
    ? { entries: PAGES(200, 'a'), memory: [], truncated: false, memoryTruncated: false }
    : { projects: [{ project: 'one' }], truncated: false, canWrite: true, readonly: false }));

  callOrFail('selectDomain runs', () => selectDomain('alpha'));

  const b = __state().browse;
  ok(!!b, 'a cached switch leaves a page list in state immediately');
  eq(b && b.slug, 'alpha', '...stamped with the domain being switched TO');
  eq(b && b.loading, false, '...and NOT in a loading state — this is the whole fix');
  eq(b && b.entries.length, 200, '...carrying that domain\'s own rows');
  const p = __state().projects;
  eq(p && p.loading, false, 'the project list is likewise seeded rather than blanked');
  eq(p && p.slug, 'alpha', '...and stamped');

  // The panel a cache hit paints must contain ROWS, not a placeholder.
  const html = callOrFail('renderBrowsePanel on a cache hit', () => renderBrowsePanel());
  ok(html && html.includes('dm-browse-row'), 'the card paints real rows on the frame of the switch');
  ok(html && !/aria-busy="true"/.test(html), '...and carries no aria-busy, because nothing is pending on screen');

  // ...and it STILL asks the server.
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  const c = __calls();
  ok(c.fetch.some((u) => u.includes('/api/wiki/alpha/list')),
     'a cache hit still issues the background revalidation — stale-while-REVALIDATE, not stale-forever');
  ok(c.fetch.some((u) => u.includes('/api/memory/alpha/projects')),
     '...for the project list too');
  eq(c.health.length, 1, 'CONTROL — the health scan is still asked for on every switch (it is never cached)');
  ok(c.health[0] && !c.health[0].opts, '...with NO keep flag, so it takes the clearing path (the v3.17.x safety property)');
}

// ═════════════════════════════════════════════════════════════════════════
section('§2  AN IDENTICAL REVALIDATION REPAINTS NOTHING');
// ═════════════════════════════════════════════════════════════════════════
{
  __setState(freshState());
  const rows = PAGES(40, 'a');
  await warm('alpha', rows, [{ project: 'one' }]);

  __reset();
  // The SAME answer, byte for byte, as the one already on screen.
  __setFetch((url) => (url.includes('/api/wiki/')
    ? { entries: rows.map((r) => ({ ...r })), memory: [], truncated: false, memoryTruncated: false }
    : { projects: [{ project: 'one' }], truncated: false, canWrite: true, readonly: false }));

  await callOrFail('loadBrowse revalidates', () => loadBrowse('alpha', 1));
  eq(__calls().render, 0, 'an identical page list causes ZERO repaints — setMain would rebuild the whole column for nothing');
  eq(__calls().gateBegin, 0, '...and takes no loading gate, because nothing was blanked');
  eq(__calls().gateSettle, 0, '...and settles none, which would decrement another load\'s counter');

  __reset();
  await callOrFail('loadProjects revalidates', () => loadProjects('alpha', 1));
  eq(__calls().render, 0, 'an identical project list likewise repaints nothing');

  // ANTI-VACUITY: it really did ask.
  ok(__calls().fetch.length === 1, '...having actually made the request (so "zero repaints" is a finding, not a silence)');
}

// ═════════════════════════════════════════════════════════════════════════
section('§3  A DIFFERENT PAYLOAD REPAINTS EXACTLY ONCE');
// ═════════════════════════════════════════════════════════════════════════
{
  __setState(freshState());
  await warm('alpha', PAGES(40, 'a'), [{ project: 'one' }]);

  __reset();
  __setFetch(() => ({ entries: PAGES(41, 'a'), memory: [], truncated: false, memoryTruncated: false }));
  await callOrFail('loadBrowse sees a changed list', () => loadBrowse('alpha', 1));
  eq(__calls().render, 1, 'a changed page list repaints EXACTLY once');
  eq(__state().browse.entries.length, 41, '...and the new rows are what landed');
  eq(__state().browse.loading, false, '...with no intermediate loading state on the way');

  __reset();
  __setFetch(() => ({ projects: [{ project: 'one' }, { project: 'two' }], truncated: false, canWrite: true, readonly: false }));
  await callOrFail('loadProjects sees a changed list', () => loadProjects('alpha', 1));
  eq(__calls().render, 1, 'a changed project list repaints EXACTLY once');
  eq(__state().projects.rows.length, 2, '...and the new rows are what landed');

  // A FAILED revalidation must not replace good rows with an error card.
  __reset();
  __setFetch(() => ({ __throw: 'network down' }));
  await callOrFail('loadBrowse survives a failed revalidation', () => loadBrowse('alpha', 1));
  eq(__state().browse.error, null, 'a failed BACKGROUND re-ask leaves the good list alone rather than blanking it');
  eq(__state().browse.entries.length, 41, '...with its rows intact');
  eq(__calls().render, 0, '...and repaints nothing');
}

// ═════════════════════════════════════════════════════════════════════════
section('§4  A RESPONSE FOR A DOMAIN THE USER HAS LEFT IS DROPPED');
// ═════════════════════════════════════════════════════════════════════════
{
  // LAYER 1 — the write. A slow answer for alpha lands after the user is on
  // beta; it must not be written into the beta-stamped state.
  __setState(freshState({ activeSlug: 'alpha' }));
  let release;
  __setFetch(() => new Promise((r) => { release = () => r({ entries: PAGES(9, 'ALPHA'), memory: [] }); }));
  const inflight = loadBrowse('alpha', 1);
  // the user switches away mid-fetch
  const st = __state();
  st.activeSlug = 'beta';
  st.browse = { slug: 'beta', loading: false, error: null, entries: PAGES(2, 'BETA'), memory: [], filter: '', folder: 'all', window: BROWSE_RENDER_CAP };
  __reset();
  release();
  await inflight;
  eq(__state().browse.slug, 'beta', 'the stale answer never re-stamps the state to the domain it was for');
  ok(!__state().browse.entries.some((e) => e.slug.startsWith('ALPHA')),
     '...and alpha\'s rows never reach beta\'s list');
  eq(__state().browse.entries.length, 2, '...and beta\'s own list is left exactly as it was');
  // It DOES paint once on the way out, and must: that paint is settleGate's,
  // and the gate contract in §7 is why it is not optional. What it paints is
  // beta's state, which the two assertions above have just checked.
  eq(__calls().render, 1, 'the one render it does cause is the mandatory gate settle, not a write of stale data');

  // LAYER 2 — the render, INDEPENDENTLY. Even a state that somehow held a
  // mismatched list must not paint it.
  __setState(freshState({
    activeSlug: 'beta',
    browse: { slug: 'alpha', loading: false, error: null, entries: PAGES(3, 'ALPHA'), memory: [], filter: '', folder: 'all', window: BROWSE_RENDER_CAP },
  }));
  eq(activeBrowse(), null, 'activeBrowse() refuses a list stamped for another domain (LAYER 2, unchanged)');
  const html = callOrFail('renderBrowsePanel with a mismatched list', () => renderBrowsePanel());
  ok(html && !html.includes('ALPHA'), '...so the card cannot paint one domain\'s rows under another\'s heading');

  __setState(freshState({
    activeSlug: 'beta',
    projects: { slug: 'alpha', loading: false, error: null, rows: [{ project: 'x' }], truncated: false, canWrite: true, readonly: false },
  }));
  eq(activeProjects(), null, 'activeProjects() does the same for the project list');

  // And the cache itself is only ever read for its own key.
  __setState(freshState());
  await warm('alpha', PAGES(7, 'a'), [{ project: 'one' }]);
  __setState(Object.assign(__state(), { activeSlug: 'alpha' }));
  __setFetch(() => ({ entries: [], memory: [] }));
  selectDomain('beta');
  const seeded = __state().browse;
  // THE STAMP IS NOT THE ASSERTION. A seed taken from the wrong slot is
  // re-stamped with the slug being switched TO, so it LOOKS right and carries
  // another domain's rows — which is the whole failure mode. So the CONTENT is
  // what is checked. (A first draft asserted only the stamp, and the mutation
  // that reads the cache under a fixed key stayed green against it.)
  ok(seeded === null || seeded.entries.length === 0,
     'switching to an UNCACHED domain seeds no ROWS from another domain\'s slot');
  ok(!seeded || !seeded.entries.some((e) => e.slug.startsWith('a')),
     '...not one of them, however the seeded object is stamped');
}

// ═════════════════════════════════════════════════════════════════════════
section('§5  THE LOADING CARD IS NEVER A ZERO-HEIGHT COLLAPSE');
// ═════════════════════════════════════════════════════════════════════════
{
  // THE MEASURED DEFECT: gatedLoader returns '' below the 200 ms threshold —
  // correctly — so this card painted with NO children, 26 px between two
  // 585 px paints. What was missing was not a loader; it was the space.
  __setState(freshState({ browse: { slug: 'alpha', loading: true, entries: [], memory: [], filter: '', folder: 'all', window: BROWSE_RENDER_CAP } }));
  let html = callOrFail('renderBrowsePanel while loading, no reserve yet', () => renderBrowsePanel());
  ok(html && /aria-busy="true"/.test(html),
     'a loading page-list card ALWAYS declares itself busy, whether or not the gate has put words on screen');
  ok(html && !/min-height/.test(html),
     '...and emits NO min-height before any card height has been measured — absent is not zero');

  __state().reserve = { browse: 585, health: 452 };
  html = callOrFail('renderBrowsePanel while loading, with a reserve', () => renderBrowsePanel());
  ok(html && html.includes('style="min-height:585px"'),
     'once a height HAS been measured, the placeholder holds exactly that height');

  // The health card's placeholder, same rule.
  __setState(freshState({ healthLoading: true, reserve: { browse: 585, health: 452 } }));
  let hh = callOrFail('the health placeholder', () => healthPlaceholder({ slug: 'alpha' }));
  ok(hh && /aria-busy="true"/.test(hh), 'the "Scanning…" card declares itself busy too');
  ok(hh && hh.includes('style="min-height:452px"'), '...and holds the height the last report had');
  ok(hh && hh.includes('<div class="dm-health-body">Scanning…</div>'),
     '...while the gate-exempt Scanning line itself is untouched (byte-pinned by test-next-loading-gate.js)');

  __setState(freshState({ healthLoading: true }));
  hh = callOrFail('the health placeholder with no reserve', () => healthPlaceholder({ slug: 'alpha' }));
  ok(hh && !/min-height/.test(hh), '...and emits none before anything has been measured');

  // ── captureCardReserve: it records, and it refuses to record a placeholder.
  const card = (h, busy) => ({
    getAttribute: (n) => (n === 'aria-busy' ? (busy ? 'true' : null) : null),
    getBoundingClientRect: () => ({ height: h }),
  });
  const withDom = (map) => __setDocument({
    querySelector: (sel) => map[sel] || null, getElementById: () => null, querySelectorAll: () => [],
  });

  __setState(freshState());
  withDom({ '.dm-browse-card': card(585, false), '.dm-health-card': card(452, false) });
  __resetTaskFlag();
  callOrFail('captureCardReserve reads the live cards', () => captureCardReserve());
  eq(__state().reserve && __state().reserve.browse, 585, 'captureCardReserve records the page-list card\'s real height');
  eq(__state().reserve && __state().reserve.health, 452, '...and the health card\'s');

  // THE DECAY HAZARD: reading a card that is ITSELF reserving would ratchet
  // the number down to the placeholder's own height on the next switch, and
  // the defect would return looking like a regression somewhere else.
  withDom({ '.dm-browse-card': card(26, true), '.dm-health-card': card(89, true) });
  __resetTaskFlag();
  callOrFail('captureCardReserve against placeholders', () => captureCardReserve());
  eq(__state().reserve.browse, 585, 'a card that is itself aria-busy is NOT read — the reserve cannot decay');
  eq(__state().reserve.health, 452, '...for either card');

  // And an implausible reading is refused rather than reserved.
  withDom({ '.dm-browse-card': card(0, false), '.dm-health-card': card(99999, false) });
  __resetTaskFlag();
  callOrFail('captureCardReserve against nonsense', () => captureCardReserve());
  eq(__state().reserve.browse, 585, 'a 0 px rect (hidden ancestor, minimised window) is refused, not reserved');
  eq(__state().reserve.health, 452, '...and so is an absurd one, which would open a hole in the page');

  // ONCE PER TASK — the second call in the same task must not re-read.
  withDom({ '.dm-browse-card': card(700, false), '.dm-health-card': card(300, false) });
  __resetTaskFlag();
  captureCardReserve();
  eq(__state().reserve.browse, 700, 'CONTROL — a fresh task does read the new height');
  withDom({ '.dm-browse-card': card(120, false), '.dm-health-card': card(120, false) });
  captureCardReserve();   // same task: the flag is still set
  eq(__state().reserve.browse, 700, 'a SECOND capture in the same task is skipped — later reads see a DOM we just wrote');

  __setDocument({ querySelector: () => null, getElementById: () => null, querySelectorAll: () => [] });
}

// ═════════════════════════════════════════════════════════════════════════
section('§5b AN OPEN ⓘ FOLD SURVIVES A FULL REPAINT (v3.58.0)');
// ═════════════════════════════════════════════════════════════════════════
//
// shared/text.js keeps a panel's open state in the DOM ONLY -- it flips
// `hidden` and sets `aria-expanded` and records nothing -- so every render()
// closed every fold on this screen. That is v3.53.1's finding verbatim,
// unfixed here. It matters more now: this card carries four kinds of fold (the
// PROJECTS mark plus two per project row), and the OVERVIEW figures added this
// release re-render the whole column on a click, so an open explanation would
// be shut by the very control it explains.
//
// DRIVEN through the SHIPPED render(), with a document that is REPLACED
// mid-call -- which is what setMain() is from render()'s point of view.
{
  // A node model just rich enough for the two helpers: an attribute bag with
  // `hidden`, and a document that answers by id and by the one selector.
  const node = (id, expanded) => ({
    id, _attrs: { 'data-tx-info': id, 'aria-expanded': expanded },
    getAttribute(n) { return this._attrs[n]; },
    setAttribute(n, v) { this._attrs[n] = v; },
    hidden: expanded !== 'true',
  });
  const docOf = (btns, panels) => ({
    getElementById: (id) => btns[id] || panels[id] || null,
    querySelector: () => null,
    // BOTH selectors are answered, and that is not padding: a restore that
    // CLOSED what it did not capture would reach for every mark, and a model
    // that returned [] for the bare selector would let that mutation pass.
    querySelectorAll: (sel) => {
      const all = Object.values(btns);
      if (sel === '[data-tx-info]') return all;
      if (sel === '[data-tx-info][aria-expanded="true"]') {
        return all.filter((b) => b.getAttribute('aria-expanded') === 'true');
      }
      return [];
    },
  });
  // TWO TREES, AND THEY ARE NOT THE SAME SHAPE, which is the whole point.
  // `mk('a')` is what is ON SCREEN: fold `a` open, fold `b` closed. `mk()` is
  // what a REPAINT produces: every fold closed, because the markup ships
  // `hidden` and the component records nothing. A fixture whose fresh tree
  // already had `a` open would pass whether the capture ran before or after
  // the swap -- which is exactly what the first cut did, and its mutation
  // stayed green until this was fixed.
  const mk = (open) => {
    const btns = { 'a-btn': node('a', open === 'a' ? 'true' : 'false'),
                   'b-btn': node('b', open === 'b' ? 'true' : 'false') };
    btns['a-btn'].id = 'a-btn'; btns['b-btn'].id = 'b-btn';
    btns['a-btn']._attrs['data-tx-info'] = 'a';
    btns['b-btn']._attrs['data-tx-info'] = 'b';
    const panels = { a: { hidden: open !== 'a' }, b: { hidden: open !== 'b' } };
    // getElementById('a') must find the PANEL and getElementById('a-btn') the
    // button, which is the -btn convention every producer of this mark emits.
    return { btns, panels, doc: docOf(btns, panels) };
  };

  const before = mk('a');
  __setDocument(before.doc);
  const ids = callOrFail('captureOpenInfoPanels runs', () => captureOpenInfoPanels());
  eq(JSON.stringify(ids), JSON.stringify(['a']), 'the capture names exactly the OPEN fold');

  const after = mk();
  // The repaint destroys the old nodes: the new ones are all CLOSED, which is
  // exactly the defect -- the markup ships `hidden`.
  eq(after.panels.a.hidden, true, 'CONTROL -- a freshly repainted tree really does start closed');
  __setDocument(after.doc);
  callOrFail('restoreOpenInfoPanels runs', () => restoreOpenInfoPanels(ids));
  eq(after.panels.a.hidden, false, 'the fold that was open is re-opened after the swap');
  eq(after.btns['a-btn'].getAttribute('aria-expanded'), 'true',
    '...and its button says so to assistive tech');
  // RESTORE ONLY EVER OPENS.
  eq(after.panels.b.hidden, true, 'the fold that was CLOSED is left closed');
  eq(after.btns['b-btn'].getAttribute('aria-expanded'), 'false', '...and is not announced as expanded');

  // A MARK THAT IS GONE IS SKIPPED, not resurrected: a project renamed, or a
  // domain switched, takes its folds with it.
  const empty = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
  __setDocument(empty);
  callOrFail('restoring against a page that no longer has the mark', () => restoreOpenInfoPanels(['a']));
  callOrFail('...and restoring nothing at all', () => restoreOpenInfoPanels([]));

  // THE WHOLE THING, THROUGH THE SHIPPED render(). The document is swapped
  // BY renderMain, so the capture reads the old DOM and the restore the new
  // one -- which is the ordering the fix depends on and the one a
  // capture-after-swap would silently get wrong.
  // RESTORE ONLY EVER OPENS: a fold the NEW tree has opened for itself must
  // survive a restore that never saw it open. views/memory.js relies on that
  // for its force-open arms, and settings.js states the rule.
  const selfOpened = mk('b');
  __setDocument(selfOpened.doc);
  callOrFail('restoring against a tree that opened its OWN fold', () => restoreOpenInfoPanels(['a']));
  eq(selfOpened.panels.b.hidden, false, 'a fold the new tree opened itself is NOT closed by the restore');
  eq(selfOpened.btns['b-btn'].getAttribute('aria-expanded'), 'true', '...nor is its button contradicted');
  eq(selfOpened.panels.a.hidden, false, '...and the captured one is opened alongside it');

  const live = mk('a');
  const fresh = mk();
  __setDocument(live.doc);
  __setSwapDom(fresh.doc);
  __resetTaskFlag();
  __reset();
  callOrFail('the shipped render() runs', () => realRender(1));
  eq(__calls().renderSidebar + __calls().renderMain, 2, 'render repainted both columns');
  eq(fresh.panels.a.hidden, false, '...and the fold the user had open is open on the NEW tree');
  eq(fresh.panels.b.hidden, true, '...while the one they had closed stays closed');
  // ANTI-VACUITY: without the restore the new tree's panel really is hidden.
  const control = mk();
  eq(control.panels.a.hidden, true,
    'CONTROL -- a freshly rendered fold starts hidden, so the assertion above is a finding');

  __setSwapDom(null);
  __setDocument({ querySelector: () => null, getElementById: () => null, querySelectorAll: () => [] });
}

// ═════════════════════════════════════════════════════════════════════════
section('§6  A SWITCH STILL KILLS THE DESTRUCTIVE FORMS');
// ═════════════════════════════════════════════════════════════════════════
{
  __setState(freshState());
  await warm('alpha', PAGES(4, 'a'), [{ project: 'one' }]);
  await warm('beta', PAGES(4, 'b'), [{ project: 'two' }]);

  const st = __state();
  st.activeSlug = 'beta';
  st.lifecycle = { mode: 'delete', slug: 'beta', busy: false };
  st.projectLc = { mode: 'delete', slug: 'beta', project: 'two', confirmText: 'two' };
  st.confirm = { title: 'Delete?', run: () => { throw new Error('must never be reachable'); } };
  st.banner = { tone: 'success', text: 'done' };
  st.copied = { kind: 'marker', project: 'two', ok: true, text: 'x' };

  __setFetch(() => ({ entries: PAGES(4, 'a'), memory: [], projects: [{ project: 'one' }] }));
  callOrFail('a switch with two delete forms open', () => selectDomain('alpha'));

  eq(__state().lifecycle, null, 'the domain rename/delete form does not survive a switch (it carries a target slug)');
  eq(__state().projectLc, null, 'nor does the project delete form');
  eq(__state().confirm, null, 'nor an open confirmation, whose `run` closes over the previous domain\'s snapshot');
  eq(__state().banner, null, 'nor a banner about something that happened to another domain');
  eq(__state().copied, null, 'nor a copy acknowledgement for a row that is no longer on screen');
  // ANTI-VACUITY: the cache restore really did happen in the same call, so
  // the five nulls above are not just "nothing ran".
  eq(__state().browse && __state().browse.slug, 'alpha', 'CONTROL — and the switch DID seed the new domain\'s cached list');
  eq(__state().browse && __state().browse.loading, false, '...without a loading state');
}

// ═════════════════════════════════════════════════════════════════════════
section('§7  settleGate IS STILL REACHED ON THE EARLY-RETURN PATHS');
// ═════════════════════════════════════════════════════════════════════════
{
  // The finally in loadBrowse is mandatory: the two `b.slug !== slug` returns
  // (domain switched mid-fetch) would otherwise leave the gate pending
  // forever — a loader that appears at 200 ms and never leaves.

  // (a) COLD load, success path, switched away mid-fetch.
  __setState(freshState({ activeSlug: 'alpha' }));
  __reset();
  let release;
  __setFetch(() => new Promise((r) => { release = () => r({ entries: PAGES(3, 'a'), memory: [] }); }));
  let p = loadBrowse('alpha', 1);
  eq(__calls().gateBegin, 1, 'a COLD load begins the gate');
  __state().browse = { slug: 'beta', loading: false, error: null, entries: [], memory: [] };
  release();
  await p;
  eq(__calls().gateSettle, 1, '...and settles it even though the success path returned early');

  // (b) COLD load, ERROR path, switched away mid-fetch.
  __setState(freshState({ activeSlug: 'alpha' }));
  __reset();
  let fail;
  __setFetch(() => new Promise((_r, rej) => { fail = () => rej(new Error('boom')); }));
  p = loadBrowse('alpha', 1);
  eq(__calls().gateBegin, 1, 'a COLD load that will fail also begins the gate');
  __state().browse = { slug: 'beta', loading: false, error: null, entries: [], memory: [] };
  fail();
  await p;
  eq(__calls().gateSettle, 1, '...and settles it from the catch path\'s early return too');

  // (c) COLD load, unmounted mid-fetch — the third early return.
  __setState(freshState({ activeSlug: 'alpha' }));
  __reset();
  __setFetch(() => new Promise((r) => { release = () => r({ entries: [], memory: [] }); }));
  p = loadBrowse('alpha', 1);
  __setMounted(false);
  release();
  await p;
  __setMounted(true);
  eq(__calls().gateSettle, 1, 'and from the unmounted early return, which returns before either slug check');

  // (d) THE SILENT REVALIDATION must NOT settle a gate it never began. A
  //     counted gate settled once too often hides a loader another in-flight
  //     load legitimately raised.
  __setState(freshState());
  await warm('alpha', PAGES(6, 'a'), [{ project: 'one' }]);
  __reset();
  __setFetch(() => ({ entries: PAGES(6, 'a'), memory: [], truncated: false, memoryTruncated: false }));
  await loadBrowse('alpha', 1);
  eq(__calls().gateBegin, 0, 'a silent revalidation begins no gate');
  eq(__calls().gateSettle, 0, '...and settles none');
}

console.log('\n' + '='.repeat(60));
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ Domains stale-while-revalidate assertions FAILED'); process.exit(1); }
console.log('✅ Domains stale-while-revalidate, reserved heights and switch safety hold');
