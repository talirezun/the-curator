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

import { createHash, randomUUID, randomBytes, timingSafeEqual } from 'crypto';
import { createStorageAdapter } from './sharedbrain-storage-factory.js';
// v3.6.2: IMPORTED, never re-implemented. `scrubPaths` is the absolute-path
// scrubber added in v3.3.0 for the ingest queue's HTTP surface. Its bare-pass
// bridge width is MEASURED against a fixture table (see its docblock) and
// pinned in both directions by test-ingest-queue.js — a second hand-written
// copy here would be the v3.2.0 CRITICAL shape (two hand-maintained copies of
// one guard) inside a file whose own docblock cites that lesson. The marginal
// import cost is ~2 ms: this module already pulls the same transitive graph
// through sharedbrain-synthesis.js.
import { scrubPaths } from './ingest-queue.js';
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

/** Max length of a per-failure error string in the API result. */
const MAX_FAILURE_DETAIL_CHARS = 240;

/**
 * Build a scrubber for error strings that are about to become USER-VISIBLE
 * and (as counts) PERSISTED.
 *
 * Before v3.6.2 these strings only ever reached `console.error`, so putting
 * them in the API response is a genuinely new exposure surface and needs a
 * guard of its own.
 *
 * The guard is deliberately VALUE-BASED (redact the exact secrets this
 * connection holds) rather than a second copy of the GitHub token-prefix
 * regex list that already lives in sharedbrain-github-adapter.js
 * (`sanitizeDetail`). Two hand-maintained copies of one guard is what
 * produced the v3.2.0 CRITICAL; a value-based check has nothing to drift
 * and is strictly stronger for the tokens actually in scope here — the
 * only credentials that can appear in our own adapters' errors are the
 * ones on this connection. Adapter-side prefix scrubbing still runs first
 * and is unchanged.
 *
 * ── Three passes, in this order, and the order is load-bearing ────────────
 *
 *   1. SECRETS — exact value match against the original text. First,
 *      because it is the only pass that must see the string as the provider
 *      wrote it: a later pass that rewrote a substring could split a token
 *      across a replacement boundary and defeat an exact match.
 *   2. PATHS   — `scrubPaths` (imported, v3.3.0). Raw `fs` errors embed
 *      absolute paths, and on the erasure path they reach the admin-visible
 *      summary: a real LocalFolderStorageAdapter failure produced
 *      "…could NOT be deleted (…: EACCES: permission denied, unlink
 *      '/var/folders/…/shared-storage/contributions/…')". On a real install
 *      the leading directories are the user's home and their cloud-storage
 *      layout. The basename is the useful half and carries no location.
 *   3. CAP     — last, so the cap applies to the FINAL string. Capping
 *      before the other passes would let a rewrite push the result back
 *      over MAX_FAILURE_DETAIL_CHARS.
 *
 * ── ENFORCED ─────────────────────────────────────────────────────────────
 *
 * Every error string this function returns is secret-scrubbed, path-scrubbed
 * and length-capped. v3.6.2 CORRECTION: that sentence was previously written
 * as "every error string this function can hand back", which was an
 * OVERCLAIM about the CALLER, not about this function — `runLocalSynthesis`
 * RETURNS (rather than throws) at sharedbrain-synthesis.js's adapter-init and
 * listContributionsSince guards, and revokeContributor interpolated that
 * `error` field straight into `problems` → `summary` → the SSE frame,
 * bypassing this scrubber and its cap entirely. The claim is now true because
 * that path was ROUTED THROUGH here (see `synthesisError` at the rebuild
 * step), not because the sentence was softened. A docblock claiming coverage
 * it lacks is what stops the next reviewer looking.
 *
 * ── NOT ENFORCED (stated, not hidden) ────────────────────────────────────
 *
 *  - A third party's token echoed verbatim by a hostile proxy: out of scope
 *    here — that is the adapter's `sanitizeDetail` prefix layer.
 *  - Non-error text this module composes itself is NOT routed through here.
 *    The only such value is `connection.shared_domain`, interpolated into the
 *    listPages abort message. It is operator-supplied configuration, not
 *    provider output, and is slug-validated in sharedbrain-config.js.
 *  - `scrubPaths`'s own documented limits (an UNQUOTED path whose folder
 *    name runs past its measured space bridge; a path split across a
 *    newline). Node's `fs` errors always quote, which is the shape that
 *    actually occurs here.
 */
function makeScrubber(connection) {
  const secrets = [
    connection && connection.github_pat,
    connection && connection.admin_token,
    connection && connection.fellow_token,
  ].filter(s => typeof s === 'string' && s.length >= 8);

  // Accepts an Error OR a bare string: `runLocalSynthesis` reports its
  // failures by RETURNING `{ok:false, error:'…'}`, so the string form is a
  // real caller, not a defensive nicety.
  return function scrub(err) {
    let s = (err && err.message) ? String(err.message) : String(err || 'unknown error');
    for (const secret of secrets) {
      // split/join: no regex construction from an attacker-influenced value.
      s = s.split(secret).join('[redacted]');
    }
    s = scrubPaths(s);
    if (s.length > MAX_FAILURE_DETAIL_CHARS) s = s.slice(0, MAX_FAILURE_DETAIL_CHARS) + '…';
    return s;
  };
}

/**
 * What the in-progress marker is doing at the moment of an abort.
 *
 * NAMED rather than passed as a bare boolean, because the three states are
 * genuinely different and a boolean would force two of them to lie. This is
 * the field an admin acts on: `active` means cohort-wide synthesis is
 * REFUSED right now for every contributor, and only a re-run of the
 * revocation clears it.
 */
const MARKER_NEVER_WRITTEN = 'never-written'; // pre-Step-0 abort: no marker exists
const MARKER_WRITE_FAILED  = 'write-failed';  // the Step-0 write itself threw
const MARKER_ACTIVE        = 'active';        // Step 0 succeeded: synthesis is blocked

/**
 * Build the FULL documented result shape for an ABORT — a return that happens
 * before the ordinary verdict/summary block can run.
 *
 * v3.6.2 RE-AUDIT (finding 4): six of this function's nine return points were
 * bare `{ok, error}` while the admin doc states the SSE `error` payload
 * carries the whole result object. A client written against the doc read
 * `erasure_complete` as `undefined` — falsy, so it degraded safely, but the
 * contract was wrong.
 *
 * The values are decided PER PATH, not stamped uniformly, because two fields
 * mean different things depending on how far the run got:
 *
 *   erasure_complete — always `false` on an abort, and this is honest rather
 *     than merely safe. The field asserts COMPLETENESS, not effort: on a path
 *     where nothing was attempted, the contributor's data is definitely still
 *     in shared storage, which is exactly what `false` says. The
 *     "was anything attempted?" question is answered by `partial`, and the
 *     detail by `summary` — overloading this field with effort is how it
 *     would start lying.
 *
 *   marker_cleared — `null` (NOT APPLICABLE) when no marker was ever written,
 *     `false` only when one is genuinely sitting active. Stamping `false`
 *     everywhere would be the "blindly stamp the same object" mistake: a
 *     client rendering "marker_cleared:false ⇒ synthesis blocked" would raise
 *     a COHORT-WIDE alarm for a request that failed input validation and
 *     touched nothing. `null` is still falsy, so any existing truthiness
 *     check degrades identically.
 *
 *   marker_active — v3.6.2 ADDITION, and the actionable one: it answers
 *     "is cohort synthesis blocked right now?" directly instead of leaving it
 *     to be inferred from a field that cannot express it. `null` means
 *     genuinely unknown (the Step-0 write threw, so a partial commit cannot
 *     be ruled out) — the recovery is the same either way, and the summary
 *     says so.
 *
 * Counts and per-category failure lists are zero/empty on an abort because
 * that is the literal truth: no delete was attempted, so none failed.
 * `audit_record` is null because no audit line is written on an abort.
 */
function abortResult(error, markerState, overrides = {}) {
  let markerCleared, markerActive;
  switch (markerState) {
    case MARKER_NEVER_WRITTEN:
      markerCleared = null;  markerActive = false; break;
    case MARKER_WRITE_FAILED:
      markerCleared = null;  markerActive = null;  break;
    case MARKER_ACTIVE:
    default:
      // The default arm is deliberately grouped with the BLOCKING state.
      // v3.6.1 recorded a defect where a `default:` arm fell into the
      // cheerful branch; the direction matters more than the branch. Every
      // call site passes a state explicitly, so this is unreachable — and if
      // it ever became reachable, a false "check your marker" prompt costs an
      // admin one look, while a missed one is a silent cohort-wide outage.
      markerCleared = false; markerActive = true;  break;
  }
  return {
    ok: false,
    erasure_complete: false,
    partial: false, // no erasure mutation was attempted; overridden where one was
    error,
    summary: error, // one wording, so the two fields can never drift
    contributions_deleted: 0,
    contributions_failed: [],
    digest_failed: null,
    pages_deleted: 0,
    pages_failed: [],
    pages_rebuilt: 0,
    pages_rebuild_failed: 0,
    state_reset_failed: null,
    audit_failed: null,
    marker_cleared: markerCleared,
    marker_active: markerActive,
    audit_record: null,
    ...overrides,
  };
}

/**
 * @param {object} connection — full connection record (with tokens, internal use)
 * @param {object} opts
 * @param {string} opts.fellowId      — UUID of the contributor to revoke
 * @param {string} opts.adminTokenHash — sha256 of the admin token for the audit
 *                                       trail; never the raw token
 * @param {Function} [opts.onProgress] — (stage, message, meta?) => void
 * @returns {Promise<{
 *   ok: boolean,
 *   erasure_complete: boolean,
 *   partial: boolean,
 *   summary: string,
 *   error?: string,
 *   contributions_deleted: number,
 *   contributions_failed: Array<{submission_id: string, error: string}>,
 *   digest_failed: {error: string}|null,
 *   pages_deleted: number,
 *   pages_failed: Array<{path: string, error: string}>,
 *   pages_rebuilt: number,
 *   pages_rebuild_failed: number,
 *   state_reset_failed: {error: string}|null,
 *   audit_failed: {error: string}|null,
 *   marker_cleared: boolean|null,
 *   marker_active: boolean|null,
 *   audit_record: object|null
 * }>}
 *
 * EVERY return point returns that whole shape — all nine of them. v3.6.2
 * re-audit: six were bare `{ok, error}`, so a client written against the
 * documented contract read `erasure_complete` as `undefined`. See
 * `abortResult` for why `marker_cleared` is `null` (not `false`) where no
 * marker was ever written, and for the `marker_active` addition.
 *
 * v3.6.2 — SELF-REPORTING ERASURE. Every step that can fail per-item now
 * records the failure into the result AND the audit record instead of
 * `console.error`-ing it and letting the run report success. An admin uses
 * this result to certify an Article 17 erasure to a data subject; a
 * swallowed delete turned that certification into a false statement.
 *
 * Two failure classes, handled differently on purpose:
 *
 *   SCOPE failures  → ABORT. If we cannot enumerate WHAT to erase
 *                     (listFellowSubmissions, listPages) this is not a
 *                     partial erasure, it is an UNATTEMPTED one. Continuing
 *                     would run the rebuild and clear the in-progress
 *                     marker over a collective we never scanned.
 *   PER-ITEM failures → RECORD AND CONTINUE. The scope is known and the
 *                     remaining items can still be erased. Aborting at
 *                     item 3 of 40 would leave 37 files on disk that we
 *                     could have deleted — every one of them continuing
 *                     unlawful processing. Every step is idempotent, so a
 *                     re-run finishes the remainder; maximising first-pass
 *                     erasure strictly shrinks the residual set.
 *
 * The safety property of "abort" is preserved without aborting: when ANY
 * erasure failure is recorded the in-progress marker is NOT cleared, so
 * ordinary synthesis stays refused and the admin is forced to resolve it.
 */
export async function revokeContributor(connection, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const fellowId = opts.fellowId;
  // Input validation, before anything is touched: no marker exists, no
  // erasure was attempted, cohort synthesis is unaffected.
  if (typeof fellowId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fellowId)) {
    return abortResult('revokeContributor: fellowId must be a UUID', MARKER_NEVER_WRITTEN);
  }
  if (!connection || !connection.shared_domain) {
    return abortResult('revokeContributor: connection.shared_domain is required', MARKER_NEVER_WRITTEN);
  }

  // v3.6.2: built BEFORE the adapter, so EVERY error string this function
  // can hand back is scrubbed — including the three early aborts below
  // (adapter init, in-progress-marker write, listFellowSubmissions). Those
  // returned `err.message` raw into exactly the user-visible field the
  // scrubber's own docblock says needed a guard. They are the least likely
  // of the failure paths to carry a credential, but leaving them raw made
  // that docblock claim more than the code delivered, and applying the
  // existing scrubber to them costs nothing.
  const scrub = makeScrubber(connection);

  let adapter;
  try {
    // opts.adapter is a TEST-ONLY seam (same pattern and rationale as
    // compile.js's opts.generateText): it lets the suite drive genuinely
    // failing deletes and the GitHub-only truncated-tree refusal offline.
    // Production never passes it — routes/sharedbrain.js calls this with
    // fellowId / adminTokenHash / onProgress only.
    adapter = opts.adapter || createStorageAdapter(connection);
  } catch (err) {
    return abortResult(
      `revokeContributor: adapter init failed: ${scrub(err)}`, MARKER_NEVER_WRITTEN);
  }

  const shortId = shortenFellowId(fellowId);
  if (shortId.length !== SHORT_ID_LEN) {
    // Still pre-Step-0: the adapter exists but nothing has been written.
    return abortResult(
      `revokeContributor: could not derive short id from fellowId`, MARKER_NEVER_WRITTEN);
  }

  // Every per-item failure lands here. Nothing on the erasure path may be
  // handled with a bare console.error again — a stderr line is not a user
  // surface, and this result is what an admin certifies an erasure with.
  const failures = {
    contributions: [], // {submission_id, error}
    pages: [],         // {path, error}
    digest: null,      // {error}
    stateReset: null,  // {error}
    audit: null,       // {error}
    markerClear: null, // {error}
  };

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
    // The marker write itself threw. We cannot prove nothing landed — a
    // GitHub 502 can follow a commit — so the marker state is genuinely
    // UNKNOWN rather than absent, and the message says so instead of
    // guessing. The recovery is the same in both cases.
    return abortResult(
      `Erasure NOT STARTED: could not write the revocation-in-progress marker — ${scrub(err)}. ` +
      `Nothing was deleted. The marker guards the collective against being synthesised ` +
      `mid-erasure, so the revocation refuses to run without it. It is UNKNOWN whether a ` +
      `partial marker landed in shared storage; if cohort synthesis is now refusing, that is ` +
      `why. Resolve the storage failure, then re-run this revocation — every step is ` +
      `idempotent, and a successful run clears the marker.`,
      MARKER_WRITE_FAILED);
  }

  // ── Step 1: delete contributions ─────────────────────────────────────────

  onProgress('info', `Listing contributions for ${shortId}…`);
  // SCOPE failure → ABORT, and SAY WHAT THAT LEAVES BEHIND (v3.6.2 re-audit,
  // finding 3).
  //
  // This is the structural TWIN of the listPages abort ~60 lines below: both
  // are scope failures, both return AFTER the Step-0 marker write, and both
  // therefore leave cohort-wide synthesis refused. v3.6.2 gave that one a
  // thorough, admin-actionable message and left this one a bare two-clause
  // error — the release's own named failure shape (a fix closing the reported
  // case while its identical sibling stays broken) recurring inside its own
  // fix.
  //
  // What that cost, reproduced live: a transient GitHub 502 here returned
  // "listFellowSubmissions failed: GitHub 502 Bad Gateway". Nothing had been
  // erased, which is true and reassuring, so the admin walks away. But the
  // marker is active, so from that moment EVERY contributor's synthesis
  // returns ok:false ("A contributor revocation is in progress or was
  // interrupted") indefinitely. Nobody connects the two, and the recovery —
  // re-run the revocation — was never stated.
  //
  // `listFellowSubmissions` is also the primitive the GitHub adapter's
  // truncated-tree refusal protects: an unreadable submission list is not a
  // partial erasure, it is an UNATTEMPTED one.
  let submissionIds = [];
  try {
    submissionIds = await adapter.listFellowSubmissions(fellowId);
  } catch (err) {
    const detail = scrub(err);
    const errMsg =
      `Erasure ABORTED before anything was deleted: could not list this contributor's ` +
      `submissions — ${detail}. NOTHING has been erased, so their data is still in shared ` +
      `storage and this revocation must NOT be reported as complete. ` +
      `The revocation-in-progress marker IS set, which means ordinary synthesis is now ` +
      `refused for EVERY contributor in this brain until a revocation run finishes. ` +
      `Resolve the listing failure, then re-run this revocation — every step is idempotent, ` +
      `and a successful run both completes the erasure and clears the marker.`;
    console.error(`[sharedbrain-revoke] listFellowSubmissions failed: ${detail}`);
    onProgress('error', errMsg);
    return abortResult(errMsg, MARKER_ACTIVE, {
      // Mirrors the listPages abort's `pages_failed: [{path:'*'}]`: a synthetic
      // '*' entry means "the enumeration itself failed", so a client rendering
      // the per-category list shows the failure instead of an empty array that
      // reads as "nothing went wrong".
      contributions_failed: [{ submission_id: '*', error: detail }],
    });
  }
  onProgress('info', `Found ${submissionIds.length} contribution${submissionIds.length !== 1 ? 's' : ''} to delete.`);

  let contributionsDeleted = 0;
  for (const subId of submissionIds) {
    try {
      const removed = await adapter.deleteContribution(fellowId, subId);
      if (removed) contributionsDeleted++;
      onProgress('progress', `Deleted contribution ${subId.slice(0, 8)}…`);
    } catch (err) {
      const detail = scrub(err);
      console.error(`[sharedbrain-revoke] failed to delete contribution ${subId}: ${detail}`);
      failures.contributions.push({ submission_id: subId, error: detail });
      onProgress('warn', `Could NOT delete contribution ${subId.slice(0, 8)}… — ${detail}`);
    }
  }

  // ── Step 2: delete digest ────────────────────────────────────────────────
  //
  // The digest is the fellow's own synthesis-input cache — it holds THEIR
  // facts. A failure here leaves the data subject's content in shared
  // storage, so it is an erasure failure, not a housekeeping one.

  onProgress('info', 'Deleting digest cache…');
  let digestDeleted = false;
  try {
    digestDeleted = !!(await adapter.deleteDigest(fellowId));
  } catch (err) {
    const detail = scrub(err);
    console.error(`[sharedbrain-revoke] failed to delete digest: ${detail}`);
    failures.digest = { error: detail };
    onProgress('warn', `Could NOT delete the contributor's digest cache — ${detail}`);
  }

  // ── Step 3: delete pages where revoked fellow appears in Provenance ──────

  onProgress('info', 'Scanning collective pages for revoked-contributor provenance…');
  let pagesDeleted = 0;

  // SCOPE failure → ABORT (v3.6.2).
  //
  // This was `.catch(() => [])`, and that single expression defeated the
  // guard written to protect this exact operation. GitHubStorageAdapter's
  // `listPages` calls `_refuseTruncatedTree`, whose own docblock says it
  // exists because otherwise "revoke would report a successful Article 17
  // erasure while missing submissions". That throw landed here and became
  // an empty array: the loop below iterated ZERO pages, `pagesDeleted`
  // stayed 0, the rebuild ran, the marker was cleared and the admin was
  // told "Revocation complete" — while every page carrying the revoked
  // contributor's provenance survived untouched.
  //
  // An unreadable page list is not a partial erasure. It means we do not
  // know what to erase, so we must not proceed to rebuild-and-clear.
  let pagePaths;
  try {
    pagePaths = await adapter.listPages(connection.shared_domain);
  } catch (err) {
    const detail = scrub(err);
    const errMsg =
      `Erasure ABORTED before the collective-page scan: could not list the pages of ` +
      `"${connection.shared_domain}" — ${detail}. ` +
      `${contributionsDeleted} contribution${contributionsDeleted !== 1 ? 's' : ''} and ` +
      `${digestDeleted ? 'the digest were' : 'no digest was'} already deleted, but NO page was ` +
      `checked for this contributor's provenance, so the erasure is INCOMPLETE. ` +
      `The revocation-in-progress marker is still set (synthesis stays blocked). ` +
      `Resolve the listing failure, then re-run this revocation — every step is idempotent.`;
    console.error(`[sharedbrain-revoke] listPages failed: ${detail}`);
    onProgress('error', errMsg);
    // Built through the SAME helper as its twin above, so the two scope
    // aborts cannot drift apart again — which is precisely what finding 3
    // was. `partial: true` here and false there is the one real difference:
    // by this point contributions and the digest may already be deleted.
    return abortResult(errMsg, MARKER_ACTIVE, {
      partial: true,
      contributions_deleted: contributionsDeleted,
      contributions_failed: failures.contributions,
      digest_failed: failures.digest,
      pages_failed: [{ path: '*', error: detail }],
    });
  }

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
        // `removed === false` is NOT recorded as a failure, and that is a
        // load-bearing assumption rather than an oversight: BOTH shipped
        // adapters return false ONLY when the target is already absent
        // (LocalFolderStorageAdapter.deletePage → `if (!existsSync(abs))
        // return false`; GitHubStorageAdapter.deletePage → _deleteIfExists
        // → `if (!existing) return false` on a 404). Every other outcome
        // THROWS and lands in the catch below. So false means "already
        // erased", which is the desired end state, not a silent no-op.
        // A new adapter that returns false for a refused delete would
        // silently re-open the reported-as-complete hole this release
        // exists to close — the contract is pinned behaviourally in
        // scripts/test-sharedbrain-revoke.js §16.
        const removed = await adapter.deletePage(connection.shared_domain, pagePath);
        if (removed) {
          pagesDeleted++;
          onProgress('progress', `Deleted page ${pagePath}`);
        }
      }
    } catch (err) {
      const detail = scrub(err);
      console.error(`[sharedbrain-revoke] failed to scan/delete ${pagePath}: ${detail}`);
      // Read failure and delete failure are both recorded: a page we could
      // not READ is a page we could not clear of this contributor either.
      failures.pages.push({ path: pagePath, error: detail });
      onProgress('warn', `Could NOT check/delete page ${pagePath} — ${detail}`);
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
    // v3.6.2 — what this failure IS and IS NOT, because the two are easy
    // to conflate and the previous comment said only half of it:
    //   NOT an erasure failure — `erasure_complete` stays true; the data
    //     subject's content is gone regardless of this write.
    //   NOT fatal to the rebuild — it takes its baseline from
    //     `stateOverride`, not from this write (v3.0.6), and a successful
    //     synthesis writes a fresh state at the end anyway.
    //   NOT marker-blocking — it is deliberately absent from `fullSuccess`
    //     below, so a clean erasure still clears the marker and synthesis
    //     is never taken offline for a stale watermark.
    //   IT IS reported — it goes into `problems`, so the run returns
    //     ok:false. This is a deliberate bias toward OVER-reporting on a
    //     compliance path: a storage layer that cannot write meta is very
    //     likely to have failed something else too, and the summary the
    //     admin reads is precise about what did and did not complete
    //     ("the erasure itself completed, but do NOT certify…").
    const detail = scrub(err);
    console.error(`[sharedbrain-revoke] could not reset last-synthesis: ${detail}`);
    failures.stateReset = { error: detail };
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
    const detail = scrub(err);
    console.error(`[sharedbrain-revoke] re-synthesis failed: ${detail}`);
    synthesisResult = { ok: false, error: detail };
  }
  const rebuildOk = !!(synthesisResult && synthesisResult.ok);
  // v3.6.2 re-audit (finding 10): `runLocalSynthesis` reports most of its
  // failures by RETURNING `{ok:false, error}`, not by throwing — its
  // adapter-init and listContributionsSince guards both do. Only the THROW
  // path above was scrubbed, so a returned error reached `problems` →
  // `summary` → the SSE frame raw AND uncapped, bypassing
  // MAX_FAILURE_DETAIL_CHARS. No credential path is demonstrated (the PAT is
  // header-only and the adapter prefix-scrubs its own errors), but a
  // `listContributionsSince` failure is exactly the shape that carries an
  // absolute path, and makeScrubber's docblock claimed this was covered.
  // Routed through the one scrubber rather than softening the claim.
  const synthesisError = (synthesisResult && synthesisResult.error)
    ? scrub(synthesisResult.error)
    : null;
  const pagesRebuilt = rebuildOk ? (synthesisResult.pages_written || 0) : 0;
  // v3.6.2: runLocalSynthesis returns ok:true even when some pages failed
  // to write, so `rebuildOk` alone over-reports. Those pages are missing
  // from the collective and must not be hidden behind a green result.
  const pagesRebuildFailed = (synthesisResult && typeof synthesisResult.pages_failed === 'number')
    ? synthesisResult.pages_failed
    : 0;

  // ── Verdict ──────────────────────────────────────────────────────────────
  // Erasure completeness is decided ONLY by the erasure steps. A rebuild or
  // audit problem is serious but is not "their data is still there".
  const erasureComplete =
    failures.contributions.length === 0 &&
    failures.pages.length === 0 &&
    failures.digest === null;

  // ── Step 5: append audit log entry ───────────────────────────────────────

  // v3.6.2: the audit record carries the FAILURES too. An erasure audit
  // trail that only records successes is not an audit trail — a regulator
  // reading it would see a clean run over a partial erasure.
  //
  // Failures are recorded as COUNTS AND BOOLEANS ONLY, never the error
  // strings. This keeps the record's existing, load-bearing property
  // intact — no real names, no contribution content, and now also no
  // provider text that could carry either. The detail lives in the API
  // result the admin is looking at, not in the permanent log.
  const auditRecord = {
    revoked_at: new Date().toISOString(),
    fellow_id: fellowId,
    by_admin_token_hash: opts.adminTokenHash || null,
    contributions_deleted: contributionsDeleted,
    pages_deleted: pagesDeleted,
    pages_rebuilt: pagesRebuilt,
    rebuild_ok: rebuildOk, // v3.0.3 — false = erasure done, rebuild pending
    // ── v3.6.2 additions ──
    erasure_complete: erasureComplete,
    contributions_failed: failures.contributions.length,
    pages_failed: failures.pages.length,
    digest_failed: failures.digest !== null,
    pages_rebuild_failed: pagesRebuildFailed,
    state_reset_failed: failures.stateReset !== null,
    revocation_id: randomUUID(),
  };
  let auditWritten = false;
  try {
    await adapter.appendAudit(REVOCATIONS_LOG_PATH, auditRecord);
    auditWritten = true;
  } catch (err) {
    const detail = scrub(err);
    console.error(`[sharedbrain-revoke] could not write audit log: ${detail}`);
    failures.audit = { error: detail };
  }

  // ── Step 6 (v3.0.3): clear the in-progress marker ONLY on full success ───
  // On rebuild failure the marker stays active: synthesis keeps refusing and
  // the admin is steered to re-run the revoke (which is idempotent and will
  // finish the rebuild).
  //
  // v3.6.2 TIGHTENED: the gate is now the FULL verdict, not just the
  // rebuild. A recorded erasure failure keeps the marker active, so
  // ordinary synthesis stays refused and the admin cannot walk away from a
  // partial erasure. This is how "record and continue" keeps the safety
  // property of "abort" without giving up first-pass erasure coverage.
  //
  // v3.6.2 CORRECTION (adversarial audit): `auditWritten` was briefly a term
  // here and has been REMOVED. The marker's one stated job — quoted at Step
  // 0 — is that synthesis must refuse while the collective may be in a
  // mid-erasure state. A failed audit APPEND has nothing to do with that:
  // the erasure is finished and the collective is consistent. Blocking on it
  // borrowed a safety mechanism for an unrelated purpose and paid for it
  // with a COHORT-WIDE outage — a rate-limited or SHA-conflicted appendAudit
  // would make runLocalSynthesis return ok:false for EVERY contributor until
  // an admin re-ran the whole revocation, which re-lists the collective and
  // re-runs a full LLM synthesis, and under a persisting rate limit fails
  // the same way. The failure is still loud: it is in `problems`, the run
  // returns ok:false with `audit_failed` populated, and the summary says the
  // revocation must not be certified. Reported, not weaponised.
  //
  // Every remaining term is (a) load-bearing, (b) covered by a fixture that
  // can genuinely fail (§7/§8, §13, §15), and (c) semantically about
  // "is the collective in a mid-erasure state?" — which is the only
  // question this marker answers.
  const fullSuccess = erasureComplete && rebuildOk && pagesRebuildFailed === 0;
  let markerCleared = false;
  if (fullSuccess) {
    try {
      await adapter.writeMeta('state.revocation-in-progress', {
        active: false,
        finished_at: new Date().toISOString(),
      });
      markerCleared = true;
    } catch (err) {
      const detail = scrub(err);
      console.error(`[sharedbrain-revoke] could not clear the in-progress marker: ${detail}`);
      failures.markerClear = { error: detail };
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  //
  // Built by ACCUMULATING problems. The reassuring string is produced ONLY
  // inside `if (problems.length === 0)`; there is no `else`, no `default:`
  // and no fallthrough that can reach it. v3.6.1 shipped a `default:` arm
  // that fell into the cheerful branch — that is exactly how this class
  // survives, so the structure here removes the branch rather than
  // remembering to write it correctly.
  const problems = [];
  if (failures.contributions.length > 0) {
    problems.push(
      `${failures.contributions.length} contribution file${failures.contributions.length !== 1 ? 's' : ''} could NOT be deleted ` +
      `(e.g. ${failures.contributions[0].submission_id.slice(0, 8)}…: ${failures.contributions[0].error})`);
  }
  if (failures.digest !== null) {
    problems.push(`the contributor's digest cache could NOT be deleted (${failures.digest.error})`);
  }
  if (failures.pages.length > 0) {
    problems.push(
      `${failures.pages.length} collective page${failures.pages.length !== 1 ? 's' : ''} could NOT be checked or deleted ` +
      `(e.g. ${failures.pages[0].path}: ${failures.pages[0].error})`);
  }
  if (!rebuildOk) {
    problems.push(
      `the rebuild synthesis FAILED (${synthesisError || 'unknown error'}) — ` +
      `the collective is missing the deleted pages until it runs`);
  } else if (pagesRebuildFailed > 0) {
    problems.push(`the rebuild completed but ${pagesRebuildFailed} page${pagesRebuildFailed !== 1 ? 's' : ''} failed to write`);
  }
  if (failures.audit !== null) {
    problems.push(`the erasure was NOT written to the audit log (${failures.audit.error}) — you have no record of this revocation`);
  }
  if (failures.markerClear !== null) {
    problems.push(`the revocation-in-progress marker could not be cleared (${failures.markerClear.error}) — synthesis will stay blocked`);
  }
  if (failures.stateReset !== null) {
    problems.push(`the synthesis watermark could not be reset (${failures.stateReset.error})`);
  }

  const tally =
    `${contributionsDeleted} contribution${contributionsDeleted !== 1 ? 's' : ''} deleted, ` +
    `${pagesDeleted} page${pagesDeleted !== 1 ? 's' : ''} removed, ${pagesRebuilt} rebuilt`;

  const baseResult = {
    erasure_complete: erasureComplete,
    contributions_deleted: contributionsDeleted,
    contributions_failed: failures.contributions,
    digest_failed: failures.digest,
    pages_deleted: pagesDeleted,
    pages_failed: failures.pages,
    pages_rebuilt: pagesRebuilt,
    pages_rebuild_failed: pagesRebuildFailed,
    state_reset_failed: failures.stateReset,
    audit_failed: failures.audit,
    marker_cleared: markerCleared,
    // Step 0 succeeded to reach here, so a marker definitely exists and its
    // state is exactly "did we clear it?". Unlike the abort paths there is no
    // N/A case, so this is a plain boolean. Derived from the same variable
    // rather than re-read, so the two fields cannot disagree.
    marker_active: !markerCleared,
    audit_record: auditRecord,
  };

  if (problems.length > 0) {
    const headline = erasureComplete
      ? `Erasure completed (${tally}), but the revocation did NOT finish cleanly.`
      : `⚠ ERASURE INCOMPLETE — this contributor's data has NOT been fully removed (${tally}).`;
    const errMsg =
      `${headline} ${problems.length === 1 ? 'Problem' : `${problems.length} problems`}: ` +
      problems.map((p, i) => `(${i + 1}) ${p}`).join('; ') + '. ' +
      (markerCleared
        ? ''
        : `The revocation-in-progress marker is still set, so ordinary synthesis stays blocked. `) +
      (erasureComplete
        ? `The erasure itself completed, but do NOT certify this revocation until the problems above are resolved. `
        : `Do NOT report this erasure as complete. `) +
      `Resolve the problems above and re-run this revocation (safe — every step is idempotent).`;
    onProgress('error', errMsg);
    return {
      ok: false,
      partial: true,
      error: errMsg,
      summary: errMsg,
      ...baseResult,
    };
  }

  const doneMsg =
    `Revocation complete: ${tally}. ` +
    `Next: tell every contributor to Pull updates (their mirrors drop the erased content), ` +
    `and remove the person as a GitHub collaborator so they cannot push again.`;
  onProgress('done', doneMsg);

  return {
    ok: true,
    // Present on all nine return points so `partial` is never `undefined` on
    // one branch and a boolean on the others — the same consistency finding 4
    // raised about the abort paths.
    partial: false,
    summary: doneMsg,
    ...baseResult,
  };
}

/**
 * Hash an admin token for the audit trail — SALTED, per record (v3.43.0).
 *
 * `state/revocations.jsonl` lives in the shared repo and is readable by every
 * contributor. Until v3.43.0 this wrote a bare `sha256:<hex>` of the admin
 * token, which is an OFFLINE VERIFICATION ORACLE: anyone holding the file can
 * test candidate tokens at the speed of one hash each. Against the 160-bit
 * token `generateAdminToken` mints that is academic, but `validateConnection`
 * accepts ANY single-line 16–200 character string, so a hand-set or
 * hand-migrated admin token — "cohort-admin-2026", say — was recoverable from
 * a file the suspected leaker can read. That token is the sole gate on
 * revoking any contributor.
 *
 * FORMAT: `sha256:<saltHex>:<digestHex>` where digest = sha256(saltHex + ':' +
 * token). The salt is 16 random bytes, fresh PER RECORD, and stored beside the
 * digest, so:
 *   - the audit stays VERIFIABLE — an admin holding the token recomputes the
 *     digest with the record's own salt (verifyAdminTokenHash below, which is
 *     exported so "verifiable" is executable rather than prose);
 *   - precomputation and cross-record correlation both die with it.
 *
 * COST, STATED: a per-record salt means two revocations by the same admin no
 * longer produce the same string, so the old docblock's "which admin instance"
 * correlation is GONE. That is a deliberate trade and the weaker property was
 * the one worth losing: correlating revocations to one admin is a privacy leak
 * of its own, and the audit's job is that the erasure happened and was
 * authorised — which verification still answers.
 *
 * The `sha256:` prefix is kept so existing readers (and the live suite's
 * "never the raw token" assertion) keep working, and verifyAdminTokenHash
 * still accepts the legacy two-part form so pre-v3.43.0 records stay checkable.
 */
export function hashAdminToken(token) {
  if (typeof token !== 'string' || !token) return null;
  const salt = randomBytes(16).toString('hex');
  return `sha256:${salt}:${createHash('sha256').update(salt + ':' + token).digest('hex')}`;
}

/**
 * Verify a stored `by_admin_token_hash` against a candidate token. Accepts
 * both the salted form and the legacy unsalted one. Constant-time on the
 * digest comparison — the value being checked is a credential.
 */
export function verifyAdminTokenHash(token, stored) {
  if (typeof token !== 'string' || !token) return false;
  if (typeof stored !== 'string' || !stored.startsWith('sha256:')) return false;
  const parts = stored.split(':');
  let expected;
  if (parts.length === 3) {
    expected = createHash('sha256').update(parts[1] + ':' + token).digest('hex');
  } else if (parts.length === 2) {
    expected = createHash('sha256').update(token).digest('hex'); // pre-v3.43.0
  } else {
    return false;
  }
  const a = Buffer.from(parts[parts.length - 1], 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export const __testing = {
  shortenFellowId,
  REVOCATIONS_LOG_PATH,
  // v3.6.2 re-audit: exported so makeScrubber's ENFORCED list is executable
  // rather than prose. Its docblock has now over-claimed once; an assertion
  // that can go red is the only version of that claim worth keeping.
  makeScrubber,
  MAX_FAILURE_DETAIL_CHARS,
};
