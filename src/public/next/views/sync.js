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
  registerView, setSidebar, setMain, escapeHtml, icon, navigate, isCurrentMount,
  reportAsyncMountFailure, reportAsyncActionFailure,
  isAnyWriteBusy, getDomainWriteLabel, onWriteGateChange,
  refreshSyncBadge, refreshSyncRemoteBadge,
} from '../app.js';
import { createLoadingGate, gatedLoader, settleGate } from '../shared/loading-gate.js';
// The ONE text system in /next. renderViewHeader owns the top of this view so a
// paragraph cannot float under the title; renderStatus carries the cross-write
// refusal that used to live in a `title=` on a DISABLED button (see below).
import { renderViewHeader, renderStatus } from '../shared/text.js';

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
    // `decision` is the connect flow's second screen, and it exists because
    // of the v3.32.0 incident: a refusal that leaves only a destructive door
    // open is not a guard. Shapes: null (no decision pending),
    // {kind:'overwrite', count, sample, createCount}, {kind:'adopt', originUrl},
    // {kind:'foreign', originUrl}, {kind:'remote-empty'|'remote-not-empty'}.
    // Every one of them offers at least one NON-destructive way forward.
    setupForm: {
      repoUrl: '', token: '', mode: 'push', submitting: false, error: null,
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
    renderViewHeader({
      variant: 'sidebar',
      title: 'Sync',
      info: 'Pages, chats and schemas travel; source files and keys stay here.',
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
      info: 'Every push and pull is a real git commit, and a pull auto-saves your local changes before merging. There is no revert control in the app, but a git client pointed at your knowledge-base folder can browse that history and roll back.',
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
        '<input type="password" class="mono sync-setup-input" id="setup-token" placeholder="ghp_… or a fine-grained token">' +
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
      (f.error ? '<div class="settings-inline-error">' + escapeHtml(f.error) + '</div>' : '') +
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
        '<p class="sync-decision-body">Another Curator install on this Mac already syncs this domains folder ' +
        'to the same repository. This install will use that same sync history instead of starting a second ' +
        'one \u2014 nothing in your folder is changed.</p>' +
        '<div class="sync-decision-actions">' +
          '<button type="button" class="btn btn-primary" id="btn-decide-go"' + dis + '>' +
            (busy ? 'Connecting\u2026' : 'Connect') + '</button>' +
          '<button type="button" class="btn btn-secondary" id="btn-decide-cancel">Cancel</button>' +
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
          '<button type="button" class="btn btn-secondary" id="btn-decide-cancel">Cancel</button>' +
        '</div>' +
      '</div>'
    );
  }

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
      '<div class="sync-status-top">' +
        '<span class="status-pill status-pill-ok"><span class="status-pill-dot"></span>Connected</span>' +
        '<code class="mono sync-repo">' + escapeHtml(s.repoUrl || '') + '</code>' +
        '<span class="sync-last">last synced ' + escapeHtml(lastSyncLabel) + '</span>' +
      '</div>' +
      (state.statusError ? '<div class="settings-inline-error">' + escapeHtml(state.statusError) + '</div>' : '') +
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
            detail: 'Another Curator install on this Mac also syncs this domains folder, through its own ' +
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
        '<span class="sync-pending-note">' + escapeHtml(String(pendingCount)) + ' local change' + (pendingCount === 1 ? '' : 's') + ' not pushed</span>' +
      '</div>' +
      (state.actionMessage ? '<div class="sync-action-note">' + escapeHtml(state.actionMessage) + '</div>' : '') +
      (state.actionError ? '<div class="settings-inline-error" style="margin-top:8px">' + escapeHtml(state.actionError) + '</div>' : '') +
    '</div>' +

    renderSharedBrainRow() +

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
      '<span class="sync-sb-meta">' + label + '</span>' +
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
  return '<button type="button" class="sync-disconnect-link" id="btn-disconnect-open"' + (disabled ? ' disabled' : '') + '>Disconnect this repository</button>';
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

    // Decision-panel buttons. `confirmOverwrite` is passed as a literal
    // `true` from exactly ONE of them and nowhere else in this file — the
    // one the user reaches only after seeing the count and the file list.
    const dMerge = document.getElementById('btn-decide-merge');
    if (dMerge) dMerge.addEventListener('click', () => runSetup('merge', false, myMountToken));
    const dOver = document.getElementById('btn-decide-overwrite');
    if (dOver) dOver.addEventListener('click', () => runSetup('pull', true, myMountToken));
    const dGo = document.getElementById('btn-decide-go');
    if (dGo) dGo.addEventListener('click', () => runSetup(state.setupForm.mode, false, myMountToken));
    const dCancel = document.getElementById('btn-decide-cancel');
    if (dCancel) dCancel.addEventListener('click', () => {
      state.setupForm.decision = null;
      state.setupForm.error = null;
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
  render(token);
  try {
    const res = await fetch('/api/sync/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoUrl, token: pat, mode, confirmOverwrite: confirmOverwrite === true }),
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
        throw new Error(data.error || 'Could not connect.');
      }
      state.setupForm.submitting = false;
      render(token);
      return;
    }
    if (!isCurrentMount(token)) return;
    await loadStatus(token);
    if (!isCurrentMount(token)) return;
    state.setupForm = freshState().setupForm;
  } catch (err) {
    if (!isCurrentMount(token)) return;
    state.setupForm.decision = null;
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
  if (kind === 'push') {
    if (data.pushed === false) return data.message || 'Everything is already up to date.';
    return 'Pushed ' + fileCount(data.filesChanged || 0) + ' to GitHub.';
  }

  if (kind === 'pull') {
    const n = data.filesChanged || 0;
    const pruned = describePruned(data.pruned);
    const kept = describePruneKept(data.prunedKept);
    if (n === 0 && !pruned && !kept) return 'Already up to date — nothing new on GitHub.';
    const parts = [];
    if (n > 0) parts.push('Pulled ' + fileCount(n) + ' from GitHub');
    if (pruned) parts.push(pruned);
    if (kept) parts.push(kept);
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
  const kept = describePruneKept(pullResult.prunedKept);
  if (kept) parts.push(kept);

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
