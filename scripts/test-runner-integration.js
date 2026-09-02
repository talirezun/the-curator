#!/usr/bin/env node
/**
 * v3.0.1-beta.26 — integration test for the live-suite flake ORCHESTRATION in
 * scripts/run-tests.js (retry → inconclusive/fail → exit code).
 *
 * Offline + free: drives the REAL aggregator via the RUN_TESTS_LIVE_ONLY test
 * seam, pointed at tiny deterministic fake suites in scripts/test-fixtures/.
 * No network, no API keys — the fakes just print + exit. This complements
 * test-ci-flake.js (which unit-tests the pure helpers) by exercising the actual
 * loop, retry spawn, exit code, and summary accounting.
 *
 * Run:  node scripts/test-runner-integration.js
 * Exit: 0 if all green; non-zero on any failure.
 */

import { spawnSync } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RUNNER = path.join(__dirname, 'run-tests.js');

let passed = 0, failed = 0;
const failures = [];
function ok(cond, label) {
  cond ? (passed++, console.log(`  ✓ ${label}`)) : (failed++, failures.push(label), console.log(`  ✗ ${label}`));
}
function section(t) { console.log(`\n${t}`); }

function runAggregator(liveOnly, extraEnv = {}) {
  const res = spawnSync(process.execPath, [RUNNER, '--live'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, RUN_TESTS_LIVE_ONLY: liveOnly, ...extraEnv },
  });
  return { code: res.status, out: (res.stdout || '') + (res.stderr || '') };
}

// ── 1. Transient provider error on first attempt → INCONCLUSIVE, no retry ───────
section('1. Transient (HTTP 503) on first attempt → inconclusive, retry skipped, exit 0');
{
  const r = runAggregator('test-fixtures/runner-transient.js');
  ok(r.code === 0, `exit code is 0 (got ${r.code}) — provider outage does NOT fail the build`);
  ok(/inconclusive/i.test(r.out), 'output reports "inconclusive"');
  ok(/flake/i.test(r.out), 'suite is labelled as a flake, not a pass');
  ok(/skipping retry/i.test(r.out), 'the slow retry is skipped when the first attempt is already a provider storm');
  ok(!/retrying once/i.test(r.out), 'no full retry was performed for a transient first failure');
  ok(!/FAILED suites/.test(r.out), 'not listed under FAILED suites');
}

// ── 2. Genuine reproducible defect (no transient marker) → FAIL ─────────────────
section('2. Real defect (no transient marker) → exit 1, FAIL');
{
  const r = runAggregator('test-fixtures/runner-realfail.js');
  ok(r.code === 1, `exit code is 1 (got ${r.code}) — a real defect still fails the build`);
  ok(/FAILED suites/.test(r.out), 'output lists FAILED suites');
  ok(!/inconclusive/i.test(r.out), 'a real defect is NOT excused as inconclusive');
}

// ── 3. Intermittent failure that recovers on retry → PASS ───────────────────────
section('3. Fails once then passes on retry → exit 0, pass');
{
  const marker = path.join(os.tmpdir(), `curator-runner-recover-${process.pid}-${Date.now()}`);
  try { fs.rmSync(marker, { force: true }); } catch {}
  const r = runAggregator('test-fixtures/runner-recover.js', { RECOVER_MARKER: marker });
  ok(r.code === 0, `exit code is 0 (got ${r.code}) — intermittent flake recovered`);
  ok(/retrying once/i.test(r.out), 'a retry WAS attempted (non-transient first failure)');
  ok(!/inconclusive/i.test(r.out) && !/FAILED suites/.test(r.out),
    'recovered run is a clean pass (not inconclusive, not failed)');
  try { fs.rmSync(marker, { force: true }); } catch {}
}

// ── 4. Mixed batch: one pass + one transient → exit 0, accounting is right ───────
section('4. Mixed batch (1 pass + 1 transient) → exit 0, correct counts');
{
  const r = runAggregator('test-fixtures/runner-pass.js,test-fixtures/runner-transient.js');
  ok(r.code === 0, `exit code is 0 (got ${r.code})`);
  ok(/1 passed/.test(r.out), 'summary shows 1 passed');
  ok(/0 failed/.test(r.out), 'summary shows 0 failed');
  ok(/1 inconclusive/.test(r.out), 'summary shows 1 inconclusive');
}

// ── 5. MANIFEST AUDIT — a suite in no list must FAIL the run, before it starts ──
//
// The manifest is hand-typed, and `test-next-asset-paths.js` proved what that
// costs: it existed, it passed, and it was registered nowhere, so nothing ever
// ran it. The audit closes that by requiring set equality between
// `scripts/test-*.js` and OFFLINE + LIVE_CI + LIVE_LOCAL.
//
// Driven through the REAL runner via RUN_TESTS_MANIFEST_FIXTURE, pointed at
// throwaway directories carrying their own manifest.json — so the failure
// shapes are produced by the shipped code rather than re-implemented here, and
// no file has to be planted inside scripts/ to make the check fire.
section('5. Manifest audit — disk and manifest must agree');
function runManifestAudit(fixtureDir) {
  const res = spawnSync(process.execPath, [RUNNER], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, RUN_TESTS_MANIFEST_FIXTURE: path.join(__dirname, 'test-fixtures', fixtureDir) },
  });
  return { code: res.status, out: (res.stdout || '') + (res.stderr || '') };
}
{
  const clean = runManifestAudit('manifest-clean');
  ok(clean.code === 0, `a manifest matching disk exits 0 (got ${clean.code})`);
  ok(/Manifest OK/.test(clean.out), '…and says so, so a green audit is visible rather than merely silent');

  const unreg = runManifestAudit('manifest-unregistered');
  ok(unreg.code === 1, `an unregistered suite FAILS the run (got ${unreg.code})`);
  ok(/MANIFEST ERROR/.test(unreg.out), 'the failure is named as a manifest error, not as a suite failure');
  ok(/test-beta\.js/.test(unreg.out) && /test-gamma\.js/.test(unreg.out),
    'EVERY unregistered file is listed by name — the message is what an agent merging parallel work acts on');
  ok(!/test-alpha\.js/.test(unreg.out),
    '…and a correctly registered file is NOT listed, so the report discriminates rather than dumping the directory');
  ok(/nothing was run/i.test(unreg.out) && !/Suites:/.test(unreg.out),
    'THE ORDERING: it refuses BEFORE spawning any suite — a four-minute run that then reports a typo has spent the time the check exists to save');

  const missing = runManifestAudit('manifest-missing');
  ok(missing.code === 1, `a listed suite that does not exist FAILS the run (got ${missing.code})`);
  ok(/test-vanished\.js/.test(missing.out),
    '…and names the entry, rather than letting it surface later as a MODULE_NOT_FOUND from a child');

  const dupe = runManifestAudit('manifest-dupe');
  ok(dupe.code === 1, `a suite listed in two tiers FAILS the run (got ${dupe.code})`);
  ok(/listed twice/.test(dupe.out) && /OFFLINE and LIVE_CI/.test(dupe.out),
    '…and names both lists — a live suite listed twice bills twice');

  // CONTROL: the REAL manifest, audited for real, with no fixture seam. If this
  // ever fails, the repository itself has an unregistered or missing suite —
  // which is the whole point, and is exactly how this suite would tell you.
  const real = spawnSync(process.execPath, [RUNNER, '--audit-only'], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, RUN_TESTS_AUDIT_ONLY: '1' },
  });
  const realOut = (real.stdout || '') + (real.stderr || '');
  ok(real.status === 0 && !/MANIFEST ERROR/.test(realOut),
    'CONTROL: the repository\'s OWN manifest passes the same audit');
}

// ── Report ──────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('All beta.26 runner-orchestration integration assertions green.');
