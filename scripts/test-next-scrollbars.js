/**
 * test-next-scrollbars.js — OFFLINE suite guarding the app-wide scrollbar
 * treatment in src/public/next/shell.css.
 *
 * ── What was reported, and what it actually was ─────────────────────────
 * "A divider you can hold with the mouse and drive up and down — too thick,
 * not within our design concept." It is NOT a divider and NOT a resizer;
 * there is no resizer anywhere in /next. It was the OS scrollbar, unstyled:
 * before this change nothing in the tree styled scrollbars at all except
 * chat.css's deliberate HIDE on .chat-scopebar, so macOS painted its own
 * classic bar — measured at 15px with a filled grey track.
 *
 * ── The four regressions this suite exists to catch ─────────────────────
 *
 * (1) THE ROOT-ONLY ONE-LINER. This is the subtle one, and it was found by
 *     measurement in a real browser rather than by reading specs:
 *
 *       scrollbar-color IS an inherited property.
 *       scrollbar-width is NOT.
 *
 *     So `:root { scrollbar-width: thin; scrollbar-color: ... }` — the
 *     obvious one-liner, and what an editor "tidying up" the two rules into
 *     one would produce — recolours every scrollbar in the app while
 *     leaving every one of them 15px THICK. Measured: with the width set
 *     only on :root, .sidebar, .main and a box nested three levels inside
 *     .main all still computed `scrollbar-width: auto`. That regression
 *     LOOKS like it worked (the colour visibly changes) while failing the
 *     entire point of the report. §2 pins the universal selector.
 *
 * (2) THE -WEBKIT- BLOCK ESCAPING ITS @supports GUARD. chat.css:226 already
 *     records the mechanism: styling ::-webkit-scrollbar opts the element
 *     out of overlay scrollbars, so the bar takes permanent layout space
 *     "on every machine, whether or not that user's OS ever shows a
 *     scrollbar". macOS "Automatic" (the default, and this machine's
 *     setting) means classic bars with a mouse attached and overlay bars on
 *     the trackpad alone — so an unguarded -webkit- block would give the
 *     SAME user a permanent gutter on every scroll container the moment
 *     they unplug their mouse. §3 pins the guard.
 *
 * (3) A HARDCODED COLOUR. The file header of shell.css states the rule:
 *     "Nothing in this file hardcodes a color, size, radius or duration
 *     that a token already names." A hex literal here would also break
 *     theming, because both themes are served by ONE declaration only
 *     because --text-3 is a semantic token that color.css redefines under
 *     [data-theme="light"]. §4 pins tokens-only.
 *
 * (4) A THUMB BELOW THE WCAG 1.4.11 3:1 FLOOR. §5 does not take the colour
 *     choice on trust — it reads whatever token shell.css actually names,
 *     resolves it through color.css in BOTH themes, and computes real
 *     relative-luminance contrast against every surface the thumb can sit
 *     on. This is the assertion that would have caught the intuitive
 *     choices: --border-strong measures 1.54 (dark) / 1.48 (light) and
 *     --text-faint 2.19 / 2.11 — roughly HALF the floor — while reading in
 *     prose like the obvious "quiet, subtle" picks. §5b is a positive
 *     control that runs the same arithmetic over --border-strong every time
 *     and requires it to FAIL, so the checker can never rot into
 *     always-true.
 *
 * ── A hazard specific to THIS suite, stated because it nearly bit ───────
 * The scrollbar block in shell.css carries a long explanatory comment that
 * itself contains the literal strings `scrollbar-width: thin`,
 * `::-webkit-scrollbar`, `--border-strong` and `--text-faint`. A scanner
 * that grepped the raw file would match its own documentation and report
 * every assertion green over a file whose real rules had been deleted.
 * Every check below therefore runs over COMMENT-STRIPPED css, and §0c is a
 * positive control proving the stripper actually removes a decoy
 * declaration planted inside a comment.
 *
 * ── ENFORCED ────────────────────────────────────────────────────────────
 *   - shell.css sets scrollbar-color on :root, with a var() not a literal.
 *   - shell.css sets scrollbar-width: thin via a UNIVERSAL selector, so it
 *     reaches elements (not just :root) and stays at specificity 0.
 *   - that universal rule carries no !important (which would defeat
 *     chat.css's deliberate .chat-scopebar hide on specificity grounds).
 *   - the track is transparent.
 *   - every ::-webkit-scrollbar rule sits inside `@supports not
 *     (scrollbar-width: thin)`.
 *   - every colour in the scrollbar rules is a token reference, and every
 *     token named actually exists in tokens/color.css.
 *   - the resolved thumb colour clears 3:1 against --canvas, --surface,
 *     --surface-sunken and --surface-raised, in BOTH themes.
 *   - chat.css still hides .chat-scopebar's scrollbar (the one deliberate
 *     exception), so a global change did not silently swallow it.
 *
 * ── NOT ENFORCED — stated rather than implied away ──────────────────────
 *   - APPEARANCE. This suite reads text and does arithmetic. It does not
 *     render anything, so it cannot tell you the scrollbar looks good, that
 *     the thumb is actually a rounded capsule, or that the track reads as
 *     empty. Those were checked by hand in a real browser in both themes;
 *     no assertion here re-checks them, and none can.
 *   - THE CASCADE. §2 asserts the universal rule carries no !important, and
 *     specificity says a class beats `*`. It does not resolve the real
 *     cross-file cascade — a future `html * { scrollbar-width: ... }` in
 *     another file would out-specify and this suite would not see it.
 *   - WHETHER THE SCROLLBAR STILL SCROLLS. Guarded only by construction:
 *     `thin` is asserted, `none` on a general selector would fail §2. No
 *     assertion here drives input.
 *   - THE OTHER 10 FILES. This suite reads shell.css (the global rule) and
 *     chat.css (the one deliberate exception). A per-view stylesheet that
 *     started setting scrollbar-width on its own containers would not be
 *     seen.
 *   - CONTRAST IS COMPUTED AGAINST FOUR NAMED SURFACE TOKENS. A thumb over
 *     some other painted background is not covered.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SHELL = path.join(ROOT, 'src/public/next/shell.css');
const COLOR = path.join(ROOT, 'src/public/next/tokens/color.css');
const CHAT = path.join(ROOT, 'src/public/next/views/chat.css');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function section(t) { console.log(`\n${t}`); }

/** Remove /* … *\/ comments. CSS has no line comments. */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/**
 * Collect top-level-ish rules as {selector, body, start, end} by walking
 * braces. Nested at-rules (@supports/@media) are walked too, so a rule
 * inside them is still found; `atStack` records the enclosing at-preludes.
 */
function collectRules(css) {
  const rules = [];
  const stack = [];
  let i = 0, chunkStart = 0;
  while (i < css.length) {
    const ch = css[i];
    if (ch === '{') {
      const prelude = css.slice(chunkStart, i).trim();
      if (prelude.startsWith('@')) {
        stack.push(prelude);
        i++; chunkStart = i; continue;
      }
      // find matching close brace
      let depth = 1, j = i + 1;
      while (j < css.length && depth > 0) {
        if (css[j] === '{') depth++;
        else if (css[j] === '}') depth--;
        j++;
      }
      rules.push({
        selector: prelude,
        body: css.slice(i + 1, j - 1),
        atStack: [...stack],
        start: chunkStart,
        end: j,
      });
      i = j; chunkStart = i; continue;
    }
    if (ch === '}') { stack.pop(); i++; chunkStart = i; continue; }
    i++;
  }
  return rules;
}

/** Split a declaration body into [prop, value] pairs. */
function decls(body) {
  return body.split(';').map(s => s.trim()).filter(Boolean).map(s => {
    const k = s.indexOf(':');
    if (k < 0) return null;
    return [s.slice(0, k).trim().toLowerCase(), s.slice(k + 1).trim()];
  }).filter(Boolean);
}

const shellRaw = readFileSync(SHELL, 'utf8');
const shell = stripComments(shellRaw);
const shellRules = collectRules(shell);

// ─────────────────────────────────────────────────────────────────────────
section('0. The scanner reaches real rules (anti-vacuous preconditions)');

ok(shellRaw.length > 2000, 'shell.css was read and is non-trivial');
ok(shellRules.length > 10, `collectRules parsed ${shellRules.length} rules out of shell.css`);

// 0b — the guard must fail loudly if the feature is simply gone, rather than
// leaving every later section vacuously green over an absent block.
const anyScrollbarDecl = shellRules.some(r =>
  decls(r.body).some(([p]) => p === 'scrollbar-width' || p === 'scrollbar-color'));
ok(anyScrollbarDecl,
  'shell.css declares at least one scrollbar property (if this fails, the whole treatment is missing)');

// 0c — POSITIVE CONTROL for the comment stripper. shell.css's own scrollbar
// comment contains the literal text `scrollbar-width: thin`; if the stripper
// silently stopped working, every check below could pass on comment text
// alone. Plant a decoy inside a comment and require it to be invisible.
{
  const decoy = 'a{scrollbar-width:none}/* b{scrollbar-width:thin} */';
  const cleaned = stripComments(decoy);
  ok(!cleaned.includes('b{'),
    'CONTROL: stripComments removes a declaration planted inside a comment');
  ok(cleaned.includes('a{'),
    'CONTROL: stripComments preserves real declarations outside comments');
  // and prove it on the real file: the prose word "divider" only ever
  // appears inside the comment, so it must be gone after stripping.
  ok(shellRaw.includes('divider') && !shell.includes('divider'),
    'CONTROL: shell.css comment prose is present raw and absent after stripping');
}

// ─────────────────────────────────────────────────────────────────────────
section('1. scrollbar-color is set on :root (inherited — reaches every container)');

const colorRules = shellRules.filter(r =>
  decls(r.body).some(([p]) => p === 'scrollbar-color'));

ok(colorRules.length > 0, 'a rule declares scrollbar-color');

const rootColorRule = colorRules.find(r => /(^|,)\s*:root\s*$/.test(r.selector.trim()));
ok(!!rootColorRule,
  'scrollbar-color is declared on :root — the property is inherited, so one declaration covers the app');

const colorValue = rootColorRule
  ? (decls(rootColorRule.body).find(([p]) => p === 'scrollbar-color') || [])[1] || ''
  : '';

ok(/\bvar\(\s*--[\w-]+\s*\)/.test(colorValue),
  `scrollbar-color's thumb is a token reference, not a literal (got: ${colorValue || 'nothing'})`);

ok(/\btransparent\b/i.test(colorValue),
  'scrollbar-color\'s track is transparent — no painted grey channel, which is what read as a solid divider');

// ─────────────────────────────────────────────────────────────────────────
section('2. scrollbar-width: thin is set via a UNIVERSAL selector, not only :root');
// THE REGRESSION: scrollbar-width is NOT inherited (measured in a real
// browser). A :root-only declaration recolours the app while leaving every
// bar at its native thickness.

const widthRules = shellRules.filter(r =>
  decls(r.body).some(([p]) => p === 'scrollbar-width'));
ok(widthRules.length > 0, 'a rule declares scrollbar-width');

/** true for `*`, `*, *::before`, `html, *` … i.e. contains a bare `*` part */
function hasUniversalPart(sel) {
  return sel.split(',').map(s => s.trim()).some(s => s === '*');
}

const universalWidthRule = widthRules.find(r => hasUniversalPart(r.selector) && r.atStack.length === 0);
ok(!!universalWidthRule,
  'scrollbar-width is declared on a universal (`*`) selector at top level, so it reaches ELEMENTS — ' +
  'a :root-only declaration would not inherit and every bar would stay full thickness');

const widthValue = universalWidthRule
  ? (decls(universalWidthRule.body).find(([p]) => p === 'scrollbar-width') || [])[1] || ''
  : '';
ok(/^thin$/i.test(widthValue.replace(/!important/i, '').trim()),
  `the global scrollbar-width is exactly "thin" (got: ${widthValue || 'nothing'}) — ` +
  '"none" globally would hide every scrollbar and remove the affordance');

ok(!/!important/i.test(widthValue),
  'the global scrollbar-width carries no !important — chat.css\'s .chat-scopebar hide ' +
  '(a class, specificity 0,1,0) must keep winning over this universal rule (0,0,0)');

// ─────────────────────────────────────────────────────────────────────────
section('3. every ::-webkit-scrollbar rule is inside @supports not (scrollbar-width: thin)');
// THE REGRESSION: an unguarded -webkit- block opts elements out of overlay
// scrollbars, forcing a permanent layout gutter for trackpad users.

const webkitRules = shellRules.filter(r => /::-webkit-scrollbar/.test(r.selector));
ok(webkitRules.length > 0, `shell.css defines ${webkitRules.length} ::-webkit-scrollbar rule(s) as a fallback`);

const isSupportsNotThin = at =>
  /@supports/.test(at) && /\bnot\b/.test(at) && /scrollbar-width\s*:\s*thin/.test(at);

const unguarded = webkitRules.filter(r => !r.atStack.some(isSupportsNotThin));
ok(unguarded.length === 0,
  unguarded.length === 0
    ? 'every ::-webkit-scrollbar rule sits inside `@supports not (scrollbar-width: thin)`'
    : `UNGUARDED ::-webkit-scrollbar rule(s): ${unguarded.map(r => r.selector).join(' | ')}`);

// the -webkit- thumb must also be a token, same reason as §4
const webkitColourLiterals = webkitRules.flatMap(r =>
  decls(r.body)
    .filter(([p]) => /color|background/.test(p))
    .map(([, v]) => v)
    .filter(v => /#[0-9a-f]{3,8}\b/i.test(v)));
ok(webkitColourLiterals.length === 0,
  webkitColourLiterals.length === 0
    ? 'the -webkit- fallback uses tokens for colour, no hex literals'
    : `hex literal(s) in the -webkit- fallback: ${webkitColourLiterals.join(', ')}`);

// ─────────────────────────────────────────────────────────────────────────
section('4. every token the scrollbar rules name actually exists in tokens/color.css');

const colorRaw = readFileSync(COLOR, 'utf8');
const colorCss = stripComments(colorRaw);
const colorRules2 = collectRules(colorCss);

function varsForSelector(pred) {
  const map = new Map();
  for (const r of colorRules2) {
    if (!pred(r.selector)) continue;
    for (const [p, v] of decls(r.body)) if (p.startsWith('--')) map.set(p, v);
  }
  return map;
}
const rootVars = varsForSelector(s => /(^|,)\s*:root\s*$/.test(s.trim()));
const lightVars = varsForSelector(s => /\[data-theme\s*=\s*["']light["']\]/.test(s));

ok(rootVars.size > 20, `parsed ${rootVars.size} :root custom properties from color.css`);
ok(lightVars.size > 10, `parsed ${lightVars.size} [data-theme="light"] custom properties from color.css`);

// gather every token named anywhere in the scrollbar rules
const scrollbarRuleBodies = [
  ...(rootColorRule ? [rootColorRule.body] : []),
  ...(universalWidthRule ? [universalWidthRule.body] : []),
  ...webkitRules.map(r => r.body),
].join(';');
const namedTokens = [...new Set(
  [...scrollbarRuleBodies.matchAll(/var\(\s*(--[\w-]+)/g)].map(m => m[1]))];

ok(namedTokens.length > 0, `scrollbar rules reference ${namedTokens.length} token(s): ${namedTokens.join(', ')}`);
for (const t of namedTokens) {
  ok(rootVars.has(t),
    `token ${t} is defined in tokens/color.css :root ` +
    '(an undefined custom property makes the whole declaration invalid, SILENTLY)');
}

// ─────────────────────────────────────────────────────────────────────────
section('5. the thumb clears WCAG 1.4.11 (3:1) in BOTH themes, on every surface it sits on');

/** resolve a var() chain within a theme, falling back to :root */
function resolveVar(name, themeVars, depth = 0) {
  if (depth > 8) return null;
  const raw = (themeVars.get(name) ?? rootVars.get(name) ?? '').trim();
  if (!raw) return null;
  const m = raw.match(/^var\(\s*(--[\w-]+)\s*\)$/);
  if (m) return resolveVar(m[1], themeVars, depth + 1);
  return raw;
}
function hexToRgb(h) {
  const s = h.replace('#', '').trim();
  if (s.length === 3) return [0, 1, 2].map(i => parseInt(s[i] + s[i], 16));
  if (s.length >= 6) return [0, 2, 4].map(i => parseInt(s.substr(i, 2), 16));
  return null;
}
function lum(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const [r, g, b] = rgb.map(f);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const la = lum(a), lb = lum(b);
  if (la === null || lb === null) return null;
  const hi = Math.max(la, lb), lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

const SURFACES = ['--canvas', '--surface', '--surface-sunken', '--surface-raised'];
const THEMES = [['dark', new Map()], ['light', lightVars]];

// the thumb token is DISCOVERED from the css, never hardcoded here, so that
// swapping the token re-runs this arithmetic against the new value.
const thumbToken = (colorValue.match(/var\(\s*(--[\w-]+)\s*\)/) || [])[1];
ok(!!thumbToken, `thumb token discovered from shell.css: ${thumbToken || 'NONE'}`);

const FLOOR = 3.0;
for (const [themeName, themeVars] of THEMES) {
  const thumb = thumbToken ? resolveVar(thumbToken, themeVars) : null;
  ok(!!thumb && /^#/.test(thumb), `${themeName}: ${thumbToken} resolves to a hex colour (${thumb})`);
  if (!thumb) continue;
  for (const surf of SURFACES) {
    const bg = resolveVar(surf, themeVars);
    const ratio = bg ? contrast(thumb, bg) : null;
    ok(ratio !== null && ratio >= FLOOR,
      `${themeName}: thumb ${thumb} on ${surf} ${bg} = ` +
      `${ratio === null ? 'UNRESOLVED' : ratio.toFixed(2)}:1 (needs >= ${FLOOR})`);
  }
}

// 5b — POSITIVE CONTROL. Runs every time, so the arithmetic above can never
// rot into always-true. --border-strong is the intuitive "quiet subtle
// border" pick and measures ~1.5:1 — it MUST be reported as failing.
section('5b. CONTROL: the contrast checker actually fires on a known-bad token');
{
  let controlFailures = 0, controlChecked = 0;
  for (const [themeName, themeVars] of THEMES) {
    const bad = resolveVar('--border-strong', themeVars);
    for (const surf of SURFACES) {
      const bg = resolveVar(surf, themeVars);
      const r = (bad && bg) ? contrast(bad, bg) : null;
      if (r !== null) { controlChecked++; if (r < FLOOR) controlFailures++; }
    }
    ok(!!bad, `CONTROL: --border-strong resolves in ${themeName} (${bad})`);
  }
  ok(controlChecked === SURFACES.length * THEMES.length,
    `CONTROL: computed ${controlChecked} control ratios (arithmetic reached every case)`);
  ok(controlFailures === controlChecked,
    `CONTROL: --border-strong fails the ${FLOOR}:1 floor on all ${controlChecked} surface/theme pairs — ` +
    'proving a below-floor token WOULD be caught, not silently passed');
}

// ─────────────────────────────────────────────────────────────────────────
section('6. the one deliberate exception is still intact');
// chat.css hides .chat-scopebar's scrollbar on purpose (v3.18.0 investigated
// it: a full-width horizontal bar under the scope chips read as a draggable
// divider). A global scrollbar rule must not have swallowed that.

const chatCss = stripComments(readFileSync(CHAT, 'utf8'));
const chatRules = collectRules(chatCss);
const scopebarHide = chatRules.find(r =>
  /\.chat-scopebar\b/.test(r.selector) &&
  decls(r.body).some(([p, v]) => p === 'scrollbar-width' && /none/i.test(v)));
ok(!!scopebarHide,
  '.chat-scopebar still sets scrollbar-width: none — the deliberate hide survives the global rule');

const scopebarWebkitHide = chatRules.some(r =>
  /\.chat-scopebar::-webkit-scrollbar/.test(r.selector) && /display\s*:\s*none/i.test(r.body));
ok(scopebarWebkitHide,
  '.chat-scopebar::-webkit-scrollbar { display: none } still present for Safari / older Chromium');

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All /next scrollbar assertions green');
