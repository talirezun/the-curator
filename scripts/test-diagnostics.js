#!/usr/bin/env node
/**
 * Offline battle test for the self-diagnostics module (v3.0.1-beta.23).
 *
 * Verifies the CONTRACT of runQuickDiagnostics() (shape, valid statuses,
 * summary accounting) and the deterministic domains-writable probe — without
 * asserting machine-specific state (provider/sync depend on the local config).
 * Does NOT call runLiveApiCheck() — that's the paid/live path.
 */
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { __setDomainsDirOverride } from '../src/brain/config.js';
import { runQuickDiagnostics } from '../src/brain/diagnostics.js';

let passed = 0, failed = 0;
const fails = [];
function ok(l)  { passed++; console.log(`  ✓ ${l}`); }
function bad(l, e) { failed++; fails.push({ l, e }); console.log(`  ✗ ${l}`); if (e) console.log(`    └─ ${e}`); }
function assert(c, l, e) { c ? ok(l) : bad(l, e || 'assertion failed'); }

const VALID = new Set(['ok', 'warn', 'fail', 'info']);

const work = mkdtempSync(path.join(tmpdir(), 'diag-test-'));

try {
  // ── Contract: shape + summary accounting ────────────────────────────────
  console.log('\n── runQuickDiagnostics contract ──');
  const writableDir = path.join(work, 'domains');
  mkdirSync(writableDir, { recursive: true });
  __setDomainsDirOverride(writableDir);

  const res = await runQuickDiagnostics();
  assert(res && Array.isArray(res.checks), 'returns { checks: [] }');
  assert(res.checks.length === 5, `5 checks returned (got ${res.checks?.length})`);
  assert(res.checks.every(c => c.id && c.label && VALID.has(c.status) && typeof c.detail === 'string'),
    'every check has id/label/valid-status/detail');

  const summed = (res.summary.ok || 0) + (res.summary.warn || 0) + (res.summary.fail || 0) + (res.summary.info || 0);
  assert(summed === res.checks.length, `summary counts sum to checks.length (${summed} === ${res.checks.length})`);

  const ids = res.checks.map(c => c.id);
  for (const id of ['version', 'provider', 'domains', 'credentials', 'sync']) {
    assert(ids.includes(id), `includes "${id}" check`);
  }

  // ── Domains-writable probe is deterministic ──────────────────────────────
  console.log('\n── domains-writable probe ──');
  const domCheckWritable = res.checks.find(c => c.id === 'domains');
  assert(domCheckWritable.status === 'ok', `writable tempdir → ok (got ${domCheckWritable.status})`);

  // Probe must self-clean — no leftover temp files in the dir.
  const { readdirSync } = await import('fs');
  const leftover = readdirSync(writableDir).filter(f => f.startsWith('.curator-healthcheck'));
  assert(leftover.length === 0, `probe file self-deleted (leftover: ${leftover.join(',') || 'none'})`);

  // Non-existent dir → warn (not a crash)
  __setDomainsDirOverride(path.join(work, 'does-not-exist'));
  const res2 = await runQuickDiagnostics();
  const domMissing = res2.checks.find(c => c.id === 'domains');
  assert(domMissing.status === 'warn', `missing domains dir → warn (got ${domMissing.status})`);

  __setDomainsDirOverride(null);
} catch (err) {
  bad('unexpected throw', err.message);
} finally {
  __setDomainsDirOverride(null);
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n  Total: ${passed + failed}   Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) {
  for (const { l, e } of fails) console.log(`  ✗ ${l}${e ? ` — ${e}` : ''}`);
  process.exit(1);
}
console.log('\nAll diagnostics tests green.');
process.exit(0);
