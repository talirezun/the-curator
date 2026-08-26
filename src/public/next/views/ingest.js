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
  progressRingHtml, INGEST_STAGES, mapIngestPctToStage,
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
    loadDomains(mountToken).catch((err) => reportAsyncMountFailure(mountToken, err));

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

      // Write-gate subscription cleanup — a torn-down mount must stop
      // reacting to gate changes.
      if (unsubscribeWriteGate) { unsubscribeWriteGate(); unsubscribeWriteGate = null; }
    };
  },
});

async function loadDomains(token) {
  // Capture the gate for THIS call. `loadGate` is module-scoped and the
  // next mount replaces it, so settling the module variable from a stale
  // in-flight load would decrement the NEXT mount's counter and hide a
  // loader that is legitimately up. A cancelled gate ignores settle(), so
  // the stale path becomes a no-op instead.
  const gate = loadGate;
  try {
    const res = await fetch('/api/domains/stats');
    const data = await res.json();
    if (!isCurrentMount(token)) return;
    const readonly = new Set(data.readonlyDomains || []);
    const list = (data.domains || [])
      .filter((d) => d && d.slug && !readonly.has(d.slug))
      .map((d) => ({ slug: d.slug, displayName: d.displayName || d.slug }));
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

function renderSidebar(token) {
  const inQueueMode = state.queueModeActive || !!state.queueJob;
  const crossBusy = !inQueueMode && state.domain && !state.submitting && isDomainWriteBusy(state.domain);
  const busyNote = crossBusy
    ? '<div class="ing-sidebar-busy">' + icon('alertTriangle', 13) +
      '<span>A write (' + escapeHtml(getDomainWriteLabel(state.domain) || 'write') +
      ') is already running for <span class="mono">' + escapeHtml(state.domain) + '</span>.</span></div>'
    : '';

  const hint = inQueueMode
    ? 'Files process one at a time, so a single failure costs one file, not the whole batch. A paused or ' +
      'interrupted batch picks back up where it left off.'
    : 'One file at a time, so a failure never costs more than that one file. Each source is decomposed into ' +
      'entity, concept and summary pages and merged into what already exists.';
  const note = inQueueMode
    ? '<div class="sidebar-note">Drop 2+ files (or add to a selection already started) to build a batch.</div>'
    : '<div class="sidebar-note">Drop 2 or more files at once to start a batch.</div>';

  setSidebar(
    '<div class="sidebar-title">Ingest</div>' +
    '<div class="sidebar-hint">' + hint + '</div>' +
    note +
    busyNote,
    token
  );
}

function renderMain(token) {
  let body;
  if (state.loadingDomains) {
    body = gatedLoader(loadGate, 'Loading domains…');
  } else if (state.domainsError) {
    body = '<div class="settings-inline-error">Could not load domains: ' + escapeHtml(state.domainsError) + '</div>';
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

  setMain(
    eyebrow('the way material gets in') +
    '<h1 class="view-title">Ingest</h1>' +
    '<div class="view-body">Drop in a <span class="mono">.pdf</span>, <span class="mono">.md</span> or ' +
    '<span class="mono">.txt</span> source — or several at once for a batch. The Curator reads them and ' +
    'updates the wiki automatically.</div>' +
    body,
    token
  );
}

function renderIngestForm() {
  const crossBusy = state.domain && !state.submitting && isDomainWriteBusy(state.domain);
  const btnDisabled = !state.file || !!state.fileError || state.submitting || crossBusy || !state.domain;
  let btnTitle = '';
  if (crossBusy) {
    btnTitle = 'A write (' + (getDomainWriteLabel(state.domain) || 'write') + ') is already running for domain "' +
      state.domain + '" — wait for it to finish, or switch to a different domain.';
  }

  const domainOptions = state.domains.map((d) => (
    '<option value="' + escapeHtml(d.slug) + '"' + (d.slug === state.domain ? ' selected' : '') + '>' +
      escapeHtml(d.displayName) +
    '</option>'
  )).join('');

  return (
    '<div class="ing-field">' +
      '<label class="ing-label" for="ing-domain">Domain</label>' +
      '<select class="ing-select" id="ing-domain"' + (state.submitting ? ' disabled' : '') + '>' + domainOptions + '</select>' +
    '</div>' +
    '<div class="ing-field">' +
      '<label class="ing-label" for="ing-file-input">File</label>' +
      renderDropZoneHtml({ disabled: state.submitting, multiHint: true }) +
      (state.file ? '<span class="ing-file-name mono">' + escapeHtml(state.file.name) + '</span>' : '') +
      (state.fileError ? '<div class="ing-field-error">' + escapeHtml(state.fileError) + '</div>' : '') +
    '</div>' +
    // sparkles marks a token-spending action (design rule) — ingest always
    // calls an LLM. The design pairs sparkles with a cost figure in the
    // label; single-file has no estimate today (only the batch confirm
    // gate calls POST /api/ingest-queue/estimate), so the mark is present
    // here without one — a known, deliberate gap, not an oversight, while
    // whether to add a single-file estimate is decided separately.
    '<button type="button" class="btn btn-primary" id="ing-submit-btn"' +
      (btnDisabled ? ' disabled' : '') + (btnTitle ? ' title="' + escapeHtml(btnTitle) + '"' : '') + '>' +
      icon('sparkles', 14) + ' ' + (state.submitting ? 'Ingesting…' : 'Ingest') +
    '</button>' +
    renderProgress() +
    renderDuplicate() +
    (state.errorMessage ? '<div class="settings-inline-error" style="margin-top:14px">' + escapeHtml(state.errorMessage) + '</div>' : '') +
    renderResult()
  );
}

// Shared by the single-file idle form AND the batch confirm gate — both
// need an identically-behaved drop zone / hidden multi-file input; only
// the surrounding context differs. `multiHint` swaps the helper text to
// mention batching (shown only in the single-file idle state, where a
// user might not know dropping 2+ files does something different).
function renderDropZoneHtml({ disabled, multiHint }) {
  const hint = multiHint
    ? 'Drop file(s) here or <label for="ing-file-input" class="ing-browse-link">browse</label> — 2 or more starts a batch'
    : 'Drop more files here or <label for="ing-file-input" class="ing-browse-link">browse</label>';
  return (
    '<div class="ing-drop-zone' + (state.dragActive ? ' ing-drop-zone-active' : '') + '" id="ing-drop-zone">' +
      '<span>' + hint + '</span>' +
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
  // class="mono"> around every number. Every OTHER progress label is a
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
  const sublabelHtml =
    (pct >= 100
      ? 'finished'
      : 'stage <span class="mono">' + stageOrdinal + '</span> of <span class="mono">' + INGEST_STAGES.length + '</span>') +
    ' · <span class="mono" id="ing-elapsed">' + escapeHtml(elapsedNow) + '</span>' +
    ' · <span class="mono">' + pct + '%</span>';

  return (
    '<div class="ing-progress">' +
      progressRingHtml({
        stages: INGEST_STAGES,
        stage,
        stageProgress,
        size: 48,
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
  const mono = (n) => '<span class="mono">' + n + '</span>';
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
  const r = state.result;
  if (!r) return '';
  const titlePrefix = r.wasOverwrite ? 'Re-ingested:' : 'Ingested:';
  const warningsHtml = renderWarningsHtml(r.warnings);
  const changesHtml = renderChangeRecordsHtml(r.changes, titlePrefix + ' ' + (r.title || ''), r.unchangedExpanded);
  const fallbackHtml = (!r.changes || !r.changes.length)
    ? '<ul class="ing-change-list-flat">' + (r.pagesWritten || []).map((p) => '<li class="mono">' + escapeHtml(p) + '</li>').join('') + '</ul>'
    : '';
  const tokenHtml = formatTokenUsageHtml(r.tokenUsage);
  return (
    '<div class="ing-result">' +
      warningsHtml +
      (r.changes && r.changes.length ? changesHtml : ('<h3 class="ing-result-title">' + escapeHtml(titlePrefix + ' ' + (r.title || '')) + '</h3>' + fallbackHtml)) +
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

function renderChangeRecordsHtml(changes, title, unchangedExpanded) {
  const created = changes.filter((c) => c.status === 'created');
  const updated = changes.filter((c) => c.status === 'updated');
  const unchanged = changes.filter((c) => c.status === 'unchanged');

  const formatRecord = (c) => {
    let detail = '';
    if (c.status === 'updated' && c.bulletsAdded > 0) {
      const sections = c.sectionsChanged && c.sectionsChanged.length
        ? ' in ' + c.sectionsChanged.map(escapeHtml).join(', ')
        : '';
      detail = '<span class="ing-change-detail">+<span class="mono">' + c.bulletsAdded + '</span> bullet' + (c.bulletsAdded === 1 ? '' : 's') + sections + '</span>';
    } else if (c.status === 'created') {
      detail = '<span class="ing-change-detail mono">' + formatBytesLocal(c.bytesAfter) + '</span>';
    } else if (c.status === 'updated') {
      detail = '<span class="ing-change-detail mono">' + formatBytesLocal(c.bytesBefore) + ' → ' + formatBytesLocal(c.bytesAfter) + '</span>';
    }
    return '<li><span class="ing-change-path mono">' + escapeHtml(c.canonPath) + '</span>' + detail + '</li>';
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
      '<div class="ing-change-header">' + icon('plus', 13) + ' <span class="mono">' + created.length + '</span> new ' + (created.length === 1 ? 'page' : 'pages') + '</div>' +
      '<ul class="ing-change-list">' + created.map(formatRecord).join('') + '</ul>' +
    '</div>'
  ) : '';

  const updatedBlock = updated.length ? (
    '<div class="ing-change-section ing-change-updated">' +
      '<div class="ing-change-header">' + icon('activity', 13) + ' <span class="mono">' + updated.length + '</span> ' + (updated.length === 1 ? 'page' : 'pages') + ' updated</div>' +
      '<ul class="ing-change-list">' + updated.map(formatRecord).join('') + '</ul>' +
    '</div>'
  ) : '';

  const unchangedBlock = unchanged.length ? (
    '<div class="ing-change-section">' +
      '<button type="button" class="ing-change-toggle" id="ing-unchanged-toggle">' +
        (unchangedExpanded ? 'Hide ' : 'Show ') + '<span class="mono">' + unchanged.length + '</span> unchanged ' + (unchanged.length === 1 ? 'page' : 'pages') +
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
  if (buckets.fixed) summaryParts.push('<span style="color:var(--success-text)"><span class="mono">' + buckets.fixed + '</span> auto-fixed</span>');
  if (buckets.review) summaryParts.push('<span style="color:var(--attention-text)"><span class="mono">' + buckets.review + '</span> for review</span>');
  if (buckets.attention) summaryParts.push('<span style="color:var(--danger-text)"><span class="mono">' + buckets.attention + '</span> attention</span>');
  if (buckets.info) summaryParts.push('<span style="color:var(--accent-text)"><span class="mono">' + buckets.info + '</span> info</span>');
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
      '<strong>Ingest finished — <span class="mono">' + warnings.length + '</span> note' + (warnings.length === 1 ? '' : 's') + '</strong>' +
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
  return '<div class="ing-token-usage mono">' + parts.join('') + '</div>';
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

function wireListeners() {
  const domainSelect = document.getElementById('ing-domain');
  if (domainSelect) {
    domainSelect.addEventListener('change', (e) => {
      state.domain = e.target.value || null;
      // Ported from src/public/app.js's own domain-select listener: a
      // domain change at the confirm gate (pre-job) means a different
      // index size and a different cost, so re-estimate. Never fires once
      // a job exists — the select is disabled by then (see renderQueuePanel).
      if (state.queueModeActive && !state.queueJob) {
        startQueueSelection(myMountToken);
      } else {
        render(myMountToken);
      }
    });
  }

  const dropZone = document.getElementById('ing-drop-zone');
  const fileInput = document.getElementById('ing-file-input');
  if (dropZone) {
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); state.dragActive = true; render(myMountToken); });
    dropZone.addEventListener('dragleave', () => { state.dragActive = false; render(myMountToken); });
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      state.dragActive = false;
      handleSelectedFiles(myMountToken, e.dataTransfer.files);
    });
    dropZone.addEventListener('click', (e) => {
      if (e.target.closest('label')) return; // the <label for=...> already opens the picker natively
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
  if (incoming.length === 0) return;

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
    }
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
  applyQueueBusyForStatus(job.status, domain);
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
  const domainOptions = state.domains.map((d) => (
    '<option value="' + escapeHtml(d.slug) + '"' + (d.slug === state.domain ? ' selected' : '') + '>' +
      escapeHtml(d.displayName) +
    '</option>'
  )).join('');

  let estimateBody = '';
  if (state.queueEstimateLoading) {
    const n = state.selectedFiles.length;
    estimateBody = '<p class="view-body">Estimating cost for <span class="mono">' + n + '</span> file' + (n === 1 ? '' : 's') + '…</p>';
  } else if (state.queueEstimateError) {
    estimateBody = '<div class="settings-inline-error">' + escapeHtml(state.queueEstimateError) + '</div>';
  } else if (state.queueEstimate) {
    estimateBody = renderQueueEstimate(state.queueEstimate);
  }

  return (
    '<div class="ing-field">' +
      '<label class="ing-label" for="ing-domain">Domain</label>' +
      '<select class="ing-select" id="ing-domain">' + domainOptions + '</select>' +
    '</div>' +
    '<div class="ing-field">' +
      renderDropZoneHtml({ disabled: false, multiHint: false }) +
    '</div>' +
    (state.queueSubmitError ? '<div class="settings-inline-error" style="margin-bottom:14px">' + escapeHtml(state.queueSubmitError) + '</div>' : '') +
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
  const basis = est2.basis ? escapeHtml(est2.basis) : '';
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

  const warningsHtml = warnings.length
    ? '<div class="ing-queue-warnings">' + warnings.map((w) => '<div>' + escapeHtml(String(w)) + '</div>').join('') + '</div>'
    : '';

  return (
    '<div class="ing-queue-confirm-head">' +
      '<h3 class="ing-queue-confirm-title">Batch ingest — <span class="mono">' + count + '</span> file' + (count === 1 ? '' : 's') + '</h3>' +
      '<div class="ing-queue-confirm-sub mono">' + formatQueueBytes(totalBytes) + ' total · ' + provider + ' · ' + model + '</div>' +
    '</div>' +
    rejectedHtml +
    fileListHtml +
    '<div class="ing-queue-estimate">' +
      '<div class="ing-queue-estimate-row"><span>Estimated cost</span><strong class="mono">' + escapeHtml(costRange) + '</strong></div>' +
      '<div class="ing-queue-estimate-row"><span>Estimated tokens</span><span class="mono">' + escapeHtml(tokIn) + ' in / ' + escapeHtml(tokOut) + ' out</span></div>' +
      (basis ? '<div class="ing-queue-estimate-basis">' + basis + '</div>' : '') +
    '</div>' +
    warningsHtml +
    '<div class="ing-field ing-queue-budget-row">' +
      '<label class="ing-label" for="ing-queue-budget">Budget cap (optional)</label>' +
      '<input type="number" class="ing-select ing-queue-budget-input" id="ing-queue-budget" min="0" step="0.01" placeholder="No cap" value="' + escapeHtml(state.queueBudgetInput) + '">' +
    '</div>' +
    '<label class="ing-queue-overwrite-row"><input type="checkbox" id="ing-queue-overwrite"' + (state.queueOverwriteInput ? ' checked' : '') + '> Overwrite existing pages for files already ingested</label>' +
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
  return '<li class="ing-queue-file-item"><span class="ing-queue-file-name mono">' + name + '</span><span class="ing-queue-file-size mono">' + size + '</span>' + removeBtn + '</li>';
}

function renderQueueRejectedItem(entry) {
  const name = escapeHtml(sanitizeDisplayName(entry && entry.name != null ? entry.name : ''));
  const reason = escapeHtml(entry && entry.reason != null ? entry.reason : 'not supported');
  return '<li class="ing-queue-file-item ing-queue-file-rejected"><span class="ing-queue-file-name mono">' + name + '</span><span class="ing-queue-file-reason">' + reason + '</span></li>';
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

function renderQueuePausedBanner(job) {
  const copy = pausedReasonCopy(job && job.pausedReason);
  const detail = (job && typeof job.pausedMessage === 'string' && job.pausedMessage)
    ? '<div class="ing-queue-paused-detail">' + escapeHtml(job.pausedMessage) + '</div>' : '';
  return (
    '<div class="ing-queue-paused-banner">' +
      '<div class="ing-queue-paused-title">' + escapeHtml(copy.title) + '</div>' +
      '<div class="ing-queue-paused-body">' + escapeHtml(copy.body) + '</div>' +
      detail +
    '</div>'
  );
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
    .map((k) => '<span class="ing-queue-done-unaccounted"><span class="mono">' + counts.other[k] + '</span> ' + escapeHtml(k) + '</span>')
    .join('');
  const notStartedSpan = notStartedN > 0 ? '<span><span class="mono">' + notStartedN + '</span> not started</span>' : '';

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
  // The qualifier sits OUTSIDE the <span class="mono"> below: it is prose,
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
  // <span class="mono">, not one blanket class on the whole row (these are
  // short "N label" phrases, same reasoning as formatIngestDoneLabelHtml).
  return (
    '<div class="ing-queue-done-summary">' +
      failReasonLine +
      '<div class="ing-queue-done-totals">' +
        '<span><span class="mono">' + doneN + '</span> done</span>' +
        '<span><span class="mono">' + failedN + '</span> failed</span>' +
        '<span><span class="mono">' + skippedN + '</span> skipped</span>' +
        '<span><span class="mono">' + cancelledN + '</span> stopped</span>' +
        notStartedSpan +
        otherSpans +
        '<span><span class="mono">' + pages + '</span> page' + (pages === 1 ? '' : 's') + ' written</span>' +
        '<span><span class="mono">' + warningsN + '</span> warning' + (warningsN === 1 ? '' : 's') + '</span>' +
        '<span>' + spentQualifier + '<span class="mono">' + spent + '</span> spent</span>' +
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
    ? '<div class="ing-queue-item-result">' + escapeHtml(sanitizeDisplayName(item.result.title || item.name || '')) + ' — <span class="mono">' + (pages == null ? 0 : pages) + '</span> page' + (pages === 1 ? '' : 's') + '</div>'
    : '';
  return (
    '<li class="ing-queue-item-row" data-queue-idx="' + idx + '">' +
      '<div class="ing-queue-item-head">' +
        '<span class="ing-queue-item-name mono">' + name + '</span>' +
        '<span class="ing-queue-item-size mono">' + size + '</span>' +
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
    : ('Item <span class="mono">' + Math.min(settledCount + 1, items.length) + '</span> of <span class="mono">' + items.length + '</span>');
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
        '<div class="ing-queue-panel-title">Batch ingest — <span class="mono">' + escapeHtml(job.domain || '') + '</span></div>' +
        '<div class="ing-queue-panel-sub">' +
          itemProgressText +
          ' · <span class="mono">' + escapeHtml(spentLabel) + '</span>' +
        '</div>' +
      '</div>' +
    '</div>';

  const streamErrorHtml = state.queueStreamError
    ? '<div class="settings-inline-error" style="margin-bottom:14px">' + escapeHtml(state.queueStreamError) + '</div>'
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

  return headerHtml + streamErrorHtml + pausedHtml + noticeHtml + doneHtml + dismissHtml + cancelConfirmHtml + listHtml;
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
