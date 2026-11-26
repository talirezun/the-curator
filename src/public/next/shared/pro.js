// shared/pro.js — the app-wide Pro switch (v4.2, build contract 2026-11-26).
//
// ── WHAT PRO IS ─────────────────────────────────────────────────────────────
// One switch for the whole app. Off (the default, for everyone, existing
// installs too) each view shows its simple design; on, it shows every detail
// and control. Pro only REVEALS: it never removes, relabels or changes what a
// control does, and a warning, a cost, an outcome, a refusal, a confirm or
// anything needed to finish a task is NEVER Pro-only
// (scripts/test-pro-guard.js holds that line).
//
// ── HOW A VIEW USES IT ──────────────────────────────────────────────────────
// Preferred: one render path. Put `proAttr()` on the Pro-only markup; one CSS
// rule (shared/pro.css) hides it while <html data-pro> is not "on", so a flip
// needs no re-render and nothing re-fetches. Only content that is not in the
// DOM until opened (a listbox menu, a popover) reads `isPro()` and re-renders
// on `onProChange`. A view never stores its own Pro state.
//
// ── WHERE THE STATE LIVES ───────────────────────────────────────────────────
// On the server: `.curator-config.json` → `uiDetail` ('simple' | 'pro'),
// through GET/POST /api/config/ui-detail, so the Electron window and a browser
// tab on the same computer agree. This computer only (never synced).
//
// A localStorage MIRROR (`curator-next-pro`) exists only for the FIRST PAINT:
// initPro() paints from it synchronously, then reconciles with the server.
// Its fail-safe direction is OFF — an unreadable store shows the simple view,
// which hides no warning, so the worst failure is cosmetic.
//
// DOM-free AT IMPORT: every browser global is read inside a function, so
// suites import this module in plain Node and drive it with fakes.

import { showToast, dismissToast } from './toast.js';

export const PRO_TOOLTIP = 'Pro shows every detail and control. Free — nothing is removed.';
export const PRO_MIRROR_KEY = 'curator-next-pro';
const ROUTE = '/api/config/ui-detail';
const TOAST_ON_KEY = 'pro-mode-on';
const TOAST_FAIL_KEY = 'pro-mode-failed';

let _on = false;          // what the screen shows now
let _confirmed = false;   // what the server last said (the revert target)
let _seq = 0;             // bumps on every setPro, so a late answer never wins
let _initPromise = null;
let _delegated = false;
const _subs = new Set();

// ── Test seams (unset in the app) ───────────────────────────────────────────
let _env = null;
/** Tests only: inject {document, window, localStorage, fetch, toast, dismissToast, raf}. */
export function __setProEnv(env) { _env = env || null; }
/** Tests only: forget all state, as a fresh page load would. */
export function __resetPro() {
  _on = false; _confirmed = false; _seq = 0; _initPromise = null; _delegated = false; _subs.clear(); _shimmerTimer = null;
}

function g(name) {
  if (_env && Object.prototype.hasOwnProperty.call(_env, name)) return _env[name];
  return typeof globalThis !== 'undefined' ? globalThis[name] : undefined;
}
function doc() { const d = g('document'); return d && typeof d === 'object' ? d : null; }

function toastApi() {
  if (_env && (_env.toast || _env.dismissToast)) return { showToast: _env.toast || (() => null), dismissToast: _env.dismissToast || (() => false) };
  return { showToast, dismissToast };
}

function readMirror() {
  try {
    const ls = g('localStorage');
    return !!ls && ls.getItem(PRO_MIRROR_KEY) === 'on';
  } catch { return false; }
}
function writeMirror(on) {
  try { const ls = g('localStorage'); if (ls) ls.setItem(PRO_MIRROR_KEY, on ? 'on' : 'off'); } catch { /* cosmetic only */ }
}

/** Paint <html data-pro> and every Pro switch on the page from `_on`. */
function paint() {
  const d = doc();
  if (!d) return;
  try { if (d.documentElement) d.documentElement.setAttribute('data-pro', _on ? 'on' : 'off'); } catch { /* no root */ }
  try {
    const sw = typeof d.querySelectorAll === 'function' ? d.querySelectorAll('[data-pro-switch]') : [];
    for (const el of sw) el.setAttribute('aria-checked', _on ? 'true' : 'false');
  } catch { /* nothing to paint */ }
}

/** Set what the screen shows; notify only on a real change. */
function apply(on, { byPress = false } = {}) {
  const changed = on !== _on;
  _on = on;
  writeMirror(on);
  paint();
  if (!changed) return;
  if (on && byPress) shimmer();
  for (const cb of Array.from(_subs)) {
    try { cb(_on); } catch (err) { try { console.error('[pro] listener failed', err); } catch { /* */ } }
  }
}

// ── The switch-on moment (owner, 2026-11-26) ───────────────────────────────
// Turning Pro ON by a press sends ONE light shimmer down the rail: pro.css
// animates `.rail::before` while <html data-pro-shimmer> is set, and this
// clears the attribute after the run, so it plays once per press. Never on
// boot, never when the server's answer or a revert turns it on, never when
// turning it off — and not at all under prefers-reduced-motion (pro.css also
// switches the animation off there, so either guard alone holds).
export const SHIMMER_MS = 900;
let _shimmerTimer = null;
function reducedMotion() {
  try {
    const w = g('window');
    const mm = (w && w.matchMedia) || g('matchMedia');
    return typeof mm === 'function' && !!mm('(prefers-reduced-motion: reduce)').matches;
  } catch { return false; }
}
function shimmer() {
  const d = doc();
  if (!d || !d.documentElement || reducedMotion()) return;
  const root = d.documentElement;
  const st = g('setTimeout'), ct = g('clearTimeout');
  try {
    if (_shimmerTimer !== null && typeof ct === 'function') ct(_shimmerTimer);
    root.setAttribute('data-pro-shimmer', '');
    if (typeof st === 'function') {
      _shimmerTimer = st(() => { _shimmerTimer = null; try { root.removeAttribute('data-pro-shimmer'); } catch { /* */ } }, SHIMMER_MS + 100);
    }
  } catch { /* decoration only */ }
}

// ── The API (contract) ──────────────────────────────────────────────────────

/**
 * Once, in app.js boot, BEFORE first paint. Its synchronous prologue (an async
 * function runs synchronously up to its first await) paints <html data-pro>
 * from the mirror, so the first frame is already right; then it asks the
 * server and reconciles. Calling it again returns the same promise.
 */
export async function initPro() {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    const mirror = readMirror();
    _on = mirror;
    _confirmed = mirror;
    paint();
    installDelegation();
    const seqAtStart = _seq;
    try {
      const f = g('fetch');
      if (typeof f !== 'function') return _on;
      const res = await f(ROUTE, { headers: { Accept: 'application/json' } });
      const j = await res.json();
      if (j && (j.uiDetail === 'pro' || j.uiDetail === 'simple')) {
        _confirmed = j.uiDetail === 'pro';
        // A press that happened while the read was in flight wins: the read
        // answered a question asked before it.
        if (_seq === seqAtStart) apply(_confirmed);
      }
    } catch { /* keep the mirror's answer; OFF if there was none */ }
    return _on;
  })();
  return _initPromise;
}

/** Synchronous: is Pro on right now. */
export function isPro() { return _on; }

/**
 * Turn Pro on or off. The screen changes at once (and listeners hear it
 * before the request is made), then the server's answer is applied. On
 * failure the switch reverts to what the server last confirmed and a toast
 * says so. Resolves to the state in force afterwards.
 */
export async function setPro(on) {
  const want = !!on;
  const seq = ++_seq;
  apply(want, { byPress: true });
  let failure = null;
  try {
    const f = g('fetch');
    if (typeof f !== 'function') throw new Error('No network here.');
    const res = await f(ROUTE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ uiDetail: want ? 'pro' : 'simple' }),
    });
    let j = null;
    try { j = await res.json(); } catch { j = null; }
    if (res.ok && j && (j.uiDetail === 'pro' || j.uiDetail === 'simple')) {
      _confirmed = j.uiDetail === 'pro';
      if (seq === _seq) apply(_confirmed);
      return _on;
    }
    failure = (j && typeof j.error === 'string' && j.error) || 'The Curator could not save it.';
  } catch (err) {
    failure = (err && err.message) || 'The Curator could not save it.';
  }
  if (seq === _seq) {
    apply(_confirmed);
    const t = toastApi();
    try {
      t.showToast({ key: TOAST_FAIL_KEY, tone: 'attention',
        title: _confirmed ? 'Pro is still on' : 'Pro is still off', lines: [String(failure).slice(0, 240)] });
    } catch { /* the switch itself already shows the truth */ }
  }
  return _on;
}

/** Subscribe to changes; cb(isPro). Returns the unsubscribe function. */
export function onProChange(cb) {
  if (typeof cb !== 'function') return () => {};
  _subs.add(cb);
  return () => { _subs.delete(cb); };
}

/** The ONE marker for Pro-only markup (leading space, ready to concatenate). */
export function proAttr() { return ' data-detail="pro"'; }

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * The quiet door at the end of a section: "More in Pro: <what> ›". `what` is
 * TEXT (escaped here). Its button turns Pro on, keeps the section where it
 * was on screen, and shows "Pro is on" with Undo. Hidden while Pro is on
 * (shared/pro.css), so a view renders it unconditionally.
 */
export function moreInProLine(what) {
  const words = String(what == null ? '' : what).trim();
  return '<p class="pro-more">' +
      '<button type="button" class="btn btn-ghost btn-xs pro-more-btn" data-pro-more>' +
        'More in Pro' + (words ? ': ' + escapeHtml(words) : '') + ' <span aria-hidden="true">›</span>' +
      '</button>' +
    '</p>';
}

/**
 * The switch itself (shared/switch.css), for the rail and Settings › General.
 * Not in the contract's list; additive (amendment 1). `role="switch"`,
 * `aria-checked` from the current state, accessible name "Pro", the tooltip
 * as its description. pro.js keeps every copy's aria-checked in step.
 */
export function proSwitchHtml(o = {}) {
  const id = typeof o.id === 'string' && /^[A-Za-z][\w-]*$/.test(o.id) ? o.id : '';
  const extra = typeof o.className === 'string' && /^[\w -]*$/.test(o.className) ? ' ' + o.className.trim() : '';
  return '<button type="button" role="switch" class="cur-switch' + extra + '"' +
      (id ? ' id="' + id + '"' : '') +
      ' data-pro-switch aria-checked="' + (_on ? 'true' : 'false') + '"' +
      ' aria-label="Pro" title="' + escapeHtml(PRO_TOOLTIP) + '">' +
      '<span class="cur-switch-knob"></span>' +
    '</button>';
}

// ── One delegated listener for every switch, door and Undo ──────────────────

function installDelegation() {
  if (_delegated) return;
  const d = doc();
  if (!d || typeof d.addEventListener !== 'function') return;
  _delegated = true;
  d.addEventListener('click', onDocClick);
}

function closestOf(target, sel) {
  return target && typeof target.closest === 'function' ? target.closest(sel) : null;
}

function onDocClick(e) {
  const t = e && e.target;
  const el = closestOf(t, '[data-pro-more], [data-pro-undo], [data-pro-switch], [data-pro-toggle]');
  if (!el) return;
  if (el.hasAttribute('data-pro-more')) { e.preventDefault(); openFromDoor(el); return; }
  if (el.hasAttribute('data-pro-undo')) { e.preventDefault(); undoFromToast(); return; }
  // A switch, or the rail item that holds one (its caption is part of it).
  if (typeof el.hasAttribute === 'function' && el.hasAttribute('disabled')) return;
  setPro(!_on);
}

function scrollerOf(el) {
  const w = g('window');
  const d = doc();
  let n = el && el.parentElement;
  while (n && w && typeof w.getComputedStyle === 'function') {
    const oy = w.getComputedStyle(n).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight) return n;
    n = n.parentElement;
  }
  return (d && d.scrollingElement) || null;
}

/** The element whose place on screen must not move: the door's section. */
function anchorOf(btn) {
  return closestOf(btn, '[data-pro-anchor]') || closestOf(btn, 'section') ||
    (btn.parentElement && btn.parentElement.parentElement) || btn.parentElement;
}

/** Keep `anchor` at `top` (viewport px) and hand it focus (never body). */
function holdAnchor(anchor, top, scroller, takeFocus) {
  if (!anchor || typeof anchor.getBoundingClientRect !== 'function') return;
  if (anchor.isConnected === false && anchor.id) {
    const d = doc();
    const again = d && d.getElementById(anchor.id);
    if (again) anchor = again;
  }
  const delta = anchor.getBoundingClientRect().top - top;
  if (scroller && Math.abs(delta) >= 1) scroller.scrollTop += delta;
  if (takeFocus) {
    if (!anchor.hasAttribute('tabindex')) { anchor.setAttribute('tabindex', '-1'); anchor.setAttribute('data-pro-focus', ''); }
    try { anchor.focus({ preventScroll: true }); } catch { /* */ }
  }
}

async function openFromDoor(btn) {
  const anchor = anchorOf(btn);
  const top = anchor && typeof anchor.getBoundingClientRect === 'function' ? anchor.getBoundingClientRect().top : 0;
  const scroller = scrollerOf(anchor);
  const d = doc();
  const hadFocus = !!d && d.activeElement === btn;
  const done = setPro(true);             // the screen flips synchronously
  holdAnchor(anchor, top, scroller, true);
  const raf = g('requestAnimationFrame');
  if (typeof raf === 'function') raf(() => holdAnchor(anchor, top, scroller, hadFocus && d.activeElement === d.body));
  const t = toastApi();
  try {
    t.showToast({ key: TOAST_ON_KEY, tone: 'neutral', title: 'Pro is on' });
    addUndo();
  } catch { /* the switch on the rail says it too */ }
  return done;
}

/** shared/toast.js draws text only; the Undo is a real button added to it. */
function addUndo() {
  const d = doc();
  if (!d || typeof d.querySelector !== 'function') return;
  const el = d.querySelector('[data-toast-key="' + TOAST_ON_KEY + '"] .cur-toast-body');
  if (!el || el.querySelector('[data-pro-undo]')) return;
  const b = d.createElement('button');
  b.setAttribute('type', 'button');
  b.className = 'btn btn-ghost btn-xs pro-undo-btn';
  b.setAttribute('data-pro-undo', '');
  b.textContent = 'Undo';
  el.appendChild(b);
}

async function undoFromToast() {
  const t = toastApi();
  try { t.dismissToast(TOAST_ON_KEY); } catch { /* */ }
  return setPro(false);
}
