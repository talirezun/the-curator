#!/usr/bin/env node
/**
 * test-next-domain-pages.js — OFFLINE suite. No network, no API key, no LLM.
 *
 * Guards the v3.50.0 Domains-screen fine-tune
 * (src/public/next/views/domains.js + views/domains.css), reported by the
 * maintainer against two screenshots of his own install.
 *
 * ── THE FIVE THINGS HE REPORTED, AND WHAT EACH MEASURED AS ───────────────
 *  1. "The top number cards float without a card" and there is no PROJECTS
 *     count. Both true: four bordered tiles sat directly on the view
 *     background under no eyebrow, and a domain's projects — one of the two
 *     things a domain HOLDS — had a whole section on the card and no figure
 *     anywhere.
 *  2. "The sections are not visually distinguished" and Projects "sits glued
 *     to Wiki health with no spacing". Measured on v3.49.1 the four gaps came
 *     from four unrelated declarations, one of which was zero:
 *         stats -> Pages     24px + 4px   Pages -> Projects   22px
 *         Projects -> Health  0px
 *     and the three cards were painted in THREE different chromes
 *     (`--surface-raised`/`--border`/no shadow, `--surface`/`--border`/no
 *     shadow, and the kit's own `--surface`/`--hairline`/`--elev-1`).
 *  3. The Projects paragraph must move under an ⓘ "like the domain header's".
 *  4. "All 3421" showing 150 with no way to see the rest. The note said
 *     "narrow the filter to see the rest" and meant it: there was no other
 *     route to row 151.
 *  5. Memory pages are markdown too and should be browsable here.
 *
 * ── EVERYTHING HERE DRIVES REAL CODE ─────────────────────────────────────
 * Functions are lifted out of live source by brace-matching and executed with
 * `new Function` against injected collaborators — the technique
 * test-next-domain-card-order.js and test-next-domain-projects.js use, for the
 * reason this repo keeps re-learning: a test that proves a line of source
 * exists proves nothing about what it does. §4 drives the REAL
 * showMoreBrowseRows against a DOM model, because "appending 150 rows leaves
 * 300 in the list and the button still last" is a mutation of a tree and a
 * substring cannot express one.
 *
 * ── NOT ENFORCED (named, not implied away) ───────────────────────────────
 *  · A tree is not a layout, and a CSS rule is not a rendered pixel. That the
 *    two gaps are EQUAL is asserted by construction — one rule, and no section
 *    carrying a margin of its own — not by measuring a browser. The rendered
 *    pass is the orchestrator's.
 *  · §5's click routing is asserted as a CALL with the right five fields, not
 *    as a network round trip.
 *  · The DOM model in §4 answers ordering, containment and text. It knows
 *    nothing about scroll position, which is the property the append exists to
 *    preserve; that is stated in the source and seen in the rendered pass.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const NEXT = join(ROOT, 'src/public/next');
const SRC = readFileSync(join(NEXT, 'views/domains.js'), 'utf8');
const CSS = readFileSync(join(NEXT, 'views/domains.css'), 'utf8');
// v3.64.2. The OVERVIEW card's geometry and its four states moved to the
// shared component's own stylesheet when the Project-context view adopted
// the same card; only the three ink classes stayed in views/domains.css.
// The assertions below follow the rule rather than re-describing it.
const OV_CSS = readFileSync(join(NEXT, 'shared/overview.css'), 'utf8');
const SHELL_CSS = readFileSync(join(NEXT, 'shell.css'), 'utf8');
const TEXT_JS = readFileSync(join(NEXT, 'shared/text.js'), 'utf8');

let passed = 0, failed = 0;
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

// ── Extraction (same brace matcher the sibling suites use) ────────────────
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
  if (extracted.includes('\n') && !/\n\}$/.test(extracted)) throw new Error(`extractFunction: "${name}" desynced`);
  return extracted;
}
function extractConstText(source, name) {
  const re = new RegExp(`(?:^|\\n)const ${name} = [^\\n]*;`);
  const m = re.exec(source);
  if (!m) throw new Error(`extractConstText: "${name}" not found as a single-line const`);
  return m[0].trim();
}
// ── A multi-line STRING const, lifted rather than re-typed ────────────────
// `extractConstText` above matches a SINGLE line. The three ⓘ texts
// (MARKER_INFO_TEXT, AGENT_INFO_TEXT, PROJECTS_INFO_HTML) are multi-line string
// concatenations, and re-typing them here would make every assertion about a
// COPY of the shipped words. Scans forward from the `=` for the first `;` that
// is not inside a string literal, so a semicolon in the prose (or in an HTML
// entity) cannot end the extraction early.
function extractConstString(source, name) {
  const re = new RegExp(`(?:^|\\n)const ${name} =`);
  const m = re.exec(source);
  if (!m) throw new Error(`extractConstString: "${name}" not found`);
  const start = m.index + (source[m.index] === '\n' ? 1 : 0);
  let i = source.indexOf('=', start) + 1;
  let quote = null;
  for (; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === ';') return source.slice(start, i + 1);
  }
  throw new Error(`extractConstString: "${name}" never terminated`);
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

// ── A DOM MODEL ──────────────────────────────────────────────────────────
// Not jsdom (this repo ships zero devDependencies): a tree that answers
// document order, containment, class membership, text and — for §4 — the four
// mutations showMoreBrowseRows performs. Anything it cannot answer is named in
// the docblock rather than faked.
function parseNodes(html) {
  const root = { tagName: 'ROOT', attrs: {}, children: [], parentNode: null, text: '' };
  const stack = [root];
  const re = /<\/?([a-zA-Z0-9]+)((?:\s+[a-zA-Z0-9:_-]+(?:="[^"]*")?)*)\s*\/?>|([^<]+)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[3] !== undefined) { stack[stack.length - 1].text += m[3]; continue; }
    if (m[0][1] === '/') { if (stack.length > 1) stack.pop(); continue; }
    const attrs = {};
    const ar = /([a-zA-Z0-9:_-]+)(?:="([^"]*)")?/g;
    let a;
    while ((a = ar.exec(m[2])) !== null) { if (a[1]) attrs[a[1]] = a[2] === undefined ? '' : a[2]; }
    const node = makeNode(m[1].toUpperCase(), attrs, stack[stack.length - 1]);
    stack[stack.length - 1].children.push(node);
    const selfClosing = /\/>$/.test(m[0]) || /^(input|img|br|hr|meta|link)$/i.test(m[1]);
    if (!selfClosing) stack.push(node);
  }
  return root;
}
function makeNode(tagName, attrs, parentNode) {
  const node = {
    tagName, attrs, children: [], parentNode, text: '', listeners: [],
    get classList() { return String(attrs.class || '').split(/\s+/).filter(Boolean); },
    // A LIVE getter, never a post-pass over a node list: showMoreBrowseRows
    // inserts nodes the test never touches again, and a decorate-on-query
    // shim would leave exactly those rows without a `dataset` — which is the
    // half of the click path the append exists to keep working.
    get dataset() {
      const out = {};
      for (const [k, v] of Object.entries(attrs)) {
        if (k.startsWith('data-')) out[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
      }
      return out;
    },
    get previousElementSibling() {
      if (!node.parentNode) return null;
      const i = node.parentNode.children.indexOf(node);
      return i > 0 ? node.parentNode.children[i - 1] : null;
    },
    get textContent() { return node.text + node.children.map((c) => c.textContent).join(''); },
    set textContent(v) { node.children.length = 0; node.text = String(v); },
    matches(sel) { return matchSel(node, sel); },
    remove() {
      if (!node.parentNode) return;
      const i = node.parentNode.children.indexOf(node);
      if (i >= 0) node.parentNode.children.splice(i, 1);
      node.parentNode = null;
    },
    querySelector(sel) { return descendants(node).find((n) => matchSel(n, sel)) || null; },
    querySelectorAll(sel) { return descendants(node).filter((n) => matchSel(n, sel)); },
    addEventListener(type, fn) { node.listeners.push({ type, fn }); },
    click() { node.dispatch('click'); },
    dispatch(type) { node.listeners.filter((l) => l.type === type).forEach((l) => l.fn()); },
    // An <input> the view reads and re-focuses. `value` starts at the rendered
    // attribute, which is what makes a re-render's caret restore observable.
    value: attrs.value === undefined ? undefined : attrs.value,
    selectionStart: 0,
    focus() { node.focused = true; },
    setSelectionRange(a) { node.selectionStart = a; },
    insertAdjacentHTML(where, html) {
      const parsed = parseNodes(html).children;
      if (where === 'beforeend') {
        for (const c of parsed) c.parentNode = node;
        node.children.push(...parsed);
        return;
      }
      if (where !== 'beforebegin') throw new Error('the model implements beforeend and beforebegin only');
      const parent = node.parentNode;
      const at = parent.children.indexOf(node);
      for (const c of parsed) c.parentNode = parent;
      parent.children.splice(at, 0, ...parsed);
    },
  };
  return node;
}
function descendants(node) { return node.children.flatMap((c) => [c, ...descendants(c)]); }
function matchSel(node, sel) {
  // Enough of a selector engine for `.cls`, `[attr]` and `.cls[attr]`, which
  // is every selector this view passes to querySelectorAll.
  const parts = sel.trim().split(/(?=[.\[])/).filter(Boolean);
  return parts.every((p) => {
    if (p.startsWith('.')) return node.classList.includes(p.slice(1));
    if (p.startsWith('[')) {
      const inner = p.slice(1, -1);
      const eqi = inner.indexOf('=');
      if (eqi === -1) return Object.prototype.hasOwnProperty.call(node.attrs, inner);
      const k = inner.slice(0, eqi);
      const v = inner.slice(eqi + 1).replace(/^"|"$/g, '');
      return node.attrs[k] === v;
    }
    return true;
  });
}
const hasClass = (n, c) => n.classList ? n.classList.includes(c) : String(n.attrs.class || '').split(/\s+/).includes(c);
function docIndex(root) {
  const seq = descendants(root);
  return (pred) => seq.findIndex(pred);
}

// ═════════════════════════════════════════════════════════════════════════
// The sandbox: the REAL renderMain, the REAL Pages panel, the REAL projects
// panel, the REAL pagination. Only the health panel is a marker — it has its
// own suites and it is not what this release changed about it (the section
// wrapper IS asserted, in §1, off the real function).
// ═════════════════════════════════════════════════════════════════════════
const PREAMBLE = `
let state = {};
let documentImpl = { getElementById: () => null, querySelectorAll: () => [],
  querySelector: () => null };
const calls = { setMain: [], render: 0, reader: [], asyncFailures: 0 };
const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
function icon() { return ''; }
function isCurrentMount() { return true; }
function isCurrentReader() { return true; }
function setMain(html) { calls.setMain.push(html); }
function render() { calls.render++; }
function domainsHeader() { return '<div class="dm-header-STUB"></div>'; }
const loadGate = null;
const myMountToken = 1;
function gatedLoader(_g, label) { return '<div class="dm-browse-empty">' + label + '</div>'; }
function renderKnowledgeNotice() { return ''; }
function renderLookedInLine() { return ''; }
function knowledgeFolderBtn() { return ''; }
function emptyCard() { return '<div class="dm-empty-STUB"></div>'; }
function renderLifecycleCard() { return ''; }
function renderProjectLifecycleCard() { return ''; }
function renderViewHeader(o) { return '<div class="tx-view-header">' + escapeHtml(o.title) + '</div>'; }
function renderStatus(o) { return '<div class="tx-status tx-status-' + o.state + '">' + escapeHtml(o.title) + '</div>'; }
function renderDescription(t) { return '<p class="tx-desc">' + escapeHtml(t) + '</p>'; }
function renderBadge(o) { return '<span class="tx-badge">' + escapeHtml(o.label) + '</span>'; }
function renderMarkdown(t) { return '<p class="md">' + escapeHtml(t) + '</p>'; }
function relTime() { return 'just now'; }
function openReader(content) { calls.reader.push(content); return 1; }
async function fetchJSON(url) { return (await fetchResponder(url)); }
let fetchResponder = async () => ({});
function reportAsyncActionFailure() { calls.asyncFailures++; }
function openWikiPageFromBrowse(p, t) { calls.reader.push({ wiki: p, title: t }); }
function renderHealthPanel() { return '<div class="STUB-health"></div>'; }
function openLifecycle() {}
function goToChatScoped() {}
function bindLifecycleListeners() {}
function bindProjectListeners() {}
function bindKnowledgeListeners() {}
function bindHealthListeners() {}
function bindBrowseListeners() {}
// v3.58.0: renderMain wires the OVERVIEW figures, which are now controls over
// the page-list facet. The REAL selectBrowseFacet is lifted below (S6 drives
// it); only the binding pass is stubbed, as its five siblings are.
function bindStatCardListeners() {}
const MIRROR_INFO = 'mirror-info';
const DOMAIN_BLURB = 'domain-blurb';
const MIRROR_WARNING = 'mirror-warning';
const document = { get getElementById() { return documentImpl.getElementById; },
                   get querySelectorAll() { return documentImpl.querySelectorAll; },
                   get querySelector() { return documentImpl.querySelector; } };
`;

// The REAL banner text, injected rather than stubbed -- renderCopyOutcome is
// lifted here so the projects panel it feeds can be rendered at all.
const { COPY_SUCCESS_BANNER, TEMPLATE } =
  await import('../src/public/next/shared/agent-instructions.js');

// The REAL docs table (v3.62.0). `docsUrl()` THROWS on an unknown key, which
// is the module's whole point, so injecting the real one is what makes a
// mistyped key a FATAL here instead of a blank panel in the browser.
const { docsLinkHtml } =
  await import('../src/public/next/shared/docs-links.js');
const { renderOverview } = await import('../src/public/next/shared/overview.js');
// v3.71.0: G3/G4's ⓘ (`PAGES_INFO`, `HEALTH_INFO`) are module consts computed
// from the real kit, the same reason docsLinkHtml/renderOverview above are
// the real modules and not stubs.
// v3.71.1: every ⓘ in the view is the kit's now (INGEST_INFO, the project
// marks, the OVERVIEW legend), so all three entry points are injected REAL.
const { explainerMark, explainerHtml, explainerLabel } = await import('../src/public/next/shared/explainer.js');
const { EXPLAINERS } = await import('../src/public/next/shared/explainers.js');

const FNS = [
  'activeBrowse', 'activeProjects', 'projectCount', 'projInfoId',
  'filterBrowseEntries', 'filterMemoryEntries', 'browseMatches', 'browseWindow',
  'browseRowHtml', 'memoryRowHtml', 'browseMoreHtml', 'browseNoteHtml',
  'renderBrowsePanel', 'renderStatCards', 'renderProjectRow', 'renderCopyOutcome', 'renderProjectsPanel',
  'showMoreBrowseRows', 'bindBrowseRowClicks', 'bindBrowseListeners', 'openMemoryPageFromBrowse',
  // v3.58.0. The ONE write path the chip row and the OVERVIEW tiles share --
  // lifted, never stubbed, because bindBrowseListeners below is driven for
  // real and a stub would make the facet assertions vacuous.
  'selectBrowseFacet', 'scrollSectionIntoView',
  'healthSection', 'renderMain',
  // v3.71.1: `infoMark` and `threeLayersInfoHtml` are gone from the view —
  // the OVERVIEW legend is the `domains.overview` explainer, from the real kit.
];

let box;
try {
  box = new Function(
    'COPY_SUCCESS_BANNER', 'docsLinkHtml', 'renderOverview', 'explainerMark',
    'explainerHtml', 'explainerLabel',
    PREAMBLE +
    // v3.65.0 (R4): section ①'s explanation left the fold's BODY for an ⓘ on
    // its head, and the sentence is a module const so `renderMain` does not
    // carry a paragraph every lifting sandbox has to carry with it. LIFTED,
    // not stubbed — the words are the thing R4 moved.
    extractConstText(SRC, 'INGEST_INFO') + '\n' +
    // v3.71.0 (G3/G4): the Pages eyebrow and the Wiki health section each
    // gained their own ⓘ — both consts are computed from `explainerMark`.
    extractConstText(SRC, 'PAGES_INFO') + '\n' +
    extractConstText(SRC, 'HEALTH_INFO') + '\n' +
    extractConstText(SRC, 'BROWSE_EYEBROW') + '\n' +
    extractConstText(SRC, 'BROWSE_RENDER_CAP') + '\n' +
    extractConstArray(SRC, 'BROWSE_FOLDERS') + '\n' +
    // v3.71.1: the three ⓘ text consts are gone (each is an explainer now).
    FNS.map((n) => extractFunction(SRC, n)).join('\n\n') + '\n' +
    `return { ${FNS.join(', ')}, BROWSE_RENDER_CAP, BROWSE_FOLDERS,
       __state: () => state, __setState: (s) => { state = s; },
       __calls: () => calls, __reset: () => { calls.setMain.length = 0; calls.render = 0;
         calls.reader.length = 0; calls.asyncFailures = 0; },
       __setDocument: (d) => { documentImpl = d; },
       __setFetch: (fn) => { fetchResponder = fn; } };`
  )(COPY_SUCCESS_BANNER, docsLinkHtml, renderOverview, explainerMark, explainerHtml, explainerLabel);
} catch (err) {
  console.log('FATAL: could not build the sandbox from domains.js -- ' + err.message);
  process.exit(1);
}

const ENTRY = (over) => ({ slug: 'alpha-note', folder: 'entities', path: 'entities/alpha-note.md', title: 'Alpha note', ...over });
const MEM_BRIEF = { kind: 'brief', project: 'lumina', isDefaultProject: false, scope: null, machine: null,
  path: 'state/lumina/project.md', title: 'lumina · Standing brief' };
const MEM_HANDOFF = { kind: 'handoff', project: 'lumina', isDefaultProject: false, scope: 'design', machine: 'mac-ab12',
  path: 'state/lumina/design/mac-ab12/current.md', title: 'lumina · design · mac-ab12' };

const browseState = (over) => ({
  slug: 'alpha', loading: false, error: null, filter: '', folder: 'all', truncated: false,
  window: box.BROWSE_RENDER_CAP, memory: [], memoryTruncated: false,
  entries: [ENTRY(), ENTRY({ slug: 'idea', folder: 'concepts', path: 'concepts/idea.md', title: 'Idea' })],
  ...over,
});
const projectsState = (over) => ({
  slug: 'alpha', loading: false, error: null, canWrite: true, readonly: false, truncated: false, total: 2,
  rows: [
    { domain: 'alpha', project: 'alpha', isDefaultProject: true, hasBrief: true, newestScope: 'main', lastWriteAt: '2026-09-01T00:00:00Z' },
    { domain: 'alpha', project: 'lumina', isDefaultProject: false, hasBrief: true, newestScope: 'design', lastWriteAt: '2026-09-02T00:00:00Z' },
  ],
  ...over,
});
const mainState = (over) => ({
  loaded: true, loadError: null, activeSlug: 'alpha',
  domains: [{ slug: 'alpha', displayName: 'Alpha', pageCount: 3, pageCounts: { entities: 1, concepts: 1, summaries: 1, other: 0 } }],
  readonlySet: new Set(), markerCopied: null, projectLc: null,
  browse: browseState(), projects: projectsState(),
  ...over,
});
function renderCard(over) {
  box.__reset();
  box.__setState(mainState(over));
  box.renderMain(1);
  return box.__calls().setMain[0];
}

// ═════════════════════════════════════════════════════════════════════════
section('S1 -- FOUR SECTIONS, ONE RHYTHM, ONE CHROME');
// ═════════════════════════════════════════════════════════════════════════
{
  const html = callOrFail('renderMain composes a domain card', () => renderCard());
  if (html) {
    const root = parseNodes(html);
    const sections = descendants(root).filter((n) => n.tagName === 'SECTION' && hasClass(n, 'dm-section'));
    // The health panel is stubbed here; §1b drives the REAL one for its wrapper.
    eq('three of the four sections render as .dm-section (health is stubbed here; see S1b)', sections.length, 3);
    // `cur-ov` is the shared component's own class on the OVERVIEW section
    // (v3.64.2); this line has always been asking which dm- section each one is.
    const keys = sections.map((s) => s.classList.filter(
      (c) => c !== 'dm-section' && c !== 'cur-ov').join(''));
    eq('...in the reported order: overview, pages, projects', keys.join(' > '), 'dm-overview > dm-pages > dm-projects');

    for (const s of sections) {
      const eyebrow = descendants(s).find((n) => hasClass(n, 'dm-section-eyebrow'));
      ok('.' + s.classList[1] + ' carries a section eyebrow', !!eyebrow,
        'no .dm-section-eyebrow inside .' + s.classList[1]);
    }
    const at = docIndex(root);
    const iHealth = at((n) => hasClass(n, 'STUB-health'));
    ok('CONTROL -- the health panel is still last, after the three sections',
      iHealth > at((n) => hasClass(n, 'dm-projects')), String(iHealth));
  }
}
{
  // S1b -- THE REAL health panel, for the wrapper only.
  const healthSection = box.healthSection;
  const wrapped = healthSection('<div class="dm-health-card">x</div>');
  const root = parseNodes(wrapped);
  const s = root.children[0];
  ok('the real healthSection wraps the card in a .dm-section', s && s.tagName === 'SECTION' && hasClass(s, 'dm-section'));
  ok('...classed dm-health, so the four sections are addressable', s && hasClass(s, 'dm-health'));
  // v3.64.2: Title case, like the Context view's steps — the second half of
  // the maintainer's "one rule for all five headings" report.
  ok('...with its own eyebrow, reading Wiki health',
    /class="cur-group-title dm-section-eyebrow">Wiki health</.test(wrapped));
  // AN EMPTY BODY RENDERS NOTHING AT ALL. renderHealthPanel returns '' when
  // there is no report, and a heading over nothing looks like a failure.
  eq('an empty body renders no section and no eyebrow', healthSection(''), '');
}
{
  // ── THE GAPS ARE EQUAL BY CONSTRUCTION, WHICH IS THE ONLY WAY TO PROVE
  //    IT OFFLINE. Two gaps being the same number in two rules is a
  //    coincidence maintained by hand; ONE rule over adjacent siblings, with
  //    every section's own margin zeroed, cannot disagree with itself.
  const rule = /\.dm-section \+ \.dm-section\s*\{([^}]*)\}/.exec(CSS);
  ok('domains.css carries ONE adjacent-sibling rule for the section gap', !!rule);
  ok('...and it sets a margin-top from the space scale, not a literal',
    rule && /margin-top:\s*var\(--space-\d+\)/.test(rule[1]), rule && rule[1]);

  // ANTI-VACUITY, and the actual defect: any section carrying its own
  // margin-top re-creates the "22px above, 0px below" the maintainer saw.
  const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
  const bare = stripComments(CSS);
  const own = /\.dm-projects\s*\{([^}]*)\}/.exec(bare);
  ok('.dm-projects no longer carries a margin-top of its own', own && /margin-top:\s*0/.test(own[1]), own && own[1]);
  const eyebrowRule = /\.dm-recent-eyebrow\s*\{([^}]*)\}/.exec(bare);
  ok('...nor does the Pages eyebrow', eyebrowRule && /margin-top:\s*0/.test(eyebrowRule[1]), eyebrowRule && eyebrowRule[1]);
  const grid = /\.cur-ov-grid\s*\{([^}]*)\}/.exec(stripComments(OV_CSS));
  ok('...and the stat grid no longer owns the gap BELOW it either',
    grid && !/margin-bottom/.test(grid[1]), grid && grid[1]);
  const healthCard = /\n\.dm-health-card\s*\{([^}]*)\}/.exec(bare);
  // margin-TOP only. The health card is the LAST section and keeps a
  // margin-BOTTOM, which is breathing room at the end of the column and not a
  // gap between two sections — the gap this release is about is the one ABOVE
  // it, which was zero.
  ok('...and the health card declares no margin-top, so the gap above it is the section rule’s',
    healthCard && !/margin-top/.test(healthCard[1]), healthCard && healthCard[1]);
}
{
  // ── ONE CARD CHROME. The three cards were painted three different ways.
  // ANCHORED AT A LINE START, so `.cur-group-title` and `.cur-group +
  // .cur-group` cannot answer for `.cur-group` — both sit in shell.css within
  // ten lines of it.
  const decl = (css, sel, prop) => {
    const m = new RegExp('\\n' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}').exec(css);
    if (!m) return null;
    const d = new RegExp('(?:^|;|\\n)\\s*' + prop + '\\s*:\\s*([^;]+)').exec(m[1]);
    return d ? d[1].trim() : null;
  };
  const group = ['background', 'border', 'box-shadow'].map((p) => decl(SHELL_CSS, '.cur-group', p));
  ok('CONTROL -- shell.css does declare the kit group’s chrome', group.every(Boolean), JSON.stringify(group));
  for (const sel of ['.dm-browse-card', '.dm-health-card']) {
    const got = ['background', 'border', 'box-shadow'].map((p) => decl(CSS, sel, p));
    ok(sel + ' takes the SAME chrome as the kit group Projects uses',
      JSON.stringify(got) === JSON.stringify(group), JSON.stringify(got) + ' vs ' + JSON.stringify(group));
  }
  // ANTI-VACUITY: the values it moved OFF were genuinely different.
  ok('...and the pre-fix value really was different, so the three assertions above are findings',
    !/--surface-raised/.test((/\.dm-browse-card\s*\{([^}]*)\}/.exec(CSS) || ['', ''])[1]));
}

// ═════════════════════════════════════════════════════════════════════════
section('S2 -- THE OVERVIEW CARD, AND THE FIGURE THAT WAS MISSING');
// ═════════════════════════════════════════════════════════════════════════
{
  const html = renderCard();
  const root = parseNodes(html);
  const overview = descendants(root).find((n) => hasClass(n, 'dm-overview'));
  ok('CONTROL -- the overview section is in the tree', !!overview);
  const group = overview && descendants(overview).find((n) => hasClass(n, 'dm-stats-group'));
  ok('the figures sit inside the kit’s inset group -- the reported "float without a card"',
    !!group && hasClass(group, 'cur-group'), group && group.classList.join(' '));
  const grid = group && descendants(group).find((n) => hasClass(n, 'dm-stats-grid'));
  ok('...and the grid is INSIDE that group, not beside it', !!grid);
  const cards = grid ? grid.children.filter((n) => hasClass(n, 'dm-stat-card')) : [];
  // SEVEN SINCE v3.65.0, and the two extra are not new readings: SOURCES and
  // SHARED were a separate `.dm-jump-row` of `.dm-jump-card`s inside this same
  // card, measured at 92.8 x 46.4 beside a 181.8 x 78.9 tile at a 16px indent
  // -- *"an entirely different design than the five on top"*. They are
  // ordinary tiles in this grid now. The FIGURES are still five, which is the
  // fact this assertion was really about, so both are asserted.
  eq('seven tiles -- the five figures and the two jumps, in ONE grid', cards.length, 7);
  eq('five of them are FIGURES, not jumps to somewhere else',
    cards.filter((n) => n.attrs['data-stat-jump'] !== 'sources'
      && n.attrs['data-stat-jump'] !== 'shared').length, 5);
  eq('...and the fifth figure is PROJECTS', cards[4] && cards[4].children[0].textContent, 'PROJECTS');
  ok('the section is labelled OVERVIEW',
    /class="cur-ov-eyebrow cur-group-title dm-section-eyebrow">OVERVIEW</.test(html));
}
{
  // THE COUNT IS THE PROJECTS LIST'S OWN. Driven through the real
  // projectCount() against the real activeProjects(), because the failure this
  // guards is the card and the list below it disagreeing.
  const value = (html, label) => {
    const card = descendants(parseNodes(html)).find(
      (n) => hasClass(n, 'dm-stat-card') && n.children[0] && n.children[0].textContent === label);
    return card ? card.children[1].textContent : null;
  };
  eq('the PROJECTS figure equals the projects list', value(renderCard(), 'PROJECTS'), '2');
  const three = projectsState({ total: 3, rows: [
    { project: 'a', hasBrief: true }, { project: 'b', hasBrief: true }, { project: 'c', hasBrief: false }] });
  eq('...and moves with it', value(renderCard({ projects: three }), 'PROJECTS'), '3');
  // A DOMAIN WITH NO PROJECTS IS A REAL ANSWER, and it is zero.
  eq('a domain whose store lists none reads 0',
    value(renderCard({ projects: projectsState({ total: 0, rows: [] }) }), 'PROJECTS'), '0');
  // AND AN UNKNOWN COUNT IS NOT ZERO. This is the module's recorded dominant
  // defect class one layer up: a fact and its absence collapsed into one value.
  eq('a list still loading reads an em dash, never 0',
    value(renderCard({ projects: projectsState({ loading: true, rows: [], total: undefined }) }), 'PROJECTS'), '—');
  eq('...and so does a list that failed',
    value(renderCard({ projects: projectsState({ error: 'nope', rows: [], total: undefined }) }), 'PROJECTS'), '—');
  // THE STORE'S UNCAPPED TOTAL WINS OVER THE ROW COUNT, because rows are
  // capped at MAX_PROJECTS_PER_DOMAIN and a cap reported as a measurement is
  // this store's other recorded defect.
  eq('a truncated list reports the store’s real total, not the number of rows it painted',
    value(renderCard({ projects: projectsState({ total: 240, truncated: true }) }), 'PROJECTS'), '240');
}

// ═════════════════════════════════════════════════════════════════════════
section('S2b -- A FIGURE IS A SHORTCUT TO THE LIST IT COUNTS (v3.58.0)');
// ═════════════════════════════════════════════════════════════════════════
//
// Reported by a user reviewing the app on video: he wanted to press ENTITIES
// and get the entities, and had not noticed the filter chips under PAGES · THE
// WIKI "for a long time". The chips stay; the figures become a second control
// over the SAME filter state, which is the property every assertion below is
// really about -- a tile with its own notion of "selected" would be a second
// state free to disagree with the list under it.
{
  const tiles = (html) => descendants(parseNodes(html)).filter((n) => hasClass(n, 'dm-stat-card'));
  const byLabel = (html, label) => tiles(html).find(
    (n) => n.children[0] && n.children[0].textContent === label);

  const html = renderCard();
  const facets = tiles(html).filter((n) => n.attrs['data-stat-facet'] !== undefined);
  eq('four figures are controls over a chip', facets.length, 4);
  eq('...PAGES selects All', byLabel(html, 'PAGES').attrs['data-stat-facet'], 'all');
  for (const [label, key] of [['ENTITIES', 'entities'], ['CONCEPTS', 'concepts'], ['SUMMARIES', 'summaries']]) {
    eq('...' + label + ' selects the ' + key + ' facet', byLabel(html, label).attrs['data-stat-facet'], key);
  }
  ok('every facet named by a tile is a REAL chip, not a string that looks like one',
    facets.every((t) => box.BROWSE_FOLDERS.some((f) => f.key === t.attrs['data-stat-facet'])),
    facets.map((t) => t.attrs['data-stat-facet']).join(', '));
  ok('...and they are <button>s, so keyboard and touch reach them',
    facets.every((t) => t.tagName === 'BUTTON'), facets.map((t) => t.tagName).join(', '));

  // PROJECTS HAS NO CHIP, so it jumps instead -- and it is NOT a toggle, so it
  // carries no aria-pressed. aria-pressed on a control that does not stay
  // pressed is a lie told only to a screen reader.
  const proj = byLabel(html, 'PROJECTS');
  eq('PROJECTS jumps to its section rather than filtering', proj.attrs['data-stat-jump'], 'projects');
  ok('...and carries no aria-pressed, because it is not a toggle',
    proj.attrs['aria-pressed'] === undefined, proj.attrs['aria-pressed']);
  ok('...and no facet either, so it can never write the filter state',
    proj.attrs['data-stat-facet'] === undefined);

  // ONE SOURCE OF TRUTH. The tile's pressed state and the chip's `.active` are
  // read from the same field, so they cannot disagree.
  const chipActive = (h, key) => {
    const c = descendants(parseNodes(h)).find(
      (n) => n.attrs['data-browse-folder'] === key);
    return c ? c.classList.includes('active') : null;
  };
  for (const key of ['all', 'entities', 'concepts', 'summaries']) {
    const h = renderCard({ browse: browseState({ folder: key }) });
    const pressed = tiles(h).filter((t) => t.attrs['aria-pressed'] === 'true');
    eq('with folder=' + key + ', exactly ONE figure reads pressed', pressed.length, 1);
    eq('...and it is the one whose facet is ' + key, pressed[0].attrs['data-stat-facet'], key);
    eq('...and the chip of the same name is active too -- one state, two controls',
      chipActive(h, key), true);
    // ANTI-VACUITY: the other three really do read false, not merely absent.
    const others = tiles(h).filter((t) => t.attrs['data-stat-facet'] !== undefined
      && t.attrs['data-stat-facet'] !== key);
    ok('...and the other three read aria-pressed="false", not nothing',
      others.length === 3 && others.every((t) => t.attrs['aria-pressed'] === 'false'),
      others.map((t) => t.attrs['data-stat-facet'] + '=' + t.attrs['aria-pressed']).join(', '));
  }
  // MEMORY is a chip and deliberately NOT a tile: `all` does not include it
  // (see BROWSE_FOLDERS), so a figure for it would contradict PAGES above it.
  ok('the memory facet has a chip and no figure',
    box.BROWSE_FOLDERS.some((f) => f.key === 'memory')
    && !tiles(html).some((t) => t.attrs['data-stat-facet'] === 'memory'));

  // THE ACCESSIBLE NAME CARRIES THE COUNT AND THE OUTCOME, on a real control.
  // v3.20.0 counted 11 pieces of information in this tree carried ONLY by a
  // hover tooltip; this must not become the twelfth.
  ok('every figure-control has an accessible name',
    tiles(html).filter((t) => t.tagName === 'BUTTON').every((t) => (t.attrs['aria-label'] || '').length > 10),
    tiles(html).map((t) => t.attrs['aria-label']).join(' | '));
  const ent = byLabel(html, 'ENTITIES');
  eq('...shaped "Entities, N pages — filter the list"',
    ent.attrs['aria-label'], 'Entities, 1 pages — filter the list');
  ok('...and PROJECTS says it goes somewhere rather than filtering',
    /go to the projects list/.test(proj.attrs['aria-label']), proj.attrs['aria-label']);
  ok('NO figure carries a title= -- a tooltip on a control is hover-only information',
    !tiles(html).some((t) => t.attrs.title !== undefined));

  // A CONTROL ONLY WHILE THERE IS A LIST FOR IT TO ACT ON. A button whose only
  // possible outcome is nothing is worse than no button.
  for (const [what, over] of [
    ['loading', browseState({ loading: true, entries: [] })],
    ['failed', browseState({ error: 'nope', entries: [] })],
  ]) {
    const h = renderCard({ browse: over });
    const t = tiles(h);
    eq('while the page list is ' + what + ', no figure is a facet control',
      t.filter((n) => n.attrs['data-stat-facet'] !== undefined).length, 0);
    ok('...and every tile is still painted, in the same shape -- a reading is a '
      + 'DIV, a jump stays a button because its section renders in every state',
      t.length === 7 && t.every((n) => n.tagName === 'DIV' || n.attrs['data-stat-jump'] !== undefined),
      t.map((n) => n.tagName).join(', '));
    ok('...while PROJECTS still jumps, because its section renders in every state',
      t.some((n) => n.attrs['data-stat-jump'] === 'projects'));
  }
  // OTHER is never a control: there is no chip for it.
  const withOther = renderCard({ domains: [{ slug: 'alpha', displayName: 'Alpha', pageCount: 4,
    pageCounts: { entities: 1, concepts: 1, summaries: 1, other: 1 } }] });
  const other = byLabel(withOther, 'OTHER');
  ok('CONTROL -- an OTHER figure renders when the count is non-zero', !!other);
  ok('...and it is NOT a control, because no chip answers for it',
    other && other.tagName === 'DIV' && other.attrs['data-stat-facet'] === undefined);
}
{
  // THE WRITE PATH, EXECUTED. selectBrowseFacet is the one place both controls
  // write, so this drives it rather than the markup.
  box.__setState(mainState({ browse: browseState({ folder: 'all', window: 400 }) }));
  box.__reset();
  box.selectBrowseFacet('concepts', {});
  eq('selecting a facet writes the filter state', box.__state().browse.folder, 'concepts');
  eq('...and resets the window, because it is a different match set',
    box.__state().browse.window, box.BROWSE_RENDER_CAP);
  ok('...and repaints', box.__calls().render > 0);

  // IT REFUSES RATHER THAN GUESSING. A facet arriving for a list that belongs
  // to another domain, or no key at all, must not write anything -- the layer-2
  // check activeBrowse() exists for.
  box.__setState(mainState({ browse: browseState({ slug: 'OTHER-DOMAIN', folder: 'all' }) }));
  box.__reset();
  box.selectBrowseFacet('entities', {});
  eq('a facet press against ANOTHER domain’s list writes nothing',
    box.__state().browse.folder, 'all');
  eq('...and does not repaint', box.__calls().render, 0);
  box.__setState(mainState({ browse: browseState({ folder: 'all' }) }));
  box.selectBrowseFacet('', {});
  eq('an empty key writes nothing either', box.__state().browse.folder, 'all');
}

// ═════════════════════════════════════════════════════════════════════════
section('S2c -- THE SELECTED FIGURE STILL READS, ON THE TINT IT GAINS');
// ═════════════════════════════════════════════════════════════════════════
//
// A selected figure paints `--accent-tint` behind its digits. That tint is
// rgba, so the plane under the ink is no longer `--surface` -- which is the
// backdrop scripts/test-next-views-kit.js computes these same three inks
// against, and it has no way to know a state was added. Composited here, in
// both themes, from the SHIPPED token values.
{
  const blocksFor = (src, sel) => {
    let out = '', i = 0;
    while ((i = src.indexOf(sel, i)) !== -1) {
      const open = src.indexOf('{', i);
      const close = src.indexOf('}', open);
      if (open === -1 || close === -1) break;
      if (src.slice(i, open).trim() === sel) out += src.slice(open + 1, close) + '\n';
      i = close + 1;
    }
    return out;
  };
  const COLOR = readFileSync(join(NEXT, 'tokens/color.css'), 'utf8');
  // shared/sidebar.css joins the table (v3.65.1): the identity palette's three
  // derived light rungs moved there with the twelve colour rules, so the three
  // `--id-ink-*` names `.dm-stat-value` reads are declared in the KIT now.
  // Without it every one of them resolves to null and the three assertions
  // below grade nothing — loudly, since the ratio helper throws on a null.
  // v3.66.0: those three are the PAGE-TYPE inks and moved to
  // tokens/identity.css as `--type-ink-entity/-concept/-summary` (renamed, so
  // the domain palette could move without re-colouring these figures).
  const KIT = readFileSync(join(NEXT, 'tokens/identity.css'), 'utf8');
  const DARK = blocksFor(COLOR, ':root') + blocksFor(KIT, ':root') + blocksFor(CSS, ':root');
  const LIGHT = DARK + blocksFor(COLOR, '[data-theme="light"]')
    + blocksFor(KIT, '[data-theme="light"]') + blocksFor(CSS, '[data-theme="light"]');
  const table = (src) => {
    const t = {};
    for (const m of src.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) t[m[1]] = m[2].trim();
    return t;
  };
  const resolve = (t, n, d = 0) => {
    const v = t[n];
    if (v === undefined || d > 10) return null;
    const m = /^var\((--[a-z0-9-]+)\)$/.exec(v);
    return m ? resolve(t, m[1], d + 1) : v;
  };
  const toRgb = (v) => {
    if (!v) return null;
    let m = /^#([0-9a-f]{6})$/i.exec(v.trim());
    if (m) return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16), a: 1 };
    m = /^rgba?\(([^)]+)\)$/i.exec(v.trim());
    if (m) { const q = m[1].split(',').map(Number); return { r: q[0], g: q[1], b: q[2], a: q[3] === undefined ? 1 : q[3] }; }
    return null;
  };
  const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  const lum = (c) => { const f = (x) => { const y = x / 255; return y <= 0.03928 ? y / 12.92 : Math.pow((y + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

  // THE FIGURE IS LARGE TEXT and the floor for it is 3:1, not 4.5. That is not
  // a convenience: docs/design-system-source.md §11 records the five OVERVIEW
  // tiles as a deliberate exception at 22px/600, and WCAG's large-text
  // threshold for bold is 18.66px. The EYEBROW above it is small text and is
  // held to 4.5 in the same block.
  const FIG_FLOOR = 3.0;
  const SMALL_FLOOR = 4.5;
  for (const [theme, src] of [['dark', DARK], ['light', LIGHT]]) {
    const t = table(src);
    const surface = toRgb(resolve(t, '--surface'));
    const tint = toRgb(resolve(t, '--accent-tint'));
    ok('CONTROL -- ' + theme + ': both ends of the composite resolve', !!surface && !!tint,
      resolve(t, '--surface') + ' / ' + resolve(t, '--accent-tint'));
    if (!surface || !tint) continue;
    const bg = over(tint, surface);
    for (const tok of ['--text', '--type-ink-entity', '--type-ink-concept', '--type-ink-summary']) {
      const fg = toRgb(resolve(t, tok));
      const got = fg ? ratio(fg, bg) : 0;
      ok(theme + ': ' + tok + ' reads ' + got.toFixed(2) + ':1 on a SELECTED figure (floor ' + FIG_FLOOR + ')',
        got >= FIG_FLOOR, resolve(t, tok));
    }
    const eyebrow = toRgb(resolve(t, '--text-2'));
    const eb = eyebrow ? ratio(eyebrow, bg) : 0;
    ok(theme + ': the tile\u2019s eyebrow reads ' + eb.toFixed(2) + ':1 on the tint (floor ' + SMALL_FLOOR + ')',
      eb >= SMALL_FLOOR);
    // ANTI-VACUITY: the tint really does move the plane, so these are findings
    // and not a restatement of the plain-surface figures the kit already has.
    const plain = ratio(toRgb(resolve(t, '--type-ink-concept')), surface);
    const tinted = ratio(toRgb(resolve(t, '--type-ink-concept')), bg);
    ok(theme + ': CONTROL -- the tint MOVES the reading (' + plain.toFixed(2) + ' -> ' + tinted.toFixed(2) + ')',
      Math.abs(plain - tinted) > 0.05);
  }
  // AND THE SELECTED FILL IS NOT THE ONLY SIGNAL. It composites to 1.13:1
  // against the plain tile -- far under any graphical floor -- which is why
  // the state is ALSO carried by `aria-pressed` and by an --accent-border
  // ring, and why the chip of the same name stays on screen saying the same
  // thing. Recorded rather than measured away.
  const bare = OV_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const sel = /\.cur-ov-group button\.cur-ov-card\[aria-pressed="true"\]\s*\{([^}]*)\}/.exec(bare);
  ok('CONTROL -- the overview kit declares a selected state for the figure', !!sel, 'no rule');
  ok('...which paints the accent TINT, the same fill the chip uses',
    sel && /background:\s*var\(--accent-tint\)/.test(sel[1]), sel && sel[1]);
  ok('...AND an --accent-border edge, because the fill alone is 1.13:1 against the plain tile',
    sel && /box-shadow:\s*inset[^;]*var\(--accent-border\)/.test(sel[1]), sel && sel[1]);
  ok('...as an INSET shadow, so selecting a figure cannot reflow the five-track grid by 2px',
    sel && !/[^-]border:/.test(sel[1]), sel && sel[1]);
  ok('the selected figure carries aria-pressed as well as a fill',
    /\[aria-pressed="true"\]/.test(OV_CSS) && /aria-pressed="/.test(SRC));

  // THE PRESS REACHES A SELECTED FIGURE TOO. `[aria-pressed="true"]` scores
  // (0,3,1) and a bare `:active` ties with it, losing on order -- so pressing
  // an already-selected figure would change nothing but the 1px nudge. The
  // press rule therefore carries BOTH arms: the bare one for the PROJECTS
  // figure, which jumps and has no aria-pressed at all, and the
  // attribute-present one to outrank the selected fill.
  const press = /\.cur-ov-group button\.cur-ov-card:active,\s*\.cur-ov-group button\.cur-ov-card\[aria-pressed\]:active\s*\{([^}]*)\}/.exec(bare);
  ok('the press rule carries both the bare and the [aria-pressed] arm', !!press,
    'the two-arm press selector is gone');
  ok('...declared AFTER the selected fill it has to outrank',
    press && sel && bare.indexOf(press[0]) > bare.indexOf(sel[0]));
  ok('...and it changes the fill, not only the nudge',
    press && /background:\s*var\(--surface-active\)/.test(press[1]) && /transform:/.test(press[1]),
    press && press[1]);
}

// ═════════════════════════════════════════════════════════════════════════
section('S3 -- THE PROJECTS PARAGRAPH IS BEHIND AN ⓘ, LIKE THE HEADER’S');
// ═════════════════════════════════════════════════════════════════════════
{
  box.__setState(mainState());
  const html = box.renderProjectsPanel(false);
  const root = parseNodes(html);
  const head = descendants(root).find((n) => hasClass(n, 'dm-proj-head'));
  ok('CONTROL -- the section header is in the tree', !!head);
  const btn = head && descendants(head).find((n) => n.attrs['data-tx-info'] !== undefined);
  ok('the header carries an ⓘ control', !!btn);
  ok('...which is the SHARED component’s contract, so nothing in this view binds it',
    btn && btn.classList.includes('tx-vh-info'), btn && btn.classList.join(' '));
  const panelId = btn && btn.attrs['data-tx-info'];
  const panel = panelId && descendants(root).find((n) => n.attrs.id === panelId);
  ok('...pointing at a panel that exists', !!panel, 'no #' + panelId);
  ok('...which is hidden until it is asked for', panel && panel.attrs.hidden !== undefined);
  ok('...and wired for assistive tech both ways',
    btn && btn.attrs['aria-controls'] === panelId && btn.attrs['aria-expanded'] === 'false');
  ok('...and the button’s own id is the panel id plus -btn, the shared convention',
    btn && btn.attrs.id === panelId + '-btn', btn && btn.attrs.id);

  // THE FOLD CARRIES THE EXPLANATION (v3.71.1: the `domains.projects`
  // explainer). A stubbed mark would pass "a panel exists" while rendering
  // nothing, so the fold's content is asserted, not its presence.
  ok('the fold contains the explanation that used to be on screen',
    panel && /A project is one piece of work inside this domain/.test(panel.textContent),
    panel && panel.textContent.slice(0, 80));
  ok('...and it is the domains.projects explainer, whole',
    panel && panel.children.length === 1 && hasClass(panel.children[0], 'xp')
    && panel.children[0].attrs['data-explainer'] === 'domains.projects',
    panel && panel.children.map((n) => n.tagName).join('/'));
  ok('...named by the explainer’s own label',
    btn && btn.attrs['aria-label'] === EXPLAINERS['domains.projects'].label, btn && btn.attrs['aria-label']);

  // ── v3.58.0: THE LOOSE LEDE IS GONE, AND THE ⓘ ANSWERS TWO QUESTIONS ────
  // v3.50.0 cut a four-line paragraph here to one sentence under the eyebrow.
  // The maintainer's verdict on the survivor was that it STILL read as a loose
  // sentence between the heading and the table -- the same complaint one size
  // smaller -- so the sentence went behind the mark that exists to hold it.
  ok('no loose lede renders between the eyebrow and the group',
    !descendants(root).some((n) => hasClass(n, 'dm-proj-caption')),
    'a .dm-proj-caption is still rendered');
  ok('...and the header holds the eyebrow and the mark and nothing else',
    head && head.children.length === 2, head && String(head.children.length));
  ok('...with the eyebrow still naming the group -- the mark is the dive-in, not the label',
    head && /Projects in this domain/.test(head.textContent));
  ok('CONTROL -- domains.css no longer places a caption either',
    !/\.dm-proj-caption/.test(CSS.replace(/\/\*[\s\S]*?\*\//g, '')));
  // NOTHING A READER NEEDED WAS DELETED, only moved: the definition is the
  // FIRST thing inside the fold.
  ok('the definition survives, as the fold’s lead',
    panel && /^\s*Projects\s*A project is one piece of work/.test(panel.textContent), panel && panel.textContent.slice(0, 60));

  // A WORD BUDGET. A fold is not a licence to write an essay; capped at 120.
  const words = panel ? panel.textContent.trim().split(/\s+/).filter(Boolean).length : 0;
  ok('the whole fold is at most 120 words', words > 0 && words <= 120, words + ' words');
  // THE TWO CONTROLS ARE EXPLAINED ON THEIR OWN MARKS (v3.58.0 gave each copy
  // control an ⓘ; v3.71.1 stopped the section fold repeating them).
  const ph = box.renderProjectsPanel(false);
  ok('each row’s Copy marker line carries the domains.marker-line explainer',
    /data-explainer="domains\.marker-line"/.test(ph), ph.slice(0, 200));
  ok('...and Copy agent instructions the domains.agent-instructions one',
    /data-explainer="domains\.agent-instructions"/.test(ph));
}

// ═══════════════════════════════════════════════════════════════════════
section('S3b -- THE ⓘ TEXTS NAME THE SAME FILES THE BLOCK AND THE DOCS DO');
// ═══════════════════════════════════════════════════════════════════════
//
// A DOC-LINKS-STYLE CROSS-CHECK. The ⓘ texts tell a user which file to paste
// into. Those file names are DEFINED in two other places -- the frozen block
// in shared/agent-instructions.js (whose COPY_SUCCESS_BANNER the user reads
// seconds later, as the post-copy confirmation) and docs/working-state.md's
// "Where it goes" table. Three copies of one fact is exactly the shape
// scripts/test-docs-links.js exists for: rename one and the other two become
// false, silently, in copy that tells people where to put something.
//
// EXECUTED, not scanned: the constants are lifted out of the shipped view and
// out of the shipped module, and the docs are read off disk.
// v3.71.1: THE FILE NAMES LEFT THE ⓘ. The two copy controls' marks are the
// `domains.marker-line` / `domains.agent-instructions` explainers, which say
// "the file your agent loads every session" and name no harness file. The
// names now live in exactly two places the user reads — the post-copy banner
// (COPY_SUCCESS_BANNER) and the user guide's "Making sure your agent actually
// does it" table — and docs/working-state.md's "Where it goes". So the
// cross-check is re-pointed at THOSE, both directions, and the marker file
// name is asserted in the marker explainer's steps.
{
  const marker = explainerHtml('domains.marker-line');
  const agent = explainerHtml('domains.agent-instructions');
  const fold = explainerHtml('domains.projects');
  const DOC = readFileSync(join(ROOT, 'docs/working-state.md'), 'utf8');
  const GUIDE = readFileSync(join(ROOT, 'docs/user-guide.md'), 'utf8');
  const at = GUIDE.indexOf('### Making sure your agent actually does it');
  const GUIDE_SEC = at === -1 ? '' : GUIDE.slice(at, GUIDE.indexOf('\n### ', at + 10));

  ok('CONTROL -- the guide section exists and is non-trivial', GUIDE_SEC.length > 500, String(GUIDE_SEC.length));

  // THE MARKER FILE.
  ok('the marker explainer’s steps name the file the marker line goes in',
    (EXPLAINERS['domains.marker-line'].visual.steps || []).some((t) => /`\.curator-project`/.test(t)),
    JSON.stringify(EXPLAINERS['domains.marker-line'].visual));
  ok('...and it renders in the panel', /\.curator-project/.test(marker));
  ok('...and docs/working-state.md defines that same file name',
    /###\s+The `\.curator-project` marker/.test(DOC));
  ok('...and the frozen block itself points an agent at it',
    /`\.curator-project`/.test(TEMPLATE), TEMPLATE.slice(0, 60));

  // THE ENTRY FILES: every name the banner quotes is in the guide table and in
  // docs/working-state.md, and the guide names no .md the banner forgot.
  const NAMES = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'];
  for (const f of NAMES) {
    ok('COPY_SUCCESS_BANNER, which the user reads seconds after copying, names ' + f, COPY_SUCCESS_BANNER.includes(f));
    ok('...and the guide’s "Making sure your agent actually does it" table', GUIDE_SEC.includes('`' + f + '`'));
    ok('...and docs/working-state.md’s "Where it goes" table', DOC.includes('`' + f + '`'));
  }
  ok('Cursor is named in the banner, the guide section and the docs',
    /Cursor/.test(COPY_SUCCESS_BANNER) && /Cursor/.test(GUIDE_SEC) && /Cursor/.test(DOC));
  const inBanner = (COPY_SUCCESS_BANNER.match(/[A-Z]+\.md/g) || []);
  ok('CONTROL -- the banner really does name .md files, so the sweep is not vacuous',
    inBanner.length === 3, inBanner.join(', '));
  ok('every entry file the post-copy banner names is in the guide section too',
    inBanner.every((f) => GUIDE_SEC.includes(f)), inBanner.join(', '));
  // AND THE ⓘ DOES NOT DRIFT BACK INTO A THIRD, HAND-KEPT COPY OF THE LIST.
  for (const f of NAMES) {
    ok('the agent-instructions explainer does not re-list ' + f, !agent.includes(f));
  }
  ok('...it points at "the file your agent loads every session" instead',
    /the file your agent loads every session/.test(agent), agent.slice(0, 400));
  ok('...and its guide card opens that very guide section',
    /#making-sure-your-agent-actually-does-it"/.test(agent), (agent.match(/href="[^"]*"/) || [''])[0]);

  // WHAT HAPPENS THEN — the part a reader cannot guess.
  ok('the marker ⓘ says what an agent does with it', /resumes/i.test(marker), marker.slice(0, 200));
  ok('the agent-instructions ⓘ says what the agent then does',
    /reads/i.test(agent) && /saves/i.test(agent), agent.slice(0, 200));

  // NO ⓘ CARRIES A WARNING, A COST OR A REFUSAL (v3.16.1).
  for (const [name, t] of [['marker', marker], ['agent', agent], ['fold', fold]]) {
    const words = t.replace(/<[^>]*>/g, ' ');
    ok('the ' + name + ' ⓘ carries neutral explanation only -- no cost, no warning',
      !/\$|cost|spend|warning|cannot be undone|permanent/i.test(words), words.slice(0, 80));
  }
}
{
  // THE GLYPH IS THE SHARED ONE, byte for byte (v3.71.1: via the kit).
  const shared = /const INFO_GLYPH =\n([\s\S]*?);\n/.exec(TEXT_JS);
  ok('CONTROL -- shared/text.js declares INFO_GLYPH', !!shared);
  // eslint-disable-next-line no-new-func
  const sharedSvg = shared ? new Function('return ' + shared[1].trim())() : null;
  const mark = explainerMark('x', 'domains.projects');
  ok('this view’s ⓘ glyph is byte-identical to shared/text.js’s',
    !!sharedSvg && mark.btn.includes(sharedSvg), mark.btn);
  ok('...and the view keeps no ⓘ implementation of its own', !/function infoMark\b/.test(SRC));
  // A MISTYPED KEY IS A THROW, never a silently empty ⓘ.
  let threw = false;
  try { explainerMark('x', 'domains.no-such-key'); } catch { threw = true; }
  ok('an unknown explainer key throws rather than rendering an empty fold', threw);
}

// ═════════════════════════════════════════════════════════════════════════
section('S4 -- THE DEAD END IS GONE: 400 -> 150 -> 300 -> 400');
// ═════════════════════════════════════════════════════════════════════════
const many = [];
for (let i = 0; i < 400; i++) many.push(ENTRY({ slug: 'p' + String(i).padStart(3, '0'), path: 'entities/p' + i + '.md', title: 'P' + i }));

/** Mounts a rendered panel into the model and wires the view's own listeners. */
function mountPanel(html) {
  const root = parseNodes(html);
  // Both re-walk on EVERY call: showMoreBrowseRows adds nodes after the
  // mount, and a snapshot taken here would not contain them.
  const doc = {
    getElementById: (id) => descendants(root).find((n) => n.attrs.id === id) || null,
    querySelectorAll: (sel) => descendants(root).filter((n) => matchSel(n, sel)),
    // v3.58.0: selectBrowseFacet re-queries the pressed control after the
    // repaint to hand focus back to it, and scrollSectionIntoView asks for the
    // section. The model has no layout, so the node it returns simply carries
    // no scrollIntoView -- which the view treats as "cannot scroll" and skips.
    querySelector: (sel) => descendants(root).find((n) => matchSel(n, sel)) || null,
  };
  box.__setDocument(doc);
  return { root, doc, list: () => doc.getElementById('dm-browse-list') };
}
function rowsIn(m) { return m.list().children.filter((n) => hasClass(n, 'dm-browse-row')).length; }

{
  box.__setState(mainState({ browse: browseState({ entries: many }) }));
  const m = mountPanel(box.renderBrowsePanel());
  eq('a 400-page domain paints 150 rows', rowsIn(m), 150);
  ok('...and says "Showing 150 of 400"',
    /Showing 150 of 400/.test(m.doc.getElementById('dm-browse-note').textContent));
  const more = m.doc.getElementById('dm-browse-more');
  ok('...with a "Show 150 more" footer row under them', !!more && /Show 150 more/.test(more.textContent));
  ok('...which is the kit’s row shape, not a floating button',
    more && more.classList.includes('cur-group-row'), more && more.classList.join(' '));
  // ── AND IT IS OUTSIDE THE SCROLL CONTAINER, WHICH IS THE POINT ─────────
  // v3.48.1 put "+ New project" INSIDE its group as the last row, and the
  // first draft of this copied that. Rendering it showed the two cases are not
  // the same: `.dm-browse-list` is capped at 420px with `overflow-y: auto`, so
  // an in-list footer sits ~130 rows below the fold, under a note reading
  // "Showing 150 of 400" that offers no visible way past it — the reported
  // defect wearing a control. The CSS cap is read here rather than assumed,
  // so this assertion stops being about placement the day the cap is removed.
  ok('CONTROL -- the list really is a fixed-height scroll container',
    /\.dm-browse-list\s*\{[^}]*max-height:\s*\d+px[^}]*overflow-y:\s*auto/.test(CSS));
  ok('...so the footer is BELOW the list, always visible, not its last row',
    more && more.parentNode !== m.list(), 'the more row is inside the scrolling list');
  ok('...with the count between the two, so it reads as the sentence the button answers',
    m.doc.getElementById('dm-browse-note').parentNode === more.parentNode);
  ok('...and the old dead-end wording is gone', !/narrow the filter/.test(box.renderBrowsePanel()));

  // THE FIRST STEP. Driven through the REAL showMoreBrowseRows.
  callOrFail('showMoreBrowseRows runs', () => box.showMoreBrowseRows());
  eq('one press paints 300', rowsIn(m), 300);
  eq('...and the window state agrees with the DOM', box.__state().browse.window, 300);
  ok('...the note follows', /Showing 300 of 400/.test(m.doc.getElementById('dm-browse-note').textContent));
  const more2 = m.doc.getElementById('dm-browse-more');
  ok('...the row is still there and still outside the list', more2 && more2.parentNode !== m.list());
  ok('...and the 150 new rows landed at the END of the list, in order',
    m.list().children[299] && m.list().children[299].dataset.browsePath === many[299].path,
    m.list().children[299] && m.list().children[299].dataset.browsePath);
  ok('...and it now offers the REMAINDER, not another blind 150',
    more2 && /Show 100 more/.test(more2.textContent), more2 && more2.textContent);

  // THE LAST STEP.
  box.showMoreBrowseRows();
  eq('a second press paints all 400', rowsIn(m), 400);
  eq('...and the window agrees', box.__state().browse.window, 400);
  ok('the footer row is GONE once everything matching is on screen', !m.doc.getElementById('dm-browse-more'));
  ok('...and so is the count, because a list that fits says nothing about its length',
    !m.doc.getElementById('dm-browse-note'));
  // IDEMPOTENT: a press that cannot happen must not corrupt the window.
  callOrFail('a further call with no button is a no-op', () => box.showMoreBrowseRows());
  eq('...and the window did not move', box.__state().browse.window, 400);
}
await (async () => {
  // EVERY APPENDED ROW IS CLICKABLE, and bound EXACTLY ONCE. A second listener
  // on one row opens the reader twice, which is why bindBrowseRowClicks takes
  // a root instead of re-scanning the document.
  box.__setState(mainState({ browse: browseState({ entries: many }) }));
  const m = mountPanel(box.renderBrowsePanel());
  box.bindBrowseRowClicks(m.doc);
  box.showMoreBrowseRows();
  const rows = m.list().children.filter((n) => hasClass(n, 'dm-browse-row'));
  eq('CONTROL -- 300 rows are on screen', rows.length, 300);
  eq('a row from the FIRST window carries one click listener', rows[0].listeners.length, 1);
  eq('...and so does one from the appended window', rows[200].listeners.length, 1);
  box.__reset();
  rows[200].click();
  await new Promise((r) => setImmediate(r));
  eq('...and clicking an appended row opens exactly one page', box.__calls().reader.length, 1);
  eq('...the right one', box.__calls().reader[0] && box.__calls().reader[0].wiki, many[200].path);
  eq('...with nothing routed to the async-failure reporter', box.__calls().asyncFailures, 0);
})();
{
  // ── THE WINDOW RESETS WITH THE MATCH SET ──────────────────────────────
  // Driven through the REAL bindBrowseListeners and a real `input` event, not
  // asserted as a line of source: `b.window` counts rows of a SPECIFIC match
  // set, and carrying 600 across into a query that matches 12 would make
  // "Showing 600 of 12" expressible. A source regex over the handler would
  // pass on a reset written after the render call, which is too late.
  const st = mainState({ browse: browseState({ entries: many, window: 400 }) });
  box.__setState(st);
  const m = mountPanel(box.renderBrowsePanel());
  box.bindBrowseListeners();
  eq('CONTROL -- the window really is wide open before the keystroke', box.__state().browse.window, 400);

  const filterEl = m.doc.getElementById('dm-browse-filter');
  ok('CONTROL -- the filter field is mounted and listening', !!filterEl && filterEl.listeners.length > 0);
  filterEl.value = 'p1';
  filterEl.dispatch('input');
  eq('typing in the filter takes the window back to one step', box.__state().browse.window, box.BROWSE_RENDER_CAP);
  eq('...and the filter itself is recorded', box.__state().browse.filter, 'p1');
  ok('...and the view re-rendered rather than mutating the list in place', box.__calls().render > 0);

  // THE SAME FOR A FACET.
  box.__state().browse.window = 400;
  const memTab = m.doc.querySelectorAll('.dm-browse-tab[data-browse-folder]')
    .find((t) => t.attrs['data-browse-folder'] === 'summaries');
  ok('CONTROL -- a facet button is mounted and listening', !!memTab && memTab.listeners.length > 0);
  memTab.dispatch('click');
  eq('changing facet takes the window back too', box.__state().browse.window, box.BROWSE_RENDER_CAP);
  eq('...and the facet is recorded', box.__state().browse.folder, 'summaries');

  // AND A STALE OVERSIZED WINDOW STILL CANNOT OVER-PAINT OR OVER-COUNT.
  st.browse.filter = 'p1';
  st.browse.folder = 'all';
  st.browse.window = 400;
  const filtered = box.browseMatches(st.browse).items.length;
  const m2 = mountPanel(box.renderBrowsePanel());
  eq('a stale oversized window paints only what matches', rowsIn(m2), filtered);
  ok('...and prints no count at all, because everything matching is shown',
    !m2.doc.getElementById('dm-browse-note'));
}

// ═════════════════════════════════════════════════════════════════════════
section('S5 -- MEMORY PAGES ARE BROWSABLE FROM THE WIKI LIST');
// ═════════════════════════════════════════════════════════════════════════
{
  const memory = [MEM_BRIEF, MEM_HANDOFF];
  box.__setState(mainState({ browse: browseState({ memory }) }));
  const html = box.renderBrowsePanel();
  const root = parseNodes(html);
  const tabs = descendants(root).filter((n) => hasClass(n, 'dm-browse-tab'));
  eq('there are five facets now', tabs.length, 5);
  const memTab = tabs.find((t) => t.attrs['data-browse-folder'] === 'memory');
  ok('...one of them is Memory', !!memTab);
  eq('...counting the memory pages, not the wiki ones', memTab.textContent.replace(/\s+/g, ' ').trim(), 'Memory 2');
  const allTab = tabs.find((t) => t.attrs['data-browse-folder'] === 'all');
  eq('and "All" still counts WIKI pages only, so it cannot contradict the stat card above it',
    allTab.textContent.replace(/\s+/g, ' ').trim(), 'All 2');
}
{
  const memory = [MEM_BRIEF, MEM_HANDOFF];
  box.__setState(mainState({ browse: browseState({ memory, folder: 'memory' }) }));
  const m = mountPanel(box.renderBrowsePanel());
  const rows = m.list().children.filter((n) => hasClass(n, 'dm-browse-row'));
  eq('the Memory facet lists both memory pages', rows.length, 2);
  const titles = rows.map((r) => descendants(r).find((n) => hasClass(n, 'dm-browse-title')).textContent);
  eq('the brief’s title names the project and what it is', titles[0], 'lumina · Standing brief');
  eq('the handoff’s title names project, work-stream and machine', titles[1], 'lumina · design · mac-ab12');
  const paths = rows.map((r) => descendants(r).find((n) => hasClass(n, 'dm-browse-path')).textContent);
  eq('...and the brief’s path is the one on disk', paths[0], 'state/lumina/project.md');
  eq('...and the handoff’s too', paths[1], 'state/lumina/design/mac-ab12/current.md');
  const dots = rows.map((r) => descendants(r).find((n) => hasClass(n, 'dm-browse-dot')).classList.join(' '));
  ok('both carry the memory dot, not a wiki type dot',
    dots.every((d) => d.includes('dm-browse-dot-memory')), JSON.stringify(dots));
  ok('...and the stylesheet paints it from an EXISTING token, not a new hex literal',
    /\.dm-browse-dot-memory\s*\{\s*background:\s*var\(--accent\);?\s*\}/.test(CSS));
  // The filter reaches everything the row shows.
  box.__setState(mainState({ browse: browseState({ memory, folder: 'memory', filter: 'mac-ab12' }) }));
  eq('the filter matches a machine name', box.browseMatches(box.__state().browse).items.length, 1);
  box.__setState(mainState({ browse: browseState({ memory, folder: 'memory', filter: 'STANDING' }) }));
  eq('...case-insensitively', box.browseMatches(box.__state().browse).items.length, 1);
  box.__setState(mainState({ browse: browseState({ memory, folder: 'memory', filter: 'zzz' }) }));
  eq('...and a miss is a miss (negative control)', box.browseMatches(box.__state().browse).items.length, 0);
}
await (async () => {
  // ── WHERE A CLICK LANDS ───────────────────────────────────────────────
  // GET /api/wiki/:domain/page CANNOT open one of these: it resolves inside
  // wiki/ and state/ is wiki/'s sibling (asserted against the REAL route in
  // scripts/test-wiki-list-memory.js). So the click goes to the route that
  // owns memory, and the reader is filled from its answer.
  const memory = [MEM_HANDOFF, MEM_BRIEF];
  box.__setState(mainState({ browse: browseState({ memory, folder: 'memory' }) }));
  const m = mountPanel(box.renderBrowsePanel());
  box.bindBrowseRowClicks(m.doc);
  const asked = [];
  box.__setFetch(async (url) => {
    asked.push(url);
    return url.includes('scope=')
      ? { ok: true, readonly: false, current: { present: true, text: '# Handoff', truncated: false, sanitisedOnRead: false } }
      : { ok: true, readonly: false, brief: { present: true, text: '# Brief', truncated: false } };
  });

  const rows = m.list().children.filter((n) => hasClass(n, 'dm-browse-row'));
  const byTitle = (t) => rows.find((r) => r.dataset.memTitle === t);

  // THE HANDOFF.
  box.__reset();
  asked.length = 0;
  byTitle(MEM_HANDOFF.title).click();
  await new Promise((r) => setImmediate(r));
  eq('a handoff row asks exactly one endpoint', asked.length, 1);
  eq('...the memory route, addressed by project, work-stream and machine', asked[0],
    '/api/memory/alpha/lumina?scope=design&machine=mac-ab12');
  const opened = box.__calls().reader;
  ok('the reader opens twice: a loader, then the page', opened.length === 2, String(opened.length));
  const page = opened[1];
  eq('...titled as the row was', page && page.title, MEM_HANDOFF.title);
  eq('...at the path the row showed', page && page.slug, MEM_HANDOFF.path);
  ok('...with the body rendered through the SHARED markdown renderer, never innerHTML',
    page && /^<p class="md">/.test(page.bodyHtml), page && page.bodyHtml);
  // NO `domain`, DELIBERATELY: that field is the one thing that switches on
  // the reader's RAW-source bar, and a memory page has no ingested source.
  ok('...and no `domain`, so the reader asks nothing about a raw source',
    page && page.domain === undefined, page && String(page.domain));
  ok('the work-stream and the machine ride along as chips',
    page && page.tags.includes('scope: design') && page.tags.includes('machine: mac-ab12'),
    page && JSON.stringify(page.tags));

  // THE BRIEF — no scope, no machine, a different half of the response.
  box.__reset();
  asked.length = 0;
  byTitle(MEM_BRIEF.title).click();
  await new Promise((r) => setImmediate(r));
  eq('a brief row asks the project with NO scope', asked[0], '/api/memory/alpha/lumina');
  eq('...and reads the brief half of the answer', box.__calls().reader[1].bodyHtml, '<p class="md"># Brief</p>');
  // v3.71.1: one noun, "the brief" — the reader's type chip follows the rename.
  eq('...labelled as what it is', box.__calls().reader[1].typeLabel, 'brief');

  // A FILE THAT WENT AWAY BETWEEN THE LIST AND THE CLICK IS SAID, not
  // rendered as an empty page. The listing is a snapshot; an agent writes.
  box.__setFetch(async () => ({ ok: true, readonly: false, brief: { present: false } }));
  box.__reset();
  byTitle(MEM_BRIEF.title).click();
  await new Promise((r) => setImmediate(r));
  ok('an absent file says so rather than opening blank',
    /not there any more/.test(box.__calls().reader[1].bodyHtml), box.__calls().reader[1].bodyHtml);

  // AND A FAILURE IS A READER ERROR, not a silent nothing.
  box.__setFetch(async () => { throw new Error('memory route said no'); });
  box.__reset();
  byTitle(MEM_BRIEF.title).click();
  await new Promise((r) => setImmediate(r));
  eq('a failed read renders the error in the reader', box.__calls().reader[1].error, 'memory route said no');
})();

// ═════════════════════════════════════════════════════════════════════════
section('S6 -- DEGRADATION: AN OLDER SERVER, AND AN EMPTY STATE TREE');
// ═════════════════════════════════════════════════════════════════════════
{
  // A browser tab can run this shell against a server that predates
  // ?include=memory. The honest degradation is an empty facet, never a throw.
  box.__setState(mainState({ browse: browseState({ memory: undefined }) }));
  const html = callOrFail('a response with no `memory` key still renders', () => box.renderBrowsePanel());
  if (html) {
    const memTab = parseNodes(html) && descendants(parseNodes(html))
      .find((n) => n.attrs['data-browse-folder'] === 'memory');
    eq('...with the facet reading zero', memTab.textContent.replace(/\s+/g, ' ').trim(), 'Memory 0');
  }
  box.__setState(mainState({ browse: browseState({ memory: [], folder: 'memory' }) }));
  const empty = box.renderBrowsePanel();
  ok('an empty Memory facet says what is empty, in its own words',
    /No memory pages match that filter/.test(empty), empty.slice(0, 200));
  box.__setState(mainState({ browse: browseState({ entries: [], folder: 'all' }) }));
  ok('...and the wiki facet keeps its own', /No pages match that filter/.test(box.renderBrowsePanel()));
  // AND loadBrowse ASKS FOR THEM. The facet count has to be right on the very
  // first paint, so the flag rides on the same round trip.
  const load = extractFunction(SRC, 'loadBrowse');
  ok('loadBrowse requests the memory pages in the SAME call as the wiki list',
    /\/list\?include=memory/.test(load));
  ok('...and treats a missing array as empty rather than trusting the shape',
    /Array\.isArray\(data\.memory\) \? data\.memory : \[\]/.test(load));
}

console.log('\n============================================================');
console.log('Passed: ' + passed + '   Failed: ' + failed);
if (failed) { console.log('Domains-view pages/memory assertions FAILED'); process.exit(1); }
console.log('Domains-view pages, overview, sections and memory assertions green');
