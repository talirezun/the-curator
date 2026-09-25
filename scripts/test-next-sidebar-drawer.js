/**
 * test-next-sidebar-drawer.js — OFFLINE guard on the responsive shell
 * (v3.76.0): the three width bands, the sidebar drawer below 800px, and the
 * first-run guide's top dock below 1100px.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 * REPORTED: at ~800px the three fixed columns left the main column 456px and
 * the guide's right-hand dock took 42% of that — measured, the view's content
 * box was 197px at 800 and 74px at 568, and headings wrapped a word per line.
 * Every part of the fix fails SILENTLY if it drifts: a media query that stops
 * matching the JS constant, a drawer that opens on a wide window where the
 * sidebar is already in the grid, an Escape that closes the drawer out from
 * under an open listbox, a guide height that is published but never read.
 *
 * ── WHAT IS COVERED ──────────────────────────────────────────────────────
 *   §1  The geometry, EVALUATED: shell.css's base rules plus its max-width
 *       media blocks are resolved at 568 / 800 / 1099 / 1100 / 1440 and the
 *       main column's width is computed from the grid they produce. Pinned to
 *       LITERALS (the measured before/after), not to the stylesheet's own
 *       numbers.
 *   §2  The JS drawer query equals the CSS band that makes #sidebar a drawer.
 *   §3  createSidebarDrawer(), RUN against a recording fake DOM: every way in
 *       and out, and every click and Escape it must leave alone.
 *   §4  The guide's top dock: onboarding.js publishes the height, shell.css
 *       reads that same property in the same band, the default is defined,
 *       and closing removes it — the last one executed, not read.
 *   §5  Wiring: app.js binds the toggle on every rail rebuild; index.html
 *       carries the scrim and a programmatically focusable <main>.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { stripComments, functionSource, callSiteCount } from './test-helpers/source-scan.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NEXT = path.join(ROOT, 'src/public/next');
const read = (p) => readFileSync(path.join(NEXT, p), 'utf8');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.log('  ✗ ' + msg); }
}
const show = (v) => (v && typeof v === 'object' && 'tag' in v) ? `<${v.tag}>` : JSON.stringify(v);
function eq(a, b, msg) { ok(a === b, `${msg} (got ${show(a)}, expected ${show(b)})`); }
function section(t) { console.log('\n' + t); }

const shellCss = stripComments(read('shell.css'));
const obCss = stripComments(read('views/onboarding.css'));

// ── A small cascade evaluator over one stylesheet ──────────────────────────
// Top-level rules and `@media (max-width: Npx)` blocks only — which is all the
// shell's layout uses. Anything else (prefers-reduced-motion, @keyframes) is
// skipped, not misread.
function parseSheet(css) {
  const rules = []; // { media: number|null, sel, body }
  let i = 0;
  const readBlock = (from) => { // returns [inner, endIndex] for the { at `from`
    let depth = 0;
    for (let j = from; j < css.length; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') { depth--; if (depth === 0) return [css.slice(from + 1, j), j + 1]; }
    }
    throw new Error('unbalanced braces');
  };
  const pushRules = (inner, media) => {
    const re = /([^{}]+)\{([^{}]*)\}/g; let m;
    while ((m = re.exec(inner))) {
      for (const sel of m[1].split(',').map((s) => s.trim()).filter(Boolean)) rules.push({ media, sel, body: m[2] });
    }
  };
  while (i < css.length) {
    const brace = css.indexOf('{', i);
    if (brace === -1) break;
    const prelude = css.slice(i, brace).trim();
    const [inner, end] = readBlock(brace);
    if (prelude.startsWith('@media')) {
      const mw = /^@media\s*\(\s*max-width:\s*(\d+)px\s*\)$/.exec(prelude);
      if (mw) pushRules(inner, Number(mw[1]));
    } else if (!prelude.startsWith('@')) {
      for (const sel of prelude.split(',').map((s) => s.trim()).filter(Boolean)) rules.push({ media: null, sel, body: inner });
    }
    i = end;
  }
  return rules;
}
const RULES = parseSheet(shellCss);

/** The winning value of `prop` on `sel` at viewport width `vw` (source order). */
function valueAt(sel, prop, vw) {
  let v = null;
  const re = new RegExp('(?:^|;)\\s*' + prop.replace(/[-]/g, '\\-') + '\\s*:\\s*([^;]+)');
  for (const r of RULES) {
    if (r.sel !== sel) continue;
    if (r.media !== null && vw > r.media) continue;
    const m = re.exec(r.body);
    if (m) v = m[1].trim();
  }
  return v;
}
/** Resolve a length expression to px at `vw`: px, var(), and the min()/calc() the shell uses. */
function px(expr, vw, depth = 0) {
  if (depth > 10) throw new Error('var() cycle: ' + expr);
  let e = expr.replace(/var\((--[a-z0-9-]+)\)/g, (_, name) => {
    const val = valueAt(':root', name, vw);
    if (val === null) throw new Error('undefined ' + name);
    return String(px(val, vw, depth + 1)) + 'px';
  });
  e = e.replace(/(\d+(?:\.\d+)?)vw/g, (_, n) => String((Number(n) * vw) / 100) + 'px');
  const js = e.replace(/(\d+(?:\.\d+)?)px/g, '$1').replace(/\bcalc\(/g, '(').replace(/\bmin\(/g, 'Math.min(').replace(/\bmax\(/g, 'Math.max(');
  if (!/^[\d\s.+\-*/(),]*$/.test(js.replace(/Math\.(min|max)/g, ''))) throw new Error('cannot evaluate ' + expr);
  return Function('"use strict"; return (' + js + ');')();
}
/** The main column's width at `vw`, computed from #app-shell's grid. */
function layoutAt(vw) {
  const cols = valueAt('#app-shell', 'grid-template-columns', vw).split(/\s+(?![^(]*\))/);
  const fixed = cols.filter((c) => c !== '1fr').map((c) => px(c, vw));
  const sidebarFixed = valueAt('.sidebar', 'position', vw) === 'fixed';
  return {
    columns: cols.length,
    main: vw - fixed.reduce((a, b) => a + b, 0),
    sidebarInGrid: !sidebarFixed,
    sidebarW: px('var(--app-sidebar-w)', vw),
    sidebarCol: px('var(--app-sidebar-col)', vw),
    guideTopDock: /var\(--guide-dock-h\)/.test(valueAt('body.guide-docked .main', 'margin-top', vw) || ''),
    guidePadRight: valueAt('body.guide-docked .main', 'padding-right', vw),
  };
}

// ═════════════════════════════════════════════════════════════════════════
section('§1  The geometry at each band, evaluated from shell.css');
// ═════════════════════════════════════════════════════════════════════════
{
  const w1440 = layoutAt(1440), w1100 = layoutAt(1100), w1099 = layoutAt(1099), w800 = layoutAt(800), w568 = layoutAt(568);
  // >= 1100: unchanged from before this release — 72 + 272 + main.
  eq(w1440.main, 1096, '1440: main column 1096px (unchanged)');
  eq(w1100.main, 756, '1100: main column 756px (unchanged — the full band starts here)');
  ok(w1440.sidebarInGrid && w1100.sidebarInGrid, '>= 1100: the sidebar is a grid column');
  ok(!w1440.guideTopDock && !w1100.guideTopDock, '>= 1100: the guide docks on the RIGHT, as before');
  // 800-1099: sidebar 240.
  eq(w1099.sidebarW, 240, '1099: the sidebar narrows to 240px');
  eq(w800.main, 488, '800: main column 488px (was 456)');
  ok(w800.sidebarInGrid, '800: still a grid column — the drawer band starts BELOW 800');
  ok(w800.guideTopDock && w1099.guideTopDock, '800-1099: the guide docks along the TOP (margin-top reads --guide-dock-h)');
  eq(w800.guidePadRight, '0', '...and the right-hand strip is released, not kept alongside');
  // < 800: drawer.
  ok(!w568.sidebarInGrid, '568: the sidebar leaves the grid (position: fixed — a drawer)');
  eq(w568.columns, 2, '568: #app-shell has two columns, so <main> cannot auto-place into a 0px one');
  eq(w568.main, 496, '568: main column 496px (was 224)');
  eq(w568.sidebarCol, 0, '568: --app-sidebar-col is 0, so the reader and the guide clip to the full column');
  ok(w568.sidebarW >= 240 && w568.sidebarW <= 300, `568: the drawer is ${w568.sidebarW}px — a real sidebar width`);
  ok(568 - 72 - w568.sidebarW >= 48, '568: the drawer leaves >= 48px of scrim to click away on');
  ok(layoutAt(360).sidebarW <= 360 - 72 - 48, '360: the drawer shrinks rather than covering the whole column');
  // Content box (main minus .main-inner's 28px sides) at the two reported widths.
  ok(w800.main - 56 >= 420 && w568.main - 56 >= 420,
    `the view's content box is >= 420px at 800 (${w800.main - 56}) and 568 (${w568.main - 56}); it was 197 and 74 with the guide open`);
  // Control: the evaluator can see a squeeze.
  const before = 800 - 72 - 272;
  ok(before < w800.main, `control: the pre-v3.76.0 geometry (${before}px at 800) evaluates narrower`);
}

// ═════════════════════════════════════════════════════════════════════════
section('§2  The JS drawer query is the CSS drawer band');
// ═════════════════════════════════════════════════════════════════════════
const drawerSrc = read('shared/sidebar-drawer.js');
const drawerMod = await import(path.join(NEXT, 'shared/sidebar-drawer.js'));
{
  const m = /^\(max-width:\s*(\d+)px\)$/.exec(drawerMod.DRAWER_MEDIA);
  ok(!!m, 'DRAWER_MEDIA is a max-width query');
  const n = m && Number(m[1]);
  eq(valueAt('.sidebar', 'position', n), 'fixed', `at ${n}px (the JS edge) shell.css makes #sidebar a drawer`);
  ok(valueAt('.sidebar', 'position', n + 1) !== 'fixed', `at ${n + 1}px it does not — the two edges are the same pixel`);
  eq(drawerMod.DRAWER_OPEN_CLASS, 'sidebar-open', 'the open class is `sidebar-open`');
  ok(new RegExp('body\\.' + drawerMod.DRAWER_OPEN_CLASS + '\\s+\\.sidebar\\s*\\{[^}]*visibility:\\s*visible').test(shellCss),
    'shell.css shows the drawer for exactly that class');
  ok(/\.sidebar\s*\{[^}]*visibility:\s*hidden/.test(shellCss),
    'and hides it otherwise with visibility (out of the tab order and the accessibility tree)');
}

// ═════════════════════════════════════════════════════════════════════════
section('§3  createSidebarDrawer(), run against a recording DOM');
// ═════════════════════════════════════════════════════════════════════════
// A tiny element with enough of the DOM for the module: attributes,
// classList, listeners, parent chain, and a selector matcher for compound
// selectors of tag / .class / [attr] / [attr="v"] / :not(simple).
function matchesSimple(el, sel) {
  const re = /(\.[\w-]+)|(\[[\w-]+(?:="[^"]*")?\])|(:not\(([^)]*)\))|(^[a-z]+)/g;
  let m, any = false;
  while ((m = re.exec(sel))) {
    any = true;
    if (m[1] && !el.classList.contains(m[1].slice(1))) return false;
    if (m[2]) {
      const a = /\[([\w-]+)(?:="([^"]*)")?\]/.exec(m[2]);
      if (!(a[1] in el.attrs)) return false;
      if (a[2] !== undefined && el.attrs[a[1]] !== a[2]) return false;
    }
    if (m[3] && matchesSimple(el, m[4])) return false;
    if (m[5] && el.tag !== m[5]) return false;
  }
  return any;
}
const matches = (el, list) => list.split(',').some((s) => matchesSimple(el, s.trim()));
function mk(tag, { cls = '', attrs = {}, parent = null } = {}) {
  const set = new Set(cls.split(/\s+/).filter(Boolean));
  const el = {
    tag, attrs: { ...attrs }, parent, children: [], listeners: {}, focused: 0,
    classList: {
      contains: (c) => set.has(c),
      toggle: (c, force) => { const on = force === undefined ? !set.has(c) : !!force; if (on) set.add(c); else set.delete(c); return on; },
    },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    addEventListener(t, fn, capture) { (this.listeners[t] ||= []).push({ fn, capture: !!capture }); },
    closest(sel) { for (let n = this; n; n = n.parent) if (matches(n, sel)) return n; return null; },
    querySelector(sel) {
      const walk = (n) => { for (const c of n.children) { if (matches(c, sel)) return c; const r = walk(c); if (r) return r; } return null; };
      return walk(this);
    },
    focus() { this.focused++; doc.activeElement = this; },
  };
  if (parent) parent.children.push(el);
  return el;
}
function fire(el, type, extra = {}) {
  let stopped = false;
  const ev = { type, target: el, defaultPrevented: false, key: extra.key, stopPropagation() { stopped = true; }, preventDefault() { this.defaultPrevented = true; } };
  for (const l of (el.listeners[type] || [])) l.fn(ev);
  return { stopped };
}
let doc;
function build({ narrow = true } = {}) {
  const html = mk('html');
  const body = mk('body', { parent: html });
  doc = {
    body, activeElement: null, listeners: {},
    addEventListener(t, fn, capture) { (this.listeners[t] ||= []).push({ fn, capture: !!capture }); },
    querySelector: (sel) => html.querySelector(sel),
  };
  const rail = mk('nav', { parent: body });
  const toggle = mk('button', { cls: 'rail-btn rail-sidebar-toggle', attrs: { id: 'rail-sidebar-toggle' }, parent: rail });
  const sidebar = mk('aside', { cls: 'sidebar', attrs: { id: 'sidebar' }, parent: body });
  const scrim = mk('div', { cls: 'sidebar-scrim', parent: body });
  const main = mk('main', { cls: 'main', attrs: { id: 'main', tabindex: '-1' }, parent: body });
  const primary = mk('button', { cls: 'btn btn-primary', parent: sidebar });
  const filter = mk('input', { parent: sidebar });
  const list = mk('div', { cls: 'cur-sb-list', parent: sidebar });
  const row = mk('button', { cls: 'cur-sb-row', parent: list });
  const rowName = mk('span', { cls: 'cur-sb-name', parent: row });
  const trash = mk('button', { cls: 'row-act', parent: list });
  // Chat puts the trash BESIDE its row; a row that carries its own action
  // INSIDE it must be left alone just the same (the .row-act exclusion).
  const wrapRow = mk('div', { cls: 'cur-sb-row', parent: list });
  const nestedTrash = mk('button', { cls: 'row-act', parent: wrapRow });
  const selList = mk('div', { cls: 'chat-conv-list row-select-mode', parent: sidebar });
  const selRow = mk('div', { cls: 'cur-sb-row', parent: selList });
  const plain = mk('div', { cls: 'sidebar-title', parent: sidebar });
  const mqListeners = [];
  const mq = { matches: narrow, addEventListener: (t, fn) => mqListeners.push(fn) };
  const win = { matchMedia: (q) => { mq.query = q; return mq; } };
  const d = drawerMod.createSidebarDrawer({ document: doc, window: win, sidebar, scrim, main });
  d.bindToggle(toggle);
  const click = (el) => { for (let n = el; n; n = n.parent) for (const l of (n.listeners.click || [])) l.fn({ target: el }); };
  const key = (k) => {
    let stopped = false;
    const ev = { key: k, defaultPrevented: false, stopPropagation() { stopped = true; } };
    for (const l of (doc.listeners.keydown || [])) l.fn(ev);
    return { stopped, capture: (doc.listeners.keydown || []).every((l) => l.capture) };
  };
  const setNarrow = (v) => { mq.matches = v; mqListeners.forEach((f) => f()); };
  return { d, body, toggle, sidebar, scrim, main, primary, filter, row, rowName, trash, nestedTrash, selRow, plain, html, mq, click, key, setNarrow };
}
const isOpen = (t) => t.body.classList.contains('sidebar-open');

{
  const t = build();
  eq(t.mq.query, drawerMod.DRAWER_MEDIA, 'the drawer asks matchMedia for its own band');
  eq(t.toggle.getAttribute('aria-controls'), 'sidebar', 'the toggle controls #sidebar');
  eq(t.toggle.getAttribute('aria-expanded'), 'false', 'it starts collapsed');
  eq(t.toggle.getAttribute('aria-label'), 'Show sidebar', 'and names the action it will take');

  t.click(t.toggle);
  ok(isOpen(t), 'a toggle click opens the drawer (body.sidebar-open)');
  eq(t.toggle.getAttribute('aria-expanded'), 'true', 'aria-expanded follows');
  eq(t.toggle.getAttribute('aria-label'), 'Hide sidebar', 'and the name flips to the action it will take now');
  eq(doc.activeElement, t.primary, 'focus moves to the first control in the drawer');
  t.click(t.toggle);
  ok(!isOpen(t), 'a second toggle click closes it');

  // Escape
  t.click(t.toggle);
  const k = t.key('Escape');
  ok(!isOpen(t), 'Escape closes the drawer');
  eq(doc.activeElement, t.toggle, 'and returns focus to the toggle');
  ok(k.stopped && k.capture, 'in the capture phase, stopping it — so the reader underneath is not ALSO closed');
  const k2 = t.key('Escape');
  ok(!k2.stopped, 'Escape with the drawer closed is left alone entirely');

  // Escape yields to an open popup and to a dialog — but not to the reader.
  t.click(t.toggle);
  const lb = mk('button', { attrs: { 'aria-haspopup': 'listbox', 'aria-expanded': 'true' }, parent: t.sidebar });
  t.key('Escape');
  ok(isOpen(t), 'Escape while a listbox is open (Chat\'s domain filter, IN the drawer) leaves the drawer open');
  lb.attrs['aria-expanded'] = 'false';
  const dlg = mk('div', { cls: 'cfd-card', attrs: { 'aria-modal': 'true' }, parent: t.body });
  t.key('Escape');
  ok(isOpen(t), 'Escape while a confirm dialog is open leaves the drawer open');
  dlg.attrs['aria-modal'] = 'false';
  mk('div', { cls: 'reader-panel', attrs: { 'aria-modal': 'true' }, parent: t.body });
  t.key('Escape');
  ok(!isOpen(t), 'but the page reader (UNDER the drawer) does not hold Escape — the drawer closes');

  // Scrim
  t.click(t.toggle); t.click(t.scrim);
  ok(!isOpen(t), 'a click on the scrim closes it');

  // Choosing vs not choosing
  const stays = [['a row\'s trash', t.trash], ['a trash nested INSIDE a row', t.nestedTrash], ['the filter field', t.filter], ['a row in Select mode', t.selRow], ['plain sidebar text', t.plain]];
  for (const [what, el] of stays) {
    t.click(t.toggle); t.click(el);
    ok(isOpen(t), `a click on ${what} leaves the drawer open`);
    t.click(t.toggle);
  }
  t.click(t.toggle); t.main.focused = 0; t.click(t.rowName);
  ok(!isOpen(t), 'a click on a sidebar ROW (on its name, inside the button) closes the drawer');
  ok(t.main.focused === 1 && doc.activeElement === t.main, 'and hands focus to the main column, where the choice appeared');
  t.click(t.toggle); t.click(t.primary);
  ok(!isOpen(t), 'the sidebar\'s primary button (New chat / New domain / New project) closes it too');

  // Widening out of drawer mode
  t.click(t.toggle);
  t.setNarrow(false);
  ok(!isOpen(t), 'widening past the band closes the drawer');
  eq(t.toggle.getAttribute('aria-expanded'), 'false', 'and the toggle says so');
  t.setNarrow(true);
  ok(!isOpen(t), 'narrowing again starts CLOSED — no drawer nobody asked for');

  // A rail rebuild hands over a new toggle.
  const t2 = mk('button', { cls: 'rail-btn rail-sidebar-toggle', parent: t.body });
  t.d.bindToggle(t2);
  eq(t2.getAttribute('aria-controls'), 'sidebar', 'a rebuilt toggle is wired (aria-controls)');
  t.click(t2);
  ok(isOpen(t) && t2.getAttribute('aria-expanded') === 'true', 'and drives the same drawer');
}
{
  const t = build({ narrow: false });
  t.click(t.toggle);
  ok(!isOpen(t), 'on a WIDE window the toggle cannot open a drawer (the sidebar is already a grid column)');
  eq(t.toggle.getAttribute('aria-expanded'), 'false', '...and never claims to have');
}
// Control: the fake matcher is not vacuous.
{
  const t = build();
  ok(drawerMod.isChoosingClick(t.rowName) && !drawerMod.isChoosingClick(t.trash) && !drawerMod.isChoosingClick(null),
    'control: isChoosingClick tells a row from its trash, and survives null');
}

// ═════════════════════════════════════════════════════════════════════════
section('§4  The guide\'s top dock — publish, read, default, remove');
// ═════════════════════════════════════════════════════════════════════════
{
  const obSrc = read('views/onboarding.js');
  const obCode = stripComments(obSrc);
  const varName = (/const DOCK_H_VAR = '(--[a-z0-9-]+)';/.exec(obCode) || [])[1];
  ok(!!varName, 'onboarding.js names the height property it publishes');
  ok(new RegExp('\\' + varName + '\\s*:\\s*0px').test(shellCss), `shell.css defines ${varName} with a 0px default (never undefined)`);
  ok(/var\(--guide-dock-h\)/.test(valueAt('body.guide-docked .main', 'margin-top', 800) || ''),
    'and the narrow band reads that SAME property as the main column\'s margin-top');
  eq(varName, '--guide-dock-h', 'the published name and the read name are one name');
  // Same breakpoint on both sides of the handshake.
  const obNarrow = /@media\s*\(\s*max-width:\s*(\d+)px\s*\)\s*\{[^{}]*\.obp-panel\s*\{[^}]*width:\s*100%/.exec(obCss);
  ok(!!obNarrow, 'onboarding.css widens the card to the column in a max-width band');
  ok(!!obNarrow && layoutAt(Number(obNarrow[1])).guideTopDock && !layoutAt(Number(obNarrow[1]) + 1).guideTopDock,
    `and that band's edge (${obNarrow && obNarrow[1]}px) is the shell's top-dock edge exactly`);
  ok(/\.obp-panel\s*\{[^}]*max-height:\s*45vh/.test(obCss.slice(obNarrow ? obNarrow.index : 0)),
    'the top-docked card is capped at 45vh, so the view always keeps most of the window');
  // EXECUTE watch/unwatch against a fake document.
  const watchSrc = functionSource(obCode, 'watchDockHeight');
  const unwatchSrc = functionSource(obCode, 'unwatchDockHeight');
  ok(!!watchSrc && !!unwatchSrc, 'both functions extract');
  const props = new Map();
  const fakeDoc = { documentElement: { style: { setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k) } } };
  let observed = null, disconnected = 0, roCb = null;
  class FakeRO { constructor(cb) { roCb = cb; } observe(el) { observed = el; } disconnect() { disconnected++; } }
  const run = new Function('document', 'ResizeObserver',
    `const DOCK_H_VAR = ${JSON.stringify(varName)}; let dockHeightObserver = null;\n${watchSrc}\n${unwatchSrc}\nreturn { watchDockHeight, unwatchDockHeight };`);
  const api = run(fakeDoc, FakeRO);
  let h = 263.2;
  const el = { getBoundingClientRect: () => ({ height: h }) };
  api.watchDockHeight(el);
  eq(props.get('--guide-dock-h'), '264px', 'opening publishes the wrapper height, rounded UP (never a 1px overlap)');
  ok(observed === el, 'and keeps watching it');
  h = 180; roCb();
  eq(props.get('--guide-dock-h'), '180px', 'a resize (a step ticks, text re-wraps) republishes');
  api.unwatchDockHeight();
  ok(!props.has('--guide-dock-h'), 'closing REMOVES the property, so the shell\'s 0px default restores the layout exactly');
  eq(disconnected, 1, 'and disconnects the observer');
  ok(callSiteCount(obSrc, 'watchDockHeight', { within: 'openPanel' }) === 1, 'openPanel() starts the watch');
  ok(callSiteCount(obSrc, 'unwatchDockHeight', { within: 'closePanel' }) === 1, 'closePanel() ends it');
}

// ═════════════════════════════════════════════════════════════════════════
section('§5  Wiring — app.js, index.html');
// ═════════════════════════════════════════════════════════════════════════
{
  const appSrc = read('app.js');
  ok(callSiteCount(appSrc, 'sidebarDrawer', { within: 'renderRail' }) === 1,
    'renderRail() hands the drawer its (new) toggle on every rebuild');
  ok(/createSidebarDrawer\(/.test(functionSource(stripComments(appSrc), 'sidebarDrawer') || ''),
    'sidebarDrawer() creates the one drawer instance');
  const html = read('index.html');
  ok(/<div class="sidebar-scrim" id="sidebar-scrim"/.test(html), 'index.html carries the scrim');
  ok(html.indexOf('id="sidebar"') < html.indexOf('id="sidebar-scrim"') && html.indexOf('id="sidebar-scrim"') < html.indexOf('id="main"'),
    'between the sidebar and <main>, so the tab order stays rail -> sidebar -> main');
  ok(/<main[^>]*id="main"[^>]*tabindex="-1"/.test(html), '<main> is focusable by script only (tabindex -1), not a tab stop');
  ok(/import \{ createSidebarDrawer \} from '\.\/shared\/sidebar-drawer\.js'/.test(appSrc), 'app.js imports the module');
  ok(!/\bdocument\b|\bwindow\b/.test(stripComments(drawerSrc).replace(/env\.(document|window)/g, '')),
    'shared/sidebar-drawer.js touches no global document/window — everything through env');
}

console.log(`\nPassed: ${passed}   Failed: ${failed}`);
if (failed) { console.log('❌ sidebar-drawer assertions FAILED'); process.exit(1); }
console.log('All sidebar-drawer assertions green');
