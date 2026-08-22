#!/usr/bin/env node
/**
 * test-sync-hygiene.js — OFFLINE battle test for the sync-hygiene bundle:
 *
 *   1. `.DS_Store` tracked by the knowledge repo (new: DOMAINS_GITIGNORE_RULES
 *      rule + untrackStaleDSStore(), mirroring the v3.0.15 `.write-lock` fix).
 *   2. Local stale `.write-lock` FILES (not just git tracking) are cleared —
 *      new `clearStaleLock()` in write-registry.js + cleanupStaleLocalLocks()
 *      in sync.js, wired into both push() and pull().
 *   3. pull() is now symmetric with push() — a pull-only machine self-heals
 *      (ensureDomainsGitignore + untrack + cleanup all run from pull() too,
 *      not just push()).
 *   4. Non-ASCII domain names no longer silently skip the untrack — `git
 *      ls-files -z` sidesteps git's default C-quoting of non-ASCII paths.
 *
 * Post-ship adversarial audit found and this suite now also covers:
 *   5. HIGH — pull() used to untrack (`git rm --cached`) BEFORE merging,
 *      which leaves the file on disk as untracked; if origin's incoming
 *      tree still carries it as TRACKED, git's merge preflight refuses to
 *      clobber the untracked file ("untracked working tree files would be
 *      overwritten by merge... Aborting") — a hard, non-retryable pull
 *      failure, reproduced here with two real machines sharing a bare
 *      remote. Fixed by moving the untrack to AFTER a successful merge, plus
 *      an automatic recovery path (recoverHygieneMergeConflict) for the
 *      residual mixed-fleet-transition exposure — gated so it NEVER touches
 *      a conflict involving anything other than our own .write-lock/
 *      .DS_Store junk.
 *   6. LOW — git pathspec-magic characters (`:` `!` `*` `?` `[` `]`) were
 *      still permitted in a path segment, so a domain literally named
 *      `:!x` (legal per createDomain) could turn `git rm --cached` into an
 *      EXCLUDE pathspec instead of a literal delete.
 *   7. MEDIUM/LOW — clearStaleLock()'s read→check→unlink sequence had a
 *      TOCTOU window where a racing process's brand-new fresh lock could be
 *      deleted instead of the dead one that was actually inspected.
 *
 * `untrackStaleWriteLocks()` shipped in v3.0.15 with ZERO test coverage —
 * this suite covers its pre-existing behaviour (section 2) as well as every
 * new addition, using REAL temporary git repositories (never mocks) — the
 * same validation style the v3.0.15 work itself used ("H1 reproduced against
 * real git before the fix and confirmed resolved after").
 *
 * Isolation: every git repo, "remote", and domains directory here lives
 * under os.tmpdir(). sync.js's GIT_DIR/CONFIG_FILE and config.js's
 * getDomainsDir() are redirected via __setSyncTestOverrides() /
 * __setDomainsDirOverride() — the ONLY way to exercise sync.js's git-facing
 * functions without touching this machine's REAL .knowledge-git/
 * .sync-config.json/domains — those are never referenced pointed at by this
 * suite. Every override is reset in a top-level `finally` so a failure
 * midway can't leave a later suite (or the real app) pointed at a stale
 * tempdir path.
 *
 * Pure offline: no network, no LLM/API key, no GitHub — the "remote" is a
 * local `git init --bare` repository.
 *
 * Run: node scripts/test-sync-hygiene.js
 * Exit code 0 if all green; non-zero on any failure.
 */

import { execSync } from 'child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import {
  __setSyncTestOverrides,
  push,
  pull,
  isConfigured,
  friendlyError,
  __testing as syncTesting,
} from '../src/brain/sync.js';
import { __setDomainsDirOverride, getDomainsDir } from '../src/brain/config.js';
import {
  acquireFileLock,
  isFileLocked,
  clearStaleLock,
  __testing as registryTesting,
} from '../src/brain/write-registry.js';

const {
  isSafePathSegment,
  isSafeTrackedPath,
  untrackStaleWriteLocks,
  untrackStaleDSStore,
  cleanupStaleLocalLocks,
  ensureDomainsGitignore,
  DOMAINS_GITIGNORE_RULES,
  recoverHygieneMergeConflict,
  isHygieneJunkPath,
  extractUntrackedOverwritePaths,
} = syncTesting;
const { LOCK_STALE_MS } = registryTesting;

let passed = 0;
let failed = 0;
const failures = [];

function ok(label) {
  passed++;
  console.log(`  ✓ ${label}`);
}
function fail(label, detail) {
  failed++;
  failures.push({ label, detail });
  console.log(`  ✗ ${label}`);
  if (detail) console.log(`    └─ ${detail}`);
}
function assertEq(actual, expected, label) {
  if (actual === expected) return ok(label);
  fail(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function assertTrue(cond, label, detail) {
  if (cond) return ok(label);
  fail(label, detail);
}

console.log('\n=== sync-hygiene battle test (.DS_Store / .write-lock / non-ASCII domains) ===\n');

// ── Test harness: real temp git repos ───────────────────────────────────────

async function mktemp(prefix) {
  return mkdtemp(path.join(tmpdir(), prefix));
}

// Git's own transient lock-contention failure — "Unable to create
// '.../index.lock': File exists" (or the friendlier wording git prints when
// it detects a live PID holding it: "Another git process seems to be running
// in this repository"). This is a REAL, if rare, failure mode of any git
// invocation racing another on the SAME repo under heavy scheduling
// contention. It is the ONLY error shape either retry helper below reacts
// to — anything else (a real assertion failure, a genuine merge conflict,
// any error from our own code) propagates on the very first attempt,
// unmodified. This is intentionally narrow: a blanket "retry on any
// failure" would hide a real bug instead of tolerating a known-transient one.
const TRANSIENT_GIT_LOCK_RE = /(?:[\\/][\w.-]*\.lock['"]?:\s*File exists)|(?:Another git process seems to be running)/i;

function sleepMsSync(ms) {
  // A tiny synchronous backoff for the synchronous sh() helper below —
  // avoids restructuring every one of its ~60 call sites to async/await
  // just for a rare retry path. `sleep` is present on both macOS and Linux.
  execSync(`sleep ${(ms / 1000).toFixed(3)}`);
}

function sh(gitDir, workTree, cmd, { retries = 3, delayMs = 150 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      execSync(`git --git-dir="${gitDir}" --work-tree="${workTree}" ${cmd}`, { stdio: 'pipe' });
      return;
    } catch (err) {
      const detail = `${err.message || ''} ${err.stderr ? err.stderr.toString('utf8') : ''}`;
      if (attempt < retries && TRANSIENT_GIT_LOCK_RE.test(detail)) {
        sleepMsSync(delayMs * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Narrowly-scoped retry for the exported push()/pull() functions — see
 * TRANSIENT_GIT_LOCK_RE above for exactly what it reacts to. Retrying the
 * WHOLE call (rather than some inner step) is safe here because push()/
 * pull() are themselves designed to be safely re-callable (the "nothing to
 * commit" guards, the aheadCount short-circuit, etc.) — this mirrors
 * exactly what a real user would do by clicking Sync again.
 */
async function withGitLockRetry(fn, { retries = 2, delayMs = 200 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt < retries && TRANSIENT_GIT_LOCK_RE.test(err.message || '')) {
        await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Repo-local git config that makes EVERY invocation against this repo —
 * ours via sh(), and sync.js's own via its internal git() helper (which we
 * cannot inject per-call flags into) — independent of the developer
 * machine's ambient/global git config:
 *   - user.email/user.name: identity, so a commit never falls back to
 *     global config (or fails outright if none is set anywhere).
 *   - commit.gpgsign/tag.gpgsign: a global commit.gpgsign=true (common for
 *     contributors who sign commits) would make EVERY commit in this suite
 *     try to invoke gpg/an ssh-agent for a signature — unrelated to what
 *     this suite tests, and a real hang/slowdown risk under the exact kind
 *     of CPU/IO contention this suite is being hardened against (an agent
 *     round-trip competing for scheduling with everything else).
 *   - core.autocrlf: keeps file-content assertions independent of line-
 *     ending conversion.
 * All of this is written to .git/config (not passed as a one-off `-c`
 * flag), so it's inherited by every later invocation against this specific
 * repo no matter which code issues it.
 */
function configureRepoIdentity(gitDir, domainsDir, { email = 'test@test', name = 'Test' } = {}) {
  sh(gitDir, domainsDir, `config user.email "${email}"`);
  sh(gitDir, domainsDir, `config user.name "${name}"`);
  sh(gitDir, domainsDir, 'config commit.gpgsign false');
  sh(gitDir, domainsDir, 'config tag.gpgsign false');
  sh(gitDir, domainsDir, 'config core.autocrlf false');
}

/** Create + initialise a repo with `origin` pointed at `remoteDir` (a local
 *  bare repo). Mirrors what setup() produces, without needing an HTTPS
 *  token — a local path remote needs none. */
async function initRepo(gitDir, domainsDir, remoteDir) {
  await mkdir(domainsDir, { recursive: true });
  sh(gitDir, domainsDir, 'init -q -b main');
  configureRepoIdentity(gitDir, domainsDir, { email: 'test@test', name: 'Test' });
  sh(gitDir, domainsDir, `remote add origin "${remoteDir}"`);
}

async function makeBareRemote() {
  const dir = await mktempTracked('sh-bare-remote-');
  execSync(`git init -q --bare "${dir}"`);
  return dir;
}

async function writeConfig(configPath, repoUrl) {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify({ repoUrl, token: '' }));
}

function trackedFiles(gitDir, domainsDir) {
  // core.quotePath=false so a non-ASCII assertion can compare the raw name
  // directly instead of the C-quoted octal-escaped form.
  const out = execSync(
    `git -c core.quotePath=false --git-dir="${gitDir}" --work-tree="${domainsDir}" ls-files`
  ).toString('utf8');
  return out.split('\n').filter(Boolean);
}

/** Seed a minimal valid domain (CLAUDE.md + a wiki page) so push()/pull()
 *  always have real, non-hygiene content to work with. */
async function seedDomain(domainsDir, slug) {
  await mkdir(path.join(domainsDir, slug, 'wiki'), { recursive: true });
  await writeFile(path.join(domainsDir, slug, 'CLAUDE.md'), '# schema\n');
  await writeFile(path.join(domainsDir, slug, 'wiki', 'index.md'), '# index\n');
}

// Track every tempdir this run creates so a final sweep can clean up even if
// an assertion throws mid-scenario.
const cleanupDirs = [];
async function mktempTracked(prefix) {
  const d = await mktemp(prefix);
  cleanupDirs.push(d);
  return d;
}

try {
  // ── 0. Unit tests — isSafePathSegment / isSafeTrackedPath ─────────────────
  console.log('0. Path-safety validators (isSafePathSegment / isSafeTrackedPath)\n');
  {
    // isSafePathSegment
    assertTrue(isSafePathSegment('articles'), 'plain ASCII segment is safe');
    assertTrue(isSafePathSegment('café'), 'non-ASCII segment is safe (domain slugs are not ASCII-restricted)');
    assertTrue(isSafePathSegment('my_domain-2'), 'underscore/hyphen/digit segment is safe');
    assertTrue(!isSafePathSegment(''), 'empty segment is unsafe');
    assertTrue(!isSafePathSegment('.'), '"." segment is unsafe');
    assertTrue(!isSafePathSegment('..'), '".." segment is unsafe (traversal)');
    assertTrue(!isSafePathSegment('a/b'), 'segment containing "/" is unsafe');
    assertTrue(!isSafePathSegment('a\\b'), 'segment containing "\\\\" is unsafe');
    assertTrue(!isSafePathSegment('a"b'), 'segment containing a double quote is unsafe');
    assertTrue(!isSafePathSegment("a'b"), 'segment containing a single quote is unsafe');
    assertTrue(!isSafePathSegment('a`b'), 'segment containing a backtick is unsafe');
    assertTrue(!isSafePathSegment('a$b'), 'segment containing "$" is unsafe');
    assertTrue(!isSafePathSegment('a;b'), 'segment containing ";" is unsafe');
    assertTrue(!isSafePathSegment('a|b'), 'segment containing "|" is unsafe');
    assertTrue(!isSafePathSegment('a&b'), 'segment containing "&" is unsafe');
    assertTrue(!isSafePathSegment('a\nb'), 'segment containing a newline is unsafe');
    assertTrue(!isSafePathSegment('a\x00b'), 'segment containing a NUL byte is unsafe');

    // git PATHSPEC-MAGIC characters (audit Finding 2, HIGH-severity-adjacent):
    // createDomain() only rejects '..', '/', '\\', and a leading '.', so a
    // domain literally named ":!x" is a LEGAL filesystem name — but git's
    // default pathspec parser reads a leading ':' as introducing magic
    // (":!"/"^" = an EXCLUDE pathspec) and '*'/'?'/'[' as glob wildcards even
    // without explicit :(glob) magic, which would turn "delete this literal
    // path" into something else entirely.
    assertTrue(!isSafePathSegment(':!x'), 'a segment shaped like ":(exclude)" pathspec magic (":!x") is unsafe');
    assertTrue(!isSafePathSegment(':x'), 'a segment starting with a bare ":" is unsafe');
    assertTrue(!isSafePathSegment('a*b'), 'a segment containing a glob "*" wildcard character is unsafe');
    assertTrue(!isSafePathSegment('a?b'), 'a segment containing a glob "?" wildcard character is unsafe');
    assertTrue(!isSafePathSegment('a[b]c'), 'a segment containing glob "[" "]" character-class characters is unsafe');
    assertTrue(!isSafePathSegment('a!b'), 'a segment containing a bare "!" is unsafe (defense in depth for ":^"/":!" forms)');
    // Non-ASCII support must survive the broadened denylist (the whole point
    // of Finding 2 was NOT to regress back to an ASCII-only allowlist).
    assertTrue(isSafePathSegment('café'), 'non-ASCII segment is still safe after the pathspec-magic denylist addition');
    assertTrue(isSafePathSegment('日本語'), 'a fully non-Latin segment is still safe');

    // isSafeTrackedPath — .write-lock requires EXACTLY one directory segment
    assertTrue(isSafeTrackedPath('articles/.write-lock', '.write-lock', 1),
      'articles/.write-lock matches exactDepth=1');
    assertTrue(!isSafeTrackedPath('articles/sub/.write-lock', '.write-lock', 1),
      'a two-level path is rejected when exactDepth=1');
    assertTrue(!isSafeTrackedPath('.write-lock', '.write-lock', 1),
      'a root-level (zero-segment) path is rejected when exactDepth=1');
    assertTrue(!isSafeTrackedPath('articles/.write-lock', '.other-name', 1),
      'wrong final filename is rejected');
    assertTrue(!isSafeTrackedPath('evil$(rm)/.write-lock', '.write-lock', 1),
      'a domain segment with shell metacharacters is rejected');
    assertTrue(!isSafeTrackedPath('../.write-lock', '.write-lock', 1),
      'a ".." traversal segment is rejected');

    // isSafeTrackedPath — .DS_Store allows any depth (exactDepth: null)
    assertTrue(isSafeTrackedPath('.DS_Store', '.DS_Store', null), 'root-level .DS_Store is safe at any depth');
    assertTrue(isSafeTrackedPath('articles/.DS_Store', '.DS_Store', null), 'one-level .DS_Store is safe at any depth');
    assertTrue(isSafeTrackedPath('articles/wiki/.DS_Store', '.DS_Store', null), 'two-level .DS_Store is safe at any depth');
    assertTrue(!isSafeTrackedPath('articles/../.DS_Store', '.DS_Store', null),
      'a ".." segment anywhere in a .DS_Store path is rejected regardless of depth');
    assertTrue(!isSafeTrackedPath(null, '.DS_Store', null), 'non-string input is rejected');
    assertTrue(!isSafeTrackedPath('', '.DS_Store', null), 'empty string input is rejected');
  }

  // ── 0b. DOMAINS_GITIGNORE_RULES content ────────────────────────────────────
  console.log('\n0b. DOMAINS_GITIGNORE_RULES contains the expected rules\n');
  {
    assertTrue(DOMAINS_GITIGNORE_RULES.includes('*/.write-lock'), 'rules include */.write-lock');
    assertTrue(DOMAINS_GITIGNORE_RULES.includes('.DS_Store'), 'rules include .DS_Store (new)');
    assertTrue(DOMAINS_GITIGNORE_RULES.includes('*/raw/'), 'rules still include */raw/ (pre-existing, unaffected)');
    assertTrue(DOMAINS_GITIGNORE_RULES.includes('*/.mcp-write-log.jsonl'), 'rules still include the MCP audit-log pattern');
  }

  // ── 1. untrackStaleWriteLocks() — pre-existing behaviour (v3.0.15, previously untested) ──
  console.log('\n1. untrackStaleWriteLocks() — real git repo, one committed stale lock\n');
  {
    const gitDir = await mktempTracked('sh-gitdir-1-');
    const domainsDir = await mktempTracked('sh-domains-1-');
    const remoteDir = await mktempTracked('sh-remote-1-');
    await initRepo(gitDir, domainsDir, remoteDir);
    await seedDomain(domainsDir, 'articles');
    await writeFile(path.join(domainsDir, 'articles', '.write-lock'), JSON.stringify({ pid: 999999, startedAt: 1 }));
    sh(gitDir, domainsDir, 'add -A');
    sh(gitDir, domainsDir, '-c user.email=t@t -c user.name=t commit -q -m seed');

    assertTrue(trackedFiles(gitDir, domainsDir).includes('articles/.write-lock'),
      'precondition: .write-lock is tracked before untrack runs');

    __setSyncTestOverrides({ gitDir, configFile: path.join(domainsDir, '..', 'unused-config.json') });
    __setDomainsDirOverride(domainsDir);
    const untracked = await untrackStaleWriteLocks();
    assertTrue(untracked.includes('articles/.write-lock'), 'untrackStaleWriteLocks() reports the path it untracked');

    const after = trackedFiles(gitDir, domainsDir);
    assertTrue(!after.includes('articles/.write-lock'), '.write-lock is no longer tracked after untrack');
    assertTrue(existsSync(path.join(domainsDir, 'articles', '.write-lock')),
      '`git rm --cached` leaves the file itself on disk (only the index entry is removed)');
  }

  // ── 2. untrackStaleDSStore() — root, one-level, and two-level depth ────────
  console.log('\n2. untrackStaleDSStore() — root / one-level / two-level committed .DS_Store files\n');
  {
    const gitDir = await mktempTracked('sh-gitdir-2-');
    const domainsDir = await mktempTracked('sh-domains-2-');
    const remoteDir = await mktempTracked('sh-remote-2-');
    await initRepo(gitDir, domainsDir, remoteDir);
    await seedDomain(domainsDir, 'articles');
    // Exactly the three real-world paths reported: domains/.DS_Store,
    // domains/articles/.DS_Store, domains/articles/wiki/.DS_Store.
    await writeFile(path.join(domainsDir, '.DS_Store'), 'ds');
    await writeFile(path.join(domainsDir, 'articles', '.DS_Store'), 'ds');
    await writeFile(path.join(domainsDir, 'articles', 'wiki', '.DS_Store'), 'ds');
    sh(gitDir, domainsDir, 'add -A');
    sh(gitDir, domainsDir, '-c user.email=t@t -c user.name=t commit -q -m seed');

    const before = trackedFiles(gitDir, domainsDir);
    assertTrue(before.includes('.DS_Store') && before.includes('articles/.DS_Store') && before.includes('articles/wiki/.DS_Store'),
      'precondition: all three .DS_Store depths are tracked before untrack runs');

    __setSyncTestOverrides({ gitDir, configFile: path.join(domainsDir, '..', 'unused-config.json') });
    __setDomainsDirOverride(domainsDir);
    const untracked = await untrackStaleDSStore();
    assertEq(untracked.length, 3, 'untrackStaleDSStore() untracks all three depths in one pass');

    const after = trackedFiles(gitDir, domainsDir);
    assertTrue(!after.includes('.DS_Store'), 'root-level .DS_Store is no longer tracked');
    assertTrue(!after.includes('articles/.DS_Store'), 'one-level .DS_Store is no longer tracked');
    assertTrue(!after.includes('articles/wiki/.DS_Store'), 'two-level .DS_Store is no longer tracked');
    assertTrue(after.includes('articles/CLAUDE.md'), 'real domain content is untouched');
  }

  // ── 3. Non-ASCII domain names (item 4: the real fix, not a documented limitation) ──
  console.log('\n3. Non-ASCII domain name — untrack still works (git ls-files -z)\n');
  {
    const gitDir = await mktempTracked('sh-gitdir-3-');
    const domainsDir = await mktempTracked('sh-domains-3-');
    const remoteDir = await mktempTracked('sh-remote-3-');
    await initRepo(gitDir, domainsDir, remoteDir);
    const domain = 'café'; // non-ASCII — createDomain() only rejects '..', '/', '\\', leading '.'
    await seedDomain(domainsDir, domain);
    await writeFile(path.join(domainsDir, domain, '.write-lock'), JSON.stringify({ pid: 999999, startedAt: 1 }));
    await writeFile(path.join(domainsDir, domain, 'wiki', '.DS_Store'), 'ds');
    sh(gitDir, domainsDir, 'add -A');
    sh(gitDir, domainsDir, '-c user.email=t@t -c user.name=t commit -q -m seed');

    // Confirm git's DEFAULT mode really does C-quote this path — the exact
    // condition that defeated the pre-fix ASCII-only regex.
    const defaultModeOut = execSync(`git --git-dir="${gitDir}" --work-tree="${domainsDir}" ls-files -- "*/.write-lock"`).toString('utf8');
    assertTrue(defaultModeOut.startsWith('"') && defaultModeOut.includes('\\303\\251'),
      'sanity check: without -z, git C-quotes the non-ASCII path (proves the bug this fixes is real)');

    __setSyncTestOverrides({ gitDir, configFile: path.join(domainsDir, '..', 'unused-config.json') });
    __setDomainsDirOverride(domainsDir);
    const lockUntracked = await untrackStaleWriteLocks();
    const dsUntracked = await untrackStaleDSStore();
    assertTrue(lockUntracked.includes(`${domain}/.write-lock`), 'non-ASCII domain .write-lock is untracked by name');
    assertTrue(dsUntracked.includes(`${domain}/wiki/.DS_Store`), 'non-ASCII domain nested .DS_Store is untracked by name');

    const after = trackedFiles(gitDir, domainsDir);
    assertTrue(!after.some(f => f.includes('.write-lock')), 'no .write-lock remains tracked for the non-ASCII domain');
    assertTrue(!after.some(f => f.includes('.DS_Store')), 'no .DS_Store remains tracked for the non-ASCII domain');
    assertTrue(after.includes(`${domain}/CLAUDE.md`), 'the non-ASCII domain\'s real content is untouched and still tracked');
  }

  // ── 4. Security: a shell-metacharacter directory name is left untouched ───
  console.log('\n4. Security — a shell-metacharacter-laden "domain" is never acted on\n');
  {
    const gitDir = await mktempTracked('sh-gitdir-4-');
    const domainsDir = await mktempTracked('sh-domains-4-');
    const remoteDir = await mktempTracked('sh-remote-4-');
    await initRepo(gitDir, domainsDir, remoteDir);
    const markerFile = path.join(tmpdir(), `sync-hygiene-pwned-${process.pid}`);
    const evilDir = `evil$(touch ${markerFile})\`touch ${markerFile}2\`;x`;
    await mkdir(path.join(domainsDir, evilDir), { recursive: true });
    await writeFile(path.join(domainsDir, evilDir, '.write-lock'), JSON.stringify({ pid: 999999, startedAt: 1 }));
    sh(gitDir, domainsDir, 'add -A');
    sh(gitDir, domainsDir, '-c user.email=t@t -c user.name=t commit -q -m seed');

    __setSyncTestOverrides({ gitDir, configFile: path.join(domainsDir, '..', 'unused-config.json') });
    __setDomainsDirOverride(domainsDir);
    const untracked = await untrackStaleWriteLocks();
    assertTrue(untracked.length === 0, 'the malicious-shaped path is not reported as untracked');

    const after = trackedFiles(gitDir, domainsDir);
    assertTrue(after.some(f => f.endsWith('.write-lock')), 'the file is left tracked (safe fallback: skip, never act on an unsafe shape)');
    assertTrue(!existsSync(markerFile) && !existsSync(`${markerFile}2`),
      'no shell injection occurred — neither marker file was created');
    // Clean up in case something unexpectedly did create them
    try { await rm(markerFile, { force: true }); } catch {}
    try { await rm(`${markerFile}2`, { force: true }); } catch {}
  }

  // ── 4b. Security (Finding 2): git pathspec-magic-shaped domain names ──────
  console.log('\n4b. Security — a pathspec-magic-shaped domain (":!x") is safely skipped, never mis-executed\n');
  {
    const gitDir = await mktempTracked('sh-gitdir-4b-');
    const domainsDir = await mktempTracked('sh-domains-4b-');
    const remoteDir = await mktempTracked('sh-remote-4b-');
    await initRepo(gitDir, domainsDir, remoteDir);
    // ":!x" is a LEGAL filesystem/domain name (createDomain only rejects
    // '..', '/', '\\', and a leading '.') but git's default pathspec parser
    // reads a leading ':' as introducing magic (":!" = an EXCLUDE pathspec)
    // — exactly the adversarial-audit finding.
    const magicDir = ':!x';
    await mkdir(path.join(domainsDir, magicDir), { recursive: true });
    await writeFile(path.join(domainsDir, magicDir, '.write-lock'), JSON.stringify({ pid: 999999, startedAt: 1 }));
    await writeFile(path.join(domainsDir, magicDir, '.DS_Store'), 'ds');
    sh(gitDir, domainsDir, 'add -A');
    sh(gitDir, domainsDir, '-c user.email=t@t -c user.name=t commit -q -m seed');

    __setSyncTestOverrides({ gitDir, configFile: path.join(domainsDir, '..', 'unused-config.json') });
    __setDomainsDirOverride(domainsDir);
    const lockUntracked = await untrackStaleWriteLocks();
    const dsUntracked = await untrackStaleDSStore();
    assertTrue(lockUntracked.length === 0, 'the ":!x" domain\'s .write-lock is never reported as untracked (rejected before any git command is built)');
    assertTrue(dsUntracked.length === 0, 'the ":!x" domain\'s .DS_Store is never reported as untracked either');

    const after = trackedFiles(gitDir, domainsDir);
    assertTrue(after.some(f => f.endsWith('.write-lock')) && after.some(f => f.endsWith('.DS_Store')),
      'both files are left safely tracked (never silently no-op\'d against the wrong target)');
  }

  // ── 4c. --literal-pathspecs itself correctly neutralises pathspec magic ──
  console.log('\n4c. --literal-pathspecs (defense layer 2) correctly treats ":!x/..." as a literal path\n');
  {
    const gitDir = await mktempTracked('sh-gitdir-4c-');
    const domainsDir = await mktempTracked('sh-domains-4c-');
    await mkdir(path.join(domainsDir, ':!x'), { recursive: true });
    await writeFile(path.join(domainsDir, ':!x', '.write-lock'), 'x');
    sh(gitDir, domainsDir, 'init -q -b main');
    configureRepoIdentity(gitDir, domainsDir, { email: 't@t', name: 't' });
    sh(gitDir, domainsDir, 'add -A');
    sh(gitDir, domainsDir, 'commit -q -m seed');
    assertTrue(trackedFiles(gitDir, domainsDir).includes(':!x/.write-lock'), 'precondition: the magic-shaped path is tracked');

    // Without --literal-pathspecs, git's default parser treats the leading
    // ':' as magic — this is the DEFECT shape the audit found. Depending on
    // exact git version this either errors outright (the auditor's own
    // "fatal: not removing '.' recursively without -r" — reproduced here) or
    // silently matches nothing; EITHER way it never removes the literal
    // file, which is the property this assertion checks.
    let defectThrew = false;
    let defectMessage = '';
    try {
      execSync(`git --git-dir="${gitDir}" --work-tree="${domainsDir}" rm --cached --ignore-unmatch -- ":!x/.write-lock"`, { stdio: 'pipe' });
    } catch (e) {
      defectThrew = true;
      defectMessage = e.stderr ? e.stderr.toString('utf8') : e.message;
    }
    assertTrue(defectThrew && /not removing|pathspec/.test(defectMessage),
      'WITHOUT --literal-pathspecs, git itself refuses/errors on the magic-shaped pathspec (reproduces the auditor\'s exact "not removing \'.\' recursively without -r")');
    assertTrue(trackedFiles(gitDir, domainsDir).includes(':!x/.write-lock'),
      'WITHOUT --literal-pathspecs, the magic-shaped pathspec does NOT remove the literal file (proves the defect is real)');

    // WITH --literal-pathspecs, the exact same string is now treated as a
    // literal path and correctly removes it.
    execSync(`git --git-dir="${gitDir}" --work-tree="${domainsDir}" --literal-pathspecs rm --cached --ignore-unmatch -- ":!x/.write-lock"`, { stdio: 'pipe' });
    assertTrue(!trackedFiles(gitDir, domainsDir).includes(':!x/.write-lock'),
      'WITH --literal-pathspecs, the same string correctly removes the literal file');
  }

  // ── 5. clearStaleLock() — unit tests against write-registry.js's own rule ──
  console.log('\n5. clearStaleLock() — stale-by-age / stale-by-dead-pid / unparseable / fresh-preserved\n');
  {
    const dir = await mktempTracked('sh-lockdir-5-');
    await mkdir(dir, { recursive: true });

    assertEq(await clearStaleLock(dir), false, 'no lock file present → false, no-op');

    // Stale by age
    await writeFile(path.join(dir, '.write-lock'), JSON.stringify({
      pid: process.pid, startedAt: Date.now() - (LOCK_STALE_MS + 60_000),
    }));
    assertEq(await clearStaleLock(dir), true, 'a lock older than LOCK_STALE_MS is cleared');
    assertTrue(!existsSync(path.join(dir, '.write-lock')), 'the stale-by-age lock file is actually removed');

    // Stale by dead PID (very unlikely to be a real running process)
    await writeFile(path.join(dir, '.write-lock'), JSON.stringify({ pid: 999999, startedAt: Date.now() }));
    assertEq(await clearStaleLock(dir), true, 'a lock with a dead PID is cleared even though it is fresh by age');
    assertTrue(!existsSync(path.join(dir, '.write-lock')), 'the stale-by-dead-pid lock file is actually removed');

    // Unparseable
    await writeFile(path.join(dir, '.write-lock'), 'not valid json{{{');
    assertEq(await clearStaleLock(dir), true, 'an unparseable lock file is treated as stale and cleared');

    // Fresh: current process's own PID (alive) and recent timestamp — must NEVER be touched
    await writeFile(path.join(dir, '.write-lock'), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    assertEq(await clearStaleLock(dir), false, 'a fresh lock (live PID, recent timestamp) is left alone');
    assertTrue(existsSync(path.join(dir, '.write-lock')), 'the fresh lock file still exists on disk');
    await rm(path.join(dir, '.write-lock'), { force: true });

    // Same rule via the real acquireFileLock() helper — round-trip sanity
    const release = await acquireFileLock(dir, { op: 'test' });
    assertTrue(typeof release === 'function', 'acquireFileLock succeeds (sanity)');
    assertEq(await clearStaleLock(dir), false, 'clearStaleLock never touches a lock acquireFileLock() itself just created');
    await release();
  }

  // ── 5b. clearStaleLock() TOCTOU guard (Finding 3) ──────────────────────────
  console.log('\n5b. clearStaleLock() TOCTOU guard — a lock that changes mid-check is never deleted\n');
  {
    const dir = await mktempTracked('sh-lockdir-5b-');
    await mkdir(dir, { recursive: true });
    const lockFile = path.join(dir, '.write-lock');

    // Scenario: clearStaleLock reads a genuinely stale lock, but BEFORE it
    // unlinks, a separate process (the MCP child process in real life) races
    // in, independently judges the SAME lock stale via its OWN
    // acquireFileLock(), clears it, and writes a brand-new FRESH lock in its
    // place. The __onBeforeRecheck test hook fires at exactly that point —
    // right after the staleness verdict, right before the recheck read.
    await writeFile(lockFile, JSON.stringify({ pid: 999999, startedAt: Date.now() - (LOCK_STALE_MS + 1000) }));
    let hookRan = false;
    const result = await clearStaleLock(dir, {
      __onBeforeRecheck: async () => {
        hookRan = true;
        // Simulate the racing process: a brand-new, definitely-live lock.
        await writeFile(lockFile, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
      },
    });
    assertTrue(hookRan, 'the test hook actually fired (sanity — otherwise this test proves nothing)');
    assertEq(result, false, 'clearStaleLock returns false when the lock changed underneath it (does NOT delete the racer\'s fresh lock)');
    assertTrue(existsSync(lockFile), 'the fresh (racer\'s) lock file still exists on disk — the double-writer corruption this test targets is prevented');
    const survivingContent = JSON.parse(await readFile(lockFile, 'utf8'));
    assertEq(survivingContent.pid, process.pid, 'the SURVIVING lock content is the racer\'s fresh one, not partially-deleted or corrupted');
    await rm(lockFile, { force: true });

    // Negative control: the SAME hook fires but does NOT modify the file —
    // clearStaleLock must still complete the deletion normally, proving the
    // guard only blocks on an ACTUAL change, not on the hook's mere presence.
    await writeFile(lockFile, JSON.stringify({ pid: 999999, startedAt: Date.now() - (LOCK_STALE_MS + 1000) }));
    let noopHookRan = false;
    const result2 = await clearStaleLock(dir, { __onBeforeRecheck: async () => { noopHookRan = true; } });
    assertTrue(noopHookRan, 'the no-op hook fired');
    assertEq(result2, true, 'clearStaleLock still deletes a genuinely stale lock when nothing changed between the two reads');
    assertTrue(!existsSync(lockFile), 'the lock file is actually gone in the unchanged-content case');

    // Also: if the racer DELETES the file entirely (rather than replacing
    // it) between our two reads, we must not throw — just decline.
    await writeFile(lockFile, JSON.stringify({ pid: 999999, startedAt: Date.now() - (LOCK_STALE_MS + 1000) }));
    const result3 = await clearStaleLock(dir, {
      __onBeforeRecheck: async () => { await rm(lockFile, { force: true }); },
    });
    assertEq(result3, false, 'clearStaleLock declines gracefully (no throw) when the racer deleted the file entirely before the recheck');

    // Production callers (cleanupStaleLocalLocks, and clearStaleLock called
    // with no opts at all) must behave EXACTLY as before — the hook is
    // opt-in and inert by default.
    await writeFile(lockFile, JSON.stringify({ pid: 999999, startedAt: Date.now() - (LOCK_STALE_MS + 1000) }));
    assertEq(await clearStaleLock(dir), true, 'clearStaleLock(dir) with no opts (the real call shape) is unaffected by the new parameter — still clears a stale lock');
  }

  // ── 6. cleanupStaleLocalLocks() — scans every domain dir, uses the same rule ──
  console.log('\n6. cleanupStaleLocalLocks() — sync.js wrapper over multiple domains\n');
  {
    const domainsDir = await mktempTracked('sh-domains-6-');
    await mkdir(path.join(domainsDir, 'stale-domain'), { recursive: true });
    await mkdir(path.join(domainsDir, 'fresh-domain'), { recursive: true });
    await mkdir(path.join(domainsDir, 'clean-domain'), { recursive: true });
    await writeFile(path.join(domainsDir, 'stale-domain', '.write-lock'),
      JSON.stringify({ pid: 999999, startedAt: Date.now() - (LOCK_STALE_MS + 1000) }));
    await writeFile(path.join(domainsDir, 'fresh-domain', '.write-lock'),
      JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    // clean-domain has no lock file at all.

    __setDomainsDirOverride(domainsDir);
    const cleared = await cleanupStaleLocalLocks();
    assertTrue(cleared.includes('stale-domain'), 'stale-domain is reported as cleared');
    assertTrue(!cleared.includes('fresh-domain'), 'fresh-domain is NOT reported as cleared');
    assertTrue(!existsSync(path.join(domainsDir, 'stale-domain', '.write-lock')), 'stale-domain lock file is gone');
    assertTrue(existsSync(path.join(domainsDir, 'fresh-domain', '.write-lock')), 'fresh-domain lock file still exists');
  }

  // ── 7. ensureDomainsGitignore() writes the new .DS_Store rule ─────────────
  console.log('\n7. ensureDomainsGitignore() — .DS_Store rule lands in a fresh gitignore\n');
  {
    const domainsDir = await mktempTracked('sh-domains-7-');
    await mkdir(domainsDir, { recursive: true });
    __setDomainsDirOverride(domainsDir);
    await ensureDomainsGitignore();
    const { readFile } = await import('fs/promises');
    const content = await readFile(path.join(domainsDir, '.gitignore'), 'utf8');
    assertTrue(content.includes('.DS_Store'), 'the fresh .gitignore contains the .DS_Store rule');
    assertTrue(content.includes('*/.write-lock'), 'the fresh .gitignore still contains the .write-lock rule');

    // Idempotent on a second call
    await ensureDomainsGitignore();
    const content2 = await readFile(path.join(domainsDir, '.gitignore'), 'utf8');
    assertEq(content2, content, 'calling ensureDomainsGitignore() again does not change an already-current file');
  }

  // ── 8. push() end-to-end: untracks stale files, commits, is idempotent ────
  console.log('\n8. push() end-to-end — real remote, stale files cleaned + committed\n');
  {
    const gitDir = await mktempTracked('sh-gitdir-8-');
    const domainsDir = await mktempTracked('sh-domains-8-');
    const remoteDir = await makeBareRemote();
    const configFile = path.join(await mktempTracked('sh-cfg-8-'), 'sync-config.json');
    await initRepo(gitDir, domainsDir, remoteDir);
    await writeConfig(configFile, remoteDir);
    await seedDomain(domainsDir, 'articles');
    await writeFile(path.join(domainsDir, 'articles', '.write-lock'), JSON.stringify({ pid: 999999, startedAt: 1 }));
    await writeFile(path.join(domainsDir, '.DS_Store'), 'ds');
    sh(gitDir, domainsDir, 'add -A');
    sh(gitDir, domainsDir, '-c user.email=t@t -c user.name=t commit -q -m seed');

    __setSyncTestOverrides({ gitDir, configFile });
    __setDomainsDirOverride(domainsDir);

    assertTrue(isConfigured(), 'isConfigured() is true once overrides + config file are in place');

    const r1 = await withGitLockRetry(() => push());
    assertTrue(r1.pushed === true, 'first push() succeeds');
    const afterPush = trackedFiles(gitDir, domainsDir);
    assertTrue(!afterPush.some(f => f.includes('.write-lock') || f.includes('.DS_Store')),
      'no stale file remains tracked after push()');
    assertTrue(afterPush.includes('articles/CLAUDE.md'), 'real content was pushed');
    assertTrue(!existsSync(path.join(domainsDir, 'articles', '.write-lock')),
      'the stale (dead-pid) lock file itself was also removed from disk by push()');
    assertTrue(existsSync(path.join(domainsDir, '.DS_Store')),
      '.DS_Store is untracked but the actual Finder file on disk is left alone (we only stop syncing it)');

    // Idempotency / the "nothing to commit" guard path
    const r2 = await withGitLockRetry(() => push());
    assertEq(r2.pushed, false, 'a second push() with nothing new does not throw and reports pushed:false');
  }

  // ── 9. pull() symmetry (item 3) — a pull-only machine self-heals ──────────
  console.log('\n9. pull() symmetry — a machine that only ever pulls still self-heals\n');
  {
    const remoteDir = await mktempTracked('sh-remote-9-');
    execSync(`git init -q --bare "${remoteDir}"`);

    // Machine A establishes origin/main with clean content (no stale files).
    const gitDirA = await mktempTracked('sh-gitdir-9a-');
    const domainsA = await mktempTracked('sh-domains-9a-');
    const configA = path.join(await mktempTracked('sh-cfg-9a-'), 'sync-config.json');
    await initRepo(gitDirA, domainsA, remoteDir);
    await writeConfig(configA, remoteDir);
    await seedDomain(domainsA, 'articles');
    __setSyncTestOverrides({ gitDir: gitDirA, configFile: configA });
    __setDomainsDirOverride(domainsA);
    await withGitLockRetry(() => push());

    // Machine B clones from the remote, then independently commits its OWN
    // stale files locally (simulating an old pre-fix Curator instance, or an
    // MCP write on B that raced a Sync click before this fix existed) — it
    // NEVER calls push().
    const gitDirB = await mktempTracked('sh-gitdir-9b-');
    const domainsB = await mktempTracked('sh-domains-9b-');
    const configB = path.join(await mktempTracked('sh-cfg-9b-'), 'sync-config.json');
    await mkdir(domainsB, { recursive: true });
    sh(gitDirB, domainsB, 'init -q -b main');
    configureRepoIdentity(gitDirB, domainsB, { email: 't@t', name: 't' });
    sh(gitDirB, domainsB, `remote add origin "${remoteDir}"`);
    sh(gitDirB, domainsB, 'fetch origin -q');
    sh(gitDirB, domainsB, 'checkout -b main origin/main');
    await writeConfig(configB, remoteDir);

    await writeFile(path.join(domainsB, 'articles', '.write-lock'), JSON.stringify({ pid: 999999, startedAt: 1 }));
    await writeFile(path.join(domainsB, 'articles', '.DS_Store'), 'ds');
    // -f forces adding despite the already-inherited .gitignore (from A's
    // push) — this mirrors how these files got committed in the first
    // place, pre-fix, before the rule existed to stop `add -A` from doing it.
    sh(gitDirB, domainsB, 'add -f articles/.write-lock articles/.DS_Store');
    sh(gitDirB, domainsB, 'commit -q -m "B local stale commit"');

    const beforePull = trackedFiles(gitDirB, domainsB);
    assertTrue(beforePull.includes('articles/.write-lock') && beforePull.includes('articles/.DS_Store'),
      'precondition: B has its own locally-committed stale files before calling pull()');

    __setSyncTestOverrides({ gitDir: gitDirB, configFile: configB });
    __setDomainsDirOverride(domainsB);
    const rp = await withGitLockRetry(() => pull());
    assertTrue(rp.pulled === true, 'pull() completes successfully');

    const afterPull = trackedFiles(gitDirB, domainsB);
    assertTrue(!afterPull.includes('articles/.write-lock'), 'B\'s own stale .write-lock is untracked by pull() ALONE (never pushed)');
    assertTrue(!afterPull.includes('articles/.DS_Store'), 'B\'s own stale .DS_Store is untracked by pull() ALONE (never pushed)');
    assertTrue(!existsSync(path.join(domainsB, 'articles', '.write-lock')),
      'the stale lock file itself is also removed from B\'s disk by pull()');
  }

  // ── 10. A fresh (live) lock is preserved through both push() and pull() ───
  console.log('\n10. A fresh lock survives push() and pull() — never touch a live cross-process lock\n');
  {
    const gitDir = await mktempTracked('sh-gitdir-10-');
    const domainsDir = await mktempTracked('sh-domains-10-');
    const remoteDir = await makeBareRemote();
    const configFile = path.join(await mktempTracked('sh-cfg-10-'), 'sync-config.json');
    await initRepo(gitDir, domainsDir, remoteDir);
    await writeConfig(configFile, remoteDir);
    await seedDomain(domainsDir, 'articles');

    __setSyncTestOverrides({ gitDir, configFile });
    __setDomainsDirOverride(domainsDir);
    await withGitLockRetry(() => push()); // establish origin/main

    // Acquire a REAL fresh lock via write-registry's own function (as the
    // MCP server would while mid-write).
    const release = await acquireFileLock(path.join(domainsDir, 'articles'), { op: 'mcp-write' });
    assertTrue(typeof release === 'function', 'fresh lock acquired');
    assertTrue(await isFileLocked(path.join(domainsDir, 'articles')), 'isFileLocked() true while held');

    await withGitLockRetry(() => push());
    assertTrue(existsSync(path.join(domainsDir, 'articles', '.write-lock')), 'lock file survives push() untouched');
    assertTrue(await isFileLocked(path.join(domainsDir, 'articles')), 'still reported locked after push()');

    await withGitLockRetry(() => pull());
    assertTrue(existsSync(path.join(domainsDir, 'articles', '.write-lock')), 'lock file survives pull() untouched');
    assertTrue(await isFileLocked(path.join(domainsDir, 'articles')), 'still reported locked after pull()');

    await release();
    assertTrue(!existsSync(path.join(domainsDir, 'articles', '.write-lock')), 'releasing the lock removes the file as normal');
  }

  // ── 11. Source-level guard: every commit site carries the "nothing to commit" guard ──
  console.log('\n11. Source guard — every reachable git commit call is wrapped with the nothing-to-commit catch\n');
  {
    const { readFileSync } = await import('fs');
    const src = readFileSync(new URL('../src/brain/sync.js', import.meta.url), 'utf8');

    // Every `await git(\`commit ...\`)` / `await git('commit ...')` call site
    // must be immediately preceded by `try {` and followed (within a small
    // window) by a catch whose block checks `.message.includes('nothing to
    // commit')` — the catch parameter name itself is not load-bearing (this
    // file uses both `err` and `commitErr`), so the regex accepts either.
    const commitCallRe = /await git\(\s*['"`]commit\b[^)]*\)/g;
    const commitCalls = [...src.matchAll(commitCallRe)];
    assertTrue(commitCalls.length >= 3, `found at least 3 commit call sites (setup/push/pull incl. the new post-merge cleanup + conflict-recovery commits) — found ${commitCalls.length}`);

    for (const m of commitCalls) {
      const idx = m.index;
      const before = src.slice(Math.max(0, idx - 60), idx);
      const after = src.slice(idx, idx + 260);
      assertTrue(/try\s*\{[\s\S]*$/.test(before), `commit call at offset ${idx} is preceded by a try {`);
      assertTrue(/catch\s*\(\w+\)\s*\{[\s\S]*nothing to commit/.test(after),
        `commit call at offset ${idx} is followed by a catch (any parameter name) that checks 'nothing to commit'`);
    }

    // Regression guard: the untrack/cleanup calls sit BEFORE the status/
    // commit block that captures their staged changes into a real commit —
    // in push() that's still the ORIGINAL (pre-merge) status/commit block,
    // since push() never merges (see the ordering note in push()'s own
    // source). In pull() it's now the opposite of the pre-fix code: the
    // untrack/cleanup calls must run AFTER the merge (`git pull --no-rebase`)
    // and BEFORE pull()'s own NEW post-merge cleanup commit — this is
    // exactly the HIGH-severity audit fix (see recoverHygieneMergeConflict's
    // doc comment): running them BEFORE the merge is what broke real pulls.
    const pushBody = src.slice(src.indexOf('export async function push()'), src.indexOf('export async function pull()'));
    assertTrue(pushBody.indexOf('untrackStaleDSStore') < pushBody.indexOf('status --porcelain'),
      'push(): untrackStaleDSStore() runs before the status/commit block (push never merges, so this ordering is safe)');
    assertTrue(pushBody.indexOf('cleanupStaleLocalLocks') < pushBody.indexOf('status --porcelain'),
      'push(): cleanupStaleLocalLocks() runs before the status/commit block');

    const pullBody = src.slice(src.indexOf('export async function pull()'), src.indexOf('async function recoverHygieneMergeConflict'));
    const idxMerge         = pullBody.indexOf("git('pull --no-rebase");
    const idxUntrackLocks  = pullBody.indexOf('await untrackStaleWriteLocks()');
    const idxUntrackDS     = pullBody.indexOf('await untrackStaleDSStore()');
    const idxCleanupLocks  = pullBody.indexOf('await cleanupStaleLocalLocks()');
    const idxPostCommit    = pullBody.indexOf('Sync hygiene cleanup');

    assertTrue([idxMerge, idxUntrackLocks, idxUntrackDS, idxCleanupLocks, idxPostCommit].every(i => i !== -1),
      'pull(): all five ordering landmarks (merge call, 3 untrack/cleanup calls, post-merge commit) are present exactly once');

    assertTrue(idxMerge < idxUntrackLocks,
      'pull(): untrackStaleWriteLocks() now runs AFTER the merge (audit fix — pre-merge ordering caused a real "untracked working tree files would be overwritten" merge abort)');
    assertTrue(idxMerge < idxUntrackDS,
      'pull(): untrackStaleDSStore() now runs AFTER the merge');
    assertTrue(idxMerge < idxCleanupLocks,
      'pull(): cleanupStaleLocalLocks() now runs AFTER the merge');
    assertTrue(idxUntrackLocks < idxPostCommit && idxUntrackDS < idxPostCommit && idxCleanupLocks < idxPostCommit,
      'pull(): the post-merge untrack/cleanup calls all run before pull()\'s own post-merge cleanup commit');

    // The merge call itself must be wrapped in try/catch feeding
    // recoverHygieneMergeConflict — not just a bare `await git(...)` that
    // would propagate the "untracked working tree files" error unhandled.
    assertTrue(/try\s*\{[\s\S]*?pull --no-rebase[\s\S]*?\}\s*catch\s*\(err\)\s*\{[\s\S]*?recoverHygieneMergeConflict\(err\)/.test(pullBody),
      'pull(): the merge call is wrapped in try/catch that routes failures through recoverHygieneMergeConflict()');
  }

  // ── 12. Finding 1 — the exact auditor reproduction, two machines, real git ──
  console.log('\n12. pull() merge-safety ordering — the exact HIGH-severity audit reproduction\n');
  {
    // Faithful reproduction of the auditor's own narrative: "one machine
    // pushes a Finder-touched .DS_Store; a machine [on the fixed code]
    // untracks it and pulls → hard failure." With the OLD (pre-fix)
    // ordering this threw "untracked working tree files would be
    // overwritten by merge... Aborting" (exit 2) on a single call to
    // pull(). With the fix, .DS_Store is STILL TRACKED locally at the
    // moment the merge runs (the untrack happens after), so this is just a
    // normal tracked-file update — no collision, no recovery path needed.
    const remoteDir = await makeBareRemote();

    // Machine A: pushes real content + .DS_Store, both tracked.
    const gitDirA = await mktempTracked('sh-gitdir-12a-');
    const domainsA = await mktempTracked('sh-domains-12a-');
    await initRepo(gitDirA, domainsA, remoteDir);
    await mkdir(path.join(domainsA, 'articles', 'wiki'), { recursive: true });
    await writeFile(path.join(domainsA, 'articles', 'CLAUDE.md'), '# schema\n');
    await writeFile(path.join(domainsA, '.DS_Store'), 'finder-v1');
    sh(gitDirA, domainsA, 'add -A');
    sh(gitDirA, domainsA, '-c user.email=a@a -c user.name=a commit -q -m base');
    sh(gitDirA, domainsA, 'push -u origin main -q');

    // Machine B: clones exactly this state (.DS_Store tracked, content "finder-v1").
    const gitDirB = await mktempTracked('sh-gitdir-12b-');
    const domainsB = await mktempTracked('sh-domains-12b-');
    const configB = path.join(await mktempTracked('sh-cfg-12b-'), 'sync-config.json');
    await mkdir(domainsB, { recursive: true });
    sh(gitDirB, domainsB, 'init -q -b main');
    configureRepoIdentity(gitDirB, domainsB, { email: 'b@b', name: 'b' });
    sh(gitDirB, domainsB, `remote add origin "${remoteDir}"`);
    sh(gitDirB, domainsB, 'fetch origin -q');
    sh(gitDirB, domainsB, 'checkout -q -b main origin/main');
    await writeConfig(configB, remoteDir);
    assertTrue(trackedFiles(gitDirB, domainsB).includes('.DS_Store'), 'precondition: B\'s .DS_Store is tracked, matching A\'s pushed state');

    // Machine A "Finder touches" .DS_Store (rewrites content) and pushes again.
    await writeFile(path.join(domainsA, '.DS_Store'), 'finder-v2-touched');
    sh(gitDirA, domainsA, 'add -A');
    sh(gitDirA, domainsA, '-c user.email=a@a -c user.name=a commit -q -m "finder touch"');
    sh(gitDirA, domainsA, 'push origin main -q');

    // Machine B: a SINGLE pull() call — .DS_Store has never been untracked
    // on B before this point, so this exercises the PRIMARY ordering fix,
    // not the recovery fallback.
    __setSyncTestOverrides({ gitDir: gitDirB, configFile: configB });
    __setDomainsDirOverride(domainsB);
    let threw = null;
    let result;
    try {
      result = await withGitLockRetry(() => pull());
    } catch (e) {
      threw = e;
    }
    assertTrue(threw === null, 'pull() does NOT throw on the exact auditor-reported trigger', threw && threw.message);
    assertTrue(result && result.pulled === true, 'pull() reports success');
    assertTrue((await readFile(path.join(domainsB, '.DS_Store'), 'utf8')).trim() === 'finder-v2-touched',
      'the merge genuinely happened — B has A\'s Finder-touched content, not a stale/skipped version');
    assertTrue(!trackedFiles(gitDirB, domainsB).includes('.DS_Store'),
      '.DS_Store ends up untracked on B afterward (the post-merge cleanup still ran)');
    assertTrue(existsSync(path.join(domainsB, '.DS_Store')),
      'the actual Finder file is left alone on disk (untracked, not deleted)');
  }

  // ── 13. Finding 1 — Shape A recovery: untracked-overwrite, mid-transition ──
  console.log('\n13. pull() auto-recovery — Shape A (untracked-overwrite) during a mixed-fleet transition\n');
  {
    // This is the RESIDUAL exposure the coordinator asked about: even with
    // the ordering fixed, an EARLIER sync cycle can have already left
    // .DS_Store untracked-but-present on B, and a DIFFERENT, still-diverging
    // source can push a tracked+modified version — so THIS pull() call's
    // merge preflight still trips. recoverHygieneMergeConflict() must catch
    // it and retry successfully.
    const remoteDir = await makeBareRemote();

    const gitDirA = await mktempTracked('sh-gitdir-13a-');
    const domainsA = await mktempTracked('sh-domains-13a-');
    await initRepo(gitDirA, domainsA, remoteDir);
    await writeFile(path.join(domainsA, 'f.txt'), 'x');
    await writeFile(path.join(domainsA, '.DS_Store'), 'base');
    sh(gitDirA, domainsA, 'add -A');
    sh(gitDirA, domainsA, '-c user.email=a@a -c user.name=a commit -q -m base');
    sh(gitDirA, domainsA, 'push -u origin main -q');

    const gitDirB = await mktempTracked('sh-gitdir-13b-');
    const domainsB = await mktempTracked('sh-domains-13b-');
    const configB = path.join(await mktempTracked('sh-cfg-13b-'), 'sync-config.json');
    await mkdir(domainsB, { recursive: true });
    sh(gitDirB, domainsB, 'init -q -b main');
    configureRepoIdentity(gitDirB, domainsB, { email: 'b@b', name: 'b' });
    sh(gitDirB, domainsB, `remote add origin "${remoteDir}"`);
    sh(gitDirB, domainsB, 'fetch origin -q');
    sh(gitDirB, domainsB, 'checkout -q -b main origin/main');
    await writeConfig(configB, remoteDir);

    // B already untracked .DS_Store in an EARLIER cycle — committed locally
    // but not yet pushed (so it stays purely local divergence for now).
    sh(gitDirB, domainsB, 'rm --cached -q --ignore-unmatch -- .DS_Store');
    sh(gitDirB, domainsB, '-c user.email=b@b -c user.name=b commit -q -m "B: earlier untrack cycle"');
    assertTrue(!trackedFiles(gitDirB, domainsB).includes('.DS_Store'), 'precondition: B\'s .DS_Store is already untracked');
    assertTrue(existsSync(path.join(domainsB, '.DS_Store')), 'precondition: the file is still physically present on B (rm --cached only)');

    // Meanwhile A (still diverging from the SAME base — simulating another
    // not-yet-updated machine) modifies .DS_Store and pushes.
    await writeFile(path.join(domainsA, '.DS_Store'), 'modified-by-A');
    sh(gitDirA, domainsA, 'add -A');
    sh(gitDirA, domainsA, '-c user.email=a@a -c user.name=a commit -q -m "A modifies"');
    sh(gitDirA, domainsA, 'push origin main -q');

    __setSyncTestOverrides({ gitDir: gitDirB, configFile: configB });
    __setDomainsDirOverride(domainsB);

    // The real exported pull() — this is exactly the scenario that used to
    // throw "untracked working tree files would be overwritten by merge"
    // even AFTER the ordering fix (because the untracked-on-disk state
    // predates this call, from an earlier cycle). recoverHygieneMergeConflict
    // must catch it, delete B's own disposable local copy, and retry.
    let threw = null;
    let result;
    try {
      result = await withGitLockRetry(() => pull());
    } catch (e) {
      threw = e;
    }
    assertTrue(threw === null, 'pull() auto-recovers from a Shape A (untracked-overwrite) conflict on .DS_Store instead of throwing', threw && threw.message);
    assertTrue(result && result.pulled === true, 'pull() reports success after auto-recovery');
    assertTrue(result && /auto-resolved/.test(result.details || ''),
      'the result surfaces that an auto-resolve happened (details field), rather than pretending nothing occurred');
    assertTrue(!trackedFiles(gitDirB, domainsB).includes('.DS_Store'), 'B\'s .DS_Store ends up untracked again after recovery');
    assertTrue((await readFile(path.join(domainsB, '.DS_Store'), 'utf8')).trim() === 'modified-by-A',
      'the merge genuinely completed — B ends up with A\'s modified content merged in, not silently discarded');
  }

  // ── 14. Finding 1 — Shape B recovery: modify/delete conflict ──────────────
  console.log('\n14. pull() auto-recovery — Shape B (CONFLICT modify/delete) on .write-lock\n');
  {
    // Same divergence shape as section 13, but this time B's copy is BOTH
    // untracked AND physically ABSENT at merge time (e.g. cleanupStaleLocalLocks()
    // deleted a genuinely stale .write-lock in an earlier cycle) — so the
    // preflight check in Shape A doesn't trip, but the commit graph still
    // diverges (B deleted-from-index, A modified), producing a genuine
    // "CONFLICT (modify/delete)" that pull --no-rebase -X theirs resolves
    // the CONTENT of but leaves uncommitted.
    const remoteDir = await makeBareRemote();

    const gitDirA = await mktempTracked('sh-gitdir-14a-');
    const domainsA = await mktempTracked('sh-domains-14a-');
    await initRepo(gitDirA, domainsA, remoteDir);
    await writeFile(path.join(domainsA, 'f.txt'), 'x');
    await mkdir(path.join(domainsA, 'articles'), { recursive: true });
    await writeFile(path.join(domainsA, 'articles', '.write-lock'), 'base-lock');
    sh(gitDirA, domainsA, 'add -A');
    sh(gitDirA, domainsA, '-c user.email=a@a -c user.name=a commit -q -m base');
    sh(gitDirA, domainsA, 'push -u origin main -q');

    const gitDirB = await mktempTracked('sh-gitdir-14b-');
    const domainsB = await mktempTracked('sh-domains-14b-');
    const configB = path.join(await mktempTracked('sh-cfg-14b-'), 'sync-config.json');
    await mkdir(domainsB, { recursive: true });
    sh(gitDirB, domainsB, 'init -q -b main');
    configureRepoIdentity(gitDirB, domainsB, { email: 'b@b', name: 'b' });
    sh(gitDirB, domainsB, `remote add origin "${remoteDir}"`);
    sh(gitDirB, domainsB, 'fetch origin -q');
    sh(gitDirB, domainsB, 'checkout -q -b main origin/main');
    await writeConfig(configB, remoteDir);

    // B untracked AND physically deleted the file (matching what an earlier
    // push()/pull() cycle running cleanupStaleLocalLocks() would produce for
    // a genuinely stale lock).
    sh(gitDirB, domainsB, 'rm --cached -q --ignore-unmatch -- articles/.write-lock');
    sh(gitDirB, domainsB, '-c user.email=b@b -c user.name=b commit -q -m "B: earlier untrack + physical cleanup"');
    await rm(path.join(domainsB, 'articles', '.write-lock'), { force: true });
    assertTrue(!trackedFiles(gitDirB, domainsB).includes('articles/.write-lock'), 'precondition: B\'s .write-lock is untracked');
    assertTrue(!existsSync(path.join(domainsB, 'articles', '.write-lock')), 'precondition: the file is ALSO physically absent on B');

    await writeFile(path.join(domainsA, 'articles', '.write-lock'), 'modified-by-A');
    sh(gitDirA, domainsA, 'add -A');
    sh(gitDirA, domainsA, '-c user.email=a@a -c user.name=a commit -q -m "A modifies write-lock"');
    sh(gitDirA, domainsA, 'push origin main -q');

    __setSyncTestOverrides({ gitDir: gitDirB, configFile: configB });
    __setDomainsDirOverride(domainsB);

    let threw = null;
    let result;
    try {
      result = await withGitLockRetry(() => pull());
    } catch (e) {
      threw = e;
    }
    assertTrue(threw === null, 'pull() auto-recovers from a Shape B (modify/delete CONFLICT) on .write-lock instead of throwing', threw && threw.message);
    assertTrue(result && result.pulled === true, 'pull() reports success after auto-resolving the modify/delete conflict');
    assertTrue(!trackedFiles(gitDirB, domainsB).includes('articles/.write-lock'),
      '.write-lock ends up untracked again after recovery (merge re-tracked it with theirs\' content, post-merge untrack removed it again)');
    // The merge must have actually completed (no leftover MERGE_HEAD / unmerged entries).
    const finalStatus = execSync(`git --git-dir="${gitDirB}" --work-tree="${domainsB}" status --porcelain`).toString('utf8');
    assertTrue(!/^(?:DU|UD|AU|UA|UU|AA)/m.test(finalStatus), 'no unmerged/conflicted entries remain in B\'s git status after recovery');
  }

  // ── 15. Finding 1 — negative control: real content conflicts are NEVER auto-resolved ──
  console.log('\n15. pull() safety — a conflict touching REAL wiki content is never silently auto-resolved\n');
  {
    const remoteDir = await makeBareRemote();

    const gitDirA = await mktempTracked('sh-gitdir-15a-');
    const domainsA = await mktempTracked('sh-domains-15a-');
    await initRepo(gitDirA, domainsA, remoteDir);
    await mkdir(path.join(domainsA, 'articles'), { recursive: true });
    await writeFile(path.join(domainsA, 'articles', 'real-page.md'), 'base content\n');
    sh(gitDirA, domainsA, 'add -A');
    sh(gitDirA, domainsA, '-c user.email=a@a -c user.name=a commit -q -m base');
    sh(gitDirA, domainsA, 'push -u origin main -q');

    const gitDirB = await mktempTracked('sh-gitdir-15b-');
    const domainsB = await mktempTracked('sh-domains-15b-');
    const configB = path.join(await mktempTracked('sh-cfg-15b-'), 'sync-config.json');
    await mkdir(domainsB, { recursive: true });
    sh(gitDirB, domainsB, 'init -q -b main');
    configureRepoIdentity(gitDirB, domainsB, { email: 'b@b', name: 'b' });
    sh(gitDirB, domainsB, `remote add origin "${remoteDir}"`);
    sh(gitDirB, domainsB, 'fetch origin -q');
    sh(gitDirB, domainsB, 'checkout -q -b main origin/main');
    await writeConfig(configB, remoteDir);

    // Reproduce the Shape B (modify/delete CONFLICT) construction from
    // section 14, but on a REAL wiki page instead of a hygiene file — B
    // deletes it (both from the index AND physically; something our own
    // code would never actually do to a real page, but this proves the
    // GATING logic itself defensively, not just that our code behaves on
    // the paths it actually touches). Note: deleting the file only from the
    // index (rm --cached, leaving it on disk) would NOT reach this branch —
    // pull()'s own pre-merge "auto-save local changes" step re-tracks any
    // untracked-but-present file before the merge runs (by design: it's
    // what makes real content safe from Shape A in the first place, since
    // ONLY gitignored paths like .write-lock/.DS_Store stay untracked
    // through that step). Physically removing the file is what constructs a
    // genuine modify/delete divergence instead.
    sh(gitDirB, domainsB, 'rm --cached -q --ignore-unmatch -- articles/real-page.md');
    await rm(path.join(domainsB, 'articles', 'real-page.md'), { force: true });
    sh(gitDirB, domainsB, '-c user.email=b@b -c user.name=b commit -q -m "B: deleted a real page (should never happen in practice)"');

    await writeFile(path.join(domainsA, 'articles', 'real-page.md'), 'IMPORTANT USER CONTENT — must never be silently discarded\n');
    sh(gitDirA, domainsA, 'add -A');
    sh(gitDirA, domainsA, '-c user.email=a@a -c user.name=a commit -q -m "A edits the real page"');
    sh(gitDirA, domainsA, 'push origin main -q');

    __setSyncTestOverrides({ gitDir: gitDirB, configFile: configB });
    __setDomainsDirOverride(domainsB);

    let threw = null;
    try {
      await withGitLockRetry(() => pull());
    } catch (e) {
      threw = e;
    }
    assertTrue(threw !== null, 'pull() THROWS rather than auto-resolving a modify/delete conflict touching a real (non-hygiene) path');
    assertTrue(threw !== null && /real-page\.md/.test(threw.message) && /CONFLICT \(modify\/delete\)/.test(threw.message),
      'the thrown error message names the real page and is the genuine modify/delete CONFLICT shape (proves this reached Shape B\'s gate, not something unrelated)');

    const friendly = threw ? friendlyError(threw) : null;
    assertTrue(friendly !== null, 'friendlyError() maps this to a non-null, user-actionable message (not raw git text passed through silently, not swallowed)');
    assertTrue(friendly && !/Please move or remove them before you merge/.test(friendly),
      'the user-facing message is NOT the raw git preflight text');
    assertTrue(friendly && /manual look|ask for help/i.test(friendly),
      'the friendly message tells the user this needs manual attention');

    // Direct unit coverage of the gating primitive on this exact real path,
    // and confirmation that the harness genuinely produced an unmerged
    // "DU" entry for it (proving Shape B's own detection logic — a
    // git-status-porcelain scan — would have found exactly this path).
    assertTrue(!isHygieneJunkPath('articles/real-page.md'), 'isHygieneJunkPath correctly rejects a real wiki page path');
    const statusAfter = execSync(`git -c core.quotePath=false --git-dir="${gitDirB}" --work-tree="${domainsB}" status --porcelain`).toString('utf8');
    assertTrue(/^DU articles\/real-page\.md$/m.test(statusAfter),
      'git status --porcelain on B shows the real page as an unresolved "DU" (deleted-by-us) conflict — exactly what Shape B\'s recovery logic scans for and correctly refuses to touch');
  }

} finally {
  // Always reset the module-level test overrides so no other suite (or a
  // stray future call in this same process) can end up pointed at a
  // now-deleted tempdir.
  __setSyncTestOverrides({});
  __setDomainsDirOverride(null);

  for (const d of cleanupDirs) {
    try { await rm(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}


// ── 16. friendlyError branch ORDER — regression guard (v3.0.16) ──────────────
//
// A merge-conflict message embeds abbreviated commit SHAs and absolute temp/
// repo paths. `friendlyError`'s auth branch used a BARE `403`/`401` substring
// test against that whole string, so a SHA like `774bb403e78...` (or a TMPDIR
// containing "403") silently routed a real content conflict to "GitHub
// rejected the token" — sending the user to regenerate a PAT while their
// unresolved merge sat untouched, and suppressing the safety message this
// release added on purpose. Hit rate ~0.7-1.8% per conflict, which is exactly
// why it survived a full adversarial audit and only surfaced as a "flaky test".
console.log('\n16. friendlyError: conflict messages must never be misread as auth failures');
{
  const conflictMsg = (sha) =>
    `CONFLICT (modify/delete): articles/wiki/page.md deleted in HEAD and modified in ${sha}. ` +
    `Automatic merge failed; fix conflicts and then commit the result.`;
  const overwriteMsg = (dir) =>
    `error: The following untracked working tree files would be overwritten by merge:\n\t${dir}/x/.DS_Store`;

  // SHAs are hex, so 403/401 occur naturally. Every one of these is a CONFLICT.
  for (const sha of ['9fb2d6a', '9f403d6', '9f401d6', '774bb403e783d4700156658d4916497ca3e89d8d', '401aaa9']) {
    const out = String(friendlyError(new Error(conflictMsg(sha))) || '');
    if (out.includes('manual look')) ok(`conflict with SHA "${sha.slice(0, 12)}" → content-conflict message, not auth`);
    else fail(`conflict with SHA "${sha.slice(0, 12)}" → content-conflict message, not auth`, `got: ${out.slice(0, 90)}`);
  }
  for (const dir of ['/tmp/clean', '/tmp/tmp403dir', '/tmp/tmp401dir']) {
    const out = String(friendlyError(new Error(overwriteMsg(dir))) || '');
    if (out.includes('manual look')) ok(`untracked-overwrite under "${dir}" → overwrite message, not auth`);
    else fail(`untracked-overwrite under "${dir}" → overwrite message, not auth`, `got: ${out.slice(0, 90)}`);
  }
  // ...and the auth branch must STILL fire for genuine auth failures.
  for (const m of [
    'fatal: Authentication failed for https://github.com/x/y.git',
    'remote: HTTP 403 Forbidden',
    'The requested URL returned error: 401 Unauthorized',
    'could not read Username for https://github.com',
  ]) {
    const out = String(friendlyError(new Error(m)) || '');
    if (out.includes('GitHub rejected the token')) ok(`genuine auth error still maps: "${m.slice(0, 34)}…"`);
    else fail(`genuine auth error still maps: "${m.slice(0, 34)}…"`, `got: ${out.slice(0, 90)}`);
  }
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log('\n=== Result ===');
console.log(`  ${passed} passed, ${failed} failed (${passed + failed} total)\n`);
if (failed > 0) {
  console.log('Failures:');
  for (const f of failures) {
    console.log(`  - ${f.label}`);
    if (f.detail) console.log(`      ${f.detail}`);
  }
  process.exit(1);
}
process.exit(0);
