/**
 * shell-platform.js — every decision the desktop shell makes DIFFERENTLY on
 * Windows, as pure functions of a platform string.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  WHY THIS FILE EXISTS                                                     ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * `main.js` cannot be imported, evaluated or run by `npm test` (Electron is not
 * an offline dependency), and nobody on this project can run Windows. So a
 * Windows branch written inline in main.js would be doubly unprovable: no
 * suite could execute it and no developer could watch it. Every fork on
 * `process.platform` that main.js needs is therefore decided HERE, as data,
 * and the suite (`scripts/test-desktop-shell-win32.js`) drives each one with
 * an injected platform. main.js keeps only the Electron calls.
 *
 * ── THE MAC IS THE FIXED POINT ─────────────────────────────────────────────
 *
 * For `darwin` every function here returns exactly what main.js did before
 * Windows existed, and the suite pins those answers. The Mac's own close
 * handler and window-all-closed handler are NOT routed through this file at
 * all — they stay as they were, character for character, because
 * `scripts/test-desktop-packaging.js` pins their text — and the Windows
 * behaviour is an ADDITIONAL listener whose decision is
 * `closeHidesToTray()` below, which answers false on every platform but win32.
 *
 * Linux is not a shipped target. Where it matters it keeps the pre-existing
 * non-darwin behaviour; nothing here was designed for it.
 */

/**
 * The Windows AppUserModelID. MUST equal electron-builder.yml's `appId`:
 * NSIS stamps the Start-menu and Desktop shortcuts with the appId as their
 * AUMID, and Windows attributes toasts (and taskbar grouping) to a process by
 * matching the AUMID it declared against a shortcut's. A mismatch means
 * notifications either do not show or show under the wrong name. Agreed with
 * the build package (E) on 2026-11-20; the suite reads the yml and compares.
 */
export const APP_USER_MODEL_ID = 'com.talirezun.the-curator';

/** The AUMID to declare on this platform, or null when none applies. */
export function appUserModelIdFor(platform) {
  return platform === 'win32' ? APP_USER_MODEL_ID : null;
}

/**
 * What a person calls the computer they are sitting at, as the app writes it.
 * The Mac wording is the pre-existing text, unchanged.
 */
export function hostNoun(platform) {
  return platform === 'win32' ? 'this PC' : 'this Mac';
}

/** What the system file browser is called — for "Reveal … in Finder". */
export function fileBrowserName(platform) {
  return platform === 'win32' ? 'File Explorer' : 'Finder';
}

/**
 * The "already running" error box shown by the SECOND copy. The darwin text is
 * byte-identical to the literal main.js carried before Windows.
 */
export function singleInstanceMessage(platform) {
  return {
    title: 'The Curator is already running',
    body:
      'Another copy of The Curator is already open on ' + hostNoun(platform) + '.\n\n' +
      'Only one copy may run at a time — two copies would write into the same ' +
      'knowledge folder at once.\n\n' +
      'Switch to the window that is already open.',
  };
}

/**
 * Should a window CLOSE be turned into a hide, on Windows?
 *
 * The rule the owner set (2026-11-20): on Windows, closing the window hides it
 * to the tray ONLY while the tray icon is actually there. Without a tray icon a
 * hidden window would leave a running app with no way back but a second launch
 * — on Windows 11 the tray icon may itself sit in the overflow flyout, which is
 * why "the tray is on" means a live Tray object, not the setting.
 *
 * Without the tray the close is allowed through, the last window closes,
 * `window-all-closed` calls `app.quit()`, and `before-quit` runs the existing
 * write-status guard — so a paid ingest is never cut off by the X button.
 *
 * Answers FALSE on darwin by construction: the Mac has its own close handler
 * (hide unless quitting) that predates this and is not touched.
 *
 * `sessionEnding`: Windows is logging off or shutting down. Hiding then would
 * hold the session open ("This app is preventing shutdown"), and there is no
 * user left to come back to the window anyway.
 */
export function closeHidesToTray({ platform, quitAuthorised = false, trayActive = false, sessionEnding = false } = {}) {
  if (platform !== 'win32') return false;
  if (quitAuthorised || sessionEnding) return false;
  return trayActive === true;
}

/**
 * Should a modal dialog be attached to the main window, or be app-modal?
 *
 * On Windows a message box owned by a HIDDEN window (the window hidden to the
 * tray) is a dialog the person may never see, and its owner cannot be brought
 * forward to reveal it. So on win32 the dialog is attached only while the
 * window is on screen. On darwin the answer is the pre-existing one — attach
 * whenever a window exists — returned unchanged so the Mac quit dialog is
 * byte-identical in behaviour.
 */
export function attachDialogToWindow({ platform, hasWindow = false, visible = false, minimized = false } = {}) {
  if (!hasWindow) return false;
  if (platform !== 'win32') return true;
  return visible === true && minimized !== true;
}

/**
 * How the tray icon is driven on this platform.
 *
 * ── macOS (unchanged) ──────────────────────────────────────────────────────
 * A template image; the context menu is SET on the tray, so a left or right
 * click opens it; `mouse-enter` re-renders from memory so the ages are exact
 * when the menu appears; both clicks re-read the index and may ask GitHub.
 *
 * ── Windows ────────────────────────────────────────────────────────────────
 * Windows conventions: LEFT click shows the window, RIGHT click opens the
 * menu. The menu is NOT set with `setContextMenu`, it is POPPED on
 * `right-click` with `popUpContextMenu(menu)`, for two reasons:
 *
 *   1. Freshness. There is no "menu will open" event on a Tray. On Windows the
 *      right-click handler runs BEFORE the menu is shown when we pop it
 *      ourselves, so the menu is rebuilt from the in-memory snapshot first and
 *      every age in it is exact at the moment it appears. This does not rely
 *      on `mouse-enter`, which Electron 43's typings list for win32 but which
 *      nobody on this project has seen fire on a Windows tray.
 *   2. Electron's Windows notify icon pops a menu set with `setContextMenu`
 *      itself on a right click; with a menu set, our own right-click handler
 *      is not the thing that opens it, so (1) could not be guaranteed.
 *      (Read from Electron's documentation and source knowledge, not
 *      measured — it is on the human check list. The design here is correct
 *      whichever way that goes, because no menu is ever set on win32.)
 *
 * A right click is a menu OPEN, so it is the trigger for the remote check
 * (lib/tray-remote.js allows 'right-click'). A left click on Windows is NOT a
 * menu open — it shows the window — so it re-reads the index (cheap, local,
 * a deliberate act) but does not ask GitHub.
 *
 * The icon is coloured, not a template (Windows does not tint tray icons;
 * a black template glyph is invisible on the default dark taskbar).
 */
export function trayInteraction(platform) {
  if (platform === 'win32') {
    return Object.freeze({
      templateImage: false,
      setContextMenu: false,
      popUpOnRightClick: true,
      leftClick: 'show-window',
      remoteCheckOnLeftClick: false,
      menuTheme: 'native-theme',
    });
  }
  return Object.freeze({
    templateImage: true,
    setContextMenu: true,
    popUpOnRightClick: false,
    leftClick: 'menu',
    remoteCheckOnLeftClick: true,
    menuTheme: 'apple-interface-style',
  });
}

/**
 * Windows truncates a tray tooltip at 127 UTF-16 units (NOTIFYICONDATA's
 * szTip is 128 including the terminator). Electron truncates silently, which
 * cuts mid-word with no sign anything is missing. Clamped here, at a word
 * boundary where one is near, with an ellipsis. The full text is always in the
 * menu one click away, so nothing is lost that the menu does not carry
 * (the v3.66.0 parity rule: no widget-only fact).
 *
 * darwin: returned unchanged.
 */
export const WIN_TOOLTIP_MAX = 127;
export function clampTrayToolTip(text, platform) {
  const s = typeof text === 'string' ? text : '';
  if (platform !== 'win32' || s.length <= WIN_TOOLTIP_MAX) return s;
  const room = WIN_TOOLTIP_MAX - 1; // one unit for the ellipsis
  let cut = s.slice(0, room);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > room - 24) cut = cut.slice(0, lastSpace);
  return cut.replace(/[\s·—,;:]+$/u, '') + '…';
}

/**
 * The Help › About dialog on Windows. `app.showAboutPanel()` exists there but
 * shows almost nothing, so Windows gets a plain message box carrying the SAME
 * facts the Mac's About panel carries — taken from the object
 * `applyAboutPanel()` (lib/app-version.js) already built for the panel, so
 * there is one composition of those facts and not two.
 *
 * @param {object} o
 * @param {string} [o.appName]
 * @param {{applicationVersion?:string, credits?:string}|null} [o.panel]
 *        what applyAboutPanel() returned; absent → "unknown".
 */
export function aboutDialogOptions({ appName = 'The Curator', panel = null } = {}) {
  const version = panel && typeof panel.applicationVersion === 'string' && panel.applicationVersion.trim()
    ? panel.applicationVersion.trim() : 'unknown';
  const credits = panel && typeof panel.credits === 'string' && panel.credits.trim()
    ? panel.credits.trim() : '';
  return {
    type: 'info',
    title: 'About ' + appName,
    message: appName + ' ' + version,
    detail: credits,
    buttons: ['OK'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

/**
 * Can this shell build an in-app updater on this platform?
 *
 * win32: only once the update-engine package (F) exports its platform adapter
 * factory, `createUpdateInstaller`. Until then the hooks are not registered on
 * Windows and the update route refuses with its own named reason — never the
 * darwin engine running `hdiutil` on a PC. Every other platform: true, which
 * is exactly what main.js did before (it built the engine unconditionally).
 */
export function updaterSupported(platform, engineModule) {
  if (platform !== 'win32') return true;
  return !!engineModule && typeof engineModule.createUpdateInstaller === 'function';
}
