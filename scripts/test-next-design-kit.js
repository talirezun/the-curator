/**
 * test-next-design-kit.js — OFFLINE suite for the material/control layer
 * added in the "Quiet System" design pass (tokens/material.css,
 * shared/switch.css, the shell's control recipes).
 *
 * ── WHY THIS SUITE EXISTS, AND WHAT IT REFUSES TO DO ─────────────────────
 * The design proposal that produced this layer quotes about thirty contrast
 * figures. EVERY ONE OF THEM IS RECOMPUTED HERE FROM THE VALUES ACTUALLY ON
 * DISK, never transcribed. A test that pins `#7C5AF5` passes happily while
 * the PAIRING is wrong; a test that computes cr(--text-on-accent,
 * --accent-hover) fails the day someone lightens the hover rung again, which
 * is precisely the defect (D1) this layer was written to fix.
 *
 * Two of the proposal's own figures did not survive the recomputation and the
 * disagreements are asserted as such rather than quietly adopted:
 *   · the dark focus halo is 3.46:1, not the quoted 3.47 (rounding);
 *   · the SHIPPED light focus ring measured 1.24:1, not the quoted 1.47 —
 *     that figure was computed with alpha 0.24, which is the DARK theme's
 *     --accent-tint-strong. Light's is 0.14. The defect was worse than
 *     claimed, not better.
 *
 * ── THE HELPER IS CONTROLLED BEFORE ANY FIGURE COUNTS ────────────────────
 * §0 asserts 1.00 on an identical pair and 21.00 on black-on-white, because
 * v3.17.3 records a contrast helper in this repo reporting 2.34 for an
 * element genuinely at 7.26. Every threshold section additionally carries an
 * ANTI-VACUITY control: a value known to FAIL is fed to the same comparator
 * and must be reported as failing. A check that cannot fail is not a check.
 *
 * Sections:
 *   0  helper controls
 *   1  theme tables parse, and material.css's own blocks are found
 *   2  focus ring   >= 3:1 non-text floor, both themes (D2)
 *   3  primary label >= 4.5:1 at REST and at HOVER, both themes (D1)
 *   4  danger-solid label >= 4.5:1, and --danger itself would fail (D-fill)
 *   5  --control-edge >= 3:1 against every surface a control rests on (D4),
 *      with the one stated exception measured rather than hidden
 *   6  the specular is a LIT EDGE and not a DRAWN LINE (D3)
 *   7  sidebar plane vs content, in a stated band, both themes
 *   8  switch geometry is derived, not duplicated
 *   9  the two-line material edge appears ONLY on chrome that floats
 *  10  no colour literal in a /next view stylesheet (per-file hex baseline)
 *  11  every interactive rule in the owned files reaches 28px
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const NEXT = path.join(ROOT, 'src/public/next');
const read = (rel) => readFileSync(path.join(NEXT, rel), 'utf8');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function section(t) { console.log(`\n${t}`); }

/* ─────────────────────────────────────────────────────────────────────────
   Parsing. Comments are stripped FIRST and that is load-bearing rather than
   tidy: tokens/material.css's own prose contains the literal string
   `[data-theme="light"]` (it explains the cascade rule that makes the light
   block mandatory), so a bare indexOf on the raw text would locate the light
   block inside a comment and read the wrong table. tokens/color.css has the
   same trap and two other suites already strip for it.
   ───────────────────────────────────────────────────────────────────────── */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '');

function parseTokenBlock(body) {
  const map = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) map[m[1]] = m[2].trim();
  return map;
}

/** The dark table is everything at bare `:root`; light is dark overlaid with
 *  the `[data-theme="light"]` block. Media-query blocks (reduced transparency,
 *  increased contrast, 2dppx) are EXCLUDED — they are degradations, and
 *  grading the shipped design against them would grade the fallback. */
function themeTables(files) {
  const dark = {}, light = {};
  for (const rel of files) {
    let css = stripComments(read(rel));
    // Drop @media blocks wholesale, one nesting level (which is all these
    // files use). Done by scanning braces rather than by regex, because a
    // `[^}]*` would stop at the first inner rule's close.
    css = dropAtRules(css);
    const lightAt = css.indexOf('[data-theme="light"]');
    const head = lightAt < 0 ? css : css.slice(0, lightAt);
    Object.assign(dark, parseTokenBlock(head));
    Object.assign(light, parseTokenBlock(head));
    if (lightAt >= 0) Object.assign(light, parseTokenBlock(css.slice(lightAt)));
  }
  return { dark, light };
}

function dropAtRules(css) {
  let out = '', i = 0;
  while (i < css.length) {
    const at = css.indexOf('@media', i);
    if (at < 0) { out += css.slice(i); break; }
    out += css.slice(i, at);
    let j = css.indexOf('{', at);
    if (j < 0) break;
    let depth = 1; j++;
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
      j++;
    }
    i = j;
  }
  return out;
}

/** Follow `var(--alias)` chains, e.g. --accent-hover -> var(--violet-500). */
function resolve(theme, name, depth = 0) {
  if (depth > 12) return null;
  const v = theme[name];
  if (!v) return null;
  const alias = v.match(/^var\((--[a-z0-9-]+)\)$/);
  return alias ? resolve(theme, alias[1], depth + 1) : v;
}

function toRgb(v) {
  if (!v) return null;
  let m = v.match(/^#([0-9a-f]{3})$/i);
  if (m) return { r: parseInt(m[1][0] + m[1][0], 16), g: parseInt(m[1][1] + m[1][1], 16), b: parseInt(m[1][2] + m[1][2], 16), a: 1 };
  m = v.match(/^#([0-9a-f]{6})$/i);
  if (m) return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16), a: 1 };
  m = v.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)\s*(?:[,/]\s*([\d.]+)\s*)?\)$/i);
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  return null;
}

const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
function ratio(a, b) {
  const L1 = lum(a), L2 = lum(b);
  return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
}
/** Source-over composite. Channels are ROUNDED, because that is what the
 *  engine hands the compositor and what every figure in the design record
 *  was computed against; leaving them as floats moves the third decimal. */
function composite(top, bottom) {
  if (top.a >= 1) return { ...top, a: 1 };
  return {
    r: Math.round(top.r * top.a + bottom.r * (1 - top.a)),
    g: Math.round(top.g * top.a + bottom.g * (1 - top.a)),
    b: Math.round(top.b * top.a + bottom.b * (1 - top.a)),
    a: 1,
  };
}
const r2 = (n) => Math.round(n * 100) / 100;

/** Contrast of token `fg` over token `base`, both resolved in `theme`, with
 *  fg composited over base if it is translucent. Returns null if either name
 *  is missing — a missing token must never silently read as a pass. */
function C(theme, fg, base) {
  const f = toRgb(resolve(theme, fg));
  const b = toRgb(resolve(theme, base));
  if (!f || !b) return null;
  return r2(ratio(composite(f, b), b));
}
/** Same, but `fg` is a literal rgba/hex string rather than a token name. */
function Clit(theme, fgLiteral, base) {
  const f = toRgb(fgLiteral);
  const b = toRgb(resolve(theme, base));
  if (!f || !b) return null;
  return r2(ratio(composite(f, b), b));
}

const TEXT_FLOOR = 4.5;
const NONTEXT_FLOOR = 3;

// ═════════════════════════════════════════════════════════════════════════
section('0. Helper controls — nothing below counts until these pass');
// ═════════════════════════════════════════════════════════════════════════
{
  const grey = { r: 119, g: 119, b: 119, a: 1 };
  ok(r2(ratio(grey, grey)) === 1, 'identical pair measures 1.00');
  ok(r2(ratio({ r: 0, g: 0, b: 0, a: 1 }, { r: 255, g: 255, b: 255, a: 1 })) === 21,
    'black on white measures 21.00');
  const half = composite({ r: 255, g: 255, b: 255, a: 0.5 }, { r: 0, g: 0, b: 0, a: 1 });
  ok(half.r === 128 && half.a === 1, 'composite() blends and returns an opaque colour (got rgb(' + half.r + '))');
  ok(toRgb('rgba(124,90,245,0.85)').a === 0.85 && toRgb('#7C5AF5').r === 124,
    'toRgb parses both rgba() and #rrggbb');
}

// ═════════════════════════════════════════════════════════════════════════
section('1. The theme tables parse, and material.css redefines in BOTH');
// ═════════════════════════════════════════════════════════════════════════
const T = themeTables(['tokens/color.css', 'tokens/material.css']);
const D = T.dark, L = T.light;
const materialCss = read('tokens/material.css');
const materialClean = dropAtRules(stripComments(materialCss));
const matLightAt = materialClean.indexOf('[data-theme="light"]');
const matDark = parseTokenBlock(materialClean.slice(0, matLightAt < 0 ? undefined : matLightAt));
const matLight = matLightAt < 0 ? {} : parseTokenBlock(materialClean.slice(matLightAt));

{
  ok(Object.keys(D).length > 60 && Object.keys(L).length > 60,
    `both theme tables are populated (dark ${Object.keys(D).length}, light ${Object.keys(L).length})`);
  ok(matLightAt > 0, 'material.css has a [data-theme="light"] block OUTSIDE its own comments');
  // Anti-vacuity for the comment-stripping: the raw text contains the light
  // selector inside prose EARLIER than the real block, so a suite that
  // forgot to strip would find it at a smaller index.
  const rawLightAt = materialCss.indexOf('[data-theme="light"]');
  ok(rawLightAt >= 0 && rawLightAt < matLightAt,
    `control: the raw file mentions [data-theme="light"] in PROSE first (raw ${rawLightAt} < cleaned-block ${matLightAt}) — a suite that did not strip comments would read the wrong table`);

  // THE CASCADE RULE. `:root` and `[data-theme="light"]` both have
  // specificity (0,1,0) and material.css is linked AFTER color.css, so any
  // THEMED name defined at bare :root here and NOT restated under
  // [data-theme="light"] would paint its DARK value onto the light theme.
  // "Themed" = anything whose value is a colour, a gradient or a shadow;
  // geometry, motion and type are theme-invariant by design.
  const isThemed = (v) => /#[0-9a-f]{3,8}\b|rgba?\(|linear-gradient|inset |^none$/i.test(v)
    || /^var\(--(violet|ink|red|teal|entity|concept|summary|accent|text|surface|canvas|border|danger)/.test(v);
  const themedDark = Object.keys(matDark).filter((k) => isThemed(matDark[k]));
  const missing = themedDark.filter((k) => !(k in matLight));
  ok(themedDark.length >= 25, `${themedDark.length} themed names are defined at :root in material.css`);
  ok(missing.length === 0,
    missing.length === 0
      ? 'every themed name at :root is RESTATED under [data-theme="light"] — none can leak its dark value into the light theme'
      : 'themed names missing from the light block (their DARK value would paint the light theme): ' + missing.join(', '));
  // Anti-vacuity: the detector must be able to report a miss.
  ok(themedDark.filter((k) => !(k in { ...matLight, '--gloss-shade': undefined })).length === 0
    && isThemed('rgba(0,0,0,0.24)') && !isThemed('7px'),
    'control: the themed-name detector classifies an rgba as themed and a 7px radius as not');
}

// ═════════════════════════════════════════════════════════════════════════
section('2. Focus ring clears the 3:1 non-text floor in BOTH themes (D2)');
// ═════════════════════════════════════════════════════════════════════════
{
  const haloD = resolve(D, '--ring-halo');
  const haloL = resolve(L, '--ring-halo');
  const dOnCanvas = Clit(D, haloD, '--canvas');
  const lOnCanvas = Clit(L, haloL, '--canvas');
  const lOnSurface = Clit(L, haloL, '--surface');
  const dOnRaised = Clit(D, haloD, '--surface-raised');
  ok(dOnCanvas >= NONTEXT_FLOOR, `dark halo over --canvas ${dOnCanvas}:1 >= 3 (recomputed; the proposal quotes 3.47)`);
  ok(lOnCanvas >= NONTEXT_FLOOR, `light halo over --canvas ${lOnCanvas}:1 >= 3`);
  ok(lOnSurface >= NONTEXT_FLOOR, `light halo over --surface ${lOnSurface}:1 >= 3 (the keyline's own backdrop on light)`);
  ok(dOnRaised >= NONTEXT_FLOOR, `dark halo over --surface-raised ${dOnRaised}:1 >= 3 (a focused control inside a card)`);

  // THE DEFECT, MEASURED, so this section cannot pass vacuously: the shipped
  // ring was 3px of --accent-tint-strong, and it must still fail.
  const oldD = Clit(D, resolve(D, '--accent-tint-strong'), '--canvas');
  const oldL = Clit(L, resolve(L, '--accent-tint-strong'), '--canvas');
  ok(oldD < NONTEXT_FLOOR && oldL < NONTEXT_FLOOR,
    `control: the SHIPPED ring (--accent-tint-strong) still measures ${oldD}:1 dark / ${oldL}:1 light — under the floor, which is the defect. ` +
    'Note the light figure: the design proposal quotes 1.47, computed with the DARK theme\'s 0.24 alpha; light\'s is 0.14.');

  // The keyline is load-bearing and must be the surrounding surface, not a
  // third colour: without it the halo abuts the control's own edge and the
  // two read as one fat border rather than as a ring around something.
  ok(/--ring-keyline:\s*var\(--canvas\)/.test(materialClean.slice(0, matLightAt)),
    'dark keyline is --canvas');
  ok(/--ring-keyline:\s*var\(--surface\)/.test(materialClean.slice(matLightAt)),
    'light keyline is --surface (a focused control on light almost always sits on a white card)');
  ok(/--ring-focus:\s*0 0 0 1\.5px var\(--ring-keyline\), 0 0 0 4px var\(--ring-halo\)/.test(materialClean),
    'the ring is keyline-then-halo, in that order — a halo drawn first would be covered by the keyline');
}

// ═════════════════════════════════════════════════════════════════════════
section('3. Primary label clears 4.5:1 at REST and at HOVER, both themes (D1)');
// ═════════════════════════════════════════════════════════════════════════
{
  const rows = [
    ['dark rest',   D, '--text-on-accent', '--accent'],
    ['light rest',  L, '--text-on-accent', '--accent'],
    ['dark hover',  D, '--text-on-accent', '--accent-hover'],
    ['light hover', L, '--text-on-accent', '--accent-hover'],
    ['dark press',  D, '--text-on-accent', '--accent-active'],
    ['light press', L, '--text-on-accent', '--accent-active'],
  ];
  for (const [label, th, fg, bg] of rows) {
    const v = C(th, fg, bg);
    ok(v !== null && v >= TEXT_FLOOR, `white on the primary fill, ${label}: ${v}:1 >= 4.5`);
  }
  // The fill itself must also clear the NON-text floor against the page, or a
  // disabled/greyed primary would vanish.
  ok(C(D, '--accent', '--canvas') >= NONTEXT_FLOOR && C(L, '--accent', '--canvas') >= NONTEXT_FLOOR,
    `the primary FILL vs --canvas: ${C(D, '--accent', '--canvas')}:1 dark / ${C(L, '--accent', '--canvas')}:1 light >= 3`);

  // ANTI-VACUITY, and it is the whole reason this section exists: the value
  // --accent-hover USED to hold on dark must still fail the same comparator.
  const v400 = Clit(D, resolve(D, '--violet-400'), '--accent');
  const white400 = r2(ratio(toRgb('#FFFFFF'), toRgb(resolve(D, '--violet-400'))));
  ok(white400 < TEXT_FLOOR,
    `control: white on --violet-400 (the value --accent-hover held on dark) measures ${white400}:1 and FAILS 4.5 — this is D1, and the comparator can still see it`);
  ok(v400 > 1, 'control: the comparator returns a real number for the old rung too (not a silent null)');

  // AND THE STRUCTURAL HALF: there is no violet in the shipped scale that is
  // lighter than --violet-500 AND clears 4.5 against white. That is what
  // makes "hover cannot lighten the fill on dark" an arithmetic fact rather
  // than a preference, so it is asserted rather than asserted-about.
  const lighter = ['--violet-400', '--violet-300', '--violet-200', '--violet-100']
    .map((n) => ({ n, cr: r2(ratio(toRgb('#FFFFFF'), toRgb(resolve(D, n)))) }))
    .filter((x) => x.cr >= TEXT_FLOOR);
  ok(lighter.length === 0,
    `no violet lighter than --violet-500 clears 4.5:1 against white (checked 4 rungs, ${lighter.length} passed) — so on dark the hover state MUST be carried by the specular and the lift, not by the fill`);
}

// ═════════════════════════════════════════════════════════════════════════
section('4. The solid destructive fill carries its own label');
// ═════════════════════════════════════════════════════════════════════════
{
  const dD = C(D, '--text-on-accent', '--danger-fill');
  const dL = C(L, '--text-on-accent', '--danger-fill');
  ok(dD >= TEXT_FLOOR, `white on --danger-fill, dark: ${dD}:1 >= 4.5`);
  ok(dL >= TEXT_FLOOR, `white on --danger-fill, light: ${dL}:1 >= 4.5`);
  // Control: --danger itself is why --danger-fill had to exist.
  const plainD = C(D, '--text-on-accent', '--danger');
  ok(plainD < TEXT_FLOOR,
    `control: white on --danger (dark) measures ${plainD}:1 and FAILS — which is why a filled destructive button could not simply use it`);
  ok(C(D, '--danger-text', '--surface') >= TEXT_FLOOR && C(L, '--danger-text', '--surface') >= TEXT_FLOOR,
    'and --danger stays correct in its own job: --danger-text on --surface clears 4.5 in both themes, so the TINTED variant is untouched');
}

// ═════════════════════════════════════════════════════════════════════════
section('5. --control-edge carries WCAG 1.4.11 on its own (D4)');
// ═════════════════════════════════════════════════════════════════════════
{
  const surfaces = ['--surface-raised', '--canvas', '--surface', '--surface-hover'];
  for (const s of surfaces) {
    const d = C(D, '--control-edge', s), l = C(L, '--control-edge', s);
    ok(d >= NONTEXT_FLOOR, `--control-edge vs ${s}, dark: ${d}:1 >= 3`);
    ok(l >= NONTEXT_FLOOR, `--control-edge vs ${s}, light: ${l}:1 >= 3`);
  }
  // THE ONE STATED FAILURE, MEASURED RATHER THAN HIDDEN. On dark the edge
  // dips below the floor against --surface-active, which is a control's
  // PRESSED background and is on screen for the ~80ms a pointer is held.
  // Raising the token to clear it would push the RESTING edge to ~3.5:1 —
  // a visibly drawn border on every quiet control, permanently, to fix a
  // transient state. The trade is refused and recorded here so a future
  // reader meets the number rather than the absence of one.
  const pressed = C(D, '--control-edge', '--surface-active');
  ok(pressed < NONTEXT_FLOOR && pressed > 2.8,
    `KNOWN AND ACCEPTED: --control-edge vs --surface-active on dark is ${pressed}:1, under the 3:1 floor, for the ~80ms of a press. --gloss-pressed adds an inner 1px darkening over the same 80ms.`);
  ok(C(L, '--control-edge', '--surface-active') >= NONTEXT_FLOOR,
    `light does not have that dip: ${C(L, '--control-edge', '--surface-active')}:1 >= 3`);

  // Control: --border, the value this replaced, must still fail.
  const oldD = C(D, '--border', '--surface-raised'), oldL = C(L, '--border', '--surface');
  ok(oldD < NONTEXT_FLOOR && oldL < NONTEXT_FLOOR,
    `control: --border measures ${oldD}:1 dark / ${oldL}:1 light against the surfaces a control sits on — which is why it could not be the only boundary of one`);

  // NO NEW HEX: both values are rungs the neutral ramp already ships.
  ok(/--control-edge:\s*var\(--ink-400\)/.test(materialClean) && /--control-edge:\s*var\(--ink-300\)/.test(materialClean),
    'both --control-edge values are existing --ink-* rungs, not new hexes');
}

// ═════════════════════════════════════════════════════════════════════════
section('6. The specular is a LIT EDGE, not a DRAWN LINE (D3)');
// ═════════════════════════════════════════════════════════════════════════
{
  const alphaOf = (decl) => {
    const m = (decl || '').match(/rgba\(255,\s*255,\s*255,\s*([\d.]+)\)/);
    return m ? +m[1] : null;
  };
  const aD = alphaOf(resolve(D, '--gloss-specular'));
  const aL = alphaOf(resolve(L, '--gloss-specular'));
  ok(aD !== null && aL !== null, `both specular alphas parse (dark ${aD}, light ${aL})`);
  const litD = Clit(D, `rgba(255,255,255,${aD})`, '--accent');
  const litL = Clit(L, `rgba(255,255,255,${aL})`, '--accent');
  ok(litD < 2 && litL < 2, `the specular reads as FORM, not as a border: ${litD}:1 dark / ${litL}:1 light against the fill it sits on`);
  ok(Math.abs(litD - litL) <= 0.1,
    `and the two themes are tuned to the same PERCEIVED lift, not the same alpha: ${litD} vs ${litL} (alphas ${aD} vs ${aL})`);

  // Control: the shipped light --inset-hi, landed on a saturated accent, is
  // the defect. It must still measure as a drawn line.
  const shape = themeTables(['tokens/color.css', 'tokens/shape.css']);
  const insetL = alphaOf(resolve(shape.light, '--inset-hi'));
  const drawn = Clit(L, `rgba(255,255,255,${insetL})`, '--accent');
  ok(insetL >= 0.8 && drawn > 4,
    `control: --inset-hi on light is ${insetL} white, which over --accent measures ${drawn}:1 — a drawn line, and the "phantom border" shell.css records`);
  ok(!/--inset-hi\s*:/.test(materialClean),
    'and --inset-hi is NOT redefined by material.css — it is still correct for the light raised surfaces it was authored for; the bug was the pairing, so the fix is on the pairing');
}

// ═════════════════════════════════════════════════════════════════════════
section('7. The sidebar plane, and the cap the type triad puts on it');
// ══════════════════════════════════════════════════════════════════════════
{
  const planeOf = (th) => composite(toRgb(resolve(th, '--mat-sidebar')), toRgb(resolve(th, '--canvas')));
  const planeD = planeOf(D), planeL = planeOf(L);
  const stepD = r2(ratio(planeD, toRgb(resolve(D, '--canvas'))));
  const stepL = r2(ratio(planeL, toRgb(resolve(L, '--canvas'))));

  // DARK gets a real plane. The band's floor is where a step stops being
  // visible; its ceiling is where --control-edge on that plane drops under
  // 3:1 (measured: --ink-750 at 1.17 puts it at 2.92).
  ok(stepD >= 1.06 && stepD <= 1.35, `dark sidebar plane vs content: ${stepD}:1, inside [1.06, 1.35]`);
  const beforeD = r2(ratio(toRgb(resolve(D, '--surface')), toRgb(resolve(D, '--canvas'))));
  ok(beforeD < 1.06,
    `control: BEFORE, the dark chrome sat at --surface against --canvas content and measured ${beforeD}:1 \u2014 under the band, which is the defect`);

  // ── LIGHT IS CAPPED BY THE TYPE TRIAD, AND THE CAP IS DERIVED HERE ──────
  // The first attempt gave light a proper macOS grey sidebar (1.18:1) and
  // scripts/test-next-domain-dots.js caught it: --concept-600 measures
  // 3.22:1 against pure WHITE, 0.22 over the 1.4.11 floor, and the domain
  // list's type dots sit on this exact plane. At 1.18 the concept dot fell
  // to 2.64.
  //
  // So this is NOT a band. It asserts the value is AT THE CEILING, by
  // measuring both sides of it: every critical rung clears 3:1 on the
  // shipped plane, AND a plane one visible step darker would break at least
  // one. That pins the token to the arithmetic instead of to a number
  // somebody typed, and it will move on its own the day the triad is lifted.
  const CRITICAL = ['--type-entity', '--type-concept', '--type-summary', '--text-faint'];
  const onPlane = (th, plane, tok) => r2(ratio(toRgb(resolve(th, tok)), plane));
  const failing = CRITICAL.filter((t) => onPlane(L, planeL, t) < NONTEXT_FLOOR);
  ok(failing.length === 0,
    failing.length === 0
      ? `light plane keeps every critical rung over 3:1 (worst ${Math.min(...CRITICAL.map((t) => onPlane(L, planeL, t)))}:1, ${CRITICAL.length} rungs checked)`
      : 'light plane breaks: ' + failing.map((t) => `${t} ${onPlane(L, planeL, t)}:1`).join(', '));

  const darker = { r: planeL.r - 10, g: planeL.g - 10, b: planeL.b - 10, a: 1 };
  const breaks = CRITICAL.filter((t) => r2(ratio(toRgb(resolve(L, t)), darker)) < NONTEXT_FLOOR);
  ok(breaks.length > 0,
    `and it is AT THE CEILING, not merely safe: 10 points darker would push ${breaks.length} rung(s) under the floor (${breaks.join(', ')}) \u2014 so the light sidebar's separation is carried by the two-line edge, not by the plane`);
  ok(stepL < 1.06,
    `stated consequence: the light plane step is ${stepL}:1 and does NOT improve on the 1.03 it replaced. That is a constraint of the shipped palette (--concept-600 is 3.22:1 against white), recorded rather than worked around.`);

  // The plane must not cost the things that sit ON it.
  ok(r2(ratio(toRgb(resolve(D, '--text-3')), planeD)) >= TEXT_FLOOR,
    `--text-3 on the dark plane: ${r2(ratio(toRgb(resolve(D, '--text-3')), planeD))}:1 >= 4.5`);
  ok(r2(ratio(toRgb(resolve(L, '--text-3')), planeL)) >= TEXT_FLOOR,
    `--text-3 on the light plane: ${r2(ratio(toRgb(resolve(L, '--text-3')), planeL))}:1 >= 4.5`);
  ok(r2(ratio(toRgb(resolve(D, '--control-edge')), planeD)) >= NONTEXT_FLOOR,
    `--control-edge on the dark plane: ${r2(ratio(toRgb(resolve(D, '--control-edge')), planeD))}:1 >= 3 \u2014 this is what caps how far dark can go`);

  // THE TWO-LINE EDGE: the two lines are NOT symmetric, and which one does
  // the work SWAPS between themes. That asymmetry is why both are always
  // drawn and why neither may be dropped as redundant.
  const lipD = r2(ratio(composite(toRgb(resolve(D, '--mat-edge-hi')), planeD), planeD));
  const lipL = r2(ratio(composite(toRgb(resolve(L, '--mat-edge-hi')), planeL), planeL));
  const sepD = Clit(D, resolve(D, '--mat-edge-lo'), '--canvas');
  const sepL = Clit(L, resolve(L, '--mat-edge-lo'), '--canvas');
  ok(Math.max(lipD, sepD) >= 1.15, `dark: the edge is carried by the LIT LIP (${lipD}:1) \u2014 the dark separator is only ${sepD}:1 against a near-black canvas`);
  ok(Math.max(lipL, sepL) >= 1.15, `light: the edge is carried by the DARK SEPARATOR (${sepL}:1) \u2014 the lit lip is only ${lipL}:1 on a near-white plane`);
  ok((lipD > sepD) !== (lipL > sepL),
    'the two lines swap which one does the work between themes \u2014 which is exactly why both are always drawn and neither may be dropped');
}

// ══════════════════════════════════════════════════════════════════════════
section('8. Switch geometry is DERIVED from its tokens, never duplicated');
// ═════════════════════════════════════════════════════════════════════════
{
  const sw = read('shared/switch.css');
  const clean = stripComments(sw);
  const geom = parseTokenBlock(materialClean);
  ok(geom['--switch-w'] === '38px' && geom['--switch-h'] === '22px' && geom['--switch-pad'] === '2px',
    `NSSwitch geometry: ${geom['--switch-w']} x ${geom['--switch-h']}, ${geom['--switch-pad']} track inset`);
  ok(/width:\s*var\(--switch-w\)/.test(clean) && /height:\s*var\(--switch-h\)/.test(clean),
    'the track reads the tokens rather than repeating 38/22');
  ok(/translateX\(calc\(var\(--switch-w\) - var\(--switch-h\)\)\)/.test(clean),
    'the knob\'s TRAVEL is derived (--switch-w - --switch-h), so moving either token moves the travel with it — two hand-maintained copies of one width is this repo\'s recorded drift shape');
  ok(!/\b(38|22)px\b/.test(clean),
    'no bare 38px/22px literal survives anywhere in switch.css');
  ok(/inset:\s*calc\(\(var\(--hit-min\) - var\(--switch-h\)\) \/ -2\) 0/.test(clean),
    'the 28px hit box is derived from --hit-min and --switch-h, not from a magic 3px');

  // TWO CURVES IN ONE GESTURE — the knob travels on the emphasized curve
  // while the track crossfades on the flat one.
  ok(/transform var\(--dur-fast\) var\(--ease-emphasized\)/.test(clean),
    'the knob travels on --ease-emphasized');
  ok(/transition:\s*\n?\s*background-color var\(--t-state\)/.test(clean),
    'while the TRACK crossfades on the flat --t-state — the mismatch is what makes it read as an object');
  ok(/\[aria-checked="true"\]/.test(clean) && !/:checked/.test(clean),
    'state is keyed on aria-checked, so the painted state and the ANNOUNCED state cannot disagree');
}

// ═════════════════════════════════════════════════════════════════════════
section('9. The two-line material edge is on CHROME ONLY');
// ═════════════════════════════════════════════════════════════════════════
{
  // The borrowed device's whole scope rule: a lit lip plus a dark separator
  // says "this is a pane floating over your content". A card, a settings
  // group, a chip and a button are IN the content, and giving them the edge
  // is how a borrowed device becomes decoration.
  const files = walkCss(NEXT);
  const users = [];
  for (const f of files) {
    const css = stripComments(readFileSync(f, 'utf8'));
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/--mat-edge-(hi|lo)/.test(m[2])) continue;
      const sel = m[1].trim().replace(/\s+/g, ' ').split('\n').pop().trim();
      const shadow = (/box-shadow\s*:\s*([^;}]+)/.exec(m[2]) || [])[1] || '';
      // Split on commas that are not inside a function call, so
      // `rgba(0,0,0,.4) 0 1px 2px` stays one layer.
      const layers = []; let depth = 0, cur = '';
      for (const ch of shadow) {
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        if (ch === ',' && depth === 0) { layers.push(cur); cur = ''; } else cur += ch;
      }
      if (cur.trim()) layers.push(cur);
      const layerFor = (tok) => layers.find((l) => l.includes(tok)) || null;
      users.push({
        file: path.relative(NEXT, f),
        sel,
        layers: layers.map((l) => l.trim()),
        hiLayer: layerFor('--mat-edge-hi'),
        loLayer: layerFor('--mat-edge-lo'),
        position: (/(?:^|;)\s*position\s*:\s*([a-z]+)/.exec(m[2]) || [])[1] || 'static',
        hasHi: /--mat-edge-hi/.test(m[2]),
        hasLo: /--mat-edge-lo/.test(m[2]),
        hasMatBg: /background:\s*var\(--mat-(chrome|sidebar|menu|sheet)\)/.test(m[2])
          && /backdrop-filter:\s*blur\(var\(--mat-blur\)\)/.test(m[2]),
      });
    }
  }
  const ALLOWED = ['.rail', '.sidebar', '.lb-menu'];
  const stray = users.filter((u) => !ALLOWED.includes(u.sel));
  ok(users.length >= 3, `${users.length} rule(s) draw the two-line edge`);

  // ── BOTH LINES, ALWAYS — AND THIS WAS FOUND BY A MUTATION COMING BACK
  //    GREEN, NOT BY WRITING IT DOWN FIRST ─────────────────────────────────
  // Deleting `inset -1px 0 0 var(--mat-edge-hi)` from .rail left every
  // assertion in this file passing, because the scan above only asked WHICH
  // RULES mention an edge token, never HOW MANY of the two they mention. §7
  // measures exactly why that is not a detail: on dark the outer separator is
  // 1.02:1 against the canvas and the LIP carries the edge; on light it
  // inverts. A rule with one line has an edge in one theme and none in the
  // other, and nothing on screen says which.
  const oneLine = users.filter((u) => !(u.hasHi && u.hasLo));
  ok(oneLine.length === 0,
    oneLine.length === 0
      ? 'and every one of them draws BOTH lines — a lit inner lip AND a dark outer separator'
      : 'rules drawing only half the edge (they lose it entirely in one theme): '
        + oneLine.map((u) => `${u.file} ${u.sel} [${u.hasHi ? 'hi' : ''}${u.hasLo ? 'lo' : ''}]`).join(', '));

  // ── AND AN EDGE WITHOUT A MATERIAL IS THE DEVICE WITHOUT ITS SUBSTRATE ──
  // Second mutation that came back green: pointing .lb-menu's background back
  // at --surface-overlay while it kept both edge lines. The result is a lit
  // lip and a dark separator drawn around an OPAQUE panel — the borrowed
  // device applied as decoration, which is precisely the failure mode the
  // design record warns about ("a half-built Glass direction reads as trying
  // to look like Tahoe and missing"). The edge is only honest on a surface
  // that is actually a material.
  const noMaterial = users.filter((u) => !u.hasMatBg);
  ok(noMaterial.length === 0,
    noMaterial.length === 0
      ? 'and every one of them sits on an actual --mat-* material with a backdrop-filter, not on an opaque panel'
      : 'edge drawn on a non-material surface: ' + noMaterial.map((u) => u.file + ' ' + u.sel).join(', '));
  ok(stray.length === 0,
    stray.length === 0
      ? 'and every one of them is chrome that floats over content (' + ALLOWED.join(', ') + ')'
      : 'the edge leaked onto content surfaces: ' + stray.map((s) => s.file + ' ' + s.sel).join(', '));
  // Anti-vacuity: the scan must be able to find a violator.
  const fakeStray = [{ sel: '.cur-group' }].filter((u) => !ALLOWED.includes(u.sel));
  ok(fakeStray.length === 1, 'control: the allow-list rejects a content surface (.cur-group) when one is offered');
  {
    // Anti-vacuity for the two checks above: both must be able to fire.
    const half = [{ sel: '.x', hasHi: false, hasLo: true, hasMatBg: true }];
    const bare = [{ sel: '.y', hasHi: true, hasLo: true, hasMatBg: false }];
    ok(half.filter((u) => !(u.hasHi && u.hasLo)).length === 1
       && bare.filter((u) => !u.hasMatBg).length === 1,
      'control: a one-line rule and a material-less rule are BOTH reported when offered — the two mutations that first came back green');
  }

  /* ── AND A DECLARED LINE IS NOT A PAINTED LINE ─────────────────────────
     Everything above asks only whether both lines are DECLARED, and that is
     exactly what let the outer separator ship invisible in every theme on
     every one of these planes for a whole release.

     MEASURED in the running app at 2x: the pixel column immediately outboard
     of .rail and of .sidebar went straight from the lip to the neighbour's
     background. Painting the neighbours transparent brought the separator
     back at 1.33:1 against the plane; raising both on z-index brought both
     separators back. The cause is paint order — #app-shell is a grid,
     `.sidebar` follows `.rail` in DOM order and `.main` is `position:
     relative`, so each neighbour's opaque background covers the gutter an
     OUTER box-shadow paints into.

     The rule is therefore NOT "always inset". `.lb-menu` is `position:
     fixed`, genuinely floats, has no neighbour that can paint over it, and
     keeps its outer separator correctly. What cannot be allowed is a plane
     IN FLOW putting a load-bearing line outside its own box. */
  {
    const inFlow = users.filter((u) => u.position === 'static' || u.position === 'relative');
    ok(inFlow.length >= 2, `${inFlow.length} edge-drawing rule(s) are IN FLOW (a neighbour can paint over their gutter)`);
    const outside = inFlow.filter((u) => !(u.hiLayer && /\binset\b/.test(u.hiLayer))
                                      || !(u.loLayer && /\binset\b/.test(u.loLayer)));
    ok(outside.length === 0,
      outside.length === 0
        ? 'and every line they draw is `inset` — nothing load-bearing is painted into a neighbour\'s box'
        : 'an in-flow plane paints an edge line OUTSIDE its own box, where the neighbour covers it: '
          + outside.map((u) => `${u.file} ${u.sel}`).join(', '));

    // ORDER. Reading outward from the plane the lip comes first and the dark
    // separator sits outermost — the other way round is a dark line inboard
    // of a light one, which reads as a groove rather than as a thickness.
    // With two insets on the same edge the SMALLER offset wins the outermost
    // pixel, so the separator must carry it.
    const offsetOf = (layer) => { const m2 = /-(\d+)px/.exec(layer || ''); return m2 ? +m2[1] : null; };
    for (const u of inFlow) {
      const lo = offsetOf(u.loLayer), hi = offsetOf(u.hiLayer);
      ok(lo !== null && hi !== null && lo < hi,
        `${u.sel}: the separator sits OUTBOARD of the lip (lo at -${lo}px, lip at -${hi}px)`);
    }

    // A floating plane is deliberately exempt, and that exemption is asserted
    // rather than assumed — if .lb-menu ever stops floating, it joins the rule.
    const floating = users.filter((u) => u.position === 'fixed' || u.position === 'absolute');
    ok(floating.length >= 1, `${floating.length} edge-drawing rule(s) float and keep an OUTER separator legitimately (${floating.map((u) => u.sel).join(', ')})`);

    // ANTI-VACUITY: the detector must report the pre-fix declaration.
    const preFix = [{ file: 'x', sel: '.rail', position: 'static',
      loLayer: '1px 0 0 var(--mat-edge-lo)', hiLayer: ' inset -1px 0 0 var(--mat-edge-hi)' }];
    ok(preFix.filter((u) => !(u.hiLayer && /\binset\b/.test(u.hiLayer))
                         || !(u.loLayer && /\binset\b/.test(u.loLayer))).length === 1,
      'control: the detector FIRES on the exact declaration that shipped — `1px 0 0 var(--mat-edge-lo)` outside, lip inset');
    const bothInset = [{ loLayer: 'inset -1px 0 0 var(--mat-edge-lo)', hiLayer: ' inset -2px 0 0 var(--mat-edge-hi)' }];
    ok(bothInset.filter((u) => !/\binset\b/.test(u.hiLayer) || !/\binset\b/.test(u.loLayer)).length === 0,
      'control: and it stays quiet on the corrected pair (so its firing above is a finding, not blindness)');
    // The layer splitter must survive an rgba(), which is what makes a naive
    // `.split(',')` report four layers where there is one.
    const splitProbe = (() => { const sh = 'rgba(0,0,0,0.45) 1px 0 0, inset -1px 0 0 rgba(255,255,255,0.1)';
      const out = []; let d = 0, c = '';
      for (const ch of sh) { if (ch === '(') d++; else if (ch === ')') d--;
        if (ch === ',' && d === 0) { out.push(c); c = ''; } else c += ch; }
      if (c.trim()) out.push(c); return out; })();
    ok(splitProbe.length === 2, `control: the layer splitter reads 2 layers from a shadow containing two rgba()s, not ${'4'} (got ${splitProbe.length})`);
  }

  /* ── ROWS ON A MATERIAL PLANE TAKE AN ALPHA OVERLAY, NOT AN ABSOLUTE ────
     --surface-hover is one rung off --surface and is correct for anything on
     the CONTENT plane. The sidebar is no longer on the content plane, so a
     row inside it that reads --surface-hover has a hover that does nothing:
     measured with a real pointer at 1.03:1 dark and 1.01:1 light, and on dark
     the hover colour is byte-for-byte --mat-sidebar's own declared value.
     The overlays are alphas and therefore step by the same perceived amount
     on any plane. This asserts the arithmetic rather than the token name. */
  {
    const planeOf2 = (th) => composite(toRgb(resolve(th, '--mat-sidebar')), toRgb(resolve(th, '--canvas')));
    const settings = stripComments(readFileSync(path.join(NEXT, 'views/settings.css'), 'utf8'));
    const navHover = /\.settings-nav-row:hover\s*\{([^}]*)\}/.exec(settings);
    ok(navHover && /var\(--mat-row-hover\)/.test(navHover[1]),
      '.settings-nav-row:hover takes the alpha overlay --mat-row-hover, not an absolute surface colour');
    const FLOOR = 1.10;
    for (const [name, th] of [['dark', D], ['light', L]]) {
      const plane = planeOf2(th);
      const hovered = composite(toRgb(resolve(th, '--mat-row-hover')), plane);
      const got = r2(ratio(hovered, plane));
      ok(got >= FLOOR, `${name}: the overlay steps ${got}:1 off the sidebar plane (floor ${FLOOR})`);
      // ANTI-VACUITY, and it is the whole point: the value that SHIPPED must
      // be reported as failing by this same comparator.
      const old = toRgb(resolve(th, '--surface-hover'));
      const wasNever = r2(ratio(old, plane));
      ok(wasNever < FLOOR, `${name}: and --surface-hover on that same plane reads ${wasNever}:1 — below the floor, which is the defect`);
      ok(got > wasNever, `${name}: the overlay is strictly the larger step (${got} > ${wasNever})`);
    }
  }

  // And the inset group — the content-side counterpart — must take ELEVATION
  // and a hairline, never the edge.
  const shell = stripComments(read('shell.css'));
  const group = /\.cur-group\s*\{([^}]*)\}/.exec(shell);
  ok(group && /--elev-1/.test(group[1]) && /--hairline/.test(group[1]) && !/--mat-edge/.test(group[1]),
    '.cur-group is elevation + hairline and carries NO material edge — it is content, not chrome');
}

// ═════════════════════════════════════════════════════════════════════════
section('10. No colour literal in a /next VIEW stylesheet');
// ═════════════════════════════════════════════════════════════════════════
{
  // The recorded discipline: a view names tokens, never colours. Counted per
  // file and BASELINED, because two files carry pre-existing literals whose
  // removal is a separate change with its own diff — a baseline that can only
  // shrink is the ratchet; a baseline that can grow is a wish.
  const BASELINE = {
    // shared/checkbox.css encodes its tick and its dash as data: URIs, and an
    // SVG inside a url() must carry a real colour — there is no var() inside
    // an encoded data URI. Two %23fff, and they are the ONLY ones.
    'shared/checkbox.css': 2,
    // views/domains.css carries eight pre-existing literals, six of them in
    // its own graph-node painting. It belongs to the NEXT phase of this work
    // and is deliberately not touched here — baselining it is the ratchet
    // working as intended, and the count may only ever shrink.
    'views/domains.css': 8,
  };
  const files = walkCss(NEXT).map((f) => path.relative(NEXT, f)).sort();
  const findings = [];
  for (const rel of files) {
    const css = stripComments(read(rel));
    const hexes = (css.match(/#[0-9a-fA-F]{3,8}\b/g) || []).length
      + (css.match(/%23[0-9a-fA-F]{3,8}\b/g) || []).length;
    const allowed = BASELINE[rel] || 0;
    if (hexes > allowed) findings.push(`${rel}: ${hexes} (baseline ${allowed})`);
  }
  ok(findings.length === 0,
    findings.length === 0
      ? `every one of the ${files.length} /next stylesheets outside tokens/ names colours by token (or is baselined)`
      : 'colour literals found: ' + findings.join(', '));
  ok(Object.keys(BASELINE).length === 2,
    'the baseline holds exactly TWO files — adding a third to make this pass is the thing this assertion exists to prevent');
  ok((BASELINE['views/domains.css'] || 0) <= 8,
    "and views/domains.css's entry may only ever SHRINK — those literals are a debt, not a licence");
  // Anti-vacuity.
  ok((stripComments('a{color:#FF0000}').match(/#[0-9a-fA-F]{3,8}\b/g) || []).length === 1
    && (stripComments('/* #FF0000 */ a{color:var(--x)}').match(/#[0-9a-fA-F]{3,8}\b/g) || []).length === 0,
    'control: the scanner counts a real literal and ignores one quoted in a comment');
}

// ═════════════════════════════════════════════════════════════════════════
section('11. Nothing interactive in the owned files is under 28px');
// ═════════════════════════════════════════════════════════════════════════
{
  // macOS's DEFAULT control target is 28x28pt (its minimum is 20x20; iOS's
  // 44pt figure does not apply to a pointer-driven Mac app). Two techniques
  // are accepted and both are here: grow the box (.btn-xs, 26 -> --control-sm)
  // or keep the glyph and grow the TARGET with a transparent ::before
  // (.reader-close, .cur-switch).
  /* shared/text.css JOINED THIS LIST AFTER THE BROWSER FOUND WHAT IT HELD.
     The scan covered three files, and `.tx-vh-info` — the header info button
     on every one of eleven surfaces — was in a fourth. It measured 24x24 with
     a 24x24 POINTER TARGET: no wrapper, no padding, nothing growing it, and
     it is the only thing in its row a pointer can aim at. A scan's file list
     is part of what it asserts, and this one was silently short. */
  const owned = ['shell.css', 'shared/switch.css', 'views/settings.css', 'shared/text.css'];

  // ── WHAT COUNTS AS "A CONTROL", AND THE THREE THINGS DELIBERATELY EXCLUDED
  // The scan grades the element a pointer AIMS AT, which is neither of the
  // two things a naive `height < 28` finds most of:
  //   · a GLYPH inside a control (`.rail-btn svg`, 19px). Growing it would be
  //     the exact opposite of the fix — the target grows, the glyph does not.
  //     Excluded by requiring the selector's LAST simple selector to be the
  //     control itself, never a descendant element.
  //   · a DECORATIVE MARKER (`.provider-dot`, 6px; `.reader-tag-chip`, 24px,
  //     which declares `cursor: default` and has no handler). A 6px dot is
  //     not something anyone clicks, and inflating it to 28 would put a
  //     28px box inside a 24px chip.
  //   · a control that keeps its glyph and grows its TARGET with a
  //     transparent ::before. That is the SANCTIONED technique, so a rule
  //     under 28 passes if and only if the same file declares
  //     `<selector>::before` reading --hit-min.
  /* `info` joins the tail list for the same reason: `.tx-vh-info` is a real
     <button> with a click handler, and the old pattern classified it as
     not-a-control purely because of how it is named. */
  const CONTROL_TAIL = /^\.[a-z0-9-]*(btn|switch|toggle|close|seg|opt|tab|link|row|info)[a-z0-9-]*(:[a-z-]+(\([^)]*\))?)*$/i;
  const isControl = (sel) => {
    const last = sel.split(/\s|>/).filter(Boolean).pop() || '';
    if (/dot|chip|badge|icon|mark|svg/i.test(last)) return false;
    return CONTROL_TAIL.test(last);
  };

  const small = [];
  const bodies = {};
  for (const rel of owned) {
    const css = stripComments(read(rel));
    bodies[rel] = css;
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = m[1].trim().replace(/\s+/g, ' ').split('\n').pop().trim();
      if (sel.includes(',')) continue;               // grouped selectors are graded per-part elsewhere
      if (/::(before|after)/.test(sel)) continue;
      if (!isControl(sel)) continue;
      const h = /(?:^|;|\s)height:\s*(\d+)px/.exec(m[2]);
      if (!h || +h[1] >= 28) continue;
      // The sanctioned escape: a same-file ::before that grows the TARGET.
      const base = sel.replace(/:[a-z-]+(\([^)]*\))?$/g, '');
      const esc = new RegExp(base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '::before\\s*\\{[^}]*--hit-min');
      if (esc.test(css)) continue;
      small.push(`${rel} ${sel} height:${h[1]}px`);
    }
  }
  ok(small.length === 0,
    small.length === 0
      ? 'every control in shell.css / switch.css / settings.css either measures >= 28px or grows its TARGET to --hit-min with a transparent ::before'
      : 'under-target controls with no hit box: ' + small.join(', '));

  // The two hit boxes are real and DERIVED, not decorative.
  ok(/\.reader-close::before\s*\{[^}]*inset:\s*calc\(\(var\(--hit-min\) - 26px\) \/ -2\)/.test(bodies['shell.css']),
    '.reader-close keeps its 26px glyph and grows its target to --hit-min via a transparent ::before');
  ok(/\.tx-vh-info::before\s*\{[^}]*inset:\s*calc\(\(var\(--hit-min\) - 24px\) \/ -2\)/.test(bodies['shared/text.css']),
    '.tx-vh-info keeps its 24px glyph and grows its target to --hit-min via a transparent ::before');
  ok(/\.tx-vh-info\s*\{[^}]*position:\s*relative/.test(bodies['shared/text.css']),
    'and it is positioned, without which that ::before would anchor to some ancestor and grow the wrong box');

  /* ── THE ONE UNDER-TARGET CONTROL LEFT, NAMED RATHER THAN SCANNED PAST ──
     `.cur-check` is 13x13 and the sanctioned technique CANNOT be applied to
     it: an <input> is a replaced element, and Chrome renders no ::before or
     ::after on one. So its target can only be grown by the <label> around
     it, and those labels are split across owners — `.cur-switch-sub` here,
     `.chat-bulk-all` and `.chat-conv-checkbox` in views/chat.css.

     Measured in the running app, the label IS the target and it is wide:
     78x15 in chat, 768x19 in Settings. So this is a control that is short,
     not one with no target — which is why it is recorded as a known figure
     rather than treated as the same defect as a 24x24 button standing alone
     in an 844px row. The assertion below pins the mechanism so the next
     reader does not spend the afternoon trying `.cur-check::before`. */
  {
    const checkbox = stripComments(read('shared/checkbox.css'));
    ok(!/\.cur-check::before/.test(checkbox),
      '.cur-check declares NO ::before hit box — it is an <input>, which renders none (recorded, not fixed)');
  }

  ok(/\.cur-switch::before\s*\{[^}]*var\(--hit-min\)/.test(bodies['shared/switch.css']),
    '.cur-switch keeps its 22pt NSSwitch track and does the same');
  ok(/--hit-min:\s*28px/.test(materialClean),
    "--hit-min is 28px — macOS's DEFAULT control size, not iOS's 44 and not macOS's 20pt minimum");
  ok(/\.btn-xs\s*\{[^}]*height:\s*var\(--control-sm\)/.test(bodies['views/settings.css']),
    '.btn-xs grew its BOX instead (26 -> --control-sm) — it cannot use the ::before trick, because .btn::before is already the gloss face');

  // ── ANTI-VACUITY, three ways, because this scan has three ways to lie ────
  ok(isControl('.x-btn') && isControl('.cur-switch:active'),
    'control: the classifier accepts a control and a control in a state');
  ok(!isControl('.rail-btn svg') && !isControl('.provider-dot') && !isControl('.reader-tag-chip'),
    'control: it rejects a descendant glyph, a decorative dot and a non-interactive chip');
  {
    const probe = 'a{}\n.x-btn{height:20px}';
    const found = [...stripComments(probe).matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((m) => isControl(m[1].trim()) && /height:\s*(\d+)px/.test(m[2]) && +/height:\s*(\d+)px/.exec(m[2])[1] < 28);
    ok(found.length === 1, 'control: a 20px control with no ::before IS reported (the scan can fail)');
    const escaped = '.y-btn{height:20px}\n.y-btn::before{inset:calc((var(--hit-min) - 20px) / -2)}';
    const esc = new RegExp('\\.y-btn::before\\s*\\{[^}]*--hit-min');
    ok(esc.test(escaped), 'control: and the ::before escape is recognised when it is present');
  }
}

// ══════════════════════════════════════════════════════════════════════════
section('12. renderBackgroundMode is EXECUTED, not scanned');
// ══════════════════════════════════════════════════════════════════════════
{
  // ── WHY THIS IS DRIVEN RATHER THAN GREPPED ──────────────────────────────
  // This is the one place the design pass changed BEHAVIOUR rather than
  // paint: a tri-state segmented control became a switch plus a dependent
  // checkbox. The wiring is untouched — wireGlobalListeners still does
  // querySelectorAll('[data-background-mode]') and POSTs dataset value — so
  // every control must still carry a REAL server mode id, and each must send
  // the id it moves TO rather than the one it is in. A source scan cannot see
  // any of that; it would prove the string exists and nothing about what it
  // sends. v3.0.17 records exactly that failure ("a test that proves a line
  // exists proves nothing about what it does").
  //
  // The function is extracted with its label table and evaluated with a fake
  // `state` and a real escapeHtml, the same test-only-seam shape compile.js
  // and ingestMultiPhase use.
  const src = readFileSync(path.join(NEXT, 'views/settings.js'), 'utf8');
  const start = src.indexOf('const BACKGROUND_MODE_LABELS');
  const fnStart = src.indexOf('function renderBackgroundMode()');
  const fnEnd = src.indexOf('\n}\n', fnStart) + 3;
  ok(start > 0 && fnStart > start && fnEnd > fnStart, 'renderBackgroundMode and its label table extract cleanly');
  const make = new Function('state', 'escapeHtml', src.slice(start, fnEnd) + '\nreturn renderBackgroundMode;');
  const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const THREE = ['window', 'tray', 'tray-only'];
  const render = (cfg, saving) => make({ config: cfg, backgroundModeSaving: !!saving }, esc)();
  const targets = (html) => [...html.matchAll(/data-background-mode="([^"]*)"/g)].map((m) => m[1]);

  // 1. Before the config GET lands there is nothing honest to mark active, so
  //    no control renders at all. Unchanged from the segmented version.
  const none = render(null);
  ok(!/role="switch"/.test(none) && !/theme-segmented/.test(none) && targets(none).length === 0,
    'no config yet: renders its label and hint with NO control rather than a control with a guessed selection');

  // 2/3/4. Each control sends the mode it moves TO.
  const off = render({ backgroundModes: THREE, backgroundMode: 'window' });
  ok(/aria-checked="false"/.test(off) && targets(off)[0] === 'tray',
    'OFF: the switch is unchecked and sends `tray` — turning on returns to the mode that KEEPS the Dock icon, because this render has no memory of which on-mode was last used and guessing would silently take it away');
  ok(/type="checkbox"[^>]*disabled|disabled[^>]*type="checkbox"/.test(off) || /<input[^>]*disabled/.test(off),
    'OFF: the dependent checkbox is DISABLED rather than hidden — hiding it makes the row jump on every toggle, and a user who never turns the icon on would never learn the option exists');

  const on = render({ backgroundModes: THREE, backgroundMode: 'tray' });
  ok(/aria-checked="true"/.test(on) && targets(on)[0] === 'window' && targets(on)[1] === 'tray-only',
    'ON: the switch sends `window` (off) and the checkbox sends `tray-only` (hide the Dock)');

  const hidden = render({ backgroundModes: THREE, backgroundMode: 'tray-only' });
  ok(/aria-checked="true"/.test(hidden) && targets(hidden)[0] === 'window' && targets(hidden)[1] === 'tray',
    'ON + Dock hidden: the checkbox now sends `tray` — unchecking restores the Dock icon without turning the facility off');
  // `<input ... checked>`, anchored to the INPUT. A bare /checked/ also matches
  // `aria-checked="true"` on the switch beside it — a test that passes for the
  // wrong reason, and it did, until this line was written properly.
  const inputChecked = (h) => /<input\b[^>]*\schecked\b/.test(h);
  ok(inputChecked(hidden) && !inputChecked(on) && !inputChecked(off),
    'and ONLY that state renders the checkbox as checked');

  // 5. Nothing may be clickable mid-save.
  const saving = render({ backgroundModes: THREE, backgroundMode: 'tray' }, true);
  ok((saving.match(/disabled/g) || []).length >= 2,
    'while a save is in flight BOTH controls are disabled — a <button> and an <input> the browser then refuses to click');

  // 6. THE FALLBACK, which is the assertion that keeps the pair from becoming
  //    the "feature that looks built and silently does nothing" shape: a
  //    server offering any other mode list must still render every mode.
  const two = render({ backgroundModes: ['window', 'tray'], backgroundMode: 'window' });
  ok(!/role="switch"/.test(two) && /theme-segmented/.test(two) && targets(two).join(',') === 'window,tray',
    'an UNKNOWN mode list falls back to the segmented control and renders every mode the server offered — hardcoding the pair would make a new mode unreachable and invisible');

  // 7. Every id emitted is one the server actually named. This is the
  //    protocol assertion: the wiring POSTs dataset.backgroundMode verbatim.
  for (const [name, html] of [['off', off], ['on', on], ['hidden', hidden], ['two', two]]) {
    const bad = targets(html).filter((t) => !THREE.includes(t) && t !== 'window' && t !== 'tray');
    ok(bad.length === 0, `${name}: every data-background-mode value is a real server mode id`);
  }

  // 8. Markup balance, because a stray tag here silently swallows the rest of
  //    the section — and the pair added three nested elements.
  for (const [name, html] of [['none', none], ['off', off], ['on', on], ['hidden', hidden], ['saving', saving], ['two', two]]) {
    const open = (html.match(/<(div|button|label|span|p)\b/g) || []).length + (html.match(/<input\b/g) || []).length;
    const close = (html.match(/<\/(div|button|label|span|p)>/g) || []).length + (html.match(/<input\b/g) || []).length;
    ok(open === close, `${name}: markup is balanced (${open} open / ${close} close)`);
  }

  // Anti-vacuity: the driver must be able to see a difference at all.
  ok(off !== on && on !== hidden,
    'control: the three states render three DIFFERENT strings — the driver is executing the function, not returning a constant');
}

function walkCss(dir) {
  const out = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) {
      if (d.name === 'tokens') continue;   // tokens ARE where colour lives
      out.push(...walkCss(p));
    } else if (d.name.endsWith('.css')) out.push(p);
  }
  return out;
}

console.log('\n────────────────────────────────────────────────────────────');
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ design-kit assertions FAILED'); process.exit(1); }
console.log('✅ All design-kit assertions green');
