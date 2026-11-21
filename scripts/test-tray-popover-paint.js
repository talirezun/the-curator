#!/usr/bin/env node
/**
 * test-tray-popover-paint.js — OFFLINE guard for the Windows tray popover's
 * PAGE (P3, v4.1.0): src/public/next/tray-popover.html and its painter,
 * src/public/next/views/tray-popover-paint.js.
 *
 * The painter is a CLASSIC script (ES modules over file:// are not trusted), so
 * this suite runs the real file inside a `vm` context with a minimal fake DOM
 * and a fake `window.curatorTray` (the preload API in CONTRACT-tray-popover.md
 * §3), and drives it with payloads shaped exactly as the contract's §1.
 *
 * What it proves:
 *   §1  the page itself: a strict CSP, no remote font, a classic relative script,
 *       relative stylesheet refs, the two mount points;
 *   §2  boot: inert without the preload; with it, onModel is registered;
 *   §3  payload → nodes + ARIA (menu / menuitem / separator, aria-disabled,
 *       aria-haspopup, names = label + sublabel, images as data: srcsets);
 *   §4  escape-first: a label of `<img src=x onerror=…>` stays TEXT (no element
 *       is created from model text, innerHTML is never touched);
 *   §5  every action id is clickable and calls act(currentGen, id), nothing else
 *       calls act, drills never reach main;
 *   §6  drill-in and back (Details only on drill pages, focus returns to the
 *       row that opened the page), live-region announcements;
 *   §7  the key map (Up/Down wrap, Home/End, Right/Enter drill, Left/Backspace
 *       back, Esc back-then-dismiss, Ctrl/Alt ignored);
 *   §8  theme from the payload (data-theme), invalid payloads ignored;
 *   §9  a new payload: stay on the page only when it exists with the same
 *       title (contract §1), and a stale node never acts;
 *   §10 size() and painted() are reported.
 * Each guard that matters is proved by MUTATION in §M: the source is mutated in
 * memory and the same check must go red.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PAINT = path.join(ROOT, 'src/public/next/views/tray-popover-paint.js');
const HTML = path.join(ROOT, 'src/public/next/tray-popover.html');
const SRC = readFileSync(PAINT, 'utf8');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function section(t) { console.log(`\n${t}`); }

// ── A minimal fake DOM ─────────────────────────────────────────────────────
// Only what the painter uses. `innerHTML`/`outerHTML`/`insertAdjacentHTML` are
// TRAPS: any write is recorded, so §4 can prove they are never used.
class FakeEl {
  constructor(doc, tag) {
    this.ownerDocument = doc;
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attrs = new Map();
    this.listeners = new Map();
    this._text = '';
    this.style = { props: new Map(), setProperty(k, v) { this.props.set(k, v); } };
    this.scrollHeight = 0;
  }
  setAttribute(k, v) { this.attrs.set(String(k), String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  removeAttribute(k) { this.attrs.delete(k); }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; }
  replaceChildren(...nodes) { for (const c of this.children) c.parentNode = null; this.children = []; for (const n of nodes) this.appendChild(n); }
  get textContent() { return this.children.length ? this.children.map(c => c.textContent).join('') : this._text; }
  set textContent(v) { for (const c of this.children) c.parentNode = null; this.children = []; this._text = String(v); }
  set innerHTML(v) { this.ownerDocument.htmlWrites.push(String(v)); }
  get innerHTML() { return ''; }
  set outerHTML(v) { this.ownerDocument.htmlWrites.push(String(v)); }
  insertAdjacentHTML(_p, v) { this.ownerDocument.htmlWrites.push(String(v)); }
  get className() { return this.getAttribute('class') || ''; }
  classes() { return this.className.split(/\s+/).filter(Boolean); }
  hasClass(c) { return this.classes().includes(c); }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
  dispatch(type, ev = {}) { for (const fn of this.listeners.get(type) || []) fn(ev); }
  click() { this.dispatch('click', { type: 'click' }); }
  focus() { this.ownerDocument.activeElement = this; this.ownerDocument.focusLog.push(this); }
  scrollIntoView() {}
  getBoundingClientRect() { return { height: this.rectHeight || 0 }; }
  walk(fn) { fn(this); for (const c of this.children) c.walk(fn); }
  all(pred) { const out = []; this.walk(e => { if (pred(e)) out.push(e); }); return out; }
}
class FakeDoc {
  constructor() {
    this.htmlWrites = [];
    this.focusLog = [];
    this.listeners = new Map();
    this.documentElement = new FakeEl(this, 'html');
    this.body = new FakeEl(this, 'body');
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
    this.pop = new FakeEl(this, 'div'); this.pop.setAttribute('id', 'pop');
    this.live = new FakeEl(this, 'div'); this.live.setAttribute('id', 'pop-live');
    this.body.appendChild(this.pop); this.body.appendChild(this.live);
    this.created = [];
  }
  createElement(tag) { const e = new FakeEl(this, tag); this.created.push(e); return e; }
  getElementById(id) { return this.documentElement.all(e => e.getAttribute('id') === id)[0] || null; }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
  key(key, mods = {}) {
    const ev = { key, ...mods, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    for (const fn of this.listeners.get('keydown') || []) fn(ev);
    return ev;
  }
}

function fakeApi() {
  const api = {
    cb: null, acts: [], sizes: [], paintedLog: [], dismissed: 0,
    onModel(cb) { api.cb = cb; },
    act(gen, id) { api.acts.push([gen, id]); return Promise.resolve(true); },
    size(h) { api.sizes.push(h); },
    painted(gen, rows) { api.paintedLog.push([gen, rows]); },
    dismiss() { api.dismissed++; },
  };
  return api;
}

/** Run the painter source in a fresh context. `withApi` false = a plain browser. */
function load(src = SRC, { withApi = true } = {}) {
  const doc = new FakeDoc();
  const api = withApi ? fakeApi() : null;
  const winListeners = new Map();
  const win = {
    document: doc,
    addEventListener(t, fn) { if (!winListeners.has(t)) winListeners.set(t, []); winListeners.get(t).push(fn); },
  };
  if (api) win.curatorTray = api;
  win.window = win;
  const ctx = vm.createContext(win);
  vm.runInContext(src, ctx, { filename: 'tray-popover-paint.js' });
  const send = (p) => { api.cb(JSON.parse(JSON.stringify(p))); };
  const fireWin = (t) => { for (const fn of winListeners.get(t) || []) fn({}); };
  return { doc, api, win, send, fireWin, paint: win.CuratorTrayPaint };
}

// ── Payload fixtures, shaped as CONTRACT-tray-popover.md §1 ─────────────────
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const img = (kind, w, h, tier = null) => ({ kind, tier, w, h, sources: [{ density: 1, url: PNG }, { density: 2, url: PNG }, { density: 3, url: PNG }] });
function payload(gen = 7, theme = 'dark', o = {}) {
  const label1 = o.projectLabel || 'ott · Claude Code · 8 min ago';
  return {
    v: 1, gen, theme, root: 'root',
    pages: {
      root: { id: 'root', parent: null, title: null, subtitle: null, details: [], rows: [
        { kind: 'drill', key: 'k0', drill: 'p:0', label: '7 days · 192 saves · Claude Code', sublabel: null, img: img('strip', 110, 30) },
        { kind: 'separator', key: 'k1' },
        { kind: 'header', key: 'k2', label: 'Active · last 24 h' },
        { kind: 'drill', key: 'k3', drill: 'p:1', label: label1, sublabel: 'opus-5.5 — v1.3.0 shipped', img: img('dot', 13, 13, 'recent') },
        { kind: 'statement', key: 'k3s', label: 'Two agent tools are writing ott · main.', sublabel: null, img: null },
        { kind: 'separator', key: 'k9' },
        { kind: 'drill', key: 'k9k', drill: 'p:2', label: 'Knowledge · 2 domains', sublabel: null, img: null },
        { kind: 'action', key: 'k10', id: 'tray-open-memory', label: 'Open Project Context…', sublabel: null, img: null },
        { kind: 'action', key: 'k11', id: 'tray-open-app', label: 'Open The Curator', sublabel: null, img: null },
        { kind: 'action', key: 'k12', id: 'tray-open-settings', label: 'Settings…', sublabel: null, img: null },
        { kind: 'stamp', key: 'k14', label: 'Updated 13:37' },
        { kind: 'separator', key: 'k15' },
        { kind: 'action', key: 'k16', id: 'tray-quit', label: 'Quit The Curator', sublabel: null, img: null },
      ] },
      'p:0': { id: 'p:0', parent: 'root', title: '7 days · 192 saves · Claude Code', subtitle: null, rows: [
        { kind: 'action', key: 'k20', id: 'tray-pulse-open', label: 'Open Project Context…', sublabel: null, img: null },
        { kind: 'statement', key: 'k21', label: 'Claude Code · 150 saves', sublabel: null, img: img('strip', 110, 30) },
      ], details: [{ label: null, lines: ['Saves per 12 hours, oldest on the left.', '192 saves in 7 days.'] }] },
      'p:1': { id: 'p:1', parent: 'root', title: label1, subtitle: 'opus-5.5 — v1.3.0 shipped', rows: [
        { kind: 'header', key: 'k4', label: 'projects / ott · main' },
        { kind: 'action', key: 'k5', id: 'tray-row-0:open', label: 'Open in The Curator', sublabel: null, img: null },
        { kind: 'action', key: 'k8', id: 'tray-row-0:reveal', label: 'Show current.md in File Explorer', sublabel: null, img: null },
        { kind: 'drill', key: 'k8o', drill: 'p:3', label: 'Other work-streams', sublabel: null, img: null },
      ], details: [{ label: null, lines: ['ott · main', 'machine: pc-1a2b3c', 'written: 21 Nov 2026, 13:37'] },
        { label: 'Open in The Curator', lines: ['Opens the project page.'] }] },
      'p:2': { id: 'p:2', parent: 'root', title: 'Knowledge · 2 domains', subtitle: null, rows: [
        { kind: 'header', key: 'k30', label: 'Domains · pages' },
        { kind: 'statement', key: 'k31', label: 'notes · 687 pages', sublabel: null, img: img('bar', 22, 4) },
        { kind: 'statement', key: 'k32', label: 'research · 212 pages', sublabel: null, img: img('bar', 22, 4) },
      ], details: [] },
      'p:3': { id: 'p:3', parent: 'p:1', title: 'Other work-streams', subtitle: null, rows: [
        { kind: 'action', key: 'k40', id: 'tray-row-1:open', label: 'ott · tests', sublabel: null, img: null },
      ], details: [] },
    },
  };
}

// helpers over the painted tree
const menuOf = (doc) => doc.pop.all(e => e.getAttribute('role') === 'menu')[0];
const items = (doc) => doc.pop.all(e => e.getAttribute('role') === 'menuitem');
const byLabel = (doc, label) => items(doc).find(e => e.all(x => x.hasClass('pop-label'))[0]?.textContent === label);
const shownTexts = (doc) => doc.pop.all(e => e.children.length === 0 && e._text).map(e => e._text);

// ═══════════════════════════════════════════════════════════════════════════
section('§1 the page: CSP, no remote font, a classic relative script');
{
  const html = readFileSync(HTML, 'utf8');
  const noComments = html.replace(/<!--[\s\S]*?-->/g, '');
  const csp = (/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i.exec(noComments) || [])[1] || '';
  const dirs = Object.fromEntries(csp.split(';').map(s => s.trim()).filter(Boolean).map(s => {
    const [k, ...v] = s.split(/\s+/); return [k, v.join(' ')];
  }));
  ok(dirs['default-src'] === "'none'", "CSP default-src 'none'");
  ok(dirs['script-src'] === "'self'", "CSP script-src 'self' only (no inline, no eval)");
  ok(dirs['style-src'] === "'self'", "CSP style-src 'self' only (no inline <style>/style=)");
  ok(dirs['img-src'] === 'data:', 'CSP img-src data: only');
  ok(!('connect-src' in dirs) && !('font-src' in dirs), 'CSP grants no connect-src and no font-src (default none)');
  ok(!/fonts\.css|fonts\.googleapis|https?:\/\//i.test(noComments), 'no remote URL and no tokens/fonts.css in the markup');
  const scripts = [...noComments.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  ok(scripts.length === 1 && /src="views\/tray-popover-paint\.js"/.test(scripts[0][1]) && scripts[0][2].trim() === '',
    'exactly one script: views/tray-popover-paint.js, relative, empty body (no inline script)');
  ok(!/type\s*=\s*"module"/i.test(scripts[0]?.[1] || ''), 'the script is CLASSIC (no type="module" over file://)');
  ok(!/<style\b/i.test(noComments) && !/\sstyle\s*=/i.test(noComments), 'no inline <style> and no style= attribute');
  const hrefs = [...noComments.matchAll(/<link\b[^>]*href="([^"]+)"/gi)].map(m => m[1]);
  ok(hrefs.length >= 2 && hrefs.every(h => !h.startsWith('/') && !/^[a-z]+:/i.test(h)), 'every stylesheet ref is relative');
  ok(hrefs.includes('views/tray-popover.css') && hrefs.includes('tokens/color.css'), 'links the tokens and views/tray-popover.css');
  ok(/id="pop"/.test(noComments) && /id="pop-live"[^>]*aria-live="polite"/.test(noComments), 'mount #pop and a polite live region #pop-live');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2 boot');
{
  const plain = load(SRC, { withApi: false });
  ok(plain.paint && plain.paint.instance === null, 'without window.curatorTray the page is INERT (no instance)');
  ok(plain.doc.pop.children.length === 0, 'and nothing is drawn');
  const t = load();
  ok(typeof t.api.cb === 'function', 'with the preload, onModel(cb) is registered at boot');
  ok(t.doc.pop.children.length === 0, 'nothing is drawn before the first payload');
  ok((t.doc.listeners.get('keydown') || []).length === 1, 'one keydown listener on the document');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3 payload → nodes + ARIA');
{
  const t = load();
  t.send(payload());
  const menu = menuOf(t.doc);
  ok(!!menu, 'root is painted as role="menu"');
  ok(menu.getAttribute('aria-label') === 'The Curator', 'the root menu is named "The Curator"');
  const its = items(t.doc);
  const rootRows = payload().pages.root.rows.filter(r => r.kind !== 'separator');
  ok(its.length === rootRows.length, `every non-separator row is a menuitem (${its.length} of ${rootRows.length})`);
  ok(its.map(e => e.getAttribute('data-key')).join() === rootRows.map(r => r.key).join(), 'in payload order');
  ok(menu.all(e => e.getAttribute('role') === 'separator').length === 3, 'separators are role="separator"');
  const proj = byLabel(t.doc, 'ott · Claude Code · 8 min ago');
  ok(proj && proj.getAttribute('aria-haspopup') === 'menu', 'a drill row has aria-haspopup="menu"');
  ok(proj && proj.getAttribute('aria-label') === 'ott · Claude Code · 8 min ago, opus-5.5 — v1.3.0 shipped', 'its name is label + sublabel');
  ok(proj && proj.hasClass('pop-row--two') && proj.all(e => e.hasClass('pop-sub'))[0]?.textContent === 'opus-5.5 — v1.3.0 shipped',
    'a row with a sublabel is a two-line row with the second line in .pop-sub');
  ok(proj && proj.all(e => e.hasClass('pop-chev')).length === 1, 'a drill row carries a chevron');
  for (const label of ['Two agent tools are writing ott · main.', 'Active · last 24 h', 'Updated 13:37']) {
    const e = byLabel(t.doc, label);
    ok(e && e.getAttribute('aria-disabled') === 'true', `"${label}" is aria-disabled (statement/header/stamp)`);
  }
  const quit = byLabel(t.doc, 'Quit The Curator');
  ok(quit && !quit.hasAttribute('aria-disabled') && !quit.hasAttribute('aria-haspopup'), 'an action row is a plain enabled menuitem');
  const imgs = t.doc.pop.all(e => e.tagName === 'IMG');
  ok(imgs.length === 2, 'the strip and the dot are painted as <img> (2)');
  const strip = imgs.find(e => e.hasClass('pop-img--strip'));
  ok(strip && strip.getAttribute('width') === '110' && strip.getAttribute('height') === '30', 'the strip is drawn at the payload\'s 2x size (110×30)');
  ok(strip && strip.getAttribute('src') === PNG && strip.getAttribute('srcset') === `${PNG} 1x, ${PNG} 2x, ${PNG} 3x`,
    'src = sources[0].url, srcset = every source with its density');
  ok(imgs.every(e => e.getAttribute('alt') === ''), 'images are decorative (alt="": the label carries the fact)');
  ok(t.doc.pop.all(e => e.hasClass('pop-details')).length === 0, 'root shows NO Details block (D7)');
  ok(t.doc.activeElement === its[0], 'focus lands on the first row');
  ok(its.filter(e => e.getAttribute('tabindex') === '0').length === 1, 'exactly one row is in the tab order (roving tabindex)');
  // Hostile image URLs never reach <img>.
  const p = payload(); p.pages.root.rows[0].img.sources = [{ density: 1, url: 'https://evil.example/x.png' }, { density: 2, url: 'javascript:alert(1)' }];
  const t2 = load(); t2.send(p);
  ok(t2.doc.pop.all(e => e.tagName === 'IMG' && e.hasClass('pop-img--strip')).length === 0, 'a non-data:image/png source is never painted');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4 escape-first: model text is text');
const XSS = '<img src=x onerror="window.pwned=1">';
function escapeCheck(src) {
  const t = load(src);
  const p = payload(7, 'dark', { projectLabel: XSS });
  p.pages.root.rows[7].label = '<b>bold</b>';
  p.pages['p:1'].details[0].lines.push('<script>x()</script>');
  t.send(p);
  const createdImgsBefore = t.doc.created.filter(e => e.tagName === 'IMG').length;
  const rootTexts = shownTexts(t.doc);
  byLabel(t.doc, XSS)?.click();
  return { t, createdImgsBefore, rootTexts, texts: shownTexts(t.doc) };
}
{
  const { t, createdImgsBefore, rootTexts, texts } = escapeCheck(SRC);
  ok(t.doc.htmlWrites.length === 0, 'innerHTML / outerHTML / insertAdjacentHTML are never written');
  ok(createdImgsBefore === 2, 'only the two payload images became <img> elements (the label made none)');
  ok(rootTexts.includes('<b>bold</b>'), 'a label of "<b>bold</b>" is shown as those exact characters');
  ok(rootTexts.includes(XSS), 'the <img onerror> label is literal text on root');
  ok(texts.includes(XSS), 'the <img onerror> label is shown as literal text on the drill page');
  ok(texts.includes('<script>x()</script>'), 'a Details line of <script> is literal text');
  ok(t.win.pwned === undefined, 'nothing ran');
  ok(!/\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|document\.write/.test(SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')),
    'the painter source contains no HTML-string sink at all');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5 every action id is clickable and calls act(currentGen, id)');
{
  const t = load();
  const p = payload(7);
  t.send(p);
  const pageActions = (pid) => p.pages[pid].rows.filter(r => r.kind === 'action');
  for (const r of pageActions('root')) byLabel(t.doc, r.label).click();
  ok(JSON.stringify(t.api.acts) === JSON.stringify(pageActions('root').map(r => [7, r.id])),
    'each root action calls act(7, its id), once, in order');
  // every action on every page, reached by drilling
  const allIds = [];
  for (const [pid, pg] of Object.entries(p.pages)) for (const r of pg.rows) if (r.kind === 'action') allIds.push([pid, r.id, r.label]);
  const t2 = load(); t2.send(p);
  const reached = new Set();
  const path_ = { 'p:0': ['p:0'], 'p:1': ['p:1'], 'p:2': ['p:2'], 'p:3': ['p:1', 'p:3'], root: [] };
  for (const [pid, id, label] of allIds) {
    t2.send({ ...p, gen: p.gen });                   // same payload: back to root
    while (t2.paint.instance.state().pageId !== 'root') t2.paint.instance.back();
    for (const step of path_[pid]) {
      const drillRow = items(t2.doc).find(e => {
        const pg = p.pages[t2.paint.instance.state().pageId];
        const r = pg.rows.find(x => x.key === e.getAttribute('data-key'));
        return r && r.kind === 'drill' && r.drill === step;
      });
      drillRow.click();
    }
    const before = t2.api.acts.length;
    const row = items(t2.doc).find(e => e.getAttribute('data-key') === p.pages[pid].rows.find(r => r.id === id).key);
    row.click();
    if (t2.api.acts.length === before + 1 && t2.api.acts.at(-1)[0] === 7 && t2.api.acts.at(-1)[1] === id) reached.add(id);
  }
  ok(reached.size === allIds.length, `every action id on every page is clickable and calls act(7, id) (${reached.size}/${allIds.length})`);
  // drills, statements, headers, stamps never call act
  const t3 = load(); t3.send(p);
  for (const label of ['Active · last 24 h', 'Two agent tools are writing ott · main.', 'Updated 13:37']) byLabel(t3.doc, label).click();
  byLabel(t3.doc, 'Knowledge · 2 domains').click();
  ok(t3.api.acts.length === 0, 'headers, statements, stamps and drills never call act (a drill stays local)');
  ok(t3.paint.instance.state().pageId === 'p:2', 'the drill opened its page locally');
  // a newer generation: the click carries the NEW gen
  const t4 = load(); t4.send(payload(7)); t4.send(payload(8));
  byLabel(t4.doc, 'Open The Curator').click();
  ok(JSON.stringify(t4.api.acts) === JSON.stringify([[8, 'tray-open-app']]), 'after gen 8 arrives, a press sends gen 8 (the current one)');
  // Enter on an action
  const t5 = load(); t5.send(payload(3));
  t5.doc.key('End'); t5.doc.key('Enter');
  ok(JSON.stringify(t5.api.acts) === JSON.stringify([[3, 'tray-quit']]), 'End then Enter sends act(3, "tray-quit")');
  // A row with an invalid id is not painted as pressable.
  const bad = payload(4); bad.pages.root.rows.push({ kind: 'action', key: 'kx', id: 'x'.repeat(201), label: 'Too long', sublabel: null, img: null });
  const t6 = load(); t6.send(bad);
  ok(!byLabel(t6.doc, 'Too long'), 'an action whose id is over 200 characters is not painted');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§6 drill-in and back');
{
  const t = load(); t.send(payload());
  const pop = t.paint.instance;
  byLabel(t.doc, 'ott · Claude Code · 8 min ago').click();
  ok(pop.state().pageId === 'p:1', 'a drill row opens its page');
  const back = items(t.doc)[0];
  ok(back.hasClass('pop-row--back') && back.getAttribute('aria-label') === 'Back: ott · Claude Code · 8 min ago',
    'the page opens with a back row named "Back: <title>"');
  ok(back.all(e => e.hasClass('pop-sub'))[0]?.textContent === 'opus-5.5 — v1.3.0 shipped', 'the back bar carries the subtitle');
  ok(menuOf(t.doc).getAttribute('aria-label') === 'ott · Claude Code · 8 min ago', 'the drill page menu is named by its title');
  ok(t.doc.live.textContent === 'ott · Claude Code · 8 min ago', 'the live region announces the page');
  ok(menuOf(t.doc).hasClass('pop-enter-fwd'), 'a drill slides forward (class pop-enter-fwd; CSS drops it under reduced motion)');
  const det = t.doc.pop.all(e => e.hasClass('pop-details'))[0];
  ok(det && det.getAttribute('role') === 'group' && det.getAttribute('aria-label') === 'Details', 'the drill page shows a Details group (D7)');
  ok(det && det.all(e => e.hasClass('pop-details-line')).map(e => e.textContent).join('|') ===
    'ott · main|machine: pc-1a2b3c|written: 21 Nov 2026, 13:37|Opens the project page.', 'every Details line is visible, in order');
  ok(det && det.all(e => e.hasClass('pop-details-label')).map(e => e.textContent).join() === 'Open in The Curator',
    'a labelled DetailGroup shows its label; the page\'s own group (label null) shows none');
  ok(!menuOf(t.doc).all(e => e === det).length, 'Details sit OUTSIDE the role=menu element (a menu holds only items)');
  ok(t.doc.activeElement === byLabel(t.doc, 'Open in The Curator'), 'focus lands on the first pressable row of the page');
  byLabel(t.doc, 'Other work-streams').click();
  ok(pop.state().pageId === 'p:3', 'a page can drill one level more');
  items(t.doc)[0].click();
  ok(pop.state().pageId === 'p:1', 'back returns to the PARENT page (p:1), not root');
  ok(t.doc.activeElement === byLabel(t.doc, 'Other work-streams'), 'and focus returns to the row that opened the page');
  pop.back();
  ok(pop.state().pageId === 'root' && t.doc.activeElement === byLabel(t.doc, 'ott · Claude Code · 8 min ago'),
    'back to root lands on the project row');
  ok(menuOf(t.doc).hasClass('pop-enter-back') && t.doc.live.textContent === 'The Curator', 'back slides back and announces "The Curator"');
  ok(pop.back() === false, 'back on root does nothing');
  // a drill to a page that does not exist is not painted
  const p = payload(); p.pages.root.rows.push({ kind: 'drill', key: 'kz', drill: 'p:99', label: 'Nowhere', sublabel: null, img: null });
  const t2 = load(); t2.send(p);
  ok(!byLabel(t2.doc, 'Nowhere'), 'a drill row whose page is missing is not painted');
  // icon column: the Knowledge page's bars widen it
  const t3 = load(); t3.send(payload()); byLabel(t3.doc, 'Knowledge · 2 domains').click();
  ok(menuOf(t3.doc).style.props.get('--pop-icon-w') === '22px', 'the icon column takes the widest bar on the page (22px)');
  ok(items(t3.doc).filter(e => !e.hasClass('pop-row--back')).every(e => e.children[0].hasClass('pop-icon')),
    'every row on that page (header included) gets the column, so labels line up');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§7 the key map');
function keyMap(src) {
  const t = load(src); t.send(payload(5));
  const pop = t.paint.instance;
  const r = {};
  const label = () => t.doc.activeElement.getAttribute('aria-label');
  r.first = label();
  t.doc.key('ArrowDown'); r.down = label();
  t.doc.key('ArrowUp'); t.doc.key('ArrowUp'); r.upWrap = label();
  t.doc.key('Home'); r.home = label();
  t.doc.key('End'); r.end = label();
  t.doc.key('ArrowDown'); r.downWrap = label();
  t.doc.key('ArrowDown'); t.doc.key('ArrowDown');   // pulse → header → project row
  r.onProject = label();
  t.doc.key('ArrowRight'); r.rightPage = pop.state().pageId;
  t.doc.key('ArrowLeft'); r.leftPage = pop.state().pageId; r.leftFocus = label();
  t.doc.key('Enter'); r.enterPage = pop.state().pageId;
  t.doc.key('Backspace'); r.bsPage = pop.state().pageId;
  t.doc.key(' '); r.spacePage = pop.state().pageId;
  t.doc.key('Escape'); r.escPage = pop.state().pageId; r.escDismiss = t.api.dismissed;
  t.doc.key('Escape'); r.escRootDismiss = t.api.dismissed;
  const ctrl = t.doc.key('ArrowDown', { ctrlKey: true }); r.ctrlHandled = ctrl.defaultPrevented; r.ctrlFocus = label();
  const alt = t.doc.key('Enter', { altKey: true }); r.altActs = t.api.acts.length;
  r.altHandled = alt.defaultPrevented;
  const down = t.doc.key('ArrowDown'); r.downPrevented = down.defaultPrevented;
  const other = t.doc.key('a'); r.otherPrevented = other.defaultPrevented;
  t.doc.key('Home'); t.doc.key('ArrowRight'); r.rightOnStripDrill = pop.state().pageId;
  t.doc.key('Escape');
  t.doc.key('End'); t.doc.key('ArrowRight'); r.rightOnAction = pop.state().pageId; r.rightActs = t.api.acts.length;
  return r;
}
{
  const r = keyMap(SRC);
  ok(r.first === '7 days · 192 saves · Claude Code', 'first focus: the first row');
  ok(r.down === 'Active · last 24 h', 'ArrowDown moves to the next row (a header is announced as disabled)');
  ok(r.upWrap === 'Quit The Curator', 'ArrowUp wraps from the top to the last row');
  ok(r.home === '7 days · 192 saves · Claude Code' && r.end === 'Quit The Curator', 'Home / End');
  ok(r.downWrap === '7 days · 192 saves · Claude Code', 'ArrowDown wraps from the last row to the first');
  ok(r.onProject === 'ott · Claude Code · 8 min ago, opus-5.5 — v1.3.0 shipped', '(walked to the project row)');
  ok(r.rightPage === 'p:1', 'ArrowRight on a drill row opens its page');
  ok(r.leftPage === 'root' && r.leftFocus === 'ott · Claude Code · 8 min ago, opus-5.5 — v1.3.0 shipped', 'ArrowLeft goes back, focus on the opener');
  ok(r.enterPage === 'p:1' && r.bsPage === 'root', 'Enter drills, Backspace goes back');
  ok(r.spacePage === 'p:1', 'Space activates like Enter');
  ok(r.escPage === 'root' && r.escDismiss === 0, 'Esc on a drill page goes BACK (no dismiss)');
  ok(r.escRootDismiss === 1, 'Esc on root calls dismiss()');
  ok(r.ctrlHandled === false && r.ctrlFocus === r.leftFocus, 'Ctrl+key is ignored by the page (the controller swallows accelerators)');
  ok(r.altActs === 0 && r.altHandled === false, 'Alt+Enter does nothing');
  ok(r.downPrevented === true && r.otherPrevented === false, 'handled keys preventDefault; others pass through');
  ok(r.rightOnStripDrill === 'p:0', 'ArrowRight on the pulse strip drills into Saves by tool');
  ok(r.rightOnAction === 'root' && r.rightActs === 0, 'ArrowRight on an ACTION does nothing (never acts)');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§8 theme and invalid payloads');
{
  const t = load();
  t.send(payload(1, 'light'));
  ok(t.doc.documentElement.getAttribute('data-theme') === 'light', 'theme "light" → <html data-theme="light">');
  t.send(payload(2, 'dark'));
  ok(t.doc.documentElement.getAttribute('data-theme') === 'dark', 'theme "dark" → data-theme="dark"');
  t.send(payload(3, 'sepia'));
  ok(t.doc.documentElement.getAttribute('data-theme') === 'light', 'anything but "dark" → light (contract §1)');
  const paints = t.paint.instance.state().paints;
  for (const bad of [null, 42, {}, { ...payload(4), v: 2 }, { ...payload(4), gen: 0 }, { ...payload(4), gen: 1.5 },
    { ...payload(4), gen: '4' }, { ...payload(4), pages: {} }, { ...payload(4), pages: null }]) t.api.cb(bad);
  ok(t.paint.instance.state().paints === paints && t.paint.instance.state().gen === 3, 'invalid payloads are ignored: the last good paint stays');
  ok(t.paint.validPayload(payload(9)) !== null, 'CONTROL: a valid payload validates');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§9 a new payload while a page is open; stale nodes never act');
{
  const t = load(); t.send(payload(7));
  byLabel(t.doc, 'ott · Claude Code · 8 min ago').click();
  t.doc.key('ArrowDown');
  const focused = t.paint.instance.state().focusKey;
  t.send(payload(8));
  ok(t.paint.instance.state().pageId === 'p:1', 'same page id, same title → the page stays open');
  ok(t.paint.instance.state().focusKey === focused, 'and focus stays on the same row key');
  t.send(payload(9, 'dark', { projectLabel: 'ott · Claude Code · 9 min ago' }));
  ok(t.paint.instance.state().pageId === 'root', 'the title changed → back to root (contract §1)');
  const p = payload(10); delete p.pages['p:1'];
  p.pages.root.rows = p.pages.root.rows.filter(r => r.drill !== 'p:1');
  const t2 = load(); t2.send(payload(7));
  byLabel(t2.doc, 'ott · Claude Code · 8 min ago').click();
  t2.send(p);
  ok(t2.paint.instance.state().pageId === 'root', 'the page vanished → back to root');
  // a node painted under gen 7 that somehow survives is never acted on under gen 8
  const t3 = load(); t3.send(payload(7));
  const oldNode = byLabel(t3.doc, 'Open The Curator');
  t3.send(payload(8));
  oldNode.click();
  ok(t3.api.acts.length === 0, 'a row node from an older paint never calls act');
  byLabel(t3.doc, 'Open The Curator').click();
  ok(JSON.stringify(t3.api.acts) === JSON.stringify([[8, 'tray-open-app']]), 'CONTROL: the freshly painted row does');
  // window focus with focus lost to <body>: focus returns to a row
  t3.doc.activeElement = t3.doc.body;
  t3.fireWin('focus');
  ok(items(t3.doc).includes(t3.doc.activeElement), 'when the window regains focus with nothing focused, a row takes focus');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§10 size() and painted()');
{
  const t = load();
  t.doc.pop.scrollHeight = 444; t.doc.pop.rectHeight = 444.4;
  t.send(payload(6));
  ok(t.api.sizes.at(-1) === 445, 'size() reports the content height rounded UP (444.4 → 445)');
  ok(JSON.stringify(t.api.paintedLog.at(-1)) === JSON.stringify([6, 10]), 'painted(gen, rows) reports gen 6 and the 10 rows on root');
  byLabel(t.doc, 'Knowledge · 2 domains').click();
  ok(JSON.stringify(t.api.paintedLog.at(-1)) === JSON.stringify([6, 3]), 'a drill page reports its own rows (3, the back bar not counted)');
  const throwing = load();
  throwing.api.size = () => { throw new Error('dead'); };
  let threw = false;
  try { throwing.send(payload(1)); } catch { threw = true; }
  ok(!threw && items(throwing.doc).length > 0, 'a dead channel never breaks the paint');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§M mutations: each guard goes red when its line is broken');
function mutant(from, to) {
  if (!SRC.includes(from)) return null;
  return SRC.split(from).join(to);
}
function check(name, src, probe) {
  if (src === null) { ok(false, `MUTATION ${name}: the anchor text was not found (suite out of date)`); return; }
  let red;
  try { red = !probe(src); } catch { red = true; }
  ok(red, `MUTATION ${name} → the guard goes red`);
}
{
  // 1. textContent → an HTML sink
  check('label painted with innerHTML',
    mutant("e.textContent = s;                           // escape-first: text, never markup", 'e.innerHTML = s;'),
    (src) => { const { t } = escapeCheck(src); return t.doc.htmlWrites.length === 0; });
  // 2. act with a captured/stale gen instead of the current one
  check('act sends a fixed gen',
    mutant('var p = api.act(state.gen, id);', 'var p = api.act(1, id);'),
    (src) => { const t = load(src); t.send(payload(7)); t.send(payload(8)); byLabel(t.doc, 'Open The Curator').click();
      return JSON.stringify(t.api.acts) === JSON.stringify([[8, 'tray-open-app']]); });
  // 3. the stale-node guard
  check('stale node guard removed',
    mutant('if (i < 0) return;', 'if (i < 0) { activate({ kind: "action", row: { id: e.getAttribute("data-key") } }); return; }'),
    (src) => { const t = load(src); t.send(payload(7)); const n = byLabel(t.doc, 'Open The Curator'); t.send(payload(8)); n.click();
      return t.api.acts.length === 0; });
  // 4. drill reaching act
  check('a drill also acts',
    mutant("if (entry.kind === 'drill') { drill(r); return; }", "if (entry.kind === 'drill') { act(r.drill); drill(r); return; }"),
    (src) => { const t = load(src); t.send(payload()); byLabel(t.doc, 'Knowledge · 2 domains').click(); return t.api.acts.length === 0; });
  // 5. Esc always dismisses
  check('Esc dismisses from a drill page',
    mutant("if (!back()) { try { if (typeof api.dismiss === 'function') api.dismiss(); } catch (_) {} }",
      "try { api.dismiss(); } catch (_) {}"),
    (src) => keyMap(src).escDismiss === 0);
  // 6. Up does not wrap
  check('ArrowUp without wrap',
    mutant('focusAt(((i + delta) % n + n) % n);', 'focusAt(Math.max(0, Math.min(n - 1, i + delta)));'),
    (src) => keyMap(src).upWrap === 'Quit The Curator');
  // 7. ArrowRight activates any row
  check('ArrowRight acts on an action',
    mutant("if (cur && cur.kind === 'drill') activate(cur); else handled = false;", 'if (cur) activate(cur);'),
    (src) => keyMap(src).rightActs === 0);
  // 8. theme copied raw
  check('theme not normalised',
    mutant("var t = theme === 'dark' ? 'dark' : 'light';", 'var t = String(theme);'),
    (src) => { const t = load(src); t.send(payload(1, 'sepia')); return t.doc.documentElement.getAttribute('data-theme') === 'light'; });
  // 9. image URL filter dropped
  check('non-data image accepted',
    mutant("if (!isObj(s) || !isStr(s.url) || s.url.indexOf(DATA_PNG) !== 0) continue;", 'if (!isObj(s) || !isStr(s.url)) continue;'),
    (src) => { const p = payload(); p.pages.root.rows[0].img.sources = [{ density: 1, url: 'https://evil.example/x.png' }];
      const t = load(src); t.send(p); return t.doc.pop.all(e => e.tagName === 'IMG' && e.hasClass('pop-img--strip')).length === 0; });
  // 10. page kept even when its title changed
  check('page kept on a changed title',
    mutant('page(prevPage).title === prevTitle', 'true'),
    (src) => { const t = load(src); t.send(payload(7)); byLabel(t.doc, 'ott · Claude Code · 8 min ago').click();
      t.send(payload(9, 'dark', { projectLabel: 'ott · Claude Code · 9 min ago' })); return t.paint.instance.state().pageId === 'root'; });
  // 11. Details painted on root too
  check('Details on root',
    mutant('if (!isRoot && Array.isArray(pg.details) && pg.details.length) {', 'if (Array.isArray(pg.details) && pg.details.length) {'),
    (src) => { const p = payload(); p.pages.root.details = [{ label: null, lines: ['leak'] }];
      const t = load(src); t.send(p); return t.doc.pop.all(e => e.hasClass('pop-details')).length === 0; });
  // 12. invalid payload accepted
  check('gen check dropped',
    mutant("if (!isObj(p) || p.v !== CONTRACT_VERSION || !isGen(p.gen)) return null;", "if (!isObj(p) || p.v !== CONTRACT_VERSION) return null;"),
    (src) => { const t = load(src); t.send(payload(3)); t.api.cb({ ...payload(4), gen: 0 }); return t.paint.instance.state().gen === 3; });
  // 13. statements lose aria-disabled
  check('statement not aria-disabled',
    mutant("if (kind === 'header' || kind === 'statement' || kind === 'stamp') {\n        e.setAttribute('aria-disabled', 'true');",
      "if (kind === 'header' || kind === 'stamp') {\n        e.setAttribute('aria-disabled', 'true');"),
    (src) => { const t = load(src); t.send(payload()); return byLabel(t.doc, 'Two agent tools are writing ott · main.').getAttribute('aria-disabled') === 'true'; });
  // 14. size not rounded up
  check('size rounded down',
    mutant("var rh = Math.ceil(Number(host.getBoundingClientRect().height) || 0);", "var rh = Math.floor(Number(host.getBoundingClientRect().height) || 0);"),
    (src) => { const t = load(src); t.doc.pop.scrollHeight = 444; t.doc.pop.rectHeight = 444.4; t.send(payload(6)); return t.api.sizes.at(-1) === 445; });
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ tray popover page: all assertions green');
