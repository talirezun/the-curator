/**
 * buildMenuTemplate() — the application menu, as plain data.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  WHY THIS IS A SEPARATE, ELECTRON-FREE MODULE                             ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * Electron is deliberately not an offline-suite dependency, so `main.js` can
 * never be imported, evaluated or run by `npm test` — a guard on it can only
 * ever be a source scan, which proves a line was WRITTEN and nothing else.
 * Every module in this folder exists to move the provable part out of main.js,
 * and this one is no different: `Menu.buildFromTemplate` consumes plain
 * objects, so the entire menu STRUCTURE — labels, accelerators, roles,
 * ordering, which items exist in which state — is ordinary data that
 * `scripts/test-desktop-menu.js` builds and inspects for real.
 *
 * main.js keeps only two lines it cannot give away: the `Menu.buildFromTemplate`
 * call and the `Menu.setApplicationMenu` call.
 *
 * ── WHAT THE DEFAULT MENU WAS, MEASURED ────────────────────────────────────
 *
 * Dumped from a running Electron 43.5.0 rather than recalled: the File menu
 * held exactly ONE item, "Close Window" (⌘W, role `close`), and NOTHING in the
 * entire menu created a window. That is why main.js had to make ⌘W hide rather
 * than close — a closed window left a running app with no route back except an
 * undiscoverable Dock click.
 *
 * That hack stays (it is still correct), but it is no longer the only thing
 * standing between a user and a lost window: the Window menu below ends with
 * an explicit item that reveals the main window from any state, including
 * hidden — which is precisely the state a hidden window cannot be recovered
 * from through macOS's own window list, because a hidden window is not in it.
 *
 * ── THERE IS NO FILE MENU, AND THAT IS THE DECISION ────────────────────────
 *
 * A File menu implies documents. The Curator has none: sources are ingested
 * into a wiki, they are not opened and saved. A File menu whose only member
 * closes a window is exactly the empty shell the default menu already was, and
 * reproducing it deliberately would be worse than inheriting it by accident.
 * ⌘W therefore lives in Window, beside the other window commands it belongs
 * with.
 *
 * ⌘O was considered for "Add a source" and REJECTED: it would navigate to the
 * Ingest view, and a ⌘O that does not open a file picker is a lie about what
 * the shortcut does. The Ingest view has its own drop zone and file button.
 *
 * ── THE ONE COUPLING TO THE APP'S OWN MARKUP, NAMED RATHER THAN HIDDEN ─────
 *
 * "Settings…" (⌘,) has to reach a view that lives in the renderer. There is no
 * URL for it — `src/public/next/app.js` restores its view from localStorage and
 * reads neither a hash nor a query string — and there is no IPC channel,
 * because `desktop/preload.js` exposes nothing and adding a `navigate` channel
 * would need the renderer to listen for it, which is a change in `src/`.
 *
 * So the shell clicks the rail button the user would have clicked, through
 * `webContents.executeJavaScript`, keyed on `SETTINGS_NAV_SELECTOR` below.
 *
 * This is NOT the case main.js rejects for `insertCSS`. That rejection turns
 * on a specific property: an injected stylesheet cannot report whether its
 * selector matched anything, so the guard could only ever assert that a STRING
 * was inserted. `executeJavaScript` RESOLVES WITH A VALUE — main.js asks
 * whether the element was found and says so out loud when it was not. The
 * failure is loud and recoverable rather than silent.
 *
 * `data-view` is also the app's own routing primitive, not a styling hook: it
 * is what the rail's click handler reads, what `renderRailActive()` matches on,
 * and it is validated against `ALL_VIEWS`. It is the most stable thing in that
 * file short of the view names themselves. `scripts/test-desktop-menu.js`
 * carries a read-only tripwire that fails if `src/public/next/app.js` stops
 * emitting it.
 */

/**
 * The rail button "Settings…" clicks. See the header for why this coupling
 * exists and why it is safe to have.
 *
 * `[data-view="settings"]` and not `#some-id`: the rail's settings button has
 * no id at all, and `data-view` is the routing attribute the app itself
 * dispatches on.
 */
export const SETTINGS_NAV_SELECTOR = '[data-view="settings"]';

/**
 * Help destinations. Every one of these must resolve to something real — a
 * Help menu pointing at a 404 is worse than no Help menu, because the user
 * concludes the documentation does not exist rather than that the link is
 * wrong.
 *
 * RELEASES_URL is deliberately the SAME literal as `RELEASES_PAGE_URL` in
 * `src/routes/config.js`, and the suite asserts they are still equal by
 * reading that file. It is duplicated rather than imported because every
 * module in this folder is src-free so the suite can execute it; a constant
 * pinned by a cross-file assertion is the cheapest way to have both.
 *
 * Note this constant is ONLY used by Help → Release Notes, which has no
 * payload to read a URL from. Every update dialog takes its URL from the
 * server's answer instead.
 */
export const HELP_URL = 'https://github.com/talirezun/the-curator/blob/main/docs/user-guide.md';
export const RELEASES_URL = 'https://github.com/talirezun/the-curator/releases';

/** Menu item ids, so a caller can address one without matching on its label
 *  (labels are user-visible copy and will change; ids are a contract). */
export const ID_CHECK_FOR_UPDATES = 'check-for-updates';
export const ID_SETTINGS = 'open-settings';
export const ID_REVEAL_WINDOW = 'reveal-window';
export const ID_SHOW_LOGS = 'show-logs';

/**
 * The two labels the update item can carry.
 *
 * The busy label is not decoration. The check is a live network call to
 * GitHub with a 12-second ceiling; a menu item that looks unchanged for ten
 * seconds after a click is the "nothing happens, then suddenly something
 * happens" complaint this project already has a release about (v3.11.0). The
 * item is relabelled AND disabled while a check is in flight, so the menu
 * itself is the progress indicator — no window has to be open, and nothing
 * has to be painted by the renderer.
 */
export const CHECK_LABEL_IDLE = 'Check for Updates…';
export const CHECK_LABEL_BUSY = 'Checking for Updates…';

/**
 * ── AND THE THIRD STATE: AN UPDATE IS ACTUALLY BEING INSTALLED ─────────────
 *
 * `updateStatus` is a whole label, composed by `updateMenuLabel()` in
 * lib/update-client.js from the server's own progress record ("Downloading
 * Update… 43%"). It is not composed here, because the phase vocabulary is the
 * update route's and this module must not grow a second copy of it.
 *
 * It takes PRECEDENCE over `checking`, and that ordering is load-bearing
 * rather than arbitrary: the install runs for minutes and the check runs for
 * seconds, so a menu that let `checking` win would show "Checking for
 * Updates…" for the whole of a download. The suite drives both flags set at
 * once and asserts which one is on screen.
 *
 * The item is DISABLED throughout, which is what stops a second click starting
 * a second download — and disabling it is safe here in a way it would not be
 * for a long silent operation, because the label is simultaneously saying what
 * is happening and how far along it is.
 */

const sep = { type: 'separator' };

/**
 * @param {object} o
 * @param {string}   o.appName            shown in the app-menu items ("Hide X").
 * @param {string}   [o.platform]         defaults to process.platform; injected
 *                                        so the suite can drive both arms.
 * @param {boolean}  [o.checking]         is an update check in flight?
 * @param {string}   [o.updateStatus]     a whole label from updateMenuLabel(),
 *                                        shown while an update is installing.
 *                                        Wins over `checking`.
 * @param {Function} o.onCheckForUpdates
 * @param {Function} o.onOpenSettings
 * @param {Function} o.onRevealWindow
 * @param {Function} o.onOpenUrl          (url) => void
 * @param {Function} o.onShowLogs
 * @returns {Array} a `Menu.buildFromTemplate` template
 */
export function buildMenuTemplate({
  appName = 'The Curator',
  platform = process.platform,
  checking = false,
  updateStatus = null,
  onCheckForUpdates,
  onOpenSettings,
  onRevealWindow,
  onOpenUrl,
  onShowLogs,
} = {}) {
  const isMac = platform === 'darwin';

  // Every handler is required. A menu item wired to `undefined` throws at
  // CLICK time — i.e. in front of the user, weeks later — so it is refused
  // here, at build time, where the suite sees it.
  for (const [name, fn] of Object.entries({
    onCheckForUpdates, onOpenSettings, onRevealWindow, onOpenUrl, onShowLogs,
  })) {
    if (typeof fn !== 'function') {
      throw new Error(`buildMenuTemplate: ${name} must be a function, got ${typeof fn}`);
    }
  }

  // A non-string, or an empty string, is NOT a status — it is the absence of
  // one, and must never render as a blank menu item. Checked for a usable
  // value rather than for truthiness so a caller handing over `0` or `{}`
  // falls back to the real labels instead of producing an unreadable row.
  const installing = typeof updateStatus === 'string' && updateStatus.trim().length > 0;

  const checkForUpdatesItem = {
    id: ID_CHECK_FOR_UPDATES,
    // Precedence: installing › checking › idle. See the constants above.
    label: installing ? updateStatus.trim() : (checking ? CHECK_LABEL_BUSY : CHECK_LABEL_IDLE),
    enabled: !installing && !checking,
    click: onCheckForUpdates,
  };

  const settingsItem = {
    id: ID_SETTINGS,
    label: 'Settings…',
    // ⌘, on macOS. Apple reserves it for preferences in every app, and a Mac
    // user reaches for it without looking. On Windows/Linux there is no such
    // convention, so no accelerator is claimed there.
    ...(isMac ? { accelerator: 'Command+,' } : {}),
    click: onOpenSettings,
  };

  // ── Application menu (macOS only) ─────────────────────────────────────────
  // Built out item by item rather than with `role: 'appMenu'`, because the
  // role's fixed submenu has no place to put Check for Updates or Settings —
  // and their position is the whole point. "Check for Updates…" directly under
  // About is where every Mac app since Sparkle has put it, and it is where a
  // user looks first. Reported by the maintainer as simply missing.
  const appMenu = {
    label: appName,
    submenu: [
      { role: 'about', label: `About ${appName}` },
      sep,
      checkForUpdatesItem,
      sep,
      settingsItem,
      sep,
      { role: 'services', submenu: [] },
      sep,
      { role: 'hide', label: `Hide ${appName}` },
      { role: 'hideOthers' },
      { role: 'unhide' },
      sep,
      // NOT `app.quit()` by hand: the `quit` role goes through Electron's
      // normal shutdown, which is what fires `before-quit` — and `before-quit`
      // is where main.js asks GET /api/write-status whether a paid, multi-minute
      // ingest is in flight. A hand-rolled `app.exit()` here would walk straight
      // past that guard.
      { role: 'quit', label: `Quit ${appName}` },
    ],
  };

  // ── Edit ──────────────────────────────────────────────────────────────────
  // This menu is FUNCTION, not decoration, and that is not a style opinion.
  // On macOS the Edit roles are what install the ⌘X/⌘C/⌘V accelerators and
  // wire them to the focused control's native clipboard actions. Replace the
  // default menu without them and copy/paste stop working in the renderer —
  // including in the chat composer and every API-key field, where a user
  // pasting a key is the single most common first action in the whole app.
  const editMenu = {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      sep,
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(isMac ? [
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
        sep,
        { label: 'Speech', submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }] },
      ] : [
        { role: 'delete' },
        sep,
        { role: 'selectAll' },
      ]),
    ],
  };

  // ── View ──────────────────────────────────────────────────────────────────
  // Reload is a genuine recovery path for a single-page app whose state can
  // wedge, and it costs nothing: the wiki, the conversations and the config
  // all live on the server, and the view and theme are restored from
  // localStorage. Zoom is the standard browser-level control, and is distinct
  // from the app's own font-scale setting — this one scales chrome and images
  // too. DevTools stays because the answer to "what does the console say?" has
  // to be reachable in a packaged build with no other way in.
  const viewMenu = {
    label: 'View',
    submenu: [
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      sep,
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      sep,
      { role: 'togglefullscreen' },
    ],
  };

  // ── Window ────────────────────────────────────────────────────────────────
  const windowMenu = {
    label: 'Window',
    submenu: [
      { role: 'minimize' },
      ...(isMac ? [{ role: 'zoom' }] : []),
      // ⌘W. main.js intercepts the resulting `close` on darwin and HIDES the
      // window instead of destroying it, which is why the item below exists.
      { role: 'close' },
      sep,
      ...(isMac ? [{ role: 'front' }, sep] : []),
      {
        // THE ITEM THE DEFAULT MENU DID NOT HAVE. macOS's own window list
        // (`role: 'window'`) cannot list a HIDDEN window, and hidden is
        // exactly what ⌘W leaves behind. Without this, the only route back to
        // a hidden window is a Dock click — real, but undiscoverable, and an
        // app whose window vanished reads as an app that quit.
        // NO ACCELERATOR, and that was a correction rather than an omission:
        // the first draft claimed ⌘0, which `role: 'resetZoom'` in the View
        // menu already owns (Electron binds it to CommandOrControl+0). Two
        // items on one accelerator is undefined behaviour dressed as a
        // feature. macOS's own window-list entries carry no accelerator
        // either, so this matches the platform.
        id: ID_REVEAL_WINDOW,
        label: appName,
        click: onRevealWindow,
      },
    ],
  };

  // ── Help ──────────────────────────────────────────────────────────────────
  // Every destination here resolves to something that exists today: the user
  // guide is `docs/user-guide.md` in this repository, the releases page is the
  // same URL the update check falls back to, and the log folder is the one
  // `getLogsDir()` resolves (v3.29.0). The third item is the interesting one —
  // the app grew its own log file in v3.29.0 and the frontend button that
  // reveals it was never wired, so until now nothing in the shipped product
  // could open it.
  const helpMenu = {
    role: 'help',
    label: 'Help',
    submenu: [
      { label: 'The Curator User Guide', click: () => onOpenUrl(HELP_URL) },
      { label: 'Release Notes', click: () => onOpenUrl(RELEASES_URL) },
      sep,
      { id: ID_SHOW_LOGS, label: 'Show Logs', click: onShowLogs },
    ],
  };

  if (isMac) return [appMenu, editMenu, viewMenu, windowMenu, helpMenu];

  // Non-macOS. The packaged app ships for macOS only today, but this shell can
  // be run from a checkout anywhere, and a menu missing Quit and Settings on
  // Linux would be a worse experience than the default menu it replaced.
  return [
    {
      label: 'File',
      submenu: [settingsItem, sep, checkForUpdatesItem, sep, { role: 'quit' }],
    },
    editMenu,
    viewMenu,
    windowMenu,
    helpMenu,
  ];
}

/**
 * Walk a template and yield every item, flattened, with its path.
 *
 * Exported because the suite needs it and because it is the only honest way to
 * assert "there is exactly one enabled item that checks for updates" — a
 * hand-written index into a nested array silently means something different
 * the moment a separator moves.
 */
export function flattenMenu(template, trail = []) {
  const out = [];
  for (const item of template || []) {
    if (!item || typeof item !== 'object') continue;
    const label = item.label || item.role || item.type || '(unnamed)';
    const path = [...trail, label];
    out.push({ ...item, path: path.join(' › ') });
    if (Array.isArray(item.submenu)) out.push(...flattenMenu(item.submenu, path));
  }
  return out;
}
