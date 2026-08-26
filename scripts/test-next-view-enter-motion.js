/**
 * test-next-view-enter-motion.js — OFFLINE suite for the /next shell's
 * per-navigation enter motion (shell.css "View enter motion" +
 * app.js playViewEnter()).
 *
 * ── Why this exists, and what it deliberately does NOT claim ─────────────
 * The change it guards is VISUAL. Whether 180ms of opacity+slide "feels
 * evolved" is not assertable offline and this suite does not pretend to
 * assert it — the animation actually running, the axis, the reader overlay
 * and reduced motion were all verified in a real browser and the numbers
 * live in the release notes.
 *
 * What IS assertable offline are the three ways this feature can be broken
 * SILENTLY — each of which leaves the app working, the whole existing suite
 * green, and nothing in any log:
 *
 *   1. THE DOUBLE-FIRE. setMain() replaces #view-root's child on every call,
 *      and the busiest views call it 2-3x per entry (measured live:
 *      domains 3, settings 3, chat 2, sync 2 child writes for ONE
 *      navigation, because each paints a "Loading…" placeholder first).
 *      Move the animation from the stable container onto `.main-inner` /
 *      `.sidebar-inner` and it fires once per write — a stutter on exactly
 *      the screens people use most, with no error anywhere.
 *
 *   2. THE CONTAINING-BLOCK DEFECT. A CSS `transform` makes an element the
 *      containing block for every `position: fixed` DESCENDANT. #main
 *      contains #reader-root, whose `.reader-scrim` is deliberately
 *      viewport-anchored. Animating #main instead of #view-root re-anchors
 *      the reader overlay to the main column. Measured live: a fixed probe
 *      inside #reader-root moved from left:0 to left:340 (= 60px rail +
 *      272px sidebar) the moment a transform was put on #main, and did not
 *      move at all with the animation on #view-root. #view-root is
 *      #reader-root's SIBLING. The wrong id here is one word wide and looks
 *      cosmetic; it behaves like the v3.8.0 click-swallower.
 *
 *   3. CLASS-NAME DRIFT. The class is a string literal in shell.css and a
 *      named constant in app.js. Rename one and not the other and the
 *      motion simply stops — no error, no console warning, and nothing else
 *      in the tree able to see it.
 *
 * Section 2 does not read source with a regex and call that a test: it
 * EXTRACTS playViewEnter() from app.js and EXECUTES it against an
 * instrumented fake DOM, so what is asserted is what the function does.
 * (Extract-and-execute is this repo's established pattern for a function
 * whose real module cannot be imported in Node — app.js has module-scope
 * `document` access and imports every views/*.js.)
 *
 *   ENFORCED — the targets playViewEnter() actually touches; the restart
 *              idiom (remove -> forced reflow -> add, in that order); its
 *              null-safety; that navigate() is the caller and setMain /
 *              setSidebar are not; that the CSS hangs the animation on the
 *              two stable containers and on nothing matching `-inner`; that
 *              the durations are var(--dur-*) tokens rather than literals;
 *              that a same-selector reduced-motion escape exists; and that
 *              the JS constant and the CSS selectors agree on the class.
 *
 *   NOT ENFORCED (named, not implied away) —
 *     • That the animation is VISUALLY pleasant, correctly eased, or the
 *       right duration. Not assertable here; browser-verified instead.
 *     • That the animation actually RUNS. A frozen document timeline (a
 *       hidden tab) leaves it at t=0 forever; that is a browser condition,
 *       not a source property, and is documented at the CSS rule.
 *     • Cascade resolution. If another stylesheet later overrides
 *       `#view-root.view-enter`'s animation, this suite still passes —
 *       it checks the rule exists in shell.css, not that it wins.
 *     • The scrollbar-axis choice. That translateY overflows and translateX
 *       cannot is a property of `overflow-x: hidden`, measured live; this
 *       suite pins the axis only insofar as it pins the keyframes' text.
 *
 * Zero dependencies — node: builtins only.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const APP_JS = path.join(ROOT, 'src/public/next/app.js');
const SHELL_CSS = path.join(ROOT, 'src/public/next/shell.css');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function section(t) { console.log(`\n${t}`); }

const appSrc = readFileSync(APP_JS, 'utf8');
const cssSrc = readFileSync(SHELL_CSS, 'utf8');

/** Brace-matched slice starting at `startIdx` (which must be at or before
 *  the first `{`). Returns the source through the matching `}`. */
function braceSlice(src, startIdx) {
  const open = src.indexOf('{', startIdx);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(startIdx, i + 1); }
  }
  return null;
}

/** Strip // line comments and block comments — used only where we need to
 *  ask "does the real CODE mention X", so a comment naming X cannot answer
 *  for it. (A comment saying "we do NOT touch .main-inner" must not satisfy
 *  an assertion that the code does not touch .main-inner.) */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// ─────────────────────────────────────────────────────────────────────────
section('1. The pieces exist and can be extracted from app.js');

const clsMatch = appSrc.match(/const\s+VIEW_ENTER_CLASS\s*=\s*'([^']+)'/);
ok(!!clsMatch, 'app.js declares VIEW_ENTER_CLASS');
const JS_CLASS = clsMatch ? clsMatch[1] : null;

const fnIdx = appSrc.indexOf('function playViewEnter(');
ok(fnIdx !== -1, 'app.js declares playViewEnter()');
const fnSrc = fnIdx === -1 ? null : braceSlice(appSrc, fnIdx);
ok(!!fnSrc, 'playViewEnter() body is brace-matchable');

const targetsMatch = appSrc.match(/const\s+VIEW_ENTER_TARGETS\s*=\s*\[([^\]]*)\]/);
ok(!!targetsMatch, 'app.js declares VIEW_ENTER_TARGETS');

// ─────────────────────────────────────────────────────────────────────────
section('2. playViewEnter() EXECUTED against an instrumented fake DOM');

/** Build the smallest DOM playViewEnter() can run against, recording the
 *  exact ordered operation log so the restart idiom is asserted as a
 *  SEQUENCE, not as the mere presence of two calls. */
function makeFakeDom(presentIds) {
  const log = [];
  const els = new Map();
  for (const id of presentIds) {
    const el = {
      id,
      _classes: new Set(),
      classList: {
        remove: (c) => { log.push({ op: 'remove', id, c }); el._classes.delete(c); },
        add:    (c) => { log.push({ op: 'add', id, c }); el._classes.add(c); },
        contains: (c) => el._classes.has(c),
      },
      get offsetWidth() { log.push({ op: 'reflow', id }); return 100; },
    };
    els.set(id, el);
  }
  const document = { getElementById: (id) => { log.push({ op: 'get', id }); return els.get(id) || null; } };
  return { document, log, els };
}

function runPlayViewEnter(dom) {
  const prelude = appSrc.slice(appSrc.indexOf('const VIEW_ENTER_CLASS'), fnIdx);
  const factory = new Function('document', `${prelude}\n${fnSrc}\nreturn playViewEnter;`);
  return factory(dom.document)();
}

{
  const dom = makeFakeDom(['view-root', 'sidebar', 'main', 'main-inner', 'sidebar-inner', 'reader-root']);
  runPlayViewEnter(dom);
  const touched = [...new Set(dom.log.filter(e => e.op === 'add' || e.op === 'remove').map(e => e.id))].sort();

  ok(JSON.stringify(touched) === JSON.stringify(['sidebar', 'view-root']),
    `mutates exactly the two STABLE containers — got [${touched.join(', ')}], expected [sidebar, view-root]`);

  ok(!touched.includes('main'),
    'DEFECT 2 GUARD: does NOT animate #main — a transform there becomes the containing block for #reader-root\'s fixed scrim (measured: fixed probe jumped left:0 -> left:340)');

  ok(!touched.includes('main-inner') && !touched.includes('sidebar-inner'),
    'DEFECT 1 GUARD: does NOT animate .main-inner / .sidebar-inner — setMain() replaces those 2-3x per navigation, so the motion would double-fire');

  // Restart idiom, asserted as an ORDERED sequence per element.
  for (const id of ['view-root', 'sidebar']) {
    const seq = dom.log.filter(e => e.id === id && e.op !== 'get').map(e => e.op);
    ok(JSON.stringify(seq) === JSON.stringify(['remove', 'reflow', 'add']),
      `${id}: restart idiom is remove -> forced reflow -> add, in that order (got ${seq.join(' -> ')})`);
  }

  const added = dom.log.filter(e => e.op === 'add').map(e => e.c);
  ok(added.length === 2 && added.every(c => c === JS_CLASS),
    `both containers end up carrying '${JS_CLASS}'`);
  ok(dom.els.get('view-root').classList.contains(JS_CLASS) && dom.els.get('sidebar').classList.contains(JS_CLASS),
    'the class is present on both containers after the call');
}

{
  // Null-safety: a missing shell container must not throw out of navigate().
  // Executed, not read — this file's module-scope null-safety discipline
  // exists because an unguarded dereference once shipped a blank page.
  for (const present of [[], ['view-root'], ['sidebar']]) {
    const dom = makeFakeDom(present);
    let threw = null;
    try { runPlayViewEnter(dom); } catch (e) { threw = e; }
    ok(threw === null,
      `does not throw when present ids are [${present.join(', ') || 'none'}] (missing container must never break navigate())`);
  }
  // …and the one that IS present still gets animated. Wrapped, like the
  // three above: with the null guard removed this call throws, and an
  // UNWRAPPED throw here kills the process before sections 3-6 ever run —
  // turning a clean behavioural red into a crash, which is a red for the
  // wrong reason. (Caught by mutation-testing this suite: M5 originally
  // aborted the run instead of reporting a tally.)
  const dom = makeFakeDom(['sidebar']);
  let survivorThrew = null;
  try { runPlayViewEnter(dom); } catch (e) { survivorThrew = e; }
  ok(survivorThrew === null && dom.log.some(e => e.op === 'add' && e.id === 'sidebar'),
    'a surviving container is still animated when its sibling is absent');
}

// ─────────────────────────────────────────────────────────────────────────
section('3. navigate() is the caller — not setMain() / setSidebar()');

{
  const code = stripComments(appSrc);
  const navIdx = code.indexOf('export function navigate(');
  ok(navIdx !== -1, 'navigate() found');
  const navBody = braceSlice(code, navIdx) || '';
  ok(/\bplayViewEnter\s*\(\s*\)/.test(navBody),
    'navigate() calls playViewEnter() — one trigger per navigation');

  for (const fn of ['setMain', 'setSidebar']) {
    const i = code.indexOf(`function ${fn}(`);
    const body = i === -1 ? '' : (braceSlice(code, i) || '');
    ok(i !== -1 && !/\bplayViewEnter\s*\(/.test(body),
      `DEFECT 1 GUARD: ${fn}() does NOT call playViewEnter() — it runs 2-3x per navigation on the busiest views`);
  }

  // Exactly one call site, so a second trigger cannot be added silently.
  // The DECLARATION `function playViewEnter()` matches the same shape, so it
  // is excluded explicitly — counting it as a call was this suite's own first
  // bug, caught on its first run.
  const callSites = (code.replace(/function\s+playViewEnter\s*\(\s*\)/g, 'function __decl__()')
    .match(/\bplayViewEnter\s*\(\s*\)/g) || []).length;
  ok(callSites === 1, `exactly one playViewEnter() call site in app.js, excluding its declaration (found ${callSites})`);

  // Inert by construction: it must not touch mount/teardown/persistence.
  const forbidden = ['mountToken', 'currentTeardown', 'state.view', 'VIEW_KEY', 'localStorage', 'pointerEvents'];
  for (const f of forbidden) {
    ok(!fnSrc.includes(f),
      `playViewEnter() does not touch ${f} — the motion layer must stay inert w.r.t. shell state`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
section('4. shell.css hangs the motion on the stable containers, via tokens');

/** All `animation:` declarations in shell.css, with their selector text. */
function animationRules(css) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    const sel = m[1].trim().split('\n').pop().trim();
    const body = m[2];
    const a = body.match(/(^|[\s;])animation\s*:\s*([^;]+)/);
    if (a) out.push({ sel: m[1].replace(/\s+/g, ' ').trim(), value: a[2].trim() });
  }
  return out;
}

{
  const rules = animationRules(cssSrc.replace(/\/\*[\s\S]*?\*\//g, ' '));
  const enter = rules.filter(r => r.sel.includes(JS_CLASS));
  ok(enter.length >= 2, `shell.css has animation rules for .${JS_CLASS} (found ${enter.length})`);

  const vr = enter.find(r => r.sel.includes('#view-root') && r.value !== 'none');
  const sb = enter.find(r => r.sel.includes('#sidebar') && r.value !== 'none');
  ok(!!vr, '#view-root.' + JS_CLASS + ' carries an animation');
  ok(!!sb, '#sidebar.' + JS_CLASS + ' carries an animation');

  for (const [name, r] of [['#view-root', vr], ['#sidebar', sb]]) {
    ok(!!r && /var\(\s*--dur-[a-z]+\s*\)/.test(r.value),
      `${name} duration is a var(--dur-*) TOKEN, not a literal — a literal bypasses tokens/motion.css's reduced-motion block entirely (got: ${r ? r.value : 'none'})`);
    ok(!!r && !/\b\d+(\.\d+)?m?s\b/.test(r.value.replace(/var\([^)]*\)/g, '')),
      `${name} carries no bare time literal outside var()`);
    ok(!!r && /var\(\s*--ease-[a-z-]+\s*\)/.test(r.value),
      `${name} easing comes from a token`);
  }

  // DEFECT 1, encoded as a CSS rule: the enter animation must never be hung
  // on an element setMain()/setSidebar() replaces.
  const innerRules = rules.filter(r => /-inner\b/.test(r.sel) && r.value !== 'none');
  ok(innerRules.length === 0,
    `DEFECT 1 GUARD: no animation is applied to a *-inner selector in shell.css (found ${innerRules.length}: ${innerRules.map(r => r.sel).join(', ')})`);

  // DEFECT 2, encoded as a CSS rule: never transform #main / .main.
  const mainAnimated = rules.filter(r => /(^|[\s,])(#main|\.main)(\b|[.:])/.test(r.sel) && !/-inner/.test(r.sel) && r.value !== 'none');
  ok(mainAnimated.length === 0,
    `DEFECT 2 GUARD: shell.css applies no animation to #main/.main — it is the ancestor of #reader-root's fixed scrim (found ${mainAnimated.length})`);
}

// ─────────────────────────────────────────────────────────────────────────
section('5. Reduced-motion escape exists for the same two selectors');

{
  const reduceIdx = cssSrc.search(/@media\s*\([^)]*prefers-reduced-motion\s*:\s*reduce[^)]*\)/);
  ok(reduceIdx !== -1, 'shell.css has a prefers-reduced-motion: reduce block');
  const block = reduceIdx === -1 ? '' : (braceSlice(cssSrc, reduceIdx) || '');
  ok(/animation\s*:\s*none/.test(block),
    'the reduce block sets animation: none (the shape test-next-reduced-motion.js recognises as coverage)');
  ok(block.includes(`#view-root.${JS_CLASS}`),
    `the reduce block names #view-root.${JS_CLASS} exactly`);
  ok(block.includes(`#sidebar.${JS_CLASS}`),
    `the reduce block names #sidebar.${JS_CLASS} exactly`);
}

// ─────────────────────────────────────────────────────────────────────────
section('6. DRIFT GUARD — the JS constant and the CSS selectors agree');

{
  // The whole feature is a string shared across two files. This is the only
  // assertion in the tree that can see them disagree.
  ok(typeof JS_CLASS === 'string' && JS_CLASS.length > 0, 'JS class name is a non-empty string');
  ok(cssSrc.includes(`#view-root.${JS_CLASS}`) && cssSrc.includes(`#sidebar.${JS_CLASS}`),
    `shell.css uses the same class app.js writes ('${JS_CLASS}') — a rename in one file only silently kills the motion`);

  // The keyframes the rules name must actually be defined.
  const rules = animationRules(cssSrc.replace(/\/\*[\s\S]*?\*\//g, ' ')).filter(r => r.sel.includes(JS_CLASS) && r.value !== 'none');
  for (const r of rules) {
    const kf = r.value.trim().split(/\s+/)[0];
    ok(new RegExp(`@keyframes\\s+${kf}\\b`).test(cssSrc),
      `@keyframes ${kf} is defined in shell.css (named by ${r.sel})`);
  }
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ /next view-enter motion assertions green');
