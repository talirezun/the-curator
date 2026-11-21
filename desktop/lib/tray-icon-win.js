/**
 * The Windows tray icon, generated rather than shipped — the Mac menu-bar
 * glyph (`lib/tray-icon.js`), drawn in the taskbar's own ink.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  THE SAME GLYPH, THE SAME ONE BIT                                         ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * The Mac glyph carries ONE bit, by one rule (`buildTrayModel().glyph`):
 *
 *   idle   ○   an EMPTY ring — The Curator is running
 *   live   ◉   the ring with a filled centre — an agent saved working state
 *              on THIS computer within LIVE_WINDOW_SECONDS (lib/tray-model.js)
 *
 * The v3.66.0 parity rule: no widget fact may exist on one platform and not
 * the other, and it must READ the same. So Windows draws the very same alpha
 * matrix (`glyphMatrix` from lib/tray-icon.js — imported, not copied, so the
 * two can never drift) and nothing else.
 *
 * ── WHY v4.0.0 READ AS "ALWAYS A DOT" (owner, 2026-11-21) ──────────────────
 *
 * v4.0.0 put the mark on a filled violet DISC. The idle ring then had violet
 * on both sides of it — and a violet centre inside a white ring is, at 16 px,
 * a filled dot. Idle and live differed only in the colour of that centre, so
 * the icon looked "live" all the time. There is no disc any more: idle is
 * transparent inside the ring, exactly as on the Mac.
 *
 * ── THE INK: WHAT macOS DOES WITH A TEMPLATE IMAGE, DONE BY HAND ───────────
 *
 * macOS tints the template glyph for the menu bar. Windows does no tinting, so
 * the shell asks which taskbar it is drawing on (main.js reads
 * `nativeTheme.shouldUseDarkColorsForSystemIntegratedUI`, which on Windows is
 * the SYSTEM theme — the taskbar's — and is documented as distinct from the
 * app theme this app pins dark) and passes it in. White on a dark taskbar,
 * near-black on a light one: the same thing the Windows 11 system icons
 * (network, volume) do. Unknown is treated as DARK, the Windows 10 and 11
 * default.
 *
 * ── THE SIZES ──────────────────────────────────────────────────────────────
 *
 * The notification area draws a small icon: 16 px at 100 % scaling, 24 px at
 * 150 %, 32 px at 200 %. All three are produced and main.js adds them as scale
 * factors 1, 1.5 and 2 of one nativeImage, so Windows picks a drawn size
 * rather than resampling one.
 */

import { createCanvas, hexToRgb, encodeRgbaPng } from './rgba-png.js';
import { glyphMatrix } from './tray-icon.js';

/** The ink on each taskbar. White is what Windows' own tray glyphs use on the
 *  dark taskbar; #1F1F1F on the light one (≈ 15 : 1 on #F3F3F3). */
export const WIN_TRAY_INK = Object.freeze({ dark: '#FFFFFF', light: '#1F1F1F' });

/** Logical size (px at 100 % scaling) of a Windows notification-area icon. */
export const WIN_TRAY_POINTS = 16;

/** The scale factors produced, and the pixel size of each. */
export const WIN_TRAY_SCALES = Object.freeze([1, 1.5, 2]);

/** Anything but a literal `false` is a dark taskbar (the Windows default). */
export function winTrayTone(darkTaskbar) {
  return darkTaskbar === false ? 'light' : 'dark';
}

/**
 * One RGBA canvas for a state at a pixel size: the Mac glyph's alpha, in the
 * taskbar's ink.
 *
 * @param {number} size  pixels
 * @param {'idle'|'live'} state
 * @param {boolean} [darkTaskbar]
 */
export function winTrayCanvas(size, state, darkTaskbar) {
  const n = Math.max(1, Math.round(size));
  const alpha = glyphMatrix(n, state === 'live' ? 'live' : 'idle');
  const ink = hexToRgb(WIN_TRAY_INK[winTrayTone(darkTaskbar)]);
  const canvas = createCanvas(n, n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const a = Math.max(0, Math.min(255, Math.round(alpha[y][x])));
      if (a <= 0) continue;
      const p = (y * n + x) * 4;
      canvas.data[p] = ink[0];
      canvas.data[p + 1] = ink[1];
      canvas.data[p + 2] = ink[2];
      canvas.data[p + 3] = a;
    }
  }
  return canvas;
}

/**
 * Every representation of one state, ready for
 * `nativeImage.createFromBuffer(reps[0].buffer, {scaleFactor: reps[0].scale})`
 * plus `addRepresentation` for the rest.
 *
 * @param {'idle'|'live'} state
 * @param {{darkTaskbar?: boolean}} [opts]
 * @returns {{state:'idle'|'live', tone:'dark'|'light', points:number, template:false,
 *            reps:Array<{scale:number, size:number, buffer:Buffer}>}}
 */
export function winTrayIconPngs(state, opts = {}) {
  const s = state === 'live' ? 'live' : 'idle';
  const darkTaskbar = opts && opts.darkTaskbar;
  return {
    state: s,
    tone: winTrayTone(darkTaskbar),
    points: WIN_TRAY_POINTS,
    // NEVER a template: Windows does not tint; the ink is chosen here instead.
    template: false,
    reps: WIN_TRAY_SCALES.map((scale) => {
      const size = Math.round(WIN_TRAY_POINTS * scale);
      return { scale, size, buffer: encodeRgbaPng(winTrayCanvas(size, s, darkTaskbar)) };
    }),
  };
}

/**
 * The identity of the image the tray should be showing, so main.js re-sets it
 * only when it changes. darwin: the glyph state itself, exactly as before.
 * win32: the state AND the taskbar tone, so a switch between a light and a dark
 * taskbar redraws the icon too.
 */
export function trayIconKey(platform, glyph, darkTaskbar) {
  const g = glyph === 'live' ? 'live' : 'idle';
  if (platform !== 'win32') return glyph;
  return g + ':' + winTrayTone(darkTaskbar);
}
