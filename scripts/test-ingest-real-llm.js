#!/usr/bin/env node
/**
 * v3.0.1-beta.1 — Real-LLM end-to-end ingest validation.
 * v3.5.1 — de-personalised: the source schema + article are now supplied by
 *   the person running the suite, via env vars, instead of being hardcoded
 *   to one machine's filesystem. See "Requirements" below.
 *
 * Uses a real Gemini/Anthropic API call to ingest a source document into an
 * isolated tempdir domain. Verifies the five bugs the v3.0.1 community report
 * fixed are actually fixed, AND that re-ingest is idempotent.
 *
 * Isolation:
 *   - CURATOR_TEST_DOMAINS_DIR points at a fresh tempdir (no contact with any
 *     production wiki)
 *   - Cleanup at end (tempdir removed even on failure)
 *
 * Requirements (all four must be present, or the suite self-skips):
 *   GEMINI_API_KEY or ANTHROPIC_API_KEY  — a real, working key
 *   CURATOR_LIVE_SCHEMA   — path to a domain CLAUDE.md schema file to seed
 *                            the test domain with (any real or synthetic
 *                            schema works; it's read verbatim)
 *   CURATOR_LIVE_ARTICLE  — path to a source document (.md/.txt/.pdf) to
 *                            ingest. Any article works — the assertions below
 *                            are structural, not tied to any specific
 *                            content or author.
 *
 * This suite needs a document you supply locally (not shipped in the public
 * repo), so it stays in the LIVE_LOCAL manifest in scripts/run-tests.js
 * rather than running in CI — see the comment there for why.
 *
 * Test plan:
 *   STAGE 1: First ingest of the supplied article
 *     ✓ Result has no validator-warning about missing summary
 *     ✓ summaries/<deterministic-slug>.md exists on disk
 *     ✓ Summary contains "Entities Mentioned" section populated by syncSummaryEntities
 *     ✓ If the source's own frontmatter/byline names an author, an entity
 *       page for them was created (derived from the SOURCE, never hardcoded)
 *     ✓ At least 3 entity pages exist
 *     ✓ At least 3 concept pages exist
 *     ✓ index.md contains rows for newly created pages
 *     ✓ log.md has an ingest entry
 *
 *   STAGE 2: Re-ingest the same file (isOverwrite=true)
 *     ✓ Still exactly ONE summary file (no duplicate)
 *     ✓ Same author entity file still exists, if one was found in stage 1
 *       (no -2 suffix or hyphen variant)
 *     ✓ Entity page Related section has merged bullets (not doubled)
 *     ✓ index.md has no duplicate rows
 *
 * Exit code 0 on green (including a clean self-skip); non-zero on failure.
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

// ── Self-skip: this suite needs a locally-supplied schema + article ─────────
// Same contract every other LIVE suite uses for a missing API key — checked
// FIRST, before any tempdir/filesystem work, so a bare `node
// scripts/test-ingest-real-llm.js` with nothing configured is a clean no-op.
const SCHEMA_PATH = process.env.CURATOR_LIVE_SCHEMA;
const ARTICLE_PATH = process.env.CURATOR_LIVE_ARTICLE;
if (!SCHEMA_PATH || !ARTICLE_PATH) {
  console.log('SKIP: this suite needs a local source document to ingest.');
  console.log('  Set CURATOR_LIVE_SCHEMA (path to a domain CLAUDE.md schema file) and');
  console.log('  CURATOR_LIVE_ARTICLE (path to an .md/.txt/.pdf article to ingest) to run it.');
  console.log('  Self-skipping (live-suite convention) — this is not a failure.');
  process.exit(0);
}
if (!existsSync(SCHEMA_PATH)) {
  console.error(`FATAL: CURATOR_LIVE_SCHEMA points at a file that doesn't exist: ${SCHEMA_PATH}`);
  process.exit(1);
}
if (!existsSync(ARTICLE_PATH)) {
  console.error(`FATAL: CURATOR_LIVE_ARTICLE points at a file that doesn't exist: ${ARTICLE_PATH}`);
  process.exit(1);
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

// Copy the supplied CLAUDE.md schema so the test domain has a realistic one.
const testSchema = path.join(domainDir, 'CLAUDE.md');
copyFileSync(SCHEMA_PATH, testSchema);

// Empty index + log
writeFileSync(path.join(wikiDir, 'index.md'), '# Index\n\n| Page | Type | Summary |\n|---|---|---|\n');
writeFileSync(path.join(wikiDir, 'log.md'), '# Log\n\n');

// Copy the supplied article into raw/, keeping its own basename so
// SOURCE_ARTICLE_NAME reflects whatever the runner pointed us at.
const SOURCE_ARTICLE_NAME = path.basename(ARTICLE_PATH);
const articleInRaw = path.join(rawDir, SOURCE_ARTICLE_NAME);
copyFileSync(ARTICLE_PATH, articleInRaw);
console.log(`Source article: ${SOURCE_ARTICLE_NAME} (${(readFileSync(articleInRaw, 'utf8').length / 1024).toFixed(1)} KB)\n`);

// Pin the domains dir to our tempdir so the real config.js doesn't redirect us
// at any production wiki. CURATOR_TEST_DOMAINS_DIR beats config; plain
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
  const { ingestFile, computeSummarySlugFromSource, extractAuthorHints, slugifyName } = await import('../src/brain/ingest.js');

  // Expected canonical summary slug + path
  const expectedSlug = computeSummarySlugFromSource(SOURCE_ARTICLE_NAME);
  const expectedSummaryPath = `summaries/${expectedSlug}.md`;
  console.log(`Expected summary slug: ${expectedSlug}\n`);

  // Derive an expected author slug from the SOURCE ITSELF (frontmatter
  // `author:` field or a "By X" / "Author: X" byline) — never hardcoded, so
  // this assertion is meaningful for whatever article CURATOR_LIVE_ARTICLE
  // points at. Some articles carry no discoverable author hint at all; that
  // is a legitimate outcome, not a bug, and the affected assertions below
  // are skipped gracefully rather than failed.
  const sourceText = readFileSync(articleInRaw, 'utf8');
  const authorHints = extractAuthorHints(sourceText);
  const expectedAuthorSlug = authorHints.length > 0 ? slugifyName(authorHints[0]) : null;
  console.log(expectedAuthorSlug
    ? `Author hint found in source: "${authorHints[0]}" → expected slug "${expectedAuthorSlug}"\n`
    : `No author hint found in source — the author-entity assertions below will be skipped (not failed).\n`);

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
    // Count linked entities — should be > 5 (a real article usually mentions many)
    const linkedCount = (summaryContent.match(/\[\[[^\]]+\]\]/g) || []).length;
    assertTrue(linkedCount >= 5,
      `summary references >= 5 wikilinks (got ${linkedCount})`,
      `low link count suggests under-reporting bug`);
  }

  // 4. If the source names an author, an entity page for them was created.
  //    Skipped (not failed) when the source carries no discoverable author
  //    hint — that's a property of the article, not of the pipeline.
  let authorCandidates = [];
  if (expectedAuthorSlug) {
    authorCandidates = stage1Entities.filter(p => {
      const base = p.replace(/^entities\//, '').replace(/\.md$/, '');
      return base === expectedAuthorSlug || base.includes(expectedAuthorSlug) || expectedAuthorSlug.includes(base);
    });
    assertTrue(authorCandidates.length >= 1,
      `author entity created for the source's own byline (expected slug "${expectedAuthorSlug}")`,
      authorCandidates.length === 0 ? `no matching entity. Entities: ${stage1Entities.join(', ')}` : null);
  } else {
    console.log('  (skipped: no author hint in source — see note above)');
  }

  // 5. Reasonable entity coverage — at least 3 (a real article usually names several)
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
  //     and the author file (if one was found) should NOT have hyphen-variant
  //     duplicates.
  const entitiesOnDisk = readdirSync(path.join(wikiDir, 'entities')).filter(f => f.endsWith('.md'));
  let authorFilesOnDisk = [];
  if (expectedAuthorSlug) {
    authorFilesOnDisk = entitiesOnDisk.filter(f => {
      const base = f.replace(/\.md$/, '');
      return base === expectedAuthorSlug || base.includes(expectedAuthorSlug) || expectedAuthorSlug.includes(base);
    });
    assertEq(authorFilesOnDisk.length, 1,
      'exactly one author entity file on disk (no hyphen variants)');
  }

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
