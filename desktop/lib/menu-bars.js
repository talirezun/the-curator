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

// ═══════════════════════════════════════════════════════════════════════════
//  THE SESSION-START METER, IN THE GUTTER (v3.70.0)
// ═══════════════════════════════════════════════════════════════════════════
//
// The app's step ④ draws the context window as a SEGMENTED depth bar
// (`src/public/next/shared/bucket.js`, design rule 6 as amended in v3.70.0):
// the window to scale on top, and below it The Curator's part ENLARGED to its
// own scale, because at a 1M window The Curator's ≈7k is under a pixel of a
// 28pt gutter. The widget draws the same two readings, in the same 28 × 13
// canvas every other bar uses, as two lanes:
//
//   window lane   y 1–3pt    the window to scale: the harness as a HATCH (only
//                            when the owner set an estimate — never measured,
//                            never violet), The Curator as one violet fill (at
//                            least 1pt, so "some" is never "none"), free space
//                            as the faint track
//   enlargement   y 4–9pt    the SAME track as every other bar, so it lines up
//                            with the documents bar above it: each layer in the
//                            kit's violet lightness step, framed solid in the
//                            neutral ink, then the reading budget's unused room
//                            framed DASHED (the kit's dashed room)
//
// The fractions are the CALLER'S (tray-model.js `meterModel`, a pinned copy of
// the kit's `bucketModel`): this module draws, it does not decide a
// denominator. It is never danger-toned — a window is not a budget the owner
// set, and the kit refuses a danger tone for the same reason.
//
// ── THE COLOURS ARE THE KIT'S, WITH ONE MEASURED EXCEPTION ────────────────
//
// `LAYER_RAMP` is `tokens/layer.css`'s `--ly-*` resolved through
// `tokens/color.css`, both themes — the suite parses the two CSS files and
// pins every hex, so there is no second ramp to drift. The kit holds every
// pair of NEIGHBOURS to ≥ 3:1, and that carries over unchanged.
//
// The exception is the harness. The kit's hatch is two dark ink steps
// (ink-600/ink-700) drawn on its own dark track; on a macOS menu those measure
// ~1.2:1 and the hatch would vanish. Here it is stripes of this module's
// NEUTRAL ink over nothing — still neutral, still never violet, still a
// pattern rather than a colour — and it clears the 3:1 floor on every band.
// The layers' own fills do NOT each clear 3:1 against the menu (dark framing
// is ~1.2:1, exactly as it is on the kit's track), which is why the layer
// block is FRAMED in the neutral ink: the extent of The Curator's part is
// always a mark that clears the floor, whatever its layers are.

/** The lanes, in points. The enlargement IS the ordinary track. */
export const METER_WINDOW_Y_POINTS = 1;
export const METER_WINDOW_H_POINTS = 2;
export const METER_ZOOM_Y_POINTS = TRACK_Y_POINTS;
export const METER_ZOOM_H_POINTS = TRACK_HEIGHT_POINTS;
/** The hatch: one stripe of this width in every period, on the diagonal. */
export const HATCH_PERIOD_POINTS = 1.5;
export const HATCH_STRIPE_POINTS = 0.75;
/** The dashed room: dash, then gap, along its top and bottom edges. */
export const ROOM_DASH_POINTS = 1.5;
export const ROOM_GAP_POINTS = 1;
/** Frames are one device pixel at 2x, and one whole pixel at 1x. */
export const FRAME_POINTS = 0.5;

/** The kit's layer ramp, resolved (see the block comment). `curator` is the
 *  window lane's one violet fill and `room` the dashed edge — both the kit's
 *  `--ly-room-edge`, the violet step it already uses as a mark on its track. */
export const LAYER_RAMP = {
  dark: {
    framing: '#363648', brief: '#9D80F8', handoff: '#3A1B82', journal: '#D8CBFF',
    index: '#6538E0', read: '#EDE7FF', other: '#7C5AF5', room: '#9D80F8', curator: '#9D80F8',
  },
  light: {
    framing: '#363648', brief: '#9D80F8', handoff: '#3A1B82', journal: '#D8CBFF',
    index: '#6538E0', read: '#BCA6FF', other: '#7C5AF5', room: '#6538E0', curator: '#6538E0',
  },
};

/** The ramp for a theme — the same literal-`true` rule as `barPalette`. */
export function meterRamp(opts) {
  return (opts && opts.dark === true) ? LAYER_RAMP.dark : LAYER_RAMP.light;
}

/** `paintPixel`'s alpha is 0..255. */
const OPAQUE = 255;

const finiteFrac = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/**
 * The meter's pixels at one scale. `g` is the caller's geometry:
 *   { harnessFrac|null, curatorFrac, layers: [{key, frac}], roomFrac }
 * with every fraction of its own lane's width (window lane: of the window;
 * enlargement: of fixed layers + max(budget, read first)). Exported so the
 * suite can read the canvas without a decode step.
 */
export function meterCanvas(g, scale, opts = {}) {
  if (!g || typeof g !== 'object') return null;
  const s = Number.isInteger(scale) && scale > 0 ? scale : 1;
  const ramp = meterRamp(opts);
  const neutral = hexToRgb(barPalette(opts).neutral);
  const canvas = createCanvas(BAR_CANVAS_POINTS * s, BAR_HEIGHT_POINTS * s);
  const px = (pt) => Math.round(pt * s);
  const x0 = px(TRACK_X_POINTS);
  const x1 = px(TRACK_X_POINTS + TRACK_WIDTH_POINTS);
  const W = x1 - x0;
  const frame = Math.max(1, px(FRAME_POINTS));

  // ── The window lane ────────────────────────────────────────────────────
  const wy0 = px(METER_WINDOW_Y_POINTS);
  const wy1 = px(METER_WINDOW_Y_POINTS + METER_WINDOW_H_POINTS);
  const hFrac = finiteFrac(g.harnessFrac);
  const cFrac = finiteFrac(g.curatorFrac) || 0;
  const hx1 = x0 + (hFrac ? Math.round(W * Math.min(1, hFrac)) : 0);
  const cw = cFrac > 0 ? Math.max(px(MIN_FILL_POINTS), Math.round(W * Math.min(1, cFrac))) : 0;
  // An over-full window is squeezed by the caller; the Curator still keeps its
  // minimum, taken from the harness end rather than past the track.
  const cx0 = Math.min(hx1, x1 - cw);
  const cx1 = cx0 + cw;
  const period = HATCH_PERIOD_POINTS * s;
  const stripe = HATCH_STRIPE_POINTS * s;
  const curatorRgb = hexToRgb(ramp.curator);
  for (let y = wy0; y < wy1; y++) {
    for (let x = x0; x < x1; x++) {
      if (x >= cx0 && x < cx1) { paintPixel(canvas, x, y, curatorRgb, OPAQUE); continue; }
      if (x < hx1) {
        // The hatch: stripes on the diagonal; the gaps are EMPTY, not track, so
        // the pattern is what reads, in the alpha channel alone.
        if (((x + 0.5 + y + 0.5) % period) < stripe) paintPixel(canvas, x, y, neutral, OPAQUE);
        continue;
      }
      paintPixel(canvas, x, y, neutral, OPAQUE * RIM_ALPHA);                  // free
    }
  }

  // ── The enlargement ────────────────────────────────────────────────────
  const zy0 = px(METER_ZOOM_Y_POINTS);
  const zy1 = px(METER_ZOOM_Y_POINTS + METER_ZOOM_H_POINTS);
  const layers = Array.isArray(g.layers) ? g.layers : [];
  const edges = [];
  let acc = 0;
  for (const l of layers) {
    const f = finiteFrac(l && l.frac) || 0;
    const a = x0 + Math.round(W * Math.min(1, acc));
    acc += f;
    const b = x0 + Math.round(W * Math.min(1, acc));
    if (b > a) edges.push({ a, b, rgb: hexToRgb(ramp[l.key] || ramp.other) });
  }
  const lx1 = edges.length ? edges[edges.length - 1].b : x0;
  const roomFrac = finiteFrac(g.roomFrac) || 0;
  const rx1 = roomFrac > 0 ? Math.min(x1, lx1 + Math.max(1, Math.round(W * roomFrac))) : lx1;
  const roomRgb = hexToRgb(ramp.room);
  const dash = ROOM_DASH_POINTS * s;
  const gap = ROOM_GAP_POINTS * s;
  for (let y = zy0; y < zy1; y++) {
    for (let x = x0; x < x1; x++) {
      if (x < lx1) {
        const onFrame = y < zy0 + frame || y >= zy1 - frame || x < x0 + frame || x >= lx1 - frame;
        if (onFrame) { paintPixel(canvas, x, y, neutral, OPAQUE); continue; }
        const seg = edges.find((e) => x >= e.a && x < e.b);
        if (seg) paintPixel(canvas, x, y, seg.rgb, OPAQUE);
        continue;
      }
      if (x < rx1) {
        const edgeY = y < zy0 + frame || y >= zy1 - frame;
        const dashed = ((x - lx1 + 0.5) % (dash + gap)) < dash;
        if ((edgeY && dashed) || x >= rx1 - frame) paintPixel(canvas, x, y, roomRgb, OPAQUE);
      }
    }
  }
  return canvas;
}

/**
 * The session-start meter as PNG bytes at 1x and 2x, or null when there is
 * nothing measured to draw (no geometry, or a Curator part of nothing).
 *
 * @param {object} o  { harnessFrac|null, curatorFrac, layers:[{key,frac}],
 *                      roomFrac, dark }
 */
export function renderGutterMeter(o = {}) {
  if (!o || typeof o !== 'object') return null;
  const cFrac = finiteFrac(o.curatorFrac);
  const layers = Array.isArray(o.layers) ? o.layers : [];
  const sum = layers.reduce((n, l) => n + (finiteFrac(l && l.frac) || 0), 0);
  if (cFrac === null || !(sum > 0)) return null;
  return {
    buffer: encodeRgbaPng(meterCanvas(o, 1, o)),
    buffer2x: encodeRgbaPng(meterCanvas(o, 2, o)),
    widthPoints: BAR_CANVAS_POINTS,
    heightPoints: BAR_HEIGHT_POINTS,
    template: false,
    kind: 'meter',
    harness: finiteFrac(o.harnessFrac) !== null && o.harnessFrac > 0,
    danger: false,
  };
}
