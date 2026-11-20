#!/usr/bin/env node
/**
 * test-windows-words.js — Settings speaks Windows on Windows, and macOS
 * exactly as before everywhere else (Windows app, 2026-11-20, package H).
 *
 * The rows a Windows user reads in Settings › General were written for the
 * Mac: "Show the menu bar icon", "Hide the Dock icon", "Mac app only", "open
 * The Curator again from your Applications folder", "right-click the Dock icon
 * → Quit", and an in-app-update promise ("no security warning to click
 * through") that is MEASURED on the Mac only. On Windows the same rows must
 * say tray icon, taskbar button, Start menu and Stop The Curator, and must not
 * make the unmeasured promise. The stored setting (`backgroundMode`, values
 * window / tray / tray-only) and every data-background-mode id are unchanged:
 * only the words move.
 *
 * HOW. settings.js runs DOM code at module scope, so the functions are LIFTED
 * from its source and evaluated with the platform INJECTED as `browserPlatform`
 * (the real import's name), the same shape test-next-design-kit §12 and
 * test-update-in-app use. A lifted function with NO browserPlatform in scope
 * must render the macOS words (the guard every DOM-free suite relies on), and
 * a forced 'darwin' render must equal that default byte for byte.
 */

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(path.join(ROOT, 'src/public/next/views/settings.js'), 'utf8');

let passed = 0, failed = 0;
function ok(cond, label, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail !== undefined ? `\n      ${String(detail).slice(0, 400)}` : ''}`); }
}
function section(t) { console.log(`\n${t}`); }

function fnSource(name) {
  const start = SRC.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in settings.js`);
  const end = SRC.indexOf('\n}\n', start);
  return SRC.slice(start + 1, end + 2);
}
function constSource(name) {
  const m = new RegExp(`\\nconst ${name} = \\{[\\s\\S]*?\\n\\};`).exec(SRC);
  if (!m) throw new Error(`const ${name} not found in settings.js`);
  return m[0].slice(1);
}
const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const MAC_WORDS = /menu bar|Dock|macOS|Mac app|Applications folder|Finder|System Settings/i;
const WIN_WORDS = /tray|taskbar|Start menu|Windows/i;

// ═══════════════════════════════════════════════════════════════════════════
section('1. The tray row (Settings › General): Windows words on win32, the macOS row untouched');
// ═══════════════════════════════════════════════════════════════════════════
{
  const body = [constSource('BACKGROUND_MODE_LABELS'), constSource('BACKGROUND_MODE_LABELS_WIN32'),
    constSource('BACKGROUND_MODE_WORDS_WIN32'), fnSource('renderBackgroundMode')].join('\n');
  // With browserPlatform injected (as in the app) and without it (a DOM-free suite).
  const withPlatform = (p) => new Function('state', 'escapeHtml', 'browserPlatform', body + '\nreturn renderBackgroundMode;')
    ({ config: CFG, backgroundModeSaving: false }, esc, () => p)();
  const noImport = () => new Function('state', 'escapeHtml', body + '\nreturn renderBackgroundMode;')
    ({ config: CFG, backgroundModeSaving: false }, esc)();
  var CFG = { backgroundModes: ['window', 'tray', 'tray-only'], backgroundMode: 'tray' };
  const targets = (html) => [...html.matchAll(/data-background-mode="([^"]*)"/g)].map((m) => m[1]);

  const win = withPlatform('win32');
  const mac = withPlatform('darwin');
  ok(/>Show the tray icon</.test(win) && />Tray icon</.test(win) && /Hide the taskbar button while it is showing/.test(win)
    && /Windows app only\./.test(win), 'Windows: "Show the tray icon", the Tray icon label, the taskbar checkbox, "Windows app only."', win);
  ok(/hidden icons/.test(win) && /\^ arrow beside the clock/.test(win),
    'Windows: the "if the icon does not appear" note names where Windows hides new tray icons');
  ok(!MAC_WORDS.test(win.replace(/data-background-mode="tray-only"/g, '')),
    'Windows: no menu bar, Dock, macOS, Finder or System Settings anywhere in the row', (win.match(MAC_WORDS) || [])[0]);
  ok(targets(win).join() === targets(mac).join() && targets(win).join() === 'window,tray-only',
    'the CONTROLS are unchanged: the same data-background-mode ids, so the POST and the stored key do not move');
  ok(/>Show the menu bar icon</.test(mac) && /Hide the Dock icon while it is showing/.test(mac) && /Mac app only\./.test(mac)
    && /Bartender or Ice/.test(mac) && !/tray icon|taskbar/i.test(mac), 'macOS: the menu bar row, word for word');
  ok(mac === noImport(), 'a lifted copy with no browserPlatform in scope renders the macOS row BYTE-IDENTICALLY (the DOM-free suites\' guard)');
  ok(withPlatform('linux') === mac, 'Linux (and any other platform) keeps the macOS strings, unchanged');

  // A Windows mode list without 'tray-only' (the shell's call): the segmented
  // fallback, still in Windows words.
  CFG = { backgroundModes: ['window', 'tray'], backgroundMode: 'window' };
  const twoWin = withPlatform('win32');
  ok(/aria-label="Tray icon"/.test(twoWin) && /No tray icon\. The taskbar button/.test(twoWin) && !MAC_WORDS.test(twoWin),
    'Windows with a two-mode list: the segmented control, labelled Tray icon, Windows words throughout', twoWin);
}

// ═══════════════════════════════════════════════════════════════════════════
section('2. "If it does not come back": Start menu / Stop The Curator on Windows, the Mac sentences elsewhere');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { UPDATE_PHASE_ORDER, UPDATE_RING_STAGES, UPDATE_PHASE_COPY } = await import('../src/public/next/shared/update-phases.js');
  const body = [fnSource('box'), fnSource('renderInAppUpdate'), fnSource('renderUpdateStatus')].join('\n');
  const names = ['escapeHtml', 'state', 'inAppUpdate', 'UPDATE_PHASE_ORDER', 'UPDATE_RING_STAGES', 'UPDATE_PHASE_COPY'];
  const run = (state, inApp, platform) => {
    const params = platform === undefined ? names : [...names, 'browserPlatform'];
    const args = [esc, state, inApp, UPDATE_PHASE_ORDER, UPDATE_RING_STAGES, UPDATE_PHASE_COPY];
    if (platform !== undefined) args.push(() => platform);
    return new Function(...params, body + '\nreturn renderUpdateStatus;')(...args)();
  };
  const RELAUNCH = { phase: 'relaunching', job: null, version: '3.99.4', failure: null, restartHint: true };
  const appWin = run({}, RELAUNCH, 'win32');
  const appMac = run({}, RELAUNCH, 'darwin');
  ok(/from the Start menu/.test(appWin) && !/Applications folder/.test(appWin),
    'Windows app, update restarting and not back: "open The Curator again from the Start menu"', appWin);
  ok(!/no security warning/.test(appWin),
    'Windows app: no "no security warning to click through" (measured on the Mac only; SmartScreen on an in-app update is unmeasured)');
  ok(/Applications folder/.test(appMac) && /no security warning to click through/.test(appMac) && appMac === run({}, RELAUNCH),
    'macOS: the Applications-folder sentence and the measured promise, byte-identical to a render with no browserPlatform');

  const GIT = { updatePhase: 'restarting', updateResult: {}, updateRestartHint: true };
  const gitWin = run(GIT, null, 'win32');
  const gitMac = run(GIT, null, 'darwin');
  ok(/Stop The Curator on your desktop or in the Start menu/.test(gitWin) && !/Dock/.test(gitWin),
    'Windows browser install, git update restarting and not back: its own Stop The Curator shortcut, no Dock', gitWin);
  ok(/right-click the Dock icon → Quit/.test(gitMac) && gitMac === run(GIT, null),
    'macOS: the Dock sentence, byte-identical to a render with no browserPlatform');
}

// ═══════════════════════════════════════════════════════════════════════════
section('3. The Appearance lede names the tray on Windows');
// ═══════════════════════════════════════════════════════════════════════════
{
  const i = SRC.indexOf('  const appearanceLede =');
  const j = SRC.indexOf(';\n', i) + 2;
  const stmt = SRC.slice(i, j);
  const lede = (p) => new Function(...(p === undefined ? [] : ['browserPlatform']), stmt + 'return appearanceLede;')(...(p === undefined ? [] : [() => p]));
  ok(lede('win32') === 'Theme, text size and the tray icon. Saved in this browser.', 'Windows: "the tray icon"', lede('win32'));
  ok(lede('darwin') === 'Theme, text size and the menu bar icon. Saved in this browser.' && lede(undefined) === lede('darwin'),
    'macOS (and a lifted copy with no browserPlatform): "the menu bar icon", unchanged');
  ok(WIN_WORDS.test(lede('win32')) && !MAC_WORDS.test(lede('win32')), 'CONTROL: the word lists this suite uses tell the two apart');
}

console.log(`\nPassed: ${passed}   Failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
