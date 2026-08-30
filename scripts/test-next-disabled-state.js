/**
 * test-next-disabled-state.js — OFFLINE suite.
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────
 * A design-system conformance audit found disabled "specified once and
 * implemented many ways". Measured from disk before this pass, the /next tree
 * carried SEVENTEEN disabled rules using FIVE different opacities:
 *
 *     0.45 x6   0.55 x4   0.6 x3   0.5 x3   0.35 x1
 *
 * and only six of the seventeen matched the system. Two more used
 * `cursor: default` — not a variant of the disabled state, the absence of one
 * — and one declared no cursor at all.
 *
 * ── TWO EARLIER TALLIES, AND WHY THEY DISAGREED ──────────────────────────
 * The audit's own tally (0.55 x4, 0.45 x4, 0.6 x3, 0.5 x3, 0.35 x1) did not
 * reproduce under a later whole-tree scan (0.45 x6, 0.55 x5, 0.6 x4, 0.5 x3,
 * 0.35 x3), and v3.25.0 recorded "nine distinct opacity values tree-wide".
 * All three are right about different things, and the difference is the
 * lesson: the second scan counted EVERY `opacity:` declaration in the tree,
 * including scrim fades (0 and 1), the progress ring's SVG arcs (0.25/0.45),
 * a keyframe (0.35), a chip's counter (0.75) and a "handled" row (0.6). Nine
 * is the correct count of opacity VALUES; it is not a count of ways disabled
 * is implemented. This suite counts disabled RULES — a rule whose selector
 * actually selects a disabled element — which is why it can be enforced.
 *
 * ── WHAT THE DESIGN SYSTEM SPECIFIES ─────────────────────────────────────
 * Once, in its readme's "Interaction states" list: `opacity: 0.45`,
 * `cursor: not-allowed`, no colour change. All four of the bundle's own
 * implementations agree literally (Button.jsx, IconButton.jsx, Checkbox.jsx,
 * ui_kits/app/primitives.jsx). The system's text ramp guideline separately
 * captions `--text-faint` "disabled", but that is a caption on a swatch and
 * NO component implements disabled as a colour — see shell.css's own comment
 * for why following the caption would be wrong here. The value is adopted as
 * `--opacity-disabled` in shell.css; the token is DERIVED (the bundle has no
 * opacity token, because its components are JSX and can write the literal
 * inline) but the VALUE is the system's.
 *
 * ── THE CURSOR / POINTER-EVENTS CONTRADICTION ────────────────────────────
 * Three rules paired `cursor: not-allowed` with `pointer-events: none`. An
 * element with no pointer events cannot show a cursor, so one of the two
 * declarations was always dead. Measured in a real browser before the fix,
 * `elementFromPoint` at a disabled `.btn`'s own centre returned a DIFFERENT
 * element in both themes. `pointer-events: none` is removed at all three:
 * every element those rules reach is a real `<button disabled>`, which the UA
 * already refuses to click and already removes from the tab order, so the
 * suppression bought nothing and cost the cursor, hover, and any tooltip —
 * the unreachability class v3.23.0 recorded when Sync's cross-write refusal
 * could not be read at all.
 *
 * The clearest evidence it was accidental is in views/sync.css: the rule
 * DIRECTLY BELOW the one carrying it, `.sync-disconnect-link[disabled]:hover`,
 * cancels a `--danger-text` hover so a disabled Disconnect does not turn red
 * — and with pointer-events suppressed that rule could never match. Removing
 * the suppression made an already-written, already-correct rule live.
 *
 * ── WHAT IS NOT ENFORCED ─────────────────────────────────────────────────
 *  - CASCADE AND SPECIFICITY. This suite reads declarations, not winners.
 *    "The rule for this selector uses the token" is weaker than "the token
 *    wins" — the right check for a drifted literal, the wrong tool for an
 *    override fight. A later rule at higher specificity re-declaring a
 *    literal opacity on the same element is INVISIBLE here.
 *  - THE GENERAL NESTED-OPACITY COMPOUND. Nested opacities multiply, and no
 *    static scan can know which container wraps which control at runtime.
 *    The one live instance is pinned BY NAME in §6 and was measured in a real
 *    browser; a NEW container opacity over a NEW disabled control would not
 *    go red here. That is the honest gap, and it is why the browser
 *    measurement exists rather than being replaced by this file.
 *  - RUNTIME-COMPOSED SELECTORS. A class assembled at runtime from fragments
 *    is not resolved.
 *  - WHETHER A CONTROL SHOULD BE DISABLED AT ALL. Purely presentational.
 *  - NON-/next TREES. The frozen `/old` app is deliberately out of scope.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const NEXT = path.join(ROOT, 'src/public/next');

const TOKEN = '--opacity-disabled';
const SPEC_VALUE = '0.45';          // the design system's readme, verbatim

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function section(t) { console.log(`\n${t}`); }

// ─────────────────────────────────────────────────────────────────────────
// Filesystem + CSS parsing — same shapes as test-next-checkbox.js /
// test-next-button-chrome.js, deliberately, so one reader learns them once.
// ─────────────────────────────────────────────────────────────────────────

function walk(dir, exts, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, exts, acc);
    else if (exts.some(e => p.endsWith(e))) acc.push(p);
  }
  return acc;
}

/**
 * Strip block comments.
 *
 * LOAD-BEARING, NOT HYGIENE, and this suite has an unusually direct proof of
 * it: the fix it guards WRITES prose comments that name `pointer-events: none`
 * on the line above `cursor: not-allowed` — because explaining a removal
 * requires naming the thing removed. Without the strip, §4's contradiction
 * detector fires on the very comments explaining why the contradiction is
 * gone. v3.24.2's scanner hid three of five real bugs by skipping this step;
 * here it would invert into three false alarms. §7 keeps that as a control.
 */
function stripCssComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

function stripSourceComments(text, ext) {
  if (ext === '.html') return text.replace(/<!--[\s\S]*?-->/g, ' ');
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/[^\n]*/gm, ' ');
}

/** Every `selector { body }` pair, at any nesting depth (@media included). */
function collectRules(css) {
  const out = [];
  const stack = [];
  let selStart = 0;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '{') {
      stack.push({ sel: css.slice(selStart, i), bodyStart: i + 1 });
      selStart = i + 1;
    } else if (ch === '}') {
      const frame = stack.pop();
      if (frame) {
        const body = css.slice(frame.bodyStart, i);
        if (!body.includes('{')) out.push({ selector: frame.sel.trim(), body });
      }
      selStart = i + 1;
    }
  }
  return out;
}

/** The declared value of `prop` in a rule body, or null. */
function valueOf(body, prop) {
  const esc = prop.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  const m = new RegExp(`(?:^|[;{])\\s*${esc}\\s*:\\s*([^;}]+)`).exec(body);
  return m ? m[1].trim() : null;
}

/**
 * Does this selector select a DISABLED element?
 *
 * `:not(...)` contents are removed first, because `.x:hover:not(:disabled)`
 * mentions `:disabled` while being an ENABLED-state rule — counting it would
 * put four hover rules into the disabled set and then demand they carry a
 * disabled opacity. Nested `:not()` is not expected here and the strip is
 * applied repeatedly so a single level cannot hide a second.
 */
function selectsDisabled(selector) {
  let s = selector;
  for (let i = 0; i < 5; i++) s = s.replace(/:not\([^()]*\)/g, ' ');
  return /:disabled|\[disabled\]|\[aria-disabled\s*=\s*["']?true|\bis-disabled\b/.test(s);
}

const CSS_FILES = walk(NEXT, ['.css']).sort();
const MARKUP_FILES = walk(NEXT, ['.js', '.html']).sort();

const RULES = [];
for (const file of CSS_FILES) {
  const rel = path.relative(NEXT, file);
  for (const r of collectRules(stripCssComments(readFileSync(file, 'utf8')))) {
    RULES.push({ ...r, file: rel });
  }
}
const DISABLED_RULES = RULES.filter(r => selectsDisabled(r.selector));

console.log('════════════════════════════════════════════════════════════');
console.log('  DISABLED STATE — one value, one cursor, no contradiction');
console.log('════════════════════════════════════════════════════════════');
console.log(`  ${CSS_FILES.length} stylesheets · ${RULES.length} rules · ` +
            `${DISABLED_RULES.length} of them select a disabled element`);

// ─────────────────────────────────────────────────────────────────────────
section('§1  The token is defined once, in a file every view loads');
// ─────────────────────────────────────────────────────────────────────────

const tokenDefs = RULES.filter(r => valueOf(r.body, TOKEN) !== null);
ok(tokenDefs.length === 1,
   `${TOKEN} is defined EXACTLY once (found ${tokenDefs.length}` +
   (tokenDefs.length ? `: ${tokenDefs.map(d => `${d.file} in "${d.selector}"`).join(', ')}` : '') +
   ') — two definitions is how a "unified" value drifts apart again');
if (tokenDefs.length === 1) {
  ok(tokenDefs[0].file === 'shell.css',
     `it lives in shell.css (${tokenDefs[0].file}), which loads after tokens/ and before every ` +
     'view — tokens/base.css and tokens/shape.css are byte-frozen and may not gain it');
  ok(tokenDefs[0].selector.trim() === ':root',
     `it is declared on :root (got "${tokenDefs[0].selector.trim()}") so every view inherits it`);
  ok(valueOf(tokenDefs[0].body, TOKEN) === SPEC_VALUE,
     `its value is ${SPEC_VALUE} — the design system's readme "Interaction states" figure, and the ` +
     'literal all four bundle components (Button/IconButton/Checkbox/primitives) write inline');
}
ok(!/\[data-theme/.test(tokenDefs.map(d => d.selector).join(' ')),
   'it is NOT theme-scoped — the system says disabled is "no colour change", so the same ' +
   'multiplier applies to both themes and a per-theme override would be a colour decision in disguise');

// ─────────────────────────────────────────────────────────────────────────
section('§2  Every disabled rule uses the token, never a literal');
// ─────────────────────────────────────────────────────────────────────────

const withOpacity = DISABLED_RULES.filter(r => valueOf(r.body, 'opacity') !== null);
const literalOpacity = withOpacity.filter(r => !valueOf(r.body, 'opacity').includes(`var(${TOKEN})`));
ok(literalOpacity.length === 0,
   'no disabled rule declares a LITERAL opacity' +
   (literalOpacity.length
     ? ` — found ${literalOpacity.length}: ` +
       literalOpacity.map(r => `${r.file} "${r.selector}" → ${valueOf(r.body, 'opacity')}`).join('; ')
     : ` (all ${withOpacity.length} route through var(${TOKEN}))`));

const distinct = new Set(withOpacity.map(r => valueOf(r.body, 'opacity').replace(/\s+/g, '')));
ok(distinct.size === 1,
   `the disabled opacity has ONE distinct declared value across the tree (${distinct.size}: ` +
   `${[...distinct].join(', ')}) — it had five before this pass`);

// ─────────────────────────────────────────────────────────────────────────
section('§3  Every disabled rule says so with the cursor');
// ─────────────────────────────────────────────────────────────────────────

const cursored = DISABLED_RULES.filter(r => valueOf(r.body, 'cursor') !== null);
const wrongCursor = cursored.filter(r => valueOf(r.body, 'cursor') !== 'not-allowed');
ok(wrongCursor.length === 0,
   'no disabled rule declares a cursor OTHER than not-allowed' +
   (wrongCursor.length
     ? ` — found ${wrongCursor.length}: ` +
       wrongCursor.map(r => `${r.file} "${r.selector}" → ${valueOf(r.body, 'cursor')}`).join('; ')
     : ' (`cursor: default` on two of them was the absence of a disabled state, not a variant of one)'));

const styling = DISABLED_RULES.filter(r => valueOf(r.body, 'opacity') !== null);
const noCursor = styling.filter(r => valueOf(r.body, 'cursor') === null);
ok(noCursor.length === 0,
   'every disabled rule that dims also declares the cursor' +
   (noCursor.length ? ` — missing on: ${noCursor.map(r => `${r.file} "${r.selector}"`).join('; ')}` : ''));

// ─────────────────────────────────────────────────────────────────────────
section('§4  The contradiction cannot reappear');
// ─────────────────────────────────────────────────────────────────────────

/** A rule declaring BOTH is self-cancelling wherever it appears. */
function contradicts(rule) {
  return valueOf(rule.body, 'cursor') === 'not-allowed' &&
         valueOf(rule.body, 'pointer-events') === 'none';
}
const contradictions = RULES.filter(contradicts);
ok(contradictions.length === 0,
   'NO rule anywhere in /next declares both `cursor: not-allowed` and `pointer-events: none`' +
   (contradictions.length
     ? ` — found ${contradictions.length}: ` +
       contradictions.map(r => `${r.file} "${r.selector}"`).join('; ')
     : ' — an element with no pointer events cannot render a cursor, so the pairing is always ' +
       'one dead declaration, in any rule, disabled or not'));

/**
 * REMOVING THE SUPPRESSION MADE A DORMANT RULE LIVE, so that rule is now
 * load-bearing and is pinned. `.sync-disconnect-link:hover` paints
 * `--danger-text`; the `[disabled]:hover` rule below it cancels that back to
 * `--text-2`. While `pointer-events: none` was set, the cancel could never
 * match and deleting it would have changed nothing. It can match now, and
 * deleting it would make a DISABLED Disconnect turn red under the cursor —
 * a control that reads as armed while refusing to act, on the destructive
 * end of the Sync view.
 */
const syncHoverCancel = RULES.filter(r =>
  /\.sync-disconnect-link\[disabled\]:hover/.test(r.selector) && valueOf(r.body, 'color') !== null);
ok(syncHoverCancel.length === 1,
   'the .sync-disconnect-link[disabled]:hover colour cancel is still present ' +
   `(${syncHoverCancel.length}) — it was DEAD CODE until pointer-events was removed and is ` +
   'load-bearing now: without it a disabled Disconnect turns --danger-text on hover');

const peSuppressed = DISABLED_RULES.filter(r => valueOf(r.body, 'pointer-events') === 'none');
ok(peSuppressed.length === 0,
   'no disabled rule suppresses pointer-events at all' +
   (peSuppressed.length
     ? ` — found ${peSuppressed.length}: ${peSuppressed.map(r => `${r.file} "${r.selector}"`).join('; ')}`
     : ' — the UA already refuses a disabled control\'s clicks and removes it from the tab order, ' +
       'so suppression adds nothing and removes hover, the cursor and any explanation'));

// ─────────────────────────────────────────────────────────────────────────
section('§5  The latent case that removing pointer-events would arm');
// ─────────────────────────────────────────────────────────────────────────

/**
 * `disabled` is INERT on an anchor. `.btn` is used on three <a> elements in
 * views/shared-brain-wizard.js, and there `pointer-events: none` would have
 * been the only thing stopping navigation. None of the three ever receives
 * the attribute today (setSaveChromeDisabled touches only #sbw-close and step
 * 5's Back, both <button>) — so this is pinned rather than defended by a rule
 * that breaks the cursor for every real button.
 */
const anchorBtnDisabled = [];
for (const file of MARKUP_FILES) {
  const ext = path.extname(file);
  const src = stripSourceComments(readFileSync(file, 'utf8'), ext);
  for (const tag of src.match(/<a\b[^>]*>/g) || []) {
    if (/class\s*=\s*["'][^"']*\bbtn\b/.test(tag) && /\bdisabled\b/.test(tag)) {
      anchorBtnDisabled.push(`${path.relative(NEXT, file)}: ${tag.slice(0, 90)}`);
    }
  }
}
ok(anchorBtnDisabled.length === 0,
   'no <a> carrying the .btn class also carries a `disabled` attribute' +
   (anchorBtnDisabled.length ? ` — found: ${anchorBtnDisabled.join('; ')}` : '') +
   ' — the attribute is inert on an anchor, so such an element would LOOK disabled and still ' +
   'navigate now that .btn[disabled] no longer suppresses pointer-events. Use aria-disabled and ' +
   'refuse the click in JS, as shared/listbox.js does for .lb-opt.');

const anchorSetsDisabled = [];
for (const file of walk(NEXT, ['.js'])) {
  const src = stripSourceComments(readFileSync(file, 'utf8'), '.js');
  // `someAnchorVar.disabled = …` cannot be resolved statically; what IS
  // checkable is a setAttribute('disabled') on an element selected by a
  // .btn-bearing anchor id used in this tree. None exists; assert the shape.
  if (/querySelector\([^)]*a\.btn[^)]*\)[^;]*\.disabled\s*=/.test(src)) {
    anchorSetsDisabled.push(path.relative(NEXT, file));
  }
}
ok(anchorSetsDisabled.length === 0,
   'no JS selects an `a.btn` and sets .disabled on it' +
   (anchorSetsDisabled.length ? ` — found in ${anchorSetsDisabled.join(', ')}` : ''));

// ─────────────────────────────────────────────────────────────────────────
section('§6  Container opacity over a disabled control (the compound)');
// ─────────────────────────────────────────────────────────────────────────

/**
 * Nested opacities MULTIPLY. Before this pass,
 * `.provider-row-unavailable { opacity: 0.55 }` wrapped a disabled `.btn` at
 * 0.45 and the two composed to an EFFECTIVE 0.2475 — measured in a real
 * browser at contrast 2.05 dark / 1.73 light, on a credentials screen.
 *
 * This is pinned BY NAME. The general shape is NOT enforced — see the header.
 */
const providerRow = RULES.filter(r => /\.provider-row-unavailable\b/.test(r.selector));
ok(providerRow.length > 0, 'the .provider-row-unavailable rules are still found by the scan');
const rowOpacity = providerRow.filter(r => valueOf(r.body, 'opacity') !== null);
ok(rowOpacity.length === 0,
   '.provider-row-unavailable declares NO opacity' +
   (rowOpacity.length
     ? ` — found ${rowOpacity.map(r => `${r.file} → ${valueOf(r.body, 'opacity')}`).join('; ')}` : '') +
   ' — it CONTAINS a disabled .btn, and a container opacity over a control opacity multiplies. ' +
   'A container de-emphasises with a colour token, which composites once.');
ok(providerRow.some(r => /var\(--text-3\)/.test(r.body)),
   'and it de-emphasises with --text-3 instead, which since v3.25.0 clears the 4.5 AA floor ' +
   'in both themes — so the row is dimmer AND more legible than the wash it replaces');

// ─────────────────────────────────────────────────────────────────────────
section('§7  Positive controls — every detector is run against a planted failure');
// ─────────────────────────────────────────────────────────────────────────

const PLANT_CONTRADICTION = '.x[disabled] { opacity: 0.45; cursor: not-allowed; pointer-events: none; }';
const PLANT_LITERAL = '.y:disabled { opacity: 0.6; cursor: not-allowed; }';
const PLANT_CURSOR = '.z[disabled] { opacity: var(--opacity-disabled); cursor: default; }';

ok(collectRules(PLANT_CONTRADICTION).filter(contradicts).length === 1,
   '§4\'s contradiction detector FIRES on a planted not-allowed + pointer-events:none rule');
ok(collectRules(PLANT_LITERAL).filter(r => selectsDisabled(r.selector) &&
     !String(valueOf(r.body, 'opacity')).includes(`var(${TOKEN})`)).length === 1,
   '§2\'s literal-opacity detector FIRES on a planted `opacity: 0.6` disabled rule');
ok(collectRules(PLANT_CURSOR).filter(r => selectsDisabled(r.selector) &&
     valueOf(r.body, 'cursor') !== 'not-allowed').length === 1,
   '§3\'s cursor detector FIRES on a planted `cursor: default` disabled rule');

/**
 * THE COMMENT-STRIP CONTROL — MEASURED ON THE REAL TREE, BOTH WAYS.
 *
 * This control's FIRST DRAFT WAS WRONG AND IS RECORDED RATHER THAN QUIETLY
 * REPLACED, because the way it was wrong is the finding. It planted a
 * synthetic rule with a comment above it and expected §4's contradiction
 * detector to fire without the strip. It did not, and could not: a comment
 * ABOVE a rule lands in the SELECTOR, and `contradicts()` reads the BODY.
 * Asserting a mechanism from the shape of a previous release's bug rather
 * than from this scanner's own behaviour is exactly the error this repo
 * keeps recording.
 *
 * So the control now RE-PARSES THE WHOLE TREE with the strip disabled and
 * compares the numbers. Measured at the time of writing:
 *
 *              STRIPPED   RAW
 *   rules        1528     1540   (+12 phantom rules)
 *   disabled       18       20   (+2 — a comment saying "disabled" above an
 *                                 unrelated rule pulls it into the set)
 *   wrongCursor     0        1   (a FALSE FAILURE on a rule dragged in above)
 *   provider        1        2   (§6's own selector match is satisfied by a
 *                                 COMMENT naming .provider-row-unavailable)
 *   providerOpacity 0        1   (so §6 reports the fixed compound as still
 *                                 broken, because the prose explaining the
 *                                 fix quotes the opacity it removed)
 *
 * v3.24.2's comment bug HID three real defects; this one INVENTS two. Both
 * directions are the same defect in the parser, and the strip is what closes
 * it. The assertions below pin the DIRECTION and the fact that the numbers
 * differ, not the exact figures, which move whenever a comment is edited.
 */
function parseTree(useStrip) {
  const rules = [];
  for (const file of CSS_FILES) {
    const raw = readFileSync(file, 'utf8');
    for (const r of collectRules(useStrip ? stripCssComments(raw) : raw)) {
      rules.push({ ...r, file: path.relative(NEXT, file) });
    }
  }
  const dis = rules.filter(r => selectsDisabled(r.selector));
  const prov = rules.filter(r => /\.provider-row-unavailable\b/.test(r.selector));
  return {
    rules: rules.length,
    disabled: dis.length,
    wrongCursor: dis.filter(r => valueOf(r.body, 'cursor') !== null &&
                                 valueOf(r.body, 'cursor') !== 'not-allowed').length,
    providerWithOpacity: prov.filter(r => valueOf(r.body, 'opacity') !== null).length,
  };
}
const S = parseTree(true);
const R = parseTree(false);
ok(R.rules > S.rules,
   `the strip changes the parse of the REAL tree (${S.rules} rules stripped vs ${R.rules} raw) — ` +
   'if these ever match, either the strip stopped mattering or the parser stopped seeing comments, ' +
   'and this control has stopped controlling anything');
ok(R.disabled > S.disabled,
   `without the strip, comments inflate the disabled-rule set (${S.disabled} → ${R.disabled}) — ` +
   'prose saying "disabled" above an unrelated rule folds into its selector');
/* These two assert the DELTA, never the absolute. A first draft wrote
   `S.wrongCursor === 0 && R.wrongCursor > 0`, which also asserts the tree is
   clean — so a real §3 defect reddened this control as well, reporting a
   comment-parsing problem that did not exist. A control must measure the
   thing it controls for and nothing else, or it starts lying about which
   guard failed. Found by running the mutations, not by re-reading it. */
ok(R.wrongCursor > S.wrongCursor,
   `§3 sees MORE cursor failures raw than stripped (${S.wrongCursor} → ${R.wrongCursor}) — the extra ` +
   'one is a FALSE FAILURE on a rule dragged in by the comment above it');
ok(R.providerWithOpacity > S.providerWithOpacity,
   `§6 sees MORE provider-opacity hits raw than stripped (${S.providerWithOpacity} → ` +
   `${R.providerWithOpacity}) — because the comment explaining the compound fix QUOTES the opacity ` +
   'it removed, and an unstripped parse reads that prose as the rule. A guard that accepts its own ' +
   'explanation as evidence of the bug is worse than no guard.');

ok(selectsDisabled('.a:hover:not(:disabled)') === false,
   '`:not(:disabled)` is NOT counted as a disabled rule — four real hover rules in this tree ' +
   'have that shape, and counting them would demand a disabled opacity on an enabled state');
ok(selectsDisabled('.a:disabled') === true && selectsDisabled('.b[disabled]') === true &&
   selectsDisabled('.c[aria-disabled="true"]') === true && selectsDisabled('.d.is-disabled') === true,
   'and all four disabled shapes ARE counted (:disabled, [disabled], [aria-disabled], .is-disabled)');

// ─────────────────────────────────────────────────────────────────────────
section('§8  Anti-vacuity — the scan is still reaching real files');
// ─────────────────────────────────────────────────────────────────────────

ok(CSS_FILES.length > 15,
   `the stylesheet walk still reaches the tree (${CSS_FILES.length} files) — a walk resolving to ` +
   'an empty directory passes every per-rule assertion above by having no rules');
ok(RULES.length > 500,
   `the CSS parse still produces rules (${RULES.length}) — every "no rule does X" assertion is ` +
   'satisfied trivially by a parse that produced nothing');
ok(DISABLED_RULES.length >= 15,
   `${DISABLED_RULES.length} disabled rules found (18 at the time of writing: 17 that dim, plus ` +
   '`.sync-disconnect-link[disabled]:hover`, which only cancels a colour) — if this collapses, ' +
   'the selector test has stopped matching and §2-§4 are green over nothing');
ok(MARKUP_FILES.length > 10,
   `the markup walk still reaches the tree (${MARKUP_FILES.length} files) — §5 needs it`);

// ─────────────────────────────────────────────────────────────────────────

console.log('\n────────────────────────────────────────────────────────────');
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) {
  console.log('❌ disabled-state assertions FAILED');
  process.exit(1);
}
console.log('✅ All disabled-state assertions green');
console.log(`   → ${DISABLED_RULES.length} disabled rules, one value (var(${TOKEN}) = ${SPEC_VALUE}), ` +
            'one cursor, zero contradictions');
