#!/usr/bin/env node
/**
 * Regression tests for v3.0.1-beta.10 fixes.
 *
 * Covers:
 *   1. getDomainStats — Last ingest date returns the MOST RECENT log
 *      entry (not the first/oldest). Reproduces the original bug pattern
 *      against a synthetic log.md with mixed dates.
 *   2. classifyNpmError — every well-known npm-install failure pattern
 *      produces the expected actionable message; unknown errors fall
 *      through with `actionable: null` so the raw npm output is surfaced.
 *
 * Both checks run fully offline — no network, no LLM, no live filesystem
 * mutation outside an isolated tempdir.
 *
 *   node scripts/test-beta10-fixes.js
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, copyFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const tempRoot = mkdtempSync(path.join(tmpdir(), 'curator-beta10-'));
process.env.DOMAINS_PATH = tempRoot;

// Sideline the real config so the test always uses tempRoot and doesn't
// accidentally read the user's real API keys.
const realCfg = path.resolve('.curator-config.json');
const stash = realCfg + '.beta10-bak';
let stashed = false;
if (existsSync(realCfg)) {
  copyFileSync(realCfg, stash);
  rmSync(realCfg);
  stashed = true;
}

let passed = 0;
let failed = 0;
function ok(label) { passed++; console.log(`  ✓ ${label}`); }
function fail(label, detail) { failed++; console.log(`  ✗ ${label}`); if (detail) console.log(`    └─ ${detail}`); }
function eq(actual, expected, label) {
  if (actual === expected) return ok(label);
  return fail(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function truthy(cond, label, detail) { if (cond) return ok(label); return fail(label, detail); }

async function cleanup() {
  try { rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  if (stashed) {
    try { copyFileSync(stash, realCfg); rmSync(stash); } catch {}
  }
}
process.on('SIGINT', async () => { await cleanup(); process.exit(130); });

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  v3.0.1-beta.10 regression tests');
  console.log('═══════════════════════════════════════════════════════════════');

  // ── Test 1 — getDomainStats Last ingest date returns the LATEST ─────
  console.log('\n[1] getDomainStats — Last ingest date returns the most recent entry');
  {
    const { createDomain, getDomainStats } = await import('../src/brain/files.js');
    await createDomain('lateststats', 'Latest Stats Test', 'desc', 'tech');
    const logPath = path.join(tempRoot, 'lateststats', 'wiki', 'log.md');

    // Synthesise a log.md mirroring real-world structure — multiple
    // entries in ASCENDING chronological order (which is what appendLog
    // produces) so the FIRST match in the file is the OLDEST date.
    const log = [
      '# Log',
      '',
      '## [2026-04-24] ingest | A historical article',
      'Pages: entities/foo.md',
      '',
      '## [2026-04-26] ingest | Another article',
      'Pages: entities/bar.md',
      '',
      '## [2026-04-27] ingest | A third article',
      'Pages: concepts/baz.md',
      '',
      '## [2026-05-21] ingest | Today\'s article',
      'Pages: entities/qux.md',
      '',
      '## [2026-05-21] ingest | Today\'s second article',
      'Pages: entities/quux.md',
      '',
    ].join('\n');
    writeFileSync(logPath, log, 'utf8');

    const stats = await getDomainStats('lateststats');
    eq(stats.lastIngestDate, '2026-05-21',
      'Test 1a: lastIngestDate returns the LATEST entry, not the first');
    eq(stats.slug, 'lateststats', 'Test 1b: stats.slug is correct');
  }

  // ── Test 2 — Empty log returns null ─────────────────────────────────
  console.log('\n[2] getDomainStats — empty log returns null');
  {
    const { createDomain, getDomainStats } = await import('../src/brain/files.js');
    await createDomain('emptylogtest', 'Empty Log Test', 'desc', 'tech');
    const logPath = path.join(tempRoot, 'emptylogtest', 'wiki', 'log.md');
    writeFileSync(logPath, '# Log\n\nNo entries yet.\n', 'utf8');

    const stats = await getDomainStats('emptylogtest');
    eq(stats.lastIngestDate, null, 'Test 2a: log without any ## [date] heading returns null');
  }

  // ── Test 3 — Single-entry log returns that date ─────────────────────
  console.log('\n[3] getDomainStats — single-entry log returns its date');
  {
    const { createDomain, getDomainStats } = await import('../src/brain/files.js');
    await createDomain('singleentrytest', 'Single Entry', 'desc', 'tech');
    const logPath = path.join(tempRoot, 'singleentrytest', 'wiki', 'log.md');
    writeFileSync(logPath, '# Log\n\n## [2026-03-15] ingest | Only entry\nPages: x.md\n', 'utf8');

    const stats = await getDomainStats('singleentrytest');
    eq(stats.lastIngestDate, '2026-03-15', 'Test 3a: single-entry log returns that one date');
  }

  // ── Test 4 — Out-of-order entries: lex-max wins ────────────────────
  console.log('\n[4] getDomainStats — out-of-order entries: lex-max wins');
  {
    const { createDomain, getDomainStats } = await import('../src/brain/files.js');
    await createDomain('outoforder', 'Out Of Order', 'desc', 'tech');
    const logPath = path.join(tempRoot, 'outoforder', 'wiki', 'log.md');
    // User manually pasted an old entry at the end — newest is still in middle
    const log = [
      '# Log',
      '',
      '## [2026-05-19] ingest | A real recent ingest',
      'Pages: x.md',
      '',
      '## [2026-04-01] ingest | A really old entry pasted at the end',
      'Pages: y.md',
      '',
    ].join('\n');
    writeFileSync(logPath, log, 'utf8');

    const stats = await getDomainStats('outoforder');
    eq(stats.lastIngestDate, '2026-05-19',
      'Test 4a: lex-max wins even when entries are out of chronological order');
  }

  // ── Test 5 — Missing log.md returns null cleanly ───────────────────
  console.log('\n[5] getDomainStats — missing log.md returns null cleanly');
  {
    const { createDomain, getDomainStats } = await import('../src/brain/files.js');
    await createDomain('nologtest', 'No Log Test', 'desc', 'tech');
    // Delete the log file that createDomain produced
    const logPath = path.join(tempRoot, 'nologtest', 'wiki', 'log.md');
    rmSync(logPath, { force: true });

    const stats = await getDomainStats('nologtest');
    eq(stats.lastIngestDate, null, 'Test 5a: missing log.md returns null (not throw)');
  }

  // ── Test 6 — classifyNpmError — EACCES → cache-corrupted ────────────
  console.log('\n[6] classifyNpmError — corrupted-cache pattern');
  {
    const { classifyNpmError } = await import('../src/routes/config.js');
    const realError = 'Command failed: npm install --silent --no-audit --no-fund\n' +
      'npm error code EACCES\n' +
      'npm error syscall rename\n' +
      'npm error path /Users/robingood/.npm/_cacache/tmp/abc-XYZ\n' +
      'npm error errno -13\n' +
      'npm error EACCES: permission denied, rename ...';
    const c = classifyNpmError(realError, 'abc1234', 'def5678');
    eq(c.kind, 'cache-corrupted', 'Test 6a: EACCES kind is cache-corrupted');
    truthy(c.actionable && c.actionable.toLowerCase().includes('npm cache clean'),
      'Test 6b: actionable mentions `npm cache clean --force`');
    truthy(c.actionable && c.actionable.includes('abc1234') && c.actionable.includes('def5678'),
      'Test 6c: actionable includes the before/after SHAs');
  }

  // ── Test 7 — Just "errno -13" without EACCES string ────────────────
  console.log('\n[7] classifyNpmError — errno -13 alone still matches');
  {
    const { classifyNpmError } = await import('../src/routes/config.js');
    const c = classifyNpmError('something something errno -13 something', 'a', 'b');
    eq(c.kind, 'cache-corrupted', 'Test 7a: errno -13 substring still matches');
  }

  // ── Test 8 — Disk full ───────────────────────────────────────────
  console.log('\n[8] classifyNpmError — disk full');
  {
    const { classifyNpmError } = await import('../src/routes/config.js');
    const c = classifyNpmError('npm error ENOSPC: no space left on device', 'a', 'b');
    eq(c.kind, 'disk-full', 'Test 8a: ENOSPC kind is disk-full');
    truthy(c.actionable && c.actionable.toLowerCase().includes('free some space'),
      'Test 8b: actionable mentions freeing space');
  }

  // ── Test 9 — Network ─────────────────────────────────────────────
  console.log('\n[9] classifyNpmError — network errors');
  {
    const { classifyNpmError } = await import('../src/routes/config.js');
    for (const sig of ['ETIMEDOUT', 'ECONNRESET', 'socket hang up', 'ENOTFOUND']) {
      const c = classifyNpmError(`npm error ${sig} talking to registry`, 'a', 'b');
      eq(c.kind, 'network', `Test 9: ${sig} classifies as network`);
    }
  }

  // ── Test 10 — PATH issue surfaces as 'path' kind ──────────────────
  console.log('\n[10] classifyNpmError — PATH issue (handled separately by caller)');
  {
    const { classifyNpmError } = await import('../src/routes/config.js');
    const c = classifyNpmError('sh: npm: command not found', 'a', 'b');
    eq(c.kind, 'path', 'Test 10a: PATH issue classified as path');
    eq(c.actionable, null, 'Test 10b: PATH actionable is null (caller handles)');
  }

  // ── Test 11 — Unknown error falls through ─────────────────────────
  console.log('\n[11] classifyNpmError — unknown errors fall through cleanly');
  {
    const { classifyNpmError } = await import('../src/routes/config.js');
    const c = classifyNpmError('some weird unrelated message', 'a', 'b');
    eq(c.kind, 'unknown', 'Test 11a: unknown kind');
    eq(c.actionable, null, 'Test 11b: unknown actionable is null (raw error surfaced)');
  }

  // ── Test 12 — Empty / null / undefined input ─────────────────────
  console.log('\n[12] classifyNpmError — defensive handling of empty input');
  {
    const { classifyNpmError } = await import('../src/routes/config.js');
    for (const input of [null, undefined, '']) {
      const c = classifyNpmError(input, 'a', 'b');
      eq(c.kind, 'unknown', `Test 12: ${input} → unknown (no throw)`);
      eq(c.actionable, null, `Test 12: ${input} actionable is null`);
    }
  }

  // ── Test 13 — Lockfile ───────────────────────────────────────────
  console.log('\n[13] classifyNpmError — lockfile corruption');
  {
    const { classifyNpmError } = await import('../src/routes/config.js');
    const c = classifyNpmError('EINTEGRITY: sha512 mismatch in package-lock.json', 'a', 'b');
    eq(c.kind, 'lockfile', 'Test 13a: EINTEGRITY classifies as lockfile');
    truthy(c.actionable && c.actionable.includes('rm -rf node_modules'),
      'Test 13b: actionable mentions removing node_modules');
  }

  // ── Test 14 — "rename ... File exists" (the original user error) ──
  console.log('\n[14] classifyNpmError — the exact user-reported error');
  {
    const { classifyNpmError } = await import('../src/routes/config.js');
    const c = classifyNpmError(
      'EACCES: permission denied, rename \'/Users/x/.npm/_cacache/tmp/A\' -> \'/Users/x/.npm/_cacache/content-v2/sha512/etc\' (File exists)',
      'a', 'b'
    );
    eq(c.kind, 'cache-corrupted', 'Test 14a: real user error string classifies as cache-corrupted');
    truthy(c.actionable && c.actionable.toLowerCase().includes('cache clean'),
      'Test 14b: actionable points at npm cache clean --force');
  }

  // ── Test 15 — SHA-less call (graceful) ─────────────────────────
  console.log('\n[15] classifyNpmError — no SHA args (graceful)');
  {
    const { classifyNpmError } = await import('../src/routes/config.js');
    const c = classifyNpmError('EACCES blah');
    eq(c.kind, 'cache-corrupted', 'Test 15a: classifier still works without SHA args');
    truthy(c.actionable && !c.actionable.includes('undefined'),
      'Test 15b: no "undefined" in the message when SHAs are omitted');
  }

  // ── Summary ──────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`  Result: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  await cleanup();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async err => {
  console.error('FATAL:', err);
  await cleanup();
  process.exit(2);
});
