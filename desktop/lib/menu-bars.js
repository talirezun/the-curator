/**
 * renderGutterBar() — the DEPTH BAR, drawn as a still colour PNG for a menu
 * item's icon gutter (v3.66.0).
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  THE THIRD VISUAL CHANNEL, ON THE ONE SURFACE THAT CANNOT TINT A ROW      ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * The app draws SIZE/SHARE as a tinted bar BEHIND a figure (`renderDepthCell`,
 * `shared/depth-bar.js`), beside the two other channels: TIME (the freshness
 * dot, here the recency dot in `menu-dots.js`) and WHICH DOMAIN (the identity
 * dot). An Electron menu item can carry a still PNG in its ICON GUTTER and
 * nothing else — no row background, no live view (see `pulse-strip.js`'s
 * header for how that was established against the installed Electron). So in
 * the menu the bar is a short drawn bar in the gutter, at the dot's height,
 * and the FIGURE lives in the item's label beside it.
 *
 * That one difference moves a contrast obligation onto the bar. In the app the
 * figure is printed ON the bar, so the bar may be a quiet tint (it measures
 * 1.25–1.40:1 there, by design). Here nothing is printed on it: the bar is the
 * mark, so its FILL must clear the 3:1 non-text floor (WCAG 2.2 1.4.11) against
 * every background in the menu band — and the suite recomputes that from the
 * shipped hexes with the repo's own contrast code.
 *
 * ── WHAT A BAR IS HERE, AND WHAT IT MUST NEVER BE ─────────────────────────
 *
 *  - Its length is `amount ÷ a NAMED denominator` (a budget, or the largest
 *    member of the set it is compared across). The caller names it in the
 *    item's tooltip; this module only draws a fraction.
 *  - It is NEVER a time. Age is owned by the recency dot and the pulse strip.
 *  - `frac === null` (or anything not a finite number ≥ 0) draws NOTHING and
 *    returns null: a reading that was not taken is not an empty bar. An EMPTY
 *    bar (the track alone) is a MEASURED zero, and the two must never share a
 *    picture — this widget's founding fact-versus-absence rule.
 *  - `danger` is for a BUDGET OVER-RUN only, and the caller must also say it in
 *    words on the label (v3.16.1: a warning is never only a colour).
 *
 * ── THE SHAPE, IN POINTS (DESIGN-visual-channels-v3.66.0 §4.4) ─────────────
 *
 *   canvas   28 × 13   the recency dot's height, so rows align
 *   track    24 × 5    vertically centred, starting 2pt in; a 0.8pt RIM drawn
 *                      inward in the fill's own ink at 35% alpha — the rim idea
 *                      from `menu-dots.js`: a fraction needs a whole to be a
 *                      fraction of
 *   fill     24 × min(1, frac), never below 1pt when frac > 0, so "some" is
 *                      never drawn as "none"
 *   over-run the fill runs PAST the track's end to the canvas edge (+2pt).
 *                      That is SHAPE, not colour: an over-budget bar reads as
 *                      over-budget with the palette thrown away, which the
 *                      suite asserts in the alpha channel alone.
 *
 * ── WHY 28 AND WHAT IT COSTS ───────────────────────────────────────────────
 *
 * Electron draws a menu icon 1:1 and the image WIDENS the item (measured: the
 * 55pt strip drew at 55.0pt). A 28pt gutter plus the 4pt gap leaves a title
 * budget of `labelBudgetChars(28)` = 38 characters at the measured 363.5pt
 * menu — 2 fewer than a 13pt-dot row, 4 fewer than a plain item. The widest
 * item on the menu is still a scope row's 46-character sublabel, so a bar item
 * that keeps to 38 does NOT widen the menu. `tray-model.js` reserves this width
 * as `BAR_ICON_POINTS` and the suite pins the two equal.
 *
 * PURE: no Electron, nothing from `src/`, so `npm test` executes every pixel.
 * The identity colours are PASSED IN as a hex by the caller (tray-model.js,
 * which receives the palette from main.js) — this module holds no palette of
 * a domain's colour, so there is no second copy of `IDENTITY_PALETTE` here.
 */

import {
  createCanvas, coverage, paintPixel, hexToRgb, encodeRgbaPng,
} from './rgba-png.js';

/** The whole image, in points. The height is `menu-dots.js`'s DOT_POINTS. */
export const BAR_CANVAS_POINTS = 28;
export const BAR_HEIGHT_POINTS = 13;

/** The track: where a fraction of 1 ends. */
export const TRACK_X_POINTS = 2;
export const TRACK_WIDTH_POINTS = 24;
export const TRACK_HEIGHT_POINTS = 5;
export const TRACK_Y_POINTS = (BAR_HEIGHT_POINTS - TRACK_HEIGHT_POINTS) / 2;

/** The rim, drawn INWARD, in the fill's own ink at this share of its alpha —
 *  the same 35% `menu-dots.js` uses, so no unmeasured hue enters the drawing. */
export const RIM_POINTS = 0.8;
export const RIM_ALPHA = 0.35;

/** A non-zero fraction is never drawn shorter than this. */
export const MIN_FILL_POINTS = 1;

/**
 * The two inks this module owns, per theme. Identity inks are the caller's.
 *
 * MEASURED against `rgba-png.js`'s MENU_BG_BAND, worst of three backgrounds
 * (recomputed by the menu-bars suite in scripts/):
 *
 *   DARK    neutral #A8A8BC  4.86     danger #F87F8D  4.55
 *   LIGHT   neutral #55556A  5.29     danger #C33345  3.95
 *
 * `neutral` is `menu-dots.js`'s cold ink in dark (ink-200), deliberately: a
 * depth bar is not a status, so it wears the quietest ink the menu already
 * uses rather than a new hue.
 */
export const BAR_PALETTE = {
  dark: { neutral: '#A8A8BC', danger: '#F87F8D' },
  light: { neutral: '#55556A', danger: '#C33345' },
};

/** The palette for a theme. Anything other than a literal `dark: true` is
 *  LIGHT — the same safe default as `menu-dots.js`. */
export function barPalette(opts) {
  return (opts && opts.dark === true) ? BAR_PALETTE.dark : BAR_PALETTE.light;
}

/** A usable fraction, or null. Exported so the model and the suite agree on
 *  what "not measured" is. */
export function barFraction(amount, denominator) {
  const a = typeof amount === 'number' && Number.isFinite(amount) && amount >= 0 ? amount : null;
  const d = typeof denominator === 'number' && Number.isFinite(denominator) && denominator >= 0
    ? denominator : null;
  if (a === null || d === null) return null;
  // A MEASURED all-zero set (nobody saved; every domain empty) is an empty bar,
  // not an absent one — and never a division by zero.
  if (d === 0) return 0;
  return a / d;
}

/** The fill's length in points for a fraction (before scaling). */
export function fillPoints(frac) {
  if (!(typeof frac === 'number' && Number.isFinite(frac) && frac >= 0)) return null;
  if (frac === 0) return 0;
  if (frac > 1) return BAR_CANVAS_POINTS - TRACK_X_POINTS;          // over-run
  return Math.max(MIN_FILL_POINTS, TRACK_WIDTH_POINTS * frac);
}

/**
 * One bar's pixels at one scale. Exported so the suite can read the canvas
 * without a decode step AND decode the PNG independently.
 */
export function barCanvas(frac, scale, rgbHex) {
  const len = fillPoints(frac);
  if (len === null) return null;
  const s = Number.isInteger(scale) && scale > 0 ? scale : 1;
  const canvas = createCanvas(BAR_CANVAS_POINTS * s, BAR_HEIGHT_POINTS * s);
  const rgb = hexToRgb(rgbHex);

  const x0 = TRACK_X_POINTS * s;
  const x1 = (TRACK_X_POINTS + TRACK_WIDTH_POINTS) * s;
  const y0 = TRACK_Y_POINTS * s;
  const y1 = (TRACK_Y_POINTS + TRACK_HEIGHT_POINTS) * s;
  const r = RIM_POINTS * s;
  const fx1 = x0 + len * s;

  const inTrack = (x, y) => x >= x0 && x < x1 && y >= y0 && y < y1;
  const inRim = (x, y) => inTrack(x, y)
    && (x < x0 + r || x >= x1 - r || y < y0 + r || y >= y1 - r);
  const inFill = (x, y) => x >= x0 && x < fx1 && y >= y0 && y < y1;

  // Resolved per pixel BEFORE writing (max of fill and scaled rim), as
  // `menu-dots.js` does — one colour written once, so drawing order cannot cut
  // a seam where the fill meets the rim.
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const a = Math.max(coverage(x, y, inFill), coverage(x, y, inRim) * RIM_ALPHA);
      if (a > 0) paintPixel(canvas, x, y, rgb, a);
    }
  }
  return canvas;
}

/**
 * The gutter bar, as PNG bytes at 1x and 2x.
 *
 * @param {object} o
 * @param {number|null} o.frac   amount ÷ its named denominator; >1 is an over-run
 * @param {string} [o.ink]       an identity hex (`#rrggbb`) for a bar that IS a
 *                               domain; omitted → the neutral ink
 * @param {boolean} [o.danger]   a budget over-run (the caller also says it in words)
 * @param {boolean} [o.dark]     the MENU's appearance, supplied by the consumer
 * @returns {{buffer, buffer2x, widthPoints, heightPoints, template:false,
 *            frac, over, danger}|null}  null when there is nothing measured
 */
export function renderGutterBar(o = {}) {
  const frac = o && typeof o.frac === 'number' && Number.isFinite(o.frac) && o.frac >= 0
    ? o.frac : null;
  if (frac === null) return null;
  const pal = barPalette(o);
  const danger = o.danger === true;
  let ink = danger ? pal.danger : pal.neutral;
  // An identity ink is honoured only when it is a real hex and the bar is not
  // a danger bar: an over-run speaks in the danger ink whatever it measures.
  if (!danger && typeof o.ink === 'string' && /^#[0-9a-fA-F]{6}$/.test(o.ink)) ink = o.ink;
  return {
    buffer: encodeRgbaPng(barCanvas(frac, 1, ink)),
    buffer2x: encodeRgbaPng(barCanvas(frac, 2, ink)),
    widthPoints: BAR_CANVAS_POINTS,
    heightPoints: BAR_HEIGHT_POINTS,
    // NOT a template image — a template is tinted to one colour by macOS, which
    // would erase the danger and identity inks. See lib/rgba-png.js.
    template: false,
    frac,
    over: frac > 1,
    danger,
    ink,
  };
}
