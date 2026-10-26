#!/usr/bin/env node
/**
 * test-ingest-index-budget.js — v3.83.0 (CONTRACT §1.1, §7 P1).
 *
 * WHY. index.md is pasted into the ingest OUTLINE and SINGLE-PASS prompts. A
 * complete index (Health's rebuild + drift prevention) on a 3,500-page domain
 * is ~600 KB ≈ 200k tokens at the 3 chars/token ingest budgets for it — over
 * Haiku 4.5's 200k window by itself. So the builders cap the embedded index at
 * INDEX_PROMPT_BUDGET_CHARS through indexForPrompt.
 *
 * Pinned:
 *   §1 AT OR UNDER the budget the index is embedded VERBATIM in both builders —
 *      the prompt equals the same prompt built around a short sentinel with the
 *      sentinel replaced by the index (so nothing else in the prompt depends on
 *      it, and no notice is appended). indexForPrompt returns the SAME string.
 *   §2 OVER the budget (a synthetic ~450 KB index): in BOTH builders the
 *      embedded index is ≤ budget including its notice, its rows are a
 *      subsequence of the original in original order, every non-row line is
 *      kept, the most source-relevant row survives, and two calls agree.
 *   §3 the batch-queue estimate prices exactly the capped prompt the builders
 *      produce (estimate and ingest agree), and is below what the uncapped index
 *      would have cost.
 *   §4 the Phase 2 batch prompt carries no index: its cacheable prefix is the
 *      same whatever the index is, and byte-stable across batches.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let passed = 0, failed = 0;
const failures = [];
function ok(cond, label, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; failures.push(label); console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + String(detail).slice(0, 400) : ''}`); }
}

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'curator-index-budget-'));
const USER_DATA = path.join(TMP_ROOT, 'userdata');
const DOMAINS = path.join(TMP_ROOT, 'domains');
mkdirSync(USER_DATA, { recursive: true });
mkdirSync(DOMAINS, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DATA;
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS;

const ingest = await import('../src/brain/ingest.js');
const { INDEX_PROMPT_BUDGET_CHARS, indexForPrompt, __testing: T } = ingest;
const { buildOutlinePrompt, buildPrompt, buildBatchPromptParts } = T;
const queue = await import('../src/brain/ingest-queue.js');
const { __setDomainsDirOverride } = await import('../src/brain/config.js');
__setDomainsDirOverride(DOMAINS);

const today = '2026-10-26';
const files = { entities: ['acme-robotics.md', 'jane-doe.md'], concepts: ['world-model.md', 'reward-shaping.md'] };
const SOURCE = 'Jane Doe of Acme Robotics explains world models and the quantum lattice gearbox in detail. '.repeat(30);

/** Both builders, the same arguments, a given index. */
const outline = (idx, text = SOURCE) => buildOutlinePrompt(today, idx, files, 'note.md', text, false, 'summaries/note.md');
const single = (idx, text = SOURCE) => buildPrompt(today, idx, files, 'note.md', text, false, false, 'summaries/note.md');
/** The index text exactly as embedded in a prompt (between its two markers). */
function embedded(prompt) {
  const a = prompt.indexOf('Current wiki index:\n');
  const b = prompt.indexOf('\n\n--- SOURCE DOCUMENT:');
  return a < 0 || b < 0 ? null : prompt.slice(a + 'Current wiki index:\n'.length, b);
}

function bigIndex(rowsWanted, descLen) {
  const head = '# Wiki Index — Budget\nLast updated: 2026-01-01\n\nSome preamble prose that must survive.\n\n## Summaries\n\n| Page | Type | Summary |\n|------|------|---------|';
  const rows = [];
  for (let i = 0; i < rowsWanted; i++) {
    rows.push(`| [[filler-topic-${String(i).padStart(5, '0')}]] | concept | ${'unrelated filler words about gardening and pottery '.repeat(Math.ceil(descLen / 50)).slice(0, descLen)} |`);
  }
  // The ONE row this source is about — buried in the middle.
  rows.splice(Math.floor(rows.length / 2), 0, '| [[quantum-lattice-gearbox]] | concept | The quantum lattice gearbox explained |');
  return head + '\n' + rows.join('\n') + '\n\n## Notes\n\nA prose block at the end.\n';
}

try {
  // ═══════════════════════════════════════════════════════════════════════
  console.log(`\n§1  at or under ${INDEX_PROMPT_BUDGET_CHARS.toLocaleString()} chars the index is embedded verbatim`);
  ok(INDEX_PROMPT_BUDGET_CHARS === 150_000, 'INDEX_PROMPT_BUDGET_CHARS is 150,000 (just above today\'s largest real index, 146,744)');
  const SENTINEL = '\u0001SENTINEL\u0001';
  const sizes = [
    ['a small index', '# Wiki Index\n\n| Page | Type | Summary |\n|---|---|---|\n| [[jane-doe]] | entity | Jane |\n'],
    ['an index exactly AT the budget', null],
    ['an empty index', ''],
  ];
  {
    const base = '# Wiki Index\n\n| Page | Type | Summary |\n|---|---|---|\n';
    let t = base;
    while (t.length < INDEX_PROMPT_BUDGET_CHARS) t += `| [[r-${t.length}]] | concept | ${'d'.repeat(80)} |\n`;
    sizes[1][1] = t.slice(0, INDEX_PROMPT_BUDGET_CHARS);
  }
  ok(sizes[1][1].length === INDEX_PROMPT_BUDGET_CHARS, 'PRECONDITION — the at-budget fixture is exactly the budget long');
  for (const [label, idx] of sizes) {
    const r = indexForPrompt(idx, SOURCE);
    ok(r.text === idx && r.truncated === false, `${label}: indexForPrompt returns the SAME string, truncated:false`);
    for (const [name, build] of [['outline', outline], ['single-pass', single]]) {
      const real = build(idx);
      if (idx === '') {
        ok(real === build(SENTINEL).replace(SENTINEL, '(empty — this is the first ingest)'),
          `${label} → ${name}: the first-ingest placeholder, exactly as before`);
      } else {
        ok(real === build(SENTINEL).replace(SENTINEL, () => idx),
          `★ ${label} → ${name} prompt is byte-identical to the template with the index substituted verbatim (no notice, nothing else changed)`);
      }
    }
  }
  ok(indexForPrompt(undefined, SOURCE).text === '' && single(undefined).includes('(empty — this is the first ingest)'),
    'a missing index (undefined) renders the first-ingest placeholder, as before');

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n§2  over the budget — capped, relevant rows kept, a subsequence in original order');
  const BIG = bigIndex(800, 540);
  ok(BIG.length > 400_000, `PRECONDITION — the fixture index is ~450 KB (${BIG.length} chars)`);
  const origLines = BIG.split('\n');
  for (const [name, build] of [['outline', outline], ['single-pass', single]]) {
    const prompt = build(BIG);
    const emb = embedded(prompt);
    ok(emb !== null && emb.length <= INDEX_PROMPT_BUDGET_CHARS,
      `★ ${name}: the embedded index is ≤ ${INDEX_PROMPT_BUDGET_CHARS.toLocaleString()} chars, notice included (${emb && emb.length})`);
    const lines = emb.split('\n');
    const notice = lines.pop();
    ok(/^\(Index shortened for this prompt: \d+ of 801 pages, those most related to this source\. Every existing entity and concept filename is listed above\.\)$/.test(notice),
      `${name}: the last line is the shortening notice with kept/total`, notice);
    // Subsequence of the original, in original order.
    let j = 0, isSub = true;
    for (const l of lines) {
      while (j < origLines.length && origLines[j] !== l) j++;
      if (j >= origLines.length) { isSub = false; break; }
      j++;
    }
    ok(isSub, `★ ${name}: every kept line is an original line, in original order (a subsequence)`);
    const nonRows = origLines.filter((l) => l.trim() && !/^\|\s*\[\[/.test(l));
    ok(nonRows.every((l) => lines.includes(l)), `${name}: every non-row line (title, date, prose, headings, table header) is kept`);
    ok(lines.includes('| [[quantum-lattice-gearbox]] | concept | The quantum lattice gearbox explained |'),
      `★ ${name}: the row most related to the source survives the cap`);
    ok(prompt.includes('Existing concept files:\n  concepts/world-model.md'), `${name}: the full slug inventory is untouched by the cap`);
    ok(build(BIG) === prompt, `${name}: deterministic — the same call twice is identical`);
  }
  {
    const r = indexForPrompt(BIG, SOURCE);
    ok(r.truncated === true && r.total === 801 && r.kept > 0 && r.kept < 801, 'indexForPrompt reports kept/total', JSON.stringify({ kept: r.kept, total: r.total }));
    const tight = indexForPrompt(BIG, SOURCE, 2_000);
    ok(tight.text.length <= 2_000, 'a tiny budget is still respected exactly', tight.text.length);
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n§3  the batch-queue estimate prices the capped prompt (estimate and ingest agree)');
  {
    const D = 'budget';
    const dd = path.join(DOMAINS, D);
    for (const s of ['wiki/entities', 'wiki/concepts', 'wiki/summaries', 'raw']) mkdirSync(path.join(dd, s), { recursive: true });
    writeFileSync(path.join(dd, 'CLAUDE.md'), '# Domain: Budget\n');
    writeFileSync(path.join(dd, 'wiki', 'index.md'), BIG);
    for (const f of files.entities) writeFileSync(path.join(dd, 'wiki', 'entities', f), '# E\n');
    for (const f of files.concepts) writeFileSync(path.join(dd, 'wiki', 'concepts', f), '# C\n');
    const { estimateOneFile } = queue.__testing;
    const { CHARS_PER_TOKEN } = queue;
    for (const size of [5_000, 60_000]) {
      const f = { name: 'doc.md', size };
      const est = estimateOneFile({ f, promptFiles: files, index: BIG, today, price: null });
      const text = 'x'.repeat(size);
      let expectChars;
      if (est.mode === 'single-pass') expectChars = buildPrompt(today, BIG, files, 'doc.md', text, false, false, 'summaries/estimate-placeholder.md').length;
      else {
        const parts = buildBatchPromptParts(today, 'doc.md', text, [], files, []);
        const { numBatches } = queue.__testing.estimateCallCounts(size);
        expectChars = buildOutlinePrompt(today, BIG, files, 'doc.md', text, false, 'summaries/estimate-placeholder.md').length
          + numBatches * (parts.prefix.length + parts.suffix.length);
      }
      ok(est.inputTokens === Math.round(expectChars / CHARS_PER_TOKEN),
        `★ ${est.mode} (${size} chars): the estimate's input tokens equal the builders' capped prompt / CHARS_PER_TOKEN`, `${est.inputTokens} vs ${Math.round(expectChars / CHARS_PER_TOKEN)}`);
      const uncappedExtra = (BIG.length - INDEX_PROMPT_BUDGET_CHARS) / CHARS_PER_TOKEN;
      ok(est.inputTokens + uncappedExtra * 0.9 < Math.round((expectChars + BIG.length) / CHARS_PER_TOKEN),
        `${est.mode}: …which is well below what the uncapped ~450 KB index would have priced (dumb cross-check)`);
    }
    // The public entry point too, over the real domain on disk.
    const full = await queue.estimateIngestQueueCost(D, [{ name: 'doc.md', size: 5_000 }]);
    const direct = estimateOneFile({ f: { name: 'doc.md', size: 5_000 }, promptFiles: files, index: BIG,
      today: new Date().toISOString().slice(0, 10), price: null }).inputTokens;
    ok(full && full.ok && full.estimate && full.estimate.inputTokensLow === direct,
      'estimateIngestQueueCost (reading index.md from disk) quotes the same capped figure',
      JSON.stringify(full && full.estimate && full.estimate.inputTokensLow) + ' vs ' + direct);
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n§4  the Phase 2 batch prompt carries no index — its cacheable prefix cannot change');
  {
    const pages = [{ path: 'concepts/world-model.md', summary: 'w' }, { path: 'entities/jane-doe.md', summary: 'j' }];
    const p1 = buildBatchPromptParts(today, 'note.md', SOURCE, [pages[0]], files, pages);
    const p2 = buildBatchPromptParts(today, 'note.md', SOURCE, [pages[1]], files, pages);
    ok(p1.prefix === p2.prefix, 'the prefix is byte-identical across batches of one ingest');
    ok(!p1.prefix.includes('Current wiki index') && !p1.prefix.includes('filler-topic-') && !(p1.prefix + p1.suffix).includes('quantum-lattice-gearbox]]'),
      'neither part carries index content');
  }
} finally {
  __setDomainsDirOverride(null);
  rmSync(TMP_ROOT, { recursive: true, force: true });
}

console.log(`\nPassed: ${passed}   Failed: ${failed}`);
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
