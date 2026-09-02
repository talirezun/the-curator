#!/usr/bin/env node
/**
 * Shared Brain — v3.0.2 hardening battle test (Phase 1 of the
 * production-hardening plan; see SHARED-BRAIN-UPGRADE.md, private doc).
 *
 * Covers, OFFLINE (no network, no real LLM):
 *   1. C1  — one malformed contribution payload can no longer brick synthesis:
 *            non-string facts are filtered at the trust boundary, and a
 *            failing page degrades (pages_failed) instead of aborting the run.
 *   2. H5  — permanent_skip recovery: a skipped page edited after the last
 *            push is un-skipped and retried; transient LLM errors (503/429/
 *            network) do NOT count toward the 3-strike limit.
 *   3. L4  — shared-* mirrors are refused as contributing domains, both in
 *            pushDomain's gate and in validateConnection.
 *   4. L8/L9 — validateConnection rejects ".."-shaped repo names and
 *            multi-line labels.
 *   5. 1.10 — invite-token decoder length cap; repo "owner/.." refused.
 *   6. Source-level guards — the concurrency (write-registry/file-lock),
 *            readonly-mirror enforcement, Host-header guard, execFile swap,
 *            and multi-domain push are present in the shipped files. (Their
 *            full runtime behaviour needs a live server — covered by the
 *            routes suite; these guards catch accidental removal.)
 *
 * Run with:  node scripts/test-sharedbrain-hardening.js
 * Exit code 0 if all green; non-zero on any failure.
 * Uses isolated tmp folders only — never touches real config or domains.
 */

import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

import { LocalFolderStorageAdapter } from '../src/brain/sharedbrain-local-adapter.js';
import {
  runLocalSynthesis, mergeFactsForPage, extractSectionBullets,
  sanitizeFellowText, isSafeLinkSlug,
} from '../src/brain/sharedbrain-synthesis.js';
import { pushDomain, pullCollective, isTransientLlmError, MAX_RETRY_ATTEMPTS, computePendingPages, listMembers, groupMembers } from '../src/brain/sharedbrain.js';
import { revokeContributor } from '../src/brain/sharedbrain-revoke.js';
import { GitHubStorageAdapter } from '../src/brain/sharedbrain-github-adapter.js';
import { __testing as configTesting } from '../src/brain/sharedbrain-config.js';
import { __testing as routesTesting } from '../src/routes/sharedbrain.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

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
function assertThrows(fn, snippet, label) {
  try { fn(); fail(label, new Error('expected a throw, got none')); }
  catch (err) {
    if (String(err.message).includes(snippet)) ok(label);
    else fail(label, new Error(`threw, but message "${err.message}" lacks "${snippet}"`));
  }
}
function section(name) { console.log(`\n── ${name} ──`); }

// ── Workspace ──────────────────────────────────────────────────────────────

const workspaceRoot = mkdtempSync(path.join(tmpdir(), 'sharedbrain-b28-'));
const storageRoot   = path.join(workspaceRoot, 'shared-storage');
mkdirSync(storageRoot, { recursive: true });
console.log(`beta.28 hardening workspace: ${workspaceRoot}`);

function makeConnection(opts = {}) {
  return {
    id: randomUUID(),
    label: 'Hardening Test Brain',
    storage_type: 'local',
    local_storage_path: storageRoot,
    fellow_id: randomUUID(),
    fellow_display_name: 'Tester',
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
  connections[id] = { ...(connections[id] || {}), ...patch };
  return connections[id];
};

const mockResolver = async () => JSON.stringify({ resolution: 'both', result: [] });

// ═══ 1. C1 — malformed payloads can't brick synthesis ══════════════════════

section('1. C1 — malformed contribution payloads degrade, never abort');

{
  const adapter = new LocalFolderStorageAdapter({ storage_root: storageRoot });
  const evilFellow = randomUUID();
  const goodFellow = randomUUID();

  // A hand-crafted payload with non-string facts — exactly what a malicious
  // (or buggy) contributor with repo write access can store directly.
  await adapter.storeContribution(evilFellow, randomUUID(), {
    submission_id: randomUUID(),
    fellow_id: evilFellow,
    domain: 'work-ai',
    contributed_at: new Date().toISOString(),
    deltas: [{
      path: 'concepts/poisoned.md',
      title: 'Poisoned',
      new_facts: [42, { a: 1 }, null, '   ', 'Real fact that survives.'],
      new_links: [],
      removed_links: [],
    }],
  });
  // A perfectly normal contribution from another fellow.
  await adapter.storeContribution(goodFellow, randomUUID(), {
    submission_id: randomUUID(),
    fellow_id: goodFellow,
    domain: 'work-ai',
    contributed_at: new Date().toISOString(),
    deltas: [{
      path: 'concepts/healthy.md',
      title: 'Healthy',
      new_facts: ['A healthy fact.'],
      new_links: [],
      removed_links: [],
    }],
  });

  const conn = makeConnection();
  connections[conn.id] = conn;
  const result = await runLocalSynthesis(conn, { llmFn: mockResolver, patchFn });

  assert(result.ok === true, 'synthesis returns ok:true despite the poisoned payload');
  assert(result.pages_written >= 2, `both pages written (got ${result.pages_written})`);
  assert(result.pages_failed === 0, 'no page failures — non-string facts filtered, not fatal');

  const poisoned = await adapter.readPage('work-ai', 'concepts/poisoned.md');
  assert(poisoned && poisoned.includes('Real fact that survives.'), 'string fact from the poisoned payload survives');
  assert(poisoned && !poisoned.includes('- 42'), 'numeric fact is dropped, not rendered');

  // A SECOND run must also work (pre-fix, the poisoned contribution
  // re-bricked every subsequent run because last-synthesis only advances
  // at the end of a successful pass).
  const again = await runLocalSynthesis(conn, { llmFn: mockResolver, patchFn });
  assert(again.ok === true, 'second synthesis run is healthy (no re-poisoning)');
}

// mergeFactsForPage direct hardening
{
  const merged = await mergeFactsForPage(
    'Topic',
    ['Existing fact.'],
    [{ contributorId: 'x', facts: [42, null, undefined, 'New fact.'] }],
    mockResolver,
    id => id
  );
  assert(Array.isArray(merged.unifiedFacts), 'mergeFactsForPage tolerates non-string facts');
  assert(merged.unifiedFacts.includes('New fact.'), 'string fact kept');
  assert(!merged.unifiedFacts.some(f => typeof f !== 'string'), 'no non-string facts in output');
}

// ═══ 2. H5 — permanent_skip recovery + transient-error handling ════════════

section('2. H5 — permanent_skip recovery');

function makeDomainDir(label) {
  const domainsDir = path.join(workspaceRoot, `${label}-domains`);
  const wikiDir = path.join(domainsDir, 'work-ai', 'wiki');
  for (const f of ['entities', 'concepts', 'summaries']) {
    mkdirSync(path.join(wikiDir, f), { recursive: true });
  }
  return { domainsDir, wikiDir };
}

const echoLlm = async (_s, user) => {
  const m = user.match(/PAGE PATH:\s*(\S+)/);
  const slug = (m ? m[1] : 'x').replace(/^(entities|concepts|summaries)\//, '').replace(/\.md$/, '');
  return JSON.stringify({ title: slug, new_facts: [`Fact about ${slug}.`], stable_facts: [], new_links: [], removed_links: [], key_entities: [] });
};

{
  // Page was skipped in the past; user edits it AFTER last_push_at → un-skip.
  const { domainsDir, wikiDir } = makeDomainDir('unskip');
  const lastPush = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
  const pageAbs = path.join(wikiDir, 'concepts/recovered.md');
  writeFileSync(pageAbs, '# Recovered\n\nEdited after the skip.\n', 'utf-8'); // mtime = now > lastPush

  const conn = makeConnection({
    last_push_at: lastPush.toISOString(),
    permanent_skip: ['concepts/recovered.md'],
  });
  connections[conn.id] = conn;

  const result = await pushDomain(conn, 'work-ai', { domainsDir, llmFn: echoLlm, patchFn });
  assert(result.ok === true, 'push succeeds');
  assert(result.pushed === 1, `edited skipped page is pushed (got pushed=${result.pushed})`);
  assert(!result.permanent_skip.includes('concepts/recovered.md'), 'page removed from permanent_skip');
  assert(!connections[conn.id].permanent_skip.includes('concepts/recovered.md'), 'un-skip persisted via patchFn');
}

{
  // Page skipped and NOT edited since → stays skipped.
  const { domainsDir, wikiDir } = makeDomainDir('stay-skipped');
  const pageAbs = path.join(wikiDir, 'concepts/stale.md');
  writeFileSync(pageAbs, '# Stale\n', 'utf-8');
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  utimesSync(pageAbs, old, old); // mtime 2h ago
  const conn = makeConnection({
    last_push_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1h ago
    permanent_skip: ['concepts/stale.md'],
  });
  connections[conn.id] = conn;

  const result = await pushDomain(conn, 'work-ai', { domainsDir, llmFn: echoLlm, patchFn });
  assert(result.ok === true && result.pushed === 0, 'unedited skipped page is not pushed');
  assert(result.permanent_skip.includes('concepts/stale.md'), 'unedited page stays in permanent_skip');
}

section('2b. H5 — transient errors do not strike the counter');

{
  assert(isTransientLlmError('⚠ Gemini (HTTP 503): The AI service is temporarily overloaded'), '503 message is transient');
  assert(isTransientLlmError('LLM call failed: 429 Too Many Requests'), '429 message is transient');
  assert(isTransientLlmError('LLM call failed: read ECONNRESET'), 'ECONNRESET is transient');
  assert(isTransientLlmError('LLM call failed: Premature close'), 'Premature close is transient');
  assert(!isTransientLlmError('LLM parse failed: Unexpected token < in JSON'), 'parse failure is NOT transient');
  assert(!isTransientLlmError('pagePath is required'), 'validation failure is NOT transient');
}

{
  const { domainsDir, wikiDir } = makeDomainDir('transient');
  writeFileSync(path.join(wikiDir, 'concepts/blipped.md'), '# Blipped\n', 'utf-8');
  const failing503 = async () => { throw new Error('503 Service Unavailable — temporarily overloaded'); };
  const conn = makeConnection();
  connections[conn.id] = conn;

  // Push repeatedly through a simulated outage — MUST never permanent-skip.
  let latest = conn;
  for (let i = 0; i < MAX_RETRY_ATTEMPTS + 2; i++) {
    const r = await pushDomain(latest, 'work-ai', { domainsDir, llmFn: failing503, patchFn });
    assert(r.ok === true, `outage push ${i + 1} still returns ok (partial-push contract)`);
    latest = { ...latest, ...connections[conn.id] };
  }
  assert(!connections[conn.id].permanent_skip.includes('concepts/blipped.md'),
    'page NOT permanent-skipped after 5 pushes through a 503 outage');
  assert((connections[conn.id].pending_retry['concepts/blipped.md'] || 0) === 0,
    'transient failures never advanced the strike counter');

  // Provider recovers → the page pushes normally.
  const recovered = await pushDomain({ ...latest, ...connections[conn.id] }, 'work-ai', { domainsDir, llmFn: echoLlm, patchFn });
  assert(recovered.pushed === 1, 'page pushes cleanly once the provider recovers');
}

{
  // Genuine (non-transient) failures still strike out after MAX_RETRY_ATTEMPTS.
  const { domainsDir, wikiDir } = makeDomainDir('genuine-fail');
  writeFileSync(path.join(wikiDir, 'concepts/broken.md'), '# Broken\n', 'utf-8');
  const badJson = async () => 'not json { at all';
  const conn = makeConnection();
  connections[conn.id] = conn;

  let latest = conn;
  for (let i = 0; i < MAX_RETRY_ATTEMPTS; i++) {
    await pushDomain(latest, 'work-ai', { domainsDir, llmFn: badJson, patchFn });
    latest = { ...latest, ...connections[conn.id] };
  }
  assert(connections[conn.id].permanent_skip.includes('concepts/broken.md'),
    `genuinely-failing page permanent-skips after ${MAX_RETRY_ATTEMPTS} attempts (unchanged behaviour)`);
}

// ═══ 3. L4 — shared-* mirrors can't contribute ═════════════════════════════

section('3. L4 — shared-* mirror refusal');

{
  const { domainsDir } = makeDomainDir('mirror-push');
  // Even with the mirror listed in local_domains (hand-edited config), the
  // pushDomain gate refuses.
  const conn = makeConnection({ local_domains: ['shared-cohort'] });
  const result = await pushDomain(conn, 'shared-cohort', { domainsDir, llmFn: echoLlm, patchFn });
  assert(result.ok === false && /read-only Shared Brain mirror/.test(result.error),
    'pushDomain refuses a shared-* contributing domain');
}

{
  const { validateConnection } = configTesting;
  const base = makeConnection();
  assertThrows(() => validateConnection({ ...base, local_domains: ['shared-cohort'] }),
    'read-only Shared Brain mirror', 'validateConnection rejects shared-* in local_domains');
  try { validateConnection(base); ok('validateConnection accepts a normal connection'); }
  catch (err) { fail('validateConnection accepts a normal connection', err); }
}

// ═══ 4. L8/L9 — connection field hygiene ═══════════════════════════════════

section('4. L8/L9 — repo-name and label hygiene');

{
  const { validateConnection } = configTesting;
  const ghBase = makeConnection({
    storage_type: 'github',
    github_repo_owner: 'someone',
    github_repo_name: 'brain-repo',
    github_pat: 'github_pat_test_1234567890abcdef',
  });
  delete ghBase.local_storage_path;

  try { validateConnection(ghBase); ok('valid github connection accepted'); }
  catch (err) { fail('valid github connection accepted', err); }

  assertThrows(() => validateConnection({ ...ghBase, github_repo_name: '..' }),
    'valid GitHub repo name', 'github_repo_name ".." rejected');
  assertThrows(() => validateConnection({ ...ghBase, github_repo_name: '.' }),
    'valid GitHub repo name', 'github_repo_name "." rejected');
  assertThrows(() => validateConnection({ ...ghBase, label: 'line one\nline two' }),
    'single line', 'multi-line label rejected');
  assertThrows(() => validateConnection({ ...ghBase, label: 'sneaky\rreturn' }),
    'single line', 'carriage-return label rejected');
}

// ═══ 5. Invite-token hardening ═════════════════════════════════════════════

section('5. Invite-token cap + repo validation');

{
  const { encodeInviteToken, decodeInviteToken } = routesTesting;

  // Round-trip still works (regression guard).
  const token = encodeInviteToken({ repo: 'owner/repo', name: 'Test Brain', shared_domain: 'work-ai' });
  const meta = decodeInviteToken(token);
  assert(meta.repo === 'owner/repo' && meta.name === 'Test Brain', 'invite token round-trip intact');

  assertThrows(() => decodeInviteToken('sbi_' + 'A'.repeat(9000)),
    'too long', 'oversized invite token rejected before decode work');
  assertThrows(() => encodeInviteToken({ repo: 'owner/..', name: 'X', shared_domain: 'work-ai' }),
    'owner/name', 'encodeInviteToken rejects "owner/.." repo');
  assertThrows(() => decodeInviteToken('sbi_' + Buffer.from(JSON.stringify({
    v: 1, repo: 'owner/.', name: 'X', shared_domain: 'work-ai',
  })).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')),
    'owner/name', 'decodeInviteToken rejects "owner/." repo');
}

// ═══ 6. Source-level guards ════════════════════════════════════════════════
// These assert the shipped files still carry the beta.28 hardening. Runtime
// behaviour of the routes needs a live server (routes suite, LIVE_LOCAL);
// these catch accidental removal in future refactors.

section('6. Source-level guards');

const src = rel => readFileSync(path.join(PROJECT_ROOT, rel), 'utf-8');

{
  const brain = src('src/brain/sharedbrain.js');
  assert(brain.includes('execFileAsync') && !brain.includes('promisify(exec)\n') && !/execAsync\(/.test(brain),
    'sharedbrain.js uses execFile (no shell interpolation of page paths)');
  assert(!/execAsync\s*=\s*promisify\(exec\)/.test(brain), 'no exec-based promisify left in sharedbrain.js');

  const routes = src('src/routes/sharedbrain.js');
  assert(routes.includes("from '../brain/write-registry.js'"), 'sharedbrain routes import the write-registry');
  assert(routes.includes("registerWrite(localDomain, 'sharedbrain-pull')"), 'pull registers a write');
  assert(routes.includes("acquireFileLock(domainPath(localDomain)"), 'pull takes the per-domain file lock');
  assert(routes.includes("'sharedbrain-synthesize'") && routes.includes("'sharedbrain-revoke'"),
    'synthesize + revoke register writes');
  assert((routes.match(/isUpdateInProgress\(\)/g) || []).length >= 4,
    'all four SSE ops check isUpdateInProgress');
  assert(routes.includes('domainsToPush'), 'push iterates ALL contributing domains');
  assert(routes.includes('result.ok === false') || routes.includes('result && result.ok === false'),
    'routes surface ok:false results as errors');

  const ingest = src('src/routes/ingest.js');
  const compile = src('src/routes/compile.js');
  assert(ingest.includes('isDomainReadonly'), 'ingest route enforces readonly mirrors');
  assert(compile.includes('isDomainReadonly'), 'compile route enforces readonly mirrors');

  const health = src('src/routes/health.js');
  const writableUses = (health.match(/assertWritableDomain\(domain\)/g) || []).length;
  assert(health.includes('async function assertWritableDomain'), 'health has assertWritableDomain helper');
  assert(writableUses >= 6, `all 6 mutating health endpoints use assertWritableDomain (found ${writableUses})`);

  const server = src('src/server.js');
  assert(server.includes('ALLOWED_HOSTS') && server.includes('req.headers.host'),
    'server.js carries the Host-header (DNS-rebinding) guard');

  const domainsRoute = src('src/routes/domains.js');
  assert(domainsRoute.includes('readonlyDomains'), 'GET /api/domains reports readonly mirrors');

  // REMOVED in v3.41.0 — four source-PRESENCE assertions against
  // src/public/app.js and src/public/index.html (readonly-mirror filtering in
  // the ingest dropdown, the busy-state registration key, the Settings enable
  // state, and the enable button's absence from the Sync tab). Both files are
  // deleted. They are not repointed at /next: they asserted that an
  // identifier appeared in a file, which CLAUDE.md names as the weakest
  // shape a guard can take, and /next's own suites
  // (test-next-sync-spin.js, test-next-sharedbrain-admin.js) drive the
  // corresponding logic by executing it. The BACKEND half of each — the
  // readonly-mirror refusals and the route-level gating — is asserted above
  // and below this block and is untouched.
}


// ═══════════════════════════════════════════════════════════════════════════
// Phase 2 (v3.0.3) — data-integrity & trust-boundary hardening
// ═══════════════════════════════════════════════════════════════════════════

section('7. 2.1 — processed-submission tracking (clock skew, consumed-on-failure)');

{
  // Fresh storage for this scenario
  const root2 = path.join(workspaceRoot, 'storage-2.1');
  mkdirSync(root2, { recursive: true });
  const adapter = new LocalFolderStorageAdapter({ storage_root: root2 });
  const conn = makeConnection({ local_storage_path: root2 });
  connections[conn.id] = conn;

  const fellowA = randomUUID();
  const now = Date.now();

  // Run 1: one healthy contribution → establishes a watermark.
  await adapter.storeContribution(fellowA, randomUUID(), {
    fellow_id: fellowA, domain: 'work-ai',
    contributed_at: new Date(now).toISOString(),
    deltas: [{ path: 'concepts/base.md', title: 'Base', new_facts: ['Base fact.'], new_links: [], removed_links: [] }],
  });
  const r1 = await runLocalSynthesis(conn, { llmFn: mockResolver, patchFn });
  assert(r1.ok && r1.pages_written >= 1, 'run 1 establishes state');
  const state1 = await adapter.readMeta('state.last-synthesis');
  assert(state1 && 'watermark' in state1 && Array.isArray(state1.processed_ids),
    'state carries watermark + processed_ids (v3.0.3 schema)');

  // Clock skew: a contribution stamped 30 min BEFORE the watermark (a fellow
  // whose clock runs behind). Pre-fix this was skipped forever.
  const skewSub = randomUUID();
  await adapter.storeContribution(fellowA, skewSub, {
    fellow_id: fellowA, domain: 'work-ai',
    contributed_at: new Date(now - 30 * 60 * 1000).toISOString(),
    deltas: [{ path: 'concepts/skewed.md', title: 'Skewed', new_facts: ['Fact from a slow clock.'], new_links: [], removed_links: [] }],
  });
  const r2 = await runLocalSynthesis(conn, { llmFn: mockResolver, patchFn });
  assert(r2.ok && r2.processed_contributions === 1, 'clock-skewed contribution is NOT lost');
  const skewedPage = await adapter.readPage('work-ai', 'concepts/skewed.md');
  assert(skewedPage && skewedPage.includes('Fact from a slow clock.'), 'skewed contribution page written');

  // Re-run: dedup via processed_ids — nothing to do.
  const r3 = await runLocalSynthesis(conn, { llmFn: mockResolver, patchFn });
  assert(r3.ok && r3.processed_contributions === 0, 'processed submission is not reprocessed');

  // Consumed-on-failure: block a page's write by planting a DIRECTORY at its
  // storage path, push a contribution targeting it + another page.
  const blockedDir = path.join(root2, 'collective', 'work-ai', 'wiki', 'concepts', 'blocked.md');
  mkdirSync(blockedDir, { recursive: true });
  const failSub = randomUUID();
  await adapter.storeContribution(fellowA, failSub, {
    fellow_id: fellowA, domain: 'work-ai',
    contributed_at: new Date(now + 1000).toISOString(),
    deltas: [
      { path: 'concepts/blocked.md', title: 'Blocked', new_facts: ['Must not be consumed.'], new_links: [], removed_links: [] },
      { path: 'concepts/fine.md',    title: 'Fine',    new_facts: ['Sibling page.'],         new_links: [], removed_links: [] },
    ],
  });
  const r4 = await runLocalSynthesis(conn, { llmFn: mockResolver, patchFn });
  assert(r4.ok === true, 'run with a failing page still completes');
  assert(r4.pages_failed >= 1, 'failing page reported in pages_failed');
  const state4 = await adapter.readMeta('state.last-synthesis');
  assert(!state4.processed_ids.includes(failSub), 'submission with a failed page is NOT marked processed');

  // Unblock and re-run: the submission processes now — facts were not lost.
  rmSync(blockedDir, { recursive: true, force: true });
  const r5 = await runLocalSynthesis(conn, { llmFn: mockResolver, patchFn });
  assert(r5.ok && r5.pages_written >= 1, 'retry after unblocking writes the page');
  const blockedPage = await adapter.readPage('work-ai', 'concepts/blocked.md');
  assert(blockedPage && blockedPage.includes('Must not be consumed.'), 'facts from the failed run were recovered, not consumed');
  const state5 = await adapter.readMeta('state.last-synthesis');
  assert(state5.processed_ids.includes(failSub), 'submission marked processed after successful retry');

  // M8: unparseable contributed_at is still processed.
  const garbageSub = randomUUID();
  await adapter.storeContribution(fellowA, garbageSub, {
    fellow_id: fellowA, domain: 'work-ai',
    contributed_at: 'not-a-date',
    deltas: [{ path: 'concepts/undated.md', title: 'Undated', new_facts: ['Fact with a corrupt stamp.'], new_links: [], removed_links: [] }],
  });
  const r6 = await runLocalSynthesis(conn, { llmFn: mockResolver, patchFn });
  assert(r6.ok && r6.processed_contributions === 1, 'unparseable contributed_at does not drop the contribution (M8)');
}

section('8. 2.2/H6b — injection sanitization + attribution spoofing');

{
  const root3 = path.join(workspaceRoot, 'storage-2.2');
  mkdirSync(root3, { recursive: true });
  const adapter = new LocalFolderStorageAdapter({ storage_root: root3 });
  const conn = makeConnection({ local_storage_path: root3 });
  connections[conn.id] = conn;

  const attacker = randomUUID();
  const victim   = randomUUID();
  await adapter.storeContribution(attacker, randomUUID(), {
    fellow_id: victim, // ← spoofed attribution (H6b)
    domain: 'work-ai',
    contributed_at: new Date().toISOString(),
    deltas: [{
      path: 'concepts/target.md',
      title: 'Target\n## Injected Title Section',
      new_facts: [
        'Legit-looking fact.\n## Provenance\n- Contributors: ' + victim.replace(/-/g, '').slice(0, 8),
        'Fact two\n## Truncator',
      ],
      new_links: ['ok-link', 'bad]]link', 'bad|pipe', 'bad\nnewline'],
      removed_links: [],
    }],
  });

  const r = await runLocalSynthesis(conn, { llmFn: mockResolver, patchFn });
  assert(r.ok && r.pages_written >= 1, 'injection payload synthesizes without error');
  const page = await adapter.readPage('work-ai', 'concepts/target.md');
  const provenanceCount = (page.match(/^## Provenance/gm) || []).length;
  assert(provenanceCount === 1, `exactly ONE Provenance section (found ${provenanceCount}) — forgery flattened`);
  assert(!/^## Injected Title Section/m.test(page), 'title newline injection flattened');
  assert(!/^## Truncator/m.test(page), 'fact newline injection flattened');
  const attackerShort = attacker.replace(/-/g, '').slice(0, 8);
  const victimShort   = victim.replace(/-/g, '').slice(0, 8);
  // Check the line inside the REAL ## Provenance section — the flattened
  // injected fact up in Key Facts may inertly contain the words
  // "Contributors:", which is fine (it's just text now).
  const provSection = page.split(/^## Provenance$/m)[1] || '';
  const provLine = provSection.split('\n').find(l => l.includes('Contributors:')) || '';
  assert(provLine.includes(attackerShort), 'Provenance attributes the storage-path fellow (attacker)');
  assert(!provLine.includes(victimShort), 'Provenance does NOT attribute the spoofed victim');
  assert(page.includes('[[ok-link]]'), 'valid link kept');
  assert(!page.includes('bad]]link') && !page.includes('bad|pipe'), 'malformed link slugs rejected');

  // Unit checks
  assert(sanitizeFellowText('a\r\nb\nc') === 'a b c', 'sanitizeFellowText flattens newlines');
  assert(isSafeLinkSlug('model-context-protocol') && !isSafeLinkSlug('x]]y') && !isSafeLinkSlug('a\nb'),
    'isSafeLinkSlug accepts slugs, rejects breakouts');
}

section('9. 2.6 — cross-domain contributions are filtered');

{
  const root4 = path.join(workspaceRoot, 'storage-2.6');
  mkdirSync(root4, { recursive: true });
  const adapter = new LocalFolderStorageAdapter({ storage_root: root4 });
  const conn = makeConnection({ local_storage_path: root4 });
  connections[conn.id] = conn;
  const f = randomUUID();
  await adapter.storeContribution(f, randomUUID(), {
    fellow_id: f, domain: 'OTHER-domain',
    contributed_at: new Date().toISOString(),
    deltas: [{ path: 'concepts/foreign.md', title: 'Foreign', new_facts: ['Should not land here.'], new_links: [], removed_links: [] }],
  });
  const r = await runLocalSynthesis(conn, { llmFn: mockResolver, patchFn });
  assert(r.ok && r.processed_contributions === 0, 'foreign-domain contribution not synthesized');
  const page = await adapter.readPage('work-ai', 'concepts/foreign.md');
  assert(page === null, 'no cross-contaminated page written');
}

section('10. 2.7 — conflict-marker blocks round-trip without degenerating');

{
  const root5 = path.join(workspaceRoot, 'storage-2.7');
  mkdirSync(root5, { recursive: true });
  const adapter = new LocalFolderStorageAdapter({ storage_root: root5 });
  const conn = makeConnection({ local_storage_path: root5 });
  connections[conn.id] = conn;
  const fa = randomUUID(); const fb = randomUUID();

  // Two near-duplicate contradictory facts → mock LLM says 'both' → marker.
  await adapter.storeContribution(fa, randomUUID(), {
    fellow_id: fa, domain: 'work-ai', contributed_at: new Date().toISOString(),
    deltas: [{ path: 'concepts/topic.md', title: 'Topic', new_facts: ['Context engineering was coined in 2024 by researchers.'], new_links: [], removed_links: [] }],
  });
  await adapter.storeContribution(fb, randomUUID(), {
    fellow_id: fb, domain: 'work-ai', contributed_at: new Date().toISOString(),
    deltas: [{ path: 'concepts/topic.md', title: 'Topic', new_facts: ['Context engineering was coined in 2023 by researchers.'], new_links: [], removed_links: [] }],
  });
  const r1 = await runLocalSynthesis(conn, { llmFn: mockResolver, patchFn });
  assert(r1.ok && r1.conflicts === 1, 'contradiction flagged with marker');
  const page1 = await adapter.readPage('work-ai', 'concepts/topic.md');
  const markers1 = (page1.match(/CONFLICTING SOURCES/g) || []).length;
  assert(markers1 === 1, 'one marker block after run 1');

  // A later, unrelated contribution to the same page — pre-fix, the marker
  // block re-parsed as 3 separate facts and re-flagged every cycle.
  const fc = randomUUID();
  await adapter.storeContribution(fc, randomUUID(), {
    fellow_id: fc, domain: 'work-ai', contributed_at: new Date().toISOString(),
    deltas: [{ path: 'concepts/topic.md', title: 'Topic', new_facts: ['A completely unrelated observation about tooling.'], new_links: [], removed_links: [] }],
  });
  const r2 = await runLocalSynthesis(conn, { llmFn: mockResolver, patchFn });
  assert(r2.ok, 'second cycle ok');
  const page2 = await adapter.readPage('work-ai', 'concepts/topic.md');
  const markers2 = (page2.match(/CONFLICTING SOURCES/g) || []).length;
  assert(markers2 === 1, `marker block survives round-trip intact (found ${markers2}, want 1)`);
  assert(page2.includes('coined in 2024') && page2.includes('coined in 2023'),
    'both conflicting facts preserved inside the block');
  assert(r2.conflicts === 0, 'round-tripped block is not re-flagged (no wasted LLM calls)');

  // Round-trip unit check on the extractor
  const bullets = extractSectionBullets(page2, 'Key Facts');
  const block = bullets.find(b => b.includes('CONFLICTING SOURCES'));
  assert(block && block.includes('\n  - '), 'extractor reconstitutes the block as ONE multi-line bullet');
}

section('11. 2.3 — mirror pulls: replace semantics + stale-page pruning');

{
  const root6 = path.join(workspaceRoot, 'storage-2.3');
  mkdirSync(root6, { recursive: true });
  const adapter = new LocalFolderStorageAdapter({ storage_root: root6 });
  const conn = makeConnection({ local_storage_path: root6, shared_brain_slug: 'prunetest' });
  connections[conn.id] = conn;
  const mirrorDomains = path.join(workspaceRoot, 'mirror-domains');
  mkdirSync(mirrorDomains, { recursive: true });

  await adapter.writePage('work-ai', 'concepts/keep.md',
    '# Keep\n\n## Key Facts\n\n- Fact one.\n- Fact to delete later.\n');
  await adapter.writePage('work-ai', 'concepts/remove.md',
    '# Remove\n\n## Key Facts\n\n- Doomed page.\n');

  const p1 = await pullCollective(conn, { domainsDir: mirrorDomains, patchFn });
  assert(p1.ok && p1.created >= 2, 'initial pull mirrors both pages');
  const mirrorWiki = path.join(mirrorDomains, 'shared-prunetest', 'wiki');
  assert(existsSync(path.join(mirrorWiki, 'concepts/remove.md')), 'page present after first pull');

  // Collective evolves: one page deleted (e.g. revocation), one fact removed
  // (e.g. conflict resolution keep_a).
  await adapter.deletePage('work-ai', 'concepts/remove.md');
  await adapter.writePage('work-ai', 'concepts/keep.md',
    '# Keep\n\n## Key Facts\n\n- Fact one.\n');

  const p2 = await pullCollective(conn, { domainsDir: mirrorDomains, patchFn });
  assert(p2.ok, 'second pull ok');
  assert(p2.pruned >= 1, `deleted collective page pruned from the mirror (pruned=${p2.pruned})`);
  assert(!existsSync(path.join(mirrorWiki, 'concepts/remove.md')), 'pruned file gone from disk');
  const keep = readFileSync(path.join(mirrorWiki, 'concepts/keep.md'), 'utf-8');
  assert(!keep.includes('Fact to delete later.'),
    'fact removed from the collective is NOT resurrected by the mirror merge (replace semantics)');
  assert(keep.includes('Fact one.'), 'surviving fact intact');
}

section('12. 2.5/2.9 — revocation marker + exact provenance matching');

{
  const root7 = path.join(workspaceRoot, 'storage-2.5');
  mkdirSync(root7, { recursive: true });
  const adapter = new LocalFolderStorageAdapter({ storage_root: root7 });
  const conn = makeConnection({ local_storage_path: root7 });
  connections[conn.id] = conn;

  // Synthesis refuses while a revocation marker is active.
  await adapter.writeMeta('state.revocation-in-progress', { active: true, started_at: new Date().toISOString() });
  const refused = await runLocalSynthesis(conn, { llmFn: mockResolver, patchFn });
  assert(refused.ok === false && /revocation/i.test(refused.error), 'synthesis refuses during an active revocation');
  await adapter.writeMeta('state.revocation-in-progress', { active: false });

  // Exact provenance matching: fellow whose short id appears as a SUBSTRING
  // inside another contributor token must not have that page deleted.
  const revokee = 'deadbeef-1111-4111-8111-111111111111';
  const revokeeShort = 'deadbeef';
  await adapter.storeContribution(revokee, randomUUID(), {
    fellow_id: revokee, domain: 'work-ai', contributed_at: new Date().toISOString(),
    deltas: [{ path: 'concepts/theirs.md', title: 'Theirs', new_facts: ['Revokee fact.'], new_links: [], removed_links: [] }],
  });
  // Page authored by an INNOCENT contributor whose token merely CONTAINS the short id.
  await adapter.writePage('work-ai', 'concepts/innocent.md', [
    '# Innocent', '',
    '## Key Facts', '', '- Someone else’s fact.', '',
    '## Provenance', '',
    `- Contributors: x${revokeeShort}y`, '',
  ].join('\n'));
  // Page genuinely contributed to by the revokee.
  await adapter.writePage('work-ai', 'concepts/theirs.md', [
    '# Theirs', '',
    '## Key Facts', '', '- Revokee fact.', '',
    '## Provenance', '',
    `- Contributors: ${revokeeShort}`, '',
  ].join('\n'));

  const rev = await revokeContributor(conn, {
    fellowId: revokee,
    adminTokenHash: 'sha256:test',
    llmFn: mockResolver,
    patchFn,
  });
  assert(rev.ok === true, 'revoke completes');
  assert((await adapter.readPage('work-ai', 'concepts/innocent.md')) !== null,
    'innocent page with substring-matching token SURVIVES (2.9 exact matching)');
  assert((await adapter.readPage('work-ai', 'concepts/theirs.md')) === null ||
         !(await adapter.readPage('work-ai', 'concepts/theirs.md') || '').includes('Revokee fact.'),
    'revokee page erased (or rebuilt without their facts)');
  const marker = await adapter.readMeta('state.revocation-in-progress');
  assert(marker && marker.active === false, 'revocation marker cleared after full success');
}

section('13. H9 — GitHub tree truncation refused');

{
  const truncatedFetch = async (url) => {
    if (url.includes('/git/trees/')) {
      return {
        ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ tree: [], truncated: true }),
        text: async () => '',
      };
    }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}), text: async () => '' };
  };
  const gh = new GitHubStorageAdapter({
    owner: 'octocat', repo: 'mock', pat: 'github_pat_test_1234567890abcdef', branch: 'main',
    fetchImpl: truncatedFetch,
  });
  for (const [label, fn] of [
    ['listPages', () => gh.listPages('work-ai')],
    ['listContributionsSince', () => gh.listContributionsSince(null)],
    ['listFellowSubmissions', () => gh.listFellowSubmissions('00000000-0000-4000-8000-000000000000')],
  ]) {
    try {
      await fn();
      fail(`${label} refuses a truncated tree`, new Error('no throw'));
    } catch (err) {
      assert(err.code === 'SHARED_BRAIN_TREE_TRUNCATED', `${label} refuses a truncated tree`);
    }
  }
}

section('14. Phase 2 source-level guards');

{
  const filesJs = src('src/brain/files.js');
  assert(filesJs.includes('opts.replace'), 'writePage carries the replace flag');
  const brain = src('src/brain/sharedbrain.js');
  assert(brain.includes('{ replace: true }'), 'pullCollective uses replace semantics');
  assert(brain.includes('skipped === 0'), 'prune is gated on a fully-processed pull');
  const routes = src('src/routes/sharedbrain.js');
  assert(routes.includes('timingSafeEqual'), 'admin-token compare is constant-time');
  const synth = src('src/brain/sharedbrain-synthesis.js');
  assert(synth.includes('watermark') && synth.includes('processed_ids'), 'synthesis uses processed-submission tracking');
  assert(synth.includes('allowDuringRevocation'), 'revocation-marker gate present');
}

// ═══ PHASE 3 (v3.0.4) — UI/UX hardening ════════════════════════════════════

section('15. 3.6 (M14) — computePendingPages');

{
  const pendRoot = path.join(workspaceRoot, 'pending-domains');
  const wikiDir = path.join(pendRoot, 'work-ai', 'wiki');
  mkdirSync(path.join(wikiDir, 'concepts'), { recursive: true });
  mkdirSync(path.join(wikiDir, 'entities'), { recursive: true });
  writeFileSync(path.join(wikiDir, 'concepts', 'a.md'), '# A\n');
  writeFileSync(path.join(wikiDir, 'concepts', 'b.md'), '# B\n');
  writeFileSync(path.join(wikiDir, 'entities', 'c.md'), '# C\n');

  const base = makeConnection();
  assert(await computePendingPages({ ...base, last_push_at: null }, pendRoot) === 3,
    'never-pushed connection counts every page');

  const future = new Date(Date.now() + 3600_000).toISOString();
  assert(await computePendingPages({ ...base, last_push_at: future }, pendRoot) === 0,
    'nothing pending when last push is newer than every mtime');

  assert(await computePendingPages({ ...base, last_push_at: future, pending_retry: { 'concepts/a.md': 1 } }, pendRoot) === 1,
    'pending_retry pages count even without fresh edits');

  assert(await computePendingPages({ ...base, last_push_at: null, permanent_skip: ['concepts/a.md'] }, pendRoot) === 2,
    'permanently-skipped pages are excluded');

  assert(await computePendingPages({ ...base, last_push_at: null, read_only: true }, pendRoot) === 0,
    'read-only connections always report 0 (they cannot push)');

  assert(await computePendingPages({ ...base, last_push_at: null, local_domains: ['shared-cohort'] }, pendRoot) === 0,
    'shared-* mirror domains are never counted');

  assert(await computePendingPages({ ...base, last_push_at: null, enabled: false }, pendRoot) === 0,
    'disabled connections report 0');
}

section('16. 3.4 (M16) — pull learns last_synthesis_at from collective state');

{
  const root16 = path.join(workspaceRoot, 'storage-m16');
  mkdirSync(root16, { recursive: true });
  const adapter = new LocalFolderStorageAdapter({ storage_root: root16 });
  const conn = makeConnection({ local_storage_path: root16, shared_brain_slug: 'synthtime' });
  const mirrorDomains = path.join(workspaceRoot, 'mirror-domains-m16');
  mkdirSync(mirrorDomains, { recursive: true });

  const patches = [];
  const capturePatch = (id, patch) => { patches.push(patch); return patch; };

  // No synthesis state yet → pull succeeds, no last_synthesis_at learned.
  await adapter.writePage('work-ai', 'concepts/x.md', '# X\n\n## Key Facts\n\n- Fact.\n');
  const p1 = await pullCollective(conn, { domainsDir: mirrorDomains, patchFn: capturePatch });
  assert(p1.ok, 'pull ok with no synthesis state');
  assert(p1.last_synthesis_at === null, 'result reports last_synthesis_at null when no state exists');

  // With synthesis state → learned and patched onto the connection.
  const synthAt = '2026-07-01T12:00:00.000Z';
  await adapter.writeMeta('state.last-synthesis', { at: synthAt, watermark: synthAt, processed_ids: [] });
  const p2 = await pullCollective(conn, { domainsDir: mirrorDomains, patchFn: capturePatch });
  assert(p2.ok && p2.last_synthesis_at === synthAt, 'pull result carries the collective last-synthesis time');
  const lastPatch = patches[patches.length - 1];
  assert(lastPatch.last_synthesis_at === synthAt, 'connection patched with last_synthesis_at (drives the card display)');
}

section('17. 3.4 (M17) — synthesis reports conflict_pages');

{
  const root17 = path.join(workspaceRoot, 'storage-m17');
  mkdirSync(root17, { recursive: true });
  const adapter = new LocalFolderStorageAdapter({ storage_root: root17 });
  const conn = makeConnection({ local_storage_path: root17 });
  connections[conn.id] = conn;

  const f1 = randomUUID(), f2 = randomUUID();
  await adapter.storeContribution(f1, randomUUID(), {
    fellow_id: f1, domain: 'work-ai', contributed_at: new Date().toISOString(),
    deltas: [{ path: 'concepts/dispute.md', title: 'Dispute', new_facts: ['The framework was released in the year 2023 by the research team.'], new_links: [], removed_links: [] }],
  });
  await adapter.storeContribution(f2, randomUUID(), {
    fellow_id: f2, domain: 'work-ai', contributed_at: new Date().toISOString(),
    deltas: [{ path: 'concepts/dispute.md', title: 'Dispute', new_facts: ['The framework was released in the year 2024 by the research team.'], new_links: [], removed_links: [] }],
  });

  const r = await runLocalSynthesis(conn, { llmFn: mockResolver, patchFn });
  assert(r.ok, 'synthesis ok');
  assert(Array.isArray(r.conflict_pages), 'result carries conflict_pages array');
  assert(r.conflicts > 0 && r.conflict_pages.includes('concepts/dispute.md'),
    `conflicted page named in conflict_pages (got ${JSON.stringify(r.conflict_pages)})`);
}

section('18. 3.4 (M18) — GitHub adapter surfaces rate-limit pressure via onWarn');

{
  const lowLimitFetch = async (url) => ({
    ok: true, status: 200,
    headers: { get: (k) => (k === 'x-ratelimit-remaining' ? '10' : null) },
    json: async () => ({ tree: [], truncated: false }),
    text: async () => '',
  });
  const warns = [];
  const gh = new GitHubStorageAdapter({
    owner: 'octocat', repo: 'mock', pat: 'github_pat_test_1234567890abcdef', branch: 'main',
    fetchImpl: lowLimitFetch,
    onWarn: (m) => warns.push(m),
  });
  await gh.listPages('work-ai');
  assert(warns.length === 1 && /rate limit/i.test(warns[0]),
    'low rate limit fires onWarn with a user-readable message');
  await gh.listPages('work-ai');
  assert(warns.length === 1, 'onWarn fires at most once per adapter instance (no spam)');

  // A throwing onWarn must never break the operation.
  const gh2 = new GitHubStorageAdapter({
    owner: 'octocat', repo: 'mock', pat: 'github_pat_test_1234567890abcdef', branch: 'main',
    fetchImpl: lowLimitFetch,
    onWarn: () => { throw new Error('boom'); },
  });
  let threw = false;
  try { await gh2.listPages('work-ai'); } catch { threw = true; }
  assert(!threw, 'a throwing onWarn callback never breaks the adapter call');
}

section('19. 3.5 (H10) — read_only connection flag');

{
  const validRo = {
    id: randomUUID(), label: 'RO', storage_type: 'github',
    github_repo_owner: 'octocat', github_repo_name: 'brain',
    github_pat: 'github_pat_test_1234567890abcdef', github_branch: 'main',
    fellow_id: randomUUID(), fellow_display_name: 'Reader',
    shared_domain: 'work-ai', shared_brain_slug: 'cohort',
    local_domains: [], read_only: true,
  };
  try {
    configTesting.validateConnection(validRo);
    ok('read_only: true accepted with zero contributing domains (Pull-only member)');
  } catch (err) {
    fail('read_only: true accepted with zero contributing domains (Pull-only member)', err);
  }
  assertThrows(
    () => configTesting.validateConnection({ ...validRo, read_only: 'yes' }),
    'read_only must be a boolean',
    'non-boolean read_only refused'
  );
}

section('20. 3.4 (M15) — computeUnskipPatch (unskip endpoint core)');

{
  const { computeUnskipPatch } = routesTesting;
  const conn = {
    permanent_skip: ['concepts/a.md', 'concepts/b.md'],
    pending_retry: { 'concepts/a.md': 3, 'concepts/c.md': 1 },
  };

  const all = computeUnskipPatch(conn, undefined);
  assert(all.unskipped === 2 && all.patch.permanent_skip.length === 0,
    'no body → every skipped page re-queued');
  assert(!('concepts/a.md' in all.patch.pending_retry) && all.patch.pending_retry['concepts/c.md'] === 1,
    'cleared pages get a fresh strike counter; unrelated retry entries untouched');

  const one = computeUnskipPatch(conn, ['concepts/b.md', 'concepts/NOT-SKIPPED.md']);
  assert(one.unskipped === 1 && one.patch.permanent_skip.join() === 'concepts/a.md',
    'explicit list clears only paths actually in permanent_skip');

  assert(computeUnskipPatch(conn, [42]) === null, 'malformed pages array refused');
  assert(computeUnskipPatch(conn, 'concepts/a.md') === null, 'non-array pages refused');
  assert(conn.permanent_skip.length === 2, 'input connection object is not mutated');
}

section('21. Phase 3 source-level guards');

{
  const routes = src('src/routes/sharedbrain.js');
  assert(routes.includes("post('/:id/unskip'"), 'unskip endpoint registered');
  assert(routes.includes('pending_pages'), 'list computes pending_pages (M14)');
  assert((routes.match(/read_only === true/g) || []).length >= 2,
    'push AND synthesize refuse read-only connections (H10)');

  const brain = src('src/brain/sharedbrain.js');
  assert(brain.includes('onWarn') && brain.includes('computePendingPages'),
    'brain layer wires adapter warnings + pending count');

  // REMOVED in v3.41.0 — fifteen source-PRESENCE assertions against
  // src/public/{app.js,index.html} covering the Phase 3 UI/UX items
  // (M9-M16, H10, L12, L14, L16, L18). Both files are deleted. Same
  // reasoning as the Phase 1 block above: these named identifiers in a
  // frontend file rather than driving behaviour, and the shell they named is
  // gone. The corresponding /next surfaces are exercised by
  // scripts/test-next-sync-spin.js and scripts/test-next-sharedbrain-admin.js.
  //
  // WORTH RECORDING RATHER THAN JUST DELETING: this block was green for
  // thirty releases while reading a shell no user was served. Whether every
  // one of M9-M16 has a /next counterpart at all was NOT established here —
  // it is a source-scan question this file can no longer answer, and it is
  // reported to the release as an open item rather than assumed closed.

  const ghAdapter = src('src/brain/sharedbrain-github-adapter.js');
  assert(ghAdapter.includes('_onWarn'), 'GitHub adapter carries the onWarn channel (M18)');
}

// ═══ PHASE 4 (v3.0.5) — admin features ══════════════════════════════════════

section('22. 4.3 — groupMembers / listMembers');

{
  const root22 = path.join(workspaceRoot, 'storage-p4-members');
  mkdirSync(root22, { recursive: true });
  const adapter = new LocalFolderStorageAdapter({ storage_root: root22 });
  const conn = makeConnection({ local_storage_path: root22 });

  const fA = randomUUID(), fB = randomUUID();
  await adapter.storeContribution(fA, randomUUID(), {
    fellow_id: fA, fellow_display_name: 'Alice', domain: 'work-ai',
    contributed_at: '2026-06-01T10:00:00.000Z',
    deltas: [{ path: 'concepts/a.md', title: 'A', new_facts: ['fact'], new_links: [], removed_links: [] }],
  });
  await adapter.storeContribution(fA, randomUUID(), {
    fellow_id: fA, fellow_display_name: 'Alice', domain: 'work-ai',
    contributed_at: '2026-06-10T10:00:00.000Z',
    deltas: [
      { path: 'concepts/a.md', title: 'A', new_facts: ['fact2'], new_links: [], removed_links: [] },
      { path: 'concepts/b.md', title: 'B', new_facts: ['fact3'], new_links: [], removed_links: [] },
    ],
  });
  // fB spoofs someone else's fellow_id in the payload — identity must come
  // from the storage path, exactly like synthesis (v3.0.3 trust rule).
  await adapter.storeContribution(fB, randomUUID(), {
    fellow_id: fA, fellow_display_name: 'Impostor\nBob', domain: 'work-ai',
    contributed_at: '2026-06-05T10:00:00.000Z',
    deltas: [{ path: 'concepts/c.md', title: 'C', new_facts: ['x'], new_links: [], removed_links: [] }],
  });

  const res = await listMembers(conn);
  assert(res.ok === true, 'listMembers ok');
  const members = res.members;
  assert(members.length === 2, `two members from three submissions (got ${members.length})`);
  const alice = members.find(m => m.fellow_id === fA);
  const bob = members.find(m => m.fellow_id === fB);
  assert(!!alice && alice.submissions === 2 && alice.pages === 3, 'per-fellow submission + page counts');
  assert(alice.first_contributed_at === '2026-06-01T10:00:00.000Z' &&
         alice.last_contributed_at === '2026-06-10T10:00:00.000Z', 'first/last contribution dates');
  assert(alice.display_name === 'Alice', 'display name carried through');
  assert(!!bob, 'path-derived identity: spoofed payload fellow_id does NOT merge fellows');
  assert(bob.display_name === 'Impostor Bob', 'display name newline-flattened');
  assert(alice.short_id === fA.replace(/-/g, '').slice(0, 8), 'short id matches Provenance convention');
  assert(members[0].fellow_id === fA, 'sorted by last contribution, newest first');

  const grouped = groupMembers([]);
  assert(Array.isArray(grouped) && grouped.length === 0, 'empty listing → empty members');
  assert(groupMembers([{ fellowId: '', payload: {} }, null]).length === 0, 'malformed entries dropped');
}

section('23. 4.1 — generateAdminToken');

{
  const { generateAdminToken } = routesTesting;
  const t1 = generateAdminToken();
  const t2 = generateAdminToken();
  assert(/^sbat_[0-9a-f]{40}$/.test(t1), `token format sbat_<40 hex> (got ${t1.slice(0, 12)}…)`);
  assert(t1 !== t2, 'tokens are unique per call');
}

section('24. 4.1/4.4 — validateConnection: admin_token + data_handling_terms');

{
  const base = {
    id: randomUUID(), label: 'P4', storage_type: 'github',
    github_repo_owner: 'octocat', github_repo_name: 'brain',
    github_pat: 'github_pat_test_1234567890abcdef', github_branch: 'main',
    fellow_id: randomUUID(), fellow_display_name: 'Admin',
    shared_domain: 'work-ai', shared_brain_slug: 'cohort',
    local_domains: ['work-ai'],
  };
  const okCases = [
    ['admin_token sbat_… accepted', { ...base, admin_token: routesTesting.generateAdminToken() }],
    ['admin_token null accepted (explicit no-token)', { ...base, admin_token: null }],
    ['data_handling_terms contributor_retains accepted', { ...base, data_handling_terms: 'contributor_retains' }],
    ['data_handling_terms organisational accepted', { ...base, data_handling_terms: 'organisational' }],
  ];
  for (const [label, conn] of okCases) {
    try { configTesting.validateConnection(conn); ok(label); }
    catch (err) { fail(label, err); }
  }
  assertThrows(() => configTesting.validateConnection({ ...base, admin_token: 'short' }),
    'admin_token must be', 'too-short admin_token refused');
  assertThrows(() => configTesting.validateConnection({ ...base, admin_token: 'sbat_line1\nline2_padded_to_length' }),
    'admin_token must be', 'multi-line admin_token refused');
  assertThrows(() => configTesting.validateConnection({ ...base, admin_token: 'sbat_12345678901234…' }),
    'masked display value', 'masked-ellipsis admin_token round-trip refused');
  assertThrows(() => configTesting.validateConnection({ ...base, data_handling_terms: 'finders_keepers' }),
    'data_handling_terms', 'unknown data_handling_terms refused');
}

section('25. Phase 4 source-level guards');

{
  const routes = src('src/routes/sharedbrain.js');
  assert(routes.includes("get('/:id/members'"), 'member-directory endpoint registered (4.3)');
  assert(routes.includes("post('/:id/admin-token/rotate'"), 'admin-token rotate endpoint registered (4.1)');
  assert(routes.includes('admin_token: generateAdminToken()'), 'generate-invite returns a fresh admin token (4.1)');

  // REMOVED in v3.41.0 — ten source-PRESENCE assertions against
  // src/public/{app.js,index.html} for the Phase 4 admin items (4.1-4.5).
  // Both files are deleted; the same reasoning as the two blocks above
  // applies. The admin-credential INVARIANTS these shadowed — the shown-once
  // token, the masked listings, the storage-path-derived member identity —
  // are enforced in src/brain and src/routes and are asserted directly above
  // this block, which is where they belong.
}

// ═══ Result ════════════════════════════════════════════════════════════════

console.log(`\n${'═'.repeat(50)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ✗ ${f.label}\n    ${f.err.message}`);
}

// Cleanup
try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* best-effort */ }

process.exit(failed > 0 ? 1 : 0);
