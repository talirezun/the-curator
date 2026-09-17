/**
 * test-next-view-enter-motion.js — OFFLINE suite for the /next shell's
 * per-navigation motion: the EXIT (v3.57.0), the mount, and the enter
 * (shell.css "View enter motion" / "View EXIT motion" + app.js
 * playViewEnter() / applyViewExit() / navigate() / mountView()).
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
 *   4. (v3.57.0) THE HELD EXIT. The exit animation fills `forwards` on
 *      purpose — it has to hold opacity 0 until mountView() swaps the
 *      content — so every path that mounts MUST clear the class, and no
 *      path may schedule the exit where the timer that clears it cannot
 *      run on time (a hidden document clamps setTimeout to ~1s). Get
 *      either wrong and the app shows a blank column with nothing in the
 *      console. Section 8 EXECUTES navigate()/mountView() over a fake DOM
 *      and fake timers to pin the order, the last-wins retarget, the boot
 *      skip, the same-view skip, the reduced-motion skip and the hidden-
 *      document skip — none of which a source scan can see.
 *
 *   5. (v3.57.0) onExit ON THE WRONG VIEW. Because the mount is deferred,
 *      `state.view` (the SELECTED view, updated in the same frame as the
 *      click) and `_mountedView` (what is actually on screen) can disagree
 *      for the length of the exit. Two clicks inside one window would fire
 *      onExit on a view that never mounted if the teardown read the wrong
 *      one. Section 8 drives exactly that sequence.
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

const exitClsMatch = appSrc.match(/const\s+VIEW_EXIT_CLASS\s*=\s*'([^']+)'/);
ok(!!exitClsMatch, 'app.js declares VIEW_EXIT_CLASS');
const JS_EXIT_CLASS = exitClsMatch ? exitClsMatch[1] : null;

const exitTokMatch = appSrc.match(/const\s+VIEW_EXIT_TOKEN\s*=\s*'(--dur-[a-z]+)'/);
ok(!!exitTokMatch, 'app.js declares VIEW_EXIT_TOKEN as a --dur-* token name (never a number)');

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
section('3. mountView() is the caller — not setMain() / setSidebar()');

{
  const code = stripComments(appSrc);
  const navIdx = code.indexOf('export function navigate(');
  ok(navIdx !== -1, 'navigate() found');
  const navBody = braceSlice(code, navIdx) || '';

  // v3.57.0 moved the trigger one level down. navigate() now has an EXIT
  // phase and hands the mount (and with it the enter) to mountView(), which
  // may run one timer tick later. The invariant is unchanged in substance —
  // ONE enter per navigation, fired from the function that mounts — so it is
  // asserted against mountView() and against navigate() reaching it.
  const mountIdx = code.indexOf('function mountView(');
  ok(mountIdx !== -1, 'mountView() found');
  const mountBody = mountIdx === -1 ? '' : (braceSlice(code, mountIdx) || '');
  ok(/\bplayViewEnter\s*\(\s*\)/.test(mountBody),
    'mountView() calls playViewEnter() — one trigger per mount');
  ok(!/\bplayViewEnter\s*\(\s*\)/.test(navBody),
    'navigate() does NOT call playViewEnter() itself — it would fire during the exit, over the OUTGOING view');
  ok(/\bmountView\s*\(/.test(navBody),
    'navigate() reaches the mount (and so the enter) through mountView()');

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
  ok(block.includes(`#view-root.${JS_EXIT_CLASS}`),
    `the reduce block names #view-root.${JS_EXIT_CLASS} exactly — the exit HOLDS opacity 0 (fill-mode forwards), so an unescaped one is a blank column, not a flourish`);
  ok(block.includes(`#sidebar.${JS_EXIT_CLASS}`),
    `the reduce block names #sidebar.${JS_EXIT_CLASS} exactly`);
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

// ─────────────────────────────────────────────────────────────────────────
section('7. shell.css hangs the EXIT on the same two containers, via tokens');

{
  const rules = animationRules(cssSrc.replace(/\/\*[\s\S]*?\*\//g, ' '));
  const exit = rules.filter(r => r.sel.includes(JS_EXIT_CLASS) && r.value !== 'none');
  const vr = exit.find(r => r.sel.includes('#view-root'));
  const sb = exit.find(r => r.sel.includes('#sidebar'));
  ok(!!vr, `#view-root.${JS_EXIT_CLASS} carries an animation`);
  ok(!!sb, `#sidebar.${JS_EXIT_CLASS} carries an animation`);

  for (const [name, r] of [['#view-root exit', vr], ['#sidebar exit', sb]]) {
    ok(!!r && /var\(\s*--dur-[a-z]+\s*\)/.test(r.value),
      `${name} duration is a var(--dur-*) TOKEN (got: ${r ? r.value : 'none'})`);
    ok(!!r && !/\b\d+(\.\d+)?m?s\b/.test(r.value.replace(/var\([^)]*\)/g, '')),
      `${name} carries no bare time literal outside var()`);
    ok(!!r && /var\(\s*--ease-[a-z-]+\s*\)/.test(r.value),
      `${name} easing comes from a token`);
    // The exit's whole job is to HOLD the leaving state until the mount
    // swaps the content. Without `forwards` the column snaps back to fully
    // visible for the frames between the animation ending and the timer
    // firing — a flash of the OLD view, on its way out.
    ok(!!r && /\bforwards\b/.test(r.value),
      `${name} fills FORWARDS — it must hold opacity 0 until mountView() clears the class`);
    // The keyframe it names must exist.
    const kf = r ? r.value.trim().split(/\s+/)[0] : '';
    ok(!!r && new RegExp(`@keyframes\\s+${kf}\\b`).test(cssSrc),
      `@keyframes ${kf} is defined in shell.css`);
  }

  ok(!!JS_EXIT_CLASS && cssSrc.includes(`#view-root.${JS_EXIT_CLASS}`) && cssSrc.includes(`#sidebar.${JS_EXIT_CLASS}`),
    `shell.css uses the same exit class app.js writes ('${JS_EXIT_CLASS}')`);

  // The shared reveal primitive the view files emit on a block's first fill.
  // It is named in four other agents' briefs, so a rename here is a silent
  // break in files this suite cannot see.
  const reveal = rules.find(r => /(^|[\s,])\.content-reveal(\b|[.:])/.test(r.sel) && r.value !== 'none');
  ok(!!reveal, '.content-reveal carries an animation — the shared primitive for content that lands after the enter has ended');
  ok(!!reveal && /var\(\s*--dur-[a-z]+\s*\)/.test(reveal.value),
    `.content-reveal duration is a var(--dur-*) token (got: ${reveal ? reveal.value : 'none'})`);
  const revealKf = reveal ? reveal.value.trim().split(/\s+/)[0] : '';
  const kfHomes = [];
  for (const f of ['src/public/next/shell.css', 'src/public/next/tokens/motion.css']) {
    if (new RegExp(`@keyframes\\s+${revealKf}\\b`).test(readFileSync(path.join(ROOT, f), 'utf8'))) kfHomes.push(f);
  }
  ok(kfHomes.length === 1,
    `@keyframes ${revealKf} is declared exactly once across shell.css + tokens/motion.css (found in: ${kfHomes.join(', ') || 'neither'}) — a second body is the drift shape motion.css retired two keyframes to close`);
  const revealReduce = cssSrc.search(/@media\s*\([^)]*prefers-reduced-motion\s*:\s*reduce[^)]*\)/) === -1
    ? '' : cssSrc.slice(cssSrc.search(/@media\s*\([^)]*prefers-reduced-motion\s*:\s*reduce[^)]*\)/));
  ok(/@media\s*\([^)]*prefers-reduced-motion[^)]*\)\s*\{[^}]*\.content-reveal[^}]*animation\s*:\s*none/.test(
      cssSrc.replace(/\s+/g, ' ')) || /\.content-reveal\s*\{\s*animation\s*:\s*none/.test(revealReduce.replace(/\s+/g, ' ')),
    '.content-reveal has a same-file prefers-reduced-motion escape setting animation: none');
}

// ─────────────────────────────────────────────────────────────────────────
section('8. navigate() EXECUTED — exit precedes teardown, last-wins, boot skip, reduce skip');

/** Build and run the REAL navigate()/mountView() pair against a fake DOM,
 *  fake timers and a fake registry.
 *
 *  Source-reading this sequence would prove nothing: the whole change is
 *  about ORDER and TIMING across a timer boundary, which only execution can
 *  answer. Same extract-and-execute pattern section 2 uses on playViewEnter.
 */
function buildNav({ durInstant = '80ms', hidden = false, present = ['view-root', 'sidebar'] } = {}) {
  const log = [];
  const els = new Map();
  for (const id of present) {
    const el = {
      id,
      _classes: new Set(),
      classList: {
        remove: (c) => { log.push({ op: 'class-remove', id, c }); el._classes.delete(c); },
        add: (c) => { log.push({ op: 'class-add', id, c }); el._classes.add(c); },
        contains: (c) => el._classes.has(c),
      },
      get offsetWidth() { return 100; },
    };
    els.set(id, el);
  }
  const document = { hidden, getElementById: (id) => els.get(id) || null };
  const getComputedStyle = () => ({ getPropertyValue: () => durInstant });

  const timers = [];
  const setTimeout_ = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  const runTimers = () => { const q = timers.splice(0); for (const t of q) t.fn(); };

  // Pull the real declarations out of app.js so the harness cannot disagree
  // with the shipped constants.
  const pick = (re, label) => {
    const m = appSrc.match(re);
    if (!m) throw new Error('could not extract ' + label);
    return m[0];
  };
  const decls = [
    pick(/const\s+VIEW_ENTER_CLASS\s*=\s*'[^']+';/, 'VIEW_ENTER_CLASS'),
    pick(/const\s+VIEW_ENTER_TARGETS\s*=\s*\[[^\]]*\];/, 'VIEW_ENTER_TARGETS'),
    pick(/const\s+VIEW_EXIT_CLASS\s*=\s*'[^']+';/, 'VIEW_EXIT_CLASS'),
    pick(/const\s+VIEW_EXIT_TOKEN\s*=\s*'[^']+';/, 'VIEW_EXIT_TOKEN'),
    pick(/let\s+_mountedView\s*=[^;]*;/, '_mountedView'),
    pick(/let\s+_pendingNav\s*=[^;]*;/, '_pendingNav'),
    pick(/let\s+_afterMountQueue\s*=[^;]*;/, '_afterMountQueue'),
  ].join('\n');

  const fns = ['function resolvedMotionMs(', 'function applyViewExit(', 'function clearViewExit(',
    'function playViewEnter(', 'export function navigate(', 'export function afterViewMount(',
    'function mountView(']
    .map((sig) => {
      const i = appSrc.indexOf(sig);
      if (i === -1) throw new Error('could not find ' + sig);
      return (braceSlice(appSrc, i) || '').replace(/^export\s+/, '');
    }).join('\n\n');

  const prelude = `
    let mountToken = 0;
    let currentTeardown = null;
    const VIEW_KEY = '__test_view__';
    const state = { view: null, reader: null };
    const registry = new Map();
    for (const n of ['chat', 'domains', 'settings']) {
      registry.set(n, {
        onEnter: (t) => { log.push({ op: 'onEnter', view: n, token: t }); return () => log.push({ op: 'teardown', view: n }); },
        onExit:  () => log.push({ op: 'onExit', view: n }),
      });
    }
    function closeReader() { log.push({ op: 'closeReader' }); }
    function renderRailActive() { log.push({ op: 'rail', view: state.view }); }
    function refreshSyncBadge() {}
    function handleMountFailure(n, e) { log.push({ op: 'mountFailure', view: n }); }
    const localStorage = { setItem() {}, getItem() { return null; }, removeItem() {} };
  `;

  const factory = new Function('document', 'getComputedStyle', 'setTimeout', 'console', 'log',
    `${prelude}\n${decls}\n${fns}\nreturn { navigate, afterViewMount, state, els: null, mountedNow: () => state.view };`);
  const api = factory(document, getComputedStyle, setTimeout_, { error() {}, warn() {} }, log);
  return { ...api, log, els, timers, runTimers, cls: (id) => [...(els.get(id)?._classes || [])].sort() };
}

{
  // BOOT: the very first navigate has nothing to leave, so it must mount in
  // the same task — no timer, no exit class, no blank frame before the shell
  // has ever painted.
  const h = buildNav();
  h.navigate('chat');
  ok(h.timers.length === 0, 'BOOT SKIP: the first navigate() schedules no exit timer');
  ok(h.log.some(e => e.op === 'onEnter' && e.view === 'chat'), '…and mounts synchronously');
  ok(!h.log.some(e => e.op === 'class-add' && e.c === JS_EXIT_CLASS), '…and never applies the exit class');
}

{
  // THE ORDER. Exit first, THEN teardown/onExit/mount — the entire point.
  const h = buildNav();
  h.navigate('chat');
  const mark = h.log.length;
  h.navigate('domains');

  const during = h.log.slice(mark);
  const exitAdds = during.filter(e => e.op === 'class-add' && e.c === JS_EXIT_CLASS).map(e => e.id);
  ok(JSON.stringify(exitAdds.sort()) === JSON.stringify(['sidebar', 'view-root']),
    `the exit class lands on exactly the two stable containers (got [${exitAdds.join(', ')}])`);
  ok(!during.some(e => e.op === 'teardown' || e.op === 'onExit' || e.op === 'onEnter'),
    'EXIT PRECEDES TEARDOWN: nothing is torn down or mounted before the timer fires');
  ok(during.some(e => e.op === 'closeReader'),
    '…while the reader still closes INSTANTLY (the hard rule is not deferred)');
  ok(during.some(e => e.op === 'rail' && e.view === 'domains'),
    '…and the rail highlights the target in the same task as the click');
  ok(h.timers.length === 1 && h.timers[0].ms === 80,
    `…and exactly one timer is armed, at the resolved --dur-instant (got ${h.timers.length} timer(s) at ${h.timers[0] && h.timers[0].ms}ms)`);

  h.runTimers();
  const after = h.log.slice(mark);
  const order = after.filter(e => ['teardown', 'onExit', 'onEnter'].includes(e.op)).map(e => e.op + ':' + e.view);
  ok(JSON.stringify(order) === JSON.stringify(['teardown:chat', 'onExit:chat', 'onEnter:domains']),
    `after the timer: teardown -> onExit -> onEnter, in that order (got ${order.join(' -> ')})`);
  ok(h.cls('view-root').includes(JS_CLASS) && !h.cls('view-root').includes(JS_EXIT_CLASS),
    'the mounted container wears the ENTER class and no longer the exit class');
}

{
  // LAST WINS. Three rapid clicks during one exit window must mount ONCE,
  // and must mount the LAST name asked for.
  const h = buildNav();
  h.navigate('chat');
  const mark = h.log.length;
  h.navigate('domains');
  h.navigate('settings');
  h.navigate('domains');
  ok(h.timers.length === 1, `LAST WINS: still exactly one armed timer after three navigations (got ${h.timers.length})`);
  h.runTimers();
  const mounts = h.log.slice(mark).filter(e => e.op === 'onEnter').map(e => e.view);
  ok(JSON.stringify(mounts) === JSON.stringify(['domains']),
    `exactly one mount, of the LAST requested view (got [${mounts.join(', ')}])`);
  const exits = h.log.slice(mark).filter(e => e.op === 'onExit').map(e => e.view);
  ok(JSON.stringify(exits) === JSON.stringify(['chat']),
    `onExit fired once, for the view that was actually MOUNTED (got [${exits.join(', ')}]) — reading state.view here would name a view that never mounted`);
}

{
  // SAME VIEW: navigate() has always re-mounted the current view. What it
  // must not do is animate a departure that is not happening.
  const h = buildNav();
  h.navigate('chat');
  const mark = h.log.length;
  h.navigate('chat');
  ok(h.timers.length === 0, 'SAME-VIEW SKIP: re-entering the mounted view arms no exit timer');
  ok(h.log.slice(mark).some(e => e.op === 'onEnter' && e.view === 'chat'), '…and still re-mounts');
}

{
  // REDUCE: tokens/motion.css zeroes --dur-*, so the resolved duration is the
  // signal. 0 means mount now.
  const h = buildNav({ durInstant: '0ms' });
  h.navigate('chat');
  const mark = h.log.length;
  h.navigate('domains');
  ok(h.timers.length === 0, 'REDUCE SKIP: a resolved 0ms duration arms no timer');
  ok(h.log.slice(mark).some(e => e.op === 'onEnter' && e.view === 'domains'), '…and mounts synchronously');
  ok(!h.log.slice(mark).some(e => e.op === 'class-add' && e.c === JS_EXIT_CLASS), '…and never applies the exit class');
}

{
  // HIDDEN DOCUMENT: setTimeout is clamped and transitionend never arrives,
  // so a deferred mount could leave the column held at opacity 0 for a
  // second or more. Nobody is looking; skip it.
  const h = buildNav({ hidden: true });
  h.navigate('chat');
  const mark = h.log.length;
  h.navigate('domains');
  ok(h.timers.length === 0, 'HIDDEN DOCUMENT: no exit is scheduled when document.hidden is true');
  ok(h.log.slice(mark).some(e => e.op === 'onEnter' && e.view === 'domains'), '…and the mount is not delayed');
}

{
  // afterViewMount(): the supported way for a caller to touch the new view's
  // DOM. Must fire AFTER onEnter, and must fire immediately when nothing is
  // pending.
  const h = buildNav();
  h.navigate('chat');
  h.navigate('domains');
  let ran = -1;
  h.afterViewMount(() => { ran = h.log.filter(e => e.op === 'onEnter').length; });
  ok(ran === -1, 'afterViewMount() waits while an exit is in flight');
  h.runTimers();
  ok(ran === 2, `…then runs AFTER the mount it was waiting for (saw ${ran} mounts)`);

  let immediate = false;
  h.afterViewMount(() => { immediate = true; });
  ok(immediate === true, '…and runs immediately when nothing is pending');

  let threw = false;
  try { h.afterViewMount(() => { throw new Error('boom'); }); } catch { threw = true; }
  ok(!threw, '…and a throwing callback never escapes');
}

{
  // Null-safety, same discipline as playViewEnter: a missing shell container
  // must not break navigation.
  for (const present of [[], ['view-root']]) {
    const h = buildNav({ present });
    let err = null;
    try { h.navigate('chat'); h.navigate('domains'); h.runTimers(); } catch (e) { err = e; }
    ok(err === null, `navigate() survives a shell with containers [${present.join(', ') || 'none'}]`);
  }
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ /next view-enter motion assertions green');
