#!/usr/bin/env node
/**
 * test-sync-run-survives-navigation.js — OFFLINE. v3.89.2.
 *
 * The owner's report: "If you press the Sync button and then move from Sync
 * to another section, the sync gets cancelled. The sync should keep working
 * until it is finished, no matter where you click next."
 *
 * ROOT CAUSE, measured on an isolated rig (a local bare remote whose
 * pre-receive hook sleeps): the SERVER never cancelled anything — nothing
 * listens for the request closing, and the commit reached the remote every
 * time. The UI lost it:
 *   (1) views/sync.js held the run in per-mount `state` and dropped its
 *       result on a stale mount token, so returning to Sync painted an IDLE
 *       page ("Sync now", enabled, no outcome, a stale pending count) while
 *       the sync was still running;
 *   (2) a click on that idle page started a SECOND sync beside the first,
 *       and the loser answered "Another sync check was running at the same
 *       time, so this one stopped early" — "cancelled", as the user read it.
 *
 *   §1  SERVER (real routes/sync.js on a real Express app, real git, a slow
 *       local bare remote): a second POST while a sync runs is REFUSED with
 *       409 `sync_running` (the old code ran it and failed it); GET /job
 *       reports the run while it runs and its result after; a request the
 *       CLIENT ABORTS mid-sync still lands its commit on the remote.
 *   §2  CLIENT RUNNER (real shared/sync-run.js, fake fetch and clock): a run
 *       outlives the mount that started it — a subscriber that arrives
 *       AFTER a navigation receives the settle; two starts make ONE request;
 *       beforeSettle (the badge refresh) finishes before the run clears; a
 *       409 `sync_running` and a job adopted from GET /job are followed to
 *       their end by polling.
 *   §3  VIEW (real functions lifted from views/sync.js): a fresh mount seeded
 *       from a running run shows `acting`, not an idle page; an outcome that
 *       finished while away is shown once; onAction does nothing while a run
 *       is going.
 *
 * ISOLATION: CURATOR_TEST_USER_DATA_DIR + CURATOR_TEST_DOMAINS_DIR set before
 * any app module is imported; sync.js's git dir and config file redirected to
 * a tempdir; the remote is a local `git init --bare`. The real credential
 * files are fingerprinted at both ends.
 *
 * Run: node scripts/test-sync-run-survives-navigation.js
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
const failures = [];
function ok(cond, label, extra) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; failures.push(label); console.log(`  ✗ ${label}${extra !== undefined ? `\n        ${typeof extra === 'string' ? extra : JSON.stringify(extra)}` : ''}`); }
}
function section(t) { console.log(`\n${t}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A watchdog: a regression that leaves a promise pending must fail, not hang.
setTimeout(() => { console.log('  ✗ watchdog: the suite did not finish in 90 s'); process.exit(1); }, 90_000).unref();

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'curator-syncnav-')));
const TMP_USER = path.join(TMP, 'userdata');
const TMP_DOMAINS = path.join(TMP, 'domains');
fs.mkdirSync(TMP_USER, { recursive: true });
fs.mkdirSync(path.join(TMP_DOMAINS, 'demo', 'wiki', 'entities'), { recursive: true });
fs.writeFileSync(path.join(TMP_DOMAINS, 'demo', 'CLAUDE.md'), 'schema\n');
fs.writeFileSync(path.join(TMP_DOMAINS, 'demo', 'wiki', 'index.md'), '# Index\n');
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
const sh = (cmd) => execSync(cmd, { stdio: 'pipe' }).toString();

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

const sync = await import('../src/brain/sync.js');
const { getDomainsDir } = await import('../src/brain/config.js');
const express = (await import('express')).default;
const syncRouter = (await import('../src/routes/sync.js')).default;
const { __resetSyncJobForTest } = await import('../src/brain/sync-job.js');

let server = null;
try {
// ═══════════════════════════════════════════════════════════════════════════
section('§0  Isolation');
// ═══════════════════════════════════════════════════════════════════════════
ok(getDomainsDir() === TMP_DOMAINS, 'the resolved domains dir IS the tempdir');

// A slow remote: every push waits HOOK_MS in pre-receive, so a sync is
// reliably still running when the test acts "mid-sync".
const HOOK_MS = 1500;
const remote = path.join(TMP, 'remote.git');
sh(`git init --bare -q "${remote}"`);
const hook = path.join(remote, 'hooks', 'pre-receive');
fs.writeFileSync(hook, `#!/bin/sh\nsleep ${HOOK_MS / 1000}\ncat >/dev/null\n`);
fs.chmodSync(hook, 0o755);
const app = path.join(TMP, 'app');
fs.mkdirSync(app, { recursive: true });
const gitDir = path.join(app, '.knowledge-git');
sync.__setSyncTestOverrides({ gitDir, configFile: path.join(app, '.sync-config.json') });
await sync.setup(`file://${remote}`, 'tok', 'push');
const inLocal = (cmd) => sh(`git --git-dir="${gitDir}" --work-tree="${TMP_DOMAINS}" ${cmd}`);
inLocal('config user.email t@t.t'); inLocal('config user.name T');
const remoteFiles = () => sh(`git --git-dir="${remote}" log --all --name-only --format=`);
__resetSyncJobForTest();

const ex = express();
ex.use(express.json());
ex.use('/api/sync', syncRouter);
await new Promise((r) => { server = ex.listen(0, '127.0.0.1', r); });
const BASE = `http://127.0.0.1:${server.address().port}/api/sync`;
const post = (p, init = {}) => fetch(BASE + p, { method: 'POST', ...init });
// Tolerant on purpose: on the pre-fix code there is no /job route, and the
// suite must still reach — and fail on — the behaviour assertions below.
const getJob = async () => {
  const r = await fetch(BASE + '/job');
  return r.ok ? r.json() : { running: null, last: null, httpStatus: r.status };
};

// ═══════════════════════════════════════════════════════════════════════════
section('§1  Server — one sync at a time, a job record, and no cancel on disconnect');
// ═══════════════════════════════════════════════════════════════════════════
{
  fs.writeFileSync(path.join(TMP_DOMAINS, 'demo', 'wiki', 'entities', 'one.md'), '# One\n');
  const first = post('/sync');
  await sleep(300);
  const during = await getJob();
  ok(during.running && during.running.kind === 'sync', '1a: GET /job reports the sync while it runs', during);

  // The click the user made on the idle-looking page after coming back.
  const second = await post('/sync');
  const secondBody = await second.json();
  ok(second.status === 409 && secondBody.code === 'sync_running',
    '1b: a second sync while one runs is REFUSED with 409 sync_running — never run beside it',
    { status: second.status, body: secondBody });
  ok(secondBody.running && secondBody.running.kind === 'sync', '1c: the refusal names the running job');

  const firstRes = await first;
  ok(firstRes.status === 200, '1d: the first sync completes normally', firstRes.status);
  ok(remoteFiles().includes('demo/wiki/entities/one.md'), '1e: its commit is on the remote');
  const after = await getJob();
  ok(after.running === null && after.last && after.last.state === 'done' && after.last.kind === 'sync',
    '1f: GET /job: nothing running, the last job done', after);
  ok(after.last && after.last.result && after.last.result.pushResult && after.last.result.pushResult.filesChanged === 1,
    '1g: …carrying the same result the POST returned (1 file pushed)');
}
{
  // The client goes away mid-request — what the owner thought happened.
  fs.writeFileSync(path.join(TMP_DOMAINS, 'demo', 'wiki', 'entities', 'two.md'), '# Two\n');
  const ac = new AbortController();
  const p = post('/push', { signal: ac.signal }).catch((e) => e);
  await sleep(300);
  ac.abort();
  const aborted = await p;
  ok(aborted instanceof Error, '1h: CONTROL — the client really did abort its request');
  let job = await getJob();
  ok(job.running && job.running.kind === 'push', '1i: the server is still running the push after the client left', job);
  for (let i = 0; i < 100 && job.running; i++) { await sleep(100); job = await getJob(); }
  ok(job.running === null && job.last && job.last.state === 'done', '1j: …and finishes it', job.last);
  // Waited on the REMOTE, not on /job, so this holds on the pre-fix code too:
  // the server never cancelled — the bug was never here.
  for (let i = 0; i < 100 && !remoteFiles().includes('demo/wiki/entities/two.md'); i++) await sleep(100);
  ok(remoteFiles().includes('demo/wiki/entities/two.md'), '1k: the aborted request\'s commit IS on the remote — the server never cancels');
}
{
  // A failed job is recorded with a sentence, and the lock is released.
  const r = await post('/pull');
  ok(r.status === 200, '1l: CONTROL — after a refusal and an abort, a new sync starts normally (the lock was released)', r.status);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2  Client runner — a run outlives the mount that started it');
// ═══════════════════════════════════════════════════════════════════════════
const { createSyncRunner, SYNC_JOB_POLL_MS } = await import(pathToFileURL(path.join(ROOT, 'src/public/next/shared/sync-run.js')).href);
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
function makeEnv() {
  const calls = [];
  const timers = [];
  const env = {
    calls, timers, routes: {},
    fetch: (url, init) => { calls.push({ url, method: (init && init.method) || 'GET' }); return env.routes[url](init); },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
  };
  return env;
}
const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
{
  const env = makeEnv();
  const d = deferred();
  env.routes['/api/sync/sync'] = () => d.promise;
  const r = createSyncRunner(env);
  const order = [];
  r.configureSyncRun({
    beforeSettle: async () => { order.push('badge:start'); await sleep(20); order.push('badge:done:' + (r.currentSyncRun() ? 'run-still-set' : 'run-cleared')); },
    describe: (kind, data) => `described ${kind} ${data.n}`,
  });

  // Mount A: subscribe, click.
  const seenA = [];
  const unsubA = r.onSyncRunChange(() => seenA.push(r.currentSyncRun() ? 'running' : 'idle'));
  const p1 = r.startSyncRun('sync');
  ok(r.currentSyncRun() && r.currentSyncRun().kind === 'sync', '2a: the run is set synchronously on click');
  // Raced against a timer: without the guard the second start would await
  // the same never-resolved request and hang the suite instead of failing.
  const p2 = await Promise.race([r.startSyncRun('sync'), sleep(200).then(() => 'hung')]);
  ok(p2 === null && env.calls.filter((c) => c.url === '/api/sync/sync').length === 1,
    '2b: a second start while running makes NO request (two clicks never start two syncs)', env.calls);

  // Navigation: mount A tears down, mount B mounts later.
  unsubA();
  ok(r.currentSyncRun() && r.currentSyncRun().kind === 'sync', '2c: after the mount that started it is torn down, the run is still running');
  const seenB = [];
  r.onSyncRunChange(() => seenB.push(r.currentSyncRun() ? 'running' : 'idle'));

  d.resolve(jsonRes(200, { n: 3 }));
  const outcome = await p1;
  ok(outcome && outcome.ok === true && outcome.message === 'described sync 3', '2d: the run settles with the described result', outcome);
  ok(seenB.includes('idle'), '2e: mount B (arrived after navigating away and back) is told the run settled', seenB);
  ok(!seenA.includes('idle'), '2f: CONTROL — the torn-down mount A is not called');
  ok(r.lastSyncOutcome() === outcome && outcome.seen === false, '2g: the outcome is kept, unseen, for the next Sync mount');
  ok(order.join(',') === 'badge:start,badge:done:run-still-set', '2h: beforeSettle (the badge refresh) finishes BEFORE the run clears', order);
  r.markOutcomeSeen(outcome);
  ok(r.lastSyncOutcome().seen === true, '2i: markOutcomeSeen marks it');
}
{
  // A failed request settles as a failure, not a hang.
  const env = makeEnv();
  env.routes['/api/sync/push'] = async () => jsonRes(500, { error: 'GitHub rejected the token.' });
  const r = createSyncRunner(env);
  const o = await r.startSyncRun('push');
  ok(o.ok === false && o.error === 'GitHub rejected the token.' && r.currentSyncRun() === null, '2j: a failure settles with its sentence and clears the run', o);
}
{
  // 409 sync_running → follow the other run by polling GET /job.
  const env = makeEnv();
  env.routes['/api/sync/sync'] = async () => jsonRes(409, { code: 'sync_running', error: 'busy', running: { kind: 'pull' } });
  let jobCalls = 0;
  env.routes['/api/sync/job'] = async () => {
    jobCalls++;
    return jobCalls < 2
      ? jsonRes(200, { running: { kind: 'pull' }, last: null })
      : jsonRes(200, { running: null, last: { kind: 'pull', state: 'done', result: { message: 'pulled 2' }, finishedAt: 'x' } });
  };
  const r = createSyncRunner(env);
  r.configureSyncRun({ describe: (k, data) => data.message });
  const o = await r.startSyncRun('sync');
  ok(o === null && r.currentSyncRun() && r.currentSyncRun().kind === 'pull' && r.currentSyncRun().here === false,
    '2k: a 409 sync_running is not a failure — the runner follows the other run', r.currentSyncRun());
  ok(env.timers.length === 1 && env.timers[0].ms === SYNC_JOB_POLL_MS, '2l: …by scheduling a poll of GET /job');
  await env.timers[0].fn();
  ok(r.currentSyncRun() && env.timers.length === 2, '2m: still running → polls again');
  await env.timers[1].fn();
  ok(r.currentSyncRun() === null && r.lastSyncOutcome() && r.lastSyncOutcome().message === 'pulled 2',
    '2n: when the job ends its result becomes the outcome', r.lastSyncOutcome());
}
{
  // A reload mid-sync: the page adopts the server's running job.
  const env = makeEnv();
  env.routes['/api/sync/job'] = async () => jsonRes(200, { running: null, last: { kind: 'sync', state: 'failed', error: 'conflict', finishedAt: 'x' } });
  const r = createSyncRunner(env);
  ok(r.adoptServerSyncJob({ running: null, last: null }) === false && r.currentSyncRun() === null, '2o: CONTROL — nothing running → nothing adopted');
  ok(r.adoptServerSyncJob({ running: { kind: 'sync' } }) === true && r.currentSyncRun().kind === 'sync', '2p: a running server job is adopted');
  await env.timers[0].fn();
  ok(r.currentSyncRun() === null && r.lastSyncOutcome().ok === false && r.lastSyncOutcome().error === 'conflict',
    '2q: …and its failure becomes the outcome when it ends', r.lastSyncOutcome());
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3  The Sync view — a returning mount shows the run, never an idle page');
// ═══════════════════════════════════════════════════════════════════════════
{
  const viewSrc = fs.readFileSync(path.join(ROOT, 'src/public/next/views/sync.js'), 'utf8');
  const box = new Function(
    `const SYNC_RUN_KINDS = ['sync', 'push', 'pull'];\n` +
    extractFunction(viewSrc, 'freshState', 'views/sync.js') + '\n' +
    extractFunction(viewSrc, 'seedFromSyncRun', 'views/sync.js') + '\n' +
    'return { freshState, seedFromSyncRun };')();
  const st = box.seedFromSyncRun(box.freshState(), { kind: 'sync', here: true }, null);
  ok(st.acting === 'sync', '3a: a fresh mount while a sync runs paints acting="sync" ("Syncing…", buttons disabled)', st.acting);
  const done = box.seedFromSyncRun(box.freshState(), null, { kind: 'sync', ok: true, message: 'Sync complete — pushed 1 file to GitHub.', seen: false });
  ok(done.acting === null && done.actionMessage === 'Sync complete — pushed 1 file to GitHub.',
    '3b: a sync that finished while the user was away is shown on return', done);
  const failedRun = box.seedFromSyncRun(box.freshState(), null, { kind: 'pull', ok: false, error: 'conflict', seen: false });
  ok(failedRun.actionError === 'conflict' && failedRun.actionMessage === null, '3c: …a failure likewise, as an error');
  const seen = box.seedFromSyncRun(box.freshState(), null, { kind: 'sync', ok: true, message: 'x', seen: true });
  ok(seen.actionMessage === null && seen.actionError === null, '3d: an outcome a Sync page already showed is not repeated');
  const disc = box.freshState(); disc.acting = 'disconnect';
  box.seedFromSyncRun(disc, null, null);
  ok(disc.acting === 'disconnect', '3e: CONTROL — a settle never clears a Disconnect in progress');

  // onAction: two clicks never start two runs, even across mounts.
  const onAction = extractFunction(viewSrc, 'onAction', 'views/sync.js');
  const mk = (running) => {
    const log = [];
    const fn = new Function('state', 'render', 'currentSyncRun', 'startSyncRun',
      `${onAction}\nreturn onAction;`)(
      { acting: null }, () => log.push('render'), () => (running ? { kind: 'sync' } : null),
      async (k) => { log.push('start:' + k); });
    return { fn, log };
  };
  const busy = mk(true);
  await busy.fn('push', 1);
  ok(busy.log.length === 0, '3f: onAction does nothing while a run is going (no second start, no repaint)', busy.log);
  const idle = mk(false);
  await idle.fn('push', 1);
  ok(idle.log.join(',') === 'render,start:push', '3g: CONTROL — idle, it paints "acting" then starts the run in the shell', idle.log);
}

} catch (err) {
  failed++;
  failures.push('suite crashed: ' + (err && err.stack || err));
  console.log('  ✗ suite crashed: ' + (err && err.stack || err));
} finally {
  if (server) await new Promise((r) => server.close(r));
  sync.__setSyncTestOverrides({});
}

ok(fingerprint() === fpBefore, '§Z real credential files unchanged (sha256 + size + existence)');
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:\n' + failures.map((f) => '  - ' + f).join('\n'));
  process.exit(1);
}
process.exit(0);
