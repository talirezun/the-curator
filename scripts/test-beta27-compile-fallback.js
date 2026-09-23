#!/usr/bin/env node
/**
 * v3.0.1-beta.26 → beta.27 — Fix #2: compile fallback ladder.
 *
 * OFFLINE, deterministic, no network. Two parts:
 *   1. Prompt-mode contract (buildCompilePrompt): full (unchanged) / concise
 *      (brevity directive) / summary-only (only the summary page).
 *   2. Orchestration: compileConversation runs full → concise → summary-only,
 *      escalating ONLY on output-token-limit (or a parse failure), surfacing a
 *      clean COMPILE-SPECIFIC error when all attempts overflow, and surfacing a
 *      non-token error (503) immediately without burning retries. Exercised by
 *      injecting a fake LLM via the opts.generateText test seam, against a
 *      throwaway domain isolated in a tempdir.
 *
 * Run:  node scripts/test-beta27-compile-fallback.js
 * Exit: 0 if all green; non-zero on any failure.
 */

import { mkdtempSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';

const DOMAINS_TMP = mkdtempSync(path.join(os.tmpdir(), 'curator-beta27-domains-'));
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS_TMP;
process.on('exit', () => { try { rmSync(DOMAINS_TMP, { recursive: true, force: true }); } catch {} });

const compileMod = await import('../src/brain/compile.js');
const files = await import('../src/brain/files.js');
const { buildCompilePrompt, compileConversation } = compileMod;
// v3.67.0: `spent` is priced by the one actual shape. Imported AFTER compile.js
// on purpose — compile.js reaches ai-run.js only at call time, and this order
// is the one that crashed when it was a static import (see compile.js).
const { spentFromUsage } = await import('../src/brain/ai-run.js');
const { makeUsageAccumulator } = await import('../src/brain/ingest.js');

let passed = 0, failed = 0;
const failures = [];
function ok(cond, label) {
  cond ? (passed++, console.log(`  ✓ ${label}`)) : (failed++, failures.push(label), console.log(`  ✗ ${label}`));
}
function section(t) { console.log(`\n${t}`); }

// ── 1. Prompt-mode contract ─────────────────────────────────────────────────────
section('1. buildCompilePrompt modes');
{
  const base = {
    today: '2026-06-29',
    existingFiles: { entities: ['openai.md'], concepts: ['retrieval-augmented-generation.md'] },
    conversation: { title: 'Compiled knowledge vs RAG', messages: [
      { role: 'user', content: 'why compile?' }, { role: 'assistant', content: 'pre-built graph.' } ] },
    summaryPath: 'summaries/x-2026-06-29-abcd.md',
  };
  const full = buildCompilePrompt(base);
  const concise = buildCompilePrompt({ ...base, mode: 'concise' });
  const summary = buildCompilePrompt({ ...base, mode: 'summary-only' });

  ok(full === buildCompilePrompt({ ...base, mode: 'full' }), 'mode "full" === default (beta.25 prompt unchanged)');
  ok(!/RETRY — the previous attempt/.test(full), 'full prompt has NO concise directive');
  ok(/RETRY — the previous attempt/.test(concise), 'concise prompt HAS the brevity directive');
  ok(/AT MOST ~10 pages/.test(concise), 'concise prompt caps page count');
  ok(/Produce ONLY a single summary page/.test(summary), 'summary-only asks for only the summary');
  ok(/do NOT[\s\S]{0,40}create any entity or concept pages/i.test(summary), 'summary-only forbids entity/concept pages');
  ok(summary.includes(base.summaryPath), 'summary-only still forces the canonical summary path');
  ok(concise.includes('entities/openai.md') && concise.includes('concepts/retrieval-augmented-generation.md'),
    'concise still grounds links in existing filenames');
}

// ── helpers for the orchestration tests ─────────────────────────────────────────
const FULL_JSON = JSON.stringify({
  title: 'Test Compile',
  pages: [
    { path: 'summaries/placeholder.md', content: '# Test\n\nTags: test\n\n- Learned X.\n- Discussed [[openai]] and [[rag]].', summary: 'a test summary' },
    { path: 'entities/openai.md', content: '# OpenAI\n\nType: company\nTags: ai\n\n- Builds frontier models.', summary: 'openai' },
    { path: 'concepts/rag.md', content: '# RAG\n\nTags: ai\n\n- Fetches chunks at query time.', summary: 'rag' },
  ],
});
const SUMMARY_JSON = JSON.stringify({
  title: 'Test Compile',
  pages: [
    { path: 'summaries/placeholder.md', content: '# Test\n\nTags: test\n\n- Summary only, no sub-pages.', summary: 'a test summary' },
  ],
});
const TOKEN_ERR = '⚠ Gemini hit the output token limit (65536 tokens) on this call. The response was cut off mid-way.';
const ERR_503 = '⚠ Gemini infrastructure is temporarily overloaded (HTTP 503). This is a transient backend issue.';

// Build a fake LLM that behaves per mode. `behaviors` maps mode → action:
//   'token' → throw a token-limit error · '503' → throw a 503 · 'badjson' → return junk
//   otherwise the value is returned verbatim (a JSON string).
function mockLLM(behaviors) {
  const calls = [];
  const fn = async (_sys, userPrompt) => {
    const mode = /Produce ONLY a single summary page/.test(userPrompt) ? 'summary-only'
      : /RETRY — the previous attempt/.test(userPrompt) ? 'concise'
      : 'full';
    calls.push(mode);
    const b = behaviors[mode];
    if (b === 'token') throw new Error(TOKEN_ERR);
    if (b === '503') throw new Error(ERR_503);
    if (b === 'badjson') return 'not valid json {{{';
    return b;
  };
  fn.calls = calls;
  return fn;
}

let convSeq = 0;
async function compileWith(domain, behaviors) {
  // Distinct conversation each call → distinct content hash → distinct summary
  // slug → no idempotency refusal between scenarios.
  convSeq += 1;
  const convId = `00000000-0000-4000-8000-0000000027${String(convSeq).padStart(2, '0')}`;
  await files.writeConversation(domain, {
    id: convId, title: `Scenario ${convSeq}`, createdAt: '2026-06-29T00:00:00.000Z', domain,
    messages: [
      { role: 'user', content: `Scenario ${convSeq}: explain compiling vs RAG, mention OpenAI.` },
      { role: 'assistant', content: `Scenario ${convSeq}: compiling pre-builds the graph; OpenAI builds models; RAG fetches chunks.` },
    ],
  });
  const llm = mockLLM(behaviors);
  const res = await compileConversation(domain, convId, () => {}, { generateText: llm });
  return { res, calls: llm.calls };
}

const domain = 'zztest-beta27';
try {
  try { await files.deleteDomain(domain); } catch {}
  await files.createDomain(domain, 'ZZ beta27', 'Throwaway beta27 fallback test', 'generic');

  // ── 2. Happy path — full attempt succeeds, no warnings ──
  section('2. Happy path: full attempt succeeds');
  {
    const { res, calls } = await compileWith(domain, { full: FULL_JSON });
    ok(res.ok === true, `compile ok (${res.error || res.reason || ''})`);
    ok(calls.length === 1 && calls[0] === 'full', 'exactly one LLM call (full) — no needless retries');
    ok(Array.isArray(res.warnings) && res.warnings.length === 0, 'no degradation warnings on a clean compile');
    ok(res.pagesWritten.some(p => p.startsWith('summaries/')), 'summary page written');
    ok(res.pagesWritten.some(p => p.startsWith('entities/')) && res.pagesWritten.some(p => p.startsWith('concepts/')),
      'entity + concept pages written');
  }

  // ── 3. Concise recovery — full overflows, concise succeeds ──
  section('3. full overflows → concise recovers');
  {
    const { res, calls } = await compileWith(domain, { full: 'token', concise: FULL_JSON });
    ok(res.ok === true, `compile ok via concise (${res.error || ''})`);
    ok(calls.join(',') === 'full,concise', `escalated full → concise (calls: ${calls.join(',')})`);
    ok(res.warnings.some(w => /more concise extraction/i.test(w)), 'a "concise extraction" note is surfaced');
    ok(res.pagesWritten.some(p => p.startsWith('entities/')), 'concise still wrote entity pages');
  }

  // ── 4. Summary-only recovery — full + concise overflow ──
  section('4. full + concise overflow → summary-only saves just the summary');
  {
    const { res, calls } = await compileWith(domain, { full: 'token', concise: 'token', 'summary-only': SUMMARY_JSON });
    ok(res.ok === true, `compile ok via summary-only (${res.error || ''})`);
    ok(calls.join(',') === 'full,concise,summary-only', `escalated through all three (calls: ${calls.join(',')})`);
    ok(res.warnings.some(w => /only a summary page was saved/i.test(w)), 'a "summary only" note is surfaced');
    ok(res.pagesWritten.length === 1 && res.pagesWritten[0].startsWith('summaries/'),
      'ONLY the summary page was written (no entity/concept pages)');
  }

  // ── 5. Non-token error surfaces immediately (no fallback) ──
  section('5. 503 on first attempt → fail fast, no fallback');
  {
    const { res, calls } = await compileWith(domain, { full: '503', concise: FULL_JSON });
    ok(res.ok === false, 'compile failed (as it should on a real provider error)');
    ok(calls.length === 1 && calls[0] === 'full', 'only ONE call — did NOT escalate on a non-token error');
    ok(/503|overloaded/i.test(res.error || ''), 'the real 503 message is surfaced');
    ok(!/too large or complex/i.test(res.error || ''), 'not mislabelled as a size problem');
  }

  // ── 6. All attempts overflow → compile-SPECIFIC error (not ingest's PDF text) ──
  section('6. all attempts overflow → compile-specific guidance');
  {
    const { res, calls } = await compileWith(domain, { full: 'token', concise: 'token', 'summary-only': 'token' });
    ok(res.ok === false, 'compile failed after exhausting the ladder');
    ok(calls.join(',') === 'full,concise,summary-only', 'tried all three before giving up');
    ok(/too large or complex/i.test(res.error || ''), 'error gives compile-specific guidance');
    ok(/shorter conversation|split this discussion/i.test(res.error || ''), 'error suggests a shorter/split conversation');
    ok(!/split the (source|PDF)/i.test(res.error || '') && !/by chapter/i.test(res.error || ''),
      'does NOT show the misleading "split the PDF by chapter" ingest text');
    ok(!/Phase 2 batch size/i.test(res.error || ''), 'does NOT reference ingest internals');
  }

  // ── 7. Parse failure escalates too (smaller output parses cleaner) ──
  section('7. malformed JSON on full → concise recovers');
  {
    const { res, calls } = await compileWith(domain, { full: 'badjson', concise: FULL_JSON });
    ok(res.ok === true, `compile recovered from a parse failure (${res.error || ''})`);
    ok(calls.join(',') === 'full,concise', `escalated on parse failure (calls: ${calls.join(',')})`);
  }
} finally {
  try { await files.deleteDomain(domain); } catch {}
}

// ── 8. v3.67.0 — `spent`: what the WHOLE ladder cost ───────────────────────────
// Every provider call of every rung reports usage (generateText fires onUsage
// once per completed call, an overflowing one included — it billed). A compile
// that escalated full → concise → summary-only paid three times, and a `spent`
// naming only the last rung would under-report the bill by the two that
// overflowed. Distinct token counts per rung make "the sum" and "the last" and
// "the first" three different numbers, so no partial accounting can pass.
section('8. spent — summed across every ladder rung (v3.67.0)');
{
  const USAGE = {
    full:           { inputTokens: 11000, outputTokens: 65536, cachedReadTokens: 0, cacheWriteTokens: 0 },
    concise:        { inputTokens: 11300, outputTokens: 65536, cachedReadTokens: 0, cacheWriteTokens: 0 },
    'summary-only': { inputTokens: 11700, outputTokens:   900, cachedReadTokens: 0, cacheWriteTokens: 0 },
  };
  const MODEL = { provider: 'gemini', model: 'gemini-2.5-flash-lite' };
  // A fake that REPORTS usage the way generateText does (6th argument's
  // onUsage), then behaves per mode.
  function billingLLM(behaviors) {
    const calls = [];
    const fn = async (_sys, userPrompt, _max, _fmt, _onWait, opts = {}) => {
      const mode = /Produce ONLY a single summary page/.test(userPrompt) ? 'summary-only'
        : /RETRY — the previous attempt/.test(userPrompt) ? 'concise' : 'full';
      calls.push(mode);
      const b = behaviors[mode];
      if (b !== 'nousage' && opts && typeof opts.onUsage === 'function') opts.onUsage({ ...USAGE[mode], ...MODEL });
      if (b === 'token') throw new Error(TOKEN_ERR);
      if (b === '503' || b === 'nousage') throw new Error(ERR_503);
      return b;
    };
    fn.calls = calls;
    return fn;
  }
  async function compileBilled(behaviors, extraOpts = {}) {
    convSeq += 1;
    const convId = `00000000-0000-4000-8000-0000000027${String(convSeq).padStart(2, '0')}`;
    await files.writeConversation(domain, {
      id: convId, title: `Billed ${convSeq}`, createdAt: '2026-06-29T00:00:00.000Z', domain,
      messages: [
        { role: 'user', content: `Billed ${convSeq}: explain compiling vs RAG, mention OpenAI.` },
        { role: 'assistant', content: `Billed ${convSeq}: compiling pre-builds the graph; OpenAI builds models.` },
      ],
    });
    const llm = billingLLM(behaviors);
    const res = await compileConversation(domain, convId, () => {}, { generateText: llm, ...extraOpts });
    return { res, calls: llm.calls };
  }
  const expectedFor = (modes) => {
    const acc = makeUsageAccumulator();
    for (const m of modes) acc.onUsage({ ...USAGE[m], ...MODEL });
    return spentFromUsage(acc.totals);
  };
  const sameSpent = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  try { await files.createDomain(domain, 'ZZ beta27', 'Throwaway beta27 fallback test', 'generic'); } catch {}

  // (a) three rungs: the named mutation's target.
  {
    const forwarded = [];
    const { res, calls } = await compileBilled(
      { full: 'token', concise: 'token', 'summary-only': SUMMARY_JSON },
      { onUsage: (u) => forwarded.push(u) });
    ok(res.ok === true && calls.length === 3, `precondition: the compile escalated through three rungs (${calls.join(',')})`);
    const sp = res.spent || {};
    ok(sp.calls === 3, `spent sums every rung: calls 3 (got ${sp.calls})`);
    ok(sp.inputTokens === 11000 + 11300 + 11700,
      `spent sums every rung: inputTokens 34000 (got ${sp.inputTokens}; the last rung alone is 11700, the first 11000)`);
    ok(sp.outputTokens === 65536 + 65536 + 900, `spent sums every rung: outputTokens 131972 (got ${sp.outputTokens})`);
    ok(sameSpent(res.spent, expectedFor(['full', 'concise', 'summary-only'])),
      'spent equals spentFromUsage of the accumulated totals of all three calls, field for field');
    ok(typeof sp.usd === 'number' && sp.usd > expectedFor(['summary-only']).usd * 10,
      'and its dollar figure is the three-call bill, many times the last rung\'s alone');
    ok(sp.model === 'gemini-2.5-flash-lite' && sp.modelLabel && sp.estimated === false,
      'spent names the model that billed, with its human label, not estimated');
    ok(forwarded.length === 3, `opts.onUsage is forwarded once per billed call (got ${forwarded.length})`);
  }
  // (b) one rung.
  {
    const { res } = await compileBilled({ full: FULL_JSON });
    ok(res.ok === true && sameSpent(res.spent, expectedFor(['full'])),
      'a clean one-call compile: spent is that one call');
  }
  // (c) a failure that BILLED still says what it cost.
  {
    const { res } = await compileBilled({ full: 'token', concise: 'token', 'summary-only': 'token' });
    ok(res.ok === false && /too large or complex/i.test(res.error || ''), 'precondition: all three rungs overflowed');
    ok(sameSpent(res.spent, expectedFor(['full', 'concise', 'summary-only'])),
      'an exhausted ladder carries spent for all three billed calls — a failure that cost money says so');
  }
  // (d) nothing billed → no spent at all (absent, never a zero-filled object).
  {
    const { res } = await compileBilled({ full: 'nousage' });
    ok(res.ok === false && !('spent' in res),
      'a call that reported no usage (it failed before billing) leaves spent ABSENT');
    const missing = await compileConversation(domain, '00000000-0000-4000-8000-00000000ffff', () => {}, {
      generateText: () => { throw new Error('THE COMPILE MADE AN LLM CALL ON A MISSING CONVERSATION'); },
    });
    ok(missing.ok === false && missing.reason && !('spent' in missing),
      'a refusal before any call carries no spent');
  }
  try { await files.deleteDomain(domain); } catch {}
}

// ── Report ──────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('All beta.27 compile-fallback assertions green.');
