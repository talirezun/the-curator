// First-run guidance panel — the /next shell's answer to "I just opened
// this and I have no idea what to do first."
//
// ── THIS IS NOT A WIZARD, AND THAT IS THE WHOLE POINT ───────────────────
// the design handoff's ARCHITECTURE.md (a PRIVATE document, not this repo's docs/architecture.md) explicitly REJECTS a first-run wizard. The binding
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
// ── TWO DOORS, AND WHY THERE ARE NOW TWO STEP SETS (v3.61.0) ────────────
// The three steps above are one audience's: somebody who reads a lot and
// wants a wiki out of it. For the OTHER audience this app has — somebody
// giving their agents memory — the same three steps were actively
// wrong, measured against the code rather than assumed:
//
//   · step 1 claimed "nothing else works without a model". The memory
//     layer and the MCP bridge need NO key and no running server:
//     mcp/server.js reads and writes markdown under getDomainsDir()
//     directly, and src/brain/working-state.js's brief / handoff /
//     journal / foundations paths are pure filesystem. The app was telling
//     them to stop and fetch a credential they do not need.
//   · step 3 (hasAnyPage) can never complete for them — they have no PDFs
//     — so the panel stayed permanently unfinished and the only fix
//     available was to dismiss the guidance.
//   · the two steps that DO matter to them (a project, a connected agent)
//     were in no step at all.
//
// So STEP_SETS holds two ordered sets and the panel picks one. What it
// must NOT do is store a persona: a stored one goes stale the day the user
// does the other thing, and this app's rule is that a reading nobody
// re-took is not a reading. The set is therefore DERIVED — from the same
// kind of on-disk fact the ticks already come from (deriveDoor below) —
// and the two doors are shown only while no fact discriminates.
//
// The door the user presses writes app.js's EXISTING `curator-next-view`
// key. No new storage key: scripts/test-ui-state.js's census classifies
// every curator-* string in this tree, and that key is already classified
// (per-device, positional). Its honest limit is stated at
// writeLandingView() — it is a LAST-VIEW key, not a preferred-home key.
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

import { navigate, afterViewMount, icon, escapeHtml,
         requestDomainFold, ADD_SOURCES_FOLD } from '../app.js';
import { loadUiState, durableStorage } from '../shared/ui-state.js';
// G1 (v3.71.0): the framing ⓘ beside this panel's own title — the first
// screen a user who dismisses this guide otherwise never sees the shape of.
// Same mechanism as everywhere else in the app (shared/text.js's delegated
// listener); the mark and its panel are two fragments this module places
// itself, exactly like every other `explainerMark` adopter.
import { explainerMark } from '../shared/explainer.js';

// Namespaced like every other /next key (curator-next-theme,
// curator-next-view, curator-next-chat-domain).
const DISMISS_KEY = 'curator-next-onboarding-dismissed-v1';

// app.js's own landing key, by the same literal — NOT a second key. See
// writeLandingView() for what writing it does and does not buy, and the
// two-doors block in the header for why no new key was created.
const LANDING_VIEW_KEY = 'curator-next-view';

// ── THE DOCK HANDSHAKE ──────────────────────────────────────────────────
// The panel is `position: fixed`, which takes no space, so on its own it
// COVERED the top-right of whatever view was mounted — and because
// .obp-panel is `pointer-events: auto`, it swallowed those clicks rather
// than merely obscuring them. Measured at 1280x800, elementFromPoint over
// the centre of Domains' "Ask this domain" button and Settings'
// "Disconnect"/"Replace" buttons returned the PANEL. Settings is where
// step 1 sends the user, so the guide was covering the controls it exists
// to point at.
//
// Moving it is not available: R7 forbids blocking the composer, and the
// composer is bottom-centred at 780px, so every bottom corner lands on it.
// So shell.css reserves the strip instead — `body.guide-docked .main` ends
// the content box before the card starts and the view REFLOWS.
//
// This class name is a CROSS-FILE contract with shell.css, and the failure
// mode if the two sides drift is silent: no error, no console warning, the
// gutter simply stops being reserved and the panel goes back to covering
// live controls. scripts/test-next-onboarding.js §11 compares this literal
// against shell.css's own selector for exactly that reason.
//
// It is toggled in openPanel/closePanel ONLY — the same two-call-site
// shape as startRefresh/stopRefresh above it — so the class is present iff
// `root` is, and dismissing therefore restores the layout with nothing
// left to unwind.
const DOCK_CLASS = 'guide-docked';

// Never throws: this runs from boot(), and boot() must reach markBooted()
// (see maybeShowOnboarding's comment). A missing <body> or a classList a
// host does not implement must degrade to "no gutter reserved", which is
// the pre-fix cosmetic state, not a blank page.
function setDocked(on) {
  try {
    document.body.classList.toggle(DOCK_CLASS, !!on);
  } catch { /* no body / no classList — the panel still renders, unducked */ }
}

// ── THE DOCK'S HEIGHT, FOR THE NARROW-WINDOW TOP DOCK (v3.76.0) ─────────
// Below 1100px shell.css docks this panel along the TOP of the main column
// instead of the right, and shortens the main column by exactly the panel's
// height (`margin-top: var(--guide-dock-h)`). CSS cannot read a fixed box's
// height, so this publishes it, and keeps it current as the card's content
// changes (a step ticks over, text wraps differently after a resize). The
// property is removed on close, so the shell's own 0px default applies and
// the layout is restored exactly — the same "nothing left half-unwound"
// guarantee DOCK_CLASS gives. Published at every width; only the narrow
// band reads it.
const DOCK_H_VAR = '--guide-dock-h';
let dockHeightObserver = null;

function watchDockHeight(el) {
  unwatchDockHeight();
  const publish = () => {
    try {
      const h = Math.ceil(el.getBoundingClientRect().height);
      document.documentElement.style.setProperty(DOCK_H_VAR, h + 'px');
    } catch { /* no layout (a test harness) — the shell's 0px default stands */ }
  };
  publish();
  if (typeof ResizeObserver === 'function') {
    dockHeightObserver = new ResizeObserver(publish);
    dockHeightObserver.observe(el);
  }
}

function unwatchDockHeight() {
  if (dockHeightObserver) { dockHeightObserver.disconnect(); dockHeightObserver = null; }
  try { document.documentElement.style.removeProperty(DOCK_H_VAR); } catch { /* no document */ }
}

// ── THE RE-CHECK, AND WHY IT USED TO RUN FOREVER ────────────────────────
// The panel has to notice a step being completed in ANOTHER view of the same
// SPA — the user clicks "Open Settings", pastes a key, and step 1 must tick
// over without them coming back and clicking anything. There is no event to
// listen to (views/settings.js owns that save and does not announce it), so
// the panel re-checks.
//
// An earlier version of this comment said the re-check "is running against
// an install with zero or very few domains", that "both endpoints are
// readdir-only local reads", and that it "stops the moment the panel closes
// AND the moment all three steps go done". All three were wrong, and the
// first two were contradicted by this same file: the header records,
// knowingly, that a developer whose only key lives in .env sees this panel —
// on a FULLY POPULATED install, where hasKey can never go true, so the
// checklist never completes and the loop never ends. The third was wrong
// because the all-done stop lived inside `if (autoCloseOnComplete)`, and
// Settings' "Show setup guide" passes that as FALSE. On a complete install
// that panel cannot close itself, so its poll ran for the life of the page,
// in every view, because the panel is appended to document.body and survives
// navigate().
//
// And it was not readdir-only. GET /api/domains/stats read every CLAUDE.md
// (twice, until this release) and every wiki/log.md IN FULL: 598 KB per poll
// on the maintainer's own tree, twelve times a minute, forever — roughly
// 420 MB an hour of filesystem reads per open tab, growing with the wiki.
// That endpoint is now 16 KB a poll (src/brain/files.js, src/routes/
// domains.js), but a cheaper leak is still a leak, so the loop itself is
// fixed here too, following the shape views/memory.js established in
// v3.17.3 for the same class of problem:
//
//   · a setTimeout CHAIN, not setInterval — a slow re-check must delay the
//     next one, not stack a second fetch on top of it;
//   · an ADAPTIVE delay derived from how long the last one actually took,
//     so an install far larger than the one this was tuned against throttles
//     itself instead of becoming a busy poll;
//   · a HARD STOP once all three steps are done, whatever autoCloseOnComplete
//     says — a finished checklist has nothing left to watch for, and keeping
//     the panel VISIBLE (which that flag is really about) does not require
//     keeping it BUSY;
//   · nothing at all while the tab is hidden, plus a focus/visibilitychange
//     revalidation so coming back is instant rather than up to one delay late;
//   · a no-op guard, so a re-check that found nothing new does not rebuild
//     the panel's DOM — which it did, every five seconds, destroying and
//     restoring focus each time.
//
// POLL_BASE_MS is deliberately the SAME 5 s the old interval used. Setup
// responsiveness is the entire point of this panel and lengthening the
// interval would have traded the user's first five minutes for the leak;
// the leak is fixed by the stop condition and the duty cycle, not by making
// the first-run path slower.
const POLL_BASE_MS = 5000;
const POLL_DUTY = 20;          // spend at most 1/20th of the wall clock re-checking
const POLL_MAX_MS = 300000;

// ═════════════════════════════════════════════════════════════════════════
// PURE LOGIC — no DOM, no fetch, no storage. Everything this panel DECIDES
// lives here so scripts/test-next-onboarding.js can drive it offline, in
// both directions, without a browser.
// ═════════════════════════════════════════════════════════════════════════

// R7. The order is the design, not an implementation detail.
const STEP_ORDER = ['api-key', 'domain', 'ingest'];

// The other audience's order, and it is a different argument rather than a
// reshuffle of the same one. Nothing in this set needs a model, so the key
// is not a precondition and must not be shown as one: somewhere for
// knowledge to land -> the project an agent resumes -> the bridge that
// reaches it, and THEN the key, marked optional, because ingest and chat
// are the halves it really does gate.
const AGENT_STEP_ORDER = ['domain', 'project', 'bridge', 'api-key'];

// The one place the two orders are named together. Read this rather than
// either array when you want "the steps for whoever is looking".
const STEP_SETS = { knowledge: STEP_ORDER, agent: AGENT_STEP_ORDER };

// The two doors. `view` is what the door writes into app.js's landing key;
// it may only ever be a view the rail actually has (writeLandingView
// validates against this list, so a door is the only thing that can name
// one). The bodies are held to the 13-word lede ceiling
// (docs/design-system-source.md §3) and pinned there.
const DOORS = [
  {
    id: 'knowledge',
    view: 'domains',
    title: 'Build a second brain',
    body: 'Read sources, get a wiki. Ingest and chat need an AI key.',
  },
  {
    id: 'agent',
    view: 'memory',
    title: 'Give your agents memory',
    body: 'Your agents read and write project context. No AI key needed.',
  },
];

const STEP_COPY = {
  // ── WHY THIS NO LONGER CLAIMS THAT NOTHING WORKS WITHOUT A KEY ───────
  // It said "Nothing else works without a model", which is false for half
  // the people who read it — see the two-doors block in the header. The
  // replacement names WHICH halves need a key, in the order they matter,
  // and says what does not. The risk is stated rather than hidden: a user
  // who reads "work without one" may skip the key and later find Ingest
  // and Chat refuse, which is why the sentence leads with the two features
  // that need it instead of with the exemption.
  'api-key': {
    title: 'Add an AI key',
    todo: 'Needed for ingest and chat. Project context and the bridge work without one.',
    done: 'A key is saved, so The Curator can read and write.',
    action: 'Open Settings',
  },
  // ── WHY THIS STEP IS NOT CALLED "CREATE" ANY MORE ───────────────────
  // It read "Create your first domain" / "A domain is one subject area
  // with its own wiki", which is the right advice for exactly one of the
  // two people who see it. The other — an existing user opening the new
  // macOS app, whose six domains live in a folder the app is not pointed
  // at — was being told to start over, on the one screen where they are
  // already wondering whether their knowledge base survived. The step's
  // real goal was never "create"; it is "have somewhere for knowledge to
  // land", which its own `done` copy has always said. So the title states
  // the goal and the body names BOTH ways to reach it.
  //
  // The action is unchanged, and deliberately so: this panel POSTS
  // NOTHING (see the header), and views/domains.js now carries both routes
  // on the screen this button opens. Adding a second button here would put
  // a folder-switching call site inside a first-run panel that has, by
  // design, never mutated anything.
  domain: {
    title: 'Point at a wiki, or start one',
    todo: 'Already have a knowledge base? Open Domains and choose the folder it lives in. ' +
          'Starting fresh? Create a domain — one subject area with its own wiki.',
    done: 'You have somewhere for knowledge to land.',
    action: 'Open Domains',
  },
  // ── WHY THE ACTION SAYS "OPEN DOMAINS" ON AN INGEST STEP (v3.64.0) ──
  // Ingest left the rail. The panel's own rule is that a step POINTS at the
  // real surface that owns the job, and as of this release that surface is
  // the ADD SOURCES section of the domain page — where a person is already
  // looking at the domain the file is going into, rather than choosing it a
  // second time from another view's picker. The step id, the title and the
  // body are unchanged because the JOB is unchanged; only where it lives
  // moved, and the button says where it now goes.
  ingest: {
    title: 'Ingest your first source',
    todo: 'Drop in a PDF, Markdown or text file. The Curator reads it and writes the wiki pages.',
    done: 'Your wiki has pages in it — the loop is running.',
    action: 'Open Domains',
  },
  // The agent set's two new steps. Both POINT, like every other step: the
  // project is created by views/domains.js's own form (the same rule that
  // keeps step 2 a navigation), and the bridge snippet is Settings' to
  // hand out.
  project: {
    title: 'Start a project',
    todo: 'Open Domains and add one under Projects. A project is what an agent resumes.',
    done: 'A project exists, so an agent has somewhere to save.',
    action: 'Open Domains',
  },
  // ── HARNESS-NEUTRAL, DELIBERATELY ─────────────────────────────────────
  // Not "connect Claude Desktop". The bridge is a stdio JSON-RPC server, so
  // it serves any MCP client that can run a local program — Claude Code and
  // Cursor among them — and naming one product here would tell the other
  // two thirds of its users that this step is not theirs. The DONE-ness has
  // the same problem and is solved the same way: it comes from the usage
  // log, never from `installed` in GET /api/mcp/config, which inspects
  // Claude Desktop's config file ONLY and would read false for ever for
  // everyone else — step 3's never-completing defect, rebuilt.
  bridge: {
    title: 'Connect your agent',
    todo: 'Settings → MCP bridge hands you the snippet your agent needs. It runs with the app closed.',
    done: 'Your agent has called the bridge — it can read and save.',
    action: 'Open Settings',
  },
};

// What the AGENT set changes about a shared step. Only the copy differs;
// the done-ness fact, the action and the destination are the same, because
// they are the same step. `optional: true` is what puts the flag on it, and
// it is a flag on ONE of four rows rather than on all of them (v3.16.1: a
// mark carried by 100% of a list carries nothing).
const AGENT_STEP_COPY = {
  'api-key': {
    todo: 'Needed for ingest and chat.',
    optional: true,
  },
};

// GET /api/config/api-keys. CONFIG-ONLY by design — see the header.
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

// GET /api/memory -> { ok, projects: [ { domain, project, … } ], total, … }.
// ONE ROW PER PROJECT since v3.48.0, across every domain, which is exactly
// the question this step asks. `total` is the store's own count taken
// BEFORE its cap, so it is read as well as the array: a capped list would
// otherwise be the only evidence and a cap is not a measurement.
function hasAnyProject(index) {
  if (!index || typeof index !== 'object') return false;
  if (Array.isArray(index.projects) && index.projects.length > 0) return true;
  return Number(index.total) > 0;
}

// GET /api/mcp/usage -> { present, logStartedAt, tools: [ { lastUsedAt,
// countTotal, … } ], … } (v3.60.0). The step is done when a client has
// actually CALLED something, which is the thing that matters and the thing
// that is harness-neutral.
//
// `present` alone is not enough and the difference is not pedantry: the log
// is rotated at 1 MB and can be deleted, so a present-but-empty file means
// "nothing since this log began", not "a call happened". Requiring a used
// tool makes the absent case read NOT-DONE, which SHOWS the step — this
// file's fail-safe direction (see the header) — instead of ticking a step
// the user never completed.
function bridgeHasBeenUsed(usage) {
  if (!usage || typeof usage !== 'object') return false;
  if (usage.present !== true) return false;
  if (!Array.isArray(usage.tools)) return false;
  return usage.tools.some((t) => (
    !!t && ((typeof t.lastUsedAt === 'string' && t.lastUsedAt.length > 0) || Number(t.countTotal) > 0)
  ));
}

const UNKNOWN_FACTS = {
  hasKey: false, hasDomain: false, hasPages: false, hasProject: false, bridgeUsed: false,
};

// The two agent-side bodies are TRAILING and DEFAULTED, so every existing
// two-argument call still means what it meant: absent -> false -> not done,
// which is the SHOW direction.
function factsFrom(keys, stats, projects, usage) {
  return {
    hasKey: hasApiKey(keys),
    hasDomain: hasAnyDomain(stats),
    hasPages: hasAnyPage(stats),
    hasProject: hasAnyProject(projects),
    bridgeUsed: bridgeHasBeenUsed(usage),
  };
}

// ── WHICH DOOR IS THE USER BEHIND, AND WHO DECIDES ──────────────────────
// Returns 'knowledge' | 'agent' | null. NULL IS NOT A FAILURE: it is the
// answer "no fact discriminates", and it is what puts the two doors on
// screen. Three rules, in this order:
//
//   1. An explicit press this session wins over any fact. The user saying
//      which audience they are is better evidence than an inference, and
//      overriding it would make the doors decorative.
//   2. `hasPages` -> knowledge. Pages are unique to that path, and the tie
//      goes to it deliberately: the knowledge steps are the SHIPPED ones,
//      and a maintainer who does both must not lose the path that works.
//   3. A project, or a bridge that has answered a call -> agent. Both are
//      unique to that path.
//
// `hasKey` and `hasDomain` are NOT consulted, and that is the whole reason
// this is a three-line function rather than a score: both appear in BOTH
// paths, so neither carries any signal about which audience is looking. A
// user who has pasted a key and made an empty domain still gets the doors,
// because the app genuinely does not know yet.
function deriveDoor(facts, chosen) {
  if (chosen === 'knowledge' || chosen === 'agent') return chosen;
  const f = (facts && typeof facts === 'object') ? facts : UNKNOWN_FACTS;
  if (f.hasPages === true) return 'knowledge';
  if (f.hasProject === true || f.bridgeUsed === true) return 'agent';
  return null;
}

// ── THE LANDING WRITE, AND EXACTLY WHAT IT BUYS ─────────────────────────
// This is app.js's OWN key (`VIEW_KEY`, app.js:272), not a new one, and the
// honest reading of it is narrower than "the door sets your home view":
//
//   · app.js reads it ONCE, in boot(), through pickStartView() — which also
//     validates it against ALL_VIEWS, so a door naming a view a future
//     build has dropped falls back to HOME_VIEW rather than breaking;
//   · every navigate() WRITES it. So the next rail click supersedes this,
//     and the app's existing "restore the view you left" behaviour takes
//     over — which for somebody who spends the session in Project context
//     lands them there anyway.
//
// What the write therefore buys is the first frame of the NEXT launch for a
// user who chose a door and then quit. That is small, and it is the whole
// of what the contract asked for; no second key is created to make it
// bigger (scripts/test-ui-state.js's census is the gate on that, and the
// design reason is in the header).
//
// `storage` is injected rather than reaching for localStorage, so the
// throwing case (a private window genuinely throws on setItem) is an
// executed assertion. Best-effort like writeDismissed(): a refused write
// costs the next launch's first frame and nothing else.
function writeLandingView(storage, view) {
  if (!DOORS.some((d) => d.view === view)) return false;
  try {
    storage.setItem(LANDING_VIEW_KEY, view);
    return true;
  } catch {
    return false;
  }
}

// The one place a step's done-ness is decided, in the one order that is
// allowed. Returns a plain array so the test can assert both the order and
// each step's state without touching the DOM.
//
// `door` is DEFAULTED to the knowledge set, so a one-argument call — which
// is what every caller made before v3.61.0, and what the suite still makes
// — returns exactly the three steps it always did, in the same order, with
// the same done-ness. Anything not 'agent' resolves to 'knowledge': an
// unknown door must land on the shipped path, never on an empty list.
function buildSteps(facts, door) {
  const f = (facts && typeof facts === 'object') ? facts : UNKNOWN_FACTS;
  const doneBy = {
    'api-key': f.hasKey === true,
    domain: f.hasDomain === true,
    ingest: f.hasPages === true,
    project: f.hasProject === true,
    bridge: f.bridgeUsed === true,
  };
  const isAgent = door === 'agent';
  const order = isAgent ? STEP_SETS.agent : STEP_SETS.knowledge;
  return order.map((id) => {
    const base = STEP_COPY[id];
    // Object.hasOwn, never a bare index: an inherited name must not be able
    // to supply copy (the same rule hasApiKey() above is written to).
    const over = (isAgent && Object.hasOwn(AGENT_STEP_COPY, id)) ? AGENT_STEP_COPY[id] : null;
    const copy = over ? Object.assign({}, base, over) : base;
    return {
      id,
      title: copy.title,
      body: doneBy[id] ? copy.done : copy.todo,
      action: copy.action,
      done: doneBy[id],
      optional: copy.optional === true,
    };
  });
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
  // NOT 'ingest' (v3.64.0). The full-page Ingest VIEW still exists and is
  // still reachable — see HOSTED_VIEWS in app.js — but it is no longer where
  // this step sends anyone, because it is no longer where the feature lives
  // for a person following a checklist. This function's whole contract is
  // "which view does this step navigate to", so it answers with the view
  // go() really calls navigate() with; a table that said 'ingest' while go()
  // went to 'domains' would be a lookup that lies, and the pure-lookup shape
  // exists precisely so the suite can assert the mapping without a shell.
  if (stepId === 'ingest') return 'domains';
  // Domains owns the project list (PROJECTS IN THIS DOMAIN) and its create
  // form — the same view step 2 points at, for the same reason.
  if (stepId === 'project') return 'domains';
  // Settings owns the MCP bridge blocks. go() additionally opens that
  // SECTION, the same way step 2 opens Domains' create form.
  if (stepId === 'bridge') return 'settings';
  return null;
}

// ═════════════════════════════════════════════════════════════════════════
// Module state
// ═════════════════════════════════════════════════════════════════════════

let root = null;
let steps = buildSteps(UNKNOWN_FACTS);
// Which door the user PRESSED, this page load, or null. Deliberately NOT
// persisted: a stored persona is what §8(b) of the design pass argues down,
// and the cost of not storing it is named rather than hidden — a hard reload
// before any discriminating fact exists shows the doors again. The panel
// itself survives navigate() (it lives on document.body), so this outlives
// every in-app move; only a real page load clears it.
let chosenDoor = null;
// The last facts the panel actually read, kept so a door press can rebuild
// the step list immediately instead of waiting for the next re-check.
let lastFacts = UNKNOWN_FACTS;
// The door the CURRENT paint was built for — 'knowledge' | 'agent' | null,
// where null means the two doors are on screen. Derived, never stored.
//
// The INITIAL value is 'knowledge' rather than null, and that is about one
// specific path: Settings' "Show setup guide" opens the panel SYNCHRONOUSLY
// from whatever module state exists, and on a page where the automatic
// check short-circuited (already dismissed) no facts have been read yet. A
// null start would ask a finished install "what do you want to set up
// first?" for the ~100 ms until the re-check lands. Starting on the shipped
// three-step path means that first frame is today's exact behaviour, and
// the doors arrive a moment later only when the facts really do not
// discriminate. Every paint after the first is deriveDoor()'s.
let activeDoor = 'knowledge';
let refreshTimer = null;
let prevFocus = null;
// How long the last re-check actually took, in ms. Feeds nextPollDelay().
let lastRefreshMs = 0;
// Guards against a manual re-check (go()) and a scheduled one overlapping.
let refreshing = false;
// Wake-on-focus listener, held so closePanel can remove it. A listener that
// outlives the panel is the same leak as a timer that does.
let wakeHandler = null;
// The signature of what render() last painted, so a re-check that changed
// nothing costs no DOM work — see screenSignature().
let renderedSignature = null;

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

// ── DURABLE, NOT MERELY LOCAL (v3.28.0) ────────────────────────────────
// The dismissal is now recorded server-side as well as in localStorage,
// through shared/ui-state.js. The reason is the storage PARTITION, not the
// key name: a native shell (Electron) gets an empty one, so a fully set-up
// user would be shown the first-run setup panel again on the app's first
// launch — the app stating something false about them.
//
// durableStorage() is a drop-in for the wrapper this function used to build:
// same getItem/setItem shape, same key, and an UNRECORDED field still falls
// through to real localStorage AND ITS THROW. That is what preserves this
// file's deliberate fail-safe direction — SHOW, the OPPOSITE of
// views/cutover-notice.js's, for the reason argued in the header — without
// this change having to restate or re-derive it.
//
// `removeItem` STAYS in the shape, and it is the reason this field is the
// one durable field that is NOT monotonic. clearDismissed() below is reached
// from views/settings.js's "Show setup guide" — an explicit UN-dismiss the
// product deliberately offers ("a tour you can never get back is worse than
// none"). A first draft of this change made every field monotonic; that would
// have left `storage.removeItem` undefined, so clearDismissed()'s try/catch
// would swallow a TypeError and report false while the server kept holding
// the dismissal — the re-open silently ceasing to persist. Caught by reading
// the call sites rather than by trusting the sentence that had already been
// written here claiming nothing called it.
function storage() {
  return durableStorage();
}

// ── THE LANDING KEY DOES *NOT* GO THROUGH durableStorage() ──────────────
// It is app.js's key, and app.js reads it from REAL localStorage in boot().
// shared/ui-state.js's durable store is an allow-list of four fields, and
// `curator-next-view` is deliberately not one of them: it is per-device by
// decision (a desktop and a laptop have no business agreeing about which
// screen was last open), and scripts/test-ui-state.js records that reason.
// Writing it through the durable wrapper would either be refused or would
// put a positional preference in the file that holds the API keys — so this
// one write goes to the same place its only reader reads from.
//
// Reaching for `localStorage` can itself THROW (a sandboxed context refuses
// the property access, not just the call), which is why this is wrapped and
// why the fallback is an object whose setItem throws: writeLandingView's
// try/catch then reports the refusal instead of the panel breaking.
function landingStorage() {
  try {
    if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
  } catch { /* the access itself is refused — fall through */ }
  return { setItem() { throw new Error('storage unavailable'); } };
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

// Requests are independent and none is allowed to take another down:
// Promise.allSettled, then null for whichever failed. A failure therefore
// reads as "not done", which SHOWS the panel — the fail-safe direction (see
// the header).
//
// ── THE SECOND PAIR IS CONDITIONAL, AND THAT IS A COST DECISION ─────────
// This runs on a timer for as long as the checklist is unfinished, so two
// more endpoints per tick is not free — and GET /api/memory walks every
// domain's state tree, which is the most expensive of the four. They are
// therefore fetched only when they can change the answer:
//
//   · door already 'knowledge'  -> never. Neither fact appears in that step
//     set, and neither can move the door once it is chosen.
//   · door already 'agent'      -> always. Two of its four ticks are these.
//   · no door yet               -> only when hasAnyPage(stats) is FALSE.
//     If pages exist, deriveDoor() returns 'knowledge' on that fact alone
//     (rule 2), so the pair could not change the outcome.
//
// The practical effect is that the install where this panel polls forever —
// a fully populated wiki whose only key lives in .env, the case this file's
// header records — pays nothing at all for the new facts.
async function loadFacts(chosen) {
  const [keysRes, statsRes] = await Promise.allSettled([
    getJson('/api/config/api-keys'),
    getJson('/api/domains/stats'),
  ]);
  const keys = keysRes.status === 'fulfilled' ? keysRes.value : null;
  const stats = statsRes.status === 'fulfilled' ? statsRes.value : null;
  const needsAgentFacts = chosen === 'agent' || (chosen !== 'knowledge' && !hasAnyPage(stats));
  if (!needsAgentFacts) return factsFrom(keys, stats, null, null);
  const [projRes, usageRes] = await Promise.allSettled([
    getJson('/api/memory'),
    getJson('/api/mcp/usage'),
  ]);
  const projects = projRes.status === 'fulfilled' ? projRes.value : null;
  const usage = usageRes.status === 'fulfilled' ? usageRes.value : null;
  return factsFrom(keys, stats, projects, usage);
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
    // ONE shared GET for the whole page load, memoised in shared/ui-state.js.
    // Until v3.41.0 views/cutover-notice.js ran first and had already awaited
    // the same promise by the time this did, so this call cost no second
    // request; that module is deleted, so this is now the FIRST awaiter and
    // the one that pays for the GET. Still one request per load either way —
    // the memoisation is what guarantees that, not the call order. It never
    // throws and never rejects, so the markBooted() property above is
    // untouched.
    await loadUiState();
    const dismissed = readDismissed(storage());
    // Short-circuit BEFORE the two GETs. A dismissed panel cannot show
    // whatever the facts say, and this runs on every page load for the
    // entire life of the install — there is no reason to pay for two
    // readdir-backed requests to throw the answer away. shouldShowPanel()
    // below is still handed the REAL dismissed value, so there is exactly
    // one place the show/hide verdict is made.
    const facts = dismissed ? UNKNOWN_FACTS : await loadFacts(chosenDoor);
    lastFacts = facts;
    const door = deriveDoor(facts, chosenDoor);
    // The GATE is always asked about a real step list, even while the doors
    // are on screen. When no door is derivable the knowledge set stands in,
    // and that cannot mis-gate: door === null implies hasPages === false
    // implies the ingest step is not done, so the all-done rule below can
    // never fire on a list built this way.
    const next = buildSteps(facts, door || 'knowledge');
    if (!shouldShowPanel(next, dismissed)) return;
    activeDoor = door;
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
  // Before the already-open early return, not after it: a re-open from
  // Settings while the panel is on screen must not be able to leave the
  // gutter unreserved.
  setDocked(true);
  if (root) {
    // Already open (Settings re-open while it is on screen) — just refresh
    // the content and, if this was an explicit request, move focus to it.
    steps = nextSteps;
    render();
    if (focus) focusHeading();
    // Re-arm if this re-open made the checklist incomplete again. Cheap and
    // self-guarding: startRefresh() returns immediately when shouldKeepPolling()
    // is false, so the ordinary "already complete, still complete" re-open
    // starts nothing. Without it, a poll that correctly stopped on completion
    // could never come back within the same panel session.
    startRefresh(panelGen);
    return;
  }
  panelGen += 1;
  steps = nextSteps;
  prevFocus = document.activeElement;

  root = document.createElement('div');
  root.className = 'obp-root';
  document.body.appendChild(root);
  render();
  watchDockHeight(root);

  // Only on an explicit request. The automatic path must NEVER steal focus
  // — someone who opened the app to type a message keeps their caret.
  if (focus) focusHeading();

  // REVALIDATE ON WAKE. The step this panel is most often waiting on is an
  // API key, and the cheapest signal that one may have appeared is the user
  // coming back: `focus` covers alt-tabbing from the provider's console after
  // copying a key, `visibilitychange` covers a background tab being brought
  // forward, which fires no focus event. Both cost nothing while the user is
  // away — which is exactly when the thing being waited for happens.
  //
  // myGen is CAPTURED, not read from panelGen inside the handler: a listener
  // that outlived its panel would otherwise hand a newer session's counter to
  // isFresh() and be waved through. closePanel() removes it, so that cannot
  // happen — capturing means it does not depend on remembering to.
  const myGen = panelGen;
  wakeHandler = () => {
    if (typeof document !== 'undefined' && document.hidden) return;
    if (!isFresh(myGen) || !shouldKeepPolling()) return;
    refresh(myGen);
  };
  if (typeof window !== 'undefined') window.addEventListener('focus', wakeHandler);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', wakeHandler);

  startRefresh(myGen);
}

function closePanel() {
  if (!root) return;
  panelGen += 1; // every in-flight handler from this session is now stale
  // TEARDOWN. Both of these outlive the panel if they are not undone here,
  // and both keep FETCHING for something nobody can see: an armed timer for
  // the life of the page, and a wake listener every time the window regains
  // focus. The generation bump above makes their bodies no-ops, but a guard
  // that merely makes work pointless is not the same as not doing it — the
  // listener would still be attached to window for the life of the document.
  stopRefresh();
  unwatchDockHeight();
  if (wakeHandler) {
    if (typeof window !== 'undefined') window.removeEventListener('focus', wakeHandler);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', wakeHandler);
    wakeHandler = null;
  }
  renderedSignature = null;
  lastRefreshMs = 0;

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
  // Paired with openPanel's setDocked(true). Runs BEFORE the focus restore
  // below so the layout the restored element is measured/scrolled into is
  // the final one, not the docked one.
  setDocked(false);

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
  // No door derivable yet -> the two doors take the body instead of the
  // step list. Nothing else about the panel changes: same section, same
  // heading, same dismiss, same foot. It is one card in two states, not a
  // first page of a flow — there is no Next, and no step is withheld
  // pending an answer.
  const askingDoor = activeDoor === null;

  const rows = steps.map((s, i) => (
    '<li class="obp-step' + (s.done ? ' obp-step-done' : '') + '" data-step="' + escapeHtml(s.id) + '">' +
      '<span class="obp-mark' + (s.done ? ' obp-mark-done' : '') + '" aria-hidden="true">' +
        (s.done ? icon('check', 12) : String(i + 1)) +
      '</span>' +
      '<span class="obp-step-text">' +
        '<span class="obp-step-title">' + escapeHtml(s.title) + '</span>' +
        // A flag on a MINORITY of the rows, which is the only way a flag
        // carries anything (v3.16.1 / v3.53.1) — one of the agent set's
        // four, and none of the knowledge set's three.
        //
        // It is a SIBLING of the title rather than nested inside it, and
        // that is not a layout preference: the escaping guard in
        // scripts/test-next-onboarding.js §7 finds an interpolation by the
        // quote-plus-value-plus-quote shape around it, so putting this
        // ternary between escapeHtml(s.title) and its closing quote would
        // stop that guard seeing the title site at all — a guard silently
        // ceasing to reach the thing it protects, which is this project's
        // named failure shape. Kept outside, every escapeHtml() site in
        // this function stays scanned, and §7 now counts them.
        (s.optional ? '<span class="obp-step-optional">Optional</span>' : '') +
        '<span class="obp-step-body">' + escapeHtml(s.body) + '</span>' +
      '</span>' +
      (s.done
        ? '<span class="obp-step-done-tag">Done</span>'
        : '<button type="button" class="btn btn-secondary obp-go" data-go="' + escapeHtml(s.id) + '">' +
            escapeHtml(s.action) +
          '</button>') +
    '</li>'
  )).join('');

  // BOTH doors are btn-secondary. Neither is the primary: design-system §1
  // reserves that tier for the one action that finishes a block, and a door
  // finishes nothing — it is a choice between two equal paths, and making
  // one of them look like the answer is the recommendation this card is
  // specifically not making.
  const doors = DOORS.map((d) => (
    '<li class="obp-door">' +
      '<button type="button" class="btn btn-secondary obp-door-btn" data-door="' + escapeHtml(d.id) + '">' +
        escapeHtml(d.title) +
      '</button>' +
      '<span class="obp-door-body">' + escapeHtml(d.body) + '</span>' +
    '</li>'
  )).join('');

  const frameInfo = explainerMark('obp-frame-info', 'onboarding.frame');

  root.innerHTML =
    '<section class="obp-panel" role="region" aria-labelledby="obp-title">' +
      '<div class="obp-head">' +
        '<h2 class="obp-title" id="obp-title" tabindex="-1">Getting started</h2>' +
        frameInfo.btn +
        '<button type="button" class="obp-dismiss" id="obp-dismiss" ' +
          'aria-label="Dismiss the setup guide">' + icon('x', 14) + '</button>' +
      '</div>' +
      frameInfo.panel +
      (askingDoor
        ? '<p class="obp-ask">What do you want to set up first?</p>' +
          '<ul class="obp-doors">' + doors + '</ul>'
        : '<p class="obp-progress" aria-live="polite">' + escapeHtml(progressLabel(steps)) + '</p>' +
          '<ol class="obp-steps">' + rows + '</ol>') +
      // Offered ONLY when the door was pressed, never when it was derived:
      // on a derived door this control would flip the panel back to a
      // question the facts have already answered, and it would answer it
      // again a moment later. It is the "both doors stay visible"
      // mitigation the design pass asks for, one click deep.
      (!askingDoor && chosenDoor !== null
        ? '<button type="button" class="obp-swap" id="obp-swap">Pick a different start</button>'
        : '') +
      (allDone
        ? '<p class="obp-foot">Everything here is done — this guide will not come back on its own.</p>'
        : '<p class="obp-foot">You can ignore this and just start typing. ' +
          'Settings → General → Show setup guide brings it back.</p>') +
    '</section>';

  // Recorded HERE, next to the paint it describes, rather than at the call
  // site: render() has several callers and a signature stamped by only some
  // of them would let a stale value pass the no-op guard in refresh().
  renderedSignature = screenSignature();
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
  root.querySelectorAll('.obp-door-btn').forEach((btn) => {
    btn.addEventListener('click', () => chooseDoor(btn.dataset.door));
  });
  const swap = root.querySelector('#obp-swap');
  if (swap) swap.addEventListener('click', () => chooseDoor(null));
}

// ── Choosing a door ─────────────────────────────────────────────────────
// The only thing on this panel that writes anything other than the
// dismissal, and what it writes is app.js's landing key — see
// writeLandingView() for exactly what that buys. It does NOT navigate: the
// user is on the view they opened the app on, and re-mounting it under them
// to make a choice visible would be the panel doing something rather than
// pointing. The visible effect is the step list it swaps in; the steps' own
// buttons do the moving, as every step always has.
//
// `null` is a real argument, not a miss: it is the "Pick a different start"
// control handing the decision back, which clears the choice and lets
// deriveDoor() ask the facts again.
function chooseDoor(doorId) {
  if (doorId === null) {
    chosenDoor = null;
  } else {
    const door = DOORS.find((d) => d.id === doorId);
    if (!door) return;
    chosenDoor = door.id;
    writeLandingView(landingStorage(), door.view);
  }
  activeDoor = deriveDoor(lastFacts, chosenDoor);
  steps = buildSteps(lastFacts, activeDoor || 'knowledge');
  render();
  // Re-check now: the agent set's two facts may not have been fetched yet
  // (loadFacts skips them until they can matter), so its ticks would
  // otherwise all read not-done until the next tick of the timer.
  const myGen = panelGen;
  refresh(myGen);
  // A door press can only ever make the checklist INCOMPLETE again (a set
  // with more unmet steps), and startRefresh() returns immediately when
  // there is nothing left to watch — so this is safe to call unconditionally
  // and is what re-arms a loop that had correctly stopped.
  startRefresh(myGen);
}

// ── Pointing, never doing ────────────────────────────────────────────────

function go(stepId) {
  const view = targetViewFor(stepId);
  if (!view) return;
  // ── BEFORE navigate(), NOT AFTER, AND THAT ORDER IS THE BEHAVIOUR ────
  // Same destination as step 2, a different part of it. NOT a click through
  // afterViewMount: see app.js's requestDomainFold() for why a <details>
  // fold takes a request where a button takes a click — clicking a <summary>
  // TOGGLES, and this fold is remembered per domain, so a click would shut
  // it for exactly the users who had already opened it.
  //
  // And it is recorded FIRST because navigate() does not always defer: with
  // motion off, or on a first navigation, the mount happens INSIDE
  // navigate(), so a request written afterwards would be written after the
  // consumer had already looked and found nothing — a step that works with
  // animations on and silently does nothing with them off. This is the same
  // ordering every other producer of a shell request uses (record, then
  // navigate), and it is why this one is not wrapped in afterViewMount the
  // way goToDomainsCreate() is: that helper needs the DOM, this needs to be
  // early.
  if (stepId === 'ingest') requestDomainFold(ADD_SOURCES_FOLD);
  navigate(view);
  // views/settings.js's freshState() opens on the 'providers' section,
  // which IS the API-keys section — so plain navigation lands on the right
  // screen with no reach into that view's internals.
  //
  // THROUGH afterViewMount, NOT DIRECTLY. v3.57.0 gave navigate() an exit
  // animation, so the new view is mounted after that ~80ms rather than
  // before navigate() returns. A bare call here would look for a button that
  // does not exist yet and the `?.` below would swallow it SILENTLY — step 2
  // would degrade to "you land on Domains and no form opens", every time, with
  // nothing in the console. afterViewMount runs the callback once the pending
  // mount has happened, and IMMEDIATELY when nothing is pending, so this is
  // also correct with motion off and on a first navigation.
  if (stepId === 'domain') afterViewMount(goToDomainsCreate);
  // Same shape, same reason, same degradation contract — see
  // goToMcpBridge(). Settings lands on its FIRST section (Providers & keys,
  // from SETTINGS_SECTIONS[0]), so without this the bridge step would send
  // somebody to the key screen it has just told them they do not need.
  if (stepId === 'bridge') afterViewMount(goToMcpBridge);

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
// WHEN IT MAY RUN, precisely. Domains' onEnter calls loadDomainsList(), whose
// FIRST statement after setting flags is render(token) — before any await — so
// the sidebar, including #dm-new-domain-btn (rendered in BOTH the loading and
// the loaded branch), is in the DOM by the time onEnter RETURNS. What changed
// in v3.57.0 is WHEN onEnter runs: navigate() now plays an exit animation
// first, so the mount lands up to `--dur-instant` later. This function is
// therefore called from go() through afterViewMount() rather than inline; it
// still needs no staleness guard of its own, because that callback runs
// exactly once, immediately after the mount it was queued for.
//
// DEGRADATION CONTRACT, matching views/domains.js's own for
// requestChatScope: if that id is ever renamed or removed, `?.` makes this
// a silent no-op and the user is simply left on the Domains view with the
// New domain button in front of them — which is the outcome this function
// is trying to reach anyway. It can fail to help; it cannot break anything.
function goToDomainsCreate() {
  document.getElementById('dm-new-domain-btn')?.click();
}

// Opens Settings' MCP bridge SECTION by clicking Settings' own nav row —
// the goToDomainsCreate() pattern exactly, for the same three reasons: no
// second write path, no reach into another view's internals, and a
// degradation contract where a renamed hook leaves the user on Settings
// with the section list in front of them rather than throwing.
//
// The selector is the row views/settings.js renders from SETTINGS_SECTIONS
// (`<button class="settings-nav-row" data-section="mcp">`). Queried by the
// pair, not by the class alone, so a reordering of that array cannot make
// this click a different section.
function goToMcpBridge() {
  document.querySelector('.settings-nav-row[data-section="mcp"]')?.click();
}

// ── Refresh loop ─────────────────────────────────────────────────────────

// THE STOP CONDITION, in exactly one place so it cannot be half-applied the
// way the old `if (autoCloseOnComplete && …)` one was. A closed panel and a
// finished checklist both mean "there is nothing left to find out".
//
// Note what it is NOT gated on: autoCloseOnComplete. That flag decides
// whether a completed panel VANISHES, which is a question about what the
// user sees after asking for it from Settings. It has never had anything to
// say about whether the app should keep hitting the disk, and reading it as
// if it did is what made the leak permanent on exactly the path a user
// reaches deliberately.
function shouldKeepPolling() {
  return !!root && !steps.every((s) => s && s.done === true);
}

/**
 * How long to wait before the next re-check.
 *
 * Derived from the measured cost of the LAST one rather than fixed, so this
 * cannot become a busy poll on an install far larger than the one it was
 * tuned against — the case that actually bit here, where the panel is shown
 * on a fully populated wiki because the only API key lives in .env.
 */
function nextPollDelay() {
  return Math.min(POLL_MAX_MS, Math.max(POLL_BASE_MS, lastRefreshMs * POLL_DUTY));
}

/**
 * A setTimeout CHAIN, re-armed only after the previous re-check has settled.
 * setInterval would queue a second pair of GETs on top of a slow first pair;
 * this structurally cannot.
 *
 * A hidden tab reschedules WITHOUT fetching — nobody is looking, and
 * wakeHandler re-checks the moment they are.
 *
 * `myGen` is captured by the CALLER and threaded through (D-F), never
 * re-read from the module variable inside the callback: a timer that
 * outlived its session would otherwise compare the live counter against
 * itself and be waved through.
 */
function startRefresh(myGen) {
  stopRefresh();
  if (!shouldKeepPolling()) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    if (!isFresh(myGen) || !shouldKeepPolling()) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      startRefresh(myGen);
      return;
    }
    refresh(myGen).finally(() => {
      if (isFresh(myGen)) startRefresh(myGen);
    });
  }, nextPollDelay());
}

function stopRefresh() {
  if (refreshTimer != null) { clearTimeout(refreshTimer); refreshTimer = null; }
}

// What render() actually paints, reduced to a comparable string. Everything
// visible is a pure function of the steps' ids and done-ness: the title, body
// and action text all come from STEP_COPY keyed on exactly those two, the
// progress line counts them, and the footer branches on all-done. So a
// signature over (id, done) is not an approximation of the screen — it IS
// the screen, and a re-check that leaves it unchanged can skip render()
// entirely rather than tearing down the panel's DOM and putting focus back.
// v3.61.0: the DOOR is part of it, and it has to be. The body is the two
// doors when activeDoor is null and the step list otherwise, so a signature
// over the steps alone would let the panel flip from question to checklist
// (or back) with no repaint — the no-op guard in refresh() reading "nothing
// changed" about the one thing that changed most. `chosenDoor` is in it too,
// because it is what decides whether the swap control is drawn.
function screenSignature() {
  return String(activeDoor) + '/' + String(chosenDoor) + '|' +
    steps.map((s) => (s && s.id) + ':' + (s && s.done === true) + ':' + (s && s.optional === true)).join('|');
}

// D-F: myGen is captured by the CALLER, synchronously, and passed in as a
// parameter — so it cannot be re-read from the module variable after the
// await and wrongly compare equal to a newer session.
async function refresh(myGen) {
  if (!isFresh(myGen) || !root) return;
  // One re-check at a time. go() fires a manual one on every step click while
  // the scheduled chain is armed independently, so without this a click
  // landing near a tick issues both pairs of GETs at once — on the endpoint
  // this release is trying to stop hammering.
  if (refreshing) return;
  refreshing = true;
  let facts;
  const startedAt = Date.now();
  try {
    facts = await loadFacts(chosenDoor);
  } catch {
    return; // leave the panel showing whatever it already had
  } finally {
    refreshing = false;
  }
  if (!isFresh(myGen) || !root) return;
  // Feeds nextPollDelay(). Recorded from the REAL request pair rather than
  // estimated, so the backoff tracks the install this is actually running on.
  lastRefreshMs = Date.now() - startedAt;
  lastFacts = facts;
  // Re-DERIVED every re-check, never remembered: this is what lets the doors
  // resolve themselves while they are on screen. Somebody who presses no
  // door and goes and makes a project in Domains comes back to the agent
  // checklist, because the fact appeared — which is the whole argument for
  // deriving rather than storing.
  activeDoor = deriveDoor(facts, chosenDoor);
  steps = buildSteps(facts, activeDoor || 'knowledge');
  // D-D: finishing setup dismisses the panel by itself — but only for a
  // panel that opened itself. See autoCloseOnComplete's own comment.
  if (autoCloseOnComplete && steps.every((s) => s.done)) { closePanel(); return; }
  // A complete checklist the user asked to SEE still stays on screen (that is
  // what autoCloseOnComplete is for) — but shouldKeepPolling() now reads
  // false, so startRefresh() will not re-arm and the loop ends here. Falling
  // through to render() is deliberate: the ticks must appear.

  // NOTHING CHANGED -> DO NOTHING. render() replaces root.innerHTML wholesale,
  // so an unconditional re-render every tick destroyed and rebuilt the panel
  // forever, taking the user's focus with it and relying on the restore below
  // to put it back. In the steady state — which is nearly always, because the
  // panel is waiting for a change that has not happened yet — the correct
  // amount of DOM work is none.
  if (screenSignature() === renderedSignature) return;

  // PRESERVE FOCUS ACROSS THE RE-RENDER. render() replaces root.innerHTML, so
  // every node inside it is destroyed — including whichever one the user was
  // on. Without this, an explicit "Show setup guide" focuses the heading and
  // then this refresh (its two GETs resolve ~100 ms later) silently drops
  // focus to <body>, stranding a keyboard user mid-panel. The automatic path
  // is unaffected because it never takes focus in the first place, which is
  // exactly why the bug was invisible: it only fires on the accessible path.
  // Restore by id rather than by node — the node itself will not survive.
  const active = document.activeElement;
  const refocusId = root.contains(active) && active.id ? active.id : null;
  render();
  if (refocusId) {
    const again = root.querySelector('#' + refocusId);
    if (again && typeof again.focus === 'function') {
      try { again.focus(); } catch { /* non-focusable in some engines — harmless */ }
    }
  }
}
