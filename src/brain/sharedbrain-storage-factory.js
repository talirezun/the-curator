// This file is licensed under the Curator Enterprise License — NOT MIT.
// Free for personal, educational, evaluation, development and testing use,
// and for production use of the GitHub-backed Shared Brain (free forever).
// Other organizational production use will require a license key once keys
// exist — until then it is free too (grace clause). Each release's version of
// this file converts to MIT two years after that release was published.
// See LICENSES/LICENSE-ENTERPRISE.txt and LICENSES/ENTERPRISE-FILES.txt.
/**
 * Shared Brain — Storage Adapter Factory
 *
 * Builds the right adapter for a given connection's storage_type.
 *
 * Currently supported:
 *   - "local"   → LocalFolderStorageAdapter   (Phase 2A — battle-testing on disk)
 *   - "github"  → GitHubStorageAdapter        (Phase 3 — REST API, fine-grained PAT)
 *
 * Coming next:
 *   - "cloudflare-r2" → CloudflareR2Adapter (Phase 3.1)
 *
 * The brain layer (push/pull/synthesis) only ever calls
 * `createStorageAdapter(connection)` — it does not know or care which
 * concrete class it gets back. Swapping storage backends is a config
 * change, not a code change.
 */

import { LocalFolderStorageAdapter } from './sharedbrain-local-adapter.js';
import { GitHubStorageAdapter } from './sharedbrain-github-adapter.js';
import { GITHUB_API } from './github-read-client.js';

// ── TEST SEAM: a fake GitHub on this computer (v3.99.2, Replace token) ──────
//
// `CURATOR_TEST_GITHUB_API` names a fake GitHub API that the offline suites
// run on 127.0.0.1, so Replace token and the push/pull after it can be proved
// over real HTTP without the network. Production never sets it, and it is
// honoured ONLY for a plain-http loopback origin: anything else (a typo, a
// real host, https, a path) is ignored and api.github.com is used, so this
// variable can never send a Shared Brain token to another computer.
// Returns null when unset or not loopback, which is the production answer.
export function testGithubApiBase() {
  const v = process.env.CURATOR_TEST_GITHUB_API;
  if (!v) return null;
  let u;
  try { u = new URL(v); } catch { return null; }
  if (u.protocol !== 'http:') return null;
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return null;
  if (u.pathname !== '/' || u.search || u.hash || u.username || u.password) return null;
  return u.origin;
}

/**
 * The fetch every Shared Brain GitHub call uses: `globalThis.fetch` itself in
 * production (no seam set), or one that rewrites the api.github.com origin to
 * the test fake. Resolved per call, so a suite can set the variable after
 * import.
 */
export function sharedBrainGithubFetch() {
  const base = testGithubApiBase();
  if (!base) return globalThis.fetch;
  return (url, init) => {
    const s = typeof url === 'string' ? url : String(url);
    return globalThis.fetch(s.startsWith(GITHUB_API + '/') ? base + s.slice(GITHUB_API.length) : s, init);
  };
}

/**
 * @param {object} connection
 * @param {object} [opts]
 * @param {Function} [opts.onWarn]  Optional (message) => void — operational
 *   warnings from the adapter (e.g. GitHub rate-limit pressure) surfaced to
 *   the caller's progress stream (v3.0.4, M18). Ignored by adapters that
 *   have no such warnings (local).
 */
export function createStorageAdapter(connection, opts = {}) {
  if (!connection || typeof connection !== 'object') {
    throw new Error('createStorageAdapter: connection object is required');
  }

  switch (connection.storage_type) {
    case 'local':
      return new LocalFolderStorageAdapter({
        storage_root: connection.local_storage_path,
      });

    case 'github':
      return new GitHubStorageAdapter({
        owner: connection.github_repo_owner,
        repo: connection.github_repo_name,
        pat: connection.github_pat,
        branch: connection.github_branch || 'main',
        onWarn: opts.onWarn,
        // Undefined in production (the adapter then uses globalThis.fetch,
        // exactly as before); the loopback test fake only under the seam.
        fetchImpl: testGithubApiBase() ? sharedBrainGithubFetch() : undefined,
      });

    case 'cloudflare-r2':
      throw new Error(
        'SharedBrain storage_type "cloudflare-r2": CloudflareR2Adapter is not yet implemented (Phase 3.1).'
      );

    default:
      throw new Error(
        `SharedBrain unknown storage_type: "${connection.storage_type}". ` +
        `Supported in this version: "local", "github". Coming soon: "cloudflare-r2".`
      );
  }
}
