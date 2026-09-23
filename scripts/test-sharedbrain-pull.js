#!/usr/bin/env node
/**
 * Shared Brain — Phase 2C Battle Test (pull orchestration)
 *
 * Validates pullCollective + ensureSharedDomainExists by simulating
 * three fellows pulling the same collective brain into their respective
 * local domains.
 *
 * Setup:
 *   - Isolated /tmp workspace
 *   - Pre-staged collective storage with entity / concept / summary pages
 *     (simulates "synthesis has already run")
 *   - Three fellow domainsDir folders
 *   - Each fellow pulls; verify each ends up with shared-<slug>/ on disk
 *
 * Scenarios:
 *   1. ensureSharedDomainExists creates the expected layout
 *   2. ensureSharedDomainExists is idempotent
 *   3. ensureSharedDomainExists writes readonly:true frontmatter (Decision 7)
 *   4. pullCollective happy path — pages land locally via writePage pipeline
 *   5. pullCollective path-traversal blocked
 *   6. pullCollective idempotency — pulling twice is safe
 *   7. pullCollective updates last_pull_at
 *   8. pullCollective on empty collective returns 0/0 cleanly
 *   9. pullCollective security: disabled connection refused
 *  10. Three-fellow round-trip — each fellow ends with the same content
 *  11. Summary pages trigger syncSummaryEntities (cross-page backlink)
 *
 * Run with:  node scripts/test-sharedbrain-pull.js
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

import { LocalFolderStorageAdapter } from '../src/brain/sharedbrain-local-adapter.js';
import { pullCollective, ensureSharedDomainExists } from '../src/brain/sharedbrain.js';

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

// ── Setup ────────────────────────────────────────────────────────────────

const workspaceRoot = mkdtempSync(path.join(tmpdir(), 'sharedbrain-2c-'));
const storageRoot   = path.join(workspaceRoot, 'shared-storage');
mkdirSync(storageRoot, { recursive: true });

console.log(`Phase 2C workspace: ${workspaceRoot}`);

function makeFellowWorkspace(label) {
  const domainsDir = path.join(workspaceRoot, `${label}-domains`);
  mkdirSync(domainsDir, { recursive: true });
  return domainsDir;
}

function makeConnection(label, fellowDisplayName, opts = {}) {
  return {
    id: randomUUID(),
    label,
    storage_type: 'local',
    local_storage_path: storageRoot,
    fellow_id: randomUUID(),
    fellow_display_name: fellowDisplayName,
    shared_domain: 'work-ai',
    shared_brain_slug: 'test-cohort',
    local_domains: ['work-ai'],
    last_push_at: null,
    last_pull_at: null,
    pending_retry: {},
    permanent_skip: [],
    enabled: true,
    ...opts,
  };
}

function makePatchFn(connectionsById) {
  return (id, patch) => {
    if (!connectionsById[id]) return null;
    for (const f of ['github_pat', 'fellow_token', 'admin_token']) {
      if (f in patch) throw new Error(`patch refused for credential field "${f}"`);
    }
    connectionsById[id] = { ...connectionsById[id], ...patch };
    return connectionsById[id];
  };
}

// Pre-stage a collective wiki via the adapter (simulating "synthesis already ran")
const adapter = new LocalFolderStorageAdapter({ storage_root: storageRoot });

async function stageCollective() {
  await adapter.writePage('work-ai', 'entities/anthropic.md',
    '# Anthropic\n\n## Key Facts\n\n- AI safety lab founded 2021.\n\n## Related\n\n- [[claude]]\n\n## Provenance\n\n- Last synthesized: 2026-05-14T02:00:00Z\n- Contributors: fellow-aaa, fellow-bbb\n');
  await adapter.writePage('work-ai', 'entities/openai.md',
    '# OpenAI\n\n## Key Facts\n\n- Research lab.\n');
  await adapter.writePage('work-ai', 'concepts/rag.md',
    '# RAG\n\nRetrieval-augmented generation.\n');
  await adapter.writePage('work-ai', 'summaries/article-foo.md',
    '# Foo Article Summary\n\n## Entities Mentioned\n\n- [[anthropic]]\n');
}

await stageCollective();

// ── 1-3. ensureSharedDomainExists ────────────────────────────────────────

section('ensureSharedDomainExists');

const fellowA_DomainsDir = makeFellowWorkspace('fellow-a');
const connA = makeConnection('Test Cohort', 'Alice');

// Set DOMAINS_PATH manually since ensureSharedDomainExists takes it directly
await ensureSharedDomainExists('shared-test-cohort', connA, fellowA_DomainsDir);

const expectedBase = path.join(fellowA_DomainsDir, 'shared-test-cohort');
assert(existsSync(expectedBase), 'shared-test-cohort/ directory created');
assert(existsSync(path.join(expectedBase, 'CLAUDE.md')), 'CLAUDE.md created');
assert(existsSync(path.join(expectedBase, 'wiki', 'entities')), 'wiki/entities/ created');
assert(existsSync(path.join(expectedBase, 'wiki', 'concepts')), 'wiki/concepts/ created');
assert(existsSync(path.join(expectedBase, 'wiki', 'summaries')), 'wiki/summaries/ created');
assert(existsSync(path.join(expectedBase, 'wiki', 'index.md')), 'wiki/index.md created');
assert(existsSync(path.join(expectedBase, 'wiki', 'log.md')), 'wiki/log.md created');
assert(existsSync(path.join(expectedBase, 'conversations')), 'conversations/ created');

const claudeMd = readFileSync(path.join(expectedBase, 'CLAUDE.md'), 'utf-8');
assert(/^---\n[\s\S]*?readonly:\s*true[\s\S]*?\n---/m.test(claudeMd),
  'CLAUDE.md has readonly:true YAML frontmatter (Decision 7)');
assert(/source:\s*shared-brain/.test(claudeMd), 'CLAUDE.md has source: shared-brain');
assert(/shared_brain_slug:\s*test-cohort/.test(claudeMd), 'CLAUDE.md records shared_brain_slug');
assert(/Shared Brain Mirror/.test(claudeMd), 'CLAUDE.md body explains this is a mirror');
assert(/will be \*\*overwritten\*\*/.test(claudeMd), 'CLAUDE.md warns about overwrites');

// Idempotency
const claudeMdBefore = readFileSync(path.join(expectedBase, 'CLAUDE.md'), 'utf-8');
await ensureSharedDomainExists('shared-test-cohort', connA, fellowA_DomainsDir);
const claudeMdAfter = readFileSync(path.join(expectedBase, 'CLAUDE.md'), 'utf-8');
assertEq(claudeMdBefore, claudeMdAfter, 'ensureSharedDomainExists is idempotent (no rewrite on re-call)');

// Slug safety
try {
  await ensureSharedDomainExists('../malicious', connA, fellowA_DomainsDir);
  fail('ensureSharedDomainExists should refuse traversal slug');
} catch (err) {
  assert(/invalid local domain slug/.test(err.message), 'rejects traversal slug with clear error');
}

// ── 3b. v3.65.3 — a mirror folder of a DIFFERENT brain is refused ─────
section('ensureSharedDomainExists — whose mirror is it? (v3.65.3)');
{
  const dir = makeFellowWorkspace('fellow-mirror-owner');
  // A GitHub-backed brain writes `shared_repo:` into the marker.
  const ghA = makeConnection('Reading Group', 'Ann', {
    storage_type: 'github', github_repo_owner: 'Bob', github_repo_name: 'Reading',
    shared_domain: 'reading', shared_brain_slug: 'reading-group',
  });
  await ensureSharedDomainExists('shared-reading-group', ghA, dir);
  const cm = readFileSync(path.join(dir, 'shared-reading-group', 'CLAUDE.md'), 'utf-8');
  assert(/^shared_repo: github:bob\/reading$/m.test(cm), 'a new GitHub mirror records shared_repo (case-folded)');

  // The SAME brain again — idempotent, as before.
  let sameErr = null;
  try { await ensureSharedDomainExists('shared-reading-group', { ...ghA, github_repo_owner: 'BOB' }, dir); }
  catch (e) { sameErr = e; }
  assert(sameErr === null, 'the same brain (case-different owner) re-uses its own mirror');

  // A DIFFERENT brain whose name derives the same mirror — refused, and the
  // folder is untouched.
  const ghB = makeConnection('Reading Group', 'Cat', {
    storage_type: 'github', github_repo_owner: 'carol', github_repo_name: 'books',
    shared_domain: 'club', shared_brain_slug: 'reading-group',
  });
  let diffErr = null;
  try { await ensureSharedDomainExists('shared-reading-group', ghB, dir); } catch (e) { diffErr = e; }
  assert(diffErr && /mirror of a DIFFERENT Shared Brain/.test(diffErr.message),
    'a different brain on the same mirror folder is refused');
  assert(diffErr && /repository folder "reading"/.test(diffErr.message), 'naming the field that disagrees');
  assertEq(readFileSync(path.join(dir, 'shared-reading-group', 'CLAUDE.md'), 'utf-8'), cm,
    'and the mirror marker was not rewritten');

  // Same folder name, different repository — caught by shared_repo alone.
  let repoErr = null;
  try {
    await ensureSharedDomainExists('shared-reading-group',
      { ...ghB, shared_domain: 'reading' }, dir);
  } catch (e) { repoErr = e; }
  assert(repoErr && /repository carol\/books, not|repository bob\/reading, not/.test(repoErr.message),
    'a different REPOSITORY with the same folder name is refused too');

  // A mirror written BEFORE v3.65.3 carries no shared_repo — never a refusal
  // on the missing field alone (it would lock every existing mirror).
  const legacyDir = makeFellowWorkspace('fellow-mirror-legacy');
  mkdirSync(path.join(legacyDir, 'shared-reading-group'), { recursive: true });
  writeFileSync(path.join(legacyDir, 'shared-reading-group', 'CLAUDE.md'),
    '---\nreadonly: true\nsource: shared-brain\nshared_brain_slug: reading-group\nshared_domain: reading\n---\n\n# old\n');
  let legacyErr = null;
  try { await ensureSharedDomainExists('shared-reading-group', ghA, legacyDir); } catch (e) { legacyErr = e; }
  assert(legacyErr === null, 'a pre-v3.65.3 mirror (no shared_repo) of the same folder is still adopted');
}

// ── 4. pullCollective happy path ─────────────────────────────────────────

section('pullCollective — happy path (Fellow A)');

const connections = { [connA.id]: connA };
const patchFn = makePatchFn(connections);

const pullA = await pullCollective(connA, {
  domainsDir: fellowA_DomainsDir,
  patchFn,
});

assert(pullA.ok, 'pull returned ok');
assertEq(pullA.local_domain, 'shared-test-cohort', 'local_domain matches');
assertEq(pullA.created + pullA.updated, 4, '4 pages written (2 entities + 1 concept + 1 summary)');

// Verify files actually landed
const localWiki = path.join(fellowA_DomainsDir, 'shared-test-cohort', 'wiki');
assert(existsSync(path.join(localWiki, 'entities', 'anthropic.md')), 'entities/anthropic.md landed locally');
assert(existsSync(path.join(localWiki, 'entities', 'openai.md')),    'entities/openai.md landed locally');
assert(existsSync(path.join(localWiki, 'concepts', 'rag.md')),       'concepts/rag.md landed locally');
assert(existsSync(path.join(localWiki, 'summaries', 'article-foo.md')), 'summaries/article-foo.md landed locally');

// Verify content survived
const anthropicLocal = readFileSync(path.join(localWiki, 'entities', 'anthropic.md'), 'utf-8');
assert(anthropicLocal.includes('AI safety lab'), 'content of pulled page preserved');
assert(anthropicLocal.includes('## Provenance'), 'Provenance section preserved');
assert(anthropicLocal.includes('Contributors: fellow-aaa, fellow-bbb'),
  'Provenance attribution preserved across pull');

// last_pull_at updated
assert(connections[connA.id].last_pull_at, 'last_pull_at populated after pull');

// log.md should have an entry
const log = readFileSync(path.join(localWiki, 'log.md'), 'utf-8');
assert(/Shared Brain pull from "Test Cohort": 4 new/.test(log),
  'log.md records the pull with counts');

// ── 5. Idempotency (BEFORE we stage extra pages) ─────────────────────────

section('pullCollective — idempotency (second pull is safe)');

const pullA2 = await pullCollective(connections[connA.id], {
  domainsDir: fellowA_DomainsDir,
  patchFn,
});

assert(pullA2.ok, 'second pull returns ok');
assertEq(pullA2.created, 0, 'second pull creates 0 new pages');
// Re-writing identical content: writePage may report "unchanged" (byte-identical)
// or "updated" (frontmatter/normalization tweaks). Either is fine — what matters
// is that NO pages were "created" and the total count covers all 4.
const totalProcessed = pullA2.created + pullA2.updated + (pullA2.unchanged || 0);
assertEq(totalProcessed, 4, 'second pull processes all 4 pages (created+updated+unchanged)');

// Files still there, content not corrupted
const anthropicAfter2 = readFileSync(path.join(localWiki, 'entities', 'anthropic.md'), 'utf-8');
assert(anthropicAfter2.includes('AI safety lab'), 'content still intact after second pull');

// ── 6. Path-traversal blocked (unit-test the guard directly) ─────────────

section('pullCollective — security: resolveInsideBase guard');

// We can't easily inject a malicious adapter without an explicit hook in
// pullCollective. But we can directly exercise the resolveInsideBase guard
// that pullCollective uses (it's exported on __testing).
const sharedbrainMod = await import('../src/brain/sharedbrain.js');
const { resolveInsideBase } = sharedbrainMod.__testing;

assert(resolveInsideBase('/tmp/x', '../../etc/passwd') === null,
  'pullCollective guard blocks ../../etc/passwd');
assert(resolveInsideBase('/tmp/x', 'foo/bar.md') !== null,
  'pullCollective guard allows normal relative path');
assert(resolveInsideBase('/tmp/x', '/absolute/path') === null,
  'pullCollective guard blocks absolute paths');
assert(resolveInsideBase('/tmp/x', '../sibling/wiki/x.md') === null,
  'pullCollective guard blocks escape into sibling domain');
assert(resolveInsideBase('/tmp/x', 'subdir/inner.md') !== null,
  'pullCollective guard allows nested subdirs (normal markdown trees)');

// ── 7. Multi-fellow simulation ──────────────────────────────────────────

section('pullCollective — three fellows pull, all converge');

const fellowB_DomainsDir = makeFellowWorkspace('fellow-b');
const fellowC_DomainsDir = makeFellowWorkspace('fellow-c');
const connB = makeConnection('Test Cohort', 'Bob');
const connC = makeConnection('Test Cohort', 'Carol');
connections[connB.id] = connB;
connections[connC.id] = connC;

const pullB = await pullCollective(connB, { domainsDir: fellowB_DomainsDir, patchFn });
const pullC = await pullCollective(connC, { domainsDir: fellowC_DomainsDir, patchFn });

assert(pullB.ok && pullB.created + pullB.updated >= 4, 'Fellow B pulled successfully');
assert(pullC.ok && pullC.created + pullC.updated >= 4, 'Fellow C pulled successfully');

// All three fellows should have the same content for the same page
const aAnthropic = readFileSync(path.join(fellowA_DomainsDir, 'shared-test-cohort/wiki/entities/anthropic.md'), 'utf-8');
const bAnthropic = readFileSync(path.join(fellowB_DomainsDir, 'shared-test-cohort/wiki/entities/anthropic.md'), 'utf-8');
const cAnthropic = readFileSync(path.join(fellowC_DomainsDir, 'shared-test-cohort/wiki/entities/anthropic.md'), 'utf-8');

// They may differ slightly due to frontmatter date stamps, but the CORE content
// should be identical — check for shared key facts.
assert(aAnthropic.includes('AI safety lab') && bAnthropic.includes('AI safety lab') && cAnthropic.includes('AI safety lab'),
  'all three fellows have the same Key Fact');
assert(aAnthropic.includes('## Provenance') && bAnthropic.includes('## Provenance') && cAnthropic.includes('## Provenance'),
  'all three fellows have the Provenance section');

// All three CLAUDE.md files have readonly:true
for (const [label, dir] of [['A', fellowA_DomainsDir], ['B', fellowB_DomainsDir], ['C', fellowC_DomainsDir]]) {
  const cm = readFileSync(path.join(dir, 'shared-test-cohort/CLAUDE.md'), 'utf-8');
  assert(/readonly:\s*true/.test(cm), `Fellow ${label}'s mirror CLAUDE.md has readonly: true`);
}

// ── 8. Empty collective ──────────────────────────────────────────────────

section('pullCollective — empty collective domain');

const fellowD_DomainsDir = makeFellowWorkspace('fellow-d');
const connD = makeConnection('Empty Cohort', 'Dave', {
  shared_domain: 'empty-domain',          // doesn't exist in storage
  shared_brain_slug: 'empty-cohort',
});
connections[connD.id] = connD;

const pullD = await pullCollective(connD, { domainsDir: fellowD_DomainsDir, patchFn });
assert(pullD.ok, 'empty-collective pull returns ok');
assertEq(pullD.created, 0, 'empty collective: 0 created');
assertEq(pullD.updated, 0, 'empty collective: 0 updated');

// Mirror domain SHOULD still be created (so it shows in list_domains)
assert(existsSync(path.join(fellowD_DomainsDir, 'shared-empty-cohort/CLAUDE.md')),
  'mirror domain created even when collective is empty');

// last_pull_at still updated
assert(connections[connD.id].last_pull_at, 'last_pull_at recorded for empty pull');

// ── 9. Security: disabled connection ────────────────────────────────────

section('pullCollective — security gates');

{
  const disabled = { ...connA, enabled: false };
  const result = await pullCollective(disabled, { domainsDir: fellowA_DomainsDir, patchFn });
  assert(!result.ok, 'disabled connection refused');
  assert(/disabled/.test(result.error || ''), 'error mentions disabled');
}

{
  const result = await pullCollective(null, { domainsDir: fellowA_DomainsDir, patchFn });
  assert(!result.ok, 'null connection refused');
  assert(/required/.test(result.error || ''), 'error mentions required');
}

{
  const missingSlug = { ...connA, shared_brain_slug: '' };
  const result = await pullCollective(missingSlug, { domainsDir: fellowA_DomainsDir, patchFn });
  assert(!result.ok, 'connection missing shared_brain_slug refused');
}

// ── 10. Env var restoration on success and on error ─────────────────────

section('pullCollective — DOMAINS_PATH env var restoration');

const prevEnv = process.env.DOMAINS_PATH;
delete process.env.DOMAINS_PATH;
await pullCollective(connA, { domainsDir: fellowA_DomainsDir, patchFn });
assert(process.env.DOMAINS_PATH === undefined,
  'DOMAINS_PATH cleared (was undefined before) — env restored after success');

process.env.DOMAINS_PATH = '/preexisting/value';
await pullCollective(connA, { domainsDir: fellowA_DomainsDir, patchFn });
assertEq(process.env.DOMAINS_PATH, '/preexisting/value',
  'pre-existing DOMAINS_PATH preserved after success');

// And on error (disabled connection — early return, but still inside try/finally)
await pullCollective({ ...connA, enabled: false }, { domainsDir: fellowA_DomainsDir, patchFn });
assertEq(process.env.DOMAINS_PATH, '/preexisting/value',
  'pre-existing DOMAINS_PATH preserved even on early-return error');

// Restore
if (prevEnv === undefined) delete process.env.DOMAINS_PATH;
else process.env.DOMAINS_PATH = prevEnv;

// ── Cleanup ──────────────────────────────────────────────────────────────

console.log('\nCleaning up...');
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

console.log('\nAll Phase 2C pull tests green. Ready for Phase 2D + 2E.');
process.exit(0);
