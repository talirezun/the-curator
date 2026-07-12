#!/usr/bin/env node
/**
 * Offline regression tests for v3.0.1-beta.13.
 *
 * Covers all three new chat improvements:
 *   1. detectEntityPivots — finds entities whose slug overlaps with the query
 *   2. extractSummaryBacklinks — parses [[summaries/X]] from entity bodies
 *   3. buildSummaryToEntitiesIndex — reverse lookup summary → entities
 *   4. detectQueryIntent — enumerate vs synthesis classification
 *   5. selectRelevantPages — pivot pages take priority over keyword
 *   6. buildSlugCatalogue — author/topic metadata enriches summaries
 *   7. buildPrompt — intent-aware instruction block
 *
 * All fully offline — no LLM, no FS writes outside isolated tempdir.
 *
 *   node scripts/test-beta13-fixes.js
 */

import { mkdtempSync, rmSync, copyFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const tempRoot = mkdtempSync(path.join(tmpdir(), 'curator-beta13-'));
process.env.DOMAINS_PATH = tempRoot;

const realCfg = path.resolve('.curator-config.json');
const stash = realCfg + '.beta13-bak';
let stashed = false;
if (existsSync(realCfg)) {
  copyFileSync(realCfg, stash);
  rmSync(realCfg);
  stashed = true;
}

let passed = 0, failed = 0;
function ok(label) { passed++; console.log(`  ✓ ${label}`); }
function fail(label, detail) { failed++; console.log(`  ✗ ${label}`); if (detail) console.log(`    └─ ${detail}`); }
function eq(actual, expected, label) {
  if (actual === expected) return ok(label);
  return fail(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function truthy(cond, label, detail) { if (cond) return ok(label); return fail(label, detail); }

async function cleanup() {
  try { rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  if (stashed) try { copyFileSync(stash, realCfg); rmSync(stash); } catch {}
}
process.on('SIGINT', async () => { await cleanup(); process.exit(130); });

// Test fixtures — a synthetic wiki structured like the real articles domain.
const TALI_ENTITY = {
  path: 'entities/tali-rezun.md',
  content: `---
type: entity
tags: [author, type/entity]
---
## Summary
Dr. Tali Rezun is the author of many articles.

## Related
- [[summaries/why-i-ditched-rag]] — RAG vs context windows
- [[summaries/data-sovereignty]] — building a private ChatGPT
- [[summaries/chasing-jarvis]] — three missing pieces
- [[summaries/the-brain-is-ready]] — body vs brain analysis
- [[summaries/from-online-to-on-chain]] — blockchain communication
- [[summaries/openclaw]] — AI assistant in your pocket
- [[summaries/the-year-i-started-coding]] — coding agent journey
- [[summaries/manifesto-1]] — key author of this document
`,
};

const OPENAI_ENTITY = {
  path: 'entities/openai.md',
  content: `---
type: entity
tags: [ai-lab, type/entity]
---
## Summary
OpenAI is an AI research lab.

## Related
- [[summaries/why-i-ditched-rag]] — mentions OpenAI models
- [[summaries/chasing-jarvis]] — references GPT models
`,
};

const RAG_SUMMARY = {
  path: 'summaries/why-i-ditched-rag.md',
  content: `---
type: summary
source: Why-I-Ditched-RAG.pdf
date: 2026-04-13
tags: [rag, llm, type/summary]
---
# Why I Ditched RAG Pipelines for 1M Token Context Windows

## Key Takeaways
- RAG was the dominant pattern in 2023-2024 but is being replaced by long-context windows.
- The 1M token context window of Gemini 2.5 Flash makes RAG unnecessary for many use cases.

## Entities Mentioned
- [[tali-rezun]] — author
- [[openai]] — embedding provider
`,
};

const DATA_SOV_SUMMARY = {
  path: 'summaries/data-sovereignty.md',
  content: `---
type: summary
source: Data Sovereignty in the AI Age.pdf
date: 2026-04-15
tags: [privacy, local-ai, type/summary]
---
# Data Sovereignty in the AI Age

## Key Takeaways
- Local AI deployment ensures data privacy.

## Entities Mentioned
- [[tali-rezun]] — author
`,
};

const HNSW_CONCEPT = {
  path: 'concepts/hnsw.md',
  content: `---
type: concept
tags: [vector-search, type/concept]
---
# HNSW

Hierarchical Navigable Small World — an ANN algorithm for vector indices.
`,
};

const FIXTURE_PAGES = [TALI_ENTITY, OPENAI_ENTITY, RAG_SUMMARY, DATA_SOV_SUMMARY, HNSW_CONCEPT, {
  path: 'index.md',
  content: '# Index\n\nDomain catalog table.',
}, {
  path: 'log.md',
  content: '# Log\n\n## [2026-05-23] ingest | foo',
}];

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  v3.0.1-beta.13 offline regression tests');
  console.log('═══════════════════════════════════════════════════════════════');

  // ── Test 1: detectEntityPivots — multi-token slug, two-token query ─────
  console.log('\n[1] detectEntityPivots — multi-token slug match');
  {
    const { detectEntityPivots } = await import('../src/brain/chat.js');
    const pivots = detectEntityPivots('What articles did Tali Rezun write?', FIXTURE_PAGES);
    eq(pivots.length, 1, 'Test 1a: one pivot detected');
    eq(pivots[0].slug, 'tali-rezun', 'Test 1b: pivot slug correct');
    eq(pivots[0].overlap, 2, 'Test 1c: both tokens matched');
  }

  // ── Test 2: detectEntityPivots — single-token slug, specific token ─────
  console.log('\n[2] detectEntityPivots — single-token specific slug');
  {
    const { detectEntityPivots } = await import('../src/brain/chat.js');
    const pivots = detectEntityPivots('Tell me about OpenAI', FIXTURE_PAGES);
    eq(pivots.length, 1, 'Test 2a: one pivot detected');
    eq(pivots[0].slug, 'openai', 'Test 2b: openai detected as pivot');
  }

  // ── Test 3: detectEntityPivots — no overlap returns empty ──────────────
  console.log('\n[3] detectEntityPivots — no overlap');
  {
    const { detectEntityPivots } = await import('../src/brain/chat.js');
    const pivots = detectEntityPivots('How does HNSW work?', FIXTURE_PAGES);
    eq(pivots.length, 0, 'Test 3a: no entity pivot for purely-concept query');
  }

  // ── Test 4: detectEntityPivots — blocklisted single-token doesn't match
  console.log('\n[4] detectEntityPivots — common-token blocklist');
  {
    const { detectEntityPivots } = await import('../src/brain/chat.js');
    // Hypothetical entity 'ai' — single token, in blocklist
    const fakePages = [...FIXTURE_PAGES, { path: 'entities/ai.md', content: '# AI' }];
    const pivots = detectEntityPivots('explain ai', fakePages);
    // Should NOT pivot on 'ai' alone (blocklist) but no other match → empty
    eq(pivots.length, 0, 'Test 4a: blocklisted single-token does not pivot');
  }

  // ── Test 5: extractSummaryBacklinks ────────────────────────────────────
  console.log('\n[5] extractSummaryBacklinks');
  {
    const { extractSummaryBacklinks } = await import('../src/brain/chat.js');
    const links = extractSummaryBacklinks(TALI_ENTITY.content);
    eq(links.length, 8, 'Test 5a: 8 summary backlinks extracted');
    truthy(links.includes('why-i-ditched-rag'), 'Test 5b: rag backlink present');
    truthy(links.includes('manifesto-1'), 'Test 5c: manifesto-1 backlink present');
  }

  // ── Test 6: extractSummaryBacklinks handles alias syntax ───────────────
  console.log('\n[6] extractSummaryBacklinks — alias syntax');
  {
    const { extractSummaryBacklinks } = await import('../src/brain/chat.js');
    const content = '[[summaries/foo|Foo Title]] and [[summaries/bar]]';
    const links = extractSummaryBacklinks(content);
    eq(links.length, 2, 'Test 6a: two links extracted from mixed syntax');
    truthy(links.includes('foo'), 'Test 6b: alias-form slug extracted correctly');
    truthy(links.includes('bar'), 'Test 6c: plain-form slug extracted correctly');
  }

  // ── Test 7: buildSummaryToEntitiesIndex ────────────────────────────────
  console.log('\n[7] buildSummaryToEntitiesIndex');
  {
    const { buildSummaryToEntitiesIndex } = await import('../src/brain/chat.js');
    const index = buildSummaryToEntitiesIndex(FIXTURE_PAGES);
    truthy(index.has('why-i-ditched-rag'), 'Test 7a: rag summary in index');
    const ragEntities = index.get('why-i-ditched-rag');
    eq(ragEntities.size, 2, 'Test 7b: rag summary has 2 entity backlinks');
    truthy(ragEntities.has('tali-rezun'), 'Test 7c: tali-rezun → rag');
    truthy(ragEntities.has('openai'), 'Test 7d: openai → rag');
  }

  // ── Test 8: detectQueryIntent — enumerate patterns ─────────────────────
  console.log('\n[8] detectQueryIntent — enumerate detection');
  {
    const { detectQueryIntent } = await import('../src/brain/chat.js');
    for (const q of [
      'list articles by Dr. Tali Rezun',
      'What articles have I ingested?',
      'how many sources do I have?',
      'show me all entities',
      'give me a list of concepts',
      'name all the authors',
      'which papers mention RAG?',
      'I want the complete list of summaries',
      'every article in this domain',
      'articles by Prof. Smith',
    ]) {
      eq(detectQueryIntent(q), 'enumerate', `Test 8: "${q.slice(0,40)}…" classified as enumerate`);
    }
  }

  // ── Test 9: detectQueryIntent — synthesis patterns ─────────────────────
  console.log('\n[9] detectQueryIntent — synthesis detection');
  {
    const { detectQueryIntent } = await import('../src/brain/chat.js');
    for (const q of [
      'What is HNSW?',
      'How does RAG work?',
      'Explain the energy footprint of generative AI',
      'tell me about vector databases',
      'compare openai and anthropic',
      'why did Tali ditch RAG?',
    ]) {
      eq(detectQueryIntent(q), 'synthesis', `Test 9: "${q.slice(0,40)}…" classified as synthesis`);
    }
  }

  // ── Test 10: detectQueryIntent — null/undefined defensive ──────────────
  console.log('\n[10] detectQueryIntent — defensive inputs');
  {
    const { detectQueryIntent } = await import('../src/brain/chat.js');
    eq(detectQueryIntent(null), 'synthesis', 'Test 10a: null returns synthesis');
    eq(detectQueryIntent(undefined), 'synthesis', 'Test 10b: undefined returns synthesis');
    eq(detectQueryIntent(''), 'synthesis', 'Test 10c: empty string returns synthesis');
  }

  // ── Test 11: selectRelevantPages — pivot loads entity + its summaries ──
  console.log('\n[11] selectRelevantPages — entity-pivot priority loading');
  {
    const { selectRelevantPages } = await import('../src/brain/chat.js');
    const result = selectRelevantPages(FIXTURE_PAGES, 'What articles did Tali Rezun write?');
    truthy(result.pivotCount >= 1, 'Test 11a: at least 1 pivot detected');
    const paths = result.selected.map(s => s.page.path);
    truthy(paths.includes('entities/tali-rezun.md'), 'Test 11b: tali-rezun entity loaded');
    truthy(paths.includes('summaries/why-i-ditched-rag.md'), 'Test 11c: rag summary (backlink) loaded');
    truthy(paths.includes('summaries/data-sovereignty.md'), 'Test 11d: data-sov summary (backlink) loaded');
    // Priority pages should be marked
    const tali = result.selected.find(s => s.page.path === 'entities/tali-rezun.md');
    truthy(tali && tali.priority === true, 'Test 11e: pivot page marked as priority');
  }

  // ── Test 12: selectRelevantPages — non-pivot keyword fallback ──────────
  console.log('\n[12] selectRelevantPages — no pivot, keyword scoring works');
  {
    const { selectRelevantPages } = await import('../src/brain/chat.js');
    const result = selectRelevantPages(FIXTURE_PAGES, 'how does HNSW work?');
    eq(result.pivotCount, 0, 'Test 12a: no pivot for HNSW query');
    const paths = result.selected.map(s => s.page.path);
    truthy(paths.includes('concepts/hnsw.md'), 'Test 12b: hnsw concept page loaded');
  }

  // ── Test 13: buildSlugCatalogue — summaries show referenced-by ─────────
  console.log('\n[13] buildSlugCatalogue — referenced-by metadata');
  {
    const { __testing, buildSummaryToEntitiesIndex } = await import('../src/brain/chat.js');
    const { buildSlugCatalogue } = __testing;
    const index = buildSummaryToEntitiesIndex(FIXTURE_PAGES);
    const catalogue = buildSlugCatalogue(FIXTURE_PAGES, index, new Set());
    truthy(catalogue.includes('referenced by:'), 'Test 13a: catalogue includes referenced-by markers');
    truthy(catalogue.includes('tali-rezun'), 'Test 13b: tali-rezun appears in referenced-by');
    // Both summaries should be enriched
    const ragLine = catalogue.split('\n').find(l => l.includes('why-i-ditched-rag'));
    truthy(ragLine && ragLine.includes('referenced by:') && ragLine.includes('tali-rezun'),
      'Test 13c: rag summary line has tali-rezun in referenced-by');
  }

  // ── Test 14: buildSlugCatalogue — pivot entity shows backlink count ────
  console.log('\n[14] buildSlugCatalogue — pivot backlink count');
  {
    const { __testing, buildSummaryToEntitiesIndex } = await import('../src/brain/chat.js');
    const { buildSlugCatalogue } = __testing;
    const index = buildSummaryToEntitiesIndex(FIXTURE_PAGES);
    const catalogue = buildSlugCatalogue(FIXTURE_PAGES, index, new Set(['tali-rezun']));
    const taliLine = catalogue.split('\n').find(l => l.includes('entities/tali-rezun'));
    truthy(taliLine && taliLine.includes('summary backlinks'),
      'Test 14a: pivot entity shows its backlink count');
  }

  // ── Test 15: buildPrompt — enumerate intent swaps instructions ─────────
  console.log('\n[15] buildPrompt — enumerate instructions for enumerate queries');
  {
    const { __testing } = await import('../src/brain/chat.js');
    const { buildPrompt } = __testing;
    const prompt = buildPrompt('articles', FIXTURE_PAGES, [], 'list all articles by Tali Rezun');
    truthy(prompt.includes('ENUMERATION query'), 'Test 15a: enumerate prompt used');
    // v3.0.7 Tier 1: the enumerate prompt was reshaped from "completeness matters
    // more than synthesis" (which drove full-domain dumps) to a focused-list form.
    truthy(prompt.includes('the user wants a focused list'),
      'Test 15b: enumerate-specific guidance present (focused-list form)');
    truthy(!prompt.includes('do not quote large blocks verbatim'),
      'Test 15c: synthesis-specific guidance NOT used');
  }

  // ── Test 16: buildPrompt — synthesis intent uses synthesis instructions
  console.log('\n[16] buildPrompt — synthesis instructions for normal queries');
  {
    const { __testing } = await import('../src/brain/chat.js');
    const { buildPrompt } = __testing;
    const prompt = buildPrompt('articles', FIXTURE_PAGES, [], 'how does RAG work?');
    truthy(prompt.includes('Synthesize across pages'), 'Test 16a: synthesis prompt used');
    truthy(prompt.includes('do not quote large blocks verbatim'),
      'Test 16b: synthesis-specific guidance present');
    truthy(!prompt.includes('ENUMERATION query'), 'Test 16c: enumerate prompt NOT used');
  }

  // ── Test 17: buildPrompt — pivot info surfaces in retrieval note ───────
  console.log('\n[17] buildPrompt — pivot info in retrieval note');
  {
    const { __testing } = await import('../src/brain/chat.js');
    const { buildPrompt } = __testing;
    const prompt = buildPrompt('articles', FIXTURE_PAGES, [], 'tell me about Tali Rezun');
    truthy(prompt.includes('entity pivot'),
      'Test 17a: pivot count surfaced in retrieval note');
    truthy(prompt.includes('tali-rezun'),
      'Test 17b: pivot slug surfaced in retrieval note');
  }

  // ── Test 18: regression — existing chat behavior preserved (no pivot, synthesis)
  console.log('\n[18] regression — existing behavior preserved');
  {
    const { selectRelevantPages } = await import('../src/brain/chat.js');
    // No keyword match, no pivot — should fall back to most-linked
    const result = selectRelevantPages(FIXTURE_PAGES, 'completely unrelated xyzqwerty');
    truthy(result.selected.length > 0, 'Test 18a: fallback still works (non-empty)');
    eq(result.pivotCount, 0, 'Test 18b: no pivot for unrelated query');
    eq(result.scoredCount, 0, 'Test 18c: no scored pages for unrelated query');
  }

  // ── Test 19: budget enforcement still works with pivots ────────────────
  console.log('\n[19] selectRelevantPages — budget enforced even with pivots');
  {
    const { selectRelevantPages } = await import('../src/brain/chat.js');
    // Build a huge entity backlink set to force budget overflow
    const bigEntity = {
      path: 'entities/bigboi.md',
      content: '# BigBoi\n' + Array.from({ length: 100 }, (_, i) => `[[summaries/summary-${i}]]`).join('\n'),
    };
    const bigSummaries = Array.from({ length: 100 }, (_, i) => ({
      path: `summaries/summary-${i}.md`,
      content: `# Summary ${i}\n` + 'lorem ipsum '.repeat(500),  // ~6 KB each
    }));
    const bigPages = [bigEntity, ...bigSummaries];
    const result = selectRelevantPages(bigPages, 'tell me about bigboi');
    truthy(result.contentBytes <= 60_000, `Test 19a: content under budget (${result.contentBytes})`);
    truthy(result.selected.length <= 50, `Test 19b: max-pages cap respected (${result.selected.length})`);
  }

  // ── Test 20: catalogue budget enforcement with metadata ────────────────
  console.log('\n[20] buildSlugCatalogue — budget enforced');
  {
    const { __testing } = await import('../src/brain/chat.js');
    const { buildSlugCatalogue } = __testing;
    // Build 1000 dummy pages
    const bigPages = Array.from({ length: 1000 }, (_, i) => ({
      path: `concepts/page-${i}.md`,
      content: `# Page ${i}\nContent`,
    }));
    const catalogue = buildSlugCatalogue(bigPages, new Map(), new Set(), 8000);
    truthy(catalogue.length <= 8500, `Test 20a: catalogue under budget (${catalogue.length})`);
    truthy(catalogue.includes('not shown in catalogue'),
      'Test 20b: truncation notice present');
  }

  // ── Summary ──────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`  Result: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  await cleanup();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async err => {
  console.error('FATAL:', err);
  await cleanup();
  process.exit(2);
});
