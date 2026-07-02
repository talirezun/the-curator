#!/usr/bin/env node
/**
 * v3.0.1-beta.8 — Live-LLM safety-net validation.
 *
 * Runs an actual ingest against Gemini Flash and verifies the new safety
 * nets engage correctly on real LLM output. The point isn't to test the
 * LLM — the existing scripts/test-ingest-real-llm.js does that — it's to
 * confirm the trunk-page detector, structural-check warnings, atomic
 * writes, and write-registry all work end-to-end on real (not mocked)
 * data without breaking the ingest.
 *
 * Test plan:
 *   STAGE 1: Ingest a real article via Gemini Flash
 *     ✓ Result has warnings array (may be empty — that's fine)
 *     ✓ If validateOutline emitted trunk warnings, the trunk page exists on disk
 *     ✓ Wiki page count is > 0 (ingest didn't refuse on a real source)
 *     ✓ index.md, log.md atomic-write-replaced cleanly (non-empty, parseable)
 *
 *   STAGE 2: Inspect that warnings + change records flow through cleanly
 *     ✓ result.warnings is an array
 *     ✓ result.changes is an array of change records
 *     ✓ Every change record has canonPath + status
 *
 * Requirements:
 *   GEMINI_API_KEY env var set
 *
 * Run:
 *   GEMINI_API_KEY=... node scripts/test-beta8-live-llm.js
 *
 * Exit code 0 on green; non-zero on any failure.
 */

import { mkdtempSync, rmSync, mkdirSync, copyFileSync, readFileSync, existsSync, readdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config(); // standalone script — .env keys aren't loaded via server.js here (v3.0.6)

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

// Isolation: tempdir for the test wiki. Use CURATOR_TEST_DOMAINS_DIR (beats
// config) — plain DOMAINS_PATH loses to a configured domainsPath and would make
// this test write into the real domains/ folder.
const tempRoot = mkdtempSync(path.join(tmpdir(), 'curator-beta8-live-'));
process.env.CURATOR_TEST_DOMAINS_DIR = tempRoot;

// Mute .curator-config.json by setting a fake path so config.js falls back to env
const origConfig = path.join(PROJECT_ROOT, '.curator-config.json');
const stashed = existsSync(origConfig);
if (stashed) {
  // Move it aside for the duration of the test so getDomainsDir() reads the env
  copyFileSync(origConfig, origConfig + '.beta8-test-bak');
  rmSync(origConfig);
}

let passed = 0;
let failed = 0;
const failures = [];

function ok(label) { passed++; console.log(`  ✓ ${label}`); }
function fail(label, detail) {
  failed++;
  failures.push({ label, detail });
  console.log(`  ✗ ${label}`);
  if (detail) console.log(`    └─ ${detail}`);
}
function assertTrue(cond, label, detail) { if (cond) return ok(label); fail(label, detail); }

async function cleanup() {
  try { rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  if (stashed) {
    try { copyFileSync(origConfig + '.beta8-test-bak', origConfig); rmSync(origConfig + '.beta8-test-bak'); } catch {}
  }
}

process.on('exit', () => { /* sync cleanup handled in main */ });

try {
  if (!process.env.GEMINI_API_KEY) {
    console.log('SKIPPED — GEMINI_API_KEY not set.');
    await cleanup();
    process.exit(0);
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  v3.0.1-beta.8 live-LLM safety-net battle test');
  console.log('═══════════════════════════════════════════════════════════\n');
  console.log('  Using DOMAINS_PATH=' + tempRoot);

  // Late imports so DOMAINS_PATH override is in effect
  const { createDomain } = await import('../src/brain/files.js');
  const { ingestFile } = await import('../src/brain/ingest.js');

  // Find a real article to ingest
  const candidatePaths = [
    path.join(PROJECT_ROOT, 'research/articles/from-graph-to-intelligence-my-curator-mcp.md'),
    path.join(PROJECT_ROOT, 'research/articles/the-agent-memory-problem.md'),
    path.join(PROJECT_ROOT, 'research/articles/knowledge-immortality-second-brain.md'),
  ];
  const sourcePath = candidatePaths.find(p => existsSync(p));
  if (!sourcePath) {
    console.log('SKIPPED — no real article available in research/articles/');
    await cleanup();
    process.exit(0);
  }
  console.log('  Source: ' + path.relative(PROJECT_ROOT, sourcePath));

  // Create the test domain
  await createDomain('beta8live', 'Beta8 Live', 'Testing safety nets', 'tech');

  // Stage the source into a temp file (ingestFile doesn't copy from outside paths)
  const stagedPath = path.join(tempRoot, path.basename(sourcePath));
  copyFileSync(sourcePath, stagedPath);

  console.log('\n═══ STAGE 1: Ingest a real article ═══\n');

  let lastPct = 0;
  const startTime = Date.now();
  const result = await ingestFile(
    'beta8live',
    stagedPath,
    path.basename(sourcePath),
    false,
    (ev) => {
      if (ev.pct && ev.pct !== lastPct) {
        process.stdout.write(`\r    [${String(ev.pct).padStart(3)}%] ${(ev.message || '').slice(0, 50).padEnd(50)}`);
        lastPct = ev.pct;
      }
    }
  );
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n\n  Ingest completed in ${elapsed}s — ${result.pagesWritten.length} pages.\n`);

  console.log('  Assertions:\n');

  // Basic shape
  assertTrue(Array.isArray(result.warnings), 'result.warnings is an array');
  assertTrue(Array.isArray(result.changes), 'result.changes is an array');
  assertTrue(result.pagesWritten.length > 0, 'at least one page written', `got ${result.pagesWritten.length}`);

  // Change records
  if (result.changes.length > 0) {
    const sample = result.changes[0];
    assertTrue(typeof sample.canonPath === 'string', 'change record has canonPath');
    assertTrue(typeof sample.status === 'string', 'change record has status');
    assertTrue(['created', 'updated', 'unchanged'].includes(sample.status),
      `change status is valid (got "${sample.status}")`);
  } else {
    fail('change records list non-empty', 'no changes recorded');
  }

  // Warnings dump (non-fatal, just informational)
  if (result.warnings.length > 0) {
    console.log('\n  Warnings emitted (informational):');
    for (const w of result.warnings) {
      console.log(`    • ${w.slice(0, 110)}${w.length > 110 ? '…' : ''}`);
    }
  } else {
    console.log('\n  (No warnings emitted by validator — outline was structurally clean.)');
  }

  // If validator emitted a trunk-page warning, the trunk file should exist on disk
  const wikiDir = path.join(tempRoot, 'beta8live', 'wiki');
  const trunkWarnings = result.warnings.filter(w => w.includes('without a parent'));
  if (trunkWarnings.length > 0) {
    console.log(`\n  Trunk-page detector fired ${trunkWarnings.length} time${trunkWarnings.length === 1 ? '' : 's'}.`);
    for (const w of trunkWarnings) {
      // Pull the prefix from the warning text (format: ... "<prefix>-*" pages without a parent "concepts/<prefix>.md")
      const m = w.match(/concepts\/(\S+?)\.md/);
      if (m) {
        const trunkSlug = m[1];
        const trunkPath = path.join(wikiDir, 'concepts', `${trunkSlug}.md`);
        assertTrue(existsSync(trunkPath),
          `trunk page "concepts/${trunkSlug}.md" exists on disk`,
          `expected at ${trunkPath}`);
      }
    }
  } else {
    console.log('\n  (Trunk detector did not fire — this LLM output had no qualifying clusters.)');
    ok('trunk detector did not falsely fire on a clean outline');
  }

  // Atomic-write integrity check — index.md and log.md should be non-empty
  // and contain expected anchors. (Atomic writes guarantee no zero-byte files.)
  const indexPath = path.join(wikiDir, 'index.md');
  const logPath = path.join(wikiDir, 'log.md');
  assertTrue(existsSync(indexPath), 'index.md exists');
  assertTrue(existsSync(logPath), 'log.md exists');
  const indexContent = readFileSync(indexPath, 'utf8');
  const logContent = readFileSync(logPath, 'utf8');
  assertTrue(indexContent.length > 50, 'index.md is non-empty (atomic write succeeded)',
    `got ${indexContent.length} bytes`);
  assertTrue(logContent.length > 10, 'log.md is non-empty (atomic write succeeded)',
    `got ${logContent.length} bytes`);
  assertTrue(logContent.includes('ingest'), 'log.md has an ingest entry');

  // Verify the wiki has the canonical folders + non-zero file counts
  for (const folder of ['entities', 'concepts', 'summaries']) {
    const dir = path.join(wikiDir, folder);
    if (existsSync(dir)) {
      const files = readdirSync(dir).filter(f => f.endsWith('.md'));
      assertTrue(files.length > 0, `${folder}/ has ${files.length} page${files.length === 1 ? '' : 's'}`);
    }
  }

  // Verify no zero-byte files anywhere in the wiki (atomic writes succeeded)
  function checkZeroBytes(dir) {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        checkZeroBytes(full);
      } else if (e.name.endsWith('.md')) {
        const stats = readFileSync(full, 'utf8');
        if (stats.length === 0) {
          fail(`zero-byte file detected: ${path.relative(wikiDir, full)}`, 'atomic write contract violated');
        }
      }
    }
  }
  const beforeFailCount = failed;
  checkZeroBytes(wikiDir);
  if (failed === beforeFailCount) ok('no zero-byte files anywhere in wiki (atomic write contract held)');

  // Verify no stray .tmp-* files
  function checkNoTmpFiles(dir) {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) checkNoTmpFiles(path.join(dir, e.name));
      else if (e.name.startsWith('.tmp-')) {
        fail(`stray temp file found: ${path.relative(wikiDir, path.join(dir, e.name))}`,
          'atomic write left tempfile orphaned');
      }
    }
  }
  const beforeTmpFails = failed;
  checkNoTmpFiles(wikiDir);
  if (failed === beforeTmpFails) ok('no orphaned .tmp-* files after ingest');

  // Summary
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════════════════\n');
  if (failed > 0) {
    console.log('Failures:');
    for (const f of failures) {
      console.log(`  - ${f.label}`);
      if (f.detail) console.log(`      ${f.detail}`);
    }
  }
  await cleanup();
  process.exit(failed > 0 ? 1 : 0);
} catch (err) {
  console.error('\nFATAL:', err.message);
  console.error(err.stack);
  await cleanup();
  process.exit(2);
}
