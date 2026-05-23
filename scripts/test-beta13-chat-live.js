#!/usr/bin/env node
/**
 * Live LLM chat regression test for v3.0.1-beta.13.
 *
 * Runs the full chat pipeline (selectRelevantPages → buildPrompt →
 * Gemini Flash) against the user's REAL articles domain. Read-only —
 * does NOT write to conversations folder, does NOT modify any wiki page.
 *
 * Each scenario runs TWICE for stability. Both runs must pass the
 * assertions; consistent failures across both runs indicate a real bug,
 * single-run failures suggest LLM stochasticity (we warn but don't fail
 * unless both runs miss).
 *
 * Run:
 *   node scripts/test-beta13-chat-live.js
 *
 * Requires GEMINI_API_KEY in env or .curator-config.json.
 *
 * Exits non-zero if any scenario fails both runs. The articles wiki is
 * untouched.
 */

import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

// Pick up the user's API key from .curator-config.json if not in env.
if (!process.env.GEMINI_API_KEY) {
  const cfgPath = path.join(PROJECT_ROOT, '.curator-config.json');
  if (existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
      if (cfg.geminiApiKey) {
        process.env.GEMINI_API_KEY = cfg.geminiApiKey;
        console.log('[live test] Using GEMINI_API_KEY from .curator-config.json');
      }
    } catch { /* ignore */ }
  }
}

if (!process.env.GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY not configured. Set it in .env or .curator-config.json.');
  process.exit(2);
}

let scenarioResults = [];

async function main() {
  const { selectRelevantPages, buildSummaryToEntitiesIndex, __testing } = await import('../src/brain/chat.js');
  const { buildPrompt } = __testing;
  const { readWikiPages } = await import('../src/brain/files.js');
  const { generateText } = await import('../src/brain/llm.js');
  const { readSchema } = await import('../src/brain/files.js');

  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('  v3.0.1-beta.13 live chat regression test');
  console.log('  Reads the real "articles" wiki — NO writes, NO modifications');
  console.log('═══════════════════════════════════════════════════════════════════════');

  const t0 = Date.now();
  const pages = await readWikiPages('articles');
  const tLoad = ((Date.now() - t0) / 1000).toFixed(2);
  console.log(`\nLoaded ${pages.length} wiki pages from articles domain in ${tLoad}s`);

  if (pages.length < 100) {
    console.error(`articles domain has only ${pages.length} pages — expected 1000+. Aborting.`);
    process.exit(2);
  }

  const schema = await readSchema('articles');

  // Pre-compute summary→entities index for analysis.
  const summaryToEntities = buildSummaryToEntitiesIndex(pages);
  let taliRefCount = 0;
  for (const ents of summaryToEntities.values()) if (ents.has('tali-rezun')) taliRefCount++;
  console.log(`\nGround truth: ${taliRefCount} summaries reference [[tali-rezun]] in the wiki.`);

  /**
   * Run a single chat turn: build prompt, call LLM, parse citations.
   * NEVER writes to conversation history.
   */
  async function runChatTurn(domain, query, history = []) {
    const prompt = buildPrompt(domain, pages, history, query);
    const start = Date.now();
    let answer;
    try {
      answer = await generateText(schema, prompt, 4096);
    } catch (err) {
      return { error: err.message, elapsed: ((Date.now() - start) / 1000).toFixed(1) };
    }
    const citations = [...answer.matchAll(/\[source:\s*([^\]]+)\]/g)].map(m => m[1].trim());
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const promptSizeKB = (prompt.length / 1024).toFixed(1);
    return { answer, citations, elapsed, promptSizeKB };
  }

  /**
   * Verify that selectRelevantPages produces sane retrieval for a query.
   * Returns analytical info without calling the LLM.
   */
  function analyzeRetrieval(query) {
    const result = selectRelevantPages(pages, query);
    return result;
  }

  // ── Test scenarios ────────────────────────────────────────────────────
  const scenarios = [
    {
      name: 'L1-enumerate-by-author',
      query: 'What articles have I ingested by Dr. Tali Rezun? List them all with their titles.',
      intent: 'enumerate',
      expectations: [
        {
          name: 'cites at least 15 unique summaries',
          check: (r) => {
            const uniqueSummaries = new Set(r.citations.filter(c => c.startsWith('summaries/')).map(c => c.replace(/\.md$/, '')));
            return {
              pass: uniqueSummaries.size >= 15,
              actual: `${uniqueSummaries.size} unique summary citations`,
              expected: '≥15',
            };
          },
        },
        {
          name: 'response mentions Tali Rezun directly',
          check: (r) => ({
            pass: /tali\s+rez/i.test(r.answer),
            actual: 'response references Tali Rezun (or variant)',
          }),
        },
      ],
    },
    {
      name: 'L2-synthesis-RAG',
      query: 'What does my wiki say about RAG vs long-context windows? Cite specific articles.',
      intent: 'synthesis',
      expectations: [
        {
          name: 'cites at least 2 relevant summaries',
          check: (r) => {
            const ragCitations = r.citations.filter(c =>
              c.toLowerCase().includes('rag') ||
              c.toLowerCase().includes('context') ||
              c.toLowerCase().includes('ditched'));
            return {
              pass: ragCitations.length >= 2,
              actual: `${ragCitations.length} rag-related citations`,
              expected: '≥2',
            };
          },
        },
        {
          name: 'response contains substantive content (not a refusal)',
          check: (r) => ({
            pass: r.answer.length > 200 && !/not in the wiki|don't have/i.test(r.answer.slice(0, 200)),
            actual: `response length ${r.answer.length} chars`,
          }),
        },
      ],
    },
    {
      name: 'L3-entity-pivot-COTRUGLI',
      query: 'Tell me about COTRUGLI Business School and what content my wiki has about it.',
      intent: 'synthesis',
      expectations: [
        {
          name: 'response references COTRUGLI',
          check: (r) => ({
            pass: /cotrugli/i.test(r.answer),
            actual: 'COTRUGLI referenced in response',
          }),
        },
      ],
    },
    {
      name: 'L4-count-query',
      query: 'How many articles by Dr. Tali Rezun do I have in this domain?',
      intent: 'enumerate',
      expectations: [
        {
          name: 'response contains a specific number',
          check: (r) => ({
            pass: /\b(\d{2,3})\b/.test(r.answer),
            actual: 'response contains a 2-3 digit number',
          }),
        },
      ],
    },
    {
      name: 'L5-niche-detail',
      query: "What does my wiki say about the energy and water footprint of generative AI? Cite specific numbers if any.",
      intent: 'synthesis',
      expectations: [
        {
          name: 'cites the energy article',
          check: (r) => ({
            pass: r.citations.some(c =>
              c.toLowerCase().includes('energy') ||
              c.toLowerCase().includes('water') ||
              c.toLowerCase().includes('footprint')),
            actual: r.citations.length + ' total citations',
          }),
        },
      ],
    },
  ];

  // ── Run each scenario TWICE for stability ─────────────────────────────
  for (const scenario of scenarios) {
    console.log(`\n${'═'.repeat(72)}`);
    console.log(`  ${scenario.name}`);
    console.log('═'.repeat(72));
    console.log(`Query: ${scenario.query}`);

    // Show retrieval analysis (deterministic, fast — done once)
    const ret = analyzeRetrieval(scenario.query);
    console.log(`\nRetrieval analysis:`);
    console.log(`  Pivots: ${ret.pivotCount} ${ret.pivotSlugs.length ? '(' + ret.pivotSlugs.slice(0, 5).join(', ') + ')' : ''}`);
    console.log(`  Keyword-scored: ${ret.scoredCount}`);
    console.log(`  Loaded in full: ${ret.selected.length} pages, ${(ret.contentBytes/1024).toFixed(1)} KB`);

    const runResults = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      console.log(`\n--- Run ${attempt}/2 ---`);
      const result = await runChatTurn('articles', scenario.query);
      if (result.error) {
        console.log(`  Error: ${result.error}`);
        runResults.push({ attempt, error: result.error, passes: 0, total: scenario.expectations.length });
        continue;
      }
      console.log(`  Response: ${result.elapsed}s, prompt ${result.promptSizeKB} KB, ${result.citations.length} citations`);
      console.log(`  First 200 chars: ${result.answer.slice(0, 200)}…`);

      let passes = 0;
      const failures = [];
      for (const exp of scenario.expectations) {
        const r = exp.check(result);
        if (r.pass) {
          passes++;
          console.log(`    ✓ ${exp.name} — ${r.actual || ''}`);
        } else {
          console.log(`    ✗ ${exp.name} — ${r.actual || ''} (expected: ${r.expected || ''})`);
          failures.push(exp.name);
        }
      }
      runResults.push({ attempt, passes, total: scenario.expectations.length, failures, citations: result.citations });
    }

    // Aggregate: scenario passes if BOTH runs pass all expectations
    const bothPass = runResults.every(r => r.passes === r.total && !r.error);
    const oneRunPass = runResults.some(r => r.passes === r.total && !r.error);
    scenarioResults.push({
      name: scenario.name,
      bothPass,
      oneRunPass,
      runs: runResults,
    });
    console.log(`\n  Scenario verdict: ${bothPass ? '✓ both runs PASS' : oneRunPass ? '⚠ one run pass (LLM variance)' : '✗ both runs FAIL'}`);
  }

  // ── Final summary ────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(72)}`);
  console.log('  Summary');
  console.log('═'.repeat(72));
  let bothPass = 0, oneRunPass = 0, failedBoth = 0;
  for (const sr of scenarioResults) {
    if (sr.bothPass) bothPass++;
    else if (sr.oneRunPass) oneRunPass++;
    else failedBoth++;
    const status = sr.bothPass ? '✓✓' : sr.oneRunPass ? '✓-' : '✗✗';
    console.log(`  ${status} ${sr.name}`);
  }
  console.log(`\n  Scenarios all-pass: ${bothPass} / ${scenarioResults.length}`);
  console.log(`  Scenarios one-pass (LLM variance): ${oneRunPass}`);
  console.log(`  Scenarios both-fail: ${failedBoth}`);

  process.exit(failedBoth === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(2);
});
