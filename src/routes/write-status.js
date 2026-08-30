/**
 * GET /api/write-status — "is it safe to quit right now?"
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * `src/brain/write-registry.js` has tracked in-flight wiki writes since
 * v3.0.1-beta.8, and until now it was used in exactly one direction: as an
 * INTERNAL guard that makes a conflicting route answer 409. Nothing could ASK
 * it a question. So there was no way — from any process, including the app's
 * own frontend — to find out whether a write was in progress without
 * attempting a mutation and reading the refusal.
 *
 * That gap becomes load-bearing the moment The Curator is a desktop app.
 * Electron's `before-quit` has to decide, synchronously-ish, whether closing
 * the window is about to truncate a multi-minute ingest. Today the only signal
 * available is "the browser tab is open", which is not the same question.
 *
 * This is deliberately the SMALLEST possible step: one GET, no new state, no
 * new bookkeeping — it reads three functions that already exist and are already
 * covered by `scripts/test-write-registry.js`. Nothing in repo mode consumes
 * it; the packaging release will.
 *
 * ── Why it is NOT a write route and NOT behind guardConcurrent ──────────────
 *
 * A 409 here would fire precisely when a write IS in progress, i.e. exactly
 * when someone is asking whether a write is in progress. The answer would be
 * carried in an error the caller has to reverse-engineer, and a caller that
 * treated 409 as a failure would learn nothing at all. Same reasoning
 * `GET /api/ingest/activity` records (v3.24.0) for the same shape.
 *
 * It also does not register a write of its own — reading a counter is not a
 * write, and registering one would make the endpoint report itself.
 *
 * ── Wire shape is an explicit allow-list ────────────────────────────────────
 *
 * Never a spread of registry internals (the v3.3.0 `toWire()` rule). `domain`
 * is a user-chosen slug and `op` is a fixed internal vocabulary; both are
 * length-capped, the array is capped, and the TRUE total rides alongside so a
 * cap is never mistaken for a measurement (v3.17.0's rule).
 */

import express from 'express';
import { hasActiveWrites, listActiveWrites, isUpdateInProgress } from '../brain/write-registry.js';

const router = express.Router();

/** Cap the array, not the count — the honest total is reported separately. */
export const MAX_LISTED_OPERATIONS = 50;
/** Same bound `wire-safe.js` uses for a wire string, applied locally. */
const MAX_WIRE_STRING = 2000;

function cap(s) {
  return typeof s === 'string' ? s.slice(0, MAX_WIRE_STRING) : '';
}

/**
 * Build the payload. Exported and pure w.r.t. its arguments so the guard suite
 * can execute it directly rather than asserting on the shape of the source
 * that renders it (v3.0.17's rule). `deps` defaults to the real registry.
 */
export function buildWriteStatus(deps = null) {
  const active = (deps && deps.listActiveWrites) || listActiveWrites;
  const anyWrites = (deps && deps.hasActiveWrites) || hasActiveWrites;
  const updating = (deps && deps.isUpdateInProgress) || isUpdateInProgress;

  const all = active() || [];
  const operations = all.slice(0, MAX_LISTED_OPERATIONS).map((a) => ({
    domain: cap(a && a.domain),
    count: Number.isFinite(a && a.count) ? a.count : 0,
    ops: Array.isArray(a && a.ops) ? a.ops.slice(0, 20).map(cap) : [],
  }));

  const activeWrites = Boolean(anyWrites());
  const updateInProgress = Boolean(updating());

  return {
    ok: true,
    // The question a quit handler actually asks. Both conditions matter: an
    // update in flight is mid `git reset --hard` + `npm install`, which is at
    // least as bad to interrupt as an ingest.
    safeToQuit: !activeWrites && !updateInProgress,
    activeWrites,
    updateInProgress,
    operations,
    operationsTotal: all.length,
  };
}

router.get('/', (_req, res) => {
  try {
    res.json(buildWriteStatus());
  } catch (err) {
    // Degrade rather than 500: a quit handler that cannot get an answer should
    // be told so explicitly, not handed an exception it will read as "busy".
    res.json({
      ok: false,
      safeToQuit: null,
      error: err && err.message ? String(err.message).slice(0, MAX_WIRE_STRING) : 'unknown',
    });
  }
});

export default router;
