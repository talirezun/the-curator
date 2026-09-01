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
 * assertion about how a cell looks is an assertion about decoded alpha values
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
 *   §4   alpha encodes CADENCE, is capped, and never claims more
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
 *    declared size, and tints it as a template image is INFERRED from the
 *    installed electron.d.ts and from electron_menu_controller.mm, and is not
 *    observed.
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
    ['session-2026-09-01-menubar-widget-design', 'talis-macbook-pro-17d23c', 828, 'RESEARCH DONE, NOTHING BUILT. Heartbeat is drawable in the menu as a per-row icon PNG, but per-machine series are FICTION on the real store.'],
    ['session-2026-08-31-native-prep-and-release-process', 'talis-macbook-pro-17d23c', 43029, 'FOUR RELEASES SHIPPED (v3.31-v3.34). Mac app installs, updates itself in-app, sync data loss fixed.'],
    ['session-2026-08-30-design-conformance-pre-native', 'talis-macbook-pro-17d23c', 124066, 'v3.25.0, v3.26.0, v3.27.0 all SHIPPED and pushed. ALL NINE design findings CLOSED.'],
    ['session-2026-08-30-design-conformance-pre-native', 'mac-17d23c', 132529, '7 of 11 issues + ramp + machine-id fix MERGED. main 14 ahead UNPUSHED, 125/125 green.'],
    ['session-2026-08-30-ingest-continuity-tables', 'talis-macbook-pro-17d23c', 138636, 'SESSION COMPLETE. v3.24.0/1/2 all shipped and tagged. CLAUDE.md 183k to 43k tokens.'],
    ['session-2026-08-30-chat-streaming', 'talis-macbook-pro-17d23c', 160514, 'SHIPPED: v3.23.0 (chat streaming + thinking region + 5 UX fixes) and v3.23.1.'],
    ['session-2026-08-30-chat-streaming', 'mac-17d23c', 175018, 'Wave 1: 2 of 3 landed (SSE reader, OpenRouter adapter). llm.js still running.'],
    ['session-2026-08-29-ux-polish', 'mac-17d23c', 209028, 'FOUR releases shipped: v3.19.0 to v3.22.0. The floating text under every title is GONE.'],
  ];
  return rows.map(([scope, machine, age, headline]) => ({
    project: 'projects', scope, machine, harness: 'claude-code',
    isThisMachine: machine === 'mac-17d23c',   // what his installed app resolves
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
function decodeGrayAlpha(buf) {
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
  const grey = [], alpha = [];
  let q = 0;
  for (let y = 0; y < height; y++) {
    if (raw[q++] !== 0) throw new Error('unexpected filter byte');
    const gr = [], al = [];
    for (let x = 0; x < width; x++) { gr.push(raw[q++]); al.push(raw[q++]); }
    grey.push(gr); alpha.push(al);
  }
  return { width, height, depth, colorType, grey, alpha };
}

/** Every alpha value in cell `i`'s own column band, top to bottom, as one
 *  flat array — the thing two cell states must differ in. */
function cellColumn(decoded, i, scale = 1) {
  const pitch = (strip.CELL_POINTS + strip.GAP_POINTS) * scale;
  const x0 = i * pitch;
  const out = [];
  for (let y = 0; y < decoded.height; y++) {
    for (let x = x0; x < x0 + strip.CELL_POINTS * scale; x++) out.push(decoded.alpha[y][x]);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
section('§0 positive control on the imports');
{
  ok(typeof strip.renderPulseStrip === 'function', 'renderPulseStrip is exported');
  ok(typeof strip.pulseCells === 'function', 'pulseCells is exported');
  ok(typeof strip.pulseLabel === 'function', 'pulseLabel is exported');
  ok(typeof strip.pulseToolTip === 'function', 'pulseToolTip is exported');
  ok(typeof menu.ID_PULSE === 'string' && menu.ID_PULSE, 'the strip item has an id, so a caller need never match on its label');
  // The PNG encoder is IMPORTED from tray-icon.js, not reimplemented. Proven by
  // behaviour rather than by a grep: both modules must produce byte-identical
  // output for the same matrix, which a second encoder would not.
  const iconMod = await import(path.join(DESKTOP, 'lib', 'tray-icon.js'));
  const m = [[0, 128], [255, 7]];
  const viaStrip = strip.renderPulseStrip(pulseFixture({ buckets: [1] }));
  ok(viaStrip !== null, 'a one-bucket pulse still renders');
  ok(Buffer.isBuffer(iconMod.encodeAlphaPng(m)), 'and tray-icon.js is the encoder both use');
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
  const s = strip.renderPulseStrip(fullWindow());
  // GUARDED BEFORE THE DECODE. A missing representation would otherwise throw
  // inside decodeGrayAlpha, and a suite that reddens by CRASHING names nothing
  // — it reports that something broke, not which property was lost.
  ok(Buffer.isBuffer(s.buffer), 'a 1x representation exists');
  ok(Buffer.isBuffer(s.buffer2x),
    'and a 2x one — without it the strip is downsampled by the OS on every retina Mac sold in a decade');
  const d1 = decodeGrayAlpha(s.buffer);
  const d2 = decodeGrayAlpha(Buffer.isBuffer(s.buffer2x) ? s.buffer2x : s.buffer);

  eq(s.widthPoints, 28 * (strip.CELL_POINTS + strip.GAP_POINTS) - strip.GAP_POINTS,
    'the declared width is 28 bars at a 3pt pitch, less the trailing gap');
  eq([s.widthPoints, s.heightPoints], [83, 11], 'which is 83 x 11 points');
  eq([d1.width, d1.height], [83, 11], 'and the 1x bytes really are that size');
  eq([d2.width, d2.height], [166, 22], 'the 2x representation is exactly double — one drawing at two resolutions');
  eq([d1.depth, d1.colorType], [8, 4], 'colour type 4 = greyscale + alpha, 8 bits each');
  ok(d1.grey.every((r) => r.every((v) => v === 0)),
    'EVERY grey value is 0 — a template image carries all its information in alpha, and macOS tints it');

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
{
  // One image holding all three states at known indices, so every comparison
  // below is between pixels of the SAME rendering.
  const b = new Array(28).fill(0);
  b[20] = 1;          // ACTIVE
  b[21] = 0;          // EMPTY
  const mixed = pulseFixture({ buckets: b, events: 1, firstKnownBucket: 10, coversWholeWindow: false });
  const d = decodeGrayAlpha(strip.renderPulseStrip(mixed).buffer);

  const active = cellColumn(d, 20);
  const empty = cellColumn(d, 21);
  const unknown = cellColumn(d, 3);

  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);

  ok(!same(active, empty), 'ACTIVE and EMPTY differ in decoded alpha');
  ok(!same(empty, unknown), 'EMPTY and UNKNOWN differ in decoded alpha — "nothing happened" is not "no data"');
  ok(!same(active, unknown), 'ACTIVE and UNKNOWN differ in decoded alpha');

  // THE CONTROL. Without it, `!same(...)` proves only that the comparator is
  // capable of saying "different" — an assertion that can never fail is worth
  // nothing, and this repo has shipped several. Two cells in the SAME state
  // must compare EQUAL through the identical code path.
  ok(same(cellColumn(d, 4), cellColumn(d, 5)),
    'CONTROL: two UNKNOWN cells compare IDENTICAL, so the comparison above can fail');
  b[22] = 1;
  const twoActive = decodeGrayAlpha(strip.renderPulseStrip(
    pulseFixture({ buckets: b, events: 2, firstKnownBucket: 10 })).buffer);
  ok(same(cellColumn(twoActive, 20), cellColumn(twoActive, 22)),
    'CONTROL: two ACTIVE cells with the same count compare IDENTICAL too');

  // The distinction is by SHAPE and not merely by opacity — which is what makes
  // it survive at a 2pt bar width, where two similar alphas do not.
  const inked = (col) => col.filter((v) => v > 0).length;
  // EVERY CELL IS DRAWN, empties included. A strip that omits its empty cells
  // stops being a timeline and becomes a scatter of marks with no scale.
  ok(inked(empty) > 0, `an EMPTY bucket is DRAWN, at low opacity (${inked(empty)} inked pixels)`);
  ok(inked(unknown) > 0, 'and so is an UNKNOWN one');
  ok(inked(unknown) < inked(empty),
    `UNKNOWN is a shorter mark than EMPTY (${inked(unknown)} inked pixels against ${inked(empty)}) — a tick, not a bar`);
  eq(inked(active), inked(empty), 'ACTIVE and EMPTY are the same SHAPE and differ only in weight');
  ok(Math.max(...active) > Math.max(...empty),
    `and ACTIVE is the heavier of the two (${Math.max(...active)} against ${Math.max(...empty)})`);

  // The UNKNOWN tick sits on the BASELINE, so the strip still reads as a
  // timeline across the boundary rather than as two unrelated drawings.
  const bottomRow = d.height - 2;
  ok(d.alpha[bottomRow][3 * (strip.CELL_POINTS + strip.GAP_POINTS)] > 0,
    'the UNKNOWN tick is on the baseline row');
  ok(d.alpha[2][3 * (strip.CELL_POINTS + strip.GAP_POINTS)] === 0,
    'and nowhere near the top of the band');

  // And at 2x it is the same drawing, not a second one.
  const d2 = decodeGrayAlpha(strip.renderPulseStrip(mixed).buffer2x);
  ok(!same(cellColumn(d2, 20, 2), cellColumn(d2, 21, 2)), 'the three states are still distinct at 2x');
  ok(!same(cellColumn(d2, 21, 2), cellColumn(d2, 3, 2)), 'including EMPTY against UNKNOWN');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4 alpha encodes CADENCE, is capped, and never claims more');
{
  eq(strip.activeAlpha(1), strip.ACTIVE_ALPHA_BASE, 'one save is the base weight');
  ok(strip.activeAlpha(2) > strip.activeAlpha(1), 'two saves is heavier than one');
  ok(strip.activeAlpha(9) <= strip.ACTIVE_ALPHA_MAX, 'and it is capped — the scale cannot run away');
  eq(strip.activeAlpha(50), strip.ACTIVE_ALPHA_MAX, 'a pathological bucket saturates rather than overflowing');
  ok(strip.ACTIVE_ALPHA_BASE > strip.EMPTY_ALPHA + 0.3,
    'ONE save is unmistakably heavier than an empty bucket, not a shade darker');

  const b = new Array(28).fill(0);
  b[0] = 1; b[1] = 4;
  const d = decodeGrayAlpha(strip.renderPulseStrip(pulseFixture({ buckets: b, events: 5 })).buffer);
  ok(Math.max(...cellColumn(d, 1)) > Math.max(...cellColumn(d, 0)),
    'and the difference survives into the actual pixels');

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
  ok(/6 hours/.test(tip), 'and how much time one bar is');
  ok(/Solid|faint|baseline tick/.test(tip), 'it carries the legend for all three marks');
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
      machine: 'mac-17d23c', harness: 'claude-code', isThisMachine: true,
      writtenAgeSeconds: 800, ageSource: 'agent', headline: 'x'.repeat(200),
    }],
  };
  const m = model.buildTrayModel(summary, { now: NOW });
  ok(m.pulse !== null, 'the model carries a pulse when the summary does');
  ok(Buffer.isBuffer(m.pulse.strip.buffer), 'including the 1x PNG bytes');
  ok(Buffer.isBuffer(m.pulse.strip.buffer2x), 'and the 2x ones');

  const seen = [];
  const t = menu.buildTrayMenuTemplate(m, { ...NOOPS, makeIcon: (s) => { seen.push(s); return { fake: 'image' }; } });
  const flat = menu.flattenTrayMenu(t);
  const idx = flat.findIndex((i) => i.id === menu.ID_PULSE);
  ok(idx >= 0, 'the strip item is in the template');
  eq(flat[idx - 1].id, menu.ID_HEADLINE_WHERE, 'and it sits directly BELOW the headline pair, near the top');
  eq(flat[idx].enabled, false, 'it is a STATEMENT, not an action — the menu\'s existing idiom for a status line');
  ok(!flat[idx].click, 'and carries no click handler at all');
  eq(flat[idx].icon, { fake: 'image' }, 'the injected makeIcon result becomes the item\'s icon');
  eq(seen.length, 1, 'makeIcon is called exactly once');
  ok(seen[0] === m.pulse.strip, 'and is handed the strip itself, buffers and all');
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
    project: 'projects', scope: 'session-alpha', machine: 'mac-17d23c',
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
  ok(!/claude-code|mac-17d23c/.test(remote.rows[0].label),
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
  ok(max < 93, `the widest rendered line is ${max}, down from the 93 measured before this change`);
  ok(mean < 50, `and the mean is ${mean.toFixed(1)}, down from 58.4`);
  ok(lens.filter((n) => n > 70).length <= 3,
    `${lens.filter((n) => n > 70).length} lines run past 70, down from 15`);
  // The one row that still runs long is a REMOTE row, and its excess is
  // entirely the machine label — which may not be dropped. Stated as an
  // assertion so it cannot quietly become something else.
  const overRows = model.buildTrayModel(REAL_STORE, { now: NOW }).rows.filter((r) => r.label.length > 56);
  ok(overRows.every((r) => !r.isThisMachine),
    'every row still over 56 characters is a row from ANOTHER machine, whose machine label is not droppable');
  const localMax = Math.max(...model.buildTrayModel(REAL_STORE, { now: NOW })
    .rows.filter((r) => r.isThisMachine).map((r) => r.label.length));
  ok(localMax <= 56, `the widest LOCAL row is ${localMax} characters, inside the 56 target`);
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
  ok(checked === 8, `all ${checked} rows were checked, so the loop above is not vacuous`);

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
  ok(/mac-17d23c/.test(surfaced),
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
// Reachable in ordinary use, not exotic: one scope worked on from two machines,
// whose two ages round to the same words, is a handoff.
{
  const twin = (machine, isLocal) => ({
    project: 'projects', scope: 'session-alpha', machine, harness: 'claude-code',
    isThisMachine: isLocal, ageSource: 'agent', writtenAgeSeconds: 90000, headline: 'h',
  });
  const m = model.buildTrayModel({
    ok: true, scopes: [twin('mac-17d23c', true), twin('studio-9f8e7d', true)],
  }, { now: NOW });
  eq(m.rows[0].ageText, m.rows[1].ageText, 'the two rows really do have the same age text — the collision is real');
  ok(m.rows[0].label !== m.rows[1].label, 'and yet the two labels differ');
  ok(/mac/.test(m.rows[0].label) && /studio/.test(m.rows[1].label),
    'because the MACHINE came back — the token that actually differs, not the one that is shared');

  // CONTROL: with the ages apart, the same two rows stay compact. Without this
  // the assertion above would pass on an implementation that never compacts.
  const apart = model.buildTrayModel({
    ok: true,
    scopes: [twin('mac-17d23c', true), { ...twin('studio-9f8e7d', true), writtenAgeSeconds: 300 }],
  }, { now: NOW });
  ok(!/mac-17d23c|studio/.test(apart.rows[0].label + apart.rows[1].label),
    'CONTROL: when the labels already differ, nothing is restored and both rows stay compact');

  // ── THE GUARD THE FIRST MUTATION PASS MISSED ──────────────────────────
  //
  // The collision fix only ever FILLS AN EMPTY SLOT; it must never overwrite a
  // provenance that was already there. Deleting that skip came back GREEN on
  // the first pass, so a fixture was built for the shape it is reachable in.
  //
  // Two REMOTE rows whose machine field is absent both render "unknown
  // machine", which collides — and since there is then only one distinct
  // machine value in the group, an unguarded fix would replace that label with
  // the HARNESS. A harness on a row from another computer is the one thing the
  // two-meaning slot exists to prevent: it says that tool is running HERE.
  const anon = (over) => ({
    project: 'projects', scope: 'session-alpha', harness: 'claude-code',
    isThisMachine: false, ageSource: 'agent', writtenAgeSeconds: 90000, headline: 'h', ...over,
  });
  const anonymous = model.buildTrayModel({ ok: true, scopes: [anon({}), anon({})] }, { now: NOW });
  eq(anonymous.rows[0].label, anonymous.rows[1].label,
    'two rows with no machine and nothing else to tell them apart really do collide — the fixture is the shape being guarded');
  for (const r of anonymous.rows) {
    ok(/unknown machine/.test(r.label),
      'a REMOTE row keeps saying its machine is unknown, even inside a collision');
    ok(!/claude-code/.test(r.label),
      'and is NEVER relabelled with a harness — that would say the tool is running on THIS computer');
  }

  // When it is the HARNESS that differs, the harness is what comes back.
  const harnessTwin = model.buildTrayModel({
    ok: true,
    scopes: [
      { ...twin('mac-17d23c', true), harness: 'claude-code' },
      { ...twin('mac-17d23c', true), harness: 'claude-code' },
    ],
  }, { now: NOW });
  ok(harnessTwin.rows[0].label === harnessTwin.rows[1].label,
    'two rows identical in EVERY field stay identical — no label composition can separate them, and none pretends to');
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
  ok(/makeIcon:\s*pulseStripImage/.test(src), 'SCAN ONLY: the menu is built with the strip\'s icon factory');
  ok(/function pulseStripImage/.test(src), 'SCAN ONLY: and that factory exists');
  const fn = src.slice(src.indexOf('function pulseStripImage'), src.indexOf('function trayImage'));
  ok(/nativeImage\.createFromBuffer\(strip\.buffer,\s*\{\s*scaleFactor:\s*1\s*\}\)/.test(fn),
    'SCAN ONLY: the 1x buffer is built at scaleFactor 1');
  ok(/addRepresentation\(\{\s*scaleFactor:\s*2,\s*buffer:\s*strip\.buffer2x\s*\}\)/.test(fn),
    'SCAN ONLY: and the 2x buffer is added as a second representation');
  ok(/setTemplateImage\(true\)/.test(fn),
    'SCAN ONLY: setTemplateImage(true) — without it the strip is a black smear on a dark menu');
  ok(/catch\s*\{\s*\n\s*return null;/.test(fn),
    'SCAN ONLY: and it returns null rather than throwing, because a menu item that throws while being BUILT takes the whole menu');
  // The decisions must NOT be here. A geometry constant appearing in main.js
  // would mean a second opinion about the drawing in the one file no test runs.
  ok(!/CELL_POINTS|GAP_POINTS|firstKnownBucket|pulseCells/.test(src),
    'and NO drawing decision leaked into main.js — the geometry lives only where the suite can execute it');
}

console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
