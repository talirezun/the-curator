#!/usr/bin/env node
/**
 * test-next-domain-dots.js — OFFLINE suite, zero dependencies, no network,
 * no browser.
 *
 * Guards two findings fixed in views/domains.js + views/domains.css:
 *
 *   1. THE DOMAIN IDENTITY DOTS WERE UNTHEMEABLE. Six raw hex values lived in
 *      `DOMAIN_DOT_PALETTE` and were emitted as `style="background:#3FBFD8"`.
 *      An inline style cannot be reached by any stylesheet or `[data-theme]`
 *      block, so the DARK values were painted in LIGHT too and every dot sat
 *      under WCAG 1.4.11's 3:1 non-text floor there — worst 1.77, and 1.85 for
 *      dot 1 on the selected row, which is the figure CLAUDE.md records.
 *
 *   2. CODE-SHAPED TEXT IN THE HEALTH ROWS MUST BE MONO. `.dm-issue-main`
 *      already carried `mono` at every emission site (the reported "renders in
 *      sans" premise did not survive contact with the source — see NOT
 *      ENFORCED). What was genuinely in the body face was the META column:
 *      `suggests entities/foo` and `→ some-slug` are slugs, and they now sit
 *      in their own `<span class="mono">`.
 *
 * ── WHAT THIS SUITE CANNOT DO. READ THIS FIRST. ──────────────────────────
 * It does not render anything. Every contrast figure below is ARITHMETIC over
 * colour values parsed off disk, joined to a MODEL of which surface each dot
 * sits on. That model is stated explicitly in §5 and was validated once in a
 * real browser (headless Chrome over CDP, both themes, probe controlled at
 * 1.00 on an identical pair and 21.00 on black-on-white); this suite is the
 * RATCHET that stops those numbers rotting back, not the measurement.
 *
 * ── ENFORCED ─────────────────────────────────────────────────────────────
 *  §1 The contrast and CIEDE2000 helpers are validated by controls before any
 *     of their output is trusted.
 *  §2 tokens/color.css parses into two GENUINELY DIFFERENT theme maps. A bare
 *     `indexOf('[data-theme="light"]')` also matches that file's own header
 *     COMMENT, which is how a previous tool in this repo reported both themes
 *     identical; comments are stripped and the maps are compared.
 *  §3 CLASS INVARIANT: no `style=` attribute anywhere in views/domains.js
 *     carries a literal colour. Scanned over the whole file, not a named list.
 *  §4 The dot slots are ENUMERATED BY RUNNING the real `domainDotClass`
 *     extracted from the real source — never a hardcoded list of class names —
 *     and each returned class must have BOTH a default rule and a
 *     `[data-theme="light"]` rule in views/domains.css.
 *  §5 Every slot clears 3:1 against every backdrop a domain row can have, in
 *     BOTH themes. The backdrop list is derived from the `.dm-row` rules on
 *     disk plus `.sidebar` in shell.css, so moving a row's background moves
 *     the check with it.
 *  §6 SEPARABILITY: the six stay tellable apart. Minimum pairwise CIEDE2000
 *     within each theme is asserted against a floor, and the six values are
 *     asserted DISTINCT — a set that passes contrast by converging is a
 *     broken feature, not a fixed one.
 *  §7 Health rows: `renderIssueRow` is EXECUTED for every key in the real
 *     `HEALTH_CATEGORIES` (enumerated from disk) plus an unknown key for the
 *     `default:` branch, the output is parsed with a class-stack tokenizer,
 *     and every code-shaped run — by sentinel AND by shape — must sit inside
 *     an element carrying `mono`.
 *  §8 POSITIVE CONTROLS: every detector in §3–§7 is run against a planted
 *     defect and must FIRE. A detector nobody has watched fail is this repo's
 *     most-recorded defect shape.
 *
 * ── NOT ENFORCED ─────────────────────────────────────────────────────────
 *  · THE CASCADE. This suite reads declarations, it does not resolve
 *    specificity, order or `!important`. A later sheet redeclaring
 *    `.dm-row-dot-1 { background: … }` would win in a browser and pass here.
 *  · THE BACKDROP MODEL. `.dm-row` paints `transparent`, so the unselected
 *    backdrop is taken from `.sidebar`'s `--surface`. A DOM change that nests
 *    the row inside some other painted container is invisible here.
 *  · TRANSLUCENT COLOURS. Every value on this path is opaque today and the
 *    parser REFUSES an `rgba()`/`color-mix()` value rather than guessing at a
 *    composite — refusing is loud, guessing is a wrong verdict.
 *  · WHICH FIELDS ARE CODE-SHAPED. §7's sentinel list is a hand-maintained
 *    judgement about `issue` fields. A NEW branch in `renderIssueRow` reading
 *    a field name the fixture does not supply escapes the sentinel half; the
 *    generic shape half still catches it if the value looks like a path or a
 *    `[[wikilink]]`, and nothing catches a bare new slug field.
 *  · THE ORIGINAL FINDING-2 PREMISE. "`.dm-issue-main` renders paths in sans"
 *    is NOT reproduced: `mono` has been on that span since v3.2.0 (`git log
 *    -S'mono dm-issue-main'` returns exactly the file's introducing commit).
 *    §7 pins the mono treatment so it cannot be lost, but this suite does not
 *    claim to have fixed a defect there, because there was none.
 *  · RENDERING. No layout, no computed style, no paint. See the header.
 */

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { stripComments, functionSource } from './test-helpers/source-scan.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOMAINS_JS = path.join(ROOT, 'src/public/next/views/domains.js');
const DOMAINS_CSS = path.join(ROOT, 'src/public/next/views/domains.css');
const SHELL_CSS = path.join(ROOT, 'src/public/next/shell.css');
const COLOR_CSS = path.join(ROOT, 'src/public/next/tokens/color.css');

const jsRaw = readFileSync(DOMAINS_JS, 'utf8');
const js = stripComments(jsRaw);
const domainsCss = readFileSync(DOMAINS_CSS, 'utf8');
const shellCss = readFileSync(SHELL_CSS, 'utf8');
const colorCss = readFileSync(COLOR_CSS, 'utf8');

let passed = 0, failed = 0;
const ok = (cond, label) => { if (cond) { passed++; console.log(`  ✓ ${label}`); } else { failed++; console.log(`  ✗ ${label}`); } };
const eq = (a, b, label) => ok(a === b, `${label}${a === b ? '' : ` (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`}`);
const section = (t) => console.log(`\n${t}`);

console.log('Domain identity dots + health-row mono — offline guard\n');

// ── colour maths ───────────────────────────────────────────────────────────
function parseHex(h) {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(String(h).trim());
  if (!m) return null;
  const s = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
}
function relLum(rgb) {
  const l = rgb.map((v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
  return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2];
}
function contrast(a, b) {
  const A = relLum(parseHex(a)), B = relLum(parseHex(b));
  const hi = Math.max(A, B), lo = Math.min(A, B);
  return (hi + 0.05) / (lo + 0.05);
}
const r2 = (n) => Math.round(n * 100) / 100;

function toLab(hex) {
  const [r, g, b] = parseHex(hex).map((v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
  let X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  let Y = (0.2126 * r + 0.7152 * g + 0.0722 * b);
  let Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  X = f(X); Y = f(Y); Z = f(Z);
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
}
/** CIEDE2000. Perceptual distance — the honest way to ask "are these two dots
 *  still tellable apart?", which a contrast ratio cannot answer (two colours
 *  of equal luminance have contrast 1.00 and may be wildly different hues). */
function deltaE2000(h1, h2) {
  const [L1, a1, b1] = toLab(h1), [L2, a2, b2] = toLab(h2);
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Math.pow(Cb, 7) / (Math.pow(Cb, 7) + Math.pow(25, 7))));
  const ap1 = (1 + G) * a1, ap2 = (1 + G) * a2;
  const Cp1 = Math.hypot(ap1, b1), Cp2 = Math.hypot(ap2, b2);
  const hf = (b, a) => { if (a === 0 && b === 0) return 0; const h = Math.atan2(b, a) * 180 / Math.PI; return h < 0 ? h + 360 : h; };
  const hp1 = hf(b1, ap1), hp2 = hf(b2, ap2);
  const dLp = L2 - L1, dCp = Cp2 - Cp1;
  let dhp = 0;
  if (Cp1 * Cp2 !== 0) { dhp = hp2 - hp1; if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360; }
  const dHp = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin(dhp * Math.PI / 360);
  const Lbp = (L1 + L2) / 2, Cbp = (Cp1 + Cp2) / 2;
  let hbp;
  if (Cp1 * Cp2 === 0) hbp = hp1 + hp2;
  else { hbp = hp1 + hp2; if (Math.abs(hp1 - hp2) > 180) hbp += (hbp < 360 ? 360 : -360); hbp /= 2; }
  const T = 1 - 0.17 * Math.cos((hbp - 30) * Math.PI / 180) + 0.24 * Math.cos(2 * hbp * Math.PI / 180)
    + 0.32 * Math.cos((3 * hbp + 6) * Math.PI / 180) - 0.20 * Math.cos((4 * hbp - 63) * Math.PI / 180);
  const dth = 30 * Math.exp(-Math.pow((hbp - 275) / 25, 2));
  const Rc = 2 * Math.sqrt(Math.pow(Cbp, 7) / (Math.pow(Cbp, 7) + Math.pow(25, 7)));
  const Sl = 1 + (0.015 * Math.pow(Lbp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbp - 50, 2));
  const Sc = 1 + 0.045 * Cbp, Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(2 * dth * Math.PI / 180) * Rc;
  return Math.sqrt(Math.pow(dLp / Sl, 2) + Math.pow(dCp / Sc, 2) + Math.pow(dHp / Sh, 2) + Rt * (dCp / Sc) * (dHp / Sh));
}

// ── CSS reading ────────────────────────────────────────────────────────────
function stripCssComments(css) { return css.replace(/\/\*[\s\S]*?\*\//g, ''); }

/**
 * Top-level rules only, as {selectors: string[], body: string}. Anything
 * inside an at-rule block (`@media`, `@supports`) is DELIBERATELY skipped
 * rather than flattened — a media-scoped override is a different fact from an
 * unconditional one and silently folding the two together is how a guard ends
 * up asserting something it never checked.
 */
function topLevelRules(css) {
  const src = stripCssComments(css);
  const out = [];
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1) break;
    const prelude = src.slice(i, open).trim();
    let depth = 0, end = -1;
    for (let j = open; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end === -1) break;
    if (!prelude.startsWith('@')) {
      out.push({ selectors: prelude.split(',').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean), body: src.slice(open + 1, end) });
    }
    i = end + 1;
  }
  return out;
}

/** LAST declaration of `prop` among top-level rules naming exactly `selector`. */
function declFor(css, selector, prop) {
  let value = null;
  for (const rule of topLevelRules(css)) {
    if (!rule.selectors.includes(selector)) continue;
    const re = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;}]+)`, 'g');
    let m;
    while ((m = re.exec(rule.body)) !== null) value = m[1].trim();
  }
  return value;
}

/** Custom properties declared inside the LAST top-level rule matching `selector`. */
function tokenMap(css, selector) {
  const map = new Map();
  for (const rule of topLevelRules(css)) {
    if (!rule.selectors.includes(selector)) continue;
    const re = /(--[a-z0-9-]+)\s*:\s*([^;}]+)/gi;
    let m;
    while ((m = re.exec(rule.body)) !== null) map.set(m[1], m[2].trim());
  }
  return map;
}

/**
 * Resolve a value to a hex literal through `var()` chains. `primary` is the
 * theme map, `base` the `:root` map a theme only partially overrides.
 * Returns null on anything that is not an opaque hex — never a guess.
 */
function resolveColor(value, primary, base, seen = new Set()) {
  if (value == null) return null;
  let v = String(value).trim();
  for (let hops = 0; hops < 12; hops++) {
    const m = /^var\(\s*(--[a-z0-9-]+)\s*(?:,[^)]*)?\)$/i.exec(v);
    if (!m) break;
    const name = m[1];
    if (seen.has(name)) return null;              // cycle
    seen.add(name);
    const next = primary.get(name) ?? base.get(name);
    if (next == null) return null;
    v = String(next).trim();
  }
  return parseHex(v) ? v.toUpperCase() : null;
}

// ── §1 helper controls ─────────────────────────────────────────────────────
section('§1 The helpers are controlled before any of their output is believed');
eq(r2(contrast('#123456', '#123456')), 1, 'contrast(identical pair) === 1.00');
eq(r2(contrast('#000000', '#FFFFFF')), 21, 'contrast(black, white) === 21.00');
eq(r2(contrast('#FFFFFF', '#000000')), 21, 'contrast is symmetric');
eq(r2(deltaE2000('#3FBFD8', '#3FBFD8')), 0, 'deltaE2000(identical pair) === 0.00');
eq(r2(deltaE2000('#FFFFFF', '#000000')), 100, 'deltaE2000(white, black) === 100.00');
ok(parseHex('not-a-colour') === null, 'parseHex refuses a non-hex value (null, never a guess)');
ok(parseHex('rgba(0,0,0,0.5)') === null, 'parseHex refuses a translucent value rather than treating it as opaque');

// ── §2 the two theme maps ──────────────────────────────────────────────────
section('§2 tokens/color.css yields two genuinely different theme maps');
const DARK_TOKENS = tokenMap(colorCss, ':root');
const LIGHT_TOKENS = tokenMap(colorCss, '[data-theme="light"]');
ok(DARK_TOKENS.size > 40, `:root declares ${DARK_TOKENS.size} custom properties`);
ok(LIGHT_TOKENS.size > 20, `[data-theme="light"] declares ${LIGHT_TOKENS.size} custom properties`);
{
  // The trap: the file's own header COMMENT contains the literal string
  // `[data-theme="light"]`. Comments are stripped before parsing, and the
  // proof that the two blocks really differ is a value comparison.
  const shared = [...LIGHT_TOKENS.keys()].filter((k) => DARK_TOKENS.has(k));
  const differing = shared.filter((k) => DARK_TOKENS.get(k) !== LIGHT_TOKENS.get(k));
  ok(shared.length > 10, `${shared.length} token names appear in BOTH blocks`);
  ok(differing.length > 10, `${differing.length} of them hold DIFFERENT values — the light block is real, not a comment match`);
  eq(resolveColor('var(--surface)', DARK_TOKENS, DARK_TOKENS), '#0C0C14', '--surface resolves dark');
  eq(resolveColor('var(--surface)', LIGHT_TOKENS, DARK_TOKENS), '#FFFFFF', '--surface resolves light');
}

// ── §3 no inline colour anywhere in views/domains.js ───────────────────────
section('§3 CLASS INVARIANT — no style= attribute in views/domains.js carries a colour');
/**
 * Enumerates every `style="…"` / `style='…'` attribute literal in the file and
 * flags any whose value contains a hex, an rgb()/hsl() function, or a CSS
 * colour keyword on a paint property. Not a list of known offenders: the
 * scan is the whole file.
 */
function inlineColorStyles(source) {
  const out = [];
  const re = /style\s*=\s*(["'])([^"']*)\1/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const val = m[2];
    if (/#[0-9a-fA-F]{3,8}\b/.test(val) || /\b(?:rgba?|hsla?|color-mix)\s*\(/i.test(val)) out.push(val);
  }
  return out;
}
{
  const offenders = inlineColorStyles(js);
  eq(offenders.length, 0, `zero inline-colour style attributes${offenders.length ? `: ${offenders.join(' | ')}` : ''}`);
  // Anti-vacuity: the scanner must actually be finding style attributes to
  // look at, or "zero offenders" means only that the regex stopped matching.
  const anyStyleAttrs = (js.match(/style\s*=\s*(["'])[^"']*\1/g) || []).length;
  ok(anyStyleAttrs > 0, `the scanner does see ${anyStyleAttrs} style= attribute(s) in this file (so 0 offenders is a reading, not a silence)`);
  ok(!/DOMAIN_DOT_PALETTE/.test(js), 'the old DOMAIN_DOT_PALETTE hex array is gone from the source');
}

// ── §4 the slots, enumerated by RUNNING the real class picker ──────────────
section('§4 Dot slots enumerated by executing the real domainDotClass');
let domainDotClass = null, slotCount = null;
{
  const fnSrc = functionSource(js, 'domainDotClass');
  ok(fnSrc !== null, 'domainDotClass extracted from views/domains.js');
  const slotDecl = /const\s+DOMAIN_DOT_SLOTS\s*=\s*(\d+)/.exec(js);
  ok(slotDecl !== null, 'DOMAIN_DOT_SLOTS declared in views/domains.js');
  if (fnSrc && slotDecl) {
    slotCount = Number(slotDecl[1]);
    domainDotClass = new Function(`const DOMAIN_DOT_SLOTS = ${slotCount};\n${fnSrc}\nreturn domainDotClass;`)();
  }
  ok(typeof domainDotClass === 'function', 'domainDotClass runs in a sandbox');
  // Pinned to a LITERAL, not read back off the constant the code uses.
  eq(slotCount, 6, 'six identity slots (the design gives each domain a stable colour by list position)');
}
const SLOT_CLASSES = [];
if (domainDotClass && slotCount) {
  for (let i = 0; i < slotCount; i++) SLOT_CLASSES.push(domainDotClass(i));
  const unique = new Set(SLOT_CLASSES);
  eq(unique.size, slotCount, 'every slot yields a DISTINCT class');
  eq(domainDotClass(slotCount), SLOT_CLASSES[0], 'the picker wraps around at the slot count');
  eq(domainDotClass(slotCount * 3 + 2), SLOT_CLASSES[2], 'and keeps wrapping for a long domain list');
}
{
  // The call site itself — a function with no callers proves nothing (this
  // repo's root cause 3).
  const rowFn = functionSource(js, 'renderSidebar') || js;
  ok(/domainDotClass\(/.test(js), 'domainDotClass has a call site');
  ok(/class="dm-row-dot '?\s*\+\s*domainDotClass\(/.test(js) || /dm-row-dot[^"]*"\s*\+\s*domainDotClass\(/.test(js),
    'the dot span composes its class from domainDotClass, with no style= attribute');
  ok(!/dm-row-dot[^>]*style\s*=/.test(js), 'the dot span carries no style attribute at all');
  void rowFn;
}

// ── §5 contrast, both themes, every backdrop a row can have ────────────────
section('§5 Every dot clears the 3:1 non-text floor, both themes, every row state');
/**
 * THE BACKDROP MODEL, stated so it can be argued with:
 *   · `.dm-row` paints `transparent`, so an ordinary row's backdrop is the
 *     nearest painted ancestor — `.sidebar`, which paints `--surface`.
 *   · `.dm-row:hover`   paints `--surface-hover`.
 *   · `.dm-row.active`  paints `--surface-active`  ← the worst case, and the
 *     one an arithmetic check against `--surface` alone would miss (2.17 vs
 *     the 1.85 a browser reads on the selected row).
 * All three are READ OFF DISK below rather than hardcoded, so a change to any
 * of those rules moves this check with it.
 */
const BACKDROP_TOKENS = [];
{
  const rowBg = declFor(domainsCss, '.dm-row', 'background');
  eq(rowBg, 'transparent', '.dm-row paints `transparent` (so the sidebar is the real backdrop)');
  const sidebarBg = declFor(shellCss, '.sidebar', 'background');
  ok(sidebarBg !== null, `.sidebar background read from shell.css (${sidebarBg})`);
  const hoverBg = declFor(domainsCss, '.dm-row:hover', 'background');
  const activeBg = declFor(domainsCss, '.dm-row.active', 'background');
  ok(hoverBg !== null, `.dm-row:hover background read from disk (${hoverBg})`);
  ok(activeBg !== null, `.dm-row.active background read from disk (${activeBg})`);
  BACKDROP_TOKENS.push(['row on sidebar', sidebarBg], ['row hovered', hoverBg], ['row SELECTED', activeBg]);
}

const FLOOR_NON_TEXT = 3.0;
const THEMES = [
  { name: 'dark', selectorFor: (cls) => `.${cls}`, tokens: DARK_TOKENS },
  { name: 'light', selectorFor: (cls) => `[data-theme="light"] .${cls}`, tokens: LIGHT_TOKENS },
];
const resolvedSlots = { dark: [], light: [] };
for (const theme of THEMES) {
  for (const cls of SLOT_CLASSES) {
    const decl = declFor(domainsCss, theme.selectorFor(cls), 'background');
    ok(decl !== null, `${theme.name}: .${cls} has a background declaration (${theme.selectorFor(cls)})`);
    const hex = decl === null ? null : resolveColor(decl, theme.tokens, DARK_TOKENS);
    ok(hex !== null, `${theme.name}: .${cls} resolves to an opaque hex (${decl} -> ${hex})`);
    if (hex) resolvedSlots[theme.name].push({ cls, hex });
  }
}
for (const theme of THEMES) {
  eq(resolvedSlots[theme.name].length, slotCount, `${theme.name}: all ${slotCount} slots resolved`);
  for (const { cls, hex } of resolvedSlots[theme.name]) {
    for (const [label, token] of BACKDROP_TOKENS) {
      const bg = resolveColor(token, theme.tokens, DARK_TOKENS);
      ok(bg !== null, `${theme.name}: backdrop "${label}" resolves (${token} -> ${bg})`);
      if (!bg) continue;
      const cr = contrast(hex, bg);
      ok(cr >= FLOOR_NON_TEXT, `${theme.name}: .${cls} ${hex} on ${label} ${bg} = ${r2(cr)} >= ${FLOOR_NON_TEXT}`);
    }
  }
}
{
  // RATCHET on the worst reading in each theme, pinned to LITERALS taken from
  // the browser measurement. A palette edit that quietly walks a dot toward
  // the floor moves this number and is reported even while it still passes.
  const worst = (name) => {
    let lo = Infinity, at = '';
    for (const { cls, hex } of resolvedSlots[name]) {
      for (const [label, token] of BACKDROP_TOKENS) {
        const bg = resolveColor(token, name === 'dark' ? DARK_TOKENS : LIGHT_TOKENS, DARK_TOKENS);
        if (!bg) continue;
        const cr = contrast(hex, bg);
        if (cr < lo) { lo = cr; at = `.${cls} on ${label}`; }
      }
    }
    return { lo: r2(lo), at };
  };
  const wLight = worst('light'), wDark = worst('dark');
  eq(wLight.lo, 3.44, `light: worst dot reads 3.44 (${wLight.at})`);
  eq(wDark.lo, 6.77, `dark: worst dot reads 6.77 (${wDark.at}) — unchanged by this fix`);
}

// ── §6 separability ────────────────────────────────────────────────────────
section('§6 The six stay tellable apart — contrast fixed by convergence is not fixed');
const DE_FLOOR = 10;
for (const name of ['dark', 'light']) {
  const set = resolvedSlots[name].map((s) => s.hex);
  eq(new Set(set).size, set.length, `${name}: all six values are distinct`);
  let min = Infinity, pair = '';
  for (let i = 0; i < set.length; i++) {
    for (let j = i + 1; j < set.length; j++) {
      const d = deltaE2000(set[i], set[j]);
      if (d < min) { min = d; pair = `${set[i]} vs ${set[j]}`; }
    }
  }
  ok(min >= DE_FLOOR, `${name}: minimum pairwise CIEDE2000 is ${r2(min)} (${pair}) >= ${DE_FLOOR} — well over the ~2.3 JND`);
}

// ── §7 health rows: code-shaped text is mono ───────────────────────────────
section('§7 Health rows — every path, slug and [[wikilink]] renders in mono');
/** Minimal HTML tokenizer that tracks the CLASS STACK, so a nested
 *  `<span class="mono">` inside a sans parent is attributed correctly. A
 *  regex over `<span …>(.*?)</span>` cannot do that and would mis-report the
 *  meta column, which is exactly the element this section is about. */
function textRuns(html) {
  const runs = [];
  const stack = [];
  let i = 0, buf = '';
  const flush = () => {
    if (buf.trim()) runs.push({ text: buf, classes: stack.flatMap((f) => f.classes) });
    buf = '';
  };
  while (i < html.length) {
    if (html[i] === '<') {
      flush();
      const end = html.indexOf('>', i);
      if (end === -1) break;
      const tag = html.slice(i + 1, end);
      if (tag.startsWith('/')) stack.pop();
      else if (!tag.endsWith('/')) {
        const cm = /class\s*=\s*(["'])([^"']*)\1/.exec(tag);
        stack.push({ classes: cm ? cm[2].split(/\s+/).filter(Boolean) : [] });
      }
      i = end + 1;
      continue;
    }
    buf += html[i];
    i++;
  }
  flush();
  return runs;
}
{
  const runs = textRuns('<span class="a"><span class="mono">X</span> Y</span>');
  eq(runs.length, 2, 'tokenizer control: two text runs from a nested span');
  ok(runs[0].classes.includes('mono') && runs[0].text.includes('X'), 'tokenizer control: the nested run carries mono');
  ok(!runs[1].classes.includes('mono') && runs[1].text.includes('Y'), 'tokenizer control: the outer run does not');
}

let renderIssueRow = null, HEALTH_KEYS = [];
{
  const fnSrc = functionSource(js, 'renderIssueRow');
  ok(fnSrc !== null, 'renderIssueRow extracted from views/domains.js');
  if (fnSrc) {
    renderIssueRow = new Function(
      'escapeHtml',
      `${fnSrc}\nreturn renderIssueRow;`
    )((s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'));
  }
  ok(typeof renderIssueRow === 'function', 'renderIssueRow runs in a sandbox');

  // ENUMERATED FROM DISK — the category list is read out of the real
  // HEALTH_CATEGORIES, so a seventh category added tomorrow is exercised here
  // without anybody remembering to add it.
  const m = /const\s+HEALTH_CATEGORIES\s*=\s*\[/.exec(js);
  ok(m !== null, 'HEALTH_CATEGORIES located in views/domains.js');
  if (m) {
    const open = js.indexOf('[', m.index);
    let depth = 0, end = -1;
    for (let i = open; i < js.length; i++) {
      if (js[i] === '[') depth++;
      else if (js[i] === ']') { depth--; if (depth === 0) { end = i; break; } }
    }
    const arr = new Function(`return ${js.slice(open, end + 1)};`)();
    HEALTH_KEYS = arr.map((c) => c.key);
  }
  ok(HEALTH_KEYS.length >= 6, `${HEALTH_KEYS.length} health categories enumerated from disk: ${HEALTH_KEYS.join(', ')}`);
}

/** Sentinels chosen so every code-shaped one is unmistakable in the output.
 *  `type` is DELIBERATELY prose ("concept") — it is a word, not a slug, and
 *  demanding mono for it would be the opposite error. */
const SENTINEL_ISSUE = {
  sourceFile: 'entities/zz-src-page.md',
  linkText: 'zz-link-target',
  path: 'concepts/zz-orphan-page.md',
  type: 'concept',
  keep: 'entities/zz-keep.md',
  remove: 'concepts/zz-remove.md',
  files: ['entities/zz-var-a.md', 'entities/zz-var-b.md'],
  suggestedSlug: 'zz-suggested-slug',
  suggestedTarget: 'entities/zz-suggested-target.md',
  summary: 'summaries/zz-summary.md',
  entity: 'entities/zz-entity.md',
};
const CODE_SHAPED_FIELDS = ['sourceFile', 'linkText', 'path', 'keep', 'remove', 'suggestedSlug', 'suggestedTarget', 'summary', 'entity'];
const PROSE_FIELDS = ['type'];

/** Returns [] when clean, or a list of offences. Shared with §8's controls. */
function monoOffences(renderer, keys) {
  const bad = [];
  for (const key of [...keys, 'zzUnknownCategoryForTheDefaultBranch']) {
    const html = renderer(key, { ...SENTINEL_ISSUE, ...(key === 'hyphenVariants' ? {} : {}) }, false);
    const runs = textRuns(html);
    // (a) sentinel half — every code-shaped VALUE that appears must be mono.
    for (const field of CODE_SHAPED_FIELDS) {
      const value = SENTINEL_ISSUE[field];
      const needles = Array.isArray(value) ? value : [value];
      for (const needle of needles) {
        for (const run of runs) {
          if (!run.text.includes(needle)) continue;
          if (!run.classes.includes('mono')) bad.push(`${key}: ${field} "${needle}" rendered outside mono`);
        }
      }
    }
    // (b) shape half — anything that LOOKS like a path or a wikilink, whatever
    //     field it came from, including fields this fixture never supplied.
    for (const run of runs) {
      if (run.classes.includes('mono')) continue;
      const shapes = run.text.match(/\[\[[^\]]+\]\]|[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+/g) || [];
      for (const s of shapes) bad.push(`${key}: code-shaped "${s}" rendered outside mono`);
    }
    // (c) the container itself.
    for (const run of runs) {
      if (run.classes.includes('dm-issue-main') && !run.classes.includes('mono')) {
        bad.push(`${key}: .dm-issue-main is not mono`);
      }
    }
  }
  return bad;
}
if (renderIssueRow && HEALTH_KEYS.length) {
  const bad = monoOffences(renderIssueRow, HEALTH_KEYS);
  eq(bad.length, 0, `zero code-shaped runs in the body face across ${HEALTH_KEYS.length + 1} row types${bad.length ? `:\n      ${bad.join('\n      ')}` : ''}`);
  // Anti-vacuity: prove the checker actually saw sentinels, or "0 offences"
  // could just mean the renderer returned nothing recognisable.
  let seen = 0;
  for (const key of HEALTH_KEYS) {
    const runs = textRuns(renderIssueRow(key, SENTINEL_ISSUE, false));
    for (const run of runs) for (const f of CODE_SHAPED_FIELDS) if (run.text.includes(SENTINEL_ISSUE[f])) seen++;
  }
  ok(seen >= 6, `the checker actually found ${seen} code-shaped sentinel run(s) to judge`);
  // And the prose field is NOT forced into mono — a rule that monos everything
  // is not the typographic rule, it is the absence of one.
  const orphanRuns = textRuns(renderIssueRow('orphans', SENTINEL_ISSUE, false));
  const typeRun = orphanRuns.find((r) => r.text.trim() === SENTINEL_ISSUE.type);
  ok(typeRun && !typeRun.classes.includes('mono'), `the orphan row's prose "${PROSE_FIELDS[0]}" word stays in the body face`);
}
{
  // Every SOURCE emission of dm-issue-main carries mono — the executed check
  // above only covers rows renderIssueRow builds, and there are others
  // (the dismissed list, the semantic-dupe handled rows).
  const classAttrs = js.match(/class="([^"]*dm-issue-main[^"]*)"/g) || [];
  ok(classAttrs.length >= 3, `${classAttrs.length} dm-issue-main emission sites found in source`);
  const sansSites = classAttrs.filter((a) => !/\bmono\b/.test(a));
  eq(sansSites.length, 0, `every dm-issue-main emission carries mono${sansSites.length ? `: ${sansSites.join(' | ')}` : ''}`);
}

// ── §7b the cascade half of the mono rule ──────────────────────────────────
section('§7b — nothing in views/domains.css can out-declare shell.css\'s .mono');
{
  // `.mono { font-family: var(--font-mono) }` lives in shell.css, and
  // views/domains.css is linked AFTER it at EQUAL specificity — so a single
  // `.dm-issue-main { font-family: … }` in this file would silently win and
  // §7's structural check would still be green. That is the "a CSS fix can be
  // inert" shape v3.23.0 records, pointed the other way.
  const indexHtml = readFileSync(path.join(ROOT, 'src/public/next/index.html'), 'utf8');
  const order = [...indexHtml.matchAll(/href="([^"]+\.css)"/g)].map((m) => m[1]);
  const shellAt = order.findIndex((h) => h.endsWith('/shell.css'));
  const viewAt = order.findIndex((h) => h.endsWith('/views/domains.css'));
  ok(shellAt >= 0 && viewAt >= 0, `both sheets are linked (shell #${shellAt}, domains #${viewAt})`);
  ok(viewAt > shellAt, 'views/domains.css loads AFTER shell.css — so an equal-specificity font-family here would WIN');
  const monoRule = declFor(shellCss, '.mono', 'font-family');
  eq(monoRule, 'var(--font-mono)', 'shell.css .mono still declares var(--font-mono) — the rule everything above relies on');

  // Every class the executed renderer pairs with `mono` must be free of a
  // font-family declaration in this view's own sheet.
  const monoPartners = new Set();
  if (renderIssueRow && HEALTH_KEYS.length) {
    for (const key of HEALTH_KEYS) {
      for (const run of textRuns(renderIssueRow(key, SENTINEL_ISSUE, false))) {
        if (!run.classes.includes('mono')) continue;
        for (const c of run.classes) if (c !== 'mono') monoPartners.add(c);
      }
    }
  }
  ok(monoPartners.size > 0, `${monoPartners.size} class(es) ride alongside mono on health rows: ${[...monoPartners].join(', ')}`);
  for (const cls of monoPartners) {
    const ff = declFor(domainsCss, `.${cls}`, 'font-family');
    ok(ff === null, `views/domains.css declares no font-family for .${cls}${ff ? ` (found "${ff}", which would beat .mono)` : ''}`);
  }
}

// ── §8 positive controls ───────────────────────────────────────────────────
section('§8 POSITIVE CONTROLS — every detector is watched failing');
{
  const planted = 'html += \'<span class="dm-row-dot" style="background:#3FBFD8"></span>\';';
  ok(inlineColorStyles(planted).length === 1, '§3 detector FIRES on a planted inline background hex');
  ok(inlineColorStyles('el.setAttribute("style", "width:8px")').length === 0, '§3 detector does NOT fire on a colourless inline style');
  ok(inlineColorStyles('<span style="color: rgba(1,2,3,.5)">').length === 1, '§3 detector FIRES on an inline rgba() too');
}
{
  const cssMissingLight = '.dm-row-dot-1 { background: var(--entity-500); }';
  ok(declFor(cssMissingLight, '[data-theme="light"] .dm-row-dot-1', 'background') === null,
    '§4 detector FIRES when a slot has no [data-theme="light"] rule');
  ok(declFor('[data-theme="light"] .dm-row-dot-1 { background: #16768C; }', '[data-theme="light"] .dm-row-dot-1', 'background') === '#16768C',
    '§4 detector reads a present light rule (so its null above is a finding, not blindness)');
  // The comment trap, planted: a rule named only inside a CSS comment must NOT
  // be read as a rule.
  ok(declFor('/* [data-theme="light"] .dm-row-dot-9 { background: #FFF; } */', '[data-theme="light"] .dm-row-dot-9', 'background') === null,
    '§4 detector is not satisfied by a selector that appears only in a CSS comment');
}
{
  const failing = resolveColor('var(--entity-500)', LIGHT_TOKENS, DARK_TOKENS);   // the OLD light value
  const lightSurfaceActive = resolveColor('var(--surface-active)', LIGHT_TOKENS, DARK_TOKENS);
  const cr = contrast(failing, lightSurfaceActive);
  ok(cr < FLOOR_NON_TEXT, `§5 detector FIRES on the pre-fix value: ${failing} on ${lightSurfaceActive} = ${r2(cr)} < 3.0`);
  eq(r2(cr), 1.85, 'and it reproduces the 1.85 figure CLAUDE.md records for this exact pairing');
}
{
  const converged = ['#16768C', '#16768D', '#438126', '#925E13', '#C33345', '#63637A'];
  let min = Infinity;
  for (let i = 0; i < converged.length; i++) for (let j = i + 1; j < converged.length; j++) min = Math.min(min, deltaE2000(converged[i], converged[j]));
  ok(min < DE_FLOOR, `§6 detector FIRES on a converged palette (min ΔE ${r2(min)}) — six passing-but-identical dots are a broken feature`);
}
{
  // §7 controls: a renderer that drops mono from the main span, and one that
  // puts a slug in the sans meta column — the exact shape this change fixed.
  const sansMain = (type, issue) => `<div class="dm-issue-row"><span class="dm-issue-main">${issue.sourceFile} → [[${issue.linkText}]]</span></div>`;
  const sansMeta = (type, issue) => `<div class="dm-issue-row"><span class="mono dm-issue-main">${issue.path}</span><span class="dm-issue-meta">suggests ${issue.suggestedTarget}</span></div>`;
  const clean = (type, issue) => `<div class="dm-issue-row"><span class="mono dm-issue-main">${issue.path}</span><span class="dm-issue-meta">suggests <span class="mono">${issue.suggestedTarget}</span></span></div>`;
  ok(monoOffences(sansMain, ['brokenLinks']).length > 0, '§7 detector FIRES when .dm-issue-main loses mono');
  ok(monoOffences(sansMeta, ['brokenLinks']).length > 0, '§7 detector FIRES when the meta column renders a slug in the body face');
  ok(monoOffences(clean, ['brokenLinks']).length === 0, '§7 detector stays quiet on the corrected shape (so its firing above is a finding)');
  const plantedSheet = '.dm-issue-main { font-size: 11px; font-family: var(--font-sans); }';
  ok(declFor(plantedSheet, '.dm-issue-main', 'font-family') === 'var(--font-sans)',
    '§7b detector FIRES on a planted sans font-family for a mono-carrying class');
  ok(declFor('.dm-issue-main { font-size: 11px; }', '.dm-issue-main', 'font-family') === null,
    '§7b detector does NOT fire on a rule with no font-family (so its firing above is a finding)');
}

console.log(`\nPassed: ${passed}   Failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
