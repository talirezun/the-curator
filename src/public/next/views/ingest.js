// View: Ingest — "the way material gets in". Drop a file (or several);
// each is decomposed into entity, concept and summary pages and merged
// into what's already there.
//
// PHASE 1 (shipped) — the SINGLE-FILE path: setFile/submitIngest, ported
// from src/public/app.js's single-file flow (roughly its lines 71–618).
// Unaffected by everything below: 1 file, picked for the first time with
// no batch already in progress, still goes straight through pickSingleFile
// -> runIngest exactly as before.
//
// PHASE 2 (this pass) — the BATCH QUEUE: 2+ files, ported from
// src/public/app.js's "BATCH INGEST QUEUE" section (its lines ~619–1716).
// Two different kinds of code came from that section, on purpose:
//   - 13 pure DATA/LOGIC helpers are IMPORTED, byte-identical, from
//     ../shared/ingest-queue-logic.js — never reimplemented here. A drift
//     tripwire test (scripts/test-next-ingest-logic-drift.js) string-
//     compares them against app.js's own copies. 11 of the 13 come from
//     app.js's contiguous 669–883 range; computeQueueStatusCounts (the
//     "no item can be lost" bucketing invariant) and computeQueueSpentLabel
//     (in-progress-zero vs terminal-zero) were added later from app.js's
//     SEPARATE ~970–1085 range — both were briefly REIMPLEMENTED here
//     instead of imported (the shared/reimplement boundary had been drawn
//     by app.js LINE RANGE rather than by NATURE), and computeQueueSpentLabel
//     had already drifted cosmetically (template literal vs string
//     concatenation) before that was caught and fixed. Do not reintroduce
//     local copies of either — see the shared module's own header comment.
//   - The remaining HTML-string builders (app.js 885–1135, minus the two
//     above) are REIMPLEMENTED below in this shell's own markup/classes —
//     they're presentation, and presentation is what legitimately differs
//     between the two frontends.
// The three real defects the maintainer found in production and their
// fixes are preserved exactly — see the functions named in each comment
// below: (1) selections ACCUMULATE across every picker/drop event, batch
// mode is sticky (handleSelectedFiles/addFilesToQueueSelection); (2)
// cancel gives immediate feedback, terminal status always beats a stale
// cancelRequested/pauseRequested flag (computeQueueInFlight); (3) a
// terminal batch is Dismiss-able without a page reload, UI-only
// (dismissQueuePanel).
//
// DELIBERATE DIVERGENCE from app.js, recorded so it isn't "fixed" back:
// app.js's drop zone/file input stay visible and clickable even while a
// batch is live or sitting terminal-but-undismissed (its static HTML never
// hides them; refreshIngestBtnAvailability() just disables the single-file
// Ingest button when the domain is busy). This shell instead hides the
// single-file form ENTIRELY whenever a batch exists (state.queueModeActive
// || state.queueJob — see renderMain) and shows only the queue UI. Chosen
// because this shell rebuilds the whole panel from scratch on every
// render (setMain/innerHTML replace), so there's no natural place for a
// second, independent form to coexist with the queue panel the way two
// always-present static HTML blocks can in app.js. The batch UI is
// self-explanatory while live, and v3.3.1's Dismiss button (ported here
// too — see #3 above) always gives a visible way back to the single-file
// form once terminal, so nothing is unreachable — but it IS a real
// interaction difference from the production-proven design, not a neutral
// implementation detail, and should be treated as reviewable if app.js's
// behaviour here ever turns out to matter for a reason this comment didn't
// anticipate.
//
// Backend used (all pre-existing):
//   GET  /api/domains/stats                        → {domains:[{slug,displayName,...}], readonlyDomains:[slug,...]}
//   -- single-file (src/routes/ingest.js) --
//   POST /api/ingest  (multipart: domain, file, overwrite?)
//     → plain JSON error/duplicate, or an SSE stream of {type:'progress'|
//       'wait', pct, message} events then one {type:'done', ...} or
//       {type:'error', message}.
//   -- batch queue (src/routes/ingest-queue.js, mounted at /api/ingest-queue) --
//   POST /estimate            {domain, files:[{name,size}]} → free cost estimate
//   POST /                    multipart {domain, files[], overwrite?, budgetUsd?} → {ok, jobId, job}
//   GET  /active               → {ok, job|null} — the ONE globally active (non-terminal) job, if any
//   GET  /:jobId                → {ok, job}
//   GET  /:jobId/stream          → SSE: {type:'job', job} on connect, then
//                                  {type:'item-progress', idx, pct, message} and
//                                  {type:'job', job} per change, {type:'done', job} at the end
//   POST /:jobId/start           → start or resume → {ok, job}
//   POST /:jobId/pause            → {ok, job}
//   POST /:jobId/cancel            → {ok, job}
//
// Cross-view write gate: EVERY real write registers with app.js's
// beginDomainWrite()/isDomainWriteBusy() — the CONTRACT (is a write
// genuinely in progress THIS INSTANT, not "an operation exists") lives in
// app.js's own docblock; which other views currently read the gate is
// deliberately not enumerated here — an earlier version of this comment
// named a specific caller count and an independent audit found it had
// already gone stale. Check with grep if it matters for what you're doing.
//   - Single-file: this mount's own ingest, AND any still running from an
//     abandoned earlier mount, since that fetch is deliberately never
//     aborted on navigate-away (no server-side "get status" endpoint
//     exists for it — nothing to reattach to, so aborting would just make
//     the gate lie). See runIngest's own comment.
//   - Batch: the OPPOSITE choice, and it's the right one BECAUSE the
//     backend genuinely supports reattachment here (GET /active, GET
//     /:jobId, GET /:jobId/stream all exist). Leaving Ingest calls
//     detachQueueStream() (aborts the SSE fetch, which releases the write
//     handle in its own `finally`); returning calls checkActiveQueueJob(),
//     which re-fetches the live snapshot and reattaches the stream if the
//     job is 'running' — resurrecting a REAL progress view, not a fake
//     one, because the server can actually hand one back. Ported from
//     src/public/app.js's own tab-switch handler + checkActiveQueueJob.
//     An independent audit found that detach's release ALSO used to be
//     the ONLY thing holding the gate busy for a batch — so leaving
//     Ingest mid-batch made the gate read false while the job kept
//     running server-side. Closed by app.js's active-job watcher
//     (reportPossibleActiveJob(), called from applyQueueJobSnapshot below)
//     — a SHELL-level handle sourced from server truth, independent of
//     this view's own mount state or stream.

import {
  registerView, setSidebar, setMain, eyebrow, emptyCard, escapeHtml, icon,
  isCurrentMount, reportAsyncMountFailure, reportAsyncActionFailure,
  beginDomainWrite, isDomainWriteBusy, getDomainWriteLabel, onWriteGateChange,
  reportPossibleActiveJob,
} from '../app.js';

// The 13 pure data helpers — byte-identical copies of src/public/app.js's
// own, imported (never reimplemented) per the drift-tripwire contract
// documented in ../shared/ingest-queue-logic.js's own file header.
// computeQueueStatusCounts/computeQueueSpentLabel used to be reimplemented
// locally in THIS file — moved into the shared module after review found
// that the shared/reimplement boundary had been drawn by app.js LINE RANGE
// rather than by NATURE, and these two pure-logic functions (no markup
// returned) had fallen on the wrong side of it. Do not reintroduce local
// copies of these two — see the shared module's own header comment.
import {
  queueBusyTransition, formatQueueBytes, formatUsdRange, formatTokenRange,
  pausedReasonCopy, statusPillMeta, resolveEstimateFileList, dedupeQueueFiles,
  extractConflictJobId, formatHealthCounts, sanitizeDisplayName,
  computeQueueStatusCounts, computeQueueSpentLabel,
} from '../shared/ingest-queue-logic.js';
import { renderListboxHtml, mountListbox, closeAllListboxes } from '../shared/listbox.js';
// The ONE text system in /next (shared/text.js). Imported, never re-implemented.
// This view rendered its cost ESTIMATE — the figure a user decides to spend on —
// in a bespoke label/value row, and its static "what this view does" sentence in
// `.view-body`, a class that also means "loading placeholder" and "empty state"
// elsewhere in the tree. renderReadout and renderDescription are those two roles.
// scripts/test-next-memory-ingest-text.js asserts these imports are present AND
// reached: a component that ships unused is the shape this repo keeps re-learning.
import {
  renderStatus, renderReadoutGroup, renderViewHeader,
} from '../shared/text.js';

// The honest USD renderer. NOT one of the byte-pinned 13 above — it is a
// separate module precisely because those are frozen to app.js and this
// fixes a defect in how money is displayed. See ../shared/format-usd.js.
import { formatUsdHonest } from '../shared/format-usd.js';

// The design system's two-layer progress ring, and the map from the pct
// src/brain/ingest.js actually sends onto its five REAL phases. Read that
// module's header before changing anything here: the outer ring is only
// ever allowed to move because a stage genuinely advanced, and the ingest
// map deliberately leaves Saving / Extracting / Planning at stageProgress
// 0 because those phases report nothing while they run. Planning is the
// one v3.0.17 was reported as "hung" on.
import {
  progressRingHtml, INGEST_STAGES, mapIngestPctToStage, ringAria,
} from '../shared/progress-ring.js';
import { createLoadingGate, gatedLoader, settleGate } from '../shared/loading-gate.js';

const ALLOWED_EXT = ['.txt', '.md', '.pdf'];
const QUEUE_API = '/api/ingest-queue';

function freshState() {
  return {
    loadingDomains: true,
    domainsError: null,
    domains: [],           // [{slug, displayName}] — readonly mirrors already filtered out
    domain: null,           // selected domain slug
    file: null,             // File | null
    fileError: null,        // string | null — bad extension on selection
    dragActive: false,
    submitting: false,      // an ingest THIS MOUNT started is in flight
    progress: null,         // {pct, label, waiting, phaseStartedAt} | null
    duplicate: null,        // {filename} | null
    result: null,           // {title, changes, warnings, truncated, wasOverwrite, tokenUsage, unchangedExpanded} | null
    errorMessage: null,

    // ── Server-backed activity (v3.24.0) ─────────────────────────────
    // The record GET /api/ingest/activity holds for the SELECTED domain,
    // or null. This is what makes a single-file ingest survive navigating
    // away, a reload and a second tab: the events were always arriving and
    // always being dropped (see runIngest's setProgress comment), so the
    // fix is not to keep the fetch alive, it is to let the server remember.
    remote: null,               // wire record for state.domain, or null
    // `remote.phaseStartedAt` is on the SERVER's clock. This is the same
    // instant expressed on THIS machine's clock, computed once per fetch as
    // `Date.now() - (serverNow - phaseStartedAt)` — a subtraction of two
    // readings from the same clock, so machine-to-machine skew cancels and
    // is never reasoned about. Everything on screen ticks from this.
    remotePhaseStartedAtLocal: null,
    remoteError: null,          // a failed activity fetch; never blanks what is on screen
    remoteResultExpanded: false, // the restored result's unchanged-pages fold

    // Every domain the server says has a single-file ingest RUNNING, sorted.
    // Kept because `remote` above deliberately holds only the SELECTED
    // domain's record, and the sidebar has to be able to mark a row that is
    // not the selected one. See renderSidebar's live-marker block, and
    // adoptDestination for why one record being invisible was the whole bug.
    runningDomains: [],

    // Every SETTLED record the server still remembers, newest-finished first,
    // stored RAW — NOT filtered by this viewer's acknowledgements.
    //
    // THE ACK IS APPLIED AT READ TIME, DELIBERATELY, and that is the whole
    // reason this holds the raw set. `dismissSettledElsewhere` and
    // `dismissRemoteOutcome` both write the ack to localStorage and re-render
    // immediately; if the ack had been applied HERE, at fetch time, a dismissal
    // would not take effect until the next poll landed — up to 15 seconds of a
    // notice the user has already told us to remove. `pendingRemoteOutcome`
    // already reads `isActivityAcked` at call time for exactly this reason;
    // these two surfaces follow it rather than inventing a second convention.
    settledActivity: [],

    // Whether this mount still owes its one-and-only destination adoption.
    // Lives on `state` — NOT at module scope like `refreshingDomainStats` —
    // precisely because onEnter replaces `state` wholesale, and "has anyone
    // chosen a destination in THIS mount" is a per-mount question. It is
    // cleared by the first activity fetch to land and by selectDomain,
    // whichever comes first; see adoptDestination.
    destinationAdoptionPending: true,

    // ── Batch queue (Phase 2) ────────────────────────────────────────
    // Pre-job (confirm-gate) state — mirrors src/public/app.js's
    // selectedFiles/queueModeActive/queueEstimate.
    queueModeActive: false,     // sticky once true — see handleSelectedFiles
    selectedFiles: [],           // File[] accumulated, pre-job
    queueEstimate: null,         // last POST /estimate response, or null
    queueEstimateLoading: false,
    queueEstimateError: null,
    queueBudgetInput: '',        // budget-cap text field
    queueOverwriteInput: false,  // overwrite checkbox
    queueSubmitting: false,      // POST create+start round-trip in flight
    queueSubmitError: null,

    // Live/terminal job state — the server snapshot IS the state; this
    // view never derives its own. null when no job is being watched.
    queueJob: null,               // last wire-shape job snapshot, or null
    queueStreamError: null,       // banner text on a stream failure
    queueCancelConfirmOpen: false,
    queueActionBusy: null,        // 'pause' | 'resume' | 'cancel' | null — THIS click's own round-trip only; the authoritative post-response state always comes from queueJob.pauseRequested/cancelRequested/status
    // The user dropped files while a batch panel was on screen — i.e. onto a
    // surface with no drop zone, so nothing was added. Set by the
    // document-level drop guard, cleared the moment the advice it carries
    // stops applying (the panel is dismissed, or a new selection begins).
    // It exists because the alternative is SILENCE after a deliberate user
    // action, which is the exact complaint this release started from.
    queueDropIgnored: false,
  };
}

let state = freshState();

// Same capture-before-first-await discipline as every other view with real
// async work (see app.js's isCurrentMount doc comment, and sync.js's
// file-header comment for the concrete failure this avoids).
let myMountToken = 0;

// Delay-gated loading indicator for this view's entry load. Built in
// onEnter, cancelled in the teardown. See shared/loading-gate.js.
let loadGate = null;

// Re-entrancy guard for refreshDomainStats. Module-scoped rather than on
// `state`, which onEnter replaces wholesale per mount: an in-flight refresh
// outlives that replacement, and a flag on the dead object would leave the new
// mount thinking nothing is running while a fetch is still landing. Cleared in
// a `finally`, so a thrown parse cannot wedge it true for the process lifetime.
let refreshingDomainStats = false;

// Closure state for the currently-running ingest's elapsed-time clock
// (v3.0.17 in the shipping app — ticks every second, resets only on a
// genuine new progress step, NOT on a `wait` sub-event, so a stalled phase
// visibly keeps counting instead of looking frozen). Scoped at module level
// because the ticking interval must keep running (and get cleaned up)
// regardless of which mount is currently active — see runIngest's own
// comment on why teardown does not abort the underlying fetch.
let elapsedTimerId = null;
let phaseStartedAt = null;

// Unsubscribe function for the write-gate subscription this mount installed
// (see onWriteGateChange in app.js) — released in teardown.
let unsubscribeWriteGate = null;

// ── Server-backed activity: polling + the reattached elapsed clock ───────
//
// Cadence is two-speed and the endpoint is why: GET /api/ingest/activity
// reads an in-memory Map and touches no filesystem and no network, unlike
// views/memory.js's index route (which stats every (scope, machine) pair
// across up to 200 domains and therefore had to derive its interval from
// measured cost). Measured here at well under a millisecond server-side, so
// a fixed pair of constants is honest rather than under-thought:
//   ACTIVE — a run is in flight and the phase label/ring must track it. The
//     elapsed clock ticks LOCALLY every second in between, so this only has
//     to be fast enough that the PHASE looks current, not the seconds.
//   IDLE — nothing is running for this domain. Still polled, because an
//     ingest can be started from another tab, and that tab is exactly the
//     case this whole feature exists for.
const ACTIVITY_POLL_ACTIVE_MS = 2000;
const ACTIVITY_POLL_IDLE_MS = 15000;

let activityPollTimer = null;
let activityWakeHandler = null;
let activityInFlight = false;
// The document-level drag guards' remover (see installDocumentDragGuards).
// Held at module scope for the same reason activityWakeHandler is: they are
// installed ONCE per mount in onEnter — never in wireListeners, which runs on
// every render and would stack a new set of listeners each time — and the
// teardown is the only thing that can take them off again.
let removeDocumentDragGuards = null;
// Separate from `elapsedTimerId`, which belongs to runIngest and is cleared
// in its `finally`. Merging the two would mean one teardown path deciding the
// lifetime of two clocks with different owners.
let remoteElapsedTimerId = null;
// What render() last painted for the activity panes. A poll that finds nothing
// new must not re-render — views/memory.js's screenSignature, same reason: a
// rebuild would disturb an open fold and the scroll position for no change.
let renderedActivitySignature = null;

// ── Batch queue module-level tracking (Phase 2) ───────────────────────────
// Deliberately module-level, NOT `state` fields — they track a live network
// resource (the SSE connection) and a busy-gate handle that must be torn
// down/reattached in lockstep with mount lifecycle itself (onExit/onEnter),
// not with any one mount's own render cycle. Mirrors src/public/app.js's
// own module-level queueJobId/queueStreamAbort/_queueLastStatus/
// _queueBusyDomain — same shape, adapted for this shell's release-handle
// gate (see applyQueueBusyForStatus below for the adaptation).
let queueJobId = null;          // the job this mount is currently watching, or null
let queueStreamAbort = null;    // AbortController for the live SSE fetch, or null
let _queueLastStatus = null;    // last status queueBusyTransition was told about
// The release handle from THIS specific beginDomainWrite() call — never a
// domain string to re-derive later. Same H2-proofing shape as the
// single-file path's `release` local in runIngest, just held across a
// longer lifetime (survives many snapshot updates within one job's run).
let _queueBusyRelease = null;

registerView('ingest', {
  onEnter(mountToken) {
    state = freshState();
    myMountToken = mountToken;
    loadGate = createLoadingGate({
      onChange: () => { if (isCurrentMount(mountToken)) render(mountToken); },
    });
    loadGate.begin();
    render(mountToken);
    loadDomains(mountToken)
      .then(() => {
        // See the chaining note below: the activity record is keyed by domain,
        // so this must run AFTER a destination exists.
        if (isCurrentMount(mountToken)) refreshActivity(mountToken).catch(() => {});
      })
      .catch((err) => reportAsyncMountFailure(mountToken, err));

    // Re-render whenever ANY domain's write-gate state changes — e.g.
    // another mount's abandoned ingest on the currently-selected domain
    // finishes, or a Sync/Shared-Brain write starts/ends on it. This view
    // only READS the gate to decide its own button/notice state; it never
    // begins a write on another view's behalf.
    unsubscribeWriteGate = onWriteGateChange(() => {
      if (isCurrentMount(mountToken)) render(mountToken);
    });

    // Batch resume-on-return (Phase 2): unlike single-file, the backend
    // genuinely supports reattachment (GET /active + /:jobId/stream), so
    // every mount checks for a live batch and reattaches to it — ported
    // from src/public/app.js's checkActiveQueueJob(), called the same way
    // (on every Ingest-view entry).
    checkActiveQueueJob(mountToken).catch((err) => reportAsyncMountFailure(mountToken, err));

    // SINGLE-FILE resume-on-return (v3.24.0). The comment at the top of this
    // file used to say there was "no server-side 'get status' endpoint" for
    // the single-file path and therefore "nothing to reattach to". There is
    // now: GET /api/ingest/activity. So this mount asks what the server knows
    // the moment it opens, exactly as checkActiveQueueJob does for a batch.
    //
    // Errors are swallowed rather than routed through reportAsyncMountFailure:
    // refreshActivity already treats a failure as "keep what is on screen and
    // try again next tick", and a view whose whole job is telling you what
    // happened must not itself fail to open because one poll did.
    // CHAINED ONTO loadDomains, NOT fired beside it. `state.domain` is null
    // until loadDomains resolves and picks a destination, and the record is
    // looked up BY DOMAIN — so an immediate call finds nothing and the view
    // then shows an empty form over a live ingest until the next IDLE poll,
    // up to 15 s later. Measured in a real browser: the server reported
    // `running, pct 12, "Phase 1: planning wiki structure…"` while the view
    // rendered a plain drop zone. Chaining costs nothing (loadDomains is
    // already awaited by the mount) and removes the window entirely.
    renderedActivitySignature = activitySignature();

    // REVALIDATE ON WAKE, for the reason views/memory.js gives for its own:
    // `focus` covers alt-tabbing back, `visibilitychange` covers a background
    // tab being brought forward (which fires no focus event). Both are free
    // while the user is elsewhere — which is exactly when an ingest they
    // started is still running.
    //
    // The mount token is CAPTURED rather than read from `myMountToken`: a
    // later mount overwrites that module-level variable, and a listener that
    // outlived its teardown would then hand isCurrentMount the wrong view's
    // token and be waved through.
    activityWakeHandler = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (!isCurrentMount(mountToken)) return;
      refreshActivity(mountToken).catch(() => {});
    };
    if (typeof window !== 'undefined') window.addEventListener('focus', activityWakeHandler);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', activityWakeHandler);
    scheduleActivityPoll(mountToken);

    // Drop anywhere in the view, and refuse the browser's navigate-to-the-file
    // default everywhere else. Installed HERE and not in wireListeners for the
    // reason the variable's own comment gives: wireListeners runs on every
    // render, and document listeners added there would accumulate.
    if (removeDocumentDragGuards) { removeDocumentDragGuards(); removeDocumentDragGuards = null; }
    removeDocumentDragGuards = installDocumentDragGuards(mountToken);

    return () => {
      // Deliberately does NOT abort an in-flight SINGLE-FILE fetch. A
      // single-file ingest has no cancel semantics anywhere in this app
      // (that is a batch-queue-only feature — v3.4.0 in the shipping app,
      // and even there it only cancels BETWEEN LLM calls, never mid-call)
      // — the server has already started (or will finish) writing pages
      // regardless of whether this tab is still watching. Aborting our own
      // client-side fetch() would just make the write gate lie (report
      // "not busy" while the server is still writing), which is worse than
      // leaving it running: isDomainWriteBusy() stays accurate for every
      // OTHER view exactly because runIngest's own finally block — not
      // this teardown — is what releases the write handle, once the
      // request genuinely completes. See runIngest for that release.
      //
      // The BATCH queue is the opposite, on purpose (see this file's
      // header comment): detach the live SSE stream on the way out. Its
      // own `finally` (in attachQueueStream) releases the write-gate
      // handle exactly once, mirroring the shipping app's
      // "disconnect the live SSE stream when leaving the Ingest tab (this
      // also releases the busy gate)" comment. checkActiveQueueJob() above
      // is what resurrects a REAL (not fake) progress view on return,
      // because — unlike single-file — the backend can actually hand one
      // back.
      detachQueueStream();

      // Timer hygiene (load-bearing): an armed delay timer that survives
      // this teardown would paint a loader into whatever view comes next.
      if (loadGate) { loadGate.cancel(); loadGate = null; }

      // Activity poll + clock hygiene. An armed poll timer surviving this
      // teardown is worse than a stray delay timer: it would keep FETCHING for
      // a view nobody is looking at, for the life of the page. Verified at 0
      // requests after leaving the view.
      stopActivityPoll();
      stopRemoteElapsedTimer();
      if (activityWakeHandler) {
        if (typeof window !== 'undefined') window.removeEventListener('focus', activityWakeHandler);
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', activityWakeHandler);
        activityWakeHandler = null;
      }
      // Document-level drag guards go with the view. Left behind, they would
      // keep swallowing file drops — and keep answering isCurrentMount with a
      // dead token — for the life of the page.
      if (removeDocumentDragGuards) { removeDocumentDragGuards(); removeDocumentDragGuards = null; }
      renderedActivitySignature = null;

      // Write-gate subscription cleanup — a torn-down mount must stop
      // reacting to gate changes.
      if (unsubscribeWriteGate) { unsubscribeWriteGate(); unsubscribeWriteGate = null; }

      // The domain picker's menu is a <body> child, so a rail navigation
      // does not remove it with the view. navigate() closes the reader but
      // explicitly does NOT reach into view-owned popovers (see its
      // comment), so closing it is this view's job. The component also
      // self-closes when its trigger leaves the document; this is the
      // deliberate second layer.
      closeAllListboxes();
    };
  },
});

// ── Server-backed activity ═══════════════════════════════════════════════
//
// THE DEFECT, and why the fix is server-side. Reported from real use: start a
// single-file ingest, navigate away, come back, and the view shows only the
// generic "Waiting on another write in this domain" note — no file, no phase,
// no progress — and when the ingest finishes, nothing at all.
//
// MEASURED: the events were never lost. This view deliberately does NOT abort
// its SSE fetch on navigate-away (see the teardown's comment, and runIngest's),
// so every `progress` event AND the `done` event still arrive — and are then
// DROPPED, because setProgress and the done handler are gated on
// isCurrentMount(token) and a returning mount has a brand-new `state`. Data
// received, no consumer reads it: this repo's dead-data shape.
//
// Keeping the fetch alive across mounts would not fix it either — a reload or
// a second tab has no fetch to keep. The only thing that survives all three is
// the SERVER remembering, which is what src/brain/ingest-activity.js does and
// what GET /api/ingest/activity hands back.

// Acknowledgement is PER VIEWER and lives in localStorage, deliberately.
//
// "I have seen this result" is a fact about one person looking at one browser,
// not about the ingest — a DIFFERENT browser, machine or profile has not seen
// it and should still be told. (Precisely: localStorage is per ORIGIN and per
// profile, so a second TAB in the same browser shares the dismissal. An
// earlier draft of this comment claimed a second tab would still be told,
// which is false, and was corrected after checking rather than left standing.)
// Making it server state would also
// mean a MUTATING endpoint, and a route that writes needs registerWrite, a
// file lock and a place in the write-guard class invariants; that is a real
// cost to buy a dismissed-ness flag.
//
// Every read AND write is wrapped: storage throws outright in some private
// modes, and the view must render correctly with no stored value. Failing to
// read means the result is shown again — the SAFE direction, matching the rule
// v3.8.0 set for its own dismissal (guidance reappearing is harmless; silently
// hiding an outcome has no visible symptom).
const ACTIVITY_ACK_KEY = 'curator-ingest-activity-ack-v1';
// Ids are UUIDs and only the most recent handful can ever still be live, so
// the list is trimmed rather than grown forever in a store with a size cap.
const ACTIVITY_ACK_MAX = 20;

function loadAckedActivityIds() {
  try {
    const raw = window.localStorage.getItem(ACTIVITY_ACK_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function isActivityAcked(id) {
  if (!id) return false;
  return loadAckedActivityIds().includes(id);
}

function ackActivityId(id) {
  if (!id) return;
  try {
    const next = [id, ...loadAckedActivityIds().filter((v) => v !== id)].slice(0, ACTIVITY_ACK_MAX);
    window.localStorage.setItem(ACTIVITY_ACK_KEY, JSON.stringify(next));
  } catch {
    /* private mode / storage disabled — the result simply shows again */
  }
}

/**
 * The activity request, and NOTHING else.
 *
 * Split out for the reason views/memory.js records for its own `fetchIndex`:
 * a revalidation that builds its own request is a second copy of the parse,
 * and two copies of a parse drift about what an error means. Returns a plain
 * result and writes NOTHING to `state`.
 */
async function fetchActivity() {
  try {
    const res = await fetch('/api/ingest/activity');
    if (!res.ok) return { error: 'Could not read ingest activity (' + res.status + ')' };
    const data = await res.json();
    if (!data || !Array.isArray(data.activity)) return { error: 'Ingest activity response was malformed' };
    return { activity: data.activity, serverNow: Number(data.serverNow) };
  } catch (err) {
    return { error: err && err.message ? err.message : 'Could not read ingest activity' };
  }
}

/**
 * What the activity panes currently show, as a comparable string.
 *
 * Built from the values that are actually PAINTED, so a poll that changed
 * nothing visible costs no render. `phaseStartedAt` is included because the
 * clock resetting IS a visible change; the ticking seconds are not, because
 * they are patched into #ing-remote-elapsed by textContent rather than by a
 * re-render (same split the live path already uses for #ing-elapsed).
 */
function activitySignature() {
  const r = state.remote;
  // The running set is folded in BEFORE the no-record fast path, and that
  // ordering was a real bug caught by its own assertion rather than by review.
  // `if (!r) return 'none'` is precisely the branch taken in the reported
  // scenario — selected domain `articles`, ingest running on `posts` — so a
  // set appended only to the array below would have been computed on every
  // poll and never painted. That is the dead-data shape this whole feature
  // exists to remove, reintroduced one level up inside its own fix.
  const running = (state.runningDomains || []).join(',');
  // THE SETTLED SET IS FOLDED IN THE SAME WAY, AND FOR THE SAME REASON.
  // It is the exact trap above, one release later: the FINISHED case the
  // maintainer reported — selected `articles`, a settled record on `posts` —
  // also takes the `!r` fast path, so a settled set appended only to the array
  // below would be recomputed on every poll and never painted. Both new
  // surfaces would silently never appear, which is the defect they exist to
  // remove. Computed here rather than inside the branch so both arms provably
  // read the SAME value.
  //
  // The ACK-FILTERED set is what goes in, because acknowledgement is what the
  // surfaces are gated on: dismissing a record must repaint. Status rides
  // along because it picks the WORD on the row (Ingested vs Failed), and the
  // id because it is what changes when one record replaces another.
  //
  // Deliberately NOT filtered to "elsewhere": that subset depends on
  // `state.domain`, and a selection change already repaints directly through
  // `selectDomain`. Keeping this selection-INDEPENDENT means the stored
  // signature cannot go stale the moment the destination moves.
  const settled = unackedSettledRecords()
    .map((s) => s.domain + ':' + s.status + ':' + s.id)
    .join(',');
  if (!r) return 'none|' + running + '|' + settled;
  return JSON.stringify([
    r.id, r.status, r.pct, r.message, r.waiting, r.phaseStartedAt,
    r.filename, r.error,
    r.result ? [r.result.title, r.result.changesTotal, r.result.warningsTotal] : null,
    isActivityAcked(r.id),
    state.remoteResultExpanded,
    // THE SIDEBAR MARKERS ARE A PANE THIS GUARD MUST BE ABLE TO SEE.
    // `state.remote` covers only the selected domain, so without this line a
    // poll that discovered an ingest running on a DIFFERENT domain would
    // change `state.runningDomains`, compare equal here, and never repaint —
    // leaving the marker off the row it exists for. That is memory.js's own
    // recorded failure verbatim: "a no-op guard that cannot see a pane is not
    // a guard for that pane."
    running,
    // Same argument, for the settled surfaces. Without this a poll that
    // discovered a run had FINISHED on another domain would leave the sidebar
    // unmarked and the main-pane line unpainted.
    settled,
  ]);
}

/**
 * Every SETTLED record the server still remembers, newest-FINISHED first.
 *
 * ── THE HALF OF THE REPORT THE RUNNING FIX DID NOT COVER ────────────────
 * The maintainer opened with "the process ended, but there's basically no way
 * I can know if this article was ingested or not." v3.24.1's `adoptDestination`
 * answers the RUNNING case — come back mid-ingest and the view adopts that
 * domain — and its own commit message records the rest as unfixed: a run that
 * FINISHES while you are elsewhere still surfaces nothing, because
 * `pendingRemoteOutcome` is keyed on `state.remote`, which holds the SELECTED
 * domain's record only. Ingest into `posts`, walk away, come back on
 * `articles`: nothing is running so no marker, and no outcome panel. On Flash
 * Lite an ingest can finish in ~9 s, so this is the COMMON path.
 *
 * ── WHY `finishedAt`, NOT `startedAt` ───────────────────────────────────
 * `src/brain/ingest-activity.js` stamps `finishedAt` when a record settles and
 * puts it on the wire through `wireNum` (so it is a finite number or null,
 * exactly like `startedAt`). It is the honest key for this question: the user
 * is asking WHICH ONE FINISHED, and a long run started first can finish last.
 * It is also fixed for the life of the record, so re-evaluating on every poll
 * cannot make the ordering ping-pong — the same stability argument
 * `pickAdoptableDestination` makes for `startedAt`.
 *
 * Ties break on domain ASCENDING so the order is TOTAL and the answer is
 * deterministic rather than dependent on the server's Map iteration order. A
 * record with no `finishedAt` sorts LAST rather than poisoning the comparator
 * with NaN — a record we cannot date must not outrank one we can. Both rules
 * are lifted verbatim from `pickAdoptableDestination`, deliberately: two
 * orderings over the same activity list that disagree would be a bug waiting
 * to be discovered by a user rather than by a test.
 *
 * `id` is carried because it is what the acknowledgement store is keyed on —
 * without it neither surface could be dismissed, and the ack is the ONLY thing
 * that clears them.
 */
function settledActivityRecords(activity) {
  const at = (r) => (Number.isFinite(r.finishedAt) ? r.finishedAt : -Infinity);
  return (activity || [])
    .filter((a) => a && (a.status === 'done' || a.status === 'error')
      && typeof a.domain === 'string' && a.domain
      && typeof a.id === 'string' && a.id)
    .map((a) => ({
      id: a.id,
      domain: a.domain,
      status: a.status,
      finishedAt: Number.isFinite(a.finishedAt) ? a.finishedAt : null,
      filename: typeof a.filename === 'string' ? a.filename : null,
    }))
    .sort((a, b) => {
      if (at(b) !== at(a)) return at(b) - at(a);                       // newest finished first
      return a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0;   // total order
    });
}

/**
 * The settled records THIS VIEWER has not dismissed.
 *
 * Reads `isActivityAcked` at CALL time, so a dismissal takes effect on the very
 * next render rather than on the next poll. Both new surfaces derive from this
 * one function, which is what makes the single existing acknowledgement clear
 * BOTH of them — there is deliberately no second dismissal store.
 */
function unackedSettledRecords() {
  return (state.settledActivity || []).filter((r) => !isActivityAcked(r.id));
}

/**
 * The unacknowledged settled records for domains that are NOT the selected one.
 *
 * Two filters, each load-bearing for a different reason.
 *
 * NOT THE SELECTED DOMAIN — because that case is already served, completely and
 * better, by `renderRemoteOutcome`: select the domain and the full panel appears
 * with the page list, the warnings and the token usage. A line saying "an ingest
 * finished here" directly above that panel would be the same instrument twice,
 * which is the shape v3.20.0 records deleting from Domains.
 *
 * IN `state.domains` — because the ONLY action this line offers is "select that
 * domain", and `selectDomain` on a slug the sidebar cannot draw would move the
 * form to a destination with no row and no stats. The running marker gets this
 * intersection for free at render time (a `Set.has` per row); the line has to
 * ask for it explicitly, so it does.
 */
function settledElsewhere() {
  const listed = new Set((state.domains || []).map((d) => d && d.slug));
  return unackedSettledRecords().filter(
    (r) => listed.has(r.domain) && r.domain !== state.domain
  );
}

/**
 * Which domains the server says are mid-ingest, sorted so the string built
 * from this in activitySignature() is stable under Map iteration order.
 *
 * Not intersected with `state.domains` here: the sidebar can only draw rows
 * for domains it lists, so the intersection happens for free at render time,
 * and keeping the raw set means this function answers exactly one question.
 */
function runningActivityDomains(activity) {
  return (activity || [])
    .filter((a) => a && a.status === 'running' && typeof a.domain === 'string' && a.domain)
    .map((a) => a.domain)
    .sort();
}

/**
 * The destination a FRESH mount should adopt, or null to leave the selection
 * alone. Pure: takes the server's list, this mount's own domain list and the
 * current selection, and returns a slug.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────
 * Reported from real use: "I uploaded a document, ingested it, then switched
 * to the memory layer and returned, and everything was gone. No message, no
 * nothing." Then, minutes later, "now it works, I don't know why."
 *
 * MEASURED on the live server, and it is not intermittent. GET
 * /api/ingest/activity held TWO records — `posts`, started 94 s earlier, and
 * `articles`, started 27 s later with the SAME filename. That pair is the
 * signature of the whole sequence: ingest into `posts` -> return -> see
 * nothing -> re-ingest, which the second time lands on the default domain and
 * therefore shows. The feature worked; it was unreachable.
 *
 * The cause is two lines that were each correct alone. `loadDomains` does
 * `state.domain = list[0].slug` unconditionally, and `refreshActivity` looks
 * the record up with `find((a) => a.domain === state.domain)`. So a returning
 * mount can only ever find a record for the FIRST domain, and an ingest
 * running anywhere else is invisible however complete the server's memory is.
 *
 * ── THIS IS BATCH-PATH PARITY, NOT A NEW IDEA ───────────────────────────
 * `applyQueueJobSnapshot` and `checkActiveQueueJob` have always done
 * `if (job.domain && state.domains.some(d => d.slug === job.domain))
 *  state.domain = job.domain;` — adopt a live job's domain, guarded on it
 * being in this mount's own list. The single-file path simply never inherited
 * it. The `state.domains` guard is kept verbatim rather than reinvented.
 *
 * ── WHY THIS RUNS ONCE, AT MOUNT, AND NEVER AGAIN ───────────────────────
 * v3.23.1's rule, which this must not relax: a poll never swaps the document
 * under a reader, and a choice the user actually made is never taken away.
 * A fresh mount has made no choice yet — `list[0]` is the store's own default,
 * not an intention — so resolving it to the live run is right there and only
 * there. Fifteen seconds later the user IS reading a screen, and moving their
 * destination out from under them because a second tab started an ingest would
 * be the worse bug: the sidebar markers (part two of this fix) tell them
 * without touching what they selected.
 *
 * v3.23.1's own bug was reading the store's auto-resolution back as if it were
 * the user's choice, which pinned a control to a stale value forever. The
 * mirror-image mistake here would be treating `list[0]` as a choice and never
 * adopting at all — which is exactly the shipped defect. The distinction is
 * carried by `state.destinationAdoptionPending`, which only a real
 * `selectDomain` click or the one adoption attempt can clear.
 *
 * ── CHOOSING AMONG SEVERAL RUNNING RECORDS ──────────────────────────────
 * The maintainer genuinely had two, so "adopt the running one" is
 * under-specified and the rule has to be written down.
 *
 *  1. If the CURRENT selection already has a running record, return null.
 *     Nothing is hidden, so there is nothing to fix, and moving would be pure
 *     harm. This short-circuit means an adoption only ever fires when the
 *     screen would otherwise show nothing.
 *  2. Otherwise take the running record with the LATEST `startedAt`. It is the
 *     run the user most recently caused, which is the best available proxy for
 *     which one they came back to look at; it is stable, because `startedAt`
 *     is fixed for the life of a record, so re-evaluating cannot ping-pong;
 *     and where there is exactly one running record — the common case, and the
 *     only case in the report above — "latest" and "the one" coincide, so the
 *     rule adds no behaviour in the case that matters most.
 *  3. Ties break on slug, ascending, so the order is TOTAL and the answer is
 *     deterministic rather than dependent on Map insertion order. `startedAt`
 *     arrives through `wireNum`, which yields null for anything non-finite, so
 *     a missing stamp sorts LAST rather than poisoning the comparator with
 *     NaN — a record we cannot date must not outrank one we can.
 *
 * Refusing to adopt when ambiguous was considered and rejected: it reinstates
 * the blank screen in precisely the case the user is most confused by.
 */
function pickAdoptableDestination(activity, domains, currentDomain) {
  const listed = new Set((domains || []).map((d) => d && d.slug));
  const running = (activity || []).filter(
    (a) => a && a.status === 'running' && a.domain && listed.has(a.domain)
  );
  if (!running.length) return null;
  // Rule 1 — the selected domain is already showing its own run.
  if (currentDomain && running.some((a) => a.domain === currentDomain)) return null;
  const at = (a) => (Number.isFinite(a.startedAt) ? a.startedAt : -Infinity);
  const best = running.slice().sort((a, b) => {
    if (at(b) !== at(a)) return at(b) - at(a);           // rule 2 — latest first
    return a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0;  // rule 3 — total order
  })[0];
  return best.domain === currentDomain ? null : best.domain;
}

/**
 * Spend this mount's ONE destination adoption, if it is still owed.
 *
 * A named writer of `state.domain`, deliberately, rather than four lines
 * inline in refreshActivity: scripts/test-next-ingest-view.js §2 attributes
 * every `state.domain =` to its enclosing function and fails on anything not
 * allow-listed. Inline, the allow-list entry would have to be `refreshActivity`
 * — which would then wave through ANY future write anywhere in that function,
 * including a rogue one. Naming the writer keeps the guard as narrow as the
 * behaviour.
 *
 * The pending flag is cleared whether or not anything was adopted. Adoption is
 * a mount-time RECONCILIATION, not an ongoing behaviour: leaving it armed
 * would let a poll fifteen seconds later yank the destination out from under a
 * user who is by then reading the screen, because a second tab started an
 * ingest. That is the v3.23.1 harm, and the sidebar's live markers are how
 * that case is served instead. Returns whether the selection moved.
 */
function adoptDestination(activity) {
  if (!state.destinationAdoptionPending) return false;
  state.destinationAdoptionPending = false;
  const adopt = pickAdoptableDestination(activity, state.domains, state.domain);
  if (!adopt) return false;
  state.domain = adopt;
  return true;
}

/**
 * Re-ask the server what it knows, and reconcile ONE thing: the record for the
 * currently-selected domain.
 *
 * Deliberately narrow. It touches neither the selected file, nor the domain,
 * nor this mount's own in-flight ingest — a revalidation that moved any of
 * those would be a worse bug than the staleness it fixes (views/memory.js's
 * v3.17.3 rule, applied to a screen with the same "something else is writing
 * while you watch" premise).
 */
async function refreshActivity(token) {
  if (activityInFlight) return;
  activityInFlight = true;
  try {
    const got = await fetchActivity();
    if (!isCurrentMount(token)) return;

    // A failed revalidation must NOT blank a record that is on screen and
    // still broadly true. Keep what we have and try again next tick — the
    // opposite of an initial load, where an error IS the answer.
    if (got.error) {
      state.remoteError = got.error;
      return;
    }
    state.remoteError = null;

    // Called BEFORE the record lookup below, which is keyed on `state.domain`
    // — that ordering is the point: adopting after it would leave this pass
    // showing the old domain's (absent) record for one more tick.
    const adopted = adoptDestination(got.activity);

    // Every running domain, not just the selected one — this is what the
    // sidebar rows are marked from. Recomputed on every fetch, so a run
    // finishing clears its marker on the next poll.
    state.runningDomains = runningActivityDomains(got.activity);

    // Every settled record, RAW — the acknowledgement filter is applied at read
    // time (see settledActivity in freshState) so a dismissal repaints at once
    // instead of waiting for the next poll. Recomputed on every fetch, so a
    // record ageing out of the server's 30-minute TTL clears both of its
    // surfaces without any client-side expiry logic.
    state.settledActivity = settledActivityRecords(got.activity);

    const rec = state.domain
      ? got.activity.find((a) => a && a.domain === state.domain) || null
      : null;

    const before = renderedActivitySignature;
    state.remote = rec;
    // Server clock -> this machine's clock, by subtraction only. Both figures
    // come from the same server reading, so skew cancels; see listActivity's
    // own comment for why that makes this safe where a bare timestamp is not.
    state.remotePhaseStartedAtLocal =
      rec && Number.isFinite(rec.phaseStartedAt) && Number.isFinite(got.serverNow)
        ? Date.now() - (got.serverNow - rec.phaseStartedAt)
        : null;

    const after = activitySignature();
    // An adoption repaints UNCONDITIONALLY. The signature describes the
    // activity panes, not the selection, so it is not the right instrument for
    // "the destination itself moved" — the sidebar's active row and the form's
    // picker both changed and neither is in it. Relying on the record content
    // happening to differ would be true today and silently wrong the day a
    // field leaves the signature.
    //
    // HONESTLY: this arm is DEFENCE IN DEPTH and is not independently
    // load-bearing on any path reachable today. An adoption implies a running
    // record, and record ids are UUIDs, so the signature always differs from
    // the mount's own 'none|…' and the second arm would repaint anyway. Only
    // the source guard in §14e catches its removal — recorded as such rather
    // than claimed as tested (the v3.15.1 rule for a guard whose mutation
    // stays green because a second layer is doing the work).
    if (adopted || after !== before) {
      renderedActivitySignature = after;
      render(token);
    }
    syncRemoteElapsedTimer(token);
  } finally {
    activityInFlight = false;
  }
}

/**
 * True when the SERVER says an ingest is running on the selected domain and
 * this mount is not the one running it.
 *
 * The two halves matter separately. `state.submitting` means this mount owns
 * the run and is already painting its own live progress from the SSE stream —
 * rendering the server's copy alongside it would put the same ingest on screen
 * twice, on two update cadences.
 */
function isRemoteIngestRunning() {
  return !!(state.remote && state.remote.status === 'running' && !state.submitting && !state.progress);
}

/** A settled record this viewer has not dismissed, and is not already seeing. */
function pendingRemoteOutcome() {
  const r = state.remote;
  if (!r || r.status === 'running') return null;
  // This mount is already showing its OWN outcome for the same ingest —
  // the server's copy is the same event, not a second one.
  if (state.result || state.errorMessage || state.progress || state.submitting) return null;
  if (isActivityAcked(r.id)) return null;
  return r;
}

/**
 * The reattached elapsed clock.
 *
 * Runs ONLY while a remote run is on screen, and patches #ing-remote-elapsed
 * by textContent rather than re-rendering — the same targeted-DOM-write
 * exception the live path already makes for #ing-elapsed, and for the same
 * reason: a full panel rebuild every second while nothing else changed.
 */
function syncRemoteElapsedTimer(token) {
  const wanted = isRemoteIngestRunning() && state.remotePhaseStartedAtLocal != null;
  if (!wanted) { stopRemoteElapsedTimer(); return; }
  if (remoteElapsedTimerId != null) return;
  remoteElapsedTimerId = setInterval(() => {
    if (!isCurrentMount(token) || state.remotePhaseStartedAtLocal == null) return;
    const el = document.getElementById('ing-remote-elapsed');
    if (el) el.textContent = formatElapsedMs(Date.now() - state.remotePhaseStartedAtLocal);
  }, 1000);
}

function stopRemoteElapsedTimer() {
  if (remoteElapsedTimerId != null) { clearInterval(remoteElapsedTimerId); remoteElapsedTimerId = null; }
}

function stopActivityPoll() {
  if (activityPollTimer !== null) { clearTimeout(activityPollTimer); activityPollTimer = null; }
}

/**
 * A setTimeout CHAIN, re-armed only after the previous refresh settles.
 * setInterval would queue a second fetch on top of a slow first one; this
 * structurally cannot. A hidden tab reschedules WITHOUT fetching — nobody is
 * looking, and the wake handler refreshes the moment they are.
 */
function scheduleActivityPoll(token) {
  stopActivityPoll();
  const delay = isRemoteIngestRunning() || state.submitting
    ? ACTIVITY_POLL_ACTIVE_MS
    : ACTIVITY_POLL_IDLE_MS;
  activityPollTimer = setTimeout(() => {
    activityPollTimer = null;
    if (!isCurrentMount(token)) return;
    const hidden = typeof document !== 'undefined' && document.hidden;
    if (hidden) { scheduleActivityPoll(token); return; }
    refreshActivity(token)
      .catch(() => { /* a failed poll keeps what is on screen; see refreshActivity */ })
      .finally(() => { if (isCurrentMount(token)) scheduleActivityPoll(token); });
  }, delay);
}

/**
 * Dismiss a settled record, for this viewer only.
 *
 * UI-only: no server call, and the record itself is untouched, so a second tab
 * still sees its outcome. Mirrors v3.3.1's batch Dismiss, which is also
 * client-side for the same reason.
 */
function dismissRemoteOutcome(token) {
  if (state.remote) ackActivityId(state.remote.id);
  renderedActivitySignature = activitySignature();
  render(token);
}

/**
 * Dismiss ONE settled record named by the main-pane line.
 *
 * Writes the SAME per-viewer acknowledgement `dismissRemoteOutcome` writes, so
 * the sidebar marker for that domain clears in the same render — there is one
 * dismissal store, not two that could disagree.
 *
 * Dismisses only the record it names. Clearing every settled record at once
 * would silence outcomes the user was never actually shown — the line names
 * one, so it may only speak for one. Where more remain, the count in the line
 * has already said so and the next takes its place on this very re-render.
 *
 * `renderedActivitySignature` is refreshed BEFORE `render` for the reason
 * `dismissRemoteOutcome` does the same: the signature is what the next poll
 * compares against, and leaving it stale would make that poll believe the
 * screen still needs the repaint it just did.
 */
function dismissSettledElsewhere(id, token) {
  if (!id) return;
  ackActivityId(id);
  renderedActivitySignature = activitySignature();
  render(token);
}

/**
 * Fetch + parse the destination list. ONE request shape, ONE parse, shared by
 * the initial load and by every revalidation.
 *
 * Factored out for the reason views/memory.js records for its own `fetchIndex`:
 * a revalidation that builds its own request is a second copy of the parse, and
 * two copies of a parse drift. Returns a plain result — `{ list }` or
 * `{ error }` — and writes NOTHING to `state`, so each caller decides what a
 * failure means for it. That difference is the whole point: on the initial load
 * an error IS the answer and must be shown; on a revalidation it is not, and
 * the right response is to keep what is already on screen.
 *
 * pageCount and lastIngestDate come from the SAME response
 * (GET /api/domains/stats returns them per domain — see getDomainStats in
 * src/brain/files.js). Both are optional on the wire as far as this view is
 * concerned — a missing value renders as "unknown", never as a fabricated
 * 0/date.
 */
async function fetchDomainStats() {
  try {
    const res = await fetch('/api/domains/stats');
    const data = await res.json();
    const readonly = new Set(data.readonlyDomains || []);
    return {
      list: (data.domains || [])
        .filter((d) => d && d.slug && !readonly.has(d.slug))
        .map((d) => ({
          slug: d.slug,
          displayName: d.displayName || d.slug,
          pageCount: Number.isFinite(d.pageCount) ? d.pageCount : null,
          lastIngestDate: typeof d.lastIngestDate === 'string' && d.lastIngestDate ? d.lastIngestDate : null,
        })),
    };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * The rendered identity of everything a destination-stats revalidation can
 * change. Compared before/after so a refresh that found nothing new costs no
 * render at all.
 *
 * ── WHY A SIGNATURE AND NOT JUST "RENDER AGAIN" ──────────────────────────
 * `render()` replaces BOTH panes wholesale and re-binds every listener, so an
 * unconditional re-render on every revalidation would drop the file the user
 * has staged mid-interaction out from under an open picker, and churn focus.
 * views/memory.js hit exactly this and its `screenSignature` is the pattern
 * copied here.
 *
 * ── IT IS BUILT FROM RENDERED TEXT, NOT RAW FIELDS ───────────────────────
 * `formatDestinationMeta(d)` is the string the row actually shows, so anything
 * that changes the row changes the signature and anything that does not, does
 * not. Comparing raw `pageCount` would be equivalent today and would silently
 * stop covering the row the moment the formatter learns to round or bucket.
 *
 * ── THE RECORDED FAILURE THIS AVOIDS ─────────────────────────────────────
 * memory.js: "OMITTING THIS WAS HALF THE BUG… A no-op guard that cannot see a
 * pane is not a guard for that pane." Every pane a stats revalidation can
 * change must appear here — that is the sidebar's destination rows and nothing
 * else, because `refreshDomainStats` writes only `state.domains`.
 */
function destinationsSignature() {
  return JSON.stringify(
    (state.domains || []).map((d) => [d.slug, d.displayName, formatDestinationMeta(d)])
  );
}

/**
 * Re-ask for the destination stats and repaint ONLY if they moved.
 *
 * ── THE DEFECT, MEASURED ────────────────────────────────────────────────
 * The sidebar read "Business · 59 pages" while both disk and
 * /api/domains/stats said 96. `loadDomains` had exactly ONE call site — inside
 * `onEnter` — so `state.domains` was written once per mount and never again.
 * An ingest that wrote 37 pages could not move the number sitting beside the
 * button that started it. Navigating away and back fixed it, which is the tell
 * for a mount-only load.
 *
 * ── A CORRECTION TO THE BRIEF, WORTH RECORDING ──────────────────────────
 * This was reported as "the BATCH path refreshes and the single-file path does
 * not". Reading the code, that is not so: NEITHER path refreshed. Neither
 * `applyQueueJobSnapshot` nor `attachQueueStream` nor `dismissQueuePanel` ever
 * touched `state.domains`. The batch panel merely LOOKS correct because its own
 * summary is rendered from the job snapshot off the wire, so the main column is
 * fresh while the sidebar beside it is just as stale as after a single file.
 * Both completion paths are wired below; fixing only the reported one would
 * have left the identical bug live one panel away.
 *
 * ── WHY THIS IS NOT `loadDomains` CALLED AGAIN ──────────────────────────
 * `loadDomains` unconditionally does `state.domain = list[0].slug`. Re-running
 * it to refresh counts would SNAP THE USER'S CHOSEN DESTINATION BACK TO THE
 * FIRST DOMAIN — and silently, right as they are about to write to it. It would
 * also make it a fifth writer of `state.domain`, a set
 * scripts/test-next-ingest-view.js §2 pins deliberately. This function writes
 * `state.domains` and nothing else.
 *
 * ── FAILURE IS A NO-OP, NOT A BLANK ─────────────────────────────────────
 * `loadDomains`' catch clears the list and shows an error, which is right when
 * there is nothing on screen yet. Here there IS something on screen and it was
 * true a moment ago, so a failed refresh keeps it and tries again at the next
 * user action. Blanking a populated sidebar because one poll-adjacent fetch
 * failed would be a worse bug than the staleness.
 *
 * ── NOT A POLL, DELIBERATELY ────────────────────────────────────────────
 * Every trigger rides a moment the user has already caused: an ingest they ran
 * finishing, or a destination row they clicked (whose click re-renders anyway,
 * so the fetch is free at the interaction level). memory.js needs a timer
 * because something ELSE — an agent over MCP — writes while you watch. Nothing
 * writes a domain's page count except this app, so there is nothing to poll for
 * and a timer here would be cost with no reachable benefit.
 */
async function refreshDomainStats(token) {
  if (refreshingDomainStats) return;      // cleared in `finally`
  refreshingDomainStats = true;
  try {
    const got = await fetchDomainStats();
    if (!isCurrentMount(token)) return;
    if (got.error) return;                // keep what we have — see above
    const before = destinationsSignature();
    state.domains = got.list;
    // A destination that has since disappeared must not stay selected. This is
    // NOT the `loadDomains` snap-to-first: it only fires when the current
    // selection is genuinely gone from the server's own list.
    if (state.domain && !got.list.some((d) => d.slug === state.domain)) {
      state.domain = got.list.length ? got.list[0].slug : null;
      render(token);
      return;
    }
    if (destinationsSignature() !== before) render(token);
  } finally {
    refreshingDomainStats = false;
  }
}

async function loadDomains(token) {
  // Capture the gate for THIS call. `loadGate` is module-scoped and the
  // next mount replaces it, so settling the module variable from a stale
  // in-flight load would decrement the NEXT mount's counter and hide a
  // loader that is legitimately up. A cancelled gate ignores settle(), so
  // the stale path becomes a no-op instead.
  const gate = loadGate;
  try {
    const got = await fetchDomainStats();
    if (!isCurrentMount(token)) return;
    if (got.error) throw new Error(got.error);
    const list = got.list;
    state.domains = list;
    state.domain = list.length ? list[0].slug : null;
    state.domainsError = null;
  } catch (err) {
    if (!isCurrentMount(token)) return;
    state.domains = [];
    state.domain = null;
    state.domainsError = err.message;
  } finally {
    if (isCurrentMount(token)) {
      // Delay-gated: paints straight through when the load beat the 200 ms
      // threshold, which is the measured case here (~5.5 ms).
      settleGate(gate, () => {
        state.loadingDomains = false;
        render(token);
      });
    }
  }
}

// ── Render ───────────────────────────────────────────────────────────────

function render(token) {
  renderSidebar(token);
  renderMain(token);
  wireListeners(token);
}

// The ONE place `state.domain` changes in response to a USER action. Both
// the in-form domain picker and the sidebar's destination rows call this, so the
// two controls cannot drift: there is one writer and the whole view
// re-renders from state. (Two further writers exist and are legitimate —
// applyQueueJobSnapshot and checkActiveQueueJob adopt a live job's domain,
// which is SERVER truth and must beat a local selection on a cross-mount
// reattach. scripts/test-next-ingest-view.js §2 pins the whole set.)
//
// The re-estimate branch is the behaviour ported from src/public/app.js's
// own domain-select listener and must stay attached to the WRITE, not to
// one of the controls — a domain change at the confirm gate means a
// different index size and therefore a different cost, whichever control
// the user reached for. It cannot fire once a job exists: by then
// renderQueueSection returns the panel, so neither control is on screen.
function selectDomain(slug) {
  if (!slug || slug === state.domain) return;
  state.domain = slug;
  // A real choice has now been made, so the mount's one adoption is forfeit.
  // Without this, a user who picks a destination before the first activity
  // fetch lands would have it moved out from under them by that fetch — the
  // v3.23.1 rule (a deliberate choice is never taken away) applied to the one
  // race this feature can actually lose.
  state.destinationAdoptionPending = false;
  // The activity record is PER DOMAIN, so the one on screen belongs to the
  // domain we just left. Clear it immediately — showing domain A's ingest
  // under domain B's name is a correctness bug, strictly worse than the brief
  // gap before the refetch lands (the same ordering domains.js settled on for
  // its health report in v3.11.0: KEEP on re-entry, CLEAR on a domain switch).
  state.remote = null;
  state.remotePhaseStartedAtLocal = null;
  // `state.runningDomains` is deliberately NOT cleared alongside it. `remote`
  // is mis-attributed by a domain switch — it would render under the new
  // domain's name — whereas each marker in runningDomains names its own row
  // and stays true. Clearing it would blink every marker off on each click.
  //
  // `state.settledActivity` is NOT cleared for exactly the same reason, and
  // the case is even clearer: every record in it carries its own `domain`, so
  // nothing in it can be mis-attributed by a selection change. Clearing it
  // would blank the sidebar's settled markers AND the main-pane line on every
  // click, and the line would then reappear a poll later — a flicker in the
  // one surface whose entire job is telling the user something happened.
  stopRemoteElapsedTimer();
  refreshActivity(myMountToken).catch(() => {});
  if (state.queueModeActive && !state.queueJob) {
    startQueueSelection(myMountToken);
  } else {
    render(myMountToken);
  }
}

// Is the hidden multi-file <input> currently in the DOM AND enabled? It
// lives in the MAIN column (renderIngestForm / renderQueueConfirmGate both
// emit it via renderDropZoneHtml), so a sidebar button that opens the
// picker is only honest while one of those two is what's rendered.
function isFilePickerAvailable() {
  if (state.loadingDomains || state.domainsError || !state.domains.length) return false;
  if (state.queueJob || queueJobId) return false;
  // The input is rendered with `disabled` while a single-file ingest is in
  // flight (renderDropZoneHtml({ disabled: state.submitting })), and
  // .click() on a disabled input is a native NO-OP. Measured in a real
  // browser: without this line the sidebar button stayed enabled during a
  // live ingest and did nothing when pressed — a control that looks live
  // and isn't, which is a worse state than a disabled one.
  if (state.submitting) return false;
  return true;
}

// A destination row's second line. Both numbers are the ones GET
// /api/domains/stats already returns; neither is invented when absent.
//
// "last write", NOT "last ingest": lastIngestDate is the most recent
// `## [YYYY-MM-DD]` heading in the domain's wiki/log.md, and appendLog is
// called by conversation COMPILE as well as by ingest (see
// src/brain/compile.js). Labelling a compile-only domain's date "last
// ingest" would be a small false statement on a screen whose whole job is
// telling you where material goes.
function formatDestinationMeta(d) {
  const pages = Number.isFinite(d.pageCount)
    ? (d.pageCount + ' page' + (d.pageCount === 1 ? '' : 's'))
    : 'page count unknown';
  const when = d.lastIngestDate ? ('last write ' + d.lastIngestDate) : 'nothing written yet';
  return pages + ' · ' + when;
}

function renderSidebar(token) {
  const inQueueMode = state.queueModeActive || !!state.queueJob;
  // See renderIngestForm for why the server record is ORed in (the client gate
  // is blind after a reload) and why a known ingest gets a specific sentence
  // instead of "a write is already running".
  const remoteRunning = !inQueueMode && isRemoteIngestRunning();
  const crossBusy = !inQueueMode && state.domain && !state.submitting &&
    (isDomainWriteBusy(state.domain) || remoteRunning);
  const busyNote = !crossBusy
    ? ''
    : remoteRunning
      ? '<div class="ing-sidebar-busy">' + icon('alertTriangle', 13) +
        '<span>Ingesting ' +
        (state.remote.filename ? '<span class="ing-name">' + escapeHtml(state.remote.filename) + '</span>' : 'a file') +
        ' into <span class="ing-name">' + escapeHtml(state.domain) + '</span> — ' +
        escapeHtml(state.remote.message || 'working…') + '</span></div>'
      : '<div class="ing-sidebar-busy">' + icon('alertTriangle', 13) +
        '<span>A write (' + escapeHtml(getDomainWriteLabel(state.domain) || 'write') +
        ') is already running for <span class="ing-name">' + escapeHtml(state.domain) + '</span>.</span></div>';

  const hint = inQueueMode
    ? 'Files process one at a time, so a single failure costs one file, not the whole batch. A paused or ' +
      'interrupted batch picks back up where it left off.'
    : 'One file at a time, so a failure never costs more than that one file. Each source is decomposed into ' +
      'entity, concept and summary pages and merged into what already exists.';

  const pickerAvailable = isFilePickerAvailable();
  const pickBtn =
    '<button class="btn btn-primary ing-sidebar-pick-btn" id="ing-sidebar-pick-btn"' +
      (pickerAvailable ? '' : ' disabled') + '>' +
      icon('plus', 14) + ' Choose files' +
    '</button>';

  // The destination list. Every other /next view's sidebar carries a
  // primary action plus the navigable list of what the view operates on
  // (Domains: domains; Chat: conversations; Agent memory: projects).
  // Ingest's is the DESTINATION — which domain the next file lands in.
  //
  // Rows are LOCKED (not hidden) while this view is mid-write: switching
  // destination during a single-file ingest would point the form at one
  // domain while the request in flight writes to another, and once a batch
  // job exists the server already owns the domain. Disabling states that
  // plainly; hiding the list would make the sidebar blink empty at exactly
  // the moment there's most to look at.
  const rowsLocked = state.submitting || !!state.queueJob || !!queueJobId;
  // ── THE LIVE MARKER, AND WHY IT IS THE HALF THAT ACTUALLY CLOSES THIS ──
  // `state.remote` holds the record for the SELECTED domain only, so before
  // this an ingest running anywhere else was invisible no matter how complete
  // the server's memory was — the reported "everything was gone. No message,
  // no nothing." Adopting the destination on mount (see
  // pickAdoptableDestination) rescues the moment you walk back in; this
  // rescues every other moment, because a row that is not selected can now
  // still say what it is doing.
  //
  // With it, no running ingest can be invisible whatever is selected, which
  // makes the class structurally gone rather than handled at one entry point.
  //
  // Marked on the ACTIVE row too, not just the others. A marker that vanished
  // the moment you clicked the row would read as the ingest having stopped —
  // a small false statement, and this list's whole job is telling you the
  // truth about where material goes.
  //
  // It is TEXT, not a colour or a dot: the row is a <button>, so the word ends
  // up in its accessible name ("Business, 96 pages · last write …, Ingesting")
  // and reaches a screen reader for free. v3.23.0's own finding — a health
  // count that lived on an empty span was unreachable by hover, keyboard AND
  // screen reader — is the reason that is not left to styling.
  const running = new Set(state.runningDomains || []);
  // ── THE SETTLED MARKER — the same idea, one state along ────────────────
  // A run that FINISHED while you were on another view surfaced nothing at
  // all: nothing is running, so no live marker, and `pendingRemoteOutcome` is
  // keyed on the SELECTED domain, so no outcome panel either. That is the
  // sentence the maintainer opened with — "the process ended, but there's
  // basically no way I can know if this article was ingested or not."
  //
  // ALL unacknowledged settled records are marked, not just the one the
  // main-pane line names. That is what stops this fix recreating the very
  // invisibility it removes: the line can only point at one domain, so if the
  // sidebar showed only that one, a second finished run would be exactly as
  // unfindable as before. Here the set is complete and dismissing one promotes
  // the next into the line.
  //
  // DONE AND FAILED ARE DIFFERENT WORDS, and that is not decoration. The
  // question being answered is literally "was this ingested or not", so a run
  // that FAILED must not be reported with the word a successful one uses. One
  // shared neutral label would make the marker answer a different question
  // from the one asked.
  //
  // Clicking the row selects that domain, at which point the EXISTING
  // `renderRemoteOutcome` panel renders the full result — page list, warnings,
  // token usage, Dismiss. No second outcome panel is built: this marker is a
  // POINTER to the one that already exists.
  //
  // Marked on the ACTIVE row too, for the reason the live marker records
  // directly above: a marker that vanished the instant you clicked would read
  // as the thing having gone away. Here the outcome panel appears in the same
  // beat, so the row and the panel agree until the user dismisses, which
  // clears both at once.
  //
  // TEXT, not a dot, so it reaches the row's accessible name — same v3.23.0
  // finding as above.
  const settledByDomain = new Map();
  for (const rec of unackedSettledRecords()) {
    // Newest-finished first (settledActivityRecords sorts), so the FIRST record
    // seen for a domain is the one to describe; a later, older one must not
    // overwrite it.
    if (!settledByDomain.has(rec.domain)) settledByDomain.set(rec.domain, rec);
  }
  const rows = state.domains.map((d) => {
    const isActive = d.slug === state.domain;
    const isRunning = running.has(d.slug);
    // A domain that is running again is described as RUNNING, not as settled.
    // The live state is the more urgent truth and the newer one, and showing
    // both words on one row would make it say two things at once.
    const settledRec = isRunning ? null : settledByDomain.get(d.slug) || null;
    return (
      '<button type="button" class="ing-dest-row' + (isActive ? ' active' : '') + '"' +
        ' data-dest-slug="' + escapeHtml(d.slug) + '"' +
        (rowsLocked ? ' disabled' : '') +
        (isActive ? ' aria-current="true"' : '') + '>' +
        '<span class="ing-dest-main">' +
          '<span class="ing-dest-name">' + escapeHtml(d.displayName || d.slug) + '</span>' +
          '<span class="ing-dest-meta">' + escapeHtml(formatDestinationMeta(d)) + '</span>' +
        '</span>' +
        (isRunning ? '<span class="ing-dest-live">Ingesting</span>' : '') +
        (settledRec
          ? '<span class="ing-dest-settled' + (settledRec.status === 'error' ? ' failed' : '') + '">' +
              (settledRec.status === 'error' ? 'Failed' : 'Ingested') +
            '</span>'
          : '') +
        (isActive ? '<span class="ing-dest-mark" aria-hidden="true">' + icon('check', 13) + '</span>' : '') +
      '</button>'
    );
  }).join('');

  const listBlock = state.domains.length
    ? '<div class="cur-eyebrow" style="margin-top:10px">DESTINATION</div>' +
      '<div class="ing-dest-list">' + rows + '</div>'
    : '';

  // RELOCATED. The hint explains the failure-isolation model and, in queue
  // mode, that an interrupted batch resumes — neither is stated anywhere
  // else on screen, so it is kept rather than cut. It is no longer a
  // paragraph floating under the sidebar title: renderViewHeader puts it
  // behind the info mark, in a panel that is hidden on first paint. It also
  // left `.sidebar-hint`, which AT THE TIME painted --text-3 — measured 4.27
  // dark / 4.14 light, under the 4.5 AA floor — for the panel's --text-2.
  // (That contrast argument has since been retired at the source: shell.css
  // now paints `.sidebar-hint` --text-2 too, so the relocation stands on the
  // "no prose floating under a title" reason alone. Recorded rather than
  // deleted — the number was true when the move was made.)
  setSidebar(
    renderViewHeader({ variant: 'sidebar', title: 'Ingest', info: hint, infoId: 'tx-vh-info-ingest-sidebar' }) +
    pickBtn +
    listBlock +
    busyNote,
    token
  );

  // setSidebar is a no-op on a stale mount, so binding after it would
  // otherwise attach a SECOND set of listeners to the sidebar DOM the
  // previous mount left standing. Same guard shape as
  // renderSidebarConversationsOnly in views/chat.js, for the same reason.
  if (!isCurrentMount(token)) return;

  const pickBtnEl = document.getElementById('ing-sidebar-pick-btn');
  if (pickBtnEl) {
    pickBtnEl.addEventListener('click', () => document.getElementById('ing-file-input')?.click());
  }
  document.querySelectorAll('.ing-dest-row[data-dest-slug]').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectDomain(btn.dataset.destSlug);
      // Revalidate on the action the user has already taken — views/memory.js's
      // `revalidateIndex` pattern. Picking a destination re-renders this pane
      // anyway, so the refresh costs the user nothing they can perceive, and it
      // is the moment they are most likely to be reading the page count they
      // are about to write into. Fired for EVERY click, including a re-click on
      // the already-selected row, because `selectDomain` early-returns on that
      // one and a user clicking the row again is plainly asking to see it
      // afresh. Never awaited: a click must not wait on the network.
      refreshDomainStats(myMountToken).catch(() => {});
    });
  });
}

function renderMain(token) {
  let body;
  if (state.loadingDomains) {
    body = gatedLoader(loadGate, 'Loading domains…');
  } else if (state.domainsError) {
    body = renderStatus({ state: 'danger', title: 'Could not load domains', detail: state.domainsError });
  } else if (!state.domains.length) {
    body = emptyCard({
      title: 'No domains to ingest into yet',
      body: 'Create a domain from the Domains view first, then come back here to add a source to it.',
    });
  } else if (state.queueModeActive || state.queueJob) {
    body = renderQueueSection();
  } else {
    body = renderIngestForm();
  }

  // CUT, not relocated. Every clause of the deleted sentence was already on
  // screen, simultaneously, in the drop zone directly beneath it: "Drop a
  // source here", an accepted-extension list built from the same ALLOWED_EXT
  // constant, and "2 or more files at once starts a batch". Relocating it
  // behind the info mark would have preserved a duplicate; the one clause not
  // restated below — that the wiki updates automatically — is what the Ingest
  // button does and is demonstrated by pressing it.
  //
  // The `acceptList` / `accepts` pair that built the extension list for that
  // sentence went WITH it. It had no other reader: renderDropZoneHtml derives
  // its own list from ALLOWED_EXT in its own body, which is what
  // scripts/test-next-ingest-view.js asserts. Leaving the pair here would have
  // been an unread computation over the very constant whose single-source-of-
  // truth the deleted comment was about.
  // ABOVE `body`, and OUTSIDE the branch that produced it — deliberately.
  // `body` is one of five things (loader, domains error, empty state, queue,
  // form), and a run finishing elsewhere is equally true in all of them. Put
  // inside renderIngestForm it would vanish the moment the user entered batch
  // mode, which is precisely a moment they are likely to be mid-workflow and
  // away from where the last file landed. It self-suppresses when there is
  // nothing to say, so the loading and error frames are unaffected.
  setMain(
    renderViewHeader({ eyebrow: 'the way material gets in', title: 'Ingest' }) +
    renderSettledElsewhere() +
    body,
    token
  );
}

/**
 * The domain picker's whole description, in ONE place.
 *
 * ── WHY THIS IS A FUNCTION AND NOT TWO LITERALS ─────────────────────────
 * The same control is rendered by the single-file form AND by the batch
 * confirm gate. They previously carried two hand-written copies of the same
 * <option> loop; the copies happened to agree, which is the state every pair
 * of copies is in right up until one of them is edited. One builder, called
 * twice, and the two surfaces cannot describe different domains.
 *
 * ── READ-ONLY MIRRORS STAY OUT, AND THAT IS NOT DECORATION ──────────────
 * `state.domains` is already filtered upstream of this view (a Shared Brain
 * `shared-*` mirror is excluded from the ingest destination list, and the
 * route refuses one anyway). This builder does not re-derive that list — it
 * consumes it — so there is exactly one place the exclusion is decided and
 * this control cannot reintroduce a domain the loader deliberately dropped.
 *
 * `disabled` is passed in rather than read from state so the confirm gate,
 * which is never mid-submit, does not have to reason about a flag that
 * belongs to the other surface.
 */
function domainListboxCfg({ disabled = false } = {}) {
  return {
    id: 'ing-domain',
    ariaLabel: 'Domain',
    value: state.domain,
    disabled: !!disabled,
    rootClass: 'lb-block',
    triggerClass: 'lb-field',
    placeholder: 'Choose a domain…',
    options: state.domains.map((d) => ({ value: d.slug, label: d.displayName })),
    onChange: (value) => selectDomain(value),
  };
}

function renderIngestForm() {
  // TWO sources of "this domain is busy", and they are not redundant.
  //
  // isDomainWriteBusy is app.js's CLIENT-SIDE gate: accurate for anything this
  // browser tab started and still owns, and blind after a reload or in a
  // second tab, because it lives in a module variable that a page load resets.
  // The SERVER record is what survives all three. After F5 mid-ingest the gate
  // reads false while the write is genuinely still running, so without the OR
  // the Ingest button would look live, and pressing it would send a second
  // upload that the per-domain file lock refuses — an error the user has no
  // way to have predicted.
  //
  // Deliberately NOT done here: teaching app.js's gate about server truth.
  // That is a shell-level change affecting every view that reads the gate, and
  // this is one view's own button. The narrower fix is the honest one to make
  // from inside this file.
  const remoteRunning = isRemoteIngestRunning();
  const crossBusy = state.domain && !state.submitting && (isDomainWriteBusy(state.domain) || remoteRunning);
  const btnDisabled = !state.file || !!state.fileError || state.submitting || crossBusy || !state.domain;

  // ── WHY INGEST IS GREYED OUT IS VISIBLE TEXT, NOT A TOOLTIP ────────────
  // This was a `title=` on the Ingest button, set on exactly the condition
  // (`crossBusy`) that also sets `disabled`. A disabled button is not in the
  // tab order, so the sentence was unreachable by keyboard and, with no hover
  // on touch, did not exist there at all — and nothing else in this view says
  // it. Ingest is the app's most expensive action; "why can I not press this"
  // is not a detail to put behind a mouse.
  //
  // renderStatus, unfolded, directly above the button — the same treatment
  // settings.js gives the identical message (renderCrossWriteBanner) and the
  // same rule v3.22.0 applied when it refused to fold a data-loss warning
  // behind the header's info mark.
  //
  // WHEN WE KNOW WHAT IS RUNNING, WE SAY WHAT IS RUNNING. The generic sentence
  // below is the whole of what the reported screenshot showed — "A write
  // (ingest) is already running for domain 'articles'" — which names neither
  // the file, nor the phase, nor how long it has been going, on the one screen
  // whose premise is that something else is writing while you watch. When a
  // server record exists, renderRemoteProgress replaces this outright with the
  // real ring, the real phase and the real clock. The generic note remains for
  // the case it was actually written for: a write of some OTHER kind (a Sync
  // push, a Shared Brain pull) that this store knows nothing about.
  const crossBusyNote = (crossBusy && !remoteRunning)
    ? '<div class="ing-status-block">' +
        renderStatus({
          state: 'attention',
          title: 'Waiting on another write in this domain',
          detail: 'A write (' + (getDomainWriteLabel(state.domain) || 'write') +
            ') is already running for domain "' + state.domain +
            '" — wait for it to finish, or switch to a different domain.',
        }) +
      '</div>'
    : '';

  return (
    '<div class="ing-field">' +
      '<span class="ing-label" id="ing-domain-label">Domain</span>' +
      renderListboxHtml(domainListboxCfg({ disabled: state.submitting })) +
    '</div>' +
    '<div class="ing-field">' +
      '<label class="ing-label" for="ing-file-input">File</label>' +
      renderDropZoneHtml({ disabled: state.submitting, multiHint: true }) +
      (state.file ? '<span class="ing-file-name">' + escapeHtml(state.file.name) + '</span>' : '') +
      (state.fileError ? '<div class="ing-field-error">' + escapeHtml(state.fileError) + '</div>' : '') +
    '</div>' +
    // sparkles marks a token-spending action (design rule) — ingest always
    // calls an LLM. The design pairs sparkles with a cost figure in the
    // label; single-file has no estimate today (only the batch confirm
    // gate calls POST /api/ingest-queue/estimate), so the mark is present
    // here without one — a known, deliberate gap, not an oversight, while
    // whether to add a single-file estimate is decided separately.
    crossBusyNote +
    '<button type="button" class="btn btn-primary" id="ing-submit-btn"' +
      (btnDisabled ? ' disabled' : '') + '>' +
      icon('sparkles', 14) + ' ' + (state.submitting ? 'Ingesting…' : 'Ingest') +
    '</button>' +
    renderProgress() +
    renderRemoteProgress() +
    renderRemoteOutcome() +
    renderDuplicate() +
    (state.errorMessage
      ? '<div class="ing-status-block">' +
          renderStatus({ state: 'danger', title: 'Ingest failed', detail: state.errorMessage }) +
        '</div>'
      : '') +
    renderResult()
  );
}

// Shared by the single-file idle form AND the batch confirm gate — both
// need an identically-behaved drop zone / hidden multi-file input; only
// the surrounding context differs. `multiHint` swaps the helper text to
// mention batching (shown only in the single-file idle state, where a
// user might not know dropping 2+ files does something different).
function renderDropZoneHtml({ disabled, multiHint }) {
  // ── BOTH SENTENCES ARE IN THE MARKUP AT ONCE, AND CSS PICKS ONE ────────
  //
  // Drag-over is a DIFFERENT sentence, not a restyle of the same one: the
  // idle copy tells you what this surface takes, the active copy tells you
  // what letting go will do. Both are one line; nothing reflows the panel.
  //
  // They used to be chosen HERE, off `state.dragActive`, which meant the
  // copy could only change by re-rendering — and re-rendering is what broke
  // drag-and-drop outright in the Mac app (see wireListeners' drag block for
  // the full account: setMain() replaces #view-root's innerHTML, so the very
  // node the pointer is holding a file over was destroyed on the first
  // dragover). Emitting both spans and letting `.ing-drop-zone-active` in
  // ingest.css decide which is visible means the ONLY thing a drag has to
  // change is one class on the zone's root element. Nothing under the cursor
  // is destroyed, replaced, or even mutated — and in particular the
  // `<label for="ing-file-input">` inside `.ing-drop-sub` survives, which an
  // innerHTML swap of that line would not have.
  //
  // `state.dragActive` still decides the ROOT CLASS, so a render that
  // happens for an unrelated reason mid-drag (a write-gate change, a poll)
  // repaints the zone in the state the drag is actually in rather than
  // snapping it back to idle.
  const idleHeadline = multiHint ? 'Drop a source here' : 'Drop more files here';

  // ALLOWED_EXT is the same array pickSingleFile validates against, so this
  // line cannot claim a format the picker would then refuse. Rendered from
  // the constant rather than typed out, for exactly that reason.
  const formats = ALLOWED_EXT
    .map((ext) => '<span class="mono">' + escapeHtml(ext) + '</span>')
    .join(' · ');

  const batchHint = multiHint
    ? '<div class="ing-drop-batch-hint">2 or more files at once starts a batch</div>'
    : '<div class="ing-drop-batch-hint">Dropping more files adds them to the batch you already started</div>';

  return (
    '<div class="ing-drop-zone' + (state.dragActive ? ' ing-drop-zone-active' : '') + '" id="ing-drop-zone"' +
      ' role="button" tabindex="0"' +
      // The accessible name follows the surface. At the confirm gate this
      // control ADDS to a batch that already exists, and announcing it as
      // "choose a file to ingest" there described a different control.
      ' aria-label="' + (multiHint
        ? 'Choose a file to ingest, or drop one here'
        : 'Choose more files to add to this batch, or drop them here') + '">' +
      '<span class="ing-drop-icon">' + icon('upload', 26) + '</span>' +
      '<div class="ing-drop-headline">' +
        '<span class="ing-drop-idle">' + escapeHtml(idleHeadline) + '</span>' +
        '<span class="ing-drop-hot">Release to add</span>' +
      '</div>' +
      '<div class="ing-drop-sub">' +
        'or <label for="ing-file-input" class="ing-browse-link">browse your files</label>' +
      '</div>' +
      '<div class="ing-drop-formats">Accepts ' + formats + '</div>' +
      batchHint +
      '<input type="file" id="ing-file-input" accept=".txt,.md,.pdf" multiple hidden' + (disabled ? ' disabled' : '') + ' />' +
    '</div>'
  );
}

function renderProgress() {
  if (!state.progress) return '';
  const p = state.progress;
  const elapsedNow = p.phaseStartedAt ? formatElapsedMs(Date.now() - p.phaseStartedAt) : '';
  const pct = Number.isFinite(p.pct) ? Math.max(0, Math.min(100, p.pct)) : 0;
  // "Results are specific" (design principle): the terminal label is built
  // by formatIngestDoneLabelHtml from real counts + a byte delta — never
  // the literal word "Done!" — so it already carries its own <span
  // class="ing-num"> around every number. Every OTHER progress label is a
  // plain server-sent phase message (e.g. "AI is analyzing the
  // document…") with no numbers to mark up, so it stays plain escaped text.
  const labelContent = p.labelHtml ? p.labelHtml : escapeHtml(p.label || 'Working…');

  // The bar is gone; the ring takes over its visual role. NOTHING ELSE
  // moves: the pct readout, the elapsed clock (same #ing-elapsed id, still
  // patched by textContent from the interval — see runIngest), the amber
  // retry state and the "this isn't stuck" note are all still here, they
  // have just been rearranged around the ring.
  //
  // Stage/stageProgress come from mapIngestPctToStage and from nothing
  // else. During Planning — one LLM call, no sub-progress, the phase
  // v3.0.17 was reported as hung on — the map returns stageProgress 0, so
  // that segment sits EMPTY while the orbit keeps turning. That is the
  // whole point of the component and must not be "improved".
  const { stage, stageProgress } = mapIngestPctToStage(pct);
  const stageOrdinal = Math.min(stage + 1, INGEST_STAGES.length);

  // ── ONE QUANTITY, ONE NUMBER — THE THREE-FIGURE DEFECT ──────────────────
  // MEASURED: at one instant, on one single-file ingest, this block put THREE
  // disagreeing figures on screen together — a centre counter reading "2/5",
  // a ring reporting aria-valuenow=40, and this sublabel reading
  // "stage 3 of 5 · 15%". Sampled twice, 150 ms apart; not a race — the render
  // is a pure function of `state.progress.pct` and all three were derived from
  // the same 15. They disagreed because they were expressed on THREE DIFFERENT
  // SCALES:
  //
  //   "2/5"          completed stages           (ringCenterText)
  //   40             stage-space, (stage+frac)/n (ringAria, and the ring FILL)
  //   "stage 3 of 5" the IN-FLIGHT stage        (stage + 1, here)
  //   "15%"          the server's RAW pct        (here, unmapped)
  //
  // The last is the root cause. `mapIngestPctToStage` bands the pct axis
  // NON-UNIFORMLY (>=90 -> 4, >=20 -> 3, >=10 -> 2, >=8 -> 1) onto five EQUAL
  // ring segments, so raw pct and stage-space can only ever coincide at 0 and
  // 100. Printing the raw pct beside a ring drawn in stage-space was showing
  // two incompatible axes as if they were one measurement.
  //
  // THE FIX IS A SINGLE DERIVATION, NOT A RECONCILIATION. `stage` and
  // `stageProgress` are the one source of truth; the percentage is now taken
  // from `ringAria` — the SAME function `progressRingHtml` calls to stamp
  // `aria-valuenow`, given the same three fields — so the number a sighted user
  // reads and the number a screen reader announces are one computation, not two
  // that happen to agree. Recomputing `(stage+frac)/n*100` inline here would
  // have been a fourth copy of the arithmetic and is exactly how this started.
  //
  // AND THE STAGE IS STATED ONCE. The ring's centre glyph is suppressed
  // (`center: 'none'` below) because "2/5" is a THIRD framing of the same
  // quantity, and an ambiguous one: `ringCenterText` prints the completed count
  // while a stage sits at frac 0 but the in-flight count once frac > 0, so it
  // means different things at different moments. The sublabel's ordinal is
  // unambiguous (always the running stage, matching the phase name in the label
  // beside it), so that is the one kept. The segments and the orbit still carry
  // the whole visual; nothing about the ring's honesty changes.
  //
  // WHAT IS DELIBERATELY NOT DONE: the ring is NOT made to move more smoothly.
  // v3.9.0's rule stands — a live stage reporting stageProgress 0 shows an EMPTY
  // segment, and Planning (one LLM call, no sub-progress, the phase v3.0.17 was
  // reported as hung on) is exactly that. The figures now agree because they
  // share a derivation, not because motion was invented to make them line up.
  const shownPct = ringAria({ stages: INGEST_STAGES, stage, stageProgress }).valueNow;
  const sublabelHtml =
    (pct >= 100
      ? 'finished'
      : 'stage <span class="ing-num">' + stageOrdinal + '</span> of <span class="ing-num">' + INGEST_STAGES.length + '</span>') +
    ' · <span class="ing-num" id="ing-elapsed">' + escapeHtml(elapsedNow) + '</span>' +
    ' · <span class="ing-num">' + shownPct + '%</span>';

  return (
    '<div class="ing-progress">' +
      progressRingHtml({
        stages: INGEST_STAGES,
        stage,
        stageProgress,
        size: 48,
        // The stage is stated ONCE, in the sublabel — see the block above.
        // 'auto' would print a centre "2/5" here, a third framing of the same
        // quantity on a scale that matches neither the sublabel's ordinal nor
        // its percentage. `center: 'none'` is the component's own supported
        // option (domains.js:1916, and the queue panel at :2108 below).
        center: 'none',
        // waiting === a retry/backoff sub-event, which re-sends the SAME
        // pct — so the ring correctly does not advance, and amber says why.
        tone: pct >= 100 ? 'success' : (p.waiting ? 'attention' : 'accent'),
        labelHtml: labelContent,
        sublabelHtml,
        className: 'ing-progress-ring',
      }) +
      '<div class="ing-progress-note">Large documents can take a minute or more per phase — especially planning. The timer keeps ticking while the AI works; it isn’t stuck.</div>' +
    '</div>'
  );
}

// "Results are specific" (design principle, verbatim): never "Done!" —
// `Wrote 7 new pages · updated 4 existing · +6.1 KB`. Built from the same
// `finalData.changes` the change-records panel below already uses, so the
// transient 100%-label and the full result panel can never disagree about
// what happened. Every number is wrapped in its own mono span — the design
// is explicit that numbers are always monospace and always exact, and this
// is prose with numbers embedded in it, not a table cell, so each number
// needs its own span rather than one blanket .mono on the whole line.
function formatIngestDoneLabelHtml(changes) {
  const list = Array.isArray(changes) ? changes : [];
  const created = list.filter((c) => c && c.status === 'created').length;
  const updated = list.filter((c) => c && c.status === 'updated').length;
  const deltaBytes = list.reduce((sum, c) => {
    if (!c) return sum;
    const before = Number.isFinite(c.bytesBefore) ? c.bytesBefore : 0;
    const after = Number.isFinite(c.bytesAfter) ? c.bytesAfter : 0;
    return sum + (after - before);
  }, 0);
  const mono = (n) => '<span class="ing-num">' + n + '</span>';
  const parts = [];
  if (created > 0) parts.push('Wrote ' + mono(created) + ' new ' + (created === 1 ? 'page' : 'pages'));
  if (updated > 0) parts.push('updated ' + mono(updated) + ' existing');
  if (!parts.length) parts.push('No pages changed');
  const deltaLabel = formatByteDeltaLabel(deltaBytes);
  if (deltaLabel) parts.push(mono(deltaLabel));
  return parts.join(' · ');
}

// +6.1 KB / −340 B / null (omitted entirely) when the byte total is
// genuinely unchanged — e.g. a re-ingest of byte-identical content — since
// "+0 B" reads as a claim that something happened when nothing did.
function formatByteDeltaLabel(n) {
  if (!Number.isFinite(n) || n === 0) return null;
  const sign = n > 0 ? '+' : '−';
  const abs = Math.abs(n);
  return sign + (abs < 1024 ? (abs + ' B') : ((abs / 1024).toFixed(1) + ' KB'));
}

/**
 * The REATTACHED progress view: a run this mount is not watching, painted
 * from what the server remembers.
 *
 * Uses the SAME ring, the SAME stage map and the SAME elapsed format as the
 * live path — deliberately, because a user who navigates away and back is
 * looking at one ingest, not two, and a second visual vocabulary for it would
 * be a worse answer than the generic amber note it replaces. What differs is
 * only where the numbers come from (a poll rather than an SSE stream) and the
 * clock's anchor (`remotePhaseStartedAtLocal`, converted once per fetch).
 *
 * The file name is here and the old note had none: "an ingest is running" is
 * not the question a returning user has. "Is THIS article in?" is.
 */
function renderRemoteProgress() {
  if (!isRemoteIngestRunning()) return '';
  const r = state.remote;
  const pct = Number.isFinite(r.pct) ? Math.max(0, Math.min(100, r.pct)) : 0;
  const { stage, stageProgress } = mapIngestPctToStage(pct);
  const stageOrdinal = Math.min(stage + 1, INGEST_STAGES.length);
  const elapsedNow = state.remotePhaseStartedAtLocal != null
    ? formatElapsedMs(Date.now() - state.remotePhaseStartedAtLocal)
    : '';
  // ONE quantity, ONE number — the shownPct comes from ringAria, the same
  // function progressRingHtml calls to stamp aria-valuenow, exactly as the
  // live path does. Recomputing it here would be a second copy of the
  // arithmetic and is precisely how the three-figure defect started.
  const shownPct = ringAria({ stages: INGEST_STAGES, stage, stageProgress }).valueNow;
  const sublabelHtml =
    'stage <span class="ing-num">' + stageOrdinal + '</span> of <span class="ing-num">' + INGEST_STAGES.length + '</span>' +
    ' · <span class="ing-num" id="ing-remote-elapsed">' + escapeHtml(elapsedNow) + '</span>' +
    ' · <span class="ing-num">' + shownPct + '%</span>';

  return (
    '<div class="ing-status-block">' +
      renderStatus({
        state: 'attention',
        title: 'An ingest is already running in this domain',
        detail: 'Started here or in another tab. It keeps running whether or not this view is open — ' +
                'the result will appear below when it finishes.',
      }) +
    '</div>' +
    '<div class="ing-progress ing-progress-remote">' +
      (r.filename
        ? '<div class="ing-remote-file">Ingesting <strong class="ing-name">' + escapeHtml(r.filename) + '</strong> into <span class="ing-name">' + escapeHtml(r.domain) + '</span></div>'
        : '') +
      progressRingHtml({
        stages: INGEST_STAGES,
        stage,
        stageProgress,
        size: 48,
        center: 'none',
        // waiting === a retry/backoff sub-event, which re-sends the SAME pct —
        // so the ring correctly does not advance, and amber says why.
        tone: r.waiting ? 'attention' : 'accent',
        labelHtml: escapeHtml(r.message || 'Working…'),
        sublabelHtml,
        className: 'ing-progress-ring',
      }) +
      '<div class="ing-progress-note">Large documents can take a minute or more per phase — especially planning. The timer keeps ticking while the AI works; it isn’t stuck.</div>' +
    '</div>'
  );
}

/**
 * One line saying an ingest finished somewhere ELSE, with a control that takes
 * you there.
 *
 * ── WHY A LINE AND NOT ONLY A MARKER ────────────────────────────────────
 * The sidebar marker (see renderSidebar) is AMBIENT — it is true, it is
 * complete, and it is entirely dependent on the user happening to look left.
 * The complaint being answered is that NOTHING TOLD HIM. A marker he may not
 * look at is an improvement on silence; it is not an answer to it. This line
 * sits in the pane he is already reading, in the same column as the form he
 * just used, and names the domain in words.
 *
 * ── WHY THIS DOES NOT ADOPT THE DOMAIN ──────────────────────────────────
 * The obvious move — do what `adoptDestination` does, but for settled records
 * — was considered and REJECTED, and the reasoning is worth keeping because it
 * is not obvious. A terminal record lives for `TERMINAL_TTL_MS` (30 minutes,
 * `src/brain/ingest-activity.js`). Adoption fires once per mount, so within
 * that half hour EVERY visit to Ingest would yank the destination onto a run
 * that has already finished — including the visit where the user came to
 * ingest something else, into the domain the picker is already showing. The
 * running case does not have that problem: a running record means work is
 * happening NOW, and it ends when the work ends.
 *
 * So this OFFERS the move instead of making it. One click, the user's choice,
 * and `selectDomain` then does what it always does.
 *
 * ── CHOOSING AMONG SEVERAL, AND WHY NOTHING BECOMES UNREACHABLE ─────────
 * The maintainer genuinely ran two concurrent ingests, so "the finished one" is
 * under-specified. The line names the record with the LATEST `finishedAt`
 * (ties on domain ascending — see settledActivityRecords for why that ordering
 * is total and stable), and states how many others there are.
 *
 * That is safe ONLY because the sidebar marks every one of them. The line is a
 * rotating pointer over a set that is fully enumerated elsewhere: dismiss the
 * named one and the next takes its place, select it and its own panel opens.
 * A line that named one record while the others were invisible would be this
 * defect with a smaller blast radius, not a fix for it.
 *
 * ── DISMISSAL ──────────────────────────────────────────────────────────
 * The same per-viewer acknowledgement the outcome panel writes
 * (`ackActivityId`) — ONE store, so dismissing here also clears the sidebar
 * marker, and dismissing in the panel also clears this line. There is
 * deliberately no second dismissal state to keep in step.
 *
 * Dismiss is offered rather than forcing a visit, because the alternative is a
 * notice that can only be silenced by navigating somewhere the user may not
 * care about — a notice you cannot put down is the opposite failure to the one
 * being fixed.
 */
function renderSettledElsewhere() {
  const pending = settledElsewhere();
  if (!pending.length) return '';
  const top = pending[0];
  const others = pending.length - 1;
  const failed = top.status === 'error';

  const label = state.domains.find((d) => d && d.slug === top.domain);
  const shown = (label && label.displayName) || top.domain;

  return (
    '<div class="ing-settled-elsewhere' + (failed ? ' failed' : '') + '" role="status">' +
      '<span class="ing-settled-elsewhere-text">' +
        (failed ? 'An ingest failed in ' : 'An ingest finished in ') +
        '<strong>' + escapeHtml(shown) + '</strong>' +
        (top.filename ? ' · <span class="ing-name">' + escapeHtml(top.filename) + '</span>' : '') +
        (others > 0
          ? ' <span class="ing-settled-elsewhere-more">and ' + others +
            ' more ' + (others === 1 ? 'domain' : 'domains') + '</span>'
          : '') +
      '</span>' +
      '<span class="ing-settled-elsewhere-actions">' +
        '<button type="button" class="btn btn-secondary btn-xs" data-settled-show="' +
          escapeHtml(top.domain) + '">Show me</button>' +
        '<button type="button" class="btn btn-ghost btn-xs" data-settled-dismiss="' +
          escapeHtml(top.id) + '">Dismiss</button>' +
      '</span>' +
    '</div>'
  );
}

/**
 * The RESTORED outcome: an ingest that finished while nobody was watching.
 *
 * This is the half of the report that had nothing at all — "the process ended,
 * but there's basically no way I can know if this article was ingested or not."
 * Dismiss is per-viewer and client-side (see ackActivityId), so a second tab
 * still gets told.
 *
 * Covers the SELECTED domain only, deliberately — `renderSettledElsewhere`
 * handles every other domain by pointing back at this panel rather than
 * duplicating it.
 */
function renderRemoteOutcome() {
  const r = pendingRemoteOutcome();
  if (!r) return '';

  const header =
    '<div class="ing-remote-outcome-head">' +
      '<span class="ing-remote-outcome-when">Finished while you were away' +
        (r.filename ? ' · <span class="ing-name">' + escapeHtml(r.filename) + '</span>' : '') +
      '</span>' +
      '<button type="button" class="btn btn-ghost btn-xs" id="ing-remote-dismiss">Dismiss</button>' +
    '</div>';

  if (r.status === 'error') {
    return (
      '<div class="ing-remote-outcome">' + header +
        '<div class="ing-status-block">' +
          renderStatus({
            state: 'danger',
            title: 'Ingest failed',
            detail: r.error || 'The ingest did not complete.',
          }) +
        '</div>' +
      '</div>'
    );
  }

  // Same builder as the live panel — see renderResultBodyHtml.
  return (
    '<div class="ing-remote-outcome">' + header +
      renderResultBodyHtml(r.result || {}, state.remoteResultExpanded, 'ing-remote-unchanged-toggle') +
    '</div>'
  );
}

function renderDuplicate() {
  if (!state.duplicate) return '';
  return (
    '<div class="ing-duplicate">' +
      icon('alertTriangle', 15) +
      '<div class="ing-duplicate-body">' +
        '<strong>' + escapeHtml(state.duplicate.filename) + '</strong> has already been ingested into this domain.' +
        '<div class="ing-duplicate-actions">' +
          '<button type="button" class="btn btn-secondary btn-xs" id="ing-dup-overwrite">Re-ingest &amp; update wiki</button>' +
          '<button type="button" class="btn btn-ghost btn-xs" id="ing-dup-cancel">Cancel</button>' +
        '</div>' +
      '</div>' +
    '</div>'
  );
}

function renderResult() {
  if (!state.result) return '';
  return renderResultBodyHtml(state.result, state.result.unchangedExpanded, 'ing-unchanged-toggle');
}

/**
 * The outcome panel's markup, from a result-shaped object.
 *
 * Factored out so the LIVE result (this mount watched the ingest finish) and
 * the RESTORED one (the server remembered it while nobody was watching) are
 * ONE builder rather than two. They describe the same event, and two
 * hand-maintained copies of one panel is this repo's named drift shape — the
 * copies agree right up until one of them is edited.
 *
 * The restored record carries `changesTotal` / `warningsTotal` alongside the
 * (capped) arrays. Where they disagree the panel SAYS SO rather than silently
 * rendering the shorter list: counts derived from a quietly-shortened array
 * under-state the user's own ingest, which is the dishonest direction.
 */
function renderResultBodyHtml(r, unchangedExpanded, toggleId) {
  const titlePrefix = r.wasOverwrite ? 'Re-ingested:' : 'Ingested:';
  const warningsHtml = renderWarningsHtml(r.warnings);
  const changesHtml = renderChangeRecordsHtml(r.changes, titlePrefix + ' ' + (r.title || ''), unchangedExpanded, toggleId);
  const fallbackHtml = (!r.changes || !r.changes.length)
    ? '<ul class="ing-change-list-flat">' + (r.pagesWritten || []).map((p) => '<li class="ing-name">' + escapeHtml(p) + '</li>').join('') + '</ul>'
    : '';
  const tokenHtml = formatTokenUsageHtml(r.tokenUsage);
  const shownChanges = Array.isArray(r.changes) ? r.changes.length : 0;
  const truncNote = (Number.isFinite(r.changesTotal) && r.changesTotal > shownChanges)
    ? '<div class="ing-change-empty">Showing <span class="ing-num">' + shownChanges +
      '</span> of <span class="ing-num">' + r.changesTotal + '</span> changed pages — the rest were not kept in this summary.</div>'
    : '';
  return (
    '<div class="ing-result">' +
      warningsHtml +
      (r.changes && r.changes.length ? changesHtml : ('<h3 class="ing-result-title">' + escapeHtml(titlePrefix + ' ' + (r.title || '')) + '</h3>' + fallbackHtml)) +
      truncNote +
      tokenHtml +
    '</div>'
  );
}

// ── Change records (ported from src/public/app.js's renderChangeRecords —
//    same field contract, same created/updated/unchanged split with
//    unchanged collapsed by default; rebuilt as a pure string+toggle-state
//    function to match this shell's render-from-state convention instead
//    of app.js's DOM-mutation-in-place one). ─────────────────────────────

function formatBytesLocal(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  return (n / 1024).toFixed(1) + ' KB';
}

// `toggleId` defaults to the live path's original literal, so that call site
// is byte-unchanged. The RESTORED result (see renderRemoteOutcome) needs its
// own id because it has its own fold state — two controls sharing one id is
// invalid HTML and, worse, would make a click on either flip whichever one
// getElementById happened to find first.
function renderChangeRecordsHtml(changes, title, unchangedExpanded, toggleId = 'ing-unchanged-toggle') {
  const created = changes.filter((c) => c.status === 'created');
  const updated = changes.filter((c) => c.status === 'updated');
  const unchanged = changes.filter((c) => c.status === 'unchanged');

  const formatRecord = (c) => {
    let detail = '';
    if (c.status === 'updated' && c.bulletsAdded > 0) {
      const sections = c.sectionsChanged && c.sectionsChanged.length
        ? ' in ' + c.sectionsChanged.map(escapeHtml).join(', ')
        : '';
      detail = '<span class="ing-change-detail">+<span class="ing-num">' + c.bulletsAdded + '</span> bullet' + (c.bulletsAdded === 1 ? '' : 's') + sections + '</span>';
    } else if (c.status === 'created') {
      detail = '<span class="ing-change-detail">' + formatBytesLocal(c.bytesAfter) + '</span>';
    } else if (c.status === 'updated') {
      detail = '<span class="ing-change-detail">' + formatBytesLocal(c.bytesBefore) + ' → ' + formatBytesLocal(c.bytesAfter) + '</span>';
    }
    return '<li><span class="ing-change-path">' + escapeHtml(c.canonPath) + '</span>' + detail + '</li>';
  };

  const headerRow = title ? '<h3 class="ing-change-title">' + escapeHtml(title) + '</h3>' : '';

  // No-emoji-in-the-chrome: the design's restraint section rules out ✨/✏️
  // here — replaced with the shell's own icon() (hand-drawn Lucide-style
  // strokes), not a sparkle: this is a data label reporting a past result,
  // not a control that spends API tokens, and the design reserves sparkles
  // for the latter only. `plus` reads as "new"; a page count is a number,
  // so it carries the mono treatment ("Numbers are always monospace and
  // always exact").
  const createdBlock = created.length ? (
    '<div class="ing-change-section ing-change-created">' +
      '<div class="ing-change-header">' + icon('plus', 13) + ' <span class="ing-num">' + created.length + '</span> new ' + (created.length === 1 ? 'page' : 'pages') + '</div>' +
      '<ul class="ing-change-list">' + created.map(formatRecord).join('') + '</ul>' +
    '</div>'
  ) : '';

  const updatedBlock = updated.length ? (
    '<div class="ing-change-section ing-change-updated">' +
      '<div class="ing-change-header">' + icon('activity', 13) + ' <span class="ing-num">' + updated.length + '</span> ' + (updated.length === 1 ? 'page' : 'pages') + ' updated</div>' +
      '<ul class="ing-change-list">' + updated.map(formatRecord).join('') + '</ul>' +
    '</div>'
  ) : '';

  const unchangedBlock = unchanged.length ? (
    '<div class="ing-change-section">' +
      '<button type="button" class="ing-change-toggle" id="' + toggleId + '">' +
        (unchangedExpanded ? 'Hide ' : 'Show ') + '<span class="ing-num">' + unchanged.length + '</span> unchanged ' + (unchanged.length === 1 ? 'page' : 'pages') +
      '</button>' +
      (unchangedExpanded ? '<ul class="ing-change-list">' + unchanged.map(formatRecord).join('') + '</ul>' : '') +
    '</div>'
  ) : '';

  const emptyBlock = (!created.length && !updated.length)
    ? '<div class="ing-change-empty">No changes — every page was already up to date.</div>'
    : '';

  return (
    '<div class="ing-change-summary">' +
      headerRow + createdBlock + updatedBlock + emptyBlock + unchangedBlock +
    '</div>'
  );
}

// v3.0.1-beta.12+ classifier, ported verbatim from src/public/app.js's
// classifyIngestEntry — SAME trigger strings, SAME bucket semantics (see
// that file's own comment for why: most "warnings" are safeguard
// SUCCESSES, not problems). Colors are re-pointed at this shell's
// theme-aware CSS custom properties instead of app.js's hardcoded hex —
// the shipping app is dark-only so a literal hex is safe there; this shell
// supports light + dark, so a literal hex would be wrong in one of them.
// If ingest.js's warning wording ever changes, update BOTH this copy and
// app.js's — see scripts/test-ingest-prompt-slimming.js's note about the
// "briefer than the rest" phrase for why that specific trigger is fragile.
function classifyIngestEntry(w) {
  const lc = String(w || '').toLowerCase();
  if (lc.includes('injected the trunk page') ||
      lc.includes('hub linkification') ||
      lc.includes('injected entities/') ||
      lc.includes('injected the canonical summary') ||
      lc.includes('redirected to canonical') ||
      lc.includes('redirected; bullets will merge') ||
      lc.includes('dropping') && lc.includes('content will merge')) {
    return { kind: 'fixed', iconName: 'checkAlt', color: 'var(--success-text)', label: 'Auto-fixed' };
  }
  if (lc.includes('keeping both') ||
      lc.includes("don't resolve") ||
      lc.includes('do not resolve') ||
      lc.includes('stub page') ||
      lc.includes('briefer than the rest')) {
    return { kind: 'review', iconName: 'alertCircle', color: 'var(--attention-text)', label: 'For review' };
  }
  if (lc.includes('truncated to')) {
    return { kind: 'attention', iconName: 'alertTriangle', color: 'var(--danger-text)', label: 'Attention' };
  }
  return { kind: 'info', iconName: 'dotRing', color: 'var(--accent-text)', label: 'Info' };
}

function renderWarningsHtml(warnings) {
  if (!Array.isArray(warnings) || !warnings.length) return '';

  const buckets = { fixed: 0, review: 0, attention: 0, info: 0 };
  const classified = warnings.map((w) => {
    const c = classifyIngestEntry(w);
    buckets[c.kind] += 1;
    return { msg: w, ...c };
  });

  // No-emoji-in-the-chrome: the four buckets stay distinguishable by
  // BOTH colour AND a distinct icon() SHAPE (check / circle / triangle /
  // ring — rising visual weight matches rising severity), not by emoji.
  // Deliberately NOT flattened to one shared treatment — most of these are
  // safeguard SUCCESSES, not problems, and losing the distinction is what
  // made the panel read as alarming to real users (see the file's own
  // classifyIngestEntry comment). Counts are numbers, so they carry mono.
  const summaryParts = [];
  if (buckets.fixed) summaryParts.push('<span style="color:var(--success-text)"><span class="ing-num">' + buckets.fixed + '</span> auto-fixed</span>');
  if (buckets.review) summaryParts.push('<span style="color:var(--attention-text)"><span class="ing-num">' + buckets.review + '</span> for review</span>');
  if (buckets.attention) summaryParts.push('<span style="color:var(--danger-text)"><span class="ing-num">' + buckets.attention + '</span> attention</span>');
  if (buckets.info) summaryParts.push('<span style="color:var(--accent-text)"><span class="ing-num">' + buckets.info + '</span> info</span>');
  const summaryLine = summaryParts.join(' · ');

  const items = classified.map((c) => (
    '<li><span class="ing-warn-icon" style="color:' + c.color + '">' + icon(c.iconName, 12) + '</span> <span style="color:' + c.color + ';font-weight:600">' + c.label + ':</span> ' + escapeHtml(c.msg) + '</li>'
  )).join('');

  const bucketClass = buckets.attention ? 'ing-warnings-attention'
    : buckets.review ? 'ing-warnings-review'
    : buckets.fixed ? 'ing-warnings-fixed'
    : 'ing-warnings-info';

  return (
    '<div class="ing-warnings ' + bucketClass + '">' +
      '<strong>Ingest finished — <span class="ing-num">' + warnings.length + '</span> note' + (warnings.length === 1 ? '' : 's') + '</strong>' +
      (summaryLine ? '<div class="ing-warnings-summary">' + summaryLine + '</div>' : '') +
      '<ul class="ing-warnings-list">' + items + '</ul>' +
    '</div>'
  );
}

// Ported from src/public/app.js's formatTokenUsage — same defensive
// per-field contract (every field individually optional; renders nothing,
// never NaN/undefined text, on an absent/partial/empty payload).
function formatTokenUsageHtml(u) {
  if (!u || typeof u !== 'object') return '';
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const calls = isNum(u.calls) ? u.calls : null;
  const inputTokens = isNum(u.inputTokens) ? u.inputTokens : null;
  const outputTokens = isNum(u.outputTokens) ? u.outputTokens : null;
  const cachedReadTokens = isNum(u.cachedReadTokens) ? u.cachedReadTokens : 0;
  const cacheWriteTokens = isNum(u.cacheWriteTokens) ? u.cacheWriteTokens : 0;
  const provider = typeof u.provider === 'string' && u.provider ? u.provider : null;
  const model = typeof u.model === 'string' && u.model ? u.model : null;

  if (calls == null && inputTokens == null && outputTokens == null && !provider && !model) return '';

  const parts = [];
  if (provider || model) {
    const label = [provider, model].filter(Boolean).join(' · ');
    parts.push('<span class="ing-token-model">' + escapeHtml(label) + '</span>');
  }
  if (calls != null) parts.push('<span>' + calls + ' call' + (calls === 1 ? '' : 's') + '</span>');
  if (inputTokens != null || outputTokens != null) {
    const inStr = inputTokens != null ? inputTokens.toLocaleString() : '—';
    const outStr = outputTokens != null ? outputTokens.toLocaleString() : '—';
    parts.push('<span>' + inStr + ' in / ' + outStr + ' out</span>');
  }
  if (cachedReadTokens > 0 || cacheWriteTokens > 0) {
    const bits = [];
    if (cachedReadTokens > 0) bits.push(cachedReadTokens.toLocaleString() + ' cached read');
    if (cacheWriteTokens > 0) bits.push(cacheWriteTokens.toLocaleString() + ' cache write');
    parts.push('<span class="ing-token-cache">' + bits.join(' · ') + '</span>');
  }
  if (!parts.length) return '';
  return '<div class="ing-token-usage">' + parts.join('') + '</div>';
}

function formatElapsedMs(ms) {
  const safeMs = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  const totalSec = Math.floor(safeMs / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? (m + 'm ' + s + 's') : (s + 's');
}

// ── Listeners ─────────────────────────────────────────────────────────────
// Entered synchronously by real click/input/drop events — reading
// myMountToken fresh inside each handler body is safe (see sync.js's
// file-header comment for why: nothing can re-mount between a real user
// event firing and the very next line of JS running).

/**
 * The ONE writer of `state.dragActive`, and the only thing a live drag is
 * allowed to change on screen.
 *
 * It paints the LIVE node — `classList.toggle` on the zone's root — instead
 * of calling render(). That is the whole fix for the reported "drag and drop
 * does nothing" defect; wireListeners' drag block carries the full account of
 * why a render mid-drag destroys the drop target. Everything else the drag
 * state affects (the headline swap, the hidden "browse your files" line) is
 * expressed in ingest.css off this one class, so there is nothing else to
 * update and no child node to replace.
 *
 * The equality guard stays — not to make a render rare, but because
 * `dragover` fires dozens of times a second and there is no reason to touch
 * the DOM on frames where nothing changed.
 *
 * Looks the zone up by id rather than closing over a node: this is called
 * from the document-level guards and from handleSelectedFiles as well as
 * from the zone's own listeners, and in the queue-panel state there is no
 * zone at all — the state flag is still worth keeping straight so the next
 * render of a zone starts from the truth.
 */
function setDragActive(next) {
  const on = !!next;
  if (state.dragActive === on) return;
  state.dragActive = on;
  const zone = document.getElementById('ing-drop-zone');
  if (zone) zone.classList.toggle('ing-drop-zone-active', on);
}

/**
 * Does this drag carry FILES (as opposed to a text selection, a link being
 * dragged inside the app, or an editor's own drag)?
 *
 * `dataTransfer.types` is a DOMStringList in older engines and a frozen array
 * in current ones; both answer to Array.from. Reading `.files` here would be
 * useless — it is deliberately empty until `drop` — so the type list is the
 * only signal available during dragenter/dragover, which is exactly when the
 * document-level guard has to decide whether to intervene.
 */
function dragCarriesFiles(e) {
  const dt = e && e.dataTransfer;
  if (!dt) return false;
  let types = [];
  try { types = Array.from(dt.types || []); } catch { return false; }
  return types.indexOf('Files') !== -1;
}

/**
 * Document-level drag guards, installed ONCE per mount (onEnter) and removed
 * in the teardown — never from wireListeners, which runs on every render.
 *
 * TWO jobs, and the second is the one that matters most:
 *
 *  1. A file dropped anywhere in the Ingest view — the sidebar, the header,
 *     the gap beside the zone — is treated as a drop on the zone, provided a
 *     zone is actually on screen. Aiming a file at a 168px target is the
 *     kind of precision a desktop app should not ask for, and the answer to
 *     "did I hit it?" should never be "the app went blank".
 *
 *  2. A file dropped anywhere at all is REFUSED rather than left to the
 *     browser. The default action for a file dropped on a page is to
 *     navigate to it: in Electron that takes the window off the app with no
 *     error and no way back except relaunching. That is a hazard on EVERY
 *     view, not just this one — but this view is the only place a user has
 *     any reason to be dragging a file, so this is where it is closed, and
 *     desktop/main.js's will-navigate guard is the layer that covers the
 *     rest.
 *
 * Deliberately scoped to drags that carry files: a text selection dragged
 * inside a textarea must keep working, so a non-file drag is not touched.
 */
function installDocumentDragGuards(mountToken) {
  if (typeof document === 'undefined') return null;

  const overGuard = (e) => {
    if (!isCurrentMount(mountToken)) return;
    if (!dragCarriesFiles(e)) return;
    // Refusing the default is what stops the navigation, so it happens for
    // every file drag over this view whether or not a zone is on screen.
    e.preventDefault();
    try { if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; } catch { /* not settable here */ }
  };

  const dropGuard = (e) => {
    if (!isCurrentMount(mountToken)) return;
    if (!dragCarriesFiles(e)) return;
    e.preventDefault();
    setDragActive(false);
    // Inside the zone the zone's own listener has already handled it — this
    // handler sees the same event on the way up. Doing the work twice would
    // add every dropped file to the batch twice.
    const zone = document.getElementById('ing-drop-zone');
    if (zone && e.target && typeof e.target.closest === 'function' && e.target.closest('#ing-drop-zone')) return;
    // No zone on screen (a batch is live or terminal-undismissed, or the
    // domain list failed to load) — the drop is not ACTED on. Silently
    // mutating a running batch's file list from a stray drop would be worse
    // than ignoring it, and the navigation is refused either way. But it is
    // not swallowed SILENTLY: a batch panel says so, because a user who has
    // just dragged three files onto the app is owed an answer.
    if (!zone) {
      if (state.queueJob && !state.queueDropIgnored) {
        state.queueDropIgnored = true;
        render(mountToken);
      }
      return;
    }
    handleSelectedFiles(mountToken, e.dataTransfer && e.dataTransfer.files);
  };

  // A drag that ends outside the window — released over Finder, or
  // cancelled with Escape — fires no dragleave at the zone in every engine.
  // Without this the zone can be left reading "Release to add" over a drag
  // that is already over.
  const endGuard = () => { if (isCurrentMount(mountToken)) setDragActive(false); };

  document.addEventListener('dragenter', overGuard);
  document.addEventListener('dragover', overGuard);
  document.addEventListener('drop', dropGuard);
  document.addEventListener('dragend', endGuard);
  if (typeof window !== 'undefined') window.addEventListener('blur', endGuard);

  return () => {
    document.removeEventListener('dragenter', overGuard);
    document.removeEventListener('dragover', overGuard);
    document.removeEventListener('drop', dropGuard);
    document.removeEventListener('dragend', endGuard);
    if (typeof window !== 'undefined') window.removeEventListener('blur', endGuard);
  };
}

function wireListeners() {
  // The domain picker. Hydrated from the SAME builder the markup came from
  // (domainListboxCfg), so the mounted control and the rendered one cannot
  // describe different options.
  //
  // No `disabled` is passed here, deliberately: the flag only ever affects
  // the RENDERED markup, and mountListbox reads the live `button.disabled`
  // off the DOM. A disabled <button> refuses the click at the platform
  // level — there is no CSS-only lookalike that still fires a handler
  // mid-write, which is the failure a hand-rolled menu invites.
  //
  // onChange routes through selectDomain — the single writer of state.domain,
  // shared with the sidebar's destination rows so the two controls cannot
  // drift. The re-estimate-at-the-confirm-gate behaviour ported from
  // src/public/app.js lives in there; see its comment.
  mountListbox(domainListboxCfg());

  const dropZone = document.getElementById('ing-drop-zone');
  const fileInput = document.getElementById('ing-file-input');
  if (dropZone) {
    // ── THE DROP TARGET MUST SURVIVE THE WHOLE DRAG SESSION ─────────────
    //
    // THE DEFECT (reported from the Mac app: "dragging files from Finder
    // onto the drop zone does nothing", while Choose files worked for one
    // file and for many). `dragover` fires CONTINUOUSLY while a file is held
    // over the zone. The first one called setDragActive(true), which called
    // render() — and render() goes renderMain -> setMain, which replaces
    // #view-root's innerHTML wholesale. So the element the pointer was
    // holding a file over was DESTROYED by the drag's own first event, and
    // rebuilt as a different node.
    //
    // The old comment here knew the shape of the hazard ("repainting the
    // very element the pointer is over ... is how a drag gets dropped on
    // the floor") and then answered it with a guard that only stops the
    // repaint from happening MANY times. Once is enough to break it. Worse,
    // it made the destruction self-sustaining: Chromium dispatches
    // `dragleave` at the old target when the drag target changes, that
    // listener flipped the flag back to false and rendered AGAIN, and the
    // next dragover flipped it true and rendered a third time. Every frame
    // of the drag replaced the node under the cursor, so the `drop` never
    // landed on an attached element and the browser fell through to its
    // default action — which, for a file dropped on a page, is to NAVIGATE
    // to it. In a browser tab that shows the file; in Electron it silently
    // takes the window off the app (hence "nothing happens").
    // desktop/main.js now refuses that navigation as well — belt and
    // braces, and see its will-navigate comment for why both halves exist.
    //
    // THE RULE, therefore: while a drag is in progress this view MUTATES,
    // it never re-renders. setDragActive toggles ONE class on the live zone
    // (the copy swap is CSS — see renderDropZoneHtml and ingest.css), and
    // nothing else in the subtree is touched.
    //
    // `dragenter` is registered and preventDefault'd rather than left out.
    // The HTML drag-and-drop model determines the current target element
    // from whether `dragenter` was cancelled; browsers are more forgiving
    // than the spec and usually accept a dragover-only zone, but a target
    // that answers only half the handshake is relying on that forgiveness,
    // and it costs one line not to. `dropEffect = 'copy'` is what makes the
    // OS draw a copy cursor instead of the "no entry" badge, which is the
    // feedback a user reads BEFORE letting go.
    //
    // Both handlers are gated on dragCarriesFiles(e) — the same check the
    // document-level drag guards (below in this file) use. Without it, a
    // drag with no files at all (a text selection, a link, an editor's own
    // drag — `dataTransfer.types` has no 'Files' entry) still activated the
    // zone: `dragenter`/`dragover` fire regardless of payload, so
    // accept()/setDragActive(true) ran unconditionally, cancelling a plain
    // text drag and flipping the zone to "Release to add" over a drag it can
    // never turn into a file. A non-file drag now falls through untouched —
    // no preventDefault, no dropEffect, no active state — leaving the
    // browser's own default handling (e.g. a text drop into a focused field)
    // intact. `drop` keeps handling every payload unconditionally:
    // handleSelectedFiles already treats an empty/absent FileList as "nothing
    // usable" (see §7's "carrying nothing" case), so gating it here would
    // only duplicate that check for no benefit.
    const accept = (e) => {
      e.preventDefault();
      // Read-only in some drag phases in some engines; never worth throwing.
      try { if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; } catch { /* not settable here */ }
    };
    dropZone.addEventListener('dragenter', (e) => {
      if (!dragCarriesFiles(e)) return;
      accept(e); setDragActive(true);
    });
    dropZone.addEventListener('dragover', (e) => {
      if (!dragCarriesFiles(e)) return;
      accept(e); setDragActive(true);
    });
    // The zone has CHILD elements (icon, headline, sub, formats line), and
    // dragleave fires when the pointer crosses from the zone onto any of
    // them. `relatedTarget` is the node being entered, so a move that stays
    // inside the zone is not a leave — without this the active state strobes
    // while the user is still holding the file over the target.
    dropZone.addEventListener('dragleave', (e) => {
      if (e.relatedTarget && dropZone.contains(e.relatedTarget)) return;
      setDragActive(false);
    });
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      // Through setDragActive, not a bare assignment: the flag and the class
      // on screen are one fact, and writing the flag alone is what left the
      // zone reading "Release to add" after a drop that carried no files.
      setDragActive(false);
      handleSelectedFiles(myMountToken, e.dataTransfer && e.dataTransfer.files);
    });
    dropZone.addEventListener('click', (e) => {
      if (e.target.closest('label')) return; // the <label for=...> already opens the picker natively
      if (fileInput) fileInput.click();
    });
    // The zone carries role="button" tabindex="0", so it MUST answer the
    // keys a button answers. A focusable element that announces itself as a
    // button and then ignores Enter/Space is worse than a plain div: it
    // puts a keyboard user in a stop with no exit. Space is preventDefault'd
    // so the page does not scroll underneath the picker.
    dropZone.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      if (e.target.closest('label')) return;
      e.preventDefault();
      if (fileInput) fileInput.click();
    });
  }
  if (fileInput) {
    fileInput.addEventListener('change', () => handleSelectedFiles(myMountToken, fileInput.files));
  }

  const submitBtn = document.getElementById('ing-submit-btn');
  if (submitBtn) submitBtn.addEventListener('click', () => runIngest(myMountToken, false));

  const dupOverwrite = document.getElementById('ing-dup-overwrite');
  if (dupOverwrite) dupOverwrite.addEventListener('click', () => { state.duplicate = null; runIngest(myMountToken, true); });
  const dupCancel = document.getElementById('ing-dup-cancel');
  if (dupCancel) dupCancel.addEventListener('click', () => { state.duplicate = null; render(myMountToken); });

  const unchangedToggle = document.getElementById('ing-unchanged-toggle');
  if (unchangedToggle) {
    unchangedToggle.addEventListener('click', () => {
      if (state.result) state.result.unchangedExpanded = !state.result.unchangedExpanded;
      render(myMountToken);
    });
  }

  // ── Restored outcome (v3.24.0) ──────────────────────────────────────
  // Its own fold state and its own toggle id, because it can never share
  // either with the live panel (see renderChangeRecordsHtml's toggleId).
  const remoteToggle = document.getElementById('ing-remote-unchanged-toggle');
  if (remoteToggle) {
    remoteToggle.addEventListener('click', () => {
      state.remoteResultExpanded = !state.remoteResultExpanded;
      // Keep the no-op guard's idea of the screen in step with the render we
      // are about to do ourselves, or the next poll would compare against a
      // stale signature and repaint the fold shut.
      renderedActivitySignature = null;
      render(myMountToken);
      renderedActivitySignature = activitySignature();
    });
  }

  const remoteDismiss = document.getElementById('ing-remote-dismiss');
  if (remoteDismiss) remoteDismiss.addEventListener('click', () => dismissRemoteOutcome(myMountToken));

  // The main-pane settled line. "Show me" goes through `selectDomain` — the
  // SAME writer the sidebar rows use, and one of §2's allow-listed writers of
  // `state.domain`. It is deliberately not a new adoption path: this is the
  // user making a choice, so it must look exactly like every other choice,
  // including forfeiting the mount's pending adoption.
  const settledShow = document.querySelector('[data-settled-show]');
  if (settledShow) {
    settledShow.addEventListener('click', () => {
      selectDomain(settledShow.dataset.settledShow);
      // Same revalidation the destination rows fire, for the same reason: the
      // user is about to look at that domain's page count and last write.
      refreshDomainStats(myMountToken).catch(() => {});
    });
  }
  const settledDismiss = document.querySelector('[data-settled-dismiss]');
  if (settledDismiss) {
    settledDismiss.addEventListener('click', () =>
      dismissSettledElsewhere(settledDismiss.dataset.settledDismiss, myMountToken));
  }

  wireQueueListeners();
}

// The ONE case that must behave exactly as before Phase 2: a completely
// fresh single-file pick, with no batch ever started, stays on the
// untouched single-file path (pickSingleFile). Everything else — 2+ files
// in one event, or a 2nd file arriving on top of an already-selected
// single file (picker OR drop, same code path for both — this is also
// what fixes "drop replaces the previous file") — enters or extends the
// batch. Ported verbatim in STRUCTURE from src/public/app.js's own
// handleSelectedFiles; see enterQueueMode/addFilesToQueueSelection for
// the accumulate behaviour itself.
function handleSelectedFiles(token, fileList) {
  const incoming = Array.from(fileList || []);
  if (incoming.length === 0) {
    // A drop can genuinely carry nothing this view can use — a folder on some
    // platforms, a dragged-out mail attachment that never materialises — and
    // a cancelled picker fires `change` with an empty list too. The early
    // return was correct; what was missing is that it left `state.dragActive`
    // wherever the drop had put it, so the zone sat on "Release to add" over
    // a drag that had already ended. setDragActive is a no-op when the flag
    // is already false, so the ordinary picker path costs nothing.
    setDragActive(false);
    return;
  }

  if (!state.queueModeActive) {
    if (incoming.length === 1 && !state.file) {
      pickSingleFile(token, incoming);
      return;
    }
    const combined = state.file ? [state.file, ...incoming] : incoming;
    enterQueueMode(token, combined);
    return;
  }
  // Already accumulating: batch mode is STICKY (see the file-header
  // comment's defect #1) — even a removal that brings the total to 1 does
  // NOT fall back to the single-file path; only explicit Clear does.
  addFilesToQueueSelection(token, incoming);
}

function pickSingleFile(token, fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  const file = files[0];
  const ext = '.' + (file.name.split('.').pop() || '').toLowerCase();

  state.duplicate = null;
  state.result = null;
  state.errorMessage = null;

  if (!ALLOWED_EXT.includes(ext)) {
    state.file = null;
    state.fileError = 'Unsupported file type: ' + ext + '. Use .txt, .md, or .pdf.';
    render(token);
    return;
  }

  state.file = file;
  state.fileError = null;
  render(token);
}

// ── Ingest submission ──────────────────────────────────────────────────
// Ported from src/public/app.js's submitIngest — same SSE contract, same
// duplicate-file 409 handling, same elapsed-clock semantics (see the
// module-level phaseStartedAt/elapsedTimerId comment above). Structural
// difference from app.js: this rebuilds the whole panel from `state` on
// every progress event (this shell's render-from-state convention, same
// as every other view here) rather than mutating individual DOM nodes in
// place — except the elapsed-clock TICK itself, which updates #ing-elapsed
// directly via textContent, exactly like app.js's own tickProgressElapsed,
// to avoid a full-panel rebuild every second while nothing else changed.
async function runIngest(token, overwrite) {
  if (!state.file || !state.domain) return;
  const domain = state.domain;
  const file = state.file;

  state.submitting = true;
  state.errorMessage = null;
  state.duplicate = null;
  phaseStartedAt = Date.now();
  state.progress = { pct: 2, label: 'Starting…', waiting: false, phaseStartedAt };
  render(token);

  // Registers this write with the shell-wide gate so Sync/Domains/Settings
  // (once they subscribe — Phase 2/3 wiring) can refuse a conflicting
  // action, and so THIS view itself correctly reports "busy" if the user
  // navigates away and back before this finishes. `release` has already
  // closed over `domain` — nothing below ever needs to re-supply it.
  const release = beginDomainWrite(domain, 'ingest');

  if (elapsedTimerId != null) { clearInterval(elapsedTimerId); elapsedTimerId = null; }
  elapsedTimerId = setInterval(() => {
    if (!isCurrentMount(token) || phaseStartedAt == null) return;
    const el = document.getElementById('ing-elapsed');
    if (el) el.textContent = formatElapsedMs(Date.now() - phaseStartedAt);
  }, 1000);

  const setProgress = (pct, label, waiting) => {
    if (!waiting) phaseStartedAt = Date.now();
    // BUG FOUND DURING BROWSER VERIFICATION, fixed here: `state` is a
    // module-level `let`, reassigned WHOLESALE by each mount's onEnter
    // (`state = freshState()` above) — exactly the shape sync.js's onConnect/
    // onAction comments warn about ("this view's state is reassigned
    // wholesale on every onEnter... an ungated reset would reach through
    // the state closure variable into whatever the CURRENT mount's state
    // object is"). This function used to write `state.progress = {...}`
    // UNCONDITIONALLY and only gate the render() call after it — so an
    // ABANDONED mount's still-running SSE loop (this view deliberately does
    // NOT abort the fetch on navigate-away; see the teardown comment above)
    // kept mutating whatever object the module-level `state` variable
    // pointed to, which after a navigate-away-and-back is a LATER mount's
    // OWN fresh state object, even though its own render was correctly
    // suppressed. Reproduced live: drop a file, click Ingest, immediately
    // navigate away and back before it finishes — the fresh mount showed a
    // phantom, permanently-stuck "Done! 100%" progress bar (the elapsed
    // clock kept counting up correctly since renderProgress() computes it
    // from `phaseStartedAt` at render time — the corrupted STATE was real,
    // not a stale paint) even though it never itself called runIngest. The
    // assignment must be gated exactly like every other state mutation in
    // this file (and like every write in sync.js/domains.js) — never write
    // to `state` before checking isCurrentMount(token).
    if (!isCurrentMount(token)) return;
    state.progress = { pct, label, waiting: !!waiting, phaseStartedAt };
    render(token);
  };

  const formData = new FormData();
  formData.append('domain', domain);
  formData.append('file', file);
  if (overwrite) formData.append('overwrite', 'true');

  try {
    const res = await fetch('/api/ingest', { method: 'POST', body: formData });

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/event-stream')) {
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && data.duplicate) {
        if (isCurrentMount(token)) {
          state.progress = null;
          state.duplicate = { filename: data.filename || file.name };
          render(token);
        }
        return;
      }
      throw new Error(data.error || ('Ingest failed (' + res.status + ')'));
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let finalData = null;

    try {
      outer: for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          let ev;
          try { ev = JSON.parse(line.slice(6)); } catch { continue; }
          if (ev.type === 'progress') setProgress(ev.pct, ev.message, false);
          else if (ev.type === 'wait') setProgress(ev.pct, ev.message, true);
          else if (ev.type === 'done') { finalData = ev; break outer; }
          else if (ev.type === 'error') throw new Error(ev.message);
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }

    if (!finalData) throw new Error('Ingest did not complete successfully');

    if (isCurrentMount(token)) {
      // "Results are specific" — never the bare word "Done!" (design
      // principle). See formatIngestDoneLabelHtml's own comment.
      state.progress = {
        pct: 100,
        label: null,
        labelHtml: formatIngestDoneLabelHtml(finalData.changes),
        waiting: false,
        phaseStartedAt,
      };
      render(token);
    }
    await new Promise((r) => setTimeout(r, 400));

    if (isCurrentMount(token)) {
      state.progress = null;
      state.file = null;
      state.fileError = null;
      state.result = {
        title: finalData.title,
        changes: Array.isArray(finalData.changes) ? finalData.changes : [],
        pagesWritten: Array.isArray(finalData.pagesWritten) ? finalData.pagesWritten : [],
        warnings: Array.isArray(finalData.warnings) ? finalData.warnings : [],
        truncated: !!finalData.truncated,
        wasOverwrite: !!overwrite,
        tokenUsage: finalData.tokenUsage,
        unchangedExpanded: false,
      };
      render(token);
      // The write that just landed is exactly what makes the sidebar's page
      // count wrong — measured at 59 on screen against 96 on disk. Refresh it
      // now, on the one event that guarantees it moved. Deliberately AFTER the
      // result render, so the outcome panel paints immediately and the sidebar
      // number settles behind it rather than the user waiting on a second
      // round-trip to see what their ingest produced. Not awaited for the same
      // reason; `refreshDomainStats` re-checks the mount token itself and
      // repaints only if the numbers actually moved.
      refreshDomainStats(token).catch(() => {});
    }
  } catch (err) {
    if (isCurrentMount(token)) {
      state.progress = null;
      state.errorMessage = err.message;
      render(token);
    }
  } finally {
    if (elapsedTimerId != null) { clearInterval(elapsedTimerId); elapsedTimerId = null; }
    phaseStartedAt = null;
    // Always released — success, duplicate, error, or a stale mount. This
    // is the ONLY place a write handle for this ingest is ever released,
    // and it is the SAME function beginDomainWrite() handed back at the
    // top of this call — see app.js's write-gate comment for why that
    // shape makes the shipping app's H2 leak (enter keyed on one domain
    // value, exit keyed on a LATER, possibly-different one) impossible to
    // reproduce here.
    release();
    if (isCurrentMount(token)) {
      state.submitting = false;
      render(token);
      // THIS mount watched the run end and is already showing the outcome, so
      // the server's copy of it is the same event, not a second one. Mark it
      // seen, or navigating away and back would re-present a result the user
      // has already read — which is noise, and noise on this panel is what
      // makes a real one easy to walk past.
      //
      // The ack is deliberately INSIDE the mount check: an ABANDONED mount
      // reaching here means the user was not looking, so the record must stay
      // unacknowledged for whoever comes back. That is the entire feature.
      //
      // Acked by asking the server which record this was, rather than by
      // remembering an id locally: the id is minted server-side and the client
      // is never told it, and inventing a second channel to carry it would be
      // a protocol change to save one cheap request on an event that already
      // fires refreshDomainStats.
      ackOwnCompletedRun(token).catch(() => {});
    }
  }
}

/**
 * Mark the record for the run this mount just watched as seen.
 * Best-effort: a failure means the outcome shows once more. Harmless.
 */
async function ackOwnCompletedRun(token) {
  await refreshActivity(token);
  if (!isCurrentMount(token)) return;
  const r = state.remote;
  if (r && r.status !== 'running') {
    ackActivityId(r.id);
    renderedActivitySignature = activitySignature();
  }
}

// ── Batch queue (Phase 2) ═══════════════════════════════════════════════
//
// Structural rule, quoted from src/public/app.js's own section header
// (ported verbatim as policy, not just as a comment): the client NEVER
// derives or caches job state. Every render takes a FULL job snapshot
// from the server (an SSE 'job'/'done' event, a POST start/pause/cancel
// response, or a GET refresh) and rebuilds the panel from it — no
// incremental patching, no client-side "which item is running"
// bookkeeping. The ONE narrow, explicitly-scoped exception is
// updateQueueItemProgress(), which handles the item-progress SSE event
// ({idx, pct, message} only, never a full job) — same shape as the
// single-file path's own elapsed-clock tick, which also bypasses a full
// render for one cheap, targeted DOM write.
//
// applyQueueJobSnapshot() is the single chokepoint every job object flows
// through — SSE events, POST responses, GET refreshes — and the ONLY
// place that touches the write gate (via applyQueueBusyForStatus). No
// other function below calls beginDomainWrite/_queueBusyRelease directly
// or calls render() with job data that didn't come through here first.

function isQueueTerminal(status) {
  return status === 'done' || status === 'cancelled' || status === 'failed';
}

// ── Selection / confirm gate (pre-job) ────────────────────────────────
// Defect #1 fix, ported: EVERY selection event (picker OR drop) used to
// be treated as the WHOLE batch — pick 3 from one folder, then 2 from
// another, and the first 3 vanished; drop one file, drop another, and the
// second replaced the first. Real users assemble a batch incrementally.
// From here down, every add/remove path accumulates onto
// state.selectedFiles; only resetQueueSelection (Clear all) starts over.

function enterQueueMode(token, files) {
  state.queueModeActive = true;
  state.file = null;
  state.fileError = null;
  state.duplicate = null;
  state.selectedFiles = dedupeQueueFiles(files);
  startQueueSelection(token);
}

function addFilesToQueueSelection(token, incoming) {
  state.selectedFiles = dedupeQueueFiles([...state.selectedFiles, ...incoming]);
  startQueueSelection(token);
}

// Per-file remove — keyed on name+size (not array index), because the
// rendered list order is server-derived (largest-first) and does not
// match state.selectedFiles' insertion order. Removing the LAST file is
// an implicit Clear — a 0-file "batch" has nothing to confirm.
function removeQueueFile(token, name, bytesStr) {
  if (state.queueJob) return; // never once a job exists — the confirm gate is gone by then
  const hasBytes = bytesStr !== '' && bytesStr != null && Number.isFinite(Number(bytesStr));
  const bytes = hasBytes ? Number(bytesStr) : null;
  state.selectedFiles = state.selectedFiles.filter((f) => {
    if (!f || f.name !== name) return true;
    if (bytes == null) return false;
    return f.size !== bytes;
  });
  if (state.selectedFiles.length === 0) { resetQueueSelection(token); return; }
  startQueueSelection(token);
}

function resetQueueSelection(token) {
  state.queueModeActive = false;
  state.selectedFiles = [];
  state.queueEstimate = null;
  state.queueEstimateLoading = false;
  state.queueEstimateError = null;
  state.queueBudgetInput = '';
  state.queueOverwriteInput = false;
  state.queueSubmitError = null;
  state.queueDropIgnored = false;
  // Ported carve-out from app.js's own resetQueueSelection: never clear a
  // batch that's still genuinely LIVE — only a lingering TERMINAL one.
  // Not reachable today (Clear all only ever renders at the confirm gate,
  // before a job exists) but kept honest rather than assumed.
  const isLive = state.queueJob && !isQueueTerminal(state.queueJob.status);
  if (!isLive) {
    state.queueJob = null;
    queueJobId = null;
  }
  render(token);
}

// Re-estimates against whatever state.selectedFiles CURRENTLY holds —
// every add/remove call site above updates it first, then calls this with
// no argument beyond the token, so the estimate shown always matches the
// live list.
async function startQueueSelection(token) {
  const files = state.selectedFiles;
  state.queueEstimate = null;
  state.queueEstimateError = null;
  state.queueEstimateLoading = true;
  render(token);
  try {
    const body = { domain: state.domain, files: files.map((f) => ({ name: f.name, size: f.size })) };
    const res = await fetch(QUEUE_API + '/estimate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!isCurrentMount(token)) return;
    if (!res.ok || !data.ok) throw new Error(data.error || ('Could not estimate cost (HTTP ' + res.status + ')'));
    state.queueEstimate = data;
    state.queueEstimateLoading = false;
    render(token);
  } catch (err) {
    if (!isCurrentMount(token)) return;
    state.queueEstimate = null;
    state.queueEstimateLoading = false;
    state.queueEstimateError = err.message;
    render(token);
  }
}

async function beginQueueJob(token) {
  if (!state.selectedFiles.length) return;
  state.queueSubmitting = true;
  state.queueSubmitError = null;
  render(token);

  const domain = state.domain;
  const formData = new FormData();
  formData.append('domain', domain);
  if (state.queueOverwriteInput) formData.append('overwrite', 'true');
  const budgetNum = Number(state.queueBudgetInput);
  if (state.queueBudgetInput !== '' && state.queueBudgetInput != null && Number.isFinite(budgetNum)) {
    formData.append('budgetUsd', String(budgetNum));
  }
  for (const f of state.selectedFiles) formData.append('files', f);

  try {
    const res = await fetch(QUEUE_API, { method: 'POST', body: formData });
    const data = await res.json().catch(() => ({}));
    if (res.status === 409) {
      const activeId = extractConflictJobId(data);
      throw new Error(activeId
        ? ('A batch is already running (job ' + activeId + '). Wait for it to finish, or check the panel below.')
        : (data.error || 'A batch is already running on this domain.'));
    }
    if (!res.ok || !data.ok || !data.jobId) throw new Error(data.error || ('Could not start the batch (HTTP ' + res.status + ')'));

    const startRes = await fetch(QUEUE_API + '/' + encodeURIComponent(data.jobId) + '/start', { method: 'POST' });
    const startData = await startRes.json().catch(() => ({}));
    if (!startRes.ok || !startData.ok) throw new Error(startData.error || ('Could not start the batch (HTTP ' + startRes.status + ')'));

    if (!isCurrentMount(token)) return;
    // Uploaded + started — the confirm gate's job is done; everything
    // from here is driven by job snapshots (attachQueueStream's own first
    // frame calls applyQueueJobSnapshot — this function does not call it
    // directly, matching app.js's own beginQueueJob, which hands off to
    // attachQueueStream rather than double-applying the /start response).
    state.queueModeActive = false;
    state.selectedFiles = [];
    state.queueEstimate = null;
    state.queueSubmitting = false;
    queueJobId = data.jobId;
    render(token); // paints "Starting batch…" for the brief window before the stream's first snapshot lands
    attachQueueStream(data.jobId, token);
  } catch (err) {
    if (!isCurrentMount(token)) return;
    state.queueSubmitError = err.message;
    state.queueSubmitting = false;
    render(token);
  }
}

// ── Stream lifecycle + the write-gate chokepoint ──────────────────────

function detachQueueStream() {
  if (queueStreamAbort) {
    queueStreamAbort.abort();
    queueStreamAbort = null;
  }
}

// `domain` is only ever consulted on ENTER. On EXIT, the handle captured
// at entry time (_queueBusyRelease) is used instead of re-deriving
// anything — this is the H2-proofing property; see the module-level
// _queueBusyRelease doc comment above (near onEnter) and app.js's
// beginDomainWrite doc comment for the shipping-app leak this closes.
function applyQueueBusyForStatus(nextStatus, domain) {
  const decision = queueBusyTransition(_queueLastStatus, nextStatus);
  if (decision === 'enter') {
    if (_queueBusyRelease) { _queueBusyRelease(); _queueBusyRelease = null; } // defensive — should never already be held
    _queueBusyRelease = beginDomainWrite(domain, 'batch ingest');
  } else if (decision === 'exit') {
    const release = _queueBusyRelease;
    _queueBusyRelease = null;
    if (release) release();
  }
  _queueLastStatus = nextStatus;
  // Returned so the caller can act on the busy->terminal edge. This is the
  // one place in the file that already knows a batch has STOPPED writing,
  // and it fires exactly once per transition rather than on every snapshot.
  return decision;
}

// THE single chokepoint every job snapshot flows through. Updates the
// busy gate (unconditionally — that bookkeeping reflects REAL server
// state and must stay correct even for a mount that's no longer current,
// exactly like the single-file path's release() in its own `finally`),
// then — gated by isCurrentMount, same discipline the Phase-1 bug fix
// established for every state write in this file — updates `state.queueJob`
// and re-renders.
function applyQueueJobSnapshot(job, token) {
  if (!job) return;
  queueJobId = job.jobId || queueJobId;
  const domain = job.domain || state.domain;
  const busyDecision = applyQueueBusyForStatus(job.status, domain);
  // HIGH-2 fix: kick the SHELL's own active-job watcher (app.js, near the
  // write gate) so the gate stays correct from server truth even after
  // THIS view's own handle (above) is released by a later teardown — see
  // that watcher's comment for why this view's own gate handling alone
  // was not enough. Cheap and safe to call on every snapshot, terminal or
  // not; the watcher re-derives truth itself rather than trusting `job`.
  reportPossibleActiveJob();
  if (isCurrentMount(token)) {
    state.queueJob = job;
    // Minor honesty deviation from app.js (flagged in the phase report):
    // reflect the job's REAL domain in the (disabled-while-non-terminal)
    // domain select, rather than leaving whatever the dropdown happened
    // to show before a cross-mount reattach. Only when that domain is
    // actually in this mount's own domains list.
    if (job.domain && state.domains.some((d) => d.slug === job.domain)) state.domain = job.domain;
    render(token);
    // A batch that has just STOPPED writing moved the same page counts a
    // single-file ingest does. Reported as "only the single-file path is
    // stale"; reading the code, NEITHER path refreshed — the batch panel only
    // looks right because its own summary comes off the job snapshot, while
    // the sidebar beside it is equally stale. Hooked to the busy->terminal
    // EDGE, not to the snapshot, so it fires once per batch instead of on
    // every progress frame.
    if (busyDecision === 'exit') refreshDomainStats(token).catch(() => {});
  }
  // Structural guarantee, ported from app.js's own comment: a snapshot can
  // report 'running' from a source that never attaches a stream in THIS
  // mount (a GET refresh, a pause/resume POST response) — so whenever a
  // snapshot says running and nothing is attached, attach one now.
  // Guarantees every 'enter' this mount performs is paired with a stream
  // whose `finally` will eventually release it.
  if (isCurrentMount(token) && job.status === 'running' && !queueStreamAbort && job.jobId) {
    attachQueueStream(job.jobId, token);
  }
}

async function attachQueueStream(jobId, token) {
  detachQueueStream(); // tear down any prior connection first (also releases its busy state via its own finally)
  queueJobId = jobId;
  const controller = new AbortController();
  queueStreamAbort = controller;
  const domain = state.domain;
  try {
    const res = await fetch(QUEUE_API + '/' + encodeURIComponent(jobId) + '/stream', { signal: controller.signal });
    if (!res.body) throw new Error('Stream unavailable for this job');

    // Same reader-loop shape as runIngest's single-file SSE parsing.
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      outer: for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          let ev;
          try { ev = JSON.parse(line.slice(6)); } catch { continue; }
          if (ev.type === 'job' && ev.job) {
            applyQueueJobSnapshot(ev.job, token);
          } else if (ev.type === 'item-progress') {
            updateQueueItemProgress(ev.idx, ev.pct, ev.message);
          } else if (ev.type === 'done' && ev.job) {
            applyQueueJobSnapshot(ev.job, token);
            break outer;
          }
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  } catch (err) {
    if (err && err.name === 'AbortError') return; // detached on purpose (nav-away / re-attach)
    if (isCurrentMount(token)) {
      state.queueStreamError = (err && err.message) ? err.message : 'Lost connection to the batch.';
      render(token);
    }
  } finally {
    // Always release the busy gate here, exactly once, regardless of how
    // the stream ended (done event, thrown error, or abort) — mirrors
    // runIngest's own `finally`. `domain` (read from state when this
    // attach began) is only a same-tick fallback for the "somehow never
    // entered" edge case; the real release key is whatever
    // applyQueueBusyForStatus recorded at ENTER time (_queueBusyRelease).
    applyQueueBusyForStatus(null, domain);
    if (queueStreamAbort === controller) queueStreamAbort = null;
  }
}

// The ONE documented exception to "render from a snapshot" — {idx, pct,
// message} only, no full job. Targeted update of a single row's progress
// bar/message; every other part of the panel is still rebuilt wholesale
// by the next applyQueueJobSnapshot-driven render.
function updateQueueItemProgress(idx, pct, message) {
  if (!Number.isFinite(idx)) return;
  const row = document.querySelector('[data-queue-idx="' + idx + '"]');
  if (!row) return;
  const slot = row.querySelector('.ing-queue-item-progress');
  if (!slot) return;
  slot.classList.remove('ing-hidden');
  // Re-emitting the ring markup (rather than mutating a width) is the
  // honest move here: the segment set itself changes when a phase turns
  // over, so there is no single attribute to nudge. The orbit does not
  // visibly restart, because progressRingHtml stamps a negative
  // animation-delay derived from the clock — the new element picks the
  // cycle up where the destroyed one left off.
  const { stage, stageProgress } = mapIngestPctToStage(pct);
  slot.innerHTML = progressRingHtml({
    stages: INGEST_STAGES,
    stage,
    stageProgress,
    size: 20,
    label: typeof message === 'string' ? message : '',
    className: 'pring-sm ing-queue-item-ring',
  });
}

// Resume-on-return: called on every Ingest-view onEnter. If an active
// (non-terminal) job exists ANYWHERE (jobs are global, not per-domain —
// see src/brain/ingest-queue.js's getActiveJob), render it immediately
// from the GET snapshot, then reattach the live SSE stream only if it's
// actually running — a paused/pending job renders statically with its
// own Resume/Start button, which reattaches the stream when clicked.
async function checkActiveQueueJob(token) {
  try {
    const res = await fetch(QUEUE_API + '/active');
    const data = await res.json().catch(() => ({}));
    if (!isCurrentMount(token)) return;
    if (!res.ok || !data.ok || !data.job) {
      // BUG FOUND DURING BROWSER VERIFICATION, fixed here: `queueJobId` is
      // module-level so it survives remounts on purpose (that's what makes
      // reattachment work at all) — but that means a job started on an
      // EARLIER mount, which then finished terminal while the user was on
      // some OTHER view (so this mount never saw it and never got a
      // chance to Dismiss it), leaves `queueJobId` stuck non-null forever.
      // The very next time the user builds a FRESH batch on this same
      // mount, renderQueueSection()'s `if (queueJobId) return 'Starting
      // batch…'` fallback — meant only for the brief window between a
      // successful POST /start and the SSE stream's first snapshot —
      // wrongly fires immediately on selection, before Start was ever
      // clicked, with no Start button anywhere to click and no way out
      // short of a full page reload. Reproduced live: batch A finishes
      // while off-view, its jobId is never cleared; batch B's confirm
      // gate never renders, stuck permanently on "Starting batch…".
      // `/active` returning null is the authoritative "nothing to track"
      // signal — clear the stale pointers unconditionally on it. This can
      // never race a same-mount beginQueueJob() (which sets queueJobId
      // itself, later): checkActiveQueueJob only ever runs once, at the
      // top of onEnter, before any click on this fresh mount could have
      // reached beginQueueJob.
      queueJobId = null;
      _queueLastStatus = null;
      return;
    }
    const job = data.job;
    // Sync the SHELL's active-job watcher too, even for a non-'running'
    // job (paused/pending): reportPossibleActiveJob() is a safe no-op
    // when the job turns out not to be busy (queueBusyTransition-driven —
    // see app.js's own comment), so this keeps its bookkeeping current on
    // every mount that finds a job, not just the ones that go on to
    // attachQueueStream below.
    reportPossibleActiveJob();
    state.queueJob = job;
    if (job.domain && state.domains.some((d) => d.slug === job.domain)) state.domain = job.domain;
    queueJobId = job.jobId;
    render(token);
    if (job.status === 'running') {
      attachQueueStream(job.jobId, token);
    } else {
      _queueLastStatus = job.status; // keep busy-gate bookkeeping honest with no live stream attached
    }
  } catch { /* non-critical — the Ingest view just won't show a resumed batch */ }
}

// ── Job actions ────────────────────────────────────────────────────────

async function pauseQueueJob(token, jobId) {
  if (!jobId) return;
  state.queueActionBusy = 'pause';
  render(token);
  try {
    const res = await fetch(QUEUE_API + '/' + encodeURIComponent(jobId) + '/pause', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || ('Could not pause (HTTP ' + res.status + ')'));
    if (isCurrentMount(token)) state.queueActionBusy = null;
    if (data.job) applyQueueJobSnapshot(data.job, token);
    else if (isCurrentMount(token)) render(token);
  } catch (err) {
    if (isCurrentMount(token)) {
      state.queueStreamError = err.message;
      state.queueActionBusy = null;
      render(token);
    }
  }
}

async function resumeQueueJob(token, jobId) {
  if (!jobId) return;
  state.queueActionBusy = 'resume';
  render(token);
  try {
    const res = await fetch(QUEUE_API + '/' + encodeURIComponent(jobId) + '/start', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || ('Could not resume (HTTP ' + res.status + ')'));
    if (isCurrentMount(token)) state.queueActionBusy = null;
    if (data.job) applyQueueJobSnapshot(data.job, token);
    // Guard against double-attaching, ported from app.js's own resumeQueueJob
    // comment: if the snapshot above already reported 'running',
    // applyQueueJobSnapshot's own auto-attach has ALREADY called
    // attachQueueStream. Only attach here if nothing is attached yet.
    if (!queueStreamAbort) attachQueueStream(jobId, token);
  } catch (err) {
    if (isCurrentMount(token)) {
      state.queueStreamError = err.message;
      state.queueActionBusy = null;
      render(token);
    }
  }
}

// Defect #2 fix, ported: cancel gives immediate feedback. The inline
// confirm (no window.confirm/alert anywhere in this codebase) is opened
// by wireQueueListeners' cancel-btn handler (sets
// state.queueCancelConfirmOpen = true); "Never mind" re-fetches the live
// snapshot rather than trusting anything local.
async function confirmCancelQueueJob(token, jobId) {
  if (!jobId) return;
  state.queueActionBusy = 'cancel';
  render(token);
  try {
    const res = await fetch(QUEUE_API + '/' + encodeURIComponent(jobId) + '/cancel', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || ('Could not cancel (HTTP ' + res.status + ')'));
    if (isCurrentMount(token)) {
      state.queueCancelConfirmOpen = false;
      state.queueActionBusy = null;
    }
    if (data.job) applyQueueJobSnapshot(data.job, token);
    else if (isCurrentMount(token)) render(token);
  } catch (err) {
    if (isCurrentMount(token)) {
      state.queueStreamError = err.message;
      state.queueActionBusy = null;
      render(token);
    }
  }
}

async function refreshQueueJob(token, jobId) {
  if (!jobId) return;
  try {
    const res = await fetch(QUEUE_API + '/' + encodeURIComponent(jobId));
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok && data.job) applyQueueJobSnapshot(data.job, token);
  } catch { /* leave the current panel as-is */ }
}

// Defect #3 fix, ported: a terminal batch is Dismiss-able without a page
// reload. UI-only — never touches the job server-side (no DELETE call;
// the job stays exactly as it finished, on disk). Only ever reachable via
// #ing-queue-dismiss-btn, which is only ever rendered when isQueueTerminal
// (see renderQueuePanel) — structurally cannot fire on a live job.
function dismissQueuePanel(token) {
  detachQueueStream(); // defensive — a terminal job should already hold no live stream
  queueJobId = null;
  _queueLastStatus = null;
  state.queueJob = null;
  state.queueCancelConfirmOpen = false;
  state.queueStreamError = null;
  // The advice in that note is "dismiss this and drop them again", which is
  // what just happened. Leaving it up would tell the user to do a thing they
  // have already done.
  state.queueDropIgnored = false;
  render(token);
}

// ── Rendering — confirm gate (pre-job) ────────────────────────────────
// Reimplemented in this shell's markup (see the file-header comment on
// why HTML builders are reimplemented, not copied, from app.js 885–1135).

function renderQueueSection() {
  if (state.queueJob) return renderQueuePanel(state.queueJob);
  // Brief window between a successful POST /start and the SSE stream's
  // first snapshot — honest loading text, never a fabricated panel.
  if (queueJobId) return '<p class="view-body">Starting batch…</p>';
  return renderQueueConfirmGate();
}

function renderQueueConfirmGate() {
  let estimateBody = '';
  if (state.queueEstimateLoading) {
    const n = state.selectedFiles.length;
    // ── THE SHAPE OF THE ANSWER, NOT A SPINNER ─────────────────────────────
    // The sentence stays: it names the file count, so the wait is attributable
    // and a user who picked the wrong pile can say so before spending. What is
    // ADDED is the shape the estimate will land in — a row per file plus the
    // three summary rows — so the panel does not jump from one line of prose
    // to a full block. `aria-hidden` on the placeholder and `aria-live` on the
    // sentence, so a screen reader gets the words and none of the scaffolding.
    // Rows are capped at six: past that the skeleton stops describing the
    // answer and starts being a wall.
    const rows = Math.max(1, Math.min(n, 6));
    estimateBody =
      '<p class="view-body" aria-live="polite">Estimating cost for <span class="ing-num">' + n + '</span> file' + (n === 1 ? '' : 's') + '…</p>' +
      '<div class="ing-queue-skeleton" aria-hidden="true">' +
        Array.from({ length: rows }, () =>
          '<div class="ing-queue-skeleton-row">' +
            '<span class="cur-skeleton ing-queue-skeleton-name"></span>' +
            '<span class="cur-skeleton ing-queue-skeleton-size"></span>' +
          '</div>').join('') +
        '<div class="ing-queue-skeleton-row ing-queue-skeleton-total">' +
          '<span class="cur-skeleton ing-queue-skeleton-name"></span>' +
          '<span class="cur-skeleton ing-queue-skeleton-size"></span>' +
        '</div>' +
      '</div>';
  } else if (state.queueEstimateError) {
    estimateBody = renderStatus({
      state: 'danger', title: 'Could not estimate this batch', detail: state.queueEstimateError,
    });
  } else if (state.queueEstimate) {
    estimateBody = renderQueueEstimate(state.queueEstimate);
  }

  return (
    '<div class="ing-field">' +
      '<span class="ing-label" id="ing-domain-label">Domain</span>' +
      renderListboxHtml(domainListboxCfg({ disabled: false })) +
    '</div>' +
    '<div class="ing-field">' +
      renderDropZoneHtml({ disabled: false, multiHint: false }) +
    '</div>' +
    (state.queueSubmitError
      ? '<div class="ing-status-block">' +
          renderStatus({ state: 'danger', title: 'Could not start this batch', detail: state.queueSubmitError }) +
        '</div>'
      : '') +
    estimateBody
  );
}

function renderQueueEstimate(est) {
  const fileList = resolveEstimateFileList(est, state.selectedFiles);
  const rejected = Array.isArray(est.files && est.files.rejected) ? est.files.rejected : [];
  const count = (est.files && Number.isFinite(est.files.count)) ? est.files.count : fileList.length;
  const totalBytes = est.files && est.files.totalBytes;
  const provider = escapeHtml(est.provider || 'unknown provider');
  const model = escapeHtml(est.model || 'unknown model');
  const est2 = est.estimate || {};
  const costRange = formatUsdRange(est2.usdLow, est2.usdHigh);
  const tokIn = formatTokenRange(est2.inputTokensLow, est2.inputTokensHigh);
  const tokOut = formatTokenRange(est2.outputTokensLow, est2.outputTokensHigh);
  const warnings = Array.isArray(est.warnings) ? est.warnings : [];

  const rejectedHtml = rejected.length
    ? '<div class="ing-queue-section">' +
        '<div class="ing-queue-section-label">Won’t be included</div>' +
        '<ul class="ing-queue-file-list">' + rejected.map(renderQueueRejectedItem).join('') + '</ul>' +
      '</div>'
    : '';

  const fileListHtml =
    '<div class="ing-queue-section">' +
      '<div class="ing-queue-section-label">Will be ingested (largest first)</div>' +
      '<ul class="ing-queue-file-list" id="ing-queue-file-list">' +
        fileList.map((f) => renderQueueFileListItem(f, { removable: true })).join('') +
      '</ul>' +
    '</div>';

  // A WARNING ON A SPENDING SURFACE. renderStatus, unfolded and above the
  // Start button, never an explainer: v3.16.1's rule is that a warning behind
  // a click is not a warning, and this is the exact surface that rule was
  // learned on. The component makes hiding these structurally awkward — there
  // is no parameter that puts toned text inside a fold — and nothing here
  // works around that.
  //
  // The estimator can emit several; they are one finding about one batch, so
  // they are one box with the lines as its detail rather than N stacked boxes
  // competing with the Start button.
  const warningsHtml = warnings.length
    ? renderStatus({
        state: 'attention',
        title: warnings.length === 1 ? 'Before you start' : 'Before you start (' + warnings.length + ' notes)',
        detail: warnings.map((w) => String(w)).join(' · '),
      })
    : '';

  return (
    '<div class="ing-queue-confirm-head">' +
      '<h3 class="ing-queue-confirm-title">Batch ingest — <span class="ing-num">' + count + '</span> file' + (count === 1 ? '' : 's') + '</h3>' +
      '<div class="ing-queue-confirm-sub">' + formatQueueBytes(totalBytes) + ' total · ' + provider + ' · ' + model + '</div>' +
    '</div>' +
    rejectedHtml +
    fileListHtml +
    // THE TWO FIGURES THIS WHOLE GATE EXISTS FOR, as instruments. They were a
    // hand-built label/value row: the label in body prose, the figure bolded
    // mono — close to right, and one more private description of a role the
    // app now has a single definition of. renderReadout puts the figure in
    // mono at full --text and steps the label back by SIZE and FAMILY, so the
    // cost stops competing with the sentence above it.
    //
    // `basis` — the estimator's own account of HOW it arrived at the range —
    // is PROVENANCE, which is exactly the third field of a readout, and it
    // hangs off the cost it qualifies rather than floating under both rows.
    //
    // ABSENT IS NOT ZERO: formatUsdRange already returns an honest "unknown"
    // string rather than a fabricated $0.00 (test-ingest-queue-frontend.js
    // pins that), and renderReadout drops a provenance line that was never
    // supplied rather than printing "—". Neither behaviour is re-implemented
    // here; both are inherited.
    '<div class="ing-queue-estimate">' +
      renderReadoutGroup([
        { label: 'Estimated cost', value: costRange, provenance: est2.basis || undefined },
        { label: 'Estimated tokens', value: tokIn + ' in / ' + tokOut + ' out' },
      ]) +
    '</div>' +
    warningsHtml +
    '<div class="ing-field ing-queue-budget-row">' +
      '<label class="ing-label" for="ing-queue-budget">Budget cap (optional)</label>' +
      '<input type="number" class="ing-select ing-queue-budget-input" id="ing-queue-budget" min="0" step="0.01" placeholder="No cap" value="' + escapeHtml(state.queueBudgetInput) + '">' +
    '</div>' +
    '<label class="ing-queue-overwrite-row"><input type="checkbox" class="cur-check" id="ing-queue-overwrite"' + (state.queueOverwriteInput ? ' checked' : '') + '> <span>Overwrite existing pages for files already ingested</span></label>' +
    '<div class="ing-queue-confirm-actions">' +
      // sparkles marks a token-spending action (design rule), paired here
      // with the real "Estimated cost" row already rendered above — the
      // pairing the design asks for, unlike the single-file Ingest button.
      '<button type="button" class="btn btn-primary" id="ing-queue-start-btn"' + (state.queueSubmitting ? ' disabled' : '') + '>' +
        icon('sparkles', 14) + ' ' + (state.queueSubmitting ? 'Uploading…' : 'Start batch') +
      '</button>' +
      '<button type="button" class="btn btn-secondary" id="ing-queue-addmore-btn">Add more files</button>' +
      '<button type="button" class="btn btn-ghost" id="ing-queue-clear-btn">Clear all</button>' +
    '</div>'
  );
}

// `opts.removable` adds a per-row remove control, keyed on name+size (the
// same identity dedupeQueueFiles uses) via data attributes the delegated
// click handler in wireQueueListeners reads back.
function renderQueueFileListItem(entry, opts) {
  const name = escapeHtml(sanitizeDisplayName(entry && entry.name != null ? entry.name : ''));
  const size = formatQueueBytes(entry && entry.bytes);
  const removable = !!(opts && opts.removable);
  const rawName = entry && entry.name != null ? String(entry.name) : '';
  const rawBytes = entry && Number.isFinite(entry.bytes) ? String(entry.bytes) : '';
  const removeBtn = removable
    ? '<button type="button" class="ing-queue-file-remove" data-name="' + escapeHtml(rawName) + '" data-bytes="' + escapeHtml(rawBytes) + '" title="Remove this file" aria-label="Remove ' + name + '">' + icon('x', 12) + '</button>'
    : '';
  return '<li class="ing-queue-file-item"><span class="ing-queue-file-name">' + name + '</span><span class="ing-queue-file-size">' + size + '</span>' + removeBtn + '</li>';
}

function renderQueueRejectedItem(entry) {
  const name = escapeHtml(sanitizeDisplayName(entry && entry.name != null ? entry.name : ''));
  const reason = escapeHtml(entry && entry.reason != null ? entry.reason : 'not supported');
  return '<li class="ing-queue-file-item ing-queue-file-rejected"><span class="ing-queue-file-name">' + name + '</span><span class="ing-queue-file-reason">' + reason + '</span></li>';
}

// ── Rendering — live/terminal job panel ────────────────────────────────
//
// computeQueueStatusCounts (the no-item-lost bucketing invariant) and
// computeQueueSpentLabel (in-progress-zero vs terminal-zero) are now
// IMPORTED from ../shared/ingest-queue-logic.js, not reimplemented here —
// see this file's own header comment and the shared module's for why
// (both are pure logic, no markup, so they belong on the byte-identical-
// copy contract with the other 11, not on this file's reimplement-the-
// markup side of the line).

/**
 * A paused batch — state, said without a sentence of our own.
 *
 * `pausedReasonCopy` (shared/ingest-queue-logic.js) stays the ONE source of
 * the words; only their TREATMENT moves to the shared status role. A pause is
 * `attention`, never `danger`: every reason in that table is recoverable and
 * says so ("Nothing was lost", "resume when ready"), and dressing a resumable
 * pause as a failure is the mistake shared/text.js's own status docblock
 * records its precedent avoiding.
 *
 * The rail carries the tone as a BORDER (floor 3:1, which --attention-text
 * clears in both themes) while the words stay at --text / --text-2, which
 * clear the 4.5:1 text floor — where the amber-on-tint TEXT this banner used
 * measures 3.21:1 in the light theme.
 *
 * `pausedMessage` is the server's own account of the pause and is appended to
 * the copy's body rather than dropped: it is the line that names WHICH file or
 * WHICH provider, and it is the one part a user can act on. Absent is not
 * zero — when the server sent none, nothing extra is rendered.
 */
function renderQueuePausedBanner(job) {
  const copy = pausedReasonCopy(job && job.pausedReason);
  const extra = (job && typeof job.pausedMessage === 'string' && job.pausedMessage.trim())
    ? ' ' + job.pausedMessage.trim() : '';
  return renderStatus({
    state: 'attention',
    title: copy.title,
    detail: copy.body + extra,
  });
}

function renderQueueDoneSummary(job) {
  const items = Array.isArray(job && job.items) ? job.items : [];
  const counts = computeQueueStatusCounts(items);
  const doneN = counts.known.done;
  const failedN = counts.known.failed;
  const skippedN = counts.known.skipped;
  const cancelledN = counts.known.cancelled;

  // A CANCELLED batch's untouched items are still sitting at 'pending' on
  // the server (cancel doesn't relabel them) — that's the batch behaving
  // exactly as asked, not an anomaly, so it must not render through the
  // amber unaccounted styling. A FAILED job's leftover pending items are
  // genuinely unexpected and keep it; only 'cancelled' is carved out.
  const isCancelled = job && job.status === 'cancelled';
  const notStartedN = isCancelled ? (counts.other.pending || 0) : 0;
  const otherSpans = Object.keys(counts.other)
    .filter((k) => !(isCancelled && k === 'pending'))
    .sort()
    .map((k) => '<span class="ing-queue-done-unaccounted"><span class="ing-num">' + counts.other[k] + '</span> ' + escapeHtml(k) + '</span>')
    .join('');
  const notStartedSpan = notStartedN > 0 ? '<span><span class="ing-num">' + notStartedN + '</span> not started</span>' : '';

  const pages = items.reduce((sum, i) => sum + (i && i.result && Number.isFinite(i.result.pagesWritten) ? i.result.pagesWritten : 0), 0);
  const warningsN = items.reduce((sum, i) => sum + (i && i.result && Number.isFinite(i.result.warningCount) ? i.result.warningCount : 0), 0);
  // COST HONESTY, two changes on one line's worth of readout:
  //
  //  (1) `toFixed(4)` rendered any real charge under $0.00005 as `$0.0000`,
  //      i.e. a paid batch reported as free. formatUsdHonest renders
  //      `< $0.0001` instead; a genuine zero still reads `$0.00`.
  //
  //  (2) A batch containing a CANCELLED or FAILED item can no longer claim
  //      its total is exact. The queue now attributes the spend those items
  //      really incurred (see chargePartialSpend in src/brain/ingest-queue.js)
  //      but the provider call that was in flight at the moment of the abort
  //      never completed, so it is not in the totals — the figure is a
  //      measured LOWER BOUND, and the panel that read `Finished · $0.0094
  //      spent` after a mid-document cancel was stating a precise-looking
  //      number that was ~35-40% low.
  //
  //  (3) THERE ARE TWO WAYS TO BE INEXACT AND THEY NEED DIFFERENT WORDS.
  //      This line rendered "at least" from `spendIsEstimated`, which is the
  //      flag for the OTHER case: a model with no published price, charged a
  //      share of `estimate.usdHigh`. usdHigh is the no-caching end of an
  //      estimate, not a bound — measured at 66.8% of actual on Anthropic,
  //      i.e. the displayed figure can be ~50% ABOVE real spend. Prefixing
  //      THAT with "at least" asserts a floor that does not exist, which is
  //      the same class of error as the precise-looking figure in (2), just
  //      pointing the other way.
  //
  //      So: `spendIsLowerBound` (a MEASURED partial — every counted dollar
  //      was billed, only the in-flight call is missing) renders "at least ";
  //      `spendIsEstimated` (an ESTIMATE SHARE — could be high or low)
  //      renders "approx. ". Estimated WINS when both are set: the weaker
  //      claim is the true one, and "at least" over a possibly-inflated
  //      number is the reading we must never produce.
  //
  // The qualifier sits OUTSIDE the <span class="ing-num"> below: it is prose,
  // and this view's rule is that the NUMBER is monospace, not the sentence
  // around it (same reasoning as the per-count spans beside it).
  const spentUsd = (job && typeof job.spentUsd === 'number' && Number.isFinite(job.spentUsd)) ? job.spentUsd : null;
  const spentFigure = formatUsdHonest(spentUsd);
  const spent = spentFigure === null ? '—' : spentFigure;
  const spentQualifier = spentFigure === null ? ''
    : (job && job.spendIsEstimated === true) ? 'approx. '
    : (job && job.spendIsLowerBound === true) ? 'at least '
    : '';
  const healthStr = formatHealthCounts(job && job.health && job.health.counts);
  const healthLine = (job && job.health)
    ? '<div class="ing-queue-done-health">Health scan: ' + (healthStr ? escapeHtml(healthStr) : 'no issues found') + ' — see Health inside the <strong>Domains</strong> view.</div>'
    : '';
  // A job-level failure (domain deleted, renamed, or converted to a
  // read-only Shared Brain mirror while the batch sat paused) sets
  // job.failReason server-side and the whole batch stops.
  const failReasonLine = (job && job.status === 'failed' && typeof job.failReason === 'string' && job.failReason)
    ? '<div class="ing-queue-done-fail-reason"><strong>Batch failed:</strong> ' + escapeHtml(job.failReason) + '</div>'
    : '';

  // Every count/dollar figure here is a number, so — per the design's
  // "numbers are always monospace and always exact" — each gets its own
  // <span class="ing-num">, not one blanket class on the whole row (these are
  // short "N label" phrases, same reasoning as formatIngestDoneLabelHtml).
  return (
    '<div class="ing-queue-done-summary">' +
      failReasonLine +
      '<div class="ing-queue-done-totals">' +
        '<span><span class="ing-num">' + doneN + '</span> done</span>' +
        '<span><span class="ing-num">' + failedN + '</span> failed</span>' +
        '<span><span class="ing-num">' + skippedN + '</span> skipped</span>' +
        '<span><span class="ing-num">' + cancelledN + '</span> stopped</span>' +
        notStartedSpan +
        otherSpans +
        '<span><span class="ing-num">' + pages + '</span> page' + (pages === 1 ? '' : 's') + ' written</span>' +
        '<span><span class="ing-num">' + warningsN + '</span> warning' + (warningsN === 1 ? '' : 's') + '</span>' +
        '<span>' + spentQualifier + '<span class="ing-num">' + spent + '</span> spent</span>' +
      '</div>' +
      healthLine +
    '</div>'
  );
}

// Defect #2 fix, ported: cancelRequested/pauseRequested are read straight
// off the job SNAPSHOT (never local click-state alone), so a second tab —
// or a page reload — sees the identical "Cancelling…"/"Pausing…"
// treatment. `state.queueActionBusy` only covers the narrow round-trip
// BEFORE the server has even acknowledged the request; the authoritative
// state afterward is always the snapshot's own flags. TERMINAL STATUS
// ALWAYS BEATS a stale flag: this function returns empty controls/notice
// the instant isQueueTerminal(job.status) is true, regardless of what
// cancelRequested/pauseRequested still say on that same wire frame (a
// real frame can carry status:'cancelled' AND cancelRequested:true
// simultaneously — see the file-header comment).
function computeQueueInFlight(job) {
  if (!job || isQueueTerminal(job.status)) return { noticeHtml: '', controlsHtml: '' };
  const cancelRequested = job.cancelRequested === true;
  const pauseRequested = job.pauseRequested === true;
  const actionBusy = state.queueActionBusy;
  const noticeHtml = (job.status === 'running' && (cancelRequested || pauseRequested))
    ? '<div class="ing-queue-inflight-notice">' +
        (cancelRequested ? 'Cancelling — stopping the current file now.' : 'Pausing after the current file…') +
      '</div>'
    : '';
  // A cancel in flight makes Pause moot too — clicking it while the
  // server is already tearing the job down would just race a pause
  // request against a cancel that's about to win. pauseRequested alone
  // must NOT block escalating straight to Cancel.
  const pauseDisabled = pauseRequested || cancelRequested || actionBusy === 'pause' || actionBusy === 'cancel';
  const cancelDisabled = cancelRequested || actionBusy === 'cancel';
  const primaryBtn = job.status === 'running'
    ? '<button type="button" class="btn btn-secondary" id="ing-queue-pause-btn"' + (pauseDisabled ? ' disabled' : '') + '>' +
        (pauseRequested || actionBusy === 'pause' ? 'Pausing…' : 'Pause') + '</button>'
    : '<button type="button" class="btn btn-primary" id="ing-queue-resume-btn"' + (actionBusy === 'resume' ? ' disabled' : '') + '>' +
        (actionBusy === 'resume' ? 'Starting…' : (job.status === 'pending' ? 'Start' : 'Resume')) + '</button>';
  const controlsHtml =
    '<div class="ing-queue-panel-controls">' +
      primaryBtn +
      '<button type="button" class="btn btn-ghost" id="ing-queue-cancel-btn"' + (cancelDisabled ? ' disabled' : '') + '>' +
        (cancelRequested || actionBusy === 'cancel' ? 'Cancelling…' : 'Cancel') +
      '</button>' +
    '</div>';
  return { noticeHtml, controlsHtml };
}

function renderQueueItemRow(item, opts) {
  const idx = item && Number.isFinite(item.idx) ? item.idx : 0;
  const name = escapeHtml(sanitizeDisplayName(item && item.name != null ? item.name : ''));
  const size = formatQueueBytes(item && item.bytes);
  const jobTerminal = !!(opts && opts.jobTerminal);
  const meta = statusPillMeta(item && item.status, jobTerminal);
  const isRunning = item && item.status === 'running';
  const isFailedItem = item && item.status === 'failed';
  const isCancelledItem = item && item.status === 'cancelled';
  const errorLine = ((isFailedItem || isCancelledItem) && item.error)
    ? '<div class="ing-queue-item-error' + (isCancelledItem ? ' ing-queue-item-stopped-msg' : '') + '">' + escapeHtml(item.error) + '</div>'
    : '';
  const pages = item && item.result && Number.isFinite(item.result.pagesWritten) ? item.result.pagesWritten : null;
  const resultLine = (item && item.status === 'done' && item.result)
    ? '<div class="ing-queue-item-result">' + escapeHtml(sanitizeDisplayName(item.result.title || item.name || '')) + ' — <span class="ing-num">' + (pages == null ? 0 : pages) + '</span> page' + (pages === 1 ? '' : 's') + '</div>'
    : '';
  return (
    '<li class="ing-queue-item-row" data-queue-idx="' + idx + '">' +
      '<div class="ing-queue-item-head">' +
        '<span class="ing-queue-item-name">' + name + '</span>' +
        '<span class="ing-queue-item-size">' + size + '</span>' +
        '<span class="ing-queue-item-pill ' + meta.cls + '">' + escapeHtml(meta.label) + '</span>' +
      '</div>' +
      // The per-item ring. Rendered EMPTY on the initial snapshot even for
      // a running item: the SSE item-progress frame for it may not have
      // arrived yet, and inventing a stage here would be exactly the lie
      // the outer ring exists to prevent. updateQueueItemProgress fills it
      // the moment the server actually reports something.
      '<div class="ing-queue-item-progress' + (isRunning ? '' : ' ing-hidden') + '">' +
        (isRunning
          ? progressRingHtml({
            stages: INGEST_STAGES, stage: 0, stageProgress: 0, size: 20,
            label: '', className: 'pring-sm ing-queue-item-ring',
          })
          : '') +
      '</div>' +
      errorLine +
      resultLine +
    '</li>'
  );
}

// Defect #3 fix, ported: Dismiss only ever renders when isQueueTerminal —
// structurally cannot appear alongside the live Pause/Resume/Cancel
// controls above, since computeQueueInFlight independently returns empty
// controls for the same terminal check. Both booleans are derived from
// the SAME isQueueTerminal() helper (not two hand-duplicated status
// checks, unlike app.js's three separate inline checks) — a smaller
// drift surface for the same guarantee app.js's own audit comment
// describes as "weaker than one shared gate", without fully closing it.
function renderQueuePanel(job) {
  const isTerminal = isQueueTerminal(job.status);
  const items = Array.isArray(job.items) ? job.items : [];
  const settledCount = items.filter((i) => i && (i.status === 'done' || i.status === 'failed' || i.status === 'skipped' || i.status === 'cancelled')).length;
  const spentLabel = computeQueueSpentLabel(job.spentUsd, isTerminal);

  const itemProgressText = isTerminal
    ? 'Finished'
    : ('Item <span class="ing-num">' + Math.min(settledCount + 1, items.length) + '</span> of <span class="ing-num">' + items.length + '</span>');
  // Overall batch progress is a PLAIN PERCENTAGE, not a staged ring: the
  // stages of a batch are its files, and settled/total is a real, exact
  // count the server already gives us. Before the first item settles it is
  // 0 — a real zero, not an unknown — so `value` is a number rather than
  // null, and the orbit is what says the batch is alive.
  //
  // The spend label keeps computeQueueSpentLabel's honesty verbatim: an
  // in-progress zero reads "spend so far: pending first file", never a
  // misleading $0.0000 (v3.3.1), and formatUsdHonest's "at least $X" lower
  // bound is untouched. The ring sits BESIDE that line, it does not
  // replace it.
  const overallValue = items.length > 0 ? (settledCount / items.length) * 100 : 0;
  const headerHtml =
    '<div class="ing-queue-panel-head">' +
      progressRingHtml({
        value: overallValue,
        // A cancelled batch is terminal with items that never started, so
        // settled/total never reaches 100. The orbit must still stop: the
        // work is over. The count stays truthful; only the liveness layer
        // is told the job ended.
        complete: isTerminal,
        size: 32,
        tone: isTerminal ? 'success' : 'accent',
        center: 'none',
        className: 'ing-queue-panel-ring',
      }) +
      '<div class="ing-queue-panel-headtext">' +
        '<div class="ing-queue-panel-title">Batch ingest — <span class="ing-name">' + escapeHtml(job.domain || '') + '</span></div>' +
        '<div class="ing-queue-panel-sub">' +
          itemProgressText +
          ' · <span class="ing-num">' + escapeHtml(spentLabel) + '</span>' +
        '</div>' +
      '</div>' +
    '</div>';

  const streamErrorHtml = state.queueStreamError
    ? '<div class="ing-status-block">' +
        renderStatus({ state: 'danger', title: 'Lost the live connection to this batch', detail: state.queueStreamError }) +
      '</div>'
    : '';
  // Files were dropped onto this panel, which has no drop zone. Say what
  // happened and what to do instead, rather than leaving the drag to
  // disappear — the whole point of the guard that caught it. `isTerminal`
  // picks the recovery sentence, because the two states have different ones.
  const dropIgnoredHtml = state.queueDropIgnored
    ? '<div class="ing-status-block">' +
        renderStatus({
          state: 'attention',
          title: 'Those files were not added',
          detail: isTerminal
            ? 'This batch has finished. Dismiss it to get the drop zone back, then drop them again.'
            : 'A batch is already running, and files cannot be added to one once it has started. Wait for it to finish, then drop them into the new batch.',
        }) +
      '</div>'
    : '';
  const pausedHtml = job.status === 'paused' ? renderQueuePausedBanner(job) : '';
  const doneHtml = isTerminal ? renderQueueDoneSummary(job) : '';
  const { noticeHtml, controlsHtml } = computeQueueInFlight(job);

  const cancelConfirmHtml = (!isTerminal && state.queueCancelConfirmOpen)
    ? '<div class="ing-queue-panel-controls ing-queue-cancel-confirm">' +
        '<span>Cancel this batch? Items already ingested stay in the wiki; anything not started yet is skipped.</span>' +
        '<button type="button" class="btn btn-secondary" id="ing-queue-cancel-yes-btn"' + (state.queueActionBusy === 'cancel' ? ' disabled' : '') + '>' +
          (state.queueActionBusy === 'cancel' ? 'Cancelling…' : 'Yes, cancel') +
        '</button>' +
        '<button type="button" class="btn btn-ghost" id="ing-queue-cancel-no-btn"' + (state.queueActionBusy === 'cancel' ? ' disabled' : '') + '>Never mind</button>' +
      '</div>'
    : controlsHtml;

  const dismissHtml = isTerminal
    ? '<div class="ing-queue-terminal-actions"><button type="button" class="btn btn-secondary" id="ing-queue-dismiss-btn">Dismiss</button></div>'
    : '';

  const listHtml = '<ul class="ing-queue-item-list">' + items.map((item) => renderQueueItemRow(item, { jobTerminal: isTerminal })).join('') + '</ul>';

  return headerHtml + streamErrorHtml + dropIgnoredHtml + pausedHtml + noticeHtml + doneHtml + dismissHtml + cancelConfirmHtml + listHtml;
}

// ── Listeners ─────────────────────────────────────────────────────────
// Same discipline as wireListeners above — entered synchronously by real
// click/input events, myMountToken read fresh inside each handler body.
// Text/number inputs update `state` WITHOUT calling render() (matches
// sync.js's own setup-form inputs) — a full DOM rebuild on every
// keystroke would steal focus out from under the user's cursor.

function wireQueueListeners() {
  // Confirm gate
  const startBtn = document.getElementById('ing-queue-start-btn');
  if (startBtn) startBtn.addEventListener('click', () => beginQueueJob(myMountToken));
  const addMoreBtn = document.getElementById('ing-queue-addmore-btn');
  if (addMoreBtn) addMoreBtn.addEventListener('click', () => document.getElementById('ing-file-input')?.click());
  const clearBtn = document.getElementById('ing-queue-clear-btn');
  if (clearBtn) clearBtn.addEventListener('click', () => resetQueueSelection(myMountToken));
  const budgetInput = document.getElementById('ing-queue-budget');
  if (budgetInput) budgetInput.addEventListener('input', (e) => { state.queueBudgetInput = e.target.value; });
  const overwriteInput = document.getElementById('ing-queue-overwrite');
  if (overwriteInput) overwriteInput.addEventListener('change', (e) => { state.queueOverwriteInput = !!e.target.checked; });
  const fileListEl = document.getElementById('ing-queue-file-list');
  if (fileListEl) {
    // One delegated listener for every per-row remove button, rather than
    // one per row — the list is rebuilt wholesale on every render anyway.
    fileListEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.ing-queue-file-remove');
      if (!btn) return;
      removeQueueFile(myMountToken, btn.dataset.name || '', btn.dataset.bytes || '');
    });
  }

  // Live/terminal job panel
  const jobId = state.queueJob && state.queueJob.jobId;
  const pauseBtn = document.getElementById('ing-queue-pause-btn');
  if (pauseBtn) pauseBtn.addEventListener('click', () => pauseQueueJob(myMountToken, jobId));
  const resumeBtn = document.getElementById('ing-queue-resume-btn');
  if (resumeBtn) resumeBtn.addEventListener('click', () => resumeQueueJob(myMountToken, jobId));
  const cancelBtn = document.getElementById('ing-queue-cancel-btn');
  if (cancelBtn) cancelBtn.addEventListener('click', () => { state.queueCancelConfirmOpen = true; render(myMountToken); });
  const cancelYesBtn = document.getElementById('ing-queue-cancel-yes-btn');
  if (cancelYesBtn) cancelYesBtn.addEventListener('click', () => confirmCancelQueueJob(myMountToken, jobId));
  const cancelNoBtn = document.getElementById('ing-queue-cancel-no-btn');
  if (cancelNoBtn) {
    cancelNoBtn.addEventListener('click', () => {
      state.queueCancelConfirmOpen = false;
      render(myMountToken);
      refreshQueueJob(myMountToken, jobId);
    });
  }
  const dismissBtn = document.getElementById('ing-queue-dismiss-btn');
  if (dismissBtn) dismissBtn.addEventListener('click', () => dismissQueuePanel(myMountToken));
}
