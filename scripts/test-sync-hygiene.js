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

import { execSync, spawn } from 'child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'fs/promises';
import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

import {
  __setSyncTestOverrides,
  push,
  pull,
  sync,
  getRemoteStatus,
  isConfigured,
  friendlyError,
  remoteErrorMessage,
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
  isSafeTrackedPathSuffix,
  isSafeTrackedTailPath,
  untrackStaleWriteLocks,
  untrackStaleDSStore,
  untrackStaleObsidianWorkspace,
  untrackStaleObsidianLeftovers,
  cleanupStaleLocalLocks,
  ensureDomainsGitignore,
  DOMAINS_GITIGNORE_RULES,
  recoverHygieneMergeConflict,
  isHygieneJunkPath,
  extractUntrackedOverwritePaths,
  countIncoming,
  invalidateRemoteCache,
  REMOTE_CHECK_TTL_MS,
  REMOTE_CHECK_FAILURE_TTL_MS,
  remoteCacheTtl,
} = syncTesting;

// ── Extracting the frontend's pure functions and RUNNING them ──────────────
//
// The v3.9.1 defects are both "what does the user actually SEE", so the
// assertions below execute the real frontend functions over the real objects
// the real backend produced, rather than regex-ing the source for a hopeful
// substring. A source scan cannot tell the difference between a renderer that
// reads a field and one that merely mentions it — which is exactly how this
// codebase's recurring dead-data defect keeps surviving review.
function extractFn(src, name, file) {
  const start = src.search(new RegExp('(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function\\s+' + name + '\\s*\\('));
  if (start < 0) throw new Error(`${file}: function ${name}() not found — has it been renamed?`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`${file}: unbalanced braces extracting ${name}()`);
}

function extractConst(src, name, file) {
  const m = new RegExp('(?:^|\\n)const\\s+' + name + '\\s*=\\s*[^;\\n]+;').exec(src);
  if (!m) throw new Error(`${file}: const ${name} not found`);
  return m[0];
}
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

  // ── 15b. Unit tests — isSafeTrackedPathSuffix / isSafeTrackedTailPath ─────
  console.log('\n15b. Path-safety validators for the v3.5.1 additions (isSafeTrackedPathSuffix / isSafeTrackedTailPath)\n');
  {
    assertTrue(isSafeTrackedPathSuffix('Untitled.base', '.base', null), 'bare "Untitled.base" at depth 0 matches the .base suffix');
    assertTrue(isSafeTrackedPathSuffix('articles/Untitled 1.base', '.base', null), 'a space-containing basename ("Untitled 1.base") is still recognised');
    assertTrue(isSafeTrackedPathSuffix('articles/wiki/Untitled 2.base', '.base', null), 'two-level-deep .base file recognised');
    assertTrue(!isSafeTrackedPathSuffix('articles/real-page.md', '.base', null), 'a real .md page never matches the .base suffix');
    assertTrue(!isSafeTrackedPathSuffix('articles/Untitled.base; rm -rf /', '.base', null), 'a shell-metacharacter-laced basename is rejected even though it ends with .base');
    assertTrue(!isSafeTrackedPathSuffix(null, '.base', null), 'null input rejected, not thrown on');
    assertTrue(!isSafeTrackedPathSuffix('', '.base', null), 'empty string input rejected');

    assertTrue(isSafeTrackedTailPath('.obsidian/workspace.json', ['.obsidian', 'workspace.json']), 'root-level (vault root = domains/) .obsidian/workspace.json matches');
    assertTrue(isSafeTrackedTailPath('articles/.obsidian/workspace.json', ['.obsidian', 'workspace.json']), 'one-level (vault root = domains/<domain>/) matches');
    assertTrue(isSafeTrackedTailPath('articles/wiki/.obsidian/workspace.json', ['.obsidian', 'workspace.json']), 'two-level (vault root = domains/<domain>/wiki/, the documented default) matches');
    assertTrue(!isSafeTrackedTailPath('articles/.obsidian/workspace.json.bak', ['.obsidian', 'workspace.json']), 'a similarly-named but different file (workspace.json.bak) does NOT match');
    assertTrue(!isSafeTrackedTailPath('articles/.obsidian/appearance.json', ['.obsidian', 'workspace.json']), 'a DIFFERENT file inside .obsidian/ (appearance.json) does NOT match — the scope is workspace.json only, never the directory wholesale');
    assertTrue(!isSafeTrackedTailPath('articles/real-page.md', ['.obsidian', 'workspace.json']), 'an unrelated real path never matches');
    assertTrue(!isSafeTrackedTailPath(null, ['.obsidian', 'workspace.json']), 'null input rejected, not thrown on');
  }

  // ── 15c. DOMAINS_GITIGNORE_RULES — the four new v3.5.1 entries ────────────
  console.log('\n15c. DOMAINS_GITIGNORE_RULES carries the four new v3.5.1 entries\n');
  {
    // MUST carry the '**/' prefix, not a bare '.obsidian/workspace.json' —
    // caught live (section 15g/15h below): a pattern with a slash anywhere
    // other than a single trailing one is anchored to the .gitignore's own
    // directory per gitignore(5), so the bare form only ever matched
    // domains/.obsidian/workspace.json, never the real vault-root depths one
    // or two levels down. The untrack itself (git ls-files pathspec
    // matching) worked fine either way; it was the FOLLOWING `git add -A` in
    // the same push()/pull() cycle that silently re-staged the file because
    // gitignore never actually excluded the nested path — undoing the
    // untrack inside its own commit.
    assertTrue(DOMAINS_GITIGNORE_RULES.includes('**/.obsidian/workspace.json'), 'rule: **/.obsidian/workspace.json is present, anchored to match at ANY depth');
    assertTrue(!DOMAINS_GITIGNORE_RULES.includes('.obsidian/workspace.json'), 'rule: the un-prefixed, root-anchored-only form is NOT present — the regression this guards against');
    assertTrue(!DOMAINS_GITIGNORE_RULES.includes('.obsidian/'), 'rule: the directory is NOT ignored wholesale — appearance/graph/plugin settings still sync unless the user opts out some other way');
    assertTrue(DOMAINS_GITIGNORE_RULES.includes('*.base'), 'rule: *.base is present (mirrors the app repo .gitignore)');
    assertTrue(DOMAINS_GITIGNORE_RULES.includes('Untitled.md'), 'rule: Untitled.md is present (mirrors the app repo .gitignore)');
    assertTrue(DOMAINS_GITIGNORE_RULES.includes('Untitled 1.md'), 'rule: "Untitled 1.md" is present (mirrors the app repo .gitignore)');
    // Do-not-invent-patterns guard: only the entries the coordinator named
    // as "the relevant entries" from the app repo's own Obsidian-leftover
    // block — not the whole block (no .canvas, no behind-the_curtain.md).
    assertTrue(!DOMAINS_GITIGNORE_RULES.includes('*.canvas'), 'no invented pattern: *.canvas was NOT part of the instructed scope');
    assertTrue(!DOMAINS_GITIGNORE_RULES.some(r => r.includes('behind-the_curtain')), 'no invented pattern: behind-the_curtain.md was NOT part of the instructed scope');
  }

  // ── 15d. untrackStaleObsidianWorkspace() — root / one-level / two-level ───
  console.log('\n15d. untrackStaleObsidianWorkspace() — root / one-level / two-level committed workspace.json\n');
  {
    const gitDir = await mktempTracked('sh-gitdir-15d-');
    const domainsDir = await mktempTracked('sh-domains-15d-');
    const remoteDir = await mktempTracked('sh-remote-15d-');
    await initRepo(gitDir, domainsDir, remoteDir);
    await seedDomain(domainsDir, 'articles');
    // Three plausible vault-root depths (see CLAUDE.md's Obsidian Graph
    // Setup section: root can point at domains/, domains/<domain>/, or
    // domains/<domain>/wiki/).
    await mkdir(path.join(domainsDir, '.obsidian'), { recursive: true });
    await writeFile(path.join(domainsDir, '.obsidian', 'workspace.json'), '{}');
    await mkdir(path.join(domainsDir, 'articles', '.obsidian'), { recursive: true });
    await writeFile(path.join(domainsDir, 'articles', '.obsidian', 'workspace.json'), '{}');
    await mkdir(path.join(domainsDir, 'articles', 'wiki', '.obsidian'), { recursive: true });
    await writeFile(path.join(domainsDir, 'articles', 'wiki', '.obsidian', 'workspace.json'), '{}');
    // A DIFFERENT file in the same directory must survive — scope is
    // workspace.json only.
    await writeFile(path.join(domainsDir, 'articles', 'wiki', '.obsidian', 'appearance.json'), '{}');
    sh(gitDir, domainsDir, 'add -A');
    sh(gitDir, domainsDir, '-c user.email=t@t -c user.name=t commit -q -m seed');

    const before = trackedFiles(gitDir, domainsDir);
    assertTrue(before.includes('.obsidian/workspace.json') && before.includes('articles/.obsidian/workspace.json') && before.includes('articles/wiki/.obsidian/workspace.json'),
      'precondition: all three depths of workspace.json are tracked before untrack runs');
    assertTrue(before.includes('articles/wiki/.obsidian/appearance.json'), 'precondition: appearance.json (a different file) is also tracked');

    __setSyncTestOverrides({ gitDir, configFile: path.join(domainsDir, '..', 'unused-config.json') });
    __setDomainsDirOverride(domainsDir);
    const untracked = await untrackStaleObsidianWorkspace();
    assertEq(untracked.length, 3, 'untrackStaleObsidianWorkspace() untracks all three depths in one pass');

    const after = trackedFiles(gitDir, domainsDir);
    assertTrue(!after.includes('.obsidian/workspace.json'), 'root-level workspace.json is no longer tracked');
    assertTrue(!after.includes('articles/.obsidian/workspace.json'), 'one-level workspace.json is no longer tracked');
    assertTrue(!after.includes('articles/wiki/.obsidian/workspace.json'), 'two-level workspace.json is no longer tracked');
    assertTrue(after.includes('articles/wiki/.obsidian/appearance.json'), 'appearance.json (NOT workspace.json) is STILL tracked — the scope really is one file, not the directory');
    assertTrue(after.includes('articles/CLAUDE.md'), 'real domain content is untouched');

    // Untrack means `git rm --cached`, never deleting from disk — the
    // maintainer's Obsidian settings must keep working locally.
    assertTrue(existsSync(path.join(domainsDir, '.obsidian', 'workspace.json')), 'root-level workspace.json still EXISTS ON DISK after being untracked');
    assertTrue(existsSync(path.join(domainsDir, 'articles', '.obsidian', 'workspace.json')), 'one-level workspace.json still exists on disk');
    assertTrue(existsSync(path.join(domainsDir, 'articles', 'wiki', '.obsidian', 'workspace.json')), 'two-level workspace.json still exists on disk');
  }

  // ── 15e. untrackStaleObsidianLeftovers() — *.base / Untitled.md / "Untitled 1.md" ──
  console.log('\n15e. untrackStaleObsidianLeftovers() — *.base (incl. a space in the name), Untitled.md, "Untitled 1.md"\n');
  {
    const gitDir = await mktempTracked('sh-gitdir-15e-');
    const domainsDir = await mktempTracked('sh-domains-15e-');
    const remoteDir = await mktempTracked('sh-remote-15e-');
    await initRepo(gitDir, domainsDir, remoteDir);
    await seedDomain(domainsDir, 'articles');
    // The exact three names the maintainer reported: Untitled.base,
    // "Untitled 1.base", "Untitled 2.base" — all match *.base.
    await writeFile(path.join(domainsDir, 'Untitled.base'), 'x');
    await writeFile(path.join(domainsDir, 'articles', 'Untitled 1.base'), 'x');
    await writeFile(path.join(domainsDir, 'articles', 'wiki', 'Untitled 2.base'), 'x');
    await writeFile(path.join(domainsDir, 'Untitled.md'), 'x');
    await writeFile(path.join(domainsDir, 'articles', 'Untitled 1.md'), 'x');
    // A REAL page whose name merely CONTAINS "Untitled" as a substring must
    // survive — the match is on the exact final segment, never a substring.
    await writeFile(path.join(domainsDir, 'articles', 'Untitled Notes About Growth.md'), 'real content, do not touch\n');
    sh(gitDir, domainsDir, 'add -A');
    sh(gitDir, domainsDir, '-c user.email=t@t -c user.name=t commit -q -m seed');

    const before = trackedFiles(gitDir, domainsDir);
    assertTrue(before.includes('Untitled.base') && before.includes('articles/Untitled 1.base') && before.includes('articles/wiki/Untitled 2.base'),
      'precondition: all three .base depths/names are tracked');
    assertTrue(before.includes('Untitled.md') && before.includes('articles/Untitled 1.md'), 'precondition: both stub names are tracked');
    assertTrue(before.includes('articles/Untitled Notes About Growth.md'), 'precondition: the real look-alike page is also tracked');

    __setSyncTestOverrides({ gitDir, configFile: path.join(domainsDir, '..', 'unused-config.json') });
    __setDomainsDirOverride(domainsDir);
    const untracked = await untrackStaleObsidianLeftovers();
    assertEq(untracked.length, 5, 'untrackStaleObsidianLeftovers() untracks all 3 .base files + both stub names in one pass');

    const after = trackedFiles(gitDir, domainsDir);
    assertTrue(!after.includes('Untitled.base') && !after.includes('articles/Untitled 1.base') && !after.includes('articles/wiki/Untitled 2.base'),
      'none of the three .base files remain tracked');
    assertTrue(!after.includes('Untitled.md') && !after.includes('articles/Untitled 1.md'), 'neither stub name remains tracked');
    assertTrue(after.includes('articles/Untitled Notes About Growth.md'),
      'FIXED (precision): a real page that merely starts with "Untitled" but is NOT an exact "Untitled.md"/"Untitled 1.md" match is left tracked — the rule is an exact-name/suffix match, not a substring guess');
    assertTrue(after.includes('articles/CLAUDE.md'), 'real domain content is untouched');

    // Untrack means `git rm --cached`, never deleting from disk.
    assertTrue(existsSync(path.join(domainsDir, 'Untitled.base')), 'Untitled.base still exists on disk after untrack');
    assertTrue(existsSync(path.join(domainsDir, 'articles', 'Untitled 1.base')), '"Untitled 1.base" still exists on disk after untrack');
    assertTrue(existsSync(path.join(domainsDir, 'Untitled.md')), 'Untitled.md still exists on disk after untrack');
    assertTrue(existsSync(path.join(domainsDir, 'articles', 'Untitled 1.md')), '"Untitled 1.md" still exists on disk after untrack');
  }

  // ── 15f. isHygieneJunkPath — precise recognition, no widened gate ─────────
  console.log('\n15f. isHygieneJunkPath() recognises exactly the new junk shapes, nothing more\n');
  {
    assertTrue(isHygieneJunkPath('.obsidian/workspace.json'), 'root-level workspace.json recognised');
    assertTrue(isHygieneJunkPath('articles/wiki/.obsidian/workspace.json'), 'nested workspace.json recognised');
    assertTrue(!isHygieneJunkPath('articles/wiki/.obsidian/appearance.json'), 'a different .obsidian/ file is NOT recognised — narrow scope holds at the recovery gate too');
    assertTrue(isHygieneJunkPath('Untitled.base'), 'Untitled.base recognised');
    assertTrue(isHygieneJunkPath('articles/Untitled 1.base'), '"Untitled 1.base" recognised');
    assertTrue(isHygieneJunkPath('Untitled.md'), 'Untitled.md recognised');
    assertTrue(isHygieneJunkPath('articles/Untitled 1.md'), '"Untitled 1.md" recognised');
    // Still correctly rejects everything it always rejected.
    assertTrue(!isHygieneJunkPath('articles/real-page.md'), 'a real wiki page is still correctly rejected');
    assertTrue(!isHygieneJunkPath('articles/Untitled Notes About Growth.md'), 'a real page merely starting with "Untitled" is rejected — substring, not exact match');
    assertTrue(isHygieneJunkPath('articles/.write-lock'), '.write-lock is still recognised (pre-existing, unaffected by this extension)');
    assertTrue(isHygieneJunkPath('.DS_Store'), '.DS_Store is still recognised (pre-existing, unaffected by this extension)');
  }

  // ── 15g. push() end-to-end includes the new untracks ──────────────────────
  console.log('\n15g. push() end-to-end untracks + commits the new Obsidian junk classes\n');
  {
    const gitDir = await mktempTracked('sh-gitdir-15g-');
    const domainsDir = await mktempTracked('sh-domains-15g-');
    const remoteDir = await makeBareRemote();
    const configPath = path.join(await mktempTracked('sh-cfg-15g-'), 'sync-config.json');
    await initRepo(gitDir, domainsDir, remoteDir);
    await seedDomain(domainsDir, 'articles');
    await mkdir(path.join(domainsDir, 'articles', 'wiki', '.obsidian'), { recursive: true });
    await writeFile(path.join(domainsDir, 'articles', 'wiki', '.obsidian', 'workspace.json'), '{}');
    await writeFile(path.join(domainsDir, 'Untitled.base'), 'x');
    sh(gitDir, domainsDir, 'add -A');
    sh(gitDir, domainsDir, '-c user.email=t@t -c user.name=t commit -q -m seed');
    sh(gitDir, domainsDir, 'push -u origin main -q');
    assertTrue(trackedFiles(gitDir, domainsDir).includes('articles/wiki/.obsidian/workspace.json'), 'precondition: workspace.json tracked before push()');
    assertTrue(trackedFiles(gitDir, domainsDir).includes('Untitled.base'), 'precondition: Untitled.base tracked before push()');

    await writeConfig(configPath, remoteDir);
    __setSyncTestOverrides({ gitDir, configFile: configPath });
    __setDomainsDirOverride(domainsDir);

    let threw = null;
    try { await withGitLockRetry(() => push()); } catch (e) { threw = e; }
    assertTrue(threw === null, 'push() does not throw while self-healing the new junk classes', threw && threw.message);

    const after = trackedFiles(gitDir, domainsDir);
    assertTrue(!after.includes('articles/wiki/.obsidian/workspace.json'), 'push() untracked workspace.json');
    assertTrue(!after.includes('Untitled.base'), 'push() untracked Untitled.base');
    assertTrue(existsSync(path.join(domainsDir, 'articles', 'wiki', '.obsidian', 'workspace.json')), 'workspace.json still exists on disk after push()');
    assertTrue(existsSync(path.join(domainsDir, 'Untitled.base')), 'Untitled.base still exists on disk after push()');

    // .gitignore itself now carries the new rules (ensureDomainsGitignore
    // self-heal, exercised via push()).
    const gitignoreContent = await readFile(path.join(domainsDir, '.gitignore'), 'utf8');
    assertTrue(gitignoreContent.includes('.obsidian/workspace.json'), 'push() self-healed .gitignore to include the new workspace.json rule');
    assertTrue(gitignoreContent.includes('*.base'), 'push() self-healed .gitignore to include the new *.base rule');
  }

  // ── 15h. pull() merge-safety ordering for the NEW junk classes — real
  //    two-machine reproduction, mirroring section 12's .DS_Store proof ────
  console.log('\n15h. pull() merge-safety ordering — real two-machine reproduction for .obsidian/workspace.json\n');
  {
    const remoteDir = await makeBareRemote();

    const gitDirA = await mktempTracked('sh-gitdir-15ha-');
    const domainsA = await mktempTracked('sh-domains-15ha-');
    await initRepo(gitDirA, domainsA, remoteDir);
    await mkdir(path.join(domainsA, 'articles', 'wiki', '.obsidian'), { recursive: true });
    await writeFile(path.join(domainsA, 'articles', 'CLAUDE.md'), '# schema\n');
    await writeFile(path.join(domainsA, 'articles', 'wiki', '.obsidian', 'workspace.json'), '{"pane":"v1"}');
    sh(gitDirA, domainsA, 'add -A');
    sh(gitDirA, domainsA, '-c user.email=a@a -c user.name=a commit -q -m base');
    sh(gitDirA, domainsA, 'push -u origin main -q');

    const gitDirB = await mktempTracked('sh-gitdir-15hb-');
    const domainsB = await mktempTracked('sh-domains-15hb-');
    const configB = path.join(await mktempTracked('sh-cfg-15hb-'), 'sync-config.json');
    await mkdir(domainsB, { recursive: true });
    sh(gitDirB, domainsB, 'init -q -b main');
    configureRepoIdentity(gitDirB, domainsB, { email: 'b@b', name: 'b' });
    sh(gitDirB, domainsB, `remote add origin "${remoteDir}"`);
    sh(gitDirB, domainsB, 'fetch origin -q');
    sh(gitDirB, domainsB, 'checkout -q -b main origin/main');
    await writeConfig(configB, remoteDir);
    assertTrue(trackedFiles(gitDirB, domainsB).includes('articles/wiki/.obsidian/workspace.json'), 'precondition: B\'s workspace.json is tracked, matching A\'s pushed state');

    // Machine A moves a pane (rewrites workspace.json) and pushes again —
    // exactly the "rewritten on essentially every Obsidian interaction"
    // scenario from the report.
    await writeFile(path.join(domainsA, 'articles', 'wiki', '.obsidian', 'workspace.json'), '{"pane":"v2-moved"}');
    sh(gitDirA, domainsA, 'add -A');
    sh(gitDirA, domainsA, '-c user.email=a@a -c user.name=a commit -q -m "moved a pane"');
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
    assertTrue(threw === null, 'pull() does NOT throw on a Finder/Obsidian-touched workspace.json (the CORRECT after-merge ordering)', threw && threw.message);
    assertTrue(result && result.pulled === true, 'pull() reports success');
    assertTrue((await readFile(path.join(domainsB, 'articles', 'wiki', '.obsidian', 'workspace.json'), 'utf8')).includes('v2-moved'),
      'the merge genuinely happened — B has A\'s moved-pane content, not a stale/skipped version');
    assertTrue(!trackedFiles(gitDirB, domainsB).includes('articles/wiki/.obsidian/workspace.json'),
      'workspace.json ends up untracked on B afterward (the post-merge cleanup still ran)');
    assertTrue(existsSync(path.join(domainsB, 'articles', 'wiki', '.obsidian', 'workspace.json')),
      'the actual file is left alone on disk (untracked, not deleted) — Obsidian keeps working locally');


    // ── MUTATION-PROVE: reproduce, against REAL git, exactly what happens if
    //    a future edit calls the new untrack functions BEFORE the merge
    //    instead of after — the same class of bug this ordering fix (and the
    //    pre-existing .write-lock/.DS_Store guard above it) exists to
    //    prevent. Rather than re-importing a hand-mutated copy of sync.js
    //    (risky: it has real relative imports to config.js/atomic-write.js/
    //    write-registry.js/paths.js that only resolve from its real
    //    location), this drives the REAL exported untrack functions
    //    (untrackStaleObsidianWorkspace/untrackStaleObsidianLeftovers) by
    //    hand, in the WRONG position, then issues the exact same git command
    //    pull() itself uses — proving the mechanism directly against real
    //    git, the same style test-raw-store.js §2b uses for its own
    //    mutation proofs ("mutate the layer, not the source text"). ────────
    {
      // Static half of the proof: confirm the REAL pull() source places the
      // merge command textually BEFORE the two new untrack calls (i.e. the
      // fix is actually shipped in the position this whole section assumes).
      const syncSrc = await readFile(path.join(ROOT, 'src/brain/sync.js'), 'utf8');
      const pullFnMatch = syncSrc.match(/export async function pull\(\)[\s\S]*?\n}\n/);
      assertTrue(!!pullFnMatch, 'mutation sanity — pull() was extractable from the real source file');
      const pullFnSrc = pullFnMatch[0];
      const mergeIdx = pullFnSrc.indexOf("git('pull --no-rebase -X theirs origin main'");
      const workspaceUntrackIdx = pullFnSrc.indexOf('await untrackStaleObsidianWorkspace();');
      const leftoversUntrackIdx = pullFnSrc.indexOf('await untrackStaleObsidianLeftovers();');
      assertTrue(mergeIdx > -1 && workspaceUntrackIdx > -1 && leftoversUntrackIdx > -1,
        'mutation sanity — all three anchors (merge command, the two new untrack calls) were found in pull()');
      assertTrue(mergeIdx < workspaceUntrackIdx && mergeIdx < leftoversUntrackIdx,
        'STATIC CHECK — in the shipped source, the merge command runs textually BEFORE untrackStaleObsidianWorkspace()/untrackStaleObsidianLeftovers(), matching the documented after-merge ordering');

      // Dynamic half of the proof: build a real two-machine divergence, then
      // call the REAL exported untrack functions in the WRONG position (i.e.
      // exactly what a regression would do) and confirm the same preflight
      // abort pull()'s docblock describes actually reproduces.
      const remoteDirE = await makeBareRemote();

      const gitDirE = await mktempTracked('sh-gitdir-15he-');
      const domainsE = await mktempTracked('sh-domains-15he-');
      await initRepo(gitDirE, domainsE, remoteDirE);
      await mkdir(path.join(domainsE, 'articles', 'wiki', '.obsidian'), { recursive: true });
      await writeFile(path.join(domainsE, 'articles', 'CLAUDE.md'), '# schema\n');
      await writeFile(path.join(domainsE, 'articles', 'wiki', '.obsidian', 'workspace.json'), '{"pane":"e-base"}');
      sh(gitDirE, domainsE, 'add -A');
      sh(gitDirE, domainsE, '-c user.email=e@e -c user.name=e commit -q -m base');
      sh(gitDirE, domainsE, 'push -u origin main -q');

      const gitDirF = await mktempTracked('sh-gitdir-15hf-');
      const domainsF = await mktempTracked('sh-domains-15hf-');
      const configF = path.join(await mktempTracked('sh-cfg-15hf-'), 'sync-config.json');
      await mkdir(domainsF, { recursive: true });
      sh(gitDirF, domainsF, 'init -q -b main');
      configureRepoIdentity(gitDirF, domainsF, { email: 'f@f', name: 'f' });
      sh(gitDirF, domainsF, `remote add origin "${remoteDirE}"`);
      sh(gitDirF, domainsF, 'fetch origin -q');
      sh(gitDirF, domainsF, 'checkout -q -b main origin/main');
      await writeConfig(configF, remoteDirE);
      assertTrue(trackedFiles(gitDirF, domainsF).includes('articles/wiki/.obsidian/workspace.json'),
        'precondition: F starts in sync with E — workspace.json is tracked on both');

      // E moves a pane again and pushes — the trigger condition (origin
      // still/again carries the path as TRACKED).
      await writeFile(path.join(domainsE, 'articles', 'wiki', '.obsidian', 'workspace.json'), '{"pane":"e-moved-again"}');
      sh(gitDirE, domainsE, 'add -A');
      sh(gitDirE, domainsE, '-c user.email=e@e -c user.name=e commit -q -m "E moves a pane"');
      sh(gitDirE, domainsE, 'push origin main -q');

      // Reproduce the WRONG order by hand: call the REAL exported untrack
      // functions on F BEFORE fetching/merging E's new push — this is
      // exactly what a future regression that moved these two calls back
      // above the merge would do on F's next pull().
      __setSyncTestOverrides({ gitDir: gitDirF, configFile: configF });
      __setDomainsDirOverride(domainsF);
      const preUntracked = [
        ...(await untrackStaleObsidianWorkspace()),
        ...(await untrackStaleObsidianLeftovers()),
      ];
      assertTrue(preUntracked.includes('articles/wiki/.obsidian/workspace.json'),
        'the real untrackStaleObsidianWorkspace() ran (out of order, on purpose) and untracked F\'s workspace.json');
      assertTrue(!trackedFiles(gitDirF, domainsF).includes('articles/wiki/.obsidian/workspace.json'),
        'F\'s workspace.json is now untracked but still physically present — the exact precondition the docblock names');
      assertTrue(existsSync(path.join(domainsF, 'articles', 'wiki', '.obsidian', 'workspace.json')),
        'the file itself is untouched on disk (untrack never deletes)');

      // Commit the untrack (mirrors what a real cycle would do — pull()
      // itself commits any staged untrack) so the working tree is clean
      // going into the merge attempt below, isolating the untracked-FILE
      // preflight check from an unrelated "uncommitted changes" complaint.
      sh(gitDirF, domainsF, '-c user.email=f@f -c user.name=f commit -q -m "F: out-of-order untrack (reproducing a regression)"');

      // Now issue the EXACT same merge command pull() uses. Because the
      // untrack ran first, origin's incoming tree still carries this path
      // as TRACKED at the same location — the documented collision.
      let mergeThrew = null;
      try {
        sh(gitDirF, domainsF, 'fetch origin main -q');
        sh(gitDirF, domainsF, 'pull --no-rebase -X theirs origin main');
      } catch (e) {
        mergeThrew = e;
      }
      const mergeDetail = mergeThrew ? `${mergeThrew.message || ''} ${mergeThrew.stderr ? mergeThrew.stderr.toString('utf8') : ''}` : '';
      assertTrue(mergeThrew !== null && /untracked working tree files would be overwritten/.test(mergeDetail),
        `RED CONFIRMED — calling the real untrackStaleObsidianWorkspace()/untrackStaleObsidianLeftovers() BEFORE the merge (the pre-fix/regressed ordering) reproduces the exact documented preflight abort ("untracked working tree files would be overwritten by merge... Aborting") against real git (got: ${JSON.stringify(mergeDetail.slice(0, 200))})`);

      // Restore: leave the module-level overrides pointed at a scenario
      // later sections don't depend on (they each set their own before use);
      // nothing on disk outside the tempdirs was ever touched, and F's own
      // tempdir is abandoned (cleaned up in the top-level finally) rather
      // than repaired, since the whole point was to break it on purpose.
    }
  }

  // ── 17. Bidirectional sync REPORTS BOTH DIRECTIONS (v3.9.1 defect 1) ─────
  //
  // Until v3.9.1 the /next Sync view answered the primary "Sync now" action
  // with the bare string 'Sync complete.' — no counts, no directions — while
  // push-only and pull-only each reported theirs. The maintainer hit it on a
  // real two-machine setup: "it is not clear what we pushed, how many files,
  // and what we pulled".
  //
  // THE POINT OF DOING IT THIS WAY: the fix is one line of frontend copy, and
  // a frontend-only test would prove nothing about whether the numbers it
  // prints actually exist. So this drives the REAL sync() against REAL git
  // repos and feeds its REAL return value into the REAL renderer. If the
  // route or brain ever stops carrying a direction, this goes red on the
  // rendered sentence — which is the failure the user would actually see.
  console.log('\n17. sync() reports BOTH directions — real repos, real renderer\n');
  {
    const syncViewSrc = await readFile(path.join(ROOT, 'src/public/next/views/sync.js'), 'utf8');
    const view = new Function(
      extractConst(syncViewSrc, 'PRUNED_NAMES_SHOWN', 'views/sync.js') + '\n' +
      extractFn(syncViewSrc, 'fileCount', 'views/sync.js') + '\n' +
      extractFn(syncViewSrc, 'describePruned', 'views/sync.js') + '\n' +
      extractFn(syncViewSrc, 'describeResult', 'views/sync.js') + '\n' +
      'return { describeResult, describePruned };'
    )();

    const remoteDir = await makeBareRemote();

    // Machine A: two domains, pushed.
    const gitDirA = await mktempTracked('sh-gitdir-17a-');
    const domainsA = await mktempTracked('sh-domains-17a-');
    const configA = path.join(await mktempTracked('sh-cfg-17a-'), 'sync-config.json');
    await initRepo(gitDirA, domainsA, remoteDir);
    await writeConfig(configA, remoteDir);
    await seedDomain(domainsA, 'articles');
    await seedDomain(domainsA, 'ghost');
    __setSyncTestOverrides({ gitDir: gitDirA, configFile: configA });
    __setDomainsDirOverride(domainsA);
    await withGitLockRetry(() => push());

    // Machine B: clone.
    const gitDirB = await mktempTracked('sh-gitdir-17b-');
    const domainsB = await mktempTracked('sh-domains-17b-');
    const configB = path.join(await mktempTracked('sh-cfg-17b-'), 'sync-config.json');
    await mkdir(domainsB, { recursive: true });
    sh(gitDirB, domainsB, 'init -q -b main');
    configureRepoIdentity(gitDirB, domainsB, { email: 't@t', name: 't' });
    sh(gitDirB, domainsB, `remote add origin "${remoteDir}"`);
    sh(gitDirB, domainsB, 'fetch origin -q');
    sh(gitDirB, domainsB, 'checkout -q -b main origin/main');
    await writeConfig(configB, remoteDir);

    // A moves on: adds two pages AND deletes the whole `ghost` domain — the
    // v2.3.4 sync-delete that pruneGhostDomainDirs() cleans up on the other
    // machine, and that the old app named explicitly in its result copy.
    __setSyncTestOverrides({ gitDir: gitDirA, configFile: configA });
    __setDomainsDirOverride(domainsA);
    await writeFile(path.join(domainsA, 'articles', 'wiki', 'a1.md'), '# a1\n');
    await writeFile(path.join(domainsA, 'articles', 'wiki', 'a2.md'), '# a2\n');
    await rm(path.join(domainsA, 'ghost'), { recursive: true, force: true });
    await withGitLockRetry(() => push());

    // B makes its own local change, so this is a genuine BOTH-directions sync.
    __setSyncTestOverrides({ gitDir: gitDirB, configFile: configB });
    __setDomainsDirOverride(domainsB);
    await writeFile(path.join(domainsB, 'articles', 'wiki', 'b1.md'), '# b1\n');

    // B also has a gitignored source file inside the doomed domain — which is
    // WHY a ghost directory exists at all. The merge deletes every TRACKED
    // file under `ghost/`, but git will not remove a directory that still
    // holds untracked content, so `ghost/` survives as an empty-looking shell
    // with no CLAUDE.md — invisible in the Domains list (the v2.3.4
    // ghost-domain rule) until pruneGhostDomainDirs() clears it. `*/raw/` is
    // gitignored, so this is the ordinary real-world case, not a contrivance.
    await mkdir(path.join(domainsB, 'ghost', 'raw'), { recursive: true });
    await writeFile(path.join(domainsB, 'ghost', 'raw', 'paper.pdf'), 'not really a pdf');

    const result = await withGitLockRetry(() => sync());

    // (a) The wire genuinely carries both directions.
    assertTrue(result && result.pullResult && result.pushResult,
      'POST /api/sync/sync payload carries BOTH pullResult and pushResult');
    const pulledN = result.pullResult.filesChanged;
    const pushedN = result.pushResult.filesChanged;
    assertTrue(typeof pulledN === 'number' && pulledN > 0,
      `pullResult.filesChanged is a real count (got ${pulledN})`);
    assertTrue(typeof pushedN === 'number' && pushedN > 0,
      `pushResult.filesChanged is a real count (got ${pushedN})`);
    assertTrue(Array.isArray(result.pullResult.pruned) && result.pullResult.pruned.includes('ghost'),
      'pullResult.pruned names the domain deleted on the other machine');

    // (b) The renderer prints them. These are the assertions that would have
    //     caught the regression: the old code returned a constant string, so
    //     no count could ever appear in it.
    const msg = view.describeResult('sync', result);
    assertTrue(msg !== 'Sync complete.',
      'the bidirectional message is no longer the countless constant "Sync complete."');
    assertTrue(msg.includes('pulled ' + pulledN + ' file'),
      `the message states the PULLED count (${pulledN}) — got: ${msg}`);
    assertTrue(msg.includes('pushed ' + pushedN + ' file'),
      `the message states the PUSHED count (${pushedN}) — got: ${msg}`);
    assertTrue(msg.includes('removed 1 deleted domain (ghost)'),
      `the message names the pruned domain — got: ${msg}`);

    // (c) The two directions stay DISTINCT facts. A single combined total
    //     would be meaningless (they describe different machines) and would
    //     point the user at the wrong action.
    assertTrue(pulledN !== pushedN,
      `precondition: the two counts differ (${pulledN} vs ${pushedN}), so this check cannot pass by coincidence`);
    assertTrue(!msg.includes(' ' + String(pulledN + pushedN) + ' file'),
      `the summed total (${pulledN + pushedN}) never appears as a file count — got: ${msg}`);

    // (d) A no-op sync must not invent activity.
    const quiet = view.describeResult('sync', {
      pullResult: { pulled: true, filesChanged: 0, pruned: [] },
      pushResult: { pushed: false, filesChanged: 0 },
    });
    assertEq(quiet, 'Sync complete — everything was already up to date.',
      'a sync with nothing to do says so plainly');

    // (e) A push that never ran is never reported as a push, even if a stale
    //     filesChanged came along with it.
    const notPushed = view.describeResult('sync', {
      pullResult: { pulled: true, filesChanged: 3, pruned: [] },
      pushResult: { pushed: false, filesChanged: 7 },
    });
    assertTrue(notPushed.includes('pulled 3 files') && !notPushed.includes('pushed'),
      'pushed:false suppresses the push clause even when filesChanged is non-zero');

    // (f) Pull-only ALSO surfaces pruned domains (the shipping app did; /next
    //     dropped it in the same function).
    const pullMsg = view.describeResult('pull', { pulled: true, filesChanged: 4, pruned: ['old-domain'] });
    assertTrue(pullMsg.includes('Pulled 4 files') && pullMsg.includes('removed 1 deleted domain (old-domain)'),
      'pull-only names pruned domains as well as the file count');
    assertEq(view.describeResult('pull', { pulled: true, filesChanged: 0, pruned: [] }),
      'Already up to date — nothing new on GitHub.',
      'a pull with nothing incoming says "already up to date", not "Pulled 0 files"');

    // (g) Singular/plural, and the pruned-name cap.
    assertTrue(view.describeResult('pull', { filesChanged: 1, pruned: [] }).includes('1 file from'),
      'one file is singular');
    const many = view.describePruned(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    assertTrue(many.includes('removed 7 deleted domains') && many.includes('and 2 more'),
      'the pruned name list is capped and says how many more');
  }

  // ── 18. getRemoteStatus(): "what is waiting on GitHub" (v3.9.1 defect 2) ──
  //
  // NEW CAPABILITY, not a restoration — nothing in this codebase has ever
  // computed "behind". The shipping badge and /next's both read
  // `git status --porcelain`, which is local-only by construction.
  //
  // The assertions that matter are the dishonest-failure ones: a check we
  // could not perform must resolve to null, never to a reassuring 0.
  console.log('\n18. getRemoteStatus() — behind-count, failure honesty, and no tree mutation\n');
  {
    async function treeChecksum(dir) {
      const h = createHash('sha256');
      async function walk(d, rel) {
        const entries = (await readdir(d, { withFileTypes: true }))
          .sort((a, b) => (a.name < b.name ? -1 : 1));
        for (const e of entries) {
          const p = path.join(d, e.name);
          const r = rel ? rel + '/' + e.name : e.name;
          if (e.isDirectory()) { h.update('D:' + r + '\n'); await walk(p, r); }
          else { h.update('F:' + r + '\n'); h.update(await readFile(p)); }
        }
      }
      await walk(dir, '');
      return h.digest('hex');
    }

    const remoteDir = await makeBareRemote();

    const gitDirA = await mktempTracked('sh-gitdir-18a-');
    const domainsA = await mktempTracked('sh-domains-18a-');
    const configA = path.join(await mktempTracked('sh-cfg-18a-'), 'sync-config.json');
    await initRepo(gitDirA, domainsA, remoteDir);
    await writeConfig(configA, remoteDir);
    await seedDomain(domainsA, 'articles');
    __setSyncTestOverrides({ gitDir: gitDirA, configFile: configA });
    __setDomainsDirOverride(domainsA);
    await withGitLockRetry(() => push());

    const gitDirB = await mktempTracked('sh-gitdir-18b-');
    const domainsB = await mktempTracked('sh-domains-18b-');
    const configB = path.join(await mktempTracked('sh-cfg-18b-'), 'sync-config.json');
    await mkdir(domainsB, { recursive: true });
    sh(gitDirB, domainsB, 'init -q -b main');
    configureRepoIdentity(gitDirB, domainsB, { email: 't@t', name: 't' });
    sh(gitDirB, domainsB, `remote add origin "${remoteDir}"`);
    sh(gitDirB, domainsB, 'fetch origin -q');
    sh(gitDirB, domainsB, 'checkout -q -b main origin/main');
    await writeConfig(configB, remoteDir);

    __setSyncTestOverrides({ gitDir: gitDirB, configFile: configB });
    __setDomainsDirOverride(domainsB);

    // (a) Fully in sync → a MEASURED zero (not null).
    invalidateRemoteCache();
    const rs0 = await getRemoteStatus();
    assertEq(rs0.configured, true, 'configured repo reports configured:true');
    assertEq(rs0.remoteChecked, true, 'an in-sync check completes');
    assertEq(rs0.behindFiles, 0, 'nothing waiting on GitHub is a measured 0');

    // (b) A pushes three files → B is behind by exactly three.
    __setSyncTestOverrides({ gitDir: gitDirA, configFile: configA });
    __setDomainsDirOverride(domainsA);
    for (const n of ['r1.md', 'r2.md', 'r3.md']) {
      await writeFile(path.join(domainsA, 'articles', 'wiki', n), '# ' + n + '\n');
    }
    await withGitLockRetry(() => push());

    __setSyncTestOverrides({ gitDir: gitDirB, configFile: configB });
    __setDomainsDirOverride(domainsB);

    // (b) + (c) are ONE measured call, and that ordering is deliberate.
    //
    // They were originally two — count first, then a separate checksummed
    // call. A mutation (fetch -> pull) proved that arrangement useless: the
    // FIRST call had already pulled the files, so by the time the checksum
    // ran there was nothing left to change and the tree-immutability
    // assertion stayed GREEN against an implementation that demonstrably
    // mutated the tree. It was measuring a state the mutation had already
    // consumed.
    //
    // So the checksum now wraps the very first remote check taken while
    // there IS something on the remote to wrongly pull, and the behind
    // count is read from that same call.
    const before = await treeChecksum(domainsB);
    const dirtyBefore = execSync(
      `git --git-dir="${gitDirB}" --work-tree="${domainsB}" status --porcelain`
    ).toString('utf8');

    invalidateRemoteCache();
    const rs1 = await getRemoteStatus();

    const after = await treeChecksum(domainsB);
    const dirtyAfter = execSync(
      `git --git-dir="${gitDirB}" --work-tree="${domainsB}" status --porcelain`
    ).toString('utf8');

    assertEq(rs1.remoteChecked, true, 'the behind check completes against a live remote');
    assertEq(rs1.behindFiles, 3, 'behind count is the exact number of files waiting to pull');
    assertTrue(rs1.behindCommits >= 1, 'behind commit count is populated too');

    // THE FETCH MUST NOT TOUCH THE WORKING TREE. A badge that silently
    // modified the user's files on a 10-minute background timer would be far
    // worse than the missing number it exists to show.
    assertEq(after, before, 'the working tree is byte-identical across a remote-status check');
    assertEq(dirtyAfter, dirtyBefore, 'git status --porcelain is unchanged — nothing was merged or checked out');
    assertTrue(!existsSync(path.join(domainsB, 'articles', 'wiki', 'r1.md')),
      'a file only present on the remote is still NOT on disk — the check fetched, it did not pull');

    // (d) The TTL cache serves a second call without going to the network.
    //     Proven by making the network impossible between the two calls: if
    //     the cached call had re-fetched, it would fail.
    invalidateRemoteCache();
    const fresh = await getRemoteStatus();
    assertEq(fresh.cached, false, 'the first call after invalidation is a real check');
    const savedRemote = remoteDir + '-moved';
    execSync(`mv "${remoteDir}" "${savedRemote}"`);
    const cached = await getRemoteStatus();
    assertEq(cached.cached, true, 'a second call inside the TTL is served from cache');
    assertEq(cached.behindFiles, fresh.behindFiles, 'the cached answer matches the measured one');

    // (e) FAILURE HONESTY — with the remote gone and the cache expired, the
    //     check cannot run. It must report "unknown", NEVER a confident 0.
    const failed = await getRemoteStatus({ maxAgeMs: 0 });
    assertEq(failed.remoteChecked, false, 'an unreachable remote reports remoteChecked:false');
    assertEq(failed.behindFiles, null, 'a FAILED check is null — never 0, which would mean "nothing waiting"');
    assertEq(failed.behindCommits, null, 'the commit count is null on failure too');
    assertTrue(typeof failed.remoteError === 'string' && failed.remoteError.length > 0,
      'the failure carries an explanation');
    assertTrue(!/[A-Za-z0-9_]{20,}@/.test(failed.remoteError),
      'the failure message carries no credential-shaped token');
    // This endpoint is polled in the background, so its error field is on the
    // wire continuously. A live run against an unreachable remote originally
    // leaked TWO absolute paths here (git echoes its own --git-dir/--work-tree
    // arguments) — the v3.3.0 path-leak shape.
    assertTrue(!failed.remoteError.includes('/'),
      `the failure message carries no filesystem path — got: ${failed.remoteError}`);
    assertTrue(!/--git-dir|--work-tree|Command failed/.test(failed.remoteError),
      'the failure message is a written sentence, not a raw git invocation');
    assertTrue(failed.remoteError.length < 200,
      'the failure message is bounded, not an unbounded git transcript');

    execSync(`mv "${savedRemote}" "${remoteDir}"`);

    // (f) After a real pull, nothing is waiting any more — and the cache was
    //     invalidated by pull() itself, so this is a fresh measurement.
    invalidateRemoteCache();
    assertEq((await getRemoteStatus()).behindFiles, 3, 'precondition: still 3 waiting before the pull');
    await withGitLockRetry(() => pull());
    const afterPull = await getRemoteStatus();
    assertEq(afterPull.cached, false, 'pull() invalidated the cache, so this is a fresh check');
    assertEq(afterPull.behindFiles, 0, 'after pulling, nothing is waiting on GitHub');
    assertTrue(existsSync(path.join(domainsB, 'articles', 'wiki', 'r1.md')),
      'the pull genuinely brought the files down');

    // (g) SINGLE DERIVATION: the badge count and pull()'s own report come
    //     from the same countIncoming(), so they cannot disagree.
    __setSyncTestOverrides({ gitDir: gitDirA, configFile: configA });
    __setDomainsDirOverride(domainsA);
    await writeFile(path.join(domainsA, 'articles', 'wiki', 'r4.md'), '# r4\n');
    await withGitLockRetry(() => push());
    __setSyncTestOverrides({ gitDir: gitDirB, configFile: configB });
    __setDomainsDirOverride(domainsB);
    invalidateRemoteCache();
    const predicted = (await getRemoteStatus()).behindFiles;
    const actual = (await withGitLockRetry(() => pull())).filesChanged;
    assertEq(predicted, actual,
      'the number the badge promises is exactly the number the pull then reports');

    // (h) An unconfigured install never reaches the network at all.
    __setSyncTestOverrides({ gitDir: path.join(await mktempTracked('sh-nogit-18-'), 'nope'), configFile: path.join(await mktempTracked('sh-nocfg-18-'), 'nope.json') });
    invalidateRemoteCache();
    const unconf = await getRemoteStatus();
    assertEq(unconf.configured, false, 'an unconfigured install returns configured:false');
    assertTrue(!('behindFiles' in unconf), 'and carries no behind count to misread');

    assertTrue(REMOTE_CHECK_TTL_MS >= 60_000,
      'the server-side TTL is at least a minute, so a chatty client cannot hammer GitHub');
    assertTrue(REMOTE_CHECK_FAILURE_TTL_MS < REMOTE_CHECK_TTL_MS,
      'a FAILED check is retried sooner than a successful one is refreshed');
    assertTrue(REMOTE_CHECK_FAILURE_TTL_MS >= 30_000,
      'but a failure is still cached long enough that a flapping network cannot hammer GitHub');

    // (i) A failure must not pin "unknown" for the whole success TTL. The
    //     network conditions that break a fetch (lid closed, VPN dropped,
    //     captive portal) clear in seconds; a five-minute stale "could not
    //     check" reads as a broken feature.
    // The asymmetry is asserted on the pure TTL decision, NOT by waiting a
    // real minute for a cache to expire. A timing-based assertion here would
    // be the flaky-under-load kind v3.9.0 deleted; this is deterministic and
    // says exactly the same thing.
    assertEq(remoteCacheTtl({ remoteChecked: true }, REMOTE_CHECK_TTL_MS), REMOTE_CHECK_TTL_MS,
      'a SUCCESSFUL check is cached for the full TTL');
    assertEq(remoteCacheTtl({ remoteChecked: false }, REMOTE_CHECK_TTL_MS), REMOTE_CHECK_FAILURE_TTL_MS,
      'a FAILED check is cached only for the much shorter failure TTL, so it recovers quickly');
    assertEq(remoteCacheTtl({ remoteChecked: false }, 5_000), 5_000,
      'a caller asking for fresher data than the failure TTL still gets it (min, never max)');
    assertEq(remoteCacheTtl({ remoteChecked: true }, 0), 0,
      'maxAgeMs 0 forces a refresh even for a success');
    assertEq(remoteCacheTtl(null, REMOTE_CHECK_TTL_MS), REMOTE_CHECK_FAILURE_TTL_MS,
      'a malformed cached payload is treated as a failure, never cached for the long TTL');
  }

  // ── 18b. The two fetch sites, and the race between them (v3.9.1 blocker) ─
  //
  // v3.9.1 added getRemoteStatus(), giving this module a SECOND `git fetch`
  // site alongside the one pull() has always had. Both write
  // refs/remotes/origin/main, so concurrently they are a compare-and-swap
  // race on that ref — and pull()'s fetch sat OUTSIDE its try/catch, so the
  // loser was the USER'S PULL: it threw before the merge and the sync
  // silently did not happen. Reproduced against real git with a bare local
  // remote at 11 failures in 12 before the fix.
  //
  // Every assertion below is on an OUTCOME — did the pull succeed, did the
  // page land on disk, how many real fetch subprocesses ran — never on a
  // duration or a ratio. v3.9.0 deleted a timing assertion that failed 73%
  // of the time under CI load while the code under it was provably correct;
  // a race is exactly where that temptation is strongest and exactly where
  // it teaches people to ignore the guard.
  console.log('\n18b. fetch serialisation, coalescing, cache keying, and the pull-vs-badge race\n');
  {
    // (a) THE CLASS INVARIANT. Exactly one raw fetch invocation of the git()
    //     helper exists in sync.js — the one inside gitFetch(). This is
    //     deliberately not "each known site is wrapped": this project's
    //     named recurring defect is a guard applied to the instance in front
    //     of its author while a sibling doing identical work stays
    //     unprotected (v3.6.0 shipped four in one release). Written as a
    //     count so a FOURTH site added later goes red on its own.
    //
    //     Comment lines are dropped first, by a filter that can only ever
    //     UNDER-strip (a block comment's continuation lines start with `*`,
    //     which is covered; anything it misses leaves a comment in and
    //     produces a false POSITIVE). That direction is chosen on purpose —
    //     a false positive is a red test someone reads, a false negative is
    //     this bug shipping again. No hand-rolled lexer: v3.1.0 shipped two
    //     of those and both were silently blind.
    const syncSrc = await readFile(path.join(ROOT, 'src/brain/sync.js'), 'utf8');
    const codeLines = syncSrc.split('\n').filter((l) => {
      const t = l.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    });
    const rawFetchSites = codeLines.filter((l) => /\bgit\(\s*[`'"]fetch\b/.test(l));
    assertEq(rawFetchSites.length, 1,
      'sync.js contains EXACTLY ONE raw git fetch invocation (inside gitFetch) — every other site must go through the gate');
    const gateBody = syncSrc.slice(syncSrc.indexOf('function gitFetch('));
    assertTrue(/\bgit\(\s*`fetch \$\{args\}`/.test(gateBody.slice(0, 500)),
      'and that one invocation is gitFetch\'s own');
    // Every caller reaches fetch through the gate, so the callers are named
    // here too — a site could otherwise "pass" (a) by not fetching at all.
    const gateCalls = codeLines
      .filter((l) => !/function gitFetch\(/.test(l))
      .join('\n').match(/\bgitFetch\(/g) || [];
    assertEq(gateCalls.length, 3,
      'all three fetch callers (getRemoteStatus, setup, pull) go through gitFetch');

    // (b) THE BLOCKER ITSELF, end to end against real git. A background
    //     badge check runs concurrently with the user's pull, exactly as the
    //     Sync view produced it: click Push, buttons re-enable, click Sync
    //     now. Asserted on whether the user's sync actually HAPPENED, not
    //     merely on whether an error was raised — a fix that made pull()
    //     stop throwing while also not merging would pass the weaker check.
    const remote19 = await makeBareRemote();
    const gitA19 = await mktempTracked('sh-gitdir-19a-');
    const domA19 = await mktempTracked('sh-domains-19a-');
    await initRepo(gitA19, domA19, remote19);
    await seedDomain(domA19, 'd1');
    sh(gitA19, domA19, 'add -A'); sh(gitA19, domA19, 'commit -q -m base'); sh(gitA19, domA19, 'push -q -u origin main');

    const gitB19 = await mktempTracked('sh-gitdir-19b-');
    const domB19 = await mktempTracked('sh-domains-19b-');
    const cfgB19 = path.join(await mktempTracked('sh-cfg-19b-'), 'sync-config.json');
    await initRepo(gitB19, domB19, remote19);
    sh(gitB19, domB19, 'fetch -q origin main'); sh(gitB19, domB19, 'reset -q --hard origin/main');
    await writeConfig(cfgB19, remote19);
    __setSyncTestOverrides({ gitDir: gitB19, configFile: cfgB19 });
    __setDomainsDirOverride(domB19);

    const ROUNDS = 12;
    let pullOk = 0; let pullFailed = 0; let landed = 0; let zeroCount = 0;
    let firstErr = '';
    for (let i = 0; i < ROUNDS; i++) {
      // Advance the remote so origin/main MUST move — a fetch that has
      // nothing to update takes no ref lock and races nothing, so without
      // this the scenario would silently never be exercised.
      await writeFile(path.join(domA19, 'd1', 'wiki', `p${i}.md`), `# page ${i}\n`);
      sh(gitA19, domA19, 'add -A'); sh(gitA19, domA19, `commit -q -m adv${i}`); sh(gitA19, domA19, 'push -q origin main');

      invalidateRemoteCache();
      const background = getRemoteStatus({ maxAgeMs: 0 }).catch(() => null);
      try {
        const r = await pull();
        pullOk++;
        if ((r.filesChanged || 0) === 0) zeroCount++;
      } catch (err) {
        pullFailed++;
        if (!firstErr) firstErr = err.message;
      }
      await background;
      if (existsSync(path.join(domB19, 'd1', 'wiki', `p${i}.md`))) landed++;
    }
    assertEq(pullFailed, 0,
      `the user's pull survives a concurrent background remote check, ${ROUNDS}/${ROUNDS}` +
      (firstErr ? ` — first failure: ${firstErr.slice(0, 120)}` : ''));
    assertEq(pullOk, ROUNDS, 'every pull returned a result');
    assertEq(landed, ROUNDS,
      'and every pull ACTUALLY MERGED — the incoming page is on disk, not merely un-errored');
    assertEq(zeroCount, 0,
      'and none reported filesChanged:0 for a pull that really moved a file (a wrong number is worse than an error)');

    // (b2) THE CROSS-PROCESS CASE — and this is the assertion that keeps
    //      pull()'s own tolerance from being decorative. gitFetch()'s gate
    //      is per-PROCESS: it cannot see the MCP server Claude Desktop
    //      spawns against the same git dir, or a second app instance. With
    //      the gate in place but pull()'s fetch moved back outside its try
    //      (the shipped defect), scenario (b) above stays fully GREEN —
    //      measured — because the gate alone prevents the in-process
    //      collision. Only a genuinely EXTERNAL fetch exercises the second
    //      layer, so that is what this spawns: a real `git fetch`
    //      subprocess, not a stub. Under that same mutation this scenario
    //      goes red at 11 failures in 12 with just 1 of 12 pages merged.
    //
    //      Stability: the assertion is that the user's pull SUCCEEDS, which
    //      is deterministic with the fix — `git pull` runs its own fetch and
    //      merges FETCH_HEAD, so a lost ref race cannot affect it (verified
    //      60/60 across five runs). Nothing here asserts a duration, and
    //      nothing depends on the race actually firing on any given round.
    let xOk = 0; let xFailed = 0; let xLanded = 0; let xFirstErr = '';
    for (let i = 0; i < ROUNDS; i++) {
      await writeFile(path.join(domA19, 'd1', 'wiki', `x${i}.md`), `# external ${i}\n`);
      sh(gitA19, domA19, 'add -A'); sh(gitA19, domA19, `commit -q -m ext${i}`); sh(gitA19, domA19, 'push -q origin main');

      const external = spawn('git',
        [`--git-dir=${gitB19}`, `--work-tree=${domB19}`, 'fetch', 'origin', 'main'],
        { stdio: 'ignore' });
      const externalDone = new Promise((r) => external.on('close', r));
      try { await pull(); xOk++; } catch (err) { xFailed++; if (!xFirstErr) xFirstErr = err.message; }
      await externalDone;
      if (existsSync(path.join(domB19, 'd1', 'wiki', `x${i}.md`))) xLanded++;
    }
    assertEq(xFailed, 0,
      `the user's pull survives a fetch from a SEPARATE process, ${ROUNDS}/${ROUNDS}` +
      (xFirstErr ? ` — first failure: ${xFirstErr.split('\n').pop().slice(0, 110)}` : ''));
    assertEq(xOk, ROUNDS, 'every cross-process pull returned a result');
    assertEq(xLanded, ROUNDS,
      'and every one ACTUALLY MERGED — this is the assertion pull()\'s try/catch is load-bearing for');

    // (c) COALESCING. The TTL cache is read before the await and written
    //     after it, so it never bounded CONCURRENT callers: measured at 40
    //     concurrent calls it produced 40 real fetch subprocesses and zero
    //     hits. The in-flight memo is what makes the docblock's "at most
    //     once per TTL per process" true. Counted on the call itself, so
    //     this asserts what actually ran.
    invalidateRemoteCache();
    syncTesting.resetFetchCount();
    const burst = await Promise.all(Array.from({ length: 40 }, () => getRemoteStatus({ maxAgeMs: 0 })));
    assertEq(syncTesting.fetchCount(), 1,
      '40 concurrent remote checks issue exactly ONE real git fetch subprocess');
    assertEq(new Set(burst.map((b) => b.behindFiles)).size, 1,
      'and every coalesced caller receives the same answer');
    assertTrue(burst.every((b) => b.remoteChecked === true),
      'and not one of them is degraded to "could not check" by racing a sibling');

    // The N=2 case is called out separately because it is not a stress
    // test — it is two browser tabs booting, and before the memo one of the
    // two checks failed outright.
    invalidateRemoteCache();
    syncTesting.resetFetchCount();
    const twoTabs = await Promise.all([getRemoteStatus({ maxAgeMs: 0 }), getRemoteStatus({ maxAgeMs: 0 })]);
    assertEq(syncTesting.fetchCount(), 1, 'two tabs booting together issue ONE fetch, not two');
    assertTrue(twoTabs.every((b) => b.remoteChecked === true), 'and both get a real answer');

    // (d) THE GATE MUST SURVIVE A REJECTION. It chains promises; chaining
    //     the un-caught promise instead of its settled form would wedge
    //     every later fetch in the process after the first failure — a
    //     permanently dead badge, and a permanently mis-counted pull.
    const deadCfg = path.join(await mktempTracked('sh-cfg-19dead-'), 'sync-config.json');
    await writeConfig(deadCfg, '/nonexistent-remote-for-gate-test');
    const deadGit = await mktempTracked('sh-gitdir-19dead-');
    const deadDom = await mktempTracked('sh-domains-19dead-');
    await initRepo(deadGit, deadDom, '/nonexistent-remote-for-gate-test');
    __setSyncTestOverrides({ gitDir: deadGit, configFile: deadCfg });
    __setDomainsDirOverride(deadDom);
    invalidateRemoteCache();
    const broke = await getRemoteStatus({ maxAgeMs: 0 });
    assertEq(broke.remoteChecked, false, 'precondition: a fetch against a nonexistent remote fails');
    // Back to the working repo — the gate must not still be poisoned.
    __setSyncTestOverrides({ gitDir: gitB19, configFile: cfgB19 });
    __setDomainsDirOverride(domB19);
    invalidateRemoteCache();
    const recovered = await getRemoteStatus({ maxAgeMs: 0 });
    assertEq(recovered.remoteChecked, true,
      'a FAILED fetch does not wedge the gate — the next fetch still runs');

    // (e) THE CACHE IS KEYED ON THE REPOSITORY. invalidateRemoteCache() is
    //     called by push()/pull() but NOT by setup()/disconnect(), so the
    //     ordinary "wrong repo, let me redo it" flow used to keep answering
    //     with the OLD repo's number for a full TTL — measured, the rail
    //     showed "waiting to pull" for a repo with nothing waiting. No
    //     invalidate() call is issued between the two reads below, on
    //     purpose: that is the whole point.
    // (b) above pulled repo1 empty, so give it something to be behind by
    // again — the property under test is the CACHE KEY, and it can only be
    // exercised from a non-zero starting number.
    await writeFile(path.join(domA19, 'd1', 'wiki', 'keytest.md'), '# key test\n');
    sh(gitA19, domA19, 'add -A'); sh(gitA19, domA19, 'commit -q -m keytest'); sh(gitA19, domA19, 'push -q origin main');
    invalidateRemoteCache();
    const onRepo1 = await getRemoteStatus({});
    assertTrue(onRepo1.behindFiles > 0, `precondition: repo1 has changes waiting (got ${onRepo1.behindFiles})`);

    const remote19b = await makeBareRemote();
    const gitC19 = await mktempTracked('sh-gitdir-19c-');
    const domC19 = await mktempTracked('sh-domains-19c-');
    const cfgC19 = path.join(await mktempTracked('sh-cfg-19c-'), 'sync-config.json');
    await initRepo(gitC19, domC19, remote19b);
    await seedDomain(domC19, 'd2');
    sh(gitC19, domC19, 'add -A'); sh(gitC19, domC19, 'commit -q -m base2'); sh(gitC19, domC19, 'push -q -u origin main');
    await writeConfig(cfgC19, remote19b);
    __setSyncTestOverrides({ gitDir: gitC19, configFile: cfgC19 });
    __setDomainsDirOverride(domC19);

    const onRepo2 = await getRemoteStatus({});
    assertEq(onRepo2.behindFiles, 0,
      'repointing at a different repo does NOT serve the previous repo\'s behind-count');
    assertEq(onRepo2.cached, false,
      'and the answer is reported as a live check, not as a cache hit');

    // (f) A losing ref race must never reach a user as raw git text. The
    //     gate covers this process; a separate process against the same git
    //     dir (the MCP server Claude Desktop spawns, a second app instance)
    //     is outside it, and the raw message carries absolute filesystem
    //     paths. This is the verbatim shape git emits, captured from the
    //     live reproduction.
    const refRace =
      'Command failed: git --git-dir="/Users/someone/second-brain/.knowledge-git" ' +
      '--work-tree="/Users/someone/second-brain/domains" fetch origin main\n' +
      'From /Users/someone/knowledge\n * branch main -> FETCH_HEAD\n' +
      "error: cannot lock ref 'refs/remotes/origin/main': is at 67137e158298 but expected 8ad8978e2b63\n" +
      ' ! 8ad8978..67137e1  main -> origin/main  (unable to update local ref)';
    const mappedRace = String(friendlyError(new Error(refRace)) || '');
    assertTrue(mappedRace.includes('Another sync check was running'),
      'a losing ref compare-and-swap maps to a written sentence');
    assertTrue(!/\/Users\//.test(mappedRace) && !/--git-dir/.test(mappedRace),
      'and that sentence leaks no absolute path and no git command line');
    assertTrue(!mappedRace.includes('GitHub rejected the token'),
      'and the 40-char SHAs in it do not shadow into the auth branch');
    // The polled endpoint is the one that must never carry raw git text.
    assertTrue(!/\/Users\//.test(String(remoteErrorMessage(new Error(refRace)))),
      'and the background-poll error helper leaks no absolute path either');

    //      And the same property proven on the WHOLE serialised payload
    //      rather than on one field, across four REAL git failures — this
    //      endpoint is polled in the background, so anything it carries is
    //      on the wire continuously rather than in response to a click.
    //      Scanning the serialised object (not `remoteError` alone) is the
    //      point: a future field added to the payload is covered by this
    //      without anyone remembering to extend the assertion.
    const leakCases = [
      ['a remote directory that does not exist', '/var/folders/curator-nonexistent-remote-xyz'],
      ['a remote path that is not a repository', await mktempTracked('sh-notrepo-19-')],
      ['an unresolvable host', 'https://no-such-host.invalid/o/r.git'],
      // Deliberately NOT shaped like a real provider token: this repo's
      // pre-commit secret guard matches `ghp_`/`github_pat_` + 20 chars,
      // and a test fixture must never need an allow-list entry to be
      // committable. A long opaque userinfo segment is the shape that
      // matters here anyway — it is what the assertion's `{20,}@` rule
      // detects, and it is provider-agnostic.
      ['a credential-bearing remote URL', 'https://AAAAAAAAAAAAAAAAAAAAAAAAAA@github.invalid/o/r.git'],
    ];
    for (const [label, remoteUrl] of leakCases) {
      const lg = await mktempTracked('sh-gitdir-19leak-');
      const lw = await mktempTracked('sh-domains-19leak-');
      const lc = path.join(await mktempTracked('sh-cfg-19leak-'), 'sync-config.json');
      await initRepo(lg, lw, remoteUrl);
      await writeConfig(lc, remoteUrl);
      __setSyncTestOverrides({ gitDir: lg, configFile: lc });
      __setDomainsDirOverride(lw);
      invalidateRemoteCache();
      const payload = await getRemoteStatus({ maxAgeMs: 0 });
      const blob = JSON.stringify(payload);
      assertEq(payload.remoteChecked, false, `precondition: the check fails for ${label}`);
      assertEq(payload.behindFiles, null, `and reports null, never a reassuring 0, for ${label}`);
      assertTrue(!/"[^"]*\/(Users|var|tmp|home|private)\//.test(blob),
        `the polled payload carries NO absolute path for ${label}`);
      assertTrue(!/--git-dir|--work-tree|Command failed|fatal:|error:/.test(blob),
        `and no raw git text for ${label}`);
      assertTrue(!/ghp_|github_pat_|[A-Za-z0-9_]{20,}@/.test(blob),
        `and no credential for ${label}`);
    }

    // (g) FRONTEND ORDERING. The Sync view used to re-enable its buttons and
    //     THEN fire the badge's fetch, unawaited — putting the user's own
    //     next click inside the window this section exists to close. Source
    //     guard rather than a browser drive, and scoped to the one ordering
    //     property: the awaited badge refresh must PRECEDE the line that
    //     re-enables the controls.
    const viewSrc = await readFile(path.join(ROOT, 'src/public/next/views/sync.js'), 'utf8');
    const awaitAt = viewSrc.indexOf('await refreshSyncRemoteBadge()');
    const enableAt = viewSrc.indexOf('state.acting = null;', viewSrc.indexOf('async function onAction'));
    assertTrue(awaitAt > 0, 'the Sync view AWAITS the remote badge refresh');
    assertTrue(enableAt > 0 && awaitAt < enableAt,
      'and does so BEFORE clearing `acting`, so no button is live while our own fetch runs');
    assertTrue(!/^\s*refreshSyncRemoteBadge\(\);/m.test(viewSrc),
      'no un-awaited remote badge refresh remains in the view');
  }


  // ── 19. The rail badge's decision functions, executed (v3.9.1 defect 2) ───
  console.log('\n19. Rail badge — tri-state behind count, never summed, never a false zero\n');
  {
    const appSrc = await readFile(path.join(ROOT, 'src/public/next/app.js'), 'utf8');
    const syncViewSrcForWiring = await readFile(path.join(ROOT, 'src/public/next/views/sync.js'), 'utf8');
    const badge = new Function(
      'const VIEW_META = { sync: { title: "Sync" } };\n' +
      extractFn(appSrc, 'syncBadgeTitle', 'next/app.js') + '\n' +
      extractFn(appSrc, 'syncBehindFromRemote', 'next/app.js') + '\n' +
      extractFn(appSrc, 'syncBadgeLabel', 'next/app.js') + '\n' +
      'return { syncBadgeTitle, syncBehindFromRemote, syncBadgeLabel };'
    )();

    // ── syncBehindFromRemote: the tri-state ──
    // undefined = no remote concept at all; null = tried and failed;
    // number = measured. Collapsing null into 0 is the defect.
    assertEq(badge.syncBehindFromRemote({ configured: false }), undefined,
      'sync not configured -> undefined (no remote information exists)');
    assertEq(badge.syncBehindFromRemote(null), undefined, 'a null payload -> undefined');
    assertEq(badge.syncBehindFromRemote({ configured: true, remoteChecked: true, behindFiles: 0 }), 0,
      'a MEASURED zero stays 0');
    assertEq(badge.syncBehindFromRemote({ configured: true, remoteChecked: true, behindFiles: 5 }), 5,
      'a measured five is 5');
    assertEq(badge.syncBehindFromRemote({ configured: true, remoteChecked: false, behindFiles: null }), null,
      'a FAILED check -> null, not 0');
    assertEq(badge.syncBehindFromRemote({ configured: true, remoteChecked: false, behindFiles: 0 }), null,
      'remoteChecked:false wins even if a 0 came along in the payload');
    for (const bad of ['7', null, NaN, Infinity, -2, undefined]) {
      assertEq(badge.syncBehindFromRemote({ configured: true, remoteChecked: true, behindFiles: bad }), null,
        `an unusable behindFiles (${String(bad)}) -> null, never a guessed 0`);
    }

    // ── syncBadgeLabel: the two numbers are NEVER added ──
    assertEq(badge.syncBadgeLabel(0, 0), '', 'nothing pending anywhere -> no badge');
    assertEq(badge.syncBadgeLabel(0, undefined), '', 'no local work and no remote info -> no badge');
    assertEq(badge.syncBadgeLabel(3, undefined), '3', 'local only -> the local number alone');
    assertEq(badge.syncBadgeLabel(0, 5), '↓5', 'incoming only -> the down-arrow form (the two-machine case)');
    assertEq(badge.syncBadgeLabel(3, 5), '3↓5', 'both -> both numbers, separately readable');
    assertTrue(badge.syncBadgeLabel(3, 5) !== '8', 'the two counts are NEVER summed into one number');
    assertEq(badge.syncBadgeLabel(3, null), '3', 'a failed remote check adds nothing to the badge text');
    assertEq(badge.syncBadgeLabel(0, null), '', 'a failed check alone shows no badge (the tooltip carries it)');

    // ── syncBadgeTitle: the tooltip is where the honesty lives ──
    // Single-argument behaviour must stay byte-identical — test-next-recovery-
    // and-badge.js pins these exact strings.
    assertEq(badge.syncBadgeTitle(0), 'Sync', 'one-arg zero is still the plain title');
    assertEq(badge.syncBadgeTitle(1), 'Sync — 1 local change not yet pushed to GitHub',
      'one-arg singular sentence is unchanged');
    assertEq(badge.syncBadgeTitle(2), 'Sync — 2 local changes not yet pushed to GitHub',
      'one-arg plural sentence is unchanged');
    assertEq(badge.syncBadgeTitle(0, undefined), 'Sync', 'explicit undefined behaves like the one-arg call');

    assertEq(badge.syncBadgeTitle(0, 5), 'Sync — 5 files waiting to pull from GitHub',
      'incoming-only tooltip names the pull direction');
    assertEq(badge.syncBadgeTitle(0, 1), 'Sync — 1 file waiting to pull from GitHub',
      'one incoming file is singular');
    assertEq(badge.syncBadgeTitle(2, 5),
      'Sync — 2 local changes not yet pushed to GitHub; 5 files waiting to pull from GitHub',
      'both directions are named separately in the tooltip');
    assertEq(badge.syncBadgeTitle(0, 0), 'Sync', 'a measured zero incoming adds no clause');
    assertEq(badge.syncBadgeTitle(0, null), 'Sync — could not check GitHub for incoming changes',
      'a FAILED check says so — it never renders as "you are up to date"');
    assertEq(badge.syncBadgeTitle(2, null),
      'Sync — 2 local changes not yet pushed to GitHub; could not check GitHub for incoming changes',
      'a failed check is reported alongside the local count, not instead of it');

    for (const [l, b] of [[0, 5], [2, 5], [0, null], [2, null], [1, 1]]) {
      assertTrue(!/["]/.test(badge.syncBadgeTitle(l, b)),
        `the title never emits a double quote (it is interpolated into title="…"): (${l}, ${String(b)})`);
    }

    // ── Wiring: the cost decision, pinned ──
    // The remote check must NOT be on navigate()'s hot path. If someone
    // later wires it there, every rail click becomes a GitHub round-trip.
    const navFn = extractFn(appSrc, 'navigate', 'next/app.js');
    assertTrue(!/refreshSyncRemoteBadge/.test(navFn),
      'navigate() does NOT trigger a network fetch — the remote check stays off the hot path');
    assertTrue(/refreshSyncBadge\(\)/.test(navFn),
      'navigate() still refreshes the free, local-only badge half');
    const bootFn = extractFn(appSrc, 'boot', 'next/app.js');
    assertTrue(/setInterval\(refreshSyncRemoteBadge, SYNC_REMOTE_REFRESH_MS\)/.test(bootFn),
      'boot() arms the slow remote interval');
    assertTrue(/SYNC_REMOTE_REFRESH_MS = 10 \* 60_000/.test(appSrc),
      'the remote cadence is 10 minutes — an order of magnitude slower than the local one');
    const remoteFn = extractFn(appSrc, 'refreshSyncRemoteBadge', 'next/app.js');
    assertTrue(/try \{[\s\S]*?\} catch/.test(remoteFn),
      'refreshSyncRemoteBadge() wraps its fetch in try/catch (it runs inside boot())');
    assertTrue(!/\bthrow\b/.test(remoteFn), 'refreshSyncRemoteBadge() never throws');
    assertTrue(/next = null/.test(remoteFn),
      'a failed fetch resolves to null (tried and failed), not undefined or 0');
    // The local status endpoint keeps exactly one fetch site in the shell —
    // the remote check is a DIFFERENT endpoint on a different cadence, not a
    // second poll of the same one.
    assertEq((appSrc.match(/fetch\('\/api\/sync\/status'\)/g) || []).length, 1,
      'still exactly ONE /api/sync/status fetch site in the shell');
    assertEq((appSrc.match(/fetch\('\/api\/sync\/remote-status'\)/g) || []).length, 1,
      'exactly ONE /api/sync/remote-status fetch site in the shell');

    // A push/pull/sync is the one moment BOTH badge halves are known to be
    // wrong, and the remote half is only re-checked every 10 minutes — so
    // without this the rail can keep advertising "↓5 waiting to pull" long
    // after the user pulled it.
    //
    // SOURCE SCAN, and labelled as one rather than dressed up: driving the
    // real click would need a DOM, a mounted view and a live server. This
    // asserts the calls are present in onAction's finally, NOT that they
    // fire — a call made unreachable by some future early return would still
    // pass. Added because a mutation deleting both lines left this suite
    // fully GREEN, i.e. the wiring had no coverage at all.
    const onActionFn = extractFn(syncViewSrcForWiring, 'onAction', 'views/sync.js');
    assertTrue(/refreshSyncBadge\(\)/.test(onActionFn),
      'views/sync.js repaints the LOCAL badge half after a completed sync action');
    assertTrue(/refreshSyncRemoteBadge\(\)/.test(onActionFn),
      'views/sync.js repaints the REMOTE badge half after a completed sync action');
    assertTrue(/refreshSyncBadge,\s*refreshSyncRemoteBadge/.test(syncViewSrcForWiring),
      'both refreshers are imported from the shell, not re-implemented as a second fetch path');
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
