import { Router } from 'express';
import { existsSync, readFileSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { getConfig, setDomainsDir, getApiKeys, setApiKeys, clearApiKey, setActiveProvider, getDefaultDomain, setDefaultDomain } from '../brain/config.js';
import { listDomains } from '../brain/files.js';
import { getProviderInfo, getFallbackStatus, getDefaultModel } from '../brain/llm.js';
import {
  hasActiveWrites,
  conflictResponse,
  beginUpdate,
  endUpdate,
} from '../brain/write-registry.js';
import { APP_ROOT } from '../brain/paths.js';

const execAsync = promisify(exec);
// The CODE root — package.json + the git checkout the auto-updater operates on.
// Never user data (see src/brain/paths.js).
const PROJECT_ROOT = APP_ROOT;

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

/**
 * Classify an `npm install` failure into one of a handful of well-known
 * remediation buckets. Returns `{ kind, actionable }` where `actionable`
 * is a user-facing plain-English message with a concrete next step, or
 * `null` when the error doesn't match any known pattern (caller should
 * surface the raw npm output in that case).
 *
 * Exported for unit testing (v3.0.1-beta.10). The classifier itself is
 * a pure function over a string + two SHA strings — no FS, no network,
 * deterministic — so it can be exercised from a stand-alone test
 * script with synthetic npm error strings.
 *
 * Kept narrow on purpose: we only enrich messages we recognise. Unknown
 * errors fall through with `actionable: null` so the user sees the real
 * npm output rather than a wrong-but-confident remediation.
 */
export function classifyNpmError(rawMessage, beforeSha = '', afterSha = '') {
  const msg = (rawMessage || '').toLowerCase();
  if (!msg) return { kind: 'unknown', actionable: null };

  // PATH issue is handled separately by the caller (returns a different
  // shape — partial success rather than failure). Surface it for
  // completeness so test coverage stays explicit.
  if (msg.includes('npm: command not found') || msg.includes('npm: not found')) {
    return { kind: 'path', actionable: null };
  }

  const shaSpan = beforeSha && afterSha ? `${beforeSha} → ${afterSha} ` : '';

  // Corrupted npm cache — partial file in ~/.npm/_cacache blocks the
  // rename(2) of the freshly-downloaded tarball. Diagnosed via Cowork
  // troubleshooting on a user's machine that had been force-quit during
  // a previous install. The canonical recovery is `npm cache clean --force`.
  if (msg.includes('eacces') ||
      msg.includes('errno -13') ||
      msg.includes('permission denied') ||
      (msg.includes('rename') && msg.includes('file exists'))) {
    return {
      kind: 'cache-corrupted',
      actionable:
        `Your npm cache appears to be corrupted (EACCES / permission denied during a rename). ` +
        `This is usually the result of a previous install being interrupted. To recover: ` +
        `open Terminal and run ` +
        '`npm cache clean --force`' +
        ` then click Check for Updates again. ` +
        `Files were ${shaSpan ? 'updated to ' + shaSpan : 'updated '}but dependencies didn't install — ` +
        `your existing app keeps working, only the dependency install was blocked.`,
    };
  }

  // Disk-out-of-space.
  if (msg.includes('enospc') || msg.includes('no space left')) {
    return {
      kind: 'disk-full',
      actionable:
        `Disk is full (ENOSPC) — npm couldn't write to disk. Free some space ` +
        `(at least 500 MB to be safe) and click Check for Updates again. ` +
        `Files were ${shaSpan ? 'updated to ' + shaSpan : 'updated '}but dependencies didn't install.`,
    };
  }

  // Network-related — registry timeouts, dropped connections, DNS.
  if (msg.includes('etimedout') ||
      msg.includes('econnreset') ||
      msg.includes('socket hang up') ||
      msg.includes('enotfound') ||
      msg.includes('network')) {
    return {
      kind: 'network',
      actionable:
        `Network error while downloading dependencies (timeout / connection reset / DNS). ` +
        `Check your connection and click Check for Updates again. ` +
        `Files were ${shaSpan ? 'updated to ' + shaSpan : 'updated '}but dependencies didn't install.`,
    };
  }

  // Lockfile in a bad state — happens when a previous npm install was
  // interrupted between the package.json write and the package-lock.json
  // regeneration. Auto-recovers on retry once user clears node_modules.
  if (msg.includes('eintegrity') || msg.includes('lockfile')) {
    return {
      kind: 'lockfile',
      actionable:
        `npm lockfile is in a bad state. To recover: open Terminal, run ` +
        '`rm -rf node_modules package-lock.json && npm install`' +
        ` and then relaunch The Curator. ` +
        `Files were ${shaSpan ? 'updated to ' + shaSpan : 'updated '}but dependencies didn't reinstall.`,
    };
  }

  return { kind: 'unknown', actionable: null };
}

const router = Router();

/**
 * Refuse a config mutation while any wiki write is in flight.
 *
 * ── Why these routes need it ─────────────────────────────────────────────
 *
 * Two config values are read FRESH on every use, by deliberate design, so a
 * mutation lands instantly on an operation that is already half-finished:
 *
 *   • `getDomainsDir()` re-reads .curator-config.json on EVERY call (the
 *     v3.1.0 per-call-resolution invariant, enforced by a source guard), and
 *     `wikiPath()`/`rawPath()` in files.js call it once per page write. Change
 *     the folder mid-ingest and the REMAINING pages of that document are
 *     written under the new root — one source's pages split across two
 *     locations, with an index and log that each describe only half of it.
 *     Nothing is deleted, but recovery is manual and the cause is invisible.
 *
 *   • `getProviderInfo()` runs per LLM call inside `callProvider`, so changing
 *     or clearing the active key mid-run either fails the ingest partway
 *     through or silently finishes it on a DIFFERENT model. Note this includes
 *     plain saves: v3.0.2's last-saved-wins means saving a key also switches
 *     the active provider.
 *
 * A multi-phase ingest takes minutes, and the shipping frontend's busy gate
 * disables only Update / the four sync buttons / delete-domain — the folder
 * picker and the key controls are NOT in that list, so a user wandering into
 * Settings mid-ingest reaches all of this. The 409 is the canonical safety
 * net, exactly as it is for `POST /update` below.
 *
 * Deliberately NOT guarded: `POST /default-domain`. It only selects which
 * domain MCP write tools assume when the user doesn't name one; an in-flight
 * ingest already has an explicit domain, so changing it cannot affect a write
 * that is already running.
 *
 * Predicate is process-wide (`hasActiveWrites`) rather than per-domain, and
 * that is the correct scope, not an over-broad one: none of these routes take
 * a domain, and both mutations are themselves process-global — a new domains
 * root moves EVERY domain, and a provider switch changes EVERY subsequent LLM
 * call. `isDomainActive` would be a category error here.
 *
 * Same middleware shape as sync.js's `guardConcurrent`, and the response is
 * built by the shared `conflictResponse()` so the status, body shape and
 * message style are identical to every other refusal in the app.
 */
function guardConcurrent(action) {
  return (req, res, next) => {
    if (hasActiveWrites()) {
      const { status, body } = conflictResponse(action);
      return res.status(status).json(body);
    }
    next();
  };
}

/** GET /api/config — returns current app configuration */
router.get('/', (_req, res) => {
  res.json({ ...getConfig(), defaultDomain: getDefaultDomain() });
});

/**
 * GET /api/config/default-domain — returns { defaultDomain, domains[] }.
 * Used by the Settings UI to render the dropdown of available domains.
 */
router.get('/default-domain', async (_req, res) => {
  try {
    const domains = await listDomains();
    res.json({ defaultDomain: getDefaultDomain(), domains });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/config/default-domain — set or clear the default domain.
 * Body: { defaultDomain: <slug> | null | "" }
 * The default domain is the wiki MCP write tools (compile_to_wiki, etc.) use
 * when the user says "my wiki" without specifying which one.
 */
router.post('/default-domain', async (req, res) => {
  try {
    const requested = (req.body && typeof req.body.defaultDomain === 'string')
      ? req.body.defaultDomain.trim()
      : null;
    if (requested) {
      // Validate that it's a real domain — refuse silently-broken state
      const domains = await listDomains();
      if (!domains.includes(requested)) {
        return res.status(400).json({ error: `Unknown domain: ${requested}` });
      }
    }
    setDefaultDomain(requested || null);
    res.json({ ok: true, defaultDomain: getDefaultDomain() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/config/domains-path — set a new domains folder path */
router.post('/domains-path', guardConcurrent('change the knowledge folder'), (req, res) => {
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

/** POST /api/config/pick-folder — opens native macOS folder picker via osascript.
 *  Guarded because this route does NOT merely return a path for the client to
 *  submit to /domains-path — it calls setDomainsDir() itself (below), so it is
 *  a mutation in its own right and needs the same protection.
 */
router.post('/pick-folder', guardConcurrent('change the knowledge folder'), async (_req, res) => {
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
      // Re-check immediately before the mutation. The middleware above only
      // proves the state at the moment the dialog OPENED, and this dialog
      // blocks for up to 60 s — long enough for the batch-ingest queue to pick
      // up its next item, or for a second tab to start an ingest, while the
      // user is still browsing for a folder. Deliberately NOT merged into the
      // `cancelled` branch: the shipping frontend checks `data.cancelled`
      // BEFORE `res.ok`, so a refusal must never carry that field.
      if (hasActiveWrites()) {
        const { status, body } = conflictResponse('change the knowledge folder');
        return res.status(status).json(body);
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
    // Config-only (Settings) key presence. The chat model selector keys off
    // THESE so it mirrors exactly what the user has connected in Settings — a
    // key removed via Disconnect (but still in .env) must not appear or be usable
    // in chat. (getEffectiveKey / .env still drives the GLOBAL provider for the
    // documented dev fallback; the per-chat selector is deliberately config-only.)
    hasGeminiKey:    !!keys.geminiApiKey,
    hasAnthropicKey: !!keys.anthropicApiKey,
    activeProvider:  provider?.provider || null,
    activeModel:     provider?.model || null,
    // Current default model id per provider, so the chat model selector's label
    // stays in sync with DEFAULTS automatically when we bump to a newer model.
    models: {
      gemini:    getDefaultModel('gemini'),
      anthropic: getDefaultModel('anthropic'),
    },
    // null if primary model is working; populated when the fallback chain kicked in
    // because the pinned default has been retired by the provider.
    fallback:        getFallbackStatus(),
  });
});

/** POST /api/config/api-keys — save API keys (partial update).
 *  Saving a non-empty key for a provider also marks it as the active provider
 *  ("last-saved-wins" — see setApiKeys in brain/config.js).
 */
router.post('/api-keys', guardConcurrent('save API keys'), (req, res) => {
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
router.post('/api-keys/disconnect', guardConcurrent('disconnect an API key'), (req, res) => {
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

/** POST /api/config/api-keys/active — switch the active provider WITHOUT
 *  re-saving its key. Body: { provider: 'gemini' | 'anthropic' }
 *  Refuses (400) if the requested provider has no stored key.
 */
router.post('/api-keys/active', guardConcurrent('switch the AI provider'), (req, res) => {
  const { provider } = req.body || {};
  if (provider !== 'gemini' && provider !== 'anthropic') {
    return res.status(400).json({ error: 'provider must be "gemini" or "anthropic"' });
  }
  try {
    const before = getApiKeys();
    const hasKey = provider === 'gemini'
      ? !!(before.geminiApiKey || process.env.GEMINI_API_KEY)
      : !!(before.anthropicApiKey || process.env.ANTHROPIC_API_KEY);
    if (!hasKey) {
      return res.status(400).json({ error: `No ${provider} key is configured — add one before switching to it.` });
    }
    setActiveProvider(provider);
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
  // v3.0.1-beta.8: refuse to update while any wiki write is in flight.
  // The update flow does `git reset --hard origin/main` (safe — only touches
  // tracked app files, domains/ is gitignored) followed by `/api/restart`
  // (NOT safe — kills the Node process, can truncate in-flight wiki writes).
  // The atomic-write fix in this same release makes the truncation
  // recoverable, but the kindest UX is still to refuse the update rather
  // than abort a running ingest.
  if (hasActiveWrites()) {
    const { status, body } = conflictResponse('update the app');
    return res.status(status).json(body);
  }

  // Shared exec options — the env override is what makes `npm` resolvable under
  // the .app wrapper's minimal PATH.
  const execOpts = (extra = {}) => ({ cwd: PROJECT_ROOT, env: SUBPROCESS_ENV, ...extra });
  let beforeSha = null, afterSha = null;

  // Flag this domain-global operation so an ingest that arrives during the
  // git-reset / npm-install window is refused with a clear 409 (see the
  // matching check in src/routes/ingest.js). Cleared in `finally`.
  beginUpdate();
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

      // v3.0.1-beta.10: classify other common npm install failures so the
      // user sees an actionable next step rather than the cryptic
      // "Command failed: npm install --silent --no-audit --no-fund".
      //
      // Reported case that motivated this: a user's `~/.npm/_cacache` had a
      // partial file from a prior force-quit, so every npm install failed
      // with `EACCES: permission denied, rename ...`. The previous error
      // message gave them no hint that `npm cache clean --force` would fix
      // it. The classifier maps each well-known npm-failure pattern to a
      // plain-English remediation that the frontend renders verbatim in
      // the Settings → Updates banner.
      //
      // For genuinely unknown errors we still re-throw the raw npmErr so
      // the user sees the actual text and can google it — never hide an
      // error we don't recognise.
      const classification = classifyNpmError(npmErr.message, beforeSha, afterSha);
      if (classification.actionable) {
        const enriched = new Error(classification.actionable);
        enriched.original = npmErr.message;
        enriched.classification = classification.kind;
        throw enriched;
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
  } finally {
    // v3.0.1-beta.8: ALWAYS clear the update flag — success path leads to a
    // restart anyway, but failure path must release so future ingests aren't
    // blocked. Runs even after the early `return` for the partial-success
    // npm-PATH case.
    endUpdate();
  }
});

export default router;
