#!/usr/bin/env node
/**
 * test-sync-foreign-folders.js — OFFLINE, real git, local bare remotes.
 *
 * Measured on folders The Curator did not create: Sync pushed `.env` and any
 * other folder to the user's repository; skipped `*.base`, `Untitled.md` and
 * `raw/` without a word; and on a vault with its own `.git` reported success
 * while the remote held an empty gitlink, after which every Sync failed with a
 * raw git command line. Every assertion reads the REMOTE with git, never a
 * return value, for what was or was not sent.
 *
 * ISOLATION. Temp dirs only. CURATOR_TEST_USER_DATA_DIR and the sync test seams
 * are set before the modules run. All credentials here are synthetic and built
 * from parts, and no value is ever asserted to appear in a report.
 *
 * Run: node scripts/test-sync-foreign-folders.js
 */
import { execSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync, readdirSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import path from 'path';
import http from 'http';
import express from 'express';

const ROOT_TMP = mkdtempSync(path.join(tmpdir(), 'curator-foreign-sync-'));
process.env.CURATOR_TEST_USER_DATA_DIR = path.join(ROOT_TMP, 'user-data');
mkdirSync(process.env.CURATOR_TEST_USER_DATA_DIR);

const sync = await import('../src/brain/sync.js');
const { __setDomainsDirOverride } = await import('../src/brain/config.js');
const safety = await import('../src/brain/sync-safety.js');
const view = await import('../src/public/next/views/sync-backup.js');

const { __setSyncTestOverrides, setup, push, pull, preflightSetup, friendlyError, syncRefusalOf } = sync;
const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }).toString();

let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; failures.push(msg); console.log(`  ✗ ${msg}`); }
}
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)})`);
const section = (t) => console.log(`\n${t}\n`);

let n = 0;
function write(base, rel, text = 'x\n') {
  const p = path.join(base, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, text);
}
const SECRET_LOOKING = ['SYNTH', 'VALUE', 'not', 'real'].join('_');

/** One computer: a folder, a sync git dir, a config file, pointed at a remote. */
function computer(remote, name = 'a') {
  const dir = path.join(ROOT_TMP, `${name}-${++n}`);
  mkdirSync(dir);
  const c = {
    domains: path.join(dir, 'folder'),
    gitDir: path.join(dir, 'gitdir'),
    configFile: path.join(dir, 'config.json'),
    remote,
    url: `file://${remote}`,
    use() {
      __setDomainsDirOverride(c.domains);
      __setSyncTestOverrides({ gitDir: c.gitDir, configFile: c.configFile });
      return c;
    },
  };
  mkdirSync(c.domains);
  return c.use();
}
function newRemote() {
  const r = path.join(ROOT_TMP, `remote-${++n}.git`);
  sh(`git init -q --bare -b main "${r}"`);
  return r;
}
const remoteTree = (remote) => {
  const out = sh(`git --git-dir="${remote}" ls-tree -r -z main`);
  return out.split('\0').filter(Boolean).map((l) => {
    const [meta, p] = [l.slice(0, l.indexOf('\t')), l.slice(l.indexOf('\t') + 1)];
    return { mode: meta.split(' ')[0], path: p };
  });
};
const remotePaths = (remote) => remoteTree(remote).map((e) => e.path);
const remoteEverEver = (remote) =>
  sh(`git --git-dir="${remote}" log --all --format= --name-only`).split('\n').filter(Boolean);
const remoteBlob = (remote, p) => sh(`git --git-dir="${remote}" show "main:${p}"`);
const remoteHead = (remote) => sh(`git --git-dir="${remote}" rev-parse main`).trim();
const isAncestor = (remote, a, b) => {
  try { sh(`git --git-dir="${remote}" merge-base --is-ancestor ${a} ${b}`); return true; } catch { return false; }
};

/** A folder with its own committed repository. */
function nestedRepo(base, rel, { commit = true } = {}) {
  const d = path.join(base, rel);
  write(d, 'CLAUDE.md', 'schema\n');
  write(d, 'wiki/entities/a.md', 'a\n');
  sh('git init -q -b main', d);
  if (commit) sh('git add -A && git -c user.email=t@t.t -c user.name=T commit -qm own', d);
  return d;
}
/** Sha256 of every file under a directory, `.git` included. */
function fingerprint(dir) {
  const h = createHash('sha256');
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { h.update(p); h.update(readFileSync(p)); }
    }
  };
  walk(dir);
  return h.digest('hex');
}

/** The state v3.96.1 left behind: a commit on the remote holding a gitlink. */
function makeBadState(c) {
  nestedRepo(c.domains, 'vault');
  write(c.domains, 'real/CLAUDE.md');
  write(c.domains, 'real/wiki/entities/r.md');
  const G = `git --git-dir="${c.gitDir}" --work-tree="${c.domains}"`;
  mkdirSync(c.gitDir, { recursive: true });
  sh(`${G} init -q -b main && ${G} config user.email t@t.t && ${G} config user.name T`, ROOT_TMP);
  sh(`${G} remote add origin "${c.url}"`, ROOT_TMP);
  sh(`${G} add -A && ${G} commit -qm bad && ${G} push -q -u origin main`, ROOT_TMP);
  writeFileSync(c.configFile, JSON.stringify({ repoUrl: c.url, token: 't' }));
}

try {
  section('0. Name rules: the table agrees with real git, and a page is never a secret');
  {
    const yes = ['.env', 'd/.env', '.env.local', '.env.production', '.env-prod', '.envrc', 'd/wiki/server.pem', 'k.key', 'a.p12', 'a.pfx',
      'id_rsa', 'd/id_ed25519', '.netrc', '.npmrc', '.pgpass', '.git-credentials', '.sync-config.json', '.curator-config.json',
      '.sharedbrain-config.json', 'credentials', 'credentials.json', 'secrets.yaml', 'service-account-prod.json', 'client_secret_1.json',
      'token.json', '.aws/credentials', 'd/.aws/credentials', '.docker/config.json', '.ssh/config', 'd/.ssh/whatever', '.knowledge-git/config'];
    const no = ['d/wiki/concepts/credentials.md', 'd/wiki/concepts/service-account-token.md', 'd/wiki/entities/api-key.md', 'd/wiki/concepts/secrets.md',
      'd/wiki/concepts/env.md', 'env', '.environment', 'd/.obsidian/app.json', 'd/.obsidian/graph.json', 'id_rsa.pub', 'd/wiki/log.md', 'keys.txt', 'config.json', 'd/CLAUDE.md'];
    for (const p of yes) ok(safety.isCredentialPath(p), `secret by name: ${p}`);
    for (const p of no) ok(!safety.isCredentialPath(p), `not a secret: ${p}`);

    // Cross-check: real `git check-ignore` over the generated gitignore lines.
    const d = path.join(ROOT_TMP, 'xcheck');
    mkdirSync(d);
    sh('git init -q', d);
    writeFileSync(path.join(d, '.gitignore'), safety.CREDENTIAL_GITIGNORE_RULES.join('\n') + '\n');
    const ignoredByGit = (p) => { try { sh(`git check-ignore -q --no-index -- "${p}"`, d); return true; } catch { return false; } };
    for (const p of yes) ok(ignoredByGit(p), `real git ignores ${p}`);
    for (const p of no) ok(!ignoredByGit(p), `real git keeps ${p}`);

    ok(safety.pluginSettingsHoldSecret(JSON.stringify({ apiKey: 'x'.repeat(20) })), 'plugin settings with a long apiKey');
    ok(safety.pluginSettingsHoldSecret(JSON.stringify({ a: { deep: { access_token: 'x'.repeat(20) } } })), 'plugin settings with a nested token');
    ok(!safety.pluginSettingsHoldSecret(JSON.stringify({ apiKey: '', maxTokens: 4000, tokenLimit: 'x'.repeat(20), theme: 'x'.repeat(40) })), 'ordinary plugin settings are not a secret');
    ok(!safety.pluginSettingsHoldSecret('not json'), 'unparsable settings are not reported as a secret');
  }

  section('1. A first push: secrets stay here, pages go up, and the user is told');
  {
    const remote = newRemote();
    const c = computer(remote);
    write(c.domains, '.env', `${SECRET_LOOKING}\n`);
    write(c.domains, '.env.local');
    write(c.domains, 'alpha/.env');
    write(c.domains, 'alpha/server.pem');
    write(c.domains, 'alpha/CLAUDE.md');
    write(c.domains, 'alpha/wiki/concepts/credentials.md');
    write(c.domains, 'alpha/wiki/concepts/service-account-token.md');
    write(c.domains, 'other/.aws/credentials');
    write(c.domains, 'other/note.md');
    const r = await setup(c.url, 't', 'push');
    const tree = remotePaths(remote);
    for (const p of ['.env', '.env.local', 'alpha/.env', 'alpha/server.pem', 'other/.aws/credentials']) ok(!tree.includes(p), `${p} is not on the remote`);
    for (const p of ['alpha/CLAUDE.md', 'alpha/wiki/concepts/credentials.md', 'alpha/wiki/concepts/service-account-token.md']) ok(tree.includes(p), `${p} is on the remote`);
    ok(existsSync(path.join(c.domains, '.env')), 'the file is still on this computer');
    eq(r.backup.credentialsLeftOut.count, 5, 'the report counts what was left out');
    ok(r.backup.credentialsLeftOut.files.includes('alpha/server.pem'), 'and names it');
    ok(!JSON.stringify(r.backup).includes(SECRET_LOOKING), 'no value reaches the report');
    ok(!r.partial, 'a left-out secret alone is not a partial backup');
  }

  section('1b. The second layer: a `!.env` in a nested .gitignore cannot bring it back');
  {
    const remote = newRemote();
    const c = computer(remote);
    write(c.domains, 'alpha/CLAUDE.md');
    write(c.domains, 'alpha/.gitignore', '!.env\n!*.pem\n');
    write(c.domains, 'alpha/.env');
    write(c.domains, 'alpha/a.pem');
    const r = await setup(c.url, 't', 'push');
    const tree = remotePaths(remote);
    ok(!tree.includes('alpha/.env') && !tree.includes('alpha/a.pem'), 'negated rules do not get a secret onto the remote on the first (unborn) commit');
    write(c.domains, 'alpha/b.pem');
    await push();
    ok(!remotePaths(remote).includes('alpha/b.pem'), 'nor on a later push');
    ok(r.heldBack.includes('alpha/.env'), 'the result says it was held back');
  }

  section('1c. Every commit path: merge connect, push, pull auto-save, sync');
  {
    const remote = newRemote();
    const seed = computer(remote, 'seed');
    write(seed.domains, 'alpha/CLAUDE.md');
    await setup(seed.url, 't', 'push');

    const m = computer(remote, 'merge');
    write(m.domains, 'beta/CLAUDE.md');
    write(m.domains, 'beta/.env');
    await setup(m.url, 't', 'merge');
    await push();
    let tree = remotePaths(remote);
    ok(tree.includes('beta/CLAUDE.md') && !tree.includes('beta/.env'), 'merge connect leaves the secret out');

    write(m.domains, '.env.after');
    write(m.domains, 'beta/wiki/p.md');
    await pull();
    await push();
    tree = remotePaths(remote);
    ok(tree.includes('beta/wiki/p.md') && !tree.includes('.env.after'), 'pull auto-save then push leaves it out');

    write(m.domains, 'beta/after.key');
    await sync.sync();
    ok(!remotePaths(remote).includes('beta/after.key'), 'sync() leaves it out');
    ok(!remoteEverEver(remote).some((p) => /\.env|\.key$/.test(p)), 'and no commit in history ever held one');
  }

  section('1d. Obsidian plugin settings holding a key');
  {
    const remote = newRemote();
    const c = computer(remote);
    write(c.domains, '.obsidian/app.json', '{}');
    write(c.domains, '.obsidian/plugins/copilot/data.json', JSON.stringify({ openAIApiKey: 'y'.repeat(40) }));
    write(c.domains, '.obsidian/plugins/calm/data.json', JSON.stringify({ theme: 'dark' }));
    write(c.domains, 'alpha/CLAUDE.md');
    const r = await setup(c.url, 't', 'push');
    const tree = remotePaths(remote);
    ok(!tree.includes('.obsidian/plugins/copilot/data.json'), 'settings holding a key stay here');
    ok(tree.includes('.obsidian/plugins/calm/data.json') && tree.includes('.obsidian/app.json'), 'the rest of .obsidian still syncs');
    ok(r.backup.credentialsLeftOut.files.includes('.obsidian/plugins/copilot/data.json'), 'and it is named');
  }

  section('2. Already on the remote: warned, not pushed again, history untouched');
  {
    const remote = newRemote();
    const c = computer(remote);
    write(c.domains, 'alpha/CLAUDE.md');
    write(c.domains, '.env', 'OLD\n');
    const G = `git --git-dir="${c.gitDir}" --work-tree="${c.domains}"`;
    mkdirSync(c.gitDir);
    sh(`${G} init -q -b main && ${G} config user.email t@t.t && ${G} config user.name T && ${G} remote add origin "${c.url}"`, ROOT_TMP);
    sh(`${G} add -A && ${G} commit -qm old-version && ${G} push -q -u origin main`, ROOT_TMP);
    writeFileSync(c.configFile, JSON.stringify({ repoUrl: c.url, token: 't' }));
    const before = remoteHead(remote);

    let rep = await sync.getBackupReport();
    eq(rep.credentialsInRepo.files, ['.env'], 'the report names the tracked secret');
    const warn = view.backupReportHtml(rep);
    ok(/new one/.test(warn) && /never rewrites history/.test(warn), 'the page says what to do');

    write(c.domains, '.env', 'ROTATED\n');
    write(c.domains, 'alpha/wiki/p.md');
    const r = await push();
    eq(remoteBlob(remote, '.env'), 'OLD\n', 'a rotated key is not pushed over the old one');
    ok(remotePaths(remote).includes('alpha/wiki/p.md'), 'the rest of the push went');
    eq(readFileSync(path.join(c.domains, '.env'), 'utf8'), 'ROTATED\n', 'the file here is untouched');
    ok(isAncestor(remote, before, remoteHead(remote)), 'history was not rewritten');
    ok(r.heldBack.includes('.env'), 'the result says it was held back');

    let threw = null;
    try { await push(); await pull(); await sync.sync(); } catch (e) { threw = e; }
    ok(!threw, `a held-back change never fails a later sync${threw ? `: ${threw.message.slice(0, 200)}` : ''}`);

    // The written remedy, followed literally.
    const away = path.join(ROOT_TMP, `moved-${n}`);
    renameSync(path.join(c.domains, '.env'), away);
    await push();
    ok(!remotePaths(remote).includes('.env'), 'moving it out and syncing removes it from the latest version');
    renameSync(away, path.join(c.domains, '.env'));
    await push();
    ok(!remotePaths(remote).includes('.env'), 'moving it back keeps it local');
    rep = await sync.getBackupReport();
    eq(rep.credentialsInRepo.count, 0, 'the warning is gone');
    ok(rep.credentialsLeftOut.files.includes('.env'), 'and it is listed as left out');
    ok(isAncestor(remote, before, remoteHead(remote)), 'still no rewrite');
  }

  section('3. Non-domain folders stay backed up, are named, and can be left out at connect');
  {
    const remote = newRemote();
    const c = computer(remote);
    write(c.domains, 'alpha/CLAUDE.md');
    write(c.domains, 'Private Journal/diary.md');
    write(c.domains, 'Attachments/p.png');
    write(c.domains, 'Loose note.md');
    write(c.domains, '.obsidian/app.json', '{}');
    const beforeNames = fingerprint(c.domains);
    const pre = await preflightSetup(c.url, 't');
    eq(fingerprint(c.domains), beforeNames, 'the preview writes nothing to the folder');
    ok(!existsSync(c.gitDir), 'nor a git dir');
    const names = pre.backup.nonDomain.map((d) => d.name);
    ok(names.includes('Private Journal') && names.includes('Attachments') && names.includes(null), 'the preview names folders and loose files');
    ok(!names.includes('alpha') && !names.includes('.obsidian'), 'a domain and .obsidian are not listed');
    ok(view.connectNeedsReview(pre.backup), 'the connect stops to show it');
    ok(view.connectReviewHtml(pre.backup, {}).includes('Private Journal'), 'and the panel says it');

    const r = await setup(c.url, 't', 'push', { leaveOut: ['Private Journal'] });
    const tree = remotePaths(remote);
    ok(!tree.includes('Private Journal/diary.md'), 'a folder left out at connect is not sent');
    ok(tree.includes('Attachments/p.png'), 'one kept is sent: images in the vault root are backed up');
    ok(existsSync(path.join(c.domains, 'Private Journal/diary.md')), 'and the folder is untouched');
    ok(r.backup.ownRules.files.includes('Private Journal/diary.md'), 'and the report still shows it as not backed up');

    const c2 = computer(newRemote());
    write(c2.domains, 'alpha/CLAUDE.md');
    write(c2.domains, 'Private Journal/diary.md');
    const r2 = await setup(c2.url, 't', 'push');
    ok(remotePaths(c2.remote).includes('Private Journal/diary.md'), 'without that choice it is backed up, as before');
    eq(r2.backup.nonDomain.map((d) => d.name), ['Private Journal'], 'and the report names it');
    ok(view.backupReportHtml(r2.backup).includes('Private Journal'), 'on the page too');

    for (const bad of [['alpha'], ['../outside'], ['a/b'], ['.'], ['..'], ['does-not-exist'], [7]]) {
      const c3 = computer(newRemote());
      write(c3.domains, 'alpha/CLAUDE.md');
      let code = null;
      try { await setup(c3.url, 't', 'push', { leaveOut: bad }); } catch (e) { code = (syncRefusalOf(e) || {}).code; }
      eq(code, 'invalid-leave-out', `leaveOut ${JSON.stringify(bad)} is refused by the server`);
    }
  }

  section('4. What Sync skips is visible');
  {
    const remote = newRemote();
    const c = computer(remote);
    write(c.domains, 'alpha/CLAUDE.md');
    write(c.domains, 'alpha/raw/source.pdf');
    write(c.domains, 'alpha/My View.base');
    write(c.domains, 'Untitled.md');
    write(c.domains, '.DS_Store');
    write(c.domains, 'alpha/.write-lock');
    write(c.domains, '.gitignore', 'drafts/\n');
    write(c.domains, 'drafts/d.md');
    const r = await setup(c.url, 't', 'push');
    const tree = remotePaths(remote);
    ok(!tree.includes('alpha/raw/source.pdf') && !tree.includes('Untitled.md'), 'precondition: they are skipped');
    eq(r.backup.rawSources.files, ['alpha/raw/source.pdf'], 'raw/ is listed');
    eq(r.backup.obsidianFiles.files.sort(), ['Untitled.md', 'alpha/My View.base'], 'Bases and Untitled are listed');
    eq(r.backup.ownRules.files, ['drafts/d.md'], 'the user’s own rule is listed');
    eq(r.backup.housekeepingCount, 2, 'housekeeping is counted');
    const html = view.backupReportHtml(r.backup);
    ok(html.includes('alpha/raw/source.pdf') && html.includes('My View.base') && html.includes('drafts/d.md'), 'the page names them');
    ok(!/<details|chevron/.test(html), 'nothing sits behind a chevron');
    const hostile = view.backupReportHtml({ ...r.backup, rawSources: { count: 1, files: ['a/raw/<img src=x>'] } });
    ok(!hostile.includes('<img') && hostile.includes('&lt;img'), 'a file name is escaped');
    eq(await sync.getBackupReport().then((b) => b.rawSources.count), 1, 'the route function agrees');
  }

  section('5. A vault with its own .git: not reported as backed up, and Sync keeps working');
  {
    const remote = newRemote();
    const c = computer(remote);
    const vault = nestedRepo(c.domains, 'vault');
    write(c.domains, 'real/CLAUDE.md');
    write(c.domains, 'real/wiki/entities/r.md');
    const before = fingerprint(vault);
    const r = await setup(c.url, 't', 'push');
    ok(!remoteTree(remote).some((e) => e.mode === '160000'), 'the remote holds no gitlink');
    ok(!remotePaths(remote).includes('vault'), 'and no entry for that folder');
    ok(remotePaths(remote).includes('real/wiki/entities/r.md'), 'everything else went');
    ok(r.partial === true, 'the result is partial');
    ok(/vault/.test(r.warning) && /own git history/.test(r.warning) && /nothing in it is on GitHub/.test(r.warning), 'and says so in plain words');
    eq(fingerprint(vault), before, 'the vault and its .git are untouched');

    write(vault, 'wiki/entities/new.md');
    write(c.domains, 'real/wiki/entities/r2.md');
    let threw = null;
    let p1; let s1;
    try { p1 = await push(); s1 = await sync.sync(); await pull(); } catch (e) { threw = e; }
    ok(!threw, `later Syncs do not fail${threw ? `: ${threw.message.slice(0, 200)}` : ''}`);
    ok(p1 && p1.pushed && /not backed up/.test(p1.warning), 'a later push says it again');
    ok(s1 && s1.pushResult.partial, 'and so does sync');
    ok(/not backed up/.test(view.backupReportHtml(await sync.getBackupReport())), 'and the page');
    ok(remotePaths(remote).includes('real/wiki/entities/r2.md'), 'the rest keeps syncing');
    const st = await sync.getStatus();
    eq(st.changesCount, 0, 'the vault does not sit on the pending count');

    // Told to delete its .git: the folder then really is backed up.
    rmSync(path.join(vault, '.git'), { recursive: true });
    const p2 = await push();
    ok(remotePaths(remote).includes('vault/wiki/entities/a.md'), 'after its .git is gone the folder is backed up');
    ok(!p2.partial, 'and the warning clears');
  }

  section('5b. The shapes of a nested repository');
  {
    // No commits: `git add` fails outright on this one, so the walk is load-bearing.
    const c1 = computer(newRemote());
    nestedRepo(c1.domains, 'fresh', { commit: false });
    write(c1.domains, 'real/CLAUDE.md');
    const r1 = await setup(c1.url, 't', 'push');
    ok(remotePaths(c1.remote).includes('real/CLAUDE.md') && r1.backup.nestedRepos.includes('fresh'), 'a repository with no commits does not stop the backup');

    // A gitfile, as a worktree or submodule has.
    const c2 = computer(newRemote());
    write(c2.domains, 'wt/.git', 'gitdir: /nonexistent/place\n');
    write(c2.domains, 'wt/a.md');
    write(c2.domains, 'real/CLAUDE.md');
    const r2 = await setup(c2.url, 't', 'push');
    ok(r2.backup.nestedRepos.includes('wt') && !remotePaths(c2.remote).includes('wt/a.md'), 'a `.git` file counts');

    // An empty `.git` folder is not a repository to git, and its files DO go.
    const c3 = computer(newRemote());
    mkdirSync(path.join(c3.domains, 'plain/.git'), { recursive: true });
    write(c3.domains, 'plain/a.md');
    const r3 = await setup(c3.url, 't', 'push');
    ok(remotePaths(c3.remote).includes('plain/a.md'), 'files beside an empty .git folder are backed up');
    eq(r3.backup.nestedRepos, [], 'and it is not reported as a gap');

    // Inside raw/: ignored anyway, and not news.
    const c4 = computer(newRemote());
    write(c4.domains, 'real/CLAUDE.md');
    nestedRepo(c4.domains, 'real/raw/clone');
    const r4 = await setup(c4.url, 't', 'push');
    eq(r4.backup.nestedRepos, [], 'a repository the rules already ignore is not reported');

    // Deep, with hostile characters in the name.
    const c5 = computer(newRemote());
    nestedRepo(c5.domains, 'deep/er/My [va*lt] $(x) "q"');
    write(c5.domains, 'deep/keep.md');
    const r5 = await setup(c5.url, 't', 'push');
    ok(r5.backup.nestedRepos.includes('deep/er/My [va*lt] $(x) "q"'), 'a deep repository with shell and glob characters is found');
    ok(remotePaths(c5.remote).includes('deep/keep.md') && !remoteTree(c5.remote).some((e) => e.mode === '160000'), 'and left out exactly');
    write(c5.domains, 'deep/er/sibling.md');
    await push();
    ok(remotePaths(c5.remote).includes('deep/er/sibling.md'), 'its sibling still goes');

    // Merge connect.
    const remote6 = newRemote();
    const seed = computer(remote6, 'seed');
    write(seed.domains, 'alpha/CLAUDE.md');
    await setup(seed.url, 't', 'push');
    const c6 = computer(remote6, 'b');
    nestedRepo(c6.domains, 'vault');
    write(c6.domains, 'real/CLAUDE.md');
    const r6 = await setup(c6.url, 't', 'merge');
    await push();
    ok(r6.partial && !remoteTree(remote6).some((e) => e.mode === '160000'), 'merge connect too');
  }

  section('5c. Nothing but a nested repository: refused, not "connected"');
  {
    for (const mode of ['push', 'merge']) {
      const remote = newRemote();
      if (mode === 'merge') {
        const seed = computer(remote, 'seed');
        write(seed.domains, 'alpha/CLAUDE.md');
        await setup(seed.url, 't', 'push');
      }
      const c = computer(remote);
      const vault = nestedRepo(c.domains, 'vault');
      const before = fingerprint(vault);
      let refused = null;
      try { await setup(c.url, 't', mode); } catch (e) { refused = syncRefusalOf(e); }
      eq(refused && refused.code, 'only-nested-repos', `${mode}: refused with a code the panel renders`);
      ok(refused && /vault/.test(refused.message) && /knowledge folder/.test(refused.message), 'it names the folder and the way out');
      ok(!existsSync(c.gitDir) && !existsSync(c.configFile), 'nothing half-configured is left');
      ok(!sync.isConfigured(), 'the app does not claim sync is set up');
      eq(fingerprint(vault), before, 'the vault is untouched');
    }
    // Control: that vault chosen AS the folder works, which is what the words promise.
    const c = computer(newRemote());
    nestedRepo(c.domains, 'vault');
    const v = computer(c.remote, 'v');
    rmSync(v.domains, { recursive: true });
    v.domains = path.join(c.domains, 'vault');
    v.use();
    const r = await setup(v.url, 't', 'push');
    ok(remotePaths(c.remote).includes('wiki/entities/a.md') && !r.partial, 'choosing the vault itself as the folder backs it up');
  }

  section('6. A repository already in the bad state is repaired');
  {
    const remote = newRemote();
    const c = computer(remote);
    makeBadState(c);
    ok(remoteTree(remote).some((e) => e.mode === '160000'), 'precondition: the remote holds a gitlink');
    const badHead = remoteHead(remote);
    const vault = path.join(c.domains, 'vault');
    const before = fingerprint(vault);

    let rep = await sync.getBackupReport();
    eq(rep.brokenLinks, ['vault'], 'the page can name it before the repair');
    ok(/empty link/.test(view.backupWarningsHtml(rep)), 'in words');
    eq(fingerprint(vault), before, 'reading the report changes nothing');

    // A CLEAN status: the repair must not depend on the folder being dirty.
    const r = await push();
    ok(!remoteTree(remote).some((e) => e.mode === '160000'), 'a clean push removes the gitlink from the remote');
    eq(r.repairedLinks, ['vault'], 'and reports it');
    ok(isAncestor(remote, badHead, remoteHead(remote)), 'history was not rewritten');
    eq(fingerprint(vault), before, 'the vault is untouched');

    write(c.domains, 'real/wiki/entities/after.md');
    const r2 = await push();
    ok(remotePaths(remote).includes('real/wiki/entities/after.md') && r2.partial, 'and Sync works again');

    // The reported failure: a dirty gitlink, through sync(), whose first step is pull().
    const remote2 = newRemote();
    const d = computer(remote2);
    makeBadState(d);
    write(path.join(d.domains, 'vault'), 'wiki/entities/dirty.md');
    write(path.join(d.domains, 'vault'), 'CLAUDE.md', 'modified\n');
    let threw = null;
    try { await sync.sync(); } catch (e) { threw = e; }
    ok(!threw, `a dirty gitlink no longer fails Sync${threw ? `: ${threw.message.slice(0, 200)}` : ''}`);
    ok(!remoteTree(remote2).some((e) => e.mode === '160000'), 'and it is repaired on the remote');
  }

  section('6b. Two computers: the repair must not destroy the other one’s repository');
  {
    const remote = newRemote();
    const a = computer(remote, 'a');
    makeBadState(a);

    // B connected before the repair, with its own real repository at that path.
    const b = computer(remote, 'b');
    write(b.domains, 'b-only/CLAUDE.md');
    await setup(b.url, 't', 'merge');
    await push();
    rmSync(path.join(b.domains, 'vault'), { recursive: true, force: true });
    const bVault = nestedRepo(b.domains, 'vault');
    const bBefore = fingerprint(bVault);

    a.use();
    await sync.sync();
    ok(!remoteTree(remote).some((e) => e.mode === '160000'), 'A repaired the remote');

    b.use();
    let threw = null;
    let res;
    try { res = await pull(); } catch (e) { threw = e; }
    ok(!threw, `B pulls the repair${threw ? `: ${threw.message.slice(0, 200)}` : ''}`);
    ok(existsSync(path.join(bVault, '.git/HEAD')), 'B’s nested repository survives');
    eq(fingerprint(bVault), bBefore, 'byte for byte');
    ok(res && !(res.pruned || []).includes('vault'), 'it is not reported as pruned');

    // A secret alone in a folder another computer deleted stays too.
    const remote2 = newRemote();
    const p = computer(remote2, 'p');
    write(p.domains, 'gone/note.md');
    write(p.domains, 'keep/CLAUDE.md');
    await setup(p.url, 't', 'push');
    const q = computer(remote2, 'q');
    await setup(q.url, 't', 'pull', { confirmOverwrite: true });
    write(q.domains, 'gone/.env', 'LOCAL ONLY\n');
    p.use();
    rmSync(path.join(p.domains, 'gone'), { recursive: true });
    await push();
    q.use();
    const qr = await pull();
    ok(existsSync(path.join(q.domains, 'gone/.env')), 'a local-only secret is not removed with a deleted folder');
    ok((qr.prunedKept || []).includes('gone'), 'and the folder is reported as kept');
    // Control: a raw/-only shell still goes (the v2.3.4 contract).
    const c1 = computer(newRemote(), 'c1');
    write(c1.domains, 'dead/note.md');
    write(c1.domains, 'keep/CLAUDE.md');
    await setup(c1.url, 't', 'push');
    const c2 = computer(c1.remote, 'c2');
    await setup(c2.url, 't', 'pull', { confirmOverwrite: true });
    write(c2.domains, 'dead/raw/s.pdf');
    c1.use();
    rmSync(path.join(c1.domains, 'dead'), { recursive: true });
    await push();
    c2.use();
    const cr = await pull();
    ok((cr.pruned || []).includes('dead') && !existsSync(path.join(c2.domains, 'dead')), 'control: an ordinary deleted domain is still pruned');
  }

  section('7. The guard that must stay: a clean index never throws, in all three wordings');
  {
    for (const words of ['nothing to commit, working tree clean', 'nothing added to commit but untracked files present', 'no changes added to commit (use "git add")']) {
      ok(sync.__testing.isCleanIndexError(new Error(words)), `clean index: ${words.slice(0, 26)}`);
    }
    ok(!sync.__testing.isCleanIndexError(new Error('fatal: unable to write new index file')), 'a real commit failure is not swallowed');
    ok(/own git history/.test(friendlyError(new Error("error: 'x/' does not have a commit checked out"))), 'a nested repo error is in plain words');
    ok(/own git history/.test(friendlyError(new Error('modified:   vault (modified content, untracked content) 401'))), 'and beats the auth branch');
    ok(/held back/.test(friendlyError(new Error('error: Your local changes to the following files would be overwritten by merge: .env'))), 'a held-back collision is in plain words');
  }

  section('8. Through the routes');
  {
    const syncRouter = (await import('../src/routes/sync.js')).default;
    const app = express();
    app.use(express.json());
    app.use('/api/sync', syncRouter);
    const server = http.createServer(app);
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    const base = `http://127.0.0.1:${server.address().port}/api/sync`;
    const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    try {
      const remote = newRemote();
      const c = computer(remote);
      nestedRepo(c.domains, 'vault');
      write(c.domains, 'real/CLAUDE.md');
      write(c.domains, '.env');

      let res = await post('/preflight', { repoUrl: c.url, token: 't' });
      let body = await res.json();
      ok(body.ok && body.backup.nestedRepos.includes('vault') && body.backup.credentialsLeftOut.files.includes('.env'), 'POST /preflight reports both before anything is sent');

      res = await post('/setup', { repoUrl: c.url, token: 't', mode: 'push' });
      body = await res.json();
      eq(res.status, 200, 'POST /setup connects');
      eq(body.success, false, 'but does not report success for a folder it did not back up');
      ok(body.partial && /vault/.test(body.warning), 'and says which');
      ok(body.configured === true, 'the connection itself is up');

      res = await fetch(`${base}/backup-report`);
      body = await res.json();
      ok(res.status === 200 && body.nestedRepos.includes('vault'), 'GET /backup-report answers');
      const before = fingerprint(c.gitDir);
      await fetch(`${base}/backup-report`);
      eq(fingerprint(c.gitDir), before, 'and writes nothing');

      res = await post('/sync', {});
      body = await res.json();
      eq(res.status, 200, 'POST /sync is no longer a 500');
      ok(body.pushResult.partial, 'and carries the gap');

      const c2 = computer(newRemote());
      nestedRepo(c2.domains, 'vault');
      res = await post('/setup', { repoUrl: c2.url, token: 't', mode: 'push' });
      body = await res.json();
      eq(res.status, 409, 'nothing but a nested repository is a 409');
      eq(body.code, 'only-nested-repos', 'with its code');

      const c3 = computer(newRemote());
      write(c3.domains, 'real/CLAUDE.md');
      res = await post('/setup', { repoUrl: c3.url, token: 't', mode: 'push' });
      body = await res.json();
      eq(body.success, true, 'an ordinary connect is still a plain success');
    } finally {
      await new Promise((res) => server.close(res));
    }
  }

  section('9. Result sentences (the view)');
  {
    const src = readFileSync(new URL('../src/public/next/views/sync.js', import.meta.url), 'utf8');
    const start = src.indexOf('function fileCount(n)');
    const end = src.indexOf('async function onDisconnect');
    const fn = new Function(`${src.slice(start, end)}; return describeResult;`)();
    const warning = 'A folder was not backed up: vault has its own git history, so nothing in it is on GitHub.';
    ok(!/^Sync complete/.test(fn('sync', { pullResult: {}, pushResult: { pushed: true, filesChanged: 2, warning } })), 'a partial sync never opens "Sync complete"');
    ok(fn('sync', { pullResult: {}, pushResult: { pushed: false, warning } }).includes('vault'), 'nor with nothing new');
    ok(fn('push', { pushed: true, filesChanged: 2, warning }).includes('vault'), 'push names it');
    eq(fn('sync', { pullResult: {}, pushResult: { pushed: false } }), 'Sync complete — everything was already up to date.', 'no gap, the sentence is unchanged');
  }
} finally {
  __setSyncTestOverrides({});
  __setDomainsDirOverride(null);
  rmSync(ROOT_TMP, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed ? 1 : 0);
