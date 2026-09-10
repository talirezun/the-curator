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
let documentImpl = { getElementById: () => null, querySelectorAll: () => [] };
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
const MIRROR_INFO = 'mirror-info';
const DOMAIN_BLURB = 'domain-blurb';
const MIRROR_WARNING = 'mirror-warning';
const document = { get getElementById() { return documentImpl.getElementById; },
                   get querySelectorAll() { return documentImpl.querySelectorAll; } };
`;

const FNS = [
  'activeBrowse', 'activeProjects', 'projectCount', 'infoMark',
  'filterBrowseEntries', 'filterMemoryEntries', 'browseMatches', 'browseWindow',
  'browseRowHtml', 'memoryRowHtml', 'browseMoreHtml', 'browseNoteHtml',
  'renderBrowsePanel', 'renderStatCards', 'renderProjectRow', 'renderProjectsPanel',
  'showMoreBrowseRows', 'bindBrowseRowClicks', 'bindBrowseListeners', 'openMemoryPageFromBrowse',
  'healthSection', 'renderMain',
];

let box;
try {
  box = new Function(
    PREAMBLE +
    extractConstText(SRC, 'BROWSE_EYEBROW') + '\n' +
    extractConstText(SRC, 'BROWSE_RENDER_CAP') + '\n' +
    extractConstArray(SRC, 'BROWSE_FOLDERS') + '\n' +
    FNS.map((n) => extractFunction(SRC, n)).join('\n\n') + '\n' +
    `return { ${FNS.join(', ')}, BROWSE_RENDER_CAP, BROWSE_FOLDERS,
       __state: () => state, __setState: (s) => { state = s; },
       __calls: () => calls, __reset: () => { calls.setMain.length = 0; calls.render = 0;
         calls.reader.length = 0; calls.asyncFailures = 0; },
       __setDocument: (d) => { documentImpl = d; },
       __setFetch: (fn) => { fetchResponder = fn; } };`
  )();
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
    const keys = sections.map((s) => s.classList.filter((c) => c !== 'dm-section').join(''));
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
  ok('...with its own eyebrow, reading WIKI HEALTH',
    /class="cur-group-title dm-section-eyebrow">WIKI HEALTH</.test(wrapped));
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
  const grid = /\.dm-stats-grid\s*\{([^}]*)\}/.exec(bare);
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
  eq('five figures, not four', cards.length, 5);
  eq('...and the fifth is PROJECTS', cards[4] && cards[4].children[0].textContent, 'PROJECTS');
  ok('the section is labelled OVERVIEW',
    /class="cur-group-title dm-section-eyebrow">OVERVIEW</.test(html));
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

  // THE FOLD CARRIES THE PARAGRAPH, and this is the assertion a stubbed
  // infoMark would have passed while rendering nothing.
  ok('the fold contains the explanation that used to be on screen',
    panel && /agents keep their working notes against/.test(panel.textContent), panel && panel.textContent.slice(0, 80));
  ok('...and it is long enough to be the paragraph rather than a label',
    panel && panel.textContent.length > 200, panel && String(panel.textContent.length));

  // THE VISIBLE CAPTION IS ONE LINE.
  const caption = descendants(root).find((n) => hasClass(n, 'dm-proj-caption'));
  ok('CONTROL -- the caption is still there', !!caption);
  const text = caption ? caption.textContent.trim() : '';
  ok('the visible caption is ONE sentence', (text.match(/[.!?](\s|$)/g) || []).length === 1, text);
  ok('...and short', text.length < 110, text.length + ' chars: ' + text);
  ok('...and still the shared DESCRIPTION role, not a re-dressed copy',
    caption && caption.children.some((c) => hasClass(c, 'tx-desc')));
  // ANTI-VACUITY: the paragraph is NOT still rendered visibly as well.
  const visible = html.slice(0, html.indexOf('tx-vh-panel')) + html.slice(html.indexOf('</div>', html.indexOf('tx-vh-panel')));
  ok('...and the long version is not ALSO on screen beside the fold',
    !/agents keep their working notes against/.test(caption ? caption.textContent : ''));
}
{
  // THE GLYPH IS THE SHARED ONE, byte for byte. Two copies of a mark that
  // drift are how one section stops looking like the header it is imitating.
  const shared = /const INFO_GLYPH =\n([\s\S]*?);\n/.exec(TEXT_JS);
  ok('CONTROL -- shared/text.js declares INFO_GLYPH', !!shared);
  // eslint-disable-next-line no-new-func
  const sharedSvg = shared ? new Function('return ' + shared[1].trim())() : null;
  const mark = box.infoMark('x', 'About x', 'body');
  ok('this view’s ⓘ glyph is byte-identical to shared/text.js’s',
    !!sharedSvg && mark.btn.includes(sharedSvg), mark.btn);
  // AND THE HELPER REFUSES AN EMPTY FOLD: a mark with nothing behind it is a
  // control whose only outcome is an empty panel.
  eq('an empty body yields no button', box.infoMark('x', 'l', '   ').btn, '');
  eq('...and no panel', box.infoMark('x', 'l', '').panel, '');
  eq('...and so does a missing id', box.infoMark('', 'l', 'text').btn, '');
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
  eq('...labelled as what it is', box.__calls().reader[1].typeLabel, 'standing brief');

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
