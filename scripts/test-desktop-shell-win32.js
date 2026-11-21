#!/usr/bin/env node
/**
 * test-desktop-shell-win32.js — OFFLINE suite for the Windows desktop shell
 * and its tray widget (Windows app v1, package G, 2026-11-20).
 *
 * Nobody on this project can run Windows, and Electron is not an offline
 * dependency, so every Windows decision the shell makes lives in a pure module
 * and is EXECUTED here with an injected platform:
 *
 *   §1  the AppUserModelID equals electron-builder.yml's appId
 *   §2  the single-instance words: darwin byte-identical, win32 "this PC"
 *   §3  close → hide to tray only on win32 AND only while a tray is live
 *   §4  dialog parenting: darwin unchanged, win32 only while on screen
 *   §5  how the tray is driven: darwin unchanged, win32 left=window right=menu
 *   §6  the Windows tooltip clamp (127 units)
 *   §7  the About dialog carries the About panel's facts
 *   §8  the updater gate: no darwin engine on a PC until F's adapter exists
 *   §9  background mode: `tray-only` hedged on Windows, darwin text unchanged
 *   §10 the coloured Windows tray icon, decoded with an INDEPENDENT decoder
 *   §11 the tray menu on Windows: every Mac-only field moved, no fact lost
 *   §12 the tray model's words: "this PC" on win32, darwin byte-identical
 *   §13 main.js source scan — WEAK, labelled so
 *
 * ── NOT ENFORCED — stated rather than implied away ────────────────────────
 *  - No tray icon, window, menu or dialog is created on any Windows machine.
 *    Whether `right-click` fires with no context menu set, whether
 *    `popUpContextMenu` blocks, how Windows draws `&&`, the dark/light of a
 *    Windows tray menu, and whether the icon reads on a real taskbar are on
 *    the human check list in the package report.
 *  - §13 proves lines were WRITTEN, never that they run.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DESKTOP = path.join(ROOT, 'desktop');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(actual, expected, label) {
  const good = JSON.stringify(actual) === JSON.stringify(expected);
  if (good) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`); }
}
function section(t) { console.log(`\n${t}`); }
function read(p) { return readFileSync(p, 'utf8'); }
/** Line comments first (a `//` naming a glob contains `/*`). */
function stripJsComments(src) {
  return src.replace(/^[ \t]*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

let sp, mode, winIcon, menu, trayMenu, trayModel, appVersion, png, contrast;
try {
  sp = await import(pathToFileURL(path.join(DESKTOP, 'lib', 'shell-platform.js')).href);
  mode = await import(pathToFileURL(path.join(DESKTOP, 'lib', 'background-mode.js')).href);
  winIcon = await import(pathToFileURL(path.join(DESKTOP, 'lib', 'tray-icon-win.js')).href);
  menu = await import(pathToFileURL(path.join(DESKTOP, 'lib', 'menu.js')).href);
  trayMenu = await import(pathToFileURL(path.join(DESKTOP, 'lib', 'tray-menu.js')).href);
  trayModel = await import(pathToFileURL(path.join(DESKTOP, 'lib', 'tray-model.js')).href);
  appVersion = await import(pathToFileURL(path.join(DESKTOP, 'lib', 'app-version.js')).href);
  png = await import(pathToFileURL(path.join(ROOT, 'scripts', 'visual', 'png.js')).href);
  contrast = await import(pathToFileURL(path.join(ROOT, 'scripts', 'visual', 'contrast.js')).href);
} catch (err) {
  console.log(`\n  ✗ FATAL — could not import the shell modules: ${err.message}`);
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§1 the AppUserModelID is the appId NSIS stamps on the shortcut');
{
  const yml = read(path.join(DESKTOP, 'electron-builder.yml'));
  const m = yml.match(/^appId:\s*(\S+)\s*$/m);
  ok(!!m, 'CONTROL — electron-builder.yml declares an appId');
  eq(sp.APP_USER_MODEL_ID, m && m[1],
    'the AUMID equals the appId — Windows matches a process\'s AUMID against the shortcut\'s to show its notifications');
  eq(sp.APP_USER_MODEL_ID, 'com.talirezun.the-curator', 'and it is the value agreed with the build package');
  eq(sp.appUserModelIdFor('win32'), sp.APP_USER_MODEL_ID, 'win32 declares it');
  eq(sp.appUserModelIdFor('darwin'), null, 'darwin declares nothing — the Mac path makes no new call');
  eq(sp.appUserModelIdFor('linux'), null, 'linux declares nothing');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2 the "already running" box: darwin byte-identical, win32 says PC');
{
  // The literal main.js carried before Windows, copied here by hand so the
  // module is compared against the OLD text and not against itself.
  const OLD_BODY =
    'Another copy of The Curator is already open on this Mac.\n\n' +
    'Only one copy may run at a time — two copies would write into the same ' +
    'knowledge folder at once.\n\n' +
    'Switch to the window that is already open.';
  const mac = sp.singleInstanceMessage('darwin');
  eq(mac.title, 'The Curator is already running', 'darwin title unchanged');
  eq(mac.body, OLD_BODY, 'darwin body is BYTE-IDENTICAL to the pre-Windows literal');
  const win = sp.singleInstanceMessage('win32');
  ok(win.body.includes('already open on this PC.') && !win.body.includes('Mac'),
    'win32 says "this PC" and never "Mac"');
  eq(win.body.replace('this PC', 'this Mac'), OLD_BODY, 'and differs from the Mac text in that one noun only');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3 closing the window: hide to the tray ONLY on win32 with a live tray');
{
  const c = (o) => sp.closeHidesToTray(o);
  eq(c({ platform: 'win32', trayActive: true }), true, 'win32 + tray on → the X hides the window to the tray');
  eq(c({ platform: 'win32', trayActive: false }), false,
    'win32 + NO tray → the close goes through, so window-all-closed quits through the before-quit write guard');
  eq(c({ platform: 'win32', trayActive: true, quitAuthorised: true }), false,
    'win32 during an authorised quit → allowed, or Quit could never close the window');
  eq(c({ platform: 'win32', trayActive: true, sessionEnding: true }), false,
    'win32 while Windows logs off or shuts down → allowed, a hide would hold the session open');
  for (const p of ['darwin', 'linux']) {
    for (const trayActive of [true, false]) {
      eq(c({ platform: p, trayActive }), false,
        `${p}, tray ${trayActive ? 'on' : 'off'} → never (the Mac keeps its own pre-existing handler)`);
    }
  }
  eq(c({ platform: 'win32', trayActive: 'yes' }), false, 'a truthy non-boolean is not a live tray');
  eq(c(), false, 'no argument → never hides');

  // audit minor 5: win32 with NO tray asks the quit question while the window is still there.
  const q = (o) => sp.closeAsksQuitFirst(o);
  eq(q({ platform: 'win32', trayActive: false }), true,
    'win32 + NO tray → the X is turned into app.quit(), so "Quit now?" is asked BEFORE the window goes ("Keep working" keeps it)');
  eq(q({ platform: 'win32', trayActive: true }), false, 'win32 + tray → no (the tray hide applies instead)');
  eq(q({ platform: 'win32', quitAuthorised: true }), false, 'win32 during an authorised quit → the close goes through (no loop)');
  eq(q({ platform: 'win32', sessionEnding: true }), false, 'win32 while Windows logs off → the close goes through');
  for (const p of ['darwin', 'linux']) for (const trayActive of [true, false]) {
    eq(q({ platform: p, trayActive }), false, `${p}, tray ${trayActive ? 'on' : 'off'} → never (macOS keeps its own handler)`);
  }
  eq(q(), false, 'no argument → never');
  // Exactly one of the two Windows close listeners acts on any close that is not a quit/log-off.
  for (const trayActive of [true, false]) {
    const o = { platform: 'win32', trayActive };
    eq([c(o), q(o)].filter(Boolean).length, 1, `win32, tray ${trayActive ? 'on' : 'off'}: exactly one close listener acts`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3b refusing to start on incomplete Windows program files (audit M1)');
// ═══════════════════════════════════════════════════════════════════════════
{
  const paths = await import(pathToFileURL(path.join(ROOT, 'src', 'brain', 'paths.js')).href);
  const INST = 'C:\\Users\\Ana\\AppData\\Local\\Programs\\The Curator';
  const ROOTW = INST + '\\resources\\app';
  const MARK = ROOTW + '\\.curator-bundle';
  const host = (o) => paths.__setHostForTest({ platform: 'win32', appRoot: ROOTW, env: { LOCALAPPDATA: 'C:\\Users\\Ana\\AppData\\Local' },
    homedir: 'C:\\Users\\Ana', exists: (p) => !!o.marker && p === MARK, electron: o.electron, ...(o.appRoot ? { appRoot: o.appRoot } : {}) });
  const box = () => sp.appFilesIncompleteBox(paths);
  try {
    host({ electron: true, marker: false });
    const b = box();
    ok(!!b && b.title === 'The Curator could not start' && b.body === paths.WIN32_APP_FILES_INCOMPLETE_MESSAGE,
      'the packaged app (Electron) in …\\resources\\app WITHOUT the marker → the refusal box, in paths.js\'s own words');
    ok(/your notes and settings are safe/.test(b ? b.body : '') && /run its installer/.test(b ? b.body : '') && !/\bstack\b|Error:/.test(b ? b.body : ''),
      '…which says the notes are safe and what to do, in plain words');
    let thrown = null;
    try { paths.isBundleInstall(); } catch (e) { thrown = e; }
    eq(thrown && thrown.code, 'app-files-incomplete', 'paths.js itself THROWS in that shape (covers the MCP bridge: the exe run as Node)');
    let thrownUD = null;
    try { paths.getUserDataDir(); } catch (e) { thrownUD = e; }
    ok(!!thrownUD, '…so no user-data path is ever resolved (the program folder is never chosen)');
    host({ electron: true, marker: true });
    eq(box(), null, 'the marker present → start normally');
    eq(paths.isBundleInstall(), true, '…as a bundle');
    host({ electron: false, marker: false });
    eq(box(), null, 'plain Node (the browser install, a checkout) in the same path → never refused');
    eq(paths.isBundleInstall(), false, '…and still repo mode, exactly as before');
    host({ electron: true, marker: false, appRoot: 'C:\\Users\\Ana\\the-curator' });
    eq(box(), null, 'Electron from a checkout (dev run) → not the program-folder shape, never refused');
    host({ electron: true, marker: false, appRoot: INST.toUpperCase() + '\\RESOURCES\\APP\\' });
    ok(box() !== null, 'the shape is matched in any case and with a trailing separator');
    host({ electron: true, marker: false, appRoot: 'C:/x/resources/app' });
    ok(box() !== null, '…and with forward slashes');
  } finally { paths.__setHostForTest(null); }
  eq(box(), null, `this host (${process.platform}): never refused`);
  eq(sp.appFilesIncompleteBox(null), null, 'no module → null (start; never invent a refusal)');
  eq(sp.appFilesIncompleteBox({ win32AppFilesIncomplete: () => { throw new Error('x'); } }), null, 'a module that throws → null');
  eq(sp.appFilesIncompleteBox({ win32AppFilesIncomplete: () => 'yes' }), null, 'only a literal true refuses');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4 which window a dialog attaches to');
{
  const a = (o) => sp.attachDialogToWindow(o);
  // darwin: the pre-existing rule was `mainWindow ? attach : app-modal`.
  for (const visible of [true, false]) {
    for (const minimized of [true, false]) {
      eq(a({ platform: 'darwin', hasWindow: true, visible, minimized }), true,
        `darwin with a window (visible ${visible}, minimised ${minimized}) attaches — unchanged`);
    }
  }
  eq(a({ platform: 'darwin', hasWindow: false }), false, 'darwin with no window is app-modal — unchanged');
  eq(a({ platform: 'win32', hasWindow: true, visible: true, minimized: false }), true, 'win32, window on screen → attached');
  eq(a({ platform: 'win32', hasWindow: true, visible: false, minimized: false }), false,
    'win32, window HIDDEN to the tray → app-modal, or the quit question could never be seen');
  eq(a({ platform: 'win32', hasWindow: true, visible: true, minimized: true }), false, 'win32, minimised → app-modal');
  eq(a({ platform: 'win32', hasWindow: false, visible: true }), false, 'win32 with no window → app-modal');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5 how the tray is driven');
{
  const mac = sp.trayInteraction('darwin');
  eq({ ...mac }, {
    templateImage: true, setContextMenu: true, popUpOnRightClick: false,
    leftClick: 'menu', remoteCheckOnLeftClick: true, menuTheme: 'apple-interface-style',
  }, 'darwin is exactly the pre-existing behaviour: template glyph, menu SET on the tray, either click opens it');
  const win = sp.trayInteraction('win32');
  eq(win.templateImage, false, 'win32: NOT a template image — Windows does not tint; the ink is chosen from the taskbar theme');
  eq(win.iconTheme, 'system-integrated-ui', 'win32: the icon ink follows the SYSTEM (taskbar) theme, not the app theme boot() pins dark');
  eq(win.setContextMenu, false, 'win32: the menu is never SET on the tray…');
  eq([win.popUpOnLeftClick, win.popUpOnRightClick], [false, true], '…it is POPPED on a RIGHT click only, rebuilt immediately before it is shown (v4.1.0, owner D1)');
  eq(win.leftClick, 'popover', 'win32: a LEFT click opens the tray POPOVER (v4.1.0, owner D1; v4.0.1 popped the menu on both clicks)');
  eq(win.remoteCheckOnLeftClick, true, 'win32: a left-click IS a widget open, so it may ask GitHub, as on the Mac');

  // EXECUTED: the very handlers main.js registers, driven with recording effects.
  const drive = (platform) => {
    const log = [];
    const h = sp.trayClickHandlers(platform, {
      popMenu: () => log.push('pop'), refresh: () => log.push('refresh'), checkRemote: (t) => log.push('remote:' + t),
      showPopover: () => log.push('popover'),
    });
    const out = {};
    for (const ev of Object.keys(h)) { log.length = 0; h[ev](); out[ev] = log.slice(); }
    return out;
  };
  eq(drive('darwin'), { click: ['refresh', 'remote:click'], 'right-click': ['refresh', 'remote:right-click'] },
    'darwin: exactly the v3.x handlers — re-read, then the remote check; nothing popped (the menu is SET on the tray)');
  eq(drive('win32'), { click: ['popover', 'refresh', 'remote:click'], 'right-click': ['pop', 'refresh', 'remote:right-click'] },
    'win32: a LEFT click opens the popover FIRST, a RIGHT click pops the native menu FIRST (fresh from memory); each then re-reads and asks — no window reveal');
  ok(!Object.keys(sp.trayClickHandlers('win32', { popMenu() {}, refresh() {}, checkRemote() {}, showPopover() {} })).includes('double-click'),
    'win32: no double-click handler — the first click has already opened the popover, which takes the second');
  let threw = false;
  try { sp.trayClickHandlers('win32', { popMenu() {}, refresh() {} }); } catch { threw = true; }
  ok(threw, 'a missing effect is refused when the handlers are BUILT, not when a click lands');
  let threwPop = null;
  try { sp.trayClickHandlers('win32', { popMenu() {}, refresh() {}, checkRemote() {} }); } catch (e) { threwPop = e.message; }
  ok(threwPop && /showPopover/.test(threwPop), 'win32: building the clicks WITHOUT showPopover is refused (the left click could open nothing)');
  {
    const log = [];
    const h = sp.trayClickHandlers('darwin', { popMenu: () => log.push('pop'), refresh: () => log.push('refresh'), checkRemote: () => log.push('remote'), showPopover: () => log.push('popover') });
    h.click(); h['right-click']();
    eq(log, ['refresh', 'remote', 'refresh', 'remote'], 'darwin: a showPopover handed over anyway is NEVER called (the Mac click path is v4.0.1\'s)');
  }
  ok(Object.isFrozen(mac) && Object.isFrozen(win), 'both plans are frozen');
  // The remote-check allow-list must contain both triggers the Windows clicks
  // pass — or the Windows menu would never ask about other machines.
  const remote = await import(pathToFileURL(path.join(DESKTOP, 'lib', 'tray-remote.js')).href);
  ok(remote.REMOTE_CHECK_TRIGGERS.includes('click') && remote.REMOTE_CHECK_TRIGGERS.includes('right-click'),
    'both triggers Windows passes are in tray-remote.js\'s allow-list');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§6 the Windows tray tooltip is clamped to 127 units');
{
  eq(sp.WIN_TOOLTIP_MAX, 127, 'the limit is NOTIFYICONDATA szTip (128 with the terminator)');
  const long = 'The Curator — Last save: alpha · harness-one · 8 min ago · ' + 'a long brief sentence that keeps going '.repeat(5);
  ok(long.length > 127, 'CONTROL — the fixture really is over the limit');
  eq(sp.clampTrayToolTip(long, 'darwin'), long, 'darwin: untouched');
  const w = sp.clampTrayToolTip(long, 'win32');
  ok(w.length <= 127, `win32: within the limit (${w.length})`);
  ok(w.endsWith('…'), 'win32: says it was shortened');
  ok(long.startsWith(w.slice(0, -1)), 'win32: a prefix of the real text, nothing invented');
  ok(!/\s…$/.test(w), 'win32: no dangling space before the ellipsis');
  eq(sp.clampTrayToolTip('The Curator', 'win32'), 'The Curator', 'win32: a short tooltip is untouched');
  eq(sp.clampTrayToolTip(undefined, 'win32'), '', 'win32: garbage becomes empty, never a throw');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§7 Help › About on Windows carries the About panel\'s facts');
{
  const stubApp = { setAboutPanelOptions() {}, getVersion: () => '9.9.9' };
  const panel = appVersion.applyAboutPanel(stubApp, ROOT, {
    platform: 'win32', versions: { electron: '43.5.0', chrome: '140.0', node: '22.0.0', v8: '14.0' },
    osRelease: '10.0.22631', arch: 'x64',
  });
  const rootVersion = JSON.parse(read(path.join(ROOT, 'package.json'))).version;
  const d = sp.aboutDialogOptions({ appName: 'The Curator', panel });
  eq(d.title, 'About The Curator', 'titled like the menu item');
  eq(d.message, 'The Curator ' + rootVersion, 'the version is the panel\'s, read from package.json — one source');
  ok(d.detail.includes('Electron 43.5.0') && d.detail.includes('win32 10.0.22631 (x64)'),
    'the runtime and OS lines are the panel\'s own — and the OS is NOT labelled macOS on a PC');
  ok(!/macOS/.test(d.detail), 'nothing says macOS');
  eq(d.buttons, ['OK'], 'one button');
  eq(sp.aboutDialogOptions({}).message, 'The Curator unknown', 'no panel → "unknown", never a blank');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§8 the in-app updater is never the darwin engine on a PC');
{
  eq(sp.updaterSupported('darwin', {}), true, 'darwin: built, as before');
  eq(sp.updaterSupported('linux', {}), true, 'linux: as before (the shell built it unconditionally)');
  eq(sp.updaterSupported('win32', { createUpdateEngine() {} }), false,
    'win32 WITHOUT the platform adapter → not built; the update route refuses with its own named reason');
  eq(sp.updaterSupported('win32', null), false, 'win32 with nothing → not built');
  eq(sp.updaterSupported('win32', { createUpdateInstaller() {} }), true,
    'win32 once the update-engine package exports createUpdateInstaller → built');
  const engine = await import(pathToFileURL(path.join(DESKTOP, 'lib', 'update-engine.js')).href);
  console.log(`    (today update-engine.js ${typeof engine.createUpdateInstaller === 'function' ? 'DOES' : 'does NOT yet'} export createUpdateInstaller)`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§9 background mode on Windows');
{
  const macOnly = mode.resolveTrayPlan('tray-only');
  eq(macOnly.reason, 'Hiding the Dock icon is not implemented yet — the menu bar icon is on, and the Dock icon stays.',
    'no platform (every pre-Windows caller): the Mac reason, byte-identical');
  eq(mode.resolveTrayPlan('tray-only', { platform: 'darwin' }), macOnly, 'darwin: identical to the no-platform call');
  const w = mode.resolveTrayPlan('tray-only', { platform: 'win32' });
  eq([w.mode, w.tray, w.hideDock, w.hedged], ['tray-only', true, false, true],
    'win32 tray-only: RECOGNISED, tray on, taskbar button kept, and hedged');
  ok(/taskbar/.test(w.reason) && !/Dock|menu bar/.test(w.reason), 'with the reason in Windows words');
  for (const m of ['window', 'tray']) {
    eq(mode.resolveTrayPlan(m, { platform: 'win32' }), mode.resolveTrayPlan(m), `win32 ${m}: identical to the Mac plan`);
  }
  // Every live transition is the same nine cases on Windows: only the words differ.
  for (const a of mode.BACKGROUND_MODES) {
    for (const b of mode.BACKGROUND_MODES) {
      eq(mode.planModeTransition(a, b, { platform: 'win32' }), mode.planModeTransition(a, b),
        `transition ${a} → ${b} is the same on Windows`);
    }
  }
  eq(mode.planModeTransition('tray', 'window', { platform: 'win32' }).revealWindow, true,
    'turning the tray off on Windows reveals the window — a window hidden to the tray is never stranded');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§10 the Windows tray icon: the Mac glyph, its one bit, in the taskbar\'s ink');
{
  const macIcon = await import(pathToFileURL(path.join(DESKTOP, 'lib', 'tray-icon.js')).href);
  const pix = (img, x, y) => {
    const p = (y * img.width + x) * img.channels;
    return [img.data[p], img.data[p + 1], img.data[p + 2], img.data[p + 3]];
  };
  const INK = { dark: [0xFF, 0xFF, 0xFF], light: [0x1F, 0x1F, 0x1F] };
  const TONES = [['dark', true], ['light', false]];
  for (const [tone, darkTaskbar] of TONES) {
    for (const state of ['idle', 'live']) {
      const r = winIcon.winTrayIconPngs(state, { darkTaskbar });
      eq([r.template, r.tone], [false, tone], `${state}/${tone}: never a template, tone ${tone}`);
      eq(r.reps.map((x) => [x.scale, x.size]), [[1, 16], [1.5, 24], [2, 32]], `${state}/${tone}: 16, 24 and 32 px for 100/150/200 %`);
      for (const rep of r.reps) {
        const img = png.decodePng(rep.buffer);
        const n = rep.size;
        eq([img.width, img.height, img.channels], [n, n, 4], `${state}/${tone} ${n}px decodes (independent decoder) as RGBA ${n}×${n}`);
        eq(pix(img, 0, 0)[3], 0, `${state}/${tone} ${n}px: the corner is transparent — no disc, no tile`);
        // Every drawn pixel is the taskbar's ink: a monochrome glyph, like the Mac's.
        let off = 0, drawn = 0;
        for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
          const q = pix(img, x, y);
          if (q[3] === 0) continue;
          drawn++;
          if (q[0] !== INK[tone][0] || q[1] !== INK[tone][1] || q[2] !== INK[tone][2]) off++;
        }
        ok(drawn > 0 && off === 0, `${state}/${tone} ${n}px: all ${drawn} drawn pixels are the ${tone}-taskbar ink`);
        // THE SAME DRAWING AS THE MAC: alpha equals glyphMatrix at this size, pixel for pixel.
        const mac = macIcon.glyphMatrix(n, state);
        let mism = 0;
        for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (pix(img, x, y)[3] !== Math.round(mac[y][x])) mism++;
        eq(mism, 0, `${state}/${tone} ${n}px: the alpha IS the Mac glyph's (lib/tray-icon.js glyphMatrix), pixel for pixel`);
      }
    }
  }
  // THE OWNER'S REPORT (2026-11-21): "always a circle with a filled dot". The
  // idle centre must be EMPTY — measured as alpha, and by a dumb count over the
  // whole central area the live dot occupies.
  const centreArea = (state, size, darkTaskbar) => {
    const rep = winIcon.winTrayIconPngs(state, { darkTaskbar }).reps.find((x) => x.size === size);
    const img = png.decodePng(rep.buffer);
    const c = size / 2, r = size * 0.19;
    let opaque = 0, total = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if ((x + 0.5 - c) ** 2 + (y + 0.5 - c) ** 2 > r * r) continue;
      total++;
      if (pix(img, x, y)[3] > 0) opaque++;
    }
    return { opaque, total, centre: pix(img, Math.floor(c), Math.floor(c)) };
  };
  for (const size of [16, 24, 32]) for (const [tone, d] of TONES) {
    const idle = centreArea('idle', size, d), live = centreArea('live', size, d);
    eq(idle.opaque, 0, `${size}px ${tone}: IDLE draws nothing in the centre (${idle.total} px checked) — an empty ring, as on the Mac`);
    ok(live.centre[3] === 255 && live.opaque >= live.total * 0.9, `${size}px ${tone}: LIVE fills the centre (${live.opaque}/${live.total} px) — the Mac's dot`);
  }
  // The one bit is the ONLY difference: outside the centre, both states agree.
  for (const [tone, d] of TONES) {
    const a = png.decodePng(winIcon.winTrayIconPngs('idle', { darkTaskbar: d }).reps[2].buffer);
    const b = png.decodePng(winIcon.winTrayIconPngs('live', { darkTaskbar: d }).reps[2].buffer);
    let diffOutside = 0, diffInside = 0;
    const c = 16, rDot = 32 * 0.19 + 1;
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
      const p = (y * 32 + x) * 4;
      const same = a.data.subarray(p, p + 4).equals(b.data.subarray(p, p + 4));
      const inDot = (x + 0.5 - c) ** 2 + (y + 0.5 - c) ** 2 <= rDot * rDot;
      if (!same) { if (inDot) diffInside++; else diffOutside++; }
    }
    ok(diffInside > 10 && diffOutside === 0, `${tone}: live and idle differ in the centre (${diffInside} px) and NOWHERE else — exactly the Mac glyph's one bit`);
  }
  // Contrast, computed from the decoded pixels, and the reason the tone exists.
  {
    const ring = (d) => {
      const img = png.decodePng(winIcon.winTrayIconPngs('idle', { darkTaskbar: d }).reps[2].buffer);
      for (let x = 0; x < 32; x++) { const q = pix(img, x, 16); if (q[3] === 255) return q; }
      return null;
    };
    const white = ring(true), black = ring(false);
    ok(!!white && !!black, 'CONTROL — a fully opaque ring pixel was found on both tones');
    const onDark = contrast.contrastRatio(white, [0x20, 0x20, 0x20]);
    const onLight = contrast.contrastRatio(black, [0xF3, 0xF3, 0xF3]);
    ok(onDark >= 3, `the dark-taskbar ink on #202020: ${contrast.round2(onDark)}:1 (non-text floor 3:1)`);
    ok(onLight >= 3, `the light-taskbar ink on #F3F3F3: ${contrast.round2(onLight)}:1`);
    ok(contrast.contrastRatio(white, [0xF3, 0xF3, 0xF3]) < 3,
      'CONTROL — the dark-taskbar ink on a LIGHT taskbar fails the floor, which is why the tone is read rather than fixed');
  }
  // Unknown taskbar → dark (the Windows default), never a throw.
  eq(winIcon.winTrayIconPngs('idle').tone, 'dark', 'no taskbar reading → the dark-taskbar ink (the Windows 10/11 default)');
  eq(winIcon.winTrayIconPngs('idle', { darkTaskbar: null }).tone, 'dark', 'a null reading → dark');
  eq(winIcon.winTrayIconPngs('weird').state, 'idle', 'an unknown state draws idle (never a false "live")');
  // The image key main.js compares before re-setting the icon.
  eq(['idle', 'live'].map((g) => winIcon.trayIconKey('darwin', g, null)), ['idle', 'live'],
    'darwin: the key IS the glyph state, exactly the v3.x comparison');
  eq(winIcon.trayIconKey('darwin', 'live', false), 'live', 'darwin ignores any taskbar reading');
  eq([winIcon.trayIconKey('win32', 'idle', true), winIcon.trayIconKey('win32', 'live', false), winIcon.trayIconKey('win32', 'idle')],
    ['idle:dark', 'live:light', 'idle:dark'], 'win32: the state AND the taskbar tone, so either change redraws the icon');
  // Wiring the state through on win32 — the trayImage → winTrayIconPngs call
  // and the key — can only be source-scanned (main.js does not run here).
  const src = stripJsComments(read(path.join(DESKTOP, 'main.js')));
  ok(/const iconKey = trayIconKey\(process\.platform, model\.glyph, darkTaskbar\);\s*if \(iconKey !== trayGlyph\) \{\s*trayGlyph = iconKey;\s*tray\.setImage\(trayImage\(model\.glyph, darkTaskbar\)\);/.test(src),
    'WEAK (source scan): every render re-keys on the model\'s glyph and the taskbar tone, and re-sets the image when either changes');
  ok(/winTrayIconPngs\(state, \{ darkTaskbar \}\)/.test(src), 'WEAK (source scan): win32 draws the requested STATE with the taskbar tone');
  ok(/shouldUseDarkColorsForSystemIntegratedUI !== false/.test(src), 'WEAK (source scan): the tone is the SYSTEM theme, not shouldUseDarkColors (pinned dark by boot())');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§11 the tray menu on Windows: every Mac-only field is moved, none lost');
const NOOPS = { onOpenScope() {}, onOpenMemory() {}, onOpenApp() {}, onOpenSettings() {}, onRowAction() {} };
const NOW = new Date('2026-08-31T14:32:00');
const at = (sec) => new Date(NOW.getTime() - sec * 1000).toISOString();
function fixture() {
  // Every name INVENTED (public repo). Two machines, so the newer-elsewhere
  // notice and machine tooltips exist; an `&` in a project name for the
  // mnemonic case; an idle project for the Idle fold.
  return {
    ok: true, total: 4,
    lastSave: { project: 'r&d', scope: 'main', writtenAt: at(60), ageSource: 'agent', harness: 'harness-one', model: 'demo-4-6' },
    scopes: [
      { project: 'r&d', scope: 'main', machine: 'laptop-a1b2c3', harness: 'harness-one', model: 'demo-4-6',
        writtenAt: at(600), ageSource: 'agent', headline: 'wired the tray', isThisMachine: true, isThisHost: true },
      { project: 'r&d', scope: 'other', machine: 'studio-9f8e7d', harness: 'harness-two', model: 'demo-4-6',
        writtenAt: at(60), ageSource: 'agent', headline: 'second stream', isThisMachine: false, isThisHost: false },
      { project: 'beta', scope: 'main', machine: 'laptop-a1b2c3', harness: 'harness-one', model: 'demo-4-6',
        writtenAt: at(3 * 86400), ageSource: 'agent', headline: 'old work', isThisMachine: true, isThisHost: true },
    ],
    brief: null, remote: null, warnings: [],
    // The widget's pictures: the save pulse (a top-level leaf with a legend
    // tooltip) and the Knowledge submenu (leaves with tooltips inside a submenu).
    domains: [
      { domain: 'posts', index: 0, slot: 5, displayName: 'posts', pageCount: 687 },
      { domain: 'work', index: 1, slot: 2, displayName: 'work', pageCount: 30 },
    ],
    pulse: {
      windowSeconds: 604800, bucketSeconds: 21600, buckets: new Array(28).fill(0).map((_, i) => (i > 20 ? 1 : 0)),
      events: 7, eventsOutsideWindow: 0, pairsCounted: 2, pairsTruncated: 0, clock: 'agent',
      oldestEventAt: null, coversWholeWindow: true, firstKnownBucket: 0,
    },
  };
}
function walk(t, f, trail = []) {
  for (const i of t || []) { if (!i || typeof i !== 'object') continue; f(i, trail); if (Array.isArray(i.submenu)) walk(i.submenu, f, [...trail, i]); }
}
{
  const macModel = trayModel.buildTrayModel(fixture(), { now: NOW });
  const mac = trayMenu.buildTrayMenuTemplate(macModel, NOOPS);
  const macExplicit = trayMenu.buildTrayMenuTemplate(trayModel.buildTrayModel(fixture(), { now: NOW, platform: 'darwin' }), { ...NOOPS, platform: 'darwin' });
  const ser = (t) => JSON.stringify(t, (k, v) => (typeof v === 'function' ? 'fn' : v));
  eq(ser(macExplicit), ser(mac), 'darwin passed explicitly builds a menu identical to the pre-Windows call');

  let subs = 0, tips = 0, headers = 0;
  walk(mac, (i) => { if (i.sublabel) subs++; if (i.toolTip) tips++; if (i.type === trayMenu.MENU_HEADER_TYPE) headers++; });
  ok(subs > 0 && tips > 0 && headers > 0, `CONTROL — the Mac menu really uses all three Mac-only fields (${subs} sublabels, ${tips} tooltips, ${headers} headers)`);

  const winModel = trayModel.buildTrayModel(fixture(), { now: NOW, platform: 'win32' });
  const win = trayMenu.buildTrayMenuTemplate(winModel, { ...NOOPS, platform: 'win32' });
  let wSubs = 0, wTips = 0, wHeaders = 0;
  const winLabels = [];
  walk(win, (i) => {
    if ('sublabel' in i) wSubs++; if ('toolTip' in i) wTips++; if (i.type === 'header') wHeaders++;
    if (typeof i.label === 'string') winLabels.push(i.label);
  });
  eq([wSubs, wTips, wHeaders], [0, 0, 0], 'win32: no sublabel, no item tooltip, no header type survives — Windows draws none of them');

  // NO FACT LOST. Every sublabel the Mac-shaped template carries is inside
  // some Windows label, and every tooltip line is a Windows item, both after
  // mnemonic escaping. Compared against the template built from the SAME
  // (Windows-worded) model before the adaptation pass, so the "this PC" noun
  // is not mistaken for a lost fact.
  const esc = (s) => s.replace(/&/g, '&&');
  const pre = trayMenu.buildTrayMenuTemplate(winModel, NOOPS);
  const macSubs = [], macTipLines = [];
  walk(pre, (i) => {
    if (i.sublabel) macSubs.push(i.sublabel.trim());
    if (i.toolTip && i.toolTip.trim() !== (i.label || '').trim()) macTipLines.push(...i.toolTip.split('\n').map((l) => l.trim()).filter(Boolean));
  });
  ok(macSubs.every((s) => winLabels.some((l) => l.includes(esc(s)))),
    `every Mac sublabel (${macSubs.length}) is on a Windows label`);
  // Every Mac tooltip FACT is on the Windows menu: as an item of its own, inside
  // a label (a row's second line), or — when a leaf restates its own label
  // first — the rest of the line, shown once for the whole submenu.
  const tipFacts = [];
  walk(pre, (i) => {
    if (!i.toolTip || i.toolTip.trim() === (i.label || '').trim()) return;
    for (const l of i.toolTip.split('\n').map((x) => x.trim()).filter(Boolean)) tipFacts.push({ l, label: (i.label || '').trim() });
  });
  // A long line is wrapped (v4.0.2) into consecutive rows: joined with one space they read as the line.
  const winText = winLabels.join(' ');
  const missing = tipFacts.filter(({ l, label }) => !winLabels.includes(esc(l))
    && !winLabels.some((w) => w.includes(esc(l)))
    && !winText.includes(esc(l).replace(/\s+/g, ' '))
    && !(label && l.startsWith(label + ' · ') && winLabels.includes(esc(l.slice(label.length + 3)))));
  ok(tipFacts.length > 10, `CONTROL — the Mac menu carries real tooltip facts (${tipFacts.length} lines)`);
  eq(missing.length, 0, `every Mac tooltip fact (${tipFacts.length}) is visible on the Windows menu${missing.length ? ' — missing: ' + missing.slice(0, 3).map((m) => m.l).join(' | ') : ''}`);

  // THE MAC'S SHAPE (owner 2026-11-21: "a different design"): a leaf INSIDE a
  // submenu stays a leaf on Windows — no extra arrow, no generic first item —
  // with its own click and its own picture, exactly as on the Mac.
  const byId = (t) => { const m = new Map(); walk(t, (i, trail) => { if (i.id) m.set(i.id, { i, depth: trail.length }); }); return m; };
  const macIds = byId(mac), winIds = byId(win);
  let innerLeaves = 0;
  for (const [id, { i, depth }] of macIds) {
    if (depth < 1 || Array.isArray(i.submenu) || i.type === trayMenu.MENU_HEADER_TYPE) continue;
    innerLeaves++;
    const w = winIds.get(id);
    ok(!!w && !Array.isArray(w.i.submenu) && (typeof w.i.click === 'function') === (typeof i.click === 'function'),
      `inner leaf ${id}: still a leaf on Windows, with ${typeof i.click === 'function' ? 'its own click' : 'no click'}`);
  }
  ok(innerLeaves >= 2, `CONTROL — inner leaves with tooltips were really compared (${innerLeaves})`);
  const domainRows = [...winIds.values()].filter(({ i }) => /^tray-domain-/.test(i.id));
  ok(domainRows.length === 2 && domainRows.every(({ i }) => !i.submenu && typeof i.click === 'function'),
    'each domain row is a clickable leaf, as on the Mac (v4.0.0 made it a parent whose "Open in The Curator" opened Settings)');
  const know = trayMenu.flattenTrayMenu(win).find((i) => i.id === trayMenu.ID_KNOWLEDGE);
  const legend = know.submenu.filter((i) => typeof i.label === 'string' && i.label.startsWith('Bar: against the largest domain'));
  eq(legend.length, 1, 'the bars\' shared sentence ("Bar: against the largest domain, …") is said ONCE, at the end of the Knowledge submenu');
  // THE PICTURES: every image the Mac menu draws (pulse strip, freshness
  // dots, domain bars) is on the same item on Windows, and none is a template
  // image (Windows does not tint; a template would be drawn black).
  {
    const pics = (platform) => {
      const m = trayModel.buildTrayModel(fixture(), { now: NOW, platform, dark: true });
      const t = trayMenu.buildTrayMenuTemplate(m, { ...NOOPS, platform, makeIcon: (spec) => spec });
      const out = new Map();
      walk(t, (i) => { if (i.icon) out.set(i.id, i.icon); });
      return out;
    };
    const macPics = pics('darwin'), winPics = pics('win32');
    const kinds = new Set([...winPics.values()].map((sp2) => (sp2.kind === 'dot' ? 'dot' : 'frac' in sp2 ? 'bar' : 'strip')));
    ok(macPics.size >= 5 && kinds.has('dot') && kinds.has('bar') && kinds.has('strip'),
      `CONTROL — the fixture's Mac menu draws dots, bars and the pulse strip (${macPics.size} pictures)`);
    eq([...winPics.keys()].sort(), [...macPics.keys()].sort(), 'win32: every picture sits on the same item as on the Mac, and no other');
    ok([...winPics.values()].every((sp2) => sp2.template === false && Buffer.isBuffer(sp2.buffer) && Buffer.isBuffer(sp2.buffer2x)),
      'win32: every picture is a colour image with a 1x and a 2x representation, never a template');
  }
  // The pulse, a TOP-LEVEL leaf with a legend, becomes a parent whose first
  // item is its own action, worded for what it does.
  const pulse = win.find((i) => i.id === trayMenu.ID_PULSE);
  ok(!!pulse && Array.isArray(pulse.submenu), 'CONTROL — the fixture draws the save pulse, and on Windows its legend is a submenu');
  eq(pulse.submenu[0].label, 'Open Project Context…', 'the pulse\'s first item says what its click does (it opens Project Context, not "Open in The Curator")');

  // The mnemonic.
  ok(winLabels.some((l) => l.includes('r&&d')), 'an "&" in a project name is escaped to "&&", so Windows draws "r&d" and not "rd"');
  ok(!winLabels.some((l) => /(^|[^&])&([^&]|$)/.test(l)), 'and no label carries a bare "&" that Windows would eat as a mnemonic');

  // Nothing clickable stopped being clickable, and nothing gained a second action.
  const clicks = (t) => { let n = 0; walk(t, (i) => { if (typeof i.click === 'function') n++; }); return n; };
  eq(clicks(win), clicks(mac), `the same number of actions on both (${clicks(mac)})`);
  // Same ids for every item that had one.
  const ids = (t) => { const s = []; walk(t, (i) => { if (i.id) s.push(i.id); }); return s.sort(); };
  eq(ids(win), ids(mac), 'every id the Mac menu carries is on the Windows menu, and no new ones');
  // Quit stays a role with no handler (the path that fires before-quit).
  const quit = trayMenu.flattenTrayMenu(win).find((i) => i.id === trayMenu.ID_QUIT);
  ok(quit && quit.role === 'quit' && typeof quit.click !== 'function', 'Quit is still role:quit with no handler on Windows');
  // Reveal is worded for Windows.
  const reveal = trayMenu.flattenTrayMenu(win).find((i) => typeof i.id === 'string' && i.id.endsWith(':' + trayMenu.ID_ROW_REVEAL));
  eq(reveal && reveal.label, 'Show current.md in File Explorer', 'the reveal action names File Explorer');
  eq(trayMenu.rowActionsFor('darwin'), trayMenu.ROW_ACTIONS, 'darwin keeps ROW_ACTIONS itself');
  eq(trayMenu.rowActionsFor('win32').map(([id]) => id), trayMenu.ROW_ACTIONS.map(([id]) => id), 'win32 changes words only, never ids or order');
  // The input is not mutated.
  const before = ser(mac);
  (await import(pathToFileURL(path.join(DESKTOP, 'lib', 'tray-menu-win.js')).href)).adaptTrayMenuForWindows(mac);
  eq(ser(mac), before, 'adaptTrayMenuForWindows does not mutate the Mac template');
  // A disabled statement with a tooltip opens a submenu of facts, and stays a statement.
  const tw = await import(pathToFileURL(path.join(DESKTOP, 'lib', 'tray-menu-win.js')).href);
  const [stmt] = tw.adaptTrayMenuForWindows([{ label: 'short', enabled: false, toolTip: 'the whole sentence\nsecond fact' }]);
  ok(stmt.enabled === true && stmt.submenu.length === 2 && stmt.submenu.every((x) => x.enabled === false),
    'a clipped statement becomes a parent whose submenu holds only its disabled detail lines');
  let hit = 0;
  const [act] = tw.adaptTrayMenuForWindows([{ label: 'collision', click: () => { hit++; }, toolTip: 'full text' }]);
  eq(act.submenu[0].label, tw.WIN_OPEN_LABEL, 'an action with a tooltip keeps its action as the first submenu item');
  act.submenu[0].click();
  eq(hit, 1, 'and that item runs the original handler');
  ok(typeof act.click !== 'function', 'the parent itself carries no handler (Windows opens the submenu)');
  // A leaf inside a submenu stays a leaf; its lines join the end of that submenu,
  // without repeating anything the submenu already shows.
  let leafHit = 0;
  const [parent] = tw.adaptTrayMenuForWindows([{ label: 'P', submenu: [
    { label: 'Head', enabled: false },
    { id: 'a', label: 'alpha · 3', click: () => { leafHit++; }, toolTip: 'alpha · 3 · same legend' },
    { id: 'b', label: 'beta · 9', click: () => {}, toolTip: 'beta · 9 · same legend' },
    { id: 'c', label: 'gamma', click: () => {}, toolTip: 'Head' },
  ] }]);
  const la = parent.submenu.find((i) => i.id === 'a');
  ok(la && !la.submenu && typeof la.click === 'function', 'a leaf with a tooltip inside a submenu stays a clickable leaf');
  la.click();
  eq(leafHit, 1, '…running its own handler');
  eq(parent.submenu.map((i) => i.type === 'separator' ? '—' : i.label), ['Head', 'alpha · 3', 'beta · 9', 'gamma', '—', 'same legend'],
    'the leaves\' shared sentence once, under a separator; a line the submenu already shows ("Head") not repeated');
  const [mixed] = tw.adaptTrayMenuForWindows([{ label: 'P', submenu: [
    { label: 'x', click() {}, toolTip: 'x · one fact' }, { label: 'y', click() {}, toolTip: 'y · another fact' },
  ] }]);
  eq(mixed.submenu.slice(3).map((i) => i.label), ['x · one fact', 'y · another fact'],
    'different sentences keep their leaf\'s name, so no fact loses what it is about');
  const [pl] = tw.adaptTrayMenuForWindows([{ id: 'p1', label: 'pulse', click() {}, toolTip: 'legend' }], { actionLabels: { p1: 'Open Project Context…' } });
  eq(pl.submenu[0].label, 'Open Project Context…', 'a top-level leaf\'s action takes the words it is given by id');
  const [plain] = tw.adaptTrayMenuForWindows([{ label: 'same', toolTip: 'same' }]);
  ok(!plain.submenu, 'a tooltip that only repeats the label adds nothing');
  const many = tw.adaptTrayMenuForWindows([{ label: 'x', enabled: false, toolTip: Array.from({ length: 40 }, (_, k) => 'line ' + k).join('\n') }])[0];
  eq(many.submenu.length, tw.WIN_DETAIL_LINES_MAX, 'a pathological tooltip is capped');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§12 the tray model\'s words');
{
  const mac = trayModel.buildTrayModel(fixture(), { now: NOW });
  const win = trayModel.buildTrayModel(fixture(), { now: NOW, platform: 'win32' });
  const macNotice = mac.notices.find((n) => n.kind === 'newer-elsewhere');
  const winNotice = win.notices.find((n) => n.kind === 'newer-elsewhere');
  ok(!!macNotice && /saved after this Mac$/.test(macNotice.text), `CONTROL — the Mac notice: "${macNotice && macNotice.text}"`);
  ok(!!winNotice && /saved after this PC$/.test(winNotice.text), `win32: "${winNotice && winNotice.text}"`);
  eq(trayModel.staleDocsFull('p', 0, 2), 'p: 2 could not be checked from this Mac (its source was not reachable, e.g. a GitHub document with no read token)',
    'staleDocsFull with no host: the Mac text, byte-identical');
  ok(/from this PC/.test(trayModel.staleDocsFull('p', 0, 2, 'this PC')), 'and with the PC noun on Windows');
  const strip = (m) => JSON.stringify(m, (k, v) => (typeof v === 'function' ? 'fn' : v));
  ok(!strip(win).includes('this Mac'), 'the whole Windows model never says "this Mac"');
  eq(strip(trayModel.buildTrayModel(fixture(), { now: NOW, platform: 'darwin' })), strip(mac), 'darwin passed explicitly = the pre-Windows model');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§13 main.js source scan — WEAK BY CONSTRUCTION, and labelled as such');
{
  const raw = read(path.join(DESKTOP, 'main.js'));
  const src = stripJsComments(raw);
  ok(src.length > raw.length * 0.15 && src.includes('createWindow'), 'CONTROL — comment stripping left real code');
  const iAumid = src.indexOf('app.setAppUserModelId(');
  const iLock = src.indexOf('app.requestSingleInstanceLock()');
  ok(iAumid > 0 && iLock > 0 && iAumid < iLock, 'the AUMID is declared at top level, before the single-instance lock and before ready');
  ok(/appUserModelIdFor\(process\.platform\)/.test(src), '…from the module the suite executes, never a second literal');
  ok(/if \(quitAuthorised \|\| process\.platform !== 'darwin'\) return;/.test(src),
    'the Mac close handler is still the pre-existing line, character for character');
  ok(/closeHidesToTray\(\{[\s\S]{0,200}trayActive: !!\(tray && !tray\.isDestroyed\(\)\)/.test(src),
    'the Windows close listener asks closeHidesToTray with a LIVE tray, not the setting');
  ok(/mainWindow\.on\('session-end'/.test(src), 'a Windows log-off lets every later close through');
  ok(/if \(TRAY_UI\.setContextMenu\) tray\.setContextMenu\(menu\);\s*else trayMenu = menu;/.test(src),
    'the menu is SET on the Mac tray and KEPT for popping on Windows');
  ok(/tray\.popUpContextMenu\(trayMenu\)/.test(src), 'Windows pops the kept menu');
  ok(/function popTrayMenu\(\)[\s\S]{0,120}renderTrayFromSnapshot\(\)/.test(src),
    'and rebuilds it from the in-memory snapshot (no I/O) immediately before popping');
  ok(/const clicks = trayClickHandlers\(process\.platform, \{\s*popMenu: popTrayMenu,\s*refresh: \(\) => \{ refreshTraySummary\(\); \},\s*checkRemote: \(trigger\) => \{ maybeCheckRemote\(trigger\); \},\s*\.\.\.\(TRAY_UI\.leftClick === 'popover' \? \{ showPopover: showTrayPopover \} : \{\}\),\s*\}\);\s*for \(const \[event, handler\] of Object\.entries\(clicks\)\) tray\.on\(event, handler\);/.test(src),
    'the tray\'s clicks are EXACTLY the handlers §5 executes (trayClickHandlers), wired to popTrayMenu / refreshTraySummary / maybeCheckRemote, and showTrayPopover only where the plan says popover');
  ok(/function showTrayPopover\(\)[\s\S]{0,200}popoverLeftClick\(\{\s*popover: trayPopover,\s*publish: publishPopover,\s*popMenu: popTrayMenu,/.test(src),
    'the left click is lib/tray-popover-shell.js popoverLeftClick (executed by test-tray-popover-shell.js): publish, then toggle; no controller → the native menu');
  ok(/quit: \(\) => app\.quit\(\),/.test(src) && !/app\.exit\(/.test(src.slice(src.indexOf('createTrayPopover({'), src.indexOf('createTrayPopover({') + 2500)),
    'the popover\'s Quit is app.quit() (before-quit runs the write-status guard), never app.exit()');
  ok(/onFallback: popoverFallbackHandler\(\{ popMenu: popTrayMenu,/.test(src), 'the popover\'s fallback pops the native menu (popoverFallbackHandler)');
  ok(/mainWindow\.on\('focus', \(\) => \{ if \(trayPopover\) trayPopover\.mainWindowFocused\(\); \}\);/.test(src), 'the main window\'s focus hides the popover (mainWindowFocused)');
  ok(/function stopTray\(\) \{[\s\S]{0,80}destroyTrayPopover\(\);/.test(src) && /if \(quitAuthorised\) \{ destroyTrayPopover\(\); return; \}/.test(src),
    'the popover is destroyed in stopTray() and on the authorised quit');
  ok(/dark = nativeTheme\.shouldUseDarkColorsForSystemIntegratedUI === true/.test(src) && /imageScales: POPOVER_IMAGE_SCALES/.test(src) && /theme: dark \? 'dark' : 'light'/.test(src),
    'the popover\'s payload follows the SYSTEM mode (D3), with the popover\'s picture scales');
  ok(/Menu\.buildFromTemplate\(buildTrayMenuTemplate\(model, \{\s*\.\.\.trayMenuHandlers\(\),/.test(src) && /buildTrayPopover\(model, \{[\s\S]{0,120}\.\.\.trayMenuHandlers\(\),/.test(src),
    'the native menu and the popover get the SAME five handlers (trayMenuHandlers)');
  ok(!/tray\.on\('(click|right-click|double-click)'/.test(src), 'and no click handler is registered beside them (no window reveal on a click)');
  ok(/platform: process\.platform,\s*\}\)\);/.test(src) && /identityHex,\s*platform: process\.platform/.test(src),
    'the platform is handed to the tray model and the tray menu');
  ok(/updaterSupported\(process\.platform, updateEngineModule\)/.test(src), 'the updater is gated on the platform adapter');
  ok(/onShowAbout:/.test(src) && /aboutDialogOptions\(/.test(src), 'Help › About is wired to the module-built dialog');
  ok(/getUserDefault\('AppleInterfaceStyle', 'string'\) === 'Dark'/.test(src),
    'the Mac menu theme still reads AppleInterfaceStyle');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§14 wave-2 wiring: the updater, the folder dialog, runCommand, afterStart (EXECUTED where it can be)');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { spawn } = await import('node:child_process');
  const rc = await import(pathToFileURL(path.join(DESKTOP, 'lib', 'run-command.js')).href);
  const engine = await import(pathToFileURL(path.join(DESKTOP, 'lib', 'update-engine.js')).href);

  // runCommand, through a RECORDING spawn: the options it hands Node.
  const calls = [];
  const fakeSpawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return spawn(process.execPath, ['-e', 'process.stdout.write("hi")'], opts); };
  const r1 = await rc.runCommandWith(fakeSpawn, '/usr/bin/plutil', ['-x'], {});
  eq(calls[0].opts, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    'runCommand spawns with the Mac stdio it always had, plus windowsHide (no flashing PowerShell console; ignored off Windows)');
  eq([r1.status, r1.stdout, r1.stderr], [0, 'hi', ''], '…and collects output and status as before');
  const capped = await rc.runCommandWith(spawn, process.execPath, ['-e', 'process.stdout.write("x".repeat(200000))'], { maxOutput: 1000 });
  ok(capped.status === 0 && capped.stdout.length >= 1000 && capped.stdout.length < 200000, `the output cap still applies (${capped.stdout.length} chars kept)`);
  const thrown = await rc.runCommandWith(() => { throw new Error('EINVAL'); }, 'x', [], {});
  eq([thrown.status, thrown.stderr], [127, 'EINVAL'], 'a spawn that throws resolves 127, never rejects');
  const missing = await rc.runCommandWith(spawn, '/nonexistent/definitely-not-here', [], {});
  eq(missing.status, 127, 'a program that is not there resolves 127 (the error event), never rejects');
  const failing = await rc.runCommandWith(spawn, process.execPath, ['-e', 'process.exit(3)'], {});
  eq(failing.status, 3, 'a non-zero exit is reported as is');

  // The timeout: a hung child must not hang Prepare.
  const t0 = Date.now();
  const hung = await rc.runCommandWith(spawn, process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 300 });
  const took = Date.now() - t0;
  ok(hung.status === rc.TIMEOUT_STATUS && hung.timedOut === true && took < 5000,
    `a child that hangs is killed at opts.timeoutMs and resolves {status: 124} (${took} ms, not 60 s)`);
  // Killed, not orphaned: a child that would write a file after 1.5 s must not.
  const { mkdtempSync, existsSync, rmSync } = await import('node:fs');
  const os = await import('node:os');
  const td = mkdtempSync(path.join(os.tmpdir(), 'curator-runcmd-'));
  const late = path.join(td, 'late.txt');
  await rc.runCommandWith(spawn, process.execPath, ['-e', `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(late)}, 'x'), 1500)`], { timeoutMs: 200 });
  await new Promise((r) => setTimeout(r, 2000));
  ok(!existsSync(late), '…and the hung child is actually killed (it never got to write its file)');
  rmSync(td, { recursive: true, force: true });
  const quick = await rc.runCommandWith(spawn, process.execPath, ['-e', 'process.stdout.write("ok")'], { timeoutMs: 10000 });
  eq([quick.status, quick.stdout, quick.timedOut], [0, 'ok', undefined], 'a child that finishes in time is unaffected by its timeout');

  // afterStart → what the reopened app shows.
  eq(sp.afterStartNotice({ ok: true, outcome: null, removed: 0, kept: 0 }), null, 'the Mac no-op answer shows nothing');
  eq(sp.afterStartNotice({ ok: true, outcome: { status: 'updated', result: 'installed', version: '9.9.9', message: null } }), null,
    'an update that landed shows nothing');
  eq(sp.afterStartNotice({ ok: true, outcome: { status: 'updated', result: 'installing', version: '9.9.9', message: 'any words' } }), null,
    '…even if a future record carried words: only a FAILED outcome is shown');
  const failedOutcome = { status: 'failed', result: 'exe-in-use', version: '9.9.9', message: 'The Curator was not updated, because …' };
  const n = sp.afterStartNotice({ ok: true, outcome: failedOutcome });
  ok(n && n.type === 'warning' && n.message === failedOutcome.message && n.buttons.length === 1,
    'an update that did NOT land shows the helper\'s own sentence once, as a warning with one button');
  eq([sp.afterStartNotice(null), sp.afterStartNotice({ ok: false }), sp.afterStartNotice({ ok: true, outcome: { status: 'failed', message: '  ' } })],
    [null, null, null], 'an unreadable or empty answer shows nothing (never an empty box)');
  // The real Windows engine's own answer, driven over a temp work dir.
  const wd = mkdtempSync(path.join(os.tmpdir(), 'curator-afterstart-'));
  const { writeFileSync } = await import('node:fs');
  const W = engine.createUpdateInstaller('win32', { workDir: wd, env: {}, pathImpl: path, showMessages: false, runCommand: async () => ({ status: 0, stdout: '', stderr: '' }) });
  writeFileSync(path.join(wd, 'last-update.json'), JSON.stringify({ version: '9.9.9', result: 'exe-in-use' }));
  const real = await W.afterStart({ currentVersion: '1.0.0' });
  const rn = sp.afterStartNotice(real);
  ok(rn && /not updated/.test(rn.message), `the Windows engine's failed record → a notice in its own words ("${rn && rn.message.slice(0, 60)}…")`);
  const D = engine.createUpdateInstaller('darwin', {});
  eq(sp.afterStartNotice(await D.afterStart({ currentVersion: '1.0.0' })), null, 'the Mac engine\'s afterStart → no notice');
  rmSync(wd, { recursive: true, force: true });
  eq(engine.createUpdateInstaller('linux', {}), null, 'any other platform: no engine, so no hooks (the route refuses no-updater)');

  // main.js — WEAK source scan of the wiring that cannot run here.
  const raw = read(path.join(DESKTOP, 'main.js'));
  const src = stripJsComments(raw);
  ok(/return createUpdateInstaller\(process\.platform, \{/.test(src) && !/createUpdateEngine\(/.test(src),
    'main.js builds the engine with createUpdateInstaller(process.platform, deps), not the Mac-only factory');
  ok(/env: process\.env,/.test(src), '…handing the Windows engine its environment');
  ok(/windowsHide: true,\s*\n\s*\.\.\.\(opts && opts\.env \? \{ env: opts\.env \} : \{\}\)/.test(src),
    'spawnDetached passes windowsHide and opts.env (only when given, so the Mac child inherits as before)');
  ok(/return runCommandWith\(spawn, cmd, args, opts\);/.test(src), 'runCommand is the executed lib/run-command.js');
  ok(/createWindow\(\);\s*if \(updater && typeof updater\.afterStart === 'function'\) \{\s*updater\.afterStart\(\{ currentVersion: readAppVersion\(\) \}\)/.test(src)
      && (src.match(/updater\.afterStart\(/g) || []).length === 1,
    'afterStart is called once per start, AFTER the window is created, with the running version');
  ok(/afterStartNotice\(r\)/.test(src), '…and what it shows is decided by afterStartNotice (executed above)');
  ok(/pickFolder: createPickFolder\(\{ dialog, getWindow: \(\) => mainWindow, platform: process\.platform \}\),/.test(src),
    'the folder dialog is the FA wiring line, exactly');
  ok(!/showOpenDialog/.test(src), '…and no second inline dialog survives in main.js');
  // NSIS starts the app with `--updated` after a silent update
  // (app-builder-lib templates/nsis/common.nsh StartApp). The shell reads no
  // argv at all, so the argument is ignored.
  ok(!/process\.argv/.test(src) && !/commandLine\.(hasSwitch|getSwitchValue)/.test(src),
    'main.js reads no command-line arguments, so NSIS\'s `--updated` after a silent update changes nothing');
  // audit M1 / minor 5 wiring (WEAK: written, not run).
  const iRefuse = src.indexOf("if (process.platform === 'win32' && await refusedIncompleteWindowsInstall()) return;");
  const iServer = src.indexOf('await import(pathToFileURL(SERVER_ENTRY).href)');
  ok(iRefuse > 0 && iServer > iRefuse && iRefuse < src.indexOf('applyMenu();'),
    'boot() refuses an incomplete Windows install FIRST: before the menu, the port and the server import');
  ok(/const refusal = appFilesIncompleteBox\(pathsModule\);\s*if \(!refusal\) return false;\s*dialog\.showErrorBox\(refusal\.title, refusal\.body\);\s*quitAuthorised = true;\s*app\.exit\(1\);/.test(src),
    '…with the box appFilesIncompleteBox decided (executed in §3b), then exit; nothing else runs');
  ok(/if \(!closeAsksQuitFirst\(\{\s*platform: process\.platform,\s*quitAuthorised,\s*trayActive: !!\(tray && !tray\.isDestroyed\(\)\),\s*sessionEnding,\s*\}\)\) return;\s*event\.preventDefault\(\);\s*app\.quit\(\);/.test(src),
    'the third close listener turns a no-tray Windows close into app.quit() (decision executed in §3)');
  ok((src.match(/keepReachableAfterKeepWorking\(\);/g) || []).length === 2,
    '"Keep working" and a failed quit check both bring a lost window back on Windows');
}

console.log(`\n  ────────────────────────────────────────`);
console.log(`  Passed: ${passed}   Failed: ${failed}`);
console.log(`  ────────────────────────────────────────\n`);
process.exit(failed === 0 ? 0 : 1);
