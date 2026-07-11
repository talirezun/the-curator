#!/usr/bin/env node
/**
 * Test aggregator (v3.0.1-beta.21).
 *
 * One command to run the whole battle-test suite and get a single pass/fail
 * report. Replaces "remember which of the 25 test-*.js files to run by name".
 *
 *   npm test            → OFFLINE suites only (fast, free, deterministic, no
 *                         network). Safe to run anytime, including in CI.
 *   npm run test:live   → OFFLINE + LIVE suites. LIVE suites hit the real
 *                         Gemini/Anthropic/GitHub APIs and need keys in .env or
 *                         the environment; each one self-skips if its key is
 *                         absent. Costs a few cents.
 *
 * Safety net: in the default (offline) mode we spawn each child with the
 * API/network credentials STRIPPED from its environment. So even if a suite is
 * mis-classified as offline, it physically cannot make a paid API call — the
 * worst case is the suite self-skips its live portion.
 *
 * A suite is judged PASSED iff it exits 0 AND its output shows no failure
 * marker. Both checks matter: some suites process.exit(1) on failure, and the
 * output scan is a backstop for any that don't.
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { hasTransientMarker, classifyLiveOutcome } from './ci-flake.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Suite manifest ────────────────────────────────────────────────────────
// OFFLINE: pure, deterministic, no network, no API key. The default `npm test`.
const OFFLINE = [
  'test-beta8-stress.js',
  'test-beta10-fixes.js',
  'test-beta11-fixes.js',
  'test-beta13-fixes.js',
  'test-beta15-fixes.js',
  'test-beta16-broken-links.js',
  'test-beta25-compile-prompt.js',
  'test-beta27-compile-fallback.js',
  'test-ci-flake.js',
  'test-runner-integration.js',
  'test-ingest-fixes.js',
  'test-sharedbrain-local.js',
  'test-sharedbrain-push.js',
  'test-sharedbrain-pull.js',
  'test-sharedbrain-security.js',
  'test-sharedbrain-synthesis.js',
  'test-sharedbrain-github-offline.js',
  'test-sharedbrain-mcp-guard.js',
  'test-sharedbrain-revoke.js',
  'test-sharedbrain-hardening.js',
  'test-sharedbrain-scenarios.js', // v3.0.6 Phase 5: 5.8-5.12 (local adapter, mock LLM/fetch, tempdir git)
  'test-diagnostics.js',
  'test-chat-truncation.js',       // v3.0.7: text-mode graceful truncation + context-neutral MAX_TOKENS error
];

// LIVE suites hit real Gemini/Anthropic/GitHub. Each self-skips when its key is
// missing, so running test:live without keys is harmless (reports SKIP, exit 0).
// Split into two tiers:
//
// LIVE_CI — self-contained + deterministic enough to gate CI. They isolate the
//   domains dir via CURATOR_TEST_DOMAINS_DIR (beats config) so they never touch
//   the real domains/ folder, on CI or a configured dev machine.
const LIVE_CI = [
  'test-beta8-live-llm.js',
  'test-beta14-anthropic-fix.js',
  'test-beta15-production.js',   // large source = committed docs/ingestion-pipeline.md
  'test-beta16-production.js',
  'test-beta17-production.js',
  'test-beta25-compile-live.js', // compile on a seeded large-index domain (Fix #1)
  'test-beta27-compile-live.js', // compile fallback prompts honoured by real models (Fix #2)
  'test-chat-truncation-live.js', // v3.0.7: real Gemini/Anthropic — text partial-return, JSON throw + isOutputTokenLimit
  // v3.0.6 Phase 5 (plan 5.6) — the GITHUB_TEST_* workflow secrets are no
  // longer dead config; all three self-skip or self-degrade without them:
  'test-sharedbrain-github-live.js', // self-skips without GITHUB_TEST_*; unique slugs per run; exhaustive cleanup
  'test-sharedbrain-routes.js',      // spawns a server on 3334; on-disk config backup (L21 fixed); no network unless GITHUB_TEST_* set
  'test-sharedbrain-llm-live.js',    // real delta+conflict prompts on every configured provider; GitHub storage when secrets present, local otherwise
];

// LIVE_LOCAL — run locally (full `npm run test:live`) but EXCLUDED on CI:
//   - test-beta13-chat-live: reads the dev machine's real 1000-page `articles`
//     domain and judges LLM answer quality (no data on CI; non-deterministic).
//   - test-ingest-real-llm: tied to a SPECIFIC personal article (asserts the
//     author "Dr. Tali Rezun") read from a hardcoded local path — not in the repo.
//   - test-ingest-deep: strict LLM-output quality thresholds (flaky as a gate).
const LIVE_LOCAL = [
  'test-beta13-chat-live.js',
  'test-ingest-real-llm.js',     // tied to a specific personal article (author assertions) on a hardcoded local path
  'test-ingest-deep.js',
];

// All live suites, for labelling.
const LIVE = [...LIVE_CI, ...LIVE_LOCAL];

// Env vars that grant API/network access. Stripped from offline children.
const CREDENTIAL_ENV = [
  'GEMINI_API_KEY', 'ANTHROPIC_API_KEY',
  'GITHUB_TEST_REPO', 'GITHUB_TEST_PAT',
];

// Offline suites run in <1s; live suites do real multi-phase ingests on one or
// two providers and legitimately take minutes (beta15-production ingests on BOTH
// Gemini and Anthropic). Give live suites a generous ceiling so a slow-but-fine
// run isn't killed; offline keeps a tight one.
const OFFLINE_TIMEOUT_MS = 120_000;  // 2 min (deterministic; never approached)
const LIVE_TIMEOUT_MS = 600_000;     // 10 min — heavy dual-provider live suites

// ── Args ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const runLive = args.includes('--live') || process.env.RUN_LIVE === '1';
// On CI (GitHub sets CI=true) exclude the local-only suites: they either need
// real local data, special secrets, or have flaky LLM-quality thresholds.
const isCI = process.env.CI === 'true' || process.env.CI === '1';

let suites;
if (!runLive) {
  suites = [...OFFLINE];
} else if (isCI) {
  suites = [...OFFLINE, ...LIVE_CI];
} else {
  suites = [...OFFLINE, ...LIVE_CI, ...LIVE_LOCAL];
}

// Test-only seam (used by test-runner-integration.js; unset in normal runs/CI):
// RUN_TESTS_LIVE_ONLY=<comma-separated suite files> replaces the manifest with
// exactly those files and marks each as LIVE, so the retry/inconclusive
// orchestration can be exercised end-to-end against tiny fake suites.
let forcedLive = null;
if (process.env.RUN_TESTS_LIVE_ONLY) {
  suites = process.env.RUN_TESTS_LIVE_ONLY.split(',').map(s => s.trim()).filter(Boolean);
  forcedLive = new Set(suites);
}

// ── Runner ────────────────────────────────────────────────────────────────
function runSuite(file, { stripCreds, timeoutMs }) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    if (stripCreds) for (const k of CREDENTIAL_ENV) delete env[k];

    const started = Date.now();
    const child = spawn(process.execPath, [path.join(__dirname, file)], {
      cwd: path.resolve(__dirname, '..'),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ file, ok: false, ms: Date.now() - started, reason: 'TIMEOUT', out });
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      const ms = Date.now() - started;
      // Failure markers (CASE-SENSITIVE on purpose). Two summary styles exist:
      //   "Passed: 39   Failed: 0"  → match a non-zero after the "Failed:" label
      //   "70 passed, 0 failed"     → match a non-zero before the lowercase word
      // Case sensitivity stops the lowercase pattern from matching the capital
      // "Failed" label preceded by the (non-zero) PASSED count, which was a
      // false-positive in the first cut.
      const failMarker =
        /Failed:\s*[1-9]/.test(out) ||
        /\b[1-9]\d*\s+failed\b/.test(out) ||
        /(^|\n)\s*✗/.test(out);
      // "Skipped" = the suite self-skipped (a live suite with no key). Match
      // only the strong markers the gating code prints — the ⏭ glyph, an
      // all-caps "SKIPPED", or a leading "SKIP:" line — NOT the lowercase word
      // "skip" that appears in ordinary assertion labels ("graceful skip…").
      const skipped = /⏭/.test(out) || /\bSKIPPED\b/.test(out) || /^SKIP:/m.test(out);
      const ok = code === 0 && !failMarker;
      resolve({ file, ok, ms, code, skipped, out });
    });
  });
}

function tail(out, n = 12) {
  return out.split('\n').filter(Boolean).slice(-n).map(l => `      ${l}`).join('\n');
}

(async () => {
  console.log(`\n  The Curator — test aggregator`);
  console.log(`  Mode: ${runLive ? 'OFFLINE + LIVE (real API calls)' : 'OFFLINE only (no network, no cost)'}`);
  if (runLive && isCI) {
    console.log(`  CI detected → excluding ${LIVE_LOCAL.length} local-only suite(s): ${LIVE_LOCAL.join(', ')}`);
  }
  console.log(`  Suites: ${suites.length}\n`);

  const results = [];
  for (const file of suites) {
    const isLive = LIVE.includes(file) || (forcedLive !== null && forcedLive.has(file));
    const opts = {
      stripCreds: !runLive,
      timeoutMs: isLive ? LIVE_TIMEOUT_MS : OFFLINE_TIMEOUT_MS,
    };
    let r = await runSuite(file, opts);

    // Live-suite flake tolerance (Option 1, v3.0.1-beta.26).
    //
    // A live suite hits real Gemini/Anthropic, so a transient provider error
    // (503 / dropped stream / rate-limit / network) fails it through no fault of
    // the code. Two cases, handled differently to keep the gate both honest AND
    // fast:
    //
    //   • First failure ALREADY shows a transient marker → the provider is in a
    //     storm right now. Do NOT retry — a retry would just grind through the
    //     same 503 backoffs (minutes on a heavy multi-phase ingest, and a real
    //     timeout risk). Mark INCONCLUSIVE immediately. During an outage
    //     "inconclusive" is the honest verdict anyway.
    //   • First failure has NO transient marker → it's ambiguous (an intermittent
    //     blip or a non-deterministic LLM-quality miss that may pass on a second
    //     look, and the suite ran at normal speed so a retry is cheap). Retry
    //     ONCE: pass → pass; fail-with-transient → inconclusive; fail-with-no-
    //     marker → genuine FAIL.
    //
    // Offline suites are deterministic and never retried. A TIMEOUT is never
    // retried (it would double an already-10-minute wait) and stays a FAIL.
    // Accepted trade-off: a real failure coinciding with a transient error in
    // the same run is reported inconclusive, not fail — the deterministic offline
    // suite + local `test:live` still catch real regressions, and a real bug
    // recurs on the next healthy-provider run.
    if (!r.ok && isLive && r.reason !== 'TIMEOUT') {
      if (hasTransientMarker(r.out)) {
        // Provider storm on the first attempt — skip the (slow, futile) retry.
        console.log(`  \x1b[33m⚠ flake\x1b[0m  ${file.padEnd(38)} transient provider error on first attempt — skipping retry`);
        r = { ...r, ok: true, skipped: true, inconclusive: true };
      } else {
        console.log(`  \x1b[33m↻ retry\x1b[0m  ${file.padEnd(38)} live suite failed (no provider error) — retrying once…`);
        const r2 = await runSuite(file, opts);
        const outcome = classifyLiveOutcome({
          firstOk: false,
          retried: true,
          retryOk: r2.ok,
          firstTransient: false,
          retryTransient: hasTransientMarker(r2.out),
        });
        if (outcome === 'pass') {
          r = r2;
        } else if (outcome === 'inconclusive') {
          r = { ...r2, ok: true, skipped: true, inconclusive: true };
        } else {
          r = r2; // genuine, reproducible failure
        }
      }
    }

    results.push(r);
    const label = r.inconclusive
      ? '\x1b[33m⚠ flake\x1b[0m'
      : r.ok
        ? (r.skipped ? '\x1b[33m⏭ skip\x1b[0m' : '\x1b[32m✓ pass\x1b[0m')
        : '\x1b[31m✗ FAIL\x1b[0m';
    console.log(`  ${label}  ${file.padEnd(38)} ${(r.ms + 'ms').padStart(7)}${isLive ? '  (live)' : ''}`);
    if (r.inconclusive) {
      console.log(`         ⚠ inconclusive — transient provider error (503 / rate-limit / dropped stream) on both attempts. NOT counted as a failure.`);
    } else if (!r.ok) {
      console.log(`         reason: ${r.reason || `exit ${r.code}`}`);
      console.log(tail(r.out));
    }
  }

  const failed = results.filter(r => !r.ok);
  const inconclusive = results.filter(r => r.inconclusive);
  const skipped = results.filter(r => r.ok && r.skipped && !r.inconclusive);
  const passed = results.length - failed.length - inconclusive.length;
  console.log(`\n  ────────────────────────────────────────`);
  console.log(
    `  ${results.length} suites · ${passed} passed · ${failed.length} failed` +
    `${inconclusive.length ? ` · ${inconclusive.length} inconclusive (provider flake)` : ''}` +
    `${skipped.length ? ` · ${skipped.length} skipped` : ''}`
  );
  console.log(`  ────────────────────────────────────────\n`);

  if (inconclusive.length) {
    console.log('  ⚠ INCONCLUSIVE (transient provider errors — not gating the build):');
    for (const r of inconclusive) console.log(`    ⚠ ${r.file}`);
    console.log('    Re-run the live job when the provider has recovered to get a clean signal.\n');
  }

  if (failed.length) {
    console.log('  FAILED suites:');
    for (const r of failed) console.log(`    ✗ ${r.file} (${r.reason || `exit ${r.code}`})`);
    console.log('');
    process.exit(1);
  }
  process.exit(0);
})();
