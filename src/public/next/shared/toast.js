// shared/toast.js — the ONE pattern for a message that RESULTS FROM AN ACTION
// (v3.67.2): a confirmation ("Agent instructions copied"), a clarification
// ("why can't I re-copy this?"), or a short instruction ("paste it at the top
// of CLAUDE.md"). Built once here; every view shows one through `showToast`.
//
// ── WHY A TOAST, AND WHY IT GOES AWAY ON ITS OWN ────────────────────────────
// Through v3.67.1 each view painted its own in-flow success box after a copy
// and kept it until the project changed — the maintainer's finding was that
// "it never goes away". A confirmation is true for the moment after the press;
// left on screen it becomes furniture that pushes the page down and reads as a
// standing state. So a toast:
//   · disappears on its own after TOAST_MS (30 s),
//   · PAUSES while the pointer is over it or focus is inside it (someone
//     reading or reaching for the × is not interrupted), and resumes after,
//     with at least TOAST_RESUME_FLOOR_MS left so it never vanishes the
//     instant the pointer leaves,
//   · has a small × that closes it early,
//   · comes BACK when the same action is repeated — showing the same `key`
//     again replaces the old one with a fresh one and a fresh 30 s. That is
//     how a user gets a dismissed message back: do the thing again.
//
// ── WHAT MUST NEVER BE A TOAST ──────────────────────────────────────────────
// The standing rule (v3.16.1): a warning about a COST, a DESTRUCTIVE outcome,
// or a state that still BLOCKS the user is never hidden — and a message that
// vanishes on a timer is hidden 30 seconds later. Those stay persistent and
// in flow. So does a FAILURE whose fallback the user still needs on screen
// (a refused clipboard hands the text over to be selected by hand; a toast
// would take the text away with it). This module cannot enforce that — it
// cannot know what a sentence means — so the rule is stated here, at the one
// place a caller has to read to use it.
//
// ── ACCESSIBILITY ──────────────────────────────────────────────────────────
// ONE region, `role="status"` + `aria-live="polite"`, created once and kept in
// <body> (outside #view-root, so no view's re-render can replace it and no
// navigation unmounts it). Each toast is appended into it, so a screen reader
// announces it without moving focus — a status message must never steal focus.
// The × is a real <button> with an accessible name; Escape while focus is in a
// toast closes it. Motion is CSS only (shared/toast.css) and is switched off
// under prefers-reduced-motion.
//
// ── WHY THE CLOCK IS INJECTED ───────────────────────────────────────────────
// `createToaster({document, setTimeout, clearTimeout, now})` takes every
// ambient dependency as an argument so scripts/test-toast.js can drive the
// real code with a fake clock and a fake DOM and assert the TIMING — 30 s,
// the hover pause, the resume floor, the re-show — as behaviour rather than as
// the presence of a number in the source. `showToast` below is the same
// object, built once against the browser's own globals.
//
// Text is set with `textContent`, never innerHTML: a toast can quote a path, a
// project name or a server message, and none of them may become markup.

export const TOAST_MS = 30000;
export const TOAST_RESUME_FLOOR_MS = 4000;
export const TOAST_MAX_VISIBLE = 3;

const TONES = ['success', 'neutral', 'attention'];

/**
 * @param {{document: Document, setTimeout: Function, clearTimeout: Function,
 *          now: () => number}} env
 */
export function createToaster(env) {
  const doc = env.document;
  const setT = env.setTimeout;
  const clrT = env.clearTimeout;
  const now = env.now;
  const live = new Map();   // key -> record, in insertion (display) order
  let region = null;

  function ensureRegion() {
    if (region && region.parentNode) return region;
    region = doc.createElement('div');
    region.className = 'cur-toast-region';
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
    region.setAttribute('aria-label', 'Notifications');
    doc.body.appendChild(region);
    return region;
  }

  function disarm(rec) {
    if (rec.timer !== null) { clrT(rec.timer); rec.timer = null; }
  }

  function arm(rec, ms) {
    disarm(rec);
    rec.deadline = now() + ms;
    rec.timer = setT(() => { rec.timer = null; dismiss(rec.key); }, ms);
  }

  function pause(rec) {
    if (rec.timer === null) return;
    rec.remaining = Math.max(0, rec.deadline - now());
    disarm(rec);
  }

  function maybeResume(rec) {
    if (rec.hovered || rec.focused) return;
    if (rec.timer !== null || live.get(rec.key) !== rec) return;
    const left = typeof rec.remaining === 'number' ? rec.remaining : rec.duration;
    arm(rec, Math.max(left, TOAST_RESUME_FLOOR_MS));
  }

  function removeEl(rec) {
    const el = rec.el;
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function dismiss(key) {
    const rec = live.get(key);
    if (!rec) return false;
    disarm(rec);
    live.delete(key);
    removeEl(rec);
    return true;
  }

  /**
   * Show a toast. Showing a `key` that is already up REPLACES it (fresh
   * element, fresh timer), which is what makes a repeated action bring a
   * dismissed or fading message back.
   *
   * @param {{key?: string, tone?: 'success'|'neutral'|'attention',
   *          title: string, lines?: string[], durationMs?: number}} o
   * @returns {string|null} the key, or null when there was nothing to show
   */
  function show(o) {
    if (!o || typeof o !== 'object') return null;
    const title = typeof o.title === 'string' ? o.title.trim() : '';
    if (!title) return null;
    const key = typeof o.key === 'string' && o.key ? o.key : title;
    const tone = TONES.indexOf(o.tone) === -1 ? 'neutral' : o.tone;
    const lines = (Array.isArray(o.lines) ? o.lines : [])
      .filter((l) => typeof l === 'string' && l.trim()).slice(0, 2);
    const duration = Number.isFinite(o.durationMs) && o.durationMs > 0 ? o.durationMs : TOAST_MS;

    dismiss(key);
    // A burst of different actions never stacks a wall: the oldest goes.
    while (live.size >= TOAST_MAX_VISIBLE) dismiss(live.keys().next().value);

    const el = doc.createElement('div');
    el.className = 'cur-toast cur-toast-' + tone;
    el.setAttribute('data-toast-key', key);
    const body = doc.createElement('div');
    body.className = 'cur-toast-body';
    const t = doc.createElement('div');
    t.className = 'cur-toast-title';
    t.textContent = title;
    body.appendChild(t);
    for (const line of lines) {
      const d = doc.createElement('div');
      d.className = 'cur-toast-line';
      d.textContent = line;
      body.appendChild(d);
    }
    const x = doc.createElement('button');
    x.setAttribute('type', 'button');
    x.className = 'cur-toast-close';
    x.setAttribute('aria-label', 'Dismiss: ' + title);
    x.textContent = '×';
    el.appendChild(body);
    el.appendChild(x);

    const rec = { key, el, duration, timer: null, deadline: 0, remaining: null,
      hovered: false, focused: false };
    x.addEventListener('click', () => dismiss(key));
    el.addEventListener('mouseenter', () => { rec.hovered = true; pause(rec); });
    el.addEventListener('mouseleave', () => { rec.hovered = false; maybeResume(rec); });
    el.addEventListener('focusin', () => { rec.focused = true; pause(rec); });
    el.addEventListener('focusout', (e) => {
      const to = e && e.relatedTarget;
      if (to && typeof el.contains === 'function' && el.contains(to)) return;
      rec.focused = false;
      maybeResume(rec);
    });
    el.addEventListener('keydown', (e) => {
      if (e && e.key === 'Escape') dismiss(key);
    });

    live.set(key, rec);
    ensureRegion().appendChild(el);
    arm(rec, duration);
    return key;
  }

  return {
    show,
    dismiss,
    prime: () => { ensureRegion(); },
    isOpen: (key) => live.has(key),
    element: (key) => (live.has(key) ? live.get(key).el : null),
    keys: () => Array.from(live.keys()),
  };
}

// ── The browser's own toaster, built on first use ──────────────────────────
let defaultToaster = null;
function browserToaster() {
  if (defaultToaster) return defaultToaster;
  if (typeof document === 'undefined' || !document || !document.body) return null;
  defaultToaster = createToaster({
    document,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    now: () => Date.now(),
  });
  return defaultToaster;
}

// The live region is created AT LOAD, empty, so the first toast is announced:
// several screen readers ignore a live region that arrives already filled.
if (typeof document !== 'undefined' && document && document.body) {
  const t = browserToaster();
  if (t) t.prime();
}

/** Show a toast in the app. Returns its key, or null outside a browser. */
export function showToast(o) {
  const t = browserToaster();
  return t ? t.show(o) : null;
}

/** Close a toast early by key. */
export function dismissToast(key) {
  const t = browserToaster();
  return t ? t.dismiss(key) : false;
}
