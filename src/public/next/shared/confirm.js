// shared/confirm.js — the /next tree's ONE in-design replacement for
// window.confirm().
//
// ── Why this exists ──────────────────────────────────────────────────────
// `window.confirm` renders the browser's own chrome ("localhost:3333
// says…"), which is jarringly outside the design and, on a destructive
// action, gives the user no context beyond a single line of text. Two
// native dialogs survived the /next cutover; both now route through here.
//
// ── Why the API takes the ACTION rather than returning a DECISION ────────
// This is the load-bearing design choice in this file, and it is not
// stylistic.
//
// `window.confirm` is SYNCHRONOUS and BLOCKING:
//
//     const ok = window.confirm('Delete…');
//     if (!ok) return;
//     await fetch(url, { method: 'DELETE' });
//
// Any in-page replacement is necessarily ASYNCHRONOUS. The obvious port is
// a promise-returning `openConfirm(): Promise<boolean>` — and that shape
// carries a silent data-loss bug one missing keyword away: a caller who
// writes `const ok = openConfirm(...)` without `await` gets a **Promise
// object, which is truthy**, so `if (!ok) return` never fires and the file
// is deleted whether the user clicked Delete or Cancel. No error, no
// warning, nothing in the console — the destructive path runs on Cancel.
//
// So this module deliberately exports NO function that resolves to a
// decision. There is no boolean anywhere in its public surface to be
// mis-tested. The destructive work is handed in as `onConfirm` and the
// ONLY reference to it lives inside the confirm button's own handler, so
// the action is unreachable unless the user actually confirmed. Forgetting
// `await confirmThen(...)` costs you error propagation and nothing else;
// it cannot delete anything.
//
// (Same structural shape as `beginDomainWrite()`'s already-bound release
// function in views/ingest.js: make the mistake impossible rather than
// documenting it and hoping.)
//
// ── Accessibility ────────────────────────────────────────────────────────
// The mechanism is copied deliberately from views/mcp-wizard.js — a
// capture-phase Escape handler, a Tab focus trap filtered on
// `offsetParent !== null`, backdrop dismissal on `mousedown` with an
// `e.target === scrim` identity test, and focus restored to the launching
// element read into a LOCAL before the root is detached. The wizard's
// *chrome* is not copied; only the mechanism, and it lives here once so
// the two call sites cannot drift apart. (views/domains.js's inline
// `renderConfirmCard()` is the right pattern for a confirm attached to a
// form the user is already looking at; a destructive confirm fired from a
// list row or a sidebar footer has no such anchor and is legitimately
// modal.)
//
// Owns the `.cfd-*` block in views/shared.css. Every colour there is an
// existing token — scripts/test-css-tokens.js hard-fails on any undefined
// `var(--x)` in /next, and the scrim darkness is an INLINE rgba literal,
// never `var(--scrim, …)`: that name is baselined at exactly one reference
// (shell.css) and a second one fails the suite.

// ── Module state ─────────────────────────────────────────────────────────
// One dialog at a time. `gen` is bumped on open AND close so a handler
// left over from a previous dialog can never act on the current one.
let root = null;
let scrimEl = null;
let prevFocus = null;
let settle = null;   // resolves the confirmThen() promise, exactly once
let gen = 0;

function bumpGen() { gen += 1; return gen; }

export function isConfirmOpen() { return root !== null; }

/**
 * Open the confirm dialog and run `opts.onConfirm` if — and only if — the
 * user confirms.
 *
 * Returns a Promise that settles when the interaction is over: after
 * `onConfirm` has settled on the confirm path, immediately on the cancel /
 * Escape / scrim path. It resolves to `undefined` on BOTH paths, by
 * design — see this file's header. Reject propagates whatever `onConfirm`
 * threw, so call sites use `.catch(reportAsyncActionFailure)`.
 *
 * opts:
 *   title        required, plain text (heading)
 *   message      required, plain text (the subject — usually user content)
 *   detail       optional, plain text (consequence line)
 *   confirmLabel optional, default 'Confirm'
 *   cancelLabel  optional, default 'Cancel'
 *   tone         'danger' (default) | 'default'
 *   onConfirm    optional function; may be async
 *
 * ALL interpolated strings are written with textContent, never innerHTML —
 * a conversation title is user content and reaches this module verbatim.
 */
export function confirmThen(opts) {
  const o = opts || {};

  // A second dialog while one is open resolves WITHOUT running the action.
  // Fail-safe direction: never run destructive work that the user has not
  // just been asked about on a dialog they can actually see.
  if (root) return Promise.resolve();

  const myGen = bumpGen();
  prevFocus = document.activeElement;

  root = document.createElement('div');
  root.className = 'cfd-root';
  root.innerHTML =
    '<div class="cfd-scrim">' +
      '<div class="cfd-card' + (o.tone === 'default' ? '' : ' cfd-danger') + '" role="dialog" aria-modal="true" aria-labelledby="cfd-title" aria-describedby="cfd-body">' +
        '<h2 class="cfd-title" id="cfd-title"></h2>' +
        '<div class="cfd-body" id="cfd-body">' +
          '<p class="cfd-message"></p>' +
          '<p class="cfd-detail"></p>' +
        '</div>' +
        '<div class="cfd-actions">' +
          '<button type="button" class="btn btn-ghost cfd-cancel"></button>' +
          '<button type="button" class="btn cfd-confirm"></button>' +
        '</div>' +
      '</div>' +
    '</div>';
  document.body.appendChild(root);

  scrimEl = root.querySelector('.cfd-scrim');
  const titleEl = root.querySelector('.cfd-title');
  const msgEl = root.querySelector('.cfd-message');
  const detailEl = root.querySelector('.cfd-detail');
  const cancelBtn = root.querySelector('.cfd-cancel');
  const confirmBtn = root.querySelector('.cfd-confirm');

  titleEl.textContent = String(o.title || 'Are you sure?');
  msgEl.textContent = String(o.message || '');
  if (o.detail) detailEl.textContent = String(o.detail);
  else detailEl.remove();
  cancelBtn.textContent = String(o.cancelLabel || 'Cancel');
  confirmBtn.textContent = String(o.confirmLabel || 'Confirm');
  confirmBtn.classList.add(o.tone === 'default' ? 'btn-primary' : 'btn-danger');

  document.addEventListener('keydown', onKeydown, true);
  scrimEl.addEventListener('mousedown', onScrimDown);
  cancelBtn.addEventListener('click', () => { if (gen === myGen) close(); });
  confirmBtn.addEventListener('click', () => { if (gen === myGen) accept(o.onConfirm); });

  // Focus lands on CANCEL for a destructive dialog: Enter and Space then
  // dismiss rather than destroy. A non-danger dialog focuses its primary.
  (o.tone === 'default' ? confirmBtn : cancelBtn).focus();

  return new Promise((resolve, reject) => { settle = { resolve, reject }; });
}

/**
 * Close the dialog if one is open, resolving its promise WITHOUT running
 * the action. Safe to call unconditionally — every view's teardown does,
 * so an overlay can never survive a view change (the shell's hard rule).
 */
export function closeConfirmIfOpen() { if (root) close(); }

// ── Internals ────────────────────────────────────────────────────────────

function teardown() {
  bumpGen(); // every handler from this session is now stale
  document.removeEventListener('keydown', onKeydown, true);
  if (scrimEl) scrimEl.removeEventListener('mousedown', onScrimDown);

  // Read the launcher into a LOCAL before detaching: `prevFocus` is module
  // state and is cleared below, and refocusing must happen only after the
  // dialog's own nodes are gone or the browser can bounce focus back.
  const returnTo = prevFocus;
  root.remove();
  root = null;
  scrimEl = null;
  prevFocus = null;

  if (returnTo && typeof returnTo.focus === 'function') {
    try { returnTo.focus(); } catch { /* the element may be gone */ }
  }
  const s = settle;
  settle = null;
  return s;
}

/** Cancel path: Escape, scrim, the Cancel button, or a view teardown. */
function close() {
  const s = teardown();
  if (s) s.resolve();
}

/** Confirm path — the ONLY place `onConfirm` is ever referenced. */
function accept(onConfirm) {
  const s = teardown();
  if (typeof onConfirm !== 'function') { if (s) s.resolve(); return; }
  // The dialog is dismissed BEFORE the action runs: the action's own
  // surface (a list refresh, an inline progress block) is the feedback,
  // and leaving a modal up over it would hide exactly that.
  let out;
  try { out = onConfirm(); } catch (err) { if (s) s.reject(err); return; }
  if (!s) return;
  Promise.resolve(out).then(() => s.resolve(), (err) => s.reject(err));
}

function onKeydown(e) {
  if (!root) return;
  if (e.key === 'Escape') { e.preventDefault(); close(); return; }
  if (e.key !== 'Tab') return;
  // Scoped to the dialog's own root, so background controls are
  // unreachable while it is open.
  const focusables = Array.from(root.querySelectorAll(
    'button:not([disabled]), a[href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'
  )).filter((el) => el.offsetParent !== null);
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) {
    e.preventDefault();
    first.focus();
  }
}

// Identity test, not `contains` — a mousedown that STARTED inside the card
// and drifted onto the backdrop before release must not dismiss.
function onScrimDown(e) { if (e.target === scrimEl) close(); }
