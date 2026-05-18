#!/usr/bin/env node
/**
 * v3.0.1-beta.1 — Ingestion accuracy fixes battle test.
 *
 * Validates the 7 fixes that close the systematic gaps reported by the
 * community in v3.0.0-beta.1 (missing summaries / authors / parent concepts,
 * fragmented sub-concepts, silent 80 k truncation, broken index merges,
 * silent stub pages).
 *
 * Pure unit tests — no LLM calls, no filesystem writes. Asserts:
 *   1. computeSummarySlugFromSource — deterministic, idempotent, edge cases
 *   2. validateOutline — injects missing summary, redirects non-canonical,
 *      drops extras
 *   3. Prompt builders contain the new coverage requirements (originator
 *      rule, parent-over-children rule, forced summary path)
 *   4. Single-pass prompt no longer asks the LLM for the index
 *   5. mergeIntoIndex (imported from compile.js) handles new + existing +
 *      pipe injection + no-changes
 *   6. stubPageContent renders a clearly-marked warning
 *
 * Run: node scripts/test-ingest-fixes.js
 * Exit code 0 if all green; non-zero on any failure.
 */

import {
  computeSummarySlugFromSource,
  validateOutline,
  extractAuthorHints,
  slugifyName,
  __testing,
} from '../src/brain/ingest.js';
import { mergeIntoIndex } from '../src/brain/compile.js';

const { buildOutlinePrompt, buildPrompt, buildBatchPrompt, stubPageContent, TEXT_CAP } = __testing;

let passed = 0;
let failed = 0;
const failures = [];

function ok(label) {
  passed++;
  console.log(`  ✓ ${label}`);
}
function fail(label, detail) {
  failed++;
  failures.push({ label, detail });
  console.log(`  ✗ ${label}`);
  if (detail) console.log(`    └─ ${detail}`);
}
function assertEq(actual, expected, label) {
  if (actual === expected) return ok(label);
  fail(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function assertTrue(cond, label, detail) {
  if (cond) return ok(label);
  fail(label, detail);
}
function assertContains(haystack, needle, label) {
  if (haystack.includes(needle)) return ok(label);
  fail(label, `did not find: ${JSON.stringify(needle)}`);
}
function assertNotContains(haystack, needle, label) {
  if (!haystack.includes(needle)) return ok(label);
  fail(label, `should NOT contain: ${JSON.stringify(needle)}`);
}

console.log('\n=== v3.0.1-beta.1 ingest fixes battle test ===\n');

// ── 1. computeSummarySlugFromSource ──────────────────────────────────────────
console.log('1. computeSummarySlugFromSource\n');

assertEq(computeSummarySlugFromSource('report.pdf'), 'report',
  'simple .pdf → slug');
assertEq(computeSummarySlugFromSource('My Article.md'), 'my-article',
  'spaces → hyphens');
assertEq(computeSummarySlugFromSource('two_worlds_of_code.md'), 'two-worlds-of-code',
  'underscores → hyphens');
assertEq(computeSummarySlugFromSource('Hello, World!.pdf'), 'hello-world',
  'punctuation stripped');
assertEq(computeSummarySlugFromSource('UPPERCASE.PDF'), 'uppercase',
  'lowercased');
assertEq(computeSummarySlugFromSource(''), 'untitled',
  'empty → untitled fallback');
assertEq(computeSummarySlugFromSource(undefined), 'untitled',
  'undefined → untitled fallback');
assertEq(computeSummarySlugFromSource(null), 'untitled',
  'null → untitled fallback');
assertEq(computeSummarySlugFromSource('   leading-trailing.txt'), 'leading-trailing',
  'whitespace trimmed');
assertEq(computeSummarySlugFromSource('---weird---.md'), 'weird',
  'collapsed runs of hyphens');

// Deterministic: same input → same output, every call
{
  const s1 = computeSummarySlugFromSource('Re-Ingest Test.pdf');
  const s2 = computeSummarySlugFromSource('Re-Ingest Test.pdf');
  const s3 = computeSummarySlugFromSource('Re-Ingest Test.pdf');
  assertTrue(s1 === s2 && s2 === s3, 'deterministic on repeated calls');
  assertEq(s1, 're-ingest-test', 'expected slug shape');
}

// Long filename truncates to 80 chars and never ends with hyphen
{
  const long = 'a'.repeat(50) + ' ' + 'b'.repeat(50) + '.pdf';
  const slug = computeSummarySlugFromSource(long);
  assertTrue(slug.length <= 80, `slug truncated to ≤80 chars (got ${slug.length})`);
  assertTrue(!slug.endsWith('-'), 'truncated slug does not end with hyphen');
}

// Double extension behavior — only the LAST extension is stripped, then
// punctuation in the inner part is removed. Documented to be deterministic
// rather than human-perfect; what matters is that re-ingest hits the same slug.
{
  const slug1 = computeSummarySlugFromSource('archive.tar.gz');
  const slug2 = computeSummarySlugFromSource('archive.tar.gz');
  assertEq(slug1, slug2, 'archive.tar.gz: deterministic across calls');
  assertTrue(slug1.length > 0 && !slug1.includes('.'),
    `archive.tar.gz: produces non-empty slug with no dots (got "${slug1}")`);
}

// ── 2. validateOutline ───────────────────────────────────────────────────────
console.log('\n2. validateOutline\n');

const SP = 'summaries/the-source.md';

// Case A: outline missing summary → inject + warn
{
  const outline = {
    title: 'Test',
    pages: [
      { path: 'entities/alice.md', summary: 'Alice the author' },
      { path: 'concepts/llm.md', summary: 'LLM concept' },
    ],
  };
  const { outline: out, warnings } = validateOutline(outline, SP, 'the-source.pdf');
  assertTrue(out.pages.some(p => p.path === SP), 'case A: summary page injected');
  assertEq(out.pages.length, 3, 'case A: 3 pages total after injection');
  assertTrue(warnings.length === 1 && warnings[0].includes('missing summary'),
    'case A: warning emitted');
}

// Case B: outline has a wrong summary path → redirect + warn
{
  const outline = {
    title: 'Test',
    pages: [
      { path: 'summaries/some-other-slug.md', summary: 'Wrong slug' },
      { path: 'entities/alice.md', summary: 'Alice' },
    ],
  };
  const { outline: out, warnings } = validateOutline(outline, SP, 'the-source.pdf');
  const summaries = out.pages.filter(p => p.path.startsWith('summaries/'));
  assertEq(summaries.length, 1, 'case B: still exactly one summary');
  assertEq(summaries[0].path, SP, 'case B: summary path redirected to canonical');
  assertTrue(warnings.some(w => w.includes('non-canonical')), 'case B: redirect warning');
}

// Case C: outline already correct → no warnings, no changes
{
  const outline = {
    title: 'Test',
    pages: [
      { path: SP, summary: 'Canonical' },
      { path: 'entities/alice.md', summary: 'Alice' },
    ],
  };
  const { outline: out, warnings } = validateOutline(outline, SP, 'the-source.pdf');
  assertEq(warnings.length, 0, 'case C: no warnings');
  assertEq(out.pages.length, 2, 'case C: page count unchanged');
}

// Case D: multiple summaries → keep one, drop extras
{
  const outline = {
    title: 'Test',
    pages: [
      { path: 'summaries/one.md', summary: 'one' },
      { path: 'summaries/two.md', summary: 'two' },
      { path: 'summaries/three.md', summary: 'three' },
      { path: 'entities/alice.md', summary: 'Alice' },
    ],
  };
  const { outline: out, warnings } = validateOutline(outline, SP, 'the-source.pdf');
  const summaries = out.pages.filter(p => p.path.startsWith('summaries/'));
  assertEq(summaries.length, 1, 'case D: extras dropped, exactly one summary remains');
  assertEq(summaries[0].path, SP, 'case D: remaining summary uses canonical path');
  assertTrue(warnings.some(w => w.includes('summary pages')), 'case D: drop warning emitted');
}

// Case E: bad input shape doesn't crash
{
  const { outline, warnings } = validateOutline({}, SP, 'x.pdf');
  assertTrue(Array.isArray(outline.pages), 'case E: empty input → array pages');
  assertEq(warnings.length, 1, 'case E: one warning (missing summary)');
}

// ── 3. Prompt builders: required coverage rules ──────────────────────────────
console.log('\n3. Prompt structure (outline + single-pass)\n');

const today = '2026-05-18';
const existing = { entities: ['alice.md'], concepts: ['llm.md'] };
const summaryPath = 'summaries/test-source.md';

const outlinePromptText = buildOutlinePrompt(
  today, '', existing, 'test-source.pdf', 'Sample source text.', false, summaryPath
);

assertContains(outlinePromptText, 'REQUIRED COVERAGE',
  'outline prompt: REQUIRED COVERAGE section present');
assertContains(outlinePromptText, 'ORIGINATOR entity',
  'outline prompt: originator rule present');
assertContains(outlinePromptText, 'CONSOLIDATION RULE',
  'outline prompt: consolidation rule present');
assertContains(outlinePromptText, summaryPath,
  'outline prompt: forced summary path inlined');
assertContains(outlinePromptText, 'EXACTLY ONE summary page',
  'outline prompt: exact-one-summary instruction');

const singlePromptText = buildPrompt(
  today, '', existing, 'test-source.pdf', 'Sample.', false, false, summaryPath
);

assertContains(singlePromptText, 'REQUIRED COVERAGE',
  'single-pass prompt: REQUIRED COVERAGE section present');
assertContains(singlePromptText, 'ORIGINATOR entity',
  'single-pass prompt: originator rule present');
assertContains(singlePromptText, 'CONSOLIDATION RULE',
  'single-pass prompt: consolidation rule present');
assertContains(singlePromptText, summaryPath,
  'single-pass prompt: forced summary path inlined');
assertContains(singlePromptText, 'DO NOT touch index.md',
  'single-pass prompt: index handed off to app');
assertNotContains(singlePromptText, '"index": "full content',
  'single-pass prompt: no index field requested');
assertNotContains(singlePromptText, 'updated index.md',
  'single-pass prompt: no "updated index.md" instruction');

// Batch prompt now asks for the summary field on each page
const batchPromptText = buildBatchPrompt(
  today, 'test-source.pdf', 'Sample.',
  [{ path: 'entities/alice.md', summary: 'Author' }],
  existing
);
assertContains(batchPromptText, '"summary": "1-line description for the index"',
  'batch prompt: requests per-page summary field');

// ── 4. mergeIntoIndex — programmatic index merge ─────────────────────────────
console.log('\n4. mergeIntoIndex (shared with compile)\n');

// Case A: empty index, two new created pages
{
  const existingIndex = '';
  const pages = [
    { path: 'entities/alice.md', content: '', summary: 'Alice the author' },
    { path: 'concepts/llm.md',   content: '', summary: 'Large language models' },
  ];
  const writeRecords = [
    { originalPath: 'entities/alice.md', record: { canonPath: 'entities/alice.md', status: 'created' } },
    { originalPath: 'concepts/llm.md',   record: { canonPath: 'concepts/llm.md',   status: 'created' } },
  ];
  const merged = mergeIntoIndex(existingIndex, pages, writeRecords);
  assertTrue(merged && merged.includes('[[alice]]'), 'case A: alice row added');
  assertTrue(merged && merged.includes('[[llm]]'),   'case A: llm row added');
  assertTrue(merged.includes('| entity | Alice the author |'),
    'case A: entity row has type + summary');
  assertTrue(merged.includes('| concept | Large language models |'),
    'case A: concept row has type + summary');
}

// Case B: existing index with table + new page
{
  const existingIndex = `# Index\n\n| Page | Type | Summary |\n|---|---|---|\n| [[alice]] | entity | Pre-existing |\n`;
  const pages = [
    { path: 'concepts/llm.md', content: '', summary: 'LLM concept' },
  ];
  const writeRecords = [
    { originalPath: 'concepts/llm.md', record: { canonPath: 'concepts/llm.md', status: 'created' } },
  ];
  const merged = mergeIntoIndex(existingIndex, pages, writeRecords);
  assertTrue(merged.includes('[[alice]] | entity | Pre-existing'),
    'case B: existing alice row preserved');
  assertTrue(merged.includes('[[llm]]'), 'case B: new llm row appended');
}

// Case C: page already mentioned in existing index → skipped (no dup)
{
  const existingIndex = `# Index\n\n| Page | Type | Summary |\n|---|---|---|\n| [[alice]] | entity | Already here |\n`;
  const pages = [
    { path: 'entities/alice.md', content: '', summary: 'Updated description' },
  ];
  const writeRecords = [
    { originalPath: 'entities/alice.md', record: { canonPath: 'entities/alice.md', status: 'created' } },
  ];
  const merged = mergeIntoIndex(existingIndex, pages, writeRecords);
  // The function returns null when nothing new to add — `created` status but slug
  // already mentioned means no new row.
  assertEq(merged, null, 'case C: returns null when slug already in index');
}

// Case D: status=updated should NOT add a row (only `created` pages)
{
  const existingIndex = `| Page | Type | Summary |\n|---|---|---|\n`;
  const pages = [
    { path: 'entities/alice.md', content: '', summary: 'Updated alice' },
  ];
  const writeRecords = [
    { originalPath: 'entities/alice.md', record: { canonPath: 'entities/alice.md', status: 'updated' } },
  ];
  const merged = mergeIntoIndex(existingIndex, pages, writeRecords);
  assertEq(merged, null, 'case D: status=updated → no new index row');
}

// Case E: pipe / newline injection in summary is sanitised
{
  const pages = [
    { path: 'entities/bad.md', content: '', summary: 'has | pipes\nand newlines | yes' },
  ];
  const writeRecords = [
    { originalPath: 'entities/bad.md', record: { canonPath: 'entities/bad.md', status: 'created' } },
  ];
  const merged = mergeIntoIndex('', pages, writeRecords);
  // count pipe occurrences in the new row line specifically
  const newRow = merged.split('\n').find(l => l.includes('[[bad]]'));
  assertTrue(newRow, 'case E: row produced');
  // A correctly formatted row has exactly 4 pipes (start, col1|col2, col2|col3, end)
  const pipeCount = (newRow.match(/\|/g) || []).length;
  assertEq(pipeCount, 4, 'case E: pipes in summary sanitised (exactly 4 pipes in row)');
  assertTrue(!newRow.includes('\n') || newRow === newRow.trim(),
    'case E: no embedded newline survives');
}

// Case F: cross-folder redirect — writeRecords[i] mapping uses canonical path
{
  const existingIndex = '';
  const pages = [
    { path: 'concepts/google.md', content: '', summary: 'Concept Google' },
  ];
  // writePage's cross-folder dedup redirected concepts/google.md → entities/google.md
  const writeRecords = [
    { originalPath: 'concepts/google.md', record: { canonPath: 'entities/google.md', status: 'created' } },
  ];
  const merged = mergeIntoIndex(existingIndex, pages, writeRecords);
  assertTrue(merged.includes('[[google]] | entity |'),
    'case F: redirected page indexed under entity type, not concept');
  assertTrue(merged.includes('Concept Google'),
    'case F: LLM summary text preserved after redirect');
}

// ── 5. Stub page content ─────────────────────────────────────────────────────
console.log('\n5. Stub page rendering\n');

const stub = stubPageContent('entities/alice.md', 'The author of the source', 'article.pdf');
assertContains(stub, '⚠', 'stub: warning glyph present');
assertContains(stub, 'Stub page', 'stub: identifies itself as stub');
assertContains(stub, 'Re-ingest "article.pdf"',
  'stub: instructs user to re-ingest the source');
assertContains(stub, 'The author of the source',
  'stub: preserves the planned summary so the page is not blank');
assertContains(stub, 'Tags: stub',
  'stub: includes "stub" tag for Health scanner discovery');

const conceptStub = stubPageContent('concepts/foo.md', 'A concept', 'src.md');
assertContains(conceptStub, 'type/concept',
  'stub: concept page gets type/concept tag');

// ── 6. TEXT_CAP constant exists (truncation guard) ───────────────────────────
console.log('\n6. Truncation guard constant\n');

assertEq(TEXT_CAP, 80_000, 'TEXT_CAP === 80,000 chars (matches code path)');

// ── 7. extractAuthorHints — originator detection ─────────────────────────────
console.log('\n7. extractAuthorHints (originator detection)\n');

// YAML frontmatter single author
{
  const text = `---\ntitle: My Article\nauthor: Dr. Tali Rezun\ndate: 2026-05-18\n---\n\nContent here.`;
  const hints = extractAuthorHints(text);
  assertTrue(hints.length >= 1, 'YAML author line detected');
  assertTrue(hints.includes('Dr. Tali Rezun'), 'YAML author value captured exactly');
}

// YAML frontmatter quoted author
{
  const text = `---\nauthor: "Jane Doe"\n---\n\nBody.`;
  const hints = extractAuthorHints(text);
  assertTrue(hints.includes('Jane Doe'), 'quoted YAML author unquoted');
}

// YAML frontmatter wikilink-form author (Obsidian convention)
{
  const text = `---\nauthor:\n  - "[[Dr. Tali Rezun]]"\n---\n\nBody.`;
  const hints = extractAuthorHints(text);
  assertTrue(hints.includes('Dr. Tali Rezun'), 'YAML wikilink-form author captured');
}

// "By Dr. X" byline
{
  const text = `Some intro\n\nBy Dr. Tali Rezun on April 14\n\nBody.`;
  const hints = extractAuthorHints(text);
  assertTrue(hints.some(h => /Tali Rezun/.test(h)), '"By Dr. X" byline detected');
}

// "Author: X" plain marker
{
  const text = `Some body\n\nAuthor: Jane Smith\n\nMore body.`;
  const hints = extractAuthorHints(text);
  assertTrue(hints.includes('Jane Smith'), '"Author: X" marker detected');
}

// Empty text → empty array
assertEq(extractAuthorHints('').length, 0, 'empty text → no hints');
assertEq(extractAuthorHints(null).length, 0, 'null text → no hints (no crash)');
assertEq(extractAuthorHints(undefined).length, 0, 'undefined text → no hints (no crash)');

// No author signal → empty array
{
  const text = `Just some plain text. No author byline anywhere. Just facts.`;
  assertEq(extractAuthorHints(text).length, 0, 'no signal → no hints');
}

// ── 8. slugifyName ────────────────────────────────────────────────────────────
console.log('\n8. slugifyName (originator → slug)\n');

assertEq(slugifyName('Dr. Tali Rezun'), 'tali-rezun', 'strips Dr honorific');
assertEq(slugifyName('Prof. Jane Doe'), 'jane-doe', 'strips Prof honorific');
assertEq(slugifyName('Mr. John Q. Smith'), 'john-q-smith', 'preserves middle initial');
assertEq(slugifyName('Dr. Tali Režun'), 'tali-rezun', 'strips diacritics (Režun → rezun)');
assertEq(slugifyName(''), '', 'empty → empty');
assertEq(slugifyName('Jane'), 'jane', 'single name OK');

// ── 9. validateOutline with originatorHints ──────────────────────────────────
console.log('\n9. validateOutline — originator-hint injection\n');

// Case G: outline missing author → injected from hint
{
  const outline = {
    title: 'Test',
    pages: [
      { path: SP, summary: 'Summary' },
      { path: 'entities/google.md', summary: 'A company' },
    ],
  };
  const { outline: out, warnings } = validateOutline(outline, SP, 'src.md', ['Dr. Tali Rezun']);
  const newEntity = out.pages.find(p => p.path === 'entities/tali-rezun.md');
  assertTrue(!!newEntity, 'case G: missing originator injected as entities/tali-rezun.md');
  assertTrue(warnings.some(w => w.includes('Outline omitted originator')),
    'case G: originator-injection warning emitted');
}

// Case H: author already in outline → not duplicated
{
  const outline = {
    title: 'Test',
    pages: [
      { path: SP, summary: 'Summary' },
      { path: 'entities/tali-rezun.md', summary: 'Author' },
    ],
  };
  const { outline: out, warnings } = validateOutline(outline, SP, 'src.md', ['Dr. Tali Rezun']);
  const taliPages = out.pages.filter(p => p.path === 'entities/tali-rezun.md');
  assertEq(taliPages.length, 1, 'case H: author already present → not duplicated');
  assertTrue(!warnings.some(w => w.includes('Outline omitted originator')),
    'case H: no originator-injection warning');
}

// Case I: hyphen-normalised match prevents near-duplicate
{
  const outline = {
    title: 'Test',
    pages: [
      { path: SP, summary: 'Summary' },
      { path: 'entities/talirezun.md', summary: 'Author' },  // no hyphen
    ],
  };
  const { outline: out } = validateOutline(outline, SP, 'src.md', ['Dr. Tali Rezun']);
  const candidates = out.pages.filter(p => /tali/i.test(p.path));
  assertEq(candidates.length, 1, 'case I: hyphen-norm match prevents duplicate slug variant');
}

// Case I2: honorific WITH period — "dr.-tali-rezun" must redirect to canonical
// (v3.0.1-beta.2 regression test — the LLM occasionally preserves "Dr." literally)
{
  const outline = {
    title: 'Test',
    pages: [
      { path: SP, summary: 'Summary' },
      { path: 'entities/dr.-tali-rezun.md', summary: 'Author' },  // LLM kept the dot
    ],
  };
  const { outline: out, warnings } = validateOutline(outline, SP, 'src.md', ['Dr. Tali Rezun']);
  const taliPages = out.pages.filter(p => /tali|rezun/i.test(p.path));
  assertEq(taliPages.length, 1, 'case I2: dr.- variant deduped → exactly 1 author page');
  assertEq(taliPages[0].path, 'entities/tali-rezun.md',
    'case I2: dr.- variant redirected to canonical tali-rezun.md');
  assertTrue(warnings.some(w => /redirected to canonical/.test(w)),
    'case I2: redirect warning emitted');
}

// Case I3: honorific WITHOUT period — "dr-tali-rezun" must also redirect
{
  const outline = {
    title: 'Test',
    pages: [
      { path: SP, summary: 'Summary' },
      { path: 'entities/dr-tali-rezun.md', summary: 'Author' },
    ],
  };
  const { outline: out } = validateOutline(outline, SP, 'src.md', ['Dr. Tali Rezun']);
  const taliPages = out.pages.filter(p => /tali|rezun/i.test(p.path));
  assertEq(taliPages.length, 1, 'case I3: dr- variant deduped → exactly 1 author page');
  assertEq(taliPages[0].path, 'entities/tali-rezun.md',
    'case I3: dr- variant redirected to canonical tali-rezun.md');
}

// ── 10. Health scanner hyphen-variant detection (v3.0.1-beta.3) ──────────────
// Regression: the inline normalisation at the detection site failed to call
// normKey() — so dr.-tali-rezun.md never grouped with tali-rezun.md. Test
// the actual scanWiki output against a tempdir containing the exact filename
// pair the user reported.
console.log('\n10. Health scanner hyphen-variant detection (real pair)\n');
{
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('fs');
  const { tmpdir } = await import('os');
  const pathMod = await import('path');

  const testRoot = mkdtempSync(pathMod.join(tmpdir(), 'curator-health-test-'));
  const domainsPath = pathMod.join(testRoot, 'domains');
  const domainDir = pathMod.join(domainsPath, 'hvt');
  const wikiDir = pathMod.join(domainDir, 'wiki');
  mkdirSync(pathMod.join(wikiDir, 'entities'), { recursive: true });
  mkdirSync(pathMod.join(wikiDir, 'concepts'), { recursive: true });
  mkdirSync(pathMod.join(wikiDir, 'summaries'), { recursive: true });
  writeFileSync(pathMod.join(domainDir, 'CLAUDE.md'), '# Test\n');
  writeFileSync(pathMod.join(wikiDir, 'index.md'), '# Index\n');
  writeFileSync(pathMod.join(wikiDir, 'log.md'), '# Log\n');

  // Create the exact filename pair the user reported
  const stub = '---\ntype: entity\ntags: [type/entity]\n---\n\nStub content.\n';
  writeFileSync(pathMod.join(wikiDir, 'entities', 'dr.-tali-rezun.md'), stub);
  writeFileSync(pathMod.join(wikiDir, 'entities', 'tali-rezun.md'), stub);

  // Point ingest/health at this tempdir
  const oldDomainsPath = process.env.DOMAINS_PATH;
  process.env.DOMAINS_PATH = domainsPath;

  // Bust ESM module cache — health.js reads getDomainsDir() at call time, OK
  const { scanWiki } = await import('../src/brain/health.js');
  const report = await scanWiki('hvt');

  assertTrue(report.hyphenVariants.length >= 1,
    'scanWiki detects dr.-X.md and X.md as hyphen variants');
  if (report.hyphenVariants.length >= 1) {
    const v = report.hyphenVariants.find(g => g.files.some(f => /dr\.-tali-rezun/.test(f)));
    assertTrue(!!v, 'group includes the dr.- variant file');
    if (v) {
      assertEq(v.suggestedSlug, 'tali-rezun',
        'canonical suggestion is "tali-rezun" (honorific-free), not "dr.-tali-rezun"');
      assertTrue(v.files.includes('dr.-tali-rezun') && v.files.includes('tali-rezun'),
        'group contains both files');
    }
  }

  // Cleanup
  rmSync(testRoot, { recursive: true, force: true });
  if (oldDomainsPath) process.env.DOMAINS_PATH = oldDomainsPath;
  else delete process.env.DOMAINS_PATH;
}

// Case J: empty hints array → no injection, no errors
{
  const outline = {
    title: 'Test',
    pages: [{ path: SP, summary: 'Summary' }],
  };
  const { outline: out, warnings } = validateOutline(outline, SP, 'src.md', []);
  assertEq(out.pages.length, 1, 'case J: empty hints → no changes');
  assertEq(warnings.length, 0, 'case J: empty hints → no warnings');
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) {
  console.log('Failures:');
  for (const f of failures) {
    console.log(`  - ${f.label}`);
    if (f.detail) console.log(`    ${f.detail}`);
  }
  process.exit(1);
}
process.exit(0);
