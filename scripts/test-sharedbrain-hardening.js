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

import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

import { LocalFolderStorageAdapter } from '../src/brain/sharedbrain-local-adapter.js';
import { runLocalSynthesis, mergeFactsForPage } from '../src/brain/sharedbrain-synthesis.js';
import { pushDomain, isTransientLlmError, MAX_RETRY_ATTEMPTS } from '../src/brain/sharedbrain.js';
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

  const appJs = src('src/public/app.js');
  assert(appJs.includes('readonlyDomains.includes(d)'), 'ingest dropdown filters readonly mirrors');
  assert(appJs.includes('sharedbrain:${connId}') || appJs.includes('`sharedbrain:'),
    'Shared Brain ops register through the busy-state gate');

  const indexHtml = src('src/public/index.html');
  assert(indexHtml.includes('settings-sharedbrain-enabled'), 'Settings hosts the Shared Brain enable state');
  const syncTab = indexHtml.slice(indexHtml.indexOf('id="tab-sync"'), indexHtml.indexOf('id="tab-settings"'));
  assert(!syncTab.includes('sharedbrain-enable-btn'), 'the enable button no longer lives in the Sync tab');
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
