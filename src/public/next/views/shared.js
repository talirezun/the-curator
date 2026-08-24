// View: Shared Brain — "your team's brain". A collective wiki a cohort
// writes together.
//
// DESIGN DECISION (per the design handoff's ARCHITECTURE.md, relayed
// mid-session — read this before touching the enable control):
// the shipping app enables Shared Brain from a button in Settings, then
// OPERATES it from the Sync tab — one feature, two homes, with the enable
// button framing an entire product tier as a preference. In this shell
// Shared Brain is a rail peer between Domains and Agent memory because it
// IS the second tier (your brain → your team's brain → your agents' brain),
// so the enable control lives HERE, not in Settings. The governing rule:
// "You configure sharing in Shared Brain. You observe it in Sync." —
// sync.js already renders one reporting row (renderSharedBrainRow) that
// links back to this view via navigate('shared'); that file is untouched.
//
// Backend used (all pre-existing — see src/routes/sharedbrain.js,
// src/brain/sharedbrain.js, src/brain/sharedbrain-config.js):
//   GET  /api/sharedbrain/feature-flag                → {enabled}
//   POST /api/sharedbrain/enable-flag                 → {enabled}
//   GET  /api/sharedbrain/list                         → {connections} (masked; each carries pending_pages)
//   POST /api/sharedbrain/:id/push | /pull | /synthesize   → SSE stream
//   POST /api/sharedbrain/:id/unskip                    → {ok, unskipped, permanent_skip}
//   GET  /api/sharedbrain/:id/members                   → {members, self_fellow_id}
//   DELETE /api/sharedbrain/:id                          → {removed} ("Leave")
// Plus one read-only call, used only for the lazy "Cohort & sharing
// details" panel — see the honesty notes below:
//   GET  /api/domains/:domain/stats                     → real local page counts for the shared-<slug> mirror
//
// SCOPE: this file builds the CONNECTED state and the flag states. The
// five-step setup wizard itself — the highest-risk surface in this view,
// since it holds a GitHub PAT and a Shared Brain admin token — lives in
// its own module, views/shared-brain-wizard.js, ported verbatim from the
// shipping app's #sharedbrain-wizard (src/public/index.html + app.js) and
// only restyled here. See that file's own header for the full behaviour
// contract (link-population-on-entry, monotonic debounce guards, the
// admin-token-survives-regenerate rule, the credential-never-persisted-
// outside-module-state discipline, etc.) — every rule there is a real bug
// fixed in the shipping wizard and must not regress. This file's own job
// is limited to: opening the wizard from the two CTA entry points (below,
// "I have an invite token" / "Start a new Shared Brain", both on the
// empty state AND as "+ Join another" / "+ Set up another" once
// connections exist — mirroring the shipping app's sharedbrain-join-btn/
// -join-btn-2 and sharedbrain-create-btn/-create-btn-2 pattern), refreshing
// the connection list once the wizard reports a real save, and closing any
// open wizard when this view is torn down (closeSharedBrainWizardIfOpen in
// the onEnter teardown below) so navigating away can never leave a
// credential-holding overlay mounted behind the next view.
//
// HONESTY NOTES — every one of these was checked against the real backend
// before being rendered, per the "never render a fabricated value" rule.
// The design's connected-state wishlist (contributor count, shared page
// count, attribution share, synthesis schedule, per-domain opt-in toggles,
// a cost estimate on the pending-contribution notice, export, leave) was
// mapped item-by-item:
//   - Contributor count + your attribution share: REAL, computed from
//     GET /:id/members (groupMembers) — total submitters and this
//     connection's own fellow_id's share of total contributed pages.
//   - Shared page count: REAL, but only "as of your last pull" — sourced
//     from GET /api/domains/:domain/stats on the local shared-<slug>
//     mirror (the same page-count numbers Domains/Health already trust).
//     There is no endpoint that reports the live remote collective page
//     count without actually pulling, so a domain that has never been
//     pulled shows "not pulled yet", never a guessed number.
//   - Leave: REAL — DELETE /:id.
//   - Export: NOT AVAILABLE. Grepped every route in sharedbrain.js — there
//     is no export endpoint anywhere in this feature. Rendered as an
//     honest "not available yet" line, no button.
//   - Synthesis schedule: NOT AVAILABLE — there is no scheduler anywhere
//     in the codebase; synthesis is always admin-triggered. Rendered as
//     "no automatic schedule", never an invented cadence.
//   - Per-domain opt-in toggles: STRUCTURALLY BLOCKED, not merely
//     unbuilt. POST /save is a full-replace write, and
//     sharedbrain-config.js's validateConnection deliberately REFUSES a
//     PAT ending in the masking ellipsis — which is exactly what
//     GET /list returns. A client that reads the masked list and saves it
//     back cannot round-trip; the refusal is an intentional v3.0.5
//     credential defence, not a gap to work around. Rendered as a
//     read-only list with an explicit note — no editing UI, no attempt to
//     smuggle the real PAT through this shell (which doesn't handle
//     credentials outside the setup wizard on purpose).
//   - Cost estimate on the pending-contribution notice: NOT AVAILABLE —
//     grepped sharedbrain.js/sharedbrain.js routes for estimate/cost
//     helpers (the pattern ingest.js and Health's AI tools use); none
//     exist for Push or Synthesize. The pending count itself is real
//     (server-computed, mtime-based); the missing cost is stated
//     explicitly rather than silently absent.
//
// Push and Synthesize both call the local LLM (delta generation /
// conflict resolution) and so are genuinely token-spending — per the
// design rule "the sparkles mark is reserved for token-spending actions
// and nothing else", they get icon('sparkles'), and — because no cost
// figure exists to put in the button — an inline confirm before either
// runs that says exactly what will happen and that nothing has been sent
// yet (the design's cost-before-action trust mechanism, minus a dollar
// figure this backend cannot supply). Pull spends no tokens (writes are
// local file I/O only) — icon('refresh'), no confirm gate, matching how
// Health's own free/local operations are gated in domains.js.
//
// Invariants carried over from sync.js / ingest.js (see their own header
// comments for the bugs each one closes):
//   - Mount-token discipline throughout; `state` is reassigned wholesale
//     on every onEnter (state = freshState()), so per-connection async
//     work captures its own `card` object reference (from state.cards at
//     call time) rather than re-reading state.cards[id] after an await —
//     an abandoned mount's continuation then mutates a detached object
//     that no live render() ever reads, by construction, the same shape
//     ingest.js's runIngest relies on for its own module-level `state`.
//   - card.acting stops a SECOND click on the SAME mount only — it lives
//     in state.cards, which freshState() wipes on every onEnter, so it
//     cannot detect "this connection has an operation running that a
//     DIFFERENT (possibly abandoned) mount started". An earlier version
//     of this file argued Push and Synthesize didn't need the write gate
//     because neither writes to a LOCAL domain — that claim is true but
//     was the WRONG test: it is not the gate's criterion, and it left
//     card.acting as the only defence for those two actions, which an
//     adversarial audit reproduced as a real double-fire (push → navigate
//     away → back → push again → two concurrent POSTs, two real LLM delta
//     runs, last-writer-wins on last_push_at/pending_retry). The fix is
//     to register ALL THREE operations with the write gate, keyed
//     EXACTLY the way the backend's own registerWrite calls key them
//     (routes/sharedbrain.js): Push against every domain in
//     connection.local_domains (one release per domain, all released in
//     `finally`); Pull and Synthesize both against the local
//     shared-<slug> mirror domain (routes/sharedbrain.js's synthesize
//     handler registers there too, with an in-code comment explaining why
//     — "a restart/update mid-run would leave the collective
//     half-written with contributions consumed" — the same reasoning
//     applies to a second, concurrent client-side Synthesize). Client and
//     server then agree about what counts as busy, instead of the shell
//     inventing its own, narrower test. See domainsForAction() below —
//     it is the single place this key choice is made, so the mapping to
//     the backend can't drift between the click guard, the render-time
//     disabled state, and the acquire/release calls.
//   - Two independent guards close the race, deliberately: startAction()
//     checks isDomainWriteBusy() BEFORE calling runSseAction() (closes
//     the click), and runSseAction() checks it again as its own first
//     statement, before acquiring any handle (closes the async-gap
//     variant — two clicks arriving in the same tick, before either
//     handle exists yet). Losing either guard still leaves the other.
//   - Terminal status always beats a stale "in progress" read: card.acting
//     is cleared in the SAME synchronous block that sets the final
//     message (both happen before the single render() call in `finally`),
//     so there is no window where a render can show "still working" next
//     to an already-final result. The write-gate handles are released in
//     that same `finally`, unconditionally — success, error, or an
//     abandoned mount alike — so a failed operation can never leave a
//     domain permanently marked busy.
//   - GET /list stays cheap — no per-connection follow-up call rides on
//     it. The two supplementary reads (members, mirror stats) are fetched
//     lazily, only when a card's "Cohort & sharing details" panel is
//     opened, exactly mirroring domains.js's dismissed-records pattern
//     (state sentinel === null → "not loaded yet"; fetch on <details>
//     toggle, not on render).
//
// Owns views/shared.css.

import {
  registerView, setSidebar, setMain, eyebrow, emptyCard, escapeHtml, icon,
  isCurrentMount, reportAsyncMountFailure, reportAsyncActionFailure,
  beginDomainWrite, isDomainWriteBusy, getDomainWriteLabel, onWriteGateChange,
} from '../app.js';
import { openSharedBrainWizard, closeSharedBrainWizardIfOpen } from './shared-brain-wizard.js';

function freshState() {
  return {
    loading: true,        // still resolving feature-flag (+ connections, if enabled)
    enabled: false,
    flagError: null,
    enabling: false,
    enableError: null,

    connections: [],       // GET /list — masked; each carries pending_pages
    listError: null,

    cards: {},              // connection id -> ensureCard() shape, below
    expandedSkips: new Set(),
    expandedCohort: new Set(),
  };
}

let state = freshState();

// Same discipline as sync.js/ingest.js — see the file-header comment above.
let myMountToken = 0;
let unsubscribeWriteGate = null;

function ensureCard(id) {
  if (!state.cards[id]) {
    state.cards[id] = {
      acting: null,               // null | 'push' | 'pull' | 'synthesize' | 'unskip' | 'leave'
      message: null,
      error: false,
      pushConfirmOpen: false,
      synthesizeConfirmOpen: false,
      leaveConfirmOpen: false,
      cohort: null,                // null = not loaded | 'loading' | {members, selfFellowId, mirrorStats} | {error}
    };
  }
  return state.cards[id];
}

function findConnection(id) {
  return state.connections.find((c) => c.id === id) || null;
}

function mirrorDomainFor(conn) {
  return conn && typeof conn.shared_brain_slug === 'string' && conn.shared_brain_slug
    ? 'shared-' + conn.shared_brain_slug
    : null;
}

// The write-gate domain key(s) for one action on one connection — mirrors
// routes/sharedbrain.js's own registerWrite() calls exactly, so the
// client and server agree about what counts as busy (see the file-header
// comment). Push registers per CONTRIBUTING domain (routes/sharedbrain.js
// registers `d` for every domain in domainsToPush); Pull and Synthesize
// both register the local shared-<slug> mirror (routes/sharedbrain.js
// registers `shared-${slug}` for both — Synthesize's own in-code comment
// there explains why: a restart mid-run would strand the collective
// half-written with contributions already consumed). Always returns an
// array so every caller (acquire, release, the busy check) can treat
// Push and Pull/Synthesize identically without a branch of their own.
function domainsForAction(conn, action) {
  if (action === 'push') {
    return Array.isArray(conn && conn.local_domains) ? conn.local_domains.filter((d) => typeof d === 'string' && d) : [];
  }
  const mirror = mirrorDomainFor(conn);
  return mirror ? [mirror] : [];
}

registerView('shared', {
  onEnter(mountToken) {
    state = freshState();
    myMountToken = mountToken;
    render(mountToken);
    loadAll(mountToken).catch((err) => reportAsyncMountFailure(mountToken, err));

    // Re-render on any cross-view write-gate change — this is what keeps a
    // Pull button's "busy" note live (e.g. an abandoned prior mount's pull
    // is still finishing server-side; see the file-header comment).
    unsubscribeWriteGate = onWriteGateChange(() => {
      if (isCurrentMount(mountToken)) render(mountToken);
    });

    return () => {
      if (unsubscribeWriteGate) { unsubscribeWriteGate(); unsubscribeWriteGate = null; }
      // Never leave a credential-holding overlay mounted behind the next
      // view — see the file-header comment above.
      closeSharedBrainWizardIfOpen();
    };
  },
});

// ── Loading ──────────────────────────────────────────────────────────────

async function loadAll(token) {
  await loadFlag(token);
  if (!isCurrentMount(token)) return;
  if (state.enabled) await loadConnections(token);
  if (!isCurrentMount(token)) return;
  state.loading = false;
  render(token);
}

async function loadFlag(token) {
  try {
    const res = await fetch('/api/sharedbrain/feature-flag');
    const data = await res.json();
    if (!isCurrentMount(token)) return;
    state.enabled = !!data.enabled;
    state.flagError = null;
  } catch (err) {
    if (!isCurrentMount(token)) return;
    state.enabled = false;
    state.flagError = err.message;
  }
}

// Deliberately does not render itself — every caller renders once it has
// finished whatever else it also needed (same convention as sync.js's
// loadStatus). GET /list stays cheap: no per-connection network follow-up
// happens here — see the file-header comment.
async function loadConnections(token) {
  try {
    const res = await fetch('/api/sharedbrain/list');
    if (res.status === 404) {
      // Flag flipped off between our flag-check and this call (another
      // tab, or a race) — fall back to the disabled state rather than
      // surfacing a confusing 404 as an error.
      if (isCurrentMount(token)) { state.enabled = false; state.connections = []; state.listError = null; }
      return;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load Shared Brain connections.');
    if (!isCurrentMount(token)) return;
    const list = Array.isArray(data.connections) ? data.connections : [];
    const ids = new Set(list.map((c) => c.id));
    for (const id of Object.keys(state.cards)) if (!ids.has(id)) delete state.cards[id];
    for (const c of list) ensureCard(c.id);
    state.connections = list;
    state.listError = null;
  } catch (err) {
    if (!isCurrentMount(token)) return;
    state.listError = err.message;
  }
}

async function refreshConnections(token) {
  await loadConnections(token);
  if (isCurrentMount(token)) render(token);
}

// ── Render ───────────────────────────────────────────────────────────────

function render(token) {
  renderSidebar(token);
  renderMain(token);
  wireListeners(token);
}

function renderSidebar(token) {
  let body;
  if (state.loading) {
    body = '<div class="sidebar-note">Loading…</div>';
  } else if (!state.enabled) {
    body = '<div class="sidebar-note">Not enabled on this install.</div>';
  } else if (state.connections.length === 0) {
    body = '<div class="sidebar-note">No Shared Brains connected yet.</div>';
  } else {
    body =
      '<div class="cur-eyebrow" style="margin-top:2px">YOUR SHARED BRAINS</div>' +
      '<div class="sb-conn-list">' +
      state.connections.map((c) => {
        const pending = typeof c.pending_pages === 'number' ? c.pending_pages : 0;
        const stateLabel = c.read_only ? 'read-only' : (pending > 0 ? pending + ' pending' : 'up to date');
        return (
          '<div class="sb-conn-row">' +
            '<span class="sb-conn-dot' + (c.read_only ? ' sb-conn-dot-readonly' : '') + '"></span>' +
            '<span class="sb-conn-name mono">' + escapeHtml(c.label || '(unnamed)') + '</span>' +
            '<span class="sb-conn-state mono">' + escapeHtml(stateLabel) + '</span>' +
          '</div>'
        );
      }).join('') +
      '</div>';
  }

  setSidebar(
    '<div class="sidebar-title">Shared Brain<span class="sb-beta-pill">beta</span></div>' +
    '<div class="sidebar-hint">A collective wiki a cohort writes together. Contributors push synthesised ' +
    'summaries of the domains they opt in; the merged wiki comes back as a read-only mirror.</div>' +
    body,
    token
  );
}

function renderMain(token) {
  let body;
  if (state.loading) {
    body = '<p class="view-body">Loading Shared Brain status…</p>';
  } else if (state.flagError) {
    body = '<div class="settings-inline-error">Could not reach the Shared Brain feature flag: ' + escapeHtml(state.flagError) + '</div>';
  } else if (!state.enabled) {
    body = renderDisabled();
  } else {
    body = renderEnabled();
  }

  setMain(
    eyebrow('your team’s brain') +
    '<h1 class="view-title">Shared Brain</h1>' +
    '<div class="view-body">A Shared Brain is a collective wiki a cohort writes together. Contributors push ' +
    'synthesised summaries of the domains they opt in; the merged wiki comes back as a read-only mirror. Nothing ' +
    'else on your machine moves.</div>' +
    body,
    token
  );
}

function renderDisabled() {
  return (
    '<div class="sb-enable-card">' +
      '<div class="sb-enable-title">Shared Brain is off on this install</div>' +
      '<p class="settings-hint-text">Turning it on doesn’t connect you to anything by itself — it just unlocks ' +
      'this view so you can join a cohort with an invite token, or set one up for others to join. Nothing is sent ' +
      'anywhere until you push a domain to a Shared Brain you’ve configured.</p>' +
      (state.enableError ? '<div class="settings-inline-error">' + escapeHtml(state.enableError) + '</div>' : '') +
      '<button type="button" class="btn btn-primary" id="btn-sb-enable"' + (state.enabling ? ' disabled' : '') + '>' +
        (state.enabling ? 'Enabling…' : 'Enable Shared Brain (beta)') +
      '</button>' +
    '</div>'
  );
}

function renderEnabled() {
  if (state.listError) {
    return (
      '<div class="settings-inline-error">Could not load your Shared Brain connections: ' + escapeHtml(state.listError) + '</div>' +
      '<button type="button" class="btn btn-secondary" id="btn-sb-retry-list" style="margin-top:10px">Try again</button>'
    );
  }
  if (state.connections.length === 0) {
    return (
      '<div class="sb-cta-row">' +
        '<div class="sb-cta-card">' +
          '<div class="sb-cta-content">' +
            '<h4 class="sb-cta-title">' + icon('users', 16) + ' I have an invite token</h4>' +
            '<p class="sb-cta-desc">From my cohort, team, or research group.</p>' +
          '</div>' +
          '<button type="button" class="btn btn-primary" id="btn-sb-join">Join →</button>' +
        '</div>' +
        '<div class="sb-cta-card">' +
          '<div class="sb-cta-content">' +
            '<h4 class="sb-cta-title">' + icon('sparkles', 16) + ' I’m starting a new Shared Brain</h4>' +
            '<p class="sb-cta-desc">Set one up for my cohort or team.</p>' +
          '</div>' +
          '<button type="button" class="btn btn-secondary" id="btn-sb-create">Set up →</button>' +
        '</div>' +
      '</div>'
    );
  }
  return (
    '<div class="sb-cards">' + state.connections.map(renderCard).join('') + '</div>' +
    '<div class="sb-add-more">' +
      '<button type="button" class="btn btn-secondary" id="btn-sb-join-2">+ Join another</button>' +
      '<button type="button" class="btn btn-secondary" id="btn-sb-create-2">+ Set up another</button>' +
    '</div>'
  );
}

function formatRelativeTime(iso, neverLabel) {
  if (!iso) return neverLabel;
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return neverLabel;
  const diffMs = Date.now() - then.getTime();
  if (diffMs < 60000) return 'just now';
  const min = Math.floor(diffMs / 60000);
  if (min < 60) return min + ' min ago';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + ' hr ago';
  const day = Math.floor(hr / 24);
  if (day < 30) return day + (day === 1 ? ' day ago' : ' days ago');
  return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function renderCard(conn) {
  const card = ensureCard(conn.id);
  const busy = !!card.acting;
  const readOnly = conn.read_only === true;
  const mirrorDomain = mirrorDomainFor(conn);

  // Cross-mount busy checks, one per action, keyed exactly like the
  // backend (domainsForAction() above). Pull and Synthesize share the
  // mirror-domain key on purpose — so does routes/sharedbrain.js — so
  // `mirrorBusy` legitimately gates both.
  const pushBusyDomain = !busy ? domainsForAction(conn, 'push').find((d) => isDomainWriteBusy(d)) : null;
  const mirrorBusy = !busy && !!mirrorDomain && isDomainWriteBusy(mirrorDomain);

  // Repo cell — link only for a real GitHub repo; local/other storage
  // types show a plain (non-clickable) label, matching the shipping app.
  const repoUrl = conn.storage_type === 'github' && conn.github_repo_owner && conn.github_repo_name
    ? 'https://github.com/' + conn.github_repo_owner + '/' + conn.github_repo_name
    : null;
  const repoLabel = conn.storage_type === 'github'
    ? conn.github_repo_owner + '/' + conn.github_repo_name
    : conn.storage_type === 'local'
    ? 'local: ' + (conn.local_storage_path || '')
    : (conn.storage_type || 'unknown storage');
  const repoCell = repoUrl
    ? '<a class="sb-card-repo mono" href="' + escapeHtml(repoUrl) + '" target="_blank" rel="noopener">' + escapeHtml(repoLabel) + '</a>'
    : '<span class="sb-card-repo mono">' + escapeHtml(repoLabel) + '</span>';

  const domainsLabel = Array.isArray(conn.local_domains) && conn.local_domains.length
    ? conn.local_domains.join(', ')
    : (readOnly ? '(none — read-only member)' : '(none configured)');

  const dataHandlingLabel = conn.data_handling_terms === 'organisational'
    ? 'Organisational — cohort owns the synthesised output'
    : 'You retain copyright in your own contributions';

  const pendingCount = typeof conn.pending_pages === 'number' ? conn.pending_pages : 0;
  const retryCount = conn.pending_retry && typeof conn.pending_retry === 'object' ? Object.keys(conn.pending_retry).length : 0;
  const skips = Array.isArray(conn.permanent_skip) ? conn.permanent_skip.filter((p) => typeof p === 'string') : [];

  const fellowShort = (conn.fellow_id || '').slice(0, 8);

  return (
    '<div class="sb-card" data-conn-id="' + escapeHtml(conn.id) + '">' +
      '<div class="sb-card-header">' +
        '<h3 class="sb-card-title">' + escapeHtml(conn.label || '(unnamed)') +
          (readOnly ? '<span class="sb-pill-readonly">' + icon('lock', 11) + ' read-only member</span>' : '') +
        '</h3>' +
        repoCell +
      '</div>' +

      '<div class="sb-card-stats">' +
        '<span><span class="sb-card-stat-label">Last pushed</span><span class="mono">' + escapeHtml(formatRelativeTime(conn.last_push_at, 'never')) + '</span></span>' +
        '<span><span class="sb-card-stat-label">Last pulled</span><span class="mono">' + escapeHtml(formatRelativeTime(conn.last_pull_at, 'never')) + '</span></span>' +
        '<span><span class="sb-card-stat-label">Last synthesis</span><span class="mono">' + escapeHtml(formatRelativeTime(conn.last_synthesis_at, 'never — ask your admin to run synthesis')) + '</span></span>' +
        '<span><span class="sb-card-stat-label">Domains</span><span class="mono">' + escapeHtml(domainsLabel) + '</span></span>' +
        '<span><span class="sb-card-stat-label">Data handling</span><span>' + escapeHtml(dataHandlingLabel) + '</span></span>' +
      '</div>' +

      (!readOnly && (pendingCount > 0 || retryCount > 0)
        ? '<div class="sb-card-pending">' + icon('alertTriangle', 13) +
          '<span>' +
            (pendingCount > 0 ? '<span class="mono">' + pendingCount + '</span> page' + (pendingCount === 1 ? '' : 's') + ' ready to push' : '') +
            (pendingCount > 0 && retryCount > 0 ? ' · ' : '') +
            (retryCount > 0 ? '<span class="mono">' + retryCount + '</span> queued for automatic retry' : '') +
          '</span>' +
          '<span class="sb-card-pending-note">(no cost estimate available for Shared Brain pushes yet)</span>' +
        '</div>'
        : '') +

      (pushBusyDomain
        ? '<div class="sb-card-busy-note">' + icon('alertTriangle', 13) +
          '<span>A write (' + escapeHtml(getDomainWriteLabel(pushBusyDomain) || 'write') + ') is already running for <span class="mono">' +
          escapeHtml(pushBusyDomain) + '</span> — Push is disabled until it finishes.</span></div>'
        : '') +

      (mirrorBusy
        ? '<div class="sb-card-busy-note">' + icon('alertTriangle', 13) +
          '<span>A write (' + escapeHtml(getDomainWriteLabel(mirrorDomain) || 'write') + ') is already running for <span class="mono">' +
          escapeHtml(mirrorDomain) + '</span> — Pull and Synthesize are disabled until it finishes.</span></div>'
        : '') +

      renderActions(conn, card, busy, readOnly, pushBusyDomain, mirrorBusy) +

      (skips.length > 0 ? renderSkips(conn, card) : '') +

      renderCohort(conn, card) +

      (card.message ? '<div class="sb-card-status' + (card.error ? ' error' : '') + '" aria-live="polite">' + escapeHtml(card.message) + '</div>' : '') +

      (mirrorDomain ? '<p class="sb-card-note">Pulled content appears as the read-only domain <span class="mono">' + escapeHtml(mirrorDomain) + '</span> in the Domains tab.</p>' : '') +

      '<div class="sb-card-footer">' +
        '<span class="sb-fellow-pill mono">fellow ' + escapeHtml(fellowShort) + '…</span>' +
        (card.leaveConfirmOpen
          ? '<div class="sb-confirm-inline">' +
              '<span>Leave this Shared Brain? Your local wiki files stay exactly as they are, including the read-only ' +
              (mirrorDomain ? '<span class="mono">' + escapeHtml(mirrorDomain) + '</span> mirror' : 'mirror domain') +
              ' — only the sync connection is removed from this machine. This does not remove you as a GitHub ' +
              'collaborator on the repo; ask the admin for that. You can rejoin any time with a new invite token.</span>' +
              '<div class="sb-confirm-actions">' +
                '<button type="button" class="btn btn-secondary btn-xs" data-sb-action="leave-confirm"' + (busy ? ' disabled' : '') + '>' +
                  (card.acting === 'leave' ? 'Leaving…' : 'Leave') +
                '</button>' +
                '<button type="button" class="btn btn-ghost btn-xs" data-sb-action="leave-cancel">Cancel</button>' +
              '</div>' +
            '</div>'
          : '<button type="button" class="sb-leave-link" data-sb-action="leave-open"' + (busy ? ' disabled' : '') + '>Leave this Shared Brain</button>') +
      '</div>' +
    '</div>'
  );
}

// pushBusyDomain: the contributing domain (a string) another mount's Push
// is running against, or null. mirrorBusy: is the shared-<slug> mirror
// domain busy from another mount's Pull OR Synthesize — the two share a
// key on purpose, see domainsForAction()'s own comment.
function renderActions(conn, card, busy, readOnly, pushBusyDomain, mirrorBusy) {
  const pushDisabled = busy || !!pushBusyDomain;
  const pullSynthDisabled = busy || mirrorBusy;
  let html = '<div class="sb-card-actions">';

  if (!readOnly) {
    if (card.pushConfirmOpen) {
      html += renderPushConfirm(conn, pushDisabled);
    } else {
      html += '<button type="button" class="btn btn-primary" data-sb-action="push-open"' + (pushDisabled ? ' disabled' : '') +
        (pushBusyDomain ? ' title="Another write is already running for a contributing domain."' : '') + '>' +
        icon('sparkles', 14) + ' ' + (card.acting === 'push' ? 'Pushing…' : 'Push contributions') + '</button>';
    }
  }

  html += '<button type="button" class="btn btn-secondary" data-sb-action="pull"' + (pullSynthDisabled ? ' disabled' : '') +
    (mirrorBusy ? ' title="Another write is already running for this mirror domain."' : '') + '>' +
    icon('refresh', 14) + ' ' + (card.acting === 'pull' ? 'Pulling…' : 'Pull updates') + '</button>';

  if (!readOnly) {
    if (card.synthesizeConfirmOpen) {
      html += renderSynthesizeConfirm(pullSynthDisabled);
    } else {
      html += '<button type="button" class="btn btn-ghost" data-sb-action="synthesize-open"' + (pullSynthDisabled ? ' disabled' : '') +
        (mirrorBusy ? ' title="Another write is already running for this mirror domain."' : '') + '>' +
        icon('sparkles', 14) + ' ' + (card.acting === 'synthesize' ? 'Synthesizing…' : 'Run synthesis (admin)') + '</button>';
    }
  }

  html += '</div>';
  return html;
}

function renderPushConfirm(conn, busy) {
  const domains = Array.isArray(conn.local_domains) && conn.local_domains.length ? conn.local_domains.join(', ') : '(no domains configured)';
  const pendingCount = typeof conn.pending_pages === 'number' ? conn.pending_pages : 0;
  return (
    '<div class="sb-confirm-inline sb-confirm-block">' +
      '<span>Push will scan <span class="mono">' + escapeHtml(domains) + '</span> for pages changed since your last push ' +
      '(currently <span class="mono">' + pendingCount + '</span> pending), summarise each with your configured AI provider ' +
      '— this spends API credits, and Shared Brain pushes don’t have a cost estimate yet — then send the summaries to the ' +
      'shared repository. Nothing has been sent yet.</span>' +
      '<div class="sb-confirm-actions">' +
        '<button type="button" class="btn btn-primary btn-xs" data-sb-action="push-confirm"' + (busy ? ' disabled' : '') + '>Push contributions</button>' +
        '<button type="button" class="btn btn-ghost btn-xs" data-sb-action="push-cancel">Cancel</button>' +
      '</div>' +
    '</div>'
  );
}

function renderSynthesizeConfirm(busy) {
  return (
    '<div class="sb-confirm-inline sb-confirm-block">' +
      '<span>Synthesis merges every pending contributor submission into the collective wiki, using your AI provider to ' +
      'resolve any conflicting facts — this spends API credits, and Shared Brain synthesis doesn’t have a cost estimate ' +
      'yet. It’s usually run by the brain admin, weekly or after a batch of pushes. Nothing has been written yet.</span>' +
      '<div class="sb-confirm-actions">' +
        '<button type="button" class="btn btn-primary btn-xs" data-sb-action="synthesize-confirm"' + (busy ? ' disabled' : '') + '>Run synthesis</button>' +
        '<button type="button" class="btn btn-ghost btn-xs" data-sb-action="synthesize-cancel">Cancel</button>' +
      '</div>' +
    '</div>'
  );
}

function renderSkips(conn, card) {
  const skips = conn.permanent_skip.filter((p) => typeof p === 'string');
  const open = state.expandedSkips.has(conn.id);
  const busy = !!card.acting;
  return (
    '<details class="sb-card-skips"' + (open ? ' open' : '') + ' data-sb-skips="' + escapeHtml(conn.id) + '">' +
      '<summary>' + icon('alertTriangle', 13) + ' <span class="mono">' + skips.length + '</span> page' + (skips.length === 1 ? '' : 's') + ' skipped after repeated failures</summary>' +
      '<ul class="sb-card-skips-list mono">' + skips.map((p) => '<li>' + escapeHtml(p) + '</li>').join('') + '</ul>' +
      '<button type="button" class="btn btn-secondary btn-xs" data-sb-action="unskip"' + (busy ? ' disabled' : '') + '>' +
        (card.acting === 'unskip' ? 'Re-queuing…' : 'Retry these pages on next push') +
      '</button>' +
    '</details>'
  );
}

function renderCohort(conn, card) {
  const open = state.expandedCohort.has(conn.id);
  const c = card.cohort;

  let networkBody;
  if (c === null) {
    networkBody = '<div class="sb-card-cohort-row sb-card-cohort-note">Opens on first view…</div>';
  } else if (c === 'loading') {
    networkBody = '<div class="sb-card-cohort-row sb-card-cohort-note">Loading…</div>';
  } else if (c.error) {
    networkBody = '<div class="sb-card-cohort-row sb-card-cohort-note">Could not load: ' + escapeHtml(c.error) + '</div>';
  } else {
    const members = c.members || [];
    const total = members.reduce((n, m) => n + (m.pages || 0), 0);
    const self = c.selfFellowId ? members.find((m) => m.fellow_id === c.selfFellowId) : null;
    const selfPages = self ? (self.pages || 0) : 0;
    const attributionText = total > 0
      ? '<span class="mono">' + selfPages + ' of ' + total + '</span> pages (<span class="mono">' + Math.round((selfPages / total) * 100) + '%</span>)'
      : 'no contributions yet';

    let mirrorLine;
    if (conn.storage_type && !c.mirrorStats) {
      mirrorLine = 'not pulled yet';
    } else if (c.mirrorStats === 'not-pulled') {
      mirrorLine = 'not pulled yet';
    } else if (c.mirrorStats && typeof c.mirrorStats.pageCount === 'number') {
      mirrorLine = '<span class="mono">' + c.mirrorStats.pageCount + '</span> pages (as of your last pull)';
    } else {
      mirrorLine = 'not available';
    }

    networkBody =
      '<div class="sb-card-cohort-row"><span class="sb-card-stat-label">Contributors</span><span class="mono">' + members.length + '</span></div>' +
      '<div class="sb-card-cohort-row"><span class="sb-card-stat-label">Your attribution</span><span>' + attributionText + '</span></div>' +
      '<div class="sb-card-cohort-row"><span class="sb-card-stat-label">Shared pages</span><span>' + mirrorLine + '</span></div>';
  }

  return (
    '<details class="sb-card-cohort"' + (open ? ' open' : '') + ' data-sb-cohort="' + escapeHtml(conn.id) + '">' +
      '<summary>Cohort &amp; sharing details</summary>' +
      '<div class="sb-card-cohort-body">' +
        networkBody +
        '<div class="sb-card-cohort-row sb-card-cohort-note">Which domains contribute is read-only here — changing it needs your access token re-entered, which this preview shell doesn’t handle outside the setup wizard yet.</div>' +
        '<div class="sb-card-cohort-row sb-card-cohort-note">No automatic synthesis schedule — it’s triggered manually, usually by the brain admin.</div>' +
        '<div class="sb-card-cohort-row sb-card-cohort-note">Exporting your Shared Brain data isn’t available in this build yet.</div>' +
      '</div>' +
    '</details>'
  );
}

// ── Listeners ─────────────────────────────────────────────────────────────

function wireListeners(token) {
  document.getElementById('btn-sb-enable')?.addEventListener('click', () => onEnableFlag(token));
  document.getElementById('btn-sb-retry-list')?.addEventListener('click', () => { refreshConnections(token); });

  // Wizard entry points — both the empty-state CTAs and the "+ Join
  // another" / "+ Set up another" row once connections exist. onSaved
  // refreshes the connection list the same way any other mutation here
  // does (refreshConnections re-checks isCurrentMount internally).
  const openJoin = () => openSharedBrainWizard('join', { onSaved: () => refreshConnections(token) });
  const openCreate = () => openSharedBrainWizard('create', { onSaved: () => refreshConnections(token) });
  document.getElementById('btn-sb-join')?.addEventListener('click', openJoin);
  document.getElementById('btn-sb-create')?.addEventListener('click', openCreate);
  document.getElementById('btn-sb-join-2')?.addEventListener('click', openJoin);
  document.getElementById('btn-sb-create-2')?.addEventListener('click', openCreate);

  document.querySelectorAll('.sb-card[data-conn-id]').forEach((cardEl) => {
    const connId = cardEl.dataset.connId;
    cardEl.querySelectorAll('button[data-sb-action]').forEach((btn) => {
      btn.addEventListener('click', () => onCardButton(token, connId, btn.dataset.sbAction));
    });
  });

  document.querySelectorAll('.sb-card-skips[data-sb-skips]').forEach((el) => {
    el.addEventListener('toggle', () => {
      const id = el.dataset.sbSkips;
      if (el.open) state.expandedSkips.add(id); else state.expandedSkips.delete(id);
    });
  });

  document.querySelectorAll('.sb-card-cohort[data-sb-cohort]').forEach((el) => {
    el.addEventListener('toggle', () => {
      const id = el.dataset.sbCohort;
      if (el.open) {
        state.expandedCohort.add(id);
        const card = ensureCard(id);
        if (card.cohort === null) loadCohortDetails(token, id).catch(reportAsyncActionFailure);
      } else {
        state.expandedCohort.delete(id);
      }
    });
  });
}

function onCardButton(token, connId, action) {
  const card = ensureCard(connId);
  switch (action) {
    case 'push-open': card.pushConfirmOpen = true; render(token); return;
    case 'push-cancel': card.pushConfirmOpen = false; render(token); return;
    case 'push-confirm': card.pushConfirmOpen = false; startAction(token, connId, 'push'); return;
    case 'pull': startAction(token, connId, 'pull'); return;
    case 'synthesize-open': card.synthesizeConfirmOpen = true; render(token); return;
    case 'synthesize-cancel': card.synthesizeConfirmOpen = false; render(token); return;
    case 'synthesize-confirm': card.synthesizeConfirmOpen = false; startAction(token, connId, 'synthesize'); return;
    case 'unskip': onUnskip(token, connId); return;
    case 'leave-open': card.leaveConfirmOpen = true; render(token); return;
    case 'leave-cancel': card.leaveConfirmOpen = false; render(token); return;
    case 'leave-confirm': onLeave(token, connId); return;
    default: return;
  }
}

// ── Actions ───────────────────────────────────────────────────────────────

// First of two independent guards against a double-run — see the
// file-header comment. This one closes the click: card.acting catches a
// second click on THIS mount; the isDomainWriteBusy check catches a
// click on a DIFFERENT (possibly abandoned) mount whose own operation is
// still running against the same backend-keyed domain(s). The second
// guard, inside runSseAction itself, closes the remaining gap where two
// clicks race through this function before either has acquired a handle.
function startAction(token, connId, kind) {
  const card = ensureCard(connId);
  if (card.acting) {
    card.message = 'An operation is already running on this connection — wait for it to finish.';
    card.error = true;
    render(token);
    return;
  }
  const conn = findConnection(connId);
  const busyDomain = domainsForAction(conn, kind).find((d) => isDomainWriteBusy(d));
  if (busyDomain) {
    card.message = 'A write (' + (getDomainWriteLabel(busyDomain) || 'write') + ') is already running for ' + busyDomain + ' — wait for it to finish.';
    card.error = true;
    render(token);
    return;
  }
  runSseAction(token, connId, kind).catch(reportAsyncActionFailure);
}

function composeDoneMessage(action, payload, lastMessage) {
  if (payload && typeof payload.message === 'string' && payload.message) return payload.message;
  const r = payload && payload.result;
  if (r && typeof r === 'object') {
    if (typeof r.message === 'string' && r.message) return r.message;
    if (action === 'pull' && 'created' in r) {
      return 'Pull complete: ' + r.created + ' new, ' + r.updated + ' updated' +
        ('unchanged' in r ? ', ' + r.unchanged + ' unchanged' : '') +
        (r.pruned > 0 ? ', ' + r.pruned + ' removed' : '') +
        (r.skipped > 0 ? ', ' + r.skipped + ' skipped' : '') + '.';
    }
    if (action === 'synthesize' && 'pages_written' in r) {
      let m = 'Synthesis complete: ' + r.pages_written + ' page' + (r.pages_written === 1 ? '' : 's') + ' written' +
        ('processed_contributions' in r ? ' from ' + r.processed_contributions + ' contribution' + (r.processed_contributions === 1 ? '' : 's') : '');
      if (r.conflicts > 0) {
        m += ', ' + r.conflicts + ' conflict' + (r.conflicts === 1 ? '' : 's') + ' flagged';
        if (Array.isArray(r.conflict_pages) && r.conflict_pages.length > 0) {
          m += ' in ' + r.conflict_pages.slice(0, 5).join(', ') + (r.conflict_pages.length > 5 ? ' (+' + (r.conflict_pages.length - 5) + ' more)' : '');
        }
      }
      if (r.pages_failed > 0) m += ', ' + r.pages_failed + ' page' + (r.pages_failed === 1 ? '' : 's') + ' failed';
      return m + '.';
    }
  }
  return lastMessage || (action + ' completed.');
}

// Runs push/pull/synthesize as an SSE-streamed action against ONE
// connection. See the file-header comment for the mount/card-object-
// identity reasoning and the terminal-status-beats-pending invariant this
// is built to satisfy by construction.
async function runSseAction(token, connId, action) {
  const card = ensureCard(connId);
  if (card.acting) return; // defense in depth — see startAction's own guard

  const conn = findConnection(connId);
  const domains = domainsForAction(conn, action);
  // Second guard — see startAction's comment. Re-checked here (not just
  // trusted from the caller) because two clicks can both pass
  // startAction's check before either has reached this line and acquired
  // a handle; only ONE of them may proceed past this point.
  const busyDomain = domains.find((d) => isDomainWriteBusy(d));
  if (busyDomain) {
    card.message = 'A write (' + (getDomainWriteLabel(busyDomain) || 'write') + ') is already running for ' + busyDomain + ' — try again shortly.';
    card.error = true;
    render(token);
    return;
  }

  card.acting = action;
  card.message = 'Starting ' + action + '…';
  card.error = false;
  render(token);

  // Acquired for ALL THREE actions, keyed exactly like the backend's own
  // registerWrite calls (domainsForAction — see the file-header comment
  // for why this criterion, not "does it write locally", is the right
  // one). Push can touch several domains at once; every handle it took
  // is released below regardless of outcome.
  const releases = domains.map((d) => beginDomainWrite(d, 'sharedbrain-' + action));

  let hadError = false;
  try {
    const res = await fetch('/api/sharedbrain/' + connId + '/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/event-stream')) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || (action + ' failed (HTTP ' + res.status + ')'));
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let finalPayload = null;
    let lastMessage = card.message;

    try {
      outer: for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const events = buf.split('\n\n');
        buf = events.pop();
        for (const ev of events) {
          if (!ev.startsWith('data:')) continue;
          let payload;
          try { payload = JSON.parse(ev.slice(5).trim()); } catch { continue; }
          if (payload.type === 'error') {
            hadError = true;
            card.message = 'Error: ' + payload.message;
            card.error = true;
            if (isCurrentMount(token)) render(token);
          } else if (payload.type === 'done') {
            finalPayload = payload;
            break outer;
          } else if (payload.message) {
            lastMessage = payload.message;
            card.message = lastMessage;
            card.error = false;
            if (isCurrentMount(token)) render(token);
          }
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }

    if (finalPayload) {
      card.message = composeDoneMessage(action, finalPayload, lastMessage);
      card.error = false;
    } else if (!hadError) {
      // Stream ended with neither a 'done' nor an 'error' frame — do not
      // report success for an outcome we never actually confirmed.
      hadError = true;
      card.message = action + ' ended unexpectedly with no result.';
      card.error = true;
    }
  } catch (err) {
    hadError = true;
    card.message = err.message;
    card.error = true;
  } finally {
    // Released unconditionally, every handle this call took — a
    // write-gate handle must not outlive the request just because this
    // mount was abandoned, or a domain would stay marked busy forever;
    // see the file-header comment (and ingest.js's identical reasoning).
    releases.forEach((r) => r());
    // card.message/card.error are already final at this point (set above,
    // in the same synchronous continuation) — clearing `acting` here means
    // the next render can never show "still working" beside a final
    // result (the "terminal beats pending" invariant, satisfied by
    // ordering rather than by a second flag to keep in sync).
    card.acting = null;
    if (isCurrentMount(token)) {
      render(token);
      if (!hadError) refreshConnections(token).catch(reportAsyncActionFailure);
    }
  }
}

async function onUnskip(token, connId) {
  const card = ensureCard(connId);
  if (card.acting) {
    card.message = 'An operation is already running on this connection — wait for it to finish.';
    card.error = true;
    render(token);
    return;
  }
  card.acting = 'unskip';
  card.message = 'Re-queuing skipped pages…';
  card.error = false;
  render(token);
  try {
    const res = await fetch('/api/sharedbrain/' + connId + '/unskip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok !== true) throw new Error(data.error || 'Could not re-queue skipped pages.');
    card.message = data.unskipped + ' page' + (data.unskipped === 1 ? '' : 's') + ' re-queued — they will be retried on the next push.';
    card.error = false;
  } catch (err) {
    card.message = err.message;
    card.error = true;
  } finally {
    card.acting = null;
    if (isCurrentMount(token)) {
      render(token);
      refreshConnections(token).catch(reportAsyncActionFailure);
    }
  }
}

async function onLeave(token, connId) {
  const card = ensureCard(connId);
  if (card.acting) return;
  card.acting = 'leave';
  render(token);
  try {
    const res = await fetch('/api/sharedbrain/' + connId, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not leave this Shared Brain.');
    delete state.cards[connId];
    state.connections = state.connections.filter((c) => c.id !== connId);
    if (isCurrentMount(token)) render(token);
  } catch (err) {
    card.acting = null;
    card.leaveConfirmOpen = false;
    card.message = err.message;
    card.error = true;
    if (isCurrentMount(token)) render(token);
  }
}

async function loadCohortDetails(token, connId) {
  const card = ensureCard(connId);
  if (card.cohort === 'loading') return;
  card.cohort = 'loading';
  render(token);

  const conn = findConnection(connId);
  const mirrorDomain = mirrorDomainFor(conn);

  try {
    const [membersRes, statsRes] = await Promise.all([
      fetch('/api/sharedbrain/' + connId + '/members'),
      mirrorDomain ? fetch('/api/domains/' + encodeURIComponent(mirrorDomain) + '/stats') : Promise.resolve(null),
    ]);
    const membersData = await membersRes.json().catch(() => ({}));
    if (!membersRes.ok) throw new Error(membersData.error || 'Could not load the contributor list.');

    let mirrorStats = 'not-pulled';
    if (statsRes) {
      if (statsRes.status === 404) mirrorStats = 'not-pulled';
      else if (statsRes.ok) mirrorStats = await statsRes.json().catch(() => 'not-pulled');
    }

    if (!isCurrentMount(token)) return;
    card.cohort = {
      members: Array.isArray(membersData.members) ? membersData.members : [],
      selfFellowId: membersData.self_fellow_id || null,
      mirrorStats,
    };
  } catch (err) {
    if (!isCurrentMount(token)) return;
    card.cohort = { error: err.message };
  } finally {
    if (isCurrentMount(token)) render(token);
  }
}

async function onEnableFlag(token) {
  if (state.enabling) return;
  state.enabling = true;
  state.enableError = null;
  render(token);
  try {
    const res = await fetch('/api/sharedbrain/enable-flag', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not enable Shared Brain.');
    if (!isCurrentMount(token)) return;
    state.enabled = !!data.enabled;
    if (state.enabled) await loadConnections(token);
  } catch (err) {
    if (isCurrentMount(token)) state.enableError = err.message;
  } finally {
    if (isCurrentMount(token)) { state.enabling = false; render(token); }
  }
}
