/**
 * test-next-settings-scroll-and-scale.js — OFFLINE suite, zero dependencies.
 *
 * Guards three fixes that landed together because they all sit on Settings:
 *
 *   1. READING POSITION SURVIVES A RE-RENDER (§1-§3). setMain() replaces
 *      #view-root wholesale and `.main` is the scroll container, so every
 *      re-render from a scrolled position sent the user back to the top.
 *      Reported as "Test on my wiki throws me back to the top of Settings,
 *      and so does Start", but the two qualify handlers were never special:
 *      ~40 call sites reach settings.js's render(). Fixed at the chokepoint.
 *
 *   2. THE TWO NATIVE SELECTS (§4). `#select-default-domain` and the model
 *      sort control were the only form controls in Settings drawing macOS
 *      chrome. `appearance: none` + a CSS-drawn chevron, the pattern
 *      views/memory.css established in v3.17.3.
 *
 *   3. AN APP-WIDE TEXT SIZE (§5-§7). One multiplier over the type ramp,
 *      four presets, persisted per browser.
 *
 * WHERE POSSIBLE THIS EXECUTES THE REAL CODE, lifted out of the live source
 * by brace-matching and run with `new Function` — the technique
 * test-next-provider-rows.js and -loading-gate.js use. "A test that proves a
 * line exists proves nothing about what it does" (CLAUDE.md, v3.0.17). Only
 * the CSS assertions are necessarily textual, because there is no CSSOM here.
 *
 * ── ENFORCED ─────────────────────────────────────────────────────────────
 *  · preserveMainScroll restores #main's scrollTop across a render, restores
 *    focus BY ID, and does both even when the render THROWS.
 *  · It refuses to capture focus from outside #view-root/#sidebar, so it can
 *    never reach into the rail or another view.
 *  · resetMainScroll zeroes it.
 *  · settings.js's render() actually goes through preserveMainScroll — driven,
 *    with a spy, not grepped.
 *  · A SECTION CHANGE resets to the top, and does so AFTER render() (which
 *    restores the old offset first, so the order is load-bearing).
 *  · normalizeFontScale accepts exactly the four presets and lands everything
 *    else — including `__proto__` and `constructor` — on the default.
 *  · applyFontScale writes --font-scale on <html> with a NUMBER, persists the
 *    NAME, and still applies when storage throws.
 *  · boot() reads the stored scale and applies it BEFORE the first paint.
 *  · Every --text-* ramp token is expressed against --font-scale, and
 *    --font-scale is defined in CSS so the default survives with no JS.
 *  · Both selects set `appearance: none` AND have a wrapper drawing a chevron
 *    from a theme token rather than a data URI.
 *  · The theme handler is scoped to [data-theme-choice] — a bare
 *    `.theme-seg-btn` selector would bind it to the text-size buttons too and
 *    picking a text size would silently switch the theme.
 *
 * ── NOT ENFORCED (named, not implied away) ───────────────────────────────
 *  · There is no CSSOM here, so §4 asserts the DECLARATIONS exist, not that
 *    they cascade to the element. The open dropdown list is OS-drawn and
 *    nothing in this file (or in any CSS) can reach it — see settings.css.
 *  · 18 hardcoded px font-sizes remain under src/public/next/**, all in view
 *    CSS this change does not own (chat.css, sync.css, shell.css). They do
 *    not scale. §7 pins the COUNT so the number cannot grow silently, and
 *    pins settings.css at zero so the screen hosting the control is coherent.
 *  · Nothing here measures rendered geometry. Whether the largest preset
 *    actually fits was checked in a real browser, not by an assertion — a
 *    scrollHeight delta is not reproducible in Node (the v3.11.0 finding).
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NEXT = join(ROOT, 'src/public/next');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  [32m✓[0m ${label}`); }
  else { failed++; console.log(`  [31m✗ ${label}[0m`); }
}
function eq(a, b, label) { ok(a === b, `${label} (got ${JSON.stringify(a)})`); }

/** Brace-matched extraction of a real function from live source. Throws
 *  loudly on a desync rather than producing a confusing SyntaxError later.
 *  (Same helper as scripts/test-next-loading-gate.js.) */
function extractFunction(src, name, where) {
  const marker = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ${name}\\s*\\(`);
  const m = marker.exec(src);
  if (!m) throw new Error(`extractFunction: "${name}" not found in ${where}`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  let p = src.indexOf('(', start), parenDepth = 0;
  for (; p < src.length; p++) {
    if (src[p] === '(') parenDepth++;
    else if (src[p] === ')') { parenDepth--; if (parenDepth === 0) { p++; break; } }
  }
  let i = src.indexOf('{', p), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const out = src.slice(start, i).replace(/^export\s+/, '');
  if (!/\n\}$/.test(out)) throw new Error(`extractFunction: "${name}" desynced in ${where}`);
  return out;
}

const appSrc = readFileSync(join(NEXT, 'app.js'), 'utf8');
const settingsSrc = readFileSync(join(NEXT, 'views/settings.js'), 'utf8');
const settingsCss = readFileSync(join(NEXT, 'views/settings.css'), 'utf8');
const typographyCss = readFileSync(join(NEXT, 'tokens/typography.css'), 'utf8');

// ── A DOM small enough to reason about, real enough to drive the code ──────
//
// Only what the two primitives actually touch: getElementById, an
// activeElement with an id and a closest(), and a mutable scrollTop. Building
// this by hand rather than reaching for jsdom keeps the suite dependency-free
// (the house rule for every offline suite here) and keeps what is being
// simulated visible — a fixture whose behaviour you cannot see is how a guard
// ends up asserting against a shape the product cannot produce (v3.17.1).
function makeDom({ scrollTop = 0, activeId = null, activeInside = true, present = ['btn-a', 'btn-b'], goneAfterRender = [] } = {}) {
  const focused = [];
  const els = new Map();
  const mk = (id, inside) => ({
    id,
    focusCalls: [],
    focus(opts) { focused.push(id); this.focusCalls.push(opts); },
    // `closest('#view-root, #sidebar')` — truthy for a node inside the two
    // surfaces the shell owns, null for one outside them (the rail).
    closest: () => (inside ? { id: 'view-root' } : null),
  });
  for (const id of present) els.set(id, mk(id, true));
  const main = { id: 'main', scrollTop };
  els.set('main', main);

  // THE ACTIVE ELEMENT IS PUT IN THE DOCUMENT, always — including when it is
  // meant to be out of bounds. The first draft of this fixture left the
  // out-of-bounds node ABSENT from the element map, so removing the
  // containment check from the real function left this suite 121/0 GREEN:
  // the id was captured, getElementById returned null, and nothing was
  // focused for the wrong reason. That is a guard that cannot fail, produced
  // by a fixture in a shape the product cannot produce (the v3.17.1 lesson).
  // With the node present, dropping the check demonstrably focuses the rail.
  let active = { id: '', closest: () => null };
  if (activeId) {
    if (!els.has(activeId)) els.set(activeId, mk(activeId, activeInside));
    const el = els.get(activeId);
    el.closest = () => (activeInside ? { id: 'view-root' } : null);
    active = el;
  }

  // A control the render REMOVED: it exists while focus is captured and is
  // gone by the time focus would be restored. That is the real shape of the
  // qualify panel's Start button when the phase moves to `running`.
  const gone = new Set(goneAfterRender);

  return {
    dom: {
      getElementById: (id) => (gone.has(id) ? null : (els.get(id) || null)),
      get activeElement() { return active; },
    },
    main,
    focused,
    els,
  };
}

const preserveFn = new Function('document',
  extractFunction(appSrc, 'preserveMainScroll', 'app.js') + '\nreturn preserveMainScroll;');
const resetFn = new Function('document',
  extractFunction(appSrc, 'resetMainScroll', 'app.js') + '\nreturn resetMainScroll;');

// ── §1  preserveMainScroll — the scroll half ─────────────────────────────
console.log('\n§1  preserveMainScroll restores reading position');
{
  const { dom, main } = makeDom({ scrollTop: 912 });
  const preserve = preserveFn(dom);
  // Exactly what setMain does to the scroll container: the content vanishes,
  // so the browser clamps scrollTop to 0. This is the defect, reproduced.
  preserve(() => { main.scrollTop = 0; });
  eq(main.scrollTop, 912, 'a render that clamps scrollTop to 0 is undone');
}
{
  const { dom, main } = makeDom({ scrollTop: 0 });
  const preserve = preserveFn(dom);
  preserve(() => { main.scrollTop = 0; });
  eq(main.scrollTop, 0, 'a user already at the top stays at the top (no spurious scroll)');
}
{
  // The value is written back unconditionally; the BROWSER clamps it if the
  // new content is shorter. Node has no layout, so what is pinned here is
  // that we do not clamp it ourselves — which would land the user somewhere
  // arbitrary rather than at the bottom of the page that shrank.
  const { dom, main } = makeDom({ scrollTop: 4000 });
  preserveFn(dom)(() => { main.scrollTop = 0; });
  eq(main.scrollTop, 4000, 'the captured offset is restored verbatim, leaving the clamp to the browser');
}
{
  const { dom, main } = makeDom({ scrollTop: 500 });
  const preserve = preserveFn(dom);
  let threw = false;
  try { preserve(() => { main.scrollTop = 0; throw new Error('render blew up'); }); }
  catch { threw = true; }
  ok(threw, 'a throwing render still propagates — the wrapper does not swallow it');
  eq(main.scrollTop, 500, 'and the position is STILL restored (the finally), not left at the top of a half-painted page');
}
{
  // Boot, a detached shell, or any future caller before #main exists.
  const dom = { getElementById: () => null, activeElement: null };
  let ran = false;
  preserveFn(dom)(() => { ran = true; });
  ok(ran, 'with no #main the render still runs — the primitive never gates the render on the DOM');
}

// ── §2  preserveMainScroll — the focus half ──────────────────────────────
console.log('\n§2  preserveMainScroll restores focus by id');
{
  const { dom, focused, els } = makeDom({ scrollTop: 300, activeId: 'btn-a' });
  preserveFn(dom)(() => { /* innerHTML replaced; a same-id node comes back */ });
  ok(focused.includes('btn-a'), 'the control that had focus is refocused after the render');
  ok(els.get('btn-a').focusCalls.some(o => o && o.preventScroll === true),
    'focused with preventScroll — otherwise the browser would scroll to it and undo the position just restored');
}
{
  // The reported flow: Start disappears when the panel moves to `running`.
  const { dom, focused } = makeDom({
    scrollTop: 300, activeId: 'qualify-go', present: ['qualify-stop'], goneAfterRender: ['qualify-go'],
  });
  preserveFn(dom)(() => {});
  eq(focused.length, 0, 'an id that did NOT come back is simply not restored — never a guess at a different control');
}
{
  // THE CONTAINMENT CHECK. The rail button is genuinely IN the document and
  // focusable — it is only out of bounds by reporting no #view-root/#sidebar
  // ancestor. That is what makes this assertion able to fail: drop the check
  // from preserveMainScroll and it focuses the rail here.
  const { dom, focused, els } = makeDom({ scrollTop: 300, activeId: 'rail-theme-toggle', activeInside: false });
  ok(els.has('rail-theme-toggle') && dom.getElementById('rail-theme-toggle') !== null,
    'control: the out-of-bounds node IS in the document, so a missing containment check would really focus it');
  preserveFn(dom)(() => {});
  eq(focused.length, 0, 'focus OUTSIDE #view-root/#sidebar is never captured — it cannot reach into the rail');
}
{
  const { dom, focused } = makeDom({ scrollTop: 300, activeId: null });
  preserveFn(dom)(() => {});
  eq(focused.length, 0, 'nothing focused (activeElement is <body>) restores nothing');
}
{
  const { dom, focused, main } = makeDom({ scrollTop: 42, activeId: 'btn-a' });
  try { preserveFn(dom)(() => { throw new Error('x'); }); } catch { /* expected */ }
  ok(focused.includes('btn-a') && main.scrollTop === 42,
    'a throwing render restores BOTH halves, not just the scroll');
}

// ── §3  The chokepoint, and the one deliberate exception ─────────────────
console.log('\n§3  settings.js render() goes through it; a section change does not');
{
  const { dom, main } = makeDom({ scrollTop: 0 });
  eq(main.scrollTop, 0, 'reset fixture starts at the top');
  main.scrollTop = 777;
  resetFn(dom)();
  eq(main.scrollTop, 0, 'resetMainScroll sends the main column back to the top');
}
{
  // The REAL settings.js render(), executed with spies. This is the assertion
  // that would have caught a "fix" applied only to the two reported handlers:
  // it drives the chokepoint every one of the ~40 call sites reaches.
  const calls = [];
  const fn = new Function(
    'preserveMainScroll', 'renderSidebar', 'renderMain', 'wireGlobalListeners',
    extractFunction(settingsSrc, 'render', 'views/settings.js') + '\nreturn render;'
  );
  const render = fn(
    (f) => { calls.push('preserve:in'); f(); calls.push('preserve:out'); },
    () => calls.push('sidebar'),
    () => calls.push('main'),
    () => calls.push('wire'),
  );
  render('tok');
  eq(calls.join(','), 'preserve:in,sidebar,main,wire,preserve:out',
    'render() runs the WHOLE re-render (sidebar + main + re-wire) inside preserveMainScroll');
}
{
  // Order is load-bearing: render() restores the OLD offset, so the reset for
  // a new section has to come after it or it is immediately overwritten.
  const src = settingsSrc;
  const i = src.indexOf('state.section = btn.dataset.section;');
  ok(i > 0, 'the section-switch handler is found');
  const region = src.slice(i, i + 1200);
  const r = region.indexOf('render(myMountToken);');
  const z = region.indexOf('resetMainScroll();');
  ok(r >= 0 && z >= 0, 'the section-switch handler both re-renders and resets the scroll');
  ok(z > r, 'resetMainScroll() runs AFTER render() — before it, render() would restore the old offset over the reset');
}
ok(/import \{[\s\S]*?preserveMainScroll[\s\S]*?\} from '\.\.\/app\.js'/.test(settingsSrc),
  'settings.js takes the primitive from the shell rather than reading #main itself (views/README.md rule 4)');
ok(!/getElementById\(\s*['"]main['"]\s*\)/.test(settingsSrc),
  'settings.js never reaches for #main directly');
{
  // preserveMainScroll must stay opt-in. Folding it into setMain would wrap
  // views/chat.js's renders too, and chat drives `.main`'s scroll itself.
  const setMainBody = extractFunction(appSrc, 'setMain', 'app.js');
  ok(!setMainBody.includes('preserveMainScroll'),
    'setMain() does NOT preserve scroll itself — chat.js drives that scroll and would be fought silently');
}

// ── §3b  The fold that was actually collapsing ───────────────────────────
console.log('\n§3b  An expanded model row survives a repaint');
{
  // WHAT MEASUREMENT CHANGED HERE, recorded because the brief said otherwise.
  // The reported symptom was "Test on my wiki throws me back to the top".
  // Driven in a real browser against this app, an innerHTML swap on
  // #view-root does NOT move `.main`'s scrollTop while the offset still fits
  // — measured 300 -> 300 with the scroll fix REMOVED. What did move was
  // FOCUS (-> <body>), and what shortens the document is rows collapsing:
  // `.model-row` derived `open` ONLY from "is this the model being
  // qualified", so every other expanded row snapped shut on every repaint,
  // and this list repaints on a keystroke in the search box, on the sort, on
  // a key save, and on the cross-view write gate firing for an ingest
  // elsewhere. A shorter document is the one condition under which the
  // browser clamps the scroll container. That is the root cause; the scroll
  // preservation in §1-§3 is correct and cheap but is NOT what fixes it.
  // THE EXPRESSION IS LIFTED OUT OF THE LIVE SOURCE, not retyped here. The
  // first draft of this section re-implemented it inside `new Function` and
  // was therefore DECORATIVE: reinstating the shipped bug in settings.js left
  // it 132/0 green, because it was testing a copy. Caught by mutation, which
  // is the only thing that can catch it.
  const openExprLine = settingsSrc.split('\n').find(l => l.includes("state.modelRowOpen[m.id] === true"));
  const expr = openExprLine ? /\((\(.*\))\s*\?\s*' open'\s*:\s*''\)/.exec(openExprLine) : null;
  ok(!!expr,
    'the row-open condition is found in views/settings.js and consults state.modelRowOpen');
  // FAIL CLEANLY, never crash. A suite that throws here would go red for the
  // wrong reason and hide every assertion after it — the v3.7.0 lesson, and
  // the exact shape this file's own §3b mutation first produced.
  const openFor = expr
    ? (() => { const fn = new Function('state', 'c', 'm', `return (${expr[1]}) ? ' open' : '';`); return (s, c, m) => fn(s, c, m); })()
    : () => '(condition not found — see the assertion above)';
  const m = { id: 'z-ai/glm-4.7' };
  eq(openFor({ modelRowOpen: {} }, {}, m), '', 'a row nobody opened renders closed');
  eq(openFor({ modelRowOpen: { 'z-ai/glm-4.7': true } }, {}, m), ' open',
    'a row THE USER opened stays open across a repaint they did not ask for');
  eq(openFor({ modelRowOpen: {} }, { qualify: { modelId: 'z-ai/glm-4.7' } }, m), ' open',
    'the row being measured is FORCED open — the panel must be visible even on a row never expanded');
  eq(openFor({ modelRowOpen: {} }, { qualify: { modelId: 'other/model' } }, m), '',
    'a different row being measured does not open this one');
  ok(/modelRowOpen: \{\}/.test(settingsSrc), 'the fold map is part of the per-mount state (reset on leaving the view)');
  ok(/data-model-row="/.test(settingsSrc), 'rows carry their id so the toggle can be recorded');
  ok(/querySelectorAll\('\[data-model-row\]'\)[\s\S]{0,320}addEventListener\('toggle'/.test(settingsSrc),
    'and a toggle listener records it');
  ok(/\[data-model-row\][\s\S]{0,320}state\.modelRowOpen\[el\.dataset\.modelRow\] = true/.test(settingsSrc),
    'recording it, deliberately WITHOUT a render() — repainting here would throw away the DOM the user just opened');
}
{
  // TEMPORAL DEAD ZONE. This bug was introduced by this change and caught by
  // executing the render rather than by `node --check`, which passes over it:
  // `idAttr` is a `const` and the new use sat ABOVE its declaration, so every
  // model row would have thrown ReferenceError at render time — a blank model
  // picker for anyone with a catalogue. A syntax check cannot see a TDZ
  // error, so the syntax suite could never have caught it.
  const fnSrc = extractFunction(settingsSrc, 'renderModelOption', 'views/settings.js');
  const stripped = fnSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  for (const name of ['idAttr']) {
    const decl = stripped.indexOf(`const ${name} =`);
    const firstUse = stripped.search(new RegExp(`\\b${name}\\b(?!\\s*=)`));
    ok(decl >= 0, `renderModelOption declares ${name}`);
    ok(firstUse >= decl,
      `${name} is declared BEFORE its first use — a const used above its declaration is a render-time ReferenceError that node --check cannot see`);
  }
}

// ── §4  The two selects ──────────────────────────────────────────────────
console.log('\n§4  Both Settings selects are styled, not native chrome');
for (const sel of ['.settings-select', '.model-filter-sort']) {
  const block = blockFor(settingsCss, sel);
  ok(block !== null, `${sel} has a rule block`);
  ok(/(^|\n)\s*appearance:\s*none;/.test(block), `${sel}: appearance: none — the UA menulist chrome is off`);
  ok(/-webkit-appearance:\s*none;/.test(block), `${sel}: -webkit-appearance too (Safari still needs the prefix)`);
  // Without right padding a long value runs underneath the chevron.
  ok(/padding:[^;]*\b(2[0-9]|[3-9][0-9])px\b/.test(block), `${sel}: reserves right padding for the chevron`);
}
{
  const after = blockFor(settingsCss, '.settings-select-wrap::after');
  ok(after !== null, 'a wrapper draws the replacement indicator');
  ok(/border-right:[^;]*var\(--text-2\)/.test(after) && /border-bottom:[^;]*var\(--text-2\)/.test(after),
    'the chevron is two rotated borders in a THEME TOKEN — a data URI carries its own colour and cannot follow the theme');
  ok(/rotate\(45deg\)/.test(after), 'rotated into a chevron');
  ok(/pointer-events:\s*none/.test(after), 'pointer-events: none — the chevron is not a dead zone on the control');
  ok(!/url\(\s*['"]?data:/.test(after), 'not a data-URI background image');
  const wrap = blockFor(settingsCss, '.settings-select-wrap');
  ok(/position:\s*relative/.test(wrap), 'the wrapper is the positioning context the chevron needs');
}
{
  // The wrapper became the flex item, so whatever the select contributed to
  // its parent's layout had to move. Losing this is not subtle: in the column
  // block the wrapper stretches full width and takes the chevron with it.
  ok(blockFor(settingsCss, '.settings-field-block > .settings-select-wrap') !== null,
    'the default-domain wrapper carries the align-self/max-width that moved off the select');
  ok(/\.model-filter-sort-wrap\s*\{[^}]*flex:\s*0 0 auto/.test(settingsCss),
    'the sort wrapper carries the flex sizing that moved off the select');
  ok(settingsSrc.includes('settings-select-wrap'), 'settings.js renders the wrapper (a rule with no markup is dead CSS)');
  ok(settingsSrc.includes('model-filter-sort-wrap'), 'settings.js renders the sort wrapper');
}
ok(/OPEN dropdown list is\s*\n?\s*drawn by the OS|open dropdown list is[\s\S]{0,40}OS/i.test(settingsCss),
  'settings.css STATES what is still native rather than implying it away');
// Comments stripped for the same reason §6 strips them from boot(): this
// file's own comment EXPLAINS why base-select was not taken, and naming the
// thing you rejected must not read as having used it. Second instance of
// that mistake in this suite, hence the shared helper.
ok(!/appearance:\s*base-select|::picker\s*\(/.test(stripCssComments(settingsCss)),
  'no ::picker/base-select DECLARATION — Chromium-only with an untested fallback, deliberately not taken');
// memory.css is another agent's file in this cycle. The duplication is the
// correct outcome; what must not happen is this change having edited it.
ok(readFileSync(join(NEXT, 'views/memory.css'), 'utf8').includes('.mem-select-wrap'),
  'views/memory.css keeps its own copy of the pattern, untouched');

// ── §5  normalizeFontScale ───────────────────────────────────────────────
console.log('\n§5  Text scale — any input lands on a scale we ship');
const FONT_SCALES_SRC = /const FONT_SCALES = \{[\s\S]*?\n\};/.exec(appSrc);
ok(!!FONT_SCALES_SRC, 'FONT_SCALES is found in app.js');
const normalize = new Function(
  FONT_SCALES_SRC[0] + "\nconst FONT_SCALE_DEFAULT = 'default';\n" +
  extractFunction(appSrc, 'normalizeFontScale', 'app.js') + '\nreturn normalizeFontScale;'
)();
const SCALES = new Function(FONT_SCALES_SRC[0] + '\nreturn FONT_SCALES;')();
eq(Object.keys(SCALES).length, 4, 'four presets');
eq(SCALES.default, 1, 'the default preset is exactly 1 — the design system\'s own values, unmultiplied');
ok(SCALES.compact < 1 && SCALES.large > 1 && SCALES.largest > SCALES.large,
  'the presets are strictly ordered around the default (a control that does not move monotonically is unusable)');
ok(SCALES.largest <= 1.18,
  'the top preset stays at or under 1.18 — past ~1.25 text at --leading-normal no longer clears a 28px control');
for (const id of Object.keys(SCALES)) eq(normalize(id), id, `"${id}" is accepted unchanged`);
for (const bad of ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
  eq(normalize(bad), 'default',
    `"${bad}" is REFUSED — FONT_SCALES is a plain object, so a truthiness guard would have written a function or Object into a CSS property`);
}
for (const bad of [null, undefined, '', 'HUGE', 1.5, {}, [], true, NaN]) {
  eq(normalize(bad), 'default', `${JSON.stringify(bad) ?? String(bad)} falls back to the default rather than throwing`);
}
ok(/Object\.hasOwn\(FONT_SCALES/.test(appSrc),
  'the guard is Object.hasOwn, not truthiness or `in` (the v3.0.9 prototype-key lesson)');

// ── §6  applyFontScale + boot ────────────────────────────────────────────
console.log('\n§6  Applying a scale: immediate, persisted, and safe when storage is not');
function driveApply({ storageThrows = false } = {}) {
  const props = new Map();
  const stored = new Map();
  const doc = { documentElement: { style: { setProperty: (k, v) => props.set(k, v) } } };
  const ls = {
    setItem: (k, v) => { if (storageThrows) throw new Error('QuotaExceeded'); stored.set(k, v); },
    getItem: (k) => (stored.has(k) ? stored.get(k) : null),
  };
  const st = { fontScale: 'default' };
  const apply = new Function('document', 'localStorage', 'state',
    FONT_SCALES_SRC[0] + "\nconst FONT_SCALE_DEFAULT = 'default';\nconst FONT_SCALE_KEY = 'curator-next-font-scale';\n" +
    extractFunction(appSrc, 'normalizeFontScale', 'app.js') + '\n' +
    extractFunction(appSrc, 'applyFontScale', 'app.js') + '\nreturn applyFontScale;'
  )(doc, ls, st);
  return { apply, props, stored, st };
}
{
  const { apply, props, stored, st } = driveApply();
  const used = apply('largest');
  eq(used, 'largest', 'applyFontScale returns the name actually used');
  eq(props.get('--font-scale'), String(SCALES.largest), 'the custom property on <html> carries the NUMBER');
  eq(stored.get('curator-next-font-scale'), 'largest',
    'storage carries the NAME, not the number — re-tuning a preset later then reaches everyone who chose it');
  eq(st.fontScale, 'largest', 'state is updated so the control can mark itself active');
}
{
  const { apply, props, stored } = driveApply();
  const used = apply('__proto__');
  eq(used, 'default', 'a prototype key is normalised BEFORE anything is written');
  eq(props.get('--font-scale'), '1', 'and the property is a plain number, never [object Object]');
  eq(stored.get('curator-next-font-scale'), 'default', 'and only a known name is persisted');
}
{
  const { apply, props } = driveApply({ storageThrows: true });
  const used = apply('compact');
  eq(used, 'compact', 'private mode / disabled storage costs the persistence, never the setting just chosen');
  eq(props.get('--font-scale'), String(SCALES.compact), 'the scale is still applied');
}
{
  const bootRaw = extractFunction(appSrc, 'boot', 'app.js');
  // ORDERING IS MEASURED ON CODE, NOT ON PROSE. The first draft of this
  // section compared indexOf() over the raw text and went red for the wrong
  // reason: the comment ABOVE applyFontScale explains itself by naming
  // renderRail() and navigate(), so "renderRail comes first" was true of the
  // comment and false of the code. Stripping comments first is the fix; the
  // lesson is that a source-order assertion has to read the source the
  // engine reads.
  const boot = bootRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  ok(/normalizeFontScale\(localStorage\.getItem\(FONT_SCALE_KEY\)\)/.test(boot),
    'boot() reads the stored scale through the normaliser — so it survives a reload, and junk in storage cannot reach the property');
  const iApply = boot.indexOf('applyFontScale(');
  const iRail = boot.indexOf('renderRail()');
  const iNav = boot.indexOf('navigate(');
  ok(iApply > 0 && iRail > 0 && iNav > 0, 'boot() applies the scale, renders the rail and navigates');
  ok(iApply < iRail && iApply < iNav,
    'the scale is applied BEFORE the first text is painted — no frame shows the app at the wrong size');
  ok(/try \{[\s\S]*getItem\(FONT_SCALE_KEY\)[\s\S]*\} catch/.test(boot),
    'the storage read is inside boot()\'s existing try/catch — a throwing read cannot blank the app');
}
{
  // A view must not be able to set the property itself and skip persistence,
  // or apply without marking state — two half-updates that drift.
  const views = walk(join(NEXT, 'views')).filter(p => p.endsWith('.js'));
  for (const p of views) {
    const src = readFileSync(p, 'utf8');
    ok(!/setProperty\(\s*['"]--font-scale/.test(src),
      `${relative(NEXT, p)}: does not write --font-scale directly (goes through setFontScale)`);
  }
  ok(/export function setFontScale/.test(appSrc), 'the shell exports the one way in');
}

// ── §7  The ramp actually moves, and the control is wired ────────────────
console.log('\n§7  The type ramp is expressed against the scale');
{
  ok(/^\s*--font-scale:\s*1;/m.test(typographyCss),
    '--font-scale is DEFINED in CSS at 1 — with no JS, no stored value, or storage disabled, the ramp is the design system\'s original');
  // Enumerated from the file, never a hardcoded list of token names — a
  // hardcoded list is how a guard here goes blind when a step is added. The
  // count is asserted so the enumeration collapsing to a subset is visible:
  // the first draft of this regex silently missed --text-sm and reported 12.
  const ramp = [...typographyCss.matchAll(/^\s*(--text-[a-z0-9]+)\s*:\s*([^;]+);/gm)];
  eq(ramp.length, 13, 'all 13 ramp steps are enumerated from the file');
  for (const [, name, value] of ramp) {
    ok(/^calc\(\s*\d+px\s*\*\s*var\(--font-scale\)\s*\)$/.test(value.trim()),
      `${name} is calc(<px> * var(--font-scale)) — so it moves with the setting`);
  }
  // The composed roles are what most rules actually read; they must keep
  // reading the ramp rather than having been inlined at some point.
  for (const role of ['--type-body', '--type-h1', '--type-label', '--type-mono']) {
    ok(new RegExp(`${role}:[^;]*var\\(--text-`).test(typographyCss),
      `${role} still resolves through the ramp (so it inherits the scale for free)`);
  }
}
{
  ok(settingsSrc.includes('function renderTextSize()'), 'Settings renders a text-size control');
  ok(/fontScaleOptions\(\)/.test(settingsSrc), 'it renders whatever the SHELL offers — presets cannot drift between the two files');
  ok(!/data-font-scale="(compact|large|largest)"/.test(settingsSrc.replace(/escapeHtml\(id\)/g, '')),
    'no preset name is hardcoded into the markup');
  ok(/document\.querySelectorAll\('\[data-font-scale\]'\)/.test(settingsSrc), 'and wires them');
  // THE COLLISION. The text-size buttons reuse .theme-seg-btn for its look.
  // A bare `.theme-seg-btn` theme handler would bind to them as well, and
  // requestTheme(undefined) falls through to the light branch — so choosing a
  // text size would silently switch the theme.
  ok(/querySelectorAll\('\[data-theme-choice\]'\)/.test(settingsSrc),
    'the THEME handler is scoped to [data-theme-choice], not to the shared .theme-seg-btn class');
  ok(!/querySelectorAll\('\.theme-seg-btn'\)/.test(settingsSrc),
    'nothing binds by the shared look-alike class (that would make a text-size click switch the theme)');
  ok(/aria-pressed="/.test(extractFunction(settingsSrc, 'renderTextSize', 'views/settings.js')),
    'the active preset is announced, not only coloured');
}
{
  // Settings is the screen the control lives on: text there that does NOT
  // move while everything around it does reads as a rendering bug.
  const hard = [...settingsCss.matchAll(/font-size:\s*([\d.]+)px/g)];
  eq(hard.length, 0, 'settings.css has no hardcoded px font-size left — the whole screen follows the setting');
  const segBtn = blockFor(settingsCss, '.theme-seg-btn');
  ok(/font-size:\s*var\(--text-/.test(segBtn),
    'including the segmented control itself — the one control that changes text size must not be the only thing that does not');
}
{
  // The honest limit, pinned as a NUMBER so it cannot grow unnoticed.
  const cssFiles = walk(NEXT).filter(p => p.endsWith('.css'));
  let n = 0;
  const where = new Map();
  for (const p of cssFiles) {
    const hits = readFileSync(p, 'utf8').match(/font-size:\s*[\d.]+px/g) || [];
    if (hits.length) where.set(relative(NEXT, p), hits.length);
    n += hits.length;
  }
  console.log(`      (unscaled px font-sizes remaining: ${n} — ${[...where].map(([f, c]) => `${f}:${c}`).join(', ') || 'none'})`);
  // 20 at the time of writing: shell.css 2, chat.css 15, shared.css 1,
  // sync.css 2 — every one of them in a file this change does not own.
  // A CEILING, not an equality: another agent removing one must not turn
  // this red, but nobody may quietly ADD to the set of text that refuses to
  // follow the user's setting.
  ok(n <= 20,
    `at most 20 hardcoded px font-sizes remain under /next, all in view CSS this change does not own (found ${n}) — they stay at today's size rather than breaking`);
  ok(!where.has('views/settings.css'),
    'and none of them is in settings.css — the screen that hosts the control scales completely');
}

// ── helpers ──────────────────────────────────────────────────────────────

/** CSS with /* … *​/ comments removed, so an assertion about DECLARATIONS is
 *  never satisfied (or defeated) by prose. */
function stripCssComments(css) { return css.replace(/\/\*[\s\S]*?\*\//g, ''); }

/** The declaration block for an exact selector, or null. Matches the selector
 *  standing alone on its own line so `.settings-select` cannot accidentally
 *  return `.settings-select-wrap`'s block. */
function blockFor(css, selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`);
  const m = re.exec(css);
  return m ? m[1] : null;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

console.log(`\nPassed: ${passed}   Failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
