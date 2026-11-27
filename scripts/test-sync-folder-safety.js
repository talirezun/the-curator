#!/usr/bin/env node
/**
 * v4.1.2 safety release, package F1 (Sync). The audit's repros (2026-11-26,
 * AUDIT-wizards.md) turned into a suite. Every check drives the real code:
 * the brain's setup()/push()/pull()/preflightSetup() against local bare git
 * repositories (file://), and the folder routes' real handlers.
 *
 *   §1  S2/S3/W6  git runs with an argument array, no shell: hostile folder
 *                 names, repository addresses and tokens run nothing and act
 *                 on the right folder.
 *   §2  S4        a failed connect leaves no git dir, no token on disk.
 *   §3  S1        a second computer whose push was refused can Merge or Pull;
 *                 a git dir an earlier version left behind is recovered.
 *   §4  O1        changing the knowledge folder while Sync is connected never
 *                 deletes the remote's domains (brain floor + both routes).
 *   §5  O4        the picker validates exactly as the typed path does.
 *   §6  W4        a NEW knowledge repo pins core.autocrlf=false; an existing
 *                 one is left alone.
 *   §7  S6/S8/S9  input refusals name the field; a stale index.lock has its
 *                 own sentence; POST /setup on a connected install refuses.
 *   §8  N1        (candidate audit) a Pull never removes a local file, link or
 *                 folder in the way of the repository's folder or file: the
 *                 measurement and the byte check each refuse it; unreadable
 *                 files and folders are never "absent"; a failed connect never
 *                 removes a .gitignore it could not read.
 *   §9  N2/N3     the folder-changed sentence names only a remedy that works:
 *                 the routes accept the folder Sync recorded while connected;
 *                 without a record, it names only Disconnect.
 *   §10 N4        the record is stored and compared exactly (a name ending
 *                 in a space syncs; the trimmed name is another folder).
 *
 * Isolation: CURATOR_TEST_USER_DATA_DIR, CURATOR_TEST_DOMAINS_DIR, a fake HOME
 * and CURATOR_NO_OPEN are set BEFORE any app module is imported, and the sync
 * git dir / config file go through __setSyncTestOverrides. No network: every
 * remote is a local bare repository or a closed local port.
 */

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { createServer } from 'http';

const TMP = mkdtempSync(path.join(tmpdir(), 'curator-f1-'));
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
const { __setDomainsDirOverride, getDomainsDir } = await import('../src/brain/config.js');
const cfgRoutes = await import('../src/routes/config.js');
const { getCapabilities } = await import('../src/brain/install-mode.js');
const { getCuratorConfigFile, APP_ROOT } = await import('../src/brain/paths.js');
const { default: syncRouter } = await import('../src/routes/sync.js');
const { default: configRouter } = await import('../src/routes/config.js');
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
function bareRemote(files = null) {
  const base = fresh('remote');
  const remote = path.join(base, 'r.git');
  gitRun(['init', '--bare', '-q', '-b', 'main', remote]);
  if (files) {
    const seed = path.join(base, 'seed');
    mkdirSync(seed);
    gitRun(['init', '-q', '-b', 'main'], seed);
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(seed, rel)), { recursive: true });
      writeFileSync(path.join(seed, rel), body);
    }
    gitRun(['add', '-A'], seed);
    gitRun(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'seed'], seed);
    gitRun(['push', '-q', remote, 'main'], seed);
  }
  return { remote, url: `file://${remote}` };
}
const remoteFiles = (remote) => {
  try { return gitRun(['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'main']).split('\n').filter(Boolean).sort(); }
  catch { return []; }
};
function domainsWith(dir, files) {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}
/** One "computer": its own git dir, config file and knowledge folder. */
function computer(domainsDir) {
  const home = fresh('computer');
  const c = { gitDir: path.join(home, '.knowledge-git'), configFile: path.join(home, '.sync-config.json'), domains: domainsDir };
  return c;
}
function use(c) {
  sync.__setSyncTestOverrides({ gitDir: c.gitDir, configFile: c.configFile });
  __setDomainsDirOverride(c.domains);
}
async function attempt(fn) { try { return { value: await fn() }; } catch (err) { return { err }; } }
const codeOf = (r) => (r.err && sync.syncRefusalOf(r.err) ? sync.syncRefusalOf(r.err).code : null);
function allFilesContaining(dir, needle) {
  const hits = [];
  const walk = (d) => {
    let ents; try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { if (readFileSync(p).includes(needle)) hits.push(p); } catch { /* unreadable */ } }
    }
  };
  walk(dir);
  return hits;
}
const TOKEN = 'ghp_' + 'Z'.repeat(36);

// ═══════════════════════════════════════════════════════════════════════════
section('§1 S2/S3/W6 — git runs with an argument array, never a shell');
// ═══════════════════════════════════════════════════════════════════════════
{
  // (a) the helper refuses a command string outright
  const r = await attempt(() => T.git('status --porcelain'));
  ok(r.err instanceof TypeError, 'git() refuses a command string (a future call site cannot bring the shell back)');

  // (b) `Cash$flow notes` beside `Cash notes`: the audit's wrong-folder repro
  const parent = fresh('dollar');
  const sibling = domainsWith(path.join(parent, 'Cash notes'), { 'PRIVATE.md': 'not for github\n' });
  const real = domainsWith(path.join(parent, 'Cash$flow notes'), { 'money/wiki/index.md': '# money\n' });
  const { remote, url } = bareRemote();
  const c = computer(real);
  use(c);
  const res = await attempt(() => sync.setup(url, 't', 'push'));
  ok(!res.err, 'connect from a folder named `Cash$flow notes` succeeds', res.err && res.err.message);
  const files = remoteFiles(remote);
  ok(files.includes('money/wiki/index.md'), 'the repository received the wiki from THAT folder', files);
  ok(!files.includes('PRIVATE.md'), 'and nothing from the sibling `Cash notes` (shell expansion of $flow)', files);
  ok(existsSync(path.join(sibling, 'PRIVATE.md')), 'control: the sibling folder still exists and was a real trap');

  // (c) a double quote in the folder name
  const quoted = domainsWith(path.join(fresh('quote'), 'My "Brain"'), { 'a/wiki/index.md': '# a\n' });
  const q = bareRemote();
  const cq = computer(quoted);
  use(cq);
  const rq = await attempt(() => sync.setup(q.url, 't', 'push'));
  ok(!rq.err, 'connect from a folder named `My "Brain"` succeeds', rq.err && rq.err.message);
  ok(remoteFiles(q.remote).includes('a/wiki/index.md'), 'and its wiki is in the repository');

  // (d) command substitution and a backtick in the folder path
  const markerDir = fresh('markers');
  const m1 = path.join(markerDir, 'M1');
  const m2 = path.join(markerDir, 'M2');
  const evil = domainsWith(path.join(fresh('evil'), `x$(touch ${m1})`, `y\`touch ${m2}\`z`), { 'd/wiki/index.md': '# d\n' });
  const e = bareRemote();
  const ce = computer(evil);
  use(ce);
  const re = await attempt(() => sync.setup(e.url, 't', 'push'));
  ok(!re.err, 'connect from a folder path holding $(…) and a backtick succeeds', re.err && re.err.message);
  ok(!existsSync(m1) && !existsSync(m2), 'and RAN NOTHING: neither marker file exists');
  const pushAgain = await attempt(() => { writeFileSync(path.join(evil, 'd/wiki/new.md'), 'x\n'); return sync.push(); });
  ok(!pushAgain.err && remoteFiles(e.remote).includes('d/wiki/new.md'), 'a later push from that folder works too', pushAgain.err && pushAgain.err.message);
  ok(!existsSync(m1) && !existsSync(m2), 'and still ran nothing');

  // (e) the repository address: injection through preflight and setup
  const m3 = path.join(markerDir, 'M3');
  const m4 = path.join(markerDir, 'M4');
  const m5 = path.join(markerDir, 'M5');
  const plain = domainsWith(fresh('plain'), { 'p/wiki/index.md': '# p\n' });
  const cp = computer(plain);
  use(cp);
  const badUrls = [
    `file://${TMP}/nope$(touch${'${IFS}'}${m3}).git`,
    `https://127.0.0.1:9/o/r$(touch${'${IFS}'}${m4})`,
    `https://127.0.0.1:9/o/r\`touch${'${IFS}'}${m5}\``,
  ];
  for (const u of badUrls) {
    await attempt(() => sync.preflightSetup(u, TOKEN));
    await attempt(() => sync.setup(u, TOKEN, 'push'));
  }
  ok(![m3, m4, m5].some(existsSync), 'a repository address holding $(…) or a backtick runs nothing (preflight and connect)');
  ok(!existsSync(cp.gitDir), 'and leaves no git dir behind');

  // (f) the argv layer on its own, past the input check (dumb cross-check):
  //     a hostile ARGUMENT reaches git as one argument and nothing runs.
  const m6 = path.join(markerDir, 'M6');
  await attempt(() => T.git(['config', '--get', `x$(touch ${m6})`], { gitDir: c.gitDir }));
  ok(!existsSync(m6), 'git() hands a $(…) argument to git as data');
  const m7 = path.join(markerDir, 'M7');
  await attempt(() => T.git(['remote', 'set-url', 'origin', `https://a";touch ${m7};"@h/o/r`], { gitDir: c.gitDir }));
  ok(!existsSync(m7), 'and a quote-breaking address too');
  eq(T.git.length >= 1 && typeof T.git, 'function', 'control: the helper under test is the real one');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2 S4 — a failed connect leaves no token on disk');
// ═══════════════════════════════════════════════════════════════════════════
{
  const dom = domainsWith(fresh('s4'), { 'z/wiki/index.md': '# z\n' });
  // an unreachable host (a closed local port) and a repository that does not exist
  for (const [label, u] of [['an unreachable host', 'https://127.0.0.1:9/owner/wiki'], ['a missing repository', `file://${TMP}/missing.git`]]) {
    for (const mode of ['push', 'merge', 'pull']) {
      const c = computer(dom);
      use(c);
      const r = await attempt(() => sync.setup(u, TOKEN, mode));
      ok(!!r.err, `${label}, ${mode}: the connect fails`);
      ok(!existsSync(c.gitDir), `${label}, ${mode}: no git dir is left behind`);
      ok(!existsSync(c.configFile), `${label}, ${mode}: no settings file is written`);
      eq(allFilesContaining(path.dirname(c.gitDir), TOKEN).length, 0, `${label}, ${mode}: the token is in no file on this computer`);
      ok(!sync.isConfigured(), `${label}, ${mode}: the install still reads "not connected"`);
    }
  }
  // An existing git dir (here: one an earlier version left behind) keeps its
  // history; only the address goes, so no token stays for a connection that does not exist.
  const c = computer(dom);
  use(c);
  mkdirSync(c.gitDir, { recursive: true });
  gitRun(['--git-dir', c.gitDir, '--work-tree', dom, 'init', '-q']);
  gitRun(['--git-dir', c.gitDir, 'remote', 'add', 'origin', `https://${TOKEN}@127.0.0.1:9/old/old.git`]);
  const r = await attempt(() => sync.setup('https://127.0.0.1:9/owner/wiki', TOKEN, 'push'));
  ok(!!r.err && existsSync(c.gitDir), 'an existing git dir: the connect fails and the directory is kept');
  eq(allFilesContaining(c.gitDir, TOKEN).length, 0, 'an existing git dir on an unconnected install: no token remains in it');
  eq((statSync(path.join(c.gitDir, 'config')).mode & 0o777), 0o600, 'and its config file is owner-only (0600)');

  // the success path keeps its 0600
  const ok1 = bareRemote();
  const cs = computer(domainsWith(fresh('s4ok'), { 'k/wiki/index.md': '# k\n' }));
  use(cs);
  await sync.setup(ok1.url, 't', 'push');
  eq((statSync(path.join(cs.gitDir, 'config')).mode & 0o777), 0o600, 'a successful connect: the git config is 0600');
  eq((statSync(cs.configFile).mode & 0o777), 0o600, 'and .sync-config.json is 0600');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3 S1 — a second computer whose push was refused can still Merge or Pull');
// ═══════════════════════════════════════════════════════════════════════════
async function firstComputer() {
  const { remote, url } = bareRemote();
  const a = computer(domainsWith(fresh('A'), { 'shared/wiki/index.md': '# from A\n', 'shared/wiki/a.md': 'A\n' }));
  use(a);
  await sync.setup(url, 't', 'push');
  return { remote, url, a };
}
{
  // MERGE after a refused push (the audit's case B)
  const { remote, url } = await firstComputer();
  const b = computer(domainsWith(fresh('B'), { 'mine/wiki/b.md': 'B only\n' }));
  use(b);
  const refused = await attempt(() => sync.setup(url, 't', 'push'));
  eq(codeOf(refused), 'remote-not-empty', 'B: the default Push is refused, the repository already has a wiki');
  ok(!existsSync(b.gitDir), 'B: and the refused push leaves no git dir behind');
  ok(!existsSync(path.join(b.domains, '.gitignore')), 'B: nor the .gitignore it had written into the folder (S9)');
  const merged = await attempt(() => sync.setup(url, 't', 'merge'));
  ok(!merged.err, 'B: Merge — keep both now succeeds', merged.err && merged.err.message);
  ok(existsSync(path.join(b.domains, 'mine/wiki/b.md')) && existsSync(path.join(b.domains, 'shared/wiki/a.md')),
    'B: both sides are in the folder after the merge');
  await sync.push();
  const rf = remoteFiles(remote);
  ok(rf.includes('mine/wiki/b.md') && rf.includes('shared/wiki/a.md'), 'B: and a push sends the merge up with nothing lost', rf);
}
{
  // PULL after a refused push (the audit's case C): no overlap, so it pulls
  const { url } = await firstComputer();
  const b = computer(domainsWith(fresh('B2'), { 'other/wiki/x.md': 'local only\n' }));
  use(b);
  eq(codeOf(await attempt(() => sync.setup(url, 't', 'push'))), 'remote-not-empty', 'B2: Push refused first');
  const pulled = await attempt(() => sync.setup(url, 't', 'pull'));
  ok(!pulled.err, 'B2: Pull now succeeds (was "would overwrite 0 files")', pulled.err && sync.syncRefusalOf(pulled.err));
  ok(existsSync(path.join(b.domains, 'shared/wiki/a.md')), 'B2: the repository\'s pages arrived');
  ok(existsSync(path.join(b.domains, 'other/wiki/x.md')), 'B2: the local-only page is still there');
}
{
  // PULL that WOULD overwrite still asks first, with the real count
  const { url } = await firstComputer();
  const b = computer(domainsWith(fresh('B3'), { 'shared/wiki/a.md': 'B changed this\n' }));
  use(b);
  await attempt(() => sync.setup(url, 't', 'push'));
  const p = await attempt(() => sync.setup(url, 't', 'pull'));
  const ref = p.err && sync.syncRefusalOf(p.err);
  eq(ref && ref.code, 'pull-would-overwrite', 'B3: a pull that would replace a changed page is still refused');
  eq(ref && ref.details.overwriteCount, 1, 'B3: with the true count (1), measured before anything is attempted');
  eq(readFileSync(path.join(b.domains, 'shared/wiki/a.md'), 'utf8'), 'B changed this\n', 'B3: and the page is untouched');
}
{
  // A git dir an EARLIER version left behind (commit on `main`, the token in
  // its address, no settings file): exactly the state the audit reproduced.
  async function leftover(files) {
    const { url, a } = await firstComputer();
    const b = computer(domainsWith(fresh('L'), files));
    // v4.1.1's refused push had also written the generated .gitignore: the
    // same bytes as the one computer A pushed, untracked here.
    writeFileSync(path.join(b.domains, '.gitignore'), readFileSync(path.join(a.domains, '.gitignore')));
    use(b);
    const g = ['--git-dir', b.gitDir, '--work-tree', b.domains];
    mkdirSync(b.gitDir, { recursive: true });
    gitRun([...g, 'init', '-q']);
    gitRun([...g, 'add', '-A']);
    gitRun([...g, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'Initial The Curator sync']);
    gitRun([...g, 'branch', '-M', 'main']);
    gitRun([...g, 'remote', 'add', 'origin', url]);
    return { url, b };
  }
  {
    const { url, b } = await leftover({ 'mine/wiki/m.md': 'mine\n' });
    const merged = await attempt(() => sync.setup(url, 't', 'merge'));
    ok(!merged.err, 'leftover git dir: Merge succeeds (was "a branch named main already exists" for good)', merged.err && merged.err.message);
    ok(existsSync(path.join(b.domains, 'mine/wiki/m.md')) && existsSync(path.join(b.domains, 'shared/wiki/a.md')), 'leftover: merge keeps both');
  }
  {
    const { url, b } = await leftover({ 'mine/wiki/m.md': 'mine\n' });
    const pulled = await attempt(() => sync.setup(url, 't', 'pull'));
    ok(!pulled.err, 'leftover git dir: Pull succeeds', pulled.err && (sync.syncRefusalOf(pulled.err) || pulled.err.message));
    ok(existsSync(path.join(b.domains, 'mine/wiki/m.md')),
      'leftover: the page tracked only by the leftover commit is NOT deleted by the checkout');
    ok(existsSync(path.join(b.domains, 'shared/wiki/a.md')), 'leftover: the repository\'s pages arrived');
    const branches = gitRun(['--git-dir', b.gitDir, 'branch', '--list', 'curator-before-connect-*']).trim();
    ok(/curator-before-connect-/.test(branches), 'leftover: the old commit is kept on its own branch, never deleted', branches);
  }
}

{
  // A page copied by hand with the remote's exact bytes is not an overwrite;
  // a .gitignore with DIFFERENT bytes still is (control).
  const { url } = await firstComputer();
  const b = computer(domainsWith(fresh('copy'), { 'shared/wiki/a.md': 'A\n' }));
  use(b);
  const p = await attempt(() => sync.setup(url, 't', 'pull'));
  ok(!p.err, 'an identical hand-copied page does not block a Pull', p.err && (sync.syncRefusalOf(p.err) || p.err.message));
  const { url: u2 } = await firstComputer();
  const b2 = computer(domainsWith(fresh('copy2'), { '.gitignore': 'something else\n' }));
  use(b2);
  const p2 = await attempt(() => sync.setup(u2, 't', 'pull'));
  eq(codeOf(p2), 'pull-would-overwrite', 'control: a .gitignore with different bytes is still an overwrite the person must confirm');
  eq(readFileSync(path.join(b2.domains, '.gitignore'), 'utf8'), 'something else\n', 'and it is untouched');
  // A DIRECTORY where the remote has a file is not something the byte check
  // can vouch for: the pull stays refused and the directory's page is kept.
  const { url: u3 } = await firstComputer();
  const b3 = computer(domainsWith(fresh('dirway'), { 'shared/wiki/a.md/note.md': 'mine, inside a folder\n' }));
  use(b3);
  const p3 = await attempt(() => sync.setup(u3, 't', 'pull'));
  ok(!!p3.err, 'a folder in the way of a remote file: the pull is refused');
  eq(existsSync(path.join(b3.domains, 'shared/wiki/a.md/note.md')) ? readFileSync(path.join(b3.domains, 'shared/wiki/a.md/note.md'), 'utf8') : null,
    'mine, inside a folder\n', 'and the page inside that folder is untouched');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4 O1 — a changed knowledge folder never deletes the remote\'s domains');
// ═══════════════════════════════════════════════════════════════════════════
{
  // The brain floor: the audit's repro, with the folder changed underneath Sync.
  const { remote, url } = bareRemote();
  const oldDir = domainsWith(fresh('old'), { 'history/wiki/index.md': '# h\n', 'physics/wiki/index.md': '# p\n' });
  const newDir = domainsWith(fresh('new'), { 'cooking/wiki/index.md': '# c\n' });
  const c = computer(oldDir);
  use(c);
  await sync.setup(url, 't', 'push');
  const before = remoteFiles(remote);
  ok(before.includes('history/wiki/index.md') && before.includes('physics/wiki/index.md'), 'precondition: the remote holds history/ and physics/');
  __setDomainsDirOverride(newDir);
  for (const [name, fn] of [['sync', sync.sync], ['push', sync.push], ['pull', sync.pull]]) {
    const r = await attempt(fn);
    eq(codeOf(r), 'folder-changed', `${name}() after the folder changed: refused`);
  }
  eq(JSON.stringify(remoteFiles(remote)), JSON.stringify(before), 'the remote is byte-for-byte the same list: nothing deleted');
  ok(!existsSync(path.join(newDir, '.gitignore')), 'and nothing was written into the new folder');
  const d = sync.describeSyncError((await attempt(sync.sync)).err);
  ok(/Disconnect/.test(d.error) && /Nothing was changed/.test(d.error), 'the sentence says nothing changed and names the way out', d.error);
  __setDomainsDirOverride(oldDir);
  writeFileSync(path.join(oldDir, 'history/wiki/new.md'), 'n\n');
  const back = await attempt(sync.sync);
  ok(!back.err && remoteFiles(remote).includes('history/wiki/new.md'), 'with the folder set back, Sync works again', back.err && back.err.message);

  // An install synced by a version with no record (the legacy check)
  gitRun(['--git-dir', c.gitDir, 'config', '--unset', T.WORK_TREE_KEY]);
  __setDomainsDirOverride(newDir);
  eq(codeOf(await attempt(sync.push)), 'folder-changed', 'no record yet: a folder holding none of the tracked domains is refused');
  eq(JSON.stringify(remoteFiles(remote).filter((f) => f.startsWith('cooking/'))), '[]', 'and cooking/ was not sent');
  __setDomainsDirOverride(oldDir);
  const legacyOk = await attempt(sync.push);
  ok(!legacyOk.err, 'no record yet, same folder: allowed', legacyOk.err && legacyOk.err.message);
  eq(gitRun(['--git-dir', c.gitDir, 'config', '--get', T.WORK_TREE_KEY]).trim(), oldDir, 'and the first sync it lets through records the folder');
}
{
  // The routes: typed path and picker refuse while Sync is connected.
  const { url } = bareRemote();
  const cur = domainsWith(fresh('routecur'), { 'r/wiki/index.md': '# r\n' });
  const other = domainsWith(fresh('routeother'), { 's/wiki/index.md': '# s\n' });
  const c = computer(cur);
  use(c);
  await sync.setup(url, 't', 'push');
  const cfgFile = getCuratorConfigFile();
  const cfgBefore = existsSync(cfgFile) ? readFileSync(cfgFile, 'utf8') : null;
  const fakeRes = () => { const r = { statusCode: 200, body: null, status(s) { r.statusCode = s; return r; }, json(b) { r.body = b; return r; } }; return r; };

  const t1 = fakeRes();
  cfgRoutes.domainsPathHandler({ body: { path: other } }, t1, null);
  eq(t1.statusCode, 400, 'typed path while Sync is connected: refused (400)');
  eq(t1.body && t1.body.reason, 'sync-connected', 'with reason sync-connected');
  ok(t1.body && !('cancelled' in t1.body), 'and never `cancelled` (the frontends read that first)');
  eq(existsSync(cfgFile) ? readFileSync(cfgFile, 'utf8') : null, cfgBefore, 'and the settings file is unchanged');

  const t2 = fakeRes();
  cfgRoutes.domainsPathHandler({ body: { path: cur } }, t2, null);
  eq(t2.statusCode, 200, 'typed path to the folder ALREADY set: allowed (changes nothing)');

  const pickDeps = (picked) => ({
    caps: getCapabilities('repo', 'darwin'), platform: 'darwin', hasActiveWrites: () => false,
    execAsync: async () => ({ stdout: picked + '\n' }),
  });
  const cfgNow = existsSync(cfgFile) ? readFileSync(cfgFile, 'utf8') : null;
  const p1 = fakeRes();
  await cfgRoutes.pickFolderHandler({}, p1, pickDeps(other));
  eq(p1.statusCode, 400, 'picker while Sync is connected: refused (400)');
  eq(p1.body && p1.body.reason, 'sync-connected', 'with reason sync-connected');
  eq(existsSync(cfgFile) ? readFileSync(cfgFile, 'utf8') : null, cfgNow, 'and the settings file is unchanged');

  // before the dialog opens: the middleware on the route
  const m = fakeRes();
  let nextCalled = false;
  cfgRoutes.refuseFolderChangeWhileSyncConnected({}, m, () => { nextCalled = true; });
  ok(!nextCalled && m.statusCode === 400 && m.body.reason === 'sync-connected', 'the picker route refuses before any dialog opens');
  const layer = configRouter.stack.find((l) => l.route && l.route.path === '/pick-folder');
  ok(!!layer && layer.route.stack.some((s) => s.handle === cfgRoutes.refuseFolderChangeWhileSyncConnected),
    'and that check is on the /pick-folder route itself');

  // disconnected: both work as before
  await sync.disconnect();
  ok(!sync.isConfigured(), 'precondition: disconnected');
  const m2 = fakeRes();
  let next2 = false;
  cfgRoutes.refuseFolderChangeWhileSyncConnected({}, m2, () => { next2 = true; });
  ok(next2, 'disconnected: the picker route lets the request through');
  const t3 = fakeRes();
  cfgRoutes.domainsPathHandler({ body: { path: other } }, t3, null);
  eq(t3.statusCode, 200, 'disconnected: the typed path is applied');
  ok(readFileSync(cfgFile, 'utf8').includes(JSON.stringify(other).slice(1, -1)), 'and written to the (test) settings file');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5 O4 — the picker validates exactly as the typed path does');
// ═══════════════════════════════════════════════════════════════════════════
{
  sync.__setSyncTestOverrides({ gitDir: path.join(fresh('nosync'), '.knowledge-git'), configFile: path.join(TMP, 'none.json') });
  const cfgFile = getCuratorConfigFile();
  const fakeRes = () => { const r = { statusCode: 200, body: null, status(s) { r.statusCode = s; return r; }, json(b) { r.body = b; return r; } }; return r; };
  for (const platform of ['darwin', 'linux']) {
    for (const bad of [path.join(APP_ROOT, 'src'), APP_ROOT]) {
      const before = existsSync(cfgFile) ? readFileSync(cfgFile, 'utf8') : null;
      const typed = fakeRes();
      cfgRoutes.domainsPathHandler({ body: { path: bad } }, typed, null);
      const picked = fakeRes();
      const deps = {
        caps: getCapabilities('repo', platform), platform, hasActiveWrites: () => false,
        execAsync: async () => ({ stdout: bad + '\n' }),
        pickFolderLinux: async () => ({ kind: 'picked', path: bad }),
      };
      await cfgRoutes.pickFolderHandler({}, picked, deps);
      eq(typed.statusCode, 400, `${platform}, ${path.relative(path.dirname(APP_ROOT), bad)}: the typed path refuses it`);
      eq(picked.statusCode, 400, `${platform}, ${path.relative(path.dirname(APP_ROOT), bad)}: the picker refuses it too`);
      eq(picked.body && picked.body.reason, typed.body && typed.body.reason, `${platform}: with the same reason (${typed.body && typed.body.reason})`);
      eq(existsSync(cfgFile) ? readFileSync(cfgFile, 'utf8') : null, before, `${platform}: and nothing is written`);
    }
  }
  const good = fresh('goodpick');
  const r = fakeRes();
  await cfgRoutes.pickFolderHandler({}, r, { caps: getCapabilities('repo', 'darwin'), platform: 'darwin', hasActiveWrites: () => false, execAsync: async () => ({ stdout: good + '/\n' }) });
  ok(r.statusCode === 200 && r.body.ok === true, 'control: an ordinary folder from the picker is still applied', r.body);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§6 W4 — line endings are pinned on a NEW knowledge repo only');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { url } = bareRemote();
  const c = computer(domainsWith(fresh('crlf'), { 'q/wiki/index.md': '# q\n' }));
  use(c);
  await sync.setup(url, 't', 'push');
  let pinned = null;
  try { pinned = gitRun(['--git-dir', c.gitDir, 'config', '--local', '--get', 'core.autocrlf']).trim(); } catch { pinned = null; }
  eq(pinned, 'false', 'a repo created by Connect has core.autocrlf=false in its own config');
  const pre = await attempt(() => sync.preflightSetup(url, 't'));
  ok(!pre.err, 'preflight (its throwaway repo is new too) still works', pre.err && pre.err.message);

  // an existing repository is not changed: turning conversion off there would
  // make every CRLF-written file look modified
  const c2 = computer(domainsWith(fresh('crlf2'), { 'q/wiki/index.md': '# q\n' }));
  use(c2);
  mkdirSync(c2.gitDir, { recursive: true });
  gitRun(['--git-dir', c2.gitDir, '--work-tree', c2.domains, 'init', '-q']);
  gitRun(['--git-dir', c2.gitDir, 'config', 'core.autocrlf', 'true']);
  await attempt(() => sync.setup(url, 't', 'merge'));
  eq(gitRun(['--git-dir', c2.gitDir, 'config', '--local', '--get', 'core.autocrlf']).trim(), 'true', 'an existing repo keeps its own core.autocrlf');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§7 S6/S8/S9 — inputs named by field; a stale lock; connect on a connected install');
// ═══════════════════════════════════════════════════════════════════════════
{
  const cases = [
    ['not a url', TOKEN, 'invalid-repo-url'],
    ['https://github.com/a b/c', TOKEN, 'invalid-repo-url'],
    ['https://user:pw@github.com/o/r', TOKEN, 'invalid-repo-url'],
    ['ssh://git@github.com/o/r.git', TOKEN, 'invalid-repo-url'],
    [42, TOKEN, 'invalid-repo-url'],
    ['https://github.com/o/r', 'ghp_with spaces in it xxxxxxxxxxxxxxx', 'invalid-token'],
    ['https://github.com/o/r', 'short', 'invalid-token'],
  ];
  for (const [u, t, want] of cases) {
    const r = await attempt(() => T.checkConnectInput(u, t));
    eq(codeOf(r), want, `${JSON.stringify(u)} / token ${JSON.stringify(String(t).slice(0, 12))}…: refused as ${want}`);
  }
  eq(T.checkConnectInput('https://github.com/o/r/', TOKEN).repoUrl, 'https://github.com/o/r', 'a trailing slash is dropped');
  eq(T.checkConnectInput('https://github.com/o/r/tree/main', TOKEN).repoUrl, 'https://github.com/o/r', 'a pasted /tree/main page address is reduced to the repository');
  eq(T.checkConnectInput('git@github.com:o/r.git', TOKEN).repoUrl, 'git@github.com:o/r.git', 'the ssh form for github.com is still accepted');
  eq(T.checkConnectInput(' file:///x/r.git ', 't').repoUrl, 'file:///x/r.git', 'file:// is accepted with any token (it carries none)');

  // an invalid input writes nothing into the knowledge folder (S9's first half)
  const dom = fresh('s9');
  use(computer(dom));
  await attempt(() => sync.setup('not a url', TOKEN, 'push'));
  ok(!existsSync(path.join(dom, '.gitignore')), 'a refused address writes no .gitignore into the knowledge folder');

  // S8
  const lock = sync.describeSyncError(new Error("Command failed: git commit\nfatal: Unable to create '/x/.knowledge-git/index.lock': File exists.\n\nAnother git process seems to be running"));
  eq(lock.code, 'sync-index-locked', 'a stale index.lock has its own code');
  ok(/index\.lock/.test(lock.error) && !/Try again in a minute/.test(lock.error), 'and a sentence that names the file instead of "try again"', lock.error);

  // S9 and S6 over HTTP: the real routers on a local server
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/sync', syncRouter);
  const server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const post = async (p, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const { url } = bareRemote();
  const c = computer(domainsWith(fresh('http'), { 'h/wiki/index.md': '# h\n' }));
  use(c);
  const bad = await post('/api/sync/preflight', { repoUrl: 'not a url', token: TOKEN });
  eq(bad.status, 400, 'POST /preflight with an unusable address: 400, not a server failure');
  eq(bad.body.code, 'invalid-repo-url', 'and the code names the field');
  const first = await post('/api/sync/setup', { repoUrl: url, token: 't', mode: 'push' });
  eq(first.status, 200, 'POST /setup connects');
  const cfgBefore = readFileSync(c.configFile, 'utf8');
  const { url: url2 } = bareRemote();
  const second = await post('/api/sync/setup', { repoUrl: url2, token: 't', mode: 'push' });
  eq(second.status, 409, 'POST /setup on a connected install: refused (409)');
  eq(second.body.code, 'already-connected', 'with code already-connected');
  eq(readFileSync(c.configFile, 'utf8'), cfgBefore, 'and the install still points at the first repository');
  await new Promise((r) => server.close(r));
}

// ═══════════════════════════════════════════════════════════════════════════
section('§8 N1 — a Pull never removes a local file, folder or link that is in the way');
// ═══════════════════════════════════════════════════════════════════════════
// The candidate audit's N1: a regular FILE where the repository has a FOLDER
// (`shared`, or `shared/wiki`) made lstat throw ENOTDIR below it, the
// identical-bytes check took that as "absent", and `checkout -f` removed the
// file. Two independent layers now hold it, and each is checked on its own:
// the measurement (assessPullOverwrite, which the preview and the first
// refusal use) and the byte check behind git's own refusal
// (collisionsAreIdentical). The end-to-end Pull needs only one of them.
{
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const { symlinkSync, chmodSync, lstatSync } = await import('fs');
  /** A computer whose folder is shaped by `shape(dir)`, its git dir fetched from A's remote. */
  async function blocker(label, shape) {
    const { url } = await firstComputer();   // remote: .gitignore, shared/wiki/index.md, shared/wiki/a.md
    const dir = fresh(label);
    shape(dir);
    const c = computer(dir);
    use(c);
    return { url, c, dir };
  }
  async function layers(c, url) {
    await T.prepareRemote(c.gitDir, url, 60000);
    const a = await T.assessPullOverwrite(c.gitDir);
    const same = await T.collisionsAreIdentical(c.gitDir);
    rmSync(c.gitDir, { recursive: true, force: true });
    return { a, same };
  }
  const cases = [
    ['a FILE where the repository has a domain folder', 'fileTop',
      (d) => writeFileSync(path.join(d, 'shared'), 'ONLY COPY top\n'), 'shared', 'ONLY COPY top\n'],
    ['a FILE where the repository has a wiki folder', 'fileDeep',
      (d) => { mkdirSync(path.join(d, 'shared')); writeFileSync(path.join(d, 'shared', 'wiki'), 'ONLY COPY deep\n'); },
      'shared/wiki', 'ONLY COPY deep\n'],
    ['a FOLDER where the repository has a file', 'dirWay',
      (d) => domainsWith(d, { 'shared/wiki/a.md/kept.md': 'ONLY COPY in folder\n' }), 'shared/wiki/a.md', null],
  ];
  for (const [what, label, shape, at, body] of cases) {
    const { url, c, dir } = await blocker(label, shape);
    const { a, same } = await layers(c, url);
    ok(a.overwrite.includes(at), `${what}: the measurement counts it as an overwrite, named by its local path`, a);
    eq(same, false, `${what}: the byte check does not vouch for it`);
    const pre = await sync.preflightSetup(url, 't');
    ok(pre.overwriteCount >= 1 && pre.overwriteSample.includes(at), `${what}: the preview says so before anything is attempted`, pre.overwriteSample);
    const p = await attempt(() => sync.setup(url, 't', 'pull'));
    eq(codeOf(p), 'pull-would-overwrite', `${what}: a Pull with no confirmation is refused`);
    const full = path.join(dir, at);
    if (body !== null) {
      ok(existsSync(full) && lstatSync(full).isFile() && readFileSync(full, 'utf8') === body, `${what}: and the file is still there with its bytes`);
    } else {
      eq(existsSync(path.join(full, 'kept.md')) ? readFileSync(path.join(full, 'kept.md'), 'utf8') : null, 'ONLY COPY in folder\n',
        `${what}: and the page inside the folder is untouched`);
    }
    ok(!existsSync(c.gitDir), `${what}: and the refused connect left no git dir`);
  }
  {
    // A LINK where the repository has a folder: the link is not replaced by a folder.
    const outside = domainsWith(fresh('outside'), { 'mine.md': 'outside note\n' });
    const { url, c, dir } = await blocker('linkTop', (d) => symlinkSync(outside, path.join(d, 'shared')));
    const { a, same } = await layers(c, url);
    ok(a.overwrite.includes('shared'), 'a LINK where the repository has a folder: counted as an overwrite', a);
    eq(same, false, 'a LINK where the repository has a folder: the byte check does not vouch for it');
    eq(codeOf(await attempt(() => sync.setup(url, 't', 'pull'))), 'pull-would-overwrite', 'a LINK in the way: the Pull is refused');
    ok(lstatSync(path.join(dir, 'shared')).isSymbolicLink(), 'and the link is still a link');
    eq(JSON.stringify(readdirSync(outside)), '["mine.md"]', 'and its target folder is untouched');
  }
  {
    // A LINK at a file's own path, pointing at a file with the remote's bytes:
    // identical content, but a checkout would replace the link, so not vouched for.
    const twin = path.join(fresh('twin'), 'a.md');
    writeFileSync(twin, 'A\n');
    const { url, c } = await blocker('linkFile', (d) => { mkdirSync(path.join(d, 'shared', 'wiki'), { recursive: true }); symlinkSync(twin, path.join(d, 'shared', 'wiki', 'a.md')); });
    const { same } = await layers(c, url);
    eq(same, false, 'a LINK at a file path, even to identical bytes: the byte check does not vouch for it');
  }
  if (!isRoot) {
    // An UNREADABLE file with the remote's exact bytes: nothing is proven.
    const { url, c, dir } = await blocker('unread', (d) => domainsWith(d, { 'shared/wiki/a.md': 'A\n' }));
    const f = path.join(dir, 'shared/wiki/a.md');
    chmodSync(f, 0o000);
    const { same } = await layers(c, url);
    eq(same, false, 'an unreadable file, even with identical bytes: the byte check does not vouch for it');
    const p = await attempt(() => sync.setup(url, 't', 'pull'));
    ok(!!p.err, 'an unreadable file in the way: the Pull does not go ahead', p.value);
    chmodSync(f, 0o644);
    eq(readFileSync(f, 'utf8'), 'A\n', 'and the file is untouched');
    // An unreadable FOLDER on the way to a remote file: lstat answers EACCES.
    const { url: u2, c: c2, dir: d2 } = await blocker('unreadDir', (d) => domainsWith(d, { 'shared/wiki/x.md': 'mine\n' }));
    chmodSync(path.join(d2, 'shared/wiki'), 0o000);
    eq(T.localPathState(d2, 'shared/wiki/a.md').state, 'unknown', 'a folder that cannot be read: its contents are unknown, never "absent"');
    const { same: same2 } = await layers(c2, u2);
    eq(same2, false, 'and the byte check does not vouch for it');
    chmodSync(path.join(d2, 'shared/wiki'), 0o755);
    // A .gitignore the connect could not read: its earlier state is unknown,
    // so a failed connect does not "restore" it by removing the file.
    const gdir = domainsWith(fresh('gi'), { 'g/wiki/index.md': '# g\n', '.gitignore': 'my-private-notes/\n' });
    chmodSync(path.join(gdir, '.gitignore'), 0o000);
    use(computer(gdir));
    const gr = await attempt(() => sync.setup(`file://${TMP}/missing.git`, 't', 'push'));
    ok(!!gr.err, 'an unreadable .gitignore, a connect that fails: precondition, it fails');
    ok(existsSync(path.join(gdir, '.gitignore')), 'and the rollback does not delete a .gitignore whose earlier state it could not read');
    try { chmodSync(path.join(gdir, '.gitignore'), 0o644); } catch { /* replaced */ }
  } else {
    console.log('  (unreadable-file cases skipped: running as root)');
  }
  {
    // Controls: absent paths are creates, identical copies are vouched for.
    const { url, c } = await blocker('ctlEmpty', () => {});
    const { a, same } = await layers(c, url);
    eq(a.overwriteCount, 0, 'control: an empty folder has nothing to overwrite');
    eq(same, true, 'control: and nothing in the way');
    const { url: u2, c: c2 } = await blocker('ctlSame', (d) => domainsWith(d, { 'shared/wiki/a.md': 'A\n' }));
    const r2 = await layers(c2, u2);
    eq(r2.a.overwriteCount, 0, 'control: an identical hand-copied page is not counted');
    eq(r2.same, true, 'control: and the byte check vouches for it');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('§9 N2/N3 — the folder-changed refusal names only a way out that works');
// ═══════════════════════════════════════════════════════════════════════════
{
  const fakeRes = () => { const r = { statusCode: 200, body: null, status(s) { r.statusCode = s; return r; }, json(b) { r.body = b; return r; } }; return r; };
  const { remote, url } = bareRemote();
  const synced = domainsWith(fresh('synced'), { 'physics/wiki/index.md': '# p\n' });
  const fallback = domainsWith(fresh('fallback'), { 'scratch/wiki/index.md': '# s\n' });
  const third = domainsWith(fresh('third'), { 'third/wiki/index.md': '# t\n' });
  const c = computer(synced);
  use(c);
  await sync.setup(url, 't', 'push');
  const before = remoteFiles(remote);
  // The folder pointer goes elsewhere behind Sync's back (a "Start fresh" on
  // a damaged settings file puts it back to the default folder).
  __setDomainsDirOverride(fallback);
  const r = await attempt(sync.sync);
  eq(codeOf(r), 'folder-changed', 'the folder changed underneath: Sync refuses');
  const msg = sync.describeSyncError(r.err).error;
  ok(msg.includes('set the knowledge folder back') && msg.includes(synced), 'the sentence says to set the folder back, and names it', msg);
  eq(sync.syncRefusalOf(r.err).details.syncedFolder, synced, 'the details carry the folder Sync backs up');
  ok(sync.isRecordedSyncFolder(synced) && !sync.isRecordedSyncFolder(third), 'isRecordedSyncFolder answers for the recorded folder only');
  ok(sync.syncFolderIsElsewhere(), 'and the install is in the folder-changed state');

  // The remedy the sentence names: the typed path accepts the recorded folder.
  const t1 = fakeRes();
  cfgRoutes.domainsPathHandler({ body: { path: third } }, t1, null);
  eq(t1.statusCode, 400, 'while connected, any OTHER folder is still refused');
  ok(t1.body && t1.body.reason === 'sync-connected' && /only be set back/.test(t1.body.error),
    'with a sentence that says only the folder Sync backs up is accepted (not "connected to your current folder")', t1.body);
  const t2 = fakeRes();
  cfgRoutes.domainsPathHandler({ body: { path: synced } }, t2, null);
  eq(t2.statusCode, 200, 'the folder Sync recorded is accepted while connected: the way back');
  ok(readFileSync(getCuratorConfigFile(), 'utf8').includes(JSON.stringify(synced).slice(1, -1)), 'and written to the (test) settings file');

  // The picker: its dialog opens in this state, and accepts only the recorded folder.
  let opened = false;
  cfgRoutes.refuseFolderChangeWhileSyncConnected({}, fakeRes(), () => { opened = true; });
  ok(opened, 'folder-changed state: the picker route lets the dialog open');
  const pickDeps = (picked) => ({
    caps: getCapabilities('repo', 'darwin'), platform: 'darwin', hasActiveWrites: () => false,
    execAsync: async () => ({ stdout: picked + '\n' }),
  });
  const p1 = fakeRes();
  await cfgRoutes.pickFolderHandler({}, p1, pickDeps(third));
  ok(p1.statusCode === 400 && p1.body.reason === 'sync-connected', 'the picker refuses another folder', p1.body);
  const p2 = fakeRes();
  await cfgRoutes.pickFolderHandler({}, p2, pickDeps(synced));
  eq(p2.statusCode, 200, 'the picker accepts the folder Sync recorded');

  __setDomainsDirOverride(synced);
  ok(!sync.syncFolderIsElsewhere(), 'back on the recorded folder: no longer elsewhere');
  let opened2 = false;
  const m = fakeRes();
  cfgRoutes.refuseFolderChangeWhileSyncConnected({}, m, () => { opened2 = true; });
  ok(!opened2 && m.statusCode === 400, 'and the picker is refused before its dialog again');
  writeFileSync(path.join(synced, 'physics/wiki/new.md'), 'n\n');
  const back = await attempt(sync.sync);
  ok(!back.err, 'Sync works again', back.err && back.err.message);
  ok(remoteFiles(remote).includes('physics/wiki/new.md') && before.every((f) => remoteFiles(remote).includes(f)), 'and nothing was lost on the remote');

  // No record (the legacy check): no recorded folder to name, so the sentence
  // names none. v4.2.1 audit M2: the way back is open all the same: the route
  // accepts a folder that holds every file Sync backs up, and says so when it
  // refuses one that does not.
  gitRun(['--git-dir', c.gitDir, 'config', '--unset', T.WORK_TREE_KEY]);
  try { gitRun(['--git-dir', c.gitDir, 'config', '--unset-all', 'curator.workTreeReal']); } catch { /* none recorded */ }
  __setDomainsDirOverride(third);
  const lr = await attempt(sync.push);
  eq(codeOf(lr), 'folder-changed', 'no record, a folder with none of the tracked domains: refused');
  const lmsg = sync.describeSyncError(lr.err).error;
  ok(/Disconnect/.test(lmsg) && !/back to it in Settings:/.test(lmsg) && /holds? every file Sync backs up/.test(lmsg),
    'and the sentence names no folder and says which one Settings accepts', lmsg);
  ok(!sync.isRecordedSyncFolder(synced), 'with no record, no folder is "the recorded one"');
  const t2b = fakeRes();
  cfgRoutes.domainsPathHandler({ body: { path: fresh('legacy-empty') } }, t2b, null);
  ok(t2b.statusCode === 400 && /has not yet recorded which knowledge folder/.test(t2b.body && t2b.body.error),
    'the route refuses a folder missing the tracked files, with the no-record sentence', t2b.body);
  const t3 = fakeRes();
  cfgRoutes.domainsPathHandler({ body: { path: synced } }, t3, null);
  eq(t3.statusCode, 200, 'and accepts the folder that holds every tracked file, as the sentence says');
  __setDomainsDirOverride(third);
  // A global setting of the same key is never read as this repo's record.
  const gcfg = path.join(TMP_HOME, '.gitconfig');
  writeFileSync(gcfg, `[curator]\n\tworkTree = ${synced}\n`);
  ok(!sync.isRecordedSyncFolder(synced), 'a GLOBAL curator.workTree is not a record (--local only)');
  const gr = await attempt(sync.push);
  eq(codeOf(gr), 'folder-changed', 'and the brain check still uses the legacy rule');
  rmSync(gcfg, { force: true });
  __setDomainsDirOverride(synced);
  await sync.disconnect();
}

// ═══════════════════════════════════════════════════════════════════════════
section('§10 N4 — the recorded folder is stored and compared exactly');
// ═══════════════════════════════════════════════════════════════════════════
{
  for (const [label, name] of [['a name ending in a space', 'trail '], ['a name ending in two spaces and a tab', 'tabbed  \t'], ['a name starting with a space', ' lead']]) {
    const { remote, url } = bareRemote();
    const dir = path.join(fresh('n4'), name);
    domainsWith(dir, { 'n4/wiki/index.md': '# n4\n' });
    const c = computer(dir);
    use(c);
    const conn = await attempt(() => sync.setup(url, 't', 'push'));
    ok(!conn.err, `${label}: connect`, conn.err && conn.err.message);
    const rec = await T.readRecordedFolder({ gitDir: c.gitDir });
    eq(rec, dir, `${label}: the record is the folder byte for byte`);
    writeFileSync(path.join(dir, 'n4/wiki/a.md'), 'a\n');
    const s1 = await attempt(sync.sync);
    ok(!s1.err, `${label}: Sync works`, s1.err && s1.err.message);
    const s2 = await attempt(sync.sync);
    ok(!s2.err, `${label}: and again`, s2.err && s2.err.message);
    ok(remoteFiles(remote).includes('n4/wiki/a.md'), `${label}: the page reached the remote`);
    // The same folder spelled with a trailing separator, or through a link, is the same folder.
    const { symlinkSync } = await import('fs');
    const link = path.join(fresh('n4link'), 'via');
    symlinkSync(dir, link);
    __setDomainsDirOverride(link);
    ok(!(await attempt(sync.sync)).err, `${label}: through a link to the same folder: still the same folder`);
    // The name WITHOUT its spaces is another folder.
    const trimmed = path.join(path.dirname(dir), name.trim());
    domainsWith(trimmed, { 'n4/wiki/index.md': '# other\n' });
    __setDomainsDirOverride(trimmed);
    eq(codeOf(await attempt(sync.sync)), 'folder-changed', `${label}: the trimmed name is ANOTHER folder: refused`);
    __setDomainsDirOverride(dir);
    await sync.disconnect();
  }
}

// ── isolation ───────────────────────────────────────────────────────────────
sync.__setSyncTestOverrides({});
__setDomainsDirOverride(null);
eq(fingerprint(), FINGERPRINT_BEFORE, '§Z real credential files unchanged (sha256 + size + existence)');
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:\n' + failures.map((f) => '  - ' + f).join('\n')); process.exit(1); }
