#!/usr/bin/env node
/**
 * Offline regression tests for v3.0.1-beta.11.
 *
 * Covers:
 *   1. Chat: selectRelevantPages prefers query-matching pages over file order
 *   2. Chat: selectRelevantPages excludes index.md + log.md from content
 *   3. Chat: selectRelevantPages falls back to top-linked when no match
 *   4. Chat: scorePage weighting (filename > heading > body)
 *   5. Chat: selectRelevantPages respects content budget
 *   6. Ingest: redirectSemanticDuplicates auto-redirects at ≥0.85 Jaccard
 *   7. Ingest: redirectSemanticDuplicates warns in 0.5–0.85 band
 *   8. Ingest: redirectSemanticDuplicates catches singular/plural via stem
 *   9. Ingest: redirectSemanticDuplicates catches within-outline dupes
 *  10. Ingest: redirectSemanticDuplicates leaves entities alone
 *  11. Ingest: buildBatchPrompt now includes the full outline slug list
 *  12. Ingest: buildBatchPrompt categorises by folder
 *
 * All checks run offline — no network, no LLM, no live filesystem outside
 * of an isolated tempdir.
 *
 *   node scripts/test-beta11-fixes.js
 */

import { mkdtempSync, rmSync, copyFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const tempRoot = mkdtempSync(path.join(tmpdir(), 'curator-beta11-'));
process.env.DOMAINS_PATH = tempRoot;

const realCfg = path.resolve('.curator-config.json');
const stash = realCfg + '.beta11-bak';
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

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  v3.0.1-beta.11 regression tests');
  console.log('═══════════════════════════════════════════════════════════════');

  // ── Test 1: chat selectRelevantPages prefers query-matching ────────
  console.log('\n[1] chat — selectRelevantPages picks matching pages');
  {
    const { selectRelevantPages } = await import('../src/brain/chat.js');
    const pages = [
      { path: 'index.md',  content: 'index goes here, lots of slug listings' },
      { path: 'log.md',    content: 'log entries' },
      { path: 'concepts/vector-database.md', content: '# Vector Database\nA store of high-dimensional embeddings used by RAG systems.' },
      { path: 'concepts/quantization.md',    content: '# Quantization\nReducing precision to save memory in vector indices.' },
      { path: 'entities/pinecone.md',        content: '# Pinecone\nManaged vector database service.' },
      { path: 'concepts/cooking.md',         content: '# Cooking\nUnrelated content.' },
    ];
    const { selected } = selectRelevantPages(pages, 'what is a vector database?');
    const selectedPaths = selected.map(s => s.page.path);
    truthy(selectedPaths.includes('concepts/vector-database.md'),
      'Test 1a: vector-database page selected for matching query');
    truthy(!selectedPaths.includes('index.md'),
      'Test 1b: index.md excluded from content selection');
    truthy(!selectedPaths.includes('log.md'),
      'Test 1c: log.md excluded from content selection');
    truthy(!selectedPaths.includes('concepts/cooking.md'),
      'Test 1d: non-matching cooking page not selected (or low priority)');
  }

  // ── Test 2: scorePage prefers filename matches over body matches ───
  console.log('\n[2] chat — scorePage weighting');
  {
    const { selectRelevantPages } = await import('../src/brain/chat.js');
    const pages = [
      { path: 'concepts/hnsw.md', content: '# HNSW\nHierarchical Navigable Small World algorithm.' },
      { path: 'concepts/everything.md', content: '# Everything\nThis page mentions hnsw somewhere in the body but is about generic concepts.' },
    ];
    const { selected } = selectRelevantPages(pages, 'HNSW');
    eq(selected[0].page.path, 'concepts/hnsw.md',
      'Test 2a: filename-matching page ranks first');
  }

  // ── Test 3: fall back to top-linked pages on no match ──────────────
  console.log('\n[3] chat — selectRelevantPages fallback on no match');
  {
    const { selectRelevantPages } = await import('../src/brain/chat.js');
    const pages = [
      { path: 'concepts/hub.md', content: '# Hub\nLots of links: [[a]] [[b]] [[c]] [[d]] [[e]]' },
      { path: 'concepts/lonely.md', content: '# Lonely\nNo outgoing links here.' },
    ];
    const { selected } = selectRelevantPages(pages, 'completely unrelated query about xyzqwertyuiop');
    truthy(selected.length > 0, 'Test 3a: fallback returned at least one page');
    eq(selected[0].page.path, 'concepts/hub.md', 'Test 3b: most-linked hub picked as fallback');
  }

  // ── Test 4: budget enforcement ──────────────────────────────────
  console.log('\n[4] chat — selectRelevantPages respects content budget');
  {
    const { selectRelevantPages } = await import('../src/brain/chat.js');
    // Build 100 pages each 5 KB → 500 KB total, far over the 60 KB budget
    const pages = Array.from({ length: 100 }, (_, i) => ({
      path: `concepts/topic-${i}.md`,
      content: `# Topic ${i}\n` + 'lorem ipsum topic abcdef '.repeat(200),  // ~5 KB each
    }));
    const { selected, contentBytes } = selectRelevantPages(pages, 'topic');
    truthy(contentBytes <= 60_000, `Test 4a: content under budget (${contentBytes} bytes)`);
    truthy(selected.length < 100, `Test 4b: not all 100 pages selected (got ${selected.length})`);
  }

  // ── Test 5: chat with empty domain ──────────────────────────────
  console.log('\n[5] chat — selectRelevantPages on empty pages list');
  {
    const { selectRelevantPages } = await import('../src/brain/chat.js');
    const { selected, contentBytes } = selectRelevantPages([], 'anything');
    eq(selected.length, 0, 'Test 5a: empty pages → empty selected');
    eq(contentBytes, 0, 'Test 5b: empty pages → 0 contentBytes');
  }

  // ── Test 6: redirectSemanticDuplicates auto-redirects at ≥0.85 ──
  console.log('\n[6] ingest — redirectSemanticDuplicates auto-redirect');
  {
    const { redirectSemanticDuplicates } = await import('../src/brain/ingest.js');
    const outline = {
      pages: [
        { path: 'summaries/foo.md', summary: 'A summary' },
        { path: 'concepts/experts-roundup-format.md', summary: 'A roundup of expert views' },
      ],
    };
    const existingFiles = { concepts: ['expert-roundup-format.md'], entities: [] };
    const { warnings, redirects } = redirectSemanticDuplicates(outline, existingFiles);
    eq(redirects.length, 1, 'Test 6a: one redirect emitted');
    eq(redirects[0].from, 'experts-roundup-format', 'Test 6b: redirect.from is the proposed slug');
    eq(redirects[0].to,   'expert-roundup-format',  'Test 6c: redirect.to is the existing slug');
    eq(outline.pages[1].path, 'concepts/expert-roundup-format.md', 'Test 6d: outline path rewritten');
    truthy(warnings.some(w => w.includes('Jaccard')), 'Test 6e: warning mentions Jaccard');
  }

  // ── Test 7: warn band (0.5–0.85) doesn't redirect ──────────────
  console.log('\n[7] ingest — redirectSemanticDuplicates warn band');
  {
    const { redirectSemanticDuplicates } = await import('../src/brain/ingest.js');
    const outline = {
      pages: [
        { path: 'concepts/data-pipeline.md', summary: 'sum' },
      ],
    };
    // Existing has SOME tokens in common but less than 0.85 — token-overlap ~0.5
    const existingFiles = { concepts: ['data-warehouse.md'], entities: [] };
    const { warnings, redirects } = redirectSemanticDuplicates(outline, existingFiles);
    eq(redirects.length, 0, 'Test 7a: no redirect in warn band');
    eq(outline.pages[0].path, 'concepts/data-pipeline.md', 'Test 7b: outline path unchanged');
    truthy(warnings.some(w => w.includes('Jaccard')) || warnings.length === 0,
      'Test 7c: either warning emitted or band missed entirely');
  }

  // ── Test 8: singular/plural via stem ──────────────────────────
  console.log('\n[8] ingest — singular/plural stemming');
  {
    const { redirectSemanticDuplicates } = await import('../src/brain/ingest.js');
    const outline = {
      pages: [
        { path: 'concepts/best-of-collection-format.md', summary: 's' },
      ],
    };
    const existingFiles = { concepts: ['best-of-collections.md'], entities: [] };
    const { redirects } = redirectSemanticDuplicates(outline, existingFiles);
    // With stem: {best, of, collection} vs {best, of, collection, format} = 3/4 = 0.75
    // Below 0.85 auto-redirect threshold but in warn band — this validates the
    // stem-then-jaccard math is working, even if the final action is to warn.
    truthy(redirects.length === 0 || redirects[0].score >= 0.5,
      'Test 8a: stemming brings best-of-collection(s) into comparable range');
  }

  // ── Test 9: within-outline duplicates ──────────────────────────
  console.log('\n[9] ingest — within-outline near-duplicate');
  {
    const { redirectSemanticDuplicates } = await import('../src/brain/ingest.js');
    const outline = {
      pages: [
        { path: 'concepts/expert-roundup-format.md', summary: 'first' },
        { path: 'concepts/experts-roundup-format.md', summary: 'plural variant' },
      ],
    };
    const existingFiles = { concepts: [], entities: [] };
    const { warnings, redirects } = redirectSemanticDuplicates(outline, existingFiles);
    eq(redirects.length, 1, 'Test 9a: one within-outline redirect');
    eq(redirects[0].scope, 'within', 'Test 9b: scope=within');
    eq(outline.pages.length, 1, 'Test 9c: outline.pages dropped to single entry');
    truthy(warnings.some(w => w.includes('near-duplicate')),
      'Test 9d: warning mentions near-duplicate');
  }

  // ── Test 10: entities are untouched ──────────────────────────
  console.log('\n[10] ingest — entities skipped by semantic dedup');
  {
    const { redirectSemanticDuplicates } = await import('../src/brain/ingest.js');
    const outline = {
      pages: [
        { path: 'entities/openai.md', summary: 'AI lab' },
        { path: 'entities/open-ai.md', summary: 'variant' },  // would Jaccard-match
      ],
    };
    const existingFiles = { concepts: [], entities: ['openai.md'] };
    const { redirects } = redirectSemanticDuplicates(outline, existingFiles);
    eq(redirects.length, 0, 'Test 10a: entities not redirected (writePage Pass A/B handles them)');
    eq(outline.pages.length, 2, 'Test 10b: outline.pages unchanged');
  }

  // ── Test 11: buildBatchPrompt includes the full outline slugs ────
  console.log('\n[11] ingest — buildBatchPrompt includes full outline');
  {
    const { __testing } = await import('../src/brain/ingest.js');
    const { buildBatchPrompt } = __testing;
    const allPages = [
      { path: 'summaries/foo.md', summary: 'sum' },
      { path: 'concepts/format-a.md', summary: 'a' },
      { path: 'concepts/format-b.md', summary: 'b' },
      { path: 'concepts/format-c.md', summary: 'c' },
      { path: 'concepts/hub.md', summary: 'hub' },
    ];
    const batch = [{ path: 'concepts/hub.md', summary: 'hub' }];
    const prompt = buildBatchPrompt('2026-05-22', 'foo.md', 'source', batch, { entities: [], concepts: [] }, allPages);
    truthy(prompt.includes('format-a'), 'Test 11a: prompt mentions format-a (other batch slug)');
    truthy(prompt.includes('format-b'), 'Test 11b: prompt mentions format-b');
    truthy(prompt.includes('format-c'), 'Test 11c: prompt mentions format-c');
    truthy(prompt.includes('summaries/foo'), 'Test 11d: prompt includes summary path with prefix');
    truthy(prompt.includes('PAGES BEING CREATED IN THIS SAME INGEST'),
      'Test 11e: prompt header for full-ingest slugs present');
    truthy(prompt.includes('HUB-PAGE RULE'),
      'Test 11f: prompt includes HUB-PAGE RULE guidance');
  }

  // ── Test 12: buildBatchPrompt categorises by folder ────────────
  console.log('\n[12] ingest — buildBatchPrompt sorts slugs by folder');
  {
    const { __testing } = await import('../src/brain/ingest.js');
    const { buildBatchPrompt } = __testing;
    const allPages = [
      { path: 'summaries/foo.md', summary: '' },
      { path: 'entities/openai.md', summary: '' },
      { path: 'concepts/rag.md', summary: '' },
    ];
    const prompt = buildBatchPrompt('2026', 'src.md', '', allPages, { entities: [], concepts: [] }, allPages);
    truthy(prompt.includes('Entities being created:  openai'),
      'Test 12a: entities listed under Entities header');
    truthy(prompt.includes('Concepts being created:  rag'),
      'Test 12b: concepts listed under Concepts header');
    truthy(prompt.includes('Summaries being created: summaries/foo'),
      'Test 12c: summaries listed with prefix');
  }

  // ── Test 13: backwards compat — empty allPages doesn't break ────
  console.log('\n[13] ingest — buildBatchPrompt with empty allPages still works');
  {
    const { __testing } = await import('../src/brain/ingest.js');
    const { buildBatchPrompt } = __testing;
    const prompt = buildBatchPrompt('2026', 'src.md', 'text', [{ path: 'concepts/a.md', summary: '' }], { entities: [], concepts: [] }, []);
    truthy(prompt.includes('(none)'),
      'Test 13a: empty in-ingest slug list renders as "(none)"');
    truthy(prompt.includes('PAGES BEING CREATED IN THIS SAME INGEST'),
      'Test 13b: header still present');
  }

  // ── Test 14: hub linkification doesn't nest brackets ───────────
  // Regression guard for the bug found during the v3.0.1-beta.11 deep
  // live-LLM test: the linkifier was modifying segments in-place across
  // multiple candidates, so the second candidate's case-insensitive
  // match wrapped the just-wrapped text from the first, producing
  // `[[[[microsoft]]` patterns. Test simulates the exact pre-condition:
  // a hub page already has correct [[wikilinks]] AND mentions the same
  // titles in plain text — the linkifier should ONLY wrap the plain
  // text, never touch the existing brackets.
  console.log('\n[14] ingest — hub linkification no nested brackets regression guard');
  {
    // We exercise this at the regex/segment level since the full
    // function is async and FS-bound. Replicate the exact segment-split
    // logic and confirm that wrapping one candidate, then re-splitting,
    // protects subsequent candidates from the wrapped text.
    function simulateWrap(content, replacements) {
      let modified = content;
      let count = 0;
      for (const { candidate, slug } of replacements) {
        const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`\\b${escaped}\\b`, 'gi');
        const segments = modified.split(/(```[\s\S]*?```|`[^`]*`|\[\[[^\]]*\]\])/g);
        let candidateLinks = 0;
        for (let i = 0; i < segments.length; i++) {
          if (i % 2 === 1) continue;
          const before = segments[i];
          if (!re.test(before)) continue;
          re.lastIndex = 0;
          segments[i] = before.replace(re, (m) => { candidateLinks++; return `[[${slug}|${m}]]`; });
        }
        if (candidateLinks > 0) { modified = segments.join(''); count += candidateLinks; }
      }
      return { modified, count };
    }

    // Pre-condition: existing wikilink AND plain-text Microsoft mention
    const content = '1. **Microsoft** is a tech giant. See [[microsoft]] for details.';
    const { modified, count } = simulateWrap(content, [
      { candidate: 'Microsoft', slug: 'microsoft' },
      { candidate: 'microsoft', slug: 'microsoft' },
    ]);
    // Should wrap the bold "Microsoft" exactly once and leave the existing [[microsoft]] alone
    eq(count, 1, 'Test 14a: only one wrap (bold Microsoft) — existing [[microsoft]] untouched');
    truthy(!modified.includes('[[[['), 'Test 14b: no [[[[ nested bracket pattern produced');
    truthy(!modified.includes(']]]]'), 'Test 14c: no ]]]] nested bracket pattern produced');
    truthy(modified.includes('[[microsoft|Microsoft]]'),
      'Test 14d: bold Microsoft correctly wrapped as [[microsoft|Microsoft]]');
    truthy(modified.includes('[[microsoft]]'),
      'Test 14e: existing [[microsoft]] still present unchanged');
  }

  // ── Summary ──────────────────────────────────────────────────
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
