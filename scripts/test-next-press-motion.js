/**
 * test-next-press-motion.js — OFFLINE suite.
 *
 * THE DEFECT THIS EXISTS TO STOP COMING BACK
 * ------------------------------------------
 * Before this change the whole `/next` tree carried exactly TWO `:active`
 * rules — `shell.css .btn` and `chat.css .chat-send-btn` — and both did the
 * same thing: `transform: translateY(0.5px)`. Measured live in the running
 * app that resolves to 0.4716px, i.e. SUB-PIXEL at 1x. The rail, the list
 * rows, the settings nav, the theme segments, the scope pills, the memory
 * rows and the ingest destination rows had no press state at all: a real
 * mousedown returned `transform: none` with an unchanged background.
 *
 * The design system specifies a press as THREE simultaneous changes — a
 * background step, a translate, and an ~80ms transform transition. The app
 * had adopted ONE of the three, at an amplitude below the display's own
 * resolution. That is the shape this file locks down.
 *
 * ── WHAT IS ENFORCED ─────────────────────────────────────────────────────
 *  §1  The press vocabulary exists in tokens/motion.css and is composed from
 *      tokens that were already there (no new duration, no new curve).
 *  §2  AMPLITUDE RATCHET. Every transform inside an `:active` rule anywhere
 *      in /next reads a press token — no literal px, no literal scale. This
 *      is what makes a return to `translateY(0.5px)` impossible, and what
 *      stops a THIRD amplitude appearing beside the two that exist.
 *  §3  ADOPTION, enumerated FROM DISK. Every button-role element the tree
 *      emits is resolved to its classes and must reach at least one press
 *      rule. The floor is a measured ratchet, not a hardcoded roster.
 *  §4  REDUCED MOTION, DECIDED PER ELEMENT. Every press transform is
 *      neutralised; the selection edges KEEP their position; and the ingest
 *      progress ring is asserted NOT to be disabled.
 *  §5  KEYFRAME CONSOLIDATION. One rotate, one panel entrance. No duplicate
 *      keyframe bodies anywhere in the tree.
 *  §6  CASCADE. A press background that ties with its own `:hover` must be
 *      declared after it, or it never paints. Two real bugs of exactly this
 *      shape were found and fixed while writing the CSS.
 *  §7  CONTROLS — including the comment-stripping positive control this repo
 *      has now been bitten by four times (v3.24.2 once, v3.26.0 three times).
 *
 * ── WHAT IS NOT ENFORCED, named rather than implied away ─────────────────
 *  - CASCADE IS RESOLVED ONLY FOR TIES, AND ONLY BY SOURCE ORDER. §6 checks
 *    that a press rule with the same specificity as its hover comes later in
 *    the same FILE. It does not model cross-file order, `!important`, or
 *    layers. "Declared later in the same file" is the right check for the
 *    real defect (a press written above its own hover) and the wrong tool for
 *    a general override fight.
 *  - SPECIFICITY IS COUNTED, NOT COMPUTED. §6 counts class and
 *    pseudo-class/attribute tokens in a selector. That is enough to tell
 *    `.x:active` (2) from `.x:hover:not(:disabled)` (3), which is the only
 *    distinction it needs. It is not a CSS specificity engine.
 *  - PERCEPTIBILITY IS NOT MEASURED HERE. Whether 0.985 on a given control
 *    actually moves a device pixel needs a browser and the element's real
 *    width; the token comments carry the arithmetic and the release carries
 *    the live figures. This suite can only prove a token is READ, never that
 *    the result is visible — which is exactly how `translateY(0.5px)` passed
 *    every check for four releases.
 *  - AN ELEMENT WHOSE PRESS COMES FROM AN ANCESTOR IS INVISIBLE TO §3.
 *    `.chat-conv-row-main` is a role="button" div whose press is painted by
 *    `.chat-conv-row:active` (`:active` matches ancestors). §3 counts it as
 *    uncovered. Reported rather than special-cased, because an exemption
 *    list is how a real gap gets waved through.
 *  - `document.createElement` buttons with no class attribute in source are
 *    invisible to the markup scan — the v3.25.0 blind spot that made a
 *    checkbox count read six when it was seven.
 *  - NOTHING HERE CHECKS THE JS. A control that is never rendered, or is
 *    covered by another element, still passes.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const NEXT = path.join(ROOT, 'src/public/next');

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function section(t) { console.log(`\n${t}`); }

// ─────────────────────────────────────────────────────────────────────────
// Corpus
// ─────────────────────────────────────────────────────────────────────────

function walk(dir, ext, acc = []) {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, ext, acc);
    else if (p.endsWith(ext)) acc.push(p);
  }
  return acc;
}

/**
 * Strip /* … *\/ comments. LOAD-BEARING, not hygiene.
 *
 * v3.24.2's scanner did not do this and a prose comment naming `.btn` above a
 * border-declaring rule hid THREE of five real bugs. v3.26.0 hit the same
 * class three more times in one session, once in a comment that quoted the
 * very values it had just removed. This file's own CSS is dense with comments
 * that name `:active`, `transform` and `translateY(0.5px)` — the historical
 * value — so without this every assertion below would read those comments as
 * rules and pass on a tree that had been gutted. §7 keeps a positive control
 * that goes red if this is removed.
 */
function stripCssComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/**
 * JS comments, same reasoning. Only FULL-LINE `//` comments are stripped
 * (the `//` must start the trimmed line), so a `//` inside a string literal —
 * a URL, a regex — survives. Conservative in the direction that keeps real
 * markup visible.
 */
function stripJsComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map(l => (/^\s*\/\//.test(l) ? '' : l))
    .join('\n');
}

/** Every `selector { body }` pair, at any nesting depth (@media included). */
function collectRules(css) {
  const out = [];
  const stack = [];
  let selStart = 0;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '{') {
      stack.push({ sel: css.slice(selStart, i), bodyStart: i + 1, at: i });
      selStart = i + 1;
    } else if (ch === '}') {
      const frame = stack.pop();
      if (frame) {
        const body = css.slice(frame.bodyStart, i);
        if (!body.includes('{')) {
          out.push({
            selector: frame.sel.trim(),
            body,
            offset: frame.at,
            // The enclosing at-rule preludes, outermost first.
            wrappers: stack.map(s => s.sel.trim()),
          });
        }
      }
      selStart = i + 1;
    }
  }
  return out;
}

const CSS_FILES = walk(NEXT, '.css').sort();
const JS_FILES = walk(NEXT, '.js').sort();

const RULES = [];
for (const file of CSS_FILES) {
  const rel = path.relative(NEXT, file);
  const raw = readFileSync(file, 'utf8');
  for (const r of collectRules(stripCssComments(raw))) RULES.push({ ...r, file: rel });
}

/** Rules that are NOT inside a prefers-reduced-motion block. */
const NORMAL_RULES = RULES.filter(r => !r.wrappers.some(w => /prefers-reduced-motion/.test(w)));
/** Rules that ARE inside a prefers-reduced-motion: reduce block. */
const REDUCE_RULES = RULES.filter(r => r.wrappers.some(w => /prefers-reduced-motion\s*:\s*reduce/.test(w)));

function declares(body, prop) {
  const esc = prop.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  return new RegExp(`(?:^|[;{])\\s*${esc}\\s*:`).test(body);
}
function declValue(body, prop) {
  const esc = prop.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  const m = body.match(new RegExp(`(?:^|[;{])\\s*${esc}\\s*:([^;}]*)`));
  return m ? m[1].trim() : null;
}
function classEsc(c) { return c.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'); }
function classRe(c) { return new RegExp('\\.' + classEsc(c) + '(?![\\w-])'); }
function classesIn(selector) {
  return [...selector.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m => m[1]);
}

const TOKENS_MOTION = stripCssComments(readFileSync(path.join(NEXT, 'tokens/motion.css'), 'utf8'));
const TOKENS_MOTION_RAW = readFileSync(path.join(NEXT, 'tokens/motion.css'), 'utf8');

console.log('test-next-press-motion.js — the press vocabulary, its adoption, and its reduced-motion contract\n');

// ─────────────────────────────────────────────────────────────────────────
// §1 — The vocabulary
// ─────────────────────────────────────────────────────────────────────────
section('1. The press vocabulary exists and composes tokens that were already there');

ok(CSS_FILES.length >= 15, `walked the /next CSS tree from disk (${CSS_FILES.length} stylesheets, never a hardcoded list)`);
ok(JS_FILES.length >= 15, `walked the /next JS tree from disk (${JS_FILES.length} modules)`);

const PRESS_TOKENS = ['--press-shift', '--press-scale', '--press-scale-icon', '--t-press'];
for (const t of PRESS_TOKENS) {
  ok(new RegExp(`(?:^|[;{])\\s*${classEsc(t)}\\s*:`, 'm').test(TOKENS_MOTION),
    `tokens/motion.css defines ${t}`);
}

const tPress = declValue(TOKENS_MOTION.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] || TOKENS_MOTION, '--t-press');
ok(tPress !== null && /var\(--dur-instant\)/.test(tPress) && /var\(--ease-out\)/.test(tPress),
  `--t-press COMPOSES existing tokens rather than minting a duration (got: ${tPress})`);

/**
 * --t-press is a CONSOLIDATION and this assertion is the proof. Before it,
 * the pairing `var(--dur-instant) var(--ease-out)` was spelled out longhand
 * in two separate transition declarations. It must now appear nowhere except
 * the token's own definition — otherwise the "one name for one value"
 * argument in tokens/motion.css is false in its own tree.
 */
const longhandPress = [];
for (const r of RULES) {
  if (r.file === 'tokens/motion.css') continue;
  const tr = declValue(r.body, 'transition');
  if (tr && /var\(--dur-instant\)\s*var\(--ease-out\)/.test(tr)) {
    longhandPress.push(`${r.file} ${r.selector}`);
  }
}
ok(longhandPress.length === 0,
  `no stylesheet spells the press pairing out longhand — it reads --t-press${longhandPress.length ? ' (found: ' + longhandPress.join('; ') + ')' : ''}`);

/**
 * --t-select is deliberately ABSENT, and the assertion is PAIRED with the
 * measurement that justifies the absence — the v3.25.0 §4a shape, where a
 * hand-written list that merely BANS a name can silently keep banning
 * something that has since become correct. The proposal defined --t-select as
 * `var(--dur-fast) var(--ease-out)`, byte-identical to --t-state. If someone
 * later has a real reason for a distinct selection duration, this assertion
 * fails and they must change --t-state or state the difference — which is the
 * conversation worth having, rather than an alias appearing quietly.
 */
const rootBlock = TOKENS_MOTION.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] || '';
const tState = declValue(rootBlock, '--t-state');
ok(!/(?:^|[;{])\s*--t-select\s*:/m.test(TOKENS_MOTION),
  'no --t-select token — it would be a second name for --t-state');
ok(tState === 'var(--dur-fast) var(--ease-out)',
  `…and the reason is measurable, not stylistic: --t-state IS the value --t-select was proposed as (got: ${tState})`);

// ─────────────────────────────────────────────────────────────────────────
// §2 — AMPLITUDE RATCHET
// ─────────────────────────────────────────────────────────────────────────
section('2. Amplitude ratchet — every :active transform reads a press token, never a literal');

const ACTIVE_RULES = NORMAL_RULES.filter(r => /:active/.test(r.selector));
ok(ACTIVE_RULES.length >= 25,
  `the tree carries ${ACTIVE_RULES.length} press rules outside reduced-motion blocks (it carried TWO before this change)`);

/**
 * Transform functions and their arguments, PAREN-BALANCED.
 *
 * The first draft used `/\bscale\(([^)]*)\)/`, which stops at the first `)` —
 * and every correct value in this tree is `scale(var(--press-scale))`, whose
 * first `)` closes the `var(`. So the naive pattern captured
 * `var(--press-scale` , failed the token match, and reported all 38 CORRECT
 * rules as literals while a genuine `scale(0.97)` would have looked the same.
 * A detector that fires on everything is as useless as one that fires on
 * nothing; §7b's control is what proves this version still fires on a real
 * literal.
 */
function transformCalls(value) {
  const out = [];
  const re = /\b(scale|scaleX|scaleY|translate|translateX|translateY)\(/g;
  let m;
  while ((m = re.exec(value))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < value.length && depth > 0; i++) {
      if (value[i] === '(') depth++;
      else if (value[i] === ')') depth--;
    }
    out.push({ fn: m[1], arg: value.slice(start, i - 1).trim() });
    re.lastIndex = i;
  }
  return out;
}

const badTransforms = [];
const usedScaleTokens = new Set();
const usedShiftTokens = new Set();
for (const r of ACTIVE_RULES) {
  const tf = declValue(r.body, 'transform');
  if (!tf || tf === 'none') continue;
  for (const { fn, arg } of transformCalls(tf)) {
    const isScale = fn.startsWith('scale');
    if (isScale) {
      if (/^var\(--press-scale\)$/.test(arg)) usedScaleTokens.add('--press-scale');
      else if (/^var\(--press-scale-icon\)$/.test(arg)) usedScaleTokens.add('--press-scale-icon');
      else badTransforms.push(`${r.file} "${r.selector}" ${fn}(${arg})`);
    } else {
      if (/^var\(--press-shift\)$/.test(arg)) usedShiftTokens.add('--press-shift');
      else badTransforms.push(`${r.file} "${r.selector}" ${fn}(${arg})`);
    }
  }
}
ok(badTransforms.length === 0,
  `no press transform uses a literal amplitude${badTransforms.length ? ' (found: ' + badTransforms.join('; ') + ')' : ''}`);
ok(usedScaleTokens.size === 2,
  `exactly TWO scale amplitudes are in use, both tokens (${[...usedScaleTokens].sort().join(', ')}) — a third would be drift`);
ok(usedShiftTokens.has('--press-shift'),
  'the translate amplitude is --press-shift');

/**
 * The specific historical value, pinned. `translateY(0.5px)` was the shipping
 * press for four releases and measured 0.4716px live. It is banned by name so
 * a revert reads as a REGRESSION rather than as a plausible edit.
 */
const halfPx = [];
for (const r of RULES) {
  const tf = declValue(r.body, 'transform');
  if (tf && /translateY\(\s*0?\.\d+px\s*\)/.test(tf)) halfPx.push(`${r.file} ${r.selector}`);
}
ok(halfPx.length === 0,
  `no rule reintroduces a sub-pixel translate (the 0.4716px defect)${halfPx.length ? ' (found: ' + halfPx.join('; ') + ')' : ''}`);

/** Every press transform needs a transform TRANSITION, or it snaps. */
const noTransitionFor = [];
for (const r of ACTIVE_RULES) {
  const tf = declValue(r.body, 'transform');
  if (!tf || tf === 'none') continue;
  for (const cls of classesIn(r.selector)) {
    const re = classRe(cls);
    const hasT = NORMAL_RULES.some(x => re.test(x.selector) && /transform/.test(declValue(x.body, 'transition') || ''));
    if (!hasT) noTransitionFor.push(`${r.file} ${r.selector} (.${cls})`);
  }
}
ok(noTransitionFor.length === 0,
  `every pressed class also declares a transform transition somewhere${noTransitionFor.length ? ' (missing for: ' + noTransitionFor.join('; ') + ')' : ''}`);

// ─────────────────────────────────────────────────────────────────────────
// §3 — ADOPTION, enumerated from disk
// ─────────────────────────────────────────────────────────────────────────
section('3. Adoption — controls ENUMERATED FROM DISK, resolved to classes, measured');

const TOKEN_RE = /^[a-zA-Z][\w-]*$/;
function tokensFrom(raw) {
  const pieces = raw.split(/[^\w-]+/).filter(Boolean);
  const out = new Set();
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    if (TOKEN_RE.test(p)) out.add(p);
    // A trailing hyphen means an interpolation split a class name in half —
    // re-join it with the next few tokens. A SUPERSET, so interpolated lists
    // are treated permissively (the same trade test-next-button-chrome.js
    // documents; refusing to analyse them trains people to add exemptions).
    if (/^[a-zA-Z][\w-]*-$/.test(p)) {
      for (let j = i + 1; j < pieces.length && j <= i + 4; j++) {
        if (TOKEN_RE.test(pieces[j])) out.add(p + pieces[j]);
      }
    }
  }
  return [...out];
}

const instances = [];
for (const file of JS_FILES) {
  const rel = path.relative(NEXT, file);
  const src = stripJsComments(readFileSync(file, 'utf8'));
  for (const m of src.matchAll(/<(button|div|a|li|span)\b[^>]*>/g)) {
    const whole = m[0];
    const tag = m[1];
    if (tag !== 'button' && !/role\s*=\s*["']button/.test(whole)) continue;
    const cm = whole.match(/class=(?:"([^"]*)"|'([^']*)')/);
    const cls = cm ? (cm[1] ?? cm[2]) : '';
    instances.push({
      file: rel,
      line: src.slice(0, m.index).split('\n').length,
      classes: tokensFrom(cls),
    });
  }
}

const pressCache = new Map();
function classHasPress(cls) {
  if (pressCache.has(cls)) return pressCache.get(cls);
  const re = classRe(cls);
  const v = ACTIVE_RULES.some(r => re.test(r.selector));
  pressCache.set(cls, v);
  return v;
}

const uncovered = instances.filter(i => !i.classes.some(classHasPress));
const covered = instances.length - uncovered.length;

ok(instances.length >= 150,
  `enumerated ${instances.length} button-role elements from the JS on disk (never a hardcoded roster)`);

/**
 * THE RATCHET. Measured at the time of writing: 188 of 200. The floor is a
 * measurement, not an aspiration — it may only move UP. Twelve remain
 * uncovered and each has a stated reason (link-shaped text controls, menu
 * options where instant is correct, the drop zone, and one element whose
 * press is painted by an ancestor); those reasons live in the CSS beside the
 * rules, not in an exemption list here, so an unexplained thirteenth would
 * fail this line rather than be silently absorbed.
 */
const FLOOR = 185;
ok(covered >= FLOOR,
  `${covered} of ${instances.length} button-role elements reach a press rule (${(covered / instances.length * 100).toFixed(1)}%) — floor ${FLOOR}`);

/**
 * ANTI-VACUITY. A scan that silently stops matching reports perfect coverage
 * forever. If `covered` ever equals `instances.length` that is far more
 * likely to mean the class resolution broke than that every link-shaped
 * control grew a press — so the suite says so out loud instead of going green.
 */
ok(uncovered.length > 0,
  `the scan can still SEE an uncovered control (${uncovered.length}) — total coverage here would mean the resolver broke, not that the tree is perfect`);
console.log(`    → uncovered, each deliberate: ${uncovered.map(u => u.classes[0] || '(no class)').join(', ')}`);

/**
 * The families the audit named by hand, asserted individually. §3's ratchet
 * is a population measure and a population can improve while the specific
 * screens the maintainer complained about stay dead — "clicking through the
 * sections acknowledges nothing" is about the RAIL, and no aggregate figure
 * proves the rail moved.
 */
const NAMED_FAMILIES = [
  // [class, label, must the press MOVE the element?]
  ['rail-btn', 'the rail — "clicking through the sections"', true],
  ['rail-theme-toggle', 'the theme toggle', true],
  ['settings-nav-row', 'the settings nav rows', true],
  ['theme-seg-btn', 'the segmented controls', true],
  ['dm-row', 'domain rows', true],
  ['mem-row', 'memory rows', true],
  ['ing-dest-row', 'ingest destination rows', true],
  ['chat-scope-pill', 'chat scope pills', true],
  ['chat-conv-row', 'conversation rows', true],
  ['chat-compile-btn', 'Compile to Wiki — the one control here that spends money', true],
  ['btn', 'the shared button', true],
  // DELIBERATELY false: a transform on the listbox trigger changes the rect
  // its own rAF positioner watches, so the open menu twitches. Listed with
  // the exclusion explicit rather than omitted from the list.
  ['lb-btn', 'the listbox trigger', false],
];
/**
 * "HAS A PRESS RULE" IS NOT ENOUGH, and M1 proved it.
 *
 * The first draft of this section asserted only that each family had SOME
 * `:active` rule. Deleting the rail's `transform` line entirely — the exact
 * defect the maintainer reported, "clicking a section acknowledges nothing" —
 * left the suite GREEN at 73/0, because `.rail-btn:not(.active):active` still
 * matched the class and satisfied the existence check.
 *
 * So the assertion is what the press DOES. Every named family's press rules,
 * taken together, must declare a transform or a background; and the families
 * whose whole reported defect was NOT MOVING must declare a transform
 * specifically. `.lb-btn` is the one family deliberately excluded from the
 * transform requirement — its rAF positioner reads the trigger's rect (see
 * the assertion below) — so it is listed with `moves: false` rather than
 * being skipped, which keeps the exclusion visible and asserted.
 */
for (const [cls, label, moves] of NAMED_FAMILIES) {
  const rules = ACTIVE_RULES.filter(r => classRe(cls).test(r.selector));
  ok(rules.length > 0, `${label} (.${cls}) has a press rule`);
  const doesSomething = rules.some(r => declares(r.body, 'transform') || declares(r.body, 'background'));
  ok(doesSomething, `…and it actually CHANGES something (transform or background), not merely exists`);
  if (moves) {
    const movesNow = rules.some(r => {
      const tf = declValue(r.body, 'transform');
      return tf && tf !== 'none';
    });
    ok(movesNow, `…and .${cls} MOVES on press — the reported defect was a real mousedown returning transform: none`);
  }
}

/**
 * A whole-tree ratchet on the same property, so a family NOT in the list
 * above cannot lose its movement silently either. Measured at the time of
 * writing.
 */
const movingPresses = ACTIVE_RULES.filter(r => {
  const tf = declValue(r.body, 'transform');
  return tf && tf !== 'none';
});
ok(movingPresses.length >= 29,
  `${movingPresses.length} press rules actually move their element (floor 29) — the tree had TWO, both sub-pixel`);

/**
 * The listbox trigger is the ONE deliberate exception to "a press moves":
 * shared/listbox.js keeps an open menu aligned with a rAF loop that watches
 * the trigger's getBoundingClientRect, and a transform is reflected in that
 * rect — so a press transform there makes the open popup twitch and re-runs
 * a full re-measure of a list that can hold ~200 rows. Asserted so a later
 * uniformity pass has to read the reason before "fixing" it.
 */
const lbActive = ACTIVE_RULES.filter(r => classRe('lb-btn').test(r.selector));
ok(lbActive.length > 0 && lbActive.every(r => !declares(r.body, 'transform')),
  '.lb-btn press is BACKGROUND ONLY — a transform changes the rect its own rAF positioner watches');
ok(lbActive.some(r => declares(r.body, 'background')),
  '…and it does step the background, so the press is still acknowledged');

/** `--accent-active` had zero consumers tree-wide. It must now have one. */
const accentActiveUsers = NORMAL_RULES.filter(r => /var\(--accent-active\)/.test(r.body));
ok(accentActiveUsers.length >= 1,
  `--accent-active is finally consumed (${accentActiveUsers.length} rule(s)) — it had ZERO consumers tree-wide`);
ok(accentActiveUsers.every(r => /:active/.test(r.selector)),
  '…and only by press states, which is the pairing it was authored for');

// ─────────────────────────────────────────────────────────────────────────
// §4 — REDUCED MOTION, PER ELEMENT
// ─────────────────────────────────────────────────────────────────────────
section('4. Reduced motion — decided per element, not by a blanket sweep');

/**
 * Every press transform must be neutralised by a reduce rule IN THE SAME FILE
 * that itself sets `transform`. Same rule shape as
 * scripts/test-next-reduced-motion.js uses for animations: mere selector
 * re-appearance confers no coverage, because a reduce block that touches an
 * unrelated property is the false-exemption hole that suite already records.
 */
const reduceTransformSelectors = new Map(); // file -> Set of selector fragments
for (const r of REDUCE_RULES) {
  if (!declares(r.body, 'transform')) continue;
  if (!reduceTransformSelectors.has(r.file)) reduceTransformSelectors.set(r.file, []);
  for (const part of r.selector.split(',')) reduceTransformSelectors.get(r.file).push(part.trim());
}

const unneutralised = [];
for (const r of ACTIVE_RULES) {
  const tf = declValue(r.body, 'transform');
  if (!tf || tf === 'none') continue;
  const mine = reduceTransformSelectors.get(r.file) || [];
  for (const part of r.selector.split(',').map(s => s.trim())) {
    if (!mine.includes(part)) unneutralised.push(`${r.file} "${part}"`);
  }
}
ok(unneutralised.length === 0,
  `every press transform has a same-file reduced-motion rule that itself sets transform${unneutralised.length ? ' (missing: ' + unneutralised.join('; ') + ')' : ''}`);

/** …and it must actually be `none`, not a smaller amplitude. */
const notNone = REDUCE_RULES
  .filter(r => /:active/.test(r.selector) && declares(r.body, 'transform'))
  .filter(r => declValue(r.body, 'transform') !== 'none');
ok(notNone.length === 0,
  `every reduced-motion press rule sets transform: none, not a reduced amplitude${notNone.length ? ' (found: ' + notNone.map(r => r.file + ' ' + r.selector).join('; ') + ')' : ''}`);

/**
 * THE OPPOSITE DECISION, ASSERTED. The ingest progress ring KEEPS animating
 * under reduced motion — it is the only signal that a multi-minute,
 * money-spending write is alive, so removing its motion removes the
 * information. This is the assertion that stops a future "turn all motion
 * off" tidy-up from folding it in with the presses.
 */
const ringReduce = REDUCE_RULES.filter(r => /\.pring-orbit\b/.test(r.selector) && declares(r.body, 'animation'));
ok(ringReduce.length === 1,
  'the ingest ring has exactly one reduced-motion animation rule');
ok(ringReduce.length === 1 && declValue(ringReduce[0].body, 'animation') !== 'none',
  `the ingest ring is NOT disabled under reduced motion — it SUBSTITUTES (got: ${ringReduce[0] ? declValue(ringReduce[0].body, 'animation') : 'n/a'})`);
ok(ringReduce.length === 1 && /pring-breathe/.test(declValue(ringReduce[0].body, 'animation') || ''),
  '…specifically a slow opacity breath, so the "still working" signal survives');

/**
 * THE SELECTION EDGES KEEP THEIR POSITION. `transform: scaleY(1)` on an
 * `.active::before` IS the accent bar. A reduce rule that set `transform:
 * none` there would collapse the bar and take away the only mark saying
 * which row is selected — removing information rather than motion. The edges
 * must be reduced by killing the TRANSITION, never the transform.
 */
const EDGE_SELECTORS = ['.settings-nav-row::before', '.chat-conv-row::before'];
for (const sel of EDGE_SELECTORS) {
  const base = NORMAL_RULES.find(r => r.selector === sel);
  ok(!!base && declValue(base.body, 'transform') === 'scaleY(0)',
    `${sel} is declared on the BASE rule at scaleY(0) — a ::before generated by .active has no start value and can only appear instantly`);
  const activeEdge = NORMAL_RULES.find(r => r.selector === sel.replace('::before', '.active::before'));
  ok(!!activeEdge && declValue(activeEdge.body, 'transform') === 'scaleY(1)',
    `${sel.replace('::before', '.active::before')} scales it to 1, so there are two states to interpolate`);
  ok(!!base && /transform/.test(declValue(base.body, 'transition') || ''),
    `${sel} transitions its transform`);
  const red = REDUCE_RULES.filter(r => r.selector.split(',').map(s => s.trim()).includes(sel));
  ok(red.length > 0 && red.every(r => !declares(r.body, 'transform')),
    `${sel} under reduced motion loses its TRANSITION and KEEPS its position — transform: none would delete the state marker`);
  ok(red.some(r => declValue(r.body, 'transition') === 'none'),
    `…and it does explicitly say transition: none`);
}

// ─────────────────────────────────────────────────────────────────────────
// §5 — KEYFRAME CONSOLIDATION
// ─────────────────────────────────────────────────────────────────────────
section('5. Keyframe consolidation — one rotate, one panel entrance, no duplicate bodies');

const keyframes = [];
for (const file of CSS_FILES) {
  const rel = path.relative(NEXT, file);
  const css = stripCssComments(readFileSync(file, 'utf8'));
  for (const m of css.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
    // Brace-match the body.
    let depth = 0, i = m.index + m[0].length - 1, start = i + 1;
    for (; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') { depth--; if (depth === 0) break; }
    }
    keyframes.push({
      name: m[1],
      file: rel,
      body: css.slice(start, i).replace(/\s+/g, ' ').trim(),
    });
  }
}

ok(keyframes.length >= 5, `found ${keyframes.length} @keyframes across the tree`);

/**
 * THE DUPLICATE-BODY CHECK. `mcpwFadeIn` and `sbwFadeIn` were byte-equivalent
 * to each other and to `curator-panel-in` — proven by normalising whitespace
 * and comparing bodies, which is the same evidence used to justify deleting
 * them. `chat-spin` was byte-equivalent to `curator-spin`. This is the rule
 * that stops a fourth copy appearing.
 */
const byBody = new Map();
for (const k of keyframes) {
  if (!byBody.has(k.body)) byBody.set(k.body, []);
  byBody.get(k.body).push(`${k.name} (${k.file})`);
}
const dupes = [...byBody.values()].filter(v => v.length > 1);
ok(dupes.length === 0,
  `no two @keyframes share a body${dupes.length ? ' (duplicates: ' + dupes.map(d => d.join(' == ')).join(' | ') + ')' : ''}`);

const names = keyframes.map(k => k.name);
for (const gone of ['chat-spin', 'mcpwFadeIn', 'sbwFadeIn']) {
  ok(!names.includes(gone), `@keyframes ${gone} is RETIRED — it duplicated a keyframe that already existed`);
}
ok(names.includes('curator-panel-in'), '@keyframes curator-panel-in exists');
ok(keyframes.find(k => k.name === 'curator-panel-in')?.file === 'tokens/motion.css',
  '…and lives in tokens/motion.css, where a shared keyframe belongs');
ok(names.filter(n => n === 'curator-spin').length === 1, 'exactly one curator-spin definition');

/** Every rotate in the tree runs at the app's single cadence. */
const rotateDurations = new Set();
for (const r of NORMAL_RULES) {
  const a = declValue(r.body, 'animation');
  if (a && /curator-spin/.test(a)) {
    const d = a.match(/(\d+(?:\.\d+)?)s\b/);
    if (d) rotateDurations.add(d[1] + 's');
  }
}
ok(rotateDurations.size === 1 && rotateDurations.has('1.15s'),
  `every curator-spin consumer runs at the app's single rotate cadence (got: ${[...rotateDurations].join(', ')})`);

/** The panel entrance is shared, not re-implemented. */
const panelInUsers = NORMAL_RULES.filter(r => /curator-panel-in/.test(declValue(r.body, 'animation') || ''));
ok(panelInUsers.length >= 3,
  `curator-panel-in has ${panelInUsers.length} adopters (the two consolidated wizard panels plus the view-header info panel)`);
ok(panelInUsers.every(r => /var\(--dur-/.test(declValue(r.body, 'animation'))),
  'every curator-panel-in adopter takes its duration from a --dur-* token, so tokens/motion.css can reach it');

// ─────────────────────────────────────────────────────────────────────────
// §6 — CASCADE: a press background must be declared after its own hover
// ─────────────────────────────────────────────────────────────────────────
section('6. Cascade — a press background that ties with its hover must come later, or it never paints');

/**
 * TWO REAL BUGS OF THIS SHAPE were found and fixed while writing the CSS, and
 * both were invisible to every other check here: `.btn-primary:active` first
 * sat ABOVE `.btn-primary:hover`, and `.reader-backlink-row:active` sat ~200
 * lines above its own hover. Both are `.class:pseudo` — specificity 0,2,0 —
 * so they tie, the later one wins, and the press simply did not paint while
 * every "does a press rule exist" assertion stayed green.
 *
 * Specificity here is COUNTED, not computed (see NOT ENFORCED). It only has
 * to distinguish `.x:active` from `.x:hover:not(:disabled)`.
 */
function crudeSpecificity(sel) {
  const classes = (sel.match(/\.[a-zA-Z][\w-]*/g) || []).length;
  const pseudos = (sel.match(/:(?!:)[a-zA-Z-]+/g) || []).length;
  const attrs = (sel.match(/\[[^\]]*\]/g) || []).length;
  return classes + pseudos + attrs;
}

const cascadeProblems = [];
for (const r of ACTIVE_RULES) {
  if (!declares(r.body, 'background')) continue;
  const spec = crudeSpecificity(r.selector);
  for (const cls of classesIn(r.selector)) {
    const re = classRe(cls);
    for (const h of NORMAL_RULES) {
      if (h.file !== r.file) continue;              // same-file order only
      if (!/:hover/.test(h.selector)) continue;
      if (!re.test(h.selector)) continue;
      if (!declares(h.body, 'background')) continue;
      if (crudeSpecificity(h.selector) > spec) {
        cascadeProblems.push(`${r.file}: "${r.selector}" (${spec}) is OUTRANKED by "${h.selector}" (${crudeSpecificity(h.selector)}) — the press background can never paint`);
      } else if (crudeSpecificity(h.selector) === spec && h.offset > r.offset) {
        cascadeProblems.push(`${r.file}: "${r.selector}" ties with "${h.selector}" but is declared BEFORE it — the hover wins and the press background never paints`);
      }
    }
  }
}
ok(cascadeProblems.length === 0,
  `every press background outranks or postdates its own hover${cascadeProblems.length ? '\n      ' + cascadeProblems.join('\n      ') : ''}`);

/**
 * The same trap one level up: a reduced-motion rule is inside a media query,
 * which adds NO specificity. If a plain `.x:active { transform: … }` is
 * declared after the reduce block that neutralises it, the escape loses and
 * reduced motion is silently ignored — coverage that reads as coverage and
 * is not. This is why shell.css's reduce block is the last thing in the file.
 */
const reduceOrderProblems = [];
for (const red of REDUCE_RULES) {
  if (!declares(red.body, 'transform')) continue;
  for (const part of red.selector.split(',').map(s => s.trim())) {
    const later = NORMAL_RULES.filter(n =>
      n.file === red.file &&
      n.offset > red.offset &&
      n.selector.split(',').map(s => s.trim()).includes(part) &&
      declares(n.body, 'transform'));
    for (const l of later) {
      reduceOrderProblems.push(`${red.file}: reduced-motion rule for "${part}" is declared BEFORE the plain rule at offset ${l.offset} — a media query adds no specificity, so the escape loses`);
    }
  }
}
ok(reduceOrderProblems.length === 0,
  `every reduced-motion transform escape is declared after the rule it neutralises${reduceOrderProblems.length ? '\n      ' + reduceOrderProblems.join('\n      ') : ''}`);

// ─────────────────────────────────────────────────────────────────────────
// §7 — CONTROLS
// ─────────────────────────────────────────────────────────────────────────
section('7. Controls — the checks above can actually fail');

// 7a. Comment stripping. THE control this repo keeps needing.
const commentTrap = `
/* Historical note: this used to read
   .fake-control:active { transform: translateY(0.5px); }
   and the old --t-select token was var(--dur-fast) var(--ease-out). */
.fake-control { color: red; }
`;
const trapRules = collectRules(stripCssComments(commentTrap));
ok(trapRules.length === 1 && trapRules[0].selector === '.fake-control',
  'CONTROL: a rule quoted inside a comment is NOT parsed as a rule (the v3.24.2 / v3.26.0 false-positive class)');
ok(!/:active/.test(stripCssComments(commentTrap)),
  'CONTROL: the comment-strip removes a `:active` that exists only in prose');
const unstripped = collectRules(commentTrap);
ok(unstripped.some(r => /:active/.test(r.selector) || /translateY\(0\.5px\)/.test(r.body)) || unstripped.length !== 1,
  'CONTROL (positive): WITHOUT the strip the same input parses differently — so the strip is doing real work, not decoration');

// 7b. The amplitude detector fires on a planted literal.
const plantedLiteral = collectRules(stripCssComments('.x:active { transform: translateY(0.5px) scale(0.97); }'));
let plantedBad = 0;
for (const r of plantedLiteral) {
  for (const { fn, arg } of transformCalls(declValue(r.body, 'transform') || '')) {
    void fn;
    if (!/^var\(--press-/.test(arg)) plantedBad++;
  }
}
ok(plantedBad === 2,
  'CONTROL: the amplitude detector fires on a planted literal translate AND a planted literal scale (got 2 findings)');

/**
 * THE PAREN-BALANCE CONTROL. The first draft of transformCalls stopped at the
 * first `)`, which sits INSIDE `var(--press-scale)` — so it reported all 38
 * correct rules as literals. This asserts the parser reads the whole nested
 * argument, which is what makes the assertion above discriminating rather
 * than merely loud.
 */
const nested = transformCalls('translateY(var(--press-shift)) scale(var(--press-scale))');
ok(nested.length === 2 && nested[0].arg === 'var(--press-shift)' && nested[1].arg === 'var(--press-scale)',
  `CONTROL: the transform parser is paren-BALANCED, so a var() argument is read whole (got: ${JSON.stringify(nested.map(n => n.arg))})`);

// 7c. The cascade detector fires on a planted wrong-order pair.
const plantedOrder = collectRules(stripCssComments(
  '.y:active { background: blue; }\n.y:hover { background: red; }'));
const a = plantedOrder.find(r => /:active/.test(r.selector));
const h = plantedOrder.find(r => /:hover/.test(r.selector));
ok(a && h && crudeSpecificity(a.selector) === crudeSpecificity(h.selector) && h.offset > a.offset,
  'CONTROL: the cascade detector recognises a tied hover declared after a press as a finding');

// 7d. The reduced-motion coverage check is not satisfied by an unrelated property.
const falseExemption = collectRules(stripCssComments(
  '@media (prefers-reduced-motion: reduce) { .z:active { color: red; } }'));
ok(falseExemption.length === 1 && !declares(falseExemption[0].body, 'transform'),
  'CONTROL: a reduce rule touching an unrelated property declares no transform, so it confers no coverage (the false-exemption hole test-next-reduced-motion.js records)');

// 7e. The keyframe duplicate detector fires.
const kfA = 'from { opacity: 0; } to { opacity: 1; }';
const planted = new Map([[kfA, ['aFade (x.css)', 'bFade (y.css)']]]);
ok([...planted.values()].filter(v => v.length > 1).length === 1,
  'CONTROL: two keyframes with identical bodies are reported as duplicates');

// 7f. Anti-vacuity on the corpus itself.
ok(NORMAL_RULES.length > 1000,
  `CONTROL: the rule corpus is populated (${NORMAL_RULES.length} rules outside reduce blocks) — an empty corpus would pass every "no bad rule found" assertion above`);
ok(REDUCE_RULES.length >= 10,
  `CONTROL: reduced-motion rules were actually found (${REDUCE_RULES.length}) — zero would make §4 vacuous`);
ok(instances.length > 0 && instances.some(i => i.classes.length > 0),
  'CONTROL: the markup scan resolved real class lists, so §3 is measuring something');

console.log('\n────────────────────────────────────────────────────────────');
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) {
  console.log('❌ press/motion assertions FAILED');
  process.exit(1);
}
console.log('✅ All /next press + motion assertions green');
