/**
 * sync-job.js — ONE personal-sync operation at a time, and a record of it
 * that outlives the HTTP request that started it (v3.89.2).
 *
 * WHY THIS EXISTS. The owner's report: "If you press the Sync button and then
 * move from Sync to another section, the sync gets cancelled." Measured on an
 * isolated rig (a local bare remote whose pre-receive hook sleeps 5 s), the
 * server operation was NEVER cancelled — nothing in routes/sync.js or
 * brain/sync.js listens for the request closing, and the commit reached the
 * remote every time. What the user saw was the UI:
 *
 *   1. views/sync.js kept the run in its per-mount `state`, so leaving the
 *      page dropped the result and coming back painted a fresh, IDLE page —
 *      "Sync now", enabled, no outcome, and a pending count read mid-sync
 *      ("1 local change not pushed") that was never re-read.
 *   2. Clicking "Sync now" again on that idle-looking page started a SECOND
 *      sync beside the first. The two raced each other's refs and the second
 *      one answered "Another sync check was running at the same time, so this
 *      one stopped early" — which reads exactly like "it got cancelled".
 *
 * This module is the server half of the fix: a single-flight gate around
 * push / pull / sync / setup / disconnect (a second start while one runs is
 * REFUSED with a typed error, never queued and never run beside it), and the
 * running + last job, readable by any client at GET /api/sync/job — so a
 * returning page, a reloaded window or another view can show the run it did
 * not start. The client half is src/public/next/shared/sync-run.js.
 *
 * The check-and-set below has no `await` between them, so on Node's single
 * thread two requests can never both pass it.
 *
 * Process-local by design: the app runs one server. The MCP's separate
 * process never runs personal sync.
 */

let _running = null; // { id, kind, startedAt }
let _last = null;    // { id, kind, startedAt, finishedAt, state: 'done'|'failed', result?, error? }
let _seq = 0;

export class SyncBusyError extends Error {
  constructor(running) {
    super('A sync is already running (' + running.kind + ', started ' + running.startedAt + '). ' +
          'It keeps going on its own — wait for it to finish; this one was not started.');
    this.code = 'sync_running';
    this.running = { ...running };
  }
}

/** The running job (or null) and the last finished one (or null). Copies. */
export function getSyncJob() {
  return {
    running: _running ? { ..._running } : null,
    last: _last ? { ..._last } : null,
  };
}

/**
 * Run `fn` as THE sync job of kind `kind`. Throws SyncBusyError, without
 * calling `fn`, when another job is running. `describeError(err)` turns a
 * failure into the sentence recorded on the job (the routes pass
 * friendlyError); the original error is re-thrown unchanged.
 */
export async function runSyncJob(kind, fn, { describeError } = {}) {
  if (_running) throw new SyncBusyError(_running);
  const job = { id: ++_seq, kind, startedAt: new Date().toISOString() };
  _running = job;
  try {
    const result = await fn();
    _last = { ...job, finishedAt: new Date().toISOString(), state: 'done', result };
    return result;
  } catch (err) {
    let error = err && err.message ? err.message : String(err);
    try { if (describeError) error = describeError(err) || error; } catch { /* keep the raw message */ }
    _last = { ...job, finishedAt: new Date().toISOString(), state: 'failed', error };
    throw err;
  } finally {
    _running = null;
  }
}

/** Test seam: forget every job. */
export function __resetSyncJobForTest() { _running = null; _last = null; }
