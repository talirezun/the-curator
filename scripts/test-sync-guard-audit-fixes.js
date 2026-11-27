#!/usr/bin/env node
/**
 * v4.2.1 — the independent audit's findings on the Sync deletion guard, each
 * as the audit's repro turned into checks.
 *
 *   §1  M1   neither guard half trusts `refs/remotes/origin/main`. An
 *            `origin` with no fetch refspec for `main` (a git folder made or
 *            edited by hand) leaves that ref missing or stale:
 *            (a) missing: Push only after 8 deletions asks, the remote keeps
 *                the pages, and the token passes;
 *            (b) stale: Pull only brings what the other computer pushed, and
 *                Sync then works (v4.2.0 behaviour; the candidate merged the
 *                old commit and failed every Sync after).
 *            A remote with no `main` at all: Push only sends everything, no
 *            question. The push half of Sync now assesses the commit the pull
 *            merged (one fetch per Sync, audit m5), also when the first
 *            fetch loses a ref race.
 *   §2  M2   the legacy N3 refusal changes nothing: no `curator.workTree` /
 *            `workTreeReal` is written until a sync gets past the guard; the
 *            folder can be set back in Settings; the route's sentences are
 *            true; a good sync records the folder.
 *   §3  m1   a folder moved with a link left at its old path: the sentence
 *            does not tell the person to set the folder to that path.
 *   §4  m7   the LAST 8 tokens are kept, so a ninth, correct one passes.
 *   §5  m3/m10  the page's runner (real shared/sync-run.js, fake fetch):
 *            Delete them sends exactly the tokens; a question the page
 *            answered is not adopted again from the server's job; another
 *            question still is; the card's heading can take the focus.
 *
 * Real git against local bare repositories (file://). Isolation:
 * CURATOR_TEST_USER_DATA_DIR, CURATOR_TEST_DOMAINS_DIR, a fake HOME,
 * CURATOR_NO_OPEN, __setSyncTestOverrides. No network, no paid call.
 */

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, renameSync, symlinkSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';

const TMP = mkdtempSync(path.join(tmpdir(), 'curator-gaf-'));
const TMP_USER = path.join(TMP, 'userdata');
const TMP_DOMAINS = path.join(TMP, 'domains-default');
const TMP_HOME = path.join(TMP, 'home');
for (const d of [TMP_USER, TMP_DOMAINS, TMP_HOME]) mkdirSync(d, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = TMP_USER;
process.env.CURATOR_TEST_DOMAINS_DIR = TMP_DOMAINS;
process.env.CURATOR_NO_OPEN = '1';
process.env.HOME = TMP_HOME;
delete process.env.DOMAINS_PATH;

const REPO_ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const REAL_FILES = ['.curator-config.json', '.sync-config.json', '.sharedbrain-config.json'].map((f) => path.join(REPO_ROOT, f));
const fingerprint = () => REAL_FILES.map((f) => {
  if (!existsSync(f)) return `${path.basename(f)}:absent`;
  const b = readFileSync(f);
  return `${path.basename(f)}:${b.length}:${createHash('sha256').update(b).digest('hex')}`;
}).join('|');
const FINGERPRINT_BEFORE = fingerprint();

const sync = await import('../src/brain/sync.js');
const D = await import('../src/brain/sync-deletions.js');
const { __setDomainsDirOverride } = await import('../src/brain/config.js');
const cfgRoutes = await import('../src/routes/config.js');
const T = sync.__testing;

let passed = 0, failed = 0;
const failures = [];
function ok(cond, msg, extra) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; failures.push(msg); console.log(`  ✗ ${msg}${extra !== undefined ? ' — ' + JSON.stringify(extra) : ''}`); }
}
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`); }
function section(t) { console.log(`\n${t}\n`); }

// ── fixtures ────────────────────────────────────────────────────────────────
let n = 0;
const fresh = (name) => { const d = path.join(TMP, `${name}-${++n}`); mkdirSync(d, { recursive: true }); return d; };
const gitRun = (args, cwd) => execFileSync('git', args, { cwd: cwd || TMP, stdio: 'pipe' }).toString();
function bareRemote() {
  const remote = path.join(fresh('remote'), 'r.git');
  gitRun(['init', '--bare', '-q', '-b', 'main', remote]);
  return { remote, url: `file://${remote}` };
}
const remoteFiles = (remote) => {
  try { return gitRun(['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'main']).split('\n').filter(Boolean).sort(); }
  catch { return []; }
};
function write(dir, files) {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}
function domain(name, pages, tag = '') {
  const f = { [`${name}/CLAUDE.md`]: `# ${name}\n`, [`${name}/wiki/index.md`]: `# index ${name}\n`, [`${name}/wiki/log.md`]: '# log\n' };
  for (let i = 0; i < pages; i++) f[`${name}/wiki/concepts/p${i}.md`] = `# ${name} page ${i}${tag}\n`;
  return f;
}
function computer(domainsDir) {
  const home = fresh('computer');
  return { gitDir: path.join(home, '.knowledge-git'), configFile: path.join(home, '.sync-config.json'), domains: domainsDir };
}
function use(c, domainsDir) {
  sync.__setSyncTestOverrides({ gitDir: c.gitDir, configFile: c.configFile });
  __setDomainsDirOverride(domainsDir || c.domains);
}
async function attempt(fn) { try { return { value: await fn() }; } catch (err) { return { err }; } }
const refusalOf = (r) => (r.err ? sync.syncRefusalOf(r.err) : null);
const codeOf = (r) => (refusalOf(r) ? refusalOf(r).code : (r.err ? `ERR:${r.err.message.slice(0, 200)}` : 'ok'));
const gitOf = (c, args) => gitRun([`--git-dir=${c.gitDir}`, `--work-tree=${c.domains}`, ...args]);
const cfgGet = (c, k) => { try { return gitRun([`--git-dir=${c.gitDir}`, 'config', '--local', '--get', k]).trim(); } catch { return null; } };
const cfgUnset = (c, k) => { try { gitRun([`--git-dir=${c.gitDir}`, 'config', '--local', '--unset-all', k]); } catch { /* not set */ } };
const originMain = (c) => { try { return gitOf(c, ['rev-parse', '--verify', '-q', 'refs/remotes/origin/main']).trim(); } catch { return null; } };
async function connected(files, mode = 'push') {
  const { remote, url } = bareRemote();
  const dir = write(fresh('vault'), files);
  const c = computer(dir);
  use(c);
  await sync.setup(url, 't', mode);
  return { remote, url, c, dir };
}
async function second(url) {
  const dir = fresh('vaultb');
  const c = computer(dir);
  use(c);
  await sync.setup(url, 't', 'pull');
  return { c, dir };
}
const fakeRes = () => { const r = { statusCode: 200, body: null, status(s) { r.statusCode = s; return r; }, json(b) { r.body = b; return r; } }; return r; };

// ═══════════════════════════════════════════════════════════════════════════
section('§1 M1 — the guard never trusts refs/remotes/origin/main');
// ═══════════════════════════════════════════════════════════════════════════
for (const variant of ['no fetch refspec', 'a refspec for another branch only']) {
  const { remote, url, c: a, dir: dirA } = await connected(domain('articles', 10));
  const { c: b, dir: dirB } = await second(url);
  cfgUnset(b, 'remote.origin.fetch');
  if (variant !== 'no fetch refspec') gitOf(b, ['config', 'remote.origin.fetch', '+refs/heads/other:refs/remotes/origin/other']);
  const staleRef = originMain(b);
  for (let k = 0; k < 2; k++) {
    use(a); write(dirA, { [`articles/wiki/concepts/from-a-${k}.md`]: 'a\n' }); await sync.sync();
    use(b);
    const r = await attempt(() => sync.pull());
    eq(codeOf(r), 'ok', `${variant}: Pull only #${k + 1} works`);
    ok(existsSync(path.join(dirB, `articles/wiki/concepts/from-a-${k}.md`)), `${variant}: …and the other computer's page #${k + 1} ARRIVES (the stale ref merged nothing before)`);
    ok(r.value && r.value.filesChanged >= 1, `${variant}: …and is counted`, r.value && r.value.filesChanged);
  }
  eq(originMain(b), staleRef, `${variant}: CONTROL — origin/main really is stale on this computer`);
  use(b); write(dirB, { 'articles/wiki/concepts/from-b.md': 'b\n' });
  const s = await attempt(() => sync.sync());
  eq(codeOf(s), 'ok', `${variant}: then Sync now works (it failed every time before)`);
  ok(remoteFiles(remote).includes('articles/wiki/concepts/from-b.md'), `${variant}: …and this computer's page reached the remote`);
}
{
  // (a) The ref is MISSING: Push only must still ask.
  const { remote, url } = await connected(domain('articles', 10));
  const { c: b, dir: dirB } = await second(url);
  cfgUnset(b, 'remote.origin.fetch');
  gitOf(b, ['update-ref', '-d', 'refs/remotes/origin/main']);
  eq(originMain(b), null, 'CONTROL — origin/main does not exist on this computer');
  use(b);
  for (let i = 0; i < 8; i++) rmSync(path.join(dirB, `articles/wiki/concepts/p${i}.md`));
  const before = remoteFiles(remote);
  const r = await attempt(() => sync.push());
  eq(codeOf(r), 'sync-deletions-need-confirm', 'missing origin/main: Push only after 8 deletions ASKS (it deleted them with no question before)');
  eq(JSON.stringify(remoteFiles(remote)), JSON.stringify(before), '…and the remote keeps every page');
  const tok = refusalOf(r) && refusalOf(r).details.confirmToken;
  const r2 = await attempt(() => sync.push({ confirmDeletions: [tok] }));
  eq(codeOf(r2), 'ok', '…and the token passes');
  ok(!remoteFiles(remote).includes('articles/wiki/concepts/p0.md'), '…and only then are they deleted on the remote');
}
{
  // (a) offline: the ref is missing AND the remote cannot be reached. Push
  // only must stop before it commits anything, never assess against nothing
  // (the deletions would be committed here and sent at the next push).
  const { url } = await connected(domain('articles', 10));
  const { c: b, dir: dirB } = await second(url);
  cfgUnset(b, 'remote.origin.fetch');
  gitOf(b, ['update-ref', '-d', 'refs/remotes/origin/main']);
  gitOf(b, ['config', 'remote.origin.url', `file://${path.join(TMP, 'no-such-remote.git')}`]);
  use(b);
  for (let i = 0; i < 8; i++) rmSync(path.join(dirB, `articles/wiki/concepts/p${i}.md`));
  const head0 = gitOf(b, ['rev-parse', 'HEAD']).trim();
  const r = await attempt(() => sync.push());
  ok(codeOf(r) !== 'ok', 'offline, no origin/main: Push only fails', codeOf(r));
  ok(r.err && /fetch/.test(sync.describeSyncError(r.err).detail || ''), '…with the fetch named in the technical detail', r.err && sync.describeSyncError(r.err));
  eq(gitOf(b, ['rev-parse', 'HEAD']).trim(), head0, '…before committing the deletions (HEAD unchanged)');
  ok(gitOf(b, ['ls-files']).includes('articles/wiki/concepts/p0.md'), '…and the deleted pages are still tracked');
}
{
  // A remote with no `main` (a first push to an emptied repository): nothing
  // there can be deleted, so Push only sends everything with no question.
  const { remote, c } = await connected(domain('articles', 10));
  gitRun(['--git-dir', remote, 'update-ref', '-d', 'refs/heads/main']);
  use(c);
  const r = await attempt(() => sync.push());
  eq(codeOf(r), 'ok', 'remote with no main: Push only works with no question');
  ok(remoteFiles(remote).includes('articles/wiki/concepts/p0.md'), '…and the remote has the pages again');
}
{
  // m5: the push half assesses the commit the pull merged: one fetch per
  // Sync, and a confirmed incoming deletion asks nothing more, including
  // when the pull's first fetch loses a ref race (origin/main left behind).
  for (const race of [false, true]) {
    const { remote, url, c: a, dir: dirA } = await connected(domain('articles', 12));
    const { c: b } = await second(url);
    use(a);
    for (let i = 0; i < 9; i++) rmSync(path.join(dirA, `articles/wiki/concepts/p${i}.md`));
    const ra = await attempt(() => sync.push());
    await sync.push({ confirmDeletions: [refusalOf(ra).details.confirmToken] });
    use(b);
    const lock = path.join(b.gitDir, 'refs', 'remotes', 'origin', 'main.lock');
    if (race) writeFileSync(lock, '');
    const q = await attempt(() => sync.sync());
    eq(codeOf(q), 'sync-pull-deletions-need-confirm', `${race ? 'ref race' : 'plain'}: the incoming deletion asks`);
    T.resetFetchCount();
    const s = await attempt(() => sync.sync({ confirmDeletions: [refusalOf(q).details.confirmToken] }));
    if (race) rmSync(lock, { force: true });
    eq(codeOf(s), 'ok', `${race ? 'ref race' : 'plain'}: confirmed, Sync completes with no second, false question`);
    eq(T.fetchCount(), race ? 2 : 1, `${race ? 'ref race' : 'plain'}: the push half did not fetch again (it assessed the pull's commit)`);
    ok(!remoteFiles(remote).includes('articles/wiki/concepts/p0.md') && remoteFiles(remote).includes('articles/wiki/concepts/p9.md'), `${race ? 'ref race' : 'plain'}: the remote is as the other computer left it`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2 M2 — the legacy refusal changes nothing, and the way back is open');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { remote, c: a, dir: original } = await connected({ ...domain('history', 6), ...domain('physics', 6) });
  cfgUnset(a, T.WORK_TREE_KEY); cfgUnset(a, T.WORK_TREE_REAL_KEY);
  const other = write(fresh('othervault'), domain('physics', 1, ' other'));
  use(a, other);
  const cfg0 = readFileSync(path.join(a.gitDir, 'config'), 'utf8');
  const before = remoteFiles(remote);
  const r = await attempt(() => sync.sync());
  eq(codeOf(r), 'sync-deletions-need-confirm', 'N3 legacy: the other vault is stopped by the deletion guard');
  eq(JSON.stringify(remoteFiles(remote)), JSON.stringify(before), '…the remote keeps every file');
  eq(readFileSync(path.join(a.gitDir, 'config'), 'utf8'), cfg0, '…and the git config is byte-for-byte as it was (no folder recorded)');
  eq(cfgGet(a, T.WORK_TREE_KEY), null, '…curator.workTree is still unset');
  eq(cfgGet(a, T.WORK_TREE_REAL_KEY), null, '…curator.workTreeReal is still unset');
  ok(sync.syncFolderIsElsewhere(), 'the install reads as "not on the synced folder" (the other vault lacks files Sync backs up)');
  // The person presses Cancel and sets the folder back in Settings.
  const wrong = fakeRes();
  cfgRoutes.domainsPathHandler({ body: { path: fresh('somewhere') } }, wrong, null);
  ok(wrong.statusCode === 400 && /has not yet recorded which knowledge folder/.test(wrong.body && wrong.body.error)
    && !/connected to your current knowledge folder/.test(wrong.body.error), 'a third folder is refused, with a sentence that is true here', wrong.body);
  const back = fakeRes();
  cfgRoutes.domainsPathHandler({ body: { path: original } }, back, null);
  eq(back.statusCode, 200, 'setting the knowledge folder BACK to the original is accepted (400 sync-connected before)');
  use(a, original);
  ok(!sync.syncFolderIsElsewhere(), 'back on the original: no longer elsewhere');
  write(original, { 'history/wiki/concepts/new.md': 'n\n' });
  const s = await attempt(() => sync.sync());
  eq(codeOf(s), 'ok', 'and Sync works from it');
  eq(cfgGet(a, T.WORK_TREE_KEY), original, 'the good sync records the folder');
  eq(cfgGet(a, T.WORK_TREE_REAL_KEY), realpathSync.native(original), '…and its real path');
  ok(remoteFiles(remote).includes('history/wiki/concepts/new.md') && before.every((f) => remoteFiles(remote).includes(f)), 'nothing was lost on the remote');
}
{
  // A legacy push with nothing to send still records the folder (the check
  // used to do it itself).
  const { c } = await connected(domain('history', 3));
  cfgUnset(c, T.WORK_TREE_KEY); cfgUnset(c, T.WORK_TREE_REAL_KEY);
  use(c);
  const r = await attempt(() => sync.push());
  eq(codeOf(r), 'ok', 'legacy, nothing to send: Push only works');
  eq(cfgGet(c, T.WORK_TREE_KEY), c.domains, '…and records the folder');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3 m1 — a folder moved with a link left at its old path');
// ═══════════════════════════════════════════════════════════════════════════
{
  const parent = fresh('moved');
  const oldPath = path.join(parent, 'brain');
  write(oldPath, domain('history', 3));
  const { remote, url } = bareRemote();
  const c = computer(oldPath);
  use(c);
  await sync.setup(url, 't', 'push');
  const recordedReal = cfgGet(c, T.WORK_TREE_REAL_KEY);
  const newPath = path.join(parent, 'brain-moved');
  renameSync(oldPath, newPath);
  symlinkSync(newPath, oldPath);
  const before = remoteFiles(remote);
  const r = await attempt(() => sync.sync());
  eq(codeOf(r), 'folder-changed', 'the same setting now leading to the moved folder is refused (the safe direction)');
  const msg = sync.describeSyncError(r.err).error;
  ok(!/set it to that folder in Settings/.test(msg) && !/would remove the other folder/.test(msg), 'the sentence gives no advice that cannot be followed here', msg);
  ok(/no longer there/.test(msg) && /Disconnect/.test(msg) && msg.includes(recordedReal), 'it says the folder is no longer there, names it and the way that works', msg);
  ok(refusalOf(r).details && refusalOf(r).details.syncedFolderGone === true, 'the refusal says the recorded folder is gone');
  eq(JSON.stringify(remoteFiles(remote)), JSON.stringify(before), 'nothing changed on the remote');
  // CONTROL: a link re-pointed at another folder that still exists keeps the
  // original advice (that folder can be set).
  rmSync(oldPath);
  renameSync(newPath, oldPath);
  const elsewhere = write(fresh('elsewhere'), domain('history', 3));
  const link = path.join(fresh('lnk'), 'brain-link');
  symlinkSync(elsewhere, link);
  __setDomainsDirOverride(link);
  gitRun([`--git-dir=${c.gitDir}`, 'config', T.WORK_TREE_KEY, link]);
  const r2 = await attempt(() => sync.sync());
  const msg2 = r2.err ? sync.describeSyncError(r2.err).error : '';
  ok(codeOf(r2) === 'folder-changed' && /set it to that folder in Settings/.test(msg2), 'CONTROL: the recorded folder still exists, so the sentence still offers it', msg2);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4 m7 — the newest token is never the one dropped');
// ═══════════════════════════════════════════════════════════════════════════
{
  const toks = Array.from({ length: 9 }, (_, i) => 'sdo-' + String(i).repeat(40));
  const kept = D.confirmedTokens(toks);
  eq(kept.length, 8, 'at most 8 are kept');
  ok(kept.includes(toks[8]) && !kept.includes(toks[0]), 'the LAST 8: the ninth (newest) is kept, the first dropped', kept);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5 m3 / m10 — the page: tokens sent, an answered question stays answered');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { createSyncRunner } = await import('../src/public/next/shared/sync-run.js');
  const C = await import('../src/public/next/shared/sync-deletion-card.js');
  const details = { direction: 'out', count: 8, pages: 8, byDomain: [{ domain: 'a', count: 8 }], confirmToken: 'sdo-' + 'a'.repeat(40) };
  const requests = [];
  let answer = () => ({ status: 409, body: { error: 'ask', code: 'sync-deletions-need-confirm', details } });
  const env = {
    fetch: async (url, init) => {
      requests.push({ url, init });
      const a = answer(url, init);
      return { ok: a.status < 400, status: a.status, json: async () => a.body };
    },
    setTimeout: () => 0, clearTimeout: () => {},
  };
  const r = createSyncRunner(env);
  const o = await r.startSyncRun('sync');
  ok(o && o.details && o.details.confirmToken === details.confirmToken, 'a refused run settles with the question');
  eq(requests[0].init.body, undefined, 'a plain start sends no body (byte-for-byte the old request)');
  // Delete them: the page sends the token(s), exactly.
  answer = () => ({ status: 200, body: { message: 'done' } });
  await r.startSyncRun('sync', { confirmDeletions: [...(o.confirmed || []), o.details.confirmToken] });
  const sent = requests[1];
  let sentTokens = null;
  try { sentTokens = JSON.parse(sent.init.body).confirmDeletions; } catch { sentTokens = null; }
  ok(sent.init && sent.init.method === 'POST' && Array.isArray(sentTokens) && sentTokens.length === 1 && sentTokens[0] === details.confirmToken,
    'Delete them POSTs exactly the confirm token', sent.init);
  // After that, the server's job for the SAME question is not adopted again.
  const job = { running: null, last: { id: 7, kind: 'sync', state: 'failed', code: 'sync-deletions-need-confirm', details, finishedAt: new Date(Date.now() - 60000).toISOString() } };
  eq(r.adoptServerSyncJob(job), false, 'a question the page answered (Delete them) is not shown again from the job');
  // Cancel: the same, on a fresh runner.
  answer = () => ({ status: 409, body: { error: 'ask', code: 'sync-deletions-need-confirm', details } });
  const r2 = createSyncRunner(env);
  const o2 = await r2.startSyncRun('sync');
  r2.dismissDeletionQuestion(o2);
  eq(r2.adoptServerSyncJob(job), false, 'after Cancel, the next visit does not adopt the same question (it came back once before)');
  eq(r2.adoptServerSyncJob(job), false, '…nor the visit after');
  const garbled = { running: null, last: { ...job.last, finishedAt: 'not a time' } };
  eq(r2.adoptServerSyncJob(garbled), false, '…nor a job whose time cannot be read (the safe side: no reappearance)');
  const later = { running: null, last: { ...job.last, id: 9, finishedAt: new Date(Date.now() + 60000).toISOString() } };
  eq(r2.adoptServerSyncJob(later), true, 'CONTROL: the same set asked by a LATER run (the Context page, after Cancel) IS brought here');
  const r3 = createSyncRunner(env);
  const o3 = await r3.startSyncRun('sync');
  r3.dismissDeletionQuestion(o3);
  const other = { running: null, last: { ...job.last, id: 8, details: { ...details, confirmToken: 'sdo-' + 'b'.repeat(40) } } };
  eq(r3.adoptServerSyncJob(other), true, 'CONTROL: a different question from another page IS adopted');
  const card = C.deletionCardHtml(details);
  ok(/class="sync-decision-title" id="sync-deletion-title" tabindex="-1"/.test(card), 'the card heading can take the focus when it appears');
}

// ── wrap up ────────────────────────────────────────────────────────────────
__setDomainsDirOverride(null);
eq(fingerprint(), FINGERPRINT_BEFORE, 'no real credential file in the repository was touched');
rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:\n  - ' + failures.join('\n  - ')); process.exit(1); }
