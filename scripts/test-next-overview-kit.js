#!/usr/bin/env node
/**
 * ════════════════════════════════════════════════════════════════════════════
 *  test-next-overview-kit.js — ONE overview card, rendered by TWO views.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * OFFLINE. No network, no API key, no LLM, no filesystem outside this repo.
 *
 * ── WHAT THIS SUITE EXISTS TO STOP ─────────────────────────────────────────
 *
 * The maintainer's brief was one question about two screenshots: the domain
 * page drew its readings as a grid of stat cards under an `OVERVIEW` eyebrow
 * with an ⓘ; the Project-context page drew the same idea as a three-cell mono
 * strip with a lone ⓘ pushed to the right. *"How are these the same?"* They
 * are one component now. Six ways that could quietly stop being true:
 *
 *   1. ONE OF THE TWO VIEWS GROWING ITS OWN MARKUP AGAIN. §1 renders BOTH
 *      views' real inputs through the shipped function and requires the
 *      element shape — head, eyebrow, ⓘ, `.cur-group`, grid, card, value — to
 *      be the SAME on both. The two adopters may differ in exactly two ways
 *      (the Domains alias tokens, and the optional second line), and §1c
 *      enumerates that difference rather than allowing any difference.
 *   2. THE ALIAS LEAKING. The `dm-` tokens exist so four shipped suites, this
 *      view's own listeners and its column-patch walk keep addressing the
 *      same elements. They are the DOMAINS page's, and §2 fails if one
 *      reaches the Context view's output — that is how a "shared" component
 *      becomes one view's component with a second caller.
 *   3. A FILTER HIGHLIGHT APPEARING WHERE THERE IS NO FILTER. `aria-pressed`
 *      on the Context cards would tell a screen-reader user that a reading is
 *      a toggle they have not pressed. §3 requires the selected state on the
 *      Domains facet cards and NOWHERE else, and requires the ⓘ to say in
 *      words that these are readings rather than a filter.
 *   4. A CALLER-SUPPLIED STRING REACHING THE PAGE UNESCAPED. Every label,
 *      value, sub-line, accessible name, facet key and jump key comes from
 *      the store or from a user-named domain. §4 drives the XSS corpus
 *      through all of them. `markHtml` and `infoText`+`infoHtml` are the two
 *      NAMED trusted fields and the suite pins that they are the only two —
 *      including `toneClass`, which is a class NAME and is filtered to the
 *      class alphabet rather than escaped.
 *   5. A READING PRINTED AS A PERCENTAGE OR A RATIO. Both screens answer
 *      "where does this stand", and a `4/6` or an `83%` on either one implies
 *      a target neither app surface claims. §5 fails on one in either view's
 *      real output.
 *   6. THE CARD LOSING ITS STYLESHEET. Every class the component emits must
 *      resolve a rule, the press must keep its reduced-motion escape, and the
 *      `[hidden]` counter-rule must survive — `[hidden]` loses to an author
 *      `display:` at any specificity, which is how v3.62.0 shipped a warning
 *      chip that painted anyway. §6 reads shared/overview.css for all three.
 *
 * ── EXECUTED, NOT SCANNED ──────────────────────────────────────────────────
 * §1–§5 run the REAL `renderOverview`, and the two views' REAL card builders
 * (`renderStatCards` from views/domains.js, `renderLayerStrip` from
 * views/memory.js) lifted by brace-matching and executed with `new Function`
 * — the technique the sibling view suites use. A source regex proving a line
 * exists proves nothing about what it does.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────
 *  · Either view's own behaviour around the card — the facet write path, the
 *    fold that a jump opens, the column patch. scripts/test-next-domain-
 *    sections.js, -pages.js and test-next-memory-view.js own those, and each
 *    now runs the REAL component rather than a stub.
 *  · Rendering, layout and contrast. Nothing in Node measures a pixel; the
 *    browser pass (both themes, 1370 and 568, zero console errors) is
 *    recorded in the release row, not here.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renderOverview } from '../src/public/next/shared/overview.js';
import { docsLinkHtml } from '../src/public/next/shared/docs-links.js';
import { freshnessTier } from '../src/public/next/shared/age.js';
// The REAL budget, from the module that owns it — a literal typed here
// would be this suite asserting against its own copy.
import { FOUNDATIONS_BUDGET_BYTES } from '../src/public/next/shared/foundations-init.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const NEXT = path.join(ROOT, 'src/public/next');
const KIT_JS = readFileSync(path.join(NEXT, 'shared/overview.js'), 'utf8');
const KIT_CSS = readFileSync(path.join(NEXT, 'shared/overview.css'), 'utf8');
const BLOCK_JS = readFileSync(path.join(NEXT, 'shared/block.js'), 'utf8');
const DOMAINS_JS = readFileSync(path.join(NEXT, 'views/domains.js'), 'utf8');
const MEMORY_JS = readFileSync(path.join(NEXT, 'views/memory.js'), 'utf8');
const INDEX_HTML = readFileSync(path.join(NEXT, 'index.html'), 'utf8');

let passed = 0;
let failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + msg); return true; }
  failed++;
  console.log('  \x1b[31m✗\x1b[0m ' + msg + (detail === undefined ? '' : ' — ' + String(detail).slice(0, 400)));
  return false;
}
function eq(msg, got, want) {
  return ok(got === want, msg, 'got ' + JSON.stringify(got) + ', wanted ' + JSON.stringify(want));
}
function section(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }

/** Brace-match a top-level `function name(` out of a module's source. */
function extractFunction(src, name, file) {
  const at = src.indexOf('function ' + name + '(');
  if (at === -1) throw new Error('no function ' + name + ' in ' + file);
  let i = src.indexOf('{', at);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  throw new Error('unbalanced ' + name + ' in ' + file);
}

const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// ── A MINIMAL DOM READER ───────────────────────────────────────────────────
// Enough to ask "which elements, with which classes, in which order" without
// a dependency. Attributes are read off the raw tag text, so nothing is
// normalised away — an unescaped quote stays visible.
function tags(html) {
  const out = [];
  const re = /<(\w+)\b([^>]*)>/g;
  let m;
  while ((m = re.exec(html))) {
    const attrs = {};
    const are = /([\w:-]+)(?:="([^"]*)")?/g;
    let a;
    while ((a = are.exec(m[2]))) attrs[a[1]] = a[2] === undefined ? '' : a[2];
    out.push({ tag: m[1].toUpperCase(), attrs, classes: (attrs.class || '').split(/\s+/).filter(Boolean) });
  }
  return out;
}
const withClass = (html, c) => tags(html).filter((t) => t.classes.includes(c));
const shape = (html) => tags(html)
  .filter((t) => t.classes.some((c) => c.startsWith('cur-')))
  .map((t) => t.tag + '.' + t.classes.filter((c) => c.startsWith('cur-')).join('.'))
  .join(' > ');

// ═════════════════════════════════════════════════════════════════════════
// THE TWO VIEWS' REAL CARD BUILDERS
// ═════════════════════════════════════════════════════════════════════════
//
// Lifted and executed rather than re-described. The point of this file is
// that two screens go through one component; a fixture typed here would prove
// that a fixture does.

function domainsOverview(over) {
  const state = {
    activeSlug: 'alpha',
    browse: { slug: 'alpha', loading: false, error: null, folder: 'entities' },
    projects: { slug: 'alpha', loading: false, error: null, total: 2, rows: [{}, {}] },
    ...(over || {}),
  };
  const box = new Function('docsLinkHtml', 'renderOverview', 'escapeHtml', 'state',
    'function relTime() { return "3 days ago"; }\n'
    + extractFunction(DOMAINS_JS, 'activeBrowse', 'domains.js') + '\n'
    + extractFunction(DOMAINS_JS, 'activeProjects', 'domains.js') + '\n'
    + extractFunction(DOMAINS_JS, 'projectCount', 'domains.js') + '\n'
    + extractFunction(DOMAINS_JS, 'threeLayersInfoHtml', 'domains.js') + '\n'
    + extractFunction(DOMAINS_JS, 'renderStatCards', 'domains.js') + '\n'
    + 'return renderStatCards;')(docsLinkHtml, renderOverview, escapeHtml, state);
  return box({ entities: 3416, concepts: 2717, summaries: 141, other: 0 }, 6274, projectCount(state), {
    sources: true,
    lastIngest: '2026-09-17',
    // `__jumps` asks for the state BEFORE the Shared Brain panel has reported:
    // the tile exists and is hidden.
    shared: (over && over.__jumps) ? { show: false, value: null } : { show: true, value: '2 cohorts' },
  });
  function projectCount(s) { return s.projects && s.projects.total; }
}

function contextOverview(over) {
  const state = {
    activeDomain: 'acme',
    activeProject: 'lumina',
    projects: [],
    knowledge: { domain: 'acme', error: null, data: { pageCount: 767, lastIngestDate: '2026-09-13' } },
    capture: { domain: 'acme', project: 'lumina', error: null,
      data: { logPresent: true, totals: { sessions: 1 }, sessions: [] } },
    ...(over || {}),
  };
  const read = {
    scopes: [{ scope: 'session-2026-09-20-overview', machine: 'boxa', writtenAgeSeconds: 720 }],
    savedCopies: 1,
    distinctScopeCount: 1,
    foundations: { present: true, documents: [
      { slug: 'architecture.md', freshness: 'fresh' }, { slug: 'decisions.md', freshness: 'stale' },
    ] },
    ...(over && over.__read ? over.__read : {}),
  };
  // `freshnessTier` is shared/age.js's, imported by the view — injected REAL
  // here, because the tier a reading paints is the reading.
  const fns = ['skeletonOf', 'foundationsFacts', 'foundationsWord', 'newestPair',
    'effectiveSave', 'formatAge', 'renderLayerStrip'];
  const box = new Function('docsLinkHtml', 'renderOverview', 'escapeHtml', 'state',
    'formatDayAge', 'freshnessDotHtml', 'freshnessTier',
    'const READ_FIRST_BUDGET_BYTES = 120 * 1024;\n'
    + 'const FOUNDATIONS_BUDGET_BYTES = ' + FOUNDATIONS_BUDGET_BYTES + ';\n'
    + fns.map((n) => extractFunction(MEMORY_JS, n, 'memory.js')).join('\n')
    + '\nreturn renderLayerStrip;')(
    docsLinkHtml, renderOverview, escapeHtml, state,
    () => '1 week ago',
    () => '<span class="fresh-dot fresh-week" aria-hidden="true"></span>',
    freshnessTier);
  return box(read);
}

// ═════════════════════════════════════════════════════════════════════════
section('§1 — ONE SHAPE. Both views render the SAME elements.');
// ═════════════════════════════════════════════════════════════════════════
const DOM = domainsOverview();
const CTX = contextOverview();
{
  ok(DOM.length > 200 && CTX.length > 200, 'CONTROL — both views produced a card',
    DOM.length + '/' + CTX.length);

  // THE SHAPE, elementwise, taken over the kit's own classes only — so the
  // Domains aliases and the host section classes cannot make two identical
  // structures look different.
  const shapeOf = (html) => tags(html)
    .filter((t) => t.classes.some((c) => c === 'cur-ov' || c.startsWith('cur-ov-')))
    .map((t) => t.tag + '.' + t.classes.filter((c) => c === 'cur-ov' || c.startsWith('cur-ov-'))[0]);
  const d = shapeOf(DOM);
  const c = shapeOf(CTX);
  eq('the wrapper is a <section class="cur-ov"> on both', d[0] + '|' + c[0],
    'SECTION.cur-ov|SECTION.cur-ov');
  eq('...then the head, the eyebrow, the group and the grid, in that order — on Domains',
    d.slice(1, 5).join(' > '),
    'DIV.cur-ov-head > DIV.cur-ov-eyebrow > DIV.cur-ov-group > DIV.cur-ov-grid');
  eq('...and on Context, the same four',
    c.slice(1, 5).join(' > '),
    'DIV.cur-ov-head > DIV.cur-ov-eyebrow > DIV.cur-ov-group > DIV.cur-ov-grid');

  eq('the grid holds five figures on a domain', withClass(DOM, 'cur-ov-card').length, 5);
  eq('...and three on a project', withClass(CTX, 'cur-ov-card').length, 3);
  eq('every figure on both carries a `.cur-ov-value`',
    withClass(DOM, 'cur-ov-value').length + '/' + withClass(CTX, 'cur-ov-value').length, '5/3');
  ok(/class="cur-eyebrow">PAGES</.test(DOM) && /class="cur-eyebrow">FOUNDATIONS</.test(CTX),
    'and every figure is captioned by the SAME `.cur-eyebrow` the kit uses everywhere');

  // THE EYEBROW AND ITS ⓘ — one pattern, one word, one component.
  for (const [name, html, id, label] of [
    ['Domains', DOM, 'dm-overview-info', 'About these figures'],
    ['Context', CTX, 'mem-layers-info', 'About the readings on this page'],
  ]) {
    ok(new RegExp('class="cur-ov-eyebrow[^"]*">OVERVIEW<').test(html),
      name + ': the card is captioned OVERVIEW', html.slice(0, 200));
    ok(html.includes('data-tx-info="' + id + '"'),
      name + ': the ⓘ is the SHARED mark, with this view\'s own panel id');
    ok(new RegExp('<div class="tx-vh-panel" id="' + id + '"[^>]*hidden>').test(html),
      name + ': ...and it ships CLOSED', html.slice(0, 400));
    ok(html.includes('aria-label="' + label + '"'), name + ': ...with an accessible name');
    // THE ⓘ IS INSIDE THE HEAD ROW, never floated beside the card. That was
    // the visible half of the reported difference between the two screens.
    // INSIDE the head row, not merely before the card. An index compare
    // passes for a mark rendered after the head closes — which is exactly
    // the "lone ⓘ floating beside the readings" this release removed — so
    // the anatomy is pinned elementwise: head > eyebrow > button, then the
    // panel, then the group.
    ok(new RegExp('<div class="cur-ov-head[^"]*"><div class="cur-ov-eyebrow[^"]*">[^<]*</div>'
      + '<button type="button" class="tx-vh-info"').test(html),
    name + ': ...and it sits INSIDE the head row, beside the eyebrow it belongs to',
    html.slice(html.indexOf('cur-ov-head') - 20, html.indexOf('cur-ov-head') + 260));
    const panel = html.indexOf('tx-vh-panel');
    const group = html.indexOf('cur-ov-group');
    ok(panel !== -1 && panel < group,
      name + ': ...with its panel between the head and the card', panel + '/' + group);
  }
}
{
  // §1c — THE ONLY TWO PERMITTED DIFFERENCES, enumerated.
  section('§1c — the two adopters may differ in exactly two ways');
  ok(withClass(DOM, 'cur-ov-sub').length === 0,
    'the Domains figures carry NO second line, so they are byte-identical to the row they replaced');
  eq('the Context figures carry one each', withClass(CTX, 'cur-ov-sub').length, 3);
  ok(/class="cur-ov-value dm-stat-value/.test(DOM) && !/dm-stat-value/.test(CTX),
    'and the alias token is the second — see §2');
  // ── AND THE THIRD: THE FIGURE'S RUNG ─────────────────────────────────
  // A COUNT and a PHRASE are different content. `figure: 'phrase'` drops one
  // rung, and it is the component's ONLY option — enumerated here so the
  // next option has to be argued rather than added.
  ok(!/cur-ov-value-phrase/.test(DOM) && (CTX.match(/cur-ov-value-phrase/g) || []).length === 3,
    'the Domains counts keep the display rung and all three Context phrases drop one');
  const optioned = new Set();
  for (const m of KIT_JS.matchAll(/opts\.(\w+)/g)) optioned.add(m[1]);
  optioned.delete('id'); optioned.delete('eyebrow'); optioned.delete('cards');
  optioned.delete('jumps'); optioned.delete('infoText'); optioned.delete('infoLabel');
  optioned.delete('infoHtml'); optioned.delete('alias'); optioned.delete('sectionClass');
  eq('...and `figure` is the only OPTION the component takes beyond its content '
    + 'and its host\'s own classes', [...optioned].sort().join(','), 'figure');
  ok(renderOverview({ id: 'p', eyebrow: 'P', figure: 'phrase',
    cards: [{ label: 'A', value: 'saved 12 min ago' }] }).includes('cur-ov-value-phrase'),
  'CONTROL: the kit really does render the phrase rung when it is asked for');
  ok(!renderOverview({ id: 'p', eyebrow: 'P', figure: 'something-else',
    cards: [{ label: 'A', value: '1' }] }).includes('cur-ov-value-phrase'),
  '...and an unrecognised value takes the DEFAULT rung rather than none at all');
  // ANTI-VACUITY: a `sub` handed to the Domains shape would render, so the
  // absence above is the CALLER's decision and not a capability the kit lacks.
  ok(renderOverview({ id: 'x', eyebrow: 'X', cards: [{ label: 'A', value: '1', sub: 's' }] })
    .includes('cur-ov-sub'),
  'CONTROL: the kit renders a second line when it is given one');
}

// ═════════════════════════════════════════════════════════════════════════
section('§2 — THE ALIAS IS THE DOMAINS PAGE\'S, and it stays there');
// ═════════════════════════════════════════════════════════════════════════
{
  for (const token of ['dm-stats-grid', 'dm-stat-card', 'dm-stat-value', 'dm-stats-group',
    'dm-section-head-row', 'dm-section-eyebrow', 'dm-jump-row', 'dm-jump-card', 'dm-jump-value']) {
    ok(DOM.includes(token), 'the Domains card still carries `' + token + '` — four suites, this '
      + 'view\'s listeners and its column patch address it by name');
  }
  const leaked = (CTX.match(/\bdm-[\w-]+/g) || []);
  eq('...and NOT ONE `dm-` token reaches the Context view', leaked.join(','), '');
  ok(!MEMORY_JS.includes("alias: 'dm'"), 'views/memory.js does not ask for the alias');
  ok(DOMAINS_JS.includes("alias: 'dm'"), 'CONTROL: views/domains.js does');

  // THE INK STAYED BEHIND, and that is the rule the split rests on: the kit
  // may not read a view's token set.
  ok(/toneClass: 'dm-stat-project'/.test(DOMAINS_JS),
    'the Domains page hands its own ink classes in as `toneClass`');
  ok(!/--dm-ink/.test(KIT_CSS.replace(/\/\*[\s\S]*?\*\//g, '')),
    'and the kit\'s stylesheet declares no `--dm-ink-*` token');
  ok(/class="cur-ov-value dm-stat-value dm-stat-entity"/.test(DOM),
    '...which lands on the figure beside the kit\'s own classes', DOM.slice(0, 600));
}

// ═════════════════════════════════════════════════════════════════════════
section('§3 — A FILTER HIGHLIGHT ONLY WHERE THERE IS A FILTER');
// ═════════════════════════════════════════════════════════════════════════
{
  const pressed = (html) => (html.match(/aria-pressed="(true|false)"/g) || []);
  eq('four of the five Domains figures are toggles over the page list',
    pressed(DOM).length, 4);
  eq('...and exactly ONE of them is selected, from the filter state',
    pressed(DOM).filter((s) => s.includes('true')).length, 1);
  ok(/data-stat-facet="entities" aria-pressed="true"/.test(DOM),
    '...the one the filter actually names', DOM.slice(0, 900));
  eq('NO Context card carries aria-pressed — there is no filter on that page',
    pressed(CTX).length, 0);
  ok(CTX.includes('not a filter'),
    '...and the ⓘ says so in words, rather than leaving the reader to notice');
  // The Domains ⓘ must NOT make that claim, because its figures ARE a filter.
  ok(!DOM.includes('not a filter'), 'CONTROL: the Domains ⓘ makes no such claim');

  // EVERY CARD IS A DOOR ON THE CONTEXT PAGE, and each one names its step.
  const jumps = tags(CTX).filter((t) => t.attrs['data-ov-jump'] !== undefined)
    .map((t) => t.attrs['data-ov-jump']);
  eq('the three readings open the three steps, and CAPTURE the session reading',
    jumps.join(','), 'context-canonical,context-state,context-knowledge,capture');
  ok(/aria-label="Foundations, 2 documents — go to step 1"/.test(CTX),
    '...each with an accessible name that says where it goes', CTX.slice(0, 900));
  // The Domains page's own two doors, unchanged.
  const dj = tags(DOM).filter((t) => t.attrs['data-ov-jump'] !== undefined)
    .map((t) => t.attrs['data-ov-jump']);
  eq('the Domains card keeps its three doors', dj.join(','), 'projects,sources,shared');
  ok(/data-stat-jump="projects"/.test(DOM) && /data-stat-jump="sources"/.test(DOM),
    '...still addressable by the hook `bindStatCardListeners` binds');

  // A DOOR TO A READING THAT HAS NOT ARRIVED IS NOT DRAWN.
  const noCap = contextOverview({ capture: { domain: 'acme', project: 'lumina', error: null, data: null } });
  ok(!noCap.includes('CAPTURE'), 'with no capture answer yet there is no CAPTURE door at all');
  ok(!noCap.includes('cur-ov-jumps'), '...and no jump row either, rather than an empty one');

  // THE SHARED TILE IS RENDERED AND HIDDEN, never omitted — it is revealed
  // without a repaint, and `[hidden]` is what makes that possible.
  const noShared = domainsOverview();
  ok(/data-stat-jump="shared"/.test(noShared), 'CONTROL: the SHARED tile is in the markup');
  const hiddenShared = new RegExp('data-ov-jump="shared"[^>]*hidden');
  ok(!hiddenShared.test(DOM), '...visible when the panel has reported a connection');
  // AND HIDDEN WHEN IT IS NOT, which is the half that matters: the tile is
  // revealed later by ONE attribute write with no repaint, so an omitted tile
  // means the reveal has nothing to write to and the reading never appears.
  const noConn = domainsOverview({ __jumps: true });
  ok(/data-ov-jump="shared"[^>]*hidden/.test(noConn),
    'a jump whose answer has not warranted it is RENDERED and HIDDEN, never omitted',
    noConn.slice(noConn.indexOf('cur-ov-jumps'), noConn.indexOf('cur-ov-jumps') + 400));
  ok(withClass(noConn, 'cur-ov-jump').length === withClass(DOM, 'cur-ov-jump').length,
    '...so the row holds the same number of tiles either way');
}

// ═════════════════════════════════════════════════════════════════════════
section('§4 — EVERY CALLER STRING IS ESCAPED, AND TWO NAMED FIELDS ARE NOT');
// ═════════════════════════════════════════════════════════════════════════
const XSS = '<img src=x onerror=alert(1)>';
const ATTR = '" onmouseover="alert(1)';
{
  const hostile = renderOverview({
    id: 'x' , eyebrow: 'OVER' + XSS, sectionClass: 'ok ' + XSS,
    infoText: XSS, infoLabel: ATTR,
    alias: XSS,
    cards: [{ label: XSS, value: ATTR, sub: XSS, toneClass: 'good ' + ATTR,
      facet: XSS, active: true, name: ATTR },
    { label: 'B', value: 'v', jump: ATTR, name: XSS }],
    jumps: [{ key: ATTR, label: XSS, value: ATTR, name: XSS }],
  });
  ok(!hostile.includes('<img '), 'no hostile element survives anywhere in the card', hostile.slice(0, 300));
  // The STRING "onerror=" survives as escaped TEXT, which is correct and is
  // the point; what must not exist is a TAG carrying it as an attribute.
  // The STRING "onerror=" survives as escaped TEXT, and `onmouseover=&quot;`
  // survives inside an escaped attribute VALUE. Both are correct and are the
  // point. What must not exist is a real handler attribute, which needs a
  // real quote after the `=` — the exact byte escaping removes.
  ok(!/\son\w+="/.test(hostile), '...and no tag carries a hostile handler',
    hostile.slice(0, 400));
  ok(/aria-label="&quot; onmouseover=&quot;/.test(hostile),
    'CONTROL: the attribute-breaking payload IS present, escaped — so the line above is '
    + 'about escaping and not about an input that never arrived');
  ok(!/ onmouseover="/.test(hostile), '...and nothing breaks out of an attribute',
    hostile.slice(0, 600));
  ok(!hostile.includes('class="ok <'), 'the section class is a class NAME slot, filtered rather than escaped');
  ok(/class="cur-ov-value[^"]*good"/.test(hostile),
    '...and so is toneClass: the safe token survives and the rest is dropped', hostile.slice(0, 900));
  ok(!/\balias\b/.test('') && !hostile.includes('dm-stat-card'),
    'an alias the kit does not recognise adds NOTHING, rather than being interpolated');

  // THE TWO TRUSTED FIELDS, named and proven.
  const trusted = renderOverview({ id: 'y', eyebrow: 'Y',
    infoText: '<p><b>bold</b></p>', infoHtml: true,
    cards: [{ label: 'A', value: '1', markHtml: '<span class="fresh-dot fresh-live"></span>' }] });
  ok(trusted.includes('<b>bold</b>'), '`infoText` + `infoHtml: true` is trusted markup');
  ok(trusted.includes('<span class="fresh-dot fresh-live"></span>'), '`markHtml` is trusted markup');
  ok(renderOverview({ id: 'z', eyebrow: 'Z', infoText: '<b>x</b>',
    cards: [{ label: 'A', value: '1' }] }).includes('&lt;b&gt;'),
  '...and WITHOUT `infoHtml` the same string is escaped — the default is safe');

  // REAL HOSTILE INPUT THROUGH THE REAL VIEW. The domain name is a user
  // string and it reaches the KNOWLEDGE card's second line.
  const hostileCtx = contextOverview({ activeDomain: XSS });
  ok(!hostileCtx.includes('<img '), 'a hostile DOMAIN NAME is escaped on the real Context card',
    hostileCtx.slice(0, 400));
}
{
  // NO READING, NO INSTRUMENT.
  eq('an overview with no card renders nothing at all',
    renderOverview({ id: 'a', eyebrow: 'A', cards: [] }), '');
  eq('...nor without an id', renderOverview({ eyebrow: 'A', cards: [{ label: 'x', value: 1 }] }), '');
  eq('...nor without an eyebrow', renderOverview({ id: 'a', cards: [{ label: 'x', value: 1 }] }), '');
  eq('...and a non-object argument is refused rather than throwing',
    renderOverview(undefined), '');
  // A card with no value is dropped, not printed as an empty figure.
  eq('a card with a null value is dropped',
    withClass(renderOverview({ id: 'a', eyebrow: 'A',
      cards: [{ label: 'x', value: null }, { label: 'y', value: 0 }] }), 'cur-ov-card').length, 1);
}

// ═════════════════════════════════════════════════════════════════════════
section('§5 — NO PERCENTAGES, NO RATIOS, AND A MARK NEVER READS ALONE');
// ═════════════════════════════════════════════════════════════════════════
{
  const visible = (html) => html
    .replace(/<div class="tx-vh-panel"[\s\S]*?<\/div>/g, ' ')
    .replace(/<[^>]*>/g, ' ');
  for (const [name, html] of [['Domains', DOM], ['Context', CTX]]) {
    ok(!/\d+\s*%/.test(visible(html)), name + ': no percentage is printed on the card');
    ok(!/\b\d+\s*\/\s*\d+\b/.test(visible(html)), name + ': and no ratio either');
  }
  // EVERY MARK IS aria-hidden AND HAS A WORD BESIDE IT. The dot carries no
  // reading of its own — the app-wide rule for the freshness scale.
  const dots = [...CTX.matchAll(/<span class="fresh-dot[^"]*"([^>]*)>/g)].map((m) => m[1]);
  ok(dots.length === 3 && dots.every((a) => /aria-hidden="true"/.test(a)),
    'all three Context marks are aria-hidden — the words beside them are the reading',
    JSON.stringify(dots));
  ok(/fresh-dot fresh-week[^<]*<\/span>2 documents/.test(CTX.replace(/\s+/g, ' ')),
    '...and the mark rides INSIDE the value, beside the reading it qualifies',
    CTX.slice(CTX.indexOf('FOUNDATIONS'), CTX.indexOf('FOUNDATIONS') + 300));
  ok(!/fresh-dot/.test(DOM),
    'the Domains figures take no mark, because nothing there is a comparison against a clock');
}

// ═════════════════════════════════════════════════════════════════════════
section('§6 — THE STYLESHEET, AND THE THREE RULES THAT FAIL SILENTLY');
// ═════════════════════════════════════════════════════════════════════════
{
  ok(INDEX_HTML.includes('href="/next/shared/overview.css"'),
    'the stylesheet is LINKED — an unlinked one is unstyled AND invisible to test-css-tokens.js §5');
  const linkAt = INDEX_HTML.indexOf('/next/shared/overview.css');
  const firstView = INDEX_HTML.indexOf('/next/views/');
  ok(linkAt !== -1 && firstView !== -1 && linkAt < firstView,
    '...ABOVE the view sheets, so a host may still place it at equal specificity',
    linkAt + ' vs ' + firstView);

  const bare = KIT_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const emitted = new Set();
  for (const m of KIT_JS.matchAll(/class="(cur-ov[\w-]*)/g)) emitted.add(m[1]);
  for (const m of KIT_JS.matchAll(/cls\('(cur-ov[\w-]*)'/g)) emitted.add(m[1]);
  ok(emitted.size >= 7, 'CONTROL — the component emits ' + emitted.size + ' kit classes',
    [...emitted].join(','));
  for (const c of emitted) {
    if (c === 'cur-ov') continue; // the wrapper is a placement hook with no rule of its own
    ok(new RegExp('\\.' + c + '\\b').test(bare), '`.' + c + '` resolves a rule in the kit stylesheet');
  }

  // THE PRESS AND ITS ESCAPE, in the same file, in that order.
  const press = /\.cur-ov-group button\.cur-ov-card:active,\s*\.cur-ov-group button\.cur-ov-card\[aria-pressed\]:active\s*\{([^}]*)\}/.exec(bare);
  ok(!!press, 'the press rule carries both the bare and the [aria-pressed] arm',
    'the two-arm press selector is gone');
  const sel = /\.cur-ov-group button\.cur-ov-card\[aria-pressed="true"\]\s*\{([^}]*)\}/.exec(bare);
  ok(!!sel && bare.indexOf(press[0]) > bare.indexOf(sel[0]),
    '...declared AFTER the selected fill it has to outrank');
  const rm = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\}\s*\}/.exec(bare);
  ok(!!rm && /cur-ov-card\[aria-pressed\]:active/.test(rm[1]) && /cur-ov-jump:active/.test(rm[1])
    && /transform:\s*none/.test(rm[1]),
  'every press declared here has its reduced-motion escape here too', rm && rm[1]);
  ok(bare.lastIndexOf('@media (prefers-reduced-motion') > bare.lastIndexOf('.cur-ov-jump-value'),
    '...declared LAST in the file, because a media query adds no specificity and would '
    + 'otherwise lose to the later of two tied `.class:pseudo` rules');

  // `[hidden]` LOSES TO AN AUTHOR `display:` AT ANY SPECIFICITY.
  ok(/\.cur-ov-jump\[hidden\]\s*\{\s*display:\s*none;?\s*\}/.test(bare),
    'the kit carries the counter-rule that makes `hidden` real on a jump tile');
  ok(/\.cur-ov-jump\s*\{[^}]*display:\s*flex/.test(bare),
    'CONTROL — the tile really does declare a display of its own');

  // THE MOVE WAS A MOVE. views/domains.css must no longer own the card.
  const domCss = readFileSync(path.join(NEXT, 'views/domains.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  for (const dead of ['.dm-stats-grid', '.dm-stat-card', '.dm-stat-value', '.dm-jump-card',
    '.dm-jump-row', '.dm-jump-value', '.dm-stats-group']) {
    ok(!new RegExp('\\' + dead + '[\\s,{]').test(domCss),
      'views/domains.css declares no rule for `' + dead + '` — the card moved, it was not copied');
  }
  ok(/\.dm-stat-entity\s*\{[^}]*--dm-ink-entity/.test(domCss),
    'CONTROL: the three ink classes stayed, because they read this view\'s own ramp');
}

// ═════════════════════════════════════════════════════════════════════════
section('§7 — THE COPIED HELPER, PINNED RATHER THAN TRUSTED');
// ═════════════════════════════════════════════════════════════════════════
{
  // shared/block.js records why every import-free kit module carries its own
  // escapeHtml. The copies must not be "improved" independently.
  const grab = (src) => {
    const fn = extractFunction(src, 'escapeHtml', 'kit');
    return fn.replace(/\s+/g, ' ').trim();
  };
  eq('shared/overview.js\'s escapeHtml is byte-identical to shared/block.js\'s (modulo whitespace)',
    grab(KIT_JS), grab(BLOCK_JS));
  // ANTI-VACUITY: it actually escapes.
  eq('CONTROL — and it escapes all five characters',
    new Function(extractFunction(KIT_JS, 'escapeHtml', 'kit') + '\nreturn escapeHtml;')()('<&>"\''),
    '&lt;&amp;&gt;&quot;&#39;');
  // THE KIT TAKES ONE IMPORT, AND IT IS THE SHARED MARK.
  const imports = [...KIT_JS.matchAll(/^import .*from '([^']+)';$/gm)].map((m) => m[1]);
  eq('the kit imports exactly one module — the shared ⓘ', imports.join(','), './text.js');
}

console.log('\n  ' + '─'.repeat(60));
console.log('  Passed: ' + passed + '   Failed: ' + failed);
if (failed) {
  console.log('  \x1b[31m❌ ' + failed + ' overview-kit assertion(s) failed\x1b[0m');
  process.exit(1);
}
console.log('  \x1b[32m✅ one overview card, two views, one shape\x1b[0m');
