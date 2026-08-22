/**
 * Persistent app configuration — stored in .curator-config.json in the user-data
 * directory (see src/brain/paths.js; the project root for a repo install).
 * Priority order for domainsPath:
 *   1. .curator-config.json  (set via UI)
 *   2. DOMAINS_PATH env var  (set in .env)
 *   3. <user-data dir>/domains (default — see src/brain/paths.js)
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { writeFileAtomicSync } from './atomic-write.js';
import { getCuratorConfigFile, getDefaultDomainsDir } from './paths.js';

// v3.1.0+: these resolve through paths.js instead of this file's own location.
// In a repo install getUserDataDir() === APP_ROOT, so both are byte-identical
// to the previous `path.join(PROJECT_ROOT, …)`. In a (future) packaged .app
// they move to ~/Library/Application Support/The Curator, which is writable.
//
// Resolved PER CALL, not snapshotted into a const at module load. A snapshot
// would be taken at import time and would silently defeat paths.js's test seams
// (__setUserDataDirOverride / CURATOR_TEST_USER_DATA_DIR) for any test that
// imports this module before setting them — which would mean the test reading
// and WRITING the developer's real .curator-config.json.
const configFile = () => getCuratorConfigFile();

function readRaw() {
  const f = configFile();
  if (!existsSync(f)) return {};
  try { return JSON.parse(readFileSync(f, 'utf8')); }
  catch { return {}; }
}

// v3.0.1-beta.8: atomic write so a kill-mid-write of .curator-config.json
// cannot wipe the user's API keys / domainsPath. Sync variant required —
// callers in this module don't await.
// v3.0.1-beta.20: 0600 — this file holds the Gemini/Anthropic API keys, so it
// must not be readable by other local users.
function writeRaw(data) {
  writeFileAtomicSync(configFile(), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

// Test-only override. Production code NEVER sets this — it stays null, so
// getDomainsDir's real precedence (config → env → default) is unchanged.
// Battle tests use it to point the domains dir at a throwaway tempdir WITHOUT
// mutating the user's real .curator-config.json. The env-var path can't serve
// this role because a real install almost always has `domainsPath` in config,
// which (correctly) wins over the env var.
let _domainsDirOverride = null;

/** Test seam — see _domainsDirOverride. Pass null to clear. */
export function __setDomainsDirOverride(p) {
  _domainsDirOverride = p || null;
}

/** Returns the resolved, absolute path to the domains folder. */
export function getDomainsDir() {
  // In-process test override (set by __setDomainsDirOverride).
  if (_domainsDirOverride) return path.resolve(_domainsDirOverride);
  // Cross-process test override (env). Unlike DOMAINS_PATH, this BEATS config —
  // it exists so battle tests (including ones that spawn a child server, e.g.
  // test-sharedbrain-routes) can point the domains dir at a throwaway tempdir
  // even on a machine whose .curator-config.json sets domainsPath. Test-only;
  // never set in production. The legacy DOMAINS_PATH (below, loses to config)
  // remains for the documented developer fallback.
  if (process.env.CURATOR_TEST_DOMAINS_DIR) return path.resolve(process.env.CURATOR_TEST_DOMAINS_DIR);
  const cfg = readRaw();
  if (cfg.domainsPath) return path.resolve(cfg.domainsPath);
  if (process.env.DOMAINS_PATH) return path.resolve(process.env.DOMAINS_PATH);
  return getDefaultDomainsDir();
}

/** Persists a new domains path to .curator-config.json. */
export function setDomainsDir(newPath) {
  const cfg = readRaw();
  cfg.domainsPath = path.resolve(newPath);
  writeRaw(cfg);
}

/** Returns config object for the UI. */
export function getConfig() {
  const cfg = readRaw();
  const source = cfg.domainsPath ? 'ui'
               : process.env.DOMAINS_PATH ? 'env'
               : 'default';
  return {
    domainsPath: getDomainsDir(),
    domainsPathSource: source,
  };
}

// ── API Keys ────────────────────────────────────────────────────────────────

/** Read API keys from .curator-config.json (not .env). */
export function getApiKeys() {
  const cfg = readRaw();
  return {
    geminiApiKey:    cfg.geminiApiKey    || '',
    anthropicApiKey: cfg.anthropicApiKey || '',
  };
}

/**
 * Save API keys to .curator-config.json. Partial update — only overwrites provided keys.
 *
 * Saving a non-empty key for a provider ALSO sets it as the active provider.
 * This implements "last-saved-wins": users don't juggle priorities, they just
 * paste the key they want to use. If both fields are submitted in one save,
 * whichever non-empty key is encountered last takes the active slot (the
 * current frontend sends {geminiApiKey, anthropicApiKey} in that order, so
 * Anthropic wins a dual-save — deterministic, rare edge case).
 */
export function setApiKeys({ geminiApiKey, anthropicApiKey }) {
  const cfg = readRaw();
  if (geminiApiKey !== undefined) {
    cfg.geminiApiKey = geminiApiKey;
    if (geminiApiKey) cfg.activeProvider = 'gemini';
  }
  if (anthropicApiKey !== undefined) {
    cfg.anthropicApiKey = anthropicApiKey;
    if (anthropicApiKey) cfg.activeProvider = 'anthropic';
  }
  writeRaw(cfg);
}

/**
 * Clear a specific provider's stored key. Used by the Settings "Disconnect"
 * button so users can wipe a key without having to add a new one.
 * If the cleared key was the active provider, active switches to the other
 * provider (if it has a key), or to null.
 */
export function clearApiKey(provider) {
  if (provider !== 'gemini' && provider !== 'anthropic') return;
  const cfg = readRaw();
  if (provider === 'gemini')    cfg.geminiApiKey = '';
  if (provider === 'anthropic') cfg.anthropicApiKey = '';
  if (cfg.activeProvider === provider) {
    if (provider === 'gemini'    && cfg.anthropicApiKey) cfg.activeProvider = 'anthropic';
    else if (provider === 'anthropic' && cfg.geminiApiKey)    cfg.activeProvider = 'gemini';
    else delete cfg.activeProvider;
  }
  writeRaw(cfg);
}

/**
 * Explicitly set the active provider WITHOUT re-saving its key. Powers the
 * Settings provider toggle: a user holding both a Gemini and an Anthropic key
 * can flip which one is live with one click, instead of re-pasting a key
 * (which the "last-saved-wins" path in setApiKeys requires) or disconnecting
 * the other (which deletes a key).
 *
 * Refuses to activate a provider that has no stored key — switching to a
 * provider with no key would break every subsequent LLM call. Returns the
 * resulting active provider (unchanged if the switch was refused).
 */
export function setActiveProvider(provider) {
  if (provider !== 'gemini' && provider !== 'anthropic') return getActiveProvider();
  const cfg = readRaw();
  const hasKey = provider === 'gemini'
    ? !!(cfg.geminiApiKey || process.env.GEMINI_API_KEY)
    : !!(cfg.anthropicApiKey || process.env.ANTHROPIC_API_KEY);
  if (!hasKey) return getActiveProvider();
  cfg.activeProvider = provider;
  writeRaw(cfg);
  return provider;
}

/**
 * Returns the provider the user most recently activated via the Settings UI.
 * For legacy configs (pre-v2.4.2) that don't have an activeProvider field,
 * falls back to the previous "Gemini-first if both are set" behaviour so
 * existing installations keep working without any action.
 */
export function getActiveProvider() {
  const cfg = readRaw();
  if (cfg.activeProvider === 'gemini' || cfg.activeProvider === 'anthropic') {
    return cfg.activeProvider;
  }
  // Legacy priority: whichever key exists, Gemini first
  if (cfg.geminiApiKey)    return 'gemini';
  if (cfg.anthropicApiKey) return 'anthropic';
  if (process.env.GEMINI_API_KEY)    return 'gemini';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  return null;
}

// ── AI Health settings (v2.4.5+) ─────────────────────────────────────────────

const DEFAULT_AI_HEALTH = {
  costCeilingTokens:    50_000, // hard-stops semantic-dupe scan before LLM calls
  semanticDupeMaxPairs: 500,    // candidate-pair cap out of the pre-filter
};

/**
 * Returns the persisted AI Health settings, falling back to defaults for
 * missing fields so new installs pick up sensible values without needing
 * a config migration.
 */
export function getAiHealthSettings() {
  const cfg = readRaw();
  const stored = cfg.aiHealth || {};
  return {
    costCeilingTokens:    Number.isInteger(stored.costCeilingTokens) && stored.costCeilingTokens > 0
                          ? stored.costCeilingTokens : DEFAULT_AI_HEALTH.costCeilingTokens,
    semanticDupeMaxPairs: Number.isInteger(stored.semanticDupeMaxPairs) && stored.semanticDupeMaxPairs > 0
                          ? stored.semanticDupeMaxPairs : DEFAULT_AI_HEALTH.semanticDupeMaxPairs,
  };
}

/**
 * Partial update — pass only the fields you want to change. Non-numeric or
 * non-positive values are ignored (UI enforces sane ranges; this is the
 * last line of defence).
 */
export function setAiHealthSettings({ costCeilingTokens, semanticDupeMaxPairs } = {}) {
  const cfg = readRaw();
  const next = { ...(cfg.aiHealth || {}) };
  if (Number.isFinite(costCeilingTokens) && costCeilingTokens > 0) {
    next.costCeilingTokens = Math.round(costCeilingTokens);
  }
  if (Number.isFinite(semanticDupeMaxPairs) && semanticDupeMaxPairs > 0) {
    next.semanticDupeMaxPairs = Math.round(semanticDupeMaxPairs);
  }
  cfg.aiHealth = next;
  writeRaw(cfg);
  return getAiHealthSettings();
}

// ── Default domain (v2.5.2+) ─────────────────────────────────────────────────
// Used by the MCP write tools when the user says "my wiki" without naming a
// domain. If unset, MCP tools must require an explicit domain argument and
// can use list_domains to enumerate.

/** Returns the user's preferred default domain slug, or null if unset. */
export function getDefaultDomain() {
  const cfg = readRaw();
  const v = cfg.defaultDomain;
  return typeof v === 'string' && v ? v : null;
}

/** Sets or clears the default domain. Pass null/empty to unset. */
export function setDefaultDomain(slug) {
  const cfg = readRaw();
  if (slug && typeof slug === 'string') {
    cfg.defaultDomain = slug;
  } else {
    delete cfg.defaultDomain;
  }
  writeRaw(cfg);
  return getDefaultDomain();
}

// ── Shared Brain feature flag (v3.0.0+) ─────────────────────────────────────
// When false (default), Shared Brain routes return 404 and the UI hides the
// section. Circuit-breaker: if a Shared Brain bug ships, a hotfix can flip
// the flag globally without rolling back any code. See docs/shared-brain-design.md.

/** Returns true if the Shared Brain feature is enabled for this install. */
export function getSharedBrainEnabled() {
  const cfg = readRaw();
  return cfg.sharedBrainEnabled === true;
}

/** Enables or disables the Shared Brain feature. */
export function setSharedBrainEnabled(enabled) {
  const cfg = readRaw();
  cfg.sharedBrainEnabled = !!enabled;
  writeRaw(cfg);
  return getSharedBrainEnabled();
}

/**
 * Returns the effective API key for a provider.
 * Priority: .curator-config.json → process.env → null
 */
export function getEffectiveKey(provider) {
  const keys = getApiKeys();
  if (provider === 'gemini') {
    return keys.geminiApiKey || process.env.GEMINI_API_KEY || null;
  }
  if (provider === 'anthropic') {
    return keys.anthropicApiKey || process.env.ANTHROPIC_API_KEY || null;
  }
  return null;
}
