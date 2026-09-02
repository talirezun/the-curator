/**
 * test-sharedbrain-route-guards.js — OFFLINE suite (v3.43.0)
 *
 * Five guards, all found by a LIVE end-to-end run of Shared Brain against a
 * real private GitHub repo with two isolated Curator instances. Every one of
 * them is driven here through the REAL express routers on a REAL HTTP server;
 * nothing is asserted from source text.
 *
 *   §1  F-01 CRITICAL — POST /:id/admin-token/rotate had NO proof of
 *       possession. Any connection on the machine could mint an admin token,
 *       and the member instance's card OFFERED the button. With that token,
 *       GET /:id/members hands out every fellow_id and POST /:id/revoke
 *       accepts it — so a plain contributor could GDPR-erase the cohort admin.
 *       The live run walked exactly that path.
 *
 *   §2  F-15 — joining the same (repo, shared_domain) twice minted a second
 *       fellow_id for one person, so a revoke of either erased half their
 *       contributions while certifying a complete Article 17 erasure.
 *
 *   §3  F-03 (the naming half) — `shared-` was called a reserved namespace in
 *       three enforcement sites and was NOT reserved at domain creation, so a
 *       user could own the exact folder a crafted invite token aims a
 *       destructive pull at.
 *
 *   §4  (a) — chat wrote a conversation file into a read-only Shared Brain
 *       mirror. Proven live: the admin instance's mirror held one.
 *
 *   §5  (b) — CURATOR_TEST_USER_DATA_DIR did not cover the log path, so two
 *       throwaway test instances wrote their whole run into the maintainer's
 *       own ~/Library/Logs/The Curator/curator.log.
 *
 * ── ANTI-VACUITY ────────────────────────────────────────────────────────────
 * Every refusal assertion is paired with a matching ACCEPTANCE against the same
 * route: a guard that always refuses is exactly as broken as one that never
 * does, and only the positive half tells them apart. §1 additionally asserts
 * the STATE after a refusal (no token was written), because a route that
 * refuses in its response while still mutating is the shape that matters here.
 *
 * ── ISOLATION ───────────────────────────────────────────────────────────────
 * CURATOR_TEST_USER_DATA_DIR and __setDomainsDirOverride are set before any app
 * module resolves a path; the real credential files are sha256-fingerprinted
 * before and after (size + hash + existence only — never mtime, which the
 * maintainer's live app moves during ordinary use). No network: the only
 * provider call in the file goes through llm.js's existing
 * __setAnthropicClientFactory seam.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync,
         readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import express from 'express';

// ── Isolation FIRST — before any app module is imported ────────────────────
const TMP = mkdtempSync(path.join(os.tmpdir(), 'curator-sbguard-'));
const TMP_USER = path.join(TMP, 'userdata');
const TMP_DOMAINS = path.join(TMP, 'domains');
mkdirSync(TMP_USER, { recursive: true });
mkdirSync(TMP_DOMAINS, { recursive: true });

process.env.CURATOR_TEST_USER_DATA_DIR = TMP_USER;
delete process.env.DOMAINS_PATH;
delete process.env.CURATOR_TEST_LOG_DIR;
delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.LLM_MODEL;

const REPO_ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const REAL_FILES = ['.curator-config.json', '.sync-config.json', '.sharedbrain-config.json']
  .map(f => path.join(REPO_ROOT, f));
function fingerprint() {
  return REAL_FILES.map(f => {
    if (!existsSync(f)) return `${path.basename(f)}:absent`;
    const buf = readFileSync(f);
    return `${path.basename(f)}:${buf.length}:${createHash('sha256').update(buf).digest('hex')}`;
  }).join('|');
}
const FINGERPRINT_BEFORE = fingerprint();
const REAL_LOG = path.join(os.homedir(), 'Library', 'Logs', 'The Curator', 'curator.log');
const REAL_LOG_BEFORE = existsSync(REAL_LOG) ? readFileSync(REAL_LOG).length : null;

const { default: sharedBrainRouter, __testing: routesT } =
  await import('../src/routes/sharedbrain.js');
const { default: domainsRouter } = await import('../src/routes/domains.js');
const { default: chatRouter } = await import('../src/routes/chat.js');
const { __setDomainsDirOverride } = await import('../src/brain/config.js');
const { getSharedBrainWithToken, getSharedBrains, saveSharedBrain, __testing: cfgT } =
  await import('../src/brain/sharedbrain-config.js');
const { getLogsDir, __setLogDirOverride } = await import('../src/brain/paths.js');
const { __setAnthropicClientFactory } = await import('../src/brain/llm.js');

__setDomainsDirOverride(TMP_DOMAINS);

// ── Harness ────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];
function ok(cond, label, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual, expected, label) {
  ok(actual === expected, label, `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}
function section(t) { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 68 - t.length))}`); }

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use('/api/sharedbrain', sharedBrainRouter);
app.use('/api/domains', domainsRouter);
app.use('/api/chat', chatRouter);
const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const BASE = `http://127.0.0.1:${server.address().port}`;

async function req(method, p, body) {
  const init = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + p, init);
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body: json };
}

// ── Fixture ────────────────────────────────────────────────────────────────
writeFileSync(path.join(TMP_USER, '.curator-config.json'), JSON.stringify({
  sharedBrainEnabled: true,
  anthropicApiKey: 'zz-fake-anthropic-key-for-tests',
  activeProvider: 'anthropic',
}, null, 2) + '\n');

const ADMIN_TOKEN = 'sbat_' + 'a'.repeat(40);
const ADMIN_ID = randomUUID();
const MEMBER_ID = randomUUID();

function baseConn(over) {
  return {
    id: randomUUID(),
    label: 'Cohort Brain',
    storage_type: 'github',
    github_repo_owner: 'alice',
    github_repo_name: 'cohort-brain',
    github_pat: 'github_pat_TESTONLY_SHOULD_NEVER_APPEAR_0123456789',
    github_branch: 'main',
    fellow_id: randomUUID(),
    fellow_display_name: 'Tester',
    shared_domain: 'workai',
    shared_brain_slug: 'cohort',
    local_domains: [],
    enabled: true,
    read_only: false,
    pending_retry: {},
    permanent_skip: [],
    ...over,
  };
}

// The ADMIN connection: has an admin token. The MEMBER connection: does not,
// and points at a DIFFERENT brain so §2's duplicate guard does not refuse it.
saveSharedBrain(baseConn({ id: ADMIN_ID, label: 'Admin', admin_token: ADMIN_TOKEN }));
saveSharedBrain(baseConn({ id: MEMBER_ID, label: 'Member', shared_domain: 'otherdomain' }));

// ═══ §1 — F-01: admin-token rotation needs the CURRENT token ═══════════════
section('1. F-01 CRITICAL — rotate requires proof of possession');
{
  const before = getSharedBrainWithToken(MEMBER_ID).admin_token;
  ok(before === undefined || before === null,
    'fixture precondition: the member connection stores NO admin token');

  // (a) A plain contributor asking for one — the live-proven escalation.
  const r1 = await req('POST', `/api/sharedbrain/${MEMBER_ID}/admin-token/rotate`, {});
  eq(r1.status, 403, 'a connection with no admin token is REFUSED, not issued one');
  eq(r1.body && r1.body.code, 'no_admin_token', 'the refusal carries code=no_admin_token');
  ok(!(r1.body && r1.body.admin_token), 'no token is returned on the refusal');
  const afterRefusal = getSharedBrainWithToken(MEMBER_ID).admin_token;
  ok(afterRefusal === undefined || afterRefusal === null,
    'AND NOTHING WAS WRITTEN — the member connection still stores no admin token');

  // (b) Even supplying a plausible-looking token does not help a connection
  //     that has none: there is nothing to compare against.
  const r1b = await req('POST', `/api/sharedbrain/${MEMBER_ID}/admin-token/rotate`,
    { admin_token: ADMIN_TOKEN });
  eq(r1b.status, 403, 'another connection\'s admin token does not unlock this one');
  eq(r1b.body && r1b.body.code, 'no_admin_token', 'still no_admin_token — the gate reads THIS connection');

  // (c) The real admin, with no token in the body.
  const r2 = await req('POST', `/api/sharedbrain/${ADMIN_ID}/admin-token/rotate`, {});
  eq(r2.status, 403, 'the admin must still supply the current token');
  eq(r2.body && r2.body.code, 'admin_token_required', 'code=admin_token_required when the body carries none');
  eq(getSharedBrainWithToken(ADMIN_ID).admin_token, ADMIN_TOKEN,
    'the stored admin token is untouched by a refused rotation');

  // (d) Wrong token. Same LENGTH as the real one, so this cannot pass by
  //     accident through any length-based short-circuit.
  const wrong = 'sbat_' + 'b'.repeat(40);
  eq(wrong.length, ADMIN_TOKEN.length, 'control: the wrong token is the same length as the right one');
  const r3 = await req('POST', `/api/sharedbrain/${ADMIN_ID}/admin-token/rotate`, { admin_token: wrong });
  eq(r3.status, 403, 'a wrong admin token is refused');
  eq(r3.body && r3.body.code, 'admin_token_mismatch', 'code=admin_token_mismatch');
  eq(getSharedBrainWithToken(ADMIN_ID).admin_token, ADMIN_TOKEN,
    'a wrong token does not rotate anything');

  // (e) THE ACCEPTANCE HALF. Without this the four refusals above would be
  //     green against a route that always 403s.
  const r4 = await req('POST', `/api/sharedbrain/${ADMIN_ID}/admin-token/rotate`,
    { admin_token: ADMIN_TOKEN });
  eq(r4.status, 200, 'the CORRECT current token rotates');
  ok(typeof r4.body.admin_token === 'string' && r4.body.admin_token.startsWith('sbat_'),
    'a new sbat_ token comes back');
  ok(r4.body.admin_token !== ADMIN_TOKEN, 'the new token differs from the old one');
  eq(r4.body.rotated, true, 'rotated:true — the shape the view reads');
  eq(getSharedBrainWithToken(ADMIN_ID).admin_token, r4.body.admin_token,
    'the new token is what is now stored');

  // (f) Rotation really invalidates: the OLD token no longer works.
  const r5 = await req('POST', `/api/sharedbrain/${ADMIN_ID}/admin-token/rotate`,
    { admin_token: ADMIN_TOKEN });
  eq(r5.status, 403, 'the previous token is dead the moment it is rotated');
  eq(r5.body && r5.body.code, 'admin_token_mismatch', 'and it reports a mismatch, not a missing token');

  // Restore for the revoke assertions below.
  const live = getSharedBrainWithToken(ADMIN_ID);
  saveSharedBrain({ ...live, admin_token: ADMIN_TOKEN });

  // (g) The REVOKE gate shares this implementation and is unchanged in wording.
  const rv = await req('POST', `/api/sharedbrain/${MEMBER_ID}/revoke`, {
    admin_token: ADMIN_TOKEN, fellow_id: randomUUID(),
  });
  eq(rv.status, 403, 'revoke on a connection with no admin token is still 403');
  eq(rv.body.error, 'admin_token is required and must match the connection',
    'the revoke sentence is BYTE-IDENTICAL to the one the view has always rendered');
  eq(rv.body.code, 'no_admin_token', 'and it now also carries the machine-readable code');

  // (h) The UI needs to know whether to draw the affordance at all.
  const list = await req('GET', '/api/sharedbrain/list');
  const rows = list.body.connections;
  const adminRow = rows.find(c => c.id === ADMIN_ID);
  const memberRow = rows.find(c => c.id === MEMBER_ID);
  eq(adminRow.has_admin_token, true, 'GET /list reports has_admin_token:true for the admin');
  eq(memberRow.has_admin_token, false, 'GET /list reports has_admin_token:false for a plain contributor');
  ok(typeof adminRow.admin_token === 'string' && adminRow.admin_token.endsWith('…'),
    'and the token itself is still MASKED in the listing');
}

// ═══ §2 — F-15: one brain, one membership ═════════════════════════════════
section('2. F-15 — joining the same (repo, shared_domain) twice is refused');
{
  // Re-saving the SAME connection must keep working. Asserted FIRST, because
  // every wizard step, every credential update and every rotate does it.
  const live = getSharedBrainWithToken(ADMIN_ID);
  const again = await req('POST', '/api/sharedbrain/save', { connection: { ...live } });
  eq(again.status, 200, 're-saving the same connection id is allowed');

  // A second connection to the same repo AND the same shared domain.
  const dup = baseConn({ label: 'Cohort Brain (again)' });
  const rDup = await req('POST', '/api/sharedbrain/save', { connection: dup });
  eq(rDup.status, 400, 'a second membership of the same brain is refused');
  ok(/already connected to that shared brain/i.test(rDup.body.error || ''),
    'the refusal says what happened');
  ok(/erasure/i.test(rDup.body.error || ''),
    'and says WHY it matters — split contributions survive an erasure request');
  ok(!getSharedBrains().some(c => c.id === dup.id), 'the duplicate was not written');

  // Case is not a way around it: GitHub owners and repo names are
  // case-insensitive, so `Alice/Cohort-Brain` is the same repository.
  const dupCase = baseConn({
    label: 'Cohort Brain (case)', github_repo_owner: 'Alice', github_repo_name: 'Cohort-Brain',
  });
  eq((await req('POST', '/api/sharedbrain/save', { connection: dupCase })).status, 400,
    'a case-different spelling of the same repo is still the same brain');

  // THE ACCEPTANCE HALF — a genuinely different brain still connects, twice
  // over: a different shared domain in the same repo, and a different repo.
  const otherDomain = baseConn({ label: 'Other domain', shared_domain: 'research' });
  eq((await req('POST', '/api/sharedbrain/save', { connection: otherDomain })).status, 200,
    'a different shared_domain in the same repo is a different brain and is allowed');
  const otherRepo = baseConn({ label: 'Other repo', github_repo_name: 'second-brain-repo' });
  eq((await req('POST', '/api/sharedbrain/save', { connection: otherRepo })).status, 200,
    'a different repo is a different brain and is allowed');

  // The identity function itself, on the shapes the route cannot reach.
  const { connectionIdentity } = cfgT;
  ok(connectionIdentity({ storage_type: 'github', github_repo_owner: 'a',
        github_repo_name: 'b', shared_domain: 'd' }) ===
     connectionIdentity({ storage_type: 'github', github_repo_owner: 'A',
        github_repo_name: 'B', shared_domain: 'D' }),
    'connectionIdentity folds case on every component');
  eq(connectionIdentity({ storage_type: 'github', shared_domain: 'd' }), null,
    'an incomplete record has NO identity — so it can never collide with everything');
  eq(connectionIdentity({ storage_type: 'local', local_storage_path: '/x/../y', shared_domain: 'd' }),
     connectionIdentity({ storage_type: 'local', local_storage_path: '/y', shared_domain: 'd' }),
    'local paths are resolved before comparison');

  // Clean up so §5's log check and the isolation fingerprint stay readable.
  await req('DELETE', `/api/sharedbrain/${otherDomain.id}`);
  await req('DELETE', `/api/sharedbrain/${otherRepo.id}`);
}

// ═══ §3 — F-03 (naming half): the shared- namespace is reserved ════════════
section('3. F-03 — "shared-" is reserved at domain creation and rename');
{
  const rBad = await req('POST', '/api/domains', { displayName: 'Shared Thalassic Cohort' });
  eq(rBad.status, 400, 'a display name that slugs to shared-… is refused');
  ok(/reserved/i.test(rBad.body.error || ''), 'the refusal uses the word "reserved"');
  ok(!existsSync(path.join(TMP_DOMAINS, 'shared-thalassic-cohort')),
    'and no folder was created');

  // ACCEPTANCE — a name that merely CONTAINS "shared" is fine; only the
  // leading `shared-` segment is reserved.
  const rOk = await req('POST', '/api/domains', { displayName: 'Notes On Shared Work' });
  eq(rOk.status, 201, 'an ordinary name still creates a domain');
  eq(rOk.body.slug, 'notes-on-shared-work', 'and it keeps the slug it asked for');

  // Renaming INTO the namespace is the same claim by another door.
  const rRename = await req('PUT', `/api/domains/${rOk.body.slug}`,
    { displayName: 'Shared Cohort Mirror' });
  eq(rRename.status, 400, 'renaming a domain INTO shared-… is refused');
  ok(/reserved/i.test(rRename.body.error || ''), 'with the same reason');
  ok(existsSync(path.join(TMP_DOMAINS, rOk.body.slug)),
    'and the domain is still where it was');

  // ACCEPTANCE — an ordinary rename still works, so the guard above is not
  // simply "rename is broken".
  const rRenameOk = await req('PUT', `/api/domains/${rOk.body.slug}`, { displayName: 'Plain Notes' });
  eq(rRenameOk.status, 200, 'an ordinary rename still works');
  eq(rRenameOk.body.newSlug, 'plain-notes', 'and lands on the expected slug');
}

// ═══ §4 — (a): chat never writes into a read-only mirror ═══════════════════
section('4. Chat answers a read-only mirror without writing into it');
{
  // A real mirror, created the way pullCollective creates one.
  const MIRROR = 'shared-cohort';
  const PLAIN = 'plain-notes';
  for (const [d, claudeMd] of [
    [MIRROR, '---\nreadonly: true\nsource: shared-brain\n---\n\n# Mirror\n'],
    [PLAIN,  '# Plain\n'],
  ]) {
    mkdirSync(path.join(TMP_DOMAINS, d, 'wiki', 'entities'), { recursive: true });
    mkdirSync(path.join(TMP_DOMAINS, d, 'conversations'), { recursive: true });
    writeFileSync(path.join(TMP_DOMAINS, d, 'CLAUDE.md'), claudeMd);
    writeFileSync(path.join(TMP_DOMAINS, d, 'wiki', 'entities', 'kestrel.md'),
      '---\ntype: entity\n---\n# Kestrel Array\n\n## Key Facts\n- Twelve shore clusters.\n');
  }

  // The provider is faked through llm.js's EXISTING seam — no new production
  // seam, no network, no spend. (test-chat-cancel.js uses the same one.)
  __setAnthropicClientFactory(() => ({
    messages: {
      stream: () => ({
        finalMessage: () => Promise.resolve({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'The Kestrel Array has twelve clusters. [source: entities/kestrel.md]' }],
          usage: { input_tokens: 10, output_tokens: 8 },
        }),
      }),
    },
  }));

  const convFiles = (d) => {
    const dir = path.join(TMP_DOMAINS, d, 'conversations');
    return existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')) : [];
  };

  eq(convFiles(MIRROR).length, 0, 'precondition: the mirror holds no conversations');

  const m1 = await req('POST', `/api/chat/${MIRROR}`, { message: 'How many clusters?' });
  eq(m1.status, 200, 'chatting with a mirror is still ANSWERED — that is what a mirror is for');
  ok(typeof m1.body.answer === 'string' && m1.body.answer.length > 0, 'and a real answer comes back');
  eq(m1.body.persisted, false, 'the response says the thread was NOT persisted');
  eq(convFiles(MIRROR).length, 0, 'AND NO FILE WAS WRITTEN into the read-only mirror');

  // Multi-turn still works: the thread is held in memory, so the second turn
  // keeps its id and its history rather than silently starting over. This is
  // the half that makes "do not persist" acceptable instead of a hidden
  // downgrade of the answer quality.
  const m2 = await req('POST', `/api/chat/${MIRROR}`,
    { message: 'And how deep?', conversationId: m1.body.conversationId });
  eq(m2.body.conversationId, m1.body.conversationId, 'the second turn keeps the same conversation id');
  eq(m2.body.isNew, false, 'and is NOT reported as a new thread — the history was found');
  eq(m2.body.persisted, false, 'still not persisted');
  eq(convFiles(MIRROR).length, 0, 'still nothing on disk in the mirror');

  // THE ACCEPTANCE HALF. Without it, everything above is green against a chat
  // route that has simply stopped saving anything at all.
  const p1 = await req('POST', `/api/chat/${PLAIN}`, { message: 'How many clusters?' });
  eq(p1.status, 200, 'an ordinary domain still answers');
  eq(p1.body.persisted, true, 'and reports persisted:true');
  eq(convFiles(PLAIN).length, 1, 'and the conversation IS on disk for an ordinary domain');
  ok(existsSync(path.join(TMP_DOMAINS, PLAIN, 'conversations', `${p1.body.conversationId}.json`)),
    'under the id the response named');
}

// ═══ §5 — (b): the user-data seam covers the log ══════════════════════════
section('5. CURATOR_TEST_USER_DATA_DIR isolates the log path too');
{
  const resolved = getLogsDir();
  eq(resolved, path.join(TMP_USER, 'logs'),
    'with CURATOR_TEST_USER_DATA_DIR set, the log lands INSIDE the isolated tree');
  ok(!resolved.startsWith(path.join(os.homedir(), 'Library', 'Logs')),
    'and not in the real ~/Library/Logs');

  // The log-SPECIFIC seams must still outrank it, or a suite that wants to
  // isolate only the log inside an already-isolated fixture cannot.
  process.env.CURATOR_TEST_LOG_DIR = path.join(TMP, 'explicit-log');
  eq(getLogsDir(), path.join(TMP, 'explicit-log'),
    'CURATOR_TEST_LOG_DIR still wins over the user-data seam');
  delete process.env.CURATOR_TEST_LOG_DIR;
  __setLogDirOverride(path.join(TMP, 'override-log'));
  eq(getLogsDir(), path.join(TMP, 'override-log'), '__setLogDirOverride still wins too');
  __setLogDirOverride(null);

  // ANTI-VACUITY: with NO seam set at all, the real location is still the real
  // location — this change must not have moved the log for actual users.
  const savedUD = process.env.CURATOR_TEST_USER_DATA_DIR;
  delete process.env.CURATOR_TEST_USER_DATA_DIR;
  eq(getLogsDir(), path.join(os.homedir(), 'Library', 'Logs', 'The Curator'),
    'with no seam set, a real install still logs to ~/Library/Logs/The Curator');
  process.env.CURATOR_TEST_USER_DATA_DIR = savedUD;
  eq(getLogsDir(), path.join(TMP_USER, 'logs'), 'and the seam takes effect again immediately');
}

// ═══ §7 — F-02 at the ROUTE: a real multi-domain push over SSE ════════════
section('7. F-02 — POST /:id/push re-reads the connection per domain');
{
  // The queue MERGE is proven at the module level in
  // test-sharedbrain-queue-scope.js §1. This section proves the OTHER half,
  // which only the route has: it must re-read the connection between domains,
  // and it must pin `last_push_at` and the clock for the whole run.
  //
  // ONE assertion catches all three, and that is why it is written this way:
  //
  //   - no re-read      → beta's write is computed from alpha's PRE-push
  //                       snapshot and alpha's entry disappears;
  //   - no baseline pin → beta scans from the watermark ALPHA just advanced
  //                       to, so beta's own page reads as unchanged and is
  //                       never queued at all;
  //   - no merge        → alpha's entry is replaced wholesale.
  //
  // Each failure mode removes a DIFFERENT one of the two expected keys, so
  // both are asserted, and a control below proves the fixture can produce them.
  const A = 'alpha-src', B = 'beta-src';
  const storage = path.join(TMP, 'push-store');
  mkdirSync(storage, { recursive: true });
  for (const d of [A, B]) {
    mkdirSync(path.join(TMP_DOMAINS, d, 'wiki', 'entities'), { recursive: true });
    writeFileSync(path.join(TMP_DOMAINS, d, 'CLAUDE.md'), `# ${d}\n`);
    writeFileSync(path.join(TMP_DOMAINS, d, 'wiki', 'entities', 'kestrel.md'),
      `# Kestrel in ${d}\n\n## Key Facts\n- Twelve clusters.\n`);
  }

  // Every delta call answers with text that cannot be parsed as JSON, so every
  // page fails pre-processing and every page is QUEUED. Failure is the state
  // this defect lives in, so it is the state the fixture creates.
  let deltaCalls = 0;
  __setAnthropicClientFactory(() => ({
    messages: {
      stream: () => {
        deltaCalls++;
        return { finalMessage: () => Promise.resolve({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'not json { at all' }],
          usage: { input_tokens: 5, output_tokens: 5 },
        }) };
      },
    },
  }));

  const PUSH_ID = randomUUID();
  saveSharedBrain(baseConn({
    id: PUSH_ID, label: 'Two sources', storage_type: 'local',
    local_storage_path: storage, shared_domain: 'pushtest',
    shared_brain_slug: 'pushtest', local_domains: [A, B],
    github_repo_owner: undefined, github_repo_name: undefined,
    github_pat: undefined, github_branch: undefined,
  }));

  const res = await fetch(`${BASE}/api/sharedbrain/${PUSH_ID}/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  await res.text();   // drain the SSE stream to completion

  ok(deltaCalls >= 2, 'control: the push really ran a delta call for each domain',
     `deltaCalls=${deltaCalls}`);

  const after = getSharedBrainWithToken(PUSH_ID);
  const keys = Object.keys(after.pending_retry || {}).sort();
  ok(keys.includes(`${A}/entities/kestrel.md`),
    'ALPHA\'S ENTRY SURVIVED the second domain\'s write (re-read + merge)',
    `pending_retry = ${JSON.stringify(after.pending_retry)}`);
  ok(keys.includes(`${B}/entities/kestrel.md`),
    'BETA\'S OWN PAGE WAS SCANNED AT ALL (the baseline was pinned for the run)',
    `pending_retry = ${JSON.stringify(after.pending_retry)}`);
  eq(keys.length, 2, 'exactly the two pages, one entry each — no collision, no loss');
  ok(typeof after.last_push_at === 'string', 'and the watermark did advance once the run finished');

  await req('DELETE', `/api/sharedbrain/${PUSH_ID}`);
}

// ═══ Isolation proof ══════════════════════════════════════════════════════
section('6. Isolation — the real files were never touched');
{
  eq(fingerprint(), FINGERPRINT_BEFORE,
    'the real .curator-config.json / .sync-config.json / .sharedbrain-config.json are byte-identical');
  const after = existsSync(REAL_LOG) ? readFileSync(REAL_LOG).length : null;
  eq(after, REAL_LOG_BEFORE, 'the maintainer\'s real curator.log did not grow by one byte');
  ok(routesT.adminTokenGate !== undefined, 'the shared admin-token gate is exported for reuse');
}

server.close();
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(`\n══════════════════════════════════════`);
console.log(`  Total: ${passed + failed}   Passed: ${passed}   Failed: ${failed}`);
console.log(`══════════════════════════════════════\n`);
if (failed > 0) {
  console.log('FAILURES:');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
