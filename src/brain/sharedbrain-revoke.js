// This file is licensed under the Curator Enterprise License — NOT MIT.
// Free for personal, educational, evaluation, development and testing use,
// and for production use of the GitHub-backed Shared Brain (free forever).
// Other organizational production use will require a license key once keys
// exist — until then it is free too (grace clause). Each release's version of
// this file converts to MIT two years after that release was published.
// See LICENSES/LICENSE-ENTERPRISE.txt and LICENSES/ENTERPRISE-FILES.txt.
/**
 * Shared Brain — Revocation orchestration (Phase 4F, Decision 6b)
 *
 * Implements GDPR Article 17 (right to erasure) for Shared Brain contributors.
 * Triggered by the admin via POST /api/sharedbrain/:id/revoke.
 *
 * Algorithm (matches the procedure documented in docs/shared-brain-compliance.md §2b):
 *
 *   1. Enumerate the revoked fellow's contributions in storage and delete each.
 *   2. Delete the fellow's digest (the per-fellow synthesis input cache).
 *   3. Scan every collective page; any page whose Provenance section contains
 *      the revoked fellow's short ID is deleted from collective storage.
 *      (Brute-force approach: the page WILL be re-created by step 4 if other
 *      contributors still have facts for it; if not, it stays deleted —
 *      this honors Article 17 for pages where the revoked fellow was the
 *      sole contributor.)
 *   4. Reset state.last-synthesis to epoch so the next synthesis re-processes
 *      ALL remaining contributions from scratch.
 *   5. Run runLocalSynthesis using the existing pipeline. Pages get rebuilt
 *      from remaining contributors' submissions only — revoked facts are
 *      naturally absent because their submissions are gone.
 *   6. Append a record to state/revocations.jsonl. Audit contains only the
 *      UUID + timestamp + counts — no real names, no content.
 *
 * The operation is IRREVERSIBLE. Once revoked, the contributor's submissions
 * cannot be reconstructed from shared storage.
 *
 * Design notes:
 *   - The orchestration uses the storage adapter interface only. It works
 *     against LocalFolderStorageAdapter and GitHubStorageAdapter identically.
 *   - Step 3 uses the fellow's short ID (first 8 hex of UUID minus hyphens)
 *     because that's what Provenance sections store. We tolerate both
 *     bare-uuid and "Name (short-id)" formats — see extractProvenanceContributors.
 *   - We do NOT delete git history. That's noted in the compliance doc §2d
 *     as a separate admin procedure for absolute-erasure scenarios.
 */

import { createHash, randomUUID } from 'crypto';
import { createStorageAdapter } from './sharedbrain-storage-factory.js';
import { runLocalSynthesis } from './sharedbrain-synthesis.js';
import { extractProvenanceContributors } from './sharedbrain-synthesis.js';

const REVOCATIONS_LOG_PATH = 'state/revocations.jsonl';
const SHORT_ID_LEN = 8;

/**
 * Derive the short id that Provenance sections use for a given fellow UUID.
 * Matches defaultShortenId in sharedbrain-synthesis.js.
 */
function shortenFellowId(fellowId) {
  if (typeof fellowId !== 'string') return '';
  return fellowId.replace(/-/g, '').slice(0, SHORT_ID_LEN);
}

/**
 * @param {object} connection — full connection record (with tokens, internal use)
 * @param {object} opts
 * @param {string} opts.fellowId      — UUID of the contributor to revoke
 * @param {string} opts.adminTokenHash — sha256 of the admin token for the audit
 *                                       trail; never the raw token
 * @param {Function} [opts.onProgress] — (stage, message, meta?) => void
 * @returns {Promise<{ok, contributions_deleted, pages_deleted, pages_rebuilt, audit_record}>}
 */
export async function revokeContributor(connection, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const fellowId = opts.fellowId;
  if (typeof fellowId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fellowId)) {
    return { ok: false, error: 'revokeContributor: fellowId must be a UUID' };
  }
  if (!connection || !connection.shared_domain) {
    return { ok: false, error: 'revokeContributor: connection.shared_domain is required' };
  }

  let adapter;
  try {
    adapter = createStorageAdapter(connection);
  } catch (err) {
    return { ok: false, error: `revokeContributor: adapter init failed: ${err.message}` };
  }

  const shortId = shortenFellowId(fellowId);
  if (shortId.length !== SHORT_ID_LEN) {
    return { ok: false, error: `revokeContributor: could not derive short id from fellowId` };
  }

  // ── Step 0 (v3.0.3): write an in-progress marker to shared storage ───────
  // If the revoke is interrupted (process killed, network drop) after the
  // deletions but before the rebuild, the marker survives: synthesis refuses
  // to run while it's active (it could otherwise re-create pages from data
  // mid-erasure), and the admin gets a clear "re-run the revocation" steer.
  // Re-running the revoke is safe — every step below is idempotent.
  try {
    await adapter.writeMeta('state.revocation-in-progress', {
      active: true,
      fellow_short_id: shortId, // short id only — no PII beyond what Provenance already shows
      started_at: new Date().toISOString(),
    });
  } catch (err) {
    return { ok: false, error: `revokeContributor: could not write the in-progress marker: ${err.message}` };
  }

  // ── Step 1: delete contributions ─────────────────────────────────────────

  onProgress('info', `Listing contributions for ${shortId}…`);
  let submissionIds = [];
  try {
    submissionIds = await adapter.listFellowSubmissions(fellowId);
  } catch (err) {
    return { ok: false, error: `revokeContributor: listFellowSubmissions failed: ${err.message}` };
  }
  onProgress('info', `Found ${submissionIds.length} contribution${submissionIds.length !== 1 ? 's' : ''} to delete.`);

  let contributionsDeleted = 0;
  for (const subId of submissionIds) {
    try {
      const removed = await adapter.deleteContribution(fellowId, subId);
      if (removed) contributionsDeleted++;
      onProgress('progress', `Deleted contribution ${subId.slice(0, 8)}…`);
    } catch (err) {
      console.error(`[sharedbrain-revoke] failed to delete contribution ${subId}: ${err.message}`);
    }
  }

  // ── Step 2: delete digest ────────────────────────────────────────────────

  onProgress('info', 'Deleting digest cache…');
  try {
    await adapter.deleteDigest(fellowId);
  } catch (err) {
    console.error(`[sharedbrain-revoke] failed to delete digest: ${err.message}`);
  }

  // ── Step 3: delete pages where revoked fellow appears in Provenance ──────

  onProgress('info', 'Scanning collective pages for revoked-contributor provenance…');
  let pagesDeleted = 0;
  const pagePaths = await adapter.listPages(connection.shared_domain).catch(() => []);
  for (const pagePath of pagePaths) {
    try {
      const content = await adapter.readPage(connection.shared_domain, pagePath);
      if (!content) continue;
      const contributors = extractProvenanceContributors(content);
      // Tolerate both bare short-ids and "Name (short-id)" formats — the
      // helper already extracts the canonical id; we compare prefixes too
      // since Provenance lines historically have stored short-IDs.
      // v3.0.3: EXACT matching only. The previous `norm.includes(shortId)`
      // was collision-prone — 8 hex chars appearing anywhere inside another
      // fellow's UUID or a display name would delete an innocent page.
      // extractProvenanceContributors already unwraps "Name (short-id)" to
      // the parenthesised id, so the remaining legitimate shapes are the
      // bare short id and the full UUID.
      const shortIdLc = shortId.toLowerCase();
      const hit = contributors.some(c => {
        if (!c) return false;
        const norm = String(c).trim().toLowerCase();
        return norm === shortIdLc
            || (shortenFellowId(norm) === shortIdLc && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(norm));
      });
      if (hit) {
        const removed = await adapter.deletePage(connection.shared_domain, pagePath);
        if (removed) {
          pagesDeleted++;
          onProgress('progress', `Deleted page ${pagePath}`);
        }
      }
    } catch (err) {
      console.error(`[sharedbrain-revoke] failed to scan/delete ${pagePath}: ${err.message}`);
    }
  }

  // ── Step 4: reset synthesis state, then run synthesis from scratch ───────

  onProgress('info', 'Resetting last-synthesis state and rebuilding from remaining contributions…');
  // v3.0.6: the reset carries the FULL v3.0.3 state shape — `watermark: null`
  // ("nothing processed — list everything") and empty `processed_ids`. The
  // old `{at: epoch}` shape relied on the legacy fallback and left readers
  // free to dedup against a stale processed_ids list.
  const resetState = {
    at: new Date(0).toISOString(),
    watermark: null,
    processed_ids: [],
    run_number: 0,
  };
  try {
    await adapter.writeMeta('state.last-synthesis', resetState);
  } catch (err) {
    console.error(`[sharedbrain-revoke] could not reset last-synthesis: ${err.message}`);
  }

  let synthesisResult = null;
  try {
    synthesisResult = await runLocalSynthesis(connection, {
      onProgress: (stage, message, meta) => onProgress('progress', `synthesis: ${message}`, meta),
      llmFn: opts.llmFn,
      patchFn: opts.patchFn,
      allowDuringRevocation: true, // our own marker is active — see Step 0
      // v3.0.6 (5.1 live finding): hand the rebuild its baseline DIRECTLY.
      // Re-reading state.last-synthesis right after writing it raced
      // GitHub's eventual consistency — the rebuild saw the stale
      // pre-reset processed_ids, "rebuilt" nothing, and the revoke
      // reported success over missing pages.
      stateOverride: resetState,
    });
  } catch (err) {
    console.error(`[sharedbrain-revoke] re-synthesis failed: ${err.message}`);
    synthesisResult = { ok: false, error: err.message };
  }
  const rebuildOk = !!(synthesisResult && synthesisResult.ok);
  const pagesRebuilt = rebuildOk ? (synthesisResult.pages_written || 0) : 0;

  // ── Step 5: append audit log entry ───────────────────────────────────────

  const auditRecord = {
    revoked_at: new Date().toISOString(),
    fellow_id: fellowId,
    by_admin_token_hash: opts.adminTokenHash || null,
    contributions_deleted: contributionsDeleted,
    pages_deleted: pagesDeleted,
    pages_rebuilt: pagesRebuilt,
    rebuild_ok: rebuildOk, // v3.0.3 — false = erasure done, rebuild pending
    revocation_id: randomUUID(),
  };
  try {
    await adapter.appendAudit(REVOCATIONS_LOG_PATH, auditRecord);
  } catch (err) {
    console.error(`[sharedbrain-revoke] could not write audit log: ${err.message}`);
  }

  // ── Step 6 (v3.0.3): clear the in-progress marker ONLY on full success ───
  // On rebuild failure the marker stays active: synthesis keeps refusing and
  // the admin is steered to re-run the revoke (which is idempotent and will
  // finish the rebuild).
  if (rebuildOk) {
    try {
      await adapter.writeMeta('state.revocation-in-progress', {
        active: false,
        finished_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error(`[sharedbrain-revoke] could not clear the in-progress marker: ${err.message}`);
    }
  }

  if (!rebuildOk) {
    // v3.0.3: pre-fix this returned ok:true — the admin saw "Revocation
    // complete" while the collective sat gutted (pages deleted, rebuild
    // never ran). Now the failure is loud and carries the recovery path.
    const errMsg =
      `Erasure completed (${contributionsDeleted} contributions + ${pagesDeleted} pages deleted), ` +
      `but the rebuild synthesis FAILED: ${synthesisResult && synthesisResult.error ? synthesisResult.error : 'unknown error'}. ` +
      `The collective is missing the deleted pages until the rebuild runs. ` +
      `Re-run this revocation (safe — every step is idempotent) once the underlying problem is resolved.`;
    onProgress('error', errMsg);
    return {
      ok: false,
      partial: true,
      error: errMsg,
      contributions_deleted: contributionsDeleted,
      pages_deleted: pagesDeleted,
      pages_rebuilt: 0,
      audit_record: auditRecord,
    };
  }

  onProgress('done', `Revocation complete: ${contributionsDeleted} contributions deleted, ${pagesDeleted} pages removed, ${pagesRebuilt} rebuilt.`);

  return {
    ok: true,
    contributions_deleted: contributionsDeleted,
    pages_deleted: pagesDeleted,
    pages_rebuilt: pagesRebuilt,
    audit_record: auditRecord,
  };
}

/**
 * Hash an admin token for the audit trail. We log only the hash so
 * even reading the audit log doesn't reveal who triggered the revoke
 * (only which admin instance — admins should use distinct tokens).
 */
export function hashAdminToken(token) {
  if (typeof token !== 'string' || !token) return null;
  return 'sha256:' + createHash('sha256').update(token).digest('hex');
}

export const __testing = {
  shortenFellowId,
  REVOCATIONS_LOG_PATH,
};
