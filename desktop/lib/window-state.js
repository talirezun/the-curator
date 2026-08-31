/**
 * window-state.js — remember the window's size and position between launches.
 *
 * ── Why this is a separate, electron-free module ────────────────────────────
 *
 * Same reason as lib/quit-decision.js: `npm test` cannot import `main.js`,
 * because Electron is deliberately not an offline-suite dependency. A guard
 * that could only grep main.js for the word "window-state" would prove a line
 * was written, never that it behaves — the shape CLAUDE.md names at v3.0.17
 * ("assert behaviour, not the presence of a line of source").
 *
 * So every decision lives here, importing nothing from Electron and nothing
 * from `src/`. The one thing this module cannot know — where the user's
 * displays are — is passed IN as an array of work-area rectangles.
 * `scripts/test-desktop-packaging.js` §12 EXECUTES all of it.
 *
 * ── Where the file goes, and why not desktop/ ───────────────────────────────
 *
 * `app.getPath('userData')` — on macOS `~/Library/Application Support/The
 * Curator/window-state.json`. NOT inside `desktop/`, and that is not a
 * preference: an installed `.app` is READ-ONLY, so a write next to the code
 * would fail in the one build that matters, and in the repo layout it would
 * put a per-machine file inside a git checkout. It is also deliberately NOT
 * under `getUserDataDir()` from `src/brain/paths.js`: this is shell chrome,
 * not Curator knowledge, it must never travel through Personal Sync, and
 * `src/` is not this change's to reach into.
 *
 * ── THE RULE THAT MATTERS: A RESTORED WINDOW MUST BE REACHABLE ──────────────
 *
 * The failure this module exists to prevent is not "the size is wrong", it is
 * "the window is off-screen and the user cannot get it back". Close the app on
 * a second monitor, unplug the monitor, relaunch: a naive restore puts the
 * window at x=2400 on a machine whose only display ends at 1512, and there is
 * no menu item, no keystroke and no Dock gesture that recovers it. The app
 * looks like it failed to start.
 *
 * So a saved POSITION is adopted only when the rectangle still overlaps a real
 * work area by MIN_ONSCREEN_PX on BOTH axes, and only when its top edge is at
 * or below that work area's top. Anything else drops x/y — and dropping x/y is
 * a safe, silent, correct outcome, because a BrowserWindow created without
 * them is centred by the OS. A saved SIZE is kept in that case: the size is
 * never the thing that strands a window, and it is the half the user notices.
 *
 * ── What is deliberately NOT persisted ──────────────────────────────────────
 *
 * Full screen. Restoring into full screen hides the menu bar and the Dock on a
 * launch the user did not ask for it, and Electron's own full-screen restore
 * races `ready-to-show`. `maximized` IS persisted — it is unmistakable,
 * reversible with one click, and cheap to get right.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/** First-run geometry. The shell has always opened at this size. */
export const DEFAULT_WIDTH = 1280;
export const DEFAULT_HEIGHT = 860;

/**
 * Floor on window size.
 *
 * NOT arbitrary, and NOT the browser app's breakpoint. v3.16.1 recorded the
 * `/next` shell COLLAPSING at a 375px viewport, so a desktop window that can
 * be dragged down to phone width would reproduce a known-broken layout with no
 * way for the app to refuse. 960x600 was checked by hand against this build:
 * the 60px rail, the conversation sidebar and the main pane all still render
 * and the composer is still reachable. Raise these if a view is ever found
 * that needs more; never lower them without re-checking that view.
 */
export const MIN_WIDTH = 960;
export const MIN_HEIGHT = 600;

/**
 * How much of the window must remain on a real display for its saved position
 * to be trusted, on each axis independently. 96px is roughly a grabbable strip
 * of title bar — enough that the user can drag the window back into view.
 */
export const MIN_ONSCREEN_PX = 96;

/** The basename under userData. */
export const WINDOW_STATE_FILE = 'window-state.json';

const isInt = (n) => Number.isInteger(n) && Number.isFinite(n);

/** Overlap of two 1-D intervals, in pixels. Never negative. */
function overlap1d(aStart, aLen, bStart, bLen) {
  return Math.max(0, Math.min(aStart + aLen, bStart + bLen) - Math.max(aStart, bStart));
}

/**
 * Is a rectangle reachable on at least one of these work areas?
 *
 * @param {{x:number,y:number,width:number,height:number}} rect
 * @param {Array<{x:number,y:number,width:number,height:number}>} workAreas
 */
export function isOnScreen(rect, workAreas) {
  if (!Array.isArray(workAreas) || workAreas.length === 0) return false;
  return workAreas.some((wa) => {
    if (!wa || !isInt(wa.x) || !isInt(wa.y) || !isInt(wa.width) || !isInt(wa.height)) return false;
    const dx = overlap1d(rect.x, rect.width, wa.x, wa.width);
    const dy = overlap1d(rect.y, rect.height, wa.y, wa.height);
    if (dx < MIN_ONSCREEN_PX || dy < MIN_ONSCREEN_PX) return false;
    // The top edge must not be ABOVE the work area. A work area already
    // excludes the menu bar, so this is exactly "the title bar is grabbable".
    return rect.y >= wa.y;
  });
}

/**
 * Turn whatever was on disk into geometry a BrowserWindow can be constructed
 * with. Never throws; every unusable input degrades to the default.
 *
 * @param {any} raw            parsed JSON, or null/undefined when there is none
 * @param {Array<{x:number,y:number,width:number,height:number}>} workAreas
 * @returns {{width:number,height:number,x?:number,y?:number,maximized:boolean}}
 */
export function sanitizeWindowState(raw, workAreas) {
  const out = { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, maximized: false };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;

  // ── size ─────────────────────────────────────────────────────────────────
  // Clamped UP to the minimum and DOWN to the largest work area, so a window
  // saved on a 5K display cannot come back larger than the laptop it is now on.
  const areas = Array.isArray(workAreas) ? workAreas.filter(
    (wa) => wa && isInt(wa.x) && isInt(wa.y) && isInt(wa.width) && isInt(wa.height),
  ) : [];
  const maxW = areas.length ? Math.max(...areas.map((wa) => wa.width)) : Infinity;
  const maxH = areas.length ? Math.max(...areas.map((wa) => wa.height)) : Infinity;

  if (isInt(raw.width) && raw.width > 0) {
    out.width = Math.max(MIN_WIDTH, Math.min(raw.width, Math.max(MIN_WIDTH, maxW)));
  }
  if (isInt(raw.height) && raw.height > 0) {
    out.height = Math.max(MIN_HEIGHT, Math.min(raw.height, Math.max(MIN_HEIGHT, maxH)));
  }

  out.maximized = raw.maximized === true;

  // ── position ─────────────────────────────────────────────────────────────
  // Both or neither. A half-restored position is worse than none: it pins one
  // axis to a stale display and lets the OS pick the other.
  if (isInt(raw.x) && isInt(raw.y)) {
    const rect = { x: raw.x, y: raw.y, width: out.width, height: out.height };
    if (isOnScreen(rect, areas)) { out.x = raw.x; out.y = raw.y; }
  }
  return out;
}

/**
 * The object to write. Takes the window's NORMAL bounds — the pre-maximise
 * ones — so a maximised session does not overwrite the size the user chose.
 *
 * @param {{x:number,y:number,width:number,height:number}} normalBounds
 * @param {{maximized?:boolean}} [flags]
 */
export function serializeWindowState(normalBounds, flags = {}) {
  const b = normalBounds || {};
  return {
    x: isInt(b.x) ? b.x : undefined,
    y: isInt(b.y) ? b.y : undefined,
    width: isInt(b.width) ? b.width : DEFAULT_WIDTH,
    height: isInt(b.height) ? b.height : DEFAULT_HEIGHT,
    maximized: flags.maximized === true,
  };
}

/**
 * Read the state file. Returns null for "no usable file" — missing, empty,
 * unreadable, or not JSON are all the same answer to the caller, and none of
 * them is worth an exception on a launch path.
 *
 * @param {string} dir the userData directory
 */
export function readWindowState(dir) {
  try {
    const text = readFileSync(path.join(dir, WINDOW_STATE_FILE), 'utf8');
    // A 64 KB ceiling on what is a ~90-byte document. Cheap insurance against
    // parsing something that is not this file at all.
    if (typeof text !== 'string' || text.length > 64 * 1024) return null;
    const parsed = JSON.parse(text);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Write the state file. Returns true on success, false on any failure —
 * NEVER throws. This runs from window `move`/`resize`/`close` handlers, where
 * an exception is an unhandled rejection in the main process, and losing a
 * remembered window size is not worth one.
 *
 * @param {string} dir the userData directory
 * @param {object} state the object from serializeWindowState()
 */
export function writeWindowState(dir, state) {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, WINDOW_STATE_FILE), JSON.stringify(state), 'utf8');
    return true;
  } catch {
    return false;
  }
}
