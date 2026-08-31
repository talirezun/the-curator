/**
 * The Curator — Electron main process (SCAFFOLD).
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  THIS HAS NEVER BEEN RUN. Electron is not installed and `desktop/` has no ║
 * ║  node_modules and no lockfile. Every claim below was verified by READING  ║
 * ║  the app's source, not by executing this file. Treat the reasoning as     ║
 * ║  load-bearing and the code as a first draft. See desktop/README.md.       ║
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

import { app, BrowserWindow, dialog, session, shell } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { pickFreePort, appUrl } from './lib/port.js';
import { fetchWriteStatus } from './lib/write-status.js';
import { decideQuit } from './lib/quit-decision.js';

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

/**
 * Set once the quit has been authorised, so the `before-quit` handler does not
 * re-ask itself on the second pass. Without this flag, calling `app.quit()`
 * from inside `before-quit` re-enters the same handler and the dialog loops.
 */
let quitAuthorised = false;
/** Guards against two overlapping ⌘Q presses stacking two dialogs. */
let quitCheckInFlight = false;

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
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(boot).catch(fatal);
}

// ── 2. Boot ──────────────────────────────────────────────────────────────────

async function boot() {
  const port = await pickFreePort();
  baseUrl = appUrl(port);

  // MUST precede the import — `src/server.js` reads both at module scope.
  process.env.PORT = String(port);
  process.env.CURATOR_NO_OPEN = '1';

  // Start the app. This is the whole backend: one import, no child process, no
  // second Node runtime. `pathToFileURL` because a Windows path is not a valid
  // ESM specifier; this file is macOS-first but the conversion costs nothing.
  await import(pathToFileURL(SERVER_ENTRY).href);

  installRestartInterceptor(port);
  createWindow();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    show: false,
    titleBarStyle: 'hiddenInset',
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

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  // Anything the page tries to open in a new window goes to the real browser.
  // Without this, an external link opens a chrome-less Electron window with no
  // address bar, which is both a bad experience and a phishing surface.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadURL(baseUrl);
}

// ── 3. Restart ───────────────────────────────────────────────────────────────
//
// `POST /api/restart` in `src/server.js` does:
//
//     spawn(process.execPath, [path.join(PROJECT_ROOT, 'src/server.js')], …)
//
// Under Electron `process.execPath` is the APP BINARY, not `node`. Spawning it
// with a script path launches a SECOND CURATOR WINDOW rather than a headless
// server — and then the old process exits, leaving a window whose backend was
// never started the way this file starts it. The route is right for repo mode
// and wrong here.
//
// `src/brain/install-mode.js` already names the correct answer as a capability
// (`restartStyle: 'app-relaunch'`) and states that nothing branches on it yet.
// The clean fix is for the route to consult it — that is a change in `src/`,
// which this change deliberately does not make.
//
// So the interception lives here, at the HTTP layer, where it needs no `src/`
// change at all: cancel the request before it reaches Express, and relaunch.
//
// HONEST CAVEATS, because this is a workaround and should read as one:
//   · The renderer's fetch rejects with ERR_BLOCKED_BY_CLIENT. The app is
//     relaunching, so the window is gone before that matters — but if the
//     relaunch ever fails, the user sees a network error, not a restart error.
//   · This only catches requests from the RENDERER. A restart triggered by
//     anything else (curl, a script, the MCP) still takes the broken path.
//   · An exact-URL filter is used rather than a wildcard so this can never
//     accidentally intercept a different route on a different port.
// The durable fix is a `restartStyle` branch in the route. Report it, do not
// let this comment become the reason nobody does it.
function installRestartInterceptor(port) {
  const target = `http://127.0.0.1:${port}/api/restart`;
  session.defaultSession.webRequest.onBeforeRequest({ urls: [target] }, (details, callback) => {
    if (details.method !== 'POST') return callback({});
    callback({ cancel: true });
    // relaunch() queues an argv-identical launch for after this process exits;
    // exit(0) is what actually ends it. quitAuthorised is set first so the
    // before-quit handler does not stop a restart the user just asked for —
    // /api/restart already refuses while writes are active (hasActiveWrites()),
    // so that check has been made by the server before we ever see the request.
    quitAuthorised = true;
    app.relaunch();
    app.exit(0);
  });
}

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

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && baseUrl) createWindow();
});

function fatal(err) {
  dialog.showErrorBox(
    'The Curator could not start',
    (err && err.stack) ? err.stack : String(err)
  );
  app.exit(1);
}
