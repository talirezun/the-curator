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
 *   live    full disc,  r 5.0pt      78.5pt² of ink
 *   warm    ¾ disc,     r 5.0pt      58.9
 *   today   ½ disc,     r 5.0pt      39.3
 *   cool    ¼ disc,     r 5.0pt      19.6
 *   cold    filled dot, r 2.0pt      12.6
 *
 * Strictly decreasing, and the suite asserts it from the shipped geometry
 * rather than from this comment.
 *
 * ── A DRAINING CLOCK, AND WHY IT REPLACED THE RINGS ────────────────────────
 *
 * The shipped ladder was a full disc and then three RINGS separated by 0.5pt of
 * radius. At 1x that is ONE DEVICE PIXEL between `warm`, `today` and `cool` —
 * three of the five states, differing by a pixel, inside an 11pt box whose
 * largest mark was a 6pt drawing. The ladder existed in the arithmetic and not
 * on the screen.
 *
 * A SECTOR carries the same ordering at a size a person can see: the disc
 * drains anticlockwise from full, through three-quarters, half and a quarter,
 * to a small solid dot. Every step is a quarter of the circle — a difference
 * measured in whole quadrants rather than in pixels — and the shape reads as
 * a quantity even in a thumbnail.
 *
 * `live` is the one state whose recognition changes what a person does next
 * (something is being written RIGHT NOW), and it is the only complete disc, so
 * it is separable from everything else without reference to colour at all.
 * `cold` returns to a filled shape at 16% of `live`'s area, which no viewer
 * will confuse with it, and which keeps the coldest state from being a sliver
 * that reads as damage.
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
 * ── 11 -> 13, AND THE BOX GREW BECAUSE THE MARK HAD TO ─────────────────────
 *
 * The sector ladder needs a circle large enough that a quarter of it is still
 * a shape. At r 3.0 in an 11pt box, a quarter-disc is a 3x3-point wedge — nine
 * square points at 1x, which is a smudge. 13pt takes the radius to 5.0 and the
 * quarter-disc to 19.6pt², and still leaves 1.5pt of margin so the full disc is
 * not flush against the gutter's edge.
 *
 * The odd-canvas argument is unchanged and is why it is 13 and not 12 or 14:
 * the centre lands at 6.5, the middle of pixel 6, so `cold`'s small filled dot
 * has a solid core and the sector boundaries fall on the centre pixel rather
 * than between two of them.
 */
export const DOT_POINTS = 13;

/**
 * Every colour drawn by this module, per theme.
 *
 * MEASURED, NOT PICKED. Each value clears 3:1 (WCAG 2.2 1.4.11, the NON-TEXT
 * floor) against all three backgrounds of its theme's band in `rgba-png.js`'s
 * `MENU_BG_BAND`. Worst of the three:
 *
 *   LIGHT   hot  #15704F   4.42     teal, the design system's success hue
 *           mid  #8A5F19   4.10     attention
 *           cold #6B6B80   3.79     neutral
 *
 *   DARK    hot  #4FD3A4   6.05     teal-400
 *           mid  #EDBB63   6.43     summary-400
 *           cold #A8A8BC   4.86     ink-200
 *
 * Apple's own `systemGreen` `#34C759` was measured at about 1.6:1 against a
 * light menu and is NOT here. A palette is not correct because a platform
 * vendor ships it, and that value is kept as the suite's anti-vacuity control.
 *
 * ── THE LUMINANCE LADDER IS NO LONGER THE WEIGHT LADDER, AND SHOULD NOT BE ─
 *
 * This module used to require `hot > mid > cold` in contrast, so that a warmer
 * row was a HEAVIER mark. That was the right rule when all five marks were
 * nearly the same size and colour was doing the work of the ladder.
 *
 * The sector geometry above now carries weight explicitly — 78.5pt² of ink down
 * to 12.6, a 6:1 range — and it does so in the ALPHA CHANNEL, where it survives
 * a viewer who cannot resolve the colours at all. Ranking the palette by
 * contrast on top of that would be a second, far weaker ladder pointed at the
 * same fact, and it would rule out the design system's own hues for a reason
 * that no longer holds: in dark, `summary-400` (6.43) is brighter than
 * `teal-400` (6.05), and nothing about that makes `today` read heavier than
 * `warm` when `warm` is drawn with 50% more ink.
 *
 * So the palette's requirement is a FLOOR, not an ordering, and the suite
 * asserts the ink ladder instead — see `dotInkArea` and the alpha-only section.
 */
export const DOT_PALETTE = {
  light: { hot: '#15704F', mid: '#8A5F19', cold: '#6B6B80' },
  dark: { hot: '#4FD3A4', mid: '#EDBB63', cold: '#A8A8BC' },
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
 * `turns` is the FRACTION OF THE DISC that is drawn, from 1 (whole) down to
 * 0.25 (a quadrant). The disc drains anticlockwise from the top-right, so the
 * bottom-left quadrant — the last one standing — is the one `cool` keeps.
 * Radii are in points and scale with the representation, so 1x and 2x are one
 * drawing at two resolutions rather than two drawings that happen to look
 * alike.
 */
export const DOT_INK = {
  live: { tone: 'hot', radius: 5.0, turns: 1 },
  warm: { tone: 'hot', radius: 5.0, turns: 0.75 },
  today: { tone: 'mid', radius: 5.0, turns: 0.5 },
  cool: { tone: 'cold', radius: 5.0, turns: 0.25 },
  // The ONE state that is not a sector. A one-eighth wedge would be a sliver
  // that reads as a rendering fault rather than as a quantity, so the coldest
  // mark returns to a solid shape at 16% of `live`'s area — small, definite,
  // and unmistakable for the full disc.
  cold: { tone: 'cold', radius: 2.0, turns: 1 },
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
  // A sector's area is its fraction of the whole disc, exactly. There is no
  // approximation here and no rim to account for: the boundaries are two radii
  // and an arc, and `paintShape` antialiases the arc without changing the area
  // the geometry describes.
  return ink.turns * Math.PI * ink.radius * ink.radius;
}

/**
 * Is (dx, dy) inside the drawn part of a `turns` sector?
 *
 * The disc DRAINS ANTICLOCKWISE FROM THE TOP-RIGHT — quadrant order top-right,
 * top-left, bottom-left, bottom-right in the sense a clock hand sweeps
 * backwards — so `0.75` loses the top-right, `0.5` keeps the bottom half, and
 * `0.25` keeps the bottom-left.
 *
 * Quadrant-aligned by construction rather than by an angle comparison: every
 * shipped value is a whole quarter, and testing signs of dx/dy is exact where
 * an `atan2` against a floating-point boundary is not — a sector edge landing a
 * hair either side of a pixel centre is what makes a half-disc's straight edge
 * look wobbly.
 *
 * Note the screen's y axis points DOWN, so "above the centre" is `dy < 0`.
 */
function inSector(dx, dy, turns) {
  if (turns >= 1) return true;
  const top = dy < 0, right = dx > 0;
  if (turns >= 0.75) return !(top && right);          // lose the top-right
  if (turns >= 0.5) return !top;                      // keep the bottom half
  return !top && !right;                              // keep the bottom-left
}

/** The RGBA canvas for one bucket at one scale factor. */
export function dotCanvas(bucket, scale, palette) {
  const ink = DOT_INK[bucket];
  if (!ink) return null;
  const s = Number.isInteger(scale) && scale > 0 ? scale : 1;
  const canvas = createCanvas(DOT_POINTS * s, DOT_POINTS * s);

  const c = (DOT_POINTS / 2) * s;
  const outer = ink.radius * s;

  paintShape(canvas, hexToRgb(palette[ink.tone]), (x, y) => {
    const dx = x - c, dy = y - c;
    if (dx * dx + dy * dy > outer * outer) return false;
    return inSector(dx, dy, ink.turns);
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
