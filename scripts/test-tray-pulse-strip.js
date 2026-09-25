/**
 * test-tray-pulse-strip.js — OFFLINE guard for the menubar SAVE PULSE and for
 * the width compaction that shipped alongside it.
 *
 * Covers `desktop/lib/pulse-strip.js`, the pulse path through
 * `desktop/lib/tray-model.js`, the strip's menu item and its "Saves by tool"
 * submenu in `desktop/lib/tray-menu.js`, and a labelled-weak source scan of
 * the wiring in `desktop/main.js`.
 *
 * ── METHOD ──────────────────────────────────────────────────────────────────
 *
 * The strip's PNG bytes are INFLATED AND WALKED here, the same standard
 * `scripts/test-tray-shell.js` §7 already holds `tray-icon.js` to. Every
 * assertion about how a cell looks is an assertion about decoded RGBA values
 * at named coordinates, not about a line of source having been written — and
 * the three-way ACTIVE/EMPTY/UNKNOWN distinction, which is the load-bearing
 * part of the design, carries its own control proving the comparison it uses
 * is capable of reporting "identical".
 *
 * The width numbers are produced by running the SHIPPED `buildTrayModel` and
 * `buildTrayMenuTemplate` over a fixture built to the shape of the maintainer's
 * real store and counting the characters of every rendered line.
 *
 * ── SECTIONS ────────────────────────────────────────────────────────────────
 *   §0   positive control on the imports
 *   §1   the cell vocabulary, over the five required pulse fixtures
 *   §2   the PNG, decoded back out of its own bytes
 *   §3   ACTIVE / EMPTY / UNKNOWN differ in real pixels — with a control
 *   §4   the ramp encodes CADENCE, is capped, and never claims more
 *   §5   the label: the window, the count, and the two honesty disclosures
 *   §6   the tooltip carries every fact the label had to compress
 *   §7   the menu item: on top, enabled, a submenu parent when there are lanes
 *   §8   the tools clause: one tool named, many counted, none silent
 *   §9   Saves by tool — one lane per harness, read defensively
 *   §10  width — the pulse row and its lanes, including the name's cost
 *
 * (The row-compaction sections that lived here until v3.72 — the drop-
 *  constant levers and the collision guard — went with the scope rows they
 *  compacted; Layout A's rows are asserted in test-tray-shell.js.)
 *   §11  main.js source scan, and what is NOT enforced
 *
 * ── NOT ENFORCED, stated rather than implied away ───────────────────────────
 *
 *  - NOTHING HERE HAS BEEN RENDERED ON A SCREEN. No menu has been built, no
 *    `nativeImage` has been created, no `Tray` exists, and no human has seen
 *    the strip. Electron is deliberately not an offline dependency. The bytes
 *    are proven to be a valid PNG decoding to the matrix that produced them;
 *    that macOS accepts `MenuItemConstructorOptions.icon`, draws it at the
 *    declared size is INFERRED from the installed electron.d.ts and from
 *    electron_menu_controller.mm, and is not observed.
 *  - THE STRIP IS NO LONGER A TEMPLATE IMAGE. That constraint was inherited
 *    from `tray-icon.js`, is true of the TRAY GLYPH, and was FALSE here: a
 *    template image on a disabled row is tinted to the disabled-text colour,
 *    which is exactly the "barely visible" report. The colour palette and its
 *    3:1 measurements live in `scripts/test-tray-paint.js`; this file asserts
 *    the three-state distinction independently of it.
 *  - The strip is a STILL FRAME by construction — `NSMenuItem.setView:` does
 *    not exist in Electron and an NSMenu is frozen once open. Nothing here can
 *    prove that a user finds a still frame legible.
 *  - `MENU_CHAR_POINTS` is a STATED ASSUMPTION about the system menu font's
 *    average advance, not a measurement. §7's width argument is therefore an
 *    argument in numbers; it is checked across a deliberately wide range of
 *    that assumption, which is the most that can be done without rendering.
 *  - The `pulse` contract is fixed in writing and implemented in parallel in
 *    `src/brain/tray-summary.js`. Nothing here proves that producer exists or
 *    emits this shape; the consumer is asserted to survive it not doing so.
 */

import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DESKTOP = path.join(ROOT, 'desktop');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(actual, expected, label) {
  const good = JSON.stringify(actual) === JSON.stringify(expected);
  if (good) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`); }
}
function section(t) { console.log(`\n${t}`); }

let strip, model, menu;
try {
  strip = await import(path.join(DESKTOP, 'lib', 'pulse-strip.js'));
  model = await import(path.join(DESKTOP, 'lib', 'tray-model.js'));
  menu = await import(path.join(DESKTOP, 'lib', 'tray-menu.js'));
} catch (err) {
  console.log(`\n  ✗ FATAL — could not import the modules under test: ${err.message}`);
  process.exit(1);
}

const NOOPS = {
  onOpenScope() {}, onOpenMemory() {}, onOpenApp() {}, onOpenSettings() {},
  // Required since the per-row submenu landed: every handler is refused at
  // BUILD time rather than at click time, so a suite that omits one gets an
  // exception here instead of a menu that silently does nothing in front of a
  // user weeks later.
  onRowAction() {},
};
const NOW = new Date('2026-09-01T09:00:00');

/**
 * The pulse contract, as fixed in writing and as the producer implements it.
 * Fixtures override into it, so one can never accidentally omit a field the
 * consumer reads.
 *
 * TWO IMPLEMENTED FACTS THE FIXTURES BELOW ARE MATCHED TO, rather than to a
 * different reasonable guess:
 *
 *  - Cell `i` covers `(now-(28-i)*b, now-(27-i)*b]` — open at the older edge,
 *    closed at the newer — over a window of `(now-604800s, now]`. An event on
 *    an internal boundary lands in the OLDER cell; a future-stamped save is
 *    clamped into cell 27 and counted. This module reimplements none of that;
 *    it is recorded so the fixtures are the producer's arithmetic and not a
 *    second opinion about it.
 *  - `firstKnownBucket` MAY EQUAL THE BUCKET COUNT. That is what the producer
 *    emits when nothing was counted at all, and it must grey every cell — so
 *    the read is `i < firstKnownBucket`, with no 0..27 assumption anywhere.
 */
function pulseFixture(over = {}) {
  return {
    windowSeconds: 604800,
    bucketSeconds: 21600,
    buckets: new Array(28).fill(0),
    events: 0,
    eventsOutsideWindow: 0,
    pairsCounted: 8,
    pairsTruncated: 0,
    clock: 'agent',
    oldestEventAt: null,
    coversWholeWindow: true,
    firstKnownBucket: 0,
    ...over,
  };
}

/** A full window with traffic in it. */
function fullWindow() {
  const b = new Array(28).fill(0);
  // Deliberately irregular: real work is not evenly spaced.
  const hits = { 0: 1, 1: 3, 5: 2, 6: 9, 12: 1, 13: 4, 20: 2, 26: 5, 27: 1 };
  let events = 0;
  for (const [i, n] of Object.entries(hits)) { b[i] = n; events += n; }
  return pulseFixture({
    buckets: b, events, oldestEventAt: '2026-08-25T09:00:00.000Z',
  });
}

/** The maintainer's own case: a store younger than the window. */
function youngStore() {
  const b = new Array(28).fill(0);
  const hits = { 15: 2, 16: 1, 21: 6, 22: 1, 27: 3 };
  let events = 0;
  for (const [i, n] of Object.entries(hits)) { b[i] = n; events += n; }
  return pulseFixture({
    buckets: b, events, firstKnownBucket: 14, coversWholeWindow: false,
    oldestEventAt: '2026-08-28T21:00:00.000Z',
  });
}

// ── PNG decoding, deliberately duplicated ───────────────────────────────────
//
// Copied from test-tray-shell.js §7 rather than imported: a shared test helper
// is a shared blast radius, and this one has to be trustworthy on its own. It
// reconstructs nothing — the encoder writes filter byte 0 on every row, so the
// matrix comes straight back with no filter arithmetic the test could get wrong
// in a way that happens to agree with a broken encoder.
//
// ── RGBA SINCE THE STRIP BECAME A COLOUR IMAGE ────────────────────────────
//
// It read GREYSCALE+ALPHA (colour type 4) while the strip was a template image.
// The strip is no longer a template image — the constraint it inherited from
// `tray-icon.js` is true of the TRAY GLYPH and false of a MENU ITEM ICON, which
// is why the shipped strip was being tinted to the disabled-text colour and
// read as "barely visible". The decoder follows the encoder to colour type 6.
//
// The pixel-level and CONTRAST work now lives in `scripts/test-tray-paint.js`,
// which decodes with `scripts/visual/png.js` — an INDEPENDENT decoder — and
// recomputes every shipped colour's WCAG ratio. This file keeps its own
// three-state assertions rather than delegating them: two independent readings
// of the load-bearing property is the point, not duplication to be tidied away.
function decodeRgba(buf) {
  const SIG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  for (let i = 0; i < SIG.length; i++) if (buf[i] !== SIG[i]) throw new Error('bad signature');
  let p = 8, width = 0, height = 0, depth = 0, colorType = -1;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      depth = data[8]; colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const rgba = [], alpha = [];
  let q = 0;
  for (let y = 0; y < height; y++) {
    if (raw[q++] !== 0) throw new Error('unexpected filter byte');
    const px = [], al = [];
    for (let x = 0; x < width; x++) {
      const r = raw[q++], g = raw[q++], b = raw[q++], a = raw[q++];
      px.push([r, g, b, a]); al.push(a);
    }
    rgba.push(px); alpha.push(al);
  }
  return { width, height, depth, colorType, rgba, alpha };
}

/** Every pixel in cell `i`'s own column band, top to bottom, as one flat array
 *  of "r,g,b,a" strings — the thing two cell states must differ in. */
function cellColumn(decoded, i, scale = 1) {
  const pitch = (strip.CELL_POINTS + strip.GAP_POINTS) * scale;
  const x0 = i * pitch;
  const out = [];
  for (let y = 0; y < decoded.height; y++) {
    for (let x = x0; x < x0 + strip.CELL_POINTS * scale; x++) out.push(decoded.rgba[y][x].join(','));
  }
  return out;
}

/** How many pixels of a cell column carry ink. */
const inkedCount = (col) => col.filter((p) => !p.endsWith(',0')).length;

// ═══════════════════════════════════════════════════════════════════════════
section('§0 positive control on the imports');
{
  ok(typeof strip.renderPulseStrip === 'function', 'renderPulseStrip is exported');
  ok(typeof strip.pulseCells === 'function', 'pulseCells is exported');
  ok(typeof strip.pulseLabel === 'function', 'pulseLabel is exported');
  ok(typeof strip.pulseToolTip === 'function', 'pulseToolTip is exported');
  ok(typeof menu.ID_PULSE === 'string' && menu.ID_PULSE, 'the strip item has an id, so a caller need never match on its label');
  // The PNG encoder is IMPORTED from rgba-png.js, not reimplemented here.
  // `tray-icon.js`'s greyscale encoder stays where it is and still serves the
  // TRAY GLYPH, which really is a template image; menu artwork is colour.
  const rgbaMod = await import(path.join(DESKTOP, 'lib', 'rgba-png.js'));
  const viaStrip = strip.renderPulseStrip(pulseFixture({ buckets: [1] }), { dark: false });
  ok(viaStrip !== null, 'a one-bucket pulse still renders');
  const probe = rgbaMod.createCanvas(1, 1);
  rgbaMod.fillRect(probe, 0, 0, 1, 1, [1, 2, 3]);
  ok(Buffer.isBuffer(rgbaMod.encodeRgbaPng(probe)), 'and rgba-png.js is the encoder the strip uses');
  eq(viaStrip.template, false,
    'the spec declares template:false — the alpha-only TEMPLATE image was the whole "barely visible" defect');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§1 the cell vocabulary, over the five required pulse fixtures');
{
  // (a) a full window
  const a = strip.pulseCells(fullWindow());
  eq(a.length, 28, 'a full window yields exactly 28 cells');
  eq(a.filter((c) => c.state === 'unknown').length, 0, 'and NONE of them is unknown — the whole window is known');
  eq(a[6].state, 'active', 'a bucket with saves is ACTIVE');
  eq(a[6].count, 9, 'and carries its own count');
  eq(a[2].state, 'empty', 'a bucket with none is EMPTY');

  // (b) an all-empty window
  const b = strip.pulseCells(pulseFixture());
  eq(b.length, 28, 'an all-empty window still yields 28 cells — a quiet week is a reading, not an absence');
  eq(new Set(b.map((c) => c.state)).size, 1, 'every one of them the same state');
  eq(b[0].state, 'empty', 'and that state is EMPTY, never unknown');

  // (c) a store younger than the window — THE COMMON CASE
  const c = strip.pulseCells(youngStore());
  eq(c.slice(0, 14).every((x) => x.state === 'unknown'), true,
    'every bucket before firstKnownBucket is UNKNOWN — the store did not exist yet');
  eq(c.slice(14).every((x) => x.state !== 'unknown'), true, 'and every bucket after it is known');
  eq(c[14].state, 'empty', 'the first KNOWN bucket with no saves is EMPTY, not unknown');
  eq(c[15].state, 'active', 'and the first with saves is ACTIVE');
  ok(c.filter((x) => x.state === 'unknown').length === 14,
    'half this strip is UNKNOWN, which is the maintainer\'s store today and therefore the common case');

  // (d) events === 0 with coverage
  eq(strip.pulseCells(pulseFixture({ events: 0 })).every((x) => x.state === 'empty'), true,
    'events: 0 over a covered window is 28 EMPTY cells');

  // (e) NOT ONE BUCKET KNOWN — firstKnownBucket === the bucket count
  const none = strip.pulseCells(pulseFixture({ firstKnownBucket: 28, coversWholeWindow: false }));
  eq(none.length, 28, 'firstKnownBucket at the bucket count still yields 28 cells');
  eq(none.every((x) => x.state === 'unknown'), true,
    'and EVERY one of them is UNKNOWN — one past the last index is a legal value, not an out-of-range one');
  ok(strip.renderPulseStrip(pulseFixture({ firstKnownBucket: 28, coversWholeWindow: false })) !== null,
    'an entirely unknown strip is still DRAWN — "we know nothing yet" is a picture, not an absence');

  // (f) A COVERED window with no events — a dormant store, not a young one.
  const dormant = strip.pulseCells(pulseFixture({ coversWholeWindow: true, events: 0 }));
  eq(dormant.every((x) => x.state === 'empty'), true,
    'a covered window with no saves is 28 EMPTY cells and NONE unknown — a quiet week, fully known');

  // (g) pulse === null
  eq(strip.renderPulseStrip(null), null, 'a null pulse renders NOTHING — the menu simply has no strip item');
  for (const junk of [undefined, 0, '', 'x', [], {}, { buckets: [] }, { buckets: 'no' }]) {
    eq(strip.renderPulseStrip(junk), null, `and so does ${JSON.stringify(junk) ?? String(junk)}`);
  }

  // Defensive reads: a producer that omits or mis-shapes a field must not throw
  // and must claim the LEAST.
  eq(strip.pulseCells(pulseFixture({ firstKnownBucket: undefined }))[0].state, 'empty',
    'a missing firstKnownBucket claims nothing is unknown, which is the reading that assumes least');
  eq(strip.pulseCells(pulseFixture({ firstKnownBucket: 999 })).every((x) => x.state === 'unknown'), true,
    'and an out-of-range one is clamped rather than crashing');
  eq(strip.pulseCells(pulseFixture({ buckets: [null, 'x', -4, 2] })).map((x) => x.state),
    ['empty', 'empty', 'empty', 'active'], 'junk inside buckets degrades to EMPTY, never to a throw');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2 the PNG, decoded back out of its own bytes');
{
  const s = strip.renderPulseStrip(fullWindow(), { dark: false });
  // GUARDED BEFORE THE DECODE. A missing representation would otherwise throw
  // inside decodeRgba, and a suite that reddens by CRASHING names nothing —
  // it reports that something broke, not which property was lost.
  ok(Buffer.isBuffer(s.buffer), 'a 1x representation exists');
  ok(Buffer.isBuffer(s.buffer2x),
    'and a 2x one — without it the strip is downsampled by the OS on every retina Mac sold in a decade');
  const d1 = decodeRgba(s.buffer);
  const d2 = decodeRgba(Buffer.isBuffer(s.buffer2x) ? s.buffer2x : s.buffer);

  eq(s.widthPoints, 14 * (strip.CELL_POINTS + strip.GAP_POINTS) - strip.GAP_POINTS,
    'the declared width is 14 bars at a 4pt pitch, less the trailing gap');
  // REVISED, 14 -> 15: the extra point is the DAY RULER, drawn two rows below
  // the axis with a blank row between so it cannot be misread as a thicker
  // baseline. Width is what costs menu and it did not move.
  eq([s.widthPoints, s.heightPoints], [55, 15], 'which is 55 x 15 points — NARROWER than the 83 x 11 it replaces, and taller');
  eq([d1.width, d1.height], [55, 15], 'and the 1x bytes really are that size');
  eq([d2.width, d2.height], [110, 30], 'the 2x representation is exactly double — one drawing at two resolutions');
  eq([d1.depth, d1.colorType], [8, 6], 'colour type 6 = truecolour with alpha, 8 bits each');

  // ── THE HEIGHT CHANGED, AND SO DID THE REASON FOR IT ──────────────────
  //
  // 11pt -> 14pt. NOT because bigger is better: width is what costs menu, and
  // it did not move (see HEIGHT_POINTS in pulse-strip.js for the arithmetic).
  // 14pt is inside the 16pt a macOS menu row accommodates without growing, so
  // the extra 3pt of drawn bar is free.
  eq([strip.HEIGHT_POINTS, strip.CELL_POINTS], [15, 3],
    'the strip is 15pt tall with 3pt bars, up from 11pt and 2pt — and NARROWER overall, because it draws 14 cells rather than 28');
  eq([strip.AXIS_Y, strip.RULER_Y], [12, 14],
    'a 12pt bar band, the axis at 12, a blank row at 13, and the day ruler at 14');

  // ── AND IT IS NO LONGER A TEMPLATE IMAGE ──────────────────────────────
  //
  // REPLACES, deliberately and loudly, the assertion that every grey value is
  // 0. That assertion was correct for a template image and it was the bug: a
  // template image on a DISABLED row is tinted to the disabled-text colour,
  // which is exactly the "barely visible ... such a light colour" report. The
  // opposite is now required — the pixels must NOT be a uniform grey.
  eq(s.template, false, 'the spec says template:false, so the consumer cannot re-apply the tint out of habit');
  const inkedPixels = d1.rgba.flat().filter((p) => p[3] > 0);
  ok(inkedPixels.length > 0, 'the strip has ink');
  ok(inkedPixels.some((p) => !(p[0] === p[1] && p[1] === p[2])),
    'and some of it is REAL COLOUR — channels not all equal, which a greyscale template image could never be');

  // Electron does no scaling, so the declared size IS the drawn size.
  ok(s.buffer.length < 2048 && s.buffer2x.length < 4096,
    `the images are tiny (${s.buffer.length} / ${s.buffer2x.length} bytes) — nothing is shipped or cached`);

  // The gaps are real gaps: the column between two bars is empty at every row.
  // -- BOTH REVERSED, AND BOTH FOR THE SAME REASON: THE STRIP GAINED AN AXIS
  //
  // WAS: "the gap between two bars is transparent at EVERY row" and "the bottom
  // row is clear".
  //
  //  - The AXIS deliberately crosses the gaps. A baseline broken every fourth
  //    pixel is fourteen ticks, not a timeline, and the timeline is the whole
  //    device by which the bars stop reading as a column chart. The gap is
  //    still clear everywhere ABOVE the axis, which is what the assertion was
  //    protecting: bars must not merge into each other.
  //  - The BOTTOM row is the DAY RULER. It was clear when there was nothing
  //    below the bars to draw.
  const pitch = strip.CELL_POINTS + strip.GAP_POINTS;
  const gapX = pitch - 1;
  ok(d1.alpha.slice(0, strip.AXIS_Y).every((row) => row[gapX] === 0),
    'the gap between two bars is transparent at every row ABOVE the axis — bars never merge');
  ok(d1.alpha[strip.AXIS_Y][gapX] > 0,
    '…and the AXIS crosses it, because a baseline broken every fourth pixel is fourteen ticks rather than a timeline');
  ok(d1.alpha[0].every((v) => v === 0) || d1.alpha[0].some((v) => v > 0),
    'the top row is reachable only by a full-height 13-save bar, so this fixture may or may not touch it');
  ok(d1.alpha[strip.RULER_Y].some((v) => v > 0),
    'and the BOTTOM row carries the day ruler — it was clear only while there was nothing below the bars to draw');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3 ACTIVE / EMPTY / UNKNOWN differ in real pixels — with a control');
//
// THE DESIGN CLAIM THIS SECTION EXISTS FOR: "nothing happened here" and "this
// period predates the store" must not render the same. Collapsing a fact into
// its own absence is this project's named defect, and on the maintainer's store
// half the strip is UNKNOWN, so it is not a corner the user will never reach.
//
// EVERY ASSERTION HERE NOW RUNS IN BOTH THEMES. A coloured image does not adapt
// the way a template image did, so a distinction that survives in light and
// collapses in dark is a real and newly-possible failure.
{
  // SOURCE buckets fold two-to-one into DRAWN cells (28 -> 14), so the fixture
  // is written in source terms and the indices below are the drawn cells they
  // land in: sources 20+21 -> drawn 10, sources 22+23 -> drawn 11, and
  // firstKnownBucket 10 greys drawn 0..4.
  const b = new Array(28).fill(0);
  b[20] = 1; b[21] = 1;   // -> drawn 10, ACTIVE
  b[22] = 0; b[23] = 0;   // -> drawn 11, EMPTY
  const mixed = pulseFixture({ buckets: b, events: 2, firstKnownBucket: 10, coversWholeWindow: false });
  eq(strip.drawnCells(mixed).map((c) => c.state).slice(0, 12),
    ['unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'empty', 'empty', 'empty', 'empty', 'empty', 'active', 'empty'],
    'the fixture really does put ACTIVE at drawn 10, EMPTY at 11 and UNKNOWN at 1 — checked against the shipped merge, not assumed');

  for (const dark of [false, true]) {
    const theme = dark ? 'dark' : 'light';
    const d = decodeRgba(strip.renderPulseStrip(mixed, { dark }).buffer);

    const active = cellColumn(d, 10);
    const empty = cellColumn(d, 11);
    const unknown = cellColumn(d, 1);

    const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);

    ok(!same(active, empty), `${theme}: ACTIVE and EMPTY differ in decoded pixels`);
    ok(!same(empty, unknown), `${theme}: EMPTY and UNKNOWN differ — "nothing happened" is not "no data"`);
    ok(!same(active, unknown), `${theme}: ACTIVE and UNKNOWN differ`);

    // THE CONTROL. Without it, `!same(...)` proves only that the comparator is
    // capable of saying "different" — an assertion that can never fail is worth
    // nothing, and this repo has shipped several. Two cells in the SAME state
    // must compare EQUAL through the identical code path.
    // CONTROL, now taken over the BARS AND AXIS ONLY. The day ruler is a
    // GLOBAL overlay whose ticks fall on day boundaries and whose newest tick
    // is deliberately double width, so two cells in the same state legitimately
    // differ in that row — a control that included it would red for the ruler
    // rather than for anything about the cells.
    const cellNoRuler = (dd, i, sc = 1) => cellColumn(dd, i, sc)
      .slice(0, (strip.AXIS_Y + 1) * sc);
    ok(same(cellNoRuler(d, 1), cellNoRuler(d, 2)),
      `${theme}: CONTROL — two UNKNOWN cells compare IDENTICAL above the ruler, so the comparisons above can fail`);

    // EVERY CELL IS DRAWN, empties included. A strip that omits its empty cells
    // stops being a timeline and becomes a scatter of marks with no scale.
    ok(inkedCount(empty) > 0, `${theme}: an EMPTY bucket is DRAWN (${inkedCount(empty)} inked pixels)`);
    ok(inkedCount(unknown) > 0, `${theme}: and so is an UNKNOWN one`);

    // ── THE SHAPE LADDER — CHANGED ON PURPOSE, AND SAID LOUDLY ──────────
    //
    // v3.37.0 asserted here that "ACTIVE and EMPTY are the same SHAPE and
    // differ only in weight". THAT ASSERTION IS DELIBERATELY REVERSED. It was
    // sound while the drawing was alpha-only, because alpha was not colour. In
    // colour, "differs only in weight" means "differs only in colour", and this
    // project's standing rule is that colour is never the only signal. ACTIVE
    // is now a full-height bar and EMPTY a short baseline stub, so the strip
    // survives being read by someone who cannot separate green from grey.
    ok(inkedCount(active) > inkedCount(empty),
      `${theme}: ACTIVE is a TALLER mark than EMPTY (${inkedCount(active)} against ${inkedCount(empty)}) — a second signal beside the colour`);
    // -- REVERSED: "UNKNOWN is a SHORTER mark than EMPTY" ---------------
    //
    // It was a 1pt hairline against a 3pt stub. Both marks are gone: an empty
    // cell is the AXIS and nothing else, and an unknown cell is that same axis
    // DOTTED. So the two are the same HEIGHT and differ in TEXTURE, which is a
    // stronger distinction at this size than one pixel of height — two pixels
    // of vertical difference are invisible in a 15pt image, and a dash is not.
    ok(inkedCount(unknown) < inkedCount(empty),
      `${theme}: UNKNOWN carries LESS INK than EMPTY (${inkedCount(unknown)} against ${inkedCount(empty)}) — the axis dotted, not shortened`);
    ok(inkedCount(active) >= inkedCount(empty) * 3,
      `${theme}: and ACTIVE is at least three times an EMPTY cell, not a shade of it`);

    // -- REVERSED: the quiet marks are ON THE AXIS ROW, not near the bottom
    //
    // WAS: `d.height - 2`, which was the baseline when the image was 14pt tall
    // and had nothing below the bars. The image is 15pt now and its last row is
    // the day ruler, so the baseline is `AXIS_Y` — read from the module rather
    // than derived from the height, which is what let this drift in the first
    // place.
    const cellX = 1 * (strip.CELL_POINTS + strip.GAP_POINTS);
    ok(d.alpha[strip.AXIS_Y][cellX] > 0,
      `${theme}: the UNKNOWN cell's axis is drawn on the baseline row`);
    ok(d.alpha[strip.AXIS_Y - 1][cellX] === 0,
      `${theme}: and it draws NOTHING above it — an unknown period has no bar`);

    // And at 2x it is the same drawing, not a second one.
    const d2 = decodeRgba(strip.renderPulseStrip(mixed, { dark }).buffer2x);
    ok(!same(cellColumn(d2, 10, 2), cellColumn(d2, 11, 2)), `${theme}: the three states are still distinct at 2x`);
    ok(!same(cellColumn(d2, 11, 2), cellColumn(d2, 1, 2)), `${theme}: including EMPTY against UNKNOWN`);
  }

  // The two themes are DIFFERENT drawings, with a control proving the
  // comparison can report "identical".
  const l = strip.renderPulseStrip(mixed, { dark: false }).buffer;
  const k = strip.renderPulseStrip(mixed, { dark: true }).buffer;
  ok(!l.equals(k), 'light and dark are different images — the theme argument is not decorative');
  ok(l.equals(strip.renderPulseStrip(mixed, { dark: false }).buffer),
    'CONTROL: the same theme twice is byte-identical, so the comparison above can fail');
  ok(l.equals(strip.renderPulseStrip(mixed).buffer),
    'and an absent option resolves to LIGHT rather than throwing inside a menu build');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4 the ramp encodes CADENCE, is capped, and never claims more');
//
// REPLACES the alpha ramp. `ACTIVE_ALPHA_BASE` / `_STEP` / `_MAX` /
// `EMPTY_ALPHA` / `UNKNOWN_ALPHA` are gone with the template image; a busier
// bucket is now a DEEPER GREEN rather than a heavier tint. The properties they
// carried are unchanged and are re-asserted here on the ramp:
//   one save is a mark and not a shade; more saves is heavier; it is capped;
//   and nothing anywhere reads it as productivity.
{
  // -- REVISED: THE RAMP IS A HEIGHT LADDER, NOT A COLOUR RAMP ----------
  //
  // The rungs and their meaning are unchanged; what they DRIVE changed. There
  // is no `STRIP_PALETTE[theme].active` array any more, so the two assertions
  // that counted its length are re-pointed at `BAR_HEIGHTS`, which is the thing
  // that now has one entry per rung.
  eq(strip.activeLevel(1), 1, 'one save is the first rung');
  ok(strip.activeLevel(2) > strip.activeLevel(1), 'two saves is heavier than one');
  ok(strip.activeLevel(9) <= strip.ACTIVE_LEVELS, 'and it is capped — the scale cannot run away');
  eq(strip.activeLevel(50), strip.ACTIVE_LEVELS, 'a pathological bucket saturates rather than overflowing');
  eq(strip.BAR_HEIGHTS.length, strip.ACTIVE_LEVELS, 'the height ladder has exactly that many rungs');
  ok(strip.BAR_HEIGHTS.every((v, i) => i === 0 || v > strip.BAR_HEIGHTS[i - 1]),
    `and they rise strictly (${strip.BAR_HEIGHTS.join(' < ')}pt), so a busier cell is never drawn shorter`);

  // ONE save is unmistakably heavier than an empty bucket. This was
  // `ACTIVE_ALPHA_BASE > EMPTY_ALPHA + 0.3`; it is now a CONTRAST comparison,
  // and it caught a real defect — the first palette written had the lightest
  // green BELOW the empty grey. `scripts/test-tray-paint.js` §2 owns the
  // measurement; this is the structural half of it.
  // REVISED to the shipped vocabulary: an empty cell has no bar at all, so the
  // question "is one save distinguishable from none" is answered by SHAPE and
  // not by two colours being different. The bottom rung must clear the axis.
  for (const theme of ['light', 'dark']) {
    ok(strip.STRIP_PALETTE[theme].bar !== strip.STRIP_PALETTE[theme].axis,
      `${theme}: a bar and the axis are not the same colour`);
  }
  ok(strip.BAR_HEIGHTS[0] > strip.RULE_THICKNESS,
    'and the shortest bar stands clear of the 1pt axis, so ONE SAVE never reads as a thicker baseline');

  const b = new Array(28).fill(0);
  b[0] = 1; b[2] = 4;       // -> drawn 0 holds one save, drawn 1 holds four
  const d = decodeRgba(strip.renderPulseStrip(pulseFixture({ buckets: b, events: 5 }), { dark: false }).buffer);
  ok(JSON.stringify(cellColumn(d, 1)) !== JSON.stringify(cellColumn(d, 0)),
    'and the difference between one save and four survives into the actual pixels');
  // -- REVERSED, AND THIS IS THE HEADLINE REVERSAL OF THE RELEASE -------
  //
  // WAS: "both bars are exactly the same HEIGHT — a count is never drawn as a
  // taller bar, which would read as a productivity chart."
  //
  // The refusal it encoded is still respected; what changed is the finding that
  // the SHIPPED alternative broke it in substance. A five-rung colour ramp
  // encodes the identical quantity in the one channel that is illegible at
  // three points of width, so the count was being drawn either way — just
  // invisibly. And the ramp capped at five saves while real twelve-hour cells
  // hold 3 to 18, so it sat pinned at saturation: the fence the maintainer
  // reported.
  //
  // The progress-bar reading is now defeated STRUCTURALLY — a baseline axis and
  // a day ruler make the picture a time series — and by the copy, which says
  // "saves per 12 hours" and never "activity". Both are asserted below and in
  // test-tray-paint.js §5b.
  ok(inkedCount(cellColumn(d, 1)) > inkedCount(cellColumn(d, 0)),
    'and a four-save bar is TALLER than a one-save bar — the count is in the height, where it can be read');
  ok(/saves per/i.test(strip.pulseToolTip(fullWindow())) && !/activity/i.test(strip.pulseToolTip(fullWindow())),
    'with the reading anchored as a CADENCE in the legend — "saves per …", never "activity"');

  // The recorded refusal, asserted as copy rather than as a comment: nothing
  // the user reads may rank a dense column above a sparse one.
  const words = (strip.pulseLabel(fullWindow()) + ' ' + strip.pulseToolTip(fullWindow())).toLowerCase();
  for (const banned of ['productiv', 'progress', 'streak', 'score', 'goal', 'better', 'good day']) {
    ok(!words.includes(banned), `the copy never says "${banned}" — more saves is a different cadence, not more progress`);
  }
  ok(words.includes('save'), 'CONTROL: it does say "save", so the scan above is looking at real text');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5 the label: the window, the count, and the two honesty disclosures');
{
  const full = strip.pulseLabel(fullWindow());
  ok(/7 days/.test(full), `the label names the WINDOW — ${JSON.stringify(full)}`);
  ok(/28 saves/.test(full), 'and the count');

  // (1) coversWholeWindow === false. The strip does not span its own window, so
  // the label must not attach the count to a period the strip cannot speak for.
  const young = strip.pulseLabel(youngStore());
  ok(!/7 days/.test(young), `a partial window does NOT claim 7 days — ${JSON.stringify(young)}`);
  ok(/known/.test(young), 'it says how much is KNOWN instead');
  ok(/3 days|4 days/.test(young), 'and names that span, derived from firstKnownBucket');

  // (2) pairsTruncated > 0. The count is a FLOOR and the label says so.
  const trunc = strip.pulseLabel(pulseFixture({
    buckets: fullWindow().buckets, events: 28, pairsCounted: 8, pairsTruncated: 5,
  }));
  ok(/at least/.test(trunc), `a truncated read reports a FLOOR — ${JSON.stringify(trunc)}`);
  ok(!/at least/.test(full), 'CONTROL: an untruncated read does NOT, so that clause means something');

  // Both at once.
  const both = strip.pulseLabel(pulseFixture({
    buckets: youngStore().buckets, events: 13, firstKnownBucket: 14,
    coversWholeWindow: false, pairsTruncated: 2,
  }));
  ok(/known/.test(both) && /at least/.test(both), `both disclosures survive together — ${JSON.stringify(both)}`);
  ok(both.length <= 56, `and the pair still fits the width budget (${both.length} chars)`);

  // Nothing saved is a reading, and it is not the same sentence as no clock.
  const quiet = strip.pulseLabel(pulseFixture());
  ok(/no saves/.test(quiet), `an empty week says so — ${JSON.stringify(quiet)}`);
  ok(/7 days/.test(quiet), 'while still naming the window it looked at');

  const noClock = strip.pulseLabel(pulseFixture({ clock: 'none', buckets: fullWindow().buckets, events: 28 }));
  ok(/no save times/.test(noClock), `no clock is a DIFFERENT sentence — ${JSON.stringify(noClock)}`);
  ok(!/28 saves/.test(noClock), 'and it does not quote a count it has no times behind');

  // The three no-saves pictures are three different sentences. This is the
  // fact-versus-absence rule applied to copy rather than to pixels.
  const nothingKnown = strip.pulseLabel(pulseFixture({ firstKnownBucket: 28, coversWholeWindow: false }));
  const dormantLabel = strip.pulseLabel(pulseFixture({ coversWholeWindow: true, events: 0 }));
  const youngQuiet = strip.pulseLabel(pulseFixture({ firstKnownBucket: 14, coversWholeWindow: false }));
  ok(!/7 days/.test(nothingKnown),
    `with NOT ONE bucket known the label names no period at all — ${JSON.stringify(nothingKnown)}`);
  ok(!/no saves/.test(nothingKnown),
    'and does not say "no saves" about a week it knows nothing about — an entirely grey strip is not an empty one');
  ok(/7 days/.test(dormantLabel) && /no saves/.test(dormantLabel),
    `a COVERED quiet week does say exactly that — ${JSON.stringify(dormantLabel)}`);
  eq(new Set([nothingKnown, dormantLabel, youngQuiet]).size, 3,
    'and all three no-saves states read differently — nothing known, a quiet full week, and a quiet young store');

  // ── THE TOOLS CLAUSE, AND THE TWO CASES IT MUST BE SILENT IN ────────
  //
  // CHASED FROM A MUTATION THAT CAME BACK GREEN: loosening `n > 1` to `n > 0`
  // passed everything, because no fixture carried a harnessCount of exactly 1 —
  // which is EVERY single-tool store, i.e. most of them.
  const tools = (n) => strip.pulseLabel(pulseFixture({
    buckets: fullWindow().buckets, events: 28, harnessCount: n,
  }));
  ok(/· 2 tools/.test(tools(2)), `two tools is stated — ${JSON.stringify(tools(2))}`);
  ok(!/tool/.test(tools(1)),
    `ONE tool is silent — a token on every row of every single-tool store distinguishes nothing — ${JSON.stringify(tools(1))}`);
  ok(!/tool/.test(tools(0)),
    'and ZERO is silent too, because it is the ABSENCE of a measurement and not a measurement of none');
  ok(!/tool/.test(tools(undefined)), 'as is a producer that does not compute it at all');
  ok(/· 7 tools/.test(tools(7)), 'CONTROL — the clause really does render for larger counts');

  eq(strip.pulseLabel(null), null, 'no pulse, no label');
  eq(strip.pulseLabel(pulseFixture({ events: 1, buckets: (() => { const b = new Array(28).fill(0); b[27] = 1; return b; })() })).includes('1 save'), true,
    'one save is singular');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§6 the tooltip carries every fact the label had to compress');
{
  const p = pulseFixture({
    buckets: youngStore().buckets, events: 13, firstKnownBucket: 14,
    coversWholeWindow: false, pairsCounted: 8, pairsTruncated: 5,
    eventsOutsideWindow: 41, oldestEventAt: '2026-08-28T21:00:00.000Z', clock: 'agent',
  });
  const tip = strip.pulseToolTip(p);
  ok(/oldest on the left/i.test(tip), 'the tooltip says which way time runs');
  ok(/12 hours/.test(tip),
    'and how much time one DRAWN bar is — twelve, because two of the producer\'s six-hour buckets are folded into one cell');
  // REVISED WORDING, SAME RULE. Two of the three marks the old legend named —
  // the "low grey stub" and the "baseline hairline" — no longer exist: an empty
  // cell is the axis and an unknown one is that axis dotted. The legend names
  // the marks the picture actually has, and still names SHAPES rather than only
  // colours, which is the property the assertion exists for.
  ok(/bar height/i.test(tip) && /solid baseline/i.test(tip) && /dotted baseline/i.test(tip),
    'it carries the legend for every mark, naming their SHAPES and not only their colours');
  ok(/amber cap/i.test(tip), '…including the handover cap, which is the mark the widget exists for');
  ok(tip.includes('13'), 'the count');
  ok(/younger than the window/.test(tip), 'the partial-coverage fact');
  ok(tip.includes('5') && /floor/.test(tip), 'the truncation, named as a floor');
  ok(tip.includes('41'), 'and eventsOutsideWindow, which lives ONLY here');
  ok(tip.includes('2026-08-28T21:00:00.000Z'), 'plus the oldest save it saw, in full');
  // eventsOutsideWindow is deliberately absent from the label: older saves
  // existing is history, not a reason to distrust the drawing.
  ok(!strip.pulseLabel(p).includes('41'), 'the LABEL does not carry it — but the tooltip does, so nothing is lost');
  eq(strip.pulseToolTip(null), null, 'no pulse, no tooltip');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§7 the menu item: ON TOP, enabled, and a submenu parent when there are lanes (v3.74.0)');
{
  const summary = {
    ok: true, total: 1, pulse: youngStore(),
    scopes: [{
      project: 'projects', scope: 'session-2026-09-01-menubar-widget-design',
      machine: 'mac-9f3c1a', harness: 'claude-code', isThisMachine: true,
      writtenAgeSeconds: 800, ageSource: 'agent', headline: 'x'.repeat(200),
    }],
  };
  const m = model.buildTrayModel(summary, { now: NOW });
  ok(m.pulse !== null, 'the model carries a pulse when the summary does');
  ok(Buffer.isBuffer(m.pulse.strip.buffer) && Buffer.isBuffer(m.pulse.strip.buffer2x), 'including the 1x and 2x PNG bytes');
  eq(m.pulse.strip.template, false, 'and the spec the model carries says template:false');

  const seen = [];
  const t = menu.buildTrayMenuTemplate(m, { ...NOOPS, makeIcon: (s) => { seen.push(s); return { fake: 'image' }; } });
  // ON TOP, with no header above it: the "Working on" headline is gone, so the
  // pulse is the first line and the newest save is the SECOND — one line
  // higher than v3.72 put it, and said once.
  eq(t[0].id, menu.ID_PULSE, 'the pulse is the FIRST item of the menu');
  eq(t[1].type, 'separator', 'and a separator divides it from the activity below');
  ok(!menu.flattenTrayMenu(t).some((i) => i.id === 'tray-header-pulse' || i.id === 'tray-headline'),
    'the "Save pulse" header and the "Working on" headline are both gone');
  eq(t[0].enabled, true, 'it is drawn at FULL CONTRAST (a disabled item greys its strip — the v3.47 "barely visible" defect)');
  ok(typeof t[0].click === 'function' && !t[0].submenu,
    'with NO per-tool lanes in the summary it is a plain item that opens Project Context, as before');
  eq(t[0].icon, { fake: 'image' }, 'the injected makeIcon result becomes the item\'s icon');
  ok(seen.includes(m.pulse.strip), 'makeIcon is handed the strip itself, buffers and all');
  ok(typeof t[0].toolTip === 'string' && t[0].toolTip.length > 40, 'the item carries the full tooltip');
  eq(m.pulse.tools, [], 'no lanes in → no tools out, never an invented one');

  // With lanes, it becomes a SUBMENU PARENT — and a parent carries no click.
  const lanes = { ...youngStore(), harnessCount: 1, byHarness: {
    'claude-code': { label: 'Claude Code', buckets: youngStore().buckets, events: youngStore().events, lastSeenAt: new Date(NOW.getTime() - 3600e3).toISOString() },
    antigravity: { label: 'Antigravity', buckets: new Array(28).fill(0), events: 0, lastSeenAt: '2026-08-20T10:00:00Z' },
  } };
  const withLanes = model.buildTrayModel({ ...summary, pulse: lanes }, { now: NOW });
  const t2 = menu.buildTrayMenuTemplate(withLanes, { ...NOOPS, makeIcon: (s) => s });
  ok(Array.isArray(t2[0].submenu) && !t2[0].click, 'with lanes the pulse row is a submenu parent, with no click beside it');
  eq(t2[0].submenu[0].type, 'header', 'the submenu opens on a header …');
  eq(t2[0].submenu[0].label, 'Saves by tool · 7 days', '… "Saves by tool · 7 days", naming the window the strips share');
  eq(t2[0].submenu.slice(1).map((i) => i.label), ['Claude Code · ' + youngStore().events + ' saves', 'Antigravity · none · last 20 Aug'],
    'one line per tool, most saves first: a counted one, and a silent one with the day it was last seen');
  ok(t2[0].submenu.slice(1).every((i) => i.enabled === true && typeof i.click === 'function' && i.icon && i.icon.heightPoints === 15),
    'each lane carries its OWN strip (enabled, so it is not greyed) and opens Project Context');

  // With no makeIcon the reading survives without the picture.
  const noIcon = menu.buildTrayMenuTemplate(m, NOOPS)[0];
  ok(noIcon && noIcon.label === m.pulse.label && !('icon' in noIcon),
    'with no makeIcon the item still appears, label intact, and simply carries no icon key');
  const bare = model.buildTrayModel({ ...summary, pulse: null }, { now: NOW });
  eq(bare.pulse, null, 'no pulse in the summary, none in the model');
  ok(!menu.flattenTrayMenu(menu.buildTrayMenuTemplate(bare, NOOPS)).some((i) => i.id === menu.ID_PULSE),
    'and no strip item in the menu — an absent measurement is not a blank rectangle');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§8 the tools clause: ONE tool is NAMED, many are counted, none is silent');
{
  const lane = (label, events, lastSeenAt = null) => ({ label, buckets: new Array(28).fill(0).map((_, i) => (i === 27 ? events : 0)), events, lastSeenAt });
  const base = fullWindow();
  const one = { ...base, harnessCount: 1, byHarness: { 'claude-code': lane('Claude Code', base.events), antigravity: lane('Antigravity', 0, '2026-08-20T10:00:00Z') } };
  eq(strip.pulseLabel(one), 'Save pulse · 7 days · ' + base.events + ' saves · Claude Code',
    'ONE tool saved this week → it is NAMED, so a silent second harness is an absence you can read');
  const two = { ...base, harnessCount: 2, byHarness: { 'claude-code': lane('Claude Code', base.events - 2), antigravity: lane('Antigravity', 2) } };
  ok(/ · 2 tools$/.test(strip.pulseLabel(two)), 'two tools saved → "2 tools", as before');
  ok(!/tool|Claude/.test(strip.pulseLabel({ ...base, harnessCount: 0 })), 'ZERO is silent — no harness named anywhere is not "0 tools"');
  ok(!/Claude|tool/.test(strip.pulseLabel({ ...base, harnessCount: 1 })),
    'ONE tool counted but NO lane to name it → silent, never an id or a guess');
  ok(!/claude-code/.test(strip.pulseLabel({ ...base, harnessCount: 1, harnesses: ['claude-code'] })),
    'the data layer\'s `harnesses` is a list of IDS — an id is never printed as a name');
  eq(strip.pulseLabel({ ...base, harnessCount: 1, byHarness: { x: lane('A tool with a very long name', base.events) } }),
    'Save pulse · 7 days · ' + base.events + ' saves · 1 tool',
    `a name longer than ${strip.PULSE_TOOL_NAME_CHARS} characters falls back to "1 tool" — the clause stays bounded`);
  ok(/One agent tool wrote inside this window: Claude Code\./.test(strip.pulseToolTip(one)),
    'the tooltip says the same thing in a sentence');
  // THE MAINTAINER'S REAL PULSE read `4 tools` for claude-code / Claude Code /
  // Claude Code (desktop) / antigravity — two tools spelled four ways. The
  // lanes are keyed by the normalised id, so where they exist they ARE the count.
  const spelled = { ...base, harnessCount: 4, byHarness: { 'claude-code': lane('Claude Code', base.events - 3), antigravity: lane('Antigravity', 3) } };
  ok(/ · 2 tools$/.test(strip.pulseLabel(spelled)),
    `a raw harnessCount of 4 over two NORMALISED lanes reads "2 tools" (${strip.pulseLabel(spelled)})`);
  ok(/^2 different agent tools/m.test(strip.pulseToolTip(spelled)), '…and so does the tooltip');
  ok(/ · 4 tools$/.test(strip.pulseLabel({ ...base, harnessCount: 4 })),
    'CONTROL — with no lanes the producer\'s own count is used, so the lane rule above is doing the work');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§9 Saves by tool — one lane per harness, read defensively');
{
  const at = (h) => new Date(NOW.getTime() - h * 3600e3).toISOString();
  const b = (n) => new Array(28).fill(0).map((_, i) => (i === 27 ? n : 0));
  const p = { ...fullWindow(), pairsTruncated: 0, byHarness: {
    antigravity: { label: 'Antigravity', buckets: b(0), events: 0, lastSeenAt: '2026-08-20T10:00:00Z' },
    'claude-code': { label: 'Claude Code', buckets: b(12), events: 12, lastSeenAt: at(1) },
    'claude-desktop': { label: 'Claude Desktop', buckets: b(3), events: 3, lastSeenAt: at(30) },
    broken: 'not an object',
    nolabel: { buckets: b(1), events: 1, lastSeenAt: at(2) },
    nocount: { label: 'X' },
  } };
  const lanes = strip.harnessPulses(p);
  eq(lanes.map((l) => l.id), ['claude-code', 'claude-desktop', 'nolabel', 'antigravity'],
    'most saves first, then the most recently seen; a non-object and a lane with no count are DROPPED, never drawn as zero');
  eq(lanes.find((l) => l.id === 'nolabel').label, 'nolabel', 'a lane with no label is named by its id rather than dropped');
  const cc = lanes[0];
  eq([cc.pulse.buckets, cc.pulse.events, cc.pulse.harnessCount, cc.pulse.windowSeconds, cc.pulse.firstKnownBucket],
    [b(12), 12, 1, p.windowSeconds, p.firstKnownBucket],
    'a lane\'s pulse is the WHOLE STORE\'S window with that tool\'s buckets and count — so the strips line up cell for cell');
  ok(cc.pulse.harnessChanges === undefined, 'and no handover caps: a change of tool has nothing to say inside one tool\'s lane');
  ok(strip.renderPulseStrip(cc.pulse) && strip.renderPulseStrip(cc.pulse).widthPoints === strip.renderPulseStrip(p).widthPoints,
    'a lane renders through the SAME renderer at the SAME width as the pulse row');
  eq(strip.harnessPulseLabel(cc, p), 'Claude Code · 12 saves', 'a counted lane: "Claude Code · 12 saves"');
  eq(strip.harnessPulseLabel(lanes[3], p), 'Antigravity · none · last 20 Aug', 'a silent lane: "none · last 20 Aug"');
  const floor = { ...p, byHarnessFloor: true, byHarnessNote: 'At least these counts: 2 journals were read only from the newest 16 KB.' };
  eq(strip.harnessPulseLabel(cc, floor), 'Claude Code · at least 12 saves', 'a FLOOR says "at least" …');
  eq(strip.harnessPulseLabel(lanes[3], floor), 'Antigravity · none · last seen 20 Aug',
    '… and "last SEEN": a tail can hide a later save, so the date is when it was seen, not provably its last');
  eq(strip.harnessPulseLabel({ ...lanes[3], lastSeenAt: null }, p), 'Antigravity · none', 'no date known → no date invented');
  eq(strip.harnessPulses({ ...p, byHarness: null }), [], 'no byHarness → no lanes');
  eq(strip.harnessPulses({ ...p, byHarness: [1, 2] }), [], 'an ARRAY where an object belongs → no lanes, not a crash');
  eq(strip.windowWords(p), '7 days', 'the header\'s window is the pulse\'s own words');

  // Through the model: the note reaches every lane's tooltip, verbatim.
  const m = model.buildTrayModel({ ok: true, scopes: [], pulse: floor }, { now: NOW });
  ok(m.pulse.tools.length === 4 && m.pulse.tools.every((t) => t.toolTip.includes(floor.byHarnessNote)),
    'the data layer\'s floor note is on every lane\'s tooltip, word for word');
  ok(m.pulse.tools.every((t) => t.strip === null || t.strip.heightPoints === 15), 'each lane carries its own strip spec');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§10 width — the pulse row and its lanes, MEASURED, including what the tool name costs');
{
  // A lane label never cuts its count: the budget is the pulse row's.
  const budget = model.pulseLabelBudget(55);
  const lanes = { ...fullWindow(), byHarnessFloor: true, byHarness: {
    'copilot-cli': { label: 'GitHub Copilot CLI', buckets: new Array(28).fill(1), events: 9999, lastSeenAt: null },
  } };
  const m = model.buildTrayModel({ ok: true, scopes: [], pulse: lanes }, { now: NOW });
  ok(m.pulse.tools[0].label === 'GitHub Copilot CLI · at least 9999 saves' && m.pulse.tools[0].label.length <= budget,
    `the longest known tool with a four-digit floor reads whole within the ${budget}-character budget`);
  // THE COST OF NAMING THE TOOL, stated rather than discovered on a photograph.
  // The maintainer's own reading is `7 days · at least 192 saves · Claude Code`
  // (41 characters). The width arithmetic gives the strip row 33; the budget
  // is the LARGER of that and the longest reading, so it is not cut — and it
  // is wider than the measured 363.5pt menu. Asserted as a number so the
  // photograph review knows what to look for.
  const real = { ...fullWindow(), events: 192, pairsTruncated: 3, harnessCount: 1,
    byHarness: { 'claude-code': { label: 'Claude Code', buckets: new Array(28).fill(7), events: 192, lastSeenAt: null } } };
  const label = model.buildTrayModel({ ok: true, scopes: [], pulse: real }, { now: NOW }).pulse.label;
  eq(label, '7 days · at least 192 saves · Claude Code', 'the maintainer\'s reading is whole');
  const pts = label.length * model.MENU_CHAR_POINTS + 55 + model.MENU_ICON_GAP_POINTS + model.MENU_CHROME_POINTS;
  ok(pts > model.MENU_WIDTH_POINTS && pts < model.MENU_WIDTH_POINTS * 1.15,
    `KNOWN COST: that row is ~${pts.toFixed(1)}pt against the measured ${model.MENU_WIDTH_POINTS}pt menu — about ${(pts - model.MENU_WIDTH_POINTS).toFixed(0)}pt wider, under 15%. To be confirmed on a photograph.`);
  const noName = label.replace(/ · Claude Code$/, '');
  ok(noName.length * model.MENU_CHAR_POINTS + 55 + model.MENU_ICON_GAP_POINTS + model.MENU_CHROME_POINTS <= model.MENU_WIDTH_POINTS,
    'CONTROL — without the tool name the same row fits the menu, so the cost above is the name\'s and nothing else\'s');
}


// ═══════════════════════════════════════════════════════════════════════════
section('§11 main.js source scan — WEAK, and it says so');
//
// main.js cannot be imported, evaluated or run: Electron is not an offline
// dependency. Everything below proves a line was WRITTEN and nothing about what
// it does. It is here only because the two Electron calls the strip needs
// cannot live anywhere the suite can execute.
{
  const src = readFileSync(path.join(DESKTOP, 'main.js'), 'utf8');
  ok(/makeIcon:\s*menuImage/.test(src), 'SCAN ONLY: the menu is built with the shared icon factory');
  ok(/function menuImage/.test(src), 'SCAN ONLY: and that factory exists');
  const fn = src.slice(src.indexOf('function menuImage'), src.indexOf('function trayImage'));
  ok(/nativeImage\.createFromBuffer\(spec\.buffer,\s*\{\s*scaleFactor:\s*1\s*\}\)/.test(fn),
    'SCAN ONLY: the 1x buffer is built at scaleFactor 1');
  ok(/addRepresentation\(\{\s*scaleFactor:\s*2,\s*buffer:\s*spec\.buffer2x\s*\}\)/.test(fn),
    'SCAN ONLY: and the 2x buffer is added as a second representation');
  // THE ASSERTION THAT REVERSED, AND WHY IT IS THE POINT OF THE CHANGE.
  // This used to require a hardcoded `setTemplateImage(true)`. A template image
  // carries ONLY alpha and macOS tints it — correct for the tray GLYPH, and the
  // reason the shipped strip rendered as a ghost. The factory must now honour
  // the SPEC, so a colour image stays colour and the glyph stays a template.
  ok(/setTemplateImage\(spec\.template === true\)/.test(fn),
    'SCAN ONLY: the factory honours spec.template rather than hardcoding it — a hardcoded true is what made the strip a ghost');
  ok(!/setTemplateImage\(true\)/.test(fn),
    'SCAN ONLY: and it does NOT hardcode true, which would re-tint the colour art to the disabled text colour');
  ok(/catch\s*\{\s*\n\s*return null;/.test(fn),
    'SCAN ONLY: and it returns null rather than throwing, because a menu item that throws while being BUILT takes the whole menu');
  // The decisions must NOT be here. A geometry constant appearing in main.js
  // would mean a second opinion about the drawing in the one file no test runs.
  ok(!/CELL_POINTS|GAP_POINTS|firstKnownBucket|pulseCells/.test(src),
    'and NO drawing decision leaked into main.js — the geometry lives only where the suite can execute it');
}

console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
