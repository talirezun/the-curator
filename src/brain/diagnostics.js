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
import { getDomainsDir } from './config.js';
import { appPath, getCredentialFiles } from './paths.js';
import { getProviderInfo, generateText, getFallbackStatus } from './llm.js';
import { isConfigured as syncConfigured, getStatus as syncGetStatus } from './sync.js';
import { writeFileAtomic } from './atomic-write.js';

// Files that should be owner-only (0600). getCredentialFiles() in paths.js is
// the SINGLE source of truth, shared with the startup chmod sweep in
// server.js — the two lists previously had to be kept in sync by hand.

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

// ── 2. AI provider key configured (no API call) ──────────────────────────────
function checkProvider() {
  try {
    const { provider, model } = getProviderInfo();
    const fb = getFallbackStatus?.();
    const fbNote = fb ? ` (currently using fallback model ${fb.usingModel})` : '';
    return check('provider', 'AI provider key', 'ok',
      `Configured: ${provider} · ${model}${fbNote}`);
  } catch {
    return check('provider', 'AI provider key', 'warn',
      'No API key configured. Add a Gemini or Anthropic key above to enable ingest, chat, and AI Health.');
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

/**
 * Run all FREE, local checks. No network, no API call, no cost. Returns
 * { checks: [...], summary: {ok, warn, fail, info} }.
 */
export async function runQuickDiagnostics() {
  const checks = [
    checkVersion(),
    checkProvider(),
    await checkDomainsWritable(),
    checkCredentialPerms(),
    await checkSync(),
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
    return { ok: false, error: 'No API key configured. Add a Gemini or Anthropic key in Settings first.' };
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
    return {
      ok: false,
      provider,
      model,
      latencyMs: Date.now() - started,
      error: err.message,
    };
  }
}
