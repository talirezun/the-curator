#!/usr/bin/env node
/**
 * test-sync-connect-safety.js — OFFLINE battle test for the v3.32.0
 * connect-time data-loss fix.
 *
 * WHAT HAPPENED. A user installed the Mac app, pointed it at the domains
 * folder his existing browser install was already syncing, and connected
 * GitHub sync. Four working-state handoffs written that morning were
 * destroyed, and `journal.jsonl` — an APPEND-ONLY file — came back one line
 * long. Two defects combined:
 *
 *   (1) TWO GIT REPOSITORIES OVER ONE WORK TREE. `getSyncGitDir()` resolves
 *       through `getUserDataDir()`, which forks on install mode. The WORK
 *       TREE does not fork — it is `getDomainsDir()`. So a second install
 *       pointed at an existing domains folder silently created a second,
 *       independent sync history over the same files.
 *
 *   (2) A REFUSAL THAT LEFT ONLY THE DESTRUCTIVE DOOR OPEN. Connecting in
 *       "Push my wiki" mode was CORRECTLY refused — the remote had commits
 *       this new repo did not. The only other control on the screen was
 *       "Pull an existing wiki", and setup()'s pull arm ended in an
 *       unconditional `git reset --hard origin/main`.
 *
 * Section 1 reproduces (2) against real git and is kept as a permanent
 * CONTROL: it proves `reset --hard` really is the one tree-writing command
 * with no untracked-file check, so every later assertion is measuring a real
 * hazard rather than a hypothetical one.
 *
 * `setup()` had ZERO test coverage before this file, and the reason is
 * visible in scripts/test-sync-hygiene.js: every fixture there hand-builds a
 * repo with `git remote add`, because setup() could not be pointed at a local
 * bare repo. The function that destroyed a user's working state was
 * untestable offline. buildRemoteUrl()'s `file://` passthrough is what made
 * this suite possible.
 *
 * ISOLATION. Every repo, remote and domains directory lives under
 * os.tmpdir(). sync.js's git dir / config file and config.js's domains dir
 * are redirected via __setSyncTestOverrides() / __setDomainsDirOverride(),
 * reset in a top-level finally. The real .sync-config.json, the real
 * .knowledge-git and the real domains/ are fingerprinted at both ends and
 * asserted unchanged.
 *
 * Pure offline: no network, no API key, no GitHub. Every "remote" is a local
 * `git init --bare`.
 *
 * Run: node scripts/test-sync-connect-safety.js
 */

import { execSync } from 'child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

import {
  __setSyncTestOverrides,
  setup,
  preflightSetup,
  syncRefusalOf,
  getStatus,
  push,
  disconnect,
  friendlyError,
  SETUP_MODES,
  __testing as T,
} from '../src/brain/sync.js';
import { __setDomainsDirOverride } from '../src/brain/config.js';
import { getSyncConfigFile, getSyncGitDir, getDefaultDomainsDir } from '../src/brain/paths.js';

let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; failures.push(msg); console.log(`  ✗ ${msg}`); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, `${msg} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}

const TMPS = [];
async function tmp(prefix) {
  const d = await mkdtemp(path.join(tmpdir(), `curator-${prefix}-`));
  TMPS.push(d);
  return d;
}
const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'pipe' }).toString();
const inRepo = (gitDir, workTree, cmd) =>
  sh(`git --git-dir="${gitDir}" --work-tree="${workTree}" ${cmd}`);

/** Map of every file under `dir` to its sha256. */
async function treeMap(dir) {
  const out = new Map();
  async function walk(d, rel) {
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(p, r);
      else out.set(r, createHash('sha256').update(await readFile(p)).digest('hex'));
    }
  }
  await walk(dir, '');
  return out;
}

async function treeFingerprint(dir) {
  const m = await treeMap(dir);
  return createHash('sha256').update([...m].map(([k, v]) => `${k}\0${v}`).join('\n')).digest('hex');
}

/**
 * Every path whose content changed (or appeared, or vanished) between two
 * treeMaps.
 *
 * Reported as a LIST rather than as a single equal/not-equal, because
 * `.gitignore` at the domains root is legitimately rewritten on every connect
 * — ensureDomainsGitignore() is the first thing setup() calls, and it is
 * pre-existing behaviour with its own coverage in test-sync-hygiene.js.
 * Excluding it from a boolean fingerprint would hide anything else the same
 * write path touched; naming exactly what moved does not.
 */
function changedPaths(before, after) {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].filter((n) => before.get(n) !== after.get(n)).sort();
}

/** A bare "remote" holding one commit of `files`. */
async function makeSeededRemote(files) {
  const base = await tmp('remote');
  const remote = path.join(base, 'remote.git');
  sh(`git init --bare -q "${remote}"`);
  const seed = path.join(base, 'seed');
  await mkdir(seed, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(path.join(seed, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(seed, rel), body);
  }
  sh('git -c init.defaultBranch=main init -q .', seed);
  sh('git config user.email t@t.t && git config user.name T && git add -A && git commit -qm seed && git branch -M main', seed);
  sh(`git remote add origin "${remote}" && git push -q -u origin main`, seed);
  return remote;
}

/** A domains folder holding `files`, wired up as the active domains dir. */
async function makeDomains(files) {
  const base = await tmp('install');
  const domains = path.join(base, 'domains');
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(path.join(domains, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(domains, rel), body);
  }
  __setDomainsDirOverride(domains);
  return { base, domains };
}

/** Point sync.js at a private git dir + config file under `base`. */
async function useInstall(base, name = 'appdata') {
  const dir = path.join(base, name);
  await mkdir(dir, { recursive: true });
  const gitDir = path.join(dir, '.knowledge-git');
  const configFile = path.join(dir, '.sync-config.json');
  __setSyncTestOverrides({ gitDir, configFile });
  return { gitDir, configFile };
}

// ── Real-file fingerprints, taken BEFORE anything runs ────────────────────
const REAL = {
  syncConfig: existsSync(getSyncConfigFile())
    ? createHash('sha256').update(readFileSync(getSyncConfigFile())).digest('hex') : null,
  syncGitExists: existsSync(getSyncGitDir()),
  domainsFingerprint: existsSync(getDefaultDomainsDir())
    ? await treeFingerprint(getDefaultDomainsDir()) : null,
};

try {

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n1. CONTROL — the hazard is real: `git reset --hard` clobbers untracked files that `checkout` refuses to touch\n');
// ═══════════════════════════════════════════════════════════════════════════
// This is the incident's mechanism, reproduced with raw git and NO Curator
// code, and kept permanently. Without it every assertion below is measuring
// a guard against a threat nobody has demonstrated. Git says no twice; the
// old fallback ladder said yes anyway.
{
  const remote = await makeSeededRemote({
    'proj/CLAUDE.md': 'schema\n',
    'proj/state/current.md': 'OLD handoff\n',
    'proj/state/journal.jsonl': '{"n":1}\n',
  });
  const { base, domains } = await makeDomains({
    'proj/CLAUDE.md': 'schema\n',
    'proj/state/current.md': 'NEW handoff — four hours of work\n',
    'proj/state/journal.jsonl': '{"n":1}\n{"n":2}\n{"n":3}\n',
  });
  const gitDir = path.join(base, 'raw', '.knowledge-git');
  await mkdir(gitDir, { recursive: true });
  inRepo(gitDir, domains, 'init -q');
  inRepo(gitDir, domains, 'config user.email t@t.t');
  inRepo(gitDir, domains, 'config user.name T');
  inRepo(gitDir, domains, `remote add origin "file://${remote}"`);
  inRepo(gitDir, domains, 'fetch -q origin main');

  let checkoutRefused = false;
  try { inRepo(gitDir, domains, 'checkout -b main origin/main'); }
  catch (err) { checkoutRefused = /untracked working tree files would be overwritten/i.test(String(err.stderr || err)); }
  ok(checkoutRefused, '1a: `git checkout -b main origin/main` REFUSES, naming the files it would overwrite — git\'s own guard fires');

  inRepo(gitDir, domains, 'reset --hard origin/main');
  const afterJournal = await readFile(path.join(domains, 'proj/state/journal.jsonl'), 'utf8');
  const afterCurrent = await readFile(path.join(domains, 'proj/state/current.md'), 'utf8');
  eq(afterJournal.trim().split('\n').length, 1,
     '1b: `git reset --hard` then destroys the append-only journal anyway — 3 lines to 1');
  eq(afterCurrent, 'OLD handoff\n',
     '1c: ...and replaces the newer handoff with the older remote revision, exit 0, no warning');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n2. assessPullOverwrite — the measurement, and the refresh that makes it honest\n');
// ═══════════════════════════════════════════════════════════════════════════
{
  const remote = await makeSeededRemote({
    'proj/CLAUDE.md': 'schema\n',
    'proj/differs.md': 'remote version\n',
    'proj/identical.md': 'byte for byte\n',
    'proj/remote-only.md': 'only in the repo\n',
  });
  const { base, domains } = await makeDomains({
    'proj/CLAUDE.md': 'schema\n',
    'proj/differs.md': 'LOCAL version\n',
    'proj/identical.md': 'byte for byte\n',
    'proj/local-only.md': 'only on disk\n',
  });
  const gitDir = path.join(base, 'probe', '.knowledge-git');
  await mkdir(gitDir, { recursive: true });
  inRepo(gitDir, domains, 'init -q');
  inRepo(gitDir, domains, `remote add origin "file://${remote}"`);
  inRepo(gitDir, domains, 'fetch -q origin main');

  const before = await treeFingerprint(domains);
  const a = await T.assessPullOverwrite(gitDir);
  const after = await treeFingerprint(domains);

  eq(after, before, '2a: assessPullOverwrite writes NOTHING to the work tree');
  eq(a.overwriteCount, 1, '2b: exactly one file would be overwritten');
  eq(a.overwrite[0], 'proj/differs.md', '2c: ...and it is the one whose content actually differs');
  ok(!a.overwrite.includes('proj/identical.md'),
     '2d: THE REFRESH CONTROL — a byte-identical file is NOT reported. Without `update-index --refresh` a freshly read-tree\'d index has zeroed stat data and diff-files reports EVERY file as modified, so the guard would fire on every connect and be clicked through');
  ok(!a.overwrite.includes('proj/local-only.md'),
     '2e: a local-only file is not in the overwrite set — a checkout does not touch it');
  eq(a.createCount, 1, '2f: a remote-only file is counted separately as a creation, not an overwrite');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n3. preflightSetup — a preview that changes nothing\n');
// ═══════════════════════════════════════════════════════════════════════════
{
  const remote = await makeSeededRemote({
    'proj/CLAUDE.md': 'schema\n',
    'proj/state/current.md': 'OLD handoff\n',
  });
  const { base, domains } = await makeDomains({
    'proj/CLAUDE.md': 'schema\n',
    'proj/state/current.md': 'NEW handoff\n',
  });
  const { gitDir } = await useInstall(base);

  const before = await treeFingerprint(domains);
  const pre = await preflightSetup(`file://${remote}`, 'tok');
  const after = await treeFingerprint(domains);

  eq(after, before, '3a: the preflight does not touch a single byte of the domains folder');
  ok(!existsSync(gitDir),
     '3b: ...and does not create this install\'s git dir. isConfigured() tests for that directory, so a preview that created it would leave a cancelled connect claiming to be set up');
  eq(pre.ok, true, '3c: preflight reports ok');
  eq(pre.remoteHasMain, true, '3d: it saw the remote history');
  eq(pre.overwriteCount, 1, '3e: it quotes the count BEFORE the click — this is the number that was missing');
  eq(pre.overwriteSample[0], 'proj/state/current.md', '3f: ...and names the file');
  eq(pre.recommendedMode, 'merge',
     '3g: the recommended mode is NEVER the destructive one when it would destroy something');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n4. setup(mode:"pull") REFUSES rather than overwriting, and cleans up after itself\n');
// ═══════════════════════════════════════════════════════════════════════════
{
  const remote = await makeSeededRemote({
    'proj/CLAUDE.md': 'schema\n',
    'proj/state/current.md': 'OLD handoff\n',
    'proj/state/journal.jsonl': '{"n":1}\n',
  });
  const { base, domains } = await makeDomains({
    'proj/CLAUDE.md': 'schema\n',
    'proj/state/current.md': 'NEW handoff — four hours of work\n',
    'proj/state/journal.jsonl': '{"n":1}\n{"n":2}\n{"n":3}\n',
  });
  const { gitDir, configFile } = await useInstall(base);
  const before = await treeMap(domains);

  let refusal = null;
  try { await setup(`file://${remote}`, 'tok', 'pull'); }
  catch (err) { refusal = syncRefusalOf(err); }

  ok(refusal !== null, '4a: THE FIX — the incident\'s exact call is refused instead of executed');
  eq(refusal && refusal.code, 'pull-would-overwrite', '4b: with a machine-readable code the UI can render as a choice');
  eq(refusal && refusal.details.overwriteCount, 2, '4c: and the count of what it would have destroyed');
  eq(refusal && refusal.details.source, 'measured',
     '4c2: WHICH LAYER REFUSED. There are two — the measurement above the checkout, and git\'s own untracked-overwrite refusal below it — and a mutation deleting the first left the suite GREEN, because the second catches the same collision. They are not interchangeable: only the measurement produces a count and a file list BEFORE anything is attempted, and it is the only one a preview can use at all. Pinning the source is what makes deleting it visible');
  eq(JSON.stringify(changedPaths(before, await treeMap(domains))), JSON.stringify(['.gitignore']),
     '4d: NOT ONE WIKI FILE MOVED — the handoff and the append-only journal survive. The only path that changed is the domains .gitignore, which ensureDomainsGitignore() writes on every connect, push and pull and always has');
  ok(!existsSync(gitDir),
     '4e: ROLLBACK — the git dir this call created is removed. isConfigured() tests for it, so leaving it would make the app claim sync is configured when no credentials were ever saved');
  ok(!existsSync(configFile), '4f: and no credentials were written');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n5. ...and the confirmed overwrite still works, so the guard is a gate and not a wall\n');
// ═══════════════════════════════════════════════════════════════════════════
{
  const remote = await makeSeededRemote({
    'proj/CLAUDE.md': 'schema\n',
    'proj/state/current.md': 'OLD handoff\n',
  });
  const { base, domains } = await makeDomains({
    'proj/CLAUDE.md': 'schema\n',
    'proj/state/current.md': 'NEW handoff\n',
  });
  await useInstall(base);

  // A CLIENT THAT DOES NOT KNOW ABOUT THE FLAG CANNOT DESTROY ANYTHING.
  // /old's connect form is frozen and can never be taught the new dialog, so
  // the safety has to hold on this side of the wire. A truthy STRING must
  // not pass either — `Boolean('false')` is true, which is the coercion trap
  // v3.30.0 refused for safeToQuit.
  for (const bad of [undefined, false, 'true', 1, {}]) {
    let code = null;
    try { await setup(`file://${remote}`, 'tok', 'pull', { confirmOverwrite: bad }); }
    catch (err) { code = (syncRefusalOf(err) || {}).code; }
    eq(code, 'pull-would-overwrite',
       `5a: confirmOverwrite: ${JSON.stringify(bad)} does NOT authorise an overwrite`);
  }

  const r = await setup(`file://${remote}`, 'tok', 'pull', { confirmOverwrite: true });
  eq(r.mode, 'pull', '5b: an explicit `=== true` confirmation proceeds');
  eq(await readFile(path.join(domains, 'proj/state/current.md'), 'utf8'), 'OLD handoff\n',
     '5c: ...and does what it says on the tin — the user was shown the count and said yes');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n6. setup(mode:"merge") — the non-destructive route that was missing\n');
// ═══════════════════════════════════════════════════════════════════════════
{
  const remote = await makeSeededRemote({
    'proj/CLAUDE.md': 'schema\n',
    'proj/state/current.md': 'OLD handoff\n',
    'proj/state/journal.jsonl': '{"n":1}\n',
    'proj/remote-only.md': 'only in the repo\n',
  });
  const { base, domains } = await makeDomains({
    'proj/CLAUDE.md': 'schema\n',
    'proj/state/current.md': 'NEW handoff — four hours of work\n',
    'proj/state/journal.jsonl': '{"n":1}\n{"n":2}\n{"n":3}\n',
    'proj/new-local.md': 'written since the last push\n',
  });
  const { gitDir } = await useInstall(base);

  // Guarded: two mutations in this arm (dropping
  // --allow-unrelated-histories, and not committing the local side before
  // the merge) make this call THROW, and an uncaught throw kills the tally
  // before any expectation is named — the v3.24.1 shape.
  let r = null;
  let mergeErr = null;
  try { r = await setup(`file://${remote}`, 'tok', 'merge'); }
  catch (err) { mergeErr = err; }
  ok(mergeErr === null,
     `6a0: merge mode completes rather than throwing${mergeErr ? ` (threw: ${mergeErr.message.slice(0, 90)})` : ''}`);
  eq(r && r.mode, 'merge', '6a: merge mode completes');
  eq(await readFile(path.join(domains, 'proj/state/current.md'), 'utf8').catch(() => null),
     'NEW handoff — four hours of work\n',
     '6b: THE LOCAL SIDE SURVIVES. `-X ours` on a FIRST CONNECT is a different decision from pull()\'s `-X theirs`: the local side has by construction never been pushed anywhere, so preferring origin would prefer a revision that provably does not contain the user\'s newest work');
  eq(((await readFile(path.join(domains, 'proj/state/journal.jsonl'), 'utf8').catch(() => ''))).trim().split('\n').filter(Boolean).length, 3,
     '6c: the append-only journal keeps all three lines');
  eq(await readFile(path.join(domains, 'proj/new-local.md'), 'utf8').catch(() => null), 'written since the last push\n',
     '6d: a page written locally since the last push is kept');
  ok(existsSync(path.join(domains, 'proj/remote-only.md')),
     '6e: and a page that exists only in the repo is brought in — nothing from either side is dropped');

  // The pre-merge state of every local file is reachable from the merge's
  // FIRST parent, because the local content is committed BEFORE the merge.
  // That single ordering is what makes this recoverable rather than merely
  // preferable.
  let preMerge = null;
  try {
    const firstParent = inRepo(gitDir, domains, 'rev-parse HEAD^1').trim();
    preMerge = inRepo(gitDir, domains, `show ${firstParent}:proj/state/current.md`);
  } catch { /* named by the assertion below, never by a crash */ }
  eq(preMerge, 'NEW handoff — four hours of work\n',
     '6f: RECOVERABILITY — the local side is committed before the merge, so whatever the merge decides, the pre-merge bytes are reachable from HEAD^1');

  let pushed = null;
  try { pushed = await push(); } catch (err) { pushed = { pushed: false, err: err.message }; }
  eq(pushed.pushed, true,
     '6g: and the push fast-forwards — the merge has origin/main as a parent, so this is the whole recovery path for the reported incident');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n7. Adoption — one sync repo per folder, and the work tree is never touched\n');
// ═══════════════════════════════════════════════════════════════════════════
let adoptFixture = null;
{
  // An EMPTY remote that the browser install seeds, which is the real
  // history: one install connected first and pushed this folder up.
  const remoteBase = await tmp('remote');
  const remote = path.join(remoteBase, 'remote.git');
  sh(`git init --bare -q "${remote}"`);
  const { base, domains } = await makeDomains({
    'proj/CLAUDE.md': 'schema\n',
    'proj/state/current.md': 'NEW handoff\n',
    'proj/state/journal.jsonl': '{"n":1}\n{"n":2}\n{"n":3}\n',
  });
  // The BROWSER install: its sync repo is the sibling of the domains folder,
  // which is where a repo-mode install necessarily puts it (getUserDataDir()
  // IS the checkout, and the default domains folder is <checkout>/domains).
  const browserGit = path.join(base, '.knowledge-git');
  await mkdir(browserGit, { recursive: true });
  inRepo(browserGit, domains, 'init -q');
  inRepo(browserGit, domains, 'config user.email t@t.t');
  inRepo(browserGit, domains, 'config user.name T');
  inRepo(browserGit, domains, `remote add origin "file://${remote}"`);
  inRepo(browserGit, domains, 'add -A');
  inRepo(browserGit, domains, 'commit -qm first');
  inRepo(browserGit, domains, 'branch -M main');
  inRepo(browserGit, domains, 'push -q -u origin main');

  // The MAC APP: its own user-data dir, its own default git dir.
  const { gitDir: appDefault, configFile } = await useInstall(base, 'appdata');

  const before = await treeMap(domains);
  const pre = await preflightSetup(`file://${remote}`, 'tok');
  ok(pre.foreignSyncRepo !== null, '7a: the preflight sees the other install\'s sync repo');
  // `(pre.foreignSyncRepo || {})`, not a bare dereference: a mutation that
  // disables detection makes this null, and a TypeError here kills the
  // process before the tally prints. A guard must STOP, not crash.
  eq((pre.foreignSyncRepo || {}).matchesRequestedRepo, true, '7b: ...and confirms it points at the SAME GitHub repository');
  eq(pre.recommendedMode, 'adopt', '7c: ...so the recommendation is to join it, not to start a second one');

  // GUARDED, NOT BARE. A mutation that disables adoption makes this call
  // THROW, and an uncaught throw here kills the process before the tally
  // prints — the v3.24.1 shape, where a mutation reddens by crashing and
  // names no expectation. Catching it turns that into a named failure.
  let r = null;
  let setupErr = null;
  try { r = await setup(`file://${remote}`, 'tok', 'pull'); }
  catch (err) { setupErr = err; }
  ok(setupErr === null,
     `7d0: setup completes rather than throwing${setupErr ? ` (threw: ${setupErr.message.slice(0, 90)})` : ''}`);
  eq(r && r.adopted, true, '7d: setup adopts, and the requested MODE becomes irrelevant — even "pull" writes nothing');
  eq(JSON.stringify(changedPaths(before, await treeMap(domains))), JSON.stringify(['.gitignore']),
     '7e: NOT ONE WIKI FILE MOVED. Adoption is safe to do automatically precisely because closing the split costs no file — the only path that changed is the managed .gitignore');
  ok(!existsSync(appDefault), '7f: no second sync repo was created');
  const cfg = existsSync(configFile) ? JSON.parse(await readFile(configFile, 'utf8')) : {};
  eq(cfg.gitDir, browserGit, '7g: the adoption is RECORDED as a stored fact, not re-derived by a heuristic on every call');
  eq(T.currentGitDir(), browserGit, '7h: ...and currentGitDir() honours it');

  // A push from the app must land in the ADOPTED history, not a private one.
  await writeFile(path.join(domains, 'proj/state/current.md'), 'newer still\n');
  let pushed = null;
  try { pushed = await push(); } catch (err) { pushed = { pushed: false, err: err.message }; }
  eq(pushed.pushed, true, '7i: the app can push');
  ok(inRepo(browserGit, domains, 'log -1 --format=%s').includes('The Curator sync'),
     '7j: ...and the commit lands in the OTHER install\'s repository — one history, which is the whole point');

  const st = await getStatus();
  eq(st.adoptedSyncRepo, true, '7k: getStatus reports the adoption');
  eq(st.splitSyncRepo, false, '7l: ...and does NOT report a split, because there is not one any more');

  adoptFixture = { base, domains, browserGit, configFile, remote };
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n8. disconnect() must never delete a repo it adopted\n');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { browserGit, configFile } = adoptFixture;
  await disconnect();
  ok(existsSync(path.join(browserGit, 'HEAD')),
     '8a: THE HAZARD ADOPTION CREATES, CLOSED. Without this branch the Mac app\'s Disconnect button would rm -rf the browser install\'s entire sync history — strictly worse than the split adoption exists to fix');
  ok(!existsSync(configFile), '8b: it removes only this install\'s own credential file, which is all this install owns');
  eq(T.configuredGitDir(), null, '8c: and the install is fully un-adopted afterwards');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n9. A foreign sync repo pointing at a DIFFERENT remote is refused, not silently doubled\n');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { base, domains, browserGit } = adoptFixture;
  __setDomainsDirOverride(domains);
  await useInstall(base, 'appdata2');
  const otherBase = await tmp('other');
  const other = path.join(otherBase, 'other.git');
  sh(`git init --bare -q "${other}"`);

  const before = await treeFingerprint(domains);
  let refusal = null;
  try { await setup(`file://${other}`, 'tok', 'push'); }
  catch (err) { refusal = syncRefusalOf(err); }
  eq(refusal && refusal.code, 'foreign-sync-repo',
     '9a: two sync repos over one folder pushing to two DIFFERENT repositories is not a configuration anyone means — refused');
  ok(refusal && refusal.details.otherOriginUrl && refusal.details.otherOriginUrl.includes('remote.git'),
     '9b: the refusal names the other install\'s remote, so the user can tell which is which');
  eq(await treeFingerprint(domains), before, '9c: and nothing was written');
  ok(existsSync(path.join(browserGit, 'HEAD')), '9d: the other install\'s repo is untouched');
}

{
  // A foreign sync repo whose `origin` CANNOT BE READ. Adoption turns on
  // "does it point at the same repository?", and the answer here is "we
  // cannot tell" — which is not "yes". A mutation writing the comparison as
  // a plain `a === b` makes two nulls compare EQUAL and adopts a repository
  // on no evidence at all; that mutation came back green until this fixture
  // existed.
  const remote = await makeSeededRemote({ 'proj/CLAUDE.md': 'schema\n' });
  const { base, domains } = await makeDomains({ 'proj/CLAUDE.md': 'schema\n' });
  const orphanGit = path.join(base, '.knowledge-git');
  await mkdir(orphanGit, { recursive: true });
  inRepo(orphanGit, domains, 'init -q');   // a real git dir, but NO origin remote
  await useInstall(base, 'appdata3');

  const detected = await T.detectForeignSyncRepo(`file://${remote}`);
  ok(detected !== null, '9e: a sibling repo with no origin is still DETECTED — it governs the folder either way');
  eq((detected || {}).matchesRequestedRepo, false,
     '9f: ...but it does NOT match. "We could not tell" is not "they are the same", and adopting on it would hand this install a repository nobody chose');
  // THE BOTH-NULL CASE, and it needs its own assertion: with a REQUESTED url
  // that is also unparseable, `a === b` is satisfied by two nulls and the
  // repo is adopted on no evidence whatsoever. Writing the comparison as
  // `a === b` came back GREEN against 9f alone, because there `a` is null
  // and `b` is a real string, so the inequality carried the refusal on its
  // own. Only the `a &&` half is being tested here.
  const bothNull = await T.detectForeignSyncRepo('');
  eq((bothNull || {}).matchesRequestedRepo, false,
     '9f2: two unreadable identities are NOT a match — null never equals null on the question "is this the same repository?"');

  let code = null;
  try { await setup(`file://${remote}`, 'tok', 'push'); }
  catch (err) { code = (syncRefusalOf(err) || {}).code; }
  eq(code, 'foreign-sync-repo', '9g: so setup refuses rather than adopting on no evidence');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n10. getStatus reports the ALREADY-SPLIT state, because adoption cannot retro-fix one\n');
// ═══════════════════════════════════════════════════════════════════════════
{
  // setup() closes the split for a connect made from now on. It does nothing
  // for an install that is already split, because setup() does not run again
  // — and one exists, on the machine that reported this. Self-healing it
  // silently would switch a working install onto a different repository
  // behind the user's back and orphan whatever its own repo holds; that is
  // the same class of unrequested decision that lost the data. So the app
  // has to be able to SAY so.
  const remote = await makeSeededRemote({ 'proj/CLAUDE.md': 'schema\n' });
  const { base, domains } = await makeDomains({ 'proj/CLAUDE.md': 'schema\n' });
  const browserGit = path.join(base, '.knowledge-git');
  await mkdir(browserGit, { recursive: true });
  inRepo(browserGit, domains, 'init -q');
  inRepo(browserGit, domains, `remote add origin "file://${remote}"`);

  // An install already configured with its OWN repo — the split state.
  const { gitDir, configFile } = await useInstall(base, 'splitapp');
  await mkdir(gitDir, { recursive: true });
  inRepo(gitDir, domains, 'init -q');
  inRepo(gitDir, domains, 'config user.email t@t.t');
  inRepo(gitDir, domains, 'config user.name T');
  inRepo(gitDir, domains, `remote add origin "file://${remote}"`);
  await writeFile(configFile, JSON.stringify({ repoUrl: `file://${remote}`, token: 'tok' }), { mode: 0o600 });

  const st = await getStatus();
  eq(st.splitSyncRepo, true, '10a: the split is detected and reported');
  eq(st.adoptedSyncRepo, false, '10b: ...and distinguished from an adopted install, which shares a repo by design');
  eq(T.foreignSyncRepoPresent(), true, '10c: the cheap detector agrees');

  // The maintainer's remedy, end to end: Disconnect, then Connect again.
  await disconnect();
  // Guarded: with adoption disabled this connect is REFUSED (the remote is
  // not empty), and an uncaught refusal here kills the tally.
  let r = null;
  let remedyErr = null;
  try { r = await setup(`file://${remote}`, 'tok', 'push'); }
  catch (err) { remedyErr = err; }
  ok(remedyErr === null,
     `10d0: the reconnect completes rather than throwing${remedyErr ? ` (threw: ${remedyErr.message.slice(0, 80)})` : ''}`);
  eq(r && r.adopted, true, '10d: THE REMEDY — a reconnect after disconnecting adopts, and the split is gone in two clicks');
  eq((await getStatus()).splitSyncRepo, false, '10e: ...confirmed by the status the banner reads');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n11. repoIdentity — the comparison adoption turns on\n');
// ═══════════════════════════════════════════════════════════════════════════
{
  const id = T.repoIdentity;
  eq(id('https://github.com/me/wiki'), 'github.com/me/wiki', '11a: plain https');
  eq(id('https://github.com/me/wiki.git'), 'github.com/me/wiki', '11b: .git suffix stripped');
  eq(id('git@github.com:me/wiki.git'), 'github.com/me/wiki', '11c: ssh form normalises to the same identity');
  eq(id('https://ghp_secret@github.com/me/wiki'), 'github.com/me/wiki', '11d: an embedded credential is stripped, so a stored token never decides the comparison');
  eq(id('https://GitHub.com/Me/Wiki/'), 'github.com/me/wiki', '11e: case and a trailing slash do not split the identity');
  ok(id('https://github.com/me/wiki') !== id('https://github.com/me/other'),
     '11f: different repos do not collide');
  eq(id(''), null, '11g: unparseable is null');
  ok(!(id(null) && id(undefined) && id(null) === id(undefined)),
     '11h: NULL NEVER MATCHES NULL — an unreadable origin is "we could not tell", and adopting on that basis would be adopting on no evidence');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n11b. An adopted git dir that has VANISHED fails back to the install default\n');
// ═══════════════════════════════════════════════════════════════════════════
{
  // FAILS BACK, NEVER FAILS OVER. If the other install is deleted, the
  // recorded gitDir points at nothing. Resolving to the install default
  // means this install starts a repo of its own — the pre-v3.32.0 behaviour,
  // which is recoverable. Throwing, or returning a dead path, would leave
  // sync permanently broken with no way back through the UI.
  const { base } = await makeDomains({ 'proj/CLAUDE.md': 'schema\n' });
  const { gitDir, configFile } = await useInstall(base, 'ghost');
  const ghost = path.join(base, 'deleted', '.knowledge-git');
  await writeFile(configFile, JSON.stringify({ repoUrl: 'x', token: 'y', gitDir: ghost }), { mode: 0o600 });
  eq(T.configuredGitDir(), null, '11b1: a gitDir that is not a git dir on disk is ignored');
  eq(T.currentGitDir(), gitDir, '11b2: ...and resolution falls back to this install\'s own default');

  // A RELATIVE path that IS a real git dir when resolved from the process
  // cwd. `../relative` alone would not prove anything: it is not a git dir
  // either, so looksLikeGitDir() catches it and the absoluteness check is
  // untested — that version of this assertion came back green under a
  // mutation deleting `path.isAbsolute`. A relative path is refused because
  // existsSync resolves it against process.cwd() while git() runs with
  // `cwd: ROOT`, so the same string can name two different directories in
  // the same process, and the one it names is then interpolated into a
  // `git --git-dir` argument.
  const realGit = path.join(base, 'realgit', '.knowledge-git');
  await mkdir(realGit, { recursive: true });
  inRepo(realGit, base, 'init -q');
  const relative = path.relative(process.cwd(), realGit);
  ok(T.looksLikeGitDir(relative),
     '11b3: (control) the relative path really does resolve to a git dir from the process cwd, so the shape check alone would accept it');
  await writeFile(configFile, JSON.stringify({ repoUrl: 'x', token: 'y', gitDir: relative }), { mode: 0o600 });
  eq(T.configuredGitDir(), null, '11b4: ...and it is refused anyway, on absoluteness');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n12. The refusals a wrong mode produces are sentences, never raw git text\n');
// ═══════════════════════════════════════════════════════════════════════════
{
  const emptyBase = await tmp('empty-remote');
  const emptyRemote = path.join(emptyBase, 'remote.git');
  sh(`git init --bare -q "${emptyRemote}"`);
  const { base } = await makeDomains({ 'proj/CLAUDE.md': 'schema\n' });
  await useInstall(base);

  let code = null;
  try { await setup(`file://${emptyRemote}`, 'tok', 'pull'); }
  catch (err) { code = (syncRefusalOf(err) || {}).code; }
  eq(code, 'remote-empty',
     '12a: pulling from an empty repository is a written refusal, not a git transcript');

  // And the push arm's non-fast-forward, which is what the reporter hit.
  const seeded = await makeSeededRemote({ 'proj/CLAUDE.md': 'other machine\n' });
  const { base: b2 } = await makeDomains({ 'proj/CLAUDE.md': 'schema\n' });
  await useInstall(b2);
  let refusal = null;
  try { await setup(`file://${seeded}`, 'tok', 'push'); }
  catch (err) { refusal = syncRefusalOf(err); }
  eq(refusal && refusal.code, 'remote-not-empty',
     '12b: THE REFUSAL THE REPORTER HIT is now connect-specific');
  ok(refusal && /merge option/i.test(refusal.message) && !/Advanced/.test(refusal.message) && !/Pull only/.test(refusal.message),
     '12c: ...and it names an ACTION and a screen rather than a button label. The old wording sent the user to "Pull only (under Advanced)" — a control on the CONFIGURED screen in /old and nowhere at all on the connect screen — so the only thing left to click was the one that overwrote his files. Naming a label here would reproduce that one screen over, because /old is frozen and has no merge control');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n13. Copy and call-site guards\n');
// ═══════════════════════════════════════════════════════════════════════════
{
  ok(!friendlyError(new Error('! [rejected] main -> main (non-fast-forward)')).includes('under Advanced'),
     '13a: the shared non-fast-forward message no longer names a control by its location. /next puts Push only / Pull only at the top level of the Sync view; only /old has an "Advanced" disclosure');

  const viewSrc = await readFile(path.join(ROOT, 'src/public/next/views/sync.js'), 'utf8');
  const code = viewSrc.split('\n').filter((l) => {
    const t = l.trim();
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
  }).join('\n');
  const confirmSites = code.match(/runSetup\([^)]*,\s*true\s*,/g) || [];
  eq(confirmSites.length, 1,
     '13b: EXACTLY ONE call site in the Sync view authorises an overwrite — the button the user reaches only after seeing the count and the file list');
  ok(/data-mode="merge"/.test(code),
     '13c: the merge control exists in the connect card — the door that was missing');
  ok(/id="btn-decide-merge"/.test(code) && /id="btn-decide-overwrite"/.test(code),
     '13d: and the overwrite decision panel offers merge alongside it, so the destructive route is never the only one');
  // POSITIVE CONTROL for the comment-stripping above: a false positive here
  // is a red test someone reads; a false negative is this bug shipping again.
  ok(/btn-decide-cancel/.test(code), '13e: (control) the stripper did not eat the panel — its Cancel button is still visible to the scan');

  const routeSrc = await readFile(path.join(ROOT, 'src/routes/sync.js'), 'utf8');
  ok(/confirmOverwrite:\s*confirmOverwrite === true/.test(routeSrc),
     '13f: the route compares confirmOverwrite with === true rather than coercing it. `Boolean("false")` is true, and this is the single flag standing between a POST body and a `git reset --hard` over the user\'s wiki');
  ok(/POST-only|router\.post\('\/preflight'/.test(routeSrc) && !/router\.get\('\/preflight'/.test(routeSrc),
     '13g: the preflight is POST-only — it carries a GitHub PAT in its body, and a GET would put the token in a URL');

  ok(SETUP_MODES.includes('merge') && SETUP_MODES.length === 3,
     '13f: three connect modes, and the route validates against this list rather than a second hand-written copy');
}

} finally {
  __setSyncTestOverrides({});
  __setDomainsDirOverride(null);
  for (const d of TMPS) await rm(d, { recursive: true, force: true }).catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n14. ISOLATION — the developer\'s real sync credentials and wiki are untouched\n');
// ═══════════════════════════════════════════════════════════════════════════
{
  const nowConfig = existsSync(getSyncConfigFile())
    ? createHash('sha256').update(readFileSync(getSyncConfigFile())).digest('hex') : null;
  eq(nowConfig, REAL.syncConfig, '14a: the real .sync-config.json (which holds a GitHub PAT) is unchanged');
  eq(existsSync(getSyncGitDir()), REAL.syncGitExists, '14b: the real .knowledge-git was neither created nor removed');
  const nowDomains = existsSync(getDefaultDomainsDir()) ? await treeFingerprint(getDefaultDomainsDir()) : null;
  eq(nowDomains, REAL.domainsFingerprint, '14c: the real domains folder is byte-identical');
}

console.log('\n' + '='.repeat(60));
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed) {
  console.log('\nFailing assertions:');
  for (const f of failures) console.log('  - ' + f);
}
console.log('='.repeat(60));
process.exit(failed ? 1 : 0);
