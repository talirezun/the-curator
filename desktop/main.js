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

import { app, BrowserWindow, Menu, Tray, dialog, nativeImage, nativeTheme, screen, shell } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, watch as fsWatch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { pickFreePort, appUrl } from './lib/port.js';
import { createUpdateEngine } from './lib/update-engine.js';
import { resolveInstallerRelease } from './lib/update-release.js';
import { fetchWriteStatus } from './lib/write-status.js';
import { decideQuit } from './lib/quit-decision.js';
import { applyAboutPanel } from './lib/app-version.js';
import { buildMenuTemplate, SETTINGS_NAV_SELECTOR } from './lib/menu.js';
import { fetchUpdateCheck } from './lib/update-check.js';
import { describeUpdate, describeInstallOutcome, ACTION_ID } from './lib/update-verdict.js';
import { fetchUpdaterProbe, runInstall, applyOnlyForAction, UPDATE_LABEL_PENDING } from './lib/update-client.js';
import {
  MIN_WIDTH, MIN_HEIGHT,
  sanitizeWindowState, serializeWindowState, readWindowState, writeWindowState,
} from './lib/window-state.js';
import { buildTrayModel, liveExpiresInMs, MAX_ROWS } from './lib/tray-model.js';
import { buildTrayMenuTemplate, trayToolTip } from './lib/tray-menu.js';
import { decideRemoteCheck, remoteAnswerIsRenderable } from './lib/tray-remote.js';
import { trayIconPngs } from './lib/tray-icon.js';
import { resolveBackgroundMode, resolveTrayPlan, planModeTransition } from './lib/background-mode.js';
import {
  createStateWatcher, createExpiryTimer, isConfigEvent, FALLBACK_POLL_MS,
} from './lib/state-watch.js';

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
/** The whole menu label while an update is being installed, or null. Composed
 *  by `updateMenuLabel()` in lib/update-client.js from the SERVER's own
 *  progress record — never assembled here, because the phase vocabulary
 *  belongs to the update route and a second copy of it would drift.
 *
 *  Non-null is ALSO the "an install is running" flag: it takes precedence over
 *  `updateCheckInFlight` in the menu, and it is what refuses a second click. */
let updateInstallLabel = null;
/** Resolved in boot() from the app's OWN path resolver, not re-derived here. */
let logsDir = null;

// ── Menubar widget state (see §2c) ───────────────────────────────────────────
/** The `Tray`, or null in `window` mode. */
let tray = null;
/** Which glyph the tray is currently showing, so an unchanged one is never
 *  re-set — replacing a tray image is not free and, more importantly, it is
 *  not silent on every macOS version. */
let trayGlyph = null;
/** The last `getTraySummary()` result. Rendering from this costs no I/O, which
 *  is what makes hovering the icon free and opening it instant. */
let traySnapshot = null;
/** The filesystem watch + fallback poll. Null while the tray is off — turning
 *  the feature off must stop paying for it. */
let stateWatcher = null;
/** One-shot corrector for the `live` glyph. Never a repeating tick. */
let glyphExpiry = null;
/** The mode currently APPLIED, so a config re-read that changes nothing does
 *  nothing. See planModeTransition() for why idempotence matters here. */
let appliedMode = 'window';
/** Watches `.curator-config.json`'s directory so a Settings flip takes effect
 *  without a restart. Runs in every mode — it is what NOTICES the mode. */
let configWatcher = null;
/** The data layer's `getTraySummary`, resolved once in boot(). Null means the
 *  function is not available, which the menu SAYS rather than hides. */
let getTraySummary = null;
let traySummaryError = null;
/** The two halves of the multi-machine signal, resolved once in boot():
 *  `getRemoteStatus` from brain/sync.js (the check) and `noteRemoteStatus`
 *  from brain/tray-summary.js (where the answer is parked for the next read).
 *  Null when either is unavailable, in which case the remote line simply never
 *  appears — which is exactly what it did before, so a failed resolve degrades
 *  to the old behaviour rather than to an error. */
let getRemoteStatus = null;
let noteRemoteStatus = null;
/** When a remote check was last STARTED, and whether one is running. Reset by
 *  stopTray(), so turning the tray off also forgets it paid anything. */
let remoteCheckLastAttemptMs = null;
let remoteCheckInFlight = false;
/** The domains folder, resolved in boot() from the app's own path module. */
let domainsDirForWatch = null;

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

  // The in-app updater. Built here rather than in lib/ because this is the one
  // place that legitimately holds Electron, `src/` and the process identity at
  // once; everything it needs is handed to the engine as a plain function so
  // the engine itself stays executable by the offline suite.
  const updater = await buildUpdateEngine();

  registerDesktopHost({
    pickFolder: async ({ prompt }) => {
      const r = await dialog.showOpenDialog(mainWindow, {
        title: prompt,
        properties: ['openDirectory', 'createDirectory'],
      });
      return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
    },
    relaunch: () => { quitAuthorised = true; app.relaunch(); app.exit(0); },
    // Registered only when the engine could be built. A partial registration is
    // the designed shape (`desktop-host.js`: "a shell that can relaunch but has
    // no folder picker registers only what it has"), and the consumer of a
    // missing hook REFUSES with a named reason rather than falling back to
    // something that half-works.
    ...(updater ? {
      prepareUpdate: (opts = {}) => updater.prepareUpdate(opts),
      installUpdate: (opts = {}) => updater.installUpdate(opts),
    } : {}),
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

  // ── The menubar widget (§2c) ─────────────────────────────────────────────
  //
  // ORDER MATTERS AND IT BITES IF MISSED: the mode is needed BEFORE anything is
  // created, and the renderer does not exist yet at this point, so it must not
  // be waited on from the renderer. Everything here reads through the same
  // APP_ROOT as the server import, so it is the same module instance the server
  // is using rather than a second copy with its own overrides.
  //
  // Nothing in this block can be fatal. A shell that cannot resolve the domains
  // folder, the config file, or the data function still opens the app; the tray
  // then says what it could not do instead of not appearing.
  try {
    const paths = await import(
      pathToFileURL(path.join(APP_ROOT, 'src', 'brain', 'paths.js')).href);
    const cfg = await import(
      pathToFileURL(path.join(APP_ROOT, 'src', 'brain', 'config.js')).href);
    domainsDirForWatch = typeof cfg.getDomainsDir === 'function' ? cfg.getDomainsDir() : null;
    const configFile = typeof paths.getCuratorConfigFile === 'function'
      ? paths.getCuratorConfigFile()
      : null;
    const resolved = await resolveTraySummary();
    getTraySummary = resolved.fn;
    traySummaryError = resolved.error;
    await resolveRemoteCheck();
    startConfigWatch(configFile);
    applyBackgroundMode(await readBackgroundMode());
  } catch { /* the app runs; the menu bar icon simply does not appear */ }

  createWindow();
}

// ── 2a. The in-app updater ───────────────────────────────────────────────────
//
// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║  WHY THIS IS NOT electron-updater — MEASURED ON THE SHIPPED ARTIFACT.     ║
// ╚═══════════════════════════════════════════════════════════════════════════╝
//
// The full argument, with the numbers, is in lib/update-engine.js's docblock.
// The one-line version: `codesign -d -r-` on the installed v3.32.0 bundle
// prints `# designated => cdhash H"…"`, because an ad-hoc signature has no
// certificate and no team for a requirement to name. Squirrel.Mac — which is
// what electron-updater drives on macOS — validates every downloaded build
// against that requirement, and a cdhash requirement is satisfiable by exactly
// one build: the one already installed. So it rejects every genuine update,
// deterministically, and no configuration reaches the check because it lives
// in Electron's own binary rather than in electron-updater's JavaScript.
//
// This is what Mac apps did before notarisation, and it works unsigned.
//
// ── EVERY EFFECT IS PASSED IN AS A FUNCTION ─────────────────────────────────
//
// Not for tidiness. Nothing in this file can be executed by `npm test` —
// Electron is deliberately not an offline-suite dependency — so anything that
// lives HERE can only ever be source-scanned, which this repo has repeatedly
// found to be worth very little (v3.0.17). Both hooks are therefore real,
// executable code in lib/, and this function is the fifteen lines of wiring
// that cannot be anywhere else.
async function buildUpdateEngine() {
  try {
    const paths = await import(pathToFileURL(path.join(APP_ROOT, 'src', 'brain', 'paths.js')).href);
    const registry = await import(pathToFileURL(path.join(APP_ROOT, 'src', 'brain', 'write-registry.js')).href);
    const launcher = await import(pathToFileURL(path.join(APP_ROOT, 'src', 'brain', 'mcp-launcher.js')).href);
    // The module that OWNS the question "which release is newest". It is
    // already in this realm — `src/server.js` imported it a few lines ago —
    // so this is a module-cache hit, and it is the same instance the HTTP
    // route uses. Resolving it from the same APP_ROOT as everything else is
    // what keeps that true.
    const cfg = await import(pathToFileURL(path.join(APP_ROOT, 'src', 'routes', 'config.js')).href);

    return createUpdateEngine({
      // ── which release, and which .dmg inside it ──
      resolveRelease: ({ signal }) => resolveInstallerRelease({
        configModule: cfg,
        fetchImpl: globalThis.fetch,
        // Read from the SAME file `installerUpdateCheck()` reads, rather than
        // from `app.getVersion()`. They agree today — lib/verify-version.mjs
        // refuses a build where the Info.plist and the manifest disagree — but
        // "two sources that a build hook keeps in step" is still two sources,
        // and the updater must ask the same question the update-check endpoint
        // asked or the two can name different versions.
        currentVersion: readAppVersion(),
        arch: process.arch,
        signal,
      }),

      // ── where we are, and whether we may replace it ──
      execPath: process.execPath,
      homeDir: app.getPath('home'),
      arch: process.arch,
      // REUSED, not re-implemented. The path-component match on
      // `AppTranslocation`, the case-insensitive ~/Downloads check (because
      // APFS is case-insensitive) and the empty-execPath case were all got
      // right once, in mcp-launcher.js, each detail with a recorded failure
      // behind it. A second copy is the thing that drifts.
      classifyLaunchOrigin: launcher.classifyLaunchOrigin,

      // ── where the download lands ──
      // getAppSupportDir(), NOT getUserDataDir(): in repo mode the latter IS
      // the git checkout, and a 140 MB .dmg dropped into a live working tree
      // is the class of mistake this project has already shipped twice
      // (.DS_Store in v3.0.16, .write-lock in v3.0.15). Same precedent, and
      // the same reasoning, as getMcpLauncherDir()'s own docblock.
      workDir: path.join(paths.getAppSupportDir(), 'updates'),
      logPath: path.join(paths.getLogsDir(), 'update-install.log'),

      // ── subprocesses ──
      runCommand,
      spawnDetached: (cmd, args) => {
        // `detached` gives the helper its own process group, so it survives
        // this app's exit — which is the entire point of it. `stdio: 'ignore'`
        // because a pipe nobody reads fills and blocks, and there is nobody
        // left to read it. `unref` so this process is not held open by it.
        const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
        child.unref();
        return child;
      },

      // ── quitting ──
      // `app.quit()`, not `app.exit(0)`. quit() runs the window's own `close`
      // handler, which is what persists the remembered size and position;
      // exit() would silently throw that away on every update. `quitAuthorised`
      // is set first so `before-quit` does not re-ask about writes we have
      // already checked.
      quitApp: () => { quitAuthorised = true; app.quit(); },

      // ── the guard that stops an update truncating a paid ingest ──
      writeRegistry: {
        hasActiveWrites: registry.hasActiveWrites,
        listActiveWrites: registry.listActiveWrites,
        beginUpdate: registry.beginUpdate,
        endUpdate: registry.endUpdate,
      },
    });
  } catch (err) {
    // A shell that cannot build the updater still runs the app. The hooks are
    // simply not registered, and the consumer refuses with a named reason —
    // the no-fallback rule in desktop-host.js's header.
    console.error('[The Curator] in-app updater unavailable:', err && err.message ? err.message : err);
    return null;
  }
}

/** The running version, read from the packaged manifest — the same file
 *  `installerUpdateCheck()` reads. Returns '' rather than throwing, which the
 *  resolver reports as `local-version-unreadable`. */
function readAppVersion() {
  try {
    return String(JSON.parse(readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version || '');
  } catch {
    return '';
  }
}

/**
 * Run a command, collect its output, never throw.
 *
 * `spawn`, not `execFile`: `ditto` of a 400 MB bundle takes seconds, and
 * anything synchronous here freezes the window for the whole of it. Output is
 * capped because `hdiutil` and `codesign` can be verbose and nothing reads
 * more than a status line — an uncapped buffer on a subprocess this code does
 * not control is a memory hazard for no benefit.
 */
function runCommand(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ status: 127, stdout: '', stderr: String(err && err.message ? err.message : err) });
      return;
    }
    const cap = Number.isFinite(opts.maxOutput) ? opts.maxOutput : 64 * 1024;
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { if (stdout.length < cap) stdout += d.toString(); });
    child.stderr.on('data', (d) => { if (stderr.length < cap) stderr += d.toString(); });
    child.on('error', (err) => resolve({ status: 127, stdout, stderr: String(err && err.message ? err.message : err) }));
    child.on('close', (code) => resolve({ status: typeof code === 'number' ? code : 1, stdout, stderr }));
  });
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
    updateStatus: updateInstallLabel,
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
 * Show one update dialog and return the button index. The two update dialogs
 * are built the same way, so they are shown by one function rather than two.
 */
async function showUpdateDialog(verdict) {
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

  // Window-modal ONLY when the window is actually on screen. A sheet attached
  // to a hidden window (⌘W leaves one behind — see the close handler) or a
  // minimised one is invisible, so the app would appear frozen with a
  // permanently disabled menu item and no way to dismiss anything.
  const attachable = mainWindow && !mainWindow.isDestroyed()
    && mainWindow.isVisible() && !mainWindow.isMinimized();
  const { response } = attachable
    ? await dialog.showMessageBox(mainWindow, opts)
    : await dialog.showMessageBox(opts);
  return response;
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
 * THAT DECISION IS ABOUT THE CHECK AND IT STILL STANDS. Where the DOWNLOAD's
 * progress goes is a separate question, decided separately, in
 * `runMenuInstall()` below.
 *
 * WHAT IS NOT DUPLICATED, which is the constraint this had to satisfy: which
 * release is newest, whether it is newer than this build, whether the versions
 * can be compared at all, whether anything is published, whether this build
 * can install its own updates, whether an update is already running, the
 * release URL, and every failure sentence. All of those arrive on the wire
 * from GET /api/config/update-check and GET /api/config/update-progress, which
 * are the only sides that read the release list and the job record.
 * lib/update-verdict.js contains no version comparator, and the suite asserts
 * that.
 *
 * WHAT IS: four short headline sentences that also exist in Settings ▸ General,
 * plus `INSTALL_EXPLAINER` — byte-identical to the Settings confirm dialog's
 * and pinned to it by a cross-file assertion. Bounded, named in
 * desktop/README.md, and accepted.
 */
async function checkForUpdates() {
  if (updateCheckInFlight || updateInstallLabel !== null) return;
  updateCheckInFlight = true;
  // The menu bar IS the progress indicator: the item relabels to "Checking for
  // Updates…" and disables. This costs nothing, needs no window, and closes
  // the gap the maintainer would otherwise see — a live GitHub call with a
  // 12-second ceiling behind a menu item that looked unchanged.
  applyMenu();

  // Chosen inside the try, acted on after the `finally` — so the check's busy
  // label is cleared before a multi-minute install claims the same menu item.
  let next = null;
  try {
    // BOTH questions at once, and both answered by the server. The second one
    // is what this release is for: `updaterAttached` says whether this build
    // can install its own update, and the job record says whether one is
    // already going. Asking rather than assuming is the point — Settings reads
    // the same field, so the two surfaces cannot disagree.
    const [payload, installer] = await Promise.all([
      fetchUpdateCheck(baseUrl),
      fetchUpdaterProbe(baseUrl),
    ]);
    const verdict = describeUpdate(payload, installer);
    const response = await showUpdateDialog(verdict);
    if (response === ACTION_ID && verdict.action) next = verdict.action;
  } catch (err) {
    // fetchUpdateCheck and fetchUpdaterProbe never reject and describeUpdate is
    // pure, so reaching here means Electron's own dialog call failed. Say so
    // rather than leaving a menu item that appears to do nothing.
    dialog.showErrorBox(
      'Could not check for updates',
      (err && err.message) ? err.message : String(err)
    );
  } finally {
    updateCheckInFlight = false;
    applyMenu();
  }

  if (!next) return;
  try {
    if (next.type === 'open-url') await shell.openExternal(next.url);
    else if (next.type === 'open-settings') await openSettingsView();
    else if (next.type === 'install' || next.type === 'install-staged') await runMenuInstall(next);
  } catch (err) {
    dialog.showErrorBox(
      'Could not update The Curator',
      (err && err.message) ? err.message : String(err)
    );
  }
}

/**
 * ── THE UPDATE ITSELF, AND WHERE ITS PROGRESS GOES ─────────────────────────
 *
 * The whole of the decision-making is in lib/update-client.js, which the suite
 * EXECUTES. What is here is the two things it cannot be given: the Electron
 * dialogs, and holding the label in a variable.
 *
 * `runInstall` POSTs the app's OWN update route — the same two endpoints, in
 * the same order, that Settings ▸ General POSTs. It does NOT reach for the
 * engine hooks this file registered, and the reasons are in that module's
 * header. The shortest one: the route owns the job record, so a download
 * started here shows up in Settings, and one started in Settings is seen here.
 *
 * ── WHERE PROGRESS IS SHOWN, AND WHAT WAS REJECTED ─────────────────────────
 *
 *   (a) A native dialog that updates as it goes. REJECTED, and not on taste:
 *       Electron has no API to change or close a `showMessageBox` once it is
 *       on screen. The only way to fake it is to close and reopen a dialog per
 *       tick, which flickers, steals focus repeatedly, and would have to be
 *       throttled to be bearable at all.
 *
 *   (b) Switch the window to Settings ▸ General so the five-phase ring shows
 *       it. REJECTED AS THE MECHANISM, though it happens anyway — see below.
 *       It needs a window (the menu is reachable with none), it needs the two
 *       ordered renderer couplings the check rejected, and its auto-continue
 *       to the restart lives in the client that STARTED the stream, so a panel
 *       that merely adopted the job would stop at "downloaded" and wait for a
 *       second click the user was never told about.
 *
 *   (c) The Dock icon's progress bar (`setProgressBar`). REJECTED: it is a
 *       BrowserWindow method, so it needs a window, and it cannot say what
 *       phase is running or what failed. Two indicators that can disagree is
 *       worse than one that cannot.
 *
 *   (d) The menu item's own label. CHOSEN. It is the only surface that exists
 *       with no window open — which is the state ⌘W leaves behind and the
 *       state this menu is reachable from — and it is the mechanism this shell
 *       ALREADY uses for the check, so it extends one pattern instead of
 *       adding a second. It is determinate: "Downloading Update… 43%".
 *
 * AND (b) HAPPENS ANYWAY, FOR FREE, which is the property that made this
 * choice cheap: because the work is the server's job record, opening
 * Settings ▸ General mid-download finds it — `probeInAppUpdate()` there adopts
 * a running job and polls it. Nothing here draws that; not starting a second,
 * invisible updater is what allows it.
 */
async function runMenuInstall(action) {
  if (updateInstallLabel !== null) return;
  updateInstallLabel = UPDATE_LABEL_PENDING;
  applyMenu();

  // A staged-but-not-installed outcome is OFFERED AGAIN rather than reported
  // as a dead end — the verified bundle is still on disk and still installable.
  // Written as a LOOP and not as recursion, so a user who keeps clicking
  // Install Now cannot grow the stack.
  //
  // WHETHER TO SKIP THE DOWNLOAD IS DECIDED BY applyOnlyForAction(), NOT BY A
  // LITERAL HERE. A mutation flipping a literal in this loop came back green,
  // because nothing in this file can be executed by the suite. The decision
  // therefore lives in lib/update-client.js, where it is driven for real.
  let next = action;
  for (;;) {
    let outcome;
    try {
      outcome = await runInstall(baseUrl, {
        applyOnly: applyOnlyForAction(next),
        // Called ONLY when the label actually changes — the throttling lives in
        // the client and is asserted there, so the menu is rebuilt about a
        // hundred times over a 140 MB download rather than five hundred.
        onLabel: (label) => { updateInstallLabel = label; applyMenu(); },
      });
    } catch (err) {
      // `runInstall` has its own total catch and does not reject, so this is
      // belt and braces. It exists so that no path can leave the menu item
      // stuck on "Downloading Update…" and permanently disabled.
      updateInstallLabel = null;
      applyMenu();
      throw err;
    }

    // SUCCESS ENDS WITH THIS PROCESS GONE. There is nobody to show a dialog to,
    // and the new app must not open one nobody asked for. The label is
    // deliberately left saying "Installing Update…" — it is the last true thing
    // the menu can say, and rebuilding a menu during shutdown buys nothing.
    if (!outcome || outcome.ok === true) return;

    updateInstallLabel = null;
    applyMenu();

    const verdict = describeInstallOutcome(outcome);
    const response = await showUpdateDialog(verdict);
    if (response !== ACTION_ID || !verdict.action) return;
    if (verdict.action.type === 'open-url') { await shell.openExternal(verdict.action.url); return; }
    if (!applyOnlyForAction(verdict.action)) return;

    next = verdict.action;
    updateInstallLabel = UPDATE_LABEL_PENDING;
    applyMenu();
  }
}

// ── 2c. The menubar widget ───────────────────────────────────────────────────
//
// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║  THE DECISIONS ARE IN lib/tray-*.js. ONLY THE WIRING IS HERE.             ║
// ╚═══════════════════════════════════════════════════════════════════════════╝
//
// Same split, and the same reason, as the application menu above: Electron is
// not an offline-suite dependency, so nothing in this file can be EXECUTED by
// `npm test`. The row model, the menu template, the glyph pixels, the mode
// resolution and every timing decision therefore live in lib/, where
// scripts/test-tray-shell.js runs them for real. What is left here is the
// handful of Electron calls that cannot be anywhere else.
//
// ── THE TRAY IS CREATED IN THE MAIN PROCESS, NEVER A HELPER ─────────────────
//
// Not a style preference. Apple DTS documents apps whose status item never
// appeared AND never showed up in macOS 26's "Allow in the Menu Bar" list at
// all, because the item was owned by a second bare executable inside
// Contents/MacOS/ rather than the main one. Apple's guidance is to own the
// status item from the main executable, and `new Tray()` here is that.
//
// ── NOTHING IN THIS SECTION HAS EVER BEEN RENDERED ──────────────────────────
//
// Stated here rather than left to be assumed: no tray icon has been created on
// any machine. Electron cannot be run by the suite and the maintainer is at his
// own computer, so every claim below about how macOS behaves comes from
// Electron's and Apple's documentation, and the parts that ARE proven are
// proven as data — the template, the model, the pixels, the transitions.
// desktop/README.md carries the same statement.

/** The row limit asked of the data layer. The model caps again at MAX_ROWS;
 *  asking for exactly what is displayable keeps the index read as small as the
 *  contract allows. */
const TRAY_ROW_LIMIT = MAX_ROWS;

/**
 * Resolve the data layer's `getTraySummary`.
 *
 * ONE FUNCTION, IMPORTED DIRECTLY. The shell and the server share a Node realm
 * — `boot()` above did `await import(SERVER_ENTRY)` — so this is a plain call
 * with no HTTP hop and no IPC, and the specifier is derived from the same
 * APP_ROOT as everything else so it is the same module instance the rest of the
 * app is using rather than a second copy.
 *
 * TWO CANDIDATE HOMES ARE TRIED, and that is a coordination hedge rather than a
 * fallback of the kind desktop-host.js forbids: both resolve to the SAME
 * function if it exists, so there is no half-working second behaviour. If
 * neither is present the shell records WHY and the menu says "Agent memory
 * could not be read" — loud, recoverable, and never a tray that silently shows
 * an empty store to someone whose store is full.
 */
async function resolveTraySummary() {
  const candidates = [
    ['brain', 'tray-summary.js'],
    ['brain', 'working-state.js'],
  ];
  const tried = [];
  for (const rel of candidates) {
    const spec = pathToFileURL(path.join(APP_ROOT, 'src', ...rel)).href;
    try {
      const mod = await import(spec);
      if (typeof mod.getTraySummary === 'function') return { fn: mod.getTraySummary, error: null };
      tried.push(`${rel.join('/')}: loaded, no getTraySummary export`);
    } catch (err) {
      tried.push(`${rel.join('/')}: ${(err && err.message) || String(err)}`);
    }
  }
  return { fn: null, error: tried.join('; ') };
}

/**
 * Resolve the two functions the multi-machine signal needs.
 *
 * SAME REALM, SAME MODULE INSTANCE, NO HTTP HOP — the same argument as
 * `resolveTraySummary()` above: `boot()` already did `await
 * import(SERVER_ENTRY)`, so these resolve to the very objects the server is
 * using. That matters more here than it does for the summary: `getRemoteStatus`
 * carries a repo-keyed TTL cache, an in-flight memo and — through
 * `gitFetch()` — the process-wide fetch gate, and every one of those bounds is
 * per-MODULE-INSTANCE. A second copy of `sync.js` would have its own gate, its
 * own cache, and would be precisely the "second fetch site" the v3.9.1
 * incident is about. Importing by the same APP_ROOT-derived specifier is what
 * makes this ONE more caller of an existing bounded thing, rather than a new
 * unbounded one.
 *
 * A failure is not fatal and is not reported anywhere: with these null the
 * tray simply never runs a check, which is the behaviour that shipped.
 */
async function resolveRemoteCheck() {
  try {
    const sync = await import(
      pathToFileURL(path.join(APP_ROOT, 'src', 'brain', 'sync.js')).href);
    const summary = await import(
      pathToFileURL(path.join(APP_ROOT, 'src', 'brain', 'tray-summary.js')).href);
    if (typeof sync.getRemoteStatus === 'function' && typeof summary.noteRemoteStatus === 'function') {
      getRemoteStatus = sync.getRemoteStatus;
      noteRemoteStatus = summary.noteRemoteStatus;
    }
  } catch {
    getRemoteStatus = null;
    noteRemoteStatus = null;
  }
}

/**
 * Ask GitHub whether another machine has pushed — ON A MENU OPEN AND NOWHERE
 * ELSE.
 *
 * `lib/tray-remote.js` owns the WHEN and explains at length why this is a
 * check on open rather than a timer, what was verified about the fetch gate,
 * and what could not be. This function owns only the doing.
 *
 * IT NEVER BLOCKS THE MENU. Electron shows the context menu that was already
 * set, synchronously, so there is nothing to await into: the check lands, the
 * observation is parked, and the menu is rebuilt for the next open. That is
 * the identical latency contract the index re-read on click already has, and
 * the absolute "Updated HH:MM" stamp is what keeps it honest.
 *
 * NOTHING HERE THROWS. `getRemoteStatus()` already converts a failed check
 * into a well-formed "unknown" payload, and the catch covers the rest, because
 * an unhandled rejection in a tray event handler is a crash in a process whose
 * whole purpose is to still be running.
 */
async function maybeCheckRemote(trigger) {
  if (!tray || tray.isDestroyed()) return;
  if (!getRemoteStatus || !noteRemoteStatus) return;

  const decision = decideRemoteCheck({
    trigger,
    nowMs: Date.now(),
    lastAttemptMs: remoteCheckLastAttemptMs,
    inFlight: remoteCheckInFlight,
  });
  if (!decision.check) return;

  // Stamped BEFORE the await, not after. The floor has to bound ATTEMPTS: a
  // check that takes thirty seconds and then fails must not leave the window
  // wide open for every click made while it was running.
  remoteCheckLastAttemptMs = Date.now();
  remoteCheckInFlight = true;
  try {
    const payload = await getRemoteStatus();
    if (!remoteAnswerIsRenderable(payload)) return;
    noteRemoteStatus(payload);
    // Re-render rather than re-read: the observation is the only thing that
    // changed, and `getTraySummary()` picks it up from the module-level store
    // on its next call anyway. Going through refreshTraySummary() here would
    // spend a disk walk to deliver a fact that did not come from the disk.
    await refreshTraySummary();
  } catch {
    /* A failed check is already an "unknown" payload; anything past that is
       not something a menu bar can act on. */
  } finally {
    remoteCheckInFlight = false;
  }
}

/** The current mode, read from the app's OWN config module. Never from the
 *  renderer, and never waited on: the value is needed BEFORE the tray and the
 *  window exist, and at that point there is no renderer to ask. */
async function readBackgroundMode() {
  try {
    const mod = await import(
      pathToFileURL(path.join(APP_ROOT, 'src', 'brain', 'config.js')).href);
    // Whichever shape the config module exposes. resolveBackgroundMode()
    // accepts a bare string OR a whole config object and answers 'window' for
    // anything it does not recognise, so no branch here can produce a wrong
    // mode — only a default one.
    if (typeof mod.getBackgroundMode === 'function') return resolveBackgroundMode(mod.getBackgroundMode());
    if (typeof mod.getConfig === 'function') return resolveBackgroundMode(mod.getConfig());
  } catch { /* fall through to the safe default */ }
  return resolveBackgroundMode(null);
}

/** Build the tray menu from the snapshot already in memory. NO I/O, no network
 *  — which is what makes it safe to do on hover. */
function renderTrayFromSnapshot() {
  if (!tray || tray.isDestroyed()) return;
  const model = buildTrayModel(traySnapshot, { maxRows: TRAY_ROW_LIMIT });

  if (model.glyph !== trayGlyph) {
    trayGlyph = model.glyph;
    tray.setImage(trayImage(model.glyph));
  }
  tray.setToolTip(trayToolTip(model));
  tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate(model, {
    onOpenScope: openScopeInApp,
    onOpenMemory: () => openMemoryView(null),
    onOpenApp: () => revealWindow(),
    onOpenSettings: () => { openSettingsView(); },
  })));

  // THE ONE-SHOT CORRECTOR, NOT A TICK. `liveExpiresInMs` is null unless the
  // glyph is `live`, so in the state the process is in almost all of the time
  // this arms nothing at all. When it does fire it re-renders from this same
  // snapshot — no index read, no filesystem, no network.
  if (glyphExpiry) glyphExpiry.arm(liveExpiresInMs(model));
}

/** Re-read the index, then render. This is the only thing here that touches
 *  the disk, and it happens on a real save, on the 5-minute fallback, on boot,
 *  and on a deliberate click — never on a timer while the menu is closed. */
async function refreshTraySummary() {
  if (!tray || tray.isDestroyed()) return;
  if (!getTraySummary) {
    traySnapshot = {
      ok: false, scopes: [], warnings: [
        'Agent memory is unavailable in this build' + (traySummaryError ? ': ' + traySummaryError : ''),
      ],
    };
    renderTrayFromSnapshot();
    return;
  }
  try {
    traySnapshot = await getTraySummary({ limit: TRAY_ROW_LIMIT });
  } catch (err) {
    // A throw here must not take the tray down: a menubar app that vanished is
    // indistinguishable from one that was never installed.
    traySnapshot = {
      ok: false, scopes: [],
      warnings: ['Could not read agent memory: ' + ((err && err.message) || String(err))],
    };
  }
  renderTrayFromSnapshot();
}

/** The template image for a glyph state. Generated, not shipped — see
 *  lib/tray-icon.js for why, and for why it is greyscale+alpha. */
function trayImage(state) {
  const png = trayIconPngs(state);
  const img = nativeImage.createFromBuffer(png.scale1, { scaleFactor: 1 });
  img.addRepresentation({ scaleFactor: 2, buffer: png.scale2 });
  // WITHOUT THIS THE GLYPH IS A BLACK BLOB ON A DARK MENU BAR. A template
  // image is tinted by macOS for the current bar — light, dark, tinted
  // wallpaper, and the inverted state while the menu is open. Correct pixels
  // are necessary and not sufficient; this call is the rest of it.
  img.setTemplateImage(true);
  return img;
}

/** Open the app on a scope. There is NO second reader in the shell. */
async function openScopeInApp(row) {
  await openMemoryView(row && row.project ? row.project : null);
}

/**
 * Reveal the window on the Agent memory view, optionally on one project.
 *
 * ── THE HONEST LIMIT, AND IT IS A LIMIT ────────────────────────────────────
 *
 * This lands on the VIEW and on the PROJECT. It does NOT select the scope: the
 * scope picker is internal to the memory view and has no routing attribute to
 * address, whereas `data-view` and `data-mem-project` are the app's own
 * dispatch attributes — what the rail's click handler reads and what
 * `memory.js`'s own row handler matches on. Coupling to those two is the same
 * coupling `lib/menu.js` already accepts for Settings, with the same property
 * that makes it acceptable: `executeJavaScript` RESOLVES WITH A VALUE, so the
 * shell learns when the coupling has rotted and says so, instead of offering a
 * menu item that silently does nothing.
 *
 * The project name is passed as a JSON string and compared against
 * `dataset.memProject` — never interpolated into a selector. A project name is
 * user-supplied text, and building a CSS selector out of it would be an
 * injection into code running in the app's own origin.
 */
async function openMemoryView(project) {
  revealWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.webContents.isLoading()) await waitForLoad(mainWindow.webContents);
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const js =
    '(() => { const rail = document.querySelector("[data-view=\\"memory\\"]");' +
    ' if (!rail) return "no-view";' +
    ' rail.click();' +
    ' const want = ' + JSON.stringify(project === null ? '' : String(project)) + ';' +
    ' if (!want) return "view";' +
    ' const rows = Array.from(document.querySelectorAll(".mem-row[data-mem-project]"));' +
    ' const hit = rows.find((el) => el.dataset.memProject === want);' +
    ' if (!hit) return "view";' +
    ' hit.click(); return "project"; })()';

  let landed = 'error';
  try {
    landed = await mainWindow.webContents.executeJavaScript(js, true);
  } catch {
    landed = 'error';
  }
  if (landed === 'project' || landed === 'view') return;
  dialog.showErrorBox(
    'Could not open Agent Memory',
    'The Curator’s window did not respond to the menu bar.\n\n' +
    'Open it with the Agent memory button in the left-hand rail.'
  );
}

/** Create the tray icon and everything that keeps it current. */
function startTray() {
  if (tray) return;
  trayGlyph = 'idle';
  tray = new Tray(trayImage('idle'));
  tray.setToolTip('The Curator');

  glyphExpiry = createExpiryTimer({ onExpire: renderTrayFromSnapshot });

  // HOVER RE-RENDERS FROM MEMORY; A CLICK RE-READS THE INDEX.
  //
  // The reason for the split is the one thing a menu cannot do: there is no
  // "menu will open" event on a Tray, so a menu built ten minutes ago would
  // still say "just now". `mouse-enter` fires before the click, costs nothing
  // (no I/O, no network — it renders the snapshot already held), and makes the
  // ages exact at the moment the menu is about to appear. The click is a
  // DELIBERATE act, so that is where the index read belongs — and it is the
  // only place anything expensive is allowed to happen, because it is the only
  // moment a human has asked for it.
  //
  // Correct even if neither event ever fires: the menu is also rebuilt on every
  // real save and on the fallback tick, and it carries an absolute "Updated
  // HH:MM" stamp so a stale reading is visible AS stale rather than confidently
  // wrong.
  //
  // A MENU OPEN ALSO ASKS ABOUT THE OTHER MACHINES, and that is the ONLY
  // trigger that does. `mouse-enter` deliberately stays free — see
  // lib/tray-remote.js for the whole argument, including what was and was not
  // verified about racing the user's own pull. Both calls are fire-and-forget
  // because Electron shows the already-built menu synchronously; there is
  // nothing here to await into.
  tray.on('mouse-enter', renderTrayFromSnapshot);
  tray.on('click', () => { refreshTraySummary(); maybeCheckRemote('click'); });
  tray.on('right-click', () => { refreshTraySummary(); maybeCheckRemote('right-click'); });

  stateWatcher = createStateWatcher({
    roots: trayWatchRoots(),
    watch: fsWatch,
    onRefresh: () => { refreshTraySummary(); },
    fallbackMs: FALLBACK_POLL_MS,
    onWatchError: () => { /* the fallback poll covers it; never fatal */ },
  });
  stateWatcher.start();

  refreshTraySummary();
}

/** Tear the tray down, including everything it was paying for. */
function stopTray() {
  if (stateWatcher) { stateWatcher.stop(); stateWatcher = null; }
  if (glyphExpiry) { glyphExpiry.cancel(); glyphExpiry = null; }
  if (tray && !tray.isDestroyed()) tray.destroy();
  tray = null;
  trayGlyph = null;
  traySnapshot = null;
  // Turning the feature off must stop paying for it, and that includes the
  // rate-limit state: a tray turned back on is a fresh decision, not one
  // still serving a floor armed by the previous one. `remoteCheckInFlight` is
  // deliberately NOT cleared — a check started before the tray was destroyed
  // is still running, and its own `finally` owns that flag; clearing it here
  // would let a second check start alongside the first.
  remoteCheckLastAttemptMs = null;
}

/** Where the working-state files live. Resolved in boot() through the app's
 *  OWN resolver, never re-derived here — two copies of a path is how they
 *  drift, and this one has to be the same folder the MCP writes into or the
 *  watch is pointed at nothing and the tray only ever updates on the fallback
 *  tick. An empty list is survivable and is exactly that degraded state. */
function trayWatchRoots() {
  return domainsDirForWatch ? [domainsDirForWatch] : [];
}

/**
 * Apply a background mode, from any other mode, idempotently.
 *
 * The transition itself is computed by `planModeTransition()` — a pure function
 * the suite drives over the whole 3x3 matrix — so this is nine cases decided in
 * a file that can be executed and applied in a file that cannot.
 */
function applyBackgroundMode(next) {
  const plan = planModeTransition(appliedMode, next);
  if (!plan.changed) return plan;
  if (plan.destroyTray) stopTray();
  if (plan.createTray) startTray();
  // TURNING IT OFF MUST NEVER LEAVE SOMEBODY WITH NO VISIBLE APP. Going back to
  // `window` mode shows the window, so the transition always ends with
  // something on screen rather than with a running process and no affordance.
  if (plan.revealWindow) revealWindow();
  // plan.hideDock is always false today — lib/background-mode.js holds
  // `tray-only` back deliberately and says so in `plan.hedged`. There is no
  // dock call here because there is no tested transition to make it with.
  appliedMode = plan.to;
  return plan;
}

/**
 * Notice a Settings flip without a restart.
 *
 * Runs in EVERY mode, including `window`, because it is what notices the mode
 * being turned ON. It is one non-recursive watch on one directory with an exact
 * basename filter, which is the cheapest thing in this file.
 *
 * The DIRECTORY and not the file: config is written with `writeFileAtomic`, a
 * temp file plus a rename, and a watch on an inode that gets renamed over stops
 * delivering events silently.
 */
function startConfigWatch(configFile) {
  if (configWatcher || !configFile) return;
  const dir = path.dirname(configFile);
  const base = path.basename(configFile);
  configWatcher = createStateWatcher({
    roots: [dir],
    watch: fsWatch,
    recursive: false,
    filter: (name) => isConfigEvent(name, base),
    // No fallback poll: an unnoticed mode change costs the user one restart,
    // and a poll for a setting that changes twice a year is exactly the
    // permanent cost this design refuses to pay.
    fallbackMs: 0,
    onRefresh: async () => { applyBackgroundMode(await readBackgroundMode()); },
    onWatchError: () => { /* the setting then needs a restart; nothing breaks */ },
  });
  configWatcher.start();
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
