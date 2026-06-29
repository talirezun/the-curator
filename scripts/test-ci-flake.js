#!/usr/bin/env node
/**
 * v3.0.1-beta.26 — offline unit test for the live-suite flake classifier.
 *
 * Verifies the pure helpers in scripts/ci-flake.js that let the test aggregator
 * tolerate transient provider outages (HTTP 503, dropped streams, rate limits,
 * network blips) on the live-API CI job WITHOUT masking genuine code defects.
 *
 * Run:  node scripts/test-ci-flake.js
 * Exit: 0 if all green; non-zero on any failure.
 */

import { hasTransientMarker, classifyLiveOutcome, TRANSIENT_MARKERS } from './ci-flake.js';

let passed = 0, failed = 0;
const failures = [];
function ok(cond, label) {
  cond ? (passed++, console.log(`  ✓ ${label}`)) : (failed++, failures.push(label), console.log(`  ✗ ${label}`));
}
function section(t) { console.log(`\n${t}`); }

// ── 1. hasTransientMarker — real provider error strings are detected ────────────
section('1. hasTransientMarker detects real transient provider/network errors');

// These are taken verbatim from the failing CI run + llm.js error text.
const gemini503 = '⚠ Gemini infrastructure is temporarily overloaded (HTTP 503). This is a transient backend issue on the provider\'s side';
const anthropicPremature = 'compile succeeded (ok=false, error="LLM call failed: Premature close")';
const rate429 = '⚠ Rate limit hit on Gemini (HTTP 429). This is an upstream limit on your API account';
const netReset = 'Error: read ECONNRESET';
const sockHang = 'FetchError: request to https://... failed, reason: socket hang up';
const serviceUnavail = 'Service Unavailable';

ok(hasTransientMarker(gemini503), 'Gemini HTTP 503 "temporarily overloaded" → transient');
ok(hasTransientMarker(anthropicPremature), 'Anthropic "Premature close" → transient');
ok(hasTransientMarker(rate429), 'HTTP 429 rate limit → transient');
ok(hasTransientMarker(netReset), 'ECONNRESET → transient');
ok(hasTransientMarker(sockHang), 'socket hang up → transient');
ok(hasTransientMarker(serviceUnavail), 'Service Unavailable → transient');

// ── 2. hasTransientMarker — genuine assertion failures are NOT transient ────────
section('2. hasTransientMarker does NOT flag genuine code-defect output');

const realAssertFail = [
  '  ✗ run 2: compile wrote pages (0)',
  '  ✗ summary page produced',
  'RESULT: 12 passed, 2 failed',
  'Failures:',
  '  - compile wrote pages (0)',
].join('\n');
ok(!hasTransientMarker(realAssertFail), 'a normal assertion failure (no provider error) → NOT transient');
ok(!hasTransientMarker(''), 'empty string → NOT transient');
ok(!hasTransientMarker(null), 'null → NOT transient (defensive)');
ok(!hasTransientMarker(undefined), 'undefined → NOT transient (defensive)');
ok(TRANSIENT_MARKERS.length > 5, 'marker list is populated');

// A failure that LOOKS like an LLM-quality miss (the beta17 pattern) but carries
// no network/503 string must NOT be auto-tolerated — it should reach the
// "no transient marker" branch so a persistent miss can still fail.
const llmQualityMiss = '✗ [anthropic] AI found a home for backpropagation (→ none)';
ok(!hasTransientMarker(llmQualityMiss), 'LLM-quality miss with no provider error → NOT transient');

// ── 3. classifyLiveOutcome — the retry/inconclusive truth table ────────────────
section('3. classifyLiveOutcome — full truth table');

// First run passes → pass (no retry needed).
ok(classifyLiveOutcome({ firstOk: true }) === 'pass',
  'first run passes → pass');

// First fails, retry passes → pass (intermittent flake recovered).
ok(classifyLiveOutcome({ firstOk: false, retried: true, retryOk: true, firstTransient: true, retryTransient: false }) === 'pass',
  'first fails (transient), retry passes → pass');
ok(classifyLiveOutcome({ firstOk: false, retried: true, retryOk: true, firstTransient: false, retryTransient: false }) === 'pass',
  'first fails (no marker), retry passes → pass (e.g. an LLM-quality miss that recovered)');

// First fails, retry fails, transient present → inconclusive (provider outage).
ok(classifyLiveOutcome({ firstOk: false, retried: true, retryOk: false, firstTransient: true, retryTransient: true }) === 'inconclusive',
  'both fail with transient markers → inconclusive');
ok(classifyLiveOutcome({ firstOk: false, retried: true, retryOk: false, firstTransient: true, retryTransient: false }) === 'inconclusive',
  'first transient, retry no-marker but still failed → inconclusive (provider trouble in the window)');
ok(classifyLiveOutcome({ firstOk: false, retried: true, retryOk: false, firstTransient: false, retryTransient: true }) === 'inconclusive',
  'retry hit a transient error → inconclusive');

// First fails, retry fails, NO transient marker either time → genuine FAIL.
ok(classifyLiveOutcome({ firstOk: false, retried: true, retryOk: false, firstTransient: false, retryTransient: false }) === 'fail',
  'both fail with NO transient marker → fail (real, reproducible defect)');

// Defensive: not retried.
ok(classifyLiveOutcome({ firstOk: false, retried: false, firstTransient: false }) === 'fail',
  'failed, not retried, no marker → fail');
ok(classifyLiveOutcome({ firstOk: false, retried: false, firstTransient: true }) === 'inconclusive',
  'failed, not retried, transient marker → inconclusive');

// ── 4. End-to-end scenario fidelity (mirrors the real failing CI run) ───────────
section('4. The real CI failure modes resolve correctly');

// beta25 run-2 hit a Gemini 503; a retry on healthy Gemini would pass.
ok(classifyLiveOutcome({ firstOk: false, retried: true, retryOk: true, firstTransient: hasTransientMarker(gemini503), retryTransient: false }) === 'pass',
  'beta25 (Gemini 503 then recovers) → pass');
// Sustained Gemini outage across both attempts → inconclusive, not a red build.
ok(classifyLiveOutcome({ firstOk: false, retried: true, retryOk: false, firstTransient: hasTransientMarker(gemini503), retryTransient: hasTransientMarker(gemini503) }) === 'inconclusive',
  'sustained Gemini 503 across both attempts → inconclusive (gate stays usable)');
// A truly broken compile (no provider error) must still fail, even with a retry.
ok(classifyLiveOutcome({ firstOk: false, retried: true, retryOk: false, firstTransient: hasTransientMarker(realAssertFail), retryTransient: hasTransientMarker(realAssertFail) }) === 'fail',
  'a real reproducible compile bug → still fail (not masked)');

// ── Report ──────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('All beta.26 CI-flake classifier assertions green.');
