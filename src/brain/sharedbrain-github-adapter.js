/**
 * Shared Brain — GitHub REST API Storage Adapter
 *
 * Backs a Shared Brain with a single private GitHub repository, using
 * fine-grained PATs (Contents R/W + Metadata R) per Decision 1 in
 * docs/shared-brain-design.md. SHA-based optimistic concurrency. All writes
 * land on the configured branch (default "main"). No path-level scoping.
 *
 * Mapping to the storage interface (identical schema across all adapters):
 *
 *   collective/<domain>/wiki/<path>           → wiki pages
 *   contributions/<fellowId>/<submissionId>.json
 *   digests/<fellowId>/latest.json
 *   meta/<key-as-path>.json
 *
 * Security:
 *   - The PAT is held only in this adapter instance and used as the value
 *     of the Authorization header. It is never logged, never embedded in
 *     a thrown Error message, never serialised, never returned from any
 *     public method. The token-leak audit in
 *     scripts/test-sharedbrain-github-offline.js asserts this.
 *   - Path-traversal hardening: every domain, fellowId, submissionId, and
 *     relative wiki path is validated via isSafeId() / refusePathTraversal()
 *     before any HTTP call. ".." segments, absolute paths, leading slashes,
 *     and control characters are rejected.
 *
 * Concurrency:
 *   - Reads return both the decoded content AND the GitHub blob SHA.
 *   - Writes pass the SHA back (if updating) so GitHub rejects with 409
 *     on concurrent mutation. The adapter refetches once and retries; a
 *     second 409 throws SHARED_BRAIN_CONCURRENT_WRITE with the path
 *     (no token).
 *   - This is best-effort optimistic concurrency, not a global lock.
 *     Synthesis runs are expected to be coordinated at the org level
 *     (single admin trigger), not via this primitive.
 *
 * Rate limits:
 *   - GitHub fine-grained PATs get 5000 REST requests/hour.
 *   - When X-RateLimit-Remaining drops below 50, a stderr warning fires.
 *   - 429 or 403-with-rate-limit-zero throws a typed error directing
 *     the user to wait until reset.
 */

import { readFileSync } from 'fs';
import path from 'path';
import { SharedBrainStorageAdapter } from './sharedbrain-storage.js';
import { appPath } from './paths.js';

// ── Curator version (for User-Agent) ──────────────────────────────────────

let CURATOR_VERSION = 'unknown';
try {
  const pkg = JSON.parse(readFileSync(appPath('package.json'), 'utf8'));
  CURATOR_VERSION = pkg.version || 'unknown';
} catch { /* keep "unknown" */ }

const USER_AGENT = `the-curator-sharedbrain/${CURATOR_VERSION}`;
const GITHUB_API = 'https://api.github.com';

// ── Validation helpers (identical semantics to local adapter) ─────────────

/** Slug validator — matches LocalFolderStorageAdapter.isSafeId. */
function isSafeId(s) {
  return typeof s === 'string' && /^[a-z0-9][a-z0-9_-]{0,127}$/i.test(s);
}

/** Branch name validator — GitHub permits a richer set, but we lock to slug-safe. */
function isSafeBranch(s) {
  return typeof s === 'string' && /^[a-z0-9][a-z0-9._/-]{0,127}$/i.test(s);
}

/**
 * Reject any candidate relative path that:
 *   - is null/non-string
 *   - is absolute (starts with "/")
 *   - contains ".." segments
 *   - contains a null byte or control character
 *   - is empty (we always require a real path at the leaf level)
 * Returns the normalised path on success, null on rejection.
 */
function safeRelPath(rel) {
  if (typeof rel !== 'string' || rel.length === 0) return null;
  if (rel.startsWith('/') || rel.startsWith('\\')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(rel)) return null;
  // Normalise to forward slashes for GitHub paths.
  const norm = rel.replace(/\\/g, '/');
  const parts = norm.split('/');
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') return null;
  }
  return parts.join('/');
}

/** Convert a dotted meta key ("state.last-synthesis") into a repo path ("meta/state/last-synthesis.json"). */
function metaKeyToRepoPath(key) {
  if (typeof key !== 'string' || !key) return null;
  if (!/^[a-z0-9._-]+(\.[a-z0-9._-]+)*$/i.test(key)) return null;
  return 'meta/' + key.split('.').join('/') + '.json';
}

// ── Base64 helpers (Node-native, no dependency) ──────────────────────────

function encodeContent(str) {
  return Buffer.from(str, 'utf8').toString('base64');
}

function decodeContent(b64) {
  return Buffer.from(b64, 'base64').toString('utf8');
}

// ── Typed errors (never carry credential bytes) ──────────────────────────

class GitHubAdapterError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'GitHubAdapterError';
    this.code = code;
    if (typeof status === 'number') this.status = status;
  }
}

/**
 * Defence-in-depth sanitiser for response-body detail text that we
 * concatenate into thrown error messages. GitHub's own error responses
 * should never include a caller's PAT, but adversarial proxies or
 * misbehaving plugins could. Strip the known GitHub credential shapes
 * before any string ever leaves this module.
 *
 * Token prefixes documented at:
 *   https://github.blog/2021-04-05-behind-githubs-new-authentication-token-formats/
 */
const TOKEN_PATTERNS = [
  /github_pat_[A-Za-z0-9_]+/g,  // fine-grained PAT
  /ghp_[A-Za-z0-9]{20,}/g,      // classic PAT
  /gho_[A-Za-z0-9]{20,}/g,      // OAuth access token
  /ghu_[A-Za-z0-9]{20,}/g,      // user-to-server token
  /ghs_[A-Za-z0-9]{20,}/g,      // server-to-server token
  /ghr_[A-Za-z0-9]{20,}/g,      // refresh token
];

function sanitizeDetail(s) {
  if (typeof s !== 'string') return '';
  let out = s;
  for (const re of TOKEN_PATTERNS) {
    out = out.replace(re, '[redacted-token]');
  }
  return out;
}

// ── Adapter ──────────────────────────────────────────────────────────────

export class GitHubStorageAdapter extends SharedBrainStorageAdapter {
  /**
   * @param {object} config
   * @param {string} config.owner   GitHub owner (user or org).
   * @param {string} config.repo    Repository name.
   * @param {string} config.pat     Fine-grained PAT with Contents R/W on this repo only.
   * @param {string} [config.branch="main"]
   * @param {Function} [config.fetchImpl=globalThis.fetch]  Injectable for offline tests.
   * @param {number} [config.maxRetries=1]  Max SHA-conflict retries after first attempt.
   * @param {Function} [config.onWarn]  Optional (message) => void — operational
   *   warnings (rate-limit pressure) for the caller's progress stream. stderr
   *   logging still happens regardless; this is the user-visible channel
   *   (v3.0.4, M18 — rate-limit warnings used to go to stderr only).
   */
  constructor(config) {
    super();
    if (!config || typeof config !== 'object') {
      throw new Error('GitHubStorageAdapter: config object is required');
    }
    if (typeof config.owner !== 'string' || !/^[a-z0-9][a-z0-9-]{0,38}$/i.test(config.owner)) {
      throw new Error('GitHubStorageAdapter: owner is required and must be a valid GitHub login');
    }
    if (typeof config.repo !== 'string' || !/^[a-zA-Z0-9._-]{1,100}$/.test(config.repo)) {
      throw new Error('GitHubStorageAdapter: repo is required and must be a valid GitHub repository name');
    }
    if (typeof config.pat !== 'string' || config.pat.length < 20) {
      throw new Error('GitHubStorageAdapter: pat is required (fine-grained PAT, Contents R/W)');
    }
    const branch = config.branch || 'main';
    if (!isSafeBranch(branch)) {
      throw new Error('GitHubStorageAdapter: branch must be a valid ref name');
    }

    this.owner = config.owner;
    this.repo = config.repo;
    this._pat = config.pat; // underscore-prefixed; never exposed by any public method
    this.branch = branch;
    this._fetch = config.fetchImpl || globalThis.fetch;
    if (typeof this._fetch !== 'function') {
      throw new Error('GitHubStorageAdapter: no fetch implementation available (Node 18+ required)');
    }
    // v3.0.6 (found by the 5.4 live concurrency test): default raised 1 → 3.
    // Two writers CREATING the same new file race like this: the loser's
    // PUT-without-sha gets 422 "sha wasn't supplied", and the immediate
    // refetch can MISS the winner's just-committed blob (GitHub's contents
    // API is only eventually consistent for a second or two) — with a
    // single retry the loser threw. Three attempts with a small backoff
    // (see _writeWithRetry) absorb the real-world consistency window.
    this._maxRetries = typeof config.maxRetries === 'number' ? config.maxRetries : 3;
    this._onWarn = typeof config.onWarn === 'function' ? config.onWarn : null;
  }

  // ── Internal repo-path builders ──────────────────────────────────────────

  _wikiRepoPath(domain, relPath) {
    if (!isSafeId(domain)) return null;
    const safe = safeRelPath(relPath);
    if (!safe) return null;
    return `collective/${domain}/wiki/${safe}`;
  }

  _contribRepoPath(fellowId, submissionId) {
    if (!isSafeId(fellowId) || !isSafeId(submissionId)) return null;
    return `contributions/${fellowId}/${submissionId}.json`;
  }

  _digestRepoPath(fellowId) {
    if (!isSafeId(fellowId)) return null;
    return `digests/${fellowId}/latest.json`;
  }

  _metaRepoPath(key) {
    return metaKeyToRepoPath(key);
  }

  // ── Low-level HTTP ───────────────────────────────────────────────────────

  /**
   * Build standard headers. Never log this object — it contains the PAT.
   */
  _headers(extra) {
    return {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${this._pat}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': USER_AGENT,
      ...(extra || {}),
    };
  }

  /**
   * Inspect rate-limit headers; emit a stderr warning if low.
   * Throws if the limit has been blown.
   */
  _checkRateLimit(response, repoPath) {
    const remaining = response.headers.get('x-ratelimit-remaining');
    if (remaining === null) return;
    const n = Number(remaining);
    if (Number.isFinite(n)) {
      if (n === 0 && (response.status === 403 || response.status === 429)) {
        const reset = response.headers.get('x-ratelimit-reset') || 'unknown';
        throw new GitHubAdapterError(
          'SHARED_BRAIN_RATE_LIMIT',
          `GitHub rate limit exhausted while accessing ${repoPath}. Resets at unix-ts ${reset}.`,
          response.status,
        );
      }
      if (n < 50) {
        console.error(
          `[sharedbrain-github] rate limit low: ${n} requests remaining ` +
          `(${this.owner}/${this.repo})`,
        );
        // v3.0.4 (M18): also surface to the caller's progress stream so the
        // user sees the pressure in the UI, not just the server log. At most
        // once per adapter instance — one push/pull/synthesis makes many
        // HTTP calls and a warning per call would drown the real progress.
        if (this._onWarn && !this._warnedRateLimit) {
          this._warnedRateLimit = true;
          const reset = response.headers.get('x-ratelimit-reset');
          const resetText = reset && Number.isFinite(Number(reset))
            ? ` It resets at ${new Date(Number(reset) * 1000).toLocaleTimeString()}.`
            : '';
          try {
            this._onWarn(
              `GitHub rate limit is running low (${n} requests remaining this hour).` +
              `${resetText} Large operations may fail until it resets.`
            );
          } catch { /* a warn callback must never break the operation */ }
        }
      }
    }
  }

  /**
   * Throw a typed error from a non-2xx response. The body is parsed for
   * GitHub's `message` field if present, but the full body is NEVER
   * concatenated into the error (would risk echoing back tokens or other
   * secrets if GitHub happens to return them — which they shouldn't, but
   * defence in depth).
   */
  async _throwForStatus(response, repoPath, op) {
    let detail = '';
    try {
      const body = await response.json();
      if (body && typeof body.message === 'string') {
        // Sanitise BEFORE slicing — a token at byte 195 would otherwise
        // survive truncation as a partial leak.
        detail = sanitizeDetail(body.message).slice(0, 200);
      }
    } catch { /* non-JSON body */ }

    const code = response.status === 409 ? 'SHARED_BRAIN_SHA_CONFLICT'
               : response.status === 422 ? 'SHARED_BRAIN_VALIDATION'
               : response.status === 404 ? 'SHARED_BRAIN_NOT_FOUND'
               : response.status === 401 ? 'SHARED_BRAIN_AUTH'
               : response.status === 403 ? 'SHARED_BRAIN_FORBIDDEN'
               : 'SHARED_BRAIN_HTTP_ERROR';

    throw new GitHubAdapterError(
      code,
      `GitHub ${op} ${repoPath} → ${response.status}${detail ? `: ${detail}` : ''}`,
      response.status,
    );
  }

  /**
   * GET /repos/:owner/:repo/contents/:path
   * Returns { content: string, sha: string } or null on 404.
   */
  async _apiGetContents(repoPath) {
    const url = `${GITHUB_API}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/contents/${encodePath(repoPath)}?ref=${encodeURIComponent(this.branch)}`;
    const response = await this._fetch(url, { method: 'GET', headers: this._headers() });
    this._checkRateLimit(response, repoPath);

    if (response.status === 404) {
      // Drain the body so the connection can be reused.
      try { await response.text(); } catch { /* ignore */ }
      return null;
    }
    if (!response.ok) {
      await this._throwForStatus(response, repoPath, 'GET');
    }

    const body = await response.json();
    // Contents API can return an array for directories — we never read those.
    if (Array.isArray(body)) {
      throw new GitHubAdapterError(
        'SHARED_BRAIN_NOT_A_FILE',
        `GET ${repoPath} returned a directory listing`,
      );
    }
    // Files >1MB come back with content: null + content_url; treat as not-supported in v1.
    if (body.content === null || body.content === undefined) {
      throw new GitHubAdapterError(
        'SHARED_BRAIN_FILE_TOO_LARGE',
        `${repoPath} is too large for the Contents API (>1MB). Shared Brain v1 caps page size at 1MB.`,
      );
    }

    // GitHub returns base64 with embedded newlines per RFC 2045.
    const cleaned = String(body.content).replace(/\n/g, '');
    return {
      content: decodeContent(cleaned),
      sha: String(body.sha),
    };
  }

  /**
   * PUT /repos/:owner/:repo/contents/:path
   * If `sha` is provided, this is an update (will 409 on conflict).
   * If `sha` is null/undefined, this is a create (will 422 if the file
   * already exists — which we treat as a conflict-class error).
   */
  async _apiPutContents(repoPath, content, message, sha) {
    const url = `${GITHUB_API}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/contents/${encodePath(repoPath)}`;
    const payload = {
      message: message || `Shared Brain: write ${repoPath}`,
      content: encodeContent(content),
      branch: this.branch,
    };
    if (sha) payload.sha = sha;

    const response = await this._fetch(url, {
      method: 'PUT',
      headers: this._headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });
    this._checkRateLimit(response, repoPath);

    if (response.ok) {
      try { await response.json(); } catch { /* ignore */ }
      return;
    }
    await this._throwForStatus(response, repoPath, 'PUT');
  }

  /**
   * Retry-loop wrapper that handles 409 (sha mismatch) and 422 (sha required
   * because file already exists when we didn't pass one) by refetching the
   * latest sha and retrying exactly once.
   */
  async _writeWithRetry(repoPath, content, message) {
    let attempt = 0;
    let sha = null;

    // First read to get the current SHA. null if file doesn't exist yet.
    const existing = await this._apiGetContents(repoPath).catch(err => {
      if (err && err.code === 'SHARED_BRAIN_FILE_TOO_LARGE') {
        // We can't read the existing file, so we can't supply a sha.
        // Caller's write will likely 422 — let it. (This is a v3.0
        // documented limitation: a >1MB file blocks re-writes via this path.)
        return null;
      }
      throw err;
    });
    sha = existing ? existing.sha : null;

    // Skip-write optimisation: if the content is byte-identical, do nothing.
    // GitHub would create an empty-diff commit which clutters history.
    if (existing && existing.content === content) {
      return { unchanged: true };
    }

    while (true) {
      try {
        await this._apiPutContents(repoPath, content, message, sha);
        return { unchanged: false };
      } catch (err) {
        const isConflict = err instanceof GitHubAdapterError
          && (err.code === 'SHARED_BRAIN_SHA_CONFLICT' || err.code === 'SHARED_BRAIN_VALIDATION');
        if (!isConflict || attempt >= this._maxRetries) {
          throw err;
        }
        attempt++;
        // v3.0.6: brief growing backoff BEFORE the refetch. The refetch
        // after a create-race 422 raced GitHub's read-after-write lag and
        // returned 404 — so the retry repeated the exact same sha-less PUT.
        // A few hundred ms lets the winner's commit become visible.
        await new Promise(r => setTimeout(r, 250 * attempt));
        // Refetch the latest SHA and retry. If the file disappeared between
        // the conflict and now (unlikely but possible), sha goes back to null.
        const refreshed = await this._apiGetContents(repoPath).catch(() => null);
        sha = refreshed ? refreshed.sha : null;
        // If the content is now identical to remote, treat as success.
        if (refreshed && refreshed.content === content) {
          return { unchanged: true };
        }
      }
    }
  }

  /**
   * DELETE /repos/:owner/:repo/contents/:path
   * Requires the file's blob sha to confirm the delete target. Returns
   * void on success; throws GitHubAdapterError on any non-2xx (including
   * 404, in case caller assumed the file exists but it doesn't).
   *
   * Used internally by:
   *   - the live battle test for cleanup
   *   - the v3.0 admin revoke endpoint (Phase 4, Decision 6b)
   *
   * NOT part of the SharedBrainStorageAdapter interface in this phase —
   * Phase 4 will lift it to the formal interface when revoke wires up.
   */
  async _apiDelete(repoPath, message, sha) {
    if (typeof sha !== 'string' || !sha) {
      throw new GitHubAdapterError(
        'SHARED_BRAIN_DELETE_REQUIRES_SHA',
        `_apiDelete: sha is required for ${repoPath}`,
      );
    }
    const url = `${GITHUB_API}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/contents/${encodePath(repoPath)}`;
    const payload = {
      message: message || `Shared Brain: delete ${repoPath}`,
      sha,
      branch: this.branch,
    };
    const response = await this._fetch(url, {
      method: 'DELETE',
      headers: this._headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });
    this._checkRateLimit(response, repoPath);
    if (response.ok) {
      try { await response.json(); } catch { /* ignore */ }
      return;
    }
    await this._throwForStatus(response, repoPath, 'DELETE');
  }

  /**
   * GET /repos/:owner/:repo/git/trees/:branch?recursive=1
   * Returns the list of file blob paths (and their SHAs) for the entire repo.
   * GitHub truncates above ~100,000 entries; we surface that to the caller.
   */
  async _apiTree() {
    const url = `${GITHUB_API}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/trees/${encodeURIComponent(this.branch)}?recursive=1`;
    const response = await this._fetch(url, { method: 'GET', headers: this._headers() });
    this._checkRateLimit(response, `tree:${this.branch}`);

    if (response.status === 404) {
      // Branch doesn't exist yet — treat as empty tree.
      try { await response.text(); } catch { /* ignore */ }
      return { entries: [], truncated: false };
    }
    if (!response.ok) {
      await this._throwForStatus(response, `tree:${this.branch}`, 'GET');
    }

    const body = await response.json();
    const tree = Array.isArray(body.tree) ? body.tree : [];
    const entries = tree
      .filter(e => e && e.type === 'blob' && typeof e.path === 'string')
      .map(e => ({ path: e.path, sha: e.sha }));
    return { entries, truncated: !!body.truncated };
  }

  /**
   * v3.0.3 (H9): GitHub truncates recursive tree listings at ~100k entries /
   * 7 MB. A truncated tree means listings would SILENTLY miss files —
   * synthesis would skip contributions, pull would skip pages, and worst,
   * revoke would report a successful Article 17 erasure while missing
   * submissions. Refuse loudly instead.
   */
  _refuseTruncatedTree(op, truncated) {
    if (!truncated) return;
    throw new GitHubAdapterError(
      'SHARED_BRAIN_TREE_TRUNCATED',
      `${op}: GitHub returned a TRUNCATED tree listing for this repo — it has grown past ` +
      `GitHub's recursive-listing limit, so any operation relying on a full listing would ` +
      `silently miss files. Aborting to avoid data loss / incomplete erasure. ` +
      `Archive or remove old contribution files to shrink the tree, then retry.`,
    );
  }

  // ── Public interface — page operations ───────────────────────────────────

  async readPage(domain, relPath) {
    const repoPath = this._wikiRepoPath(domain, relPath);
    if (!repoPath) return null;
    const result = await this._apiGetContents(repoPath);
    return result ? result.content : null;
  }

  async writePage(domain, relPath, content) {
    const repoPath = this._wikiRepoPath(domain, relPath);
    if (!repoPath) {
      throw new GitHubAdapterError(
        'SHARED_BRAIN_UNSAFE_PATH',
        `writePage: unsafe domain or path (${domain}, ${relPath})`,
      );
    }
    if (typeof content !== 'string') {
      throw new Error('writePage: content must be a string');
    }
    await this._writeWithRetry(repoPath, content, `Shared Brain: write ${repoPath}`);
  }

  async listPages(domain, prefix = '') {
    if (!isSafeId(domain)) return [];
    if (typeof prefix !== 'string') prefix = '';
    const safePrefix = prefix ? safeRelPath(prefix) : '';
    if (prefix && !safePrefix) return [];

    const wikiRoot = `collective/${domain}/wiki/`;
    const queryPrefix = safePrefix ? `${wikiRoot}${safePrefix}/` : wikiRoot;

    const { entries, truncated } = await this._apiTree();
    this._refuseTruncatedTree('listPages', truncated);
    const out = [];
    for (const e of entries) {
      if (!e.path.startsWith(queryPrefix)) continue;
      // Return paths relative to wiki/.
      out.push(e.path.slice(wikiRoot.length));
    }
    return out;
  }

  // ── Public interface — meta operations ───────────────────────────────────

  async readMeta(key) {
    const repoPath = this._metaRepoPath(key);
    if (!repoPath) return null;
    const result = await this._apiGetContents(repoPath);
    if (!result) return null;
    try { return JSON.parse(result.content); }
    catch { return null; }
  }

  async writeMeta(key, value) {
    const repoPath = this._metaRepoPath(key);
    if (!repoPath) {
      throw new GitHubAdapterError(
        'SHARED_BRAIN_UNSAFE_PATH',
        `writeMeta: unsafe key "${key}"`,
      );
    }
    const content = JSON.stringify(value, null, 2) + '\n';
    await this._writeWithRetry(repoPath, content, `Shared Brain: write ${repoPath}`);
  }

  // ── Public interface — contribution operations ───────────────────────────

  async storeContribution(fellowId, submissionId, payload) {
    const repoPath = this._contribRepoPath(fellowId, submissionId);
    if (!repoPath) {
      throw new GitHubAdapterError(
        'SHARED_BRAIN_UNSAFE_PATH',
        `storeContribution: unsafe ids (${fellowId}, ${submissionId})`,
      );
    }
    const content = JSON.stringify(payload, null, 2) + '\n';
    await this._writeWithRetry(repoPath, content, `Shared Brain: contribution ${fellowId}/${submissionId}`);
  }

  async contributionExists(fellowId, submissionId) {
    const repoPath = this._contribRepoPath(fellowId, submissionId);
    if (!repoPath) return false;
    const result = await this._apiGetContents(repoPath).catch(err => {
      // Treat NOT_FOUND as false; rethrow anything else.
      if (err instanceof GitHubAdapterError && err.code === 'SHARED_BRAIN_NOT_FOUND') return null;
      throw err;
    });
    return !!result;
  }

  async listContributionsSince(sinceIso) {
    const sinceMs = sinceIso ? new Date(sinceIso).getTime() : 0;
    if (Number.isNaN(sinceMs)) {
      throw new Error(`listContributionsSince: invalid sinceIso "${sinceIso}"`);
    }

    const { entries, truncated } = await this._apiTree();
    this._refuseTruncatedTree('listContributionsSince', truncated);
    const candidates = entries.filter(e => /^contributions\/[^/]+\/[^/]+\.json$/.test(e.path));

    // Fetch contents in bounded parallel batches.
    const out = [];
    const BATCH = 8;
    for (let i = 0; i < candidates.length; i += BATCH) {
      const slice = candidates.slice(i, i + BATCH);
      const results = await Promise.all(slice.map(async e => {
        const parts = e.path.split('/');
        const fellowId = parts[1];
        const submissionId = parts[2].replace(/\.json$/, '');
        if (!isSafeId(fellowId) || !isSafeId(submissionId)) return null;
        try {
          const data = await this._apiGetContents(e.path);
          if (!data) return null;
          let payload;
          try { payload = JSON.parse(data.content); }
          catch { return null; }
          // v3.0.3 (M8): a missing or unparseable contributed_at must NOT
          // silently drop the contribution — include it and let synthesis
          // decide (its processed-ID tracking prevents endless reprocessing;
          // garbage stamps never advance the watermark).
          const contributedAt = payload && payload.contributed_at
            ? new Date(payload.contributed_at).getTime()
            : NaN;
          if (Number.isNaN(contributedAt) || contributedAt >= sinceMs) {
            return { fellowId, submissionId, payload };
          }
        } catch (err) {
          // Surface rate-limit and auth failures; swallow per-file 404s
          // (contribution might have been deleted mid-list — rare).
          if (err instanceof GitHubAdapterError && err.code !== 'SHARED_BRAIN_NOT_FOUND') {
            throw err;
          }
        }
        return null;
      }));
      for (const r of results) {
        if (r) out.push(r);
      }
    }

    out.sort((a, b) => {
      const ta = a.payload.contributed_at ? new Date(a.payload.contributed_at).getTime() : 0;
      const tb = b.payload.contributed_at ? new Date(b.payload.contributed_at).getTime() : 0;
      if (ta !== tb) return ta - tb;
      return a.submissionId.localeCompare(b.submissionId);
    });
    return out;
  }

  // ── Public interface — digest operations ─────────────────────────────────

  async storeDigest(fellowId, digest) {
    const repoPath = this._digestRepoPath(fellowId);
    if (!repoPath) {
      throw new GitHubAdapterError(
        'SHARED_BRAIN_UNSAFE_PATH',
        `storeDigest: unsafe fellowId "${fellowId}"`,
      );
    }
    const content = JSON.stringify(digest, null, 2) + '\n';
    await this._writeWithRetry(repoPath, content, `Shared Brain: digest ${fellowId}`);
  }

  async loadDigest(fellowId) {
    const repoPath = this._digestRepoPath(fellowId);
    if (!repoPath) return null;
    const result = await this._apiGetContents(repoPath);
    if (!result) return null;
    try { return JSON.parse(result.content); }
    catch { return null; }
  }

  // ── Phase 4F: revoke support (Decision 6b) ─────────────────────────────────
  //
  // Each delete first GETs the file to learn its SHA (required by the
  // Contents DELETE API). 404 on GET → return false (idempotent). Any other
  // error propagates so the orchestration layer sees real problems.

  async _deleteIfExists(repoPath, message) {
    const existing = await this._apiGetContents(repoPath).catch(err => {
      if (err && err.code === 'SHARED_BRAIN_NOT_FOUND') return null;
      throw err;
    });
    if (!existing) return false;
    await this._apiDelete(repoPath, message, existing.sha);
    return true;
  }

  async deletePage(domain, relPath) {
    const repoPath = this._wikiRepoPath(domain, relPath);
    if (!repoPath) {
      throw new GitHubAdapterError(
        'SHARED_BRAIN_UNSAFE_PATH',
        `deletePage: unsafe domain or path (${domain}, ${relPath})`,
      );
    }
    return this._deleteIfExists(repoPath, `Shared Brain: revoke — delete ${repoPath}`);
  }

  async deleteContribution(fellowId, submissionId) {
    const repoPath = this._contribRepoPath(fellowId, submissionId);
    if (!repoPath) {
      throw new GitHubAdapterError(
        'SHARED_BRAIN_UNSAFE_PATH',
        `deleteContribution: unsafe ids (${fellowId}, ${submissionId})`,
      );
    }
    return this._deleteIfExists(repoPath, `Shared Brain: revoke — delete contribution ${fellowId}/${submissionId}`);
  }

  async deleteDigest(fellowId) {
    const repoPath = this._digestRepoPath(fellowId);
    if (!repoPath) {
      throw new GitHubAdapterError(
        'SHARED_BRAIN_UNSAFE_PATH',
        `deleteDigest: unsafe fellowId "${fellowId}"`,
      );
    }
    return this._deleteIfExists(repoPath, `Shared Brain: revoke — delete digest ${fellowId}`);
  }

  async listFellowSubmissions(fellowId) {
    if (!isSafeId(fellowId)) return [];
    const { entries, truncated } = await this._apiTree();
    // Refusing here makes REVOKE abort on truncation — an incomplete
    // Article 17 erasure reported as success is the worst possible outcome.
    this._refuseTruncatedTree('listFellowSubmissions', truncated);
    const prefix = `contributions/${fellowId}/`;
    return entries
      .filter(e => e.path.startsWith(prefix) && e.path.endsWith('.json'))
      .map(e => e.path.slice(prefix.length, -5))
      .filter(isSafeId);
  }

  async appendAudit(relPath, record) {
    if (typeof relPath !== 'string' || !relPath) {
      throw new Error('appendAudit: relPath is required');
    }
    if (!relPath.startsWith('state/') || !relPath.endsWith('.jsonl')) {
      throw new Error(`appendAudit: relPath must be under state/ and end with .jsonl (got "${relPath}")`);
    }
    const safe = safeRelPath(relPath);
    if (!safe) {
      throw new GitHubAdapterError('SHARED_BRAIN_UNSAFE_PATH', `appendAudit: unsafe path "${relPath}"`);
    }

    // Read existing content (404 → empty), append the new JSONL line, write back.
    // SHA-based concurrency via _writeWithRetry handles concurrent admin actions.
    const line = JSON.stringify(record) + '\n';
    const existing = await this._apiGetContents(safe).catch(err => {
      if (err && err.code === 'SHARED_BRAIN_NOT_FOUND') return null;
      throw err;
    });
    const newContent = (existing ? existing.content : '') + line;
    await this._writeWithRetry(safe, newContent, `Shared Brain: audit log entry`);
  }
}

// ── Path encoding for the GitHub Contents API ────────────────────────────
//
// The Contents API takes the path as part of the URL. We encode each segment
// so that `#`, `?`, `%`, and spaces don't break the URL, but keep `/` as the
// segment separator. GitHub's documented rule is "URI-encode each segment".

function encodePath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

// Exposed for tests only.
export const __testing = {
  isSafeId,
  isSafeBranch,
  safeRelPath,
  metaKeyToRepoPath,
  encodeContent,
  decodeContent,
  encodePath,
  sanitizeDetail,
  GitHubAdapterError,
  USER_AGENT,
};
