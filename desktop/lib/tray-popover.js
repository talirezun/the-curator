/**
 * tray-popover.js — the Windows tray popover's controller: one lazily created, frameless window
 * under the tray icon, painted by src/public/next/tray-popover.html from the payload main sends
 * (CONTRACT-tray-popover.md). Everything Electron is INJECTED, so scripts/test-tray-popover.js
 * drives every state with fakes; main.js (package P5) wires it in.
 *
 * Adapted from AgentLink 0.5.9/0.5.10's popover (the owner's own), keeping its MEASURED lessons as
 * named constants:
 *   TOGGLE_GRACE_MS 300       clicking the icon blurs the popover first; that blur-hide must not be
 *                             undone by the click's own toggle. Only when the pointer was on the icon
 *                             at the blur, so an unrelated blur never swallows the next real click.
 *   SHOW_BLUR_IGNORE_MS 150   a blur right after a show is the window coming forward, not the person
 *                             leaving: ignored, then focus is re-checked (refocus once, then hide).
 *   FIRST_PAINT_BACKSTOP_MS 1000  the first show waits for the PAGE to say it painted the payload
 *                             (no blank flash). DIFFERENT from AgentLink, per the design's §3: if no
 *                             paint arrives by then, the popover does not appear and THAT click falls
 *                             back to the native menu (onFallback). A window still loading its very
 *                             first page at the backstop is not counted as a failure (a cold start);
 *                             anything else is.
 *   MAIN_FOCUS_GRACE_MS 500   the main window getting focus hides the popover, except right after a
 *                             show (P5 calls mainWindowFocused()).
 *   close only hides (unless isQuitting()); a crashed renderer is reloaded on the next show;
 *   every Ctrl/Alt/Meta key combination is swallowed (no reload, zoom or close accelerators).
 *
 * Fallbacks (design §3): a popover that cannot be built, cannot load, does not paint within the
 * backstop, or whose renderer dies makes that click call onFallback(reason) (P5: pop the v4.0.1
 * native menu) and writes ONE log line. MAX_FAILURES (2) failures and the popover is off for the
 * session: the window is destroyed and every later show() calls onFallback('off') at once.
 *
 * Security (design §1): sandbox, contextIsolation, no nodeIntegration, no webview, devtools only
 * when not packaged; its OWN in-memory partition (no `persist:`) whose permission handlers deny
 * everything; webRequest cancels every request that is not data: or a file: inside the page's own
 * folder; navigation, redirects and new windows are always refused; no downloads; the window has
 * no menu. Frameless, not resizable/movable, off the taskbar, always on top.
 */
import path from 'node:path';
import { computePopoverPosition, validTrayBounds, validDisplayArea } from './tray-popover-position.js';
import { CHANNELS, registerTrayPopoverIpc, fileUrlToPlatformPath } from './tray-popover-ipc.js';

export const TOGGLE_GRACE_MS = 300;
export const SHOW_BLUR_IGNORE_MS = 150;
export const MAIN_FOCUS_GRACE_MS = 500;
export const FIRST_PAINT_BACKSTOP_MS = 1000;
export const MAX_FAILURES = 2;
export const POPOVER_WIDTH = 360;
/** Height before the page has reported its content height. */
export const INITIAL_HEIGHT = 480;
/** One single-line row (design §2): the smallest height a page may ask for. */
export const MIN_HEIGHT = 32;
export const MAX_HEIGHT = 4000;
/** In memory only: no `persist:` prefix. */
export const PARTITION = 'tray-popover';
/** --surface-raised in tokens/color.css (dark: --ink-850; light: #FFFFFF), so no white flash. */
/** How Chromium words a Content Security Policy refusal on the console. */
export const CSP_VIOLATION = /Content Security Policy/i;

export const BACKGROUND = Object.freeze({ dark: '#10101A', light: '#FFFFFF' });

const pathFor = (platform) => (platform === 'win32' ? path.win32 : path.posix);

/** The BrowserWindow options (pure; asserted by the suite). */
export function popoverWindowOptions({ preloadPath, session, isPackaged, theme, height = INITIAL_HEIGHT }) {
  return {
    width: POPOVER_WIDTH,
    height,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    closable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: true,
    transparent: false,
    thickFrame: true,
    roundedCorners: true,
    autoHideMenuBar: true,
    focusable: true,
    title: 'The Curator',
    backgroundColor: theme === 'light' ? BACKGROUND.light : BACKGROUND.dark,
    webPreferences: {
      preload: preloadPath,
      session,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      enableWebSQL: false,
      spellcheck: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
      devTools: isPackaged !== true,
      // The first show waits for the page to paint while the window is still hidden; a throttled
      // hidden renderer could miss the backstop.
      backgroundThrottling: false,
    },
  };
}

/** True for a request the popover may make: data:, or a file: inside the page's own folder. */
export function requestAllowed(url, pageDir, platform = process.platform) {
  if (typeof url !== 'string') return false;
  if (/^data:/i.test(url)) return true;
  if (!/^file:/i.test(url)) return false;
  const p = fileUrlToPlatformPath(url, platform);
  if (p === null || typeof pageDir !== 'string' || pageDir.length === 0) return false;
  const P = pathFor(platform);
  const rel = P.relative(P.resolve(pageDir), P.resolve(p));
  if (rel === '' || rel.startsWith('..') || P.isAbsolute(rel)) return false;
  return true;
}

/** Per session: what its one set of listeners reads. A tray toggled off and on builds a new
 *  controller on the SAME partition; it must update these, never add a second set of listeners. */
const hardened = new WeakMap();

/** Hardens the popover's own session ONCE per session object; a later call only updates where
 *  refusals are reported (`onRefused`, the CI self-test's negative probe) and the allowed folder. */
export function hardenPopoverSession(ses, { pageDir, platform, onRefused }) {
  const known = ses && typeof ses === 'object' ? hardened.get(ses) : undefined;
  if (known) { Object.assign(known, { pageDir, platform, onRefused }); return false; }
  const conf = { pageDir, platform, onRefused };
  if (ses && typeof ses === 'object') hardened.set(ses, conf);
  const quiet = (fn) => { try { fn(); } catch { /* an API this build lacks is not a hole: the rest still apply */ } };
  quiet(() => ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false)));
  quiet(() => ses.setPermissionCheckHandler(() => false));
  quiet(() => ses.setDevicePermissionHandler(() => false));
  quiet(() => ses.setDisplayMediaRequestHandler((_req, callback) => callback({})));
  quiet(() => ses.webRequest.onBeforeRequest((details, callback) => {
    const cancel = !requestAllowed(details && details.url, conf.pageDir, conf.platform);
    if (cancel && typeof conf.onRefused === 'function') { try { conf.onRefused(); } catch { /* */ } }
    callback({ cancel });
  }));
  quiet(() => ses.on('will-download', (event, item) => {
    try { event.preventDefault(); } catch { /* */ }
    try { item.cancel(); } catch { /* */ }
  }));
  for (const picker of ['select-hid-device', 'select-serial-port', 'select-usb-device', 'select-bluetooth-device']) {
    quiet(() => ses.on(picker, (event, _details, callback) => {
      try { event.preventDefault(); } catch { /* */ }
      try { if (typeof callback === 'function') callback(); } catch { /* */ }
    }));
  }
  return true;
}

/** The ids of every `action` row in a payload (a cross-check of the gate's own map). */
export function actionIdsOf(p) {
  const ids = new Set();
  const pages = p && typeof p === 'object' && p.pages && typeof p.pages === 'object' ? p.pages : {};
  for (const key of Object.keys(pages)) {
    const rows = pages[key] && Array.isArray(pages[key].rows) ? pages[key].rows : [];
    for (const row of rows) if (row && row.kind === 'action' && typeof row.id === 'string') ids.add(row.id);
  }
  return ids;
}

const inside = (p, r) => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
const isPoint = (p) => p && typeof p === 'object' && Number.isFinite(p.x) && Number.isFinite(p.y);
const safe = (fn) => { try { return fn(); } catch { return null; } };

/**
 * deps (all injected):
 *   BrowserWindow   Electron's constructor
 *   screen          getDisplayMatching, getDisplayNearestPoint, getPrimaryDisplay, getCursorScreenPoint
 *   session         Electron's `session` module (fromPartition)
 *   ipcMain         Electron's ipcMain
 *   gate            createPopoverActionGate() — ONE per controller (tray-popover-model.js)
 *   pagePath        absolute path of src/public/next/tray-popover.html
 *   preloadPath     absolute path of desktop/lib/tray-popover-preload.js
 *   quit            () => app.quit()        (never app.exit())
 *   isQuitting      () => boolean           (true once before-quit ran: then close really closes)
 *   onFallback      (reason) => void        pop the native menu for this click
 *   log             (line) => void          one line to curator.log (default: nothing)
 *   getTrayBounds   () => Rectangle         optional; the icon now (for the toggle-grace test)
 *   isPackaged, platform ('win32'), now, setTimer, clearTimer
 */
export function createTrayPopover(deps) {
  const platform = deps.platform || 'win32';
  const P = pathFor(platform);
  const pagePath = deps.pagePath;
  const pageDir = P.dirname(pagePath);
  const now = deps.now || Date.now;
  const setTimer = deps.setTimer || ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = deps.clearTimer || ((t) => clearTimeout(t));
  const log = (line) => { try { if (typeof deps.log === 'function') deps.log(line); } catch { /* */ } };
  const fallback = (reason) => { try { if (typeof deps.onFallback === 'function') deps.onFallback(reason); } catch { /* */ } };
  const isQuitting = () => sessionEnding || safe(() => deps.isQuitting && deps.isQuitting()) === true;

  let win = null;
  let ses = null;
  let loaded = false;        // the current load finished (did-finish-load)
  let painted = false;       // the page painted a payload since that load
  let needsLoad = true;
  let loadToken = 0;
  let failedToken = 0;
  let showsOnWindow = 0;     // show attempts on the current window (a cold first load is not a failure)
  let pending = null;        // { timer, attempt } while a show waits for the first paint
  let shownAt = -Infinity;
  let showCount = 0;
  let blurHiddenAt = -Infinity;
  let failures = 0;          // CONSECUTIVE failures: a successful reveal resets it
  let failuresTotal = 0;     // every failure this session (stats, the CI self-test)
  let off = false;
  let sessionEnding = false; // this window saw query-session-end / session-end (a log-off)
  let destroyed = false;
  let payload = null;
  let sentGen = 0;
  let sentIds = new Set();   // the `action` row ids of the payload the page was last sent
  let theme = 'dark';
  let anchor = null;         // the tray bounds the last show was given
  let contentHeight = INITIAL_HEIGHT;
  let lastPainted = null;
  let lastBounds = null;
  let dismissals = 0;        // Esc on the root page (curatorTray.dismiss) — the CI self-test
  let cspViolations = 0;     // Chromium's own console reports of a refused load (CI self-test)
  let refusedRequests = 0;   // requests the session's webRequest filter cancelled (CI self-test)

  const live = () => {
    if (win && safe(() => win.isDestroyed()) === true) resetWindow();
    return win;
  };
  function resetWindow() {
    win = null;
    loaded = false;
    painted = false;
    needsLoad = true;
    showsOnWindow = 0;
    cancelPending();
  }
  function cancelPending() {
    if (pending) { safe(() => clearTimer(pending.timer)); pending = null; }
  }
  const windowVisible = () => { const w = live(); return !!w && safe(() => w.isVisible()) === true; };

  function fail(reason, duringClick) {
    failures += 1;
    failuresTotal += 1;
    log(`tray-popover: ${reason} (fallback to the native menu)`);
    if (duringClick) fallback(reason);
    needsLoad = true;
    if (failures >= MAX_FAILURES && !off) {
      off = true;
      log('tray-popover: off for this session after repeated failures');
      const w = win;
      resetWindow();
      if (w) safe(() => w.destroy());
    }
  }

  function send(p) {
    const w = live();
    if (!w || !loaded || !p) return;
    if (safe(() => { w.webContents.send(CHANNELS.model, p); return true; }) === true) {
      sentGen = p.gen;
      sentIds = actionIdsOf(p);
    }
  }

  function ensureSession() {
    if (ses) return ses;
    ses = deps.session.fromPartition(PARTITION, { cache: false });
    hardenPopoverSession(ses, { pageDir, platform, onRefused: () => { refusedRequests += 1; } });
    return ses;
  }

  function ensure() {
    const existing = live();
    if (existing) return existing;
    const s = ensureSession();
    const w = new deps.BrowserWindow(popoverWindowOptions({
      preloadPath: deps.preloadPath, session: s, isPackaged: deps.isPackaged, theme, height: contentHeight,
    }));
    const wc = w.webContents;
    safe(() => w.setMenu(null));
    const refuse = (event) => { try { event.preventDefault(); } catch { /* */ } };
    wc.on('will-navigate', refuse);
    wc.on('will-redirect', refuse);
    wc.on('will-frame-navigate', refuse);
    wc.on('will-attach-webview', refuse);
    safe(() => wc.setWindowOpenHandler(() => ({ action: 'deny' })));
    wc.on('before-input-event', (event, input) => {
      if (input && (input.control === true || input.alt === true || input.meta === true)) refuse(event);
    });
    wc.on('did-finish-load', () => {
      if (win !== w) return;
      loaded = true;
      if (payload) send(payload);
    });
    wc.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
      if (win !== w || isMainFrame === false || code === -3) return;
      loadFailed(w, loadToken);
    });
    wc.on('render-process-gone', () => {
      if (win !== w) return;
      const during = !!pending;
      cancelPending();
      safe(() => w.hide());
      loaded = false;
      painted = false;
      fail('crashed', during);
    });
    wc.on('unresponsive', () => { if (win === w) safe(() => w.hide()); });
    // Content counted, never logged: Chromium reports each load the page's CSP refused on the
    // console ("Refused to … because it violates the following Content Security Policy …").
    // Electron 43 hands a details object; older builds positional (event, level, message).
    wc.on('console-message', (event, _level, message) => {
      if (win !== w) return;
      const text = event && typeof event.message === 'string' ? event.message
        : (typeof message === 'string' ? message : '');
      if (CSP_VIOLATION.test(text)) cspViolations += 1;
    });
    w.on('page-title-updated', refuse);
    // A log-off (Windows): the window hears it itself, so its close is never prevented then, even
    // before main's own handlers have run (or if they never do).
    const ending = () => { sessionEnding = true; };
    w.on('query-session-end', ending);
    w.on('session-end', ending);
    w.on('blur', () => onBlur(w));
    w.on('close', (event) => {
      if (isQuitting()) return;
      refuse(event);
      hide();
    });
    w.on('closed', () => { if (win === w) resetWindow(); });
    win = w;
    loaded = false;
    painted = false;
    needsLoad = true;
    showsOnWindow = 0;
    return w;
  }

  function loadFailed(w, token) {
    if (win !== w || token !== loadToken || loaded || failedToken === token) return;
    failedToken = token;   // one failure per load, however many signals report it
    const during = !!pending;
    cancelPending();
    fail('load-failed', during);
  }

  function load(w) {
    needsLoad = false;
    loaded = false;
    painted = false;
    sentGen = 0;
    sentIds = new Set();
    loadToken += 1;
    const token = loadToken;
    let started;
    try { started = w.loadFile(pagePath); } catch { loadFailed(w, token); return; }
    Promise.resolve(started).catch(() => loadFailed(w, token));
  }

  function displayFor(trayRect) {
    const { screen } = deps;
    let display = null;
    if (trayRect) {
      const matching = safe(() => screen.getDisplayMatching(trayRect));
      if (validDisplayArea(matching)) display = matching;
    }
    const cursor = safe(() => screen.getCursorScreenPoint());
    if (!display && isPoint(cursor)) {
      const near = safe(() => screen.getDisplayNearestPoint(cursor));
      if (validDisplayArea(near)) display = near;
    }
    if (!display) {
      const primary = safe(() => screen.getPrimaryDisplay());
      if (validDisplayArea(primary)) display = primary;
    }
    return { display, cursor: isPoint(cursor) ? cursor : null };
  }

  function place(w) {
    const tray = validTrayBounds(anchor);
    const { display, cursor } = displayFor(tray);
    if (!display) return;
    const r = computePopoverPosition({
      trayBounds: tray, display, cursor, scaleFactor: display.scaleFactor,
      size: { width: POPOVER_WIDTH, height: contentHeight },
    });
    const bounds = { x: r.x, y: r.y, width: r.width, height: r.height };
    // Mixed DPI (design §6): Electron can size a window wrongly when it moves to a display with
    // another scale factor. Set, read back, and set once more if it did not land.
    safe(() => w.setBounds(bounds));
    const got = safe(() => w.getBounds());
    if (got && (got.x !== bounds.x || got.y !== bounds.y || got.width !== bounds.width || got.height !== bounds.height)) {
      safe(() => w.setBounds(bounds));
    }
    lastBounds = bounds;
  }

  function reveal(w) {
    place(w);
    shownAt = now();
    showCount += 1;
    safe(() => w.show());
    safe(() => w.focus());
    // A show that worked ends a run of failures: only CONSECUTIVE ones switch the popover off,
    // never two transient ones weeks apart.
    failures = 0;
  }

  function pointerOnIcon() {
    const tray = validTrayBounds(safe(() => (deps.getTrayBounds ? deps.getTrayBounds() : anchor)));
    const cursor = safe(() => deps.screen.getCursorScreenPoint());
    // Unknown icon or pointer: assume the icon (the click then never reopens what it just closed).
    if (!tray || !isPoint(cursor)) return true;
    return inside(cursor, tray);
  }

  function recheckFocus(w, first, show) {
    if (show !== showCount || win !== w || !windowVisible()) return;
    if (safe(() => w.isFocused()) === true) return;
    if (first) {
      safe(() => w.focus());
      safe(() => setTimer(() => recheckFocus(w, false, show), SHOW_BLUR_IGNORE_MS));
      return;
    }
    safe(() => w.hide());
  }

  function onBlur(w) {
    if (win !== w || !windowVisible()) return;
    const since = now() - shownAt;
    if (since < SHOW_BLUR_IGNORE_MS) {
      const show = showCount;
      safe(() => setTimer(() => recheckFocus(w, true, show), SHOW_BLUR_IGNORE_MS - since));
      return;
    }
    safe(() => w.hide());
    blurHiddenAt = pointerOnIcon() ? now() : -Infinity;
  }

  function onPainted({ gen, rows }) {
    // Any payload this load was sent counts as content (the page reports each paint; a newer send
    // may cross an older paint in flight). A gen never sent is not a paint.
    if (sentGen < 1 || gen > sentGen || !loaded) return;
    painted = true;
    lastPainted = { gen, rows };
    // A show waiting on a warm window reveals on the NEWEST paint only (see show()).
    if (pending && pending.warm && gen < sentGen) return;
    if (pending) {
      cancelPending();
      const w = live();
      if (w) reveal(w);
    }
  }

  function backstop(w, attempt) {
    if (!pending || win !== w) return;
    pending = null;
    if (!loaded && attempt === 1) {
      // A cold first load: this click gets the native menu, the window keeps loading.
      log('tray-popover: still loading at the first click (fallback to the native menu)');
      fallback('slow-load');
      return;
    }
    fail('no-paint', true);
  }

  // ── The public API ─────────────────────────────────────────────────────────

  /** Shows the popover at the icon. Returns true if it is (or will be, once painted) on screen. */
  function show(trayBounds) {
    if (destroyed) return false;
    if (off) { fallback('off'); return false; }
    anchor = trayBounds === undefined ? anchor : trayBounds;
    let w;
    try { w = ensure(); } catch {
      fail('build-failed', true);
      return false;
    }
    if (windowVisible()) { place(w); safe(() => w.focus()); return true; }
    if (pending) return true;
    // A warm window reveals at once — but only when its last paint is the newest payload sent,
    // so a person never sees the previous open's content first; otherwise it waits for that paint.
    if (!needsLoad && loaded && painted && lastPainted && lastPainted.gen >= sentGen) { reveal(w); return true; }
    showsOnWindow += 1;
    const attempt = showsOnWindow;
    const p = { attempt, timer: null, warm: !needsLoad && loaded && painted };
    pending = p;
    p.timer = safe(() => setTimer(() => { if (pending === p) backstop(w, attempt); }, FIRST_PAINT_BACKSTOP_MS));
    if (needsLoad) load(w);   // a synchronous load failure ends `pending` and falls back this click
    return pending === p;
  }

  /** Causes that end a waiting show WITHOUT the native menu: the person's own second click or
   *  Esc, and the native menu itself being popped (it is that click's answer already). */
  const QUIET_CAUSES = new Set(['toggle', 'dismiss', 'menu']);

  /**
   * Hides the popover. A show still WAITING for its first paint is cancelled; unless `cause` is
   * one of QUIET_CAUSES, that click then gets the native menu (fallback 'cancelled'), so a click
   * never produces neither a popover nor a menu.
   */
  function hide(cause) {
    const wasPending = !!pending;
    cancelPending();
    const w = live();
    if (w && windowVisible()) safe(() => w.hide());
    if (wasPending && !QUIET_CAUSES.has(cause) && !destroyed) {
      log('tray-popover: a waiting show was cancelled (fallback to the native menu)');
      fallback('cancelled');
    }
  }

  /** CI self-test only: from the PAGE's own context, ask for a file outside src/public/next/
   *  (a stylesheet, which the page's CSP allows as 'self'); the session's webRequest filter must
   *  cancel it. Resolves 'error' | 'load' | 'timeout' | null (no window). */
  function probeRefusedLoad() {
    const w = live();
    if (!w || !loaded) return Promise.resolve(null);
    const code = "new Promise(function (r) { var l = document.createElement('link'); l.rel = 'stylesheet';"
      + " l.href = '../../../package.json'; l.onload = function () { r('load'); };"
      + " l.onerror = function () { r('error'); }; setTimeout(function () { r('timeout'); }, 3000);"
      + ' document.head.appendChild(l); })';
    try { return Promise.resolve(w.webContents.executeJavaScript(code)).catch(() => null); } catch { return Promise.resolve(null); }
  }

  /** The tray icon's left click. */
  function toggle(trayBounds) {
    if (windowVisible() || pending) { hide('toggle'); return false; }
    if (now() - blurHiddenAt < TOGGLE_GRACE_MS) { blurHiddenAt = -Infinity; return false; }
    return show(trayBounds);
  }

  /**
   * Creates the hidden window and loads the page ahead of the first click (main calls it when
   * the tray starts), so that click only has to paint and reveal instead of falling back to the
   * native menu at the 1 s backstop on a cold load. Nothing is shown. A load that fails here is
   * not a click's failure (no fallback); the next show loads again.
   */
  function preload() {
    if (destroyed || off || pending) return false;
    let w;
    try { w = ensure(); } catch { return false; }
    if (needsLoad) load(w);
    return true;
  }

  /** A new payload (gate.publish(...)'s result). Sent at once when the page is loaded. The SAME
   *  payload object again (the gate found nothing changed) is not re-sent: no repaint. */
  function update(next) {
    if (destroyed || !next || typeof next !== 'object' || !Number.isSafeInteger(next.gen) || next.gen < 1) return;
    if (next === payload && sentGen === next.gen) return;
    payload = next;
    const t = next.theme === 'light' ? 'light' : 'dark';
    if (t !== theme) {
      theme = t;
      const w = live();
      if (w) safe(() => w.setBackgroundColor(BACKGROUND[t]));
    }
    send(next);
  }

  /** The main window got focus: hides the popover, except right after a show. */
  function mainWindowFocused() {
    if (now() - shownAt < MAIN_FOCUS_GRACE_MS) return;
    hide();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    ipc.dispose();
    const w = win;
    resetWindow();
    if (w && safe(() => w.isDestroyed()) !== true) safe(() => w.destroy());
  }

  const ipc = registerTrayPopoverIpc({
    ipcMain: deps.ipcMain,
    gate: deps.gate,
    quit: deps.quit,
    target: {
      webContents: () => { const w = live(); return w ? w.webContents : null; },
      isShown: () => windowVisible() && !pending,
      currentGen: () => sentGen,
      knownId: (id) => sentIds.has(id),
      pagePath,
      platform,
    },
    onActed: () => hide(),
    resend: () => { const c = safe(() => deps.gate.current()); if (c) { payload = c; send(c); } },
    onSize: ({ height }) => {
      contentHeight = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(height)));
      const w = live();
      if (w && windowVisible()) place(w);
    },
    onPainted,
    onDismiss: () => { dismissals += 1; hide('dismiss'); },
  });

  return {
    show,
    hide,
    toggle,
    preload,
    update,
    destroy,
    mainWindowFocused,
    isVisible: () => windowVisible(),
    isEnabled: () => !off && !destroyed,
    /** For P5's CI self-test and for diagnostics: no content, only state. */
    stats: () => ({
      failures, failuresTotal, off, visible: windowVisible(), waiting: !!pending,
      loaded, painted, sentGen, lastPainted, bounds: lastBounds, cspViolations, dismissals, refusedRequests,
    }),
    /** For the CI self-test only (lib/tray-popover-selftest.js): one real key press into the
     *  page, as a person's keyboard would deliver it. False when there is no window. */
    pressKey: (keyCode) => {
      const w = live();
      if (!w || typeof keyCode !== 'string') return false;
      return safe(() => {
        w.webContents.sendInputEvent({ type: 'keyDown', keyCode });
        w.webContents.sendInputEvent({ type: 'keyUp', keyCode });
        return true;
      }) === true;
    },
    /** For the CI self-test only: see probeRefusedLoad. */
    probeRefusedLoad,
  };
}
