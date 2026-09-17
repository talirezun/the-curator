#!/usr/bin/env node
/**
 * scripts/test-next-button-family.js — OFFLINE
 *
 * The shared control classes are declared ONCE, in the shell, and the taxonomy
 * that says which variant to reach for is written down beside them.
 *
 * ── THE DEFECT THIS EXISTS TO CLOSE ────────────────────────────────────────
 *
 * `.btn-xs` was declared in FIVE view stylesheets — views/sync.css,
 * views/shared.css, views/ingest.css, views/settings.css, views/memory.css —
 * byte-identically, and never in shell.css. views/memory.css carried a comment
 * saying each view "owns its own CSS file … so an edit there can never
 * silently change this view's button". That was FALSE. index.html links every
 * view stylesheet into one document; all five copies sit at identical
 * specificity; settings.css is linked last. So settings.css's copy rendered
 * every small button in the app including Agent memory's, and four files were
 * editing text nobody could see. `.theme-segmented` / `.theme-seg-btn` had the
 * same defect across two files, and had DRIFTED with it: the sync.css copy
 * still carried `border-radius: 7px` and `font-size: 12.5px` where the winning
 * copy carried tokens.
 *
 * views/settings.css already records this shape under the name THE INERT-COPY
 * DEFECT, for `.settings-hint-text`, and scripts/test-next-contrast-ratchet.js
 * §9 records what it cost to find: a contrast fix applied to two of three
 * copies measured GREEN in the suite while the live document still failed.
 *
 * A comment cannot prevent the next copy. A count can, and that is all this
 * file does: for each shared class, exactly one declaration, in the file that
 * is allowed to hold it.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NEXT = join(ROOT, 'src/public/next');

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); }
}
function section(t) { console.log('\n' + t); }

/** Comments hold quoted CSS on purpose in this tree — they must not count. */
function stripComments(css) { return css.replace(/\/\*[\s\S]*?\*\//g, ''); }

const cssFiles = [];
(function walk(dir) {
  for (const e of readdirSync(dir).sort()) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.css')) cssFiles.push(p);
  }
})(NEXT);
const REL = (p) => relative(NEXT, p);

/**
 * Every file declaring a rule whose selector LIST contains `sel` as a whole
 * simple selector on its own — `.btn-xs` counts, `.btn-xs:hover` and
 * `.foo .btn-xs` do not. Those are states and scoped overrides; a second BASE
 * declaration is the defect.
 */
function declaredIn(sel) {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('(?:^|,)\\s*' + esc + '\\s*(?:,|\\{)', 'm');
  return cssFiles.filter((p) => re.test(stripComments(readFileSync(p, 'utf8')))).map(REL);
}

// ═════════════════════════════════════════════════════════════════════════
section('§0  THE SCAN CAN SEE THE TREE');

ok(cssFiles.length >= 15, `${cssFiles.length} stylesheets under src/public/next/`);
ok(cssFiles.some((p) => REL(p) === 'shell.css') && cssFiles.some((p) => REL(p) === 'views/settings.css'),
  'CONTROL: shell.css and views/settings.css are both in the set');
ok(declaredIn('.btn').includes('shell.css'), 'CONTROL: the matcher finds `.btn` where it really lives');
ok(!declaredIn('.no-such-class-anywhere').length, 'CONTROL: …and finds nothing for a class that does not exist');

// ═════════════════════════════════════════════════════════════════════════
section('§1  .btn-xs — ONE declaration, in the shell');

{
  const where = declaredIn('.btn-xs');
  ok(where.length === 1 && where[0] === 'shell.css',
    `.btn-xs is declared exactly once, in shell.css — found in [${where.join(', ') || 'nowhere'}]`);
  const shell = stripComments(readFileSync(join(NEXT, 'shell.css'), 'utf8'));
  ok(/\.btn-xs\s*\{[^}]*height:\s*var\(--control-sm\)/.test(shell),
    '…and it still grows the BOX to --control-sm (it cannot use the ::before hit-box trick — .btn::before is the gloss face)');
  ok(/\.btn-xs\s*\{[^}]*font-size:\s*var\(--text-xs\)/.test(shell),
    '…with a TOKEN font-size, so the one control size that is not --control-md still follows the text-size setting');
}

// ═════════════════════════════════════════════════════════════════════════
section('§2  the segmented control — ONE declaration, in the shell');

for (const sel of ['.theme-segmented', '.theme-seg-btn']) {
  const where = declaredIn(sel);
  ok(where.length === 1 && where[0] === 'shell.css',
    `${sel} is declared exactly once, in shell.css — found in [${where.join(', ') || 'nowhere'}]`);
}
{
  const settings = stripComments(readFileSync(join(NEXT, 'views/settings.css'), 'utf8'));
  ok(/\.fs-seg-btn\s*\{/.test(settings) && /\.bgmode-segmented\s*\{/.test(settings),
    'the .fs-* / .bgmode-* MODIFIERS stay in views/settings.css — they exist for Settings\' three- and four-option rows only');
  // THE SURVIVOR IS THE RIGHT ONE. Both copies were deleted and one was
  // re-declared in the shell, so this pins WHICH: the tokenised settings.css
  // version, not sync.css's `font-size: 12.5px` / `border-radius: 7px`
  // literals. (views/sync.css still carries one unrelated 12.5px, on
  // `.sync-repo` — a bare absence check would have matched that and lied.)
  const shellCss = stripComments(readFileSync(join(NEXT, 'shell.css'), 'utf8'));
  const seg = /\.theme-seg-btn\s*\{[^}]*\}/.exec(shellCss);
  ok(!!seg && /font-size:\s*var\(--text-sm\)/.test(seg[0]) && !/font-size:\s*[\d.]+px/.test(seg[0]),
    'the surviving copy is the TOKENISED one — var(--text-sm), not the 12.5px literal the drifted copy carried');
  const track = /\.theme-segmented\s*\{[^}]*\}/.exec(shellCss);
  ok(!!track && /border-radius:\s*calc\(var\(--radius-control\)/.test(track[0]),
    '…and the track keeps the concentric calc() radius, not sync.css\'s flat 7px');
}

// ═════════════════════════════════════════════════════════════════════════
section('§3  .settings-hint-text / .settings-inline-error — settings.css only');

for (const sel of ['.settings-hint-text', '.settings-inline-error']) {
  const where = declaredIn(sel);
  ok(where.length === 1 && where[0] === 'views/settings.css',
    `${sel} is declared exactly once, in views/settings.css — found in [${where.join(', ') || 'nowhere'}]`);
}

// ═════════════════════════════════════════════════════════════════════════
section('§4  THE TAXONOMY IS WRITTEN DOWN, ABOVE .btn');

{
  const shellRaw = readFileSync(join(NEXT, 'shell.css'), 'utf8');
  const btnAt = shellRaw.search(/^\.btn \{/m);
  ok(btnAt > 0, 'CONTROL: `.btn {` is found in shell.css');
  const above = shellRaw.slice(0, btnAt);
  const block = /\/\*[^*]*THE BUTTON TAXONOMY[\s\S]*?\*\//.exec(above);
  ok(!!block, 'a comment block naming THE BUTTON TAXONOMY sits ABOVE .btn — not below it, not in another file');
  if (block) {
    const text = block[0];
    // The four tiers, IN ORDER. A set check would pass on a block that lists
    // them backwards, and the order IS the content: it is a weight ramp.
    const order = ['.btn-primary', '.btn-secondary', '.btn-ghost', '.btn-ai'];
    const at = order.map((c) => text.indexOf(c));
    ok(at.every((i) => i >= 0), 'it names all four tier classes: ' + order.join(', '));
    ok(at.every((v, i) => i === 0 || v > at[i - 1]),
      '…in descending-weight ORDER (primary → secondary → ghost → consequence), because the order is the rule');
    ok(/\.btn-danger\b/.test(text) && /\.btn-danger-solid/.test(text),
      '…and it names .btn-danger and the one exception, .btn-danger-solid');
    ok(/at most\s+one/i.test(text),
      'tier 1 carries the "at most one per card, row or panel" constraint — the part that is actually enforceable by eye');
    ok(/--control-md/.test(text) && /\.btn-xs/.test(text),
      'and SIZE is stated as a property of the CONTAINER, naming both --control-md and .btn-xs');
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('§5  THE CONSEQUENCE TIER IS STILL FILLED-FREE, AND STILL EXISTS');

{
  const shell = stripComments(readFileSync(join(NEXT, 'shell.css'), 'utf8'));
  for (const sel of ['.btn-ai', '.btn-danger', '.btn-danger-solid', '.btn-ghost', '.btn-primary', '.btn-secondary']) {
    ok(declaredIn(sel).includes('shell.css'), `${sel} is declared in shell.css — the taxonomy names a class that exists`);
  }
  // .btn-ai and .btn-danger are TINTED. The gloss set is asserted exactly by
  // scripts/test-next-button-chrome.js; this is the one-line version of the
  // same refusal, so deleting that suite would not silently drop it.
  ok(/\.btn-ai\s*\{[^}]*background-color:\s*var\(--accent-tint\)/.test(shell),
    '.btn-ai is a TINT, not a fill — the control that spends money is never the most inviting thing on screen');
  ok(/\.btn-danger\s*\{[^}]*background:\s*transparent/.test(shell),
    '.btn-danger is transparent at rest — it destroys data, so it does not advertise');
}

// ═════════════════════════════════════════════════════════════════════════
section('§6  THE OTHER PLACE THE CONTAINER DECIDES GEOMETRY — the settings block head');

/* Same principle as the SIZE rule in the taxonomy above, which is why it is
   guarded here rather than left to the eye: the numeral column's width is
   DERIVED, and the derivation was written down in views/settings.css and then
   not followed. The indent comment said "32px = 20px numeral + the 12px gap"
   while the gap declared --space-5 (10px), so the heading text started at
   30px and the lede under it at 32px. Two pixels is not read as a step; it is
   read as one of them being slightly wrong. Asserted as the ARITHMETIC, not
   as the literal `var(--space-6)`, so the next person may change the numeral
   or the gap as long as the three numbers still add up. */
{
  const settings = stripComments(readFileSync(join(NEXT, 'views/settings.css'), 'utf8'));
  const space = stripComments(readFileSync(join(NEXT, 'tokens/space.css'), 'utf8'));
  const tok = (name) => {
    const m = new RegExp('--' + name + ':\\s*(\\d+)px').exec(space);
    return m ? Number(m[1]) : NaN;
  };
  const gapVar = /\.settings-block-hd\s*\{[^}]*gap:\s*var\(--(space-[\w-]+)\)/.exec(settings);
  const numW = /\.settings-block-num\s*\{[^}]*width:\s*(\d+)px/.exec(settings);
  const indent = /\.settings-block-lede\s*\{\s*margin-left:\s*(\d+)px/.exec(settings);
  ok(!!gapVar && !!numW && !!indent,
    'CONTROL: the three numbers are all readable from views/settings.css + tokens/space.css');
  if (gapVar && numW && indent) {
    const gap = tok(gapVar[1]);
    ok(Number.isFinite(gap), `CONTROL: --${gapVar[1]} resolves to a px value (${gap})`);
    ok(Number(numW[1]) + gap === Number(indent[1]),
      `the prose indent IS the numeral plus the gap: ${numW[1]} + ${gap} = ${indent[1]} ` +
        '— so the lede starts exactly under the heading text, not 2px past it');
  }
  ok(/\.settings-block-body\s*\{\s*margin-left:\s*32px/.test(settings),
    'and the body takes the same indent as the lede, so the prose is one column');
  ok(/\.settings-block-unnumbered[^{]*\{[^}]*margin-left:\s*0/.test(settings),
    'a block with no numeral (settingsBlock(null, …)) zeroes that indent — otherwise its prose hangs inside a heading with nothing to its left');
  const js = readFileSync(join(NEXT, 'views/settings.js'), 'utf8');
  ok(/const numbered = num != null;/.test(js),
    'and settingsBlock decides it with `!= null`, not a falsy test — a numbering scheme must not silently lose a 0');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
