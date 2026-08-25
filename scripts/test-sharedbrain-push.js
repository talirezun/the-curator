#!/usr/bin/env node
/**
 * Shared Brain — Phase 2B Battle Test (push orchestration + delta)
 *
 * Validates the delta module + pushDomain orchestration by simulating a real
 * cohort end-to-end:
 *
 *   - Spins up an isolated /tmp folder as the "shared storage root"
 *   - Creates THREE separate "fellow workspaces" — each with its own domains
 *     folder + its own connection — pointing at the same shared storage
 *   - Each fellow has wiki pages on disk (entities, concepts, summaries)
 *   - Each pushes with a MOCK LLM (no real Gemini call) and the test
 *     verifies the resulting contribution payloads land correctly
 *
 * Scenarios:
 *   1. Pure delta helpers: extractTitle / extractWikilinks / classifyPage
 *   2. Cross-domain link filter (Decision 2 — strict)
 *   3. Jaccard similarity buckets (Decision 4)
 *   4. generateDeltaSummary with happy-path mock LLM
 *   5. generateDeltaSummary with failing mock LLM → fallback returned
 *   6. pushDomain happy path — 3-fellow cohort, each pushes different pages
 *   7. pushDomain security gate — refuses domain not in local_domains
 *   8. pushDomain LLM failure tracking — pending_retry counter increments
 *   9. pushDomain permanent_skip after 3 failures
 *  10. pushDomain idempotency — second push with no changes returns 0 pushed
 *
 * Run with:  node scripts/test-sharedbrain-push.js
 * Exit code 0 if all green; non-zero on any failure.
 *
 * This test does NOT call any real LLM and does NOT touch your production
 * .sharedbrain-config.json or domains folder. It uses isolated /tmp folders
 * and an in-memory patch function for connection state.
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, utimesSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

import { LocalFolderStorageAdapter } from '../src/brain/sharedbrain-local-adapter.js';
import {
  extractTitle, extractWikilinks, classifyPage, filterToDomainLinks,
  jaccardSimilarity, tokenize,
  buildDeltaPrompt, buildFallbackDelta, generateDeltaSummary,
} from '../src/brain/sharedbrain-delta.js';
import {
  pushDomain, findChangedPages, getAllPagePaths, MAX_RETRY_ATTEMPTS,
  loadPriorContent,
} from '../src/brain/sharedbrain.js';
import { __setUserDataDirOverride } from '../src/brain/paths.js';
import { execFileSync } from 'child_process';

// ── Test harness (same shape as Phase 2A) ──────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function ok(label)        { passed++; console.log(`  ✓ ${label}`); }
function fail(label, err) { failed++; failures.push({ label, err }); console.log(`  ✗ ${label}`); if (err) console.log(`    └─ ${err.message || err}`); }
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) ok(label);
  else fail(label, new Error(`expected ${e}, got ${a}`));
}
function assert(cond, label, errMsg) {
  if (cond) ok(label);
  else fail(label, new Error(errMsg || 'assertion failed'));
}
function section(name) { console.log(`\n── ${name} ──`); }

// ── Setup: an isolated workspace tree ──────────────────────────────────────

const workspaceRoot = mkdtempSync(path.join(tmpdir(), 'sharedbrain-2b-'));
const storageRoot   = path.join(workspaceRoot, 'shared-storage');
mkdirSync(storageRoot, { recursive: true });

console.log(`Phase 2B workspace: ${workspaceRoot}`);
console.log(`Shared storage:     ${storageRoot}`);

// Each fellow gets their own domains-dir. They share storageRoot.
function makeFellowWorkspace(label) {
  const domainsDir = path.join(workspaceRoot, `${label}-domains`);
  mkdirSync(domainsDir, { recursive: true });
  return domainsDir;
}

function makeDomain(domainsDir, domainSlug) {
  const wikiDir = path.join(domainsDir, domainSlug, 'wiki');
  mkdirSync(path.join(wikiDir, 'entities'),  { recursive: true });
  mkdirSync(path.join(wikiDir, 'concepts'),  { recursive: true });
  mkdirSync(path.join(wikiDir, 'summaries'), { recursive: true });
  return wikiDir;
}

function writePage(wikiDir, relPath, content, mtimeOverride = null) {
  const abs = path.join(wikiDir, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
  if (mtimeOverride) {
    const t = mtimeOverride instanceof Date ? mtimeOverride : new Date(mtimeOverride);
    utimesSync(abs, t, t);
  }
}

// Mock LLM — returns a canned DeltaSummary-ish JSON. Configurable per page.
function makeMockLLM(pageResponses = {}, defaultBehaviour = 'echo') {
  return async (_system, user, _maxTokens) => {
    // Extract PAGE PATH from the user prompt so we can look up the canned response.
    const pathMatch = user.match(/PAGE PATH:\s*(\S+)/);
    const pagePath = pathMatch ? pathMatch[1] : '';
    const canned = pageResponses[pagePath];

    if (canned === 'throw') {
      throw new Error(`mock LLM: simulated failure for ${pagePath}`);
    }
    if (canned === 'malformed') {
      return 'not json at all { broken';
    }
    if (canned && typeof canned === 'object') {
      return JSON.stringify(canned);
    }
    if (defaultBehaviour === 'echo') {
      // Default canned response: title from path, no facts, no links.
      const slug = pagePath.replace(/^(entities|concepts|summaries)\//, '').replace(/\.md$/, '');
      return JSON.stringify({
        title: slug,
        new_facts: [`Default fact about ${slug}.`],
        stable_facts: [],
        new_links: [],
        removed_links: [],
        key_entities: [],
      });
    }
    throw new Error(`mock LLM: no canned response for ${pagePath}`);
  };
}

// In-memory replacement for patchSharedBrain — tests track state without writing config.
function makePatchFn(connectionsById) {
  return (id, patch) => {
    const existing = connectionsById[id];
    if (!existing) return null;
    // Reject token-field updates the way the real patchSharedBrain does.
    for (const field of ['github_pat', 'fellow_token', 'admin_token']) {
      if (field in patch) {
        throw new Error(`patchSharedBrain: cannot update credential field "${field}" via patch`);
      }
    }
    connectionsById[id] = { ...existing, ...patch };
    return connectionsById[id];
  };
}

function makeConnection(label, fellowDisplayName, domainsDir) {
  return {
    id: randomUUID(),
    label,
    storage_type: 'local',
    local_storage_path: storageRoot,
    fellow_id: randomUUID(),
    fellow_display_name: fellowDisplayName,
    // v3.6.2: the display name only reaches shared storage when the
    // contributor opted in (contributorNameForStorage). This suite exercises
    // push MECHANICS and asserts the name lands in the payload, so its fellows
    // are opted in. The privacy gate itself — including every fail-closed case
    // and a byte-level scan of the written files — lives in
    // scripts/test-sharedbrain-attribution.js.
    attribute_by_name: true,
    shared_domain: 'work-ai',
    shared_brain_slug: 'test-cohort',
    local_domains: ['work-ai'],
    last_push_at: null,
    pending_retry: {},
    permanent_skip: [],
    enabled: true,
    // domainsDir is passed via opts to pushDomain; not part of the connection schema
    __testDomainsDir: domainsDir,
  };
}

// ─── 1. Pure delta helpers ────────────────────────────────────────────────

section('Delta helpers (pure functions)');

assertEq(extractTitle('# Foo Bar\n\nbody'), 'Foo Bar', 'extractTitle reads first H1');
assertEq(extractTitle('no heading here'), 'Untitled', 'extractTitle falls back to "Untitled"');
assertEq(extractTitle(''), 'Untitled', 'extractTitle handles empty');
assertEq(extractTitle(null), 'Untitled', 'extractTitle handles null');

assertEq(
  extractWikilinks('See [[foo]] and [[concepts/bar]] and [[entities/baz]].'),
  ['foo', 'bar', 'baz'],
  'extractWikilinks strips folder prefixes'
);
assertEq(extractWikilinks('no links here'), [], 'extractWikilinks returns empty when no links');

assertEq(classifyPage('entities/foo.md'),  'entity',  'classifyPage entity');
assertEq(classifyPage('concepts/foo.md'),  'concept', 'classifyPage concept');
assertEq(classifyPage('summaries/foo.md'), 'summary', 'classifyPage summary');
assertEq(classifyPage('other/foo.md'),     'unknown', 'classifyPage unknown');

// ─── 2. Cross-domain link filter (Decision 2, strict) ────────────────────

section('filterToDomainLinks — strict cross-domain stripping (Decision 2)');

const domainPaths = [
  'entities/anthropic.md',
  'entities/openai.md',
  'concepts/rag.md',
  'summaries/foo.md',
];

assertEq(
  filterToDomainLinks(['anthropic', 'openai'], domainPaths),
  ['anthropic', 'openai'],
  'in-domain links pass through'
);
assertEq(
  filterToDomainLinks(['anthropic', 'tali-rezun'], domainPaths),
  ['anthropic'],
  'out-of-domain link stripped (tali-rezun is in a different domain)'
);
assertEq(
  filterToDomainLinks(['concepts/rag'], domainPaths),
  ['rag'],
  'folder-prefixed link normalised'
);
assertEq(
  filterToDomainLinks(['Anthropic', 'ANTHROPIC'], domainPaths),
  ['Anthropic'],
  'case-insensitive match + dedup'
);
assertEq(
  filterToDomainLinks(['Anthropic Inc'], domainPaths),  // would normalise to "anthropic-inc"
  [],
  'multi-word link without matching slug is stripped'
);
assertEq(filterToDomainLinks([], domainPaths), [], 'empty input → empty output');
assertEq(filterToDomainLinks(['foo'], []), [], 'empty domain → all links stripped');
assertEq(
  filterToDomainLinks(['anthropic'], domainPaths).length,
  1,
  'duplicate detection counts once'
);

// ─── 3. Jaccard similarity buckets (Decision 4) ───────────────────────────

section('jaccardSimilarity — contradiction-detection buckets (Decision 4)');

const identical = jaccardSimilarity(
  'Context Engineering coined in 2024 by Anthropic',
  'context engineering coined in 2024 by anthropic'
);
assert(identical === 1.0, `identical strings → 1.0 (got ${identical})`);

const conflicting = jaccardSimilarity(
  'Context Engineering coined in 2024 by Anthropic',
  'Context Engineering coined in 2023 by Anthropic'
);
assert(
  conflicting >= 0.5 && conflicting < 1.0,
  `same fact different year → 0.5 ≤ s < 1.0 (got ${conflicting})`
);

const independent = jaccardSimilarity(
  'Anthropic is an AI safety company',
  'OpenAI builds GPT-class language models'
);
assert(
  independent < 0.5,
  `unrelated statements → s < 0.5 (got ${independent})`
);

assert(jaccardSimilarity('', '') === 1.0, 'empty/empty → 1.0 (degenerate identical)');
assert(jaccardSimilarity('foo', '') === 0.0, 'foo/empty → 0.0');
assert(jaccardSimilarity('', 'bar') === 0.0, 'empty/bar → 0.0');

// Tokenizer drops stop words and short tokens. It does NOT dedup —
// callers (e.g. jaccardSimilarity) wrap the result in a Set if they need that.
const toks = tokenize('The quick brown fox is a fox.');
assertEq(toks.sort(), ['brown', 'fox', 'fox', 'quick'], 'tokenize drops stop words + short tokens; preserves duplicates');

// ─── 4. generateDeltaSummary — happy path with mock LLM ───────────────────

section('generateDeltaSummary — happy path');

{
  const mockLLM = makeMockLLM({
    'concepts/rag.md': {
      title: 'RAG',
      new_facts: ['Retrieval-augmented generation combines retrieval and LLMs.'],
      stable_facts: [],
      new_links: ['anthropic', 'tali-rezun'],
      removed_links: [],
      key_entities: ['anthropic'],
    },
  });

  const result = await generateDeltaSummary({
    pagePath: 'concepts/rag.md',
    currentContent: '# RAG\n\n[[anthropic]] [[tali-rezun]]\n',
    priorContent: null,
    fellowId: 'fellow-1',
    fellowDisplayName: 'Fellow One',
    domainPagePaths: ['entities/anthropic.md', 'concepts/rag.md'],
    options: { llmFn: mockLLM },
  });

  assert(result.ok, 'happy path returns ok=true');
  assertEq(result.delta.path, 'concepts/rag.md', 'delta carries pagePath');
  assertEq(result.delta.type, 'concept', 'delta type classified');
  assertEq(result.delta.title, 'RAG', 'delta title from LLM');
  assertEq(result.delta.new_facts.length, 1, 'one new fact');
  assertEq(result.delta.new_links, ['anthropic'], 'cross-domain link "tali-rezun" stripped');
  assertEq(result.delta.contributor_id, 'fellow-1', 'delta carries fellow_id');
  assertEq(result.delta.contributor_name, 'Fellow One', 'delta carries display name');
  assertEq(result.delta.full_content_fallback, null, 'fallback is null on success');
}

// ─── 5. generateDeltaSummary — LLM failure returns fallback ───────────────

section('generateDeltaSummary — LLM failures');

{
  const throwLLM = makeMockLLM({ 'concepts/x.md': 'throw' });
  const result = await generateDeltaSummary({
    pagePath: 'concepts/x.md',
    currentContent: '# X\n',
    priorContent: null,
    fellowId: 'f', fellowDisplayName: 'F',
    domainPagePaths: ['concepts/x.md'],
    options: { llmFn: throwLLM },
  });
  assert(!result.ok, 'thrown LLM returns ok=false');
  assert(/LLM call failed/.test(result.error || ''), 'error message mentions LLM');
  assert(result.fallback && result.fallback.full_content_fallback === '# X\n', 'fallback DeltaSummary attached');
  assertEq(result.fallback.path, 'concepts/x.md', 'fallback path matches');
}

{
  const malformedLLM = makeMockLLM({ 'concepts/y.md': 'malformed' });
  const result = await generateDeltaSummary({
    pagePath: 'concepts/y.md',
    currentContent: '# Y\n',
    priorContent: null,
    fellowId: 'f', fellowDisplayName: 'F',
    domainPagePaths: ['concepts/y.md'],
    options: { llmFn: malformedLLM },
  });
  assert(!result.ok, 'malformed LLM JSON returns ok=false');
  assert(/parse failed/.test(result.error || ''), 'error message mentions parse');
  assert(result.fallback, 'fallback attached on parse failure');
}

// ─── 6. pushDomain happy path — 3-fellow cohort ───────────────────────────

section('pushDomain — three fellows push concurrently');

// Fellow A's domain — has 2 wiki pages
const fellowA_DomainsDir = makeFellowWorkspace('fellow-a');
const fellowA_WikiDir = makeDomain(fellowA_DomainsDir, 'work-ai');
writePage(fellowA_WikiDir, 'entities/anthropic.md',
  '# Anthropic\n\nAI safety lab. [[claude]] [[tali-rezun]]\n');
writePage(fellowA_WikiDir, 'concepts/rag.md',
  '# RAG\n\nRetrieval-augmented generation.\n');

// Fellow B's domain — 1 wiki page
const fellowB_DomainsDir = makeFellowWorkspace('fellow-b');
const fellowB_WikiDir = makeDomain(fellowB_DomainsDir, 'work-ai');
writePage(fellowB_WikiDir, 'entities/openai.md',
  '# OpenAI\n\nResearch lab. [[gpt]]\n');

// Fellow C's domain — 1 wiki page
const fellowC_DomainsDir = makeFellowWorkspace('fellow-c');
const fellowC_WikiDir = makeDomain(fellowC_DomainsDir, 'work-ai');
writePage(fellowC_WikiDir, 'concepts/context-engineering.md',
  '# Context Engineering\n\nManaging LLM context windows.\n');

// Connections
const connA = makeConnection('Fellow A', 'Alice', fellowA_DomainsDir);
const connB = makeConnection('Fellow B', 'Bob',   fellowB_DomainsDir);
const connC = makeConnection('Fellow C', 'Carol', fellowC_DomainsDir);

const connections = { [connA.id]: connA, [connB.id]: connB, [connC.id]: connC };
const patchFn = makePatchFn(connections);

// Mock LLM that produces realistic deltas (returns echo'd default for each path)
const mockLLM = makeMockLLM({}, 'echo');

const pushA = await pushDomain(connA, 'work-ai', {
  llmFn: mockLLM,
  domainsDir: fellowA_DomainsDir,
  patchFn,
});
const pushB = await pushDomain(connB, 'work-ai', {
  llmFn: mockLLM,
  domainsDir: fellowB_DomainsDir,
  patchFn,
});
const pushC = await pushDomain(connC, 'work-ai', {
  llmFn: mockLLM,
  domainsDir: fellowC_DomainsDir,
  patchFn,
});

assert(pushA.ok, 'Fellow A push succeeded');
assertEq(pushA.pushed, 2, 'Fellow A pushed 2 pages');
assert(pushA.submission_id, 'Fellow A got a submission_id');

assert(pushB.ok, 'Fellow B push succeeded');
assertEq(pushB.pushed, 1, 'Fellow B pushed 1 page');

assert(pushC.ok, 'Fellow C push succeeded');
assertEq(pushC.pushed, 1, 'Fellow C pushed 1 page');

// Verify the contributions all landed in shared storage
const adapter = new LocalFolderStorageAdapter({ storage_root: storageRoot });
const allContribs = await adapter.listContributionsSince(null);
assertEq(allContribs.length, 3, 'shared storage holds 3 contributions');

const fellowIds = allContribs.map(c => c.fellowId).sort();
assertEq(
  fellowIds,
  [connA.fellow_id, connB.fellow_id, connC.fellow_id].sort(),
  'all three fellow_ids represented'
);

// Verify per-payload contents
const aPayload = allContribs.find(c => c.fellowId === connA.fellow_id).payload;
assertEq(aPayload.deltas.length, 2, 'Fellow A payload contains 2 deltas');
assertEq(aPayload.fellow_display_name, 'Alice', 'Fellow A payload carries display name');
assertEq(aPayload.consent.share_with_brain, true, 'consent flag set');

// Verify cross-domain link filtering happened in deltas (tali-rezun NOT in this domain)
const aAnthropicDelta = aPayload.deltas.find(d => d.path === 'entities/anthropic.md');
assert(
  !aAnthropicDelta.new_links.includes('tali-rezun'),
  'cross-domain link "tali-rezun" filtered out of stored delta'
);

// Verify connection state was updated
assert(connections[connA.id].last_push_at, 'Fellow A last_push_at updated');
assertEq(connections[connA.id].pending_retry, {}, 'Fellow A pending_retry empty after success');
assertEq(connections[connA.id].permanent_skip, [], 'Fellow A permanent_skip empty');

// ─── 7. Security gate — refuse domain not in local_domains ────────────────

section('pushDomain — security gate');

{
  const result = await pushDomain(connA, 'evil-domain', {
    llmFn: mockLLM,
    domainsDir: fellowA_DomainsDir,
    patchFn,
  });
  assert(!result.ok, 'push refused for domain not in local_domains');
  assert(/not in this connection's contribution list/.test(result.error || ''),
    'error message names the problem');
}

{
  const disabledConn = { ...connA, enabled: false };
  const result = await pushDomain(disabledConn, 'work-ai', {
    llmFn: mockLLM,
    domainsDir: fellowA_DomainsDir,
    patchFn,
  });
  assert(!result.ok, 'push refused when enabled=false');
  assert(/disabled/.test(result.error || ''), 'error mentions disabled');
}

// ─── 8. Idempotency: second push with no changes ──────────────────────────

section('pushDomain — idempotency (no changes since last push)');

{
  const secondPush = await pushDomain(connections[connA.id], 'work-ai', {
    llmFn: mockLLM,
    domainsDir: fellowA_DomainsDir,
    patchFn,
  });
  assert(secondPush.ok, 'second push (no changes) returns ok');
  assertEq(secondPush.pushed, 0, 'second push pushes 0 pages');
  assertEq(secondPush.submission_id, null, 'no submission_id when nothing was sent');
}

// Storage still has just 3 contributions (no new payload created)
{
  const stillThree = await adapter.listContributionsSince(null);
  assertEq(stillThree.length, 3, 'shared storage still has 3 contributions after idempotent re-push');
}

// ─── 9. LLM failure tracking: pending_retry counter ───────────────────────

section('pushDomain — pending_retry tracking on LLM failure');

// Fellow D — fresh workspace where every page's LLM call throws
const fellowD_DomainsDir = makeFellowWorkspace('fellow-d');
const fellowD_WikiDir = makeDomain(fellowD_DomainsDir, 'work-ai');
writePage(fellowD_WikiDir, 'entities/x.md', '# X\n');
writePage(fellowD_WikiDir, 'entities/y.md', '# Y\n');

const connD = makeConnection('Fellow D', 'Dana', fellowD_DomainsDir);
connections[connD.id] = connD;

const throwAllLLM = makeMockLLM({
  'entities/x.md': 'throw',
  'entities/y.md': 'throw',
});

const dPush1 = await pushDomain(connD, 'work-ai', {
  llmFn: throwAllLLM,
  domainsDir: fellowD_DomainsDir,
  patchFn,
});

assert(dPush1.ok, 'partial push still returns ok=true (Decision 3)');
assertEq(dPush1.pushed, 0, 'no deltas pushed');
assertEq(dPush1.skipped, 2, 'both pages skipped');
assertEq(
  Object.keys(dPush1.pending_retry).sort(),
  ['entities/x.md', 'entities/y.md'],
  'both failed pages in pending_retry'
);
assertEq(dPush1.pending_retry['entities/x.md'], 1, 'attempt count = 1 after first failure');

// Run two more times to hit MAX_RETRY_ATTEMPTS (3)
await pushDomain(connections[connD.id], 'work-ai', { llmFn: throwAllLLM, domainsDir: fellowD_DomainsDir, patchFn });
const dPush3 = await pushDomain(connections[connD.id], 'work-ai', { llmFn: throwAllLLM, domainsDir: fellowD_DomainsDir, patchFn });

// On the 3rd failure (newCount === MAX_RETRY_ATTEMPTS), pages move to permanent_skip.
assertEq(
  dPush3.permanent_skip.sort(),
  ['entities/x.md', 'entities/y.md'],
  'after 3 failures, pages move to permanent_skip'
);
assertEq(dPush3.pending_retry, {}, 'pending_retry cleared when pages go to permanent_skip');

// Next push should NOT process these pages (they're in permanent_skip and excluded from changedPages)
const dPush4 = await pushDomain(connections[connD.id], 'work-ai', { llmFn: throwAllLLM, domainsDir: fellowD_DomainsDir, patchFn });
assertEq(dPush4.pushed, 0, 'permanent_skip pages not re-processed automatically');
assertEq(dPush4.skipped, 0, 'permanent_skip pages don\'t count as skipped (they\'re ignored entirely)');

// ─── 10. findChangedPages — mtime delta + pending_retry union ─────────────

section('findChangedPages — mtime + pending_retry behaviour');

const fellowE_WikiDir = makeDomain(makeFellowWorkspace('fellow-e'), 'work-ai');
writePage(fellowE_WikiDir, 'entities/old.md', '# Old\n', new Date('2026-01-01T00:00:00Z'));
writePage(fellowE_WikiDir, 'entities/new.md', '# New\n', new Date('2026-05-01T00:00:00Z'));

const allChanged = await findChangedPages(fellowE_WikiDir, null, {});
assertEq(
  allChanged.sort(),
  ['entities/new.md', 'entities/old.md'],
  'findChangedPages(null) returns all pages'
);

const recentOnly = await findChangedPages(
  fellowE_WikiDir, new Date('2026-03-01T00:00:00Z'), {}
);
assertEq(recentOnly, ['entities/new.md'], 'findChangedPages with date filters out older pages');

const withRetry = await findChangedPages(
  fellowE_WikiDir,
  new Date('2026-06-01T00:00:00Z'),  // future → no mtime hits
  { 'entities/old.md': 1 }            // but old.md is in pending_retry
);
assertEq(withRetry, ['entities/old.md'], 'pending_retry pages included even when mtime says no');

const retryGone = await findChangedPages(
  fellowE_WikiDir,
  new Date('2026-06-01T00:00:00Z'),
  { 'entities/deleted.md': 1 }       // page in pending_retry but file is gone
);
assertEq(retryGone, [], 'pending_retry entry for missing file is dropped silently');

// ─── 11. getAllPagePaths — domain page enumeration ────────────────────────

section('getAllPagePaths — domain page enumeration');

const paths = await getAllPagePaths(fellowA_WikiDir);
assertEq(paths.sort(), ['concepts/rag.md', 'entities/anthropic.md'].sort(),
  'getAllPagePaths returns all .md files in the three canonical folders');

const emptyPaths = await getAllPagePaths(path.join(workspaceRoot, 'nonexistent'));
assertEq(emptyPaths, [], 'getAllPagePaths on missing dir returns []');

// ─── 12. New page added after last push triggers a delta ──────────────────

section('pushDomain — subsequent push detects new file');

// Fellow A already pushed everything in step 6. Now add a new page.
writePage(fellowA_WikiDir, 'entities/openai.md', '# OpenAI\n\nResearch lab.\n');

const aPush2 = await pushDomain(connections[connA.id], 'work-ai', {
  llmFn: mockLLM,
  domainsDir: fellowA_DomainsDir,
  patchFn,
});

assert(aPush2.ok, 'Fellow A second push succeeded');
assertEq(aPush2.pushed, 1, 'Fellow A second push pushed exactly 1 page (the new one)');

const fourContribs = await adapter.listContributionsSince(null);
assertEq(fourContribs.length, 4, 'shared storage now has 4 contributions');

// ── 11. loadPriorContent against a REAL git repo ─────────────────────────
//
// This section builds a throwaway git repo laid out exactly the way Personal
// Sync lays out the real one (git dir = <userData>/.knowledge-git, work-tree =
// the domains folder, so tracked paths are `<domain>/wiki/...` with NO
// `domains/` prefix) and drives the real function against it.
//
// It asserts BEHAVIOUR — returned content — never source text. Three of these
// assertions fail if the historical `domains/` prefix or git's default
// glob-y pathspec parsing is reintroduced.
//
// It never touches the user's real .knowledge-git: __setUserDataDirOverride
// redirects getSyncGitDir() at a tempdir for the duration of this section.

section('11. loadPriorContent — real git repo (prior-version diff)');

const gitRoot     = path.join(workspaceRoot, 'gitfellow');       // stands in for userDataDir
const gitDir      = path.join(gitRoot, '.knowledge-git');
const gitDomains  = path.join(gitRoot, 'domains');               // the work-tree
const gitWikiDir  = path.join(gitDomains, 'notes', 'wiki', 'entities');
// A DECOY domain literally named "domains". If someone reintroduces the
// `domains/<domain>/wiki/...` pathspec, the lookup resolves HERE and the
// content assertions below fail loudly with the wrong body — rather than
// quietly returning null, which is how the original bug hid for four releases.
const decoyDir    = path.join(gitDomains, 'domains', 'notes', 'wiki', 'entities');

mkdirSync(gitWikiDir, { recursive: true });
mkdirSync(decoyDir,   { recursive: true });

// `-c` overrides rather than GIT_CONFIG_GLOBAL so this works on any git that
// ships with macOS or an Actions runner, and so a developer's global
// commit.gpgsign / core.hooksPath can't break the fixture.
const GIT_ISOLATION = [
  '-c', 'init.defaultBranch=main',
  '-c', 'commit.gpgsign=false',
  '-c', 'core.hooksPath=/dev/null',
];
const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid',
};

let gitAvailable = true;
function g(args, extraEnv = {}) {
  return execFileSync(
    'git',
    [...GIT_ISOLATION, `--git-dir=${gitDir}`, `--work-tree=${gitDomains}`, ...args],
    {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],   // swallow git's hints/warnings
      env: { ...process.env, ...GIT_IDENTITY, ...extraEnv },
    }
  );
}
function commitAt(iso, message) {
  g(['--literal-pathspecs', 'add', '-A']);
  g(['commit', '-q', '-m', message], { GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso });
}

try {
  // Exactly how sync.js bootstraps the real repo: git dir and work-tree given
  // explicitly, so tracked paths are relative to the DOMAINS folder.
  g(['init', '-q']);
} catch (err) {
  gitAvailable = false;
  fail('git is available to build the loadPriorContent fixture', err);
}

if (gitAvailable) {
  __setUserDataDirOverride(gitRoot);   // points getSyncGitDir() at our tempdir

  const pageRel   = 'entities/openai.md';
  const pageAbs   = path.join(gitWikiDir, 'openai.md');
  const decoyAbs  = path.join(decoyDir, 'openai.md');
  // Glob-magic probe: an ordinary page whose NAME contains a character class,
  // plus a sibling that the class would match.
  const bracketRel = 'entities/n[ab].md';
  const bracketAbs = path.join(gitWikiDir, 'n[ab].md');
  const siblingAbs = path.join(gitWikiDir, 'na.md');
  // A genuinely 0-BYTE page. Obsidian writes one of these every time someone
  // makes a new note, and the documented vault root IS domains/<d>/wiki/.
  const emptyRel = 'entities/blank.md';
  const emptyAbs = path.join(gitWikiDir, 'blank.md');
  // Whitespace-only — truthy, so both delta.js consumers already agree on it.
  // Present to prove the guard collapses ONLY falsy content.
  const wsRel  = 'entities/whitespace.md';
  const wsAbs  = path.join(gitWikiDir, 'whitespace.md');

  const T1 = '2020-01-01T00:00:00Z';
  const T2 = '2020-01-03T00:00:00Z';
  const T3 = '2020-01-05T00:00:00Z';

  // Commit 1 — original bodies.
  writeFileSync(pageAbs,    '# OpenAI\n\nVERSION-ONE body.\n');
  writeFileSync(decoyAbs,   '# DECOY — the domains/ prefix is back\n');
  writeFileSync(bracketAbs, 'BRACKET-ONE\n');
  writeFileSync(siblingAbs, 'SIBLING-ONE\n');
  writeFileSync(emptyAbs, '');          // committed EMPTY, body written later
  writeFileSync(wsAbs, '\n\n  \n');
  commitAt(T1, 'c1');

  // Commit 2 — touches ONLY the sibling. If the pathspec is glob-parsed,
  // `n[ab].md` matches `na.md`, so the sha lookup lands on THIS commit and the
  // bracket page is read at the wrong point in history.
  writeFileSync(siblingAbs, 'SIBLING-TWO\n');
  commitAt(T2, 'c2 — sibling only');

  // Commit 3 — the real pages change.
  writeFileSync(pageAbs,    '# OpenAI\n\nVERSION-TWO body.\n');
  writeFileSync(bracketAbs, 'BRACKET-TWO\n');
  commitAt(T3, 'c3');

  const domainsDirArg = gitDomains;

  // (a) A watermark BETWEEN c1 and c3 must return the c1 body — the version as
  //     it stood at the watermark, not HEAD.
  const priorMid = await loadPriorContent(domainsDirArg, 'notes', pageRel, new Date('2020-01-02T00:00:00Z'));
  assert(typeof priorMid === 'string' && priorMid.includes('VERSION-ONE'),
    'loadPriorContent returns the content as of the watermark (VERSION-ONE)',
    `got: ${JSON.stringify(priorMid)}`);
  assert(typeof priorMid === 'string' && !priorMid.includes('DECOY'),
    'loadPriorContent does NOT resolve through a literal domains/ directory (prefix regression guard)',
    `got: ${JSON.stringify(priorMid)}`);

  // (b) A watermark after c3 must return the c3 body.
  const priorLate = await loadPriorContent(domainsDirArg, 'notes', pageRel, new Date('2020-02-01T00:00:00Z'));
  assert(typeof priorLate === 'string' && priorLate.includes('VERSION-TWO'),
    'loadPriorContent advances with the watermark (VERSION-TWO after the later commit)',
    `got: ${JSON.stringify(priorLate)}`);

  // (c) A page whose FILENAME contains glob characters resolves to its own
  //     history. NOTE, honestly: this passes with or without
  //     --literal-pathspecs on git 2.48.1 — a globbed `git log -1` can only
  //     select a commit at or after the one that last touched the real page,
  //     and `git show <sha>:<path>` is snapshot-based, so the content comes
  //     out the same. It is pinned as a property, NOT as the flag's guard.
  //     The assertion that actually fails without the flag is (h).
  const priorBracket = await loadPriorContent(domainsDirArg, 'notes', bracketRel, new Date('2020-02-01T00:00:00Z'));
  assert(priorBracket === 'BRACKET-TWO\n',
    'loadPriorContent resolves a page whose filename contains [] to its own history',
    `got: ${JSON.stringify(priorBracket)}`);

  // (d) A watermark BEFORE the page's first commit → the page did not exist.
  const priorTooEarly = await loadPriorContent(domainsDirArg, 'notes', pageRel, new Date('2019-01-01T00:00:00Z'));
  assertEq(priorTooEarly, null, 'loadPriorContent returns null for a watermark before the page existed');

  // (e) Page that was never tracked at all.
  const priorMissing = await loadPriorContent(domainsDirArg, 'notes', 'entities/never-existed.md', new Date('2020-02-01T00:00:00Z'));
  assertEq(priorMissing, null, 'loadPriorContent returns null for a page that does not exist');

  // (f) Unknown domain.
  const priorBadDomain = await loadPriorContent(domainsDirArg, 'no-such-domain', pageRel, new Date('2020-02-01T00:00:00Z'));
  assertEq(priorBadDomain, null, 'loadPriorContent returns null for an unknown domain');

  // (g) Falsy sinceDate → null without touching git (first push).
  assertEq(await loadPriorContent(domainsDirArg, 'notes', pageRel, null), null,
    'loadPriorContent returns null when sinceDate is null');
  assertEq(await loadPriorContent(domainsDirArg, 'notes', pageRel, undefined), null,
    'loadPriorContent returns null when sinceDate is undefined');

  // (h) A glob-shaped path whose literal file does not exist returns null.
  //
  //     HONEST SCOPE NOTE: this does NOT pin --literal-pathspecs. Without the
  //     flag `git log` matches the sibling .md files, `git show <sha>:*.md`
  //     exits 0 with empty stdout, and the function would return `''` — but
  //     the (h2) falsy-content guard now converts that to null anyway, so this
  //     assertion passes either way. I searched for a case where literal vs
  //     glob parsing still changes the RETURN VALUE and could not construct
  //     one: a globbed `git log -1` only ever selects a commit at or after the
  //     one that last touched the real page, and `git show <sha>:<path>` is
  //     snapshot-based, so the content is identical (verified on git 2.48.1,
  //     including the delete-and-recreate shape where the two shas genuinely
  //     differ). The flag is defence-in-depth on the sha lookup and has no
  //     behavioural test. Do not relabel this as its guard.
  const priorGlob = await loadPriorContent(domainsDirArg, 'notes', 'entities/*.md', new Date('2020-02-01T00:00:00Z'));
  assertEq(priorGlob, null,
    'loadPriorContent returns null (never an empty string) for a glob-shaped path');

  // (h2) THE 0-BYTE GUARD — a DIFFERENT path to the same bad return value.
  //      There is no glob here, so --literal-pathspecs never engages: `git log`
  //      finds a real sha and `git show` legitimately exits 0 with empty stdout
  //      for an empty blob. Only `if (!content) return null` closes this.
  //
  //      Asserted with `=== null` on purpose. `''` is falsy, so a
  //      truthiness-based assertion would pass against the bug — and `''` vs
  //      `null` IS the entire bug, because delta.js's two consumers use an
  //      identity check and a truthiness check respectively.
  const priorEmpty = await loadPriorContent(domainsDirArg, 'notes', emptyRel, new Date('2020-02-01T00:00:00Z'));
  assert(priorEmpty === null,
    'loadPriorContent returns strictly null (not "") for a 0-byte prior version — falsy-content guard',
    `got ${JSON.stringify(priorEmpty)} (typeof ${typeof priorEmpty})`);

  // (h3) The 0-byte page IS reachable — prove the guard is doing the work and
  //      the null did not come from an earlier short-circuit (missing sha,
  //      missing repo). If git could not resolve this page at all, (h2) would
  //      pass for the wrong reason and measure nothing.
  const emptySha = g(['--literal-pathspecs', 'log', '--format=%H', '-1', '--',
                      `notes/wiki/${emptyRel}`]).trim();
  assert(emptySha.length === 40,
    'the 0-byte page really is tracked and resolvable — (h2) is not passing via an early return',
    `sha was ${JSON.stringify(emptySha)}`);

  // (h4) THE CONTRACT THAT ACTUALLY MATTERS. Checking the return value alone
  //      would not catch this bug's harm. Feed each possible prior straight
  //      into the REAL buildDeltaPrompt and require that `isNew` (delta.js:293,
  //      an identity check) and the block actually rendered (delta.js:192, a
  //      truthiness check) agree. They disagree on exactly one value: ''.
  const coherence = (prior) => {
    const isNew = prior === null || prior === undefined;       // delta.js:293
    const { user } = buildDeltaPrompt('entities/x.md', 'entity', '# Cur\n\nBody.\n', prior, isNew);
    const showsPrior = user.includes('PRIOR VERSION:');
    return { isNew, showsPrior, agree: isNew === !showsPrior };
  };
  assert(coherence(priorEmpty).agree,
    'a 0-byte prior produces an internally consistent delta prompt (isNew matches the block shown)');
  assert(coherence(priorEmpty).isNew === true,
    'a 0-byte prior is framed to the model as a NEW page, so its whole body is contributed');
  assert(coherence('').agree === false,
    "control: '' really would be incoherent — this is the value the guard exists to eliminate");
  assert(coherence(null).agree && coherence('# Old\n').agree && coherence('\n\n  \n').agree,
    'null, a real prior, and a whitespace-only prior are all coherent (whitespace-only is left alone by design)');

  // (h5) Whitespace-only is NOT collapsed — verified against the real function,
  //      not assumed. It is truthy, both consumers agree on it, and it is a
  //      real if thin prior version.
  const priorWs = await loadPriorContent(domainsDirArg, 'notes', wsRel, new Date('2020-02-01T00:00:00Z'));
  assertEq(priorWs, '\n\n  \n',
    'loadPriorContent preserves a whitespace-only prior version (the guard collapses only falsy content)');

  // (i) Never-throws / never-escapes contract on hostile input.
  let hostileBad = null;
  const hostile = [
    ['../../etc', 'passwd'],
    ['notes', '../../../../etc/passwd'],
    [':!notes', pageRel],
    ['notes', 'entities/openai.md\nrm -rf /'],
    ['notes', 'entities/openai.md; echo pwned'],
  ];
  for (const [d, p] of hostile) {
    try {
      const r = await loadPriorContent(domainsDirArg, d, p, new Date('2020-02-01T00:00:00Z'));
      if (r !== null) hostileBad = `${d} | ${p} → ${JSON.stringify(String(r).slice(0, 60))}`;
    } catch (err) {
      hostileBad = `${d} | ${p} threw ${err.message}`;
    }
  }
  assert(hostileBad === null,
    'loadPriorContent never throws and never escapes the repo on hostile domain/pagePath input',
    hostileBad);

  // (j) A non-repo at the git-dir path must degrade to null, not throw.
  __setUserDataDirOverride(path.join(workspaceRoot, 'bogus-userdata'));
  mkdirSync(path.join(workspaceRoot, 'bogus-userdata', '.knowledge-git'), { recursive: true });
  let brokenRepoResult = 'unset';
  try {
    brokenRepoResult = await loadPriorContent(domainsDirArg, 'notes', pageRel, new Date('2020-02-01T00:00:00Z'));
  } catch { brokenRepoResult = 'threw'; }
  assertEq(brokenRepoResult, null, 'loadPriorContent returns null (does not throw) when .knowledge-git is not a repo');

  // (k) No .knowledge-git at all — the common case for users without Personal Sync.
  __setUserDataDirOverride(path.join(workspaceRoot, 'no-sync-userdata'));
  assertEq(await loadPriorContent(domainsDirArg, 'notes', pageRel, new Date('2020-02-01T00:00:00Z')), null,
    'loadPriorContent returns null when Personal Sync was never set up');

  // ── 11b. pushDomain wires prior content through to the delta prompt ──────
  //
  // Behavioural check on the CALL SITE: a page that changed since the last
  // push must be diffed, while a page queued in pending_retry (never
  // successfully contributed) must be treated as new so its whole body is
  // still sent.
  section('11b. pushDomain — prior-content wiring + never-contributed guard');

  __setUserDataDirOverride(gitRoot);

  const seenPrompts = {};
  const spyLLM = async (system, user) => {
    const m = /^PAGE PATH: (.+)$/m.exec(user);
    seenPrompts[m ? m[1] : '?'] = user;
    return JSON.stringify({
      title: 'X', new_facts: ['f'], stable_facts: [], new_links: [],
      removed_links: [], key_entities: [],
    });
  };

  // Make both pages look edited since the watermark.
  const future = new Date(Date.now() + 1000);
  writeFileSync(pageAbs,    '# OpenAI\n\nVERSION-THREE body.\n');
  writeFileSync(bracketAbs, 'BRACKET-THREE\n');
  utimesSync(pageAbs, future, future);
  utimesSync(bracketAbs, future, future);

  const gitStorageRoot = path.join(workspaceRoot, 'git-shared-storage');
  mkdirSync(gitStorageRoot, { recursive: true });
  const gitConn = {
    id: randomUUID(),
    label: 'Git Fellow',
    enabled: true,
    storage_type: 'local',
    local_storage_path: gitStorageRoot,
    shared_domain: 'notes',
    shared_brain_slug: 'git-cohort',
    local_domains: ['notes'],
    fellow_id: randomUUID(),
    fellow_display_name: 'Git Fellow',
    last_push_at: '2020-01-04T00:00:00.000Z',   // between c2 and c3
    pending_retry: { [bracketRel]: 1 },          // never successfully contributed
    permanent_skip: [],
  };

  const gitPush = await pushDomain(gitConn, 'notes', {
    llmFn: spyLLM,
    domainsDir: gitDomains,
    patchFn: () => {},
  });

  assert(gitPush.ok, 'pushDomain succeeded against the git-backed fellow', gitPush.error);

  const openaiPrompt = seenPrompts[pageRel];
  assert(typeof openaiPrompt === 'string' && openaiPrompt.includes('PRIOR VERSION:'),
    'pushDomain builds a PRIOR VERSION / CURRENT VERSION prompt for a previously-contributed page');
  assert(typeof openaiPrompt === 'string' && openaiPrompt.includes('VERSION-ONE'),
    'the prior version handed to the LLM is the watermark-era body, not HEAD');
  assert(typeof openaiPrompt === 'string' && openaiPrompt.includes('VERSION-THREE'),
    'the current version handed to the LLM is the on-disk body');
  assert(typeof openaiPrompt === 'string' && openaiPrompt.includes('IS NEW PAGE: false'),
    'a previously-contributed page is no longer flagged as new');

  const bracketPrompt = seenPrompts[bracketRel];
  assert(typeof bracketPrompt === 'string' && bracketPrompt.includes('CONTENT (new page):'),
    'a pending_retry page is treated as NEW — its full body is still contributed');
  assert(typeof bracketPrompt === 'string' && !bracketPrompt.includes('PRIOR VERSION:'),
    'a pending_retry page is NOT diffed (synthesis reads new_facts only, so a diff would drop its body)');

  // ── 11c. A page whose readFile FAILED must not be diffed next push ───────
  //
  // This is the third door into "never contributed", and the one the guard
  // originally missed. Step 6 advances last_push_at unconditionally, so a page
  // skipped on a read error and left out of both tracking sets looks
  // previously-contributed on the next push and gets DIFFED — its whole body
  // then arrives as PRIOR VERSION, routes to stable_facts, and is dropped,
  // because nothing reads stable_facts.
  //
  // Realistic trigger: domains/ on iCloud Drive / Dropbox / a network mount
  // with the page evicted to online-only (EIO/ENOENT), or an Obsidian rename
  // landing between readdir and readFile.
  section('11c. push — read failure queues, warns, and is treated as new next push');

  const rfRel = 'entities/unreadable.md';
  const rfAbs = path.join(gitWikiDir, 'unreadable.md');
  writeFileSync(rfAbs, '# Unreadable\n\nALPHA fact.\n');
  commitAt('2020-01-06T00:00:00Z', 'c4 — page that will fail to read');

  // Make it unreadable, then run a push whose watermark predates the content.
  chmodSync(rfAbs, 0o000);
  let readBlocked = true;
  try { await (await import('fs/promises')).readFile(rfAbs, 'utf-8'); readBlocked = false; }
  catch { /* expected — chmod 000 took effect */ }

  if (!readBlocked) {
    console.log('  (skipped — this filesystem/user ignores chmod 000, cannot simulate a read failure)');
  } else {
    const patched = {};
    const rfConn = {
      ...gitConn,
      id: randomUUID(),
      last_push_at: '2020-01-05T12:00:00Z',
      pending_retry: {},
      permanent_skip: [],
    };
    const push1Prompts = {};
    const spy1 = async (system, user) => {
      push1Prompts[/^PAGE PATH: (.+)$/m.exec(user)[1]] = user;
      return JSON.stringify({ title: 'X', new_facts: ['f'], stable_facts: [], new_links: [], removed_links: [], key_entities: [] });
    };
    const rfWarnings = [];
    const push1 = await pushDomain(rfConn, 'notes', {
      llmFn: spy1, domainsDir: gitDomains,
      patchFn: (id, patch) => Object.assign(patched, patch),
      onProgress: (stage, msg) => { if (stage === 'warn') rfWarnings.push(msg); },
    });

    assert(push1.ok, 'push succeeds overall even though one page could not be read');
    assert(!(rfRel in push1Prompts), 'the unreadable page never reached the LLM on push 1');

    // (1) QUEUED — the mechanism.
    assert(Object.prototype.hasOwnProperty.call(patched.pending_retry || {}, rfRel),
      'a page whose readFile failed is QUEUED into pending_retry (not silently dropped)',
      `pending_retry was ${JSON.stringify(patched.pending_retry)}`);
    assertEq((patched.pending_retry || {})[rfRel], 0,
      'a read failure does NOT advance the permanent-skip strike counter');
    assert(!(patched.permanent_skip || []).includes(rfRel),
      'a read failure never marks a page permanent_skip');

    // (2) WARNED — console.error is not a user surface.
    assert(rfWarnings.some(m => m.includes(rfRel)),
      'the skipped page is surfaced to the user via onProgress("warn"), not just console.error',
      `warnings seen: ${JSON.stringify(rfWarnings)}`);

    // (3) THE HARM — the next push must frame it as NEW, not diff it.
    chmodSync(rfAbs, 0o644);
    const push2Prompts = {};
    const spy2 = async (system, user) => {
      push2Prompts[/^PAGE PATH: (.+)$/m.exec(user)[1]] = user;
      return JSON.stringify({ title: 'X', new_facts: ['f'], stable_facts: [], new_links: [], removed_links: [], key_entities: [] });
    };
    const rfConn2 = { ...rfConn, last_push_at: patched.last_push_at, pending_retry: patched.pending_retry, permanent_skip: patched.permanent_skip };
    await pushDomain(rfConn2, 'notes', { llmFn: spy2, domainsDir: gitDomains, patchFn: () => {} });

    const p2 = push2Prompts[rfRel];
    assert(typeof p2 === 'string', 'the previously-unreadable page IS reprocessed on the next push');
    assert(typeof p2 === 'string' && p2.includes('CONTENT (new page):'),
      'a page that failed to read gets NEW-page framing on the next push, so its whole body is contributed');
    assert(typeof p2 === 'string' && !p2.includes('PRIOR VERSION:'),
      'a page that failed to read is NOT diffed on the next push (its body would route to the unread stable_facts)');
    assert(typeof p2 === 'string' && p2.includes('ALPHA fact.'),
      'the body that was never contributed appears in the CURRENT content, not stranded as PRIOR');
  }

  // ── 11d. TOTAL COVERAGE — the invariant, not the individual door ─────────
  //
  // The bug above was not a missing branch, it was an INCOMPLETE ENUMERATION.
  // Testing one more door would leave the next one open. This pins the actual
  // invariant instead: every page in changedPages must end up accounted for in
  // deltas ∪ pending_retry ∪ permanent_skip. Any future exit path that skips a
  // page without queueing it fails here regardless of which branch it is.
  section('11d. push — every changed page is accounted for (total-coverage invariant)');

  const covDir = path.join(gitDomains, 'coverage', 'wiki', 'entities');
  mkdirSync(covDir, { recursive: true });
  writeFileSync(path.join(covDir, 'good.md'),      '# Good\n\nfine\n');
  writeFileSync(path.join(covDir, 'llmfail.md'),   '# LlmFail\n\nbad\n');
  writeFileSync(path.join(covDir, 'transient.md'), '# Transient\n\nbad\n');
  const covUnreadable = path.join(covDir, 'noread.md');
  writeFileSync(covUnreadable, '# NoRead\n\nbad\n');
  chmodSync(covUnreadable, 0o000);

  const mixedLLM = async (system, user) => {
    const p = /^PAGE PATH: (.+)$/m.exec(user)[1];
    if (p.includes('llmfail'))   return 'not json at all';
    if (p.includes('transient')) throw new Error('503 Service Unavailable — temporarily overloaded');
    return JSON.stringify({ title: 'X', new_facts: ['f'], stable_facts: [], new_links: [], removed_links: [], key_entities: [] });
  };

  const covPatched = {};
  const covConn = {
    ...gitConn, id: randomUUID(), local_domains: ['coverage'],
    last_push_at: null, pending_retry: {}, permanent_skip: [],
  };
  const covPush = await pushDomain(covConn, 'coverage', {
    llmFn: mixedLLM, domainsDir: gitDomains,
    patchFn: (id, patch) => Object.assign(covPatched, patch),
  });

  const covChanged = await getAllPagePaths(path.join(gitDomains, 'coverage', 'wiki'));

  // Ground truth for "contributed" is the stored contribution itself, not the
  // returned count — a count cannot tell you WHICH page went missing.
  const covAdapter = new LocalFolderStorageAdapter({ storage_root: gitStorageRoot });
  const covContribs = await covAdapter.listContributionsSince(null);
  // Only THIS push's submission — the shared storage root also holds §11b's.
  const contributed = new Set(
    covContribs
      .filter(c => c.submissionId === covPush.submission_id)
      .flatMap(c => (c.payload.deltas || []).map(d => d.path))
  );
  const queued = new Set([
    ...Object.keys(covPatched.pending_retry || {}),
    ...(covPatched.permanent_skip || []),
  ]);

  const untracked = covChanged.filter(p => !contributed.has(p) && !queued.has(p));
  assertEq(untracked, [],
    'TOTAL COVERAGE: no changed page is left untracked — every one is contributed, queued, or skipped');
  assertEq(new Set([...contributed, ...queued]).size, covChanged.length,
    'contributed ∪ queued exactly covers the changed-page set (no page counted twice, none missing)');
  assert(contributed.size >= 1, 'the healthy page really was contributed');
  assert(queued.size === 3,
    'all three failure doors (LLM-parse, transient-LLM, read-failure) landed in the tracking sets',
    `queued=${JSON.stringify([...queued])}`);

  chmodSync(covUnreadable, 0o644);   // so rmSync can clean up
}

// ── Cleanup ──────────────────────────────────────────────────────────────

console.log('\nCleaning up...');
__setUserDataDirOverride(null);
rmSync(workspaceRoot, { recursive: true, force: true });
console.log(`Removed ${workspaceRoot}`);

// ── Summary ──────────────────────────────────────────────────────────────

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

console.log('\nAll Phase 2B push tests green. Ready for Phase 2C (pull orchestration).');
process.exit(0);
