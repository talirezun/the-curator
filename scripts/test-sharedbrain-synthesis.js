#!/usr/bin/env node
/**
 * Shared Brain — Phase 2E Battle Test (synthesis pipeline)
 *
 * The last milestone of Phase 2. Validates the full round-trip:
 *
 *   3 fellows push deltas → runLocalSynthesis → collective storage updated
 *   → all 3 fellows pull → each sees the synthesized output locally
 *
 * Scenarios:
 *   1. Pure helpers: parseExistingPage, extractSectionBullets,
 *      extractProvenanceContributors, jsonSafe, groupDeltasByPage
 *   2. mergeLinksForPage (Rule 2) — union + intersection-removal
 *   3. mergeFactsForPage (Rule 1+3) — exact dedup, Jaccard candidate
 *      detection, LLM resolution: unified / keep_a / keep_b / both
 *   4. mergeFactsForPage robustness — LLM throws → emits ⚠️ CONFLICTING
 *   5. composeCollectivePage — frontmatter + sections + provenance
 *   6. End-to-end synthesis: 3 fellows contribute non-conflicting facts;
 *      verify pages composed correctly with all facts unioned
 *   7. End-to-end synthesis: 3 fellows contribute contradictory facts;
 *      verify ⚠️ CONFLICTING SOURCES marker appears on the right pages
 *   8. Idempotency: re-running synthesis with no new contributions is a no-op
 *   9. Index rebuild: collective/<domain>/wiki/index.md contains all pages
 *  10. Full round-trip: synthesis → 3 fellows pull → all see same output
 *  11. last-synthesis state persists + advances run_number
 *  12. Security gate: disabled connection refused
 *
 * Run with:  node scripts/test-sharedbrain-synthesis.js
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

import { LocalFolderStorageAdapter } from '../src/brain/sharedbrain-local-adapter.js';
import { pushDomain, pullCollective } from '../src/brain/sharedbrain.js';
import {
  runLocalSynthesis,
  extractTitleFromContent,
  stripFrontmatter,
  extractSectionBullets,
  extractProvenanceContributors,
  groupDeltasByPage,
  mergeLinksForPage,
  mergeFactsForPage,
  buildProvenanceSection,
  composeCollectivePage,
  __testing as synthT,
} from '../src/brain/sharedbrain-synthesis.js';

// ── Harness ─────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
const failures = [];
function ok(label)        { passed++; console.log(`  ✓ ${label}`); }
function fail(label, err) { failed++; failures.push({ label, err }); console.log(`  ✗ ${label}`); if (err) console.log(`    └─ ${err.message || err}`); }
function assert(c, l, e)  { c ? ok(l) : fail(l, new Error(e || 'assertion failed')); }
function assertEq(a, e, l) {
  const sa = JSON.stringify(a);
  const se = JSON.stringify(e);
  sa === se ? ok(l) : fail(l, new Error(`expected ${se}, got ${sa}`));
}
function section(name) { console.log(`\n── ${name} ──`); }

const workspaceRoot = mkdtempSync(path.join(tmpdir(), 'sharedbrain-2e-'));
const storageRoot = path.join(workspaceRoot, 'shared-storage');
mkdirSync(storageRoot, { recursive: true });
console.log(`Phase 2E workspace: ${workspaceRoot}`);

function makeFellowDomainsDir(label) {
  const d = path.join(workspaceRoot, `${label}-domains`);
  mkdirSync(d, { recursive: true });
  return d;
}
function makeDomain(domainsDir, slug) {
  const wikiDir = path.join(domainsDir, slug, 'wiki');
  mkdirSync(path.join(wikiDir, 'entities'),  { recursive: true });
  mkdirSync(path.join(wikiDir, 'concepts'),  { recursive: true });
  mkdirSync(path.join(wikiDir, 'summaries'), { recursive: true });
  return wikiDir;
}
function writePage(wikiDir, relPath, content) {
  const abs = path.join(wikiDir, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}
function makeConnection(label, displayName, opts = {}) {
  return {
    id: randomUUID(),
    label,
    storage_type: 'local',
    local_storage_path: storageRoot,
    fellow_id: randomUUID(),
    fellow_display_name: displayName,
    shared_domain: 'work-ai',
    shared_brain_slug: 'cohort',
    local_domains: ['work-ai'],
    last_push_at: null,
    last_pull_at: null,
    pending_retry: {},
    permanent_skip: [],
    enabled: true,
    ...opts,
  };
}
const connections = {};
const patchFn = (id, patch) => {
  if (!connections[id]) return null;
  connections[id] = { ...connections[id], ...patch };
  return connections[id];
};

// ── 1. Parsing helpers ────────────────────────────────────────────────────

section('Parsing helpers');

const samplePage = `---
title: Anthropic
type: entity
---

# Anthropic

## Key Facts

- AI safety company.
- Founded in 2021.

## Related

- [[claude]]
- [[constitutional-ai]]

## Provenance

<!-- DO NOT EDIT -->
- Last synthesized: 2026-05-14T12:00:00Z
- Contributors: a3f9bbb1, b7c1aaaa
`;

assertEq(extractTitleFromContent(samplePage), 'Anthropic', 'extract H1 title');
assertEq(extractTitleFromContent('no title'), 'Untitled', 'fallback to Untitled');

const body = stripFrontmatter(samplePage);
assert(!body.startsWith('---'), 'stripFrontmatter removes YAML block');
assert(body.includes('# Anthropic'), 'stripFrontmatter preserves body content');

assertEq(extractSectionBullets(samplePage, 'Key Facts'),
  ['AI safety company.', 'Founded in 2021.'],
  'extractSectionBullets: Key Facts');
assertEq(extractSectionBullets(samplePage, 'Related').map(b => b.match(/\[\[(.+)\]\]/)[1]),
  ['claude', 'constitutional-ai'],
  'extractSectionBullets: Related (with bracket parse)');
assertEq(extractSectionBullets(samplePage, 'NonExistent'), [], 'missing section returns []');

assertEq(extractProvenanceContributors(samplePage),
  ['a3f9bbb1', 'b7c1aaaa'],
  'extractProvenanceContributors parses comma list');

// Tolerant of "Name (uuid)" style
const namedPage = samplePage.replace('a3f9bbb1, b7c1aaaa', 'Alice (a3f9bbb1), Bob (b7c1aaaa)');
assertEq(extractProvenanceContributors(namedPage),
  ['a3f9bbb1', 'b7c1aaaa'],
  'extractProvenanceContributors extracts ids from "Name (id)" form');

// ── 2. groupDeltasByPage ──────────────────────────────────────────────────

section('groupDeltasByPage');

const contributions = [
  { fellowId: 'fellow-a', payload: { fellow_id: 'fellow-a', deltas: [
    { path: 'entities/x.md', new_facts: ['from a'] },
    { path: 'concepts/y.md', new_facts: ['concept y from a'] },
  ]}},
  { fellowId: 'fellow-b', payload: { fellow_id: 'fellow-b', deltas: [
    { path: 'entities/x.md', new_facts: ['from b'] },
  ]}},
];
const grouped = groupDeltasByPage(contributions);
assertEq(grouped.size, 2, 'groups into 2 unique pages');
assertEq(grouped.get('entities/x.md').length, 2, 'x.md has 2 contributors');
assertEq(grouped.get('concepts/y.md').length, 1, 'y.md has 1 contributor');

// ── 3. mergeLinksForPage (Rule 2) ────────────────────────────────────────

section('mergeLinksForPage — Rule 2');

const linkMergeBasic = mergeLinksForPage(
  ['existing-link'],
  [
    { addedLinks: ['new-a', 'shared'], removedLinks: [] },
    { addedLinks: ['new-b', 'shared'], removedLinks: [] },
  ]
);
assertEq(linkMergeBasic, ['existing-link', 'new-a', 'new-b', 'shared'],
  'union of existing + adds, deduped + sorted');

const linkRemove = mergeLinksForPage(
  ['old-link', 'kept-link'],
  [
    { addedLinks: [], removedLinks: ['old-link'] },
    { addedLinks: [], removedLinks: ['old-link'] },
  ]
);
assertEq(linkRemove, ['kept-link'], 'removed_links drops link when nobody re-adds');

const linkResurrect = mergeLinksForPage(
  ['linkX'],
  [
    { addedLinks: [], removedLinks: ['linkX'] },
    { addedLinks: ['linkX'], removedLinks: [] },
  ]
);
assertEq(linkResurrect, ['linkX'],
  're-adding a removed link in same cycle keeps it (per spec spirit)');

assertEq(mergeLinksForPage([], []), [], 'empty input → empty output');

// ── 4. mergeFactsForPage — exact dedup + LLM resolution ───────────────────

section('mergeFactsForPage — Rule 1 + Rule 3');

// Mock LLM that responds to specific contradictions in canned ways
function makeMockResolver(scenarios = {}) {
  return async (_system, user) => {
    const aMatch = user.match(/Contributor A: "([^"]+)"/);
    const bMatch = user.match(/Contributor B: "([^"]+)"/);
    const a = aMatch ? aMatch[1] : '';
    const b = bMatch ? bMatch[1] : '';
    const key = `${a}|${b}`;
    const reverseKey = `${b}|${a}`;
    if (scenarios[key]) return JSON.stringify(scenarios[key]);
    if (scenarios[reverseKey]) {
      const s = scenarios[reverseKey];
      // Mirror resolution direction
      const mirrored = { ...s };
      if (s.resolution === 'keep_a') mirrored.resolution = 'keep_b';
      else if (s.resolution === 'keep_b') mirrored.resolution = 'keep_a';
      return JSON.stringify(mirrored);
    }
    // Default: 'both'
    return JSON.stringify({ resolution: 'both' });
  };
}

const shortenId = id => id.slice(0, 8);

// Scenario A: exact-dedup of identical facts (no LLM call needed for exact match)
{
  const result = await mergeFactsForPage(
    'Test',
    ['Fact A.'],
    [
      { contributorId: 'fellow-aaaa1111', facts: ['Fact A.'] },     // exact dup
      { contributorId: 'fellow-bbbb2222', facts: ['Fact A.'] },     // exact dup
    ],
    makeMockResolver(),
    shortenId
  );
  assertEq(result.unifiedFacts, ['Fact A.'], 'exact duplicates merged to one');
  assertEq(result.conflicts, 0, 'no contradictions');
}

// Scenario B: LLM picks "unified" — replace two near-dups with one synthesis
{
  const result = await mergeFactsForPage(
    'Anthropic',
    [],
    [
      { contributorId: 'fellow-aaaa1111', facts: ['AI safety lab founded in 2021.'] },
      { contributorId: 'fellow-bbbb2222', facts: ['AI safety company founded 2021.'] },
    ],
    makeMockResolver({
      'AI safety lab founded in 2021.|AI safety company founded 2021.': {
        resolution: 'unified',
        result: ['AI safety company founded in 2021.'],
      },
    }),
    shortenId
  );
  assertEq(result.unifiedFacts, ['AI safety company founded in 2021.'],
    'LLM-unified version replaces both originals');
  assertEq(result.conflicts, 0, 'unified → no conflict marker');
}

// Scenario C: LLM picks "both" — emit ⚠️ CONFLICTING marker
{
  const result = await mergeFactsForPage(
    'Context Engineering',
    [],
    [
      { contributorId: 'aaaa1111-1111-1111-1111-aaaaaaaaaaaa', facts: ['Coined in 2024 by Anthropic.'] },
      { contributorId: 'bbbb2222-2222-2222-2222-bbbbbbbbbbbb', facts: ['Coined in 2023 by Anthropic.'] },
    ],
    makeMockResolver({
      'Coined in 2024 by Anthropic.|Coined in 2023 by Anthropic.': { resolution: 'both' },
    }),
    synthT.defaultShortenId
  );
  assertEq(result.conflicts, 1, '1 conflict marker emitted');
  const conflictBullet = result.unifiedFacts.find(f => f.startsWith(synthT.CONFLICT_MARKER));
  assert(conflictBullet, 'conflict marker present in unifiedFacts');
  assert(/Coined in 2024.*aaaa1111/.test(conflictBullet),
    'conflict marker carries contributor A attribution');
  assert(/Coined in 2023.*bbbb2222/.test(conflictBullet),
    'conflict marker shows contributor B too');
}

// Scenario D: LLM picks "keep_a" — drop the second.
// Strings must be similar enough that Jaccard flags them (>=0.5 and <1.0).
// "Coined in 2024" vs "Coined in 2023" hits 0.5 (overlap = coined+anthropic = 2 of 4 union).
{
  const result = await mergeFactsForPage(
    'Topic',
    [],
    [
      { contributorId: 'aaaa1111-1111-1111-1111-aaaaaaaaaaaa', facts: ['Coined in 2024 by Anthropic.'] },
      { contributorId: 'bbbb2222-2222-2222-2222-bbbbbbbbbbbb', facts: ['Coined in 2023 by Anthropic.'] },
    ],
    makeMockResolver({
      'Coined in 2024 by Anthropic.|Coined in 2023 by Anthropic.': { resolution: 'keep_a' },
    }),
    synthT.defaultShortenId
  );
  assert(result.unifiedFacts.includes('Coined in 2024 by Anthropic.'), 'kept fact A');
  assert(!result.unifiedFacts.includes('Coined in 2023 by Anthropic.'), 'dropped fact B');
  assertEq(result.conflicts, 0, 'no conflict marker (resolved by keep_a)');
}

// Scenario E: LLM throws — fallback to 'both' (CONFLICT marker emitted, conservative)
{
  const throwingLLM = async () => { throw new Error('quota exceeded'); };
  const result = await mergeFactsForPage(
    'Topic',
    [],
    [
      { contributorId: 'fellow-aaaa1111', facts: ['Fact alpha version one.'] },
      { contributorId: 'fellow-bbbb2222', facts: ['Fact alpha version two.'] },
    ],
    throwingLLM,
    shortenId
  );
  assertEq(result.conflicts, 1, 'LLM throw → conservative fallback emits CONFLICT marker');
}

// Scenario F: existing facts merged with new facts
{
  const result = await mergeFactsForPage(
    'Topic',
    ['Established fact from prior synthesis.'],
    [
      { contributorId: 'fellow-aaaa1111', facts: ['New unique fact from A.'] },
    ],
    makeMockResolver(),
    shortenId
  );
  assertEq(result.unifiedFacts,
    ['Established fact from prior synthesis.', 'New unique fact from A.'],
    'existing + new facts union-merged in order');
}

// Scenario G: independent facts (Jaccard < 0.5) → both kept, no LLM call
{
  let llmCalled = false;
  const trackingLLM = async () => { llmCalled = true; return JSON.stringify({ resolution: 'both' }); };
  const result = await mergeFactsForPage(
    'Topic',
    [],
    [
      { contributorId: 'fellow-aaaa1111', facts: ['Anthropic is an AI safety company.'] },
      { contributorId: 'fellow-bbbb2222', facts: ['OpenAI builds GPT-class models.'] },
    ],
    trackingLLM,
    shortenId
  );
  assertEq(result.unifiedFacts.length, 2, 'both independent facts kept');
  assert(!llmCalled, 'LLM not invoked for independent facts (Jaccard < 0.5)');
}

// ── 5. buildProvenanceSection + composeCollectivePage ────────────────────

section('buildProvenanceSection + composeCollectivePage');

const prov = buildProvenanceSection(
  ['aaaa1111-1111-1111-1111-aaaaaaaaaaaa', 'bbbb2222-2222-2222-2222-bbbbbbbbbbbb'],
  '2026-05-14T12:00:00Z',
  synthT.defaultShortenId
);
assert(prov.includes('## Provenance'), 'Provenance section heading');
assert(prov.includes('Last synthesized: 2026-05-14T12:00:00Z'), 'timestamp line');
assert(prov.includes('Contributors: aaaa1111, bbbb2222'), 'contributor short ids');
assert(prov.includes('DO NOT EDIT'), 'auto-generated marker');

const composed = composeCollectivePage({
  title: 'Anthropic',
  type: 'entity',
  keyFacts: ['AI safety company.', 'Founded in 2021.'],
  relatedLinks: ['claude', 'constitutional-ai'],
  provenanceSection: prov,
  lastSynthesizedIso: '2026-05-14T12:00:00Z',
});
assert(composed.startsWith('---\ntitle: Anthropic'), 'composed page starts with YAML frontmatter');
assert(composed.includes('type: entity'), 'frontmatter type');
assert(composed.includes('source: shared-brain-synthesis'), 'frontmatter source marker');
assert(composed.includes('# Anthropic'), 'H1 title');
assert(composed.includes('## Key Facts'), 'Key Facts section');
assert(composed.includes('- AI safety company.'), 'first fact bullet');
assert(composed.includes('## Related'), 'Related section');
assert(composed.includes('- [[claude]]'), 'first link bullet');
assert(composed.includes('## Provenance'), 'Provenance section');

// Composed page with no facts or links — sections skipped
const empty = composeCollectivePage({
  title: 'X', type: 'concept', keyFacts: [], relatedLinks: [],
  provenanceSection: prov, lastSynthesizedIso: '2026-05-14T12:00:00Z',
});
assert(!empty.includes('## Key Facts'), 'no Key Facts section when empty');
assert(!empty.includes('## Related'), 'no Related section when empty');
assert(empty.includes('## Provenance'), 'Provenance still present');

// ── 6. End-to-end synthesis — non-conflicting facts ─────────────────────

section('End-to-end synthesis — three fellows, no conflicts');

// Set up three fellows, each with a personal domain. They all push deltas
// to the same shared_domain. Then we run synthesis and verify the output.

const fellowA = makeFellowDomainsDir('fellow-a');
const fellowB = makeFellowDomainsDir('fellow-b');
const fellowC = makeFellowDomainsDir('fellow-c');

const wikiA = makeDomain(fellowA, 'work-ai');
const wikiB = makeDomain(fellowB, 'work-ai');
const wikiC = makeDomain(fellowC, 'work-ai');

// Each fellow has unique content
writePage(wikiA, 'entities/anthropic.md', '# Anthropic\n\nAI safety lab.\n');
writePage(wikiB, 'entities/anthropic.md', '# Anthropic\n\nBased in San Francisco.\n');
writePage(wikiC, 'entities/openai.md', '# OpenAI\n\nGPT research lab.\n');

const connA = makeConnection('Cohort', 'Alice');
const connB = makeConnection('Cohort', 'Bob');
const connC = makeConnection('Cohort', 'Carol');
connections[connA.id] = connA;
connections[connB.id] = connB;
connections[connC.id] = connC;

// Mock LLM for delta generation — returns deterministic deltas based on content.
// Content extraction: slice between known markers in the prompt rather than
// using a lazy regex (which stops at the first blank line and would yield ""
// for content like "# Anthropic\n\nAI safety lab.\n").
function makeDeltaLLM() {
  return async (_system, user) => {
    const pathMatch = user.match(/PAGE PATH:\s*(\S+)/);
    const pagePath = pathMatch ? pathMatch[1] : '';

    const startMarker = 'CONTENT (new page):\n';
    const endMarker = '\n\nExtract the following:';
    const startIdx = user.indexOf(startMarker);
    const endIdx = user.indexOf(endMarker, startIdx);
    const content = (startIdx >= 0 && endIdx > startIdx)
      ? user.slice(startIdx + startMarker.length, endIdx)
      : '';

    // Pull the first non-heading, non-empty line as a fact
    const factLine = content.split('\n').find(l => l.trim() && !l.startsWith('#')) || 'No facts.';
    const slug = pagePath.replace(/^(entities|concepts|summaries)\//, '').replace(/\.md$/, '');
    return JSON.stringify({
      title: slug.charAt(0).toUpperCase() + slug.slice(1),
      new_facts: [factLine.trim()],
      stable_facts: [],
      new_links: [],
      removed_links: [],
      key_entities: [],
    });
  };
}

const deltaLLM = makeDeltaLLM();
await pushDomain(connA, 'work-ai', { llmFn: deltaLLM, domainsDir: fellowA, patchFn });
await pushDomain(connB, 'work-ai', { llmFn: deltaLLM, domainsDir: fellowB, patchFn });
await pushDomain(connC, 'work-ai', { llmFn: deltaLLM, domainsDir: fellowC, patchFn });

// Run synthesis (Fellow A acts as the "admin")
const synth1 = await runLocalSynthesis(connections[connA.id], {
  llmFn: makeMockResolver(),  // no conflicts expected
  patchFn,
});

assert(synth1.ok, 'synthesis returned ok');
assertEq(synth1.processed_contributions, 3, 'processed 3 contributions');
assert(synth1.pages_written >= 2, `wrote at least 2 pages (got ${synth1.pages_written})`);
assertEq(synth1.conflicts, 0, 'no conflicts on non-conflicting input');

// Read back synthesized pages from storage
const adapter = new LocalFolderStorageAdapter({ storage_root: storageRoot });
const anthropic = await adapter.readPage('work-ai', 'entities/anthropic.md');
assert(anthropic !== null, 'synthesized anthropic.md exists in storage');
assert(anthropic.includes('AI safety lab'), 'Fellow A\'s fact present');
assert(anthropic.includes('Based in San Francisco'), 'Fellow B\'s fact present');
assert(anthropic.includes('## Provenance'), 'Provenance section appended');
assert(/Contributors:.*[a-f0-9]{8}/.test(anthropic), 'Provenance lists contributor short ids');

const openai = await adapter.readPage('work-ai', 'entities/openai.md');
assert(openai !== null, 'synthesized openai.md exists');
assert(openai.includes('GPT research lab'), 'Fellow C\'s fact present');

// ── 7. End-to-end synthesis — conflicts trigger ⚠️ marker ───────────────

section('End-to-end synthesis — conflict detection');

// Each fellow contributes a different YEAR for "context-engineering"
const fellowDdir = makeFellowDomainsDir('fellow-d');
const fellowEdir = makeFellowDomainsDir('fellow-e');
const wikiD = makeDomain(fellowDdir, 'work-ai');
const wikiE = makeDomain(fellowEdir, 'work-ai');
writePage(wikiD, 'concepts/context-engineering.md',
  '# Context Engineering\n\nCoined in 2024 by Anthropic.\n');
writePage(wikiE, 'concepts/context-engineering.md',
  '# Context Engineering\n\nCoined in 2023 by Anthropic.\n');

const connD = makeConnection('Cohort', 'Dana');
const connE = makeConnection('Cohort', 'Evan');
connections[connD.id] = connD;
connections[connE.id] = connE;

await pushDomain(connD, 'work-ai', { llmFn: deltaLLM, domainsDir: fellowDdir, patchFn });
await pushDomain(connE, 'work-ai', { llmFn: deltaLLM, domainsDir: fellowEdir, patchFn });

// Run synthesis again. The conflict-resolution LLM is told to call this pair "both".
const synth2 = await runLocalSynthesis(connections[connD.id], {
  llmFn: makeMockResolver({
    'Coined in 2024 by Anthropic.|Coined in 2023 by Anthropic.': { resolution: 'both' },
  }),
  patchFn,
});

assert(synth2.ok, 'synthesis with conflicts returned ok');
assert(synth2.conflicts >= 1, `at least 1 conflict flagged (got ${synth2.conflicts})`);

const ctxEng = await adapter.readPage('work-ai', 'concepts/context-engineering.md');
assert(ctxEng !== null, 'synthesized concepts/context-engineering.md exists');
assert(ctxEng.includes('⚠️ CONFLICTING SOURCES'),
  'page contains ⚠️ CONFLICTING SOURCES marker');
// Attribution uses 8-char short ids (no 'fellow-' prefix in the output).
assert(/Coined in 2024.*per [a-f0-9]{8}/.test(ctxEng) && /Coined in 2023.*per [a-f0-9]{8}/.test(ctxEng),
  'both contradictory facts present with contributor attribution');

// ── 8. Synthesis idempotency ─────────────────────────────────────────────

section('Synthesis idempotency — re-run with no new contributions');

const synth3 = await runLocalSynthesis(connections[connA.id], {
  llmFn: makeMockResolver(),
  patchFn,
});

// After synth2, last-synthesis state was advanced. synth3 should see 0 new.
assert(synth3.ok, 'idempotent re-run returns ok');
assertEq(synth3.processed_contributions, 0, '0 new contributions on re-run');
assertEq(synth3.pages_written, 0, '0 pages written on re-run');

// ── 8b. Windows device names ───────────────────────────────────

section('A contribution cannot create a page Windows could not open');

const fellowFdir = makeFellowDomainsDir('fellow-f');
const wikiF = makeDomain(fellowFdir, 'work-ai');
writePage(wikiF, 'concepts/con.md', '# Con\n\nA reserved name.\n');
writePage(wikiF, 'concepts/nul.md', '# Nul\n\nAlready in the collective.\n');
writePage(wikiF, 'concepts/console-page.md', '# Console\n\nAn ordinary name.\n');
await adapter.writePage('work-ai', 'concepts/nul.md', '# Nul\n\n## Key Facts\n- Was there before\n');
const connF = makeConnection('Cohort', 'Fay');
connections[connF.id] = connF;
await pushDomain(connF, 'work-ai', { llmFn: deltaLLM, domainsDir: fellowFdir, patchFn });
const reservedNotes = [];
const synthF = await runLocalSynthesis(connections[connF.id], {
  llmFn: makeMockResolver(),
  patchFn,
  onProgress: (kind, msg) => { if (kind === 'warn') reservedNotes.push(msg); },
});
assert(synthF.ok, 'synthesis with a reserved name returned ok');
assert((await adapter.readPage('work-ai', 'concepts/con.md')) === null, 'concepts/con.md was not created in the collective');
assert(reservedNotes.some((m) => m.includes('concepts/con.md') && m.includes('Windows')), 'and the run says so');
assert((await adapter.readPage('work-ai', 'concepts/console-page.md')) !== null, 'an ordinary name in the same run was written');
assert(!reservedNotes.some((m) => m.includes('concepts/nul.md')), 'a reserved name already in the collective is not refused');

// ── 9. Index rebuild ────────────────────────────────────────────────────

section('Index rebuild (Rule 5)');

const idx = await adapter.readPage('work-ai', 'index.md');
assert(idx !== null, 'index.md generated by synthesis');
assert(idx.includes('Wiki Index'), 'index.md has heading');
assert(idx.includes('entities/anthropic.md'), 'index references anthropic.md');
assert(idx.includes('entities/openai.md'), 'index references openai.md');
assert(idx.includes('concepts/context-engineering.md'), 'index references concept page');
assert(idx.includes('| entity |'),  'page type column shows "entity"');
assert(idx.includes('| concept |'), 'page type column shows "concept"');

// ── 10. Full round-trip: synthesis → pull, three fellows converge ───────

section('Full round-trip — fellows pull synthesized output');

const pullA = await pullCollective(connections[connA.id], { domainsDir: fellowA, patchFn });
const pullB = await pullCollective(connections[connB.id], { domainsDir: fellowB, patchFn });
const pullC = await pullCollective(connections[connC.id], { domainsDir: fellowC, patchFn });

assert(pullA.ok, 'Fellow A pull ok');
assert(pullB.ok, 'Fellow B pull ok');
assert(pullC.ok, 'Fellow C pull ok');

// Each fellow now has the synthesized output locally
const localA = readFileSync(path.join(fellowA, 'shared-cohort/wiki/entities/anthropic.md'), 'utf-8');
const localB = readFileSync(path.join(fellowB, 'shared-cohort/wiki/entities/anthropic.md'), 'utf-8');
const localC = readFileSync(path.join(fellowC, 'shared-cohort/wiki/entities/anthropic.md'), 'utf-8');

// All three should have BOTH facts (synthesized from A and B's pushes)
assert(localA.includes('AI safety lab') && localA.includes('Based in San Francisco'),
  'Fellow A locally has both facts after synth + pull');
assert(localB.includes('AI safety lab') && localB.includes('Based in San Francisco'),
  'Fellow B locally has both facts after synth + pull');
assert(localC.includes('AI safety lab') && localC.includes('Based in San Francisco'),
  'Fellow C locally has both facts after synth + pull');

// All three should have the Provenance section
assert(localA.includes('## Provenance') && localB.includes('## Provenance') && localC.includes('## Provenance'),
  'all three fellows have Provenance section locally');

// And they all have the conflict marker for context-engineering
const localCtxA = readFileSync(path.join(fellowA, 'shared-cohort/wiki/concepts/context-engineering.md'), 'utf-8');
assert(localCtxA.includes('⚠️ CONFLICTING SOURCES'),
  'Fellow A locally has the conflict marker after pull');

// ── 11. last-synthesis state persists ─────────────────────────────────────

section('last-synthesis state — run number advances');

const state = await adapter.readMeta('state.last-synthesis');
assert(state !== null, 'last-synthesis state recorded');
assert(typeof state.at === 'string' && state.at.length > 0, 'state has timestamp');
assert(state.run_number >= 2, `run_number advanced (got ${state.run_number} after 2 syntheses)`);

// Connection's last_synthesis_at populated
assert(connections[connA.id].last_synthesis_at, 'connection.last_synthesis_at populated');

// ── 12. Security gates ──────────────────────────────────────────────────

section('Security gates');

{
  const disabled = { ...connA, enabled: false };
  const r = await runLocalSynthesis(disabled, { llmFn: makeMockResolver(), patchFn });
  assert(!r.ok, 'disabled connection refused');
  assert(/disabled/i.test(r.error || ''), 'error mentions disabled');
}
{
  const r = await runLocalSynthesis(null, { llmFn: makeMockResolver(), patchFn });
  assert(!r.ok, 'null connection refused');
}
{
  const noDomain = { ...connA, shared_domain: '' };
  const r = await runLocalSynthesis(noDomain, { llmFn: makeMockResolver(), patchFn });
  assert(!r.ok, 'missing shared_domain refused');
}

// Cleanup
console.log('\nCleaning up...');
rmSync(workspaceRoot, { recursive: true, force: true });
console.log(`Removed ${workspaceRoot}`);

// Summary
console.log('\n══════════════════════════════════════');
console.log(`  Total: ${passed + failed}   Passed: ${passed}   Failed: ${failed}`);
console.log('══════════════════════════════════════');
if (failed > 0) {
  console.log('\nFAILURES:');
  for (const { label, err } of failures) {
    console.log(`  ✗ ${label}`);
    if (err) console.log(`    └─ ${err.message || err}`);
  }
  process.exit(1);
}
console.log('\nAll Phase 2E synthesis tests green. Phase 2 complete. Ready for v2.7.0 release.');
process.exit(0);
