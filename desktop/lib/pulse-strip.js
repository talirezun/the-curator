/**
 * renderPulseStrip() — the save pulse, drawn as a COLOUR PNG for a menu item.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  WHY A STILL FRAME IN AN ICON GUTTER, AND NOT A LIVE GRAPH                ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * The maintainer asked for graphics in the menu. What AppKit will actually give
 * us was checked against the INSTALLED Electron 43.5.0 type definitions rather
 * than assumed, and it decides the whole shape of this file:
 *
 *  - `MenuItemConstructorOptions.icon?: NativeImage | string` EXISTS. So a menu
 *    item can carry a picture, drawn in the icon gutter to the LEFT of its
 *    title.
 *  - Electron performs NO SCALING on it — `item.image = icon.GetImage()
 *    .ToNSImage()` in electron_menu_controller.mm, with no resize anywhere. The
 *    image draws at its declared size and it WIDENS THE MENU. That is why the
 *    dimensions below are chosen against the menu's own width budget (see
 *    `MENU_CHAR_POINTS`) rather than picked for looks.
 *  - `NSMenuItem.setView:` — the API iStat Menus and Stats use to put a live,
 *    animating multi-band graph in a menu — is ABSENT from Electron. Zero
 *    matches in the whole surface. And an NSMenu is frozen at the AppKit level
 *    once it is open regardless.
 *
 * So the strip is A STILL FRAME, redrawn on each menu open. That is a stated
 * limitation of the platform we are on, not a bug to engineer around, and the
 * absolute "Updated HH:MM" stamp already in the menu is what makes a frame that
 * stopped being redrawn visible.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  IT IS NO LONGER A TEMPLATE IMAGE — THE CONSTRAINT WAS WRONG              ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * v3.37.0 shipped this as an alpha-only TEMPLATE image, reasoning by analogy
 * from `lib/tray-icon.js`: macOS takes only a template image's alpha and tints
 * it for the current context, which is the only thing that looks right on a
 * MENU BAR. That is true of the tray glyph. It is FALSE of a menu item's icon,
 * and the difference was settled by building a real Electron menu on this
 * machine rather than by argument: a full-colour RGBA icon in a menu item
 * renders in colour.
 *
 * The cost of the wrong constraint was visible in the shipped build. The strip
 * sits on a DISABLED row — it is a statement, not an action — so macOS tinted
 * it to the DISABLED TEXT colour, and the maintainer's verdict was "barely
 * visible, I don't know why it's in such a light colour". Nothing was wrong
 * with the drawing; every one of its pixels was being multiplied by a grey
 * chosen to say "you cannot click this".
 *
 * Both halves are fixed. The row becomes enabled (in `tray-menu.js`), and the
 * art becomes colour (here). The returned spec carries `template: false` so the
 * consumer cannot re-apply the tint out of habit; `desktop/main.js` must NOT
 * call `setTemplateImage(true)` on this image.
 *
 * ── THE CELL VOCABULARY IS THE LOAD-BEARING PART ───────────────────────────
 *
 * Three states, and they must be VISUALLY DISTINCT:
 *
 *   ACTIVE   solid axis + a VIOLET BAR, height by count  saves landed here
 *   EMPTY    solid axis, nothing above it                existed, nothing happened
 *   UNKNOWN  DOTTED axis, nothing above it               before the store existed
 *
 * ── THE AXIS IS WHAT MAKES THIS A TIMELINE AND NOT A CHART ─────────────────
 *
 * A continuous baseline runs the full width, and its own texture carries the
 * third state: SOLID where the store existed, DOTTED where it did not. That
 * turns the grey region from "damage" into "the timeline starts here" — a
 * statement about the axis rather than a mark in the data — and it is SHAPE,
 * not colour, so it survives with the palette removed. A DAY RULER two points
 * below it, with today's tick doubled, gives the strip a scale; without one, a
 * row of bars is a column chart, and a column chart of save counts invites
 * exactly the productivity reading this file refuses below.
 *
 * EMPTY AND UNKNOWN MUST NOT RENDER IDENTICALLY. Collapsing "nothing happened"
 * into "no data" is this project's named fact-versus-absence defect, and it is
 * not a corner case here: the maintainer's own store is about 3.5 days old
 * against a 7-day window, so roughly HALF this strip is UNKNOWN today. The
 * common case.
 *
 * Every cell is drawn, empties included. A strip that omits its empty cells
 * stops being a timeline and becomes a scatter of marks with no scale — the
 * empties are what make the spacing readable at this size.
 *
 * ── COLOUR IS NEVER THE ONLY SIGNAL ────────────────────────────────────────
 *
 * Every distinction this strip draws survives the colour being removed:
 * ACTIVE has a bar and the other two do not; UNKNOWN's axis is dotted where
 * EMPTY's is solid; the handover cap is a 2-point notch at the top of a bar,
 * which is a shape before it is a colour. The suite asserts all of that in the
 * ALPHA CHANNEL ALONE, with the palette thrown away.
 *
 * ── THE HEIGHT REFUSAL IS LIFTED, AND HERE IS WHY IT NO LONGER HOLDS ───────
 *
 * v3.37.0 refused to put the save count in the bar height, on the ground that a
 * rising and falling column chart reads as a productivity graph. That ground is
 * real and it is still respected below — but the SHIPPED alternative was a
 * five-rung COLOUR RAMP, which encodes the identical quantity in the one
 * channel that is illegible at three points of width. The refusal was therefore
 * being honoured in form and broken in substance: the same number was being
 * drawn, just invisibly.
 *
 * Worse, it did not work. `activeLevel` capped at FIVE saves and the
 * maintainer's twelve-hour cells hold 3 to 18, so the ramp sat pinned at
 * saturation and every active cell was the same dark green — a fence, which is
 * exactly what he reported.
 *
 * There were two honest positions — do not encode the count at all, or encode
 * it where it can be read — and this file now takes the second. The
 * progress-bar reading is defeated STRUCTURALLY rather than by refusal: the
 * baseline axis and the day ruler make the picture a TIME SERIES, and the label
 * beside it says *saves per 12 hours*, never *activity* and never *progress*.
 *
 * The ladder is LOG-ISH — 1 / 2–3 / 4–6 / 7–12 / 13+ saves drawn at 3 / 5 / 7 /
 * 9 / 12 points — because real twelve-hour counts run from 1 to about 20 and a
 * linear scale over that range spends most of its height on the difference
 * between a busy afternoon and a very busy one, which is the least interesting
 * comparison on the strip.
 *
 * ── WHAT THE HEIGHT MEANS, AND WHAT IT MUST NEVER BE READ AS ──────────────
 *
 * An ACTIVE cell's height rises with the NUMBER OF SAVES in that bucket. That
 * is a CADENCE measurement and nothing else.
 *
 * RECORDED REFUSAL: it must never encode, or be captioned as, anything readable
 * as QUALITY, PROGRESS or PRODUCTIVITY. More saves means an agent checkpointed
 * more often — a different capture rhythm, which is what
 * `claude-skills/curator-continuity` explicitly asks for ("save early and
 * often") — and a denser column absolutely does not mean a better day's work.
 * The label beside the strip therefore says "saves", never "activity" and never
 * "progress", and no legend anywhere ranks a tall column above a short one.
 *
 * ── THE ONE MARK THAT ANSWERS THE WIDGET'S PURPOSE ─────────────────────────
 *
 * An amber cap on a bar means THE HARNESS CHANGED inside that cell — a save
 * came from a different tool than the save before it in the same work-stream.
 * That is the only thing this widget draws which speaks directly to whether
 * context is being carried from harness to harness, which is the sentence the
 * whole feature is measured against. It is a boolean, never a count: two
 * handovers in twelve hours and one prompt the same action.
 */

import {
  createCanvas, fillRect, encodeRgbaPng, hexToRgb,
} from './rgba-png.js';

// ── Geometry, in POINTS ─────────────────────────────────────────────────────
//
// Every dimension is in points and multiplied by the scale factor, so the 1x
// and 2x representations are one drawing at two resolutions rather than two
// drawings that happen to look alike — the failure mode that makes a retina
// asset subtly not match its own low-resolution twin.

/** Bar width — 3pt, up from 2pt. Three device pixels at 1x and six at 2x. At
 *  2pt a bar is the narrowest thing that is not a hairline; at 3pt it is a
 *  bar. Paid for by drawing FEWER cells, not by taking more menu — see
 *  TARGET_CELLS. */
export const CELL_POINTS = 3;

/** The gap between bars. One point, so the pitch is 4pt. */
export const GAP_POINTS = 1;

/**
 * How many cells the strip DRAWS, at most.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  THE WIDTH ARITHMETIC, WHICH IS THE WHOLE REASON THIS CONSTANT EXISTS     ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * Electron does NOT scale a menu item icon, so every point of icon is a point
 * of menu width ADDED to the label beside it. The strip is therefore in direct
 * tension with the menu's own width target of ~260pt, and it is the only lever:
 * a per-row character budget cannot shrink a fixed-width image.
 *
 * BEFORE: 28 buckets x 3pt pitch = 83pt, 11pt tall, 2pt bars.
 * NOW:    14 cells   x 4pt pitch = 55pt, 14pt tall, 3pt bars.
 *
 *   width      83 -> 55pt          34% NARROWER
 *   height     11 -> 14pt          27% taller
 *   bar        2  -> 3pt           50% fatter
 *   ink/cell   18 -> 36pt²         TWICE the ink in an ACTIVE cell
 *
 * So the strip is more present and smaller at the same time, which is the only
 * honest way to answer "make it more present" inside a shrinking width budget.
 *
 * AGAINST THE 260pt TARGET, stated with its assumptions on the table:
 *
 *   menu chrome (leading inset + icon-to-title gap + trailing inset)   ~24pt  ASSUMED
 *   the strip                                                           55pt  exact
 *   the label "Save pulse · 7 days · 28 saves", 30 chars at 6.5pt      ~195pt ASSUMED
 *                                                                     ------
 *                                                                      274pt
 *
 * That is still 14pt over 260, and THE ICON IS NOT WHERE THE OVERAGE IS. The
 * label is 71% of that row; the picture is 20%. Cutting the strip to fit would
 * mean about 41pt, which is 10 cells — and the remaining 14pt would still have
 * to come out of a sentence that already carries two honesty disclosures. The
 * arithmetic is reported rather than forced, because forcing it would trade a
 * disclosure for 5% of a width target.
 *
 * ── WHAT MERGING COSTS, AND WHY 14 AND NOT 7 ───────────────────────────────
 *
 * The seven-day window and the six-hour bucket are the PRODUCER's contract and
 * are not touched. What changes is how many source buckets one drawn cell
 * covers: two, so a cell is twelve hours — morning and evening of each of seven
 * days, which is a timeline a person can read.
 *
 * SEVEN daily cells were considered and REFUSED, and the reason is the ramp
 * rather than the picture. Counts per six-hour bucket on a real store run 1..9,
 * which the five-rung ramp discriminates. Counts per DAY run 5..40, which pins
 * the ramp at saturation permanently — every working day would be the darkest
 * green, and the cadence reading, which is the only thing the colour carries,
 * would be gone. Twelve hours keeps counts in a range the ramp can speak about.
 */
export const TARGET_CELLS = 14;

/**
 * Total image height — 15pt, up from 14.
 *
 * The width half of the presence budget is argued at `TARGET_CELLS`. Height is
 * the cheap half: a macOS menu row accommodates a 16pt icon without growing, so
 * this is inside the row's existing height and costs ZERO points of width.
 *
 * The extra point over v3.38.0's 14 buys the DAY RULER, which is what stops the
 * bars reading as a bare column chart. The rows are laid out:
 *
 *     y 0..11    the bars, growing UP from the axis
 *     y 12       AXIS_Y   — the baseline, solid or dotted
 *     y 13       deliberately EMPTY, so the ruler cannot be misread as a
 *                thicker axis
 *     y 14       RULER_Y  — one tick per day, today's doubled
 */
export const HEIGHT_POINTS = 15;

/** The baseline row. Bars sit ON it and grow upward; it is the last row a bar
 *  can occupy plus one, i.e. a bar of height h covers [AXIS_Y - h, AXIS_Y). */
export const AXIS_Y = 12;

/** The day ruler, two rows below the axis with one blank row between. */
export const RULER_Y = 14;

/** The tallest a bar may be — the whole band above the axis. */
export const BAR_MAX_POINTS = 12;

/** Every axis and ruler mark is one point thick. Thicker and the axis starts
 *  competing with the bars it is supposed to sit under. */
export const RULE_THICKNESS = 1;

/**
 * The UNKNOWN axis is dotted at ONE DEVICE PIXEL on, one off.
 *
 * Deliberately in DEVICE pixels rather than points: at 2x a point-based dash
 * would be a 2-on-2-off pattern, which at this size reads as a slightly lighter
 * solid line rather than as a dotted one. In device pixels the texture is the
 * same texture at both scales, which is the whole reason the distinction
 * survives.
 */
export const UNKNOWN_DASH_PIXELS = 1;

/** The handover cap: the top 2 points of a bar, drawn in the cap colour. Two
 *  points because one is a hairline that disappears against the bar's own top
 *  edge, and three would start to look like a separate stacked segment. */
export const CAP_POINTS = 2;

// ── The cadence ramp ────────────────────────────────────────────────────────

/**
 * How many rungs the ACTIVE ladder has. Five, and they are HEIGHTS now rather
 * than shades — see the header for why the height refusal was lifted.
 */
export const ACTIVE_LEVELS = 5;

/**
 * The bar height, in points, for each rung.
 *
 * 3 / 5 / 7 / 9 / 12. The bottom rung is deliberately well clear of the axis
 * (which is 1pt) so ONE SAVE never reads as a thick baseline, and the top rung
 * jumps three points rather than two so a genuinely busy cell is separable at a
 * glance from a merely active one.
 */
export const BAR_HEIGHTS = [3, 5, 7, 9, 12];

/**
 * The rung for a bucket holding `count` saves, 1..ACTIVE_LEVELS.
 *
 * LOG-ISH: 1 / 2–3 / 4–6 / 7–12 / 13 or more. The boundaries are doubling-ish
 * rather than round, because the counts they have to separate are 1..20 and a
 * linear scale over that range puts four of its five rungs above 15 saves,
 * where nothing interesting happens.
 *
 * It SATURATES rather than running away, for the same reason the old ramp
 * capped: a pathological bucket must not be able to redefine what busy looks
 * like for the rest of the strip. See the header's RECORDED REFUSAL — this is
 * cadence, never quality. Called only for buckets known to hold ≥1 save.
 */
export function activeLevel(count) {
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 1;
  if (n <= 1) return 1;
  if (n <= 3) return 2;
  if (n <= 6) return 3;
  if (n <= 12) return 4;
  return ACTIVE_LEVELS;
}

/** The drawn height of a bucket holding `count` saves, in points. */
export function barHeightPoints(count) {
  return BAR_HEIGHTS[activeLevel(count) - 1];
}

// ── The palette ─────────────────────────────────────────────────────────────

/**
 * Every colour drawn by this module, per theme.
 *
 * MEASURED, NOT PICKED. Each value clears 3:1 (WCAG 2.2 1.4.11, the NON-TEXT
 * floor — 4.5:1 is the text floor and citing it here would be citing the wrong
 * rule) against all three backgrounds of its theme's band in
 * `rgba-png.js`'s `MENU_BG_BAND`, worst case quoted:
 *
 *   LIGHT (worst of #F6F6F6 / #ECECEC / #DCDCDC)
 *     bar   #5127B4  violet-700     6.66
 *     axis  #6B6B80  neutral        3.79
 *     cap   #8A5F19  attention      4.10
 *
 *   DARK (worst of #1E1E1E / #2C2C2E / #3A3A3C)
 *     bar   #9D80F8  violet-400     3.72
 *     axis  #8C8C9C  neutral        3.43
 *     cap   #EDBB63  summary-400    6.43
 *
 * `scripts/test-tray-paint.js` recomputes every one of those from the values
 * shipped here and fails on any that falls short, with controls proving the
 * check can fail — Apple's `systemGreen` on light, `violet-400` on light and
 * `violet-700` on dark are all required to FAIL. The numbers in this comment
 * are therefore a convenience, not the guarantee.
 *
 * ── ONE COLOUR FOR THE BARS, AND IT IS VIOLET ──────────────────────────────
 *
 * The count moved into the HEIGHT, so the five-rung ramp is gone and the bars
 * are a single hue. Violet, for two reasons that pull the same way.
 *
 * The design system reserves violet for IDENTITY AND ACTION and forbids it as a
 * DATA TYPE — and a save is The Curator's own activity, not a data type, so the
 * reservation is being honoured rather than bent. And it stops the strip
 * reading as the wiki's green "concept" marker, which is a different thing in
 * the same product.
 *
 * ── THE AXIS AND THE BARS ARE THE SAME INK IN THE ALPHA CHANNEL ────────────
 *
 * The axis clears the floor by itself, so the "did the store exist" reading is
 * available to a viewer who sees no colour at all — the distinction it carries
 * is SOLID versus DOTTED, which is texture, and the per-pixel contrast is
 * identical on both sides of it by construction.
 */
export const STRIP_PALETTE = {
  light: { bar: '#5127B4', axis: '#6B6B80', cap: '#8A5F19' },
  dark: { bar: '#9D80F8', axis: '#8C8C9C', cap: '#EDBB63' },
};

/** The palette for a theme. Anything other than an explicit `dark: true` is
 *  LIGHT, because a missing option must resolve to something rather than to a
 *  crash inside a menu build. */
export function stripPalette(opts) {
  return (opts && opts.dark === true) ? STRIP_PALETTE.dark : STRIP_PALETTE.light;
}

// ── The cells ───────────────────────────────────────────────────────────────

/**
 * Turn a `pulse` record's buckets into the cell vocabulary.
 *
 * The input is treated as UNTRUSTED for the same reason `tray-model.js` treats
 * `getTraySummary()` as untrusted: it is produced by another module, and a
 * menubar that throws is a menubar that is simply absent with no error anywhere
 * a user will look. A missing `firstKnownBucket` means "we have no reason to
 * believe any bucket predates the store", which is 0 — the reading that claims
 * the LEAST.
 *
 * @param {object} pulse
 * @returns {Array<{index:number, state:'active'|'empty'|'unknown', count:number,
 *                  level:number, changed:boolean}>}
 */
export function pulseCells(pulse) {
  const buckets = pulse && Array.isArray(pulse.buckets) ? pulse.buckets : null;
  if (!buckets || !buckets.length) return [];

  const rawFirst = pulse.firstKnownBucket;
  const first = Number.isFinite(rawFirst) && rawFirst > 0
    ? Math.min(Math.floor(rawFirst), buckets.length)
    : 0;

  // Optional and read defensively: a producer that does not compute handovers
  // must cost the CAPS and never the strip. Absent means "no handover is
  // known", which draws nothing — the reading that claims the least.
  const flags = Array.isArray(pulse.harnessChanges) ? pulse.harnessChanges : null;

  return buckets.map((b, index) => {
    const count = Number.isFinite(b) && b > 0 ? Math.floor(b) : 0;
    // A cap is drawn ON a bar, so it is meaningless without one. An UNKNOWN or
    // EMPTY cell carrying a change flag is a producer contradicting itself —
    // a handover implies a save — and the honest response is to draw the cell
    // as its own state says, not to invent a bar to hang a cap on.
    const changed = !!(flags && flags[index] === true);
    if (index < first) return { index, state: 'unknown', count: 0, level: 0, changed: false };
    if (count > 0) return { index, state: 'active', count, level: activeLevel(count), changed };
    return { index, state: 'empty', count: 0, level: 0, changed: false };
  });
}

/**
 * How many SOURCE buckets one DRAWN cell covers.
 *
 * The smallest exact divisor of the bucket count that brings the drawn count to
 * `TARGET_CELLS` or fewer. Exact, because a ragged final cell would cover a
 * different span from every other cell while looking identical to them, which
 * is a picture that lies about its own scale.
 *
 * FAILS SAFE TO 1. A bucket count with no useful divisor — a prime, say —
 * would otherwise fold the whole week into one or two cells, which is a worse
 * drawing than a wide one. So a factor that leaves fewer than `MIN_CELLS` cells
 * is rejected and the strip simply draws every bucket and is wider. The
 * producer emits 28 today; this exists so a producer that one day emits
 * something else degrades in the direction of showing MORE rather than less.
 */
export const MIN_CELLS = 4;
export function mergeFactor(bucketCount) {
  const n = Number.isInteger(bucketCount) && bucketCount > 0 ? bucketCount : 0;
  if (!n || n <= TARGET_CELLS) return 1;
  for (let f = 2; f <= n; f++) {
    if (n % f !== 0) continue;
    const cells = n / f;
    if (cells <= TARGET_CELLS) return cells >= MIN_CELLS ? f : 1;
  }
  return 1;
}

/**
 * Fold `factor` source cells into one drawn cell.
 *
 * ── THE UNKNOWN RULE IS THE ONE THAT COULD LIE ─────────────────────────────
 *
 * A drawn cell is UNKNOWN only when EVERY source bucket it covers is unknown.
 * The alternative — unknown if ANY source is — would grey a half-known cell and
 * claim the store is younger than it is, which is the fact-versus-absence
 * collapse running in the direction that hides real saves. If any source is
 * known, the cell is known; if any known source holds saves, it is ACTIVE and
 * carries their SUM; otherwise it is EMPTY.
 *
 * The consequence is disclosed rather than hidden: a boundary cell that is
 * half before the store's beginning reads as an ordinary known cell. That is
 * the reading that claims LESS about how young the store is, and the label's
 * "N days known" is still computed at SOURCE granularity, so the sentence
 * beside the picture keeps the finer number.
 */
export function mergeCells(cells, factor) {
  const f = Number.isInteger(factor) && factor > 1 ? factor : 1;
  if (f === 1) return cells;
  const out = [];
  for (let i = 0; i < cells.length; i += f) {
    const group = cells.slice(i, i + f);
    const count = group.reduce((n, c) => n + c.count, 0);
    // A handover ANYWHERE in the group makes the drawn cell a handover cell.
    // OR and not AND, and it is the same argument as the unknown rule above run
    // the other way: a handover that happened is a fact, and folding two source
    // buckets together must not be able to erase one.
    const changed = group.some((c) => c.changed === true);
    const index = out.length;
    if (group.every((c) => c.state === 'unknown')) {
      out.push({ index, state: 'unknown', count: 0, level: 0, changed: false });
    } else if (count > 0) {
      out.push({ index, state: 'active', count, level: activeLevel(count), changed });
    } else {
      out.push({ index, state: 'empty', count: 0, level: 0, changed: false });
    }
  }
  return out;
}

/** The cells actually DRAWN: the producer's buckets, folded to fit the width
 *  budget. `pulseCells` stays raw so the source granularity is still testable
 *  and still available to anything that wants it. */
export function drawnCells(pulse) {
  const cells = pulseCells(pulse);
  return mergeCells(cells, mergeFactor(cells.length));
}

/** The span one DRAWN cell covers, in seconds — the producer's bucket times the
 *  merge factor. The tooltip quotes this and not `bucketSeconds`, because the
 *  legend must describe the picture the user is looking at. */
export function drawnBucketSeconds(pulse) {
  const b = pulse && Number.isFinite(pulse.bucketSeconds) && pulse.bucketSeconds > 0
    ? pulse.bucketSeconds : 0;
  const n = pulse && Array.isArray(pulse.buckets) ? pulse.buckets.length : 0;
  return b * mergeFactor(n);
}

/**
 * The BAR for one cell — its colour, the band of rows it occupies, and whether
 * it carries a handover cap. `null` for a cell that draws no bar at all.
 *
 * Split out so the suite can assert the height ladder without decoding a PNG,
 * and so the ladder exists in exactly one place. EMPTY and UNKNOWN return null
 * here and are drawn entirely by the AXIS — see `axisTextureAt`.
 */
export function cellInk(cell, palette) {
  if (!cell || cell.state !== 'active') return null;
  const height = BAR_HEIGHTS[cell.level - 1];
  return {
    hex: palette.bar,
    // Bars grow UP from the axis, so a taller bar starts higher.
    top: AXIS_Y - height,
    height,
    cap: cell.changed === true ? { hex: palette.cap, height: Math.min(CAP_POINTS, height) } : null,
  };
}

/**
 * Is the axis DRAWN at this device pixel?
 *
 * Solid under a known cell, dotted under an unknown one. `x` is in device
 * pixels of the finished canvas, so the dash is one device pixel at every
 * scale — see UNKNOWN_DASH_PIXELS for why that is not a point measurement.
 *
 * The gaps BETWEEN cells take the texture of the cell to their left, so a run
 * of unknown cells is one continuous dotted line rather than dashes separated
 * by solid gaps.
 */
function axisTextureAt(cells, x, s) {
  const pitch = (CELL_POINTS + GAP_POINTS) * s;
  const i = Math.min(Math.floor(x / pitch), cells.length - 1);
  const cell = cells[i];
  if (!cell || cell.state !== 'unknown') return true;
  return Math.floor(x / UNKNOWN_DASH_PIXELS) % 2 === 0;
}

/**
 * How many DRAWN cells make one day, for the ruler.
 *
 * DERIVED from the span a drawn cell actually covers, never hardcoded to 2. The
 * strip folds the producer's buckets to fit its width budget, and it falls back
 * to drawing them unfolded when no exact divisor is available (see
 * `mergeFactor`) — so a ruler that assumed twelve-hour cells would silently
 * mark every twelve hours as a day on the fallback path, which is a scale that
 * lies by a factor of two.
 *
 * Returns 0 when the span is unknown or does not divide the day, and the ruler
 * is then simply not drawn: a scale nobody can trust is worse than none.
 */
export function cellsPerDay(pulse) {
  const span = drawnBucketSeconds(pulse);
  if (!Number.isFinite(span) || span <= 0) return 0;
  const n = 86400 / span;
  return Number.isInteger(n) && n >= 1 ? n : 0;
}

/**
 * The RGBA canvas for one scale factor.
 *
 * Every mark is opaque — every shape here is a rectangle on integer boundaries,
 * so there is no rim to antialias and no partial alpha anywhere in the strip.
 * That is what lets the suite assert a contrast ratio against a decoded pixel
 * without compositing anything.
 *
 * @param {Array} cells       drawn cells
 * @param {number} scale      1 or 2
 * @param {object} palette
 * @param {number} [perDay]   drawn cells per day; 0 draws no ruler
 */
export function stripCanvas(cells, scale, palette, perDay = 0) {
  const s = Number.isInteger(scale) && scale > 0 ? scale : 1;
  const pitch = CELL_POINTS + GAP_POINTS;
  const width = (cells.length * pitch - GAP_POINTS) * s;
  const canvas = createCanvas(width, HEIGHT_POINTS * s);
  const axisRgb = hexToRgb(palette.axis);

  // ── THE AXIS FIRST, THE FULL WIDTH ──────────────────────────────────────
  //
  // Drawn per device pixel rather than per cell, because its texture changes
  // WITHIN a run: it has to be continuous across the gaps between cells or it
  // reads as fourteen ticks rather than as one timeline.
  for (let x = 0; x < width; x++) {
    if (!axisTextureAt(cells, x, s)) continue;
    fillRect(canvas, x, AXIS_Y * s, 1, RULE_THICKNESS * s, axisRgb);
  }

  // ── THE DAY RULER ───────────────────────────────────────────────────────
  //
  // One tick at each day boundary, and TODAY'S IS DOUBLE WIDTH so "the last
  // day" is findable without counting cells. Ticks are laid out backwards from
  // the newest cell, not forwards from the oldest: the newest edge is the one
  // anchored to `now` (see computePulse), so counting from the old end would
  // put the doubled tick a fraction of a day off whenever the window does not
  // divide evenly.
  if (perDay >= 1) {
    for (let i = cells.length - perDay; i >= 0; i -= perDay) {
      const last = i + perDay >= cells.length;
      fillRect(canvas, i * pitch * s, RULER_Y * s,
        (last ? 2 : 1) * s, RULE_THICKNESS * s, axisRgb);
    }
  }

  // ── THE BARS, AND THEIR CAPS ────────────────────────────────────────────
  cells.forEach((cell, i) => {
    const ink = cellInk(cell, palette);
    if (!ink) return;
    const x = i * pitch * s;
    fillRect(canvas, x, ink.top * s, CELL_POINTS * s, ink.height * s, hexToRgb(ink.hex));
    // Painted OVER the bar's own top rows — `paintPixel` replaces rather than
    // composites, which is exactly what is wanted: the cap is the top of the
    // bar in a different ink, not a translucent overlay whose colour would
    // depend on what is under it.
    if (ink.cap) {
      fillRect(canvas, x, ink.top * s, CELL_POINTS * s, ink.cap.height * s,
        hexToRgb(ink.cap.hex));
    }
  });

  return canvas;
}

/**
 * The strip, as PNG bytes at 1x and 2x.
 *
 * Returns `null` — never an empty image — when there is no pulse to draw, so
 * the menu simply has no strip item rather than an item carrying a blank
 * rectangle. An absent measurement and a measurement of nothing are different
 * things, which is the same rule the rest of this widget runs on.
 *
 * @param {object|null} pulse
 * @param {{dark?:boolean}} [opts]  the CONSUMER supplies the theme; this module
 *   cannot read it, because Electron is the consumer's dependency and not this
 *   one's, and a module that guessed the appearance would be a second opinion
 *   about it.
 * @returns {{buffer:Buffer, buffer2x:Buffer, widthPoints:number,
 *            heightPoints:number, template:false}|null}
 */
export function renderPulseStrip(pulse, opts) {
  if (!pulse || typeof pulse !== 'object') return null;
  const cells = drawnCells(pulse);
  if (!cells.length) return null;
  const palette = stripPalette(opts);
  const perDay = cellsPerDay(pulse);

  return {
    buffer: encodeRgbaPng(stripCanvas(cells, 1, palette, perDay)),
    // TWO representations, not one: a 1x-only image is soft on every Mac sold
    // in the last decade, and a 2x-only image handed to a 1x display is
    // downsampled by the OS rather than drawn.
    buffer2x: encodeRgbaPng(stripCanvas(cells, 2, palette, perDay)),
    widthPoints: cells.length * (CELL_POINTS + GAP_POINTS) - GAP_POINTS,
    heightPoints: HEIGHT_POINTS,
    // NOT a template image. Present on the spec so the consumer never has to
    // remember which of this folder's images are tinted by macOS and which are
    // drawn as they are — the confusion that produced the "barely visible"
    // report in the first place.
    template: false,
  };
}

// ── The words beside the picture ────────────────────────────────────────────

/** A duration in seconds as the coarsest honest unit. Used only for spans this
 *  strip actually draws (hours to a week), so it stops at days deliberately. */
function spanText(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const h = Math.round(seconds / 3600);
  if (h < 1) return null;
  if (h < 48) return h + (h === 1 ? ' hour' : ' hours');
  const d = Math.round(h / 24);
  return d + (d === 1 ? ' day' : ' days');
}

/** The whole window, as words. */
function windowText(pulse) {
  return spanText(pulse && pulse.windowSeconds) || 'the recent past';
}

/**
 * How many buckets the strip can actually speak about.
 *
 * `firstKnownBucket` is allowed to equal the bucket COUNT — that is what the
 * producer emits when nothing was counted at all, and it correctly greys every
 * cell. So this can legitimately be 0, and 0 known buckets is not the same
 * claim as an empty week; see `pulseLabel`.
 */
function knownBuckets(pulse) {
  const buckets = Array.isArray(pulse.buckets) ? pulse.buckets.length : 0;
  const first = Number.isFinite(pulse.firstKnownBucket) && pulse.firstKnownBucket > 0
    ? Math.min(Math.floor(pulse.firstKnownBucket), buckets) : 0;
  return buckets - first;
}

/** The span the strip can actually speak about. This is a MEASUREMENT of what
 *  is drawn, not an estimate of when the store was created — it is
 *  bucket-aligned, and the label says "known" rather than naming a moment, so
 *  it never claims a precision the 6-hour buckets do not have. */
function knownText(pulse) {
  const bucketSeconds = Number.isFinite(pulse.bucketSeconds) && pulse.bucketSeconds > 0
    ? pulse.bucketSeconds : 0;
  return spanText(knownBuckets(pulse) * bucketSeconds);
}

/**
 * The reading, in words — the sentence a user reads to decide whether to trust
 * the picture.
 *
 * ── EVERY HONESTY FIELD IS DISCLOSED IN THE LABEL, NOT HIDDEN IN THE TOOLTIP ─
 *
 * Two of the producer's fields say the drawing is less than it looks, and both
 * change the LABEL rather than only the tooltip, because a caveat a user has to
 * hover to find is a caveat that arrives after they have already believed the
 * picture:
 *
 *  - `coversWholeWindow: false` — the strip does not span its own window. The
 *    label then names the span it DOES cover ("4 days known") instead of the
 *    window, so the headline number is never attached to a period the strip
 *    cannot speak about.
 *  - `pairsTruncated > 0` — some (scope, machine) pairs were not read, so the
 *    count is a FLOOR. "at least 65 saves" is the exact meaning of a floor and
 *    costs nine characters; a bare "65 saves" would be a claim the producer
 *    explicitly declined to make.
 *
 * And `clock: 'none'` means there is no clock behind any of it, which is not a
 * caveat on a reading — it is the absence of one, so it replaces the sentence
 * rather than qualifying it.
 *
 * Length is a design constraint here, not an afterthought: this item sits near
 * the top of a menu whose width is a standing concern, and its icon already
 * costs about 83 points. The suite measures that this item is not the widest
 * thing in the menu.
 */
export function pulseLabel(pulse) {
  if (!pulse || typeof pulse !== 'object') return null;

  if (pulse.clock !== 'agent') {
    // No agent clock anywhere in the store. There is no reading to qualify.
    return 'Save pulse · no save times recorded';
  }

  const events = Number.isFinite(pulse.events) && pulse.events > 0 ? Math.floor(pulse.events) : 0;
  const partial = pulse.coversWholeWindow === false;
  const floor = Number.isFinite(pulse.pairsTruncated) && pulse.pairsTruncated > 0;

  // ── NOT ONE BUCKET IS KNOWN, WHICH IS NOT AN EMPTY WEEK ────────────────
  //
  // `firstKnownBucket` may equal the bucket count: the producer emits that when
  // nothing was counted at all, and every cell is drawn UNKNOWN. Falling
  // through to the ordinary sentence here would caption an entirely grey strip
  // "7 days · no saves" — a confident statement about a week this reading knows
  // nothing about, and the exact fact-versus-absence collapse the three cell
  // states exist to prevent. Caught before any period is named.
  if (knownBuckets(pulse) === 0) return 'Save pulse · nothing recorded yet';

  const span = (partial ? knownText(pulse) : null);
  const period = span ? span + ' known' : windowText(pulse);

  // A COVERED window with no events is a REACHABLE and DIFFERENT picture: a
  // dormant store whose oldest save predates the window, every cell EMPTY and
  // none UNKNOWN. It says a quiet week, and it must not read like a young one.
  if (events === 0) return 'Save pulse · ' + period + ' · no saves';

  const count = (floor ? 'at least ' : '') + events + (events === 1 ? ' save' : ' saves');
  return 'Save pulse · ' + period + ' · ' + count + toolsClause(pulse);
}

/**
 * ` · N tools`, and ONLY when N is greater than one.
 *
 * ── THE CHEAP SUBSTITUTE FOR PER-HARNESS LANES, AND THAT IS DELIBERATE ─────
 *
 * Two lanes inside a 15-point image give seven points each, and the bar ladder
 * needs twelve. Lanes would also need a legend, and a legend in an NSMenu is
 * another disabled row on the surface with the least vertical space in the
 * product. So the fact that MORE THAN ONE TOOL wrote this week is stated in
 * words instead, and the tooltip names them.
 *
 * ── WHY IT IS SILENT AT ONE, AND SILENT AT ZERO ────────────────────────────
 *
 * ` · 1 tool` is a token on every row of every single-tool store — the
 * drop-constant rule, which this file's own label already obeys twice. And
 * ZERO is not a measurement of tools, it is the absence of one: a store whose
 * saves named no harness has not told us how many tools wrote it, and printing
 * `0 tools` would answer a question the data declined to answer.
 */
function toolsClause(pulse) {
  const n = Number.isFinite(pulse && pulse.harnessCount) ? Math.floor(pulse.harnessCount) : 0;
  return n > 1 ? ' · ' + n + ' tools' : '';
}

/**
 * The strip's tooltip: the legend, plus every field the label had to compress.
 *
 * Nothing the label drops may become unreachable — the same rule the row labels
 * are held to. `eventsOutsideWindow` lives ONLY here, deliberately: older saves
 * existing is ordinary history rather than a reason to distrust the drawing, so
 * it does not earn room in a menu label, but a user counting saves must be able
 * to find out that the window is a window.
 */
export function pulseToolTip(pulse) {
  if (!pulse || typeof pulse !== 'object') return null;
  const lines = [];

  // The DRAWN span, not the producer's bucket: the legend must describe the
  // picture in front of the reader. Two six-hour buckets are drawn as one
  // twelve-hour cell (see TARGET_CELLS), and a legend saying "per 6 hours"
  // beside a 12-hour cell would be precisely wrong.
  lines.push('Saves per ' + (spanText(drawnBucketSeconds(pulse)) || 'bucket') +
    ', oldest on the left.');
  // The legend names every mark and RANKS NOTHING. See the header's recorded
  // refusal: a taller column is a different cadence, not a better day. It names
  // the SHAPE of each mark as well as its colour, because a legend that reads
  // "violet means saves" is useless to the viewer who most needs it.
  lines.push('Bar height = how many saves · solid baseline = this store existed · dotted baseline = it did not yet');
  lines.push('An amber cap means a different agent tool took over inside that period.');
  const tools = Number.isFinite(pulse.harnessCount) ? Math.floor(pulse.harnessCount) : 0;
  if (tools > 1) lines.push(tools + ' different agent tools wrote inside this window.');
  if (Number.isFinite(pulse.bucketSeconds) && pulse.bucketSeconds > 0
      && cellsPerDay(pulse) >= 1) {
    lines.push('The ticks below the baseline are day boundaries; the wide one is today.');
  }

  const events = Number.isFinite(pulse.events) ? pulse.events : null;
  if (events !== null) {
    lines.push(events + ' save' + (events === 1 ? '' : 's') + ' in ' + windowText(pulse) + '.');
  }
  if (pulse.coversWholeWindow === false) {
    const span = knownText(pulse);
    lines.push('This store is younger than the window' +
      (span ? '; only the last ' + span + ' is known.' : '.'));
  }
  if (Number.isFinite(pulse.pairsTruncated) && pulse.pairsTruncated > 0) {
    lines.push('Counted ' + (Number.isFinite(pulse.pairsCounted) ? pulse.pairsCounted : '?') +
      ' work-streams; ' + pulse.pairsTruncated +
      ' more were not read, so the count is a floor.');
  }
  if (Number.isFinite(pulse.eventsOutsideWindow) && pulse.eventsOutsideWindow > 0) {
    lines.push(pulse.eventsOutsideWindow + ' older save' +
      (pulse.eventsOutsideWindow === 1 ? ' falls' : 's fall') + ' outside this window.');
  }
  if (typeof pulse.oldestEventAt === 'string' && pulse.oldestEventAt) {
    lines.push('Oldest save seen: ' + pulse.oldestEventAt);
  }
  if (pulse.clock !== 'agent') {
    lines.push('No agent clock is recorded for these saves.');
  }
  return lines.join('\n');
}

/**
 * An ESTIMATE of the average advance of the system menu font, in points.
 *
 * STATED AS AN ASSUMPTION, because nothing here has ever been rendered: no menu
 * has been built, no font has been measured, and there is no width API in
 * Electron or in AppKit's maximum direction to ask. It exists so the suite can
 * check that the strip item does not become the widest thing in a menu whose
 * width is a standing concern — an argument carried out in numbers, which is
 * worth more than an argument carried out in adjectives, and less than a
 * measurement, which is not available.
 */
export const MENU_CHAR_POINTS = 6.5;
