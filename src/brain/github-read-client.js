/**
 * A READ-ONLY GitHub client — the HTTP plumbing two features share.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
 * v3.63.0 mirrors a project's tier-0 foundations from a GitHub repository
 * when the checkout is not on this machine (see the remote arm in
 * `src/brain/working-state.js`). Every byte of plumbing that needs is
 * already in `sharedbrain-github-adapter.js`, and it has been hardened by
 * production incidents a second client would repeat: the token that never
 * reaches a log or an error string, the truncated recursive tree that must
 * refuse loudly rather than silently miss files, the rate-limit headers read
 * before anything else, the per-segment path encoding. So the plumbing moved
 * here and BOTH callers use it.
 *
 * ── WHERE THE SEAM IS, AND WHY IT IS NOT WHERE THE DESIGN SAID ───────────
 * The design record (§F.2) said to lift `_apiGetContents` and `_apiTree`
 * themselves. The code refused that: both are welded to the adapter's
 * `this.branch` AND to its `SHARED_BRAIN_*` error vocabulary, whose codes are
 * matched on by `_writeWithRetry`, by synthesis and by revoke. Lifting them
 * whole would either change those codes — the one thing the extraction is
 * forbidden to do, since `scripts/test-sharedbrain-github-offline.js` must
 * stay green with zero edits — or drag "SHARED_BRAIN_NOT_FOUND" onto a
 * missing `architecture.md`, which is a sentence nobody can act on. So the
 * shared layer is what is genuinely common (headers, token redaction, path
 * encoding, the rate-limit reading, base64 decoding, the API host, the
 * version string) and each caller keeps its own vocabulary on top. The
 * adapter DELEGATES rather than duplicating: there is one implementation of
 * each, not two.
 *
 * ── LICENSING, STATED RATHER THAN ASSUMED ────────────────────────────────
 * The code below was extracted from `sharedbrain-github-adapter.js`, which is
 * ENTERPRISE-licensed (`LICENSES/ENTERPRISE-FILES.txt`). This file is NOT on
 * that list, so by that document's own rule it is MIT — which is deliberate
 * and is the reason the seam is drawn where it is: nothing here is Shared
 * Brain logic. It is generic GitHub REST plumbing, and the memory layer
 * (MIT) now depends on it. Moving it onto the enterprise list instead would
 * make `working-state.js` — the core of the app — depend on an
 * enterprise-licensed module, which is a much larger change than a refactor
 * is allowed to make. If the maintainer wants the opposite call, it is one
 * line in that file plus an import audit.
 *
 * ── WHAT THIS CLIENT WILL NOT DO ─────────────────────────────────────────
 * GET, and only GET. There is no `PUT`, no `DELETE`, no `POST`, and no way to
 * reach one: every request this module issues names `method: 'GET'`
 * literally. A mirror refresh that could write to the source repository is a
 * path-construction defect waiting to happen, and the cheapest defence is an
 * object that has no such verb in it.
 *
 * The token is used as a header value and nothing else. It is never placed in
 * a URL or a query string, never logged, never serialised, and never included
 * in a thrown error — errors name the token's SOURCE (`.curator-config.json`
 * or Personal Sync's `.sync-config.json`) so a person can fix the right one,
 * which is the actionable half and carries none of the risk.
 */

import { readFileSync, existsSync } from 'fs';
import { appPath, getCuratorConfigFile, getSyncConfigFile } from './paths.js';

export const GITHUB_API = 'https://api.github.com';

/** Total attempts per request, including the first. The adapter's `_maxRetries`
 *  default of 3 is the shape this borrows — it is NOT the same constant,
 *  because that one counts SHA-conflict retries on a write and this one counts
 *  transient-failure retries on a read. Stated so nobody "unifies" them. */
export const READ_ATTEMPTS = 3;
/** Backoff before attempt N, in ms: `READ_BACKOFF_MS * attempt`. The adapter's
 *  `250 * attempt` (v3.0.6), for the same reason: a few hundred ms is what a
 *  transient upstream blip costs, and a fixed zero is what makes a retry a
 *  second failure. */
export const READ_BACKOFF_MS = 250;

/** The token sources a caller may name. `config` is the recommended one — a
 *  second, fine-grained, read-only token scoped to the source repository. */
export const GITHUB_TOKEN_SOURCES = Object.freeze(['config', 'sync']);
/** The `.curator-config.json` key holding the separate read-only token. */
export const GITHUB_READ_TOKEN_KEY = 'githubReadToken';

// ── The Curator's version, for the User-Agent ────────────────────────────
let _version = null;
/** `package.json`'s version, or "unknown". Read once. */
export function curatorVersion() {
  if (_version === null) {
    try {
      const pkg = JSON.parse(readFileSync(appPath('package.json'), 'utf8'));
      _version = pkg.version || 'unknown';
    } catch { _version = 'unknown'; }
  }
  return _version;
}

// ── Token redaction ──────────────────────────────────────────────────────
//
// Defence-in-depth sanitiser for response-body detail text that is
// concatenated into thrown error messages. GitHub's own error responses
// should never include a caller's PAT, but adversarial proxies or misbehaving
// plugins could. Strip the known GitHub credential shapes before any string
// leaves this module.
//
// Token prefixes documented at:
//   https://github.blog/2021-04-05-behind-githubs-new-authentication-token-formats/
export const TOKEN_PATTERNS = Object.freeze([
  /github_pat_[A-Za-z0-9_]+/g,  // fine-grained PAT
  /ghp_[A-Za-z0-9]{20,}/g,      // classic PAT
  /gho_[A-Za-z0-9]{20,}/g,      // OAuth access token
  /ghu_[A-Za-z0-9]{20,}/g,      // user-to-server token
  /ghs_[A-Za-z0-9]{20,}/g,      // server-to-server token
  /ghr_[A-Za-z0-9]{20,}/g,      // refresh token
]);

export function sanitizeDetail(s) {
  if (typeof s !== 'string') return '';
  let out = s;
  for (const re of TOKEN_PATTERNS) out = out.replace(re, '[redacted-token]');
  return out;
}

// ── Path encoding for the GitHub Contents API ────────────────────────────
//
// The Contents API takes the path as part of the URL. Encode each segment so
// that `#`, `?`, `%`, and spaces don't break the URL, but keep `/` as the
// segment separator. GitHub's documented rule is "URI-encode each segment".
export function encodePath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

/** GitHub returns base64 with embedded newlines per RFC 2045. */
export function decodeBase64Content(b64) {
  return Buffer.from(String(b64).replace(/\n/g, ''), 'base64');
}

/** Standard headers. NEVER log this object — it holds the token. */
export function githubReadHeaders({ token, userAgent, extra } = {}) {
  return {
    'Accept': 'application/vnd.github+json',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': userAgent || `the-curator/${curatorVersion()}`,
    ...(extra || {}),
  };
}

/**
 * Read the rate-limit headers. PURE — it decides nothing and throws nothing,
 * so each caller keeps its own message and its own threshold. `remaining` is
 * null when the header is absent (which is a different fact from zero).
 */
export function rateLimitReading(response) {
  const raw = response?.headers?.get ? response.headers.get('x-ratelimit-remaining') : null;
  const n = raw === null || raw === undefined ? null : Number(raw);
  const remaining = Number.isFinite(n) ? n : null;
  const resetRaw = response?.headers?.get ? response.headers.get('x-ratelimit-reset') : null;
  const status = typeof response?.status === 'number' ? response.status : 0;
  return {
    remaining,
    reset: resetRaw || null,
    // GitHub answers an exhausted PRIMARY limit with 403 (historically) or 429
    // and `x-ratelimit-remaining: 0`. That is NOT retryable — the reset can be
    // up to an hour away — which is why it is separated from an ordinary 429.
    exhausted: remaining === 0 && (status === 403 || status === 429),
  };
}

// ── The typed error ──────────────────────────────────────────────────────

export class GitHubReadError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'GitHubReadError';
    this.code = code;
    if (typeof status === 'number') this.status = status;
  }
}

export const READ_ERROR_CODES = Object.freeze({
  UNAUTHORISED: 'GITHUB_READ_UNAUTHORISED',
  NOT_FOUND: 'GITHUB_READ_NOT_FOUND',
  RATE_LIMIT: 'GITHUB_READ_RATE_LIMIT',
  TREE_TRUNCATED: 'GITHUB_READ_TREE_TRUNCATED',
  TOO_LARGE: 'GITHUB_READ_TOO_LARGE',
  MALFORMED: 'GITHUB_READ_MALFORMED',
  HTTP: 'GITHUB_READ_HTTP',
  NETWORK: 'GITHUB_READ_NETWORK',
});

// ── Owner / repo / ref validation ────────────────────────────────────────

const OWNER_RE = /^[a-z0-9][a-z0-9-]{0,38}$/i;
const REPO_RE = /^[a-zA-Z0-9._-]{1,100}$/;
/** A ref name, deliberately narrower than git's grammar: it goes in a URL. */
const REF_RE = /^[a-z0-9][a-z0-9._/-]{0,127}$/i;
const SHA_RE = /^[0-9a-f]{40}$/;

export function isValidOwner(s) { return typeof s === 'string' && OWNER_RE.test(s); }
export function isValidRepo(s) { return typeof s === 'string' && REPO_RE.test(s); }
export function isValidRef(s) { return typeof s === 'string' && REF_RE.test(s) && !s.includes('..'); }
export function isCommitSha(s) { return typeof s === 'string' && SHA_RE.test(s); }

/**
 * Parse a git remote URL into `{owner, repo}`, or null.
 *
 * Accepts the two forms `git remote get-url origin` actually prints — SSH
 * (`git@github.com:owner/repo.git`, `ssh://git@github.com/owner/repo`) and
 * HTTPS (`https://github.com/owner/repo.git`, with or without a userinfo
 * part) — plus a bare `owner/repo`, which is what a person types.
 *
 * A NON-GITHUB host answers null rather than throwing, and that is the
 * feature: a GitLab or self-hosted remote simply means this project has no
 * GitHub mirror arm, which is a fact about the project and not an error. A
 * `github.example.com` is not github.com and is refused for the same reason —
 * this client speaks to api.github.com and nothing else, so recording an
 * enterprise host would promise a fetch that cannot happen.
 */
export function parseGitHubRemote(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  if (!s) return null;
  let rest = null;
  const scp = /^(?:[A-Za-z0-9._-]+@)?github\.com:(.+)$/.exec(s);
  if (scp) {
    rest = scp[1];
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    let u;
    try { u = new URL(s); } catch { return null; }
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (host !== 'github.com') return null;
    rest = u.pathname;
  } else if (!s.includes(':') && !s.includes('//')) {
    rest = s;
  } else {
    return null;
  }
  const parts = String(rest).replace(/^\/+/, '').replace(/\.git$/i, '').replace(/\/+$/, '').split('/');
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  return isValidOwner(owner) && isValidRepo(repo) ? { owner, repo } : null;
}

// ── The token, from one of two files ─────────────────────────────────────

/**
 * Resolve the read token. Returns `{ok, token, source}` or a refusal naming
 * the source — NEVER the value, on either arm.
 *
 * ── THE ARGUMENT FOR TWO SOURCES, AND FOR THE DEFAULT (§F.3, Q4) ─────────
 * `.sync-config.json` holds the Personal Sync PAT, and `docs/sync.md` tells
 * the user to make it EITHER a fine-grained token scoped to one repository
 * with Contents R/W, OR a CLASSIC token with the `repo` scope — which can read
 * every repository they own. Reusing the classic one to mirror a DIFFERENT
 * repository works, and spends on a second purpose a permission granted for
 * the first. So it is never reached unless the caller names it
 * (`tokenSource: 'sync'`), and the default is a separate token the user
 * creates fine-grained and READ-ONLY (Contents: Read on the source repo),
 * stored under `githubReadToken` in `.curator-config.json` — a file this repo
 * already writes at 0600 and already sweeps in `getCredentialFiles()`, so the
 * new key needs no new file and no new hardening.
 *
 * A fine-grained SYNC token, by contrast, simply cannot read another repo: it
 * answers 404/403, which is why the refusal below names the scope rather than
 * only the status.
 */
export function readGitHubReadToken(source = 'config') {
  const want = GITHUB_TOKEN_SOURCES.includes(source) ? source : 'config';
  const file = want === 'sync' ? getSyncConfigFile() : getCuratorConfigFile();
  const label = want === 'sync' ? 'Personal Sync (.sync-config.json)' : `.curator-config.json (${GITHUB_READ_TOKEN_KEY})`;
  if (!existsSync(file)) {
    return { ok: false, source: want, reason: 'no-token', message: `No GitHub read token in ${label} — that file is not on this computer.` };
  }
  let raw;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); }
  catch { return { ok: false, source: want, reason: 'unreadable', message: `${label} could not be read as JSON, so no token was taken from it.` }; }
  const value = want === 'sync' ? raw?.token : raw?.[GITHUB_READ_TOKEN_KEY];
  const token = typeof value === 'string' ? value.trim() : '';
  if (token.length < 20) {
    return {
      ok: false, source: want, reason: 'no-token',
      message: want === 'sync'
        ? 'Personal Sync is not connected, so it holds no GitHub token to read with.'
        : `No GitHub read token is saved. Add a fine-grained, read-only (Contents: Read) token for the source `
          + `repository as "${GITHUB_READ_TOKEN_KEY}" in .curator-config.json.`,
    };
  }
  return { ok: true, token, source: want };
}

// ── The client ───────────────────────────────────────────────────────────

/**
 * @param {object} cfg
 * @param {string} cfg.token         the PAT; header value only
 * @param {string} [cfg.tokenSource] named in errors, never the value
 * @param {Function} [cfg.fetchImpl] injectable — every test drives a fake one
 * @param {Function} [cfg.sleepImpl] injectable — a suite records the schedule
 * @param {Function} [cfg.onWarn]    user-visible channel for rate-limit pressure
 * @param {number} [cfg.attempts]
 */
export function createGitHubReadClient(cfg = {}) {
  const token = typeof cfg.token === 'string' ? cfg.token : '';
  const tokenSource = GITHUB_TOKEN_SOURCES.includes(cfg.tokenSource) ? cfg.tokenSource : 'config';
  const fetchImpl = typeof cfg.fetchImpl === 'function' ? cfg.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('createGitHubReadClient: no fetch implementation available (Node 18+ required)');
  }
  const sleepImpl = typeof cfg.sleepImpl === 'function'
    ? cfg.sleepImpl
    : (ms) => new Promise((r) => setTimeout(r, ms));
  const onWarn = typeof cfg.onWarn === 'function' ? cfg.onWarn : null;
  const attempts = Number.isInteger(cfg.attempts) && cfg.attempts > 0 ? cfg.attempts : READ_ATTEMPTS;
  const userAgent = `the-curator-foundations/${curatorVersion()}`;
  let requests = 0;
  let warnedRateLimit = false;

  function coords(owner, repo) {
    if (!isValidOwner(owner) || !isValidRepo(repo)) {
      throw new GitHubReadError(READ_ERROR_CODES.MALFORMED,
        `"${String(owner).slice(0, 40)}/${String(repo).slice(0, 60)}" is not a GitHub owner/repository pair.`);
    }
    return `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }

  async function detailOf(response) {
    try {
      const body = await response.json();
      if (body && typeof body.message === 'string') {
        // Sanitise BEFORE slicing — a token at byte 195 would otherwise
        // survive truncation as a partial leak.
        return sanitizeDetail(body.message).slice(0, 200);
      }
    } catch { /* non-JSON body */ }
    return '';
  }

  /** The single request chokepoint. GET only; retries 5xx and a NON-exhausted
   *  429; never retries a 4xx, and never retries an exhausted rate limit. */
  async function get(url, what, { allow404 = false } = {}) {
    let attempt = 0;
    for (;;) {
      attempt++;
      requests++;
      let response;
      try {
        response = await fetchImpl(url, { method: 'GET', headers: githubReadHeaders({ token, userAgent }) });
      } catch (err) {
        // A transport failure. Retryable like a 5xx — the cause text is
        // sanitised on the way out because a proxy could echo anything.
        if (attempt < attempts) { await sleepImpl(READ_BACKOFF_MS * attempt); continue; }
        throw new GitHubReadError(READ_ERROR_CODES.NETWORK,
          `GitHub could not be reached while reading ${what} (${sanitizeDetail(String(err?.message ?? err)).slice(0, 120)}).`);
      }
      const rl = rateLimitReading(response);
      if (rl.exhausted) {
        try { await response.text(); } catch { /* drain */ }
        throw new GitHubReadError(READ_ERROR_CODES.RATE_LIMIT,
          `GitHub's rate limit is exhausted (reading ${what}). It resets at unix-ts ${rl.reset || 'unknown'} — nothing was copied.`,
          response.status);
      }
      if (rl.remaining !== null && rl.remaining < 50 && onWarn && !warnedRateLimit) {
        warnedRateLimit = true;
        try {
          onWarn(`GitHub's rate limit is running low (${rl.remaining} requests left this hour). A large mirror may not finish.`);
        } catch { /* a warn callback must never break the operation */ }
      }
      if (response.status === 404 && allow404) {
        try { await response.text(); } catch { /* drain */ }
        return null;
      }
      if (response.ok) {
        try { return await response.json(); } catch (err) {
          throw new GitHubReadError(READ_ERROR_CODES.MALFORMED,
            `GitHub's answer for ${what} was not JSON (${sanitizeDetail(String(err?.message ?? err)).slice(0, 80)}).`,
            response.status);
        }
      }
      const retryable = response.status >= 500 || response.status === 429;
      if (retryable && attempt < attempts) {
        // Drain and drop the body so an error page cannot hold a socket.
        try { await response.text(); } catch { /* ignore */ }
        await sleepImpl(READ_BACKOFF_MS * attempt);
        continue;
      }
      const detail = await detailOf(response);
      if (response.status === 401 || response.status === 403) {
        throw new GitHubReadError(READ_ERROR_CODES.UNAUTHORISED,
          `GitHub refused the token from ${tokenSource === 'sync' ? 'Personal Sync' : '.curator-config.json'} `
          + `with ${response.status} while reading ${what}. A fine-grained token can only read the repository it was `
          + `scoped to; a classic token needs the "repo" scope.${detail ? ` GitHub said: ${detail}` : ''}`,
          response.status);
      }
      if (response.status === 404) {
        throw new GitHubReadError(READ_ERROR_CODES.NOT_FOUND,
          `GitHub answered 404 for ${what}. Either it is not there, or the token from `
          + `${tokenSource === 'sync' ? 'Personal Sync' : '.curator-config.json'} cannot see this repository — a `
          + `fine-grained token scoped to another repository answers 404 rather than 403.`,
          404);
      }
      throw new GitHubReadError(READ_ERROR_CODES.HTTP,
        `GitHub answered ${response.status} while reading ${what}${detail ? `: ${detail}` : ''}`
        + (retryable ? ` (after ${attempt} attempts)` : ''),
        response.status);
    }
  }

  return {
    /** `{ defaultBranch }`. One call, and only when no ref was named. */
    async getRepo(owner, repo) {
      const body = await get(coords(owner, repo), `${owner}/${repo}`);
      const defaultBranch = body && typeof body.default_branch === 'string' ? body.default_branch : null;
      if (!isValidRef(defaultBranch || '')) {
        throw new GitHubReadError(READ_ERROR_CODES.MALFORMED,
          `${owner}/${repo} reported a default branch this client will not put in a URL.`);
      }
      return { defaultBranch };
    },

    /**
     * Resolve a ref to a COMMIT SHA. `ref` may be a branch, a tag or a sha;
     * null means "the repository's default branch", which costs one extra
     * call and is resolved rather than assumed — `main` is a guess and a
     * wrong guess here mirrors the wrong bytes silently.
     */
    async getRef(owner, repo, ref) {
      let use = ref;
      if (use === null || use === undefined || use === '') {
        ({ defaultBranch: use } = await this.getRepo(owner, repo));
      }
      if (!isValidRef(use)) {
        throw new GitHubReadError(READ_ERROR_CODES.MALFORMED, `"${String(ref).slice(0, 60)}" is not a usable ref name.`);
      }
      const body = await get(`${coords(owner, repo)}/commits/${encodePath(use)}`, `${owner}/${repo}@${use}`);
      const sha = body && typeof body.sha === 'string' ? body.sha.toLowerCase() : null;
      if (!isCommitSha(sha)) {
        throw new GitHubReadError(READ_ERROR_CODES.MALFORMED, `GitHub did not return a commit sha for ${owner}/${repo}@${use}.`);
      }
      return { sha, ref: use };
    },

    /**
     * The whole tree at a commit. THROWS on a truncated listing.
     *
     * v3.0.3 (H9) recorded why, for Shared Brain, and it is the same defect
     * here with a different cost: GitHub truncates recursive listings at
     * ~100k entries / 7 MB, and a truncated one would make a document that IS
     * in the repository look absent — which this mirror reports as `missing`
     * while KEEPING the stale copy and reporting success. A loud refusal is
     * the only honest answer.
     */
    async getTree(owner, repo, sha, { recursive = true } = {}) {
      if (!isCommitSha(sha) && !isValidRef(sha)) {
        throw new GitHubReadError(READ_ERROR_CODES.MALFORMED, `"${String(sha).slice(0, 60)}" is not a tree-ish this client will fetch.`);
      }
      const url = `${coords(owner, repo)}/git/trees/${encodePath(sha)}${recursive ? '?recursive=1' : ''}`;
      const body = await get(url, `the file list of ${owner}/${repo}@${String(sha).slice(0, 7)}`);
      if (body && body.truncated === true) {
        throw new GitHubReadError(READ_ERROR_CODES.TREE_TRUNCATED,
          `GitHub returned a TRUNCATED file listing for ${owner}/${repo} — the repository has grown past GitHub's `
          + 'recursive-listing limit, so a file that IS there could be read as missing and a stale copy kept while '
          + 'this reported success. Nothing was copied.');
      }
      const tree = Array.isArray(body?.tree) ? body.tree : [];
      const entries = tree
        .filter((e) => e && e.type === 'blob' && typeof e.path === 'string')
        .map((e) => ({
          path: e.path,
          sha: typeof e.sha === 'string' ? e.sha : null,
          size: Number.isInteger(e.size) ? e.size : null,
        }));
      return { entries, truncated: false };
    },

    /** One blob by its git sha, as BYTES. `bytes` is the decoded length. */
    async getBlob(owner, repo, sha) {
      if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) {
        throw new GitHubReadError(READ_ERROR_CODES.MALFORMED, `"${String(sha).slice(0, 60)}" is not a blob sha.`);
      }
      const body = await get(`${coords(owner, repo)}/git/blobs/${sha}`, `a file of ${owner}/${repo}`);
      if (!body || body.content === null || body.content === undefined) {
        throw new GitHubReadError(READ_ERROR_CODES.TOO_LARGE,
          `GitHub would not return the contents of one file of ${owner}/${repo} inline (it is over the blob API's limit).`);
      }
      if (body.encoding !== 'base64') {
        throw new GitHubReadError(READ_ERROR_CODES.MALFORMED,
          `GitHub returned a file of ${owner}/${repo} in an encoding this client does not read (${String(body.encoding).slice(0, 20)}).`);
      }
      const buf = decodeBase64Content(body.content);
      return { buf, bytes: buf.length };
    },

    /** One path at one ref, as BYTES — or null when it is not there. */
    async getContent(owner, repo, filePath, ref) {
      if (typeof filePath !== 'string' || !filePath || filePath.includes('\0')) {
        throw new GitHubReadError(READ_ERROR_CODES.MALFORMED, 'that is not a file path this client will fetch.');
      }
      const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
      const body = await get(`${coords(owner, repo)}/contents/${encodePath(filePath)}${q}`,
        `${filePath.slice(0, 120)} in ${owner}/${repo}`, { allow404: true });
      if (body === null) return null;
      if (Array.isArray(body)) {
        throw new GitHubReadError(READ_ERROR_CODES.MALFORMED, `${filePath.slice(0, 120)} is a directory, not a file.`);
      }
      if (body.content === null || body.content === undefined) {
        throw new GitHubReadError(READ_ERROR_CODES.TOO_LARGE,
          `${filePath.slice(0, 120)} is too large for GitHub's contents API (over 1 MB).`);
      }
      const buf = decodeBase64Content(body.content);
      return { buf, bytes: buf.length, sha: typeof body.sha === 'string' ? body.sha : null };
    },

    /** How many HTTP requests this client has made. For disclosure, not control. */
    stats() { return { requests }; },
  };
}
