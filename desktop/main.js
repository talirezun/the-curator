/**
 * The Curator — Electron main process.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  RUN FOR THE FIRST TIME ON 2026-08-31, on one machine (macOS 15, arm64).  ║
 * ║  Every claim in this file was originally written from READING the app's   ║
 * ║  source; all of it then held when the file was actually executed. What    ║
 * ║  was measured, and what still is not, is in desktop/README.md.            ║
 * ║                                                                           ║
 * ║  `npm test` cannot run this file — Electron is not an offline-suite       ║
 * ║  dependency — so scripts/test-desktop-packaging.js source-scans it and    ║
 * ║  says so in its own NOT ENFORCED block. Treat a green suite as proof      ║
 * ║  about the CONFIG, never about the app.                                   ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * ── The shape ───────────────────────────────────────────────────────────────
 *
 * `src/server.js` runs UNMODIFIED, in this process, as an ordinary ESM import.
 * It is a script with side effects — it calls `startListen()` at module scope —
 * so importing it IS starting it. Everything it needs from us therefore has to
 * be in `process.env` BEFORE the import, which is why the env writes below sit
 * above `await import(...)` and not next to the window code.
 *
 * ── The two environment variables, and why each one is not optional ─────────
 *
 * PORT             `src/server.js` does `const PORT = process.env.PORT || 3333`
 *                  and then builds ALLOWED_ORIGINS / ALLOWED_HOSTS from that
 *                  same value. Setting it moves the guards with it. We choose a
 *                  free one rather than 3333 so the desktop build and a repo
 *                  checkout can both run — see lib/port.js for the full
 *                  argument, including what that costs.
 *
 * CURATOR_NO_OPEN  `startListen()`'s callback ends with
 *                  `if (!process.env.CURATOR_NO_OPEN) exec('open http://localhost:'+PORT)`.
 *                  Without this every launch opens the user's default BROWSER
 *                  beside the app window, pointed at the same server — two UIs,
 *                  one of which is not the product.
 *
 * ── The URL: read lib/port.js's appUrl() before touching this ───────────────
 *
 * `file://` and custom schemes send `Origin: null`, which the server's
 * cross-origin guard treats as present-and-disallowed → 403 on every mutating
 * request. The whole app would load and do nothing. Do not go there.
 */

import { app, BrowserWindow, Menu, dialog, nativeTheme, screen, shell } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { pickFreePort, appUrl } from './lib/port.js';
import { fetchWriteStatus } from './lib/write-status.js';
import { decideQuit } from './lib/quit-decision.js';
import { applyAboutPanel } from './lib/app-version.js';
import { buildMenuTemplate, SETTINGS_NAV_SELECTOR } from './lib/menu.js';
import { fetchUpdateCheck } from './lib/update-check.js';
import { describeUpdate, ACTION_ID } from './lib/update-verdict.js';
import {
  MIN_WIDTH, MIN_HEIGHT,
  sanitizeWindowState, serializeWindowState, readWindowState, writeWindowState,
} from './lib/window-state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The app root — the directory that contains `src/`, `mcp/` and `node_modules/`.
 *
 * It is PROBED rather than hardcoded because this file sits at a different
 * depth in the two layouts it has to work in, and getting it wrong is a
 * "module not found" at launch with no other symptom:
 *
 *   dev      <repo>/desktop/main.js          → root is ..
 *   packaged Resources/app/main.js           → root is .
 *
 * The packaged layout is flat by construction: electron-builder.yml maps the
 * parent's `src`, `mcp` and `node_modules` into the app root ALONGSIDE this
 * file, so that `src/brain/paths.js`'s own `path.resolve(__dirname, '../..')`
 * lands on the same directory this constant does. Those two derivations must
 * agree or `paths.js` and this file will disagree about where the app is.
 */
const APP_ROOT = existsSync(path.join(__dirname, 'src', 'server.js'))
  ? __dirname
  : path.resolve(__dirname, '..');
const SERVER_ENTRY = path.join(APP_ROOT, 'src', 'server.js');

/** Resolved once `boot()` has picked a port. */
let baseUrl = null;
let mainWindow = null;

// ── About panel ──────────────────────────────────────────────────────────────
//
// The default panel showed `0.0.0 (0.0.0)` and nothing else — reported as "it
// doesn't have any data" — and the number was not a display bug: the packaged
// Info.plist really did say 0.0.0, because electron-builder derives both
// version keys from the app manifest and desktop/package.json is pinned at the
// sentinel.
//
// The whole implementation is in lib/app-version.js so the offline suite can
// EXECUTE it against a stub `app`; this file keeps only the call site, because
// nothing here is importable without Electron. lib/verify-version.mjs is the
// other half — the build-time refusal that stops a wrong version reaching an
// artifact at all.

/**
 * Set once the quit has been authorised, so the `before-quit` handler does not
 * re-ask itself on the second pass. Without this flag, calling `app.quit()`
 * from inside `before-quit` re-enters the same handler and the dialog loops.
 */
let quitAuthorised = false;
/** Guards against two overlapping ⌘Q presses stacking two dialogs. */
let quitCheckInFlight = false;
/** Same shape, for the update check: one dialog, never two. Also drives the
 *  menu item's label and enabled state — see applyMenu(). */
let updateCheckInFlight = false;
/** Resolved in boot() from the app's OWN path resolver, not re-derived here. */
let logsDir = null;

// ── 1. Single instance ───────────────────────────────────────────────────────
//
// This is now the ONLY thing stopping two copies of The Curator writing into
// one `domains/` folder. It used to be a side effect of both copies wanting
// port 3333: the second lost, retried for ~6 s, and exited 1 — with the reason
// written only to a log file, so from the user's side the app simply never
// appeared. A dynamic port removes that accident, so the guard has to be
// explicit, and it has to SAY something.
//
// Taken before the window and before the server import, so the loser never
// binds a port, never touches the wiki and never paints.
if (!app.requestSingleInstanceLock()) {
  // showErrorBox is synchronous and works before `ready`, which is the whole
  // reason it is used here rather than the nicer showMessageBox.
  dialog.showErrorBox(
    'The Curator is already running',
    'Another copy of The Curator is already open on this Mac.\n\n' +
    'Only one copy may run at a time — two copies would write into the same ' +
    'knowledge folder at once.\n\n' +
    'Switch to the window that is already open.'
  );
  // THIS LINE IS NOT DECORATION — without it the second instance CANNOT QUIT.
  // The `before-quit` handler below is registered unconditionally (it has to
  // be: registering event handlers inside a branch is how you end up with a
  // quit path that exists in one code path and not another). On this instance
  // `baseUrl` is still null, so the handler would preventDefault, get no
  // answer from the write-status check, decide 'ask', and put a "Quit now?"
  // dialog in front of a user who is looking at the "already running" error
  // and never asked to quit anything. Authorising the quit up front is what
  // keeps that handler's honest default from misfiring here.
  quitAuthorised = true;
  app.quit();
  // `app.quit()` is asynchronous; process.exit(0) here would skip Electron's
  // own teardown. Returning is not possible at module top level in a way that
  // stops the rest of the file, so the remaining wiring is inside boot(),
  // which the `whenReady` below only reaches on the lock-holding instance.
} else {
  app.on('second-instance', () => { revealWindow(); });

  app.whenReady().then(boot).catch(fatal);
}

// ── 2. Boot ──────────────────────────────────────────────────────────────────

async function boot() {
  // ── The title bar is native, so its COLOUR is a native setting ────────────
  //
  // A real title bar follows the Mac's appearance, and on a light-mode Mac
  // that is a light grey strip directly above an app whose default theme is
  // near-black — the one genuine cost of choosing 'default' over hiddenInset,
  // and it is paid here instead of accepted.
  //
  // This is SAFE for the app's own theming, and that was verified rather than
  // assumed. `nativeTheme.themeSource` drives `prefers-color-scheme` in the
  // renderer — but the `/next` stylesheets do not use that query and are
  // written not to: the shell stamps `data-theme` on <html> in app.js's
  // applyTheme() (both ways, from localStorage, dark by default), and four
  // /next stylesheets carry an explicit in-file PROHIBITION on ever adding a
  // prefers-color-scheme block. So this moves the native chrome and cannot
  // move the app.
  //
  // 'dark' rather than 'system' because it matches the app's default and most
  // common state. The residue is honest and small: a user who switches the app
  // to its LIGHT theme keeps a dark title bar. Making it track the app would
  // need a channel out of the renderer, and the clean one is a
  // `<meta name="theme-color">` that applyTheme() updates — which fires
  // webContents' own `did-change-theme-color`, a standard web-platform event
  // rather than a private selector. That is an app-CSS/app-JS change and is
  // reported in desktop/README.md, not made here.
  nativeTheme.themeSource = 'dark';

  // Before the window, so the App menu's "About The Curator" item is correct
  // the first time it is opened. It reads nothing that depends on the server.
  applyAboutPanel(app, APP_ROOT);

  // The menu goes up NOW, before the port scan and before the server import,
  // so the menu bar is never briefly Electron's default one. Its handlers read
  // `baseUrl` and `logsDir` at CLICK time, both of which are still null here —
  // and both of those cases answer honestly rather than throwing
  // (fetchUpdateCheck(null) resolves to its "wait a moment and try again"
  // body, which is exactly true during the second this window is open).
  applyMenu();

  const port = await pickFreePort();
  baseUrl = appUrl(port);

  // MUST precede the import — `src/server.js` reads both at module scope.
  process.env.PORT = String(port);
  process.env.CURATOR_NO_OPEN = '1';

  // Start the app. This is the whole backend: one import, no child process, no
  // second Node runtime. `pathToFileURL` because a Windows path is not a valid
  // ESM specifier; this file is macOS-first but the conversion costs nothing.
  await import(pathToFileURL(SERVER_ENTRY).href);

  // Hand the shell's native capabilities to the server. They are in the SAME
  // Node realm — the import above ran `src/server.js` in this process — so a
  // module registry is a real channel, not a message bus. The specifier is
  // resolved from the same APP_ROOT as SERVER_ENTRY on purpose: a different
  // specifier gives a second module instance and a registry nobody reads.
  const { registerDesktopHost } =
    await import(pathToFileURL(path.join(APP_ROOT, 'src', 'brain', 'desktop-host.js')).href);
  registerDesktopHost({
    pickFolder: async ({ prompt }) => {
      const r = await dialog.showOpenDialog(mainWindow, {
        title: prompt,
        properties: ['openDirectory', 'createDirectory'],
      });
      return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
    },
    relaunch: () => { quitAuthorised = true; app.relaunch(); app.exit(0); },
  });

  // Where Help ▸ Show Logs points. Read from the app's OWN resolver — the same
  // module `src/brain/logger.js` writes through — rather than re-typing
  // `~/Library/Logs/The Curator` here. Two copies of a path is how they drift,
  // and getLogsDir() deliberately does NOT fork on install mode, so there is
  // exactly one right answer and this is it. Resolved through the same
  // APP_ROOT as everything else so it is the same module instance the server
  // is using, not a second copy with its own test overrides.
  try {
    const { getLogsDir } =
      await import(pathToFileURL(path.join(APP_ROOT, 'src', 'brain', 'paths.js')).href);
    logsDir = getLogsDir();
  } catch {
    // Non-fatal by design: a shell that cannot resolve the log folder still
    // runs the app. The menu item says so when it is clicked.
    logsDir = null;
  }

  createWindow();
}

// ── 2b. The application menu ─────────────────────────────────────────────────
//
// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║  THE STRUCTURE IS IN lib/menu.js. ONLY THE WIRING IS HERE.                ║
// ╚═══════════════════════════════════════════════════════════════════════════╝
//
// Same split, and the same reason, as decideQuit() and applyAboutPanel():
// Electron is not an offline-suite dependency, so nothing in this file can be
// executed by `npm test`. `Menu.buildFromTemplate` takes plain objects, so the
// entire menu — every label, accelerator, role and ordering decision — is
// ordinary data that scripts/test-desktop-menu.js builds and inspects for
// real. What is left here is the two Electron calls and the five handlers.
//
// The menu is REBUILT rather than mutated when the update check starts and
// finishes. Mutating a live MenuItem's label works on macOS but is a second
// mechanism doing the same job as the builder, and the builder is the one the
// suite can see. Rebuilding is one function call and cannot get out of step
// with the flag it reads.

/** Build the template from the current state and install it. */
function applyMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate({
    appName: app.name,
    checking: updateCheckInFlight,
    // Every click handler is wrapped so no promise escapes into Electron's
    // menu dispatcher. A floating rejection there is an unhandled rejection in
    // the main process, which in a packaged app is an invisible failure.
    onCheckForUpdates: () => { void checkForUpdates(); },
    onOpenSettings: () => { void openSettingsView(); },
    onRevealWindow: () => { revealWindow(); },
    onOpenUrl: (url) => { void shell.openExternal(url).catch(() => {}); },
    onShowLogs: () => { void showLogs(); },
  })));
}

/**
 * The JS the shell runs in the renderer to reach the Settings view.
 *
 * Built from the exported selector rather than typed inline, and serialised
 * with JSON.stringify so the string cannot break out of its own literal.
 *
 * IT RETURNS A BOOLEAN, and that is the whole reason this is acceptable where
 * `insertCSS` was not (see the block above createWindow). An injected
 * stylesheet cannot report whether its selector matched; this can, so the
 * shell knows when the coupling has rotted and SAYS so, instead of presenting
 * a menu item that silently does nothing.
 */
const SETTINGS_CLICK_JS =
  '(() => { const el = document.querySelector(' + JSON.stringify(SETTINGS_NAV_SELECTOR) + ');' +
  ' if (!el) return false; el.click(); return true; })()';

/**
 * Resolve once a webContents has stopped loading, or after `timeoutMs`.
 *
 * Needed because `revealWindow()` legitimately CREATES the window when the
 * previous one was destroyed, and `loadURL` is asynchronous — so without this,
 * ⌘, on a destroyed window injects its click into a blank page, finds nothing,
 * and shows the "did not respond" error for a window that was about to work.
 * Found by reading the call path, not by running it.
 *
 * A timeout rather than an unbounded wait: a page that never finishes loading
 * must still produce the honest error instead of a menu item that hangs.
 */
function waitForLoad(wc, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(); };
    const timer = setTimeout(done, timeoutMs);
    wc.once('did-finish-load', done);
    wc.once('did-fail-load', done);
  });
}

/** ⌘, — bring the window forward and put the user on the Settings view. */
async function openSettingsView() {
  revealWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.webContents.isLoading()) await waitForLoad(mainWindow.webContents);
  if (!mainWindow || mainWindow.isDestroyed()) return;
  let landed = false;
  try {
    // `true` = treat as a user gesture. The click itself does not need it, but
    // this IS a user gesture and mis-declaring it is how a future action that
    // does need one fails for no visible reason.
    landed = await mainWindow.webContents.executeJavaScript(SETTINGS_CLICK_JS, true) === true;
  } catch {
    landed = false;
  }
  if (landed) return;
  dialog.showErrorBox(
    'Could not open Settings',
    'The Curator’s window did not respond to the menu.\n\n' +
    'Open Settings with the gear button at the bottom of the left-hand rail.'
  );
}

/** Help ▸ Show Logs. */
async function showLogs() {
  if (!logsDir) {
    dialog.showErrorBox(
      'The log folder is not available yet',
      'The Curator has not finished starting up. Try again in a moment.'
    );
    return;
  }
  // openPath resolves with an ERROR STRING rather than rejecting, and it
  // returns one when the folder does not exist — which is the normal state
  // until the logger's first lazy write. Reported with the path, so the user
  // can look for it themselves rather than being told "it failed".
  let err = '';
  try { err = await shell.openPath(logsDir); } catch (e) { err = (e && e.message) || String(e); }
  if (err) {
    dialog.showErrorBox('Could not open the log folder', `${logsDir}\n\n${err}`);
  }
}

/**
 * ── "Check for Updates…", and why it answers HERE rather than navigating ────
 *
 * The three options, and what each one costs:
 *
 *   (a) Navigate to Settings ▸ General and start the check there.
 *       Rejected. The panel renders five states well, but a menu item that
 *       silently swaps the visible view has no way to say the most common
 *       answer — "you are up to date" — without the user hunting for where it
 *       appeared. And it needs TWO renderer couplings landing in order (mount
 *       the view, then click a button inside it that does not exist until the
 *       view has rendered), which is a race across a re-render.
 *
 *   (b) Answer in a native dialog. CHOSEN. "Check for Updates…" is a macOS
 *       idiom with a fixed meaning, and the ellipsis promises a dialog. It
 *       works with no window open, it cannot be missed, and the one action it
 *       offers is the one the user came for.
 *
 *   (c) Both. Rejected — two things happening from one click is how a menu
 *       item comes to feel unpredictable.
 *
 * WHAT IS NOT DUPLICATED, which is the constraint this had to satisfy: which
 * release is newest, whether it is newer than this build, whether the versions
 * can be compared at all, whether anything is published, the release URL, and
 * every failure sentence. All of those arrive on the wire from
 * GET /api/config/update-check, which is the only side that read the release
 * list. lib/update-verdict.js contains no version comparator, and the suite
 * asserts that.
 *
 * WHAT IS: four short headline sentences that also exist in Settings ▸ General.
 * Bounded, named in desktop/README.md, and accepted.
 */
async function checkForUpdates() {
  if (updateCheckInFlight) return;
  updateCheckInFlight = true;
  // The menu bar IS the progress indicator: the item relabels to "Checking for
  // Updates…" and disables. This costs nothing, needs no window, and closes
  // the gap the maintainer would otherwise see — a live GitHub call with a
  // 12-second ceiling behind a menu item that looked unchanged.
  applyMenu();

  try {
    const verdict = describeUpdate(await fetchUpdateCheck(baseUrl));

    const opts = {
      type: verdict.type,
      buttons: verdict.buttons,
      defaultId: verdict.defaultId,
      cancelId: verdict.cancelId,
      title: 'Software Update',
      message: verdict.message,
      detail: verdict.detail,
      // Stop macOS pulling a button out of the row and rendering it as a link
      // because its label happens to look like one.
      noLink: true,
    };

    // Window-modal ONLY when the window is actually on screen. A sheet
    // attached to a hidden window (⌘W leaves one behind — see the close
    // handler) or a minimised one is invisible, so the app would appear frozen
    // with a permanently disabled menu item and no way to dismiss anything.
    const attachable = mainWindow && !mainWindow.isDestroyed()
      && mainWindow.isVisible() && !mainWindow.isMinimized();
    const { response } = attachable
      ? await dialog.showMessageBox(mainWindow, opts)
      : await dialog.showMessageBox(opts);

    if (response !== ACTION_ID || !verdict.action) return;
    if (verdict.action.type === 'open-url') {
      await shell.openExternal(verdict.action.url);
    } else if (verdict.action.type === 'open-settings') {
      await openSettingsView();
    }
  } catch (err) {
    // fetchUpdateCheck never rejects and describeUpdate is pure, so reaching
    // here means Electron's own dialog or shell call failed. Say so rather
    // than leaving a menu item that appears to do nothing.
    dialog.showErrorBox(
      'Could not check for updates',
      (err && err.message) ? err.message : String(err)
    );
  } finally {
    updateCheckInFlight = false;
    applyMenu();
  }
}

// ── 3. The window ────────────────────────────────────────────────────────────
//
// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║  WHY THERE IS A REAL TITLE BAR, AND WHY hiddenInset CANNOT COME BACK      ║
// ║  UNTIL THE APP'S OWN CSS CARRIES A DRAG REGION.                           ║
// ╚═══════════════════════════════════════════════════════════════════════════╝
//
// v3.30.0 shipped `titleBarStyle: 'hiddenInset'` and it produced three defects
// at once, all reported from the packaged app on first use:
//
//   1. macOS drew the traffic lights OVER the web content. Measured in the
//      running app: the rail is (0,0,60x860) and its logo mark is
//      (17,12,26x26) — the exact rectangle hiddenInset puts the close/
//      minimise/zoom buttons in. The screenshot shows red and yellow sitting
//      ON the mark and green escaped onto the "Chat" heading.
//   2. Nothing was draggable. Measured, not assumed: a CDP sweep of every
//      element in the live renderer found `-webkit-app-region: drag` on ZERO
//      of them. hiddenInset removes the title bar and hands the app the job of
//      replacing it; the app never took the job.
//   3. The window was hard to grab to resize, which is the same wound — with
//      no title bar and no drag region, the only handle on a 1280x860 window
//      is a ~4px border the user has to hunt for.
//
// ── WHY NOT trafficLightPosition ────────────────────────────────────────────
//
// It fixes (1) only if there is somewhere free to put the buttons, and in this
// shell there is not. The Curator's navigation is a VERTICAL rail spanning
// y 0 -> 860 at x 0 -> 60; there is no empty horizontal strip anywhere along
// the top. Move the lights down and they land on the rail's own nav buttons;
// move them right and they land on the view header. Making room means adding a
// top inset to the app's layout — a change in `src/public/next/**`, which is
// not this file's to make. And it fixes neither (2) nor (3) at all.
//
// ── WHY NOT titleBarStyle:'hidden' + titleBarOverlay ────────────────────────
//
// Checked against the installed Electron's own typings rather than from
// memory: `TitleBarOverlay.color` and `.symbolColor` are `@platform
// win32,linux`. On macOS the option only switches ON the Window Controls
// Overlay CSS environment variables and the `navigator.windowControlsOverlay`
// API — it paints nothing and it creates no drag region. Consuming those env
// vars is, again, app CSS.
//
// ── WHY NOT INJECT THE DRAG REGION WITH webContents.insertCSS ───────────────
//
// It is the one option that stays inside this file, and it was rejected on
// three counts, not on taste:
//   · It would have to be keyed on the app's own selectors (`#rail`, the
//     header) while another agent is editing those files this wave. The day
//     one is renamed the window silently stops being draggable, and the guard
//     could only ever assert that a CSS STRING was inserted — it cannot assert
//     the selector matched anything. That is precisely the vacuous source scan
//     this repo keeps re-learning about.
//   · `-webkit-app-region: drag` makes every descendant unclickable unless
//     each is walked back with `no-drag`. The zone in question contains the
//     logo and all seven rail buttons — the app's primary navigation. Getting
//     one selector wrong trades a cosmetic defect for a dead nav.
//   · It still would not fix (1). The overlap needs the app's content pushed
//     down, which is a layout change, not an injected rule.
//
// A frameless design is the right long-term answer and it belongs with the app
// CSS that has to carry it. Until then the title bar does all three jobs
// correctly and immediately: the buttons get their own strip, the whole bar is
// a drag handle a first-time user does not have to be taught, and the window
// gains the standard double-click-to-zoom the previous build also lacked.
function createWindow() {
  const workAreas = screen.getAllDisplays().map((d) => d.workArea);
  const wanted = sanitizeWindowState(readWindowState(app.getPath('userData')), workAreas);

  mainWindow = new BrowserWindow({
    width: wanted.width,
    height: wanted.height,
    // Both or neither — sanitizeWindowState drops a position it cannot prove
    // is still reachable, and an absent x/y makes the OS centre the window.
    ...(Number.isInteger(wanted.x) && Number.isInteger(wanted.y) ? { x: wanted.x, y: wanted.y } : {}),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    // `titleBarStyle` is stated rather than omitted. 'default' IS the default,
    // so this line changes no behaviour on its own — it exists so that the
    // reasoning above has something to hang on, and so the guard suite can
    // assert the value rather than assert an absence.
    titleBarStyle: 'default',
    backgroundColor: '#12121a',
    webPreferences: {
      // The renderer is the app's OWN frontend, served over loopback. It has
      // never needed Node and must not get it: everything it does goes through
      // the HTTP API, which is the surface that carries the guards.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (wanted.maximized) mainWindow.maximize();

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  // ── Remember size and position ───────────────────────────────────────────
  //
  // Saved on a debounce from move/resize rather than only on close, because
  // only-on-close loses everything to a crash or a Force Quit — and Force Quit
  // is exactly what a user reaches for when something has gone wrong, i.e. the
  // moment they are most likely to relaunch and notice.
  //
  // getNormalBounds(), not getBounds(): while maximised the latter reports the
  // screen, which would overwrite the size the user actually chose with one
  // they never picked.
  let saveTimer = null;
  const persist = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    // Full screen is not persisted (see lib/window-state.js) and its bounds
    // are the display, so skip the sample entirely rather than record it.
    if (mainWindow.isFullScreen()) return;
    writeWindowState(app.getPath('userData'), serializeWindowState(
      mainWindow.getNormalBounds(), { maximized: mainWindow.isMaximized() },
    ));
  };
  const persistSoon = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 400);
  };
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) mainWindow.on(ev, persistSoon);
  // 'close' fires while the window still exists; 'closed' is too late to read
  // bounds off it. Cancel the pending debounce so it cannot fire afterwards
  // against a destroyed window.
  mainWindow.on('close', () => { clearTimeout(saveTimer); persist(); });

  // ── ⌘W must not strand the app ───────────────────────────────────────────
  //
  // The DEFAULT Electron menu was dumped from a running Electron 43.5.0 rather
  // than recalled: File holds exactly one item, "Close Window" (⌘W, role
  // `close`), and NOTHING in the whole menu creates a window. With
  // `window-all-closed` correctly not quitting on darwin, ⌘W therefore left a
  // running, windowless app whose only route back was a Dock click — a gesture
  // that is real (`activate`, below) but undiscoverable, and an app whose
  // window vanished reads as an app that quit.
  //
  // Fixed here rather than by rebuilding the menu, which this pass is not for:
  // on macOS a close that is not part of a quit HIDES the window instead of
  // destroying it. The Dock icon, ⌘Tab and a second launch all bring it back —
  // and bring it back with the renderer's state intact, which destroying and
  // re-creating would have thrown away. `quitAuthorised` is what keeps ⌘Q
  // working: during a real quit the close is allowed through.
  //
  // Scoped to darwin because on Windows and Linux closing the last window
  // SHOULD quit, which is what the window-all-closed handler below does.
  mainWindow.on('close', (event) => {
    if (quitAuthorised || process.platform !== 'darwin') return;
    event.preventDefault();
    mainWindow.hide();
  });

  // Anything the page tries to open in a new window goes to the real browser.
  // Without this, an external link opens a chrome-less Electron window with no
  // address bar, which is both a bad experience and a phishing surface.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadURL(baseUrl);
}
// ── Restart ──────────────────────────────────────────────────────────────────
//
// There is NO interceptor here any more, and its absence is the point.
//
// This file previously cancelled `POST /api/restart` at the HTTP layer with
// `session.webRequest.onBeforeRequest`, because the route spawned
// `process.execPath` — which under Electron is the app binary, so it produced a
// second window rather than a server. That was a workaround and said so.
//
// The route now branches on the `restartStyle` capability and calls the
// `relaunch` hook registered above. The interceptor had to GO rather than stay
// as belt-and-braces: it cancelled the request BEFORE Express, so the real
// branch could never run and the workaround would have silently won. Two
// mechanisms for one job, where the worse one executes first, is not redundancy.
//
// It also only ever caught the RENDERER. A restart from curl, a script or the
// MCP took the broken path; the route-level branch covers all of them.


// ── 4. Quit ──────────────────────────────────────────────────────────────────
//
// ⌘Q is one keystroke. A multi-phase ingest is 20+ paid LLM calls over several
// minutes. `GET /api/write-status` (v3.26.0) exists precisely so this handler
// can tell those apart; the decision itself is in lib/quit-decision.js so it
// can be tested without a window. Read that file for why `safeToQuit: null`
// is its own case rather than being folded into "safe" or "busy".
app.on('before-quit', (event) => {
  if (quitAuthorised) return;
  event.preventDefault();
  if (quitCheckInFlight) return;
  quitCheckInFlight = true;

  (async () => {
    const status = baseUrl ? await fetchWriteStatus(baseUrl) : null;
    const decision = decideQuit(status);

    if (decision.action === 'quit') {
      quitAuthorised = true;
      app.quit();
      return;
    }

    const lines = [decision.detail];
    if (decision.operations.length) {
      lines.push('', ...decision.operations);
      const hidden = decision.operationsTotal - decision.operations.length;
      if (hidden > 0) lines.push(`…and ${hidden} more`);
    }

    // Window-modal when there is a window, app-modal when there is not. Passing
    // `undefined` as the window argument is not the same call signature and is
    // not worth relying on.
    const opts = {
      type: 'warning',
      buttons: ['Keep working', 'Quit anyway'],
      // Both defaults point at the SAFE option. A dialog that defaults to the
      // destructive button turns "⌘Q, Return" into data loss.
      defaultId: decision.defaultIsQuit ? 1 : 0,
      cancelId: 0,
      title: 'Quit The Curator?',
      message: 'Quit now?',
      detail: lines.join('\n'),
    };
    const { response } = mainWindow
      ? await dialog.showMessageBox(mainWindow, opts)
      : await dialog.showMessageBox(opts);

    if (response === 1) {
      quitAuthorised = true;
      app.quit();
    }
  })()
    .catch((err) => {
      // A failure to ASK is not a licence to quit. Leave the app running and
      // say why — the user can try again, or quit from the Dock.
      dialog.showErrorBox('Could not check for writes in progress',
        `The Curator did not quit, because it could not confirm that no work was in flight.\n\n${err && err.message ? err.message : String(err)}`);
    })
    .finally(() => { quitCheckInFlight = false; });
});

// macOS convention: closing the last window does not quit the app.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => { revealWindow(); });

/**
 * Put the one window in front of the user, whatever state it is in.
 *
 * This is the single recovery path, reached from a Dock click (`activate`) and
 * from a second launch (`second-instance`). It has to cover THREE states, and
 * the pre-existing version covered only one of them:
 *
 *   destroyed   ⌘Q was never pressed but the window is gone     -> re-create
 *   hidden      ⌘W or the red button, since this release        -> show
 *   minimised   the yellow button or ⌘M                         -> restore
 *
 * The old handler tested `getAllWindows().length === 0`, which is FALSE for a
 * hidden window — so with the ⌘W fix above and nothing here, the Dock click
 * that used to re-create the window would have done nothing at all. The two
 * changes are a pair; neither is correct alone.
 */
function revealWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    // Only re-creatable once boot() has a URL to load. Before that there is
    // nothing to show and creating a window would race the server import.
    if (baseUrl) createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

function fatal(err) {
  dialog.showErrorBox(
    'The Curator could not start',
    (err && err.stack) ? err.stack : String(err)
  );
  app.exit(1);
}
