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

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) {
  console.log('❌ FAILURES:');
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}
console.log('✅ All ingest prompt-slimming offline assertions green');
