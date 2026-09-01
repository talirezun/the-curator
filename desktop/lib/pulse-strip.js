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
 *   ACTIVE   full-height bar, GREEN, weight by cadence   saves landed here
 *   EMPTY    short grey stub on the baseline             existed, nothing happened
 *   UNKNOWN  grey hairline on the baseline               before the store existed
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
 * ── COLOUR IS NEVER THE ONLY SIGNAL, AND THAT IS A CHANGE FROM v3.37.0 ─────
 *
 * The shipped strip separated ACTIVE from EMPTY by OPACITY ALONE — same bar,
 * same height, different alpha — and separated EMPTY from UNKNOWN by shape. In
 * colour, "different alpha" becomes "different colour", and this project's
 * standing rule is that colour is never the only carrier of a distinction. So
 * the ACTIVE/EMPTY pair gains a second signal: ACTIVE is a FULL-HEIGHT bar,
 * EMPTY is a SHORT STUB on the baseline.
 *
 * That is a strengthening and it is stated rather than slipped in: the old
 * suite asserted "ACTIVE and EMPTY are the same SHAPE and differ only in
 * weight", and that assertion is deliberately replaced by its opposite. A
 * viewer who cannot separate green from grey now still reads the strip.
 *
 * The three heights form a ladder — 12pt, 3pt, 1pt — so the strip degrades to a
 * legible greyscale drawing with the colour removed entirely.
 *
 * ── WHY CADENCE IS IN THE COLOUR RAMP AND NOT IN THE BAR HEIGHT ────────────
 *
 * Bar height is the obvious place to put a count, and it is REFUSED. A column
 * chart whose bars rise and fall reads as a productivity graph — see the
 * recorded refusal below — and it would also collide with the height ladder
 * that carries ACTIVE/EMPTY/UNKNOWN. Every ACTIVE bar is therefore exactly the
 * same height, and a busier bucket is a DEEPER GREEN, not a taller one.
 *
 * ── WHAT THE WEIGHT MEANS, AND WHAT IT MUST NEVER BE READ AS ───────────────
 *
 * An ACTIVE cell's weight rises with the NUMBER OF SAVES in that bucket. That
 * is a CADENCE measurement and nothing else.
 *
 * RECORDED REFUSAL: it must never encode, or be captioned as, anything readable
 * as QUALITY, PROGRESS or PRODUCTIVITY. More saves means an agent checkpointed
 * more often — a different capture rhythm, which is what
 * `claude-skills/curator-continuity` explicitly asks for ("save early and
 * often") — and a denser column absolutely does not mean a better day's work.
 * The label beside the strip therefore says "saves", never "activity" and never
 * "progress", and no legend anywhere ranks a dense column above a sparse one.
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
 * Total image height — 14pt, up from 11pt.
 *
 * The width half of the presence budget is argued at `TARGET_CELLS`. Height is
 * the cheap half: a macOS menu row accommodates a 16pt icon without growing, so
 * 14pt is inside the row's existing height and costs ZERO points of width. The
 * drawn bar goes from 9pt to 12pt.
 *
 * DARKNESS IS THE DOMINANT TERM AND IT IS WHERE THE FIX ACTUALLY IS. The
 * shipped strip's brightest cell was alpha 1.0 of the DISABLED-text tint;
 * disabled menu text is roughly a quarter of the label colour's opacity, which
 * puts the heaviest bar it could draw at well under 2:1 against the menu. The
 * replacement's lightest ACTIVE rung measures 3.70:1 at the hardest background
 * in its light band and 3.65:1 in dark, and its heaviest 9.33 and 8.02. That is
 * the "barely visible" fix; the extra 3pt of height is a supporting change, not
 * the argument.
 */
export const HEIGHT_POINTS = 14;

/** The full-height ACTIVE bar occupies [BAR_TOP, BAR_BOTTOM) — 12pt, leaving
 *  1pt of breathing room top and bottom so the strip is not flush against the
 *  row. */
export const BAR_TOP = 1;
export const BAR_BOTTOM = 13;

/**
 * The height ladder, in points: 12 / 3 / 1.
 *
 * These are the SECOND signal, the one that survives when colour does not. The
 * ratios were chosen to be unmistakable rather than tasteful: an EMPTY stub is
 * a quarter of an ACTIVE bar, and an UNKNOWN hairline is a third of an EMPTY
 * stub. At 1x that is 12px, 3px and 1px, and at 2x 24px, 6px and 2px.
 */
export const EMPTY_HEIGHT_POINTS = 3;
export const UNKNOWN_HEIGHT_POINTS = 1;

// ── The cadence ramp ────────────────────────────────────────────────────────

/**
 * How many rungs the ACTIVE ramp has. Five: one save, two, three, four, and
 * five-or-more. Beyond that the scale saturates rather than running away, for
 * the same reason the old alpha ramp capped — a pathological bucket must not be
 * able to redefine what "busy" looks like for the rest of the strip.
 */
export const ACTIVE_LEVELS = 5;

/**
 * The rung for a bucket holding `count` saves, 1..ACTIVE_LEVELS.
 *
 * See the header's RECORDED REFUSAL: this is cadence, never quality. It is
 * called only for buckets already known to hold at least one save.
 */
export function activeLevel(count) {
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 1;
  return Math.min(ACTIVE_LEVELS, n);
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
 *     active 1  #257E43   3.70      active 4  #094D24   7.30
 *     active 2  #186B37   4.79      active 5  #023B19   9.33
 *     active 3  #146131   5.50
 *     empty     #76767D   3.29      unknown   #5F5F66   4.62
 *
 *   DARK (worst of #1E1E1E / #2C2C2E / #3A3A3C)
 *     active 1  #35A659   3.65      active 4  #4FD97F   6.25
 *     active 2  #40BE6B   4.75      active 5  #6DF29D   8.02
 *     active 3  #46CD75   5.54
 *     empty     #8C8C93   3.40      unknown   #A9A9B0   4.86
 *
 * ── RUNG ONE OUTWEIGHS AN EMPTY BUCKET, AND THE FIRST DRAFT DID NOT ────────
 *
 * The lightest ACTIVE rung must be HEAVIER than an EMPTY stub, or a bucket
 * holding one save reads as quieter than a bucket holding none. The first
 * palette written here failed exactly that — light rung 1 measured 3.15 against
 * EMPTY's 3.29 — and the suite caught it, not the eye. Both rung 1s were moved
 * up; the ordering is now asserted rather than assumed.
 *
 * `scripts/test-tray-paint.js` recomputes every one of those from the values
 * shipped here and fails on any that falls short, with a control proving the
 * check can fail. The numbers in this comment are therefore a convenience, not
 * the guarantee.
 *
 * ── UNKNOWN IS HEAVIER THAN EMPTY, ON PURPOSE ──────────────────────────────
 *
 * Carried over from the alpha version, where UNKNOWN was 0.30 against EMPTY's
 * 0.16, and preserved for the same reason: making "no data" the faintest thing
 * on the strip would encode it as "even less than nothing", which is the wrong
 * reading. Both clear the floor; UNKNOWN clears it by more.
 */
export const STRIP_PALETTE = {
  light: {
    active: ['#257E43', '#186B37', '#146131', '#094D24', '#023B19'],
    empty: '#76767D',
    unknown: '#5F5F66',
  },
  dark: {
    active: ['#35A659', '#40BE6B', '#46CD75', '#4FD97F', '#6DF29D'],
    empty: '#8C8C93',
    unknown: '#A9A9B0',
  },
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
 * @returns {Array<{index:number, state:'active'|'empty'|'unknown', count:number, level:number}>}
 */
export function pulseCells(pulse) {
  const buckets = pulse && Array.isArray(pulse.buckets) ? pulse.buckets : null;
  if (!buckets || !buckets.length) return [];

  const rawFirst = pulse.firstKnownBucket;
  const first = Number.isFinite(rawFirst) && rawFirst > 0
    ? Math.min(Math.floor(rawFirst), buckets.length)
    : 0;

  return buckets.map((b, index) => {
    const count = Number.isFinite(b) && b > 0 ? Math.floor(b) : 0;
    if (index < first) return { index, state: 'unknown', count: 0, level: 0 };
    if (count > 0) return { index, state: 'active', count, level: activeLevel(count) };
    return { index, state: 'empty', count: 0, level: 0 };
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
    const index = out.length;
    if (group.every((c) => c.state === 'unknown')) {
      out.push({ index, state: 'unknown', count: 0, level: 0 });
    } else if (count > 0) {
      out.push({ index, state: 'active', count, level: activeLevel(count) });
    } else {
      out.push({ index, state: 'empty', count: 0, level: 0 });
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

/** The ink for one cell: its colour and the band of rows it occupies. Split out
 *  so the suite can assert the height ladder without decoding a PNG, and so the
 *  ladder exists in exactly one place. */
export function cellInk(cell, palette) {
  if (cell.state === 'active') {
    return { hex: palette.active[cell.level - 1], top: BAR_TOP, height: BAR_BOTTOM - BAR_TOP };
  }
  const height = cell.state === 'unknown' ? UNKNOWN_HEIGHT_POINTS : EMPTY_HEIGHT_POINTS;
  return {
    hex: cell.state === 'unknown' ? palette.unknown : palette.empty,
    top: BAR_BOTTOM - height,
    height,
  };
}

/**
 * The RGBA canvas for one scale factor.
 *
 * Every mark is opaque — a bar is a rectangle on integer boundaries, so there
 * is no rim to antialias and no partial alpha anywhere in the strip. That is
 * what lets the suite assert a contrast ratio against a decoded pixel without
 * compositing anything.
 */
export function stripCanvas(cells, scale, palette) {
  const s = Number.isInteger(scale) && scale > 0 ? scale : 1;
  const pitch = CELL_POINTS + GAP_POINTS;
  const canvas = createCanvas(
    (cells.length * pitch - GAP_POINTS) * s,
    HEIGHT_POINTS * s,
  );

  cells.forEach((cell, i) => {
    const ink = cellInk(cell, palette);
    fillRect(canvas, i * pitch * s, ink.top * s, CELL_POINTS * s, ink.height * s,
      hexToRgb(ink.hex));
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

  return {
    buffer: encodeRgbaPng(stripCanvas(cells, 1, palette)),
    // TWO representations, not one: a 1x-only image is soft on every Mac sold
    // in the last decade, and a 2x-only image handed to a 1x display is
    // downsampled by the OS rather than drawn.
    buffer2x: encodeRgbaPng(stripCanvas(cells, 2, palette)),
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
  return 'Save pulse · ' + period + ' · ' + count;
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
  // The legend names the three marks and RANKS NOTHING. See the header's
  // recorded refusal: a denser column is a different cadence, not a better day.
  // It names the SHAPE of each mark as well as its colour, because a legend
  // that reads "green means saves" is useless to the viewer who most needs it.
  lines.push('Tall green bar = saves · low grey stub = quiet · baseline hairline = before this store existed');

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
