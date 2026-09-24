/**
 * test-tray-session-start.js — OFFLINE guard for the menubar widget's SESSION
 * START line (v3.70.0): the label and its cutting order, the gutter meter
 * (`desktop/lib/menu-bars.js` `renderGutterMeter`), the model item
 * (`desktop/lib/tray-model.js`) and its placement (`desktop/lib/tray-menu.js`).
 *
 * ── METHOD ──────────────────────────────────────────────────────────────────
 *
 * PARITY WITH THE APP IS EXECUTED, NOT READ. The widget imports nothing from
 * `src/`, so it carries copies of the kit's `formatTokens`, `bucketModel`
 * geometry and `bucketText`. This suite imports the REAL kit
 * (`src/public/next/shared/bucket.js`) and runs both over the same matrix of
 * meters, and the input is built by the REAL `sessionStartBrief` — so a fact
 * the widget states that the app does not, or words that drift, go red here.
 * The ramp is pinned by PARSING `tokens/layer.css` and `tokens/color.css`.
 * Pixels are decoded by `scripts/visual/png.js`, an independent decoder, and
 * ratios by `scripts/visual/contrast.js`.
 *
 * ── SECTIONS ────────────────────────────────────────────────────────────────
 *   §0  imports, with a positive control
 *   §1  kit parity — formatTokens, the geometry, the text alternative
 *   §2  the ramp, pinned against the CSS the app ships
 *   §3  contrast on the menu band, with the control that explains the hatch
 *   §4  pixels — the two lanes, the hatch only when set, the dashed room
 *   §5  the label and its cutting order (38 characters)
 *   §6  the model item — the only source, the failure line, no second notice
 *   §7  the menu template — placement, click, the icon seam
 *   §8  width — the menu does not widen, under a fuzz
 *
 * ── NOT ENFORCED ────────────────────────────────────────────────────────────
 *  - Nothing here has been rendered in a real macOS menu. The gutter PNGs were
 *    rendered to files for review (REPORT.md), not photographed.
 */

import path from 'node:path';
import { readFileSync } from 'node:fs';
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

let BARS, M, MENU, RGBA, KIT, SS, png, contrast;
try {
  BARS = await import(path.join(DESKTOP, 'lib', 'menu-bars.js'));
  M = await import(path.join(DESKTOP, 'lib', 'tray-model.js'));
  MENU = await import(path.join(DESKTOP, 'lib', 'tray-menu.js'));
  RGBA = await import(path.join(DESKTOP, 'lib', 'rgba-png.js'));
  KIT = await import(path.join(ROOT, 'src', 'public', 'next', 'shared', 'bucket.js'));
  SS = await import(path.join(ROOT, 'src', 'brain', 'session-start.js'));
  png = await import(path.join(ROOT, 'scripts', 'visual', 'png.js'));
  contrast = await import(path.join(ROOT, 'scripts', 'visual', 'contrast.js'));
} catch (err) {
  console.log(`\n  ✗ FATAL — could not import the modules under test: ${err.message}`);
  process.exit(1);
}

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), 1];
const ratio = (a, b) => contrast.contrastRatio(hex(a), hex(b));
const NOW = new Date('2026-09-24T10:00:00Z');
const NOOPS = {
  onOpenScope: () => {}, onOpenMemory: () => {}, onOpenApp: () => {},
  onOpenSettings: () => {}, onRowAction: () => {},
};

// ── Fixtures ────────────────────────────────────────────────────────────────
const LAYERS = (framing, brief, handoff, journal, index, read) => [
  { key: 'framing', label: 'framing', tokens: framing }, { key: 'brief', label: 'standing brief', tokens: brief },
  { key: 'handoff', label: 'latest handoff', tokens: handoff }, { key: 'journal', label: 'journal', tokens: journal },
  { key: 'index', label: 'document list', tokens: index }, { key: 'read', label: 'read first', tokens: read }];

/** A report shaped like `sessionStartReport`'s (REPORT-p2.md), run through
 *  the REAL `sessionStartBrief` — the widget's only input. */
function report({ domain = 'projects', project = 'curator', layers = LAYERS(925, 3500, 500, 1025, 875, 15900),
  windowTokens = 1000000, windowSet = true, harness = null, budget = 16384, replies = 2, onDemand = { documents: 7, tokens: 32100 } } = {}) {
  const tokens = layers.reduce((a, l) => a + l.tokens, 0);
  const rLayers = layers.map((l) => ({ key: l.key === 'read' ? 'readFirst' : l.key, label: l.label, bytes: l.tokens * 4, tokens: l.tokens }));
  return {
    ok: true, domain, project, planned: true,
    bytes: { mcp: tokens * 4 }, tokens: { mcp: tokens, hook: null },
    layers: rLayers,
    budget: { bytes: budget * 4, tokens: budget, source: 'owner', preset: 'standard', custom: false, nearest: null },
    onDemand: { ...onDemand, notAtStart: 0 },
    delivery: { replies, paged: replies > 1, pageTokens: 20480 },
    window: { tokens: windowTokens, set: windowSet },
    harness: { tokens: harness, set: harness !== null },
    meter: {
      windowTokens, harnessTokens: harness,
      layers: layers.map((l) => ({ key: l.key, label: l.label, tokens: l.tokens })),
      budgetTokens: budget, onDemand, delivery: { replies, replyTokens: 20480 }, preview: false,
    },
  };
}
const brief = (o) => SS.sessionStartBrief(report(o));

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
    lastSave: { domain: 'projects', project: 'curator' },
    scopes: [scope('projects', 'curator', 10), scope('business', 'alpha', 60 * 26)],
    projects: [
      { domain: 'projects', project: 'curator', capture: null,
        documents: { count: 5, totalBytes: 90000, budgetBytes: 204800, budgetExceeded: false, readFirstCount: 2,
          readFirstBytes: 63200, readFirstBudgetBytes: 65536, readFirstBudgetExceeded: false,
          basis: 'read-first', amountBytes: 63200, applicableBudgetBytes: 65536, exceeded: false } },
    ],
    sessionStart: brief(),
    warnings: [],
    ...over,
  };
}
const build = (s, o = {}) => M.buildTrayModel(s, { now: NOW, ...o });

function pixel(dec, x, y) {
  const p = (y * dec.width + x) * dec.channels;
  return [dec.data[p], dec.data[p + 1], dec.data[p + 2], dec.data[p + 3]];
}
const toHex = (p) => '#' + p.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();

// ═══════════════════════════════════════════════════════════════════════════
section('§0 imports, with a positive control');
{
  ok(typeof BARS.renderGutterMeter === 'function' && typeof M.sessionStartLabel === 'function',
    'menu-bars.js exports renderGutterMeter; tray-model.js exports sessionStartLabel');
  ok(typeof KIT.bucketText === 'function' && typeof SS.sessionStartBrief === 'function',
    'the REAL kit and the REAL sessionStartBrief are loaded');
  const spec = BARS.renderGutterMeter({ ...M.meterGutter(brief().meter), dark: true });
  const dec = png.decodePng(spec.buffer2x);
  let opaque = 0;
  for (let y = 0; y < dec.height; y++) for (let x = 0; x < dec.width; x++) if (pixel(dec, x, y)[3] === 255) opaque++;
  ok(opaque > 100, `CONTROL — a real meter decodes to ${opaque} opaque pixels at 2x, so every "no pixel" reading below is a measurement`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§1 kit parity — the widget\'s copies against the REAL kit');
{
  const ns = [0, 1, 49, 50, 99, 100, 949, 950, 999, 6875, 9950, 10000, 20480, 22725, 99949, 99950, 100000, 199999,
    200000, 873000, 999499, 999500, 1000000, 1049999, 1050000, 1500000, 10000000, -5, NaN, null, undefined, '12'];
  eq(ns.map(M.formatTokens), ns.map(KIT.formatTokens), `formatTokens agrees with the kit on ${ns.length} values across every rung`);
  eq(M.KIT_LAYER_KEYS, KIT.LAYER_KEYS, 'the layer keys are the kit\'s');
  const meters = [];
  for (const windowTokens of [200000, 1000000, 8000, 0]) {
    for (const harnessTokens of [null, 0, 50000, 250000]) {
      for (const [budgetTokens, read] of [[16384, 0], [16384, 15800], [16384, 30000], [0, 0], [204800, 120000]]) {
        for (const delivery of [null, { replies: 1, replyTokens: 20480 }, { replies: 3 }]) {
          meters.push({ windowTokens, harnessTokens, budgetTokens, delivery,
            layers: LAYERS(925, 3500, 500, 1025, 875, read).concat(read === 30000 ? [{ key: 'future', label: '', tokens: 10 }] : []),
            onDemand: read === 0 ? { tokens: 47900, documents: 9 } : (read === 15800 ? 1234 : null),
            preview: budgetTokens === 0 && delivery !== null });
        }
      }
    }
  }
  meters.push(null, {}, { windowTokens: 1e6, layers: 'x' });
  eq(meters.map((m) => M.meterText(m)), meters.map((m) => KIT.bucketText(m)),
    `meterText IS the kit's bucketText, sentence for sentence, on ${meters.length} meters (preview, over-full, budget 0, unknown key, every onDemand shape)`);
  const FIELDS = ['windowTokens', 'harnessSet', 'harness', 'curator', 'used', 'over', 'free', 'harnessPct', 'curatorPct',
    'freePct', 'readTokens', 'fixed', 'budget', 'room', 'roomPct', 'roomState', 'onDemand', 'delivery', 'preview'];
  const pick = (g) => (g ? { ...Object.fromEntries(FIELDS.map((f) => [f, g[f]])),
    layers: g.layers.map((l) => [l.key, l.label, l.tokens, l.pct]) } : null);
  eq(meters.map((m) => pick(M.meterModel(m))), meters.map((m) => pick(KIT.bucketModel(m))),
    'meterModel returns the kit\'s bucketModel geometry, field for field, on the same matrix');
  // A dumb cross-check of the clever one: the enlargement closes to 100%.
  const g = M.meterModel(brief().meter);
  ok(Math.abs(g.layers.reduce((a, l) => a + l.pct, 0) + g.roomPct - 100) < 1e-9,
    'the enlargement\'s layers plus its room are exactly 100% (fixed + max(budget, read first))');
  eq(Object.keys(brief()).sort(), ['budget', 'bytes', 'delivery', 'domain', 'harness', 'layers', 'meter', 'onDemand',
    'planned', 'project', 'tokens', 'window'], 'CONTROL — the input is the real sessionStartBrief shape');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2 the ramp, pinned against the CSS the app ships');
{
  const colorCss = readFileSync(path.join(ROOT, 'src', 'public', 'next', 'tokens', 'color.css'), 'utf8');
  const layerCss = readFileSync(path.join(ROOT, 'src', 'public', 'next', 'tokens', 'layer.css'), 'utf8');
  const prim = {};
  for (const mm of colorCss.matchAll(/--((?:ink|violet)-\d+):\s*(#[0-9A-Fa-f]{6})/g)) if (!prim[mm[1]]) prim[mm[1]] = mm[2].toUpperCase();
  const block = (sel) => {
    const i = layerCss.indexOf(sel + ' {');
    const body = layerCss.slice(i, layerCss.indexOf('}', i));
    const out = {};
    for (const mm of body.matchAll(/--ly-([a-z-]+):\s*var\(--([a-z]+-\d+)\)/g)) out[mm[1]] = prim[mm[2]];
    return out;
  };
  const css = { dark: block(':root'), light: block('[data-theme="light"]') };
  ok(Object.keys(css.dark).length >= 14 && Object.keys(css.light).length >= 14, 'CONTROL — both theme blocks of layer.css parsed');
  for (const theme of ['dark', 'light']) {
    const r = BARS.LAYER_RAMP[theme];
    eq(['framing', 'brief', 'handoff', 'journal', 'index', 'read', 'other'].map((k) => r[k]),
      ['framing', 'brief', 'handoff', 'journal', 'index', 'read', 'other'].map((k) => css[theme][k]),
      `${theme}: every layer fill is the kit's --ly-* (no second ramp)`);
    eq([r.room, r.curator], [css[theme]['room-edge'], css[theme]['room-edge']],
      `${theme}: the dashed room and the window lane's Curator are the kit's --ly-room-edge`);
  }
  ok(BARS.LAYER_RAMP.light.read !== BARS.LAYER_RAMP.dark.read, 'the light read-first step differs, as the kit\'s does (violet-100 vanishes on white)');
  eq(BARS.meterRamp({ dark: 'yes' }), BARS.LAYER_RAMP.light, 'anything but a literal dark:true is the light ramp');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3 contrast on the menu band');
{
  for (const theme of ['dark', 'light']) {
    const band = RGBA.MENU_BG_BAND[theme];
    const r = BARS.LAYER_RAMP[theme];
    const neutral = BARS.BAR_PALETTE[theme].neutral;
    const worst = (h) => Math.min(...band.map((b) => ratio(h, b)));
    ok(worst(r.room) >= 3, `${theme}: the dashed room edge clears 3:1 on every band (${worst(r.room).toFixed(2)})`);
    ok(worst(r.curator) >= 3, `${theme}: the window lane's Curator fill clears 3:1 (${worst(r.curator).toFixed(2)})`);
    ok(worst(neutral) >= 3, `${theme}: the hatch and the layer frame (neutral ink) clear 3:1 (${worst(neutral).toFixed(2)})`);
    const order = ['framing', 'brief', 'handoff', 'journal', 'index', 'read'];
    const pairs = order.slice(1).map((k, i) => ratio(r[order[i]], r[k]));
    ok(pairs.every((x) => x >= 3), `${theme}: every pair of neighbouring layers is ≥ 3:1 (${pairs.map((x) => x.toFixed(2)).join(', ')})`);
    ok(order.every((k) => ratio(r[k], neutral) >= 1.0), `${theme}: each layer is drawn inside the neutral frame (reported, not a floor)`);
  }
  // Why the hatch is not the kit's: ink-600/ink-700 on a dark menu.
  const kitHatch = Math.max(...RGBA.MENU_BG_BAND.dark.map((b) => ratio('#363648', b)));
  ok(kitHatch < 3, `CONTROL — the kit's own hatch ink (ink-600) on a dark menu is ${kitHatch.toFixed(2)}:1, so it could not be reused`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4 pixels — two lanes, the hatch only when set, the dashed room');
{
  const S = 2;
  const spec = (o, dark = true) => BARS.renderGutterMeter({ ...M.meterGutter(brief(o).meter), dark });
  const dec = (sp) => png.decodePng(sp.buffer2x);
  const lane = (d, y0pt, y1pt) => {
    const out = [];
    for (let y = y0pt * S; y < y1pt * S; y++) for (let x = 0; x < d.width; x++) out.push({ x, y, p: pixel(d, x, y) });
    return out;
  };
  const noHarness = spec({ harness: null });
  const withHarness = spec({ harness: 120000 });
  eq([noHarness.widthPoints, noHarness.heightPoints, noHarness.template, noHarness.danger], [28, 13, false, false],
    'a 28 × 13 still, never a template, never danger');
  const d1 = png.decodePng(noHarness.buffer);
  eq([d1.width, d1.height, dec(noHarness).width, dec(noHarness).height], [28, 13, 56, 26], '1x and 2x decode to one drawing at two resolutions');
  const N = BARS.BAR_PALETTE.dark.neutral;
  const R = BARS.LAYER_RAMP.dark;
  const winNo = lane(dec(noHarness), BARS.METER_WINDOW_Y_POINTS, BARS.METER_WINDOW_Y_POINTS + BARS.METER_WINDOW_H_POINTS);
  const winYes = lane(dec(withHarness), BARS.METER_WINDOW_Y_POINTS, BARS.METER_WINDOW_Y_POINTS + BARS.METER_WINDOW_H_POINTS);
  const opaqueNeutral = (px) => px.filter((q) => q.p[3] === 255 && toHex(q.p) === N).length;
  eq(opaqueNeutral(winNo), 0, 'harness NOT set → no hatch pixel anywhere in the window lane');
  ok(opaqueNeutral(winYes) > 10, `harness set → the hatch is drawn (${opaqueNeutral(winYes)} opaque neutral pixels)`);
  // The hatch is a PATTERN in the alpha channel alone: inside the harness span
  // there are opaque AND empty pixels.
  const hx = Math.round(24 * S * (120000 / 1e6));
  const span = winYes.filter((q) => q.x >= 2 * S && q.x < 2 * S + hx);
  ok(span.some((q) => q.p[3] === 255) && span.some((q) => q.p[3] === 0), '… and it is a pattern in alpha alone — stripes and gaps, not a colour');
  ok(span.every((q) => q.p[3] === 0 || toHex(q.p) === N), '… every painted harness pixel is the neutral ink, never violet');
  // The Curator keeps at least 1pt at 1M (its true share is 0.2pt).
  const cur = winNo.filter((q) => q.y === BARS.METER_WINDOW_Y_POINTS * S && q.p[3] === 255 && toHex(q.p) === R.curator).length;
  eq(cur, BARS.MIN_FILL_POINTS * S, `The Curator's ≈22.7k of 1M is under a point, drawn at the 1pt minimum (${cur}px at 2x)`);
  ok(winNo.some((q) => q.p[3] > 0 && q.p[3] < 255), 'the free window is the faint track (translucent), so the share has a whole');
  // The enlargement: centre row, left to right.
  const zd = dec(spec({ layers: LAYERS(925, 3500, 500, 1025, 875, 15800), budget: 16384 }));
  const cy = Math.floor((BARS.METER_ZOOM_Y_POINTS + BARS.METER_ZOOM_H_POINTS / 2) * S);
  const row = [];
  for (let x = 0; x < zd.width; x++) row.push(pixel(zd, x, cy));
  const runs = [];
  for (const p of row) {
    const h = p[3] === 255 ? toHex(p) : null;
    if (h && (!runs.length || runs[runs.length - 1] !== h)) runs.push(h);
  }
  const layerInks = runs.filter((h) => h !== N);
  ok(layerInks.length >= 3, `CONTROL — the centre row has ${layerInks.length} layer runs to compare`);
  ok(['brief', 'journal', 'read'].every((k) => runs.includes(R[k])), 'the brief, journal and read-first steps are all on the centre row');
  ok(runs.indexOf(R.brief) < runs.indexOf(R.journal) && runs.indexOf(R.journal) < runs.indexOf(R.read),
    '… in the kit\'s drawing order (brief before journal before read first)');
  ok(runs[0] === N, 'the layer block starts with its neutral frame (the extent clears 3:1 whatever the first layer is)');
  // The room: unused budget → a dashed outline, empty inside.
  const ud = dec(spec({ layers: LAYERS(925, 3500, 500, 1025, 875, 0), budget: 16384, replies: 1 }));
  const topY = BARS.METER_ZOOM_Y_POINTS * S;
  const roomTop = [];
  for (let x = 12 * S; x < 25 * S; x++) roomTop.push(pixel(ud, x, topY));
  ok(roomTop.some((p) => p[3] === 255 && toHex(p) === R.room) && roomTop.some((p) => p[3] === 0),
    'an unused reading budget is a DASHED room — violet dashes and gaps along its top edge (alpha alone)');
  const roomMid = [];
  for (let x = 12 * S; x < 25 * S; x++) roomMid.push(pixel(ud, x, cy));
  ok(roomMid.every((p) => p[3] === 0), '… and EMPTY inside: an unused room is drawn as room, never as a fill');
  // Index only: no budget → no room; the layers reach the track's end.
  const id = dec(spec({ layers: LAYERS(925, 3500, 500, 1025, 875, 0), budget: 0, replies: 1 }));
  const endX = (2 + 24) * S - 1;
  ok(toHex(pixel(id, endX, cy)) === N && pixel(id, endX, cy)[3] === 255, 'budget 0 (Index only) → no room: the framed layers fill the track');
  let roomPx = 0;
  // Counted on the enlargement's top edge, where a layer shows only its neutral
  // frame — the room ink is also the brief's step, so a whole-lane count would
  // be counting the brief.
  for (let x = 0; x < id.width; x++) if (toHex(pixel(id, x, topY)) === R.room && pixel(id, x, topY)[3] === 255) roomPx++;
  let roomPxU = 0;
  for (let x = 0; x < ud.width; x++) if (toHex(pixel(ud, x, topY)) === R.room && pixel(ud, x, topY)[3] === 255) roomPxU++;
  ok(roomPxU > 0, `CONTROL — the same count on the unused-budget meter finds ${roomPxU} room pixels`);
  eq(roomPx, 0, '… and not one room-edge pixel on the enlargement\'s edge');
  // Never danger.
  const danger = [BARS.BAR_PALETTE.dark.danger, BARS.BAR_PALETTE.light.danger];
  const all = [];
  for (const d of [dec(withHarness), zd, ud, id]) for (let y = 0; y < d.height; y++) for (let x = 0; x < d.width; x++) all.push(toHex(pixel(d, x, y)));
  ok(!all.some((h) => danger.includes(h)), 'no pixel is ever the danger ink — a window is not a budget the owner set');
  // Light theme draws the light ramp.
  const lt = dec(spec({ layers: LAYERS(925, 3500, 500, 1025, 875, 15800) }, false));
  const lrow = [];
  for (let x = 0; x < lt.width; x++) lrow.push(toHex(pixel(lt, x, cy)));
  ok(lrow.includes(BARS.LAYER_RAMP.light.read) && !lrow.includes(BARS.LAYER_RAMP.dark.read), 'a light menu gets the light read-first step, not the dark one');
  // Absent is not zero.
  eq([BARS.renderGutterMeter(null), BARS.renderGutterMeter({}), M.meterGutter(null), M.meterGutter({ windowTokens: 0, layers: [] })],
    [null, null, null, null], 'no meter, no window, no layers → NO picture (never an empty meter standing in for "not measured")');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5 the label and its cutting order');
{
  const L = (o) => M.sessionStartLabel(brief(o));
  const k227 = LAYERS(925, 3500, 500, 1025, 875, 15900);          // ≈22.7k
  eq(M.formatTokens(k227.reduce((a, l) => a + l.tokens, 0)), '22.7k', 'CONTROL — the fixture is ≈22.7k');
  const design = 'Session start ≈22.7k tok · 2 replies · 2.3% of 1M';
  ok(design.length > M.BAR_LABEL_CHARS, `CONTROL — the design's example is ${design.length} characters, over the ${M.BAR_LABEL_CHARS} budget, so a cut is required`);
  eq(L({ layers: k227, windowSet: true, replies: 2 }), 'Session start ≈22.7k tok · 2.3% of 1M',
    'window SET → the share of the window is kept; the replies go to the tooltip');
  eq(L({ layers: k227, windowSet: false, windowTokens: 200000, replies: 2 }), 'Session start ≈22.7k tok · 2 replies',
    'window NOT set → the share goes FIRST; the replies are kept');
  eq(L({ layers: k227, windowSet: false, windowTokens: 200000, replies: 1 }), 'Session start ≈22.7k tok',
    '… and an unset window\'s share never costs the unit: with one reply the head stands alone');
  eq(L({ layers: k227, windowSet: true, windowTokens: 200000, replies: 1 }), 'Session start ≈22.7k · 11.4% of 200k',
    'a SET 200k window: " tok" gives way so the chosen window\'s share survives');
  eq(L({ layers: LAYERS(900, 3500, 500, 1000, 900, 0), windowSet: true, replies: 1 }), 'Session start ≈6.8k tok · 0.7% of 1M',
    'one reply is not a clause: "Session start ≈6.8k tok · 0.7% of 1M"');
  eq(L({ layers: LAYERS(1100, 3500, 500, 1025, 875, 28000), windowSet: true, windowTokens: 200000, replies: 2 }),
    'Session start ≈35k tok · 17.5% of 200k', 'exactly 38 characters is kept whole');
  eq(L({ layers: LAYERS(900, 3500, 500, 1000, 900, 0), windowSet: false, windowTokens: 200000, replies: 1 }),
    'Session start ≈6.8k tok · 3.4% of 200k', 'an unset window\'s share is still shown when it fits with the unit');
  eq(L({ layers: LAYERS(900, 3500, 500, 1000, 900, 0), windowSet: true, replies: 3 }),
    'Session start ≈6.8k tok · 0.7% of 1M', 'both clauses never fit together (the head + both is ≥ 39)');
  const withH = M.sessionStartLabel(brief({ layers: k227, harness: 500000 }));
  eq(withH, 'Session start ≈22.7k tok · 2.3% of 1M', 'the harness estimate is NEVER added to the figure or the share');
  eq(M.sessionStartLabel(null), null, 'no measurement → no label');
  eq(M.sessionStartLabel({ tokens: 'x' }), null, 'a non-number → no label, never "≈0"');
  // Fuzz: every label within budget, the head always whole.
  let worst = 0; let headKept = true;
  for (let i = 0; i < 400; i++) {
    const t = Math.floor(Math.random() * 1e6);
    const ss = { tokens: t, window: { tokens: [200000, 400000, 1000000, 8000, 10000000][i % 5], set: i % 2 === 0 }, delivery: { replies: 1 + (i % 12) } };
    const s = M.sessionStartLabel(ss);
    worst = Math.max(worst, s.length);
    if (!s.startsWith('Session start ≈' + M.formatTokens(t))) headKept = false;
  }
  ok(worst <= M.BAR_LABEL_CHARS, `400 random readings: the longest label is ${worst} ≤ ${M.BAR_LABEL_CHARS}`);
  ok(headKept, '… and the head — the noun and the measured figure — is never cut');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§6 the model item — the only source, the failure line, no second notice');
{
  const m = build(summary(), { dark: true });
  const s = m.sessionStart;
  ok(s && s.id === 'tray-session-start' && s.project === 'curator' && s.domain === 'projects', 'the item is built for sessionStart\'s own project');
  eq(s.label, 'Session start ≈22.7k tok · 2.3% of 1M', 'its label is sessionStartLabel over the summary\'s sessionStart');
  const kitLines = KIT.bucketText(summary().sessionStart.meter).lines;
  ok(kitLines.length >= 3 && kitLines.every((line) => s.toolTip.includes(line)),
    'the tooltip carries the kit\'s own text alternative, every sentence (the app\'s words)');
  const rest = s.toolTip.split(' · ').filter((part) => !kitLines.some((line) => line.includes(part)));
  eq(rest, ['Session start, projects / curator: ≈22.7k tokens (estimated at four bytes each)'],
    '… and the ONLY other clause is the head: no widget-only fact');
  ok(s.bar && s.bar.kind === 'meter' && s.bar.template === false, 'the bar is the gutter meter');
  let seenDark = null;
  build(summary(), { dark: true, renderMeter: (o) => { seenDark = o.dark; return null; } });
  eq(seenDark, true, 'the menu\'s theme reaches the meter renderer');
  const thrown = build(summary(), { renderMeter: () => { throw new Error('boom'); } });
  ok(thrown.sessionStart && thrown.sessionStart.bar === null && thrown.sessionStart.label, 'a renderer that throws costs the picture, never the line');
  // Unset window: the tooltip says so.
  const unset = build(summary({ sessionStart: brief({ windowSet: false, windowTokens: 200000 }) }));
  ok(/context window not set; 200k is the default/.test(unset.sessionStart.toolTip), 'an unset window is said in the tooltip');
  // null + no warning → no line; the notice list is untouched.
  eq(build(summary({ sessionStart: null })).sessionStart, null, 'sessionStart null and no warning → NO line (nothing was measured, nothing failed)');
  // null + the data layer's warning → one line, and the notice is not repeated.
  const warn = { code: M.WARNING_SESSION_START, message: 'Could not measure what an agent receives at session start for this project.', detail: 'io' };
  const f = build(summary({ sessionStart: null, warnings: [warn] }));
  eq([f.sessionStart.label, f.sessionStart.bar, f.sessionStart.failed], [M.SESSION_START_FAILED, null, true],
    'a failed measurement → "Session start · could not measure", with NO picture');
  eq(f.sessionStart.toolTip, warn.message, '… its tooltip is the data layer\'s own sentence');
  ok(!f.notices.some((n) => n.code === M.WARNING_SESSION_START), '… and the same warning is NOT said again as a notice');
  // The warning's project is off screen → no line, so the notice stays.
  const off = build(summary({ sessionStart: null, warnings: [warn], lastSave: { domain: 'x', project: 'nowhere' } }));
  ok(off.sessionStart === null && off.notices.some((n) => n.code === M.WARNING_SESSION_START),
    'with no group to carry the line, the failure stays a notice — never silently dropped');
  // A sessionStart for a project with no group on screen → no item.
  eq(build(summary({ sessionStart: brief({ project: 'ghost' }) })).sessionStart, null,
    'a measurement for a project with no group on screen → no item (never moved to another project)');
  eq(build(summary({ sessionStart: brief({ domain: 'business', project: 'curator' }) })).sessionStart, null,
    'same project name in ANOTHER domain → no item (matched on domain and project)');
  // The pinned warning code is the real producer's.
  const trayTxt = readFileSync(path.join(ROOT, 'src', 'brain', 'tray-summary.js'), 'utf8');
  ok(trayTxt.includes(`code: '${M.WARNING_SESSION_START}'`), 'the warning code is the one tray-summary.js emits');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§7 the menu template — placement, click, the icon seam');
{
  const calls = [];
  const seen = [];
  const m = build(summary(), { dark: true });
  const flat = MENU.flattenTrayMenu(MENU.buildTrayMenuTemplate(m, {
    ...NOOPS, onOpenScope: (r) => calls.push(r && r.route),
    makeIcon: (sp) => { seen.push(sp); return { fake: 'image', from: sp }; },
  }));
  const ids = flat.map((i) => i.id);
  const item = flat.find((i) => i.id === MENU.ID_SESSION_START);
  ok(item && item.enabled === true && item.icon && item.icon.from === m.sessionStart.bar,
    'the line is ENABLED and carries its meter through makeIcon');
  const g0 = ids.indexOf('tray-group-0');
  eq(m.groups[0].project, 'curator', 'CONTROL — group 0 is the measured project');
  eq([ids[g0 + 1], ids[g0 + 2]], [MENU.ID_DOCUMENTS, MENU.ID_SESSION_START],
    'under the open project\'s header: the documents line, then the session start line, then its scope rows');
  eq(flat.filter((i) => i.id === MENU.ID_SESSION_START).length, 1, '… exactly once');
  item.click();
  eq(calls.pop(), 'projects/curator', 'its click opens Context on that project (step ④ is its app twin)');
  const offscreen = { ...m, groups: m.groups.slice(1) };
  ok(!MENU.flattenTrayMenu(MENU.buildTrayMenuTemplate(offscreen, NOOPS)).some((i) => i.id === MENU.ID_SESSION_START),
    'its group off screen → the line is omitted, never moved');
  const noDocs = build(summary({ projects: [] }), { dark: true });
  const nd = MENU.flattenTrayMenu(MENU.buildTrayMenuTemplate(noDocs, NOOPS)).map((i) => i.id);
  eq(nd[nd.indexOf('tray-group-0') + 1], MENU.ID_SESSION_START, 'with no documents reading, it is the first line under the header');
  const failed = build(summary({ sessionStart: null, warnings: [{ code: M.WARNING_SESSION_START, message: 'Could not measure.' }] }));
  const fi = MENU.flattenTrayMenu(MENU.buildTrayMenuTemplate(failed, { ...NOOPS, makeIcon: (sp) => ({ from: sp }) }))
    .find((i) => i.id === MENU.ID_SESSION_START);
  ok(fi && fi.label === M.SESSION_START_FAILED && !fi.icon, 'the failure line is drawn with no icon');
  const safe = MENU.buildTrayMenuTemplate(m, { ...NOOPS, makeIcon: () => { throw new Error('boom'); } });
  ok(MENU.flattenTrayMenu(safe).some((i) => i.id === MENU.ID_SESSION_START && !i.icon), 'a makeIcon that throws costs the meter, never the line');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§8 width — the menu does not widen');
{
  const sp = BARS.renderGutterMeter({ ...M.meterGutter(brief().meter), dark: false });
  eq([sp.widthPoints, M.BAR_ICON_POINTS], [BARS.BAR_CANVAS_POINTS, BARS.BAR_CANVAS_POINTS],
    'the meter occupies exactly the reserved 28pt bar gutter');
  const item = M.BAR_LABEL_CHARS * M.MENU_CHAR_POINTS + BARS.BAR_CANVAS_POINTS + M.MENU_ICON_GAP_POINTS;
  ok(item <= M.MENU_WIDTH_POINTS - M.MENU_CHROME_POINTS && M.MENU_WIDTH_POINTS === 363.5,
    `a full session-start line (${item}pt) fits the measured title column of the unchanged 363.5pt menu`);
  const long = 'x'.repeat(80);
  const m = build(summary({
    lastSave: { domain: long, project: long }, scopes: [scope(long, long, 5)], projects: [],
    sessionStart: brief({ domain: long, project: long, layers: LAYERS(9999, 32000, 48000, 9000, 9000, 819200 / 4), windowSet: true, windowTokens: 10000000, replies: 11 }),
  }));
  ok(m.sessionStart && m.sessionStart.label.length <= M.BAR_LABEL_CHARS,
    `a long project, a huge start, a 10M window, 11 replies: "${m.sessionStart && m.sessionStart.label}" ≤ ${M.BAR_LABEL_CHARS}`);
  ok(M.SESSION_START_FAILED.length <= M.BAR_LABEL_CHARS, 'the failure words fit too');
}

console.log(`\n${failed ? '✗' : '✓'} test-tray-session-start: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
