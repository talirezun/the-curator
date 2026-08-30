#!/usr/bin/env node
/**
 * CLI for the visual harness.
 *
 *   node scripts/visual/run.js                 measure + diff against the baseline
 *   node scripts/visual/run.js --record        (re)record the baseline
 *   node scripts/visual/run.js --json out.json dump the full raw report
 *   node scripts/visual/run.js --views chat,domains --themes dark
 *   node scripts/visual/run.js --with-onboarding   measure the first-run panel docked
 *
 * EXIT CODES: 0 pass or skip · 1 regression / hard failure.
 * SELF-SKIP: exit 0 with a printed reason when no browser is installed — the
 * same contract a live suite uses for a missing API key.
 */

import { writeFileSync } from 'fs';
import { runSweep } from './harness.js';
import { readBaseline, writeBaseline, diffBaseline, baselineFor } from './baseline.js';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const record = has('--record');
const jsonOut = val('--json');
const views = val('--views') ? val('--views').split(',').map(s => s.trim()) : null;
const themes = val('--themes') ? val('--themes').split(',').map(s => s.trim()) : undefined;
const withOnboarding = has('--with-onboarding');
// An explicit --baseline always wins; otherwise the file follows the MODE, so
// the first-run panel is never diffed against the steady-state screen.
const baselineFile = val('--baseline', baselineFor({ withOnboarding }));

const log = (s) => console.log(s);
console.log('── Curator visual harness ──────────────────────────────────');

let report;
try {
  report = await runSweep({ views, themes, withOnboarding, log });
} catch (err) {
  console.error(`\n✗ harness error: ${err.message}`);
  process.exit(1);
}

if (report.skipped) {
  console.log(`\n⊘ SKIPPED — ${report.reason}`);
  console.log('  looked for:');
  for (const c of report.searched) console.log(`    ${c}`);
  console.log('\n  This is a skip, not a pass: nothing was measured.');
  process.exit(0);
}

if (jsonOut) { writeFileSync(jsonOut, JSON.stringify(report, null, 2)); console.log(`\nfull report -> ${jsonOut}`); }

// ── Hard failures: things no baseline may ever excuse ──────────────────
const hard = [];
if (!report.assetDetectorControl.fires) {
  hard.push('POSITIVE CONTROL FAILED: a request for a missing .css did not come back as the SPA shell. ' +
            '`servedAsShell` has stopped meaning "asset missing", so the asset check is now decorative.');
}
for (const a of report.assets) {
  if (a.servedAsShell) hard.push(`asset MISSING (SPA shell answered ${a.status} ${a.ctype}): ${a.ref}`);
  else if (!a.ok) hard.push(`asset bad (${a.status} ${a.ctype}${a.error ? ' ' + a.error : ''}): ${a.ref}`);
}
if (!report.boot?.booted) hard.push('the shell never set window.__curatorBooted — it did not boot');
const bm = report.backdropModelCheck;
if (bm && bm.total > 0 && bm.agreed < bm.total) {
  for (const s of bm.samples.filter(x => !x.agrees)) {
    hard.push(`contrast model disagrees with PAINT at ${s.key} ${JSON.stringify(s.point)}: ` +
              `modelled ${s.modelled} vs painted ${s.painted} (delta ${s.diff}) — contrast numbers here are not trustworthy`);
  }
}
if (bm && bm.total === 0) console.log('\n! backdrop model check found no eligible sample points (model UNVALIDATED this run)');

// ── Summary ────────────────────────────────────────────────────────────
console.log('\n── summary ─────────────────────────────────────────────────');
console.log(`assets checked over HTTP : ${report.assets.length} (${report.assets.filter(a => a.ok).length} ok)`);
console.log(`missing-asset control    : ${report.assetDetectorControl.fires ? 'FIRES' : 'DID NOT FIRE'} ` +
            `(${report.assetDetectorControl.status} ${report.assetDetectorControl.ctype})`);
console.log(`backdrop model vs paint  : ${bm ? `${bm.agreed}/${bm.total} agree within ${bm.tolerance}/channel` : 'n/a'}`);
console.log(`views x themes measured  : ${Object.keys(report.views).length}`);
const fz = report.fontScaleFrozen;
if (fz) console.log(`font-scale response      : ${fz.moved}/${fz.measured} moved, ${fz.frozen.length} FROZEN across ${fz.views?.length ?? 1} view(s)`);

let totalOccluded = 0, totalContrastFail = 0, totalDead = 0;
for (const [k, v] of Object.entries(report.views)) {
  const occ = v.controls.filter(c => c.state === 'occluded');
  const cf = v.contrast.filter(c => !c.pass);
  const dead = v.stylesheets.filter(s => !s.inCssom || s.rules === 0);
  const pen = v.controls.filter(c => c.state === 'pointer-events-none');
  if (pen.length) {
    console.log(`\n  ${k}: ${pen.length} control(s) look enabled but have pointer-events:none`);
    for (const p of pen.slice(0, 6)) console.log(`    ${p.key} "${p.label}"`);
  }
  totalOccluded += occ.length; totalContrastFail += cf.length; totalDead += dead.length;
  if (occ.length) {
    console.log(`\n  ${k}: ${occ.length} control(s) covered at their own centre`);
    for (const o of occ.slice(0, 6)) console.log(`    ${o.key} "${o.label}" <- ${o.occludedBy} (layer ${o.occluderLayer}, z ${o.occluderZ})`);
  }
  if (dead.length) console.log(`\n  ${k}: stylesheet(s) linked but applying nothing: ${dead.map(d => d.href).join(', ')}`);
}
console.log(`\ncontrast failures        : ${totalContrastFail} across all views/themes`);
console.log(`occluded controls        : ${totalOccluded}`);
console.log(`dead stylesheets         : ${totalDead}`);

if (fz && fz.frozen.length) {
  console.log('\nfrozen against --font-scale (these ignore the app text-size setting):');
  const seen = new Set();
  for (const f of fz.frozen) { const id = `${f.view}:${f.key}`; if (seen.has(id)) continue; seen.add(id); if (seen.size <= 14) console.log(`    ${String(f.view).padEnd(9)} ${f.key} @ ${f.px}px`); }
  if (seen.size > 14) console.log(`    …and ${seen.size - 14} more distinct`);
}

// ── Baseline ───────────────────────────────────────────────────────────
let exitCode = 0;
if (hard.length) {
  console.log('\n── HARD FAILURES ───────────────────────────────────────────');
  for (const h of hard) console.log(`  ✗ ${h}`);
  exitCode = 1;
}

if (record) {
  const f = writeBaseline(report, baselineFile);
  console.log(`\n✓ baseline recorded -> ${f}`);
  console.log('  Read it before committing it. A baseline records what IS, including');
  console.log('  defects; recording one is asserting "this is the state I accept".');
} else {
  const base = readBaseline(baselineFile);
  if (!base) {
    console.log(`\n! no baseline at ${baselineFile} — nothing to diff against.`);
    console.log('  Run with --record once you have read the summary above.');
  } else {
    const { regressions, improvements, changes } = diffBaseline(report, base);
    console.log('\n── baseline diff ───────────────────────────────────────────');
    if (!regressions.length && !improvements.length && !changes.length) console.log('  no change');
    for (const r of regressions) console.log(`  ✗ REGRESSION  ${r}`);
    for (const i of improvements) console.log(`  ✓ improvement ${i}`);
    for (const c of changes.slice(0, 40)) console.log(`  · change      ${c}`);
    if (changes.length > 40) console.log(`  · …and ${changes.length - 40} more changes`);
    if (regressions.length) exitCode = 1;
  }
}

console.log(exitCode === 0 ? '\nPassed.' : '\nFAILED.');
process.exit(exitCode);
