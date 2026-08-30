/**
 * test-next-contrast-ratchet.js — OFFLINE suite, zero dependencies, no network.
 *
 * Guards the measured contrast fixes in the three view stylesheets owned by the
 * v3.23.0 contrast wave: views/domains.css, views/sync.css, views/shared.css.
 *
 * ── WHAT THIS SUITE CANNOT DO. READ THIS FIRST. ──────────────────────────
 *
 * It DOES NOT measure rendering. It never opens a browser, never lays anything
 * out, and never asks a rendering engine for a computed style. What it does is
 * arithmetic over token VALUES parsed out of tokens/color.css, joined to a
 * TEXT SCAN of which token each CSS declaration names. That is a proxy, and the
 * gap between the proxy and the truth is real:
 *
 *   · It assumes each declaration's backdrop. A rule is checked against the
 *     surfaces it plausibly sits on, not the surface it ACTUALLY sits on in the
 *     live DOM. A page that nests a card inside an unexpected container can put
 *     a passing token on a failing backdrop and this suite will not notice.
 *   · It cannot resolve the cascade. Specificity, order, `!important`, and any
 *     rule in a file this suite does not read (shell.css, text.css, another
 *     view) can override what it reads here and it will still report green.
 *   · It cannot see an ABSENT declaration. An element that inherits its colour
 *     has no `color:` line to scan, so it is invisible to every check below —
 *     the same class v3.20.0 records for form controls and the browser's UA
 *     font-size default. You cannot grep for a declaration that is not there.
 *   · It does not know what is text. `color` on an <svg> glyph is a NON-TEXT
 *     UI component under WCAG 1.4.11 (3:1) while `color` on a <span> is text
 *     (4.5:1), and nothing in a stylesheet distinguishes them. The selector
 *     allow-list in §5 is a hand-maintained judgement, not a derivation.
 *
 * The ONLY thing that proves a rendered contrast ratio is a real browser
 * reading getComputedStyle in both themes. That measurement was taken for this
 * wave (127.0.0.1:3391, 1280px, both themes, helper validated by controls
 * returning 1.00 on an identical pair and 21.0 on black-on-white) and the
 * numbers quoted in the assertions below come from it. This suite exists so
 * those numbers cannot rot back — it is a RATCHET, not a measurement.
 *
 * ── ENFORCED ─────────────────────────────────────────────────────────────
 *  §2 The offline contrast helper is validated by controls, INCLUDING that the
 *     dark and light token blocks parse to genuinely different values (a bare
 *     indexOf for `[data-theme="light"]` matches color.css's own HEADER
 *     COMMENT, which is how one previous tool reported both themes identical).
 *  §3 The token-level facts the fixes rest on. RE-BASED ON THE APPROVED TEXT-
 *     RAMP CHANGE: --text-3 and --text-faint used to fail the 4.5 text floor in
 *     both themes, and several assertions here demanded that they still did.
 *     tokens/color.css has since lightened the dark rungs and darkened the
 *     light ones at SOURCE, so --text-3 now CLEARS 4.5 (6.16 dark / 5.60 light
 *     on --surface) and --text-faint now clears the 3:1 NON-TEXT floor (3.47 /
 *     3.61) while still failing 4.5 as text. Those assertions are INVERTED, not
 *     deleted, per this project's practice: they now guard the fix and go red
 *     if the ramp regresses. --attention-text is untouched and still fails in
 *     LIGHT.
 *  §4 THE CLASS RATCHET: zero declarations in the three owned files paint a
 *     below-floor token as TEXT. Counted, so a new one is a new failure.
 *     BELOW_TEXT_FLOOR is a hand-written list, so §4a CROSS-CHECKS IT AGAINST
 *     THE ARITHMETIC: every token on it must genuinely measure under 4.5, and
 *     --text-3 must be absent BECAUSE it now measures over. That is what stops
 *     the list becoming a blanket ban divorced from measurement — the failure
 *     shape that made this re-base necessary in the first place.
 *  §5 The deliberate NON-TEXT survivors are asserted PRESENT with their
 *     measured values, because a survivor that silently disappears is as much
 *     a regression as a new failure — and because leaving them proves the
 *     ratchet is a floor rule, not a blanket ban on a token.
 *  §6 The named sites from the brief are pinned individually by selector.
 *  §7 Positive controls: every detector is run against a planted failing rule
 *     and must fire. A detector that cannot fail is this repo's most-recorded
 *     defect shape.
 *  §8 The KNOWN REMAINING GAP is counted: --success-text as TEXT measures 4.05
 *     light (3.59 over its own tint), under the 4.5 floor. It was NOT part of
 *     this brief and is NOT fixed. The count stops it growing quietly.
 *  §9 The INERT-COPY DEFECT — .settings-hint-text and .theme-seg-btn, whose
 *     winning copy lives in views/settings.css. Was a tripwire asserting that
 *     copy was still broken; settings.css has since been fixed, so it is now
 *     INVERTED and guards the fix, including the ABSENCE of a second, later
 *     --text-3 declaration in the same file (a presence-only check misses it).
 *§10b The two SIDEBAR EMPTY-STATE roles, also in shell.css: .sidebar-hint (on
 *     --surface) and .sidebar-note (on its OWN --surface-inset, which is the
 *     backdrop that makes the LIGHT figure the worse of the two — grading it
 *     against --surface would have hidden that). Six functional empty-state
 *     sentences across four views, plus gatedLoader's placeholder. Both were
 *     --text-3, measured 4.27/4.14 and 4.33/3.87 AT THE TIME, both under the
 *     floor; both went --text-2. Since the ramp change --text-3 clears the
 *     floor on both backdrops, so these two are now KEPT on ROLE grounds
 *     rather than floor grounds — see shell.css, and contrast with
 *     .cur-eyebrow in §10, which was retired for exactly the opposite reason.
 * §10 WAS the two APP-WIDE fixes in shell.css. `.cur-eyebrow`'s override has
 *     been RETIRED — it existed only to escape the broken --text-3 rung, the
 *     rung is fixed at source, and its own comment said it was overriding
 *     "rather than at source". So §10 now asserts the override is GONE and the
 *     BYTE-FROZEN base.css value paints and clears the floor. `.empty-card
 *     .empty-body` is KEPT at --text-2 on role grounds, not floor grounds, and
 *     still asserts the base.css-before-shell.css load order READ OUT OF
 *     index.html plus that no sheet linked afterwards redeclares either
 *     selector standalone.
 *
 * ── NOT ENFORCED ─────────────────────────────────────────────────────────
 *  · Borders. --border (1.24/1.29) and --border-strong (1.48/1.64) are under
 *    the 3:1 non-text floor across the whole app, in files this wave does not
 *    own. Fixing them in three files only would make those three inconsistent
 *    with every other view. Recorded, deliberately untouched.
 *  · Any file other than the three named — EXCEPT views/settings.css, which is
 *    READ (never written) by §9, because it OVERRIDES two of the fixes here.
 *  · §9 covers .settings-hint-text and .theme-seg-btn, whose winning copy is in
 *    settings.css, NOT in a file this wave owns. It was a TRIPWIRE asserting
 *    that copy was still broken; settings.css has since been fixed, so it is
 *    now INVERTED and guards the fix. §4 reporting green on those two selectors
 *    still proves nothing on its own — §9 is what makes them real.
 *  · Whether a rule is REACHED at runtime at all.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NEXT = join(ROOT, 'src/public/next');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function section(t) { console.log(`\n${t}`); }

// ── Comment stripping ────────────────────────────────────────────────────
// Load-bearing twice over. color.css's HEADER COMMENT contains the literal
// string `[data-theme="light"]`, so splitting the file on that substring
// without stripping comments first parses `:root` twice and reports dark and
// light as identical — a real tool in this project's history did exactly that.
// And the view files' own comments QUOTE the retired tokens while explaining
// why they went, so a raw scan reads a comment and reports the opposite of
// the truth.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '');
}

// ── Token resolution ─────────────────────────────────────────────────────
function parseTokenBlock(body) {
  const map = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) map[m[1]] = m[2].trim();
  return map;
}
function readThemes() {
  const css = stripComments(readFileSync(join(NEXT, 'tokens/color.css'), 'utf8'));
  const lightAt = css.indexOf('[data-theme="light"]');
  if (lightAt < 0) throw new Error('could not locate the light theme block');
  const rootAt = css.indexOf(':root');
  const base = parseTokenBlock(css.slice(rootAt, lightAt));
  const light = { ...base, ...parseTokenBlock(css.slice(lightAt)) };
  return { dark: base, light };
}
// Follow var() alias chains: --attention-text -> var(--summary-400) -> #EDBB63
function resolve(theme, name, depth = 0) {
  if (depth > 12) return null;
  let v = theme[name];
  if (!v) return null;
  const alias = v.match(/^var\((--[a-z0-9-]+)\)$/);
  if (alias) return resolve(theme, alias[1], depth + 1);
  return v;
}

// ── Contrast maths ───────────────────────────────────────────────────────
function toRgb(v) {
  const hx = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hx) {
    let h = hx[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
  }
  const rg = v.match(/rgba?\(([^)]+)\)/);
  if (rg) {
    const p = rg[1].split(',').map((s) => parseFloat(s));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  return null;
}
const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
function ratio(a, b) {
  const L1 = lum(a), L2 = lum(b);
  return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
}
// A TRANSLUCENT tint must be composited against its backdrop before it is
// measured. Treating one as opaque is how a previous probe read a badge at
// 1.90:1 when composited it is 13.81.
function composite(top, bottom) {
  if (top.a >= 1) return top;
  return { r: top.r * top.a + bottom.r * (1 - top.a),
           g: top.g * top.a + bottom.g * (1 - top.a),
           b: top.b * top.a + bottom.b * (1 - top.a), a: 1 };
}
/** Contrast of token `fg` over `base`, with optional translucent `tint` on top of base. */
function C(theme, fg, base, tint) {
  const f = toRgb(resolve(theme, fg));
  let bg = toRgb(resolve(theme, base));
  if (!f || !bg) return null;
  if (tint) {
    const t = toRgb(resolve(theme, tint));
    if (t) bg = composite(t, bg);
  }
  return Math.round(ratio(f, bg) * 100) / 100;
}
const themes = readThemes();
const D = themes.dark, L = themes.light;
/** Worst of the two themes — the number an assertion should be held to. */
const worst = (fg, base, tint) => Math.min(C(D, fg, base, tint), C(L, fg, base, tint));

// ── Owned stylesheets, parsed into rules ─────────────────────────────────
const OWNED = ['domains', 'sync', 'shared'];
const FILES = {};
for (const f of OWNED) FILES[f] = readFileSync(join(NEXT, `views/${f}.css`), 'utf8');

function rulesOf(css) {
  const out = [];
  for (const m of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim().replace(/\s+/g, ' ');
    if (!sel || sel.startsWith('@')) continue;
    out.push({ sel, body: m[2] });
  }
  return out;
}
/** Every `color:` declaration naming one of `tokens`, as {file, sel, token}. */
function colorDecls(tokens, css) {
  const hits = [];
  for (const { sel, body } of rulesOf(css)) {
    for (const m of body.matchAll(/(?:^|;)\s*color\s*:\s*var\((--[a-z0-9-]+)\)/g)) {
      if (tokens.includes(m[1])) hits.push({ sel, token: m[1] });
    }
  }
  return hits;
}
/**
 * A `color:` declaration is NON-TEXT — 3:1 floor, not 4.5 — when it paints an
 * icon rather than a sentence. Nothing in CSS distinguishes those, so this is
 * a hand-maintained allow-list, stated as such rather than dressed up as a
 * derivation. Each entry carries its measured value from the browser pass.
 */
const NON_TEXT_COLOR = [
  '.dm-group-summary svg',        // disclosure chevron — 4.27 dark / 4.14 light
  '.sbw-note-block svg',          // note-block icon     — 4.33 / 3.87
  '.dm-quick-note-busy svg',      // busy warning icon   — 9.75 / 3.16
  '.sync-sidebar-busy svg',       // busy warning icon   — 9.11 / 3.21
  '.sb-token-warn > svg',         // shown-once warning  — 9.11 / 3.21
];
const isNonText = (sel) => NON_TEXT_COLOR.includes(sel);

// ═════════════════════════════════════════════════════════════════════════
section('§0  META-CONTROL — the assertion helper itself');

// v3.18.0 records suites in this repo disagreeing about ok()'s argument order,
// which made every literal assertion pass unconditionally — caught by mutation,
// not review. Every content assertion below is blind to that, because a label
// string is truthy.
//
// AND SO IS THIS CHECK, IF ITS VERDICT GOES THROUGH ok(). The first version of
// this block ended `ok(detected, '...')`, and a mutation reversing the
// signature left the suite GREEN at 49/0: the probe passed instead of failing,
// `detected` came out false, and then `ok(false, 'META-CONTROL…')` ALSO passed
// because the label was in the condition slot. The guard against the hazard was
// disabled by the hazard. The verdict therefore does NOT use ok() — it throws.
{
  const bp = passed, bf = failed;
  const realLog = console.log;
  console.log = () => {};                 // the probe MUST fail; do not print its ✗
  ok(false, '(meta-control probe)');
  console.log = realLog;
  const detected = failed === bf + 1 && passed === bp;
  passed = bp; failed = bf;               // roll the probe back out either way
  if (!detected) {
    console.log('  ✗ META-CONTROL: ok(false, ...) did NOT increment FAILED. The helper\'s argument ' +
                'order is reversed (ok(label, cond)), so every assertion in this file passes ' +
                'unconditionally and the whole suite is decorative. Refusing to report a result.');
    console.log('\n' + '='.repeat(60));
    console.log('Passed: 0   Failed: 1');
    console.log('❌ FAILURES');
    process.exit(1);
  }
  ok(true, 'META-CONTROL: ok(cond, label) counts a false condition as a FAILURE');
}

// ═════════════════════════════════════════════════════════════════════════
section('§1  Token parsing');

ok(Object.keys(D).length > 40, `dark block parsed (${Object.keys(D).length} tokens)`);
ok(Object.keys(L).length > 40, `light block parsed (${Object.keys(L).length} tokens)`);
ok(resolve(D, '--attention-text') === '#EDBB63',
   `alias chain resolves: dark --attention-text -> --summary-400 -> #EDBB63 (got ${resolve(D, '--attention-text')})`);
ok(resolve(L, '--attention-text') === '#B57C21',
   `alias chain resolves: light --attention-text -> --summary-600 -> #B57C21 (got ${resolve(L, '--attention-text')})`);

// ═════════════════════════════════════════════════════════════════════════
section('§2  CONTROLS — the helper is validated before anything is trusted');

const white = { r: 255, g: 255, b: 255, a: 1 }, black = { r: 0, g: 0, b: 0, a: 1 };
ok(Math.round(ratio(white, white) * 100) / 100 === 1,
   `CONTROL: an identical pair returns 1.00 (got ${Math.round(ratio(white, white) * 100) / 100})`);
ok(Math.round(ratio(black, white) * 100) / 100 === 21,
   `CONTROL: black on white returns 21.0 (got ${Math.round(ratio(black, white) * 100) / 100})`);
ok(Math.round(composite({ r: 224, g: 163, b: 58, a: 0.13 }, { r: 12, g: 12, b: 20, a: 1 }).r) === 40,
   'CONTROL: a 0.13-alpha tint composites rather than being read as opaque');

// THE HEADER-COMMENT TRAP, asserted directly. If comment stripping regresses,
// both blocks parse from `:root` and every light-theme number silently becomes
// a dark-theme number — green, and completely wrong.
ok(resolve(D, '--text') !== resolve(L, '--text'),
   `CONTROL: dark and light parse to DIFFERENT values (--text ${resolve(D, '--text')} vs ${resolve(L, '--text')}). ` +
   'color.css\'s own header comment contains the literal string [data-theme="light"], so a scan that does not ' +
   'strip comments first parses :root twice and reports the two themes identical.');
ok(/\[data-theme="light"\]/.test(readFileSync(join(NEXT, 'tokens/color.css'), 'utf8').slice(0, 1200)),
   'CONTROL: that trap is REAL — the literal selector does appear in color.css\'s header comment');

// ═════════════════════════════════════════════════════════════════════════
section('§3  The token-level facts these fixes rest on');

const TEXT_FLOOR = 4.5, NONTEXT_FLOOR = 3;

// ── INVERTED (1/6). This assertion used to read `< TEXT_FLOOR` and its label
// said "--text-3 FAILS the 4.5 text floor (4.27 / 4.14). If this ever passes,
// the sweep below is unnecessary and should be revisited." It has passed: the
// approved ramp change moved --text-3 from #74748A to #8F8FA5 in dark and from
// #7B7B90 to #66667B in light, AT SOURCE in tokens/color.css. Inverted rather
// than deleted — it now guards the fix, and goes red the day the rung regresses.
ok(worst('--text-3', '--surface') >= TEXT_FLOOR,
   `--text-3 CLEARS the ${TEXT_FLOOR} text floor (${C(D, '--text-3', '--surface')} dark / ` +
   `${C(L, '--text-3', '--surface')} light on --surface). It measured 4.27 / 4.14 before the ramp change and ` +
   'this assertion demanded that it still failed. A third usable text rung is the entire point of the change: ' +
   'the app had spent releases overriding --text-3 up to --text-2, and every such rescue flattened the ramp ' +
   'by one more role.');
// ── INVERTED (2/6). Was `< NONTEXT_FLOOR`, labelled "--text-faint fails even
// the 3 NON-TEXT floor (2.26 / 2.34) — roughly half of either floor." The ramp
// change moved it to #66667A / #858599 and it now clears 3:1. That matters
// concretely: §5 below records .sync-domain-dot having to LEAVE --text-faint
// because a 6px dot could not be seen at 2.26.
ok(worst('--text-faint', '--surface') >= NONTEXT_FLOOR,
   `--text-faint now clears the ${NONTEXT_FLOOR} NON-TEXT floor (${C(D, '--text-faint', '--surface')} dark / ` +
   `${C(L, '--text-faint', '--surface')} light). It was 2.26 / 2.34 — under HALF the text floor and under the ` +
   'non-text floor too, which is why nothing in the app painted it as text and only two rules used it at all.');
// NOT inverted, and load-bearing: --text-faint still fails the TEXT floor. It
// is the rung that is deliberately not for running text, and it is what keeps
// §4's ratchet and §7's positive control able to fire at all. If a future edit
// lifts it over 4.5, BELOW_TEXT_FLOOR loses its last both-theme failure and §7
// must be re-based again rather than left to pass vacuously.
ok(worst('--text-faint', '--surface') < TEXT_FLOOR,
   `--text-faint still FAILS the ${TEXT_FLOOR} text floor (${C(D, '--text-faint', '--surface')} dark / ` +
   `${C(L, '--text-faint', '--surface')} light), which is deliberate — it is the non-text rung. It is also the ` +
   'only token in BELOW_TEXT_FLOOR that fails in BOTH themes, so it is what makes §7\'s positive control real. ' +
   'If this ever goes red, §4 and §7 have lost their teeth and must be re-based, NOT relaxed.');
ok(C(L, '--attention-text', '--surface') < TEXT_FLOOR,
   `--attention-text FAILS as text in LIGHT (${C(L, '--attention-text', '--surface')} on --surface, ` +
   `${C(L, '--attention-text', '--surface', '--attention-tint')} on its own tint) while PASSING in dark ` +
   `(${C(D, '--attention-text', '--surface')}). This asymmetry is why amber moves to the rail rather than being re-toned.`);
ok(C(D, '--attention-text', '--surface') >= TEXT_FLOOR,
   'and the dark theme genuinely passes, so the fix is not addressing an imaginary problem there');

// The replacements actually clear the floor. Without this, the sweep could be
// swapping one failing token for another and every count below would be green.
for (const base of ['--surface', '--canvas', '--surface-raised', '--surface-inset']) {
  ok(worst('--text-2', base) >= TEXT_FLOOR,
     `--text-2 clears ${TEXT_FLOOR} over ${base} (${C(D, '--text-2', base)} dark / ${C(L, '--text-2', base)} light)`);
}
for (const tint of ['--attention-tint', '--accent-tint']) {
  ok(worst('--text', '--surface', tint) >= TEXT_FLOOR,
     `--text clears ${TEXT_FLOOR} over ${tint} (${C(D, '--text', '--surface', tint)} dark / ` +
     `${C(L, '--text', '--surface', tint)} light) — the neutral half of the rail-carries-the-tone pattern`);
}
ok(worst('--attention-text', '--surface') >= NONTEXT_FLOOR,
   `--attention-text clears the ${NONTEXT_FLOOR} NON-TEXT floor as a rail/icon ` +
   `(${C(D, '--attention-text', '--surface')} dark / ${C(L, '--attention-text', '--surface')} light) — ` +
   'which is the whole reason the tone can stay on the border at all');

// ═════════════════════════════════════════════════════════════════════════
section('§4  THE CLASS RATCHET — no below-floor token is painted as TEXT');

// RE-BASED. `--text-3` was the first entry here for the whole life of this
// suite. It is GONE because it now MEASURES over the floor, not because anyone
// decided to stop caring — which is exactly the distinction §4a below turns
// into an assertion. Removing it makes §4 more permissive on paper; §4a is what
// stops that being a weakening, by refusing to let the list drift away from the
// arithmetic in EITHER direction.
const BELOW_TEXT_FLOOR = ['--text-faint', '--attention-text'];

for (const f of OWNED) {
  const hits = colorDecls(BELOW_TEXT_FLOOR, FILES[f]).filter((h) => !isNonText(h.sel));
  ok(hits.length === 0,
     `views/${f}.css paints ZERO below-floor tokens as text. Found ${hits.length}: ` +
     hits.map((h) => `${h.sel} { color: ${h.token} }`).join(', ') +
     `. --text-faint measures ${C(D, '--text-faint', '--surface')}/${C(L, '--text-faint', '--surface')}, ` +
     '--attention-text 3.21 light on its own tint — under the 4.5 AA floor. Use --text-2 or --text-3 for dim ' +
     'body text; for a status, put the tone on the border or the icon and the words in --text.');
}

// ═════════════════════════════════════════════════════════════════════════
section('§4a  THE LIST IS CROSS-CHECKED AGAINST THE ARITHMETIC, in both directions');

// A hand-written ban list rots two ways: it keeps banning a token that has been
// FIXED — which is exactly what happened here, and is why the app kept
// overriding --text-3 up to --text-2 long after that had stopped being the right
// answer — or it quietly drops a token that still fails. Both are now checked,
// on the SAME numbers §3 uses, so the list cannot drift from the measurement.
for (const t of BELOW_TEXT_FLOOR) {
  ok(worst(t, '--surface') < TEXT_FLOOR,
     `BELOW_TEXT_FLOOR entry ${t} genuinely measures under ${TEXT_FLOOR} ` +
     `(${C(D, t, '--surface')} dark / ${C(L, t, '--surface')} light). A list entry that PASSES would make §4 a ` +
     'blanket ban on a token rather than a measured floor rule.');
}
// ── INVERTED (4/6). The ABSENCE of --text-3 is asserted, and asserted TOGETHER
// WITH the measurement that justifies it — so it cannot be re-added on taste,
// and cannot stay out if the rung ever regresses.
ok(!BELOW_TEXT_FLOOR.includes('--text-3') && worst('--text-3', '--surface') >= TEXT_FLOOR,
   '--text-3 is deliberately ABSENT from BELOW_TEXT_FLOOR, and the reason is arithmetic: it measures ' +
   `${C(D, '--text-3', '--surface')} / ${C(L, '--text-3', '--surface')}, over the ${TEXT_FLOOR} floor. It was on ` +
   'this list from the suite\'s creation until the ramp change. If the token regresses, this pairing goes red, ' +
   'so the omission can never outlive the measurement that earned it.');
// And the list must retain at least one token failing in BOTH themes, or §7's
// positive control degrades into a check that one theme happens to fail.
ok(BELOW_TEXT_FLOOR.some((t) => C(D, t, '--surface') < TEXT_FLOOR && C(L, t, '--surface') < TEXT_FLOOR),
   'at least one BELOW_TEXT_FLOOR token fails in BOTH themes (--text-faint, ' +
   `${C(D, '--text-faint', '--surface')} / ${C(L, '--text-faint', '--surface')}), so the detector §7 exercises ` +
   'fires on an unambiguously failing token rather than on a one-theme edge case');

// ═════════════════════════════════════════════════════════════════════════
section('§5  Deliberate NON-TEXT survivors — present, and above the 3:1 floor');

// This is NOT a token ban. --text-3 on a 6px dot or a chevron is correct: the
// floor there is 3:1 and it now measures 6.16/5.60 (4.27/4.14 before the ramp
// change, which already cleared 3:1 — the margin simply grew). Asserting the survivors are
// PRESENT stops a later reader "finishing the job" by deleting a correct use,
// and keeps views/domains.css above the `text3 > 0` clause that
// test-next-domains-text.js's own ratchet depends on.
const SURVIVORS = [
  ['domains', /\.dm-browse-dot\s*\{[^}]*background:\s*var\(--text-3\)/, '.dm-browse-dot background — a 6px dot, 6.16 / 5.60 against a 3:1 floor (4.27 / 4.14 before the ramp change)'],
  ['domains', /\.dm-group-summary svg\s*\{[^}]*color:\s*var\(--text-3\)/, '.dm-group-summary svg — a chevron glyph, 6.16 / 5.60'],
  ['sync',    /\.sync-domain-dot\s*\{[^}]*background:\s*var\(--text-3\)/, '.sync-domain-dot background — was --text-faint at 2.26 / 2.34, UNDER the 3:1 non-text floor at the time; --text-3 cleared it then at 4.27 / 4.14 and clears it now at 6.16 / 5.60'],
  ['shared',  /\.sbw-note-block svg\s*\{[^}]*color:\s*var\(--text-3\)/, '.sbw-note-block svg — an icon, 6.24 / 5.24 on --surface-inset'],
];
for (const [file, re, why] of SURVIVORS) {
  ok(re.test(stripComments(FILES[file])), `views/${file}.css KEEPS ${why}`);
}
ok(worst('--text-3', '--surface') >= NONTEXT_FLOOR,
   `and --text-3 genuinely clears the ${NONTEXT_FLOOR} non-text floor (${C(D, '--text-3', '--surface')} / ` +
   `${C(L, '--text-3', '--surface')}), so keeping those four is correct rather than merely tolerated`);
// ── INVERTED (5/6). Was "while --text-faint does NOT, which is why
// .sync-domain-dot had to move even though it is not text". The ramp change
// lifted --text-faint over 3:1, so the CLAUSE is now false while the DECISION it
// explains stays right. Inverted to record both halves: the dot's move was
// correct at the time AND the token it left has since been repaired.
ok(worst('--text-faint', '--surface') >= NONTEXT_FLOOR,
   `--text-faint now ALSO clears the ${NONTEXT_FLOOR} non-text floor ` +
   `(${C(D, '--text-faint', '--surface')} / ${C(L, '--text-faint', '--surface')}), where it measured 2.26 / 2.34 ` +
   'when .sync-domain-dot was moved off it. The move was right on the numbers of the day and the dot deliberately ' +
   'stays on --text-3 — a 6px dot wants the stronger of the two, and moving it back would be churn with no gain. ' +
   'What has changed is that --text-faint is no longer BELOW the non-text floor, so a future non-text use of it ' +
   'is defensible where it previously was not.');

// ═════════════════════════════════════════════════════════════════════════
section('§6  The named sites from the brief, pinned individually');

// Pinned by SELECTOR, not just by count: a count stays green while any single
// site regresses, as long as another is fixed in the same edit.
const NAMED = [
  ['shared',  /\.sb-conn-state\s*\{[^}]*color:\s*var\(--text-2\)/,
   '.sb-conn-state is --text-2 (8.34 / 7.26). It was --text-faint, MEASURED 2.26 dark / 2.34 light — ' +
   'under the 4.5 text floor AND under the 3:1 non-text floor, on the only span in the row that says whether ' +
   'a connection has unpushed work.'],
  ['shared',  /\.sb-conn-name\s*\{[^}]*color:\s*var\(--text\)\s*;/,
   '.sb-conn-name is --text (16.71 / 18.27), NOT --text-2. Both spans at --text-2 would paint the row one ' +
   'flat colour and lose the dim step the pair is built on.'],
  ['domains', /\.dm-quick-note-busy\s*\{[^}]*color:\s*var\(--text\)\s*;/,
   '.dm-quick-note-busy words are --text (14.78 / 16.15). It was --attention-text at 3.16 light over --accent-tint.'],
  ['domains', /\.dm-quick-note-busy svg\s*\{[^}]*color:\s*var\(--attention-text\)/,
   '...and the amber survives on its ICON, which is a non-text component at a 3:1 floor (9.75 / 3.16)'],
  ['domains', /\.dm-chip-amber\s*\{[^}]*border-color:\s*var\(--attention-text\)/,
   '.dm-chip-amber puts the amber on the border — .dm-chip already reserves 1px, so this costs no layout'],
  ['sync',    /\.sync-sidebar-busy svg\s*\{[^}]*color:\s*var\(--attention-text\)/,
   '.sync-sidebar-busy keeps its amber icon while the sentence goes --text'],
  ['shared',  /\.upd-warning\s*\{[\s\S]*?border-top:\s*1px solid var\(--attention-text\)/,
   '.upd-warning moves the amber onto the top border it already had (1.11 / 1.05 as --border-subtle, ' +
   '9.11 / 3.21 as --attention-text) rather than adding a new box'],
];
for (const [file, re, why] of NAMED) {
  ok(re.test(stripComments(FILES[file])), `views/${file}.css: ${why}`);
}

// ═════════════════════════════════════════════════════════════════════════
section('§7  POSITIVE CONTROLS — every detector must be able to fire');

// RE-BASED. The planted rule used to be `--text-3` — the token whose failure the
// whole suite was built around. That control DIED the moment --text-3 cleared
// 4.5: it would have kept "passing" only if the list stayed stale. --text-faint
// is the token that still fails in both themes, so it carries the control now,
// and §4a above asserts that it really does, so this cannot go vacuous silently.
const plantedText = '.planted-a { color: var(--text-faint); }';
ok(colorDecls(BELOW_TEXT_FLOOR, plantedText).length === 1,
   'CONTROL: the below-floor text detector fires on a planted --text-faint colour rule ' +
   `(${C(D, '--text-faint', '--surface')} dark / ${C(L, '--text-faint', '--surface')} light, both under 4.5)`);
ok(colorDecls(BELOW_TEXT_FLOOR, '.planted-c { color: var(--attention-text); }').length === 1,
   'CONTROL: ...and on --attention-text');
ok(colorDecls(BELOW_TEXT_FLOOR, '.planted-d { background: var(--text-faint); }').length === 0,
   'CONTROL: ...and NOT on a background, which is a non-text component at a 3:1 floor');
ok(colorDecls(BELOW_TEXT_FLOOR, '.planted-e { color: var(--text-2); }').length === 0,
   'CONTROL: ...and NOT on a passing token, so the detector is not simply always-true');
// ── INVERTED (6/6). This exact string used to be asserted to produce ONE hit.
// It now must produce ZERO, and that is the single clearest statement in the
// suite that the ramp changed: the same input, the opposite expected verdict.
ok(colorDecls(BELOW_TEXT_FLOOR, '.planted-b { color: var(--text-3); }').length === 0,
   'CONTROL, INVERTED: the detector no longer fires on --text-3. This assertion used to demand exactly ONE hit ' +
   `on this same string. --text-3 measures ${C(D, '--text-3', '--surface')} / ${C(L, '--text-3', '--surface')} ` +
   'and painting it as body text is now correct, so a detector that still fired here would be reporting a ' +
   'failure that no longer exists — the precise failure mode that had the app overriding this token app-wide.');
ok(colorDecls(BELOW_TEXT_FLOOR, '/* .planted-f { color: var(--text-faint); } */').length === 0,
   'CONTROL: ...and NOT on a rule that only exists inside a comment');
ok(colorDecls(BELOW_TEXT_FLOOR, plantedText).filter((h) => !isNonText(h.sel)).length === 1 &&
   colorDecls(BELOW_TEXT_FLOOR, '.sbw-note-block svg { color: var(--text-faint); }').filter((h) => !isNonText(h.sel)).length === 0,
   'CONTROL: the non-text allow-list exempts exactly the listed selectors and nothing else');
ok(!/\.sb-conn-state\s*\{[^}]*color:\s*var\(--text-2\)/.test('.sb-conn-state { color: var(--text-faint); }'),
   'CONTROL: the §6 named-site pattern does NOT match the pre-fix declaration');

// ═════════════════════════════════════════════════════════════════════════
section('§8  KNOWN REMAINING GAP, counted — --success-text as text');

// Not in this wave's brief, measured here rather than left unsaid.
// --success-text is #4FD3A4 dark (10.37, fine) and #1E8F69 light, which is
// 4.05 on --surface and 3.59 on its own tint — under the 4.5 floor, the same
// shape as --attention-text one family over. Fixing it would be a fourth
// colour family across three files in a wave that was briefed for three; it is
// counted so it cannot grow, and reported so it can be commissioned.
ok(C(L, '--success-text', '--surface') < TEXT_FLOOR,
   `THE GAP IS REAL: --success-text as text measures ${C(L, '--success-text', '--surface')} on --surface and ` +
   `${C(L, '--success-text', '--surface', '--success-tint')} on its own tint in LIGHT — under ${TEXT_FLOOR}. ` +
   `(Dark is ${C(D, '--success-text', '--surface')} and fine.)`);
ok(worst('--success-text', '--surface') >= NONTEXT_FLOOR,
   'though it clears the 3:1 non-text floor, so its use as a dot or a rail is correct');

const successAsText = OWNED.reduce((n, f) => n + colorDecls(['--success-text'], FILES[f]).length, 0);
ok(successAsText === 12,
   `RATCHETED: exactly ${successAsText} declarations across the three owned files paint --success-text as TEXT. ` +
   'Expected 12 (domains 4, sync 1, shared 7). It may fall; it must not rise. This is a KNOWN, UNFIXED failure in the light theme ' +
   '(4.05 on --surface, 3.59 on --success-tint) reported rather than repaired, because a fourth colour family ' +
   'was outside this wave\'s brief. The fix is the same one applied to amber: tone on the rail, words in --text.');

// --danger-text, by contrast, genuinely passes and must NOT be swept up.
ok(worst('--danger-text', '--surface') >= TEXT_FLOOR,
   `--danger-text PASSES as text (${C(D, '--danger-text', '--surface')} dark / ` +
   `${C(L, '--danger-text', '--surface')} light) and is deliberately left alone — the rule is a measured floor, ` +
   'not a blanket ban on status colours in text.');

// ═════════════════════════════════════════════════════════════════════════
section('§9  THE INERT-COPY DEFECT — history kept, tripwire INVERTED');

// ── WHAT THIS SECTION WAS, AND WHY IT IS NOT DELETED ─────────────────────
// This began as a TRIPWIRE. `.settings-hint-text` is declared THREE times
// (views/shared.css, views/sync.css, views/settings.css) and `.theme-seg-btn`
// TWICE (views/sync.css, views/settings.css), at IDENTICAL specificity.
// index.html links settings.css AFTER both files this wave owns, so
// settings.css WINS — and an earlier pass that fixed only the two OWNED copies
// changed NOTHING a user could see. Measured in the real document at the time:
// both selectors still rendered 4.38 dark / 4.00 light, under the 4.5 floor,
// while §4 above reported GREEN for them. That is the cascade blindness this
// suite's header warns about, caught in the act.
//
// The tripwire asserted settings.css STILL carried --text-3, so that the day
// someone fixed it the suite would go RED and point them here rather than let
// the note quietly become a lie. That day has come: settings.css now carries
// --text-2 for both selectors, with an in-file comment recording the defect.
//
// So the assertion is INVERTED, not deleted, per its own instruction. It now
// guards the fix instead of announcing the defect: settings.css — the copy the
// cascade actually lands on — must carry --text-2 and must NOT re-acquire
// --text-3 for either selector. The reasoning above is why the owned copies in
// §9a were changed at all, and deleting it would strand them looking arbitrary.
//
// RE-MEASURED LIVE after the settings.css fix (127.0.0.1, 1280px, both themes,
// every view sheet linked, transitions frozen before reading getComputedStyle,
// helper validated by controls returning 1.00 on an identical pair and 21.0 on
// black-on-white):
//   .settings-hint-text        8.55 dark / 7.02 light   (was 4.38 / 4.00)
//   .theme-seg-btn inactive    8.45 dark / 6.79 light   (was 4.33 / 3.87)
//   .theme-seg-btn.active     16.22 dark / 18.27 light  — the step survives
// and the live cascade for each element now reads --text-2 at EVERY rung:
//   .settings-hint-text  shared.css #13 -> sync.css #16 -> settings.css #17
//   .theme-seg-btn                         sync.css #16 -> settings.css #17
// so no copy can win and reintroduce the failure.
const settingsCss = stripComments(readFileSync(join(NEXT, 'views/settings.css'), 'utf8'));

section('§9a  the OWNED copies (inert, but pinned so they cannot rot back)');
ok(/\.settings-hint-text\s*\{[^}]*color:\s*var\(--text-2\)/.test(stripComments(FILES.shared)) &&
   /\.settings-hint-text\s*\{[^}]*color:\s*var\(--text-2\)/.test(stripComments(FILES.sync)),
   'both OWNED copies of .settings-hint-text are --text-2 — they cannot rot back, even while inert');
ok(/\.theme-seg-btn\s*\{[^}]*color:\s*var\(--text-2\)/.test(stripComments(FILES.sync)),
   'the OWNED copy of .theme-seg-btn is --text-2');

section('§9b  the copy the CASCADE LANDS ON — views/settings.css, read never written');
ok(/\.settings-hint-text\s*\{[^}]*color:\s*var\(--text-2\)/.test(settingsCss),
   'INVERTED TRIPWIRE (1/3): views/settings.css paints .settings-hint-text --text-2. This is the copy that ' +
   'RENDERS — it is linked after views/shared.css and views/sync.css at identical specificity — so it is the ' +
   'only one of the three whose value a user ever sees. Measured live after the fix: 8.55 dark / 7.02 light, ' +
   'against 4.38 / 4.00 before it. This assertion used to demand the OPPOSITE, as a tripwire announcing that ' +
   'the owned copies above were inert; it was inverted rather than deleted when settings.css was fixed.');
ok(/\.theme-seg-btn\s*\{[^}]*color:\s*var\(--text-2\)/.test(settingsCss),
   'INVERTED TRIPWIRE (2/3): views/settings.css paints .theme-seg-btn --text-2 — the INACTIVE segment labels, ' +
   'real words on --surface-inset, measured live at 8.45 dark / 6.79 light against 4.33 / 3.87 before. The ' +
   'active/inactive step survives: .theme-seg-btn.active is --text on --surface-raised at 16.22 / 18.27.');
// A count-free presence check would stay green if a SECOND, later --text-3
// declaration for either selector were added lower in the same file: same
// specificity, later wins, and the passing declaration above would be inert in
// exactly the way this whole section exists to record. So the absence is
// asserted too, over the whole file.
ok(!/\.settings-hint-text\s*\{[^}]*color:\s*var\(--text-3\)/.test(settingsCss) &&
   !/\.theme-seg-btn\s*\{[^}]*color:\s*var\(--text-3\)/.test(settingsCss),
   'INVERTED TRIPWIRE (3/3): and --text-3 appears for NEITHER selector anywhere in views/settings.css. ' +
   'Presence of the good value is not enough on its own — a second, later declaration in the same file wins ' +
   'at identical specificity and would make the passing one inert, which is the precise defect this section ' +
   'was created to record.');

section('§9c  POSITIVE CONTROLS — the inverted tripwire can still fire');
ok(!/\.settings-hint-text\s*\{[^}]*color:\s*var\(--text-2\)/.test('.settings-hint-text { color: var(--text-3); }'),
   'CONTROL: assertion 1/3 goes RED on the pre-fix declaration, so it is not vacuously true');
ok(!/\.theme-seg-btn\s*\{[^}]*color:\s*var\(--text-2\)/.test('.theme-seg-btn { color: var(--text-3); }'),
   'CONTROL: assertion 2/3 goes RED on the pre-fix declaration');
ok(/\.settings-hint-text\s*\{[^}]*color:\s*var\(--text-3\)/.test(
     '.settings-hint-text { color: var(--text-2); }\n.foo{}\n.settings-hint-text { color: var(--text-3); }'),
   'CONTROL: the absence half of 3/3 fires on a SECOND, later --text-3 declaration — the exact regression ' +
   'shape a presence-only check would miss');
ok(!/\.settings-hint-text\s*\{[^}]*color:\s*var\(--text-3\)/.test(
     stripComments('/* .settings-hint-text { color: var(--text-3); } */')),
   'CONTROL: ...and does NOT fire on a rule that exists only inside a comment — settings.css\'s own note ' +
   'QUOTES the retired token while explaining why it went');

// ═════════════════════════════════════════════════════════════════════════
section('§10  THE TWO SHARED FIXES IN shell.css, AND THE LOAD ORDER THEY REST ON');

// Two app-wide text failures, both fixed in src/public/next/shell.css:
//
//   .cur-eyebrow            4.38 dark / 4.00 light  ->  8.55 / 7.02
//   .empty-card .empty-body 4.27 dark / 4.14 light  ->  8.34 / 7.26
//
// (Live, 127.0.0.1, 1280px, both themes, all 21 sheets linked, transitions
// frozen with `!important` before any getComputedStyle read — a hidden pane
// throttles timers and never fires rAF, so a transition left running is how a
// previous probe read a stale pre-switch colour. Helper validated by controls
// returning 1.00 on an identical pair and 21.0 on black-on-white, and by a
// 0.13-alpha tint compositing rather than being read as opaque.)
//
// `.cur-eyebrow` is the class behind EVERY eyebrow in the app — the view header
// on all seven views, the four Domains stat-card labels, Sync's "DOMAINS BACKED
// UP" and "History", Memory's "PROJECTS" and "CURRENT HANDOFF" — at 11px, with
// no large-text exemption. It was not one view's failure; it was the same
// failure at roughly twenty sites.
//
// IT IS DECLARED IN tokens/base.css, WHICH IS BYTE-FROZEN — copied from the
// design-system bundle and never edited. So the fix is an OVERRIDE, and an
// override is only real if the cascade lands on it. That is the entire content
// of this section: §9 above records a fix in this same repo that was INERT
// because another sheet redeclared the same selector later at the same
// specificity, and a file-level scan reported it green.
//
// So the load order is asserted FROM index.html, and the sheets linked after
// shell.css are ENUMERATED FROM THAT FILE rather than hardcoded — a hardcoded
// list is how a previous guard in this repo went blind.
//
// NOT ENFORCED, stated rather than implied away:
//  · A SCOPED override (`.foo .cur-eyebrow { color: … }`) in a later sheet is
//    allowed. It out-specifies this rule by design and only affects `.foo`
//    contexts — views/domains.css's `.dm-quick-eyebrow` does exactly that, on
//    purpose, and measures 9.31 dark / 8.84 light. Only a BARE, standalone
//    redeclaration is forbidden, because that is the shape that defeats the
//    fix everywhere at once.
//  · Inline `style=` and JS-set colours are invisible here, as everywhere in
//    this suite.
//  · This still measures nothing. The numbers above came from a browser.
{
  const baseCss = readFileSync(join(NEXT, 'tokens/base.css'), 'utf8');
  const shellCss = readFileSync(join(NEXT, 'shell.css'), 'utf8');
  const indexHtml = readFileSync(join(NEXT, 'index.html'), 'utf8');

  // base.css STILL declares --text-3 here, unchanged and byte-frozen — but the
  // token it names has been repaired, so this is no longer "the problem at
  // source". It is now the design system's correct third-level role, working.
  ok(/\.cur-eyebrow\s*\{[^}]*color:\s*var\(--text-3\)/.test(stripComments(baseCss)),
     'tokens/base.css still declares .cur-eyebrow { color: var(--text-3) }, byte-frozen and untouched. It now ' +
     `measures ${C(D, '--text-3', '--canvas')} dark / ${C(L, '--text-3', '--canvas')} light on --canvas, OVER ` +
     `the ${TEXT_FLOOR} AA floor (4.38 / 4.00 before tokens/color.css was fixed at source). Third level is the ` +
     'correct role for an 11px uppercase metadata label and the system says so; what was broken was the rung, ' +
     'not the role.');

  // ── INVERTED. This used to assert that shell.css OVERRODE the eyebrow to
  // --text-2, and it was the suite's headline fix. The override existed only to
  // escape a rung that failed AA; the rung is fixed, so the override is retired
  // and its ABSENCE is now what is guarded. Re-adding it would flatten ~20
  // eyebrows into the same colour as the body text under them, which is the
  // hierarchy collapse the ramp change exists to undo.
  ok(!/\.cur-eyebrow\s*\{[^}]*color:/.test(stripComments(shellCss)),
     'shell.css NO LONGER overrides .cur-eyebrow. The override was added when --text-3 measured 4.38 / 4.00 and ' +
     `promoted every eyebrow in the app to --text-2; --text-3 is now ${C(D, '--text-3', '--canvas')} / ` +
     `${C(L, '--text-3', '--canvas')} on --canvas and clears the floor on every surface an eyebrow sits on ` +
     `(worst case ${Math.min(C(D, '--text-3', '--surface-raised'), C(D, '--text-3', '--surface-sunken'))} dark / ` +
     `${Math.min(C(L, '--text-3', '--surface-raised'), C(L, '--text-3', '--surface-sunken'))} light), so the ` +
     'byte-frozen base.css value paints and the system\'s own third level is restored. This assertion demanded ' +
     'the OPPOSITE until the ramp was fixed; it was inverted rather than deleted.');
  ok(worst('--text-3', '--canvas') >= TEXT_FLOOR &&
     worst('--text-3', '--surface') >= TEXT_FLOOR &&
     worst('--text-3', '--surface-raised') >= TEXT_FLOOR &&
     worst('--text-3', '--surface-sunken') >= TEXT_FLOOR,
     '...and the retirement is measured, not assumed: --text-3 clears the floor on --canvas, --surface, ' +
     '--surface-raised AND --surface-sunken in both themes. If ANY of those regresses this goes red, which is ' +
     'the signal to fix the token again rather than re-add a per-class rescue.');
  ok(/\.empty-card \.empty-body\s*\{[^}]*color:\s*var\(--text-2\)/.test(stripComments(shellCss)),
     'shell.css paints .empty-card .empty-body --text-2 — the SHARED empty state app.js\'s emptyCard() renders ' +
     'for Ingest, Domains, Shared Brain and Memory, so on a fresh install it is the first sentence a new user ' +
     'reads. It was --text-3, measured live at 4.27 dark / 4.14 light; it is now 8.34 / 7.26.');
  ok(!/\.empty-card \.empty-body\s*\{[^}]*color:\s*var\(--text-3\)/.test(stripComments(shellCss)),
     '...and --text-3 is gone from that rule rather than merely joined by --text-2');

  // ── THE LOAD ORDER, read out of index.html in document order ────────────
  const linked = [...indexHtml.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/g)].map((m) => m[1]);
  const iBase = linked.indexOf('/next/tokens/base.css');
  const iShell = linked.indexOf('/next/shell.css');
  ok(iBase >= 0 && iShell >= 0 && iBase < iShell,
     `index.html links tokens/base.css (#${iBase}) BEFORE shell.css (#${iShell}). Both declarations are ` +
     'specificity (0,1,0), so ORDER is the only thing that decides which one paints. That ordering is what made ' +
     'the retired .cur-eyebrow override work at all, and it is still what .empty-card .empty-body rests on.');

  // Nothing linked AFTER shell.css may redeclare either selector STANDALONE.
  // Enumerated from index.html, never from a hardcoded list.
  const bareRedeclarers = (selector) => {
    const out = [];
    for (const href of linked.slice(iShell + 1)) {
      const rel = href.replace(/^\/next\//, '');
      let css;
      try { css = readFileSync(join(NEXT, rel), 'utf8'); } catch { continue; }
      for (const { sel, body } of rulesOf(css)) {
        if (!/(?:^|;)\s*color\s*:/.test(body)) continue;
        if (sel.split(',').some((s) => s.trim() === selector)) out.push(`${rel} { ${sel} }`);
      }
    }
    return out;
  };
  ok(linked.slice(iShell + 1).length >= 10,
     `CONTROL: there really are sheets after shell.css to scan (${linked.slice(iShell + 1).length}), so the ` +
     'two checks below are not vacuously true because the list is empty');
  for (const sel of ['.cur-eyebrow', '.empty-card .empty-body']) {
    const clashes = bareRedeclarers(sel);
    ok(clashes.length === 0,
       `NO sheet linked after shell.css redeclares \`${sel}\` STANDALONE with a color. Found ${clashes.length}: ` +
       (clashes.join(', ') || 'none') + '. Such a rule wins at identical specificity and would make the shell.css ' +
       'fix INERT everywhere — the exact defect §9 records. A SCOPED override is fine and is not checked here.');
  }

  section('§10a  POSITIVE CONTROLS — every §10 detector is shown to fire');
  // The eyebrow check is now an ABSENCE check, so its control must plant a
  // PRESENCE and watch it fire — both the retired --text-2 form and any other
  // colour, because "someone re-added an override" is the regression, not
  // "someone re-added that exact value".
  ok(/\.cur-eyebrow\s*\{[^}]*color:/.test(stripComments('.cur-eyebrow {\n  color: var(--text-2);\n}')),
     'CONTROL: the eyebrow ABSENCE check fires on the retired override being re-added verbatim');
  ok(/\.cur-eyebrow\s*\{[^}]*color:/.test(stripComments('.cur-eyebrow { color: #fff; }')),
     'CONTROL: ...and on any other colour, since the regression is the override existing at all');
  ok(!/\.cur-eyebrow\s*\{[^}]*color:/.test(stripComments('/* .cur-eyebrow { color: var(--text-2); } */')),
     'CONTROL: ...and NOT on the retirement note this file keeps, which QUOTES the rule while explaining why ' +
     'it went — the comment-stripping trap that has caught a tool in this repo before');
  ok(!/\.cur-eyebrow\s*\{[^}]*color:/.test(stripComments('.cur-eyebrow { margin-bottom: 8px; }')),
     'CONTROL: ...and NOT on a .cur-eyebrow rule that sets no colour, so a future layout tweak is not a failure');
  ok(!/\.empty-card \.empty-body\s*\{[^}]*color:\s*var\(--text-2\)/.test('.empty-card .empty-body { color: var(--text-3); }'),
     'CONTROL: the empty-body check goes RED on the pre-fix declaration');
  {
    // The standalone-redeclaration detector, driven on synthetic CSS through
    // the same rulesOf() the real scan uses.
    const bare = rulesOf('.cur-eyebrow { color: var(--text-3); }')
      .filter((r) => /(?:^|;)\s*color\s*:/.test(r.body) && r.sel.split(',').some((s) => s.trim() === '.cur-eyebrow'));
    const scoped = rulesOf('.dm-quick-eyebrow { color: var(--accent-text); } .foo .cur-eyebrow { color: red; }')
      .filter((r) => /(?:^|;)\s*color\s*:/.test(r.body) && r.sel.split(',').some((s) => s.trim() === '.cur-eyebrow'));
    const inList = rulesOf('.a, .cur-eyebrow { color: red; }')
      .filter((r) => /(?:^|;)\s*color\s*:/.test(r.body) && r.sel.split(',').some((s) => s.trim() === '.cur-eyebrow'));
    const noColor = rulesOf('.cur-eyebrow { margin-bottom: 8px; }')
      .filter((r) => /(?:^|;)\s*color\s*:/.test(r.body) && r.sel.split(',').some((s) => s.trim() === '.cur-eyebrow'));
    ok(bare.length === 1, 'CONTROL: the standalone-redeclaration detector FIRES on a bare later `.cur-eyebrow { color }`');
    ok(scoped.length === 0,
       'CONTROL: ...and does NOT fire on a scoped `.foo .cur-eyebrow` override, nor on views/domains.css\'s ' +
       'deliberate `.dm-quick-eyebrow` re-tone (--accent-text, 9.31 dark / 8.84 light)');
    ok(inList.length === 1, 'CONTROL: ...and DOES fire when the selector appears inside a comma list');
    ok(noColor.length === 0, 'CONTROL: ...and does NOT fire on a later rule that sets no color at all');
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§10b  THE TWO SIDEBAR EMPTY-STATE ROLES — also shell.css, also app-wide');
  // ═══════════════════════════════════════════════════════════════════════
  //
  // Between them these two classes carry six functional empty-state sentences
  // across four views, plus gatedLoader's "Loading…" placeholder:
  //
  //   .sidebar-hint  "No conversations yet in this domain." /
  //                  "No conversations match \u201c…\u201d." (chat.js)
  //   .sidebar-note  "No domains yet. A domain is one compounding wiki…"
  //                  (domains.js), "No domains to back up yet." (sync.js),
  //                  "Not enabled on this install." / "No Shared Brains
  //                  connected yet." (shared.js)
  //
  // Both painted --text-3 and both failed the 4.5 AA text floor. Measured
  // live in the visual harness's own browser at 1280x860 in both themes:
  //
  //   .sidebar-hint  on --surface        4.27 dark / 4.14 light -> 8.34 / 7.26
  //   .sidebar-note  on --surface-inset  4.33 dark / 3.87 light -> 8.45 / 6.79
  //
  // THE BACKDROPS DIFFER AND THAT IS LOAD-BEARING. `.sidebar-note` sets its
  // OWN --surface-inset background, so grading it against --surface — the
  // obvious assumption, and the one this whole suite's header warns about —
  // would have reported 4.14 light where the truth is 3.87. The worse of the
  // two is the one behind the inset box, not the bare line.
  //
  // WHY NOT RELOCATE THEM INSTEAD. v3.22.0's strategy moves MARKETING PROSE
  // out of `.sidebar-hint` rather than recolouring it, and views/domains.js
  // recorded this token as deliberately "untouched" for that reason. That
  // strategy is unchanged and still right — but what survives it in these two
  // classes is not marketing: it is the sentence that says what the empty list
  // in front of you means. It has to live somewhere and has to be readable.
  ok(/\.sidebar-hint\s*\{[^}]*color:\s*var\(--text-2\)/.test(stripComments(shellCss)),
     `shell.css paints .sidebar-hint --text-2 (${C(D, '--text-2', '--surface')} dark / ` +
     `${C(L, '--text-2', '--surface')} light on --surface). It was --text-3 — ` +
     `${C(D, '--text-3', '--surface')} / ${C(L, '--text-3', '--surface')} — under the ${TEXT_FLOOR} floor.`);
  ok(!/\.sidebar-hint\s*\{[^}]*color:\s*var\(--text-3\)/.test(stripComments(shellCss)),
     '...and --text-3 is GONE from that rule rather than merely joined by --text-2 (a presence-only check ' +
     'passes while a second, later declaration in the same rule still wins)');
  ok(/\.sidebar-note\s*\{[^}]*color:\s*var\(--text-2\)/.test(stripComments(shellCss)),
     `shell.css paints .sidebar-note --text-2 against its OWN --surface-inset background ` +
     `(${C(D, '--text-2', '--surface-inset')} dark / ${C(L, '--text-2', '--surface-inset')} light). It was ` +
     `--text-3 — ${C(D, '--text-3', '--surface-inset')} / ${C(L, '--text-3', '--surface-inset')} — and the ` +
     'LIGHT figure is the worse of the two, which grading it against --surface would have hidden.');
  ok(!/\.sidebar-note\s*\{[^}]*color:\s*var\(--text-3\)/.test(stripComments(shellCss)),
     '...and --text-3 is gone from that rule too');

  // The token-level facts these two rest on, asserted rather than assumed.
  // ── INVERTED. Was `< TEXT_FLOOR`, with the label "if a token edit ever makes
  // it pass, this goes RED so nobody keeps routing around a problem that no
  // longer exists". A token edit made it pass, and it did go red. Inverted, and
  // the KEEP decision for these two classes is re-argued on role rather than
  // silently left resting on a floor that no longer binds — see shell.css.
  ok(C(D, '--text-3', '--surface-inset') >= TEXT_FLOOR && C(L, '--text-3', '--surface-inset') >= TEXT_FLOOR,
     `--text-3 on --surface-inset now CLEARS the ${TEXT_FLOOR} floor in BOTH themes ` +
     `(${C(D, '--text-3', '--surface-inset')} / ${C(L, '--text-3', '--surface-inset')}, from 4.33 / 3.87). ` +
     'So --text-2 on .sidebar-hint and .sidebar-note is no longer FORCED by contrast, and both are deliberately ' +
     'kept anyway: an eyebrow is a label and third level is its role (which is why that override was retired), ' +
     'while these carry the one sentence explaining an otherwise empty screen, which is a second-level role on ' +
     'its own merits.');
  ok(C(D, '--text-2', '--surface') >= TEXT_FLOOR && C(L, '--text-2', '--surface') >= TEXT_FLOOR &&
     C(D, '--text-2', '--surface-inset') >= TEXT_FLOOR && C(L, '--text-2', '--surface-inset') >= TEXT_FLOOR,
     '--text-2 clears the floor on BOTH backdrops in BOTH themes — the replacement is not a token swap that ' +
     'merely trades one failure for another');

  // The same standalone-redeclaration hazard §10 exists for. A later bare
  // rule at identical specificity would make both of these inert everywhere.
  for (const sel of ['.sidebar-hint', '.sidebar-note']) {
    const clashes = bareRedeclarers(sel);
    ok(clashes.length === 0,
       `NO sheet linked after shell.css redeclares \`${sel}\` STANDALONE with a color. Found ${clashes.length}: ` +
       (clashes.join(', ') || 'none'));
  }

  section('§10c  POSITIVE CONTROLS — the §10b detectors are shown to fire');
  ok(!/\.sidebar-hint\s*\{[^}]*color:\s*var\(--text-2\)/.test('.sidebar-hint { color: var(--text-3); }'),
     'CONTROL: the .sidebar-hint check goes RED on the pre-fix declaration');
  ok(!/\.sidebar-note\s*\{[^}]*color:\s*var\(--text-2\)/.test('.sidebar-note { color: var(--text-3); }'),
     'CONTROL: the .sidebar-note check goes RED on the pre-fix declaration');
  ok(/\.sidebar-hint\s*\{[^}]*color:\s*var\(--text-3\)/
       .test('.sidebar-hint { color: var(--text-2); color: var(--text-3); }'),
     'CONTROL: the ABSENCE check fires on a rule that keeps --text-2 and appends a later --text-3 — the ' +
     'shape a presence-only assertion cannot see');
}

console.log('\n' + '='.repeat(60));
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ contrast ratchet holds for views/domains.css, views/sync.css, views/shared.css');
