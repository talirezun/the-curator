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
 *      respect the in-flight state.
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
 */

import { existsSync } from 'fs';
import { writeFile, readFile, unlink, mkdir } from 'fs/promises';
import path from 'path';
import { writeFileAtomic } from './atomic-write.js';

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
 * Designed for cross-process use — the web server and the MCP child
 * process both call this. Within the same process the in-memory registry
 * is faster and authoritative; the file lock is the cross-process layer.
 *
 * @param {string} domainDir  absolute path to <domainsDir>/<domain>/
 * @param {{ op?: string, ttlMs?: number }} [opts]
 * @returns {Promise<(() => Promise<void>) | null>}
 */
export async function acquireFileLock(domainDir, opts = {}) {
  const op = opts.op || 'write';
  const lockFile = lockPath(domainDir);
  await mkdir(domainDir, { recursive: true });

  if (existsSync(lockFile)) {
    let stale = false;
    try {
      const raw = await readFile(lockFile, 'utf8');
      const data = JSON.parse(raw);
      const age = Date.now() - (data.startedAt || 0);
      if (age > LOCK_STALE_MS) {
        stale = true;
      } else if (typeof data.pid === 'number' && !isPidAlive(data.pid)) {
        stale = true;
      }
    } catch {
      stale = true;  // unparseable lock = stale
    }
    if (!stale) return null;
    try { await unlink(lockFile); } catch { /* ignore */ }
  }

  const payload = {
    pid: process.pid,
    op,
    startedAt: Date.now(),
    hostname: process.env.HOSTNAME || 'unknown',
  };
  try {
    await writeFileAtomic(lockFile, JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    // Race: another process wrote the lock in between our staleness check
    // and our own write. Don't claim the lock.
    return null;
  }

  return async function release() {
    // Best-effort: if another process took the lock (e.g. ours was deemed
    // stale by the next caller), don't error out.
    try {
      const raw = await readFile(lockFile, 'utf8');
      const data = JSON.parse(raw);
      if (data.pid !== process.pid) return;
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

// ── Test helpers (internal — not part of public API) ──────────────────

export const __testing = {
  _resetActiveWrites: () => _activeWrites.clear(),
  _resetUpdate: () => { _updateInProgress = false; },
  LOCK_STALE_MS,
};
