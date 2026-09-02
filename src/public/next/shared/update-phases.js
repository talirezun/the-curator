// Shared: update-phases.js — the ONE source of the update's phase vocabulary,
// its ring-position mapping and its byte formatting.
//
// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║  WHY THIS FILE EXISTS: TWO SURFACES NOW DRAW THE SAME UPDATE.             ║
// ╚═══════════════════════════════════════════════════════════════════════════╝
//
// Until v3.41.0 there was one: Settings ▸ General, whose five-phase ring these
// functions were written inside. The menu-bar path had no progress display at
// all beyond the menu item's own label — the maintainer ran the first real
// in-app update from the menu bar and reported that between clicking Update
// and the app restarting, nothing visible happened.
//
// v3.41.0 gives that path a small dedicated updater window, and that window
// draws the SAME ring. Two surfaces drawing one operation is precisely the
// shape this project keeps paying for: v3.36.0's whole story is a menu and a
// settings panel that disagreed about whether this build could install
// anything, and each half passed its own tests. So the wording, the phase
// order and the number formatting were MOVED here rather than copied.
// `views/settings.js` and `views/update-window.js` both import this file, and
// there is no second copy for a future edit to update only half of.
//
// ── WHAT IS *NOT* SHARED, AND WHY IT IS ONE NAMED OVERRIDE ─────────────────
//
// Exactly one sentence differs between the two surfaces, and it differs
// because it is FALSE on one of them: the panel's `installing` body ends
// "…and this page reloads itself", which the Settings page really does. The
// updater window cannot — it is a child of the process being replaced and goes
// away with it. So `UPDATE_WINDOW_BODY` below overrides that ONE phase, IN
// THIS FILE, where both sentences sit side by side and the difference is
// visible, rather than in the window where it would be an unmarked second
// copy. `scripts/test-update-window.js` asserts the override set is exactly
// {installing} and that every other phase's window body is byte-identical to
// the panel's.
//
// ── DOM-FREE AND FETCH-FREE ────────────────────────────────────────────────
//
// Every export below is a pure function or a plain table, so the suites IMPORT
// this module and execute it rather than extracting it out of a view with a
// regex — which is how `test-update-in-app.js` reached these functions while
// they lived inside settings.js, a technique that silently splices an EMPTY
// STRING into its sandbox the day a function is renamed.

/** The five phases the server may report, in order. Duplicated from
 *  `UPDATE_PHASES` in src/routes/config.js rather than imported, for the same
 *  reason `compareSemver` is duplicated at the top of this file: this is
 *  browser ESM served to the client and that is a server route. The suite
 *  asserts the two lists are identical AND in the same order — which is the
 *  only thing that makes duplicating it safe. */
export const UPDATE_PHASE_ORDER = ['resolving', 'downloading', 'verifying', 'staging', 'installing'];

/** The outer ring's segment names. SHORTER than the phase names: a five-
 *  segment ring is 48px across and the full sentence is already the ring's
 *  label, so these only have to be distinguishable from each other. */
export const UPDATE_RING_STAGES = ['Finding', 'Downloading', 'Checking', 'Preparing', 'Installing'];

/**
 * One sentence per phase, in the user's terms rather than the engine's.
 *
 * `headline` is the state; `body` says what is happening to their machine.
 * The two that matter most are `verifying` and `staging`: both are fast and
 * neither reports sub-progress, so their ring segments sit EMPTY while they
 * run and the sentence is the only thing carrying the information. That is
 * deliberate — see updateRingPosition below.
 */
export const UPDATE_PHASE_COPY = {
  resolving:   { headline: 'Preparing the update',  body: 'Finding the download for the new version.' },
  // NOT "or sync". `isUpdateInProgress()` is what gates a start during an
  // update, and it is checked by ingest, compile, Health and Shared Brain —
  // NOT by sync, whose `guardConcurrent` tests `hasActiveWrites()` only, a
  // flag the updater never sets. Naming sync here promised a hold the app
  // does not apply.
  downloading: { headline: 'Downloading',           body: 'The download keeps going if you switch to another screen. A new ingest won’t start until the update finishes.' },
  // WHAT IS ACTUALLY CHECKED IS INTEGRITY, NOT APPLE'S BLESSING. The engine
  // compares a sha256 against the digest GitHub publishes for the asset, plus
  // the byte length, the staged bundle's version, and `codesign --verify`.
  // Authenticity rests on that digest and on TLS to GitHub — nothing here can
  // say Apple vouched for the build, so nothing here says so.
  verifying:   { headline: 'Checking the download', body: 'Confirming the file arrived complete and unaltered, and that the app inside it is intact. Nothing has been replaced yet.' },
  staging:     { headline: 'Preparing to install',  body: 'Unpacking the new version beside the one you are running. Nothing has been replaced yet.' },
  installing:  { headline: 'Installing',            body: 'Putting the new version in place. The Curator restarts on its own, and this page reloads itself.' },
};

/**
 * THE ONE PHASE WHOSE BODY DIFFERS BY SURFACE, and it differs because the
 * panel's version is not true in the other place.
 *
 * `UPDATE_PHASE_COPY.installing.body` promises "…and this page reloads
 * itself". Settings ▸ General really does that — `finishInAppUpdate()` polls
 * for the new server and reloads the page. The updater window cannot make that
 * promise about itself: it belongs to the process being swapped out, so it
 * disappears, and what comes back is the app's own main window.
 *
 * Kept HERE, beside the sentence it replaces, rather than inside the window —
 * a per-surface string living in the surface is exactly the second copy this
 * module exists to abolish. Anything ABSENT from this table falls through to
 * the shared body, so a phase added later is shared by default and has to be
 * opted out of sharing deliberately.
 */
export const UPDATE_WINDOW_BODY = {
  installing: 'Putting the new version in place. The Curator will restart on its own.',
};

/**
 * The copy for one phase, on one surface. `surface` is 'panel' (Settings ▸
 * General) or 'window' (the menu-bar updater window). Anything else is treated
 * as the panel, which is the surface whose wording has shipped for releases.
 *
 * TOTAL: an unknown phase — including `null`, which is what the job record
 * carries before the engine has reported anything — falls back to `resolving`
 * rather than returning undefined, because a progress display with no sentence
 * at all is worse than one showing the first phase. That fallback is the
 * panel's own pre-existing expression
 * (`UPDATE_PHASE_COPY[job.phase] || UPDATE_PHASE_COPY.resolving`), moved here
 * so both surfaces inherit one answer instead of each writing their own.
 */
export function phaseCopy(phase, surface) {
  const base = (phase !== null && phase !== undefined && Object.hasOwn(UPDATE_PHASE_COPY, phase))
    ? UPDATE_PHASE_COPY[phase]
    : UPDATE_PHASE_COPY.resolving;
  if (surface !== 'window') return { headline: base.headline, body: base.body };
  const over = Object.hasOwn(UPDATE_WINDOW_BODY, phase) ? UPDATE_WINDOW_BODY[phase] : null;
  return { headline: base.headline, body: over === null ? base.body : over };
}

/**
 * Map a job snapshot onto the progress ring's `{stage, stageProgress}`.
 *
 * ── THE HONESTY RULE, AND WHY AN EMPTY SEGMENT IS NOT A BUG ──────────────
 *
 * `stageProgress` is derived from the DOWNLOAD PERCENTAGE and from nothing
 * else, and only for the `downloading` phase. Every other phase returns 0, so
 * its segment stays visibly empty for as long as it runs.
 *
 * That is the point. `resolving`, `verifying` and `staging` report no
 * sub-progress because they genuinely have none — each is a single HTTP call,
 * a single hash, a single move. A bar creeping across them would be inventing
 * a duration nobody measured. progress-ring.js's own header states the same
 * rule from the other side ("a segment fills only when that stage genuinely
 * advances… that is CORRECT, not a bug to paper over"), and the orbit inside
 * the ring carries the liveness while a segment is honestly empty.
 *
 * A `downloading` phase with an UNKNOWN total (no `content-length`) also
 * returns 0 rather than a guess: `percent` is null there, and null is a
 * different fact from zero.
 */
export function updateRingPosition(job) {
  const j = job || {};
  const idx = UPDATE_PHASE_ORDER.indexOf(j.phase);
  const stage = idx >= 0 ? idx : 0;
  const pct = typeof j.percent === 'number' && isFinite(j.percent) ? j.percent : null;
  const stageProgress = (j.phase === 'downloading' && pct !== null)
    ? Math.max(0, Math.min(1, pct / 100))
    : 0;
  return { stage, stageProgress };
}

/**
 * Bytes → "136.4 MB". Binary units, one decimal, because that is what macOS
 * and every browser download shelf show — a user comparing the two should not
 * have to reconcile them.
 *
 * Returns null for anything that is not a real byte count, so a caller can
 * tell "no size reported" from "zero bytes" and say different things.
 */
export function formatBytes(n) {
  if (typeof n !== 'number' || !isFinite(n) || n < 0) return null;
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  // One decimal below 100, whole numbers above: "58.2 MB of 137 MB" reads as a
  // download in progress, while "58.16 MB" reads as a measurement nobody asked
  // for and "58 MB" stops moving for a second at a time on a slow connection —
  // which is the thing a progress line exists to disprove.
  return (v < 100 ? v.toFixed(1) : String(Math.round(v))) + ' ' + units[u];
}

/**
 * The monospace second line under the ring — the numbers.
 *
 * THREE OUTCOMES, NEVER COLLAPSED (this repo's rule that a fact and its
 * absence never share a presentation):
 *
 *   both counts known   "58.2 MB of 136.4 MB · 43%"
 *   total unknown       "58.2 MB downloaded · total size unknown"
 *   nothing reported    null — the caller renders no line at all, rather than
 *                       a reassuring "0 MB of 0 MB"
 *
 * The percentage appears only alongside the two numbers it is derived from, so
 * the line cannot contradict itself.
 */
export function updateProgressSublabel(job) {
  const j = job || {};
  if (j.phase !== 'downloading') return null;
  const got = formatBytes(j.receivedBytes);
  if (got === null) return null;
  const total = formatBytes(j.totalBytes);
  if (total === null) return got + ' downloaded · total size unknown';
  const pct = typeof j.percent === 'number' && isFinite(j.percent) ? Math.round(j.percent) : null;
  return got + ' of ' + total + (pct === null ? '' : ' · ' + pct + '%');
}
