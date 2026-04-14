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

/** Save API keys to .curator-config.json. Partial update — only overwrites provided keys. */
export function setApiKeys({ geminiApiKey, anthropicApiKey }) {
  const cfg = readRaw();
  if (geminiApiKey !== undefined)    cfg.geminiApiKey    = geminiApiKey;
  if (anthropicApiKey !== undefined) cfg.anthropicApiKey = anthropicApiKey;
  writeRaw(cfg);
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
