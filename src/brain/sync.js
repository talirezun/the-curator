import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { mkdir, readFile, unlink, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { getDomainsDir } from './config.js';
import { writeFileAtomic } from './atomic-write.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT       = path.resolve(__dirname, '../..');
const GIT_DIR    = path.join(ROOT, '.knowledge-git');
const CONFIG_FILE = path.join(ROOT, '.sync-config.json');

const execAsync = promisify(exec);

// AppleScript's `do shell script` launches us with a minimal PATH. Prepend the
// usual locations for git/node/npm so subprocesses resolve them reliably.
const NODE_BIN_DIR = path.dirname(process.execPath);
const SUBPROCESS_PATH = [
  NODE_BIN_DIR, '/usr/local/bin', '/opt/homebrew/bin',
  '/usr/bin', '/bin', '/usr/sbin', '/sbin',
  process.env.PATH || '',
].filter(Boolean).join(':');
const SUBPROCESS_ENV = { ...process.env, PATH: SUBPROCESS_PATH };

// ── Internal helpers ──────────────────────────────────────────────────────────

function sanitize(str) {
  return String(str)
    .replace(/https?:\/\/[^:@\s]+:[^@\s]*@/g, 'https://***@')
    .replace(/https?:\/\/[^@\s]+@/g,           'https://***@');
}

async function git(cmd, opts = {}) {
  const full = `git --git-dir="${GIT_DIR}" --work-tree="${getDomainsDir()}" ${cmd}`;
  try {
    const { stdout, stderr } = await execAsync(full, {
      timeout: opts.timeout || 30000,
      cwd: ROOT,              // Explicit cwd prevents "getcwd: Operation not permitted" on macOS
      env: SUBPROCESS_ENV,    // Ensure git is findable under the .app wrapper's minimal PATH
    });
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err) {
    // exec's err.message includes stderr but NOT stdout. Git writes benign
    // status like "nothing to commit, working tree clean" to stdout, and the
    // callers below detect that via err.message.includes('nothing to commit').
    // Append stdout so those checks (setup commit, pull auto-save, friendlyError)
    // see it — otherwise a no-op commit crashes setup on an already-clean repo.
    const detail = err.stdout ? `${err.message}\n${err.stdout}` : err.message;
    throw new Error(sanitize(detail));
  }
}

function buildRemoteUrl(repoUrl, token) {
  let url = repoUrl.trim();
  // SSH → HTTPS
  if (url.startsWith('git@')) {
    url = url.replace(/^git@github\.com:/, 'https://github.com/');
  }
  url = url.replace(/\.git$/, '');
  const host = url.replace(/^https?:\/\//, '');
  return `https://${token}@${host}.git`;
}

function displayUrl(repoUrl) {
  return repoUrl
    .replace(/\.git$/, '')
    .replace(/^https?:\/\//, '');
}

function friendlyError(err) {
  const msg = err.message.toLowerCase();
  if (msg.includes('authentication failed') || msg.includes('403') ||
      msg.includes('401') || msg.includes('could not read username')) {
    return 'GitHub rejected the token. For a fine-grained token, make sure it has ' +
           '"Contents: Read and write" on the repo; for a classic token, make sure ' +
           'it has the "repo" scope. Also check the token hasn\'t expired.';
  }
  if (msg.includes('repository not found') || msg.includes('does not exist') ||
      msg.includes('not found')) {
    return 'Repository not found. Check the URL — it must be a private repo you own.';
  }
  if (msg.includes('could not resolve host') || msg.includes('connection refused') ||
      msg.includes('unable to access')) {
    return 'Cannot reach GitHub. Check your internet connection and try again.';
  }
  if (msg.includes('non-fast-forward') || msg.includes('rejected')) {
    return 'GitHub has changes you don\'t have locally. Click "Pull only" first (under Advanced), then sync again.';
  }
  if (msg.includes('nothing to commit')) {
    return null; // Not an error
  }
  return sanitize(err.message);
}

// ── Config ────────────────────────────────────────────────────────────────────

async function saveConfig(repoUrl, token) {
  // v3.0.1-beta.20: atomic + 0600 — .sync-config.json holds the GitHub PAT, so
  // it must not be world-readable, and a kill mid-write must not lose the token.
  await writeFileAtomic(CONFIG_FILE, JSON.stringify({ repoUrl, token }, null, 2), { mode: 0o600 });
}

async function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return null;
  try { return JSON.parse(await readFile(CONFIG_FILE, 'utf8')); } catch { return null; }
}

// ── Domains .gitignore ────────────────────────────────────────────────────────

// What we want excluded from sync, per-domain:
//   */raw/                       — uploaded source files (large, local-only)
//   */.mcp-write-log.jsonl       — MCP audit log (v2.5.2+, machine-private)
const DOMAINS_GITIGNORE_RULES = [
  '*/raw/',
  '*/.mcp-write-log.jsonl',
  // Cross-process write lock (src/brain/write-registry.js) is machine-local
  // state, not wiki content. If it's synced and a crash leaves it stale, a
  // machine that pulls it can refuse writes for up to 30 minutes because
  // isPidAlive() sees a foreign PID number.
  '*/.write-lock',
];

async function ensureDomainsGitignore() {
  const p = path.join(getDomainsDir(), '.gitignore');
  let existing = '';
  if (existsSync(p)) {
    try { existing = await readFile(p, 'utf8'); } catch {}
  }
  // A CRLF-saved .gitignore (e.g. edited on Windows, or normalised by some
  // text editor — Windows is a supported manual-install target) has a
  // trailing \r on every line. git's own gitignore parser does NOT strip
  // that \r, so a pattern written as "*/.write-lock\r" matches nothing —
  // silently. Our own existence check below runs .trim() (which DOES strip
  // \r) to decide whether a rule is "already present", so without this
  // guard we'd conclude the file is already correct and never rewrite it,
  // leaving the ineffective \r-suffixed pattern in place forever. Force a
  // rewrite (which always emits clean LF-only lines) whenever any \r is
  // found anywhere in the existing file, regardless of the trimmed match.
  const hasCarriageReturn = existing.includes('\r');
  const lines = existing.split('\n').map(l => l.trim()).filter(Boolean);
  let changed = hasCarriageReturn;
  for (const rule of DOMAINS_GITIGNORE_RULES) {
    if (!lines.includes(rule)) {
      lines.push(rule);
      changed = true;
    }
  }
  if (!existing || changed) {
    // v3.0.1-beta.20: atomic — a truncated .gitignore could let raw/ source
    // files get committed to GitHub on the next push.
    await writeFileAtomic(p, lines.join('\n') + '\n', 'utf8');
  }
}

// A gitignore rule does NOT untrack a file that's already committed — it only
// keeps NEW/untracked files out. If a `.write-lock` was committed before this
// rule existed (realistically reachable: the MCP server is a SEPARATE child
// process from the web server, so it can hold the *file* lock — see
// src/brain/write-registry.js — while the web server's in-memory write
// registry is empty; a Sync click in that window runs `git add -A` and
// commits the lock file), it would keep propagating to every machine forever.
// This walks the ACTUAL tracked paths (via `git ls-files`, never a raw shell
// glob) and untracks only the ones matching the exact expected shape.
async function untrackStaleWriteLocks() {
  let stdout;
  try {
    ({ stdout } = await git('ls-files -- "*/.write-lock"'));
  } catch {
    return []; // no repo / nothing tracked yet — safe no-op
  }
  const candidates = stdout.split('\n').map(s => s.trim()).filter(Boolean);
  const untracked = [];
  for (const p of candidates) {
    // Hard guard, stricter than a suffix check: exactly one path segment
    // (a domain slug — alnum/hyphen/underscore only, matching the domain-slug
    // validation used elsewhere, e.g. mcp/util.js's isValidSlug) followed by
    // the literal filename. No `..`, no extra `/`, no quote/`$`/backtick/
    // semicolon — nothing that could escape the quoting below and let a
    // crafted path act on any file other than the exact one `git ls-files`
    // reported. Anything that doesn't match this shape is left untouched.
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*\/\.write-lock$/.test(p)) continue;
    try {
      await git(`rm --cached --ignore-unmatch -- "${p}"`);
      untracked.push(p);
    } catch { /* best-effort — a failed untrack here must never block sync */ }
  }
  return untracked;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function isConfigured() {
  return existsSync(GIT_DIR) && existsSync(CONFIG_FILE);
}

export async function getStatus() {
  if (!isConfigured()) return { configured: false };

  const config = await loadConfig();
  try {
    const { stdout: statusOut } = await git('status --porcelain');
    const changesCount = statusOut.split('\n').filter(Boolean).length;

    let lastSync = null;
    try {
      const { stdout } = await git('log -1 --format=%ci');
      lastSync = stdout.trim() || null;
    } catch { /* no commits yet */ }

    return {
      configured: true,
      changesCount,
      lastSync,
      repoUrl: config ? displayUrl(config.repoUrl) : null,
    };
  } catch (err) {
    return { configured: true, error: sanitize(err.message) };
  }
}

export async function setup(repoUrl, token, mode) {
  await ensureDomainsGitignore();
  await mkdir(GIT_DIR, { recursive: true });

  const remoteUrl = buildRemoteUrl(repoUrl, token);

  // Init and configure git identity + auto-upstream for push
  await git('init');
  await git('config user.email "thecurator@local"');
  await git('config user.name "The Curator"');
  await git('config push.autoSetupRemote true');

  // Set remote (add or update)
  try {
    await git(`remote add origin "${remoteUrl}"`);
  } catch {
    await git(`remote set-url origin "${remoteUrl}"`);
  }

  if (mode === 'push') {
    await git('add -A');
    try {
      await git('commit -m "Initial The Curator sync"');
    } catch (err) {
      if (!err.message.includes('nothing to commit')) throw err;
    }
    await git('branch -M main');
    await git('push -u origin main', { timeout: 120000 });

  } else { // pull
    await git('fetch origin', { timeout: 120000 });
    try {
      await git('checkout -b main origin/main');
    } catch {
      try {
        await git('checkout main');
        await git('reset --hard origin/main');
      } catch {
        await git('reset --hard origin/main');
      }
    }
  }

  await saveConfig(repoUrl, token);
}

export async function push() {
  // Self-heal: existing installs configured before a DOMAINS_GITIGNORE_RULES
  // addition (e.g. the */.write-lock rule) never re-run ensureDomainsGitignore()
  // otherwise — it was previously only called from setup(). Idempotent no-op
  // when the file is already current.
  await ensureDomainsGitignore();

  // Self-heal part 2: the gitignore rule only keeps FUTURE .write-lock files
  // from being tracked — it does nothing for one already committed. Untrack
  // any that are, BEFORE the status/commit below, so the removal rides along
  // with this push's commit instead of needing a second sync round-trip.
  await untrackStaleWriteLocks();

  // Stage and commit any uncommitted changes
  const { stdout } = await git('status --porcelain');
  const uncommittedCount = stdout.split('\n').filter(Boolean).length;

  if (uncommittedCount > 0) {
    const now  = new Date();
    const date = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    await git('add -A');
    // `add -A` can legitimately cancel out everything `status --porcelain`
    // counted above — most concretely, untrackStaleWriteLocks() staging a
    // "D  <domain>/.write-lock" deletion (counted as 1+ of uncommittedCount)
    // followed by this add -A RE-ADDING that same still-on-disk file if the
    // domains .gitignore doesn't yet effectively exclude it (e.g. a stale
    // CRLF-suffixed pattern on a pre-fix install) — the add cancels the
    // delete back to a clean index, and an unguarded commit then throws
    // "nothing to commit" and takes push() down with it. setup() and pull()
    // already guard their own commits this way; push() must match.
    try {
      await git(`commit -m "The Curator sync — ${date} ${time} — ${uncommittedCount} change${uncommittedCount !== 1 ? 's' : ''}"`);
    } catch (err) {
      if (!err.message.includes('nothing to commit')) throw err;
    }
  }

  // Determine what will be pushed BEFORE pushing. We want the union of files
  // changed across ALL unpushed commits — including commits made earlier in
  // this sync by pull()'s auto-save. The previous implementation only counted
  // the most recent commit's diff, so a big ingest that got split into
  // multiple commits by pull() → push() would show a wildly-wrong count like
  // "6 files" for a 200-file change.
  // Count files we're actually sending TO remote. Naive `diff origin/main..HEAD`
  // is symmetric: when local merged a remote commit (`-X theirs`), files that
  // origin had — but local didn't touch — still show up as "differing", which
  // inflates the count. Use `merge-base` so the count reflects only what local
  // is genuinely adding on top of the common ancestor (v3.0.1-beta.6).
  let aheadCount = 0;
  let filesToPush = 0;
  let filePreview = [];
  try {
    const { stdout: ahead } = await git('rev-list --count origin/main..HEAD');
    aheadCount = parseInt(ahead.trim(), 10) || 0;
    if (aheadCount > 0) {
      const { stdout: baseOut } = await git('merge-base HEAD origin/main');
      const base = baseOut.trim();
      const diffRange = base ? `${base}..HEAD` : 'origin/main..HEAD';
      const { stdout: names } = await git(`diff --name-only ${diffRange}`);
      const list = names.split('\n').filter(Boolean);
      filesToPush = list.length;
      filePreview = list.slice(0, 20);
    }
  } catch {
    // First push ever: origin/main doesn't exist yet. Count tracked files.
    try {
      const { stdout: names } = await git('ls-files');
      const list = names.split('\n').filter(Boolean);
      filesToPush = list.length;
      filePreview = list.slice(0, 20);
      aheadCount = 1;
    } catch { filesToPush = uncommittedCount; aheadCount = 1; }
  }

  if (aheadCount === 0) {
    return {
      pushed: false,
      filesChanged: 0,
      commitsAhead: 0,
      message: 'Everything is already up to date — nothing new to sync.',
    };
  }

  await git('push -u origin main', { timeout: 120000 });

  return {
    pushed: true,
    filesChanged: filesToPush,
    commitsAhead: aheadCount,
    files: filePreview,
    // Back-compat: `changesCount` was the field the UI used before v2.3.7
    changesCount: filesToPush,
  };
}

export async function pull() {
  // Self-heal: see push() — keeps .gitignore current on installs configured
  // before a DOMAINS_GITIGNORE_RULES addition.
  await ensureDomainsGitignore();

  // Auto-commit local changes so the pull merge succeeds
  const { stdout } = await git('status --porcelain');
  if (stdout.trim()) {
    const date = new Date().toLocaleString();
    await git('add -A');
    try {
      await git(`commit -m "Auto-save before sync — ${date}"`);
    } catch (err) {
      if (!err.message.includes('nothing to commit')) throw err;
    }
  }

  // Fetch remote state without merging yet, so we can count what's incoming.
  await git('fetch origin main', { timeout: 120000 });

  // Count files actually coming FROM remote. Naive `diff HEAD..origin/main`
  // is symmetric — it counts files differing in EITHER direction, including
  // files we modified locally in the auto-save commit above. That produces
  // confusing reports like "pulled 206 / pushed 206" for the same 206 files.
  // Using `merge-base` lets us count only files origin advanced beyond the
  // common ancestor (v3.0.1-beta.6).
  let filesPulled = 0;
  let commitsPulled = 0;
  let filePreview = [];
  try {
    const { stdout: cnt } = await git('rev-list --count HEAD..origin/main');
    commitsPulled = parseInt(cnt.trim(), 10) || 0;
    if (commitsPulled > 0) {
      const { stdout: baseOut } = await git('merge-base HEAD origin/main');
      const base = baseOut.trim();
      if (base) {
        const { stdout: names } = await git(`diff --name-only ${base}..origin/main`);
        const list = names.split('\n').filter(Boolean);
        filesPulled = list.length;
        filePreview = list.slice(0, 20);
      }
    }
  } catch { /* no remote yet — first sync, pull will do the right thing */ }

  // Use merge (not rebase) with "theirs" strategy for conflicts.
  // Wiki files are merged at the application level (mergeWikiPage) on next ingest,
  // so accepting the remote version for git conflicts is safe and avoids the
  // "could not apply" rebase errors when both computers edit the same entity pages.
  const { stdout: pullOut } = await git('pull --no-rebase -X theirs origin main', { timeout: 120000 });

  // Prune ghost domain directories. When another machine deletes a domain, the
  // pull removes every tracked file, but empty dirs are left behind because git
  // doesn't track them.
  const pruned = await pruneGhostDomainDirs();

  return {
    pulled: true,
    filesChanged: filesPulled,
    commitsPulled,
    files: filePreview,
    pruned,
    details: pullOut,
  };
}

/**
 * Remove any directory under the domains root that has no CLAUDE.md.
 * Called after pull so sync-delete from another machine fully takes effect.
 * Returns the list of pruned domain names (usually empty).
 */
async function pruneGhostDomainDirs() {
  const base = getDomainsDir();
  const pruned = [];
  let entries;
  try {
    const { readdir } = await import('fs/promises');
    entries = await readdir(base, { withFileTypes: true });
  } catch { return pruned; }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dirPath = path.join(base, entry.name);
    const schemaPath = path.join(dirPath, 'CLAUDE.md');
    if (existsSync(schemaPath)) continue;    // real domain, keep
    // Schema is gone → ghost directory. Remove it recursively.
    try {
      await rm(dirPath, { recursive: true, force: true });
      pruned.push(entry.name);
    } catch { /* best-effort; fall through */ }
  }
  return pruned;
}

export async function sync() {
  // Bidirectional sync: pull remote changes first, then push local changes.
  // This is the safest order — always get the latest before pushing.
  const pullResult = await pull();
  const pushResult = await push();
  return { pullResult, pushResult };
}

export async function disconnect() {
  if (existsSync(GIT_DIR))    await rm(GIT_DIR, { recursive: true, force: true });
  if (existsSync(CONFIG_FILE)) await unlink(CONFIG_FILE);
}

export { friendlyError };
