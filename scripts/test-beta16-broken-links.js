#!/usr/bin/env node
/**
 * v3.0.1-beta.16 — Bulk AI broken-link fix, offline battle test.
 *
 * Covers the pure logic that decides each broken link's fate:
 *   1. buildLinkResolver — the deterministic (free) pre-pass: slugify spaces,
 *      strip `.md`, folder/honorific/article prefixes, hyphen-normalise.
 *   2. isLexicalVariant — the safety gate that keeps the AI from retargeting a
 *      genuinely-missing concept to a loosely-related page (the key quality fix).
 *   3. groupBrokenLinks — occurrence grouping by unique linkText.
 *
 * The destructive apply path + the live AI plan are covered by
 * test-beta16-production.js (real LLM, throwaway domain).
 *
 * Run: node scripts/test-beta16-broken-links.js   (exit 0 = all green)
 */

import { __testing } from '../src/brain/health-ai.js';
const { isLexicalVariant, buildLinkResolver, groupBrokenLinks, slugifyText } = __testing;

let passed = 0, failed = 0;
const failures = [];
function assert(cond, label, detail = '') { cond ? (passed++, console.log(`  ✓ ${label}`)) : (failed++, failures.push(`${label} — ${detail}`), console.log(`  ✗ ${label} — ${detail}`)); }

// ── 1. Deterministic resolver ─────────────────────────────────────────────────
console.log('\n1. buildLinkResolver — free formatting fixes');
{
  const resolve = buildLinkResolver(
    ['tali-rezun', 'openai', 'the-curator'],        // entities
    ['artificial-intelligence', 'machine-learning'], // concepts
    ['the-energy-and-water-footprint']               // summaries (bare)
  );
  assert(resolve('artificial intelligence') === 'artificial-intelligence', 'space → hyphen slug resolves');
  assert(resolve('tali-rezun.md') === 'tali-rezun', '.md suffix stripped + resolves');
  assert(resolve('The Curator') === 'the-curator', 'caps + space → existing slug');
  assert(resolve('concepts/machine-learning') === 'machine-learning', 'folder prefix stripped');
  assert(resolve('summaries/the-energy-and-water-footprint') === 'summaries/the-energy-and-water-footprint', 'summary prefixed link resolves');
  assert(resolve('energy-and-water-footprint') === 'summaries/the-energy-and-water-footprint', 'article-prefix-tolerant summary match');
  assert(resolve('Artificial Intelligence') === 'artificial-intelligence', 'mixed case resolves');
  assert(resolve('nonexistent-thing') === null, 'genuinely missing → null (no deterministic match)');
  assert(resolve('') === null, 'empty → null');
}

// ── 2. Lexical-variant gate ───────────────────────────────────────────────────
console.log('\n2. isLexicalVariant — only true same-page variants retarget');
{
  // TRUE variants (retarget allowed) — drawn from the real articles-domain run.
  assert(isLexicalVariant('rezun-tali', 'tali-rezun'), 'reordering is a variant');
  assert(isLexicalVariant('iot', 'iot-and-ai'), 'token-subset (acronym topic) is a variant');
  assert(isLexicalVariant('mcp', 'model-context-protocol-mcp'), 'acronym contained in target is a variant');
  assert(isLexicalVariant('big data', 'big-data-and-ai'), 'space-form + topic suffix is a variant');
  assert(isLexicalVariant('software-development-efficiency-enhancement', 'software-development-efficiency'), 'superset is a variant');
  assert(isLexicalVariant('NEO Cotruglian Triple Entry (NCTE)', 'neo-cotrugli-triple-entry-ncte'), 'caps/punctuation slugify + overlap is a variant');
  assert(isLexicalVariant('artificial-intelligence-defined', 'artificial-intelligence-definition'), 'jaccard ≥ 0.5 is a variant');

  // FALSE — different concepts that the LLM over-reached on (must strip, NOT retarget).
  assert(!isLexicalVariant('context-window', 'agent-memory'), 'context-window ≠ agent-memory (strip)');
  assert(!isLexicalVariant('big-data', 'ai-and-weather-forecasting-improvement'), 'big-data ≠ weather (strip)');
  assert(!isLexicalVariant('healthcare', 'ai-applications-in-medical-care'), 'healthcare ≠ medical-care page (strip)');
  assert(!isLexicalVariant('productivity', 'ai-as-a-force-multiplier'), 'productivity ≠ force-multiplier (strip)');
  assert(!isLexicalVariant('responsible-ai-development', 'agency-in-ai-development'), 'jaccard 0.4 < 0.5 → strip');

  // Single-token subset guard (audit M4): a short generic token must NOT match a
  // much longer slug, but a 3+ char acronym should.
  assert(!isLexicalVariant('ai', 'ai-and-weather-forecasting-improvement'), 'generic "ai" ⊄ long slug → strip (M4)');
  assert(!isLexicalVariant('ml', 'ml-ops-platform-comparison'), 'generic "ml" (2 chars) → strip (M4)');
  assert(isLexicalVariant('iot', 'iot-and-ai'), '"iot" (3 chars) still a variant');
  assert(isLexicalVariant('gpt', 'gpt-family-of-models'), '"gpt" (3 chars) still a variant');

  // Defensive
  assert(!isLexicalVariant('', 'tali-rezun'), 'empty broken → false');
  assert(!isLexicalVariant('foo', ''), 'empty target → false');
  assert(isLexicalVariant('summaries/the-paper', 'summaries/the-paper'), 'identical summary → variant');
}

// ── 3. Grouping ───────────────────────────────────────────────────────────────
console.log('\n3. groupBrokenLinks — occurrence grouping');
{
  const groups = groupBrokenLinks([
    { sourceFile: 'a.md', linkText: 'mcp' },
    { sourceFile: 'b.md', linkText: 'mcp' },
    { sourceFile: 'a.md', linkText: 'mcp' },     // same file repeat
    { sourceFile: 'c.md', linkText: 'rag' },
    { sourceFile: 'd.md', linkText: '' },         // empty → skipped
  ]);
  const mcp = groups.find(g => g.linkText === 'mcp');
  const rag = groups.find(g => g.linkText === 'rag');
  assert(groups.length === 2, 'two unique targets (empty skipped)', `got ${groups.length}`);
  assert(mcp.occurrences === 3, 'mcp counted 3 occurrences', `got ${mcp.occurrences}`);
  assert(mcp.sourceFiles.length === 2 && mcp.sourceFiles.includes('a.md') && mcp.sourceFiles.includes('b.md'), 'mcp source files deduped to 2');
  assert(rag.occurrences === 1, 'rag counted once');
}

// ── 4. slugifyText sanity ─────────────────────────────────────────────────────
console.log('\n4. slugifyText');
{
  assert(slugifyText('Artificial Intelligence') === 'artificial-intelligence', 'caps+space');
  assert(slugifyText('tali-rezun.md') === 'tali-rezun', '.md stripped');
  assert(slugifyText('NEO Cotruglian Triple Entry (NCTE)') === 'neo-cotruglian-triple-entry-ncte', 'punctuation removed');
  assert(slugifyText('a__b') === 'a-b', 'underscores → hyphen, collapsed');
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(48)}`);
console.log(`beta.16 offline: ${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:'); failures.forEach(f => console.log('  • ' + f)); process.exit(1); }
console.log('All green ✓');
