// View: Sync — "where it all lives". A footer item rather than a rail
// peer: you need to know at a glance that changes are unpushed (the rail
// badge), but rarely need to come here on purpose.
//
// Backend used (all pre-existing — see src/routes/sync.js, src/brain/sync.js):
//   GET    /api/sync/status                    → {configured, changesCount, uncommittedCount,
//                                                  unpushedCommits, lastSync, repoUrl}
//   POST   /api/sync/setup {repoUrl, token, mode}
//   POST   /api/sync/push | /pull | /sync      (through shared/sync-run.js, v3.89.2)
//   GET    /api/sync/job                       → {running, last} — a run this page did not start
//   DELETE /api/sync/disconnect
//   POST   /api/sync/token {token}             → Replace token (2026-11-19)
// Every error answers {error, detail?, code?}: `error` is the sentence shown,
// `detail` is shown under it as "Technical detail (for support):", and the
// codes in tokenErrorCodes() open the Replace token panel beside the error.
// Plus two read-only calls used ONLY to render honest context, not owned
// by this view's write surface:
//   GET /api/domains                 → real domain names for the sidebar list
//   GET /api/sharedbrain/feature-flag + /list → the one-line SB reporting row
//     (404s cleanly when the flag is off — treated as "not connected", not
//     an error)
//
// Honesty notes:
//   - There is NO commit-history/revert endpoint anywhere in the backend
//     (verified against src/brain/sync.js and src/routes/sync.js — push()
//     and pull() return only a same-call file-count/preview, not a
//     persisted log with revertable entries), and there never has been one —
//     CLAUDE.md v3.9.1 records finding a FALSE "revert it from the Sync tab"
//     claim at 8 sites app-wide. The design's original History section
//     rendered an honest "coming soon" card for it. Reported by the
//     maintainer (v3.24.0): that card reads as an unexplained roadmap note
//     on an operational panel — "why is this here?" — because it names a
//     feature nobody asked for, on a screen whose job is running syncs, not
//     announcing a backlog. Removed outright. The one fact worth keeping —
//     every sync IS a real git commit, so a git client pointed at the
//     knowledge-base folder can already revert by hand — is not a "coming
//     soon" tease, it is the actual recovery path today; it now lives
//     behind renderMain()'s info mark (see renderMain() below) rather than
//     in a dedicated card, per v3.22.0's rule that an EXPLANATION (as
//     opposed to a warning, a cost, or an irreversibility notice) belongs
//     behind the icon. The same fact is documented in full, with the exact
//     git commands, at docs/sync.md's "no revert control" callout.
//   - GET /api/sync/status returns a single TOTAL changesCount (v3.72.1:
//     files not on GitHub — uncommitted plus unpushed commits); there is no per-file or per-domain endpoint
//     that doesn't ALSO perform a real push/pull. The sidebar therefore
//     lists the real domain NAMES only ("what this backup covers"), with the
//     one real total in the main pane. An earlier version added a per-domain
//     state column that rendered a hardcoded "—" plus a footnote explaining
//     why it was empty; both were removed at cutover — see renderSidebar().
//
// MEDIUM-3 fix (re-audit, second round): this view used to guard its async
// work with a hand-rolled `let mounted = false` boolean instead of the
// mount-token primitive chat.js/domains.js use (isCurrentMount). That
// looked equivalent but wasn't: a boolean can only say "is SOME mount of
// this view still current", not "is THIS SPECIFIC mount still current" —
// it can't distinguish "still mounted" from "REmounted" (navigate away and
// back to Sync is a fresh onEnter with a NEW token, but `mounted` just
// flips false-then-true-again and reads identical to never having left).
// Demonstrated live: mount A's abandoned push/pull result surfaced under
// mount B. Migrated to the same token discipline as chat.js/domains.js —
// every async function captures `const token = myMountToken` (or receives
// one) before its first await and checks isCurrentMount(token) after.
// setSidebar/setMain in app.js now also REQUIRE a token (fail closed on
// omission) — this view could no longer opt out even if it tried to.
//
// Cross-view write gate (this session's task): Push / Pull / Sync now /
// Disconnect all run `git` against the SAME work-tree that ingests and
// Shared Brain pulls are writing wiki pages into — `git pull --no-rebase
// -X theirs` can race a write in progress, and `git add -A` would snapshot
// a half-written batch. The backend already knows this: every one of these
// four routes is wrapped in `guardConcurrent()` (src/routes/sync.js), which
// checks `hasActiveWrites()` (src/brain/write-registry.js — ANY domain, not
// a specific one, because sync's work-tree spans every domain) and refuses
// with a 409 mid-write. Until this change that 409 was the ONLY thing
// stopping the click — the user saw a raw failure with no warning
// beforehand. This view now reads the SAME signal the backend already acts
// on (app.js's isAnyWriteBusy(), the frontend mirror of hasActiveWrites())
// and disables the four buttons proactively, so the common case is a
// disabled control with an explanation instead of a failed request.
// `/api/sync/setup` (the "Connect" button on the unconfigured card) is
// deliberately NOT gated — it has no guardConcurrent() wrapper on the
// backend (a fresh repo connection can't conflict with an in-flight write
// the way a push/pull/sync/disconnect against an ALREADY-connected repo
// can), so gating it here would be inventing a restriction the backend
// doesn't itself enforce.
//
// FAIL-OPEN, not fail-closed (see crossWriteBusy() below): if reading gate
// state ever throws, every button stays ENABLED. The backend's 409 is the
// real safety net; a frontend read failure should degrade to "the user
// might see an honest error", never to "Sync is permanently unusable with
// no path forward but a page reload".

import {
  registerView, setSidebar, setMain, escapeHtml, icon, navigate, isCurrentMount,
  reportAsyncMountFailure, reportAsyncActionFailure,
  isAnyWriteBusy, getDomainWriteLabel, onWriteGateChange,
  refreshSyncBadge, refreshSyncRemoteBadge, openReader,
} from '../app.js';
import { createLoadingGate, gatedLoader, settleGate } from '../shared/loading-gate.js';
// The ONE text system in /next. renderViewHeader owns the top of this view so a
// paragraph cannot float under the title; renderStatus carries the cross-write
// refusal that used to live in a `title=` on a DISABLED button (see below).
import { renderViewHeader, renderStatus } from '../shared/text.js';
// v3.71.1: the ONE ⓘ on this view — the main header's `sync.page` explainer.
import { explainerHtml } from '../shared/explainer.js';
// v3.89.2: a push/pull/sync run belongs to the SHELL, not to this mount —
// leaving the page used to drop it (see shared/sync-run.js for the measured
// report). This view only starts runs there and paints what it says.
import {
  SYNC_RUN_KINDS, currentSyncRun, lastSyncOutcome, markOutcomeSeen,
  onSyncRunChange, configureSyncRun, startSyncRun, adoptServerSyncJob,
  dismissDeletionQuestion,
} from '../shared/sync-run.js';
// v4.2.1: the deletion guard's question, as a card on this page.
import { deletionCardHtml, deletionListHtml } from '../shared/sync-deletion-card.js';
// ── THE MONITOR ─────────────────────────────────────────────
// `.sync-status-card` was a HAND COPY of views/settings.js's bridge status
// card — the same status pill, the same mono `<code>` identity
// line, the same trailing age — written twice in two files. Two hand copies of
// one pattern is this project's definition of a component since v3.55.0, and
// the maintainer's own reading of them is the reason: *"we are looking for a
// unified design AND a distinguished design, so this can be distinguished from
// other sections, other cards."* Both call sites are now the same call.
import { renderMonitor } from '../shared/monitor.js';
import { backupReportHtml, connectNeedsReview, connectReviewHtml, reviewFolders } from './sync-backup.js';
import { machineWord as thisMachine } from '../shared/platform.js';
// v3.99.2: only a code a person can look up in the published catalogue is
// shown on the support line (the same test net.js's support line uses).
import { isCatalogueCode } from '../shared/user-errors.js';
// A caught error (a thrown sentence with .detail/.code, the fetch wrapper's
// server-unreachable, or a JSON parse failure on an HTML page) as {error,
// detail, code}: raw parser text never becomes the sentence.
import { userMessageFrom } from '../shared/net.js';

function freshState() {
  return {
    loading: true,
    status: null,      // GET /api/sync/status response
    statusError: null,
    domains: [],        // GET /api/domains → domains[]
    sb: null,           // { enabled, connections: [] | null(unreadable) } | null while loading
    acting: null,       // 'sync' | 'push' | 'pull' | 'disconnect' | 'token' | null
    actionMessage: null,
    actionError: null,
    actionErrorDetail: null, // the route's `detail`: shown, smaller, under the error
    actionErrorCode: null,   // the route's `code`: a token code opens Replace token
    // v4.2.1: the deletion guard's question (the outcome it arrived on):
    // {kind, details, confirmed}. Shown as the confirm card instead of the error.
    deletionAsk: null,
    // The question whose heading already took the focus (audit m4).
    deletionFocusedToken: null,
    // Delete them was pressed: its button goes with the card, so when that
    // run settles the focus returns to the button of the action it answered
    // (audit m4: it was left on the page body).
    focusAfterConfirm: null,
    statusErrorDetail: null,
    statusErrorCode: null,
    // Replace token (2026-11-19). `token` holds keystrokes only until the
    // submit reads them: it is cleared at that moment, on cancel, and in the
    // teardown, and never written into markup (see renderTokenPanel).
    tokenForm: { open: false, dismissed: false, token: '', submitting: false, error: null, detail: null, code: null, focusPending: false },
    disconnectConfirmOpen: false,
    // `decision` is the connect flow's second screen, and it exists because
    // of the v3.32.0 incident: a refusal that leaves only a destructive door
    // open is not a guard. Shapes: null (no decision pending),
    // {kind:'overwrite', count, sample, createCount}, {kind:'adopt', originUrl},
    // {kind:'foreign', originUrl}, {kind:'remote-empty'|'remote-not-empty'}.
    // Every one of them offers at least one NON-destructive way forward.
    setupForm: {
      repoUrl: '', token: '', mode: 'push', submitting: false, error: null, errorDetail: null, errorCode: null,
      checking: false, decision: null,
    },
  };
}

let state = freshState();

// Same discipline as chat.js/domains.js — see the file-header comment
// above. Read fresh inside a handler invoked SYNCHRONOUSLY by a real click
// (safe: nothing can re-mount between the click firing and that line
// running); captured as a local BEFORE any await in every async function,
// and threaded through rather than re-derived afterward.
let myMountToken = 0;

// Delay-gated loading indicator for this view's entry load. Built in
// onEnter, cancelled in the teardown. See shared/loading-gate.js.
let loadGate = null;

// Unsubscribe function for this mount's write-gate subscription (see
// onWriteGateChange in app.js) — released in teardown, same discipline
// views/ingest.js already uses. A torn-down mount must stop reacting to
// gate changes; leaving this subscribed would re-render a view that no
// longer owns the sidebar/main DOM (setSidebar/setMain's own token guard
// would refuse the paint, but there is no reason to even try).
let unsubscribeWriteGate = null;

// This mount's subscription to the shell-level sync run (shared/sync-run.js).
let unsubscribeSyncRun = null;

// Module level, NOT per mount: these hooks run when a run settles, whichever
// view is on screen by then. `beforeSettle` is awaited BEFORE the run clears,
// so the remote badge's fetch finishes before any Sync button is live again.
configureSyncRun({
  beforeSettle: settleSyncBadges,
  describe: (kind, data) => (data && data.message) || describeResult(kind, data),
});

// Repaint the RAIL badge after a push/pull/sync — both halves become wrong at
// exactly that moment (the local count just dropped; a pull consumed what was
// waiting on GitHub). Awaited by the runner BEFORE it clears the run, and the
// ordering is the fix, not an aesthetic choice: refreshSyncRemoteBadge()
// issues a real `git fetch`, and a button handed back while it runs let the
// user's own pull race it (reproduced against real git, 11 failures in 12).
// brain/sync.js also serialises its fetches, so this is the second of two
// layers; a UI that hands back a button while it is still working is worth
// removing on its own merits. Awaiting is safe: refreshSyncRemoteBadge()
// never throws or rejects. Ungated on any mount token: the rail outlives
// every view.
async function settleSyncBadges() {
  refreshSyncBadge();
  await refreshSyncRemoteBadge();
}

// PURE over the state object it is handed: paint the shell-level run (or its
// outcome) into a mount's `state`. A running run shows as this view's own
// `acting`; a finished one clears that and shows its sentence — unless a
// mounted Sync page already showed it and the user then left (`seen`).
export function seedFromSyncRun(st, run, outcome) {
  if (run) {
    st.acting = run.kind;
    st.actionMessage = null;
    st.actionError = null;
    st.actionErrorDetail = null;
    st.actionErrorCode = null;
    st.deletionAsk = null;
    return st;
  }
  if (st.acting && SYNC_RUN_KINDS.indexOf(st.acting) !== -1) st.acting = null;
  if (outcome && !outcome.seen) {
    st.actionMessage = outcome.ok ? outcome.message : null;
    st.actionError = outcome.ok ? null : outcome.error;
    st.actionErrorDetail = outcome.ok ? null : (outcome.detail || null);
    st.actionErrorCode = outcome.ok ? null : (outcome.code || null);
    st.deletionAsk = !outcome.ok && outcome.details && typeof outcome.details.confirmToken === 'string' && typeof outcome.details.count === 'number'
      ? { kind: outcome.kind, details: outcome.details, confirmed: outcome.confirmed || [], outcome }
      : null;
  } else if (outcome && outcome.dismissed) {
    st.deletionAsk = null;
  }
  return st;
}

registerView('sync', {
  onEnter(mountToken) {
    state = freshState();
    myMountToken = mountToken;
    // A run started on an earlier mount (or another view) is still going, or
    // finished while the user was elsewhere: show it, never an idle page.
    seedFromSyncRun(state, currentSyncRun(), lastSyncOutcome());
    unsubscribeSyncRun = onSyncRunChange(() => onSyncRunChanged(mountToken));
    loadGate = createLoadingGate({
      onChange: () => { if (isCurrentMount(mountToken)) render(mountToken); },
    });
    loadGate.begin();
    render(mountToken);
    loadAll(mountToken).catch((err) => reportAsyncMountFailure(mountToken, err));

    // Re-render whenever ANY domain's write-gate state changes — e.g. an
    // ingest starts/finishes on some domain while the user is sitting on
    // Sync. This view only READS the gate to decide its own button/notice
    // state; it never begins a write itself.
    unsubscribeWriteGate = onWriteGateChange(() => onGateChange(mountToken));

    return () => {
      // L2 fix (re-audit finding): don't let a typed-but-unsubmitted (or
      // in-flight, later-abandoned) GitHub token sit in memory after the
      // user leaves this view. onConnect()'s success path already clears
      // state.setupForm.token, but that clear sits behind an early return
      // that skips it entirely if the connect happens to resolve after
      // the user has already navigated away — this is the unconditional
      // backstop.
      state.setupForm.token = '';
      // The same backstop for Replace token's field.
      if (state.tokenForm) state.tokenForm.token = '';

      // Timer hygiene (load-bearing): an armed delay timer that survives
      // this teardown would paint a loader into whatever view comes next.
      if (loadGate) { loadGate.cancel(); loadGate = null; }
      if (unsubscribeWriteGate) { unsubscribeWriteGate(); unsubscribeWriteGate = null; }
      // Leaving does NOT touch the run — it keeps going in the shell. Only
      // this mount stops listening; an outcome it already showed is spent.
      if (unsubscribeSyncRun) { unsubscribeSyncRun(); unsubscribeSyncRun = null; }
      if (state.actionMessage || state.actionError) markOutcomeSeen(lastSyncOutcome());
    };
  },
});

// The shell-level run started, or settled. Re-read the counts after a
// settle: the pending count, "last synced" and the domain list all changed.
// The render() AFTER the re-read is load-bearing (HIGH-1, third re-audit
// round): loadStatus() only mutates state, and without a paint the button
// stayed on "Pushing…" forever after a push that had succeeded on disk.
// The domain list is re-read too (v3.72.1, F4): a pull can bring a domain in
// or prune one, and the sidebar must not name a folder that is gone.
function onSyncRunChanged(mountToken) {
  if (!isCurrentMount(mountToken)) return;
  const wasActing = state.acting;
  const run = currentSyncRun();
  seedFromSyncRun(state, run, lastSyncOutcome());
  // A refused token: the panel opens beside the error and takes the focus once.
  if (!run && tokenPanelOpen(state)) state.tokenForm.focusPending = true;
  render(mountToken);
  if (!run && state.focusAfterConfirm) {
    // A new question (the set changed) takes the focus on its own heading.
    const btnId = state.deletionAsk ? null : state.focusAfterConfirm;
    state.focusAfterConfirm = null;
    let lost = false;
    try { lost = !document.activeElement || document.activeElement === document.body; } catch { lost = false; }
    const btn = btnId && lost ? document.getElementById(btnId) : null;
    if (btn && typeof btn.focus === 'function') { try { btn.focus(); } catch { /* not focusable */ } }
  }
  if (!run && wasActing && SYNC_RUN_KINDS.indexOf(wasActing) !== -1) {
    Promise.all([loadStatus(mountToken), loadDomains(mountToken), loadBackup(mountToken)])
      .then(() => { if (isCurrentMount(mountToken)) render(mountToken); })
      .catch(reportAsyncActionFailure);
  }
}

// A write-gate change while this view is mounted (v3.72.1, F3). It always
// repaints (the buttons' busy state). When every write has settled it also
// re-reads /api/sync/status: a write that just FINISHED elsewhere (an ingest,
// a Shared Brain pull) changed the files this page counts, and the rail badge
// re-reads at this same moment (app.js), so without this the page and the
// rail showed one field with two values. Not mid-write: git status is
// repo-wide, and a count taken while a write is running is already stale.
function onGateChange(mountToken) {
  if (!isCurrentMount(mountToken)) return;
  render(mountToken);
  if (!crossWriteBusy()) {
    loadStatus(mountToken)
      .then(() => { if (isCurrentMount(mountToken)) render(mountToken); })
      .catch(reportAsyncActionFailure);
  }
}

// ── Cross-view write gate (see this file's header comment) ────────────────

// FAIL-OPEN: if isAnyWriteBusy() itself throws for any reason, every Sync
// button stays enabled rather than becoming permanently stuck disabled.
// The backend's guardConcurrent() 409 is the real safety net (see the
// header comment) — losing the proactive frontend signal just means the
// user occasionally sees that 409 instead of a disabled button, which is
// the pre-existing behaviour this change is layered on top of, not a new
// failure mode.
function crossWriteBusy() {
  try {
    return isAnyWriteBusy();
  } catch (err) {
    console.error('[sync] isAnyWriteBusy() failed — failing OPEN (Sync buttons stay enabled)', err);
    return false;
  }
}

// Best-effort "what's busy" for a disabled control's tooltip.
// isAnyWriteBusy() alone can't say which domain or what kind of write —
// app.js's write-gate is keyed per-domain (getDomainWriteLabel(domain)),
// so this asks it about every domain this view already knows about (from
// GET /api/domains, loaded into state.domains). A busy domain this view
// hasn't loaded — a race on first paint, or a Shared Brain mirror slug the
// domains list doesn't happen to include — still correctly counts toward
// crossWriteBusy() above (the buttons still disable); it only means the
// tooltip falls back to a generic message instead of naming the domain.
function activeWriteInfo() {
  try {
    for (const d of state.domains) {
      const label = getDomainWriteLabel(d);
      if (label) return { domain: d, label };
    }
  } catch (err) {
    console.error('[sync] getDomainWriteLabel() failed while building a tooltip', err);
  }
  return null;
}

function crossWriteTitle() {
  const info = activeWriteInfo();
  return info
    ? 'A write (' + info.label + ') is running for domain "' + info.domain +
      '" — wait for it to finish, or it may conflict with this sync.'
    : 'A write is running in another view — wait for it to finish, or it may conflict with this sync.';
}

async function loadAll(token) {
  // Capture the gate for THIS call. `loadGate` is module-scoped and the
  // next mount replaces it, so settling the module variable from a stale
  // in-flight load would decrement the NEXT mount's counter and hide a
  // loader that is legitimately up. A cancelled gate ignores settle(), so
  // the stale path becomes a no-op instead.
  const gate = loadGate;
  await Promise.all([loadStatus(token), loadDomains(token), loadSharedBrainSummary(token), loadJob(token), loadBackup(token)]);
  if (!isCurrentMount(token)) return;
  // Delay-gated: settle() paints immediately when no loader was ever shown
  // (the measured case here — this load lands in ~3 ms), and holds the
  // result back only long enough to honour the min-visible clamp when one
  // WAS shown. See shared/loading-gate.js.
  settleGate(gate, () => {
    state.loading = false;
    render(token);
  });
}

// Deliberately does NOT render itself — every caller (loadAll, and
// HIGH-1's onAction below) is responsible for rendering once it has
// finished awaiting whatever ELSE it also needed, so a caller with more
// work to do after this doesn't render twice for no reason. Do not add a
// render() call here without checking every call site.
async function loadStatus(token) {
  try {
    const res = await fetch('/api/sync/status');
    const data = await res.json();
    if (!isCurrentMount(token)) return;
    state.status = data;
    state.statusError = data.error || null;
    state.statusErrorDetail = (data && typeof data.detail === 'string' && data.detail) || null;
    state.statusErrorCode = (data && typeof data.code === 'string' && data.code) || null;
  } catch (err) {
    if (!isCurrentMount(token)) return;
    state.status = { configured: false };
    const u = userMessageFrom(err);
    state.statusError = u.error;
    state.statusErrorDetail = u.detail || null;
    state.statusErrorCode = u.code || null;
  }
}

// A run this page did not start — a reload mid-sync, or the Context page's
// Sync button — is still the user's sync: follow it (shared/sync-run.js
// polls GET /api/sync/job until it ends). Read-only and local.
async function loadJob(token) {
  try {
    const res = await fetch('/api/sync/job');
    if (!res.ok) return;
    const data = await res.json();
    if (!isCurrentMount(token)) return;
    adoptServerSyncJob(data);
  } catch { /* no job information — the page shows what it knows */ }
}

// What is not backed up. Local, no fetch. A failure here leaves the panel away
// rather than saying "nothing is left out", which would be a claim it cannot make.
async function loadBackup(token) {
  try {
    const res = await fetch('/api/sync/backup-report');
    const data = res.ok ? await res.json() : null;
    if (isCurrentMount(token)) state.backup = data;
  } catch {
    if (isCurrentMount(token)) state.backup = null;
  }
}

async function loadDomains(token) {
  try {
    const res = await fetch('/api/domains');
    const data = await res.json();
    if (!isCurrentMount(token)) return;
    state.domains = data.domains || [];
  } catch {
    if (!isCurrentMount(token)) return;
    state.domains = [];
  }
}

// Read-only, best-effort — a 404 (flag off) or any failure just means
// "nothing to report", never surfaced as an error in this view.
async function loadSharedBrainSummary(token) {
  try {
    const flagRes = await fetch('/api/sharedbrain/feature-flag');
    const flag = await flagRes.json();
    if (!flag.enabled) { if (isCurrentMount(token)) state.sb = { enabled: false, connections: [] }; return; }
    const listRes = await fetch('/api/sharedbrain/list');
    // `connections: null` = the list could not be read. It is NOT rendered
    // as "Not connected" — a failed read is not a measured absence.
    if (!listRes.ok) { if (isCurrentMount(token)) state.sb = { enabled: true, connections: null }; return; }
    const list = await listRes.json();
    // v3.72.1 (F11): EVERY connection, not `connections[0]` — a user with
    // two Shared Brains was told only about the first.
    const connections = Array.isArray(list.connections) ? list.connections : null;
    if (isCurrentMount(token)) state.sb = { enabled: true, connections };
  } catch {
    if (isCurrentMount(token)) state.sb = { enabled: false, connections: [] };
  }
}

// ── Render ───────────────────────────────────────────────────────────────

function render(token) {
  // A repaint rebuilds the Replace token field; whoever was typing in it keeps
  // the focus (a write finishing elsewhere repaints this page).
  let refocus = false;
  try { refocus = !!document.activeElement && document.activeElement.id === 'sync-token-input'; } catch { refocus = false; }
  if (refocus && state.tokenForm) state.tokenForm.focusPending = true;
  // The same for the deletion card's heading (audit m4): a repaint after the
  // run settles (the counts re-read) rebuilds it, and the focus must stay.
  try {
    if (document.activeElement && document.activeElement.id === 'sync-deletion-title') state.deletionFocusedToken = null;
  } catch { /* no document focus to read */ }
  // And for the three run buttons: the re-read of the counts after a run
  // repaints them, and a keyboard user keeps their place (audit m4: after
  // Delete them the focus fell to the page body).
  let runBtnId = null;
  try {
    const a = document.activeElement;
    if (a && RUN_BUTTON_IDS.indexOf(a.id) !== -1) runBtnId = a.id;
  } catch { runBtnId = null; }
  renderSidebar(token);
  renderMain(token);
  wireListeners();
  if (runBtnId) {
    try {
      const a = document.activeElement;
      const btn = document.getElementById(runBtnId);
      if (btn && (!a || a === document.body)) btn.focus();
    } catch { /* not focusable right now */ }
  }
}
const RUN_BUTTON_IDS = ['btn-sync-now', 'btn-sync-push', 'btn-sync-pull'];

function renderSidebar(token) {
  // The per-domain STATE column that used to sit at the end of each row was
  // removed at cutover. It rendered a hardcoded "—" for every domain, on
  // every render, forever: GET /api/sync/status returns a single TOTAL
  // changesCount from `git status --porcelain`, and no endpoint anywhere
  // exposes a per-domain breakdown without ALSO performing a real push or
  // pull (verified against src/routes/sync.js and src/brain/sync.js). So the
  // column could never display anything, and the footnote underneath it
  // existed only to apologise for that.
  //
  // The domain NAMES are real data (GET /api/domains) and worth keeping —
  // "these are the domains this backup covers" is the honest, useful claim,
  // and it is now what the heading says. Deleting the empty column and the
  // apology leaves exactly that, with the real total below in the main pane.
  const domainRows = state.domains.length
    ? state.domains.map((d) => (
        '<div class="sync-domain-row">' +
          '<span class="sync-domain-dot"></span>' +
          '<span class="sync-domain-name">' + escapeHtml(d) + '</span>' +
        '</div>'
      )).join('')
    : '<div class="sidebar-note">No domains to back up yet.</div>';

  // Same cross-view write-gate note ingest.js's sidebar shows (own class,
  // own copy — see the README's "own your own CSS file" rule) — only
  // meaningful once a repo is actually connected, since an unconfigured
  // card's one action (Connect) isn't gated (see this file's header
  // comment for why).
  const writeBusy = state.status && state.status.configured && crossWriteBusy();
  const busyNote = writeBusy
    ? '<div class="sync-sidebar-busy">' + icon('alertTriangle', 13) +
      '<span>' + escapeHtml(crossWriteTitle()) + '</span></div>'
    : '';

  setSidebar(
    // No paragraph under the title. The sentence explains a MECHANISM — what
    // the backup covers — and nothing in it warns, costs or is irreversible:
    // source files staying local is the design (raw/ is gitignored, so a
    // private repo never carries them), not a loss of anything the user has.
    // The DOMAINS BACKED UP list immediately below is the readout it qualifies.
    // v3.71.1: NO ⓘ on a sidebar title (the standing rule). What travels is
    // now a point in the main header's `sync.page` explainer.
    renderViewHeader({
      variant: 'sidebar',
      title: 'Sync',
    }) +
    '<div class="cur-eyebrow" style="margin-top:2px">DOMAINS BACKED UP</div>' +
    '<div class="sync-domain-list">' + domainRows + '</div>' +
    busyNote,
    token
  );
}

function renderMain(token) {
  const s = state.status;
  let body;
  if (state.loading) {
    body = gatedLoader(loadGate, 'Loading sync status…');
  } else if (!s || !s.configured) {
    body = renderUnconfigured();
  } else {
    body = renderConfigured(s);
  }

  // v3.22.0's ORIGINAL sentence was cut, not relocated: in the CONFIGURED
  // state the status card directly below says "Connected", prints the repo
  // URL and the last sync time — the sentence restated all three in the
  // abstract. In the UNCONFIGURED state the setup card's own title is
  // "Connect a GitHub repository" and its hint names the private repo and
  // the token. Either way it taught nothing to someone already looking at
  // the screen, which is the test v3.22.0 cut ingest's drop-zone sentence
  // against.
  //
  // `info` here (v3.24.0) is a DIFFERENT fact, not a reintroduction of that
  // one: how to recover, which nothing else on this screen states once the
  // "coming soon" History card is gone (see this file's header comment).
  // It qualifies for the mark rather than an unfolded renderStatus box
  // because it explains a MECHANISM and warns of nothing — no cost, no
  // irreversibility, no action currently in flight — matching Domains'
  // DOMAIN_BLURB, the other real-world example of `info` on a main-variant
  // header. True in every state (unconfigured included: it describes what
  // happens once syncing starts, not something that has already happened),
  // so it is not gated on `s.configured`.
  //
  // THE PHRASE "so nothing is lost" WAS IN THE FIRST DRAFT AND WAS CUT, on
  // measurement rather than taste. Two things make it false as an absolute:
  // `*/raw/` is the FIRST entry in DOMAINS_GITIGNORE_RULES, so the source
  // files a user ingested are never committed and a git history cannot
  // restore them; and pull() resolves with `-X theirs`, which v3.17.2
  // measured SILENTLY discarding — and in one shape SPLICING — the local
  // side of a conflicting hunk. What IS true is the narrower mechanism now
  // stated: pull() runs `add -A` + an "Auto-save before sync" commit BEFORE
  // the merge (src/brain/sync.js), so the pre-merge local state is in the
  // history a git client can reach. This file is the ninth-plus site of the
  // false-revert class CLAUDE.md tracks from v3.9.1 through v3.20.0; an
  // absolute safety promise here is exactly how that class keeps recurring,
  // so the copy states the MECHANISM and names the ABSENCE instead.
  setMain(
    renderViewHeader({
      eyebrow: 'where it all lives',
      title: 'Sync',
      // v3.71.1: the `sync.page` explainer, which carries the recovery route
      // ("each sync is a git commit that a git client can undo") and what
      // travels (merged in from the sidebar's retired ⓘ). The pre-merge
      // auto-save detail is in docs/sync.md.
      info: explainerHtml('sync.page'),
      infoHtml: true,
    }) +
    body,
    token
  );
}

function renderUnconfigured() {
  const f = state.setupForm;
  return (
    '<div class="sync-setup-card">' +
      '<div class="sync-setup-title">Connect a GitHub repository</div>' +
      '<p class="settings-hint-text">Paste an empty private repo and a token with Contents: Read and write access. ' +
      '“Push” sends this machine’s wiki up first; “Pull” starts from what’s already in the repo.</p>' +
      '<div class="sync-setup-field">' +
        '<span class="sync-setup-label">Repository URL</span>' +
        '<input type="text" class="mono sync-setup-input" id="setup-repo-url" placeholder="https://github.com/you/your-wiki" value="' + escapeHtml(f.repoUrl) + '">' +
      '</div>' +
      '<div class="sync-setup-field">' +
        '<span class="sync-setup-label">Personal access token</span>' +
        // L2 fix (re-audit finding): no `value="..."` attribute here — a
        // GitHub PAT serialized into markup is readable in DevTools'
        // Elements panel and in any copied outerHTML, which a live
        // type="password" field's actual VALUE is not normally exposed
        // through. wireListeners() sets `.value` as a DOM property right
        // after this markup is inserted, so the previously-typed token is
        // still restored across re-renders — it just never touches HTML.
        '<input type="password" class="mono sync-setup-input" id="setup-token" autocomplete="off" spellcheck="false" placeholder="ghp_… or a fine-grained token">' +
      '</div>' +
      '<div class="sync-setup-field">' +
        '<span class="sync-setup-label">Starting direction</span>' +
        '<div class="theme-segmented">' +
          '<button type="button" class="theme-seg-btn' + (f.mode === 'push' ? ' active' : '') + '" data-mode="push">Push my wiki</button>' +
          // THE THIRD OPTION IS THE POINT OF THIS RELEASE. Before it there
          // were exactly two doors out of a first connect — send this folder
          // up, or check the repository out over this folder — and when the
          // first was refused (the repository already had commits) the second
          // was the only one left, and it destroyed four hours of work. Merge
          // is the door that was missing.
          '<button type="button" class="theme-seg-btn' + (f.mode === 'merge' ? ' active' : '') + '" data-mode="merge">Merge — keep both</button>' +
          '<button type="button" class="theme-seg-btn' + (f.mode === 'pull' ? ' active' : '') + '" data-mode="pull">Pull an existing wiki</button>' +
        '</div>' +
        '<p class="settings-hint-text sync-mode-hint">' + escapeHtml(MODE_HINTS[f.mode] || '') + '</p>' +
      '</div>' +
      (f.error ? syncErrorHtml(f.error, f.errorDetail, '', f.errorCode) : '') +
      renderSetupDecision(f) +
      (f.decision ? '' :
        '<button type="button" class="btn btn-primary" id="btn-sync-connect"' + (f.submitting || f.checking ? ' disabled' : '') + '>' +
          (f.checking ? 'Checking…' : f.submitting ? 'Connecting…' : 'Connect') +
        '</button>') +
    '</div>'
  );
}

// One sentence per mode, shown under the toggle. The destructive one says
// what it does in the plainest words available; "Pull an existing wiki" on
// its own reads like a download.
const MODE_HINTS = {
  push:  'Sends this machine\u2019s domains folder up as the first version. Nothing here is changed.',
  merge: 'Combines what is in this folder with what is in the repository. Nothing here is deleted, and files you deleted locally may come back.',
  pull:  'Replaces the contents of this folder with the repository\u2019s version. Local-only files are kept; files that exist in both are overwritten.',
};

/**
 * The decision panel — the connect flow's answer to "the guard fired and the
 * user still lost data".
 *
 * EVERY BRANCH OFFERS A NON-DESTRUCTIVE ROUTE, and the destructive one is
 * never the primary button, never preselected, and never rendered without a
 * COUNT and a sample of the actual paths beside it. That last part is the
 * difference between a warning and a fact: "this may overwrite files" is
 * something people click through; "this replaces these 4 files, here they
 * are" is not.
 */
function renderSetupDecision(f) {
  const d = f.decision;
  if (!d) return '';
  const busy = f.submitting;
  const dis = busy ? ' disabled' : '';

  if (d.kind === 'adopt') {
    return (
      '<div class="sync-decision sync-decision-info">' +
        '<div class="sync-decision-title">This folder is already synced</div>' +
        '<p class="sync-decision-body">Another Curator install on this ' + thisMachine() + ' already syncs this domains folder ' +
        'to the same repository. This install will use that same sync history instead of starting a second ' +
        'one \u2014 nothing in your folder is changed.</p>' +
        '<div class="sync-decision-actions">' +
          '<button type="button" class="btn btn-primary" id="btn-decide-go"' + dis + '>' +
            (busy ? 'Connecting\u2026' : 'Connect') + '</button>' +
          '<button type="button" class="btn btn-ghost" id="btn-decide-cancel">Cancel</button>' +
        '</div>' +
      '</div>'
    );
  }

  if (d.kind === 'foreign') {
    return (
      '<div class="sync-decision sync-decision-warn">' +
        '<div class="sync-decision-title">Another install already syncs this folder</div>' +
        '<p class="sync-decision-body">It is connected to a different repository' +
        (d.originUrl ? ' (' + escapeHtml(d.originUrl) + ')' : '') + '. Connecting this one too would put two ' +
        'independent sync histories over the same files, which is how pages get silently replaced. ' +
        'Disconnect sync in the other install first, or point this install at a different domains folder.</p>' +
        '<div class="sync-decision-actions">' +
          '<button type="button" class="btn btn-secondary" id="btn-decide-cancel">OK</button>' +
        '</div>' +
      '</div>'
    );
  }

  if (d.kind === 'overwrite') {
    const n = d.count;
    return (
      '<div class="sync-decision sync-decision-danger">' +
        '<div class="sync-decision-title">Pulling would overwrite ' + n + ' file' + (n === 1 ? '' : 's') + '</div>' +
        '<p class="sync-decision-body">These files are in your domains folder with different content from the ' +
        'repository\u2019s version. Pulling replaces them, and the version currently on this machine is not ' +
        'recoverable afterwards.</p>' +
        (d.sample && d.sample.length
          ? '<ul class="sync-decision-files">' +
              d.sample.map((x) => '<li>' + escapeHtml(x) + '</li>').join('') +
              (n > d.sample.length ? '<li class="sync-decision-more">\u2026and ' + (n - d.sample.length) + ' more</li>' : '') +
            '</ul>'
          : '') +
        '<div class="sync-decision-actions">' +
          '<button type="button" class="btn btn-primary" id="btn-decide-merge"' + dis + '>' +
            (busy && f.mode === 'merge' ? 'Merging\u2026' : 'Merge \u2014 keep both') + '</button>' +
          '<button type="button" class="btn btn-danger" id="btn-decide-overwrite"' + dis + '>' +
            (busy && f.mode === 'pull' ? 'Overwriting\u2026' : 'Overwrite my local files') + '</button>' +
          '<button type="button" class="btn btn-ghost" id="btn-decide-cancel">Cancel</button>' +
        '</div>' +
      '</div>'
    );
  }

  if (d.kind === 'review') return connectReviewHtml(d.backup, { busy, leavingOut: !!f.leaveOut });

  // remote-empty / remote-not-empty and anything else setup() refuses with a
  // written sentence. Rendered as text plus a way back, never as a dead end.
  return (
    '<div class="sync-decision sync-decision-warn">' +
      '<div class="sync-decision-title">Cannot connect that way</div>' +
      '<p class="sync-decision-body">' + escapeHtml(d.message || '') + '</p>' +
      '<div class="sync-decision-actions">' +
        '<button type="button" class="btn btn-secondary" id="btn-decide-cancel">OK</button>' +
      '</div>' +
    '</div>'
  );
}

const SYNC_UNDO_NOTE = 'The Curator has no revert control. A git client pointed at your knowledge folder can undo a sync.';

function renderConfigured(s) {
  const acting = state.acting;
  // v3.72.1 (F1): `lastSync` is the RECORDED time of the last successful
  // push/pull/connect, never a commit date. Null means no sync has been
  // recorded on this install yet — which, for an install connected before
  // v3.72.1, is not "never synced", so it is not worded as "never".
  const lastSyncLabel = s.lastSync ? formatSyncTime(s.lastSync) : 'not recorded yet';
  const pendingNote = pendingNoteText(s);

  // Cross-view write gate (see this file's header comment). `acting` is
  // THIS view's own in-flight action (e.g. mid-push) — that already
  // disables the buttons and shows its own "Pushing…" label, and is NOT a
  // conflict with itself, so the cross-write title only applies when
  // something ELSE is busy and this view is idle.
  const crossBusy = !acting && crossWriteBusy();
  const disabled = acting || crossBusy;
  // NOT a `title=`, and the reason is measured rather than stylistic: these
  // buttons are `disabled` in exactly the state this string describes, and a
  // disabled control receives no pointer events, so the tooltip frequently
  // never fires at all — and it is out of the tab order, so a keyboard user
  // could never reach it either. A refusal reason explaining why every primary
  // action is dead has to be VISIBLE. This is the v3.18.0 class: a refusal the
  // user cannot see reads as "my click did not register", and they click again.
  //
  // renderStatus, not the info mark: a warning behind a click is not a warning.
  const crossNote = crossBusy
    ? renderStatus({
        state: 'attention',
        title: 'Waiting on another write',
        detail: crossWriteTitle(),
      })
    : '';

  return (
    '<div class="sync-status-card">' +
      // M11 — THE SAME CALL SHAPE AS THE MCP BRIDGE'S (views/settings.js). One
      // call site pattern, two callers, and no third: the connection's state
      // word in the head, the identity it is connected TO and the age of the
      // last exchange as its lines. `lastSyncLabel` is already this view's own
      // formatted stamp, so it goes in as the value it is.
      //
      // IT REPLACES `.sync-status-top` IN PLACE, inside the card, rather than
      // taking the card's job: what surrounds it is a warning, a refusal and
      // the action row, and those are not readings. A monitor is the
      // instrument INSIDE the thing that names it.
      renderMonitor({
        id: 'sync-status-monitor',
        label: 'Sync connection',
        // The live state of the connection: a running push/pull/sync is the
        // reading while it runs (v3.89.2) — also after leaving and coming
        // back, because `acting` is seeded from the shell-level run.
        head: {
          stateWord: acting === 'sync' ? 'Syncing…' : acting === 'push' ? 'Pushing…' : acting === 'pull' ? 'Pulling…' : 'Connected',
          tone: 'ok',
        },
        lines: [
          { key: 'repo', value: s.repoUrl || '' },
          { key: 'last synced', value: lastSyncLabel },
        ],
      }) +
      (state.statusError ? syncErrorHtml(state.statusError, state.statusErrorDetail, '', state.statusErrorCode) : '') +
      // THE ALREADY-SPLIT INSTALL. setup()'s adoption closes the split for a
      // connect made from now on and does nothing for an install that is
      // already in it — and one exists, because the incident that produced
      // this work left one. Self-healing it silently would switch a working
      // install onto a different repository behind the user's back and
      // orphan whatever its own repo already holds; that is the same class
      // of unrequested decision that lost the data. So the app SAYS so, in
      // the one place the user goes to think about sync, and names the two
      // clicks that fix it. `adoptedSyncRepo` suppresses it: an adopted
      // install shares the other install's repo by design and is not split.
      (s.splitSyncRepo && !s.adoptedSyncRepo
        ? renderStatus({
            state: 'attention',
            title: 'Two sync histories over one folder',
            detail: 'Another Curator install on this ' + thisMachine() + ' also syncs this domains folder, through its own ' +
                    'separate sync history. Both push to the same repository, so each one\u2019s changes ' +
                    'arrive at the other as a merge \u2014 which can silently replace edited pages. ' +
                    'To fix it: Disconnect below, then Connect again with the same repository. The ' +
                    'reconnect will join the existing history instead of starting a second one, and ' +
                    'nothing in your folder is changed.',
          })
        : '') +
      crossNote +
      '<div class="sync-status-actions">' +
        // The icon SPINS only while `acting === 'sync'` (this button's own
        // in-flight request — never `push`/`pull`, which are their own
        // buttons with their own labels and no icon to spin). It is wrapped
        // in its own span rather than animating the <svg> selected off the
        // button, because a bare `#btn-sync-now.is-syncing svg` would also
        // catch any icon a future edit adds elsewhere inside this button.
        // Reuses `curator-spin` (tokens/motion.css) at the SAME 1.15s
        // cadence as shared/progress-ring.css's `.pring-orbit` — one spin
        // speed in the app, not two nearly-identical ones.
        '<button type="button" class="btn btn-primary" id="btn-sync-now"' + (disabled ? ' disabled' : '') + '>' +
          '<span class="sync-now-icon' + (acting === 'sync' ? ' is-spinning' : '') + '">' + icon('refresh', 14) + '</span>' +
          ' ' + (acting === 'sync' ? 'Syncing…' : 'Sync now') +
        '</button>' +
        '<button type="button" class="btn btn-secondary" id="btn-sync-push"' + (disabled ? ' disabled' : '') + '>' + (acting === 'push' ? 'Pushing…' : 'Push only') + '</button>' +
        '<button type="button" class="btn btn-secondary" id="btn-sync-pull"' + (disabled ? ' disabled' : '') + '>' + (acting === 'pull' ? 'Pulling…' : 'Pull only') + '</button>' +
        '<span class="sync-pending-note">' + escapeHtml(pendingNote) + '</span>' +
      '</div>' +
      // AN OUTCOME STAYS ON THE PAGE (v3.71.1): the app cannot undo a sync,
      // and the one route back is a git client — said beside the actions,
      // unfolded, not only in the header's ⓘ (v3.16.1).
      '<div class="sync-undo-note">' + escapeHtml(SYNC_UNDO_NOTE) + '</div>' +
      (state.actionMessage ? '<div class="sync-action-note">' + escapeHtml(state.actionMessage) + '</div>' : '') +
      // THE DELETION GUARD'S QUESTION (v4.2.1) replaces the error line: the
      // count and domains on the card, the list in the reader, never folded.
      (state.deletionAsk
        ? '<div style="margin-top:12px">' + deletionCardHtml(state.deletionAsk.details, { disabled: crossBusy }) + '</div>'
        : (state.actionError ? syncErrorHtml(state.actionError, state.actionErrorDetail, 'margin-top:8px', state.actionErrorCode) : '')) +
      // Replace token: OPEN right under the error when the error says GitHub
      // refused the token (never behind a chevron, v3.16.1); otherwise one
      // quiet button, so a token can be changed without Disconnect.
      renderTokenPanel(s, disabled) +
    '</div>' +

    backupReportHtml(state.backup) +

    renderSharedBrainRow() +

    renderDisconnect()
  );
}

// The error sentence, and under it the technical detail for support: visible,
// smaller, muted, selectable (the error contract). Both escaped; the detail is
// in a <code> so it reads as quoted text, not as the app's own words.
// v3.99.2: the catalogue code goes on the same line, as net.js's support line
// writes it ("<detail> (code: sync-offline)", or "code: sync-offline" alone),
// so support can look the code up. A code outside the catalogue is not shown.
function syncErrorHtml(message, detail, style, code) {
  const c = code && isCatalogueCode(code) ? code : '';
  const body = detail
    ? '<code>' + escapeHtml(detail) + '</code>' + (c ? ' (code: ' + escapeHtml(c) + ')' : '')
    : (c ? 'code: ' + escapeHtml(c) : '');
  return '<div class="settings-inline-error"' + (style ? ' style="' + style + '"' : '') + '>' + escapeHtml(message) + '</div>' +
    (body ? '<div class="sync-error-detail">Technical detail (for support): ' + body + '</div>' : '');
}

// The codes that mean "GitHub refused the token Sync has": the panel opens.
function tokenErrorCodes() {
  return ['sync-token-rejected', 'sync-token-no-access'];
}

export function tokenPanelOpen(st) {
  const f = st.tokenForm || {};
  if (f.open) return true;
  return !f.dismissed && !!st.actionError && tokenErrorCodes().indexOf(st.actionErrorCode) !== -1;
}

// Replace token (2026-11-19), built from the connect form's own parts: the
// decision panel, the setup field, label and input, and the app's buttons.
// The input carries NO value attribute (the L2 rule on the connect form): what
// was typed is restored as a DOM property in wireListeners and cleared on submit.
function renderTokenPanel(s, disabled) {
  const f = state.tokenForm;
  if (!tokenPanelOpen(state)) {
    return '<button type="button" class="btn btn-ghost btn-xs" id="btn-token-open"' + (disabled ? ' disabled' : '') +
      ' style="margin-top:10px">Replace token</button>';
  }
  const busy = f.submitting || state.acting === 'token';
  return (
    '<div class="sync-decision sync-decision-info" id="sync-token-panel" style="margin-top:12px">' +
      '<div class="sync-decision-title">Replace the GitHub token</div>' +
      '<p class="sync-decision-body">Paste a new token for ' + escapeHtml(s.repoUrl || 'this repository') +
      ' with Contents: Read and write. The Curator checks it with GitHub first and changes nothing unless ' +
      'GitHub accepts it. Your sync history stays as it is.</p>' +
      '<div class="sync-setup-field">' +
        '<label class="sync-setup-label" for="sync-token-input">New personal access token</label>' +
        '<input type="password" class="sync-setup-input" id="sync-token-input" autocomplete="off" spellcheck="false" placeholder="ghp_… or a fine-grained token"' + (busy ? ' disabled' : '') + '>' +
      '</div>' +
      (f.error ? syncErrorHtml(f.error, f.detail, '', f.code) : '') +
      '<div class="sync-decision-actions">' +
        '<button type="button" class="btn btn-primary" id="btn-token-save"' + (busy || disabled ? ' disabled' : '') + '>' +
          (busy ? 'Checking with GitHub…' : 'Check and save') + '</button>' +
        '<button type="button" class="btn btn-ghost" id="btn-token-cancel"' + (busy ? ' disabled' : '') + '>Cancel</button>' +
      '</div>' +
    '</div>'
  );
}

// One line per Shared Brain connection (v3.72.1, F11). The time is the last
// push that actually SENT a contribution (`last_contribution_at`, F9) — a
// push that found nothing to send advances `last_push_at` (the scan
// watermark) and is not a contribution. A connection that predates the
// field and has only the watermark says so rather than borrowing it.
export function sharedBrainRowLines(sb, nowMs) {
  if (!sb) return ['Checking Shared Brain…'];
  if (sb.connections === null) return ['Shared Brain list could not be read'];
  const list = Array.isArray(sb.connections) ? sb.connections : [];
  if (!list.length) return ['Not connected to any Shared Brain'];
  return list.map((c) => {
    const name = (c && c.label) || 'Shared Brain';
    let when;
    if (c && c.last_contribution_at) when = 'pushed ' + formatSyncTime(c.last_contribution_at, nowMs);
    else if (c && c.last_push_at) when = 'last push run ' + formatSyncTime(c.last_push_at, nowMs) + ', nothing recorded as sent';
    else when = 'no pushes yet';
    return name + ' · ' + when;
  });
}

function renderSharedBrainRow() {
  const lines = sharedBrainRowLines(state.sb);
  return (
    '<div class="sync-sb-row">' +
      icon('users', 16) +
      '<span class="sync-sb-text">Shared Brain pushes are managed in <strong>Shared Brain</strong>. This tab only reports them.</span>' +
      '<span class="sync-sb-metas">' + lines.map((l) => '<span class="sync-sb-meta">' + escapeHtml(l) + '</span>').join('') + '</span>' +
      '<button type="button" class="btn btn-ghost btn-xs" id="btn-sync-open-shared">Open</button>' +
    '</div>'
  );
}

function renderDisconnect() {
  // Same cross-write gate as the three main action buttons above — the
  // backend's guardConcurrent('disconnect sync') 409s this exact request
  // while any write is in flight (see this file's header comment), so
  // there is no case where enabling this and letting it fail is better
  // than explaining upfront.
  const acting = state.acting;
  const crossBusy = !acting && crossWriteBusy();
  const disabled = acting || crossBusy;
  // No second copy of the cross-write note: renderDisconnect() is rendered
  // from inside renderConfigured()'s own return, so the one visible status box
  // above is already on screen explaining why this button is disabled too.

  if (state.disconnectConfirmOpen) {
    return (
      '<div class="sync-disconnect-confirm">' +
        '<span>Disconnect this repository? Your local wiki files stay exactly as they are — only the sync ' +
        'connection is removed. You can reconnect any time.</span>' +
        '<div class="sync-disconnect-actions">' +
          '<button type="button" class="btn btn-secondary btn-xs" id="btn-disconnect-confirm"' + (disabled ? ' disabled' : '') + '>' +
            (acting === 'disconnect' ? 'Disconnecting…' : 'Disconnect') +
          '</button>' +
          // Cancel never hits the network — always enabled, even mid cross-write, so there is always a way out of the confirm panel.
          '<button type="button" class="btn btn-ghost btn-xs" id="btn-disconnect-cancel">Cancel</button>' +
        '</div>' +
      '</div>'
    );
  }
  return '<button type="button" class="btn btn-ghost btn-xs" id="btn-disconnect-open"' + (disabled ? ' disabled' : '') + '>Disconnect this repository</button>';
}

// ── Formatting ────────────────────────────────────────────────────────────

// Absolute, so it cannot go stale on a page left open. v3.72.1 (F14): the
// year is shown whenever it is not this year — "Sep 3 09:10" for a sync more
// than a year old read as this September.
export function formatSyncTime(iso, nowMs) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date(typeof nowMs === 'number' ? nowMs : Date.now());
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return 'today ' + time;
  const opts = d.getFullYear() === now.getFullYear()
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' };
  return d.toLocaleDateString(undefined, opts) + ' ' + time;
}

// v3.72.1 (F2): the SAME field the rail badge reads (`changesCount`), which
// now counts every file whose current version is not on GitHub — uncommitted
// ones AND ones in commits that were made here but never pushed ("Pull only"
// auto-commits; a failed push leaves its commit). The committed-but-unpushed
// part is named, because "I have no edits" is exactly what a user thinks
// after a Pull only. A status that could not be counted says so — it is
// never rendered as "0 local changes".
export function pendingNoteText(s) {
  const n = s && typeof s.changesCount === 'number' && Number.isFinite(s.changesCount) ? s.changesCount : null;
  if (n === null) return 'local changes not counted';
  const base = n + ' local change' + (n === 1 ? '' : 's') + ' not pushed';
  const unc = typeof s.uncommittedCount === 'number' ? s.uncommittedCount : null;
  const committed = unc !== null ? n - unc : 0;
  return committed > 0 ? base + ' (' + committed + ' in commits not yet pushed)' : base;
}

// ── Listeners ─────────────────────────────────────────────────────────────
// Entered synchronously by real click/input events — reading myMountToken
// fresh inside each handler body is safe (see the file-header comment).

function wireListeners() {
  if (!state.status || !state.status.configured) {
    // M7 fix: renderUnconfigured() sets each input's `value` attribute from
    // state.setupForm.{repoUrl,token} — but nothing ever wrote the user's
    // keystrokes BACK into that state, so any re-render (the mode toggle
    // below, or a failed-connect error render in onConnect's catch) wiped
    // both fields, since it rebuilt them from the still-empty defaults.
    // Reproduced: type a repo URL + token, click "Pull only" — both fields
    // came back blank. Keeping state.setupForm live-synced here means every
    // future render (including the error-path one) reflects what's
    // actually been typed.
    const repoInput = document.getElementById('setup-repo-url');
    if (repoInput) repoInput.addEventListener('input', (e) => { state.setupForm.repoUrl = e.target.value; });
    const tokenInput = document.getElementById('setup-token');
    if (tokenInput) {
      // L2 fix: restore a previously-typed token as a live DOM property
      // (never an HTML attribute — see renderUnconfigured's comment) now
      // that the markup no longer carries `value="..."`.
      tokenInput.value = state.setupForm.token || '';
      tokenInput.addEventListener('input', (e) => { state.setupForm.token = e.target.value; });
    }

    document.querySelectorAll('.sync-setup-field .theme-seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => { state.setupForm.mode = btn.dataset.mode; render(myMountToken); });
    });
    const connectBtn = document.getElementById('btn-sync-connect');
    if (connectBtn) connectBtn.addEventListener('click', () => onConnect(myMountToken));

    // Decision-panel buttons. `confirmOverwrite` is passed as a literal
    // `true` from exactly ONE of them and nowhere else in this file — the
    // one the user reaches only after seeing the count and the file list.
    const dMerge = document.getElementById('btn-decide-merge');
    if (dMerge) dMerge.addEventListener('click', () => runSetup('merge', false, myMountToken));
    const dOver = document.getElementById('btn-decide-overwrite');
    if (dOver) dOver.addEventListener('click', () => runSetup('pull', true, myMountToken));
    const dGo = document.getElementById('btn-decide-go');
    if (dGo) dGo.addEventListener('click', () => { state.setupForm.leaveOut = null; runSetup(state.setupForm.mode, false, myMountToken); });
    const dLeave = document.getElementById('btn-decide-leave-out');
    if (dLeave) dLeave.addEventListener('click', () => {
      state.setupForm.leaveOut = reviewFolders(state.setupForm.decision.backup);
      runSetup(state.setupForm.mode, false, myMountToken);
    });
    const dCancel = document.getElementById('btn-decide-cancel');
    if (dCancel) dCancel.addEventListener('click', () => {
      state.setupForm.decision = null;
      state.setupForm.error = null;
      state.setupForm.errorDetail = null;
      state.setupForm.errorCode = null;
      render(myMountToken);
    });
    return;
  }

  const nowBtn = document.getElementById('btn-sync-now');
  if (nowBtn) nowBtn.addEventListener('click', () => onAction('sync', myMountToken));
  const pushBtn = document.getElementById('btn-sync-push');
  if (pushBtn) pushBtn.addEventListener('click', () => onAction('push', myMountToken));
  const pullBtn = document.getElementById('btn-sync-pull');
  if (pullBtn) pullBtn.addEventListener('click', () => onAction('pull', myMountToken));
  const openSharedBtn = document.getElementById('btn-sync-open-shared');
  if (openSharedBtn) openSharedBtn.addEventListener('click', () => navigate('shared'));
  const discOpen = document.getElementById('btn-disconnect-open');
  if (discOpen) discOpen.addEventListener('click', () => { state.disconnectConfirmOpen = true; render(myMountToken); });
  const discCancel = document.getElementById('btn-disconnect-cancel');
  if (discCancel) discCancel.addEventListener('click', () => { state.disconnectConfirmOpen = false; render(myMountToken); });
  const discConfirm = document.getElementById('btn-disconnect-confirm');
  if (discConfirm) discConfirm.addEventListener('click', () => onDisconnect(myMountToken));

  // The deletion guard's card (v4.2.1).
  const delCancel = document.getElementById('btn-deletions-cancel');
  if (delCancel) delCancel.addEventListener('click', () => {
    const ask = state.deletionAsk;
    if (!ask) return;
    dismissDeletionQuestion(ask.outcome);
    state.deletionAsk = null;
    state.actionError = null;
    state.actionErrorCode = null;
    // An incoming question cancelled: this computer still has the pages
    // GitHub no longer does, and every later sync asks again (audit m2). Say
    // the way that puts them back (measured: Disconnect, then Merge).
    state.actionMessage = 'Cancelled. Nothing was changed: no file was deleted here or on GitHub.' +
      (ask.details && ask.details.direction === 'in'
        ? ' To put these pages back on GitHub, choose Disconnect this repository below, then connect to the same repository again and choose Merge \u2014 keep both, then press Sync now.'
        : '');
    render(myMountToken);
    const now = document.getElementById('btn-sync-now');
    if (now && typeof now.focus === 'function') { try { now.focus(); } catch { /* not focusable */ } }
  });
  const delShow = document.getElementById('btn-deletions-show');
  if (delShow) delShow.addEventListener('click', () => {
    const ask = state.deletionAsk;
    if (!ask) return;
    openReader({
      slug: 'sync/deletions',
      title: ask.details.direction === 'in' ? 'What this sync would delete on this computer' : 'What this sync would delete from GitHub',
      bodyHtml: deletionListHtml(ask.details),
      hideBacklinks: true,
      returnFocusTo: 'btn-deletions-show',
    }, myMountToken);
  });
  const delConfirm = document.getElementById('btn-deletions-confirm');
  if (delConfirm) delConfirm.addEventListener('click', () => {
    const ask = state.deletionAsk;
    if (!ask || currentSyncRun()) return;
    const tokens = ask.confirmed.concat([ask.details.confirmToken]);
    state.deletionAsk = null;
    state.focusAfterConfirm = ask.kind === 'push' ? 'btn-sync-push' : ask.kind === 'pull' ? 'btn-sync-pull' : 'btn-sync-now';
    onAction(ask.kind, myMountToken, { confirmDeletions: tokens });
  });
  // When a question appears (a new one: each token once), the focus goes to
  // its heading, so a keyboard user starts at the card, not at the top of the
  // page (audit m4). A repaint of the same question leaves the focus alone.
  const delTitle = document.getElementById('sync-deletion-title');
  if (delTitle && state.deletionAsk && state.deletionFocusedToken !== state.deletionAsk.details.confirmToken) {
    state.deletionFocusedToken = state.deletionAsk.details.confirmToken;
    try { delTitle.focus(); } catch { /* not focusable right now */ }
  }

  const tokOpen = document.getElementById('btn-token-open');
  if (tokOpen) tokOpen.addEventListener('click', () => {
    state.tokenForm = { ...state.tokenForm, open: true, dismissed: false, error: null, detail: null, code: null, focusPending: true };
    render(myMountToken);
  });
  const tokInput = document.getElementById('sync-token-input');
  if (tokInput) {
    tokInput.value = state.tokenForm.token || '';
    tokInput.addEventListener('input', (e) => { state.tokenForm.token = e.target.value; });
    tokInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); onReplaceToken(myMountToken); } });
    if (state.tokenForm.focusPending) {
      state.tokenForm.focusPending = false;
      try { tokInput.focus(); } catch { /* not focusable right now */ }
    }
  }
  const tokCancel = document.getElementById('btn-token-cancel');
  if (tokCancel) tokCancel.addEventListener('click', () => {
    state.tokenForm = { ...freshState().tokenForm, dismissed: true };
    render(myMountToken);
  });
  const tokSave = document.getElementById('btn-token-save');
  if (tokSave) tokSave.addEventListener('click', () => onReplaceToken(myMountToken));
}

// POST /api/sync/token. The token is read from the field and cleared from
// state and the field BEFORE the request, so it is held only by this call's
// own variable while the check runs; a failure asks for it again rather than
// keeping it. Nothing in the answer carries it.
async function onReplaceToken(token) {
  if (state.tokenForm.submitting || state.acting) return;
  const input = document.getElementById('sync-token-input');
  let pat = ((input ? input.value : state.tokenForm.token) || '').trim();
  state.tokenForm.token = '';
  if (input) input.value = '';
  if (!pat) {
    state.tokenForm.error = 'Paste the new token from GitHub first. Nothing was changed.';
    state.tokenForm.detail = null;
    state.tokenForm.code = null;
    state.tokenForm.focusPending = true;
    render(token);
    return;
  }
  state.tokenForm.submitting = true;
  state.tokenForm.error = null;
  state.tokenForm.detail = null;
  state.tokenForm.code = null;
  state.acting = 'token';
  render(token);
  let res = null;
  let data = {};
  try {
    res = await fetch('/api/sync/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: pat }),
    });
    try { data = await res.json(); } catch { data = {}; }
  } catch {
    res = null;
  } finally {
    pat = '';
  }
  if (!isCurrentMount(token)) return;
  state.acting = null;
  if (res && res.ok) {
    state.tokenForm = freshState().tokenForm;
    // The earlier "token rejected" is answered: it must not come back on a re-seed.
    markOutcomeSeen(lastSyncOutcome());
    state.actionError = null;
    state.actionErrorDetail = null;
    state.actionErrorCode = null;
    state.actionMessage = 'Token replaced. Sync uses the new token from now on.';
    await loadStatus(token);
    if (!isCurrentMount(token)) return;
    render(token);
    await refreshSyncRemoteBadge();
    return;
  }
  state.tokenForm.submitting = false;
  state.tokenForm.open = true;
  state.tokenForm.focusPending = true;
  state.tokenForm.error = res
    ? ((data && data.error) || 'The new token could not be saved. Nothing was changed.')
    : 'The Curator could not be reached, so the token was not changed. Try again.';
  state.tokenForm.detail = (data && typeof data.detail === 'string' && data.detail) || null;
  state.tokenForm.code = (data && typeof data.code === 'string' && data.code) || null;
  render(token);
}

// ── Actions ───────────────────────────────────────────────────────────────

async function onConnect(token) {
  // L3 fix (re-audit finding): prefer the LIVE DOM value over state — a
  // password manager or browser autofill can assign an input's `.value`
  // directly without dispatching an `input` event, so state.setupForm
  // (which only updates via the 'input' listeners in wireListeners) can
  // lag behind what's actually sitting in the field. Falling back to state
  // covers the input somehow not being in the DOM at all (shouldn't
  // happen on this branch, but cheap to keep). Re-sync state from
  // whichever source won, so a subsequent render (the error path below)
  // reflects reality either way.
  const repoInput = document.getElementById('setup-repo-url');
  const tokenInput = document.getElementById('setup-token');
  const repoUrl = (repoInput ? repoInput.value : state.setupForm.repoUrl) || '';
  const pat = (tokenInput ? tokenInput.value : state.setupForm.token) || '';
  state.setupForm.repoUrl = repoUrl;
  state.setupForm.token = pat;
  if (!repoUrl.trim() || !pat.trim()) {
    state.setupForm.error = 'Both the repository URL and a token are required.';
    state.setupForm.errorDetail = null;  // not an earlier failure's support line
    state.setupForm.errorCode = null;
    render(token);
    return;
  }
  // ── PREFLIGHT FIRST, ALWAYS ──────────────────────────────────────────
  // The whole defect this replaces is that Connect went straight to an
  // operation that could replace files, with no number in front of it. The
  // preflight writes nothing outside a tempdir (see preflightSetup in
  // brain/sync.js) and its only cost is one fetch, paid once per install.
  //
  // A preflight that FAILS does not block the connect: it is an
  // improvement to the information, not a new gate, and a user whose
  // preflight failed for a transient reason must still be able to connect.
  // The server-side refusal in setup() is the real guard, and it cannot be
  // skipped — this is the half that turns that refusal into a choice.
  state.setupForm.checking = true;
  state.setupForm.error = null;
  state.setupForm.errorDetail = null;
  state.setupForm.errorCode = null;
  state.setupForm.decision = null;
  render(token);
  let pre = null;
  try {
    const res = await fetch('/api/sync/preflight', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoUrl: repoUrl.trim(), token: pat.trim() }),
    });
    const data = await res.json();
    if (res.ok && data && data.ok) pre = data;
    else if (!res.ok) {
      if (!isCurrentMount(token)) return;
      state.setupForm.checking = false;
      state.setupForm.error = data && data.error ? data.error : 'Could not reach that repository.';
      state.setupForm.errorDetail = (data && typeof data.detail === 'string' && data.detail) || null;
      state.setupForm.errorCode = (data && typeof data.code === 'string' && data.code) || null;
      render(token);
      return;
    }
  } catch { /* transient — fall through to the connect, which has its own guard */ }
  if (!isCurrentMount(token)) return;
  state.setupForm.checking = false;

  if (pre) {
    if (pre.foreignSyncRepo && !pre.foreignSyncRepo.matchesRequestedRepo) {
      state.setupForm.decision = { kind: 'foreign', originUrl: pre.foreignSyncRepo.originUrl };
      render(token);
      return;
    }
    if (pre.foreignSyncRepo) {
      state.setupForm.decision = { kind: 'adopt', originUrl: pre.foreignSyncRepo.originUrl };
      render(token);
      return;
    }
    if (state.setupForm.mode === 'pull' && pre.overwriteCount > 0) {
      state.setupForm.decision = {
        kind: 'overwrite',
        count: pre.overwriteCount,
        sample: pre.overwriteSample || [],
        createCount: pre.createCount || 0,
      };
      render(token);
      return;
    }
    // Before anything goes up: what is not a domain, and what stays behind.
    if (state.setupForm.mode !== 'pull' && connectNeedsReview(pre.backup)) {
      state.setupForm.decision = { kind: 'review', backup: pre.backup };
      render(token);
      return;
    }
  }

  await runSetup(state.setupForm.mode, false, token);
}

/**
 * POST /api/sync/setup and render whatever comes back.
 *
 * `confirmOverwrite` is threaded explicitly rather than read off state, so
 * that grepping this file for the literal `true` at its call sites shows
 * every path that can authorise an overwrite. There is one.
 */
async function runSetup(mode, confirmOverwrite, token) {
  const repoUrl = (state.setupForm.repoUrl || '').trim();
  const pat = (state.setupForm.token || '').trim();
  state.setupForm.mode = mode;
  state.setupForm.submitting = true;
  state.setupForm.error = null;
  state.setupForm.errorDetail = null;
  state.setupForm.errorCode = null;
  render(token);
  try {
    const res = await fetch('/api/sync/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoUrl, token: pat, mode, confirmOverwrite: confirmOverwrite === true, leaveOut: state.setupForm.leaveOut || undefined }),
    });
    const data = await res.json();
    if (!res.ok) {
      // A 409 carries setup()'s own refusal code and numbers. Render it as
      // the same decision panel the preflight would have produced — so the
      // route's guard is not merely an error, it is the same offer of a
      // non-destructive route. This is the path a client that skipped the
      // preflight lands on, which is why it must render a CHOICE and not a
      // red box.
      if (!isCurrentMount(token)) return;
      if (res.status === 409 && data && data.code === 'pull-would-overwrite') {
        const det = data.details || {};
        state.setupForm.decision = {
          kind: 'overwrite',
          count: det.overwriteCount || 0,
          sample: det.overwriteSample || [],
          createCount: det.createCount || 0,
        };
      } else if (res.status === 409 && data && data.code === 'foreign-sync-repo') {
        state.setupForm.decision = { kind: 'foreign', originUrl: (data.details || {}).otherOriginUrl };
      } else if (res.status === 409 && data && data.code) {
        state.setupForm.decision = { kind: data.code, message: data.error };
      } else {
        const e = new Error(data.error || 'Could not connect.');
        e.detail = (data && typeof data.detail === 'string' && data.detail) || null;
        e.code = (data && typeof data.code === 'string' && data.code) || null;
        throw e;
      }
      state.setupForm.submitting = false;
      render(token);
      return;
    }
    if (!isCurrentMount(token)) return;
    // v3.72.1 (F4): a pull-mode connect brings domains in — the sidebar's
    // list is re-read with the status, not left at the pre-connect set.
    await Promise.all([loadStatus(token), loadDomains(token), loadBackup(token)]);
    if (!isCurrentMount(token)) return;
    state.setupForm = freshState().setupForm;
  } catch (err) {
    if (!isCurrentMount(token)) return;
    state.setupForm.decision = null;
    const u = userMessageFrom(err);
    state.setupForm.error = u.error;
    state.setupForm.errorDetail = u.detail || null;
    state.setupForm.errorCode = u.code || null;
  } finally {
    // Unlike domains.js's busyKey (a SINGLE persistent `state` object that
    // survives across mounts, where an ungated reset is required — see H2),
    // this view's `state` is REASSIGNED WHOLESALE on every onEnter
    // (`state = freshState()`). A fresh mount therefore already starts with
    // `submitting: false` regardless of what a stale mount's finally does —
    // so gating here isn't just safe, it's REQUIRED: an ungated reset would
    // reach through the `state` closure variable into whatever the CURRENT
    // (possibly already-mid-connect) mount's state object is and wrongly
    // clear ITS OWN in-flight submitting flag.
    // `checking` is cleared here too: onConnect sets it, and a throw
    // between that and runSetup's own reset would otherwise leave the
    // Connect button reading "Checking…" and disabled with nothing running.
    if (isCurrentMount(token)) {
      state.setupForm.submitting = false;
      state.setupForm.checking = false;
      render(token);
    }
  }
}

async function onAction(kind, token, opts) {
  // ONE sync at a time. A run started on an earlier mount, or by another
  // view, is still running in the shell; this click must not start a second
  // one beside it (that second run used to die with "Another sync check was
  // running at the same time" — what the owner read as "cancelled").
  if (currentSyncRun()) return;
  state.acting = kind;
  state.actionMessage = null;
  state.actionError = null;
  render(token);
  // The run belongs to the SHELL (shared/sync-run.js), not to this mount:
  // the request is never aborted, and its result is NOT dropped when the
  // user navigates away. Whichever mount is current when it settles paints
  // it through onSyncRunChanged() — this one, a later one, or none (the
  // rail and a toast show it then). The runner awaits settleSyncBadges()
  // BEFORE it clears the run, so every button comes back only after both
  // badge halves are re-read; onSyncRunChanged() then clears `acting`,
  // shows the sentence and re-reads the status and the domain list.
  //
  // Before v3.89.2 this function awaited the request itself and dropped the
  // result on a stale mount token, so a sync that finished while the user
  // was on another page left the Sync page idle, enabled and unchanged.
  await startSyncRun(kind, opts);
}

// ── Result copy ─────────────────────────────────────────────────────────
//
// PARITY, and this is the reason it is written out rather than shortened.
// "Sync now" is the primary action on this screen, and until v3.9.1 the
// bidirectional branch returned the bare string 'Sync complete.' — no
// counts, no direction, nothing. Push-only and pull-only each reported
// their number, so the ONE action the design makes prominent was the one
// that told the user least.
//
// The data was never missing. POST /api/sync/sync returns
// `{pullResult, pushResult}` — brain/sync.js's sync() awaits pull() then
// push() and returns both, and routes/sync.js passes that through
// untouched. Both counts were arriving on the wire and being discarded
// here. (Worth stating plainly, because the opposite shape — a plausible
// sentence rendered over data that never arrives — is this codebase's
// named dead-data defect, and the fix for that one would have been in the
// backend. This one genuinely was the string.)
//
// The shipping app has rendered all of this since v2.3.7
// (src/public/app.js, the #sync-both-btn handler): both directions, and
// the pruned-domain list that tells you a delete propagated from another
// machine. v2.3.7 exists because push once claimed "6 files synced" when
// ~200 had moved, so under-reporting here is a regression twice over.
//
// Every string below is rendered through escapeHtml() by renderConfigured.

function fileCount(n) {
  return n + ' file' + (n === 1 ? '' : 's');
}

// The v2.3.4 sync-delete signal: another machine deleted a domain, the pull
// removed its files, and pruneGhostDomainDirs() cleaned up the empty shell
// git left behind. Silence here reads as "nothing happened" for what is
// actually the most consequential thing a pull can do.
//
// THE WORDING IS PART OF THE DEFECT THIS FIXES. "removed N deleted domains"
// was printed for whatever the prune had deleted — and until v3.33.0 that
// included any top-level folder without a CLAUDE.md, so the one sentence
// the user got about a recursive delete could be false about the single
// fact that mattered: what was destroyed was not a domain at all. The
// backend is now narrow enough that a stray folder cannot reach here, but
// the sentence still says only what is provable: this folder's contents
// were deleted on another machine and that deletion has now arrived. It
// does not claim the folder was a domain.
//
// Named list capped at 5 — the shipping app joins all of them, which is
// fine for the realistic 1-2 but would build an unbounded sentence from
// remote-controlled names. Cap, then say how many more.
const PRUNED_NAMES_SHOWN = 5;

function nameList(names) {
  const shown = names.slice(0, PRUNED_NAMES_SHOWN);
  const rest = names.length - shown.length;
  return shown.join(', ') + (rest > 0 ? ', and ' + rest + ' more' : '');
}

function describePruned(pruned) {
  if (!pruned || !pruned.length) return null;
  return 'removed ' + pruned.length + ' folder'
    + (pruned.length === 1 ? '' : 's') + ' deleted on another machine ('
    + nameList(pruned) + ')';
}

// The other half of the same event, and the one that needs saying out loud:
// the pull found a folder whose synced content is gone, but it still holds
// a file the user has never pushed, so nothing was deleted. Without this
// line the user's only signal is silence, and the folder looks like it
// simply survived by luck.
function describePruneKept(kept) {
  if (!kept || !kept.length) return null;
  return 'kept ' + kept.length + ' folder' + (kept.length === 1 ? '' : 's')
    + ' that still ' + (kept.length === 1 ? 'holds' : 'hold')
    + ' local files (' + nameList(kept) + ')';
}

function describeResult(kind, data) {
  // What was not backed up goes in the same sentence as what was. A "Sync
  // complete" alone over a folder that never reached GitHub was the defect.
  const warning = kind === 'sync' ? (data.pushResult || {}).warning : data.warning;
  const said = (text) => (warning ? text + ' ' + warning : text);
  if (kind === 'push') {
    if (data.pushed === false) return said(data.message || 'Everything is already up to date.');
    return said('Pushed ' + fileCount(data.filesChanged || 0) + ' to GitHub.');
  }

  if (kind === 'pull') {
    const n = data.filesChanged || 0;
    const pruned = describePruned(data.pruned);
    const kept = describePruneKept(data.prunedKept);
    if (n === 0 && !pruned && !kept) return said('Already up to date — nothing new on GitHub.');
    const parts = [];
    if (n > 0) parts.push('Pulled ' + fileCount(n) + ' from GitHub');
    if (pruned) parts.push(pruned);
    if (kept) parts.push(kept);
    return said(parts.join(', ') + '.');
  }

  // Bidirectional. sync() runs pull() FIRST, then push(), and both results
  // are reported in that order so the sentence matches what happened.
  const pullResult = data.pullResult || {};
  const pushResult = data.pushResult || {};
  const pulled = pullResult.filesChanged || 0;
  const pushed = pushResult.filesChanged || 0;

  const parts = [];
  if (pulled > 0) parts.push('pulled ' + fileCount(pulled) + ' from GitHub');
  // `pushed === true` is checked as well as the count: push() reports
  // filesChanged 0 with pushed:false when there was nothing to send, and
  // claiming a push that never ran is the same class of dishonesty as the
  // count that is missing entirely.
  if (pushResult.pushed && pushed > 0) parts.push('pushed ' + fileCount(pushed) + ' to GitHub');
  const pruned = describePruned(pullResult.pruned);
  if (pruned) parts.push(pruned);
  const kept = describePruneKept(pullResult.prunedKept);
  if (kept) parts.push(kept);

  if (!parts.length) {
    return warning ? 'Nothing new to sync. ' + warning : 'Sync complete — everything was already up to date.';
  }
  return warning
    ? 'Synced, with a gap: ' + parts.join(', ') + '. ' + warning
    : 'Sync complete — ' + parts.join(', ') + '.';
}

async function onDisconnect(token) {
  state.acting = 'disconnect';
  render(token);
  try {
    const res = await fetch('/api/sync/disconnect', { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) {
      const e = new Error(data.error || 'Could not disconnect.');
      e.detail = (data && typeof data.detail === 'string' && data.detail) || null;
      e.code = (data && typeof data.code === 'string' && data.code) || null;
      throw e;
    }
    if (!isCurrentMount(token)) return;
    state = freshState();
    render(token);
    // LOW-7 fix (re-audit): this fire-and-forget call had no `.catch` —
    // an unexpected throw deep inside loadAll() would have become a bare,
    // unattributed "Uncaught (in promise)". This is a user-triggered
    // ACTION (not a mount), so it gets the lighter action-failure logger,
    // not the full mount-error card.
    loadAll(token).catch(reportAsyncActionFailure);
  } catch (err) {
    if (!isCurrentMount(token)) return;
    const u = userMessageFrom(err);
    state.actionError = u.error;
    state.actionErrorDetail = u.detail || null;
    // v3.99.2: kept for the support line (it was dropped before).
    state.actionErrorCode = u.code || null;
    state.acting = null;
    state.disconnectConfirmOpen = false;
    render(token);
  }
}
