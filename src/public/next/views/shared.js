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
import { createLoadingGate, gatedLoader, settleGate } from '../shared/loading-gate.js';
// The ONE text system in /next (shared/text.js). The view header owns the
// eyebrow, the title and the info mark; it has NO parameter that renders a
// paragraph under the title, which is what this view used to do.
import { renderViewHeader, renderStatus } from '../shared/text.js';

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
    expandedAdmin: new Set(),
  };
}

let state = freshState();

// Same discipline as sync.js/ingest.js — see the file-header comment above.
let myMountToken = 0;

// Delay-gated loading indicator for this view's entry load. Built in
// onEnter, cancelled in the teardown. See shared/loading-gate.js.
let loadGate = null;
let unsubscribeWriteGate = null;

function ensureCard(id) {
  if (!state.cards[id]) {
    state.cards[id] = {
      acting: null,               // null | 'push' | 'pull' | 'synthesize' | 'unskip' | 'leave' | 'rotate' | 'revoke'
      message: null,
      error: false,
      pushConfirmOpen: false,
      synthesizeConfirmOpen: false,
      leaveConfirmOpen: false,
      cohort: null,                // null = not loaded | 'loading' | {members, selfFellowId, mirrorStats} | {error}

      // ── Admin controls (see the "Admin controls" section below) ────────
      // adminTokenProvisioned: a successful rotate makes the revoke
      // affordance appear WITHOUT re-reading GET /list. That is not a
      // convenience — it is the shown-once rule (CLAUDE.md v3.0.5: the
      // display "deliberately SKIPS the post-op list refresh … don't 'fix'
      // that by adding one"). In THIS architecture a refresh is worse than
      // in the shipping app's: loadConnections() can set state.listError,
      // and renderEnabled() then returns the error branch, which renders NO
      // CARDS AT ALL — the freshly-minted token would vanish from the
      // screen entirely. So the card learns "a token now exists" from this
      // local flag instead, and no refresh is issued.
      adminTokenProvisioned: false,
      // The one place a real admin token is ever held. Set only from the
      // rotate response, rendered only inside its own shown-once box,
      // cleared only when the admin explicitly presses Hide. Never written
      // to localStorage, a URL, or any other surface.
      shownAdminToken: null,
      rotateConfirmOpen: false,

      // ── Invite re-display (v3.0.5 §4.4) ───────────────────────────────
      // The invite token is NOT a credential — it is base64 of the
      // connection's own public metadata, deterministic, and designed to be
      // forwarded over Slack and email. It is held here purely so a
      // re-render redraws it instead of destroying it (same reason as
      // shownAdminToken, different reason for existing: that one is
      // shown-once because it is secret; this one is re-derivable at any
      // time and simply must not vanish mid-copy).
      inviteOpen: false,
      inviteToken: null,
      inviteLoading: false,
      inviteError: null,

      revokeOpen: false,
      revokeMembers: null,          // null = not loaded | 'loading' | {members, selfFellowId} | {error}
      revokeSelectedFellowId: null,
      revokeTyped: '',              // the typed confirmation — NOT a secret
      // BOOLEAN ONLY. The admin token itself lives in the password input in
      // the DOM and nowhere else; this records merely that something long
      // enough has been typed, so the unlock state survives a re-render.
      // runRevoke() re-reads the live input and refuses locally if it is
      // gone, so a stale `true` here can never produce a doomed request.
      revokeTokenPresent: false,
      revokeProgress: null,
      revokeOutcome: null,          // classifyRevokeOutcome() output
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
    loadGate = createLoadingGate({
      onChange: () => { if (isCurrentMount(mountToken)) render(mountToken); },
    });
    loadGate.begin();
    render(mountToken);
    loadAll(mountToken).catch((err) => reportAsyncMountFailure(mountToken, err));

    // Re-render on any cross-view write-gate change — this is what keeps a
    // Pull button's "busy" note live (e.g. an abandoned prior mount's pull
    // is still finishing server-side; see the file-header comment).
    unsubscribeWriteGate = onWriteGateChange(() => {
      if (isCurrentMount(mountToken)) render(mountToken);
    });

    return () => {
      // Timer hygiene (load-bearing): an armed delay timer that survives
      // this teardown would paint a loader into whatever view comes next.
      if (loadGate) { loadGate.cancel(); loadGate = null; }
      if (unsubscribeWriteGate) { unsubscribeWriteGate(); unsubscribeWriteGate = null; }
      // Never leave a credential-holding overlay mounted behind the next
      // view — see the file-header comment above.
      closeSharedBrainWizardIfOpen();
    };
  },
});

// ── Loading ──────────────────────────────────────────────────────────────

async function loadAll(token) {
  // Capture the gate for THIS call. `loadGate` is module-scoped and the
  // next mount replaces it, so settling the module variable from a stale
  // in-flight load would decrement the NEXT mount's counter and hide a
  // loader that is legitimately up. A cancelled gate ignores settle(), so
  // the stale path becomes a no-op instead.
  const gate = loadGate;
  await loadFlag(token);
  if (!isCurrentMount(token)) return;
  if (state.enabled) await loadConnections(token);
  if (!isCurrentMount(token)) return;
  settleGate(gate, () => {
    state.loading = false;
    render(token);
  });
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
    body = gatedLoader(loadGate, 'Loading…', 'sidebar-note');
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
            '<span class="sb-conn-name">' + escapeHtml(c.label || '(unnamed)') + '</span>' +
            '<span class="sb-conn-state">' + escapeHtml(stateLabel) + '</span>' +
          '</div>'
        );
      }).join('') +
      '</div>';
  }

  // CUT, not relocated: "Cohorts this install writes to." labelled the list
  // directly beneath it, which either names the cohorts or says "Not enabled
  // on this install." — so the label restated what the list already showed.
  // Hiding 30 characters behind a click would be worse than either keeping
  // or deleting them. It also sat in `.sidebar-hint`, which AT THE TIME
  // painted --text-3 (4.27 dark / 4.14 light, under the 4.5 AA floor). That
  // half is now historical: shell.css paints both sidebar empty-state roles
  // --text-2, so the cut rests on the duplication reason alone. The three
  // `.sidebar-note` lines below are the functional empty states that fix
  // covers — measured 8.45 dark / 6.79 light against --surface-inset.
  setSidebar(
    '<div class="sidebar-title">Shared Brain<span class="sb-beta-pill">beta</span></div>' +
    body,
    token
  );
}

function renderMain(token) {
  let body;
  if (state.loading) {
    body = gatedLoader(loadGate, 'Loading Shared Brain status…');
  } else if (state.flagError) {
    body = '<div class="settings-inline-error">Could not reach the Shared Brain feature flag: ' + escapeHtml(state.flagError) + '</div>';
  } else if (!state.enabled) {
    body = renderDisabled();
  } else {
    body = renderEnabled();
  }

  // RELOCATED, not cut: this is the only place the contribution model is
  // explained, and "Nothing else on your machine moves" is a privacy claim a
  // first-time reader needs once. It is not a warning and carries no cost or
  // irreversibility, so the fold is the right home for it.
  setMain(
    renderViewHeader({
      eyebrow: 'your team’s brain',
      title: 'Shared Brain',
      info: 'A Shared Brain is a collective wiki a cohort writes together. Contributors push '
          + 'synthesised summaries of the domains they opt in; the merged wiki comes back as a '
          + 'read-only mirror. Nothing else on your machine moves.',
    }) +
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
        '<span><span class="sb-card-stat-label">Last pushed</span><span class="sb-num">' + escapeHtml(formatRelativeTime(conn.last_push_at, 'never')) + '</span></span>' +
        '<span><span class="sb-card-stat-label">Last pulled</span><span class="sb-num">' + escapeHtml(formatRelativeTime(conn.last_pull_at, 'never')) + '</span></span>' +
        '<span><span class="sb-card-stat-label">Last synthesis</span><span class="sb-num">' + escapeHtml(formatRelativeTime(conn.last_synthesis_at, 'never — ask your admin to run synthesis')) + '</span></span>' +
        '<span><span class="sb-card-stat-label">Domains</span><span class="sb-name">' + escapeHtml(domainsLabel) + '</span></span>' +
        '<span><span class="sb-card-stat-label">Data handling</span><span>' + escapeHtml(dataHandlingLabel) + '</span></span>' +
      '</div>' +

      (!readOnly && (pendingCount > 0 || retryCount > 0)
        ? '<div class="sb-card-pending">' + icon('alertTriangle', 13) +
          '<span>' +
            (pendingCount > 0 ? '<span class="sb-num">' + pendingCount + '</span> page' + (pendingCount === 1 ? '' : 's') + ' ready to push' : '') +
            (pendingCount > 0 && retryCount > 0 ? ' · ' : '') +
            (retryCount > 0 ? '<span class="sb-num">' + retryCount + '</span> queued for automatic retry' : '') +
          '</span>' +
          '<span class="sb-card-pending-note">(no cost estimate available for Shared Brain pushes yet)</span>' +
        '</div>'
        : '') +

      (pushBusyDomain
        ? '<div class="sb-card-busy-note">' + icon('alertTriangle', 13) +
          '<span>A write (' + escapeHtml(getDomainWriteLabel(pushBusyDomain) || 'write') + ') is already running for <span class="sb-name">' +
          escapeHtml(pushBusyDomain) + '</span> — Push is disabled until it finishes.</span></div>'
        : '') +

      (mirrorBusy
        ? '<div class="sb-card-busy-note">' + icon('alertTriangle', 13) +
          '<span>A write (' + escapeHtml(getDomainWriteLabel(mirrorDomain) || 'write') + ') is already running for <span class="sb-name">' +
          escapeHtml(mirrorDomain) + '</span> — Pull and Synthesize are disabled until it finishes.</span></div>'
        : '') +

      renderActions(conn, card, busy, readOnly, pushBusyDomain, mirrorBusy) +

      (skips.length > 0 ? renderSkips(conn, card) : '') +

      renderCohort(conn, card) +

      renderAdmin(conn, card, busy, mirrorBusy) +

      (card.message ? '<div class="sb-card-status' + (card.error ? ' error' : '') + '" aria-live="polite">' + escapeHtml(card.message) + '</div>' : '') +

      (mirrorDomain ? '<p class="sb-card-note">Pulled content appears as the read-only domain <span class="sb-name">' + escapeHtml(mirrorDomain) + '</span> in the Domains tab.</p>' : '') +

      '<div class="sb-card-footer">' +
        '<span class="sb-fellow-pill mono">fellow ' + escapeHtml(fellowShort) + '…</span>' +
        (card.leaveConfirmOpen
          ? '<div class="sb-confirm-inline">' +
              '<span>Leave this Shared Brain? Your local wiki files stay exactly as they are, including the read-only ' +
              (mirrorDomain ? '<span class="sb-name">' + escapeHtml(mirrorDomain) + '</span> mirror' : 'mirror domain') +
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

  // ── WHY A CONTROL IS GREYED OUT IS NOW VISIBLE TEXT, NOT A TOOLTIP ─────
  // All three buttons below carried a `title=` explaining that another write
  // holds the domain — and each was set on exactly the condition that also
  // set `disabled`. A disabled button is removed from the tab order, so that
  // sentence could not be reached by keyboard at all, and on touch, where
  // there is no hover, it did not exist. It was also the ONLY place the
  // reason was written anywhere in this view: unlike settings.js, this card
  // has no equivalent of renderCrossWriteBanner.
  //
  // So it renders as a status box ABOVE the row, unfolded, for everyone.
  // That is the house rule this repo already applies to the same class of
  // message (settings.js's renderCrossWriteBanner) and the same rule
  // v3.22.0 used to keep a data-loss warning out from behind an info mark:
  // nothing that warns, costs money or is irreversible sits behind a
  // gesture. Push, Pull and Synthesize all spend tokens and write pages.
  //
  // ONE box, not three: the two conditions name different domains (a
  // contributing domain vs the shared-<slug> mirror — see domainsForAction),
  // so both are stated when both are true, but a card is one place and one
  // note there is easier to read than a note per button.
  const blocked = [];
  if (pushBusyDomain && !readOnly) blocked.push('a contributing domain');
  if (mirrorBusy) blocked.push('this Shared Brain’s mirror domain');
  const busyNote = blocked.length
    ? renderStatus({
        state: 'attention',
        title: 'Some actions are paused while another write finishes',
        detail: 'Another write is already running for ' + blocked.join(' and ') +
          '. The buttons below come back on their own when it finishes.',
      })
    : '';

  let html = busyNote + '<div class="sb-card-actions">';

  if (!readOnly) {
    if (card.pushConfirmOpen) {
      html += renderPushConfirm(conn, pushDisabled);
    } else {
      html += '<button type="button" class="btn btn-primary" data-sb-action="push-open"' + (pushDisabled ? ' disabled' : '') + '>' +
        icon('sparkles', 14) + ' ' + (card.acting === 'push' ? 'Pushing…' : 'Push contributions') + '</button>';
    }
  }

  html += '<button type="button" class="btn btn-secondary" data-sb-action="pull"' + (pullSynthDisabled ? ' disabled' : '') + '>' +
    icon('refresh', 14) + ' ' + (card.acting === 'pull' ? 'Pulling…' : 'Pull updates') + '</button>';

  if (!readOnly) {
    if (card.synthesizeConfirmOpen) {
      html += renderSynthesizeConfirm(pullSynthDisabled);
    } else {
      html += '<button type="button" class="btn btn-ghost" data-sb-action="synthesize-open"' + (pullSynthDisabled ? ' disabled' : '') + '>' +
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
      '<span>Push will scan <span class="sb-name">' + escapeHtml(domains) + '</span> for pages changed since your last push ' +
      '(currently <span class="sb-num">' + pendingCount + '</span> pending), summarise each with your configured AI provider ' +
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
      '<summary>' + icon('alertTriangle', 13) + ' <span class="sb-num">' + skips.length + '</span> page' + (skips.length === 1 ? '' : 's') + ' skipped after repeated failures</summary>' +
      '<ul class="sb-card-skips-list">' + skips.map((p) => '<li>' + escapeHtml(p) + '</li>').join('') + '</ul>' +
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
      ? '<span class="sb-num">' + selfPages + ' of ' + total + '</span> pages (<span class="sb-num">' + Math.round((selfPages / total) * 100) + '%</span>)'
      : 'no contributions yet';

    let mirrorLine;
    if (conn.storage_type && !c.mirrorStats) {
      mirrorLine = 'not pulled yet';
    } else if (c.mirrorStats === 'not-pulled') {
      mirrorLine = 'not pulled yet';
    } else if (c.mirrorStats && typeof c.mirrorStats.pageCount === 'number') {
      mirrorLine = '<span class="sb-num">' + c.mirrorStats.pageCount + '</span> pages (as of your last pull)';
    } else {
      mirrorLine = 'not available';
    }

    networkBody =
      '<div class="sb-card-cohort-row"><span class="sb-card-stat-label">Contributors</span><span class="sb-num">' + members.length + '</span></div>' +
      '<div class="sb-card-cohort-row"><span class="sb-card-stat-label">Your attribution</span><span>' + attributionText + '</span></div>' +
      '<div class="sb-card-cohort-row"><span class="sb-card-stat-label">Shared pages</span><span>' + mirrorLine + '</span></div>';
  }

  return (
    '<details class="sb-card-cohort"' + (open ? ' open' : '') + ' data-sb-cohort="' + escapeHtml(conn.id) + '">' +
      '<summary>Cohort &amp; sharing details</summary>' +
      '<div class="sb-card-cohort-body">' +
        networkBody +
        '<div class="sb-card-cohort-row sb-card-cohort-note">Which domains contribute is read-only here — changing it means re-entering your access token, which only the setup wizard asks for. Use <b>Leave this Shared Brain</b> at the bottom of this card, then re-join with a fresh invite, to change the selection.</div>' +
        '<div class="sb-card-cohort-row sb-card-cohort-note">No automatic synthesis schedule — it’s triggered manually, usually by the brain admin.</div>' +
        '<div class="sb-card-cohort-row sb-card-cohort-note">Exporting your Shared Brain data — coming soon.</div>' +
      '</div>' +
    '</details>'
  );
}

// ── Admin controls: admin token + contributor revocation (Art. 17) ────────
//
// WHY THIS EXISTS AT ALL. Before this, /next shipped GET /:id/members —
// which exists for exactly one reason, to let an admin discover a
// fellow_id so they can revoke — and not the revocation itself. Cutting
// over in that state would mean an admin could not serve a GDPR erasure
// request from the app at all. Revoke is the Article 17 path; it is
// IRREVERSIBLE; and its result is what an admin uses to certify to a data
// subject that their data is gone.
//
// FIVE RULES, each one a recorded bug in this repo's history:
//
//  1. The admin token is shown ONCE. No post-op list refresh — see
//     ensureCard()'s comment for why a refresh is *more* destructive in
//     this render-from-state architecture than in the shipping app's.
//  2. The admin types the SHORT form (REVOKE-<short_id>); the client
//     expands it to the full-UUID literal the API requires. The
//     confirmation field is NEVER prefilled — prefilling it would defeat
//     the entire accident gate, which is the only thing standing between a
//     mis-click and an irreversible erasure.
//  3. fellow_id comes from GET /:id/members, whose identity is derived
//     from the STORAGE PATH, never from a payload's self-declared
//     fellow_id — the same trust rule synthesis uses, so a spoofed payload
//     cannot impersonate or merge a fellow.
//  4. read_only connections get no admin section at all; a connection with
//     no admin token gets rotate (as the PROVISIONING path) but no revoke.
//  5. A non-clean outcome must NEVER read as success. v3.0.3 records the
//     pre-fix admin seeing "Revocation complete" over a gutted collective.
//
// THE FIELD-TO-PIXEL TRACE. This backend was reworked in v3.6.2 to be
// self-reporting, and v3.6.2's own changelog records TWO instances of
// "new fields, no consumer" shipping inside its own fixes. So every field
// consumed here is traced to something an admin actually sees:
//
//   summary            → outcome.summary        → rendered verbatim (it is
//                        server-built from a `problems[]` accumulator and
//                        honest by construction; the reassuring wording is
//                        emitted at exactly one site, inside
//                        `if (problems.length === 0)`, with no `else` and
//                        no `default:`. Preferred over any client-composed
//                        string — a client-composed one is how the old UI
//                        drifted into claiming success.)
//   erasure_complete   → outcome.tone + outcome.erasureLine
//   partial / ok       → outcome.tone + outcome.headline
//   marker_active      → outcome.marker  (the actionable one: is cohort
//                        synthesis blocked RIGHT NOW)
//   marker_cleared     → outcome.marker  (null = N/A, never "blocked")
//   contributions_failed[], pages_failed[], digest_failed,
//   pages_rebuild_failed, state_reset_failed, audit_failed
//                      → outcome.lines   → one rendered row each
//   audit_record       → outcome.audit   (and an ABORT, which writes NO
//                        audit line, must not be implied to have been
//                        logged)
//
// THE SSE TRAP, and why nothing here breaks on the first terminal frame.
// revokeContributor calls onProgress('done', msg) — which the route
// forwards as {type:'done', message} with NO result — and only THEN does
// the route emit its own {type:'done', result} once the await returns. The
// failure path is the same shape: onProgress('error', msg) first, then
// {type:'error', message, result}. A reader that breaks on the first
// terminal frame therefore gets the prose and NONE of the structured
// fields — the exact "the fields reach nobody" shape this release is
// guarding against. absorbRevokeFrame() below never stops absorption and
// never lets a later result-less frame clear a result already seen; the
// caller reads to stream end (the route's `finally` calls res.end(), so it
// terminates).

// The admin affordances for one connection. Rule 4 lives here, in one
// place, so the render, the click handlers and the tests cannot disagree
// about who may see what.
function adminAffordances(conn, card) {
  if (conn && conn.read_only === true) {
    return { show: false, showRotate: false, showRevoke: false, hasToken: false, rotateLabel: '' };
  }
  const hasToken =
    !!(conn && typeof conn.admin_token === 'string' && conn.admin_token.length > 0) ||
    !!(card && card.adminTokenProvisioned);
  return {
    show: true,
    showRotate: true,
    showRevoke: hasToken,
    hasToken,
    rotateLabel: hasToken ? 'Rotate admin token' : 'Generate admin token',
  };
}

// ── Invite re-display (v3.0.5 §4.4) ───────────────────────────────────────
//
// WHY THIS EXISTS. Before this, /next minted an invite token in exactly one
// place — the setup wizard's step 2. An admin who closed that wizard and
// later needed to onboard someone had NO path back to the token except
// tearing the brain down and re-creating it. That is the precise defect
// v3.0.5 §4.4 shipped to fix in the shipping frontend, re-introduced by
// omission here; cutting over in that state would have regressed it.
//
// THE DERIVATION IS THE WHOLE FEATURE. The token is DETERMINISTIC:
// `encodeInviteToken` (src/routes/sharedbrain.js) builds a fixed payload
// object and base64url-encodes it, so re-sending the connection's stored
// metadata reproduces the ORIGINAL token byte-for-byte. It is not stored
// verbatim anywhere and must never be reconstructed by string surgery. The
// consequence of getting a field wrong is silent: a well-formed token that
// simply nobody in the cohort can redeem against the right brain.
//
// The route's defaults are mirrored here rather than left to the server so
// the body is explicit and testable: `branch || 'main'`, storage_type
// 'github', `data_handling_terms || 'contributor_retains'`.
//
// PRE-v3.0.5 CONNECTIONS. `data_handling_terms` was not persisted before
// v3.0.5, so a connection saved back then re-derives with the DEFAULT
// terms. If the brain was actually set up in the organisational (IP
// transfer) mode, that token shows a joining contributor the wrong consent
// text — a consent defect, not a cosmetic one. So the absence of the field
// is surfaced as an explicit caution rather than silently defaulted.
function inviteRequestBody(conn) {
  if (!conn) return null;
  return {
    repo: String(conn.github_repo_owner) + '/' + String(conn.github_repo_name),
    name: conn.label,
    shared_domain: conn.shared_domain,
    branch: conn.github_branch || 'main',
    storage_type: 'github',
    data_handling_terms: conn.data_handling_terms || 'contributor_retains',
  };
}

// Who may see the invite affordance. Deliberately STRICTER than the
// shipping app, which shows "Show invite token" to every connection
// including read-only members: minting an invitation to a brain is an
// administrative act, and a read-only member cannot add collaborators to
// the repo anyway — the token alone would strand whoever received it. So
// this reuses the same gate the rest of the admin surface uses (rule 4):
// no admin section for read-only members, and the invite block only where
// an admin token exists (or has just been provisioned this mount).
//
// storage_type is also gated: encodeInviteToken REFUSES a non-github
// storage_type at mint time, so offering the button on a local-folder
// brain would only ever produce a 400.
function inviteAffordance(conn, card) {
  const admin = adminAffordances(conn, card);
  if (!admin.show || !admin.hasToken) {
    return { show: false, reason: 'not-admin', cautionTerms: false };
  }
  if (!conn || conn.storage_type !== 'github') {
    return { show: false, reason: 'not-github', cautionTerms: false };
  }
  return {
    show: true,
    reason: null,
    // TRUE only when the stored value is genuinely absent. A stored
    // 'contributor_retains' is a real recorded choice and must NOT raise
    // the caution — that would train admins to ignore it.
    cautionTerms: !conn.data_handling_terms,
  };
}

// What the admin must TYPE — the short form, per rule 2. short_id is
// `fellow_id.replace(/-/g,'').slice(0,8)` (hyphens stripped) and is
// therefore NOT recoverable back into a UUID by string surgery, which is
// exactly why the expansion below reads the picked member's own fellow_id.
function revokeExpectedTyped(member) {
  return member && typeof member.short_id === 'string' && member.short_id
    ? 'REVOKE-' + member.short_id
    : null;
}

// What the API must RECEIVE — the full-UUID literal. Never shown, never
// prefilled, never derived from what was typed.
function revokeConfirmationFor(member) {
  return member && typeof member.fellow_id === 'string' && member.fellow_id
    ? 'REVOKE-' + member.fellow_id
    : null;
}

function revokeGateState({ member, typed, tokenPresent, busy }) {
  if (busy) return { unlocked: false, reason: 'An operation is already running on this connection.' };
  if (!member) return { unlocked: false, reason: 'Select the contributor to revoke.' };
  if (!tokenPresent) return { unlocked: false, reason: 'Paste the admin token from your password manager.' };
  const expected = revokeExpectedTyped(member);
  if (!expected) return { unlocked: false, reason: 'This member has no usable short id — it cannot be revoked from here.' };
  if (String(typed == null ? '' : typed).trim() !== expected) {
    return { unlocked: false, reason: 'Type ' + expected + ' exactly to unlock.' };
  }
  if (!revokeConfirmationFor(member)) {
    return { unlocked: false, reason: 'This member has no usable fellow id — it cannot be revoked from here.' };
  }
  return { unlocked: true, reason: null };
}

function freshRevokeAcc() {
  return { result: null, lastMessage: null, errorMessage: null, sawError: false, sawTerminal: false };
}

// See "THE SSE TRAP" above. Returns a NEW accumulator; a frame that
// carries no `result` can never clear one already absorbed.
function absorbRevokeFrame(acc, payload) {
  const next = {
    result: acc.result,
    lastMessage: acc.lastMessage,
    errorMessage: acc.errorMessage,
    sawError: acc.sawError,
    sawTerminal: acc.sawTerminal,
  };
  if (!payload || typeof payload !== 'object') return next;
  const hasResult = !!payload.result && typeof payload.result === 'object';
  const msg = typeof payload.message === 'string' && payload.message ? payload.message : null;

  if (payload.type === 'error') {
    next.sawError = true;
    next.sawTerminal = true;
    if (msg) next.errorMessage = msg;
    if (hasResult) next.result = payload.result;
    return next;
  }
  if (payload.type === 'done') {
    next.sawTerminal = true;
    if (hasResult) next.result = payload.result;
    else if (msg) next.lastMessage = msg;
    return next;
  }
  if (msg) next.lastMessage = msg;
  return next;
}

// The buffering half of "THE SSE TRAP", extracted so it is EXECUTED by the
// offline suite rather than grepped for. Feeds one decoded text chunk (what
// `dec.decode(value, { stream: true })` produces for one `reader.read()`)
// into a { acc, buf } state, absorbing every complete `data: …` frame it
// completes along the way — a partial frame straddling a chunk boundary
// stays in `buf` for the next call, exactly as the inline version runRevoke
// used to do. `onFrame(acc)` fires once per absorbed frame (not once per
// chunk) so a caller driving the real network stream gets the same
// per-frame progress granularity the old inline loop had.
function consumeRevokeChunk(consumeState, chunk, onFrame) {
  let acc = consumeState.acc;
  let buf = consumeState.buf + chunk;
  const events = buf.split('\n\n');
  buf = events.pop();
  for (const ev of events) {
    if (!ev.startsWith('data:')) continue;
    let payload;
    try { payload = JSON.parse(ev.slice(5).trim()); } catch { continue; }
    acc = absorbRevokeFrame(acc, payload);
    if (typeof onFrame === 'function') onFrame(acc);
  }
  return { acc, buf };
}

// MEDIUM-4 (audit): the whole-stream replay, callable from the offline
// suite with NO network/DOM. It contains the entire "keep going" decision
// for a revoke stream: there is no early exit here on `acc.sawTerminal` —
// every chunk in `chunks` is fed through consumeRevokeChunk unconditionally,
// so a fixture shaped [done-with-no-result, done-with-result] proves the
// SECOND terminal frame — the one carrying the real result — is never
// dropped. runRevoke's real reader loop delegates its "keep reading" test
// to `reader.read()`'s own `done` flag alone (see below) and has NO other
// early-exit path, so this function is not a parallel re-implementation of
// that decision — it IS that decision, lifted out of the network loop so it
// can be driven by a fixture. The audit's exact regression —
// `if (acc.sawTerminal) { streamDone = true; break; }` inserted into this
// loop — is exactly what a mutation test against this function must catch;
// a source regex checking for the literal string "break outer" or for
// `if (done) break;`'s presence could not, and did not.
function consumeRevokeStream(chunks) {
  let state = { acc: freshRevokeAcc(), buf: '' };
  for (const chunk of chunks) state = consumeRevokeChunk(state, chunk);
  return state.acc;
}

// Every per-category failure field the v3.6.2 backend can report, turned
// into rows. This function is the ONLY reason those fields are not dead
// data; renderRevokeOutcomeHtml() renders whatever it returns.
function revokeFailureLines(result) {
  const lines = [];
  if (!result || typeof result !== 'object') return lines;
  const detailOf = (o) => (o && typeof o.error === 'string' && o.error ? o.error : 'unknown error');

  const cf = Array.isArray(result.contributions_failed) ? result.contributions_failed : [];
  if (cf.length > 0) {
    lines.push({
      label: cf.length + ' contribution file' + (cf.length === 1 ? '' : 's') + ' could NOT be deleted — still in shared storage',
      detail: cf.map((f) => (f && f.submission_id ? String(f.submission_id).slice(0, 8) + '… — ' : '') + detailOf(f)).join(' · '),
    });
  }
  if (result.digest_failed) {
    lines.push({ label: 'The contributor’s digest cache could NOT be deleted', detail: detailOf(result.digest_failed) });
  }
  const pf = Array.isArray(result.pages_failed) ? result.pages_failed : [];
  if (pf.length > 0) {
    lines.push({
      label: pf.length + ' collective page' + (pf.length === 1 ? '' : 's') + ' could NOT be checked or deleted — they may still carry this contributor’s content',
      detail: pf.map((f) => (f && f.path ? String(f.path) + ' — ' : '') + detailOf(f)).join(' · '),
    });
  }
  // rebuild_ok is deliberately read out of audit_record: it is NOT a
  // top-level result field (checked against sharedbrain-revoke.js's
  // baseResult and abortResult, and against the documented shape in
  // docs/shared-brain-admin.md) and inventing a top-level one here would
  // read as `undefined` forever — a row that could never fire.
  const rec = result.audit_record && typeof result.audit_record === 'object' ? result.audit_record : null;
  if (rec && rec.rebuild_ok === false) {
    lines.push({
      label: 'The rebuild synthesis FAILED',
      detail: 'The erasure ran, but the collective is missing the deleted pages until a rebuild succeeds. Re-running this revocation is safe — every step is idempotent.',
    });
  }
  const prf = typeof result.pages_rebuild_failed === 'number' ? result.pages_rebuild_failed : 0;
  if (prf > 0) {
    lines.push({
      label: prf + ' page' + (prf === 1 ? '' : 's') + ' failed to write during the rebuild',
      detail: 'The erasure is unaffected, but the collective is incomplete until a further synthesis succeeds.',
    });
  }
  if (result.state_reset_failed) {
    lines.push({
      label: 'The synthesis watermark could not be reset',
      detail: detailOf(result.state_reset_failed) + ' — reported for completeness; this is not an erasure failure.',
    });
  }
  if (result.audit_failed) {
    lines.push({
      label: 'The erasure was NOT written to the audit log',
      detail: detailOf(result.audit_failed) + ' — you have no permanent record of this revocation.',
    });
  }
  return lines;
}

// marker_active is the field to act on: is cohort synthesis blocked right
// now? marker_cleared is deliberately NOT reinterpreted here — a `null`
// means "no marker was ever written", and rendering that as "synthesis
// blocked" would raise a cohort-wide alarm for a request that failed input
// validation and touched nothing.
function revokeMarkerNotice(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.marker_active === true) {
    return {
      tone: 'danger',
      text: 'Cohort synthesis is BLOCKED right now — the revocation-in-progress marker is still set, so every contributor’s ordinary synthesis is being refused. Re-run this revocation (safe — every step is idempotent) to clear it.',
    };
  }
  if (result.marker_active === null || result.marker_active === undefined) {
    return {
      tone: 'warning',
      text: 'Whether cohort synthesis is blocked is UNKNOWN — the in-progress marker write itself failed, so a partial commit cannot be ruled out. If contributors report synthesis refusing, that is why.',
    };
  }
  return { tone: 'ok', text: 'Cohort synthesis is not blocked (the in-progress marker is clear).' };
}

// An ABORT writes no audit line at all. Saying nothing would let an admin
// assume one exists, so the "no record" case is stated explicitly.
function revokeAuditNotice(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.audit_failed) {
    return { tone: 'danger', text: 'No audit record: the erasure could not be written to state/revocations.jsonl.' };
  }
  if (result.audit_record) {
    return { tone: 'ok', text: 'Recorded in the revocation audit log (state/revocations.jsonl).' };
  }
  return { tone: 'warning', text: 'No audit record was written for this attempt — a run that aborts before the erasure steps writes no log line at all.' };
}

// THE CLASSIFIER. Success is a NARROW conjunction and everything else
// falls to the honest side. v3.6.1 records a `default:` arm that fell into
// the cheerful branch; the direction of the default is the whole lesson,
// so an unrecognised/absent shape here degrades to "not proven", never to
// "complete".
function classifyRevokeOutcome(acc) {
  const result = acc && acc.result && typeof acc.result === 'object' ? acc.result : null;
  const transport = acc && typeof acc.errorMessage === 'string' && acc.errorMessage ? acc.errorMessage : null;

  if (!result) {
    return {
      tone: 'danger',
      headline: 'Revocation did not report a result — treat this contributor’s data as NOT erased.',
      // L4 (audit): this is a fallback — transport error text, or whatever
      // progress message happened to be last (which can itself be
      // success-shaped prose, e.g. "Revocation complete" cut off before the
      // structured result that would have confirmed it). summaryFromServer
      // stays false on this whole branch so the render never labels it
      // quotable.
      summary: transport || (acc && acc.lastMessage) || 'The revocation stream ended without a result.',
      summaryFromServer: false,
      erasureLine: 'Erasure NOT confirmed. Do not certify this revocation. Re-running it is safe — every step is idempotent.',
      lines: [],
      marker: null,
      audit: null,
      certifiable: false,
      sawError: !!(acc && acc.sawError),
    };
  }

  const erasureComplete = result.erasure_complete === true;
  const erasureDenied = result.erasure_complete === false;
  const clean = result.ok === true && result.partial !== true;

  let tone, headline, erasureLine;
  if (erasureDenied) {
    tone = 'danger';
    headline = '⚠ ERASURE INCOMPLETE — this contributor’s data has NOT been fully removed.';
    erasureLine = 'Do NOT report this erasure as complete to the data subject. Resolve the problems below and re-run the revocation.';
  } else if (!erasureComplete) {
    // erasure_complete absent/null: the server did not assert completeness,
    // so neither do we.
    tone = 'warning';
    headline = 'Erasure completeness was NOT confirmed by the server.';
    erasureLine = 'Do not certify this revocation — the response carried no erasure_complete verdict. Re-running it is safe.';
  } else if (!clean) {
    tone = 'warning';
    headline = 'Erasure completed, but the revocation did NOT finish cleanly.';
    erasureLine = 'The contributor’s data IS gone, but do NOT certify this revocation until the problems below are resolved.';
  } else {
    tone = 'success';
    headline = 'Revocation complete.';
    erasureLine = 'The contributor’s data has been erased. Next: tell every contributor to Pull updates so their mirrors drop the erased content, and remove the person as a GitHub collaborator so they cannot push again.';
  }

  const hasServerSummary = typeof result.summary === 'string' && !!result.summary;

  return {
    tone,
    headline,
    // The server owns this wording. Preferred outright over anything
    // composed here — see the field-to-pixel trace above.
    summary: hasServerSummary ? result.summary : (transport || 'No summary was returned.'),
    // L4 (audit): true ONLY when `summary` above is actually quoting
    // result.summary. The transport-error / "no summary" fallbacks are not
    // server-authored prose and must never be labelled quotable either.
    summaryFromServer: hasServerSummary,
    erasureLine,
    lines: revokeFailureLines(result),
    marker: revokeMarkerNotice(result),
    audit: revokeAuditNotice(result),
    certifiable: tone === 'success',
    // L5 (audit): recorded on freshRevokeAcc/absorbRevokeFrame but never
    // reached the outcome the UI reads — carried through so a stream that
    // reported an error frame partway through (even one recovered by a
    // later terminal `done` with a clean result) is visible to the admin,
    // not silently dropped.
    sawError: !!(acc && acc.sawError),
    counts: {
      contributionsDeleted: typeof result.contributions_deleted === 'number' ? result.contributions_deleted : null,
      pagesDeleted: typeof result.pages_deleted === 'number' ? result.pages_deleted : null,
      pagesRebuilt: typeof result.pages_rebuilt === 'number' ? result.pages_rebuilt : null,
    },
  };
}

// Pure string renderer — no DOM, so the suite can assert that a given
// backend field reaches the actual markup rather than trusting a source
// regex that a field is "consumed somewhere".
function renderRevokeOutcomeHtml(outcome) {
  if (!outcome) return '';
  const toneClass = outcome.tone === 'success' ? 'sb-outcome-ok'
    : outcome.tone === 'warning' ? 'sb-outcome-warn'
    : 'sb-outcome-danger';
  const glyph = outcome.tone === 'success' ? icon('check', 14) : icon('alertTriangle', 14);

  const c = outcome.counts || {};
  const countsRow = (c.contributionsDeleted !== null && c.contributionsDeleted !== undefined)
    ? '<div class="sb-outcome-counts">' +
        escapeHtml(c.contributionsDeleted + ' contribution' + (c.contributionsDeleted === 1 ? '' : 's') + ' deleted · ' +
          c.pagesDeleted + ' page' + (c.pagesDeleted === 1 ? '' : 's') + ' removed · ' + c.pagesRebuilt + ' rebuilt') +
      '</div>'
    : '';

  const linesHtml = outcome.lines && outcome.lines.length
    ? '<ul class="sb-outcome-lines">' + outcome.lines.map((l) =>
        '<li><span class="sb-outcome-line-label">' + escapeHtml(l.label) + '</span>' +
        (l.detail ? '<span class="sb-outcome-line-detail">' + escapeHtml(l.detail) + '</span>' : '') + '</li>'
      ).join('') + '</ul>'
    : '';

  const noticeHtml = (n) => n
    ? '<div class="sb-outcome-notice sb-outcome-notice-' + escapeHtml(n.tone) + '">' + escapeHtml(n.text) + '</div>'
    : '';

  // L5 (audit): certifiable and sawError render here — the only place that
  // reads them outside the test file.
  const certifyNotice = outcome.certifiable
    ? { tone: 'ok', text: 'Certifiable: this result is safe to certify to the data subject as a completed erasure.' }
    : null;
  const streamErrorNotice = outcome.sawError
    ? {
        tone: 'warning',
        text: outcome.tone === 'success'
          ? 'An error frame was reported partway through this stream, even though the run went on to report success above — re-check the details before certifying.'
          : 'An error frame was reported partway through this stream, consistent with the outcome above.',
      }
    : null;

  // L4 (audit): only label the quoted text "the wording to quote" when it
  // is genuinely result.summary from the server — never leftover progress
  // prose or a transport error, which can read as success-shaped even when
  // the tone above correctly says otherwise.
  const summaryLabel = outcome.summaryFromServer
    ? 'Server summary (the wording to quote)'
    : 'Last message received (not a confirmed result — do not quote this)';

  return (
    '<div class="sb-outcome ' + toneClass + '" role="status" aria-live="polite">' +
      '<div class="sb-outcome-headline">' + glyph + '<span>' + escapeHtml(outcome.headline) + '</span></div>' +
      '<div class="sb-outcome-erasure">' + escapeHtml(outcome.erasureLine) + '</div>' +
      noticeHtml(certifyNotice) +
      countsRow +
      linesHtml +
      noticeHtml(streamErrorNotice) +
      noticeHtml(outcome.marker) +
      noticeHtml(outcome.audit) +
      '<details class="sb-outcome-raw"><summary>' + escapeHtml(summaryLabel) + '</summary>' +
        '<p class="sb-outcome-summary">' + escapeHtml(outcome.summary) + '</p>' +
      '</details>' +
    '</div>'
  );
}

// Scrolls the just-rendered revoke outcome into view if it landed
// off-screen. A no-op when it's already fully in the viewport — same
// "already visible = don't yank the page" reasoning as domains.js's own
// revealMessage() (see that file's comment for the full origin story); not
// lifted into a shared helper on purpose, since one hand-maintained copy of
// a small DOM check drifting per view is a much smaller risk than the two
// hand-maintained copies of a SECURITY guard that produced the v3.2.0
// CRITICAL — this is not that shape.
//
// MEDIUM-3 (audit): runRevoke's finally block renders the outcome, then —
// when the panel is open — fires loadRevokeMembers(), whose OWN render
// re-expands the (now member-less, reloading) panel underneath the outcome
// that was just drawn, pushing it further down the page with no scroll
// adjustment. A revoke is a GDPR Article 17 erasure the admin must be able
// to see the result of, so this must be called AFTER every re-render that
// can move it — never right after the first render, which is provably too
// early.
function revealRevokeOutcome(connId) {
  const el = document.querySelector('.sb-card[data-conn-id="' + connId + '"] .sb-outcome');
  if (!el || typeof el.getBoundingClientRect !== 'function') return false;
  const r = el.getBoundingClientRect();
  if (r.height === 0 && r.width === 0) return false;
  if (r.top >= 0 && r.bottom <= window.innerHeight) return false; // already readable
  if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' });
  return true;
}

// ── Admin controls: render ────────────────────────────────────────────────

function renderAdmin(conn, card, busy, mirrorBusy) {
  const aff = adminAffordances(conn, card);
  if (!aff.show) return '';   // rule 4: read-only members get no admin surface at all

  const open = state.expandedAdmin.has(conn.id);
  return (
    '<details class="sb-card-admin"' + (open ? ' open' : '') + ' data-sb-admin="' + escapeHtml(conn.id) + '">' +
      '<summary>' + icon('lock', 13) + ' Admin controls — admin token &amp; contributor revocation</summary>' +
      '<div class="sb-admin-body">' +
        renderAdminToken(card, aff, busy) +
        renderInvite(conn, card, busy) +
        (aff.showRevoke
          ? renderRevoke(conn, card, busy, mirrorBusy)
          : '<div class="sb-admin-note">' + icon('alertCircle', 13) +
            '<span>Revoking a contributor needs an admin token, and this connection has none stored. ' +
            'Generate one above first — that is also the provisioning path for brains created before admin tokens existed.</span></div>') +
      '</div>' +
    '</details>'
  );
}

function renderAdminToken(card, aff, busy) {
  let html = '<div class="sb-admin-block">';
  html +=
    '<div class="sb-admin-row">' +
      '<div class="sb-admin-row-text">' +
        '<div class="sb-admin-row-title">Admin token</div>' +
        '<p class="sb-admin-hint">' +
          (aff.hasToken
            ? 'Authorises contributor revocation on this connection. Rotate it if you think it leaked — the current token stops working immediately.'
            : 'Authorises contributor revocation (GDPR erasure). None is stored for this connection yet.') +
        '</p>' +
      '</div>' +
      (card.rotateConfirmOpen
        ? ''
        : '<button type="button" class="btn btn-secondary btn-xs" data-sb-action="rotate-open"' + (busy ? ' disabled' : '') + '>' +
            (card.acting === 'rotate' ? 'Working…' : escapeHtml(aff.rotateLabel)) +
          '</button>') +
    '</div>';

  if (card.rotateConfirmOpen) {
    html +=
      '<div class="sb-confirm-inline sb-confirm-block">' +
        '<span>' +
          (aff.hasToken
            ? 'Rotate the admin token? The CURRENT token stops working immediately — anywhere you stored it becomes invalid, including any other machine you administer this brain from.'
            : 'Generate an admin token for this connection? It authorises contributor revocation (GDPR erasure).') +
          ' It is shown <strong>once</strong> and never again — have your password manager open before you continue.' +
        '</span>' +
        '<div class="sb-confirm-actions">' +
          '<button type="button" class="btn btn-primary btn-xs" data-sb-action="rotate-confirm"' + (busy ? ' disabled' : '') + '>' +
            (aff.hasToken ? 'Rotate token' : 'Generate token') +
          '</button>' +
          '<button type="button" class="btn btn-ghost btn-xs" data-sb-action="rotate-cancel">Cancel</button>' +
        '</div>' +
      '</div>';
  }

  // The shown-once box. Rendered straight from card.shownAdminToken, so a
  // re-render REDRAWS it rather than destroying it — and nothing on this
  // path issues a list refresh (see ensureCard()'s comment). It is cleared
  // only by the admin's own Hide button.
  if (card.shownAdminToken) {
    html +=
      '<div class="sb-token-box">' +
        '<div class="sb-token-warn">' + icon('alertTriangle', 13) +
          // Browser-verified: the token survives every re-render WITHIN this
          // mount, and is discarded when you leave the view (state =
          // freshState() on re-entry — a credential must not outlive the
          // mount that minted it). That is the right behaviour and a silent
          // trap if unstated, so the copy states it.
          '<span>Your admin token — <strong>shown once</strong>. Store it in a password manager now; it authorises contributor ' +
          'revocation and cannot be displayed again. Leaving this view discards it — you would have to rotate, which invalidates this one.</span>' +
        '</div>' +
        '<code class="sb-token-value mono">' + escapeHtml(card.shownAdminToken) + '</code>' +
        '<div class="sb-token-actions">' +
          '<button type="button" class="btn btn-secondary btn-xs" data-sb-action="token-copy">' + icon('copy', 12) + ' Copy</button>' +
          '<button type="button" class="btn btn-ghost btn-xs" data-sb-action="token-hide">I’ve stored it — hide</button>' +
        '</div>' +
      '</div>';
  }

  return html + '</div>';
}

// The invite block. Every class here already exists in views/shared.css
// (which this session does not own) — the neutral .sb-admin-block is used
// as the container rather than the amber .sb-token-box, because the amber
// box means "secret, shown once" and this token is neither.
function renderInvite(conn, card, busy) {
  const aff = inviteAffordance(conn, card);
  if (!aff.show) return '';

  let html = '<div class="sb-admin-block">';
  html +=
    '<div class="sb-admin-row">' +
      '<div class="sb-admin-row-text">' +
        '<div class="sb-admin-row-title">Invite token</div>' +
        '<p class="sb-admin-hint">Share this with anyone joining the brain — it carries the repository, branch and ' +
        'data-handling terms, and no credentials. It never expires and it is the same token everyone else already ' +
        'has, so re-showing it is safe. They still need a GitHub collaborator invitation and their own access token.</p>' +
      '</div>' +
      (card.inviteOpen
        ? '<button type="button" class="btn btn-ghost btn-xs" data-sb-action="invite-hide">Hide</button>'
        : '<button type="button" class="btn btn-secondary btn-xs" data-sb-action="invite-show"' + (busy ? ' disabled' : '') + '>' +
            (card.inviteLoading ? 'Working…' : 'Show invite token') +
          '</button>') +
    '</div>';

  if (card.inviteOpen) {
    if (card.inviteError) {
      html +=
        '<div class="sb-admin-note sb-admin-note-danger" style="margin-top:10px">' + icon('alertCircle', 13) +
        '<span>' + escapeHtml(card.inviteError) + '</span></div>';
    } else if (card.inviteLoading || !card.inviteToken) {
      html += '<p class="sb-admin-hint" style="margin-top:10px">Re-deriving the invite token…</p>';
    } else {
      html +=
        '<div style="margin-top:10px;display:flex;flex-direction:column;gap:9px">' +
          (aff.cautionTerms
            ? '<div class="sb-token-warn">' + icon('alertTriangle', 13) +
              '<span>This connection was set up before the data-handling choice was recorded, so the token above ' +
              'uses the default <strong>contributor retains copyright</strong> terms. If this brain actually runs on ' +
              'the organisational (IP transfer) terms, share your originally issued token instead — this one would ' +
              'show a joining contributor the wrong consent text.</span></div>'
            : '') +
          '<code class="sb-token-value mono">' + escapeHtml(card.inviteToken) + '</code>' +
          '<div class="sb-token-actions">' +
            '<button type="button" class="btn btn-secondary btn-xs" data-sb-action="invite-copy">' + icon('copy', 12) + ' Copy</button>' +
          '</div>' +
        '</div>';
    }
  }

  return html + '</div>';
}

function renderRevoke(conn, card, busy, mirrorBusy) {
  let html = '<div class="sb-admin-block sb-admin-block-danger">';
  html +=
    '<div class="sb-admin-row">' +
      '<div class="sb-admin-row-text">' +
        '<div class="sb-admin-row-title">Revoke a contributor <span class="sb-irreversible-pill">irreversible</span></div>' +
        '<p class="sb-admin-hint">GDPR Article 17. Permanently erases this contributor’s submissions and every collective page ' +
        'carrying their provenance, then rebuilds the collective from the remaining contributors. This cannot be undone.</p>' +
      '</div>' +
      (card.revokeOpen
        ? '<button type="button" class="btn btn-ghost btn-xs" data-sb-action="revoke-close"' + (card.acting === 'revoke' ? ' disabled' : '') + '>Close</button>'
        : '<button type="button" class="btn btn-secondary btn-xs" data-sb-action="revoke-open"' + (busy || mirrorBusy ? ' disabled' : '') + '>Revoke a contributor…</button>') +
    '</div>';

  if (card.revokeOpen) html += renderRevokePanel(conn, card, busy, mirrorBusy);
  if (card.revokeOutcome) html += renderRevokeOutcomeHtml(card.revokeOutcome);

  return html + '</div>';
}

function selectedMemberOf(card) {
  const m = card.revokeMembers;
  if (!m || typeof m !== 'object' || m === 'loading' || !Array.isArray(m.members)) return null;
  return m.members.find((x) => x && x.fellow_id === card.revokeSelectedFellowId) || null;
}

// The ENTIRE state transition for picking a member in the revoke panel,
// factored out of its DOM `change` listener so it can be called directly.
//
// MEDIUM-5 (audit): the old guard was a whole-FILE regex for the literal
// string `card.revokeTyped = '';`, which occurs at three unrelated sites
// (here, revoke-close, and runRevoke's own post-run reset) — so a mutation
// that made member SELECTION prefill the confirmation (defeating the
// accident gate outright: with a token already pasted, one click would
// leave the irreversible button one click from firing) still matched the
// regex and stayed green. Calling this function and asserting its OUTPUT
// is what actually proves the invariant.
function selectRevokeMember(card, fellowId) {
  card.revokeSelectedFellowId = fellowId;
  // Deliberately does NOT prefill the confirmation — picking a member must
  // never fill in the phrase that unlocks an irreversible write.
  card.revokeTyped = '';
  return card;
}

function renderRevokePanel(conn, card, busy, mirrorBusy) {
  const m = card.revokeMembers;
  if (m === null || m === 'loading') {
    return '<div class="sb-admin-note">Loading the contributor list from the shared repo…</div>';
  }
  if (m.error) {
    return '<div class="sb-admin-note sb-admin-note-danger">' + icon('alertTriangle', 13) +
      '<span>Could not load the contributor list: ' + escapeHtml(m.error) + '</span></div>';
  }
  const members = Array.isArray(m.members) ? m.members : [];
  if (members.length === 0) {
    return '<div class="sb-admin-note">No contributions have been made to this brain yet — there is nobody to revoke.</div>';
  }

  if (card.acting === 'revoke') {
    return '<div class="sb-admin-note">' + icon('alertTriangle', 13) +
      '<span>' + escapeHtml(card.revokeProgress || 'Revocation running — do not close the app.') + '</span></div>';
  }

  const selected = selectedMemberOf(card);
  const gate = revokeGateState({
    member: selected,
    typed: card.revokeTyped,
    tokenPresent: card.revokeTokenPresent,
    busy: busy || mirrorBusy,
  });
  const expected = revokeExpectedTyped(selected);

  const memberRows = members.map((mem) => {
    const isSelf = !!(m.selfFellowId && mem.fellow_id === m.selfFellowId);
    const who = mem.display_name ? mem.display_name + ' (' + mem.short_id + '…)' : 'fellow ' + mem.short_id + '…';
    const subs = typeof mem.submissions === 'number' ? mem.submissions : 0;
    const meta = subs + ' submission' + (subs === 1 ? '' : 's') +
      ' · ' + (typeof mem.pages === 'number' ? mem.pages : 0) + ' page' + ((mem.pages === 1) ? '' : 's') +
      ' · last active ' + formatRelativeTime(mem.last_contributed_at, 'never');
    return (
      '<label class="sb-member-row' + (card.revokeSelectedFellowId === mem.fellow_id ? ' selected' : '') + '">' +
        '<input type="radio" name="sb-revoke-' + escapeHtml(conn.id) + '" value="' + escapeHtml(mem.fellow_id) + '"' +
          (card.revokeSelectedFellowId === mem.fellow_id ? ' checked' : '') + ' data-sb-member="' + escapeHtml(mem.fellow_id) + '">' +
        '<span class="sb-member-text">' +
          '<span class="sb-member-who">' + escapeHtml(who) + (isSelf ? '<span class="sb-member-self">YOU</span>' : '') + '</span>' +
          '<span class="sb-member-meta">' + escapeHtml(meta) + '</span>' +
        '</span>' +
      '</label>'
    );
  }).join('');

  return (
    '<div class="sb-revoke-panel">' +
      '<div class="sb-revoke-step">' +
        '<div class="sb-revoke-step-label">1 · Who</div>' +
        '<div class="sb-member-list">' + memberRows + '</div>' +
        '<p class="sb-admin-hint">Identity comes from the shared repo’s own storage paths, not from anything a contributor’s payload claims about itself.</p>' +
      '</div>' +
      '<div class="sb-revoke-step">' +
        '<div class="sb-revoke-step-label">2 · Admin token</div>' +
        '<input type="password" class="sb-revoke-input mono" id="sb-revoke-token-' + escapeHtml(conn.id) + '" ' +
          'placeholder="sbat_…" autocomplete="off" spellcheck="false" data-sb-input="token">' +
        '<p class="sb-admin-hint">Read from your password manager. It is sent once, in the request body, and is never stored by this screen.</p>' +
      '</div>' +
      '<div class="sb-revoke-step">' +
        '<div class="sb-revoke-step-label">3 · Confirm</div>' +
        '<input type="text" class="sb-revoke-input mono" id="sb-revoke-confirm-' + escapeHtml(conn.id) + '" ' +
          'placeholder="' + escapeHtml(selected ? 'Type ' + expected : 'Select a contributor first') + '" ' +
          'value="' + escapeHtml(card.revokeTyped || '') + '" autocomplete="off" spellcheck="false" data-sb-input="confirm">' +
        '<p class="sb-admin-hint">' +
          (selected
            ? 'Type <span class="mono">' + escapeHtml(expected) + '</span> exactly. It is deliberately not filled in for you.'
            : 'Pick a contributor above and the exact phrase to type will appear here.') +
        '</p>' +
      '</div>' +
      '<div class="sb-revoke-go">' +
        '<button type="button" class="btn btn-danger" data-sb-action="revoke-run"' + (gate.unlocked ? '' : ' disabled') + '>' +
          icon('trash', 14) + ' Permanently revoke this contributor' +
        '</button>' +
        (gate.reason ? '<span class="sb-revoke-gate-reason">' + escapeHtml(gate.reason) + '</span>' : '') +
      '</div>' +
    '</div>'
  );
}

// Typing must NOT trigger a full render(): setMain() replaces innerHTML
// wholesale, which would destroy the focused field mid-keystroke and empty
// the password input on every character. So the gate's two visible effects
// — the danger button's disabled state and the reason line — are patched in
// place from the SAME revokeGateState() the render uses, so the two can
// never disagree about whether the button should be live.
function updateRevokeGateUi(cardEl, connId) {
  const card = ensureCard(connId);
  const conn = findConnection(connId);
  const mirrorDomain = mirrorDomainFor(conn);
  const gate = revokeGateState({
    member: selectedMemberOf(card),
    typed: card.revokeTyped,
    tokenPresent: card.revokeTokenPresent,
    busy: !!card.acting || (!!mirrorDomain && isDomainWriteBusy(mirrorDomain)),
  });
  const btn = cardEl.querySelector('button[data-sb-action="revoke-run"]');
  if (btn) btn.disabled = !gate.unlocked;
  const reason = cardEl.querySelector('.sb-revoke-gate-reason');
  if (reason) reason.textContent = gate.reason || '';
}

// ── Admin controls: actions ───────────────────────────────────────────────

async function onRotateAdminToken(token, connId) {
  const card = ensureCard(connId);
  if (card.acting) {
    card.message = 'An operation is already running on this connection — wait for it to finish.';
    card.error = true;
    render(token);
    return;
  }
  const conn = findConnection(connId);
  const aff = adminAffordances(conn, card);
  if (!aff.showRotate) return;   // rule 4, enforced at the action too, not only in the render

  card.rotateConfirmOpen = false;
  card.acting = 'rotate';
  card.message = aff.hasToken ? 'Rotating the admin token…' : 'Generating an admin token…';
  card.error = false;
  render(token);

  try {
    const res = await fetch('/api/sharedbrain/' + connId + '/admin-token/rotate', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok !== true || typeof data.admin_token !== 'string' || !data.admin_token) {
      throw new Error(data.error || 'The admin token could not be ' + (aff.hasToken ? 'rotated' : 'generated') + ' (HTTP ' + res.status + ').');
    }
    // Deliberately NOT gated on isCurrentMount: `card` is this mount's own
    // object and `state` is replaced wholesale on re-entry, so writing here
    // touches a detached object on an abandoned mount and nothing else. The
    // render call below IS gated.
    card.shownAdminToken = data.admin_token;
    card.adminTokenProvisioned = true;
    card.message = data.rotated
      ? 'Admin token rotated. The previous token no longer works.'
      : 'Admin token generated. Contributor revocation is now available on this connection.';
    card.error = false;
  } catch (err) {
    card.message = err.message;
    card.error = true;
  } finally {
    card.acting = null;
    // NO refreshConnections() here, on purpose — see ensureCard()'s comment.
    // A list reload that errored would flip renderEnabled() to its error
    // branch, which renders no cards, taking the shown-once token off screen
    // before it could be copied.
    if (isCurrentMount(token)) {
      state.expandedAdmin.add(connId);
      render(token);
    }
  }
}

// Copy must never be able to lose the token: the value is read from card
// state (not the DOM), and neither the success nor the failure path clears
// card.shownAdminToken or re-renders the box away. A failed clipboard write
// says so, and the token stays on screen to be selected by hand.
function copyShownAdminToken(token, connId) {
  const card = ensureCard(connId);
  const value = card.shownAdminToken;
  if (!value) return;
  const done = (msg, isError) => {
    card.message = msg;
    card.error = !!isError;
    if (isCurrentMount(token)) render(token);
  };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(
        () => done('Admin token copied to the clipboard. It is still shown below until you press Hide.', false),
        () => done('Could not copy automatically — select the token below and copy it by hand.', true)
      );
      return;
    }
  } catch { /* fall through to the manual message */ }
  done('Could not copy automatically — select the token below and copy it by hand.', true);
}

// Re-derive and show the invite token.
//
// Deliberately does NOT set card.acting: this is a pure read that mutates
// nothing on the server (POST /generate-invite is an encoder, and its
// docblock says so), so it must not take the per-connection action lock and
// block a Push, nor be blocked by one. It carries its own inviteLoading
// flag instead, and re-entry is refused on that flag alone.
//
// The response ALSO carries a freshly-minted admin_token — the route mints
// one for the setup wizard's step 2. It is deliberately ignored here, the
// same way the shipping app ignores it: nothing persists it, so reading it
// would only put a live credential on screen that authorises nothing.
async function onShowInvite(token, connId) {
  const card = ensureCard(connId);
  if (card.inviteLoading) return;

  const conn = findConnection(connId);
  const aff = inviteAffordance(conn, card);
  if (!aff.show) return;   // enforced at the action too, not only in the render

  card.inviteOpen = true;
  card.inviteError = null;

  // Already derived on this mount — deterministic, so nothing can have
  // changed it. Show it again without a second round trip.
  if (card.inviteToken) { render(token); return; }

  card.inviteLoading = true;
  render(token);

  try {
    const res = await fetch('/api/sharedbrain/generate-invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(inviteRequestBody(conn)),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || typeof data.token !== 'string' || !data.token) {
      throw new Error(data.error || 'The invite token could not be re-generated (HTTP ' + res.status + ').');
    }
    card.inviteToken = data.token;
    card.inviteError = null;
  } catch (err) {
    card.inviteToken = null;
    card.inviteError = err.message;
  } finally {
    card.inviteLoading = false;
    if (isCurrentMount(token)) {
      state.expandedAdmin.add(connId);
      render(token);
    }
  }
}

function copyInviteToken(token, connId) {
  const card = ensureCard(connId);
  const value = card.inviteToken;
  if (!value) return;
  const done = (msg, isError) => {
    card.message = msg;
    card.error = !!isError;
    if (isCurrentMount(token)) render(token);
  };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(
        () => done('Invite token copied to the clipboard.', false),
        () => done('Could not copy automatically — select the invite token below and copy it by hand.', true)
      );
      return;
    }
  } catch { /* fall through to the manual message */ }
  done('Could not copy automatically — select the invite token below and copy it by hand.', true);
}

async function loadRevokeMembers(token, connId) {
  const card = ensureCard(connId);
  if (card.revokeMembers === 'loading') return;
  card.revokeMembers = 'loading';
  render(token);
  try {
    const res = await fetch('/api/sharedbrain/' + connId + '/members');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'members returned HTTP ' + res.status);
    card.revokeMembers = {
      members: Array.isArray(data.members) ? data.members : [],
      selfFellowId: data.self_fellow_id || null,
    };
  } catch (err) {
    card.revokeMembers = { error: err.message };
  } finally {
    if (isCurrentMount(token)) render(token);
  }
}

// The irreversible one. Guarded exactly like runSseAction(): card.acting
// for a second click on THIS mount, isDomainWriteBusy() for a click on a
// different (possibly abandoned) mount, re-checked here as well as at the
// click. The backend registers `shared-<slug>` for revoke, which is what
// domainsForAction() already returns for anything that is not a push — so
// client and server agree about what counts as busy.
async function runRevoke(token, connId) {
  const card = ensureCard(connId);
  // NIT (audit): siblings (startAction, onRotateAdminToken) surface a
  // message on this exact guard; this one used to be a silent no-op.
  if (card.acting) {
    card.message = 'An operation is already running on this connection — wait for it to finish.';
    card.error = true;
    render(token);
    return;
  }

  const conn = findConnection(connId);
  const aff = adminAffordances(conn, card);
  if (!aff.showRevoke) return;   // rule 4 at the action, not only in the render

  const member = selectedMemberOf(card);

  // Re-read the live inputs. card.revokeTokenPresent is only a boolean, and
  // an unrelated re-render (the cross-view write gate fires one) can empty
  // the password field while leaving that flag set — so the value that is
  // actually sent is read here, and a doomed request is refused locally
  // rather than turned into a confusing 403.
  const tokenEl = document.getElementById('sb-revoke-token-' + connId);
  const adminToken = tokenEl ? tokenEl.value.trim() : '';
  const confirmEl = document.getElementById('sb-revoke-confirm-' + connId);
  const typed = confirmEl ? confirmEl.value : card.revokeTyped;

  const busyDomain = domainsForAction(conn, 'revoke').find((d) => isDomainWriteBusy(d));
  const gate = revokeGateState({
    member,
    typed,
    tokenPresent: adminToken.length >= 16,
    busy: !!busyDomain,
  });
  if (!gate.unlocked) {
    card.revokeTyped = typed;
    card.revokeTokenPresent = adminToken.length >= 16;
    card.message = busyDomain
      ? 'A write (' + (getDomainWriteLabel(busyDomain) || 'write') + ') is already running for ' + busyDomain + ' — wait for it to finish.'
      : gate.reason;
    card.error = true;
    render(token);
    return;
  }

  // Rule 2: the admin typed REVOKE-<short_id>; the API requires the
  // full-UUID literal, built from the PICKED MEMBER's own fellow_id (short_id
  // has its hyphens stripped and cannot be expanded back).
  const confirmation = revokeConfirmationFor(member);
  const fellowId = member.fellow_id;

  card.acting = 'revoke';
  card.revokeOutcome = null;
  card.revokeProgress = 'Starting revocation…';
  card.message = 'Starting revocation…';
  card.error = false;
  state.expandedAdmin.add(connId);
  render(token);

  const releases = domainsForAction(conn, 'revoke').map((d) => beginDomainWrite(d, 'sharedbrain-revoke'));

  let acc = freshRevokeAcc();
  try {
    const res = await fetch('/api/sharedbrain/' + connId + '/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ admin_token: adminToken, fellow_id: fellowId, confirmation }),
    });

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/event-stream')) {
      // 403 / 400 / 409 land here. Never `(await res.json())` inside a throw —
      // a non-JSON body would surface as "Unexpected token '<'".
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Revocation refused (HTTP ' + res.status + ').');
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    // MEDIUM-4 (audit): the frame-buffering/absorption logic itself now
    // lives in consumeRevokeChunk/consumeRevokeStream (see their own
    // comments) so the offline suite can drive the exact same code this
    // loop runs. This loop's OWN and ONLY "keep going" decision is
    // `reader.read()`'s `done` flag, right below — there is no other
    // early-exit path here, on purpose.
    let consumeState = { acc, buf: '' };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        // Read to STREAM END — never break on a terminal frame; see
        // "THE SSE TRAP" above.
        if (done) break;
        consumeState = consumeRevokeChunk(consumeState, dec.decode(value, { stream: true }), (frameAcc) => {
          // Live progress line only. Once a terminal frame has been
          // absorbed, sawTerminal flips and this stops overwriting
          // card.message — the outcome rendered from `acc` after the loop
          // takes over instead (see "THE SSE TRAP" for why absorption
          // still continues past that point regardless).
          if (!frameAcc.sawTerminal && frameAcc.lastMessage) {
            card.revokeProgress = frameAcc.lastMessage;
            card.message = frameAcc.lastMessage;
            card.error = false;
            if (isCurrentMount(token)) render(token);
          }
        });
      }
    } finally {
      acc = consumeState.acc;
      reader.cancel().catch(() => {});
    }

    if (!acc.sawTerminal) {
      acc.errorMessage = 'The revocation stream ended without a result — treat this contributor’s data as NOT erased and re-run the revocation.';
    }
  } catch (err) {
    acc.errorMessage = err.message;
  } finally {
    releases.forEach((r) => r());
    const outcome = classifyRevokeOutcome(acc);
    card.revokeOutcome = outcome;
    card.revokeProgress = null;
    card.message = outcome.headline;
    card.error = outcome.tone !== 'success';
    // Terminal beats pending: cleared in the SAME synchronous block that
    // set the final outcome, before the single render below.
    card.acting = null;
    // The token and confirmation are single-use — clear the gate so a second
    // irreversible run needs the whole ceremony again.
    card.revokeTyped = '';
    card.revokeTokenPresent = false;
    card.revokeSelectedFellowId = null;
    card.revokeMembers = null;
    if (isCurrentMount(token)) {
      state.expandedAdmin.add(connId);
      render(token);
      // The member directory was invalidated above, and NOTHING else reloads
      // it — loadRevokeMembers only runs on revoke-open. Found in browser
      // verification: after a refused run the panel sat on "Loading the
      // contributor list…" forever, with no way forward but closing and
      // re-opening it. The reset was right (a stale list after a successful
      // erasure would offer a contributor who no longer exists); leaving the
      // panel with no way to repopulate was the half that was broken.
      //
      // MEDIUM-3 (audit): both of these fire their OWN render() once they
      // resolve, and each of those re-renders can push .sb-outcome further
      // down the page (loadRevokeMembers re-expands the panel underneath
      // it; refreshConnections repaints the whole card list). Reveal the
      // outcome only after every render that can still move it has run —
      // scrolling right after the render above would be provably too early.
      const settling = [];
      if (card.revokeOpen) settling.push(loadRevokeMembers(token, connId).catch(reportAsyncActionFailure));
      // A completed revoke changes what /list reports. Refreshed only on the
      // SUCCESS path — a failed run's outcome panel is the thing the admin
      // must read, and a list error would flip the whole view to its error
      // branch, which renders no cards at all.
      if (outcome.tone === 'success') settling.push(refreshConnections(token).catch(reportAsyncActionFailure));
      if (settling.length > 0) {
        Promise.all(settling).then(() => { if (isCurrentMount(token)) revealRevokeOutcome(connId); });
      } else {
        revealRevokeOutcome(connId);
      }
    }
  }
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

  document.querySelectorAll('.sb-card-admin[data-sb-admin]').forEach((el) => {
    el.addEventListener('toggle', () => {
      const id = el.dataset.sbAdmin;
      if (el.open) state.expandedAdmin.add(id); else state.expandedAdmin.delete(id);
    });
  });

  // Revoke gate inputs. The confirmation text is kept in card state (it is
  // not a secret) so a re-render preserves it; the admin token is NOT —
  // only the boolean "is something long enough typed" is recorded, and the
  // value itself never leaves the DOM until runRevoke() reads it for the
  // one request body. See runRevoke()'s own comment for the re-read.
  document.querySelectorAll('.sb-card[data-conn-id]').forEach((cardEl) => {
    const connId = cardEl.dataset.connId;
    const card = ensureCard(connId);
    cardEl.querySelectorAll('input[data-sb-input]').forEach((input) => {
      input.addEventListener('input', () => {
        if (input.dataset.sbInput === 'confirm') card.revokeTyped = input.value;
        else card.revokeTokenPresent = input.value.trim().length >= 16;
        updateRevokeGateUi(cardEl, connId);
      });
    });
    cardEl.querySelectorAll('input[data-sb-member]').forEach((radio) => {
      radio.addEventListener('change', () => {
        selectRevokeMember(card, radio.dataset.sbMember);
        render(token);
      });
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

    // ── Admin controls ──────────────────────────────────────────────────
    case 'rotate-open': card.rotateConfirmOpen = true; render(token); return;
    case 'rotate-cancel': card.rotateConfirmOpen = false; render(token); return;
    case 'rotate-confirm': onRotateAdminToken(token, connId).catch(reportAsyncActionFailure); return;
    case 'token-hide': card.shownAdminToken = null; render(token); return;
    case 'token-copy': copyShownAdminToken(token, connId); return;
    case 'invite-show': onShowInvite(token, connId).catch(reportAsyncActionFailure); return;
    case 'invite-hide':
      card.inviteOpen = false;
      card.inviteError = null;
      // card.inviteToken is deliberately KEPT — it is public metadata, not
      // a secret, so re-showing it should not re-hit the network.
      render(token);
      return;
    case 'invite-copy': copyInviteToken(token, connId); return;
    case 'revoke-open':
      card.revokeOpen = true;
      card.revokeOutcome = null;
      state.expandedAdmin.add(connId);
      render(token);
      if (card.revokeMembers === null) loadRevokeMembers(token, connId).catch(reportAsyncActionFailure);
      return;
    case 'revoke-close':
      card.revokeOpen = false;
      // Single-use ceremony: closing the panel drops the typed
      // confirmation and the token-present flag, so re-opening it cannot
      // start already half-unlocked.
      card.revokeTyped = '';
      card.revokeTokenPresent = false;
      card.revokeSelectedFellowId = null;
      card.revokeMembers = null;
      render(token);
      return;
    case 'revoke-run': runRevoke(token, connId).catch(reportAsyncActionFailure); return;

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
