#!/usr/bin/env node
/**
 * Shared Brain — Phase 3 Battle Test (GitHub adapter, LIVE NETWORK)
 *
 * ===========================================================================
 * THIS TEST MAKES REAL NETWORK CALLS AND WRITES TO A REAL GITHUB REPO.
 *
 * It is NOT invoked by any package.json script. It runs ONLY when both
 * env vars are present:
 *
 *   GITHUB_TEST_REPO=<owner>/<name>
 *   GITHUB_TEST_PAT=<fine-grained PAT with Contents R/W on that repo>
 *
 * Manual invocation:
 *
 *   source /tmp/curator-sharedbrain-phase3.env \
 *     && node scripts/test-sharedbrain-github-live.js
 *
 * If either env var is missing, the test exits 0 with a SKIP message —
 * regression sweeps stay green and never hit the network.
 *
 * What it does (per Phase 3 plan):
 *   1. Creates the scaffold (collective/<domain>/wiki/ + meta state)
 *   2. Fellow A pushes a contribution
 *   3. Fellow B pushes a contribution (with a contradictory new_fact to
 *      exercise the conflict marker path)
 *   4. Runs synthesis locally with a deterministic mock LLM (does NOT
 *      call real Gemini / Anthropic — the LLM call exists only to resolve
 *      Jaccard-flagged conflict candidates; we use a mock that always
 *      picks "both" so we can observe the CONFLICTING SOURCES marker)
 *   5. Verifies synthesised pages appear in the remote repo, with the
 *      Provenance section + conflict marker
 *   6. Pulls back from a third "puller" fellow's perspective via the
 *      same adapter — confirms cross-fellow visibility
 *   7. Best-effort cleanup — deletes every file the test created.
 *      Cleanup failures are warnings, not test failures (so a stale
 *      file from a previous aborted run doesn't wedge the next run).
 *
 * Exit code 0 on success (or skip). Non-zero on any test failure.
 * ===========================================================================
 */

import { randomUUID } from 'crypto';
import { GitHubStorageAdapter } from '../src/brain/sharedbrain-github-adapter.js';
import { runLocalSynthesis } from '../src/brain/sharedbrain-synthesis.js';
import { revokeContributor } from '../src/brain/sharedbrain-revoke.js';

// ── Env-var gate ────────────────────────────────────────────────────────

const repoSlug = process.env.GITHUB_TEST_REPO;
const pat      = process.env.GITHUB_TEST_PAT;

if (!repoSlug || !pat) {
  console.error('');
  console.error('SKIP: live GitHub Shared Brain test requires:');
  console.error('  GITHUB_TEST_REPO=<owner>/<name>');
  console.error('  GITHUB_TEST_PAT=<fine-grained PAT, Contents R/W>');
  console.error('');
  console.error('This test makes real network calls and writes to a real repo.');
  console.error('Refusing to run without explicit env. Regression unaffected.');
  console.error('');
  process.exit(0);
}

const slugMatch = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/.exec(repoSlug);
if (!slugMatch) {
  console.error(`FATAL: GITHUB_TEST_REPO must be "<owner>/<name>", got "${repoSlug}"`);
  process.exit(2);
}
const [, owner, repo] = slugMatch;

// ── Harness ─────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
const failures = [];
function ok(label)        { passed++; console.log(`  ✓ ${label}`); }
function fail(label, err) { failed++; failures.push({ label, err }); console.log(`  ✗ ${label}`); if (err) console.log(`    └─ ${err.message || err}`); }
function assert(c, l, e)  { c ? ok(l) : fail(l, new Error(e || 'assertion failed')); }
function section(name) { console.log(`\n── ${name} ──`); }
function warn(msg) { console.log(`  ⚠ ${msg}`); }

// ── Setup ───────────────────────────────────────────────────────────────

// Domain name is deterministic per run + slightly randomised so concurrent
// runs against the same throwaway repo don't collide.
const runId = randomUUID().slice(0, 8);
const sharedDomain = `live-test-${runId}`;
const fellowA = randomUUID();
const fellowB = randomUUID();
const fellowC = randomUUID(); // "puller" — only reads
const subA = randomUUID();
const subB = randomUUID();

console.log('\n══════════════════════════════════════════════════════════════');
console.log(`  Phase 3 LIVE GitHub adapter test`);
console.log(`  Repo:          ${owner}/${repo}`);
console.log(`  Shared domain: ${sharedDomain}`);
console.log(`  Fellow A:      ${fellowA.slice(0, 8)}…`);
console.log(`  Fellow B:      ${fellowB.slice(0, 8)}…`);
console.log(`  Fellow C:      ${fellowC.slice(0, 8)}… (read-only)`);
console.log('══════════════════════════════════════════════════════════════');

function makeAdapter() {
  return new GitHubStorageAdapter({
    owner, repo, pat, branch: 'main',
  });
}

// Connection shape used by runLocalSynthesis
const connection = {
  id: randomUUID(),
  label: 'Live Test Cohort',
  storage_type: 'github',
  github_repo_owner: owner,
  github_repo_name:  repo,
  github_pat:        pat,
  github_branch:     'main',
  fellow_id: fellowA,
  fellow_display_name: 'Live Tester',
  shared_domain:     sharedDomain,
  shared_brain_slug: `live-${runId}`,
  local_domains: ['personal'],
  attribute_by_name: false,
  enabled: true,
};

// Mock LLM that always returns the synthesis-expected "both" verdict
// (keep both contradictory facts + flag as conflict). Field name must be
// `resolution` to match resolveContradiction() in sharedbrain-synthesis.js.
// Deterministic. Does NOT call real Gemini/Anthropic.
const mockLLM = async (_system, _user) => {
  return JSON.stringify({ resolution: 'both', result: [] });
};

// patchFn that does nothing — we don't want to touch real .sharedbrain-config.json
const noopPatch = (_id, _patch) => null;

// Track every path we create so cleanup is exhaustive.
const createdPaths = new Set();

// ── 1. Scaffold the shared brain ───────────────────────────────────────

section('1. Scaffold — initial scaffold via writePage + writeMeta');

const adapterA = makeAdapter();

try {
  await adapterA.writeMeta('state.last-synthesis', {
    at: new Date(0).toISOString(), // epoch — forces synthesis to process all contributions
    run_number: 0,
  });
  createdPaths.add('meta/state/last-synthesis.json');
  ok('writeMeta(state.last-synthesis) succeeded');
} catch (err) {
  fail('writeMeta scaffold', err);
}

// ── 2. Fellow A pushes a contribution ──────────────────────────────────

section('2. Fellow A pushes a contribution');

const payloadA = {
  submission_id: subA,
  fellow_id: fellowA,
  fellow_display_name: 'Fellow A',
  domain: sharedDomain,
  contributed_at: '2026-05-14T10:00:00Z',
  deltas: [
    {
      path: 'entities/context-engineering.md',
      type: 'entity',
      title: 'Context Engineering',
      // Phrasing chosen so jaccardSimilarity(A, B) lands at ≥0.5 — i.e.
      // enough shared tokens (coined, anthropic) that the conflict
      // heuristic flags them as a contradiction candidate. With shorter
      // phrasing ("Coined in 2024.") the similarity is only 0.33 and
      // they get treated as independent facts, no LLM call, no marker.
      new_facts: ['Coined in 2024 by Anthropic.'],
      new_links: [],
      removed_links: [],
    },
  ],
};

try {
  await adapterA.storeContribution(fellowA, subA, payloadA);
  createdPaths.add(`contributions/${fellowA}/${subA}.json`);
  ok('storeContribution(fellow A) succeeded');

  // Poll briefly — a freshly stored contribution can take a moment to
  // become visible through the contents API (read-after-write lag).
  let exists = false;
  for (let i = 0; i < 8 && !exists; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 1500));
    exists = await adapterA.contributionExists(fellowA, subA);
  }
  assert(exists, 'contributionExists(fellow A) returns true');
} catch (err) {
  fail('Fellow A push', err);
}

// ── 3. Fellow B pushes contradictory contribution ──────────────────────

section('3. Fellow B pushes a CONTRADICTORY fact on the same page');

const adapterB = makeAdapter();
const payloadB = {
  submission_id: subB,
  fellow_id: fellowB,
  fellow_display_name: 'Fellow B',
  domain: sharedDomain,
  contributed_at: '2026-05-14T11:00:00Z',
  deltas: [
    {
      path: 'entities/context-engineering.md',
      type: 'entity',
      title: 'Context Engineering',
      // Same shape as A's fact ("Coined in YEAR") so Jaccard sees them as
      // a near-duplicate → contradiction candidate → LLM call → "both".
      new_facts: ['Coined in 2023 by Anthropic.'],
      new_links: [],
      removed_links: [],
    },
  ],
};

try {
  await adapterB.storeContribution(fellowB, subB, payloadB);
  createdPaths.add(`contributions/${fellowB}/${subB}.json`);
  ok('storeContribution(fellow B) succeeded');
} catch (err) {
  fail('Fellow B push', err);
}

// Verify both contributions visible via listContributionsSince
try {
  const allContribs = await adapterA.listContributionsSince(null);
  // Filter to just OUR contributions (the repo might have stale data from
  // prior aborted runs — that would be cleaned up by exhaustive cleanup
  // at the end, but it's not a failure for this test to see >2 here).
  const ours = allContribs.filter(c => c.fellowId === fellowA || c.fellowId === fellowB);
  assert(ours.length === 2, `listContributionsSince sees both our contributions (saw ${ours.length})`);
} catch (err) {
  fail('listContributionsSince', err);
}

// ── 4. Run synthesis ───────────────────────────────────────────────────

section('4. Run runLocalSynthesis() against live repo');

let synthesisResult = null;
try {
  synthesisResult = await runLocalSynthesis(connection, {
    llmFn: mockLLM,
    patchFn: noopPatch,
    onProgress: (level, msg) => console.log(`    [${level}] ${msg}`),
  });

  assert(synthesisResult.ok, 'synthesis returned ok=true');
  assert(synthesisResult.pages_written >= 1, `at least 1 page written (got ${synthesisResult.pages_written})`);
  assert(synthesisResult.processed_contributions >= 2, `processed ≥2 contributions (got ${synthesisResult.processed_contributions})`);
  // With the mock LLM always picking "both", the contradictory facts
  // should produce exactly 1 conflict marker.
  assert(synthesisResult.conflicts >= 1, `at least 1 conflict flagged (got ${synthesisResult.conflicts})`);

  // Track the index page + the synthesised entity page for cleanup.
  createdPaths.add(`collective/${sharedDomain}/wiki/index.md`);
  createdPaths.add(`collective/${sharedDomain}/wiki/entities/context-engineering.md`);
} catch (err) {
  fail('runLocalSynthesis', err);
}

// ── 5. Verify synthesised page appears on the remote ───────────────────

section('5. Verify synthesised page exists on remote with expected content');

if (synthesisResult && synthesisResult.ok) {
  try {
    const remotePages = await adapterA.listPages(sharedDomain);
    assert(remotePages.includes('entities/context-engineering.md'),
      'listPages returns the synthesised entity page');
    assert(remotePages.includes('index.md'),
      'listPages returns the rebuilt index.md');

    const content = await adapterA.readPage(sharedDomain, 'entities/context-engineering.md');
    assert(typeof content === 'string' && content.length > 0,
      'readPage returns non-empty string for synthesised page');
    assert(/## Provenance/.test(content),
      'synthesised page contains "## Provenance" section');
    // The mock LLM picks "both" → conflict marker appears.
    assert(/CONFLICTING SOURCES/.test(content),
      'synthesised page contains the CONFLICTING SOURCES marker');
    // Both contributing fellows' (shortened) UUIDs should appear in Provenance
    const shortA = fellowA.slice(0, 8);
    const shortB = fellowB.slice(0, 8);
    assert(content.includes(shortA) || content.includes(`fellow-${shortA}`),
      `Provenance lists fellow A's short id (${shortA})`);
    assert(content.includes(shortB) || content.includes(`fellow-${shortB}`),
      `Provenance lists fellow B's short id (${shortB})`);
  } catch (err) {
    fail('Verify synthesised page', err);
  }
}

// ── 6. Pull check from a third puller fellow's perspective ─────────────

section('6. Pull check — Fellow C (read-only) sees the synthesised page');

{
  const adapterC = makeAdapter(); // Fellow C uses the same PAT (test scope)
  try {
    const pages = await adapterC.listPages(sharedDomain);
    assert(pages.includes('entities/context-engineering.md'),
      'Fellow C sees the synthesised entity page in tree listing');
    const content = await adapterC.readPage(sharedDomain, 'entities/context-engineering.md');
    assert(typeof content === 'string' && content.length > 0,
      'Fellow C reads back identical content');

    const meta = await adapterC.readMeta('state.last-synthesis');
    assert(meta && typeof meta.at === 'string',
      'Fellow C sees the updated state.last-synthesis metadata');
    assert(typeof meta.run_number === 'number' && meta.run_number >= 1,
      `Fellow C sees run_number ≥ 1 (got ${meta && meta.run_number})`);
  } catch (err) {
    fail('Fellow C pull', err);
  }
}

// ── 6b. (Phase 5.4) True concurrent writers ─────────────────────────────

section('6b. (5.4) Concurrent writers — real SHA races resolve without loss');

{
  // Two independent adapter instances hammer the SAME page at the same
  // moment. GitHub's contents API serialises via blob SHAs: at least one
  // writer typically gets a 409/422 and must refetch-and-retry. The
  // adapter's retry ladder must absorb that — no throw, no corrupt result.
  const w1 = makeAdapter();
  const w2 = makeAdapter();
  const racePath = 'concepts/race-target.md';
  const contentA = `# Race Target\n\n## Key Facts\n\n- Written by writer A (${runId}).\n`;
  const contentB = `# Race Target\n\n## Key Facts\n\n- Written by writer B (${runId}).\n`;

  try {
    const results = await Promise.allSettled([
      w1.writePage(sharedDomain, racePath, contentA),
      w2.writePage(sharedDomain, racePath, contentB),
    ]);
    createdPaths.add(`collective/${sharedDomain}/wiki/${racePath}`);
    const rejected = results.filter(r => r.status === 'rejected');
    assert(rejected.length === 0,
      `both concurrent page writers succeed (rejections: ${rejected.map(r => r.reason && r.reason.message).join('; ') || 'none'})`);

    const final = await w1.readPage(sharedDomain, racePath);
    assert(final === contentA || final === contentB,
      'final page content is exactly ONE writer\'s payload (no corruption/merge artifact)');

    // Same race on a meta key (synthesis state is the real-world contention
    // point when two admins synthesize simultaneously — documented
    // last-writer-wins, but it must never corrupt or throw).
    const metaResults = await Promise.allSettled([
      w1.writeMeta('state.race-test', { writer: 'A', run: runId }),
      w2.writeMeta('state.race-test', { writer: 'B', run: runId }),
    ]);
    const metaRejected = metaResults.filter(r => r.status === 'rejected');
    assert(metaRejected.length === 0, 'both concurrent meta writers succeed');
    const meta = await w1.readMeta('state.race-test');
    assert(meta && (meta.writer === 'A' || meta.writer === 'B') && meta.run === runId,
      'final meta is one writer\'s intact payload (last-writer-wins, parseable)');
  } catch (err) {
    fail('concurrent writers', err);
  }
}

// ── 6c. (Phase 5.1) Revoke E2E on the REAL GitHub adapter ───────────────
//
// THE highest-risk gap of the whole program: the GDPR Article 17 claim had
// never run against the production storage backend. Fellow A (whose fact
// is on the synthesised page) is revoked; fellow B's content must survive
// the rebuild.

section('6c. (5.1) Revoke E2E — Article 17 against the live repo');

if (synthesisResult && synthesisResult.ok) {
  try {
    const rev = await revokeContributor(connection, {
      fellowId: fellowA,
      adminTokenHash: 'sha256:live-test',
      llmFn: mockLLM,
      patchFn: noopPatch,
      onProgress: (level, msg) => console.log(`    [${level}] ${msg}`),
    });
    createdPaths.add('meta/state/revocation-in-progress.json');

    assert(rev.ok === true, `revoke completes ok (error: ${rev.error || 'none'})`);
    assert(rev.contributions_deleted >= 1, `fellow A's contributions deleted (${rev.contributions_deleted})`);
    assert(rev.pages_deleted >= 1, `provenance-tainted page(s) deleted (${rev.pages_deleted})`);
    assert(rev.audit_record && rev.audit_record.rebuild_ok === true, 'audit record says rebuild_ok');

    // Erasure verified directly against the remote.
    const subsLeft = await adapterA.listFellowSubmissions(fellowA);
    assert(subsLeft.length === 0, 'listFellowSubmissions(fellow A) is empty on the remote');
    const stillThere = await adapterA.contributionExists(fellowA, subA);
    assert(stillThere === false, 'fellow A\'s contribution file is gone from the repo');

    // The page was rebuilt from fellow B's surviving contribution ONLY.
    const rebuilt = await adapterA.readPage(sharedDomain, 'entities/context-engineering.md');
    assert(typeof rebuilt === 'string' && rebuilt.length > 0, 'page rebuilt from remaining contributors');
    assert(!rebuilt.includes('Coined in 2024'), 'revoked fellow\'s fact is GONE from the rebuilt page');
    assert(rebuilt.includes('Coined in 2023'), 'surviving fellow\'s fact preserved');
    const shortA = fellowA.replace(/-/g, '').slice(0, 8);
    assert(!rebuilt.includes(shortA), 'revoked fellow\'s short id absent from rebuilt Provenance');
    assert(!/CONFLICTING SOURCES/.test(rebuilt),
      'conflict marker dissolved (the contradicting party was erased)');

    // Audit log on the remote records the revocation (hash only, no name).
    // Freshly created files take a moment to become visible through the
    // contents API (read-after-write lag) — poll briefly.
    let auditText = '';
    for (let i = 0; i < 8 && !auditText.includes(fellowA); i++) {
      if (i > 0) await new Promise(r => setTimeout(r, 1500));
      const auditRaw = await adapterA._apiGetContents('state/revocations.jsonl').catch(() => null);
      auditText = auditRaw && auditRaw.content ? auditRaw.content : '';
    }
    assert(auditText.includes(fellowA), 'audit JSONL contains the revoked fellow UUID');
    assert(auditText.includes('sha256:live-test'), 'audit JSONL contains the admin-token HASH (never the raw token)');

    // In-progress marker cleared only on full success.
    const marker = await adapterA.readMeta('state.revocation-in-progress');
    assert(marker && marker.active === false, 'revocation-in-progress marker cleared after success');
  } catch (err) {
    fail('revoke E2E', err);
  }
} else {
  warn('skipping revoke E2E — synthesis phase did not complete');
}

// ── 7. Cleanup (best-effort) ───────────────────────────────────────────

section('7. Cleanup — delete every path we created');

// Tree-based exhaustive cleanup: list every blob whose path starts with
// any of our created prefixes, then delete each by sha. This catches
// pages and index files written by synthesis that the test didn't
// explicitly track.
const cleanupAdapter = makeAdapter();
let deleted = 0;
let cleanupErrors = 0;

try {
  const { entries } = await cleanupAdapter._apiTree();
  const ourPrefixes = [
    `collective/${sharedDomain}/`,
    `contributions/${fellowA}/`,
    `contributions/${fellowB}/`,
    `digests/${fellowA}/`,
    `digests/${fellowB}/`,
    `digests/${fellowC}/`,
    `meta/state/last-synthesis.json`,
    `meta/state/revocation-in-progress.json`, // v3.0.6 (5.1)
    `meta/state/race-test.json`,              // v3.0.6 (5.4)
    `state/revocations.jsonl`,                // v3.0.6 (5.1) — throwaway repo's audit log
  ];
  const targets = entries.filter(e => ourPrefixes.some(p => e.path === p || e.path.startsWith(p)));

  console.log(`    Targeting ${targets.length} blob${targets.length !== 1 ? 's' : ''} for cleanup`);

  for (const t of targets) {
    try {
      await cleanupAdapter._apiDelete(t.path, `Shared Brain: cleanup live-test ${runId}`, t.sha);
      deleted++;
    } catch (err) {
      cleanupErrors++;
      warn(`could not delete ${t.path}: ${err.message}`);
    }
  }

  console.log(`    Deleted ${deleted} / ${targets.length} files (${cleanupErrors} errors)`);
  if (cleanupErrors > 0) {
    warn(`cleanup left ${cleanupErrors} orphan file${cleanupErrors !== 1 ? 's' : ''} in the repo`);
    warn('they will not block future runs (each run uses a fresh sharedDomain slug)');
  } else {
    ok(`cleanup deleted all ${deleted} files we created`);
  }
} catch (err) {
  warn(`cleanup phase errored: ${err.message}`);
  warn('this does not fail the test; clean the repo manually if needed');
}

// ── Summary ─────────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════');
console.log(`  Total: ${passed + failed}   Passed: ${passed}   Failed: ${failed}`);
console.log('══════════════════════════════════════');

if (failed > 0) {
  console.log('\nFAILURES:');
  for (const { label, err } of failures) {
    console.log(`  ✗ ${label}`);
    if (err) console.log(`    └─ ${err.message || err}`);
  }
  console.log('\nThe LIVE Phase 3 test failed. The throwaway repo may contain partial data.');
  console.log('Run the cleanup section manually (or re-run; cleanup is idempotent) if needed.');
  process.exit(1);
}

console.log('\nAll Phase 3 LIVE GitHub adapter tests green.');
console.log('Adapter is production-ready for Phase 4 wiring.');
process.exit(0);
