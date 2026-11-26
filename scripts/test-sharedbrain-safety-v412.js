/**
 * test-sharedbrain-safety-v412.js — OFFLINE suite (v4.1.2)
 *
 * The Shared Brain findings of the 2026-11-26 setup-flow audit, each driven
 * through the REAL code (the express router on a real HTTP server, the real
 * pullCollective against a real local store, the wizard's own functions lifted
 * from its live source and executed). Nothing is asserted from source text.
 *
 *   §1 B1 CRITICAL — a Pull deleted the user's own pages in an existing
 *      `shared-<slug>` folder that had no CLAUDE.md: the adoption refusal ran
 *      only when CLAUDE.md existed, the creation step then wrote the mirror
 *      marker, and the prune removed every page the collective did not send.
 *   §2 B3 — POST /save with an existing id replaced the record unchecked: a
 *      contributor could plant an admin token (then revoke and rotate
 *      accepted it), erase a stored one, or take another member's fellow_id.
 *   §3 B5/B7 — POST /validate-pat: no timeout, a rate-limited 403 read as a
 *      rejected token, no shape check (a token with a newline was echoed in
 *      the answer and to stderr), no code.
 *   §4 B4 — an invite whose name holds a newline passed step 1 and failed at
 *      step 5, after the person had made a GitHub token; no length cap.
 *   §5 B8 — Leave (DELETE /:id) answered 200 while that connection's Pull ran.
 *   §6 W3 — the two git calls in loadPriorContent passed no windowsHide.
 *   §7 B6/B9 — the wizard: Create mode spoke to a contributor and let an admin
 *      continue with a read-only token; an empty ADMIN TOKEN row on join step
 *      5; a doubled "Update The Curator" sentence.
 *
 * Every refusal is paired with an ACCEPTANCE on the same path, and every
 * refusal asserts the STATE after it (files byte-identical, config sha256
 * unchanged), because a route that refuses while still mutating is the shape
 * that matters here.
 *
 * ISOLATION: CURATOR_TEST_USER_DATA_DIR, CURATOR_TEST_DOMAINS_DIR, a fake HOME
 * and CURATOR_NO_OPEN are set before any app module loads; domains go through
 * __setDomainsDirOverride. GitHub is a fake on 127.0.0.1 (the loopback-only
 * CURATOR_TEST_GITHUB_API seam). No network, no LLM.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// ── Isolation FIRST ────────────────────────────────────────────────────────
const TMP = mkdtempSync(path.join(os.tmpdir(), 'curator-sb412-'));
const TMP_USER = path.join(TMP, 'userdata');
const TMP_DOMAINS = path.join(TMP, 'domains');
const TMP_HOME = path.join(TMP, 'home');
const STORE = path.join(TMP, 'store');
for (const d of [TMP_USER, TMP_DOMAINS, TMP_HOME, STORE]) mkdirSync(d, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = TMP_USER;
process.env.CURATOR_TEST_DOMAINS_DIR = TMP_DOMAINS;
process.env.HOME = TMP_HOME;
process.env.CURATOR_NO_OPEN = '1';
delete process.env.DOMAINS_PATH;
delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENROUTER_API_KEY;

// §6 needs to see the options every execFile call receives. sharedbrain.js
// promisifies execFile at load time, so the recorder goes in BEFORE it loads.
const require = createRequire(import.meta.url);
const cp = require('node:child_process');
const realExecFile = cp.execFile;
const realExecFileP = promisify(realExecFile);
const execFileCalls = [];
function recordingExecFile(...args) {
  execFileCalls.push(args);
  return realExecFile.apply(this, args);
}
recordingExecFile[promisify.custom] = (...args) => { execFileCalls.push(args); return realExecFileP(...args); };
cp.execFile = recordingExecFile;
syncBuiltinESMExports();

const express = (await import('express')).default;
const { default: sharedBrainRouter, __testing: routesT } = await import('../src/routes/sharedbrain.js');
const { __setDomainsDirOverride, setSharedBrainEnabled } = await import('../src/brain/config.js');
const { getSharedBrainWithToken } = await import('../src/brain/sharedbrain-config.js');
const { pullCollective, loadPriorContent } = await import('../src/brain/sharedbrain.js');
const { LocalFolderStorageAdapter } = await import('../src/brain/sharedbrain-local-adapter.js');
const { registerWrite } = await import('../src/brain/write-registry.js');
await import('./test-helpers/net-globals.js');

__setDomainsDirOverride(TMP_DOMAINS);
setSharedBrainEnabled(true);

// ── Harness ────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];
function ok(cond, label, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; failures.push(label); console.log(`  ✗ ${label}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); }
}
function eq(a, b, label) { ok(a === b, label, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); }
function section(t) { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 68 - t.length))}`); }
const sha = (f) => existsSync(f) ? createHash('sha256').update(readFileSync(f)).digest('hex') : 'absent';
const CFG = path.join(TMP_USER, '.sharedbrain-config.json');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api/sharedbrain', sharedBrainRouter);
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const BASE = `http://127.0.0.1:${server.address().port}/api/sharedbrain`;
async function req(method, p, body) {
  const init = { method };
  if (body !== undefined) { init.headers = { 'Content-Type': 'application/json' }; init.body = JSON.stringify(body); }
  const r = await fetch(BASE + p, init);
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* SSE or text */ }
  return { status: r.status, body: json, text };
}
const sseFrames = (t) => t.split('\n').filter((l) => l.startsWith('data: ')).map((l) => { try { return JSON.parse(l.slice(6)); } catch { return {}; } });

const localConn = (slug, extra = {}) => ({
  label: 'Cohort ' + slug, storage_type: 'local', local_storage_path: STORE,
  fellow_display_name: 'Ana', shared_domain: slug, shared_brain_slug: slug,
  local_domains: [], attribute_by_name: false, read_only: false, enabled: true, ...extra,
});
const storeAdapter = new LocalFolderStorageAdapter({ storage_root: STORE });
async function stage(sharedDomain) {
  await storeAdapter.writePage(sharedDomain, 'concepts/collective-page.md', '# Collective Page\n\nFrom the cohort.\n');
}
const patchFn = () => null;

try {
  // ═══ §1 — B1: a Pull never deletes a person's own pages ═══════════════════
  section('1. B1 — an existing shared-<slug> folder without CLAUDE.md is refused');
  {
    await stage('foo');
    const mineA = path.join(TMP_DOMAINS, 'shared-foo/wiki/concepts/my-own-note.md');
    const mineB = path.join(TMP_DOMAINS, 'shared-foo/wiki/entities/my-person.md');
    mkdirSync(path.dirname(mineA), { recursive: true });
    mkdirSync(path.dirname(mineB), { recursive: true });
    writeFileSync(mineA, '# My own note\n\nWritten by hand in Obsidian.\n');
    writeFileSync(mineB, '# My person\n');
    const before = [sha(mineA), sha(mineB)];

    // Through the REAL route, which takes the mirror's .write-lock first.
    const saved = await req('POST', '/save', { connection: localConn('foo') });
    eq(saved.status, 200, 'control: the connection saves');
    const pull = await req('POST', `/${saved.body.connection.id}/pull`);
    const frames = sseFrames(pull.text);
    ok(frames.some((f) => f.type === 'error' && /Refusing to pull into "shared-foo"/.test(f.message || '')),
      'the Pull answers with a refusal naming the folder', frames.map((f) => f.type + ':' + (f.message || '').slice(0, 80)));
    ok(!frames.some((f) => /Removed /.test(f.message || '')), 'and removes nothing');
    eq(sha(mineA), before[0], 'concepts/my-own-note.md is byte-identical');
    eq(sha(mineB), before[1], 'entities/my-person.md is byte-identical');
    ok(!existsSync(path.join(TMP_DOMAINS, 'shared-foo/CLAUDE.md')), 'no mirror CLAUDE.md was written into it');
    ok(!existsSync(path.join(TMP_DOMAINS, 'shared-foo/wiki/index.md')), 'no index.md was written into it');
    ok(!existsSync(path.join(TMP_DOMAINS, 'shared-foo/wiki/concepts/collective-page.md')), 'no collective page was merged into it');
    ok(!existsSync(path.join(TMP_DOMAINS, 'shared-foo/.write-lock')), 'the route released its lock');
    await req('DELETE', `/${saved.body.connection.id}`);

    // A single file anywhere, even outside the three page folders, is someone's.
    await stage('notes');
    const loose = path.join(TMP_DOMAINS, 'shared-notes/ideas.txt');
    mkdirSync(path.dirname(loose), { recursive: true });
    writeFileSync(loose, 'mine');
    const r2 = await pullCollective({ ...localConn('notes'), id: randomUUID(), fellow_id: randomUUID() }, { domainsDir: TMP_DOMAINS, patchFn });
    ok(r2.ok === false && /holds files/.test(r2.error || ''), 'a folder holding any other file is refused too', r2.error);
    ok(readdirSync(path.join(TMP_DOMAINS, 'shared-notes')).join(',') === 'ideas.txt', 'and is left exactly as it was');

    // ACCEPTANCE: what an interrupted first creation leaves (empty folders),
    // plus OS litter and the app's own lock, is still initialised and pulled.
    await stage('bar');
    for (const f of ['wiki/entities', 'wiki/concepts', 'wiki/summaries', 'raw']) mkdirSync(path.join(TMP_DOMAINS, 'shared-bar', f), { recursive: true });
    writeFileSync(path.join(TMP_DOMAINS, 'shared-bar/.DS_Store'), 'x');
    writeFileSync(path.join(TMP_DOMAINS, 'shared-bar/wiki/Thumbs.db'), 'x');
    const r3 = await pullCollective({ ...localConn('bar'), id: randomUUID(), fellow_id: randomUUID() }, { domainsDir: TMP_DOMAINS, patchFn });
    ok(r3.ok !== false, 'control: a folder of empty directories and OS litter is initialised and pulled', r3.error);
    ok(existsSync(path.join(TMP_DOMAINS, 'shared-bar/wiki/concepts/collective-page.md')), 'and the collective page landed');
    ok(/source: shared-brain/.test(readFileSync(path.join(TMP_DOMAINS, 'shared-bar/CLAUDE.md'), 'utf8')), 'with the mirror marker');

    // ACCEPTANCE through the route: no folder at all (the ordinary first Pull).
    await stage('fresh');
    const s4 = await req('POST', '/save', { connection: localConn('fresh') });
    const p4 = sseFrames((await req('POST', `/${s4.body.connection.id}/pull`)).text);
    ok(p4.some((f) => f.type === 'done'), 'control: a first Pull with no folder completes through the route', p4.map((f) => f.type));
    ok(existsSync(path.join(TMP_DOMAINS, 'shared-fresh/wiki/concepts/collective-page.md')), 'and writes the mirror');
    await req('DELETE', `/${s4.body.connection.id}`);

    // The prune itself still works on a GENUINE mirror (read-only by design).
    const stale = path.join(TMP_DOMAINS, 'shared-bar/wiki/concepts/gone-from-collective.md');
    writeFileSync(stale, '# Gone\n');
    const r5 = await pullCollective({ ...localConn('bar'), id: randomUUID(), fellow_id: randomUUID() }, { domainsDir: TMP_DOMAINS, patchFn });
    ok(r5.ok !== false && !existsSync(stale), 'control: a genuine mirror still drops a page the collective no longer has');

    // The v3.43.0 refusal (a personal CLAUDE.md) is unchanged.
    await stage('own');
    mkdirSync(path.join(TMP_DOMAINS, 'shared-own/wiki/concepts'), { recursive: true });
    writeFileSync(path.join(TMP_DOMAINS, 'shared-own/CLAUDE.md'), '# my schema\n');
    const keep = path.join(TMP_DOMAINS, 'shared-own/wiki/concepts/keep.md');
    writeFileSync(keep, '# keep\n');
    const r6 = await pullCollective({ ...localConn('own'), id: randomUUID(), fellow_id: randomUUID() }, { domainsDir: TMP_DOMAINS, patchFn });
    ok(r6.ok === false && /NOT a Shared Brain mirror/.test(r6.error || '') && existsSync(keep), 'a folder with a personal CLAUDE.md is still refused');
  }

  // ═══ §2 — B3: an update keeps who the connection is ══════════════════════
  section('2. B3 — /save on an existing id cannot plant, erase or swap identity');
  {
    const member = await req('POST', '/save', { connection: localConn('cohort-b3', { shared_domain: 'b3' }) });
    eq(member.status, 200, 'control: a contributor connection saves');
    const mid = member.body.connection.id;
    const mfellow = member.body.connection.fellow_id;
    const planted = 'sbat_' + 'c'.repeat(40);

    let h = sha(CFG);
    const plant = await req('POST', '/save', { connection: { ...localConn('cohort-b3', { shared_domain: 'b3' }), id: mid, fellow_id: mfellow, admin_token: planted } });
    eq(plant.status, 403, 'planting an admin token on a contributor connection is refused');
    eq(plant.body && plant.body.code, 'no_admin_token', 'with code no_admin_token');
    eq(sha(CFG), h, 'and .sharedbrain-config.json is sha256-identical');
    const rv = await req('POST', `/${mid}/revoke`, { admin_token: planted, fellow_id: 'not-a-uuid', confirmation: 'x' });
    eq(rv.status, 403, 'revoke with the made-up token is refused at the gate (403, not 400)');
    eq((await req('POST', `/${mid}/admin-token/rotate`, { admin_token: planted })).status, 403, 'rotate with it is refused');

    const victim = randomUUID();
    h = sha(CFG);
    const swap = await req('POST', '/save', { connection: { ...localConn('cohort-b3', { shared_domain: 'b3' }), id: mid, fellow_id: victim } });
    eq(swap.status, 400, 'changing fellow_id on an existing connection is refused');
    eq(sha(CFG), h, 'and the config is sha256-identical');
    eq(getSharedBrainWithToken(mid).fellow_id, mfellow, 'the stored fellow_id is the original');

    const relabel = await req('POST', '/save', { connection: { ...localConn('cohort-b3', { shared_domain: 'b3' }), id: mid, label: 'Renamed' } });
    eq(relabel.status, 200, 'control: an ordinary update (no fellow_id sent) still saves');
    eq(getSharedBrainWithToken(mid).label, 'Renamed', 'and changes the label');
    eq(getSharedBrainWithToken(mid).fellow_id, mfellow, 'keeping the fellow_id');

    // The admin: the token arrives at CREATION, as the Create wizard sends it.
    const adminTok = 'sbat_' + 'a'.repeat(40);
    const admin = await req('POST', '/save', { connection: localConn('cohort-adm', { shared_domain: 'adm', admin_token: adminTok }) });
    eq(admin.status, 200, 'control: a NEW connection may carry an admin token (the Create wizard)');
    const aid = admin.body.connection.id;
    const afellow = admin.body.connection.fellow_id;
    const gatePasses = async (tok) => (await req('POST', `/${aid}/revoke`, { admin_token: tok, fellow_id: 'not-a-uuid', confirmation: 'x' })).status === 400;
    ok(await gatePasses(adminTok), 'control: the revoke gate accepts the real admin token');

    eq((await req('POST', '/save', { connection: { ...localConn('cohort-adm', { shared_domain: 'adm' }), id: aid } })).status, 200, 'an update that omits the admin token saves');
    eq(getSharedBrainWithToken(aid).admin_token, adminTok, 'and KEEPS the stored admin token (no silent erase)');
    eq((await req('POST', '/save', { connection: { ...localConn('cohort-adm', { shared_domain: 'adm' }), id: aid, admin_token: null } })).status, 200, 'an update sending admin_token:null saves');
    eq(getSharedBrainWithToken(aid).admin_token, adminTok, 'and keeps it too');
    h = sha(CFG);
    const other = await req('POST', '/save', { connection: { ...localConn('cohort-adm', { shared_domain: 'adm' }), id: aid, fellow_id: afellow, admin_token: 'sbat_' + 'd'.repeat(40) } });
    eq(other.status, 403, 'an update with a DIFFERENT admin token is refused (rotate is the way)');
    eq(other.body && other.body.code, 'admin_token_mismatch', 'with code admin_token_mismatch');
    eq(sha(CFG), h, 'and the config is sha256-identical');
    eq((await req('POST', '/save', { connection: { ...localConn('cohort-adm', { shared_domain: 'adm' }), id: aid, admin_token: adminTok } })).status, 200, 'control: resending the same admin token saves');
    const rot = await req('POST', `/${aid}/admin-token/rotate`, { admin_token: adminTok });
    eq(rot.status, 200, 'control: rotate with the real token still works');
    ok(await gatePasses(rot.body.admin_token) && !(await gatePasses(adminTok)), 'and the gate follows the rotated token');
    await req('DELETE', `/${mid}`); await req('DELETE', `/${aid}`);
  }

  // ═══ §3 — B5/B7: the wizard's token check ═════════════════════════════════
  section('3. B5/B7 — /validate-pat: shape, timeout, rate limit, codes, no echo');
  {
    const hung = [];
    const fake = http.createServer((rq, rs) => {
      const m = rq.url.match(/^\/repos\/acme\/([^/?]+)/);
      const which = m ? m[1] : '';
      const json = (status, body, headers = {}) => { rs.writeHead(status, { 'Content-Type': 'application/json', ...headers }); rs.end(JSON.stringify(body)); };
      if (which === 'ok') return json(200, { id: 1, full_name: 'acme/ok', private: true, permissions: { push: true } });
      if (which === 'ro') return json(200, { id: 2, full_name: 'acme/ro', permissions: { push: false } });
      if (which === 'nope') return json(404, { message: 'Not Found' });
      if (which === 'bad') return json(401, { message: 'Bad credentials' });
      if (which === 'limited') return json(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' });
      if (which === 'hang') { hung.push(rs); return; }
      return json(500, { message: 'boom' });
    });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    process.env.CURATOR_TEST_GITHUB_API = `http://127.0.0.1:${fake.address().port}`;
    const PAT = 'github_pat_' + 'A'.repeat(30);
    const v = (repo, pat = PAT) => req('POST', '/validate-pat', { repo, pat });

    const okA = await v('acme/ok');
    ok(okA.body.valid === true && okA.body.hasWriteAccess === true && okA.body.repoFullName === 'acme/ok', 'a write token: valid, write access', okA.body);
    const ro = await v('acme/ro');
    ok(ro.body.valid === true && ro.body.hasWriteAccess === false, 'a read-only token: valid, no write access');
    const nope = await v('acme/nope');
    ok(nope.body.valid === false && nope.body.code === 'sharedbrain-pat-no-access' && /Repository not found/.test(nope.body.error), '404: no-access, the same sentence', nope.body);
    const bad = await v('acme/bad');
    ok(bad.body.valid === false && bad.body.code === 'sharedbrain-pat-rejected' && /GitHub rejected the token/.test(bad.body.error), '401: rejected, the same sentence');
    const lim = await v('acme/limited');
    ok(lim.body.valid === false && lim.body.code === 'sharedbrain-pat-rate-limited' && !/rejected/i.test(lim.body.error), 'a rate-limited 403 is NOT called a rejected token', lim.body);
    const five = await v('acme/other');
    ok(five.body.valid === false && five.body.code === 'sharedbrain-pat-check-failed' && /GitHub returned 500/.test(five.body.error), '5xx: check failed, the same sentence');

    routesT.setValidatePatTimeoutMs(400);
    const t0 = Date.now();
    // The test's own 8 s ceiling: without the route's timeout this request
    // would wait minutes, and that must read as a red check, not a stuck suite.
    let hang;
    try {
      const r = await fetch(BASE + '/validate-pat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo: 'acme/hang', pat: PAT }), signal: AbortSignal.timeout(8000) });
      hang = { status: r.status, body: await r.json() };
    } catch (e) { hang = { status: 0, body: { error: 'no answer within 8 s: ' + e.name } }; }
    const took = Date.now() - t0;
    ok(hang.status === 502 && hang.body.code === 'sharedbrain-pat-check-timeout' && hang.body.valid === false, 'a GitHub that never answers times out', hang.body);
    ok(took < 5000, `and the answer comes back promptly (${took} ms)`);
    routesT.setValidatePatTimeoutMs(30000);
    for (const rs of hung) rs.destroy();

    // B7: a token holding a newline is refused before any fetch and never echoed.
    const secret = 'github_pat_SECRET' + 'Z'.repeat(20);
    const logged = [];
    const origErr = console.error;
    console.error = (...a) => { logged.push(a.join(' ')); };
    let nl, ws;
    try {
      nl = await v('acme/ok', secret + '\nInjected: yes');
      ws = await v('acme/ok', secret + ' tail');
    } finally { console.error = origErr; }
    ok(nl.status === 400 && nl.body.code === 'sharedbrain-pat-invalid' && nl.body.valid === false, 'a token with a newline: 400 sharedbrain-pat-invalid', nl.body);
    ok(!nl.text.includes('SECRET') && !ws.text.includes('SECRET'), 'the answer does not contain the token');
    ok(!logged.some((l) => l.includes('SECRET')), 'nothing logged contains the token');
    eq(ws.body && ws.body.code, 'sharedbrain-pat-invalid', 'a token with a space is refused the same way');

    const s400 = await v('acme/ok', 'short');
    ok(s400.status === 400 && s400.body.code === 'sharedbrain-pat-invalid', 'a short token: 400 with a code');
    const r400 = await req('POST', '/validate-pat', { repo: 'nope', pat: PAT });
    ok(r400.status === 400 && r400.body.code === 'sharedbrain-pat-repo-invalid', 'a bad repo: 400 with a code');

    await new Promise((r) => fake.close(r));
    const off = await v('acme/ok'); // the fake is gone: connection refused
    ok(off.status === 502 && off.body.code === 'sharedbrain-pat-check-offline' && !off.text.includes(PAT), 'GitHub unreachable: 502 offline, no token in the answer', off.body);
    delete process.env.CURATOR_TEST_GITHUB_API;
  }

  // ═══ §4 — B4: a multi-line or oversized brain name is refused at step 1 ═══
  section('4. B4 — the invite name is one line, at most 200 characters');
  {
    const b64u = (o) => 'sbi_' + Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const good = { v: 1, storage_type: 'github', repo: 'acme/cohort', name: 'Cohort One', shared_domain: 'cohort', branch: 'main', data_handling_terms: 'contributor_retains' };
    const p = (o) => req('POST', '/parse-invite', { token: b64u(o) });
    eq((await p(good)).body.valid, true, 'control: an ordinary invite parses');
    const nl = await p({ ...good, name: 'Cohort\nOne' });
    ok(nl.status === 400 && nl.body.valid === false && /single line/.test(nl.body.error), 'a name holding a newline is refused at step 1', nl.body);
    eq((await p({ ...good, name: 'x'.repeat(200) })).body.valid, true, 'control: a 200-character name parses');
    eq((await p({ ...good, name: 'x'.repeat(201) })).status, 400, 'a 201-character name is refused');
    let threw = null;
    try { routesT.encodeInviteToken({ repo: 'acme/cohort', name: 'A\nB', shared_domain: 'cohort' }); } catch (e) { threw = e; }
    ok(threw && /single line/.test(threw.message), 'and an admin cannot mint one either');
    let threw2 = null;
    try { routesT.encodeInviteToken({ repo: 'acme/cohort', name: 'x'.repeat(201), shared_domain: 'cohort' }); } catch (e) { threw2 = e; }
    ok(threw2 && /at most 200/.test(threw2.message), 'nor a 201-character one');
    ok(typeof routesT.encodeInviteToken({ repo: 'acme/cohort', name: 'x'.repeat(200), shared_domain: 'cohort' }) === 'string', 'control: a 200-character name mints');
  }

  // ═══ §5 — B8: Leave waits for this connection's own work ══════════════════
  section('5. B8 — DELETE /:id refuses while this connection’s Pull runs');
  {
    const s = await req('POST', '/save', { connection: localConn('leaver', { shared_domain: 'leaver', local_domains: [] }) });
    const id = s.body.connection.id;
    const release = registerWrite('shared-leaver', 'sharedbrain-pull');
    let d;
    try { d = await req('DELETE', `/${id}`); } finally { release(); }
    eq(d.status, 409, 'Leave during this connection’s Pull: 409');
    ok(!!getSharedBrainWithToken(id), 'and the connection is still there');
    const unrelated = registerWrite('some-other-domain', 'ingest');
    let d2;
    try { d2 = await req('DELETE', `/${id}`); } finally { unrelated(); }
    eq(d2.status, 200, 'control: an unrelated ingest does not block Leave');
    ok(!getSharedBrainWithToken(id), 'and the connection is removed');
  }

  // ═══ §6 — W3: no console window per git call on Windows ═══════════════════
  section('6. W3 — loadPriorContent’s git calls pass windowsHide');
  {
    const repo = path.join(TMP_USER, '.knowledge-git'); // getSyncGitDir(), isolated
    const work = path.join(TMP, 'work');
    mkdirSync(path.join(work, 'd/wiki/concepts'), { recursive: true });
    writeFileSync(path.join(work, 'd/wiki/concepts/p.md'), '# P\n\nold\n');
    const g = (...a) => execFileSync('git', [`--git-dir=${repo}`, `--work-tree=${work}`, ...a], { stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z' } });
    execFileSync('git', ['init', '-q', '--bare', repo]);
    g('add', '-A');
    g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'one');
    execFileCalls.length = 0;
    const prior = await loadPriorContent(work, 'd', 'concepts/p.md', new Date('2021-01-01T00:00:00Z'));
    const gitCalls = execFileCalls.filter((a) => Array.isArray(a[1]) && a[1].some((x) => String(x).startsWith('--git-dir=')));
    ok(typeof prior === 'string' && prior.includes('old'), 'control: the prior version is read through git', prior);
    ok(gitCalls.length >= 2, `both git calls went through execFile (${gitCalls.length})`);
    ok(gitCalls.length > 0 && gitCalls.every((a) => a[2] && a[2].windowsHide === true), 'every one passes windowsHide: true');
  }

  // ═══ §7 — B6/B9: the wizard, its own functions executed ═══════════════════
  section('7. B6/B9 — the wizard speaks to an admin; no empty admin row; one "Update"');
  {
    const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const src = readFileSync(path.join(ROOT, 'src/public/next/views/shared-brain-wizard.js'), 'utf8');
    const lift = (name) => {
      const m = new RegExp(`\\nfunction ${name}\\s*\\(`).exec(src);
      if (!m) throw new Error('not found: ' + name);
      let i = src.indexOf('{', src.indexOf(')', m.index)), depth = 0;
      for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } } }
      return src.slice(m.index + 1, i);
    };
    const patVerdict = new Function(lift('patVerdict') + '\nreturn patVerdict;')();
    const meta = { repo: 'acme/brain' };
    const roCreate = patVerdict({ valid: true, hasWriteAccess: false }, meta, 'create');
    ok(roCreate.kind === 'error' && /As the admin you need write access/.test(roCreate.message), 'Create: a read-only token is an error that blocks Continue, in an admin’s words', roCreate);
    const roJoin = patVerdict({ valid: true, hasWriteAccess: false }, meta, 'join');
    ok(roJoin.kind === 'warn' && /read-only member/.test(roJoin.message), 'control: Join keeps the read-only member warning');
    const nfCreate = patVerdict({ valid: false, code: 'sharedbrain-pat-no-access', error: 'Repository not found … ask the admin …' }, meta, 'create');
    ok(nfCreate.kind === 'error' && !/ask the admin/i.test(nfCreate.message) && /repository you typed/.test(nfCreate.message), 'Create: a 404 points at the repository the admin typed, never "ask the admin"', nfCreate);
    const nfJoin = patVerdict({ valid: false, code: 'sharedbrain-pat-no-access', error: 'Repository not found … ask the admin …' }, meta, 'join');
    ok(/ask the admin/.test(nfJoin.message), 'control: Join keeps the server’s sentence');
    eq(patVerdict({ valid: true, hasWriteAccess: true, repoFullName: 'acme/brain' }, meta, 'create').kind, 'ok', 'control: Create with a write token is ok');

    const plainInviteError = new Function('plainError', lift('plainInviteError') + '\nreturn plainInviteError;')(globalThis.plainError);
    const future = plainInviteError('Invite token uses version 9; this Curator install supports up to v1. Update The Curator.');
    eq((future.match(/Update The Curator/g) || []).length, 1, '"Update The Curator" is said once');
    ok(/Settings → Updates/.test(future), 'and still says where');

    const mkEl = () => ({ textContent: '', hidden: false, cls: new Set(['sbw-hidden']), classList: null });
    const els = {};
    for (const f of ['name', 'folder', 'mirror', 'admin-token-dt', 'admin-token', 'repo', 'domains', 'attribution', 'display-name']) {
      const e = mkEl(); e.classList = { toggle: (c, on) => { if (on) e.cls.add(c); else e.cls.delete(c); } }; els[f] = e;
    }
    const box = { querySelector: (sel) => { const m = sel.match(/data-field="([^"]+)"/); return m ? els[m[1]] || null : null; } };
    const run = (state) => new Function('state', 'byId', 'mirrorSlugForName', 'isReadOnlyVerdict', lift('populateReview') + '\npopulateReview();')(
      state, () => ({ querySelector: () => box }), () => 'cohort', () => false);
    run({ inviteMetadata: { name: 'Cohort', repo: 'acme/c', shared_domain: 'c' }, mode: 'join', selectedDomains: new Set() });
    ok(els['admin-token-dt'].hidden === true && els['admin-token'].hidden === true, 'Join step 5: the ADMIN TOKEN row is hidden (attribute, not only a class)');
    run({ inviteMetadata: { name: 'Cohort', repo: 'acme/c', shared_domain: 'c' }, mode: 'create', generatedAdminToken: 'sbat_x', selectedDomains: new Set() });
    ok(els['admin-token-dt'].hidden === false && els['admin-token'].hidden === false && /stored on this computer/.test(els['admin-token'].textContent), 'control: Create step 5 shows it');
  }
} catch (err) {
  failed++; failures.push('suite threw: ' + (err && err.stack || err));
  console.log('  ✗ suite threw: ' + (err && err.stack || err));
} finally {
  cp.execFile = realExecFile; syncBuiltinESMExports();
  await new Promise((r) => server.close(r));
  rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
