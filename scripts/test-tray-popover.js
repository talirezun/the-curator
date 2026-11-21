/**
 * test-tray-popover.js — OFFLINE guard for the Windows tray popover's controller, preload and IPC
 * (desktop/lib/tray-popover.js, tray-popover-preload.js, tray-popover-ipc.js; package P4).
 *
 * Electron is never loaded: every Electron object is a recording FAKE (AgentLink-style), driven
 * with a manual clock, so each state is EXECUTED: the 300 ms toggle grace (only with the pointer on
 * the icon), the 150 ms early-blur ignore and its focus re-check, the first-paint wait and its 1 s
 * backstop (fallback to the native menu; a cold first load is not counted), the 500 ms main-window
 * focus grace, Esc (the page's dismiss), close → hide, a renderer crash → fallback and reload, two
 * failures → off for the session, the position via computePopoverPosition, the window and session
 * hardening, and every IPC refusal (wrong sender, sub-frame, wrong URL, hidden, waiting to paint,
 * stale gen, unknown id, extra keys, wrong types). The preload is run in a vm with a fake
 * `require('electron')` and a fake navigator: the user-activation gate, one call in flight, the
 * exact message shapes. Nothing touches user data or the network.
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(__dirname, '..', 'desktop', 'lib');
const imp = (f) => import(pathToFileURL(path.join(LIB, f)).href);
const pop = await imp('tray-popover.js');
const ipcMod = await imp('tray-popover-ipc.js');
const { computePopoverPosition } = await imp('tray-popover-position.js');
const {
  createTrayPopover, popoverWindowOptions, requestAllowed, actionIdsOf,
  TOGGLE_GRACE_MS, SHOW_BLUR_IGNORE_MS, MAIN_FOCUS_GRACE_MS, FIRST_PAINT_BACKSTOP_MS, MAX_FAILURES,
  POPOVER_WIDTH, MIN_HEIGHT, PARTITION, BACKGROUND,
} = pop;
const { CHANNELS, parseAct, parseSize, parsePainted, parseDismiss, isPageUrl, fileUrlToPlatformPath } = ipcMod;

let passed = 0, failed = 0;
function ok(cond, label, extra) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''}`); }
}
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), label, { got: a, want: b });
const flush = () => new Promise((r) => setImmediate(r));

// ── Fakes ────────────────────────────────────────────────────────────────────

const PAGE = 'C:\\Users\\Ana\\AppData\\Local\\Programs\\the-curator\\resources\\app\\src\\public\\next\\tray-popover.html';
const PAGE_URL = 'file:///C:/Users/Ana/AppData/Local/Programs/the-curator/resources/app/src/public/next/tray-popover.html';
const PRELOAD = 'C:\\Users\\Ana\\AppData\\Local\\Programs\\the-curator\\resources\\app\\lib\\tray-popover-preload.js';

class Emitter {
  constructor() { this.l = new Map(); }
  on(ev, fn) { if (!this.l.has(ev)) this.l.set(ev, []); this.l.get(ev).push(fn); return this; }
  once(ev, fn) { const w = (...a) => { this.off(ev, w); fn(...a); }; return this.on(ev, w); }
  off(ev, fn) { const a = this.l.get(ev) || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
  emit(ev, ...args) { for (const fn of [...(this.l.get(ev) || [])]) fn(...args); }
  count(ev) { return (this.l.get(ev) || []).length; }
}
const evt = () => ({ prevented: false, preventDefault() { this.prevented = true; } });

function makeRig(opts = {}) {
  let t = 1000;
  const timers = [];
  let seq = 0;
  const clock = {
    now: () => t,
    setTimer: (cb, ms) => { const id = ++seq; timers.push({ id, at: t + ms, cb }); return id; },
    clearTimer: (id) => { const i = timers.findIndex((x) => x.id === id); if (i >= 0) timers.splice(i, 1); },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at || a.id - b.id);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        t = next.at;
        next.cb();
      }
      t = end;
    },
  };
  const windows = [];
  class FakeWebContents extends Emitter {
    constructor() {
      super();
      this.sent = [];
      this.mainFrame = { url: '', parent: null, processId: 7, routingId: 1 };
      this.openHandler = null;
    }
    send(ch, p) { this.sent.push([ch, p]); }
    setWindowOpenHandler(fn) { this.openHandler = fn; }
  }
  class FakeWindow extends Emitter {
    constructor(options) {
      super();
      if (rig.throwOnCreate) throw new Error('cannot create');
      this.options = options;
      this.webContents = new FakeWebContents();
      this.visible = false; this.focused = false; this.destroyed = false;
      this.bounds = { x: 0, y: 0, width: options.width, height: options.height };
      this.setBoundsLog = []; this.loads = []; this.menu = 'default'; this.bg = options.backgroundColor;
      this.boundsDrift = null;
      windows.push(this);
    }
    show() { this.visible = true; this.focused = true; }
    hide() { this.visible = false; this.focused = false; }
    focus() { this.focused = true; this.focusCalls = (this.focusCalls || 0) + 1; }
    isFocused() { return this.focused; }
    isVisible() { return this.visible; }
    isDestroyed() { return this.destroyed; }
    destroy() { if (this.destroyed) return; this.destroyed = true; this.visible = false; this.emit('closed'); }
    setBounds(b) { this.setBoundsLog.push({ ...b }); this.bounds = this.boundsDrift ? this.boundsDrift(b, this.setBoundsLog.length) : { ...b }; }
    getBounds() { return { ...this.bounds }; }
    setMenu(m) { this.menu = m; }
    setBackgroundColor(c) { this.bg = c; }
    loadFile(p) {
      this.loads.push(p);
      if (rig.loadThrows) throw new Error('sync load failure');
      return rig.loadReject ? Promise.reject(new Error('ERR_FILE_NOT_FOUND')) : Promise.resolve();
    }
    // test helpers
    finishLoad(url = PAGE_URL) { this.webContents.mainFrame.url = url; this.webContents.emit('did-finish-load'); }
    close() { const e = evt(); this.emit('close', e); if (!e.prevented) this.destroy(); return e; }
  }
  const sessions = [];
  const session = {
    fromPartition(name, o) {
      const ses = new Emitter();
      ses.name = name; ses.opts = o;
      ses.webRequest = { onBeforeRequest(fn) { ses.beforeRequest = fn; } };
      ses.setPermissionRequestHandler = (fn) => { ses.permReq = fn; };
      ses.setPermissionCheckHandler = (fn) => { ses.permCheck = fn; };
      ses.setDevicePermissionHandler = (fn) => { ses.devPerm = fn; };
      ses.setDisplayMediaRequestHandler = (fn) => { ses.displayMedia = fn; };
      sessions.push(ses);
      return ses;
    },
  };
  const ipcMain = {
    handlers: new Map(), listeners: new Map(),
    handle(ch, fn) { if (this.handlers.has(ch)) throw new Error('second handler for ' + ch); this.handlers.set(ch, fn); },
    removeHandler(ch) { this.handlers.delete(ch); },
    on(ch, fn) { if (!this.listeners.has(ch)) this.listeners.set(ch, []); this.listeners.get(ch).push(fn); },
    removeListener(ch, fn) { const a = this.listeners.get(ch) || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
    invoke(ch, event, msg) { const h = this.handlers.get(ch); return h ? h(event, msg) : Promise.resolve('no-handler'); },
    send(ch, event, msg) { for (const fn of this.listeners.get(ch) || []) fn(event, msg); },
  };
  const DISPLAY = {
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1032 },
    scaleFactor: 1.5,
  };
  const screen = {
    cursor: { x: 1810, y: 1050 },
    display: DISPLAY,
    getDisplayMatching() { return this.display; },
    getDisplayNearestPoint() { return this.display; },
    getPrimaryDisplay() { return this.display; },
    getCursorScreenPoint() { return this.cursor; },
  };
  // A minimal gate with the contract's shape (CONTRACT §2): resolve by current gen + own-property id.
  const gate = {
    gen: 0, payload: null, actions: new Map(), calls: [],
    publish(p) { this.gen += 1; this.payload = { ...p, gen: this.gen }; this.actions = new Map(actionIdsToFns(this.payload)); return this.payload; },
    current() { return this.payload; },
    act(g, id, o) {
      this.calls.push([g, id]);
      if (g !== this.gen || !this.actions.has(id)) return false;
      const a = this.actions.get(id);
      if (a === 'quit') { o.quit(); return true; }
      a(); return true;
    },
  };
  const clicks = [];
  function actionIdsToFns(p) {
    return [...actionIdsOf(p)].map((id) => [id, id === 'tray-quit' ? 'quit' : () => clicks.push(id)]);
  }
  const fallbacks = [];
  const logs = [];
  const rig = {
    clock, windows, sessions, ipcMain, screen, gate, clicks, fallbacks, logs,
    quits: 0, quitting: false, throwOnCreate: false, loadReject: false, loadThrows: false,
    trayBounds: { x: 1800, y: 1040, width: 24, height: 32 },
  };
  rig.popover = createTrayPopover({
    BrowserWindow: FakeWindow, screen, session, ipcMain, gate,
    pagePath: PAGE, preloadPath: PRELOAD, platform: 'win32', isPackaged: true,
    quit: () => { rig.quits += 1; },
    isQuitting: () => rig.quitting,
    onFallback: (r) => fallbacks.push(r),
    log: (l) => logs.push(l),
    getTrayBounds: () => rig.trayBounds,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    ...opts,
  });
  rig.win = () => windows[windows.length - 1];
  rig.publish = (extraRows = []) => rig.popover.update(rig.gate.publish(samplePayload(extraRows)));
  // The page: paints the last payload it was sent.
  rig.paint = (w = rig.win(), rows = 5) => {
    const last = w.webContents.sent.filter(([ch]) => ch === CHANNELS.model).pop();
    ipcMain.send(CHANNELS.painted, rig.ev(w), { gen: last ? last[1].gen : 1, rows });
  };
  rig.ev = (w = rig.win()) => ({ sender: w.webContents, senderFrame: w.webContents.mainFrame });
  /** Opens it fully: show, load, paint. */
  rig.open = () => {
    if (!rig.gate.payload) rig.publish();
    rig.popover.show(rig.trayBounds);
    const w = rig.win();
    if (w.loads.length && !w.webContents.mainFrame.url) w.finishLoad();
    rig.paint(w);
    return w;
  };
  return rig;
}

function samplePayload(extraRows = []) {
  return {
    v: 1, gen: 0, theme: 'dark', root: 'root',
    pages: {
      root: { id: 'root', parent: null, title: null, subtitle: null, details: [], rows: [
        { kind: 'header', key: 'k0', label: 'Active · last 24 h' },
        { kind: 'drill', key: 'k1', drill: 'p:0', label: 'ott', sublabel: null, img: null },
        { kind: 'action', key: 'k2', id: 'tray-open-memory', label: 'Open Project Context…', sublabel: null, img: null },
        ...extraRows,
        { kind: 'action', key: 'k9', id: 'tray-quit', label: 'Quit The Curator', sublabel: null, img: null },
      ] },
      'p:0': { id: 'p:0', parent: 'root', title: 'ott', subtitle: null, details: [], rows: [
        { kind: 'action', key: 'k3', id: 'tray-row-0:open', label: 'Open in The Curator', sublabel: null, img: null },
      ] },
    },
  };
}

// ── §0 positive controls ────────────────────────────────────────────────────
console.log('\n§0 constants and positive controls');
ok(TOGGLE_GRACE_MS === 300 && SHOW_BLUR_IGNORE_MS === 150 && MAIN_FOCUS_GRACE_MS === 500
  && FIRST_PAINT_BACKSTOP_MS === 1000 && MAX_FAILURES === 2, 'AgentLink\'s measured timings and two failures');
eq(CHANNELS, { model: 'curator-tray:model', act: 'curator-tray:act', size: 'curator-tray:size',
  painted: 'curator-tray:painted', dismiss: 'curator-tray:dismiss' }, 'the contract\'s five channel names');
{
  const r = makeRig();
  const w = r.open();
  ok(w.visible && w.focused, 'a full open (show → load → paint) puts a focused window on screen');
  eq([...actionIdsOf(r.gate.payload)].sort(), ['tray-open-memory', 'tray-quit', 'tray-row-0:open'], 'actionIdsOf: exactly the action rows, every page');
}

// ── §1 the window and its session ───────────────────────────────────────────
console.log('\n§1 window options and session hardening');
{
  const r = makeRig();
  r.publish();
  r.popover.show(r.trayBounds);
  const w = r.win();
  const o = w.options;
  const wp = o.webPreferences;
  ok(o.frame === false && o.resizable === false && o.movable === false && o.skipTaskbar === true
    && o.alwaysOnTop === true && o.show === false && o.transparent === false && o.minimizable === false
    && o.maximizable === false && o.fullscreenable === false, 'frameless, fixed, off the taskbar, on top, hidden until painted, opaque');
  ok(wp.sandbox === true && wp.contextIsolation === true && wp.nodeIntegration === false
    && wp.nodeIntegrationInSubFrames === false && wp.nodeIntegrationInWorker === false && wp.webviewTag === false
    && wp.webSecurity === true, 'sandbox, context isolation, no Node anywhere, no webview');
  ok(wp.preload === PRELOAD, 'its own preload');
  ok(wp.devTools === false, 'no devtools when packaged');
  ok(popoverWindowOptions({ isPackaged: false }).webPreferences.devTools === true, 'devtools only in a dev run');
  ok(o.width === POPOVER_WIDTH && o.backgroundColor === BACKGROUND.dark, '360 px wide, the dark surface by default');
  ok(w.menu === null, 'the window has no menu (no accelerators)');
  eq(w.loads, [PAGE], 'loads exactly the page file');
  ok(r.sessions.length === 1 && r.sessions[0].name === PARTITION && !/^persist:/.test(r.sessions[0].name)
    && wp.session === r.sessions[0], 'its OWN in-memory partition, handed to the window');
  const s = r.sessions[0];
  let granted = 'unset';
  s.permReq(w.webContents, 'notifications', (v) => { granted = v; });
  ok(granted === false, 'a permission request is denied');
  ok(s.permCheck(w.webContents, 'clipboard-read', 'file://') === false && s.permCheck(null, 'media') === false, 'a permission check is denied');
  ok(s.devPerm() === false, 'device permissions denied');
  let dm = 'unset'; s.displayMedia({}, (v) => { dm = v; });
  eq(dm, {}, 'screen capture answered with nothing');
  const cancel = (url) => { let res; s.beforeRequest({ url }, (v) => { res = v; }); return res.cancel; };
  ok(cancel(PAGE_URL) === false, 'the page itself loads');
  ok(cancel('file:///C:/Users/Ana/AppData/Local/Programs/the-curator/resources/app/src/public/next/views/tray-popover.css') === false
    && cancel('file:///C:/Users/Ana/AppData/Local/Programs/the-curator/resources/app/src/public/next/tokens/color.css') === false, 'its css/js/tokens beside it load');
  ok(cancel('data:image/png;base64,AAAA') === false, 'data: pictures load');
  ok(cancel('https://fonts.googleapis.com/css2?family=Inter') === true, 'https is cancelled (no remote content)');
  ok(cancel('http://127.0.0.1:3333/api/config') === true, 'the local server is cancelled too');
  ok(cancel('file:///C:/Users/Ana/.curator-config.json') === true
    && cancel('file:///C:/Users/Ana/AppData/Local/Programs/the-curator/resources/app/src/public/secret.json') === true,
  'a file: outside the page\'s folder is cancelled');
  ok(cancel('file:///C:/Users/Ana/AppData/Local/Programs/the-curator/resources/app/src/public/next/../../brain/config.js') === true,
    'a ../ escape is cancelled');
  ok(cancel('file://server/share/src/public/next/tray-popover.html') === true, 'a UNC file: is cancelled');
  ok(cancel('blob:file:///x') === true && cancel('javascript:alert(1)') === true && cancel('chrome://gpu') === true, 'other schemes are cancelled');
  let dl = { cancelled: false, cancel() { this.cancelled = true; } }; const de = evt();
  s.emit('will-download', de, dl);
  ok(de.prevented && dl.cancelled, 'downloads refused');
  for (const ev of ['will-navigate', 'will-redirect', 'will-frame-navigate', 'will-attach-webview']) {
    const e = evt(); w.webContents.emit(ev, e, 'https://example.com/');
    ok(e.prevented, `${ev} always refused`);
  }
  {
    const e = evt(); w.webContents.emit('will-navigate', e, PAGE_URL);
    ok(e.prevented, 'even a navigation to the page itself is refused (only main loads it)');
  }
  eq(w.webContents.openHandler({ url: 'https://example.com' }), { action: 'deny' }, 'new windows denied');
  for (const input of [{ type: 'keyDown', key: 'r', control: true }, { type: 'keyDown', key: '=', control: true },
    { type: 'keyDown', key: 'F4', alt: true }, { type: 'keyDown', key: 'w', meta: true }]) {
    const e = evt(); w.webContents.emit('before-input-event', e, input);
    ok(e.prevented, `accelerator swallowed: ${JSON.stringify(input)}`);
  }
  for (const key of ['ArrowDown', 'Enter', 'Escape', 'Backspace', 'Home']) {
    const e = evt(); w.webContents.emit('before-input-event', e, { type: 'keyDown', key });
    ok(!e.prevented, `plain ${key} reaches the page (its key map)`);
  }
  const pe = evt(); w.emit('page-title-updated', pe);
  ok(pe.prevented, 'the page cannot retitle the window');
}

// ── §2 first paint and its backstop ─────────────────────────────────────────
console.log('\n§2 the first show waits for the page\'s paint');
{
  const r = makeRig();
  r.publish();
  ok(r.popover.show(r.trayBounds) === true, 'show() answers true while it waits');
  const w = r.win();
  ok(!w.visible, 'not on screen before the page loaded');
  w.finishLoad();
  const sent = w.webContents.sent.filter(([ch]) => ch === CHANNELS.model);
  ok(sent.length === 1 && sent[0][1].gen === 1, 'the payload is sent once the page loaded');
  ok(!w.visible, 'loaded is not painted: still hidden (no blank flash)');
  r.ipcMain.send(CHANNELS.painted, r.ev(w), { gen: 2, rows: 4 });
  ok(!w.visible, 'a paint of a gen never sent does not count');
  r.paint(w, 4);
  ok(w.visible && w.focused, 'the page\'s paint reveals it');
  eq(r.popover.stats().lastPainted, { gen: 1, rows: 4 }, 'stats carry the painted gen and rows (CI self-test)');
  r.clock.advance(FIRST_PAINT_BACKSTOP_MS + 10);
  ok(r.fallbacks.length === 0 && w.visible, 'the backstop was cancelled by the paint');
}
{
  // loaded, never painted → that click falls back, one failure counted, one log line
  const r = makeRig();
  r.publish();
  r.popover.show(r.trayBounds);
  const w = r.win();
  w.finishLoad();
  r.clock.advance(FIRST_PAINT_BACKSTOP_MS - 1);
  ok(r.fallbacks.length === 0 && !w.visible, 'nothing at 999 ms');
  r.clock.advance(1);
  eq(r.fallbacks, ['no-paint'], 'at 1 s the click falls back to the native menu');
  ok(!w.visible && r.popover.stats().failures === 1 && r.logs.length === 1, 'not shown, one failure, one log line');
  r.paint(w);
  ok(!w.visible, 'a late paint after the fallback does not pop it up over the native menu');
}
{
  // a cold first load: no fallback counted
  const r = makeRig();
  r.publish();
  r.popover.show(r.trayBounds);
  r.clock.advance(FIRST_PAINT_BACKSTOP_MS);
  eq(r.fallbacks, ['slow-load'], 'still loading at the first click: native menu for this click');
  ok(r.popover.stats().failures === 0 && r.popover.isEnabled(), 'a cold start is not a failure');
  const w = r.win();
  w.finishLoad(); r.paint(w);
  ok(!w.visible, 'the late paint does not reveal it');
  r.popover.show(r.trayBounds);
  ok(w.visible && w.loads.length === 1, 'the next click shows it at once, without a reload');
}
{
  // loaded after a cold-start fallback but NEVER painted: the next click must still wait
  const r = makeRig();
  r.publish();
  r.popover.show(r.trayBounds);
  r.clock.advance(FIRST_PAINT_BACKSTOP_MS);
  const w = r.win();
  w.finishLoad();
  r.popover.show(r.trayBounds);
  ok(!w.visible, 'loaded but not painted: the next click waits for the paint (never a blank window)');
  r.paint(w);
  ok(w.visible, 'and shows on the paint');
}
{
  // a second slow show on the same window IS a failure
  const r = makeRig();
  r.publish();
  r.popover.show(r.trayBounds); r.clock.advance(FIRST_PAINT_BACKSTOP_MS);
  r.popover.show(r.trayBounds); r.clock.advance(FIRST_PAINT_BACKSTOP_MS);
  eq(r.fallbacks, ['slow-load', 'no-paint'], 'a window still not loaded at its second show counts');
  ok(r.popover.stats().failures === 1, 'one failure');
}

// ── §3 toggle, blur and focus ───────────────────────────────────────────────
console.log('\n§3 toggle grace, early blur, main-window focus');
{
  const r = makeRig();
  const w = r.open();
  r.clock.advance(1000);
  // the click on the icon: the popover blurs first (pointer on the icon), then the click's toggle
  r.screen.cursor = { x: 1810, y: 1050 };
  w.emit('blur');
  ok(!w.visible, 'a blur hides it');
  r.clock.advance(TOGGLE_GRACE_MS - 1);
  ok(r.popover.toggle(r.trayBounds) === false && !w.visible, 'that click\'s toggle within 300 ms does NOT reopen it');
  ok(r.popover.toggle(r.trayBounds) === true && w.visible, 'the next click opens it again (the grace is spent)');
}
{
  const r = makeRig();
  const w = r.open();
  r.clock.advance(1000);
  w.emit('blur'); r.clock.advance(TOGGLE_GRACE_MS);
  r.popover.toggle(r.trayBounds);
  ok(w.visible, 'a click 300 ms after the blur opens it');
}
{
  const r = makeRig();
  const w = r.open();
  r.clock.advance(1000);
  r.screen.cursor = { x: 400, y: 300 };   // the person clicked another app
  w.emit('blur');
  r.clock.advance(50);
  r.popover.toggle(r.trayBounds);
  ok(w.visible, 'a blur with the pointer AWAY from the icon never swallows the next real click');
}
{
  const r = makeRig();
  const w = r.open();
  r.clock.advance(1000);
  ok(r.popover.toggle(r.trayBounds) === false && !w.visible, 'a click while it is up hides it');
}
{
  // early blur: ignored, refocused once, then hidden if still unfocused
  const r = makeRig();
  const w = r.open();
  w.focused = false;
  r.clock.advance(40);
  w.emit('blur');
  ok(w.visible, 'a blur 40 ms after the show is ignored');
  const focusBefore = w.focusCalls || 0;
  r.clock.advance(SHOW_BLUR_IGNORE_MS - 40);
  ok(w.visible && (w.focusCalls || 0) === focusBefore + 1, 'at 150 ms: still up, focus asked for once');
  w.focused = false;
  r.clock.advance(SHOW_BLUR_IGNORE_MS);
  ok(!w.visible, 'still unfocused at the next check: hidden (never left up over the main window)');
}
{
  const r = makeRig();
  const w = r.open();
  r.clock.advance(40);
  w.emit('blur');
  w.focused = true;
  r.clock.advance(SHOW_BLUR_IGNORE_MS * 3);
  ok(w.visible, 'an ignored early blur followed by focus keeps it up');
}
{
  const r = makeRig();
  const w = r.open();
  r.clock.advance(MAIN_FOCUS_GRACE_MS - 1);
  r.popover.mainWindowFocused();
  ok(w.visible, 'main-window focus within 500 ms of a show keeps it');
  r.clock.advance(1);
  r.popover.mainWindowFocused();
  ok(!w.visible, 'main-window focus after 500 ms hides it');
}

// ── §4 Esc, close, act → hide ────────────────────────────────────────────────
console.log('\n§4 Esc (dismiss), close → hide, quit');
{
  const r = makeRig();
  const w = r.open();
  r.ipcMain.send(CHANNELS.dismiss, r.ev(w), {});
  ok(!w.visible, 'the page\'s dismiss (Esc on root) hides it');
  r.clock.advance(1000);
  r.popover.show(r.trayBounds);
  const e = w.close();
  ok(e.prevented && !w.destroyed && !w.visible, 'close (Alt+F4) only hides');
  r.quitting = true;
  r.popover.show(r.trayBounds);
  const e2 = w.close();
  ok(!e2.prevented && w.destroyed, 'while quitting, close really closes');
  ok(r.popover.isVisible() === false, 'the controller forgets a closed window');
}
{
  const r = makeRig();
  const w = r.open();
  r.popover.destroy();
  ok(w.destroyed, 'destroy() destroys the window');
  ok(r.ipcMain.handlers.size === 0 && [...r.ipcMain.listeners.values()].every((a) => a.length === 0), 'destroy() removes every IPC handler it added');
  ok(r.popover.show(r.trayBounds) === false && r.windows.length === 1, 'nothing after destroy');
}

// ── §5 crash and failures ───────────────────────────────────────────────────
console.log('\n§5 renderer crash, load failure, build failure, off for the session');
{
  const r = makeRig();
  const w = r.open();
  w.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  ok(!w.visible && r.popover.stats().failures === 1, 'a crash hides it and counts one failure');
  ok(r.fallbacks.length === 0, 'a crash with no click waiting pops no menu');
  r.clock.advance(1000);
  r.popover.show(r.trayBounds);
  ok(w.loads.length === 2 && !w.visible, 'the next show RELOADS the page and waits for its paint');
  w.finishLoad(); r.paint(w);
  ok(w.visible, 'the reloaded page shows');
}
{
  const r = makeRig();
  r.publish();
  r.popover.show(r.trayBounds);
  const w = r.win();
  w.webContents.emit('render-process-gone', {}, { reason: 'oom' });
  eq(r.fallbacks, ['crashed'], 'a crash while a click waits: that click falls back');
  r.popover.show(r.trayBounds);
  w.webContents.emit('render-process-gone', {}, { reason: 'oom' });
  eq(r.fallbacks, ['crashed', 'crashed'], 'second crash falls back too');
  ok(r.popover.isEnabled() === false && w.destroyed, 'two failures: off for the session, window destroyed');
  ok(r.logs.some((l) => /off for this session/.test(l)), 'logged once that it is off');
  const logsBefore = r.logs.length;
  ok(r.popover.show(r.trayBounds) === false, 'show() refuses');
  eq(r.fallbacks.slice(-1), ['off'], 'and every later click gets the native menu at once');
  ok(r.windows.length === 1 && r.logs.length === logsBefore, 'no new window, no log spam');
}
{
  const r = makeRig();
  r.loadReject = true;
  r.publish();
  r.popover.show(r.trayBounds);
  await flush();
  const w = r.win();
  w.webContents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', PAGE_URL, true);
  eq(r.fallbacks, ['load-failed'], 'a load failure falls back that click, once (rejection + did-fail-load)');
  ok(r.popover.stats().failures === 1, 'one failure for one load');
}
{
  const r = makeRig();
  r.publish();
  r.popover.show(r.trayBounds);
  const w = r.win();
  w.webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', PAGE_URL, true);
  w.webContents.emit('did-fail-load', {}, -6, 'x', 'file:///sub', false);
  ok(r.fallbacks.length === 0, 'ERR_ABORTED and sub-frame failures are not failures');
}
{
  const r = makeRig();
  r.loadThrows = true;
  r.publish();
  ok(r.popover.show(r.trayBounds) === false, 'a synchronous load failure: show() answers false');
  eq(r.fallbacks, ['load-failed'], 'and that click falls back');
}
{
  const r = makeRig();
  r.throwOnCreate = true;
  r.publish();
  ok(r.popover.show(r.trayBounds) === false, 'a window that cannot be built: false');
  eq(r.fallbacks, ['build-failed'], 'and that click falls back');
  r.popover.show(r.trayBounds);
  ok(r.popover.isEnabled() === false, 'twice: off');
}

// ── §6 position ─────────────────────────────────────────────────────────────
console.log('\n§6 position via computePopoverPosition, height from the page');
{
  const r = makeRig();
  const w = r.open();
  const want = computePopoverPosition({ trayBounds: r.trayBounds, display: r.screen.display, cursor: r.screen.cursor,
    scaleFactor: 1.5, size: { width: POPOVER_WIDTH, height: pop.INITIAL_HEIGHT } });
  eq(w.bounds, { x: want.x, y: want.y, width: want.width, height: want.height }, 'bounds are exactly computePopoverPosition\'s');
  ok(want.edge === 'bottom' && w.bounds.y + w.bounds.height <= 1032, 'above a bottom taskbar, inside the work area');
  r.ipcMain.send(CHANNELS.size, r.ev(w), { height: 300.4 });
  const want2 = computePopoverPosition({ trayBounds: r.trayBounds, display: r.screen.display, scaleFactor: 1.5,
    size: { width: POPOVER_WIDTH, height: 301 } });
  eq(w.bounds, { x: want2.x, y: want2.y, width: 360, height: 301 }, 'the page\'s height (rounded up) re-places it at once');
  r.ipcMain.send(CHANNELS.size, r.ev(w), { height: 5 });
  ok(w.bounds.height === MIN_HEIGHT, 'never smaller than one row');
  r.ipcMain.send(CHANNELS.size, r.ev(w), { height: 99999 });
  ok(w.bounds.height === 1032 - 16, 'never taller than the work area less two margins');
  r.ipcMain.send(CHANNELS.size, r.ev(w), { height: NaN });
  r.ipcMain.send(CHANNELS.size, r.ev(w), { height: 200, x: 1 });
  ok(w.bounds.height === 1032 - 16, 'junk sizes ignored');
}
{
  // a top taskbar on a secondary display at negative x
  const r = makeRig();
  r.screen.display = { bounds: { x: -2560, y: 0, width: 2560, height: 1440 }, workArea: { x: -2560, y: 40, width: 2560, height: 1400 }, scaleFactor: 1 };
  r.trayBounds = { x: -100, y: 4, width: 32, height: 32 };
  r.screen.cursor = { x: -90, y: 10 };
  const w = r.open();
  ok(w.bounds.x < 0 && w.bounds.y === 46 && w.bounds.x + w.bounds.width <= 0 - 8 + 0.0001, 'top taskbar, display at negative x: below it, inside', w.bounds);
}
{
  // unusable tray bounds → the cursor
  const r = makeRig();
  r.trayBounds = { x: NaN, y: 0, width: 0, height: 0 };
  r.screen.cursor = { x: 1000, y: 1050 };
  const w = r.open();
  ok(w.bounds.x === 1000 - 180 && w.bounds.y + w.bounds.height <= 1032, 'unusable icon bounds: placed from the cursor', w.bounds);
}
{
  // mixed DPI: the first setBounds lands wrong, so it is set again
  const r = makeRig();
  r.publish();
  r.popover.show(r.trayBounds);
  const w = r.win();
  w.boundsDrift = (b, n) => (n === 1 ? { ...b, width: Math.round(b.width * 1.25) } : { ...b });
  w.finishLoad(); r.paint(w);
  ok(w.setBoundsLog.length === 2 && w.bounds.width === 360, 'a setBounds that did not land is repeated once', w.setBoundsLog);
}

// ── §7 payload flow and theme ───────────────────────────────────────────────
console.log('\n§7 update(payload)');
{
  const r = makeRig();
  const w = r.open();
  r.publish();
  const sent = w.webContents.sent.filter(([ch]) => ch === CHANNELS.model).map(([, p]) => p.gen);
  eq(sent, [1, 2], 'a new payload while loaded is sent at once');
  r.popover.update({ gen: 0 }); r.popover.update(null); r.popover.update({ gen: 'x' });
  ok(w.webContents.sent.length === 2, 'an unpublished or junk payload is never sent');
  r.popover.update({ ...r.gate.publish(samplePayload()), theme: 'light' });
  ok(w.bg === BACKGROUND.light, 'a light payload turns the window background light (no dark flash)');
}

// ── §8 IPC: act and every refusal ───────────────────────────────────────────
console.log('\n§8 act, and every refusal');
async function actRig() {
  const r = makeRig();
  const w = r.open();
  return { r, w };
}
{
  const { r, w } = await actRig();
  const okAns = await r.ipcMain.invoke(CHANNELS.act, r.ev(w), { gen: 1, id: 'tray-open-memory' });
  ok(okAns === true && r.clicks.join() === 'tray-open-memory', 'a valid act runs the template\'s click and answers true');
  ok(!w.visible, 'and hides the popover');
}
{
  const { r, w } = await actRig();
  const ans = await r.ipcMain.invoke(CHANNELS.act, r.ev(w), { gen: 1, id: 'tray-quit' });
  ok(ans === true && r.quits === 1, 'Quit runs the injected quit (main passes app.quit, never app.exit)');
}
{
  const { r, w } = await actRig();
  const ans = await r.ipcMain.invoke(CHANNELS.act, r.ev(w), { gen: 1, id: 'tray-row-0:open' });
  ok(ans === true && r.clicks.join() === 'tray-row-0:open', 'an action on a drill page works');
}
const refusals = [
  ['wrong sender (another webContents)', (r, w) => [{ sender: { mainFrame: w.webContents.mainFrame }, senderFrame: w.webContents.mainFrame }, { gen: 1, id: 'tray-open-memory' }]],
  ['sub-frame', (r, w) => [{ sender: w.webContents, senderFrame: { url: PAGE_URL, parent: w.webContents.mainFrame, processId: 7, routingId: 9 } }, { gen: 1, id: 'tray-open-memory' }]],
  ['a top frame with other ids', (r, w) => [{ sender: w.webContents, senderFrame: { url: PAGE_URL, parent: null, processId: 7, routingId: 2 } }, { gen: 1, id: 'tray-open-memory' }]],
  ['no sender frame', (r, w) => [{ sender: w.webContents, senderFrame: null }, { gen: 1, id: 'tray-open-memory' }]],
  ['wrong URL (another file)', (r, w) => { w.webContents.mainFrame.url = PAGE_URL.replace('tray-popover.html', 'index.html'); return [r.ev(w), { gen: 1, id: 'tray-open-memory' }]; }],
  ['wrong URL (a query)', (r, w) => { w.webContents.mainFrame.url = PAGE_URL + '?x=1'; return [r.ev(w), { gen: 1, id: 'tray-open-memory' }]; }],
  ['wrong URL (an empty query)', (r, w) => { w.webContents.mainFrame.url = PAGE_URL + '?'; return [r.ev(w), { gen: 1, id: 'tray-open-memory' }]; }],
  ['wrong URL (an empty fragment)', (r, w) => { w.webContents.mainFrame.url = PAGE_URL + '#'; return [r.ev(w), { gen: 1, id: 'tray-open-memory' }]; }],
  ['a frame with a parent, even with the top frame\'s ids', (r, w) => [{ sender: w.webContents, senderFrame: { url: PAGE_URL, parent: {}, processId: 7, routingId: 1 } }, { gen: 1, id: 'tray-open-memory' }]],
  ['wrong URL (a fragment)', (r, w) => { w.webContents.mainFrame.url = PAGE_URL + '#p'; return [r.ev(w), { gen: 1, id: 'tray-open-memory' }]; }],
  ['wrong URL (http)', (r, w) => { w.webContents.mainFrame.url = 'http://127.0.0.1:3333/next/tray-popover.html'; return [r.ev(w), { gen: 1, id: 'tray-open-memory' }]; }],
  ['hidden', (r, w) => { r.popover.hide(); return [r.ev(w), { gen: 1, id: 'tray-open-memory' }]; }],
  ['stale gen', (r, w) => { r.publish(); return [r.ev(w), { gen: 1, id: 'tray-open-memory' }]; }],
  ['a gen not yet sent', (r, w) => [r.ev(w), { gen: 2, id: 'tray-open-memory' }]],
  ['unknown id', (r, w) => [r.ev(w), { gen: 1, id: 'tray-row-9:open' }]],
  ['a drill row\'s key is not an id', (r, w) => [r.ev(w), { gen: 1, id: 'k1' }]],
  ['prototype id', (r, w) => [r.ev(w), { gen: 1, id: '__proto__' }]],
  ['extra key', (r, w) => [r.ev(w), { gen: 1, id: 'tray-open-memory', also: 1 }]],
  ['missing key', (r, w) => [r.ev(w), { gen: 1 }]],
  ['gen as a string', (r, w) => [r.ev(w), { gen: '1', id: 'tray-open-memory' }]],
  ['id too long', (r, w) => [r.ev(w), { gen: 1, id: 'x'.repeat(201) }]],
  ['an array', (r, w) => [r.ev(w), [1, 'tray-open-memory']]],
  ['a class instance', (r, w) => [r.ev(w), Object.assign(Object.create({ evil: 1 }), { gen: 1, id: 'tray-open-memory' })]],
];
for (const [name, build] of refusals) {
  const { r, w } = await actRig();
  const sentBefore = w.webContents.sent.length;
  const [ev, msg] = build(r, w);
  const ans = await r.ipcMain.invoke(CHANNELS.act, ev, msg);
  ok(ans === false && r.clicks.length === 0 && r.quits === 0, `refused: ${name}`);
  if (name === 'stale gen' || name === 'unknown id') {
    ok(w.webContents.sent.length > sentBefore + (name === 'stale gen' ? 1 : 0), `  …and the page is resent the current payload (repaint): ${name}`);
  }
}
{
  // main's OWN gen/id cross-check, proven with a gate that would accept anything
  for (const [name, mk] of [
    ['stale gen', (r) => { r.publish(); return { gen: 1, id: 'tray-open-memory' }; }],
    ['a gen the page was never sent', () => ({ gen: 2, id: 'tray-open-memory' })],
    ['an id not in the sent payload', () => ({ gen: 1, id: 'tray-row-7:open' })],
  ]) {
    const { r, w } = await actRig();
    const msg = mk(r);
    r.gate.act = (g, id) => { r.clicks.push(id); return true; };
    const ans = await r.ipcMain.invoke(CHANNELS.act, r.ev(w), msg);
    ok(ans === false && r.clicks.length === 0, `main refuses before the gate (lenient gate): ${name}`);
  }
}
{
  // waiting to paint counts as not shown
  const r = makeRig();
  r.publish();
  r.popover.show(r.trayBounds);
  const w = r.win();
  w.finishLoad();
  const ans = await r.ipcMain.invoke(CHANNELS.act, r.ev(w), { gen: 1, id: 'tray-open-memory' });
  ok(ans === false && r.clicks.length === 0, 'refused: while still waiting for the first paint');
}
{
  // the gate's own refusal (main's cross-check passes, the gate says no) → false + resend
  const { r, w } = await actRig();
  r.gate.act = () => false;
  const before = w.webContents.sent.length;
  ok(await r.ipcMain.invoke(CHANNELS.act, r.ev(w), { gen: 1, id: 'tray-open-memory' }) === false
    && w.webContents.sent.length === before + 1 && w.visible, 'a gate refusal answers false, resends, keeps it up');
  r.gate.act = () => { throw new Error('boom'); };
  ok(await r.ipcMain.invoke(CHANNELS.act, r.ev(w), { gen: 1, id: 'tray-open-memory' }) === false, 'a throwing gate answers false');
}
{
  // size/painted/dismiss from a wrong sender are ignored
  const { r, w } = await actRig();
  const bad = { sender: {}, senderFrame: w.webContents.mainFrame };
  const h = w.bounds.height;
  r.ipcMain.send(CHANNELS.size, bad, { height: 200 });
  r.ipcMain.send(CHANNELS.dismiss, bad, {});
  ok(w.bounds.height === h && w.visible, 'size and dismiss from another sender are ignored');
  r.ipcMain.send(CHANNELS.dismiss, r.ev(w), { now: true });
  ok(w.visible, 'a dismiss with keys is ignored');
  w.webContents.mainFrame.url = 'file:///C:/elsewhere/tray-popover.html';
  r.ipcMain.send(CHANNELS.dismiss, r.ev(w), {});
  ok(w.visible, 'a dismiss from another file is ignored');
}

// ── §9 the pure parsers and the URL check ───────────────────────────────────
console.log('\n§9 parsers and the page-URL check');
eq(parseAct({ gen: 3, id: 'a' }), { gen: 3, id: 'a' }, 'parseAct accepts the exact shape');
ok([null, {}, { gen: 0, id: 'a' }, { gen: 1.5, id: 'a' }, { gen: 2 ** 53, id: 'a' }, { gen: 1, id: '' }, { gen: 1, id: 5 },
  { gen: 1, id: 'a', [Symbol('s')]: 1 }].every((m) => parseAct(m) === null), 'parseAct refuses every other shape (incl. a symbol key)');
eq(parseSize({ height: 12 }), { height: 12 }, 'parseSize');
ok([{ height: 0 }, { height: -1 }, { height: Infinity }, { height: '9' }, { h: 9 }].every((m) => parseSize(m) === null), 'parseSize refuses junk');
eq(parsePainted({ gen: 1, rows: 0 }), { gen: 1, rows: 0 }, 'parsePainted');
ok([{ gen: 1, rows: -1 }, { gen: 0, rows: 1 }, { gen: 1, rows: 1.5 }, { gen: 1 }].every((m) => parsePainted(m) === null), 'parsePainted refuses junk');
ok(parseDismiss({}) !== null && parseDismiss(Object.create(null)) !== null && parseDismiss({ a: 1 }) === null && parseDismiss(null) === null, 'parseDismiss: only {}');
ok(isPageUrl(PAGE_URL, PAGE, 'win32'), 'the page URL is the page');
ok(isPageUrl(PAGE_URL.replace('file:///C:', 'file:///c:'), PAGE, 'win32'), 'win32: drive letter case does not matter');
ok(!isPageUrl(PAGE_URL.replace('/Ana/', '/Bob/'), PAGE, 'win32'), 'another profile is not the page');
{
  const spaced = 'C:\\Users\\Ana Lopez\\AppData\\Local\\Programs\\the-curator\\resources\\app\\src\\public\\next\\tray-popover.html';
  ok(isPageUrl('file:///C:/Users/Ana%20Lopez/AppData/Local/Programs/the-curator/resources/app/src/public/next/tray-popover.html', spaced, 'win32'),
    'a percent-encoded space in the profile path');
  const uni = 'C:\\Users\\Željko\\x\\tray-popover.html';
  ok(isPageUrl(pathToFileURL('/C:/Users/Željko/x/tray-popover.html').href.replace('file:///C:', 'file:///C:'), uni, 'win32'), 'a non-ASCII profile name (UTF-8 escapes)');
  ok(isPageUrl("file:///C:/Users/O'Brien/x/tray-popover.html", "C:\\Users\\O'Brien\\x\\tray-popover.html", 'win32'), 'an apostrophe in the profile name');
}
ok(!isPageUrl('file://host/C:/x/tray-popover.html', 'C:\\x\\tray-popover.html', 'win32'), 'a UNC host is never the page');
ok(fileUrlToPlatformPath('file:///C:/a%00b', 'win32') === null && fileUrlToPlatformPath('file:///C:/a%E0', 'win32') === null, 'NUL and bad escapes refused');
ok(isPageUrl('file:///Users/a/next/tray-popover.html', '/Users/a/next/tray-popover.html', 'darwin')
  && !isPageUrl('file:///users/a/next/tray-popover.html', '/Users/a/next/tray-popover.html', 'darwin'), 'posix: exact, case-sensitive');
ok(requestAllowed('file:///Users/a/next/x.css', '/Users/a/next', 'darwin') && !requestAllowed('file:///Users/a/other.css', '/Users/a/next', 'darwin'), 'requestAllowed on posix paths too');

// ── §11 the v4.1.0 audit's fixes ────────────────────────────────────────────
console.log('\n§11 audit fixes: consecutive failures, no lost click, log-off, preload, no stale flash');
{
  // Minor 1: only CONSECUTIVE failures switch it off.
  const r = makeRig();
  r.open(); r.clock.advance(1000);
  r.popover.hide();
  const w = r.win();
  w.webContents.emit('render-process-gone');                      // failure 1 (not during a click)
  ok(r.popover.stats().failures === 1 && r.popover.isEnabled(), 'one failure: still on');
  r.publish();
  r.popover.show(r.trayBounds);                        // reload, paint → a successful show
  w.finishLoad(); r.paint(w);
  ok(w.visible && r.popover.stats().failures === 0 && r.popover.stats().failuresTotal === 1,
    'a successful show resets the run (failures 0) but the session total stays 1');
  r.popover.hide('toggle');
  w.webContents.emit('render-process-gone');                      // failure 2, weeks later in effect
  ok(r.popover.isEnabled() && r.popover.stats().failuresTotal === 2,
    'two failures with a good show between them: the popover stays ON');
  r.publish(); r.popover.show(r.trayBounds); w.finishLoad();
  r.clock.advance(FIRST_PAINT_BACKSTOP_MS);            // no paint: a second CONSECUTIVE failure
  ok(!r.popover.isEnabled() && r.popover.stats().off, 'two consecutive failures: off for the session (CONTROL)');
}
{
  // Minor 5: a waiting show cancelled by anything but the person's own toggle/Esc, or the menu
  // itself, gives that click the native menu.
  const waiting = () => { const r = makeRig(); r.publish(); r.popover.show(r.trayBounds); r.win().finishLoad(); return r; };
  const a = waiting();
  a.clock.advance(MAIN_FOCUS_GRACE_MS + 1);
  a.popover.mainWindowFocused();
  eq(a.fallbacks, ['cancelled'], 'main-window focus cancelling a waiting show → that click gets the native menu');
  a.clock.advance(FIRST_PAINT_BACKSTOP_MS * 2);
  eq(a.fallbacks, ['cancelled'], '…once, and the cancelled backstop never fires a second one');
  const b = waiting();
  b.popover.hide();
  eq(b.fallbacks, ['cancelled'], 'a bare hide() of a waiting show falls back too');
  const c = waiting();
  ok(c.popover.toggle(c.trayBounds) === false, 'CONTROL — a second click while waiting closes it');
  eq(c.fallbacks, [], '…and the person\'s own toggle is NOT answered with a menu');
  const d = waiting();
  d.popover.hide('menu');
  eq(d.fallbacks, [], 'hide(\'menu\') (main pops the native menu itself) → no second menu');
  const e = waiting();
  const w = e.win();
  w.close();
  eq(e.fallbacks, ['cancelled'], 'a close while waiting → the native menu (never neither)');
  const f = makeRig(); f.open(); f.clock.advance(1000);
  f.popover.mainWindowFocused();
  eq(f.fallbacks, [], 'CONTROL — hiding a popover that is already SHOWN is no fallback');
}
{
  // Minor 6: the popover window hears the log-off itself.
  for (const ev of ['query-session-end', 'session-end']) {
    const r = makeRig();
    const w = r.open();
    ok(w.close().prevented, `CONTROL — before ${ev}, close only hides`);
    r.popover.show(r.trayBounds); r.paint(w);
    w.emit(ev, evt());
    const e = w.close();
    ok(!e.prevented && w.destroyed, `after the window's own ${ev}, close really closes (main's isQuitting still false)`);
  }
}
{
  // Minor 4: preload at tray start → the first click only paints and reveals.
  const r = makeRig();
  ok(r.popover.preload() === true, 'preload() answers true');
  const w = r.win();
  eq([w.loads, w.visible, r.fallbacks], [[PAGE], false, []], 'preload: the window is created and the page loaded, hidden, no fallback');
  w.finishLoad();
  r.publish();
  ok(r.popover.show(r.trayBounds) === true && !w.visible, 'the first click: waits only for the paint of its payload');
  r.paint(w);
  ok(w.visible, '…which reveals it');
  r.clock.advance(FIRST_PAINT_BACKSTOP_MS * 2);
  eq([r.fallbacks, w.loads.length, r.popover.stats().failuresTotal], [[], 1, 0], 'no fallback to the native menu, one load, no failure');
  const cold = makeRig();
  cold.publish(); cold.popover.show(cold.trayBounds); cold.clock.advance(FIRST_PAINT_BACKSTOP_MS);
  eq(cold.fallbacks, ['slow-load'], 'CONTROL — WITHOUT preload the cold first click falls back at the backstop');
  const broken = makeRig(); broken.loadReject = true;
  broken.popover.preload(); await flush();
  eq(broken.fallbacks, [], 'a preload whose load fails is no click\'s failure: no menu pops by itself');
}
{
  // Minor 2: the SAME payload object (the gate found nothing changed) is not re-sent.
  const r = makeRig();
  const w = r.open();
  const p = r.gate.current();
  const n = w.webContents.sent.length;
  r.popover.update(p);
  ok(w.webContents.sent.length === n, 'update() with the payload already sent: no send, no repaint');
  r.publish();
  ok(w.webContents.sent.length === n + 1, 'CONTROL — a new payload is sent');
}
{
  // Nit: a warm window never flashes the previous open's content.
  const r = makeRig();
  const w = r.open(); r.clock.advance(1000);
  r.popover.hide('toggle');
  r.popover.show(r.trayBounds);
  ok(w.visible, 'nothing new published: the warm window reveals at once');
  r.popover.hide('toggle');
  r.publish();                                         // gen 2 sent, page has painted gen 1
  r.popover.show(r.trayBounds);
  ok(!w.visible, 'a newer payload sent: it waits for that paint (no flash of the last one)');
  r.ipcMain.send(CHANNELS.painted, r.ev(w), { gen: 1, rows: 5 });
  ok(!w.visible, 'an older paint crossing it does not reveal it');
  r.paint(w);
  ok(w.visible, 'the newest paint does');
}
{
  // Nit: hardening is idempotent per session; refusals are counted where the newest controller reads.
  const ses = new Emitter();
  let filters = 0;
  ses.webRequest = { onBeforeRequest(fn) { filters += 1; ses.filter = fn; } };
  ses.setPermissionRequestHandler = () => {}; ses.setPermissionCheckHandler = () => {};
  ses.setDevicePermissionHandler = () => {}; ses.setDisplayMediaRequestHandler = () => {};
  let a = 0, b = 0;
  const dir = 'C:\\x\\src\\public\\next';
  ok(pop.hardenPopoverSession(ses, { pageDir: dir, platform: 'win32', onRefused: () => { a += 1; } }) === true, 'first hardening registers');
  ok(pop.hardenPopoverSession(ses, { pageDir: dir, platform: 'win32', onRefused: () => { b += 1; } }) === false, 'a second one does not');
  ok(filters === 1 && ses.count('will-download') === 1 && ses.count('select-usb-device') === 1, 'one filter, one listener of each kind (a tray toggled off and on stacks nothing)');
  let res; ses.filter({ url: 'file:///C:/x/package.json' }, (v) => { res = v; });
  ok(res.cancel === true && a === 0 && b === 1, 'a refused request is counted by the NEWEST controller');
  ses.filter({ url: 'file:///C:/x/src/public/next/views/a.css' }, (v) => { res = v; });
  ok(res.cancel === false && b === 1, 'an allowed one is not counted');
  const r = makeRig();
  r.open();
  let got; r.sessions[0].beforeRequest({ url: 'file:///C:/Windows/win.ini' }, (v) => { got = v; });
  ok(got.cancel === true && r.popover.stats().refusedRequests === 1, 'the controller\'s stats count the refusal (the CI self-test\'s negative probe)');
}

// ── §10 the preload in a vm ─────────────────────────────────────────────────
console.log('\n§10 the preload (vm, fake electron, fake navigator)');
const PRELOAD_SRC = fs.readFileSync(path.join(LIB, 'tray-popover-preload.js'), 'utf8');
function runPreload() {
  const exposed = {};
  const ipc = {
    listeners: {}, invokes: [], sends: [], answer: true, hold: null,
    on(ch, fn) { this.listeners[ch] = fn; },
    invoke(ch, msg) {
      this.invokes.push([ch, msg]);
      if (this.hold) return new Promise((res) => { (this.held ||= []).push(() => res(this.answer)); this.release = () => this.held.splice(0).forEach((f) => f()); });
      return Promise.resolve(this.answer);
    },
    send(ch, msg) { this.sends.push([ch, msg]); },
  };
  const nav = { userActivation: { isActive: true } };
  const ctx = {
    navigator: nav,
    require: (m) => {
      if (m !== 'electron') throw new Error('only electron');
      return { contextBridge: { exposeInMainWorld: (k, v) => { exposed[k] = v; } }, ipcRenderer: ipc };
    },
  };
  vm.runInNewContext(PRELOAD_SRC, ctx, { filename: 'tray-popover-preload.js' });
  return { api: exposed.curatorTray, exposed, ipc, nav };
}
{
  const { api, exposed, ipc, nav } = runPreload();
  eq(Object.keys(exposed), ['curatorTray'], 'exposes exactly window.curatorTray');
  eq(Object.keys(api).sort(), ['act', 'dismiss', 'onModel', 'painted', 'size'], 'exactly the contract\'s five calls');
  ok(Object.isFrozen(api), 'frozen');
  ok(await api.act(1, 'tray-open-memory') === true, 'act with activation answers main\'s true');
  eq(ipc.invokes, [['curator-tray:act', { gen: 1, id: 'tray-open-memory' }]], 'act sends exactly {gen, id} on curator-tray:act');
  nav.userActivation.isActive = false;
  ok(await api.act(1, 'tray-open-memory') === false && ipc.invokes.length === 1, 'no user activation: false, no IPC');
  nav.userActivation = undefined;
  ok(await api.act(1, 'tray-open-memory') === false && ipc.invokes.length === 1, 'no userActivation API: false, no IPC');
  nav.userActivation = { isActive: true };
  for (const [g, id] of [[0, 'a'], [1.5, 'a'], ['1', 'a'], [1, ''], [1, 'x'.repeat(201)], [1, { toString: () => 'a' }]]) {
    ok(await api.act(g, id) === false, `act refuses ${JSON.stringify([g, typeof id === 'object' ? 'object' : id.length > 20 ? id.length + ' chars' : id])} without IPC`);
  }
  ok(ipc.invokes.length === 1, 'none of those reached IPC');
  ipc.hold = true;
  const first = api.act(1, 'tray-quit');
  const second = await Promise.race([api.act(1, 'tray-open-memory'), flush().then(() => 'still pending')]);
  ok(second === false && ipc.invokes.length === 2, 'one call in flight: a second answers false without IPC', second);
  ipc.release();
  ok(await first === true, 'the first settles with main\'s answer');
  ipc.hold = null; ipc.answer = 'yes';
  ok(await api.act(1, 'tray-open-memory') === false, 'only a strict true from main is true');
  ipc.invoke = () => Promise.reject(new Error('gone'));
  ok(await api.act(1, 'tray-open-memory') === false, 'a rejected invoke answers false, never rejects');
  ipc.invoke = () => Promise.resolve(true);
  ok(await api.act(1, 'tray-open-memory') === true, 'and the busy flag was released after it');
  api.size(320); api.size(NaN); api.size(-1); api.size('9');
  api.painted(3, 7); api.painted(0, 7); api.painted(3, -1);
  nav.userActivation.isActive = false;
  api.dismiss();
  eq(ipc.sends, [['curator-tray:size', { height: 320 }], ['curator-tray:painted', { gen: 3, rows: 7 }], ['curator-tray:dismiss', {}]],
    'size/painted send only valid shapes; dismiss needs no activation (Esc grants none)');
}
{
  const { api, ipc } = runPreload();
  ipc.listeners['curator-tray:model']({}, { gen: 4 });
  ipc.listeners['curator-tray:model']({}, { gen: 5 });
  const got = [];
  api.onModel((p) => got.push(p.gen));
  eq(got, [5], 'a payload that came before onModel is delivered once (the latest) on registration');
  ipc.listeners['curator-tray:model']({}, { gen: 6 });
  const got2 = [];
  api.onModel((p) => got2.push(p.gen));
  ipc.listeners['curator-tray:model']({}, { gen: 7 });
  eq([got, got2], [[5, 6], [7]], 'a later onModel replaces the callback');
  api.onModel((p) => { throw new Error('page bug ' + p.gen); });
  let threw = false;
  try { ipc.listeners['curator-tray:model']({}, { gen: 8 }); } catch { threw = true; }
  ok(!threw, 'a throwing page callback never breaks the channel');
}

console.log('\n============================================================');
console.log(`Passed: ${passed}   Failed: ${failed}`);
console.log('============================================================');
process.exit(failed ? 1 : 0);
