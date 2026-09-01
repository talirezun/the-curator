/**
 * renderPulseStrip() — the save pulse, drawn as a template PNG for a menu item.
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
 * ── IT IS A TEMPLATE IMAGE, WHICH IS A HARD CONSTRAINT ─────────────────────
 *
 * Same constraint, same reason, as `lib/tray-icon.js`: macOS takes ONLY the
 * alpha channel of a template image and tints it for the current context —
 * light menu, dark menu, and the INVERTED state of a highlighted row. So every
 * grey value is pinned at 0 and every distinction this strip draws is carried
 * in alpha and in SHAPE. There is no colour available here, and a coloured
 * strip would be a coloured smear on half the backgrounds it is drawn on.
 *
 * `encodeAlphaPng` is IMPORTED from `tray-icon.js` rather than reimplemented. A
 * second hand-rolled CRC32/deflate encoder in the same folder is a second thing
 * to get wrong, and that module's suite already decodes its output back and
 * asserts real pixel coverage — this file is held to that same standard by
 * `scripts/test-tray-pulse-strip.js`.
 *
 * ── THE CELL VOCABULARY IS THE LOAD-BEARING PART ───────────────────────────
 *
 * Three states, and they must be VISUALLY DISTINCT:
 *
 *   ACTIVE   full-height bar, high alpha    saves landed in this bucket
 *   EMPTY    full-height bar, low alpha     this bucket existed, nothing happened
 *   UNKNOWN  a baseline tick, low alpha     before the store existed at all
 *
 * EMPTY AND UNKNOWN MUST NOT RENDER IDENTICALLY, and they are separated by
 * SHAPE and not merely by opacity — a bar versus a tick reads at 2pt wide,
 * where two similar alphas do not. Collapsing "nothing happened" into "no data"
 * is this project's named fact-versus-absence defect, and it is not a corner
 * case here: the maintainer's own store is about 3.5 days old against a 7-day
 * window, so roughly HALF this strip is UNKNOWN today. The common case.
 *
 * Every cell is drawn, empties included, at low opacity. A strip that omits its
 * empty cells stops being a timeline and becomes a scatter of marks with no
 * scale — the empties are what make the spacing readable at this size.
 *
 * ── WHAT THE ALPHA MEANS, AND WHAT IT MUST NEVER BE READ AS ────────────────
 *
 * An ACTIVE cell's alpha rises with the NUMBER OF SAVES in that bucket. That is
 * a CADENCE measurement and nothing else.
 *
 * RECORDED REFUSAL: it must never encode, or be captioned as, anything readable
 * as QUALITY, PROGRESS or PRODUCTIVITY. More saves means an agent checkpointed
 * more often — a different capture rhythm, which is what
 * `claude-skills/curator-continuity` explicitly asks for ("save early and
 * often") — and a denser column absolutely does not mean a better day's work.
 * The label beside the strip therefore says "saves", never "activity" and never
 * "progress", and no legend anywhere ranks a dense column above a sparse one.
 */

import { encodeAlphaPng } from './tray-icon.js';

// ── Geometry, in POINTS ─────────────────────────────────────────────────────
//
// Every dimension is in points and multiplied by the scale factor, so the 1x
// and 2x representations are one drawing at two resolutions rather than two
// drawings that happen to look alike — the failure mode that makes a retina
// asset subtly not match its own low-resolution twin.

/** Bar width. Two points is two device pixels at 1x and four at 2x: the
 *  narrowest mark that still reads as a bar rather than as a hairline. */
export const CELL_POINTS = 2;

/** The gap between bars. One point, so the pitch is 3pt and 28 buckets cost
 *  83pt of menu width — see MENU_CHAR_POINTS for why that number was checked
 *  against the menu's width budget rather than chosen by eye. */
export const GAP_POINTS = 1;

/** Total image height. A macOS menu row is about 19pt tall, so 11pt sits
 *  comfortably inside it without forcing the row taller. */
export const HEIGHT_POINTS = 11;

/** The full-height bar occupies [BAR_TOP, BAR_BOTTOM) — 9pt, leaving 1pt of
 *  breathing room top and bottom so the strip is not flush against the row. */
const BAR_TOP = 1;
const BAR_BOTTOM = 10;

/** The UNKNOWN tick is the bottom TICK_POINTS of the bar's band. A different
 *  SHAPE, not a different opacity, because opacity alone is not a distinction
 *  a 2pt-wide mark can carry. */
const TICK_POINTS = 1;

// ── Alpha ───────────────────────────────────────────────────────────────────

/** One save in a bucket. Chosen well clear of EMPTY_ALPHA so a single save is
 *  unmistakably a mark rather than a slightly darker gap. */
export const ACTIVE_ALPHA_BASE = 0.60;
/** Each additional save. Four legible steps before the cap. */
export const ACTIVE_ALPHA_STEP = 0.13;
export const ACTIVE_ALPHA_MAX = 1.0;

/** A bucket that existed and in which nothing was saved. Low, but drawn. */
export const EMPTY_ALPHA = 0.16;

/** Before the store existed. Deliberately NOT lower than EMPTY_ALPHA — the two
 *  are separated by shape, and making "no data" the faintest thing on the strip
 *  would encode it as "even less than nothing", which is the wrong reading. */
export const UNKNOWN_ALPHA = 0.30;

/**
 * The alpha for a bucket holding `count` saves.
 *
 * See the header's RECORDED REFUSAL: this is cadence, never quality.
 */
export function activeAlpha(count) {
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 1;
  return Math.min(ACTIVE_ALPHA_MAX, ACTIVE_ALPHA_BASE + ACTIVE_ALPHA_STEP * (n - 1));
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
 * @returns {Array<{index:number, state:'active'|'empty'|'unknown', count:number, alpha:number}>}
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
    if (index < first) return { index, state: 'unknown', count: 0, alpha: UNKNOWN_ALPHA };
    if (count > 0) return { index, state: 'active', count, alpha: activeAlpha(count) };
    return { index, state: 'empty', count: 0, alpha: EMPTY_ALPHA };
  });
}

/**
 * The alpha matrix for one scale factor. Every value is 0..255.
 */
export function stripMatrix(cells, scale) {
  const s = Number.isInteger(scale) && scale > 0 ? scale : 1;
  const pitch = CELL_POINTS + GAP_POINTS;
  const width = (cells.length * pitch - GAP_POINTS) * s;
  const height = HEIGHT_POINTS * s;

  const rows = [];
  for (let y = 0; y < height; y++) rows.push(new Array(width).fill(0));

  cells.forEach((cell, i) => {
    const x0 = i * pitch * s;
    const x1 = x0 + CELL_POINTS * s;
    const top = (cell.state === 'unknown' ? BAR_BOTTOM - TICK_POINTS : BAR_TOP) * s;
    const bottom = BAR_BOTTOM * s;
    const a = Math.max(0, Math.min(255, Math.round(cell.alpha * 255)));
    for (let y = top; y < bottom; y++) {
      for (let x = x0; x < x1; x++) rows[y][x] = a;
    }
  });

  return rows;
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
 * @returns {{buffer:Buffer, buffer2x:Buffer, widthPoints:number,
 *            heightPoints:number, cells:Array}|null}
 */
export function renderPulseStrip(pulse) {
  if (!pulse || typeof pulse !== 'object') return null;
  const cells = pulseCells(pulse);
  if (!cells.length) return null;

  return {
    buffer: encodeAlphaPng(stripMatrix(cells, 1)),
    // TWO representations, not one: a 1x-only image is soft on every Mac sold
    // in the last decade, and a 2x-only image handed to a 1x display is
    // downsampled by the OS rather than drawn.
    buffer2x: encodeAlphaPng(stripMatrix(cells, 2)),
    widthPoints: cells.length * (CELL_POINTS + GAP_POINTS) - GAP_POINTS,
    heightPoints: HEIGHT_POINTS,
    cells,
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
 * the top of a menu whose width is the thing being fixed in the same release,
 * and its icon already costs about 83 points. The suite measures that this item
 * is not the widest thing in the menu.
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

  lines.push('Saves per ' + (spanText(pulse.bucketSeconds) || 'bucket') +
    ', oldest on the left.');
  // The legend names the three marks and RANKS NOTHING. See the header's
  // recorded refusal: a denser column is a different cadence, not a better day.
  lines.push('Solid = saves · faint = quiet · baseline tick = before this store existed');

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
 * width is the very thing being reduced — an argument carried out in numbers,
 * which is worth more than an argument carried out in adjectives, and less than
 * a measurement, which is not available.
 */
export const MENU_CHAR_POINTS = 6.5;
