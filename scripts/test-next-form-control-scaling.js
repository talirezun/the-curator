/**
 * test-next-form-control-scaling.js — OFFLINE suite.
 *
 * Guards the ONE rule that lets `button`, `input`, `select` and `textarea`
 * participate in the app's user-adjustable text scale.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────
 * Settings > General ships a TEXT SIZE control. It works by writing a single
 * custom property, `--font-scale`, which multiplies the whole `--text-*`
 * ramp in tokens/typography.css. Every rule that reads a ramp token moves
 * with it for free.
 *
 * Form controls did not. `font-size` on a form control is NOT an inherited
 * value — the UA stylesheet sets it explicitly (Chromium, in effect,
 * `button { font: 400 13.3333px Arial }`). An AUTHOR declaration is required
 * to displace it, so any control with no font rule of its own is FROZEN at
 * ~13.33px, in Arial, no matter what the user picks.
 *
 * MEASURED in Chromium/macOS at 1280x860, over all 92 (tag, class) control
 * shapes the /next JS actually builds: 23 frozen at 13.3333px, 21 of those
 * also rendering in Arial, plus 6 further controls that already sized
 * correctly and still rendered in Arial. After the rule: 0 and 0, in all
 * seven views, in both themes, at all four scale presets.
 *
 * ── WHAT IS ACTUALLY ON SCREEN, STATED HONESTLY ─────────────────────────
 * Measured with each control's REAL inner markup rather than a bare text
 * node, NOT ONE currently-shipping control renders text at the frozen SIZE:
 * of the 23, thirteen contain only an icon() SVG, four put their text in
 * child spans that carry their own ramp token, one is a checkbox, and
 * `select` matches nothing in this tree at all. The visible defect is the
 * TYPEFACE — Domains' quick-maintenance label, the Chat model-picker row
 * title (a spend surface), the Ingest change-list toggle and the Sync
 * disconnect link all rendered in Arial beside system-font neighbours.
 *
 * So the rule is half corrective (font-family) and half PREVENTATIVE
 * (font-size). The preventative half changes nothing visible today and
 * closes a trap no scan can see: the next control that puts its label
 * directly in the button and forgets a font rule silently stops responding
 * to the text-size setting. This suite is what makes that half durable —
 * without it, a future reader measuring "no visible change" would have
 * every reason to delete the declaration.
 *
 * ── WHY THIS SUITE ASSERTS THE RULE AND NOT THE CONTROLS ────────────────
 * YOU CANNOT GREP FOR AN ABSENT DECLARATION. The defect is the absence of a
 * font-size on a control, and no static scan can enumerate "every element
 * that will be a form control at runtime and has no font rule" — the class
 * comes from JS string concatenation, the cascade comes from eleven
 * stylesheets, and the frozen value comes from the browser's own stylesheet,
 * which is not in this repo at all.
 *
 * So the guard is inverted: it pins the single rule that makes the whole
 * class of defect impossible, and pins the specific ways that rule could be
 * weakened into uselessness while still looking present.
 *
 * ── ENFORCED (what a failure here actually means) ───────────────────────
 *   1. shell.css contains a rule whose selector list carries ALL FOUR bare
 *      type selectors — button, input, select, textarea.
 *   2. That rule sets BOTH `font-family` and `font-size`.
 *   3. Both are literally `inherit`. A px literal, a `var()`, `initial`,
 *      `unset` or `revert` in either slot is rejected — each would either
 *      re-freeze the control or reintroduce the UA value.
 *   4. The selector is UNSCOPED: no class, id, attribute selector,
 *      pseudo-class, or descendant combinator, and not inside an at-rule.
 *      A scoped version (`.settings-nav-list button`) would raise the
 *      specificity above a component's own class rule and silently start
 *      overriding deliberate per-control typography.
 *   5. The rule does NOT set `line-height`. This is a MEASURED exclusion,
 *      not a style preference: inheriting body's 1.45 in place of the UA's
 *      `normal` grew 11 controls' box height by 3-4px, and SEVEN of those
 *      were not frozen at all (.chat-browse-clear, .chat-reask-btn,
 *      .chat-cite-chip, .theme-seg-btn, .chat-browse-q, .sync-setup-input,
 *      .sbw-input.mono). `font: inherit` and the five-longhand form both do
 *      this; that is why neither was used.
 *   6. No OTHER rule anywhere under src/public/next/** sets a font property
 *      on a BARE `button`/`input`/`select`/`textarea` type selector. Such a
 *      rule has identical specificity (0,0,1), so LINK ORDER would decide —
 *      and every view stylesheet is linked AFTER shell.css, so a bare
 *      `button { font-size: 12px }` in any of them would silently re-freeze
 *      every control the moment it shipped.
 *   7. shell.css is actually <link>ed from index.html. v3.9.1 shipped a
 *      whole stylesheet that was styled but never linked; a rule in an
 *      unreachable file is not a fix.
 *   8. A positive control: the same parser, run on synthetic stylesheets,
 *      correctly REJECTS a missing font-size and a px literal. Without this
 *      the suite could rot into always-true and nobody would know.
 *
 * ── NOT ENFORCED — stated plainly, because a guard that implies more than
 *    it checks is worse than none ──────────────────────────────────────────
 *   • NOTHING HERE MEASURES RENDERING. No suite in the OFFLINE manifest
 *     does — `test-visual-regression.js` is the one that measures real
 *     layout, and it is LIVE_LOCAL because it needs a browser.
 *     This file reads text. It cannot tell you that a single pixel on screen
 *     changed size, that the browser resolved `inherit` to what you expect,
 *     or that the UA default is still 13.3333px in a future Chromium. The
 *     acceptance test for this fix was, and remains, a real browser: seven
 *     views x two themes x four scale presets, computed `fontSize` read off
 *     live elements with the "before" cascade re-injected via
 *     `font-size: revert` rather than reasoned about.
 *   • It does NOT prove any particular control is unfrozen. It proves the
 *     rule that unfreezes them is present and unweakened.
 *   • It does NOT catch a control that hardcodes its OWN px font-size. Those
 *     are visible to a declaration scan and are a different guard's job
 *     (see the --font-scale note in app.js: 22 such literals were counted
 *     under /next and are owned by their view files).
 *   • It does NOT resolve the cascade. `!important`, inline `style=`, and
 *     specificity arithmetic beyond the bare/not-bare distinction in (4) and
 *     (6) are out of reach. In particular the boot-recovery button in
 *     index.html sets `font-size:14px` inline and is deliberately immune to
 *     this rule; nothing here checks that.
 *   • Its rule-splitter is a brace matcher, not a CSS parser. A selector
 *     containing a brace inside a string or an `url()` would confuse it.
 *     None exists in this tree.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NEXT = path.join(ROOT, 'src/public/next');
const SHELL = path.join(NEXT, 'shell.css');
const INDEX = path.join(NEXT, 'index.html');

let passed = 0;
let failed = 0;

function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function section(title) { console.log(`\n${title}`); }

// ── Tiny CSS reader ──────────────────────────────────────────────────────
// Comments are stripped first so a selector or a property named inside a
// comment can never satisfy an assertion. This repo has shipped exactly that
// bug: v3.19.0 records an ABSENCE check that passed because the replacement
// COMMENT quoted the very selector it asserted was gone.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Collect every declaration block, recording whether it sits inside an
 * at-rule (@media / @supports / …). Brace matching, so a nested at-rule does
 * not get mistaken for a selector.
 */
function collectRules(src) {
  const out = [];
  const stack = [];      // open at-rule preludes
  let i = 0;
  let buf = '';
  while (i < src.length) {
    const ch = src[i];
    if (ch === '{') {
      const prelude = buf.trim().replace(/\s+/g, ' ');
      buf = '';
      if (prelude.startsWith('@')) {
        stack.push(prelude);
        i++;
        continue;
      }
      // a declaration block: consume to its matching close
      let depth = 1;
      let body = '';
      i++;
      while (i < src.length && depth > 0) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) break; }
        body += src[i];
        i++;
      }
      out.push({ selector: prelude, body, atRules: [...stack] });
      i++;
      continue;
    }
    if (ch === '}') { stack.pop(); buf = ''; i++; continue; }
    buf += ch;
    i++;
  }
  return out;
}

/** Longhand or shorthand — every way a rule can set this property. */
function decl(body, prop) {
  const re = new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;}]+)`, 'i');
  const m = re.exec(body);
  return m ? m[1].trim() : null;
}
function setsAnyFont(body) {
  return /(?:^|;|\s)font(?:-family|-size|-weight|-style|-stretch|-variant|)\s*:/i.test(body);
}

const CONTROL_TAGS = ['button', 'input', 'select', 'textarea'];

/** A compound is a BARE type selector iff it is exactly one of our tags. */
function bareControlTags(selector) {
  const parts = selector.split(',').map((s) => s.trim()).filter(Boolean);
  const bare = new Set();
  for (const p of parts) if (CONTROL_TAGS.includes(p.toLowerCase())) bare.add(p.toLowerCase());
  return bare;
}
/** Does any comma-part reference a control tag in a NON-bare way? */
function scopedControlParts(selector) {
  return selector.split(',').map((s) => s.trim()).filter(Boolean).filter((p) => {
    const low = p.toLowerCase();
    if (CONTROL_TAGS.includes(low)) return false;                 // bare — handled above
    return CONTROL_TAGS.some((t) => new RegExp(`(^|[\\s>+~])${t}\\b`, 'i').test(low));
  });
}

function listCssFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listCssFiles(p));
    else if (e.name.endsWith('.css')) out.push(p);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
console.log('test-next-form-control-scaling.js — form controls follow --font-scale');

const shellRules = collectRules(stripComments(readFileSync(SHELL, 'utf8')));

// ─────────────────────────────────────────────────────────────────────────
section('1. shell.css carries ONE unscoped rule naming all four control tags');

const candidates = shellRules.filter((r) => bareControlTags(r.selector).size > 0);
ok(candidates.length === 1,
  `exactly one rule in shell.css targets bare control type selectors (found ${candidates.length})`);

const rule = candidates[0] || { selector: '', body: '', atRules: [] };
const tags = bareControlTags(rule.selector);
for (const t of CONTROL_TAGS) {
  ok(tags.has(t), `the rule's selector list includes bare \`${t}\``);
}
ok(rule.atRules.length === 0,
  'the rule is NOT nested inside an @media / @supports block (it must apply unconditionally)');
ok(scopedControlParts(rule.selector).length === 0,
  'no part of the selector is scoped (a descendant/class-qualified form would outrank component rules)');

// ─────────────────────────────────────────────────────────────────────────
section('2. It inherits font-family AND font-size, and nothing else');

const famVal = decl(rule.body, 'font-family');
const sizeVal = decl(rule.body, 'font-size');

ok(famVal !== null, 'the rule sets font-family');
ok(sizeVal !== null, 'the rule sets font-size');
ok(famVal === 'inherit',
  `font-family is literally \`inherit\` (found: ${famVal === null ? 'nothing' : famVal})`);
ok(sizeVal === 'inherit',
  `font-size is literally \`inherit\` (found: ${sizeVal === null ? 'nothing' : sizeVal})`);

// A px literal here is the exact defect wearing the fix's clothes: the rule
// would be present, the control would stop being 13.33px, and it would still
// never move with --font-scale.
ok(!/font-size\s*:\s*[\d.]+(px|pt|em|rem|%)/i.test(rule.body),
  'font-size is not a length literal — a px value would look like a fix and still freeze the control');

// MEASURED exclusion. See the header, item 5.
ok(decl(rule.body, 'line-height') === null,
  'the rule does NOT set line-height (measured: inheriting 1.45 grew 11 controls 3-4px, 7 of them not frozen)');
ok(!/(?:^|;|\s)font\s*:/i.test(rule.body),
  'the rule does not use the `font` SHORTHAND (it would reset font-variant/stretch/feature-settings to initial, and drag line-height in)');

// ─────────────────────────────────────────────────────────────────────────
section('3. No other bare control type selector anywhere under /next sets a font');
// Specificity 0,0,1 both ways, so LINK ORDER decides — and every view
// stylesheet is linked after shell.css. One `button { font-size: 12px }` in a
// view file would silently re-freeze the whole app.

{
  const files = listCssFiles(NEXT);
  ok(files.length > 5, `scanned ${files.length} stylesheets under src/public/next/** (enumerated from disk, never a hardcoded list)`);

  const offenders = [];
  for (const f of files) {
    for (const r of collectRules(stripComments(readFileSync(f, 'utf8')))) {
      // shell.css's OWN canonical rule is the thing being guarded, not a
      // competitor. Matched by selector text, because this is a fresh parse
      // and object identity would never hold.
      if (f === SHELL && r.selector === rule.selector) continue;
      if (bareControlTags(r.selector).size === 0) continue;
      if (setsAnyFont(r.body)) offenders.push(`${path.relative(ROOT, f)} :: ${r.selector}`);
    }
  }
  ok(offenders.length === 0,
    `no competing bare-type font rule exists${offenders.length ? ' — found: ' + offenders.join(' | ') : ''}`);
}

// ─────────────────────────────────────────────────────────────────────────
section('4. shell.css is reachable — <link>ed from index.html');
// v3.9.1: shared/progress-ring.css shipped fully styled and never linked, so
// both consuming views rendered unstyled markup for a whole release.

{
  const html = readFileSync(INDEX, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const links = [...html.matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi)].map((m) => m[0]);
  ok(links.some((l) => /href=["'][^"']*\/shell\.css["']/i.test(l)),
    'index.html <link>s shell.css (a rule in an unlinked file is not a fix)');
}

// ─────────────────────────────────────────────────────────────────────────
section('5. Self-test — the detector can actually go red');
// A check that reports zero must be shown catching a planted defect, or it
// is indistinguishable from a check that stopped working.

{
  // (a) the rule present but missing font-size — the original defect, half-fixed
  const halfFixed = collectRules(stripComments(
    'button,\ninput,\nselect,\ntextarea { font-family: inherit; }\n'));
  const hf = halfFixed.find((r) => bareControlTags(r.selector).size === 4);
  ok(!!hf && decl(hf.body, 'font-size') === null,
    'a planted rule that inherits only font-family is correctly seen as MISSING font-size');

  // (b) a px literal in the font-size slot
  const pxLit = collectRules(stripComments(
    'button, input, select, textarea { font-family: inherit; font-size: 13px; }'));
  const pl = pxLit.find((r) => bareControlTags(r.selector).size === 4);
  ok(!!pl && decl(pl.body, 'font-size') === '13px',
    'a planted px literal is correctly read as `13px`, not silently accepted as inherit');

  // (c) a scoped selector must NOT be accepted as the rule
  const scoped = collectRules(stripComments(
    '.settings-nav-list button { font-family: inherit; font-size: inherit; }'));
  const sc = scoped[0];
  ok(bareControlTags(sc.selector).size === 0 && scopedControlParts(sc.selector).length === 1,
    'a planted SCOPED selector (`.settings-nav-list button`) is rejected as bare and flagged as scoped');

  // (d) a competing bare rule in another file must be detectable
  const competing = collectRules(stripComments('button { font-size: 12px; }'));
  ok(bareControlTags(competing[0].selector).size === 1 && setsAnyFont(competing[0].body),
    'a planted competing `button { font-size: 12px }` is detected by the same logic section 3 uses');

  // (e) an at-rule-wrapped version must NOT be accepted
  const wrapped = collectRules(stripComments(
    '@media (min-width: 900px) { button, input, select, textarea { font-family: inherit; font-size: inherit; } }'));
  const wr = wrapped.find((r) => bareControlTags(r.selector).size === 4);
  ok(!!wr && wr.atRules.length === 1,
    'a planted @media-wrapped rule is correctly recorded as nested inside an at-rule');
}

// ─────────────────────────────────────────────────────────────────────────
section('6. The ramp the rule feeds from is still scale-driven');
// `font-size: inherit` is only a fix while the value it inherits actually
// moves. If typography.css ever stops multiplying the ramp by --font-scale,
// this rule becomes decorative and nothing else would say so.

{
  const typo = stripComments(readFileSync(path.join(NEXT, 'tokens/typography.css'), 'utf8'));
  ok(/--font-scale\s*:/.test(typo), 'tokens/typography.css defines --font-scale');
  const ramp = [...typo.matchAll(/--text-[a-z0-9]+\s*:\s*([^;]+);/gi)].map((m) => m[1]);
  ok(ramp.length >= 10, `the --text-* ramp still has ${ramp.length} steps`);
  ok(ramp.every((v) => /var\(\s*--font-scale\s*\)/.test(v)),
    'EVERY --text-* step multiplies by var(--font-scale) — otherwise inheriting the ramp inherits a constant');

  const base = stripComments(readFileSync(path.join(NEXT, 'tokens/base.css'), 'utf8'));
  ok(/body\s*\{[^}]*font\s*:\s*var\(\s*--type-body\s*\)/.test(base),
    'base.css still sets body font from --type-body — that is the value every control now inherits');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ Form controls follow --font-scale (rule present, unscoped, uncontested, reachable)');
