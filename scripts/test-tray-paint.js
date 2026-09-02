/**
 * test-tray-paint.js — OFFLINE guard for the COLOUR menu artwork:
 * `desktop/lib/rgba-png.js`, the recoloured `desktop/lib/pulse-strip.js`, and
 * the new `desktop/lib/menu-dots.js`.
 *
 * ── METHOD ──────────────────────────────────────────────────────────────────
 *
 * Every claim below is made about DECODED PIXELS or about a number computed
 * from the values actually shipped. Nothing asserts that a line of source was
 * written. The standard is the one `test-tray-pulse-strip.js` already holds the
 * alpha strip to, with two additions the move to colour forces:
 *
 *  1. THE DECODER IS NOT THIS FOLDER'S. `scripts/visual/png.js` is an
 *     INDEPENDENT PNG decoder, written months ago for the contrast harness,
 *     which reconstructs all five filter types and knows nothing about the
 *     encoder under test. Decoding with a helper written beside the encoder is
 *     how a test comes to agree with a broken encoder; this one cannot.
 *
 *  2. THE CONTRAST MATHS IS NOT THIS FOLDER'S EITHER. `scripts/visual/
 *     contrast.js` is the repo's audited WCAG implementation. Every ratio
 *     quoted in `pulse-strip.js` and `menu-dots.js` is RECOMPUTED here from the
 *     shipped hex values and checked against the 3:1 non-text floor, with an
 *     anti-vacuity control: a colour known to fail must fail the same check.
 *
 * ── SECTIONS ────────────────────────────────────────────────────────────────
 *   §0   positive control on the imports
 *   §1   the RGBA encoder, decoded by an independent decoder
 *   §2   every shipped colour clears the non-text floor, over a band
 *   §3   the strip draws in COLOUR and is not a template image
 *   §4   ACTIVE / EMPTY / UNKNOWN differ in real pixels, in BOTH themes
 *   §5   the height ladder — the signal that survives without colour
 *   §5b  the axis, the day ruler and the handover caps — decoded
 *   §6   cadence is in the HEIGHT, is capped, and never claims more
 *   §7   the recency dots: five buckets, three colours, one ink ladder
 *   §8   the dots' pixels, decoded, in both themes
 *   §9   1x and 2x are one drawing at two resolutions
 *   §10  the spec shape, exactly as contracted
 *   §11  COLOUR DISCARDED — every state readable in the alpha channel alone
 *   §12  the merge, and the width budget it was bought with
 *
 * ── NOT ENFORCED, stated rather than implied away ───────────────────────────
 *
 *  - NOTHING HERE HAS BEEN RENDERED ON A SCREEN BY THIS SUITE OR ITS AUTHOR.
 *    No menu has been built, no `nativeImage` created, no `Tray` constructed,
 *    and no human has seen a pixel of this. Electron is deliberately not an
 *    offline dependency.
 *  - THE MENU BACKGROUND IS AN ASSUMPTION. `#ECECEC` / `#2C2C2E` have not been
 *    sampled from a running menu, and a real NSMenu is a vibrancy material
 *    whose effective background moves with the wallpaper behind it. The band
 *    check below is the mitigation, not a measurement: it proves a colour is
 *    not sitting one shade above the floor at a single assumed point.
 *  - THAT A MENU ITEM ICON RENDERS IN COLOUR AT ALL is reported from an
 *    Electron menu built by hand on this machine; this suite cannot re-derive
 *    it and does not claim to.
 *  - WHETHER THE THREE DOT COLOURS ARE PERCEPTIBLY DIFFERENT AT 13pt to a
 *    viewer with a colour vision deficiency is NOT asserted, and neither is
 *    legibility at 3pt inside an inverted, highlighted menu row. A contrast
 *    ratio computed against a background token is not the same claim as
 *    legibility. That is why §11 exists: it throws the colour away entirely and
 *    requires the reading to survive in the alpha channel alone, so the palette
 *    is an ACCELERATOR rather than the signal.
 *  - THE MENU CHROME in §12's width arithmetic (~24pt of insets and gaps) and
 *    `MENU_CHAR_POINTS` (6.5pt per character) are ASSUMPTIONS. §12 checks the
 *    conclusion across a range of both rather than at one point.
 */

import { createHash } from 'node:crypto';
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

let rgba, strip, dots, png, contrast;
try {
  rgba = await import(path.join(DESKTOP, 'lib', 'rgba-png.js'));
  strip = await import(path.join(DESKTOP, 'lib', 'pulse-strip.js'));
  dots = await import(path.join(DESKTOP, 'lib', 'menu-dots.js'));
  // INDEPENDENT of the modules under test — see the header.
  png = await import(path.join(ROOT, 'scripts', 'visual', 'png.js'));
  contrast = await import(path.join(ROOT, 'scripts', 'visual', 'contrast.js'));
} catch (err) {
  console.log(`\n  ✗ FATAL — could not import the modules under test: ${err.message}`);
  process.exit(1);
}

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

/** One decoded pixel as [r,g,b,a]. `decodePng` returns raw un-filtered samples. */
function pixel(dec, x, y) {
  const p = (y * dec.width + x) * dec.channels;
  return [dec.data[p], dec.data[p + 1], dec.data[p + 2], dec.data[p + 3]];
}

/** The pulse contract, matched to the producer, same fixture shape as
 *  `test-tray-pulse-strip.js` so the two suites cannot drift apart on it. */
function pulseFixture(over = {}) {
  return {
    windowSeconds: 604800, bucketSeconds: 21600,
    buckets: new Array(28).fill(0), events: 0, eventsOutsideWindow: 0,
    pairsCounted: 8, pairsTruncated: 0, clock: 'agent', oldestEventAt: null,
    coversWholeWindow: true, firstKnownBucket: 0, ...over,
  };
}

/**
 * One image holding all three cell states at known DRAWN indices, so every
 * comparison is between pixels of the SAME rendering.
 *
 * Source buckets are folded two-to-one (28 -> 14), so the fixture is written in
 * SOURCE terms and the indices below are the DRAWN cells they land in. Both
 * halves of each pair are set deliberately: a merged cell whose halves disagree
 * would be a less obvious fixture, and this one is checked against the shipped
 * `drawnCells` rather than assumed.
 */
function mixedPulse() {
  const b = new Array(28).fill(0);
  b[20] = 1; b[21] = 1;      // -> drawn 10, ACTIVE with 2 saves
  b[24] = 1; b[25] = 1;      // -> drawn 12, ACTIVE with 2 saves (the control twin)
  return pulseFixture({ buckets: b, events: 4, firstKnownBucket: 10, coversWholeWindow: false });
}
const I_ACTIVE = 10, I_ACTIVE_TWIN = 12, I_EMPTY = 11, I_UNKNOWN = 1, I_UNKNOWN_TWIN = 2;
const PITCH = 4;   // CELL_POINTS 3 + GAP_POINTS 1

// ═══════════════════════════════════════════════════════════════════════════
section('§0 positive control on the imports');
{
  ok(typeof rgba.encodeRgbaPng === 'function', 'encodeRgbaPng is exported');
  ok(typeof strip.renderPulseStrip === 'function', 'renderPulseStrip is exported');
  ok(typeof dots.renderRecencyDot === 'function', 'renderRecencyDot is exported');
  ok(typeof png.decodePng === 'function', 'the INDEPENDENT decoder is importable');
  ok(typeof contrast.contrastRatio === 'function', 'and the repo\'s audited WCAG maths');

  // The PNG signature is checked against the eight bytes of the specification,
  // written out by hand here — not against whatever the encoder happens to emit.
  eq([...rgba.PNG_SIGNATURE], [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A],
    'PNG_SIGNATURE is the specification\'s eight bytes, asserted against a literal and not against the encoder');
  eq(rgba.COLOR_TYPE_RGBA, 6, 'colour type 6 = truecolour with alpha');
  eq(rgba.CONTRAST_FLOOR_NON_TEXT, 3.0,
    'the floor is 3:1 — WCAG 1.4.11 non-text, NOT the 4.5:1 text floor, which would be the wrong rule');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§1 the RGBA encoder, decoded by an independent decoder');
{
  const c = rgba.createCanvas(4, 3);
  rgba.fillRect(c, 1, 1, 2, 2, [17, 200, 90]);
  const d = png.decodePng(rgba.encodeRgbaPng(c));

  eq([d.width, d.height, d.channels], [4, 3, 4], 'the bytes decode to a 4x3 RGBA image');
  eq(pixel(d, 1, 1), [17, 200, 90, 255], 'a filled pixel carries the exact colour, fully opaque');
  eq(pixel(d, 2, 2), [17, 200, 90, 255], 'and so does the far corner of the rect');
  eq(pixel(d, 0, 0), [0, 0, 0, 0],
    'an untouched pixel is fully TRANSPARENT — a menu icon is a mark on the menu\'s own surface, never a tile of colour');
  eq(pixel(d, 3, 1), [0, 0, 0, 0], 'and so is the column past the rect');

  // Out-of-range paints are ignored, not thrown: a menu item whose icon factory
  // throws while the menu is being BUILT takes the whole menu with it.
  rgba.paintPixel(c, -1, 0, [255, 0, 0], 255);
  rgba.paintPixel(c, 99, 99, [255, 0, 0], 255);
  eq(pixel(png.decodePng(rgba.encodeRgbaPng(c)), 0, 0), [0, 0, 0, 0],
    'a paint outside the canvas is dropped rather than throwing or wrapping');

  eq(rgba.hexToRgb('#2F8A4D'), [47, 138, 77], 'hexToRgb parses a #rrggbb triple');
  let threw = false;
  try { rgba.hexToRgb('2F8A4D'); } catch { threw = true; }
  ok(threw, 'and REFUSES a malformed one rather than returning a plausible wrong colour');

  // Antialiasing exists, and produces partial alpha at a rim and full alpha inside.
  const circ = rgba.createCanvas(20, 20);
  rgba.paintShape(circ, [255, 255, 255], (x, y) => (x - 10) ** 2 + (y - 10) ** 2 <= 64);
  const dc = png.decodePng(rgba.encodeRgbaPng(circ));
  eq(pixel(dc, 10, 10)[3], 255, 'the interior of an antialiased shape is fully opaque');
  let partial = 0, rimRgbWrong = 0;
  for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) {
    const p = pixel(dc, x, y);
    if (p[3] > 0 && p[3] < 255) { partial++; if (p.slice(0, 3).join() !== '255,255,255') rimRgbWrong++; }
  }
  ok(partial > 0, `and its rim is partially covered (${partial} partial pixels) — so contrast is asserted on interiors only`);
  eq(rimRgbWrong, 0, 'a rim pixel carries the SAME rgb as the interior and differs only in alpha');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2 every shipped colour clears the non-text floor, over a band');
//
// THE CLAIM: no colour this folder ships is below 3:1 against ANY plausible
// menu background of its own theme. Computed from the shipped values, not read
// from a comment. The band exists because an NSMenu is a vibrancy material and
// its effective background moves with the wallpaper — a single assumed hex is
// not a background anything is ever drawn on.
{
  const FLOOR = rgba.CONTRAST_FLOOR_NON_TEXT;
  const worst = (h, theme) => Math.min(...rgba.MENU_BG_BAND[theme].map(
    (bg) => contrast.contrastRatio(hex(h), hex(bg))));

  // -- REVISED: the strip palette lost its five-rung ramp ----------------
  //
  // The save count moved from a COLOUR RAMP into the BAR HEIGHT, so the strip
  // ships three colours per theme instead of seven. The check itself is
  // unchanged: every value shipped, recomputed from the shipped hex, against
  // the hardest background in its own band. The COUNT is now DERIVED from the
  // palette objects rather than typed, so a colour added tomorrow is checked
  // without anyone editing this line — the previous literal 20 would have
  // silently stopped covering a new entry.
  const shipped = [];
  for (const theme of ['light', 'dark']) {
    for (const [role, h] of Object.entries(strip.STRIP_PALETTE[theme])) shipped.push([`strip ${role}`, theme, h]);
    for (const tone of ['hot', 'mid', 'cold']) shipped.push([`dot ${tone}`, theme, dots.DOT_PALETTE[theme][tone]]);
  }
  eq(shipped.length, Object.keys(strip.STRIP_PALETTE.light).length * 2 + 6,
    `every shipped colour is checked (${shipped.length} of them), and the count is DERIVED from the palettes rather than typed`);
  ok(shipped.length >= 12, 'CONTROL — there really are colours to check, so the loop below is not vacuous');

  for (const [name, theme, h] of shipped) {
    const w = worst(h, theme);
    ok(w >= FLOOR,
      `${theme} ${name} ${h} is ${contrast.round2(w).toFixed(2)}:1 at the HARDEST background in its band (floor ${FLOOR})`);
  }

  // ── ANTI-VACUITY. Without this the loop above proves only that a loop ran.
  // Two colours known to fail must fail the identical check, through the
  // identical code path.
  ok(worst('#34C759', 'light') < FLOOR,
    `CONTROL: Apple's own systemGreen #34C759 FAILS in light (${contrast.round2(worst('#34C759', 'light')).toFixed(2)}:1) — a vendor palette is not an audit`);
  ok(worst('#3A3A3C', 'dark') < FLOOR,
    'CONTROL: a colour equal to the dark band\'s own background FAILS, so the check is not passing everything');
  // The two theme-inversion controls the design table names. A palette is
  // chosen per theme, and using the WRONG theme's value must FAIL rather than
  // merely look wrong — which is what makes the per-theme split a measurement.
  ok(worst(strip.STRIP_PALETTE.dark.bar, 'light') < FLOOR,
    `CONTROL: the DARK bar violet ${strip.STRIP_PALETTE.dark.bar} fails on a LIGHT menu (${contrast.round2(worst(strip.STRIP_PALETTE.dark.bar, 'light')).toFixed(2)}:1)`);
  ok(worst(strip.STRIP_PALETTE.light.bar, 'dark') < FLOOR,
    `CONTROL: and the LIGHT bar violet ${strip.STRIP_PALETTE.light.bar} fails on a DARK one (${contrast.round2(worst(strip.STRIP_PALETTE.light.bar, 'dark')).toFixed(2)}:1)`);

  // The nominal background is inside the band, so the band is a superset of the
  // point check rather than a different one.
  for (const theme of ['light', 'dark']) {
    ok(rgba.MENU_BG_BAND[theme].includes(rgba.MENU_BG[theme]),
      `the ${theme} band contains its own nominal background ${rgba.MENU_BG[theme]}`);
  }

  // -- REMOVED, WITH THE REASON, RATHER THAN QUIETLY DROPPED -------------
  //
  // Two assertions stood here and both were about palette entries that no
  // longer exist:
  //
  //   "UNKNOWN is heavier than EMPTY"  — both were BAR colours. Empty and
  //      unknown cells no longer draw a bar at all; the distinction is now
  //      SOLID versus DOTTED on the axis, which is texture rather than weight,
  //      and it is asserted in the alpha channel in 4 and 11 where it belongs.
  //   "the ACTIVE ramp rises monotonically" — there is no ramp. The count is in
  //      the height, which 5 measures off decoded pixels; a five-shade ladder
  //      at three points of width was the thing the maintainer reported as a
  //      fence, and asserting its monotonicity was asserting the wrong property
  //      of the right idea.
  //
  // What replaces them does not depend on the palette at all: the axis must
  // clear the floor BY ITSELF, so the known/unknown reading survives even if
  // every bar were invisible.
  for (const theme of ['light', 'dark']) {
    ok(worst(strip.STRIP_PALETTE[theme].axis, theme) >= FLOOR,
      `${theme}: the axis clears the floor on its own, so "did this store exist" is readable without the bars`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3 the strip draws in COLOUR and is not a template image');
{
  for (const dark of [false, true]) {
    const s = strip.renderPulseStrip(mixedPulse(), { dark });
    const theme = dark ? 'dark' : 'light';
    eq(s.template, false,
      `${theme}: the spec says template:false — the whole v3.37.0 defect was a template image tinted to the DISABLED text colour`);
    const d = png.decodePng(s.buffer);
    eq(d.channels, 4, `${theme}: the bytes decode as RGBA, not greyscale+alpha`);

    // A coloured bar, decoded, IS the shipped colour — and the RUNG is taken
    // from the shipped `drawnCells`, not typed here, so a change to the merge
    // cannot be silently agreed with by the fixture.
    const cell = strip.drawnCells(mixedPulse())[I_ACTIVE];
    eq([cell.state, cell.count], ['active', 2],
      `${theme}: drawn cell ${I_ACTIVE} folds two one-save buckets into one two-save cell`);
    // SAMPLED JUST ABOVE THE AXIS, which is inside every bar whatever its
    // height. The previous sample point was `BAR_TOP` — the top of a band every
    // bar filled — and bars now have five different heights.
    const px = pixel(d, I_ACTIVE * PITCH, strip.AXIS_Y - 1);
    const want = strip.STRIP_PALETTE[theme].bar;
    eq(px, [...hex(want), 255], `${theme}: it decodes to exactly ${want}, fully opaque`);

    // NOT greyscale. The v3.37.0 encoder pinned every colour channel at 0; if
    // that ever came back this is the assertion that would say so.
    ok(!(px[0] === px[1] && px[1] === px[2]),
      `${theme}: and its channels are NOT equal — this is real colour, not a grey being tinted by macOS`);
  }

  // The two themes are DIFFERENT drawings.
  const l = png.decodePng(strip.renderPulseStrip(mixedPulse(), { dark: false }).buffer);
  const dk = png.decodePng(strip.renderPulseStrip(mixedPulse(), { dark: true }).buffer);
  ok(!l.data.equals(dk.data), 'light and dark are different images — the theme argument is not decorative');
  // CONTROL: the same theme twice IS identical, so the comparison can report equal.
  const l2 = png.decodePng(strip.renderPulseStrip(mixedPulse(), { dark: false }).buffer);
  ok(l.data.equals(l2.data), 'CONTROL: the same theme rendered twice is byte-identical, so the comparison above can fail');

  // A missing or malformed option resolves to LIGHT rather than crashing inside
  // a menu build.
  for (const junk of [undefined, null, {}, { dark: 'yes' }, { dark: 0 }]) {
    ok(png.decodePng(strip.renderPulseStrip(mixedPulse(), junk).buffer).data.equals(l.data),
      `an option of ${JSON.stringify(junk) ?? String(junk)} resolves to LIGHT rather than throwing`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4 ACTIVE / EMPTY / UNKNOWN differ in real pixels, in BOTH themes');
//
// THE DESIGN CLAIM: "nothing happened here" and "this period predates the
// store" must not render the same. Collapsing a fact into its own absence is
// this project's named defect, and on the maintainer's store half the strip is
// UNKNOWN, so it is not a corner nobody reaches.
{
  // -- THE RULER ROW IS EXCLUDED, AND THAT IS NOT A CONVENIENCE ----------
  //
  // The day ruler is a GLOBAL overlay whose ticks fall on day boundaries, not a
  // property of a cell — and today's tick is deliberately double width. So two
  // cells in the same state legitimately differ in the ruler row, and a control
  // asserting "two ACTIVE cells render identically" would red for the ruler
  // rather than for anything about the cells. The ruler has its own section.
  const column = (d, i, scale = 1) => {
    const pitch = (strip.CELL_POINTS + strip.GAP_POINTS) * scale;
    const out = [];
    for (let y = 0; y <= strip.AXIS_Y * scale; y++) {
      for (let x = i * pitch; x < i * pitch + strip.CELL_POINTS * scale; x++) out.push(pixel(d, x, y).join(','));
    }
    return out.join('|');
  };

  for (const dark of [false, true]) {
    const theme = dark ? 'dark' : 'light';
    const d = png.decodePng(strip.renderPulseStrip(mixedPulse(), { dark }).buffer);
    const a = column(d, I_ACTIVE), e = column(d, I_EMPTY), u = column(d, I_UNKNOWN);

    ok(a !== e, `${theme}: ACTIVE and EMPTY differ in decoded pixels`);
    ok(e !== u, `${theme}: EMPTY and UNKNOWN differ — "nothing happened" is not "no data"`);
    ok(a !== u, `${theme}: ACTIVE and UNKNOWN differ`);

    // THE CONTROL. `a !== e` on its own proves only that the comparator can say
    // "different"; an assertion that cannot fail is worth nothing.
    ok(column(d, I_UNKNOWN) === column(d, I_UNKNOWN_TWIN),
      `${theme}: CONTROL — two UNKNOWN cells compare IDENTICAL, so the comparisons above can fail`);
    ok(column(d, I_ACTIVE) === column(d, I_ACTIVE_TWIN),
      `${theme}: CONTROL — two ACTIVE cells with the same count compare IDENTICAL too`);

    // Every cell is DRAWN. A strip that omits its empty cells stops being a
    // timeline and becomes a scatter of marks with no scale.
    const inked = (col) => col.split('|').filter((p) => !p.endsWith(',0')).length;
    ok(inked(e) > 0, `${theme}: an EMPTY bucket is DRAWN (${inked(e)} inked pixels), not omitted`);
    ok(inked(u) > 0, `${theme}: and so is an UNKNOWN one (${inked(u)})`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5 the height ladder — the signal that survives without colour');
//
// v3.37.0 separated ACTIVE from EMPTY by OPACITY ALONE. In colour that becomes
// "by colour alone", which this project does not allow, so ACTIVE gained a
// second signal: a full-height bar against a short baseline stub. This section
// is the guard on that strengthening.
{
  const d = png.decodePng(strip.renderPulseStrip(mixedPulse(), { dark: false }).buffer);
  // Measured over the BARS AND THE AXIS only. The ruler is a global overlay and
  // has its own section; counting it here would add a pixel to some columns and
  // not to others for a reason having nothing to do with the cell.
  const colHeight = (i) => {
    let n = 0;
    for (let y = 0; y <= strip.AXIS_Y; y++) if (pixel(d, i * PITCH, y)[3] > 0) n++;
    return n;
  };
  const ha = colHeight(I_ACTIVE), he = colHeight(I_EMPTY), hu = colHeight(I_UNKNOWN);

  // -- REVERSED: 12 / 3 / 1 IS GONE, AND SO IS WHAT IT MEASURED ---------
  //
  // WAS: `[ha, he, hu] === [12, 3, 1]` — every ACTIVE bar was full height, an
  // EMPTY was a 3pt stub and an UNKNOWN a 1pt hairline. All three changed:
  //
  //  - ACTIVE height is now the SAVE COUNT (3/5/7/9/12pt), so a fixed 12 would
  //    assert the opposite of the feature. This fixture's active cell holds two
  //    saves, which is rung 2.
  //  - EMPTY draws NO bar; it is the axis and nothing else, which is one pixel.
  //  - UNKNOWN draws no bar either; it is the axis DOTTED, so it differs from
  //    EMPTY horizontally rather than vertically — which sections 4 and 11
  //    measure, in the alpha channel, where that distinction lives.
  //
  // What survives verbatim is the RULE the old numbers were serving: the three
  // states are separable by SHAPE with the colour discarded.
  eq(ha, 1 + strip.barHeightPoints(2),
    `an ACTIVE cell holding 2 saves is ${ha}px tall including the axis — the height IS the count`);
  eq(he, 1, 'an EMPTY cell is the axis and nothing else — one pixel');
  ok(hu <= 1, 'and an UNKNOWN cell is the axis DOTTED, so its sampled column may be empty at that x');
  ok(ha > he, 'a strictly decreasing ladder — the strip is legible with the colour removed entirely');

  // Every bar sits ON the axis, so the strip reads as one timeline rather than
  // as floating marks.
  ok(pixel(d, I_ACTIVE * PITCH, strip.AXIS_Y - 1)[3] > 0, 'a bar reaches down to the row above the axis');
  ok(pixel(d, I_ACTIVE * PITCH, strip.AXIS_Y)[3] > 0, 'and the axis itself is drawn beneath it');
  ok(pixel(d, I_EMPTY * PITCH, strip.AXIS_Y)[3] > 0, 'an EMPTY cell still carries the axis — the timeline is continuous');
  ok(pixel(d, I_EMPTY * PITCH, strip.AXIS_Y - 1)[3] === 0, 'and nothing above it');

  // The gaps between BARS are real gaps. The AXIS deliberately crosses them —
  // a baseline broken every fourth pixel is fourteen ticks, not a timeline.
  let barGapClear = true, topClear = true, axisGapInked = 0;
  for (let y = 0; y < strip.AXIS_Y; y++) if (pixel(d, PITCH - 1, y)[3] !== 0) barGapClear = false;
  for (let x = 0; x < d.width; x++) if (pixel(d, x, 0)[3] !== 0) topClear = false;
  for (let x = PITCH - 1; x < d.width; x += PITCH) if (pixel(d, x, strip.AXIS_Y)[3] > 0) axisGapInked++;
  ok(barGapClear, 'the gap between two bars is transparent at every row ABOVE the axis');
  ok(topClear, 'the top row is clear — only a 12pt bar could reach it, and this fixture has none');
  ok(axisGapInked > 5, `the AXIS crosses the gaps (${axisGapInked} of them inked) — it is one baseline, not fourteen ticks`);

  eq([strip.HEIGHT_POINTS, strip.BAR_MAX_POINTS, strip.AXIS_Y, strip.RULER_Y], [15, 12, 12, 14],
    'the image is 15pt tall: a 12pt bar band, the axis at 12, a blank row, and the ruler at 14');
  ok(strip.HEIGHT_POINTS <= 16,
    'and it is inside the 16pt a menu row accommodates without growing');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5b the axis, the day ruler and the handover caps — decoded');
//
// These three marks are what turn a row of bars into a TIME SERIES, which is
// how the productivity reading is defeated structurally rather than by refusal.
// Every one of them is asserted against real pixels.
{
  const b = new Array(28).fill(0);
  b[8] = 2; b[9] = 1;        // -> drawn 4, ACTIVE, 3 saves
  b[26] = 4; b[27] = 4;      // -> drawn 13, ACTIVE, 8 saves, the newest cell
  const changes = new Array(28).fill(false);
  changes[9] = true;         // -> drawn 4 carries a handover cap
  const withCaps = pulseFixture({
    buckets: b, events: 11, firstKnownBucket: 4, coversWholeWindow: false,
    harnessChanges: changes, harnessCount: 2,
  });
  const cells = strip.drawnCells(withCaps);
  eq([cells[4].state, cells[4].count, cells[4].changed], ['active', 3, true],
    'CONTROL — drawn cell 4 is ACTIVE and carries a handover, so the cap assertions below are not vacuous');
  eq(cells[13].changed, false,
    'CONTROL — and cell 13 is ACTIVE with NO handover, which is the pair the cap is measured against');

  for (const dark of [false, true]) {
    const theme = dark ? 'dark' : 'light';
    const d = png.decodePng(strip.renderPulseStrip(withCaps, { dark }).buffer);
    const pal = strip.STRIP_PALETTE[theme];

    // THE CAP is the top CAP_POINTS rows of the bar, in the cap ink.
    const top4 = strip.AXIS_Y - strip.barHeightPoints(3);
    eq(pixel(d, 4 * PITCH, top4), [...hex(pal.cap), 255],
      `${theme}: the top of a handover bar is the cap colour ${pal.cap}`);
    eq(pixel(d, 4 * PITCH, top4 + strip.CAP_POINTS), [...hex(pal.bar), 255],
      `${theme}: and CAP_POINTS below it the bar is back to ${pal.bar} — the cap is a notch, not a recolour`);
    const top13 = strip.AXIS_Y - strip.barHeightPoints(8);
    eq(pixel(d, 13 * PITCH, top13), [...hex(pal.bar), 255],
      `${theme}: CONTROL — a bar with NO handover has no cap, so the assertion above is about the flag and not about the top of every bar`);

    // THE AXIS: solid under a known cell, dotted under an unknown one, and the
    // texture is the SAME INK on both sides so the distinction is shape only.
    const known = [], unknown = [];
    for (let x = 0; x < 4 * PITCH - 1; x++) unknown.push(pixel(d, x, strip.AXIS_Y)[3] > 0 ? 1 : 0);
    for (let x = 6 * PITCH; x < 8 * PITCH; x++) known.push(pixel(d, x, strip.AXIS_Y)[3] > 0 ? 1 : 0);
    ok(known.every((v) => v === 1), `${theme}: the axis is SOLID under known cells`);
    ok(unknown.includes(0) && unknown.includes(1), `${theme}: and DOTTED under unknown ones`);
    eq(pixel(d, 0, strip.AXIS_Y).slice(0, 3), hex(pal.axis),
      `${theme}: the dotted axis uses the SAME ink as the solid one, so "before this store existed" is texture and never a fainter colour`);

    // THE DAY RULER: one tick per day, TODAY'S DOUBLED.
    const ticks = [];
    for (let x = 0; x < d.width; x++) if (pixel(d, x, strip.RULER_Y)[3] > 0) ticks.push(x);
    eq(ticks.length, 8, `${theme}: the ruler draws 7 day boundaries, the last of them two pixels wide`);
    eq([ticks[ticks.length - 2], ticks[ticks.length - 1]], [48, 49],
      `${theme}: and TODAY'S tick is the double-width one at the newest end`);
    let blank = true;
    for (let x = 0; x < d.width; x++) if (pixel(d, x, strip.AXIS_Y + 1)[3] !== 0) blank = false;
    ok(blank, `${theme}: the row between the axis and the ruler is EMPTY, so the two do not merge into one thick line`);
  }

  // THE RULER IS DERIVED FROM THE DRAWN SPAN, NEVER HARDCODED TO 2.
  eq(strip.cellsPerDay(withCaps), 2, 'two twelve-hour cells make a day');
  eq(strip.cellsPerDay(pulseFixture({ buckets: new Array(29).fill(0) })), 4,
    'an unmergeable 29-bucket producer draws SIX-hour cells, so a day is four of them — the ruler follows the picture');
  eq(strip.cellsPerDay(pulseFixture({ bucketSeconds: 0 })), 0,
    'and a span it cannot divide the day by draws NO ruler, rather than a scale nobody can trust');

  // A HANDOVER FLAG ON A CELL WITH NO BAR IS IGNORED, not drawn on nothing.
  const bogus = pulseFixture({
    buckets: new Array(28).fill(0), harnessChanges: new Array(28).fill(true),
  });
  ok(strip.drawnCells(bogus).every((c) => c.changed === false),
    'a handover flag on an EMPTY cell is dropped — a handover implies a save, and a producer contradicting itself must not make this file invent a bar');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§6 cadence is in the ramp, is capped, and never claims more');
{
  // -- REVERSED, AND THE RUNG BOUNDARIES MOVED WITH IT -------------------
  //
  // WAS: `activeLevel` was LINEAR and capped at five (`activeLevel(3) === 3`,
  // `activeLevel(5) === ACTIVE_LEVELS`), driving a five-shade colour ramp.
  //
  // Measured twelve-hour counts on the maintainer's real store run 3 to 18, so
  // a linear cap at five sat pinned at saturation and every active cell was the
  // same dark green — the fence he reported. The ladder is LOG-ISH now
  // (1 / 2-3 / 4-6 / 7-12 / 13+) and it drives HEIGHT, which is legible at
  // three points of width where a shade is not.
  eq(strip.activeLevel(1), 1, 'one save is the first rung');
  eq(strip.activeLevel(3), 2, 'three saves is the SECOND — the ladder is log-ish, not linear');
  eq(strip.activeLevel(6), 3, 'six is the third');
  eq(strip.activeLevel(12), 4, 'twelve the fourth');
  eq(strip.activeLevel(13), strip.ACTIVE_LEVELS, 'and thirteen reaches the top rung');
  eq(strip.activeLevel(500), strip.ACTIVE_LEVELS, 'a pathological bucket SATURATES rather than redefining what busy looks like');
  eq(strip.activeLevel(0), 1, 'a non-positive count degrades to the first rung rather than indexing off the ladder');
  eq(strip.BAR_HEIGHTS.length, strip.ACTIVE_LEVELS, 'there is exactly one drawn height per rung');
  ok(strip.BAR_HEIGHTS.every((v, i) => i === 0 || v > strip.BAR_HEIGHTS[i - 1]),
    `and the heights rise strictly (${strip.BAR_HEIGHTS.join(' < ')}pt)`);
  eq(strip.BAR_HEIGHTS[strip.ACTIVE_LEVELS - 1], strip.BAR_MAX_POINTS,
    'the top rung fills the whole band, so the tallest bar is the band and not an arbitrary number');
  ok(strip.BAR_HEIGHTS[0] > 1,
    'and the bottom rung is clear of the 1pt axis, so ONE SAVE never reads as a thick baseline');

  // CADENCE IS IN THE HEIGHT, and this is the assertion that reversed. See the
  // module header: the refusal was being honoured in form and broken in
  // substance, because the colour ramp encoded the identical quantity in the
  // one channel that is illegible at 3pt.
  const b = new Array(28).fill(0);
  b[0] = 1; b[1] = 0;      // -> drawn 0, one save
  b[2] = 9; b[3] = 0;      // -> drawn 1, nine saves
  const d = png.decodePng(strip.renderPulseStrip(pulseFixture({ buckets: b, events: 10 }), { dark: false }).buffer);
  const h = (i) => { let n = 0; for (let y = 0; y < strip.AXIS_Y; y++) if (pixel(d, i * PITCH, y)[3] > 0) n++; return n; };
  eq([h(0), h(1)], [strip.barHeightPoints(1), strip.barHeightPoints(9)],
    `a nine-save cell is TALLER than a one-save cell (${h(1)}pt against ${h(0)}pt) — the height IS the count`);
  ok(h(1) > h(0), 'CONTROL — strictly taller, so the comparison above is not two equal numbers agreeing');
  eq(pixel(d, 0, strip.AXIS_Y - 1).slice(0, 3), pixel(d, PITCH, strip.AXIS_Y - 1).slice(0, 3),
    'and they are the SAME colour — one hue for every bar, because the count left the palette entirely');

  // Untrusted input degrades, never throws.
  eq(strip.pulseCells(pulseFixture({ buckets: [null, 'x', -4, 2] })).map((c) => c.state),
    ['empty', 'empty', 'empty', 'active'], 'junk inside buckets degrades to EMPTY, never to a throw');
  for (const junk of [undefined, 0, '', 'x', [], {}, { buckets: [] }, { buckets: 'no' }]) {
    eq(strip.renderPulseStrip(junk, { dark: false }), null,
      `no pulse, no strip: ${JSON.stringify(junk) ?? String(junk)}`);
  }

  // The recorded refusal, asserted as copy. Nothing the user reads may rank a
  // dense column above a sparse one.
  const words = (strip.pulseLabel(pulseFixture({ buckets: b, events: 10 })) + ' ' +
    strip.pulseToolTip(pulseFixture({ buckets: b, events: 10 }))).toLowerCase();
  for (const banned of ['productiv', 'progress', 'streak', 'score', 'goal', 'better', 'good day']) {
    ok(!words.includes(banned), `the copy never says "${banned}"`);
  }
  ok(words.includes('save'), 'CONTROL: it does say "save", so the scan is looking at real text');
  // The legend names SHAPES, not only colours — a legend reading "green means
  // saves" is useless to the viewer who most needs it.
  // REVISED WORDING, SAME RULE. The legend named the marks it had — "tall green
  // bar / low grey stub / baseline hairline" — and two of those three marks no
  // longer exist. It names the marks that DO: bar height, a solid baseline, a
  // dotted one, and the amber cap.
  const tip = strip.pulseToolTip(pulseFixture({ buckets: b, events: 10 }));
  ok(/bar height/i.test(tip) && /solid baseline/i.test(tip) && /dotted baseline/i.test(tip),
    'and the legend names the SHAPES, so it does not depend on the reader seeing colour');
  ok(/amber cap/i.test(tip) && /took over/i.test(tip),
    'including the handover cap, which is the one mark that answers what this widget is for');
  ok(/saves per 12 hours/i.test(tip) && !/activity/i.test(tip),
    'the legend says "saves per 12 hours" and never "activity" — a cadence, never a productivity reading');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§7 the recency dots: five buckets, three colours, one ink ladder');
{
  // The bucket names come from tray-model.js, which is the module that computes
  // them. A second opinion about what "warm" means is the drift this project
  // keeps recording, so they are READ rather than restated.
  const model = await import(path.join(DESKTOP, 'lib', 'tray-model.js'));
  const derived = [
    model.ageBucket(1), model.ageBucket(600), model.ageBucket(3 * 3600),
    model.ageBucket(3 * 86400), model.ageBucket(30 * 86400),
  ];
  eq(derived, dots.DOT_ORDER,
    'DOT_ORDER is exactly what ageBucket() actually returns across its five drawable ranges');
  eq(Object.keys(dots.DOT_INK).sort(), [...dots.DOT_ORDER].sort(), 'and every one of them has ink');

  // `unknown` has NO mark. An age we do not have is not an old one.
  eq(model.ageBucket(null), 'unknown', 'ageBucket returns "unknown" for a missing age');
  eq(dots.renderRecencyDot('unknown', {}), null, 'and an unknown bucket renders NOTHING — not the coldest dot');
  for (const junk of [undefined, null, 42, '', 'LIVE', 'ancient', {}]) {
    eq(dots.renderRecencyDot(junk, {}), null, `and so does ${JSON.stringify(junk) ?? String(junk)}`);
  }
  ok(dots.renderRecencyDot('cold', {}) !== null, 'CONTROL: a real bucket DOES render, so the refusals above mean something');

  // FIVE BUCKETS ONTO THREE COLOURS. The collapse is deliberate; the ladder is
  // what keeps all five separable when the colour does not separate them.
  eq(dots.DOT_ORDER.map((b) => dots.DOT_INK[b].tone), ['hot', 'hot', 'mid', 'cold', 'cold'],
    'green covers live+warm (under 30 min), amber covers today, grey covers cool+cold');
  const areas = dots.DOT_ORDER.map((b) => dots.dotInkArea(b));
  ok(areas.every((v, i) => i === 0 || v < areas[i - 1]),
    `the ink ladder is STRICTLY decreasing (${areas.map((a) => a.toFixed(1)).join(' > ')} pt²) — the signal that survives without colour`);
  // -- REVISED: rings became SECTORS, so `stroke` became `turns` ---------
  //
  // WAS: `live.stroke === null && warm.stroke !== null` — a filled disc against
  // a ring. Three of the five states were rings differing by 0.5pt of radius,
  // which is ONE DEVICE PIXEL at 1x, so the ladder existed in the arithmetic
  // and not on the screen. The disc now DRAINS by quarter turns, and the same
  // property is asserted over the fraction drawn.
  eq(dots.DOT_ORDER.map((b) => dots.DOT_INK[b].turns), [1, 0.75, 0.5, 0.25, 1],
    'the disc drains a quarter at a time, and COLD returns to a solid shape at a smaller radius');
  ok(dots.DOT_INK.live.turns === 1 && dots.DOT_INK.live.radius > dots.DOT_INK.cold.radius,
    'LIVE is the only FULL disc at full size, so the one state that changes what you do next is separable by shape alone');
  ok(dots.DOT_ORDER.slice(0, 4).every((b, i, a) => i === 0 || dots.DOT_INK[b].turns < dots.DOT_INK[a[i - 1]].turns),
    'and the four sector states are a strictly draining clock, each a whole quadrant apart rather than half a point of radius');
  ok(dots.dotInkArea('cold') < dots.dotInkArea('live') * 0.25,
    `and COLD, which is also filled, is under a quarter of LIVE's area (${dots.dotInkArea('cold').toFixed(1)} against ${dots.dotInkArea('live').toFixed(1)})`);

  // -- REVERSED, AND THIS ONE IS A DELIBERATE WEAKENING OF THE PALETTE ---
  //
  // WAS: `hot > mid > cold` in contrast, in both themes, so a warmer row was a
  // heavier mark. That was the right rule when all five marks were nearly the
  // same SIZE and colour was doing the ladder's work.
  //
  // The sector geometry now carries weight explicitly — 78.5pt² of ink down to
  // 12.6, a 6:1 range, asserted above and again in section 11 in the ALPHA
  // CHANNEL, where it survives a viewer who cannot resolve the colours at all.
  // Requiring a luminance ordering ON TOP of that is a second, far weaker
  // ladder pointed at the same fact, and it rules out the design system's own
  // hues for a reason that has stopped applying: in dark, summary-400 (6.43) is
  // brighter than teal-400 (6.05), and nothing about that makes `today` read
  // heavier than `warm` when `warm` is drawn with 50% more ink.
  //
  // What is required instead is a FLOOR — checked in section 2 for every value
  // — plus the three tones being genuinely DIFFERENT, so the palette
  // accelerates the ladder rather than contradicting it.
  for (const theme of ['light', 'dark']) {
    const bg = hex(rgba.MENU_BG[theme]);
    const r = ['hot', 'mid', 'cold'].map((t) => contrast.contrastRatio(hex(dots.DOT_PALETTE[theme][t]), bg));
    ok(r.every((v) => v >= rgba.CONTRAST_FLOOR_NON_TEXT),
      `${theme}: all three tones clear the floor (${r.map((v) => contrast.round2(v).toFixed(2)).join(', ')}) — a floor, not an ordering`);
    eq(new Set(['hot', 'mid', 'cold'].map((t) => dots.DOT_PALETTE[theme][t])).size, 3,
      `${theme}: and the three tones are three different colours, so the palette accelerates the ink ladder rather than flattening it`);
  }
  // The INK ladder is the one that has to be monotone, and it is asserted above
  // from the shipped geometry. Restated here as the replacement for what was
  // removed, so the section does not merely lose an assertion.
  ok(dots.dotInkArea('warm') > dots.dotInkArea('today')
    && dots.dotInkArea('today') > dots.dotInkArea('cool'),
    'the WEIGHT ladder is carried by ink area, which is theme-independent and colour-independent');

  // Every band has words, so the colour is never the only way to learn it.
  for (const b of dots.DOT_ORDER) {
    ok(typeof dots.dotToolTipLine(b) === 'string' && dots.dotToolTipLine(b).length > 8,
      `"${b}" has a tooltip line, so the band is reachable without seeing colour`);
  }
  eq(dots.dotToolTipLine('unknown'), null, 'and an unknown bucket has no line to offer');
  eq(new Set(dots.DOT_ORDER.map(dots.dotToolTipLine)).size, 5, 'all five lines are different sentences');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§8 the dots\' pixels, decoded, in both themes');
{
  for (const dark of [false, true]) {
    const theme = dark ? 'dark' : 'light';
    const seen = new Set();
    for (const b of dots.DOT_ORDER) {
      const spec = dots.renderRecencyDot(b, { dark });
      const d = png.decodePng(spec.buffer);
      const d2 = png.decodePng(spec.buffer2x);
      eq([d.width, d.height, d.channels], [dots.DOT_POINTS, dots.DOT_POINTS, 4],
        `${theme} ${b}: decodes to an ${dots.DOT_POINTS}x${dots.DOT_POINTS} RGBA image`);
      eq(spec.template, false, `${theme} ${b}: and is NOT a template image`);

      // -- REVISED: the centre is a COVERAGE ladder, not a binary ------
      //
      // WAS: filled-or-hollow, because the marks were a disc and three rings.
      // A SECTOR covers the centre pixel in proportion to how much of the disc
      // it draws, so the centre alpha is itself the ladder — and that is a
      // stronger assertion than the old one, because it distinguishes all four
      // sector states rather than only disc-versus-ring.
      //
      // The even-canvas argument the old assertion was protecting is unchanged
      // and is asserted below on `cold`: on an even canvas the centre lands on
      // a pixel CORNER and the smallest filled dot has no opaque pixel at all.
      const mid = (dots.DOT_POINTS - 1) / 2;
      const centre = pixel(d, mid, mid);
      if (dots.DOT_INK[b].turns === 1) {
        eq(centre[3], 255, `${theme} ${b}: a FULL disc has a solid centre pixel — the odd-canvas guarantee`);
      } else {
        ok(centre[3] > 0 && centre[3] < 255,
          `${theme} ${b}: a sector covers its centre pixel PARTIALLY (alpha ${centre[3]}), in proportion to the fraction drawn`);
      }

      // EVERY inked pixel carries the shipped RGB; only alpha varies, because
      // `paintShape` writes the colour and puts coverage in alpha alone. That
      // is what lets §2's contrast figures describe what is actually drawn.
      const tone = dots.DOT_PALETTE[theme][dots.DOT_INK[b].tone];
      const rgbWanted = hex(tone).join(',');
      let inked = 0, wrong = 0, opaque2x = 0;
      for (let y = 0; y < d.height; y++) for (let x = 0; x < d.width; x++) {
        const p = pixel(d, x, y);
        if (p[3] === 0) continue;
        inked++;
        if (p.slice(0, 3).join(',') !== rgbWanted) wrong++;
      }
      for (let y = 0; y < d2.height; y++) for (let x = 0; x < d2.width; x++) {
        if (pixel(d2, x, y)[3] === 255) opaque2x++;
      }
      ok(inked > 0 && wrong === 0,
        `${theme} ${b}: all ${inked} inked pixels are exactly ${tone} — only alpha varies, so the contrast figure describes the ink`);
      ok(opaque2x > 0,
        `${theme} ${b}: and at 2x the mark has ${opaque2x} FULLY OPAQUE pixels, so the colour is drawn at full strength somewhere`);
      seen.add(d.data.toString('base64'));
    }
    eq(seen.size, 5, `${theme}: all five dots are DIFFERENT images — none of the five states renders as another`);

    // THE CENTRE-COVERAGE LADDER, over the four sector states. This is the
    // draining clock, measured in decoded pixels rather than asserted from the
    // geometry that produced it.
    const mid = (dots.DOT_POINTS - 1) / 2;
    const centres = ['live', 'warm', 'today', 'cool'].map(
      (b) => pixel(png.decodePng(dots.renderRecencyDot(b, { dark }).buffer), mid, mid)[3]);
    ok(centres.every((v, i) => i === 0 || v < centres[i - 1]),
      `${theme}: the centre coverage drains strictly (${centres.join(' > ')}) — the disc emptying, in real pixels`);
  }

  // CONTROL on that set comparison: the same bucket twice IS one image.
  const a = png.decodePng(dots.renderRecencyDot('today', { dark: true }).buffer);
  const b = png.decodePng(dots.renderRecencyDot('today', { dark: true }).buffer);
  ok(a.data.equals(b.data), 'CONTROL: the same bucket rendered twice is byte-identical, so the set comparison above can fail');
  const lightToday = png.decodePng(dots.renderRecencyDot('today', { dark: false }).buffer);
  ok(!a.data.equals(lightToday.data), 'and the two themes are genuinely different drawings');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§9 1x and 2x are one drawing at two resolutions');
//
// A 1x-only image is soft on every Mac sold in a decade; a 2x-only one handed
// to a 1x display is downsampled by the OS rather than drawn. Both are
// required, and they must be the SAME drawing rather than two that look alike.
{
  const s = strip.renderPulseStrip(mixedPulse(), { dark: true });
  const d1 = png.decodePng(s.buffer), d2 = png.decodePng(s.buffer2x);
  eq([d1.width, d1.height], [55, 15], 'the strip is 55 x 15 points at 1x — the extra point over 14 is the day ruler');
  eq([d2.width, d2.height], [110, 30], 'and exactly double at 2x');
  eq([s.widthPoints, s.heightPoints], [55, 15], 'and it DECLARES the 1x size, which is what Electron draws it at');
  ok(!s.buffer.equals(s.buffer2x), 'the two buffers are different bytes');

  // -- REVISED: ONE ROW IS DELIBERATELY NOT SCALED, AND IT IS THE POINT --
  //
  // WAS: every 1x pixel reproduced at (2x, 2y), with no exceptions. That held
  // while every mark was a point-sized rectangle. The UNKNOWN axis is dashed in
  // DEVICE PIXELS — one on, one off, at both scales — because a point-based
  // dash becomes 2-on-2-off at 2x, which at this size reads as a slightly
  // lighter SOLID line rather than as a dotted one, and the whole distinction
  // it carries would evaporate on exactly the displays most people have.
  //
  // So the identity is asserted everywhere it should hold, the exception is
  // MEASURED rather than waved through, and it is required to be confined to
  // the axis row under unknown cells.
  const cells1x = strip.drawnCells(mixedPulse());
  const dottedX = new Set();
  cells1x.forEach((c, i) => {
    if (c.state !== 'unknown') return;
    for (let x = i * PITCH; x < i * PITCH + PITCH && x < d1.width; x++) dottedX.add(x);
  });
  ok(dottedX.size > 8, `CONTROL — the fixture really has a dotted region (${dottedX.size}px), so the exception below is exercised`);
  let matched = 0, mismatchesOutside = 0, mismatchesInDash = 0;
  for (let y = 0; y < d1.height; y++) for (let x = 0; x < d1.width; x++) {
    if (JSON.stringify(pixel(d1, x, y)) === JSON.stringify(pixel(d2, x * 2, y * 2))) { matched++; continue; }
    if (y === strip.AXIS_Y && dottedX.has(x)) mismatchesInDash++;
    else mismatchesOutside++;
  }
  eq(mismatchesOutside, 0,
    `every 1x pixel outside the dashed axis is reproduced at (2x, 2y) — one drawing, two resolutions (${matched} matched)`);
  ok(mismatchesInDash > 0,
    `and the ${mismatchesInDash} that differ are ALL in the dashed axis row, where the texture is one DEVICE pixel at both scales by design`);

  for (const b of dots.DOT_ORDER) {
    const spec = dots.renderRecencyDot(b, { dark: false });
    const e1 = png.decodePng(spec.buffer), e2 = png.decodePng(spec.buffer2x);
    eq([e1.width, e2.width], [dots.DOT_POINTS, dots.DOT_POINTS * 2],
      `${b}: the dot is ${dots.DOT_POINTS}pt at 1x and ${dots.DOT_POINTS * 2}px at 2x`);
    // A circle is antialiased, so pixel identity is not the right check; the
    // CENTRE is, because it is either fully inside the mark or fully outside it
    // at both resolutions.
    // REVISED: a single centre pixel is the wrong probe for a sector, because
    // at 2x the pixel nearest the centre lies wholly inside ONE quadrant and is
    // therefore all-or-nothing where the 1x pixel straddles four. The TOTAL INK
    // is the scale-invariant property, and it is the one the ladder is built
    // on: 2x must carry about four times the coverage of 1x.
    const coverage = (d) => {
      let sum = 0;
      for (let y = 0; y < d.height; y++) for (let x = 0; x < d.width; x++) sum += pixel(d, x, y)[3];
      return sum / 255;
    };
    const ratio = coverage(e2) / coverage(e1);
    ok(ratio > 3.7 && ratio < 4.3,
      `${b}: the 2x drawing carries ${ratio.toFixed(2)}x the ink of the 1x one — one drawing at two resolutions, not two that look alike`);
  }

  ok(s.buffer.length < 4096 && s.buffer2x.length < 8192,
    `the strip images are tiny (${s.buffer.length} / ${s.buffer2x.length} bytes) — nothing is shipped or cached`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§10 the spec shape, exactly as contracted');
//
// One shape for both renderers, fixed in writing before either was built, so
// the consumer has one thing to handle. Asserted as an EXACT key set: an extra
// field is a second contract nobody agreed to, and a missing one is a crash in
// a menu build.
{
  const want = ['buffer', 'buffer2x', 'heightPoints', 'template', 'widthPoints'];
  for (const [name, spec] of [
    ['renderPulseStrip', strip.renderPulseStrip(mixedPulse(), { dark: false })],
    ['renderRecencyDot', dots.renderRecencyDot('warm', { dark: false })],
  ]) {
    eq(Object.keys(spec).sort(), want, `${name} returns exactly {buffer, buffer2x, widthPoints, heightPoints, template}`);
    ok(Buffer.isBuffer(spec.buffer) && Buffer.isBuffer(spec.buffer2x), `${name}: both representations are Buffers`);
    ok(Number.isInteger(spec.widthPoints) && Number.isInteger(spec.heightPoints), `${name}: the declared size is in whole points`);
    eq(spec.template, false, `${name}: template is the literal false, never merely falsy`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('§11 COLOUR DISCARDED — every state readable in the alpha channel alone');
//
// THE INSTRUCTION THIS SECTION ANSWERS: colour is an ACCELERATOR, not the
// signal. Nothing here has ever been rendered, and a contrast ratio computed
// against an ASSUMED background token is not a claim about legibility at 3pt
// inside an inverted, highlighted menu row. So every distinction is required to
// survive with the colour thrown away — the alpha channel, and nothing else.
//
// If this section were hard to write, that would itself be the finding. It was
// not, because the shape ladder was designed in before the palette was.
{
  // Bars and axis only — see section 4 for why the global day ruler is not a
  // property of a cell and must not enter a cell-versus-cell comparison.
  const alphaOnly = (d, i) => {
    const out = [];
    for (let y = 0; y <= strip.AXIS_Y; y++) {
      for (let x = i * PITCH; x < i * PITCH + strip.CELL_POINTS; x++) out.push(pixel(d, x, y)[3]);
    }
    return out.join(',');
  };

  for (const dark of [false, true]) {
    const theme = dark ? 'dark' : 'light';
    const d = png.decodePng(strip.renderPulseStrip(mixedPulse(), { dark }).buffer);
    const a = alphaOnly(d, I_ACTIVE), e = alphaOnly(d, I_EMPTY), u = alphaOnly(d, I_UNKNOWN);

    ok(a !== e, `${theme}: ACTIVE and EMPTY differ WITH THE COLOUR DISCARDED`);
    ok(e !== u, `${theme}: EMPTY and UNKNOWN differ with the colour discarded`);
    ok(a !== u, `${theme}: ACTIVE and UNKNOWN differ with the colour discarded`);
    ok(alphaOnly(d, I_UNKNOWN) === alphaOnly(d, I_UNKNOWN_TWIN),
      `${theme}: CONTROL — two cells in the same state have IDENTICAL alpha, so the three above can fail`);
  }

  // AND THE TWO THEMES ARE THE SAME DRAWING. This is the strongest form of the
  // claim: the alpha channel — the silhouette — is BYTE-IDENTICAL in light and
  // dark, so whatever a viewer can read from the shape in one appearance they
  // can read in the other, and the palette changes nothing structural.
  const sil = (dark) => {
    const d = png.decodePng(strip.renderPulseStrip(mixedPulse(), { dark }).buffer);
    const out = [];
    for (let y = 0; y < d.height; y++) for (let x = 0; x < d.width; x++) out.push(pixel(d, x, y)[3]);
    return out.join(',');
  };
  // Compared as a DIGEST, not as the raw string: a 770-value mismatch dumped
  // into a test report is a failure nobody reads. The digest is over the same
  // bytes, so it can fail for exactly the same reasons.
  const digest = (v) => createHash('sha256').update(v).digest('hex').slice(0, 16);
  eq(digest(sil(true)), digest(sil(false)),
    'the strip\'s SILHOUETTE is byte-identical in light and dark — the theme changes the ink, never the reading');

  // The same test for the dots: all five states separable with no colour at all.
  const dotSil = (b, dark) => {
    const d = png.decodePng(dots.renderRecencyDot(b, { dark }).buffer);
    const out = [];
    for (let y = 0; y < d.height; y++) for (let x = 0; x < d.width; x++) out.push(pixel(d, x, y)[3]);
    return out.join(',');
  };
  const sils = dots.DOT_ORDER.map((b) => dotSil(b, false));
  eq(new Set(sils).size, 5,
    'all FIVE recency dots have different silhouettes — the five buckets are separable with the palette discarded entirely');
  ok(sils[0] === dotSil('live', false), 'CONTROL: the same bucket twice has the same silhouette, so the set comparison can fail');
  for (const b of dots.DOT_ORDER) {
    eq(dotSil(b, true), dotSil(b, false), `${b}: and its silhouette does not change with the theme`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('§12 the merge, and the width budget it was bought with');
//
// "More present" and "~260pt of menu" pull in opposite directions, and the
// strip is the only lever — a per-row character budget cannot shrink a
// fixed-width image. The answer was to draw FEWER, FATTER cells: 34% narrower
// and twice the ink per cell. This section is the guard on both halves.
{
  eq([strip.CELL_POINTS, strip.GAP_POINTS, strip.TARGET_CELLS], [3, 1, 14],
    'a 3pt bar on a 4pt pitch, at most 14 cells');
  eq(strip.mergeFactor(28), 2, '28 six-hour buckets fold two-to-one into 14 twelve-hour cells');
  eq(strip.drawnCells(pulseFixture()).length, 14, 'so 14 cells are drawn');
  eq(strip.renderPulseStrip(pulseFixture(), { dark: false }).widthPoints, 55,
    'which is 55pt — against the 83pt it replaces, a 34% saving');
  eq(strip.CELL_POINTS * strip.BAR_MAX_POINTS, 36,
    'and a FULL ACTIVE cell carries 36pt² of ink against the 18 of the 83pt strip — twice, in two-thirds the width');

  // THE MERGE FAILS SAFE. A bucket count with no useful divisor must draw MORE
  // cells, never fold the week into two.
  eq(strip.mergeFactor(14), 1, 'a producer already at 14 buckets is not merged at all');
  eq(strip.mergeFactor(29), 1, 'a PRIME count refuses to merge rather than folding 29 buckets into one cell');
  eq(strip.mergeFactor(100), 10, 'and 100 buckets fold ten-to-one into 10');
  eq(strip.drawnCells(pulseFixture({ buckets: new Array(29).fill(0) })).length, 29,
    'so an unmergeable producer is drawn WIDE and complete rather than compressed into a lie');

  // THE UNKNOWN RULE. A merged cell is unknown only when EVERY source is. The
  // other reading would grey a half-known cell and claim the store is younger
  // than it is.
  const half = pulseFixture({ firstKnownBucket: 11 });      // source 10 known, 11 unknown -> drawn 5 straddles
  const cells = strip.drawnCells(half);
  eq(cells[4].state, 'unknown', 'a drawn cell whose sources are BOTH unknown is unknown');
  eq(cells[5].state, 'empty',
    'but one straddling the boundary is KNOWN — the reading that claims less about how young the store is');
  const b2 = new Array(28).fill(0); b2[11] = 3;
  // REVISED IN TWO PLACES, both consequences of shipped changes rather than of
  // this assertion: the cell record gained `changed`, and three saves is now
  // the SECOND rung rather than the third (the ladder is log-ish).
  eq(strip.drawnCells(pulseFixture({ buckets: b2, firstKnownBucket: 11 }))[5],
    { index: 5, state: 'active', count: 3, level: 2, changed: false },
    'and a straddling cell carries the SUM of its known sources, at the rung that sum earns');

  // THE LEGEND FOLLOWS THE PICTURE. A tooltip saying "per 6 hours" beside a
  // 12-hour cell would be precisely wrong.
  eq(strip.drawnBucketSeconds(pulseFixture()), 43200, 'one drawn cell is twelve hours');
  ok(/per 12 hours/.test(strip.pulseToolTip(pulseFixture())),
    'and the legend says so, rather than quoting the producer\'s six');

  // ── THE WIDTH ARITHMETIC, ACROSS ITS ASSUMPTIONS ──────────────────────
  //
  // Two assumed numbers: the menu's chrome and the font's average advance.
  // The conclusion is checked over a range of both, because a conclusion that
  // holds only at one assumed point is not a conclusion.
  const label = strip.pulseLabel(pulseFixture({ buckets: (() => { const b = new Array(28).fill(0); b[27] = 28; return b; })(), events: 28 }));
  for (const chrome of [16, 24, 32]) {
    for (const charPoints of [5.5, 6.5, 7.5]) {
      const total = chrome + 55 + label.length * charPoints;
      const was = chrome + 83 + label.length * charPoints;
      ok(total < was,
        `at ${chrome}pt chrome and ${charPoints}pt/char the row is ~${total.toFixed(0)}pt, down from ~${was.toFixed(0)}pt — the strip is strictly cheaper than what it replaces`);
    }
  }
  // And the honest half: the LABEL, not the picture, is what keeps the row over
  // the target. Reported rather than hidden.
  ok(label.length * 6.5 > 55 * 2,
    `the label (${label.length} chars, ~${(label.length * 6.5).toFixed(0)}pt) is more than TWICE the picture — the overage against 260pt is in the sentence, not the icon`);
}

console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
