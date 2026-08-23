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
