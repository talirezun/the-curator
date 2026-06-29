#!/usr/bin/env node
/**
 * v3.0.1-beta.25 — Fix #1: drop the full index.md from the compile prompt.
 *
 * OFFLINE, deterministic, no network. Asserts the contract of the rebuilt
 * buildCompilePrompt():
 *
 *   • The full wiki index is NO LONGER embedded in the prompt — this was the
 *     root cause of the "Gemini hit the output token limit (65536 tokens)"
 *     failure on Compile-to-Wiki for large domains: a tens-of-KB index table
 *     fed into the request pushed the model into a degeneration loop that
 *     filled the entire output budget.
 *   • The link-grounding inputs the LLM actually needs are STILL present:
 *     existing entity/concept filename lists, the forced summary path, the
 *     transcript, and the "do not touch index.md" guidance.
 *   • mergeIntoIndex (the programmatic index updater) is unchanged and still
 *     works — that is what keeps index.md correct after the LLM call.
 *
 * Run:  node scripts/test-beta25-compile-prompt.js
 * Exit: 0 if all green; non-zero on any failure.
 */

import { buildCompilePrompt, mergeIntoIndex } from '../src/brain/compile.js';

let passed = 0, failed = 0;
const failures = [];
function ok(cond, label) {
  cond ? (passed++, console.log(`  ✓ ${label}`)) : (failed++, failures.push(label), console.log(`  ✗ ${label}`));
}
function section(t) { console.log(`\n${t}`); }

// ── Fixture: a domain whose index is large and full of distinctive tokens, plus
//    distinct entity/concept filenames so we can tell prompt sections apart. ──
const BIG_INDEX_MARKER = 'ZZINDEXMARKER';
const bigIndexRows = Array.from({ length: 400 }, (_, i) =>
  `| [[entities/legacy-page-${i}]] | entity | ${BIG_INDEX_MARKER} description for legacy page number ${i} goes here with extra padding text |`
).join('\n');
const bigIndex = `# Index\n\n| Page | Type | Summary |\n|---|---|---|\n${bigIndexRows}\n`;

const existingFiles = {
  entities: ['acme-corp.md', 'jane-doe.md'],
  concepts: ['retrieval-augmented-generation.md'],
};

const conversation = {
  title: 'Why compiled knowledge beats RAG',
  messages: [
    { role: 'user', content: 'Explain UNIQUEUSERTOKEN why compiling beats retrieval.' },
    { role: 'assistant', content: 'UNIQUEASSISTANTTOKEN compiling pre-builds the graph.' },
  ],
};

const summaryPath = 'summaries/why-compiled-knowledge-beats-rag-2026-06-29-ab12.md';

// buildCompilePrompt's signature no longer accepts `index`. Pass it as an extra
// key anyway to prove that even if a caller leaks it, it cannot reach the prompt.
const prompt = buildCompilePrompt({
  today: '2026-06-29',
  index: bigIndex,            // deliberately passed — must be IGNORED
  existingFiles,
  conversation,
  summaryPath,
});

// ── 1. The index must NOT appear in the prompt ──────────────────────────────────
section('1. Full index is excluded from the compile prompt');
ok(!prompt.includes(BIG_INDEX_MARKER),
  'index row descriptions (ZZINDEXMARKER) do NOT appear in the prompt');
ok(!prompt.includes('legacy-page-200'),
  'index page slugs (legacy-page-200) do NOT appear in the prompt');
ok(!/current wiki index/i.test(prompt),
  'no "Current wiki index:" heading in the prompt');
// Sanity: the giant index would have dominated the prompt if present.
ok(prompt.length < bigIndex.length,
  `prompt (${prompt.length} chars) is far smaller than the index alone (${bigIndex.length} chars)`);

// ── 2. Link-grounding inputs ARE still present ──────────────────────────────────
section('2. Grounding inputs the LLM needs are retained');
ok(prompt.includes('entities/acme-corp.md'), 'existing entity filename acme-corp.md is present');
ok(prompt.includes('entities/jane-doe.md'), 'existing entity filename jane-doe.md is present');
ok(prompt.includes('concepts/retrieval-augmented-generation.md'),
  'existing concept filename retrieval-augmented-generation.md is present');
ok(prompt.includes(summaryPath), 'forced summary path is present');
ok(prompt.includes('UNIQUEUSERTOKEN') && prompt.includes('UNIQUEASSISTANTTOKEN'),
  'conversation transcript (both turns) is present');

// ── 3. Index-discipline guidance is intact ──────────────────────────────────────
section('3. "Do not touch index" guidance still in the prompt');
ok(/do not touch index\.md/i.test(prompt), 'prompt still tells the LLM not to touch index.md');
ok(/return only valid json/i.test(prompt), 'prompt still requires JSON-only output');

// ── 4. "none yet" path when a fresh domain has no entity/concept files ──────────
section('4. Fresh-domain prompt (no existing files) still builds');
const freshPrompt = buildCompilePrompt({
  today: '2026-06-29',
  existingFiles: { entities: [], concepts: [] },
  conversation,
  summaryPath,
});
ok(freshPrompt.includes('(none yet)'), 'empty entity/concept lists render as "(none yet)"');
ok(!/current wiki index/i.test(freshPrompt), 'fresh-domain prompt also omits the index');

// ── 5. mergeIntoIndex is untouched — index.md is still maintained programmatically
section('5. mergeIntoIndex still appends new rows correctly (regression guard)');
{
  const existingIndex = '# Index\n\n| Page | Type | Summary |\n|---|---|---|\n| [[old-thing]] | concept | pre-existing row |\n';
  const pages = [
    { path: 'concepts/new-concept.md', content: '...', summary: 'a brand new concept' },
  ];
  const writeRecords = [
    { originalPath: 'concepts/new-concept.md', record: { canonPath: 'concepts/new-concept.md', status: 'created' } },
  ];
  const merged = mergeIntoIndex(existingIndex, pages, writeRecords);
  ok(merged && merged.includes('[[new-concept]]'), 'new created page is appended to the index');
  ok(merged.includes('a brand new concept'), 'new page summary appears in the index row');
  ok(merged.includes('[[old-thing]]'), 'pre-existing index row is preserved');
}

// ── Report ──────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('All beta.25 compile-prompt assertions green.');
