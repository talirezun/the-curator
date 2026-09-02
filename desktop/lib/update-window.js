/**
 * update-window.js — the small "Software Update" window the MENU-BAR update
 * path opens, expressed as decisions rather than as Electron calls.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  THE REPORT THIS FILE ANSWERS                                             ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * v3.40.0 was the first update the maintainer installed in place, from the
 * menu bar, on his own Mac. It worked end to end. His report was about the
 * middle of it: from  → Check for Updates… → "an update is available" →
 * Update, NOTHING VISIBLE HAPPENED until the app restarted. From Settings ▸
 * General the same update draws a five-phase ring with real byte counts.
 *
 * The menu item's label does move ("Downloading Update… 43%") — that shipped
 * in v3.36.0 and it is still there, unchanged. But it is inside a menu that is
 * CLOSED for the whole download: you have to pull the menu down to read it. So
 * the honest description of the shipped behaviour is the maintainer's: from
 * the menu bar, an update is minutes of nothing.
 *
 * ── WHY A WINDOW, AND HOW THAT ANSWERS v3.36.0's REJECTIONS ────────────────
 *
 * `main.js`'s `runMenuInstall()` docblock rejected three alternatives, and
 * every one of those rejections still stands. This is a FOURTH option, and it
 * was rejected by none of them:
 *
 *   (a) A native dialog that updates as it goes — rejected because Electron
 *       has no API to change or close a `showMessageBox` once it is on screen.
 *       STILL TRUE, and untouched: this is a BrowserWindow, not a dialog. It
 *       is redrawn by its own page, in place, as often as it likes.
 *
 *   (b) Switching the main window to Settings ▸ General — rejected on three
 *       grounds. THIS ANSWERS ALL THREE. It needs no main window, because it
 *       creates its own (the menu is reachable with no window at all, which is
 *       exactly the state ⌘W leaves behind). It needs no renderer couplings
 *       landing in order, because it loads ONE page whose whole job is this.
 *       And the auto-continue is untouched: `runInstall` in
 *       `lib/update-client.js` still drives the stream and still POSTs
 *       `/update/apply` itself. THE WINDOW STARTS NOTHING, APPLIES NOTHING AND
 *       CANCELS NOTHING — it is a reader of `GET /update-progress`, which is
 *       the same read-only route Settings' own `probeInAppUpdate()` uses to
 *       adopt a running job. A panel that "merely adopted" the job would have
 *       stalled at `staged`; this one does not adopt anything, so it cannot.
 *
 *   (c) `setProgressBar` — rejected because it is a BrowserWindow method, so
 *       it needs a window, and because it cannot name a phase or a failure.
 *       The first objection is answered by the same window; the second is why
 *       the Dock bar is an ACCESSORY here and never the display. The window
 *       names the phase and the failure. The Dock bar says only how far the
 *       download has got, which is the one thing it can say — and it says it
 *       while the window is behind something else.
 *
 * ── EVERYTHING ELECTRON IS INJECTED, FOR THE USUAL REASON ──────────────────
 *
 * Electron is deliberately not an offline-suite dependency, so `main.js` is
 * never imported, evaluated or run by `npm test`, and a guard on it can only
 * be a source scan — which proves a line was WRITTEN and nothing else. So all
 * four Electron capabilities arrive as functions in `deps`:
 *
 *   openWindow(spec)      -> a handle (anything; opaque here), or null
 *   setDockProgress(h, v) -> BrowserWindow#setProgressBar
 *   closeWindow(h)        -> BrowserWindow#close
 *   notify({title, body}) -> new Notification(...).show()
 *
 * A MISSING DEP IS NOT AN ERROR. It means that capability is unavailable —
 * `Notification.isSupported()` false, a platform with no Dock — and the update
 * still runs, unchanged, with one fewer thing on screen. That direction is
 * chosen deliberately: nothing in this file may be able to stop an update.
 * Every dep call is wrapped, and a dep that THROWS is treated as a dep that is
 * absent from then on rather than as a failure of the update.
 *
 * `scripts/test-update-window.js` drives all of it with recording fakes.
 */

/**
 * The page. Served by `express.static` straight out of `src/public/`, so it
 * needs no route: `src/server.js`'s static mount answers any request that
 * NAMES A FILE, and the `index: false` option only ever applied to directory
 * requests. A path that did not exist would fall through to the SPA catch-all
 * and load the whole app in a 380-point window, which is why this constant is
 * pinned by the suite against the file really being on disk.
 */
export const UPDATE_WINDOW_PATH = '/next/update-window.html';

/**
 * 380 × 140 POINTS. Small on purpose, and the two numbers come from what is
 * inside it: a 48pt ring with a two-line text block beside it, one headline
 * and one sentence, plus the byte line. Sparkle's own updater window is about
 * this size and Mac users have seen it for twenty years.
 *
 * NOT resizable: there is nothing to reveal by making it bigger and nothing
 * that survives making it smaller. NOT maximisable or fullscreenable for the
 * same reason. It is a statement, not a workspace.
 */
export const UPDATE_WINDOW_WIDTH = 380;
export const UPDATE_WINDOW_HEIGHT = 140;

/**
 * The same title the two update DIALOGS carry (`showUpdateDialog` in main.js
 * sets `title: 'Software Update'`). One operation, one name, wherever macOS
 * shows it — including the Window menu and the ⌘` cycle.
 */
export const UPDATE_WINDOW_TITLE = 'Software Update';

/**
 * The two Dock-bar sentinels, named rather than written as bare numbers at the
 * call site, because `-1` and `2` are Electron's own encoding and neither is a
 * progress value: `setProgressBar` REMOVES the bar for anything below 0 and
 * switches to INDETERMINATE for anything above 1.
 *
 * Indeterminate is used for a real state and not as decoration — see
 * `dockProgressFor`.
 */
export const DOCK_CLEAR = -1;
export const DOCK_INDETERMINATE = 2;

/**
 * Which menu actions open the window.
 *
 * ONLY the two that actually install something. `describeUpdate()` in
 * lib/update-verdict.js produces nine kinds and this is deliberately keyed on
 * the ACTION rather than on the kind, because the action is what main.js
 * dispatches on and it is the smaller, closed set:
 *
 *   {type:'install'}         → yes. The ordinary case.
 *   {type:'install-staged'}  → yes. Already downloaded; the window shows the
 *                              swap, which is short but is the part that ends
 *                              in the app disappearing.
 *   {type:'open-url'}        → NO. That is the no-engine build: the update
 *                              happens in a browser and then by hand.
 *   {type:'open-settings'}   → NO. The git-pull arm, which the shell
 *                              deliberately does not apply itself.
 *   null                     → NO. "You're up to date", "you're ahead",
 *                              "couldn't check", "an update is already
 *                              running" — every dialog with no action.
 *
 * A window that opened on "you're up to date" would be the worst possible
 * outcome of this change: a progress display for an operation that is not
 * happening. The suite drives this from REAL `describeUpdate()` payloads
 * rather than from hand-written action objects, so the mapping is checked
 * against the thing that actually produces them.
 */
export function shouldOpenUpdateWindow(action) {
  if (!action || typeof action !== 'object') return false;
  return action.type === 'install' || action.type === 'install-staged';
}

/**
 * The BrowserWindow options, as plain data, so the suite can inspect every
 * one of them without Electron.
 *
 * `null` when there is no usable base URL — the shell could not resolve its
 * own server's port, which is a state `main.js` already handles elsewhere by
 * doing nothing. A window loading `undefined/next/update-window.html` would
 * render a Chromium error page titled "Software Update", which is worse than
 * no window.
 *
 * `show: false` and no `parent`: the caller shows it once the page has
 * painted, so the user never sees an empty white rectangle, and it is NOT a
 * child of the main window because there may be no main window at all. Not
 * `alwaysOnTop` either — an update the user chose to start does not get to sit
 * over their work for two minutes.
 *
 * NO `webPreferences`, deliberately. The main window carries a preload; this
 * page needs nothing from the shell — it reads one HTTP endpoint — so it gets
 * Electron's defaults, which are `contextIsolation: true` and
 * `nodeIntegration: false`. Handing a page Node when it has no use for Node is
 * how a progress display becomes an attack surface.
 *
 * `title` is also the `<title>` of the page itself, which is what macOS ends
 * up showing once the document loads. Both say "Software Update"; the suite
 * reads the HTML file and asserts they still agree, because a window whose
 * title changes half a second after it opens looks like two windows.
 */
export function updateWindowSpec(baseUrl) {
  if (typeof baseUrl !== 'string' || !baseUrl) return null;
  return {
    url: `${baseUrl}${UPDATE_WINDOW_PATH}`,
    width: UPDATE_WINDOW_WIDTH,
    height: UPDATE_WINDOW_HEIGHT,
    title: UPDATE_WINDOW_TITLE,
    resizable: false,
    maximizable: false,
    minimizable: true,
    fullscreenable: false,
    show: false,
  };
}

/**
 * A job snapshot → the Dock bar's value.
 *
 * ── THE BAR IS THE DOWNLOAD, AND EVERYTHING ELSE IS "WORKING" ─────────────
 *
 * `downloading` with a percent is the only state that has a real proportion,
 * and it is the only state that gets one. The percent comes from the ROUTE,
 * which derives it from the two byte counts and sends `null` — never 0 — when
 * the server gave no `content-length`. That distinction survives here:
 * an unknown total produces INDETERMINATE, not a bar pinned at the far left,
 * which is the same fact-versus-absence rule `updateProgressSublabel` applies
 * to the text ("58.2 MB downloaded · total size unknown").
 *
 * `resolving`, `verifying` and `staging` genuinely have no sub-progress —
 * each is one HTTP call, one hash, one move — so they are indeterminate too.
 * They are also brief; the window's own ring is what carries which one is
 * running, and the Dock bar is not asked to say something it cannot know.
 *
 * `installing` CLEARS the bar. Two reasons, and the second is the one that
 * matters: nothing measurable is left, and this process is about to be
 * replaced — a Dock bar frozen at some percentage on an icon whose app has
 * gone is a stuck-looking artefact nobody can dismiss. The window says
 * "Installing" in words at that moment.
 *
 * An unrecognised or absent phase also clears it, for the reason the route
 * gives for ignoring an unknown phase name: a display that renders something
 * it cannot describe is worse than one that shows nothing.
 */
export function dockProgressFor(job) {
  const j = (job && typeof job === 'object') ? job : {};
  const phase = typeof j.phase === 'string' ? j.phase : null;
  if (phase === 'downloading') {
    const pct = (typeof j.percent === 'number' && Number.isFinite(j.percent)) ? j.percent : null;
    if (pct === null) return DOCK_INDETERMINATE;
    // QUANTISED TO WHOLE PERCENT, and that is what makes the controller's
    // throttle real rather than decorative. The route derives `percent` from
    // two byte counts, so it is continuous — every one of the ~550 records a
    // 140 MB download produces carries a different float, and an unquantised
    // value would therefore write to the Dock 550 times to move a bar about
    // 200 points wide. Whole percent is the same granularity the menu label
    // already uses, is the most a bar that size can show, and caps the writes
    // at 101. Measured in the suite rather than asserted here.
    return Math.max(0, Math.min(1, Math.round(pct) / 100));
  }
  if (phase === 'resolving' || phase === 'verifying' || phase === 'staging') return DOCK_INDETERMINATE;
  return DOCK_CLEAR;
}

/**
 * The notification shown at the restart moment.
 *
 * ── WHY THE RESTART AND NOT THE FINISH ─────────────────────────────────────
 *
 * There is no "finish" to notify about. A successful update ends with this
 * process gone; the new one opens its own window and a notification posted
 * milliseconds before `app.exit()` may never be drawn at all. So the moment
 * chosen is the transition into `installing` — the instant the swap is asked
 * for, which is also the last instant this process is reliably alive. The
 * sentence is written for that moment and stays true a second later: the app
 * IS restarting.
 *
 * ── AND WHY IT NEVER FIRES ON A FAILURE ────────────────────────────────────
 *
 * A failure already gets a dialog, from `describeInstallOutcome()`, carrying
 * the server's own sentence and an offer to finish or to open the download
 * page. A banner saying "restarting" beside a dialog saying it did not
 * install would be the two-surfaces contradiction this whole area of the app
 * is a case study in. `createUpdateWindow` fires this ONCE, on the phase
 * transition, and never from the outcome — so there is no path from a failure
 * to this text.
 *
 * `version` is frequently null (an apply-only run never saw a `staged` event
 * carrying one), and the sentence is written so the number is optional rather
 * than rendered as "v" or "vnull".
 */
export function restartNotice(version) {
  const v = (typeof version === 'string' && version.trim()) ? `v${version.trim()}` : null;
  return {
    title: 'The Curator is restarting',
    body: v
      ? `Installing ${v}. The Curator will reopen by itself.`
      : 'Installing the update. The Curator will reopen by itself.',
  };
}

/**
 * The controller. One per install attempt; `main.js` holds it for the life of
 * `runMenuInstall()`.
 *
 * ── WHY IT IS A CLOSURE AND NOT FOUR LOOSE FUNCTIONS ──────────────────────
 *
 * Three pieces of state have to agree: whether a window is open, what the Dock
 * bar was last set to, and whether the restart notification has already fired.
 * Spread across `main.js` those would be three more module-level `let`s in a
 * file `npm test` cannot execute — which is exactly where v3.36.0 found a
 * decision that a mutation could delete invisibly. Here the suite drives the
 * whole sequence and counts the calls.
 *
 * @param {{openWindow?:Function, setDockProgress?:Function, closeWindow?:Function, notify?:Function}} [deps]
 */
export function createUpdateWindow(deps = {}) {
  const d = (deps && typeof deps === 'object') ? deps : {};
  let handle = null;
  let lastDock = null;
  let notified = false;
  /** Counted rather than inferred, so the suite can assert the THROTTLE — the
   *  same measurement `onLabel` carries in update-client.js. */
  let dockWrites = 0;

  /** Call a dep, swallow anything it does. A cosmetic surface must never be
   *  able to fail an update — the rule `runInstall` already applies to its own
   *  label callback ("the menu is not load-bearing"). */
  const safe = (fn, ...args) => {
    if (typeof fn !== 'function') return null;
    try { return fn(...args); } catch { return null; }
  };

  const setDock = (value) => {
    if (handle === null) return;              // no window ⇒ no Dock bar to own
    if (value === lastDock) return;           // the throttle
    lastDock = value;
    dockWrites++;
    safe(d.setDockProgress, handle, value);
  };

  return {
    /**
     * Open the window for this action, if this action installs anything.
     *
     * IDEMPOTENT. `runMenuInstall` is a LOOP — a swap refused because a write
     * was in flight is offered again — so this is called more than once per
     * attempt, and a second window would be a second progress display for one
     * job.
     */
    open(baseUrl, action) {
      if (handle !== null) return true;
      if (!shouldOpenUpdateWindow(action)) return false;
      const spec = updateWindowSpec(baseUrl);
      if (!spec) return false;
      const h = safe(d.openWindow, spec);
      // A dep that returned nothing is a capability that is not there. The
      // update carries on; there is simply no window, which is v3.40.0's
      // behaviour and is survivable.
      if (h === null || h === undefined) return false;
      handle = h;
      return true;
    },

    /**
     * One progress record from the stream. Drives the Dock bar, and fires the
     * restart notification exactly once.
     *
     * THE NOTIFICATION IS KEYED ON THE PHASE, NOT ON THE OUTCOME. `installing`
     * is pushed by `runInstall` immediately before it POSTs `/update/apply`,
     * which is the last moment this process is reliably alive — see
     * `restartNotice`.
     */
    progress(job) {
      const j = (job && typeof job === 'object') ? job : {};
      setDock(dockProgressFor(j));
      if (j.phase === 'installing' && !notified) {
        notified = true;
        // The version rides on the RECORD rather than being held here.
        // `runInstall` learns it from the stream's `staged` event and puts it
        // on the `installing` transition it pushes, so this controller never
        // has to keep a second copy of a fact the client already has.
        safe(d.notify, restartNotice(typeof j.version === 'string' ? j.version : null));
      }
    },

    /**
     * The attempt ended without a restart.
     *
     * The Dock bar is CLEARED on every ending, success or failure — on success
     * because `installing` already cleared it and this is belt and braces, and
     * on failure because a bar left at 43% on a download that stopped is a
     * claim that it is still going.
     *
     * The WINDOW is closed only on a FAILURE. On success it is left standing,
     * saying "Installing", for the second or two until the process is replaced:
     * closing it would blank the screen at the exact moment the user is
     * watching for confirmation, and the process is going away regardless.
     */
    finish(outcome) {
      const ok = Boolean(outcome && outcome.ok === true);
      if (handle !== null) {
        // Straight through `safe`, bypassing `setDock`'s throttle: this must
        // happen even if the last value written was already DOCK_CLEAR.
        lastDock = DOCK_CLEAR;
        safe(d.setDockProgress, handle, DOCK_CLEAR);
        if (!ok) {
          safe(d.closeWindow, handle);
          handle = null;
        }
      }
      return ok;
    },

    /** TEST-ONLY view of the three pieces of state above. Read-only, and it
     *  cannot change anything — the same shape as `__resetUpdateJob`'s
     *  justification: the worst it can do in production is be called. */
    state() {
      return { open: handle !== null, lastDock, notified, dockWrites };
    },
  };
}
