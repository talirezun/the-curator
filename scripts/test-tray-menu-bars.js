/**
 * test-tray-menu-bars.js — OFFLINE guard for the menubar widget's DEPTH BARS
 * (v3.66.0): `desktop/lib/menu-bars.js` (the drawing), the three readings in
 * `desktop/lib/tray-model.js`, and their placement in `desktop/lib/tray-menu.js`.
 *
 * ── METHOD ──────────────────────────────────────────────────────────────────
 *
 * Pixels are DECODED by `scripts/visual/png.js`, an independent decoder, and
 * every ratio is recomputed by `scripts/visual/contrast.js`, the repo's audited
 * WCAG code — the same standard `test-tray-paint.js` holds the dots and the
 * strip to. The identity colours come from the REAL kit module
 * (`src/brain/identity-palette.js`), handed to the model exactly as main.js
 * hands it, so a second mapping or a second palette in the widget reds here.
 *
 * ── SECTIONS ────────────────────────────────────────────────────────────────
 *   §0   imports, with a positive control
 *   §1   geometry and the WIDTH COST, from `labelBudgetChars`
 *   §2   the spec shape, decoded at 1x and 2x
 *   §3   THE ALPHA CHANNEL ALONE — length, empty-vs-absent, over-run as SHAPE
 *   §4   contrast of every fill against every menu band, with a failing control
 *   §5   which ink is drawn (neutral · danger · identity) — decoded
 *   §6   (1) capture per project: numerator, NAMED denominator, absent ≠ 0
 *   §7   (3) documents: the app's own applicability rule, danger only on over-run
 *   §8   (2) domains: largest first, the kit's identity mapping, the cap
 *   §9   the menu template: placement, enabled-ness, clicks, the icon seam
 *   §10  width: no bar item can widen the menu, under a fuzz of long names
 *   §11  main.js wiring — SOURCE SCAN, weak by construction, labelled so
 *
 * ── NOT ENFORCED, stated rather than implied away ───────────────────────────
 *  - NOTHING HERE HAS BEEN RENDERED ON A SCREEN. Whether AppKit draws the 28pt
 *    image 1:1 beside an ENABLED ordinary item (it did for the 55pt strip),
 *    whether it aligns every title in the menu to the widest image, and how a
 *    `header` item with no icon now looks beside enabled project lines, all
 *    need a PHOTOGRAPH of the real menu (see REPORT-v366-widget.md).
 *  - The menu backgrounds are `rgba-png.js`'s ASSUMED band, not samples.
 */

import path from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
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

let BARS, M, MENU, RGBA, DOTS, png, contrast, PALETTE;
try {
  BARS = await import(path.join(DESKTOP, 'lib', 'menu-bars.js'));
  M = await import(path.join(DESKTOP, 'lib', 'tray-model.js'));
  MENU = await import(path.join(DESKTOP, 'lib', 'tray-menu.js'));
  RGBA = await import(path.join(DESKTOP, 'lib', 'rgba-png.js'));
  DOTS = await import(path.join(DESKTOP, 'lib', 'menu-dots.js'));
  png = await import(path.join(ROOT, 'scripts', 'visual', 'png.js'));
  contrast = await import(path.join(ROOT, 'scripts', 'visual', 'contrast.js'));
  PALETTE = await import(path.join(ROOT, 'src', 'brain', 'identity-palette.js'));
} catch (err) {
  console.log(`\n  ✗ FATAL — could not import the modules under test: ${err.message}`);
  process.exit(1);
}

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const NOW = new Date('2026-09-23T10:00:00Z');
const NOOPS = {
  onOpenScope: () => {}, onOpenMemory: () => {}, onOpenApp: () => {},
  onOpenSettings: () => {}, onRowAction: () => {},
};

function pixel(dec, x, y) {
  const p = (y * dec.width + x) * dec.channels;
  return [dec.data[p], dec.data[p + 1], dec.data[p + 2], dec.data[p + 3]];
}
/** The ALPHA of one decoded row, colour thrown away. */
function alphaRow(dec, y) {
  const out = [];
  for (let x = 0; x < dec.width; x++) out.push(pixel(dec, x, y)[3]);
  return out;
}
/** Opaque columns on the bar's centre line at 1x — the fill length in points. */
function opaqueRun(spec) {
  const dec = png.decodePng(spec.buffer);
  const row = alphaRow(dec, Math.floor(dec.height / 2));
  return row.filter((a) => a === 255).length;
}

// A fixture shaped exactly like getTraySummary() (REPORT-v366-data.md §1).
const KB = 1024;
function docs(over = {}) {
  const d = {
    count: 5, totalBytes: 88 * KB, budgetBytes: 204800, budgetExceeded: false,
    readFirstCount: 0, readFirstBytes: 0, readFirstBudgetBytes: 122880, readFirstBudgetExceeded: false,
    ...over,
  };
  const flagged = d.readFirstCount > 0;
  const amountBytes = flagged ? d.readFirstBytes : d.totalBytes;
  const applicableBudgetBytes = flagged ? d.readFirstBudgetBytes : d.budgetBytes;
  return { basis: flagged ? 'read-first' : 'stored', amountBytes, applicableBudgetBytes,
    exceeded: amountBytes > applicableBudgetBytes, ...d, ...('basis' in over ? { basis: over.basis } : {}) };
}
function scope(domain, project, ageMin, extra = {}) {
  return {
    domain, project, scope: 'main', machine: 'mac-a1b2c3', harness: 'claude-code',
    writtenAt: new Date(NOW.getTime() - ageMin * 60000).toISOString(),
    ageSource: 'agent', headline: 'did a thing', isThisMachine: true, ...extra,
  };
}
function summary(over = {}) {
  return {
    ok: true,
    scopes: [scope('projects', 'curator', 10), scope('business', 'alpha', 60 * 26)],
    projects: [
      { domain: 'projects', project: 'curator', projectLabel: 'projects / curator',
        capture: { sessions: 11, sessionsRead: 9, sessionsSaved: 9, lastSessionAt: null, domainMismatch: false },
        documents: docs() },
      { domain: 'business', project: 'alpha', projectLabel: 'business / alpha',
        capture: { sessions: 3, sessionsRead: 1, sessionsSaved: 1, lastSessionAt: null, domainMismatch: false },
        documents: null },
      // Scanned, never a row on screen — and it is the BUSIEST. The denominator
      // must be taken over it, not over the rows left after the caps.
      { domain: 'research', project: 'atlas', projectLabel: 'research / atlas',
        capture: { sessions: 20, sessionsRead: 18, sessionsSaved: 18, lastSessionAt: null, domainMismatch: false },
        documents: null },
    ],
    capture: { logPresent: true, logFiles: 1, windowDays: 30, busiestSaved: 18 },
    domains: [
      { domain: 'posts', index: 0, displayName: 'posts', pageCount: 687, entities: 301, concepts: 216, summaries: 170 },
      { domain: 'projects', index: 1, displayName: 'projects', pageCount: 30, entities: 10, concepts: 10, summaries: 10 },
      { domain: 'business', index: 2, displayName: 'business', pageCount: 120, entities: 60, concepts: 40, summaries: 20 },
    ],
    // The pulse contract, same shape as test-tray-paint.js's fixture.
    pulse: {
      windowSeconds: 604800, bucketSeconds: 21600, buckets: new Array(28).fill(0).map((_, i) => (i > 20 ? 1 : 0)),
      events: 7, eventsOutsideWindow: 0, pairsCounted: 2, pairsTruncated: 0, clock: 'agent',
      oldestEventAt: null, coversWholeWindow: true, firstKnownBucket: 0,
    },
    warnings: [],
    ...over,
  };
}
const build = (s, o = {}) => M.buildTrayModel(s, { now: NOW, identityHex: PALETTE.identityHex, ...o });

// ═══════════════════════════════════════════════════════════════════════════
section('§0 imports, with a positive control');
{
  ok(typeof BARS.renderGutterBar === 'function', 'menu-bars.js exports renderGutterBar');
  ok(typeof PALETTE.identityHex === 'function' && PALETTE.IDENTITY_SLOTS === 12,
    'the REAL kit palette is loaded (12 slots) — the one the app\'s identity dots read');
  const spec = BARS.renderGutterBar({ frac: 0.5 });
  ok(spec && Buffer.isBuffer(spec.buffer) && opaqueRun(spec) > 0,
    'CONTROL — a half bar decodes to real opaque pixels, so every "0 pixels" reading below is a measurement');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§1 geometry, and the WIDTH COST measured from the code');
{
  eq(M.BAR_ICON_POINTS, BARS.BAR_CANVAS_POINTS,
    'the model RESERVES exactly the gutter the renderer draws (a smaller reservation is a budget quietly wrong on every bar item)');
  eq(BARS.BAR_HEIGHT_POINTS, DOTS.DOT_POINTS, 'the bar is the recency dot\'s height, so the rows align');
  eq(BARS.BAR_CANVAS_POINTS, 28, 'a 28pt gutter (DESIGN §4.4)');
  eq(BARS.TRACK_WIDTH_POINTS, 24, 'a 24pt track');
  eq(BARS.TRACK_HEIGHT_POINTS, 5, '5pt tall');
  eq(M.BAR_LABEL_CHARS, M.labelBudgetChars(BARS.BAR_CANVAS_POINTS), 'the bar items\' budget IS labelBudgetChars(28)');
  eq([M.labelBudgetChars(0), M.labelBudgetChars(M.ROW_ICON_POINTS), M.BAR_LABEL_CHARS, M.labelBudgetChars(55)],
    [42, 40, 38, 33], 'the width table: plain 42 · 13pt dot 40 · 28pt bar 38 · 55pt strip 33 characters');
  const barItem = M.BAR_LABEL_CHARS * M.MENU_CHAR_POINTS + BARS.BAR_CANVAS_POINTS + M.MENU_ICON_GAP_POINTS;
  const titleColumn = M.MENU_WIDTH_POINTS - M.MENU_CHROME_POINTS;
  ok(barItem <= titleColumn,
    `a full bar item (${barItem}pt) fits the measured title column (${titleColumn}pt) — it does NOT widen the 363.5pt menu`);
  const sublabelRow = 46 * M.MENU_SUBLABEL_CHAR_POINTS + M.ROW_ICON_POINTS + M.MENU_ICON_GAP_POINTS;
  ok(sublabelRow >= barItem - 2.5 && sublabelRow <= titleColumn,
    `the widest item is still a scope row's 46-character sublabel (${sublabelRow.toFixed(1)}pt)`);
  // The anti-vacuity control: one character more WOULD widen it.
  ok((M.BAR_LABEL_CHARS + 1) * M.MENU_CHAR_POINTS + BARS.BAR_CANVAS_POINTS + M.MENU_ICON_GAP_POINTS > titleColumn,
    'CONTROL — a 39-character bar label would overrun the column, so 38 is the true edge, not a loose one');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2 the spec shape, decoded at 1x and 2x');
{
  const s = BARS.renderGutterBar({ frac: 0.25, dark: true });
  eq([s.widthPoints, s.heightPoints, s.template], [28, 13, false],
    '28 × 13 points, and NOT a template (macOS would flatten the danger and identity inks to one tint)');
  const d1 = png.decodePng(s.buffer), d2 = png.decodePng(s.buffer2x);
  eq([d1.width, d1.height, d1.channels], [28, 13, 4], '1x decodes to 28 × 13 RGBA');
  eq([d2.width, d2.height, d2.channels], [56, 26, 4], '2x decodes to 56 × 26 RGBA — one drawing at two resolutions');
  const run1 = alphaRow(d1, 6).filter((a) => a === 255).length;
  const run2 = alphaRow(d2, 13).filter((a) => a === 255).length;
  eq(run2, run1 * 2, `the 2x fill is exactly twice the 1x fill (${run1} → ${run2} px)`);
  eq(BARS.renderGutterBar({ frac: null }), null, 'frac null → NO image (not measured is not an empty bar)');
  for (const bad of [undefined, NaN, -0.1, Infinity, '0.5']) {
    eq(BARS.renderGutterBar({ frac: bad }), null, `frac ${String(bad)} → no image`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3 THE ALPHA CHANNEL ALONE — the reading survives with the colour thrown away');
{
  eq(opaqueRun(BARS.renderGutterBar({ frac: 0 })), 0, 'frac 0 (a MEASURED zero) → no fill …');
  const empty = png.decodePng(BARS.renderGutterBar({ frac: 0 }).buffer);
  const rimTop = alphaRow(empty, BARS.TRACK_Y_POINTS | 0).filter((a) => a > 0).length;
  ok(rimTop >= 20, `… but its TRACK is drawn (${rimTop} rim pixels on the top edge) — an empty bar and an absent one never share a picture`);
  ok(alphaRow(empty, BARS.TRACK_Y_POINTS | 0).every((a) => a <= Math.ceil(255 * BARS.RIM_ALPHA)),
    'the rim is scaffolding at ≤35% alpha, never mistakable for fill');
  eq(opaqueRun(BARS.renderGutterBar({ frac: 0.5 })), 12, 'frac 0.5 → 12 of 24 points');
  eq(opaqueRun(BARS.renderGutterBar({ frac: 1 })), 24, 'frac 1 → the whole 24-point track');
  ok(opaqueRun(BARS.renderGutterBar({ frac: 0.001 })) >= 1,
    'a non-zero share is NEVER drawn as none (≥ 1 point), so "some" and "nothing" stay apart');
  const lens = [0.1, 0.3, 0.6, 0.9].map((f) => opaqueRun(BARS.renderGutterBar({ frac: f })));
  ok(lens.every((v, i) => i === 0 || v > lens[i - 1]), `length is monotone in the share (${lens.join(' < ')})`);
  // THE OVER-RUN IS SHAPE: the fill leaves the track and reaches the canvas edge.
  const over = png.decodePng(BARS.renderGutterBar({ frac: 1.26, danger: true }).buffer);
  const full = png.decodePng(BARS.renderGutterBar({ frac: 1, danger: true }).buffer);
  const edge = BARS.TRACK_X_POINTS + BARS.TRACK_WIDTH_POINTS;   // 26
  ok(alphaRow(over, 6).slice(edge).every((a) => a === 255),
    'an OVER-RUN runs past the track\'s end to the canvas edge — readable in the alpha channel alone');
  ok(alphaRow(full, 6).slice(edge).every((a) => a === 0),
    'CONTROL — exactly-full does NOT, so "at budget" and "over budget" are different pixels');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4 contrast — every fill clears 3:1 against every menu band');
{
  const worst = (ink, theme) => Math.min(...RGBA.MENU_BG_BAND[theme]
    .map((bg) => contrast.contrastRatio([...hex(ink), 1], [...hex(bg), 1])));
  for (const theme of ['dark', 'light']) {
    for (const k of ['neutral', 'danger']) {
      const r = worst(BARS.BAR_PALETTE[theme][k], theme);
      ok(r >= RGBA.CONTRAST_FLOOR_NON_TEXT,
        `${theme} ${k} ${BARS.BAR_PALETTE[theme][k]} — worst ${contrast.round2(r)}:1 across the ${theme} band`);
    }
    const ids = PALETTE.IDENTITY_PALETTE[theme].map((h) => worst(h, theme));
    ok(ids.every((r) => r >= RGBA.CONTRAST_FLOOR_NON_TEXT),
      `every one of the 12 identity inks clears 3:1 on the ${theme} menu band (lowest ${contrast.round2(Math.min(...ids))})`);
  }
  // Anti-vacuity: Apple's systemGreen is known to fail on a light menu.
  ok(worst('#34C759', 'light') < RGBA.CONTRAST_FLOOR_NON_TEXT, 'CONTROL — #34C759 FAILS the same check on light, so the check can fail');
  // The rim is scaffolding and is reported, not held to the floor.
  const rimLight = contrast.compositeOver([...hex(BARS.BAR_PALETTE.light.neutral), BARS.RIM_ALPHA], [...hex('#DCDCDC'), 1]);
  console.log(`    (reported, not a floor) the light neutral rim composites at ${contrast.round2(contrast.contrastRatio(rimLight, [...hex('#DCDCDC'), 1]))}:1 — scaffolding, like menu-dots' rim`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5 which ink is drawn — decoded');
{
  const fill = (spec) => { const d = png.decodePng(spec.buffer); return pixel(d, 4, 6).slice(0, 3); };
  eq(fill(BARS.renderGutterBar({ frac: 1, dark: true })), hex(BARS.BAR_PALETTE.dark.neutral), 'dark neutral');
  eq(fill(BARS.renderGutterBar({ frac: 1 })), hex(BARS.BAR_PALETTE.light.neutral), 'anything but dark:true is LIGHT (the safe default)');
  eq(fill(BARS.renderGutterBar({ frac: 1, danger: true, dark: true })), hex(BARS.BAR_PALETTE.dark.danger), 'danger ink');
  const idInk = PALETTE.identityHex(3, 'dark');
  eq(fill(BARS.renderGutterBar({ frac: 1, ink: idInk, dark: true })), hex(idInk), 'an identity ink is drawn as given');
  eq(fill(BARS.renderGutterBar({ frac: 1.2, ink: idInk, danger: true, dark: true })), hex(BARS.BAR_PALETTE.dark.danger),
    'an over-run speaks in the DANGER ink whatever identity it carries');
  eq(fill(BARS.renderGutterBar({ frac: 1, ink: 'red', dark: true })), hex(BARS.BAR_PALETTE.dark.neutral),
    'a malformed ink falls back to neutral rather than throwing inside a menu build');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§6 (1) capture per project — numerator, NAMED denominator, absent ≠ 0');
{
  const m = build(summary(), { dark: true });
  const [cur, alpha] = m.groups;
  eq(cur.captureFrac, 9 / 18, 'curator: 9 saved ÷ the BUSIEST project\'s 18 — atlas, which is not even on screen');
  eq(alpha.captureFrac, 1 / 18, 'alpha: 1 ÷ 18');
  ok(cur.bar && cur.bar.frac === 0.5 && !cur.bar.danger, 'the bar is drawn, neutral — a share of the busiest is never a warning');
  ok(cur.label.includes('9 of 11 saved') && cur.label.length <= M.BAR_LABEL_CHARS,
    `the label carries the reading within ${M.BAR_LABEL_CHARS}: "${cur.label}"`);
  ok(/busiest project \(18 saved\)/.test(cur.toolTip) && /last 30 days/.test(cur.toolTip),
    'the tooltip NAMES the denominator and the window');
  // No log → no bar, no invented zero, said in words.
  const none = build(summary({
    projects: summary().projects.map((p) => ({ ...p, capture: null })),
    capture: { logPresent: false, windowDays: 30, busiestSaved: null },
  }));
  ok(none.groups.every((g) => g.bar === null && g.captureFrac === null),
    'NO usage log → NO bar on any header (absent is not an empty bar)');
  ok(none.groups.every((g) => !/\b0 of\b/.test(g.label) && g.toolTip.includes('no usage log')),
    '… no "0 of" is printed, and the tooltip says there is no log');
  // A measured zero: a log exists, nobody saved anything anywhere.
  const zero = build(summary({
    projects: summary().projects.map((p) => ({ ...p, capture: { sessions: 2, sessionsRead: 2, sessionsSaved: 0, lastSessionAt: null, domainMismatch: false } })),
    capture: { logPresent: true, windowDays: 30, busiestSaved: 0 },
  }));
  ok(zero.groups.every((g) => g.bar && g.captureFrac === 0 && opaqueRun(g.bar) === 0),
    'a MEASURED zero (busiest 0) is an EMPTY TRACK — drawn, never divided by zero');
  const idle = build(summary({
    projects: summary().projects.map((p, i) => (i === 0 ? { ...p, capture: { sessions: 0, sessionsRead: 0, sessionsSaved: 0, lastSessionAt: null, domainMismatch: false } } : p)),
  }));
  ok(idle.groups[0].label.includes('no sessions') && idle.groups[0].bar && idle.groups[0].captureFrac === 0,
    'a project with a log and no session in 30 days reads "no sessions" over an empty track');
  // A long name gives way; the reading does not.
  const longName = 'an-unreasonably-long-project-name-for-a-menu';
  const lm = build(summary({
    scopes: [scope('projects', longName, 5)],
    projects: [{ domain: 'projects', project: longName, projectLabel: 'projects / ' + longName,
      capture: { sessions: 11, sessionsRead: 9, sessionsSaved: 9, lastSessionAt: null, domainMismatch: false }, documents: null }],
  }));
  ok(lm.groups[0].label.endsWith('9 of 11 saved') && lm.groups[0].label.length <= M.BAR_LABEL_CHARS,
    `a long name is clipped so the figure survives: "${lm.groups[0].label}"`);
  // capture comes from projects[] first, falls back to the row's own record.
  const fb = build(summary({ projects: null, scopes: [scope('projects', 'curator', 10,
    { capture: { sessions: 4, sessionsRead: 4, sessionsSaved: 2, lastSessionAt: null, domainMismatch: false } })] }));
  eq(fb.groups[0].captureFrac, 2 / 18, 'with no projects[], the row\'s own capture reading is used');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§7 (3) documents — the APP\'S applicability rule, danger only on over-run');
{
  const withDocs = (d) => build(summary({
    projects: [{ ...summary().projects[0], documents: d }, ...summary().projects.slice(1)],
  }), { dark: true }).documents;
  const stored = withDocs(docs({ totalBytes: 88 * KB }));
  eq(stored.label, 'Documents · 88 of 200 KB', 'nothing flagged → stored bytes against the 200 KB project budget');
  eq([stored.basis, stored.frac, stored.over, stored.bar.danger], ['stored', 88 * KB / 204800, false, false],
    '… basis stored, share 88/200, not over, not danger');
  const rf = withDocs(docs({ totalBytes: 1980 * KB, budgetExceeded: true, readFirstCount: 3, readFirstBytes: 64 * KB }));
  eq(rf.label, 'Read first · 64 of 120 KB',
    'once anything is flagged → read-first bytes against 120 KB, EVEN THOUGH 1,980 KB stored is over 200');
  ok(!rf.over && !rf.bar.danger && rf.toolTip.includes('1,980 KB stored') && rf.toolTip.includes('(over)'),
    '… so the bar is NOT danger (the app warns on the read-first set), and the stored over-run is still told in the tooltip');
  const rfOver = withDocs(docs({ readFirstCount: 3, readFirstBytes: 151 * KB, readFirstBudgetExceeded: true }));
  eq(rfOver.label, 'Read first · over · 151 of 120 KB', 'an OVER-RUN says "over" in words, before the figures');
  ok(rfOver.over && rfOver.bar.danger && rfOver.bar.over, '… and only then is the bar danger, and over-run in shape');
  const stOver = withDocs(docs({ totalBytes: 1980 * KB, budgetExceeded: true }));
  eq(stOver.label, 'Documents · over · 1,980 of 200 KB', 'a stored over-run, with the app\'s en-US grouping');
  ok(stOver.label.length <= M.BAR_LABEL_CHARS && rfOver.label.length <= M.BAR_LABEL_CHARS,
    'both over-run labels fit the bar budget, so no clip can ever take "over" away');
  eq(withDocs(docs({ count: 0, totalBytes: 0 })).label, 'Documents · none', 'no documents → "none" …');
  eq(opaqueRun(withDocs(docs({ count: 0, totalBytes: 0 })).bar), 0, '… over an empty track (a measured zero)');
  eq(withDocs(docs({ totalBytes: 300 })).label, 'Documents · <1 of 200 KB', '300 bytes is "<1", never a rounded-down "0"');
  eq(withDocs(null), null, 'documents null (index refused / manifest unreadable) → NO item, never a zero');
  eq(build(summary({ scopes: [], projects: [] })).documents, null, 'an empty store has no documents item');
  ok(stored.route === 'projects/curator', 'the item routes to the HEADLINE project');
  eq(M.kbFigure(0), '0', 'kbFigure(0) is a real zero');
  eq(M.kbFigure(null), null, 'kbFigure(null) is no figure');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§8 (2) domains — largest first, the KIT\'S identity mapping, the cap');
{
  const m = build(summary(), { dark: true });
  const d = m.domains;
  eq(d.header, 'Domains · pages', 'the section is headed "Domains · pages"');
  eq(d.rows.map((r) => r.domain), ['posts', 'business', 'projects'], 'largest first');
  eq(d.rows.map((r) => r.frac), [1, 120 / 687, 30 / 687], 'each against the LARGEST domain (687)');
  eq(d.rows.map((r) => r.ink), [0, 2, 1].map((i) => PALETTE.identityHex(i, 'dark')),
    'each bar wears identityHex(its install index) — the app\'s ONE mapping, not a second one');
  const light = build(summary()).domains;
  eq(light.rows.map((r) => r.ink), [0, 2, 1].map((i) => PALETTE.identityHex(i, 'light')), '… in the light ramp on a light menu');
  // Past the old six slots: domain 8 and domain 12 must wear slots 8 and 12,
  // not a wrapped copy of slots 2 and 6 (a second, six-slot mapping).
  const high = build(summary({ domains: [
    { domain: 'h', index: 7, pageCount: 9 }, { domain: 'l', index: 11, pageCount: 3 }] }), { dark: true }).domains;
  eq(high.rows.map((r) => r.ink), [PALETTE.identityHex(7, 'dark'), PALETTE.identityHex(11, 'dark')],
    'indices 7 and 11 wear slots 8 and 12 — the widget wraps where the kit wraps, at IDENTITY_SLOTS, never earlier');
  ok(high.rows[0].ink !== PALETTE.identityHex(1, 'dark') && high.rows[1].ink !== PALETTE.identityHex(5, 'dark'),
    'CONTROL — those slots differ from the ones a six-slot wrap would pick, so the check above can fail');
  eq(d.rows[0].label, 'posts · 687 pages', 'the label is the figure');
  ok(/largest domain, posts \(687 pages\)/.test(d.rows[1].toolTip), 'the tooltip NAMES the denominator');
  // The cap: > 4 domains → 3 rows + "…and N more", largest over ALL of them.
  const many = build(summary({ domains: [
    { domain: 'a', index: 0, pageCount: 10 }, { domain: 'b', index: 1, pageCount: 900 },
    { domain: 'c', index: 2, pageCount: 50 }, { domain: 'd', index: 3, pageCount: 40 },
    { domain: 'e', index: 4, pageCount: 30 }, { domain: 'f', index: 5, pageCount: null },
  ] })).domains;
  eq([many.rows.length, many.moreLabel, many.hidden], [3, '…and 3 more', 3],
    'six domains → three rows and "…and 3 more" — the section never exceeds four items');
  eq(many.rows.map((r) => r.domain), ['b', 'c', 'd'], 'the three largest');
  const exactlyFour = build(summary({ domains: summary().domains.concat([{ domain: 'z', index: 3, pageCount: 1 }]) })).domains;
  eq([exactlyFour.rows.length, exactlyFour.moreLabel], [4, null], 'exactly four → all four, no "more" line');
  // Absent ≠ 0.
  const unk = build(summary({ domains: [{ domain: 'a', index: 0, pageCount: 5 }, { domain: 'b', index: 1, pageCount: null }] })).domains;
  ok(unk.rows[1].bar === null && unk.rows[1].label.includes('pages unknown'),
    'a domain whose count could not be read has NO bar and says so');
  const empty = build(summary({ domains: [{ domain: 'a', index: 0, pageCount: 0 }, { domain: 'b', index: 1, pageCount: 0 }] })).domains;
  ok(empty.rows.every((r) => r.bar && r.frac === 0), 'every domain empty → empty tracks, never a division by zero');
  // No palette handed in, or an unindexed domain → neutral, never a guessed colour.
  const bare = M.buildTrayModel(summary(), { now: NOW, dark: true }).domains;
  ok(bare.rows.every((r) => r.ink === null && r.bar.ink === BARS.BAR_PALETTE.dark.neutral),
    'with no identityHex handed in, every domain bar is NEUTRAL — a missing colour is never guessed');
  const unindexed = build(summary({ domains: [{ domain: 'a', pageCount: 5 }] }), { dark: true }).domains;
  ok(unindexed.rows[0].ink === null && unindexed.rows[0].bar.ink === BARS.BAR_PALETTE.dark.neutral,
    'a domain with no install index gets NO identity colour (v3.65.3\'s rule)');
  eq(build(summary({ domains: null })).domains, null, 'domains null (unreadable) → no section');
  eq(build(summary({ domains: [] })).domains, null, 'no domains → no section');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§9 the menu template — placement, clicks, and the icon seam');
{
  const seen = [];
  const calls = { scope: [], settings: 0 };
  const m = build(summary(), { dark: true });
  const flat = MENU.flattenTrayMenu(MENU.buildTrayMenuTemplate(m, {
    ...NOOPS,
    onOpenScope: (r) => calls.scope.push(r && r.route),
    onOpenSettings: () => { calls.settings++; },
    makeIcon: (sp) => { seen.push(sp); return { fake: 'image', from: sp }; },
  }));
  const ids = flat.map((i) => i.id);
  const byId = (id) => flat.find((i) => i.id === id);
  const doc = byId(MENU.ID_DOCUMENTS);
  ok(doc && doc.enabled === true && doc.icon && doc.icon.from === m.documents.bar,
    'the documents item is ENABLED and carries its bar through makeIcon');
  ok(ids.indexOf(MENU.ID_HEADER_PULSE) > 0, 'CONTROL — the fixture draws a pulse, so the ordering below compares two real positions');
  ok(ids.indexOf(MENU.ID_HEADLINE) < ids.indexOf(MENU.ID_DOCUMENTS)
    && ids.indexOf(MENU.ID_DOCUMENTS) < ids.indexOf(MENU.ID_HEADER_PULSE),
    '… directly under the headline block, above the save pulse');
  doc.click();
  eq(calls.scope.pop(), 'projects/curator', '… and its click opens Context on the headline project');
  const g0 = byId('tray-group-0');
  ok(g0.enabled === true && g0.icon && g0.icon.from === m.groups[0].bar && g0.type !== MENU.MENU_HEADER_TYPE,
    'a project header is an ENABLED item carrying its capture bar (a disabled one greys its icon)');
  const dh = byId(MENU.ID_HEADER_DOMAINS);
  ok(dh && dh.type === MENU.MENU_HEADER_TYPE && dh.enabled === false && !dh.icon,
    'the domains header is a real header — it carries no picture to grey');
  const drows = flat.filter((i) => String(i.id || '').startsWith('tray-domain-'));
  ok(drows.length === 3 && drows.every((r) => r.enabled === true && r.icon), 'three enabled domain rows, each with its bar');
  drows.forEach((r) => r.click());
  eq(calls.settings, 3, '… each opening Settings, where the Vault folder monitor is the app twin');
  const lastRow = Math.max(...flat.map((i, k) => (String(i.id || '').startsWith('tray-row-') ? k : -1)));
  ok(lastRow < ids.indexOf(MENU.ID_HEADER_DOMAINS) && ids.indexOf(MENU.ID_HEADER_DOMAINS) < ids.indexOf(MENU.ID_OPEN_MEMORY),
    'the domains section closes the reading block: after the last scope row, before the commands');
  ok(seen.includes(m.documents.bar) && m.domains.rows.every((r) => seen.includes(r.bar)),
    'every bar SPEC reaches the injected seam unchanged (template flag and all)');
  // A throwing seam costs the pictures, never the menu.
  const safe = MENU.buildTrayMenuTemplate(m, { ...NOOPS, makeIcon: () => { throw new Error('boom'); } });
  ok(Array.isArray(safe) && MENU.flattenTrayMenu(safe).some((i) => i.id === MENU.ID_DOCUMENTS && !i.icon),
    'a makeIcon that throws costs the bar, never the item or the menu');
  const more = MENU.flattenTrayMenu(MENU.buildTrayMenuTemplate(build(summary({ domains: [
    { domain: 'a', index: 0, pageCount: 1 }, { domain: 'b', index: 1, pageCount: 2 }, { domain: 'c', index: 2, pageCount: 3 },
    { domain: 'd', index: 3, pageCount: 4 }, { domain: 'e', index: 4, pageCount: 5 }] })), NOOPS)).find((i) => i.id === MENU.ID_DOMAINS_MORE);
  ok(more && more.label === '…and 2 more' && more.enabled === true && typeof more.click === 'function',
    '"…and N more" is enabled and routed — a line naming a place you cannot reach is worse than none');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§10 width — no bar item can widen the menu, under a fuzz of long names');
{
  const long = 'x'.repeat(70);
  const m = build(summary({
    scopes: [scope(long, long, 5), scope('b', long + 'y', 9)],
    projects: [{ domain: long, project: long, projectLabel: long + ' / ' + long,
      capture: { sessions: 99999, sessionsRead: 1, sessionsSaved: 99999, lastSessionAt: null, domainMismatch: true },
      documents: docs({ readFirstCount: 9, readFirstBytes: 9999 * KB }) }],
    capture: { logPresent: true, windowDays: 30, busiestSaved: 99999 },
    domains: [{ domain: long, index: 0, displayName: long, pageCount: 1234567 }],
  }), { dark: true });
  const barItems = [m.documents, ...m.groups.filter((g) => g.bar), ...m.domains.rows.filter((r) => r.bar)];
  ok(barItems.length >= 3, `CONTROL — ${barItems.length} bar items were built, so the check below is not vacuous`);
  ok(barItems.every((b) => b.label.length <= M.BAR_LABEL_CHARS),
    `every bar item's label ≤ ${M.BAR_LABEL_CHARS} (${barItems.map((b) => b.label.length).join(', ')})`);
  ok(m.groups[0].label.endsWith('99999 of 99999 saved') && m.domains.rows[0].label.endsWith('1,234,567 pages')
    && m.documents.label === 'Read first · over · 9,999 of 120 KB',
    'the FIGURE survives on every one — the name is what gives way');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§11 main.js wiring — SOURCE SCAN, weak by construction');
{
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const main = strip(readFileSync(path.join(DESKTOP, 'main.js'), 'utf8'));
  ok(/buildTrayModel\(traySnapshot,\s*\{[^}]*\bidentityHex\b[^}]*\}\)/.test(main),
    'main.js hands identityHex into buildTrayModel (it cannot be executed offline — this proves a line exists, nothing more)');
  ok(/path\.join\(APP_ROOT,\s*'src',\s*'brain',\s*'identity-palette\.js'\)/.test(main),
    '… resolved from the kit\'s own Node address by APP_ROOT, the same way getTraySummary is');
  const libs = readdirSync(path.join(DESKTOP, 'lib')).filter((f) => f.endsWith('.js'));
  ok(libs.every((f) => !/from\s+['"][^'"]*\/src\//.test(readFileSync(path.join(DESKTOP, 'lib', f), 'utf8'))),
    'no desktop/lib module imports from src/ — the palette arrives as an argument');
  const barsSrc = readFileSync(path.join(DESKTOP, 'lib', 'menu-bars.js'), 'utf8');
  ok(!PALETTE.IDENTITY_PALETTE.dark.concat(PALETTE.IDENTITY_PALETTE.light).some((h) => barsSrc.toUpperCase().includes(h.toUpperCase())),
    'menu-bars.js carries NO identity hex — there is no second copy of the palette to drift');
}

console.log(`\n${failed ? '✗' : '✓'} test-tray-menu-bars: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
