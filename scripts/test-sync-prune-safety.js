#!/usr/bin/env node
/**
 * test-sync-prune-safety.js — OFFLINE battle test for pull()'s ghost-domain
 * prune: it must still finish a sync-delete, and it must never again delete
 * a folder the user made.
 *
 * WHAT WAS WRONG. `pruneGhostDomainDirs()` ran at the end of EVERY pull(),
 * walked the top level of the domains folder, and recursively deleted any
 * non-dot directory with no `CLAUDE.md`. Measured in the research pass for
 * docs/roadmap-automatic-sync.md, with nothing incoming from the remote:
 *
 *     before pull: [ Attachments, demo, newdomain ]
 *     after  pull: [ demo ]      pruned: ["Attachments","newdomain"]
 *
 * The domains folder is a documented Obsidian vault root, and Obsidian's own
 * default for a pasted image is an attachments folder at the vault root. So
 * a folder created by the normal use of the tool the docs recommend was
 * destroyed by the next pull, with no confirmation and no undo — and, since
 * `push()` runs `git add -A`, a stray folder that had ever been pushed was
 * TRACKED, so the deletion was then propagated to the remote and to every
 * other machine.
 *
 * WHAT THIS SUITE HOLDS. Section 1 is a permanent CONTROL: it runs the
 * PRE-FIX rule, transcribed literally, against real git and reproduces both
 * halves of the harm — so every assertion after it is measuring a real
 * hazard rather than a hypothetical one. Sections 2-6 drive the REAL pull()
 * against REAL temporary git repositories and assert, in the same pull:
 *
 *   - a stray user folder SURVIVES (the fix), and
 *   - a genuinely deleted domain's shell is still cleaned up (v2.3.4, the
 *     property that must not be lost), and
 *   - the prune can never stage a deletion, so it can never propagate.
 *
 * Section 7 is the fail-safe/injection unit, section 8 runs the real
 * frontend renderer (the wording was part of the defect: "removed N deleted
 * domains" was printed for things that were never domains).
 *
 * ISOLATION. Every git repo, "remote" and domains directory lives under
 * os.tmpdir(). sync.js's git dir / config file and config.js's domains dir
 * are redirected via __setSyncTestOverrides() / __setDomainsDirOverride(),
 * reset in a top-level finally. The real .sync-config.json, the real
 * .knowledge-git and the real domains/ are fingerprinted at both ends and
 * asserted unchanged. Pure offline: no network, no API key, no GitHub —
 * every "remote" is a local `git init --bare`.
 *
 * The harness helpers (sh / withGitLockRetry / configureRepoIdentity) are
 * the established pattern from test-sync-hygiene.js and
 * test-sync-connect-safety.js; see those files for why each exists.
 *
 * Run: node scripts/test-sync-prune-safety.js
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
  push,
  pull,
  __testing as T,
} from '../src/brain/sync.js';
import { __setDomainsDirOverride } from '../src/brain/config.js';
import { getSyncConfigFile, getSyncGitDir, getDefaultDomainsDir } from '../src/brain/paths.js';

let passed = 0;
let failed = 0;
const failures = [];

function ok(label) { passed++; console.log(`  ✓ ${label}`); }
function fail(label, detail) {
  failed++; failures.push({ label, detail });
  console.log(`  ✗ ${label}`);
  if (detail) console.log(`    └─ ${detail}`);
}
function assertEq(actual, expected, label) {
  if (actual === expected) return ok(label);
  fail(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function assertTrue(cond, label, detail) {
  if (cond) return ok(label); fail(label, detail);
}

// ── Harness ────────────────────────────────────────────────────────────────

const cleanupDirs = [];
async function tmp(prefix) {
  const d = await mkdtemp(path.join(tmpdir(), `sps-${prefix}-`));
  cleanupDirs.push(d);
  return d;
}

const TRANSIENT_GIT_LOCK_RE =
  /(?:[\\/][\w.-]*\.lock['"]?:\s*File exists)|(?:Another git process seems to be running)/i;

function sh(gitDir, workTree, cmd) {
  for (let attempt = 0; ; attempt++) {
    try {
      return execSync(`git --git-dir="${gitDir}" --work-tree="${workTree}" ${cmd}`,
        { stdio: 'pipe' }).toString('utf8');
    } catch (err) {
      const detail = `${err.message || ''} ${err.stderr ? err.stderr.toString('utf8') : ''}`;
      if (attempt < 3 && TRANSIENT_GIT_LOCK_RE.test(detail)) {
        execSync('sleep 0.15');
        continue;
      }
      throw err;
    }
  }
}

async function withGitLockRetry(fn, { retries = 2, delayMs = 200 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); } catch (err) {
      if (attempt < retries && TRANSIENT_GIT_LOCK_RE.test(err.message || '')) {
        await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}

function configureRepoIdentity(gitDir, workTree) {
  sh(gitDir, workTree, 'config user.email "test@test"');
  sh(gitDir, workTree, 'config user.name "Test"');
  sh(gitDir, workTree, 'config commit.gpgsign false');
  sh(gitDir, workTree, 'config tag.gpgsign false');
  sh(gitDir, workTree, 'config core.autocrlf false');
}

async function makeBareRemote() {
  const dir = await tmp('remote');
  const remote = path.join(dir, 'remote.git');
  execSync(`git init -q --bare "${remote}"`);
  return remote;
}

async function writeConfigFile(configPath, repoUrl) {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify({ repoUrl, token: '' }));
}

async function seedDomain(domainsDir, slug) {
  await mkdir(path.join(domainsDir, slug, 'wiki'), { recursive: true });
  await writeFile(path.join(domainsDir, slug, 'CLAUDE.md'), '# schema\n');
  await writeFile(path.join(domainsDir, slug, 'wiki', 'index.md'), `# ${slug}\n`);
}

/** An install: its own git dir, config file and domains folder. */
async function makeInstall(name, remote) {
  const base = await tmp(name);
  const domains = path.join(base, 'domains');
  const gitDir = path.join(base, 'appdata', '.knowledge-git');
  const configFile = path.join(base, 'appdata', '.sync-config.json');
  await mkdir(domains, { recursive: true });
  await mkdir(path.dirname(gitDir), { recursive: true });
  sh(gitDir, domains, 'init -q -b main');
  configureRepoIdentity(gitDir, domains);
  sh(gitDir, domains, `remote add origin "${remote}"`);
  await writeConfigFile(configFile, remote);
  return { domains, gitDir, configFile };
}

/** Point sync.js + config.js at one install. */
function use(install) {
  __setSyncTestOverrides({ gitDir: install.gitDir, configFile: install.configFile });
  __setDomainsDirOverride(install.domains);
}

async function topLevel(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .map(e => e.name).sort();
}

function trackedPaths(install) {
  return sh(install.gitDir, install.domains, '-c core.quotePath=false ls-files')
    .split('\n').filter(Boolean);
}

function porcelain(install) {
  return sh(install.gitDir, install.domains, 'status --porcelain')
    .split('\n').filter(Boolean);
}

/**
 * Read a file that a MUTATION is allowed to have deleted. A bare readFile
 * here throws ENOENT and kills the run — the suite then reds by CRASHING,
 * naming no expectation and leaving the tally wrong. Found by mutation M1
 * doing exactly that.
 */
async function readOrMissing(p) {
  try { return await readFile(p, 'utf8'); } catch { return '<<MISSING>>'; }
}

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
 * THE PRE-FIX RULE, transcribed literally from the body that shipped from
 * v2.3.4 to v3.32.0:
 *
 *     for (const entry of entries) {
 *       if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
 *       const dirPath = path.join(base, entry.name);
 *       const schemaPath = path.join(dirPath, 'CLAUDE.md');
 *       if (existsSync(schemaPath)) continue;    // real domain, keep
 *       await rm(dirPath, { recursive: true, force: true });
 *     }
 *
 * Kept here, and only here, so section 1 measures the real hazard instead of
 * describing it. Nothing in src/ calls this.
 */
async function preFixPrune(base) {
  const pruned = [];
  const entries = await readdir(base, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dirPath = path.join(base, entry.name);
    if (existsSync(path.join(dirPath, 'CLAUDE.md'))) continue;
    await rm(dirPath, { recursive: true, force: true });
    pruned.push(entry.name);
  }
  return pruned;
}

// ── Real-file fingerprints, taken BEFORE anything runs ────────────────────
const REAL = {
  syncConfig: existsSync(getSyncConfigFile())
    ? createHash('sha256').update(readFileSync(getSyncConfigFile())).digest('hex') : null,
  syncGitExists: existsSync(getSyncGitDir()),
  domainsFingerprint: existsSync(getDefaultDomainsDir())
    ? await treeFingerprint(getDefaultDomainsDir()) : null,
};

console.log('\n=== sync ghost-prune safety battle test ===\n');

try {

// ═══════════════════════════════════════════════════════════════════════════
console.log('1. CONTROL — the pre-fix rule really does destroy user folders, and really does propagate\n');
// ═══════════════════════════════════════════════════════════════════════════
{
  const remote = await makeBareRemote();
  const a = await makeInstall('control', remote);
  await seedDomain(a.domains, 'demo');
  // The two folders from the measured reproduction: an Obsidian attachments
  // folder at the vault root, and a domain being made by hand whose schema
  // does not exist yet.
  await mkdir(path.join(a.domains, 'Attachments'), { recursive: true });
  await writeFile(path.join(a.domains, 'Attachments', 'diagram.png'), 'PNG bytes');
  await mkdir(path.join(a.domains, 'newdomain'), { recursive: true });
  await writeFile(path.join(a.domains, 'newdomain', 'draft.md'), '# draft I am still writing\n');

  use(a);
  await withGitLockRetry(() => push());

  assertTrue(trackedPaths(a).includes('Attachments/diagram.png'),
    'precondition: push() `git add -A` TRACKS a stray user folder — it is repo content, not a local curiosity');

  const before = await topLevel(a.domains);
  assertEq(before.join(','), 'Attachments,demo,newdomain', 'precondition: three folders on disk');

  const pruned = await preFixPrune(a.domains);

  assertEq((await topLevel(a.domains)).join(','), 'demo',
    'PRE-FIX: both user folders are recursively deleted by the rule "no CLAUDE.md"');
  assertEq(pruned.sort().join(','), 'Attachments,newdomain',
    'PRE-FIX: and they are reported as if they were domains');
  assertTrue(!existsSync(path.join(a.domains, 'Attachments', 'diagram.png')),
    'PRE-FIX: the pasted image is gone from disk');

  // The half that was not in the original report: the deletion is not local.
  const dirty = porcelain(a);
  assertTrue(dirty.some(l => /^\s*D\s+Attachments\/diagram\.png$/.test(l)),
    `PRE-FIX: git sees a DELETION staged against the remote — got ${JSON.stringify(dirty)}`);
  sh(a.gitDir, a.domains, 'add -A');
  assertTrue(!trackedPaths(a).includes('Attachments/diagram.png'),
    'PRE-FIX: one push() later the folder is deleted on GitHub too, and on every other machine');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n2. THE FIX — a pull with NOTHING incoming prunes nothing (the exact measured scenario)\n');
// ═══════════════════════════════════════════════════════════════════════════
{
  const remote = await makeBareRemote();
  const a = await makeInstall('quiet', remote);
  await seedDomain(a.domains, 'demo');
  await mkdir(path.join(a.domains, 'Attachments'), { recursive: true });
  await writeFile(path.join(a.domains, 'Attachments', 'diagram.png'), 'PNG bytes');
  await mkdir(path.join(a.domains, 'newdomain'), { recursive: true });
  await writeFile(path.join(a.domains, 'newdomain', 'draft.md'), '# draft I am still writing\n');

  use(a);
  await withGitLockRetry(() => push());

  const before = await treeMap(a.domains);
  const result = await withGitLockRetry(() => pull());

  assertEq((await topLevel(a.domains)).join(','), 'Attachments,demo,newdomain',
    'FIXED: all three folders survive a pull that had nothing to do');
  assertEq(result.pruned.length, 0, 'pull() reports nothing pruned');
  // Asserted as a SHAPE first: a missing field would otherwise crash the
  // next line with a TypeError, which names no expectation and leaves the
  // tally wrong — this project has been bitten by exactly that.
  assertTrue(Array.isArray(result.prunedKept),
    `pull() carries prunedKept on the wire — got ${JSON.stringify(result.prunedKept)}`);
  assertEq((result.prunedKept || []).length, 0,
    'and nothing kept-with-a-warning either — this pull was a no-op');
  const after = await treeMap(a.domains);
  assertEq(after.get('Attachments/diagram.png'), before.get('Attachments/diagram.png'),
    'the pasted image is byte-identical after the pull');
  assertEq(after.get('newdomain/draft.md'), before.get('newdomain/draft.md'),
    'the hand-made draft domain is byte-identical after the pull');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n2b. THE BASELINE IS TAKEN AFTER THE AUTO-SAVE — a LOCAL delete nominates nothing\n');
// ═══════════════════════════════════════════════════════════════════════════
//
// FOUND BY MUTATION. Moving the `rev-parse HEAD` in pull() from after the
// auto-save commit to before it left the suite green, and it is not a
// cosmetic move: pull() commits the user's tree before it merges, so a
// baseline taken too early puts the user's OWN local deletions into the
// deletion diff. The prune would then treat "I deleted some files in
// Finder" as "another machine deleted this domain" and rm -rf whatever was
// left — here, an Obsidian `.base` file, which domains/.gitignore ignores
// and which therefore has no other guard.
//
// The diff must contain what the REMOTE removed, and nothing else.
{
  const remote = await makeBareRemote();
  const a = await makeInstall('local-del', remote);
  await seedDomain(a.domains, 'demo');
  await mkdir(path.join(a.domains, 'Notes'), { recursive: true });
  await writeFile(path.join(a.domains, 'Notes', 'a.md'), '# a\n');
  await writeFile(path.join(a.domains, 'Notes', 'view.base'), 'obsidian base\n');
  use(a);
  await withGitLockRetry(() => push());

  assertTrue(trackedPaths(a).includes('Notes/a.md') && !trackedPaths(a).includes('Notes/view.base'),
    'precondition: a.md is tracked, the .base file is gitignored — so only the baseline protects it');

  // The user tidies up in Finder: the only tracked file under Notes/ goes.
  await rm(path.join(a.domains, 'Notes', 'a.md'));

  const result = await withGitLockRetry(() => pull());

  assertEq(result.pruned.length, 0,
    `a purely LOCAL deletion nominates nothing — got ${JSON.stringify(result.pruned)}`);
  assertEq(await readOrMissing(path.join(a.domains, 'Notes', 'view.base')), 'obsidian base\n',
    'and the ignored file the user still wanted is byte-identical on disk');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n3. ONE PULL, BOTH BEHAVIOURS — the deleted domain is cleaned up AND the stray folders survive\n');
// ═══════════════════════════════════════════════════════════════════════════
//
// This is the assertion that matters. The v2.3.4 property (a domain deleted
// on another machine stops haunting this one) and the fix (a folder the user
// made is not collateral) have to hold in the SAME pull, or the fix is just
// a feature deletion wearing a guard's clothes.
{
  const remote = await makeBareRemote();
  const a = await makeInstall('m-a', remote);
  await seedDomain(a.domains, 'articles');
  await seedDomain(a.domains, 'ghost');
  use(a);
  await withGitLockRetry(() => push());

  const b = await makeInstall('m-b', remote);
  sh(b.gitDir, b.domains, 'fetch origin -q');
  sh(b.gitDir, b.domains, 'checkout -q -b main origin/main');

  // A deletes the whole `ghost` domain and adds a page.
  use(a);
  await writeFile(path.join(a.domains, 'articles', 'wiki', 'new-page.md'), '# new\n');
  await rm(path.join(a.domains, 'ghost'), { recursive: true, force: true });
  await withGitLockRetry(() => push());

  // B: the ghost shell survives locally ONLY because `raw/` is gitignored and
  // holds a source file — which is the real-world reason the shell exists at
  // all, and exactly the v2.3.4 report.
  use(b);
  await mkdir(path.join(b.domains, 'ghost', 'raw'), { recursive: true });
  await writeFile(path.join(b.domains, 'ghost', 'raw', 'paper.pdf'), 'not really a pdf');
  // B also has the user's own folders at the vault root.
  await mkdir(path.join(b.domains, 'Attachments'), { recursive: true });
  await writeFile(path.join(b.domains, 'Attachments', 'diagram.png'), 'PNG bytes');
  await mkdir(path.join(b.domains, 'Templates'), { recursive: true });
  await writeFile(path.join(b.domains, 'Templates', 'daily.md'), '# daily note template\n');

  const result = await withGitLockRetry(() => pull());

  assertTrue(result.pruned.includes('ghost'),
    `v2.3.4 PRESERVED: the domain deleted on the other machine is pruned — got ${JSON.stringify(result.pruned)}`);
  assertTrue(!existsSync(path.join(b.domains, 'ghost')),
    'v2.3.4 PRESERVED: the ghost shell is gone from disk, including its gitignored raw/ source');
  assertTrue(existsSync(path.join(b.domains, 'Attachments', 'diagram.png')),
    'FIXED: the Obsidian attachments folder survives the same pull');
  assertTrue(existsSync(path.join(b.domains, 'Templates', 'daily.md')),
    'FIXED: a second stray folder survives the same pull');
  assertEq(result.pruned.length, 1, 'exactly one folder was removed — the strays are not in the list');
  assertTrue(Array.isArray(result.prunedKept) && result.prunedKept.length === 0,
    `nothing was kept-with-a-warning in this pull — got ${JSON.stringify(result.prunedKept)}`);
  assertTrue(result.filesChanged > 0,
    `precondition: this pull really did have incoming work (${result.filesChanged} files)`);

  // ── The prune must never stage anything ────────────────────────────────
  // Rule 3 (nothing tracked under it) is what guarantees this: a removal that
  // git already considers deleted cannot become a new deletion to push.
  const dirty = porcelain(b);
  assertTrue(!dirty.some(l => /^\s*D/.test(l)),
    `the prune leaves NO staged or unstaged deletion behind — got ${JSON.stringify(dirty)}`);
  const afterPush = await withGitLockRetry(() => push());
  assertTrue(afterPush !== null, 'a push after the prune completes');
  // Whatever the push did, the stray folders are still here and still tracked.
  assertTrue(trackedPaths(b).includes('Attachments/diagram.png'),
    'and the stray folder is still tracked after that push — nothing propagated');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n3b. RULE 1 ALONE — the folders no other rule can save\n');
// ═══════════════════════════════════════════════════════════════════════════
//
// FOUND BY MUTATION. Deleting rule 1 left section 3 fully green, because
// pull()'s own auto-save commit had TRACKED the stray folders moments
// earlier and rule 3 caught them. So section 3 does not measure the fix; it
// measures a bodyguard standing in front of it.
//
// These three are the shapes with no bodyguard — nothing tracked under
// them, and nothing untracked-and-unignored either, so rules 2, 3 and 4 all
// wave them through and only "this pull did not delete anything here" stops
// the rm -rf. Every one of them is ordinary Obsidian behaviour at a vault
// root:
//
//   - an empty folder you just made (git cannot see an empty directory at
//     all — not as tracked, not as untracked),
//   - a folder holding only `.DS_Store`, which Finder writes into every
//     folder you so much as look at, and which domains/.gitignore ignores,
//   - a folder whose only content is gitignored (`*/raw/`).
//
// The pull must still have real deletions in it, or the size-0 early return
// would be doing the work instead.
{
  const remote = await makeBareRemote();
  const a = await makeInstall('bare-a', remote);
  await seedDomain(a.domains, 'articles');
  await seedDomain(a.domains, 'ghost');
  use(a);
  await withGitLockRetry(() => push());

  const b = await makeInstall('bare-b', remote);
  sh(b.gitDir, b.domains, 'fetch origin -q');
  sh(b.gitDir, b.domains, 'checkout -q -b main origin/main');

  use(a);
  await rm(path.join(a.domains, 'ghost'), { recursive: true, force: true });
  await withGitLockRetry(() => push());

  use(b);
  // The doomed domain's shell only survives the merge because something
  // untracked is inside it — git removes a directory it has emptied. Same
  // reason as section 3, and it is what makes `pruned` non-empty here.
  await mkdir(path.join(b.domains, 'ghost', 'raw'), { recursive: true });
  await writeFile(path.join(b.domains, 'ghost', 'raw', 'source.pdf'), 'not really a pdf');
  await mkdir(path.join(b.domains, 'Inbox'), { recursive: true });
  await mkdir(path.join(b.domains, 'Screenshots'), { recursive: true });
  await writeFile(path.join(b.domains, 'Screenshots', '.DS_Store'), 'finder junk');
  await mkdir(path.join(b.domains, 'Sources', 'raw'), { recursive: true });
  await writeFile(path.join(b.domains, 'Sources', 'raw', 'paper.pdf'), 'not really a pdf');

  const result = await withGitLockRetry(() => pull());

  // Precondition: these really are invisible to every other rule.
  const tracked = trackedPaths(b);
  assertTrue(!tracked.some(p => /^(Inbox|Screenshots|Sources)\//.test(p)),
    `precondition: git tracks NOTHING under the three folders — got ${JSON.stringify(tracked.filter(p => /^(Inbox|Screenshots|Sources)/.test(p)))}`);
  const untracked = porcelain(b).filter(l => l.startsWith('??'));
  assertTrue(!untracked.some(l => /(Inbox|Screenshots|Sources)/.test(l)),
    `precondition: and none of them shows as untracked-not-ignored either — got ${JSON.stringify(untracked)}`);
  assertTrue(result.pruned.includes('ghost'),
    'precondition: this pull DID delete something, so the early return is not what is being measured');

  assertTrue(existsSync(path.join(b.domains, 'Inbox')),
    'RULE 1: an empty folder the user just made survives');
  assertTrue(existsSync(path.join(b.domains, 'Screenshots', '.DS_Store')),
    'RULE 1: a folder holding only Finder junk survives');
  assertEq(await readOrMissing(path.join(b.domains, 'Sources', 'raw', 'paper.pdf')), 'not really a pdf',
    'RULE 1: a folder whose only content is gitignored survives, byte-identical');
  assertEq(result.pruned.join(','), 'ghost',
    'and none of the three is reported as removed');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n4. RULE 3 — a folder that still holds TRACKED files is never pruned, schema or no schema\n');
// ═══════════════════════════════════════════════════════════════════════════
//
// A domain whose CLAUDE.md was deleted on another machine, but whose pages
// were not, is a partially-deleted domain. The old rule deleted the pages
// too. This is also the shape that protects a stray folder holding work the
// user has not pushed: pull()'s own auto-save commit tracks it moments
// earlier, so rule 3 — not rule 4 — is what catches it in practice.
{
  const remote = await makeBareRemote();
  const a = await makeInstall('half-a', remote);
  await seedDomain(a.domains, 'articles');
  await seedDomain(a.domains, 'half');
  await writeFile(path.join(a.domains, 'half', 'wiki', 'keeper.md'), '# keeper\n');
  use(a);
  await withGitLockRetry(() => push());

  const b = await makeInstall('half-b', remote);
  sh(b.gitDir, b.domains, 'fetch origin -q');
  sh(b.gitDir, b.domains, 'checkout -q -b main origin/main');

  use(a);
  await rm(path.join(a.domains, 'half', 'CLAUDE.md'));
  await withGitLockRetry(() => push());

  use(b);
  const result = await withGitLockRetry(() => pull());

  assertTrue(existsSync(path.join(b.domains, 'half', 'wiki', 'keeper.md')),
    'a page under a schema-less folder survives — a partial delete is not a delete');
  assertEq(result.pruned.length, 0, 'and nothing is reported as removed');
  assertEq(await readOrMissing(path.join(b.domains, 'half', 'wiki', 'keeper.md')), '# keeper\n',
    'the surviving page is byte-identical');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n5. RULE 4 — a file written into the shell DURING the pull is kept, and reported\n');
// ═══════════════════════════════════════════════════════════════════════════
//
// pull() auto-commits before it merges, so by the time the prune runs almost
// nothing is untracked-and-unignored. The case that survives that is a write
// landing DURING the pull — the MCP server or an ingest in another process,
// which is exactly the concurrency this app has. Driven by calling the real
// prune directly with the real pre-merge baseline, because that is the only
// way to open that window deterministically.
{
  const remote = await makeBareRemote();
  const a = await makeInstall('race-a', remote);
  await seedDomain(a.domains, 'articles');
  await seedDomain(a.domains, 'doomed');
  use(a);
  await withGitLockRetry(() => push());

  const b = await makeInstall('race-b', remote);
  sh(b.gitDir, b.domains, 'fetch origin -q');
  sh(b.gitDir, b.domains, 'checkout -q -b main origin/main');

  use(a);
  await rm(path.join(a.domains, 'doomed'), { recursive: true, force: true });
  await withGitLockRetry(() => push());

  use(b);
  const preMergeHead = sh(b.gitDir, b.domains, 'rev-parse HEAD').trim();
  sh(b.gitDir, b.domains, 'pull --no-rebase -X theirs origin main -q');
  // The concurrent writer lands now, after the merge, before the prune.
  await mkdir(path.join(b.domains, 'doomed'), { recursive: true });
  await writeFile(path.join(b.domains, 'doomed', 'in-flight.md'), '# written mid-pull\n');

  const { pruned, keptLocalContent } = await T.pruneGhostDomainDirs(preMergeHead);

  assertEq(pruned.length, 0, 'nothing is deleted while a file nobody has pushed is sitting in it');
  assertEq(keptLocalContent.join(','), 'doomed', 'and the folder is REPORTED, not silently skipped');
  assertEq(await readOrMissing(path.join(b.domains, 'doomed', 'in-flight.md')), '# written mid-pull\n',
    'the mid-pull write survives byte-identical');

  // Anti-vacuity: the SAME fixture with the file removed does prune, so the
  // assertions above are measuring rule 4 and not a fixture that could never
  // have been pruned by anything.
  await rm(path.join(b.domains, 'doomed', 'in-flight.md'), { force: true });
  const second = await T.pruneGhostDomainDirs(preMergeHead);
  assertEq(second.pruned.join(','), 'doomed',
    'CONTROL: with the unpushed file gone, the same shell IS pruned — rule 4 is what kept it');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n5b. MECHANISM — through pull(), rule 4 hands its case to rule 3\n');
// ═══════════════════════════════════════════════════════════════════════════
//
// WHY THIS SECTION EXISTS, AND WHAT IT ADMITS. Mutation M7 — replacing
// pull()'s `prunedKept: keptLocalContent` with a literal `[]` — comes back
// GREEN, and it stays green deliberately rather than for want of trying.
// Building a fixture to red it turned up the reason: pull() COMMITS the
// tree twice, once before the merge ("Auto-save before sync") and once
// after it ("Sync hygiene cleanup"), and the second one runs `git add -A`
// immediately before the prune. So by the time the prune looks, anything
// the user left lying around is TRACKED, and rule 3 — not rule 4 — is what
// saves it. Rule 4's only live window is a write landing between that
// commit and the prune, i.e. the MCP server or an ingest in ANOTHER
// process. That window is real (section 5 drives it), it is a race, and a
// racing fixture in npm test would be flaky. A flaky suite is worse than an
// honest gap, so the gap is recorded here instead of papered over.
//
// The fixture below is the strongest deterministic thing available: a
// remote carrying an OLDER `.gitignore`, so the file is ignored when the
// auto-save commit runs and unignored by the time the merge finishes —
// which is exactly what a machine on an older release pushes. It proves the
// mechanism, and it proves the user's file survives either way.
{
  const remote = await makeBareRemote();
  const a = await makeInstall('wire-a', remote);
  await seedDomain(a.domains, 'articles');
  await seedDomain(a.domains, 'doomed');
  use(a);
  await withGitLockRetry(() => push());          // writes the canonical .gitignore

  const b = await makeInstall('wire-b', remote);
  sh(b.gitDir, b.domains, 'fetch origin -q');
  sh(b.gitDir, b.domains, 'checkout -q -b main origin/main');

  // A, on an older release: a .gitignore with no `*/raw/` rule, and the
  // domain deleted. Raw git, because push() would re-add the rule via
  // ensureDomainsGitignore().
  use(a);
  const gi = await readFile(path.join(a.domains, '.gitignore'), 'utf8');
  await writeFile(path.join(a.domains, '.gitignore'),
    gi.split('\n').filter(l => l.trim() !== '*/raw/').join('\n'));
  await rm(path.join(a.domains, 'doomed'), { recursive: true, force: true });
  sh(a.gitDir, a.domains, 'add -A');
  sh(a.gitDir, a.domains, 'commit -qm "older release: narrower gitignore + delete doomed"');
  sh(a.gitDir, a.domains, 'push -q origin main');

  use(b);
  await mkdir(path.join(b.domains, 'doomed', 'raw'), { recursive: true });
  await writeFile(path.join(b.domains, 'doomed', 'raw', 'paper.pdf'), 'the only copy');

  const result = await withGitLockRetry(() => pull());

  assertEq(await readOrMissing(path.join(b.domains, 'doomed', 'raw', 'paper.pdf')), 'the only copy',
    "THE POINT: the user's unpushed source file is still on disk, byte-identical");
  assertEq(result.pruned.length, 0, 'nothing was removed');
  assertTrue(trackedPaths(b).includes('doomed/raw/paper.pdf'),
    'MECHANISM: the hygiene commit tracked it first, so rule 3 is what kept the folder');
  assertEq((result.prunedKept || []).length, 0,
    'and rule 4 therefore reports nothing — this is the case M7 cannot red');
  assertTrue(Array.isArray(result.prunedKept),
    'the field is still on the wire, shaped as the renderer expects');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n6. FAIL-SAFE — an unusable baseline deletes nothing, and never reaches a shell\n');
// ═══════════════════════════════════════════════════════════════════════════
{
  const remote = await makeBareRemote();
  const a = await makeInstall('safe', remote);
  await seedDomain(a.domains, 'demo');
  await mkdir(path.join(a.domains, 'stray'), { recursive: true });
  await writeFile(path.join(a.domains, 'stray', 'x.md'), 'x\n');
  use(a);
  await withGitLockRetry(() => push());
  const fingerprint = await treeFingerprint(a.domains);

  for (const bad of [null, undefined, '', 'HEAD', 'main',
                     '$(rm -rf .)', 'abc; rm -rf /', '../../etc', 'ZZZZZZZ']) {
    const r = await T.pruneGhostDomainDirs(bad);
    assertTrue(r.pruned.length === 0 && r.keptLocalContent.length === 0,
      `a baseline of ${JSON.stringify(bad)} prunes nothing`);
  }
  assertEq(await treeFingerprint(a.domains), fingerprint,
    'the domains tree is byte-identical after every one of those calls');

  // THE INJECTION GATE, measured rather than asserted. `preMergeHead` is
  // interpolated into a shell command string by git(), so the regex is the
  // only thing between a caller's value and /bin/sh. A payload whose
  // execution is harmless but OBSERVABLE proves the gate is reached: with
  // the regex widened, the shell runs the substitution and the sentinel
  // appears. (Deliberately `touch` in a tempdir — no mutation of this file
  // should ever be able to make it destructive.)
  const sentinel = path.join(await tmp('sentinel'), 'pwned');
  const payload = '$(touch ' + sentinel + ')';
  const injected = await T.pruneGhostDomainDirs(payload);
  assertEq(injected.pruned.length, 0, 'a command-substitution payload prunes nothing');
  assertTrue(!existsSync(sentinel),
    'and never reaches a shell — the sentinel file the payload would create does not exist');

  // A syntactically valid but unknown commit id: the diff throws, and a
  // throw must mean "keep", never "sweep". Caught here rather than awaited
  // bare, so a mutation that lets the error escape reds on a named
  // assertion instead of crashing the run.
  let unknown;
  try {
    unknown = await T.pruneGhostDomainDirs('0000000000000000000000000000000000000000');
  } catch (err) {
    unknown = { pruned: ['<<THREW>>'], keptLocalContent: [], threw: String(err && err.message).slice(0, 80) };
  }
  assertTrue(!unknown.threw,
    `an unreadable baseline is absorbed, never raised into pull() — got ${unknown.threw || 'no throw'}`);
  assertEq(unknown.pruned.length, 0, 'an unknown commit id prunes nothing (the git call throws → keep)');
  assertEq(await treeFingerprint(a.domains), fingerprint,
    'and the tree is still byte-identical');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n7. topLevelSegments — NUL parsing, prefixes, and the shapes that must NOT match\n');
// ═══════════════════════════════════════════════════════════════════════════
{
  const seg = T.topLevelSegments;
  assertEq([...seg('a/b.md\0a/c.md\0d/e.md\0')].sort().join(','), 'a,d',
    'NUL-separated paths collapse to their top-level segment');
  assertEq([...seg('')].length, 0, 'empty output yields no segments');
  assertEq([...seg('café ñ/x.md\0')].join(','), 'café ñ',
    'a non-ASCII name with a space survives intact — this is why -z is used, not core.quotePath');
  assertEq([...seg('?? Attachments/\0?? b/c.md\0 M live/page.md\0', '?? ')].sort().join(','), 'Attachments,b',
    'the "?? " prefix selects untracked-not-ignored entries only');
  assertEq([...seg(' M live/page.md\0A  new/page.md\0', '?? ')].length, 0,
    'modified and added entries are NOT read as untracked');
  assertEq([...seg('R  old/p.md\0new/p.md\0', '?? ')].length, 0,
    "a rename's bare second chunk is ignored rather than misread as a path");
  assertEq([...seg('top.md\0')].join(','), 'top.md',
    'a root-level file yields itself — callers match it against directory names, so it is inert');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n8. THE WORDING — the sentence must be true of what actually happened\n');
// ═══════════════════════════════════════════════════════════════════════════
//
// "removed N deleted domains" was printed for whatever the prune deleted,
// and the prune's only test was "no CLAUDE.md". So the one sentence the user
// got about a recursive delete could be false about the only fact that
// mattered. Extracted and EXECUTED, not grepped — a source scan cannot tell
// a renderer that reads a field from one that merely mentions it.
{
  const src = await readFile(path.join(ROOT, 'src/public/next/views/sync.js'), 'utf8');
  const extractFn = (name) => {
    const start = src.search(new RegExp('(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function\\s+' + name + '\\s*\\('));
    if (start < 0) throw new Error(`views/sync.js: function ${name}() not found — renamed?`);
    const open = src.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    throw new Error(`views/sync.js: unbalanced braces extracting ${name}()`);
  };
  const extractConst = (name) => {
    const m = new RegExp('(?:^|\\n)const\\s+' + name + '\\s*=\\s*[^;\\n]+;').exec(src);
    if (!m) throw new Error(`views/sync.js: const ${name} not found`);
    return m[0];
  };
  const view = new Function(
    extractConst('PRUNED_NAMES_SHOWN') + '\n' +
    extractFn('fileCount') + '\n' +
    extractFn('nameList') + '\n' +
    extractFn('describePruned') + '\n' +
    extractFn('describePruneKept') + '\n' +
    extractFn('describeResult') + '\n' +
    'return { describeResult, describePruned, describePruneKept };'
  )();

  const one = view.describePruned(['ghost']);
  assertTrue(!/domain/i.test(one),
    `the pruned sentence never calls the folder a domain — got: ${one}`);
  assertTrue(one.includes('removed 1 folder deleted on another machine (ghost)'),
    `it says what is actually provable — got: ${one}`);
  assertTrue(view.describePruned(['a', 'b']).includes('removed 2 folders'),
    'plural agrees');
  assertEq(view.describePruned([]), null, 'nothing pruned prints nothing');

  const kept = view.describePruneKept(['Inbox']);
  assertTrue(kept.includes('kept 1 folder that still holds local files (Inbox)'),
    `the kept sentence names the folder and the reason — got: ${kept}`);
  assertTrue(view.describePruneKept(['a', 'b']).includes('kept 2 folders that still hold local files'),
    'plural agrees on the kept sentence too');
  assertEq(view.describePruneKept([]), null, 'nothing kept prints nothing');

  // The wire shapes the backend actually returns, through the real renderer.
  const pullMsg = view.describeResult('pull', {
    pulled: true, filesChanged: 4, pruned: ['ghost'], prunedKept: ['Inbox'],
  });
  assertTrue(pullMsg.includes('Pulled 4 files')
    && pullMsg.includes('removed 1 folder deleted on another machine (ghost)')
    && pullMsg.includes('kept 1 folder that still holds local files (Inbox)'),
    `pull-only reports all three facts — got: ${pullMsg}`);
  assertTrue(!/deleted domain/.test(pullMsg),
    `and never the old wording — got: ${pullMsg}`);

  const syncMsg = view.describeResult('sync', {
    pullResult: { pulled: true, filesChanged: 2, pruned: ['ghost'], prunedKept: ['Inbox'] },
    pushResult: { pushed: true, filesChanged: 1 },
  });
  assertTrue(syncMsg.includes('kept 1 folder that still holds local files (Inbox)'),
    `the bidirectional sentence carries the kept folders too — got: ${syncMsg}`);

  // A pull that did nothing still says so — the kept clause must not invent
  // activity when the arrays are absent (an /old-shaped payload).
  assertEq(view.describeResult('pull', { pulled: true, filesChanged: 0, pruned: [] }),
    'Already up to date — nothing new on GitHub.',
    'a payload with no prunedKept field at all is handled exactly as before');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n9. This suite touched none of the real installation\n');
// ═══════════════════════════════════════════════════════════════════════════
{
  const nowConfig = existsSync(getSyncConfigFile())
    ? createHash('sha256').update(readFileSync(getSyncConfigFile())).digest('hex') : null;
  assertEq(nowConfig, REAL.syncConfig, 'the real .sync-config.json is byte-identical');
  assertEq(existsSync(getSyncGitDir()), REAL.syncGitExists,
    'the real .knowledge-git was neither created nor removed');
  const nowDomains = existsSync(getDefaultDomainsDir())
    ? await treeFingerprint(getDefaultDomainsDir()) : null;
  assertEq(nowDomains, REAL.domainsFingerprint, 'the real domains/ tree is byte-identical');
}

} finally {
  __setSyncTestOverrides({ gitDir: null, configFile: null });
  __setDomainsDirOverride(null);
  for (const d of cleanupDirs) {
    try { await rm(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

console.log('\n=== Result ===');
console.log(`  ${passed} passed, ${failed} failed (${passed + failed} total)`);
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.label}${f.detail ? `\n      ${f.detail}` : ''}`);
}
process.exit(failed ? 1 : 0);
