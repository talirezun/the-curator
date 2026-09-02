/**
 * Write registry — coordinate long-running writes against concurrent
 * sync / update / restart / delete operations (v3.0.1-beta.8).
 *
 * ── The problem this solves ──────────────────────────────────────────────
 *
 * Pre-v3.0.1-beta.8 the Curator had NO coordination between in-flight
 * ingests / compiles / health-fix-all bulk runs and the mutating endpoints
 * that touch the same disk state (update, restart, sync, delete-domain).
 * Clicking "Check for Updates" while an ingest was running would happily
 * `git reset --hard` the app and then `/api/restart` would kill the Node
 * process mid-write — leaving truncated wiki files behind.
 *
 * The fix is layered:
 *   1. Atomic writes (src/brain/atomic-write.js) so a kill mid-write never
 *      truncates a file. Closes the worst symptom.
 *   2. THIS module — a shared in-memory map of (operation → domain) for the
 *      current web-server process. Long-running operations add to it on
 *      entry, remove on exit. Conflicting endpoints check it first and
 *      return 409 with a clear error.
 *   3. File-based lock under <domain>/.write-lock so the MCP server
 *      (separate child process spawned by Claude Desktop) can also
 *      respect the in-flight state. This is a REAL exclusive acquire
 *      (link(2) against an existing name) as of the fix below — it was
 *      `existsSync` followed by a rename for its whole life before that,
 *      which double-granted. See acquireFileLock's docblock.
 *   4. Frontend disables the Update/Sync/Delete buttons while the
 *      ingest SSE stream is open (defense in depth — the user usually
 *      never sees the 409 because the click is impossible).
 *
 * ── Data model ───────────────────────────────────────────────────────────
 *
 * In-memory: `Map<domain, { count: number, ops: Set<{op, startedAt}> }>`.
 * A counter (rather than a Set) lets two ingests for the SAME domain
 * coexist correctly — one decrement doesn't fully release.
 *
 * Update/restart use a separate boolean (`_updateInProgress`) because they
 * are domain-global. The ingest path double-checks both before adding to
 * the registry (closes the millisecond race window where an update
 * arrived 1ms after the ingest check passed).
 *
 * ── What this is NOT ─────────────────────────────────────────────────────
 *
 * Not a mutex. Two concurrent ingests on the same domain are still allowed
 * (current behaviour) — they will both register, the merge-race inside
 * writePage is unchanged. The registry's purpose is coordinating BETWEEN
 * write operations and DESTRUCTIVE operations (reset --hard, git pull, rm),
 * not eliminating same-class races.
 *
 * Not persistent. Restart wipes the in-memory map; the file lock under
 * <domain>/.write-lock has a TTL + PID staleness check so an orphaned lock
 * from a crashed process clears itself.
 *
 * ── What the file lock was NOT, until this fix ───────────────────────────
 *
 * It was described here and in docs/architecture.md as a cross-process lock,
 * and it was not one. acquireFileLock() was `existsSync(lockFile)` followed
 * by `writeFileAtomic(lockFile, ...)`, with a `catch` arm whose comment said
 * it handled "another process wrote the lock in between". That arm was
 * UNREACHABLE: writeFileAtomic ends in `rename(2)`, and rename over an
 * existing regular file is a silent, successful replace on POSIX. So two
 * processes that both passed the existsSync check both "acquired" the lock,
 * and the second one's write simply overwrote the first one's record —
 * leaving the first holder's release() unable to even recognise its own
 * lock. Three separate call sites had already written the defect down as
 * fact (ingest-queue.js, working-state.js, src/public/app.js) and routed
 * around it. The acquire is now exclusive by construction — see below.
 */

import { existsSync } from 'fs';
import { writeFile, readFile, unlink, mkdir, link } from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

// ── In-memory registry ──────────────────────────────────────────────────

/** @type {Map<string, { count: number, ops: Set<string> }>} */
const _activeWrites = new Map();

/** Set when /api/update is running its git-reset / npm-install path. */
let _updateInProgress = false;

/**
 * Mark the start of a write operation on `domain`. Returns a release token
 * that the caller MUST invoke (in `finally`) to decrement the counter.
 *
 * @param {string} domain
 * @param {string} op - human-readable operation name (e.g. "ingest", "compile", "health-fix-all")
 * @returns {() => void}  release token
 */
export function registerWrite(domain, op = 'write') {
  if (typeof domain !== 'string' || !domain) {
    throw new Error('registerWrite requires a non-empty domain string');
  }
  const entry = _activeWrites.get(domain) || { count: 0, ops: new Set() };
  entry.count++;
  entry.ops.add(op);
  _activeWrites.set(domain, entry);

  let released = false;
  return function release() {
    if (released) return;
    released = true;
    const e = _activeWrites.get(domain);
    if (!e) return;
    e.count = Math.max(0, e.count - 1);
    if (e.count === 0) {
      _activeWrites.delete(domain);
    } else {
      // Multi-ingest case: keep the entry; ops tracking is informational
      _activeWrites.set(domain, e);
    }
  };
}

/**
 * Returns the current list of domains with active writes plus their ops.
 * Used by the 409 error message construction in conflicting routes.
 *
 * @returns {Array<{ domain: string, count: number, ops: string[] }>}
 */
export function listActiveWrites() {
  const out = [];
  for (const [domain, entry] of _activeWrites) {
    out.push({ domain, count: entry.count, ops: [...entry.ops] });
  }
  return out;
}

/** Convenience: is any write active anywhere? */
export function hasActiveWrites() {
  return _activeWrites.size > 0;
}

/** Is a write active on a specific domain? */
export function isDomainActive(domain) {
  return _activeWrites.has(domain);
}

// ── Update flag (domain-global) ────────────────────────────────────────

export function beginUpdate() {
  _updateInProgress = true;
}
export function endUpdate() {
  _updateInProgress = false;
}
export function isUpdateInProgress() {
  return _updateInProgress;
}

/**
 * Build a standard 409-response payload for a conflicting endpoint.
 * Centralises the message format so all routes report uniformly.
 *
 * @param {string} attemptedOp - "update", "sync push", "delete domain", etc.
 * @returns {{ status: 409, body: object }}
 */
export function conflictResponse(attemptedOp) {
  const active = listActiveWrites();
  const domainList = active.length === 0
    ? ''
    : active.map(a => `${a.domain} (${a.ops.join(', ')})`).join('; ');
  const message = _updateInProgress
    ? `Cannot ${attemptedOp} while an app update is in progress. Please wait for the update to complete.`
    : `Cannot ${attemptedOp} while a write operation is running: ${domainList}. Please wait for it to finish, then try again.`;
  return {
    status: 409,
    body: {
      error: message,
      conflict: 'write_in_progress',
      active,           // structured for the frontend
      updateInProgress: _updateInProgress,
    },
  };
}

// ── File-based lock (cross-process; MCP coordination) ──────────────────

/**
 * Stale-lock threshold. If a .write-lock file is older than this, we
 * consider the holder dead and treat the lock as gone. 30 minutes is
 * generous — a single ingest is typically 30–120 seconds; even a slow
 * Phase 2 multi-batch run with retries rarely exceeds 5 minutes.
 */
const LOCK_STALE_MS = 30 * 60 * 1000;

function lockPath(domainDir) {
  return path.join(domainDir, '.write-lock');
}

/**
 * Try to acquire a file-based write lock for `domainDir`. Returns a
 * release function on success, or null if another process holds a fresh
 * lock. Stale locks (older than LOCK_STALE_MS or with a dead PID) are
 * silently cleared and the caller acquires the new lock.
 *
 * Designed for cross-process use - the web server and the MCP child
 * process both call this. Within the same process the in-memory registry
 * is faster and authoritative; the file lock is the cross-process layer.
 *
 * -- Why link(2) and not open('wx') --------------------------------------
 *
 * Either is a genuinely exclusive create - the kernel resolves the race,
 * not us. `link(2)` is used because it publishes the lock's NAME and its
 * CONTENT in the same instant: with open('wx') there is a window between
 * the create and the write in which a second process reads a ZERO-BYTE
 * lock file, fails to parse it, and - by this module's own long-standing
 * "unparseable lock = stale" rule - deletes a lock that a live holder had
 * just taken. So the payload is written to a per-caller tempfile first and
 * the tempfile is then linked into place under the real name. EEXIST from
 * link() means somebody already holds it.
 *
 * -- The one race that remains, stated rather than hidden ----------------
 *
 * Clearing a STALE lock is still unlink-then-retry, so two processes that
 * simultaneously judge the SAME dead lock stale can both unlink, and the
 * loser's unlink can remove the winner's brand-new lock. That is the same
 * TOCTOU clearStaleLock() documents, and it cannot be closed without a
 * lower-level primitive. It is narrowed the same way clearStaleLock
 * narrows it - re-read immediately before the unlink and bail if the bytes
 * changed - and it needs a lock that is ALREADY dead, so no live writer's
 * data is at risk. The case the fix actually had to close is two live
 * processes racing for a FREE lock, and link(2) closes that outright.
 *
 * @param {string} domainDir  absolute path to <domainsDir>/<domain>/
 * @param {{ op?: string, ttlMs?: number, __onBeforeLink?: (attempt: number) => Promise<void> }} [opts]
 *   `__onBeforeLink` is a TEST-ONLY seam - see the call site below. Production
 *   callers never pass it.
 * @returns {Promise<(() => Promise<void>) | null>}
 */
export async function acquireFileLock(domainDir, opts = {}) {
  const op = opts.op || 'write';
  const lockFile = lockPath(domainDir);
  await mkdir(domainDir, { recursive: true });

  // A nonce, not just the pid: after a lock of ours is judged stale and
  // cleared by someone else, THIS process can legitimately hold the lock
  // again under the same pid. Without the nonce the older release() token
  // would happily delete the newer holder's lock.
  const nonce = crypto.randomBytes(8).toString('hex');
  const payload = JSON.stringify({
    pid: process.pid,
    op,
    startedAt: Date.now(),
    hostname: process.env.HOSTNAME || 'unknown',
    nonce,
  }, null, 2);

  const tmpPath = `${lockFile}.${process.pid}.${nonce}.tmp`;
  try {
    await writeFile(tmpPath, payload, 'utf8');
  } catch {
    return null;   // cannot even stage the lock - never claim it
  }

  let acquired = false;
  try {
    // Two attempts: the first can lose to an existing lock, and if that
    // lock proves stale we clear it and try exactly once more. More
    // attempts would only lengthen a spin against a live holder.
    for (let attempt = 0; attempt < 2 && !acquired; attempt++) {
      // TEST-ONLY seam: lets a suite interleave another acquirer at exactly
      // the instant before the exclusive create. A no-op in production.
      if (typeof opts.__onBeforeLink === 'function') {
        try { await opts.__onBeforeLink(attempt); } catch { /* never let the seam break the acquire */ }
      }
      try {
        await link(tmpPath, lockFile);   // EEXIST if anybody already holds it
        acquired = true;
        break;
      } catch (err) {
        if (err.code !== 'EEXIST') return null;   // ENOSPC, EPERM, ... - do not claim
      }
      if (attempt > 0) break;   // already retried once
      // Not ours yet. Either it is dead and clearable, or it vanished under
      // us because its holder released between our link() and this line —
      // both are worth exactly one more attempt. Only a lock that is STILL
      // THERE and NOT stale means somebody alive holds it.
      const cleared = await clearStaleLock(domainDir);
      if (!cleared && existsSync(lockFile)) return null;
    }
  } finally {
    try { await unlink(tmpPath); } catch { /* best-effort */ }
  }

  if (!acquired) return null;

  return async function release() {
    // Best-effort: if another process took the lock (e.g. ours was deemed
    // stale by the next caller), don't error out - and, crucially, don't
    // delete THEIR lock. The nonce is what makes that check exact.
    try {
      const raw = await readFile(lockFile, 'utf8');
      const data = JSON.parse(raw);
      if (data.pid !== process.pid) return;
      if (data.nonce !== nonce) return;
      await unlink(lockFile);
    } catch { /* lock already gone */ }
  };
}

/**
 * Probe whether a PID is still alive without actually signalling it.
 * `process.kill(pid, 0)` throws ESRCH if the process is gone.
 * Returns false on any error (conservative: better to treat a possibly-alive
 * process as alive than to clobber its lock).
 */
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'ESRCH') return false;   // no such process
    if (err.code === 'EPERM') return true;    // exists but we can't signal
    return true;
  }
}

/**
 * Quick non-acquiring check — returns true if a fresh lock exists for
 * `domainDir`. Used by MCP write tools to refuse fast without trying to
 * take the lock themselves.
 */
export async function isFileLocked(domainDir) {
  const lockFile = lockPath(domainDir);
  if (!existsSync(lockFile)) return false;
  try {
    const raw = await readFile(lockFile, 'utf8');
    const data = JSON.parse(raw);
    const age = Date.now() - (data.startedAt || 0);
    if (age > LOCK_STALE_MS) return false;
    if (typeof data.pid === 'number' && !isPidAlive(data.pid)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort cleanup pass: remove the `.write-lock` file under `domainDir`
 * ONLY if the SAME staleness rule used by acquireFileLock()/isFileLocked()
 * already considers it dead — age > LOCK_STALE_MS, or the owning PID is no
 * longer alive; an unparseable lock file also counts as stale, exactly as
 * it does in acquireFileLock(). This is deliberately the ONE definition of
 * "stale" in the module; callers must never grow a second, looser one.
 *
 * Unlike acquireFileLock(), this does NOT claim the lock afterward — it's a
 * pure hygiene pass, not an acquire. It exists because `git rm --cached`
 * (used by sync.js's untrackStaleWriteLocks()) only removes a committed lock
 * from git's INDEX; it never touches the file on disk, so a genuinely dead
 * lock can be left sitting in the working tree indefinitely (v3.0.15 shipped
 * that gap — see CLAUDE.md's "Deferred to v3.0.16" note). A FRESH lock — one
 * a live process, in this process or the separate MCP child process, still
 * legitimately holds — is never touched: the age/PID checks are identical to
 * the ones acquireFileLock() itself uses to decide whether to self-heal.
 *
 * TOCTOU note (audit finding, fixed here): the read → staleness-check →
 * unlink sequence is not atomic. Between the read and the unlink, a SEPARATE
 * process (classically the MCP child process) can independently decide this
 * SAME lock is stale via its own acquireFileLock(), clear it, and write a
 * brand-new FRESH lock in its place. Blindly unlinking at that point deletes
 * the OTHER process's live lock instead of the dead one we inspected —
 * opening the door to two concurrent writers, exactly the corruption this
 * lock exists to prevent (the holder's own release() then silently no-ops
 * because the file is already gone). This can't be closed to a zero-width
 * window without a lower-level OS primitive (acquireFileLock() itself has
 * the same non-atomic shape), but re-reading immediately before the unlink
 * and bailing if the bytes changed shrinks the window from "however long we
 * held stale data" down to the gap between two adjacent syscalls.
 *
 * @param {string} domainDir  absolute path to <domainsDir>/<domain>/
 * @param {{ __onBeforeRecheck?: () => Promise<void> }} [opts]  test-only —
 *   see the note at the recheck call site below. Production callers never
 *   pass this.
 * @returns {Promise<boolean>}  true if a stale lock was removed
 */
export async function clearStaleLock(domainDir, opts = {}) {
  const lockFile = lockPath(domainDir);
  if (!existsSync(lockFile)) return false;

  let firstRaw;
  try {
    firstRaw = await readFile(lockFile, 'utf8');
  } catch {
    return false; // vanished between existsSync and readFile — nothing to do
  }

  let stale = false;
  try {
    const data = JSON.parse(firstRaw);
    const age = Date.now() - (data.startedAt || 0);
    if (age > LOCK_STALE_MS) {
      stale = true;
    } else if (typeof data.pid === 'number' && !isPidAlive(data.pid)) {
      stale = true;
    }
  } catch {
    stale = true; // unparseable lock = stale, same rule acquireFileLock() uses
  }
  if (!stale) return false;

  // Test-only seam: lets a battle test simulate another process racing in
  // and rewriting the lock file at exactly this point, to prove the recheck
  // below actually catches it. A no-op whenever the caller doesn't pass it
  // (every production call site).
  if (typeof opts.__onBeforeRecheck === 'function') {
    await opts.__onBeforeRecheck();
  }

  // The TOCTOU guard itself: re-read right before acting, and refuse to
  // touch the file if its content is no longer what we inspected above.
  let secondRaw;
  try {
    secondRaw = await readFile(lockFile, 'utf8');
  } catch {
    return false; // already gone — someone else's release()/cleanup won the race
  }
  if (secondRaw !== firstRaw) {
    // Changed underneath us — quite possibly a brand-new FRESH lock. Never
    // touch it; a future pass will correctly judge IT on its own merits.
    return false;
  }

  try {
    await unlink(lockFile);
    return true;
  } catch {
    // Race: another process already removed/replaced it in the gap between
    // our recheck read and this unlink. Never treat this as an error —
    // best-effort cleanup only.
    return false;
  }
}

// ── Test helpers (internal — not part of public API) ──────────────────

export const __testing = {
  _resetActiveWrites: () => _activeWrites.clear(),
  _resetUpdate: () => { _updateInProgress = false; },
  LOCK_STALE_MS,
};
