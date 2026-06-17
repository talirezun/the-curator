/**
 * Shared Brain — Connection Config
 *
 * Stores user-configured Shared Brain connections in
 * `.sharedbrain-config.json` at the project root. Gitignored — contains
 * tokens. Mirrors the storage pattern used by .sync-config.json.
 *
 * Schema (one file per install, contains an array of connections):
 *
 * {
 *   "connections": [
 *     {
 *       "id": "<uuid>",
 *       "label": "Cohort Brain",
 *       "storage_type": "local" | "github" | "cloudflare-r2",
 *
 *       // LocalFolder fields (storage_type === 'local')
 *       "local_storage_path": "/absolute/path/to/storage/folder",
 *
 *       // GitHub fields (storage_type === 'github') — Phase 3
 *       "github_repo_owner": "...",
 *       "github_repo_name":  "...",
 *       "github_pat":        "...",        // NEVER displayed past first 8 chars
 *       "github_branch":     "main",
 *
 *       // Cloudflare R2 fields (storage_type === 'cloudflare-r2') — Phase 3.1
 *       "endpoint":     "https://brain.example.com",
 *       "fellow_token": "...",             // NEVER displayed past first 8 chars
 *       "admin_token":  null,              // optional — for revoke / synthesis ops
 *
 *       // Common fields (every storage_type)
 *       "fellow_id":              "<uuid>",
 *       "fellow_display_name":    "Dr. Tali Režun",
 *       "shared_domain":          "work-ai",      // domain slug in REMOTE storage
 *       "shared_brain_slug":      "cohort",       // used for local: shared-cohort
 *       "local_domains":          ["work-ai"],     // local domain slugs that contribute
 *       "attribute_by_name":      false,           // GDPR — Decision 6a; default UUID
 *       "last_push_at":           null,
 *       "last_pull_at":           null,
 *       "pending_retry":          {},              // path → attempt count (Decision 3)
 *       "permanent_skip":         [],              // paths that failed 3+ times
 *       "enabled":                true
 *     }
 *   ]
 * }
 *
 * Token-masking discipline:
 *   - getSharedBrains()           — masks tokens for UI listings
 *   - getSharedBrainWithToken(id) — returns full tokens for internal push/pull
 *   - Never log tokens. Never include them in SSE event payloads or error
 *     messages. Spec Part 10 invariants 2 and 8.
 */

import { readFileSync, existsSync } from 'fs';
import { randomUUID } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { writeFileAtomicSync } from './atomic-write.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const CONFIG_FILE  = path.join(PROJECT_ROOT, '.sharedbrain-config.json');

// Fields that are credentials — masked in UI listings, never logged.
const TOKEN_FIELDS = ['github_pat', 'fellow_token', 'admin_token'];

// Visible prefix length when masking. Matches the spec's
// "first 8 chars + mask" rule (Part 9.1 token display rule).
const MASK_VISIBLE_PREFIX = 8;

// ── File I/O ────────────────────────────────────────────────────────────────

function readRaw() {
  if (!existsSync(CONFIG_FILE)) return { connections: [] };
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    if (!parsed || !Array.isArray(parsed.connections)) return { connections: [] };
    return parsed;
  } catch {
    return { connections: [] };
  }
}

// v3.0.1-beta.20: atomic + 0600 — this file holds Shared Brain credentials
// (github_pat, fellow_token, admin_token), so it must not be world-readable,
// and a kill mid-write must not corrupt every connection's tokens.
function writeRaw(data) {
  writeFileAtomicSync(CONFIG_FILE, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

// ── Masking ─────────────────────────────────────────────────────────────────

/** Returns a copy of `conn` with token fields masked for UI display. */
function maskTokens(conn) {
  const out = { ...conn };
  for (const field of TOKEN_FIELDS) {
    if (typeof out[field] === 'string' && out[field].length > 0) {
      const visible = out[field].slice(0, MASK_VISIBLE_PREFIX);
      out[field] = `${visible}…`; // ellipsis instead of "..." so it's unambiguous
    }
  }
  return out;
}

// ── Validation ──────────────────────────────────────────────────────────────

function isUuid(s) {
  return typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function validateConnection(conn) {
  if (!conn || typeof conn !== 'object') {
    throw new Error('SharedBrain connection: must be an object');
  }
  if (!isUuid(conn.id)) {
    throw new Error('SharedBrain connection: id must be a UUID');
  }
  if (typeof conn.label !== 'string' || !conn.label.trim()) {
    throw new Error('SharedBrain connection: label is required');
  }
  if (!['local', 'github', 'cloudflare-r2'].includes(conn.storage_type)) {
    throw new Error(`SharedBrain connection: storage_type must be one of local|github|cloudflare-r2 (got ${conn.storage_type})`);
  }
  if (conn.storage_type === 'local') {
    if (typeof conn.local_storage_path !== 'string' || !path.isAbsolute(conn.local_storage_path)) {
      throw new Error('SharedBrain connection: local_storage_path must be an absolute path');
    }
  }
  // Defense-in-depth XSS guard: when github storage, the owner/name fields
  // flow into rendered URLs in the connection card. Validate them with the
  // same regex GitHub uses for usernames + repo names.
  if (conn.storage_type === 'github') {
    if (typeof conn.github_repo_owner !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(conn.github_repo_owner)) {
      throw new Error('SharedBrain connection: github_repo_owner must be a valid GitHub login (alphanumeric + hyphen, ≤39 chars)');
    }
    if (typeof conn.github_repo_name !== 'string' ||
        !/^[A-Za-z0-9._-]{1,100}$/.test(conn.github_repo_name)) {
      throw new Error('SharedBrain connection: github_repo_name must be a valid GitHub repo name');
    }
    if (conn.github_branch !== undefined && conn.github_branch !== '' &&
        (typeof conn.github_branch !== 'string' ||
         !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(conn.github_branch) ||
         conn.github_branch.includes('..'))) {
      throw new Error('SharedBrain connection: github_branch must be a valid git ref name (no .. segments)');
    }
    if (typeof conn.github_pat !== 'string' || conn.github_pat.length < 20 || conn.github_pat.length > 400) {
      throw new Error('SharedBrain connection: github_pat is required (20-400 chars)');
    }
    // Defense against the round-trip-of-masked-token bug: if someone POSTs
    // a connection whose PAT looks like the masked-display form (ends in
    // the Unicode ellipsis we use for masking), refuse — the caller almost
    // certainly read it from a masked listing and would clobber the real PAT.
    if (/…$/.test(conn.github_pat)) {
      throw new Error('SharedBrain connection: github_pat appears to be a masked display value (ends in …). Pass the full PAT or omit the field to keep the existing one.');
    }
  }
  if (!isUuid(conn.fellow_id)) {
    throw new Error('SharedBrain connection: fellow_id must be a UUID');
  }
  if (typeof conn.fellow_display_name !== 'string') {
    throw new Error('SharedBrain connection: fellow_display_name must be a string');
  }
  if (typeof conn.shared_domain !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/i.test(conn.shared_domain)) {
    throw new Error('SharedBrain connection: shared_domain must be a slug-shaped string');
  }
  if (typeof conn.shared_brain_slug !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/i.test(conn.shared_brain_slug)) {
    throw new Error('SharedBrain connection: shared_brain_slug must be a slug-shaped string');
  }
  if (!Array.isArray(conn.local_domains) || !conn.local_domains.every(d => typeof d === 'string' && /^[a-z0-9][a-z0-9_-]*$/i.test(d))) {
    throw new Error('SharedBrain connection: local_domains must be an array of slug-shaped strings');
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * List all configured Shared Brain connections, with tokens masked.
 * Safe to return to the UI / log.
 */
export function getSharedBrains() {
  const raw = readRaw();
  return raw.connections.map(maskTokens);
}

/**
 * Get a single connection by id, with FULL tokens. Internal use only —
 * push/pull/synthesis operations call this. NEVER return the result to
 * the UI directly.
 */
export function getSharedBrainWithToken(id) {
  if (!isUuid(id)) return null;
  const raw = readRaw();
  return raw.connections.find(c => c.id === id) || null;
}

/**
 * Save a connection (insert or update by id). Returns the masked version.
 * Caller is responsible for ensuring tokens / fellow_id / id are set
 * BEFORE calling save — this is not a partial-update helper.
 */
export function saveSharedBrain(conn) {
  validateConnection(conn);
  const raw = readRaw();
  const idx = raw.connections.findIndex(c => c.id === conn.id);
  if (idx === -1) {
    raw.connections.push(conn);
  } else {
    raw.connections[idx] = conn;
  }
  writeRaw(raw);
  return maskTokens(conn);
}

/** Remove a connection by id. Returns true if removed, false if not found. */
export function removeSharedBrain(id) {
  if (!isUuid(id)) return false;
  const raw = readRaw();
  const before = raw.connections.length;
  raw.connections = raw.connections.filter(c => c.id !== id);
  if (raw.connections.length === before) return false;
  writeRaw(raw);
  return true;
}

/**
 * Patch a subset of a connection's fields. Helpful for state updates
 * (last_push_at, pending_retry, etc) where the caller doesn't want to
 * re-supply the whole record. Token fields cannot be patched via this
 * function — use saveSharedBrain() for credential changes.
 */
export function patchSharedBrain(id, patch) {
  if (!isUuid(id)) return null;
  if (!patch || typeof patch !== 'object') return null;
  const raw = readRaw();
  const idx = raw.connections.findIndex(c => c.id === id);
  if (idx === -1) return null;

  // Reject token-field updates here — those go through saveSharedBrain
  // with full validation. This keeps a single, audited write path for credentials.
  for (const field of TOKEN_FIELDS) {
    if (field in patch) {
      throw new Error(`patchSharedBrain: cannot update credential field "${field}" via patch — use saveSharedBrain`);
    }
  }

  raw.connections[idx] = { ...raw.connections[idx], ...patch };
  writeRaw(raw);
  return maskTokens(raw.connections[idx]);
}

/** Generate a UUID. Wraps Node.js built-in crypto.randomUUID for convenience. */
export function newUuid() {
  return randomUUID();
}

// Test surface — internal validation helpers exposed for the battle-test script.
export const __testing = { isUuid, maskTokens, validateConnection, TOKEN_FIELDS };
