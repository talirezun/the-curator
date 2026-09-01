/**
 * renderRecencyDot() — a per-row recency mark for the tray menu.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  THIS IS A SURFACE FOR A CALCULATION THE APP ALREADY PERFORMS             ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * `ageBucket()` in `lib/tray-model.js` has always resolved a row's age into
 * five named states — `live` / `warm` / `today` / `cool` / `cold` — plus
 * `unknown` when there is no age at all. Until now exactly one of those
 * distinctions reached a screen: the tray glyph fills its centre when some row
 * on THIS machine is `live`, and the other four states were computed and
 * discarded. Nothing new is being measured here. A measurement that was already
 * being made is being drawn.
 *
 * The bucket names, the thresholds and the `unknown` case are READ from
 * `tray-model.js` and are not restated as constants: a second opinion about
 * what "warm" means is exactly the drift this project keeps recording. This
 * module maps names to ink and nothing else.
 *
 * ── FIVE BUCKETS ONTO THREE COLOURS, AND WHY THAT IS NOT A LOSS ────────────
 *
 * The approved palette is green / amber / grey, and there are five states. The
 * collapse is deliberate, and the boundaries are placed where the ANSWER
 * changes rather than where the numbers are round:
 *
 *   green   live, warm    under 30 minutes    this is the work-stream in front
 *                                             of you; resuming costs nothing
 *   amber   today         30 min to 12 hours  same working day; resumable, but
 *                                             you will re-read the handoff
 *   grey    cool, cold    over 12 hours       history
 *
 * WHY GREEN COVERS `warm` AND NOT ONLY `live`. `LIVE_WINDOW_SECONDS` is 120
 * seconds. A menu opened by hand will essentially never land inside a
 * two-minute window, so a green reserved for `live` alone would spend the
 * strongest colour in the palette on the state the user almost never sees, and
 * every row would be amber or grey in practice. 30 minutes is the point at
 * which the handoff stops being in your head, which is the thing the colour is
 * being asked about.
 *
 * WHY GREY COVERS BOTH `cool` AND `cold`. Three days ago and three weeks ago
 * prompt the same action — read it properly before you touch it — so a third
 * shade between them would be a distinction with no consequence.
 *
 * AND THE COLLAPSE COSTS NOTHING, because the exact figure is on the same row.
 * `formatAge` already writes "2 min ago" / "34 hr ago" / "1 day ago" into the
 * row's own text. The dot is the PRE-ATTENTIVE BAND and the words are the
 * NUMBER — the same split v3.34.0 recorded for the save-status pip, where the
 * age is "a BAND rather than a number" for the one-second glance. Collapsing a
 * value whose exact form is printed beside it is not information loss.
 *
 * ── COLOUR IS NEVER THE ONLY SIGNAL ────────────────────────────────────────
 *
 * Green and amber are the classic confusion pair for the commonest colour
 * vision deficiencies, and their luminances cannot be pushed far apart without
 * one of them approaching the contrast floor. So the five states are ALSO a
 * ladder in ink, and the ladder is the part that survives with the colour
 * removed:
 *
 *   live    filled disc, r 3.0pt      28.3pt² of ink
 *   warm    ring,        r 3.0pt      18.1
 *   today   ring,        r 2.5pt      13.5
 *   cool    ring,        r 2.0pt       9.4
 *   cold    filled dot,  r 1.2pt       4.5
 *
 * Strictly decreasing, and the suite asserts it from the shipped geometry
 * rather than from this comment. `live` is the one state whose recognition
 * changes what a person does next — something is being written right now — and
 * it is the only FILLED disc at full size, so it is separable from everything
 * else without reference to colour at all. `cold` returns to a filled shape at
 * 16% of `live`'s area, which no viewer will confuse with it.
 *
 * The ring/disc vocabulary is deliberately the tray glyph's own: `tray-icon.js`
 * draws a ring always and fills the centre when live. A user who has learned
 * the glyph has already learned the dot.
 *
 * ── NOT A TEMPLATE IMAGE ───────────────────────────────────────────────────
 *
 * See `lib/rgba-png.js` for the whole story. Menu item icons are drawn in
 * colour; the returned spec says `template: false` and the consumer must not
 * call `setTemplateImage(true)` on it.
 *
 * ── WHAT THIS DOT DELIBERATELY DOES NOT SAY ────────────────────────────────
 *
 * It is a recency mark and nothing else. It does not say whether a scope is
 * finished, whether it is healthy, whether it is yours, or whether it is worth
 * opening — an old scope is not a stale one, the same refusal the standing
 * brief's missing pip records. And it carries no count: the number of saves is
 * the pulse strip's job, on one row, once.
 */

import {
  createCanvas, encodeRgbaPng, hexToRgb, paintShape,
} from './rgba-png.js';

/**
 * The canvas, in POINTS. 11pt square.
 *
 * Electron does not scale a menu item icon, so this is 11 points added to the
 * row — but a macOS menu reserves an icon gutter for every item as soon as one
 * item has an image, and the tray menu already has one (the pulse strip). So on
 * a menu that already carries the strip the marginal width of a row dot is the
 * amount by which 11pt exceeds the gutter the strip already opened, which is
 * nothing. THAT IS AN ASSUMPTION about NSMenu's layout, not a measurement; if
 * it is wrong the cost is 11pt on a ~260pt menu, or 4.2%.
 *
 * ── WHY IT IS ODD, WHICH IS NOT A ROUNDING CHOICE ──────────────────────────
 *
 * The first draft was 10pt and the suite caught it. A circle centred at
 * `size / 2` on an EVEN canvas is centred on a pixel CORNER, so it splits
 * symmetrically across four pixels and no pixel is fully covered. At 1x, where
 * a 1.2pt dot is 2.4 device pixels across, that means the mark has no opaque
 * pixel anywhere — every one of it is a partial-coverage rim, and a `cold` dot
 * that should be solid renders as a soft grey blur. On an ODD canvas the centre
 * is at 5.5, the middle of pixel 5, and the smallest filled dot has a solid
 * core again.
 *
 * The same reasoning decides the ring: at 1x, pixel 5 lies entirely inside
 * every ring's HOLE, so `renderRecencyDot('cool').buffer` has a genuinely
 * transparent centre rather than a half-covered smudge, and the disc/ring
 * distinction — the one that does not need colour — survives at 1x.
 *
 * 11pt also leaves 2.5pt of margin around the largest mark (r 3.0pt), which
 * stops the disc sitting flush against the gutter's edge.
 */
export const DOT_POINTS = 11;

/**
 * Every colour drawn by this module, per theme.
 *
 * MEASURED, NOT PICKED. Each value clears 3:1 (WCAG 2.2 1.4.11, the NON-TEXT
 * floor) against all three backgrounds of its theme's band in `rgba-png.js`'s
 * `MENU_BG_BAND`. Nominal / worst case:
 *
 *   LIGHT   hot  #0F5A2C   7.06 / 6.08
 *           mid  #9A5D06   4.51 / 3.88
 *           cold #7B7B82   3.56 / 3.06
 *
 *   DARK    hot  #4FD97F   7.67 / 6.25
 *           mid  #C89522   5.16 / 4.20
 *           cold #85858C   3.80 / 3.10
 *
 * Apple's own `systemGreen` `#34C759` was measured at about 1.8:1 against white
 * and is NOT here. A palette is not correct because a platform vendor ships it.
 *
 * ── THE LUMINANCE LADDER IS PART OF THE MEANING ────────────────────────────
 *
 * Within each theme the three contrast ratios are ordered hot > mid > cold, so
 * a warmer row is a HEAVIER mark. That is theme-independent even though the
 * direction is not: in a light menu heavier means darker, in a dark menu
 * heavier means brighter, and "more contrast against its own background" is the
 * single rule that expresses both. The suite asserts that ordering rather than
 * asserting a lightness, because a lightness assertion would be true in one
 * theme and inverted in the other.
 */
export const DOT_PALETTE = {
  light: { hot: '#0F5A2C', mid: '#9A5D06', cold: '#7B7B82' },
  dark: { hot: '#4FD97F', mid: '#C89522', cold: '#85858C' },
};

/**
 * The ink for each of `ageBucket()`'s five drawable states.
 *
 * `unknown` is ABSENT and that is the point: an age we do not have is not an
 * old one, so there is no mark for it and `renderRecencyDot` returns null. A
 * row with no age gets no dot at all rather than the coldest one — the same
 * rule as the save-status strip's dashed ring, where "we don't know" is not
 * step 0.
 *
 * `stroke` is the ring's wall thickness in points; a `null` stroke is a filled
 * shape. Radii and strokes are in points and scale with the representation, so
 * 1x and 2x are one drawing at two resolutions.
 */
export const DOT_INK = {
  live: { tone: 'hot', radius: 3.0, stroke: null },
  warm: { tone: 'hot', radius: 3.0, stroke: 1.2 },
  today: { tone: 'mid', radius: 2.5, stroke: 1.1 },
  cool: { tone: 'cold', radius: 2.0, stroke: 1.0 },
  cold: { tone: 'cold', radius: 1.2, stroke: null },
};

/** The order the ladder is asserted in — warmest first. Exported so the suite
 *  cannot quietly assert a different order from the one shipped. */
export const DOT_ORDER = ['live', 'warm', 'today', 'cool', 'cold'];

/**
 * Buckets that are DELIBERATELY not drawn — a WRITTEN case, not an omission.
 *
 * `ageBucket()` returns `'unknown'` for a row with no usable clock, and it is
 * the sixth thing it can return. If that case were merely absent from `DOT_INK`
 * the natural fallback would be the coldest dot, which would assert "old" about
 * a row whose own label says the time is unknown — this project's
 * fact-versus-absence collapse, in the direction that manufactures a fact.
 *
 * So it is listed, checked before anything else, and asserted on its own. An
 * unknown age gets NO MARK AT ALL, the same rule as the save-status strip's
 * dashed ring: "we don't know" is not step 0 of the ladder.
 */
export const NO_DOT_BUCKETS = ['unknown'];

/** The palette for a theme. Anything other than an explicit `dark: true` is
 *  LIGHT, because a missing option must resolve to something rather than to a
 *  crash inside a menu build. */
export function dotPalette(opts) {
  return (opts && opts.dark === true) ? DOT_PALETTE.dark : DOT_PALETTE.light;
}

/**
 * The ink area of one bucket's mark, in square points.
 *
 * Exported because it is the LADDER — the thing that carries the five states
 * when colour cannot — and a property that only a comment claims is a property
 * nothing checks.
 */
export function dotInkArea(bucket) {
  const ink = DOT_INK[bucket];
  if (!ink) return 0;
  const outer = Math.PI * ink.radius * ink.radius;
  if (ink.stroke === null) return outer;
  const inner = Math.max(0, ink.radius - ink.stroke);
  return outer - Math.PI * inner * inner;
}

/** The RGBA canvas for one bucket at one scale factor. */
export function dotCanvas(bucket, scale, palette) {
  const ink = DOT_INK[bucket];
  if (!ink) return null;
  const s = Number.isInteger(scale) && scale > 0 ? scale : 1;
  const canvas = createCanvas(DOT_POINTS * s, DOT_POINTS * s);

  const c = (DOT_POINTS / 2) * s;
  const outer = ink.radius * s;
  const inner = ink.stroke === null ? 0 : Math.max(0, ink.radius - ink.stroke) * s;

  paintShape(canvas, hexToRgb(palette[ink.tone]), (x, y) => {
    const dx = x - c, dy = y - c;
    const r2 = dx * dx + dy * dy;
    return r2 <= outer * outer && r2 >= inner * inner;
  });

  return canvas;
}

/**
 * The recency dot, as PNG bytes at 1x and 2x.
 *
 * @param {string} bucket  one of `ageBucket()`'s names
 * @param {{dark?:boolean}} [opts]  the CONSUMER supplies the theme; this module
 *   cannot read it, because Electron is the consumer's dependency and not this
 *   one's.
 * @returns {{buffer:Buffer, buffer2x:Buffer, widthPoints:number,
 *            heightPoints:number, template:false}|null}
 *   `null` for `unknown` and for anything this module does not recognise — a
 *   bucket name it has never heard of is an unknown age, not a cold one, and
 *   inventing a mark for it would be the fact-versus-absence collapse this
 *   whole widget is built to avoid.
 */
export function renderRecencyDot(bucket, opts) {
  // The written case, checked FIRST and before the ink lookup, so that "we do
  // not know when this was saved" can never fall through to a mark. See
  // NO_DOT_BUCKETS.
  if (NO_DOT_BUCKETS.includes(bucket)) return null;
  if (typeof bucket !== 'string' || !DOT_INK[bucket]) return null;
  const palette = dotPalette(opts);

  return {
    buffer: encodeRgbaPng(dotCanvas(bucket, 1, palette)),
    // TWO representations, not one: a 1x-only image is soft on every Mac sold
    // in the last decade, and a 2x-only image handed to a 1x display is
    // downsampled by the OS rather than drawn.
    buffer2x: encodeRgbaPng(dotCanvas(bucket, 2, palette)),
    widthPoints: DOT_POINTS,
    heightPoints: DOT_POINTS,
    // NOT a template image — see lib/rgba-png.js.
    template: false,
  };
}

/**
 * The tooltip line for a dot, so the colour is never the only way to learn what
 * it means.
 *
 * A legend that exists only in a design document is a legend the user does not
 * have. This returns the band in words; the consumer is free to append it to
 * the row's own tooltip, and the row's age text remains the exact figure.
 */
export function dotToolTipLine(bucket) {
  switch (bucket) {
    case 'live': return 'Being written right now.';
    case 'warm': return 'Saved within the last half hour.';
    case 'today': return 'Saved earlier today.';
    case 'cool': return 'Saved in the last week.';
    case 'cold': return 'Older than a week.';
    default: return null;
  }
}
