#!/usr/bin/env node
/**
 * v3.0.1-beta.1 — Real-LLM end-to-end ingest validation.
 *
 * Uses the actual Gemini Flash API to ingest a real article into an isolated
 * tempdir domain. Verifies the five bugs the community reported are actually
 * fixed by the v3.0.1 changes, AND that re-ingest is idempotent.
 *
 * Isolation:
 *   - DOMAINS_PATH points to a fresh tempdir (no contact with the user's
 *     production wiki at /Users/talirezun/second-brain/domains/)
 *   - Cleanup at end (tempdir removed even on failure)
 *
 * Requirements:
 *   GEMINI_API_KEY env var set (or .env in cwd loaded). User authorised real
 *   LLM calls.
 *
 * Test plan:
 *   STAGE 1: First ingest of an MD article
 *     ✓ Result has no validator-warning about missing summary
 *     ✓ summaries/<deterministic-slug>.md exists on disk
 *     ✓ Summary contains "Entities Mentioned" section populated by syncSummaryEntities
 *     ✓ At least 1 entity page exists for the author (Dr Tali Rezun)
 *     ✓ At least 3 concept pages exist
 *     ✓ index.md contains rows for newly created pages
 *     ✓ log.md has an ingest entry
 *
 *   STAGE 2: Re-ingest the same file (isOverwrite=true)
 *     ✓ Still exactly ONE summary file (no duplicate)
 *     ✓ Same author entity file still exists (no -2 suffix or hyphen variant)
 *     ✓ Entity page Related section has merged bullets (not doubled)
 *     ✓ index.md has no duplicate rows
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
const ROOT = path.resolve(__dirname, '..');

// ── Test harness ─────────────────────────────────────────────────────────────
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
function assertEq(actual, expected, label) {
  if (actual === expected) return ok(label);
  fail(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ── Setup: isolated tempdir ──────────────────────────────────────────────────
const testRoot = mkdtempSync(path.join(tmpdir(), 'curator-ingest-real-'));
const domainsPath = path.join(testRoot, 'domains');
const TEST_DOMAIN = 'test-real';
const domainDir = path.join(domainsPath, TEST_DOMAIN);
const rawDir = path.join(domainDir, 'raw');
const wikiDir = path.join(domainDir, 'wiki');

console.log(`\nIsolated test domain: ${domainDir}\n`);

// Create domain skeleton
mkdirSync(path.join(wikiDir, 'entities'), { recursive: true });
mkdirSync(path.join(wikiDir, 'concepts'), { recursive: true });
mkdirSync(path.join(wikiDir, 'summaries'), { recursive: true });
mkdirSync(rawDir, { recursive: true });

// Copy the real domain's CLAUDE.md schema to make the test realistic
const realSchema = '/Users/talirezun/second-brain/domains/articles/CLAUDE.md';
const testSchema = path.join(domainDir, 'CLAUDE.md');
if (existsSync(realSchema)) {
  copyFileSync(realSchema, testSchema);
} else {
  writeFileSync(testSchema, '# Articles domain\n\nIngest articles and extract entities, concepts, and a summary.\n');
}

// Empty index + log
writeFileSync(path.join(wikiDir, 'index.md'), '# Index\n\n| Page | Type | Summary |\n|---|---|---|\n');
writeFileSync(path.join(wikiDir, 'log.md'), '# Log\n\n');

// Copy a real article into raw/
const SOURCE_ARTICLE_NAME = 'lumina-v1-48-hours.md';
const realArticlePath = '/Users/talirezun/second-brain/domains/articles/raw/From Google AI Studio to Production_ Building Lumina v1 in 48 Hours.md';
if (!existsSync(realArticlePath)) {
  console.error(`Source article not found: ${realArticlePath}`);
  rmSync(testRoot, { recursive: true, force: true });
  process.exit(1);
}
const articleInRaw = path.join(rawDir, SOURCE_ARTICLE_NAME);
copyFileSync(realArticlePath, articleInRaw);
console.log(`Source article: ${SOURCE_ARTICLE_NAME} (${(readFileSync(articleInRaw, 'utf8').length / 1024).toFixed(1)} KB)\n`);

// Pin the domains dir to our tempdir so the real config.js doesn't redirect us
// at the user's production wiki. CURATOR_TEST_DOMAINS_DIR beats config; plain
// DOMAINS_PATH does NOT (it loses to a configured domainsPath), so the old line
// silently wrote into the real domains/ on a configured machine.
process.env.CURATOR_TEST_DOMAINS_DIR = domainsPath;

// Cleanup hook — runs even on uncaught exception
function cleanup() {
  try { rmSync(testRoot, { recursive: true, force: true }); }
  catch (e) { console.warn(`Cleanup warning: ${e.message}`); }
}
process.on('exit', cleanup);

(async () => {
  // ── Sanity check: API key present ────────────────────────────────────────
  const apiKey = process.env.GEMINI_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('SKIP: no GEMINI_API_KEY or ANTHROPIC_API_KEY available — live-suite convention is self-skip.');
    process.exit(0);
  }
  console.log(`Using ${process.env.GEMINI_API_KEY ? 'Gemini' : 'Anthropic'} for this test.\n`);

  // ── Import after env is set so config.js reads the right paths ───────────
  const { ingestFile, computeSummarySlugFromSource } = await import('../src/brain/ingest.js');

  // Expected canonical summary slug + path
  const expectedSlug = computeSummarySlugFromSource(SOURCE_ARTICLE_NAME);
  const expectedSummaryPath = `summaries/${expectedSlug}.md`;
  console.log(`Expected summary slug: ${expectedSlug}\n`);

  // ── STAGE 1: First ingest ────────────────────────────────────────────────
  console.log('═══ STAGE 1: First ingest ═══\n');
  let result1;
  try {
    const t0 = Date.now();
    result1 = await ingestFile(
      TEST_DOMAIN,
      articleInRaw,
      SOURCE_ARTICLE_NAME,
      false, // isOverwrite
      (e) => {
        if (e.type === 'progress' && e.pct % 20 === 0) {
          process.stdout.write(`\r    [${e.pct}%] ${e.message}                              `);
        }
      }
    );
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    process.stdout.write('\n');
    console.log(`\n  Completed in ${elapsed}s — ${result1.pagesWritten.length} pages written.\n`);
  } catch (e) {
    console.error(`\nFATAL: ingestFile threw: ${e.message}`);
    failed++;
    return;
  }

  // Group canonical paths by folder
  const stage1Paths = result1.pagesWritten;
  const stage1Summaries = stage1Paths.filter(p => p.startsWith('summaries/'));
  const stage1Entities  = stage1Paths.filter(p => p.startsWith('entities/'));
  const stage1Concepts  = stage1Paths.filter(p => p.startsWith('concepts/'));

  console.log(`  • Summaries: ${stage1Summaries.length}`);
  console.log(`  • Entities:  ${stage1Entities.length}  (${stage1Entities.slice(0,6).join(', ')}${stage1Entities.length > 6 ? '…' : ''})`);
  console.log(`  • Concepts:  ${stage1Concepts.length}  (${stage1Concepts.slice(0,6).join(', ')}${stage1Concepts.length > 6 ? '…' : ''})`);
  console.log(`  • Warnings:  ${result1.warnings?.length || 0}${result1.warnings?.length ? ' — ' + result1.warnings.join(' | ') : ''}`);
  console.log(`  • Truncated: ${result1.truncated}\n`);

  // ── Assertions: STAGE 1 ─────────────────────────────────────────────────
  console.log('  Assertions:\n');

  // 1. Summary page exists at the deterministic slug
  assertEq(stage1Summaries.length, 1, 'exactly one summary page in pagesWritten');
  assertTrue(stage1Summaries.includes(expectedSummaryPath),
    `summary page lands on canonical slug "${expectedSummaryPath}"`,
    stage1Summaries.length ? `got: ${stage1Summaries[0]}` : 'no summary present');

  // 2. Summary file exists on disk
  const summaryFile = path.join(wikiDir, expectedSummaryPath);
  assertTrue(existsSync(summaryFile), 'summary file exists on disk');

  // 3. Summary contains "Entities Mentioned" (syncSummaryEntities ran)
  if (existsSync(summaryFile)) {
    const summaryContent = readFileSync(summaryFile, 'utf8');
    assertTrue(/^##\s+Entities Mentioned/m.test(summaryContent),
      'summary has "Entities Mentioned" section (syncSummaryEntities ran)');
    // Count linked entities — should be > 5 (the article mentions many)
    const linkedCount = (summaryContent.match(/\[\[[^\]]+\]\]/g) || []).length;
    assertTrue(linkedCount >= 5,
      `summary references >= 5 wikilinks (got ${linkedCount})`,
      `low link count suggests under-reporting bug`);
  }

  // 4. At least one author entity — the article is by Dr Tali Rezun
  const authorCandidates = stage1Entities.filter(p =>
    /tali|rezun/i.test(p)
  );
  assertTrue(authorCandidates.length >= 1,
    'author entity created (page slug contains "tali" or "rezun")',
    authorCandidates.length === 0 ? `no entities mentioning author. Entities: ${stage1Entities.join(', ')}` : null);

  // 5. Reasonable entity coverage — at least 3 (this article mentions many: Google, Gemini, Lumina, …)
  assertTrue(stage1Entities.length >= 3,
    `at least 3 entity pages created (got ${stage1Entities.length})`,
    'under-coverage suggests prompt rules not landing');

  // 6. Concept coverage — at least 3
  assertTrue(stage1Concepts.length >= 3,
    `at least 3 concept pages created (got ${stage1Concepts.length})`);

  // 7. index.md has the summary row
  const indexContent = readFileSync(path.join(wikiDir, 'index.md'), 'utf8');
  assertTrue(indexContent.includes(`[[summaries/${expectedSlug}]]`),
    'index.md contains row for the new summary',
    `index excerpt: ${indexContent.slice(-300)}`);

  // 8. log.md has an ingest entry
  const logContent = readFileSync(path.join(wikiDir, 'log.md'), 'utf8');
  assertTrue(/##\s+\[.*\]\s+ingest\s+\|/.test(logContent),
    'log.md has an ingest entry');

  // 9. No validator warning about missing summary (the prompt worked)
  const missingSummaryWarn = (result1.warnings || []).find(w => w.includes('missing summary'));
  assertTrue(!missingSummaryWarn,
    'no "missing summary" warning — prompt produced a summary directly',
    missingSummaryWarn ? `got warning: ${missingSummaryWarn}` : null);

  // ── STAGE 2: Re-ingest (idempotency) ─────────────────────────────────────
  console.log('\n═══ STAGE 2: Re-ingest same file (idempotency check) ═══\n');

  let result2;
  try {
    const t0 = Date.now();
    result2 = await ingestFile(
      TEST_DOMAIN,
      articleInRaw,
      SOURCE_ARTICLE_NAME,
      true, // isOverwrite
      (e) => {
        if (e.type === 'progress' && e.pct % 20 === 0) {
          process.stdout.write(`\r    [${e.pct}%] ${e.message}                              `);
        }
      }
    );
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    process.stdout.write('\n');
    console.log(`\n  Re-ingest completed in ${elapsed}s — ${result2.pagesWritten.length} pages.\n`);
  } catch (e) {
    console.error(`\nFATAL: re-ingest threw: ${e.message}`);
    failed++;
    return;
  }

  // ── Assertions: STAGE 2 ─────────────────────────────────────────────────
  console.log('  Assertions:\n');

  // 10. On-disk summaries folder still has exactly ONE file (no duplicate)
  const summariesOnDisk = readdirSync(path.join(wikiDir, 'summaries')).filter(f => f.endsWith('.md'));
  assertEq(summariesOnDisk.length, 1, 'exactly one summary file on disk after re-ingest');
  if (summariesOnDisk.length === 1) {
    assertEq(summariesOnDisk[0], `${expectedSlug}.md`,
      'the one summary file uses the canonical slug');
  }

  // 11. Re-ingest pages_written summary path is the SAME canonical path
  const stage2Summaries = result2.pagesWritten.filter(p => p.startsWith('summaries/'));
  assertEq(stage2Summaries[0], expectedSummaryPath,
    're-ingest summary path identical to first ingest');

  // 12. Entity files on disk: count should grow only by genuinely new entities,
  //     and known author files should NOT have hyphen-variant duplicates.
  const entitiesOnDisk = readdirSync(path.join(wikiDir, 'entities')).filter(f => f.endsWith('.md'));
  const authorFilesOnDisk = entitiesOnDisk.filter(f => /tali|rezun/i.test(f));
  assertEq(authorFilesOnDisk.length, 1,
    'exactly one author entity file on disk (no hyphen variants)');

  // 13. index.md has no duplicate rows for the summary
  const indexAfter = readFileSync(path.join(wikiDir, 'index.md'), 'utf8');
  const summaryRowCount = (indexAfter.match(new RegExp(`\\[\\[summaries/${expectedSlug.replace(/[-]/g, '\\-')}\\]\\]`, 'g')) || []).length;
  assertEq(summaryRowCount, 1, 'index.md has exactly 1 row for the summary slug (no duplicates)');

  // 14. The summary file's "Entities Mentioned" still has the author backlink
  const summaryAfter = readFileSync(summaryFile, 'utf8');
  assertTrue(/Entities Mentioned/.test(summaryAfter),
    'summary still has Entities Mentioned section after re-ingest');

  // 15. Author entity's Related section contains the summary backlink (one bullet, not duplicated)
  if (authorFilesOnDisk.length === 1) {
    const authorContent = readFileSync(path.join(wikiDir, 'entities', authorFilesOnDisk[0]), 'utf8');
    const summaryBacklinks = (authorContent.match(new RegExp(`\\[\\[summaries/${expectedSlug.replace(/[-]/g, '\\-')}\\]\\]`, 'g')) || []).length;
    assertEq(summaryBacklinks, 1,
      'author entity has exactly 1 backlink to summary (no duplicates)');
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
  if (failed > 0) {
    console.log('Failures:');
    for (const f of failures) {
      console.log(`  ✗ ${f.label}`);
      if (f.detail) console.log(`    └─ ${f.detail}`);
    }
    process.exit(1);
  }
  process.exit(0);
})().catch(e => {
  console.error('\nUncaught test error:', e);
  process.exit(2);
});
