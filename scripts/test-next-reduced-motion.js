/**
 * test-next-reduced-motion.js — OFFLINE suite. CLASS INVARIANT: no CSS
 * animation under src/public/next/** may carry a hardcoded time literal
 * (`0.16s`, `160ms`, …) as its duration unless that selector is ALSO
 * neutralized by a `prefers-reduced-motion: reduce` rule in the same file
 * that ITSELF sets `animation` or `animation-duration`.
 *
 * ── The bug this exists to catch ────────────────────────────────────────
 * tokens/motion.css's reduced-motion block zeroes only the --dur-* CUSTOM
 * PROPERTIES:
 *
 *   @media (prefers-reduced-motion: reduce) {
 *     :root { --dur-instant:0ms; --dur-fast:0ms; --dur-mid:0ms; ... }
 *   }
 *
 * Any rule that writes a literal duration straight into `animation:` never
 * reads a --dur-* variable, so that block can never reach it. Two rules did
 * exactly this — `.mcpw-panel` (views/mcp-wizard.css) and `.sbw-panel`
 * (views/shared.css) both shipped `animation: xFadeIn 0.16s ease;` — a
 * fourth, undocumented duration outside the 80/120/180/240/400ms scale, and
 * invisible to prefers-reduced-motion entirely. Both are fixed by this same
 * change to `var(--dur-mid) var(--ease-out)` plus an explicit
 * `@media (prefers-reduced-motion: reduce) { .sel { animation: none; } }`
 * escape (the same two-layer pattern already used by views/chat.css's
 * `.chat-spinner`, and now also self-satisfied by shared/progress-ring.css's
 * `.pring-orbit`, which deliberately SUBSTITUTES a gentler breathing
 * animation instead of disabling — see below).
 *
 * ── THE CORRECTED RULE (v2 — the v1 shape was itself a false-exemption
 *    hole, found by an adversarial audit BEFORE ship) ─────────────────────
 * The first version of this guard granted coverage from mere SELECTOR
 * RE-APPEARANCE inside any reduce block, without checking that the reduce
 * rule actually did anything to the animation. An audit built:
 *
 *   .probe-false-exemption { animation: probeKf 3.5s ease; }
 *   @media (prefers-reduced-motion: reduce) {
 *     .probe-false-exemption { color: red; }
 *   }
 *
 * — a reduce block that changes an UNRELATED property (`color`) and does
 * nothing about the animation at all — and the v1 guard reported it
 * COVERED. That is this repo's own named failure shape (a check that stops
 * reaching the thing it exists to protect) reproduced inside the very fix
 * meant to close an earlier instance of it. See §0 "false-exemption" and
 * the M5 mutation in the release history for the reproduction.
 *
 * The rule is now:
 *
 *   A selector is COVERED if and only if it appears in a rule under a
 *   `prefers-reduced-motion: reduce` stack IN THE SAME FILE, **and that
 *   same rule ITSELF sets an `animation` or `animation-duration`
 *   property** (to any value — `none`, a substitute animation, whatever).
 *   Nothing else counts as coverage. A reduce rule that repeats the
 *   selector but touches only some other property (color, opacity,
 *   `transition`, …) confers NO coverage.
 *
 * DECISION, stated explicitly per review: only the exact two properties
 * `animation` (shorthand) and `animation-duration` count as neutralizing
 * evidence — the SAME two properties section 2 scans for hardcoded
 * durations. Longhand-only overrides (`animation-name`, `animation-delay`,
 * `animation-iteration-count`, `animation-play-state`,
 * `animation-timing-function`, `animation-fill-mode`, `animation-direction`)
 * are DELIBERATELY NOT accepted as sufficient coverage, even though some of
 * them can plausibly reduce motion in practice (`animation-play-state:
 * paused` freezes at a keyframe rather than stopping the timeline;
 * `animation-iteration-count: 1` still runs the full configured DURATION
 * once — which is exactly the property this guard is checking — before
 * stopping; `animation-name: none` is a real disable path for a
 * single-value `animation-name` but none of this codebase's current rules
 * use it, and accepting it would require modelling `animation-name` value
 * lists to match it back to the right `animation` shorthand, which is more
 * complexity than the two real cases in this tree currently justify). A
 * genuine reduced-motion rule that relies on one of these longhands will be
 * reported as UNCOVERED and must add an explicit `animation:` or
 * `animation-duration:` override instead (as `.chat-spinner`'s `animation:
 * none;` and `.pring-orbit`'s substitute both already do) — this is a
 * FALSE POSITIVE in the fail-safe direction (blocks CI, forces a human to
 * look), never a false negative, which is the correct asymmetry for a
 * safety guard: see the NOT ENFORCED list below for where it is named
 * rather than silently narrowed.
 *
 * ── The rule, not a name list ────────────────────────────────────────────
 * This suite does NOT allowlist files or selectors by name. It applies one
 * rule to every CSS file under src/public/next/**, discovered by walking the
 * tree (never a hardcoded list — a hardcoded file list is exactly what let a
 * declarer slip past an earlier guard in this codebase; see
 * test-css-tokens.js's walkCssFiles docblock for the same lesson learned
 * once already):
 *
 *   For every `animation:` / `animation-duration:` declaration containing a
 *   bare (not `var(...)`-wrapped) CSS time literal, that declaration's
 *   selector must ALSO be COVERED (per the corrected rule above) by a
 *   `@media (prefers-reduced-motion: reduce) { ... }` block IN THE SAME
 *   FILE. If it is not, the declaration fails.
 *
 * Coverage is DERIVED, not declared. The two documented exemptions below are
 * not special-cased in code — they simply happen to satisfy the rule:
 *
 *   ENFORCED   — every .css file under src/public/next/** (walked
 *                recursively; new files/subdirectories are covered
 *                automatically, nothing to update here when one is added).
 *                A hardcoded `animation`/`animation-duration` literal is
 *                flagged unless the SAME selector, in a reduce rule in the
 *                SAME file, itself sets `animation` or `animation-duration`.
 *
 *   NOT ENFORCED (named, not implied away) —
 *     • A `prefers-reduced-motion: reduce` block in a DIFFERENT file does
 *       not confer coverage — coverage is deliberately per-file (matching
 *       how this codebase's two real fixes and both pre-existing correct
 *       examples are all structured: the reduce rule lives beside the rule
 *       it neutralizes). A shared cross-file reduce stylesheet, if one is
 *       ever introduced, would need this guard extended.
 *     • Coverage via a DIFFERENT-BUT-OVERLAPPING selector is not
 *       recognized — matching is exact-string (after selector-list
 *       splitting and whitespace normalisation) per selector. A reduce rule
 *       written against `.mcpw-panel.some-modifier`, an ancestor selector,
 *       a shared class, or the universal selector `*` would NOT be seen as
 *       covering a normal rule written against bare `.mcpw-panel`, even if
 *       it happens to apply to the same element at runtime.
 *     • Longhand-only reduce overrides do not confer coverage — see the
 *       DECISION paragraph above (`animation-play-state`, `animation-name`,
 *       `animation-iteration-count`, etc. alone are not accepted).
 *     • Inline `style="animation:...s"` attributes (in HTML or built by JS)
 *       are invisible to this guard — it scans only `.css` files, per the
 *       brief's scope. An animation duration set at runtime via JS
 *       (`el.style.animationDuration = '...'`) is equally invisible.
 *     • A `@media (prefers-reduced-motion)` query that does not spell the
 *       value `reduce` exactly (a malformed boolean-context query with no
 *       `: reduce` at all, or an explicit `: no-preference`) is correctly
 *       NOT treated as a reduce escape — this matches how a real browser
 *       would treat the same malformed/no-preference query, so it is not a
 *       guard-specific blind spot, but it is recorded here for completeness.
 *     • Two rules using `!important` or specificity tricks to fight for
 *       control of the same property are not analyzed for which one wins —
 *       this guard only checks for the PRESENCE of a same-file, same-
 *       selector reduce override, not cascade resolution.
 *
 * The two currently-shipping exemptions, verified against the corrected
 * rule (both keep the SAME verdict as before, because both genuinely set
 * `animation` inside their reduce rule — the v1→v2 change only had to
 * newly REJECT the adversarial probe, not any real code):
 *     • shared/progress-ring.css .pring-orbit — its NORMAL rule has a
 *       hardcoded `1.15s` (line ~57), and `.pring-orbit` reappears inside
 *       this file's own `prefers-reduced-motion: reduce` block (line ~115)
 *       setting `animation: pring-breathe 2.6s ease-in-out infinite;` —
 *       deliberately SUBSTITUTING a slow opacity-breathe animation rather
 *       than disabling outright (liveness is doctrine for a multi-minute
 *       ingest indicator — see that file's own header). The substitute
 *       rule's own `2.6s` literal is covered for the identical reason:
 *       `.pring-orbit` appears inside a reduce block that sets `animation`,
 *       so by the rule's own definition it is covered by itself.
 *     • views/chat.css .chat-spinner — its normal rule has a hardcoded
 *       `0.8s`, and a `prefers-reduced-motion: reduce` block in the same
 *       file sets `.chat-spinner { animation: none; }` — full disable, the
 *       other valid shape the rule accepts.
 *
 * A hardcoded literal that appears ONLY inside a reduce block's own
 * `animation`/`animation-duration` declaration (never outside one) is also
 * accepted: by construction it only ever runs when reduced motion was
 * explicitly requested, which is the reduced behaviour by definition — see
 * `.pring-orbit`'s own reduce-block declaration above, which the rule
 * accepts via this exact path (its selector is "covered" by itself, and
 * that coverage is earned because the rule DOES set `animation`, not merely
 * because the selector text reappears).
 *
 * A literal inside a `var(--x, <fallback>)` fallback is NOT treated as
 * hardcoded — the whole `var(...)` span (including any nested fallback) is
 * masked before scanning for bare time literals, because the primary value
 * still reads the custom property that CAN be zeroed by the reduced-motion
 * block; only a literal with no enclosing var() at all bypasses that block.
 *
 * Section 6 additionally asserts POSITIVELY that tokens/motion.css's reduce
 * block still zeroes all five --dur-* properties, so deleting that block
 * (which would make even a correctly-tokenized rule silently un-reducible)
 * fails loudly instead of this suite going quietly moot.
 *
 * Zero dependencies — node: builtins only, no CSS parser library. Mirrors
 * test-css-tokens.js's conventions (ok()/section() helpers, a synthetic
 * parser self-test section before touching real files, final
 * "Passed: N   Failed: M" summary line) but is entirely self-contained
 * rather than importing from it, so neither file's internals can drift the
 * other silently.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const NEXT_DIR = path.join(ROOT, 'src/public/next');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function section(t) { console.log(`\n${t}`); }

// ─────────────────────────────────────────────────────────────────────────
// The parser
// ─────────────────────────────────────────────────────────────────────────

/** Blank `/* *\/` block comments, preserving length + newlines so char
 *  offsets computed against the cleaned text stay valid line numbers
 *  against the ORIGINAL raw text.
 */
function stripBlockComments(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    if (text[i] === '/' && text[i + 1] === '*') {
      let j = text.indexOf('*/', i + 2);
      j = j === -1 ? n : j + 2;
      for (let k = i; k < j; k++) out += text[k] === '\n' ? '\n' : ' ';
      i = j;
    } else {
      out += text[i];
      i++;
    }
  }
  return out;
}

/** Blank the interior of '...' / "..." string literals (keep the quotes),
 *  so a decoy like `content: "animation: x 999s;"` can never be misread as
 *  a real declaration.
 */
function maskStrings(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const quote = c;
      out += c;
      i++;
      while (i < n && text[i] !== quote) {
        out += text[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) { out += text[i]; i++; }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function cleanCss(text) {
  return maskStrings(stripBlockComments(text));
}

function computeLineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function lineNumberFor(lineStarts, index) {
  let lo = 0, hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= index) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

/** Find the index of the `}` that closes the `{` at `openIdx`, brace-depth
 *  aware. Returns -1 if unbalanced (caller must handle gracefully — a
 *  malformed file must not crash the whole suite).
 */
function findMatchingBrace(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split a selector list on TOP-LEVEL commas (paren-depth aware, so a
 *  functional pseudo-class like `:not(.a, .b)` is not mistaken for two
 *  selectors), then normalise each to a single-spaced, trimmed string so
 *  `.mcpw-panel` written identically in two different rules compares equal
 *  regardless of incidental whitespace.
 */
function splitSelectorList(raw) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    if (c === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  parts.push(cur);
  return parts
    .map(s => s.replace(/\s+/g, ' ').trim())
    .filter(s => s.length > 0);
}

/** Recursively walk `cleaned` (a comment/string-masked CSS text, same
 *  length as its source so indices remain valid line numbers), recording
 *  every plain-selector rule found — at any nesting depth under @media /
 *  @supports / @layer / @container / any other at-rule with a nested rule
 *  body — along with the stack of enclosing at-rule preludes active at that
 *  point. `@keyframes` (and vendor-prefixed variants) bodies are treated as
 *  OPAQUE: their `from`/`to`/`NN%` blocks are not CSS rules in the sense
 *  this scanner cares about (no selector, no `animation:` property is valid
 *  there) and are skipped entirely rather than mis-recorded.
 *
 *  Pushes `{ selectors: string[], rawSelector, body, bodyOffset, mediaStack }`
 *  onto `out` for every plain rule. `mediaStack` is a snapshot (not a live
 *  reference) of the enclosing at-rule condition strings, lowercase-
 *  comparable by the caller.
 */
function collectRules(cleaned, baseOffset, mediaStack, out) {
  let i = 0;
  const n = cleaned.length;
  while (i < n) {
    const openIdx = cleaned.indexOf('{', i);
    if (openIdx === -1) break;
    const preludeRaw = cleaned.slice(i, openIdx).trim();
    const closeIdx = findMatchingBrace(cleaned, openIdx);
    if (closeIdx === -1) break; // unbalanced — stop rather than mis-scan garbage
    const body = cleaned.slice(openIdx + 1, closeIdx);
    const bodyOffset = baseOffset + openIdx + 1;

    if (/^@(-\w+-)?keyframes\b/i.test(preludeRaw)) {
      // Opaque: no selectors, no meaningful `animation:` declarations inside.
    } else if (preludeRaw.startsWith('@')) {
      // Any other at-rule (@media, @supports, @layer, @container, ...).
      // Recursing into a childless at-rule (@font-face, @page) is harmless:
      // collectRules just finds no further '{' and returns immediately.
      collectRules(body, bodyOffset, [...mediaStack, preludeRaw], out);
    } else if (preludeRaw.length > 0) {
      out.push({
        selectors: splitSelectorList(preludeRaw),
        rawSelector: preludeRaw,
        body,
        bodyOffset,
        mediaStack: [...mediaStack],
      });
      // Standard CSS (no nesting spec in use here) never nests further rules
      // inside a plain declaration block — do not recurse into `body`.
    }
    i = closeIdx + 1;
  }
}

const REDUCE_MOTION_RE = /prefers-reduced-motion\s*:\s*reduce/i;

function isReduceStack(mediaStack) {
  return mediaStack.some(m => REDUCE_MOTION_RE.test(m));
}

/** Paren-depth-aware split of a declaration BLOCK body on top-level `;`.
 *  `offset` points at the first NON-WHITESPACE character of each
 *  declaration (not the raw accumulator start, which usually begins with
 *  the newline/indentation trailing the PREVIOUS declaration) — otherwise a
 *  declaration's reported line number lands one line too early whenever the
 *  source has one declaration per line, which is every real file here.
 */
function splitDeclarations(body) {
  const decls = [];
  let depth = 0;
  let cur = '';
  let curStart = 0;
  function pushDecl(text, rawStart) {
    const leadingWs = text.match(/^\s*/)[0].length;
    decls.push({ text, offset: rawStart + leadingWs });
  }
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    if (c === ';' && depth === 0) {
      pushDecl(cur, curStart);
      cur = '';
      curStart = i + 1;
    } else {
      cur += c;
    }
  }
  if (cur.trim()) pushDecl(cur, curStart);
  return decls;
}

/** Mask every top-level `var(...)` span (including a nested fallback var())
 *  to spaces, preserving length. A literal living inside a var() fallback
 *  is not "hardcoded" for this guard's purposes — the primary value still
 *  reads a custom property that the reduced-motion block CAN zero.
 */
function maskVarCalls(value) {
  let out = '';
  let i = 0;
  const n = value.length;
  while (i < n) {
    if (value.slice(i, i + 4).toLowerCase() === 'var(') {
      const close = findMatchingBrace(value.replace(/\(/g, '{').replace(/\)/g, '}'), i + 3);
      // findMatchingBrace expects {}; reuse it via a translated copy so we
      // don't duplicate the brace-matching loop for parens.
      const end = close === -1 ? n : close + 1;
      for (let k = i; k < end; k++) out += ' ';
      i = end;
    } else {
      out += value[i];
      i++;
    }
  }
  return out;
}

const TIME_LITERAL_RE = /\b\d+(?:\.\d+)?m?s\b/i;

/** True if `value` (the RHS of an `animation:`/`animation-duration:`
 *  declaration) contains a bare CSS time literal NOT wrapped in var(...).
 */
function hasHardcodedDuration(value) {
  return TIME_LITERAL_RE.test(maskVarCalls(value));
}

function walkCssFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkCssFiles(abs));
    else if (entry.isFile() && entry.name.endsWith('.css')) out.push(abs);
  }
  return out;
}

/** True if `declarations` (from splitDeclarations) contains an `animation`
 *  or `animation-duration` property — i.e. this rule ACTUALLY sets one of
 *  the two properties this guard cares about, regardless of what value it
 *  sets it to (`none`, a substitute animation, whatever). This is the
 *  coverage test itself: see the CORRECTED RULE section of the file
 *  docblock for why mere selector re-appearance is not enough (a reduce
 *  block that only tweaks an unrelated property, e.g. `color`, must NOT
 *  count as neutralizing the animation).
 */
function declarationsSetAnimationProperty(declarations) {
  return declarations.some(d => {
    const colonIdx = d.text.indexOf(':');
    if (colonIdx === -1) return false;
    const prop = d.text.slice(0, colonIdx).trim().toLowerCase();
    return prop === 'animation' || prop === 'animation-duration';
  });
}

/** Full per-file analysis: returns { reduceSelectors: Set<string>,
 *  animationDecls: [{selectors, rawSelector, propName, valueText, offset,
 *  hardcoded}] } — the caller decides pass/fail per declaration against the
 *  file's own reduceSelectors set.
 *
 *  reduceSelectors contains a selector only when a rule under a
 *  `prefers-reduced-motion: reduce` stack, FOR THAT EXACT SELECTOR, itself
 *  sets `animation` or `animation-duration` — not merely when the selector
 *  text happens to reappear inside a reduce block for an unrelated reason.
 */
function analyzeFile(raw) {
  const cleaned = cleanCss(raw);
  const rules = [];
  collectRules(cleaned, 0, [], rules);

  // Compute each rule's declarations ONCE; reused for both the coverage
  // test below and the animation-decl collection that follows, so the two
  // can never see a different view of the same rule body.
  for (const rule of rules) {
    rule.declarations = splitDeclarations(rule.body);
  }

  const reduceSelectors = new Set();
  for (const rule of rules) {
    if (!isReduceStack(rule.mediaStack)) continue;
    if (!declarationsSetAnimationProperty(rule.declarations)) continue;
    for (const sel of rule.selectors) reduceSelectors.add(sel);
  }

  const animationDecls = [];
  for (const rule of rules) {
    for (const decl of rule.declarations) {
      const colonIdx = decl.text.indexOf(':');
      if (colonIdx === -1) continue;
      const propName = decl.text.slice(0, colonIdx).trim().toLowerCase();
      if (propName !== 'animation' && propName !== 'animation-duration') continue;
      const valueText = decl.text.slice(colonIdx + 1).trim();
      const hardcoded = hasHardcodedDuration(valueText);
      animationDecls.push({
        selectors: rule.selectors,
        rawSelector: rule.rawSelector,
        propName,
        valueText,
        offset: rule.bodyOffset + decl.offset,
        hardcoded,
      });
    }
  }

  return { reduceSelectors, animationDecls };
}

// ─────────────────────────────────────────────────────────────────────────
// 0. Parser self-tests — synthetic CSS with known right/wrong answers.
//    Without these, a regex typo could make this suite silently find zero
//    declarations everywhere and report an all-green no-op.
// ─────────────────────────────────────────────────────────────────────────
section('0. Parser self-tests (synthetic CSS)');

{
  const src = `.a { animation: fooFade 0.16s ease; }\n`;
  const { animationDecls } = analyzeFile(src);
  ok(animationDecls.length === 1, 'finds exactly one animation: declaration');
  ok(animationDecls[0].hardcoded === true, 'a bare "0.16s" literal is detected as hardcoded');
  ok(animationDecls[0].selectors[0] === '.a', 'the declaring selector is captured correctly');
}

{
  const src = `.a { animation: fooFade var(--dur-mid) var(--ease-out); }\n`;
  const { animationDecls } = analyzeFile(src);
  ok(animationDecls.length === 1 && animationDecls[0].hardcoded === false,
    'animation: fooFade var(--dur-mid) var(--ease-out); is NOT flagged as hardcoded');
}

{
  const src = `.a { animation: fooFade var(--dur-mid, 180ms) ease; }\n`;
  const { animationDecls } = analyzeFile(src);
  ok(animationDecls.length === 1 && animationDecls[0].hardcoded === false,
    'a time literal living inside a var(...) FALLBACK is not treated as hardcoded (the primary read is still the token)');
}

{
  // Covered case: normal rule has a bare literal, reduce block sets the
  // SAME selector to `animation: none;` — matches views/chat.css's real shape.
  const src = `
.spin { animation: spinKf 0.8s linear infinite; }
@media (prefers-reduced-motion: reduce) {
  .spin { animation: none; }
}
`;
  const { reduceSelectors, animationDecls } = analyzeFile(src);
  ok(reduceSelectors.has('.spin'), 'a selector reappearing inside a reduce block is recorded as covered');
  const hardcodedDecls = animationDecls.filter(d => d.hardcoded);
  ok(hardcodedDecls.length === 1 && hardcodedDecls[0].selectors.every(s => reduceSelectors.has(s)),
    'the hardcoded-duration declaration\'s selector is covered by the reduce escape (disable shape)');
}

{
  // Covered case: reduce block SUBSTITUTES a different hardcoded animation
  // for the same selector, rather than disabling — matches
  // shared/progress-ring.css's real .pring-orbit shape. The substitute
  // declaration's OWN literal must also be accepted (it is "covered by
  // itself": its selector appears inside a reduce block, namely this one).
  const src = `
.orbit { animation: spinKf 1.15s linear infinite; }
@media (prefers-reduced-motion: reduce) {
  .orbit { animation: breatheKf 2.6s ease-in-out infinite; }
}
`;
  const { reduceSelectors, animationDecls } = analyzeFile(src);
  ok(reduceSelectors.has('.orbit'), '.orbit is recorded as covered (appears inside a reduce block)');
  const hardcodedDecls = animationDecls.filter(d => d.hardcoded);
  ok(hardcodedDecls.length === 2, 'both the normal-rule literal AND the substitute reduce-rule literal are detected as hardcoded');
  ok(hardcodedDecls.every(d => d.selectors.every(s => reduceSelectors.has(s))),
    'both hardcoded declarations are covered — including the one that lives INSIDE the reduce block itself (substitute shape)');
}

{
  // Uncovered case: a bare literal with no reduce escape anywhere.
  const src = `.lonely { animation: fadeKf 0.16s ease; }\n`;
  const { reduceSelectors, animationDecls } = analyzeFile(src);
  ok(!reduceSelectors.has('.lonely'), 'a selector with no reduce-block appearance is correctly NOT recorded as covered');
  const bad = animationDecls.find(d => d.hardcoded);
  ok(!!bad && !bad.selectors.every(s => reduceSelectors.has(s)),
    'the hardcoded declaration is correctly identified as UNCOVERED');
}

{
  // FALSE-EXEMPTION REGRESSION GUARD — the exact adversarial probe an audit
  // built against v1 of this guard: a reduce block that repeats the
  // selector but touches an UNRELATED property (`color`), never the
  // animation itself. v1 recorded `.probe-false-exemption` as covered from
  // selector re-appearance alone and reported the whole suite green over an
  // undisguised, unmitigated hardcoded 3.5s animation. This must now FAIL —
  // both the coverage set and the end-to-end violation check.
  const src = `
.probe-false-exemption { animation: probeKf 3.5s ease; }
@media (prefers-reduced-motion: reduce) {
  .probe-false-exemption { color: red; }
}
`;
  const { reduceSelectors, animationDecls } = analyzeFile(src);
  ok(!reduceSelectors.has('.probe-false-exemption'),
    'FALSE-EXEMPTION GUARD: a reduce rule that only sets an unrelated property (color) does NOT confer coverage, even though the selector reappears inside a reduce block');
  const bad = animationDecls.find(d => d.hardcoded && d.selectors.includes('.probe-false-exemption'));
  ok(!!bad && !bad.selectors.every(s => reduceSelectors.has(s)),
    'FALSE-EXEMPTION GUARD: the hardcoded 3.5s declaration is correctly identified as UNCOVERED — the exact case the v1 guard let through');
}

{
  // Sibling shape: a reduce block that neutralizes a DIFFERENT selector in
  // the same file must not accidentally cover this one — proves coverage
  // is per-selector, not "a reduce block exists somewhere in this file".
  const src = `
.target { animation: targetKf 0.5s ease; }
@media (prefers-reduced-motion: reduce) {
  .unrelated { animation: none; }
}
`;
  const { reduceSelectors, animationDecls } = analyzeFile(src);
  ok(reduceSelectors.has('.unrelated') && !reduceSelectors.has('.target'),
    'a reduce override for one selector does not leak coverage to a different selector in the same file');
  const bad = animationDecls.find(d => d.hardcoded && d.selectors.includes('.target'));
  ok(!!bad && !bad.selectors.every(s => reduceSelectors.has(s)),
    '.target remains UNCOVERED despite a reduce block existing in the same file for a sibling selector');
}

{
  // Longhand-only override — DELIBERATELY not accepted as coverage (see the
  // DECISION paragraph in the file docblock). `animation-play-state` alone
  // does not guarantee the DURATION is neutralized, which is what this
  // guard checks; requiring the same two properties (`animation` /
  // `animation-duration`) as section 2 keeps the coverage test and the
  // violation test symmetric.
  const src = `
.paused { animation: pauseKf 1.2s ease; }
@media (prefers-reduced-motion: reduce) {
  .paused { animation-play-state: paused; }
}
`;
  const { reduceSelectors, animationDecls } = analyzeFile(src);
  ok(!reduceSelectors.has('.paused'),
    'a longhand-only override (animation-play-state) does NOT confer coverage — only animation/animation-duration count, by deliberate decision');
  const bad = animationDecls.find(d => d.hardcoded && d.selectors.includes('.paused'));
  ok(!!bad && !bad.selectors.every(s => reduceSelectors.has(s)),
    '.paused is reported UNCOVERED — a false positive in the safe direction, per the documented decision');
}

{
  // @keyframes bodies are opaque — their `to { transform: ... }` blocks must
  // never be mistaken for a real selector rule with an animation property.
  const src = `@keyframes fadeKf { from { opacity: 0; } to { opacity: 1; } }\n.a { animation: fadeKf 0.16s ease; }\n`;
  const { animationDecls } = analyzeFile(src);
  ok(animationDecls.length === 1 && animationDecls[0].selectors[0] === '.a',
    '@keyframes body is not scanned as a rule — only the real .a rule is recorded');
}

{
  // Comments and strings must not leak fake declarations or fake coverage.
  const src = `
/* .fake { animation: x 999s; } */
.a::before { content: "animation: x 999s;"; }
.a { animation: realKf 0.16s ease; }
`;
  const { animationDecls } = analyzeFile(src);
  ok(animationDecls.length === 1 && animationDecls[0].hardcoded === true,
    'a decoy declaration inside a comment or a string literal is never counted — only the real one is');
}

{
  // animation-delay / animation-name / other longhands are OUT OF SCOPE —
  // only `animation` and `animation-duration` are checked, per the brief.
  const src = `.a { animation-delay: 0.5s; animation-name: fooKf; animation-duration: 0.3s; }\n`;
  const { animationDecls } = analyzeFile(src);
  ok(animationDecls.length === 1 && animationDecls[0].propName === 'animation-duration',
    'animation-delay / animation-name are ignored; only animation-duration is checked');
  ok(animationDecls[0].hardcoded === true, 'a bare animation-duration: 0.3s; is flagged as hardcoded');
}

{
  // Selector lists split on top-level commas, not on a comma inside :not(...).
  const parts = splitSelectorList('.a, .b:not(.c, .d), .e');
  ok(parts.length === 3 && parts[1] === '.b:not(.c, .d)',
    'splitSelectorList: a comma inside a functional pseudo-class does not split the selector');
}

{
  // Nested at-rules (@media inside @media, e.g. a dark-theme override
  // combined with a width query) must still be walked recursively.
  const src = `
@media (min-width: 600px) {
  @media (prefers-reduced-motion: reduce) {
    .deep { animation: none; }
  }
}
.deep { animation: deepKf 0.2s ease; }
`;
  const { reduceSelectors } = analyzeFile(src);
  ok(reduceSelectors.has('.deep'), 'a reduce condition nested two levels inside another at-rule is still detected');
}

{
  // Line-number accuracy end to end (used for failure reporting).
  const src = `.a {\n  color: red;\n}\n.b {\n  animation: x 0.4s ease;\n}\n`;
  const lineStarts = computeLineStarts(src);
  const { animationDecls } = analyzeFile(src);
  const line = lineNumberFor(lineStarts, animationDecls[0].offset);
  ok(line === 5, `line number correctly resolves to the real declaration line (got ${line}, expected 5)`);
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Discover every .css file under src/public/next/** — walked, never a
//    hardcoded list.
// ─────────────────────────────────────────────────────────────────────────
section('1. Discover every /next CSS file (recursive walk, not a hardcoded list)');

const cssFiles = walkCssFiles(NEXT_DIR)
  .map(abs => ({ abs, rel: path.relative(ROOT, abs).split(path.sep).join('/') }))
  .sort((a, b) => a.rel.localeCompare(b.rel));

ok(cssFiles.length >= 15, `found ${cssFiles.length} .css file(s) under src/public/next/** (expected at least 15)`);
ok(cssFiles.some(f => f.rel === 'src/public/next/tokens/motion.css'), 'tokens/motion.css is discovered');
ok(cssFiles.some(f => f.rel === 'src/public/next/views/mcp-wizard.css'), 'views/mcp-wizard.css is discovered');
ok(cssFiles.some(f => f.rel === 'src/public/next/views/shared.css'), 'views/shared.css is discovered');
ok(cssFiles.some(f => f.rel === 'src/public/next/views/chat.css'), 'views/chat.css is discovered');
ok(cssFiles.some(f => f.rel === 'src/public/next/shared/progress-ring.css'), 'shared/progress-ring.css is discovered');
console.log(`  → ${cssFiles.length} file(s): ${cssFiles.map(f => f.rel.replace('src/public/next/', '')).join(', ')}`);

// ─────────────────────────────────────────────────────────────────────────
// 2. Every hardcoded-duration animation declaration must be covered by a
//    same-file prefers-reduced-motion: reduce escape for its selector.
// ─────────────────────────────────────────────────────────────────────────
section('2. Every hardcoded animation duration is covered by a same-file reduced-motion escape');

const violations = [];
let totalAnimationDecls = 0;
let totalHardcoded = 0;
let totalCoveredHardcoded = 0;

for (const f of cssFiles) {
  const raw = readFileSync(f.abs, 'utf8');
  const lineStarts = computeLineStarts(raw);
  const { reduceSelectors, animationDecls } = analyzeFile(raw);
  totalAnimationDecls += animationDecls.length;

  for (const decl of animationDecls) {
    if (!decl.hardcoded) continue;
    totalHardcoded++;
    const covered = decl.selectors.length > 0 && decl.selectors.every(s => reduceSelectors.has(s));
    if (covered) {
      totalCoveredHardcoded++;
    } else {
      const line = lineNumberFor(lineStarts, decl.offset);
      violations.push({
        file: f.rel,
        line,
        selector: decl.rawSelector,
        declaration: `${decl.propName}: ${decl.valueText};`,
      });
    }
  }
}

ok(totalAnimationDecls > 0, `found ${totalAnimationDecls} animation:/animation-duration: declaration(s) across ${cssFiles.length} /next CSS file(s)`);
console.log(`  → ${totalHardcoded} carry a hardcoded time literal; ${totalCoveredHardcoded} are covered by a same-file reduce escape`);

ok(violations.length === 0,
  violations.length === 0
    ? 'no UNCOVERED hardcoded animation duration found under src/public/next/**'
    : `found ${violations.length} UNCOVERED hardcoded animation duration(s):\n` +
      violations.map(v => `        ${v.file}:${v.line}  ${v.selector} { ${v.declaration} }`).join('\n')
);

// ─────────────────────────────────────────────────────────────────────────
// 3. Named regression guards for the two fixed rules — pins the FIX, not
//    just the general rule, so a revert of either is unmistakable in the
//    failure message rather than landing in the generic bucket above.
// ─────────────────────────────────────────────────────────────────────────
section('3. Regression guards — .mcpw-panel and .sbw-panel specifically');

{
  const raw = readFileSync(path.join(ROOT, 'src/public/next/views/mcp-wizard.css'), 'utf8');
  const { reduceSelectors, animationDecls } = analyzeFile(raw);
  const decl = animationDecls.find(d => d.selectors.includes('.mcpw-panel') && d.propName === 'animation');
  ok(!!decl, 'views/mcp-wizard.css: .mcpw-panel has an animation: declaration');
  ok(!!decl && !decl.hardcoded,
    !!decl && !decl.hardcoded
      ? '.mcpw-panel animation duration is token-driven (var(--dur-mid)), not a hardcoded literal'
      : `REGRESSION: .mcpw-panel animation duration reverted to a hardcoded literal: ${decl && decl.valueText}`);
  ok(reduceSelectors.has('.mcpw-panel'),
    '.mcpw-panel has an explicit @media (prefers-reduced-motion: reduce) escape in the same file');
}

{
  const raw = readFileSync(path.join(ROOT, 'src/public/next/views/shared.css'), 'utf8');
  const { reduceSelectors, animationDecls } = analyzeFile(raw);
  const decl = animationDecls.find(d => d.selectors.includes('.sbw-panel') && d.propName === 'animation');
  ok(!!decl, 'views/shared.css: .sbw-panel has an animation: declaration');
  ok(!!decl && !decl.hardcoded,
    !!decl && !decl.hardcoded
      ? '.sbw-panel animation duration is token-driven (var(--dur-mid)), not a hardcoded literal'
      : `REGRESSION: .sbw-panel animation duration reverted to a hardcoded literal: ${decl && decl.valueText}`);
  ok(reduceSelectors.has('.sbw-panel'),
    '.sbw-panel has an explicit @media (prefers-reduced-motion: reduce) escape in the same file');
}

// ─────────────────────────────────────────────────────────────────────────
// 4. The two documented, derived (not name-listed) exemptions still hold —
//    proves the rule accepts BOTH valid shapes (disable, and substitute).
// ─────────────────────────────────────────────────────────────────────────
section('4. Documented exemptions still satisfy the general rule (not special-cased)');

{
  const raw = readFileSync(path.join(ROOT, 'src/public/next/shared/progress-ring.css'), 'utf8');
  const { reduceSelectors, animationDecls } = analyzeFile(raw);
  const hardcodedOrbit = animationDecls.filter(d => d.hardcoded && d.selectors.includes('.pring-orbit'));
  ok(hardcodedOrbit.length >= 1, 'progress-ring.css: .pring-orbit still carries at least one hardcoded-duration animation declaration');
  ok(reduceSelectors.has('.pring-orbit'),
    '.pring-orbit is covered — appears inside this file\'s prefers-reduced-motion: reduce block (substitute shape, not disable)');
  ok(hardcodedOrbit.every(d => d.selectors.every(s => reduceSelectors.has(s))),
    'every hardcoded .pring-orbit declaration (including the reduce-block substitute itself) passes the coverage check');
}

{
  const raw = readFileSync(path.join(ROOT, 'src/public/next/views/chat.css'), 'utf8');
  const { reduceSelectors, animationDecls } = analyzeFile(raw);
  const hardcodedSpinner = animationDecls.filter(d => d.hardcoded && d.selectors.includes('.chat-spinner'));
  ok(hardcodedSpinner.length === 1, 'chat.css: .chat-spinner carries exactly one hardcoded-duration animation declaration');
  ok(reduceSelectors.has('.chat-spinner'),
    '.chat-spinner is covered — appears inside this file\'s prefers-reduced-motion: reduce block (disable shape)');
}

// ─────────────────────────────────────────────────────────────────────────
// 5. New synthetic-violation self-test — proves the corpus CAN go red, per
//    this repo's standing rule that a check reporting zero must also be
//    shown catching a real planted defect (test-css-tokens.js §9b is the
//    house precedent for this exact discipline).
// ─────────────────────────────────────────────────────────────────────────
section('5. Self-test — the corpus can actually fail (planted synthetic violation)');

{
  const src = `.planted { animation: plantedKf 0.42s ease; }\n`;
  const { reduceSelectors, animationDecls } = analyzeFile(src);
  const bad = animationDecls.find(d => d.hardcoded);
  const covered = !!bad && bad.selectors.every(s => reduceSelectors.has(s));
  ok(!!bad && !covered,
    'a planted hardcoded-duration rule with NO reduce escape is correctly identified as a violation by the same logic section 2 uses');
}

// ─────────────────────────────────────────────────────────────────────────
// 6. Positive assertion — tokens/motion.css's reduce block still zeroes all
//    five --dur-* properties. Deleting this block would silently defeat
//    every correctly-tokenized rule in the whole /next tree; this must fail
//    loudly, not just leave section 2 vacuously green because nothing is
//    hardcoded anymore.
// ─────────────────────────────────────────────────────────────────────────
section('6. tokens/motion.css still zeroes all five --dur-* properties under reduced motion');

{
  const raw = readFileSync(path.join(ROOT, 'src/public/next/tokens/motion.css'), 'utf8');
  const cleaned = cleanCss(raw);
  const rules = [];
  collectRules(cleaned, 0, [], rules);

  const reduceDeclText = rules
    .filter(r => isReduceStack(r.mediaStack))
    .map(r => r.body)
    .join('\n');

  ok(reduceDeclText.length > 0, 'a prefers-reduced-motion: reduce block exists in tokens/motion.css');

  const REQUIRED_DUR_VARS = ['--dur-instant', '--dur-fast', '--dur-mid', '--dur-slow', '--dur-slower'];
  for (const name of REQUIRED_DUR_VARS) {
    const re = new RegExp(`${name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\s*:\\s*0(ms|s)?\\b`, 'i');
    ok(re.test(reduceDeclText), `${name} is zeroed (to 0/0ms/0s) inside the reduced-motion block`);
  }
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All /next reduced-motion animation-duration assertions green');
