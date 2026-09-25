/**
 * test-tray-session-start.js — OFFLINE guard: the menubar widget NO LONGER
 * carries a Session start line (v3.74.0, Layout A).
 *
 * ── WHAT CHANGED ────────────────────────────────────────────────────────────
 *
 * v3.70.0 put "Session start ≈N tok · X% of 1M" and a two-lane window meter
 * in the open project's group. The v3.74.0 redesign removed it from the MENU
 * on the maintainer's decision: it is a planning reading about the context
 * CONFIGURATION (its window is a Context-view setting, not the harness that
 * ran), its home is the app's Context step ④ — which keeps it, so the parity
 * rule is untouched — and it cost a full `get_project_context` run on every
 * tray refresh (main.js now asks for `sessionStart: false`).
 *
 * The widget-side copies of the kit (`formatTokens`, `bucketModel`,
 * `bucketText`), the label's cutting order and `menu-bars.js`'s
 * `renderGutterMeter` went with the line; the sections that pinned them were
 * deleted with it rather than left asserting code nothing calls.
 *
 * ── WHAT IS STILL ASSERTED ──────────────────────────────────────────────────
 *   §0  imports, with a positive control
 *   §1  a summary that CARRIES a measurement draws no Session start line, no
 *       meter, and none of the kit's words — the removal is behavioural,
 *       proven against a measurement built by the REAL `sessionStartBrief`
 *   §2  the data layer's `session-start-unavailable` warning is not re-said
 *       as a notice (the menu shows no reading it could be about), while any
 *       other warning still is — and the code is the one tray-summary.js emits
 *
 * The data half of this file is the fixture: the REAL `sessionStartBrief`
 * builds the measurement, so the test is about the shape the store emits.
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
// ═══════════════════════════════════════════════════════════════════════════
{
  ok(typeof SS.sessionStartBrief === 'function' && typeof M.buildTrayModel === 'function'
    && typeof MENU.buildTrayMenuTemplate === 'function', 'the data layer\'s brief and the widget\'s model and menu load');
  const b = brief();
  ok(b && typeof b.tokens === 'number' && b.tokens > 0 && b.meter && KIT.bucketText(b.meter).lines.length >= 3,
    'CONTROL — the fixture IS a real measurement: tokens, a meter, and the kit\'s own words for it');
  const m = build(summary());
  ok(m.rows.some((r) => r.project === 'curator'), 'CONTROL — the measured project IS on the menu, so an absent line is a decision, not a missing row');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§1 a supplied measurement draws NO line, NO meter, NONE of its words');
// ═══════════════════════════════════════════════════════════════════════════
{
  const s = summary();
  const m = build(s, { dark: true });
  ok(!Object.prototype.hasOwnProperty.call(m, 'sessionStart'), 'the model has no sessionStart field at all');
  const flat = MENU.flattenTrayMenu(MENU.buildTrayMenuTemplate(m, { ...NOOPS, makeIcon: (sp) => sp }));
  ok(!flat.some((i) => typeof i.label === 'string' && /^Session start/.test(i.label)),
    'no menu item, at any depth, is a "Session start" line');
  ok(!flat.some((i) => i.icon && i.icon.kind === 'meter'), 'no item carries a meter picture');
  const kitLines = KIT.bucketText(s.sessionStart.meter).lines;
  const everyWord = flat.map((i) => [i.label, i.sublabel, i.toolTip].filter(Boolean).join('\n')).join('\n');
  ok(kitLines.every((line) => !everyWord.includes(line)), 'none of the kit\'s text alternative reaches any label, sublabel or tooltip');
  ok(!everyWord.includes('≈' + '22.7k'), 'and the token figure itself is nowhere in the menu');
  ok(BARS.renderGutterMeter === undefined, 'menu-bars.js no longer exports a meter renderer nothing would call');
  eq(Object.keys(M).filter((k) => /sessionStart|meter/i.test(k)), [], 'tray-model.js exports nothing about the session start or its meter');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2 the failure warning is not a notice; other warnings still are');
// ═══════════════════════════════════════════════════════════════════════════
{
  const warn = { code: 'session-start-unavailable', message: 'Could not measure what an agent receives at session start for this project.', detail: 'io' };
  const other = { code: 'something-else', message: 'A different warning the menu must still say.' };
  const f = build(summary({ sessionStart: null, warnings: [warn, other] }));
  ok(!f.notices.some((n) => n.code === warn.code || (n.full || n.text) === warn.message),
    'the session-start failure is not re-said as a notice — the menu shows no reading it is about');
  ok(f.notices.some((n) => (n.full || n.text) === other.message), 'CONTROL — a different supplied warning in the same list IS a notice');
  eq(M.WARNING_SESSION_START, warn.code, 'the silenced code is named in the model, not matched by prose');
  // The pinned warning code is the real producer's (the data half).
  const trayTxt = readFileSync(path.join(ROOT, 'src', 'brain', 'tray-summary.js'), 'utf8');
  ok(trayTxt.includes(`code: '${M.WARNING_SESSION_START}'`), 'the warning code is the one tray-summary.js emits');
}

console.log(`\n${failed ? '✗' : '✓'} test-tray-session-start: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
