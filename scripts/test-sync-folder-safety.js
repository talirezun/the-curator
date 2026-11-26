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

// ── isolation ───────────────────────────────────────────────────────────────
sync.__setSyncTestOverrides({});
__setDomainsDirOverride(null);
eq(fingerprint(), FINGERPRINT_BEFORE, '§Z real credential files unchanged (sha256 + size + existence)');
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:\n' + failures.map((f) => '  - ' + f).join('\n')); process.exit(1); }
