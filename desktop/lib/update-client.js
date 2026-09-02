/**
 * update-client.js — the shell as a CLIENT of the app's own update route.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  THE ONE RULE THIS FILE EXISTS TO ENFORCE:                                ║
 * ║  THERE IS ONE UPDATER, AND IT IS THE SERVER'S. THE MENU DRIVES IT.        ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * ── THE DEFECT THIS FILE CLOSES ─────────────────────────────────────────────
 *
 * v3.33.0 shipped two things in one release, built by two agents:
 *
 *   · an in-app update engine — download, verify, stage, swap, relaunch —
 *     driven from Settings ▸ General, which really works and really lands
 *     without a Gatekeeper prompt;
 *   · an application menu whose "Check for Updates…" item told the user
 *     "this build does not install updates by itself" and opened a web page.
 *
 * The second sentence was TRUE when it was written (v3.31.0's check-and-tell
 * design) and became false around it. It was never rewired. The maintainer hit
 * it on the shipped v3.35.0 and said the update path was not working — from
 * the menu, it was not.
 *
 * ── WHY THIS IS AN HTTP CLIENT AND NOT A SECOND CALL INTO THE ENGINE ────────
 *
 * `main.js` holds the engine directly: it built it, and it registered
 * `prepareUpdate`/`installUpdate` into `src/brain/desktop-host.js`. Calling
 * those hooks from the menu would have been two lines. It would also have been
 * WRONG, and the reasons are all observable rather than stylistic:
 *
 *   1. `src/routes/config.js` owns the JOB RECORD — one job at a time, its
 *      state, its phase, its byte counts, its token. A menu-started download
 *      that bypassed the route would leave `GET /api/config/update-progress`
 *      reporting `job: null` while 140 MB came down. Settings ▸ General would
 *      show "no update running" during an update. Two surfaces disagreeing
 *      about whether an update is in progress is the SAME defect this file was
 *      written to fix, in a new place.
 *   2. The route owns the refusals that come BEFORE the engine — a write in
 *      flight, an update already running, no engine attached — through the
 *      app's shared `conflictResponse` shape. A second entry point would need
 *      its own copies.
 *   3. The route owns the `beginUpdate()` marker, which is what makes the
 *      shell's OWN quit dialog say "an update is being applied".
 *   4. Every failure sentence is already written once, by the side that knows
 *      what happened, and relayed by the route. This file re-authors none.
 *
 * So the menu POSTs the same two endpoints the Settings panel POSTs, in the
 * same order, and reads the same SSE stream. The consequence worth stating out
 * loud: open Settings ▸ General while a menu-started update is downloading and
 * the five-phase ring is already showing it — not because anything here draws
 * it, but because `probeInAppUpdate()` there adopts the server's running job.
 * That is the property a second engine call would have destroyed.
 *
 * ── ELECTRON-FREE AND src-FREE, LIKE EVERY MODULE IN THIS FOLDER ────────────
 *
 * Electron is deliberately not an offline-suite dependency, so `main.js` can
 * never be imported, evaluated or run by `npm test`. A guard on it can only be
 * a source scan, which proves a line was WRITTEN and nothing else — the lesson
 * this repo recorded in v3.0.17 and paid for again with the very dialog this
 * file replaces. So the whole decision surface lives here: the request order,
 * the SSE parsing, the auto-continue, the menu label, and every branch of what
 * happens when something fails. `scripts/test-desktop-menu-install.js` DRIVES
 * all of it against a fake `fetch` and a real `ReadableStream`.
 *
 * What is left in main.js is the four lines it cannot give away: two Electron
 * dialogs, `applyMenu()`, and holding the label in a variable.
 */

import { UPDATE_PHASES } from './update-plan.js';

/**
 * The three endpoints, as constants.
 *
 * Constants rather than literals for the reason `src/routes/config.js` gives
 * for `UPDATE_STAGE_HOOK`: they are a CONTRACT ACROSS FILES this module does
 * not own. `scripts/test-desktop-menu-install.js` asserts each one is a route
 * REALLY REGISTERED in `src/routes/config.js`, by reading that file — the same
 * cross-file pin `lib/menu.js` uses for `RELEASES_URL`. A typo here would
 * otherwise be a 404 the user meets as "the update could not start".
 */
export const UPDATE_CHECK_PATH = '/api/config/update-check';
export const UPDATE_PROGRESS_PATH = '/api/config/update-progress';
export const UPDATE_STAGE_PATH = '/api/config/update';
export const UPDATE_APPLY_PATH = '/api/config/update/apply';

/** How long to wait for the progress probe. Local, in-memory, no network on
 *  the server side — so this is generous only against a server still booting. */
export const PROBE_TIMEOUT_MS = 4000;

/** Refuse to parse a probe/refusal body larger than this. Same reasoning and
 *  the same number as `update-check.js`: the documented payloads are a few
 *  hundred bytes, and this is bounded headroom rather than a limit anyone
 *  should reach. */
export const MAX_BODY_BYTES = 256 * 1024;

/** No ceiling is placed on the download itself, and that is deliberate rather
 *  than an omission. A 140 MB transfer on a hotel connection legitimately
 *  takes many minutes; a timeout here would abort an update that was working
 *  and report a failure the server never had. The stream ending is the signal,
 *  and the route's own `error` event is the failure. */

/** The job states `updateJobToWire()` in `src/routes/config.js` can put on the
 *  wire. Transcribed rather than imported, because this module is src-free —
 *  and pinned by the suite against that file. */
export const JOB_STATES = Object.freeze(['running', 'applying', 'staged', 'failed']);

// ─────────────────────────────────────────────────────────────────────────────
//  The probe — "can this build install an update, and is one already going?"
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalise `GET /api/config/update-progress` into the two facts the menu
 * needs, and NOTHING else.
 *
 * `attached` is the SERVER's answer, not the shell's. The shell knows perfectly
 * well whether it registered the hooks — it is the thing that registered them —
 * and asking anyway is the point: `updaterAttached` is the same field Settings
 * reads, so the two surfaces cannot reach different conclusions about whether
 * this build can install anything. A shell-local boolean would be a second
 * answer to a question that already has one.
 *
 * `attached: null` means WE DO NOT KNOW — the probe did not answer. It is a
 * third value and never collapsed into `false`, because "there is no updater"
 * and "we could not ask" are different facts. The caller treats unknown as
 * not-installable, which is the fail-safe direction: the dialog falls back to
 * the download-page text, which is TRUE of every build.
 */
export function normaliseUpdaterProbe(body) {
  if (!body || typeof body !== 'object' || body.ok !== true) {
    return { attached: null, jobState: null, jobVersion: null };
  }
  const job = (body.job && typeof body.job === 'object') ? body.job : null;
  const state = job && JOB_STATES.includes(job.state) ? job.state : null;
  return {
    attached: body.updaterAttached === true,
    jobState: state,
    jobVersion: job && typeof job.version === 'string' && job.version ? job.version : null,
  };
}

/**
 * Ask the server. NEVER rejects and never returns null — an unanswered probe
 * is the "we do not know" record above, so a menu click cannot die on it.
 *
 * The `'fetchImpl' in deps` check rather than `deps.fetchImpl || globalThis.fetch`
 * is the v3.30.0 rule: an assertion passing `{fetchImpl: null}` must NOT fall
 * through to the real network. A caller that names the seam gets the seam,
 * even when what they named is unusable.
 */
export async function fetchUpdaterProbe(baseUrl, deps = {}) {
  const body = await getJson(baseUrl, UPDATE_PROGRESS_PATH, deps, PROBE_TIMEOUT_MS);
  return normaliseUpdaterProbe(body);
}

async function getJson(baseUrl, routePath, deps, timeoutMs) {
  const doFetch = ('fetchImpl' in deps) ? deps.fetchImpl : globalThis.fetch;
  if (typeof doFetch !== 'function') return null;
  if (typeof baseUrl !== 'string' || !baseUrl) return null;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => { try { controller && controller.abort(); } catch { /* ignore */ } }, timeoutMs);
  try {
    const res = await doFetch(`${baseUrl}${routePath}`, {
      method: 'GET',
      signal: controller ? controller.signal : undefined,
      headers: { accept: 'application/json' },
    });
    if (!res || typeof res.text !== 'function') return null;
    const text = await res.text();
    if (typeof text !== 'string' || !text.length || text.length > MAX_BODY_BYTES) return null;
    const parsed = JSON.parse(text);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  The menu label
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One label per phase.
 *
 * ── WHY THE MENU ITEM IS THE PROGRESS DISPLAY ──────────────────────────────
 *
 * It is the only surface that exists with no window open, which is the state
 * the menu is reachable from and the state ⌘W leaves behind. It is also the
 * mechanism this shell already established for the CHECK ("Checking for
 * Updates…"), so this extends a pattern rather than inventing a second one.
 *
 * The alternatives and why they lost are in `main.js`'s `runMenuInstall()`
 * docblock; the short version is that a native `showMessageBox` cannot be
 * updated once it is on screen, and the Dock progress bar needs a window.
 *
 * ── AND WHY IT REBUILDS AT MOST ~101 TIMES ─────────────────────────────────
 *
 * The engine emits a progress record every 256 KB — about 550 of them over a
 * 140 MB download — and rebuilding the whole application menu 550 times would
 * be a lot of work to show a number that mostly did not change. The label
 * itself is the throttle: it carries a WHOLE percent, so it changes at most
 * 101 times, and `runInstall` only calls back when the string actually
 * differs. That is asserted by driving 550 real progress events and counting
 * the callbacks, not by reading this comment.
 */
export const INSTALL_LABEL_START = 'Downloading Update…';

/**
 * What the menu says between the click and the first progress record, and for
 * a phase name this shell has no sentence for.
 *
 * It is deliberately NOT "Downloading Update…". An apply-only run downloads
 * nothing — the bundle is already on disk — so a frame saying *Downloading*
 * would be a frame that is false, however briefly it is on screen. And an
 * unrecognised phase is a thing we cannot describe, which is a different claim
 * from a thing we can: the same fact-versus-its-absence rule this project
 * applies to `percent`.
 */
export const UPDATE_LABEL_PENDING = 'Updating…';

export function updateMenuLabel(job) {
  const j = (job && typeof job === 'object') ? job : {};
  const phase = UPDATE_PHASES.includes(j.phase) ? j.phase : null;
  if (phase === 'downloading') {
    // `percent` is `null`, never a number, when the total is unknown — the
    // route's own rule. So the label says what IS known (the bytes) rather
    // than rendering a 0% that is a different claim from "we cannot tell".
    if (typeof j.percent === 'number' && Number.isFinite(j.percent)) {
      return `Downloading Update… ${Math.max(0, Math.min(100, Math.floor(j.percent)))}%`;
    }
    if (typeof j.receivedBytes === 'number' && Number.isFinite(j.receivedBytes) && j.receivedBytes > 0) {
      return `Downloading Update… ${megabytes(j.receivedBytes)}`;
    }
    return INSTALL_LABEL_START;
  }
  if (phase === 'resolving') return 'Finding the Update…';
  if (phase === 'verifying') return 'Checking the Download…';
  if (phase === 'staging') return 'Preparing the Update…';
  if (phase === 'installing') return 'Installing Update…';
  return UPDATE_LABEL_PENDING;
}

/** Whole MB above 10, one decimal below — the same shape the Settings panel's
 *  progress line uses. Never a bare byte count: nobody reads 61,341,696. */
function megabytes(bytes) {
  const mb = bytes / (1024 * 1024);
  return mb >= 10 ? `${Math.round(mb)} MB` : `${Math.round(mb * 10) / 10} MB`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Server-sent events
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Split a buffer into complete SSE frames. PURE, and total.
 *
 * Written as its own function because the interesting failure is a frame split
 * across two network reads, which is invisible to a test that feeds one whole
 * string. The suite drives a stream chopped at every single byte boundary and
 * asserts the same events come out.
 *
 * @returns {{events: Array<{type:string, data:object|null}>, rest: string}}
 */
export function parseSseFrames(buffer) {
  const events = [];
  let buf = typeof buffer === 'string' ? buffer : '';
  for (;;) {
    const idx = buf.indexOf('\n\n');
    if (idx === -1) break;
    const frame = buf.slice(0, idx);
    buf = buf.slice(idx + 2);
    let type = 'message';
    let payload = '';
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) type = line.slice(6).trim();
      else if (line.startsWith('data:')) payload += line.slice(5).trim();
    }
    if (!payload) continue;
    let data = null;
    try { data = JSON.parse(payload); } catch { data = null; }
    if (data === null) continue;
    events.push({ type, data });
  }
  return { events, rest: buf };
}

// ─────────────────────────────────────────────────────────────────────────────
//  The outcome
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every outcome of an install attempt, as data.
 *
 * `ok: true` means the swap helper has been handed off and this process is
 * going away — there is nothing left to show and no dialog to show it in.
 *
 * `ok: false` always carries `error`, which is A SENTENCE WRITTEN BY THE SERVER
 * (relayed from the engine's own 36-entry table, or from the route's shared
 * refusal shapes). This module authors exactly ONE sentence of its own — the
 * one below — for the case the server cannot describe because it never
 * answered.
 *
 * `staged: true` is the interesting one: the bytes are downloaded and verified
 * and sitting beside the running app, and only the SWAP was refused. The honest
 * thing to say then is not "the update failed" but "it is downloaded and one
 * step away", and the offer is to finish it rather than to start again.
 */
/**
 * Does THIS action mean "finish what is already downloaded" rather than "start
 * a download"?
 *
 * Exported as a function, and consulted at both call sites, because of a
 * mutation that came back GREEN: with the decision written as a literal in
 * `main.js`'s retry loop, flipping it to `false` — which makes clicking
 * *Install Now* after a write-in-flight refusal re-download 140 MB that is
 * already verified on disk — changed nothing any suite could see. `main.js`
 * cannot be executed by `npm test`, so a decision that lives there can only
 * ever be grepped. This one now lives here instead.
 *
 * `install-staged` is produced by TWO different dialogs — the check's, when
 * the server's job record already says `staged`, and the failure dialog's,
 * when the swap was refused — and both mean the same thing to the engine.
 * Anything else, including a malformed action, means start from the top: the
 * fail-safe direction is a download that was not needed, never a swap of
 * something that was never verified.
 */
export function applyOnlyForAction(action) {
  return Boolean(action && typeof action === 'object' && action.type === 'install-staged');
}

export const CLIENT_UNREACHABLE =
  'The Curator could not reach its own server to start the update. Nothing on this Mac was changed.';

export const STREAM_INTERRUPTED =
  'The connection to the update carried on this Mac ended before the download finished. Nothing was replaced, ' +
  'so this copy of The Curator still works. Try again.';

function failure({ staged = false, reason, error, hint = null, releasesPageUrl = null, version = null }) {
  return { ok: false, staged, reason, error, hint, releasesPageUrl, version };
}

// ─────────────────────────────────────────────────────────────────────────────
//  runInstall — the whole thing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Download, verify, stage, install, restart — by driving the app's own route.
 *
 * ── THE AUTO-CONTINUE, AND WHY IT IS SAFE ──────────────────────────────────
 *
 * `staged` is not `done`. When the stream reaches it this function POSTs
 * `/update/apply` without asking again, for the reason `settings.js` gives for
 * the identical step: the user agreed at the dialog, and stopping to ask a
 * second time after the only long part is over is ceremony, not consent.
 *
 * It is safe even if they have wandered off, and the safety is the SERVER's,
 * not a guess made here: `POST /update/apply` re-checks `hasActiveWrites()` at
 * the moment of the swap. An ingest that started during the download is not
 * truncated — the finish is refused, this returns `staged: true`, and the
 * dialog says the update is downloaded and one click away. Nothing here routes
 * around that check, and nothing here duplicates it.
 *
 * ── `applyOnly` ────────────────────────────────────────────────────────────
 *
 * Skips straight to the swap. Two callers: the menu when the server's probe
 * already reports a staged job (so a second 140 MB download is not started for
 * a build that is already on disk), and the "Install Now" retry after a
 * write-in-flight refusal.
 *
 * @param {string} baseUrl
 * @param {{applyOnly?: boolean, onLabel?: Function, onProgress?: Function}} [opts]
 *        `onLabel` is called ONLY when the menu label actually changes.
 *        `onProgress` is called for EVERY record, with the record itself — see
 *        `emit()` below for why the two throttles differ. v3.41.0's updater
 *        window is its one consumer.
 * @param {{fetchImpl?: Function}} [deps]
 * @returns {Promise<object>} never rejects
 */
export async function runInstall(baseUrl, opts = {}, deps = {}) {
  try {
    return await runInstallInner(baseUrl, opts, deps);
  } catch (err) {
    // Nothing below is expected to throw. If it does, the app is still running
    // — which is itself the proof that nothing was replaced — so say so rather
    // than leaving a menu item stuck on "Downloading Update…".
    return failure({
      reason: 'internal-error',
      error: 'Something went wrong while updating, so nothing on this Mac was changed. Try again, or download ' +
             'the update from the releases page.',
      hint: (err && err.message) ? String(err.message).slice(0, 200) : null,
    });
  }
}

async function runInstallInner(baseUrl, opts, deps) {
  const doFetch = ('fetchImpl' in deps) ? deps.fetchImpl : globalThis.fetch;
  if (typeof doFetch !== 'function' || typeof baseUrl !== 'string' || !baseUrl) {
    return failure({ reason: 'offline', error: CLIENT_UNREACHABLE });
  }

  const rawLabel = typeof opts.onLabel === 'function' ? opts.onLabel : null;
  const rawProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  let lastLabel = null;

  /**
   * One emission point for both sinks, and they are DELIBERATELY THROTTLED
   * DIFFERENTLY.
   *
   * `onLabel` fires only when the menu item's whole string changes, because
   * rebuilding the application menu is real work and the label carries a whole
   * percent — about 101 rebuilds over a 140 MB download rather than 550.
   *
   * `onProgress` fires on EVERY record, unthrottled, because it is a raw
   * feed for a caller that has its own idea of what "changed" means: v3.41.0's
   * updater window turns it into a Dock progress bar, which it throttles by
   * VALUE, and into a one-shot restart notification keyed on the phase
   * transition — a transition a label-shaped throttle would hide whenever two
   * neighbouring phases happened to render the same string. Throttling here
   * would push a second policy onto every future consumer.
   *
   * Neither sink may break an update. Both are wrapped, the same rule the
   * engine applies to its own `onProgress`.
   */
  const emit = (job) => {
    if (rawProgress) {
      try { rawProgress(job); } catch { /* a progress display is not load-bearing */ }
    }
    if (!rawLabel) return;
    const next = updateMenuLabel(job);
    if (next === lastLabel) return;
    lastLabel = next;
    try { rawLabel(next); } catch { /* the menu is not load-bearing */ }
  };

  let version = null;

  if (opts.applyOnly !== true) {
    emit({ phase: 'resolving' });

    let res;
    try {
      res = await doFetch(`${baseUrl}${UPDATE_STAGE_PATH}`, {
        method: 'POST',
        headers: { accept: 'text/event-stream' },
      });
    } catch {
      return failure({ reason: 'offline', error: CLIENT_UNREACHABLE });
    }

    // Every refusal on this route is plain JSON sent BEFORE any SSE header —
    // the 409s (a write in flight, an update already running) and the 501 (no
    // engine attached) — so each one is readable here in full, with a `reason`
    // and a sentence already written for a person.
    if (!res || res.ok !== true || !res.body) {
      const body = await readJsonBody(res);
      return failure({
        reason: (body && body.reason) || 'unknown',
        error: (body && body.error)
          || `The update could not start (HTTP ${res && res.status ? res.status : '?'}).`,
        hint: body && body.hint,
        releasesPageUrl: body && body.releasesPageUrl,
      });
    }

    const streamed = await readStagingStream(res.body, emit);
    if (streamed.error) {
      return failure({
        reason: streamed.error.reason || 'unknown',
        error: streamed.error.error || STREAM_INTERRUPTED,
        hint: streamed.error.hint,
        releasesPageUrl: streamed.error.releasesPageUrl,
      });
    }
    if (!streamed.staged) {
      // The stream ended with neither `staged` nor `error`: the server hung up
      // mid-download. Reported as its own thing rather than left on a label
      // that will never move again.
      return failure({ reason: 'interrupted', error: STREAM_INTERRUPTED });
    }
    version = streamed.version;
  }

  // ── The swap. ────────────────────────────────────────────────────────────
  // The version rides along so a consumer of `onProgress` does not have to keep
  // its own copy of what the stream already told this function. `updateMenuLabel`
  // reads neither field, so the menu label is byte-identical to v3.36.0's.
  emit({ phase: 'installing', version });

  let applyRes;
  try {
    applyRes = await doFetch(`${baseUrl}${UPDATE_APPLY_PATH}`, {
      method: 'POST',
      headers: { accept: 'application/json' },
    });
  } catch {
    // THE PROCESS GOING AWAY MID-REQUEST IS THE SUCCESS CASE — the swap
    // happened and the app is quitting under us. `settings.js` treats the same
    // rejection the same way, and for the same reason. There is nothing left
    // to draw and nobody left to draw it for.
    return { ok: true, installing: true, version };
  }

  if (applyRes && applyRes.ok === true) {
    // Reached only if the shell chose not to end the process — the route says
    // so itself. Still a success.
    return { ok: true, installing: true, version };
  }

  const body = await readJsonBody(applyRes);
  return failure({
    // STAGED, not failed. The verified bundle is still on disk and still
    // installable, so the honest state is "downloaded, not yet in place" and
    // the offer that follows is to finish it rather than to start over. The
    // route holds exactly the same view — `applyFailed()` puts its own job
    // record back to `staged`.
    staged: true,
    reason: (body && body.reason) || 'install-failed',
    error: (body && body.error)
      || `The update could not be installed (HTTP ${applyRes && applyRes.status ? applyRes.status : '?'}).`,
    hint: body && body.hint,
    releasesPageUrl: body && body.releasesPageUrl,
    version,
  });
}

/** Read a refusal body. Never throws; a body that cannot be read is `null`,
 *  which the caller renders as its own sentence rather than as an empty one. */
async function readJsonBody(res) {
  if (!res || typeof res.text !== 'function') return null;
  try {
    const text = await res.text();
    if (typeof text !== 'string' || !text.length || text.length > MAX_BODY_BYTES) return null;
    const parsed = JSON.parse(text);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Consume the SSE stream to its end.
 *
 * The reader is CANCELLED in a `finally` so the socket cannot be left open
 * when this returns early — but note what cancelling does NOT do: it does not
 * cancel the update. The route has no `req.on('close')` handler, deliberately,
 * because a 140 MB download that dies because someone closed a window is a
 * worse outcome than one that finishes unwatched.
 */
async function readStagingStream(body, emit) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let staged = false;
  let version = null;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const { events, rest } = parseSseFrames(buf);
      buf = rest;
      for (const ev of events) {
        if (ev.type === 'progress') {
          emit(ev.data);
        } else if (ev.type === 'staged') {
          staged = true;
          version = typeof ev.data.version === 'string' ? ev.data.version : null;
        } else if (ev.type === 'error') {
          return { staged: false, version: null, error: ev.data };
        }
        // An unrecognised event type is IGNORED rather than treated as a
        // failure. The route's event list is documented and asserted, and a
        // shell that fell over on a future keep-alive frame would be a
        // needlessly brittle client of a stream it does not own.
      }
    }
  } catch {
    return { staged: false, version: null, error: { reason: 'interrupted', error: STREAM_INTERRUPTED } };
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
  return { staged, version, error: null };
}
