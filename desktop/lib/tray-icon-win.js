/**
 * The Windows tray icon, generated rather than shipped — the coloured twin of
 * `lib/tray-icon.js`'s macOS template glyph.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  WHY NOT THE MAC GLYPH, AND WHY NOT A STATIC .ico                         ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * The Mac glyph is a TEMPLATE image: pure black, all information in alpha, and
 * macOS tints it for the bar. Windows does no such tinting. A black ring on the
 * default (dark) Windows 10/11 taskbar is invisible. So Windows needs colour.
 *
 * A static `.ico` from the build would be coloured, but it would carry ONE
 * picture, and the Mac glyph carries one BIT: idle (a ring) or live (a ring
 * with a filled centre — an agent has written on this computer within the live
 * window). The v3.66.0 parity rule says no widget fact may exist on one
 * platform and not the other, so the Windows icon carries the same bit, drawn
 * by the same rule (`state === 'live'` fills the centre), and is generated here
 * where the offline suite can decode it and assert the pixels.
 *
 * ── THE DRAWING ────────────────────────────────────────────────────────────
 *
 * A violet disc (the app's accent, `--violet-500` #7C5AF5) carrying the Mac's
 * mark in white: a ring, plus a filled centre when live. The disc is what makes
 * it legible on BOTH taskbar themes without having to know which one is
 * showing (AgentLink needed a light and a dark set; this needs neither):
 *
 *   white on #7C5AF5                ≈ 4.5 : 1
 *   #7C5AF5 on a dark taskbar #202020 ≈ 3.6 : 1
 *   #7C5AF5 on a light taskbar #F3F3F3 ≈ 4.1 : 1
 *
 * all at or above the 3:1 non-text floor `rgba-png.js` already uses. The suite
 * recomputes them from the decoded pixels rather than trusting this comment.
 *
 * ── THE SIZES ──────────────────────────────────────────────────────────────
 *
 * The notification area draws a small icon: 16 px at 100 % scaling, 24 px at
 * 150 %, 32 px at 200 %. All three are produced and main.js adds them as scale
 * factors 1, 1.5 and 2 of one nativeImage, so Windows picks a drawn size
 * rather than resampling one (which is what makes a 16 px circle mush).
 */

import { createCanvas, coverage, hexToRgb, encodeRgbaPng } from './rgba-png.js';

/** The app's accent — `--violet-500` in src/public/next/tokens/color.css. */
export const WIN_TRAY_DISC_HEX = '#7C5AF5';
export const WIN_TRAY_MARK_HEX = '#FFFFFF';

/** Logical size (px at 100 % scaling) of a Windows notification-area icon. */
export const WIN_TRAY_POINTS = 16;

/** The scale factors produced, and the pixel size of each. */
export const WIN_TRAY_SCALES = Object.freeze([1, 1.5, 2]);

/**
 * The geometry, as fractions of the canvas, so every size is the same drawing
 * at a different resolution. Exported so the suite can assert the mark sits
 * inside the disc at every size rather than trusting the numbers.
 */
export const WIN_TRAY_GEOMETRY = Object.freeze({
  disc: 0.47,        // disc radius
  ringOuter: 0.33,   // white ring, outer radius
  ringWidth: 0.10,   // white ring thickness
  dot: 0.15,         // white centre, live only
});

function mix(a, b, t) { return a + (b - a) * t; }

/**
 * One RGBA canvas for a state at a pixel size.
 *
 * Composited by hand rather than painted twice: `paintPixel` overwrites, so a
 * second pass would replace a disc edge pixel with a half-transparent white
 * one. Here the disc decides the ALPHA and the mark decides how far each pixel
 * moves from violet towards white — the mark lies entirely inside the disc, so
 * the two never compete.
 *
 * @param {number} size  pixels
 * @param {'idle'|'live'} state
 */
export function winTrayCanvas(size, state) {
  const n = Math.max(1, Math.round(size));
  const c = n / 2;
  const g = WIN_TRAY_GEOMETRY;
  const disc = n * g.disc;
  const outer = n * g.ringOuter;
  const inner = outer - n * g.ringWidth;
  const dot = n * g.dot;
  const live = state === 'live';
  const discRgb = hexToRgb(WIN_TRAY_DISC_HEX);
  const markRgb = hexToRgb(WIN_TRAY_MARK_HEX);

  const inDisc = (x, y) => { const dx = x - c, dy = y - c; return dx * dx + dy * dy <= disc * disc; };
  const inMark = (x, y) => {
    const dx = x - c, dy = y - c;
    const r2 = dx * dx + dy * dy;
    if (r2 <= outer * outer && r2 >= inner * inner) return true;
    return live && r2 <= dot * dot;
  };

  const canvas = createCanvas(n, n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const a = coverage(x, y, inDisc);
      if (a <= 0) continue;
      const t = coverage(x, y, inMark) / 255;
      const p = (y * n + x) * 4;
      canvas.data[p] = Math.round(mix(discRgb[0], markRgb[0], t));
      canvas.data[p + 1] = Math.round(mix(discRgb[1], markRgb[1], t));
      canvas.data[p + 2] = Math.round(mix(discRgb[2], markRgb[2], t));
      canvas.data[p + 3] = Math.round(a);
    }
  }
  return canvas;
}

/**
 * Every representation of one state, ready for
 * `nativeImage.createFromBuffer(reps[0].buffer, {scaleFactor: reps[0].scale})`
 * plus `addRepresentation` for the rest.
 *
 * @returns {{state:'idle'|'live', points:number, template:false,
 *            reps:Array<{scale:number, size:number, buffer:Buffer}>}}
 */
export function winTrayIconPngs(state) {
  const s = state === 'live' ? 'live' : 'idle';
  return {
    state: s,
    points: WIN_TRAY_POINTS,
    // NEVER a template: Windows does not tint, and the colour IS the legibility.
    template: false,
    reps: WIN_TRAY_SCALES.map((scale) => {
      const size = Math.round(WIN_TRAY_POINTS * scale);
      return { scale, size, buffer: encodeRgbaPng(winTrayCanvas(size, s)) };
    }),
  };
}
