#!/usr/bin/env node
/**
 * test-sync-sb-truth.js — OFFLINE. v3.72.1, the "true numbers" release:
 * every number the Sync page, the rail badge, the Shared Brain section and
 * the menubar tray show must come from the true current source.
 *
 * Each section drives the REAL code against a reproduction of the finding it
 * pins (truth audit, part-sync-sb-shell.md / part-tray-copy.md):
 *
 *   §1  sync F1   "last synced" is the recorded time of a successful sync,
 *                 never the newest commit's date (a fast-forward pull of an
 *                 OLD commit, a push that failed after its commit).
 *   §2  sync F2   the pending count (the rail badge's field) counts files in
 *                 commits that were never pushed, and a new folder by file.
 *   §3  SB F8/9/10/13  distinct member pages; `last_contribution_at` only
 *                 when a contribution was written; an uncountable pending is
 *                 null, never 0; retries are a subset of pending.
 *   §4  SB F5/F6  runSseAction refreshes the connection list and the cohort
 *                 panel after a PARTLY failed push (error frame, then done).
 *   §5  sync view F2/F11/F14 + SB labels — the lifted real render helpers.
 *   §6  tray F1/F5/F7 — one busiest-project figure for the tray and the app;
 *                 the capture label from the payload's window; the stamp is
 *                 the read time.
 *
 * ISOLATION: CURATOR_TEST_USER_DATA_DIR + CURATOR_TEST_DOMAINS_DIR set before
 * any app module is imported; sync.js's git dir and config file redirected to
 * a tempdir; every "remote" is a local `git init --bare`. The real credential
 * files are fingerprinted at both ends.
 *
 * Run: node scripts/test-sync-sb-truth.js
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
const failures = [];
function ok(cond, label, extra) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; failures.push(label); console.log(`  ✗ ${label}${extra ? `\n        ${extra}` : ''}`); }
}
function eq(a, b, label) {
  ok(a === b, `${label} (got ${JSON.stringify(a)}${a === b ? '' : `, expected ${JSON.stringify(b)}`})`);
}
function section(t) { console.log(`\n${t}`); }

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'curator-truth-')));
const TMP_USER = path.join(TMP, 'userdata');
const TMP_DOMAINS = path.join(TMP, 'domains');
fs.mkdirSync(TMP_USER, { recursive: true });
fs.mkdirSync(TMP_DOMAINS, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = TMP_USER;
process.env.CURATOR_TEST_DOMAINS_DIR = TMP_DOMAINS;
delete process.env.DOMAINS_PATH;

const REAL_FILES = ['.curator-config.json', '.sync-config.json', '.sharedbrain-config.json']
  .map((f) => path.join(ROOT, f));
function fingerprint() {
  return REAL_FILES.map((f) => {
    if (!fs.existsSync(f)) return `${path.basename(f)}:absent`;
    const buf = fs.readFileSync(f);
    return `${path.basename(f)}:${buf.length}:${createHash('sha256').update(buf).digest('hex')}`;
  }).join('|');
}
const fpBefore = fingerprint();

const sh = (cmd, cwd, env) => execSync(cmd, { cwd, stdio: 'pipe', env: { ...process.env, ...(env || {}) } }).toString();

const sync = await import('../src/brain/sync.js');
const { __setDomainsDirOverride, getDomainsDir } = await import('../src/brain/config.js');
const sb = await import('../src/brain/sharedbrain.js');
const { LocalFolderStorageAdapter } = await import('../src/brain/sharedbrain-local-adapter.js');

function extractFunction(src, name, where) {
  const m = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ${name}\\s*\\(`).exec(src);
  if (!m) throw new Error(`extractFunction: "${name}" not found in ${where}`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  let i = src.indexOf('(', start);
  let pd = 0;
  for (; i < src.length; i++) { if (src[i] === '(') pd++; else if (src[i] === ')') { pd--; if (pd === 0) { i++; break; } } }
  i = src.indexOf('{', i);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const out = src.slice(start, i);
  if (!/\n\}$/.test(out)) throw new Error(`extractFunction: "${name}" desynced in ${where}`);
  return out.replace(/^export\s+/, '');
}
const R = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

try {
// ═══════════════════════════════════════════════════════════════════════════
section('§0  Isolation');
// ═══════════════════════════════════════════════════════════════════════════
ok(getDomainsDir() === TMP_DOMAINS, 'the resolved domains dir IS the tempdir');

// ── A real two-machine rig over a local bare remote ─────────────────────────
const remote = path.join(TMP, 'remote.git');
sh(`git init --bare -q "${remote}"`);
const domainsA = path.join(TMP, 'machineA-domains');
fs.mkdirSync(path.join(domainsA, 'research', 'wiki'), { recursive: true });
fs.writeFileSync(path.join(domainsA, 'research', 'CLAUDE.md'), 'schema\n');
fs.writeFileSync(path.join(domainsA, 'research', 'wiki', 'index.md'), '# Index\n');
__setDomainsDirOverride(domainsA);
const appA = path.join(TMP, 'appA');
fs.mkdirSync(appA, { recursive: true });
const gitDirA = path.join(appA, '.knowledge-git');
sync.__setSyncTestOverrides({ gitDir: gitDirA, configFile: path.join(appA, '.sync-config.json') });
const inA = (cmd) => sh(`git --git-dir="${gitDirA}" --work-tree="${domainsA}" ${cmd}`);

// ═══════════════════════════════════════════════════════════════════════════
section('§1  sync F1 — "last synced" is a recorded sync, not a commit date');
// ═══════════════════════════════════════════════════════════════════════════
{
  const t0 = Date.now();
  await sync.setup(`file://${remote}`, 'tok', 'push');
  // git needs an identity for the commits push()/pull() make.
  inA('config user.email a@a.a'); inA('config user.name A');
  const st = await sync.getStatus();
  ok(typeof st.lastSync === 'string' && Date.parse(st.lastSync) >= t0 - 1000 && Date.parse(st.lastSync) <= Date.now() + 1000,
    '1a: a successful connect (push mode) records lastSync at that moment', st.lastSync);
  eq(st.lastSync, inA(`config --get ${sync.__testing.LAST_SYNC_KEY}`).trim(),
    '1b: …read from the sync repo\'s own git config, the one place it is written');
  eq(st.changesCount, 0, '1c: CONTROL — nothing pending right after the first push');

  // Machine B pushes a commit whose committer date is years in the past.
  const cloneB = path.join(TMP, 'machineB');
  sh(`git clone -q -b main "${remote}" "${cloneB}"`);
  sh('git config user.email b@b.b && git config user.name B', cloneB);
  fs.writeFileSync(path.join(cloneB, 'research', 'wiki', 'from-b.md'), '# From B\n');
  const OLD = '2020-01-02T03:04:05Z';
  sh('git add -A && git commit -qm from-b', cloneB, { GIT_COMMITTER_DATE: OLD, GIT_AUTHOR_DATE: OLD });
  sh('git push -q origin HEAD:main', cloneB);

  const before = (await sync.getStatus()).lastSync;
  const t1 = Date.now();
  await new Promise((r) => setTimeout(r, 20));
  await sync.pull();
  const after = await sync.getStatus();
  const headDate = inA('log -1 --format=%cI').trim();
  ok(headDate.startsWith('2020-01-02'), '1d: CONTROL — the fast-forward really did move HEAD to B\'s 2020 commit', headDate);
  ok(Date.parse(after.lastSync) >= t1 && after.lastSync !== before,
    '1e: THE FIX — after the pull, lastSync is NOW (the pull), not 2020 (the other machine\'s commit)', after.lastSync);

  // A push whose `git push` fails AFTER its commit: lastSync must not move.
  fs.writeFileSync(path.join(domainsA, 'research', 'wiki', 'local.md'), '# Local\n');
  inA(`remote set-url origin "file://${path.join(TMP, 'no-such-remote.git')}"`);
  let threw = false;
  try { await sync.push(); } catch { threw = true; }
  ok(threw, '1f: CONTROL — the push really failed');
  const failed1 = await sync.getStatus();
  eq(failed1.lastSync, after.lastSync, '1g: THE FIX — a failed push leaves lastSync where the last real sync put it');
  ok(Date.parse(inA('log -1 --format=%cI').trim()) >= t1 - 2000,
    '1h: CONTROL — …although the failed push DID leave a fresh local commit (which the old field would have shown)');

  // ═══════════════════════════════════════════════════════════════════════════
  section('§2  sync F2 — the pending count sees unpushed commits and counts files');
  // ═══════════════════════════════════════════════════════════════════════════
  eq(failed1.uncommittedCount, 0, '2a: CONTROL — the failed push committed everything; `git status` alone reads 0');
  eq(failed1.unpushedCommits, 1, '2b: …but one commit is not on origin');
  eq(failed1.changesCount, 1, '2c: THE FIX — the badge field counts the file in that commit (was 0 → no badge)');

  fs.mkdirSync(path.join(domainsA, 'newdomain', 'wiki', 'concepts'), { recursive: true });
  for (const n of ['a', 'b', 'c']) fs.writeFileSync(path.join(domainsA, 'newdomain', 'wiki', 'concepts', `${n}.md`), `# ${n}\n`);
  const porcelainLines = inA('status --porcelain').split('\n').filter(Boolean).length;
  const st2 = await sync.getStatus();
  eq(porcelainLines, 1, '2d: CONTROL — `git status --porcelain` shows the new folder as ONE line');
  eq(st2.uncommittedCount, 3, '2e: THE FIX — the three new files count as three');
  eq(st2.changesCount, 4, '2f: …and the total is the union: 3 uncommitted + 1 in the unpushed commit');

  // Pull only auto-commits and never pushes — the badge must stay.
  inA(`remote set-url origin "file://${remote}"`);
  await sync.pull();
  const st3 = await sync.getStatus();
  eq(st3.uncommittedCount, 0, '2g: CONTROL — after Pull only everything is committed');
  eq(st3.changesCount, 4, '2h: THE FIX — …and all 4 files are still reported as not on GitHub');

  const r = await sync.push();
  eq(r.filesChanged, st3.changesCount, '2i: the push reports EXACTLY the number the badge promised (one formula)');
  const st4 = await sync.getStatus();
  eq(st4.changesCount, 0, '2j: after a real push nothing is pending');
  eq(st4.unpushedCommits, 0, '2k: …and no commit is ahead');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3  Shared Brain F8 / F9 / F10 / F13 — brain side');
// ═══════════════════════════════════════════════════════════════════════════
{
  const fid = randomUUID();
  const members = sb.groupMembers([
    { fellowId: fid, submissionId: 's1', payload: { contributed_at: '2026-09-01T00:00:00Z', deltas: [{ path: 'concepts/a.md' }] } },
    { fellowId: fid, submissionId: 's2', payload: { contributed_at: '2026-09-02T00:00:00Z', deltas: [{ path: 'concepts/a.md' }, { path: 'concepts/b.md' }] } },
  ]);
  eq(members[0].pages, 2, '3a: F8 — a page re-pushed in two submissions is ONE distinct page (2 pages, not 3)');
  eq(members[0].page_updates, 3, '3b: …and the raw sum is kept, named page_updates');

  const storage = path.join(TMP, 'sb-storage');
  const sbDomains = path.join(TMP, 'sb-domains');
  const wiki = path.join(sbDomains, 'work', 'wiki');
  for (const f of ['entities', 'concepts', 'summaries']) fs.mkdirSync(path.join(wiki, f), { recursive: true });
  fs.writeFileSync(path.join(wiki, 'concepts', 'x.md'), '# X\n\nBody.\n');
  // A minute in the past: pushDomain's watermark is ms-truncated while mtimes
  // are sub-ms, so a page written in the same millisecond as the push would
  // otherwise read as "changed since" and be pushed again.
  const past = new Date(Date.now() - 60e3);
  fs.utimesSync(path.join(wiki, 'concepts', 'x.md'), past, past);
  const conns = {};
  const conn = {
    id: randomUUID(), label: 'Cohort', storage_type: 'local', local_storage_path: storage,
    fellow_id: randomUUID(), fellow_display_name: 'F', attribute_by_name: false,
    shared_domain: 'work', shared_brain_slug: 'cohort', local_domains: ['work'],
    last_push_at: null, pending_retry: {}, permanent_skip: [], enabled: true,
  };
  conns[conn.id] = conn;
  const patchFn = (id, patch) => { conns[id] = { ...conns[id], ...patch }; return conns[id]; };
  const llmFn = async () => JSON.stringify({ title: 'x', new_facts: ['f'], stable_facts: [], new_links: [], removed_links: [], key_entities: [] });
  const p1 = await sb.pushDomain(conns[conn.id], 'work', { llmFn, domainsDir: sbDomains, patchFn });
  ok(p1.ok && p1.pushed === 1, '3c: CONTROL — a real push wrote one contribution');
  const firstContribution = conns[conn.id].last_contribution_at;
  ok(typeof firstContribution === 'string' && firstContribution === conns[conn.id].last_push_at,
    '3d: F9 — a push that WROTE a contribution sets last_contribution_at');
  await new Promise((r) => setTimeout(r, 15));
  const p2 = await sb.pushDomain(conns[conn.id], 'work', { llmFn, domainsDir: sbDomains, patchFn });
  ok(p2.ok && p2.pushed === 0, '3e: CONTROL — the second push had nothing to send');
  ok(conns[conn.id].last_push_at !== firstContribution, '3f: CONTROL — …and still advanced last_push_at (the scan watermark)');
  eq(conns[conn.id].last_contribution_at, firstContribution, '3g: THE FIX — last_contribution_at did NOT move on a push that sent nothing');

  const bad = await sb.computePendingBreakdown({ ...conn, last_push_at: 'not-a-date' }, sbDomains);
  eq(bad.pages, null, '3h: F10 — an unreadable watermark answers null ("unknown"), never 0 ("up to date")');
  eq(await sb.computePendingPages({ ...conn, last_push_at: 'not-a-date' }, sbDomains), null, '3i: …through computePendingPages too');

  // Retries are a SUBSET of pending, and a stale entry for a deleted page is not counted.
  const future = new Date(Date.now() + 3600e3).toISOString();
  fs.writeFileSync(path.join(wiki, 'concepts', 'y.md'), '# Y\n');
  const withRetry = { ...conn, last_push_at: future, pending_retry: { 'work/concepts/y.md': 1, 'work/concepts/gone.md': 2 } };
  const b = await sb.computePendingBreakdown(withRetry, sbDomains);
  eq(b.pages, 1, '3j: CONTROL — only the retry page that exists is pending (mtimes are older than the watermark)');
  eq(b.retry, 1, '3k: F13 — "retrying" counts 1 (the existing page), not the 2 raw queue keys');
  ok(b.retry <= b.pages, '3l: …and is never more than pending — it is a part of it, not an addition');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4  Shared Brain F5 / F6 — a PARTLY failed push still refreshes');
// ═══════════════════════════════════════════════════════════════════════════
{
  const shared = R('src/public/next/views/shared.js');
  const calls = [];
  const box = new Function(
    'fetch', 'calls',
    'let state = { cards: {}, connections: [], expandedCohort: new Set(["c1"]), expandedSecRows: new Set(), freshPages: {} };\n' +
    'let hostCtx = { mode: "view" };\n' +
    'function ensureCard(id) { return state.cards[id] || (state.cards[id] = { acting: null, message: null, error: false, cohort: { members: [] } }); }\n' +
    'function findConnection() { return { id: "c1", local_domains: ["a", "b"], shared_brain_slug: "cohort" }; }\n' +
    'function domainsForAction() { return ["a", "b"]; }\n' +
    'function mirrorDomainFor() { return "shared-cohort"; }\n' +
    'function isDomainWriteBusy() { return false; }\n' +
    'function getDomainWriteLabel() { return null; }\n' +
    'function beginDomainWrite() { return () => {}; }\n' +
    'function render() {}\n' +
    'function isCurrentMount() { return true; }\n' +
    'function reportAsyncActionFailure(e) { calls.push("fail:" + e.message); }\n' +
    'async function refreshConnections() { calls.push("refreshConnections"); }\n' +
    'async function loadCohortDetails(t, id) { calls.push("loadCohort:" + id); }\n' +
    extractFunction(shared, 'composeDoneMessage', 'shared.js') + '\n' +
    extractFunction(shared, 'invalidateCohort', 'shared.js') + '\n' +
    extractFunction(shared, 'refreshMirrorPages', 'shared.js') + '\n' +
    extractFunction(shared, 'runSseAction', 'shared.js') + '\n' +
    'return { runSseAction, state };'
  );
  const frames = [
    { type: 'info', message: 'Pushing a…' },
    { type: 'error', message: 'b: storage write failed' },
    { type: 'done', message: 'Push complete: 12 pages pushed across 1 domain, 1 domain failed.' },
  ];
  const sseFetch = async () => {
    const body = frames.map((f) => 'data: ' + JSON.stringify(f) + '\n\n').join('');
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(body)); c.close(); } }),
      { headers: { 'content-type': 'text/event-stream' } });
  };
  const { runSseAction, state } = box(sseFetch, calls);
  await runSseAction(1, 'c1', 'push');
  ok(/12 pages pushed/.test(state.cards.c1.message), '4a: CONTROL — the partial push\'s done message is shown');
  ok(calls.includes('refreshConnections'),
    '4b: F5 THE FIX — the connection list (pending, pushed, sidebar) is re-read after a push with a failed domain', calls.join(','));
  ok(calls.includes('loadCohort:c1'), '4c: F6 — the open cohort panel is re-loaded (attribution changed)', calls.join(','));
  eq(state.cards.c1.cohort, null, '4d: …the cached cohort figures were dropped first, never kept from the first open');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5  Render helpers — the Sync view and the Shared Brain labels');
// ═══════════════════════════════════════════════════════════════════════════
{
  const syncSrc = R('src/public/next/views/sync.js');
  const v = new Function(
    extractFunction(syncSrc, 'formatSyncTime', 'sync.js') + '\n' +
    extractFunction(syncSrc, 'pendingNoteText', 'sync.js') + '\n' +
    extractFunction(syncSrc, 'sharedBrainRowLines', 'sync.js') + '\n' +
    'return { formatSyncTime, pendingNoteText, sharedBrainRowLines };'
  )();
  const now = Date.parse('2026-09-25T12:00:00');
  ok(/2025/.test(v.formatSyncTime('2025-09-03T09:10:00', now)), '5a: F14 — a sync from last year carries its year', v.formatSyncTime('2025-09-03T09:10:00', now));
  ok(!/2026/.test(v.formatSyncTime('2026-09-03T09:10:00', now)), '5b: …this year\'s dates stay short');
  eq(v.pendingNoteText({ changesCount: 4, uncommittedCount: 3 }), '4 local changes not pushed (1 in commits not yet pushed)',
    '5c: F2 — the note names the part that is committed but not pushed');
  eq(v.pendingNoteText({ configured: true, error: 'x' }), 'local changes not counted',
    '5d: a status that could not be counted is not "0 local changes"');
  const lines = v.sharedBrainRowLines({ enabled: true, connections: [
    { label: 'Cohort A', last_contribution_at: '2026-09-25T10:00:00', last_push_at: '2026-09-25T11:00:00' },
    { label: 'Cohort B', last_push_at: null },
  ] }, now);
  eq(lines.length, 2, '5e: F11 — one line PER connection (was connections[0] only)');
  ok(/^Cohort A · pushed today 10:00/.test(lines[0]), '5f: F9 — "pushed" is the contribution time, not the later no-op watermark', lines[0]);
  eq(lines[1], 'Cohort B · no pushes yet', '5g: the second Shared Brain is reported too');
  ok(/nothing recorded as sent/.test(v.sharedBrainRowLines({ connections: [{ label: 'L', last_push_at: '2026-09-01T00:00:00' }] }, now)[0]),
    '5h: a connection with only the watermark does not borrow it as a push time');
  eq(v.sharedBrainRowLines({ enabled: true, connections: null }, now)[0], 'Shared Brain list could not be read',
    '5i: an unreadable list is not "Not connected"');

  // F3 / F4 — the view re-reads after a mutation, driven through the REAL
  // handlers with recording collaborators.
  const calls = [];
  const drive = new Function('calls', 'busy',
    'let state = { acting: null, actionMessage: null, actionError: null };\n' +
    'function isCurrentMount() { return true; }\n' +
    'function render() { calls.push("render"); }\n' +
    'function crossWriteBusy() { return busy(); }\n' +
    'function reportAsyncActionFailure(e) { calls.push("fail:" + e.message); }\n' +
    'async function loadStatus() { calls.push("loadStatus"); }\n' +
    'async function loadDomains() { calls.push("loadDomains"); }\n' +
    'function refreshSyncBadge() {}\n' +
    'async function refreshSyncRemoteBadge() {}\n' +
    'function describeResult() { return "done"; }\n' +
    'const fetch = async () => ({ ok: true, json: async () => ({ pulled: true }) });\n' +
    extractFunction(syncSrc, 'onGateChange', 'sync.js') + '\n' +
    extractFunction(syncSrc, 'onAction', 'sync.js') + '\n' +
    'return { onGateChange, onAction };'
  );
  let busyNow = true;
  const h = drive(calls, () => busyNow);
  h.onGateChange(1);
  await new Promise((r) => setTimeout(r, 0));
  ok(calls.includes('render') && !calls.includes('loadStatus'), '5o: F3 CONTROL — while a write is still running, only a repaint');
  calls.length = 0; busyNow = false;
  h.onGateChange(1);
  await new Promise((r) => setTimeout(r, 0));
  ok(calls.includes('loadStatus'), '5p: F3 THE FIX — when the last write settles, the pending count is re-read (as the rail badge is)', calls.join(','));
  calls.length = 0;
  await h.onAction('pull', 1);
  ok(calls.includes('loadStatus') && calls.includes('loadDomains'),
    '5q: F4 — after a pull the "domains backed up" list is re-read with the status', calls.join(','));

  const shared = R('src/public/next/views/shared.js');
  const ageSrc = R('src/public/next/shared/age.js');
  const s = new Function(
    extractFunction(ageSrc, 'formatAge', 'age.js') + '\n' +
    extractFunction(shared, 'formatRelativeTime', 'shared.js') + '\n' +
    extractFunction(shared, 'pendingReading', 'shared.js') + '\n' +
    'return { formatRelativeTime, pendingReading };'
  )();
  eq(s.formatRelativeTime(new Date(Date.now() - 12 * 86400e3).toISOString(), 'never'), '1 week ago',
    '5j: F12 — Shared Brain ages speak the app ladder ("1 week ago", not "12 days ago")');
  eq(s.pendingReading({ pending_pages: null }).pending, null, '5k: F10 — a null pending stays unknown in the view');
  eq(s.pendingReading({ pending_pages: 5, pending_retry_pages: 2 }).retry, 2, '5l: F13 — the retry subset comes from the server field');
  eq(s.pendingReading({ pending_pages: 1, pending_retry_pages: 4 }).retry, 1, '5m: …clamped to pending (a subset never exceeds its whole)');
  ok(/pending === null \? 'pending unknown'/.test(extractFunction(shared, 'renderSidebar', 'shared.js')),
    '5n: F10 — the sidebar has a distinct "pending unknown" state');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§6  tray F1 / F5 / F7');
// ═══════════════════════════════════════════════════════════════════════════
{
  __setDomainsDirOverride(null);
  const pathsMod = await import('../src/brain/paths.js');
  const usage = await import('../src/brain/mcp-usage.js');
  const tray = await import('../src/brain/tray-summary.js');
  const model = await import('../desktop/lib/tray-model.js');
  const menu = await import('../desktop/lib/tray-menu.js');
  const routes = await import('../src/routes/mcp.js');

  // One store project ("quiet", one saving session) and a LOG-ONLY project
  // ("retired", three saving sessions) — the case where the two differed.
  const DOM = 'workshop';
  fs.mkdirSync(path.join(TMP_DOMAINS, DOM, 'wiki'), { recursive: true });
  fs.writeFileSync(path.join(TMP_DOMAINS, DOM, 'CLAUDE.md'), 'schema\n');
  fs.mkdirSync(path.join(TMP_DOMAINS, DOM, 'state', 'quiet'), { recursive: true });
  fs.writeFileSync(path.join(TMP_DOMAINS, DOM, 'state', 'quiet', 'project.md'), '# Quiet\n\nFixture.\n');
  const LOG = pathsMod.getMcpUsageLogPath();
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  const at = (h) => new Date(Date.now() - h * 3600e3).toISOString();
  const lines = [
    { ts: at(1), tool: 'save_working_state', domain: DOM, project: 'quiet', ok: true, refused: false, ms: 1, sid: 'a1a1a1a1a1a1' },
    ...['b1', 'b2', 'b3'].map((x, i) => ({ ts: at(2 + i), tool: 'save_working_state', domain: 'gone', project: 'retired', ok: true, refused: false, ms: 1, sid: x.repeat(6) })),
  ];
  fs.writeFileSync(LOG, lines.map((o) => JSON.stringify(o)).join('\n') + '\n');
  usage.__clearUsageCache();

  const summary = await tray.getTraySummary({ limit: 20 });
  let app = null;
  await routes.usageHandler({ query: { include: 'projects' } }, { json: (o) => { app = o; } });
  ok(app && app.byProject.some((r) => r.project === 'retired' && r.inStore === false),
    '6a: CONTROL — the app lists the log-only project, the busiest one');
  eq(app.byProjectWindow.busiestSaved, 3, '6b: CONTROL — the app\'s denominator is 3');
  eq(summary.capture.busiestSaved, app.byProjectWindow.busiestSaved,
    '6c: F1 THE FIX — the tray names the SAME busiest figure (was 1: the store\'s projects only)');
  eq(tray.busiestSavedOf([], false), null, '6d: …and with no log it is null, not 0');

  eq(model.captureNoneInWindow(14), 'no logged sessions · 14 d', '6e: F5 — the label is built from the payload\'s window');
  eq(model.captureNoneInWindow(30), model.CAPTURE_NONE_IN_WINDOW, '6f: …and at 30 it is exactly the pinned wording');
  eq(model.captureNoneInWindow(undefined), 'no logged sessions', '6g: …and with no window it states none rather than guessing 30');

  ok(typeof summary.readAt === 'string' && Number.isFinite(Date.parse(summary.readAt)), '6h: F7 — the summary carries its read time');
  const snap = { ...summary, readAt: '2026-09-25T10:05:00' };
  const m = model.buildTrayModel(snap, { now: new Date('2026-09-25T10:40:00') });
  eq(m.readAtText, '10:05', '6i: the model carries the READ time');
  eq(m.renderedAtText, '10:40', '6j: CONTROL — the render (hover) time is later');
  const NOOPS = { onOpenScope() {}, onOpenMemory() {}, onOpenApp() {}, onOpenSettings() {}, onRowAction() {} };
  const items = menu.flattenTrayMenu(menu.buildTrayMenuTemplate(m, NOOPS));
  const stamp = items.find((i) => i && i.id === menu.ID_UPDATED_STAMP);
  eq(stamp && stamp.label, 'Updated 10:05', '6k: F7 THE FIX — the menu stamp is when the figures were read, not the hover');
  fs.rmSync(LOG, { force: true });
  usage.__clearUsageCache();
}

eq(fingerprint(), fpBefore, '§Z real credential files unchanged (sha256 + size + existence)');
} catch (err) {
  failed++;
  console.log(`  ✗ threw: ${err && err.stack ? err.stack : err}`);
} finally {
  sync.__setSyncTestOverrides({});
  __setDomainsDirOverride(null);
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
