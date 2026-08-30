#!/usr/bin/env node
/**
 * OFFLINE guard for the visual harness's own machinery.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * `scripts/visual/` measures the running app in a real browser. That browser
 * is not available in `npm test`, so the browser sweep lives in LIVE_LOCAL.
 * What CAN be pinned offline is the machinery the sweep's verdicts rest on:
 * the WCAG arithmetic, the alpha compositing, the PNG decode used to read
 * real painted pixels, the baseline differ, and the origin guard that keeps a
 * shared browser from letting one agent record another agent's page.
 *
 * THIS REPO HAS BEEN MISLED BY UNCHECKED CONTRAST HELPERS TWICE:
 * one reported 2.34 for an element genuinely at 7.26 (a bare indexOf matched a
 * stylesheet's HEADER COMMENT, so it parsed :root twice); another read a badge
 * at 1.90 by treating a TRANSLUCENT tint as opaque when composited it is
 * 13.81. Both were believed because nothing tested the helper. So every check
 * below has a control that MUST fire, including a control proving the
 * baseline differ is not vacuous.
 *
 * No network, no API key, no server, no browser, no spend.
 */

import zlib from 'zlib';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  relativeLuminance, compositeOver, flattenStack, contrastRatio, round2,
  isLargeText, textFloorFor, parseSimpleCssColor,
  FLOOR_TEXT_AA, FLOOR_LARGE_TEXT,
} from './visual/contrast.js';
import { decodePng, pixelAt } from './visual/png.js';
import { normalize, diffBaseline } from './visual/baseline.js';
import { shellAssetRefs } from './visual/harness.js';
import * as probes from './visual/probes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function near(a, b, eps, label) { ok(Math.abs(a - b) <= eps, `${label} (got ${a}, expected ~${b})`); }
function section(t) { console.log(`\n${t}`); }

const WHITE = [255, 255, 255, 1];
const BLACK = [0, 0, 0, 1];

// ── §1 The two controls the brief names ────────────────────────────────
section('§1 Contrast controls — the two anchors of the whole scale');
ok(contrastRatio(BLACK, WHITE) === 21, 'black on white is EXACTLY 21 (the ceiling of the scale)');
ok(contrastRatio(WHITE, BLACK) === 21, 'the ratio is symmetric — white on black is also exactly 21');
ok(contrastRatio([18, 18, 24, 1], [18, 18, 24, 1]) === 1,
   'an IDENTICAL pair is EXACTLY 1 — a helper that cannot return 1 here is returning something other than contrast');
ok(contrastRatio([124, 90, 245, 1], [124, 90, 245, 1]) === 1, 'identical holds for a saturated colour too, not just neutrals');
ok(contrastRatio(BLACK, BLACK) === 1 && contrastRatio(WHITE, WHITE) === 1, 'identical holds at both ends of the range');

// A control proving the corpus can DISAGREE: if every pair returned 1 the
// assertions above would pass while the helper measured nothing.
ok(contrastRatio([119, 119, 119, 1], WHITE) !== 1, 'CONTROL: a genuinely different pair does NOT return 1 (so §1 is not vacuous)');
near(round2(contrastRatio([119, 119, 119, 1], WHITE)), 4.48, 0.02, 'mid grey #777 on white is the classic 4.48 near-miss');
near(round2(contrastRatio([117, 117, 117, 1], WHITE)), 4.6, 0.03, 'two shades darker clears 4.5 — the helper is sensitive at the floor');

section('§2 Relative luminance');
ok(relativeLuminance(WHITE) === 1, 'white has luminance 1');
ok(relativeLuminance(BLACK) === 0, 'black has luminance 0');
ok(relativeLuminance([0, 255, 0, 1]) > relativeLuminance([255, 0, 0, 1]),
   'green weighs more than red (0.7152 vs 0.2126) — the coefficients are not swapped');
ok(relativeLuminance([0, 0, 255, 1]) < relativeLuminance([255, 0, 0, 1]), 'blue weighs least');
ok(relativeLuminance([10, 10, 10, 1]) > 0 && relativeLuminance([10, 10, 10, 1]) < 0.005,
   'the linear segment below the 0.04045 threshold is applied (a very dark grey is not clamped to 0)');

// ── §3 Compositing — the defect class that produced 1.90 for a 13.81 element
section('§3 Alpha compositing — the step whose ABSENCE inverts verdicts');
ok(JSON.stringify(compositeOver([12, 34, 56, 1], WHITE)) === JSON.stringify([12, 34, 56, 1]),
   'an opaque foreground passes through unchanged');
{
  const r = compositeOver([255, 255, 255, 0], [10, 20, 30, 1]);
  ok(r[0] === 10 && r[1] === 20 && r[2] === 30, 'a fully transparent foreground leaves the backdrop exactly');
}
{
  const r = compositeOver(WHITE.slice(0, 3).concat([0.5]), BLACK);
  ok(r[0] === 127.5 && r[3] === 1, '50% white over black is 127.5 and the result is opaque');
}
{
  // THE CONTROL THAT MATTERS. A tint at the alpha this app actually uses.
  // Naive (tint read as opaque) vs composited must not merely differ — they
  // must give OPPOSITE VERDICTS, or this check would not have caught the bug
  // it exists for.
  const tint = [255, 180, 60, 0.08];
  const surface = [20, 20, 28, 1];
  const naive = contrastRatio(tint, surface);
  const real = contrastRatio(compositeOver(tint, surface), surface);
  ok(naive >= FLOOR_TEXT_AA, `CONTROL: read as OPAQUE the tint reports ${round2(naive)} — a comfortable pass`);
  ok(real < FLOOR_TEXT_AA, `CONTROL: composited it is ${round2(real)} — a FAIL. The two disagree about the verdict, not just the digits`);
  ok(naive / real > 5, 'CONTROL: the gap is a factor of >5x, not a rounding difference');
}
{
  const stack = flattenStack([[255, 255, 255, 0.5], [255, 255, 255, 0.5]], BLACK);
  near(stack[0], 191.25, 0.01, 'flattenStack composites front-most LAST (two 50% whites over black = 191.25, not 127.5)');
}

section('§4 WCAG floors and the large-text exemption');
ok(FLOOR_TEXT_AA === 4.5 && FLOOR_LARGE_TEXT === 3, 'the two floors are 4.5 and 3');
ok(isLargeText(24, 400) === true, '24px at normal weight is large text');
ok(isLargeText(23.9, 400) === false, '23.9px at normal weight is NOT large text');
ok(isLargeText(18.66, 700) === true, '18.66px BOLD is large text');
ok(isLargeText(18.66, 400) === false, '18.66px at normal weight is not — weight is part of the rule');
ok(textFloorFor(14, 400) === 4.5 && textFloorFor(27, 400) === 3, 'the floor follows from size and weight, not from a constant');

section('§5 Fallback colour parser (tests and token reading only)');
ok(JSON.stringify(parseSimpleCssColor('#fff')) === JSON.stringify([255, 255, 255, 1]), '#fff expands to white');
ok(JSON.stringify(parseSimpleCssColor('#7C5AF5')) === JSON.stringify([124, 90, 245, 1]), 'six-digit hex, case-insensitive');
ok(parseSimpleCssColor('#80808080')[3] === 128 / 255, 'eight-digit hex carries alpha');
ok(JSON.stringify(parseSimpleCssColor('rgba(124,90,245,0.14)')) === JSON.stringify([124, 90, 245, 0.14]), 'rgba() with commas');
ok(JSON.stringify(parseSimpleCssColor('rgb(1 2 3 / 0.5)')) === JSON.stringify([1, 2, 3, 0.5]), 'rgb() space syntax with a slash alpha');
ok(parseSimpleCssColor('transparent')[3] === 0, 'the transparent keyword is alpha 0');
ok(parseSimpleCssColor('oklch(0.5 0.1 200)') === null,
   'an unsupported form returns NULL rather than guessing — a wrong colour is a confident wrong verdict, null is loud');
ok(parseSimpleCssColor('rebeccapurple') === null, 'a named colour returns null (the measurement path uses the browser instead)');
ok(parseSimpleCssColor(undefined) === null && parseSimpleCssColor(42) === null, 'non-strings return null rather than throwing');

// ── §6 PNG decoder — the ground-truth path ─────────────────────────────
section('§6 PNG decode — how the harness reads REAL painted pixels');
function makePng(width, height, rgbRows, filterType = 0) {
  const chunks = [];
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(0);        // decoder ignores CRC
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8-bit RGB
  chunks.push(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  chunks.push(chunk('IHDR', ihdr));
  const raw = [];
  let prev = Buffer.alloc(width * 3);
  for (const row of rgbRows) {
    const cur = Buffer.from(row);
    const filtered = Buffer.alloc(width * 3);
    for (let i = 0; i < cur.length; i++) {
      filtered[i] = filterType === 2 ? (cur[i] - prev[i]) & 0xff : cur[i];
    }
    raw.push(Buffer.concat([Buffer.from([filterType]), filtered]));
    prev = cur;
  }
  chunks.push(chunk('IDAT', zlib.deflateSync(Buffer.concat(raw))));
  chunks.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(chunks);
}
{
  const img = decodePng(makePng(1, 1, [[51, 102, 204]]));
  ok(img.width === 1 && img.height === 1 && img.channels === 3, 'a 1x1 RGB PNG decodes to 1x1x3');
  ok(JSON.stringify(pixelAt(img, 0, 0)) === JSON.stringify([51, 102, 204, 1]), 'the pixel round-trips EXACTLY (no drift in the decode path)');
}
{
  // Filter type 2 (Up) exercises the un-filtering arithmetic. With filter 0
  // the decoder could ignore filtering entirely and still pass, so this is
  // the control that the un-filter is real.
  const rows = [[10, 20, 30, 40, 50, 60], [200, 100, 5, 9, 250, 1]];
  const img = decodePng(makePng(2, 2, rows, 2));
  ok(JSON.stringify(pixelAt(img, 0, 0)) === JSON.stringify([10, 20, 30, 1]), 'CONTROL: filter type 2 (Up) row 0 decodes correctly');
  ok(JSON.stringify(pixelAt(img, 1, 1)) === JSON.stringify([9, 250, 1, 1]), 'CONTROL: filter type 2 row 1 needs real un-filtering — it decodes correctly');
}
{
  let threw = false;
  try { decodePng(Buffer.from('not a png at all')); } catch { threw = true; }
  ok(threw, 'CONTROL: a non-PNG buffer THROWS rather than returning plausible garbage');
}
{
  let threw = false;
  try { decodePng(makePng(1, 1, [[1, 2, 3]], 9)); } catch { threw = true; }
  ok(threw, 'CONTROL: an unknown filter byte throws — the decoder refuses to invent pixels');
}

// ── §7 Origin guard — EXECUTED, not source-scanned ─────────────────────
section('§7 Origin guard — the shared-browser protection, executed');
/**
 * The probes reference bare `location`/`document`/`window` globals because
 * they are stringified into the page. That makes them runnable here in a
 * sandbox with those globals faked — so this section EXECUTES the guard
 * rather than grepping for it. A comment mentioning `location.port` would
 * satisfy a source scan; it cannot satisfy this.
 */
function runProbe(fn, fakeLocation, fakeWindow = { innerWidth: 1280, innerHeight: 860 }, ...args) {
  const factory = new Function('location', 'window', 'document', `return (${fn.toString()});`);
  return factory(fakeLocation, fakeWindow, { querySelectorAll: () => [], querySelector: () => null, documentElement: { getAttribute: () => null, setAttribute: () => null } })(...args);
}
const GUARDED = [
  ['collectReport', probes.collectReport, ['x', 400]],
  ['measureFontSizes', probes.measureFontSizes, []],
  ['setFontScale', probes.setFontScale, [1]],
  ['setTheme', probes.setTheme, ['dark']],
  ['gotoView', probes.gotoView, ['chat']],
  ['railViews', probes.railViews, []],
  ['backdropSamples', probes.backdropSamples, [4]],
  // The info-panel probes (LIVE_LOCAL test-info-panel-reachability.js). They
  // measure geometry and run elementFromPoint, so a reading taken against
  // another agent's tab would be silently wrong rather than absent — exactly
  // what the guard exists for. Listed here so the guard is EXECUTED offline
  // even on a machine with no browser, where the suite that uses them skips.
  ['infoPanelSurvey', probes.infoPanelSurvey, []],
  ['markGeometry', probes.markGeometry, ['some-btn']],
  ['mutateForControl', probes.mutateForControl, ['dup-id']],
];
for (const [name, fn, extra] of GUARDED) {
  let threw = false, msg = '';
  try { runProbe(fn, { port: '3333' }, undefined, '54321', ...extra); }
  catch (e) { threw = true; msg = String(e.message); }
  ok(threw && /origin guard/.test(msg),
     `${name}() REFUSES to measure when location.port is not the expected port (this is what stops one agent recording another agent's app on :3333)`);
}
{
  // CONTROL: the guard must pass on a MATCHING port, or every assertion above
  // would be satisfied by a function that simply always throws.
  let threw = false;
  try { runProbe(probes.railViews, { port: '54321' }, undefined, '54321'); } catch { threw = true; }
  ok(!threw, 'CONTROL: with a MATCHING port the guard does NOT throw — §7 is not just "everything throws"');
}
{
  let threw = false, msg = '';
  try { runProbe(probes.measureFontSizes, { port: '54321' }, { innerWidth: 0, innerHeight: 0 }, '54321'); }
  catch (e) { threw = true; msg = String(e.message); }
  ok(threw && /origin guard/.test(msg),
     'a ZERO-WIDTH viewport is refused too — geometry and elementFromPoint are meaningless in a hidden or unsized tab');
}

// ── §8 Baseline differ ─────────────────────────────────────────────────
section('§8 Baseline differ — including a control that it is not vacuous');
function fakeReport(mut = (r) => r) {
  const r = {
    boot: { booted: true },
    assets: [
      { ref: '/next/shell.css', status: 200, ctype: 'text/css; charset=UTF-8', ok: true, servedAsShell: false },
      { ref: '/next/app.js', status: 200, ctype: 'application/javascript', ok: true, servedAsShell: false },
    ],
    fontScaleFrozen: { frozen: [{ key: 'button.settings-nav-row', px: 13.33 }] },
    views: {
      'chat|dark': {
        geometry: { horizontalOverflow: false },
        stylesheets: [{ href: '/next/shell.css', inCssom: true, rules: 40 }],
        controls: [{ key: 'button#a', state: 'reachable' }, { key: 'button#b', state: 'reachable' }],
        contrast: [
          { key: 'div.x', fontSize: 12, ratio: 8.55, floor: 4.5, pass: true },
          { key: 'div.y', fontSize: 12, ratio: 4.27, floor: 4.5, pass: false },
        ],
        typography: { 'div|14|400': 3 },
        consoleErrors: [],
      },
    },
  };
  return mut(JSON.parse(JSON.stringify(r)));
}
const base = normalize(fakeReport());
{
  const d = diffBaseline(fakeReport(), base);
  ok(d.regressions.length === 0 && d.improvements.length === 0 && d.changes.length === 0,
     'an unchanged report diffs to nothing at all');
}
{
  const d = diffBaseline(fakeReport(r => { r.views['chat|dark'].controls[0] = { key: 'button#a', state: 'occluded', occludedBy: 'div.overlay' }; return r; }), base);
  ok(d.regressions.some(x => /covered at its own centre/.test(x)), 'CONTROL: a newly occluded control is a REGRESSION');
}
{
  const d = diffBaseline(fakeReport(r => { r.views['chat|dark'].contrast[0].pass = false; return r; }), base);
  ok(d.regressions.some(x => /new contrast failure/.test(x)), 'CONTROL: a newly failing contrast pair is a REGRESSION');
}
{
  const d = diffBaseline(fakeReport(r => { r.views['chat|dark'].contrast[1].pass = true; return r; }), base);
  ok(d.improvements.some(x => /contrast failure gone/.test(x)) && d.regressions.length === 0,
     'a FIXED contrast failure is an improvement, not a regression — the ratchet only tightens');
}
{
  const d = diffBaseline(fakeReport(r => { r.assets[0].ctype = 'text/html; charset=UTF-8'; r.assets[0].ok = false; r.assets[0].servedAsShell = true; return r; }), base);
  ok(d.regressions.some(x => /asset broke/.test(x)), 'CONTROL: a stylesheet answered by the SPA shell instead of text/css is a REGRESSION');
}
{
  const d = diffBaseline(fakeReport(r => { r.views['chat|dark'].stylesheets[0].rules = 0; return r; }), base);
  ok(d.regressions.some(x => /applies no rules/.test(x)),
     'CONTROL: a stylesheet that is LINKED but applies nothing is a REGRESSION (the styled-but-unloaded shape)');
}
{
  const d = diffBaseline(fakeReport(r => { r.fontScaleFrozen.frozen.push({ key: 'input.foo', px: 13.33 }); return r; }), base);
  ok(d.regressions.some(x => /newly frozen/.test(x)), 'CONTROL: a newly font-scale-frozen element is a REGRESSION');
}
{
  const d = diffBaseline(fakeReport(r => { r.fontScaleFrozen.frozen = []; return r; }), base);
  ok(d.improvements.length === 1 && d.regressions.length === 0,
     'the KNOWN-frozen element is ratcheted, not asserted absent — fixing it reads as an improvement');
}
{
  const d = diffBaseline(fakeReport(r => { r.views['chat|dark'].consoleErrors = ['TypeError: x is not a function']; return r; }), base);
  ok(d.regressions.some(x => /new console error/.test(x)), 'CONTROL: a new console error is a REGRESSION');
}
{
  const d = diffBaseline(fakeReport(r => { r.boot.booted = false; return r; }), base);
  ok(d.regressions.some(x => /BOOT/.test(x)), 'CONTROL: the shell failing to boot is a REGRESSION');
}

section('§9 Shell asset enumeration');
{
  const refs = shellAssetRefs();
  ok(refs.length >= 15, `index.html yields ${refs.length} same-origin asset references`);
  ok(refs.every(r => !/^https?:/i.test(r) && !r.startsWith('data:')), 'external and data: URLs are excluded (we only check what we serve)');
  ok(refs.includes('/next/shell.css') && refs.includes('/next/app.js'), 'the two load-bearing refs are among them');
  const html = readFileSync(path.join(__dirname, '..', 'src', 'public', 'next', 'index.html'), 'utf8');
  ok(refs.filter(r => r.endsWith('.css')).length === new Set(html.match(/href="([^"]+\.css)"/g) || []).size,
     'every .css href in index.html is enumerated — the extractor is not silently dropping any');
}

console.log(`\nPassed: ${passed}   Failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
