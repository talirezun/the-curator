// This file is licensed under the Curator Enterprise License — NOT MIT.
// Free for personal, educational, evaluation, development and testing use,
// and for production use of the GitHub-backed Shared Brain (free forever).
// Other organizational production use will require a license key once keys
// exist — until then it is free too (grace clause). Each release's version of
// this file converts to MIT two years after that release was published.
// See LICENSES/LICENSE-ENTERPRISE.txt and LICENSES/ENTERPRISE-FILES.txt.
/**
 * Shared Brain — Storage Adapter Interface
 *
 * Every concrete adapter (LocalFolder, GitHub, Cloudflare R2) implements
 * exactly these methods with identical semantics. The brain layer
 * (sharedbrain.js, push/pull/synthesis) only ever talks to this interface,
 * never to a concrete adapter, so swapping storage backends is a config
 * change — no code change.
 *
 * Concept model (mirrors spec Part 1):
 *   - domain       : short slug, e.g. "work-ai"
 *   - path         : relative to wiki root, e.g. "entities/foo.md"
 *   - key          : dot-separated metadata key, e.g. "state.last-synthesis"
 *   - fellowId     : a contributor's UUID
 *   - submissionId : one push event's UUID — payload is one batch of DeltaSummaries
 *
 * Storage layout (identical across all adapters):
 *   collective/<domain>/wiki/<path>          — the collective wiki pages
 *   contributions/<fellowId>/<submissionId>.json  — raw contribution payloads
 *   digests/<fellowId>/latest.json           — per-fellow synthesis input cache
 *   meta/<key-as-path>.json                  — coordination/state metadata
 *
 * All methods are async. Adapter implementations may cache, but must NOT
 * leak credentials in error messages, log lines, or thrown objects.
 */

export class SharedBrainStorageAdapter {
  /** Read a collective wiki page. Returns string content or null if not found. */
  async readPage(_domain, _path) { throw new Error('SharedBrainStorageAdapter.readPage: not implemented'); }

  /** Write a collective wiki page. Creates parent dirs as needed. Idempotent on identical content. */
  async writePage(_domain, _path, _content) { throw new Error('SharedBrainStorageAdapter.writePage: not implemented'); }

  /** List all wiki-page paths under collective/<domain>/wiki/<prefix>. Returns array of paths relative to wiki/. */
  async listPages(_domain, _prefix = '') { throw new Error('SharedBrainStorageAdapter.listPages: not implemented'); }

  /** Read a metadata object. Returns parsed JSON value or null if not found. */
  async readMeta(_key) { throw new Error('SharedBrainStorageAdapter.readMeta: not implemented'); }

  /** Write a metadata object. Value is serialised to JSON. */
  async writeMeta(_key, _value) { throw new Error('SharedBrainStorageAdapter.writeMeta: not implemented'); }

  /** Store a contribution payload. Idempotent — same (fellowId, submissionId) is a safe re-call. */
  async storeContribution(_fellowId, _submissionId, _payload) { throw new Error('SharedBrainStorageAdapter.storeContribution: not implemented'); }

  /** Returns true if a contribution with the given id exists. Used for idempotency checks. */
  async contributionExists(_fellowId, _submissionId) { throw new Error('SharedBrainStorageAdapter.contributionExists: not implemented'); }

  /**
   * List all contributions submitted at or after sinceIso (ISO-8601 timestamp).
   * Pass null to list all contributions. Returns array of
   * { fellowId, submissionId, payload } objects.
   */
  async listContributionsSince(_sinceIso) { throw new Error('SharedBrainStorageAdapter.listContributionsSince: not implemented'); }

  /** Store the latest digest for a fellow. Overwrites any prior digest for that fellow. */
  async storeDigest(_fellowId, _digest) { throw new Error('SharedBrainStorageAdapter.storeDigest: not implemented'); }

  /** Load the latest digest for a fellow. Returns parsed JSON or null if not found. */
  async loadDigest(_fellowId) { throw new Error('SharedBrainStorageAdapter.loadDigest: not implemented'); }

  // ── Phase 4F additions — revoke support (Decision 6b) ──────────────────────
  //
  // These methods exist so the revoke endpoint can implement GDPR Article 17
  // ("right to erasure") without leaking adapter-specific implementation
  // details into the orchestration layer. All four are idempotent: deleting
  // something that doesn't exist must not throw.

  /** Delete a single wiki page. Returns true if a file was removed, false if not found. */
  async deletePage(_domain, _path) { throw new Error('SharedBrainStorageAdapter.deletePage: not implemented'); }

  /** Delete a single contribution payload. Returns true if removed, false if not found. */
  async deleteContribution(_fellowId, _submissionId) { throw new Error('SharedBrainStorageAdapter.deleteContribution: not implemented'); }

  /** Delete a fellow's digest. Returns true if removed, false if not found. */
  async deleteDigest(_fellowId) { throw new Error('SharedBrainStorageAdapter.deleteDigest: not implemented'); }

  /** List all submission ids for a fellow. Returns array of strings. */
  async listFellowSubmissions(_fellowId) { throw new Error('SharedBrainStorageAdapter.listFellowSubmissions: not implemented'); }

  /** Append one JSONL audit record. Creates the file if absent. Used by revoke. */
  async appendAudit(_relPath, _record) { throw new Error('SharedBrainStorageAdapter.appendAudit: not implemented'); }
}
