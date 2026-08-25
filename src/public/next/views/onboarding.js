// First-run guidance panel — the /next shell's answer to "I just opened
// this and I have no idea what to do first."
//
// ── THIS IS NOT A WIZARD, AND THAT IS THE WHOLE POINT ───────────────────
// ARCHITECTURE.md explicitly REJECTS a first-run wizard. The binding
// design decision (R7) is that first-run guidance must be a dismissible,
// re-findable, NON-BLOCKING layer — "coach-marks over the REAL UI, never a
// modal that hides the thing it describes" — and that it "must not block
// the composer: someone who would rather just type is never trapped."
//
// Everything below follows from that:
//   - No scrim, no role="dialog", no aria-modal, NO FOCUS TRAP. Those are
//     the mechanics of modality; adding any of them would re-create the
//     exact trap R7 forbids. This is a labelled REGION (D-E). The two real
//     wizards in this shell (views/mcp-wizard.js, views/shared-brain-
//     wizard.js) are the opposite shape on purpose — this file copies
//     their CONVENTIONS (namespaced prefix, generation counter, textContent
//     discipline, [data-theme] theming) and none of their modality.
//   - It never steals focus on the automatic path. Focus moves only when
//     the user themselves asks for the panel from Settings.
//   - Every step POINTS. No step embeds an input; no step POSTs anything.
//     The action button navigates to the REAL surface that already owns
//     that job, and the user does the thing there.
//
// ── WHY THE PANEL POSTS NOTHING, ESPECIALLY NOT A DOMAIN ────────────────
// views/domains.js holds the ONLY `POST /api/domains` call site in the
// whole /next tree, and scripts/test-next-chat-compile.js asserts that
// count is exactly 1. A second create path — even a "shared" helper both
// surfaces call — re-creates the duplicate-create-path collision v3.7.0
// deleted, which is the v3.2.0 "two hand-maintained copies of a guard"
// CRITICAL in another costume. Step 2 therefore navigates to Domains and
// lets ITS existing create flow run. See goToDomainsCreate() below.
//
// ── STEP ORDER IS LOAD-BEARING ──────────────────────────────────────────
// API key -> first domain -> first ingest, in that order, per R7: nothing
// works without a model, so pointing at domain creation first means the
// user makes an empty domain and immediately hits a wall — an error before
// a success. STEP_ORDER below is the single source of that order and
// scripts/test-next-onboarding.js pins it.
//
// ── WHAT COUNTS AS "HAS A KEY" (D-A) ────────────────────────────────────
// hasApiKey() reads hasGeminiKey/hasAnthropicKey from
// GET /api/config/api-keys, which trace to getApiKeys() in
// src/brain/config.js — CONFIG ONLY. It deliberately does NOT consider
// .env, and this file must never grow a `geminiUsable`/`anthropicUsable`
// notion: v3.0.13 REMOVED those two fields because they were misleading,
// and CLAUDE.md records "do NOT reintroduce getEffectiveKey /
// geminiUsable / anthropicUsable into the selector path" as a binding
// invariant. Consequence, accepted knowingly: a developer whose only key
// lives in .env sees this panel. Because the panel is non-blocking and one
// click dismisses it, that is a minor annoyance — not the trap the same
// mismatch is in the shipping app, where it gates real behaviour.
//
// ── FAIL-SAFE DIRECTION IS "SHOW", AND IT IS THE OPPOSITE OF A CONSENT ──
// readDismissed() returns FALSE (i.e. "show the panel") if localStorage
// throws or is unavailable. Guidance re-appearing is harmless; permanently
// hiding first-run setup is the harmful direction, and it produces NO
// VISIBLE SYMPTOM — the user simply never learns the app needs a key.
// v3.6.0 established that a CONSENT fails CLOSED (ask again). This is not
// a consent. Do not "make it consistent" by inverting it.
// The same reasoning applies to loadFacts(): if the two GETs fail, the
// facts come back all-false, which SHOWS the panel rather than hiding it.
//
// ── OWNERSHIP: SHELL-LEVEL, NOT VIEW-LEVEL ─────────────────────────────
// This panel must survive navigate() — its whole job is to point at other
// views. So, unlike the two wizards, it is NOT opened by a view's onEnter
// and it is NOT closed by any view's teardown. It is opened once from
// app.js's boot() and lives on document.body until dismissed or completed.
// views/settings.js may RE-open it (D-C) but must never close it.
//
// Owns views/onboarding.css (the `obp-` prefix, used nowhere else).

import { navigate, icon, escapeHtml } from '../app.js';

// Namespaced like every other /next key (curator-next-theme,
// curator-next-view, curator-next-chat-domain).
const DISMISS_KEY = 'curator-next-onboarding-dismissed-v1';

// While the panel is open the user is, by definition, mid-setup — so this
// re-check is running against an install with zero or very few domains and
// both endpoints are readdir-only local reads. It stops the moment the
// panel closes AND the moment all three steps go done (see tick()), so it
// is self-terminating rather than a background loop that runs forever.
// Skipped entirely while the tab is hidden.
const REFRESH_MS = 5000;

// ═════════════════════════════════════════════════════════════════════════
// PURE LOGIC — no DOM, no fetch, no storage. Everything this panel DECIDES
// lives here so scripts/test-next-onboarding.js can drive it offline, in
// both directions, without a browser.
// ═════════════════════════════════════════════════════════════════════════

// R7. The order is the design, not an implementation detail.
const STEP_ORDER = ['api-key', 'domain', 'ingest'];

const STEP_COPY = {
  'api-key': {
    title: 'Add an AI key',
    todo: 'Nothing else works without a model. Paste a Gemini or Anthropic key in Settings.',
    done: 'A key is saved, so The Curator can read and write.',
    action: 'Open Settings',
  },
  domain: {
    title: 'Create your first domain',
    todo: 'A domain is one subject area with its own wiki — “articles”, “research”, “work”.',
    done: 'You have somewhere for knowledge to land.',
    action: 'Open Domains',
  },
  ingest: {
    title: 'Ingest your first source',
    todo: 'Drop in a PDF, Markdown or text file. The Curator reads it and writes the wiki pages.',
    done: 'Your wiki has pages in it — the loop is running.',
    action: 'Open Ingest',
  },
};

// GET /api/config/api-keys. CONFIG-ONLY by design — see the header.
function hasApiKey(keys) {
  if (!keys || typeof keys !== 'object') return false;
  return keys.hasGeminiKey === true || keys.hasAnthropicKey === true;
}

// GET /api/domains/stats -> { domains: [ { slug, pageCount, ... } ], ... }.
function hasAnyDomain(stats) {
  if (!stats || typeof stats !== 'object') return false;
  return Array.isArray(stats.domains) && stats.domains.length > 0;
}

// "Has a page" means a real wiki page, and getDomainStats()'s pageCount is
// exactly that: every .md under wiki/ EXCEPT the two app-managed ones
// (index.md, log.md), which createDomain() writes. So a freshly-created,
// never-ingested domain is pageCount 0 and step 3 correctly reads
// not-done. A domain whose stats failed comes back as { slug, error } with
// no pageCount — Number() of undefined is NaN, and NaN > 0 is false, so a
// broken domain never falsely completes the step.
function hasAnyPage(stats) {
  if (!hasAnyDomain(stats)) return false;
  return stats.domains.some((d) => d && Number(d.pageCount) > 0);
}

const UNKNOWN_FACTS = { hasKey: false, hasDomain: false, hasPages: false };

function factsFrom(keys, stats) {
  return {
    hasKey: hasApiKey(keys),
    hasDomain: hasAnyDomain(stats),
    hasPages: hasAnyPage(stats),
  };
}

// The one place a step's done-ness is decided, in the one order that is
// allowed. Returns a plain array so the test can assert both the order and
// each step's state without touching the DOM.
function buildSteps(facts) {
  const f = (facts && typeof facts === 'object') ? facts : UNKNOWN_FACTS;
  const doneBy = {
    'api-key': f.hasKey === true,
    domain: f.hasDomain === true,
    ingest: f.hasPages === true,
  };
  return STEP_ORDER.map((id) => ({
    id,
    title: STEP_COPY[id].title,
    body: doneBy[id] ? STEP_COPY[id].done : STEP_COPY[id].todo,
    action: STEP_COPY[id].action,
    done: doneBy[id],
  }));
}

// FAIL-SAFE: SHOW. See the header. `storage` is injected so the throwing
// case is a real, executed assertion in the suite rather than a source
// regex — a private-mode browser genuinely throws on getItem.
function readDismissed(storage) {
  try {
    return storage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

// Best-effort. A storage that refuses the write means the panel comes back
// on the next launch — annoying, never harmful, and the alternative
// (surfacing a storage error over a dismissal) is worse.
function writeDismissed(storage) {
  try {
    storage.setItem(DISMISS_KEY, '1');
    return true;
  } catch {
    return false;
  }
}

function clearDismissed(storage) {
  try {
    storage.removeItem(DISMISS_KEY);
    return true;
  } catch {
    return false;
  }
}

// THE gate for the AUTOMATIC path. Two rules, in this order:
//   1. All three done -> never show, whatever the dismissed flag says
//      (D-D: completing setup is itself the dismissal; nobody should have
//      to click × to get rid of a checklist they have finished).
//   2. Otherwise, show iff not dismissed.
// The EXPLICIT path (openOnboardingPanel(), from Settings) deliberately
// bypasses this — a button that answers a direct request with nothing
// visible reads as broken. See that function's own comment.
function shouldShowPanel(steps, dismissed) {
  if (!Array.isArray(steps) || steps.length === 0) return false;
  if (steps.every((s) => s && s.done === true)) return false;
  return dismissed !== true;
}

function progressLabel(steps) {
  const list = Array.isArray(steps) ? steps : [];
  const done = list.filter((s) => s && s.done === true).length;
  return done + ' of ' + list.length + ' done';
}

// Which view each step points at. A pure lookup so the test can assert the
// mapping without a shell.
function targetViewFor(stepId) {
  if (stepId === 'api-key') return 'settings';
  if (stepId === 'domain') return 'domains';
  if (stepId === 'ingest') return 'ingest';
  return null;
}

// ═════════════════════════════════════════════════════════════════════════
// Module state
// ═════════════════════════════════════════════════════════════════════════

let root = null;
let steps = buildSteps(UNKNOWN_FACTS);
let refreshTimer = null;
let prevFocus = null;

// D-D applies to the panel that put ITSELF on screen. A panel the user
// explicitly asked for from Settings must not vanish under them the moment
// the background re-check confirms setup is finished — that is the same
// "button appears broken" failure as answering the request with nothing.
// See refresh().
let autoCloseOnComplete = true;

// D-F. Module-level, deliberately NOT a field on anything that gets
// replaced — every async handler captures `const myGen = panelGen` as a
// LOCAL, synchronously, and compares that local against the live counter
// after each await. Reading a module variable live on BOTH sides is the
// HANDOFF bug #8 shape: it always compares equal and the guard is inert.
let panelGen = 0;
function isFresh(myGen) { return myGen === panelGen; }

// localStorage access is wrapped rather than referenced directly so the
// whole module keeps working in a context where the property access itself
// throws (some privacy modes throw on `window.localStorage`, not just on
// getItem). Returns an object that always satisfies the readDismissed /
// writeDismissed contract; its methods throwing is the tested path.
function storage() {
  try {
    return window.localStorage;
  } catch {
    return { getItem() { throw new Error('no storage'); },
             setItem() { throw new Error('no storage'); },
             removeItem() { throw new Error('no storage'); } };
  }
}

// ═════════════════════════════════════════════════════════════════════════
// Data
// ═════════════════════════════════════════════════════════════════════════

async function getJson(url) {
  const res = await fetch(url);
  const ct = String(res.headers.get('content-type') || '').toLowerCase();
  // v2.3.3 SPA-fallthrough: src/server.js's app.get('*') answers an unknown
  // path with index.html at HTTP 200, so res.json() would throw
  // `Unexpected token '<'`. Treat that as "no data", never as a crash.
  if (!ct.includes('application/json')) return null;
  if (!res.ok) return null;
  return res.json();
}

// Both requests are independent and neither is allowed to take the other
// down: Promise.allSettled, then null for whichever failed. A failure
// therefore reads as "not done", which SHOWS the panel — the fail-safe
// direction (see the header).
async function loadFacts() {
  const [keysRes, statsRes] = await Promise.allSettled([
    getJson('/api/config/api-keys'),
    getJson('/api/domains/stats'),
  ]);
  const keys = keysRes.status === 'fulfilled' ? keysRes.value : null;
  const stats = statsRes.status === 'fulfilled' ? statsRes.value : null;
  return factsFrom(keys, stats);
}

// ═════════════════════════════════════════════════════════════════════════
// Entry points
// ═════════════════════════════════════════════════════════════════════════

// THE BOOT HOOK, called once from app.js's boot().
//
// SAFETY PROPERTY THIS MUST KEEP — the highest-stakes detail in this file:
// app.js calls markBooted() immediately after boot() returns, and
// next/index.html's inline <head> guard treats an unset
// window.__curatorBooted at DOMContentLoaded as proof the module died,
// rendering a full-page blank-page recovery panel TO EVERY USER. So this
// function must never be able to stop markBooted() from running. Two
// independent reasons it cannot:
//   1. It is `async`. An async function's body — including its synchronous
//      prologue — can only ever produce a REJECTED PROMISE, never a
//      synchronous throw at the call site.
//   2. Its whole body is inside try/catch, so it does not even reject.
// The call site in boot() adds a third layer (its own try/catch) and is
// NOT awaited. Any one of the three is sufficient; all three are present
// because getting this wrong ships a blank page and the failure is silent
// until a user reports it. scripts/test-next-onboarding.js §6 pins the
// call-site half.
export async function maybeShowOnboarding() {
  try {
    const dismissed = readDismissed(storage());
    // Short-circuit BEFORE the two GETs. A dismissed panel cannot show
    // whatever the facts say, and this runs on every page load for the
    // entire life of the install — there is no reason to pay for two
    // readdir-backed requests to throw the answer away. shouldShowPanel()
    // below is still handed the REAL dismissed value, so there is exactly
    // one place the show/hide verdict is made.
    const facts = dismissed ? UNKNOWN_FACTS : await loadFacts();
    const next = buildSteps(facts);
    if (!shouldShowPanel(next, dismissed)) return;
    openPanel(next, { focus: false });
  } catch (err) {
    // Never fatal. A first-run hint failing is not worth degrading the app
    // over, and it must not reach the pre-boot error recorder.
    console.error('[next/onboarding] first-run check failed', err);
  }
}

// D-C — R7: "a tour you can never get back is worse than none." Called by
// views/settings.js's General section.
//
// Deliberately bypasses shouldShowPanel()'s all-done rule: that rule
// exists so a FINISHED checklist stops appearing on its own, not so an
// explicit request answers with nothing. A user who clicks "Show setup
// guide" after finishing setup gets the panel with three ticks and an
// all-done note — visible feedback that the button worked.
export function openOnboardingPanel() {
  clearDismissed(storage());
  openPanel(steps, { focus: true, autoCloseOnComplete: false });
  // Refresh in the background so the ticks are current rather than
  // whatever the last load happened to see. myGen is captured
  // SYNCHRONOUSLY here, after openPanel() has bumped the counter (D-F).
  const myGen = panelGen;
  refresh(myGen);
}

// ═════════════════════════════════════════════════════════════════════════
// Panel
// ═════════════════════════════════════════════════════════════════════════

function openPanel(nextSteps, opts) {
  const focus = !!(opts && opts.focus);
  autoCloseOnComplete = !(opts && opts.autoCloseOnComplete === false);
  if (root) {
    // Already open (Settings re-open while it is on screen) — just refresh
    // the content and, if this was an explicit request, move focus to it.
    steps = nextSteps;
    render();
    if (focus) focusHeading();
    return;
  }
  panelGen += 1;
  steps = nextSteps;
  prevFocus = document.activeElement;

  root = document.createElement('div');
  root.className = 'obp-root';
  document.body.appendChild(root);
  render();

  // Only on an explicit request. The automatic path must NEVER steal focus
  // — someone who opened the app to type a message keeps their caret.
  if (focus) focusHeading();

  startRefresh();
}

function closePanel() {
  if (!root) return;
  panelGen += 1; // every in-flight handler from this session is now stale
  stopRefresh();

  // Do not strand focus on a node that is about to be removed (D-E). If the
  // user was inside the panel, hand focus back to whatever had it when the
  // panel opened, provided that element is still in the document; otherwise
  // let the browser do its default (focus falls to <body>), which is a
  // sensible resting place and never a detached node.
  const insidePanel = root.contains(document.activeElement);
  const restore = prevFocus;
  prevFocus = null;

  root.remove();
  root = null;

  if (insidePanel && restore && restore.isConnected && typeof restore.focus === 'function') {
    try { restore.focus(); } catch { /* the element may have gone away */ }
  }
}

function focusHeading() {
  const h = root && root.querySelector('#obp-title');
  if (h && typeof h.focus === 'function') {
    try { h.focus(); } catch { /* non-focusable in some engines — harmless */ }
  }
}

// ── Render ───────────────────────────────────────────────────────────────
// role="region" + aria-labelledby, NOT role="dialog"/aria-modal — see the
// header. Every interpolated string is run through escapeHtml even though
// they are all internal literals today: the discipline is what survives a
// future edit that makes one of them dynamic.
function render() {
  if (!root) return;
  const allDone = steps.every((s) => s.done);

  const rows = steps.map((s, i) => (
    '<li class="obp-step' + (s.done ? ' obp-step-done' : '') + '" data-step="' + escapeHtml(s.id) + '">' +
      '<span class="obp-mark' + (s.done ? ' obp-mark-done' : '') + '" aria-hidden="true">' +
        (s.done ? icon('check', 12) : String(i + 1)) +
      '</span>' +
      '<span class="obp-step-text">' +
        '<span class="obp-step-title">' + escapeHtml(s.title) + '</span>' +
        '<span class="obp-step-body">' + escapeHtml(s.body) + '</span>' +
      '</span>' +
      (s.done
        ? '<span class="obp-step-done-tag">Done</span>'
        : '<button type="button" class="btn btn-secondary obp-go" data-go="' + escapeHtml(s.id) + '">' +
            escapeHtml(s.action) +
          '</button>') +
    '</li>'
  )).join('');

  root.innerHTML =
    '<section class="obp-panel" role="region" aria-labelledby="obp-title">' +
      '<div class="obp-head">' +
        '<h2 class="obp-title" id="obp-title" tabindex="-1">Getting started</h2>' +
        '<button type="button" class="obp-dismiss" id="obp-dismiss" ' +
          'aria-label="Dismiss the setup guide">' + icon('x', 14) + '</button>' +
      '</div>' +
      '<p class="obp-progress" aria-live="polite">' + escapeHtml(progressLabel(steps)) + '</p>' +
      '<ol class="obp-steps">' + rows + '</ol>' +
      (allDone
        ? '<p class="obp-foot">Everything here is done — this guide will not come back on its own.</p>'
        : '<p class="obp-foot">You can ignore this and just start typing. ' +
          'Settings → General → Show setup guide brings it back.</p>') +
    '</section>';

  bind();
}

function bind() {
  const dismiss = root.querySelector('#obp-dismiss');
  if (dismiss) {
    dismiss.addEventListener('click', () => {
      writeDismissed(storage());
      closePanel();
    });
  }
  root.querySelectorAll('.obp-go').forEach((btn) => {
    btn.addEventListener('click', () => go(btn.dataset.go));
  });
}

// ── Pointing, never doing ────────────────────────────────────────────────

function go(stepId) {
  const view = targetViewFor(stepId);
  if (!view) return;
  navigate(view);
  // views/settings.js's freshState() opens on the 'providers' section,
  // which IS the API-keys section — so plain navigation lands on the right
  // screen with no reach into that view's internals.
  if (stepId === 'domain') goToDomainsCreate();

  // The panel stays open on purpose: the user is meant to see step 2 next.
  // Re-check now so a step they completed a moment ago ticks over without
  // waiting for the interval.
  const myGen = panelGen;
  refresh(myGen);
}

// Opens Domains' OWN create flow, by clicking its OWN button.
//
// This is deliberate, and the alternatives are worse. A second
// `POST /api/domains` call site is forbidden (see the header). A shell-level
// hand-off in the requestChatScope() style would need a consumer inside
// views/domains.js, which this change does not own. So: click the real
// button the real view already renders.
//
// It is SYNCHRONOUS and needs no staleness guard. navigate() calls the
// view's onEnter synchronously; domains' onEnter calls loadDomainsList(),
// whose FIRST statement after setting flags is render(token) — before any
// await. So the sidebar, including #dm-new-domain-btn (rendered in BOTH the
// loading and the loaded branch), is already in the DOM by the time
// navigate() returns.
//
// DEGRADATION CONTRACT, matching views/domains.js's own for
// requestChatScope: if that id is ever renamed or removed, `?.` makes this
// a silent no-op and the user is simply left on the Domains view with the
// New domain button in front of them — which is the outcome this function
// is trying to reach anyway. It can fail to help; it cannot break anything.
function goToDomainsCreate() {
  document.getElementById('dm-new-domain-btn')?.click();
}

// ── Refresh loop ─────────────────────────────────────────────────────────

function startRefresh() {
  stopRefresh();
  refreshTimer = setInterval(() => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    refresh(panelGen);
  }, REFRESH_MS);
}

function stopRefresh() {
  if (refreshTimer != null) { clearInterval(refreshTimer); refreshTimer = null; }
}

// D-F: myGen is captured by the CALLER, synchronously, and passed in as a
// parameter — so it cannot be re-read from the module variable after the
// await and wrongly compare equal to a newer session.
async function refresh(myGen) {
  if (!isFresh(myGen) || !root) return;
  let facts;
  try {
    facts = await loadFacts();
  } catch {
    return; // leave the panel showing whatever it already had
  }
  if (!isFresh(myGen) || !root) return;
  steps = buildSteps(facts);
  // D-D: finishing setup dismisses the panel by itself — but only for a
  // panel that opened itself. See autoCloseOnComplete's own comment.
  if (autoCloseOnComplete && steps.every((s) => s.done)) { closePanel(); return; }
  render();
}
