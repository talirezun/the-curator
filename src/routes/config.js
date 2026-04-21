import { Router } from 'express';
import { existsSync, readFileSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';
import { getConfig, setDomainsDir, getApiKeys, setApiKeys, clearApiKey } from '../brain/config.js';
import { getProviderInfo, getFallbackStatus } from '../brain/llm.js';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

/**
 * When The Curator is launched via the .app wrapper, AppleScript's `do shell script`
 * starts the node process with a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`).
 * That finds `git` (Xcode CLT at `/usr/bin/git`) but NOT `npm`, which lives next
 * to the node binary in `/usr/local/bin` or `/opt/homebrew/bin`. Every subprocess
 * the updater spawns inherits this bare PATH, so `npm install` fails with
 * "npm: command not found". We prepend the node binary's directory plus the
 * common Homebrew / system prefixes so the child shells can resolve everything.
 */
const NODE_BIN_DIR = path.dirname(process.execPath);
const SUBPROCESS_PATH = [
  NODE_BIN_DIR,
  '/usr/local/bin',
  '/opt/homebrew/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
  process.env.PATH || '',
].filter(Boolean).join(':');
const SUBPROCESS_ENV = { ...process.env, PATH: SUBPROCESS_PATH };

const router = Router();

/** GET /api/config — returns current app configuration */
router.get('/', (_req, res) => {
  res.json(getConfig());
});

/** POST /api/config/domains-path — set a new domains folder path */
router.post('/domains-path', (req, res) => {
  const { path: newPath } = req.body;
  if (!newPath || typeof newPath !== 'string' || !newPath.trim()) {
    return res.status(400).json({ error: 'path is required' });
  }
  const trimmed = newPath.trim();
  if (!existsSync(trimmed)) {
    return res.status(400).json({ error: `Folder does not exist: ${trimmed}` });
  }
  try {
    setDomainsDir(trimmed);
    res.json({ ok: true, domainsPath: trimmed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/config/pick-folder — opens native macOS folder picker via osascript */
router.post('/pick-folder', async (_req, res) => {
  try {
    const { stdout } = await execAsync(
      `osascript -e 'POSIX path of (choose folder with prompt "Select your Knowledge Base folder:")'`,
      { timeout: 60000, env: SUBPROCESS_ENV }
    );
    const picked = stdout.trim();
    if (picked) {
      if (!existsSync(picked)) {
        return res.status(400).json({ error: `Folder does not exist: ${picked}` });
      }
      setDomainsDir(picked);
      res.json({ ok: true, path: picked });
    } else {
      res.json({ cancelled: true });
    }
  } catch (err) {
    // User pressed Cancel in the picker (exit code 1, error -128)
    if (err.killed || err.code === 1 || String(err.stderr).includes('-128')) {
      res.json({ cancelled: true });
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});

// ── API Keys ────────────────────────────────────────────────────────────────

/** Mask an API key: show only last 4 chars */
function maskKey(key) {
  if (!key || key.length < 8) return key ? '••••' : '';
  return '••••••••' + key.slice(-4);
}

/** GET /api/config/api-keys — returns masked keys + active provider info */
router.get('/api-keys', (_req, res) => {
  const keys = getApiKeys();
  let provider = null;
  try {
    provider = getProviderInfo();
  } catch { /* no key configured yet */ }

  res.json({
    geminiApiKey:    maskKey(keys.geminiApiKey),
    anthropicApiKey: maskKey(keys.anthropicApiKey),
    hasGeminiKey:    !!keys.geminiApiKey,
    hasAnthropicKey: !!keys.anthropicApiKey,
    activeProvider:  provider?.provider || null,
    activeModel:     provider?.model || null,
    // null if primary model is working; populated when the fallback chain kicked in
    // because the pinned default has been retired by the provider.
    fallback:        getFallbackStatus(),
  });
});

/** POST /api/config/api-keys — save API keys (partial update).
 *  Saving a non-empty key for a provider also marks it as the active provider
 *  ("last-saved-wins" — see setApiKeys in brain/config.js).
 */
router.post('/api-keys', (req, res) => {
  const { geminiApiKey, anthropicApiKey } = req.body;

  const update = {};
  if (geminiApiKey !== undefined)    update.geminiApiKey    = geminiApiKey.trim();
  if (anthropicApiKey !== undefined) update.anthropicApiKey = anthropicApiKey.trim();

  try {
    setApiKeys(update);
    let provider = null;
    try { provider = getProviderInfo(); } catch {}
    res.json({
      ok: true,
      activeProvider: provider?.provider || null,
      activeModel:    provider?.model || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/config/api-keys/disconnect — clear one provider's stored key.
 *  Body: { provider: 'gemini' | 'anthropic' }
 *  If the disconnected key was active, active switches to the other provider
 *  (if it still has a key), or to null.
 */
router.post('/api-keys/disconnect', (req, res) => {
  const { provider } = req.body || {};
  if (provider !== 'gemini' && provider !== 'anthropic') {
    return res.status(400).json({ error: 'provider must be "gemini" or "anthropic"' });
  }
  try {
    clearApiKey(provider);
    let info = null;
    try { info = getProviderInfo(); } catch {}
    res.json({
      ok: true,
      activeProvider: info?.provider || null,
      activeModel:    info?.model || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Update ──────────────────────────────────────────────────────────────────

/** GET /api/config/update-check — compare local vs remote version AND git commit */
router.get('/update-check', async (_req, res) => {
  try {
    const pkg = JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
    const current = pkg.version;

    // Get local git commit hash
    let localCommit = null;
    try {
      const { stdout } = await execAsync('git rev-parse --short HEAD', { cwd: PROJECT_ROOT, env: SUBPROCESS_ENV });
      localCommit = stdout.trim();
    } catch { /* not a git repo — skip commit comparison */ }

    // Get remote version from GitHub
    const response = await fetch(
      'https://raw.githubusercontent.com/talirezun/the-curator/main/package.json'
    );
    if (!response.ok) throw new Error('Could not reach GitHub');
    const remote = await response.json();
    const latest = remote.version;

    // Get remote git commit hash
    let remoteCommit = null;
    try {
      const commitRes = await fetch(
        'https://api.github.com/repos/talirezun/the-curator/commits/main',
        { headers: { 'Accept': 'application/vnd.github.v3.sha' } }
      );
      if (commitRes.ok) {
        const sha = await commitRes.text();
        remoteCommit = sha.trim().slice(0, 7);
      }
    } catch { /* GitHub API unavailable — fall back to version comparison only */ }

    // Update is available if version differs OR if commits differ
    const versionDiffers = latest !== current;
    const commitsDiffer = localCommit && remoteCommit && localCommit !== remoteCommit;
    const updateAvailable = versionDiffers || commitsDiffer;

    res.json({
      current,
      latest,
      localCommit,
      remoteCommit,
      updateAvailable,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/config/update — fetch latest code, hard-sync to origin/main, install deps, rebuild .app
 *
 * We use `fetch + reset --hard` instead of `pull` because `npm install` commonly
 * regenerates `package-lock.json` with machine-specific diffs, which make plain
 * `git pull` abort with "local changes would be overwritten". The app directory
 * is meant to track `main` verbatim — user data (domains/, .curator-config.json,
 * .sync-config.json) is all gitignored, so hard-reset is safe.
 */
router.post('/update', async (_req, res) => {
  // Shared exec options — the env override is what makes `npm` resolvable under
  // the .app wrapper's minimal PATH.
  const execOpts = (extra = {}) => ({ cwd: PROJECT_ROOT, env: SUBPROCESS_ENV, ...extra });
  let beforeSha = null, afterSha = null;

  try {
    // 1. Fetch before resetting so we never hard-reset to a stale ref if the remote is unreachable.
    await execAsync('git fetch origin main', execOpts({ timeout: 30000 }));

    // 2. Record before/after SHAs so the response explains what changed.
    const before = await execAsync('git rev-parse HEAD', execOpts({ timeout: 5000 }));
    beforeSha = before.stdout.trim().slice(0, 7);

    // 3. Hard-sync to origin/main. Discards any local modifications to tracked files
    //    (including the common `package-lock.json` regeneration) without touching gitignored data.
    await execAsync('git reset --hard origin/main', execOpts({ timeout: 10000 }));
    const after = await execAsync('git rev-parse HEAD', execOpts({ timeout: 5000 }));
    afterSha = after.stdout.trim().slice(0, 7);

    // 4. Install deps. Uses the absolute node binary's directory so `npm` resolves
    //    under the .app wrapper's minimal PATH.
    try {
      await execAsync('npm install --silent --no-audit --no-fund', execOpts({ timeout: 120000 }));
    } catch (npmErr) {
      // "npm: command not found" is the classic sign of a pre-v2.3.5 running app:
      // the files on disk already contain the PATH fix, but the currently-running
      // process (which is what spawned this subprocess) doesn't. Restarting picks
      // up the fixed version. Since v2.3.4→v2.3.5 added no dependencies, the
      // existing node_modules is still correct and a restart is sufficient.
      //
      // For any OTHER npm error, we re-throw and surface it — auto-restarting
      // into a broken-dependency state would be worse than reporting the failure.
      const msg = (npmErr.message || '').toLowerCase();
      const pathIssue = msg.includes('npm: command not found') || msg.includes('npm: not found');
      if (pathIssue) {
        return res.json({
          ok: true,
          restarting: true,
          partial: true,
          from: beforeSha,
          to:   afterSha,
          warning: `Files updated ${beforeSha} → ${afterSha}. ` +
                   `npm couldn't be found under the running app's PATH — a known issue in ` +
                   `older versions that's fixed in the update you just pulled. Restarting will ` +
                   `load the fixed updater. No dependency install is needed for this version bump.`,
        });
      }
      throw npmErr;
    }

    // 5. Rebuild the .app so the AppleScript stays current with the code (non-fatal).
    await execAsync('bash scripts/build-app.sh', execOpts({ timeout: 30000 })).catch(() => {});

    res.json({
      ok: true,
      restarting: true,
      from: beforeSha,
      to:   afterSha,
    });
  } catch (err) {
    res.status(500).json({
      error: err.message,
      from: beforeSha,
      to:   afterSha,
    });
  }
});

export default router;
