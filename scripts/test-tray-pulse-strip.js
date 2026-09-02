/**
 * test-tray-pulse-strip.js — OFFLINE guard for the menubar SAVE PULSE and for
 * the width compaction that shipped alongside it.
 *
 * Covers `desktop/lib/pulse-strip.js`, the pulse and compaction paths through
 * `desktop/lib/tray-model.js`, the strip's menu item in `desktop/lib/
 * tray-menu.js`, and a labelled-weak source scan of the wiring in
 * `desktop/main.js`.
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
 *   §7   the menu item: where it sits, that it is a statement, and its width
 *   §8   width compaction — three levers, each conditional and each reversible
 *   §9   nothing dropped from a label becomes unreachable
 *   §10  the collision guard: compaction may never make two rows read alike
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

const NOOPS = { onOpenScope() {}, onOpenMemory() {}, onOpenApp() {}, onOpenSettings() {} };
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

// ── The fixture the width numbers are taken over ────────────────────────────
//
// Shaped from the maintainer's real store, read at the time this suite was
// written: one project, eight scopes, `session-YYYY-MM-DD-…` names, one
// harness, and the two machine folders that are in fact one laptop whose
// hostname flapped under DHCP. Held here rather than read off disk so the
// numbers above are reproducible on any machine and touch no user data.
function realStoreScopes() {
  const rows = [
    ['session-2026-09-01-menubar-widget-design', 'alices-macbook-pro-9f3c1a', 828, 'RESEARCH DONE, NOTHING BUILT. Heartbeat is drawable in the menu as a per-row icon PNG, but per-machine series are FICTION on the real store.'],
    ['session-2026-08-31-native-prep-and-release-process', 'alices-macbook-pro-9f3c1a', 43029, 'FOUR RELEASES SHIPPED (v3.31-v3.34). Mac app installs, updates itself in-app, sync data loss fixed.'],
    ['session-2026-08-30-design-conformance-pre-native', 'alices-macbook-pro-9f3c1a', 124066, 'v3.25.0, v3.26.0, v3.27.0 all SHIPPED and pushed. ALL NINE design findings CLOSED.'],
    ['session-2026-08-30-design-conformance-pre-native', 'mac-9f3c1a', 132529, '7 of 11 issues + ramp + machine-id fix MERGED. main 14 ahead UNPUSHED, 125/125 green.'],
    ['session-2026-08-30-ingest-continuity-tables', 'alices-macbook-pro-9f3c1a', 138636, 'SESSION COMPLETE. v3.24.0/1/2 all shipped and tagged. CLAUDE.md 183k to 43k tokens.'],
    ['session-2026-08-30-chat-streaming', 'alices-macbook-pro-9f3c1a', 160514, 'SHIPPED: v3.23.0 (chat streaming + thinking region + 5 UX fixes) and v3.23.1.'],
    ['session-2026-08-30-chat-streaming', 'mac-9f3c1a', 175018, 'Wave 1: 2 of 3 landed (SSE reader, OpenRouter adapter). llm.js still running.'],
    ['session-2026-08-29-ux-polish', 'mac-9f3c1a', 209028, 'FOUR releases shipped: v3.19.0 to v3.22.0. The floating text under every title is GONE.'],
  ];
  return rows.map(([scope, machine, age, headline]) => ({
    project: 'projects', scope, machine, harness: 'claude-code',
    // BOTH folders are this installation: they share the trailing install id
    // `9f3c1a`, and the machine-identity fix now resolves them as one laptop.
    // This is what the merged producer emits against his store.
    isThisMachine: machine.endsWith('-9f3c1a'),
    writtenAt: new Date(NOW.getTime() - age * 1000).toISOString(),
    writtenAgeSeconds: age, ageSource: 'agent', headline, harnessShared: false,
  }));
}
const REAL_STORE = {
  ok: true, total: 11, pulse: youngStore(),
  scopes: realStoreScopes(),
  warnings: [{ code: 'scopes-truncated', message: 'Showing the 8 most recent of 11 saved work-streams.', shown: 8, total: 11 }],
};
function realStoreMenu() {
  return menu.buildTrayMenuTemplate(model.buildTrayModel(REAL_STORE, { now: NOW }), NOOPS);
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
  eq([s.widthPoints, s.heightPoints], [55, 14], 'which is 55 x 14 points — NARROWER than the 83 x 11 it replaces, and taller');
  eq([d1.width, d1.height], [55, 14], 'and the 1x bytes really are that size');
  eq([d2.width, d2.height], [110, 28], 'the 2x representation is exactly double — one drawing at two resolutions');
  eq([d1.depth, d1.colorType], [8, 6], 'colour type 6 = truecolour with alpha, 8 bits each');

  // ── THE HEIGHT CHANGED, AND SO DID THE REASON FOR IT ──────────────────
  //
  // 11pt -> 14pt. NOT because bigger is better: width is what costs menu, and
  // it did not move (see HEIGHT_POINTS in pulse-strip.js for the arithmetic).
  // 14pt is inside the 16pt a macOS menu row accommodates without growing, so
  // the extra 3pt of drawn bar is free.
  eq([strip.HEIGHT_POINTS, strip.CELL_POINTS], [14, 3],
    'the strip is 14pt tall with 3pt bars, up from 11pt and 2pt — and NARROWER overall, because it draws 14 cells rather than 28');

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
  const pitch = strip.CELL_POINTS + strip.GAP_POINTS;
  const gapX = pitch - 1;
  ok(d1.alpha.every((row) => row[gapX] === 0), 'the gap between two bars is transparent at every row');
  ok(d1.alpha[0].every((v) => v === 0), 'the top row is clear — the bars do not touch the row above');
  ok(d1.alpha[d1.height - 1].every((v) => v === 0), 'and so is the bottom row');
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
    ok(same(cellColumn(d, 1), cellColumn(d, 2)),
      `${theme}: CONTROL — two UNKNOWN cells compare IDENTICAL, so the comparisons above can fail`);

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
    ok(inkedCount(unknown) < inkedCount(empty),
      `${theme}: UNKNOWN is a shorter mark than EMPTY (${inkedCount(unknown)} against ${inkedCount(empty)}) — a hairline, not a stub`);
    ok(inkedCount(active) >= inkedCount(empty) * 3,
      `${theme}: and ACTIVE is at least three times an EMPTY stub, not a shade of it`);

    // Both quiet marks sit on the BASELINE, so the strip still reads as a
    // timeline across the boundary rather than as two unrelated drawings.
    const bottomRow = d.height - 2;
    ok(d.alpha[bottomRow][1 * (strip.CELL_POINTS + strip.GAP_POINTS)] > 0,
      `${theme}: the UNKNOWN hairline is on the baseline row`);
    ok(d.alpha[2][1 * (strip.CELL_POINTS + strip.GAP_POINTS)] === 0,
      `${theme}: and nowhere near the top of the band`);

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
  eq(strip.activeLevel(1), 1, 'one save is the first rung');
  ok(strip.activeLevel(2) > strip.activeLevel(1), 'two saves is heavier than one');
  ok(strip.activeLevel(9) <= strip.ACTIVE_LEVELS, 'and it is capped — the scale cannot run away');
  eq(strip.activeLevel(50), strip.ACTIVE_LEVELS, 'a pathological bucket saturates rather than overflowing');
  eq(strip.STRIP_PALETTE.light.active.length, strip.ACTIVE_LEVELS, 'the light ramp has exactly that many rungs');
  eq(strip.STRIP_PALETTE.dark.active.length, strip.ACTIVE_LEVELS, 'and so does the dark one');

  // ONE save is unmistakably heavier than an empty bucket. This was
  // `ACTIVE_ALPHA_BASE > EMPTY_ALPHA + 0.3`; it is now a CONTRAST comparison,
  // and it caught a real defect — the first palette written had the lightest
  // green BELOW the empty grey. `scripts/test-tray-paint.js` §2 owns the
  // measurement; this is the structural half of it.
  for (const theme of ['light', 'dark']) {
    ok(strip.STRIP_PALETTE[theme].active[0] !== strip.STRIP_PALETTE[theme].empty,
      `${theme}: a one-save bar and an empty bucket are not the same colour`);
  }

  const b = new Array(28).fill(0);
  b[0] = 1; b[2] = 4;       // -> drawn 0 holds one save, drawn 1 holds four
  const d = decodeRgba(strip.renderPulseStrip(pulseFixture({ buckets: b, events: 5 }), { dark: false }).buffer);
  ok(JSON.stringify(cellColumn(d, 1)) !== JSON.stringify(cellColumn(d, 0)),
    'and the difference between one save and four survives into the actual pixels');
  eq(inkedCount(cellColumn(d, 0)), inkedCount(cellColumn(d, 1)),
    'while both bars are exactly the same HEIGHT — a count is never drawn as a taller bar, which would read as a productivity chart');

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
  ok(/bar/.test(tip) && /stub/.test(tip) && /hairline/.test(tip),
    'it carries the legend for all three marks, naming their SHAPES and not only their colours');
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
section('§7 the menu item: where it sits, that it is a statement, and its width');
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
  ok(Buffer.isBuffer(m.pulse.strip.buffer), 'including the 1x PNG bytes');
  eq(m.pulse.strip.template, false, 'and the spec the model carries says template:false');
  ok(Buffer.isBuffer(m.pulse.strip.buffer2x), 'and the 2x ones');

  const seen = [];
  const t = menu.buildTrayMenuTemplate(m, { ...NOOPS, makeIcon: (s) => { seen.push(s); return { fake: 'image' }; } });
  const flat = menu.flattenTrayMenu(t);
  const idx = flat.findIndex((i) => i.id === menu.ID_PULSE);
  ok(idx >= 0, 'the strip item is in the template');
  // REVERSED, DELIBERATELY, and the maintainer's own screenshot is the reason.
  // This block used to assert the pulse was DISABLED, on the grounds that a
  // disabled item is this menu's idiom for a status line. Shipped, that made
  // macOS tint the strip to the DISABLED TEXT colour, and his verdict on it was
  // "barely visible, I don't know why it's in such a light colour". Putting the
  // one piece of graphics the widget exists for into the dimmest style
  // available is the compounding-opacity defect this repo has fixed twice.
  // It is now ENABLED, at full contrast, and it goes where the headline goes.
  eq(flat[idx - 1].id, menu.ID_HEADER_PULSE, 'it sits directly below its own section header');
  eq(flat[idx].enabled, true, 'it is drawn at FULL CONTRAST, not as a dimmed statement');
  ok(typeof flat[idx].click === 'function', 'and an enabled row must DO something — an enabled item with no handler swallows a click');
  eq(flat[idx].icon, { fake: 'image' }, 'the injected makeIcon result becomes the item\'s icon');
  // The header itself is the statement, and it must stay inert.
  eq(flat[idx - 1].enabled, false, 'the section header IS a statement and stays disabled');
  ok(!flat[idx - 1].click, 'and carries no handler, so no macOS version can make a caption actionable');
  ok(seen.includes(m.pulse.strip), 'makeIcon is handed the strip itself, buffers and all');
  eq(seen.filter((x) => x === m.pulse.strip).length, 1, 'and exactly once — the picture is not built twice per menu');
  ok(typeof flat[idx].toolTip === 'string' && flat[idx].toolTip.length > 40, 'the item carries the full tooltip');

  // With no makeIcon the reading survives without the picture.
  const noIcon = menu.flattenTrayMenu(menu.buildTrayMenuTemplate(m, NOOPS))
    .find((i) => i.id === menu.ID_PULSE);
  ok(noIcon && noIcon.label === m.pulse.label, 'with no makeIcon the item still appears, with its label intact');
  ok(!('icon' in noIcon), 'and simply carries no icon key — a missing image never costs the reading');

  // No pulse in the summary, no item. Not an empty one.
  const bare = model.buildTrayModel({ ...summary, pulse: null }, { now: NOW });
  eq(bare.pulse, null, 'no pulse in the summary, none in the model');
  ok(!menu.flattenTrayMenu(menu.buildTrayMenuTemplate(bare, NOOPS)).some((i) => i.id === menu.ID_PULSE),
    'and no strip item in the menu — an absent measurement is not a blank rectangle');

  // ── THE WIDTH ARGUMENT ────────────────────────────────────────────────
  //
  // Electron does NOT scale a menu item icon, so the strip's 83 points are 83
  // points of extra menu width on this row. The claim being checked is that the
  // row still does not become the widest thing in a menu this release is
  // narrowing — and it is checked across a WIDE range of the font assumption,
  // because MENU_CHAR_POINTS is an assumption and not a measurement.
  const widest = Math.max(...menu.flattenTrayMenu(realStoreMenu()).map(
    (i) => (i.type === 'separator' ? 0 : Math.max((i.label || '').length, (i.sublabel || '').length))));
  for (const charPoints of [5.0, 6.0, strip.MENU_CHAR_POINTS, 8.0, 10.0]) {
    const cost = m.pulse.label.length + m.pulse.strip.widthPoints / charPoints;
    ok(cost < widest,
      `at ${charPoints}pt per character the strip row costs ~${cost.toFixed(1)} character-widths, under the menu's widest line (${widest})`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('§8 width compaction — three levers, each conditional and each reversible');
//
// MEASURED BEFORE THE CHANGE, on the maintainer's real store: widest rendered
// line 93 characters, mean 58.4 over 24 lines, 15 of them past 70. Three tokens
// carried zero information there — the project name (one project has state),
// a `session-` prefix on every scope, and the harness (claude-code on every
// journal line). None is deleted unconditionally; each returns the moment the
// data says it distinguishes something.
{
  const row = (over) => ({
    project: 'projects', scope: 'session-alpha', machine: 'mac-9f3c1a',
    harness: 'claude-code', isThisMachine: true, ageSource: 'agent',
    writtenAgeSeconds: 600, headline: 'h', ...over,
  });
  const build = (scopes, extra = {}) =>
    model.buildTrayModel({ ok: true, scopes, ...extra }, { now: NOW });

  // ── LEVER 1: the project token ─────────────────────────────────────────
  const one = build([row({}), row({ scope: 'session-beta', writtenAgeSeconds: 900 })]);
  ok(!one.rows[0].label.startsWith('projects'), 'ONE project: the project token is dropped');
  eq(one.rows[0].showsProject, false, 'and the model says so, rather than leaving it to be inferred');

  const two = build([row({}), row({ project: 'other', scope: 'session-beta', writtenAgeSeconds: 900 })]);
  ok(two.rows[0].label.startsWith('projects · '), 'TWO projects: it comes straight back');
  eq(two.rows[0].showsProject, true, 'on every row, not only the ones that differ');

  // Counted over EVERY scope the summary supplied, not merely the shown rows.
  const past = model.buildTrayModel({
    ok: true,
    scopes: [row({}), row({ scope: 'session-beta', writtenAgeSeconds: 900 }),
      row({ project: 'hidden', scope: 'session-gamma', writtenAgeSeconds: 1200 })],
  }, { now: NOW, maxRows: 2 });
  eq(past.rows.length, 2, 'a project past the ROW cap is not rendered');
  eq(past.rows[0].showsProject, true, 'but it still keeps the token on the rows above it');

  // ── LEVER 2: the session- prefix ───────────────────────────────────────
  eq(model.shortScopeNames(['session-alpha', 'session-beta']).get('session-alpha'), 'alpha',
    'a shared, meaningless prefix is dropped from the DISPLAYED scope');
  eq(model.shortScopeNames(['hotfix']).get('hotfix'), 'hotfix', 'a scope without it is untouched');
  eq(model.shortScopeNames(['session-']).get('session-'), 'session-',
    'and a scope that IS the prefix keeps it — stripping to nothing is not a shortening');
  // The collision guard, which is why this is a set operation.
  const clash = model.shortScopeNames(['session-deploy', 'deploy']);
  eq(clash.get('session-deploy'), 'session-deploy',
    'stripping is REFUSED when it would make two shown scopes read the same');
  eq(clash.get('deploy'), 'deploy', 'and the scope it would have collided with is unchanged');

  // ── LEVER 3: the harness ───────────────────────────────────────────────
  ok(!/claude-code/.test(one.rows[0].label), 'ONE harness across every local row: the harness is dropped');
  eq(one.rows[0].showsProvenance, false, 'the provenance slot is empty, and the model says so');
  ok(one.rows[0].toolTip.includes('harness: claude-code'), 'while the tooltip still names it');

  const twoHarness = build([row({}), row({ scope: 'session-beta', harness: 'opencode', writtenAgeSeconds: 900 })]);
  ok(/claude-code/.test(twoHarness.rows[0].label), 'TWO harnesses: it comes back on the row it belongs to');
  ok(/opencode/.test(twoHarness.rows[1].label), 'and on the other one');

  const missing = build([row({}), row({ scope: 'session-beta', harness: null, writtenAgeSeconds: 900 })]);
  ok(/claude-code/.test(missing.rows[0].label),
    'a row with NO harness counts AGAINST dropping — an absent harness is not evidence that it matches');
  ok(/unknown harness/.test(missing.rows[1].label), 'and that row says the harness is unknown rather than implying one');

  // A MACHINE token is never dropped. That is the whole reason a remote row
  // has a provenance at all.
  const remote = build([row({}), row({
    scope: 'session-beta', machine: 'studio-9f8e7d', isThisMachine: false, writtenAgeSeconds: 900,
  })]);
  ok(/studio/.test(remote.rows[1].label), 'a row from another machine ALWAYS names it');
  eq(remote.rows[1].showsProvenance, true, 'even while the local rows beside it show nothing');
  ok(!/claude-code|mac-9f3c1a/.test(remote.rows[0].label),
    'so a row with no provenance means "from here" and a row with one means "from there"');

  // ── LEVER 4: the headline cap ──────────────────────────────────────────
  ok(model.MAX_HEADLINE_CHARS < 72, `the headline cap came down from 72 (now ${model.MAX_HEADLINE_CHARS})`);
  ok(model.MAX_HEADLINE_CHARS >= 40,
    'but the headline is SHORTER, not GONE — the maintainer asked for it "available for a quick glance"');
  const long = build([row({ headline: 'y'.repeat(400) })]);
  ok(long.rows[0].sublabel.length <= model.MAX_HEADLINE_CHARS, 'a long headline is clipped to the cap');
  ok(long.rows[0].sublabel.endsWith('…'), 'and the clip is VISIBLE');

  // ── THE MEASUREMENT ────────────────────────────────────────────────────
  const flat = menu.flattenTrayMenu(realStoreMenu());
  const lens = [];
  for (const i of flat) {
    if (i.type === 'separator') continue;
    lens.push((i.label || '').length);
    if (i.sublabel) lens.push(i.sublabel.length);
  }
  const max = Math.max(...lens);
  const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
  // THE TARGET. 56 characters, over the whole rendered menu — every label, every
  // sublabel, the pulse row included — measured on his real store shape.
  ok(max <= 56, `the widest rendered line in the whole menu is ${max}, inside the 56 target (was 87)`);
  ok(mean < 45, `and the mean is ${mean.toFixed(1)}, down from 57.2`);
  eq(lens.filter((n) => n > 70).length, 0, 'no line runs past 70 any more; fourteen did');
  // A CONTROL on the measurement itself: a suite that measured an empty menu,
  // or one row, would report a small maximum and prove nothing.
  ok(lens.length >= 18, `CONTROL: ${lens.length} lines were actually measured (the row cap is 5, so the menu is shorter than it was at 8)`);
  ok(max > 40, 'CONTROL: and the widest is a real row, not a truncated stub');
  // The collision on his store resolves by AGE, not by a folder name — which
  // is the fix, asserted here against the full store rather than only against
  // the two-row fixture in §10.
  const realRows = model.buildTrayModel(REAL_STORE, { now: NOW }).rows;
  ok(realRows.every((r) => !/alices-macbook-pro|9f3c1a/.test(r.label)),
    'and NO row names a machine folder — the two colliding rows are one laptop and are separated by a finer age');
  ok(realRows.filter((r) => r.agePrecision === 'hour').length === 2,
    'exactly the two colliding rows were escalated, and no others');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§9 nothing dropped from a label becomes unreachable');
//
// THE ABSOLUTE RULE of the compaction. Checked per row against the RAW input,
// so it holds for every lever at once rather than one lever at a time.
{
  const m = model.buildTrayModel(REAL_STORE, { now: NOW });
  let checked = 0;
  for (let i = 0; i < m.rows.length; i++) {
    const r = m.rows[i];
    const src = REAL_STORE.scopes.find((s) => s.scope === r.scope && s.machine === r.machine);
    const tip = r.toolTip;
    ok(tip.includes(src.project), `row ${i}: the project is in the tooltip`);
    ok(tip.includes(src.scope), `row ${i}: the FULL scope is in the tooltip, unshortened`);
    ok(tip.includes(src.machine), `row ${i}: the full machine name is in the tooltip`);
    ok(tip.includes(src.harness), `row ${i}: the harness is in the tooltip`);
    checked++;
  }
  ok(checked === 5, `all ${checked} rows were checked, so the loop above is not vacuous (5 is the row cap; it was 8)`);

  // ── AND ONE FIELD THAT MUST NOT REACH A SURFACE AT ALL ────────────────
  //
  // The producer carries a per-row `machineMatch: 'exact' | 'install-id' |
  // 'none'` for DIAGNOSIS. It is not a user-facing fact — "install-id" is an
  // implementation detail of how two hostnames were recognised as one laptop —
  // and a diagnostic escaping into a menu label is a shape this project has
  // shipped before. Nothing here reads it; this asserts that it stays that way,
  // driven with the value actually present rather than by a source scan.
  const diag = model.buildTrayModel({
    ok: true,
    scopes: REAL_STORE.scopes.map((r) => ({ ...r, machineMatch: 'install-id' })),
  }, { now: NOW });
  const surfaced = menu.flattenTrayMenu(menu.buildTrayMenuTemplate(diag, NOOPS))
    .map((i) => [i.label, i.sublabel, i.toolTip].filter(Boolean).join(' ')).join(' ');
  ok(!/install-id|machineMatch/.test(surfaced),
    'the diagnostic machineMatch field reaches no label, sublabel or tooltip');
  ok(/mac-9f3c1a/.test(surfaced),
    'CONTROL: other per-row fields DO reach a surface, so the scan above is looking at real rendered text');

  // A control: the tooltip is NOT simply the label repeated, and it really is
  // longer than what was dropped.
  ok(m.rows[0].toolTip.length > m.rows[0].label.length,
    'CONTROL: the tooltip is a different, longer text than the label');

  // The headline's "where" line is compacted by the same rules, and keeps the
  // uncompacted form beside it so no later surface has to re-derive it.
  ok(m.headline.whereFull.includes('session-'), 'the headline keeps the FULL where text');
  ok(!m.headline.where.includes('session-'), 'while the line that is drawn is compacted the same way the rows are');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§10 the collision guard: compaction may never make two rows read alike');
//
// Reachable in ordinary use, not exotic: one scope worked on from two machines
// whose two ages round to the same words is a handoff. THE FIRST VERSION OF
// THIS SECTION TESTED THE WRONG FIX — it restored a machine FOLDER NAME, which
// on the maintainer's real store printed two names for one laptop on the only
// two lines still over the width target. The order asserted below is the fixed
// one: same computer -> finer age; different computers -> the machine stays;
// same computer inside one minute -> the folder name, as a last resort.
{
  const row = (over) => ({
    project: 'projects', scope: 'session-alpha', harness: 'claude-code',
    ageSource: 'agent', headline: 'h', ...over,
  });
  const build = (scopes) => model.buildTrayModel({ ok: true, scopes }, { now: NOW });

  // ── A. THE MAINTAINER'S REAL CASE ──────────────────────────────────────
  //
  // One project, one scope, TWO machine folders sharing the trailing install id
  // `9f3c1a` — one laptop whose hostname flapped under DHCP — and two ages that
  // both round to "1 day ago". This is transcribed from what the merged
  // producer and model actually rendered against his store.
  // The REAL scope name, not a short stand-in: it is the longest on his store
  // at 48 characters, so the "<= 56" assertions below are a real test of the
  // width target rather than a test of a fixture that could never fail it.
  const REAL_SCOPE = 'session-2026-08-30-design-conformance-pre-native';
  const real = build([
    row({ scope: REAL_SCOPE, machine: 'alices-macbook-pro-9f3c1a', isThisMachine: true, writtenAgeSeconds: 124066 }),
    row({ scope: REAL_SCOPE, machine: 'mac-9f3c1a', isThisMachine: true, writtenAgeSeconds: 132529 }),
  ]);
  eq(model.ageText(124066, 'agent'), model.ageText(132529, 'agent'),
    'the two ages really do render identically on the ordinary ladder — the collision is real, not manufactured');
  ok(real.rows[0].label !== real.rows[1].label, 'and yet the two labels differ');
  for (const r of real.rows) {
    ok(!/talis|macbook|9f3c1a|\bmac\b/.test(r.label),
      `no machine name appears — ${JSON.stringify(r.label)}`);
    ok(r.label.length <= 56, `and the row is ${r.label.length} characters, inside the 56 target`);
    eq(r.agePrecision, 'hour', 'because the AGE was escalated to hours instead');
    ok(/hr ago/.test(r.label), 'which is the same fact at a finer resolution, and makes no claim about hardware');
  }
  eq(real.rows.map((r) => r.ageText), ['34 hr ago', '36 hr ago'],
    'the exact two readings the maintainer will see');
  // The escalated age is the row's OWN ageText, not something composed only
  // into the label — two fields disagreeing about one age is how a list comes
  // to be sorted by one number and labelled with another.
  for (const r of real.rows) ok(r.label.endsWith(r.ageText), 'the label and the ageText field agree');

  // AND THE FOLDER NAME IS STILL REACHABLE. For this case the tooltip is the
  // ONLY place it appears anywhere, which is what makes the label safe to drop.
  ok(real.rows.some((r) => r.toolTip.includes('alices-macbook-pro-9f3c1a')),
    'the full machine folder name survives in the tooltip — the only place it now appears');
  ok(real.rows.some((r) => r.toolTip.includes('mac-9f3c1a')), 'and so does the other one');
  ok(real.rows.every((r) => r.toolTip.includes(REAL_SCOPE) && r.toolTip.includes('projects')),
    'along with everything else the compaction dropped');

  // CONTROL: with the ages already apart, nothing is escalated at all. Without
  // this, the assertions above would pass on an implementation that always
  // escalates — which would be a second, quieter defect.
  const apart = build([
    row({ machine: 'alices-macbook-pro-9f3c1a', isThisMachine: true, writtenAgeSeconds: 300 }),
    row({ machine: 'mac-9f3c1a', isThisMachine: true, writtenAgeSeconds: 132529 }),
  ]);
  eq(apart.rows.map((r) => r.agePrecision), [null, null],
    'CONTROL: rows that do not collide stay on the ordinary ladder, the one the app\'s memory view renders');
  ok(!/hr ago/.test(apart.rows[1].label) && /day ago/.test(apart.rows[1].label),
    'CONTROL: and still read "1 day ago", so the escalation above was caused by the collision');

  // ── B. GENUINELY DIFFERENT MACHINES ────────────────────────────────────
  //
  // Two hosts of the same name whose install ids share their first four hex
  // characters, so `shortMachineNames` gives them the same short label and they
  // collide. They are NOT one computer, so the machine label stays exactly as
  // it is and the age is NOT escalated — a finer age would be inventing a
  // distinction while the real one, that these are two computers, is already
  // on the row.
  //
  // THE AGES HERE ARE THE TWO FROM CASE A, DELIBERATELY. With identical ages an
  // escalation would be invisible — it would run, change nothing, and hand the
  // precision back — so a mutation letting different machines escalate came
  // back GREEN against the first version of this fixture. These two ages round
  // to the same words but ARE different, so escalation would visibly separate
  // them, and the assertion that it does not is a real one.
  const twoMachines = build([
    row({ machine: 'laptop-abcd1111', isThisMachine: false, writtenAgeSeconds: 124066 }),
    row({ machine: 'laptop-abcd2222', isThisMachine: false, writtenAgeSeconds: 132529 }),
  ]);
  for (const r of twoMachines.rows) {
    ok(/laptop/.test(r.label), 'a row from another machine keeps its machine label through a collision');
    eq(r.agePrecision, null, 'and its age is NOT escalated — different computers are not one computer');
  }
  ok(twoMachines.rows.every((r) => r.toolTip.includes('laptop-abcd')),
    'with the full, undisambiguated machine name in the tooltip');
  // Stated rather than implied: these two rows remain identical. That is a
  // shortMachineNames tag collision (four hex characters), not a compaction
  // defect, and inventing a finer age would hide it rather than fix it.
  eq(twoMachines.rows[0].label, twoMachines.rows[1].label,
    'they DO remain identical, which is a machine-label disambiguation problem and is recorded as one');
  ok(twoMachines.rows.every((r) => /1 day ago/.test(r.label)),
    'CONTROL: both still read "1 day ago" — the ages differ and an escalation WOULD have separated them, so declining to escalate is a decision this fixture can see');

  // A local row and a remote row never collide in the first place, because a
  // machine label is never dropped. The ordinary shape of "two machines".
  const mixed = build([
    row({ machine: 'mac-9f3c1a', isThisMachine: true, writtenAgeSeconds: 90000 }),
    row({ machine: 'studio-9f8e7d', isThisMachine: false, writtenAgeSeconds: 90000 }),
  ]);
  ok(mixed.rows[0].label !== mixed.rows[1].label, 'a local row and a remote row are distinguished with no work at all');
  ok(/studio/.test(mixed.rows.find((r) => !r.isThisMachine).label), 'the remote one names its machine');
  eq(mixed.rows.map((r) => r.agePrecision), [null, null], 'and neither age is touched');

  // ── C. THE UNRESOLVABLE CASE — same computer, inside one minute ────────
  const sameMinute = build([
    row({ machine: 'alices-macbook-pro-9f3c1a', isThisMachine: true, writtenAgeSeconds: 3600 }),
    row({ machine: 'mac-9f3c1a', isThisMachine: true, writtenAgeSeconds: 3600 }),
  ]);
  ok(sameMinute.rows[0].label !== sameMinute.rows[1].label,
    'two saves from one computer inside one minute are still told apart');
  ok(/alices-macbook-pro/.test(sameMinute.rows[0].label + sameMinute.rows[1].label)
    && /— mac ·/.test(sameMinute.rows[0].label + sameMinute.rows[1].label),
    'by the FOLDER NAMES, which is the last resort and the least-bad discriminator left');
  eq(sameMinute.rows.map((r) => r.agePrecision), [null, null],
    'and the finer age is HANDED BACK once it is shown to buy nothing — no row reads "60 min ago" beside rows saying "1 hr ago"');

  // ── D. AND THE GUARD THE FIRST MUTATION PASS MISSED ────────────────────
  //
  // The collision fix only ever FILLS AN EMPTY SLOT; it must never overwrite a
  // provenance that was already there. Deleting that skip came back GREEN on
  // the first pass, so a fixture was built for the shape it is reachable in.
  //
  // Two REMOTE rows whose machine field is absent both render "unknown
  // machine". They key as one computer, so the age escalates first — and with
  // identical ages that changes nothing, so it falls through. An unguarded fix
  // would then replace "unknown machine" with the HARNESS, which is the one
  // thing the two-meaning slot exists to prevent: it says that tool is running
  // HERE.
  const anonymous = build([
    row({ isThisMachine: false, writtenAgeSeconds: 90000 }),
    row({ isThisMachine: false, writtenAgeSeconds: 90000 }),
  ]);
  eq(anonymous.rows[0].label, anonymous.rows[1].label,
    'two rows with no machine and nothing else to tell them apart really do collide — the fixture is the shape being guarded');
  for (const r of anonymous.rows) {
    ok(/unknown machine/.test(r.label),
      'a REMOTE row keeps saying its machine is unknown, even inside a collision');
    ok(!/claude-code/.test(r.label),
      'and is NEVER relabelled with a harness — that would say the tool is running on THIS computer');
  }

  // ── E. THE LADDER ITSELF ───────────────────────────────────────────────
  //
  // Extended rather than duplicated: a second age formatter beside the app's
  // own is the smallest version of the drift problem this project keeps
  // recording. The DEFAULT arm must be byte-identical to the one
  // test-tray-shell.js §1 pins against src/public/next/views/memory.js.
  eq(model.AGE_PRECISIONS, [null, 'hour', 'minute'], 'the ladder is coarsest-first and has three rungs');
  for (const secs of [0, 59, 60, 3599, 3600, 86400, 400 * 86400, -1, null, NaN]) {
    eq(model.formatAge(secs, undefined), model.formatAge(secs),
      `an absent precision is byte-identical to the one-argument call (${secs})`);
  }
  eq(model.formatAge(124066), '1 day ago', 'the default ladder is unchanged');
  eq(model.formatAge(124066, 'hour'), '34 hr ago', 'an hour floor never goes coarser than hours');
  eq(model.formatAge(124066, 'minute'), '2067 min ago', 'a minute floor never goes coarser than minutes');
  eq(model.formatAge(30, 'minute'), 'just now', 'but nothing below a minute is invented — "just now" survives every floor');
  eq(model.formatAge(-1, 'minute'), null, 'and an absent age stays absent at every precision');
  eq(model.ageText(124066, 'file', 'hour'), 'changed 34 hr ago',
    'the file-clock qualifier survives escalation — which clock it came from is unchanged by reading it finer');
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
