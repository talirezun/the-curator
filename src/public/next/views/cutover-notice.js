// Cutover notice — the one-time "the interface changed, here is the way
// back" bar, shown on the first load after "/" stops serving the shipping
// frontend and starts serving this shell.
//
// ── WHAT THIS IS FOR, AND WHO IT IS FOR ─────────────────────────────────
// The cutover is the only release in which a user's app can look entirely
// different without them doing anything: the auto-updater lands it, they
// open the Dock icon, and the seven-tab UI they have used for months is
// gone. The maintainer's decision was a dismissible notice plus a visible
// way back — NOT a forced tour, and NOT a silent swap.
//
// A BRAND-NEW user has nothing to be surprised by. They have never seen
// the old interface, "/old" would show them a second, older app they have
// no reason to want, and the surface that IS for them —
// views/onboarding.js's first-run guidance panel — targets exactly that
// case. So this bar is shown only to an EXISTING user (see isExistingUser
// below), and the two surfaces are disjoint by construction.
//
// ── THE FACTS ARE NOT ENOUGH ON THEIR OWN: THE PROVENANCE GATE ──────────
// isExistingUser() has NO time or provenance component, and three facts that
// any install eventually acquires cannot, by themselves, distinguish "was
// here before the cutover" from "arrived after it". A brand-new user who
// installs post-cutover, adds a key, creates a domain, ingests once and
// reloads satisfies all three — and was shown "The Curator has a new look…
// Use the previous interface", pointing at /old, on their second page load,
// indefinitely. Reproduced live on a fixture whose localStorage held only
// curator-next-view and curator-next-theme, i.e. not one artifact of the
// shipping frontend.
//
// So the bar additionally requires an ORIGIN of 'pre', recorded ONCE and
// never re-decided. The fact that makes this sound is an ordering one:
//
//   • An EXISTING user arrives at this shell with key + domain + pages
//     ALREADY TRUE on their very first /next load — they built all of it in
//     the old UI.
//   • A NEW user can only acquire those three facts BY USING THIS SHELL, so
//     by the time they are true, this module has already run at least once
//     and recorded origin 'post'.
//
// Two rejected alternatives, recorded so they are not re-proposed:
//
//   1. "A localStorage key only the SHIPPING frontend writes."  There is no
//      such key. src/public/app.js writes exactly three
//      (curator-chat-response-style, curator-chat-model-provider,
//      curator-ai-health-disclosure-seen-v1) and /next writes ALL THREE too
//      (views/chat.js and views/domains.js). Keying on any of them — or on
//      their union — re-arms the identical false positive the moment a new
//      user picks a Length in /next's composer. Measured by grep, not
//      assumed.
//   2. "The /next keys being ABSENT proves this is the first /next load."
//      They are not absent by then: boot() calls applyTheme() and
//      navigate(), which write curator-next-theme and curator-next-view
//      SYNCHRONOUSLY, before the Promise.resolve().then() that reaches this
//      module. That is exactly why the live repro fixture had them.
//
// KNOWN AND ACCEPTED, in the fail-safe direction: an existing user whose two
// GETs both fail on their FIRST post-cutover load is recorded 'post' and
// never sees the bar. That is a missed notice, which this file already
// argues is the cheap error (see FAIL-SAFE below). It is not a spurious one.
//
// ── THE PREDICATE, AND WHY IT IS THE STRICT ONE ─────────────────────────
// isExistingUser() = has an API key AND has a domain AND has at least one
// wiki page. Two independent reasons for all three rather than any one:
//
//   1. A page on disk is the only fact that proves the app was actually
//      USED. A key alone can be a half-finished setup; a domain alone can
//      be an empty folder created a minute ago. A wiki page means an
//      ingest completed — the user has seen the old UI do its job.
//
//   2. It makes the exclusion STRUCTURAL. Those three facts are exactly
//      the three steps views/onboarding.js checks, and its shouldShowPanel()
//      never shows when all three are done. So this bar SHOWING implies the
//      guidance panel does not AUTO-show, over the same three booleans, for
//      any facts and whatever either dismissal flag says. That property does
//      not depend on anybody remembering the call ORDER in boot() (which is
//      a second, independent layer) — and scripts/test-cutover.js proves it
//      by executing BOTH modules' real functions over all eight fact
//      combinations.
//
//      TWO PRECISIONS, because the earlier wording here overclaimed:
//
//      (a) It is an IMPLICATION, not a partition. With the origin gate
//          below, a fully-set-up install of post-cutover origin shows
//          NEITHER surface — which is the correct outcome for a new user who
//          has finished setting up, and is the whole point of that gate.
//          "They cannot both show" still holds; "exactly one always shows"
//          does not, and never needed to.
//
//      (b) It is a claim about the AUTOMATIC predicates only. Settings'
//          "Show setup guide" button calls views/onboarding.js's exported
//          openOnboardingPanel() DIRECTLY, which deliberately bypasses
//          shouldShowPanel()'s all-done rule — so a user who has the bar on
//          screen and presses that button really can have both at once.
//          Verified harmless: the bar RESERVES its strip (see LAYOUT below)
//          so the panel sits beneath it and covers no control. The
//          maybeShowCutoverNotice() guard against .obp-root only closes the
//          other direction (panel already open -> bar does not open); there
//          is no guard in this direction and none is wanted, because
//          refusing a button the user just pressed is worse than an overlap
//          that costs nothing.
//      The three predicates below are therefore kept BYTE-IDENTICAL to
//      views/onboarding.js's, and that identity is asserted, because if
//      they silently drift the exclusion quietly stops holding. Two
//      hand-maintained copies of one rule is the v3.2.0 CRITICAL shape;
//      the answer this repo already uses for duplicated PURE helpers is a
//      byte-identity drift test (v3.6.0's test-next-ingest-logic-drift.js),
//      not an import — importing would mean editing onboarding.js to
//      export internals it deliberately keeps private.
//
// ── FAIL-SAFE DIRECTION: HIDE. THE OPPOSITE OF onboarding.js ────────────
// If we cannot tell — either GET fails, the bodies are malformed, or
// localStorage throws on read — this bar does NOT show.
//
// views/onboarding.js's readDismissed() fails the other way (it SHOWS),
// and its header explains why: guidance that never appears leaves a user
// stuck with NO VISIBLE SYMPTOM. The costs here are inverted. A missed
// notice costs one existing user a moment of "where did the old UI go?" —
// and "/old" is still there, plus the release notes. A SPURIOUS notice is
// worse in two ways at once: it tells someone who has never seen the old
// interface that something they never used has changed, and it offers them
// a link INTO a deprecated app, at the exact moment the guidance panel is
// trying to walk them through setup. Wrong-and-noisy beats absent here, so
// absent wins.
//
// ── LAYOUT: IT REFLOWS, IT DOES NOT FLOAT ──────────────────────────────
// views/onboarding.js's panel was measured as a cosmetic overlap and was
// in fact SWALLOWING CLICKS on Domains' primary action and Settings'
// Disconnect/Replace buttons, because a `position: fixed` card with
// `pointer-events: auto` covers whatever is under it. The fix there was to
// make the shell RESERVE the strip.
//
// This bar starts from that answer instead of rediscovering it: it is a
// full-width strip at the very top, and cutover-notice.css shortens
// #app-shell by exactly its height and pushes it down by the same amount,
// so every view REFLOWS and the bar covers nothing. Verified with
// document.elementFromPoint over the CENTRE of real controls in every
// view, not by comparing text bounding boxes.
//
// ── NON-MODAL ──────────────────────────────────────────────────────────
// No scrim, no role="dialog", no aria-modal, no focus trap, and it never
// calls focus(). It is a labelled region the user may ignore forever. The
// two real wizards in this shell are modal on purpose; this is not one.
//
// Owns views/cutover-notice.css (the `cvn-` prefix, used nowhere else).

// Namespaced and versioned like every other /next key
// (curator-next-theme, curator-next-view, curator-next-onboarding-dismissed-v1).
// The -v1 suffix is the convention that lets a future, genuinely different
// notice re-show without hunting down old keys.
const DISMISS_KEY = 'curator-next-cutover-notice-v1';

// The provenance record described in the header: 'pre' | 'post', written
// ONCE — on the first load of this shell that could read the facts — and
// never re-decided afterwards.
//
// Recording the VERDICT rather than a bare "this shell has booted before"
// flag is deliberate: a bare seen-flag would make the bar a strictly
// one-load surface, so an existing user who closed the app without pressing
// "Got it" would never see it again. Persisting the origin keeps the
// intended "shows until dismissed" behaviour for the users it is FOR, while
// permanently excluding the users it is not for.
const ORIGIN_KEY = 'curator-next-install-origin-v1';

// Cross-file contract with cutover-notice.css, which uses it to shorten
// #app-shell. Same shape (and same silent failure mode if the two drift) as
// views/onboarding.js's DOCK_CLASS / shell.css handshake, so it is pinned by
// scripts/test-cutover.js the same way.
const DOCK_CLASS = 'cutover-docked';

// The class views/onboarding.js puts on ITS panel root. Read here only to
// refuse opening on top of it — a cheap third layer under the predicate and
// the call order. Pinned by scripts/test-cutover.js against the real
// onboarding.js so a rename there fails loudly instead of silently
// re-allowing the overlap.
const ONBOARDING_ROOT_CLASS = 'obp-root';

// ═════════════════════════════════════════════════════════════════════════
// PURE LOGIC — no DOM, no fetch, no storage, so scripts/test-cutover.js can
// drive every decision offline, in both directions.
// ═════════════════════════════════════════════════════════════════════════

// ── BYTE-IDENTICAL TO views/onboarding.js ───────────────────────────────
// The next three functions are copied verbatim from views/onboarding.js and
// MUST stay that way — the mutual exclusion above is a claim about the two
// modules agreeing on the same three facts. scripts/test-cutover.js compares
// the extracted bodies character for character and fails on any difference,
// including whitespace. If a fact's definition genuinely needs to change,
// change it in BOTH files in the same edit.
//
// GET /api/config/api-keys. CONFIG-ONLY by design: hasGeminiKey /
// hasAnthropicKey trace to getApiKeys() in src/brain/config.js. Never
// reintroduce geminiUsable/anthropicUsable — v3.0.13 removed them.
function hasApiKey(keys) {
  if (!keys || typeof keys !== 'object') return false;
  // Derived from the payload rather than a hardcoded list of providers: this
  // exact predicate has already gone stale once (it checked only
  // hasGeminiKey/hasAnthropicKey and missed hasOpenrouterKey when the third
  // provider landed, telling an OpenRouter-only user on every load that they
  // still needed a key they had already added) — a fourth provider must not
  // require editing this file again. Any OWN property named has<Provider>Key
  // whose value is strictly `true` counts; Object.hasOwn (never a bare index)
  // is what keeps an inherited name like `constructor` from reading as
  // present.
  for (const k in keys) {
    if (Object.hasOwn(keys, k) && /^has[A-Z][A-Za-z]*Key$/.test(k) && keys[k] === true) return true;
  }
  return false;
}

// GET /api/domains/stats -> { domains: [ { slug, pageCount, ... } ], ... }.
function hasAnyDomain(stats) {
  if (!stats || typeof stats !== 'object') return false;
  return Array.isArray(stats.domains) && stats.domains.length > 0;
}

// pageCount counts every .md under wiki/ EXCEPT index.md and log.md, which
// createDomain() writes — so a freshly-created, never-ingested domain is 0.
// A domain whose stats failed comes back as { slug, error } with no
// pageCount; Number(undefined) is NaN and NaN > 0 is false, so a broken
// domain never falsely counts as "used".
function hasAnyPage(stats) {
  if (!hasAnyDomain(stats)) return false;
  return stats.domains.some((d) => d && Number(d.pageCount) > 0);
}

// ── END BYTE-IDENTICAL BLOCK ────────────────────────────────────────────

// Everything unknown. This is what a failed load produces, and it makes
// isExistingUser() false — the fail-safe HIDE direction.
const UNKNOWN_FACTS = { hasKey: false, hasDomain: false, hasPages: false };

function factsFrom(keys, stats) {
  return {
    hasKey: hasApiKey(keys),
    hasDomain: hasAnyDomain(stats),
    hasPages: hasAnyPage(stats),
  };
}

// See the header. All three, and `=== true` on each so a malformed facts
// object (a string, a missing field, a truthy non-boolean) reads as "cannot
// tell" rather than as "yes".
function isExistingUser(facts) {
  if (!facts || typeof facts !== 'object') return false;
  return facts.hasKey === true && facts.hasDomain === true && facts.hasPages === true;
}

// FAIL-SAFE: HIDE. A storage that throws on read (a real private-mode
// browser does) must be treated as "already dismissed", not as "show". See
// the header for why this is the opposite of onboarding.js's choice.
// `storage` is injected so the throwing case is a real executed assertion
// rather than a source regex.
function readDismissed(storage) {
  try {
    return storage.getItem(DISMISS_KEY) === '1';
  } catch {
    return true;
  }
}

// Best-effort. A storage that refuses the write means the bar returns on the
// next launch — mildly annoying, never harmful, and far better than
// surfacing a storage error over a dismissal click.
function writeDismissed(storage) {
  try {
    storage.setItem(DISMISS_KEY, '1');
    return true;
  } catch {
    return false;
  }
}

// ── PROVENANCE (see the header) ─────────────────────────────────────────
// Returns 'pre' | 'post' | null, where null means "not recorded yet, decide
// now". Anything unrecognised in storage — a value from a future version, a
// half-written string, a key some other tool squatted on — reads as null and
// is re-decided rather than trusted.
//
// FAIL-SAFE: HIDE. A storage that THROWS reads as 'post', the value that
// suppresses the bar, matching readDismissed()'s direction and the header's
// cost argument.
function readOrigin(storage) {
  try {
    const v = storage.getItem(ORIGIN_KEY);
    return (v === 'pre' || v === 'post') ? v : null;
  } catch {
    return 'post';
  }
}

// Best-effort, exactly like writeDismissed. If the write is refused, the
// origin is re-decided from live facts on every load — which for a NEW user
// is the pre-fix behaviour again. Accepted, and bounded by the same storage
// failure that already makes the dismissal non-durable: a browser that
// cannot persist anything cannot be given a one-time surface at all.
function writeOrigin(storage, origin) {
  try {
    storage.setItem(ORIGIN_KEY, origin);
    return true;
  } catch {
    return false;
  }
}

// Decide the origin ONCE. A stored verdict always wins — this is what makes
// the record a provenance fact rather than a second reading of the same
// three booleans, and it is why a user's later ingests can never promote
// them from 'post' to 'pre'.
function classifyOrigin(stored, facts) {
  if (stored === 'pre' || stored === 'post') return stored;
  return isExistingUser(facts) ? 'pre' : 'post';
}

// THE gate. Show iff this install is of PRE-cutover origin, is a
// recognisably existing user, and has not dismissed it. There is no
// "explicit re-open" path and no all-done rule: a one-time notice has
// exactly one reason to appear.
//
// `origin` and `isExistingUser(facts)` are both required even though the
// origin was originally DERIVED from those facts. That is not redundancy: a
// pre-cutover user who later deletes every domain stops satisfying the facts
// and should not be shown a notice about an interface for content that is no
// longer there, and a missing third argument (an old call site, a future
// refactor) must read as HIDE rather than as the pre-fix behaviour.
function shouldShowNotice(facts, dismissed, origin) {
  if (dismissed === true) return false;
  if (origin !== 'pre') return false;
  return isExistingUser(facts);
}

// ═════════════════════════════════════════════════════════════════════════
// Module state
// ═════════════════════════════════════════════════════════════════════════

let root = null;

// Wrapped rather than referenced directly: some privacy modes throw on the
// `window.localStorage` property access itself, not only on getItem. The
// stand-in throws from every method, which readDismissed() turns into HIDE.
function storage() {
  try {
    return window.localStorage;
  } catch {
    return { getItem() { throw new Error('no storage'); },
             setItem() { throw new Error('no storage'); } };
  }
}

// Never throws: this runs on the boot path, and boot() must reach
// markBooted() (see maybeShowCutoverNotice's comment). A missing <body> or a
// classList a host does not implement degrades to "no strip reserved", which
// is cosmetic, not a blank page.
function setDocked(on) {
  try {
    document.body.classList.toggle(DOCK_CLASS, !!on);
  } catch { /* no body / no classList — the bar still renders, undocked */ }
}

// ═════════════════════════════════════════════════════════════════════════
// Data
// ═════════════════════════════════════════════════════════════════════════

async function getJson(url) {
  const res = await fetch(url);
  const ct = String(res.headers.get('content-type') || '').toLowerCase();
  // The SPA catch-all answers an unknown path with the shell's index.html at
  // HTTP 200 (v2.3.3), so res.json() would throw `Unexpected token '<'`.
  // Treat that as "no data" — which, here, means HIDE.
  if (!ct.includes('application/json')) return null;
  if (!res.ok) return null;
  return res.json();
}

// Neither request may take the other down: allSettled, then null for
// whichever failed. A failure therefore reads as "not an existing user",
// which HIDES the bar — the fail-safe direction.
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
// Entry point
// ═════════════════════════════════════════════════════════════════════════

// THE BOOT HOOK, called once from app.js's boot().
//
// SAFETY PROPERTY THIS MUST KEEP — the highest-stakes detail in this file,
// and the same one views/onboarding.js's maybeShowOnboarding() carries:
// app.js calls markBooted() immediately after boot() returns, and
// next/index.html's inline <head> guard treats an unset
// window.__curatorBooted at DOMContentLoaded as proof this module died — it
// then paints a full-page blank-page recovery panel TO EVERY USER. So this
// function must never be able to stop markBooted() from running. Two
// independent reasons it cannot:
//   1. It is `async`, so its body — including its synchronous prologue — can
//      only ever produce a rejected promise, never a synchronous throw at
//      the call site.
//   2. Its whole body is inside try/catch, so it does not even reject.
// The call site in boot() adds more layers (a promise chain that is not
// awaited, with its own .catch, inside its own try/catch).
//
// RETURNS true iff the bar was opened. app.js uses that to decide whether to
// run the first-run guidance check at all — the second, independent layer of
// the exclusion. openBar() is deliberately the LAST thing this function
// does, so "returned false or rejected" reliably means "nothing was put on
// screen" and the caller can safely fall through to onboarding.
export async function maybeShowCutoverNotice() {
  try {
    const dismissed = readDismissed(storage());
    // Short-circuit before the two GETs: a dismissed notice cannot show
    // whatever the facts say, and this runs on every page load for the rest
    // of the install's life. shouldShowNotice() below is still handed the
    // REAL dismissed value, so there is exactly one place the verdict is made.
    const facts = dismissed ? UNKNOWN_FACTS : await loadFacts();
    // Provenance, decided once. The write is skipped when `dismissed` short-
    // circuited the loads: UNKNOWN_FACTS would record 'post' from facts we
    // never actually read. Nothing is lost by skipping it — a dismissed
    // notice can never show again whatever the origin says.
    const stored = readOrigin(storage());
    const origin = classifyOrigin(stored, facts);
    if (stored === null && !dismissed) writeOrigin(storage(), origin);
    if (!shouldShowNotice(facts, dismissed, origin)) return false;
    // Third layer, and the only one that can see the actual page: never open
    // on top of the first-run guidance panel. Unreachable today (the
    // predicates are complements and this runs first), which is the point —
    // it costs one query and removes a whole class of future regression.
    if (document.querySelector('.' + ONBOARDING_ROOT_CLASS)) return false;
    openBar();
    return true;
  } catch (err) {
    // Never fatal, and it must not reach the pre-boot error recorder.
    console.error('[next/cutover] notice check failed', err);
    return false;
  }
}

// ═════════════════════════════════════════════════════════════════════════
// Bar
// ═════════════════════════════════════════════════════════════════════════

function openBar() {
  if (root) return;
  setDocked(true);

  root = document.createElement('div');
  root.className = 'cvn-bar';
  // A labelled REGION, never a dialog. No aria-modal, no focus trap, and
  // nothing below calls focus() — the caret stays wherever the user left it.
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', 'Interface update notice');

  const msg = document.createElement('p');
  msg.className = 'cvn-msg';

  const strong = document.createElement('strong');
  strong.className = 'cvn-lede';
  strong.textContent = 'The Curator has a new look.';
  msg.appendChild(strong);

  const rest = document.createElement('span');
  rest.className = 'cvn-detail';
  // Says the thing an existing user actually wants to know first. Every
  // string here is a literal and every one is set with textContent, never
  // innerHTML — the discipline is what survives an edit that makes one of
  // them dynamic.
  rest.textContent = ' Everything is where you left it — same domains, same wiki, same settings. Nothing was migrated or moved.';
  msg.appendChild(rest);

  root.appendChild(msg);

  const actions = document.createElement('div');
  actions.className = 'cvn-actions';

  // A REAL anchor with a real href, not a click handler that calls
  // location.assign — so it is middle-clickable, copyable, and works if the
  // script that wired it ever fails to run.
  const back = document.createElement('a');
  back.className = 'cvn-link';
  back.href = '/old';
  back.textContent = 'Use the previous interface';
  actions.appendChild(back);

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'cvn-dismiss';
  dismiss.textContent = 'Got it';
  dismiss.addEventListener('click', () => {
    writeDismissed(storage());
    closeBar();
  });
  actions.appendChild(dismiss);

  root.appendChild(actions);
  document.body.appendChild(root);
}

function closeBar() {
  if (!root) return;
  root.remove();
  root = null;
  // Paired with openBar's setDocked(true). The class toggle is the WHOLE of
  // the layout state, so dismissing restores the shell exactly with nothing
  // left half-unwound.
  setDocked(false);
}
