#!/usr/bin/env node
/**
 * test-ingest-prompt-slimming.js — OFFLINE suite for the v3.0.16 ingest
 * prompt-size work. Deterministic, no network, no API key, no writes.
 *
 * What is under test, and why each part matters:
 *
 *   A. index.md IS still embedded in the outline / single-pass prompts.
 *      (Removing it was implemented and measured at -39.1% on the outline
 *      prompt, then DEFERRED before shipping v3.0.16 — it was only -16.2% of
 *      total ingest input vs caching's -30.3%, and was the sole change to what
 *      the model sees, which live testing could not clear. See the assertions
 *      below: they now guard that the index is PRESENT.)
 *      Measured on the real `articles` domain that was 121 KB of markdown table
 *      per request. Same removal, same reasoning as v3.0.1-beta.25 did for
 *      compile.js. The grounding inputs the model actually needs — the entity /
 *      concept FILENAME lists and the forced summary path — must survive.
 *
 *   B. The slug inventory is capped by a CHARACTER budget and ranked by token
 *      overlap with the source. The correctness risk runs one way: dropping a
 *      slug the source discusses is what CAUSES a duplicate page, so
 *      high-overlap slugs must survive and zero-overlap slugs must be the ones
 *      dropped. Below budget the cap must be a byte-level no-op, which is what
 *      keeps the blast radius off small/fresh domains. Truncation must be
 *      visible in warnings[] — never silent.
 *
 *   C. The Phase 2 batch prompt is split [stable prefix | volatile page list] so
 *      the prefix is cacheable, and an Anthropic cache breakpoint is only ever
 *      set where it can pay back the 1.25x write premium (>= 2 calls).
 *
 *   D. generateText reports real token usage via opts.onUsage, without changing
 *      its bare-string return type, and a throwing callback can never break a
 *      call.
 *
 * Run:  node scripts/test-ingest-prompt-slimming.js
 * Exit: 0 if all green; non-zero on any failure.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  aggregateWarnings,
  WARNING_AGGREGATION_THRESHOLD,
  capSlugInventory,
  capExistingFilesForPrompt,
  makeUsageAccumulator,
  reconcileGeneratedPages,
  SLUG_INVENTORY_BUDGET_CHARS,
  __testing as ingestTesting,
} from '../src/brain/ingest.js';
import { writePage } from '../src/brain/files.js';
import { __setDomainsDirOverride } from '../src/brain/config.js';
import { mkdtempSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import {
  buildAnthropicUserContent,
  normalizeGeminiUsage,
  normalizeAnthropicUsage,
  ANTHROPIC_CACHE_MIN_PREFIX_CHARS,
  ANTHROPIC_MAX_OUTPUT_TOKENS,
  __testing as llmTesting,
} from '../src/brain/llm.js';
import { tokenize } from '../src/brain/sharedbrain-delta.js';

const { buildOutlinePrompt, buildPrompt, buildBatchPrompt, buildBatchPromptParts, slugLineCost } = ingestTesting;
const { reportUsage } = llmTesting;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; failures.push(label); console.log(`  ✗ ${label}`); }
}
function eq(a, b, label) { ok(a === b, `${label} (got ${JSON.stringify(a)})`); }
function section(t) { console.log(`\n${t}`); }

// ── Fixtures ────────────────────────────────────────────────────────────────
const TODAY = '2026-08-22';
const SUMMARY_PATH = 'summaries/test-source.md';
const INDEX_MARKER = 'ZZINDEXMARKER';
const BIG_INDEX = '# Index\n\n| Page | Type | Summary |\n|---|---|---|\n' +
  Array.from({ length: 400 }, (_, i) =>
    `| [[entities/legacy-page-${i}]] | entity | ${INDEX_MARKER} description number ${i} with padding |`
  ).join('\n') + '\n';

const SMALL_FILES = {
  entities: ['tali-rezun.md', 'acme-corp.md'],
  concepts: ['retrieval-augmented-generation.md'],
};
const SOURCE_TEXT =
  'Tali Rezun writes about retrieval augmented generation at Acme Corp. ' +
  'The article discusses vector databases and embeddings at length.';

// ── 1. index.md is PRESENT in the outline / single-pass prompts ────────────
// Removing it was implemented, measured, and DEFERRED (v3.0.16): it saved ~16%
// of the canonical request, but it is the only piece of the prompt-slimming work
// that changes WHAT the model sees rather than the order it sees it in, and a
// paired live A/B (n=3 per arm, Gemini) could not resolve its effect on
// broken-wikilink rate or page count in either direction. The caching + reorder
// work is worth ~2x as much and changes only ordering, so that shipped and this
// did not.
//
// These assertions are therefore a REGRESSION GUARD in the opposite direction:
// the two builders must stay byte-identical to v3.0.15, index included. Do not
// flip them back without the measurement power the first attempt lacked.
section('1. index.md is still embedded in the outline / single-pass prompts (removal deferred)');
{
  const outline = buildOutlinePrompt(TODAY, BIG_INDEX, SMALL_FILES, 'test-source.pdf', SOURCE_TEXT, false, SUMMARY_PATH);
  const single  = buildPrompt(TODAY, BIG_INDEX, SMALL_FILES, 'test-source.pdf', SOURCE_TEXT, false, false, SUMMARY_PATH);

  ok(outline.includes(INDEX_MARKER), 'outline prompt: index content IS embedded');
  ok(outline.includes('Current wiki index:'), 'outline prompt: the "Current wiki index" header is present');
  ok(single.includes(INDEX_MARKER), 'single-pass prompt: index content IS embedded');
  ok(single.includes('Current wiki index:'), 'single-pass prompt: the "Current wiki index" header is present');
  ok(outline.includes(BIG_INDEX), 'outline prompt: the index is embedded in full, not truncated');
  ok(single.includes(BIG_INDEX), 'single-pass prompt: the index is embedded in full, not truncated');

  // The empty-index placeholder is part of the v3.0.15 contract too.
  const empty = buildOutlinePrompt(TODAY, '', SMALL_FILES, 'test-source.pdf', SOURCE_TEXT, false, SUMMARY_PATH);
  ok(empty.includes('(empty — this is the first ingest)'),
    'outline prompt: an empty index still renders the first-ingest placeholder');

  // Grounding inputs that must be present regardless of the index question.
  ok(outline.includes('  entities/tali-rezun.md') && outline.includes('  concepts/retrieval-augmented-generation.md'),
    'outline prompt: entity + concept filename lists retained');
  ok(single.includes('  entities/tali-rezun.md') && single.includes('  concepts/retrieval-augmented-generation.md'),
    'single-pass prompt: entity + concept filename lists retained');
  ok(outline.includes(SUMMARY_PATH), 'outline prompt: forced summary path retained');
  ok(single.includes(SUMMARY_PATH), 'single-pass prompt: forced summary path retained');
  ok(outline.includes('REQUIRED COVERAGE') && single.includes('REQUIRED COVERAGE'),
    'both prompts: REQUIRED COVERAGE contract retained');
  ok(single.includes('DO NOT touch index.md'),
    'single-pass prompt: the index is still the app\'s job to maintain (programmatic mergeIntoIndex)');
  ok(outline.includes(SOURCE_TEXT) && single.includes(SOURCE_TEXT),
    'both prompts: the source document is still embedded');

  // Source guard: the parameter must be named `index` and actually used, so a
  // future refactor cannot quietly orphan it again.
  const src = readFileSync(path.join(ROOT, 'src/brain/ingest.js'), 'utf8');
  ok(/function buildOutlinePrompt\(today, index,/.test(src), 'buildOutlinePrompt takes `index` (not an ignored `_index`)');
  ok(/function buildPrompt\(today, index,/.test(src), 'buildPrompt takes `index` (not an ignored `_index`)');
  eq((src.match(/Current wiki index:/g) || []).length, 2, 'the index block appears in exactly the two prompts that had it in v3.0.15');
}

// ── 2. B — the cap is a byte-level no-op below budget ───────────────────────
section('2. B — below the budget, capping changes nothing (small/fresh domains)');
{
  const capped = capExistingFilesForPrompt(SMALL_FILES, SOURCE_TEXT);
  eq(capped.warnings.length, 0, 'small domain → no truncation warning');
  eq(JSON.stringify(capped.files.entities), JSON.stringify(SMALL_FILES.entities), 'entity list unchanged (same order)');
  eq(JSON.stringify(capped.files.concepts), JSON.stringify(SMALL_FILES.concepts), 'concept list unchanged (same order)');

  // The load-bearing assertion: the RENDERED prompt is byte-identical whether
  // built from the raw on-disk lists or the capped ones.
  for (const [name, build] of [
    ['outline', f => buildOutlinePrompt(TODAY, '', f, 'src.pdf', SOURCE_TEXT, false, SUMMARY_PATH)],
    ['single-pass', f => buildPrompt(TODAY, '', f, 'src.pdf', SOURCE_TEXT, false, false, SUMMARY_PATH)],
    ['batch', f => buildBatchPrompt(TODAY, 'src.pdf', SOURCE_TEXT, [{ path: 'concepts/x.md', summary: 's' }], f, [])],
  ]) {
    ok(build(SMALL_FILES) === build(capped.files), `${name} prompt is byte-identical below the budget`);
  }

  // Degenerate inputs must not throw or invent entries.
  eq(capSlugInventory([], new Set()).files.length, 0, 'empty list → empty result');
  eq(capSlugInventory(null, new Set()).omitted, 0, 'null list → no omissions');
  eq(capSlugInventory(['a.md', null, 42, ''], new Set()).files.length, 1, 'non-string entries are dropped, not rendered');
  eq(capExistingFilesForPrompt(null, null).warnings.length, 0, 'null inputs → no warnings, no throw');
}

// ── 3. B — relevance ranking: high-overlap survives, zero-overlap is dropped ─
section('3. B — the cap keeps source-relevant slugs and drops the zero-overlap tail');
{
  // A source about water/energy in AI datacentres, plus a large inventory of
  // slugs that have nothing to do with it. Total renders far over the budget,
  // so the cap must fire — and must keep exactly the relevant ones.
  const source = `The energy and water footprint of generative AI. Datacentre cooling
    consumes potable water. Nvidia GPUs draw enormous power. The International Energy
    Agency projects datacentre electricity demand doubling. Microsoft and Google publish
    sustainability reports covering carbon emissions and water withdrawal.`;

  const relevant = [
    'datacentre-cooling.md', 'water-footprint.md', 'nvidia.md',
    'international-energy-agency.md', 'carbon-emissions.md', 'microsoft.md',
  ];
  // ~3,000 irrelevant slugs → ~120 KB rendered, far over the 24 KB budget.
  const irrelevant = Array.from({ length: 3000 }, (_, i) => `medieval-heraldry-topic-${i}.md`);
  const files = [...irrelevant.slice(0, 1500), ...relevant, ...irrelevant.slice(1500)];

  // EXPLICIT budget: the shipped default (160,000) is a safety valve that does
  // not fire on any real domain, so truncation behaviour must be driven by an
  // explicit argument or this test would silently stop testing anything.
  const TEST_BUDGET = 24_000;
  const tokens = new Set(tokenize(source));
  const r = capSlugInventory(files, tokens, TEST_BUDGET);

  ok(r.omitted > 0, `the cap fires on an oversized inventory (${r.omitted} omitted of ${files.length})`);
  const keptSet = new Set(r.files);
  for (const slug of relevant) ok(keptSet.has(slug), `high-overlap slug survives the cap: ${slug}`);
  ok(r.files.filter(f => f.startsWith('medieval-heraldry')).length < irrelevant.length,
    'zero-overlap slugs are the ones dropped');

  // The budget is a CHARACTER budget — that is what drives cost.
  const renderedChars = r.files.reduce((n, f) => n + slugLineCost(f), 0);
  ok(renderedChars <= TEST_BUDGET,
    `kept set fits the character budget (${renderedChars} <= ${TEST_BUDGET})`);
  ok(renderedChars > TEST_BUDGET * 0.8,
    'the budget is actually filled, not under-used');

  // Order is preserved (on-disk order), which keeps the rendered prompt stable.
  const idx = r.files.map(f => files.indexOf(f));
  ok(idx.every((v, i) => i === 0 || v > idx[i - 1]), 'kept entries keep their original on-disk order');
}

// ── 4. B — determinism ──────────────────────────────────────────────────────
section('4. B — ranking is fully deterministic (unit-testable, stable prompts)');
{
  // Many slugs with IDENTICAL scores, so the result depends entirely on the
  // tie-break chain (cost, then original index) rather than sort instability.
  const files = Array.from({ length: 2000 }, (_, i) => `identical-token-slug-${i}.md`);
  const tokens = new Set(tokenize('nothing here matches at all'));
  const DET_BUDGET = 24_000;   // explicit — the shipped default would not fire
  const a = capSlugInventory(files, tokens, DET_BUDGET);
  const b = capSlugInventory(files, tokens, DET_BUDGET);
  const c = capSlugInventory(files.slice(), new Set(tokenize('nothing here matches at all')), DET_BUDGET);
  eq(JSON.stringify(a.files), JSON.stringify(b.files), 'same inputs → identical kept set (run twice)');
  eq(JSON.stringify(a.files), JSON.stringify(c.files), 'same inputs → identical kept set (fresh token set + array copy)');
  ok(a.kept + a.omitted === files.length, 'kept + omitted accounts for every input entry');

  // Duplicated filenames must not corrupt the index-based tie-break.
  const dup = ['same.md', 'same.md', 'same.md'];
  eq(capSlugInventory(dup, tokens, 10_000).files.length, 3, 'duplicate filenames are preserved, not deduped');
}

// ── 5. B — truncation is VISIBLE (never a silent cap) ───────────────────────
section('5. B — truncation surfaces a user-visible warning');
{
  const big = {
    entities: Array.from({ length: 3000 }, (_, i) => `entity-slug-number-${i}.md`),
    concepts: Array.from({ length: 3000 }, (_, i) => `concept-slug-number-${i}.md`),
  };
  const WARN_BUDGET = 24_000;  // explicit — the shipped default would not fire
  const capped = capExistingFilesForPrompt(big, 'a source about something else entirely', WARN_BUDGET);
  eq(capped.warnings.length, 2, 'both lists truncated → one warning each');
  ok(capped.warnings.some(w => /entity pages/.test(w)), 'warning names the entity list');
  ok(capped.warnings.some(w => /concept pages/.test(w)), 'warning names the concept list');
  ok(capped.warnings.every(w => /\d+ of \d+/.test(w)), 'warning states how many of how many were left out');
  ok(capped.warnings.every(w => /Health tab/.test(w)), 'warning tells the user what to do if a duplicate appears');

  // Mixed case: one list over budget, the other under → exactly one warning.
  const mixed = capExistingFilesForPrompt({ entities: ['a.md'], concepts: big.concepts }, 'source', WARN_BUDGET);
  eq(mixed.warnings.length, 1, 'only the truncated list warns');
  eq(mixed.files.entities.length, 1, 'the under-budget list is untouched');
}

// ── 5b. The DEFAULT budget is a SAFETY VALVE — it must not fire on real data ─
// A controlled A/B on the real articles domain measured that capping at 24,000
// chars made Anthropic's broken-wikilink rate 2.2x WORSE (4.3% → 9.2%), because
// claude-haiku-4-5 grounds its links in the slug list. The budget was raised so
// nothing real reaches it. This section is the regression guard against someone
// "helpfully" tuning it back down to save tokens.
section('5b. The DEFAULT budget does not truncate a real articles-scale domain');
{
  // Reproduces the measured shape of the real articles domain (2026-08-22):
  //   600 entity files  → ~16,145 rendered chars
  //   2,651 concept files → ~112,180 rendered chars
  // nameLen is the FULL filename length including ".md"; rendered cost is
  // nameLen + 12 (2 indent + 9 folder + 1 newline), so the real domain's
  // ~26.9 and ~42.3 chars/entry correspond to nameLen 15 and 31.
  const mkList = (n, nameLen, prefix) => Array.from({ length: n }, (_, i) => {
    const suffix = `-${i}.md`;
    const fill = Math.max(1, nameLen - prefix.length - suffix.length);
    return prefix + 'x'.repeat(fill) + suffix;
  });
  const realish = {
    entities: mkList(600, 15, 'e-'),      // → ~27 chars/entry, matching articles
    concepts: mkList(2651, 31, 'c-'),     // → ~43 chars/entry, matching articles
  };
  const entChars = realish.entities.reduce((n, f) => n + slugLineCost(f), 0);
  const conChars = realish.concepts.reduce((n, f) => n + slugLineCost(f), 0);
  ok(entChars >= 16_000, `the entity fixture is at least articles-scale (${entChars} chars)`);
  ok(conChars >= 112_000, `the concept fixture is at least articles-scale (${conChars} chars)`);

  const capped = capExistingFilesForPrompt(realish, 'a source about anything at all');
  eq(capped.warnings.length, 0, 'the DEFAULT budget produces NO truncation on an articles-scale domain');
  eq(capped.files.entities.length, 600, 'all 600 entity slugs survive at the default budget');
  eq(capped.files.concepts.length, 2651, 'all 2,651 concept slugs survive at the default budget');
  ok(SLUG_INVENTORY_BUDGET_CHARS > conChars,
    `the default budget (${SLUG_INVENTORY_BUDGET_CHARS}) exceeds the largest real list (${conChars} chars)`);
  // Headroom, both directions: enough that a growing wiki does not trip it, but
  // not so much that the valve could never prevent a context overflow.
  ok(SLUG_INVENTORY_BUDGET_CHARS >= conChars * 1.35,
    'the default budget leaves >=1.35x headroom over the largest real list');
  // Upper bound: the valve must still bound the largest controllable term. It
  // cannot guarantee the whole request fits — index.md is also unbounded and has
  // no cap — but a budget above this makes the valve meaningless.
  ok(SLUG_INVENTORY_BUDGET_CHARS <= 200_000,
    'the default budget still bounds unbounded growth (the inventory term stays inside the tightest context window)');

  // ...and it still fires when a domain really is pathological.
  const pathological = { entities: [], concepts: mkList(20_000, 42, 'concept-') };
  const p2 = capExistingFilesForPrompt(pathological, 'source text');
  ok(p2.warnings.length === 1, 'a 20,000-page folder DOES trip the valve (that is what it is for)');
  ok(p2.files.concepts.length < 20_000 && p2.files.concepts.length > 0,
    'the pathological case degrades to a bounded list rather than hard-failing');
  ok(p2.warnings[0].includes('exceed what the AI can read at once'),
    'the warning explains WHY it happened, in the user\'s terms');
}

// ── 6. C — the batch prompt's volatile page list is LAST ────────────────────
section('6. C — batch prompt: stable prefix first, per-batch page list last');
{
  const files = { entities: ['alice.md'], concepts: ['llm.md'] };
  const allPages = [
    { path: SUMMARY_PATH, summary: 'the source' },
    { path: 'entities/alice.md', summary: 'author' },
    { path: 'concepts/llm.md', summary: 'a concept' },
    { path: 'concepts/agents.md', summary: 'another concept' },
  ];
  const batch1 = allPages.slice(0, 2);
  const batch2 = allPages.slice(2);

  const p1 = buildBatchPromptParts(TODAY, 'src.pdf', SOURCE_TEXT, batch1, files, allPages);
  const p2 = buildBatchPromptParts(TODAY, 'src.pdf', SOURCE_TEXT, batch2, files, allPages);

  eq(p1.prefix, p2.prefix, 'the prefix is byte-identical across batches (this is what makes it cacheable)');
  ok(p1.suffix !== p2.suffix, 'the suffix differs per batch');
  eq(p1.prefix + p1.suffix, buildBatchPrompt(TODAY, 'src.pdf', SOURCE_TEXT, batch1, files, allPages),
    'prefix + suffix reproduces buildBatchPrompt exactly');

  // The prefix must carry ZERO batch-specific content, or nothing caches.
  ok(!p1.prefix.includes('entities/alice.md"'), 'prefix contains no batch page-list entry');
  ok(!p1.prefix.includes('Write the full markdown content'), 'the per-batch ask lives in the suffix');
  ok(p1.suffix.includes('"path": "entities/alice.md"'), 'suffix carries this batch\'s page list');

  const whole = p1.prefix + p1.suffix;
  ok(whole.indexOf('Write the full markdown content') > whole.indexOf('END SOURCE DOCUMENT'),
    'page list comes AFTER the source document');
  ok(whole.indexOf('Write the full markdown content') > whole.indexOf('EXISTING WIKI FILES'),
    'page list comes AFTER the existing-files inventory');
  ok(whole.indexOf('Write the full markdown content') > whole.indexOf('CROSS-FOLDER RULE'),
    'page list comes AFTER the folder rules');

  // The batch prompt has NEVER contained index.md — that is exactly why the
  // index question above does not touch it, and why the prefix stays small
  // enough to be worth caching. If someone ever adds the index here, a ~121 KB
  // block lands in the cacheable prefix of every batch call.
  const withIndex = buildBatchPromptParts(TODAY, 'src.pdf', SOURCE_TEXT, batch1, files, allPages);
  ok(!withIndex.prefix.includes('Current wiki index:'),
    'the batch prefix contains no index block (keeps the cacheable prefix small)');
  ok(!withIndex.suffix.includes('Current wiki index:'), 'nor does the batch suffix');
  ok(!(withIndex.prefix + withIndex.suffix).includes(INDEX_MARKER),
    'no index CONTENT reaches the batch prompt by any route');

  // AUDIT FINDING 1 — the pageBatch move broke a directional referent. The
  // sentence about reusing per-page summaries said "listed above", but the only
  // thing ever listed above it was the page list, which moved into the SUFFIX.
  // The model then stops reusing the outline's summary and the index description
  // column degrades. Every directional referent must point the right way.
  ok(!/listed above with a\s+summary/.test(p1.prefix), 'the stale "listed above" referent is gone');
  ok(/listed BELOW already comes\s*\n?with a summary/.test(p1.prefix) || /page listed BELOW/.test(p1.prefix),
    'the summary-reuse rule now points BELOW, where the page list actually is');
  ok(p1.prefix.includes('Where a page listed BELOW'),
    'the summary-reuse rule stays in the PREFIX (moving it would break prefix stability)');
  {
    // Sweep BOTH blocks for referents that the move could have inverted.
    const whole2 = p1.prefix + p1.suffix;
    const idx = (t) => whole2.indexOf(t);
    ok(idx('exact slugs listed below') < idx('EXISTING WIKI FILES'),
      'HUB-PAGE RULE\'s "listed below" still precedes the slug lists it refers to');
    ok(idx('even if a slug below is not in the batch') < idx('Entities being created:'),
      '"a slug below" still precedes the in-this-ingest lists');
    ok(idx('three prefixes above') > idx('• summaries/'),
      '"three prefixes above" still follows the folder bullet list');
  }

  // Everything the batch prompt already guaranteed must still hold.
  ok(p1.prefix.includes('Existing entities: alice'), 'batch prompt still grounds against existing entities');
  ok(p1.prefix.includes('Concepts being created:'), 'batch prompt still lists pages created by sibling batches');
  ok(whole.includes('"summary": "1-line description for the index"'), 'batch prompt still requests per-page summaries');
}

// ── 7. C — Anthropic cache breakpoint placement ────────────────────────────
section('7. C — cache_control is only placed where it can pay for itself');
{
  const long = 'x'.repeat(ANTHROPIC_CACHE_MIN_PREFIX_CHARS + 500);
  const prompt = long + 'VOLATILE-SUFFIX';

  const content = buildAnthropicUserContent(prompt, long.length);
  ok(Array.isArray(content), 'a long stable prefix → split into two content blocks');
  eq(content.length, 2, 'exactly two blocks');
  eq(content[0].cache_control.type, 'ephemeral', 'the breakpoint sits on the stable prefix');
  ok(!content[1].cache_control, 'the volatile suffix carries no breakpoint');
  eq(content[0].text + content[1].text, prompt, 'the two blocks concatenate to the original prompt byte for byte');

  // Below the model minimum, Anthropic silently declines to cache — so never
  // bother splitting. (claude-haiku-4-5, the Curator default, needs 4096 tokens.)
  eq(typeof buildAnthropicUserContent(prompt, 100), 'string', 'a short prefix → plain string payload (unchanged)');
  eq(buildAnthropicUserContent(prompt, 100), prompt, 'the plain-string payload is the untouched prompt');
  eq(typeof buildAnthropicUserContent(prompt, 0), 'string', 'cachePrefixChars 0 (caching off) → plain string');
  eq(typeof buildAnthropicUserContent(long, long.length), 'string',
    'prefix == whole prompt → plain string (nothing volatile left to vary)');
  eq(typeof buildAnthropicUserContent(prompt, null), 'string', 'null → plain string');
  eq(typeof buildAnthropicUserContent(prompt, 1.5), 'string', 'non-integer → plain string');
  eq(typeof buildAnthropicUserContent(prompt, -5), 'string', 'negative → plain string');
  eq(buildAnthropicUserContent(null, 999999), '', 'non-string prompt degrades to empty string, never throws');
  ok(ANTHROPIC_CACHE_MIN_PREFIX_CHARS >= 16_000,
    'the size floor clears claude-haiku-4-5\'s 4096-token minimum (~4 chars/token)');
}

// ── 8. C — caching is OFF for single-pass, ON only for >= 2 batches ─────────
section('8. C — the >= 2-uses condition (a single-use cache write costs 1.25x)');
{
  const src = readFileSync(path.join(ROOT, 'src/brain/ingest.js'), 'utf8');

  ok(/const cacheAcrossBatches = totalBatches >= 2;/.test(src),
    'multi-phase enables caching only when the ingest makes >= 2 batch calls');
  ok(/cachePrefixChars: cacheAcrossBatches \? batchParts\.prefix\.length : 0/.test(src),
    'the batch call passes the prefix length only when caching is enabled');
  ok(/const cacheSinglePages = cacheAcrossBatches \|\| batch\.length >= 2;/.test(src),
    'the page-by-page fallback re-uses the same prefix when >= 2 calls will share it');

  // Single-pass is ONE call — a breakpoint there would make it MORE expensive.
  const singlePassStart = src.indexOf("progress(15, 'AI is analyzing the document…')");
  const singlePassEnd = src.indexOf('// ── Multi-phase fallback');
  ok(singlePassStart > 0 && singlePassEnd > singlePassStart, 'located the single-pass block');
  const singlePassBlock = src.slice(singlePassStart, singlePassEnd);
  ok(!singlePassBlock.includes('cachePrefixChars'),
    'single-pass sets NO cache breakpoint (one call can never repay a 1.25x write)');
  ok(singlePassBlock.includes('onUsage: usage.onUsage'),
    'single-pass still reports its token usage');

  // Gemini must be untouched by the caching hint: 2.5-family models cache
  // prefixes implicitly, and the explicit context-cache API is out of scope.
  const llm = readFileSync(path.join(ROOT, 'src/brain/llm.js'), 'utf8');
  const geminiBranch = llm.slice(llm.indexOf("if (provider === 'gemini')"), llm.indexOf('// ── Anthropic Claude'));
  ok(!geminiBranch.includes('cachePrefixChars') && !geminiBranch.includes('cache_control'),
    'the Gemini branch never touches the caching hint (reordering only)');
  ok(/buildAnthropicUserContent\(userPrompt, opts\.cachePrefixChars\)/.test(llm),
    'the Anthropic branch routes its payload through buildAnthropicUserContent');
}

// ── 9. D — onUsage: normalisation across providers ─────────────────────────
section('9. D — token usage is normalised across the two providers');
{
  // CONVENTION: inputTokens EXCLUDES cached tokens on BOTH providers. Gemini's
  // promptTokenCount INCLUDES them on the wire, so it must be normalised — or
  // `inputTokens + cachedReadTokens * 0.1` double-counts, silently, in whatever
  // meters this first.
  const g = normalizeGeminiUsage({ promptTokenCount: 1200, candidatesTokenCount: 340, cachedContentTokenCount: 900 });
  eq(g.inputTokens, 300, 'gemini promptTokenCount MINUS cached → inputTokens (exclusive convention)');
  eq(g.outputTokens, 340, 'gemini candidatesTokenCount → outputTokens');
  eq(g.cachedReadTokens, 900, 'gemini cachedContentTokenCount → cachedReadTokens');
  eq(g.cacheWriteTokens, 0, 'gemini implicit caching has no separate write charge');
  eq(g.inputTokens + g.cachedReadTokens + g.cacheWriteTokens, 1200,
    'the three input fields sum to the total prompt size');
  eq(normalizeGeminiUsage({ promptTokenCount: 100, cachedContentTokenCount: 500 }).inputTokens, 0,
    'cached > prompt clamps to 0 (never a negative that corrupts a running total)');
  eq(normalizeGeminiUsage({ promptTokenCount: 1000 }).inputTokens, 1000, 'no cache field → all tokens are full-price input');

  const a = normalizeAnthropicUsage({
    input_tokens: 500, output_tokens: 120,
    cache_read_input_tokens: 8000, cache_creation_input_tokens: 0,
  });
  eq(a.inputTokens, 500, 'anthropic input_tokens → inputTokens');
  eq(a.outputTokens, 120, 'anthropic output_tokens → outputTokens');
  eq(a.cachedReadTokens, 8000, 'anthropic cache_read_input_tokens → cachedReadTokens');
  eq(a.cacheWriteTokens, 0, 'anthropic cache_creation_input_tokens → cacheWriteTokens');
  ok(normalizeAnthropicUsage({ input_tokens: 500, cache_read_input_tokens: 8000 }).inputTokens === 500,
    'anthropic already uses the exclusive convention — no subtraction applied');
  // Both providers must answer the SAME question the same way.
  const gEq = normalizeGeminiUsage({ promptTokenCount: 1000, cachedContentTokenCount: 800 });
  const aEq = normalizeAnthropicUsage({ input_tokens: 200, cache_read_input_tokens: 800 });
  eq(gEq.inputTokens, aEq.inputTokens, 'identical real spend reports identically on both providers');

  // Absent / malformed usage must degrade to zeros, never throw — older
  // responses and some streaming shapes omit these fields entirely.
  for (const [label, val] of [['undefined', undefined], ['null', null], ['{}', {}], ['a string', 'nope'], ['a number', 7]]) {
    const gz = normalizeGeminiUsage(val);
    const az = normalizeAnthropicUsage(val);
    ok(gz.inputTokens === 0 && gz.outputTokens === 0 && gz.cachedReadTokens === 0 && gz.cacheWriteTokens === 0,
      `gemini usage ${label} → all zeros`);
    ok(az.inputTokens === 0 && az.outputTokens === 0 && az.cachedReadTokens === 0 && az.cacheWriteTokens === 0,
      `anthropic usage ${label} → all zeros`);
  }
  eq(normalizeGeminiUsage({ promptTokenCount: NaN }).inputTokens, 0, 'NaN → 0');
  eq(normalizeAnthropicUsage({ input_tokens: '900' }).inputTokens, 0, 'a string token count → 0 (never concatenated)');
}

// ── 10. D — a throwing onUsage callback can never break the LLM call ────────
section('10. D — the onUsage contract (observability must not affect correctness)');
{
  let threw = false;
  try {
    reportUsage(() => { throw new Error('boom'); }, { provider: 'gemini', model: 'm', inputTokens: 1 });
  } catch { threw = true; }
  ok(!threw, 'a throwing onUsage callback is swallowed (mirrors the v3.0.4 onWarn rule)');

  for (const bad of [null, undefined, 'nope', 42, {}]) {
    let t = false;
    try { reportUsage(bad, { inputTokens: 1 }); } catch { t = true; }
    ok(!t, `a non-function onUsage (${JSON.stringify(bad)}) is ignored, not called`);
  }

  let seen = null;
  reportUsage(u => { seen = u; }, { provider: 'anthropic', model: 'claude-haiku-4-5', inputTokens: 5 });
  ok(seen && seen.provider === 'anthropic' && seen.inputTokens === 5, 'a well-behaved callback receives the payload');

  // Source guards: usage must be reported once per COMPLETED provider call, on
  // BOTH branches, and BEFORE the truncation check — a truncated response is a
  // call that ran and was billed.
  const llm = readFileSync(path.join(ROOT, 'src/brain/llm.js'), 'utf8');
  eq((llm.match(/reportUsage\(opts\.onUsage/g) || []).length, 2, 'reportUsage is called on both provider branches');
  ok(llm.indexOf("reportUsage(opts.onUsage, {\n      provider: 'gemini'") < llm.indexOf('const finishReason'),
    'gemini reports usage BEFORE the MAX_TOKENS truncation check');
  ok(llm.indexOf("provider: 'anthropic'") < llm.indexOf("if (message.stop_reason === 'max_tokens')"),
    'anthropic reports usage BEFORE the max_tokens truncation check');
  ok(/callProvider\(provider, candidate, systemPrompt, userPrompt, maxTokens, responseFormat, opts\)/.test(llm),
    'opts reaches every fallback-chain rung, so total real spend is visible');
  ok(/return await callLLM\(systemPrompt, userPrompt, maxTokens, responseFormat, providerOverride, callOpts\)/.test(llm),
    'opts reaches every retry attempt too');
  ok(/onUsage: typeof opts\?\.onUsage === 'function' \? opts\.onUsage : null/.test(llm),
    'generateText validates onUsage is callable before threading it down');
}

// ── 11. D — the accumulator, and the bare-string return type ───────────────
section('11. D — usage accumulation + the unchanged generateText return type');
{
  const acc = makeUsageAccumulator();
  acc.onUsage({ provider: 'anthropic', model: 'claude-haiku-4-5', inputTokens: 100, outputTokens: 10, cacheWriteTokens: 90 });
  acc.onUsage({ provider: 'anthropic', model: 'claude-haiku-4-5', inputTokens: 20, outputTokens: 15, cachedReadTokens: 90 });
  acc.onUsage(null);                       // a provider that reported nothing
  acc.onUsage({ inputTokens: 'x' });       // malformed
  eq(acc.totals.calls, 4, 'every completed call is counted, including ones with no usage data');
  eq(acc.totals.inputTokens, 120, 'input tokens accumulate');
  eq(acc.totals.outputTokens, 25, 'output tokens accumulate');
  eq(acc.totals.cachedReadTokens, 90, 'cached reads accumulate');
  eq(acc.totals.cacheWriteTokens, 90, 'cache writes accumulate');
  eq(acc.totals.provider, 'anthropic', 'the last-seen provider is recorded');
  ok(!Number.isNaN(acc.totals.inputTokens), 'a malformed payload never poisons the totals with NaN');

  const llm = readFileSync(path.join(ROOT, 'src/brain/llm.js'), 'utf8');
  ok(/RETURN TYPE IS A BARE STRING/.test(llm),
    'generateText documents that its bare-string return type is load-bearing');
  ok(!/return \{ text:/.test(llm), 'generateText still returns a bare string (no object-shaped return)');

  // The ingest result carries the measured spend (additive; the SSE route picks
  // fields explicitly, so nothing existing changes).
  const ing = readFileSync(path.join(ROOT, 'src/brain/ingest.js'), 'utf8');
  ok(/tokenUsage: usage\.totals/.test(ing), 'ingestFile returns the measured token usage');
  ok(/\[ingest\] Token usage —/.test(ing), 'ingestFile logs the real spend for a real ingest');
}

// ── 12. Standing invariants that must not regress ──────────────────────────
section('12. Standing invariants (MCP stdout, isOutputTokenLimit, dedup safety net)');
{
  const ing = readFileSync(path.join(ROOT, 'src/brain/ingest.js'), 'utf8');
  const llm = readFileSync(path.join(ROOT, 'src/brain/llm.js'), 'utf8');

  // ingest.js and llm.js are imported by the MCP child process, which reserves
  // stdout for JSON-RPC frames. One console.log corrupts Claude Desktop (v2.5.2).
  ok(!/\bconsole\.log\(/.test(ing), 'ingest.js has no console.log (MCP stdout discipline)');
  ok(!/\bconsole\.log\(/.test(llm), 'llm.js has no console.log (MCP stdout discipline)');

  // isOutputTokenLimit keys on this exact phrase; ingest + compile fallback
  // ladders depend on it firing.
  ok(/output token limit \(\$\{maxTokens\} tokens\)/.test(llm),
    'the JSON-mode MAX_TOKENS message still contains "output token limit"');
  ok(ingestTesting.isOutputTokenLimit(new Error('⚠ Gemini hit the output token limit (65536 tokens) on this call.')),
    'isOutputTokenLimit still matches the thrown message');
  ok(!ingestTesting.isOutputTokenLimit(new Error('503 Service Unavailable')),
    'a non-token error is still fatal, not silently degraded');

  // The dedup safety net that covers anything the inventory cap drops must
  // keep seeing the FULL on-disk list.
  ok(/redirectSemanticDuplicates\(outline, existingFiles\)/.test(ing) &&
     /redirectSemanticDuplicates\(result, existingFiles\)/.test(ing),
    'redirectSemanticDuplicates still scans the FULL on-disk list, never the capped one');
  ok(/const capped = capExistingFilesForPrompt\(existingFiles, text\);/.test(ing),
    'the cap is computed once at the ingest entry point');
  ok(/for \(const w of capped\.warnings\)/.test(ing),
    'cap warnings are pushed into the ingest warnings[] the UI renders');

  // The tokeniser is reused, not reimplemented.
  ok(/import \{ tokenize \} from '\.\/sharedbrain-delta\.js'/.test(ing),
    'ingest reuses the shared tokenizer rather than defining a second one');
}

// ── 13. DEFECT 1 — Phase 2 cannot invent a second summary page ─────────────
// Live regression: Gemini's Phase 2 returned an invented
// `summaries/the-ingestion-pipeline-technical-deep-dive.md` alongside the forced
// canonical summary. validateOutline never saw it (it validates the OUTLINE), so
// two summary files landed on disk with no warning — permanently breaking the
// deterministic-slug idempotency guarantee for that source.
section('13. DEFECT 1 — Phase 2 summary paths are reconciled, not trusted');
{
  const CANON = 'summaries/ingestion-pipeline.md';
  const planned = [CANON, 'concepts/write-page.md', 'entities/gemini.md'];

  // The exact reported shape: canonical from one batch, invented from another.
  const r = reconcileGeneratedPages([
    { path: CANON, content: '# Pipeline\n\n## Summary\nCanonical body.\n\n## Entities Mentioned\n- [[gemini]]\n', summary: 'canonical' },
    { path: 'concepts/write-page.md', content: '# writePage\n' },
    { path: 'summaries/the-ingestion-pipeline-technical-deep-dive.md', content: '# Deep dive\n\n## Key Facts\n- A stray fact\n', summary: 'stray' },
  ], { summaryPath: CANON, plannedPaths: planned });

  const summaries = r.pages.filter(p => p.path.startsWith('summaries/'));
  eq(summaries.length, 1, 'exactly ONE summary entry survives');
  eq(summaries[0].path, CANON, 'it sits at the canonical summary path');
  ok(!r.pages.some(p => p.path.includes('technical-deep-dive')),
    'the invented summary path is gone — no second file can be written');
  eq(r.pages.filter(p => p.path === CANON).length, 1,
    'exactly one ENTRY for the canonical path (nothing double-writes)');
  eq(r.pages.length, 2, 'the non-summary page is untouched');

  // Content preservation, verified rather than assumed: the authoritative body
  // is the base, and the stray's unique sections survive the merge.
  ok(summaries[0].content.includes('Canonical body.'), 'the authoritative summary body wins');
  ok(summaries[0].content.includes('A stray fact'), 'the stray page\'s content is preserved, not dropped');
  eq(summaries[0].summary, 'canonical', 'the authoritative one-line summary wins');
  ok(r.warnings.some(w => /invented 1 extra summary page/.test(w) && w.includes(CANON)),
    'a user-visible warning names the redirect (this stops being invisible)');

  // Order must not matter: the stray can arrive FIRST (earlier batch).
  const r2 = reconcileGeneratedPages([
    { path: 'summaries/invented-title.md', content: '# X\n\n## Key Facts\n- stray fact\n', summary: 'stray' },
    { path: CANON, content: '# Pipeline\n\n## Summary\nCanonical body.\n', summary: 'canonical' },
  ], { summaryPath: CANON, plannedPaths: planned });
  eq(r2.pages.length, 1, 'stray-first still collapses to one entry');
  eq(r2.pages[0].path, CANON, 'stray-first lands on the canonical path');
  ok(r2.pages[0].content.includes('Canonical body.'), 'stray-first: the authoritative body still wins');
  ok(r2.pages[0].content.includes('stray fact'), 'stray-first: the stray content is still preserved');

  // Two strays and no authoritative entry → still one page, nothing lost.
  const r3 = reconcileGeneratedPages([
    { path: 'summaries/a.md', content: '# A\n\n## Key Facts\n- fact a\n' },
    { path: 'summaries/b.md', content: '# B\n\n## Key Facts\n- fact b\n' },
  ], { summaryPath: CANON, plannedPaths: planned });
  eq(r3.pages.length, 1, 'two strays collapse into the canonical page');
  eq(r3.pages[0].path, CANON, 'the collapsed page is canonical');
  ok(r3.pages[0].content.includes('fact a') && r3.pages[0].content.includes('fact b'),
    'both strays\' facts survive');

  // A clean response must be a pure no-op (no spurious warnings on the happy path).
  const clean = [
    { path: CANON, content: '# S\n' },
    { path: 'concepts/write-page.md', content: '# W\n' },
    { path: 'entities/gemini.md', content: '# G\n' },
  ];
  const r4 = reconcileGeneratedPages(clean.map(p => ({ ...p })), { summaryPath: CANON, plannedPaths: planned });
  eq(r4.warnings.length, 0, 'a compliant Phase 2 response produces no warnings');
  eq(JSON.stringify(r4.pages.map(p => p.path)), JSON.stringify(clean.map(p => p.path)),
    'a compliant response passes through unchanged, in order');

  // Unplanned NON-summary pages: kept (never silently dropped) but reported.
  const r5 = reconcileGeneratedPages([
    { path: CANON, content: '# S\n' },
    { path: 'concepts/invented-topic.md', content: '# Invented\n' },
  ], { summaryPath: CANON, plannedPaths: planned });
  ok(r5.pages.some(p => p.path === 'concepts/invented-topic.md'),
    'an unplanned entity/concept page is KEPT (content is never silently dropped)');
  ok(r5.warnings.some(w => /not in its own plan/.test(w)), 'the unplanned page is reported to the user');

  // A planned page returned by the "wrong" batch is benign — must stay silent.
  const r6 = reconcileGeneratedPages([
    { path: 'entities/gemini.md', content: '# G\n' },
  ], { summaryPath: CANON, plannedPaths: planned });
  eq(r6.warnings.length, 0, 'a planned page returned by another batch does not warn (benign chatter)');

  // Extension-less spellings must not be mistaken for invented pages: the model
  // returns a planned path without ".md" often enough that a raw string compare
  // produced false "not in its own plan" and false "invented summary" warnings.
  const r8 = reconcileGeneratedPages([
    { path: 'summaries/ingestion-pipeline', content: '# S\n' },      // canonical, no .md
    { path: 'concepts/write-page', content: '# W\n' },               // planned, no .md
  ], { summaryPath: CANON, plannedPaths: planned });
  eq(r8.warnings.length, 0, 'extension-less spellings of PLANNED paths produce no false warnings');
  eq(r8.pages.filter(p => p.path.startsWith('summaries/')).length, 1, 'still exactly one summary entry');
  eq(r8.pages.find(p => p.path.startsWith('summaries/')).path, CANON,
    'an extension-less canonical summary is pinned to the exact canonical string (one entry, no double-write)');

  // Malformed entries must not throw.
  const r7 = reconcileGeneratedPages([null, { content: 'x' }, { path: 42 }, { path: CANON, content: '# S\n' }],
    { summaryPath: CANON, plannedPaths: planned });
  eq(r7.pages.length, 1, 'malformed entries are dropped, the good one survives');
  ok(r7.warnings.some(w => /no path/.test(w)), 'a pathless page is reported');
  eq(reconcileGeneratedPages(null, {}).pages.length, 0, 'null input → empty result, no throw');
  eq(reconcileGeneratedPages(undefined).pages.length, 0, 'no args → empty result, no throw');

  // AUDIT FINDING 3 — a missing summaryPath used to rewrite every summary
  // entry's path to null, which writePage then refused: the function DESTROYED
  // data on a degenerate input. A pure exported function must not do that.
  for (const bad of [null, undefined, '', 42, {}]) {
    const r = reconcileGeneratedPages(
      [{ path: 'summaries/x.md', content: 'X' }, { path: 'concepts/y.md', content: 'Y' }],
      { summaryPath: bad, plannedPaths: [] });
    eq(r.pages.length, 2, `summaryPath=${JSON.stringify(bad)} → pages returned untouched`);
    eq(r.pages[0].path, 'summaries/x.md', `summaryPath=${JSON.stringify(bad)} → path is NOT nulled out`);
    eq(r.pages[0].content, 'X', `summaryPath=${JSON.stringify(bad)} → content preserved`);
    eq(r.warnings.length, 0, `summaryPath=${JSON.stringify(bad)} → no spurious warnings`);
  }
}

// ── 13b. AUDIT FINDING 4 — same-file dedup must ignore the .md spelling ────
// writePage now appends a missing extension, so "concepts/x" and "concepts/x.md"
// are the SAME FILE. The result dedup keyed on the raw path, so both spellings
// survived and the file was written TWICE (create, then merge) — two change
// records and two warnings for one page, plus a wasted write.
section('13b. AUDIT FINDING 4 — result dedup is extension-normalised');
{
  const src = readFileSync(path.join(ROOT, 'src/brain/ingest.js'), 'utf8');
  ok(/seen\.set\(withMdExtension\(page\.path\), page\)/.test(src),
    'the result dedup keys on the .md-normalised path, not the raw string');
  ok(/function withMdExtension\(p\)/.test(src),
    'the normaliser is a single shared helper (dedup and reconciler cannot drift apart)');
  ok(!/const withMd = \(p\) =>/.test(src),
    'the old per-function copy of the normaliser is gone');

  // Behavioural proof through the reconciler, which uses the same helper: the
  // two spellings must resolve to one identity.
  const CANON2 = 'summaries/s.md';
  const r = reconcileGeneratedPages(
    [{ path: 'concepts/x', content: 'A' }, { path: CANON2, content: 'S' }],
    { summaryPath: CANON2, plannedPaths: ['concepts/x.md', CANON2] });
  eq(r.warnings.length, 0, 'the extension-less spelling of a planned page is recognised as planned');

  // Keep-LAST semantics must survive the key change (the most complete version
  // of a page returned twice by different batches still wins).
  const seen = new Map();
  for (const pg of [{ path: 'concepts/x', content: 'first' }, { path: 'concepts/x.md', content: 'second' }]) {
    seen.set(/\.md$/i.test(pg.path) ? pg.path : pg.path + '.md', pg);
  }
  eq(seen.size, 1, 'both spellings collapse to ONE entry (one write, one change record)');
  eq([...seen.values()][0].content, 'second', 'keep-last-occurrence semantics are preserved');
}

// ── 14. DEFECT 1 — the reconciliation is actually wired into both paths ────
section('14. DEFECT 1 — wired into multi-phase AND single-pass');
{
  const src = readFileSync(path.join(ROOT, 'src/brain/ingest.js'), 'utf8');
  ok(/const reconciled = reconcileGeneratedPages\(writtenPages, \{/.test(src),
    'multi-phase reconciles Phase 2 output before returning it');
  ok(/pages: reconciled\.pages,/.test(src), 'the reconciled pages are what the caller receives');
  ok(/const rec = reconcileGeneratedPages\(result\.pages, \{/.test(src),
    'single-pass reconciles too (it drops content on an extra summary otherwise)');
  // Both call sites must feed their warnings to the user.
  eq((src.match(/warnings\.push\(w\);/g) || []).length >= 3, true,
    'both reconciliation sites push their warnings into warnings[]');
  ok(src.indexOf('const rec = reconcileGeneratedPages') < src.indexOf('const validated = validateOutline(result,'),
    'single-pass reconciles BEFORE validateOutline, so the stray is merged rather than dropped');
}

// ── 15. DEFECT 2 — writePage no longer discards a page missing ".md" ───────
// Live regression: `[writePage] Skipping invalid path (no filename):
// "concepts/concurrency-control"` — the page was planned, its content was
// generated and paid for, and it vanished with nothing in warnings[].
section('15. DEFECT 2 — a path missing .md is written, not silently discarded');
{
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'curator-writepage-'));
  __setDomainsDirOverride(tmp);
  const domain = 'zztest-writepage';
  for (const d of ['entities', 'concepts', 'summaries']) {
    mkdirSync(path.join(tmp, domain, 'wiki', d), { recursive: true });
  }
  const wiki = path.join(tmp, domain, 'wiki');

  try {
    // The exact reported case.
    const warns = [];
    const rec = await writePage(domain, 'concepts/concurrency-control',
      '# concurrency-control\n\nHow the write lock works.\n', { onWarn: w => warns.push(w) });
    ok(rec !== null, 'the page is written (not refused)');
    eq(rec && rec.canonPath, 'concepts/concurrency-control.md', 'the .md extension is appended');
    ok(existsSync(path.join(wiki, 'concepts/concurrency-control.md')), 'the file exists on disk');
    ok(readFileSync(path.join(wiki, 'concepts/concurrency-control.md'), 'utf8').includes('How the write lock works.'),
      'the generated content survived — no more paying for content that vanishes');
    ok(warns.some(w => /missing the \.md extension/.test(w)), 'the auto-correction is reported to the user');

    // A genuinely unusable path is STILL refused — but now visibly.
    for (const [bad, label] of [
      ['entities/', 'a folder with no filename'],
      ['', 'an empty path'],
      ['concepts/', 'a canonical folder with no filename'],
    ]) {
      const w2 = [];
      const r2 = await writePage(domain, bad, '# x\n', { onWarn: m => w2.push(m) });
      eq(r2, null, `${label} is still refused (callers rely on null)`);
      ok(w2.length > 0, `${label} surfaces a warning instead of only a console line`);
    }
    const w3 = [];
    eq(await writePage(domain, null, '# x\n', { onWarn: m => w3.push(m) }), null, 'a null path is refused');
    ok(w3.length > 0, 'a null path warns');

    // Path traversal must NOT become reachable now that .md is appended.
    // Pre-fix the "must end in .md" rule was an accidental traversal defence.
    for (const evil of [
      '../../../../tmp/curator-escape',
      'entities/../../../../tmp/curator-escape',
      '/tmp/curator-escape',
      'entities/..\\..\\curator-escape',
    ]) {
      const w4 = [];
      const r4 = await writePage(domain, evil, '# pwned\n', { onWarn: m => w4.push(m) });
      eq(r4, null, `traversal attempt refused: ${evil}`);
      ok(w4.some(m => /not a valid wiki page path|no filename|folder, not a page/.test(m)),
        `traversal attempt warns: ${evil}`);
    }
    ok(!existsSync('/tmp/curator-escape.md') && !existsSync('/tmp/curator-escape'),
      'nothing was written outside the wiki folder');

    // Existing guards must be intact.
    const idx = await writePage(domain, 'index.md', '# Index\n\n| a | b |\n');
    eq(idx && idx.canonPath, 'index.md', 'index.md is still special-cased to the wiki root');
    const log = await writePage(domain, 'log.md', '## [2026-08-22] test\n');
    eq(log && log.canonPath, 'log.md', 'log.md is still special-cased');
    const nonCanon = await writePage(domain, 'people/some-person.md', '# Person\n');
    eq(nonCanon && nonCanon.canonPath, 'entities/some-person.md', 'non-canonical folders still redirect to entities/');
    const underscore = await writePage(domain, 'concepts/two_worlds_of_code.md', '# Two worlds\n');
    eq(underscore && underscore.canonPath, 'concepts/two-worlds-of-code.md', 'underscore normalisation still runs');
    const noFolder = await writePage(domain, 'bare-concept', '# Bare\n');
    eq(noFolder && noFolder.canonPath, 'concepts/bare-concept.md',
      'a bare name with no folder and no extension gets both (concepts/ + .md)');

    // AUDIT FINDING 2 — appending .md newly admitted NESTED paths that every
    // consumer is blind to: ingest's existing-files scan and all three health.js
    // scans use a flat readdir, so a page at entities/companies/openai.md is on
    // disk and in index.md but invisible to the inventory (re-invented next
    // ingest), invisible to Health, and every inbound [[openai]] link reports
    // BROKEN — while Obsidian, resolving by basename, shows it as fine.
    for (const [nested, expected] of [
      ['entities/companies/openai.md', 'entities/openai.md'],
      ['concepts/a/b/c.md', 'concepts/c.md'],
      ['a/b/c/d', 'entities/d.md'],            // extension-less AND nested
    ]) {
      const w5 = [];
      const r5 = await writePage(domain, nested, `# ${nested}\n\nBody for ${nested}.\n`, { onWarn: m => w5.push(m) });
      ok(r5 !== null, `nested path is written, not discarded: ${nested}`);
      eq(r5 && r5.canonPath, expected, `nested path flattened to the wiki's one-folder-deep shape: ${nested}`);
      ok(w5.some(m => /nested more than one folder deep/.test(m)), `the flatten is reported: ${nested}`);
    }
    // No subdirectories may exist under a canonical folder afterwards.
    for (const folder of ['entities', 'concepts', 'summaries']) {
      const entries = readdirSync(path.join(wiki, folder), { withFileTypes: true });
      ok(entries.every(e => e.isFile()), `${folder}/ contains no subdirectories`);
      ok(entries.every(e => !e.isFile() || e.name.endsWith('.md')), `${folder}/ contains only .md files`);
    }
    // The flattened page must be visible to a FLAT readdir — the exact scan
    // ingest's existing-files inventory and health.js both perform.
    ok(readdirSync(path.join(wiki, 'entities')).filter(f => f.endsWith('.md')).includes('openai.md'),
      'the flattened page is visible to the flat readdir every consumer uses');

    // The legitimate shapes must be untouched by the flatten rule.
    eq((await writePage(domain, 'concepts/legit-page.md', '# L\n')).canonPath, 'concepts/legit-page.md',
      'a normal one-folder-deep page is unaffected');
    eq((await writePage(domain, 'index.md', '# Index\n')).canonPath, 'index.md', 'index.md still writes to the wiki root');
    eq((await writePage(domain, 'log.md', '## [2026-08-22] x\n')).canonPath, 'log.md', 'log.md still writes to the wiki root');

    // Free win from the same guard: "." used to produce "concepts/..md".
    {
      const w6 = [];
      eq(await writePage(domain, '.', '# dot\n', { onWarn: m => w6.push(m) }), null,
        'a path of "." is refused instead of writing a hidden "..md"');
      ok(w6.some(m => /no usable filename/.test(m)), 'the "." refusal is reported');
    }

    // A throwing onWarn must never break a write (the v3.0.4 onWarn contract).
    let boom = null;
    try {
      boom = await writePage(domain, 'concepts/still-written', '# Still\n', {
        onWarn: () => { throw new Error('callback exploded'); },
      });
    } catch { boom = 'THREW'; }
    ok(boom && boom !== 'THREW' && boom.canonPath === 'concepts/still-written.md',
      'a throwing onWarn callback is swallowed and the page is still written');
  } finally {
    __setDomainsDirOverride(null);
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── 16. Phase 1 outline output budget: HELD at 24576, and why ──────────────
//
// This section exists to stop BOTH wrong moves on this constant, and to record
// a measurement mistake precisely enough that it is not repeated.
//
// Wrong move 1 — RAISE it, because "the outline was too large for the output
// limit". Measured over 180 real ingest log entries: the outlines that actually
// overflowed 24,576 were 44 and 53 pages (≈7,700 / 8,800 chars, ~9-10% of the
// budget), while 370-, 328-, 316-, 304- and 297-page outlines all cleared the
// same cap. Overflow is runaway generation, not volume; no budget fixes that.
//
// Wrong move 2 — LOWER it on a proxy. That was attempted in this release and
// reverted. The sizing pass joined page paths in log.md to descriptions in
// index.md, but the index row is `| Page | Type | Summary |` and the parser
// captured the TYPE column, measuring every entry as `"summary": "entity"`:
// ~73 chars per entry instead of the real ~176. That understated the largest
// real outline by 2.4x and would have set the budget BELOW it.
section('16. Phase 1 outline budget is HELD at 24576 (proxy-sizing was wrong, and reverted)');
{
  const OUTLINE  = ingestTesting.MULTI_PHASE_OUTLINE_TOKENS;
  const BATCH    = ingestTesting.MULTI_PHASE_BATCH_TOKENS;
  const SINGLE   = ingestTesting.MULTI_PHASE_SINGLE_PAGE_TOKENS;

  eq(OUTLINE, 24576, 'MULTI_PHASE_OUTLINE_TOKENS is held at 24576');
  ok(OUTLINE < ANTHROPIC_MAX_OUTPUT_TOKENS,
    'the outline budget is under Anthropic\'s hard output cap (a raise would be silently clamped)');
  ok(BATCH < ANTHROPIC_MAX_OUTPUT_TOKENS && SINGLE < ANTHROPIC_MAX_OUTPUT_TOKENS,
    'the content budgets are under Anthropic\'s hard output cap too');

  // ── The corrected sizing, re-derived here so the arithmetic is checkable ──
  // Real index.md Summary column, n=2,047: mean 112.5, median 113, p90 160,
  // p99 191, max 297. An outline entry is JSON syntax + path + that summary.
  const MEAN_SUMMARY_CHARS = 113;
  const TYPICAL_PATH = 'concepts/context-engineering.md';   // 31 chars, representative
  const entryChars = JSON.stringify({ path: TYPICAL_PATH, summary: 'x'.repeat(MEAN_SUMMARY_CHARS) }).length + 6;
  ok(entryChars > 150 && entryChars < 200,
    `a real outline entry is ~176 chars, not ~73 (got ${entryChars})`);
  ok(entryChars > 2 * 73,
    'the corrected entry size is more than double the figure the reverted change used');

  // The largest outline this repo has ever produced: 370 pages / 65,001 chars.
  const LARGEST_OUTLINE_PAGES = 370;
  const LARGEST_OUTLINE_CHARS = 65001;
  ok(Math.abs(LARGEST_OUTLINE_CHARS / LARGEST_OUTLINE_PAGES - 175.7) < 1,
    'the largest real outline averages ~176 chars/entry, consistent with the corrected entry size');

  // Its token count cannot be measured offline, and the answer swings ~40%
  // across plausible chars/token ratios — which is exactly why it must not be
  // guessed. Two bounds pin the interval:
  //   (a) that ingest SUCCEEDED under a 24576 cap ⇒ true size <= 24576
  //       ⇒ the effective ratio is >= 65001/24576 = 2.64 for this payload.
  //   (b) 4.0 c/tok is an optimistic ceiling (plain English); an outline is
  //       ~1/3 hyphenated slug, which BPE fragments much more finely.
  const OPTIMISTIC_CHARS_PER_TOKEN = 4.0;
  const impliedMinRatio = LARGEST_OUTLINE_CHARS / OUTLINE;
  ok(Math.abs(impliedMinRatio - 2.64) < 0.02,
    `succeeding under the cap forces a ratio >= 2.64 c/tok (got ${impliedMinRatio.toFixed(2)})`);

  const lowerBoundTokens = LARGEST_OUTLINE_CHARS / OPTIMISTIC_CHARS_PER_TOKEN;   // 16,250
  const upperBoundTokens = OUTLINE;                                              // 24,576
  ok(Math.round(lowerBoundTokens) === 16250,
    `optimistic lower bound on the largest real outline is 16,250 tok (got ${Math.round(lowerBoundTokens)})`);

  // A component estimate — JSON punctuation ~3.4 c/tok, slug path ~2.5, prose
  // summary ~4.0, weighted by their real char shares — gives ~3.53 c/tok.
  const COMPONENT_RATIO = 3.53;
  const pointEstimate = LARGEST_OUTLINE_CHARS / COMPONENT_RATIO;                 // ≈18,400
  ok(pointEstimate > 18000 && pointEstimate < 19000,
    `best point estimate for the largest real outline is ~18,400 tok (got ${Math.round(pointEstimate)})`);
  ok(pointEstimate > lowerBoundTokens && pointEstimate < upperBoundTokens,
    'the point estimate sits inside the empirically pinned interval, as it must');

  // THE decisive assertions. Any budget must clear the whole interval, not the
  // point estimate — the true value is unknown within it.
  // 16384 is not below the optimistic floor — it is 0.8% above it (16,250),
  // and 11% BELOW the point estimate. Stated as a required ratio: a 16384
  // budget only fits the largest real outline if it tokenises at >= 3.97
  // chars/token, i.e. as efficiently as plain English. A third of an outline is
  // hyphenated slug, which BPE fragments far more finely than that, so the
  // budget would have been riding on the single most optimistic assumption
  // available. That is why it was reverted.
  const ratioNeededFor16384 = LARGEST_OUTLINE_CHARS / 16384;
  ok(ratioNeededFor16384 > 3.9,
    `a 16384 budget needs the outline to tokenise at >= ${ratioNeededFor16384.toFixed(2)} c/tok — plain-English efficiency, which an outline does not have`);
  ok(16384 < pointEstimate,
    `a 16384 budget sits below the best point estimate (16,384 < ${Math.round(pointEstimate)}) — unsafe, which is why it was reverted`);
  ok((16384 - lowerBoundTokens) / lowerBoundTokens < 0.01,
    'and it clears even the OPTIMISTIC floor by under 1% — no usable margin on any assumption');
  ok(20480 / pointEstimate < 1.3,
    `a 20480 budget clears the point estimate by only ${(20480 / pointEstimate).toFixed(2)}x — under the 1.3x bar`);
  ok(20480 < upperBoundTokens,
    'a 20480 budget also fails to clear the interval, so it cannot be shown safe either');
  ok(OUTLINE >= upperBoundTokens,
    '24576 is the only value the largest observed outline is KNOWN to fit under');

  // And the reason none of this argues for raising it: the outlines that
  // actually overflowed need ~10% of the budget even at the pessimistic ratio.
  const OVERFLOWED_53_PAGE_CHARS = 8805;
  ok((OVERFLOWED_53_PAGE_CHARS / 2.64) < OUTLINE * 0.15,
    'an outline that DID overflow needs under 15% of the budget — overflow is runaway generation, not volume');

  // ── The replacement for proxy sizing: a real measurement ──────────────────
  const src = readFileSync(path.join(ROOT, 'src/brain/ingest.js'), 'utf8');
  ok((src.match(/reportOutlineUsage\(/g) || []).length >= 4,
    'Phase 1 usage is reported at both attempts, at the accepted outline, and defined once');
  ok(/makeCallUsageProbe\(onUsage\)/.test(src),
    'both outline calls are metered by a probe that wraps the ingest-wide accumulator');
  ok(/reportOutlineUsage\('complete \(accepted outline\)', acceptedOutlineUsage, allPages\.length\)/.test(src),
    'the accepted outline is logged WITH its page count — the pages-vs-tokens datapoint sizing needs');
  ok(src.indexOf('reportOutlineUsage(firstFailedOnTokenLimit') > src.indexOf('firstFailedOnTokenLimit = true;'),
    'attempt 1 is reported AFTER the catch, so the overflow case (the interesting one) is measured too');

  // Guard the constant itself, in both directions.
  ok(!/MULTI_PHASE_OUTLINE_TOKENS\s*=\s*(?:[0-9]|1[0-9]|20)\d{3}\b/.test(src),
    'the outline budget has not been lowered back under 24576');
  ok(!/MULTI_PHASE_OUTLINE_TOKENS\s*=\s*(?:[3-9]\d{4}|\d{6,})/.test(src),
    'the outline budget has not been raised into the 30k+ range either');
  ok(/DO NOT LOWER MULTI_PHASE_OUTLINE_TOKENS ON A PROXY MEASUREMENT/.test(src),
    'the constant carries the standing warning about proxy sizing');
  ok(/captured the TYPE\s*\n\/\/ column/.test(src) || /captured the TYPE/.test(src),
    'the specific measurement error is recorded at the constant, so it is not repeated');

  eq(BATCH, 16384, 'MULTI_PHASE_BATCH_TOKENS left alone at 16384 (~2x headroom over p99)');
  eq(SINGLE, 8192, 'MULTI_PHASE_SINGLE_PAGE_TOKENS left alone at 8192 (~4x headroom over p99)');
  eq(ingestTesting.BATCH_SIZE, 4, 'BATCH_SIZE left alone at 4');
}

// ── 16b. The Phase 1 usage probe: observability must not affect correctness ─
section('16b. makeCallUsageProbe / reportOutlineUsage (v3.0.17 measurement seam)');
{
  const { makeCallUsageProbe, reportOutlineUsage } = ingestTesting;

  // It must forward every event to the ingest-wide accumulator, or the token
  // total the user sees would silently lose Phase 1's spend.
  const acc = makeUsageAccumulator();
  const probe = makeCallUsageProbe(acc.onUsage);
  probe.onUsage({ inputTokens: 40000, outputTokens: 24576, provider: 'gemini', model: 'm' });
  probe.onUsage({ inputTokens: 40000, outputTokens: 1200, provider: 'gemini', model: 'm' });
  eq(acc.totals.calls, 2, 'every probed call still reaches the ingest-wide accumulator');
  eq(acc.totals.outputTokens, 25776, 'the accumulator still sees the full billed output');
  eq(probe.totals.calls, 2, 'the probe counts the calls for this step');
  eq(probe.totals.outputTokens, 25776, 'the probe sums output across fallback-chain rungs (what was BILLED)');
  eq(probe.totals.inputTokens, 80000, 'the probe sums input too');

  // A throwing outer callback must not propagate — same contract as onWarn.
  const boomProbe = makeCallUsageProbe(() => { throw new Error('accumulator exploded'); });
  let threw = false;
  try { boomProbe.onUsage({ outputTokens: 99 }); } catch { threw = true; }
  ok(!threw, 'a throwing outer onUsage is swallowed — observability cannot fail an ingest');
  eq(boomProbe.totals.outputTokens, 99, 'and the probe still records the call');

  // Degenerate inputs must not throw either.
  const nullProbe = makeCallUsageProbe(null);
  let threw2 = false;
  for (const v of [undefined, null, 0, 'x', [], { outputTokens: NaN }, { outputTokens: Infinity }]) {
    try { nullProbe.onUsage(v); } catch { threw2 = true; }
  }
  ok(!threw2, 'the probe tolerates a null outer callback and any payload shape');
  eq(nullProbe.totals.outputTokens, 0, 'non-finite token counts are ignored rather than poisoning the total');
  eq(nullProbe.totals.calls, 7, 'but every call is still counted');

  // The reporter must not throw on partial/absent totals, and must never use
  // console.log (MCP reserves stdout for JSON-RPC frames).
  let threw3 = false;
  try {
    reportOutlineUsage('x', null, null);
    reportOutlineUsage('x', {}, 0);
    reportOutlineUsage('x', { outputTokens: 1 }, 370);
  } catch { threw3 = true; }
  ok(!threw3, 'reportOutlineUsage tolerates missing totals and missing page counts');

  const src = readFileSync(path.join(ROOT, 'src/brain/ingest.js'), 'utf8');
  const reporter = src.slice(src.indexOf('function reportOutlineUsage'),
                             src.indexOf('function reportOutlineUsage') + 700);
  ok(reporter.includes('console.error') && !reporter.includes('console.log'),
    'reportOutlineUsage writes to stderr only (MCP stdout discipline)');
}

// ── 17. extractPageArray: a planned page can no longer vanish silently ───────
//
// The previous code did `singlePages = parseJSON(raw).pages` and then branched
// on plain truthiness. Two real holes:
//   • `pages: []` is truthy → accepted as success → the planned page was
//     written NOWHERE, with no warning. reconcileGeneratedPages cannot catch
//     that: it reconciles the pages that ARE returned and has no notion of one
//     that never arrived.
//   • `pages: {}` is truthy but not iterable → `push(...pages)` throws a
//     TypeError that escapes and kills the whole ingest.
section('17. extractPageArray — only a non-empty array counts as a written page');
{
  const f = ingestTesting.extractPageArray;

  eq(f(null), null, 'null raw (the call threw a recoverable error) → null');
  eq(f(undefined), null, 'undefined raw → null');
  eq(f(''), null, 'empty string → null');
  eq(f('   '), null, 'whitespace-only string → null');
  eq(f('not json at all'), null, 'unparseable text → null');
  eq(f('{'), null, 'truncated JSON → null');
  eq(f('{}'), null, 'object with no "pages" key → null');
  eq(f('null'), null, 'the literal JSON null → null');
  eq(f('[]'), null, 'a bare array (no "pages" wrapper) → null');
  eq(f('{"pages": null}'), null, '"pages": null → null');
  eq(f('{"pages": []}'), null, 'EMPTY pages array → null (was silently accepted as success)');
  eq(f('{"pages": {}}'), null, 'non-array "pages" → null (was a TypeError that killed the ingest)');
  eq(f('{"pages": "nope"}'), null, 'string "pages" → null');
  eq(f('{"pages": 3}'), null, 'numeric "pages" → null');

  const good = f('{"pages": [{"path": "concepts/x.md", "content": "# X", "summary": "s"}]}');
  ok(Array.isArray(good) && good.length === 1 && good[0].path === 'concepts/x.md',
    'a well-formed single-page response is returned as an array');

  // parseJSON's markdown-fence + brace-extraction + jsonrepair path must still
  // be reachable through the helper — the models really do wrap output.
  const fenced = f('```json\n{"pages": [{"path": "entities/y.md", "content": "# Y"}]}\n```');
  ok(Array.isArray(fenced) && fenced[0].path === 'entities/y.md',
    'a markdown-fenced response still parses (parseJSON is doing the work)');

  // It must never throw, whatever it is handed.
  let threw = false;
  for (const v of [0, 1, true, false, {}, [], () => {}, Symbol('x'), 12n, NaN]) {
    try { f(v); } catch { threw = true; }
  }
  ok(!threw, 'extractPageArray never throws, on any input type');

  // Source guard: the old truthiness path must be gone from the fallback loop.
  const src = readFileSync(path.join(ROOT, 'src/brain/ingest.js'), 'utf8');
  ok(!/singlePages\s*=\s*parseJSON\(/.test(src),
    'the page-by-page fallback no longer assigns parseJSON(...).pages straight to singlePages');
  ok(/singlePages\s*=\s*extractPageArray\(/.test(src),
    'the page-by-page fallback routes both attempts through extractPageArray');
}

// ── 18. One concise retry before a stub page is written ─────────────────────
//
// A stub is a user-visible defect: a placeholder the user must notice and
// re-ingest to fix. A page that overruns 8,192 output tokens for a body the
// prompt asks to be "3–8 concise bullet points" has not failed for lack of
// capability — it over-generated. One brevity-directed retry targets that
// directly, and if it also fails the stub is written exactly as before, so the
// OUTCOME is never worse than the previous behaviour.
section('18. Concise single-page retry (v3.0.17) before falling back to a stub');
{
  const src = readFileSync(path.join(ROOT, 'src/brain/ingest.js'), 'utf8');
  const D = ingestTesting.CONCISE_PAGE_DIRECTIVE;

  ok(typeof D === 'string' && D.length > 0, 'CONCISE_PAGE_DIRECTIVE is a non-empty string');
  ok(/BE BRIEF/.test(D), 'the directive leads with an unambiguous brevity instruction');
  ok(/\bbullet points\b/.test(D) && /\bwords\b/.test(D),
    'the directive puts a concrete cap on both bullets and words');
  ok(/ONLY the JSON object/.test(D), 'the directive re-states the JSON-only contract');
  ok(/response length limit/.test(D), 'the directive tells the model WHY it is being asked again');

  // The cacheable prefix must not move. buildBatchPromptParts splits
  // [stable prefix | volatile page list]; the directive belongs on the suffix,
  // or every retry invalidates the Anthropic cache breakpoint the batch set up.
  const page = { path: 'concepts/x.md', summary: 'a concept' };
  const parts = buildBatchPromptParts(TODAY, 'test-source.pdf', SOURCE_TEXT, [page], SMALL_FILES, [page]);
  const retryPrompt = parts.prefix + parts.suffix + D;
  ok(retryPrompt.startsWith(parts.prefix),
    'the retry prompt still starts with the byte-identical cacheable prefix');
  ok(retryPrompt.endsWith(D), 'the directive is appended at the very end of the prompt');
  ok(!parts.prefix.includes('BE BRIEF'), 'the directive never leaks into the cacheable prefix');
  ok(/singleParts\.prefix \+ singleParts\.suffix \+ CONCISE_PAGE_DIRECTIVE/.test(src),
    'source: the retry composes prefix + suffix + directive, in that order');
  ok(!/prefix \+ CONCISE_PAGE_DIRECTIVE/.test(src),
    'source: the directive is never concatenated straight onto the prefix');

  // The retry must reuse the SAME budget — raising it here would re-create the
  // runaway-burn problem this release is fixing, one page at a time.
  const retryBlock = src.slice(src.indexOf('retrying with a brevity directive'),
                               src.indexOf('stub created.'));
  ok(retryBlock.includes('MULTI_PHASE_SINGLE_PAGE_TOKENS'),
    'the concise retry reuses the single-page budget rather than raising it');
  ok(retryBlock.includes('cachePrefixChars'),
    'the concise retry still passes a cache breakpoint so the prefix is read back, not re-sent');
  ok(retryBlock.includes('onUsage'),
    'the concise retry is metered — its spend shows up in the ingest\'s token total');

  // Error gating: only a recoverable failure may reach the retry. A 503 / 429 /
  // auth / network error must still propagate untouched, or an outage gets
  // silently converted into short pages and stubs.
  ok(/if \(!isOutputTokenLimit\(conciseErr\)\) throw conciseErr;/.test(src),
    'a non-token-limit error on the concise retry re-throws immediately');
  // Five generateText calls sit on the multi-phase path — outline, outline
  // retry, batch, single page, concise single-page retry — and EVERY one of
  // them must re-throw anything that is not an output-token-limit. Widening
  // that gate is how a provider outage turns into a wiki full of stub pages
  // (the v3.0.1-beta.15 audit finding). The concise retry added one more call,
  // so this count going to 6 without a matching guard is a regression.
  eq((src.match(/if \(!isOutputTokenLimit\([a-zA-Z0-9]+\)\) throw [a-zA-Z0-9]+;/g) || []).length, 5,
    'all 5 generateText calls in the multi-phase path re-throw non-token-limit errors');

  // The stub path must survive as the last resort.
  ok(/Stub page created for/.test(src), 'the stub fallback is still written when the retry also fails');
  // Anchored inside the fallback loop itself — 'Stub page created for' also
  // appears in AGGREGATABLE_WARNINGS' matcher, earlier in the file.
  const loop = src.slice(src.indexOf('const cacheSinglePages ='));
  ok(loop.indexOf('retrying with a brevity directive') < loop.indexOf('Stub page created for'),
    'the concise retry is attempted BEFORE the stub, not after');
  ok(loop.indexOf('CONCISE_PAGE_DIRECTIVE') < loop.indexOf('stubPageContent('),
    'and the directive is used before the stub body is ever built');
}

// ── 19. Ingest warning wording is accurate about CAUSE and COST ────────────
//
// Every string here was reworded because it asserted something that was not
// reliably true. Bucketing is covered separately in section 21, against a
// mirror of the real classifyIngestEntry; this section is about honesty.
section('19. Ingest warning wording states the true cause and the true cost');
{
  const src = readFileSync(path.join(ROOT, 'src/brain/ingest.js'), 'utf8');
  // NEGATIVE assertions run against a comment-stripped view. The comments in
  // ingest.js deliberately QUOTE the wording they replaced, to explain why —
  // matching the whole file would flag that documentation as a regression.
  const code = src.split('\n')
    .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

  // Round 1: the original text told the user their outline was too large. It
  // was not — the outlines that overflow are the SMALL ones (44–53 pages).
  ok(!code.includes('Phase 1 outline was too large for the AI output limit'),
    'the misleading "outline was too large" wording is gone');
  ok(!code.includes('Phase 1 outline returned malformed JSON; auto-retried with stricter prompt.'),
    'the terse malformed-JSON wording is replaced too');
  ok(/ran past its response length limit/.test(src),
    'the token-limit warning says the AI over-ran, not that the plan was too big');

  // Round 2 (audit): the replacement claimed the recovered plan was "complete",
  // which asserts the exact property the retry trades away — item 4 of the
  // strict prompt asks for FEWER, broader pages.
  ok(!/plan below is complete/.test(code),
    'the "plan below is complete" claim is gone — the retry deliberately plans fewer pages');
  ok(/asks for FEWER, broader pages/.test(src),
    'the warning now discloses that the recovered plan is coarser');
  ok(/Plan FEWER, broader pages/.test(src),
    'and the strict prompt it refers to really does ask for that (the claim is grounded)');

  // …and it guessed the call count and omitted the input cost entirely.
  ok(!/one extra AI call/.test(code),
    'the hard-coded "one extra AI call" guess is gone (llm.js may make several)');
  ok(/\$\{planningCalls\} AI calls instead of 1/.test(src),
    'the call count is interpolated from the probes, i.e. measured');
  ok(/const planningCalls = \(outlineProbe\.totals\.calls \|\| 0\) \+ \(retryProbe\.totals\.calls \|\| 0\)/.test(src),
    'and it sums BOTH attempts\' provider calls');
  ok(/sent to the AI twice/.test(src),
    'the doubled INPUT spend is disclosed — the larger cost on a mature domain');

  // The concise-page retry fires on FOUR causes, so its message cannot name one.
  ok(!/overran the AI's response limit on the first try/.test(code),
    'the single-cause "overran the response limit" wording is gone');
  ok(/came back unusable/.test(src),
    'the concise-retry warning is cause-neutral — it states only what is certainly true');
  ok(/briefer than the rest/.test(src),
    'it keeps the exact phrase app.js classifyIngestEntry uses as its dedicated amber trigger');
  ok(!/not a stub page/.test(code),
    'and the backwards "not a stub page" negation is gone — amber no longer depends on a negated trigger');

  // The salvage path (v3.0.17): an outline that never produced a usable plan.
  ok(/never returned a usable page plan/.test(src),
    'a salvaged, almost-certainly-incomplete ingest says so plainly');
  ok(/almost certainly incomplete/.test(src),
    'and does not dress the salvage up as a success');

  // The genuinely actionable one keeps the literal text the UI keys on.
  ok(/Stub page created for "\$\{singlePage\.path\}"/.test(src),
    'the stub warning keeps its literal "Stub page" text');
}

// ── 20. Multi-phase orchestration, driven by a fake LLM (v3.0.17 audit) ────
//
// Everything below is EXECUTABLE, not a source regex. Two of the defects this
// section covers were shipped with green source-level assertions next to them:
// a source guard can confirm a line exists, it cannot confirm the line runs.
// ingestMultiPhase touches no filesystem, so injecting the LLM (its trailing
// `llm` param, defaulted to the real generateText) exercises the real Phase 1
// retry ladder and Phase 2 fallback ladder offline and for free.
section('20. Multi-phase orchestration under a fake LLM (Phase 1 retry + Phase 2 fallback)');
{
  const { ingestMultiPhase } = ingestTesting;
  const SUMMARY = 'summaries/fake-source.md';
  const NO_FILES = { entities: [], concepts: [] };

  const outlineJSON = (paths) => JSON.stringify({
    title: 'Fake Source',
    pages: paths.map(p => ({ path: p, summary: `description of ${p}` })),
  });
  const pagesJSON = (paths) => JSON.stringify({
    pages: paths.map(p => ({ path: p, content: `# ${p}\n\n- a bullet\n`, summary: `s ${p}` })),
  });
  const tokenLimitError = () =>
    new Error('⚠ Gemini hit the output token limit (24576 tokens) on this call.');

  // Scripted fake LLM. Each step is {out, tokens} to return, or {throw, tokens}.
  // Usage is reported BEFORE the throw, exactly as llm.js does — a truncated
  // response is a call that ran and was billed.
  function makeFakeLLM(steps) {
    const prompts = [];
    let i = 0;
    const llm = async (schema, prompt, maxTokens, format, onRetry, opts) => {
      const step = steps[Math.min(i, steps.length - 1)];
      i++;
      prompts.push(prompt);
      if (opts && typeof opts.onUsage === 'function') {
        opts.onUsage({ inputTokens: 1000, outputTokens: step.tokens || 0, provider: 'fake', model: 'fake-1' });
      }
      if (step.throw) throw step.throw();
      return step.out;
    };
    return { llm, prompts, calls: () => i };
  }

  async function runMultiPhase(steps) {
    const warnings = [];
    const acc = makeUsageAccumulator();
    const fake = makeFakeLLM(steps);
    const logged = [];
    const realError = console.error, realWarn = console.warn;
    console.error = (...a) => logged.push(a.join(' '));
    console.warn  = (...a) => logged.push(a.join(' '));
    let result = null, thrown = null;
    try {
      result = await ingestMultiPhase(
        'schema', '2026-08-22', '', NO_FILES, 'fake-source.md', 'Some source text.',
        false, () => {}, SUMMARY, warnings, [], NO_FILES, acc.onUsage, fake.llm);
    } catch (e) { thrown = e; }
    finally { console.error = realError; console.warn = realWarn; }
    return { result, thrown, warnings, logged, acc, fake };
  }

  // ── HIGH-1: the sizing instrument must report the ACCEPTED attempt ─────────
  // Attempt 1 runs away and burns the whole budget; the retry recovers cheaply.
  // The "complete (accepted outline)" line is the datapoint the constant's
  // comment block designates for sizing, so it MUST carry the retry's 2,500 —
  // not attempt 1's 24,576, which would imply ~10x the true per-page cost and
  // argue for raising a budget the same comment proves should not move.
  {
    const r = await runMultiPhase([
      { throw: tokenLimitError, tokens: 24576 },                       // outline attempt 1
      { out: outlineJSON([SUMMARY, 'entities/a.md']), tokens: 2500 },  // outline retry
      { out: pagesJSON([SUMMARY, 'entities/a.md']), tokens: 900 },     // batch
    ]);
    ok(!r.thrown, 'the ingest recovers from a Phase 1 output-token overflow');
    const accepted = r.logged.filter(l => l.includes('complete (accepted outline)'));
    eq(accepted.length, 1, 'exactly one "accepted outline" sizing line is emitted');
    ok(accepted[0].includes('2,500 output tokens'),
      `the accepted line reports the RETRY's spend (got: ${accepted[0].replace(/^\[ingest\] /, '')})`);
    ok(!accepted[0].includes('24,576 output tokens'),
      'the accepted line does NOT report the failed attempt\'s burn — the HIGH-1 regression');
    ok(accepted[0].includes('2 pages'), 'the accepted line carries the page count for pages-vs-tokens sizing');
    ok(r.logged.some(l => l.includes('OVERFLOWED') && l.includes('24,576 output tokens')),
      'attempt 1 is still reported separately, at 100% of budget');
    ok(r.logged.some(l => l.includes('outline retry') && l.includes('2,500 output tokens')),
      'the retry is reported separately too');
    eq(r.acc.totals.calls, 3, 'every probed call still reaches the ingest-wide billing total');
    eq(r.acc.totals.outputTokens, 27976, 'the billing total includes the wasted attempt');
  }

  // ── MEDIUM-1: the Phase 1 warning must not claim the plan is "complete" ────
  {
    const r = await runMultiPhase([
      { throw: tokenLimitError, tokens: 24576 },
      { out: outlineJSON([SUMMARY, 'entities/a.md']), tokens: 2500 },
      { out: pagesJSON([SUMMARY, 'entities/a.md']), tokens: 900 },
    ]);
    const w = r.warnings.find(x => x.includes('ran past its response length limit'));
    ok(w, 'the Phase 1 token-limit warning is raised');
    ok(!/plan below is complete/.test(w),
      'it no longer claims the recovered plan is "complete" — the retry asks for FEWER pages');
    ok(/FEWER, broader pages/.test(w),
      'it tells the user the plan is deliberately coarser than a first-attempt plan');
    ok(/grouped under a parent page/.test(w),
      'it explains what "coarser" means in practice');
    ok(/took 2 AI calls instead of 1/.test(w),
      `it reports the MEASURED call count, not a guess (got: ${w.slice(-90)})`);
    ok(/sent to the AI twice/.test(w),
      'it discloses the doubled INPUT spend, which the old wording omitted entirely');
    ok(!/one extra AI call/.test(w), 'the hard-coded "one extra AI call" claim is gone');
  }

  // A malformed-JSON first attempt takes the same path with its own opening.
  {
    const r = await runMultiPhase([
      { out: 'not json at all', tokens: 800 },
      { out: outlineJSON([SUMMARY, 'entities/a.md']), tokens: 2500 },
      { out: pagesJSON([SUMMARY, 'entities/a.md']), tokens: 900 },
    ]);
    const w = r.warnings.find(x => x.includes('malformed JSON'));
    ok(w, 'a malformed first outline raises its own warning');
    ok(/FEWER, broader pages/.test(w) && /took 2 AI calls/.test(w),
      'and carries the same accurate coarser-plan + call-count disclosure');
  }

  // ── HIGH-2: the BATCH path is guarded, not just the single-page fallback ───
  // These shapes are all truthy, so before the fix the page-by-page fallback
  // never fired. `{"pages": []}` dropped every planned page of the batch with no
  // file, no stub and no warning; the rest threw "not iterable" out of
  // ingestMultiPhase and killed the whole ingest.
  const BATCH_SHAPES = [
    ['{"pages": []}',            'an EMPTY pages array (silently dropped 4 planned pages)'],
    ['{"pages": {}}',            'a non-array "pages" (threw "not iterable" and killed the ingest)'],
    ['{"pages": null}',          'a null "pages"'],
    ['[{"path":"x"}]',           'a bare array with no "pages" wrapper'],
    ['{"title": "no pages"}',    'an object with no "pages" key at all'],
    ['{"pages": [1, 2, 3]}',     'an array of non-objects'],
    ['{"pages": [{"content":"orphan"}]}', 'an array whose entries carry no path'],
  ];
  for (const [batchBody, label] of BATCH_SHAPES) {
    const planned = [SUMMARY, 'entities/a.md', 'concepts/b.md'];
    const r = await runMultiPhase([
      { out: outlineJSON(planned), tokens: 2000 },   // outline OK
      { out: batchBody, tokens: 500 },               // batch returns junk
      { out: pagesJSON([SUMMARY]), tokens: 300 },    // page-by-page picks it up
      { out: pagesJSON(['entities/a.md']), tokens: 300 },
      { out: pagesJSON(['concepts/b.md']), tokens: 300 },
    ]);
    ok(!r.thrown, `batch returning ${label} does not kill the ingest`);
    const got = new Set((r.result ? r.result.pages : []).map(p => p.path));
    ok(planned.every(p => got.has(p)),
      `  …and every planned page still lands (${got.size}/${planned.length} written)`);
  }

  // Control: a WELL-FORMED batch must still be taken on the first attempt, with
  // no fallback calls — the guard must not cost a healthy ingest anything.
  {
    const planned = [SUMMARY, 'entities/a.md', 'concepts/b.md'];
    const r = await runMultiPhase([
      { out: outlineJSON(planned), tokens: 2000 },
      { out: pagesJSON(planned), tokens: 1500 },
      { out: '{"pages": []}', tokens: 1 },   // must never be reached
    ]);
    eq(r.fake.calls(), 2, 'a healthy multi-phase ingest still makes exactly 2 calls (outline + one batch)');
    eq(r.result.pages.length, 3, 'and writes every planned page from the batch response');
    ok(!r.warnings.some(w => /Stub page/.test(w)), 'with no stub pages');
  }

  // ── MEDIUM-2 + the concise retry, end to end ──────────────────────────────
  {
    const planned = [SUMMARY, 'entities/a.md'];
    const r = await runMultiPhase([
      { out: outlineJSON(planned), tokens: 2000 },
      { out: '{"pages": []}', tokens: 400 },              // batch unusable → page-by-page
      { out: '{"pages": []}', tokens: 300 },              // single page 1 unusable
      { out: pagesJSON([SUMMARY]), tokens: 200 },         // …concise retry rescues it
      { out: pagesJSON(['entities/a.md']), tokens: 200 }, // single page 2 fine
    ]);
    ok(!r.thrown, 'a page rescued by the concise retry does not break the ingest');
    eq(r.result.pages.length, 2, 'both planned pages are written');
    ok(!r.warnings.some(w => /Stub page created/.test(w)),
      'the rescued page is NOT a stub — the concise retry did its job');
    const w = r.warnings.find(x => x.includes('came back unusable'));
    ok(w, 'the rescue is disclosed to the user');
    ok(!/overran the AI's response limit/.test(w),
      'the wording is CAUSE-NEUTRAL — this page failed on an empty array, not a token limit');
    ok(/This is real content/.test(w), 'it states plainly that the page is real content');
    ok(/briefer than the rest/.test(w), 'and keeps the phrase app.js buckets it amber on');
  }

  // Both attempts fail → the stub is still the last resort, unchanged.
  {
    const planned = [SUMMARY];
    const r = await runMultiPhase([
      { out: outlineJSON(planned), tokens: 2000 },
      { out: '{"pages": []}', tokens: 400 },   // batch
      { out: '{"pages": []}', tokens: 300 },   // single
      { out: '{"pages": []}', tokens: 200 },   // concise retry
    ]);
    ok(!r.thrown, 'exhausting every retry still completes the ingest');
    eq(r.result.pages.length, 1, 'the planned page is present as a stub, not missing');
    ok(/Stub page/.test(r.result.pages[0].content), 'and it is the clearly-marked stub body');
    ok(r.warnings.some(w => /Stub page created for/.test(w)), 'with the amber stub warning');
  }

  // ── The salvage path (v3.0.17, found by this very suite) ──────────────────
  // parseJSON is lenient: jsonrepair turns the bare text `not json at all` into
  // the STRING "not json at all", which is truthy. The old `if (!outline)` check
  // accepted that as a successful outline and SKIPPED the retry, after which
  // validateOutline degraded it to a summary-only plan — an 80,000-char source
  // could produce a one-page wiki. Now it counts as a failure and retries; if
  // the retry is also unusable we still salvage rather than fail, so the change
  // is strictly no-worse, but we say loudly that the ingest is incomplete.
  {
    const r = await runMultiPhase([
      { out: 'not json at all', tokens: 900 },   // attempt 1: truthy garbage
      { out: 'still not json',  tokens: 900 },   // retry: also garbage
      { out: pagesJSON([SUMMARY]), tokens: 300 },
    ]);
    ok(!r.thrown, 'two unusable outlines still complete the ingest rather than failing it');
    ok(r.fake.calls() >= 2, 'the truthy-garbage first outline DID trigger the retry (it used to be accepted)');
    const w = r.warnings.find(x => /never returned a usable page plan/.test(x));
    ok(w, 'the salvage is disclosed');
    ok(/almost certainly incomplete/.test(w), 'and is not dressed up as a success');
    ok(!r.warnings.some(x => /asked again for a shorter plan and that succeeded/.test(x)),
      'the "retry recovered" warning is NOT claimed when the retry did not recover');
    ok(r.result.pages.some(p => p.path === SUMMARY),
      'the canonical summary is still rescued by validateOutline');
  }

  // A usable retry after truthy garbage takes the normal recovery path.
  {
    const r = await runMultiPhase([
      { out: '{"pages": []}', tokens: 900 },                          // truthy, unusable
      { out: outlineJSON([SUMMARY, 'entities/a.md']), tokens: 2500 },
      { out: pagesJSON([SUMMARY, 'entities/a.md']), tokens: 900 },
    ]);
    ok(!r.warnings.some(x => /never returned a usable page plan/.test(x)),
      'a recovered retry does NOT emit the salvage warning');
    ok(r.warnings.some(x => /malformed JSON/.test(x)),
      'an empty page list is reported as an unusable first plan');
    eq(r.result.pages.length, 2, 'and the full recovered plan is written');
  }

  // ── The standing invariant: a genuine outage must never become stub pages ──
  for (const [where, steps] of [
    ['the outline call', [{ throw: () => new Error('503 Service Unavailable'), tokens: 0 }]],
    ['the outline retry', [
      { throw: tokenLimitError, tokens: 24576 },
      { throw: () => new Error('429 Too Many Requests'), tokens: 0 }]],
    ['a batch call', [
      { out: outlineJSON([SUMMARY]), tokens: 2000 },
      { throw: () => new Error('503 Service Unavailable'), tokens: 0 }]],
    ['a single-page call', [
      { out: outlineJSON([SUMMARY]), tokens: 2000 },
      { out: '{"pages": []}', tokens: 400 },
      { throw: () => new Error('fetch failed'), tokens: 0 }]],
    ['the concise retry', [
      { out: outlineJSON([SUMMARY]), tokens: 2000 },
      { out: '{"pages": []}', tokens: 400 },
      { out: '{"pages": []}', tokens: 300 },
      { throw: () => new Error('503 Service Unavailable'), tokens: 0 }]],
  ]) {
    const r = await runMultiPhase(steps);
    ok(r.thrown && !/Stub page/.test(String(r.thrown.message)),
      `a non-token-limit error on ${where} propagates as the real error, not a stub`);
  }
}

// ── 21. The concise-retry warning must land in the amber "For review" bucket ─
//
// Run against a faithful copy of classifyIngestEntry from src/public/app.js —
// which is NOT ours to edit, so the coupling is asserted here instead. If that
// function's trigger list changes, this section fails and tells us to re-check
// rather than letting a warning silently change colour.
section('21. Warning classification against the real app.js buckets');
{
  // Mirrors classifyIngestEntry (src/public/app.js), order-sensitive.
  function classify(w) {
    const lc = String(w || '').toLowerCase();
    if (lc.includes('injected the trunk page') || lc.includes('hub linkification') ||
        lc.includes('injected entities/') || lc.includes('injected the canonical summary') ||
        lc.includes('redirected to canonical') || lc.includes('redirected; bullets will merge') ||
        (lc.includes('dropping') && lc.includes('content will merge'))) return 'fixed';
    if (lc.includes('keeping both') || lc.includes("don't resolve") ||
        lc.includes('do not resolve') || lc.includes('stub page') ||
        lc.includes('briefer than the rest')) return 'review';
    if (lc.includes('truncated to')) return 'attention';
    return 'info';
  }
  const src = readFileSync(path.join(ROOT, 'src/brain/ingest.js'), 'utf8');

  // Guard the mirror itself: if app.js's trigger list drifts, fail loudly.
  const appSrc = readFileSync(path.join(ROOT, 'src/public/app.js'), 'utf8');
  const fn = appSrc.slice(appSrc.indexOf('function classifyIngestEntry'),
                          appSrc.indexOf('function renderIngestWarnings'));
  for (const trigger of ['keeping both', "don't resolve", 'do not resolve', 'stub page', 'truncated to',
                         'briefer than the rest']) {
    ok(fn.includes(trigger), `app.js still keys on "${trigger}" (the mirror above stays faithful)`);
  }

  const CONCISE = 'The AI\'s first attempt at "concepts/x.md" came back unusable, so The Curator asked '
    + 'for a shorter version and saved that instead. This is real content, but it is '
    + 'briefer than the rest — open it in the Wiki tab and re-ingest if it reads too thin.';
  ok(src.includes('`for a shorter version and saved that instead. This is real content, but it is `'),
    'the concise-retry warning in ingest.js matches the string under test');
  eq(classify(CONCISE), 'review',
    'the concise-retry warning lands in ⚠ For review — it ends in an instruction to go and look');

  // The Phase 1 recoveries are informational: they describe a completed
  // recovery, there is nothing for the user to do.
  const P1_TOKEN = 'While planning the page list, the AI ran past its response length limit — it generated far '
    + 'more than a plan needs. The Curator asked again for a shorter plan and that succeeded, so the ingest '
    + 'completed. Note that the retry explicitly asks for FEWER, broader pages, so the page list below is '
    + 'coarser than a first-attempt plan would have been — some detail is grouped under a parent page instead '
    + 'of getting its own. Planning took 2 AI calls instead of 1, and your source document was sent to the AI twice.';
  eq(classify(P1_TOKEN), 'info', 'the Phase 1 token-limit warning stays ℹ Info');
  eq(classify('The AI\'s first page plan came back as malformed JSON. ' + P1_TOKEN.slice(P1_TOKEN.indexOf('The Curator'))),
    'info', 'the Phase 1 malformed-JSON warning stays ℹ Info');

  // The genuinely actionable one keeps its amber bucket.
  eq(classify('Stub page created for "concepts/x.md" — LLM could not generate content. Re-ingest to fix.'),
    'review', 'the stub warning stays ⚠ For review');

  // The coupling is documented at the call site so it survives a future edit.
  ok(/CLASSIFIER COUPLING, deliberate/.test(src),
    'ingest.js documents the coupling at the call site');
  ok(/KEEP the phrase "briefer than\s*\n?\s*\/\/ the rest"|KEEP the phrase "briefer than/.test(src),
    'and names the exact phrase that must survive a reword');
}

// ── 22. Same-class warnings are aggregated before anyone reads them ────────
//
// A live re-run on a mature articles-scale domain produced 75 warnings, 58 of
// them the SAME sentence with a different page path. 77% of the report was one
// message, and the entries that needed action — one stub page, one stray
// summary, five rewritten pages — were buried under it.
//
// Note what these assertions are NOT protecting: the .md fix itself. Those 58
// pages were SILENTLY DROPPED before v3.0.16. The fix stays exactly as it is;
// only its reporting changes.
section('22. aggregateWarnings — one repeated slip cannot drown the report');
{
  // Mirrors classifyIngestEntry (src/public/app.js). Bucket preservation is the
  // whole risk of aggregation: collapse a group and you can silently change its
  // colour, because that classifier matches on SUBSTRINGS the members carried.
  function classify(w) {
    const lc = String(w || '').toLowerCase();
    if (lc.includes('injected the trunk page') || lc.includes('hub linkification') ||
        lc.includes('injected entities/') || lc.includes('injected the canonical summary') ||
        lc.includes('redirected to canonical') || lc.includes('redirected; bullets will merge') ||
        (lc.includes('dropping') && lc.includes('content will merge'))) return 'fixed';
    if (lc.includes('keeping both') || lc.includes("don't resolve") ||
        lc.includes('do not resolve') || lc.includes('stub page') ||
        lc.includes('briefer than the rest')) return 'review';
    if (lc.includes('truncated to')) return 'attention';
    return 'info';
  }

  const mdW      = p => `Page path "${p}" was missing the .md extension — wrote it as "${p}.md".`;
  const conciseW = p => `The AI's first attempt at "${p}" came back unusable, so The Curator asked for a shorter version and saved that instead. This is real content, but it is briefer than the rest — open it in the Wiki tab and re-ingest if it reads too thin.`;
  const stubW    = p => `Stub page created for "${p}" — LLM could not generate content. Re-ingest to fix.`;
  const batchW   = (n, t) => `Batch ${n} of ${t} was too large for the AI's output limit — wrote those pages individually instead.`;
  const noPathW  = () => 'The AI returned a page with no path — it could not be written.';
  const semDupeW = i => `Outline proposed "concepts/s-${i}.md" — possible semantic near-duplicate (Jaccard 0.50) of existing "concepts/t-${i}.md". Keeping both; review via Wiki Health → Scan for semantic duplicates if they're truly the same concept.`;

  eq(WARNING_AGGREGATION_THRESHOLD, 3, 'the aggregation threshold is 3');

  // ── The reported case, reconstructed at its real proportions ──────────────
  {
    const w = [];
    for (let i = 0; i < 58; i++) w.push(mdW(`concepts/p-${i}`));
    for (let i = 0; i < 5; i++)  w.push(conciseW(`concepts/r-${i}`));
    for (let i = 1; i <= 4; i++) w.push(batchW(i, 15));
    for (let i = 0; i < 3; i++)  w.push(semDupeW(i));
    w.push(stubW('concepts/z.md'));
    w.push('The AI invented 1 extra summary page (summaries/x.md) — merged into the canonical summary "summaries/s.md" instead of creating duplicates, so re-ingesting this source still updates the same page.');
    w.push("20 of 1126 wikilinks (1.8%) don't resolve to an existing page. Examples: a, b, c…. Run Wiki Health → Ask AI to fix or strip them, or re-ingest with broader entity coverage.");

    const out = aggregateWarnings(w);
    ok(out.length <= 12, `74 warnings collapse to a readable report (got ${out.length})`);
    eq(out.filter(x => /missing the \.md extension/.test(x)).length, 0,
      'not one of the 58 individual .md lines survives');
    const md = out.find(x => /without the "\.md" extension/.test(x));
    ok(md, 'they are replaced by a single counted entry');
    ok(md.includes('58 page paths'), 'which reports the true count');
    ok(md.includes('concepts/p-0') && md.includes('…and 55 more'),
      'with a few examples and an explicit "and N more" — never an unbounded list');
    ok(/nothing was lost/.test(md) && /change list above/.test(md),
      'and tells the user nothing was lost and where the per-page detail lives');

    // The signal that was being buried must still be individually readable.
    ok(out.some(x => x === stubW('concepts/z.md')),
      'the single stub page stays as its own specific, actionable line');
    ok(out.some(x => /extra summary page/.test(x)), 'the stray summary survives verbatim');
    ok(out.filter(x => /Keeping both/.test(x)).length === 3,
      'semantic near-duplicates are NOT aggregated — each names a specific pair to decide about');

    // Order is preserved, aggregates landing at their first member's position.
    ok(out.indexOf(md) === 0, 'an aggregate takes the position of the group\'s first member');
  }

  // ── Threshold behaviour ───────────────────────────────────────────────────
  for (const n of [1, 2]) {
    const w = Array.from({ length: n }, (_, i) => mdW(`concepts/a-${i}`));
    const out = aggregateWarnings(w);
    eq(out.length, n, `${n} occurrence(s) stay as specific per-page lines (below the threshold)`);
    ok(out.every(x => /missing the \.md extension/.test(x)), '  …with their original wording');
  }
  {
    const out = aggregateWarnings([mdW('a'), mdW('b'), mdW('c')]);
    eq(out.length, 1, 'exactly 3 occurrences DO aggregate (the threshold is inclusive)');
    ok(out[0].includes('3 page paths') && !out[0].includes('and 0 more'),
      '  …reporting 3 with no misleading "and N more" tail');
  }

  // ── Bucket preservation, per class ────────────────────────────────────────
  const CASES = [
    ['missing .md',    Array.from({ length: 5 }, (_, i) => mdW(`e/${i}`)),      'info',
     'nothing was lost and there is no user action, so it stays quiet blue'],
    ['concise rewrite', Array.from({ length: 5 }, (_, i) => conciseW(`e/${i}`)), 'review',
     'it ends in an instruction to go and look'],
    ['stub pages',     Array.from({ length: 5 }, (_, i) => stubW(`e/${i}`)),    'review',
     'placeholders always need the user'],
    ['batch overflow', Array.from({ length: 5 }, (_, i) => batchW(i, 20)),      'info',
     'recovered automatically with nothing lost'],
    ['no path',        Array.from({ length: 5 }, () => noPathW()),              'info',
     'matching the bucket its members already had'],
  ];
  for (const [label, members, expected, why] of CASES) {
    const out = aggregateWarnings(members);
    eq(out.length, 1, `${label}: 5 members collapse to 1`);
    eq(classify(out[0]), expected, `  …and the aggregate is ${expected} — ${why}`);
    // The members' own bucket must not change under the collapse.
    eq(classify(members[0]), classify(out[0]) === 'review' && expected === 'review' ? 'review' : classify(members[0]),
      `  …consistent with the individual member's bucket`);
  }
  // The two that MUST carry a trigger, stated explicitly so a reword can't drop it.
  ok(aggregateWarnings(Array.from({ length: 4 }, (_, i) => conciseW(`e/${i}`)))[0]
      .includes('briefer than the rest'),
    'the concise-rewrite aggregate keeps the exact phrase app.js buckets it amber on');
  ok(/stub page/i.test(aggregateWarnings(Array.from({ length: 4 }, (_, i) => stubW(`e/${i}`)))[0]),
    'the stub aggregate keeps "stub page" so it stays amber');
  ok(!/stub page|keeping both|don't resolve|do not resolve|truncated to|briefer than the rest/i
      .test(aggregateWarnings(Array.from({ length: 4 }, (_, i) => mdW(`e/${i}`)))[0]),
    'the .md aggregate carries NO amber/red trigger — it is genuinely informational');

  // ── Mixed, interleaved, and defensive input ───────────────────────────────
  {
    const w = [mdW('a'), stubW('x'), mdW('b'), 'something unrelated', mdW('c'), stubW('y'), mdW('d')];
    const out = aggregateWarnings(w);
    eq(out.length, 4, 'interleaved groups collapse independently');
    eq(out[0].includes('4 page paths'), true, 'the .md aggregate counts all 4 despite interleaving');
    ok(out.includes('something unrelated'), 'unrecognised warnings pass through untouched');
    ok(out.filter(x => /Stub page created for/.test(x)).length === 2,
      'a below-threshold class in the same array is left alone');
  }
  {
    const original = [mdW('a'), mdW('b'), mdW('c')];
    const copy = original.slice();
    aggregateWarnings(original);
    eq(JSON.stringify(original), JSON.stringify(copy), 'the input array is never mutated');
  }
  {
    let threw = false;
    for (const v of [null, undefined, 'not an array', 42, {}]) {
      try { ok(Array.isArray(aggregateWarnings(v)), `degenerate input ${JSON.stringify(v)} returns an array`); }
      catch { threw = true; }
    }
    ok(!threw, 'aggregateWarnings never throws on degenerate input');
    const mixed = aggregateWarnings([mdW('a'), null, 42, {}, mdW('b'), mdW('c')]);
    ok(mixed.some(x => /3 page paths/.test(x)), 'non-string entries are skipped, not counted');
    eq(mixed.length, 4, 'and non-string entries still pass through');
  }

  // ── Wiring: the aggregate must reach the LOG as well as the SSE payload ───
  const src = readFileSync(path.join(ROOT, 'src/brain/ingest.js'), 'utf8');
  ok(/const reportWarnings = aggregateWarnings\(warnings\);/.test(src),
    'ingestFile aggregates once, at a single chokepoint');
  ok(/warningSection = reportWarnings\.length/.test(src),
    'the domain log.md gets the AGGREGATED report, not the raw 58 lines');
  ok(/warnings: reportWarnings,/.test(src),
    'and so does the returned result, which becomes the SSE payload + result panel');
  ok(src.indexOf('const reportWarnings') < src.indexOf('const warningSection'),
    'aggregation happens before any consumer reads the array');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) {
  console.log('❌ FAILURES:');
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}
console.log('✅ All ingest prompt-slimming offline assertions green');
