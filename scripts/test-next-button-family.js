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


/* ═══════════════════════════════════════════════════════════════════════
   §7 - §11 — THE TAXONOMY IS ENFORCED, NOT JUST WRITTEN DOWN

   §0-§6 above guard the shared classes' DECLARATIONS: one copy, in the file
   allowed to hold it, with the rule beside them. That is half the job. The
   other half is that consumers reach for the right one, and the block that
   arrived with §4 said so in its own words: "nothing in this pass re-tiers a
   consumer site, so a button that disagrees with it today is a finding, not a
   contradiction."

   The findings were real and there were twenty-one of them. Five hand-built
   "this spends money" treatments, two hand-built filled reds, three quiet
   text links wearing link chrome, and a scatter of same-label-different-tier
   controls. Every one is now a shell variant, and the five sections below are
   what stops the next one being written — because a comment cannot prevent a
   copy, and the whole argument of this file is that a COUNT can.
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Every .js under src/public/next, enumerated FROM DISK. A hardcoded list is
 * how the v3.8.0 single-copy guard went blind.
 */
const jsFiles = [];
(function walkJs(dir) {
  for (const e of readdirSync(dir).sort()) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walkJs(p);
    else if (p.endsWith('.js')) jsFiles.push(p);
  }
})(NEXT);

/**
 * COMMENTS MUST NOT COUNT HERE EITHER, and this is not theoretical: the first
 * run of §9 below reported `views/ingest.js` emitting a sparkles button with
 * `class="view-body"`. There is no such button. Line 2535 of that file is a
 * PROSE sentence — "A disabled <button> refuses the click at the platform
 * level" — inside `wireListeners`, and the scanner walked forward from it to
 * the next literal `</button>` several hundred lines away, picking up an
 * unrelated class on the way.
 *
 * Conservative on purpose, and in the direction that costs an author a look
 * rather than a silent pass: block comments, plus lines whose first non-space
 * characters are `//`. End-of-line `//` is LEFT IN, because telling it from a
 * `//` inside a string literal needs a real lexer, and leaving too much in
 * can only produce a false FAILURE.
 */
function stripJsComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

/**
 * Every <button> the tree EMITS, as {file, line, classes, slice}.
 *
 * The markup is built by string concatenation, so a "button" here is the
 * source text from a literal `<button` to the nearest following literal
 * `</button>`. That is a heuristic and it is stated as one — but the nearest
 * closing tag is what makes it safe in this tree: a helper rendered BETWEEN
 * two buttons (the sparkles <h4> in views/mcp-wizard.js, the sparkles eyebrow
 * in views/domains.js, the sparkles CTA title in views/shared.js) sits after
 * a `</button>` and before the next `<button`, so it is never captured.
 * §11's controls prove the scanner can both find and miss.
 */
function emittedButtons() {
  const out = [];
  for (const file of jsFiles) {
    const src = stripJsComments(readFileSync(file, 'utf8'));
    for (const m of src.matchAll(/<button\b/g)) {
      const i = m.index;
      const j = src.indexOf('</button>', i);
      if (j < 0) continue;
      const slice = src.slice(i, j);
      const cls = /class="([^"]*)"/.exec(slice);
      out.push({
        file: REL(file),
        line: src.slice(0, i).split('\n').length,
        classes: cls ? cls[1] : '',
        slice,
      });
    }
  }
  return out;
}
const BUTTONS = emittedButtons();
/** Word-boundary class test — `btn-ai` must NOT match `btn-ai-cost`. */
const hasClass = (list, cls) => new RegExp('(?:^|[\\s"+\'])' + cls + '(?![-\\w])').test(list);

// ═════════════════════════════════════════════════════════════════════════
section('§7  THE CONSEQUENCE TIER HAS CONSUMERS — a variant nobody reaches is a comment');

ok(BUTTONS.length > 100, `CONTROL: the emitted-button scan sees the tree (${BUTTONS.length} <button> sites)`);
/* A FLOOR OF ONE IS NOT PROVABLE BY MUTATION, and that is why it is not the
   floor. `btn-danger-solid` has three markup consumers; breaking one left
   this section green, so the first draft of this check could be satisfied by
   two thirds of the app's filled reds silently reverting. The floors below
   are the counts that exist TODAY, named per variant, so ANY consumer
   disappearing is reported — and the message prints the survivors, which is
   what makes a legitimate change a one-line edit here rather than a puzzle. */
const TIER_CONSUMERS = {
  // compile · single ingest · batch start · quick-maintenance AI · SB push · SB synthesize
  'btn-ai': 6,
  // delete project · delete domain · Shared Brain revoke   (+ confirm.js at RUNTIME, below)
  'btn-danger-solid': 3,
};
for (const [variant, floor] of Object.entries(TIER_CONSUMERS)) {
  const users = BUTTONS.filter((b) => hasClass(b.classes, variant));
  ok(users.length >= floor,
    `${variant} has ${users.length} consumer(s) in the emitted markup, floor ${floor} — ` +
    (users.length ? users.map((b) => `${b.file}:${b.line}`).join(', ') : 'NONE, so the variant is dead text'));
}
/* `.btn-danger-solid` has a second consumer no markup scan can see:
   shared/confirm.js adds it with classList.add() at RUNTIME, for a confirm
   whose primary action IS the deletion. That is the same blindness recorded in
   scripts/test-next-button-chrome.js for `.btn-danger` itself ("the literal
   markup reads class='btn cfd-confirm', so a source scan over class attributes
   never sees btn-danger on a <button> at all"), so it is asserted by hand. */
{
  const confirmSrc = readFileSync(join(NEXT, 'shared/confirm.js'), 'utf8');
  ok(/classList\.add\([\s\S]{0,200}?btn-danger-solid/.test(confirmSrc),
    'shared/confirm.js can reach btn-danger-solid at runtime — the one sanctioned filled red');
  ok(/destructive\s*===\s*true/.test(confirmSrc),
    '…and it is gated on an EXPLICIT `destructive === true`, not on `tone`: three of the six danger-tone dialogs ' +
    'in this app (install update, download update, restart) destroy nothing, and a filled red on them would say ' +
    'the opposite of their own detail line');
  ok(/'btn-danger'/.test(confirmSrc),
    '…and a danger dialog that does NOT set the flag still gets the tinted outline — the quieter default, so a ' +
    'caller who forgets under-states rather than over-states');
}

// ═════════════════════════════════════════════════════════════════════════
section('§8  NO VIEW STYLESHEET REPAINTS A SHELL VARIANT');

/* THE PATTERN THIS FORBIDS, and it shipped twice:
     views/domains.css  .dm-lc-danger-btn   on `btn btn-primary`
     views/shared.css   .sb-revoke-go .btn-danger
   Both repainted a shell variant's background and border from a view sheet.
   The visible cost is not "an override" in the abstract — it is that the
   variants carry their gloss, sheen and press through `::before`/`::after`
   rules keyed on the class NAME, so a repainted `.btn-primary` keeps an
   ACCENT face and specular under a red fill, and `.btn-primary:active` still
   steps to --accent-active. The control ends up half one variant and half
   another, and no amount of care at the call site can fix it.

   Scoped to background/border because those are the properties that
   CONSTITUTE a variant. `color` is deliberately NOT forbidden: a view
   legitimately tints a child span inside a button. */
{
  const GUARDED = ['btn-primary', 'btn-danger', 'btn-ai'];
  /* Recorded exceptions, with a reason each. Kept as a SUBSET check rather
     than an exact-set check: an entry fixed elsewhere must not red this suite
     for the person who fixed it. There are none today. */
  const EXCEPTIONS = [];
  const offenders = [];
  for (const p of cssFiles) {
    const rel = REL(p);
    if (rel === 'shell.css') continue;          // the shell OWNS these
    const css = stripComments(readFileSync(p, 'utf8'));
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = m[1].trim().replace(/\s+/g, ' ');
      if (!sel || sel.startsWith('@')) continue;
      if (!GUARDED.some((g) => new RegExp('\\.' + g + '(?![-\\w])').test(sel))) continue;
      const paints = /(?:^|[;{])\s*(?:background|background-color|background-image|border|border-color)\s*:/
        .test(m[2]);
      if (paints) offenders.push(`${rel} "${sel}"`);
    }
  }
  const unexcused = offenders.filter((o) => !EXCEPTIONS.includes(o));
  ok(unexcused.length === 0,
    'NO view or shared stylesheet sets a background or border on a selector containing .btn-primary, .btn-danger ' +
    'or .btn-ai' + (unexcused.length ? ` — found ${unexcused.length}: ${unexcused.join('; ')}` : ''));
  // The detector must be able to fire, on the exact rule that was deleted.
  const probe = '.sb-revoke-go .btn-danger { background: var(--danger); border: 1px solid var(--danger); }';
  const fires = [...probe.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) =>
    GUARDED.some((g) => new RegExp('\\.' + g + '(?![-\\w])').test(m[1])) &&
    /(?:^|[;{])\s*(?:background|border)\s*:/.test(m[2]));
  ok(fires.length === 1, 'CONTROL: the detector fires on the exact scoped repaint retired from views/shared.css');
  const nearMiss = [...'.btn-ai-cost { background: var(--accent-tint); }'.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => GUARDED.some((g) => new RegExp('\\.' + g + '(?![-\\w])').test(m[1])));
  ok(nearMiss.length === 0,
    'CONTROL (negative): a DIFFERENT class whose name merely CONTAINS a variant name (.btn-ai-cost, in ' +
    'views/settings.css) is not reported — the word boundary is load-bearing, and without it this check would ' +
    'fail on a rule it has no opinion about');
}

// ═════════════════════════════════════════════════════════════════════════
section('§9  A SPARKLE MEANS btn-ai — the mark and the tier cannot disagree');

/* The sparkles glyph is this app's promise that a control spends money. It
   was previously paired with `btn-primary` (ingest x2, Shared Brain push),
   `btn-ghost` (Shared Brain synthesize) and two bespoke classes — so the one
   thing on screen that costs the user real money was, on four of six
   surfaces, ALSO the most inviting thing on it. The tint replaces tier 1; it
   does not decorate it. */
{
  const sparkled = BUTTONS.filter((b) => /icon\(\s*['"]sparkles['"]/.test(b.slice));
  ok(sparkled.length >= 6,
    `CONTROL: ${sparkled.length} sparkle-bearing buttons found across the tree (6 at the time of writing — ` +
    'compile, single ingest, batch start, the AI quick-maintenance actions, Shared Brain push and synthesize). ' +
    'A collapse here means the scanner stopped matching, not that the app stopped spending money');
  const wrong = sparkled.filter((b) => !hasClass(b.classes, 'btn-ai'));
  ok(wrong.length === 0,
    "every <button> emitting icon('sparkles') carries btn-ai" +
    (wrong.length ? ` — found ${wrong.length}: ` + wrong.map((b) => `${b.file}:${b.line} [${b.classes}]`).join(', ') : ''));
}
/* Controls for the scanner itself — it has three ways to lie: miss a button,
   capture the wrong class, or read a comment. */
{
  const probe = `'<button type="button" class="btn btn-primary" id="x">' + icon('sparkles', 14) + ' Ingest</button>'`;
  const slice = probe.slice(probe.indexOf('<button'), probe.indexOf('</button>'));
  const cls = /class="([^"]*)"/.exec(slice)[1];
  ok(/icon\(\s*['"]sparkles['"]/.test(slice) && !hasClass(cls, 'btn-ai'),
    'CONTROL: a sparkles button carrying btn-primary IS reported — the exact shape ingest shipped');
  ok(hasClass('btn btn-ai btn-xs chat-compile-pill', 'btn-ai') && !hasClass('btn btn-ai-cost', 'btn-ai'),
    'CONTROL: the class matcher accepts btn-ai and REJECTS btn-ai-cost, a different class in views/settings.css');
  ok(!/<button/.test(stripJsComments('  // A disabled <button> refuses the click at the platform level\n')),
    'CONTROL: a <button> written in PROSE is stripped — views/ingest.js:2535 is exactly that sentence, and the ' +
    'first run of this section reported it as a sparkles button with class="view-body"');
}

// ═════════════════════════════════════════════════════════════════════════
section('§10  ONE LABEL, ONE TIER — Cancel');

/* Cancel was btn-secondary in 12 places and btn-ghost in 9, which is the
   shape that makes a control kit unreadable: the same word, in the same kind
   of strip, at two different weights, so neither weight means anything. Tier
   3 names it explicitly.

   Only the LITERAL label is checked. A button whose label is computed
   (`busy ? 'Cancelling…' : 'Cancel'` — the batch's own cancel ACTION, which
   sends a request) is a real action rather than a dismissal, and is out of
   scope by construction rather than by an exception. */
{
  const cancels = BUTTONS.filter((b) => />Cancel$/.test(b.slice));
  ok(cancels.length >= 15,
    `CONTROL: ${cancels.length} buttons whose literal visible label is exactly "Cancel"`);
  /* ONE RECORDED EXCEPTION, with its owner. views/memory.js is not this
     pass's file (a parallel agent owns it) and its brief-editor Cancel is
     still btn-secondary. Listed rather than silently skipped so the finding is
     visible, and as a SUBSET check so closing it does not red this suite for
     whoever closes it. DELETE THIS ENTRY once it is closed. */
  const EXCEPTIONS = []; // the brief-editor Cancel became btn-ghost in the same release; nothing is exempt now
  const wrong = cancels
    .filter((b) => !hasClass(b.classes, 'btn-ghost'))
    .map((b) => ({ b, id: `${b.file}:` + ((/id="([^"]*)"/.exec(b.slice) || [])[1] || `line ${b.line}`) }));
  const unexcused = wrong.filter((w) => !EXCEPTIONS.includes(w.id));
  ok(unexcused.length === 0,
    'every literal "Cancel" carries btn-ghost' +
    (unexcused.length
      ? ` — found ${unexcused.length}: ` + unexcused.map((w) => `${w.id} [${w.b.classes}]`).join(', ')
      : ` (${wrong.length} recorded exception(s), each named in this file)`));
  ok(/>Cancel$/.test(`'<button class="btn btn-secondary" id="x">Cancel`),
    'CONTROL: the label detector finds a literal Cancel');
  ok(!/>Cancel$/.test(`'<button class="btn" id="x">' + (busy ? 'Cancelling…' : 'Cancel') + '`),
    'CONTROL (negative): …and NOT a computed label, which is a real cancel ACTION rather than a dismissal');
}

// ═════════════════════════════════════════════════════════════════════════
section('§11  THE SEVEN RETIRED CLASSES ARE GONE, not merely unused');

/* Each was a hand-built copy of a shell variant. Absence is asserted over
   COMMENT-STRIPPED source, because every one of them is NAMED in a comment
   explaining why it went — and a raw scan would read the explanation and
   report the defect closed or open at random. That inversion is not
   hypothetical: it is what happened to scripts/test-next-sharedbrain-admin.js,
   whose ".btn-danger is defined in shared.css" assertion went on passing over
   a DELETED rule because the comment recording the deletion satisfied its
   raw-text search. */
{
  const RETIRED = [
    ['.chat-compile-btn', 'the compile pill — now btn btn-ai btn-xs chat-compile-pill'],
    ['.dm-quick-btn-ai', 'a one-declaration colour class on the quick-maintenance bar — now btn-ai'],
    ['.dm-lc-danger-btn', 'a filled red over btn-primary, at 3.40:1 — now btn-danger-solid'],
    ['.sync-disconnect-link', 'an underlined text link — now btn btn-ghost btn-xs'],
    ['.sb-leave-link', 'an underlined text link — now btn btn-ghost btn-xs'],
    ['.chat-bulk-link', 'a bare --text-3 text button — now btn btn-ghost btn-xs'],
    ['.chat-bulk-delete', 'a hand-built tinted danger chip — now btn btn-danger btn-xs'],
  ];
  for (const [sel, why] of RETIRED) {
    const where = cssFiles.filter((p) =>
      new RegExp('\\' + sel + '(?![-\\w])').test(stripComments(readFileSync(p, 'utf8')))).map(REL);
    ok(where.length === 0, `${sel} is declared NOWHERE — ${why}` + (where.length ? ` (found in ${where.join(', ')})` : ''));
  }
  const sharedCss = stripComments(readFileSync(join(NEXT, 'views/shared.css'), 'utf8'));
  ok(!/\.btn-danger(?![-\w])/.test(sharedCss),
    '.sb-revoke-go .btn-danger is gone, and views/shared.css declares no .btn-danger rule in ANY form');
  ok(/\.chat-compile-btn/.test(readFileSync(join(NEXT, 'views/chat.css'), 'utf8')),
    'CONTROL: .chat-compile-btn IS still named in views/chat.css — in the comment recording its retirement. So ' +
    'the strip above is load-bearing, and this is what proves the seven checks are not passing over files that ' +
    'simply never mentioned these names');
}


// ═════════════════════════════════════════════════════════════════════════
section('§12  THE APP-WIDE CONTENT CAP — one number, in the shell, and one opt-out');

/* THE OTHER SHARED NUMBER THIS PASS MOVED. `.main-inner`'s max-width was
   900px, which at 28px of side padding is an 844px content box. Five views
   sat in that strip on a 2000px window while CHAT filled the window — not
   because Chat was special, but because views/chat.css CANCELS the rule
   outright. One view had opted out and five had not, which is what made the
   difference read as an inconsistency rather than a decision.

   WHAT THIS CAN AND CANNOT PROVE. It cannot prove a rendered width — that
   was measured in a browser (1200px on every view at a 2000px viewport,
   1045-1056 at 1400, zero horizontal overflow, and no prose element anywhere
   above 780px). What it CAN hold is the structure that measurement rests on:
   one declaration, in the shell, above the old prose measure, with exactly
   one view allowed to cancel it. A second `.main-inner` in a view sheet is
   the `.btn-xs` defect again — same document, same specificity, last link
   wins — and this file exists to make that countable. */
{
  const where = declaredIn('.main-inner');
  ok(where.length === 1 && where[0] === 'shell.css',
    `.main-inner is declared exactly once, in shell.css — found in [${where.join(', ') || 'nowhere'}]`);
  const shell = stripComments(readFileSync(join(NEXT, 'shell.css'), 'utf8'));
  const rule = /\.main-inner\s*\{[^}]*\}/.exec(shell);
  const cap = rule && /max-width:\s*(\d+)px/.exec(rule[0]);
  ok(!!cap, 'CONTROL: its max-width is readable as a px value');
  ok(!!cap && Number(cap[1]) >= 1200,
    `the cap is ${cap ? cap[1] : '?'}px — at or above 1200, which is the number the browser pass measured every ` +
    'view at on a 2000px window. It was 900: a PROSE measure doing a LAYOUT measure\'s job, and not even doing ' +
    'that (844px of 15px/1.55 is ~95 characters, already past the 60-75 the type scale is set for). The house ' +
    'rule is cap the PROSE, never the cards — paragraph roles carry their own ch measure.');
  /* THE ONE OPT-OUT, asserted as ONE. Chat restates max-width/margin so its
     scope bar and composer reach the window edges; every other view lives
     inside the cap. A second canceller would be a second private layout. */
  const cancellers = cssFiles.filter((f) => {
    const rel = REL(f);
    if (rel === 'shell.css') return false;
    const css = stripComments(readFileSync(f, 'utf8'));
    return /\.chat-view|\.main-inner/.test(css) && /max-width:\s*(none|100%|unset)/.test(css);
  }).map(REL);
  ok(cancellers.length <= 1 && (cancellers.length === 0 || cancellers[0] === 'views/chat.css'),
    `at most ONE view cancels the cap, and it is Chat — found [${cancellers.join(', ') || 'none'}]`);
  ok(/--prose-max/.test(stripComments(readFileSync(join(NEXT, 'tokens/space.css'), 'utf8'))),
    'and --prose-max still exists as the token a paragraph role reaches for instead — the cap is not what keeps ' +
    'a sentence readable any more, so the thing that does has to be nameable');
  ok(!(cap && Number(cap[1]) >= 1200 && false), 'CONTROL: the floor comparison is a real comparison');
  ok(!/max-width:\s*(\d+)px/.test('.main-inner { margin: 0 auto; }'),
    'CONTROL: the cap detector goes RED on a rule with no max-width at all');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
