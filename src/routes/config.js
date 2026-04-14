import { Router } from 'express';
import { existsSync, readFileSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';
import { getConfig, setDomainsDir, getApiKeys, setApiKeys } from '../brain/config.js';
import { getProviderInfo } from '../brain/llm.js';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

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
      { timeout: 60000 }
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
  });
});

/** POST /api/config/api-keys — save API keys (partial update) */
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

// ── Update ──────────────────────────────────────────────────────────────────

/** GET /api/config/update-check — compare local vs remote version */
router.get('/update-check', async (_req, res) => {
  try {
    const pkg = JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
    const current = pkg.version;

    const response = await fetch(
      'https://raw.githubusercontent.com/talirezun/the-curator/main/package.json'
    );
    if (!response.ok) throw new Error('Could not reach GitHub');
    const remote = await response.json();
    const latest = remote.version;

    res.json({ current, latest, updateAvailable: latest !== current });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/config/update — pull latest code and restart */
router.post('/update', async (_req, res) => {
  try {
    await execAsync('git pull origin main', { cwd: PROJECT_ROOT, timeout: 30000 });
    await execAsync('npm install --silent --no-audit --no-fund', { cwd: PROJECT_ROOT, timeout: 60000 });

    res.json({ ok: true, restarting: true });

    // Exit after response is flushed — AppleScript's on reopen will restart
    setTimeout(() => process.exit(0), 500);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
