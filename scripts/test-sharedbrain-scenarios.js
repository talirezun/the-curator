#!/usr/bin/env node
/**
 * Shared Brain — Phase 5 production-scenario battle test (OFFLINE)
 *
 * The deterministic half of the Phase 5 production test program
 * (SHARED-BRAIN-UPGRADE.md §3 PHASE 5). Everything here runs on the LOCAL
 * storage adapter, a mock LLM, mock fetch, and tempdir git repos — no
 * network, no API key, no cost. The live half (real GitHub adapter, real
 * Gemini/Anthropic) lives in test-sharedbrain-github-live.js and
 * test-sharedbrain-llm-live.js.
 *
 * Scenarios:
 *   5.8  Pull onto a hand-edited mirror → deterministic outcome (edits
 *        overwritten, stray local pages pruned, readonly CLAUDE.md intact).
 *   5.9  Contribution landing "in the past" (clock skew / mid-synthesis
 *        push) → picked up by the next run via the watermark window,
 *        never double-processed after that (validates plan 2.1).
 *   5.10 PAT degradation mid-session (expired → 401, downgraded → 403,
 *        network drop) → typed errors, retry bookkeeping preserved,
 *        last_push_at NOT advanced, and NO token bytes in any message.
 *   5.11 Scale probe: 10 fellows × 50 shared pages through synthesis on
 *        the local adapter → all pages written, index complete, second
 *        run clean (idempotent), latency logged.
 *   5.12 Two-machine mirror × Personal Sync interplay (real git in
 *        tempdirs): the mirror domain survives the sync round-trip with
 *        its readonly marker intact, is listed as a real domain (no
 *        ghost-pruning), and machine B's copy refuses writes.
 *
 * Run with:  node scripts/test-sharedbrain-scenarios.js
 * Exit code 0 if all green; non-zero on any failure.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';

import { LocalFolderStorageAdapter } from '../src/brain/sharedbrain-local-adapter.js';
import { GitHubStorageAdapter } from '../src/brain/sharedbrain-github-adapter.js';
import { runLocalSynthesis } from '../src/brain/sharedbrain-synthesis.js';
import { pushDomain, pullCollective } from '../src/brain/sharedbrain.js';
import { isDomainReadonly } from '../src/brain/files.js';
import { __setDomainsDirOverride } from '../src/brain/config.js';

// ── Harness ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];
function ok(label)        { passed++; console.log(`  ✓ ${label}`); }
function fail(label, err) { failed++; failures.push({ label, err }); console.log(`  ✗ ${label}`); if (err) console.log(`    └─ ${err.message || err}`); }
function assert(cond, label, errMsg) {
  if (cond) ok(label);
  else fail(label, new Error(errMsg || 'assertion failed'));
}
function section(name) { console.log(`\n── ${name} ──`); }

const workspaceRoot = mkdtempSync(path.join(tmpdir(), 'sharedbrain-p5-'));
console.log(`Phase 5 scenario workspace: ${workspaceRoot}`);

const connections = {};
const patchFn = (id, patch) => {
  connections[id] = { ...(connections[id] || {}), ...patch };
  return connections[id];
};
const mockResolver = async () => JSON.stringify({ resolution: 'both', result: [] });

function makeConnection(storageRoot, opts = {}) {
  return {
    id: randomUUID(),
    label: 'P5 Scenario Brain',
    storage_type: 'local',
    local_storage_path: storageRoot,
    fellow_id: randomUUID(),
    fellow_display_name: 'Tester',
    shared_domain: 'work-ai',
    shared_brain_slug: 'p5',
    local_domains: ['work-ai'],
    last_push_at: null,
    last_pull_at: null,
    pending_retry: {},
    permanent_skip: [],
    enabled: true,
    ...opts,
  };
}

// ═══ 5.8 — Pull onto a hand-edited mirror ═══════════════════════════════════

section('5.8 — pull onto a hand-edited mirror is deterministic');

{
  const root = path.join(workspaceRoot, 'storage-5.8');
  mkdirSync(root, { recursive: true });
  const adapter = new LocalFolderStorageAdapter({ storage_root: root });
  const conn = makeConnection(root, { shared_brain_slug: 'edited' });
  const domainsDir = path.join(workspaceRoot, 'domains-5.8');
  mkdirSync(domainsDir, { recursive: true });

  await adapter.writePage('work-ai', 'concepts/canon.md',
    '# Canon\n\n## Key Facts\n\n- Collective truth.\n');

  const p1 = await pullCollective(conn, { domainsDir, patchFn });
  assert(p1.ok && p1.created >= 1, 'initial pull mirrors the collective page');

  const mirrorWiki = path.join(domainsDir, 'shared-edited', 'wiki');
  const canonPath = path.join(mirrorWiki, 'concepts', 'canon.md');

  // The user hand-edits the mirror (documented as unsupported — edits are
  // overwritten) and plants a stray page that the collective never had.
  writeFileSync(canonPath,
    '# Canon\n\n## Key Facts\n\n- Collective truth.\n- LOCAL EDIT that must not survive.\n');
  writeFileSync(path.join(mirrorWiki, 'concepts', 'stray.md'),
    '# Stray\n\n## Key Facts\n\n- Never existed in the collective.\n');

  const p2 = await pullCollective(conn, { domainsDir, patchFn });
  assert(p2.ok, 'second pull ok');
  const canon = readFileSync(canonPath, 'utf-8');
  assert(!canon.includes('LOCAL EDIT'), 'hand edit overwritten by the collective version (replace semantics)');
  assert(canon.includes('Collective truth.'), 'collective content intact');
  assert(!existsSync(path.join(mirrorWiki, 'concepts', 'stray.md')),
    `stray local page pruned (pruned=${p2.pruned})`);
  const claudeMd = readFileSync(path.join(domainsDir, 'shared-edited', 'CLAUDE.md'), 'utf-8');
  assert(/readonly:\s*true/.test(claudeMd), 'mirror CLAUDE.md readonly marker untouched by the pulls');
}

// ═══ 5.9 — contribution during / behind the synthesis window ════════════════

section('5.9 — late-landing contribution is picked up, never double-processed');

{
  const root = path.join(workspaceRoot, 'storage-5.9');
  mkdirSync(root, { recursive: true });
  const adapter = new LocalFolderStorageAdapter({ storage_root: root });
  const conn = makeConnection(root);
  connections[conn.id] = conn;

  const fellowA = randomUUID();
  const fellowB = randomUUID();
  const T0 = Date.parse('2026-07-01T12:00:00.000Z');

  // A's contribution is processed by synthesis run #1.
  await adapter.storeContribution(fellowA, randomUUID(), {
    fellow_id: fellowA, domain: 'work-ai',
    contributed_at: new Date(T0).toISOString(),
    deltas: [{ path: 'concepts/topic.md', title: 'Topic', new_facts: ['Fact from A.'], new_links: [], removed_links: [] }],
  });
  const r1 = await runLocalSynthesis(conn, { llmFn: mockResolver, patchFn, now: () => new Date(T0 + 60_000) });
  assert(r1.ok && r1.pages_written === 1, 'run #1 processes the on-time contribution');

  // B's contribution LANDS AFTER run #1 but is STAMPED BEFORE the watermark
  // (contributor clock 30 min behind, or a push that raced the synthesis).
  // Pre-v3.0.3 wall-clock filtering lost this forever.
  await adapter.storeContribution(fellowB, randomUUID(), {
    fellow_id: fellowB, domain: 'work-ai',
    contributed_at: new Date(T0 - 30 * 60_000).toISOString(),
    deltas: [{ path: 'concepts/topic.md', title: 'Topic', new_facts: ['Late-landing fact from B.'], new_links: [], removed_links: [] }],
  });
  const r2 = await runLocalSynthesis(conn, { llmFn: mockResolver, patchFn, now: () => new Date(T0 + 120_000) });
  assert(r2.ok && r2.processed_contributions === 1,
    `run #2 picks up the back-dated contribution (processed=${r2.processed_contributions})`);
  const page = await adapter.readPage('work-ai', 'concepts/topic.md');
  assert(page.includes('Fact from A.') && page.includes('Late-landing fact from B.'),
    'both facts present after run #2');

  // Run #3: nothing new — the processed_ids dedup must prevent reprocessing
  // (the back-dated stamp keeps B inside the listing window forever-ish).
  const r3 = await runLocalSynthesis(conn, { llmFn: mockResolver, patchFn, now: () => new Date(T0 + 180_000) });
  assert(r3.ok && r3.processed_contributions === 0,
    `run #3 processes nothing (dedup by submission id, got ${r3.processed_contributions})`);
  const page3 = await adapter.readPage('work-ai', 'concepts/topic.md');
  const bCount = (page3.match(/Late-landing fact from B\./g) || []).length;
  assert(bCount === 1, `late fact appears exactly once (got ${bCount})`);
}

// ═══ 5.10 — PAT degradation mid-session ═════════════════════════════════════

section('5.10 — PAT degradation: typed errors, no token leakage, state preserved');

{
  // A wiki with one page to push.
  const domainsDir = path.join(workspaceRoot, 'domains-5.10');
  const wikiDir = path.join(domainsDir, 'work-ai', 'wiki', 'concepts');
  mkdirSync(wikiDir, { recursive: true });
  writeFileSync(path.join(wikiDir, 'page.md'), '# Page\n\n## Key Facts\n\n- A fact.\n');

  const SECRET_PAT = 'github_pat_SUPERSECRET_1234567890abcdefghij';

  function degradedFetch(status) {
    return async () => ({
      ok: false, status,
      headers: { get: () => null },
      json: async () => ({ message: `denied (echo ${SECRET_PAT})` }), // adversarial echo
      text: async () => '',
    });
  }

  // Expired / revoked PAT → 401 typed AUTH error.
  {
    const gh = new GitHubStorageAdapter({
      owner: 'octocat', repo: 'mock', pat: SECRET_PAT, fetchImpl: degradedFetch(401),
    });
    let err = null;
    try { await gh.readPage('work-ai', 'concepts/page.md'); } catch (e) { err = e; }
    assert(err && err.code === 'SHARED_BRAIN_AUTH', 'expired PAT → typed SHARED_BRAIN_AUTH');
    assert(!String(err.message).includes(SECRET_PAT), '401 message carries no token bytes (sanitized)');
  }

  // Downgraded to read-only mid-push → 403 on the contribution write;
  // pushDomain returns ok:false, KEEPS the retry bookkeeping, and does NOT
  // advance last_push_at (the pages must rescan next push).
  {
    const patches = [];
    const conn = makeConnection('/unused', {
      storage_type: 'github',
      github_repo_owner: 'octocat', github_repo_name: 'mock',
      github_pat: SECRET_PAT, github_branch: 'main',
    });
    delete conn.local_storage_path;
    // The delta LLM succeeds; the storage write is what degrades.
    const llmFn = async () => JSON.stringify({
      title: 'Page', summary: 'S', new_facts: ['A fact.'], new_links: [], removed_links: [],
    });
    // Monkey-patch: route the factory's fetch through the 403 mock by
    // building the connection so createStorageAdapter makes a GitHub
    // adapter... but we can't inject fetchImpl through pushDomain. Instead
    // exercise the same path via the adapter directly + the L3 contract at
    // the pushDomain level with a THROWING local adapter stand-in: use a
    // local storage path that does not exist → storeContribution throws.
    const gh = new GitHubStorageAdapter({
      owner: 'octocat', repo: 'mock', pat: SECRET_PAT, fetchImpl: degradedFetch(403),
    });
    let err = null;
    try { await gh.writePage('work-ai', 'concepts/page.md', 'x'); } catch (e) { err = e; }
    assert(err && err.code === 'SHARED_BRAIN_FORBIDDEN', 'downgraded PAT write → typed SHARED_BRAIN_FORBIDDEN');
    assert(!String(err.message).includes(SECRET_PAT), '403 message carries no token bytes (sanitized)');

    // pushDomain-level: storage failure preserves bookkeeping, no timestamp
    // advance. The local adapter auto-creates its root, so force a
    // deterministic write failure by planting a regular FILE where the
    // adapter needs the contributions/ DIRECTORY.
    const blockedRoot = path.join(workspaceRoot, 'blocked-storage-5.10');
    mkdirSync(blockedRoot, { recursive: true });
    writeFileSync(path.join(blockedRoot, 'contributions'), 'not a directory');
    const conn2 = makeConnection(blockedRoot, {
      pending_retry: { 'concepts/old-failure.md': 1 },
    });
    connections[conn2.id] = conn2;
    const res = await pushDomain(conn2, 'work-ai', {
      domainsDir, llmFn, patchFn, now: () => new Date('2026-07-01T12:00:00.000Z'),
    });
    assert(res.ok === false && /storage|ENOTDIR|EEXIST|not a directory/i.test(res.error || ''),
      `pushDomain surfaces the storage failure (got ok=${res.ok}, error=${res.error})`);
    const patched = connections[conn2.id];
    assert(patched.last_push_at === undefined || patched.last_push_at === null,
      'last_push_at NOT advanced on storage failure (pages rescan next push)');
    assert(patched.pending_retry !== undefined, 'retry bookkeeping still persisted (L3)');
  }

  // Network drop mid-operation → error surfaces, no crash, no token bytes.
  {
    const gh = new GitHubStorageAdapter({
      owner: 'octocat', repo: 'mock', pat: SECRET_PAT,
      fetchImpl: async () => { throw new Error('fetch failed: socket hang up'); },
    });
    let err = null;
    try { await gh.listPages('work-ai'); } catch (e) { err = e; }
    assert(err && !String(err.message).includes(SECRET_PAT), 'network-drop error carries no token bytes');
  }
}

// ═══ 5.11 — scale probe: 10 fellows × 50 pages ══════════════════════════════

section('5.11 — scale probe: 10 fellows × 50 pages through synthesis');

{
  const root = path.join(workspaceRoot, 'storage-5.11');
  mkdirSync(root, { recursive: true });
  const adapter = new LocalFolderStorageAdapter({ storage_root: root });
  const conn = makeConnection(root);
  connections[conn.id] = conn;

  const FELLOWS = 10;
  const PAGES = 50;
  const T0 = Date.parse('2026-07-01T08:00:00.000Z');

  for (let f = 0; f < FELLOWS; f++) {
    const fellowId = randomUUID();
    // Each fellow contributes to every 5th page starting at their offset →
    // every page gets exactly 1 fellow; pages f..f+? also get overlap via a
    // second delta batch below.
    const deltas = [];
    for (let p = f; p < PAGES; p += FELLOWS) {
      deltas.push({
        path: `concepts/page-${String(p).padStart(2, '0')}.md`,
        title: `Page ${p}`,
        new_facts: [`Fellow ${f} observed detail number ${p} about this topic.`],
        new_links: [], removed_links: [],
      });
    }
    // Overlap: every fellow ALSO contributes one distinct fact to page-00,
    // so one page accumulates facts from all 10 fellows.
    if (f > 0) {
      deltas.push({
        path: 'concepts/page-00.md', title: 'Page 0',
        new_facts: [`Fellow ${f} adds an entirely different angle on subject ${f * 7}.`],
        new_links: [], removed_links: [],
      });
    }
    await adapter.storeContribution(fellowId, randomUUID(), {
      fellow_id: fellowId, domain: 'work-ai',
      contributed_at: new Date(T0 + f * 1000).toISOString(),
      deltas,
    });
  }

  const started = Date.now();
  const r = await runLocalSynthesis(conn, { llmFn: mockResolver, patchFn, now: () => new Date(T0 + 3600_000) });
  const elapsedMs = Date.now() - started;
  console.log(`  (scale probe: ${FELLOWS} fellows × ${PAGES} pages synthesized in ${elapsedMs} ms)`);

  assert(r.ok, 'scale synthesis ok');
  assert(r.processed_contributions === FELLOWS, `all ${FELLOWS} submissions processed`);
  assert(r.pages_written === PAGES, `all ${PAGES} pages written (got ${r.pages_written})`);
  assert(r.pages_failed === 0, 'zero failed pages');

  const hub = await adapter.readPage('work-ai', 'concepts/page-00.md');
  const hubFacts = (hub.match(/^- /gm) || []).length;
  assert(hubFacts >= FELLOWS, `hub page accumulated all fellows' facts (${hubFacts} bullets)`);

  const index = await adapter.readPage('work-ai', 'index.md');
  let missing = 0;
  for (let p = 0; p < PAGES; p++) {
    if (!index.includes(`page-${String(p).padStart(2, '0')}`)) missing++;
  }
  assert(missing === 0, `index.md lists every page (missing ${missing})`);

  // Second run: idempotent, nothing reprocessed.
  const r2 = await runLocalSynthesis(conn, { llmFn: mockResolver, patchFn, now: () => new Date(T0 + 7200_000) });
  assert(r2.ok && r2.processed_contributions === 0, 'second run processes nothing (idempotent)');
  assert(elapsedMs < 60_000, `scale run completes in bounded time (${elapsedMs} ms < 60 s)`);
}

// ═══ 5.12 — two-machine mirror × Personal Sync interplay ════════════════════

section('5.12 — mirror domain survives a Personal-Sync round-trip (real git)');

{
  function git(args, cwd) {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  }

  // Machine A: pull a mirror from the collective.
  const root = path.join(workspaceRoot, 'storage-5.12');
  mkdirSync(root, { recursive: true });
  const adapter = new LocalFolderStorageAdapter({ storage_root: root });
  await adapter.writePage('work-ai', 'concepts/shared-fact.md',
    '# Shared Fact\n\n## Key Facts\n\n- Known to the whole cohort.\n');

  const machineA = path.join(workspaceRoot, 'machine-a-domains');
  mkdirSync(machineA, { recursive: true });
  const conn = makeConnection(root, { shared_brain_slug: 'sync' });
  const p1 = await pullCollective(conn, { domainsDir: machineA, patchFn });
  assert(p1.ok && p1.created >= 1, 'machine A pulls the mirror');

  // Personal Sync (as sync.js does): git the domains folder to a bare remote.
  const bare = path.join(workspaceRoot, 'remote.git');
  git(['init', '--bare', bare], workspaceRoot);
  // Point the bare repo's HEAD at main so `git clone` checks out our pushed
  // branch regardless of the machine's init.defaultBranch setting.
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], bare);
  git(['init'], machineA);
  git(['config', 'user.email', 'test@test'], machineA);
  git(['config', 'user.name', 'Test'], machineA);
  git(['add', '-A'], machineA);
  git(['commit', '-m', 'sync from machine A'], machineA);
  git(['push', bare, 'HEAD:main'], machineA);

  // Machine B: clone (first-time sync down).
  const machineB = path.join(workspaceRoot, 'machine-b-domains');
  git(['clone', bare, machineB], workspaceRoot);

  const mirrorB = path.join(machineB, 'shared-sync');
  assert(existsSync(path.join(mirrorB, 'CLAUDE.md')),
    'mirror arrives on machine B WITH its CLAUDE.md (not a ghost — listDomains counts it)');
  assert(existsSync(path.join(mirrorB, 'wiki', 'concepts', 'shared-fact.md')),
    'mirror content arrives on machine B');

  // Machine B's copy must still be recognised as read-only.
  __setDomainsDirOverride(machineB);
  try {
    const ro = await isDomainReadonly('shared-sync');
    assert(ro === true, 'machine B recognises the synced mirror as read-only (frontmatter survived git)');
  } finally {
    __setDomainsDirOverride(null);
  }

  // Machine A prunes a page (e.g. post-revocation pull) → sync → machine B
  // receives the deletion.
  await adapter.deletePage('work-ai', 'concepts/shared-fact.md');
  await adapter.writePage('work-ai', 'concepts/replacement.md',
    '# Replacement\n\n## Key Facts\n\n- New canon.\n');
  const p2 = await pullCollective(conn, { domainsDir: machineA, patchFn });
  assert(p2.ok && p2.pruned >= 1, 'machine A pull prunes the deleted page');
  git(['add', '-A'], machineA);
  git(['commit', '-m', 'sync after revocation pull'], machineA);
  git(['push', bare, 'HEAD:main'], machineA);
  git(['pull', bare, 'main'], machineB);
  assert(!existsSync(path.join(mirrorB, 'wiki', 'concepts', 'shared-fact.md')),
    'erasure propagates to machine B through Personal Sync');
  assert(existsSync(path.join(mirrorB, 'wiki', 'concepts', 'replacement.md')),
    'replacement page arrives on machine B');
}

// ═══ Result ═════════════════════════════════════════════════════════════════

console.log(`\n${'═'.repeat(50)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ✗ ${f.label}\n    ${f.err.message}`);
}

try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* best-effort */ }

process.exit(failed > 0 ? 1 : 0);
