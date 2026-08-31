/**
 * decideQuit() — what a desktop quit handler should do about `GET /api/write-status`.
 *
 * ── Why this is a separate, electron-free module ────────────────────────────
 *
 * Nothing in `desktop/` can be EXECUTED by this repo's test suite: Electron is
 * deliberately not installed (see desktop/README.md), so `main.js` cannot be
 * imported offline. A guard that can only source-scan `main.js` is exactly the
 * shape CLAUDE.md warns about — "assert behaviour, not the presence of a line
 * of source" (v3.0.17).
 *
 * So the decision itself lives here, importing nothing from Electron and
 * nothing from `src/`. `scripts/test-desktop-packaging.js` RUNS it. `main.js`
 * only wires it to a dialog. The part that can be proven offline is proven
 * offline; the part that needs a window is named in the suite's NOT ENFORCED
 * block rather than pretended.
 *
 * ── The three-way answer, and why `null` is its own case ────────────────────
 *
 * `src/routes/write-status.js` answers `safeToQuit: null` when the write
 * registry throws, and its docblock states the contract explicitly: "a quit
 * handler that cannot get an answer should be told so explicitly, not handed
 * an exception it will read as 'busy'". A boolean return here would have to
 * collapse that third state into one of the other two, and BOTH collapses are
 * wrong in a way the user pays for:
 *
 *   null → treated as SAFE   an ingest is a paid, multi-minute write. Silently
 *                            truncating one because a counter threw is the
 *                            single most expensive outcome available here.
 *
 *   null → treated as BUSY   a registry that throws does not heal on its own.
 *                            The app becomes un-quittable by ⌘Q, forever, with
 *                            no explanation — and the user reaches for Force
 *                            Quit, which truncates the write anyway AND skips
 *                            every other shutdown step.
 *
 * So `null` returns 'ask': stop, say plainly that the app could not determine
 * whether a write is in progress, and let the human decide. That is what
 * v3.29.0 means by "unknown fails CLOSED" applied to an interactive surface —
 * closed against proceeding SILENTLY, not closed against proceeding at all. A
 * gate with no human in front of it must refuse; a gate with a human in front
 * of it must ask, because refusing forever is not a safe state either.
 *
 * A transport failure (server not up, fetch timed out, malformed JSON) is the
 * SAME epistemic state — "no answer" — and returns 'ask' for the same reason.
 * It is reported with a different `reason` so the dialog can say which.
 *
 * ── What 'ask' is NOT ───────────────────────────────────────────────────────
 *
 * 'ask' is not a softer 'block'. `activeWrites === true` also returns 'ask',
 * because a desktop app that refuses ⌘Q outright is broken; the difference is
 * that the busy case can NAME what is running and the unknown case cannot.
 * There is deliberately no 'block' action at all: every non-quit answer here
 * ends in a dialog the user can resolve. What changes is the default button
 * and the sentence.
 */

/** Cap on how many operation lines a dialog should be handed. */
export const MAX_DIALOG_OPERATIONS = 8;

/**
 * @typedef {Object} QuitDecision
 * @property {'quit'|'ask'} action     'quit' = tear down now; 'ask' = show a dialog.
 * @property {'safe'|'active-writes'|'update-in-progress'|'unknown-registry'|'unreachable'|'malformed'} reason
 * @property {string}  detail          One human sentence. Never a stack trace.
 * @property {string[]} operations     Zero or more "domain — op, op" lines, capped.
 * @property {number}  operationsTotal The TRUE total, which may exceed operations.length.
 * @property {boolean} defaultIsQuit   Which button a dialog should default to.
 */

function opLines(status) {
  const raw = Array.isArray(status && status.operations) ? status.operations : [];
  return raw.slice(0, MAX_DIALOG_OPERATIONS).map((o) => {
    const domain = o && typeof o.domain === 'string' && o.domain ? o.domain : '(unnamed)';
    const ops = Array.isArray(o && o.ops) ? o.ops.filter((x) => typeof x === 'string') : [];
    return ops.length ? `${domain} — ${ops.join(', ')}` : domain;
  });
}

/**
 * @param {any} status  The parsed body of GET /api/write-status, or null/undefined
 *                      when the request failed, timed out, or did not parse.
 * @returns {QuitDecision}
 */
export function decideQuit(status) {
  // No answer at all — the request never completed. Same epistemic state as a
  // null safeToQuit, different sentence.
  if (status === null || status === undefined) {
    return {
      action: 'ask',
      reason: 'unreachable',
      detail: 'The Curator could not be reached to check whether a write is in progress.',
      operations: [],
      operationsTotal: 0,
      defaultIsQuit: false,
    };
  }

  // Something came back that is not the documented shape. Do NOT guess.
  if (typeof status !== 'object' || Array.isArray(status) || !('safeToQuit' in status)) {
    return {
      action: 'ask',
      reason: 'malformed',
      detail: 'The write-status check returned an unexpected response, so it is not known whether a write is in progress.',
      operations: [],
      operationsTotal: 0,
      defaultIsQuit: false,
    };
  }

  const { safeToQuit } = status;

  // The registry threw. The route says so honestly; do not launder it.
  if (safeToQuit === null) {
    return {
      action: 'ask',
      reason: 'unknown-registry',
      detail: 'The Curator could not determine whether a write is in progress.',
      operations: [],
      operationsTotal: 0,
      defaultIsQuit: false,
    };
  }

  if (safeToQuit === true) {
    return {
      action: 'quit',
      reason: 'safe',
      detail: 'No writes in progress.',
      operations: [],
      operationsTotal: 0,
      defaultIsQuit: true,
    };
  }

  // safeToQuit === false, or any other non-boolean value that is not null.
  // An unexpected literal (a string, a number, an object) is treated as "not
  // safe and not explained" rather than coerced — `Boolean('false')` is true,
  // which is precisely how a truthiness check would decide it is fine to quit.
  if (safeToQuit !== false) {
    return {
      action: 'ask',
      reason: 'malformed',
      detail: 'The write-status check returned an unexpected value for safeToQuit.',
      operations: [],
      operationsTotal: 0,
      defaultIsQuit: false,
    };
  }

  // An update in flight is mid `git reset --hard` + `npm install`. Reported
  // separately from an ingest because the remedy the user needs is different:
  // an ingest can be re-run for money, a half-applied update cannot be
  // "re-run" at all.
  if (status.updateInProgress === true) {
    return {
      action: 'ask',
      reason: 'update-in-progress',
      detail: 'An update is being applied. Quitting now can leave the app half-updated.',
      operations: [],
      operationsTotal: 0,
      defaultIsQuit: false,
    };
  }

  const operations = opLines(status);
  const total = Number.isFinite(status.operationsTotal)
    ? status.operationsTotal
    : operations.length;

  return {
    action: 'ask',
    reason: 'active-writes',
    detail: 'A write to your wiki is in progress. Quitting now can lose work you have paid for.',
    operations,
    // The TRUE total rides alongside the capped list — v3.17.0's rule that a
    // cap must never be reported as a measurement.
    operationsTotal: total,
    defaultIsQuit: false,
  };
}
