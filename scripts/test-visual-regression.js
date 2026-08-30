#!/usr/bin/env node
/**
 * LIVE_LOCAL — the browser sweep. $0, no API key, no network beyond localhost.
 *
 * IT IS NOT IN `npm test` AND MUST NOT BE. It launches a real browser and
 * takes ~40s; the offline suite has to stay fast and deterministic for
 * everyone. What is pinned offline lives in `test-visual-contrast-math.js`.
 *
 * SELF-SKIP CONTRACT: with no Chromium-family browser installed this prints a
 * `⊘` line and NO assertion tally, and exits 0 — the same shape a live suite
 * uses for a missing API key, so `npm run test:live` on a bare machine is
 * harmless. A skip is not a pass, and the output says so.
 *
 * WHAT MAKES THIS DIFFERENT FROM EVERY OTHER SUITE IN THIS REPO
 * Each of them says in its own header that it does not measure rendering,
 * layout or contrast. This one does, in a browser, against the running app.
 * Read scripts/visual/README.md for the ENFORCED / NOT ENFORCED contract
 * before treating a green run as evidence.
 */

import { runSweep } from './visual/harness.js';
import { readBaseline, diffBaseline, DEFAULT_BASELINE } from './visual/baseline.js';

let passed = 0, failed = 0;
const ok = (c, label) => { if (c) { passed++; console.log(`  ✓ ${label}`); } else { failed++; console.log(`  ✗ ${label}`); } };

console.log('Visual regression sweep (real browser, real server, isolated tempdirs)\n');

let report;
try {
  report = await runSweep({ log: (s) => console.log(s) });
} catch (err) {
  console.log(`  ✗ harness error: ${err.message}`);
  console.log(`\nPassed: 0   Failed: 1`);
  process.exit(1);
}

if (report.skipped) {
  console.log(`\n⊘ SKIPPED — ${report.reason}`);
  console.log('  Nothing was measured. This is a skip, not a pass.');
  process.exit(0);
}

// ── §1 The detector controls come FIRST ────────────────────────────────
// A clean sweep means nothing until the detectors have been shown to fire.
console.log('\n§1 Detector controls — each defect planted in the live app, then removed');
for (const c of report.detectorControls || []) {
  ok(c.fired, `${c.name} detector FIRES on a planted defect — ${c.detail}`);
  ok(c.restored, `${c.name} control left the app in its prior state (a control that damages the page poisons every later reading)`);
}
ok((report.detectorControls || []).length === 4, 'all four in-browser detector controls ran');
ok(report.assetDetectorControl.fires,
   `missing-asset control FIRES — a request for a nonexistent .css comes back ${report.assetDetectorControl.status} ` +
   `${report.assetDetectorControl.ctype}, so "served as the SPA shell" still means "asset missing"`);

// ── §2 Contrast model validated against real paint ─────────────────────
console.log('\n§2 The contrast model is checked against pixels Chrome actually painted');
const bm = report.backdropModelCheck;
ok(bm && bm.total > 0, `${bm?.total ?? 0} sample point(s) eligible out of ${bm?.elementsConsidered ?? 0} candidate elements`);
ok(bm && bm.agreed === bm.total,
   `composited-backdrop model agrees with PAINT at ${bm?.agreed}/${bm?.total} points within ${bm?.tolerance}/channel`);
for (const s of (bm?.samples || []).filter(x => !x.agrees)) {
  console.log(`      ${s.key} ${JSON.stringify(s.point)}: modelled ${s.modelled} vs painted ${s.painted} (delta ${s.diff})`);
}

// ── §3 Reachability over HTTP ──────────────────────────────────────────
console.log('\n§3 Every shell asset, fetched over HTTP with its content-type checked');
const missing = report.assets.filter(a => a.servedAsShell);
const bad = report.assets.filter(a => !a.ok && !a.servedAsShell);
ok(missing.length === 0,
   `no asset was answered by the SPA catch-all${missing.length ? ': ' + missing.map(a => a.ref).join(', ') : ''} ` +
   `(a missing asset returns 200 text/html here, never a 404 — the status code alone proves nothing)`);
ok(bad.length === 0, `every asset returned 200 with the right content-type${bad.length ? ': ' + bad.map(a => `${a.ref} -> ${a.status} ${a.ctype}`).join(', ') : ''}`);
ok(report.boot.booted, 'the shell booted (window.__curatorBooted is set)');
ok((report.boot.consoleErrors || []).length === 0,
   `no console error during boot${report.boot.consoleErrors?.length ? ': ' + report.boot.consoleErrors.join(' | ') : ''}`);

// ── §4 Per view/theme ──────────────────────────────────────────────────
console.log('\n§4 Every view, in both themes');
let dead = 0, occ = 0, pen = 0, cerr = 0;
for (const [k, v] of Object.entries(report.views)) {
  dead += v.stylesheets.filter(s => !s.inCssom || s.rules === 0).length;
  occ += v.controls.filter(c => c.state === 'occluded').length;
  pen += v.controls.filter(c => c.state === 'pointer-events-none').length;
  cerr += (v.consoleErrors || []).length;
  // NOT `v.guard.port === v.guard.port` — an assertion that compares a value
  // to itself passes forever and proves nothing, which is the exact defect
  // class this repo keeps finding. Compare against the port WE started.
  ok(v.guard.port === report.meta.serverPort,
     `${k}: recorded from OUR server (:${v.guard.port}), not another agent's browser tab`);
}
ok(dead === 0, `no stylesheet is linked-but-inert in any view/theme (${dead} found)`);
ok(occ === 0, `no interactive control is covered at its own centre (${occ} found)`);
ok(pen === 0, `no enabled-looking control has pointer-events:none (${pen} found)`);
ok(cerr === 0, `no console errors across ${Object.keys(report.views).length} view/theme combinations (${cerr} found)`);

// ── §5 Baseline ratchet ────────────────────────────────────────────────
console.log('\n§5 Baseline ratchet — known-unfixed defects are pinned, and cannot grow');
const base = readBaseline();
if (!base) {
  console.log(`  ! no baseline at ${DEFAULT_BASELINE}; run: node scripts/visual/run.js --record`);
  failed++;
  console.log('  ✗ a baseline is required — without one this suite cannot tell a regression from the status quo');
} else {
  const { regressions, improvements, changes } = diffBaseline(report, base);
  for (const r of regressions) console.log(`      REGRESSION: ${r}`);
  ok(regressions.length === 0, `no regression against the recorded baseline (${regressions.length} found)`);
  if (improvements.length) {
    console.log(`  · ${improvements.length} improvement(s) — re-record the baseline to lock them in:`);
    for (const i of improvements.slice(0, 10)) console.log(`      ${i}`);
  }
  if (changes.length) console.log(`  · ${changes.length} non-verdict change(s) (counts moved); run scripts/visual/run.js to read them`);
}

console.log(`\nPassed: ${passed}   Failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
