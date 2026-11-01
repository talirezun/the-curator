// shared/sync-run.js — a personal-sync run that belongs to the SHELL, not to
// a mount of the Sync view (v3.89.2).
//
// THE BUG THIS FIXES. "If you press the Sync button and then move from Sync
// to another section, the sync gets cancelled." Measured: the server never
// cancelled anything — the commit reached the remote every time. The Sync
// view kept the run in its per-mount `state`, which every mount replaces
// wholesale, and dropped the result on a stale mount token by design. So
// leaving the page threw the run away, and coming back painted an IDLE page
// ("Sync now", enabled, no outcome) while the sync was still running. A
// second click there started a second sync beside the first, and that one
// failed with "Another sync check was running at the same time, so this one
// stopped early" — which is what "cancelled" looked like.
//
// So the run lives here, at module level, for the life of the page:
//   · startSyncRun(kind) — the ONE place a push/pull/sync request is made.
//     It refuses (returns null, makes no request) while a run is already
//     going: two clicks never start two syncs. The check and the set are
//     synchronous, with no await between them.
//   · the request is never aborted and nothing here knows about mounts or
//     navigation; a run settles whatever the user does meanwhile.
//   · adoptServerSyncJob(payload) — GET /api/sync/job says a run is going that
//     THIS page did not start (a reload mid-sync, the Context page's Sync
//     button): track it by polling that endpoint until it ends.
//   · onSyncRunChange(fn) — the rail (app.js) and whichever Sync mount is
//     current subscribe; each paints itself from currentSyncRun() and
//     lastSyncOutcome().
//   · configureSyncRun({ beforeSettle, describe }) — `beforeSettle` is awaited
//     BEFORE the run is cleared, so the rail badge's remote refresh (a real
//     fetch) finishes before any Sync button is live again (the v3.9.x
//     release-blocker ordering, kept). `describe(kind, data)` turns a result
//     into the sentence shown.
//
// `createSyncRunner(env)` takes fetch and the timers as arguments so
// scripts/test-sync-run-survives-navigation.js drives the real code in Node.

export const SYNC_RUN_KINDS = ['sync', 'push', 'pull'];
export const SYNC_JOB_POLL_MS = 1000;
// A run the page only observes (it did not start it) is followed for at most
// this many polls; past it the page stops claiming anything is running.
export const SYNC_JOB_POLL_MAX = 900;

export function createSyncRunner(env) {
  const listeners = new Set();
  let run = null;       // { kind, startedAt, here: boolean }
  let outcome = null;   // { kind, ok, message, error, at, seen }
  let pollTimer = null;
  let polls = 0;
  let hooks = { beforeSettle: null, describe: null };

  function notify() {
    for (const fn of Array.from(listeners)) {
      try { fn(); } catch (err) { try { console.error('[sync-run] listener failed', err); } catch { /* no console */ } }
    }
  }

  function describe(kind, data) {
    try { if (hooks.describe) return hooks.describe(kind, data); } catch { /* fall through */ }
    return (data && data.message) || 'Sync complete.';
  }

  async function settle(next) {
    try { if (hooks.beforeSettle) await hooks.beforeSettle(); } catch { /* never blocks the settle */ }
    outcome = next;
    run = null;
    notify();
    return next;
  }

  function schedulePoll() {
    if (pollTimer !== null) return;
    pollTimer = env.setTimeout(pollOnce, SYNC_JOB_POLL_MS);
  }

  async function pollOnce() {
    pollTimer = null;
    if (!run || run.here) return;
    polls++;
    let payload = null;
    try {
      const res = await env.fetch('/api/sync/job');
      if (res.ok) payload = await res.json();
    } catch { payload = null; }
    if (!run || run.here) return;
    if (!payload || payload.running) {
      if (polls >= SYNC_JOB_POLL_MAX) { await settle(outcome); return; }
      schedulePoll();
      return;
    }
    const last = payload.last;
    if (last && SYNC_RUN_KINDS.includes(last.kind)) {
      await settle(last.state === 'done'
        ? { kind: last.kind, ok: true, message: describe(last.kind, last.result), error: null, at: last.finishedAt, seen: false }
        : { kind: last.kind, ok: false, message: null, error: last.error || 'The sync did not complete.', at: last.finishedAt, seen: false });
    } else {
      await settle(outcome);
    }
  }

  function follow(kind) {
    run = { kind, startedAt: null, here: false };
    polls = 0;
    notify();
    schedulePoll();
  }

  return {
    currentSyncRun() { return run ? { ...run } : null; },
    lastSyncOutcome() { return outcome; },
    markOutcomeSeen(o) { if (o && o === outcome) outcome.seen = true; },
    onSyncRunChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    configureSyncRun(h) { hooks = { ...hooks, ...(h || {}) }; },

    async startSyncRun(kind) {
      if (!SYNC_RUN_KINDS.includes(kind)) return null;
      if (run) return null; // one sync at a time — synchronous check-and-set
      run = { kind, startedAt: Date.now(), here: true };
      notify();
      let next;
      try {
        const res = await env.fetch('/api/sync/' + kind, { method: 'POST' });
        let data = {};
        try { data = await res.json(); } catch { data = {}; }
        if (res.status === 409 && data && data.code === 'sync_running') {
          // Someone else's run (another window, the Context page) is going:
          // follow THAT one rather than reporting a failure.
          follow((data.running && data.running.kind) || kind);
          return null;
        }
        next = res.ok
          ? { kind, ok: true, message: describe(kind, data), error: null, at: new Date().toISOString(), seen: false }
          : { kind, ok: false, message: null, error: (data && data.error) || 'That didn’t work.', at: new Date().toISOString(), seen: false };
      } catch (err) {
        next = { kind, ok: false, message: null, error: (err && err.message) || 'That didn’t work.', at: new Date().toISOString(), seen: false };
      }
      return settle(next);
    },

    adoptServerSyncJob(payload) {
      if (run) return false;
      const r = payload && payload.running;
      if (!r || !SYNC_RUN_KINDS.includes(r.kind)) return false;
      follow(r.kind);
      return true;
    },
  };
}

const runner = createSyncRunner({
  fetch: (...a) => fetch(...a),
  setTimeout: (...a) => setTimeout(...a),
  clearTimeout: (...a) => clearTimeout(...a),
});

export const currentSyncRun = runner.currentSyncRun;
export const lastSyncOutcome = runner.lastSyncOutcome;
export const markOutcomeSeen = runner.markOutcomeSeen;
export const onSyncRunChange = runner.onSyncRunChange;
export const configureSyncRun = runner.configureSyncRun;
export const startSyncRun = runner.startSyncRun;
export const adoptServerSyncJob = runner.adoptServerSyncJob;
