/**
 * test-next-checkbox.js — OFFLINE suite.
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────
 * A design-system conformance audit found raw OS checkboxes surviving in the
 * /next tree. An unstyled `<input type="checkbox">` renders as platform
 * chrome — on macOS a rounded, blue-tinted UA control — which ignores the
 * design system's radius, border, fill and accent, and does not theme: the
 * light and dark builds of the app got the same control. This is the same
 * class of native control v3.18.0 purged every `<select>` for; it survived
 * that pass only because a checkbox is small enough to look intentional.
 *
 * The sharpest instance was `.sbw-consent-check`, the control by which a user
 * agrees to contribute their own knowledge to a Shared Brain. A consent gate
 * rendering as OS chrome inside an otherwise-designed dialog is the worst
 * available place for this defect, and it drove the design.
 *
 * ── THE COUNT WAS WRONG, AND THAT IS THE POINT OF ENUMERATING FROM DISK ──
 * The audit reported SIX sites. There are SEVEN. The one it missed is in
 * views/shared-brain-wizard.js's `renderDomainCheckboxes`, which builds its
 * checkbox with `document.createElement('input')` + `cb.type = 'checkbox'`
 * rather than an HTML string — invisible to a scan that only reads markup,
 * and invisible to a human reading a list someone else wrote down. This
 * suite therefore enumerates BOTH shapes, from disk, every run. A hardcoded
 * list is a blind spot this repo has recorded three times (v3.14.0, v3.23.0,
 * v3.24.0) and it is exactly what mis-counted here.
 *
 * ── THE FIX ──────────────────────────────────────────────────────────────
 * src/public/next/shared/checkbox.css: `appearance: none` on the REAL input,
 * which stays in the DOM as the accessible element. Read that file's header
 * for why the design system's own hide-the-input-and-paint-a-span approach
 * is correct for React and wrong here (the focus ring would be painted
 * around a 0x0 rectangle).
 *
 * ── ENFORCED ─────────────────────────────────────────────────────────────
 *  §1  CLASS INVARIANT. Every `<input type="checkbox">` in every .js and
 *      .html under src/public/next/** — files ENUMERATED FROM DISK, never a
 *      hardcoded list — carries the `cur-check` class, in markup strings AND
 *      in createElement form.
 *  §2  The component exists, is LINKED from index.html (an unlinked
 *      stylesheet is the v3.9.1 defect: written, correct, and never loaded),
 *      and declares the states the design system specifies.
 *  §3  ACCESSIBILITY. No `role="checkbox"` reimplementation anywhere; the
 *      component declares NO box-shadow (v3.24.2's rule — a local one fights
 *      tokens/base.css's global :focus-visible ring); every checkbox has a
 *      source of an accessible name.
 *  §4  The `#fff` literal inside the check glyph's data: URI stays honest —
 *      tokens/color.css must still define --text-on-accent as #FFFFFF in
 *      BOTH theme blocks.
 *  §5  No site is left tinting OS chrome with `accent-color` instead of
 *      replacing it.
 *  §6  SELF-TESTS AND POSITIVE CONTROLS, including the comment-strip control
 *      §7 of test-next-button-chrome.js keeps for the same reason: that
 *      suite's first scanner did NOT strip CSS comments, and a prose comment
 *      naming class selectors above a real rule hid THREE of FIVE bugs. A
 *      comment satisfying a scan is this repo's recurring hazard.
 *  §7  ANTI-VACUITY. A parser that silently stops matching reports zero
 *      violations forever and stays green. The scan must still FIND at
 *      least as many checkboxes as it did when this was written.
 *
 * ── NOT ENFORCED, named rather than implied away ─────────────────────────
 *  - CASCADE AND SPECIFICITY ARE NOT RESOLVED. "Some rule mentioning
 *    .cur-check declares appearance: none" is weaker than "that declaration
 *    wins". It is the right check for THIS defect — a UA fallthrough happens
 *    only when the class is absent from the element entirely — and the wrong
 *    tool for an override fight. A future rule that re-declared
 *    `appearance: auto` at higher specificity would reinstate the bug and
 *    this suite would stay green.
 *  - CONTRAST IS NOT MEASURED HERE. It needs a real browser compositing real
 *    backdrops after cascade; two probes in this repo have been silently
 *    wrong computing it from tokens. It lives in
 *    scripts/test-next-checkbox-visual.js (LIVE_LOCAL), with its own probe
 *    controls.
 *  - A createElement checkbox whose class is assigned through a variable
 *    rather than a literal is not resolved. The scan looks for the literal
 *    `cur-check` in a className / classList.add / setAttribute on the same
 *    variable in the same file; an indirection would read as a violation
 *    (fails loudly) rather than pass silently, which is the safe direction.
 *  - LABEL ASSOCIATION IS CHECKED STRUCTURALLY, NOT AT RUNTIME. §3 accepts
 *    an `aria-label`, or a `<label` opening in the same emitted markup
 *    fragment, or an `id` with a matching `for=` in the tree. It cannot tell
 *    whether the label the browser actually computes is the intended one.
 *  - The indeterminate glyph is asserted to be a DIFFERENT image from the
 *    checked glyph, not to look like a dash. Only the browser suite sees
 *    pixels.
 *  - Files outside src/public/next/** are not scanned. The frozen /old tree
 *    keeps its native checkboxes deliberately, the same precedent v3.24.0
 *    set for markdown tables.
 *  - RADIOS ARE OUT OF SCOPE and were deliberately NOT converted. §5's first
 *    draft banned `accent-color` tree-wide and fired on
 *    `views/shared.css`'s `.sb-member-row input`, which is the Shared Brain
 *    revoke picker's RADIO. Five native radios remain in /next
 *    (mcp-wizard.js x2, shared.js x1, shared-brain-wizard.js x2). They are a
 *    different control with a different component in the design system, and
 *    changing the app's most destructive Shared Brain surface to make one
 *    scan uniform is not this change. Recorded as a follow-up, not as work
 *    done.
 *  - THE COMMENT STRIP IS NOT LEXICAL. `stripSourceComments` cannot tell a
 *    `/*` inside a JS string literal from a real comment opener. An
 *    assertion that no such literal exists was written, fired on five
 *    innocent `catch { /* ignore *\/ }` lines, and was removed rather than
 *    weakened — see §6. The hazard it aimed at (an over-eager strip deleting
 *    live sites and passing) is covered by §7's floor instead, which reds
 *    behaviourally if the site count falls.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const NEXT = path.join(ROOT, 'src/public/next');
const COMPONENT_REL = 'shared/checkbox.css';
const COMPONENT = path.join(NEXT, COMPONENT_REL);
const CLASS = 'cur-check';

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function section(t) { console.log(`\n${t}`); }

// ─────────────────────────────────────────────────────────────────────────
// Filesystem + CSS parsing — the same shapes test-next-button-chrome.js uses
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
 * Strip /* … *\/ comments.
 *
 * LOAD-BEARING, NOT HYGIENE. v3.24.2's first button scanner skipped this and
 * a prose comment in views/shared.css naming `.btn/.btn-primary/...` sitting
 * directly above a border-declaring rule made the naive selector/body split
 * read the comment as part of the selector — so three real bugs were reported
 * as covered. §6 keeps a positive control that goes red if this is removed.
 */
function stripCssComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/**
 * Strip comments from a SOURCE file before scanning it for markup.
 *
 * THIS SUITE'S OWN FIRST DRAFT PROVED WHY IT IS NEEDED, and the finding is
 * worth keeping rather than quietly fixing. The `<link>` comment this change
 * added to index.html explains the component by NAMING the thing it replaces,
 * as `<input type="checkbox">`. The unstripped scanner read that prose as a
 * real element, reported index.html as a site with no accessible name, and
 * inflated the site count from 7 to 8. That is v3.24.2's false positive
 * exactly — a comment satisfying (here, tripping) a scan — arriving in the
 * suite written to avoid it, one section below the control that names it.
 *
 * WHAT IS STRIPPED, AND WHAT DELIBERATELY IS NOT:
 *  - `<!-- … -->`   in .html. Unambiguous.
 *  - `/* … *\/`     in .js. A block comment is unambiguous enough; `/*`
 *                   inside a JS string literal does not occur in this tree
 *                   (asserted in §6 by a control that would notice).
 *  - a `//` line comment ONLY when the `//` opens the line (optionally
 *    indented). A general `//`-to-EOL strip would eat `'http://…'` and the
 *    `'</label>'` after it in this tree's markup strings, which is a worse
 *    failure than the one being fixed — it would DELETE real sites and go
 *    green. Narrowing to line-openers costs a trailing `// <input …>`
 *    comment, which does not occur here and would fail LOUDLY if it did.
 */
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

function declares(body, prop) {
  const esc = prop.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  return new RegExp(`(?:^|[;{])\\s*${esc}\\s*:`).test(body);
}

const CSS_FILES = walk(NEXT, ['.css']).sort();
const JS_FILES = walk(NEXT, ['.js']).sort();
const MARKUP_FILES = walk(NEXT, ['.js', '.html']).sort();

const RULES = [];
for (const file of CSS_FILES) {
  const rel = path.relative(NEXT, file);
  for (const r of collectRules(stripCssComments(readFileSync(file, 'utf8')))) {
    RULES.push({ ...r, file: rel });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// The scanners. Exported shapes so §6 can drive them against fixtures.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Every literal `<input ... type="checkbox" ...>` in a source string, with
 * the whole tag text so a caller can look for a class.
 *
 * The attribute may appear in ANY order (`class` before or after `type`) and
 * quoting may be single or double, so the tag is matched whole and then
 * interrogated rather than pattern-matched in one shot.
 */
function markupCheckboxes(src) {
  const out = [];
  // `<input` up to the first `>` that is not inside a quoted attribute value.
  const re = /<input\b[^>]*>/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const tag = m[0];
    if (!/\btype\s*=\s*(?:\\?["'])?checkbox/.test(tag)) continue;
    out.push({ tag, index: m.index });
  }
  return out;
}

/** Does a tag string carry the class token, in any of the class attributes? */
function tagHasClass(tag, cls) {
  const re = new RegExp('\\bclass\\s*=\\s*(?:\\\\?["\'])([^"\']*)', 'g');
  let m;
  while ((m = re.exec(tag)) !== null) {
    if (new RegExp('(?:^|[^\\w-])' + cls + '(?![\\w-])').test(m[1])) return true;
  }
  return false;
}

/**
 * Every `<var>.type = 'checkbox'` site, paired with whether the SAME variable
 * is given the class somewhere in the same file (className =, classList.add,
 * or setAttribute('class', …)).
 */
function createElementCheckboxes(src, cls) {
  const out = [];
  const re = /(\w+)\s*\.\s*type\s*=\s*['"]checkbox['"]/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const v = m[1];
    const esc = v.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    const assigns = new RegExp(
      `${esc}\\s*\\.\\s*className\\s*=\\s*[^;]*${cls}` +
      `|${esc}\\s*\\.\\s*classList\\s*\\.\\s*add\\([^)]*${cls}` +
      `|${esc}\\s*\\.\\s*setAttribute\\(\\s*['"]class['"][^)]*${cls}`
    ).test(src);
    out.push({ variable: v, index: m.index, hasClass: assigns });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// §1 — CLASS INVARIANT, enumerated from disk
// ─────────────────────────────────────────────────────────────────────────

section('§1 — every checkbox in /next adopts the component (enumerated from disk)');

// Comment-stripped source for every markup-bearing file, cached so §1 and §3
// read the SAME text and the byte offsets §3 uses stay meaningful.
const SOURCES = new Map();
for (const file of MARKUP_FILES) {
  SOURCES.set(path.relative(NEXT, file),
    stripSourceComments(readFileSync(file, 'utf8'), path.extname(file)));
}

const markupSites = [];
const createSites = [];
for (const [rel, src] of SOURCES) {
  for (const c of markupCheckboxes(src)) {
    markupSites.push({ file: rel, ...c, hasClass: tagHasClass(c.tag, CLASS) });
  }
  if (rel.endsWith('.js')) {
    for (const c of createElementCheckboxes(src, CLASS)) createSites.push({ file: rel, ...c });
  }
}
const allSites = [...markupSites, ...createSites];

for (const s of markupSites) {
  ok(s.hasClass,
    `${s.file}: <input type="checkbox"> carries class="${CLASS}" ` +
    `— without it the control falls through to OS chrome in BOTH themes ` +
    `(tag: ${s.tag.replace(/\s+/g, ' ').slice(0, 110)})`);
}
for (const s of createSites) {
  ok(s.hasClass,
    `${s.file}: createElement checkbox \`${s.variable}\` is assigned class "${CLASS}" ` +
    `— this is the shape the hand-written audit list MISSED, which is why it is scanned`);
}

// The consent gate, called out by name because it is the reason this exists.
const consentFile = path.join(NEXT, 'views/shared-brain-wizard.js');
const consentSrc = SOURCES.get('views/shared-brain-wizard.js') || '';
void consentFile;
const consentTag = markupCheckboxes(consentSrc).find(c => /id\s*=\s*(?:\\?["'])sbw-consent/.test(c.tag));
ok(!!consentTag && tagHasClass(consentTag.tag, CLASS),
  'THE CONSENT GATE: #sbw-consent — the control by which a user agrees to contribute their own ' +
  'knowledge to a Shared Brain — is the component, not OS chrome');
ok(/sbw-consent-check/.test(consentSrc),
  'the consent gate keeps its own .sbw-consent-check hook, so the view can still weight it ' +
  'differently from an ordinary opt-in');

// ─────────────────────────────────────────────────────────────────────────
// §2 — the component itself
// ─────────────────────────────────────────────────────────────────────────

section('§2 — the component exists, is reachable, and declares the specified states');

ok(existsSync(COMPONENT), `${COMPONENT_REL} exists`);
const componentCss = existsSync(COMPONENT) ? readFileSync(COMPONENT, 'utf8') : '';
const componentRules = collectRules(stripCssComments(componentCss));

const indexHtml = readFileSync(path.join(NEXT, 'index.html'), 'utf8');
ok(new RegExp(`<link[^>]+href=["']/next/${COMPONENT_REL}["']`).test(indexHtml),
  `index.html <link>s ${COMPONENT_REL} — an unlinked stylesheet is the v3.9.1 defect: the ` +
  'progress ring shipped written, correct and NEVER LOADED for a whole release, and ' +
  'test-css-tokens.js discovers /next stylesheets only from these <link> tags');

// The link must sit ABOVE the view stylesheets: .cur-check and
// .chat-conv-check are both single-class selectors, so which one wins is
// decided purely by source order.
const linkIdx = indexHtml.indexOf(`/next/${COMPONENT_REL}`);
const firstViewIdx = indexHtml.indexOf('/next/views/');
ok(linkIdx > -1 && firstViewIdx > -1 && linkIdx < firstViewIdx,
  `${COMPONENT_REL} is linked BEFORE the first views/ stylesheet, so a view can still add ` +
  'placement at equal specificity and win (the layering shared/listbox.css and shared/text.css ' +
  'already document)');

function baseRule() {
  return componentRules.find(r => r.selector.split(',').some(s => s.trim() === '.' + CLASS));
}
const base = baseRule();
ok(!!base, `.${CLASS} has a base rule`);
if (base) {
  ok(declares(base.body, 'appearance') && /appearance\s*:\s*none/.test(base.body),
    '.cur-check sets `appearance: none` — this is the single declaration that removes the OS ' +
    'chrome, and everything else in the file is what replaces it');
  ok(declares(base.body, 'width') && declares(base.body, 'height'),
    '.cur-check sizes the box itself (the input IS the visual box — no hidden 0x0 input and no ' +
    'painted <span> substitute)');
  // NOT --border-strong, and that is a DELIBERATE, MEASURED deviation from
  // the design system — see the component's own header. Measured in Chrome
  // by test-next-checkbox-visual.js, --border-strong on an unchecked box
  // reads 1.59:1 in dark and 1.64:1 in light against the surface behind it,
  // under WCAG 1.4.11's 3:1 floor for a control's visual boundary, and the
  // unchecked box has no other visible presence (its --surface-inset fill
  // measures 1.01 / 1.07). --text-3 clears it at 4.27 / 4.14.
  //
  // This assertion pins the DEVIATION, not the token: reverting to the
  // system's value reds here AND reds two contrast assertions in the visual
  // suite, so the pair cannot drift apart silently.
  ok(declares(base.body, 'border') && /--text-3/.test(base.body),
    '.cur-check draws its unchecked hairline with --text-3 — the measured deviation from the ' +
    'system\'s --border-strong, which sits under the 3:1 non-text floor in BOTH themes on the one ' +
    'boundary that has to carry the whole control');
  ok(!/--border-strong/.test(base.body),
    'and --border-strong is not still there alongside it — a leftover declaration would make which ' +
    'one wins a source-order accident');
  ok(declares(base.body, 'border-radius') && /--radius-xs/.test(base.body),
    '.cur-check uses --radius-xs, the radius the system\'s Checkbox.jsx specifies');
  ok(/--surface-inset/.test(base.body),
    '.cur-check fills unchecked with --surface-inset, per the system');
  ok(!/\b(?<!--cur-check-size:\s*calc\()\d+px\b/.test(base.body.replace(/calc\([^)]*\)/g, '')) ||
     /var\(--font-scale\)/.test(componentCss),
    'the box size scales with --font-scale rather than freezing at 1x while Settings > General ' +
    'grows the label beside it (shared/text.css\'s rule)');
}

function ruleForState(state) {
  return componentRules.filter(r => new RegExp('\\.' + CLASS + ':' + state + '(?![\\w-])').test(r.selector));
}
const checkedRules = ruleForState('checked');
const indetRules = ruleForState('indeterminate');
const disabledRules = ruleForState('disabled');
const hoverRules = ruleForState('hover');

ok(checkedRules.some(r => /--accent/.test(r.body) && declares(r.body, 'background-color')),
  ':checked fills with --accent, per the system');
ok(checkedRules.some(r => declares(r.body, 'background-image')),
  ':checked paints the check glyph');
ok(indetRules.some(r => declares(r.body, 'background-image')),
  ':indeterminate paints its own glyph — chat.js sets .indeterminate on #chat-bulk-all when ' +
  'SOME conversations are selected, and "some" must not read as "none" beside a Delete button');
/* CHASED, NOT FILED AS COVERAGE. The first draft of these two was
   `disabledRules.some(...)`, and changing `.cur-check:disabled`'s opacity from
   0.45 to 0.6 left the suite GREEN at 65/0. The reason is worth keeping: two
   rules in this file mention `.cur-check:disabled` — the state rule itself and
   `.cur-check-label:has(.cur-check:disabled)`, which dims the LABEL — and both
   carry 0.45, so `.some()` was satisfied by the rule it did not mean. A guard
   that passes because a DIFFERENT rule happens to say the right thing is not a
   guard.

   Fixed in both directions: the exact-selector rule must carry the value, AND
   EVERY rule that dims a disabled checkbox must use the same one, so the two
   cannot drift apart into the "disabled implemented five ways" finding this
   whole pass came out of. */
const disabledExact = componentRules.find(r =>
  r.selector.split(',').some(s => s.trim() === '.' + CLASS + ':disabled'));
ok(!!disabledExact && /opacity\s*:\s*0\.45/.test(disabledExact.body),
  'the `.cur-check:disabled` rule ITSELF sets opacity 0.45 — the system\'s value, not one of the ' +
  'five other opacities the audit found in this tree');
ok(!!disabledExact && /cursor\s*:\s*not-allowed/.test(disabledExact.body),
  'and that same rule sets cursor: not-allowed, per the system');
const disabledOpacities = disabledRules
  .map(r => (r.body.match(/opacity\s*:\s*([\d.]+)/) || [])[1])
  .filter(Boolean);
ok(disabledOpacities.length > 0 && disabledOpacities.every(v => v === '0.45'),
  `every rule that dims a disabled checkbox uses the SAME 0.45 (found: ${disabledOpacities.join(', ') || 'none'}) ` +
  '— the component must not itself become an instance of the "disabled implemented five ways" finding');
ok(hoverRules.length > 0,
  'a hover state exists (DERIVED — the system specifies none on the box itself)');

// The three glyph states must be genuinely different images.
const images = componentRules
  .map(r => (r.body.match(/background-image\s*:\s*url\(([^)]*)\)/) || [])[1])
  .filter(Boolean);
ok(new Set(images).size === images.length && images.length >= 2,
  `the checked and indeterminate glyphs are DIFFERENT images (${images.length} found, ` +
  `${new Set(images).size} distinct) — an identical pair would make "some selected" ` +
  'indistinguishable from "all selected"');

// ─────────────────────────────────────────────────────────────────────────
// §3 — accessibility
// ─────────────────────────────────────────────────────────────────────────

section('§3 — the accessible element stays native, and the focus ring is not fought');

ok(!componentRules.some(r => declares(r.body, 'box-shadow')),
  `${COMPONENT_REL} declares NO box-shadow anywhere — v3.24.2's explicit rule: tokens/base.css's ` +
  'global :focus-visible ring IS a box-shadow, and a local one fights it');

const focusRules = componentRules.filter(r => /:focus-visible/.test(r.selector));
ok(focusRules.length > 0 && focusRules.every(r => !declares(r.body, 'box-shadow')),
  'the :focus-visible rule re-declares only border-radius (so the global ring does not round the ' +
  'box to --radius-sm on focus) and never a shadow of its own');

const roleCheckbox = [];
for (const [rel, src] of SOURCES) {
  if (/role\s*=\s*(?:\\?["'])checkbox/.test(src)) roleCheckbox.push(rel);
}
ok(roleCheckbox.length === 0,
  'no site reimplements a checkbox as role="checkbox" on a <div> — the native input stays the ' +
  'accessible element, so Space, Tab, :checked, :disabled and label association are the ' +
  `browser's and not ours to get wrong (found: ${roleCheckbox.join(', ') || 'none'})`);

// Every checkbox has SOME source of an accessible name.
for (const s of markupSites) {
  const src = SOURCES.get(s.file);
  const before = src.slice(Math.max(0, s.index - 400), s.index);
  const idMatch = s.tag.match(/\bid\s*=\s*(?:\\?["'])([\w-]+)/);
  const hasFor = idMatch && [...SOURCES.values()].some(t =>
    new RegExp(`for\\s*=\\s*(?:\\\\?["'])${idMatch[1]}(?![\\w-])`).test(t));
  const named = /aria-label\s*=/.test(s.tag) || /<label\b/.test(before) || hasFor;
  ok(named,
    `${s.file}: the checkbox has an accessible name source (aria-label, a wrapping <label>, or a ` +
    `matching for=) — id=${idMatch ? idMatch[1] : '(none)'}`);
}

// ─────────────────────────────────────────────────────────────────────────
// §4 — the hardcoded #fff in the glyph stays honest
// ─────────────────────────────────────────────────────────────────────────

section('§4 — the check glyph\'s literal white is pinned to the token it stands for');

const colorCss = readFileSync(path.join(NEXT, 'tokens/color.css'), 'utf8');
const onAccent = [...colorCss.matchAll(/--text-on-accent\s*:\s*([^;]+);/g)].map(m => m[1].trim());
ok(onAccent.length >= 2,
  `tokens/color.css defines --text-on-accent in both theme blocks (found ${onAccent.length})`);
ok(onAccent.length >= 2 && onAccent.every(v => /^#ffffff$/i.test(v)),
  '--text-on-accent is #FFFFFF in BOTH themes, so the literal `%23fff` inside the glyph\'s ' +
  'data: URI is not a drifting hardcode. A data: URI cannot resolve a CSS custom property, so ' +
  `this assertion is what keeps it truthful (found: ${onAccent.join(' | ')})`);
ok(/%23fff/i.test(componentCss),
  'the glyph really does use that literal — otherwise the assertion above guards nothing');

// ─────────────────────────────────────────────────────────────────────────
// §5 — no site is left tinting OS chrome instead of replacing it
// ─────────────────────────────────────────────────────────────────────────

section('§5 — accent-color is not used as a substitute for the component');

/* THIS ASSERTION WAS NARROWED AFTER IT FIRED, and the finding it fired on is
   recorded rather than converted.

   The first draft banned `accent-color` from the whole /next tree. It went
   red on `views/shared.css`'s `.sb-member-row input { accent-color:
   var(--danger) }` — which is a RADIO, not a checkbox: the Shared Brain
   revoke picker, where exactly one member is chosen and the danger tint is
   carrying "this row is the one you are about to revoke".

   A radio is a different control with a different component in the design
   system's forms directory, and converting it here — to make one scan
   uniform — would be changing a control nobody reported, outside the scope
   of this change, on the app's most destructive Shared Brain surface. The
   tree still holds five native radios (mcp-wizard.js x2, shared.js x1,
   shared-brain-wizard.js x2); they are a follow-up, not a defect this change
   left half-done.

   So the ban is scoped to CHECKBOXES, and the class tokens it applies to are
   ENUMERATED FROM THE SITES FOUND ON DISK rather than hardcoded — a new
   checkbox class is covered the moment it appears in markup. */
const checkboxClassTokens = new Set([CLASS]);
for (const s of markupSites) {
  const m = s.tag.match(/\bclass\s*=\s*(?:\\?["'])([^"']*)/g) || [];
  for (const attr of m) {
    for (const t of attr.replace(/^[^"']*["']/, '').split(/[^\w-]+/)) {
      if (t) checkboxClassTokens.add(t);
    }
  }
}
const checkboxAccentRules = RULES.filter(r =>
  declares(r.body, 'accent-color') &&
  (/input\s*\[\s*type\s*=\s*["']?checkbox/.test(r.selector) ||
   [...checkboxClassTokens].some(t => new RegExp('\\.' + t + '(?![\\w-])').test(r.selector))));
ok(checkboxAccentRules.length === 0,
  '`accent-color` is declared on no CHECKBOX rule in /next. It only ever TINTED the OS control ' +
  '— the rounded macOS box, its border and its shape all stayed UA chrome in both themes — so a ' +
  'checkbox styled with it is one that was half-fixed. .chat-conv-check carried exactly this ' +
  `and is the regression this guards (found: ${checkboxAccentRules.map(r => r.file + ' ' + r.selector).join(', ') || 'none'})`);
ok(checkboxClassTokens.size >= 3,
  `the token set is derived from ${checkboxClassTokens.size} classes actually found on checkbox ` +
  `elements (${[...checkboxClassTokens].sort().join(', ')}), not from a list written here — a ` +
  'scan that resolved to just {cur-check} would make the assertion above nearly vacuous');
// Comment-stripped, for the third time in this file: the replacement comment
// left in views/chat.css EXPLAINS that accent-color was removed, by naming it.
// An unstripped read of that file finds the word and reds on the prose.
ok(!/accent-color/.test(stripCssComments(readFileSync(path.join(NEXT, 'views/chat.css'), 'utf8'))),
  'REGRESSION GUARD: views/chat.css no longer tints .chat-conv-check with accent-color — that ' +
  'was the half-fix the audit found, and it is the one rule in the tree that named a checkbox');

// ─────────────────────────────────────────────────────────────────────────
// §6 — self-tests and positive controls
// ─────────────────────────────────────────────────────────────────────────

section('§6 — self-tests: the scanners can actually fail');

ok(markupCheckboxes('<input type="checkbox" class="cur-check" id="x">').length === 1,
  'self-test: DETECTS a markup checkbox');
ok(markupCheckboxes('<input type="text" class="cur-check">').length === 0,
  'self-test: does NOT over-fire on a non-checkbox input');
ok(markupCheckboxes('<input class="cur-check" type="checkbox">').length === 1,
  'self-test: attribute ORDER does not matter — class may precede type');
ok(markupCheckboxes("<input type='checkbox'>").length === 1,
  'self-test: single-quoted attributes are matched');
ok(tagHasClass('<input type="checkbox" class="a cur-check b">', CLASS) === true,
  'self-test: DETECTS the class among siblings');
ok(tagHasClass('<input type="checkbox" class="cur-checkbox">', CLASS) === false,
  'self-test: does NOT match a longer class that merely starts with the token ' +
  '(cur-checkbox is not cur-check)');
ok(tagHasClass('<input type="checkbox" class="chat-conv-check">', CLASS) === false,
  'self-test: DETECTS a bare checkbox — this is the shape of the defect, and if this assertion ' +
  'could not fail the whole of §1 would be vacuous');
ok(createElementCheckboxes("const cb = document.createElement('input');\ncb.type = 'checkbox';\ncb.className = 'cur-check';", CLASS)[0]?.hasClass === true,
  'self-test: DETECTS the class on a createElement checkbox');
ok(createElementCheckboxes("const cb = document.createElement('input');\ncb.type = 'checkbox';", CLASS)[0]?.hasClass === false,
  'self-test: DETECTS a BARE createElement checkbox — the seventh site, the one the audit list ' +
  'missed entirely');
ok(createElementCheckboxes("a.type = 'checkbox';\nb.className = 'cur-check';", CLASS)[0]?.hasClass === false,
  'self-test: the class must be assigned to the SAME variable — a sibling element carrying it ' +
  'does not count');

// THE COMMENT-STRIP CONTROL. v3.24.2's first scanner did not strip CSS
// comments, and a prose comment naming class selectors above a real rule made
// the naive selector/body split treat the comment as part of that selector,
// hiding three of five bugs. Removing stripCssComments from this file turns
// the first of these two red.
const COMMENT_FIXTURE =
  '/* .cur-check and .cur-check-sm must never declare box-shadow */\n' +
  '.something-else { box-shadow: 0 0 0 3px red; }\n';
const strippedRules = collectRules(stripCssComments(COMMENT_FIXTURE));
const naiveRules = collectRules(COMMENT_FIXTURE);
ok(!strippedRules.some(r => /\.cur-check(?![\w-])/.test(r.selector)),
  'POSITIVE CONTROL: with comments stripped, a prose comment NAMING .cur-check above an ' +
  'unrelated rule does not make that rule count as a .cur-check rule');
ok(naiveRules.some(r => /\.cur-check(?![\w-])/.test(r.selector)),
  'POSITIVE CONTROL (the other half): WITHOUT the strip the same fixture DOES pollute the ' +
  'selector — proving the control is measuring something real and not asserting a tautology');

// THE SOURCE COMMENT-STRIP CONTROL. This suite's own first run reported
// index.html as a checkbox site with no accessible name, because the <link>
// comment added there NAMES the element it replaces as `<input
// type="checkbox">`. Prose read as markup: the same class as the CSS control
// above, arriving inside the suite written to avoid it.
const HTML_COMMENT_FIXTURE = '<!-- replaces <input type="checkbox"> chrome -->\n<div></div>';
ok(markupCheckboxes(stripSourceComments(HTML_COMMENT_FIXTURE, '.html')).length === 0,
  'POSITIVE CONTROL: a `<input type="checkbox">` written inside an HTML COMMENT is not counted ' +
  'as a site — the false positive this suite produced on its own first run');
ok(markupCheckboxes(HTML_COMMENT_FIXTURE).length === 1,
  'POSITIVE CONTROL (the other half): without the strip the same fixture IS miscounted, so the ' +
  'control is measuring something real');
const JS_COMMENT_FIXTURE = "/* was <input type=\"checkbox\"> */\n  // and <input type='checkbox'>\nconst a = 1;";
ok(markupCheckboxes(stripSourceComments(JS_COMMENT_FIXTURE, '.js')).length === 0,
  'POSITIVE CONTROL: both JS comment forms are stripped before the markup scan');
ok(stripSourceComments("const u = 'https://example.com/x';", '.js').includes('https://example.com'),
  'POSITIVE CONTROL: the `//` strip is anchored to LINE OPENERS, so a URL inside a string ' +
  'survives — a general //-to-EOL strip would delete real markup after it and go GREEN, which is ' +
  'a worse failure than the one it fixes');
ok(stripSourceComments("x += '</label>'; // trailing", '.js').includes('</label>'),
  'POSITIVE CONTROL: a trailing comment does not eat the markup string on the same line');
/* An assertion that `/*` never occurs inside a JS string literal was WRITTEN,
   FIRED, AND REMOVED rather than weakened into something that always passes.
   Deciding "is this `/*` inside a string" needs a JS lexer, and the cheap
   regex stand-in over-fired immediately: `catch { /* ignore *\/ }` two tokens
   after an unrelated `'yes'` matched, in five real files, none of which is a
   problem. This repo has recorded twice (v3.1.0's frontend lexer, v3.0.17's
   source-regex) what a clever scan that measures the wrong thing costs.

   The hazard it was reaching for — an over-eager strip DELETING live sites and
   going green — is already covered, and covered better, by §7's floor: a strip
   that ate real markup drops the site count below 7 and reds there for a
   BEHAVIOURAL reason. It is named in NOT ENFORCED rather than half-guarded. */

ok(declares('border: 1px solid red', 'border') === true,
  'self-test: declares() sees a declaration that is FIRST in its block (the boundary bug ' +
  'test-next-button-chrome.js records)');
ok(declares('color: red; bordercolor: blue', 'border') === false,
  'self-test: declares() does not match a longer property name');

// ─────────────────────────────────────────────────────────────────────────
// §7 — anti-vacuity
// ─────────────────────────────────────────────────────────────────────────

section('§7 — anti-vacuity: the scan is still finding things');

// Seven sites at the time of writing: ingest.js x1, shared-brain-wizard.js x3
// (two markup + one createElement), chat.js x2, settings.js x1. The floor is
// the count, not the list — a NEW checkbox must be caught by §1, and a
// DELETED one must not silently disable the suite.
const FLOOR = 7;
ok(allSites.length >= FLOOR,
  `the scan found ${allSites.length} checkbox site(s) across ${new Set(allSites.map(s => s.file)).size} ` +
  `file(s); floor is ${FLOOR}. A parser that silently stopped matching would report 0 violations ` +
  'forever and stay green — this is what makes that impossible');
ok(markupSites.length >= 6 && createSites.length >= 1,
  `BOTH shapes are still being found (${markupSites.length} markup, ${createSites.length} ` +
  'createElement) — the audit reported six and missed the createElement one, so a regression to ' +
  'markup-only scanning must go red');
ok(CSS_FILES.length > 10 && MARKUP_FILES.length > 10,
  `the file walk is still reaching the tree (${CSS_FILES.length} css, ${MARKUP_FILES.length} ` +
  'markup-bearing files) — a walk that resolved to an empty directory would pass every ' +
  'per-site assertion by having none');
ok(RULES.length > 500,
  `the CSS parse is still producing rules (${RULES.length}) — §5's "accent-color appears ` +
  'nowhere" is satisfied trivially by a parse that produced nothing');

// ─────────────────────────────────────────────────────────────────────────

console.log('\n────────────────────────────────────────────────────────────');
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) {
  console.log('❌ checkbox component assertions FAILED');
  process.exit(1);
}
console.log('✅ All checkbox component assertions green');
console.log(`   → ${allSites.length} checkbox sites, all adopting .${CLASS}`);
