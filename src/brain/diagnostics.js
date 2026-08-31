/**
 * Self-diagnostics (v3.0.1-beta.23) — the engine behind the Settings "System
 * Check" panel.
 *
 * Two tiers:
 *   - runQuickDiagnostics(): FREE, fast, local-only checks. No network, no API
 *     call, no cost. Never touches the user's real wiki content (the
 *     domains-writable probe writes a throwaway temp file and deletes it).
 *   - runLiveApiCheck(): OPT-IN. Makes ONE tiny LLM call (a few tokens) to
 *     confirm the configured key actually works and the provider is responding.
 *     Costs a fraction of a cent. The route only calls this on an explicit,
 *     cost-confirmed POST.
 *
 * Design rule: this module is READ-ONLY with respect to user data. The only
 * write it ever performs is a self-deleting temp file used to verify the
 * domains folder is writable.
 */

import { readFileSync, statSync, existsSync } from 'fs';
import { unlink } from 'fs/promises';
import path from 'path';
// execFile, never exec: no shell interpretation (the same rule
// /api/mcp/reveal-config follows). Nothing user-supplied reaches it either way.
import { execFile } from 'child_process';
import { promisify } from 'util';
import { describeInstall, getCapabilities } from './install-mode.js';
import { getDomainsDir, getApiKeys, getEffectiveKey } from './config.js';
import { appPath, getCredentialFiles } from './paths.js';
import { getProviderInfo, generateText, getFallbackStatus } from './llm.js';
import { isConfigured as syncConfigured, getStatus as syncGetStatus } from './sync.js';
import { writeFileAtomic } from './atomic-write.js';
import { getLogFilePath, getLogFileStats, logWarn } from './logger.js';

// Files that should be owner-only (0600). getCredentialFiles() in paths.js is
// the SINGLE source of truth, shared with the startup chmod sweep in
// server.js — the two lists previously had to be kept in sync by hand.

const execFileAsync = promisify(execFile);

function readVersion() {
  try {
    // package.json is CODE, not user data — always read from the app root.
    const pkg = JSON.parse(readFileSync(appPath('package.json'), 'utf8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** A single check result. status ∈ ok | warn | fail | info */
function check(id, label, status, detail) {
  return { id, label, status, detail };
}

// ── 1. Installed version ─────────────────────────────────────────────────────
function checkVersion() {
  return check('version', 'Installed version', 'info', `The Curator v${readVersion()}`);
}

/**
 * Is ANY provider's key present — in .curator-config.json OR the .env
 * developer fallback? Derived from getApiKeys()'s own field names rather than
 * a hardcoded provider list, so a future provider needs no edit here: each
 * `<id>ApiKey` field it adds is picked up automatically, and getEffectiveKey
 * already resolves config-or-env per id (returning null for anything it
 * doesn't recognise, so a stray/garbage id here is harmless).
 *
 * This exists to answer a narrower question than "does getProviderInfo()
 * throw": getProviderInfo() can throw WITH a key configured, and conflating
 * that with "no key at all" tells a user holding a valid key that they have
 * none. See checkProvider() / runLiveApiCheck() below.
 *
 * ⚠ THE CONCRETE CASE THAT MOTIVATED THIS HAS RESOLVED; THE GUARD IS KEPT ON
 * PURPOSE. When written, an OpenRouter-only install genuinely had no default
 * model, so getProviderInfo() threw for a user whose key was perfectly fine. As
 * of v3.14.0 all three shipped providers resolve a default (DEFAULTS.openrouter
 * is 'upstage/solar-pro4'), so no shipped provider reaches that throw today.
 * The throw itself still exists in getProviderInfo as a CLASS guard against any
 * provider added without a measured build-lane model, so this branch is latent
 * rather than dead — deleting it would re-arm the original defect for whoever
 * adds the fourth provider.
 */
function hasAnyKeyConfigured() {
  return Object.keys(getApiKeys())
    .map(field => field.replace(/ApiKey$/, ''))
    .some(id => !!getEffectiveKey(id));
}

// ── 2. AI provider key configured (no API call) ──────────────────────────────
function checkProvider() {
  try {
    const { provider, model } = getProviderInfo();
    const fb = getFallbackStatus?.();
    const fbNote = fb ? ` (currently using fallback model ${fb.usingModel})` : '';
    return check('provider', 'AI provider key', 'ok',
      `Configured: ${provider} · ${model}${fbNote}`);
  } catch (err) {
    if (hasAnyKeyConfigured()) {
      // A key IS configured somewhere — getProviderInfo() failed for a
      // different, more specific reason (e.g. a provider with no default
      // model and nothing selected in Settings). Surface its own message
      // verbatim rather than guessing at a cause we can't verify, and never
      // claim no key exists when one does.
      return check('provider', 'AI provider key', 'warn', err.message);
    }
    return check('provider', 'AI provider key', 'warn',
      'No API key configured. Add one in Settings to enable ingest, chat, and AI Health.');
  }
}

// ── 3. Domains folder readable + writable (self-deleting temp file) ───────────
async function checkDomainsWritable() {
  let dir;
  try {
    dir = getDomainsDir();
  } catch (err) {
    return check('domains', 'Knowledge folder', 'fail', `Could not resolve domains path: ${err.message}`);
  }
  if (!existsSync(dir)) {
    return check('domains', 'Knowledge folder', 'warn',
      `Folder does not exist yet: ${dir} (it's created when you add your first domain)`);
  }
  const probe = path.join(dir, `.curator-healthcheck-${process.pid}.tmp`);
  try {
    await writeFileAtomic(probe, 'ok', 'utf8');
    await unlink(probe);
    return check('domains', 'Knowledge folder', 'ok', `Readable and writable: ${dir}`);
  } catch (err) {
    try { await unlink(probe); } catch { /* best-effort */ }
    return check('domains', 'Knowledge folder', 'fail',
      `Folder exists but is not writable: ${dir} (${err.message})`);
  }
}

// ── 4. Credential file permissions (0600 on POSIX) ───────────────────────────
function checkCredentialPerms() {
  // chmod semantics differ on Windows; statSync mode doesn't reflect 0600 there.
  if (process.platform === 'win32') {
    return check('credentials', 'Credential file permissions', 'info',
      'Not applicable on Windows (POSIX file modes are not enforced).');
  }
  const present = getCredentialFiles().filter(f => existsSync(f.abs));
  if (present.length === 0) {
    return check('credentials', 'Credential file permissions', 'info',
      'No credential files yet (nothing to secure until you add a key or set up sync).');
  }
  const loose = [];
  for (const f of present) {
    try {
      const mode = statSync(f.abs).mode & 0o777;
      if (mode !== 0o600) loose.push(`${f.rel} (${mode.toString(8)})`);
    } catch { /* skip unreadable */ }
  }
  if (loose.length === 0) {
    return check('credentials', 'Credential file permissions', 'ok',
      `All ${present.length} credential file(s) are owner-only (0600).`);
  }
  return check('credentials', 'Credential file permissions', 'warn',
    `These files are not 0600: ${loose.join(', ')}. Restart the app to auto-harden them.`);
}

// ── 5. GitHub sync configured (local only — no network) ───────────────────────
async function checkSync() {
  try {
    if (!syncConfigured()) {
      return check('sync', 'GitHub sync', 'info', 'Not configured (optional — set it up in the Sync tab to back up your wiki).');
    }
    const status = await syncGetStatus();
    if (status && status.repoUrl) {
      const pending = typeof status.changesCount === 'number' && status.changesCount > 0
        ? ` · ${status.changesCount} local change(s) not yet pushed`
        : '';
      return check('sync', 'GitHub sync', 'ok', `Configured: ${status.repoUrl}${pending}`);
    }
    return check('sync', 'GitHub sync', 'ok', 'Configured.');
  } catch (err) {
    return check('sync', 'GitHub sync', 'warn', `Configured, but status check failed: ${err.message}`);
  }
}

// ── 6. Install mode ──────────────────────────────────────────────────────────
//
// 'info', never a pass/fail: neither mode is wrong, and the whole point of the
// row is that a support conversation starts from the right mental model.
// Whether the app can update itself is the fact that actually differs, so it is
// stated rather than left to be inferred from the mode name.
function checkInstallMode() {
  try {
    const { installMode, installModeLabel, capabilities } = describeInstall();
    // BOTH ARMS START IN SETTINGS, and saying otherwise was this row's defect:
    // v3.33.0 gave the packaged app its own updater, so "not from Settings" sent
    // a user looking for a download page the app no longer needs them to visit.
    // What still differs is HOW the new version arrives — a git pull into the
    // checkout, or a downloaded build that replaces the whole app — which is the
    // fact a support conversation actually turns on.
    const updates = capabilities.canSelfUpdateViaGit
      ? 'Updates in place from GitHub.'
      : 'Updates download from Settings and replace the whole app.';
    return check('install-mode', 'Install mode', 'info', `${installModeLabel} (${installMode}). ${updates}`);
  } catch (err) {
    return check('install-mode', 'Install mode', 'warn', `Could not determine: ${err.message}`);
  }
}

// ── 7. Git availability ──────────────────────────────────────────────────────
//
// Local, free and fast — a `git --version` subprocess, no network. It is here
// because git being absent breaks TWO features at once (Personal Sync and the
// updater) and its natural error text is actively misleading: `friendlyError`'s
// bare `not found` substring used to render "git: command not found" as
// "Repository not found. Check the URL." Fixed at source in sync.js; this row
// is what makes the condition visible BEFORE a user hits either feature.
//
// SKIPPED entirely on a build that needs neither — reporting a missing tool a
// packaged app never invokes would be a warning about nothing.
//
// FORKED on `canSelfUpdateViaGit` + `canRunNpmInstall`. `caps` is a defaulted
// parameter rather than a lookup in the body ONLY so a suite can drive both
// arms; the default is evaluated per call, so the production call site
// (`await checkGit()`) and its behaviour are unchanged. A capability lookup
// that throws still resolves to null and still takes the git-probing arm —
// the permissive direction, matching install-mode.js's own asymmetry.
function capabilitiesOrNull() {
  try {
    return getCapabilities();
  } catch {
    return null;
  }
}
export async function checkGit(caps = capabilitiesOrNull()) {
  if (caps && !caps.canSelfUpdateViaGit && !caps.canRunNpmInstall) {
    return check('git', 'Git', 'info', 'Not required by this build.');
  }
  try {
    const { stdout } = await execFileAsync('git', ['--version'], { timeout: 5000 });
    return check('git', 'Git', 'ok', (stdout || '').trim() || 'Available.');
  } catch (err) {
    const missing = /enoent|not found|not recognized/i.test(err && err.message ? err.message : '');
    return check('git', 'Git', missing ? 'fail' : 'warn',
      missing
        ? 'Not found. Personal Sync and app updates both need it — on macOS, open Terminal and run `xcode-select --install`.'
        : `Could not run \`git --version\`: ${err.message}`);
  }
}

// ── 8. Application log file ──────────────────────────────────────────────────
//
// Purely informational — there is no "wrong" state, only "exists" or "not
// yet". A fresh install that has never hit an error or restarted the server
// has legitimately never written a line. `detail` carries the resolved path
// so a user can find it without knowing the OS convention, and — since this
// is the one row a user might actually act on — enough to know whether
// there's anything worth opening. The route for a Finder/Explorer "reveal"
// action lives beside this file's sibling (POST /api/diagnostics/reveal-log,
// same execFile('open', ['-R', ...]) pattern as /api/mcp/reveal-config); no
// frontend button consumes it yet.
function checkLogFile() {
  const stats = getLogFileStats();
  if (!stats) {
    return check('log', 'Application log', 'info', `Not written yet: ${getLogFilePath()}`);
  }
  const kb = (stats.bytes / 1024).toFixed(1);
  return check('log', 'Application log', 'info', `${stats.path} (${kb} KB)`);
}

/**
 * Run all FREE, local checks. No network, no API call, no cost. Returns
 * { checks: [...], summary: {ok, warn, fail, info} }.
 */
export async function runQuickDiagnostics() {
  const checks = [
    checkVersion(),
    checkInstallMode(),
    checkProvider(),
    await checkDomainsWritable(),
    checkCredentialPerms(),
    await checkGit(),
    await checkSync(),
    checkLogFile(),
  ];
  const summary = { ok: 0, warn: 0, fail: 0, info: 0 };
  for (const c of checks) summary[c.status] = (summary[c.status] || 0) + 1;
  return { checks, summary };
}

/**
 * OPT-IN live check — one tiny LLM call to confirm the key works and the
 * provider is responding. The route only invokes this on an explicit,
 * cost-confirmed request. Returns a structured result; never throws.
 */
export async function runLiveApiCheck() {
  let provider, model;
  try {
    ({ provider, model } = getProviderInfo());
  } catch (err) {
    // Same distinction as checkProvider() above: a configured-but-unresolvable
    // provider (e.g. no default model chosen) gets its own real error, not a
    // false "no key" claim.
    const error = hasAnyKeyConfigured()
      ? err.message
      : 'No API key configured. Add one in Settings first.';
    return { ok: false, error };
  }
  const started = Date.now();
  try {
    const reply = await generateText(
      'You are a connectivity test. Reply with exactly the word OK and nothing else.',
      'Reply now.',
      16,
      'text',
    );
    const latencyMs = Date.now() - started;
    const fb = getFallbackStatus?.();
    return {
      ok: true,
      provider,
      model,
      latencyMs,
      sample: String(reply || '').trim().slice(0, 40),
      fallback: fb ? { model: fb.usingModel } : null,
    };
  } catch (err) {
    // Opt-in and rare (a user-initiated click, never a poll), so a failure
    // here is exactly the low-frequency/high-signal case the log exists for
    // — see the "what is logged" note in src/brain/logger.js.
    logWarn('diagnostics', `Live API check failed (${provider} · ${model}): ${err.message}`);
    return {
      ok: false,
      provider,
      model,
      latencyMs: Date.now() - started,
      error: err.message,
    };
  }
}
