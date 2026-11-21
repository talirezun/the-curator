/**
 * test-tray-popover-shell.js — OFFLINE guard for the Windows tray popover's WIRING (v4.1.0, P5):
 * desktop/lib/tray-popover-shell.js, the pieces main.js hands its clicks, its fallback, its log
 * and the CI self-test to, EXECUTED against the REAL controller (desktop/lib/tray-popover.js), the
 * REAL gate and payload (tray-popover-model.js over tray-model.js), and the REAL click handlers
 * (shell-platform.js trayClickHandlers). Electron is never loaded: the window, webContents,
 * session, screen and ipcMain are recording fakes, with a fake "page" that loads, paints what it
 * is sent, and answers Esc the way views/tray-popover-paint.js does (curatorTray.dismiss()).
 *
 * Proven: a left click on win32 PUBLISHES and THEN toggles; a right click pops the native menu; a
 * fallback (no paint by the backstop) pops the native menu, except during the self-test; Quit
 * reaches app.quit() and never app.exit(); the self-test's pass path and each of its failure
 * paths; it is honoured only with CURATOR_TEST_USER_DATA_DIR; the curator.log line.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(__dirname, '..', 'desktop', 'lib');
const imp = (f) => import(pathToFileURL(path.join(LIB, f)).href);
const shell = await imp('tray-popover-shell.js');
const ctl = await imp('tray-popover.js');
const popModel = await imp('tray-popover-model.js');
const trayModel = await imp('tray-model.js');
const sp = await imp('shell-platform.js');
const { CHANNELS } = await imp('tray-popover-ipc.js');

let passed = 0, failed = 0;
function ok(cond, label, extra) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''}`); }
}
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), label, { got: a, want: b });
const section = (t) => console.log(`\n${t}`);

const PAGE = 'C:\\Program Files\\x\\resources\\app\\src\\public\\next\\tray-popover.html';
const PAGE_URL = 'file:///C:/Program%20Files/x/resources/app/src/public/next/tray-popover.html';
const PRELOAD = 'C:\\Program Files\\x\\resources\\app\\lib\\tray-popover-preload.js';
const NOOPS = { onOpenScope() {}, onOpenMemory() {}, onOpenApp() {}, onOpenSettings() {}, onRowAction() {} };

class Emitter {
  constructor() { this.l = new Map(); }
  on(ev, fn) { if (!this.l.has(ev)) this.l.set(ev, []); this.l.get(ev).push(fn); return this; }
  once(ev, fn) { const w = (...a) => { this.off(ev, w); fn(...a); }; return this.on(ev, w); }
  off(ev, fn) { const a = this.l.get(ev) || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
  emit(ev, ...args) { for (const fn of [...(this.l.get(ev) || [])]) fn(...args); }
}

/**
 * The rig. `page` options: paints (true), rows (painted row count), escDismisses (true),
 * csp (console lines to emit on load), loads (true: a load finishes on the next tick).
 */
function makeRig(page = {}) {
  const P = { paints: true, rows: null, escDismisses: true, csp: [], loads: true, ...page };
  let t = 10_000;
  const timers = [];
  let seq = 0;
  const queue = [];
  const clock = {
    now: () => t,
    setTimer: (cb, ms) => { const id = ++seq; timers.push({ id, at: t + ms, cb }); return id; },
    clearTimer: (id) => { const i = timers.findIndex((x) => x.id === id); if (i >= 0) timers.splice(i, 1); },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at || a.id - b.id);
        const n = timers[0];
        if (!n || n.at > end) break;
        timers.shift(); t = n.at; n.cb();
      }
      t = end;
    },
  };
  const ipcMain = {
    handlers: new Map(), listeners: new Map(),
    handle(ch, fn) { this.handlers.set(ch, fn); },
    removeHandler(ch) { this.handlers.delete(ch); },
    on(ch, fn) { if (!this.listeners.has(ch)) this.listeners.set(ch, []); this.listeners.get(ch).push(fn); },
    removeListener(ch, fn) { const a = this.listeners.get(ch) || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
    invoke(ch, event, msg) { const h = this.handlers.get(ch); return h ? h(event, msg) : Promise.resolve('no-handler'); },
    send(ch, event, msg) { for (const fn of this.listeners.get(ch) || []) fn(event, msg); },
  };
  const windows = [];
  const ev = (w) => ({ sender: w.webContents, senderFrame: w.webContents.mainFrame });
  class WC extends Emitter {
    constructor(win) { super(); this.win = win; this.sent = []; this.mainFrame = { url: '', parent: null, processId: 3, routingId: 1 }; this.keys = []; }
    send(ch, p) {
      this.sent.push([ch, p]);
      // The page paints what it is sent — on the next tick, as a renderer would.
      if (ch === CHANNELS.model && P.paints) {
        const rows = P.rows === null ? Object.values(p.pages.root.rows).length : P.rows;
        queue.push(() => ipcMain.send(CHANNELS.painted, ev(this.win), { gen: p.gen, rows }));
      }
    }
    sendInputEvent(e) {
      this.keys.push(e);
      if (e.type === 'keyDown' && e.keyCode === 'Escape' && P.escDismisses) {
        queue.push(() => ipcMain.send(CHANNELS.dismiss, ev(this.win), {}));
      }
    }
    setWindowOpenHandler() {}
  }
  class Win extends Emitter {
    constructor(options) {
      super();
      this.options = options; this.webContents = new WC(this);
      this.visible = false; this.focused = false; this.destroyed = false;
      this.bounds = { x: 0, y: 0, width: options.width, height: options.height };
      windows.push(this);
    }
    show() { this.visible = true; this.focused = true; }
    hide() { this.visible = false; this.focused = false; }
    focus() { this.focused = true; }
    isFocused() { return this.focused; }
    isVisible() { return this.visible; }
    isDestroyed() { return this.destroyed; }
    destroy() { if (!this.destroyed) { this.destroyed = true; this.visible = false; this.emit('closed'); } }
    setBounds(b) { this.bounds = { ...b }; }
    getBounds() { return { ...this.bounds }; }
    setMenu() {}
    setBackgroundColor() {}
    loadFile() {
      if (P.loads) {
        queue.push(() => {
          this.webContents.mainFrame.url = PAGE_URL;
          for (const line of P.csp) this.webContents.emit('console-message', { message: line, level: 'error' });
          this.webContents.emit('did-finish-load');
        });
      }
      return Promise.resolve();
    }
  }
  const session = {
    fromPartition() {
      const s = new Emitter();
      s.webRequest = { onBeforeRequest() {} };
      s.setPermissionRequestHandler = () => {}; s.setPermissionCheckHandler = () => {};
      s.setDevicePermissionHandler = () => {}; s.setDisplayMediaRequestHandler = () => {};
      return s;
    },
  };
  const DISPLAY = { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1032 }, scaleFactor: 1 };
  const screen = {
    getDisplayMatching: () => DISPLAY, getDisplayNearestPoint: () => DISPLAY, getPrimaryDisplay: () => DISPLAY,
    getCursorScreenPoint: () => ({ x: 1810, y: 1050 }),
  };
  const app = { quits: 0, exits: 0, quit() { this.quits += 1; }, exit() { this.exits += 1; } };
  const gate = popModel.createPopoverActionGate();
  const effects = [];
  const r = {
    clock, windows, ipcMain, screen, DISPLAY, app, gate, effects, logs: [], fallbacks: [], selfTestRunning: false,
    trayBounds: { x: 1800, y: 1040, width: 24, height: 32 },
    win: () => windows[windows.length - 1],
    /** One tick: timers, then what the "page" queued. */
    async tick(ms = 50) {
      clock.advance(ms);
      while (queue.length) queue.shift()();
      await Promise.resolve();
    },
  };
  const popMenu = () => { effects.push('menu'); };
  r.popMenu = popMenu;
  r.popover = ctl.createTrayPopover({
    BrowserWindow: Win, screen, session, ipcMain, gate,
    pagePath: PAGE, preloadPath: PRELOAD, platform: 'win32', isPackaged: true,
    quit: () => app.quit(),
    isQuitting: () => false,
    onFallback: (reason) => { r.fallbacks.push(reason); shell.popoverFallbackHandler({ popMenu, selfTestRunning: () => r.selfTestRunning })(); },
    log: (l) => r.logs.push(l),
    getTrayBounds: () => r.trayBounds,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  r.publish = () => {
    effects.push('publish');
    const m = trayModel.buildTrayModel(null, { dark: false, platform: 'win32', imageScales: popModel.POPOVER_IMAGE_SCALES });
    r.popover.update(gate.publish(popModel.buildTrayPopover(m, { theme: 'light', appName: 'The Curator', ...NOOPS })));
  };
  // The REAL click handlers main.js registers, with main's effects.
  r.clicks = sp.trayClickHandlers('win32', {
    popMenu,
    refresh: () => effects.push('refresh'),
    checkRemote: (trig) => effects.push('remote:' + trig),
    showPopover: () => shell.popoverLeftClick({ popover: r.popover, publish: r.publish, popMenu, trayBounds: () => r.trayBounds }),
  });
  return r;
}

// ═══════════════════════════════════════════════════════════════════════════
section('§1 the left click publishes, THEN toggles; the right click pops the native menu');
{
  const r = makeRig();
  ok(r.windows.length === 0 && r.gate.gen === 0, 'CONTROL — nothing built before the first click (the window is created lazily)');
  r.clicks.click();
  eq(r.effects, ['publish', 'refresh', 'remote:click'], 'win32 left click: publish, then (the popover opens), re-read, ask — no native menu');
  const w = r.win();
  const firstModel = w && w.webContents.sent.find(([ch]) => ch === CHANNELS.model);
  ok(!!w && r.gate.gen === 1, 'the left click created the window and published generation 1 BEFORE the show');
  await r.tick(); await r.tick();
  ok(!!firstModel || w.webContents.sent.some(([ch]) => ch === CHANNELS.model), 'the page was sent the payload as soon as it loaded');
  ok(r.popover.isVisible(), 'after the page painted, the popover is on screen');
  r.effects.length = 0;
  r.clicks.click();
  ok(!r.popover.isVisible(), 'a second left click (pointer not in the toggle grace) closes it: toggle, not show');
  eq(r.effects, ['publish', 'refresh', 'remote:click'], '…and still publishes first, then re-reads and asks');
  r.effects.length = 0;
  r.clicks['right-click']();
  eq(r.effects, ['menu', 'refresh', 'remote:right-click'], 'win32 right click: the native menu, then re-read, ask — no popover publish');
}
{
  // ORDER, proved with a controller that records when it is called relative to publish.
  const calls = [];
  const fake = { isEnabled: () => true, toggle: (b) => calls.push(['toggle', b]) };
  const res = shell.popoverLeftClick({ popover: fake, publish: () => calls.push(['publish']), popMenu: () => calls.push(['menu']), trayBounds: () => ({ x: 1 }) });
  eq([res, calls], ['popover', [['publish'], ['toggle', { x: 1 }]]], 'popoverLeftClick: publish first, then toggle at the tray bounds');
  const off = []; const offCtl = { isEnabled: () => false, toggle: () => off.push('toggle') };
  shell.popoverLeftClick({ popover: offCtl, publish: () => off.push('publish'), popMenu: () => off.push('menu'), trayBounds: () => null });
  eq(off, ['toggle'], 'a controller OFF for the session gets no payload; its toggle() does the fallback itself');
  const none = [];
  eq(shell.popoverLeftClick({ popover: null, publish: () => none.push('publish'), popMenu: () => none.push('menu'), trayBounds: () => null }), 'menu',
    'no controller (it could not be created) → the native menu');
  eq(none, ['menu'], '…and nothing published');
  const thr = [];
  shell.popoverLeftClick({ popover: { isEnabled: () => true, toggle: (b) => thr.push(b === undefined ? 'undefined' : b) }, publish() {}, popMenu() {}, trayBounds: () => { throw new Error('gone'); } });
  eq(thr, ['undefined'], 'tray bounds that throw are handed over as unknown (the controller then uses the cursor)');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2 the fallback pops the native menu');
{
  const r = makeRig({ paints: false });
  r.clicks.click();
  await r.tick(); // loaded, never painted
  r.effects.length = 0;
  await r.tick(ctl.FIRST_PAINT_BACKSTOP_MS + 10);
  ok(!r.popover.isVisible(), 'a page that never paints is not shown');
  eq(r.effects, ['menu'], 'the backstop pops the native menu for that click');
  ok(r.fallbacks.length === 1 && r.logs.some((l) => /fallback to the native menu/.test(l)), `one fallback, one log line (${JSON.stringify(r.logs)})`);
}
{
  const r = makeRig({ paints: false });
  r.selfTestRunning = true;
  r.clicks.click(); await r.tick();
  r.effects.length = 0;
  await r.tick(ctl.FIRST_PAINT_BACKSTOP_MS + 10);
  eq([r.fallbacks.length, r.effects], [1, []], 'during the CI self-test the fallback is recorded but no native menu is popped (its modal loop would block the runner)');
}
{
  const r = makeRig({ paints: false });
  for (let i = 0; i < ctl.MAX_FAILURES; i++) { r.clicks.click(); await r.tick(); await r.tick(ctl.FIRST_PAINT_BACKSTOP_MS + 10); }
  ok(!r.popover.isEnabled(), `CONTROL — after ${ctl.MAX_FAILURES} failures the popover is off for the session`);
  r.effects.length = 0;
  const genBefore = r.gate.gen;
  r.clicks.click();
  eq([r.effects, r.gate.gen], [['menu', 'refresh', 'remote:click'], genBefore], 'then every left click is the native menu at once, and nothing is published');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3 Quit goes through app.quit(), never app.exit()');
{
  const r = makeRig();
  r.clicks.click(); await r.tick(); await r.tick();
  ok(r.popover.isVisible(), 'CONTROL — the popover is open');
  const w = r.win();
  const gen = r.gate.gen;
  const event = { sender: w.webContents, senderFrame: w.webContents.mainFrame };
  const answer = await r.ipcMain.invoke(CHANNELS.act, event, { gen, id: 'tray-quit' });
  eq([answer, r.app.quits, r.app.exits], [true, 1, 0], 'pressing "Quit The Curator" calls app.quit() once (before-quit and its write guard run) and app.exit() never');
  const stale = await r.ipcMain.invoke(CHANNELS.act, event, { gen: gen - 1 || 999, id: 'tray-quit' });
  eq([stale, r.app.quits], [false, 1], 'a stale generation is refused: no second quit');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4 popoverWantsRepaint: a render repaints only a popover on screen or about to be');
{
  eq(shell.popoverWantsRepaint(null), false, 'no controller → no');
  eq(shell.popoverWantsRepaint({ isVisible: () => false, stats: () => ({ waiting: false }) }), false, 'hidden → no (the next left click publishes)');
  eq(shell.popoverWantsRepaint({ isVisible: () => true, stats: () => ({}) }), true, 'visible → yes');
  eq(shell.popoverWantsRepaint({ isVisible: () => false, stats: () => ({ waiting: true }) }), true, 'waiting for its first paint → yes');
  eq(shell.popoverWantsRepaint({ isVisible: () => { throw new Error('x'); } }), false, 'a throwing controller → no, never a throw');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5 the CI self-test');
{
  const env = { CURATOR_TEST_TRAY_POPOVER_SELFTEST: '1', CURATOR_TEST_USER_DATA_DIR: 'C:\\t\\ud' };
  eq(shell.popoverSelfTestRequested(env, 'win32'), true, 'asked for, with an isolated user-data folder, on win32 → runs');
  eq(shell.popoverSelfTestRequested({ CURATOR_TEST_TRAY_POPOVER_SELFTEST: '1' }, 'win32'), false, 'WITHOUT CURATOR_TEST_USER_DATA_DIR → never (a person\'s app cannot run it)');
  eq(shell.popoverSelfTestRequested({ ...env, CURATOR_TEST_USER_DATA_DIR: '  ' }, 'win32'), false, 'a blank user-data folder → never');
  eq(shell.popoverSelfTestRequested(env, 'darwin'), false, 'on a Mac → never');
  eq(shell.popoverSelfTestRequested({ ...env, CURATOR_TEST_TRAY_POPOVER_SELFTEST: 'true' }, 'win32'), false, 'only exactly "1"');
  eq(shell.popoverSelfTestRequested(null, 'win32'), false, 'no env → never');
  ok(/^CURATOR_TEST_/.test(shell.SELFTEST_ENV), 'its variable starts with CURATOR_TEST_, so ci-win-app.mjs personEnv() strips it from every person-like launch');
}
const selfTest = (r, extra = {}) => shell.runTrayPopoverSelfTest({
  popover: r.popover,
  publish: r.publish,
  getTrayBounds: () => r.trayBounds,
  workAreaFor: () => r.DISPLAY.workArea,
  sleep: (ms) => r.tick(ms),
  now: r.clock.now,
  ...extra,
});
{
  const r = makeRig();
  r.selfTestRunning = true;
  const res = await selfTest(r);
  eq([res.pass, res.line], [true, shell.SELFTEST_PASS_LINE], `the REAL controller passes: shown, painted, inside the work area, no CSP refusal, Esc hides it (${JSON.stringify(res.facts)})`);
  ok(res.facts.rows > 0 && res.facts.cspViolations === 0 && res.facts.dismissals === 1, 'its facts: rows painted, 0 CSP violations, one dismissal');
  ok(r.win().webContents.keys.some((k) => k.type === 'keyDown' && k.keyCode === 'Escape'), 'Esc arrived as a real key event (sendInputEvent), not a direct hide');
}
{
  const r = makeRig({ csp: ["Refused to load the image 'https://x/y.png' because it violates the following Content Security Policy directive: \"img-src data:\"."] });
  r.selfTestRunning = true;
  const res = await selfTest(r);
  ok(!res.pass && /Content Security Policy/.test(res.line) && res.facts.cspViolations === 1, `a CSP refusal on the console fails it (${res.line.slice(0, 90)})`);
}
{
  const r = makeRig({ csp: ['an ordinary console line'] });
  r.selfTestRunning = true;
  eq((await selfTest(r)).pass, true, 'CONTROL — an ordinary console line is not counted');
}
{
  const r = makeRig({ rows: 0 });
  r.selfTestRunning = true;
  const res = await selfTest(r);
  ok(!res.pass && /painted no rows/.test(res.line), `a page that painted 0 rows fails it (${res.line.slice(0, 60)})`);
}
{
  const r = makeRig({ escDismisses: false });
  r.selfTestRunning = true;
  const res = await selfTest(r, { hideTimeoutMs: 400 });
  ok(!res.pass && /Esc did not hide/.test(res.line), `Esc that does not dismiss fails it (${res.line.slice(0, 60)})`);
}
{
  const r = makeRig();
  r.selfTestRunning = true;
  const res = await selfTest(r, { workAreaFor: () => ({ x: 0, y: 0, width: 800, height: 600 }) });
  ok(!res.pass && /not inside the work area/.test(res.line), `bounds outside the work area fail it (${res.line.slice(0, 70)})`);
}
{
  const r = makeRig({ paints: false });
  r.selfTestRunning = true;
  const res = await selfTest(r, { showTimeoutMs: 5000 });
  ok(!res.pass && /never became visible/.test(res.line), `a popover that never shows fails it, without hanging (${res.line.slice(0, 60)})`);
  eq(r.effects.filter((e) => e === 'menu'), [], '…and no native menu was popped during it');
}
{
  const res = await shell.runTrayPopoverSelfTest({ popover: null, publish() {}, getTrayBounds() {}, workAreaFor() {} });
  ok(!res.pass && res.line.startsWith(shell.SELFTEST_FAIL_PREFIX), 'no controller → a fail line, never a throw');
}
{
  eq(shell.boundsInside({ x: 10, y: 10, width: 10, height: 10 }, { x: 0, y: 0, width: 100, height: 100 }), true, 'boundsInside: inside');
  eq(shell.boundsInside({ x: 95, y: 10, width: 10, height: 10 }, { x: 0, y: 0, width: 100, height: 100 }), false, 'boundsInside: over the right edge');
  eq(shell.boundsInside({ x: -1, y: 10, width: 10, height: 10 }, { x: 0, y: 0, width: 100, height: 100 }), false, 'boundsInside: over the left edge');
  eq(shell.boundsInside({ x: 0, y: 0, width: 0, height: 10 }, { x: 0, y: 0, width: 100, height: 100 }), false, 'boundsInside: zero size');
  eq(shell.boundsInside({ x: NaN, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: 100, height: 100 }), false, 'boundsInside: NaN');
  eq(shell.boundsInside(null, { x: 0, y: 0, width: 1, height: 1 }), false, 'boundsInside: nothing');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§6 the curator.log line');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curator-popover-log-'));
  const logs = path.join(dir, 'logs');
  const okWrite = shell.appendDesktopLogLine({ logsDir: logs, line: 'tray-popover-selftest: pass', fs, now: () => new Date('2026-11-21T10:00:00Z') });
  shell.appendDesktopLogLine({ logsDir: logs, line: 'two\nlines', fs, now: () => new Date('2026-11-21T10:00:01Z') });
  const text = fs.readFileSync(path.join(logs, 'curator.log'), 'utf8');
  eq([okWrite, text], [true, '2026-11-21T10:00:00.000Z [info] [desktop] tray-popover-selftest: pass\n2026-11-21T10:00:01.000Z [info] [desktop] two lines\n'],
    'one line each, in curator.log, newlines folded so one event is one line');
  if (process.platform !== 'win32') eq(fs.statSync(path.join(logs, 'curator.log')).mode & 0o777, 0o600, 'the log file is 0600');
  eq(shell.appendDesktopLogLine({ logsDir: null, line: 'x', fs }), false, 'no log folder → false, never a throw');
  eq(shell.appendDesktopLogLine({ logsDir: logs, line: 'x', fs: { mkdirSync() { throw new Error('EACCES'); } } }), false, 'a failing disk → false, never a throw');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
section('§7 the CI runner (scripts/ci-win-app.mjs popover-selftest) reads the app\'s own line');
{
  const ci = await import(pathToFileURL(path.join(__dirname, 'ci-win-app.mjs')).href);
  eq(ci.POPOVER_SELFTEST_ENV, shell.SELFTEST_ENV, 'the runner sets exactly the variable the app reads');
  const pass = `2026-11-21T10:00:00.000Z [info] [desktop] ${shell.SELFTEST_PASS_LINE}`;
  const fail = `2026-11-21T10:00:00.000Z [info] [desktop] ${shell.SELFTEST_FAIL_PREFIX}the page painted no rows {"rows":0}`;
  eq(ci.popoverSelfTestLine(`a\r\n${pass}\r\nb`), pass, 'the pass line is found (CRLF log)');
  ok(/tray-popover-selftest: pass$/.test(ci.popoverSelfTestLine(pass)), '…and the runner\'s pass test accepts it');
  eq(ci.popoverSelfTestLine(fail), fail, 'a fail line is found too (so the runner stops waiting and prints it)');
  ok(!/pass$/.test(ci.popoverSelfTestLine(fail)), '…and it is not a pass');
  eq(ci.popoverSelfTestLine('tray-popover: no-paint (fallback to the native menu)'), null, 'an ordinary popover log line is not the self-test');
  eq(ci.popoverSelfTestLine(`${pass} extra`), null, 'a pass line with anything after it is not a pass');
  eq(ci.parseArgs(['popover-selftest', '--setup', 's.exe', '--version', '4.1.0']), { cmd: 'popover-selftest', setup: 's.exe', version: '4.1.0' }, 'the subcommand parses');
  ok(!!ci.parseArgs(['popover-selftest', '--setup', 's.exe']).error, '…and needs --version');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
