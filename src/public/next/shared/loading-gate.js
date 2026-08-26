/**
 * loading-gate.js — the ONE place /next decides WHETHER to show a loader.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The complaint was "you load some data, nothing happens, and then all of a
 * sudden something happens." The instinct is to make the loading states
 * prettier. Measurement says the opposite: the placeholders were never slow,
 * they were SUB-FRAME FLASHES that collapsed the content column and then
 * re-expanded it. Measured lifetimes on screen, across 13 view-entry
 * placeholders: 1.3 ms to 12 ms. On the Domains entry the "Loading…" frame
 * lived 5.8 ms and cost a 199 px jump on the way in and another on the way
 * out.
 *
 * A loader that exists for 6 ms communicates nothing and costs two layout
 * jumps. Animating it makes it worse. The fix is not to style it — it is to
 * NOT SHOW IT AT ALL unless the wait is long enough to be worth reporting.
 *
 * THE TWO CONSTANTS
 * -----------------
 *   LOADER_DELAY_MS = 200        do not show a loader for work under this
 *   LOADER_MIN_VISIBLE_MS = 400  once shown, keep it at least this long
 *
 * DELAY — why 200 ms, and why ONE number covers every device. The Domains
 * placeholder was measured under CPU throttling at x1 / x6 / x20:
 * 16.8 / 26.6 / 105 ms. Even a twenty-times-slower machine finishes that
 * work in half the threshold, so no device-capability detection is needed
 * or wanted here: the gate MEASURES the real wait instead of predicting it,
 * which is the only version of this that cannot be wrong about a machine it
 * has never run on.
 *
 * MIN-VISIBLE — why a loader that HAS appeared must overstay. Without it,
 * work finishing at 210 ms shows a loader for 10 ms: the exact strobe the
 * delay exists to prevent, just moved later. So the clamp DELAYS THE
 * RESULT, deliberately: `settle()` holds the finished content back until
 * the loader has had its 400 ms. Paying up to 390 ms of latency to avoid a
 * flash is the right trade only in the narrow band where a loader was
 * actually shown — under 200 ms nothing is ever delayed by even one
 * millisecond, which is the overwhelmingly common case (all 13 sites).
 *
 * HONESTY DOCTRINE (shared/progress-ring.css states the rule this module
 * obeys): NEVER advance an indicator to look busy. This module decides
 * WHEN a loader is shown. It has no notion of progress, emits no
 * percentage, and no caller can make it imply one. A loader that appears
 * here means exactly "we are still waiting" — which is true — and nothing
 * more.
 *
 * ── PURE CORE / THIN PLUMBING ────────────────────────────────────────────
 * `shouldShowLoader` and `settleDelayMs` are the entire decision. They are
 * pure functions of numbers, so the truth table can be tested
 * exhaustively. `createLoadingGate` is the timer/render plumbing wrapped
 * around them, and takes its clock and timer functions as INJECTED
 * dependencies so a test drives real elapsed time deterministically
 * instead of sleeping. Nothing in this file touches the DOM.
 *
 * ── TIMER HYGIENE (load-bearing) ─────────────────────────────────────────
 * A pending timer that outlives its mount paints a loader over the NEXT
 * view. Every consumer MUST call `cancel()` from its view teardown. The
 * gate additionally refuses to act on any callback after `cancel()`, so a
 * timer that has already fired cannot resurrect a torn-down view.
 */

/** Do not show a loader for work that finishes faster than this. */
export const LOADER_DELAY_MS = 200;

/** Once a loader IS on screen, keep it there at least this long. */
export const LOADER_MIN_VISIBLE_MS = 400;

/** PURE. Has the wait earned a loader yet?
 *
 *  Non-finite input answers `false` — the fail-safe direction, because the
 *  failure mode of a wrongly-`true` here is the flash this module exists to
 *  remove, while a wrongly-`false` merely leaves the column as it already
 *  was.
 */
export function shouldShowLoader(elapsedMs, delayMs = LOADER_DELAY_MS) {
  if (!Number.isFinite(elapsedMs) || !Number.isFinite(delayMs)) return false;
  return elapsedMs >= delayMs;
}

/** PURE. How much longer must the finished result be held back?
 *
 *  `shownAtMs === null` means the loader was never shown, so there is
 *  nothing to protect and the answer is 0 — the fast path every one of the
 *  13 sub-20 ms sites takes. Never negative: a loader that has already
 *  outstayed its minimum releases immediately.
 */
export function settleDelayMs(shownAtMs, nowMs, minVisibleMs = LOADER_MIN_VISIBLE_MS) {
  if (shownAtMs === null || shownAtMs === undefined) return 0;
  if (!Number.isFinite(shownAtMs) || !Number.isFinite(nowMs) || !Number.isFinite(minVisibleMs)) return 0;
  const remaining = (shownAtMs + minVisibleMs) - nowMs;
  return remaining > 0 ? remaining : 0;
}

/** Create a loading gate.
 *
 *  @param opts.onChange   called whenever `visible` flips; re-render here.
 *  @param opts.delayMs / opts.minVisibleMs   overrides, for tests.
 *  @param opts.now / opts.setTimer / opts.clearTimer   injected clock and
 *         timers. Default to the real ones; a test supplies fakes and
 *         drives elapsed time by hand.
 *
 *  Concurrency: `begin()`/`settle()` are counted, not boolean. A view with
 *  several independent loads in flight (Settings loads its version and its
 *  default section together) keeps ONE gate: the loader is warranted while
 *  ANY of them is outstanding, and the min-visible clamp is applied once,
 *  when the last one lands.
 */
export function createLoadingGate(opts) {
  const o = opts || {};
  const delayMs = Number.isFinite(o.delayMs) ? o.delayMs : LOADER_DELAY_MS;
  const minVisibleMs = Number.isFinite(o.minVisibleMs) ? o.minVisibleMs : LOADER_MIN_VISIBLE_MS;
  const onChange = typeof o.onChange === 'function' ? o.onChange : function () {};
  const now = typeof o.now === 'function' ? o.now : (() => Date.now());
  const setTimer = typeof o.setTimer === 'function' ? o.setTimer : ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = typeof o.clearTimer === 'function' ? o.clearTimer : ((h) => clearTimeout(h));

  let pending = 0;          // outstanding begin() calls
  let visible = false;      // is a loader warranted RIGHT NOW
  let shownAt = null;       // when it became visible (null = never shown)
  let showHandle = null;    // armed delay timer
  let holdHandle = null;    // armed min-visible timer
  let cancelled = false;    // torn down; every callback becomes a no-op

  function clearShow() { if (showHandle !== null) { clearTimer(showHandle); showHandle = null; } }
  function clearHold() { if (holdHandle !== null) { clearTimer(holdHandle); holdHandle = null; } }

  function armShow() {
    if (showHandle !== null || visible) return;
    showHandle = setTimer(() => {
      showHandle = null;
      // A timer that fires after teardown must never repaint. This is the
      // second half of the timer-hygiene contract — cancel() clears the
      // handle, and this guard covers the race where it had already fired.
      if (cancelled || pending === 0 || visible) return;
      visible = true;
      shownAt = now();
      onChange();
    }, delayMs);
  }

  return {
    /** True iff a loader is warranted right now. Read this in render(). */
    get visible() { return visible; },
    /** Diagnostics only — never branch product behaviour on this. */
    get pending() { return pending; },

    /** Work started. */
    begin() {
      if (cancelled) return;
      pending += 1;
      if (pending === 1) armShow();
    },

    /** Work finished. `apply` paints the result, and is called EXACTLY once
     *  — immediately when no loader was shown (the common case), or after
     *  the min-visible clamp expires when one was. Never called after
     *  cancel(). */
    settle(apply) {
      const paint = typeof apply === 'function' ? apply : function () {};
      if (cancelled) return;
      if (pending > 0) pending -= 1;

      if (pending > 0) { paint(); return; }   // other work still running

      if (!visible) {                          // never showed — nothing to protect
        clearShow();
        shownAt = null;
        paint();
        return;
      }

      const wait = settleDelayMs(shownAt, now(), minVisibleMs);
      const release = () => {
        holdHandle = null;
        if (cancelled) return;
        // Re-armed while we were holding: a new begin() has taken over and
        // the loader must stay. Its own settle() will release it.
        if (pending > 0) { paint(); return; }
        visible = false;
        shownAt = null;
        onChange();
        paint();
      };
      if (wait <= 0) { release(); return; }
      clearHold();
      holdHandle = setTimer(release, wait);
    },

    /** Teardown. MUST be called from the view's teardown. Idempotent.
     *  Never calls onChange or a pending `apply` — a torn-down view must
     *  not paint. */
    cancel() {
      cancelled = true;
      clearShow();
      clearHold();
      pending = 0;
      visible = false;
      shownAt = null;
    },
  };
}

/** The ONLY markup any /next view may use for a delay-gated loader.
 *
 *  Deliberately plain: text in the class the surrounding surface already
 *  uses. No spinner, no bar, no skeleton. A skeleton is honest only where
 *  the structure it promises is certain to arrive, and the audit found
 *  exactly one wait in this tree long enough to earn one (the Domains
 *  health panel, ~654 ms) — that is a separate change with its own proof.
 *  Everywhere else the wait is under 20 ms and a skeleton is strictly worse
 *  than nothing.
 *
 *  Centralising the markup here is also what makes the class invariant in
 *  scripts/test-next-loading-gate.js checkable: a bare loading string
 *  anywhere in views/ that is not an argument to this function is, by
 *  construction, an ungated placeholder.
 */
export function loaderHtml(label, cls) {
  return '<div class="' + (cls || 'view-body') + '" role="status">' + (label || 'Loading…') + '</div>';
}

/** Null-safe settle. A view whose gate has already been cancelled (its
 *  teardown ran while a fetch was still in flight) must still be able to
 *  paint — a MISSING gate degrades to "no gating", never to "the content
 *  never arrives". Callers use this rather than `gate.settle(...)` so the
 *  degraded path is one shared, tested branch instead of a null check
 *  repeated at every call site (and forgotten at one of them).
 */
export function settleGate(gate, apply) {
  if (gate) { gate.settle(apply); return; }
  if (typeof apply === 'function') apply();
}

/** Convenience: the gated loader, or nothing. `gate` may be null/undefined
 *  (a view that has not built one yet) — that answers '' rather than
 *  throwing, because a missing gate must degrade to "no loader", never to a
 *  broken view. */
export function gatedLoader(gate, label, cls) {
  return (gate && gate.visible) ? loaderHtml(label, cls) : '';
}
