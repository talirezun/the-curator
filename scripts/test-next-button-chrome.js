/**
 * test-next-button-chrome.js — OFFLINE suite.
 *
 * Two reported defects, one shared root, plus the class invariant that stops
 * either coming back.
 *
 * ── DEFECT 1: a phantom border across the top of every primary button ─────
 * Reported as "an additional border on top of the button which I don't know
 * how it got there — in the design system we did not design it", on
 * `+ New domain` and `+ New chat`.
 *
 * Measured in Chromium against the real element, not reasoned about. The ONLY
 * declaration that paints it is `.btn-primary { box-shadow: var(--inset-hi) }`
 * in shell.css — no ::before (content: none), no ::after, no background-image
 * (none), no border-top (1px solid transparent), no outline.
 *
 * It is a LIGHT-THEME defect only:
 *   --inset-hi dark  = inset 0 1px 0 rgba(255,255,255,0.05)
 *   --inset-hi light = inset 0 1px 0 rgba(255,255,255,0.90)
 * composited over --accent rgb(124,90,245):
 *   dark  -> rgb(131, 98,246)  contrast vs the fill 1.05:1  (imperceptible)
 *   light -> rgb(242,239,254)  contrast vs the fill 4.00:1  (a white line)
 *
 * The design system is not wrong and the app is not unfaithful: its
 * Button.jsx really does set boxShadow on primary, but its own guide scopes
 * the device to one theme — "ON DARK, an --inset-hi top highlight does what a
 * drop shadow would". The light token value was authored for near-white
 * RAISED SURFACES, where 90% white is invisible; on a saturated accent fill
 * it is a line. So the guard here is two-sided: the highlight must SURVIVE on
 * dark and must be SUPPRESSED under [data-theme="light"]. A future "cleanup"
 * that deletes it outright departs from the design system, and one that
 * restores it in light reinstates the reported bug.
 *
 * ── DEFECT 2: delete affordances rendering as buttons with a "shadow" ─────
 * Reported as "this should be only the delete basket, the icon, nothing else.
 * But now it's a button again with some sort of shadow".
 *
 * The "shadow" was never a shadow and was never ours. `.chat-conv-delete` set
 * background and colour but NEVER DECLARED `border` or `padding`, so the
 * element kept Chromium's UA <button> defaults:
 *     border: 2px outset rgb(255,255,255)   padding: 1px 6px
 * An `outset` border renders as a BEVEL — light top/left, dark bottom/right —
 * which is exactly what reads as a button with a shadow.
 *
 * ── THE CLASS, WHICH IS BIGGER THAN THE TWO REPORTS ──────────────────────
 * Any <button> whose class list receives no `border` declaration from any
 * /next stylesheet inherits that same UA bevel. Enumerating every button in
 * the tree found FIVE such occurrences, not one:
 *
 *   views/chat.js      .chat-conv-delete            (the reported one)
 *   shared/confirm.js  .btn.cfd-confirm + btn-danger added at RUNTIME —
 *                      `.btn-danger` had NO generic definition anywhere, so
 *                      EVERY destructive confirm in the app rendered as a raw
 *                      OS button: ButtonFace rgb(239,239,239), black text,
 *                      2px outset, in both themes
 *   views/memory.js    .btn.btn-xs.mem-stale-btn    ("Reload" on the
 *                      stale-write notice — measured ButtonFace rgb(107,107,
 *                      107) + 2px outset in dark theme)
 *   views/memory.js    .btn.btn-xs.mem-j-more       ("Show more", identical)
 *   views/settings.js  an interpolated list that resolves to btn-secondary /
 *                      btn-primary — a false positive, see NOT ENFORCED
 *
 * YOU CANNOT GREP FOR AN ABSENT DECLARATION — the same class shell.css
 * already records for the frozen form-control font-size. This suite therefore
 * asserts the border is PRESENT for every button the tree emits, rather than
 * trying to enumerate what happens when one is missing.
 *
 * ── ENFORCED ─────────────────────────────────────────────────────────────
 *  - Every <button ... class="..."> occurrence in every .js under
 *    src/public/next/** (files ENUMERATED FROM DISK, never a hardcoded list)
 *    has at least one class that receives a `border` declaration.
 *  - `.btn` itself carries a neutral baseline (background + color + border),
 *    so a variant-less `.btn` can never fall through to UA chrome again.
 *  - `.btn-primary` no longer consumes --inset-hi, and the light-theme
 *    suppression it once needed is gone (§2).
 *  - THE RING (v3.46.0). `.btn`'s 1px transparent border is named
 *    --btn-border-w; the two FILLED gloss variants read that same name for
 *    their border AND for the negative inset that puts their gloss overlay on
 *    the BORDER box; --gloss-specular / --gloss-shade / --gloss-pressed are on
 *    that overlay and NOT on the element, where an inset shadow is clipped to
 *    the padding box and leaves a 1px frame of raw fill. `.btn-secondary` is
 *    excluded, and the exclusion is asserted rather than left to be tidied up.
 *  - THE HOVER SHEEN (§5, v3.46.0). Reachable from exactly two selectors,
 *    declared only by shell.css, absent as an ::after from every non-raised
 *    variant, animated only through --t-hover-in/out (whose --dur-* names a
 *    reduced-motion block zeroes — followed, not grepped), and the dark hover
 *    fill still equals the dark rest fill.
 *  - `.btn-danger` is defined generically in shell.css with all three of
 *    background / color / border.
 *  - `.chat-conv-delete` declares border AND padding, declares NO box-shadow
 *    (one would fight tokens/base.css's global :focus-visible ring), tints
 *    with --danger-tint on hover, and is revealed by a :focus-within selector
 *    so it is reachable without a pointer.
 *  - The row-level remove sibling `.ing-queue-file-remove` still declares a
 *    border, so the two row affordances cannot drift apart.
 *
 * ── NOT ENFORCED, named rather than implied away ─────────────────────────
 *  - Cascade and specificity are NOT resolved. "Some rule mentioning this
 *    class declares a border" is weaker than "the border wins". It is the
 *    right check for THIS defect (a UA fallthrough happens only when NOTHING
 *    author-side declares one) and the wrong tool for an override fight.
 *  - Class lists built by interpolation are analysed by joining a token that
 *    ends in `-` with the next few bare tokens, which resolves the one real
 *    pattern in the tree (`'btn btn-' + (c ? 'secondary' : 'primary')`). That
 *    join is a SUPERSET: it can invent a class name the source never
 *    produces, so an interpolated list is treated PERMISSIVELY. Stated rather
 *    than implied — the alternative (refusing to analyse them) would report a
 *    working button as bare and train people to add exemptions.
 *  - A class attribute assembled from an array (`cls.join(' ')`, which is how
 *    shared/listbox.js builds every listbox trigger) is RESOLVED by reading
 *    that array's seed literals out of the same file — `.lb-btn` still has to
 *    declare a border. Only the seed is resolved; classes pushed on by a
 *    caller are not, which is safe here because the seed is the one carrying
 *    the chrome.
 *  - Buttons created via document.createElement with no class attribute in
 *    the source are invisible to this scan.
 *  - Only `btn-*` tokens added through classList.add are folded in. A runtime
 *    addition of some other chrome-bearing class would not be seen.
 *  - Contrast is not measured here; it needs a browser. Measured live for
 *    this change: the confirm dialog's Delete label reads 7.57:1 dark /
 *    5.41:1 light against the card. Its 1px border measures 1.20 / 1.29,
 *    which is `--border` — the tree-wide sub-3:1 border token recorded since
 *    v3.19.0 — with the information carried by the text.
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
// Filesystem + CSS parsing
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
 * Strip /* … *\/ comments.
 *
 * THIS IS LOAD-BEARING, not hygiene. The scratchpad scanner that first found
 * these defects did NOT strip comments, and views/shared.css carried a prose
 * comment reading ".btn/.btn-primary/ .btn-secondary/..." directly above a
 * rule whose body declares `border`. The naive selector/body split treated
 * the comment as part of that selector, so `.btn` "matched" a border-
 * declaring rule and THREE real bare buttons were reported as covered. A
 * comment satisfying a scan is this repo's recurring hazard; §4 keeps a
 * positive control for exactly it.
 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/** Every `selector { body }` pair, at any nesting depth (@media included). */
function collectRules(css) {
  const out = [];
  let depth = 0;
  let selStart = 0;
  const stack = [];
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '{') {
      stack.push({ sel: css.slice(selStart, i), bodyStart: i + 1 });
      depth++;
      selStart = i + 1;
    } else if (ch === '}') {
      const frame = stack.pop();
      depth--;
      if (frame) {
        const body = css.slice(frame.bodyStart, i);
        // A real declaration block contains no nested block.
        if (!body.includes('{')) out.push({ selector: frame.sel.trim(), body });
      }
      selStart = i + 1;
    }
  }
  void depth;
  return out;
}

const CSS_FILES = walk(NEXT, '.css').sort();
const JS_FILES = walk(NEXT, '.js').sort();
const RULES = [];
for (const file of CSS_FILES) {
  const rel = path.relative(NEXT, file);
  for (const r of collectRules(stripComments(readFileSync(file, 'utf8')))) {
    RULES.push({ ...r, file: rel });
  }
}

/**
 * Does `body` declare `prop`?
 *
 * The boundary is `(?:^|[;{])\s*` and the `\s*` is OUTSIDE the alternation
 * deliberately. An earlier draft wrote `(^|[;{]\s*)`, which puts the
 * whitespace only on the second branch — so a declaration that is FIRST in
 * its block (preceded by a newline and indentation rather than by `;`)
 * matched nothing. collectRules hands back bodies without their `{`, so that
 * is every rule's first declaration, i.e. `.x { border: 1px }` read as having
 * no border. It over-reported rather than under-reported, but it was wrong,
 * and it made two of this file's own controls fail — which is how it was
 * found.
 */
function declares(body, prop) {
  const esc = prop.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  return new RegExp(`(?:^|[;{])\\s*${esc}\\s*:`).test(body);
}
const BORDER_DECL = /(?:^|[;{])\s*border(-(top|right|bottom|left))?(-(width|style|color))?\s*:/;
function classSelectorRe(cls) {
  return new RegExp('\\.' + cls.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') + '(?![\\w-])');
}

const borderCache = new Map();
/** Does ANY /next rule whose selector mentions `.cls` declare a border? */
function classGetsBorder(cls) {
  if (borderCache.has(cls)) return borderCache.get(cls);
  const re = classSelectorRe(cls);
  const found = RULES.some(r => re.test(r.selector) && BORDER_DECL.test(r.body));
  borderCache.set(cls, found);
  return found;
}

/** Rules whose selector mentions `.cls`, optionally narrowed by a file. */
function rulesFor(cls, file) {
  const re = classSelectorRe(cls);
  return RULES.filter(r => re.test(r.selector) && (!file || r.file === file));
}

// ─────────────────────────────────────────────────────────────────────────
// §1 — CLASS INVARIANT: no <button> may fall through to the UA bevel
// ─────────────────────────────────────────────────────────────────────────

const BUTTON_CLASS_RE = /<button\b[^>]*?class=(?:"([^"]*)"|'([^']*)')/g;
const CLASS_LIST_ADD_RE = /classList\.add\(([^)]*)\)/g;
const TOKEN_RE = /^[a-zA-Z][\w-]*$/;

/**
 * Tokens from a raw class attribute, including the ones an interpolation
 * splits apart: a token ending in `-` is re-joined with each bare token that
 * follows it, which resolves `'btn btn-' + (c ? 'secondary' : 'primary')`
 * into btn-secondary AND btn-primary.
 */
function tokensFrom(raw) {
  // Split on everything that cannot be part of a class name, so a ternary
  // like `(hasKeyField ? 'secondary' : 'primary')` yields its two literals
  // rather than `(hasKeyField` and `primary)`.
  const pieces = raw.split(/[^\w-]+/).map(s => s.trim()).filter(Boolean);
  const tokens = new Set();
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    if (TOKEN_RE.test(piece)) tokens.add(piece);
    // A trailing hyphen means an interpolation cut a class name in half.
    // Re-join it with the next few tokens. This is a SUPERSET — it can
    // invent a name the source never produces — so an interpolated list is
    // treated permissively rather than strictly. Bounded to 4 so a long
    // expression cannot generate a combinatorial pile of fake classes.
    if (/^[a-zA-Z][\w-]*-$/.test(piece)) {
      for (let j = i + 1; j < pieces.length && j <= i + 4; j++) {
        if (!TOKEN_RE.test(pieces[j])) continue;
        tokens.add(piece + pieces[j]);
      }
    }
  }
  return tokens;
}

function runtimeVariantTokens(src) {
  const tokens = new Set();
  let m;
  CLASS_LIST_ADD_RE.lastIndex = 0;
  while ((m = CLASS_LIST_ADD_RE.exec(src))) {
    for (const lit of m[1].matchAll(/['"]([a-zA-Z][\w-]*)['"]/g)) {
      if (lit[1].startsWith('btn-')) tokens.add(lit[1]);
    }
  }
  return tokens;
}

/**
 * A class attribute assembled from an array — `class="' + esc(cls.join(' '))
 * + '"` — carries no literal token at all, so tokensFrom yields nothing.
 * shared/listbox.js builds every listbox trigger that way, seeding
 * `const cls = ['lb-btn']` and pushing caller-supplied extras onto it.
 *
 * This RESOLVES that shape rather than exempting it: find the array's
 * declaration in the same file and take its seed literals, so `.lb-btn` still
 * has to declare a border like everything else. An exemption would have
 * excused a real button; this does not.
 */
function tokensFromJoinedArray(raw, src) {
  const m = raw.match(/([A-Za-z_$][\w$]*)\s*\.join\s*\(/);
  if (!m) return new Set();
  const decl = src.match(
    new RegExp(`(?:const|let|var)\\s+${m[1]}\\s*=\\s*\\[([^\\]]*)\\]`));
  if (!decl) return new Set();
  const tokens = new Set();
  for (const lit of decl[1].matchAll(/['"]([a-zA-Z][\w-]*)['"]/g)) tokens.add(lit[1]);
  return tokens;
}

/** Every analysable button occurrence in the tree. */
function collectButtonOccurrences() {
  const out = [];
  for (const file of JS_FILES) {
    const rel = path.relative(NEXT, file);
    const src = readFileSync(file, 'utf8');
    const runtime = runtimeVariantTokens(src);
    BUTTON_CLASS_RE.lastIndex = 0;
    let m;
    while ((m = BUTTON_CLASS_RE.exec(src))) {
      const raw = m[1] ?? m[2] ?? '';
      const tokens = tokensFrom(raw);
      for (const t of tokensFromJoinedArray(raw, src)) tokens.add(t);
      if (tokens.size === 0) continue;
      out.push({
        file: rel,
        line: src.slice(0, m.index).split('\n').length,
        raw,
        tokens: new Set([...tokens, ...runtime]),
      });
    }
  }
  return out;
}

const OCCURRENCES = collectButtonOccurrences();

function bareOccurrences(list) {
  return list.filter(o => ![...o.tokens].some(classGetsBorder));
}

section('§1 — CLASS INVARIANT: every <button> gets an author border');

ok(CSS_FILES.length >= 10, `stylesheets enumerated from disk (${CSS_FILES.length})`);
ok(JS_FILES.length >= 10, `view scripts enumerated from disk (${JS_FILES.length})`);
ok(RULES.length > 500, `CSS rules parsed (${RULES.length})`);
ok(OCCURRENCES.length > 100,
  `button occurrences with a literal class list (${OCCURRENCES.length}) — the corpus is not empty`);

const bare = bareOccurrences(OCCURRENCES);
for (const b of bare) {
  console.log(`      ${b.file}:${b.line}  class="${b.raw}"`);
}
ok(bare.length === 0,
  `no <button> falls through to Chromium's 2px outset UA bevel (${bare.length} bare)`);

// The two reports, named, so a count staying at zero cannot hide a swap.
const named = [
  ['views/chat.js', 'chat-conv-delete'],
  ['shared/confirm.js', 'cfd-confirm'],
  ['views/memory.js', 'mem-stale-btn'],
  ['views/memory.js', 'mem-j-more'],
];
for (const [file, cls] of named) {
  const hit = OCCURRENCES.find(o => o.file === file && o.tokens.has(cls));
  ok(!!hit && [...hit.tokens].some(classGetsBorder),
    `${file} .${cls} — the previously-bare button now resolves a border`);
}

// ─────────────────────────────────────────────────────────────────────────
// §2 — Defect 1: the phantom line, suppressed in light, KEPT on dark
// ─────────────────────────────────────────────────────────────────────────

/* THESE TWO ASSERTIONS WERE INVERTED BY THE MATERIAL PASS, AND THE REASON
   MATTERS MORE THAN THE DIFF.

   What they used to pin was the ONLY fix available at the time: `--inset-hi`
   kept on dark (where compositing white-at-0.05 over --accent reads 1.05:1,
   i.e. nothing), and `box-shadow: none` in light (where white-at-0.90 over the
   same fill reads 4.00:1 — the reported phantom line). That second half is a
   THEME-SCOPED DELETION: light's primary button was given no top edge at all,
   because the only value available to it was wrong for that surface.

   The material pass supplies a second value. --gloss-specular is 0.22 on dark
   and 0.18 on light, and both composite to the IDENTICAL 1.44:1 against their
   own fill — tuned to equal PERCEIVED lift rather than equal alpha, which is
   the whole argument for two values under one name. So light now gets the same
   lit edge dark gets rather than getting nothing, and the suppression must be
   GONE. Asserting `box-shadow: none` still present would now be asserting the
   defect: a light primary button flat against its own hover state.

   `--inset-hi` itself is still not redefined, and tokens/shape.css is still
   asserted byte-identical below — the original finding stands that the token
   was correct for the raised light surfaces it was authored for and the bug
   was the PAIRING. The pairing is what changed. */
section('§2 — .btn-primary: the gloss trio, and the light-theme suppression retired');

const primaryRules = rulesFor('btn-primary', 'shell.css');
const primaryBase = primaryRules.find(r => /^\.btn-primary$/.test(r.selector));
ok(!!primaryBase, '.btn-primary base rule exists in shell.css');

/* The three devices are asserted SEPARATELY rather than as one string match,
   because they are separable by design — the specular is the lit top edge, the
   shade is the body gradient's dark foot, the contact is the 1px shadow that
   seats the button on its surface — and losing any one of them is a distinct
   visual regression that a whole-declaration regex would report as the same
   failure.

   WHAT MOVED, AND WHY THE ASSERTION MOVED WITH IT (the ring defect, v3.46.0).
   The two INSET devices are no longer on the element. An inset box-shadow is
   clipped to the PADDING box, and `.btn` carries `border: 1px solid
   transparent`, so the specular and the shade both stopped 1px short of the
   visible edge while `background-color` painted that 1px frame raw. Decoded
   from painted pixels at 2x, dark, column through the button's centre:
     BEFORE  top edge rgb(124,90,245) vs interior rgb(160,135,247)  1.577:1
             bot edge rgb(124,90,245) vs interior rgb( 89, 65,177)  1.647:1
     AFTER   top edge rgb(160,135,247) vs the brightest top row     1.002:1
             bot edge rgb( 90, 65,177) vs the darkest  bottom row   1.000:1
   So they live on `.btn-primary::before`, whose `inset: calc(var(
   --btn-border-w) * -1)` puts it on the BORDER box — a pseudo-element has no
   border of its own, so nothing can clip its shadows short again.

   The three devices are therefore asserted across the variant's OWN rules
   (element + ::before) AND placed: the two inset ones must be on the overlay
   that covers the border box, the outer one must be on the element. Asserting
   only "all three appear somewhere" would pass the exact configuration that
   produced the report. */
const glossVariants = ['btn-primary', 'btn-danger-solid'];

/** Every shell.css rule whose selector names `cls`, split by pseudo-element. */
function variantRules(cls) {
  const rs = rulesFor(cls, 'shell.css');
  /* A selector belonging to `cls` and ending in `pseudo` — written as a
     STARTS-WITH plus ENDS-WITH rather than a substring test, because
     `.btn-primary:hover::before` does not contain `.btn-primary::before` and
     an includes() check silently reported the hover and press rules as
     absent (caught by this suite going red rather than by reading). */
  const pseudoRules = (pseudo) => rs.filter(r => r.selector.split(',').some((s) => {
    const t = s.trim();
    return t.startsWith(`.${cls}`) && t.endsWith(pseudo);
  }));
  return {
    base: rs.find(r => r.selector.split(',').some(s => s.trim() === `.${cls}`)),
    before: pseudoRules('::before'),
    after: pseudoRules('::after'),
    all: rs,
  };
}
const declValue = (body, prop) => (new RegExp(`(?:^|[;{])\\s*${prop}\\s*:\\s*([^;}]+)`).exec(body) || [])[1] || null;
const carries = (decl, token) => !!decl && new RegExp(`var\\(\\s*${token}\\s*\\)`).test(decl);

const primaryShadow = primaryBase ? declValue(primaryBase.body, 'box-shadow') : null;
ok(primaryShadow !== null, `.btn-primary declares a box-shadow (${primaryShadow})`);
ok(carries(primaryShadow, '--gloss-contact'),
  ".btn-primary's own box-shadow carries var(--gloss-contact) — the one device drawn OUTSIDE the box");
ok(!carries(primaryShadow, '--gloss-specular') && !carries(primaryShadow, '--gloss-shade'),
  '…and NOT the two inset devices: on the element they are clipped to the padding box, which IS the ring defect');
ok(!!primaryShadow && !/var\(\s*--inset-hi\s*\)/.test(primaryShadow),
  '.btn-primary no longer consumes --inset-hi — the token is untouched, the PAIRING is what was fixed');

/* ── THE GEOMETRY, ASSERTED AS A RELATION RATHER THAN AS A NUMBER ─────────
   `inset: -1px` is only correct while the border is 1px. Both are written as
   var(--btn-border-w), and this pins that they are the SAME expression rather
   than two literals that can drift apart — the drift shape this repo names
   over and over. A future 2px border then moves the overlay with it. */
const btnBaseRule = rulesFor('btn', 'shell.css').find(r => r.selector.split(',').some(s => s.trim() === '.btn'));
ok(!!btnBaseRule && /--btn-border-w\s*:\s*1px/.test(btnBaseRule.body),
  '.btn defines --btn-border-w (1px)');
ok(!!btnBaseRule && carries(declValue(btnBaseRule.body, 'border'), '--btn-border-w'),
  "…and .btn's own border shorthand READS it, so the name is the single source of the width");

for (const cls of glossVariants) {
  const v = variantRules(cls);
  ok(!!v.base && carries(declValue(v.base.body, 'border'), '--btn-border-w'),
    `.${cls}'s border width reads var(--btn-border-w)`);

  const beforeBase = v.before.find(r => !/:hover|:active|:focus|:disabled/.test(r.selector));
  const inset = beforeBase ? declValue(beforeBase.body, 'inset') : null;
  ok(!!inset && /var\(\s*--btn-border-w\s*\)/.test(inset) && /\*\s*-1|-1\s*\*|calc\(\s*-/.test(inset),
    `.${cls}::before covers the BORDER box — inset is the NEGATIVE of --btn-border-w (${inset})`);

  const beforeShadow = beforeBase ? declValue(beforeBase.body, 'box-shadow') : null;
  for (const device of ['--gloss-specular', '--gloss-shade']) {
    ok(carries(beforeShadow, device),
      `.${cls}::before carries var(${device}) — drawn over the border box, not clipped one pixel in`);
  }
  const hoverBefore = v.before.find(r => /:hover/.test(r.selector));
  ok(!!hoverBefore && carries(declValue(hoverBefore.body, 'box-shadow'), '--gloss-specular-hi'),
    `.${cls}:hover::before raises the specular (the device that already carried hover on dark)`);
  const activeBefore = v.before.find(r => /:active/.test(r.selector));
  ok(!!activeBefore && carries(declValue(activeBefore.body, 'box-shadow'), '--gloss-pressed'),
    `.${cls}:active::before takes --gloss-pressed — its inner 1px ring lands on the border box too`);
}

/* ── .btn-secondary IS DELIBERATELY EXCLUDED, AND THE EXCLUSION IS PINNED ──
   Its border is REAL and opaque (--control-edge), so its padding box is
   exactly where its face should stop; there is no raw fill for a ring to be
   made of, and growing the face over that edge would tint the one device
   carrying WCAG 1.4.11 for the whole variant. Measured on the shipping build,
   dark: its "ring" is --control-edge at 2.37:1 top / 3.24:1 bottom against the
   fill — the edge doing its job. Recording this as an assertion means a future
   "make it consistent" pass has to argue with a measurement. */
{
  const sec = variantRules('btn-secondary');
  const secBefore = sec.before.find(r => !/:hover|:active/.test(r.selector));
  const secInset = secBefore ? declValue(secBefore.body, 'inset') : null;
  ok(secBefore && (secInset === null || /^0$/.test(secInset.trim())),
    `.btn-secondary::before stays on the PADDING box (inset ${secInset === null ? 'inherited from .btn::before = 0' : secInset}) — its opaque --control-edge is the edge`);
  ok(!!sec.base && carries(declValue(sec.base.body, 'border'), '--control-edge'),
    '…and that border is --control-edge, i.e. opaque and load-bearing, not the transparent one');
  ok(!!sec.base && carries(declValue(sec.base.body, 'box-shadow'), '--gloss-specular-quiet'),
    '…so its own inset specular correctly STAYS on the element, where the padding-box clip is right');
}

const lightSuppress = primaryRules.filter(r =>
  /\[data-theme\s*=\s*["']light["']\]/.test(r.selector) &&
  /box-shadow\s*:\s*none/.test(r.body));
ok(lightSuppress.length === 0,
  'the [data-theme="light"] .btn-primary { box-shadow: none } suppression is GONE — light gets the specular, not a deletion');
/* ANTI-VACUITY. `lightSuppress.length === 0` is also what a broken rule
   collector returns, and this repo has shipped exactly that (a suite reporting
   both themes identical because its selector match landed inside a comment).
   So the same predicate is run over a PLANTED rule and must find it. */
{
  const planted = [{ selector: '[data-theme="light"] .btn-primary', body: 'box-shadow: none;' },
                   { selector: '.btn-primary', body: 'background-color: var(--accent);' }];
  const found = planted.filter(r =>
    /\[data-theme\s*=\s*["']light["']\]/.test(r.selector) &&
    /box-shadow\s*:\s*none/.test(r.body));
  ok(found.length === 1, 'control: the same predicate FINDS a planted light-theme suppression (so 0 above is a reading, not blindness)');
  ok(rulesFor('btn-primary', 'shell.css').length > 1,
    `control: rulesFor really collects .btn-primary rules (${rulesFor('btn-primary', 'shell.css').length} of them), so its light-scoped subset being empty is a finding`);
}

// The shell always stamps data-theme both ways, so a media query here would be
// both redundant and against four other /next stylesheets' stated rule.
const shellCss = readFileSync(path.join(NEXT, 'shell.css'), 'utf8');
ok(!/prefers-color-scheme/.test(stripComments(shellCss)),
  'the suppression uses [data-theme="light"], NOT a prefers-color-scheme query');

// tokens/ is copied byte-identical from the design-system bundle and frozen.
const shapeCss = readFileSync(path.join(NEXT, 'tokens/shape.css'), 'utf8');
ok(/--inset-hi:\s*inset 0 1px 0 rgba\(255,255,255,0\.05\)/.test(shapeCss) &&
   /--inset-hi:\s*inset 0 1px 0 rgba\(255,255,255,0\.9\)/.test(shapeCss),
  'tokens/shape.css is untouched — both --inset-hi values are the bundle\'s');

// ─────────────────────────────────────────────────────────────────────────
// §3 — Defect 2: delete affordances
// ─────────────────────────────────────────────────────────────────────────

section('§3 — .btn baseline + .btn-danger + the row-level delete');

const btnBase = rulesFor('btn', 'shell.css').find(r => /^\.btn$/.test(r.selector));
ok(!!btnBase, '.btn base rule exists in shell.css');
for (const prop of ['background', 'color', 'border']) {
  ok(!!btnBase && declares(btnBase.body, prop),
    `.btn declares ${prop} — a variant-less .btn cannot inherit UA chrome`);
}

const dangerRules = rulesFor('btn-danger', 'shell.css');
const dangerBase = dangerRules.find(r => /^\.btn-danger$/.test(r.selector));
ok(!!dangerBase,
  '.btn-danger is defined GENERICALLY in shell.css (confirm.js adds it at runtime)');
for (const prop of ['background', 'color', 'border']) {
  ok(!!dangerBase && declares(dangerBase.body, prop), `.btn-danger declares ${prop}`);
}
ok(dangerRules.some(r => /:hover/.test(r.selector) && /--danger-tint/.test(r.body)),
  '.btn-danger:hover tints with --danger-tint (the design system\'s danger variant)');

// The Shared Brain revoke deliberately keeps a heavier, filled treatment.
const revoke = rulesFor('btn-danger', 'views/shared.css')
  .find(r => /\.sb-revoke-go/.test(r.selector) && /^[^:]*$/.test(r.selector));
ok(!!revoke && /background\s*:\s*var\(--danger\)/.test(revoke.body),
  '.sb-revoke-go .btn-danger keeps its FILLED treatment (higher specificity wins)');

const delRules = rulesFor('chat-conv-delete', 'views/chat.css');
const delBase = delRules.find(r => /^\.chat-conv-delete$/.test(r.selector));
ok(!!delBase, '.chat-conv-delete base rule exists');
ok(!!delBase && BORDER_DECL.test(delBase.body),
  '.chat-conv-delete DECLARES a border — no UA 2px outset bevel');
ok(!!delBase && declares(delBase.body, 'padding'),
  '.chat-conv-delete declares padding — no UA 1px 6px');
ok(!!delBase && !declares(delBase.body, 'box-shadow'),
  '.chat-conv-delete sets NO box-shadow — base.css\'s :focus-visible ring must win');
ok(delRules.some(r => /:hover/.test(r.selector) && /--danger-tint/.test(r.body)),
  '.chat-conv-delete:hover tints with --danger-tint, not a neutral surface');
ok(delRules.some(r => /:focus-within/.test(r.selector)) ||
   RULES.some(r => /chat-conv-delete/.test(r.selector) && /:focus-within/.test(r.selector)),
  '.chat-conv-delete is revealed on :focus-within — reachable without a pointer');

// The sibling row-level remove, so the two cannot drift apart.
const ingRemove = rulesFor('ing-queue-file-remove', 'views/ingest.css')
  .find(r => /^\.ing-queue-file-remove$/.test(r.selector));
ok(!!ingRemove && BORDER_DECL.test(ingRemove.body),
  '.ing-queue-file-remove (the sibling row affordance) still declares a border');

// ─────────────────────────────────────────────────────────────────────────
// §4 — POSITIVE CONTROLS: prove the detector can actually fail
// ─────────────────────────────────────────────────────────────────────────

section('§4 — positive controls');

ok(bareOccurrences([{ file: 'probe', line: 0, raw: 'btn zzz-no-such-class',
                      tokens: tokensFrom('btn zzz-no-such-class') }]).length === 0,
  'control: a class list containing `btn` is covered by the new .btn baseline');

ok(bareOccurrences([{ file: 'probe', line: 0, raw: 'zzz-alpha zzz-beta',
                      tokens: tokensFrom('zzz-alpha zzz-beta') }]).length === 1,
  'control: a class list where NOTHING declares a border IS detected as bare');

ok(bareOccurrences([{ file: 'probe', line: 0, raw: 'zzz-alpha btn-secondary',
                      tokens: tokensFrom('zzz-alpha btn-secondary') }]).length === 0,
  'control: adding a real variant clears the same list — the check is not always-true');

{
  // The interpolation join, on the one real shape in the tree.
  const t = tokensFrom("btn btn-' + (hasKeyField ? 'secondary' : 'primary') + ' btn-xs");
  ok(t.has('btn-secondary') && t.has('btn-primary'),
    'control: an interpolated `btn-` + variant list resolves to both variants');
}

{
  // THE COMMENT-SATISFIES-A-SCAN CONTROL. This is the exact false negative
  // that hid three of the five bare buttons from the first scanner: a prose
  // comment naming a class, sitting above an unrelated border-declaring rule.
  const poisoned = `
    /* .zzz-comment-only is mentioned only in this comment. */
    .zzz-unrelated { border: 1px solid red; }
  `;
  const parsed = collectRules(stripComments(poisoned));
  const re = classSelectorRe('zzz-comment-only');
  const granted = parsed.some(r => re.test(r.selector) && BORDER_DECL.test(r.body));
  ok(!granted,
    'control: a class named ONLY inside a comment is granted no border coverage');

  const unstripped = collectRules(poisoned);
  const grantedRaw = unstripped.some(r => re.test(r.selector) && BORDER_DECL.test(r.body));
  ok(grantedRaw,
    'control: without comment stripping that SAME input false-positives — the strip is load-bearing');
}

ok(classGetsBorder('btn-primary') && !classGetsBorder('zzz-definitely-absent'),
  'control: classGetsBorder discriminates a real class from an absent one');

// ─────────────────────────────────────────────────────────────────────────
// §5 — THE HOVER SHEEN (v3.46.0)
// ─────────────────────────────────────────────────────────────────────────
/*
 * REPORTED with the ring: hover "barely changes anything" on the primary
 * button, and the request was "some glass overlay animation, something nice,
 * smooth, native to Mac OS".
 *
 * The reason hover did nothing is structural and recorded on --accent-hover:
 * on DARK the hover fill is BYTE-IDENTICAL to the rest fill, because white on
 * any violet lighter than --violet-500 fails AA on a 13px/500 label. So the
 * whole of hover was --gloss-specular 0.22 -> 0.34: one CSS pixel of a 32px
 * control. The sheen is a second overlay carrying a top-lit dome.
 *
 * WHAT IS ENFORCED HERE, and why each one is the behaviour rather than the
 * spelling:
 *  a. the sheen is reachable from EXACTLY the two filled gloss variants — the
 *     set is DERIVED from the tree (every rule anywhere under /next that reads
 *     var(--gloss-sheen)) and compared for set equality, so a sheen added to
 *     .btn-ghost in some view stylesheet reds this;
 *  b. it is an ::after, i.e. ghost / ai / tinted-danger have no sheen layer at
 *     ALL rather than one at opacity 0 that a later rule could reveal;
 *  c. its transitions name --t-hover-in / --t-hover-out and contain no literal
 *     duration, and those tokens resolve to --dur-* names that a
 *     prefers-reduced-motion block zeroes — asserted by FOLLOWING the chain,
 *     not by looking for the string "prefers-reduced-motion";
 *  d. the dark hover fill still equals the dark rest fill. If someone
 *     "improves" hover by lightening the fill again, the sheen stops being
 *     necessary and the label drops below AA — that is D1, and it is the whole
 *     reason this device exists.
 */
section('§5 — the hover sheen: scope, motion, and the fill that must not move');

{
  const sheenRules = RULES.filter(r => /var\(\s*--gloss-sheen\s*\)/.test(r.body));
  const sheenSelectors = new Set();
  for (const r of sheenRules) for (const s of r.selector.split(',')) sheenSelectors.add(s.trim());
  const expected = new Set(['.btn-primary::after', '.btn-danger-solid::after']);
  const extra = [...sheenSelectors].filter(s => !expected.has(s));
  ok(sheenRules.length > 0, `--gloss-sheen has consumers (${sheenRules.length} rule(s))`);
  ok(extra.length === 0,
    extra.length === 0
      ? 'the sheen is reachable from EXACTLY .btn-primary::after and .btn-danger-solid::after'
      : 'the sheen leaked onto: ' + extra.join(', '));
  ok(expected.size === [...expected].filter(s => sheenSelectors.has(s)).length,
    '…and both of them really do read it (the set is equal, not merely a subset)');
  ok(sheenRules.every(r => r.file === 'shell.css'),
    '…and only shell.css declares it — the control kit owns its own hover, no view may add one');

  // (b) STRUCTURAL EXCLUSION. A variant with no ::after cannot be given a
  // sheen by an opacity override; assert the non-gloss variants declare none.
  for (const cls of ['btn-ghost', 'btn-ai', 'btn-danger', 'btn-secondary']) {
    const after = rulesFor(cls, 'shell.css')
      .filter(r => r.selector.split(',').some(s => s.trim().includes(`.${cls}::after`)));
    ok(after.length === 0,
      `.${cls} declares NO ::after — ghost, tinted and outline variants are not raised objects, so they get no gloss`);
  }

  // (c) MOTION. Follow the chain rather than grepping for the media query.
  const afterBase = RULES.find(r => r.file === 'shell.css'
    && r.selector.split(',').some(s => s.trim() === '.btn-primary::after')
    && /var\(\s*--gloss-sheen\s*\)/.test(r.body));
  const afterHover = RULES.find(r => r.file === 'shell.css'
    && r.selector.split(',').some(s => s.trim() === '.btn-primary:hover::after'));
  const outT = afterBase ? declValue(afterBase.body, 'transition') : null;
  const inT = afterHover ? declValue(afterHover.body, 'transition') : null;
  ok(!!outT && /var\(\s*--t-hover-out\s*\)/.test(outT) && !/\d+m?s/.test(outT),
    `the sheen leaves on var(--t-hover-out) with no literal duration (${outT})`);
  ok(!!inT && /var\(\s*--t-hover-in\s*\)/.test(inT) && !/\d+m?s/.test(inT),
    `…and arrives on var(--t-hover-in) — the kit's existing 110-in / 120-out asymmetry (${inT})`);

  const motionCss = readFileSync(path.join(NEXT, 'tokens/motion.css'), 'utf8');
  const materialCss = readFileSync(path.join(NEXT, 'tokens/material.css'), 'utf8');
  const bothTokens = stripComments(motionCss + '\n' + materialCss);
  // --t-hover-in / --t-hover-out -> the --dur-* names they compose.
  const durOf = (name) => (new RegExp(`${name}\\s*:\\s*var\\(\\s*(--dur-[\\w-]+)\\s*\\)`).exec(bothTokens) || [])[1] || null;
  const durIn = durOf('--t-hover-in'), durOut = durOf('--t-hover-out');
  ok(!!durIn && !!durOut, `both hover pairings resolve to duration tokens (${durIn}, ${durOut})`);
  // …and both of those names are set to 0 inside SOME reduced-motion block.
  const reduceBlocks = [...bothTokens.matchAll(/@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)\s*\{([\s\S]*?)\n\}/g)]
    .map(m => m[1]).join('\n');
  const zeroed = (n) => new RegExp(`${n}\\s*:\\s*0m?s`).test(reduceBlocks);
  ok(zeroed(durIn) && zeroed(durOut),
    `reduced motion zeroes both (${durIn}, ${durOut}) — the sheen appears instantly instead of animating, with no rule of its own`);
  // Anti-vacuity: the same predicate must report a name that is NOT zeroed.
  ok(!zeroed('--dur-shimmer'),
    'control: the same predicate says --dur-shimmer is NOT zeroed (it deliberately is not) — so the two above are a reading, not a match-anything');
  ok(reduceBlocks.length > 0,
    'control: at least one reduced-motion block was actually parsed out of the token files');

  // (d) THE FILL THAT MUST NOT MOVE. Re-derived from the token files, per theme.
  const lightAt = stripComments(materialCss).indexOf('[data-theme="light"]');
  const darkBlock = stripComments(materialCss).slice(0, lightAt);
  const dHover = (/--accent-hover\s*:\s*var\(\s*(--[\w-]+)\s*\)/.exec(darkBlock) || [])[1];
  ok(dHover === '--violet-500',
    `dark --accent-hover is still ${dHover} — the same rung as --accent, so hover does NOT lighten the fill (white on --violet-400 is 3.05:1)`);
  const colorCss = stripComments(readFileSync(path.join(NEXT, 'tokens/color.css'), 'utf8'));
  const dAccent = (/--accent\s*:\s*var\(\s*(--[\w-]+)\s*\)/.exec(colorCss) || [])[1];
  ok(dAccent === dHover,
    `…and dark --accent is the SAME rung (${dAccent}) — this equality is what makes the sheen structural rather than decorative`);

  const primaryHover = rulesFor('btn-primary', 'shell.css')
    .find(r => r.selector.split(',').some(s => s.trim() === '.btn-primary:hover'));
  ok(!!primaryHover && carries(declValue(primaryHover.body, 'box-shadow'), '--elev-2'),
    '.btn-primary:hover still LIFTS (--elev-2) — the sheen is the highlight, the lift is the elevation');
  ok(!!primaryHover && !carries(declValue(primaryHover.body, 'box-shadow'), '--gloss-contact'),
    '…and drops the contact shadow while lifted, rather than stacking both');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All /next button-chrome assertions green');
