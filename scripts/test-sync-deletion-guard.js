#!/usr/bin/env node
/**
 * v4.2.1 — the Sync deletion guard and the real-path record. The GitHub backup
 * can never be silently emptied: a sync that would delete more than a page or
 * two asks first, and changes nothing until it is answered.
 *
 *   §1  REPRO   the two v4.1.2 KNOWN AND UNFIXED cases that wiped the remote
 *               on v4.2.0: N3 (legacy install, folder moved to a vault that
 *               shares one domain name) and F1 (a link re-pointed at another
 *               vault). Both are now stopped, the remote byte-for-byte the
 *               same; a confirmation is what it takes to delete (the control:
 *               the deletion really was what the sync would have done).
 *   §2  F1      the real-path record: re-pointed link refused as
 *               folder-changed; a swapped drive under the same path is caught
 *               by the count; legitimate spellings still sync; an install
 *               with no real record is recorded on its next good sync.
 *   §3  PUSH    thresholds (2 pages pass; 6 ask; 3 of 20 ask by share; 2 of
 *               20 pass; a whole small domain asks; hygiene junk never
 *               counts); "nothing changed" measured (HEAD, index, work tree,
 *               remote); the token is bound to the set (stale refused, asked
 *               again with a new token).
 *   §4  PULL    another computer's mass deletion is refused on this one
 *               until confirmed; a local mass deletion is refused before the
 *               auto-save commit; Sync now's two halves share one answer.
 *   §5  ROUTES  POST /api/sync/{push,pull,sync} answer 409 with the details,
 *               record them on the job; a request with no token (every
 *               non-interactive caller) never passes; the token passes.
 *   §6  CARD    the Sync page's confirm card and the reader list, pure.
 *
 * Real git against local bare repositories (file://). Isolation:
 * CURATOR_TEST_USER_DATA_DIR, CURATOR_TEST_DOMAINS_DIR, a fake HOME,
 * CURATOR_NO_OPEN, __setSyncTestOverrides. No network, no paid call.
 */

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { createServer } from 'http';

const TMP = mkdtempSync(path.join(tmpdir(), 'curator-dg-'));
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
const { default: syncRouter } = await import('../src/routes/sync.js');
const { __resetSyncJobForTest } = await import('../src/brain/sync-job.js');
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
const remoteHead = (remote) => { try { return gitRun(['--git-dir', remote, 'rev-parse', 'main']).trim(); } catch { return null; } };
function write(dir, files) {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}
/** A domain the app would list: CLAUDE.md, index, log and `pages` pages. */
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
const codeOf = (r) => (refusalOf(r) ? refusalOf(r).code : (r.err ? `ERR:${r.err.message.slice(0, 160)}` : null));
const gitOf = (c, args) => gitRun([`--git-dir=${c.gitDir}`, `--work-tree=${c.domains}`, ...args]);
const headOf = (c) => gitOf(c, ['rev-parse', 'HEAD']).trim();
const stagedOf = (c) => gitOf(c, ['diff', '--cached', '--name-only']).trim();
function listFiles(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out.push(`${r}:${createHash('sha1').update(readFileSync(path.join(d, e.name))).digest('hex')}`);
    }
  };
  walk(dir, '');
  return out.sort().join('\n');
}
/** Every observable a refusal must leave as it was. */
function snapshot(c, remote, dir) {
  return JSON.stringify({ head: headOf(c), staged: stagedOf(c), files: listFiles(dir || c.domains), remote: remoteHead(remote), list: remoteFiles(remote) });
}
async function connected(files, mode = 'push') {
  const { remote, url } = bareRemote();
  const dir = write(fresh('vault'), files);
  const c = computer(dir);
  use(c);
  await sync.setup(url, 't', mode);
  return { remote, url, c, dir };
}

// ═══════════════════════════════════════════════════════════════════════════
section('§1 REPRO — the two cases that wiped the remote on v4.2.0 are stopped');
// ═══════════════════════════════════════════════════════════════════════════
{
  // N3: an install from before v4.1.2 (no folder record at all), whose folder
  // was changed to another vault that ALSO has a physics/ domain.
  const { remote, c } = await connected({ ...domain('history', 12), ...domain('physics', 3) });
  const before = remoteFiles(remote);
  gitOf(c, ['config', '--unset', T.WORK_TREE_KEY]);
  gitOf(c, ['config', '--unset', T.WORK_TREE_REAL_KEY]);
  const other = write(fresh('othervault'), domain('physics', 4, ' (other vault)'));
  use(c, other);
  const snap = snapshot({ ...c, domains: other }, remote);
  const r = await attempt(() => sync.sync());
  eq(codeOf(r), 'sync-deletions-need-confirm', 'N3: sync() over the moved folder is refused by the deletion guard');
  const d = refusalOf(r) ? refusalOf(r).details : {};
  ok(d.count >= 15 && d.wholeDomains && d.wholeDomains.includes('history'), 'N3: it counts the history/ domain that would vanish', d);
  eq(JSON.stringify(remoteFiles(remote)), JSON.stringify(before), 'N3: the remote still holds every file (history/ is not deleted)');
  eq(snapshot({ ...c, domains: other }, remote), snap, 'N3: nothing changed: HEAD, index, work tree and remote all as they were');
  for (const fn of ['push', 'pull']) {
    const rr = await attempt(() => sync[fn]());
    ok(/^sync-(pull-)?deletions-need-confirm$/.test(codeOf(rr) || ''), `N3: ${fn}() alone is refused too (${codeOf(rr)})`);
  }
  eq(JSON.stringify(remoteFiles(remote)), JSON.stringify(before), 'N3: the remote is still untouched after push() and pull()');
  // CONTROL: this deletion IS what the sync would have done (what v4.2.0 did
  // without asking). Confirming it lets it through, and history/ goes.
  const tokens = [d.confirmToken];
  let ctl = await attempt(() => sync.sync({ confirmDeletions: tokens }));
  for (let i = 0; i < 3 && refusalOf(ctl) && D.isDeletionCode(refusalOf(ctl).code); i++) {
    tokens.push(refusalOf(ctl).details.confirmToken);
    ctl = await attempt(() => sync.sync({ confirmDeletions: tokens }));
  }
  ok(!ctl.err, 'CONTROL: confirmed, the same sync goes through', ctl.err && ctl.err.message);
  ok(!remoteFiles(remote).some((f) => f.startsWith('history/')), 'CONTROL: and history/ is then gone from the remote: the guard is what stood between them');
}
{
  // F1: the setting names a link; the link is pointed at another vault.
  const vaultA = write(fresh('vaultA'), { ...domain('history', 5), ...domain('physics', 5) });
  const vaultB = write(fresh('vaultB'), domain('cooking', 3));
  const link = path.join(fresh('links'), 'brain');
  symlinkSync(vaultA, link);
  const { remote, url } = bareRemote();
  const c = computer(link);
  use(c);
  await sync.setup(url, 't', 'push');
  writeFileSync(path.join(vaultA, 'history/wiki/concepts/new.md'), 'n\n');
  ok(!(await attempt(() => sync.sync())).err, 'F1 precondition: a sync through the link works');
  eq(gitOf(c, ['config', '--get', T.WORK_TREE_REAL_KEY]).trim(), realpathSync(vaultA), 'F1: the real path is recorded beside the link path');
  const before = remoteFiles(remote);
  unlinkSync(link);
  symlinkSync(vaultB, link);
  const r = await attempt(() => sync.sync());
  eq(codeOf(r), 'folder-changed', 'F1: re-pointed link: refused as folder-changed by the real-path record');
  ok(refusalOf(r) && refusalOf(r).details.realPathChanged === true && /leads to a different folder/.test(refusalOf(r).message),
    'F1: the sentence says the folder now leads somewhere else, and names the folder Sync backs up', refusalOf(r));
  eq(JSON.stringify(remoteFiles(remote)), JSON.stringify(before), 'F1: the remote is untouched');
  // An install synced before v4.2.1 (path record, no real record): the path
  // check passes as it did, and the deletion guard catches it.
  gitOf({ ...c }, ['config', '--unset', T.WORK_TREE_REAL_KEY]);
  const r2 = await attempt(() => sync.sync());
  eq(codeOf(r2), 'sync-deletions-need-confirm', 'F1 with no real record (pre-v4.2.1 install): the deletion guard refuses');
  ok(refusalOf(r2) && refusalOf(r2).details.wholeDomains.join(',') === 'history,physics', 'F1: naming both domains that would vanish', refusalOf(r2) && refusalOf(r2).details);
  eq(JSON.stringify(remoteFiles(remote)), JSON.stringify(before), 'F1: the remote is still untouched');
  unlinkSync(link);
  symlinkSync(vaultA, link);
  ok(!(await attempt(() => sync.sync())).err, 'F1: link pointed back: Sync works again');
  eq(gitOf(c, ['config', '--get', T.WORK_TREE_REAL_KEY]).trim(), realpathSync(vaultA), 'F1: and the next good sync records the real path again (no lock-out)');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2 the real-path record: what passes, what is refused');
// ═══════════════════════════════════════════════════════════════════════════
{
  // A swapped drive: the same path, other content. The real path is the
  // same, so only the count can see it.
  const { remote, c, dir } = await connected({ ...domain('alpha', 8), ...domain('beta', 2) });
  const before = remoteFiles(remote);
  for (const e of readdirSync(dir)) if (e !== '.gitignore') rmSync(path.join(dir, e), { recursive: true, force: true });
  write(dir, domain('gamma', 2));
  const r = await attempt(() => sync.sync());
  eq(codeOf(r), 'sync-deletions-need-confirm', 'swapped drive (same path, other content): refused by the count');
  eq(JSON.stringify(remoteFiles(remote)), JSON.stringify(before), 'swapped drive: the remote is untouched');
}
{
  // Legitimate spellings of the same folder.
  const tmpReal = realpathSync(tmpdir());
  const { c, dir } = await connected(domain('one', 2));
  const real = realpathSync(dir);
  const spellings = [['a trailing slash', `${dir}/`], ['the real path', real]];
  if (tmpReal !== tmpdir()) spellings.push(['/tmp-style link vs its real path (macOS /var vs /private/var)', dir.startsWith(tmpReal) ? dir.replace(tmpReal, tmpdir()) : dir]);
  // A symlinked "home": a link to the folder's parent.
  const homeLink = path.join(fresh('homes'), 'me');
  symlinkSync(path.dirname(dir), homeLink);
  spellings.push(['through a symlinked parent ("home")', path.join(homeLink, path.basename(dir))]);
  // Another letter case, where the file system folds case (APFS default).
  const upper = path.join(path.dirname(dir), path.basename(dir).toUpperCase());
  let caseFolds = false;
  try { caseFolds = realpathSync(upper) === real; } catch { caseFolds = false; }
  if (caseFolds) spellings.push(['another letter case (case-insensitive volume)', upper]);
  for (const [label, p] of spellings) {
    use(c, p);
    writeFileSync(path.join(dir, 'one/wiki/concepts/x.md'), `${label}\n`);
    const r = await attempt(() => sync.sync());
    ok(!r.err, `same folder as ${label}: syncs`, r.err && r.err.message);
  }
  if (!caseFolds) console.log('  (case-sensitive volume: the letter-case spelling is a different folder here, not run)');
  // No real record (an install synced before v4.2.1): never locked out, recorded once.
  use(c, dir);
  gitOf(c, ['config', '--unset', T.WORK_TREE_REAL_KEY]);
  writeFileSync(path.join(dir, 'one/wiki/concepts/y.md'), 'y\n');
  const r = await attempt(() => sync.sync());
  ok(!r.err, 'no real record yet: syncs', r.err && r.err.message);
  eq(gitOf(c, ['config', '--get', T.WORK_TREE_REAL_KEY]).trim(), real, 'and that sync records the real path');
  // The routes' view of the record follows the real path.
  ok(sync.isRecordedSyncFolder(real) && !sync.syncFolderIsElsewhere(), 'isRecordedSyncFolder / syncFolderIsElsewhere agree with the real record');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3 PUSH — thresholds, "nothing changed", the token');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { remote, c, dir } = await connected({ ...domain('articles', 40), ...domain('research', 5) });
  // A page or two deleted on purpose: never asks.
  rmSync(path.join(dir, 'articles/wiki/concepts/p0.md'));
  rmSync(path.join(dir, 'articles/wiki/concepts/p1.md'));
  const r1 = await attempt(() => sync.push());
  ok(!r1.err, 'two pages deleted: push goes through without a question', r1.err && r1.err.message);
  ok(!remoteFiles(remote).includes('articles/wiki/concepts/p0.md'), 'and they are deleted from the remote');

  // Six: asks, and changes nothing.
  for (let i = 2; i < 8; i++) rmSync(path.join(dir, `articles/wiki/concepts/p${i}.md`));
  const snap = snapshot(c, remote);
  const r2 = await attempt(() => sync.push());
  eq(codeOf(r2), 'sync-deletions-need-confirm', 'six pages deleted: push asks first');
  const d = refusalOf(r2).details;
  eq(d.count, 6, 'count is 6');
  eq(d.pages, 6, 'and all six are wiki pages');
  eq(JSON.stringify(d.byDomain), JSON.stringify([{ domain: 'articles', count: 6, pages: 6 }]), 'grouped by domain');
  ok(Array.isArray(d.sample) && d.sample.length === 6 && d.sample.length <= 20, 'the sample names them (at most 20)', d.sample);
  ok(/^sdo-[0-9a-f]{40}$/.test(d.confirmToken), 'a confirm token', d.confirmToken);
  eq(d.stale, false, 'not stale: nothing was confirmed before');
  ok(/This sync would delete 6 pages from your GitHub backup \(articles 6\)/.test(refusalOf(r2).message) && /Nothing was changed/.test(refusalOf(r2).message),
    'the sentence counts and names them, and says nothing changed', refusalOf(r2).message);
  eq(snapshot(c, remote), snap, 'NOTHING CHANGED: HEAD, the index (nothing staged), the work tree and the remote');

  // One more deleted, then the old token: stale, asked again with a new one.
  rmSync(path.join(dir, 'articles/wiki/concepts/p8.md'));
  const r3 = await attempt(() => sync.push({ confirmDeletions: d.confirmToken }));
  eq(codeOf(r3), 'sync-deletions-need-confirm', 'the set changed: the old token is refused');
  ok(refusalOf(r3).details.stale === true && refusalOf(r3).details.confirmToken !== d.confirmToken && refusalOf(r3).details.count === 7,
    'marked stale, with a new token for the 7', refusalOf(r3).details);
  ok(!remoteFiles(remote).includes('articles/wiki/concepts/p8.md') === false, 'the remote still has them');
  // The same paths with the remote's content changed is another set too.
  const tok7 = refusalOf(r3).details.confirmToken;
  const r4 = await attempt(() => sync.push({ confirmDeletions: ['sdo-' + '0'.repeat(40), 'garbage', tok7] }));
  ok(!r4.err, 'the current token (among junk ones) confirms: push goes through', r4.err && r4.err.message);
  ok(!remoteFiles(remote).includes('articles/wiki/concepts/p8.md') && remoteFiles(remote).includes('articles/wiki/concepts/p9.md'),
    'exactly those seven are deleted from the remote, nothing else');
}
{
  // The token is bound to content: same path set, a different remote copy.
  const a = D.summarizeDeletions('out', [['x/wiki/a.md', '1'.repeat(40)]], new Map([['x/wiki/a.md', '1']]), new Set());
  const b = D.summarizeDeletions('out', [['x/wiki/a.md', '2'.repeat(40)]], new Map([['x/wiki/a.md', '2']]), new Set());
  ok(a.confirmToken !== b.confirmToken, 'the token binds each path’s content, not only its name');
  const ai = D.summarizeDeletions('in', [['x/wiki/a.md', '1'.repeat(40)]], new Map([['x/wiki/a.md', '1']]), new Set());
  ok(ai.confirmToken !== a.confirmToken && ai.confirmToken.startsWith('sdi-'), 'and its direction');
}
{
  // The share rule, on a small knowledge base: 20 tracked files.
  const files = {};
  for (let i = 0; i < 20; i++) files[`notes/n${i}.md`] = `n${i}\n`;
  const { remote, dir } = await connected(files);
  const total = remoteFiles(remote).length; // 20 + .gitignore
  rmSync(path.join(dir, 'notes/n0.md'));
  rmSync(path.join(dir, 'notes/n1.md'));
  ok(!(await attempt(() => sync.push())).err, `2 of ${total}: under 10% passes`);
  for (const i of [2, 3, 4]) rmSync(path.join(dir, `notes/n${i}.md`));
  const r = await attempt(() => sync.push());
  eq(codeOf(r), 'sync-deletions-need-confirm', `3 of ${total - 2} (over 10%): asks`);
  eq(refusalOf(r).details.pages, 0, 'loose notes are files, not wiki pages');
  ok(/delete 3 files/.test(refusalOf(r).message), 'and the sentence says files', refusalOf(r).message);
}
{
  // A whole (small) domain, and hygiene junk.
  const { remote, dir, c } = await connected({ ...domain('big', 30), ...domain('tiny', 0) });
  rmSync(path.join(dir, 'tiny'), { recursive: true, force: true });
  const r = await attempt(() => sync.push());
  eq(codeOf(r), 'sync-deletions-need-confirm', 'a whole domain of 3 files disappearing: asks');
  eq(JSON.stringify(refusalOf(r).details.wholeDomains), '["tiny"]', 'naming it');
  write(dir, domain('tiny', 0));
  // Our own junk, tracked by an older version: never counted.
  const junk = {};
  for (let i = 0; i < 12; i++) junk[`big/wiki/concepts/sub${i}/.DS_Store`] = 'x';
  write(dir, junk);
  for (const p of Object.keys(junk)) gitOf(c, ['add', '-f', '--', p]);
  gitOf(c, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'old version tracked junk']);
  gitOf(c, ['push', '-q', 'origin', 'main']);
  ok(remoteFiles(remote).filter((f) => f.endsWith('.DS_Store')).length === 12, 'precondition: 12 .DS_Store files tracked on the remote');
  const rj = await attempt(() => sync.push());
  ok(!rj.err, 'untracking 12 .DS_Store files (our own repair) never asks', rj.err && rj.err.message);
  eq(remoteFiles(remote).filter((f) => f.endsWith('.DS_Store')).length, 0, 'and they leave the remote');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4 PULL — deletions arriving, and local ones before the auto-save');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { remote, url, c: a, dir: dirA } = await connected({ ...domain('articles', 20), ...domain('research', 4) });
  const dirB = fresh('vaultB2');
  const b = computer(dirB);
  use(b);
  await sync.setup(url, 't', 'pull');
  // A deletes nine pages, confirms, pushes.
  use(a);
  for (let i = 0; i < 9; i++) rmSync(path.join(dirA, `articles/wiki/concepts/p${i}.md`));
  const ra = await attempt(() => sync.sync());
  eq(codeOf(ra), 'sync-deletions-need-confirm', 'A: deleting 9 pages asks first');
  ok(!(await attempt(() => sync.sync({ confirmDeletions: refusalOf(ra).details.confirmToken }))).err, 'A: confirmed, pushed');
  // B: the pull would delete nine of B's pages.
  use(b);
  writeFileSync(path.join(dirB, 'research/wiki/concepts/local-edit.md'), 'B wrote this\n');
  const snap = snapshot(b, remote);
  const rb = await attempt(() => sync.pull());
  eq(codeOf(rb), 'sync-pull-deletions-need-confirm', 'B: the pull that would delete 9 local pages asks first');
  ok(/on this computer/.test(refusalOf(rb).message) && refusalOf(rb).details.count === 9 && /^sdi-/.test(refusalOf(rb).details.confirmToken),
    'B: counted, worded as deletions on this computer', refusalOf(rb));
  eq(snapshot(b, remote), snap, 'B: NOTHING CHANGED: no auto-save commit, nothing staged, the nine pages still on disk, the local edit kept');
  ok(existsSync(path.join(dirB, 'articles/wiki/concepts/p0.md')), 'B: p0.md is still on disk');
  const rs = await attempt(() => sync.sync());
  eq(codeOf(rs), 'sync-pull-deletions-need-confirm', 'B: Sync now asks the same question');
  const rok = await attempt(() => sync.sync({ confirmDeletions: [refusalOf(rs).details.confirmToken] }));
  ok(!rok.err, 'B: confirmed once, Sync now completes (the push half does not ask again)', rok.err && rok.err.message);
  ok(!existsSync(path.join(dirB, 'articles/wiki/concepts/p0.md')) && remoteFiles(remote).includes('research/wiki/concepts/local-edit.md'),
    'B: the nine are gone here, and B’s own new page reached the remote');

  // A local mass deletion is refused at the pull's auto-save (nothing committed).
  for (let i = 9; i < 16; i++) rmSync(path.join(dirB, `articles/wiki/concepts/p${i}.md`));
  const head = headOf(b);
  const rl = await attempt(() => sync.pull());
  eq(codeOf(rl), 'sync-deletions-need-confirm', 'B: Pull only with 7 pages deleted here asks before its auto-save');
  eq(headOf(b), head, 'B: no auto-save commit was made');
  eq(stagedOf(b), '', 'B: and nothing is left staged');
}

{
  // THE MERGE IS THE COMMIT THAT WAS ASSESSED. Another computer pushes a mass
  // deletion in the instant between this pull's check and its merge (made
  // deterministic with a reference-transaction hook that fires on the
  // pull's own auto-save commit). `git pull` would fetch again and merge it
  // unasked; the guard merges what it counted, and the next sync asks.
  const { remote, url, dir: dirA } = await connected(domain('notes', 12));
  const dirB = fresh('vaultRace');
  const b = computer(dirB);
  use(b);
  await sync.setup(url, 't', 'pull');
  const clone = fresh('raceclone');
  gitRun(['clone', '-q', url, clone]);
  for (let i = 0; i < 8; i++) rmSync(path.join(clone, `notes/wiki/concepts/p${i}.md`));
  gitRun(['-C', clone, 'add', '-A']);
  gitRun(['-C', clone, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'mass deletion elsewhere']);
  const marker = path.join(fresh('marker'), 'fired');
  mkdirSync(path.join(b.gitDir, 'hooks'), { recursive: true });
  const hook = path.join(b.gitDir, 'hooks', 'reference-transaction');
  writeFileSync(hook, `#!/bin/sh\n[ "$1" = committed ] || exit 0\ngrep -q refs/heads/main || exit 0\n[ -e "${marker}" ] && exit 0\ntouch "${marker}"\n` +
    `env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE git -C "${clone}" push -q origin main >/dev/null 2>&1\nexit 0\n`, { mode: 0o755 });
  writeFileSync(path.join(dirB, 'notes/wiki/concepts/b-edit.md'), 'b\n');
  const r = await attempt(() => sync.pull());
  ok(existsSync(marker), 'precondition: the other computer’s deletion reached GitHub between the check and the merge');
  ok(!r.err, 'the pull merges what it assessed', r.err && r.err.message);
  ok(existsSync(path.join(dirB, 'notes/wiki/concepts/p0.md')), 'and the eight pages are NOT deleted here unasked');
  const r2 = await attempt(() => sync.pull());
  eq(codeOf(r2), 'sync-pull-deletions-need-confirm', 'the next pull counts them and asks');
  rmSync(hook);
  void dirA; void remote;
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5 ROUTES — every caller without a token is refused; the job records the question');
// ═══════════════════════════════════════════════════════════════════════════
{
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/sync', syncRouter);
  const server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/sync`;
  const post = async (kind, body) => {
    const res = await fetch(`${base}/${kind}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const { remote, dir } = await connected(domain('articles', 12));
  for (let i = 0; i < 8; i++) rmSync(path.join(dir, `articles/wiki/concepts/p${i}.md`));
  const before = remoteFiles(remote);
  __resetSyncJobForTest();
  for (const kind of ['sync', 'push', 'pull']) {
    const r = await post(kind);
    ok(r.status === 409 && r.body.code === 'sync-deletions-need-confirm' && r.body.details && r.body.details.count === 8,
      `POST /${kind} with no token (the Context page, an API client): 409 with the details`, r);
  }
  const bad = await post('sync', { confirmDeletions: 'sdo-' + 'f'.repeat(40) });
  ok(bad.status === 409 && bad.body.details.stale === true, 'a wrong token: refused, marked stale', bad.body);
  eq(JSON.stringify(remoteFiles(remote)), JSON.stringify(before), 'the remote is untouched by every refused request');
  const job = await (await fetch(`${base}/job`)).json();
  ok(job.last && job.last.state === 'failed' && job.last.code === 'sync-deletions-need-confirm' && job.last.details && /^sdo-/.test(job.last.details.confirmToken),
    'GET /job records the question with its details (the Sync page shows it as the card)', job.last);
  const okr = await post('sync', { confirmDeletions: [job.last.details.confirmToken] });
  ok(okr.status === 200, 'the token from the job: 200', okr.body);
  ok(!remoteFiles(remote).includes('articles/wiki/concepts/p0.md'), 'and the eight are deleted');
  server.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('§6 the words');
// ═══════════════════════════════════════════════════════════════════════════
{
  const entries = [];
  for (let i = 0; i < 38; i++) entries.push([`articles/wiki/concepts/a${i}.md`, String(i)]);
  for (let i = 0; i < 3; i++) entries.push([`research/wiki/entities/r${i}.md`, String(i)]);
  const before = new Map(entries);
  const s = D.summarizeDeletions('out', entries, before, new Set());
  eq(D.deletionHeadline(s), 'This sync would delete 41 pages from your GitHub backup (articles 38 · research 3).', 'the owner’s sentence, word for word');
  eq(D.deletionWhat({ count: 5, pages: 2 }), '5 files (2 of them pages)', 'mixed files and pages');
  eq(D.deletionWhat({ count: 1, pages: 1 }), '1 page', 'one page');
  ok(D.isWikiPagePath('a/wiki/concepts/x.md') && !D.isWikiPagePath('a/wiki/index.md') && !D.isWikiPagePath('a/wiki/log.md') && !D.isWikiPagePath('a/CLAUDE.md'),
    'a wiki page is a .md under <domain>/wiki/, not its index or log');
  eq(JSON.stringify(D.confirmedTokens(['x', 'sdo-' + 'a'.repeat(40), 7, 'sdi-' + 'b'.repeat(40)])), JSON.stringify(['sdo-' + 'a'.repeat(40), 'sdi-' + 'b'.repeat(40)]), 'only well-formed tokens are read');
  ok(D.isSignificant(6, 1000, 0) && !D.isSignificant(5, 1000, 0) && D.isSignificant(1, 1000, 1) && D.isSignificant(3, 20, 0) && !D.isSignificant(2, 10, 0),
    'the threshold: >5 files, a whole domain, or >=3 files over 10%');

  // The Sync page's card (shared/sync-deletion-card.js): the same words as
  // the server, the three buttons, never Pro-only.
  const C = await import('../src/public/next/shared/sync-deletion-card.js');
  const { proGuardFaults, protectedTexts } = await import('./test-helpers/pro-guard.js');
  const P = await import('../src/public/next/shared/pro.js');
  for (const dir of ['out', 'in']) {
    const sd = D.summarizeDeletions(dir, entries, before, new Set());
    eq(C.deletionHeadline(sd), D.deletionHeadline(sd), `card and server say the same sentence (${dir})`);
  }
  const card = C.deletionCardHtml({ ...s, stale: true });
  ok(card.includes('id="btn-deletions-cancel"') && card.includes('>Cancel<') && card.includes('id="btn-deletions-show"') && card.includes('>Show the pages<')
    && /class="btn btn-danger" id="btn-deletions-confirm"[^>]*>Delete them</.test(card), 'Cancel · Show the pages · Delete them (danger style)');
  ok(card.includes('If you didn’t delete these on purpose, press Cancel. Nothing is changed.') && card.includes('this is a new question'),
    'the owner’s wording, and a stale question says it is a new one');
  ok(!/chevron|<details|aria-expanded/.test(card), 'nothing on the card is behind a chevron');
  ok(proGuardFaults(card).length === 0, 'Pro guard rule 1: the card carries no Pro marking');
  const wrapped = '<div' + P.proAttr() + '>' + card + '</div>';
  ok(proGuardFaults(wrapped).length > 0, 'MUTATION CONTROL: the same card put behind Pro is flagged (it is protected by meaning: role=alert, data-never-pro, a confirm control)');
  ok(protectedTexts(card).some((t) => /would delete 41 pages/.test(t)), 'its sentence is one of the protected texts the parity rule checks');
  const list = C.deletionListHtml({ ...s, paths: ['a/<b>.md'], count: 3 });
  ok(list.includes('&lt;b&gt;') && !list.includes('<b>.md') && list.includes('and 2 more'), 'the reader list escapes every name and says how many are not listed');
}

// ── wrap up ────────────────────────────────────────────────────────────────
__setDomainsDirOverride(null);
eq(fingerprint(), FINGERPRINT_BEFORE, 'no real credential file in the repository was touched');
rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:\n  - ' + failures.join('\n  - ')); process.exit(1); }
