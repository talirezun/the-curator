/**
 * test-tray-menu-bars.js — OFFLINE guard for the menubar widget's DEPTH BARS
 * (v3.66.0): `desktop/lib/menu-bars.js` (the drawing), the reading in
 * `desktop/lib/tray-model.js`, and its placement in `desktop/lib/tray-menu.js`.
 * From v3.74.0 (Layout A) one reading remains on the menu — each domain's
 * pages, inside the `Knowledge · N domains` submenu; the capture and
 * documents bars left with their lines (§6 proves they are gone).
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
 *   §6   the capture and documents bars LEFT the menu — domain bars only
 *   §7   stale documents survive as a notice, only when true
 *   §8   domains: largest first, the kit's identity mapping, every domain
 *   §9   the menu template: one Knowledge row, its submenu, clicks, the seam
 *   §10  width: no domain bar label passes the budget, under a fuzz
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
      // `slot` is each domain's RECORDED identity slot (v3.76.0) and is the
      // colour; `index` is the list position and deliberately is NOT.
      { domain: 'posts', index: 0, slot: 5, displayName: 'posts', pageCount: 687, entities: 301, concepts: 216, summaries: 170 },
      { domain: 'projects', index: 1, slot: 2, displayName: 'projects', pageCount: 30, entities: 10, concepts: 10, summaries: 10 },
      { domain: 'business', index: 2, slot: 9, displayName: 'business', pageCount: 120, entities: 60, concepts: 40, summaries: 20 },
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
section('§6 the capture and documents bars LEFT the menu (v3.74.0) — the domain bars are the only bars');
{
  // The fixture still SUPPLIES a capture reading on every project and a
  // documents reading on one — the data layer keeps computing them for the
  // app. The menu must draw neither: D5 measured that "N of M saved" counts
  // MCP process ids, not sessions, and the Documents line is configuration,
  // not activity (the maintainer's decision).
  const seen = [];
  const m = build(summary({ projects: [{ ...summary().projects[0], documents: docs({ readFirstCount: 2, readFirstBytes: 30 * KB }) },
    ...summary().projects.slice(1)] }), { dark: true, renderBar: (o) => { seen.push(o); return BARS.renderGutterBar(o); } });
  ok(summary().projects.every((p) => p.capture && Number.isInteger(p.capture.sessionsSaved)),
    'CONTROL — every project in the fixture carries a capture reading, so its absence below is a decision');
  const flat = MENU.flattenTrayMenu(MENU.buildTrayMenuTemplate(m, { ...NOOPS, makeIcon: (sp) => sp }));
  const words = flat.map((i) => [i.label, i.sublabel, i.toolTip].filter(Boolean).join('\n')).join('\n');
  ok(!/\bof \d+ saved\b|no logged sessions|no sessions logged|Agent sessions/.test(words),
    'no label, sublabel or tooltip anywhere in the menu states a capture reading');
  ok(!/^(Documents|Read first)\b/m.test(flat.map((i) => i.label || '').join('\n')),
    'no Documents or Read first line, although the headline project has a documents reading');
  ok(seen.length === m.domains.rows.length && seen.every((o) => o.danger !== true),
    `the bar renderer was asked for exactly the ${m.domains.rows.length} domain bars and nothing else — no capture bar, no documents bar`);
  const barred = flat.filter((i) => i.icon && Object.prototype.hasOwnProperty.call(i.icon, 'frac'));
  ok(barred.length === m.domains.rows.length && barred.every((i) => String(i.id).startsWith('tray-domain-')),
    'and every item carrying a bar is a domain row');
  ok(!['groups', 'documents', 'capture'].some((k) => Object.prototype.hasOwnProperty.call(m, k)),
    'the model carries no groups, documents or capture fields a later surface could quietly start drawing again');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§7 stale documents survive as a NOTICE — only when true');
{
  const stale = (n, u) => ({ staleCount: n, unreachableCount: u });
  const withStale = build(summary({ scopes: [scope('projects', 'curator', 10, { foundations: stale(2, 1) }), scope('business', 'alpha', 60 * 26, { foundations: stale(4, 0) })] }));
  const n = withStale.notices.filter((x) => x.kind === 'docs-stale');
  eq(n.map((x) => x.text), ['curator · 3 docs stale'],
    'an ACTIVE project with stale or unreachable documents gets one notice, the two counts summed under "stale"');
  ok(/not known to be current/.test(n[0].full), '… and its tooltip says what "stale" means here');
  ok(!n.some((x) => x.project === 'alpha'), 'an IDLE project\'s stale documents are not a notice — it is not being worked on');
  const clean = build(summary({ scopes: [scope('projects', 'curator', 10, { foundations: stale(0, 0) })] }));
  eq(clean.notices.filter((x) => x.kind === 'docs-stale').length, 0, 'CONTROL — nothing stale → no notice (only when true)');
  eq(M.staleDocsText('ott', 1), 'ott · 1 doc stale', 'one document is singular');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§8 (2) domains — largest first, the KIT\'S identity mapping, EVERY domain');
{
  const m = build(summary(), { dark: true });
  const d = m.domains;
  eq(d.header, 'Domains · pages', 'the submenu is headed "Domains · pages"');
  eq(d.label, 'Knowledge · 3 domains', 'the parent row names its unit and count: "Knowledge · 3 domains"');
  eq(d.rows.map((r) => r.domain), ['posts', 'business', 'projects'], 'largest first');
  eq(d.rows.map((r) => r.frac), [1, 120 / 687, 30 / 687], 'each against the LARGEST domain (687)');
  eq(d.rows.map((r) => r.ink), [5, 9, 2].map((slot) => PALETTE.slotHex(slot, 'dark')),
    '★ each bar wears its domain\'s RECORDED slot (v3.76.0) — the app\'s ONE mapping, not its list position');
  ok(d.rows[0].ink !== PALETTE.identityHex(0, 'dark'),
    'CONTROL — posts is index 0 but slot 5: the position colour differs, so the check above can fail');
  eq(d.rows.map((r) => r.ink), [5, 9, 2].map((slot) => PALETTE.identityHex(slot - 1, 'dark')),
    '…and it is identityHex(slot − 1), the palette main.js hands in');
  const light = build(summary()).domains;
  eq(light.rows.map((r) => r.ink), [5, 9, 2].map((slot) => PALETTE.slotHex(slot, 'light')), '… in the light ramp on a light menu');
  const high = build(summary({ domains: [
    { domain: 'h', index: 0, slot: 8, pageCount: 9 }, { domain: 'l', index: 1, slot: 12, pageCount: 3 }] }), { dark: true }).domains;
  eq(high.rows.map((r) => r.ink), [PALETTE.slotHex(8, 'dark'), PALETTE.slotHex(12, 'dark')],
    'slots 8 and 12 paint 8 and 12 — every one of IDENTITY_SLOTS is reachable');
  eq(d.rows[0].label, 'posts · 687 pages', 'the label is the figure');
  ok(/largest domain, posts \(687 pages\)/.test(d.rows[1].toolTip), 'the tooltip NAMES the denominator');
  // NO CAP: the submenu has room, so "…and N more" is gone (the approved mockup).
  const many = build(summary({ domains: [
    { domain: 'a', index: 0, pageCount: 10 }, { domain: 'b', index: 1, pageCount: 900 },
    { domain: 'c', index: 2, pageCount: 50 }, { domain: 'd', index: 3, pageCount: 40 },
    { domain: 'e', index: 4, pageCount: 30 }, { domain: 'f', index: 5, pageCount: null },
  ] })).domains;
  eq(many.rows.map((r) => r.domain), ['b', 'c', 'd', 'e', 'a', 'f'],
    'six domains → all six rows, largest first, the unreadable one last — no "…and N more" line');
  eq([many.label, many.total], ['Knowledge · 6 domains', 6], 'and the parent counts all six');
  ok(/1,030 pages counted \(1 could not be read\)/.test(many.toolTip), 'the parent\'s tooltip totals the pages and says one count is missing, never adding a zero');
  eq(build(summary({ domains: [{ domain: 'a', index: 0, pageCount: 5 }] })).domains.label, 'Knowledge · 1 domain', 'one domain is singular');
  // Absent ≠ 0.
  const unk = build(summary({ domains: [{ domain: 'a', index: 0, pageCount: 5 }, { domain: 'b', index: 1, pageCount: null }] })).domains;
  ok(unk.rows[1].bar === null && unk.rows[1].label.includes('pages unknown'),
    'a domain whose count could not be read has NO bar and says so');
  const empty = build(summary({ domains: [{ domain: 'a', index: 0, pageCount: 0 }, { domain: 'b', index: 1, pageCount: 0 }] })).domains;
  ok(empty.rows.every((r) => r.bar && r.frac === 0), 'every domain empty → empty tracks, never a division by zero');
  const bare = M.buildTrayModel(summary(), { now: NOW, dark: true }).domains;
  ok(bare.rows.every((r) => r.ink === null && r.bar.ink === BARS.BAR_PALETTE.dark.neutral),
    'with no identityHex handed in, every domain bar is NEUTRAL — a missing colour is never guessed');
  const unindexed = build(summary({ domains: [{ domain: 'a', index: 0, pageCount: 5 }] }), { dark: true }).domains;
  ok(unindexed.rows[0].ink === null && unindexed.rows[0].bar.ink === BARS.BAR_PALETTE.dark.neutral,
    'a domain with no RECORDED slot (only a list index) gets NO identity colour — a position is never a colour (v3.65.3 + v3.76.0)');
  eq(build(summary({ domains: null })).domains, null, 'domains null (unreadable) → no section');
  eq(build(summary({ domains: [] })).domains, null, 'no domains → no section');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§9 the menu template — Knowledge is ONE row with a submenu; clicks; the icon seam');
{
  const seen = [];
  const calls = { settings: 0 };
  const m = build(summary(), { dark: true });
  const tpl = MENU.buildTrayMenuTemplate(m, {
    ...NOOPS,
    onOpenSettings: () => { calls.settings++; },
    makeIcon: (sp) => { seen.push(sp); return { fake: 'image', from: sp }; },
  });
  const top = tpl.map((i) => i.id);
  const k = tpl.find((i) => i.id === MENU.ID_KNOWLEDGE);
  ok(k && Array.isArray(k.submenu) && !k.click && k.label === 'Knowledge · 3 domains',
    'the top level carries ONE Knowledge row, a submenu parent with no click of its own');
  ok(!top.some((id) => String(id || '').startsWith('tray-domain-')) && !top.includes(MENU.ID_HEADER_DOMAINS),
    'no domain row and no domains header on the top level — they are folded, saving the one surface with no height');
  const dh = k.submenu[0];
  ok(dh && dh.id === MENU.ID_HEADER_DOMAINS && dh.type === MENU.MENU_HEADER_TYPE && dh.enabled === false && !dh.icon,
    'the submenu opens on a real header — it carries no picture to grey');
  const drows = k.submenu.slice(1);
  ok(drows.length === 3 && drows.every((r) => r.enabled === true && r.icon && String(r.id).startsWith('tray-domain-')),
    'three enabled domain rows, each with its bar (a disabled item greys its icon)');
  drows.forEach((r) => r.click());
  eq(calls.settings, 3, '… each opening Settings, where the Vault folder monitor is the app twin');
  const ki = top.indexOf(MENU.ID_KNOWLEDGE);
  ok(ki > top.indexOf(MENU.ID_HEADER_ACTIVE) && ki < top.indexOf(MENU.ID_OPEN_MEMORY),
    'the Knowledge row closes the reading block: after the activity, before the commands');
  ok(m.domains.rows.every((r) => seen.includes(r.bar)), 'every bar SPEC reaches the injected seam unchanged');
  const safe = MENU.buildTrayMenuTemplate(m, { ...NOOPS, makeIcon: () => { throw new Error('boom'); } });
  const sk = safe.find((i) => i.id === MENU.ID_KNOWLEDGE);
  ok(sk && sk.submenu.length === 4 && sk.submenu.slice(1).every((r) => !r.icon && r.label),
    'a makeIcon that throws costs the bars, never the rows or the menu');
  const none = MENU.buildTrayMenuTemplate(build(summary({ domains: null })), NOOPS);
  ok(!none.some((i) => i.id === MENU.ID_KNOWLEDGE), 'no domains reading → no Knowledge row (not "0 domains")');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§10 width — no domain bar item can widen its submenu past the budget, under a fuzz of long names');
{
  const long = 'x'.repeat(70);
  const m = build(summary({
    domains: [{ domain: long, index: 0, displayName: long, pageCount: 1234567 }, { domain: 'b', index: 1, displayName: long + 'y', pageCount: 3 }],
  }), { dark: true });
  const barItems = m.domains.rows.filter((r) => r.bar);
  ok(barItems.length === 2, `CONTROL — ${barItems.length} bar items were built, so the check below is not vacuous`);
  ok(barItems.every((b) => b.label.length <= M.BAR_LABEL_CHARS),
    `every bar item's label ≤ ${M.BAR_LABEL_CHARS} (${barItems.map((b) => b.label.length).join(', ')})`);
  ok(m.domains.rows[0].label.endsWith('1,234,567 pages') && m.domains.rows[1].label.endsWith('3 pages'),
    'the FIGURE survives on every one — the name is what gives way');
  ok(m.domains.label.length <= M.PLAIN_LABEL_CHARS, 'and the parent row is short by construction');
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
