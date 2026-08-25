// Shared Brain setup wizard — a faithful PORT of the shipping app's
// five-step #sharedbrain-wizard (src/public/index.html markup +
// src/public/app.js's sbWizard/*Sb* functions), restyled to the /next
// design system. Read this file's own comments together with the task
// brief before changing ANYTHING here: this module is the single place
// in the /next shell that handles a GitHub Personal Access Token and a
// Shared Brain admin token — the highest-risk credential path in the
// app. The governing rule is "port the FLOW verbatim, restyle the CHROME
// only" — every behaviour below is a real bug that was found and fixed
// in the shipping wizard (see CLAUDE.md's v3.0.4 / v3.0.5 changelog
// entries) and MUST survive this port unchanged:
//
//   1. Outbound links (the step-2 "Open the repo on GitHub" link, the
//      step-3 PAT-create deep link) populate on panel ENTRY, inside
//      goToStep() — never when LEAVING the previous panel. Before the
//      shipping fix, step 2's link was empty on first entry: the one
//      step designed to resolve collaborator-invite confusion opened
//      the Curator itself.
//   2. Step-4 domain checkboxes are REBUILT CHECKED from the saved
//      `state.selectedDomains`, with stale selections (a domain that no
//      longer exists) pruned against the live domain list, every time
//      the panel is populated — see populateDomains(). This only runs
//      from step 3's "Continue" handler, not from goToStep() itself and
//      not from Back — exactly mirroring the shipping call graph, so a
//      Back-then-forward through step 3 rebuilds the list (and must
//      still show prior selections); a Back FROM step 5 into step 4
//      alone does not rebuild anything, because the checkbox DOM nodes
//      already reflect state.selectedDomains and are never torn down
//      just by moving between already-populated panels.
//   3. Both debounced validations (invite-token parse in step 1, PAT
//      validate in step 3) carry MONOTONIC SEQUENCE GUARDS — a slow
//      response for an old input value can never overwrite the verdict
//      for whatever the user has typed since.
//   4. The PAT is stored in wizard state ONLY after a valid (or
//      valid-but-read-only) verdict from POST /validate-pat. A
//      rejected or stale token is never carried into `state.pat`.
//   5. Wizard state — including the PAT and the admin token — is reset
//      after a successful save, AND on close. This port goes one step
//      further than the shipping app for the same reason: close()
//      removes the wizard's DOM subtree from the document entirely
//      (not just hidden) AND explicitly clears the PAT input's .value
//      before detaching it (see closeWizard()'s own comment — root.remove()
//      alone does not clear an input's value, only take it out of the
//      document) AND cancels both debounced timers (an audit found one of
//      them could otherwise still run post-close and reach for
//      state.inviteMetadata, which by then had already gone null — an
//      INCIDENTAL guard, not a deliberate one; see the L4 fix in
//      closeWizard() and the hoisted freshness checks in bindStep1/
//      bindStep3 for the actual, deliberate guarantee this now rests on).
//   6. Accessibility: role="dialog", aria-modal="true", aria-labelledby;
//      Escape closes; Tab is focus-trapped inside the card; focus moves
//      to the active panel's <h3> on every step change; focus returns
//      to whatever had focus before the wizard opened, on close;
//      progress pips carry aria-current="step" on the active step;
//      status regions are aria-live="polite".
//   7. The admin token (Phase 4.1's revocation credential) is shown
//      ONCE, on admin step 2. The FIRST generated admin token is kept
//      if the admin goes Back and regenerates the invite — the invite
//      token is deterministic (safe to regenerate), the admin token is
//      random, and silently replacing an already-noted-down token would
//      strand the admin from ever revoking a contributor again.
//   8. This wizard NEVER sends a PAT/admin-token value that ends in the
//      masking ellipsis ("…") back to the server — it only ever holds
//      a freshly-typed, freshly-validated credential in memory. The
//      server-side refusal of a masked value (sharedbrain-config.js
//      validateConnection) is a defence this wizard's own design keeps
//      out of reach of, not something it needs to work around.
//
// FIXES APPLIED AFTER AN INDEPENDENT AUDIT (all reproduced live before
// being fixed, and re-verified after):
//   H1 (HIGH) — a PAT verdict obtained for repo A survived an invite-token
//       edit to repo B: no re-validation call fired, Continue stayed
//       enabled, and a save could persist `read_only` derived from a repo
//       the PAT was never checked against. Fixed via setInviteMetadata()/
//       resetPatVerdict()/currentValidatedPat() — see their own comments,
//       just above isFresh() and around isReadOnlyVerdict()/bindStep5.
//   M2 — admin step 1's branch field was never validated client-side
//       (despite a comment claiming it mirrored the server's checks
//       verbatim) — a malformed branch advanced past this step and 200'd
//       from POST /generate-invite, only to be refused by every
//       contributor's own parse-invite AND, for the admin, by /save five
//       panels later. Fixed in bindAdminStep1's validation block below,
//       using the exact rule src/routes/sharedbrain.js's decodeInviteToken
//       and src/brain/sharedbrain-config.js's validateConnection both use.
//   M3 — Escape, the backdrop click, and the Close button had no
//       AbortController on the save fetch and no in-flight check, so any
//       of them closed the wizard instantly while POST /save kept running
//       server-side with zero further feedback. Fixed via isSaveBlocking()
//       (used by onWizardKeydown and bindChrome) and setSaveChromeDisabled
//       (used by bindStep5's save handler) — see their own comments, and
//       closeSharedBrainWizardIfOpen's comment for the deliberate decision
//       to leave rail-navigation UNguarded (already safe by construction).
//   L4 — both debounced timers (invite-token parse, PAT validate) were
//       neither cancelled on close nor gated by a freshness check BEFORE
//       their first `await` — only after. Fixed in closeWizard() (cancels
//       both timers, explicitly clears the PAT input's value) and in
//       bindStep1/bindStep3 (freshness check hoisted above the fetch).
//   N5 — bindStep5's save handler built `connection` (including
//       `meta.name.toLowerCase()` / `meta.repo.split('/')`) OUTSIDE its
//       own try/catch; unreachable today, but a future throw there would
//       have left "Saving…" stuck with no recovery but a now-blocked
//       Escape (see M3). Moved inside the try.
//
// CREDENTIAL DISCIPLINE, additional to the eight points above:
//   - The PAT and the admin token exist ONLY in this module's `state`
//     object. They are never written to localStorage, sessionStorage, a
//     URL, or any console/log line — grep this file for
//     `localStorage`/`sessionStorage`/`console.` to re-verify that on
//     every future edit.
//   - `wizardGen` is a plain module-level counter (never part of the
//     replaceable `state` object, exactly the reasoning app.js's own
//     `mountToken` docblock gives for keeping ITS counter outside any
//     replaceable state) — bumped on every open() AND on every close().
//     Every async handler captures `const myGen = wizardGen` as its
//     FIRST statement (before any `await`), and re-checks
//     `myGen === wizardGen` after every `await`, before touching
//     `state.*` OR the DOM. This closes the case a naive "reset state,
//     re-check isOpen" guard would miss: state is wholesale REPLACED by
//     freshState() on both open() and close(), so a stale response
//     landing after a close-then-reopen could otherwise alias into a
//     brand-new session's state (the same trap app.js's docblock names
//     for its own mountToken).
//   - close() removes the wizard's root DOM node from the document
//     entirely (`root.remove()`), not merely a hidden-class toggle, AND
//     explicitly clears the PAT input's `.value` before removal, AND
//     cancels both debounced timers before either of those — see
//     closeWizard()'s own comment for the specific gap this closes (an
//     audit found the PAT-timer's only protection against firing
//     post-close was an INCIDENTAL side effect of `state` being replaced,
//     not a deliberate guard). What this actually guarantees: no reachable
//     reference to the PAT survives close() — not "no stray input element
//     could ever hold one", which overclaimed what root.remove() alone
//     does (it detaches a node; it does not clear its value).
//
// Owned only by views/shared.js — never registered as a view (no
// registerView() call here), never imported anywhere else.

import { escapeHtml, icon } from '../app.js';

// ── State ────────────────────────────────────────────────────────────────

function freshState() {
  return {
    mode: 'join',            // 'join' | 'create'
    step: 1,
    onSaved: null,             // caller's refresh callback, run after a real save
    prevFocus: null,

    // Step 1 — invite token
    inviteMetadata: null,       // {repo, name, branch, shared_domain, storage_type, data_handling_terms}
    step1Seq: 0,
    step1Debounce: null,

    // Step 3 — PAT
    pat: '',                      // set ONLY after a valid/warn verdict — see rule 4 above
    patValidation: null,           // {valid, hasWriteAccess, ...} | null
    patValidatedRepo: null,         // H1 fix — the repo `pat`/`patValidation` were actually checked against; see currentValidatedPat()/isReadOnlyVerdict() below
    patSeq: 0,
    patDebounce: null,

    // Step 4 — domains + display name
    selectedDomains: new Set(),
    displayName: '',
    attributeByName: false,

    // Step 5 — save
    consent: false,
    saveInProgress: false,

    // Admin path
    slugManuallyEdited: false,
    generatedInviteToken: null,
    generatedAdminToken: null,     // kept across a Back+regenerate — rule 7 above
  };
}

let state = freshState();
let wizardGen = 0;   // module-level, NEVER part of `state` — see the file header
let root = null;      // the wizard's own detached DOM subtree, or null when closed

function isFresh(myGen) { return myGen === wizardGen; }

// ── H1 fix: a PAT verdict is only trustworthy for the repo it was ─────────
// actually checked against.
//
// Bug (found by audit, reproduced live before this fix): state.pat and
// state.patValidation were cleared ONLY inside step 3's own 'input'
// handler. state.inviteMetadata is (re)assigned in three other places
// (step 1's parse-invite success, admin step 1's generate-invite success)
// and NONE of them touched the verdict — so pasting a token for repo A,
// validating a PAT, going Back, and pasting a token for repo B carried
// the repo-A verdict straight into a save for repo B: no /validate-pat
// call for B, Continue stayed enabled, and the saved connection's
// `read_only` flag (the ONLY thing step 3 exists to produce) described a
// repository the PAT was never checked against. Reproduced both
// directions; captured payload showed `read_only: false` for a PAT that
// was actually only ever validated against a different repo.
//
// setInviteMetadata() is the single assignment point for
// state.inviteMetadata — every call site below goes through it instead of
// writing the field directly, so the reset can't be forgotten at a future
// call site. But per the audit's own framing, "clear on the event that
// usually causes staleness" is a fragile shape by itself (an event can be
// missed, mis-ordered, or bypassed by a future edit) — the DURABLE
// guarantee is currentValidatedPat()/isReadOnlyVerdict() below, which are
// the ONLY two ways the rest of this file reads the verdict, and BOTH
// independently refuse to return anything unless state.patValidatedRepo
// still equals state.inviteMetadata.repo. Losing the proactive reset
// still degrades gracefully (Continue would show a stale-looking success
// state, but bindStep5's save can never actually SEND that stale verdict
// or derive read_only from it); losing the accessor guard would not.
function setInviteMetadata(newMeta) {
  const oldRepo = state.inviteMetadata && state.inviteMetadata.repo;
  state.inviteMetadata = newMeta;
  const newRepo = newMeta && newMeta.repo;
  if (oldRepo !== newRepo) resetPatVerdict();
}

// Clears the PAT/verdict and visibly resets step 3's UI (re-disables
// Continue, hides the validation box) — all panels exist in the DOM
// simultaneously while the wizard is open, so this is safe to call
// regardless of which step is currently visible.
function resetPatVerdict() {
  state.pat = '';
  state.patValidation = null;
  state.patValidatedRepo = null;
  const nextBtn = byId('sbw-step3-next');
  if (nextBtn) nextBtn.disabled = true;
  const validation = byId('sbw-pat-validation');
  if (validation) {
    validation.textContent = '';
    validation.className = 'sbw-status sbw-hidden';
  }
}

// The only way bindStep5's save handler may read the PAT — returns '' (an
// obviously-unusable value, never the real token) unless the verdict on
// file was actually obtained for the CURRENT invite metadata's repo.
function currentValidatedPat() {
  if (!state.inviteMetadata || !state.patValidation) return '';
  if (state.patValidatedRepo !== state.inviteMetadata.repo) return '';
  return state.pat;
}

// ── Panel / label tables (mirrors SB_STEP_PANELS / SB_STEP_LABELS) ────────

const STEP_PANELS = {
  join:   ['step-1', 'step-2', 'step-3', 'step-4', 'step-5'],
  create: ['admin-step-1', 'admin-step-2', 'step-3', 'step-4', 'step-5'],
};
const STEP_LABELS = {
  join:   ['Token', 'Access', 'PAT', 'Domains', 'Save'],
  create: ['Setup', 'Invite', 'PAT', 'Domains', 'Save'],
};
const ALL_PANEL_IDS = Array.from(new Set([...STEP_PANELS.join, ...STEP_PANELS.create]));

function byId(id) { return root ? root.querySelector('#' + id) : null; }
function qsa(sel) { return root ? Array.from(root.querySelectorAll(sel)) : []; }

// ── Open / close ─────────────────────────────────────────────────────────

// opts.onSaved(): called once, after a real successful save (i.e. never on
// Cancel/Escape/close-without-saving). Callers pass their own refresh —
// see views/shared.js.
export function openSharedBrainWizard(mode, opts) {
  if (root) return; // one instance at a time — defensive, the CTA buttons that call this are never both visible+enabled at once anyway
  wizardGen += 1;
  const myGen = wizardGen;

  state = freshState();
  state.mode = mode === 'create' ? 'create' : 'join';
  state.onSaved = (opts && typeof opts.onSaved === 'function') ? opts.onSaved : null;
  state.prevFocus = document.activeElement;

  root = document.createElement('div');
  root.innerHTML = wizardShellHtml(state.mode);
  document.body.appendChild(root);

  document.addEventListener('keydown', onWizardKeydown, true);

  bindChrome();
  bindStep1();
  bindStep2();
  bindAdminStep1();
  bindAdminStep2();
  bindStep3();
  bindStep4();
  bindStep5();

  goToStep(1, myGen);
}

// Safe to call whether or not the wizard is open — used by views/shared.js
// so navigating away from the Shared Brain view always closes any open
// wizard rather than leaving a credential-holding overlay mounted behind
// the next view.
//
// M3 DECISION — deliberately NOT gated on isSaveBlocking(), unlike
// Escape/backdrop/Close. Reasoning:
//   (a) The rail-navigation contract this shell already enforces (see
//       app.js's navigate(): an overlay must never survive a view change)
//       is a hard, unconditional rule the whole shell relies on. Carving
//       out "unless a Shared Brain save is in flight" would make this the
//       one view whose overlay can trap the user on it against a rail
//       click — a worse UX than the thing M3 is fixing.
//   (b) It is already SAFE by construction, not merely convenient:
//       closeWizard() bumps wizardGen, and bindStep5's save handler's own
//       `if (!isFresh(myGen)) return;` (present before this fix, for the
//       unrelated close-during-save race) means the in-flight fetch
//       finishes in the background but its result-handling — including
//       closeWizard()+onSaved() on success — becomes a no-op. The POST
//       still completes server-side (the connection IS created; nothing
//       is silently lost), it just isn't reflected by THIS callback. The
//       next time the user opens Shared Brain, GET /list runs fresh
//       (loadConnections in views/shared.js, unrelated to wizardGen) and
//       shows it. No token round-trips twice, nothing hangs.
//   (c) L4's fix (clearing the PAT input's value before root.remove())
//       applies here too, since this function calls the same closeWizard()
//       — so navigating away mid-save leaves no credential in a detached
//       node any more than an ordinary close does.
// If a future change makes the save itself abortable (an AbortController,
// matching this app's own v3.4.0 ingest-cancel precedent), navigate-away
// would be the natural place to also abort it — deliberately out of scope
// here since M3 asked about dismiss gestures on an open dialog, not about
// making the write itself cancellable.
export function closeSharedBrainWizardIfOpen() {
  if (root) closeWizard();
}

function closeWizard() {
  if (!root) return;
  wizardGen += 1; // any in-flight handler from this session is now stale — see the file header

  // L4 fix, belt: cancel both debounce timers outright. Before this, the
  // freshness check inside each timer's callback only ran AFTER `await
  // fetch(...)` — so the callback itself, and everything before the
  // first await, still executed post-close. For the PAT timer specifically
  // that meant it still called `state.inviteMetadata` (by then null, since
  // `state` had already been replaced below) — the ONLY thing stopping the
  // validate-pat POST (carrying the real PAT) from firing was that
  // incidental null-check, not a deliberate guard. See the file header:
  // "the check does not reach what it was written to protect" is the named
  // failure shape this closes. (The L4 fix, suspenders — hoisting the
  // freshness check to the TOP of each callback, before any await — lives
  // in bindStep1/bindStep3 themselves, so this protection holds even if a
  // future edit ever left a debounce timer running past a close by some
  // other path.)
  clearTimeout(state.step1Debounce);
  clearTimeout(state.patDebounce);

  // L4 fix: explicitly clear the PAT input's value before detaching it.
  // root.remove() takes the node out of the document, but does NOT clear
  // its .value — the input is garbage-COLLECTIBLE after this function
  // returns (nothing keeps a reference to it once `root` itself is reset
  // to null below), but for the instant between now and whenever the GC
  // actually runs, an unclearred detached node would still hold the full
  // PAT in memory, reachable by anything that happened to have captured a
  // reference to it (e.g. a timer closure — see the clearTimeout calls
  // just above for why that specific path is now also closed). This line
  // is what the docblock's "no stray input element can keep holding a
  // typed credential" claim actually rests on — root.remove() alone did
  // not make that claim true.
  const patInput = byId('sbw-pat-input');
  if (patInput) patInput.value = '';

  document.removeEventListener('keydown', onWizardKeydown, true);
  const prevFocus = state.prevFocus;
  root.remove();
  root = null;
  state = freshState(); // wipes pat / generatedAdminToken / everything else — rule 5 above
  if (prevFocus && typeof prevFocus.focus === 'function') {
    try { prevFocus.focus(); } catch { /* element may be gone */ }
  }
}

// M3 fix: the single check every dismiss path (Escape, backdrop click, the
// Close button, the Cancel buttons on step 1/admin step 1) goes through.
// Escape had NO AbortController on the save fetch and NO check here, so it
// closed the wizard instantly while the credential-carrying POST /save
// kept running in the background with zero further UI feedback — a user
// pressing Escape during a save reasonably believes they cancelled it;
// they did not, and the resulting connection (holding their real PAT)
// doesn't appear until they leave Shared Brain and come back. Reproduced
// live before this fix with millisecond timestamps: the wizard's DOM was
// gone ~7ms after Escape while the mocked save didn't even start firing
// until ~4.25s later. This function is intentionally the ONLY place that
// answers "is a dismiss allowed right now" — every call site below reads
// it rather than re-deriving its own copy of the condition.
function isSaveBlocking() { return !!(root && state.saveInProgress); }

// v3.0.4 (L16) parity: Escape closes; Tab cycles within the wizard card.
function onWizardKeydown(e) {
  if (!root) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    if (isSaveBlocking()) return; // M3 fix — see isSaveBlocking's comment
    closeWizard();
    return;
  }
  if (e.key !== 'Tab') return;
  const focusables = qsa(
    'button:not([disabled]), a[href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'
  );
  const visible = focusables.filter((el) => el.offsetParent !== null);
  if (visible.length === 0) return;
  const first = visible[0];
  const last = visible[visible.length - 1];
  if (e.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) {
    e.preventDefault();
    first.focus();
  }
}

// ── Step navigation ──────────────────────────────────────────────────────

function goToStep(n, myGen) {
  if (!isFresh(myGen)) return;
  state.step = n;
  const panelIds = STEP_PANELS[state.mode];

  for (const id of ALL_PANEL_IDS) {
    const panel = byId('sbw-panel-' + id);
    if (panel) panel.classList.add('sbw-hidden');
  }
  const activeId = panelIds[n - 1];
  const active = activeId ? byId('sbw-panel-' + activeId) : null;
  if (active) active.classList.remove('sbw-hidden');

  // Rule 1 — link population happens on ENTRY, here, not on leaving the
  // previous panel.
  if (activeId === 'step-2') refreshStep2Links();
  if (activeId === 'step-3') refreshPatCreateLink();

  const labels = STEP_LABELS[state.mode];
  qsa('.sbw-pip').forEach((el) => {
    const num = Number(el.dataset.step);
    el.classList.toggle('active', num === n);
    el.classList.toggle('done', num < n);
    if (num === n) el.setAttribute('aria-current', 'step');
    else el.removeAttribute('aria-current');
    const labelEl = el.querySelector('[data-label]');
    if (labelEl && labels[num - 1]) labelEl.textContent = labels[num - 1];
  });

  if (active) {
    const heading = active.querySelector('h3');
    if (heading) {
      heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: false });
    }
  }
}

// ── Markup ───────────────────────────────────────────────────────────────

function wizardShellHtml(mode) {
  const title = mode === 'create' ? 'Set up a new Shared Brain' : 'Join a Shared Brain';
  const subtitle = mode === 'create'
    ? 'Create one for your cohort, team, or research group.'
    : 'Connect to your cohort’s collective wiki.';

  return (
    '<div class="sbw-scrim open" id="sbw-scrim">' +
      '<div class="sbw-card" role="dialog" aria-modal="true" aria-labelledby="sbw-title">' +
        '<button type="button" class="sbw-close" id="sbw-close" aria-label="Close">' + icon('x', 15) + '</button>' +
        '<div class="sbw-header">' +
          '<div class="sbw-header-icon">' + icon('users', 22) + '</div>' +
          '<h2 class="sbw-title" id="sbw-title">' + escapeHtml(title) + '</h2>' +
          '<p class="sbw-subtitle">' + escapeHtml(subtitle) + '</p>' +
        '</div>' +

        '<div class="sbw-progress">' +
          [1, 2, 3, 4, 5].map((n, i) => (
            (i > 0 ? '<div class="sbw-pip-line"></div>' : '') +
            '<div class="sbw-pip' + (n === 1 ? ' active' : '') + '" data-step="' + n + '">' +
              '<span class="sbw-pip-num mono">' + n + '</span>' +
              '<span class="sbw-pip-label" data-label="step' + n + '"></span>' +
            '</div>'
          )).join('') +
        '</div>' +

        panelStep1() +
        panelStep2() +
        panelAdminStep1() +
        panelAdminStep2() +
        panelStep3() +
        panelStep4() +
        panelStep5() +
      '</div>' +
    '</div>'
  );
}

function panelStep1() {
  return (
    '<div id="sbw-panel-step-1" class="sbw-panel">' +
      '<h3>Paste your invite token</h3>' +
      '<p class="sbw-hint">Your cohort admin should have shared a token starting with <code>sbi_</code>. It carries the repo name and metadata — no credentials.</p>' +
      '<div class="sbw-field">' +
        '<label class="sbw-label" for="sbw-invite-token">Invite token</label>' +
        '<input type="text" id="sbw-invite-token" class="sbw-input mono" placeholder="sbi_..." autocomplete="off" spellcheck="false">' +
      '</div>' +
      '<div id="sbw-invite-preview" class="sbw-preview sbw-hidden">' +
        '<h4>' + icon('check', 13) + ' Token verified</h4>' +
        '<dl>' +
          '<dt>Brain name</dt><dd data-field="name"></dd>' +
          '<dt>GitHub repo</dt><dd class="mono" data-field="repo"></dd>' +
          '<dt>Branch</dt><dd class="mono" data-field="branch"></dd>' +
          '<dt>Shared domain slug</dt><dd class="mono" data-field="shared_domain"></dd>' +
        '</dl>' +
      '</div>' +
      '<div id="sbw-step1-status" class="sbw-status sbw-hidden" aria-live="polite"></div>' +
      '<div class="sbw-actions">' +
        '<button type="button" class="btn btn-ghost" data-sbw-action="close">Cancel</button>' +
        '<button type="button" class="btn btn-primary" id="sbw-step1-next" disabled>Continue →</button>' +
      '</div>' +
    '</div>'
  );
}

function panelStep2() {
  return (
    '<div id="sbw-panel-step-2" class="sbw-panel sbw-hidden">' +
      '<h3>Confirm GitHub access</h3>' +
      '<p class="sbw-hint">Before we can connect, your admin needs to have invited you as a collaborator on the repo. GitHub sent you an email — accept it now if you haven’t.</p>' +
      '<div class="sbw-access-card">' +
        '<div class="sbw-access-icon">' + icon('alertCircle', 20) + '</div>' +
        '<div class="sbw-access-text">' +
          '<strong>Check your email</strong>' +
          '<span>Look for an invitation to <strong><span data-field="invite-repo">the cohort repo</span></strong> — the subject typically starts with “[GitHub]”. Click <strong>View invitation</strong> → <strong>Accept invitation</strong>.</span>' +
        '</div>' +
      '</div>' +
      '<a id="sbw-repo-link" href="" target="_blank" rel="noopener" class="btn btn-secondary sbw-link-btn">' + icon('folder', 14) + ' Open the repo on GitHub</a>' +
      '<p class="sbw-hint sbw-note-block">' + icon('alertCircle', 12) + ' Don’t see the invitation in your inbox? Check your spam folder, or ask the admin to resend it from the repo’s <strong>Settings → Collaborators</strong> page.</p>' +
      '<div class="sbw-actions">' +
        '<button type="button" class="btn btn-secondary" data-sbw-action="back">← Back</button>' +
        '<button type="button" class="btn btn-primary" id="sbw-step2-next">I’ve accepted — continue →</button>' +
      '</div>' +
    '</div>'
  );
}

function panelAdminStep1() {
  return (
    '<div id="sbw-panel-admin-step-1" class="sbw-panel sbw-hidden">' +
      '<h3>Set up a new Shared Brain</h3>' +
      '<p class="sbw-hint">First create a <strong>private</strong> GitHub repository for your cohort (any name works). You’ll paste its full name below. Then invite each cohort member as a collaborator on that repo — that’s how GitHub grants them write access.</p>' +
      '<a href="https://github.com/new" target="_blank" rel="noopener" class="btn btn-secondary sbw-link-btn">' + icon('plus', 14) + ' Open GitHub → create a new private repo</a>' +
      '<div class="sbw-field">' +
        '<label class="sbw-label" for="sbw-admin-repo">Repository <span class="sbw-label-note">(owner/name)</span></label>' +
        '<input type="text" id="sbw-admin-repo" class="sbw-input mono" placeholder="your-org/cohort-brain" autocomplete="off" spellcheck="false">' +
      '</div>' +
      '<div class="sbw-field">' +
        '<label class="sbw-label" for="sbw-admin-name">Brain name <span class="sbw-label-note">(a friendly label, not a URL)</span></label>' +
        '<input type="text" id="sbw-admin-name" class="sbw-input" placeholder="Spring 2026 ML Cohort">' +
        '<span class="sbw-help">Examples: “Spring 2026 ML Cohort”, “Marketing Research Team”, “PhD Reading Group”. Contributors see this in their Curator app.</span>' +
      '</div>' +
      '<div class="sbw-field-row">' +
        '<div class="sbw-field">' +
          '<label class="sbw-label" for="sbw-admin-shared-domain">Folder inside the repo <span class="sbw-label-note">(auto-filled)</span></label>' +
          '<input type="text" id="sbw-admin-shared-domain" class="sbw-input mono" placeholder="(auto from brain name)" autocomplete="off" spellcheck="false">' +
          '<span class="sbw-help">Where wiki pages live: <code>collective/&lt;this&gt;/wiki/</code>. Each contributor sees this as <code>shared-&lt;this&gt;</code> in their domain list.</span>' +
        '</div>' +
        '<div class="sbw-field">' +
          '<label class="sbw-label" for="sbw-admin-branch">Branch</label>' +
          '<input type="text" id="sbw-admin-branch" class="sbw-input mono" value="main" autocomplete="off" spellcheck="false">' +
          '<span class="sbw-help">Almost always <code>main</code>.</span>' +
        '</div>' +
      '</div>' +
      '<div class="sbw-field">' +
        '<label class="sbw-label">Data handling terms <span class="sbw-label-note">(can’t be changed after invites go out)</span></label>' +
        '<div class="sbw-dht-options">' +
          '<label class="sbw-dht-card">' +
            '<input type="radio" name="sbw-admin-dht" value="contributor_retains" checked>' +
            '<div class="sbw-dht-text"><strong>Contributor retains copyright</strong><span>For educational cohorts and research groups. Contributors keep copyright in their original wiki pages; the organisation owns the synthesised collective output.</span></div>' +
          '</label>' +
          '<label class="sbw-dht-card">' +
            '<input type="radio" name="sbw-admin-dht" value="organisational">' +
            '<div class="sbw-dht-text"><strong>Organisational (IP transfer)</strong><span>For enterprise deployments where employee contracts cover IP. Contributors assign copyright in contributed pages to the organisation at contribution time.</span></div>' +
          '</label>' +
        '</div>' +
      '</div>' +
      '<div id="sbw-admin-step1-status" class="sbw-status sbw-hidden" aria-live="polite"></div>' +
      '<div class="sbw-actions">' +
        '<button type="button" class="btn btn-ghost" data-sbw-action="close">Cancel</button>' +
        '<button type="button" class="btn btn-primary" id="sbw-admin-step1-next">Continue →</button>' +
      '</div>' +
    '</div>'
  );
}

function panelAdminStep2() {
  return (
    '<div id="sbw-panel-admin-step-2" class="sbw-panel sbw-hidden">' +
      '<h3>Share this invite token with your cohort</h3>' +
      '<p class="sbw-hint">Send the token below to each contributor by email or chat. They paste it in their own Curator wizard — it’s metadata only and contains no credentials.</p>' +
      '<div class="sbw-token-box">' +
        '<code id="sbw-admin-invite-token" class="sbw-token-display mono">sbi_…</code>' +
        '<button type="button" id="sbw-admin-copy-invite" class="btn btn-secondary btn-xs sbw-copy-btn">' + icon('copy', 13) + ' <span>Copy</span></button>' +
      '</div>' +
      '<div class="sbw-admin-token-block">' +
        '<h4>' + icon('lockAlt', 14) + ' Your admin token — keep it secret, store it now</h4>' +
        '<p class="sbw-hint">This token authorises <strong>contributor revocation</strong> (GDPR erasure). It is shown <strong>only here, only once</strong> — save it in your password manager. Do NOT share it with contributors; it is not the invite token above.</p>' +
        '<div class="sbw-token-box">' +
          '<code id="sbw-admin-admin-token" class="sbw-token-display mono">sbat_…</code>' +
          '<button type="button" id="sbw-admin-copy-admin-token" class="btn btn-secondary btn-xs sbw-copy-btn">' + icon('copy', 13) + ' <span>Copy</span></button>' +
        '</div>' +
      '</div>' +
      '<div class="sbw-checklist">' +
        '<h4>Now invite your contributors as collaborators</h4>' +
        '<ol>' +
          '<li>Open <a id="sbw-admin-collab-link" href="" target="_blank" rel="noopener">Settings → Collaborators</a> on your new repo.</li>' +
          '<li>Click <strong>Add people</strong>, type each contributor’s GitHub username or email, send.</li>' +
          '<li>Send them the invite token above. They run the Shared Brain wizard with the <strong>“I have an invite token”</strong> option.</li>' +
        '</ol>' +
        '<p class="sbw-hint sbw-note-block">' + icon('alertTriangle', 12) + ' If you go <strong>Back</strong> and change any setting, a <strong>new</strong> invite token is generated — make sure contributors get the latest one.</p>' +
        '<p class="sbw-hint sbw-note-block">Now we’ll set up <strong>your own</strong> contribution to this brain — your PAT, your domains, your consent. Same as any other contributor.</p>' +
      '</div>' +
      '<div class="sbw-actions">' +
        '<button type="button" class="btn btn-secondary" data-sbw-action="back">← Back</button>' +
        '<button type="button" class="btn btn-primary" id="sbw-admin-step2-next">Set up my contribution →</button>' +
      '</div>' +
    '</div>'
  );
}

function panelStep3() {
  return (
    '<div id="sbw-panel-step-3" class="sbw-panel sbw-hidden">' +
      '<h3>Create your access token</h3>' +
      '<p class="sbw-hint">This token is <strong>yours</strong> — it identifies your contributions. The admin never sees it. Other contributors never see it.</p>' +
      '<ol class="sbw-steps">' +
        '<li>Click the button below to open GitHub’s token creation page. The name will be prefilled.</li>' +
        '<li>Under <strong>Repository access</strong>, choose <strong>Only select repositories</strong> → pick the cohort repo.</li>' +
        '<li>Under <strong>Permissions</strong>, click <strong>+ Add permissions</strong> → add <strong>Contents</strong> → set to <strong>Read and write</strong>.</li>' +
        '<li>Scroll down → click <strong>Generate token</strong>.</li>' +
        '<li>Copy the token (starts with <code>github_pat_</code>) and paste it here.</li>' +
      '</ol>' +
      '<a id="sbw-pat-create-link" href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener" class="btn btn-primary sbw-link-btn sbw-link-btn-primary">Open GitHub to create my token →</a>' +
      '<div class="sbw-field" style="margin-top:16px">' +
        '<label class="sbw-label" for="sbw-pat-input">Paste your token here</label>' +
        '<div class="sbw-input-row">' +
          '<input type="password" id="sbw-pat-input" class="sbw-input mono" placeholder="github_pat_..." autocomplete="off" spellcheck="false">' +
          '<button type="button" class="btn btn-ghost sbw-toggle-vis" data-target="sbw-pat-input" title="Show/hide" aria-label="Show or hide the token">' + icon('dotRing', 14) + '</button>' +
        '</div>' +
        '<div id="sbw-pat-validation" class="sbw-status sbw-hidden" aria-live="polite"></div>' +
      '</div>' +
      '<div class="sbw-actions">' +
        '<button type="button" class="btn btn-secondary" data-sbw-action="back">← Back</button>' +
        '<button type="button" class="btn btn-primary" id="sbw-step3-next" disabled>Continue →</button>' +
      '</div>' +
    '</div>'
  );
}

function panelStep4() {
  return (
    '<div id="sbw-panel-step-4" class="sbw-panel sbw-hidden">' +
      '<h3>What to contribute</h3>' +
      '<p class="sbw-hint">Pick which of your personal domains contribute pages to this Shared Brain. Only their content gets pushed — everything else stays on this computer.</p>' +
      '<div class="sbw-field">' +
        '<label class="sbw-label">Contributing domains</label>' +
        '<div id="sbw-domain-checkboxes" class="sbw-domain-checkboxes"><p class="sbw-hint">Loading domains…</p></div>' +
      '</div>' +
      '<div class="sbw-field">' +
        '<label class="sbw-label" for="sbw-display-name">Your display name</label>' +
        '<input type="text" id="sbw-display-name" class="sbw-input" placeholder="Your name">' +
        '<span class="sbw-help">Stored locally on your machine. Only shared as a UUID by default — see attribution below.</span>' +
      '</div>' +
      '<div class="sbw-field">' +
        '<label class="sbw-checkbox-label"><input type="checkbox" id="sbw-attribute-name"><span>Show my name in Provenance sections (default: anonymous UUID)</span></label>' +
        '<span class="sbw-help">Name attribution requires BOTH this flag and an admin-enabled cohort setting. If either is off, you appear as a short UUID.</span>' +
      '</div>' +
      '<div id="sbw-step4-status" class="sbw-status sbw-hidden" aria-live="polite"></div>' +
      '<div class="sbw-actions">' +
        '<button type="button" class="btn btn-secondary" data-sbw-action="back">← Back</button>' +
        '<button type="button" class="btn btn-primary" id="sbw-step4-next">Continue →</button>' +
      '</div>' +
    '</div>'
  );
}

function panelStep5() {
  return (
    '<div id="sbw-panel-step-5" class="sbw-panel sbw-hidden">' +
      '<h3>Review and consent</h3>' +
      '<div class="sbw-review">' +
        '<dl>' +
          '<dt>Connecting to</dt><dd data-field="name"></dd>' +
          '<dt>Repo</dt><dd class="mono" data-field="repo"></dd>' +
          '<dt>Contributing domains</dt><dd data-field="domains"></dd>' +
          '<dt>Display name</dt><dd data-field="display-name"></dd>' +
          '<dt>Name attribution</dt><dd data-field="attribution"></dd>' +
        '</dl>' +
      '</div>' +
      '<div class="sbw-consent">' +
        '<p>By clicking <strong>Save &amp; Connect</strong> you agree:</p>' +
        '<ul>' +
          '<li>Only pages from the domains you selected above will be pushed to the Shared Brain.</li>' +
          '<li></li>' + // populated by refreshConsentTextForMode()
          '<li>You can disconnect anytime — your local wiki is unaffected.</li>' +
          '<li>Your access token is stored locally on this computer only. We never transmit it except to GitHub on your behalf.</li>' +
        '</ul>' +
        '<label class="sbw-checkbox-label sbw-consent-check"><input type="checkbox" id="sbw-consent"><span>I understand and consent to the above.</span></label>' +
      '</div>' +
      '<div id="sbw-step5-status" class="sbw-status sbw-hidden" aria-live="polite"></div>' +
      '<div class="sbw-actions">' +
        '<button type="button" class="btn btn-secondary" data-sbw-action="back">← Back</button>' +
        '<button type="button" class="btn btn-primary" id="sbw-step5-save" disabled>Save &amp; Connect</button>' +
      '</div>' +
    '</div>'
  );
}

// ── Chrome: close / back / cancel / password-visibility toggles ──────────

function bindChrome() {
  // M3 fix: all three checks below route through isSaveBlocking() — see
  // its own comment for why a save in progress must refuse every dismiss
  // path, not just Escape.
  byId('sbw-close')?.addEventListener('click', () => { if (isSaveBlocking()) return; closeWizard(); });
  byId('sbw-scrim')?.addEventListener('click', (e) => { if (isSaveBlocking()) return; if (e.target.id === 'sbw-scrim') closeWizard(); });

  qsa('[data-sbw-action]').forEach((btn) => {
    const action = btn.dataset.sbwAction;
    btn.addEventListener('click', () => {
      const myGen = wizardGen;
      if (action === 'close') {
        if (isSaveBlocking()) return; // M3 fix
        closeWizard();
      } else if (action === 'back') {
        const n = state.step;
        if (n > 1) goToStep(n - 1, myGen); // link population runs inside goToStep — rule 1
      }
    });
  });

  qsa('.sbw-toggle-vis').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = byId(btn.dataset.target);
      if (!input) return;
      input.type = input.type === 'password' ? 'text' : 'password';
    });
  });
}

// ── Step 1: invite token paste + decode ───────────────────────────────────

function bindStep1() {
  const input = byId('sbw-invite-token');
  const preview = byId('sbw-invite-preview');
  const nextBtn = byId('sbw-step1-next');
  const statusEl = byId('sbw-step1-status');
  if (!input) return;

  input.addEventListener('input', () => {
    clearTimeout(state.step1Debounce);
    const mySeq = ++state.step1Seq; // rule 3: anything in flight is now stale
    const myGen = wizardGen;
    nextBtn.disabled = true;
    // H1 fix: goes through setInviteMetadata (not a direct assignment) so
    // editing the token also invalidates any PAT verdict obtained for
    // whatever repo the field previously held — see that function's
    // comment for why this alone isn't the whole guarantee.
    setInviteMetadata(null);
    statusEl.classList.add('sbw-hidden');
    preview.classList.add('sbw-hidden');
    const token = input.value.trim();
    if (!token) return;
    state.step1Debounce = setTimeout(async () => {
      if (mySeq !== state.step1Seq || !isFresh(myGen)) return; // L4 fix: gate the SEND, not just the response
      try {
        const r = await fetch('/api/sharedbrain/parse-invite', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        const j = await r.json();
        if (mySeq !== state.step1Seq || !isFresh(myGen)) return;
        if (!j.valid) {
          statusEl.textContent = j.error || 'Invite token is invalid.';
          statusEl.className = 'sbw-status sbw-status-error';
          statusEl.classList.remove('sbw-hidden');
          return;
        }
        setInviteMetadata(j.metadata); // H1 fix — see setInviteMetadata's comment
        preview.querySelector('[data-field="name"]').textContent = j.metadata.name;
        preview.querySelector('[data-field="repo"]').textContent = j.metadata.repo;
        preview.querySelector('[data-field="branch"]').textContent = j.metadata.branch || 'main';
        preview.querySelector('[data-field="shared_domain"]').textContent = j.metadata.shared_domain;
        preview.classList.remove('sbw-hidden');
        nextBtn.disabled = false;
      } catch (err) {
        if (mySeq !== state.step1Seq || !isFresh(myGen)) return;
        statusEl.textContent = 'Could not parse token: ' + err.message;
        statusEl.className = 'sbw-status sbw-status-error';
        statusEl.classList.remove('sbw-hidden');
      }
    }, 280);
  });

  nextBtn.addEventListener('click', () => goToStep(2, wizardGen));
}

// ── Step 2: confirm GitHub access ─────────────────────────────────────────

function bindStep2() {
  byId('sbw-step2-next')?.addEventListener('click', () => goToStep(3, wizardGen));
}

// Populated on panel entry — see goToStep()'s rule-1 comment.
function refreshStep2Links() {
  const meta = state.inviteMetadata;
  if (!meta) return;
  const repoLink = byId('sbw-repo-link');
  if (repoLink) repoLink.href = 'https://github.com/' + meta.repo;
  const repoName = byId('sbw-panel-step-2')?.querySelector('[data-field="invite-repo"]');
  if (repoName) repoName.textContent = meta.repo;
}

// Populated on panel entry — works for both the contributor and admin
// paths, exactly like the shipping app's refreshPatCreateLink().
function refreshPatCreateLink() {
  const meta = state.inviteMetadata;
  if (!meta) return;
  const patLink = byId('sbw-pat-create-link');
  if (patLink) {
    const name = ('Curator Shared Brain - ' + meta.name).slice(0, 60);
    patLink.href = 'https://github.com/settings/personal-access-tokens/new?name=' + encodeURIComponent(name);
  }
}

// ── Step 3: PAT paste + live validation ───────────────────────────────────

function bindStep3() {
  const input = byId('sbw-pat-input');
  const validation = byId('sbw-pat-validation');
  const nextBtn = byId('sbw-step3-next');
  if (!input) return;

  function setValidation(kind, message) {
    validation.className = 'sbw-status sbw-status-' + kind;
    validation.textContent = message;
    validation.classList.remove('sbw-hidden');
  }

  input.addEventListener('input', () => {
    clearTimeout(state.patDebounce);
    const mySeq = ++state.patSeq;
    const myGen = wizardGen;
    nextBtn.disabled = true;
    state.pat = '';               // rule 4: cleared until a fresh valid verdict
    state.patValidation = null;
    state.patValidatedRepo = null; // H1 fix
    const pat = input.value.trim();

    if (!pat) {
      validation.classList.add('sbw-hidden');
      return;
    }
    if (pat.length < 20) {
      setValidation('checking', 'Token looks too short — keep pasting.');
      return;
    }

    state.patDebounce = setTimeout(async () => {
      if (mySeq !== state.patSeq || !isFresh(myGen)) return; // L4 fix: gate the SEND, not just the response
      const meta = state.inviteMetadata;
      if (!meta) {
        setValidation('error', 'Lost the invite metadata — go back to step 1.');
        return;
      }
      setValidation('checking', 'Checking your token against GitHub…');
      try {
        const r = await fetch('/api/sharedbrain/validate-pat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repo: meta.repo, pat }),
        });
        const j = await r.json();
        if (mySeq !== state.patSeq || !isFresh(myGen)) return;

        if (!j.valid) {
          setValidation('error', j.error || 'Token rejected by GitHub.');
          return;
        }
        // Valid → store it (rule 4: only on a valid/warn verdict), and
        // record which repo it was checked against (H1 fix) — this is
        // what currentValidatedPat()/isReadOnlyVerdict() key on.
        state.patValidation = j;
        state.pat = pat;
        state.patValidatedRepo = meta.repo;

        if (!j.hasWriteAccess) {
          setValidation('warn',
            'Token works but is read-only. You can continue as a read-only member — ' +
            'you’ll be able to Pull the collective wiki, but not push contributions. ' +
            'To contribute, re-create the token with Contents: Read AND write, then re-paste.');
          nextBtn.disabled = false;
          return;
        }
        setValidation('ok', 'Token verified. Authenticated against ' + (j.repoFullName || meta.repo) + '.');
        nextBtn.disabled = false;
      } catch (err) {
        if (mySeq !== state.patSeq || !isFresh(myGen)) return;
        setValidation('error', 'Could not reach the Curator server: ' + err.message);
      }
    }, 400);
  });

  nextBtn.addEventListener('click', () => {
    goToStep(4, wizardGen);
    populateDomains();
  });
}

// ── Step 4: pick personal domains + display name ──────────────────────────

async function populateDomains() {
  const container = byId('sbw-domain-checkboxes');
  if (!container) return;
  const myGen = wizardGen;
  container.innerHTML = '<p class="sbw-hint">Loading domains…</p>';

  try {
    const r = await fetch('/api/domains');
    const j = await r.json();
    if (!isFresh(myGen)) return;
    const domains = Array.isArray(j) ? j : (j.domains || []);
    // Never contribute from a mirror.
    const eligible = domains.filter((d) => {
      const name = typeof d === 'string' ? d : d.name;
      return name && !name.startsWith('shared-');
    });

    if (eligible.length === 0) {
      container.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'sbw-hint';
      p.textContent = 'No personal domains found. Create one from the Domains view first, then come back.';
      container.appendChild(p);
      return;
    }

    // Rule 2: rebuild CHECKED from state, pruning stale selections against
    // the live domain list.
    const eligibleNames = new Set(eligible.map((d) => (typeof d === 'string' ? d : d.name)));
    for (const sel of [...state.selectedDomains]) {
      if (!eligibleNames.has(sel)) state.selectedDomains.delete(sel);
    }

    container.innerHTML = '';
    for (const d of eligible) {
      const name = typeof d === 'string' ? d : d.name;
      const label = document.createElement('label');
      label.className = 'sbw-checkbox-label';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = name;
      cb.checked = state.selectedDomains.has(name); // rule 2
      const span = document.createElement('span');
      span.textContent = name;
      label.appendChild(cb);
      label.appendChild(span);
      cb.addEventListener('change', () => {
        if (cb.checked) state.selectedDomains.add(name);
        else state.selectedDomains.delete(name);
      });
      container.appendChild(label);
    }
  } catch (err) {
    if (!isFresh(myGen)) return;
    container.textContent = '';
    const p = document.createElement('p');
    p.className = 'sbw-status sbw-status-error';
    p.textContent = 'Could not load domains: ' + err.message;
    container.appendChild(p);
  }
}

// A connection is read-only when the PAT verdict was valid-but-no-write —
// H1 fix: AND that verdict was actually obtained for the CURRENT invite
// metadata's repo (same guard as currentValidatedPat(), independently
// enforced here since this is the other of the only two places the rest
// of the file reads the verdict).
function isReadOnlyVerdict() {
  if (!state.inviteMetadata || !state.patValidation) return false;
  if (state.patValidatedRepo !== state.inviteMetadata.repo) return false;
  const v = state.patValidation;
  return !!(v.valid && !v.hasWriteAccess);
}

function bindStep4() {
  const nameEl = byId('sbw-display-name');
  const attrEl = byId('sbw-attribute-name');
  const next = byId('sbw-step4-next');
  const status = byId('sbw-step4-status');
  if (!next) return;

  nameEl?.addEventListener('input', () => { state.displayName = nameEl.value.trim(); });
  attrEl?.addEventListener('change', () => { state.attributeByName = attrEl.checked; });

  next.addEventListener('click', () => {
    const myGen = wizardGen;
    status?.classList.add('sbw-hidden');
    if (state.selectedDomains.size === 0 && !isReadOnlyVerdict()) {
      if (status) {
        status.textContent = 'Please select at least one personal domain to contribute. (You can change this later.)';
        status.className = 'sbw-status sbw-status-error';
        status.classList.remove('sbw-hidden');
      }
      return;
    }
    if (!state.displayName) {
      state.displayName = 'Anonymous Fellow';
      if (nameEl) nameEl.value = 'Anonymous Fellow';
    }
    refreshConsentTextForMode();
    populateReview();
    goToStep(5, myGen);
  });
}

// ── Step 5: review + consent + save ───────────────────────────────────────

function populateReview() {
  const meta = state.inviteMetadata;
  const box = byId('sbw-panel-step-5')?.querySelector('.sbw-review');
  if (!box || !meta) return;
  box.querySelector('[data-field="name"]').textContent = meta.name;
  box.querySelector('[data-field="repo"]').textContent =
    meta.repo + (isReadOnlyVerdict() ? ' (read-only member — Pull only)' : '');
  box.querySelector('[data-field="domains"]').textContent =
    [...state.selectedDomains].join(', ') || (isReadOnlyVerdict() ? '(none — read-only members don’t push)' : '(none)');
  box.querySelector('[data-field="display-name"]').textContent = state.displayName;
  box.querySelector('[data-field="attribution"]').textContent =
    state.attributeByName ? 'show name (admin must also enable cohort-side)' : 'anonymous UUID (default)';
}

function refreshConsentTextForMode() {
  const meta = state.inviteMetadata;
  if (!meta) return;
  const ul = byId('sbw-panel-step-5')?.querySelector('.sbw-consent ul');
  if (!ul) return;
  const ipLineText = meta.data_handling_terms === 'organisational'
    ? 'By contributing, you assign copyright in contributed pages to the organisation per your employment agreement.'
    : 'You retain copyright in your original content. The cohort owns the synthesised collective output.';
  const items = ul.querySelectorAll('li');
  if (items[1]) items[1].textContent = ipLineText;
}

function bindStep5() {
  const consent = byId('sbw-consent');
  const save = byId('sbw-step5-save');
  const status = byId('sbw-step5-status');
  if (!consent || !save) return;

  consent.addEventListener('change', () => {
    state.consent = consent.checked;
    save.disabled = !consent.checked || state.saveInProgress;
  });

  save.addEventListener('click', async () => {
    if (!state.consent) return;
    const myGen = wizardGen;
    state.saveInProgress = true;      // M3 fix: gates Escape/backdrop/close — see onWizardKeydown and bindChrome
    save.disabled = true;
    save.textContent = 'Saving…';
    status?.classList.add('sbw-hidden');
    setSaveChromeDisabled(true);       // M3 fix: Close (x) + this panel's Back also disabled while a credential write is in flight

    try {
      // N5 fix: this whole block used to sit OUTSIDE the try — a throw
      // here (e.g. state.inviteMetadata somehow null) left the button
      // stuck at "Saving…", disabled, with no recovery but Escape (which
      // is now itself blocked while saveInProgress — see M3 fix above).
      const meta = state.inviteMetadata;
      if (!meta) throw new Error('Lost the connection details — go back to step 1 and try again.');

      // Verbatim from the shipping app — a DIFFERENT slugify than the admin
      // step-1 "folder inside the repo" field (that one allows underscores
      // and collapses hyphen runs; this one doesn't, and falls back to
      // "cohort"). Both are ported unchanged, on purpose — see the file
      // header: this is a credential/data path, not a place to "clean up".
      const brainSlug = meta.name.toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'cohort';

      const connection = {
        label: meta.name,
        storage_type: meta.storage_type || 'github',
        github_repo_owner: meta.repo.split('/')[0],
        github_repo_name: meta.repo.split('/')[1],
        github_pat: currentValidatedPat(), // H1 fix: '' unless the verdict actually matches this repo
        github_branch: meta.branch || 'main',
        fellow_display_name: state.displayName,
        shared_domain: meta.shared_domain,
        shared_brain_slug: brainSlug,
        local_domains: [...state.selectedDomains],
        attribute_by_name: state.attributeByName,
        read_only: isReadOnlyVerdict(), // H1 fix: same repo-matching guard
        data_handling_terms: meta.data_handling_terms || 'contributor_retains',
        enabled: true,
      };
      if (state.mode === 'create' && state.generatedAdminToken) {
        connection.admin_token = state.generatedAdminToken;
      }

      const r = await fetch('/api/sharedbrain/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connection }),
      });
      const j = await r.json().catch(() => ({}));
      if (!isFresh(myGen)) return;
      if (!r.ok) throw new Error(j.error || 'Save failed');

      const onSaved = state.onSaved;
      closeWizard(); // rule 5: wipes state, incl. the PAT, and tears down the DOM
      if (typeof onSaved === 'function') onSaved();
    } catch (err) {
      if (!isFresh(myGen)) return;
      if (status) {
        status.textContent = 'Could not save: ' + err.message;
        status.className = 'sbw-status sbw-status-error';
        status.classList.remove('sbw-hidden');
      }
      save.textContent = 'Save & Connect';
      state.saveInProgress = false;
      save.disabled = false;
      setSaveChromeDisabled(false); // M3 fix
    }
  });
}

// M3 fix: disables/re-enables the Close (x) button and step 5's own Back
// button for the duration of a save. Escape and the backdrop click are
// blocked by checking state.saveInProgress directly (see onWizardKeydown
// and bindChrome) rather than by relying on these being disabled — two
// independent guards, same shape as the rest of this file's credential
// paths (see e.g. the H1 fix above): losing either one still leaves the
// other.
function setSaveChromeDisabled(disabled) {
  const closeBtn = byId('sbw-close');
  if (closeBtn) closeBtn.disabled = disabled;
  const step5Back = byId('sbw-panel-step-5')?.querySelector('[data-sbw-action="back"]');
  if (step5Back) step5Back.disabled = disabled;
}

// ── Admin step 1: collect form, generate invite + admin token ────────────

// Verbatim from the shipping app's slugifyForSharedDomain — deliberately a
// DIFFERENT function than the brainSlug derivation in bindStep5's save
// handler (this one keeps underscores and collapses repeated hyphens; that
// one doesn't). See this file's header and bindStep5's own comment.
function slugifyForSharedDomain(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 40);
}

function bindAdminStep1() {
  const next = byId('sbw-admin-step1-next');
  const status = byId('sbw-admin-step1-status');
  if (!next) return;

  const nameEl = byId('sbw-admin-name');
  const slugEl = byId('sbw-admin-shared-domain');

  if (nameEl && slugEl) {
    nameEl.addEventListener('input', () => {
      if (!state.slugManuallyEdited) slugEl.value = slugifyForSharedDomain(nameEl.value);
    });
    slugEl.addEventListener('input', () => {
      state.slugManuallyEdited = slugEl.value.length > 0;
    });
  }

  next.addEventListener('click', async () => {
    const myGen = wizardGen;
    const repo = byId('sbw-admin-repo').value.trim();
    const name = byId('sbw-admin-name').value.trim();
    const sharedDomain = byId('sbw-admin-shared-domain').value.trim();
    const branch = byId('sbw-admin-branch').value.trim() || 'main';
    const dht = byId('sbw-panel-admin-step-1')?.querySelector('input[name="sbw-admin-dht"]:checked')?.value || 'contributor_retains';

    status?.classList.add('sbw-hidden');

    function fail(msg) {
      if (status) { status.textContent = msg; status.className = 'sbw-status sbw-status-error'; status.classList.remove('sbw-hidden'); }
    }

    // Client-side validation mirroring the server's checks for repo,
    // display name, shared_domain, AND branch (M2 fix — the branch rule
    // was missing here entirely, despite this comment's own prior claim
    // of "verbatim"; that overclaim is exactly why it went unnoticed: a
    // comment that says more than the code does stops the next reviewer
    // looking). The branch regex is copied byte-for-byte from BOTH
    // decodeInviteToken (src/routes/sharedbrain.js) and validateConnection
    // (src/brain/sharedbrain-config.js) — those two already had to match
    // each other for parse-invite and save to agree; this is now a third,
    // client-side copy of the same rule, so a malformed branch is caught
    // here instead of silently minting a token every contributor's wizard
    // (and the admin's own eventual /save) will refuse.
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(repo)) {
      fail('Repository must be in “owner/name” format (no spaces).');
      return;
    }
    if (!name) { fail('Display name is required.'); return; }
    if (!/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(sharedDomain)) {
      fail('Shared domain slug: lowercase letters, digits, hyphens, underscores. No spaces.');
      return;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(branch) || branch.includes('..')) {
      fail('Branch must be a valid git ref name (letters, digits, ., _, -, / — no spaces, no ".." segments).');
      return;
    }

    next.disabled = true;
    next.textContent = 'Generating…';
    try {
      const r = await fetch('/api/sharedbrain/generate-invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo, name, shared_domain: sharedDomain, branch, data_handling_terms: dht, storage_type: 'github' }),
      });
      const j = await r.json();
      if (!isFresh(myGen)) return;
      if (!r.ok) throw new Error(j.error || 'generate-invite failed');

      setInviteMetadata({ v: 1, repo, name, shared_domain: sharedDomain, branch, data_handling_terms: dht, storage_type: 'github' }); // H1 fix
      state.generatedInviteToken = j.token;
      // Rule 7: keep the FIRST generated admin token across a Back+regenerate.
      if (!state.generatedAdminToken && j.admin_token) state.generatedAdminToken = j.admin_token;

      const inviteTokEl = byId('sbw-admin-invite-token');
      if (inviteTokEl) inviteTokEl.textContent = j.token;
      const adminTokEl = byId('sbw-admin-admin-token');
      if (adminTokEl && state.generatedAdminToken) adminTokEl.textContent = state.generatedAdminToken;
      const collabLink = byId('sbw-admin-collab-link');
      if (collabLink) collabLink.href = 'https://github.com/' + repo + '/settings/access';

      goToStep(2, myGen);
    } catch (err) {
      if (!isFresh(myGen)) return;
      fail('Could not generate invite token: ' + err.message);
    } finally {
      if (isFresh(myGen)) { next.disabled = false; next.textContent = 'Continue →'; }
    }
  });
}

// ── Admin step 2: copy invite/admin token, advance to PAT step ───────────

function bindCopyButton(btnId, getText) {
  const copyBtn = byId(btnId);
  if (!copyBtn) return;
  copyBtn.addEventListener('click', async () => {
    const text = getText();
    if (!text) return;
    const label = copyBtn.querySelector('span');
    try {
      await navigator.clipboard.writeText(text);
      const original = label ? label.textContent : 'Copy';
      copyBtn.classList.add('copied');
      if (label) label.textContent = 'Copied';
      setTimeout(() => { copyBtn.classList.remove('copied'); if (label) label.textContent = original; }, 1800);
    } catch {
      if (label) {
        const original = label.textContent;
        label.textContent = 'Copy blocked — select and copy manually';
        setTimeout(() => { label.textContent = original; }, 4000);
      }
    }
  });
}

function bindAdminStep2() {
  bindCopyButton('sbw-admin-copy-invite', () => state.generatedInviteToken);
  bindCopyButton('sbw-admin-copy-admin-token', () => state.generatedAdminToken);
  byId('sbw-admin-step2-next')?.addEventListener('click', () => goToStep(3, wizardGen));
}
