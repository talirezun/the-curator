#!/usr/bin/env node
/**
 * Shared Brain — Phase 4F Battle Test (revoke orchestration)
 *
 * Verifies GDPR Article 17 ("right to erasure") properties end-to-end
 * using LocalFolderStorageAdapter (no network):
 *
 *   1. Fellow A and Fellow B push contributions; synthesis runs.
 *   2. Revoke Fellow A.
 *   3. Assertions on final state:
 *      - All of A's contributions/<fellowA>/*.json deleted
 *      - A's digest deleted
 *      - Pages where ONLY A contributed are deleted (e.g. entities/a-only.md)
 *      - Pages where A+B contributed get rebuilt; A's facts no longer present
 *        in unifiedFacts; A's short ID no longer in Provenance
 *      - Pages where ONLY B contributed are untouched
 *      - state/revocations.jsonl gained one record with the revocation
 *      - state.last-synthesis reflects the post-revoke synthesis
 *   4. Token-leak audit: full PAT / admin_token text never appears in any
 *      thrown error or stderr output during the revoke.
 *
 * Run with:  node scripts/test-sharedbrain-revoke.js
 */

import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

import { LocalFolderStorageAdapter } from '../src/brain/sharedbrain-local-adapter.js';
import { revokeContributor, hashAdminToken, __testing as revokeT } from '../src/brain/sharedbrain-revoke.js';
import { runLocalSynthesis } from '../src/brain/sharedbrain-synthesis.js';

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

// ── Workspace ───────────────────────────────────────────────────────────

const workspaceRoot = mkdtempSync(path.join(tmpdir(), 'sharedbrain-4f-'));
console.log(`Phase 4F workspace: ${workspaceRoot}`);

const storageRoot = path.join(workspaceRoot, 'shared-storage');
mkdirSync(storageRoot, { recursive: true });

const fellowA = randomUUID();
const fellowB = randomUUID();

const connection = {
  id: randomUUID(),
  label: 'Phase 4F Revoke Test',
  storage_type: 'local',
  local_storage_path: storageRoot,
  fellow_id: fellowA, // doesn't actually matter for this test
  fellow_display_name: 'Test Operator',
  shared_domain: 'work-ai',
  shared_brain_slug: 'phase-4f',
  local_domains: ['unused'],
  attribute_by_name: false,
  enabled: true,
  admin_token: 'SECRET_ADMIN_TOKEN_DO_NOT_LEAK_xyz123',
};

// Mock LLM — always picks "both" if asked (matches Phase 3 live test pattern).
const mockLLM = async () => JSON.stringify({ resolution: 'both', result: [] });
const noopPatch = () => null;

// ── Step 1: scaffold initial state ──────────────────────────────────────

section('Setup: push two fellows, synthesize');

const adapter = new LocalFolderStorageAdapter({ storage_root: storageRoot });

// A contributes to two pages (a-only.md and shared.md); B contributes to
// two pages (shared.md and b-only.md). After synthesis:
//   - entities/a-only.md   → has only A's facts; revoke must delete this
//   - entities/shared.md   → has A+B facts; revoke must rebuild without A
//   - entities/b-only.md   → has only B's facts; revoke must NOT touch this

const subA1 = randomUUID();
const subB1 = randomUUID();

await adapter.storeContribution(fellowA, subA1, {
  submission_id: subA1,
  fellow_id: fellowA,
  fellow_display_name: 'Fellow A',
  domain: 'work-ai',
  contributed_at: '2026-05-14T10:00:00Z',
  deltas: [
    {
      path: 'entities/a-only.md',
      type: 'entity',
      title: 'A-only Entity',
      new_facts: ['Fact authored by Fellow A only.'],
      new_links: [], removed_links: [],
    },
    {
      path: 'entities/shared.md',
      type: 'entity',
      title: 'Shared Entity',
      new_facts: ['Fact about shared entity from fellow A.'],
      new_links: [], removed_links: [],
    },
  ],
});

await adapter.storeContribution(fellowB, subB1, {
  submission_id: subB1,
  fellow_id: fellowB,
  fellow_display_name: 'Fellow B',
  domain: 'work-ai',
  contributed_at: '2026-05-14T11:00:00Z',
  deltas: [
    {
      path: 'entities/shared.md',
      type: 'entity',
      title: 'Shared Entity',
      new_facts: ['Fact about shared entity from fellow B.'],
      new_links: [], removed_links: [],
    },
    {
      path: 'entities/b-only.md',
      type: 'entity',
      title: 'B-only Entity',
      new_facts: ['Fact authored by Fellow B only.'],
      new_links: [], removed_links: [],
    },
  ],
});

// Set state.last-synthesis to epoch so synthesis processes both contributions
await adapter.writeMeta('state.last-synthesis', { at: new Date(0).toISOString(), run_number: 0 });

const initialSynth = await runLocalSynthesis(connection, {
  llmFn: mockLLM,
  patchFn: noopPatch,
});
assertEq(initialSynth.ok, true, 'initial synthesis succeeded');
assert(initialSynth.pages_written >= 3, `initial synthesis wrote ≥3 pages (got ${initialSynth.pages_written})`);

// Verify the three pages exist
const initialPaths = (await adapter.listPages('work-ai')).sort();
assert(initialPaths.includes('entities/a-only.md'), 'a-only.md exists pre-revoke');
assert(initialPaths.includes('entities/shared.md'), 'shared.md exists pre-revoke');
assert(initialPaths.includes('entities/b-only.md'), 'b-only.md exists pre-revoke');
console.log(`    Pre-revoke pages: ${initialPaths.join(', ')}`);

// Verify A's contribution + digest exist
assert(await adapter.contributionExists(fellowA, subA1), 'A contribution exists pre-revoke');
await adapter.storeDigest(fellowA, { version: 1 });
const digestBefore = await adapter.loadDigest(fellowA);
assert(digestBefore !== null, 'A digest exists pre-revoke');

// Capture the shared page content for later comparison
const sharedBefore = await adapter.readPage('work-ai', 'entities/shared.md');
const aShortId = revokeT.shortenFellowId(fellowA);
assert(sharedBefore.includes(aShortId), `shared.md Provenance pre-revoke contains A's short id "${aShortId}"`);

// ── Step 2: run the revocation ──────────────────────────────────────────

section('Revoke: token-leak-aware execution');

const originalErr = console.error;
const stderrCaptured = [];
console.error = (...args) => stderrCaptured.push(args.join(' '));

const adminTokenHash = hashAdminToken(connection.admin_token);
const result = await revokeContributor(connection, {
  fellowId: fellowA,
  adminTokenHash,
  llmFn: mockLLM,
  patchFn: noopPatch,
});

console.error = originalErr;

assertEq(result.ok, true, 'revoke returned ok: true');
assert(result.contributions_deleted >= 1,
  `revoke deleted at least 1 contribution (got ${result.contributions_deleted})`);
assert(result.pages_deleted >= 1,
  `revoke deleted at least 1 collective page (got ${result.pages_deleted})`);
assert(typeof result.audit_record === 'object',
  'revoke returned audit_record object');

// ── Step 3: GDPR Article 17 properties ──────────────────────────────────

section('Post-revoke: A is gone, B is intact, audit recorded');

// A's contribution gone
assert(!(await adapter.contributionExists(fellowA, subA1)),
  'A contribution deleted from contributions/');
// A's digest gone
const digestAfter = await adapter.loadDigest(fellowA);
assertEq(digestAfter, null, 'A digest deleted');

// a-only.md gone (no remaining contributors)
const finalPaths = (await adapter.listPages('work-ai')).sort();
console.log(`    Post-revoke pages: ${finalPaths.join(', ')}`);
assert(!finalPaths.includes('entities/a-only.md'),
  'a-only.md deleted (no remaining contributors)');

// b-only.md retained
assert(finalPaths.includes('entities/b-only.md'),
  'b-only.md still present (B is not revoked)');

// shared.md still exists but no longer mentions A
assert(finalPaths.includes('entities/shared.md'),
  'shared.md re-built (B still contributes to it)');
const sharedAfter = await adapter.readPage('work-ai', 'entities/shared.md');
assert(!sharedAfter.includes(aShortId),
  `shared.md Provenance no longer contains A's short id "${aShortId}"`);
const bShortId = revokeT.shortenFellowId(fellowB);
assert(sharedAfter.includes(bShortId),
  `shared.md Provenance still contains B's short id "${bShortId}"`);
// A's specific fact should no longer appear
assert(!sharedAfter.includes('Fact about shared entity from fellow A.'),
  'shared.md no longer contains the fact authored by A');
// B's fact should still appear
assert(sharedAfter.includes('Fact about shared entity from fellow B.'),
  'shared.md still contains the fact authored by B');

// b-only page untouched (contains B's facts)
const bOnlyAfter = await adapter.readPage('work-ai', 'entities/b-only.md');
assert(bOnlyAfter && bOnlyAfter.includes('Fact authored by Fellow B only.'),
  'b-only.md content intact');

// state/revocations.jsonl exists with the right record
const auditPath = path.join(storageRoot, 'state', 'revocations.jsonl');
assert(existsSync(auditPath), 'revocations.jsonl was created');
const auditLines = readFileSync(auditPath, 'utf-8').trim().split('\n').filter(Boolean);
assertEq(auditLines.length, 1, 'revocations.jsonl has exactly one record');
const auditEntry = JSON.parse(auditLines[0]);
assertEq(auditEntry.fellow_id, fellowA, 'audit entry has correct fellow_id');
assert(typeof auditEntry.revoked_at === 'string' && auditEntry.revoked_at.startsWith('20'),
  'audit entry has ISO timestamp');
assert(auditEntry.by_admin_token_hash && auditEntry.by_admin_token_hash.startsWith('sha256:'),
  'audit entry has sha256-prefixed admin token hash');
assert(typeof auditEntry.contributions_deleted === 'number',
  'audit entry has contributions_deleted count');

// state.last-synthesis updated to a real timestamp (not epoch)
const lastSynth = await adapter.readMeta('state.last-synthesis');
assert(lastSynth && lastSynth.at && new Date(lastSynth.at).getTime() > 0,
  'state.last-synthesis updated to a non-epoch timestamp');

// ── Step 4: token-leak audit ────────────────────────────────────────────

section('Token-leak audit: admin token NEVER appears in stderr or audit log');

const fullStderr = stderrCaptured.join('\n');
const fullAudit = readFileSync(auditPath, 'utf-8');
assert(!fullStderr.includes(connection.admin_token),
  'admin token does not appear in captured stderr');
assert(!fullAudit.includes(connection.admin_token),
  'admin token does not appear in audit log');
// Even the first 12 chars should be absent — defense against truncation leaks
assert(!fullStderr.includes(connection.admin_token.slice(0, 12)),
  'first 12 chars of admin token never appear in stderr');

// ── Step 5: idempotency — re-revoke of same fellow should be safe ───────

section('Idempotency: revoking the same fellow twice does not error');

const result2 = await revokeContributor(connection, {
  fellowId: fellowA,
  adminTokenHash,
  llmFn: mockLLM,
  patchFn: noopPatch,
});
assertEq(result2.ok, true, 'second revoke returns ok: true even when nothing remains');
assertEq(result2.contributions_deleted, 0, 'second revoke finds no contributions to delete');

const auditLines2 = readFileSync(auditPath, 'utf-8').trim().split('\n').filter(Boolean);
assertEq(auditLines2.length, 2, 'audit log gained a second entry (records every attempt)');

// ── Step 6: validation — bad inputs rejected ────────────────────────────

section('Validation: revoke rejects malformed input');

const badInputs = [
  { args: { fellowId: 'not-a-uuid' }, label: 'rejects non-UUID fellowId' },
  { args: { fellowId: '' },           label: 'rejects empty fellowId' },
  { args: {},                          label: 'rejects missing fellowId' },
];
for (const { args, label } of badInputs) {
  const r = await revokeContributor(connection, args);
  assertEq(r.ok, false, label);
}

const r = await revokeContributor({}, { fellowId: randomUUID() });
assertEq(r.ok, false, 'rejects connection without shared_domain');

// ════════════════════════════════════════════════════════════════════════
// v3.6.2 — SELF-REPORTING ERASURE
//
// Everything above proves the HAPPY path. These sections prove the failure
// path, which is the one that matters: before v3.6.2 every per-file delete
// failure was a bare console.error and the run still reported
// "Revocation complete" — an admin could certify a GDPR Article 17 erasure
// to a data subject while their data was still in shared storage.
//
// The deletes below are made to fail GENUINELY (a real EACCES from the real
// filesystem through the real adapter), not by asserting on a stub that
// never touched the erasure path.
// ════════════════════════════════════════════════════════════════════════

const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
const scratchDirs = [];

/** Build an isolated brain with one fellow's contribution already synthesised. */
async function makeBrain(tag) {
  const root = mkdtempSync(path.join(tmpdir(), `sharedbrain-${tag}-`));
  scratchDirs.push(root);
  const store = path.join(root, 'shared-storage');
  mkdirSync(store, { recursive: true });
  const fid = randomUUID();
  const sub = randomUUID();
  const ad = new LocalFolderStorageAdapter({ storage_root: store });
  const conn = {
    ...connection,
    id: randomUUID(),
    local_storage_path: store,
    fellow_id: fid,
    github_pat: 'github_pat_TESTONLY_SHOULD_NEVER_APPEAR_0123456789',
  };
  await ad.storeContribution(fid, sub, {
    submission_id: sub, fellow_id: fid, fellow_display_name: 'Fellow C',
    domain: 'work-ai', contributed_at: '2026-05-14T10:00:00Z',
    deltas: [{
      path: 'entities/c-only.md', type: 'entity', title: 'C-only Entity',
      new_facts: ['Fact authored by Fellow C only.'], new_links: [], removed_links: [],
    }],
  });
  await ad.storeDigest(fid, { version: 1 });
  await ad.writeMeta('state.last-synthesis', { at: new Date(0).toISOString(), run_number: 0 });
  await runLocalSynthesis(conn, { llmFn: mockLLM, patchFn: noopPatch });
  return { root, store, fid, sub, ad, conn };
}

/** Wrap a real adapter, overriding one method. Everything else stays real. */
function withOverride(realAdapter, method, impl) {
  return new Proxy(realAdapter, {
    get(t, prop, recv) {
      if (prop === method) return impl;
      const v = Reflect.get(t, prop, recv);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

function quietErrors(fn) {
  const orig = console.error;
  const lines = [];
  console.error = (...a) => lines.push(a.join(' '));
  return fn().finally(() => { console.error = orig; }).then(r => ({ r, lines }));
}

// ── §7: a contribution delete that GENUINELY fails (real EACCES) ─────────

section('§7 Failing contribution delete is REPORTED, not swallowed');

if (IS_ROOT) {
  console.log('  ⏭  running as root — chmod cannot deny unlink; §7 permission case not exercised');
} else {
  const b = await makeBrain('fail-contrib');
  const contribDir = path.join(b.store, 'contributions', b.fid);
  // r-x: readdir/stat still work (so listFellowSubmissions finds the file),
  // but unlink inside the directory fails with EACCES. A real failure.
  chmodSync(contribDir, 0o500);

  const { r: res7 } = await quietErrors(() => revokeContributor(b.conn, {
    fellowId: b.fid, adminTokenHash: hashAdminToken(b.conn.admin_token),
    llmFn: mockLLM, patchFn: noopPatch,
  }));

  chmodSync(contribDir, 0o700); // restore before any assertion can throw out

  assert(existsSync(path.join(contribDir, `${b.sub}.json`)),
    '§7 precondition: the contribution really did survive (the delete genuinely failed)');
  assertEq(res7.ok, false, '§7 revoke reports ok:false when a contribution delete fails');
  assertEq(res7.erasure_complete, false, '§7 erasure_complete is false');
  assert(Array.isArray(res7.contributions_failed) && res7.contributions_failed.length === 1,
    `§7 contributions_failed lists the failure (got ${JSON.stringify(res7.contributions_failed)})`);
  const cf7 = (res7.contributions_failed || [])[0] || {};
  assertEq(cf7.submission_id, b.sub, '§7 the failure names the submission id');
  assert(typeof cf7.error === 'string' && cf7.error.length > 0,
    '§7 the failure carries a reason string');
  assertEq(res7.contributions_deleted, 0, '§7 contributions_deleted does NOT count the failure');

  // The whole point: the message must not read as a completed erasure.
  assert(!/Revocation complete/i.test(res7.summary),
    '§7 summary does NOT say "Revocation complete"');
  assert(/ERASURE INCOMPLETE/i.test(res7.summary),
    '§7 summary says the erasure is INCOMPLETE');
  assert(/re-run/i.test(res7.summary), '§7 summary carries re-run guidance');
  assertEq(res7.summary, res7.error, '§7 summary and error agree (no two wordings to drift)');

  // Marker must stay set so synthesis stays blocked and the admin must act.
  assertEq(res7.marker_cleared, false, '§7 the in-progress marker was NOT cleared');
  const marker7 = await b.ad.readMeta('state.revocation-in-progress');
  assertEq(marker7 && marker7.active, true, '§7 marker is still active on disk (synthesis stays blocked)');

  // Audit trail must record the failure, as counts only.
  const auditLine7 = JSON.parse(
    readFileSync(path.join(b.store, 'state', 'revocations.jsonl'), 'utf-8').trim().split('\n').pop());
  assertEq(auditLine7.erasure_complete, false, '§7 audit record says erasure_complete:false');
  assertEq(auditLine7.contributions_failed, 1, '§7 audit record counts the failed contribution');
  assert(typeof auditLine7.contributions_failed === 'number',
    '§7 audit records a COUNT, not an error string (no provider text in the permanent log)');
}

// ── §8: a page delete that GENUINELY fails (real EACCES) ─────────────────

section('§8 Failing collective-page delete is REPORTED');

if (IS_ROOT) {
  console.log('  ⏭  running as root — §8 permission case not exercised');
} else {
  const b = await makeBrain('fail-page');
  const entDir = path.join(b.store, 'collective', 'work-ai', 'wiki', 'entities');
  chmodSync(entDir, 0o500);

  const { r: res8 } = await quietErrors(() => revokeContributor(b.conn, {
    fellowId: b.fid, adminTokenHash: hashAdminToken(b.conn.admin_token),
    llmFn: mockLLM, patchFn: noopPatch,
  }));

  chmodSync(entDir, 0o700);

  assert(existsSync(path.join(entDir, 'c-only.md')),
    '§8 precondition: the page really did survive (the delete genuinely failed)');
  assertEq(res8.ok, false, '§8 revoke reports ok:false when a page delete fails');
  assertEq(res8.erasure_complete, false, '§8 erasure_complete is false');
  const pf8 = res8.pages_failed || [];
  assert(pf8.length === 1 && pf8[0] && pf8[0].path === 'entities/c-only.md',
    `§8 pages_failed names the page (got ${JSON.stringify(res8.pages_failed)})`);
  assertEq(res8.pages_deleted, 0, '§8 pages_deleted does NOT count the failure');
  assert(!/Revocation complete/i.test(res8.summary), '§8 summary does NOT say "Revocation complete"');
  assertEq(res8.marker_cleared, false, '§8 marker NOT cleared');
}

// ── §9: listPages failure ABORTS — the tree-truncation class ─────────────
//
// GitHubStorageAdapter.listPages throws SHARED_BRAIN_TREE_TRUNCATED
// precisely so revoke cannot report a complete erasure over a partial
// listing. Before v3.6.2 revoke caught that throw with `.catch(() => [])`:
// zero pages scanned, rebuild run, marker cleared, "Revocation complete".

section('§9 An unreadable page list ABORTS instead of erasing nothing quietly');

{
  const b = await makeBrain('trunc');
  const truncErr = Object.assign(
    new Error('listPages: GitHub returned a TRUNCATED tree listing for this repo'),
    { code: 'SHARED_BRAIN_TREE_TRUNCATED' });
  const stub = withOverride(b.ad, 'listPages', async () => { throw truncErr; });

  let synthesisRan = false;
  const { r: res9 } = await quietErrors(() => revokeContributor(b.conn, {
    fellowId: b.fid, adminTokenHash: hashAdminToken(b.conn.admin_token),
    adapter: stub,
    llmFn: async (...a) => { synthesisRan = true; return mockLLM(...a); },
    patchFn: noopPatch,
  }));

  assertEq(res9.ok, false, '§9 a truncated/failed page listing makes the revoke fail');
  assertEq(res9.erasure_complete, false, '§9 erasure_complete is false');
  assert(/ABORTED/i.test(res9.summary), '§9 summary says the erasure was ABORTED');
  assert(/INCOMPLETE/i.test(res9.summary), '§9 summary says the erasure is INCOMPLETE');
  assert(!/Revocation complete/i.test(res9.summary), '§9 summary does NOT say "Revocation complete"');
  assertEq(res9.pages_deleted, 0, '§9 no page was deleted');
  assertEq(res9.marker_cleared, false, '§9 marker NOT cleared — synthesis stays blocked');
  const marker9 = await b.ad.readMeta('state.revocation-in-progress');
  assertEq(marker9 && marker9.active, true, '§9 marker still active on disk');
  // The abort must happen BEFORE the rebuild — rebuilding over a collective
  // we never scanned is what made the old bug look like a success.
  assertEq(synthesisRan, false, '§9 the rebuild synthesis did NOT run after the abort');
  assert(existsSync(path.join(b.store, 'collective', 'work-ai', 'wiki', 'entities', 'c-only.md')),
    '§9 the un-scanned page is still on disk (this is what the old code reported as erased)');

  // CONTROL: the identical harness with a WORKING listPages must succeed —
  // otherwise §9 could be green because the stub broke something unrelated.
  const b2 = await makeBrain('trunc-control');
  const passthrough = withOverride(b2.ad, 'listPages', (d, p) => b2.ad.listPages(d, p));
  const { r: res9c } = await quietErrors(() => revokeContributor(b2.conn, {
    fellowId: b2.fid, adminTokenHash: hashAdminToken(b2.conn.admin_token),
    adapter: passthrough, llmFn: mockLLM, patchFn: noopPatch,
  }));
  assertEq(res9c.ok, true, '§9 CONTROL: same harness with a working listPages succeeds');
  assertEq(res9c.erasure_complete, true, '§9 CONTROL: erasure_complete is true');
  assert(/Revocation complete/i.test(res9c.summary), '§9 CONTROL: summary DOES say "Revocation complete"');
  assertEq(res9c.marker_cleared, true, '§9 CONTROL: marker cleared on full success');
}

// ── §10: a failed audit write is a failed revocation ─────────────────────

section('§10 An erasure with no audit record does not report as complete');

{
  const b = await makeBrain('audit-fail');
  const stub = withOverride(b.ad, 'appendAudit', async () => { throw new Error('disk full'); });
  const { r: res10 } = await quietErrors(() => revokeContributor(b.conn, {
    fellowId: b.fid, adminTokenHash: hashAdminToken(b.conn.admin_token),
    adapter: stub, llmFn: mockLLM, patchFn: noopPatch,
  }));

  assertEq(res10.ok, false, '§10 revoke reports ok:false when the audit write fails');
  assertEq(res10.erasure_complete, true, '§10 the erasure itself DID complete (reported precisely)');
  assert(!!res10.audit_failed && /disk full/.test(res10.audit_failed.error || ''),
    '§10 audit_failed carries the reason');
  assert(/audit log/i.test(res10.summary), '§10 summary names the audit-log problem');
  assert(!/Revocation complete/i.test(res10.summary), '§10 summary does NOT say "Revocation complete"');

  // v3.6.2 CORRECTION (adversarial audit). A failed audit APPEND used to keep
  // the in-progress marker set — which makes runLocalSynthesis return ok:false
  // for EVERY contributor in the cohort until an admin re-runs the whole
  // revocation. The marker's one stated job is "the collective may be
  // mid-erasure"; an audit-log write failure says nothing about that. The
  // failure is still reported loudly (ok:false + audit_failed + a named
  // problem) — it just no longer takes the cohort's synthesis offline.
  assertEq(res10.marker_cleared, true,
    '§10 marker IS cleared — a failed audit write must not take cohort synthesis offline');
  const marker10 = await b.ad.readMeta('state.revocation-in-progress');
  assertEq(marker10 && marker10.active, false, '§10 marker is inactive on disk (synthesis unblocked)');
  // The erasure DID complete, so the summary must not tell the admin the
  // opposite — but it must still refuse certification.
  assert(!/Do NOT report this erasure as complete/i.test(res10.summary),
    '§10 summary does NOT falsely claim the erasure is incomplete');
  assert(/do NOT certify/i.test(res10.summary),
    '§10 summary still refuses certification (no audit record = no certificate)');
}

// ── §11: the NEW user-visible error strings never leak credentials ───────

section('§11 New failure fields are scrubbed of this connection\'s secrets');

{
  const b = await makeBrain('scrub');
  const leaky = new Error(
    `upstream rejected: pat=${b.conn.github_pat} admin=${b.conn.admin_token} boom`);
  const stub = withOverride(b.ad, 'deleteDigest', async () => { throw leaky; });
  const { r: res11, lines } = await quietErrors(() => revokeContributor(b.conn, {
    fellowId: b.fid, adminTokenHash: hashAdminToken(b.conn.admin_token),
    adapter: stub, llmFn: mockLLM, patchFn: noopPatch,
  }));

  assert(res11.digest_failed !== null && res11.digest_failed !== undefined,
    '§11 the digest failure was recorded');
  const blob = JSON.stringify(res11);
  assert(!blob.includes(b.conn.github_pat), '§11 the GitHub PAT does not appear anywhere in the result');
  assert(!blob.includes(b.conn.admin_token), '§11 the admin token does not appear anywhere in the result');
  assert(blob.includes('[redacted]'), '§11 the secrets were redacted (not merely absent by luck)');
  assert(/boom/.test((res11.digest_failed || {}).error || ''),
    '§11 the useful part of the reason survives scrubbing');
  const stderr11 = lines.join('\n');
  assert(!stderr11.includes(b.conn.github_pat) && !stderr11.includes(b.conn.admin_token),
    '§11 stderr is scrubbed too');
  const auditBlob = readFileSync(path.join(b.store, 'state', 'revocations.jsonl'), 'utf-8');
  assert(!auditBlob.includes(b.conn.github_pat) && !auditBlob.includes(b.conn.admin_token),
    '§11 the persisted audit log carries no credentials');
  assert(!/boom/.test(auditBlob),
    '§11 the persisted audit log carries COUNTS only — no provider error text');
}

// ── §12: source guards — the swallow cannot come back ────────────────────

section('§12 Source guards on the erasure path');

{
  const revokeSrc = readFileSync(new URL('../src/brain/sharedbrain-revoke.js', import.meta.url), 'utf-8');
  const code = revokeSrc.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  assert(!/\.catch\(\s*\(\s*\)\s*=>\s*\[\s*\]\s*\)/.test(code),
    '§12 no `.catch(() => [])` remains — that expression defeated the truncated-tree refusal');
  assert(/failures\.contributions\.push/.test(code), '§12 contribution failures are recorded');
  assert(/failures\.pages\.push/.test(code), '§12 page failures are recorded');
  assert(/failures\.digest\s*=/.test(code), '§12 digest failure is recorded');
  assert(/failures\.audit\s*=/.test(code), '§12 audit failure is recorded');
  // The cheerful string must be produced only where problems.length === 0.
  const doneIdx = code.indexOf('Revocation complete:');
  const guardIdx = code.indexOf('if (problems.length > 0)');
  assert(doneIdx > guardIdx && guardIdx !== -1,
    '§12 "Revocation complete" is emitted only AFTER the problems branch has returned');
  assert(!/else\s*\{[^}]*Revocation complete/.test(code),
    '§12 "Revocation complete" is not reachable from an else/fallthrough');

  const routeSrc = readFileSync(new URL('../src/routes/sharedbrain.js', import.meta.url), 'utf-8');
  assert(/emit\(\{\s*type:\s*'error',\s*message:\s*result\.error[^}]*result\s*\}\)/.test(routeSrc.replace(/\s+/g, ' ')) ||
         /type: 'error', message: result\.error \|\| 'Revoke failed', result/.test(routeSrc),
    '§12 the route forwards the structured result on the failure path (fields are not dead data)');
}

// ════════════════════════════════════════════════════════════════════════
// §13–§15 — v3.6.2 ADVERSARIAL-AUDIT FOLLOW-UP.
//
// The audit found that two of the four terms in `fullSuccess` had NO
// fixture that could make them fire: replacing the whole
// `pagesRebuildFailed` derivation with the constant 0 left this suite at
// 98 passed / 0 failed, and `state_reset_failed` had zero assertions
// anywhere. That is v3.6.1's finding 4 — "the fix's own guard was
// decorative" — recurring inside the v3.6.2 fix.
//
// §13/§14 cover those two. §15 covers `rebuildOk`, which had a `problems`
// line and an audit field but likewise no failing fixture. Each drives a
// GENUINE failure through the real code (a real adapter refusal, a real
// runLocalSynthesis ok:false) rather than asserting on a stub that never
// reached the path.
// ════════════════════════════════════════════════════════════════════════

/**
 * Build a brain with a revoked fellow C and a SURVIVING fellow D.
 *
 * `dEscapes` adds a second delta for D whose page path escapes the wiki
 * root. LocalFolderStorageAdapter.writePage refuses it (`_wikiPath` →
 * resolveInsideBase → null → throw), so runLocalSynthesis's per-page guard
 * records exactly one `pages_failed` while everything else succeeds.
 *
 * Why this mechanism and not chmod (as §7/§8 use): a permission-denied
 * fixture cannot run as root, and §7/§8 already self-skip there. The term
 * under test here is the one the audit found UNCOVERED, so its coverage
 * must not evaporate on a root CI runner. A hostile or corrupted
 * contribution payload is also exactly the case the per-page guard in
 * sharedbrain-synthesis.js was written for.
 */
async function makeBrainWithSurvivor(tag, dEscapes) {
  const root = mkdtempSync(path.join(tmpdir(), `sharedbrain-${tag}-`));
  scratchDirs.push(root);
  const store = path.join(root, 'shared-storage');
  mkdirSync(store, { recursive: true });
  const fidC = randomUUID(), fidD = randomUUID();
  const subC = randomUUID(), subD = randomUUID();
  const ad = new LocalFolderStorageAdapter({ storage_root: store });
  const conn = {
    ...connection,
    id: randomUUID(),
    local_storage_path: store,
    fellow_id: fidC,
    github_pat: 'github_pat_TESTONLY_SHOULD_NEVER_APPEAR_0123456789',
  };
  await ad.storeContribution(fidC, subC, {
    submission_id: subC, fellow_id: fidC, fellow_display_name: 'Fellow C',
    domain: 'work-ai', contributed_at: '2026-05-14T10:00:00Z',
    deltas: [{
      path: 'entities/c-only.md', type: 'entity', title: 'C-only Entity',
      new_facts: ['Fact authored by Fellow C only.'], new_links: [], removed_links: [],
    }],
  });
  const dDeltas = [{
    path: 'entities/d-only.md', type: 'entity', title: 'D-only Entity',
    new_facts: ['Fact authored by Fellow D only.'], new_links: [], removed_links: [],
  }];
  if (dEscapes) {
    dDeltas.push({
      path: '../escape-attempt.md', type: 'entity', title: 'Escape Attempt',
      new_facts: ['This page can never be written.'], new_links: [], removed_links: [],
    });
  }
  await ad.storeContribution(fidD, subD, {
    submission_id: subD, fellow_id: fidD, fellow_display_name: 'Fellow D',
    domain: 'work-ai', contributed_at: '2026-05-14T11:00:00Z',
    deltas: dDeltas,
  });
  await ad.storeDigest(fidC, { version: 1 });
  await ad.writeMeta('state.last-synthesis', { at: new Date(0).toISOString(), run_number: 0 });
  const setup = await quietErrors(() => runLocalSynthesis(conn, { llmFn: mockLLM, patchFn: noopPatch }));
  return { root, store, fidC, fidD, subC, subD, ad, conn, setup: setup.r };
}

// ── §13: the rebuild half-fails — pages_rebuild_failed must be load-bearing ──

section('§13 A rebuild that loses a page is NOT a clean revocation');

{
  const b = await makeBrainWithSurvivor('rebuild-partial', true);
  // Precondition: the fixture really does produce a failing page write.
  // Without this, §13 could be green because the rebuild never ran at all.
  assertEq(b.setup.pages_failed, 1,
    '§13 precondition: the fixture genuinely produces one failing page write');
  assert(existsSync(path.join(b.store, 'collective', 'work-ai', 'wiki', 'entities', 'd-only.md')),
    '§13 precondition: the survivor’s good page did get written');

  const { r: res13 } = await quietErrors(() => revokeContributor(b.conn, {
    fellowId: b.fidC, adminTokenHash: hashAdminToken(b.conn.admin_token),
    llmFn: mockLLM, patchFn: noopPatch,
  }));

  // The erasure itself is perfect — this is precisely the case that used to
  // report as a clean success while the collective was missing a page.
  assertEq(res13.erasure_complete, true, '§13 the erasure itself completed');
  assertEq(res13.contributions_failed.length, 0, '§13 no contribution failure');
  assertEq(res13.pages_failed.length, 0, '§13 no page-erasure failure');
  assert(!existsSync(path.join(b.store, 'collective', 'work-ai', 'wiki', 'entities', 'c-only.md')),
    '§13 the revoked contributor’s page really was deleted');

  // …and yet the run must NOT report clean.
  assertEq(res13.pages_rebuild_failed, 1, '§13 pages_rebuild_failed counts the lost page');
  assert(res13.pages_rebuilt >= 1, `§13 the healthy page was still rebuilt (got ${res13.pages_rebuilt})`);
  assertEq(res13.ok, false, '§13 revoke reports ok:false when the rebuild loses a page');
  assert(/rebuild completed but 1 page failed to write/i.test(res13.summary),
    `§13 summary names the lost page (got: ${res13.summary})`);
  assert(!/Revocation complete/i.test(res13.summary),
    '§13 summary does NOT say "Revocation complete"');
  assert(/do NOT certify/i.test(res13.summary),
    '§13 summary refuses certification while stating the erasure completed');

  // THE POINT: a half-rebuilt collective is exactly the mid-erasure state
  // the in-progress marker exists for, so the marker must stay set.
  assertEq(res13.marker_cleared, false, '§13 the in-progress marker was NOT cleared');
  const marker13 = await b.ad.readMeta('state.revocation-in-progress');
  assertEq(marker13 && marker13.active, true, '§13 marker still active on disk (synthesis stays blocked)');

  // The permanent record must carry it too, as a COUNT.
  assertEq(res13.audit_record.pages_rebuild_failed, 1, '§13 audit record counts the failed rebuild page');
  const line13 = JSON.parse(
    readFileSync(path.join(b.store, 'state', 'revocations.jsonl'), 'utf-8').trim().split('\n').pop());
  assertEq(line13.pages_rebuild_failed, 1, '§13 the PERSISTED audit line counts it');
  assertEq(line13.erasure_complete, true, '§13 the persisted audit line is precise: erasure DID complete');

  // CONTROL: identical fixture minus the un-writable delta must go fully
  // green. Without this, §13 could pass simply because this harness can
  // never succeed.
  const c = await makeBrainWithSurvivor('rebuild-control', false);
  assertEq(c.setup.pages_failed, 0, '§13 CONTROL precondition: no failing page in the control fixture');
  const { r: res13c } = await quietErrors(() => revokeContributor(c.conn, {
    fellowId: c.fidC, adminTokenHash: hashAdminToken(c.conn.admin_token),
    llmFn: mockLLM, patchFn: noopPatch,
  }));
  assertEq(res13c.pages_rebuild_failed, 0, '§13 CONTROL: pages_rebuild_failed is 0');
  assertEq(res13c.ok, true, '§13 CONTROL: same harness with a writable rebuild succeeds');
  assertEq(res13c.marker_cleared, true, '§13 CONTROL: marker cleared on full success');
  assert(/Revocation complete/i.test(res13c.summary), '§13 CONTROL: summary DOES say "Revocation complete"');
}

// ── §14: a failed watermark reset is reported, but is NOT marker-blocking ──

section('§14 A failed last-synthesis reset is reported without blocking the cohort');

{
  const b = await makeBrain('state-reset-fail');
  const realWriteMeta = b.ad.writeMeta.bind(b.ad);
  // Fail ONLY the watermark reset. The in-progress marker writes (steps 0
  // and 6) pass straight through, so this fixture isolates one field.
  const stub = withOverride(b.ad, 'writeMeta', async (key, value) => {
    if (key === 'state.last-synthesis') throw new Error('meta write refused by storage');
    return realWriteMeta(key, value);
  });

  const { r: res14 } = await quietErrors(() => revokeContributor(b.conn, {
    fellowId: b.fid, adminTokenHash: hashAdminToken(b.conn.admin_token),
    adapter: stub, llmFn: mockLLM, patchFn: noopPatch,
  }));

  assert(!!res14.state_reset_failed && /meta write refused/.test(res14.state_reset_failed.error || ''),
    `§14 state_reset_failed carries the reason (got ${JSON.stringify(res14.state_reset_failed)})`);
  assertEq(res14.erasure_complete, true, '§14 the erasure itself completed');
  assertEq(res14.ok, false, '§14 the run is reported ok:false (compliance path over-reports)');
  assert(/watermark could not be reset/i.test(res14.summary),
    `§14 summary names the watermark problem (got: ${res14.summary})`);
  assertEq(res14.audit_record.state_reset_failed, true, '§14 audit record flags it');
  const line14 = JSON.parse(
    readFileSync(path.join(b.store, 'state', 'revocations.jsonl'), 'utf-8').trim().split('\n').pop());
  assertEq(line14.state_reset_failed, true, '§14 the PERSISTED audit line flags it');

  // The correction: it is NOT an erasure failure and NOT a mid-erasure
  // state, so it must neither block synthesis nor tell the admin their
  // erasure is incomplete.
  assertEq(res14.marker_cleared, true, '§14 marker IS cleared — a stale watermark is not a mid-erasure state');
  const marker14 = await b.ad.readMeta('state.revocation-in-progress');
  assertEq(marker14 && marker14.active, false, '§14 marker inactive on disk (synthesis unblocked)');
  assert(!/Do NOT report this erasure as complete/i.test(res14.summary),
    '§14 summary does NOT falsely claim the erasure is incomplete');
  assert(/erasure itself completed/i.test(res14.summary),
    '§14 summary states plainly that the erasure completed');
}

// ── §15: rebuildOk — the third fullSuccess term, also previously uncovered ──

section('§15 A failed rebuild keeps the marker set and is named in the summary');

{
  const b = await makeBrain('rebuild-fail');
  // The erasure runs through the REAL adapter; only the rebuild fails.
  // `enabled: false` is the cheapest deterministic way to make the REAL
  // runLocalSynthesis return ok:false without stubbing it — what is under
  // test is revoke's HANDLING of a failed rebuild, not the reason for it.
  const disabledConn = { ...b.conn, enabled: false };
  const { r: res15 } = await quietErrors(() => revokeContributor(disabledConn, {
    fellowId: b.fid, adminTokenHash: hashAdminToken(b.conn.admin_token),
    adapter: b.ad, llmFn: mockLLM, patchFn: noopPatch,
  }));

  assertEq(res15.erasure_complete, true, '§15 the erasure itself completed');
  assertEq(res15.ok, false, '§15 revoke reports ok:false when the rebuild fails');
  assertEq(res15.pages_rebuilt, 0, '§15 nothing was rebuilt');
  assert(/rebuild synthesis FAILED/i.test(res15.summary),
    `§15 summary names the rebuild failure (got: ${res15.summary})`);
  assertEq(res15.audit_record.rebuild_ok, false, '§15 audit record says rebuild_ok:false');
  assertEq(res15.marker_cleared, false, '§15 marker NOT cleared — the collective is missing pages');
  const marker15 = await b.ad.readMeta('state.revocation-in-progress');
  assertEq(marker15 && marker15.active, true, '§15 marker still active on disk');
}

// ── §16: the deletePage(false) assumption the erasure path depends on ─────
//
// revokeContributor deliberately does NOT record `deletePage() === false`
// as a failure, because both shipped adapters return false ONLY when the
// target is already absent. That assumption is what keeps `erasure_complete`
// honest, so it is pinned here behaviourally rather than left in a comment.

section('§16 Adapter contract: deletePage returns false ONLY for an absent target');

{
  const b = await makeBrain('delete-contract');
  const absent = await b.ad.deletePage('work-ai', 'entities/definitely-not-here.md');
  assertEq(absent, false, '§16 deleting an absent page returns false ("already erased")');

  let threw = null;
  try { await b.ad.deletePage('work-ai', '../escape.md'); }
  catch (err) { threw = err; }
  assert(threw !== null,
    '§16 a REFUSED delete THROWS — it never returns false, so it can never be read as "already erased"');
}

// ── §17: the EARLY aborts are scrubbed too (makeScrubber's stated scope) ──
//
// §11 covers the per-item failure fields. The three EARLY aborts (adapter
// init, in-progress-marker write, listFellowSubmissions) return their error
// into the same user-visible field and used to pass `err.message` through
// raw — which made makeScrubber's docblock claim more than the code did.

section('§17 The early-abort error strings are scrubbed as well');

{
  const b = await makeBrain('scrub-early');
  const leaky = new Error(
    `listing refused: pat=${b.conn.github_pat} admin=${b.conn.admin_token} upstream-503`);
  const stub = withOverride(b.ad, 'listFellowSubmissions', async () => { throw leaky; });
  const { r: res17 } = await quietErrors(() => revokeContributor(b.conn, {
    fellowId: b.fid, adminTokenHash: hashAdminToken(b.conn.admin_token),
    adapter: stub, llmFn: mockLLM, patchFn: noopPatch,
  }));

  assertEq(res17.ok, false, '§17 an unreadable contribution list aborts the revoke');
  const blob17 = JSON.stringify(res17);
  assert(!blob17.includes(b.conn.github_pat), '§17 the GitHub PAT is not in the early-abort error');
  assert(!blob17.includes(b.conn.admin_token), '§17 the admin token is not in the early-abort error');
  assert(blob17.includes('[redacted]'),
    '§17 the secrets were redacted (not merely absent by luck)');
  assert(/upstream-503/.test(res17.error || ''), '§17 the useful part of the reason survives');
}

// ════════════════════════════════════════════════════════════════════════
// §18–§22 — v3.6.2 RE-AUDIT FOLLOW-UP.
//
// §17 above proves the listFellowSubmissions abort is SCRUBBED. It says
// nothing about what that abort TELLS the admin, and that turned out to be
// the finding: v3.6.2 gave the listPages scope-abort a thorough,
// admin-actionable message and left its structurally identical twin a bare
// two-clause error — the release's own named failure shape (a fix closing
// the reported case while its identical sibling stays broken) recurring
// inside its own fix.
// ════════════════════════════════════════════════════════════════════════

/** The full documented result contract. EVERY return point must carry it. */
const RESULT_KEYS = [
  'ok', 'erasure_complete', 'partial', 'summary',
  'contributions_deleted', 'contributions_failed', 'digest_failed',
  'pages_deleted', 'pages_failed', 'pages_rebuilt', 'pages_rebuild_failed',
  'state_reset_failed', 'audit_failed', 'marker_cleared', 'marker_active',
  'audit_record',
];

function assertFullShape(res, label) {
  const missing = RESULT_KEYS.filter(k => !(k in res));
  assertEq(missing, [], `${label} carries the full documented field set`);
}

/** Absolute paths that must never reach an admin-visible string. */
function assertNoAbsolutePaths(blob, absRoot, label) {
  const s = String(blob);
  assert(!s.includes(absRoot),
    `${label} does not leak the storage root (${absRoot})`);
  assert(!/\/Users\/|\/var\/folders\/|\/Volumes\//.test(s),
    `${label} contains no absolute filesystem path at all`);
}

// ── §18: the listFellowSubmissions abort — FINDING 3 ─────────────────────
//
// Reproduced live before the fix: a transient GitHub 502 here returned
// "listFellowSubmissions failed: GitHub 502 Bad Gateway" with
// erasure_complete/summary/marker_cleared all `undefined`. Nothing had been
// erased, which is true and reassuring, so the admin walks away — while the
// Step-0 marker sits active and EVERY contributor's synthesis is refused
// indefinitely. Nobody connects the two; the recovery was never stated.

section('§18 An unreadable submission list says what it leaves behind (finding 3)');

{
  const b = await makeBrain('list-subs-abort');
  const boom = Object.assign(new Error('GitHub 502 Bad Gateway'), { status: 502 });
  const stub = withOverride(b.ad, 'listFellowSubmissions', async () => { throw boom; });

  let synthesisRan = false;
  const { r: res18 } = await quietErrors(() => revokeContributor(b.conn, {
    fellowId: b.fid, adminTokenHash: hashAdminToken(b.conn.admin_token),
    adapter: stub,
    llmFn: async (...a) => { synthesisRan = true; return mockLLM(...a); },
    patchFn: noopPatch,
  }));

  // Precondition: the abort really is an abort — nothing was erased.
  assert(existsSync(path.join(b.store, 'contributions', b.fid, `${b.sub}.json`)),
    '§18 precondition: the contribution is still on disk (nothing was erased)');
  assertEq(synthesisRan, false, '§18 the rebuild synthesis did NOT run after the abort');

  assertEq(res18.ok, false, '§18 the revoke fails');
  assertFullShape(res18, '§18 the abort result');
  assertEq(res18.erasure_complete, false, '§18 erasure_complete is false (was undefined)');
  assertEq(res18.contributions_deleted, 0, '§18 nothing was deleted');
  assertEq(res18.summary, res18.error, '§18 summary and error agree (no two wordings to drift)');

  // The message content — this is the finding.
  assert(/ABORTED/i.test(res18.summary), '§18 summary says the erasure was ABORTED');
  assert(/NOTHING has been erased/i.test(res18.summary),
    '§18 summary states plainly that nothing was erased');
  assert(!/Revocation complete/i.test(res18.summary),
    '§18 summary does NOT say "Revocation complete"');
  assert(/marker/i.test(res18.summary),
    `§18 summary names the revocation-in-progress marker (got: ${res18.summary})`);
  assert(/every contributor/i.test(res18.summary),
    '§18 summary says the block is COHORT-WIDE, not local to this admin');
  assert(/re-run this revocation/i.test(res18.summary),
    '§18 summary names the recovery (re-run the revocation)');
  assert(/idempotent/i.test(res18.summary),
    '§18 summary says the re-run is safe');
  assert(/upstream|502|Bad Gateway/i.test(res18.summary),
    '§18 summary still carries the underlying reason');

  // The structured fields a client would render.
  assertEq(res18.marker_cleared, false, '§18 marker_cleared is false (a marker genuinely exists)');
  assertEq(res18.marker_active, true, '§18 marker_active is true — synthesis IS blocked');
  assertEq(res18.partial, false,
    '§18 partial is FALSE — the marker is a side effect, not a partial erasure');
  assertEq((res18.contributions_failed || []).length, 1,
    '§18 the enumeration failure appears in contributions_failed, not an empty array');
  assertEq(((res18.contributions_failed || [])[0] || {}).submission_id, '*',
    '§18 the synthetic "*" entry means "the enumeration itself failed" (mirrors pages_failed)');

  // THE HARM, proven rather than described: the marker is on disk and real
  // synthesis really is refused for everyone. Without this the whole section
  // would only be asserting on our own prose.
  const marker18 = await b.ad.readMeta('state.revocation-in-progress');
  assertEq(marker18 && marker18.active, true, '§18 the marker is still active on disk');
  const blocked = await quietErrors(() => runLocalSynthesis(b.conn, {
    llmFn: mockLLM, patchFn: noopPatch,
  }));
  assertEq(blocked.r.ok, false,
    '§18 THE HARM: ordinary synthesis is genuinely refused after this abort');
  assert(/revocation is in progress/i.test(blocked.r.error || ''),
    '§18 …and it is refused for exactly the reason the summary names');

  // CONTROL: the identical harness with a WORKING listFellowSubmissions must
  // succeed and unblock synthesis — otherwise §18 could be green because the
  // stub broke something unrelated.
  const c = await makeBrain('list-subs-control');
  const passthrough = withOverride(c.ad, 'listFellowSubmissions', (f) => c.ad.listFellowSubmissions(f));
  const { r: res18c } = await quietErrors(() => revokeContributor(c.conn, {
    fellowId: c.fid, adminTokenHash: hashAdminToken(c.conn.admin_token),
    adapter: passthrough, llmFn: mockLLM, patchFn: noopPatch,
  }));
  assertEq(res18c.ok, true, '§18 CONTROL: same harness with a working listing succeeds');
  assertEq(res18c.erasure_complete, true, '§18 CONTROL: erasure_complete is true');
  assertEq(res18c.marker_active, false, '§18 CONTROL: marker_active is false');
  const unblocked = await quietErrors(() => runLocalSynthesis(c.conn, {
    llmFn: mockLLM, patchFn: noopPatch,
  }));
  assertEq(unblocked.r.ok, true, '§18 CONTROL: synthesis is NOT blocked after a clean revocation');
}

// ── §19: every return point carries the documented shape — FINDING 4 ─────
//
// Six of nine return points were bare {ok, error} while the admin doc states
// the SSE `error` payload carries the whole result object. A client written
// against the doc read `erasure_complete` as undefined — falsy, so it
// degraded safely, but the contract was wrong.

section('§19 Every return point carries the documented shape, with per-path meaning');

{
  // — Pre-marker aborts: no marker was ever written, so "was it cleared?"
  //   is a category error (null), and synthesis is NOT blocked (false).
  //   Stamping marker_cleared:false here would raise a cohort-wide alarm
  //   for a request that failed input validation and touched nothing.
  const badUuid = await revokeContributor({ shared_domain: 'work-ai' }, { fellowId: 'not-a-uuid' });
  assertFullShape(badUuid, '§19 the bad-fellowId abort');
  assertEq(badUuid.ok, false, '§19 bad fellowId is rejected');
  assertEq(badUuid.erasure_complete, false, '§19 bad fellowId: erasure_complete is false');
  assertEq(badUuid.marker_cleared, null,
    '§19 bad fellowId: marker_cleared is null (NOT APPLICABLE — no marker exists)');
  assertEq(badUuid.marker_active, false,
    '§19 bad fellowId: marker_active is false — this request blocked nobody');
  assertEq(badUuid.partial, false, '§19 bad fellowId: partial is false');
  assertEq(badUuid.audit_record, null, '§19 bad fellowId: no audit record');
  assertEq(badUuid.summary, badUuid.error, '§19 bad fellowId: summary and error agree');

  const noDomain = await revokeContributor({}, { fellowId: randomUUID() });
  assertFullShape(noDomain, '§19 the missing-shared_domain abort');
  assertEq(noDomain.marker_active, false, '§19 missing shared_domain: marker_active is false');

  // — Adapter init abort: still pre-marker. Driven through the REAL factory
  //   (no opts.adapter) so this is the production path, not a stub.
  const badAdapterConn = { ...connection, storage_type: 'no-such-backend' };
  const adapterFail = await revokeContributor(badAdapterConn, { fellowId: randomUUID() });
  assertFullShape(adapterFail, '§19 the adapter-init abort');
  assertEq(adapterFail.ok, false, '§19 an unknown storage backend aborts');
  assert(/adapter init failed/i.test(adapterFail.error || ''),
    `§19 …at the adapter-init guard (got: ${adapterFail.error})`);
  assertEq(adapterFail.marker_cleared, null, '§19 adapter init: marker_cleared is null');
  assertEq(adapterFail.marker_active, false, '§19 adapter init: marker_active is false');

  // — Marker-write abort: the ONE genuinely unknown case. The write threw,
  //   but a 502 can follow a commit, so we must not claim the marker is
  //   absent. null = unknown; the summary says so and gives the recovery.
  const b = await makeBrain('marker-write-fail');
  const realWriteMeta = b.ad.writeMeta.bind(b.ad);
  const markerStub = withOverride(b.ad, 'writeMeta', async (key, value) => {
    if (key === 'state.revocation-in-progress') throw new Error('storage refused the marker write');
    return realWriteMeta(key, value);
  });
  const { r: res19m } = await quietErrors(() => revokeContributor(b.conn, {
    fellowId: b.fid, adminTokenHash: hashAdminToken(b.conn.admin_token),
    adapter: markerStub, llmFn: mockLLM, patchFn: noopPatch,
  }));
  assertFullShape(res19m, '§19 the marker-write abort');
  assertEq(res19m.ok, false, '§19 a failed marker write aborts the revoke');
  assertEq(res19m.marker_cleared, null, '§19 marker write failed: marker_cleared is null');
  assertEq(res19m.marker_active, null,
    '§19 marker write failed: marker_active is null (UNKNOWN, not guessed)');
  assert(/UNKNOWN/i.test(res19m.summary),
    '§19 …and the summary says the marker state is unknown rather than guessing');
  assert(/re-run this revocation/i.test(res19m.summary),
    '§19 the marker-write abort also names the recovery');
  assert(existsSync(path.join(b.store, 'contributions', b.fid, `${b.sub}.json`)),
    '§19 precondition: the marker-write abort really did erase nothing');

  // — The listPages abort (§9's path) must now agree with its twin.
  const c = await makeBrain('listpages-shape');
  const truncErr = Object.assign(
    new Error('listPages: GitHub returned a TRUNCATED tree listing for this repo'),
    { code: 'SHARED_BRAIN_TREE_TRUNCATED' });
  const { r: res19p } = await quietErrors(() => revokeContributor(c.conn, {
    fellowId: c.fid, adminTokenHash: hashAdminToken(c.conn.admin_token),
    adapter: withOverride(c.ad, 'listPages', async () => { throw truncErr; }),
    llmFn: mockLLM, patchFn: noopPatch,
  }));
  assertFullShape(res19p, '§19 the listPages abort');
  assertEq(res19p.marker_active, true, '§19 listPages abort: marker_active is true');
  assertEq(res19p.partial, true,
    '§19 listPages abort: partial is TRUE — unlike its twin, deletions already happened here');

  // — And the two terminal returns.
  const d = await makeBrain('terminal-shape');
  const { r: res19ok } = await quietErrors(() => revokeContributor(d.conn, {
    fellowId: d.fid, adminTokenHash: hashAdminToken(d.conn.admin_token),
    adapter: d.ad, llmFn: mockLLM, patchFn: noopPatch,
  }));
  assertFullShape(res19ok, '§19 the clean-success return');
  assertEq(res19ok.ok, true, '§19 the clean run succeeds');
  assertEq(res19ok.partial, false, '§19 clean success: partial is false (never undefined)');
  assertEq(res19ok.marker_active, false, '§19 clean success: marker_active is false');
  assertEq(res19ok.marker_cleared, true, '§19 clean success: marker_cleared is true');

  const e = await makeBrain('problems-shape');
  const { r: res19x } = await quietErrors(() => revokeContributor({ ...e.conn, enabled: false }, {
    fellowId: e.fid, adminTokenHash: hashAdminToken(e.conn.admin_token),
    adapter: e.ad, llmFn: mockLLM, patchFn: noopPatch,
  }));
  assertFullShape(res19x, '§19 the problems return');
  assertEq(res19x.ok, false, '§19 the problems run fails');
  assertEq(res19x.marker_active, true,
    '§19 problems return: marker_active mirrors an uncleared marker');
}

// ── §20: the synthesis RETURN path is scrubbed and capped — FINDING 10 ───
//
// makeScrubber's docblock claimed "every error string this function can hand
// back is scrubbed". runLocalSynthesis RETURNS (does not throw) at its
// adapter-init and listContributionsSince guards, and revoke interpolated
// that `error` straight into problems → summary → the SSE frame, raw and
// uncapped — bypassing MAX_FAILURE_DETAIL_CHARS entirely.

section('§20 A rebuild error that was RETURNED (not thrown) is scrubbed and capped');

{
  // 20a — the scrubber's ENFORCED list, made executable.
  const scrub = revokeT.makeScrubber({
    github_pat: 'github_pat_UNIT_TEST_SECRET_0123456789',
    admin_token: 'sbat_UNIT_TEST_ADMIN_TOKEN_abcdef',
  });
  assert(!scrub(new Error('pat=github_pat_UNIT_TEST_SECRET_0123456789 boom')).includes('github_pat_UNIT'),
    '§20a pass 1 redacts the connection secrets');
  assertEq(scrub("EACCES: permission denied, unlink '/var/folders/x/y/contributions/s.json'"),
    "EACCES: permission denied, unlink '.../s.json'",
    '§20a pass 2 reduces an absolute path to its basename');
  assertEq(scrub('a string, not an Error object'), 'a string, not an Error object',
    '§20a accepts a bare string — runLocalSynthesis reports by RETURNING one');
  const long = scrub('E'.repeat(revokeT.MAX_FAILURE_DETAIL_CHARS + 500));
  assert(long.length <= revokeT.MAX_FAILURE_DETAIL_CHARS + 1,
    `§20a pass 3 caps the FINAL string at ${revokeT.MAX_FAILURE_DETAIL_CHARS} (got ${long.length})`);
  assertEq(scrub('runLocalSynthesis: connection is disabled'),
    'runLocalSynthesis: connection is disabled',
    '§20a ordinary prose survives byte-identical (over-scrubbing would damage every summary)');
  // The OTHER direction, and the one that is easy to leave unproven: a
  // scrubber that is too WIDE is not merely untidy, it destroys the only
  // identifying detail these messages carry. Real page failures name a
  // RELATIVE wiki path, which contains a separator and is not a location.
  assertEq(scrub('failed to write entities/c-only.md: SHARED_BRAIN_SHA_CONFLICT'),
    'failed to write entities/c-only.md: SHARED_BRAIN_SHA_CONFLICT',
    '§20a a RELATIVE wiki path survives untouched (an over-wide pass would eat it)');
  assertEq(scrub("EACCES: unlink '/var/tmp/x/s.json' — retry the revocation"),
    "EACCES: unlink '.../s.json' — retry the revocation",
    '§20a scrubbing a path does NOT swallow the sentence that follows it');

  // 20b — the integration proof, driving the REAL runLocalSynthesis into its
  // RETURN-an-error guard with a genuine fs error carrying an absolute path.
  //
  // Two stores on purpose: revoke erases against a healthy adapter passed in
  // via opts.adapter, while runLocalSynthesis builds its OWN adapter from
  // `connection` — which points at a store where `contributions` exists as a
  // FILE, so the real readdir throws ENOTDIR with an absolute path.
  // Deterministic and root-safe: no chmod, so this coverage does not
  // evaporate on a root CI runner (the §13 lesson).
  const b = await makeBrain('synth-return-err');
  const badRoot = mkdtempSync(path.join(tmpdir(), 'sharedbrain-synth-bad-'));
  scratchDirs.push(badRoot);
  const badStore = path.join(badRoot, 'shared-storage');
  mkdirSync(badStore, { recursive: true });
  writeFileSync(path.join(badStore, 'contributions'), 'this is a file, not a directory');

  const { r: res20 } = await quietErrors(() => revokeContributor(
    { ...b.conn, local_storage_path: badStore },
    {
      fellowId: b.fid, adminTokenHash: hashAdminToken(b.conn.admin_token),
      adapter: b.ad, llmFn: mockLLM, patchFn: noopPatch,
    }));

  // Precondition: we really did reach the RETURN path, not the throw path.
  assertEq(res20.ok, false, '§20b the run reports ok:false');
  assert(/rebuild synthesis FAILED/i.test(res20.summary),
    `§20b precondition: the rebuild really did fail (got: ${res20.summary})`);
  assert(/listContributionsSince|ENOTDIR|not a directory/i.test(res20.summary),
    '§20b precondition: it failed at the RETURN-an-error guard, carrying a real fs error');
  assertEq(res20.erasure_complete, true,
    '§20b the erasure itself completed — only the rebuild failed');

  // The finding.
  assertNoAbsolutePaths(res20.summary, badStore, '§20b the rebuild-failure summary');
  assert(String(res20.summary).includes('.../'),
    '§20b the path was reduced to its basename (scrubbed, not merely absent by luck)');
}

// ── §21: absolute filesystem paths never reach the summary — FINDING 11 ──
//
// Reproduced: "…could NOT be deleted (e.g. 13e55008…: EACCES: permission
// denied, unlink '/var/folders/…/shared-storage/contributions/…')". On a real
// install the leading directories are the user's home and their
// cloud-storage layout.

section('§21 Per-item failure strings carry the basename, never the location');

{
  const b = await makeBrain('path-leak');
  const absLeak = path.join(b.store, 'contributions', b.fid, `${b.sub}.json`);
  // The shape a real LocalFolderStorageAdapter delete failure produces — the
  // adapter method is the right seam, and the REAL scrub() and the REAL
  // summary composition run underneath.
  const fsErr = Object.assign(
    new Error(`EACCES: permission denied, unlink '${absLeak}'`),
    { code: 'EACCES', errno: -13, path: absLeak });
  const stub = withOverride(b.ad, 'deleteContribution', async () => { throw fsErr; });

  const { r: res21, lines } = await quietErrors(() => revokeContributor(b.conn, {
    fellowId: b.fid, adminTokenHash: hashAdminToken(b.conn.admin_token),
    adapter: stub, llmFn: mockLLM, patchFn: noopPatch,
  }));

  assertEq(res21.ok, false, '§21 the failed delete is reported');
  assertEq(res21.erasure_complete, false, '§21 erasure_complete is false');
  assertEq((res21.contributions_failed || []).length, 1, '§21 precondition: the failure was recorded');
  assert(/EACCES|permission denied/i.test(((res21.contributions_failed || [])[0] || {}).error || ''),
    '§21 precondition: the recorded reason really is the fs error');

  assertNoAbsolutePaths(res21.summary, b.store, '§21 the admin-visible summary');
  assertNoAbsolutePaths(((res21.contributions_failed || [])[0] || {}).error, b.store,
    '§21 the per-item failure field');
  assertNoAbsolutePaths(JSON.stringify(res21), b.store, '§21 the whole result object');
  assertNoAbsolutePaths(lines.join('\n'), b.store, '§21 the stderr line');
  assert(String(res21.summary).includes(`.../${b.sub}.json`),
    '§21 the basename SURVIVES — the useful half is kept, only the location is removed');
}

// ── §22: the class invariant — no fourth sibling can appear ──────────────
//
// Finding 3 was one abort hardened and its identical twin left bare. A
// spot-check would miss the next one exactly as it missed this one, so the
// guard is an ENUMERATION: every return inside revokeContributor must go
// through one of the two builders.

section('§22 Class invariant: every return point is built, never hand-rolled');

{
  const revokeSrc = readFileSync(new URL('../src/brain/sharedbrain-revoke.js', import.meta.url), 'utf-8');
  const lines = revokeSrc.split('\n');
  const start = lines.findIndex(l => /^export async function revokeContributor/.test(l));
  const end = lines.findIndex((l, i) => i > start && /^}/.test(l));
  assert(start !== -1 && end > start, '§22 revokeContributor was located in the source');

  const body = lines.slice(start, end);
  const returns = [];
  body.forEach((raw, i) => {
    const code = raw.replace(/^\s*\/\/.*$/, '');
    if (/(?:^|[\s{(])return(?:\s|;|$)/.test(code)) returns.push({ line: start + i + 1, code: code.trim() });
  });

  // The two returns inside the provenance `.some()` callback are predicate
  // results, not results of this function.
  const fnReturns = returns.filter(r => !/^(if \(!c\) )?return (false|norm ===)/.test(r.code));
  assert(fnReturns.length >= 9,
    `§22 the enumeration found every return point (got ${fnReturns.length}, expected >= 9)`);

  const handRolled = fnReturns.filter(r =>
    !/^return abortResult\(/.test(r.code) && !/^return \{$/.test(r.code));
  assertEq(handRolled.map(r => r.line), [],
    '§22 no return builds its own object literal inline');

  // The two `return {` forms must be the terminal ones that spread baseResult.
  const terminal = fnReturns.filter(r => /^return \{$/.test(r.code));
  assertEq(terminal.length, 2, '§22 exactly two terminal returns (problems + clean success)');
  for (const t of terminal) {
    const window = lines.slice(t.line - 1, t.line + 12).join('\n');
    assert(/\.\.\.baseResult/.test(window),
      `§22 the terminal return at line ${t.line} spreads baseResult (one shape, one place)`);
  }

  // Both scope aborts must carry the marker consequence AND the recovery.
  // The ABSENCE of that pairing on one of two identical siblings WAS
  // finding 3, so it is checked PER SIBLING — a whole-file keyword count
  // would have been satisfied by the hardened twin alone, which is exactly
  // how the bare one survived a release.
  const codeOnly = body.map(l => l.replace(/^\s*\/\/.*$/, ''));
  for (const method of ['listFellowSubmissions', 'listPages']) {
    const callIdx = codeOnly.findIndex(l => l.includes(`await adapter.${method}(`));
    assert(callIdx !== -1, `§22 the ${method} scope call was located`);
    // The abort message is composed between the call and the return that
    // follows it. 40 lines is generous; the block is ~18.
    const block = codeOnly.slice(callIdx, callIdx + 40).join('\n');
    const abortIdx = block.indexOf('return abortResult(');
    assert(abortIdx !== -1, `§22 ${method}'s catch aborts through the shared builder`);
    const msg = block.slice(0, abortIdx);
    assert(/marker/i.test(msg),
      `§22 ${method}'s abort names the revocation-in-progress marker`);
    assert(/re-run this revocation/i.test(msg),
      `§22 ${method}'s abort names the recovery (re-run — the half finding 3 was missing)`);
    assert(/idempotent/i.test(msg),
      `§22 ${method}'s abort says the re-run is safe`);
    assert(/MARKER_ACTIVE/.test(block),
      `§22 ${method}'s abort declares the marker ACTIVE (post-Step-0)`);
  }

  const code = lines.map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  assert(/MARKER_ACTIVE:\s*\n\s*default:/.test(code),
    '§22 the abortResult default arm is grouped with the BLOCKING state, not the cheerful one');
  assert(/scrubPaths\(s\)/.test(code) && !/function scrubPaths/.test(code),
    '§22 scrubPaths is IMPORTED, not a second hand-maintained copy of the v3.3.0 guard');
}

// ── Cleanup ──────────────────────────────────────────────────────────────

console.log('\nCleaning up...');
rmSync(workspaceRoot, { recursive: true, force: true });
for (const d of scratchDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
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

console.log('\nAll Phase 4F revoke tests green. GDPR Article 17 properties verified.');
process.exit(0);
