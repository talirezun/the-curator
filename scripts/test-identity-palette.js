#!/usr/bin/env node
/**
 * scripts/test-identity-palette.js — THE IDENTITY PALETTE, PINNED BY EXECUTION (v3.66.0)
 *
 * The domain palette exists twice by necessity: as CSS custom properties the
 * browser paints (`--id-1` … `--id-12` in tokens/identity.css) and as data the
 * macOS menubar widget reads (shared/identity-palette.js, re-exported from
 * src/brain/identity-palette.js — Electron's main process cannot read CSS).
 * This suite is what makes that ONE palette rather than two:
 *
 *   §2  the CSS and the module agree slot by slot, theme by theme, and the
 *       slot count is ONE constant that sidebar.js and the widget both read;
 *   §3  every hue clears 3.3:1 on every app surface a dot sits on (3:1 plus
 *       the design's margin), and 3:1 on the widget's menu bands — surfaces
 *       RESOLVED FROM THE TOKEN FILES, composited through the material planes,
 *       never typed in here;
 *   §4  SEPARATION FROM THE OTHER CHANNELS: ΔE00 ≥ 20 from every freshness,
 *       tone and danger ink in the same theme (until v3.66.0 four slots WERE
 *       those inks, ΔE 0.0), ≥ 10 from the accent and the page-type triad;
 *   §5  the slots stay tellable apart — nested floors, 15 over slots 1–8 and
 *       7.5 over all twelve — and one hue per slot across both themes;
 *   §6  the page-TYPE inks did not move with the palette;
 *   §7  a figure printed ON an identity-toned depth bar keeps 4.5:1;
 *   §8  every detector above is watched failing on a planted palette.
 *
 * A future palette edit that drops a slot under any floor reds here, with the
 * number, before it ships. Offline, no network, no DOM.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  IDENTITY_SLOTS, IDENTITY_PALETTE, identitySlot, identityHex,
} from '../src/public/next/shared/identity-palette.js';
import * as BRAIN from '../src/brain/identity-palette.js';
import { IDENTITY_DOT_SLOTS, identityDotClass } from '../src/public/next/shared/sidebar.js';
import { MENU_BG_BAND } from '../desktop/lib/rgba-png.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NEXT = path.join(ROOT, 'src/public/next');
const read = (rel) => readFileSync(path.join(NEXT, rel), 'utf8');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + msg); return true; }
  failed++;
  console.log('  \x1b[31m✗\x1b[0m ' + msg + (detail === undefined ? '' : ' — ' + String(detail).slice(0, 400)));
  return false;
}
const eq = (msg, got, want) => ok(got === want, msg, 'got ' + JSON.stringify(got) + ', wanted ' + JSON.stringify(want));
const section = (t) => console.log('\n\x1b[1m' + t + '\x1b[0m');
const r2 = (n) => Math.round(n * 100) / 100;

// ── colour maths (same formulas as scripts/test-next-domain-dots.js) ───────
function parseHex(h) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(String(h).trim());
  return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : null;
}
const lin = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
function relLum(rgb) { const l = rgb.map(lin); return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2]; }
function contrast(a, b) {
  const A = relLum(parseHex(a)), B = relLum(parseHex(b));
  return (Math.max(A, B) + 0.05) / (Math.min(A, B) + 0.05);
}
function toLab(hex) {
  const [r, g, b] = parseHex(hex).map(lin);
  let X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  let Y = (0.2126 * r + 0.7152 * g + 0.0722 * b);
  let Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  X = f(X); Y = f(Y); Z = f(Z);
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
}
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
/** OKLCH hue in degrees (Björn Ottosson's matrices). */
function oklchHue(hex) {
  const [r, g, b] = parseHex(hex).map(lin);
  const L = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const M = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const S = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const A = 1.9779984951 * L - 2.4285922050 * M + 0.4505937099 * S;
  const B = 0.0259040371 * L + 0.7827717662 * M - 0.8086757660 * S;
  const h = Math.atan2(B, A) * 180 / Math.PI;
  return h < 0 ? h + 360 : h;
}
const hueGap = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

// ── CSS reading ────────────────────────────────────────────────────────────
const stripCss = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
/** Custom properties of every TOP-LEVEL rule whose selector list is exactly `sel`
 *  (at-rule blocks skipped: a degradation is not the shipped design). */
function tokenMap(css, sel) {
  const src = stripCss(css);
  const map = new Map();
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
    if (!prelude.startsWith('@') && prelude.split(',').map((s) => s.trim()).includes(sel)) {
      for (const m of src.slice(open + 1, end).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+)/gi)) map.set(m[1], m[2].trim());
    }
    i = end + 1;
  }
  return map;
}
function resolveRaw(value, T, base) {
  let v = String(value == null ? '' : value).trim();
  const seen = new Set();
  for (let hops = 0; hops < 12; hops++) {
    const m = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i.exec(v);
    if (!m) break;
    if (seen.has(m[1])) return null;
    seen.add(m[1]);
    const next = T.get(m[1]) ?? base.get(m[1]);
    if (next == null) return null;
    v = String(next).trim();
  }
  return v;
}
function parseRgba(v) {
  const hex = parseHex(v);
  if (hex) return { r: hex[0], g: hex[1], b: hex[2], a: 1 };
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)\s*(?:[,/]\s*([\d.]+)\s*)?\)$/i.exec(String(v || '').trim());
  return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
}
function over(top, bottomHex) {
  const b = parseRgba(bottomHex);
  const ch = (t, u) => Math.round(t * top.a + u * (1 - top.a));
  const h2 = (n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
  return ('#' + h2(ch(top.r, b.r)) + h2(ch(top.g, b.g)) + h2(ch(top.b, b.b))).toUpperCase();
}
/** A token -> the opaque hex a pixel ends up, compositing a translucent value
 *  onto `bottom` (default: the theme's --canvas). Null on anything else. */
function surface(name, T, base, bottom = null) {
  const raw = resolveRaw(`var(${name})`, T, base);
  const c = parseRgba(raw);
  if (!c) return null;
  if (c.a >= 1) return raw.toUpperCase();
  const floor = bottom || surface('--canvas', T, base);
  return floor ? over(c, floor) : null;
}

const COLOR = read('tokens/color.css');
const MATERIAL = read('tokens/material.css');
const IDENTITY = read('tokens/identity.css');
const TOKENS = `${COLOR}\n${MATERIAL}\n${IDENTITY}`;   // index.html's link order
const DARK = tokenMap(TOKENS, ':root');
const LIGHT = tokenMap(TOKENS, '[data-theme="light"]');
const THEMES = [['dark', DARK], ['light', LIGHT]];

// ═════════════════════════════════════════════════════════════════════════
section('§1 — the maths is controlled before any of its output is believed');
// ═════════════════════════════════════════════════════════════════════════
eq('contrast(identical pair) = 1.00', r2(contrast('#123456', '#123456')), 1);
eq('contrast(black, white) = 21.00', r2(contrast('#000000', '#FFFFFF')), 21);
eq('ΔE00(identical) = 0', r2(deltaE2000('#86CDFF', '#86CDFF')), 0);
eq('ΔE00(white, black) = 100', r2(deltaE2000('#FFFFFF', '#000000')), 100);
eq('OKLCH hue of pure red is ~29°', Math.round(oklchHue('#FF0000')), 29);
eq('compositing 50% white over black is #808080', over({ r: 255, g: 255, b: 255, a: 0.5 }, '#000000'), '#808080');
ok(DARK.size > 40 && LIGHT.size > 20, `both theme tables parse (${DARK.size} / ${LIGHT.size} names)`);
ok(surface('--mat-sidebar', DARK, DARK) !== null && resolveRaw('var(--mat-sidebar)', DARK, DARK).startsWith('rgba'),
  'the sidebar plane is translucent and IS composited (so the row figures below grade what the screen shows)');

// ═════════════════════════════════════════════════════════════════════════
section('§2 — ONE PALETTE: the CSS, the module and the widget address agree');
// ═════════════════════════════════════════════════════════════════════════
eq('IDENTITY_SLOTS is 12 (the orchestrator\'s choice; 8 would be a one-line change)', IDENTITY_SLOTS, 12);
ok(Number.isInteger(IDENTITY_SLOTS) && IDENTITY_SLOTS >= 1 && IDENTITY_SLOTS <= IDENTITY_PALETTE.dark.length,
  'the slot count never exceeds the hues the palette carries');
eq('shared/sidebar.js\'s IDENTITY_DOT_SLOTS IS that constant (not a second copy)', IDENTITY_DOT_SLOTS, IDENTITY_SLOTS);
ok(BRAIN.IDENTITY_PALETTE === IDENTITY_PALETTE && BRAIN.IDENTITY_SLOTS === IDENTITY_SLOTS
  && BRAIN.identityHex === identityHex && BRAIN.identitySlot === identitySlot,
  'src/brain/identity-palette.js re-exports the SAME objects the browser loads — the widget cannot drift');
eq('the palette carries 12 hues per theme', `${IDENTITY_PALETTE.dark.length}/${IDENTITY_PALETTE.light.length}`, '12/12');
ok(Object.isFrozen(IDENTITY_PALETTE) && Object.isFrozen(IDENTITY_PALETTE.dark) && Object.isFrozen(IDENTITY_PALETTE.light),
  'the palette is frozen, so a caller cannot recolour a domain at runtime');
{
  const mismatches = [];
  for (const [name, T] of THEMES) {
    IDENTITY_PALETTE[name].forEach((hex, i) => {
      const css = T.get(`--id-${i + 1}`);
      if (!css || css.toUpperCase() !== hex.toUpperCase()) mismatches.push(`${name} slot ${i + 1}: css ${css} vs module ${hex}`);
    });
  }
  ok(mismatches.length === 0, 'tokens/identity.css and the module agree, slot by slot, in BOTH themes', mismatches.join(' | '));
  const extra = [...DARK.keys(), ...LIGHT.keys()].filter((k) => /^--id-\d+$/.test(k) && Number(k.slice(5)) > 12);
  eq('no thirteenth slot is declared in CSS without the module knowing', extra.join(','), '');
}
{
  // The mapping: dot class, widget hex and slot are one arithmetic.
  let agree = true;
  for (let i = -3; i < 50; i++) {
    const s = identitySlot(i);
    if (identityDotClass(i) !== 'cur-sb-dot-' + s) agree = false;
    if (identityHex(i, 'light') !== IDENTITY_PALETTE.light[s - 1]) agree = false;
    if (identityHex(i, 'dark') !== IDENTITY_PALETTE.dark[s - 1]) agree = false;
  }
  ok(agree, 'identityDotClass, identitySlot and identityHex agree for indices -3…49');
  eq('index 0 is slot 1', identitySlot(0), 1);
  eq('a 7th domain gets slot 7 (it repeated slot 1 until v3.66.0)', identitySlot(6), 7);
  eq('and the palette wraps at IDENTITY_SLOTS', identitySlot(IDENTITY_SLOTS), 1);
  eq('a non-number is slot 1, never NaN', identitySlot(undefined), 1);
  eq('an unknown theme reads as dark, never undefined', identityHex(0, 'sepia'), IDENTITY_PALETTE.dark[0]);
}
{
  // THE SLOT RULES PAINT THE TOKENS — every slot the palette carries has one.
  const sb = stripCss(read('shared/sidebar.css'));
  const miss = [];
  for (let n = 1; n <= IDENTITY_PALETTE.dark.length; n++) {
    if (!new RegExp(`\\.cur-sb-dot-${n}\\s*\\{\\s*background:\\s*var\\(--id-${n}\\);\\s*\\}`).test(sb)) miss.push(n);
  }
  eq('shared/sidebar.css paints .cur-sb-dot-N from var(--id-N) for every slot', miss.join(','), '');
  ok(/<link[^>]*href="\/next\/tokens\/identity\.css"/.test(read('index.html').replace(/<!--[\s\S]*?-->/g, '')),
    'tokens/identity.css is LINKED (comments stripped, so a commented-out link does not count)');
  const html = read('index.html').replace(/<!--[\s\S]*?-->/g, '');
  ok(html.indexOf('tokens/identity.css') > html.indexOf('tokens/color.css')
    && html.indexOf('tokens/identity.css') > html.indexOf('tokens/material.css')
    && html.indexOf('tokens/identity.css') < html.indexOf('shared/sidebar.css'),
    '...after color.css and material.css (its light block must win the tie) and before the kit that reads it');
}

// ═════════════════════════════════════════════════════════════════════════
section('§3 — LEGIBLE: ≥ 3.3:1 on every app surface a dot sits on, ≥ 3:1 on the menu bands');
// ═════════════════════════════════════════════════════════════════════════
const APP_FLOOR = 3.3;
const MENU_FLOOR = 3.0;
function appSurfaces(T) {
  const plain = surface('--surface', T, DARK);
  const side = surface('--mat-sidebar', T, DARK);
  return {
    surface: plain,
    raised: surface('--surface-raised', T, DARK),
    active: surface('--surface-active', T, DARK),
    inset: surface('--surface-inset', T, DARK),
    'sidebar plane': side,
    'row hovered': surface('--mat-row-hover', T, DARK, side),
    'row SELECTED': surface('--mat-row-active', T, DARK, side),
    'chip (accent tint)': surface('--accent-tint', T, DARK, plain),
  };
}
const worst = {};
for (const [name, T] of THEMES) {
  const S = appSurfaces(T);
  const unresolved = Object.entries(S).filter(([, v]) => !v).map(([k]) => k);
  eq(`${name}: every surface resolves from the tokens`, unresolved.join(','), '');
  let lo = Infinity, at = '', menuLo = Infinity, menuAt = '';
  const fails = [];
  IDENTITY_PALETTE[name].forEach((hex, i) => {
    for (const [k, bg] of Object.entries(S)) {
      if (!bg) continue;
      const c = contrast(hex, bg);
      if (c < lo) { lo = c; at = `slot ${i + 1} ${hex} on ${k} ${bg}`; }
      if (c < APP_FLOOR) fails.push(`slot ${i + 1} on ${k} ${r2(c)}`);
    }
    for (const bg of MENU_BG_BAND[name]) {
      const c = contrast(hex, bg);
      if (c < menuLo) { menuLo = c; menuAt = `slot ${i + 1} ${hex} on ${bg}`; }
      if (c < MENU_FLOOR) fails.push(`slot ${i + 1} on menu ${bg} ${r2(c)}`);
    }
  });
  ok(fails.length === 0, `${name}: all 12 slots clear ${APP_FLOOR}:1 in the app and ${MENU_FLOOR}:1 in the menu`, fails.join(' | '));
  worst[name] = { app: r2(lo), at, menu: r2(menuLo), menuAt };
  console.log(`    ${name}: worst app ${r2(lo)} (${at}); worst menu ${r2(menuLo)} (${menuAt})`);
}
// RATCHETS on the worst readings — the design pass's published figures
// (3.58 light / 3.69 dark app, 3.03 dark menu) reproduced from the tokens.
// A palette edit that walks a slot toward the floor moves these and is
// reported while it still passes.
eq('light: the worst app reading is 3.60 (slot 2 olive on the selected row)', worst.light.app, 3.6);
eq('dark: the worst app reading is 3.69 (slot 9 purple on the selected row)', worst.dark.app, 3.69);
eq('dark: the worst menu reading is 3.03 (slot 9 on the #3A3A3C band)', worst.dark.menu, 3.03);
eq('light: the worst menu reading is 3.46 (slot 2 on the #DCDCDC band)', worst.light.menu, 3.46);

// ═════════════════════════════════════════════════════════════════════════
section('§4 — SEPARATE FROM EVERY OTHER CHANNEL: time, tone, danger, accent, page type');
// ═════════════════════════════════════════════════════════════════════════
const HARD = ['--fresh-hot', '--fresh-mid', '--fresh-cold', '--danger', '--danger-text', '--success-text', '--attention-text'];
const SOFT = ['--accent', '--accent-text', '--type-entity', '--type-concept', '--type-summary'];
const HARD_FLOOR = 20;
const SOFT_FLOOR = 10;
function separation(palette, T) {
  const hard = [], soft = [];
  let hardLo = Infinity, softLo = Infinity;
  palette.forEach((hex, i) => {
    for (const tok of HARD) {
      const ink = surface(tok, T, DARK);
      const d = deltaE2000(hex, ink);
      hardLo = Math.min(hardLo, d);
      if (d < HARD_FLOOR) hard.push(`slot ${i + 1} vs ${tok} ${ink} ΔE ${r2(d)}`);
    }
    for (const tok of SOFT) {
      const ink = surface(tok, T, DARK);
      const d = deltaE2000(hex, ink);
      softLo = Math.min(softLo, d);
      if (d < SOFT_FLOOR) soft.push(`slot ${i + 1} vs ${tok} ${ink} ΔE ${r2(d)}`);
    }
  });
  return { hard, soft, hardLo, softLo };
}
for (const [name, T] of THEMES) {
  const unresolved = [...HARD, ...SOFT].filter((t) => !surface(t, T, DARK));
  eq(`${name}: every reference ink resolves`, unresolved.join(','), '');
  const s = separation(IDENTITY_PALETTE[name], T);
  ok(s.hard.length === 0, `${name}: every slot is ΔE00 ≥ ${HARD_FLOOR} from every freshness, tone and danger ink `
    + `(closest ${r2(s.hardLo)}) — a domain dot can never be read as "recent", "ok", "warn" or "danger"`, s.hard.join(' | '));
  ok(s.soft.length === 0, `${name}: and ≥ ${SOFT_FLOOR} from the accent and the page-type triad (closest ${r2(s.softLo)})`,
    s.soft.join(' | '));
}

// ═════════════════════════════════════════════════════════════════════════
section('§5 — TELLABLE APART: nested floors, and one hue per slot in both themes');
// ═════════════════════════════════════════════════════════════════════════
function minPair(set) {
  let lo = Infinity, at = '';
  for (let i = 0; i < set.length; i++) for (let j = i + 1; j < set.length; j++) {
    const d = deltaE2000(set[i], set[j]);
    if (d < lo) { lo = d; at = `${i + 1}↔${j + 1}`; }
  }
  return { lo, at };
}
for (const [name] of THEMES) {
  const p = IDENTITY_PALETTE[name];
  eq(`${name}: twelve DISTINCT hues`, new Set(p.map((h) => h.toUpperCase())).size, 12);
  const a = minPair(p.slice(0, 8));
  ok(a.lo >= 15, `${name}: slots 1–8 min pairwise ΔE00 ${r2(a.lo)} (${a.at}) ≥ 15 — as separable as the old six`);
  const b = minPair(p);
  ok(b.lo >= 7.5, `${name}: all 12 min pairwise ΔE00 ${r2(b.lo)} (${b.at}) ≥ 7.5 — the documented floor for 9–12`);
}
{
  const drift = [];
  for (let i = 0; i < 12; i++) {
    const g = hueGap(oklchHue(IDENTITY_PALETTE.dark[i]), oklchHue(IDENTITY_PALETTE.light[i]));
    if (g > 2) drift.push(`slot ${i + 1} ${r2(g)}°`);
  }
  ok(drift.length === 0, 'ONE OKLCH hue per slot across both themes (≤ 2°) — a theme toggle never moves a domain to another family',
    drift.join(', '));
}

// ═════════════════════════════════════════════════════════════════════════
section('§6 — the page-TYPE inks did not move with the palette');
// ═════════════════════════════════════════════════════════════════════════
{
  eq('light --type-ink-entity/-concept/-summary are v3.65.1\'s values',
    ['--type-ink-entity', '--type-ink-concept', '--type-ink-summary'].map((t) => surface(t, LIGHT, DARK)).join(','),
    '#16768C,#438126,#925E13');
  eq('dark: they alias the design bundle\'s type triad, byte for byte',
    ['--type-ink-entity', '--type-ink-concept', '--type-ink-summary'].map((t) => surface(t, DARK, DARK)).join(','),
    ['--type-entity', '--type-concept', '--type-summary'].map((t) => surface(t, DARK, DARK)).join(','));
  const dom = stripCss(read('views/domains.css'));
  ok(/\.dm-stat-entity\s*\{\s*color:\s*var\(--type-ink-entity\)/.test(dom)
    && /\.dm-stat-concept\s*\{\s*color:\s*var\(--type-ink-concept\)/.test(dom)
    && /\.dm-stat-summary\s*\{\s*color:\s*var\(--type-ink-summary\)/.test(dom),
    'the Domains OVERVIEW figures read the TYPE inks, not the identity palette');
  ok(!/--id-ink-/.test(stripCss(COLOR + MATERIAL + IDENTITY + read('shared/sidebar.css') + read('views/domains.css'))),
    'the retired, misnamed --id-ink-* is declared and read nowhere');
}

// ═════════════════════════════════════════════════════════════════════════
section('§7 — a figure printed ON an identity-toned depth bar keeps 4.5:1');
// ═════════════════════════════════════════════════════════════════════════
{
  const css = stripCss(read('shared/depth-bar.css'));
  const m = /\.cur-depth-id-1\s*\{\s*background:\s*color-mix\(in srgb,\s*var\(--id-1\)\s*(\d+)%,\s*transparent\)/.exec(css);
  ok(!!m, 'the identity tone is a color-mix of the slot ink over transparent', css.slice(0, 120));
  const alpha = m ? Number(m[1]) / 100 : 0.24;
  const bad = [];
  let lo = Infinity, at = '';
  for (const [name, T] of THEMES) {
    const text = surface('--text', T, DARK);
    for (const bgTok of ['--surface', '--surface-inset']) {
      const bg = surface(bgTok, T, DARK);
      IDENTITY_PALETTE[name].forEach((hex, i) => {
        const [r, g, b] = parseHex(hex);
        const fill = over({ r, g, b, a: alpha }, bg);
        const c = contrast(text, fill);
        if (c < lo) { lo = c; at = `${name} slot ${i + 1} on ${bgTok}`; }
        if (c < 4.5) bad.push(`${name} slot ${i + 1} on ${bgTok}: ${r2(c)}`);
      });
    }
  }
  ok(bad.length === 0, `--text on every identity bar composite is ≥ 4.5:1 (worst ${r2(lo)}, ${at})`, bad.join(' | '));
}

// ═════════════════════════════════════════════════════════════════════════
section('§8 — POSITIVE CONTROLS: every detector above is watched failing');
// ═════════════════════════════════════════════════════════════════════════
{
  // §4: the v3.65.1 palette, planted, must fail the channel separation.
  const old = { dark: ['#3FBFD8', '#79C752', '#E0A33A', '#2FB88A', '#F87F8D', '#A8A8BC'],
    light: ['#16768C', '#438126', '#925E13', '#1E8F69', '#C33345', '#63637A'] };
  const sD = separation(old.dark, DARK);
  ok(sD.hard.length > 0 && r2(sD.hardLo) === 0,
    `§4 FIRES on the v3.65.1 palette — it finds ΔE 0.00 (a slot that WAS a freshness/danger ink): ${sD.hard.length} violations`);
  // §3: a slot that is legible in the app but not on a dark menu band.
  ok(contrast('#5A3FA0', MENU_BG_BAND.dark[2]) < MENU_FLOOR, '§3 FIRES on a dark violet against the #3A3A3C menu band');
  // §5: a converged set.
  ok(minPair(['#4588F7', '#4A8CF5', '#86CDFF']).lo < 7.5, '§5 FIRES on two near-identical blues');
  // §5: a slot that changes family between themes.
  ok(hueGap(oklchHue('#86CDFF'), oklchHue('#7A2A06')) > 2, '§5 hue check FIRES when a slot turns sky -> brown');
  // §2: a CSS/module mismatch is visible to the comparison.
  const planted = tokenMap(':root { --id-1: #000000; }', ':root');
  ok(planted.get('--id-1') !== IDENTITY_PALETTE.dark[0], '§2 comparison sees a planted CSS value that disagrees');
  // §2: the parser is not satisfied by a comment.
  eq('§2 parser ignores a slot declared only inside a comment',
    tokenMap(':root { /* --id-1: #86CDFF; */ }', ':root').get('--id-1'), undefined);
}

console.log('\n  ' + '─'.repeat(60));
console.log('  Passed: ' + passed + '   Failed: ' + failed);
if (failed) { console.log('  \x1b[31m❌ identity palette\x1b[0m'); process.exit(1); }
console.log('  \x1b[32m✅ one domain, one colour — and never a colour another channel owns\x1b[0m');
