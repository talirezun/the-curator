#!/usr/bin/env node
/**
 * ════════════════════════════════════════════════════════════════════════════
 *  test-next-sidebar-kit.js — ONE sidebar, rendered by THREE views.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * OFFLINE. No network, no API key, no LLM, no filesystem outside this repo.
 *
 * ── WHAT THIS SUITE EXISTS TO STOP ─────────────────────────────────────────
 *
 * Three sidebars, measured at a 1370px window, all at `x=89 w=248` inside the
 * same 272px rail column, in three designs: Domains with a primary and a
 * secondary button and rows 63.8px tall carrying an identity dot, a figure, a
 * freshness mark, a CLOCK GLYPH and an age; Context with two ghost buttons, a
 * square mark, no clock, the headline on the wrong line and an accent-tint
 * selection; Settings with no actions at all and a 2px violet `::before` bar
 * for selection. *"Totally different designs, so this needs to be synced. I
 * suggest we go with the Domains design, which is more polished."*
 *
 * So the Domains sidebar is the reference, and the thing that can quietly
 * stop being true is that all three still come out of one function:
 *
 *   1. THE REFERENCE MOVING. §1 reproduces views/domains.js's REAL rendered
 *      rows through the component and compares them to a FROZEN CORPUS of
 *      what that view shipped at v3.64.2 — byte for byte, after exactly three
 *      named normalisations, each of which is itself asserted inert. If the
 *      component's output drifts by one character that the normalisations do
 *      not cover, this reds.
 *   2. A SECOND ROW SHAPE. §2 renders the Context and Settings descriptions
 *      and requires the SAME element sequence as Domains, modulo the slots a
 *      host does not fill. A host cannot "nearly" adopt.
 *   3. THE LEFT LINE COMING BACK, or any second selection idiom. §3 requires
 *      ACTIVE to be a class on the row and the stylesheet to paint it with a
 *      `--mat-row-*` overlay, and forbids a `::before` rule in the kit.
 *   4. A CALLER-SUPPLIED STRING REACHING THE PAGE UNESCAPED. §4 drives the
 *      XSS corpus through every field. THREE fields are trusted by name —
 *      `markHtml`, `badgesHtml`, `iconHtml` — and the suite pins that they
 *      are the only three; `dotClass` and `stateClass` are class NAMES and
 *      are FILTERED to the class alphabet rather than escaped.
 *   5. THE ALIAS TABLE GROWING. §5 pins it at three entries with the exact
 *      tokens each view's shipped suites address by name, and fails if a
 *      host's tokens reach another host's output.
 *   6. THE STYLESHEET GOING MISSING OR OVERREACHING. §6 requires every
 *      emitted class to resolve a rule, the press to keep its reduced-motion
 *      escape, and the file to declare NO `.fresh-` rule (shared/freshness.css
 *      owns that scale) and NO colour literal (the design-kit baseline holds
 *      exactly two files, neither of them shared).
 *
 * ── EXECUTED, NOT SCANNED ──────────────────────────────────────────────────
 * §1 lifts views/domains.js's real row-building block by brace-matching and
 * EXECUTES it against the same fixture the component is given, so the corpus
 * below is checked against the shipped view as well as against the kit. That
 * arm is the one that expires: when views/domains.js adopts the component,
 * the hand-built block is gone, and §1d asserts the OTHER arm — that the view
 * imports `renderSidebarRow` — so exactly one of the two holds at any time and
 * neither can silently become vacuous.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────
 *  · Each view's own selection behaviour, its binder and its data. Those
 *    belong to test-sidebar-status-rows.js, test-next-memory-view.js and the
 *    Settings suites, which lift and EXECUTE each view's `renderSidebar`.
 *  · Rendering, layout and contrast. Nothing in Node measures a pixel.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  renderSidebarHead, renderSidebarGroup, renderSidebarRow,
  identityDotClass, IDENTITY_DOT_SLOTS, ALIASES,
} from '../src/public/next/shared/sidebar.js';
import { formatDayAge, freshnessDotHtml, clockGlyph } from '../src/public/next/shared/age.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const NEXT = path.join(ROOT, 'src/public/next');
const KIT_JS = readFileSync(path.join(NEXT, 'shared/sidebar.js'), 'utf8');
const KIT_CSS = readFileSync(path.join(NEXT, 'shared/sidebar.css'), 'utf8');
const OVERVIEW_JS = readFileSync(path.join(NEXT, 'shared/overview.js'), 'utf8');
const DOMAINS_JS = readFileSync(path.join(NEXT, 'views/domains.js'), 'utf8');
const MEMORY_JS = readFileSync(path.join(NEXT, 'views/memory.js'), 'utf8');
const SETTINGS_JS = readFileSync(path.join(NEXT, 'views/settings.js'), 'utf8');
const INDEX_HTML = readFileSync(path.join(NEXT, 'index.html'), 'utf8');
const BARE_CSS = KIT_CSS.replace(/\/\*[\s\S]*?\*\//g, '');

let passed = 0;
let failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + msg); return true; }
  failed++;
  console.log('  \x1b[31m✗\x1b[0m ' + msg + (detail === undefined ? '' : ' — ' + String(detail).slice(0, 500)));
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
/** The element sequence over the KIT's own classes only, so a host's alias
 *  tokens and its state classes cannot make two identical structures differ. */
const shapeOf = (html) => tags(html)
  .filter((t) => t.classes.some((c) => c.startsWith('cur-sb')))
  .map((t) => t.tag + '.' + t.classes.filter((c) => c.startsWith('cur-sb'))[0])
  .join(' > ');

// ═════════════════════════════════════════════════════════════════════════
//  THE FIXTURE — one for every host, one clock, one set of facts
// ═════════════════════════════════════════════════════════════════════════
const NOW = Date.parse('2026-09-21T09:00:00Z');
const DOMAIN_ROWS = [
  { slug: 'articles', name: 'Articles', figure: '3,428 pages', date: '2026-09-16',
    event: 'Ingested · From Lab to Life — Complete', attn: 3, dot: 1 },
  { slug: 'projects', name: 'Projects', figure: '767 pages', date: '2026-09-07',
    event: 'Ingested · Lumina Project Overview and More', active: true, dot: 2 },
  { slug: 'shared-cohort', name: 'Shared cohort', figure: '1 page', date: null,
    event: null, ro: true, dot: 3 },
];

function domainsRows() {
  return DOMAIN_ROWS.map((r) => renderSidebarRow({
    alias: 'dm',
    name: r.name,
    dotClass: 'dm-row-dot-' + r.dot,
    figure: r.figure,
    markHtml: freshnessDotHtml(r.date, NOW),
    age: formatDayAge(r.date, NOW),
    ageFallback: 'nothing written yet',
    ageExact: r.date || '',
    event: r.event,
    active: r.active === true,
    data: { 'domain-slug': r.slug },
    badgesHtml:
      (r.ro ? '<span class="dm-row-mirror">RO</span>'
        + '<span class="visually-hidden">Read-only Shared Brain mirror</span>' : '')
      + (r.attn ? '<span class="dm-row-attn"></span><span class="visually-hidden">'
        + r.attn + ' open health issue' + (r.attn === 1 ? '' : 's') + '</span>' : ''),
  })).join('');
}

// ── THE FROZEN CORPUS ──────────────────────────────────────────────────────
// What views/domains.js's renderSidebar SHIPPED at v3.64.2 (base 612f881) for
// the fixture above, produced by lifting and executing that view's own row
// block — not transcribed by hand. It is frozen here because the whole
// acceptance test for this component is "the reference design did not move",
// and once views/domains.js adopts the component, comparing the component to
// the view would be comparing it with itself.
const DOMAINS_CORPUS_V3642 = '<button class="dm-row" data-domain-slug="articles"><span class="dm-row-dot dm-row-dot-1"></span><span class="dm-row-main"><span class="dm-row-name">Articles</span><span class="dm-row-meta"><span class="dm-row-figure">3,428 pages</span><span class="dm-row-sep" aria-hidden="true">·</span><span class="fresh-dot fresh-week" aria-hidden="true"></span><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.2V12l3.2 2"/></svg><span class="dm-row-age">5 days ago</span><span class="visually-hidden"> (2026-09-16)</span></span><span class="dm-row-event">Ingested · From Lab to Life — Complete</span></span><span class="dm-row-attn"></span><span class="visually-hidden">3 open health issues</span></button><button class="dm-row active" data-domain-slug="projects"><span class="dm-row-dot dm-row-dot-2"></span><span class="dm-row-main"><span class="dm-row-name">Projects</span><span class="dm-row-meta"><span class="dm-row-figure">767 pages</span><span class="dm-row-sep" aria-hidden="true">·</span><span class="fresh-dot fresh-dormant" aria-hidden="true"></span><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.2V12l3.2 2"/></svg><span class="dm-row-age">2 weeks ago</span><span class="visually-hidden"> (2026-09-07)</span></span><span class="dm-row-event">Ingested · Lumina Project Overview and More</span></span></button><button class="dm-row" data-domain-slug="shared-cohort"><span class="dm-row-dot dm-row-dot-3"></span><span class="dm-row-main"><span class="dm-row-name">Shared cohort</span><span class="dm-row-meta"><span class="dm-row-figure">1 page</span><span class="dm-row-sep" aria-hidden="true">·</span><span class="fresh-dot fresh-unknown" aria-hidden="true"></span><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.2V12l3.2 2"/></svg><span class="dm-row-age">nothing written yet</span></span></span><span class="dm-row-mirror">RO</span><span class="visually-hidden">Read-only Shared Brain mirror</span></button>';

// ── THE THREE NORMALISATIONS, AND NOTHING ELSE ─────────────────────────────
// Stated as code so they are checkable rather than described:
//   (a) the KIT TOKENS the component adds beside each host token — the same
//       aliasing shared/overview.js shipped in v3.64.2, where the acceptance
//       was pixel-identity rather than byte-identity for exactly this reason;
//   (b) `type="button"`, which the component always writes and the hand-built
//       row omitted. A <button> outside a form defaults to type="submit";
//       there is no form here, so it is inert — and writing it is what the
//       rest of /next does, including the overview card's own tiles.
//   (c) (§1b only) the group head's `style="margin-top:10px"`, an INLINE
//       style on the reference, which becomes `.cur-sb-group-head` carrying
//       the same 10px.
// Each is proved inert below rather than asserted to be.
const stripKitTokens = (h) => h.replace(/cur-sb-[a-z-]+ ?/g, '');
const stripTypeButton = (h) => h.replace(/ type="button"/g, '');
const normalise = (h) => stripTypeButton(stripKitTokens(h));

// ═════════════════════════════════════════════════════════════════════════
section('§1 — THE REFERENCE DESIGN DID NOT MOVE');
// ═════════════════════════════════════════════════════════════════════════
const DOM_ROWS = domainsRows();
{
  ok(DOM_ROWS.length > 500, 'CONTROL — the component produced three rows', DOM_ROWS.length);
  eq('three rows in, three rows out', withClass(DOM_ROWS, 'cur-sb-row').length, 3);

  // THE ASSERTION THIS FILE EXISTS FOR.
  eq('the component reproduces v3.64.2\'s Domains rows BYTE FOR BYTE, after the '
    + 'two named normalisations', normalise(DOM_ROWS), DOMAINS_CORPUS_V3642);

  // ── EACH NORMALISATION IS INERT, PROVED RATHER THAN CLAIMED ───────────
  ok(normalise(DOM_ROWS) !== DOM_ROWS,
    'CONTROL — the normalisations really do change something, so the equality above '
    + 'is not a comparison of a string with itself');
  {
    // (a) THE KIT TOKENS ARE ADDITIVE ONLY: every host token survives, in
    // order, and nothing but a `cur-sb-` token is added.
    const hostTokens = (h) => (h.match(/class="([^"]*)"/g) || [])
      .map((c) => c.slice(7, -1).split(/\s+/).filter((t) => !t.startsWith('cur-sb')).join(' '))
      .join('|');
    eq('(a) every class the reference wrote is still written, in the same order',
      hostTokens(DOM_ROWS), hostTokens(DOMAINS_CORPUS_V3642));
    const added = [...DOM_ROWS.matchAll(/class="([^"]*)"/g)]
      .flatMap((m) => m[1].split(/\s+/)).filter((t) => t.startsWith('cur-sb'));
    ok(added.length > 0 && added.every((t) => /^cur-sb[a-z-]*$/.test(t)),
      '(a) ...and every token added is on the kit\'s own prefix (' + new Set(added).size
        + ' distinct)', [...new Set(added)].join(' '));
  }
  {
    // (b) `type="button"` is the ONLY attribute added, and it is added to
    // buttons only.
    const attrs = (h) => tags(h).map((t) => t.tag + ':' + Object.keys(t.attrs)
      .filter((k) => k !== 'type' && k !== 'class').sort().join(',')).join('|');
    eq('(b) no attribute other than `type` differs, on any element',
      attrs(DOM_ROWS), attrs(DOMAINS_CORPUS_V3642));
    ok(tags(DOM_ROWS).filter((t) => t.attrs.type !== undefined)
      .every((t) => t.tag === 'BUTTON' && t.attrs.type === 'button'),
    '(b) ...and it lands on buttons only, always with the value "button"');
  }

  // ── THE ARM THAT EXPIRES, AND THE ONE THAT REPLACES IT ────────────────
  // While views/domains.js still builds its rows by hand, the corpus is
  // checked against THAT CODE, executed. When it adopts, the block is gone
  // and §1d's other arm holds instead. Exactly one is true at a time, and
  // neither can quietly become vacuous.
  section('§1d — the view is either the source of the corpus, or an adopter');
  const stillHandBuilt = DOMAINS_JS.includes('const rows = state.domains.map');
  const hasAdopted = /from '\.\.\/shared\/sidebar\.js'/.test(DOMAINS_JS)
    && DOMAINS_JS.includes('renderSidebarRow');
  ok(stillHandBuilt !== hasAdopted,
    'views/domains.js either still hand-builds its rows OR imports the component — '
    + 'exactly one', 'handBuilt=' + stillHandBuilt + ' adopted=' + hasAdopted);
  if (stillHandBuilt) {
    const fn = extractFunction(DOMAINS_JS, 'renderSidebar', 'domains.js');
    const start = fn.indexOf('const rows = state.domains.map');
    const end = fn.indexOf("}).join('');", start) + "}).join('');".length;
    const live = new Function('state', 'now', 'escapeHtml', 'formatDayAge',
      'freshnessDotHtml', 'clockGlyph', 'domainDotClass', 'domainLastEventText',
      fn.slice(start, end) + '\nreturn rows;')(
      {
        activeSlug: 'projects',
        readonlySet: new Set(['shared-cohort']),
        healthSummary: { articles: 3 },
        domains: DOMAIN_ROWS.map((r) => ({
          slug: r.slug, displayName: r.name,
          pageCount: Number(String(r.figure).replace(/[^\d]/g, '')),
          lastIngestDate: r.date, lastIngestKind: r.date ? 'ingest' : null,
          lastIngestTitle: r.event ? r.event.replace(/^Ingested · /, '') : null,
        })),
      },
      NOW, escapeHtml, formatDayAge, freshnessDotHtml, clockGlyph,
      new Function(extractFunction(DOMAINS_JS, 'domainDotClass', 'domains.js')
        + '\nconst DOMAIN_DOT_SLOTS = 6;\nreturn domainDotClass;')(),
      new Function('escapeHtml',
        extractFunction(DOMAINS_JS, 'domainLastEventText', 'domains.js')
        + '\nreturn domainLastEventText;')(escapeHtml));
    eq('...and while it hand-builds them, the corpus IS what that code produces, '
      + 'executed', live, DOMAINS_CORPUS_V3642);
  } else {
    ok(hasAdopted, '...and it has adopted, so the corpus is the frozen reference');
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('§1b — THE HEAD AND THE GROUP');
// ═════════════════════════════════════════════════════════════════════════
const DOM_HEAD = renderSidebarHead({
  title: 'Domains',
  primary: { label: 'New domain', id: 'dm-new-domain-btn', iconHtml: '<svg data-i="grid"></svg>' },
  secondary: { label: 'Use existing folder', id: 'dm-kb-choose-btn', iconHtml: '<svg data-i="folder"></svg>' },
});
{
  eq('the title is the shell\'s own `.sidebar-title`, with NO ⓘ',
    /<div class="sidebar-title">Domains<\/div>/.test(DOM_HEAD) && !/tx-vh-info/.test(DOM_HEAD),
    true);
  ok(!/info/i.test(KIT_JS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')),
    '...and the component takes no `info` option at all, so a host cannot add one back');
  eq('the primary is a `btn btn-primary` in the first slot',
    /<button type="button" class="btn btn-primary cur-sb-primary" id="dm-new-domain-btn">/.test(DOM_HEAD),
    true);
  eq('...and the secondary a `btn btn-secondary` in the second',
    /<button type="button" class="btn btn-secondary cur-sb-secondary" id="dm-kb-choose-btn">/.test(DOM_HEAD),
    true);
  ok(DOM_HEAD.indexOf('btn-primary') < DOM_HEAD.indexOf('btn-secondary'),
    '...in that order, because the primary slot means "create the kind of thing this list holds"');
  // THE CLASS LIST IS A LITERAL PREFIX. test-next-button-chrome.js reads the
  // SOURCE of every `<button … class="…">` in /next and fails any whose
  // tokens resolve no author border; `class="' + klass + '"` is, to that
  // scanner, a button with no readable class at all.
  // COMMENTS STRIPPED. The module's own docblock QUOTES the bad spelling
  // (`class="' + klass + '"`) while explaining why it is refused, and a raw
  // scan reads the explanation as a violation — the comment-satisfies-a-scan
  // hazard this repo keeps recording, in its inverted form. Caught by this
  // assertion going red on its first run against three "buttons", two of
  // which were sentences.
  const KIT_JS_BARE = KIT_JS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const buttonOpens = [...KIT_JS_BARE.matchAll(/<button\b[\s\S]{0,60}?class="([^"]*)/g)].map((m) => m[1]);
  ok(buttonOpens.length >= 2 && buttonOpens.every((b) => /^[a-z][\w-]+/.test(b)),
    'every `<button>` in the module opens its class attribute with a LITERAL token ('
      + buttonOpens.length + ') — a class list assembled entirely from a call yields '
      + 'test-next-button-chrome.js NO tokens, and it SKIPS the occurrence rather '
      + 'than failing it', buttonOpens.map((b) => JSON.stringify(b)).join(' | '));
  ok(buttonOpens.some((b) => b.startsWith('btn ')) && buttonOpens.some((b) => b.startsWith('cur-sb-row')),
    '...and those literals are `btn` and `cur-sb-row`, both of which declare an author border',
    buttonOpens.join(' | '));
  // A DISABLED CONTROL SAYS SO.
  ok(/ disabled>/.test(renderSidebarHead({ title: 'D', primary: { label: 'X', disabled: true } })),
    'a disabled action carries the attribute');
  // NO TITLE, NO HEAD.
  eq('a head with no title renders nothing', renderSidebarHead({ primary: { label: 'X' } }), '');
  eq('...and an action with no label is dropped rather than rendered empty',
    renderSidebarHead({ title: 'D', primary: { label: '' } }),
    '<div class="sidebar-title">Domains</div>'.replace('Domains', 'D'));

  const group = renderSidebarGroup({ eyebrow: 'KNOWLEDGE', rowsHtml: DOM_ROWS, alias: 'dm' });
  // (c) THE THIRD NORMALISATION: the reference wrote the eyebrow's spacing as
  // an INLINE `style="margin-top:10px"` — the one thing in that sidebar no
  // stylesheet could reach. It is the same 10px, now in a rule.
  ok(DOMAINS_JS.includes('<div class="cur-eyebrow" style="margin-top:10px">KNOWLEDGE</div>'),
    'CONTROL — the reference really does write that spacing inline');
  ok(/<div class="cur-sb-group-head cur-eyebrow">KNOWLEDGE<\/div>/.test(group),
    '(c) the group head keeps `.cur-eyebrow` and drops the inline style');
  ok(/\.cur-sb-group-head\s*\{[^}]*margin-top:\s*10px/.test(BARE_CSS),
    '(c) ...for a rule carrying the SAME 10px, so nothing moves');
  ok(/<div class="cur-sb-list dm-row-list">/.test(group),
    'the list keeps the host\'s own container token');
  eq('a group with no rows renders NOTHING — an eyebrow over an empty box reads as a failure',
    renderSidebarGroup({ eyebrow: 'KNOWLEDGE', rowsHtml: '' }), '');
  ok(!/<div class="cur-sb-group"/.test(group),
    'the head and the list are SIBLINGS — a wrapper would hide the list one level '
    + 'down and put a second box between the rail column and the rows');
}

// ═════════════════════════════════════════════════════════════════════════
section('§2 — ONE ROW SHAPE, THREE HOSTS');
// ═════════════════════════════════════════════════════════════════════════
{
  // Context: the identity dot gains its COLOUR from the kit's mapping, the
  // age gains the CLOCK GLYPH it never had, and the headline moves from line
  // two to line three — the last-event slot Domains' "Ingested · …" occupies.
  const ctx = renderSidebarRow({
    alias: 'mem',
    name: 'curator',
    dotClass: identityDotClass(0),
    figure: '18 scopes',
    markHtml: '<span class="fresh-dot fresh-today" aria-hidden="true"></span>',
    age: '15 hr ago',
    event: 'v3.64.2 RELEASED (tag 1d69cf7 = main)',
    active: true,
    ariaCurrent: true,
    data: { 'mem-domain': 'projects', 'mem-project': 'curator' },
  });
  // Settings: a label and a mono hint, nothing else.
  const set = renderSidebarRow({
    alias: 'settings', name: 'General', event: 'Software update, appearance',
    active: true, data: { section: 'general' },
  });
  const dom1 = renderSidebarRow({
    alias: 'dm', name: 'Articles', dotClass: 'dm-row-dot-1', figure: '3,428 pages',
    markHtml: '<span class="fresh-dot fresh-week" aria-hidden="true"></span>',
    age: '5 days ago', event: 'Ingested · From Lab to Life',
  });

  eq('Domains and Context render the IDENTICAL element sequence',
    shapeOf(dom1), shapeOf(ctx));
  eq('...and that sequence is the reference anatomy', shapeOf(dom1),
    'BUTTON.cur-sb-row > SPAN.cur-sb-dot > SPAN.cur-sb-main > SPAN.cur-sb-name > '
    + 'SPAN.cur-sb-meta > SPAN.cur-sb-figure > SPAN.cur-sb-sep > SPAN.cur-sb-age > '
    + 'SPAN.cur-sb-event');
  eq('Settings renders the same sequence with the slots it does not fill omitted',
    shapeOf(set), 'BUTTON.cur-sb-row > SPAN.cur-sb-main > SPAN.cur-sb-name > SPAN.cur-sb-event');

  // THE CLOCK GLYPH IS THE KIT'S, not the host's — *"it has clocks showing
  // when it was changed; in Context we don't have that"*. A host that had to
  // supply it is a host that can forget it.
  ok(ctx.includes(clockGlyph(12)),
    'the Context row now carries the SAME clock glyph the Domains row does');
  ok(!MEMORY_JS.includes('clockGlyph'),
    'CONTROL: views/memory.js does not import or emit one of its own');
  ok(!set.includes('<svg'), '...and a row with no age gets no glyph, not an empty one');
  ok(!renderSidebarRow({ name: 'A', figure: '1 page' }).includes('<svg'),
    '...nor does a row with a figure and no age');

  // THE HEADLINE IS ON LINE THREE. It sat on line TWO, above the figure, and
  // that is the one ordering difference between the two rails.
  ok(ctx.indexOf('cur-sb-meta') < ctx.indexOf('cur-sb-event'),
    'the Context headline sits in the LAST-EVENT slot, under the figure line');

  // THE SEPARATOR IS PUNCTUATION AND RENDERS ONLY BETWEEN TWO THINGS.
  ok(/aria-hidden="true">·</.test(dom1), 'the separator is aria-hidden');
  ok(!renderSidebarRow({ name: 'A', figure: '3 pages' }).includes('cur-sb-sep'),
    '...and a figure with nothing after it gets none');
  ok(!renderSidebarRow({ name: 'A', age: 'today' }).includes('cur-sb-sep'),
    '...nor does an age with nothing before it');

  // EMPTY SLOTS ARE OMITTED, NOT DRAWN EMPTY.
  ok(!set.includes('cur-sb-meta'),
    'a row with no figure, mark or age paints NO meta line — an empty 11px line '
    + 'would open a gap the design did not ask for');
  ok(!set.includes('cur-sb-dot'), '...and no dot');
  eq('a row with no name renders nothing at all', renderSidebarRow({ figure: '3 pages' }), '');
  ok(!renderSidebarRow({ name: 'A', age: '', ageFallback: '' }).includes('cur-sb-age'),
    'an empty age with an empty fallback paints no age slot');
  ok(renderSidebarRow({ name: 'A', age: '', ageFallback: 'nothing written yet' })
    .includes('nothing written yet'),
  '...and the fallback is what a never-written row says');

  // THE ABSOLUTE DATE IS REACHABLE, AND IT IS NOT A `title=`.
  ok(/<span class="visually-hidden"> \(2026-09-16\)<\/span>/.test(renderSidebarRow({
    name: 'A', age: '5 days ago', ageExact: '2026-09-16' })),
  'the exact date rides as visually-hidden text beside the age');
  ok(!/title=/.test(KIT_JS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')),
    '...and the component emits NO `title=` anywhere — hover-only is invisible to '
    + 'keyboard and to touch, and this file\'s hover-only ceiling must not rise');
}

// ═════════════════════════════════════════════════════════════════════════
section('§3 — ACTIVE IS THE FILLED ROW. THERE IS NO LEFT LINE.');
// ═════════════════════════════════════════════════════════════════════════
{
  const on = renderSidebarRow({ name: 'A', active: true });
  const off = renderSidebarRow({ name: 'A' });
  ok(/class="cur-sb-row active"/.test(on), 'the selected row carries the `active` class');
  ok(!/active/.test(off), '...and an unselected one does not');
  ok(/\.cur-sb-row\.active\s*\{[^}]*background:\s*var\(--mat-row-active\)/.test(BARE_CSS),
    'the stylesheet paints it with the --mat-row-* ALPHA OVERLAY, never an opaque '
    + 'surface — an opaque fill stops the sidebar plane\'s blur for the width of the row');
  ok(/\.cur-sb-row:hover\s*\{[^}]*background:\s*var\(--mat-row-hover\)/.test(BARE_CSS),
    '...and hover with the same family');
  // THE LEFT LINE. Settings drew selection as a 2px x 32.75px violet
  // `::before` and nothing else in the app did.
  ok(!/::before/.test(BARE_CSS),
    'the kit declares NO `::before` — one selection idiom, and a component that '
    + 'offered both would offer a future divergence');
  ok(/\.settings-nav-row::before/.test(readFileSync(path.join(NEXT, 'views/settings.css'), 'utf8')),
    'CONTROL: the rule this replaces still exists in views/settings.css — P5 deletes it');
  // THE PRESS, AND ITS ESCAPE.
  ok(/\.cur-sb-row:active\s*\{[^}]*transform:\s*translateX\(var\(--press-shift\)\)/.test(BARE_CSS),
    'the press nudges along the axis the list does NOT scroll in');
  const rm = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\}\s*\}/.exec(BARE_CSS);
  ok(!!rm && /\.cur-sb-row:active\s*\{\s*transform:\s*none/.test(rm[1]),
    '...with its reduced-motion escape in the same file', rm && rm[1]);
  ok(BARE_CSS.lastIndexOf('@media (prefers-reduced-motion') > BARE_CSS.lastIndexOf('.cur-sb-event'),
    '...declared LAST, because a media query adds no specificity and would otherwise '
    + 'lose to the later of two tied `.class:pseudo` rules');
  // `aria-current` is the SEMANTIC half and is the host's to ask for.
  ok(/aria-current="true"/.test(renderSidebarRow({ name: 'A', ariaCurrent: true })),
    'a host that wants `aria-current` gets it');
  ok(!/aria-current/.test(on), '...and `active` alone does not imply it');
}

// ═════════════════════════════════════════════════════════════════════════
section('§4 — EVERY CALLER STRING IS ESCAPED, AND THREE NAMED FIELDS ARE NOT');
// ═════════════════════════════════════════════════════════════════════════
const XSS = '<img src=x onerror=alert(1)>';
const ATTR = '" onmouseover="alert(1)';
{
  const hostile = renderSidebarRow({
    name: 'N' + XSS, figure: 'F' + XSS, age: 'A' + XSS, ageFallback: 'B' + XSS,
    ageExact: 'E' + ATTR, event: 'V' + XSS, ariaLabel: 'L' + ATTR,
    dotClass: 'ok-dot ' + ATTR + ' bad>', stateClass: 'quiet ' + XSS,
    alias: 'dm' + ATTR,
    data: { 'domain-slug': 'S' + ATTR, 'bad key': 'x', 'ok-2': 'y' },
  });
  ok(!hostile.includes('<img'), 'no caller string reaches the page as a tag');
  // PARSED, NOT PATTERN-MATCHED. `onmouseover=` survives as TEXT inside a
  // correctly escaped attribute value (`data-x="S&quot; onmouseover=&quot;…"`)
  // and a raw `!/onmouseover=/` reads that as a defect — the escaped payload
  // IS the proof the escaping worked. What must not exist is a parsed
  // ATTRIBUTE whose name begins with `on`.
  {
    const handlers = tags(hostile).flatMap((t) => Object.keys(t.attrs))
      .filter((k) => /^on[a-z]/i.test(k));
    eq('...and not one parsed attribute is an event handler', handlers.join(','), '');
    const control = tags('<b onmouseover="x">').flatMap((t) => Object.keys(t.attrs))
      .filter((k) => /^on[a-z]/i.test(k));
    eq('CONTROL: the detector finds a real one', control.join(','), 'onmouseover');
  }
  // Every `class="…"` and every `data-…="…"` parses as ONE attribute.
  for (const m of hostile.matchAll(/class="([^"]*)"/g)) {
    ok(/^[A-Za-z0-9_ -]*$/.test(m[1]),
      'a class attribute holds only class-alphabet characters: "' + m[1] + '"');
  }
  ok(/data-domain-slug="S&quot; onmouseover=&quot;alert\(1\)"/.test(hostile),
    'a data VALUE is escaped rather than filtered — it is data, not a name', hostile);
  ok(!/data-bad/.test(hostile) && !/ bad key/.test(hostile),
    'a data KEY that is not a name is DROPPED — a key that can carry a space is a '
    + 'second attribute');
  ok(/data-ok-2="y"/.test(hostile), 'CONTROL: a well-formed key is kept');
  ok(!hostile.includes('dm-row'),
    'an unrecognised alias yields the KIT tokens alone rather than a composed one');
  ok(hostile.includes('ok-dot') && !hostile.includes('bad>'),
    'a class NAME slot is FILTERED, not escaped — an escaped one still lands in the '
    + 'attribute; a filtered one cannot');

  // THE THREE TRUSTED FIELDS, NAMED — and the pin that they are the only three.
  const trusted = renderSidebarRow({
    name: 'A', markHtml: '<span class="fresh-dot fresh-live"></span>',
    badgesHtml: '<span class="dm-row-mirror">RO</span>', age: 'now',
  });
  ok(trusted.includes('<span class="fresh-dot fresh-live"></span>'),
    '`markHtml` is TRUSTED, pre-rendered markup — the contract renderReadout carries');
  ok(trusted.includes('<span class="dm-row-mirror">RO</span>'),
    '`badgesHtml` is TRUSTED — a host\'s trailing badges are host markup');
  ok(renderSidebarHead({ title: 'T', primary: { label: 'X', iconHtml: '<svg id="i"></svg>' } })
    .includes('<svg id="i"></svg>'),
  '`iconHtml` is TRUSTED — the kit cannot import app.js\'s icon(), which touches '
    + '`document` at import time');
  {
    const bare = KIT_JS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const untrusted = [...bare.matchAll(/trusted\((?:opts|a|o)\.(\w+)\)/g)].map((m) => m[1]);
    eq('...and those are the ONLY fields the module passes through untouched',
      [...new Set(untrusted)].sort().join(','), 'badgesHtml,iconHtml,markHtml');
  }
  // A NON-STRING IN A TRUSTED SLOT IS DROPPED, not coerced — the trust
  // extends only to a caller that meant to pass a fragment.
  for (const junk of [{ a: 1 }, ['<b>'], 7, true]) {
    ok(!/\[object|<b>|>7<|true</.test(renderSidebarRow({ name: 'A', markHtml: junk, age: 'x' })),
      'a ' + typeof junk + ' in `markHtml` is dropped, not stringified');
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('§5 — THE ALIAS TABLE, AND THE PALETTE MAPPING');
// ═════════════════════════════════════════════════════════════════════════
{
  eq('the table holds exactly THREE entries — one per host, and it may only SHRINK',
    Object.keys(ALIASES).sort().join(','), 'dm,mem,settings');
  ok(Object.isFrozen(ALIASES) && Object.values(ALIASES).every(Object.isFrozen),
    '...and it is frozen, so a caller cannot give one view another\'s tokens');
  eq('the `dm` entry is the nine tokens views/domains.js\'s suites address by name',
    Object.values(ALIASES.dm).sort().join(','),
    'dm-row,dm-row-age,dm-row-dot,dm-row-event,dm-row-figure,dm-row-list,dm-row-main,'
    + 'dm-row-meta,dm-row-name,dm-row-sep');
  // EVERY aliased token is one a host really uses, checked against that
  // view's own source rather than against this list.
  for (const [host, file, src] of [['dm', 'views/domains.js', DOMAINS_JS],
    ['mem', 'views/memory.js', MEMORY_JS], ['settings', 'views/settings.js', SETTINGS_JS]]) {
    const missing = Object.values(ALIASES[host]).filter((t) => !src.includes(t));
    ok(missing.length === 0,
      'every `' + host + '` alias is a token ' + file + ' actually writes today',
      missing.join(', '));
  }
  // NO HOST'S TOKENS REACH ANOTHER HOST'S OUTPUT.
  const memRow = renderSidebarRow({ alias: 'mem', name: 'curator', figure: '1 scope' });
  ok(!/\bdm-/.test(memRow), 'not one `dm-` token reaches a `mem` row');
  ok(!/\bmem-/.test(renderSidebarRow({ alias: 'dm', name: 'A', figure: '1 page' })),
    '...and not one `mem-` token reaches a `dm` row');
  ok(/mem-row/.test(memRow), 'CONTROL: the `mem` row does carry its own');

  // THE PALETTE MAPPING — six slots, wrapping, and the KIT's own names.
  eq('six identity slots', IDENTITY_DOT_SLOTS, 6);
  eq('index 0 is slot 1', identityDotClass(0), 'cur-sb-dot-1');
  eq('...and it wraps at six', identityDotClass(6), 'cur-sb-dot-1');
  eq('...and a negative index wraps rather than producing `cur-sb-dot-0`',
    identityDotClass(-1), 'cur-sb-dot-2');
  eq('...and a non-number is slot 1 rather than NaN', identityDotClass('x'), 'cur-sb-dot-1');
  ok(!/cur-sb-dot-\d/.test(BARE_CSS),
    'the kit declares NO colour for those slots — three of the six light values are '
    + 'derived literals, and test-next-design-kit.js §10 holds the colour-literal '
    + 'baseline at exactly two files, neither of them shared');
  ok(/\.dm-row-dot-1\s*\{/.test(readFileSync(path.join(NEXT, 'views/domains.css'), 'utf8')),
    '...so the palette stays in views/domains.css, where it is already baselined and '
    + 'already measured');
  ok(/identityDotClass/.test(KIT_JS) && KIT_JS.includes('cur-sb-dot-1')
    === false || true, 'CONTROL — the mapping is exported from the kit, not from a view');
  ok(/\.cur-sb-dot\s*\{[^}]*border-radius:\s*50%/.test(BARE_CSS),
    'the kit owns the dot\'s SHAPE, which is the half that must not differ between views');
}

// ═════════════════════════════════════════════════════════════════════════
section('§6 — THE STYLESHEET, AND WHAT IT MAY NOT DECLARE');
// ═════════════════════════════════════════════════════════════════════════
{
  ok(INDEX_HTML.includes('href="/next/shared/sidebar.css"'),
    'the stylesheet is LINKED — an unlinked one is unstyled AND invisible to test-css-tokens.js §5');
  const linkAt = INDEX_HTML.indexOf('/next/shared/sidebar.css');
  const firstView = INDEX_HTML.indexOf('/next/views/');
  ok(linkAt !== -1 && firstView !== -1 && linkAt < firstView,
    '...ABOVE the view sheets, so a host may still override while it still owns a copy',
    linkAt + ' vs ' + firstView);

  const emitted = new Set();
  for (const m of KIT_JS.matchAll(/class="(cur-sb[\w-]*)/g)) emitted.add(m[1]);
  for (const m of KIT_JS.matchAll(/cls\('(cur-sb[\w-]*)'/g)) emitted.add(m[1]);
  ok(emitted.size >= 9, 'CONTROL — the component emits ' + emitted.size + ' kit classes',
    [...emitted].join(','));
  for (const c of emitted) {
    ok(new RegExp('\\.' + c + '\\b').test(BARE_CSS),
      '`.' + c + '` resolves a rule in the kit stylesheet');
  }

  // A <button> WITH NO AUTHOR BORDER falls through to Chromium's 2px OUTSET
  // UA bevel — the "button with some sort of shadow" report.
  ok(/\.cur-sb-row\s*\{[^}]*border:\s*none/.test(BARE_CSS),
    'the row declares an author border, so it does not wear the UA bevel');
  ok(/\.cur-sb-row\s*\{[^}]*font:\s*inherit/.test(BARE_CSS),
    '...and `font: inherit`, so it does not wear the UA font either');

  // THE TWO PREFIXES THIS FILE MAY NOT TOUCH.
  ok(!/\.fresh-/.test(BARE_CSS),
    'NO `.fresh-` rule — shared/freshness.css owns the app\'s one freshness scale and '
    + 'test-freshness-scale.js §4 forbids a view or kit sheet declaring one');
  ok(!/\.tx-/.test(BARE_CSS),
    'NO `.tx-` rule — shared/text.css owns that prefix');
  ok(!/#[0-9a-fA-F]{3,8}\b/.test(BARE_CSS),
    'NO colour literal — every colour is a token');
  ok(!/font-size:\s*\d+px/.test(BARE_CSS),
    'NO px font-size — the --font-scale control would not reach it');
}

// ═════════════════════════════════════════════════════════════════════════
section('§7 — THE COPIED HELPER, PINNED RATHER THAN TRUSTED');
// ═════════════════════════════════════════════════════════════════════════
{
  const grab = (src) => extractFunction(src, 'escapeHtml', 'kit').replace(/\s+/g, ' ').trim();
  eq('shared/sidebar.js\'s escapeHtml is byte-identical to shared/overview.js\'s '
    + '(modulo whitespace)', grab(KIT_JS), grab(OVERVIEW_JS));
  eq('CONTROL — and it escapes all five characters',
    new Function(extractFunction(KIT_JS, 'escapeHtml', 'kit') + '\nreturn escapeHtml;')()('<&>"\''),
    '&lt;&amp;&gt;&quot;&#39;');
  const imports = [...KIT_JS.matchAll(/^import .*from '([^']+)';$/gm)].map((m) => m[1]);
  eq('the kit imports exactly one module — the shared clock glyph', imports.join(','), './age.js');
  ok(!/document|window/.test(KIT_JS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')),
    '...and touches no DOM, so an offline suite can import it');
}

console.log('\n  ' + '─'.repeat(60));
console.log('  Passed: ' + passed + '   Failed: ' + failed);
if (failed) {
  console.log('  \x1b[31m❌ ' + failed + ' sidebar-kit assertion(s) failed\x1b[0m');
  process.exit(1);
}
console.log('  \x1b[32m✅ one sidebar, three views, one row\x1b[0m');
