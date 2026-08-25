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
} from '../app.js';

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
  await Promise.all([loadStatus(token), loadDomains(token), loadSharedBrainSummary(token)]);
  if (!isCurrentMount(token)) return;
  state.loading = false;
  render(token);
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
  const writeBusy = state.status && state.status.configured && crossWriteBusy();
  const busyNote = writeBusy
    ? '<div class="sync-sidebar-busy">' + icon('alertTriangle', 13) +
      '<span>' + escapeHtml(crossWriteTitle()) + '</span></div>'
    : '';

  setSidebar(
    '<div class="sidebar-title">Sync</div>' +
    '<div class="sidebar-hint">Your whole wiki, backed up to a private GitHub repository you own. Pages, chats ' +
    'and schemas travel; source files and keys stay here.</div>' +
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
    body = '<p class="view-body">Loading sync status…</p>';
  } else if (!s || !s.configured) {
    body = renderUnconfigured();
  } else {
    body = renderConfigured(s);
  }

  setMain(
    eyebrow('where it all lives') +
    '<h1 class="view-title">Sync</h1>' +
    '<div class="view-body">Your wiki lives on your disk and backs up to a private repository you own. Every sync ' +
    'is a git commit, so anything can be reverted.</div>' +
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
      '<div class="sync-status-top">' +
        '<span class="status-pill status-pill-ok"><span class="status-pill-dot"></span>Connected</span>' +
        '<code class="mono sync-repo">' + escapeHtml(s.repoUrl || '') + '</code>' +
        '<span class="mono sync-last">last synced ' + escapeHtml(lastSyncLabel) + '</span>' +
      '</div>' +
      (state.statusError ? '<div class="settings-inline-error">' + escapeHtml(state.statusError) + '</div>' : '') +
      '<div class="sync-status-actions">' +
        '<button type="button" class="btn btn-primary" id="btn-sync-now"' + (disabled ? ' disabled' : '') + crossTitle + '>' +
          icon('refresh', 14) + ' ' + (acting === 'sync' ? 'Syncing…' : 'Sync now') +
        '</button>' +
        '<button type="button" class="btn btn-secondary" id="btn-sync-push"' + (disabled ? ' disabled' : '') + crossTitle + '>' + (acting === 'push' ? 'Pushing…' : 'Push only') + '</button>' +
        '<button type="button" class="btn btn-secondary" id="btn-sync-pull"' + (disabled ? ' disabled' : '') + crossTitle + '>' + (acting === 'pull' ? 'Pulling…' : 'Pull only') + '</button>' +
        '<span class="sync-pending-note mono">' + escapeHtml(String(pendingCount)) + ' local change' + (pendingCount === 1 ? '' : 's') + ' not pushed</span>' +
      '</div>' +
      (state.actionMessage ? '<div class="sync-action-note">' + escapeHtml(state.actionMessage) + '</div>' : '') +
      (state.actionError ? '<div class="settings-inline-error" style="margin-top:8px">' + escapeHtml(state.actionError) + '</div>' : '') +
    '</div>' +

    renderSharedBrainRow() +

    '<span class="cur-eyebrow" style="display:block;margin-bottom:11px">History</span>' +
    '<div class="sync-history-empty">' +
      '<div class="empty-title">Commit history &amp; revert are coming soon</div>' +
      '<div class="empty-body">Every sync is already a real git commit, so the data to revert from exists on disk ' +
      '— there just isn’t a history endpoint yet to list or revert individual commits from this view. Until then, ' +
      'a git client pointed at your knowledge base folder can do it directly.</div>' +
    '</div>' +

    renderDisconnect()
  );
}

function renderSharedBrainRow() {
  const sb = state.sb;
  const lastPush = sb && sb.connection && sb.connection.last_push_at ? formatSyncTime(sb.connection.last_push_at) : null;
  const label = sb && sb.connection
    ? escapeHtml(sb.connection.label || 'Shared Brain') + ' · ' + (lastPush ? 'pushed ' + escapeHtml(lastPush) : 'no pushes yet')
    : 'Not connected to any Shared Brain';
  return (
    '<div class="sync-sb-row">' +
      icon('users', 16) +
      '<span class="sync-sb-text">Shared Brain pushes are managed in <strong>Shared Brain</strong>. This tab only reports them.</span>' +
      '<span class="mono sync-sb-meta">' + label + '</span>' +
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
        '<span>Disconnect this repository? Your local wiki files stay exactly as they are — only the sync ' +
        'connection is removed. You can reconnect any time.</span>' +
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

function describeResult(kind, data) {
  if (kind === 'push') {
    if (data.pushed === false) return data.message || 'Everything is already up to date.';
    return 'Pushed ' + (data.filesChanged || 0) + ' file' + (data.filesChanged === 1 ? '' : 's') + ' to GitHub.';
  }
  if (kind === 'pull') {
    return 'Pulled ' + (data.filesChanged || 0) + ' file' + (data.filesChanged === 1 ? '' : 's') + ' from GitHub.';
  }
  return 'Sync complete.';
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
