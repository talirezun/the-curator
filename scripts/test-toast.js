#!/usr/bin/env node
/**
 * test-toast.js — OFFLINE suite (v3.67.2).
 *
 * Three maintainer findings on the Context view, each asserted as BEHAVIOUR:
 *
 *   §1–§6  THE ONE "MESSAGE THAT RESULTS FROM AN ACTION" — shared/toast.js.
 *          The real `createToaster`, driven with a fake clock and a fake DOM:
 *          it disappears on its own after 30 s; hover or focus PAUSES it and
 *          leaving resumes it (never with less than the floor left); the ×
 *          and Escape close it early; showing the same key again brings it
 *          back with a fresh 30 s and never stacks a duplicate; it is one
 *          polite status region; text is text, never markup.
 *   §7     THE COPY CONFIRMATION SAYS WHERE — the real `copyAgentInstructions`
 *          lifted from views/memory.js, run against the real toaster: the
 *          toast a user reads names the very TOP of the file and which file
 *          belongs to which harness.
 *   §8–§10 AN OPEN ⓘ SURVIVES A RE-RENDER WITHOUT BLINKING. The real delegated
 *          listener in shared/text.js, a fake document, and the real `render`
 *          bodies of views/memory.js and views/ingest.js: a panel opened by a
 *          press carries `data-tx-entering` (the ONLY thing that animates it,
 *          §10 reads that off the shipped CSS); a re-render's restored panel is
 *          open, paired with its button, and does NOT carry it — so it does not
 *          fade out and back in. That replayed entrance was the "blink".
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { functionSource } from './test-helpers/source-scan.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NEXT = join(ROOT, 'src/public/next');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let passed = 0;
let failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + String(detail).slice(0, 300) : '')); }
}
function eq(name, a, b) { ok(name, a === b, 'got ' + JSON.stringify(a) + ', expected ' + JSON.stringify(b)); }
function section(t) { console.log('\n' + t); }

// ── A fake DOM, just large enough for the two shared modules ───────────────
function parseSel(sel) {
  // Compound attribute selectors only: `[a]`, `[a="v"]`, chained.
  const parts = [];
  const re = /\[([a-z-]+)(?:="([^"]*)")?\]/g;
  let m;
  while ((m = re.exec(sel))) parts.push({ name: m[1], value: m[2] });
  return parts;
}
class El {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = doc;
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this.listeners = {};
    this.className = '';
    this._text = '';
    this.hidden = false;
  }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; }
  replaceWith(n) { const p = this.parentNode; const i = p.children.indexOf(this); p.children[i] = n; n.parentNode = p; this.parentNode = null; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  dispatch(t, extra) { for (const fn of (this.listeners[t] || []).slice()) fn({ type: t, target: this, ...(extra || {}) }); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join('\n'); }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  matches(sel) { return parseSel(sel).every((p) => this.hasAttribute(p.name) && (p.value === undefined || this.getAttribute(p.name) === p.value)); }
  closest(sel) { for (let x = this; x; x = x.parentNode) if (x.matches && x.matches(sel)) return x; return null; }
  *walk() { yield this; for (const c of this.children) yield* c.walk(); }
}
function makeDoc() {
  const doc = { listeners: {} };
  doc.body = new El('body', doc);
  doc.createElement = (t) => new El(t, doc);
  doc.addEventListener = (t, fn) => { (doc.listeners[t] = doc.listeners[t] || []).push(fn); };
  doc.dispatch = (t, e) => { for (const fn of (doc.listeners[t] || [])) fn(e); };
  doc.getElementById = (id) => { for (const n of doc.body.walk()) if (n.id === id) return n; return null; };
  doc.querySelectorAll = (sel) => {
    const out = [];
    for (const s of sel.split(',')) for (const n of doc.body.walk()) if (n !== doc.body && n.matches(s.trim()) && !out.includes(n)) out.push(n);
    return out;
  };
  return doc;
}
function fakeClock() {
  let t = 0;
  let id = 0;
  const q = new Map();
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const i = ++id; q.set(i, { at: t + ms, fn }); return i; },
    clearTimeout: (i) => { q.delete(i); },
    pending: () => q.size,
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const [i, v] of q) if (v.at <= end && (!next || v.at < next[1].at)) next = [i, v];
        if (!next) break;
        q.delete(next[0]);
        t = next[1].at;
        next[1].fn();
      }
      t = end;
    },
  };
}

// toast.js is imported with NO global document, so its load-time priming is
// skipped and every toaster below is built against a fake one.
const { createToaster, TOAST_MS, TOAST_RESUME_FLOOR_MS, TOAST_MAX_VISIBLE } =
  await import('../src/public/next/shared/toast.js');

function rig() {
  const doc = makeDoc();
  const clock = fakeClock();
  const t = createToaster({ document: doc, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now });
  return { doc, clock, t };
}

// ═══════════════════════════════════════════════════════════════════════════
section('§1 — it goes away on its own after 30 seconds');
// ═══════════════════════════════════════════════════════════════════════════
eq('the duration is thirty seconds', TOAST_MS, 30000);
{
  const { clock, t } = rig();
  t.show({ key: 'k', tone: 'success', title: 'Agent instructions copied', lines: ['a', 'b'] });
  const shown = t.element('k');
  ok('it is up the moment it is shown', t.isOpen('k') && shown.parentNode !== null);
  clock.advance(29999);
  ok('...still up one millisecond before thirty seconds', t.isOpen('k'));
  clock.advance(1);
  ok('...and gone AT thirty seconds, with nobody touching it', !t.isOpen('k'));
  ok('...and its element left the document', shown.parentNode === null);
  eq('no timer is left behind', clock.pending(), 0);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2 — hover and focus PAUSE it; leaving resumes it');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { clock, t } = rig();
  t.show({ key: 'k', title: 'T' });
  clock.advance(10000);
  t.element('k').dispatch('mouseenter');
  clock.advance(120000);
  ok('two minutes of hovering later it is still there — someone is reading it', t.isOpen('k'));
  t.element('k').dispatch('mouseleave');
  clock.advance(19999);
  ok('after leaving, it keeps the 20 s it had left (not a fresh 30, not zero)', t.isOpen('k'));
  clock.advance(1);
  ok('...and goes when those run out', !t.isOpen('k'));
}
{
  const { clock, t } = rig();
  t.show({ key: 'k', title: 'T' });
  clock.advance(29500);
  t.element('k').dispatch('mouseenter');
  t.element('k').dispatch('mouseleave');
  clock.advance(TOAST_RESUME_FLOOR_MS - 1);
  ok('leaving with 0.5 s left still gets the resume floor, so it never vanishes the instant the pointer leaves',
    t.isOpen('k'));
  clock.advance(1);
  ok('...and then goes', !t.isOpen('k'));
}
{
  const { clock, t } = rig();
  t.show({ key: 'k', title: 'T' });
  const el = t.element('k');
  const close = el.children[1];
  el.dispatch('focusin');
  clock.advance(90000);
  ok('focus inside it (reaching for the ×) pauses it too', t.isOpen('k'));
  el.dispatch('focusout', { relatedTarget: close });
  clock.advance(90000);
  ok('...and focus moving WITHIN it does not resume the clock', t.isOpen('k'));
  el.dispatch('focusout', { relatedTarget: null });
  clock.advance(TOAST_MS);
  ok('...focus leaving it does', !t.isOpen('k'));
}
{
  const { clock, t } = rig();
  t.show({ key: 'k', title: 'T' });
  const el = t.element('k');
  el.dispatch('mouseenter');
  el.dispatch('focusin');
  el.dispatch('mouseleave');
  clock.advance(90000);
  ok('pointer gone but focus still inside: still paused', t.isOpen('k'));
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3 — the × and Escape close it early');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { clock, t } = rig();
  t.show({ key: 'k', title: 'Copied' });
  const x = t.element('k').children[1];
  eq('the close control is a real button', x.tagName, 'BUTTON');
  ok('...with an accessible name', /Dismiss/.test(x.getAttribute('aria-label') || ''), x.getAttribute('aria-label'));
  x.dispatch('click');
  ok('pressing it closes the toast at once', !t.isOpen('k'));
  eq('...and cancels its timer', clock.pending(), 0);
  t.show({ key: 'k', title: 'Copied' });
  t.element('k').dispatch('keydown', { key: 'Escape' });
  ok('Escape while focus is in it closes it too', !t.isOpen('k'));
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4 — repeating the action shows it again (and never twice)');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { doc, clock, t } = rig();
  t.show({ key: 'copy-agent-instructions', title: 'Agent instructions copied' });
  t.element('copy-agent-instructions').children[1].dispatch('click');
  ok('SETUP: dismissed with the ×', !t.isOpen('copy-agent-instructions'));
  t.show({ key: 'copy-agent-instructions', title: 'Agent instructions copied' });
  ok('pressing Copy again brings the same message back', t.isOpen('copy-agent-instructions'));
  clock.advance(25000);
  const first = t.element('copy-agent-instructions');
  t.show({ key: 'copy-agent-instructions', title: 'Agent instructions copied' });
  ok('a repeat while it is still up replaces it with a fresh element (re-announced)',
    t.element('copy-agent-instructions') !== first && first.parentNode === null);
  clock.advance(25000);
  ok('...with a FRESH thirty seconds, not the old remainder', t.isOpen('copy-agent-instructions'));
  const region = doc.body.children[0];
  eq('...and there is still exactly ONE of it on screen',
    region.children.filter((c) => c.getAttribute('data-toast-key') === 'copy-agent-instructions').length, 1);
}
{
  const { doc, t } = rig();
  for (let i = 0; i < TOAST_MAX_VISIBLE + 2; i++) t.show({ key: 'k' + i, title: 'T' + i });
  eq('a burst of different actions never stacks a wall', doc.body.children[0].children.length, TOAST_MAX_VISIBLE);
  ok('...the OLDEST go first', !t.isOpen('k0') && !t.isOpen('k1') && t.isOpen('k' + (TOAST_MAX_VISIBLE + 1)));
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5 — one polite status region; text is text');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { doc, t } = rig();
  t.prime();
  const region = doc.body.children[0];
  eq('the region can exist BEFORE the first toast (primed at load, so the first one is announced)',
    region.children.length, 0);
  t.show({ key: 'a', tone: 'success', title: 'A' });
  t.show({ key: 'b', tone: 'attention', title: 'B' });
  eq('ONE region for every toast', doc.body.children.length, 1);
  eq('...role="status"', region.getAttribute('role'), 'status');
  eq('...aria-live="polite" — announced without taking focus', region.getAttribute('aria-live'), 'polite');
  ok('the tone is a class on the toast (the rail colour), never a sentence',
    /cur-toast-success/.test(t.element('a').className) && /cur-toast-attention/.test(t.element('b').className));
  t.show({ key: 'x', tone: 'bogus', title: 'X' });
  ok('an unknown tone falls back to neutral', /cur-toast-neutral/.test(t.element('x').className));
  t.show({ key: 'h', title: '<img src=x onerror=alert(1)>', lines: ['<b>no</b>'] });
  const body = t.element('h').children[0];
  eq('a title is set as TEXT, so a quoted name cannot become markup', body.children[0].children.length, 0);
  eq('...the literal text survives', body.children[0].textContent, '<img src=x onerror=alert(1)>');
  t.show({ key: 'l', title: 'T', lines: ['1', '2', '3'] });
  eq('at most TWO lines under the title', t.element('l').children[0].children.length, 3);
  eq('an empty title shows nothing', t.show({ title: '   ' }), null);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§6 — the stylesheet: linked, token-only, reduced motion honoured');
// ═══════════════════════════════════════════════════════════════════════════
{
  const html = read('src/public/next/index.html');
  ok('shared/toast.css is linked from the shell (where test-css-tokens.js discovers stylesheets)',
    /<link rel="stylesheet" href="\/next\/shared\/toast\.css">/.test(html));
  const css = read('src/public/next/shared/toast.css').replace(/\/\*[\s\S]*?\*\//g, '');
  ok('no --text-dim (it does not exist in this app)', !/--text-dim/.test(css));
  const reduce = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css);
  ok('the arrival animation is switched off under prefers-reduced-motion',
    !!reduce && /\.cur-toast \{ animation: none; \}/.test(reduce[1]), reduce && reduce[1]);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§7 — the copy confirmation says WHERE: the very top, and which file');
// ═══════════════════════════════════════════════════════════════════════════
{
  const AI = await import('../src/public/next/shared/agent-instructions.js');
  const memSrc = read('src/public/next/views/memory.js');
  const { doc, clock, t } = rig();
  const clip = [];
  let state = { activeDomain: 'acme', activeProject: 'lumina', copied: null };
  let renders = 0;
  // The REAL copyAgentInstructions, against the REAL toaster.
  const copy = new Function('state', 'navigator', 'isCurrentMount', 'render', 'showToast',
    'composeAgentInstructionsFull', 'COPY_SUCCESS_TITLE', 'COPY_SUCCESS_LINES',
    functionSource(memSrc, 'copyAgentInstructions') + '\nreturn copyAgentInstructions;')(
    state, { clipboard: { writeText: async (x) => { clip.push(x); } } }, () => true, () => { renders++; },
    (o) => t.show(o), AI.composeAgentInstructionsFull, AI.COPY_SUCCESS_TITLE, AI.COPY_SUCCESS_LINES);
  await copy(1);
  ok('SETUP: the block reached the clipboard', clip.length === 1 && /## Working state/.test(clip[0]));
  const el = t.element('copy-agent-instructions');
  ok('the press raises the toast', !!el);
  const text = el ? el.textContent : '';
  ok('it says to paste at the very TOP of the file', /very top of the file/.test(text), text);
  for (const [file, harness] of [['CLAUDE.md', 'Claude Code'], ['AGENTS.md', 'Codex'], ['GEMINI.md', 'Gemini CLI'],
    ['.cursor/rules', 'Cursor']]) {
    ok('...and pairs ' + file + ' with ' + harness, text.includes(file + ' for ' + harness), text);
  }
  eq('...as a title and at most two lines', el.children[0].children.length <= 3, true);
  eq('and nothing is left on the page for it to paint forever', state.copied, null);
  clock.advance(TOAST_MS);
  ok('thirty seconds later it is gone on its own', !t.isOpen('copy-agent-instructions'));
  ok('CONTROL: the region is really in this fake document', doc.body.children.length === 1);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§8 — the ⓘ press stamps its entrance; a re-render’s restore does not');
// ═══════════════════════════════════════════════════════════════════════════
const tdoc = makeDoc();
globalThis.document = tdoc;   // shared/text.js wires its ONE delegated listener at import
const TEXT = await import('../src/public/next/shared/text.js');
function mountInfo(doc, id) {
  const { btn, panel } = TEXT.renderInfoMark(id, 'About X', 'Some prose.');
  ok('CONTROL: the real mark emits both halves', btn.includes('data-tx-info="' + id + '"') && panel.includes('hidden'));
  // The fake DOM cannot parse HTML, so the two elements are built with the
  // attributes the real markup carries (asserted just above).
  const b = doc.createElement('button');
  b.setAttribute('id', id + '-btn');
  b.setAttribute('data-tx-info', id);
  b.setAttribute('aria-expanded', 'false');
  const p = doc.createElement('div');
  p.setAttribute('id', id);
  p.hidden = true;
  doc.body.appendChild(b);
  doc.body.appendChild(p);
  return { b, p };
}
function reRender(doc, id) {
  // What innerHTML does: the old nodes go, fresh CLOSED ones take their place.
  doc.body.children = doc.body.children.filter((n) => n.id !== id && n.id !== id + '-btn' && !(n.getAttribute && n.getAttribute('data-toast-key')));
  const b = doc.createElement('button');
  b.setAttribute('id', id + '-btn');
  b.setAttribute('data-tx-info', id);
  b.setAttribute('aria-expanded', 'false');
  const p = doc.createElement('div');
  p.setAttribute('id', id);
  p.hidden = true;
  doc.body.appendChild(b);
  doc.body.appendChild(p);
  return { b, p };
}
{
  const { b, p } = mountInfo(tdoc, 'i1');
  tdoc.dispatch('click', { target: b });
  ok('a press opens the panel', p.hidden === false && b.getAttribute('aria-expanded') === 'true');
  ok('...and stamps data-tx-entering on it — the ONE thing that animates a panel', p.hasAttribute('data-tx-entering'));
  const ids = TEXT.captureOpenInfoPanels();
  eq('capture sees the open panel', JSON.stringify(ids), '["i1"]');
  const fresh = reRender(tdoc, 'i1');
  TEXT.restoreOpenInfoPanels(ids);
  ok('after a re-render it is OPEN again — it survives', fresh.p.hidden === false);
  eq('...with its button saying so, so the next press closes it in one', fresh.b.getAttribute('aria-expanded'), 'true');
  ok('...and WITHOUT data-tx-entering, so it does not fade out and back in (the blink)',
    !fresh.p.hasAttribute('data-tx-entering'));
  tdoc.dispatch('click', { target: fresh.b });
  ok('one press closes the restored panel', fresh.p.hidden === true && fresh.b.getAttribute('aria-expanded') === 'false');
  ok('...and closing clears the stamp', !fresh.p.hasAttribute('data-tx-entering'));
  tdoc.dispatch('click', { target: fresh.b });
  ok('re-opening by a press animates again (the stamp is back)', fresh.p.hasAttribute('data-tx-entering'));
  tdoc.dispatch('click', { target: tdoc.body });
  ok('CONTROL: a click elsewhere closes it (the listener really is the shipped one)', fresh.p.hidden === true);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§9 — the views that re-render on a timer keep an open ⓘ, unstamped');
// ═══════════════════════════════════════════════════════════════════════════
{
  // views/memory.js — Context. Its poll repaints whenever an age crosses a
  // band; the REAL render body, with its collaborators as stand-ins.
  tdoc.body.children = [];
  const memSrc = read('src/public/next/views/memory.js');
  const { b, p } = mountInfo(tdoc, 'ctx-info');
  tdoc.dispatch('click', { target: b });
  ok('SETUP: open, stamped', !p.hidden && p.hasAttribute('data-tx-entering'));
  let fresh = null;
  const render = new Function('isCurrentMount', 'screenSignature', 'captureFocus', 'renderSidebar', 'renderMain',
    'wire', 'restoreFocus', 'maybeLoadSessionStart', 'maybeLoadSetup', 'document',
    'let renderedSignature = null;\n' + functionSource(memSrc, 'render') + '\nreturn render;')(
    () => true, () => 's', () => {}, () => {}, () => { fresh = reRender(tdoc, 'ctx-info'); },
    () => {}, () => {}, () => {}, () => {}, tdoc);
  render(1);
  ok('Context’s render really replaced the panel (not vacuous)', fresh && fresh.p !== p);
  ok('...and the open ⓘ is open after it', fresh.p.hidden === false && fresh.b.getAttribute('aria-expanded') === 'true');
  ok('...without the entrance stamp — it stays still while it is read', !fresh.p.hasAttribute('data-tx-entering'));
}
{
  // views/ingest.js — its activity poll re-renders whenever a job moves, and
  // had NO capture/restore: an open ⓘ snapped shut. The REAL render body.
  tdoc.body.children = [];
  const ingSrc = read('src/public/next/views/ingest.js');
  const { b } = mountInfo(tdoc, 'ing-info');
  tdoc.dispatch('click', { target: b });
  let fresh = null;
  const render = new Function('hostCtx', 'renderSidebar', 'renderMain', 'wireListeners', 'notifyHostBusy',
    'captureOpenInfoPanels', 'restoreOpenInfoPanels',
    functionSource(ingSrc, 'render') + '\nreturn render;')(
    null, () => {}, () => { fresh = reRender(tdoc, 'ing-info'); }, () => {}, () => {},
    TEXT.captureOpenInfoPanels, TEXT.restoreOpenInfoPanels);
  render(1);
  ok('Ingest’s render really replaced the panel (not vacuous)', !!fresh);
  ok('...and an open ⓘ survives Ingest’s repaint too', fresh.p.hidden === false
    && fresh.b.getAttribute('aria-expanded') === 'true', JSON.stringify(fresh.b.attrs));
  ok('...unstamped', !fresh.p.hasAttribute('data-tx-entering'));
}

// ═══════════════════════════════════════════════════════════════════════════
section('§10 — only a PRESSED panel animates, in every stylesheet in /next');
// ═══════════════════════════════════════════════════════════════════════════
{
  // Every rule in /next that puts an ANIMATION on `.tx-vh-panel` outside a
  // reduced-motion block must require `[data-tx-entering]` — otherwise a
  // restored panel replays its entrance on every repaint. Read off the real
  // stylesheets, comments stripped (a comment quoting the old rule must not
  // satisfy or fail this).
  const files = [];
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.css')) files.push(p); } };
  walk(NEXT);
  const offenders = [];
  let stamped = 0;
  for (const f of files) {
    let css = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    css = css.replace(/@media[^{]*prefers-reduced-motion[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sels = m[1].split(',').map((x) => x.trim());
      if (!/(^|;|\s)animation(-name)?\s*:\s*(?!none)/.test(m[2])) continue;
      for (const sel of sels) {
        if (!/\.tx-vh-panel\b/.test(sel)) continue;
        if (/\[data-tx-entering\]/.test(sel)) stamped++;
        else offenders.push(f.slice(ROOT.length + 1) + ' ' + sel);
      }
    }
  }
  ok('no rule animates an ⓘ panel without [data-tx-entering]', offenders.length === 0, offenders.join('; '));
  ok('CONTROL: and the entrance still exists, on the stamped selector', stamped >= 1, String(stamped));
}

console.log('\n' + '-'.repeat(60));
console.log('Passed: ' + passed + '   Failed: ' + failed);
if (failed) { console.log('❌ ' + failed + ' toast / info-panel assertion(s) failed'); process.exit(1); }
console.log('✅ All toast and info-panel assertions green');
