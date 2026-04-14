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
      cwd: ROOT,  // Explicit cwd prevents "getcwd: Operation not permitted" on macOS
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
  const changesCount = stdout.split('\n').filter(Boolean).length;

  if (changesCount > 0) {
    const now  = new Date();
    const date = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    await git('add -A');
    await git(`commit -m "The Curator sync — ${date} ${time} — ${changesCount} change${changesCount !== 1 ? 's' : ''}"`);
  }

  // Check if there are local commits ahead of the remote (including commits
  // made by pull()'s auto-save). Without this, sync() would report "nothing
  // to push" even though pull() just committed all local changes.
  let aheadCount = 0;
  try {
    const { stdout: ahead } = await git('rev-list --count origin/main..HEAD');
    aheadCount = parseInt(ahead.trim(), 10) || 0;
  } catch {
    // If origin/main doesn't exist yet (first push), we have commits to push
    aheadCount = 1;
  }

  if (aheadCount === 0) {
    return { pushed: false, message: 'Everything is already up to date — nothing new to sync.' };
  }

  await git('push -u origin main', { timeout: 120000 });

  // Return meaningful count: uncommitted files staged + any files in commits ahead of remote
  let filesChanged = changesCount;
  if (!filesChanged && aheadCount > 0) {
    try {
      const { stdout: diffStat } = await git('diff --stat --name-only origin/main~1..origin/main');
      filesChanged = diffStat.split('\n').filter(Boolean).length;
    } catch {
      filesChanged = aheadCount;  // Fallback to commit count
    }
  }
  return { pushed: true, changesCount: filesChanged || aheadCount };
}

export async function pull() {
  // Auto-commit local changes so rebase succeeds
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

  const { stdout: pullOut } = await git('pull --rebase origin main', { timeout: 120000 });
  return { pulled: true, details: pullOut };
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
