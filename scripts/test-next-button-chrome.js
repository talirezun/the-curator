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
 *  - `.btn-primary` keeps var(--inset-hi) AND suppresses it under
 *    [data-theme="light"].
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
   failure. */
const primaryShadow = primaryBase ? (/box-shadow\s*:\s*([^;}]+)/.exec(primaryBase.body) || [])[1] : null;
ok(primaryShadow !== null, `.btn-primary declares a box-shadow (${primaryShadow})`);
for (const device of ['--gloss-specular', '--gloss-shade', '--gloss-contact']) {
  ok(!!primaryShadow && new RegExp(`var\\(\\s*${device}\\s*\\)`).test(primaryShadow),
    `.btn-primary's box-shadow carries var(${device})`);
}
ok(!!primaryShadow && !/var\(\s*--inset-hi\s*\)/.test(primaryShadow),
  '.btn-primary no longer consumes --inset-hi — the token is untouched, the PAIRING is what was fixed');

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

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All /next button-chrome assertions green');
