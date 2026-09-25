#!/usr/bin/env node
/**
 * test-next-domain-card-order.js — OFFLINE suite. No network, no API key, no LLM.
 *
 * Guards the v3.49.0 rearrangement of the /next Domains card
 * (src/public/next/views/domains.js), reported by a power user who could not
 * find "the wiki" in an application whose entire purpose is to build one.
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────
 *  1. THE PAGE BROWSER WAS LAST, AND GATED. renderMain composed
 *     stat cards -> Projects -> Wiki health -> Pages, and the Pages panel
 *     rendered a "Browse pages" BUTTON until someone pressed it. So the index
 *     of a user's own knowledge sat underneath a maintenance report, behind a
 *     control, while four stat cards above it counted pages he had no route
 *     to. The order is now stat cards -> Pages -> Projects -> Wiki health,
 *     and the list loads with the domain.
 *  2. THE HEALTH BUTTON SAID "Rescan" WHEN NOTHING HAD BEEN SCANNED.
 *
 * ── A CORRECTION TO THE REPORT, MEASURED, so the guard is not read as wider
 *    than it is ────────────────────────────────────────────────────────────
 * "Rescan" was not wrong everywhere. Entering the view and switching domains
 * each run a scan (loadDomainsList -> loadHealth, selectDomain -> loadHealth)
 * and GET /api/health/:domain really scans rather than returning a cached
 * report — so by the time the READOUT branch paints, a scan for that domain
 * has genuinely completed and "Rescan" was already the true word there. The
 * branch that lied is the FAILURE one: a first scan that errors leaves no
 * result at all, and the button under that error offered to redo it. §3
 * below drives BOTH branches, and the failure-after-a-success case too,
 * because that one legitimately still reads "Rescan".
 *
 * ── EVERYTHING HERE DRIVES REAL CODE ─────────────────────────────────────
 * Functions are lifted out of live source by brace-matching and executed with
 * `new Function` against injected collaborators — the technique
 * test-next-domain-projects.js and test-next-domains-text.js use, and for the
 * reason this repo keeps re-learning: a test that proves a line of source
 * exists proves nothing about what it does. §1 parses renderMain's OUTPUT
 * into a tree and compares DOM POSITIONS, because "Pages is above Projects"
 * is a containment/ordering question and a substring cannot express one —
 * which is exactly how the old order survived every existing assertion.
 *
 * ── NOT ENFORCED (named, not implied away) ───────────────────────────────
 *  · A tree is not a layout. Spacing, the two themes, and what the card looks
 *    like at a narrow width are the orchestrator's rendered pass.
 *  · §1 stubs the Projects and Health panels to markers. Their own contents
 *    have their own suites (test-next-domain-projects.js,
 *    test-next-domains-text.js); what is asserted here is renderMain's
 *    composition, which is the thing that moved. The Pages panel is the REAL
 *    one, because it is the panel the report was about.
 *  · The auto-load is asserted as a CALL with the right slug and token, not
 *    as a network round trip.
 */

import { readFileSync } from 'node:fs';
import { renderMonitor } from '../src/public/next/shared/monitor.js';
import { freshnessTier } from '../src/public/next/shared/age.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The REAL docs table (v3.62.0). `docsUrl()` THROWS on an unknown key, which
// is the module's whole point, so injecting the real one is what makes a
// mistyped key a FATAL here instead of a blank panel in the browser.
const { docsLinkHtml } =
  await import('../src/public/next/shared/docs-links.js');
const { renderOverview } = await import('../src/public/next/shared/overview.js');
// v3.71.0: G3/G4's ⓘ (`PAGES_INFO`, `HEALTH_INFO`) are module consts computed
// from the REAL kit, the same reason docsLinkHtml/renderOverview above are
// the real modules and not stubs — a mistyped explainer key THROWS.
// v3.71.1: INGEST_INFO, the Shared Brain ⓘ and the OVERVIEW legend are all
// explainers now, so the whole kit is injected — real, never stubbed.
const { explainerMark, explainerHtml, explainerLabel } = await import('../src/public/next/shared/explainer.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = readFileSync(join(ROOT, 'src/public/next/views/domains.js'), 'utf8');

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
// Brace-matched, parameter-list-aware, LOUD on desync — a silent truncation
// hands the sandbox something that fails much later as a bare SyntaxError.
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
/** A single-line `const NAME = …;`. Throws rather than truncating quietly. */
function extractConstText(source, name) {
  const re = new RegExp(`(?:^|\\n)const ${name} = [^\\n]*;`);
  const m = re.exec(source);
  if (!m) throw new Error(`extractConstText: "${name}" not found as a single-line const`);
  return m[0].trim();
}
/** A multi-line `const NAME = [ … ];` array literal. */
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

// ── A DOM model, so ORDER is a tree question and not a substring one ──────
// Lifted from test-next-domain-projects.js's S9/S10 parser (this repo ships
// zero devDeps, so there is no jsdom). It is a MODEL: it answers "which node
// comes before which", which is the whole question here, and nothing about
// pixels.
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
/** Position of a node in DOCUMENT ORDER — the only thing §1 compares. */
function docOrder(root) {
  const seq = flatten(root);
  return (pred) => seq.findIndex(pred);
}

// ═════════════════════════════════════════════════════════════════════════
// The sandbox for §1: the REAL renderMain and the REAL Pages panel; the two
// panels below it stubbed to markers (see the docblock).
// ═════════════════════════════════════════════════════════════════════════
const MAIN_PREAMBLE = `
let state = {};
const calls = { setMain: [], browseLoads: [] };
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
const MIRROR_INFO = 'mirror-info';
const DOMAIN_BLURB = 'domain-blurb';
const MIRROR_WARNING = 'mirror-warning';
// The two panels BELOW Pages, stubbed to markers. Their contents have their
// own suites; what §1 asks is where renderMain puts them.
function renderProjectsPanel() { return '<div class="STUB-projects"></div>'; }
function renderHealthPanel() { return '<div class="STUB-health"></div>'; }
function openLifecycle() {}
function goToChatScoped() {}
function bindLifecycleListeners() {}
function bindProjectListeners() {}
function bindKnowledgeListeners() {}
function bindHealthListeners() {}
function bindBrowseListeners() {}
// v3.58.0: the OVERVIEW figures became controls over the page-list facet, so
// renderMain wires one more listener set. Stubbed like its five siblings --
// this suite measures CARD ORDER, not behaviour.
function bindStatCardListeners() {}
// v3.64.0: the SOURCES jump reads the domain's last-ingest date, and the two
// fold summaries read it too. Stubbed to a constant so the ORDER assertions
// below do not depend on a clock.
function relTime() { return 'just now'; }
// v3.72.1 (F2/F3): ① meta and the SOURCES tile come from the REAL
// lastWriteReading (lifted below); only its day clock is fixed here.
function formatDayAge(d) { return d ? 'today' : null; }
const document = { getElementById: () => null, querySelectorAll: () => [] };
`;

let main;
try {
  main = new Function(
    'docsLinkHtml', 'renderOverview', 'explainerMark', 'explainerHtml', 'explainerLabel',
    // v3.62.0 (P1-14). `renderStatCards` now builds the OVERVIEW block's ⓘ,
    // so the legend text and the shared docs table are collaborators of it.
    // Both are lifted rather than stubbed: `docsUrl()` THROWS on a key that is
    // not in the frozen map, and a stub would let a mistyped key pass here and
    // blank the panel in the browser.
    MAIN_PREAMBLE +
    // v3.65.0 (R4): section ①'s explanation left the fold's BODY for an ⓘ on
    // its head, and the sentence is a module const so `renderMain` does not
    // carry a paragraph every lifting sandbox has to carry with it. LIFTED,
    // not stubbed — the words are the thing R4 moved.
    extractConstText(SRC, 'INGEST_INFO') + '\n' +
    extractConstText(SRC, 'PAGES_INFO') + '\n' +
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
    extractFunction(SRC, 'renderStatCards') + '\n' +
    extractFunction(SRC, 'lastWriteReading') + '\n' +
    extractFunction(SRC, 'renderMain') + '\n' +
    `return { renderMain, renderBrowsePanel, BROWSE_EYEBROW, browseMatches, browseWindow,
       memoryRowHtml, browseRowHtml, browseMoreHtml, browseNoteHtml, projectCount,
       __setState: (s) => { state = s; }, __calls: () => calls,
       __reset: () => { calls.setMain.length = 0; } };`
  )(docsLinkHtml, renderOverview, explainerMark, explainerHtml, explainerLabel);
} catch (err) {
  console.log('FATAL: could not build the renderMain sandbox from domains.js -- ' + err.message);
  process.exit(1);
}

const ENTRY = (over) => ({ slug: 'alpha-note', folder: 'entities', path: 'entities/alpha-note.md', title: 'Alpha note', ...over });
const mainState = (over) => ({
  loaded: true, loadError: null, activeSlug: 'alpha',
  domains: [{ slug: 'alpha', displayName: 'Alpha', pageCount: 3, pageCounts: { entities: 1, concepts: 1, summaries: 1, other: 0 } }],
  readonlySet: new Set(),
  browse: {
    slug: 'alpha', loading: false, error: null, filter: '', folder: 'all', truncated: false,
    entries: [ENTRY(), ENTRY({ slug: 'idea', folder: 'concepts', path: 'concepts/idea.md', title: 'Idea' })],
  },
  ...over,
});

function renderCard(over) {
  main.__reset();
  main.__setState(mainState(over));
  main.renderMain(1);
  return main.__calls().setMain[0];
}

// ═════════════════════════════════════════════════════════════════════════
section('S1 -- THE WIKI IS NOT BURIED: card order, by DOM position');
// ═════════════════════════════════════════════════════════════════════════
{
  const html = callOrFail('renderMain composes a domain card', () => renderCard());
  if (html) {
    const root = parseHtmlToChildren(html);
    const at = docOrder(root);
    const iStats = at((n) => hasClass(n, 'dm-stats-grid'));
    const iSources = at((n) => n.attrs.id === 'dm-sources-fold');
    const iEyebrow = at((n) => hasClass(n, 'dm-recent-eyebrow'));
    const iBrowse = at((n) => hasClass(n, 'dm-browse-card'));
    const iProjects = at((n) => hasClass(n, 'STUB-projects'));
    const iShared = at((n) => n.attrs.id === 'dm-shared-fold');
    const iHealth = at((n) => hasClass(n, 'STUB-health'));

    // CONTROLS FIRST. Every assertion below compares indices, and -1 < 0
    // compares perfectly happily — a card that failed to parse would pass
    // an ordering check by accident.
    ok('CONTROL -- the stat cards are in the parsed tree', iStats >= 0, String(iStats));
    ok('CONTROL -- the Pages group is in the parsed tree', iEyebrow >= 0 && iBrowse >= 0, iEyebrow + '/' + iBrowse);
    ok('CONTROL -- both panels below it are in the parsed tree', iProjects >= 0 && iHealth >= 0, iProjects + '/' + iHealth);

    ok('CONTROL -- the two v3.64.0 hosted sections are in the parsed tree',
      iSources >= 0 && iShared >= 0, iSources + '/' + iShared);

    ok('the Pages group comes AFTER the stat cards -- the count, then the index it counts',
      iStats < iEyebrow, iStats + ' < ' + iEyebrow);
    // v3.64.0. The act of adding comes before the index of what was added --
    // the same argument v3.49.0 used to put the wiki above the housekeeping,
    // applied one step earlier, and the reason INGEST could give up rail slot
    // 2 without becoming unfindable.
    ok('INGEST sits between the figures and the wiki index',
      iStats < iSources && iSources < iEyebrow, iStats + ' < ' + iSources + ' < ' + iEyebrow);
    // A fact ABOUT the domain, like Projects, and above the maintenance
    // report for the same reason Projects is.
    ok('SHARED BRAIN sits between Projects and Wiki health',
      iProjects < iShared && iShared < iHealth, iProjects + ' < ' + iShared + ' < ' + iHealth);
    ok('the Pages group comes BEFORE Projects -- the reported defect',
      iEyebrow < iProjects && iBrowse < iProjects, iBrowse + ' < ' + iProjects);
    ok('...and before Wiki health, so the wiki is never under its own maintenance report',
      iBrowse < iHealth, iBrowse + ' < ' + iHealth);
    ok('Projects still comes before Wiki health -- the v3.48.0 placement, unchanged by this move',
      iProjects < iHealth, iProjects + ' < ' + iHealth);
    // v3.71.0 (G3): the eyebrow now carries its own ⓘ (`PAGES_INFO`), whose
    // button sits inside the eyebrow's OWN head row and whose panel is a new
    // sibling between that row and the card — so document order between the
    // eyebrow and the card is no longer EMPTY, and a raw index diff of 1 no
    // longer holds. What still has to be true is the property the diff was a
    // proxy for: nothing FOREIGN sits between them — every node in that gap
    // belongs to the eyebrow's own ⓘ (its button or its panel), not to some
    // other card that drifted in between.
    const seq = flatten(root);
    const iPanel = at((n) => n.attrs.id === 'dm-pages-info');
    const iBtn = at((n) => n.attrs.id === 'dm-pages-info-btn');
    ok('CONTROL -- the Pages ⓘ button and panel are both in the parsed tree',
      iBtn >= 0 && iPanel >= 0, iBtn + '/' + iPanel);
    const isDescendantOfEither = (n) => {
      for (let p = n; p; p = p.parentNode) {
        if (p.attrs.id === 'dm-pages-info-btn' || p.attrs.id === 'dm-pages-info') return true;
      }
      return false;
    };
    const between = seq.slice(iEyebrow + 1, iBrowse);
    const foreign = between.find((n) => !isDescendantOfEither(n));
    ok('the eyebrow immediately precedes its own card — the only thing between them is its own ⓘ',
      iEyebrow < iBrowse && !foreign,
      foreign ? `foreign node: ${foreign.tagName} class="${foreign.attrs.class || ''}"` : `${iEyebrow} -> ${iBrowse}, ${between.length} nodes between, all the ⓘ's own`);
  }
}
{
  // THE EYEBROW IS `PAGES` AGAIN (v3.64.0), and the distinguishing work has
  // moved. v3.49.0 added "· THE WIKI" because the stat cards directly above
  // carry their OWN "PAGES" eyebrow over a count, so a bare "PAGES" here read
  // as a second heading for the same number. The list now holds this domain's
  // CONTEXT documents too, so an eyebrow promising the wiki would name one of
  // three lenses -- and the LENS ROW under the eyebrow is what now says, in
  // three words, which inventory is on screen.
  const html = renderCard();
  // v3.64.2 — Title case on all five section headings, matching the Context
  // view's steps; the eyebrow face is gone and the word is the same.
  ok('the Pages group is labelled "Pages", with no second noun welded to it',
    /dm-recent-eyebrow[^>]*>Pages</.test(html) && !/Pages · [Tt]he wiki/i.test(html),
    html.slice(0, 200));
  const root = parseHtmlToChildren(html);
  const eyebrows = flatten(root).filter((n) => hasClass(n, 'cur-eyebrow'));
  ok('CONTROL -- the stat cards really do carry their own eyebrows too (' + eyebrows.length + ')',
    eyebrows.length >= 5);
  const lensChips = flatten(root).filter((n) => hasClass(n, 'dm-lens-chip'));
  ok('...and the three lens chips are what distinguish the index from the count',
    lensChips.length === 3
    && lensChips.map((c) => c.attrs['data-browse-lens']).join(',') === 'wiki,context,all',
    lensChips.map((c) => c.attrs['data-browse-lens']).join(','));
}

// ═════════════════════════════════════════════════════════════════════════
section('S2 -- THE BROWSER IS OPEN, WITH ITS FILTER AND ITS FACETS');
// ═════════════════════════════════════════════════════════════════════════
{
  const html = renderCard();
  ok('there is NO "Browse pages" gate anywhere on the card -- the reported defect',
    !html.includes('dm-browse-load-btn'), 'gate button still rendered');
  ok('the filter field is present and reachable by the id the caret-restore uses',
    html.includes('id="dm-browse-filter"'));
  const root = parseHtmlToChildren(html);
  const tabs = flatten(root).filter((n) => hasClass(n, 'dm-browse-tab'));
  // FIVE since v3.50.0: Memory joined them — the domain's standing briefs and
  // work-stream handoffs are markdown too, and this list is where a person
  // looks for "what documents are in this domain".
  eq('all five folder facets render (All / Entities / Concepts / Summaries / Memory)', tabs.length, 5);
  const rows = flatten(root).filter((n) => hasClass(n, 'dm-browse-row'));
  eq('and the pages themselves are listed', rows.length, 2);
}
{
  // BEFORE THE LOAD LANDS, the panel shows the loader — never the old gate.
  // This is the branch that paints in the instant between the first render
  // and loadBrowse's own, so it is what a user actually sees on entry.
  const html = renderCard({ browse: null });
  ok('with nothing loaded yet the panel shows a LOADER, not a button',
    html.includes('Loading pages…') && !html.includes('dm-browse-load-btn'));
  ok('...under the same eyebrow, so the group does not appear from nowhere',
    /dm-recent-eyebrow[^>]*>Pages</.test(html));
}
{
  // THE RENDER CAP SURVIVED. It is what keeps a 3,300-page domain from
  // painting 3,300 rows now that nobody has to press anything first.
  const many = [];
  for (let i = 0; i < 400; i++) many.push(ENTRY({ slug: 'p' + i, path: 'entities/p' + i + '.md', title: 'P' + i }));
  const html = renderCard({ browse: { slug: 'alpha', loading: false, error: null, filter: '', folder: 'all', truncated: false, entries: many } });
  const rows = flatten(parseHtmlToChildren(html)).filter((n) => hasClass(n, 'dm-browse-row'));
  eq('a 400-page domain paints the capped number of rows, not 400', rows.length, 150);
  // THE WORDING CHANGED WITH THE DEAD END IT DESCRIBED (v3.50.0). It used to
  // read "Showing the first 150 of 400 matches — narrow the filter to see the
  // rest", and narrowing the filter really was the only route past it. The
  // note now states the two numbers and a footer row extends the window; the
  // pagination itself is driven in scripts/test-next-domain-pages.js.
  ok('...and says so, with the real total', html.includes('Showing 150 of 400'));
  ok('...and offers the way past it, rather than telling the reader to type',
    html.includes('id="dm-browse-more"') && html.includes('Show 150 more'));
  ok('...with no trace of the old dead end', !html.includes('narrow the filter'));
}
{
  // THE FILTER STILL FILTERS, through the real filterBrowseEntries.
  const html = renderCard({ browse: { slug: 'alpha', loading: false, error: null, filter: 'idea', folder: 'all', truncated: false, entries: [ENTRY(), ENTRY({ slug: 'idea', folder: 'concepts', path: 'concepts/idea.md', title: 'Idea' })] } });
  const rows = flatten(parseHtmlToChildren(html)).filter((n) => hasClass(n, 'dm-browse-row'));
  eq('a filter narrows the list', rows.length, 1);
  ok('...to the matching page', rows[0].attrs['data-browse-path'] === 'concepts/idea.md');
}
{
  // A LIST BELONGING TO ANOTHER DOMAIN IS STILL REFUSED. activeBrowse() is
  // LAYER 2 of the domain scoping, and auto-loading makes it matter MORE,
  // not less: nobody presses anything now, so nothing else gates it.
  const html = renderCard({ browse: { slug: 'beta', loading: false, error: null, filter: '', folder: 'all', truncated: false, entries: [ENTRY()] } });
  ok('another domain\'s page list is not painted under this domain',
    !html.includes('data-browse-path'), 'stale rows rendered');
  ok('...and the panel still renders SOMETHING rather than vanishing',
    /dm-recent-eyebrow[^>]*>Pages</.test(html));
}

// ═════════════════════════════════════════════════════════════════════════
section('S3 -- "Scan wiki health" vs "Rescan"');
// ═════════════════════════════════════════════════════════════════════════
{
  const deps = {
    icon: (n) => '<ICON:' + n + '/>', escapeHtml: (x) => String(x), pluralize: (n, w) => n + ' ' + w,
    relTime: () => '10s ago', buttonRingHtml: () => '<RING/>',
    totalOpenIssues: () => 2, renderBanner: () => '', renderMirrorNote: () => '<MIRROR/>',
    renderQuickMaintenance: () => '<QUICK/>', renderAiProgressRing: () => '',
    renderConfirmCard: () => '', renderPendingPlan: () => '',
    activeSemanticScan: () => null, renderSemanticScanResult: () => '',
    renderIssueGroups: () => '<GROUPS/>',
    HEALTH_CATEGORIES: [{ key: 'brokenLinks', label: 'Broken links' }],
    inFlightWriteSlugs: new Set(),
    renderDescription: (t) => '<p>' + t + '</p>',
    renderStatus: (o) => '<div class="tx-status tx-status-' + o.state + '">' + o.title + '</div>',
    // v3.65.0: the scan's five figures are a MONITOR now (catalogue entry M6),
    // inside a fold row, so `renderHealthPanel` composes `renderMonitor` and
    // `freshnessTier` as free identifiers. A module-level import is NOT
    // visible inside a lifted body, so both are injected here — and both are
    // the REAL functions rather than stubs, because this section renders the
    // shipped panel and a stub could let the figures say anything.
    renderMonitor, freshnessTier,
    // v3.71.0 (G4): healthSection's own ⓘ, `HEALTH_INFO`, is a module const
    // computed from the real kit — `explainerMark` is injected for the SAME
    // reason renderMonitor/freshnessTier are: not visible inside a lifted body.
    explainerMark,
  };
  const names = Object.keys(deps);
  const build = () => new Function(
    'state', ...names,
    extractFunction(SRC, 'shouldKeepHealthOnReload') + '\n' +
    extractFunction(SRC, 'healthScanLabel') + '\n' +
    extractConstText(SRC, 'HEALTH_INFO') + '\n' +
    extractFunction(SRC, 'healthSection') + '\n' +
    extractFunction(SRC, 'renderHealthPanel') + '\nreturn renderHealthPanel;'
  );
  // `expandedGroups` joined the state this panel reads in v3.65.0: the scan's
  // figures sit in a fold row whose open state lives there, like every other
  // group on the card. An empty Set is the shipped default — the row is
  // CLOSED until pressed, the same call step 3 Knowledge made in v3.64.2.
  const render = (st) => build()({ expandedGroups: new Set(), ...st }, ...names.map((n) => deps[n]))({ slug: 'articles' }, false);
  const REPORT = { counts: { entities: 1, concepts: 2, summaries: 3, dismissed: 0 }, scannedAt: '2026-09-01T00:00:00Z', brokenLinks: [{}, {}] };

  // (a) THE BRANCH THAT WAS LYING: a first scan that failed. There is no
  // result, and the button used to offer to redo one.
  const firstFail = callOrFail('a first scan that failed', () =>
    render({ healthLoading: false, healthError: 'the disk went away', health: null, healthSlug: null }));
  if (firstFail) {
    ok('a FIRST failed scan offers "Scan wiki health" -- nothing has been scanned',
      firstFail.includes('Scan wiki health'), firstFail.slice(0, 400));
    ok('...and never the word Rescan', !firstFail.includes('Rescan'));
    ok('...the error is still a danger status, unchanged', firstFail.includes('tx-status-danger'));
  }

  // (b) A FAILURE AFTER A SUCCESS. A result for this domain DOES exist —
  // the panel is simply showing the error instead of it — so "Rescan" is
  // the true word and must survive the fix.
  const laterFail = callOrFail('a rescan that failed behind an existing report', () =>
    render({ healthLoading: false, healthError: 'network', health: REPORT, healthSlug: 'articles' }));
  if (laterFail) {
    ok('a failure AFTER a successful scan still says "Rescan"',
      laterFail.includes('Rescan'), laterFail.slice(0, 400));
    ok('...and does not regress to the first-scan wording', !laterFail.includes('Scan wiki health'));
  }

  // (c) A FAILURE WHOSE ONLY REPORT BELONGS TO ANOTHER DOMAIN. The stamp is
  // what separates (a) from (b), and it is the same predicate the readout
  // branch uses — so a report scanned for `beta` must read as no result.
  const foreign = callOrFail('a failed scan with only another domain\'s report in memory', () =>
    render({ healthLoading: false, healthError: 'network', health: REPORT, healthSlug: 'beta' }));
  if (foreign) {
    ok('another domain\'s report does not make this one say "Rescan"',
      foreign.includes('Scan wiki health') && !foreign.includes('Rescan'));
  }

  // (d) THE READOUT BRANCH. Unchanged, and asserted so a future "fix" that
  // makes it say "Scan wiki health" over a report on screen goes red.
  const settled = callOrFail('a settled report', () =>
    render({ healthLoading: false, healthError: null, health: REPORT, healthSlug: 'articles' }));
  if (settled) {
    ok('with a report on screen the button says "Rescan"', settled.includes('Rescan'));
    ok('...never "Scan wiki health", which would be false there', !settled.includes('Scan wiki health'));
    // v3.65.0: the five readouts became a MONITOR inside a `Scan` fold row
    // (catalogue entry M6), so the needle follows the figure and the stamp
    // into the instrument rather than pinning the old container's name.
    ok('...and the open-issue figure and the scan stamp are both in the monitor',
      /cur-mon-key">open issues<\/span><span class="cur-mon-value">2</.test(settled)
      && /cur-mon-key">scanned</.test(settled), settled.slice(settled.indexOf('cur-mon'), settled.indexOf('cur-mon') + 260));
    // THE WHOLE OPEN TAG, because `open` sits BEFORE `data-group-key` in the
    // markup and a regex anchored on the key looks past it — which is how the
    // first cut of this assertion stayed GREEN against a row hardcoded open.
    const scanTag = (/<details[^>]*data-group-key="scan"[^>]*>/.exec(settled) || [''])[0];
    ok('...and the row is CLOSED with `expandedGroups` empty, which is the shipped default \u2014 '
      + 'the headline is the reading, the breakdown is the dive-in',
      scanTag !== '' && !/\sopen(\s|>)/.test(scanTag), scanTag || '(no scan row)');
    ok('...while its own summary still says so, so the reading survives the fold rather than '
      + 'being hidden by it',
      // v3.72.1 (F12): the age is a ticking [data-age-at] span.
      /dm-group-meta">2 open issue[s]? \u00b7 <span data-age-at="[^"]+" data-age-text>10s ago<\/span></.test(settled),
      (/<span class="dm-group-meta">[^<]*/.exec(settled) || ['(none)'])[0]);
  }

  // (e) MID-SCAN. Neither label: the panel says what is happening.
  const busy = callOrFail('a scan running behind an existing report', () =>
    render({ healthLoading: true, healthError: null, health: REPORT, healthSlug: 'articles', busyKey: 'rescan' }));
  if (busy) {
    ok('while scanning the button says "Scanning…" and neither label',
      busy.includes('Scanning…') && !busy.includes('Rescan') && !busy.includes('Scan wiki health'));
  }
}
{
  // THE LABEL FUNCTION ITSELF, in isolation, with its icons — so a mutation
  // that swaps the two arms is caught even if every caller were stubbed.
  const label = new Function('icon', extractFunction(SRC, 'healthScanLabel') + '\nreturn healthScanLabel;')((n) => '[' + n + ']');
  eq('healthScanLabel(true) is the rescan wording', label(true), '[refresh] Rescan');
  eq('healthScanLabel(false) names the action for someone who has never scanned', label(false), '[activity] Scan wiki health');
  ok('the two arms differ in their ICON as well as their word -- a refresh glyph is a claim about a previous run',
    label(true) !== label(false) && !label(false).includes('refresh'));
}

// ═════════════════════════════════════════════════════════════════════════
section('S4 -- THE PAGE LIST IS LOADED WITH THE DOMAIN');
// ═════════════════════════════════════════════════════════════════════════
//
// The panel above can only be open by default if something actually asks for
// the list. Both entry points are driven here: switching domains, and
// entering the view.
{
  const PRE = `
let state = {};
let myMountToken = 7;
const calls = { browse: [], health: [], projects: [], render: 0 };
function render() { calls.render++; }
function isCurrentMount(t) { return t === myMountToken; }
function reportAsyncActionFailure() {}
function loadHealth(slug, token, opts) { calls.health.push({ slug, token, opts }); return Promise.resolve(); }
function loadProjects(slug, token) { calls.projects.push({ slug, token }); return Promise.resolve(); }
function loadBrowse(slug, token) { calls.browse.push({ slug, token }); return Promise.resolve(); }
`;
  const sb = new Function(
    PRE + extractFunction(SRC, 'selectDomain') +
    `\nreturn { selectDomain, __setState: (s) => { state = s; }, __state: () => state, __calls: () => calls };`
  )();
  sb.__setState({ activeSlug: 'alpha', expandedGroups: new Set(), browse: { slug: 'alpha', entries: [1] } });
  sb.selectDomain('beta');
  const c = sb.__calls();
  eq('switching domain asks for the new domain\'s page list', c.browse.length, 1);
  eq('...for that domain', c.browse[0].slug, 'beta');
  eq('...on this mount\'s token, so a stale reply cannot paint', c.browse[0].token, 7);
  eq('CONTROL -- the health scan is still asked for too', c.health.length, 1);
  eq('CONTROL -- and the project list', c.projects.length, 1);
  eq('the PREVIOUS domain\'s list was dropped before the ask, never rendered under the new heading',
    sb.__state().browse, null);

  // Re-selecting the SAME domain is a no-op, so a click on the active row
  // does not re-fetch three lists.
  const before = c.browse.length;
  sb.__setState({ activeSlug: 'beta', expandedGroups: new Set(), browse: null });
  sb.selectDomain('beta');
  eq('re-selecting the domain already shown asks for nothing', c.browse.length, before);
}
{
  // ENTERING THE VIEW. loadDomainsList is the mount path, and it is driven
  // for real — awaits included — rather than grepped.
  const PRE = `
let state = { semanticScan: null, health: null, healthSlug: null };
const calls = { browse: [], health: [], projects: [] };
let loadGate = null;
// v3.62.0 (P1-9). The module variable onEnter writes the shell's one-shot
// domain request into and loadDomainsList spends. NULL here, which is the
// no-request case: this section's subject is the ORDINARY mount, and the
// request's own behaviour is driven end to end in test-next-domain-request.js.
let arrivalRequest = null;
const NEW_PROJECT_REASON = 'new-project';
function freshProjectLifecycle() { return { mode: 'create' }; }
function render() {}
function isCurrentMount() { return true; }
function reportAsyncActionFailure() {}
function settleGate(_g, fn) { fn(); }
// v3.72.1 (F9): inert here; see scripts/test-domains-true-numbers.js §11.
function staleHealthSlugs() { return []; }
function loadHealth(slug, token, opts) { calls.health.push({ slug, token, opts }); return Promise.resolve(); }
function loadProjects(slug, token) { calls.projects.push({ slug, token }); return Promise.resolve(); }
function loadBrowse(slug, token) { calls.browse.push({ slug, token }); return Promise.resolve(); }
async function fetchJSON(url) {
  if (url === '/api/domains/stats') return { domains: [{ slug: 'alpha' }], readonlyDomains: [] };
  return { available: false };
}
`;
  const sb = new Function(
    PRE +
    extractFunction(SRC, 'shouldKeepSemanticScanOnReload') + '\n' +
    extractFunction(SRC, 'shouldKeepHealthOnReload') + '\n' +
    extractFunction(SRC, 'loadDomainsList') +
    `\nreturn { loadDomainsList, __calls: () => calls, __state: () => state };`
  )();
  const done = callOrFail('loadDomainsList runs to completion', () => sb.loadDomainsList(1));
  if (done) {
    await done;
    const c = sb.__calls();
    eq('entering the view asks for the active domain\'s page list', c.browse.length, 1);
    eq('...for the domain the list resolved to', c.browse[0].slug, 'alpha');
    eq('CONTROL -- the health scan still runs on entry', c.health.length, 1);
    eq('CONTROL -- and the project list', c.projects.length, 1);
  }
}

console.log('\n' + '-'.repeat(60));
console.log('Passed: ' + passed + '   Failed: ' + failed);
if (failed) { console.log('Domains-view card-order assertions FAILED'); process.exit(1); }
console.log('Domains-view card order, open wiki browser and scan labelling hold');
