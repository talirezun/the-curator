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

// ── 1. Sustained transient provider error → INCONCLUSIVE, build stays green ─────
section('1. Sustained transient (HTTP 503) → inconclusive, exit 0');
{
  const r = runAggregator('test-fixtures/runner-transient.js');
  ok(r.code === 0, `exit code is 0 (got ${r.code}) — provider outage does NOT fail the build`);
  ok(/inconclusive/i.test(r.out), 'output reports "inconclusive"');
  ok(/flake/i.test(r.out), 'suite is labelled as a flake, not a pass');
  ok(/retry/i.test(r.out), 'a retry was attempted before giving the inconclusive verdict');
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
  ok(/retry/i.test(r.out), 'a retry was attempted');
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

// ── Report ──────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('All beta.26 runner-orchestration integration assertions green.');
