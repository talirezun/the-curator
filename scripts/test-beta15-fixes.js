#!/usr/bin/env node
/**
 * v3.0.1-beta.15 — community bug-report fix bundle, offline battle test.
 *
 * Covers the pure-logic parts of the five fixes:
 *   1. mergeWikiPage prose preservation — a thin incoming page no longer wipes
 *      prose sections (Definition / Summary / Why It Matters) the existing page
 *      had. Bullet sections still accumulate; incoming prose still wins when
 *      present.
 *   2. fixSemanticDuplicatesBatch orchestration — sequential, status mapping,
 *      progress callbacks, graceful skip when a pair's files don't exist, never
 *      throws on a bad pair, empty input → all zeros.
 *
 * The ingest token-limit recovery (#2) and the compile/UI relaxations (#5) are
 * verified separately (live-LLM + DOM); they have no pure-logic surface here.
 *
 * Run: node scripts/test-beta15-fixes.js   (exit 0 = all green)
 */

import { mergeWikiPage } from '../src/brain/files.js';
import { fixSemanticDuplicatesBatch as healthBatch } from '../src/brain/health.js';
import { __testing as ingestTesting } from '../src/brain/ingest.js';

let passed = 0, failed = 0;
const failures = [];
function ok(label) { passed++; console.log(`  ✓ ${label}`); }
function bad(label, detail) { failed++; failures.push(`${label} — ${detail}`); console.log(`  ✗ ${label} — ${detail}`); }
function assert(cond, label, detail = '') { cond ? ok(label) : bad(label, detail); }

// ── 1. Prose preservation in mergeWikiPage ────────────────────────────────────
console.log('\n1. mergeWikiPage — prose preservation');

{
  const existing = `---
type: concept
tags: [type/concept]
---
# Curation

## Definition
Curation is the deliberate selection and arrangement of knowledge with a point of view.

## Why It Matters
Without a viewpoint, curation collapses into link-sharing. The act leaves a trace.

## Key Facts
- Requires competence
- Is a form of metacognition

## Related
- [[paradata]]
`;

  // Incoming is a minimal/stub edit that DROPPED the prose sections entirely.
  const incoming = `---
type: concept
tags: [type/concept]
---
# Curation

## Key Facts
- Leaves a trace

## Related
- [[metacognition]]
`;

  const merged = mergeWikiPage(existing, incoming);

  assert(/## Definition/.test(merged), 'Definition heading preserved', 'incoming dropped it but it should survive');
  assert(/deliberate selection and arrangement/.test(merged), 'Definition prose preserved');
  assert(/## Why It Matters/.test(merged), 'Why It Matters heading preserved');
  assert(/collapses into link-sharing/.test(merged), 'Why It Matters prose preserved');
  // Bullet sections accumulate (existing bullets injected into incoming).
  assert(/Requires competence/.test(merged), 'existing Key Facts bullet accumulated');
  assert(/Leaves a trace/.test(merged), 'incoming Key Facts bullet present');
  assert(/\[\[paradata\]\]/.test(merged), 'existing Related bullet accumulated');
  assert(/\[\[metacognition\]\]/.test(merged), 'incoming Related bullet present');
}

{
  // When incoming INCLUDES the prose section (a rewrite), incoming wins — we do
  // NOT also append the old prose (no duplication, preserves ingest behaviour).
  const existing = `# X

## Definition
Old definition text.
`;
  const incoming = `# X

## Definition
New, fuller definition with full-document context.
`;
  const merged = mergeWikiPage(existing, incoming);
  assert(/New, fuller definition/.test(merged), 'incoming prose wins when present');
  assert(!/Old definition text/.test(merged), 'old prose NOT duplicated when incoming rewrote the section');
  const defCount = (merged.match(/## Definition/g) || []).length;
  assert(defCount === 1, 'exactly one Definition heading (no duplication)', `got ${defCount}`);
}

{
  // No existing prose to lose → output equals incoming-derived (sanity: no crash,
  // no spurious sections appended).
  const existing = `# Y\n\n## Key Facts\n- a\n`;
  const incoming = `# Y\n\n## Key Facts\n- b\n`;
  const merged = mergeWikiPage(existing, incoming);
  assert(/- a/.test(merged) && /- b/.test(merged), 'pure bullet merge still works');
  assert(!/## Definition/.test(merged), 'no phantom prose section invented');
}

{
  // Audit fix: case-mismatched PROSE heading must NOT duplicate. Existing has
  // "## definition" (lowercase), incoming has "## Definition" — incoming wins,
  // existing is NOT appended as a second section.
  const existing = `# Z\n\n## definition\nold prose text here\n`;
  const incoming = `# Z\n\n## Definition\nnew prose with full context\n`;
  const merged = mergeWikiPage(existing, incoming);
  const defCount = (merged.match(/##\s+definition/gi) || []).length;
  assert(defCount === 1, 'case-mismatched Definition not duplicated', `got ${defCount} headings`);
  assert(/new prose with full context/.test(merged), 'incoming prose kept on case mismatch');
  assert(!/old prose text here/.test(merged), 'old prose dropped (incoming had the section)');
}

{
  // Audit fix: case-mismatched ACCUMULATE heading must NOT produce double
  // content. Existing "## key facts" (lowercase) bullets should merge into the
  // canonical "## Key Facts" injection, NOT also be appended as a prose block.
  const existing = `# W\n\n## key facts\n- existing fact\n`;
  const incoming = `# W\n\n## Key Facts\n- incoming fact\n`;
  const merged = mergeWikiPage(existing, incoming);
  const kfCount = (merged.match(/##\s+key facts/gi) || []).length;
  assert(kfCount === 1, 'case-mismatched Key Facts not duplicated as a section', `got ${kfCount} headings`);
  const existingFactCount = (merged.match(/existing fact/g) || []).length;
  assert(existingFactCount === 1, 'existing bullet appears exactly once (no double content)', `got ${existingFactCount}`);
  assert(/incoming fact/.test(merged), 'incoming bullet present');
}

// ── 2. fixSemanticDuplicatesBatch orchestration ───────────────────────────────
console.log('\n2. fixSemanticDuplicatesBatch — orchestration & safety');

{
  assert(typeof healthBatch === 'function', 'health.js exports fixSemanticDuplicatesBatch');
  assert(typeof mergeWikiPage === 'function', 'files.js exports mergeWikiPage');
}

{
  // Non-existent domain → every pair's files are absent → fixSemanticDuplicate
  // returns false → all reported as skipped, zero merges, NO throw.
  const pairs = [
    { keepSlug: 'a', keepFolder: 'concepts', removeSlug: 'a-x', removeFolder: 'concepts' },
    { keepSlug: 'b', keepFolder: 'entities', removeSlug: 'b-y', removeFolder: 'entities' },
  ];
  const progressCalls = [];
  let res;
  try {
    res = await healthBatch('__beta15_nonexistent_domain__', pairs, (p) => progressCalls.push(p));
  } catch (err) {
    bad('batch does not throw on missing files', err.message);
  }
  if (res) {
    assert(res.total === 2, 'total counts all pairs', `got ${res.total}`);
    assert(res.merged === 0, 'no merges on a non-existent domain', `got ${res.merged}`);
    assert(res.skipped === 2, 'both pairs skipped (files absent)', `got ${res.skipped}`);
    assert(res.errors === 0, 'no errors', `got ${res.errors}`);
    assert(progressCalls.length === 2, 'progress callback fired once per pair', `got ${progressCalls.length}`);
    assert(progressCalls.every((p, i) => p.done === i + 1 && p.total === 2), 'progress carries done/total');
    assert(res.results.length === 2 && res.results.every(r => r.status === 'skipped'), 'per-pair results recorded as skipped');
  }
}

{
  // Empty input → all zeros, no progress, no throw.
  const progressCalls = [];
  const res = await healthBatch('__beta15_nonexistent_domain__', [], (p) => progressCalls.push(p));
  assert(res.total === 0 && res.merged === 0 && res.skipped === 0 && res.errors === 0, 'empty list → all zeros');
  assert(progressCalls.length === 0, 'empty list → no progress callbacks');
}

{
  // Non-array input is tolerated (defensive).
  const res = await healthBatch('__beta15_nonexistent_domain__', null, () => {});
  assert(res.total === 0, 'null pairs tolerated → total 0');
}

// ── 3. Ingest error classification (drives re-throw vs recover) ───────────────
console.log('\n3. isOutputTokenLimit — only token-limit errors recover; everything else re-throws');

{
  const { isOutputTokenLimit } = ingestTesting;
  assert(typeof isOutputTokenLimit === 'function', 'isOutputTokenLimit exported from ingest __testing');

  // The REAL token-limit messages from llm.js (both providers) MUST classify as
  // recoverable → page-by-page / concise-retry fallback.
  const geminiTokenErr = new Error('⚠ Gemini hit the output token limit (65536 tokens) on this call. The response was cut off…');
  const claudeTokenErr = new Error('⚠ Claude hit the output token limit (16384 tokens) on this call. The response was cut off…');
  assert(isOutputTokenLimit(geminiTokenErr), 'Gemini output-token-limit error → recoverable');
  assert(isOutputTokenLimit(claudeTokenErr), 'Claude output-token-limit error → recoverable');

  // The REAL fatal messages from llm.js MUST NOT classify as token-limit, so
  // they re-throw instead of silently degrading a batch into stub pages.
  const rateErr = new Error('⚠ Rate limit hit on Anthropic Claude (HTTP 429). This is an upstream limit on your API account…');
  const overloadErr = new Error('⚠ Anthropic Claude infrastructure is temporarily overloaded (HTTP 503). This is a transient backend…');
  const keyErr = new Error('No LLM API key found. Add one in Settings, or set GEMINI_API_KEY / ANTHROPIC_API_KEY in .env.');
  const netErr = new Error('fetch failed: ECONNRESET');
  const parseErr = new SyntaxError('Unexpected token < in JSON at position 0');
  assert(!isOutputTokenLimit(rateErr), 'rate-limit (429) → NOT recoverable (re-throws)');
  assert(!isOutputTokenLimit(overloadErr), 'overload (503) → NOT recoverable (re-throws)');
  assert(!isOutputTokenLimit(keyErr), 'missing-key → NOT recoverable (re-throws)');
  assert(!isOutputTokenLimit(netErr), 'network error → NOT recoverable (re-throws)');
  assert(!isOutputTokenLimit(parseErr), 'JSON parse error → NOT a token-limit (handled by its own parse path)');

  // Defensive: undefined / no-message inputs never throw and classify false.
  assert(isOutputTokenLimit(undefined) === false, 'undefined error → false (no throw)');
  assert(isOutputTokenLimit({}) === false, 'message-less object → false (no throw)');
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(48)}`);
console.log(`beta.15 offline: ${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:'); failures.forEach(f => console.log('  • ' + f)); process.exit(1); }
console.log('All green ✓');
