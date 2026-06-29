#!/usr/bin/env node
/**
 * v3.0.1-beta.25 — Fix #1: LIVE end-to-end proof against REAL Gemini.
 *
 * Replicates the production failure: Compile-to-Wiki on a domain with a LARGE
 * index.md used to feed that tens-of-KB table into the request, pushing Gemini
 * into a degeneration loop that filled the 65536-token output budget and failed
 * with "hit the output token limit". After Fix #1 the index is no longer sent,
 * so compile must succeed on a large-index domain.
 *
 * What this proves:
 *   • A throwaway domain seeded with a ~90 KB synthetic index (the size of the
 *     dev machine's real `articles` index) + real entity/concept files.
 *   • compileConversation() with real Gemini succeeds (ok=true), writes the
 *     summary + pages, updates index.md — with NO output-token-limit error.
 *   • Run N times (default 3) because degeneration is stochastic; the fix should
 *     make it pass every time.
 *   • Prints the prompt-size reduction (old-style WITH index vs new WITHOUT) so
 *     the mechanism is visible.
 *
 * Safety: isolates ALL domains into a tempdir via CURATOR_TEST_DOMAINS_DIR
 * (beats config), so the real domains/ folder is never touched. Forces the
 * Gemini provider via a backed-up/restored .curator-config.json.
 *
 * Run:  node scripts/test-beta25-compile-live.js
 * Exit: 0 if all green (or skipped for no key); non-zero on any failure.
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });

import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_FILE = path.join(ROOT, '.curator-config.json');

const DOMAINS_TMP = mkdtempSync(path.join(os.tmpdir(), 'curator-beta25-domains-'));
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS_TMP;
process.on('exit', () => { try { rmSync(DOMAINS_TMP, { recursive: true, force: true }); } catch {} });

let passed = 0, failed = 0;
const failures = [];
function ok(cond, label) {
  cond ? (passed++, console.log(`  ✓ ${label}`)) : (failed++, failures.push(label), console.log(`  ✗ ${label}`));
}
function section(t) { console.log(`\n${t}`); }

const ITERATIONS = 3;
const TOKEN_LIMIT_RE = /output token limit|hit the output token/i;

const cfgMod    = await import('../src/brain/config.js');
const files     = await import('../src/brain/files.js');
const compileMod = await import('../src/brain/compile.js');

// ── provider gate ───────────────────────────────────────────────────────────────
const geminiKey = cfgMod.getEffectiveKey('gemini');
if (!geminiKey) {
  console.log('\n⊘ No Gemini key configured — skipping live compile test (exit 0).');
  process.exit(0);
}

// Force gemini, back up config to restore byte-for-byte.
const cfgBackup = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, 'utf8') : null;
function forceGemini() {
  const cfg = existsSync(CONFIG_FILE) ? JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) : {};
  cfg.activeProvider = 'gemini';
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

const domain = 'zztest-beta25-largeindex';

try {
  forceGemini();
  ok(cfgMod.getActiveProvider() === 'gemini', 'provider forced to gemini');

  // ── Seed a throwaway domain with a LARGE index + real entity/concept files ──
  section('Seed: large-index domain (replicates the production failure trigger)');
  try { await files.deleteDomain(domain); } catch { /* none */ }
  await files.createDomain(domain, 'ZZ beta25 large index', 'Throwaway beta25 test', 'generic');

  // A ~90 KB index table, like the dev machine's real `articles` index (96 KB).
  const rows = Array.from({ length: 700 }, (_, i) =>
    `| [[entities/legacy-entity-${i}]] | entity | A previously-ingested entity number ${i} with a descriptive summary line of moderate length to pad the table realistically. |`
  ).join('\n');
  const bigIndex = `# Index\n\n| Page | Type | Summary |\n|---|---|---|\n${rows}\n`;
  await files.writePage(domain, 'index.md', bigIndex);
  const indexBytes = Buffer.byteLength(bigIndex, 'utf8');
  ok(indexBytes > 80_000, `seeded index is large (${(indexBytes / 1024).toFixed(0)} KB)`);

  // A few real entity/concept pages so link grounding has something to resolve.
  await files.writePage(domain, 'entities/openai.md', '# OpenAI\n\nType: company\nTags: ai, labs\n\n- Builds frontier models.\n');
  await files.writePage(domain, 'concepts/retrieval-augmented-generation.md', '# Retrieval-Augmented Generation\n\nTags: ai, retrieval\n\n- Fetches chunks at query time.\n');

  // ── Show the prompt-size mechanism (old WITH index vs new WITHOUT) ──
  section('Mechanism: prompt size old (with index) vs new (without)');
  const existingFiles = {
    entities: ['openai.md'],
    concepts: ['retrieval-augmented-generation.md'],
  };
  const sampleConv = {
    title: 'Compiled knowledge vs RAG',
    messages: [
      { role: 'user', content: 'Why does The Curator compile knowledge into a wiki instead of using RAG?' },
      { role: 'assistant', content: 'It integrates each source into persistent markdown pages so cross-references are pre-built and the whole wiki fits one context window; RAG re-derives structure on every query.' },
    ],
  };
  const newPrompt = compileMod.buildCompilePrompt({
    today: '2026-06-29', existingFiles, conversation: sampleConv,
    summaryPath: 'summaries/x-2026-06-29-abcd.md',
  });
  const oldPromptApproxBytes = Buffer.byteLength(newPrompt, 'utf8') + indexBytes; // index would have been appended
  console.log(`     new prompt: ${(Buffer.byteLength(newPrompt, 'utf8') / 1024).toFixed(1)} KB  ·  old (with index) ≈ ${(oldPromptApproxBytes / 1024).toFixed(1)} KB`);
  ok(!newPrompt.includes('legacy-entity-300'), 'new prompt does NOT contain the seeded index rows');

  // ── Run the real compile N times against live Gemini ──
  section(`Live compile × ${ITERATIONS} on the large-index domain (real Gemini)`);
  for (let i = 1; i <= ITERATIONS; i++) {
    // Distinct conversation each iteration (distinct content hash → distinct
    // summary slug → no idempotency refusal between runs).
    const convId = `00000000-0000-4000-8000-00000000b25${i}`;
    await files.writeConversation(domain, {
      id: convId,
      title: `Run ${i}: compiling vs retrieval`,
      createdAt: new Date().toISOString(),
      domain,
      messages: [
        { role: 'user', content: `Run ${i}: Explain why The Curator compiles knowledge into a persistent wiki instead of retrieval-augmented generation, and the main trade-offs. Mention OpenAI and RAG.` },
        { role: 'assistant', content: `On ingest The Curator integrates each source into persistent markdown pages, so cross-references between entities (like OpenAI) and concepts (like RAG) are pre-built and the whole wiki fits in one LLM context window. Retrieval-augmented generation instead fetches raw chunks at query time. Trade-off: compiling costs more up front and can lose nuance during synthesis, but retrieval re-derives structure on every query and cannot reason over the global graph.` },
      ],
    });

    let res, threw = null;
    try {
      res = await compileMod.compileConversation(domain, convId);
    } catch (e) {
      threw = e;
    }

    if (threw) {
      ok(!TOKEN_LIMIT_RE.test(threw.message || ''),
        `run ${i}: did NOT fail with an output-token-limit error`);
      ok(false, `run ${i}: compile threw: ${(threw.message || '').slice(0, 160)}`);
      continue;
    }

    ok(res.ok === true,
      `run ${i}: compile succeeded (ok=${res.ok}${res.error ? `, error="${String(res.error).slice(0, 120)}"` : ''}${res.reason ? `, reason="${res.reason}"` : ''})`);
    if (res.ok) {
      ok(Array.isArray(res.pagesWritten) && res.pagesWritten.length > 0,
        `run ${i}: wrote ${res.pagesWritten?.length || 0} pages`);
      ok(res.pagesWritten.some(p => p.startsWith('summaries/')),
        `run ${i}: produced the summary page`);
      // The error we are guarding against must never appear in res.error either.
      ok(!(res.error && TOKEN_LIMIT_RE.test(res.error)),
        `run ${i}: no output-token-limit error in result`);
    }
  }

  // ── index.md remained valid + grew (programmatic merge still works) ──
  section('index.md integrity after live compiles');
  const finalIndex = readFileSync(path.join(files.wikiPath(domain), 'index.md'), 'utf8');
  ok(finalIndex.includes('legacy-entity-0'), 'pre-seeded index rows are preserved (mergeIntoIndex non-destructive)');
  ok(finalIndex.includes('summaries/'), 'at least one new summary row was appended to the index');

} catch (e) {
  ok(false, `unexpected failure: ${(e.message || e)}`);
} finally {
  try { await files.deleteDomain(domain); } catch { /* best effort */ }
  if (cfgBackup !== null) writeFileSync(CONFIG_FILE, cfgBackup, 'utf8');
}

console.log(`\n${'─'.repeat(50)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('All beta.25 LIVE compile assertions green.');
