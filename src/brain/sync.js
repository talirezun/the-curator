import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { mkdir, writeFile, readFile, unlink, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { getDomainsDir } from './config.js';

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
    throw new Error(sanitize(err.message));
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
    return 'GitHub rejected the token. Make sure it has "repo" scope and hasn\'t expired.';
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
    return 'GitHub has changes you don\'t have locally. Click "Sync Down" first, then Sync Up again.';
  }
  if (msg.includes('nothing to commit')) {
    return null; // Not an error
  }
  return sanitize(err.message);
}

// ── Config ────────────────────────────────────────────────────────────────────

async function saveConfig(repoUrl, token) {
  await writeFile(CONFIG_FILE, JSON.stringify({ repoUrl, token }, null, 2), 'utf8');
}

async function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return null;
  try { return JSON.parse(await readFile(CONFIG_FILE, 'utf8')); } catch { return null; }
}

// ── Domains .gitignore ────────────────────────────────────────────────────────

async function ensureDomainsGitignore() {
  const p = path.join(getDomainsDir(), '.gitignore');
  if (!existsSync(p)) {
    await writeFile(p, '*/raw/\n', 'utf8');
  }
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
  // Stage and commit any uncommitted changes
  const { stdout } = await git('status --porcelain');
  const uncommittedCount = stdout.split('\n').filter(Boolean).length;

  if (uncommittedCount > 0) {
    const now  = new Date();
    const date = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    await git('add -A');
    await git(`commit -m "The Curator sync — ${date} ${time} — ${uncommittedCount} change${uncommittedCount !== 1 ? 's' : ''}"`);
  }

  // Determine what will be pushed BEFORE pushing. We want the union of files
  // changed across ALL unpushed commits — including commits made earlier in
  // this sync by pull()'s auto-save. The previous implementation only counted
  // the most recent commit's diff, so a big ingest that got split into
  // multiple commits by pull() → push() would show a wildly-wrong count like
  // "6 files" for a 200-file change.
  let aheadCount = 0;
  let filesToPush = 0;
  let filePreview = [];
  try {
    const { stdout: ahead } = await git('rev-list --count origin/main..HEAD');
    aheadCount = parseInt(ahead.trim(), 10) || 0;
    if (aheadCount > 0) {
      const { stdout: names } = await git('diff --name-only origin/main..HEAD');
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

  let filesPulled = 0;
  let commitsPulled = 0;
  let filePreview = [];
  try {
    const { stdout: cnt } = await git('rev-list --count HEAD..origin/main');
    commitsPulled = parseInt(cnt.trim(), 10) || 0;
    if (commitsPulled > 0) {
      const { stdout: names } = await git('diff --name-only HEAD..origin/main');
      const list = names.split('\n').filter(Boolean);
      filesPulled = list.length;
      filePreview = list.slice(0, 20);
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
