// View: Sync — "where it all lives". A footer item rather than a rail
// peer: you need to know at a glance that changes are unpushed (the rail
// badge), but rarely need to come here on purpose.
//
// Backend used (all pre-existing — see src/routes/sync.js, src/brain/sync.js):
//   GET    /api/sync/status                    → {configured, changesCount, lastSync, repoUrl}
//   POST   /api/sync/setup {repoUrl, token, mode}
//   POST   /api/sync/push | /pull | /sync
//   DELETE /api/sync/disconnect
// Plus two read-only calls used ONLY to render honest context, not owned
// by this view's write surface:
//   GET /api/domains                 → real domain names for the sidebar list
//   GET /api/sharedbrain/feature-flag + /list → the one-line SB reporting row
//     (404s cleanly when the flag is off — treated as "not connected", not
//     an error)
//
// Honesty notes (see this session's task brief):
//   - There is NO commit-history/revert endpoint anywhere in the backend
//     (verified against src/brain/sync.js and src/routes/sync.js — push()
//     and pull() return only a same-call file-count/preview, not a
//     persisted log with revertable entries). The design's History section
//     is rendered as an honest "coming soon" empty state — never a fake list.
//   - GET /api/sync/status returns a single TOTAL changesCount from
//     `git status --porcelain`; there is no per-file or per-domain endpoint
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
  registerView, setSidebar, setMain, eyebrow, escapeHtml, icon, navigate, isCurrentMount,
  reportAsyncMountFailure, reportAsyncActionFailure,
  isAnyWriteBusy, getDomainWriteLabel, onWriteGateChange,
  refreshSyncBadge, refreshSyncRemoteBadge,
} from '../app.js';
import { createLoadingGate, gatedLoader, settleGate } from '../shared/loading-gate.js';
// ── THE TEXT SYSTEM (shared/text.js) ──────────────────────────────────────
// This view used to carry five different treatments for text: `.view-body`
// and `.sidebar-hint` for static prose, `.settings-hint-text` for more static
// prose, `.sync-last`/`.sync-pending-note`/`.sync-sb-meta` for GENERATED
// figures, and `.status-pill-ok` for connection state. The centre pane's
// description was rendered in `.view-body` — the same class a GENERATED scan
// sentence uses in domains.js and the same class loading-gate.js paints its
// placeholder in — which is precisely the reported defect: a measurement and
// an explanation in one voice.
//
// Adopted role by role, never by renaming a class:
//   static prose          -> renderDescription   (ONE treatment, --text-2)
//   a computed figure     -> renderReadout       (mono value, sans label)
//   connection state      -> renderStatus        (3px left rail, no sentence)
//   background prose      -> renderExplainer     (closed <details>)
//
// `.view-body` itself SURVIVES in shell.css — loading-gate.js's loaderHtml()
// DEFAULTS to it, so deleting the class would silently unstyle every gated
// placeholder in the app. What is removed here is this view's USE of it.
import {
  renderDescription, renderReadout, renderReadoutGroup, renderStatus, renderExplainer,
} from '../shared/text.js';

function freshState() {
  return {
    loading: true,
    status: null,      // GET /api/sync/status response
    statusError: null,
    domains: [],        // GET /api/domains → domains[]
    sb: null,           // { enabled, connection } | null while loading
    acting: null,       // 'sync' | 'push' | 'pull' | 'disconnect' | null
    actionMessage: null,
    actionError: null,
    disconnectConfirmOpen: false,
    setupForm: { repoUrl: '', token: '', mode: 'push', submitting: false, error: null },
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

registerView('sync', {
  onEnter(mountToken) {
    state = freshState();
    myMountToken = mountToken;
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
    unsubscribeWriteGate = onWriteGateChange(() => {
      if (isCurrentMount(mountToken)) render(mountToken);
    });

    return () => {
      // L2 fix (re-audit finding): don't let a typed-but-unsubmitted (or
      // in-flight, later-abandoned) GitHub token sit in memory after the
      // user leaves this view. onConnect()'s success path already clears
      // state.setupForm.token, but that clear sits behind an early return
      // that skips it entirely if the connect happens to resolve after
      // the user has already navigated away — this is the unconditional
      // backstop.
      state.setupForm.token = '';

      // Timer hygiene (load-bearing): an armed delay timer that survives
      // this teardown would paint a loader into whatever view comes next.
      if (loadGate) { loadGate.cancel(); loadGate = null; }
      if (unsubscribeWriteGate) { unsubscribeWriteGate(); unsubscribeWriteGate = null; }
    };
  },
});

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
  await Promise.all([loadStatus(token), loadDomains(token), loadSharedBrainSummary(token)]);
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
  } catch (err) {
    if (!isCurrentMount(token)) return;
    state.status = { configured: false };
    state.statusError = err.message;
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
    if (!flag.enabled) { if (isCurrentMount(token)) state.sb = { enabled: false, connection: null }; return; }
    const listRes = await fetch('/api/sharedbrain/list');
    if (!listRes.ok) { if (isCurrentMount(token)) state.sb = { enabled: true, connection: null }; return; }
    const list = await listRes.json();
    const connection = (list.connections && list.connections[0]) || null;
    if (isCurrentMount(token)) state.sb = { enabled: true, connection };
  } catch {
    if (isCurrentMount(token)) state.sb = { enabled: false, connection: null };
  }
}

// ── Render ───────────────────────────────────────────────────────────────

function render(token) {
  renderSidebar(token);
  renderMain(token);
  wireListeners();
}

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
          '<span class="sync-domain-name mono">' + escapeHtml(d) + '</span>' +
        '</div>'
      )).join('')
    : '<div class="sidebar-note">No domains to back up yet.</div>';

  // Same cross-view write-gate note ingest.js's sidebar shows (own class,
  // own copy — see the README's "own your own CSS file" rule) — only
  // meaningful once a repo is actually connected, since an unconfigured
  // card's one action (Connect) isn't gated (see this file's header
  // comment for why).
  // STATE, not prose. This used to be an amber box rendering
  // `--attention-text` as TEXT on `--attention-tint` — measured 9.11 dark but
  // **3.21 light**, under the 4.5 AA floor (shared/text.js FINDING 2). As a
  // status the amber moves to the 3px rail, whose floor is 3:1 as a non-text
  // border and which it clears in both themes (10.70 / 3.58), while the title
  // and detail sit at --text / --text-2. Nothing is decoded by colour alone.
  const writeBusy = state.status && state.status.configured && crossWriteBusy();
  const busyNote = writeBusy
    ? renderStatus({ state: 'attention', title: 'Another write is running', detail: crossWriteTitle() })
    : '';

  setSidebar(
    '<div class="sidebar-title">Sync</div>' +
    renderDescription('Pages, chats and schemas travel; source files and keys stay here.') +
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

  setMain(
    eyebrow('where it all lives') +
    '<h1 class="view-title">Sync</h1>' +
    // `.sync-lede` is a SPACING wrapper only (the 22px `.view-body` used to
    // carry); the treatment is the component's. Wrapping rather than adding
    // a margin to `.tx-desc` keeps the shared class free of view-specific
    // spacing — the way the 81 one-off text classes grew in the first place.
    '<div class="sync-lede">' +
      renderDescription('Your wiki lives on your disk and backs up to a private GitHub repository you own.') +
    '</div>' +
    body,
    token
  );
}

function renderUnconfigured() {
  const f = state.setupForm;
  return (
    '<div class="sync-setup-card">' +
      '<div class="sync-setup-title">Connect a GitHub repository</div>' +
      renderDescription('Paste an empty private repo and a token with Contents: Read and write access. ' +
        '“Push” sends this machine’s wiki up first; “Pull” starts from what’s already in the repo.') +
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
        '<input type="password" class="mono sync-setup-input" id="setup-token" placeholder="ghp_… or a fine-grained token">' +
      '</div>' +
      '<div class="sync-setup-field">' +
        '<span class="sync-setup-label">Starting direction</span>' +
        '<div class="theme-segmented">' +
          '<button type="button" class="theme-seg-btn' + (f.mode === 'push' ? ' active' : '') + '" data-mode="push">Push my wiki</button>' +
          '<button type="button" class="theme-seg-btn' + (f.mode === 'pull' ? ' active' : '') + '" data-mode="pull">Pull an existing wiki</button>' +
        '</div>' +
      '</div>' +
      (f.error ? '<div class="settings-inline-error">' + escapeHtml(f.error) + '</div>' : '') +
      '<button type="button" class="btn btn-primary" id="btn-sync-connect"' + (f.submitting ? ' disabled' : '') + '>' +
        (f.submitting ? 'Connecting…' : 'Connect') +
      '</button>' +
    '</div>'
  );
}

function renderConfigured(s) {
  const acting = state.acting;
  const lastSyncLabel = s.lastSync ? formatSyncTime(s.lastSync) : 'never';
  const pendingCount = typeof s.changesCount === 'number' ? s.changesCount : 0;

  // Cross-view write gate (see this file's header comment). `acting` is
  // THIS view's own in-flight action (e.g. mid-push) — that already
  // disables the buttons and shows its own "Pushing…" label, and is NOT a
  // conflict with itself, so the cross-write title only applies when
  // something ELSE is busy and this view is idle.
  const crossBusy = !acting && crossWriteBusy();
  const disabled = acting || crossBusy;
  const crossTitle = crossBusy ? ' title="' + escapeHtml(crossWriteTitle()) + '"' : '';

  return (
    '<div class="sync-status-card">' +
      // ── STATE, then INSTRUMENTS ──────────────────────────────────────
      // Three roles used to share one row. `Connected` was a pill rendering
      // --success-text as TEXT on --success-tint (measured 8.73 dark but
      // **3.59 light** — under AA); the repo was a 12.5px HARDCODED size, so
      // it froze at 1x while Settings > General scaled everything around it;
      // and `last synced` sat at --text-3 (4.27 / 4.14, under AA) reading as
      // a subtitle rather than as the measurement it is.
      //
      // Now: the connection STATE is a status (rail carries the colour, at
      // the 3:1 non-text floor it clears in both themes), and the two
      // computed figures are readouts — mono value, sans label, both at or
      // above --text-2.
      '<div class="sync-conn">' +
        renderStatus({ state: 'success', title: 'Connected', detail: s.repoUrl || '' }) +
        // NO TONE ON A NUMBER. The pending count used to render in
        // --attention-text. shared/text.js is explicit that colouring a
        // figure is a JUDGEMENT about it and judgement is renderStatus's
        // role — and unpushed local changes are the ORDINARY state of a
        // wiki being used, not a finding. The rail badge in the shell
        // already carries the alerting; this is the instrument.
        renderReadoutGroup([
          { label: 'Last synced', value: lastSyncLabel },
          { label: 'Local changes not pushed', value: pendingCount },
        ]) +
      '</div>' +
      (state.statusError ? '<div class="settings-inline-error">' + escapeHtml(state.statusError) + '</div>' : '') +
      '<div class="sync-status-actions">' +
        '<button type="button" class="btn btn-primary" id="btn-sync-now"' + (disabled ? ' disabled' : '') + crossTitle + '>' +
          icon('refresh', 14) + ' ' + (acting === 'sync' ? 'Syncing…' : 'Sync now') +
        '</button>' +
        '<button type="button" class="btn btn-secondary" id="btn-sync-push"' + (disabled ? ' disabled' : '') + crossTitle + '>' + (acting === 'push' ? 'Pushing…' : 'Push only') + '</button>' +
        '<button type="button" class="btn btn-secondary" id="btn-sync-pull"' + (disabled ? ' disabled' : '') + crossTitle + '>' + (acting === 'pull' ? 'Pulling…' : 'Pull only') + '</button>' +
      '</div>' +
      // An ACTION REPORT — generated from what the push/pull actually moved
      // (describeResult below composes the real counts). It used to render in
      // `.sync-action-note`: --text-2 body prose, i.e. the same voice as this
      // view's own static description two elements above it. As a status it
      // reads as a statement about the live system, which is what it is.
      // Only the success path ever sets it (onAction throws on !res.ok), so
      // the tone is not a guess. The failure path keeps `.settings-inline-error`
      // deliberately — see this file's note below renderConfigured.
      (state.actionMessage
        ? '<div class="sync-action-report">' +
            renderStatus({ state: 'success', title: state.actionMessage }) +
          '</div>'
        : '') +
      (state.actionError ? '<div class="settings-inline-error" style="margin-top:8px">' + escapeHtml(state.actionError) + '</div>' : '') +
    '</div>' +

    renderSharedBrainRow() +

    '<span class="cur-eyebrow" style="display:block;margin-bottom:11px">History</span>' +
    // THE ONE EXPLAINER IN THIS VIEW, and the split is by role rather than by
    // length. The absence of a history list is STATE (there is no endpoint) —
    // that is the news, and it stays on screen. The workaround is background
    // prose: read once, then never again, which is renderAbout's own stated
    // reason for defaulting a <details> closed. Folding it also makes it
    // FINDABLE under a label instead of being the tail of a paragraph.
    //
    // NOT A WARNING, so `warning` is deliberately not used: nothing here is
    // lost, at risk, or costs money. Every clause of the previous copy
    // survives — no claim was added, and the false revert promise this view
    // used to carry is not being reintroduced under a fold.
    '<div class="sync-history">' +
      renderStatus({
        state: 'neutral',
        title: 'Commit history & revert are coming soon',
        detail: 'Every sync is already a real git commit, so the data to revert from exists on disk — ' +
          'there just isn’t a history endpoint yet to list or revert individual commits from this view.',
      }) +
      renderExplainer({
        summary: 'Reverting a sync today',
        body: 'A git client pointed at your knowledge base folder can do it directly.',
      }) +
    '</div>' +

    renderDisconnect()
  );
}

function renderSharedBrainRow() {
  const sb = state.sb;
  const conn = sb && sb.connection ? sb.connection : null;
  const lastPush = conn && conn.last_push_at ? formatSyncTime(conn.last_push_at) : null;

  // ABSENT IS NOT ZERO, and this row is where the rule bites. `state.sb` is
  // null only while the read is still in flight; rendering "Not connected to
  // any Shared Brain" then would state a measurement nobody has taken. It is
  // omitted instead — renderReadout returns '' for a null value, so the
  // concatenation stays unconditional.
  const readout = sb
    ? renderReadout(conn
        ? {
            label: 'Shared Brain',
            value: conn.label || 'Shared Brain',
            // Provenance is the "when/how it was taken" slot, which is
            // exactly what a last-push stamp is. No push yet -> the clause
            // is OMITTED, never rendered as a zero or a dash.
            provenance: lastPush ? 'pushed ' + lastPush : undefined,
          }
        : { label: 'Shared Brain', value: 'not connected' })
    : '';

  return (
    '<div class="sync-sb-row">' +
      icon('users', 16) +
      '<div class="sync-sb-text">' +
        // html:true, and the caller owns escaping (shared/text.js states
        // this). Safe here by construction: the argument is a STATIC literal
        // with no interpolation, and the <strong> is the cross-reference to
        // the view that actually owns this control.
        renderDescription(
          'Shared Brain pushes are managed in <strong>Shared Brain</strong>. This tab only reports them.',
          { html: true },
        ) +
      '</div>' +
      readout +
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
  const crossTitle = crossBusy ? ' title="' + escapeHtml(crossWriteTitle()) + '"' : '';

  if (state.disconnectConfirmOpen) {
    return (
      '<div class="sync-disconnect-confirm">' +
        // A view-owned wrapper carries the FLEX SIZING. Nothing in this file
        // may select a `tx-` class: shared/text.css owns that prefix and its
        // suite asserts no other stylesheet defines a rule on it, which is
        // what stops an adopter quietly re-styling the shared roles back into
        // 81 local variants. A view positions the component; it never dresses
        // it.
        '<div class="sync-disconnect-text">' +
          renderDescription('Disconnect this repository? Your local wiki files stay exactly as they are — only the sync ' +
            'connection is removed. You can reconnect any time.') +
        '</div>' +
        '<div class="sync-disconnect-actions">' +
          '<button type="button" class="btn btn-secondary btn-xs" id="btn-disconnect-confirm"' + (disabled ? ' disabled' : '') + crossTitle + '>' +
            (acting === 'disconnect' ? 'Disconnecting…' : 'Disconnect') +
          '</button>' +
          // Cancel never hits the network — always enabled, even mid cross-write, so there is always a way out of the confirm panel.
          '<button type="button" class="btn btn-ghost btn-xs" id="btn-disconnect-cancel">Cancel</button>' +
        '</div>' +
      '</div>'
    );
  }
  return '<button type="button" class="sync-disconnect-link" id="btn-disconnect-open"' + (disabled ? ' disabled' : '') + crossTitle + '>Disconnect this repository</button>';
}

// ── Formatting ────────────────────────────────────────────────────────────

function formatSyncTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return 'today ' + time;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + time;
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
    render(token);
    return;
  }
  state.setupForm.submitting = true;
  state.setupForm.error = null;
  render(token);
  try {
    const res = await fetch('/api/sync/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoUrl: repoUrl.trim(), token: pat.trim(), mode: state.setupForm.mode }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not connect.');
    if (!isCurrentMount(token)) return;
    await loadStatus(token);
    if (!isCurrentMount(token)) return;
    state.setupForm = freshState().setupForm;
  } catch (err) {
    if (!isCurrentMount(token)) return;
    state.setupForm.error = err.message;
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
    if (isCurrentMount(token)) { state.setupForm.submitting = false; render(token); }
  }
}

async function onAction(kind, token) {
  state.acting = kind;
  state.actionMessage = null;
  state.actionError = null;
  render(token);
  try {
    const res = await fetch('/api/sync/' + kind, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'That didn’t work.');
    if (isCurrentMount(token)) state.actionMessage = data.message || describeResult(kind, data);
  } catch (err) {
    if (isCurrentMount(token)) state.actionError = err.message;
  } finally {
    // Gated, not unconditional — see onConnect's comment above: this
    // view's `state` is reassigned wholesale on every mount, so an
    // ungated reset here would reach into the CURRENT (possibly already
    // mid-action) mount's own state object and wrongly clear its
    // genuinely-in-flight `acting` flag. A fresh mount already starts
    // with `acting: null` via freshState() regardless.
    // Repaint the RAIL badge, and do it BEFORE this view's buttons come
    // back — the ordering is the fix, not an aesthetic choice. A push/pull/
    // sync is exactly the moment both halves of the badge become wrong: the
    // local count just dropped, and a pull just consumed whatever was
    // waiting on GitHub. Without this the rail could keep showing "↓5
    // waiting to pull" for up to the 10-minute remote interval AFTER the
    // user pulled it — telling them to do work they have already done.
    //
    // WHY IT MOVED ABOVE `state.acting = null` (release-blocker fix). It
    // used to run at the END of this block, unawaited, AFTER render() had
    // already re-enabled every button. refreshSyncRemoteBadge() issues a
    // real `git fetch`, so that left a live fetch running against controls
    // the user could click: Push → buttons re-enable → Sync now → the
    // user's own pull raced our own background fetch over
    // refs/remotes/origin/main and died before merging (reproduced against
    // real git, 11 failures in 12). brain/sync.js now serialises its
    // fetches and pull() survives a lost race, so this is the second of two
    // layers — but a UI that hands the user a button while it is still
    // working is worth removing on its own merits, and relying on the
    // backend to absorb a window we deliberately opened is how the next
    // one gets opened.
    //
    // Awaiting is safe by contract: refreshSyncRemoteBadge() NEVER throws
    // and never rejects (see its definition — boot() depends on that).
    // Ungated on the mount token, deliberately: both update module-level
    // shell state and the rail, which outlive this view, so there is no
    // stale-mount hazard. refreshSyncBadge() is local-only and instant, so
    // it stays fire-and-forget.
    if (isCurrentMount(token)) {
      refreshSyncBadge();
      await refreshSyncRemoteBadge();
    }
    if (isCurrentMount(token)) {
      state.acting = null;
      // HIGH-1 fix (third re-audit round): this used to `await loadStatus()`
      // in the finally with NO render() afterward — loadStatus() only
      // MUTATES state, it never paints anything (see its own doc comment
      // above; unlike settings.js's loadKeys(), which does end with
      // render()). Verified with a real click + real response: the button
      // stayed showing "Pushing…" forever, no confirmation message ever
      // appeared, and the stale pending-change count never updated — a
      // push/pull that succeeded ON DISK looked, from the UI, exactly like
      // a hang. The only way out was Disconnect (the one still-enabled
      // control) or leaving the view entirely.
      await loadStatus(token);
      if (isCurrentMount(token)) render(token);
    }
  }
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
// Named list capped at 5 — the shipping app joins all of them, which is
// fine for the realistic 1-2 but would build an unbounded sentence from
// remote-controlled names. Cap, then say how many more.
const PRUNED_NAMES_SHOWN = 5;

function describePruned(pruned) {
  if (!pruned || !pruned.length) return null;
  const shown = pruned.slice(0, PRUNED_NAMES_SHOWN);
  const rest = pruned.length - shown.length;
  const names = shown.join(', ') + (rest > 0 ? ', and ' + rest + ' more' : '');
  return 'removed ' + pruned.length + ' deleted domain'
    + (pruned.length === 1 ? '' : 's') + ' (' + names + ')';
}

function describeResult(kind, data) {
  if (kind === 'push') {
    if (data.pushed === false) return data.message || 'Everything is already up to date.';
    return 'Pushed ' + fileCount(data.filesChanged || 0) + ' to GitHub.';
  }

  if (kind === 'pull') {
    const n = data.filesChanged || 0;
    const pruned = describePruned(data.pruned);
    if (n === 0 && !pruned) return 'Already up to date — nothing new on GitHub.';
    const parts = [];
    if (n > 0) parts.push('Pulled ' + fileCount(n) + ' from GitHub');
    if (pruned) parts.push(pruned);
    return parts.join(', ') + '.';
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

  if (!parts.length) return 'Sync complete — everything was already up to date.';
  return 'Sync complete — ' + parts.join(', ') + '.';
}

async function onDisconnect(token) {
  state.acting = 'disconnect';
  render(token);
  try {
    const res = await fetch('/api/sync/disconnect', { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not disconnect.');
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
    state.actionError = err.message;
    state.acting = null;
    state.disconnectConfirmOpen = false;
    render(token);
  }
}
