/**
 * Persistent app configuration — stored in .curator-config.json at project root.
 * Priority order for domainsPath:
 *   1. .curator-config.json  (set via UI)
 *   2. DOMAINS_PATH env var  (set in .env)
 *   3. ./domains             (default, relative to project root)
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const CONFIG_FILE  = path.join(PROJECT_ROOT, '.curator-config.json');
const DEFAULT_DOMAINS = path.join(PROJECT_ROOT, 'domains');

function readRaw() {
  if (!existsSync(CONFIG_FILE)) return {};
  try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return {}; }
}

function writeRaw(data) {
  writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/** Returns the resolved, absolute path to the domains folder. */
export function getDomainsDir() {
  const cfg = readRaw();
  if (cfg.domainsPath) return path.resolve(cfg.domainsPath);
  if (process.env.DOMAINS_PATH) return path.resolve(process.env.DOMAINS_PATH);
  return DEFAULT_DOMAINS;
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
