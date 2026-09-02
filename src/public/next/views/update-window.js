// views/update-window.js — the page inside the small "Software Update" window
// the menu-bar update path opens.
//
// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║  THIS PAGE IS A READER. IT STARTS NOTHING AND IT FINISHES NOTHING.        ║
// ╚═══════════════════════════════════════════════════════════════════════════╝
//
// It issues exactly one kind of request, `GET /api/config/update-progress`,
// which is READ-ONLY, in-memory, no lock, no filesystem and no network on the
// server side. It never POSTs. It has no button.
//
// That is the whole reason the window is safe to add, and it is a direct
// answer to the objection `desktop/main.js` recorded when it rejected
// switching the main window to Settings: *the auto-continue to the restart
// lives in the client that STARTED the stream, so a panel that merely adopted
// the job would stop at "downloaded" and wait for a second click the user was
// never told about.* Still true — which is why this page does not adopt
// anything. `runInstall` in `desktop/lib/update-client.js` drives the SSE
// stream and POSTs `/update/apply` itself, exactly as it has since v3.36.0.
// This page watches the same job record from the outside.
//
// A second POST from here would be worse than useless: `POST /update` would be
// refused with a 409 (an update is already running) and `POST /update/apply`
// would race the shell's own apply. Neither is possible, because neither is
// written. `scripts/test-update-window.js` asserts it TWICE — once by driving
// the poll loop against a recording fetch and reading the request list, and
// once as a source scan, because the two catch different mistakes.
//
// ── WHAT IT DRAWS, AND WHY NONE OF IT IS ITS OWN VOCABULARY ────────────────
//
// The five-phase ring, the phase headline, the phase sentence and the byte
// line all come from `shared/progress-ring.js` and `shared/update-phases.js` —
// the same modules `views/settings.js` renders the same job with. Nothing
// about the update's wording is authored in this file. See update-phases.js's
// header for the one sentence that legitimately differs and why it lives
// there rather than here.
//
// ── THE TWO THINGS THIS PAGE DOES SAY FOR ITSELF ───────────────────────────
//
// `starting` and `lost` are facts about THIS PAGE'S OWN CONNECTION, not claims
// about the update, and they are worded so they cannot be read as either:
//
//   starting  the window opened before the shell's POST created a job record,
//             so `job` is null. That is an ordinary few hundred milliseconds.
//             It does NOT render as `resolving`, because "we are finding the
//             download" would be a claim about work nobody has reported yet —
//             the same fact-versus-absence rule the route applies to `percent`.
//
//   lost      the poll stopped answering BEFORE the update reached
//             `installing`. Once `installing` HAS been seen, a dead server is
//             the expected and successful case — it means the swap happened
//             and this process is being replaced — so it is rendered as
//             `installing` and the polling stops. Collapsing those two would
//             mean either an alarming red box on every successful update, or a
//             reassuring "installing" on a server that crashed.
//
// ── DOM-FREE UNTIL `mountUpdateWindow()` IS CALLED ─────────────────────────
//
// Every decision below is a pure function over a snapshot, and the only DOM
// and `fetch` work is inside `mountUpdateWindow` / `startUpdateWindow`, whose
// dependencies are injected. So `npm test` IMPORTS this module and executes
// the real functions rather than extracting them with a regex.

import { progressRingHtml } from '../shared/progress-ring.js';
import {
  UPDATE_RING_STAGES, phaseCopy, updateRingPosition, updateProgressSublabel,
} from '../shared/update-phases.js';

/** The one endpoint. A constant so the suite can pin it against the
 *  `router.get()` registration in `src/routes/config.js` — the same cross-file
 *  technique `desktop/lib/update-client.js` uses for its four paths. */
export const PROGRESS_URL = '/api/config/update-progress';

/** How often to ask. Faster than Settings' 1500 ms re-attach poll because this
 *  window has exactly one job and the answer costs the server a JSON
 *  serialisation of a dozen fields — no lock, no I/O. Slower than a frame:
 *  the number it draws changes every 256 KB of a 140 MB download, and a
 *  display that re-renders faster than its data changes is just churn. */
export const POLL_MS = 900;

/** How many consecutive unanswered polls before saying so. Three rather than
 *  one, because a single missed poll during a heavy download is ordinary and
 *  an alarm that cries wolf on a working update is worse than a slightly late
 *  one. */
export const LOST_AFTER_MISSES = 3;

/** Local rather than imported from `../app.js`, which is where the shell's own
 *  `escapeHtml` lives: importing it would evaluate the entire single-page
 *  application — its router, its rail, its localStorage reads — inside a
 *  380-point window that shows one ring. Five lines of duplication against
 *  booting a second copy of the app is not a close call. */
export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * The page's whole state, as one pure transition.
 *
 * @param {{seenInstalling:boolean, misses:number, kind:string, job:object|null, failure:object|null}} prev
 * @param {{ok:boolean, body:object|null}} poll  one answer from the endpoint;
 *        `ok:false` means the request did not produce a usable body at all.
 * @returns the next state, same shape. NEVER throws, and never returns null.
 *
 * `done` is terminal in both directions: `installing` (the app is going away)
 * and `failed` (the shell is showing a dialog about it) both stop the polling,
 * because there is nothing further this window can learn.
 */
export function nextUpdateView(prev, poll) {
  const p = (prev && typeof prev === 'object') ? prev : {};
  const state = {
    kind: typeof p.kind === 'string' ? p.kind : 'starting',
    job: (p.job && typeof p.job === 'object') ? p.job : null,
    failure: (p.failure && typeof p.failure === 'object') ? p.failure : null,
    seenInstalling: p.seenInstalling === true,
    misses: Number.isFinite(p.misses) ? p.misses : 0,
    done: p.done === true,
  };
  if (state.done) return state;

  const answered = Boolean(poll && poll.ok === true && poll.body && typeof poll.body === 'object');
  if (!answered) {
    // THE SUCCESS CASE AND THE FAILURE CASE ARE THE SAME NETWORK EVENT, and
    // only the phase already seen can tell them apart. See the header.
    if (state.seenInstalling) return { ...state, kind: 'running', done: true };
    const misses = state.misses + 1;
    if (misses < LOST_AFTER_MISSES) return { ...state, misses };
    return { ...state, misses, kind: 'lost', done: true };
  }

  state.misses = 0;
  const job = (poll.body.job && typeof poll.body.job === 'object') ? poll.body.job : null;

  // No job record yet — the shell's POST has not landed. Not `resolving`.
  if (!job) return { ...state, kind: state.seenInstalling ? 'running' : 'starting', job: null };

  if (job.state === 'failed') {
    return {
      ...state,
      kind: 'failed',
      job: null,
      // Relayed WHOLESALE from the route, which relayed it from the engine's
      // own named-reason table. This file authors no failure sentence, and
      // `reason` is deliberately not rendered — a slug beside a sentence is an
      // internal identifier shown to a person.
      failure: { error: job.error || null, hint: job.hint || null },
      done: true,
    };
  }

  const seenInstalling = state.seenInstalling || job.phase === 'installing';
  return { ...state, kind: 'running', job, seenInstalling, failure: null };
}

/**
 * A state → what to draw. Pure, and every string in it either comes from
 * `shared/update-phases.js` or is one of the two connection sentences this
 * page owns (see the header).
 */
export function updateWindowModel(view) {
  const v = (view && typeof view === 'object') ? view : {};

  if (v.kind === 'failed') {
    const f = v.failure || {};
    return {
      kind: 'failed',
      headline: 'The update didn’t finish',
      body: f.error || 'The update stopped before it finished, and nothing was replaced.',
      hint: f.hint || null,
      ring: null,
    };
  }

  if (v.kind === 'lost') {
    return {
      kind: 'lost',
      headline: 'Lost contact with The Curator',
      // Deliberately makes NO claim about the update itself. The window cannot
      // see the job any more, and saying which way it went would be inventing
      // the one fact it just lost.
      body: 'This window can’t reach The Curator to read the update’s progress. ' +
            'The update itself may still be running — check Settings ▸ General when the app is back.',
      hint: null,
      ring: null,
    };
  }

  const job = (v.job && typeof v.job === 'object') ? v.job : null;
  if (v.kind === 'starting' || !job) {
    return {
      kind: 'starting',
      headline: 'Starting the update',
      body: 'Waiting for The Curator to begin.',
      hint: null,
      // Stage 0 with NO fill. The ring's first segment is the floor of the
      // scale rather than a claim that `resolving` has started; the headline
      // is what says where we are, and nothing is drawn as advanced.
      ring: { stage: 0, stageProgress: 0, label: 'Starting the update…', sublabel: '' },
    };
  }

  const copy = phaseCopy(job.phase, 'window');
  const pos = updateRingPosition(job);
  return {
    kind: 'running',
    headline: copy.headline,
    body: copy.body,
    hint: null,
    ring: {
      stage: pos.stage,
      stageProgress: pos.stageProgress,
      label: copy.headline + '…',
      // `null` when the route reported no byte counts — rendered as no line at
      // all rather than a reassuring "0 MB of 0 MB".
      sublabel: updateProgressSublabel(job) || '',
    },
  };
}

/**
 * The model → HTML. String concatenation over escaped values only: every
 * dynamic string here (the failure sentence, the hint) was written by the
 * server and arrives over HTTP, so it is escaped exactly as `settings.js`
 * escapes the same fields, and no value is ever interpolated into an
 * attribute or a URL.
 */
export function renderUpdateWindow(model, nowMs) {
  const m = (model && typeof model === 'object') ? model : {};
  const ring = m.ring
    ? progressRingHtml({
      stages: UPDATE_RING_STAGES,
      stage: m.ring.stage,
      stageProgress: m.ring.stageProgress,
      size: 44,
      tone: 'accent',
      label: m.ring.label,
      sublabel: m.ring.sublabel,
      // 'stage' rather than 'value', for the reason settings.js gives: the
      // centre says "2/5", and two different percentages on one control is
      // how a display comes to contradict itself.
      center: 'stage',
      ...(Number.isFinite(nowMs) ? { nowMs } : {}),
    })
    : '';

  // THE HEADLINE IS DRAWN ONCE, AND WHICH ELEMENT DRAWS IT DEPENDS ON WHETHER
  // THERE IS A RING. `progressRingHtml` renders its `label` beside the svg —
  // that is where Settings' headline lives too — so drawing `m.headline` again
  // here would print the phase twice in a 380-point window. Without a ring
  // (`failed`, `lost`) nothing else would say it at all, so it is drawn.
  // The suite asserts the headline appears EXACTLY ONCE in every state.
  return '<div class="uw uw-' + escapeHtml(m.kind || 'starting') + '">' +
    (ring
      ? '<div class="uw-ring">' + ring + '</div>'
      : '<div class="uw-headline">' + escapeHtml(m.headline || '') + '</div>') +
    '<div class="uw-note">' + escapeHtml(m.body || '') + '</div>' +
    (m.hint ? '<div class="uw-hint">' + escapeHtml(m.hint) + '</div>' : '') +
  '</div>';
}

/**
 * The poll loop. The ONLY impure function in this file, and everything it
 * touches is injected so the suite can drive it with a recording fetch and a
 * fake clock.
 *
 * @param {{fetchImpl:Function, setHtml:Function, schedule:Function, cancel:Function}} deps
 * @returns {{stop:Function}}
 */
export function startUpdateWindow(deps = {}) {
  const d = (deps && typeof deps === 'object') ? deps : {};
  const doFetch = ('fetchImpl' in d) ? d.fetchImpl : globalThis.fetch;
  const schedule = typeof d.schedule === 'function' ? d.schedule : ((fn, ms) => setTimeout(fn, ms));
  const cancel = typeof d.cancel === 'function' ? d.cancel : ((t) => clearTimeout(t));
  const setHtml = typeof d.setHtml === 'function' ? d.setHtml : null;

  let view = { kind: 'starting', job: null, failure: null, seenInstalling: false, misses: 0, done: false };
  let timer = null;
  let stopped = false;

  const draw = () => {
    if (!setHtml) return;
    try { setHtml(renderUpdateWindow(updateWindowModel(view))); } catch { /* a repaint is not load-bearing */ }
  };

  const poll = async () => {
    let answer = { ok: false, body: null };
    if (typeof doFetch === 'function') {
      try {
        // `cache: 'no-store'` for the same reason `pollInAppUpdate` sets it: a
        // cached progress record is a stale one, and a progress display that
        // repeats itself reads as a hang.
        const res = await doFetch(PROGRESS_URL, { cache: 'no-store', headers: { accept: 'application/json' } });
        if (res && typeof res.json === 'function') {
          const body = await res.json();
          if (body && typeof body === 'object' && body.ok === true) answer = { ok: true, body };
        }
      } catch { /* an unanswered poll is a state, not an exception — see nextUpdateView */ }
    }
    if (stopped) return;
    view = nextUpdateView(view, answer);
    draw();
    if (view.done) return;
    timer = schedule(() => { void poll(); }, POLL_MS);
  };

  draw();
  void poll();

  return {
    stop() {
      stopped = true;
      if (timer !== null) { try { cancel(timer); } catch { /* ignore */ } timer = null; }
    },
    /** TEST-ONLY read of the current state. */
    view() { return view; },
  };
}

/**
 * Wire it to the real page. Called from `update-window.html`'s inline
 * bootstrap; guarded so importing this module in Node (which the suite does)
 * touches no DOM.
 */
export function mountUpdateWindow(doc) {
  const root = doc && doc.getElementById ? doc.getElementById('uw-root') : null;
  if (!root) return null;
  return startUpdateWindow({ setHtml: (html) => { root.innerHTML = html; } });
}
