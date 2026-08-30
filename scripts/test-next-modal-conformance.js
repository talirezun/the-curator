#!/usr/bin/env node
/**
 * test-next-modal-conformance.js — a CLASS invariant over every modal
 * surface in the /next tree.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 * A design-system conformance audit reported "five modal implementations,
 * none conforming": none at the system's `--radius-xl`, all five scrims at
 * 0.68 where the system specifies 0.72, and the confirm dialog and
 * chat-browse omitting `backdrop-filter` entirely.
 *
 * Three of those four claims survived measurement. The count is right (5),
 * the radius finding is right (4 of 5 were at --radius-lg; the fifth is not
 * a card), and the missing blur is right. THE SCRIM CLAIM IS WRONG, and the
 * correction is written into the assertions below rather than filed away:
 * the design system carries TWO scrims and they disagree.
 *
 *   components/feedback/Modal.jsx  rgba(5,5,10,0.72) + blur(6px), no light value
 *   ui_kits/app/primitives.jsx     rgba(5,5,10,.72)  + blur(6px)
 *   readme.md (frosted glass)      rgba(5,5,10,0.72) + blur(6px)
 *   The Curator App.dc.html        dark rgba(5,5,10,0.68) / light rgba(20,20,31,0.42)
 *
 * The last is the bundle's applied artifact for THIS app, and it is the
 * only one that specifies a LIGHT value — which is where the app had
 * actually drifted (0.42 on two surfaces, 0.5 on three). So 0.68 is not
 * drift, and dark pins the prototype's value.
 *
 * LIGHT DOES NOT: it pins 0.5, a deviation the browser forced. Measured
 * composited after cascade, a white --surface-overlay card against a 0.42
 * scrim is 2.80:1, under WCAG 1.4.11's 3:1; 0.5 gives 3.55. See §2 and
 * shell.css for the full figures. If the maintainer decides the bundle's
 * values are canonical regardless, shell.css's --modal-scrim is the single
 * line to change and §2's expected values here are the second.
 *
 * ── WHAT IS ENUMERATED, AND FROM WHERE ───────────────────────────────────
 * Never a hardcoded list. This repo has recorded that blind spot four times
 * (v3.14.0, v3.23.0, v3.24.0, and v3.25.0 where a checkbox count was six
 * reported / seven actual because one was built with document.createElement
 * and was invisible to a markup scan).
 *
 * So §1 walks EVERY .js file under src/public/next from disk and finds every
 * surface that declares itself a modal — `aria-modal="true"` — whether it is
 * written as a markup string or assembled with createElement/setAttribute.
 * It then resolves each one's CLASS and requires that class to be governed
 * by a rule in some /next stylesheet, also enumerated from disk. A sixth
 * modal added tomorrow, in any file, in either style, lands in this set.
 *
 * CSS COMMENTS ARE STRIPPED BEFORE ANY PARSING. v3.24.2's button scanner
 * did not strip them, and a prose comment sitting above a real rule made
 * the naive selector/body split read the comment as part of the selector —
 * hiding THREE of the FIVE bugs it was written to find. That false positive
 * is kept here as a POSITIVE CONTROL (§0): remove the strip and the control
 * goes red.
 *
 * ── NOT ENFORCED — read this before trusting a green run ─────────────────
 *  · CASCADE AND SPECIFICITY ARE NOT RESOLVED. "Some rule for this class
 *    declares border-radius: var(--radius-xl)" is weaker than "that
 *    declaration wins". The right check for a missing declaration, the
 *    wrong tool for an override fight. A later rule elsewhere could lose or
 *    win and this suite would not know.
 *  · RENDERED APPEARANCE IS NOT MEASURED. No offline suite in this repo
 *    measures real rendering. Contrast, composited scrim colour and actual
 *    blur were measured in a real browser and are recorded in the release
 *    notes; nothing here re-derives them.
 *  · A MODAL THAT DECLARES NO `aria-modal` IS INVISIBLE HERE. That is a
 *    deliberate trade: `aria-modal` is the thing that makes a surface claim
 *    modality, and a dialog that omits it has a bigger problem than its
 *    radius. §1c asserts the count so a REMOVAL is noticed, but a brand-new
 *    scrim-and-card with no aria-modal would not be found.
 *  · ACCESSIBILITY BEHAVIOUR IS NOT ASSERTED. Escape, focus trap, focus
 *    return and backdrop-dismissal semantics differ legitimately per
 *    surface (a destructive confirm must not become easier to dismiss by
 *    accident) and are owned by test-next-confirm-dialog.js and
 *    test-next-mcp-wizard.js. §4 records the reader's gap as data.
 *  · CLASS RESOLUTION IS TEXTUAL. A modal whose class is computed at
 *    runtime from a variable would resolve to nothing and §1b would fail
 *    loudly, which is the safe direction — but it is a failure to
 *    investigate, not a defect in the CSS.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NEXT = path.join(ROOT, 'src/public/next');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function section(t) { console.log(`\n${t}`); }

/** Blank /* … *\/ blocks to spaces of equal length: indices and line
 *  numbers survive, so nothing downstream needs to know it ran. */
function stripCssComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));
}

/** Every file with `ext` under `dir`, recursively, sorted for determinism. */
function walk(dir, ext) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, ext));
    else if (name.endsWith(ext)) out.push(p);
  }
  return out;
}

const jsFiles = walk(NEXT, '.js');
const cssFiles = walk(NEXT, '.css');
const rel = (p) => path.relative(NEXT, p);

// ═════════════════════════════════════════════════════════════════════════
section('§0  The comment strip, and the false positive it exists to prevent');
// ═════════════════════════════════════════════════════════════════════════
// v3.24.2's scanner read a prose comment as part of a selector and hid three
// of five real bugs. These controls fail the moment the strip is removed or
// weakened, so the guard cannot quietly go blind the way that one did.
{
  const probe = '/* .fake-card { border-radius: var(--radius-lg); } */\n.real-card { border-radius: var(--radius-xl); }';
  const stripped = stripCssComments(probe);
  ok(/\.fake-card/.test(probe) && !/\.fake-card/.test(stripped),
    'control: a selector written INSIDE a comment is present in the raw text and gone after the strip');
  ok(/\.real-card/.test(stripped) && /--radius-xl/.test(stripped),
    'control: …while the real rule beside it survives untouched');
  ok(stripped.length === probe.length,
    'control: …and length is preserved, so any index-based parsing stays correct');
  ok(/--radius-lg/.test(probe) && !/--radius-lg/.test(stripCssComments(probe)),
    'control: a TOKEN named only in a comment does not count as a declaration');
}

// ═════════════════════════════════════════════════════════════════════════
section('§1  Enumerate every modal surface in /next FROM DISK');
// ═════════════════════════════════════════════════════════════════════════
//
// Two producers, both scanned, because v3.25.0's checkbox count was wrong by
// exactly one for missing the second:
//   (a) markup strings — `role="dialog" aria-modal="true"` inside a template
//   (b) createElement + setAttribute('aria-modal', 'true')
// A surface found by either route is a modal for this suite's purposes.

const modals = [];          // { file, cls, how }
let ariaModalHits = 0;

for (const f of jsFiles) {
  const src = readFileSync(f, 'utf8');

  // (a) Markup-string form. The class and the aria-modal may appear in
  // either order and be separated by other attributes, so the window is
  // taken around the aria-modal occurrence rather than assuming a shape.
  for (const m of src.matchAll(/aria-modal\s*=\s*\\?["']true\\?["']/g)) {
    ariaModalHits++;
    const from = Math.max(0, m.index - 400);
    const window = src.slice(from, m.index + 400);
    // The nearest class= to the LEFT of the aria-modal is the element's own.
    const classMatches = [...window.slice(0, m.index - from).matchAll(/class\s*=\s*['"]([^'"]*)/g)];
    const raw = classMatches.length ? classMatches[classMatches.length - 1][1] : '';
    // Interpolated class lists (`'cfd-card' + (x ? ' y' : '')`) leave the
    // literal head, which is the identifying token. Take the first token.
    const cls = (raw.trim().split(/\s+/)[0] || '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (cls) modals.push({ file: rel(f), cls, how: 'markup' });
  }

  // (b) createElement form.
  for (const m of src.matchAll(/setAttribute\(\s*['"]aria-modal['"]\s*,\s*['"]true['"]\s*\)/g)) {
    ariaModalHits++;
    const from = Math.max(0, m.index - 800);
    const window = src.slice(from, m.index);
    const clsAssign = [...window.matchAll(/\.className\s*=\s*['"]([a-zA-Z0-9_-]+)/g)];
    const clsAdd = [...window.matchAll(/classList\.add\(\s*['"]([a-zA-Z0-9_-]+)/g)];
    const cls = clsAssign.length ? clsAssign[clsAssign.length - 1][1]
      : (clsAdd.length ? clsAdd[clsAdd.length - 1][1] : '');
    modals.push({ file: rel(f), cls, how: 'createElement' });
  }
}

console.log(`  → modal surfaces found: ${modals.length}`);
for (const m of modals) console.log(`      ${m.file}  .${m.cls}  (${m.how})`);

// §1a — anti-vacuity. A scanner that silently stopped matching would report
// zero non-conforming modals forever, which is exactly the shape of pass
// this repo keeps re-learning to distrust.
ok(jsFiles.length > 15, `anti-vacuity: ${jsFiles.length} /next .js files walked from disk`);
ok(cssFiles.length > 10, `anti-vacuity: ${cssFiles.length} /next .css files walked from disk`);
ok(ariaModalHits >= 5, `anti-vacuity: ${ariaModalHits} aria-modal="true" declarations found — a dead scanner reports 0`);
ok(modals.every((m) => m.cls),
  'every modal surface resolved to a class — an unresolved one is a failure to investigate, not a silent skip');

// §1b — the count. Five today: four centered dialogs and one drawer.
// This is deliberately an EQUALITY, not a floor: a sixth modal must come
// past this suite, and a deleted one must be noticed too.
const EXPECTED_MODAL_COUNT = 5;
ok(modals.length === EXPECTED_MODAL_COUNT,
  `exactly ${EXPECTED_MODAL_COUNT} modal surfaces in /next (got ${modals.length}) — a sixth must be conformed, not merely added`);

// §1c — and they are the five we think they are, by class.
const classes = modals.map((m) => m.cls).sort();
const EXPECTED = ['cfd-card', 'chat-browse', 'mcpw-card', 'reader-panel', 'sbw-card'];
ok(JSON.stringify(classes) === JSON.stringify(EXPECTED),
  `the five are ${EXPECTED.join(', ')} (got ${classes.join(', ')})`);

// ── Build a comment-free view of every CSS rule in /next ────────────────
// Declarations are collected per class token. Deliberately textual: see the
// NOT ENFORCED block — this answers "is it declared", never "does it win".
const allCss = cssFiles.map((f) => stripCssComments(readFileSync(f, 'utf8'))).join('\n');

// ── THE RULE SPLIT, AND THE BUG IT ALREADY HAD ──────────────────────────
// The first draft anchored each rule on the PREVIOUS closing brace,
// `/(^|\})([^{}]*)\{([^{}]*)\}/g`. That consumes the delimiter, so after
// matching `.a { … }` the engine had to find the NEXT `}` to start again —
// which is the closing brace of `.b`, making `.b` unmatchable. It silently
// skipped every ALTERNATE rule: 18 assertions went red naming real,
// correct CSS, and the tell was that the failures alternated rather than
// clustered by file. Caught by running it, not by reading it.
//
// Anchoring on nothing at all is correct here: `[^{}]*` cannot cross a
// brace, so from any position it consumes exactly the selector text since
// the last brace. Nested at-rules (`@media { .x { } }`) yield the INNER
// rule with the at-rule text in front of the selector, which is harmless
// for a "does this class declare X" question.
const RULE_RE = /([^{}]*)\{([^{}]*)\}/g;
/** Every declaration body belonging to a rule whose selector names `.cls`. */
function bodiesFor(cls, css = allCss) {
  const out = [];
  const re = new RegExp(RULE_RE.source, 'g');
  let m;
  while ((m = re.exec(css)) !== null) {
    const selector = m[1];
    if (new RegExp(`\\.${cls}(?![a-zA-Z0-9_-])`).test(selector)) out.push({ selector: selector.trim(), body: m[2] });
  }
  return out;
}

// POSITIVE CONTROL for the alternate-rule bug above. Three consecutive
// rules; the broken anchor found the 1st and 3rd and lost the 2nd. This
// probe is the shape that failed, kept so the regression cannot return
// quietly — a skipped rule reports "not declared" on correct CSS.
{
  const probe = '.a { color: red; }\n.b { color: green; }\n.c { color: blue; }';
  const found = ['a', 'b', 'c'].filter((c) => bodiesFor(c, probe).length === 1);
  ok(found.length === 3,
    `control: all THREE consecutive rules are found, including the middle one (got ${found.join(',') || 'none'}) — the first draft of this splitter skipped every alternate rule and reddened 18 assertions over correct CSS`);
  ok(bodiesFor('b', probe)[0]?.body.includes('green'),
    'control: …and the middle rule\'s own body is returned, not its neighbour\'s');
}
function declares(cls, prop, valueRe) {
  return bodiesFor(cls).some((r) => {
    const d = new RegExp(`(^|;)\\s*${prop}\\s*:([^;]*)`, 'i').exec(r.body);
    return d && valueRe.test(d[2]);
  });
}

ok(bodiesFor('cfd-card').length > 0 && bodiesFor('chat-browse').length > 0,
  'anti-vacuity: the rule extractor finds real rules for known classes (an extractor returning nothing would pass every check below)');
ok(bodiesFor('this-class-does-not-exist-anywhere').length === 0,
  'control: …and returns nothing for a class that does not exist — it discriminates');

// ═════════════════════════════════════════════════════════════════════════
section('§2  THE ONE SCRIM — one definition, five consumers, zero literals');
// ═════════════════════════════════════════════════════════════════════════
//
// The audit's headline scrim claim ("all five are 0.68 where the system
// specifies 0.72") is answered in this file's header: the bundle disagrees
// with itself and the app's values match its own applied prototype. The
// REAL scrim defect was the light theme, split 0.42 / 0.5 across the five,
// and the mechanism was a guard that made sharing impossible.
//
// `--scrim` was an UNDEFINED name carrying a hex fallback, baselined in
// test-css-tokens.js at "exactly ONE reference". Four stylesheets each
// carried a comment citing that assertion as their reason to inline the
// rgba literal instead. Five private copies of one value, by construction.
const shellCss = stripCssComments(readFileSync(path.join(NEXT, 'shell.css'), 'utf8'));

ok(/--modal-scrim\s*:\s*rgba\(5,\s*5,\s*10,\s*0\.68\)/.test(shellCss),
  '--modal-scrim is DEFINED for dark at rgba(5,5,10,0.68) — the design system app prototype\'s dark scrim');
// LIGHT IS A DELIBERATE DEVIATION FROM THE PROTOTYPE, WITH A NUMBER.
// The prototype says 0.42. MEASURED in a real browser, composited after
// cascade (controls: identical pair 1.00, black-on-white 21.00), a white
// --surface-overlay card against a 0.42 scrim reads 2.80:1 — UNDER WCAG
// 1.4.11's 3:1 non-text floor, and the 1px --border misses at either value
// (2.17 / 2.75), so the fill is the only thing that can clear it. 0.5 gives
// 3.55. It was already the value on three of the five surfaces, so this
// moves TWO surfaces up rather than three down. Same shape as v3.25.0's
// checkbox deviation: the system's own value failed a measured floor on the
// one boundary carrying the control, and the deviation is written down.
ok(/--modal-scrim\s*:\s*rgba\(20,\s*20,\s*31,\s*0\.5\)/.test(shellCss),
  '…and for light at rgba(20,20,31,0.5) — a MEASURED deviation from the prototype\'s 0.42, which puts a white modal at 2.80:1 against its own scrim (0.5 gives 3.55, over WCAG 1.4.11\'s 3:1)');
ok(/\[data-theme="light"\][^{]*\{[^}]*--modal-scrim/.test(shellCss),
  'the light value is under [data-theme="light"], never prefers-color-scheme — the shell stamps the attribute, so a media query would disagree with the toggle');

// The definition count is ONE. Two definitions is the drift this replaces,
// wearing a token name.
const scrimDefs = (allCss.match(/--modal-scrim\s*:/g) || []).length;
ok(scrimDefs === 2,
  `--modal-scrim is defined exactly twice across all of /next — once per theme (got ${scrimDefs})`);

// No rule may PAINT a scrim literal. Scoped to `background`/`background-
// color` VALUES rather than a whole-file text scan, and that narrowing is
// a measurement, not caution: a blanket scan flags the --modal-scrim
// definitions themselves (which are the fix) and tokens/color.css's
// `--graph-edge: rgba(20,20,31,0.18)`, an unrelated and entirely correct
// use of the same rgb. A guard that cries wolf on its own fix gets
// weakened by the next person rather than obeyed.
const SCRIM_RGB = /rgba\(\s*5\s*,\s*5\s*,\s*10\s*,|rgba\(\s*20\s*,\s*20\s*,\s*31\s*,/;
const scrimLiterals = [];
for (const f of cssFiles) {
  const code = stripCssComments(readFileSync(f, 'utf8'));
  const re = new RegExp(RULE_RE.source, 'g');
  let m;
  while ((m = re.exec(code)) !== null) {
    for (const d of m[2].matchAll(/(^|;)\s*background(?:-color)?\s*:([^;]*)/g)) {
      if (SCRIM_RGB.test(d[2])) scrimLiterals.push(`${rel(f)} — ${m[1].trim()} { background:${d[2].trim()} }`);
    }
  }
}
ok(scrimLiterals.length === 0,
  scrimLiterals.length === 0
    ? 'no /next rule PAINTS a scrim rgba literal — the five copies are one token'
    : `scrim rgba literals still painted: ${scrimLiterals.join('; ')}`);
// Control: the narrowed scan must still be able to see one.
{
  const probe = '.x { background: rgba(5,5,10,0.68); }';
  const re = new RegExp(RULE_RE.source, 'g');
  const hit = [...probe.matchAll(re)].some((r) =>
    [...r[2].matchAll(/(^|;)\s*background(?:-color)?\s*:([^;]*)/g)].some((d) => SCRIM_RGB.test(d[2])));
  ok(hit, 'control: a rule that DOES paint the scrim literal is detected — the narrowing did not disarm the check');
  ok(!SCRIM_RGB.test('rgba(21,20,31,0.4)'),
    'control: …and a near-miss rgb is not flagged, so the pattern discriminates');
}

// And the retired name stays retired: it was never defined, so a reference
// to it is a silent fallback, and it is what the whole duplication rested on.
const legacyScrimRefs = (allCss.match(/var\(\s*--scrim\b/g) || []).length;
ok(legacyScrimRefs === 0,
  `the retired --scrim name has zero references (got ${legacyScrimRefs}) — it has no definition anywhere, so any reference is a silent fallback`);

// ═════════════════════════════════════════════════════════════════════════
section('§3  RADIUS — "Modals 14px", stated three ways in the bundle');
// ═════════════════════════════════════════════════════════════════════════
//
//   readme.md:            "Cards 10px. Modals 14px."
//   shape-radius card:    the 14px swatch is labelled "xl · modal"
//   Modal.jsx:            borderRadius: 'var(--radius-xl)'
//
// tokens/shape.css is BYTE-FROZEN and is not touched: only consumers move.
// The audit noted --radius-xl was "used exactly once tree-wide and not on a
// modal" (it is on .chat-composer) with the implication that this was a
// misuse. IT IS NOT — the bundle's app prototype sets the composer to
// border-radius: 14px explicitly. The composer was right and the modals
// were wrong; both can be true.

// The four CENTERED dialogs must be at --radius-xl.
const CENTERED = ['cfd-card', 'sbw-card', 'mcpw-card', 'chat-browse'];
for (const cls of CENTERED) {
  ok(declares(cls, 'border-radius', /var\(\s*--radius-xl\s*\)/),
    `.${cls} is at --radius-xl (14px)`);
  ok(!declares(cls, 'border-radius', /var\(\s*--radius-lg\s*\)/),
    `…and no longer at --radius-lg (10px), the CARD radius it used to carry`);
}

// THE DRAWER IS DELIBERATELY EXCLUDED, and this asserts the exclusion so a
// future "make them all uniform" pass has to read the reason. .reader-panel
// is flush to the top, right and bottom of the main column: a corner radius
// would round edges that touch nothing. The bundle's app prototype gives
// this surface no radius, a border-left, and exactly the directional shadow
// it carries. It was the ONE conforming surface of the five.
ok(!declares('reader-panel', 'border-radius', /\S/),
  '.reader-panel declares NO border-radius — it is an edge-anchored DRAWER, not a centered dialog, and the bundle\'s app prototype gives it none');
ok(declares('reader-panel', 'border-left', /1px solid var\(--border\)/),
  '…and carries the border-left the prototype specifies, which is what separates it from the scrim');

// The composer keeps its 14px: it is not a modal, and it is not a mistake.
ok(declares('chat-composer', 'border-radius', /var\(\s*--radius-xl\s*\)/),
  '.chat-composer keeps --radius-xl — the bundle\'s app prototype sets it to 14px explicitly, so it was never the misuse the audit implied');

// ═════════════════════════════════════════════════════════════════════════
section('§4  BACKDROP BLUR — the system scopes it to exactly two places');
// ═════════════════════════════════════════════════════════════════════════
//
// readme.md: "Used in exactly two places: the modal scrim
// (rgba(5,5,10,0.72) + backdrop-filter: blur(6px)) and the sticky app
// header … Nowhere else — frosted panels everywhere is a 2021 tell."
//
// The confirm dialog and chat-browse omitted it, so the app shipped two
// visual grades of modal: one frosted, one flat, side by side in the same
// session.
const SCRIMS = ['cfd-scrim', 'sbw-scrim', 'mcpw-scrim', 'chat-browse-scrim', 'reader-scrim'];
for (const cls of SCRIMS) {
  ok(declares(cls, 'backdrop-filter', /blur\(\s*6px\s*\)/),
    `.${cls} carries backdrop-filter: blur(6px)`);
  ok(declares(cls, 'background', /var\(\s*--modal-scrim\s*\)/),
    `…and paints var(--modal-scrim), not a literal`);
}
ok(SCRIMS.length === EXPECTED_MODAL_COUNT,
  'one scrim per modal surface — the sets are the same size, so a modal cannot gain a card rule without a scrim rule');

// No per-file light override may reappear: the theme split lives at the
// token now, and a second one here is the five-copies drift one level down.
const perFileOverrides = SCRIMS.filter((cls) =>
  new RegExp(`\\[data-theme="light"\\][^{]*\\.${cls}(?![a-zA-Z0-9_-])`).test(allCss));
ok(perFileOverrides.length === 0,
  perFileOverrides.length === 0
    ? 'no scrim carries a per-file [data-theme="light"] override — the token is themed at its definition'
    : `per-file light overrides still present on: ${perFileOverrides.join(', ')}`);

// ═════════════════════════════════════════════════════════════════════════
section('§5  SHADOW — a modal floats, and the token carries the theme');
// ═════════════════════════════════════════════════════════════════════════
//
// The bundle blesses both: readme "Shadow is reserved for things that
// genuinely float: dropdown menus, modals, toasts (--shadow-pop,
// --shadow-lg)", and the elevation guideline card labels its floating
// swatch "Menu / modal — --shadow-pop". So this asserts a TOKEN, not one
// particular token.
//
// .sbw-card carried a hardcoded `0 24px 60px -20px rgba(0,0,0,0.55)`: a
// DARK shadow rendered verbatim in the light theme, the same class of
// defect as v3.25.0's Sync rail badge. shape.css defines a real light
// value for --shadow-lg and --shadow-pop; a literal cannot have one.
for (const cls of CENTERED) {
  ok(declares(cls, 'box-shadow', /var\(\s*--shadow-(lg|pop)\s*\)/),
    `.${cls} floats on a shadow TOKEN (--shadow-lg or --shadow-pop), so it themes`);
  ok(!declares(cls, 'box-shadow', /rgba\(/),
    `…and not on a hardcoded rgba shadow, which renders its dark value in light theme`);
}

// v3.24.2's rule, re-applied in v3.25.0's checkbox work: a box-shadow on an
// interactive element fights base.css's global :focus-visible ring. A modal
// CARD is not focusable chrome, so a shadow there is correct — but the
// scrims must not grow one.
for (const cls of SCRIMS) {
  ok(!declares(cls, 'box-shadow', /\S/),
    `.${cls} declares no box-shadow — the scrim is a full-viewport wash, and a shadow on it would only fight the ring on what it contains`);
}

// ═════════════════════════════════════════════════════════════════════════
section('§6  SURFACE — a modal must be readable in LIGHT, where elevation is 1.00:1');
// ═════════════════════════════════════════════════════════════════════════
//
// v3.20.0 MEASURED light-mode elevation at 1.00:1 — --surface-raised is
// byte-identical to --surface in light. A modal that separated itself from
// the page by elevation ALONE would be invisible for half the users.
//
// --surface-overlay is NOT --surface-raised and does not share that
// problem: in light it is #FFFFFF against a #FBFBFD canvas. But the margin
// is 1.02:1, so the separation is genuinely carried by the BORDER and the
// SCRIM, and both are asserted rather than assumed.
for (const cls of CENTERED) {
  ok(declares(cls, 'background', /var\(\s*--surface-overlay\s*\)/),
    `.${cls} is on --surface-overlay`);
  ok(declares(cls, 'border', /1px solid var\(--(border|danger)\)/) ||
     bodiesFor(cls).some((r) => /border\s*:\s*1px solid var\(--border\)/.test(r.body)),
    `…and carries a 1px border — in light, --surface-overlay vs --canvas is 1.02:1, so the edge is what does the separating, not the elevation`);
}
ok(declares('reader-panel', 'background', /var\(\s*--surface-overlay\s*\)/),
  '.reader-panel is on --surface-overlay too — one overlay surface across all five');

// ═════════════════════════════════════════════════════════════════════════
section('§7  Every modal is reachable by the token universe');
// ═════════════════════════════════════════════════════════════════════════
// An undefined custom property fails SILENTLY at computed-value time: the
// declaration is simply dropped, with no console error. A modal whose
// radius silently evaporates looks like a card, which is the defect this
// suite exists to catch — so a local echo of test-css-tokens.js runs over
// exactly the rules this suite asserts.
const definedNames = new Set();
for (const m of allCss.matchAll(/(--[a-z0-9-]+)\s*:/g)) definedNames.add(m[1]);
const usedByModals = new Set();
for (const cls of [...CENTERED, ...SCRIMS, 'reader-panel']) {
  for (const r of bodiesFor(cls)) {
    for (const m of r.body.matchAll(/var\(\s*(--[a-z0-9-]+)/g)) usedByModals.add(m[1]);
  }
}
const undef = [...usedByModals].filter((n) => !definedNames.has(n));
ok(definedNames.size > 100, `anti-vacuity: ${definedNames.size} custom properties defined across /next`);
ok(usedByModals.size > 5, `anti-vacuity: ${usedByModals.size} custom properties referenced by modal rules`);
ok(undef.length === 0,
  undef.length === 0
    ? 'every custom property a modal rule references is defined in /next'
    : `undefined in modal rules: ${undef.join(', ')}`);

console.log(`\nPassed: ${passed}   Failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
