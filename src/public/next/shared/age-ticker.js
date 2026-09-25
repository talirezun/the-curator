// ═══════════════════════════════════════════════════════════════════════════
//  shared/age-ticker.js — ONE CLOCK FOR EVERY "… ago" ON SCREEN (v3.72.0)
// ═══════════════════════════════════════════════════════════════════════════
//
// An age is arithmetic over a timestamp already in hand. Rendering it once
// and never again is how "saved 4 min ago" came to read the same an hour
// later in Chat's project picker (truth audit F3), and how a conversation
// started before midnight stayed under TODAY until something happened to
// repaint the list (F7).
//
// ── THE CONTRACT ──────────────────────────────────────────────────────────
// Any element carrying `data-age-at="<ISO>"` is a ticking age. Once a second
// the ticker recomputes the words with shared/age.js's `formatAge` — the one
// vocabulary — and writes them as `textContent` into a NAMED target:
//
//   · the element itself, when it also carries `data-age-text`;
//   · else its first `[data-age-text]` descendant;
//   · else the sidebar kit's `.cur-sb-age` (renderSidebarRow escapes its own
//     age slot, so a host cannot put an element of its own around the words);
//   · else the readout kit's `.tx-readout-value` (the same reason).
//
// Never the wrapper's own text by fallback: a wrapper can hold a visually
// hidden absolute date, and an unnamed fallback is how a future edit would
// start deleting it (views/memory.js's tickAges records the same rule).
//
// `data-age-prefix="started"` prefixes the words ("started 3 weeks ago"), so
// an age that is NOT last use can never be read as last use.
//
// ── IT NEVER RENDERS A VIEW ───────────────────────────────────────────────
// A render replaces markup by innerHTML, which closes an open ⓘ, shuts an
// open picker and moves focus. settings.js shipped a 1s render tick and
// v3.53.1 records it as a defect; v3.67.2 made an open ⓘ survive repaints and
// this module must not undo that. The ticker writes text, and only when the
// text CHANGED (a no-op write still dirties the node and re-announces in a
// live region).
//
// The ONE exception is not a render of anything by this module: when the
// LOCAL DAY changes (midnight, or a tab woken on another day), listeners
// registered with `onDayChange` are called, so a view can re-group a list
// under Today / Yesterday. That is the caller's own light repaint, and it
// happens at most once a day.
//
// ── NO DOM AT IMPORT ──────────────────────────────────────────────────────
// Nothing here touches `document` or `window` at import, so an offline suite
// imports it in plain Node and drives `tickAges(root, now)` with a fake root.

import { formatAge } from './age.js';

export const AGE_TICK_MS = 1000;

/** The words for one timestamp at `now`, or null when it cannot be read. */
export function ageWordsFor(iso, now, prefix) {
  const t = typeof iso === 'string' && iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return null;
  // A timestamp AHEAD of this clock (another machine's clock, a hand edit) is
  // clamped to "just now" rather than reported as negative: formatAge refuses
  // a negative age, and "just now" never rounds an age OLDER than the truth.
  const words = formatAge(Math.max(0, Math.round((now - t) / 1000)));
  if (words === null) return null;
  const p = typeof prefix === 'string' ? prefix.trim() : '';
  return p ? p + ' ' + words : words;
}

/** The named text target for one ticking element (see the contract). */
export function ageTargetOf(el) {
  if (!el) return null;
  if (typeof el.hasAttribute === 'function' && el.hasAttribute('data-age-text')) return el;
  if (typeof el.querySelector !== 'function') return null;
  return el.querySelector('[data-age-text]') ||
    el.querySelector('.cur-sb-age') ||
    el.querySelector('.tx-readout-value');
}

/**
 * One pass. Pure with respect to its arguments: `root` is anything with
 * `querySelectorAll`, `now` a millisecond clock. Returns how many targets it
 * actually CHANGED, which is what a suite asserts on.
 */
export function tickAges(root, now) {
  if (!root || typeof root.querySelectorAll !== 'function') return 0;
  const t = typeof now === 'number' ? now : Date.now();
  const nodes = root.querySelectorAll('[data-age-at]');
  let changed = 0;
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i];
    const words = ageWordsFor(el.getAttribute('data-age-at'), t, el.getAttribute('data-age-prefix'));
    if (words === null) continue;
    const target = ageTargetOf(el);
    if (target && target.textContent !== words) { target.textContent = words; changed++; }
  }
  return changed;
}

/** `YYYY-M-D` in LOCAL time — the key the day-change check compares. */
export function localDayKey(now) {
  const d = new Date(now);
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}

// ── The running clock ─────────────────────────────────────────────────────
// One interval for the whole app, started by the first subscriber and
// stopped by the last. A view subscribes on mount and unsubscribes in its
// teardown, so a view that is gone costs nothing.

let timer = null;
let lastDay = null;
let visHandler = null;
const dayListeners = new Set();
let subscribers = 0;

function pass() {
  if (typeof document === 'undefined') return;
  const now = Date.now();
  tickAges(document, now);
  const day = localDayKey(now);
  if (lastDay !== null && day !== lastDay) {
    lastDay = day;
    for (const fn of [...dayListeners]) {
      try { fn(now); } catch { /* a listener's failure must not stop the clock */ }
    }
    return;
  }
  lastDay = day;
}

/**
 * Subscribe. Returns the unsubscribe function — call it exactly once, from
 * the view's teardown.
 * @param {{onDayChange?: (now: number) => void}} [opts]
 */
export function subscribeAgeTicker(opts) {
  const onDay = opts && typeof opts.onDayChange === 'function' ? opts.onDayChange : null;
  if (onDay) dayListeners.add(onDay);
  subscribers++;
  if (!timer && typeof setInterval === 'function') {
    lastDay = localDayKey(Date.now());
    timer = setInterval(pass, AGE_TICK_MS);
    // A tab hidden overnight gets its interval throttled; the first visible
    // moment re-reads the clock at once instead of up to a second later.
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      visHandler = () => { if (document.visibilityState === 'visible') pass(); };
      document.addEventListener('visibilitychange', visHandler);
    }
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (onDay) dayListeners.delete(onDay);
    subscribers = Math.max(0, subscribers - 1);
    if (subscribers === 0 && timer) {
      clearInterval(timer);
      timer = null;
      if (visHandler && typeof document !== 'undefined') document.removeEventListener('visibilitychange', visHandler);
      visHandler = null;
    }
  };
}

/** Run one pass now (after a paint that introduced new ages). */
export function tickAgesNow() {
  if (typeof document === 'undefined') return 0;
  return tickAges(document, Date.now());
}
