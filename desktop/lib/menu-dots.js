/**
 * renderRecencyDot() — a row's freshness mark for the tray menu: THE APP'S
 * DOT, ON THE APP'S SCALE (v3.74.0).
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  ONE SCALE, TWO SURFACES                                                  ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * The app paints "how recently" with ONE scale — `freshnessTier` in
 * `src/public/next/shared/age.js`, drawn by `shared/freshness.css`:
 *
 *   live      < 60 s     hot, filled + halo
 *   recent    < 1 hr     hot, filled
 *   today     < 24 hr    mid, filled
 *   week      < 7 days   cold, filled
 *   dormant   ≥ 7 days   cold, HOLLOW
 *   unknown   no age     a DASHED ring — different in kind, never "old"
 *
 * Up to v3.72 the tray drew its OWN ladder as a draining pie (2 min / 30 min /
 * 12 h / 7 d). The design audit measured two defects: a draining disc reads
 * as a FILL GAUGE — a battery, a context meter, precisely the "am I running
 * out of context?" question it does not answer — and its cut points
 * disagreed with the app's, so one save wore two different marks on the two
 * surfaces a user sees in the same glance. This module now draws the app's
 * marks. The tier NAMES come from `tray-model.js`'s pinned copy of
 * `freshnessTier`; this module maps a name to pixels and nothing else.
 *
 * ── WHAT THE SHAPES CARRY WITHOUT COLOUR, AND WHAT THEY DO NOT ─────────────
 *
 * The app's scale differs in SHAPE at its two ends — the halo on `live`, the
 * hollow ring on `dormant`, the dashed ring on `unknown` — and in HUE only
 * between `recent`, `today` and `week`. That is the app's own decision
 * (freshness.css: "the pre-attentive cut is at one hour", and "every mark in
 * this app sits immediately beside the age in words"), and it holds here for
 * the same reason: every dot sits beside its age in words on the same line.
 * The suite asserts the shape classes in the ALPHA CHANNEL alone — live has
 * ink outside the disc, dormant has a transparent centre, unknown has gaps
 * in its ring, the three filled tiers are one silhouette — so nothing claims
 * a colour-free distinction that is not there.
 *
 * ── NOT A TEMPLATE IMAGE ───────────────────────────────────────────────────
 * Menu item icons are drawn in colour; the spec says `template: false` and
 * the consumer must not call `setTemplateImage(true)` on it. See rgba-png.js.
 */

import {
  coverage, createCanvas, encodeRgbaPng, hexToRgb, paintPixel,
} from './rgba-png.js';

/**
 * The canvas, in POINTS: 13pt square, the gutter `tray-model.js` reserves as
 * `ROW_ICON_POINTS` (pinned by the suite).
 *
 * ODD ON PURPOSE. A circle centred at `size / 2` on an EVEN canvas is centred
 * on a pixel CORNER and no pixel of a small disc is fully covered at 1x. On an
 * odd canvas the centre is the middle of pixel 6, so the disc has a solid
 * core and the hollow ring a genuinely transparent one.
 */
export const DOT_POINTS = 13;

/**
 * Every colour drawn by this module, per theme. MEASURED, NOT PICKED: each
 * clears 3:1 (WCAG 2.2 1.4.11, the non-text floor) against every background
 * of its theme's band in rgba-png.js's `MENU_BG_BAND` — the suite recomputes
 * it. The app's `--fresh-*` tokens are the same three roles (hot / mid /
 * cold); the values here are the menu-band-measured ones, because a macOS
 * menu is not the app's `--surface`.
 *
 *   LIGHT   hot  #15704F   mid  #8A5F19   cold #6B6B80
 *   DARK    hot  #4FD3A4   mid  #EDBB63   cold #A8A8BC
 */
export const DOT_PALETTE = {
  light: { hot: '#15704F', mid: '#8A5F19', cold: '#6B6B80' },
  dark: { hot: '#4FD3A4', mid: '#EDBB63', cold: '#A8A8BC' },
};

/** The app's dot is 8px across; here it is 8pt — r 4.0. */
export const DOT_RADIUS = 4.0;
/** The `live` halo: the app's `box-shadow: 0 0 0 3px` is 3px beyond an 8px
 *  dot; 13pt leaves 2.5pt of room, so the halo runs to r 6.0 — 2pt, inside
 *  the canvas with a half-point margin. */
export const HALO_OUTER = 6.0;
/** The halo's alpha: the app's `--fresh-hot-halo` is the hot ink at 0.18–0.22
 *  on a flat surface; a menu is translucent, so it is drawn a little stronger. */
export const HALO_ALPHA = 0.3;
/** `dormant`: the app's `inset 0 0 0 2px` — a 2pt ring inside the 4pt radius. */
export const HOLLOW_STROKE = 2.0;
/** `unknown`: the app's `1.5px dashed` border. Eight dashes round the ring. */
export const DASH_STROKE = 1.5;
export const DASH_COUNT = 8;

/**
 * Each tier's mark. `shape` is one of `disc`, `ring`, `dashed`; `halo` adds
 * the outer glow. `unknown` IS drawn (the app's dashed ring) — an age we do
 * not have is a different KIND of mark, never the coldest one, and the app
 * paints it rather than leaving a gap.
 */
export const DOT_INK = {
  live: { tone: 'hot', shape: 'disc', halo: true },
  recent: { tone: 'hot', shape: 'disc', halo: false },
  today: { tone: 'mid', shape: 'disc', halo: false },
  week: { tone: 'cold', shape: 'disc', halo: false },
  dormant: { tone: 'cold', shape: 'ring', halo: false },
  unknown: { tone: 'cold', shape: 'dashed', halo: false },
};

/** The order of the scale, freshest first. Exported so the suite asserts the
 *  order that ships rather than one it restates. */
export const DOT_ORDER = ['live', 'recent', 'today', 'week', 'dormant', 'unknown'];

/** The palette for a theme. Anything other than an explicit `dark: true` is
 *  LIGHT, because a missing option must resolve to something rather than to a
 *  crash inside a menu build. */
export function dotPalette(opts) {
  return (opts && opts.dark === true) ? DOT_PALETTE.dark : DOT_PALETTE.light;
}

/** Is (dx, dy) — measured from the centre — inside a dash of the dashed ring?
 *  The ring is cut into 2 × `DASH_COUNT` equal arcs, alternately drawn and
 *  empty. */
function onDash(dx, dy) {
  const a = Math.atan2(dy, dx) + Math.PI;
  const seg = Math.floor(a / (Math.PI / DASH_COUNT));
  return seg % 2 === 0;
}

/**
 * The RGBA canvas for one tier at one scale factor.
 *
 * ONE COLOUR PER PIXEL, written once: each pixel's alpha is the greater of
 * the mark's coverage and the halo's coverage scaled by `HALO_ALPHA`, so the
 * drawing order cannot cut a seam between them (`paintPixel` replaces rather
 * than composites, deliberately).
 */
export function dotCanvas(tier, scale, palette) {
  const ink = DOT_INK[tier];
  if (!ink) return null;
  const s = Number.isInteger(scale) && scale > 0 ? scale : 1;
  const canvas = createCanvas(DOT_POINTS * s, DOT_POINTS * s);
  const c = (DOT_POINTS / 2) * s;
  const r = DOT_RADIUS * s;
  const rgb = hexToRgb(palette[ink.tone]);
  const d2 = (x, y) => (x - c) * (x - c) + (y - c) * (y - c);

  let inMark;
  if (ink.shape === 'disc') {
    inMark = (x, y) => d2(x, y) <= r * r;
  } else if (ink.shape === 'ring') {
    const inner = (DOT_RADIUS - HOLLOW_STROKE) * s;
    inMark = (x, y) => { const q = d2(x, y); return q <= r * r && q >= inner * inner; };
  } else {
    const inner = (DOT_RADIUS - DASH_STROKE) * s;
    inMark = (x, y) => {
      const q = d2(x, y);
      return q <= r * r && q >= inner * inner && onDash(x - c, y - c);
    };
  }
  const haloR = HALO_OUTER * s;
  const inHalo = ink.halo
    ? (x, y) => { const q = d2(x, y); return q <= haloR * haloR && q > r * r; }
    : null;

  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const a = Math.max(coverage(x, y, inMark), inHalo ? coverage(x, y, inHalo) * HALO_ALPHA : 0);
      if (a > 0) paintPixel(canvas, x, y, rgb, a);
    }
  }
  return canvas;
}

/**
 * The freshness dot, as PNG bytes at 1x and 2x.
 *
 * @param {string} tier  one of `freshnessTier()`'s names
 * @param {{dark?:boolean}} [opts]  the CONSUMER supplies the theme
 * @returns {{buffer, buffer2x, widthPoints, heightPoints, template:false,
 *            kind:'dot', tier}|null}  null for a name this module has never
 *   heard of — an unrecognised name is not a tier, and inventing a mark for
 *   it would be a guess.
 */
export function renderRecencyDot(tier, opts) {
  if (typeof tier !== 'string' || !Object.prototype.hasOwnProperty.call(DOT_INK, tier)) return null;
  const palette = dotPalette(opts);
  return {
    buffer: encodeRgbaPng(dotCanvas(tier, 1, palette)),
    // TWO representations: a 1x-only image is soft on every Retina Mac, and a
    // 2x-only image handed to a 1x display is downsampled by the OS.
    buffer2x: encodeRgbaPng(dotCanvas(tier, 2, palette)),
    widthPoints: DOT_POINTS,
    heightPoints: DOT_POINTS,
    template: false,
    // What the picture IS, for a text rendering of the menu and the suites —
    // never read by Electron.
    kind: 'dot',
    tier,
  };
}

/**
 * The tier in words, so the colour is never the only way to learn what a mark
 * means. The app's own bands.
 */
export function dotToolTipLine(tier) {
  switch (tier) {
    case 'live': return 'Saved in the last minute.';
    case 'recent': return 'Saved in the last hour.';
    case 'today': return 'Saved in the last 24 hours.';
    case 'week': return 'Saved in the last week.';
    case 'dormant': return 'Older than a week.';
    case 'unknown': return 'No save time is recorded.';
    default: return null;
  }
}
