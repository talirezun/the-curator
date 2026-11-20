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
import { fileURLToPath } from 'node:url';

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
  sp = await import(path.join(DESKTOP, 'lib', 'shell-platform.js'));
  mode = await import(path.join(DESKTOP, 'lib', 'background-mode.js'));
  winIcon = await import(path.join(DESKTOP, 'lib', 'tray-icon-win.js'));
  menu = await import(path.join(DESKTOP, 'lib', 'menu.js'));
  trayMenu = await import(path.join(DESKTOP, 'lib', 'tray-menu.js'));
  trayModel = await import(path.join(DESKTOP, 'lib', 'tray-model.js'));
  appVersion = await import(path.join(DESKTOP, 'lib', 'app-version.js'));
  png = await import(path.join(ROOT, 'scripts', 'visual', 'png.js'));
  contrast = await import(path.join(ROOT, 'scripts', 'visual', 'contrast.js'));
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
  eq(win.templateImage, false, 'win32: NOT a template image — Windows does not tint, a black glyph vanishes on a dark taskbar');
  eq(win.setContextMenu, false, 'win32: the menu is never SET on the tray…');
  eq(win.popUpOnRightClick, true, '…it is popped on right-click, so it is rebuilt immediately before it is shown');
  eq(win.leftClick, 'show-window', 'win32: left-click shows the window (the Windows convention)');
  eq(win.remoteCheckOnLeftClick, false, 'win32: a left-click is not a menu open, so it does not ask GitHub');
  ok(Object.isFrozen(mac) && Object.isFrozen(win), 'both plans are frozen');
  // The remote-check allow-list must still contain the trigger the Windows
  // right-click passes — or the Windows menu would never ask about other machines.
  const remote = await import(path.join(DESKTOP, 'lib', 'tray-remote.js'));
  ok(remote.REMOTE_CHECK_TRIGGERS.includes('right-click'), 'the right-click trigger Windows uses is in tray-remote.js\'s allow-list');
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
  const engine = await import(path.join(DESKTOP, 'lib', 'update-engine.js'));
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
section('§10 the Windows tray icon: coloured, two states, three sizes');
{
  const DISC = [0x7C, 0x5A, 0xF5];
  const pix = (img, x, y) => {
    const p = (y * img.width + x) * img.channels;
    return [img.data[p], img.data[p + 1], img.data[p + 2], img.data[p + 3]];
  };
  const tokens = read(path.join(ROOT, 'src', 'public', 'next', 'tokens', 'color.css'));
  ok(new RegExp('--violet-500:\\s*' + winIcon.WIN_TRAY_DISC_HEX + ';', 'i').test(tokens),
    'the disc colour IS --violet-500 in the app\'s own tokens, not a second copy that can drift');
  for (const state of ['idle', 'live']) {
    const r = winIcon.winTrayIconPngs(state);
    eq(r.template, false, `${state}: never marked as a template`);
    eq(r.reps.map((x) => [x.scale, x.size]), [[1, 16], [1.5, 24], [2, 32]], `${state}: 16, 24 and 32 px for 100/150/200 %`);
    for (const rep of r.reps) {
      const img = png.decodePng(rep.buffer);
      eq([img.width, img.height, img.channels], [rep.size, rep.size, 4], `${state} ${rep.size}px decodes (independent decoder) as RGBA ${rep.size}×${rep.size}`);
      eq(pix(img, 0, 0)[3], 0, `${state} ${rep.size}px: the corner is transparent — a disc, not a square`);
      // Somewhere on the disc, between the edge and the ring, is pure violet.
      const n = rep.size;
      // Midway between the disc's edge and the ring's outer edge, straight up.
      const gq = winIcon.WIN_TRAY_GEOMETRY;
      const band = pix(img, Math.floor(n / 2), Math.floor(n / 2 - n * (gq.disc + gq.ringOuter) / 2));
      ok(band[3] > 200 && Math.abs(band[0] - DISC[0]) < 6 && Math.abs(band[2] - DISC[2]) < 6,
        `${state} ${n}px: the disc is violet (${band.slice(0, 3).join(',')})`);
    }
  }
  const centre = (state, size) => {
    const rep = winIcon.winTrayIconPngs(state).reps.find((x) => x.size === size);
    const img = png.decodePng(rep.buffer);
    return pix(img, Math.floor(size / 2), Math.floor(size / 2));
  };
  for (const size of [16, 24, 32]) {
    const live = centre('live', size), idle = centre('idle', size);
    ok(live[0] > 240 && live[1] > 240 && live[2] > 240, `${size}px live: the centre is WHITE (the Mac's filled dot)`);
    ok(Math.abs(idle[0] - DISC[0]) < 10 && Math.abs(idle[1] - DISC[1]) < 10, `${size}px idle: the centre is violet (the Mac's empty ring)`);
  }
  // The one bit is the ONLY difference: outside the centre, both states agree.
  {
    const a = png.decodePng(winIcon.winTrayIconPngs('idle').reps[2].buffer);
    const b = png.decodePng(winIcon.winTrayIconPngs('live').reps[2].buffer);
    let diffOutside = 0, diffInside = 0;
    const c = 16, rDot = 32 * winIcon.WIN_TRAY_GEOMETRY.dot + 1;
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
      const p = (y * 32 + x) * 4;
      const same = a.data.subarray(p, p + 4).equals(b.data.subarray(p, p + 4));
      const inDot = (x + 0.5 - c) ** 2 + (y + 0.5 - c) ** 2 <= rDot * rDot;
      if (!same) { if (inDot) diffInside++; else diffOutside++; }
    }
    ok(diffInside > 10, `live and idle really differ in the centre (${diffInside} px)`);
    eq(diffOutside, 0, 'and NOWHERE else — the icon carries exactly the Mac glyph\'s one bit');
  }
  // Contrast, computed from the decoded pixels.
  {
    const img = png.decodePng(winIcon.winTrayIconPngs('live').reps[2].buffer);
    const disc = pix(img, 16, 3);
    const mark = pix(img, 16, 16);
    const white = contrast.contrastRatio(mark, disc);
    const dark = contrast.contrastRatio(disc, [0x20, 0x20, 0x20]);
    const light = contrast.contrastRatio(disc, [0xF3, 0xF3, 0xF3]);
    ok(white >= 3, `the white mark on the disc: ${contrast.round2(white)}:1 (non-text floor 3:1)`);
    ok(dark >= 3, `the disc on a dark taskbar #202020: ${contrast.round2(dark)}:1`);
    ok(light >= 3, `the disc on a light taskbar #F3F3F3: ${contrast.round2(light)}:1 — legible on both, no theme detection needed`);
  }
  // Mark inside disc at every size (geometry, not trust).
  const g = winIcon.WIN_TRAY_GEOMETRY;
  ok(g.ringOuter < g.disc && g.dot < g.ringOuter - g.ringWidth, 'the ring sits inside the disc and the dot inside the ring');
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
  const missing = macTipLines.filter((l) => !winLabels.includes(esc(l)));
  eq(missing.length, 0, `every Mac tooltip line (${macTipLines.length}) is a Windows item${missing.length ? ' — missing: ' + missing.slice(0, 3).join(' | ') : ''}`);

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
  (await import(path.join(DESKTOP, 'lib', 'tray-menu-win.js'))).adaptTrayMenuForWindows(mac);
  eq(ser(mac), before, 'adaptTrayMenuForWindows does not mutate the Mac template');
  // A disabled statement with a tooltip opens a submenu of facts, and stays a statement.
  const tw = await import(path.join(DESKTOP, 'lib', 'tray-menu-win.js'));
  const [stmt] = tw.adaptTrayMenuForWindows([{ label: 'short', enabled: false, toolTip: 'the whole sentence\nsecond fact' }]);
  ok(stmt.enabled === true && stmt.submenu.length === 2 && stmt.submenu.every((x) => x.enabled === false),
    'a clipped statement becomes a parent whose submenu holds only its disabled detail lines');
  let hit = 0;
  const [act] = tw.adaptTrayMenuForWindows([{ label: 'collision', click: () => { hit++; }, toolTip: 'full text' }]);
  eq(act.submenu[0].label, tw.WIN_OPEN_LABEL, 'an action with a tooltip keeps its action as the first submenu item');
  act.submenu[0].click();
  eq(hit, 1, 'and that item runs the original handler');
  ok(typeof act.click !== 'function', 'the parent itself carries no handler (Windows opens the submenu)');
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
  ok(/tray\.on\('click', \(\) => \{ revealWindow\(\); refreshTraySummary\(\); \}\)/.test(src),
    'Windows left-click shows the window and re-reads the index, without a remote check');
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
  const rc = await import(path.join(DESKTOP, 'lib', 'run-command.js'));
  const engine = await import(path.join(DESKTOP, 'lib', 'update-engine.js'));

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
}

console.log(`\n  ────────────────────────────────────────`);
console.log(`  Passed: ${passed}   Failed: ${failed}`);
console.log(`  ────────────────────────────────────────\n`);
process.exit(failed === 0 ? 0 : 1);
