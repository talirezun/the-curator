/**
 * Shared Brain — Local Folder Storage Adapter
 *
 * Stores the entire collective brain in a plain folder on disk. Used for
 * battle-testing the push/pull/synthesis flow on a single machine before
 * any network adapter (GitHub, Cloudflare R2) is wired up.
 *
 * Three Curator instances on the same machine — each with a separate
 * DOMAINS_PATH and a separate `fellow_id` — can point at the SAME
 * `local_storage_path` and simulate a real cohort without any cloud
 * dependency. Phase 2 milestone 2A → 2E uses exactly this setup.
 *
 * Security:
 *   - resolveInsideBase() blocks path traversal on every read/write.
 *     Same chokepoint used by mcp/storage/local.js.
 *   - No credentials are stored or transmitted (it's a local folder),
 *     so there's nothing to mask in error messages.
 */

import { readFile, writeFile, mkdir, readdir, stat, unlink, appendFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { writeFileAtomic } from './atomic-write.js';
import { SharedBrainStorageAdapter } from './sharedbrain-storage.js';

/**
 * Resolves `relative` against `base` and refuses if the result escapes `base`.
 * Returns the resolved absolute path, or null on attempted traversal.
 * Matches the semantics of mcp/storage/local.js → resolveInsideBase().
 */
function resolveInsideBase(base, relative) {
  if (relative === null || relative === undefined) return null;
  if (typeof relative !== 'string') return null;
  // Reject absolute paths outright.
  if (path.isAbsolute(relative)) return null;
  const resolved = path.resolve(base, relative);
  const baseResolved = path.resolve(base);
  // Must be inside base (or equal to base).
  if (resolved !== baseResolved && !resolved.startsWith(baseResolved + path.sep)) {
    return null;
  }
  return resolved;
}

/** Slug validator — disallow path-traversal characters in domain/fellowId/submissionId args. */
function isSafeId(s) {
  return typeof s === 'string' && /^[a-z0-9][a-z0-9_-]{0,127}$/i.test(s);
}

/** Convert a dotted meta key ("state.last-synthesis") into a relative file path ("state/last-synthesis.json"). */
function metaKeyToPath(key) {
  if (typeof key !== 'string' || !key) return null;
  // Reject any traversal attempt or weird chars.
  if (!/^[a-z0-9._-]+(\.[a-z0-9._-]+)*$/i.test(key)) return null;
  return key.split('.').join('/') + '.json';
}

export class LocalFolderStorageAdapter extends SharedBrainStorageAdapter {
  /**
   * @param {object} config
   * @param {string} config.storage_root  Absolute path to the shared storage folder on disk.
   *                                      Must be writeable. The adapter creates subfolders as needed.
   */
  constructor(config) {
    super();
    if (!config || !config.storage_root) {
      throw new Error('LocalFolderStorageAdapter: config.storage_root is required');
    }
    if (!path.isAbsolute(config.storage_root)) {
      throw new Error('LocalFolderStorageAdapter: config.storage_root must be an absolute path');
    }
    this.root = path.resolve(config.storage_root);
  }

  // ── Internal path builders ──────────────────────────────────────────────

  _wikiPath(domain, relPath) {
    if (!isSafeId(domain)) return null;
    // CRITICAL: resolve relPath against the per-domain wiki/ folder, NOT against
    // this.root. If we joined everything and then checked against this.root, a
    // path like "../../etc/passwd" would normalise to "collective/etc/passwd",
    // which IS inside this.root but ESCAPES the domain's wiki/ — letting an
    // attacker write into contributions/, digests/, meta/, or another domain.
    const wikiBase = path.join(this.root, 'collective', domain, 'wiki');
    return resolveInsideBase(wikiBase, relPath);
  }

  _contribPath(fellowId, submissionId) {
    if (!isSafeId(fellowId) || !isSafeId(submissionId)) return null;
    const rel = path.join('contributions', fellowId, `${submissionId}.json`);
    return resolveInsideBase(this.root, rel);
  }

  _digestPath(fellowId) {
    if (!isSafeId(fellowId)) return null;
    const rel = path.join('digests', fellowId, 'latest.json');
    return resolveInsideBase(this.root, rel);
  }

  _metaPath(key) {
    const rel = metaKeyToPath(key);
    if (!rel) return null;
    return resolveInsideBase(this.root, path.join('meta', rel));
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  async _readFileOrNull(absPath) {
    if (!absPath) return null;
    if (!existsSync(absPath)) return null;
    return readFile(absPath, 'utf8');
  }

  async _writeFile(absPath, content) {
    await mkdir(path.dirname(absPath), { recursive: true });
    // v3.0.1-beta.8: atomic so a kill mid-write of a contribution / digest /
    // collective wiki page can't leave a truncated file in the local mirror.
    // NB — does NOT cover the appendFile call at line ~304 (audit JSONL),
    // which is intentionally append-only and crash-safe at line granularity.
    await writeFileAtomic(absPath, content, 'utf8');
  }

  async _listDirRecursive(absDir, prefix = '') {
    if (!existsSync(absDir)) return [];
    const out = [];
    const entries = await readdir(absDir, { withFileTypes: true });
    for (const entry of entries) {
      const childAbs = path.join(absDir, entry.name);
      const childRel = prefix ? path.join(prefix, entry.name) : entry.name;
      if (entry.isDirectory()) {
        const sub = await this._listDirRecursive(childAbs, childRel);
        out.push(...sub);
      } else if (entry.isFile()) {
        out.push(childRel);
      }
    }
    return out;
  }

  // ── Page operations ─────────────────────────────────────────────────────

  async readPage(domain, relPath) {
    const abs = this._wikiPath(domain, relPath);
    if (!abs) return null;
    return this._readFileOrNull(abs);
  }

  async writePage(domain, relPath, content) {
    const abs = this._wikiPath(domain, relPath);
    if (!abs) throw new Error(`LocalFolderStorageAdapter.writePage: unsafe domain or path (${domain}, ${relPath})`);
    if (typeof content !== 'string') throw new Error('writePage: content must be a string');
    await this._writeFile(abs, content);
  }

  async listPages(domain, prefix = '') {
    if (!isSafeId(domain)) return [];
    const base = path.join(this.root, 'collective', domain, 'wiki');
    if (typeof prefix !== 'string') prefix = '';
    // Guard prefix too — must resolve inside base.
    const baseWithPrefix = prefix
      ? resolveInsideBase(base, prefix)
      : base;
    if (!baseWithPrefix) return [];
    const items = await this._listDirRecursive(baseWithPrefix);
    // Return paths relative to wiki/ (re-include the prefix the caller asked about).
    return prefix ? items.map(p => path.join(prefix, p)) : items;
  }

  // ── Meta operations ─────────────────────────────────────────────────────

  async readMeta(key) {
    const abs = this._metaPath(key);
    if (!abs) return null;
    const raw = await this._readFileOrNull(abs);
    if (raw === null) return null;
    try { return JSON.parse(raw); }
    catch { return null; }
  }

  async writeMeta(key, value) {
    const abs = this._metaPath(key);
    if (!abs) throw new Error(`LocalFolderStorageAdapter.writeMeta: unsafe key "${key}"`);
    await this._writeFile(abs, JSON.stringify(value, null, 2) + '\n');
  }

  // ── Contribution operations ─────────────────────────────────────────────

  async storeContribution(fellowId, submissionId, payload) {
    const abs = this._contribPath(fellowId, submissionId);
    if (!abs) throw new Error(`LocalFolderStorageAdapter.storeContribution: unsafe ids (${fellowId}, ${submissionId})`);
    await this._writeFile(abs, JSON.stringify(payload, null, 2) + '\n');
  }

  async contributionExists(fellowId, submissionId) {
    const abs = this._contribPath(fellowId, submissionId);
    if (!abs) return false;
    return existsSync(abs);
  }

  async listContributionsSince(sinceIso) {
    const baseDir = path.join(this.root, 'contributions');
    if (!existsSync(baseDir)) return [];
    const sinceMs = sinceIso ? new Date(sinceIso).getTime() : 0;
    if (Number.isNaN(sinceMs)) {
      throw new Error(`LocalFolderStorageAdapter.listContributionsSince: invalid sinceIso "${sinceIso}"`);
    }

    const out = [];
    const fellowDirs = await readdir(baseDir, { withFileTypes: true });
    for (const fellowDir of fellowDirs) {
      if (!fellowDir.isDirectory()) continue;
      const fellowId = fellowDir.name;
      if (!isSafeId(fellowId)) continue; // skip suspicious folder names
      const fellowAbs = path.join(baseDir, fellowId);
      const files = await readdir(fellowAbs, { withFileTypes: true });
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith('.json')) continue;
        const submissionId = file.name.slice(0, -5); // strip .json
        if (!isSafeId(submissionId)) continue;
        const abs = path.join(fellowAbs, file.name);
        const raw = await readFile(abs, 'utf8');
        let payload;
        try { payload = JSON.parse(raw); } catch { continue; }
        // Filter by contributed_at if present. v3.0.3 (M8): missing or
        // unparseable stamps are INCLUDED — silently dropping a contribution
        // over a corrupt date would lose a fellow's work; synthesis's
        // processed-ID tracking bounds the reprocessing cost.
        const contributedAt = payload && payload.contributed_at
          ? new Date(payload.contributed_at).getTime()
          : NaN;
        if (Number.isNaN(contributedAt) || contributedAt >= sinceMs) {
          out.push({ fellowId, submissionId, payload });
        }
      }
    }
    // Stable order: oldest first by contributed_at, then by submissionId.
    out.sort((a, b) => {
      const ta = a.payload.contributed_at ? new Date(a.payload.contributed_at).getTime() : 0;
      const tb = b.payload.contributed_at ? new Date(b.payload.contributed_at).getTime() : 0;
      if (ta !== tb) return ta - tb;
      return a.submissionId.localeCompare(b.submissionId);
    });
    return out;
  }

  // ── Digest operations ───────────────────────────────────────────────────

  async storeDigest(fellowId, digest) {
    const abs = this._digestPath(fellowId);
    if (!abs) throw new Error(`LocalFolderStorageAdapter.storeDigest: unsafe fellowId "${fellowId}"`);
    await this._writeFile(abs, JSON.stringify(digest, null, 2) + '\n');
  }

  async loadDigest(fellowId) {
    const abs = this._digestPath(fellowId);
    if (!abs) return null;
    const raw = await this._readFileOrNull(abs);
    if (raw === null) return null;
    try { return JSON.parse(raw); }
    catch { return null; }
  }

  // ── Phase 4F: revoke support (Decision 6b) ─────────────────────────────────

  async deletePage(domain, relPath) {
    const abs = this._wikiPath(domain, relPath);
    if (!abs) throw new Error(`LocalFolderStorageAdapter.deletePage: unsafe domain or path (${domain}, ${relPath})`);
    if (!existsSync(abs)) return false;
    await unlink(abs);
    return true;
  }

  async deleteContribution(fellowId, submissionId) {
    const abs = this._contribPath(fellowId, submissionId);
    if (!abs) throw new Error(`LocalFolderStorageAdapter.deleteContribution: unsafe ids (${fellowId}, ${submissionId})`);
    if (!existsSync(abs)) return false;
    await unlink(abs);
    return true;
  }

  async deleteDigest(fellowId) {
    const abs = this._digestPath(fellowId);
    if (!abs) throw new Error(`LocalFolderStorageAdapter.deleteDigest: unsafe fellowId "${fellowId}"`);
    if (!existsSync(abs)) return false;
    await unlink(abs);
    return true;
  }

  async listFellowSubmissions(fellowId) {
    if (!isSafeId(fellowId)) return [];
    const fellowDir = path.join(this.root, 'contributions', fellowId);
    if (!existsSync(fellowDir)) return [];
    const files = await readdir(fellowDir, { withFileTypes: true });
    return files
      .filter(f => f.isFile() && f.name.endsWith('.json'))
      .map(f => f.name.slice(0, -5))
      .filter(isSafeId);
  }

  async appendAudit(relPath, record) {
    if (typeof relPath !== 'string' || !relPath) {
      throw new Error('appendAudit: relPath is required');
    }
    // Validate the audit log path: must be inside `state/` and end in `.jsonl`.
    if (!relPath.startsWith('state/') || !relPath.endsWith('.jsonl')) {
      throw new Error(`appendAudit: relPath must be under state/ and end with .jsonl (got "${relPath}")`);
    }
    const abs = resolveInsideBase(this.root, relPath);
    if (!abs) throw new Error(`appendAudit: unsafe path "${relPath}"`);
    await mkdir(path.dirname(abs), { recursive: true });
    const line = JSON.stringify(record) + '\n';
    await appendFile(abs, line, 'utf8');
  }
}

// Exposed for testing only — the resolveInsideBase guard semantics.
export const __testing = { resolveInsideBase, isSafeId, metaKeyToPath };
