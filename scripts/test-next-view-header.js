/**
 * test-next-view-header.js — OFFLINE suite for renderViewHeader in
 * src/public/next/shared/text.js, plus the four views that adopt it.
 *
 * No network, no API key, no server, no browser, no spend.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────
 *
 * Every view in /next painted a paragraph of static prose directly under its
 * <h1>. The maintainer reported it repeatedly — "text floating around",
 * "truly bad UX".
 *
 * v3.20.0 ATTEMPTED THIS AND FAILED, and the failure is why this suite is
 * shaped the way it is. That release built renderDescription and adopted it in
 * these very headers: the wording changed, the position did not. On Domains a
 * generated sentence became a static one, in the same slot, still a paragraph
 * under a title. THE CONTAINER WAS THE DEFECT, NOT THE WORDING.
 *
 * So the guard cannot be "does the copy read better". It has to be: can the
 * component even express the defect, and do the adopted views still go through
 * it. Both are asserted below, and both are mutation-proven.
 *
 * ── ENFORCED ────────────────────────────────────────────────────────────
 *
 *  §2  STRUCTURAL. renderViewHeader's output carries no <p> and no prose
 *      container outside the info panel, over an adversarial input matrix —
 *      including prose smuggled through the one caller-supplied HTML slot,
 *      which is DROPPED rather than rendered.
 *  §3  THE PANEL IS CLOSED ON FIRST PAINT. `hidden` is present on the panel
 *      in every output, and text.css states `display: none` for it explicitly
 *      so no later cascade can reveal it.
 *  §4  THE AFFORDANCE IS A REAL CONTROL: a <button type="button"> with an
 *      accessible name, aria-expanded="false", and aria-controls naming a
 *      panel id that actually exists in the same string.
 *  §5  ABSENT IS NOT ZERO, inherited from the rest of text.js: no info means
 *      no button AND no panel, not an empty one.
 *  §6  ESCAPING on every interpolated value; `infoHtml` is opt-in only.
 *  §7  TWO DENSITIES: the sidebar variant emits a <div> title, never a second
 *      <h1> on a screen that already has one.
 *  §8  ADOPTION, per view, at a NAMED SITE — because a count stays green while
 *      any single site regresses. This is the v3.20.0 lesson: reverting one
 *      call site to a raw div left that release's suite green at 98/0.
 *  §9  NO PROSE BETWEEN THE HEADER AND THE BODY in any adopted view: the
 *      retired classes do not reappear where the paragraph used to be.
 *  §10 A WARNING IS NEVER BEHIND THE MARK. Domains' read-only-mirror notice
 *      names data loss ("overwritten on the next Pull"), so it must be a
 *      renderStatus box in the body and must NOT appear in the header's info.
 *  §11 CSS HYGIENE: no px font-size in the new rules (--font-scale would stop
 *      reaching them), no colour literal, and no --text-3 (4.27 dark / 4.14
 *      light, under the 4.5 AA floor).
 *  §12 POSITIVE CONTROLS, including one for ok()'s own argument order —
 *      v3.18.0 records this repo's two suites disagreeing about it, and a
 *      reversed signature makes every literal assertion pass unconditionally.
 *
 * ── NOT ENFORCED, stated rather than implied away ───────────────────────
 *
 *  • The actions slot's prose filter is NARROW BY CONSTRUCTION. It matches a
 *    <p> and four known prose class names. A bare <div> of prose passed as
 *    `actionsHtml` renders. It is a floor, not a proof.
 *  • §8/§9 are SOURCE scans. The view modules cannot be imported in Node —
 *    they reach app.js, which touches `document` at module scope — so nothing
 *    here executes a view's real render. What IS executed is the component
 *    itself, on every branch.
 *  • NOTHING HERE MEASURES RENDERING, LAYOUT OR CONTRAST. A green run does
 *    not mean no paragraph is on screen; only looking does. The contrast
 *    figures quoted in §11's comments were measured in a real browser and are
 *    recorded, not re-derived here.
 *  • The delegated click/Escape behaviour is asserted as MARKUP (the button
 *    carries the attributes the handler keys on) and as SOURCE, not as
 *    executed DOM: there is no DOM in this process. The keyboard path was
 *    driven in a real browser instead.
 */

import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  renderViewHeader, renderStatus, renderDescription,
} from '../src/public/next/shared/text.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const NEXT = join(HERE, '..', 'src', 'public', 'next');
const read = (rel) => readFileSync(join(NEXT, rel), 'utf8');

let passed = 0, failed = 0;
/** ok(label, cond, detail) — label FIRST. §12 proves that order is real. */
function ok(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? `\n      ${String(detail).slice(0, 220)}` : ''}`); }
}
function section(t) { console.log(`\n${t}\n${'-'.repeat(60)}`); }

/**
 * Strip line and block comments. Every source scan below runs on the stripped
 * text: a commented-out call site satisfies a naive regex, which is how a
 * guard comes to certify code that no longer runs.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** The header element only — everything the user sees without clicking. */
function headerVisible(html) {
  return html.replace(/<div class="tx-vh-panel"[\s\S]*?<\/div>/g, '');
}

const TITLE = 'Ingest';
const PROSE = 'A domain is one compounding wiki — a subject you read about often.';

// ═══════════════════════════════════════════════════════════════════════════
section('§1  THE SIGNATURE HAS NO PROSE SLOT — the defect is inexpressible');
// ═══════════════════════════════════════════════════════════════════════════
// The whole claim of this release, asserted against the source of the
// function rather than against a rendered string: if a `description` /
// `subtitle` / `lede` / `body` field existed, an author could put a paragraph
// back under the title through the sanctioned API and every output assertion
// below would still pass.
{
  const src = stripComments(read('shared/text.js'));
  const fn = src.slice(src.indexOf('export function renderViewHeader'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
  for (const banned of ['o.description', 'o.subtitle', 'o.lede', 'o.body', 'o.hint', 'o.note']) {
    ok(`renderViewHeader reads no \`${banned}\` — there is no sanctioned way to add a subtitle`,
      !body.includes(banned), body.slice(0, 200));
  }
  ok('the ONE prose field is `info`, and it is read',
    body.includes('str(o.info)'), body.slice(0, 200));
  ok('...and `info` is only ever emitted inside the tx-vh-panel element',
    /class="tx-vh-panel"[\s\S]*?escapeHtml\(info\)|class="tx-vh-panel"[\s\S]*?\? info :/.test(body),
    body.slice(0, 400));
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2  STRUCTURAL — no prose in the visible header, over a matrix');
// ═══════════════════════════════════════════════════════════════════════════
{
  const matrix = [
    ['bare', { title: TITLE }],
    ['eyebrow', { eyebrow: 'the way material gets in', title: TITLE }],
    ['info', { eyebrow: 'x', title: TITLE, info: PROSE }],
    ['info+html', { title: TITLE, info: '<strong>Two jobs</strong> here.', infoHtml: true }],
    ['actions', { title: TITLE, info: PROSE, actionsHtml: '<button id="a">Rename</button>' }],
    ['sidebar', { variant: 'sidebar', title: TITLE, info: PROSE }],
  ];
  for (const [name, args] of matrix) {
    const html = renderViewHeader(args);
    const vis = headerVisible(html);
    ok(`[${name}] the visible header contains no <p>`, !/<p[\s>]/i.test(vis), vis);
    ok(`[${name}] ...and none of the retired prose classes`,
      !/\b(?:tx-desc|view-body|sidebar-hint|settings-hint-text|dm-scope-desc)\b/.test(vis), vis);
  }
  // The prose is not merely absent from the visible header — it is present in
  // the string, inside the panel. Absence alone would also be satisfied by a
  // component that silently dropped the explanation.
  const withInfo = renderViewHeader({ title: TITLE, info: PROSE });
  ok('the explanation is NOT dropped — it survives, inside the panel',
    withInfo.includes(PROSE.replace(/'/g, '&#39;')) || withInfo.includes(PROSE), withInfo);
  ok('...and it appears AFTER the title row, not before it',
    withInfo.indexOf('tx-vh-panel') > withInfo.indexOf('tx-vh-row'), withInfo);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2b  THE ONE CALLER-SUPPLIED HTML SLOT REFUSES PROSE');
// ═══════════════════════════════════════════════════════════════════════════
// `actionsHtml` is the only route by which the paragraph could re-enter the
// header, so the wrong call produces the right output: prose is DROPPED.
{
  const proseShapes = [
    ['a <p>', '<p>A domain is one compounding wiki.</p>'],
    ['a tx-desc div', '<div class="tx-desc">A domain is one compounding wiki.</div>'],
    ['a view-body div', '<div class="view-body">A domain is one compounding wiki.</div>'],
    ['a sidebar-hint div', '<div class="sidebar-hint">One file at a time.</div>'],
    ['a settings-hint-text span', '<span class="settings-hint-text">Default 50,000 tokens.</span>'],
    ['a button FOLLOWED by a <p>', '<button id="r">Rename</button><p>and some prose</p>'],
  ];
  for (const [name, actionsHtml] of proseShapes) {
    const html = renderViewHeader({ title: TITLE, actionsHtml });
    ok(`actionsHtml carrying ${name} is DROPPED, not rendered`,
      !html.includes('compounding wiki') && !html.includes('some prose')
      && !html.includes('One file at a time') && !html.includes('50,000'), html);
  }
  // ...and the slot still WORKS, or "drop everything" would pass the above.
  const real = renderViewHeader({
    title: 'Research',
    actionsHtml: '<button class="btn btn-primary" id="dm-ask-btn">Ask this domain</button>',
  });
  ok('a genuine control still renders — the filter is not "drop everything"',
    real.includes('dm-ask-btn') && real.includes('Ask this domain'), real);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3  THE PANEL IS CLOSED ON FIRST PAINT');
// ═══════════════════════════════════════════════════════════════════════════
{
  const html = renderViewHeader({ title: TITLE, info: PROSE });
  ok('the panel element carries `hidden`', /<div class="tx-vh-panel"[^>]*\shidden>/.test(html), html);
  ok('the panel is NOT rendered open', !/tx-vh-panel[^>]*\sopen/.test(html), html);
  // There is no `open: true` escape hatch, deliberately: a header that opens
  // its own panel is a paragraph under a title with extra steps.
  const forced = renderViewHeader({ title: TITLE, info: PROSE, open: true });
  ok('there is no `open` parameter — passing one cannot reveal the panel',
    /<div class="tx-vh-panel"[^>]*\shidden>/.test(forced), forced);

  const css = read('shared/text.css');
  ok('text.css states `display: none` for the hidden panel explicitly',
    /\.tx-vh-panel\[hidden\]\s*\{\s*display:\s*none;\s*\}/.test(css));
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4  THE AFFORDANCE IS A REAL CONTROL, NOT A TOOLTIP');
// ═══════════════════════════════════════════════════════════════════════════
// v3.20.0 counted 11 pieces of information in this app carried ONLY by
// `title=` on a non-focusable span — invisible to keyboard and to touch.
{
  const html = renderViewHeader({ title: 'Shared Brain', info: PROSE });
  ok('it is a <button>, and typed so it cannot submit a form',
    /<button type="button" class="tx-vh-info"/.test(html), html);
  ok('it has an accessible name', /aria-label="About Shared Brain"/.test(html), html);
  ok('it reports collapsed state', /aria-expanded="false"/.test(html), html);

  const controls = (html.match(/aria-controls="([^"]+)"/) || [])[1];
  ok('aria-controls names a panel that EXISTS in the same string',
    !!controls && html.includes(`<div class="tx-vh-panel" id="${controls}"`), controls);
  const dataId = (html.match(/data-tx-info="([^"]+)"/) || [])[1];
  ok('...and the delegated handler keys on the SAME id (data-tx-info)',
    dataId === controls, `${dataId} vs ${controls}`);
  ok('the button id is distinct from the panel id — two elements, two ids',
    /id="tx-vh-info-shared-brain-btn"/.test(html) && /id="tx-vh-info-shared-brain"/.test(html), html);

  // The glyph is decorative; the name is on the button.
  ok('the glyph is aria-hidden — the accessible name is not doubled',
    /<svg[^>]*aria-hidden="true"/.test(html), html);

  // Two headers on one screen must not collide on ids.
  const a = renderViewHeader({ title: 'Ingest', info: PROSE });
  const b = renderViewHeader({ title: 'Ingest', info: PROSE, infoId: 'tx-vh-info-ingest-sidebar' });
  // The PANEL id, not the button's — `id="…-btn"` appears first in the string.
  const panelId = (h) => (h.match(/<div class="tx-vh-panel" id="([^"]+)"/) || [])[1];
  const idA = panelId(a);
  const idB = panelId(b);
  ok('an explicit infoId overrides the derived one, so two headers can coexist',
    idA !== idB && idB === 'tx-vh-info-ingest-sidebar', `${idA} / ${idB}`);

  // The behaviour lives in ONE delegated pair, installed once.
  const src = stripComments(read('shared/text.js'));
  ok('Escape is handled — not left to a component that has no dismissal',
    /addEventListener\('keydown'[\s\S]{0,400}e\.key !== 'Escape'/.test(src), 'no Escape handler');
  ok('...and Escape returns focus to the control, never to <body>',
    /last\.focus\(\)/.test(src), 'no focus restore');
  ok('the listeners are installed ONCE, not per render',
    /if \(txInfoWired \|\| typeof document === 'undefined'\) return;/.test(src));
  ok('...and guarded on `document`, so this module still imports in Node',
    src.includes("typeof document === 'undefined'"));
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5  ABSENT IS NOT ZERO');
// ═══════════════════════════════════════════════════════════════════════════
{
  const bare = renderViewHeader({ title: TITLE });
  ok('no info → NO button', !bare.includes('tx-vh-info'), bare);
  ok('no info → NO panel, not an empty one', !bare.includes('tx-vh-panel'), bare);
  ok('no eyebrow → no empty eyebrow div', !bare.includes('tx-vh-eyebrow'), bare);
  ok('no actions → no empty actions div', !bare.includes('tx-vh-actions'), bare);

  ok('whitespace-only info renders no affordance',
    !renderViewHeader({ title: TITLE, info: '   ' }).includes('tx-vh-info'));
  ok('no title → empty string, not a headless header', renderViewHeader({ title: '  ' }) === '');
  for (const bad of [null, undefined, 'x', 42, []]) {
    ok(`a ${JSON.stringify(bad)} argument returns '' rather than throwing`,
      renderViewHeader(bad) === '');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('§6  ESCAPING');
// ═══════════════════════════════════════════════════════════════════════════
{
  const X = '<img src=x onerror=alert(1)>';
  const html = renderViewHeader({ eyebrow: X, title: X, info: X, infoId: X, actionsHtml: null });
  ok('no raw <img> survives anywhere in the output', !html.includes('<img'), html);
  ok('...the title is escaped', html.includes('&lt;img'), html);
  // Precise, because the loose version was a FALSE POSITIVE: the escaped text
  // legitimately CONTAINS the word onerror, so scanning past the closing quote
  // reported a breakout that had not happened. What matters is that no
  // attribute VALUE carries a raw < or a raw quote.
  {
    const attrs = [...html.matchAll(/(?:aria-label|title|id|aria-controls|data-tx-info)="([^"]*)"/g)]
      .map((m) => m[1]);
    ok('...and no attribute value carries a raw < — nothing can break out',
      attrs.length > 0 && attrs.every((v) => !v.includes('<')), attrs.join(' | '));
  }
  ok('...and an attacker-shaped infoId cannot break out of id=""',
    !/id="[^"]*"[^ >]/.test(html), html);

  const raw = renderViewHeader({ title: 'T', info: '<strong>ok</strong>', infoHtml: true });
  ok('infoHtml: true is honoured (opt-in only)', raw.includes('<strong>ok</strong>'), raw);
  const esc = renderViewHeader({ title: 'T', info: '<strong>ok</strong>' });
  ok('...and is NOT the default', esc.includes('&lt;strong&gt;'), esc);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§7  TWO DENSITIES, ONE VOCABULARY');
// ═══════════════════════════════════════════════════════════════════════════
{
  const main = renderViewHeader({ title: TITLE, info: PROSE });
  const side = renderViewHeader({ variant: 'sidebar', title: TITLE, info: PROSE });
  ok('the default renders an <h1>', /<h1 class="view-title tx-vh-title">/.test(main), main);
  ok('the sidebar renders a <div>, never a second <h1> on one screen',
    !side.includes('<h1') && /<div class="sidebar-title tx-vh-title">/.test(side), side);
  ok('...and both still carry the SAME affordance — one vocabulary',
    side.includes('tx-vh-info') && main.includes('tx-vh-info'));
  ok('...and the same closed-by-default panel',
    /<div class="tx-vh-panel"[^>]*\shidden>/.test(side), side);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§8  ADOPTION — per view, at a NAMED site');
// ═══════════════════════════════════════════════════════════════════════════
// A COUNT alone stays green while any single site regresses. That is not a
// hypothetical: v3.20.0 reverted one memory.js call site to a raw div and its
// suite stayed green at 98/0.
const VIEWS = {
  'domains.js': stripComments(read('views/domains.js')),
  'ingest.js': stripComments(read('views/ingest.js')),
  'shared.js': stripComments(read('views/shared.js')),
  'settings.js': stripComments(read('views/settings.js')),
};
for (const [name, src] of Object.entries(VIEWS)) {
  ok(`${name} imports renderViewHeader from the ONE shared module`,
    /import \{[^}]*\brenderViewHeader\b[^}]*\} from '\.\.\/shared\/text\.js';/s.test(src));
  ok(`${name} does NOT declare a local copy of it`,
    !/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+renderViewHeader\b/.test(src)
    && !/(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+renderViewHeader\s*=/.test(src));
  const calls = (src.match(/renderViewHeader\(/g) || []).length;
  ok(`${name} actually CALLS it (${calls} sites) — an unused import is an unadopted component`,
    calls > 0, `${calls} call sites`);
}
// The named sites.
ok('domains.js: ONE header builder serves all four list branches',
  /function domainsHeader\(\)[\s\S]{0,300}renderViewHeader\(\{ eyebrow: 'your brain', title: 'Domains', info: DOMAIN_BLURB \}\)/
    .test(VIEWS['domains.js']));
ok('domains.js: the four list branches call it, and none hand-rolls the header',
  (VIEWS['domains.js'].match(/domainsHeader\(\)/g) || []).length >= 5
  && !/eyebrow\('your brain'\) \+ '<h1/.test(VIEWS['domains.js']));
ok('domains.js: the DETAIL header is the component, with the controls in the actions slot',
  /renderViewHeader\(\{[\s\S]{0,400}actionsHtml:[\s\S]{0,400}dm-ask-btn/.test(VIEWS['domains.js']));
ok('shared.js: the centre header is the component',
  /renderViewHeader\(\{[\s\S]{0,120}title: 'Shared Brain',/.test(VIEWS['shared.js']));
ok('ingest.js: BOTH blocks the report named — centre and sidebar',
  /renderViewHeader\(\{ eyebrow: 'the way material gets in', title: 'Ingest' \}\)/.test(VIEWS['ingest.js'])
  && /renderViewHeader\(\{ variant: 'sidebar', title: 'Ingest', info: hint/.test(VIEWS['ingest.js']));
ok('settings.js: renderMain builds the header, per-section, from SECTION_INFO',
  /const info = SECTION_INFO\[state\.section\];[\s\S]{0,300}renderViewHeader\(\{/.test(VIEWS['settings.js']));
ok('settings.js: `general` has NO entry, so that section renders no mark',
  /const SECTION_INFO = \{[\s\S]*?\n\};/.test(VIEWS['settings.js'])
  && !/^\s{2}general:/m.test(VIEWS['settings.js'].match(/const SECTION_INFO = \{[\s\S]*?\n\};/)[0]));

// ═══════════════════════════════════════════════════════════════════════════
section('§9  NO PROSE WHERE THE PARAGRAPH USED TO BE');
// ═══════════════════════════════════════════════════════════════════════════
// The retired containers, per view. Named rather than generic: this is the
// exact position the maintainer reported, four times.
ok('shared.js emits no .view-body anywhere', !/class="view-body"/.test(VIEWS['shared.js']));
ok('shared.js: the sidebar label was CUT, not restyled',
  !/Cohorts this install writes to/.test(VIEWS['shared.js']));
ok('settings.js emits no .view-body anywhere (5 paragraphs, 0 left)',
  !/class="view-body"/.test(VIEWS['settings.js']));
ok('ingest.js: the deleted drop-zone sentence has not returned',
  !/Drop in a/.test(VIEWS['ingest.js']));
ok('ingest.js: .view-body SURVIVES only as the loading-placeholder role it shares with loading-gate.js',
  /class="view-body">Starting batch/.test(VIEWS['ingest.js']));
ok('domains.js: the blurb reaches the fold, never renderDescription',
  !/renderDescription\(DOMAIN_BLURB\)/.test(VIEWS['domains.js'])
  && /info: DOMAIN_BLURB/.test(VIEWS['domains.js']));
ok('domains.js: the hand-rolled title row is GONE, not kept beside the component',
  !/dm-title-row/.test(VIEWS['domains.js']));
ok('domains.css: its layout rule went with it, so there is no second copy to drift',
  !/^\.dm-title-row/m.test(stripComments(read('views/domains.css'))));

// ── §9b  THE CLASS GUARD, not one named string ────────────────────────────
// M1 in the mutation table put `renderDescription(DOMAIN_BLURB)` back above the
// Domains detail header, and §9's named assertion caught it — but only because
// it names that constant. A DIFFERENT paragraph would have walked past.
//
// So this is the generic form, over EVERY view in the tree rather than the four
// adopted here: nothing that renders prose may sit adjacent to a header call.
// A fifth view adopting renderViewHeader later inherits the guard without
// anyone remembering to extend a list — which is how the last one went blind.
{
  // BOTH DIRECTIONS. The first draft only looked AFTER the header call, and M1
  // in the mutation table walks straight past it — inserting the paragraph
  // ABOVE the header is where it fits syntactically, and prose above a title is
  // the same defect as prose below one. Caught by running the mutation, not by
  // re-reading the regex.
  const PROSE_AFTER_HEADER =
    /renderViewHeader\(([\s\S]{0,600}?)\)\s*\+\s*(?:renderDescription\(|'<p|'<div class="(?:tx-desc|view-body|sidebar-hint)")/;
  const PROSE_BEFORE_HEADER =
    /(?:renderDescription\([^;]{0,200}?\)|'<p[^']{0,200}?'|'<div class="(?:tx-desc|view-body|sidebar-hint)[^']{0,200}?')\s*\+\s*(?:\n\s*)?renderViewHeader\(/;
  const PROSE_NEXT_TO_HEADER = {
    test: (t) => PROSE_AFTER_HEADER.test(t) || PROSE_BEFORE_HEADER.test(t),
  };
  const viewFiles = readdirSync(join(NEXT, 'views')).filter((f) => f.endsWith('.js'));
  ok('every view file was enumerated FROM DISK, not from a hardcoded list',
    viewFiles.length >= 8, `${viewFiles.length} files`);
  for (const f of viewFiles) {
    const src = stripComments(readFileSync(join(NEXT, 'views', f), 'utf8'));
    if (!src.includes('renderViewHeader(')) continue;
    const hit = src.match(PROSE_AFTER_HEADER) || src.match(PROSE_BEFORE_HEADER);
    ok(`${f}: no prose is concatenated onto the view header, above it or below it`,
      !hit, hit && hit[0].slice(-160));
  }
  // CONTROL: the detector fires on the exact shape it forbids, in both forms.
  ok('CONTROL: the adjacency detector FIRES on a renderDescription after a header',
    PROSE_NEXT_TO_HEADER.test("renderViewHeader({ title: 'X' }) +\n renderDescription(BLURB) +"));
  ok('CONTROL: ...and on a raw prose div after a header',
    PROSE_NEXT_TO_HEADER.test("renderViewHeader({ title: 'X' }) +\n '<div class=\"tx-desc\">hi</div>' +"));
  ok('CONTROL: ...and on a renderDescription placed ABOVE the header',
    PROSE_NEXT_TO_HEADER.test("renderDescription(BLURB) +\n    renderViewHeader({ title: 'X' })"));
  ok('CONTROL: ...and does NOT fire on a header followed by a status box',
    !PROSE_NEXT_TO_HEADER.test("renderViewHeader({ title: 'X' }) +\n renderStatus({ title: 'y' }) +"));
  ok('CONTROL: ...nor on a status box placed above the header',
    !PROSE_NEXT_TO_HEADER.test("renderStatus({ title: 'y' }) +\n renderViewHeader({ title: 'X' })"));
}

// ═══════════════════════════════════════════════════════════════════════════
section('§10  A WARNING IS NEVER BEHIND THE MARK');
// ═══════════════════════════════════════════════════════════════════════════
// v3.16.1: a warning behind a click is not a warning. Domains' read-only
// mirror notice names data loss, so it must be in the body, unfolded.
{
  const d = VIEWS['domains.js'];
  ok('the mirror notice is SPLIT: an explanation and a warning, two constants',
    /const MIRROR_INFO = /.test(d) && /const MIRROR_WARNING = /.test(d));
  ok('the DATA-LOSS half is the warning half',
    /const MIRROR_WARNING = '[^']*overwritten on the next Pull/.test(d));
  ok('...and it renders through renderStatus, in the body',
    /renderStatus\(\{ state: 'attention', title: '[^']+', detail: MIRROR_WARNING \}\)/.test(d));
  ok('...and is NOT what the header hides',
    /info: readonly \? MIRROR_INFO : DOMAIN_BLURB/.test(d) && !/info: MIRROR_WARNING/.test(d));
  ok('the header component has NO tone/state/warning field, so it cannot host one',
    !/o\.warningTone|o\.state|o\.tone/.test(
      (() => {
        const s = stripComments(read('shared/text.js'));
        const f = s.slice(s.indexOf('export function renderViewHeader'));
        return f.slice(0, f.indexOf('\n}\n') + 3);
      })()));
  // Settings' money/timing banners stayed in the body too.
  ok('settings.js keeps the fallback-model banner unfolded (it is a billing change)',
    /renderFallbackBanner\(k\.fallback\)/.test(VIEWS['settings.js']));
  ok('settings.js keeps every cross-write banner unfolded',
    (VIEWS['settings.js'].match(/renderCrossWriteBanner\(/g) || []).length >= 2);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§11  CSS HYGIENE');
// ═══════════════════════════════════════════════════════════════════════════
{
  const css = read('shared/text.css');
  const vh = css.slice(css.indexOf('/* ── 6. View header'));
  ok('the view-header rules exist in text.css', vh.length > 200);
  // --font-scale multiplies the --text-* ramp; a px font-size freezes at 1x.
  // v3.20.0 found 14 of those in chat.css alone, including .chat-answer.
  const pxSizes = [...vh.matchAll(/font-size:\s*([0-9.]+)px/g)].map((m) => m[0]);
  ok('no hardcoded px font-size — the text-size setting still reaches this header',
    pxSizes.length === 0, pxSizes.join(', '));
  const literals = [...vh.matchAll(/(?:color|background)\s*:\s*(#[0-9a-f]{3,8}|rgb)/gi)].map((m) => m[0]);
  ok('no colour literal — every value resolves to a token', literals.length === 0, literals.join(', '));
  // --text-3 measures 4.27 dark / 4.14 light against --surface, under the 4.5
  // AA floor, and 181 rules in /next already use it as a text colour.
  ok('no --text-3 — hierarchy is made with size, weight and family',
    !/var\(--text-3\)/.test(vh));
  ok('the panel and the glyph both use --text-2 (8.34 dark / 7.26 light)',
    /\.tx-vh-info \{[\s\S]*?color: var\(--text-2\);/.test(vh)
    && /\.tx-vh-panel \{[\s\S]*?color: var\(--text-2\);/.test(vh));
  ok('the panel is bordered — --surface-raised is BYTE-IDENTICAL to --surface in light',
    /\.tx-vh-panel \{[\s\S]*?border: 1px solid var\(--border\);/.test(vh));
  ok('reduced motion is honoured for the mark’s transition',
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.tx-vh-info \{ transition: none; \}/.test(vh));
  ok('text.css is <link>ed from index.html — the v3.9.1 styled-but-unlinked trap',
    /<link[^>]+href="\/next\/shared\/text\.css"/.test(read('index.html')));
}

// ═══════════════════════════════════════════════════════════════════════════
section('§12  POSITIVE CONTROLS — every detector above is shown to FIRE');
// ═══════════════════════════════════════════════════════════════════════════
// A detector that cannot go red is a comment.
{
  // ok()'s ARGUMENT ORDER. v3.18.0 records this repo's suites disagreeing
  // about it, and a reversed signature makes every literal assertion pass
  // unconditionally — caught there by mutation, not by review.
  //
  // It drives the REAL ok() — a private copy would prove nothing about the
  // function every other assertion uses — with console.log MUTED for the
  // duration. Muting is not cosmetic: run-tests.js fails a suite on any line
  // beginning with the cross glyph (run-tests.js:334), so a deliberate red
  // printed here would mark this whole suite FAILED while it reports 0
  // failures. That is the v3.3.0 shape — a suite classified by a STRING in its
  // own output rather than by its exit code.
  const before = { p: passed, f: failed };
  const realLog = console.log;
  console.log = () => {};
  try {
    ok('CONTROL-ORDER: a deliberately-false assertion', false);
  } finally {
    console.log = realLog;
  }
  const reallyFailed = failed === before.f + 1 && passed === before.p;
  failed = before.f; passed = before.p;          // un-count the deliberate red
  ok('CONTROL: ok() takes (label, cond) — a reversed signature would pass everything unconditionally',
    reallyFailed);

  // §2's <p> detector.
  ok('CONTROL: the <p> detector FIRES on a header that really carries one',
    /<p[\s>]/i.test(headerVisible('<header class="tx-vh"><h1>T</h1><p>prose</p></header>')));
  // §2b's actions filter, both directions.
  ok('CONTROL: the actions filter PASSES a control-only slot',
    renderViewHeader({ title: 'T', actionsHtml: '<button>Go</button>' }).includes('<button>Go</button>'));
  // §3's hidden detector.
  ok('CONTROL: the hidden-panel detector FIRES on an unhidden panel',
    !/<div class="tx-vh-panel"[^>]*\shidden>/.test('<div class="tx-vh-panel" id="x">p</div>'));
  // §8's adoption scan — a file that merely imports without calling.
  ok('CONTROL: the call-site count reports 0 for import-without-call',
    ("import { renderViewHeader } from '../shared/text.js';".match(/renderViewHeader\(/g) || []).length === 0);
  // §9's retired-class scan.
  ok('CONTROL: the .view-body scan FIRES on a file that has one',
    /class="view-body"/.test('x = \'<p class="view-body">hi</p>\';'));
  // stripComments — the reason every source scan runs on stripped text.
  ok('CONTROL: stripComments removes a commented-out call site',
    !/renderViewHeader\(/.test(stripComments('// renderViewHeader({ title: "x" })\nconst a = 1;')));
  ok('CONTROL: ...and leaves a real one',
    /renderViewHeader\(/.test(stripComments('const a = renderViewHeader({ title: "x" });')));
  // The sibling roles still work — this suite must not be green because the
  // module failed to load.
  ok('CONTROL: the module really loaded (a sibling role still renders)',
    renderStatus({ state: 'attention', title: 'x' }).includes('tx-status-attention')
    && renderDescription('hi').includes('tx-desc'));
}

console.log(`\n  Passed: ${passed}   Failed: ${failed}\n`);
if (failed === 0) console.log('All view-header offline assertions green');
process.exit(failed === 0 ? 0 : 1);
