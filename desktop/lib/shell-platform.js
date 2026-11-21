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
 * Windows, NO tray (audit minor 5, 2026-11-20): should the X ask the quit
 * question BEFORE the window goes, instead of closing it?
 *
 * Without this the close went through, the last window was destroyed, and only
 * then did `window-all-closed` → `app.quit()` → `before-quit` ask "Quit now?"
 * about an ingest in progress. "Keep working" then left a process with no
 * window, no tray icon and no taskbar button: invisible, still running. So on
 * win32 with no live tray the close is cancelled and turned into the same
 * `app.quit()` a menu Quit uses; the write-status question appears with the
 * window still there, and "Keep working" keeps it. An authorised quit and a
 * Windows log-off/shut-down go through as before. Answers FALSE on every other
 * platform (the Mac keeps its own handler), and FALSE whenever the tray hide
 * above applies.
 */
export function closeAsksQuitFirst({ platform, quitAuthorised = false, trayActive = false, sessionEnding = false } = {}) {
  if (platform !== 'win32') return false;
  if (quitAuthorised || sessionEnding) return false;
  return trayActive !== true;
}

/**
 * WINDOWS (audit M1, 2026-11-20): the box shown INSTEAD of starting when the
 * packaged app's program files are incomplete — the packager's marker is
 * missing, so paths.js would otherwise read this install as a checkout and keep
 * user data inside the program folder. The decision is paths.js's own
 * `win32AppFilesIncomplete()` (the same one that makes paths.js refuse in the
 * MCP bridge), handed in as `pathsModule`. Null means start normally; it is
 * null on every platform but win32, and when the module cannot answer.
 *
 * @param {object|null} pathsModule  src/brain/paths.js's namespace
 * @returns {{title:string, body:string}|null}
 */
export function appFilesIncompleteBox(pathsModule) {
  if (!pathsModule || typeof pathsModule.win32AppFilesIncomplete !== 'function') return null;
  let incomplete = false;
  try { incomplete = pathsModule.win32AppFilesIncomplete() === true; } catch { incomplete = false; }
  if (!incomplete) return null;
  const body = typeof pathsModule.WIN32_APP_FILES_INCOMPLETE_MESSAGE === 'string'
    ? pathsModule.WIN32_APP_FILES_INCOMPLETE_MESSAGE
    : 'The Curator did not start because its program files are incomplete. Run its installer again; your notes are safe.';
  return { title: 'The Curator could not start', body };
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
 * ── Windows (v4.1.0, owner decision D1 2026-11-21) ─────────────────────────
 * A LEFT click opens the POPOVER (lib/tray-popover.js): a small window under
 * the icon that paints the Mac menu's own template as pages
 * (lib/tray-popover-model.js), so it carries every fact the Mac widget does.
 * A RIGHT click opens the NATIVE Windows menu (the v4.0.1 adapted menu,
 * lib/tray-menu-win.js), which is the Windows convention, the accessibility
 * path, and the popover's FALLBACK: a popover that cannot be built, loaded or
 * painted in time makes that left click pop the native menu instead.
 * (v4.0.0 had left click = window; v4.0.1 had both clicks = the native menu.)
 *
 * The native menu is NOT set with `setContextMenu`; it is POPPED from the
 * right-click handler (and from the popover's fallback) with
 * `popUpContextMenu(menu)`, for two reasons:
 *
 *   1. Freshness. There is no "menu will open" event on a Tray. Popping it
 *      ourselves, the handler runs BEFORE the menu is shown, so the menu is
 *      rebuilt from the in-memory snapshot first and every age in it is exact
 *      at the moment it appears. This does not rely on `mouse-enter`, which
 *      Electron 43's typings list for win32 but which nobody on this project
 *      has seen fire on a Windows tray.
 *   2. A menu set with `setContextMenu` is opened by Electron's notify icon on
 *      a right click by itself, before our handler could rebuild it; and the
 *      popover's fallback needs the same kept menu to pop.
 *
 * Both clicks open the widget (popover or menu), so both are triggers for the
 * remote check (lib/tray-remote.js allows 'click' and 'right-click'), exactly
 * as on the Mac.
 *
 * A double-click is NOT wired: the first click has already opened the
 * popover, which takes the second. "Open The Curator" is the widget's own item.
 *
 * The icon is not a template (Windows does not tint tray icons): it is the
 * Mac glyph drawn in the taskbar's ink, chosen from the SYSTEM theme
 * (`iconTheme: 'system-integrated-ui'`, see lib/tray-icon-win.js).
 */
export function trayInteraction(platform) {
  if (platform === 'win32') {
    return Object.freeze({
      templateImage: false,
      setContextMenu: false,
      popUpOnRightClick: true,
      popUpOnLeftClick: false,
      leftClick: 'popover',
      remoteCheckOnLeftClick: true,
      menuTheme: 'native-theme',
      iconTheme: 'system-integrated-ui',
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
 * The tray's click handlers, built from `trayInteraction(platform)` so the
 * suite EXECUTES the wiring main.js registers (Electron cannot run in
 * `npm test`; only this map's entries are handed to `tray.on`).
 *
 * Each handler, in order: open the widget where this platform opens it
 * (win32: the popover on a LEFT click, the native menu popped on a RIGHT
 * click), re-read the index (a deliberate act), then ask about the other
 * machines with the click's own trigger. darwin: exactly the v3.x handlers —
 * refresh, then the remote check — and nothing popped (the menu is set).
 *
 * @param {string} platform
 * @param {{popMenu: Function, refresh: Function, checkRemote: Function,
 *   showPopover?: Function}} fx  `showPopover` is required where the plan's
 *   leftClick is 'popover' (win32) and never called anywhere else
 * @returns {{click: Function, 'right-click': Function}}
 */
export function trayClickHandlers(platform, fx) {
  const ui = trayInteraction(platform);
  const popover = ui.leftClick === 'popover';
  for (const name of ['popMenu', 'refresh', 'checkRemote', ...(popover ? ['showPopover'] : [])]) {
    if (!fx || typeof fx[name] !== 'function') {
      throw new Error(`trayClickHandlers: ${name} must be a function`);
    }
  }
  const handler = (trigger, opens, asks) => () => {
    if (opens === 'popover') fx.showPopover();
    else if (opens === true) fx.popMenu();
    fx.refresh();
    if (asks) fx.checkRemote(trigger);
  };
  return {
    click: handler('click', popover ? 'popover' : ui.popUpOnLeftClick, ui.remoteCheckOnLeftClick === true),
    'right-click': handler('right-click', ui.popUpOnRightClick, true),
  };
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

/**
 * What to show after a start, from the updater's `afterStart()` answer
 * (lib/update-engine.js, F API). On Windows the helper that ran the installer
 * records how it went; when the reopened app finds that the update did NOT
 * land, it says so once, in the helper's own sentence (already in the
 * published catalogue). Anything else — the Mac's no-op, a successful update,
 * an unreadable answer — shows nothing.
 *
 * @param {{ok?:boolean, outcome?:{status?:string, message?:string}|null}|null} result
 * @returns {object|null} showMessageBox options, or null
 */
export function afterStartNotice(result) {
  const o = result && typeof result === 'object' && result.ok !== false ? result.outcome : null;
  if (!o || typeof o !== 'object' || o.status !== 'failed') return null;
  if (typeof o.message !== 'string' || !o.message.trim()) return null;
  return {
    type: 'warning',
    title: 'The Curator',
    message: o.message.trim(),
    buttons: ['OK'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}
