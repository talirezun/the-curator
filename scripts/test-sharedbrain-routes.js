#!/usr/bin/env node
/**
 * Shared Brain — Phase 4A Battle Test (HTTP routes)
 *
 * Spawns the real Curator server on an isolated port (3334, not the
 * default 3333) with DOMAINS_PATH pointed at a /tmp workspace, then
 * exercises every /api/sharedbrain/* endpoint over real HTTP:
 *
 *   - feature-flag gate (404 when disabled, 200 when enabled)
 *   - list / save / delete connection CRUD
 *   - invite token round-trip (encode → decode)
 *   - invite token validation rejects malformed input
 *   - SSE-stream endpoint shapes (push / pull / synthesize) — these use
 *     LocalFolderStorageAdapter so we exercise the route layer without
 *     hitting GitHub
 *   - revoke endpoint admin-token gate + confirmation-string gate
 *   - validate-pat against live GitHub IF env vars present (else skipped
 *     with note — same gate pattern as test-sharedbrain-github-live.js)
 *
 * Isolation:
 *   - Spawns server with PORT=3334 + DOMAINS_PATH=/tmp/.../ + CURATOR_NO_OPEN=1.
 *     The running production Curator on 3333 is unaffected.
 *   - Backs up + restores .curator-config.json and .sharedbrain-config.json
 *     in the worktree root (the test creates them; we clean up before
 *     exiting so the worktree returns to its initial state).
 *
 * Run with:  node scripts/test-sharedbrain-routes.js
 * Exit code 0 if green, non-zero on failure.
 */

import { spawn } from 'child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, unlinkSync, copyFileSync, chmodSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { LocalFolderStorageAdapter } from '../src/brain/sharedbrain-local-adapter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PORT = 3334;
const BASE = `http://localhost:${PORT}/api/sharedbrain`;

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

async function request(method, pathOrFull, body) {
  const url = pathOrFull.startsWith('http') ? pathOrFull : `${BASE}${pathOrFull}`;
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  let parsed;
  try { parsed = await r.json(); } catch { parsed = null; }
  return { status: r.status, body: parsed };
}

// ── Backup pre-existing config files (we restore at the end) ────────────

// v3.0.6 (plan L21): the backup lives ON DISK, not in process memory. The
// old in-memory Map meant a crash (SIGKILL, OOM, power loss) between the
// unlink below and restoreConfigs() permanently wiped the developer's real
// API keys. Now each config is COPIED to `<file>.pre-test-backup` first;
// if the process dies mid-run, the backup survives on disk and the next
// run (or the developer) restores it. Mode preserved at 0600 (credentials).
const configPaths = [
  path.join(PROJECT_ROOT, '.curator-config.json'),
  path.join(PROJECT_ROOT, '.sharedbrain-config.json'),
];
const backupPath = (p) => `${p}.pre-test-backup`;

// If a previous run crashed, its on-disk backups are still here — restore
// them FIRST so this run starts from the developer's true config state.
for (const p of configPaths) {
  if (existsSync(backupPath(p))) {
    copyFileSync(backupPath(p), p);
    chmodSync(p, 0o600);
    unlinkSync(backupPath(p));
    console.log(`  (recovered ${path.basename(p)} from a previous crashed run's backup)`);
  }
}

const hadOriginal = new Map();
for (const p of configPaths) {
  if (existsSync(p)) {
    copyFileSync(p, backupPath(p));
    chmodSync(backupPath(p), 0o600);
    hadOriginal.set(p, true);
  } else {
    hadOriginal.set(p, false);
  }
}

function restoreConfigs() {
  for (const p of configPaths) {
    if (hadOriginal.get(p)) {
      if (existsSync(backupPath(p))) {
        copyFileSync(backupPath(p), p);
        chmodSync(p, 0o600);
        unlinkSync(backupPath(p));
      }
    } else {
      if (existsSync(p)) unlinkSync(p);
      if (existsSync(backupPath(p))) unlinkSync(backupPath(p));
    }
  }
}

// Force a clean initial state so the test doesn't depend on whatever the
// developer's dev server left behind in .curator-config.json. Safe now —
// the on-disk backups above outlive any crash.
for (const p of configPaths) {
  if (existsSync(p)) unlinkSync(p);
}

// ── Spawn server in an isolated process ─────────────────────────────────

const domainsDir = mkdtempSync(path.join(tmpdir(), 'sharedbrain-routes-'));
console.log(`Phase 4A routes test — server port ${PORT}, domains ${domainsDir}`);

const child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'src/server.js')], {
  cwd: PROJECT_ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    // CURATOR_TEST_DOMAINS_DIR beats config in the spawned server; plain
    // DOMAINS_PATH loses to a configured domainsPath, so the child server would
    // otherwise operate on the real domains/ folder on a configured machine.
    CURATOR_TEST_DOMAINS_DIR: domainsDir,
    CURATOR_NO_OPEN: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

// Drain stdout/stderr so the child doesn't block on a full buffer.
// We capture stderr in case a failure needs diagnostics.
const stderrBuf = [];
child.stdout.on('data', () => {});
child.stderr.on('data', d => stderrBuf.push(d.toString()));

let childExited = false;
child.on('exit', () => { childExited = true; });

function shutdown() {
  try {
    restoreConfigs();
    try { rmSync(domainsDir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (!childExited) child.kill('SIGTERM');
  } catch (err) {
    console.error('shutdown error:', err.message);
  }
}
process.on('exit', shutdown);
process.on('SIGINT', () => { shutdown(); process.exit(130); });

// Wait for /api/version to respond (server is ready).
async function waitForReady(attempts = 50) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(`http://localhost:${PORT}/api/version`);
      if (r.ok) return true;
    } catch { /* server still booting */ }
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

try {
  const ready = await waitForReady();
  if (!ready) {
    console.error('Server failed to come up within 5s. stderr:');
    console.error(stderrBuf.join(''));
    process.exit(2);
  }

  // ── 1. Feature flag gate ─────────────────────────────────────────────

  section('Feature-flag gate (flag false → 404 on protected routes)');

  {
    const r = await request('GET', '/feature-flag');
    assertEq(r.status, 200, 'GET /feature-flag responds 200 even when flag is off');
    assertEq(r.body, { enabled: false }, 'feature flag is initially false');
  }

  {
    const r = await request('GET', '/list');
    assertEq(r.status, 404, 'GET /list returns 404 while flag is off');
    assert(/not enabled/i.test(r.body?.error || ''), 'error message mentions feature is not enabled');
  }

  {
    const r = await request('POST', '/enable-flag');
    assertEq(r.status, 200, 'POST /enable-flag responds 200');
    assertEq(r.body, { enabled: true }, 'flag flips to true');
  }

  {
    const r = await request('GET', '/feature-flag');
    assertEq(r.body.enabled, true, 'feature-flag now reports enabled');
  }

  // ── 2. List → save → list → delete cycle ─────────────────────────────

  section('Connection CRUD (list / save / delete)');

  {
    const r = await request('GET', '/list');
    assertEq(r.status, 200, 'GET /list responds 200');
    assertEq(r.body.connections, [], 'list is empty initially');
  }

  let savedId;
  const fakeConnection = {
    label: 'Phase 4A Test Cohort',
    storage_type: 'local',
    local_storage_path: domainsDir, // reuse temp dir as fake storage
    fellow_display_name: 'Test Fellow',
    shared_domain: 'work-ai',
    shared_brain_slug: 'phase-4a',
    local_domains: ['personal'],
  };

  {
    const r = await request('POST', '/save', { connection: fakeConnection });
    assertEq(r.status, 200, 'POST /save responds 200');
    assert(r.body.connection && r.body.connection.id, 'save returns connection with assigned id');
    assert(r.body.connection.fellow_id, 'save assigns fellow_id automatically');
    savedId = r.body.connection.id;
  }

  {
    const r = await request('GET', '/list');
    assertEq(r.body.connections.length, 1, 'list now contains the saved connection');
    assertEq(r.body.connections[0].id, savedId, 'list returns the saved connection by id');
  }

  // Try a save with malformed connection
  {
    const r = await request('POST', '/save', { connection: { storage_type: 'mystery' } });
    assertEq(r.status, 400, 'POST /save rejects malformed connection with 400');
  }

  {
    const r = await request('DELETE', `/${savedId}`);
    assertEq(r.status, 200, 'DELETE /:id responds 200');
    assertEq(r.body.removed, true, 'DELETE confirms removal');
  }

  {
    const r = await request('DELETE', `/${savedId}`);
    assertEq(r.status, 404, 'DELETE /:id second time returns 404');
  }

  {
    const r = await request('DELETE', '/not-a-uuid');
    assertEq(r.status, 400, 'DELETE /:id rejects non-UUID with 400');
  }

  // ── 3. Invite token round-trip ───────────────────────────────────────

  section('Invite token codec (generate-invite + parse-invite)');

  let inviteToken;
  {
    const r = await request('POST', '/generate-invite', {
      repo: 'talirezun/curator-sharedbrain-preflight',
      name: 'Phase 4A Test Brain',
      shared_domain: 'work-ai',
      branch: 'main',
    });
    assertEq(r.status, 200, 'POST /generate-invite responds 200');
    assert(typeof r.body.token === 'string' && r.body.token.startsWith('sbi_'),
      'token has sbi_ prefix');
    inviteToken = r.body.token;
  }

  {
    const r = await request('POST', '/parse-invite', { token: inviteToken });
    assertEq(r.status, 200, 'POST /parse-invite responds 200 for valid token');
    assertEq(r.body.valid, true, 'parse-invite reports valid: true');
    assertEq(r.body.metadata.repo, 'talirezun/curator-sharedbrain-preflight',
      'parse-invite returns repo intact');
    assertEq(r.body.metadata.name, 'Phase 4A Test Brain',
      'parse-invite returns display name intact');
    assertEq(r.body.metadata.shared_domain, 'work-ai',
      'parse-invite returns shared_domain intact');
    assertEq(r.body.metadata.v, 1, 'parse-invite returns version number');
  }

  // Bad tokens
  {
    const r = await request('POST', '/parse-invite', { token: 'not-an-invite' });
    assertEq(r.status, 400, 'parse-invite rejects bad prefix with 400');
    assertEq(r.body.valid, false, 'reports valid: false');
  }
  {
    const r = await request('POST', '/parse-invite', { token: 'sbi_!!!malformed' });
    assertEq(r.status, 400, 'parse-invite rejects malformed payload with 400');
  }
  {
    const r = await request('POST', '/parse-invite', { token: 'sbi_' + Buffer.from('{"v":99,"repo":"a/b","name":"x","shared_domain":"y"}').toString('base64url') });
    assertEq(r.status, 400, 'parse-invite rejects future version with 400');
    assert(/version/i.test(r.body.error || ''), 'error mentions version mismatch');
  }
  // generate-invite validation
  {
    const r = await request('POST', '/generate-invite', { name: 'no repo provided' });
    assertEq(r.status, 400, 'generate-invite rejects missing repo with 400');
  }
  {
    const r = await request('POST', '/generate-invite', {
      repo: 'not-a-slash', name: 'X', shared_domain: 'y',
    });
    assertEq(r.status, 400, 'generate-invite rejects malformed repo with 400');
  }
  {
    const r = await request('POST', '/generate-invite', {
      repo: 'a/b', name: 'X', shared_domain: 'has spaces',
    });
    assertEq(r.status, 400, 'generate-invite rejects bad shared_domain with 400');
  }

  // ── 4. SSE endpoints — push / pull / synthesize ──────────────────────

  section('SSE endpoint surface (push / pull / synthesize, local storage)');

  // First save a fresh local-storage connection we can run operations on.
  const sseRoot = mkdtempSync(path.join(tmpdir(), 'sharedbrain-routes-sse-'));
  const sseConn = {
    label: 'SSE Test',
    storage_type: 'local',
    local_storage_path: sseRoot,
    fellow_display_name: 'SSE Tester',
    shared_domain: 'work-ai',
    shared_brain_slug: 'sse-test',
    local_domains: ['personal'],
  };
  const saved2 = await request('POST', '/save', { connection: sseConn });
  assertEq(saved2.status, 200, 'save SSE-test connection');
  const sseConnId = saved2.body.connection.id;

  // pull endpoint should run cleanly even with an empty shared brain
  {
    const r = await fetch(`${BASE}/${sseConnId}/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    assertEq(r.status, 200, 'POST /:id/pull responds 200');
    const ct = r.headers.get('content-type') || '';
    assert(ct.includes('text/event-stream'), 'pull sends Content-Type: text/event-stream');
    const text = await r.text();
    const events = text.split('\n\n').filter(s => s.startsWith('data:')).map(s => JSON.parse(s.slice(5).trim()));
    const hasDone = events.some(e => e.type === 'done' || e.type === 'error');
    assert(hasDone, 'pull stream terminates with done or error event');
  }

  // synthesize endpoint — no contributions yet, should emit done with 0 pages
  {
    const r = await fetch(`${BASE}/${sseConnId}/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    assertEq(r.status, 200, 'POST /:id/synthesize responds 200');
    const text = await r.text();
    const events = text.split('\n\n').filter(s => s.startsWith('data:')).map(s => JSON.parse(s.slice(5).trim()));
    const doneEvent = events.find(e => e.type === 'done');
    assert(doneEvent, 'synthesize emits a done event');
  }

  // push endpoint — requires a personal domain to exist. We don't have
  // one in this isolated test setup, so it should return an error, but
  // crucially the route must still respond cleanly (not crash).
  {
    const r = await fetch(`${BASE}/${sseConnId}/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ local_domain: 'personal' }),
    });
    assertEq(r.status, 200, 'POST /:id/push responds 200 even when error path fires');
    const text = await r.text();
    const events = text.split('\n\n').filter(s => s.startsWith('data:')).map(s => JSON.parse(s.slice(5).trim()));
    assert(events.length > 0, 'push emits at least one event');
  }

  // push without local_domain → 400
  {
    const r = await fetch(`${BASE}/${sseConnId}/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    // The body has no local_domain AND the connection's local_domains[0] is
    // 'personal', so the route accepts it (defaults from connection).
    // To force the 400 we'd need to clear the connection's local_domains.
    // Instead test the broken-id path:
    assertEq(r.status, 200, 'push uses connection.local_domains[0] when body omits local_domain');
  }

  // Invalid id paths
  {
    const r = await request('POST', '/not-a-uuid/push');
    assertEq(r.status, 400, 'push with invalid id returns 400');
  }
  {
    const r = await request('POST', `/${'a'.repeat(8)}-1111-2222-3333-${'b'.repeat(12)}/pull`);
    assertEq(r.status, 404, 'pull with valid-shape but unknown id returns 404');
  }

  // Cleanup the SSE-test connection
  await request('DELETE', `/${sseConnId}`);
  rmSync(sseRoot, { recursive: true, force: true });

  // ── 5. Revoke endpoint gates ─────────────────────────────────────────

  section('Revoke endpoint (admin-only, Decision 6b)');

  // Create a connection without admin_token (typical contributor case)
  const revConn = {
    label: 'Revoke Test',
    storage_type: 'local',
    local_storage_path: domainsDir,
    fellow_display_name: 'Reviewer',
    shared_domain: 'work-ai',
    shared_brain_slug: 'revoke-test',
    local_domains: ['personal'],
  };
  const revSaved = await request('POST', '/save', { connection: revConn });
  const revId = revSaved.body.connection.id;

  // No admin_token in body → 403
  {
    const r = await request('POST', `/${revId}/revoke`, {});
    assertEq(r.status, 403, 'revoke without admin_token returns 403');
  }

  // Add admin_token via direct file-mutation isn't possible from here;
  // verify the body-validation gates instead by providing admin_token
  // that doesn't match (the connection has none, so any token mismatches).
  {
    const r = await request('POST', `/${revId}/revoke`, { admin_token: 'whatever' });
    assertEq(r.status, 403, 'revoke with mismatched admin_token returns 403');
  }

  await request('DELETE', `/${revId}`);

  // ── 5b. Phase 4/5 endpoints over HTTP (v3.0.6, plan 5.5) ─────────────
  // Full admin lifecycle against LOCAL storage: pending/unskip → members →
  // admin-token rotation → REVOKE incl. the confirmation-string SUCCESS
  // path (previously only gates were tested; the success path ran only in
  // one-off smoke scripts).

  section('Phase 4/5 endpoints (unskip / members / rotate / revoke success)');

  const p5Storage = mkdtempSync(path.join(tmpdir(), 'sharedbrain-routes-p5-'));
  const p5Adapter = new LocalFolderStorageAdapter({ storage_root: p5Storage });
  const p5FellowA = randomUUID(); // to be revoked
  const p5FellowB = randomUUID(); // survivor
  const p5ShortA = p5FellowA.replace(/-/g, '').slice(0, 8);
  await p5Adapter.storeContribution(p5FellowA, randomUUID(), {
    fellow_id: p5FellowA, fellow_display_name: 'Revokee', domain: 'work-ai',
    contributed_at: '2026-06-20T10:00:00.000Z',
    deltas: [{ path: 'concepts/theirs.md', title: 'Theirs', new_facts: ['Revokee fact.'], new_links: [], removed_links: [] }],
  });
  await p5Adapter.storeContribution(p5FellowB, randomUUID(), {
    fellow_id: p5FellowB, fellow_display_name: 'Survivor', domain: 'work-ai',
    contributed_at: '2026-06-21T10:00:00.000Z',
    deltas: [{ path: 'concepts/other.md', title: 'Other', new_facts: ['Survivor fact.'], new_links: [], removed_links: [] }],
  });
  await p5Adapter.writePage('work-ai', 'concepts/theirs.md',
    `# Theirs\n\n## Key Facts\n\n- Revokee fact.\n\n## Provenance\n\n- Contributors: ${p5ShortA}\n`);

  const p5Saved = await request('POST', '/save', { connection: {
    label: 'Phase 5 HTTP Test', storage_type: 'local', local_storage_path: p5Storage,
    fellow_display_name: 'Admin', shared_domain: 'work-ai',
    shared_brain_slug: 'p5http', local_domains: [],
    data_handling_terms: 'organisational',
    permanent_skip: ['concepts/skipme.md'],
    pending_retry: { 'concepts/skipme.md': 3 },
  }});
  assertEq(p5Saved.status, 200, 'save Phase-5 connection');
  const p5Id = p5Saved.body.connection.id;
  assertEq(p5Saved.body.connection.data_handling_terms, 'organisational',
    'data_handling_terms persisted on the connection');

  // pending_pages on list (M14)
  {
    const r = await request('GET', '/list');
    const mine = (r.body.connections || []).find(c => c.id === p5Id);
    assert(mine && typeof mine.pending_pages === 'number', 'list carries pending_pages');
  }

  // unskip
  {
    const r = await request('POST', `/${p5Id}/unskip`, {});
    assertEq(r.status, 200, 'POST /:id/unskip responds 200');
    assertEq(r.body.unskipped, 1, 'unskip clears the skipped page');
    assertEq(r.body.permanent_skip, [], 'permanent_skip now empty');
  }
  {
    const r = await request('POST', `/${p5Id}/unskip`, { pages: [42] });
    assertEq(r.status, 400, 'unskip rejects malformed pages array with 400');
  }

  // members
  {
    const r = await request('GET', `/${p5Id}/members`);
    assertEq(r.status, 200, 'GET /:id/members responds 200');
    assertEq((r.body.members || []).length, 2, 'members lists both fellows');
    const revokee = (r.body.members || []).find(m => m.fellow_id === p5FellowA);
    assert(revokee && revokee.short_id === p5ShortA && revokee.display_name === 'Revokee',
      'member entry carries short id + display name');
  }

  // admin-token rotate (provision → rotate; masked in listings)
  let p5AdminToken;
  {
    const r = await request('POST', `/${p5Id}/admin-token/rotate`);
    assertEq(r.status, 200, 'POST /:id/admin-token/rotate responds 200');
    assert(/^sbat_[0-9a-f]{40}$/.test(r.body.admin_token || ''), 'rotate returns a sbat_ token');
    assertEq(r.body.rotated, false, 'first rotate reports rotated: false (provisioning)');
    const oldToken = r.body.admin_token;
    const r2 = await request('POST', `/${p5Id}/admin-token/rotate`);
    assertEq(r2.body.rotated, true, 'second rotate reports rotated: true');
    assert(r2.body.admin_token !== oldToken, 'rotation issues a different token');
    p5AdminToken = r2.body.admin_token;
    const list = await request('GET', '/list');
    const mine = (list.body.connections || []).find(c => c.id === p5Id);
    assert(mine && /…$/.test(mine.admin_token || ''), 'admin_token is masked in listings');

    // The rotated-away token must no longer authorise a revoke.
    const stale = await request('POST', `/${p5Id}/revoke`, {
      admin_token: oldToken, fellow_id: p5FellowA, confirmation: `REVOKE-${p5FellowA}`,
    });
    assertEq(stale.status, 403, 'rotated-away admin token → 403');
  }

  // revoke gates + SUCCESS path (5.5)
  {
    const shortForm = await request('POST', `/${p5Id}/revoke`, {
      admin_token: p5AdminToken, fellow_id: p5FellowA, confirmation: `REVOKE-${p5ShortA}`,
    });
    assertEq(shortForm.status, 400, 'short-form confirmation refused (client must expand to full UUID)');

    const r = await fetch(`${BASE}/${p5Id}/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        admin_token: p5AdminToken, fellow_id: p5FellowA, confirmation: `REVOKE-${p5FellowA}`,
      }),
    });
    assertEq(r.status, 200, 'revoke with correct token + confirmation accepted');
    const text = await r.text();
    assert(text.includes('"type":"done"') && !text.includes('"type":"error"'),
      'revoke SSE stream completes without error');
    assert(/Revocation complete/.test(text), 'revoke reports completion');

    const subsLeft = await p5Adapter.listFellowSubmissions(p5FellowA);
    assertEq(subsLeft.length, 0, 'revokee submissions erased from storage');
    const page = await p5Adapter.readPage('work-ai', 'concepts/theirs.md');
    assert(page === null || !page.includes('Revokee fact.'),
      'provenance-tainted page erased (or rebuilt without revokee facts)');
    const mem = await request('GET', `/${p5Id}/members`);
    assert((mem.body.members || []).every(m => m.fellow_id !== p5FellowA),
      'revokee gone from the member directory after revoke');
    assert((mem.body.members || []).some(m => m.fellow_id === p5FellowB),
      'surviving contributor still listed');
  }

  await request('DELETE', `/${p5Id}`);
  rmSync(p5Storage, { recursive: true, force: true });

  // ── 6. validate-pat: LIVE-ish — only if env present ──────────────────

  section('validate-pat (uses live GitHub, env-gated)');

  const testRepo = process.env.GITHUB_TEST_REPO;
  const testPat  = process.env.GITHUB_TEST_PAT;

  if (testRepo && testPat) {
    {
      const r = await request('POST', '/validate-pat', { repo: testRepo, pat: testPat });
      assertEq(r.status, 200, 'validate-pat with live PAT responds 200');
      assertEq(r.body.valid, true, 'live PAT is reported valid');
      assertEq(r.body.hasWriteAccess, true, 'live PAT has write access');
    }
    {
      const r = await request('POST', '/validate-pat', {
        repo: testRepo,
        pat: 'github_pat_FAKE_TOKEN_THAT_GITHUB_WILL_REJECT_12345678',
      });
      assertEq(r.status, 200, 'validate-pat with bogus PAT responds 200 (200 = validator ran, not that token is valid)');
      assertEq(r.body.valid, false, 'bogus PAT is reported invalid');
    }
    {
      const r = await request('POST', '/validate-pat', { repo: 'a/b', pat: 'short' });
      assertEq(r.status, 400, 'validate-pat rejects too-short PAT with 400');
    }
    {
      const r = await request('POST', '/validate-pat', { repo: 'badformat', pat: 'long_enough_dummy_pat_value_x' });
      assertEq(r.status, 400, 'validate-pat rejects bad repo format with 400');
    }
  } else {
    // Wording matters: the run-tests.js aggregator classifies a suite whose
    // output contains all-caps "SKIPPED" as fully self-skipped — which made
    // CI display this 73-assertion suite as "⏭ skip" even though everything
    // ran green (v3.0.6 CI run #30). This is a partial, optional section.
    console.log('  (validate-pat live section not run — set GITHUB_TEST_REPO + GITHUB_TEST_PAT to include it)');
  }

  // ── Summary ──────────────────────────────────────────────────────────

  console.log('\n══════════════════════════════════════');
  console.log(`  Total: ${passed + failed}   Passed: ${passed}   Failed: ${failed}`);
  console.log('══════════════════════════════════════');

  if (failed > 0) {
    console.log('\nFAILURES:');
    for (const { label, err } of failures) {
      console.log(`  ✗ ${label}`);
      if (err) console.log(`    └─ ${err.message || err}`);
    }
    if (stderrBuf.length > 0) {
      console.log('\nServer stderr:');
      console.log(stderrBuf.join(''));
    }
    process.exit(1);
  }

  console.log('\nAll Phase 4A route tests green.');
  process.exit(0);
} catch (err) {
  console.error('Test harness error:', err);
  if (stderrBuf.length > 0) {
    console.log('\nServer stderr:');
    console.log(stderrBuf.join(''));
  }
  process.exit(2);
}
