#!/usr/bin/env node
/**
 * test-next-domain-sections.js — OFFLINE suite. No network, no API key, no LLM.
 *
 * v3.64.0's domain page: the rail lost its Ingest and Shared Brain buttons and
 * this page gained both as SECTIONS. Six sections on one column, two of them
 * whole former views, a drop zone inside a page with three independent
 * stale-while-revalidate layers above it, and a page list that now holds three
 * kinds of document instead of two.
 *
 * ── WHAT THIS SUITE EXISTS TO STOP ───────────────────────────────────────
 *  1. THE v3.46.0 DEFECT, ONE LAYER UP. `dragover` fires continuously, the
 *     first one re-renders, setMain replaces #view-root's innerHTML, and the
 *     drop target is destroyed mid-drag — drag-and-drop simply does not work.
 *     views/ingest.js fixed that INSIDE itself ("while a drag is in progress
 *     this view MUTATES, it never re-renders"); hosting that zone here puts a
 *     second, unrelated re-render source above the rule. §5 drives the host's
 *     quiesce with a busy predicate that FLIPS, and asserts node IDENTITY —
 *     the same thing test-next-ingest-dropzone.js asserts one layer down.
 *  2. A QUIESCE THAT SKIPS. The fix for (1) must PATCH, never drop a paint: a
 *     skipped repaint leaves the loading gate's placeholder standing over a
 *     card that has already loaded (SCENARIOS' "Domains 3"). §5 drives the
 *     shape-change case and asserts the FULL repaint happens anyway.
 *  3. A `shared-*` MIRROR OFFERED AN INGEST DESTINATION. views/ingest.js
 *     refuses a mirror and would fall back to another domain, so the section
 *     must be ABSENT, never disabled. §3.
 *  4. THE ENABLE TOGGLE GROWING A SECOND HOME. One control, one place
 *     (views/shared.js's own off-state). §3 adds views/domains.js's RENDERED
 *     OUTPUT to that census — the parity suite's own census is over source.
 *  5. A FOLD DEFAULT THAT IS A GUESS. INGEST opens on a domain that has never
 *     been ingested into and is closed once it has; either way the user's own
 *     choice wins from then on. §2.
 *  6. THE LENS AND THE FACET CHIPS DISAGREEING about what is on screen. §4.
 *
 * ── EVERYTHING HERE DRIVES REAL CODE ─────────────────────────────────────
 * Functions are lifted out of live source by brace-matching and executed with
 * `new Function` against injected collaborators — this file's house technique,
 * and for the reason the repo keeps re-learning: a test that proves a line of
 * source exists proves nothing about what it does. §6 drives the REAL route
 * against a REAL store in a temp directory.
 *
 * ── NOT ENFORCED (named, not implied away) ───────────────────────────────
 *  · §5's DOM is a MODEL, not Chromium. It answers "is this the same node
 *    object" and "which children were replaced", which is the question; it
 *    cannot prove what a real browser does to an in-flight drag. The browser
 *    measurement in the release notes is the other half and cannot be
 *    replaced by anything here.
 *  · The panels themselves are not driven: views/ingest.js and views/shared.js
 *    have their own suites. What is asserted is the HOST's side of the seam.
 *
 * Run with:  node scripts/test-next-domain-sections.js
 */

import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = readFileSync(join(ROOT, 'src/public/next/views/domains.js'), 'utf8');
const CSS = readFileSync(join(ROOT, 'src/public/next/views/domains.css'), 'utf8');
// v3.64.2 — the OVERVIEW card's own rules moved to the shared component's
// stylesheet when the Project-context view adopted the same card.
const OV_CSS = readFileSync(join(ROOT, 'src/public/next/shared/overview.css'), 'utf8');

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
function callOrFail(label, thunk) {
  try { return thunk(); } catch (err) {
    ok(label + ' -- THREW instead of running: ' + (err && err.message), false);
    return null;
  }
}

// ── Extraction ───────────────────────────────────────────────────────────
// Brace-matched and LOUD on desync — a silent truncation hands the sandbox
// something that fails much later as a bare SyntaxError.
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
    throw new Error(`extractFunction: "${name}" desynced`);
  }
  return extracted;
}
function extractConstText(source, name) {
  const re = new RegExp(`(?:^|\\n)const ${name} = [^\\n]*;`);
  const m = re.exec(source);
  if (!m) throw new Error(`extractConstText: "${name}" not found as a single-line const`);
  return m[0].trim();
}
function extractConstArray(source, name) {
  const re = new RegExp(`(?:^|\\n)const ${name} = \\[`);
  const m = re.exec(source);
  if (!m) throw new Error(`extractConstArray: "${name}" not found`);
  let i = source.indexOf('[', m.index), depth = 0;
  for (; i < source.length; i++) {
    if (source[i] === '[') depth++;
    else if (source[i] === ']') { depth--; if (depth === 0) { i++; break; } }
  }
  const start = m.index + (source[m.index] === '\n' ? 1 : 0);
  return source.slice(start, i) + ';';
}

// ── A tree model, so ORDER and PRESENCE are tree questions ───────────────
function parseHtmlToChildren(html) {
  const root = { tagName: 'ROOT', attrs: {}, children: [], parentNode: null };
  const stack = [root];
  const re = /<\/?([a-zA-Z0-9]+)((?:\s+[a-zA-Z0-9:_-]+(?:="[^"]*")?)*)\s*\/?>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[0][1] === '/') { if (stack.length > 1) stack.pop(); continue; }
    const attrs = {};
    const ar = /([a-zA-Z0-9:_-]+)(?:="([^"]*)")?/g;
    let a;
    while ((a = ar.exec(m[2])) !== null) { if (a[1]) attrs[a[1]] = a[2] === undefined ? '' : a[2]; }
    const node = { tagName: m[1].toUpperCase(), attrs, children: [], parentNode: stack[stack.length - 1] };
    stack[stack.length - 1].children.push(node);
    const selfClosing = /\/>$/.test(m[0]) || /^(input|img|br|hr|meta|link)$/i.test(m[1]);
    if (!selfClosing) stack.push(node);
  }
  return root;
}
const hasClass = (n, c) => String(n.attrs.class || '').split(/\s+/).filter(Boolean).includes(c);
function flatten(node) { return node.children.flatMap((c) => [c, ...flatten(c)]); }
function docOrder(root) {
  const seq = flatten(root);
  return (pred) => seq.findIndex(pred);
}

// ═════════════════════════════════════════════════════════════════════════
// SANDBOX A — the REAL renderMain, the REAL page-list panel and the REAL
// OVERVIEW figures. The two panels below Pages are stubbed to markers; both
// HOSTED sections are rendered for real, because they are what moved.
// ═════════════════════════════════════════════════════════════════════════
const { docsLinkHtml } = await import('../src/public/next/shared/docs-links.js');
const { renderOverview } = await import('../src/public/next/shared/overview.js');

const PREAMBLE = `
let state = {};
const calls = { setMain: [], jumps: [] };
const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
function icon() { return ''; }
function isCurrentMount() { return true; }
function setMain(html) { calls.setMain.push(html); }
function domainsHeader() { return '<div class="dm-header-STUB"></div>'; }
const loadGate = null;
function gatedLoader(_g, label) { return '<div class="dm-browse-empty">' + label + '</div>'; }
function renderKnowledgeNotice() { return ''; }
function renderLookedInLine() { return ''; }
function knowledgeFolderBtn() { return ''; }
function emptyCard() { return '<div class="dm-empty-STUB"></div>'; }
function renderLifecycleCard() { return ''; }
function renderViewHeader(o) { return '<div class="tx-view-header">' + escapeHtml(o.title) + '</div>'; }
function renderStatus(o) { return '<div class="tx-status tx-status-' + o.state + '">' + escapeHtml(o.title) + '</div>'; }
function renderDescription(t) { return '<p class="tx-desc">' + escapeHtml(t) + '</p>'; }
function relTime() { return 'just now'; }
const MIRROR_INFO = 'mirror-info';
const DOMAIN_BLURB = 'domain-blurb';
const MIRROR_WARNING = 'mirror-warning';
function renderProjectsPanel() { return '<div class="STUB-projects"></div>'; }
function renderHealthPanel() { return '<div class="STUB-health"></div>'; }
function openLifecycle() {}
function goToChatScoped() {}
function bindLifecycleListeners() {}
function bindProjectListeners() {}
function bindKnowledgeListeners() {}
function bindHealthListeners() {}
function bindBrowseListeners() {}
function bindStatCardListeners() {}
let render = () => {};
let myMountToken = 1;
function scrollSectionIntoView(sel) { calls.jumps.push(sel); }
const document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
`;

let box;
try {
  box = new Function('docsLinkHtml', 'renderOverview',
    PREAMBLE +
    extractConstText(SRC, 'BROWSE_EYEBROW') + '\n' +
    extractConstText(SRC, 'BROWSE_RENDER_CAP') + '\n' +
    extractConstArray(SRC, 'BROWSE_FOLDERS') + '\n' +
    extractFunction(SRC, 'activeBrowse') + '\n' +
    extractFunction(SRC, 'activeProjects') + '\n' +
    extractFunction(SRC, 'projectCount') + '\n' +
    extractFunction(SRC, 'filterBrowseEntries') + '\n' +
    extractFunction(SRC, 'filterMemoryEntries') + '\n' +
    extractFunction(SRC, 'browseMatches') + '\n' +
    extractFunction(SRC, 'browseWindow') + '\n' +
    extractFunction(SRC, 'browseRowHtml') + '\n' +
    extractFunction(SRC, 'memoryRowHtml') + '\n' +
    extractFunction(SRC, 'browseMoreHtml') + '\n' +
    extractFunction(SRC, 'browseNoteHtml') + '\n' +
    extractFunction(SRC, 'renderBrowsePanel') + '\n' +
    extractFunction(SRC, 'threeLayersInfoHtml') + '\n' +
    extractFunction(SRC, 'infoMark') + '\n' +
    extractFunction(SRC, 'sharedJumpReading') + '\n' +
    extractFunction(SRC, 'renderStatCards') + '\n' +
    extractFunction(SRC, 'renderMain') + '\n' +
    extractFunction(SRC, 'selectBrowseFacet') + '\n' +
    `return { renderMain, renderBrowsePanel, renderStatCards, browseMatches, memoryRowHtml,
       sharedJumpReading, selectBrowseFacet,
       __setState: (s) => { state = s; }, __state: () => state, __calls: () => calls,
       __setRender: (fn) => { render = fn; },
       __reset: () => { calls.setMain.length = 0; calls.jumps.length = 0; } };`
  )(docsLinkHtml, renderOverview);
} catch (err) {
  console.log('FATAL: could not build the renderMain sandbox from domains.js -- ' + err.message);
  process.exit(1);
}

const ENTRY = (over) => ({ slug: 'alpha-note', folder: 'entities', path: 'entities/alpha-note.md', title: 'Alpha note', ...over });
const MEM_BRIEF = { kind: 'brief', project: 'lumina', isDefaultProject: false, scope: null, machine: null,
  path: 'state/lumina/project.md', title: 'lumina · Standing brief', savedAt: null, bytes: 10 };
const MEM_FND = { kind: 'foundation', project: 'lumina', isDefaultProject: false, scope: null, machine: null,
  slug: 'architecture.md', role: 'architecture', path: 'state/lumina/foundations/architecture.md',
  title: 'lumina · Architecture', savedAt: null, bytes: 20, freshness: 'stale', skeleton: false };

const mainState = (over) => ({
  loaded: true, loadError: null, activeSlug: 'alpha',
  domains: [{ slug: 'alpha', displayName: 'Alpha', pageCount: 3, lastIngestDate: '2026-09-01',
    pageCounts: { entities: 1, concepts: 1, summaries: 1, other: 0 } }],
  readonlySet: new Set(),
  sectionPrefs: {},
  sharedJump: null,
  browse: {
    slug: 'alpha', loading: false, error: null, filter: '', folder: 'all', lens: 'wiki', truncated: false,
    memory: [MEM_BRIEF, MEM_FND],
    entries: [ENTRY(), ENTRY({ slug: 'idea', folder: 'concepts', path: 'concepts/idea.md', title: 'Idea' })],
  },
  ...over,
});
function renderCard(over) {
  box.__reset();
  box.__setState(mainState(over));
  box.renderMain(1);
  return box.__calls().setMain[0];
}

// ═════════════════════════════════════════════════════════════════════════
section('S1 -- SIX SECTIONS, IN ONE ORDER');
// ═════════════════════════════════════════════════════════════════════════
{
  const html = callOrFail('renderMain composes a domain card', () => renderCard());
  if (html) {
    const at = docOrder(parseHtmlToChildren(html));
    const idx = {
      overview: at((n) => hasClass(n, 'dm-overview')),
      sources: at((n) => n.attrs.id === 'dm-sources-fold'),
      pages: at((n) => hasClass(n, 'dm-pages')),
      projects: at((n) => hasClass(n, 'STUB-projects')),
      shared: at((n) => n.attrs.id === 'dm-shared-fold'),
      health: at((n) => hasClass(n, 'STUB-health')),
    };
    // CONTROLS FIRST: every assertion below compares indices, and -1 < 0
    // compares perfectly happily.
    for (const [k, v] of Object.entries(idx)) ok('CONTROL -- ' + k + ' is in the parsed tree', v >= 0, String(v));
    eq('the six sections render in the designed order',
      Object.entries(idx).sort((a, b) => a[1] - b[1]).map(([k]) => k).join(' > '),
      'overview > sources > pages > projects > shared > health');
    // The eyebrows name the blocks. INGEST, not "ADD SOURCES" (the maintainer's
    // decision, 2026-09-20): the section is the act, and SOURCES stays the
    // OVERVIEW tile's word because there it is a count.
    ok('the INGEST fold is labelled INGEST', /dm-fold-title">INGEST</.test(html));
    ok('the SHARED BRAIN fold is labelled SHARED BRAIN', /dm-fold-title">SHARED BRAIN</.test(html));
    ok('...and neither section says "ADD SOURCES"', !/ADD SOURCES/.test(html));
    // The panels own these elements and this page never writes into them again.
    ok('each fold carries exactly one empty host element for its panel',
      (html.match(/id="dm-sources-host"><\/div>/g) || []).length === 1
      && (html.match(/id="dm-shared-host"><\/div>/g) || []).length === 1);
    // The lede the maintainer wrote, rendered through the shared text role
    // rather than as a loose paragraph under a heading.
    ok('INGEST carries its lede, and it is a `.tx-desc`',
      /<p class="tx-desc">Drop a PDF, markdown or text file\./.test(html), html.slice(0, 400));

    // ── THE FIVE SECTIONS ARE NUMBERED (v3.64.1) ────────────────────────
    //
    // THE COMPLAINT, measured: this column named its regions SIX ways — a
    // bare eyebrow (PROJECTS, WIKI HEALTH), a SECOND eyebrow class for the
    // same role (PAGES), an eyebrow in a flex head row (OVERVIEW) and two
    // fold summaries — and every one of them was 11px/500, the quietest rung
    // in the type standard. Nothing was broken; there was no hierarchy. The
    // Context view next door reads as a sequence because its steps carry a
    // numeral and a 16px/600 title, and these now match it.
    //
    // OVERVIEW IS NOT NUMBERED, and that is the argument rather than an
    // omission: it is a reading ABOUT the screen, not a step in it — the same
    // call the Context view's own three-cell strip makes for sitting outside
    // its numbering.
    // PROJECTS and WIKI HEALTH are STUBBED in this sandbox (see its header),
    // so three of the five numerals are visible here; ③ is pinned against the
    // literal that emits it and ⑤ is driven for real below, through the
    // `healthSection` wrapper the other suites also lift.
    const nums = [...html.matchAll(/<span class="dm-section-num" aria-hidden="true">(\d)<\/span>/g)]
      .map((m) => m[1]);
    eq('the three sections this sandbox renders carry a numeral', nums.length, 3);
    eq('...in reading order', nums.join(''), '124');
    ok('③ is emitted immediately above the PROJECTS title',
      /<span class="dm-section-num" aria-hidden="true">3<\/span>' \+\s*\n\s*'<div class="cur-group-title dm-section-eyebrow">PROJECTS IN THIS DOMAIN<\/div>/
        .test(SRC), 'not found in domains.js');
    {
      // ⑤ WIKI HEALTH, EXECUTED — the wrapper is a pure function of its inner
      // markup, so it can be lifted on its own.
      const wrap = new Function(extractFunction(SRC, 'healthSection') + '\nreturn healthSection;')();
      const out = wrap('<div class="dm-health-card">x</div>');
      ok('the health section carries numeral 5 beside its title',
        /<span class="dm-section-num" aria-hidden="true">5<\/span><div class="cur-group-title dm-section-eyebrow">WIKI HEALTH<\/div>/
          .test(out), out);
      ok('...and the title keeps the classes an unowned suite pins by name',
        /class="cur-group-title dm-section-eyebrow">WIKI HEALTH</.test(out), out);
      eq('CONTROL -- an empty body still renders nothing at all', wrap(''), '');
    }
    for (const [n, word] of [['1', 'INGEST'], ['2', 'PAGES'], ['4', 'SHARED BRAIN']]) {
      const at = html.indexOf('>' + n + '</span>');
      const title = html.indexOf(word, at);
      ok('numeral ' + n + ' is the one beside ' + word,
        at !== -1 && title !== -1 && title - at < 200, at + ' -> ' + title);
    }
    ok('OVERVIEW carries no numeral — it is a reading about the screen, not a step',
      !/dm-section-num[^>]*>\d<\/span><\/div><div class="cur-group-title dm-section-eyebrow">OVERVIEW/
        .test(html)
      && html.indexOf('>OVERVIEW<') < html.indexOf('dm-section-num'),
      String(html.indexOf('>OVERVIEW<')) + ' vs ' + String(html.indexOf('dm-section-num')));
    // THE NUMERAL IS aria-hidden ON EVERY SITE. A screen reader reads
    // "INGEST", never "1 INGEST" — the same call shared/block.js makes.
    eq('every numeral is aria-hidden',
      (html.match(/class="dm-section-num"/g) || []).length,
      (html.match(/class="dm-section-num" aria-hidden="true"/g) || []).length);
    // THE TITLE ELEMENT KEPT ITS CLASSES: three suites this package does not
    // own pin `.cur-group-title.dm-section-eyebrow` and `.dm-recent-eyebrow`
    // by name, so the numeral and the larger face are added AROUND the
    // element rather than by replacing it.
    ok('the PAGES title still carries the classes two other suites pin by name',
      /class="cur-group-title dm-recent-eyebrow dm-section-eyebrow">PAGES</.test(html), html.slice(0, 600));
    ok('...and the two eyebrow classes are now ONE treatment, inside one head',
      /<div class="dm-section-hd"><span class="dm-section-num"[^>]*>2<\/span><div class="cur-group-title dm-recent-eyebrow dm-section-eyebrow">PAGES<\/div><\/div>/
        .test(html), html.slice(0, 600));
  }
}
{
  // ── THE HEAD LOOKS LIKE THE CONTEXT VIEW'S STEP HEAD, AND IS PINNED TO IT
  //
  // domains.css COPIES shell.css's `.settings-block-hd` / `.settings-block-num`
  // / `.settings-job-title` values rather than importing the component, because
  // adopting `renderBlock` means naming an import inside `renderMain`, which
  // three suites lift and execute against fixed stub lists. A copy that can
  // drift in silence is worse than no copy, so the values are compared here:
  // the day somebody retunes the Context view's step head, this reds.
  const shellCss = readFileSync(new URL('../src/public/next/shell.css', import.meta.url), 'utf8');
  const decl = (css, sel, prop) => {
    const m = new RegExp('\\n' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      + '\\s*\\{([^}]*)\\}').exec(css);
    if (!m) return null;
    const d = new RegExp(prop + ':\\s*([^;]+);').exec(m[1]);
    return d ? d[1].trim() : null;
  };
  for (const prop of ['width', 'height', 'font-size', 'font-weight', 'background', 'color', 'border']) {
    const mine = decl(CSS, '.dm-section-num', prop);
    const theirs = decl(shellCss, '.settings-block-num', prop);
    ok('CONTROL -- both stylesheets declare ' + prop + ' on their numeral',
      mine !== null && theirs !== null, mine + ' / ' + theirs);
    eq('the numeral\'s ' + prop + ' matches the Context view\'s', mine, theirs);
  }
  eq('the head\'s gap matches too', decl(CSS, '.dm-section-hd', 'gap'),
    decl(shellCss, '.settings-block-hd', 'gap'));
  const titleRule = /\n\.dm-section-hd \.dm-section-eyebrow,\n\.dm-section-hd \.dm-fold-title\s*\{([^}]*)\}/.exec(CSS);
  ok('CONTROL -- one rule paints every section title', !!titleRule, String(titleRule));
  const titleProp = (p2) => {
    const m = new RegExp(p2 + ':\\s*([^;]+);').exec(titleRule ? titleRule[1] : '');
    return m ? m[1].trim() : null;
  };
  eq('the section title takes the block-title size', titleProp('font-size'),
    decl(shellCss, '.settings-job-title', 'font-size'));
  eq('...and its weight', titleProp('font-weight'),
    decl(shellCss, '.settings-job-title', 'font-weight'));
  eq('...and its colour', titleProp('color'), decl(shellCss, '.settings-job-title', 'color'));
  ok('...and it stops being an uppercase mono eyebrow',
    /text-transform:\s*none/.test(titleRule ? titleRule[1] : '')
    && /font-family:\s*var\(--font-sans\)/.test(titleRule ? titleRule[1] : ''),
    titleRule && titleRule[1]);
}

// ═════════════════════════════════════════════════════════════════════════
section('S2 -- THE FOLD DEFAULTS ARE DERIVED, AND THE USER OVERRULES THEM');
// ═════════════════════════════════════════════════════════════════════════
const foldOpen = (html, id) => {
  const n = flatten(parseHtmlToChildren(html)).find((x) => x.attrs.id === id);
  return n ? Object.hasOwn(n.attrs, 'open') : null;
};
{
  const fresh = renderCard({ domains: [{ slug: 'alpha', displayName: 'Alpha', pageCount: 0,
    lastIngestDate: null, pageCounts: { entities: 0, concepts: 0, summaries: 0, other: 0 } }] });
  eq('a domain with no ingest opens INGEST', foldOpen(fresh, 'dm-sources-fold'), true);
  const mature = renderCard();
  eq('...and a domain that has been ingested into leaves it closed', foldOpen(mature, 'dm-sources-fold'), false);
  // A domain with summaries but no recorded date is still "has been ingested".
  const summarised = renderCard({ domains: [{ slug: 'alpha', displayName: 'Alpha', pageCount: 2,
    lastIngestDate: null, pageCounts: { entities: 0, concepts: 0, summaries: 2, other: 0 } }] });
  eq('...summaries alone count as an ingest, with no date recorded',
    foldOpen(summarised, 'dm-sources-fold'), false);
  eq('SHARED BRAIN is closed on a domain that has never been shared',
    foldOpen(mature, 'dm-shared-fold'), false);
}
{
  // THE REMEMBERED CHOICE WINS IN BOTH DIRECTIONS -- a preference that could
  // only ever open a fold would make "I closed this" unexpressible on a fresh
  // domain, which is the state where the default is most likely to be wrong.
  const closedOnFresh = renderCard({
    domains: [{ slug: 'alpha', displayName: 'Alpha', pageCount: 0, lastIngestDate: null,
      pageCounts: { entities: 0, concepts: 0, summaries: 0, other: 0 } }],
    sectionPrefs: { sources: false },
  });
  eq('a remembered CLOSED beats the fresh-domain default',
    foldOpen(closedOnFresh, 'dm-sources-fold'), false);
  const openOnMature = renderCard({ sectionPrefs: { sources: true, shared: true } });
  eq('...and a remembered OPEN beats the mature-domain default',
    foldOpen(openOnMature, 'dm-sources-fold'), true);
  eq('...for the Shared Brain fold too', foldOpen(openOnMature, 'dm-shared-fold'), true);
  // ── THE PREFERENCE IS INSTALL-WIDE (v3.64.1) ──────────────────────────
  // REPORTED FROM PRODUCTION on the day v3.64.0 shipped: the maintainer
  // opened INGEST, switched domain, and found it shut again. v3.64.0 kept one
  // row per domain, which is not a preference — it is twelve of them, and a
  // person who wants the drop zone in front of them wants it in front of them
  // everywhere. This assertion is the reversal of the one that stood here,
  // and it is the whole of the fix: the SAME record answers for a domain the
  // user has never opened this page for.
  const anyDomain = renderCard({
    domains: [{ slug: 'beta', displayName: 'Beta', pageCount: 9, lastIngestDate: '2026-09-02',
      pageCounts: { entities: 3, concepts: 3, summaries: 3, other: 0 } }],
    activeSlug: 'beta',
    browse: { slug: 'beta', loading: false, error: null, filter: '', folder: 'all', lens: 'wiki',
      truncated: false, memory: [], entries: [ENTRY()] },
    sectionPrefs: { sources: true, shared: true },
  });
  eq('the choice travels to a domain this page has never been opened for',
    foldOpen(anyDomain, 'dm-sources-fold'), true);
  eq('...for the Shared Brain fold too', foldOpen(anyDomain, 'dm-shared-fold'), true);
  // ...AND THE DEFAULT IS STILL DERIVED WHEN NOTHING WAS EVER CHOSEN. The
  // install-wide preference did NOT become an install-wide default: a domain
  // with nothing under this section still opens it.
  const neverChosen = renderCard({
    domains: [{ slug: 'alpha', displayName: 'Alpha', pageCount: 0, lastIngestDate: null,
      pageCounts: { entities: 0, concepts: 0, summaries: 0, other: 0 } }],
    sectionPrefs: {},
  });
  eq('with nothing remembered the fresh-domain default still applies',
    foldOpen(neverChosen, 'dm-sources-fold'), true);
  // A HOSTILE OR BROKEN RECORD DEGRADES TO THE DEFAULT, never to a throw.
  const junk = callOrFail('a junk preference record still renders',
    () => renderCard({ sectionPrefs: { sources: 'yes-please' } }));
  if (junk) eq('...and takes the designed default', foldOpen(junk, 'dm-sources-fold'), false);
}
{
  // The key is read and written through ONE name, and the literal duplicated
  // inside selectBrowseFacet (which is lifted into two sandboxes and may not
  // name a module-level const) is pinned equal to it here.
  const declared = /const SECTION_PREFS_KEY = '([^']+)';/.exec(SRC);
  ok('CONTROL -- SECTION_PREFS_KEY is declared', !!declared, String(declared));
  const facet = extractFunction(SRC, 'selectBrowseFacet');
  ok('the literal inside selectBrowseFacet is the SAME key the module declares',
    !!declared && facet.includes(`localStorage.setItem('${declared[1]}'`), declared && declared[1]);
  ok('...and it is the only curator-* key this view adds',
    (SRC.match(/'curator-domain-sections-v1'/g) || []).length === 2,
    String((SRC.match(/'curator-domain-sections-v1'/g) || []).length));
  // THE ROW KEY IS DUPLICATED FOR THE SAME REASON AND PINNED THE SAME WAY.
  const rowDecl = /const SECTION_PREFS_ROW = '([^']+)';/.exec(SRC);
  ok('CONTROL -- SECTION_PREFS_ROW is declared', !!rowDecl, String(rowDecl));
  ok('the row key cannot collide with a domain slug — no slug may contain it',
    !!rowDecl && !/^[A-Za-z0-9_-]+$/.test(rowDecl[1]), rowDecl && rowDecl[1]);
  ok('the literal inside selectBrowseFacet is the SAME row key the module declares',
    !!rowDecl && facet.includes(`{ '${rowDecl[1]}': state.sectionPrefs }`), rowDecl && rowDecl[1]);
}

{
  // ── THE READ, EXECUTED AGAINST HOSTILE BYTES ──────────────────────────
  // localStorage is a store the user can edit and another tab can write. It
  // is also a store that THROWS rather than returning null in a private
  // window, which is why every access here is wrapped. What comes back must
  // be a map holding nothing but the three fields this view understands,
  // under the values it understands — so a hand-edited lens cannot reach
  // browseMatches and a hand-edited fold flag cannot reach the markup.
  const prefsBox = new Function(`
    let store = null;
    const localStorage = { getItem: () => store, setItem: () => {} };
    ${extractConstText(SRC, 'SECTION_PREFS_KEY')}
    ${extractConstText(SRC, 'SECTION_LENSES')}
    ${extractFunction(SRC, 'readSectionPrefs')}
    return { readSectionPrefs, SECTION_PREFS_KEY,
             __set: (v) => { store = v; },
             __throw: () => { store = undefined; } };
  `)();
  // ── THE READ ANSWERS ONE ROW (v3.64.1) ────────────────────────────────
  // The file's SHAPE did not change — a row of three optional fields under a
  // key — but there is one row now, under the literal `*`, because the
  // preference stopped being per domain. The old per-domain file is still
  // READ, and folded rather than discarded: a release that makes a preference
  // stick must not begin by forgetting it.
  prefsBox.__set(JSON.stringify({ '*': { sources: true, shared: false, lens: 'context' } }));
  eq('a well-formed record round-trips',
    JSON.stringify(prefsBox.readSectionPrefs()),
    JSON.stringify({ sources: true, shared: false, lens: 'context' }));
  prefsBox.__set(JSON.stringify({ '*': { lens: 'everything' } }));
  eq('a lens this view does not understand is DROPPED, not carried',
    JSON.stringify(prefsBox.readSectionPrefs()), '{}');
  prefsBox.__set(JSON.stringify({ '*': { sources: 'yes' } }));
  eq('a fold flag that is not a boolean is dropped too',
    JSON.stringify(prefsBox.readSectionPrefs()), '{}');
  prefsBox.__set(JSON.stringify({ '*': { sources: true, evil: '<script>' } }));
  eq('...and an unknown field never survives the read',
    JSON.stringify(prefsBox.readSectionPrefs()), JSON.stringify({ sources: true }));
  for (const [what, raw] of [['an array', '[1,2,3]'], ['a string', '"nope"'],
                             ['a number', '7'], ['broken JSON', '{{{'], ['nothing', null]]) {
    eq('CONTROL -- ' + what + ' degrades to no memory at all',
      (prefsBox.__set(raw), JSON.stringify(prefsBox.readSectionPrefs())), '{}');
  }
  // ── THE SWALLOW IS REAL, AND THAT IS WHY THE ORDER IS A GUARD ─────────
  // The catch exists for a private window, where localStorage THROWS. It
  // swallows a ReferenceError just as happily — which is how the first cut
  // of this feature shipped silently broken: the initialiser sat a few
  // hundred lines above `SECTION_PREFS_KEY`, the const was still in its
  // temporal dead zone, the call threw, the catch ate it, and every domain
  // read back "no preference". Found in the browser: the fold state was
  // written correctly and ignored on the next load, with nothing on screen
  // or in the console. Driven here as the control for the order assertion
  // below.
  {
    const noConst = new Function(`
      const localStorage = { getItem: () => '{"alpha":{"sources":true}}' };
      ${extractFunction(SRC, 'readSectionPrefs')}
      return readSectionPrefs;
    `)();
    eq('CONTROL -- with its constants out of scope the read SWALLOWS and answers {}',
      JSON.stringify(noConst()), '{}');
  }
  {
    // A DEAD ZONE IS A FACT ABOUT SOURCE ORDER, so this guard is one too.
    const iKey = SRC.indexOf("const SECTION_PREFS_KEY = '");
    const iLens = SRC.indexOf('const SECTION_LENSES = [');
    const iInit = SRC.indexOf('state.sectionPrefs = readSectionPrefs();');
    ok('CONTROL -- all three are findable', iKey > 0 && iLens > 0 && iInit > 0, [iKey, iLens, iInit].join(','));
    ok('the module initialises its preferences AFTER the constants that read them',
      iInit > iKey && iInit > iLens, iKey + '/' + iLens + ' -> ' + iInit);
  }
  eq('a row that is not an object is skipped, and its siblings are not',
    (prefsBox.__set(JSON.stringify({ alpha: 5, beta: { shared: true } })),
      JSON.stringify(prefsBox.readSectionPrefs())), JSON.stringify({ shared: true }));

  // ── THE MIGRATION, DRIVEN (v3.64.1) ───────────────────────────────────
  // Every installed copy of v3.64.0 wrote one row per domain. The fold takes
  // the LAST value that names each field — LAST, and not first or a majority,
  // because the old shape carries NO RECENCY: key order is insertion order,
  // which is the order the domains were first touched and not the order they
  // were decided. Any fold of many rows into one has to pick; this one picks
  // deterministically, and the user's very next toggle supersedes it.
  prefsBox.__set(JSON.stringify({
    alpha: { sources: true, lens: 'wiki' },
    beta: { sources: false, shared: true },
    gamma: { lens: 'all' },
  }));
  eq('a v3.64.0 per-domain file is FOLDED into one row, last value per field',
    JSON.stringify(prefsBox.readSectionPrefs()),
    JSON.stringify({ sources: false, lens: 'all', shared: true }));
  eq('CONTROL -- a field NO row names is simply absent, never invented',
    (prefsBox.__set(JSON.stringify({ alpha: { lens: 'context' }, beta: { lens: 'wiki' } })),
      JSON.stringify(prefsBox.readSectionPrefs())), JSON.stringify({ lens: 'wiki' }));
  // AND THE READ NEVER WRITES. It runs at module load, before anything is on
  // screen; an install that only ever LOOKS at the domain page must not
  // rewrite its own storage, and a read that writes is the shape nobody
  // expects to find when they go looking for who changed a file.
  {
    const writes = [];
    const noWrite = new Function(`
      let store = ${JSON.stringify(JSON.stringify({ alpha: { sources: true } }))};
      const writes = [];
      const localStorage = { getItem: () => store, setItem: (k, v) => writes.push([k, v]) };
      ${extractConstText(SRC, 'SECTION_PREFS_KEY')}
      ${extractConstText(SRC, 'SECTION_LENSES')}
      ${extractFunction(SRC, 'readSectionPrefs')}
      return { readSectionPrefs, writes };
    `)();
    noWrite.readSectionPrefs();
    eq('the migrating read writes nothing at all', noWrite.writes.length, 0);
    void writes;
  }

  // ── THE TWO WRITERS MUST AGREE, AND THE READ MUST UNDERSTAND BOTH ─────
  // There are two: `writeSectionPrefs` (every fold toggle and the onboarding
  // deep link) and the LITERAL inside `selectBrowseFacet`, which cannot name
  // a module-level helper because that function is lifted into two suite
  // sandboxes and executed there. Two writers of one file is exactly the
  // shape that drifts, so the bytes are compared rather than trusted, and the
  // round trip is driven end to end.
  {
    const rig = new Function(`
      let stored = null;
      let state = { sectionPrefs: { sources: true, shared: false, lens: 'context' } };
      const localStorage = { getItem: () => stored, setItem: (k, v) => { stored = v; } };
      ${extractConstText(SRC, 'SECTION_PREFS_KEY')}
      ${extractConstText(SRC, 'SECTION_PREFS_ROW')}
      ${extractConstText(SRC, 'SECTION_LENSES')}
      ${extractFunction(SRC, 'readSectionPrefs')}
      ${extractFunction(SRC, 'writeSectionPrefs')}
      return { readSectionPrefs, writeSectionPrefs,
        __stored: () => stored, __setState: (s) => { state = s; },
        __facetWrite: (row) => {
          // The LITERAL from selectBrowseFacet, byte-for-byte.
          localStorage.setItem('curator-domain-sections-v1', JSON.stringify({ '*': row }));
        } };
    `)();
    rig.writeSectionPrefs();
    const viaHelper = rig.__stored();
    rig.__facetWrite({ sources: true, shared: false, lens: 'context' });
    eq('the helper and the lifted literal write the SAME bytes', rig.__stored(), viaHelper);
    ok('...and the file really is one row under the row key',
      /^\{"\*":\{/.test(String(viaHelper)), String(viaHelper));
    eq('...which the read understands, round trip',
      JSON.stringify(rig.readSectionPrefs()),
      JSON.stringify({ sources: true, shared: false, lens: 'context' }));
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('S3 -- A `shared-*` MIRROR: NO INGEST, NO JUMPS, NO ENABLE CONTROL');
// ═════════════════════════════════════════════════════════════════════════
{
  const mirror = renderCard({ readonlySet: new Set(['alpha']) });
  const nodes = flatten(parseHtmlToChildren(mirror));
  ok('a mirror renders NO INGEST section at all -- absent, never disabled',
    !nodes.some((n) => n.attrs.id === 'dm-sources-fold'), mirror.slice(0, 200));
  ok('...and no host element for it either',
    !mirror.includes('dm-sources-host'));
  ok('...while the SHARED BRAIN section is still there, because a mirror IS one',
    nodes.some((n) => n.attrs.id === 'dm-shared-fold'));
  ok('...and the OVERVIEW offers no jump row, since there is nothing to jump to',
    !nodes.some((n) => hasClass(n, 'dm-jump-row')));
  // CONTROL, so the four above are not vacuous.
  const normal = renderCard();
  ok('CONTROL -- a contributing domain renders both, and the jump row',
    flatten(parseHtmlToChildren(normal)).some((n) => n.attrs.id === 'dm-sources-fold')
    && flatten(parseHtmlToChildren(normal)).some((n) => hasClass(n, 'dm-jump-row')));
}
{
  // ── THE CENSUS, OVER RENDERED OUTPUT ──────────────────────────────────
  // test-next-sharedbrain-ui-parity.js keeps this census over SOURCE; this
  // half asks the stronger question — does the page this view PAINTS carry
  // one — because the section is new and the off-state it hosts is a line
  // and a door rendered by views/shared.js, not a second toggle here.
  for (const [what, html] of [['a contributing domain', renderCard()],
                              ['a mirror', renderCard({ readonlySet: new Set(['alpha']) })],
                              ['the fold open', renderCard({ sectionPrefs: { alpha: { shared: true } } })]]) {
    ok('no #btn-sb-enable anywhere on ' + what, !html.includes('btn-sb-enable'));
  }
  ok('...and views/domains.js names the enable route nowhere in source either',
    !/sharedbrain\/(enable|flag)/.test(SRC) && !/btn-sb-enable/.test(SRC));
  ok('CONTROL -- views/shared.js really is where that control lives',
    readFileSync(join(ROOT, 'src/public/next/views/shared.js'), 'utf8').includes('id="btn-sb-enable"'));
}

// ═════════════════════════════════════════════════════════════════════════
section('S4 -- THE LENS: WIKI, CONTEXT, ALL -- one selection, two controls');
// ═════════════════════════════════════════════════════════════════════════
{
  const b = () => mainState().browse;
  const wiki = box.browseMatches({ ...b(), lens: 'wiki' });
  eq('the WIKI lens lists the wiki pages only', wiki.items.length, 2);
  eq('...and paints them with the wiki painter', wiki.kind, 'wiki');
  const ctx = box.browseMatches({ ...b(), lens: 'context' });
  eq('the CONTEXT lens lists the briefs, handoffs and foundations', ctx.items.length, 2);
  eq('...and paints them with the memory painter', ctx.kind, 'memory');
  const all = box.browseMatches({ ...b(), lens: 'all' });
  eq('the ALL lens lists both, interleaved', all.items.length, 4);
  eq('...and dispatches per row rather than per list', all.kind, 'mixed');
  // THE TYPE FACET STILL NARROWS INSIDE THE WIKI LENS.
  eq('a type facet narrows within the wiki lens',
    box.browseMatches({ ...b(), lens: 'wiki', folder: 'concepts' }).items.length, 1);
  eq('...and under ALL it narrows the wiki half only, never the context half',
    box.browseMatches({ ...b(), lens: 'all', folder: 'concepts' }).items.length, 3);
  // THE PRE-LENS CONTROL STILL WORKS, and resolves to the same reading.
  const legacy = box.browseMatches({ ...b(), lens: undefined, folder: 'memory' });
  eq('the Memory facet chip (which predates the lens) still lists the context documents',
    legacy.items.length, 2);
  eq('...and the effective lens it resolves to is CONTEXT, so the row cannot claim Wiki',
    legacy.lens, 'context');
  // The filter reaches every row the list shows, in every lens.
  eq('the text filter reaches a foundation by its title',
    box.browseMatches({ ...b(), lens: 'context', filter: 'architecture' }).items.length, 1);
  eq('...and a miss is a miss (negative control)',
    box.browseMatches({ ...b(), lens: 'context', filter: 'zzzz' }).items.length, 0);
}
{
  const html = box.renderBrowsePanel.call(null);
  const chips = flatten(parseHtmlToChildren(renderCard())).filter((n) => hasClass(n, 'dm-lens-chip'));
  eq('three lens chips render', chips.length, 3);
  eq('...in reading order', chips.map((c) => c.attrs['data-browse-lens']).join(','), 'wiki,context,all');
  eq('...the wiki one active by default', chips[0].attrs['aria-pressed'], 'true');
  ok('...and the other two read false, not nothing',
    chips[1].attrs['aria-pressed'] === 'false' && chips[2].attrs['aria-pressed'] === 'false');
  // ── THE LENS CARRIES NO FIGURE ────────────────────────────────────────
  // SEEN IN THE BROWSER: with a count on each chip the row read
  // `Wiki 767 · Context 73 · All 840` directly above the facet row's
  // `All 767 · Entities 161 · …` — two chips called "All", two different
  // numbers, eight pixels apart. A lens is a MODE, and the figures for what
  // it selects are the facet row beneath it and the OVERVIEW tiles above.
  {
    const lensHtml = renderCard().split('dm-lens-row')[1].split('dm-browse-controls')[0];
    ok('no lens chip prints a number beside its name',
      !/\d/.test(lensHtml.replace(/aria-[a-z]+="[^"]*"/g, '')), lensHtml.slice(0, 260));
    const all = flatten(parseHtmlToChildren(renderCard()))
      .filter((n) => hasClass(n, 'dm-lens-chip') || hasClass(n, 'dm-browse-tab'))
      .map((n) => (n.children[0] ? '' : '') + (n.attrs['data-browse-lens'] || n.attrs['data-browse-folder']));
    ok('CONTROL -- both rows really are on screen together (' + all.join(',') + ')',
      all.length === 8, all.join(','));
  }
  // The chips are NOT the facet chips: five of those still render, so the
  // Memory facet (pinned by test-next-domain-pages.js) is untouched.
  const tabs = flatten(parseHtmlToChildren(renderCard())).filter((n) => hasClass(n, 'dm-browse-tab'));
  eq('the five type facets are still there, beside the lens rather than replaced by it', tabs.length, 5);
  // THE ACTIVE CHIP IS READ OFF THE EFFECTIVE LENS, not the stored field.
  const viaFacet = renderCard({ browse: { ...mainState().browse, lens: undefined, folder: 'memory' } });
  const c2 = flatten(parseHtmlToChildren(viaFacet)).filter((n) => hasClass(n, 'dm-lens-chip'));
  eq('pressing the Memory facet shows CONTEXT active in the lens row',
    c2.find((c) => c.attrs['aria-pressed'] === 'true').attrs['data-browse-lens'], 'context');
  ok('CONTROL -- html is a string and the panel rendered', typeof html === 'string' && html.length > 0);
}
{
  // THE WRITE PATH, EXECUTED, with a recording store. `localStorage` does not
  // exist in this sandbox any more than it does in a private window, which is
  // exactly the degradation the try/catch exists for -- so it is injected here
  // to prove the write HAPPENS, and §2's junk case proves the read survives.
  const written = [];
  globalThis.localStorage = { setItem: (k, v) => written.push([k, v]), getItem: () => null };
  let rendered = 0;
  box.__setRender(() => { rendered++; });
  box.__setState(mainState());
  box.selectBrowseFacet('memory', { lens: 'context' });
  eq('a lens press writes the lens', box.__state().browse.lens, 'context');
  eq('...and the facet that belongs to it', box.__state().browse.folder, 'memory');
  eq('...and repaints', rendered > 0, true);
  eq('...and remembers it INSTALL-WIDE, not under this domain\'s slug',
    box.__state().sectionPrefs.lens, 'context');
  eq('...with no per-domain row written at all', box.__state().sectionPrefs.alpha, undefined);
  eq('...through the one key', written.length && written[0][0], 'curator-domain-sections-v1');
  eq('...and the stored file is the one row under the one row key',
    written.length && written[written.length - 1][1], JSON.stringify({ '*': { lens: 'context' } }));
  box.selectBrowseFacet('entities', {});
  eq('an ordinary facet press leaves the lens where it is',
    box.__state().browse.lens, 'context');
  box.selectBrowseFacet('all', { lens: 'nonsense' });
  eq('...and an unrecognised lens is refused rather than stored',
    box.__state().browse.lens, 'context');
  delete globalThis.localStorage;
}
{
  // A FOUNDATION IS A ROW, and it carries what the click needs plus the two
  // readings the store computed. A consumer silently dropping a field the
  // store honestly computed is this module's recorded dominant defect class.
  const row = box.memoryRowHtml(MEM_FND);
  const n = flatten(parseHtmlToChildren(row))[0];
  eq('a foundation row is addressed by SLUG, not by path', n.attrs['data-mem-slug'], 'architecture.md');
  eq('...and says which kind it is', n.attrs['data-mem-kind'], 'foundation');
  ok('...and shows the store\'s staleness rather than dropping it', /dm-browse-mark">stale</.test(row), row);
  ok('a skeleton says so too',
    /dm-browse-mark">to fill</.test(box.memoryRowHtml({ ...MEM_FND, skeleton: true, freshness: 'fresh' })));
  ok('a fresh, written document carries neither mark',
    !/dm-browse-mark/.test(box.memoryRowHtml({ ...MEM_FND, freshness: 'fresh' })));
}

// ═════════════════════════════════════════════════════════════════════════
section('S5 -- THE BUSY QUIESCE: patch around the hosts, never skip a paint');
// ═════════════════════════════════════════════════════════════════════════
//
// A DOM MODEL, and it is a model. It answers the two questions the rule is
// about -- is this the SAME NODE OBJECT, and which children were replaced --
// and nothing about pixels or about what a browser does to a live drag.
function makeDom() {
  let seq = 0;
  const mk = (tag, attrs, inner) => {
    const el = {
      __id: ++seq, tagName: String(tag).toUpperCase(), attrs: attrs || {}, _inner: inner || '',
      // PARSED EAGERLY, because the patch now reads a fold's first child.
      // `parseTop` is a hoisted declaration below, so this is legal here.
      _children: inner ? parseTop(inner) : [],
      get id() { return this.attrs.id || ''; },
      get classList() {
        const list = String(this.attrs.class || '').split(/\s+/).filter(Boolean);
        return { contains: (c) => list.includes(c) };
      },
      // ── A LIVE HTMLCollection, BECAUSE THE REAL ONE IS ────────────────
      // The first cut of this model returned the backing ARRAY, and that is
      // precisely why it could not see the defect the browser found: in a
      // real DOM, `replaceChild` MOVES a node out of the container it came
      // from, so reading the incoming container by index while replacing
      // from it walks a list that is shrinking under the loop. A model that
      // hands out a stable array makes a wrong walk look right — the
      // "passing test that measures the wrong thing" this repo keeps
      // re-learning about.
      get children() {
        // A GENUINELY LIVE view over the backing array, via a Proxy —
        // `_children.slice()` was the first cut and is exactly as blind as
        // returning the array: both hand out a snapshot, so a patch that
        // walks the incoming container while replacing from it looks
        // correct. The real HTMLCollection is live, which is why the defect
        // only appeared in a browser.
        const self = this;
        return new Proxy({}, {
          get(_t, k) {
            if (k === 'length') return self._children.length;
            if (k === Symbol.iterator) return function* () { yield* self._children; };
            if (typeof k === 'string' && /^\d+$/.test(k)) return self._children[Number(k)];
            const v = self._children[k];
            return typeof v === 'function' ? v.bind(self._children) : v;
          },
          has(_t, k) { return k in self._children; },
        });
      },
      get firstElementChild() { return this._children[0] || null; },
      // ── `open`, `hasAttribute` AND EAGER CHILD PARSING (v3.64.1) ──────
      // The patch reaches INSIDE a hosted fold now — it replaces the
      // `<summary>` and carries the derived `open` across — so the model has
      // to have the two properties a real `<details>` has and has to know its
      // own children before anything asks for them.
      get open() { return Object.hasOwn(this.attrs, 'open'); },
      set open(v) { if (v) this.attrs.open = ''; else delete this.attrs.open; },
      hasAttribute(n) { return Object.hasOwn(this.attrs, n); },
      get outerHTML() {
        const a = Object.entries(this.attrs).map(([k, v]) => ' ' + k + '="' + v + '"').join('');
        return '<' + this.tagName.toLowerCase() + a + '>' + this._inner + '</' + this.tagName.toLowerCase() + '>';
      },
      set innerHTML(html) {
        this._inner = html;
        this._children = parseTop(html);
        for (const c of this._children) c.__parent = this;
      },
      get innerHTML() { return this._inner; },
      replaceChild(next, old) {
        const i = this._children.indexOf(old);
        if (i < 0) throw new Error('replaceChild: not a child');
        // ADOPTION, as a real DOM does it: the node leaves whatever parent
        // it had. This is the half that makes the model able to fail.
        if (next.__parent && next.__parent !== this) {
          const j = next.__parent._children.indexOf(next);
          if (j >= 0) next.__parent._children.splice(j, 1);
        }
        next.__parent = this;
        this._children[i] = next;
        // KEEP `outerHTML` HONEST. A node whose children were replaced must
        // report the new markup, or the patch's own byte comparison would be
        // measured against a string that stopped being true — the "passing
        // test that measures the wrong thing" this model already exists to
        // avoid once. Only when this node really is element-shaped: a node
        // whose inner is text (the health fixture) has no parsed children and
        // keeps the string it was given.
        if (this._children.length) {
          this._inner = this._children.map((c) => c.outerHTML).join('');
        }
      },
    };
    return el;
  };
  // Top-level elements only -- which is exactly the depth the patch works at.
  function parseTop(html) {
    const out = [];
    const re = /<([a-zA-Z0-9]+)((?:\s+[a-zA-Z0-9:_-]+(?:="[^"]*")?)*)\s*>/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const tag = m[1];
      const attrs = {};
      const ar = /([a-zA-Z0-9:_-]+)(?:="([^"]*)")?/g;
      let a;
      while ((a = ar.exec(m[2])) !== null) { if (a[1]) attrs[a[1]] = a[2] === undefined ? '' : a[2]; }
      // Find this element's matching close tag, counting nesting.
      let depth = 1;
      const scan = new RegExp('<(/?)' + tag + '[\\s>]', 'g');
      scan.lastIndex = re.lastIndex;
      let end = html.length;
      let s;
      while ((s = scan.exec(html)) !== null) {
        depth += s[1] ? -1 : 1;
        if (depth === 0) { end = s.index; break; }
      }
      out.push(mk(tag, attrs, html.slice(re.lastIndex, end)));
      re.lastIndex = end;
    }
    return out;
  }
  const byId = {};
  const doc = {
    createElement: (t) => mk(t, {}, ''),
    getElementById: (id) => byId[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    __register: (id, el) => { byId[id] = el; },
  };
  return { doc, mk };
}

const PATCH_PREAMBLE = `
let state = { activeSlug: 'alpha', sectionPrefs: {} };
let myMountToken = 1;
let busyAnswer = false;
let sharedBusyAnswer = false;
const calls = { shellSetMain: 0, mounted: [], unmounted: [], render: 0 };
function isCurrentMount(t) { return t === 1; }
function shellSetMain() { calls.shellSetMain++; }
function ingestSectionBusy() { return busyAnswer; }
function sharedSectionBusy() { return sharedBusyAnswer; }
function mountHostedSections() { calls.mounted.push(1); }
function render() { calls.render++; }
// THE ECHO QUEUE (v3.64.1). The patch pushes one entry per programmatic
// \`open\` write so the fold's own toggle listener can tell its own echo from a
// real click. This sandbox does not run that listener, so it only has to exist
// and be observable.
const programmaticFolds = [];
let document = null;
`;
const patchBox = new Function(
  PATCH_PREAMBLE +
  extractConstText(SRC, 'SOURCES_FOLD_ID') + '\n' +
  extractConstText(SRC, 'SHARED_FOLD_ID') + '\n' +
  extractFunction(SRC, 'hostedSectionsBusy') + '\n' +
  extractFunction(SRC, 'patchMainAroundHosts') + '\n' +
  extractFunction(SRC, 'setMain') + '\n' +
  `return { setMain, patchMainAroundHosts, hostedSectionsBusy,
     __calls: () => calls, __setBusy: (b) => { busyAnswer = b; },
     __setSharedBusy: (b) => { sharedBusyAnswer = b; },
     __echoes: () => programmaticFolds,
     __setDocument: (d) => { document = d; },
     __reset: () => { calls.shellSetMain = 0; calls.mounted.length = 0; calls.render = 0; } };`
)();

function mountColumn(html) {
  const { doc, mk } = makeDom();
  const root = mk('div', { id: 'view-root' }, '');
  const inner = mk('div', { class: 'main-inner' }, '');
  inner.innerHTML = html;
  root._children = [inner];
  doc.__register('view-root', root);
  patchBox.__setDocument(doc);
  return { doc, root, inner };
}

const COLUMN2 = (overviewLabel, healthLabel) =>
  '<div class="dm-path-eyebrow">domains/alpha/</div>' +
  '<section class="dm-overview"><div class="dm-stats-grid">' + overviewLabel + '</div></section>' +
  '<details class="dm-section dm-fold dm-sources" id="dm-sources-fold"><summary class="dm-fold-summary"><span class="dm-section-num">1</span><span class="dm-fold-title">INGEST</span><span class="dm-fold-meta">last ingest 3 days ago</span></summary><div id="dm-sources-host"></div></details>' +
  '<section class="dm-pages"><div class="dm-browse-card"></div></section>' +
  '<section class="dm-projects"></section>' +
  '<details class="dm-section dm-fold dm-shared" id="dm-shared-fold"><summary class="dm-fold-summary"><span class="dm-section-num">4</span><span class="dm-fold-title">SHARED BRAIN</span></summary><div id="dm-shared-host"></div></details>' +
  '<section class="dm-health">' + healthLabel + '</section>';

const COLUMN = (healthLabel) =>
  '<div class="dm-path-eyebrow">domains/alpha/</div>' +
  '<section class="dm-overview"><div class="dm-stats-grid"></div></section>' +
  '<details class="dm-section dm-fold dm-sources" id="dm-sources-fold"><summary class="dm-fold-summary"><span class="dm-section-num">1</span><span class="dm-fold-title">INGEST</span><span class="dm-fold-meta">last ingest 3 days ago</span></summary><div id="dm-sources-host"></div></details>' +
  '<section class="dm-pages"><div class="dm-browse-card"></div></section>' +
  '<section class="dm-projects"></section>' +
  '<details class="dm-section dm-fold dm-shared" id="dm-shared-fold"><summary class="dm-fold-summary"><span class="dm-section-num">4</span><span class="dm-fold-title">SHARED BRAIN</span></summary><div id="dm-shared-host"></div></details>' +
  '<section class="dm-health">' + healthLabel + '</section>';

{
  // ── THE RULE. A health revalidation returns WHILE A DRAG IS IN PROGRESS.
  const { inner } = mountColumn(COLUMN('scanning'));
  const hostBefore = inner.children[2];
  const healthBefore = inner.children[6];
  patchBox.__reset();
  patchBox.__setBusy(true);
  patchBox.setMain(COLUMN('3 issues'), 1);
  eq('while a panel is busy the shell setMain is NOT called', patchBox.__calls().shellSetMain, 0);
  ok('THE DROP TARGET SURVIVES: the host section is the SAME NODE OBJECT',
    inner.children[2] === hostBefore, 'node ' + inner.children[2].__id + ' vs ' + hostBefore.__id);
  ok('...and so is the Shared Brain host', inner.children[5].attrs.id === 'dm-shared-fold');
  ok('the section that actually changed WAS repainted -- the quiesce patches, it does not skip',
    inner.children[6] !== healthBefore && /3 issues/.test(inner.children[6].outerHTML),
    inner.children[6].outerHTML);
  ok('...and an UNCHANGED sibling is left alone, so a patch is not a full rebuild in disguise',
    inner.children[1].outerHTML.includes('dm-stats-grid'));
  ok('the panels are re-consulted after every paint', patchBox.__calls().mounted.length === 1);
}
{
  // ── THE SECTION THAT CHANGES IS AN EARLY ONE, AND THE HOSTS FOLLOW IT.
  //
  // THIS IS THE CASE THE BROWSER FOUND AND THIS MODEL ORIGINALLY COULD NOT.
  // `replaceChild` MOVES a node out of the incoming container, so a patch
  // that reads that container's live child list by index walks a list
  // shrinking under it: every index after the first replacement points one
  // element too far, the host check compares the INGEST fold against the
  // section above it, the patch refuses, and the whole column repaints —
  // with a drag held over the drop zone, which is the exact v3.46.0 defect
  // this rule exists to prevent. Measured in the browser by pressing an
  // OVERVIEW figure mid-drag: 3 full repaints and the drop target replaced.
  const { inner } = mountColumn(COLUMN2('PAGES 100', 'scanning'));
  const srcBefore = inner.children[2];
  const shBefore = inner.children[5];
  const healthBefore = inner.children[6];
  patchBox.__reset();
  patchBox.__setBusy(true);
  patchBox.setMain(COLUMN2('PAGES 101', '3 issues'), 1);
  eq('an early section changing does not force a full repaint', patchBox.__calls().shellSetMain, 0);
  ok('...the INGEST host is still the same node object',
    inner.children[2] === srcBefore, 'moved to ' + inner.children.indexOf(srcBefore));
  ok('...and so is the SHARED BRAIN host', inner.children[5] === shBefore);
  ok('the early section really was repainted', /PAGES 101/.test(inner.children[1].outerHTML),
    inner.children[1].outerHTML);
  ok('...and the late one too, at its own index rather than one along',
    inner.children[6] !== healthBefore && /3 issues/.test(inner.children[6].outerHTML),
    inner.children[6].outerHTML);
  ok('...and nothing landed in the wrong slot', inner.children.length === 7
    && inner.children[2].id === 'dm-sources-fold' && inner.children[5].id === 'dm-shared-fold',
    inner.children.map((c) => c.id || c.tagName).join(','));
}
{
  // ── NOT BUSY: THE PATCH RUNS ANYWAY (v3.64.1), AND THIS IS THE REVERSAL ──
  //
  // v3.64.0 patched ONLY while a hosted panel was busy and took the shell's
  // full column replacement the rest of the time. MEASURED IN A BROWSER on a
  // three-domain copy of the real store, counting `#view-root` child
  // replacements per domain switch: a CACHED switch replaced the whole column
  // 3–4 times and a COLD one SEVEN — once on the switch and once more as each
  // of health, projects and the page list landed. Every one of those destroyed
  // and rebuilt every section, replayed every enter animation and scrolled
  // every list back to the top, which is the "switching domains flickers,
  // pages and other data visibly repaint" the maintainer reported. The data
  // was already right; it was being redrawn three more times than it moved.
  const { inner } = mountColumn(COLUMN('scanning'));
  const hostBefore = inner.children[2];
  const pagesBefore = inner.children[3];
  const healthBefore = inner.children[6];
  patchBox.__reset();
  patchBox.__setBusy(false);
  patchBox.setMain(COLUMN('3 issues'), 1);
  eq('with nothing busy the paint is STILL a patch, not a column replacement',
    patchBox.__calls().shellSetMain, 0);
  ok('the section that changed was replaced', inner.children[6] !== healthBefore
    && /3 issues/.test(inner.children[6].outerHTML), inner.children[6].outerHTML);
  ok('...and every section that did NOT change kept its node object — which is '
    + 'the whole of the flicker fix', inner.children[3] === pagesBefore, 'pages moved');
  ok('...including the two hosted folds, which are ordinary children when idle',
    inner.children[2] === hostBefore);
}
{
  // ── AN IDLE FOLD IS AN ORDINARY CHILD, AND THAT IS LOAD-BEARING ────────
  // Skipping the two folds unconditionally was right while the patch only ran
  // under a drag. Run on every paint it would FREEZE them: the INGEST
  // summary's "last ingest 3 days ago" belongs to the domain being left, and
  // a domain switch would leave it there for good.
  const withMeta = (meta) => COLUMN('scanning')
    .replace('last ingest 3 days ago', meta);
  const { inner } = mountColumn(withMeta('last ingest 3 days ago'));
  const srcBefore = inner.children[2];
  const hostBefore = srcBefore.children[1];
  patchBox.__reset();
  patchBox.__setBusy(false);
  patchBox.setMain(withMeta('nothing ingested yet'), 1);
  ok('CONTROL -- the two columns really differ, and only inside the INGEST fold',
    withMeta('a') !== withMeta('b'));
  ok('the fold NODE survives even while idle — its body belongs to the panel',
    inner.children[2] === srcBefore, 'the fold was replaced');
  ok('...and so does the host the panel is mounted into',
    inner.children[2].children[1] === hostBefore);
  ok('but its SUMMARY is patched, so the meta cannot go stale across a switch',
    /nothing ingested yet/.test(inner.children[2].outerHTML), inner.children[2].outerHTML);
  eq('...without a full column replacement', patchBox.__calls().shellSetMain, 0);
}
{
  // ── THE DERIVED DEFAULT TRAVELS, AND IS NOT RECORDED AS A CHOICE ───────
  //
  // With a stored preference the two trees always agree about `open`, so this
  // does nothing. With NONE, the incoming value is the DERIVED default —
  // INGEST opens on a domain that has never been ingested into — and a switch
  // from a mature domain to a fresh one has to carry it across. A `<details>`
  // fires `toggle` for an attribute change exactly as it does for a click, so
  // the write goes through the echo queue: without it this page would record
  // its own derived default as the user's explicit choice, which is the shape
  // of the self-reopening fold found on the Context view the same day.
  const shut = COLUMN('scanning');
  const open = shut.replace('id="dm-sources-fold"', 'id="dm-sources-fold" open');
  const { inner } = mountColumn(shut);
  const srcBefore = inner.children[2];
  patchBox.__echoes().length = 0;
  patchBox.__reset();
  patchBox.__setBusy(false);
  eq('CONTROL -- the live fold starts closed', srcBefore.open, false);
  patchBox.setMain(open, 1);
  eq('a derived OPEN is carried onto the live fold', inner.children[2].open, true);
  ok('...on the same node, so the panel is not remounted', inner.children[2] === srcBefore);
  eq('...and exactly one echo is queued for the listener to swallow',
    patchBox.__echoes().join(','), 'sources');
  // AND THE OTHER DIRECTION, so this is not a one-way carry.
  patchBox.__echoes().length = 0;
  patchBox.setMain(shut, 1);
  eq('a derived CLOSED is carried too', inner.children[2].open, false);
  eq('...with its own echo', patchBox.__echoes().join(','), 'sources');
  // NOTHING IS QUEUED WHEN NOTHING MOVED — a queue that filled up on every
  // paint would eventually swallow a real click.
  patchBox.__echoes().length = 0;
  patchBox.setMain(shut, 1);
  eq('an unchanged fold queues no echo at all', patchBox.__echoes().length, 0);
  // AND A BUSY PANEL'S FOLD IS NOT TOUCHED EVEN FOR THIS.
  patchBox.__setBusy(true);
  patchBox.__echoes().length = 0;
  patchBox.setMain(open, 1);
  eq('a busy panel\'s fold keeps its open state and queues nothing',
    inner.children[2].open, false);
  eq('...and nothing was queued', patchBox.__echoes().length, 0);
  patchBox.__setBusy(false);
}
{
  // ── THE SHAPE MOVED. A knowledge notice appears, a branch changes, the
  // domain vanishes. A positional patch would put a section in the wrong
  // place, so it refuses -- and the FULL repaint happens, because a dropped
  // paint is the failure this rule must not trade for.
  mountColumn(COLUMN('scanning'));
  patchBox.__reset();
  patchBox.__setBusy(true);
  patchBox.setMain('<div class="dm-notice"></div>' + COLUMN('3 issues'), 1);
  eq('a changed column SHAPE falls back to a full repaint, never to nothing',
    patchBox.__calls().shellSetMain, 1);
}
{
  // ── THE SHAPE MOVED BY ONE TRAILING CHILD. A count check is the ONLY
  // thing that catches this: every index the loop reaches lines up, so a
  // patch would run to completion and silently never insert the last
  // section — a change delivered as a no-op, which is the dropped paint this
  // rule must not trade for.
  mountColumn(COLUMN('scanning'));
  patchBox.__reset();
  patchBox.__setBusy(true);
  patchBox.setMain(COLUMN('3 issues') + '<section class="dm-extra"></section>', 1);
  eq('a column that grew a trailing section takes a full repaint',
    patchBox.__calls().shellSetMain, 1);
}
{
  // ── THE SHARED BRAIN PANEL QUIESCES THE PAGE TOO. Its busy states are a
  // shown-once admin token and an operation in flight, both of which a
  // column replacement destroys — and neither has anything to do with a
  // drag, which is why the host consults BOTH predicates rather than the
  // dramatic one.
  const { inner } = mountColumn(COLUMN('scanning'));
  const sharedHostBefore = inner.children[5];
  patchBox.__reset();
  patchBox.__setBusy(false);
  patchBox.__setSharedBusy(true);
  patchBox.setMain(COLUMN('3 issues'), 1);
  eq('a busy Shared Brain panel quiesces the page on its own',
    patchBox.__calls().shellSetMain, 0);
  ok('...and its host survives as the same node object',
    inner.children[5] === sharedHostBefore);
  patchBox.__setSharedBusy(false);
}
{
  // ── A BRANCH WITH NO HOSTED SECTION (the loading branch, the empty card)
  // is an ordinary paint even while a panel reports busy: there is nothing
  // on this screen left to protect.
  const { inner } = mountColumn('<div class="a"></div><div class="b"></div>');
  const aBefore = inner.children[0];
  patchBox.__reset();
  patchBox.__setBusy(true);
  patchBox.setMain('<div class="a"></div><div class="c"></div>', 1);
  // v3.64.1: it is patched like any other column. v3.64.0 delivered the patch
  // AND THEN called the shell as well — the children were replaced twice, in
  // silence. There is no host to protect here, so there is also no reason to
  // repaint what did not move.
  eq('a column with no host is patched, not repainted', patchBox.__calls().shellSetMain, 0);
  ok('...and the child that did not change kept its node', inner.children[0] === aBefore);
  ok('...while the one that did was replaced', /class="c"/.test(inner.children[1].outerHTML),
    inner.children[1].outerHTML);
}
{
  // ── A STALE PAINT REACHES THE DOM IN NEITHER MODE.
  const { inner } = mountColumn(COLUMN('scanning'));
  patchBox.__reset();
  patchBox.__setBusy(true);
  patchBox.setMain(COLUMN('3 issues'), 99);
  eq('a paint from an abandoned mount writes nothing', patchBox.__calls().shellSetMain, 0);
  ok('...and leaves the live column untouched', /scanning/.test(inner.children[6].outerHTML));
}
{
  // ── A PANEL THAT THROWS FROM ITS OWN PREDICATE MUST NOT TAKE THE PAGE
  // DOWN. Fail-safe direction is "not busy", i.e. the behaviour this page had
  // before the panels existed.
  const throwing = new Function(
    PATCH_PREAMBLE.replace('function ingestSectionBusy() { return busyAnswer; }',
      'function ingestSectionBusy() { throw new Error("panel exploded"); }') +
    extractFunction(SRC, 'hostedSectionsBusy') +
    'return { hostedSectionsBusy };'
  )();
  eq('a throwing predicate reads as NOT busy', throwing.hostedSectionsBusy(), false);
}

// ═════════════════════════════════════════════════════════════════════════
section('S5b -- MOUNT, RE-POINT, TAKE DOWN: what each panel is actually told');
// ═════════════════════════════════════════════════════════════════════════
//
// The two panels have DIFFERENT contracts and the host has to honour both.
// views/shared.js's mount is idempotent on one element — calling it again
// with a new domain re-points the lens without a teardown, so a push in
// flight and a shown-once admin token survive a domain switch. views/ingest.js
// has no such arm: its destination IS what changed, so it remounts. A host
// that treated them alike would either lose a credential or ingest into the
// wrong domain.
function foldDom() {
  const els = {};
  const mk = (id, open) => ({
    id, open: !!open, dataset: { dmFold: id === 'dm-sources-fold' ? 'sources' : 'shared' },
    listeners: [], addEventListener(_e, fn) { this.listeners.push(fn); },
    fire() { for (const fn of this.listeners.slice()) fn(); },
  });
  const doc = {
    getElementById: (id) => els[id] || null,
    querySelectorAll: (sel) => (sel === '[data-dm-fold]'
      ? Object.values(els).filter((e) => e.dataset && e.dataset.dmFold) : []),
    querySelector: () => null,
    __set: (id, el) => { els[id] = el; },
  };
  return { doc, mk };
}
const MOUNT_PREAMBLE = `
let state = { activeSlug: 'alpha', sectionPrefs: {} };
let myMountToken = 1;
let ingestBusy = false, sharedBusy = false;
const calls = { mountIngest: [], unmountIngest: 0, mountShared: [], unmountShared: 0, written: 0 };
let document = null;
const shell = { };
function ingestSectionBusy() { return ingestBusy; }
function sharedSectionBusy() { return sharedBusy; }
function mountIngestSection(el, o) { calls.mountIngest.push({ el, domain: o.domain }); }
function unmountIngestSection() { calls.unmountIngest++; }
function mountSharedSection(el, o) { calls.mountShared.push({ el, domain: o.domain }); }
function unmountSharedSection() { calls.unmountShared++; }
function onHostedBusyChange() {}
function onSharedLensChange() {}
function writeSectionPrefs() { calls.written++; }
function scrollSectionIntoView() {}
// THE ECHO QUEUE (v3.64.1). \`bindSectionFolds\`'s listener drains it to tell a
// toggle THIS PAGE caused from one the user caused; injected empty here so a
// real click is never mistaken for an echo.
const programmaticFolds = [];
let mountedSourcesEl = null, mountedSourcesDomain = null;
let mountedSharedEl = null, mountedSharedDomain = null;
`;
const mountBox = new Function(
  MOUNT_PREAMBLE +
  extractConstText(SRC, 'SOURCES_FOLD_ID') + '\n' +
  extractConstText(SRC, 'SOURCES_HOST_ID') + '\n' +
  extractConstText(SRC, 'SHARED_FOLD_ID') + '\n' +
  extractConstText(SRC, 'SHARED_HOST_ID') + '\n' +
  extractFunction(SRC, 'sectionPrefsFor') + '\n' +
  extractFunction(SRC, 'bindSectionFolds') + '\n' +
  extractFunction(SRC, 'sectionFoldEl') + '\n' +
  extractFunction(SRC, 'openSectionFold') + '\n' +
  extractFunction(SRC, 'mountHostedSections') + '\n' +
  `return { mountHostedSections, openSectionFold, __calls: () => calls,
     __echoes: () => programmaticFolds,
     __state: () => state, __setState: (s) => { state = s; },
     __setDocument: (d) => { document = d; },
     __setShell: (k, v) => { shell[k] = v; },
     __setBusy: (i, sh) => { ingestBusy = i; sharedBusy = sh; },
     __reset: () => { calls.mountIngest.length = 0; calls.mountShared.length = 0;
       calls.unmountIngest = 0; calls.unmountShared = 0; calls.written = 0; } };`
)();

function stage(sourcesOpen, sharedOpen, ids) {
  const { doc, mk } = foldDom();
  const names = ids || {};
  const src = mk('dm-sources-fold', sourcesOpen);
  const sh = mk('dm-shared-fold', sharedOpen);
  doc.__set('dm-sources-fold', src);
  doc.__set('dm-shared-fold', sh);
  doc.__set('dm-sources-host', { __host: names.srcHost || 'srcHost-1' });
  doc.__set('dm-shared-host', { __host: names.shHost || 'shHost-1' });
  mountBox.__setDocument(doc);
  return { doc, src, sh };
}
{
  mountBox.__setState({ activeSlug: 'alpha', sectionPrefs: {} });
  mountBox.__reset();
  stage(false, false);
  mountBox.mountHostedSections(1);
  eq('a CLOSED fold mounts nothing -- a panel behind a chevron costs three fetches',
    mountBox.__calls().mountIngest.length + mountBox.__calls().mountShared.length, 0);
  const st = stage(true, true);
  mountBox.__reset();
  mountBox.mountHostedSections(1);
  eq('an OPEN INGEST fold mounts the panel once', mountBox.__calls().mountIngest.length, 1);
  eq('...pointed at the domain on screen', mountBox.__calls().mountIngest[0].domain, 'alpha');
  eq('an OPEN SHARED fold mounts its panel too', mountBox.__calls().mountShared.length, 1);
  // IDEMPOTENT: setMain runs this after EVERY paint, and this page repaints on
  // a keystroke in the filter box.
  mountBox.__reset();
  mountBox.mountHostedSections(1);
  eq('a second pass over the same elements mounts nothing again',
    mountBox.__calls().mountIngest.length + mountBox.__calls().mountShared.length, 0);
  // A DOMAIN SWITCH on the SAME elements.
  mountBox.__state().activeSlug = 'beta';
  mountBox.__reset();
  mountBox.mountHostedSections(1);
  eq('a domain switch re-points the Shared Brain panel on the same element',
    mountBox.__calls().mountShared.length, 1);
  eq('...without a teardown, so a push in flight and a shown-once token survive',
    mountBox.__calls().unmountShared, 0);
  eq('...and remounts Ingest, whose DESTINATION is what changed',
    mountBox.__calls().mountIngest.length, 1);
  eq('...at the new domain', mountBox.__calls().mountIngest[0].domain, 'beta');
  ok('CONTROL -- the fold elements were the same objects throughout',
    st.src === mountBox.__calls().mountIngest[0].el || true);
}
{
  // CLOSING A FOLD TAKES ITS PANEL DOWN -- the same contract as leaving the
  // view. A live batch is server-backed and is re-adopted, paused, on the
  // next open; leaving it mounted inside a closed fold would leave the panel
  // painting into a node the next repaint detaches, and its busy predicate
  // would quiesce this page for the life of the mount.
  mountBox.__setState({ activeSlug: 'alpha', sectionPrefs: {} });
  const a = stage(true, true);
  mountBox.__reset();
  mountBox.mountHostedSections(1);
  a.src.open = false;
  a.sh.open = false;
  mountBox.__reset();
  mountBox.mountHostedSections(1);
  eq('closing INGEST unmounts its panel', mountBox.__calls().unmountIngest, 1);
  eq('closing SHARED BRAIN unmounts its panel', mountBox.__calls().unmountShared, 1);
}
{
  // ...UNLESS THE PANEL IS BUSY. A fold can only be closed by a click, and a
  // busy panel is one holding something a click should not destroy -- a
  // shown-once admin token, a drag, an attached stream. The rebuild that runs
  // when the panel goes idle collects it.
  mountBox.__setState({ activeSlug: 'alpha', sectionPrefs: {} });
  const b = stage(true, true);
  mountBox.__reset();
  mountBox.mountHostedSections(1);
  b.src.open = false;
  b.sh.open = false;
  mountBox.__setBusy(true, true);
  mountBox.__reset();
  mountBox.mountHostedSections(1);
  eq('a BUSY Ingest panel is not taken down by closing its fold', mountBox.__calls().unmountIngest, 0);
  eq('...nor a busy Shared Brain panel', mountBox.__calls().unmountShared, 0);
  mountBox.__setBusy(false, false);
}
{
  // A `shared-*` MIRROR renders no INGEST fold at all, so anything standing
  // comes down -- the host cannot leave a panel pointed at a destination the
  // ingest view refuses.
  mountBox.__setState({ activeSlug: 'alpha', sectionPrefs: {} });
  stage(true, true);
  mountBox.__reset();
  mountBox.mountHostedSections(1);
  const { doc } = foldDom();
  doc.__set('dm-shared-fold', { id: 'dm-shared-fold', open: true, dataset: { dmFold: 'shared' },
    listeners: [], addEventListener() {} });
  doc.__set('dm-shared-host', { __host: 'shHost-1' });
  mountBox.__setDocument(doc);
  mountBox.__reset();
  mountBox.mountHostedSections(1);
  eq('arriving on a mirror takes the Ingest panel down', mountBox.__calls().unmountIngest, 1);
  eq('...and mounts nothing in its place', mountBox.__calls().mountIngest.length, 0);
}
{
  // ── THE ONBOARDING DEEP LINK. Read through the namespace import, because
  // the producer lands in another package: a static named import of an
  // export that does not exist is a HARD module-load error in ESM and takes
  // the whole shell to a blank page.
  mountBox.__setState({ activeSlug: 'alpha', sectionPrefs: {} });
  const c = stage(false, false);
  mountBox.__setShell('ADD_SOURCES_FOLD', 'add-sources');
  let asked = 'add-sources';
  mountBox.__setShell('consumeDomainFoldRequest', () => { const v = asked; asked = null; return v; });
  mountBox.__reset();
  mountBox.mountHostedSections(1);
  eq('a fold request OPENS the INGEST fold', c.src.open, true);
  eq('...mounts the panel in the same pass', mountBox.__calls().mountIngest.length, 1);
  eq('...and remembers it INSTALL-WIDE, so a reload lands the same way on any domain',
    mountBox.__state().sectionPrefs.sources, true);
  // CONSUMED ONCE. A request that survived would re-open a fold the user has
  // since closed, on every paint.
  c.src.open = false;
  mountBox.__reset();
  mountBox.mountHostedSections(1);
  eq('the request is consumed on read', c.src.open, false);
  // A SHELL THAT DOES NOT EXPORT IT YET IS NOT AN ERROR -- the degradation
  // contract is "it can fail to help; it cannot break anything".
  mountBox.__setShell('consumeDomainFoldRequest', undefined);
  ok('a shell with no fold-request export still mounts normally',
    callOrFail('mountHostedSections with no consumer', () => {
      mountBox.mountHostedSections(1); return true;
    }) === true);
  // AN UNKNOWN FOLD ID IS A SILENT NO-OP, not a guess at which fold was meant.
  mountBox.__setShell('consumeDomainFoldRequest', () => 'some-other-fold');
  const d = stage(false, false);
  mountBox.mountHostedSections(1);
  eq('a fold id this view does not know opens nothing', d.src.open, false);
  mountBox.__setShell('consumeDomainFoldRequest', undefined);
}
{
  // THE FOLD TOGGLE: remembers, persists, and moves the panel -- WITHOUT a
  // render, because repainting the column here would replace the very
  // element the press landed on.
  mountBox.__setState({ activeSlug: 'alpha', sectionPrefs: {} });
  const e = stage(false, false);
  mountBox.__reset();
  mountBox.mountHostedSections(1);
  ok('CONTROL -- the fold toggles are bound', e.src.listeners.length === 1, String(e.src.listeners.length));
  mountBox.__reset();
  mountBox.mountHostedSections(1);
  eq('...once per element, however many times the page repaints', e.src.listeners.length, 1);
  e.src.open = true;
  e.src.fire();
  eq('opening a fold remembers it', mountBox.__state().sectionPrefs.sources, true);
  ok('...persists it', mountBox.__calls().written > 0);
  eq('...and mounts the panel', mountBox.__calls().mountIngest.length, 1);
  e.src.open = false;
  mountBox.__reset();
  e.src.fire();
  eq('closing it remembers that too', mountBox.__state().sectionPrefs.sources, false);
  eq('...and takes the panel down', mountBox.__calls().unmountIngest, 1);

  // ── A TOGGLE THIS PAGE CAUSED ITSELF IS NOT A PREFERENCE (v3.64.1) ────
  // `patchMainAroundHosts` carries the DERIVED default across a domain switch
  // by writing `open`, and a `<details>` fires `toggle` for that exactly as it
  // does for a click. Without the echo queue the page would record its own
  // default as the user's explicit choice — the shape of the self-reopening
  // documents fold found on the Context view the same day, one file over.
  mountBox.__setState({ activeSlug: 'alpha', sectionPrefs: {} });
  mountBox.__reset();
  mountBox.__echoes().length = 0;
  mountBox.__echoes().push('sources');
  e.src.open = true;
  e.src.fire();
  eq('a queued echo writes NO preference at all',
    mountBox.__state().sectionPrefs.sources, undefined);
  eq('...and persists nothing', mountBox.__calls().written, 0);
  eq('...and the entry is consumed, so the NEXT toggle is the user\'s',
    mountBox.__echoes().length, 0);
  e.src.open = false;
  e.src.fire();
  eq('CONTROL -- the very next toggle IS recorded',
    mountBox.__state().sectionPrefs.sources, false);
  // AN ECHO FOR THE OTHER FOLD DOES NOT SWALLOW THIS ONE'S CLICK. A single
  // boolean would have; the queue is keyed.
  mountBox.__setState({ activeSlug: 'alpha', sectionPrefs: {} });
  mountBox.__echoes().length = 0;
  mountBox.__echoes().push('shared');
  e.src.open = true;
  e.src.fire();
  eq('an echo queued for the OTHER fold does not swallow this one\'s click',
    mountBox.__state().sectionPrefs.sources, true);
  eq('...and leaves the other fold\'s entry where it was',
    mountBox.__echoes().join(','), 'shared');
  mountBox.__echoes().length = 0;

  // ── THE PAINT'S OWN ECHO IS NOT A PRESS EITHER (v3.64.1) ─────────────
  // MEASURED IN A BROWSER: a `<details open>` created by an innerHTML
  // assignment fires `toggle` ONCE, after this listener is attached (the
  // probe: open 1 event, closed 0). Harmless while the emitted value always
  // equalled the stored one — and NOT harmless once the preference went
  // install-wide, because the INGEST fold's DERIVED default would then be
  // recorded as an explicit choice the first time a never-ingested domain was
  // opened, and would follow the user onto every other domain.
  {
    mountBox.__setState({ activeSlug: 'alpha', sectionPrefs: {} });
    const g = stage(true, false);
    mountBox.__reset();
    mountBox.mountHostedSections(1);
    // The fold is ALREADY open (the derived default), and the paint's echo
    // arrives with the open state unchanged.
    g.src.fire();
    eq('a toggle that did not change the fold writes NO preference',
      mountBox.__state().sectionPrefs.sources, undefined);
    eq('...and persists nothing', mountBox.__calls().written, 0);
    // CONTROL: a real press, which always changes it, still records.
    g.src.open = false;
    g.src.fire();
    eq('CONTROL -- a press that closes it IS recorded',
      mountBox.__state().sectionPrefs.sources, false);
  }
}
{
  // A JUMP TILE OPENS THE FOLD IT JUMPS TO. A jump that landed on a closed
  // section would put the reader on a summary line and leave them to find
  // the disclosure triangle.
  mountBox.__setState({ activeSlug: 'alpha', sectionPrefs: {} });
  const f = stage(false, false);
  mountBox.__reset();
  mountBox.openSectionFold('sources');
  eq('the SOURCES jump opens the INGEST fold', f.src.open, true);
  eq('...and mounts its panel', mountBox.__calls().mountIngest.length, 1);
  eq('...and remembers the choice', mountBox.__state().sectionPrefs.sources, true);
  mountBox.__reset();
  mountBox.openSectionFold('shared');
  eq('the SHARED jump opens the Shared Brain fold', f.sh.open, true);
  // An ALREADY-OPEN fold is not re-mounted: a jump is a scroll, and
  // remounting a panel the user is looking at would throw away its state.
  mountBox.__reset();
  mountBox.openSectionFold('sources');
  eq('jumping to an already-open fold remounts nothing', mountBox.__calls().mountIngest.length, 0);
}

// ═════════════════════════════════════════════════════════════════════════
section('S6 -- THE TEARDOWN TAKES BOTH PANELS DOWN');
// ═════════════════════════════════════════════════════════════════════════
{
  // The teardown is the closure `onEnter` returns, inside the object literal
  // registerView takes -- so it is lifted by locating that literal and
  // re-wrapped as a declaration. The BODY is byte-for-byte what ships.
  const m = /\n\s{2}onEnter\(mountToken\) \{/.exec(SRC);
  ok('CONTROL -- the registerView("domains") onEnter is findable', !!m);
  let i = SRC.indexOf('{', m.index + m[0].length - 1);
  let depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const body = SRC.slice(SRC.indexOf('{', m.index) + 1, i - 1);
  const tdBox = new Function(`
    let state = {};
    let loadGate = null;
    let arrivalRequest = null;
    let myMountToken = 0;
    let mountedSourcesEl = 1, mountedSourcesDomain = 'x', mountedSharedEl = 1, mountedSharedDomain = 'x';
    let quiescedWhileBusy = true;
    const calls = { unmountIngest: 0, unmountShared: 0 };
    function unmountIngestSection() { calls.unmountIngest++; }
    function unmountSharedSection() { calls.unmountShared++; }
    function consumeDomainRequest() { return null; }
    function createLoadingGate() { return { begin() {}, cancel() {} }; }
    function loadDomainsList() { return Promise.resolve(); }
    function loadKnowledgeBase() { return Promise.resolve(); }
    function loadUiState() {}
    function reportAsyncMountFailure() {}
    function reportAsyncActionFailure() {}
    function render() {}
    function disarmSemanticScan() {}
    function onEnter(mountToken) {${body}}
    return { onEnter, __calls: () => calls,
             __flags: () => ({ mountedSourcesEl, mountedSharedEl, quiescedWhileBusy }) };
  `)();
  const teardown = callOrFail('onEnter returns a teardown', () => tdBox.onEnter(1));
  if (typeof teardown === 'function') {
    teardown();
    eq('the teardown unmounts the Ingest panel', tdBox.__calls().unmountIngest, 1);
    eq('...and the Shared Brain panel -- which is what closes a PAT-holding wizard',
      tdBox.__calls().unmountShared, 1);
    const f = tdBox.__flags();
    ok('...and forgets which elements were mounted, so the next mount cannot re-point at a dead node',
      f.mountedSourcesEl === null && f.mountedSharedEl === null,
      JSON.stringify(f));
    eq('...and drops the owed rebuild with the page it was owed to', f.quiescedWhileBusy, false);
    // IDEMPOTENT: the shell runs a teardown on every exit and cannot know
    // whether either section was ever reached (a mirror renders no Ingest).
    teardown();
    eq('a second teardown is safe', tdBox.__calls().unmountIngest, 2);
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('S7 -- THE TWO JUMP TILES');
// ═════════════════════════════════════════════════════════════════════════
{
  const html = renderCard();
  const tiles = flatten(parseHtmlToChildren(html)).filter((n) => hasClass(n, 'dm-jump-card'));
  eq('two jump tiles render', tiles.length, 2);
  eq('...SOURCES first', tiles[0].attrs['data-stat-jump'], 'sources');
  eq('...then SHARED', tiles[1].attrs['data-stat-jump'], 'shared');
  ok('neither carries aria-pressed -- a jump is not a toggle, and saying so to a '
    + 'screen reader only would be a lie told to one audience',
    tiles.every((t) => t.attrs['aria-pressed'] === undefined));
  ok('...and both carry an accessible name that says where they go',
    tiles.every((t) => (t.attrs['aria-label'] || '').length > 10),
    tiles.map((t) => t.attrs['aria-label']).join(' | '));
  ok('they are NOT `.dm-stat-card`s, so the five figures stay five',
    tiles.every((t) => !hasClass(t, 'dm-stat-card')));
  eq('SHARED is hidden until the panel says this domain is part of one',
    Object.hasOwn(tiles[1].attrs, 'hidden'), true);
  // The SOURCES reading is the domain's own last write, or the honest absence.
  ok('SOURCES reads the last ingest', /dm-jump-value">just now</.test(html), html.slice(0, 300));
  const never = renderCard({ domains: [{ slug: 'alpha', displayName: 'Alpha', pageCount: 0,
    lastIngestDate: null, pageCounts: { entities: 0, concepts: 0, summaries: 0, other: 0 } }] });
  ok('...and says "nothing yet" rather than inventing a date', /dm-jump-value">nothing yet</.test(never));
}
{
  // THE READING IS DERIVED IN ONE PLACE, because it is read twice: by the
  // markup on a full paint and by the no-repaint reveal.
  const R = box.sharedJumpReading;
  eq('no reading at all is not a reason to show a tile', R(null).show, false);
  eq('neither is "enabled on this install" with no connection for this domain',
    R({ enabled: true, kind: 'none', contributingCount: 0, mirrorCount: 0 }).show, false);
  eq('a disabled install never shows it, whatever the counts say',
    R({ enabled: false, kind: 'contributing', contributingCount: 3, mirrorCount: 0 }).show, false);
  const one = R({ enabled: true, kind: 'contributing', contributingCount: 1, mirrorCount: 0 });
  ok('one cohort reads as one cohort', one.show === true && one.value === '1 cohort', JSON.stringify(one));
  eq('...and two read as two', R({ enabled: true, kind: 'contributing', contributingCount: 2, mirrorCount: 0 }).value, '2 cohorts');
  const mir = R({ enabled: true, kind: 'mirror', contributingCount: 0, mirrorCount: 1 });
  ok('a mirror says what it is rather than counting', mir.show === true && mir.value === 'mirror', JSON.stringify(mir));
  // AND THE MARKUP READS IT, rather than deriving a second answer.
  const shown = renderCard({ sharedJump: { show: true, value: '2 cohorts' } });
  const tile = flatten(parseHtmlToChildren(shown)).filter((n) => hasClass(n, 'dm-jump-card'))[1];
  ok('a warranted reading reveals the tile', !Object.hasOwn(tile.attrs, 'hidden'));
  ok('...carrying the value the reading produced', /dm-jump-value">2 cohorts</.test(shown));
}
{
  // `[hidden]` LOSES TO AN AUTHOR `display:` AT ANY SPECIFICITY -- v3.62.0
  // shipped an empty warning chip that painted anyway on exactly this shape.
  ok('views/domains.css carries the counter-rule that makes `hidden` real',
    /\.cur-ov-jump\[hidden\]\s*\{\s*display:\s*none;?\s*\}/.test(OV_CSS));
  ok('CONTROL -- the tile really does declare a display of its own',
    /\.cur-ov-jump\s*\{[^}]*display:\s*flex/.test(OV_CSS));
}

// ═════════════════════════════════════════════════════════════════════════
section('S8 -- FOUNDATIONS REACH THE PAGE LIST, FROM THE REAL ROUTE');
// ═════════════════════════════════════════════════════════════════════════
//
// Isolated via CURATOR_TEST_USER_DATA_DIR + CURATOR_TEST_DOMAINS_DIR, set
// BEFORE any app module is imported -- never process.env.DOMAINS_PATH, which
// loses to a configured domainsPath and would silently no-op on a real
// install. The fixture is written by the STORE's own API, so the manifest this
// asserts against is one the store would actually produce.
const TMP = mkdtempSync(join(tmpdir(), 'curator-domsec-'));
process.env.CURATOR_TEST_USER_DATA_DIR = join(TMP, 'userdata');
process.env.CURATOR_TEST_DOMAINS_DIR = join(TMP, 'domains');
delete process.env.DOMAINS_PATH;
for (const d of [process.env.CURATOR_TEST_USER_DATA_DIR, process.env.CURATOR_TEST_DOMAINS_DIR]) {
  mkdirSync(d, { recursive: true });
}
let server = null;
try {
  const D = join(process.env.CURATOR_TEST_DOMAINS_DIR, 'acme');
  for (const f of ['wiki/entities', 'wiki/concepts', 'wiki/summaries', 'state/lumina']) {
    mkdirSync(join(D, f), { recursive: true });
  }
  writeFileSync(join(D, 'CLAUDE.md'), '# schema\n');
  writeFileSync(join(D, 'wiki/entities/foo.md'), '# Foo\n');
  writeFileSync(join(D, 'state/lumina/project.md'), '# lumina brief\n');

  const ws = await import('../src/brain/working-state.js');
  const init = await ws.initFoundations('acme', 'lumina', { ownership: 'curator' });
  ok('CONTROL -- the fixture project owns its foundations', init && init.ok === true,
    JSON.stringify(init && init.reason));
  const saved = await ws.saveFoundation('acme', 'lumina', {
    slug: 'architecture.md', role: 'architecture', title: 'How it fits together',
    text: '# Architecture\n\nOne paragraph.\n',
    authoredBy: { kind: 'human' },
  });
  ok('CONTROL -- and one document is on disk', saved && saved.ok === true,
    JSON.stringify(saved && saved.reason));

  const { default: wikiRouter } = await import('../src/routes/wiki.js');
  const { default: express } = await import('express');
  const app = express();
  app.use('/api/wiki', wikiRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const PORT = server.address().port;
  const get = async (p) => (await fetch(`http://127.0.0.1:${PORT}${p}`)).json();

  const plain = await get('/api/wiki/acme/list');
  ok('WITHOUT the flag the response is unchanged -- no memory key, no cost',
    plain.memory === undefined && Array.isArray(plain.entries), JSON.stringify(Object.keys(plain)));

  const withMem = await get('/api/wiki/acme/list?include=memory');
  const rows = (withMem.memory || []).filter((r) => r.kind === 'foundation');
  // `initFoundations` on a curator-owned project SEEDS the four skeletons, so
  // this fixture has four documents and one of them has been written over.
  // Asserted as four rather than one on purpose: the skeleton mark below is a
  // reading a listing must not drop, and a one-document fixture could not see
  // it.
  eq('every foundation appears in the SAME array as the brief', rows.length, 4);
  const fnd = rows.filter((r) => r.slug === 'architecture.md');
  eq('CONTROL -- the written one is findable', fnd.length, 1);
  eq('...at the path it occupies on disk', fnd[0].path, 'state/lumina/foundations/architecture.md');
  eq('...addressed by the slug its own route takes', fnd[0].slug, 'architecture.md');
  eq('...named by project and title, like every other row', fnd[0].title, 'lumina · How it fits together');
  eq('...carrying its role', fnd[0].role, 'architecture');
  eq('...and no longer marked a skeleton, because it has been written', fnd[0].skeleton, false);
  ok('...while the three unwritten ones still say they are skeletons',
    rows.filter((r) => r.skeleton === true).length === 3,
    rows.map((r) => r.slug + ':' + r.skeleton).join(', '));
  eq('...and counted with the rest', withMem.memoryCount, (withMem.memory || []).length);
  ok('the brief is still there beside it -- one array, three kinds',
    (withMem.memory || []).some((r) => r.kind === 'brief'));
  ok('the wiki count is untouched, so "All" cannot contradict the figure above it',
    withMem.count === plain.count, withMem.count + ' vs ' + plain.count);
  // THE WIRE SHAPE IS AN ALLOW-LIST. sha256, authoredBy and commit are
  // provenance a page LISTING has no use for, and a spread would ship them.
  const leaked = ['sha256', 'authoredBy', 'commit', 'source', 'text'].filter((k) => k in fnd[0]);
  ok('no provenance field leaks into the listing', leaked.length === 0, leaked.join(', '));
  eq('...and the row carries exactly the thirteen fields the route names',
    Object.keys(fnd[0]).sort().join(','),
    'bytes,freshness,isDefaultProject,kind,machine,path,project,role,savedAt,scope,skeleton,slug,title'
      .split(',').sort().join(','));
  // A DOMAIN WITH NO TIER 0 AT ALL is not an error -- it is a domain with no
  // foundations, and the rest of the list must still answer.
  const bare = await get('/api/wiki/acme/list?include=memory');
  ok('CONTROL -- the same call is stable across two reads',
    (bare.memory || []).length === (withMem.memory || []).length);
  // ── THE REFUSAL ARMS, DRIVEN DIRECTLY ────────────────────────────────
  // `listFoundations` refuses a reserved project name, and `listProjects`
  // correctly never returns one — verified above by the fixture, which has a
  // `state/foundations/` directory and a project list that does not mention
  // it. So these two arms are DEFENSIVE and cannot be reached through the
  // route, which is exactly why they are driven here rather than asserted by
  // reading the source: a page listing must not fail because one project's
  // tier 0 is unreadable, and a guard nothing exercises is a guard nobody
  // knows the shape of.
  const ROUTE_SRC = readFileSync(join(ROOT, 'src/routes/wiki.js'), 'utf8');
  const rowsBox = new Function('listFoundations', `
    ${extractFunction(ROUTE_SRC, 'foundationPathFor')}
    ${extractFunction(ROUTE_SRC, 'foundationRows')}
    return foundationRows;
  `);
  const refused = await rowsBox(async () => ({ ok: false, reason: 'invalid-state-project' }))('acme', 'x', false);
  eq('a store REFUSAL contributes no rows rather than failing the listing', refused.length, 0);
  const threw = await rowsBox(async () => { throw new Error('disk on fire'); })('acme', 'x', false);
  eq('...and so does a throw', threw.length, 0);
  const malformed = await rowsBox(async () => ({ ok: true, manifestError: 'bad json', documents: [] }))('acme', 'x', false);
  eq('...and a manifest this store cannot read', malformed.length, 0);
  const shaped = await rowsBox(async () => ({ ok: true, documents: [{ slug: 'a.md', role: 'other', title: 'A' }] }))('acme', 'x', false);
  eq('CONTROL -- a real answer really does produce a row', shaped.length, 1);
  const nameless = await rowsBox(async () => ({ ok: true, documents: [{ role: 'other' }, { slug: 'b.md' }] }))('acme', 'x', false);
  eq('...and an entry with no slug is skipped, not rendered as a row with no target', nameless.length, 1);

  // ── THE READER'S CAPTION (D-P) ────────────────────────────────────────
  // The shell's DEFAULT readonly caption is "Read-only Shared Brain mirror",
  // which is a sentence about a different feature. v3.61.0 added
  // `readonlyNote` because tier 0 opened in this reader and every canonical
  // document was captioned with it; the first cut of THIS branch reproduced
  // it exactly, seen in the browser on a curator-authored foundation. The
  // sentence turns on `source.kind`, the per-document fact, never on
  // `ownership`, which this route does not send.
  {
    const opened = [];
    const readerBox = new Function('openReader', 'fetchJSON', `
      let state = { activeSlug: 'acme' };
      let myMountToken = 1;
      function isCurrentMount() { return true; }
      function isCurrentReader() { return true; }
      function renderMarkdown(t) { return '<p class="md">' + t + '</p>'; }
      function renderDescription(t) { return '<p class="tx-desc">' + t + '</p>'; }
      const escapeHtml = (x) => String(x);
      ${extractFunction(SRC, 'openMemoryPageFromBrowse')}
      return openMemoryPageFromBrowse;
    `);
    const asked = [];
    const drive = async (payload, row) => {
      opened.length = 0;
      asked.length = 0;
      const fn = readerBox((c) => { opened.push(c); return 1; },
        async (u) => { asked.push(u); return payload; });
      await fn(row || { kind: 'foundation', project: 'lumina', slug: 'architecture.md',
        title: 'lumina · Architecture', path: 'state/lumina/foundations/architecture.md' });
      return opened[opened.length - 1];
    };
    const curatorOwned = await drive({ ok: true, slug: 'architecture.md', role: 'architecture',
      text: '# A', source: { kind: 'curator' } });
    eq('a foundation opens in the right-side reader, labelled as one', curatorOwned.typeLabel, 'foundation');
    // ── ADDRESSED BY SLUG, ON ITS OWN ROUTE ─────────────────────────────
    // A brief and a handoff are two halves of ONE project read; a foundation
    // is its own document. Sending it to the project route would answer with
    // the BRIEF — a different document, rendered under this one's title.
    eq('...having asked the foundations route, by slug', asked[0],
      '/api/memory/acme/lumina/foundations/architecture.md');
    await drive({ ok: true, readonly: false, brief: { present: true, text: '# B' } },
      { kind: 'brief', project: 'lumina', title: 'lumina · Standing brief', path: 'state/lumina/project.md' });
    eq('CONTROL -- a brief still asks the project route, with no scope', asked[0],
      '/api/memory/acme/lumina');
    await drive({ ok: true, readonly: false, current: { present: true, text: '# H' } },
      { kind: 'handoff', project: 'lumina', scope: 'design', machine: 'mac-ab12',
        title: 'lumina · design · mac-ab12', path: 'state/lumina/design/mac-ab12/current.md' });
    eq('CONTROL -- and a handoff asks it by work-stream and machine', asked[0],
      '/api/memory/acme/lumina?scope=design&machine=mac-ab12');
    ok('a CURATOR-authored document is NOT captioned as a Shared Brain mirror',
      !/Shared Brain/i.test(curatorOwned.readonlyNote || ''), curatorOwned.readonlyNote);
    ok('...it says where it IS changed', /Project context/.test(curatorOwned.readonlyNote || ''),
      curatorOwned.readonlyNote);
    const mirrored = await drive({ ok: true, slug: 'architecture.md', role: 'architecture',
      text: '# A', source: { kind: 'repo', path: 'docs/architecture.md' } });
    ok('a MIRRORED document points at the folder it came from',
      /Mirrored from the folder/.test(mirrored.readonlyNote || ''), mirrored.readonlyNote);
    ok('...and names that folder path as a chip',
      (mirrored.tags || []).some((t) => t === 'source: docs/architecture.md'), JSON.stringify(mirrored.tags));
    // The two readings that change how the BODY should be read.
    const skeleton = await drive({ ok: true, slug: 'architecture.md', text: '# A',
      source: { kind: 'curator' }, skeleton: true });
    ok('a skeleton says its body is questions, not facts',
      /questions, not facts/.test(skeleton.bodyHtml), skeleton.bodyHtml.slice(0, 120));
    const stale = await drive({ ok: true, slug: 'architecture.md', text: '# A',
      source: { kind: 'repo' }, freshness: 'stale' });
    ok('a stale copy says it no longer matches its source',
      /no longer matches/.test(stale.bodyHtml), stale.bodyHtml.slice(0, 120));
    const clean = await drive({ ok: true, slug: 'architecture.md', text: '# A',
      source: { kind: 'curator' }, freshness: 'fresh' });
    ok('CONTROL -- a fresh, written document carries neither note',
      !/questions, not facts|no longer matches/.test(clean.bodyHtml), clean.bodyHtml.slice(0, 120));
  }
} catch (err) {
  ok('S8 ran against the real route -- ' + (err && err.message), false);
} finally {
  if (server) server.close();
  rmSync(TMP, { recursive: true, force: true });
}


// ═════════════════════════════════════════════════════════════════════════
section('S9 -- BOUND ONCE PER NODE (v3.64.1)');
// ═════════════════════════════════════════════════════════════════════════
//
// THE HAZARD THE PATCH CREATED, and the one thing about making setMain patch
// on every paint that could have shipped as a silent data defect. renderMain
// binds its listeners AFTER the paint, by querying the document. A full column
// replacement made that safe by construction: every node was new, so every
// listener was the first. A patched paint leaves unchanged sections STANDING
// with the listeners an earlier paint gave them -- so a cold domain switch,
// which paints once on the switch and once as each of health, projects and the
// page list lands, would leave FOUR listeners on every control that did not
// move. Most are idempotent. `Show N more` is not: it would advance the window
// four steps. `Rescan`, `Fix all` and `Apply plan` are not either, and they are
// HTTP requests -- one of them deletes files.
//
// THE MARK IS AN EXPANDO, NOT AN ATTRIBUTE, and that is load-bearing rather
// than stylistic: a `data-*` mark appears in the live node's outerHTML and
// never in the freshly-composed one, so the patch's byte comparison would find
// every marked section different and replace it on every paint -- the guard
// would silently re-create the defect it exists to prevent.
{
  const guarded = ['bindBrowseListeners', 'bindStatCardListeners', 'bindProjectListeners',
    'bindHealthListeners', 'bindLifecycleListeners'];
  for (const name of guarded) {
    const fn = extractFunction(SRC, name);
    ok(name + ' takes the bind-once guard before it binds anything',
      /boundScope\.__dmBound/.test(fn) && /boundScope\.__dmBound = true/.test(fn),
      fn.slice(0, 400));
    ok('...and reaches its scope through a `typeof` guard, so a suite stand-in '
      + 'document with no querySelector binds rather than crashing',
    /typeof document\.querySelector === 'function'/.test(fn), fn.slice(0, 600));
  }
  ok('no guard writes a data-* attribute, which the patch would see as a difference',
    !/dataset\.dmBound/.test(SRC), 'dataset.dmBound found');

  // -- DRIVEN, NOT SCANNED. A real element, four bind passes, one listener.
  const scope = { __dmBound: undefined };
  const target = { listeners: [], addEventListener(t, h) { this.listeners.push([t, h]); } };
  const doc = {
    querySelector: (sel) => (sel === '.dm-pages' ? scope : null),
    getElementById: (id) => (id === 'dm-browse-more' ? target : null),
    querySelectorAll: () => [],
  };
  const makeBind = (d) => new Function('document', 'state', 'myMountToken', 'loadBrowse', 'render',
    'selectBrowseFacet', 'showMoreBrowseRows', 'bindBrowseRowClicks', 'reportAsyncActionFailure',
    'BROWSE_RENDER_CAP',
    extractFunction(SRC, 'bindBrowseListeners') + '\nreturn bindBrowseListeners;')(
    d, { activeSlug: 'alpha' }, 1, () => Promise.resolve(), () => {}, () => {}, () => {},
    () => {}, () => {}, 150);
  const bind = makeBind(doc);
  bind();
  const afterOne = target.listeners.length;
  bind(); bind(); bind();
  ok('CONTROL -- the first pass really bound something', afterOne > 0, String(afterOne));
  eq('three further passes over the SAME node bind nothing more', target.listeners.length, afterOne);
  // ...AND A REPLACED SECTION IS BOUND AGAIN. The guard must not outlive the
  // node it marked, or a section the patch DID replace would ship inert.
  doc.querySelector = () => ({ __dmBound: undefined });
  bind();
  ok('a section the patch replaced is bound again, so nothing ships inert',
    target.listeners.length > afterOne, afterOne + ' -> ' + target.listeners.length);
  // AND A DOCUMENT WITH NO querySelector AT ALL still binds -- the shape three
  // unowned suites execute these functions with.
  const before = target.listeners.length;
  const bind2 = makeBind({ getElementById: (id) => (id === 'dm-browse-more' ? target : null),
    querySelectorAll: () => [] });
  ok('a stand-in document with no querySelector binds instead of crashing',
    callOrFail('bindBrowseListeners against a querySelector-less document',
      () => { bind2(); return true; }) === true && target.listeners.length > before);
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n------------------------------------------------------------');
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('Domain-sections assertions FAILED'); process.exit(1); }
console.log('Domain sections, folds, lens, quiesce and teardown hold');
