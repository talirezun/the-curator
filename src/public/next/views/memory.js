// View: Agent memory — "your agents' brain".
//
// Renders the working-state store (src/brain/working-state.js) that agents
// read and write over MCP: a standing project brief, a per-scope /
// per-machine handoff, and an append-only journal of saves.
//
// Backend used (see src/routes/memory.js):
//   GET   /api/memory                       -> { projects: [...] } index,
//                                              one row per PROJECT, each
//                                              carrying its `domain`
//   GET   /api/memory/:domain/:project      -> brief + work-stream index
//   GET   /api/memory/:domain/:project?scope=&machine=&journalLimit=
//                                           -> brief + current.md + journal
//   PATCH /api/memory/:domain/projects/:project  {brief} -> the ONE write
//
// ─────────────────────────────────────────────────────────────────────────
// PROJECTS INSIDE A DOMAIN (v3.48.0)
// ─────────────────────────────────────────────────────────────────────────
// A DOMAIN is where knowledge lives. A PROJECT is a thing you build, and a
// domain can host several. So the rail's list is GROUPED — domain, then the
// projects inside it — and the last project you looked at in each domain is
// remembered, because coming back to the wrong one of five is the whole
// friction this grouping exists to remove.
//
// Every user-facing word here is the one from the model, not the one from
// the filesystem: PROJECT, WORK-STREAM (the store calls it a `scope`, and
// the slug is still shown as one), STANDING BRIEF. "Tier" and a bare
// "handoff" are never used on screen without saying what they mean.
//
// ─────────────────────────────────────────────────────────────────────────
// THIS VIEW WRITES EXACTLY ONE THING: THE STANDING BRIEF
// ─────────────────────────────────────────────────────────────────────────
// Tiers 2 and 3 — the per-(work-stream, machine) handoff and its journal —
// have exactly one writer, an agent through the MCP tools, and that is what
// makes the per-machine layout safe (working-state.js's LAYOUT block: two
// machines never touch one file, so `git pull -X theirs` has no conflicting
// hunk to silently resolve away). Nothing here can write them; there is no
// editor, no Save, and no endpoint on the route to reach.
//
// The standing brief is a different file with a different owner. It is the
// HUMAN's — docs/working-state.md has said since v3.17.0 that you edit it by
// opening `state/<project>/project.md` in Obsidian — and the edit here is
// that same edit through a nicer door, stamped `authoredBy.kind: 'human'`,
// which is exactly what the store's own brief-authority reading looks for.
// It is not written under an agent's provenance line, because it is not
// written by an agent.
//
// Because the brief write is a real write, the Save button IS gated while it
// is in flight (one at a time, disabled while busy) — but this view still
// does not participate in the cross-view write gate (app.js's isAnyWriteBusy
// / beginDomainWrite) the way Sync and Ingest do: an ingest cannot conflict
// with `state/`, and refusing to read or edit a brief during one would be
// inventing a restriction the backend does not enforce.
//
// ─────────────────────────────────────────────────────────────────────────
// DESIGN — A DASHBOARD, IN FIVE BLOCKS (v3.55.0)
// ─────────────────────────────────────────────────────────────────────────
// The maintainer's verdict on the v3.54.0 page was "not okay", in six parts,
// and the shape below is each of them answered. See `renderProject` for the
// list and for which block answers which.
//
//   ① STATUS         — "Working on:", the Last-saved reading, every caveat
//   ② WORK-STREAMS   — a TABLE of the project's (scope, machine) pairs
//   ③ CURRENT HANDOFF— the lead fold, the document you came to read
//   ④ STANDING BRIEF — yours, with a pencil beside the title and an editor
//   ⑤ SESSION JOURNAL— history, folded, last
//
// ONE COLUMN, ONE RIGHT EDGE, ONE RHYTHM. The five blocks are
// shared/block.js's `renderBlock`, so shell.css's `.settings-job-block`
// declaration — 24 | 1px hairline | 24 — owns every gap between them, and this
// view declares that gap nowhere. `.mem-section` survives for the elements
// ABOVE the first block (the breadcrumb, the read-only note, the copy
// confirmation) and for the error and loading arms, with ONE bridging rule in
// memory.css so the step into the first block is the same 24.
//
// NOTHING IS CAPPED AT READING WIDTH ANY MORE, and that is a deliberate
// reversal. `.mem-doc`, `.mem-doc-headline` and `.mem-save-line` each stopped
// at `--prose-max` while the journal beside them ran the full column; on a
// 1200px column that is 47% of the width, and the page read as endlessly long
// because everything on it was half as wide as it could be. A measure cap is
// right for a DOCUMENT and wrong for a dashboard, and memory.css records the
// reversal against the rule it reverses.
//
// TWO FOLDS, NOT THREE. The handoff keeps its <details> (a fifteen-hundred-word
// handoff is not what every visit is for) and so does the journal (fifty rows
// of history, and it is the section that made the page long). The standing
// brief is NOT a fold: a block head is a heading, and a pencil in a <summary>
// would be the hazard below.
//
// "How this works" is not a card. It explains the three tiers and the
// read-only rule, which is read once per user and then never again, so it is
// the header's ⓘ panel — a mark beside the title (see renderMain). Each block
// carries its own ⓘ for the same reason, with the lede at twenty visible words
// or fewer and the depth behind the mark. WHAT NEVER FOLDS is a warning
// (v3.16.1): every save verdict, the stale notice and the unlisted note are in
// block ①'s BODY.
//
// Native <details> rather than a hand-rolled disclosure: keyboard operation
// and screen-reader announcement come free, which is the same reasoning
// settings.js's model picker records.
//
// THE <summary> HAZARD (v3.0.1-beta.18, and settings.js's model picker):
// an interactive control placed inside a <summary> toggles its own section
// when clicked. Every control in this view — the work-stream table's row
// buttons, the journal's "Show more", the brief's pencil, Save, Preview,
// Cancel — is a SIBLING of its <details>, or lives in a <details> BODY, or
// sits in a block that is not a <details> at all. The handoff's summary holds
// spans only: an eyebrow, a pip and a readout, no button and no link. There is
// therefore no propagation path to suppress, so no later edit can drop a
// stopPropagation that isn't there.
//
// SQUARE marker, not round: agent memory is a different KIND of thing from a
// knowledge domain, and the rail already puts them side by side. Domains use
// a round dot (.dm-row-dot border-radius: 50%); this uses a square
// (.mem-row-mark, radius 2px). Both docs/architecture.md and this view's own
// previous placeholder promised that distinction; it is honoured here.

import {
  registerView, setSidebar, setMain, escapeHtml, icon,
  isCurrentMount, reportAsyncMountFailure,
} from '../app.js';
import { renderMarkdown } from '../shared/markdown.js';
// The ONE text system in /next (shared/text.js). Imported, never re-implemented:
// the five roles exist precisely so a view stops inventing its own -desc /
// -hint / -quiet class per sentence. This view had FOUR semantic roles sharing
// `.mem-quiet` alone, and rendered a runtime ERROR in the same class as a
// marketing sentence (`.sidebar-hint`). scripts/test-next-memory-ingest-text.js
// asserts these imports are present AND reached, because a component that ships
// unused is the shape this repo keeps re-learning.
import {
  renderDescription, renderStatus, renderReadout, renderViewHeader,
} from '../shared/text.js';
// Every link out of the app into docs/ is a key in ONE table, checked offline
// against the real markdown (shared/docs-links.js). The "How this works" panel
// ends with one rather than with a hand-typed URL that nothing can verify.
import { docsLinkHtml } from '../shared/docs-links.js';
import { createLoadingGate, gatedLoader, settleGate } from '../shared/loading-gate.js';
// THE PAGE RHYTHM, imported rather than re-declared. v3.53.0 built the section
// block for Providers & keys, v3.54.0 moved the other four Settings sections
// onto it and lifted it into shared/block.js, and this screen is the first
// consumer outside Settings. Its CSS (24 | hairline | 24, the `.settings-*`
// names shared/block.js's header explains) lives in shell.css, so a view can
// rely on it without depending on another view's stylesheet.
import { renderBlock } from '../shared/block.js';

// THE FRESHNESS SCALE, imported rather than declared. `freshnessStep` used to
// live in this file, beside the first screen that needed it; it is now one
// half of the app-wide scale shared/freshness.css paints, so it lives in
// shared/age.js with the rest of the age vocabulary and the numbers are
// unchanged. `formatAge` deliberately stays a byte-identical COPY in this
// file rather than an import — this module registers a view and reaches for a
// DOM at import time, so shared/age.js (which must stay importable in plain
// Node) copies it in the other direction, and scripts/test-sidebar-status-
// rows.js pins the two bodies against each other. Importing a pure numeric
// function out of that DOM-free module has no such constraint.
// `freshnessTier` comes with it: the same scale under its app-wide NAMES, which
// is what shared/freshness.css paints on `.fresh-dot`. The work-stream table
// and the rail rows wear the DOT (round, 8px, the shared mark); the save strip
// and the handoff summary keep the `.mem-save-pip-s*` SQUARE, whose geometry is
// this view's own. One scale, two silhouettes — never two ladders.
import { freshnessStep, freshnessTier } from '../shared/age.js';

// The paste-into-your-entry-file block. ONE text, shared with the Domains
// view — see that module's header for what was measured and why the wording
// is frozen. This screen offers it because this screen is where someone ends
// up when they are wondering why a project has no state: the answer is often
// that the agent's harness never activated the skill, and this is the fix.
import { composeAgentInstructions, COPY_SUCCESS_BANNER } from '../shared/agent-instructions.js';

// ── THE TWO PICKERS ARE GONE, AND SO IS THE HANDOFF THEY NEEDED ──────────
//
// `renderScopeControls` built a scope listbox and a machine listbox, and a
// module-level `pendingListboxes` array carried each control's cfg from the
// render pass to the wiring pass. Both are deleted.
//
// WHY. The maintainer's verdict on the shipped screen was that work-streams
// were hard to FIND: a dropdown answers "which one am I looking at" and
// refuses to answer "what have I got, and which of them moved today" — you
// have to open it, read it, close it, and hold the list in your head. The
// menubar widget has answered that question for Mac users since v3.37.0 by
// showing the rows; this screen now shows the same rows, which is also the
// first time a Windows or Linux user has been able to see them at all.
//
// `renderWorkStreams` therefore renders a TABLE, one row per (scope, machine)
// pair, newest first, each row a button. There is no cfg to carry across the
// paint, so there is no handoff array and no `mountListbox` pass in wire().
// scripts/test-next-listbox.js counts this view's adoptions and now expects
// ZERO of them.
//
// The `<summary>` hazard this file's header records is unaffected: the table
// is a SIBLING of every <details> on the page, exactly as the pickers were.

// The standing brief's wall. src/routes/memory.js refuses a longer document
// with 400 `brief_too_large`, so the editor shows the limit rather than
// letting someone write past it and lose the write. Read as BYTES because that
// is what the route measures — a brief full of em-dashes and arrows runs out
// sooner than its character count suggests, and a counter that said otherwise
// would be wrong in the direction that costs the user their text.
const BRIEF_MAX_BYTES = 32768;

// Journal page sizes. The store clamps journalLimit to [1, 50] itself
// (MAX_JOURNAL_ENTRIES); these are just the two steps this view offers, and
// the store stays the authority on the ceiling.
const JOURNAL_PAGE = 10;
const JOURNAL_MORE = 50;

// ── Revalidation ─────────────────────────────────────────────────────────
//
// THIS SCREEN IS A WINDOW ONTO DATA ANOTHER PROCESS WRITES, and that makes a
// one-shot fetch on entry wrong here in a way it is not in Domains or Sync,
// where the browser is the only writer. The whole premise of the feature is
// that agents write this through the MCP while you watch.
//
// Measured, with the view open on a project: a save that added a second
// scope left the sidebar reading `1 scope · 12 hr ago` while the scope
// picker beside it listed TWO. Not a counting bug — GET /api/memory already
// answered `scopeCount: 2` — purely that nothing re-asked. Two panes
// disagreeing on screen reads as a broken app rather than as stale data.
//
// Three triggers, cheapest first:
//   · selecting a project — the detail fetch already happens then, so the
//     index is one request away and the two panes land together;
//   · the window regaining focus / the tab becoming visible — the exact
//     moment someone comes back from the agent that just wrote, and free
//     while they are away;
//   · a self-scheduling poll, for the case neither of those fires (the app
//     visible and focused on a second monitor while an agent runs).
//
// THE POLL IS ADAPTIVE BECAUSE THE ROUTE IS NOT FREE. `listWorkingScopes`
// stats every (scope, machine) pair and reads a 16 KB journal tail per pair,
// for every domain, up to MAX_PROJECTS = 200 (see src/routes/memory.js,
// which says so about itself). Measured at 2.2-3.6 ms over 3 domains with 2
// pairs — trivial — but that cost scales with domains x pairs, and a number
// picked against a 3-domain machine is a busy poll on a 200-domain one. So
// the interval is DERIVED from how long the last refresh actually took: at
// least POLL_BASE_MS, never more than 1/POLL_DUTY of the wall clock, capped
// at POLL_MAX_MS. A big install throttles itself without anyone tuning it.
//
// It is a setTimeout CHAIN, not setInterval: a slow refresh must delay the
// next one, not stack up behind it.
const POLL_BASE_MS = 20000;
const POLL_DUTY = 20;              // spend at most 1/20th of the wall clock refreshing
const POLL_MAX_MS = 300000;

// ── THE AGE CLOCK IS NOT THE POLL, and conflating them is how the menubar
//    widget's one useful property would have been lost here ────────────────
//
// The freshness reading on the handoff is the widget's reading, and a widget
// ticks. The poll above is a NETWORK cost and is throttled accordingly; the
// age clock is arithmetic over a timestamp already in hand, so it costs one
// Date.parse per painted reading per second and asks the server nothing.
//
// It writes `textContent` on the elements carrying `data-mem-age-at` and it
// MUST NOT call render(): a render replaces both panes by innerHTML, which
// closes the ⓘ panel, churns focus and shuts any picker the user has open.
// settings.js shipped a 1s render tick and v3.53.1 records it as a defect.
// The PIP's class is deliberately not re-derived here either — it is cut on
// formatAge's own unit bands, which is exactly when screenSignature changes
// and the pane repaints anyway, so mark and word still move together.
const AGE_TICK_MS = 1000;

function freshState() {
  return {
    loading: true,
    projects: [],          // GET /api/memory -> projects[]
    indexError: null,
    // HOW MANY DOMAINS THE SERVER LOOKED AT. `null` until the first answer,
    // and `null` from a server too old to say — which is why the empty state
    // reads it as three values and not as a number. An empty `projects` means
    // "no domains" or "domains, none with agent memory", and those are two
    // different first screens; see renderNoProjects.
    domainsScanned: null,

    // WHICH PROJECT, IN WHICH DOMAIN. Two fields, not one composite string:
    // every request needs them separately, and a composite would have to be
    // split at each of the four call sites — four places for a parse to
    // disagree. `activeKey()` builds the comparable form where a comparison
    // is what is wanted (the post-await "is this still the selection?"
    // guards), and it is derived, never stored.
    activeDomain: null,
    activeProject: null,
    // The last "Copy agent instructions" outcome, or null:
    //   { domain, project, ok, text }
    // STAMPED with its pair for the same reason briefEdit is: this view
    // switches project without unmounting, and an unstamped confirmation
    // would sit under the next project's header claiming its block had been
    // copied. Cleared whenever the selection changes.
    copied: null,
    // The standing-brief editor, or null when nothing is being edited.
    //   { domain, project, loaded, text, busy, error, preview, confirmDiscard }
    // `loaded` is the document the editor OPENED on and never changes; `text`
    // is the draft. The pair is what makes "is this dirty?" answerable without
    // re-reading the server, which is what Escape has to know.
    // Stamped with its own (domain, project) so a reply that lands after the
    // user has moved on cannot be applied to a different project's brief —
    // the same stamp discipline the rest of this view uses for scopes.
    briefEdit: null,
    // The UNSCOPED read for activeProject: brief + the full scope index.
    // Cached across scope switches so changing scope costs one request.
    projectRead: null,
    // The SCOPED read: current.md + journal for (scope, machine).
    detail: null,
    detailError: null,
    detailLoading: false,

    scope: null,
    machine: null,
    journalLimit: JOURNAL_PAGE,

    // WHICH DISCLOSURES THE USER HAS OPENED, by stable key.
    //
    // Every render re-emits the whole main pane, so a <details> written
    // without `open` comes back CLOSED — and loadScope() re-renders. Measured:
    // clicking "Show more" fetched all 15 entries, put them in the DOM, and
    // shut the journal on top of them, so the button read as doing nothing.
    // The same mechanism closed any fold the user had opened on every scope
    // or machine change.
    //
    // A key is written here only when the user actually toggles one, so
    // `undefined` still means "no opinion" and each fold keeps its own
    // default — the HANDOFF opens (it is the answer this screen gives) and
    // the JOURNAL stays shut (it is history, and it is the section that made
    // this page long). There are only those two keys since v3.55.0: the
    // standing brief is a block rather than a fold.
    openFolds: {},

    // ── Revalidation bookkeeping (see the Revalidation block above) ──────
    //
    // When the read that produced what is CURRENTLY on screen was issued, in
    // ms. Deliberately the START of that read, not its completion: a write
    // landing mid-fetch may or may not be reflected, and the fail-safe
    // direction is to offer a reload that was not strictly needed rather
    // than to leave a stale document on screen claiming to be current.
    // 0 means "nothing read yet", never "read at the epoch".
    detailFetchedAt: 0,
    // When the SCOPE LIST currently in the picker was fetched, in ms. Kept
    // separate from detailFetchedAt on purpose: they answer two different
    // questions and are healed two different ways.
    //
    //   · detailFetchedAt is about the DOCUMENT, which is never swapped
    //     under a reader — a newer write is OFFERED as a Reload and stays
    //     offered until the user takes it, so that mark deliberately does
    //     not move on its own.
    //   · scopesFetchedAt is about the PICKER, which is a list of what
    //     EXISTS. A scope that exists and is missing from it is simply a
    //     wrong answer, and there is nothing to interrupt by correcting it.
    //
    // Sharing one mark would force a choice between never healing the picker
    // (the defect) and re-fetching on every poll for as long as the Reload
    // notice is up (the notice does not dismiss itself). Two marks cost one
    // number and make each behaviour say what it means.
    scopesFetchedAt: 0,
    // An index refresh saw a write NEWER than that read. Rendered as an
    // offer to reload, never as an automatic replacement — see
    // renderStaleNotice for why the document is not swapped underneath a
    // reader.
    staleWrite: false,
    refreshing: false,
    // How long the last index refresh took, in ms. Feeds nextPollDelay.
    lastRefreshMs: 0,
    // WHETHER THE AGE CLOCK IS RUNNING, so the reading can say "updates live"
    // only when it genuinely does. onEnter sets it after arming the interval;
    // an engine with no setInterval (or a test rig that injects none) leaves it
    // false and the provenance simply omits the clause. A reading that claims
    // to be live and is frozen is worse than a reading that never claimed it.
    ageTickerArmed: false,
  };
}

let state = freshState();

/**
 * The control that should hold focus after the next render, by id.
 *
 * setMain/setSidebar replace innerHTML, so the focused node does not survive
 * a re-render and focus drops to <body> — the next Tab then restarts from the
 * rail. Restored BY ID rather than by node, the same way views/onboarding.js
 * does it (v3.8.0), because the node itself is gone.
 *
 * It persists across renders on purpose. A scope or machine change renders
 * TWICE — once into the loading state, once with the result — and the machine
 * picker is absent from the first of those (state.detail is dropped before
 * the fetch, deliberately, so the old machine list cannot be shown under the
 * new scope). Clearing on the first miss would strand focus exactly in the
 * case this exists for.
 *
 * It is bounded so a stale id can never steal focus later: only an id in
 * FOCUSABLE_IDS is ever captured, and a miss is given up on as soon as no
 * further render is coming (detailLoading false).
 */
let pendingFocusId = null;

const FOCUSABLE_IDS = [
  'mem-journal-more',
  // THE WORK-STREAM TABLE'S SELECTED ROW. Only one row carries an id — the one
  // that is open — because ids must be unique and a scope slug is not a safe
  // id fragment. Clicking a row therefore records this id EXPLICITLY in wire()
  // rather than through captureFocus: at the moment of the click the pressed
  // button has no id at all, and a moment later it is the selected row.
  'mem-ws-active',
  'mem-fold-handoff', 'mem-fold-journal',
  // BOTH ⓘ MARKS. They are real <button>s emitted by renderViewHeader, and a
  // render replaces the pane they sit in — so without these two entries a
  // keyboard user reading either panel is dropped to <body> on the next poll.
  // The ids are the component's own derivation from the title (and, for the
  // rail, from the variant): see renderViewHeader's panelId block.
  'tx-vh-info-agent-memory-btn', 'tx-vh-info-agent-memory-sidebar-btn',
  // Both revalidation controls. `mem-reload` is the one that matters: it
  // REMOVES itself on success (the notice it lives in is gone once the
  // reload lands), so it needs the same fallback treatment as "Show more".
  'mem-refresh', 'mem-reload',
  // The brief editor. `mem-brief-edit` REMOVES itself when clicked (it is
  // replaced by the textarea), so it needs the same fallback treatment as
  // "Show more" below; the textarea is where the user actually is.
  'mem-brief-edit', 'mem-brief-text', 'mem-brief-save', 'mem-brief-cancel',
  // Preview swaps the textarea for rendered markdown and back, so whichever of
  // the two is on screen the toggle itself stays put — it is the one control
  // in the editor that survives its own click, and it must not lose focus on
  // the render it causes.
  'mem-brief-preview',
  // The unsaved-draft bar. Both REMOVE themselves — Discard closes the editor,
  // Keep editing dismisses the bar — so both fall back below.
  'mem-brief-discard', 'mem-brief-keep',
];

// Where focus goes when the exact control did not come back. "Show more" is
// the case that matters: expanding the journal REMOVES the button (there is
// no more to show), so restoring by id alone would drop focus every time it
// worked. The journal's own summary is the nearest stable thing the user was
// just inside.
const FOCUS_FALLBACK = {
  'mem-journal-more': '#mem-fold-journal',
  // Reloading dismisses the notice this button lives in. The sidebar's
  // Refresh is the nearest stable control that does the same KIND of thing.
  'mem-reload': '#mem-refresh',
  // Clicking Edit replaces the button with the editor, so restoring "by id"
  // would drop focus every time it worked. The textarea is what the user
  // asked for.
  'mem-brief-edit': '#mem-brief-text',
  // Save and Cancel both dismiss the editor. The Edit button is the nearest
  // stable control that does the same KIND of thing.
  'mem-brief-save': '#mem-brief-edit',
  'mem-brief-cancel': '#mem-brief-edit',
  // Discard closes the editor, so the pencil that reopens it is the nearest
  // stable control; Keep editing dismisses only the bar, so the field the user
  // asked to stay in is where they should land.
  'mem-brief-discard': '#mem-brief-edit',
  'mem-brief-keep': '#mem-brief-text',
};

// Same mount-token discipline as chat.js / domains.js / sync.js: captured as
// a local BEFORE the first await in every async function and threaded
// through, never re-derived afterwards. A boolean cannot distinguish "still
// mounted" from "REmounted", which is the case that actually bites.
let myMountToken = 0;
let loadGate = null;
let pollTimer = null;
// The 1-second age clock (see AGE_TICK_MS). Held here, beside pollTimer, so
// the teardown that disarms one is the obvious place to disarm the other.
let ageTimer = null;
let wakeHandler = null;
// The signature of what render() last painted. Compared against a freshly
// computed one so a revalidation that changed nothing costs no render at
// all — see screenSignature.
let renderedSignature = null;

registerView('memory', {
  onEnter(mountToken) {
    state = freshState();
    myMountToken = mountToken;
    // THE AGE CLOCK. Armed here — BEFORE the first paint, so the very first
    // reading may already say "updates live" — cleared in the teardown below,
    // and armed nowhere else: one arm site and one disarm site is the only
    // shape a reader can check at a glance. `state.ageTickerArmed` is written
    // only after the interval really exists, because that flag is what lets
    // the provenance line make the claim.
    if (typeof setInterval === 'function') {
      ageTimer = setInterval(tickAges, AGE_TICK_MS);
      state.ageTickerArmed = true;
    }
    loadGate = createLoadingGate({
      onChange: () => { if (isCurrentMount(mountToken)) render(mountToken); },
    });
    loadGate.begin();
    render(mountToken);
    loadIndex(mountToken).catch((err) => reportAsyncMountFailure(mountToken, err));

    // REVALIDATE ON WAKE. `focus` covers alt-tabbing back from the terminal
    // or from Claude Desktop; `visibilitychange` covers a background tab
    // being brought forward, which fires no focus event. Both are cheap
    // because they cost nothing while the user is elsewhere — which is
    // exactly when an agent is writing.
    //
    // The mount token is captured, not read from `myMountToken`: a later
    // mount overwrites that module-level variable, and a listener that
    // outlived its teardown would then pass the WRONG view's token and be
    // waved through by isCurrentMount. The teardown below removes these, so
    // that cannot happen — capturing makes it not depend on remembering to.
    wakeHandler = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (!isCurrentMount(mountToken)) return;
      refreshIndex(mountToken).catch((err) => reportAsyncMountFailure(mountToken, err));
    };
    if (typeof window !== 'undefined') window.addEventListener('focus', wakeHandler);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', wakeHandler);
    schedulePoll(mountToken);

    return () => {
      // Timer hygiene: an armed delay timer surviving teardown would paint a
      // loader into whatever view mounts next. The poll timer is worse than
      // that — it would keep FETCHING for a view nobody is looking at, for
      // the life of the page.
      if (loadGate) { loadGate.cancel(); loadGate = null; }
      stopPoll();
      // The age clock is a timer like any other: left armed it would go on
      // walking a DOM that belongs to whatever view mounted next, once a
      // second, for the life of the page.
      if (ageTimer !== null) { clearInterval(ageTimer); ageTimer = null; }
      // NO POPOVER TO CLOSE ANY MORE. This used to call `closeAllListboxes()`
      // because navigate() explicitly does not reach into view-owned popovers,
      // so a scope or machine menu left open on a rail click was this view's to
      // shut. Both pickers are gone (see the note where `pendingListboxes` was
      // declared) and the work-stream table opens nothing, so there is no menu
      // that can outlive a teardown. Deleted rather than left standing: a
      // teardown step with nothing to tear down is a claim about the screen
      // that is no longer true.
      if (wakeHandler) {
        if (typeof window !== 'undefined') window.removeEventListener('focus', wakeHandler);
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', wakeHandler);
        wakeHandler = null;
      }
    };
  },
});

// ── Polling ──────────────────────────────────────────────────────────────

/**
 * How long to wait before the next index refresh.
 *
 * Derived from the measured cost of the LAST one rather than fixed, so this
 * cannot become a busy poll on an install far larger than the one it was
 * tuned against. See the Revalidation block for why that install exists.
 */
function nextPollDelay() {
  const measured = state.lastRefreshMs * POLL_DUTY;
  return Math.min(POLL_MAX_MS, Math.max(POLL_BASE_MS, measured));
}

function stopPoll() {
  if (pollTimer !== null) { clearTimeout(pollTimer); pollTimer = null; }
}

/**
 * A setTimeout CHAIN, re-armed only after the previous refresh has settled.
 * setInterval would queue a second fetch on top of a slow first one; this
 * structurally cannot.
 *
 * A hidden tab reschedules WITHOUT fetching: nobody is looking, and the
 * wake handler refreshes the moment they are.
 */
function schedulePoll(token) {
  stopPoll();
  pollTimer = setTimeout(() => {
    pollTimer = null;
    if (!isCurrentMount(token)) return;
    const hidden = typeof document !== 'undefined' && document.hidden;
    if (hidden) { schedulePoll(token); return; }
    refreshIndex(token)
      .catch((err) => reportAsyncMountFailure(token, err))
      .finally(() => { if (isCurrentMount(token)) schedulePoll(token); });
  }, nextPollDelay());
}

/**
 * THE AGE CLOCK — one second, `textContent`, and NOTHING else.
 *
 * ── WHY IT EXISTS ───────────────────────────────────────────────────────
 * The menubar widget carries two readings a non-Mac user has never had: a
 * freshness colour and an age that MOVES. "Saved 3 min ago" that sat frozen
 * for twenty minutes is the same class of defect as the mtime reading
 * effectiveSave exists to fix — a figure that has quietly stopped being true.
 * The pane's own repaint is governed by screenSignature, which is folded
 * through formatAge and therefore fires when the WORD changes… but only when
 * a poll happens to come round, up to POLL_MAX_MS later. This closes that gap.
 *
 * ── WHAT IT MUST NOT DO ─────────────────────────────────────────────────
 * It must not call render(). A render replaces both panes by innerHTML: it
 * closes the ⓘ panel, drops the caret out of the brief editor, shuts any
 * listbox that is open and churns focus. settings.js shipped a once-a-second
 * render tick and v3.53.1 records it as a defect by name. So this walks the
 * elements the last paint left behind and writes text into them, exactly as
 * views/ingest.js's elapsed-clock does.
 *
 * ── AND WHAT IT DELIBERATELY DOES NOT TOUCH ─────────────────────────────
 * The PIP. Its class is cut on formatAge's own unit bands (freshnessStep), so
 * the instant the word changes band is the instant screenSignature changes and
 * the pane repaints with the right mark. Re-deriving the class here would be a
 * second implementation of that rule, free to disagree with the first.
 *
 * ── THE TARGETS, PLURAL SINCE v3.55.0 ───────────────────────────────────
 * `data-mem-age-at` carries the ISO stamp that effectiveSave resolved, and it
 * sits on the WRAPPER this view owns. Inside it the clock looks for exactly
 * two named elements, in this order:
 *
 *   · `.tx-readout-value` — the handoff summary and the save strip, where the
 *     words live inside a shared/text.js readout. That component HTML-ESCAPES
 *     its `value`, so a view cannot place an element of its own around the
 *     figure and has to reach the component's own class instead. If it is ever
 *     renamed the clock FREEZES rather than overwriting the label beside it,
 *     and a frozen reading is at most one poll stale because the signature
 *     still moves. That is the fail-safe direction, and it is a trade-off.
 *   · `.mem-age-words` — the work-stream table's age cell and the "Working on"
 *     line, which are a cell and a sentence rather than instruments and carry
 *     a plain span this view owns.
 *
 * It never writes the WRAPPER's own text: the table's age cell also holds a
 * visually-hidden exact stamp, and an unnamed fallback is how a future edit
 * would start silently deleting it.
 */
function tickAges() {
  if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
  const now = Date.now();
  const nodes = document.querySelectorAll('[data-mem-age-at]');
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i];
    const at = el.getAttribute('data-mem-age-at');
    const t = at ? Date.parse(at) : NaN;
    if (!Number.isFinite(t)) continue;
    const words = formatAge(Math.max(0, Math.round((now - t) / 1000)));
    if (words === null) continue;
    // TWO SHAPES CARRY AN AGE ON THIS SCREEN, and the clock has to reach both.
    // A readout (`renderReadout`) escapes its own value, so the words are
    // inside the component's `.tx-readout-value` and a view cannot put an
    // element of its own around them — that is the handoff summary and the
    // save strip. The work-stream table and the "Working on" line are not
    // instruments, they are cells and a sentence, so they carry a plain
    // `.mem-age-words` span this view owns outright.
    //
    // NAMED TARGETS BOTH WAYS, never `el.textContent`: writing the wrapper's
    // own text would delete whatever else it holds (the table's age cell also
    // carries a visually-hidden exact stamp), and an unnamed fallback is how a
    // future edit would silently start clobbering a sibling.
    const target = el.querySelector('.tx-readout-value') || el.querySelector('.mem-age-words');
    // Written only when it CHANGED. A no-op assignment still dirties the node
    // for the browser and, on a screen reader watching a live region, still
    // reads. Most of the 60 ticks in a minute have nothing to say.
    if (target && target.textContent !== words) target.textContent = words;
  }
}

// ── Identity ─────────────────────────────────────────────────────────────
//
// A project is identified by (domain, project). Both are needed, because two
// domains may each hold a project called `main` — which is not a corner case
// but the expected shape once a user has more than one domain.
//
// `keyOf` exists ONLY for comparison. Every request builds its URL from the
// two fields separately (see fetchState), so nothing ever has to split this
// string back apart, and a project slug containing the separator cannot
// forge another project's identity in a way that matters. It is still built
// with a character `isSafeSegment` forbids, so two different pairs can never
// produce one key.

function keyOf(domain, project) {
  return String(domain) + '/' + String(project);
}

function activeKey() {
  return keyOf(state.activeDomain, state.activeProject);
}

// ── Remembering the last project per domain ──────────────────────────────
//
// One localStorage key holding a { domain: project } map. Every access is
// wrapped: localStorage THROWS on access (not merely returns null) in a
// Safari private window and under a "block site data" setting, and this is a
// convenience, so the failure mode has to be "the app forgets", never "the
// app breaks". The value is validated on read as well as write — it is
// per-browser state a user can edit, and a bad shape must degrade to no
// memory rather than to a crash in initialPick.

const LAST_PROJECT_KEY = 'curator-memory-last-project-v1';

export function readRememberedProjects() {
  try {
    const raw = localStorage.getItem(LAST_PROJECT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof k === 'string' && typeof v === 'string' && k && v) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function rememberProject(domain, project) {
  if (!domain || !project) return;
  try {
    const map = readRememberedProjects();
    map[domain] = project;
    localStorage.setItem(LAST_PROJECT_KEY, JSON.stringify(map));
  } catch {
    /* private window, blocked site data, quota — the app simply forgets */
  }
}

// ── Load ─────────────────────────────────────────────────────────────────

/**
 * The index request, and NOTHING else.
 *
 * Split out of loadIndex so the initial load and every later revalidation
 * issue the same request against the same parsing, rather than two
 * hand-maintained copies of one fetch that can drift about what an error
 * looks like. Never throws; returns {projects, error}.
 */
async function fetchIndex(token) {
  try {
    const res = await fetch('/api/memory');
    const data = await res.json();
    if (!isCurrentMount(token)) return null;
    if (!res.ok || !data.ok) {
      return { projects: [], domainsScanned: null, error: data.error || ('HTTP ' + res.status) };
    }
    return {
      projects: data.projects || [],
      // A NUMBER OR NULL, never 0 by default: 0 domains and "the server did
      // not say" are different facts, and the empty state says something
      // different for each.
      domainsScanned: Number.isInteger(data.domainsScanned) ? data.domainsScanned : null,
      error: null,
    };
  } catch (err) {
    if (!isCurrentMount(token)) return null;
    return { projects: [], domainsScanned: null, error: err.message };
  }
}

/**
 * WHAT THE SCREEN CURRENTLY SAYS, as a comparable string.
 *
 * A poll that re-renders unconditionally is worse than no poll: every render
 * replaces the whole main pane, so it would close a picker the user
 * had OPEN at that moment, and churn focus on a screen nobody asked to
 * change. In the steady state — which is almost always — nothing has moved
 * and the correct amount of work is none.
 *
 * The signature is built from the RENDERED text, not the raw fields, which
 * is what makes it exact: `projectMetaLine` already folds `ageSeconds`
 * through `formatAge`, so a row whose age ticked from 59s to 61s changes the
 * signature (it now reads "1 min ago") while one that merely aged from 300s
 * to 320s does not. Re-render iff the pixels would differ.
 */
function screenSignature() {
  // ── THE WORK-STREAM TABLE IS A PANE, AND IT PAINTS EVERY PAIR ───────────
  //
  // This used to fold in a DEDUPLICATED list of scope NAMES, because the pane
  // it was guarding was a dropdown: two copies of `main` were one option, so
  // reporting a duplicate as a change would have closed a picker somebody had
  // open for no visible difference. That was the over-firing side of the
  // guard and the reasoning was right for a picker.
  //
  // IT IS NOW EXACTLY WRONG FOR A TABLE. `main` on two machines is TWO ROWS,
  // each with its own age, headline and harness, and each one of those is a
  // thing on screen that can change on its own. So the mark is the rendered
  // content of the rows, in order, and a duplicated pair genuinely moves it —
  // the inverted assertions in scripts/test-memory-truth.js §8b and
  // scripts/test-next-memory-view.js §11b record that this reversal is
  // deliberate rather than a regression.
  //
  // Folded through `formatAge` for the same reason everything else here is:
  // the signature must change exactly when the PIXELS would. A raw age in
  // seconds would re-render on every single poll; a raw timestamp would never
  // change and the table's clock would freeze between bands.
  //
  // OMITTING THIS ENTIRELY WAS HALF OF THE ORIGINAL BUG, and that half still
  // stands: once refreshIndex re-reads the scope list, a newly written
  // work-stream changes nothing else the signature looks at in the general
  // case — the sidebar row is identical when a save adds a MACHINE under an
  // existing scope, and staleWrite is already true from an earlier poll — so
  // the render would be skipped as a no-op and the fresh data would sit in
  // state, unpainted. A no-op guard that cannot see a pane is not a guard for
  // that pane.
  //
  // THE ORDER IS PART OF THE PAINT, so it is taken through the same
  // `workStreamOrder` the table renders through rather than off the response.
  // Two rows swapping places is a change on screen with no cell of its own,
  // and it is reachable without any cell moving at all: two saves in the same
  // band ("2 hr ago" both) that cross each other in the agent's clock repaint
  // the table and would otherwise move nothing here — the pane would keep the
  // stale ORDER while every word in it stayed correct. Reading the projection
  // off `pr.scopes` directly would also mean the signature described a
  // different arrangement than the one on screen, which is the shape of bug
  // this whole function exists to avoid.
  const pr = state.projectRead;
  const tableRows = pr && Array.isArray(pr.scopes)
    ? workStreamOrder(pr.scopes).map((s) => [
      s && s.scope, (s && s.machine) || null, (s && s.headline) || null,
      formatAge(effectiveSave(s).seconds),
      (s && s.harness) || null, (s && s.model) || null,
    ])
    : null;
  // ── THE SAVE-STATUS STRIP IS A CLOCK, AND A CLOCK HAS TO TICK ──────────
  //
  // The same lesson as `pickerScopes` directly above, one pane over: a no-op
  // guard that cannot see a pane is not a guard for that pane. The strip reads
  // from `state.detail` and from every row of `state.projectRead.scopes`, and
  // NOTHING the signature looked at could see either — so a save into a
  // different scope of the same project, or the reading simply ageing from
  // "59 min ago" into "1 hr ago", would leave the strip painting a figure that
  // had stopped being true.
  //
  // Folded through `formatAge` for the same reason `projectMetaLine` is: the
  // signature has to change exactly when the PIXELS would. A raw timestamp
  // would never change on its own (so the age would freeze), and a raw age in
  // seconds would change every single tick (so every poll would re-render,
  // closing an open picker and churning focus on a screen nobody touched).
  // The rendered word changes when — and only when — the freshness step does,
  // because both are cut on formatAge's own unit bands.
  const cur = state.detail && state.detail.current && state.detail.current.present
    ? state.detail.current : null;
  const savedMark = cur
    ? [formatAge(effectiveSave(cur).seconds), effectiveSave(cur).source, cur.lastSaveKind || null]
    : null;
  // The strip reads two things out of `scopes` that `tableRows` above does not
  // carry: which pair is newest (for the "newer state in this project" line)
  // and which pairs two harnesses are sharing. Kept separate rather than
  // merged into the row mark, because both are DERIVED readings — a change in
  // which row is newest can move the strip without any row's own cell moving.
  const newest = pr && Array.isArray(pr.scopes) ? newestPair(pr.scopes) : null;
  const newestMark = newest
    ? [newest.scope, newest.machine || null, formatAge(effectiveSave(newest).seconds)] : null;
  const sharedMark = pr && Array.isArray(pr.scopes)
    ? pr.scopes.filter((s) => s && s.harnessShared === true)
      .map((s) => [s.scope, (s.harnesses || []).join('|')])
    : null;
  const briefMark = pr && pr.brief && pr.brief.present
    ? formatAge(effectiveSave({ savedAt: pr.brief.updatedAt }).seconds) : null;

  // THE EDITOR IS A PANE TOO, and the same rule applies to it as to the
  // picker and the save strip: a no-op guard that cannot see a pane is not a
  // guard for that pane. Only the fields that CHANGE PIXELS are folded in —
  // notably NOT the draft text, which changes on every keystroke and is
  // written straight into state without a re-render (see wire()), exactly as
  // the Domains lifecycle form does, so that the caret survives.
  const editMark = state.briefEdit
    ? [state.briefEdit.domain, state.briefEdit.project, !!state.briefEdit.busy, state.briefEdit.error || null,
      // Preview and the unsaved-draft bar BOTH change what is on screen and
      // neither is derivable from the draft text, which is deliberately not
      // folded in here (it moves on every keystroke and is written into state
      // without a render, so that the caret survives).
      !!state.briefEdit.preview, !!state.briefEdit.confirmDiscard]
    : null;

  return JSON.stringify([
    state.activeDomain,
    state.activeProject,
    state.staleWrite,
    state.indexError,
    state.scope,
    state.machine,
    tableRows,
    savedMark,
    newestMark,
    sharedMark,
    briefMark,
    editMark,
    // The DOMAIN rides in each row, because the rail groups by it: two
    // projects with the same name in two domains are two different rows, and
    // a signature that could not tell them apart would skip the render that
    // moves the selection between them.
    // `headline` joined the row when the rail gained its "Working on" line;
    // the freshness DOT deliberately did not, because `freshnessTier` is cut
    // on `formatAge`'s own bands and `projectMetaLine` already folds the age
    // through `formatAge` — the dot cannot change without those words changing
    // first. Folding it in as well would be a second copy of one fact.
    state.projects.map((p) => [p.domain, p.project, p.hasBrief, p.scopeCount > 0,
      p.headline || null, projectMetaLine(p)]),
  ]);
}

/**
 * Re-ask the index and reconcile the screen with it.
 *
 * Deliberately narrow: it updates the project LIST and the stale flag, and
 * touches neither the selection nor the loaded handoff. A revalidation that
 * moved the user's selection, or swapped the document they were reading,
 * would be a worse bug than the staleness it fixes.
 */
async function refreshIndex(token) {
  if (state.refreshing || state.loading) return;
  state.refreshing = true;
  const startedAt = Date.now();
  try {
    const got = await fetchIndex(token);
    if (!isCurrentMount(token) || !got) return;
    state.lastRefreshMs = Date.now() - startedAt;

    // A failed revalidation must NOT blank a list that is on screen and
    // still broadly true. Report nothing, keep what we have, try again next
    // tick — the opposite of the initial load, where an error IS the answer.
    if (got.error) return;

    state.projects = got.projects;
    state.domainsScanned = got.domainsScanned;
    state.indexError = null;

    // Has anything been written since the read that produced what is on
    // screen? Compared against the read's START time — see detailFetchedAt.
    const row = state.projects.find((p) => p.domain === state.activeDomain
      && p.project === state.activeProject);
    const wroteAt = row && row.lastWriteAt ? Date.parse(row.lastWriteAt) : NaN;
    state.staleWrite = Number.isFinite(wroteAt) &&
      state.detailFetchedAt > 0 && wroteAt > state.detailFetchedAt;

    // THE SIDEBAR IS NOT THE ONLY PANE THIS SCREEN HAS.
    //
    // Reproduced, view open on a project with two scopes, a third written
    // over MCP: the sidebar row moved to `3 scopes` and the scope picker
    // beside it still listed TWO, until the user navigated away and back.
    // Not a counting bug and not a no-op-guard misclassification — the
    // picker renders from state.projectRead, which ONLY selectProject and
    // reloadActive ever set, so no revalidation path re-asked for it. The
    // index refresh above cannot supply it: GET /api/memory carries
    // `newestScope`, never the list.
    //
    // Gated on the mark for the LIST, not the document, so this costs one
    // extra request only when the index — which is being fetched anyway —
    // has already proved something was written since the list was read. In
    // the steady state, which is nearly always, it costs nothing. That
    // matters here: the index route stats every (scope, machine) pair
    // across up to 200 domains, which is why the poll is adaptive at all.
    if (Number.isFinite(wroteAt) && state.activeProject &&
        state.scopesFetchedAt > 0 && wroteAt > state.scopesFetchedAt) {
      await refreshScopeList(token, state.activeDomain, state.activeProject);
    }

    const before = renderedSignature;
    if (screenSignature() !== before) render(token);
  } finally {
    state.refreshing = false;
  }
}

/**
 * Bring the SCOPE PICKER up to date, and nothing else.
 *
 * Narrower than reloadActive by design. It replaces the list of what exists
 * and leaves the selection, the loaded handoff, the open folds and the
 * scroll position exactly where they are — so the v3.17.3 rule that a
 * document is never swapped under a reader is not merely respected, it is
 * unreachable from here: nothing in this function can write state.detail.
 *
 * After it runs the Reload notice reads MORE truthfully than before, not
 * less: the picker is now current, so "what is below may not be the latest"
 * is a claim about the document alone, which is exactly what it says.
 *
 * Two cases where the fresh list is deliberately NOT adopted:
 *
 *   · NOTHING SELECTED. An empty project that has just received its first
 *     save would otherwise gain a picker while state.detail is still null,
 *     painting a scope name over a document that was never read. The Reload
 *     offer already covers that case correctly, and one healing path is
 *     better than two that must agree.
 *
 *     STATED RATHER THAN OVER-CLAIMED: this check is DEFENCE IN DEPTH and is
 *     not independently load-bearing today. Deleting it leaves the suite
 *     green, because the membership check below already returns for a falsy
 *     state.scope — no real scope list contains null, and slugSegment cannot
 *     mint an empty scope name. It is kept because it says what is meant, and
 *     because it is what still holds if the membership check is ever loosened
 *     (a mutation removing THAT one goes red). Measured, not assumed.
 *   · THE SELECTED SCOPE IS GONE. A save can only add, so this needs a
 *     directory removed out of band — but adopting then would leave the
 *     picker unable to show state.scope, and it would silently
 *     display some other scope's name over this scope's handoff. Keeping the
 *     old list leaves the two consistent, and Reload (which re-picks
 *     deliberately) is the right way out.
 *
 * Never throws, and a failed read changes nothing: keep what is on screen
 * and try again on the next tick, the same rule refreshIndex follows.
 */
async function refreshScopeList(token, domain, project) {
  const startedAt = Date.now();
  const key = keyOf(domain, project);
  const read = await fetchState(domain, project, {}, token);
  if (!isCurrentMount(token) || activeKey() !== key) return;
  if (!read.data) return;
  if (!state.scope) return;
  const names = (read.data.scopes || []).map((s) => s.scope);
  if (!names.includes(state.scope)) return;
  state.projectRead = read.data;
  state.scopesFetchedAt = startedAt;
}

/**
 * Re-read the ACTIVE project, keeping the user where they are.
 *
 * Two requests, and only ever on an explicit click. It refreshes the scope
 * list (so a scope written since arrival appears in the picker — otherwise
 * reloading the document would leave the picker still claiming the old set)
 * and then re-reads the scope the user was actually looking at, rather than
 * snapping back to the newest one the way selectProject does.
 */
async function reloadActive(token) {
  const domain = state.activeDomain;
  const project = state.activeProject;
  if (!project) return;
  const key = keyOf(domain, project);
  const wantScope = state.scope;
  // ONLY a machine the user DELIBERATELY picked, which is what a non-null
  // `state.machine` means: the machine picker's handler is the one place that
  // writes it, and every other path into loadScope passes null on purpose.
  //
  // THIS USED TO READ `state.detail ? state.detail.machine : state.machine`,
  // and that one expression is the reported bug. On arrival selectProject
  // calls loadScope(scope, null), so the STORE resolves the most recently
  // written machine into `state.detail.machine`; reading it back here turned
  // that resolution into a pin the user never asked for, permanently, from
  // the first successful load. When a later save landed in a DIFFERENT
  // machine folder — which a hostname flap produces, see working-state.js
  // D10 — Reload re-read the older folder, withdrew the stale notice and
  // changed nothing on screen. Refresh shares this call and was equally
  // inert. Observed as a view four hours out of date beside a save twelve
  // minutes old.
  //
  // The v3.17.3 rule is not weakened, it is honoured more exactly: a
  // document is never swapped under a reader BY THE POLL, and a machine the
  // reader actually chose is still never taken away. What moves is only the
  // case where nobody chose anything and the user has just clicked the
  // control whose entire meaning is "show me the current one".
  //
  // NOT the same as the journal's "show more", which passes
  // `state.detail.machine` DELIBERATELY: that is pagination over the
  // document in front of you, so re-resolving there really would swap whose
  // history you are part-way through reading. Two call sites, two meanings —
  // do not unify them.
  const wantMachine = state.machine;

  state.detailFetchedAt = Date.now();
  // Both reads below start now, so both marks move together here.
  state.scopesFetchedAt = state.detailFetchedAt;
  state.staleWrite = false;
  state.detailLoading = true;
  render(token);

  const read = await fetchState(domain, project, {}, token);
  if (!isCurrentMount(token) || activeKey() !== key) return;
  state.projectRead = read.data;
  state.detailError = read.error;

  const scopes = (read.data && read.data.scopes) || [];
  if (!scopes.length) {
    state.detail = null;
    state.scope = null;
    state.machine = null;
    state.detailLoading = false;
    render(token);
    return;
  }
  // Keep the user's scope if it still exists; otherwise fall back to the
  // freshest, which is what selectProject would have chosen anyway.
  const keep = scopes.some((s) => s.scope === wantScope) ? wantScope : scopes[0].scope;
  await loadScope(keep, keep === wantScope ? wantMachine : null, token);
}

/**
 * Save the standing brief. THE ONLY WRITE THIS VIEW MAKES.
 *
 * PATCH, not POST or PUT: it changes one field of an existing project, and
 * the route takes `{rename?, brief?}` on the same endpoint the Domains view
 * renames through. Nothing here can reach a work-stream handoff or a
 * journal — see the header block.
 *
 * FOUR PROPERTIES, each of which had to be deliberate:
 *
 *   · STAMPED. The edit carries the (domain, project) it was opened on, and
 *     a reply that lands after the user has moved on is dropped. Without
 *     that, a slow save landing after a project switch would report success
 *     over — and re-read — a project the user is no longer looking at.
 *   · ONE AT A TIME. `busy` disables both buttons and the textarea. A second
 *     click during a save is a second full-document write, and the last one
 *     to arrive wins, which is not what the person clicking twice means.
 *   · REPLACE, NOT MERGE, and the copy says so. The store's brief write is a
 *     whole-document replace (idempotent, like a scope save), so a partial
 *     brief silently drops what it omits.
 *   · A FAILURE KEEPS THE DRAFT. `state.briefEdit` is not cleared on error —
 *     the text the user typed stays in the box with the reason above it.
 *     Clearing it would destroy the only copy.
 */
async function saveBrief(token) {
  const e = state.briefEdit;
  if (!e || e.busy) return;
  const key = keyOf(e.domain, e.project);
  e.busy = true;
  e.error = null;
  render(token);

  let ok = false;
  let error = null;
  try {
    const res = await fetch(
      '/api/memory/' + encodeURIComponent(e.domain) + '/projects/' + encodeURIComponent(e.project),
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brief: e.text }),
      }
    );
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON error page */ }
    ok = res.ok && !!(data && data.ok);
    if (!ok) error = (data && (data.error || data.message)) || ('HTTP ' + res.status);
  } catch (err) {
    error = err.message;
  }

  if (!isCurrentMount(token)) return;
  // The reply belongs to the project it was sent for, not to whatever is on
  // screen now.
  if (!state.briefEdit || keyOf(state.briefEdit.domain, state.briefEdit.project) !== key) return;

  state.briefEdit.busy = false;
  if (!ok) {
    state.briefEdit.error = error;
    render(token);
    return;
  }
  // Saved: drop the editor and re-read, so the rendered brief, its age and
  // the sidebar row all come from the server rather than from the draft.
  state.briefEdit = null;
  if (activeKey() === key) {
    await reloadActive(token);
    refreshIndex(token).catch((err) => reportAsyncMountFailure(token, err));
  } else {
    render(token);
  }
}

async function loadIndex(token) {
  const gate = loadGate;                 // capture: the next mount replaces it
  const got = await fetchIndex(token);
  if (!isCurrentMount(token)) return;
  if (got) {
    state.projects = got.projects;
    state.domainsScanned = got.domainsScanned;
    state.indexError = got.error;
  }

  const pick = initialPick(state.projects, readRememberedProjects());

  settleGate(gate, () => {
    state.loading = false;
    render(token);
  });

  if (pick) await selectProject(pick.domain, pick.project, token);
}

/**
 * Which project to open on arrival.
 *
 * TWO STEPS, and the order is the point.
 *
 *   1. THE DOMAIN IS CHOSEN BY RECENCY — the domain holding the freshest
 *      save, which is nearly always the one the user just came from. Not by
 *      list order, which is alphabetical and would open on whatever happens
 *      to sort first.
 *   2. THE PROJECT WITHIN IT IS CHOSEN BY MEMORY — the last project the user
 *      looked at in that domain, if it still exists. Only when there is no
 *      remembered one does recency decide again.
 *
 * That second step is what "remembers the last project per domain" means,
 * and it is deliberately not global: remembering ONE project across all
 * domains would send a user who just saved in `articles` to a project in
 * `clients` because that is where they were yesterday. The domain question
 * has a fresh, factual answer every time; the project question does not.
 *
 * A project with nothing saved is still selectable — "nothing saved yet" is
 * a real answer worth being able to ask for — so the final fallback is the
 * first row rather than nothing.
 *
 * Pure, and exported through __testing: it is the only part of the arrival
 * path that makes a decision, and the rest of loadIndex is I/O.
 */
export function initialPick(projects, remembered) {
  const rows = Array.isArray(projects) ? projects.filter(Boolean) : [];
  if (!rows.length) return null;
  const byRecency = rows.filter((p) => p.lastWriteAt)
    .slice()
    .sort((a, b) => String(b.lastWriteAt).localeCompare(String(a.lastWriteAt)));
  const freshest = byRecency.length ? byRecency[0] : rows[0];
  const domain = freshest.domain;
  const want = remembered && typeof remembered === 'object' ? remembered[domain] : null;
  if (want) {
    const hit = rows.find((p) => p.domain === domain && p.project === want);
    if (hit) return hit;
  }
  return freshest;
}

async function selectProject(domain, project, token, opts = {}) {
  const key = keyOf(domain, project);
  state.activeDomain = domain;
  state.activeProject = project;
  // A pending edit belongs to the project it was opened on. Switching
  // project abandons it — silently, because there is nothing to save: the
  // draft was never sent, and carrying it onto another project's brief is
  // the one outcome that could destroy something.
  state.briefEdit = null;
  // Same rule, same reason: a copy confirmation is about the project it was
  // pressed on. The stamp on `state.copied` would already stop it rendering
  // here, but leaving it set would make it reappear the moment the user came
  // back — an acknowledgement that outlives the click.
  state.copied = null;
  rememberProject(domain, project);
  state.projectRead = null;
  state.detail = null;
  state.detailError = null;
  state.scope = null;
  state.machine = null;
  state.journalLimit = JOURNAL_PAGE;
  state.detailLoading = true;
  // The START of the read that is about to produce what goes on screen.
  // Conservative on purpose: a write landing mid-fetch is reported as
  // stale, which costs one reload the user did not strictly need, rather
  // than leaving a stale document presenting itself as current.
  state.detailFetchedAt = Date.now();
  // The unscoped read below produces the scope list as well as the handoff,
  // so the picker's mark starts here too. Set before the await, like its
  // sibling, so a write landing mid-fetch is reported rather than missed.
  state.scopesFetchedAt = state.detailFetchedAt;
  state.staleWrite = false;
  render(token);

  // A user-initiated selection is the cheapest honest moment to re-ask the
  // index: the detail fetch below is happening anyway, so the two land
  // together and the sidebar row cannot contradict the picker it sits next
  // to. NOT done for the initial pick, which loadIndex just fetched.
  if (opts.revalidateIndex) {
    refreshIndex(token).catch((err) => reportAsyncMountFailure(token, err));
  }

  const read = await fetchState(domain, project, {}, token);
  if (!isCurrentMount(token) || activeKey() !== key) return;
  state.projectRead = read.data;
  state.detailError = read.error;

  const scopes = (read.data && read.data.scopes) || [];
  if (!scopes.length) {
    state.detailLoading = false;
    render(token);
    return;
  }
  // Newest-first from the store, so [0] is the freshest handoff — which is
  // exactly what the route resolves `scope=latest` to. The name is taken
  // from the list we already have rather than costing a second request for
  // the server to tell us the same thing.
  await loadScope(scopes[0].scope, null, token);
}

async function loadScope(scope, machine, token) {
  const domain = state.activeDomain;
  const project = state.activeProject;
  const key = keyOf(domain, project);
  state.scope = scope;
  state.machine = machine;
  // Drop the previous scope's read before painting: keeping it would render
  // the OLD machine list and the OLD handoff under the NEW scope's label for
  // the duration of the fetch, which is a wrong answer stated confidently.
  state.detail = null;
  state.detailLoading = true;
  render(token);

  const q = { scope };
  if (machine) q.machine = machine;
  if (state.journalLimit !== JOURNAL_PAGE) q.journalLimit = String(state.journalLimit);

  const read = await fetchState(domain, project, q, token);
  if (!isCurrentMount(token) || activeKey() !== key || state.scope !== scope) return;
  state.detail = read.data;
  state.detailError = read.error;
  state.detailLoading = false;
  render(token);
}

/** One fetch shape for both reads. Never throws; returns {data, error}. */
async function fetchState(domain, project, query, token) {
  const qs = new URLSearchParams(query).toString();
  try {
    const res = await fetch('/api/memory/' + encodeURIComponent(domain) + '/' +
      encodeURIComponent(project) + (qs ? '?' + qs : ''));
    const data = await res.json();
    if (!isCurrentMount(token)) return { data: null, error: null };
    if (!res.ok || !data.ok) {
      return { data: null, error: data.message || data.error || ('HTTP ' + res.status) };
    }
    return { data, error: null };
  } catch (err) {
    if (!isCurrentMount(token)) return { data: null, error: null };
    return { data: null, error: err.message };
  }
}

// ── Formatting ───────────────────────────────────────────────────────────

/**
 * Relative age from a whole-second count. Deliberately coarse: the exact
 * timestamp is on the row's `title`, and a handoff's usefulness is measured
 * in "this morning" or "last week", never in minutes.
 *
 * A null/absent age is NOT rendered as "0s ago" — a fact and its absence do
 * not collapse into one value. Callers get null and render their own words.
 */
export function formatAge(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return 'just now';
  const m = Math.floor(seconds / 60);
  if (m < 60) return m + ' min ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' hr ago';
  const d = Math.floor(h / 24);
  if (d < 7) return d + ' day' + (d === 1 ? '' : 's') + ' ago';
  const w = Math.floor(d / 7);
  if (w < 5) return w + ' week' + (w === 1 ? '' : 's') + ' ago';
  const mo = Math.floor(d / 30);
  if (mo < 12) return mo + ' month' + (mo === 1 ? '' : 's') + ' ago';
  const y = Math.floor(d / 365);
  return y + ' year' + (y === 1 ? '' : 's') + ' ago';
}

/**
 * WHICH CLOCK A ROW'S AGE CAME FROM, and how many seconds it is.
 *
 * ── THE DEFECT THIS EXISTS FOR ───────────────────────────────────────────
 * Every age on this screen used to come from `ageSeconds` / `savedAt`, which
 * the store derives from filesystem mtime. **git sets mtime to the moment it
 * wrote the file locally**, so state that arrives over Personal Sync — by
 * clone and by incremental pull alike — carries the mtime of the PULL. On a
 * two-machine setup that made every incoming handoff read as brand new, and
 * "just now" over a day-old handoff is worse than no reading at all: it is the
 * exact reading that stops someone looking.
 *
 * The store now returns the agent's own clock beside it (`writtenAt`,
 * `writtenAgeSeconds`, from the journal line the save wrote). It is NULLABLE —
 * the journal append is best-effort, a hand-edited line may carry no usable
 * `at`, and a folder can predate journalling — so this function returns the
 * SOURCE alongside the number and every caller is expected to say which one it
 * showed. That is the rule the rest of this view already follows: a fact and
 * its absence must not collapse into one value.
 *
 * ONE function, every surface. The sidebar row, the freshness strip, the
 * handoff card's byline and the machine picker all read through here, so they
 * cannot come to disagree about what "2 min ago" means on one screen.
 *
 * Accepts either shape the API returns — an index row (`writtenAgeSeconds` /
 * `ageSeconds` / `lastWriteAt`) or `current` (`writtenAgeSeconds` / `savedAt`)
 * — because they are the same two facts under two names, and a second
 * hand-maintained accessor per shape is how they would drift apart.
 *
 * @returns {{seconds: number|null, at: string|null, source: 'agent'|'filesystem'|null}}
 */
export function effectiveSave(row, now = Date.now()) {
  const none = { seconds: null, at: null, source: null };
  if (!row || typeof row !== 'object') return none;
  const secs = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const fromStamp = (s) => {
    if (typeof s !== 'string' || !s) return null;
    const t = Date.parse(s);
    return Number.isFinite(t) ? Math.max(0, Math.round((now - t) / 1000)) : null;
  };
  // The agent's clock wins whenever it is there at all.
  const wAge = secs(row.writtenAgeSeconds) ?? fromStamp(row.writtenAt);
  if (wAge !== null) return { seconds: wAge, at: row.writtenAt || null, source: 'agent' };
  const fsAt = row.savedAt || row.arrivedAt || row.lastWriteAt || null;
  const fAge = secs(row.ageSeconds) ?? fromStamp(fsAt);
  if (fAge !== null) return { seconds: fAge, at: fsAt, source: 'filesystem' };
  return none;
}

// THE FIVE FRESHNESS STEPS used to be declared here. They are now in
// shared/age.js — same five bands, same numbers, same null-is-not-zero rule —
// because the pip they drive is one mark on an app-wide scale rather than
// this screen's private ladder, and shared/freshness.css paints the same
// scale on both sidebars. See the import at the top of this file for why
// `formatAge` above is still a copy while this one is an import.

/**
 * One-line summary of a project's memory for the sidebar row.
 *
 * "No state saved yet" and "a brief, no sessions yet" are DIFFERENT facts and
 * are said differently — a project carrying a standing brief but no handoff
 * is a real, deliberate configuration (someone wrote the brief before the
 * first agent session), not an empty one.
 */
export function projectMetaLine(p) {
  if (!p) return '';
  // THE AGENT'S CLOCK WHERE THERE IS ONE. This row said "just now" for every
  // project pulled from another machine, because `ageSeconds` is mtime and git
  // rewrites mtime on checkout. effectiveSave falls back to mtime when the
  // journal carries no usable time, so a row that never had a journal reads
  // exactly as it did before.
  const age = formatAge(effectiveSave(p).seconds);
  if (p.scopeCount > 0) {
    const scopes = p.scopeCount + ' scope' + (p.scopeCount === 1 ? '' : 's');
    return age ? scopes + ' · ' + age : scopes;
  }
  return p.hasBrief ? 'brief only — no sessions yet' : 'no state saved yet';
}

/**
 * Split the store's document preamble off the body.
 *
 * `renderDoc` in working-state.js emits, in order: a `# title`, an optional
 * `> subtitle` (the headline), an optional `_provenance_` line, then the
 * `## ` sections. On this screen all three are duplicates — the project,
 * scope and machine are already in the controls above, and the save time is
 * already on the card — so showing them again is chrome, not information.
 *
 * The rule is STRUCTURAL and fails safe rather than parsing the format:
 * drop leading lines only while each one is blank, a `# ` heading, a `> `
 * quote, or a single `_italic_` line, and stop at the first line that is
 * none of those. A body line can therefore never be eaten. If that walk
 * consumes the WHOLE document (a file with no sections — a hand-edited or
 * foreign one), nothing is stripped and the raw text is returned: losing
 * content to make a header prettier is not a trade worth making.
 *
 * The headline is returned rather than discarded — it is the one line of the
 * preamble that says something the controls do not.
 */
export function splitHandoffPreamble(raw) {
  const text = String(raw == null ? '' : raw);
  const lines = text.split('\n');
  let i = 0;
  let headline = null;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*$/.test(l)) continue;
    if (/^#{1,6}\s+\S/.test(l) && !/^##\s/.test(l)) continue;      // the doc title, never a section
    if (/^>\s?/.test(l)) { if (headline === null) headline = l.replace(/^>\s?/, '').trim(); continue; }
    if (/^_[^_].*_\s*$/.test(l)) continue;                          // the provenance line
    break;
  }
  const body = lines.slice(i).join('\n').replace(/^\n+/, '');
  if (!body.trim()) return { headline: null, body: text };          // fail safe: strip nothing
  return { headline: headline || null, body };
}

// ── Render ───────────────────────────────────────────────────────────────

/**
 * ── WHAT YOU OPEN STAYS OPEN ───────────────────────────────────
 *
 * THE DEFECT, and it was live on this screen before either ⓘ was added to it:
 * an open info panel's state lives ONLY in the DOM — shared/text.js flips
 * `hidden` and sets `aria-expanded`, and records nothing anywhere else — so
 * every render closed it. On Agent memory that is not a rare event: the poll
 * repaints whenever screenSignature changes, which includes the reading simply
 * ageing into the next band, so a user reading "How this works" could have it
 * shut under them while they read. v3.53.1 found and fixed the same shape on
 * Providers & keys and recorded it as UNFIXED here.
 *
 * The <details> on this page do NOT need this: their open state is already in
 * `state.openFolds`, written by the delegated `toggle` listener in wire(), and
 * re-emitted as an `open` attribute on the next paint. Only the two ⓘ panels
 * are DOM-only, so only they are captured.
 *
 * RESTORE ONLY EVER OPENS. Closing here would fight a renderer that forces a
 * panel open, and a panel that snapped shut is the defect being fixed while a
 * stray open one is visible and one click from closed. BOTH HALVES OR NEITHER:
 * shared/text.js's delegated listener reads `aria-expanded` to decide what the
 * next click does, so a panel shown with its button still saying "false" would
 * take two clicks to close.
 *
 * EVERYTHING IS INLINE, AND THAT IS A CONSTRAINT, NOT A STYLE. `render`,
 * `captureFocus` and `restoreFocus` are LIFTED out of this file and executed by
 * scripts/test-next-memory-view.js §13 with a fixed set of injected
 * collaborators; any other free identifier is a ReferenceError there — a CRASH
 * rather than a failing assertion, which is the v3.11.0 shape this file warns
 * about twice. So no module-level helper, and the `typeof` guards are what let
 * the same code run against that suite's minimal fake document (which has no
 * querySelectorAll) and under Node with no DOM at all. In a browser both are
 * always taken.
 */
function render(token) {
  if (!isCurrentMount(token)) return;
  renderedSignature = screenSignature();
  captureFocus();

  const doc = (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function')
    ? null : document;
  // Taken BEFORE the swap, off the LIVE DOM rather than off state: the click
  // that opened the panel was applied synchronously by the component's own
  // listener, so the DOM is the only place the fact exists at all.
  const openInfos = [];
  if (doc) {
    const marks = doc.querySelectorAll('[data-tx-info][aria-expanded="true"]');
    for (let i = 0; i < marks.length; i++) {
      const id = marks[i].getAttribute('data-tx-info');
      if (id) openInfos.push(id);
    }
  }

  renderSidebar(token);
  renderMain(token);

  if (doc && openInfos.length) {
    const marks = doc.querySelectorAll('[data-tx-info]');
    for (let i = 0; i < marks.length; i++) {
      const btn = marks[i];
      const id = btn.getAttribute('data-tx-info');
      if (!id || openInfos.indexOf(id) === -1) continue;
      const panel = doc.getElementById(id);
      if (!panel) continue;
      panel.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
    }
  }

  wire(token);
  restoreFocus();
}

/**
 * Remember the focused control, if it is one of ours.
 *
 * Only overwrites a pending id when there is a real one to record, so the
 * second render of a scope change — by which point focus has already been
 * dropped to <body> by the first — cannot erase the target it is about to
 * restore. Deliberately narrow: an id outside FOCUSABLE_IDS is ignored, so
 * this can never reach out and grab focus from the rail or another view.
 */
function captureFocus() {
  if (typeof document === 'undefined') return;
  const active = document.activeElement;
  const id = active && active.id;
  if (id && FOCUSABLE_IDS.includes(id)) { pendingFocusId = id; return; }
  // THE ID-LESS BRANCH IS GONE WITH THE ELEMENT IT EXISTED FOR. It resolved the
  // shared explainer's <summary>, which carries no id of its own, through
  // `data-tx-explainer`. "How this works" is now the header's ⓘ — a real
  // <button> with a real id, which the list above names — so every control this
  // view will restore to has an id again and the attribute walk has nothing
  // left to find. Deleted rather than left standing: a branch that can no
  // longer be taken is a claim about the screen that is no longer true.
}

function restoreFocus() {
  if (!pendingFocusId || typeof document === 'undefined') return;
  const el = document.getElementById(pendingFocusId) ||
    (FOCUS_FALLBACK[pendingFocusId] ? document.querySelector(FOCUS_FALLBACK[pendingFocusId]) : null);
  if (el && typeof el.focus === 'function') {
    pendingFocusId = null;
    // preventScroll: the element is already where the user left it; letting
    // the browser scroll to it would undo the reading position that the
    // re-render preserved.
    try { el.focus({ preventScroll: true }); } catch { /* non-focusable in some engines */ }
    return;
  }
  // Nothing to restore to. Keep the target only while another render is
  // still coming; otherwise drop it so it cannot fire later out of context.
  if (!state.detailLoading) pendingFocusId = null;
}

/**
 * The rail's project list, GROUPED BY DOMAIN.
 *
 * A domain heading above its projects, in the domain order the index
 * returned. The list itself is deliberately NOT re-sorted by recency: a rail
 * that reorders itself between visits is disorienting, and recency already
 * decides the initial SELECTION (see initialPick), which is the place where
 * "what did I just touch" is actually useful.
 *
 * THE HEADING IS A HEADING, NOT A BUTTON. Selecting a domain is not a thing
 * this screen does — memory belongs to a project — so a clickable domain row
 * would either do nothing or invent a second selection model. It carries the
 * domain name and nothing else.
 *
 * A domain with exactly one project still gets its heading. Suppressing it
 * would make the rail change SHAPE when a second project appears, and the
 * heading is also the only thing on this screen that names which domain a
 * project lives in.
 *
 * Pure and exported through __testing: this is the function the grouping
 * assertions drive.
 */
export function renderProjectGroups(projects, activeDomain, activeProject) {
  const rows = Array.isArray(projects) ? projects.filter(Boolean) : [];
  const order = [];
  const byDomain = new Map();
  for (const p of rows) {
    const d = p.domain == null ? '' : String(p.domain);
    if (!byDomain.has(d)) { byDomain.set(d, []); order.push(d); }
    byDomain.get(d).push(p);
  }
  return order.map((domain) => {
    const inner = byDomain.get(domain).map((p) => {
      const active = p.domain === activeDomain && p.project === activeProject;
      const has = p.scopeCount > 0 || p.hasBrief;
      // THE FRESHNESS DOT, on the app-wide scale. The rail said "3 scopes ·
      // 2 hr ago" and made you READ it to rank two projects; the dot answers
      // the same question pre-attentively, from `freshnessTier` — the same
      // function the work-stream table's dots and (under its other name,
      // `freshnessStep`) the save strip's pip are cut on, so a project row and
      // its own newest work-stream can never disagree about how fresh it is.
      // It is aria-hidden: the words beside it say the same thing.
      const tier = freshnessTier(effectiveSave(p).seconds);
      return (
        '<button class="mem-row' + (active ? ' active' : '') + (has ? '' : ' mem-row-quiet') + '"' +
          ' data-mem-domain="' + escapeHtml(domain) + '"' +
          ' data-mem-project="' + escapeHtml(p.project) + '"' +
          (active ? ' aria-current="true"' : '') + '>' +
          // SQUARE, not round — see this file's header comment.
          '<span class="mem-row-mark' + (has ? '' : ' mem-row-mark-off') + '"></span>' +
          '<span class="mem-row-main">' +
            '<span class="mem-row-name">' + escapeHtml(p.project) + '</span>' +
            // "WORKING ON:" IN THE RAIL. `headline` rides on every index row
            // and nothing had ever rendered it; the menubar widget leads with
            // it. One line, ellipsised, and OMITTED rather than filled with a
            // placeholder when there is none — an em dash under every project
            // with no saves would be noise on the one list you scan.
            (p.headline
              ? '<span class="mem-row-head">' + escapeHtml(p.headline) + '</span>'
              : '') +
            '<span class="mem-row-meta">' +
              '<span class="fresh-dot fresh-' + tier + '" aria-hidden="true"></span>' +
              '<span>' + escapeHtml(projectMetaLine(p)) + '</span>' +
            '</span>' +
          '</span>' +
        '</button>'
      );
    }).join('');
    return (
      '<div class="mem-group">' +
        '<div class="mem-group-head cur-eyebrow">' + escapeHtml(domain) + '</div>' +
        '<div class="mem-row-list">' + inner + '</div>' +
      '</div>'
    );
  }).join('');
}

function renderSidebar(token) {
  // NO PARAGRAPH UNDER THE TITLE. v3.20.0 moved this sentence from
  // `.sidebar-hint` into renderDescription, which changed its CLASS and left it
  // in the same position — still prose floating under a title. renderViewHeader
  // has no field that can put it back there.
  //
  // The clause that was cut is `read here, written by them`: it is back, in
  // ONE place, as the second sentence of this panel.
  //
  // WHY IT MOVED. It had been a floating card at the foot of the rail — a lock
  // glyph and a sentence, under the project list, belonging to nothing. The
  // maintainer flagged it as undesigned, and he is right about the mechanism as
  // well as the look: it is the same KIND of content as the sentence already
  // behind this mark (what this screen is and who writes it), rendered in a
  // second place with a second treatment. One mark, one panel, one voice.
  //
  // The Refresh button's tooltip is folded in here rather than deleted. It was
  // the only place that said the screen re-checks by itself, and a `title=` is
  // invisible to keyboard and to touch — the class v3.20.0 counted 11 of.
  const head = renderViewHeader({
    variant: 'sidebar',
    title: 'Agent memory',
    info: 'The working brief your agents leave for each other. This screen re-checks by itself '
      + 'when you come back to it, so Refresh is rarely needed. '
      + 'Agents save handoffs here over MCP; you write the standing brief.',
  });

  if (state.loading) {
    setSidebar(head + gatedLoader(loadGate, 'Loading…', 'sidebar-hint'), token);
    return;
  }
  if (state.indexError) {
    // A FAILURE, not a hint. renderStatus carries its state in a 3px rail
    // (a BORDER, so its floor is 3:1, which --danger-text clears in both
    // themes) while the words stay at --text/--text-2, which clear the 4.5:1
    // text floor. The old `.mem-error-text` painted the whole sentence in
    // --danger-text: the state was decoded from colour, and read as a dimmer
    // version of the description directly above it.
    setSidebar(head + renderStatus({
      state: 'danger',
      title: 'Could not load agent memory',
      detail: state.indexError,
    }), token);
    return;
  }
  if (!state.projects.length) {
    setSidebar(head + '<div class="cur-eyebrow" style="margin-top:10px">PROJECTS</div>' +
      renderDescription('No domains yet. Agent memory is kept per domain — create one in Domains first.'),
      token);
    return;
  }

  const rows = renderProjectGroups(state.projects, state.activeDomain, state.activeProject);

  // A VISIBLE, KEYBOARD-REACHABLE way to re-ask. The automatic triggers
  // (select, wake, poll) cover the cases we can predict; this covers the one
  // we cannot, which is a user who simply does not believe the screen.
  //
  // Plain text rather than a glyph: there is no refresh icon in ICON_BODY,
  // and icon() renders a loud placeholder for a name it does not know rather
  // than guessing (v3.9.0), so inventing one would ship a broken icon. A
  // word also needs no aria-label to be announced correctly.
  //
  // Hoisted into a local rather than inlined into the setSidebar() call
  // below: test-next-memory-view §9 reads the token argument within a
  // 12-line window of the call, and it is right to — a call whose arguments
  // no longer fit on a screen is a call whose token is easy to drop.
  const projectsHead =
    '<div class="mem-projects-head">' +
      '<span class="cur-eyebrow">PROJECTS</span>' +
      // No `title=`. The sentence it carried is in the header's info panel,
      // where a keyboard or touch user can actually reach it; the word
      // "Refresh" is its own accessible name.
      //
      // THE KIT'S QUIET TIER, NAMED. shell.css's taxonomy calls this rung
      // `.btn-ghost` — a control that must be reachable and must not compete —
      // and this button is its definition: the fallback for an automatic
      // revalidation, where prominence would imply the screen does not update
      // on its own. It used to be a bespoke `.mem-refresh` rule painting the
      // same intent by hand, which is the one-copy-per-view shape the design
      // foundation removed for `.btn-xs`. `.mem-refresh` survives for the hit
      // target and the flex behaviour only.
      '<button type="button" class="btn btn-ghost btn-xs mem-refresh" id="mem-refresh">Refresh</button>' +
    '</div>';

  // NO FOOT CARD. The lock glyph and its sentence are the header's info panel
  // now (see `head` above). What sat here was a floating, undesigned block
  // under the list — and, once the same fact was behind the mark, a second
  // copy of it on the same screen.
  setSidebar(head + projectsHead + rows, token);
}

function renderMain(token) {
  let body;
  if (state.loading) {
    body = gatedLoader(loadGate, 'Loading agent memory…');
  } else if (state.indexError) {
    body = renderStatus({
      state: 'danger', title: 'Could not load agent memory', detail: state.indexError,
    });
  } else if (!state.activeProject) {
    body = renderNoProjects();
  } else {
    body = renderProject();
  }

  // ── "HOW THIS WORKS" IS THE MARK NOW, NOT A CARD ────────────────────────
  //
  // REWRITTEN, and the note it replaces was right when it was written. It said
  // there must be no `info` here because renderAbout() already owned the
  // mechanism explanation, and a second copy behind the mark would be two
  // hand-maintained descriptions of one thing. That reasoning forbade a COPY.
  // This is a MOVE: renderAbout is gone, its four call sites with it, and the
  // text below is now the only description of the three tiers in this view.
  //
  // WHY IT MOVED. As a <details> it was a full-width card at the foot of every
  // branch of this page — the widest thing on screen, under the three cards that
  // actually carry state, and (because .tx-explainer sets no margin of its own)
  // glued to the journal above it with a 0px gap. It is read once per user and
  // then never again, which is exactly what the header's ⓘ is for:
  // renderViewHeader says so about itself, and this view's own fold is the
  // pattern that component was generalised FROM. The affordance is a mark
  // beside the title, where Finder, Mail and System Settings put the same thing.
  //
  // WHAT IT MAY NOT CARRY is unchanged: no warning, no cost, no refusal.
  // v3.16.1's rule is that a warning behind a click is not a warning, and every
  // byte of this panel explains a mechanism. The read-only rule in its last
  // paragraph is a DESIGN FACT, not a caution — the store has no endpoint to
  // reach even if the sentence were missed.
  //
  // `infoHtml: true`, so this call owns escaping. Every byte is a literal
  // except the docs link, whose URL comes from the frozen table in
  // shared/docs-links.js and whose label the helper escapes.
  //
  // THE ACTION SLOT is the component's sanctioned place for a control beside a
  // title — the same slot views/domains.js uses for Rename / Delete / Ask this
  // domain. "Copy agent instructions" used to float at the far right of the
  // breadcrumb row on a `margin-left: auto`, which is how it came to sit alone
  // above the cards, belonging to nothing. It is offered only when there is a
  // project to compose a block FOR: composeAgentInstructions needs the pair,
  // and a button that can only fail is worse than no button.
  setMain(
    renderViewHeader({
      eyebrow: 'your agents’ brain',
      title: 'Agent memory',
      info: aboutInfoHtml(),
      infoHtml: true,
      // THE PANEL RUNS THE COLUMN, like everything under it. This page's five
      // blocks, its table and its two documents all end at one right edge, and
      // a help panel stopping at 68ch beside them was the last of the four
      // widths v3.54.0 started removing from this screen. `panelWide` is an
      // opt-in on the shared component (shared/text.js) rather than a change
      // to its default, because the cap is right for every view whose header
      // panel really is a paragraph of prose.
      panelWide: true,
      actionsHtml: state.activeProject
        ? '<button type="button" class="btn btn-secondary btn-xs" id="mem-copy-agent">'
          + 'Copy agent instructions</button>'
        : '',
    }) +
    body,
    token
  );
}

/**
 * THE EMPTY SCREEN IS TWO DIFFERENT ANSWERS, and they are said differently.
 *
 * Since v3.48.0 the store omits a domain's own project when it has neither a
 * standing brief nor a save, so an empty index no longer means "no domains".
 * It means one of two things, and telling a user with four domains that they
 * have none is worse than saying nothing — it sends them to create a fifth.
 * `domainsScanned` is the server's own count; `null` means a server that did
 * not say, and that arm claims neither.
 */
function renderNoProjects() {
  const n = state.domainsScanned;
  const noDomains = n === 0;
  const title = noDomains ? 'No domains yet' : 'No agent memory yet';
  // `html: true` because these sentences carry an inline <code>. The caller
  // owns escaping when it opts in; every value here is a literal or a
  // server-supplied INTEGER, which is why `n` is checked with Number.isInteger
  // before it is used and rendered as a count rather than interpolated raw.
  const body = noDomains
    ? 'Agent memory is kept per domain, under <code>state/</code> beside that domain’s wiki. ' +
      'Create a domain first, then point an agent at it — the brief appears here the moment one saves.'
    : (Number.isInteger(n) && n > 0
        ? 'Nothing has been saved in ' + (n === 1 ? 'your domain' : 'any of your ' + n + ' domains') + ' yet. '
        : 'Nothing has been saved yet. ') +
      'Agent memory lives under <code>state/</code> beside a domain’s wiki, and a project appears here ' +
      'the moment an agent saves a handoff or you write it a standing brief in Domains → Projects.';
  return (
    '<div class="empty-card">' +
      '<div class="empty-title">' + title + '</div>' +
      renderDescription(body, { html: true }) +
    '</div>'
  );
}

/**
 * The confirmation, or the refusal, for "Copy agent instructions".
 *
 * STAMPED, and the stamp is checked here rather than only cleared on switch:
 * `state.copied` is written after an await, and this view changes project
 * without unmounting, so the only safe question to ask at paint time is
 * "was this copy about the project I am painting?".
 *
 * A refusal PRINTS THE BLOCK. `navigator.clipboard` is unavailable on a
 * non-secure origin and can be refused outright; the whole value of the button
 * is the text, so a refusal hands it over to be selected by hand instead of
 * leaving a button that silently did nothing.
 */
function renderCopyOutcome() {
  const c = state.copied;
  if (!c) return '';
  if (c.domain !== state.activeDomain || c.project !== state.activeProject) return '';
  // ONE `.mem-section`, wrapped here rather than at the call site, because the
  // refusal arm is TWO elements (a status box and the block itself) and the
  // page's single adjacency rule spaces SIBLINGS. Returning two bare siblings
  // would put a 24px gap between a refusal and the text it is handing over.
  // The empty arms above return before the wrapper, so an outcome that renders
  // nothing never emits an empty box for the rule to space around.
  if (c.ok) {
    return '<div class="mem-section">' + renderStatus({
      state: 'success',
      title: 'Agent instructions copied',
      detail: COPY_SUCCESS_BANNER,
    }) + '</div>';
  }
  return '<div class="mem-section">' + renderStatus({
    state: 'attention',
    title: 'Could not copy',
    detail: 'Your browser refused clipboard access. Select the block below and copy it by hand.',
  }) + '<pre class="mem-copy-fallback">' + escapeHtml(c.text) + '</pre></div>';
}

/**
 * Compose the block for the project on screen and put it on the clipboard.
 *
 * The pair is captured BEFORE the await and the outcome is stamped with it,
 * so a project switch during the copy leaves the confirmation belonging to the
 * project it was pressed on — where renderCopyOutcome will decline to paint
 * it — rather than re-labelling it as the new one's.
 */
async function copyAgentInstructions(token) {
  const domain = state.activeDomain;
  const project = state.activeProject;
  const text = composeAgentInstructions({ domain, project });
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch { ok = false; }
  if (!isCurrentMount(token)) return;
  state.copied = { domain, project, ok, text };
  render(token);
}

/**
 * THE PROJECT PAGE — five blocks, one right edge, one rhythm.
 *
 * ── WHAT THIS PAGE IS FOR, RESTATED, BECAUSE THE SHAPE FOLLOWS FROM IT ─────
 * The maintainer's verdict on the v3.54.0 page was "not okay", in six parts:
 * four of its elements were capped at reading width while the journal beside
 * them ran the full column; the way to edit the brief was below the brief;
 * work-streams were hard to find; the cards were inconsistently sized; there
 * was no colour to make "what moved when" glanceable; and two readings the
 * menubar widget has had for six releases — the "Working on:" headline and
 * "another machine saved after this one" — existed nowhere in the app.
 *
 * So this is a DASHBOARD, not a document, and every one of those follows:
 *
 *   ① STATUS         — where the project stands, across every machine
 *   ② WORK-STREAMS   — the table, newest first, one row per saved copy
 *   ③ CURRENT HANDOFF— the document you came to read
 *   ④ STANDING BRIEF — yours, with a pencil beside the title
 *   ⑤ SESSION JOURNAL— history, folded, last
 *
 * ── THE BLOCKS ARE shared/block.js's, AND THE RHYTHM COMES WITH THEM ───────
 * `renderBlock` emits `.settings-job-block`, whose shell.css rule is
 * 24 | 1px hairline | 24 between adjacent blocks — the same declaration
 * Providers & keys and all four Settings sections are built on. This view
 * therefore does NOT re-declare that gap; memory.css carries ONE bridging rule
 * so a `.mem-section` above the first block (the breadcrumb, a notice, the
 * copy confirmation) is separated by the same 24.
 *
 * ── UNNUMBERED, DELIBERATELY ──────────────────────────────────────────────
 * `num: null` on every block. shared/block.js's own note is that a numeral is
 * an argument for SEQUENCE, and this page is not a sequence of steps — it is
 * five readings about one project, any of which may be the one you came for.
 * Providers & keys is numbered because block 1 is the only thing a fresh
 * install can do; nothing here has that property.
 *
 * ── EVERY LEDE IS AT MOST TWENTY VISIBLE WORDS ────────────────────────────
 * The rest goes behind the block's own ⓘ, which is the rule v3.54.0 set for
 * Settings and the reason those pages stopped being "a sea of information".
 * What may NEVER fold is a warning: v3.16.1's rule is that a warning behind a
 * click is not a warning, which is why the stale notice, the unlisted note and
 * every save verdict are in block ①'s BODY and not in its fold.
 */
function renderProject() {
  const read = state.projectRead;
  const d = state.detail;

  // ── A BREADCRUMB, AND NOTHING ELSE ───────────────────────────────
  // "Copy agent instructions" used to live at the end of this row on a
  // `margin-left: auto`, which made a full-width row out of what is otherwise
  // a short phrase and floated the button alone above the cards. It is in the
  // header's action slot now (renderMain), beside the title, which is where
  // this design system puts a control belonging to the whole screen.
  //
  // WHAT STAYS. Domain then project, with the domain quiet: the project is
  // what the screen is about, the domain is where it lives, and both are shown
  // always because the rail groups by domain and this is the only place that
  // can answer "which domain is this?".
  const header =
    '<div class="mem-project-head mem-section">' +
      '<span class="mem-project-mark"></span>' +
      '<span class="mem-project-domain">' + escapeHtml(String(state.activeDomain || '')) + '</span>' +
      '<span class="mem-project-sep">/</span>' +
      '<span class="mem-project-name">' + escapeHtml(state.activeProject) + '</span>' +
      (d && d.readonly
        ? '<span class="mem-badge mem-badge-quiet">shared mirror</span>'
        : '') +
    '</div>' +
    // PROMOTED OUT OF A TOOLTIP, not folded behind a mark. This qualifies who
    // WROTE what you are about to read — it can be someone else on your cohort
    // — so it belongs with the unlisted and stale notes that also sit here to
    // qualify the claims below them, not behind a click. It was a `title=` on a
    // non-focusable <span>: unreachable by keyboard, unreachable by touch.
    (d && d.readonly
      ? '<div class="mem-note mem-section">' + icon('lockAlt', 13) +
        '<span>A read-only Shared Brain mirror — this state can have been written by ' +
        'someone else on your cohort.</span></div>'
      : '') +
    renderCopyOutcome();

  if (state.detailError) {
    return header + '<div class="mem-section">' + renderStatus({
      state: 'danger', title: 'Could not read this project’s memory', detail: state.detailError,
    }) + '</div>';
  }
  if (state.detailLoading && !read) {
    return header + '<div class="mem-section">' + gatedLoader(loadGate, 'Reading state…') + '</div>';
  }

  const scopes = (read && read.scopes) || [];
  const hasBrief = !!(read && read.brief && read.brief.present);
  const unlisted = unlistedCount(read);

  // ── BLOCK ① — STATUS ─────────────────────────────────────────────────────
  // FIRST, ABOVE EVERYTHING IT COULD BE QUALIFIED BY, and that placement is
  // the feature. It answers "am I saved?" — asked by someone with almost no
  // context left — so it must not sit under two conditional notes and a table
  // on the days those appear.
  //
  // The stale notice renders directly beneath the reading, so when a save has
  // landed since the page loaded the figure and the offer to reload read as one
  // block; the unlisted note sits with them because it qualifies every claim
  // the page is about to make. NONE of the three is inside the fold.
  const saveStatus = renderSaveStatus(read, d);
  const staleNote = renderStaleNotice();
  const unlistedNote = renderUnlistedNote(read, d);
  const statusBody = saveStatus + staleNote + unlistedNote;
  const statusBlock = statusBody
    ? renderBlock({
      num: null,
      id: 'memory-status',
      title: 'Status',
      ledeHtml: 'Where this project stands right now, across every machine.',
      infoText:
        '<p>There are TWO clocks behind every age on this page. The <b>agent’s clock</b> is the time the '
        + 'agent itself recorded when it saved, taken from the journal line it wrote. The <b>file’s clock</b> '
        + 'is when the file last changed on this disk — and on a computer that syncs, that is when the file '
        + 'ARRIVED here, not when it was written. The agent’s clock is used whenever there is one, and a '
        + 'reading that had to fall back says “file time” in its own provenance line, in words, rather '
        + 'than in a tooltip.</p>'
        + '<p>“Last saved” is exactly that. It knows when the last save happened, not whether anything has '
        + 'changed since — no screen can know that — so it never says you are saved, and the inference stays '
        + 'with you.</p>'
        + '<p>' + docsLinkHtml('memory.handoff', 'Read more in the guide') + '</p>',
      infoHtml: true,
      bodyHtml: '<div class="mem-status-stack">' + statusBody + '</div>',
    })
    : '';

  // ── BLOCK ② — WORK-STREAMS ───────────────────────────────────────────────
  const streamsBlock = scopes.length
    ? renderBlock({
      num: null,
      id: 'memory-streams',
      title: 'Work-streams',
      ledeHtml: 'Every work-stream of this project, newest first. Open one to read its handoff.',
      infoText:
        '<p>A <b>work-stream</b> is one thread of work — the files call it a <i>scope</i>, and the slug is '
        + 'still shown as one. Parallel threads get their own, so they never overwrite each other.</p>'
        + '<p>Each machine writes to its OWN folder inside a work-stream, which is what makes two computers '
        + 'safe over sync: no two of them ever touch one file. So one work-stream can appear here as several '
        + 'rows — one saved copy per machine — and the count below the table says both numbers.</p>'
        + '<p>Two rows sharing a work-stream AND a machine cannot happen; two <b>harnesses</b> on one machine '
        + 'can, and they overwrite each other, because the folder has no harness segment. Block ① names that '
        + 'explicitly when the journal shows it, and the remedy is to give each tool its own work-stream.</p>'
        + '<p>Only the most recently saved copies are listed when a project has a great many; the line under '
        + 'the table says so and gives the real total.</p>'
        + '<p>' + docsLinkHtml('memory.session-journal', 'Read more in the guide') + '</p>',
      infoHtml: true,
      bodyHtml: renderWorkStreams(scopes, d) + workStreamCounts(read, scopes.length),
    })
    : '';

  // ── BLOCK ③ — CURRENT HANDOFF ────────────────────────────────────────────
  // Its body is the lead fold when there IS a handoff, the "no handoff yet"
  // card when a brief exists without one, and the empty-project card when
  // there is nothing at all — the missing thing is missing in the place you
  // looked for it, which is the v3.17.1 rule this branch was built for.
  const handoffBody = scopes.length
    ? renderHandoff()
    : (hasBrief ? renderBriefOnlyNotice(read, unlisted) : renderEmptyProject(unlisted));
  const handoffBlock = renderBlock({
    num: null,
    id: 'memory-handoff',
    title: 'Current handoff',
    ledeHtml: 'What the last session left for the next one — overwritten on every save.',
    infoText:
      '<p>The handoff is where things stand RIGHT NOW: what an agent leaves for the next session, so that '
      + 'session starts knowing what you already settled. There is one per work-stream per machine, and it '
      + 'is <b>overwritten</b> on every save rather than appended to — which is the whole point. State has '
      + 'to be able to say “no longer true”, and a store that only accumulates cannot.</p>'
      + '<p>Your agents write this through the <span class="mono">my-curator</span> MCP tools and this '
      + 'screen never does — a handoff is worth something because an agent observed it. It is plain '
      + 'markdown on disk, so a text editor works too.</p>'
      + '<p>' + docsLinkHtml('memory.handoff', 'Read more in the guide') + '</p>',
    infoHtml: true,
    bodyHtml: handoffBody,
  });

  // ── BLOCK ④ — STANDING BRIEF ─────────────────────────────────────────────
  const briefBlock = renderBlock({
    num: null,
    id: 'memory-brief',
    title: 'Standing brief',
    ledeHtml: 'Your goals, firm decisions and working model — read by every agent, written by you.',
    infoText:
      '<p>This is the one tier a human owns. Agents READ it on every call and, unless you ask one to, '
      + 'never write it; you edit it here with the pencil, or open '
      + '<span class="mono">state/&lt;project&gt;/project.md</span> in any text editor.</p>'
      + '<p>Saving <b>replaces the whole document</b> — it is not merged with what was there — so send the '
      + 'complete brief rather than an addition. That is the same rule a handoff save follows, and for the '
      + 'same reason.</p>'
      + '<p>It is the part that rarely changes: the goal, the firm decisions not to re-litigate, the working '
      + 'model, and pointers to where the depth lives. An OLD brief is not a stale one, which is why it '
      + 'carries a date and deliberately no freshness mark.</p>'
      + '<p>' + docsLinkHtml('memory.standing-brief', 'Read more in the guide') + '</p>',
    infoHtml: true,
    bodyHtml: renderBrief(read),
  });

  // ── BLOCK ⑤ — SESSION JOURNAL ────────────────────────────────────────────
  const journalBody = renderJournal();
  const journalBlock = journalBody
    ? renderBlock({
      num: null,
      id: 'memory-journal',
      title: 'Session journal',
      ledeHtml: 'One line per save, newest first. History, not the present.',
      infoText:
        '<p>The journal is append-only and it accumulates, so any entry MAY SINCE HAVE BEEN SUPERSEDED — a '
        + 'blocker named in an old headline can have been fixed three saves ago. The current handoff above '
        + 'is what is true now.</p>'
        + '<p>Each line carries when, which harness, which model and the save’s own headline, plus any '
        + 'NOTES the store recorded about that save. Most notes are ordinary normalisation — a value filled '
        + 'in and disclosed — and the line says so in words; a note about content actually lost is the only '
        + 'one marked.</p>'
        + '<p>It survives things the handoff cannot: two agent tools writing one work-stream overwrite each '
        + 'other’s handoff, and both trails are still here.</p>'
        + '<p>' + docsLinkHtml('memory.session-journal', 'Read more in the guide') + '</p>',
      infoHtml: true,
      bodyHtml: journalBody,
    })
    : '';

  return header + statusBlock + streamsBlock + handoffBlock + briefBlock + journalBlock;
}

/**
 * "An agent saved something since you loaded this."
 *
 * OFFERED, NEVER APPLIED. The sidebar is a summary and re-renders silently;
 * the handoff is a document somebody is part-way through READING, and
 * swapping it underneath them — moving their scroll position and the folds
 * they opened — trades one wrong-looking screen for a hostile one. So the
 * document stays put and the user decides.
 *
 * Says what is true and nothing more: something was written, not what. We
 * know a newer mtime exists; we have not read it, and claiming to know
 * whether it changed THIS scope would be a guess.
 */
function renderStaleNotice() {
  if (!state.staleWrite) return '';
  // `.mem-section` is GONE from this box for the same reason it left
  // `.mem-save`: the notice sits INSIDE block ①, under the reading it
  // qualifies, and the gap there belongs to `.mem-status-stack`.
  return (
    '<div class="mem-stale" role="status">' +
      '<span class="mem-stale-text">An agent has saved to this project since you opened it — ' +
        'what is below may not be the latest.</span>' +
      // btn-secondary is NAMED, not implied. `.btn` alone carries no
      // background/colour/border of its own, so before shell.css gained its
      // neutral baseline this button inherited Chromium's native chrome and
      // rendered as a grey, bevelled OS button (measured: ButtonFace
      // rgb(107,107,107), 2px outset). The baseline now stops that being
      // NATIVE; naming the variant is what makes it look deliberate rather
      // than a ghost, which is what the author plainly intended here.
      '<button type="button" class="btn btn-secondary btn-xs mem-stale-btn" id="mem-reload">Reload</button>' +
    '</div>'
  );
}

/**
 * "AM I SAVED?" — the one question this screen has to answer in a second.
 *
 * ── WHY IT IS A STRIP AT THE TOP AND NOT A FIELD ON THE DOCUMENT ─────────
 * Reported from real use: *"when I'm using the Curator memory I'm worried all
 * the time about whether the scopes are updated. When we are approaching the
 * end of the context window I'm always wondering if we have updated the scope,
 * and if the standing brief is up to date."* That is asked by someone with
 * very little context left to spend, so the answer has to be above everything
 * that qualifies it and has to survive a one-second glance.
 *
 * ── THE FOUR THINGS IT SAYS, AND WHY EACH EARNS ITS LINE ────────────────
 *
 *  1. THIS SCOPE. Pip + age + which scope + which harness. The pip is the
 *     pre-attentive half (freshnessStep); the words are the exact half. This
 *     is the whole answer on a healthy day and it is one line.
 *
 *  2. ANY SCOPE IN THIS PROJECT. Rendered ONLY when some other (scope,
 *     machine) in this project holds something NEWER than what you are
 *     looking at. That is a different question from 1 and the difference is
 *     the one that bites: an agent told to "reuse an existing scope" can be
 *     saving beside you into a scope you are not watching, and the screen
 *     would otherwise look calm.
 *
 *  3. WHETHER THAT SAVE WAS COMPLETE. A save is not the same as a *complete*
 *     save. The store trims an over-budget handoff rather than refusing it —
 *     the right call, because a refused save near the end of a context loses
 *     the handoff outright — and it discloses the trim in the journal line's
 *     notes. "Saved 2 minutes ago" over a trimmed handoff is a comforting
 *     lie, so the reading carries the verdict the store already computed
 *     (`lastSaveKind`) and never renders a bare age over `trimmed`.
 *
 *  4. THE STANDING BRIEF, on its own much slower clock. It changes on the
 *     order of weeks and it is deliberately NOT given a freshness pip: an old
 *     brief is not a stale one, and marking it the way a handoff is marked
 *     would say something false. It gets a plain line, always, because it is
 *     the second half of the question that was asked.
 *
 * ── WHAT IT REFUSES TO SAY ───────────────────────────────────────────────
 * It never says "you are saved". It cannot know that: it knows when the last
 * save happened, not whether anything has changed since. The label is "Last
 * saved" for that reason, and the inference is left where it belongs.
 *
 * Nothing here writes, polls, or fetches; it is a projection of the two reads
 * this view already has.
 */
function renderSaveStatus(read, d) {
  const scopes = (read && Array.isArray(read.scopes)) ? read.scopes : [];
  const brief = read && read.brief;
  const doc = d && d.current && d.current.present ? d.current : null;

  // ── THE READING SURVIVES A SCOPE SWITCH ──────────────────────────────────
  // loadScope drops `state.detail` before it paints, deliberately, so the old
  // machine list and the old handoff are never shown under the new scope's
  // label. That would take the reading off screen for the length of every
  // fetch — a figure that blinks out whenever you touch the picker is not an
  // instrument. The index row for the same (scope, machine) carries every
  // field this needs, and it is already in hand, so it stands in. Anything
  // computed from it is the SAME store fields under the same names; there is
  // no second measurement here that could disagree with the first.
  const shownScope = (d && d.scope) || state.scope || null;
  const shownMachine = (d && d.machine) || state.machine || null;
  const row = !doc && shownScope
    ? (scopes.find((s) => s && s.scope === shownScope && (!shownMachine || s.machine === shownMachine))
      || scopes.find((s) => s && s.scope === shownScope) || null)
    : null;
  const cur = doc || row;

  const lines = [];
  let primary = '';

  // ── "WORKING ON:" — THE WIDGET'S HEADLINE, IN THE APP ────────────────────
  //
  // The menubar widget leads with it and this screen never showed it at all,
  // although every read carried it: `scopes[].headline` is the one-line summary
  // the agent wrote into its own save, and the index row carries the project's.
  //
  // THE PROJECT'S ANSWER, NOT THE OPEN ROW'S. This is the top of a block
  // titled "Status" whose lede says "where this project stands right now", so
  // it takes the NEWEST pair's headline even when you are reading an older
  // work-stream — the table below gives every row its own. Falling back to the
  // index row covers the moment `projectRead` has not landed yet.
  //
  // The pip and the age are the newest pair's too, for the same reason and
  // from the same `effectiveSave`, so the mark, the words and the sentence
  // cannot name three different saves.
  const newestForHead = newestPair(scopes);
  const indexRow = (state.projects || []).find(
    (p) => p && p.domain === state.activeDomain && p.project === state.activeProject) || null;
  const headline = (newestForHead && newestForHead.headline)
    || (indexRow && indexRow.headline) || null;
  if (headline) {
    const hEff = effectiveSave(newestForHead || indexRow || {});
    const hStep = freshnessStep(hEff.seconds);
    const hAge = formatAge(hEff.seconds);
    primary +=
      '<div class="mem-working"' +
        (hAge && hEff.at ? ' data-mem-age-at="' + escapeHtml(hEff.at) + '"' : '') + '>' +
        '<span class="mem-save-pip' +
          (hStep === null ? ' mem-save-pip-unknown' : ' mem-save-pip-s' + hStep) +
          '" aria-hidden="true"></span>' +
        '<span class="mem-working-label">Working on</span>' +
        '<span class="mem-working-text">' + escapeHtml(headline) + '</span>' +
        (hAge ? '<span class="mem-age-words mem-working-age">' + escapeHtml(hAge) + '</span>' : '') +
      '</div>';
  }

  if (cur) {
    const eff = effectiveSave(cur);
    const step = freshnessStep(eff.seconds);
    const age = formatAge(eff.seconds);
    // Provenance is the scope you are in and the tool that wrote it — the two
    // facts that turn "2 min ago" into "2 min ago, by the thing I am running".
    const prov = [shownScope, doc ? harnessOf(d) : (row && row.harness) || null]
      .filter(Boolean).join(' · ');
    // SAY WHICH CLOCK. `filesystem` means no journal line carried a usable
    // time, so the figure is the file's own timestamp — which on a computer
    // that syncs is when the file ARRIVED. Stated in the reading itself, not
    // in a tooltip: this view has already had to promote two `title=` facts
    // into visible text for exactly this reason.
    const clock = eff.source === 'filesystem' ? 'file time' : null;
    const kind = cur.lastSaveKind || null;

    if (age) {
      // `+=`, NOT `=`. The "Working on" line is written into `primary` above
      // this branch, and a plain assignment here silently DELETED it — caught
      // by §18g the first time it ran, which is the whole argument for driving
      // the rendered output rather than reading the source.
      primary +=
        '<div class="mem-save-main">' +
          '<span class="mem-save-pip' + (step === null ? ' mem-save-pip-unknown' : ' mem-save-pip-s' + step) +
            '" aria-hidden="true"></span>' +
          renderReadout({
            label: 'Last saved',
            value: age,
            provenance: [prov, clock].filter(Boolean).join(' · ') || undefined,
          }) +
          // The badge is on the READING, not in a note underneath it. A
          // completeness caveat that lives below the figure is a caveat the
          // one-second glance never reaches.
          //
          // `clipped` gets the QUIET badge class (the one "shared mirror"
          // uses), not the attention one `trimmed` gets: nothing about the
          // handoff was lost, only a metadata field — most often the
          // one-line summary — was shortened to fit its own limit. Badging
          // that `incomplete` is the exact defect this verdict exists to
          // fix, so it must never share `trimmed`'s badge or its class.
          (kind === 'trimmed'
            ? '<span class="mem-badge mem-badge-attn">incomplete</span>'
            : kind === 'clipped'
              ? '<span class="mem-badge mem-badge-quiet">summary shortened</span>' : '') +
        '</div>';
    }

    if (kind === 'trimmed') {
      lines.push(saveLine('alertTriangle', 'loud',
        'Part of this handoff did not survive the save — content named in the note below was dropped '
        + 'or cut short before it was written, so what you are reading beneath is missing it. '
        + 'Ask the agent to save that content again. '
        + firstNote(cur.lastSaveNotes), true));
    } else if (kind === 'clipped') {
      // Deliberately NOT the 'loud' tone `trimmed` gets, and deliberately
      // avoids "missing" / "budget" / "save again" — each was part of the
      // false alarm this verdict replaces. See the real case recorded on
      // `classifySaveNotes`: a 244-char headline clipped to 200 chars, body
      // untouched, badged and worded as if content had been lost.
      lines.push(saveLine('', '',
        'The handoff itself was written in full. What got shortened is a label attached to the save '
        + '— most often its one-line summary — not the handoff’s content. That label matters because '
        + 'it is the only thing a future session sees before deciding whether to open this state. '
        + firstNote(cur.lastSaveNotes), true));
    } else if (kind === 'replaced') {
      lines.push(saveLine('alertTriangle', '',
        'That save deliberately replaced a larger handoff. Nothing the agent sent was lost, '
        + 'but the longer document it overwrote is not recoverable. ' + firstNote(cur.lastSaveNotes), true));
    }

    if (eff.source === 'filesystem') {
      lines.push(saveLine('alertTriangle', '',
        'No journal entry carried a save time for this handoff, so the reading above is the file’s own '
        + 'timestamp. On a computer that syncs, that is when the file arrived here, not when it was written.'));
    } else {
      // BOTH CLOCKS, when they genuinely disagree. Under two minutes they are
      // the same event to a human — a save's own write takes milliseconds — so
      // a gap larger than that means the file changed on this disk well after
      // the agent wrote it, which is what a pull looks like.
      const arrived = effectiveSave({ savedAt: cur.arrivedAt || cur.savedAt || cur.lastWriteAt });
      if (arrived.seconds !== null && eff.seconds !== null && eff.seconds - arrived.seconds > 120) {
        lines.push(saveLine('', '',
          'This file arrived on this computer ' + (formatAge(arrived.seconds) || 'recently')
          + ' — the reading above is the agent’s own clock, not the file’s.'));
      }
    }
  }

  // ── TWO HARNESSES, ONE HANDOFF FILE ─────────────────────────────────────
  // `state/<scope>/<machine>/` has no harness segment and `<machine>` is per
  // INSTALLATION, so two agent tools on one computer write the same
  // `current.md` and each save silently replaces the other's. The store
  // detects it from the append-only journal, which survives the collision
  // because every line carries `harness`. Named here because the remedy is the
  // user's — give each tool its own scope — and nothing else on this screen
  // would ever show it.
  for (const s of scopes.filter((x) => x && x.harnessShared === true).slice(0, 3)) {
    const who = (s.harnesses || []).slice(0, 4).map((h) => escapeHtml(h)).join(' and ');
    lines.push(saveLine('alertTriangle', 'loud',
      '<b>Two tools are writing <span class="mem-name">' + escapeHtml(s.scope) + '</span>.</b> '
      + (who ? who + ' have ' : 'They have ')
      + 'both saved into the same handoff file, and a save overwrites — so each one has replaced the '
      + 'other’s. The journal below keeps both trails. Give each tool its own scope and they stop colliding.',
      true));
  }

  // ── NEWER STATE SOMEWHERE ELSE IN THIS PROJECT ──────────────────────────
  const newest = newestPair(scopes);
  if (newest && cur) {
    const here = effectiveSave(cur).seconds;
    const there = effectiveSave(newest).seconds;
    const samePair = newest.scope === shownScope && newest.machine === shownMachine;
    if (!samePair && there !== null && (here === null || there < here - 60)) {
      lines.push(saveLine('', '',
        'Newer state in this project: <span class="mem-name">' + escapeHtml(newest.scope) + '</span>'
        + (newest.machine && newest.machine !== shownMachine
          ? ' on <span class="mem-name">' + escapeHtml(newest.machine) + '</span>' : '')
        + ' — ' + escapeHtml(formatAge(there) || 'unknown age') + '.', true));
    }
  }

  // ── "WHAT YOU ARE READING WAS WRITTEN SOMEWHERE ELSE" ───────────────────
  // This was a `from <machine>` badge and a note beside the machine picker.
  // The picker is gone; the FACT is not, and it is a real signal rather than
  // decoration: the next steps in the handoff below were observed on another
  // computer, so paths, running processes and local checkouts may not match
  // what is in front of you.
  //
  // POSITIVE EVIDENCE ONLY — an explicit `false`, never an absent field. An
  // older response that omits `machineIsThisMachine` must not be reported as
  // either answer. And it is a rendered LINE, not a `title=`: it used to be a
  // tooltip on a non-focusable span, so the one sentence explaining why the
  // steps below may not apply reached neither keyboard nor touch users.
  if (d && d.machineIsThisMachine === false) {
    lines.push(saveLine('', '',
      'Written on <span class="mem-name">' + escapeHtml(d.machine || 'another machine')
      + '</span> and synced here — local paths and processes may differ from what the handoff describes.',
      true));
  }

  // ── "ANOTHER COMPUTER SAVED AFTER THIS ONE" ─────────────────────────────
  // The menubar widget's `newerElsewhereNotice`, which a Windows or Linux user
  // has never had and which a Mac user only saw in the menu. It is a DIFFERENT
  // question from the "newer state in this project" line above: that one is
  // about a scope you are not watching on this machine, this one is about the
  // same work continuing somewhere else — the case where pulling first is the
  // right next move and starting to type is not. See newerOnAnotherMachine for
  // the rule, and why every clause of it is load-bearing.
  const elsewhere = newerOnAnotherMachine(scopes, d);
  if (elsewhere) {
    lines.push(saveLine('', '',
      '<span class="mem-name">' + escapeHtml(elsewhere.machine)
      + '</span> saved after this computer — <span class="mem-name">'
      + escapeHtml(elsewhere.scope) + '</span>, '
      + escapeHtml(formatAge(effectiveSave(elsewhere).seconds) || 'unknown age')
      + '. Pull before you continue, or that work will be waiting there.', true));
  }

  // ── THE STANDING BRIEF — always, and on its own terms ───────────────────
  if (read) {
    const briefAge = brief && brief.present
      ? formatAge(effectiveSave({ savedAt: brief.updatedAt }).seconds) : null;
    lines.push(saveLine('', 'brief',
      'Standing brief — ' + (brief && brief.present
        ? escapeHtml(briefAge || 'updated at an unknown time')
        : 'not written yet'), true));
  }

  if (!primary && !lines.length) return '';
  // NO `.mem-section` ANY MORE. This is the body of block ① now, not a
  // top-level sibling, so the page's adjacency rule must not put 24px between
  // it and the two notices beside it — `.mem-status-stack` in memory.css owns
  // the spacing INSIDE a block, and `.settings-job-block` owns the spacing
  // between blocks. One gap, one owner, at each level.
  return '<section class="mem-save" aria-label="Save status">' + primary + lines.join('') + '</section>';
}

/** The newest (scope, machine) in a project by the AGENT'S clock where it exists. */
function newestPair(scopes) {
  let best = null, bestAge = null;
  for (const s of scopes) {
    const age = effectiveSave(s).seconds;
    if (age === null) continue;
    if (bestAge === null || age < bestAge) { best = s; bestAge = age; }
  }
  return best;
}

/** The harness that wrote the handoff on screen, from the journal's newest entry. */
function harnessOf(d) {
  const j0 = d && d.journal && d.journal.entries && d.journal.entries.length ? d.journal.entries[0] : null;
  return (j0 && typeof j0.harness === 'string' && j0.harness) ? j0.harness : null;
}

/** The first of a save's disclosure notes, escaped, or nothing. */
function firstNote(notes) {
  const n = Array.isArray(notes) ? notes.find((x) => typeof x === 'string' && x) : null;
  return n ? escapeHtml(String(n)) : '';
}

/**
 * One qualifying line in the strip.
 *
 * `html` is opt-in and the CALLER owns escaping when it opts in — the same
 * contract renderDescription uses, and every interpolated value above goes
 * through escapeHtml at its own site.
 */
function saveLine(iconName, tone, text, html = false) {
  const cls = 'mem-save-line' + (tone === 'loud' ? ' mem-save-line-loud' : '')
    + (tone === 'brief' ? ' mem-save-line-brief' : '');
  return '<div class="' + cls + '">' + (iconName ? icon(iconName, 13) : '')
    + '<span>' + (html ? text : escapeHtml(text)) + '</span></div>';
}

/**
 * How many directory entries the store can SEE but will not address.
 *
 * `unlistedEntries` is the store's own count (splitAddressable in
 * working-state.js) and covers scope AND machine directories, so it is the
 * one number that answers "is there state here we are not showing you".
 * Absent on an older response, and absent from the scoped read — read
 * defensively and treat anything non-numeric as zero.
 */
function unlistedCount(read) {
  const n = read && read.unlistedEntries;
  return typeof n === 'number' && n > 0 ? n : 0;
}

/**
 * State that exists on disk and is deliberately not read.
 *
 * THE DEFECT THIS CLOSES. The store returns `unlistedEntries` and a
 * `unlistedReason` naming exactly which naming rule was broken and how to
 * undo it. This view read neither, and rendered "Nothing saved for this
 * project yet — No agent has written a handoff here" over a handoff sitting
 * on disk: a confident false negative, the worst shape this project has.
 *
 * The reason sentence is ECHOED from the store, never paraphrased. It is the
 * store that decides what a nameable entry is, so a second copy of that rule
 * written here would drift from the one actually enforced — and would then be
 * telling the user to perform a rename that does not fix anything.
 */
function renderUnlistedNote(read, d) {
  const n = unlistedCount(read);
  const machines = d && typeof d.unlistedMachines === 'number' && d.unlistedMachines > 0
    ? d.unlistedMachines : 0;
  if (!n && !machines) return '';

  const reason = (read && typeof read.unlistedReason === 'string' && read.unlistedReason)
    ? read.unlistedReason
    // Only reachable if the count arrives without the store's sentence. Says
    // the fact and stops, rather than inventing the naming rule.
    : n + ' director' + (n === 1 ? 'y entry is' : 'ies are') +
      ' not addressable by name. They are on disk and are NOT read.';

  const machineClause = machines
    ? ' Under the scope shown below, ' + machines + ' machine folder' +
      (machines === 1 ? ' is' : 's are') + ' also unreadable for the same reason.'
    : '';

  return (
    '<div class="mem-note mem-note-loud">' + icon('alertTriangle', 13) +
      '<span><b>Some state here is on disk but is not being read.</b> ' +
      escapeHtml(reason + machineClause) + '</span></div>'
  );
}

/**
 * A project carrying a standing brief but no handoff.
 *
 * The store hands us the sentence (`message`); this used to be dropped on the
 * floor. Rendered in the slot the handoff itself would occupy, so the missing
 * thing is missing in the place you looked for it.
 */
function renderBriefOnlyNotice(read, unlisted) {
  const msg = (read && typeof read.message === 'string' && read.message)
    ? read.message
    : 'No session state saved for this project yet — only the project brief.';
  return (
    '<div class="mem-doc-card mem-doc-empty mem-section">' +
      '<div class="mem-doc-empty-title">No handoff saved yet</div>' +
      // `msg` is the STORE's own sentence and is escaped by renderDescription's
      // default path — this call deliberately does not opt into raw HTML.
      renderDescription(msg +
        (unlisted ? '' :
          ' The brief below is what every agent read returns. A handoff appears here the first time ' +
          'an agent saves its working state at the end of a session.')) +
    '</div>'
  );
}

/**
 * @param unlistedEntries  the store's count, or nothing.
 *   scripts/test-next-memory-view.js calls this with NO argument, so absent
 *   must mean zero and must reproduce the original wording exactly.
 */
function renderEmptyProject(unlistedEntries) {
  const unlisted = typeof unlistedEntries === 'number' && unlistedEntries > 0 ? unlistedEntries : 0;

  // WHY THIS BRANCHES, and why the advice changes with it.
  //
  // With an unaddressable entry present, "No agent has written a handoff
  // here" is false — one may well have, under a name this module will not
  // resolve. The original advice was worse than the wrong sentence: a save
  // lands on the SLUGGED path, so asking an agent to save does not recover
  // the existing handoff, it strands it permanently under a name nothing
  // will read again. Renaming is the only move that gets the content back.
  if (unlisted) {
    return (
      '<div class="empty-card mem-section">' +
        '<div class="empty-title">Nothing readable for this project yet</div>' +
        renderDescription('No handoff could be read here — but this project’s ' +
          '<span class="mono">state/</span> folder is not empty, and the note above says why. ' +
          'Rename those entries so they can be read. Do not save over them: a new save is written under a ' +
          'different, generated name and would leave what is already there stranded.', { html: true }) +
      '</div>'
    );
  }

  return (
    '<div class="empty-card mem-section">' +
      '<div class="empty-title">Nothing saved for this project yet</div>' +
      // `html: true`, so the project name is escaped HERE, explicitly, rather
      // than relying on the component: opting into raw HTML moves that duty to
      // the caller and this is the one interpolated value in the sentence.
      renderDescription('No agent has written a handoff here. Ask an agent connected through ' +
        '<span class="mono">my-curator</span> to save its working state for ' +
        '<span class="mem-name">' + escapeHtml(state.activeProject) +
        '</span> at the end of a session, and it will show up here.', { html: true }) +
    '</div>'
  );
}

/**
 * The table's row order: the SAME clock the row shows, youngest first.
 *
 * ── THE MARK, THE WORD AND THE ORDER ARE ONE READING ─────────────────────
 * The store's `listWorkingScopes` sorts by `mtimeMs` — the FILE clock — and
 * that is correct for what it serves: the tray and the index consume that
 * order and it is NOT changed here. But every cell this table paints reads
 * through `effectiveSave`, which prefers the AGENT'S clock (`writtenAt`) and
 * falls back to the file's only when there is no journal time at all. On any
 * machine where the two disagree — every synced one, because a checkout
 * rewrites mtime, and any folder that was copied — the table was claiming
 * "newest first" while a handoff saved four hours ago sat beneath rows a
 * fortnight old. v3.55.0 put the freshness DOT and the age WORDS in lockstep
 * on `effectiveSave`; the ORDER was left on the other clock, so a row could
 * be marked fresh, worded fresh, and ranked stale, all at once.
 *
 * ── WHY IT TAKES A COPY ──────────────────────────────────────────────────
 * `state.projectRead.scopes` is the fetched response, read by `newestPair`,
 * by `newerOnAnotherMachine`, by `workStreamCounts`, and — critically — by
 * the `scopes[0]` pick in `selectProject`/`reloadActive`, which stands in for
 * the route's own `scope=latest` and must keep resolving to the same pair the
 * SERVER would. Sorting in place would silently move that pick to a different
 * definition of "latest" than the route's. This returns a new array and the
 * response is left exactly as it arrived.
 *
 * NO AGE SORTS LAST, never first. `effectiveSave` returns `null` when it can
 * resolve neither clock, and `null` is an ABSENCE of a reading, not an age of
 * zero — the fact-and-absence collapse this view exists to refuse. Such a row
 * shows "unknown" and belongs at the end, not at the head of a list whose
 * promise is "newest first".
 *
 * Ties break on `scope` then `machine` so the order is TOTAL: two copies at
 * the same age must not swap places between two paints, which would repaint
 * the pane on every poll (screenSignature folds this order in) and move a row
 * under the pointer for no reason.
 */
function workStreamOrder(scopes, now = Date.now()) {
  const rows = Array.isArray(scopes) ? scopes.filter(Boolean) : [];
  // Decorate once. `effectiveSave` reads the clock per call, so computing the
  // key inside the comparator would let `now` advance mid-sort — a comparator
  // that is not self-consistent is undefined behaviour, not a slow one.
  const byName = (a, b) => (
    String(a.scope || '') < String(b.scope || '') ? -1
      : String(a.scope || '') > String(b.scope || '') ? 1
        : String(a.machine || '') < String(b.machine || '') ? -1
          : String(a.machine || '') > String(b.machine || '') ? 1 : 0);
  return rows
    .map((s, i) => ({ s, i, age: effectiveSave(s, now).seconds }))
    .sort((a, b) => {
      if (a.age === null && b.age !== null) return 1;
      if (b.age === null && a.age !== null) return -1;
      if (a.age !== b.age) return a.age - b.age;
      return byName(a.s, b.s) || a.i - b.i;
    })
    .map((x) => x.s);
}

/**
 * THE WORK-STREAMS TABLE — the widget's grouped rows, brought into the app.
 *
 * ── WHAT IT REPLACES, AND WHY A TABLE IS NOT A BIGGER DROPDOWN ───────────
 * This was a scope listbox beside a machine listbox. The maintainer's verdict
 * on that screen was that work-streams were hard to FIND, and the mechanism is
 * worth naming: a picker answers "which one am I looking at" and structurally
 * cannot answer "what have I got, and which of them moved today" — you open
 * it, read it, close it, and carry the list in your head. Every fact the store
 * already computes for each pair (a headline, an age, a machine, a harness)
 * was fetched on every read and shown to nobody; `scopes[].headline` had NEVER
 * been read by this view at all.
 *
 * The menubar widget has rendered exactly these rows since v3.37.0. This is
 * the first time a Windows or Linux user can see them.
 *
 * ── ONE ROW PER (SCOPE, MACHINE) PAIR, NEWEST FIRST ──────────────────────
 * Newest by `workStreamOrder` — the clock each row DISPLAYS — and they are
 * NOT collapsed by scope here. `main` on the laptop and `main` on the desktop
 * are two handoffs, two ages and two different pieces of work in flight;
 * merging them would hide the exact case the per-machine layout exists for. The count line below the table
 * says both numbers — work-streams and saved copies — so the distinction is
 * stated rather than left to be inferred from row arithmetic.
 *
 * ── THE FIRST CELL IS THE CONTROL ────────────────────────────────────────
 * A real <button>, so the row is reachable by keyboard and announces itself;
 * the freshness dot rides inside it so the marks form a column down the left
 * edge without costing a cell of their own. Only the OPEN row carries an id
 * (`mem-ws-active`), because ids must be unique and a scope slug is not a safe
 * id fragment — see FOCUSABLE_IDS for how a click still restores focus.
 *
 * ── NO TOOLTIPS ──────────────────────────────────────────────────────────
 * The exact stamp behind a humanised age rides in a `.visually-hidden` span,
 * not a `title=`. v3.20.0 counted eleven facts in this app reachable only by
 * hover, and a table of them would have been the twelfth through the
 * seventeenth; both `title=` ratchets over this file stay where they are.
 *
 * A SIBLING of every <details> on the page, exactly as the pickers were — the
 * <summary> hazard in this file's header is unaffected.
 */
function renderWorkStreams(scopes, open) {
  const rows = workStreamOrder(scopes);
  if (!rows.length) return '';
  const openScope = (open && open.scope) || null;
  const openMachine = (open && open.machine) || null;
  // POSITIVE EVIDENCE ONLY. The scoped response carries `machineIsThisMachine`
  // for the machine it RESOLVED and says nothing at all about any other, so
  // with no explicit `true` no row is marked.
  //
  // With one, EVERY row in that machine's folder is marked, and that is a fact
  // rather than an inference: `<machine>` is one installation's folder name,
  // so if the read identified `mac-studio-a1b2` as this installation then every
  // pair under `mac-studio-a1b2` is on this computer. What is never done is the
  // other direction — guessing from a name that merely looks similar, which is
  // the fact-and-absence collapse this view exists to refuse (and the D9 case
  // working-state.js records, where a folder can share a hostname and belong to
  // a different installation).
  const mineMachine = open && open.machineIsThisMachine === true ? open.machine : null;

  const body = rows.map((s) => {
    const eff = effectiveSave(s);
    const tier = freshnessTier(eff.seconds);
    const age = formatAge(eff.seconds);
    const isOpen = s.scope === openScope && (s.machine || null) === (openMachine || null);
    const mine = !!(mineMachine && s.machine === mineMachine);
    const who = [s.harness, s.model].filter(Boolean).map((x) => escapeHtml(x)).join(' · ');
    return (
      '<tr class="mem-ws-row' + (isOpen ? ' mem-ws-row-open' : '') + '"' +
        (isOpen ? ' aria-current="true"' : '') + '>' +
        '<td class="mem-ws-cell-name">' +
          '<button type="button" class="mem-ws-open"' +
            (isOpen ? ' id="mem-ws-active"' : '') +
            ' data-mem-scope="' + escapeHtml(s.scope) + '"' +
            ' data-mem-machine="' + escapeHtml(s.machine || '') + '">' +
            '<span class="fresh-dot fresh-' + tier + '" aria-hidden="true"></span>' +
            '<span class="mem-ws-slug">' + escapeHtml(s.scope) + '</span>' +
          '</button>' +
        '</td>' +
        '<td class="mem-ws-cell-head"><span class="mem-ws-headline">' +
          escapeHtml(s.headline || '—') + '</span></td>' +
        // `data-mem-age-at` is emitted ONLY when there is a resolved stamp AND
        // words to recount — tickAges rewrites `.mem-age-words` inside it. An
        // unknown age has nothing to move and gets no hook, exactly as the
        // handoff summary's does not.
        '<td class="mem-ws-cell-age"' +
          (age && eff.at ? ' data-mem-age-at="' + escapeHtml(eff.at) + '"' : '') + '>' +
          '<span class="mem-age-words">' + escapeHtml(age || 'unknown') + '</span>' +
          (eff.at
            ? '<span class="visually-hidden"> (' + escapeHtml(eff.at) +
              (eff.source === 'filesystem' ? ', file time' : '') + ')</span>'
            : '') +
        '</td>' +
        '<td class="mem-ws-cell-machine">' +
          '<span class="mem-ws-machine">' + escapeHtml(s.machine || '—') + '</span>' +
          (mine ? '<span class="mem-ws-mine">this machine</span>' : '') +
        '</td>' +
        '<td class="mem-ws-cell-who">' + (who || '—') + '</td>' +
      '</tr>'
    );
  }).join('');

  return (
    '<div class="mem-ws-wrap">' +
      '<table class="mem-ws-table">' +
        '<thead><tr>' +
          '<th scope="col">Work-stream</th>' +
          '<th scope="col">Working on</th>' +
          '<th scope="col">Last saved</th>' +
          '<th scope="col">Machine</th>' +
          '<th scope="col">Harness</th>' +
        '</tr></thead>' +
        '<tbody>' + body + '</tbody>' +
      '</table>' +
    '</div>'
  );
}

/**
 * "N work-streams · M saved copies", plus whatever the store could not show.
 *
 * TWO NUMBERS, BECAUSE THEY ARE TWO FACTS and the table's row count is
 * neither of them on a capped read. `savedCopies` is the store's UNCAPPED
 * pair total and `distinctScopeCount` its uncapped work-stream count; the
 * route's own header records that `scopeCount` means DIFFERENT quantities on
 * the two endpoints, which is exactly why neither is read here.
 *
 * Deriving either from `scopes.length` would report a CAP as a measurement —
 * the collapse `distinctScopeCount` was added to undo.
 */
function workStreamCounts(read, shown) {
  if (!read) return '';
  const pairs = typeof read.savedCopies === 'number' ? read.savedCopies : shown;
  const streams = typeof read.distinctScopeCount === 'number' ? read.distinctScopeCount : null;
  const parts = [];
  if (streams !== null) parts.push(streams + ' work-stream' + (streams === 1 ? '' : 's'));
  parts.push(pairs + ' saved cop' + (pairs === 1 ? 'y' : 'ies'));
  const truncated = read.scopesTruncated
    ? ' · showing the ' + shown + ' most recently saved'
    : '';
  return '<div class="mem-ws-count">' + escapeHtml(parts.join(' · ') + truncated) + '</div>';
}

/**
 * "Somebody else's computer saved after yours."
 *
 * THE TRAY'S READING, DERIVED THE TRAY'S WAY — see `newerElsewhereNotice` in
 * desktop/lib/tray-model.js, whose rule this reproduces. It is NOT imported:
 * `desktop/` and `src/` may not import each other (one ships inside an Electron
 * main process, the other is served to a browser), so the RULE is copied and
 * the copy is tested behaviourally rather than by byte-identity.
 *
 * THE RULE, and every clause of it is load-bearing:
 *   · AGENT CLOCKS ONLY. A filesystem age is the moment a file ARRIVED here,
 *     which on a synced folder is the moment of the pull — comparing one
 *     machine's pull time against another's save time would manufacture this
 *     notice out of sync traffic.
 *   · THE SPLIT NEEDS POSITIVE EVIDENCE. Only the scoped read says which
 *     machine is this installation (`machineIsThisMachine`), so with no such
 *     evidence there is no local side and nothing is claimed.
 *   · BOTH SIDES MUST EXIST. One machine cannot have saved after itself.
 *   · STRICTLY NEWER. A tie is not news.
 *
 * Returns the winning row, or null. The caller owns the sentence.
 */
function newerOnAnotherMachine(scopes, d) {
  if (!d || d.machineIsThisMachine !== true || !d.machine) return null;
  const rows = (Array.isArray(scopes) ? scopes : [])
    .filter((s) => s && effectiveSave(s).source === 'agent');
  const local = rows.filter((s) => s.machine === d.machine);
  const foreign = rows.filter((s) => s.machine !== d.machine);
  if (!local.length || !foreign.length) return null;
  const newestLocal = Math.min(...local.map((s) => effectiveSave(s).seconds));
  const best = foreign.reduce(
    (a, b) => (effectiveSave(b).seconds < effectiveSave(a).seconds ? b : a));
  return effectiveSave(best).seconds < newestLocal ? best : null;
}

/**
 * THE HANDOFF — the answer this screen exists to give, and now an instrument.
 *
 * ── A FOLD, LIKE THE OTHER TWO ────────────────────────────────────
 * It was the one card on this page that could not be collapsed, so a page with
 * a long handoff was a page you scrolled past to reach the brief and the
 * journal. It is a native <details> now — same `.mem-fold` family, same
 * delegated `toggle` listener, same remembered-open bookkeeping — and it
 * OPENS BY DEFAULT: `state.openFolds.handoff === undefined` means the user has
 * expressed no opinion, and the default for the answer to the question is to
 * show it. Once they close it, it stays closed, exactly as renderBrief does.
 *
 * ── THE LEADER ─────────────────────────────────────────────
 * Three folds that look identical are three folds you have to read to rank.
 * `.mem-fold-lead` gives this one a 3px accent rule, the full --border and one
 * step of elevation; the brief and the journal keep --border-subtle and no
 * shadow. One row is marked out of three, which is the v3.16.1 rule: a flag on
 * every row carries nothing.
 *
 * ── THE WIDGET'S READINGS, ON THE WEB ────────────────────────────
 * The menubar widget carries two things this screen did not: a freshness
 * COLOUR and an age that MOVES. Every non-Mac user has neither. So the summary
 * carries the same `.mem-save-pip` the save strip does — the SAME class, from
 * the SAME freshnessStep(effectiveSave(…).seconds), never a second ladder (the
 * tray's own 120 / 1800 / 43200 bands would desync the mark from the word) —
 * and the age words tick once a second (see tickAges).
 *
 * ONE VOCABULARY, TWO PLACEMENTS. The strip above still answers "am I saved?"
 * for the whole project; this answers it for the document you are about to
 * read, and both are rendered from effectiveSave, so they cannot name two
 * different times for one save.
 *
 * ── NO CONTROL IN THE <summary> ────────────────────────────────
 * The v3.0.1-beta.18 hazard this view's header block records: an interactive
 * control inside a <summary> toggles its own section when clicked. Everything
 * in this summary is a <span> or a <div> — no button, no select, no input, no
 * link — so there is no propagation path for a later edit to forget to stop.
 */
function renderHandoff() {
  const d = state.detail;
  if (state.detailLoading) {
    return '<div class="mem-doc-card">' + gatedLoader(loadGate, 'Reading handoff…') + '</div>';
  }
  if (!d) return '';
  if (!d.current || !d.current.present) {
    return (
      '<div class="mem-doc-card mem-doc-empty">' +
        '<div class="mem-doc-empty-title">No handoff under this scope yet</div>' +
        renderDescription(d.message || 'Nothing has been saved here.') +
      '</div>'
    );
  }

  // Through effectiveSave, exactly as the strip above does, so the document's
  // own byline and the freshness reading at the top of the pane are ONE
  // measurement rendered twice rather than two that can disagree.
  const savedWhen = effectiveSave(d.current);
  const savedAge = formatAge(savedWhen.seconds);
  const step = freshnessStep(savedWhen.seconds);
  // WHEN this was saved and WHO saved it are one measurement. renderReadout is
  // the instrument role: the figure is mono at full --text, the provenance
  // steps back by SIZE and FAMILY rather than by dropping under the contrast
  // floor.
  //
  // ABSENT IS NOT ZERO, and this is the case that proves it: with no savedAt
  // and no journal entry there is no reading, so nothing renders — never
  // "unknown", never a dash. Each fact is still shown when only the other is
  // missing, so consolidating the two elements cannot drop one of them.
  const savedValue = savedAge || d.current.savedAt || null;
  // Harness and model come from the journal's newest entry — STRUCTURED
  // fields, never scraped out of the document's prose provenance line. A
  // parser over that sentence would break the first time its wording moved.
  const j0 = d.journal && d.journal.entries && d.journal.entries.length ? d.journal.entries[0] : null;
  const who = j0 ? [j0.harness, j0.model].filter(Boolean).join(' · ') : '';
  // "· updates live" IS A CLAIM, AND IT IS ONLY MADE WHEN IT IS TRUE. It is
  // appended off `state.ageTickerArmed`, which onEnter writes only after the
  // interval really exists — not off the presence of the attribute, which
  // would be this view asserting its own intent rather than reporting a fact.
  // It is also withheld when the reading is a raw ISO stamp rather than an age
  // (the savedAge-less fallback below), because that string does not tick.
  const live = savedAge && state.ageTickerArmed ? '· updates live' : '';
  const prov = [who, live].filter(Boolean).join(' ');
  const readout = savedValue
    ? renderReadout({ label: 'Saved', value: savedValue, provenance: prov || undefined })
    : (who ? renderReadout({ label: 'Written by', value: who }) : '');
  // The exact ISO stamp stays reachable on hover, which formatAge's own
  // docblock relies on when it rounds to "2 hr ago". A wrapper carries it
  // because a readout states a reading and takes no tooltip of its own.
  // When the two clocks are both known the tooltip names BOTH, because that is
  // the one place the exact pair is worth having; when only the file's time is
  // known it carries that alone, unqualified, exactly as it always did.
  const stampTitle = savedWhen.source === 'agent' && savedWhen.at
    ? 'Saved ' + savedWhen.at + (d.current.arrivedAt ? ' · arrived here ' + d.current.arrivedAt : '')
    : (d.current.savedAt || null);
  // `data-mem-age-at` is the clock's only hook, and it is emitted ONLY when
  // there is an age to move: an ISO-stamp fallback has no seconds to recount,
  // and a reading with no time at all has nothing. tickAges skips an
  // unparseable stamp too, so a bad value freezes rather than printing junk.
  const ageAttr = savedAge && savedWhen.at
    ? ' data-mem-age-at="' + escapeHtml(savedWhen.at) + '"' : '';
  const stamp = readout
    ? '<span class="mem-doc-stamp"' + ageAttr +
      (stampTitle ? ' title="' + escapeHtml(stampTitle) + '"' : '') + '>' + readout + '</span>'
    : '';

  const notes = [];
  if (d.current.truncated) {
    notes.push('This handoff was longer than the state budget — the tail is not shown. ' +
      'The file on disk is complete up to that budget; nothing below it was ever written.');
  }
  if (d.current.sanitisedOnRead) {
    notes.push('Protocol-shaped text in this file was neutralised on read (it can arrive over sync from another ' +
      'machine, or from another person inside a shared mirror). The words are unchanged; only their markup is.');
  }
  const noteHtml = notes.length
    ? notes.map((n) => '<div class="mem-note">' + icon('alertTriangle', 13) + '<span>' + escapeHtml(n) + '</span></div>').join('')
    : '';

  const { headline, body } = splitHandoffPreamble(d.current.text || '');

  // The user's own toggle wins; `undefined` (never touched) opens. Same rule
  // and the same shape as renderBrief, so the three folds behave alike.
  const remembered = state.openFolds ? state.openFolds.handoff : undefined;
  const foldAttr = (remembered === undefined ? true : !!remembered) ? ' open' : '';

  // renderMarkdown (shared/markdown.js) HTML-escapes the whole string before
  // emitting any markup — the escape-first invariant that module's own suite
  // pins. State text is untrusted (syncs from other machines; inside a
  // shared-* mirror it can be another person's), so it must never reach the
  // DOM any other way.
  return (
    // `.mem-section` is gone: the FOLD is the body of block ③ now and the
    // block owns its own spacing. The fold itself stays — the maintainer asked
    // to be able to collapse a fifteen-hundred-word handoff, and the block head
    // above it is a heading rather than a second disclosure.
    '<details class="mem-fold mem-fold-lead" data-mem-fold="handoff"' + foldAttr + '>' +
      '<summary class="mem-fold-summary mem-fold-summary-lead" id="mem-fold-handoff">' +
        icon('chevronRight', 14) +
        '<span class="cur-eyebrow">CURRENT HANDOFF</span>' +
        '<span class="mem-save-pip' +
          (step === null ? ' mem-save-pip-unknown' : ' mem-save-pip-s' + step) +
          '" aria-hidden="true"></span>' +
        // NO READING IS STILL A READING TO REPORT. With neither an age nor a
        // provenance the summary says so in words rather than showing a bare
        // eyebrow beside a dashed ring nobody can decode.
        (stamp || '<span class="mem-fold-meta">time unknown</span>') +
      '</summary>' +
      '<div class="mem-fold-body">' +
        (headline ? '<div class="mem-doc-headline">' + escapeHtml(headline) + '</div>' : '') +
        noteHtml +
        '<div class="mem-doc">' + renderMarkdown(body) + '</div>' +
      '</div>' +
    '</details>'
  );
}

/**
 * HOW BIG THE DRAFT IS, in the two units that matter.
 *
 * BYTES ARE THE WALL. src/routes/memory.js refuses a longer brief with 400
 * `brief_too_large`, and it measures UTF-8 bytes — so a brief full of
 * em-dashes, arrows and accented names runs out sooner than its character
 * count suggests. A counter that said "31,900 characters" while the route was
 * about to refuse 33,100 bytes would be wrong in the one direction that costs
 * the user the text they just wrote.
 *
 * WORDS ARE THE UNIT A WRITER THINKS IN, and they are the reason both are
 * shown: "24,000 of 32,768 bytes" answers "will this save?", "410 words"
 * answers "is this a brief or a novel?". Neither substitutes for the other.
 *
 * `TextEncoder` is the measurement the route uses and is available in every
 * browser this app supports and in Node; there is deliberately no fallback to
 * `.length`, because a silent fallback would report the wrong unit under the
 * same label.
 */
function briefStats(text) {
  const s = typeof text === 'string' ? text : '';
  const bytes = new TextEncoder().encode(s).length;
  const words = s.trim() ? s.trim().split(/\s+/).length : 0;
  return { bytes, words, over: bytes > BRIEF_MAX_BYTES };
}

/**
 * WHAT ESCAPE SHOULD DO, as a value rather than as a branch.
 *
 * Three answers, and the shape is views/shared-brain-wizard.js's
 * `dismissDecision` — the same question was answered there for a wizard that
 * can be mid-flight, and giving it one name in both places means the next
 * reader learns the vocabulary once.
 *
 *   'blocked' — a save is in flight. Closing now would leave the user with no
 *               idea whether their text reached disk, and the reply cannot be
 *               cancelled. Escape does nothing and the editor says why.
 *   'confirm' — the draft differs from what was loaded. Escape must NOT throw
 *               that away silently: it raises an inline Discard / Keep editing
 *               bar, in flow, rather than a modal, because the text the user
 *               would lose has to stay visible while they decide.
 *   'close'   — nothing has changed. Escape closes, which is what Escape means.
 *
 * Pure, and takes the edit record rather than reading `state`, so the three
 * answers can be driven directly.
 */
function briefDismissDecision(e) {
  if (!e) return 'close';
  if (e.busy) return 'blocked';
  return (e.text || '') !== (e.loaded || '') ? 'confirm' : 'close';
}

/**
 * The standing-brief EDITOR. Empty unless the user has opened it.
 *
 * ── IT IS NO LONGER INSIDE A <details>, AND THAT REMOVES THE HAZARD RATHER
 *    THAN GUARDING IT ───────────────────────────────────────────────────────
 * The brief used to be a fold whose <summary> said "Standing brief" and whose
 * body held the editor, with a standing note that a control must never go in
 * the summary (the v3.0.1-beta.18 hazard). The block's head IS the heading
 * now, so there is no <summary> on this section at all: the hazard is not
 * suppressed, it is inexpressible. The pencil that opens this editor sits in
 * the block body's own toolbar row, which is an ordinary <div>.
 *
 * ── WHY THE EDITOR IS WORTH THE SPACE ────────────────────────────────────
 * "Edit brief" was a button UNDER the rendered brief, so on a brief of any
 * length the way to change it was below the thing you were reading — which is
 * the maintainer's report that it was "buried". A pencil beside the title is
 * where every document surface puts it.
 *
 * Read-only mirrors get NO editor and NO pencil: the backend refuses the write
 * (403), and offering a control whose only outcome is a refusal is worse than
 * not offering it.
 */
function renderBriefEditor(read, readonly) {
  const e = state.briefEdit;
  if (readonly || !e) return '';
  const stats = briefStats(e.text || '');
  const dirty = (e.text || '') !== (e.loaded || '');

  // THE WALL, STATED BEFORE IT IS HIT. Over budget the route answers 400 and
  // the draft would survive in the box — but a refusal the user could have
  // seen coming is a refusal that should not have been offered, so Save is
  // disabled and the reason is printed beside the figure rather than behind a
  // request.
  // ── IT IS A COUNTER, AND A COUNTER HAS TO COUNT ─────────────────────────
  // Every part of this line is addressable by a `data-brief-stat` hook, and
  // the wall below is emitted ALWAYS and merely `hidden`, because the input
  // handler updates both WITHOUT a render — a render here would rebuild the
  // textarea and take the caret and the selection with it (the same reason
  // views/domains.js's lifecycle form writes straight to state).
  //
  // FOUND BY TYPING INTO IT. The first draft rendered these figures once, on
  // open, and then never again: the counter read "916 of 32768 bytes" while
  // the draft grew past the wall, and the refusal only appeared after a save
  // the user could no longer make. A figure that has quietly stopped being
  // true is the exact class `effectiveSave` and `tickAges` exist for, and it
  // is worse here than a missing counter would be.
  const statusLine =
    '<div class="mem-brief-stats' + (stats.over ? ' mem-brief-stats-over' : '') + '" id="mem-brief-stats">' +
      '<span data-brief-stat="dirty">' + (dirty ? 'modified' : 'unchanged') + '</span>' +
      '<span data-brief-stat="words">' + escapeHtml(String(stats.words)) +
        ' word' + (stats.words === 1 ? '' : 's') + '</span>' +
      '<span data-brief-stat="bytes">' + escapeHtml(String(stats.bytes)) + ' of ' +
        escapeHtml(String(BRIEF_MAX_BYTES)) + ' bytes</span>' +
    '</div>' +
    '<div class="mem-note mem-note-loud" id="mem-brief-over"' + (stats.over ? '' : ' hidden') + '>' +
      icon('alertTriangle', 13) +
      '<span><b>Too long to save.</b> The standing brief is capped at ' +
      escapeHtml(String(BRIEF_MAX_BYTES)) + ' bytes — the count above is this draft. ' +
      'Shorten it, or move the detail into a wiki page and point at it from here.</span></div>';

  // THE UNSAVED-DRAFT BAR. Raised by Escape (see briefDismissDecision), never
  // by a timer and never by the poll, and it is INLINE rather than a modal so
  // the text under discussion stays on screen while the user decides.
  const discardBar = e.confirmDiscard
    ? '<div class="mem-brief-discard" role="alertdialog" aria-label="Unsaved changes">' +
        '<span>You have unsaved changes to this brief.</span>' +
        '<button type="button" class="btn btn-ghost btn-xs" id="mem-brief-discard">Discard</button>' +
        '<button type="button" class="btn btn-secondary btn-xs" id="mem-brief-keep">Keep editing</button>' +
      '</div>'
    : '';

  // PREVIEW SWAPS THE FIELD, IT DOES NOT SIT BESIDE IT. Two copies of one
  // document on screen at once, one of them stale the moment a key is pressed,
  // is the same trade this file already refused for the rendered brief while
  // the editor is up. The draft lives in `state.briefEdit.text`, so toggling
  // back restores it byte for byte — nothing is read out of the DOM.
  const field = e.preview
    ? '<div class="mem-doc mem-brief-preview" aria-label="Brief preview">' +
        renderMarkdown(splitHandoffPreamble(e.text || '').body) + '</div>'
    : '<textarea class="mem-brief-text" id="mem-brief-text" rows="18" spellcheck="true"' +
        (e.busy ? ' disabled' : '') + '>' + escapeHtml(e.text || '') + '</textarea>';

  return (
    '<div class="mem-brief-editor">' +
      (e.error ? renderStatus({ state: 'danger', title: 'Not saved', detail: e.error }) : '') +
      '<label class="mem-brief-label cur-eyebrow" for="mem-brief-text">Standing brief (Markdown)</label>' +
      field +
      statusLine +
      discardBar +
      '<div class="mem-brief-buttons">' +
        // THE BLOCK'S ONE COMMIT. shell.css's taxonomy allows at most one
        // primary per card or panel, and this is it; Preview only changes what
        // is displayed and Cancel leaves, so both sit below it.
        '<button type="button" class="btn btn-primary" id="mem-brief-save"' +
          (e.busy || stats.over ? ' disabled' : '') + '>' +
          (e.busy ? 'Saving…' : 'Save brief') + '</button>' +
        '<button type="button" class="btn btn-secondary btn-xs" id="mem-brief-preview"' +
          (e.busy ? ' disabled' : '') + '>' +
          (e.preview ? 'Back to editing' : 'Preview') + '</button>' +
        '<button type="button" class="btn btn-ghost" id="mem-brief-cancel"' +
          (e.busy ? ' disabled' : '') + '>Cancel</button>' +
      '</div>' +
      renderDescription('The standing brief is yours to write — agents read it, they do not own it. '
        + 'Saving replaces the whole document, so send the complete brief rather than an addition.') +
    '</div>'
  );
}

/**
 * A starting brief, offered when there is nothing to edit yet.
 *
 * The four headings are the ones the store renders and every agent read
 * returns, and the closing line says out loud that they are a starting
 * point rather than a schema — a brief with a "Roadmap" or a "How I want you
 * to work" section is a real brief, and nothing here rewrites it into these
 * four.
 */
export const BRIEF_TEMPLATE = [
  '## Standing brief',
  '',
  'What this project is, and what "done" looks like.',
  '',
  '## Firm decisions — do not re-litigate',
  '',
  '- ',
  '',
  '## Working model',
  '',
  'How the pieces fit together, in a paragraph.',
  '',
  '## Pointers to depth',
  '',
  '- ',
  '',
  '<!-- Add any headings you like — these four are a starting point, not a schema. -->',
  '',
].join('\n');

/**
 * BLOCK ④'s BODY — the standing brief, at the column's width, with a pencil.
 *
 * ── WHAT CHANGED, AND WHY EVERY PART OF IT WAS ASKED FOR ─────────────────
 * It was a collapsed <details> whose body capped the rendered markdown at the
 * prose measure and whose only way in was an "Edit brief" button BELOW that
 * markdown. Three complaints in one element: the section was a fold competing
 * with two other folds, the document stopped at roughly 47% of the column
 * while the journal beside it ran full width, and the edit affordance was
 * under the thing it edits.
 *
 * Now: a block head that is a heading, a toolbar row carrying the pencil and
 * the brief's own age, and the document at the column's width. `.mem-doc`'s
 * measure cap is gone from the stylesheet — see memory.css, where the reversal
 * is recorded against the rule it reverses.
 *
 * THE PENCIL IS NOT `icon('pencil')`: app.js's ICON_BODY has no such entry and
 * `icon()` renders a loud placeholder for a name it does not know rather than
 * guessing (v3.9.0), so inventing one would ship a broken glyph. It follows
 * the kit's own geometry exactly — 24-unit viewBox, `fill: none`,
 * `currentColor` stroke, width 1.7, round caps — so it reads as a member of
 * the same set, and it carries an `aria-label` because a glyph-only button
 * has no accessible name of its own.
 */
function renderBrief(read) {
  const readonly = !!(state.detail && state.detail.readonly) || !!(read && read.readonly);
  const has = !!(read && read.brief && read.brief.present);
  const b = has ? read.brief : null;
  const editing = !!state.briefEdit;
  const age = b && b.updatedAt
    ? formatAge(Math.max(0, Math.round((Date.now() - Date.parse(b.updatedAt)) / 1000)))
    : null;

  const pencil = readonly ? '' :
    '<button type="button" class="btn btn-ghost btn-xs mem-brief-edit" id="mem-brief-edit"' +
      ' aria-label="' + (has ? 'Edit standing brief' : 'Write a standing brief') + '">' +
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3z"/><path d="M14.5 6.5l3 3"/></svg>' +
      '<span>' + (has ? 'Edit' : 'Write a brief') + '</span>' +
    '</button>';

  // THE AGE, AND DELIBERATELY NO PIP. The brief changes on the order of weeks;
  // an old brief is not a stale one, and marking it the way a handoff is
  // marked would state something false. Same call the save strip makes for the
  // same fact, one block up.
  const toolbar =
    '<div class="mem-block-toolbar">' +
      '<span class="mem-brief-age">' +
        (has ? escapeHtml(age ? 'Updated ' + age : 'Updated at an unknown time')
          : 'Not written yet') + '</span>' +
      pencil +
    '</div>';

  if (editing) return toolbar + renderBriefEditor(read, readonly);

  if (!has) {
    return toolbar +
      renderDescription('No standing brief for this project. It is the part that rarely changes — the goal, '
        + 'the firm decisions, the working model — and every agent read returns it, so it is worth writing once.');
  }

  return (
    toolbar +
    (b.truncated ? '<div class="mem-note">' + icon('alertTriangle', 13) +
      '<span>Longer than the brief budget — the tail is not shown.</span></div>' : '') +
    // Same preamble strip as the handoff: the block head already says
    // "Standing brief" and the toolbar says when it was updated, so the
    // document's own title and `_Updated: …_` line are duplicate chrome here.
    '<div class="mem-doc">' + renderMarkdown(splitHandoffPreamble(b.text || '').body) + '</div>'
  );
}

function renderJournal() {
  const d = state.detail;
  if (!d || !d.journal) return '';
  const j = d.journal;
  // Re-emitted on every render, or the fold shuts itself the moment its own
  // "Show more" button re-renders the pane. Declared inline rather than via a
  // shared helper: scripts/test-next-memory-view.js lifts this function by
  // brace-matching and executes it with a fixed set of injected collaborators,
  // so a module-level helper called from here would be a ReferenceError there
  // (the v3.11.0 hardcoded-function-list blind spot).
  // ── THE SUMMARY NO LONGER REPEATS THE BLOCK'S TITLE ──────────────────────
  // This fold now sits INSIDE block ⑤, whose head already reads "Session
  // journal". A summary saying the same words again is the v3.50.0 finding on
  // Wiki health — a section that names itself twice — recorded there as KNOWN
  // AND UNFIXED and not repeated here. "Recent saves" names what is behind the
  // chevron rather than restating what is above it.
  //
  // The fold STAYS, and it stays CLOSED by default, because the journal is the
  // one section that can be fifty rows long and it is history rather than
  // state — the maintainer's report was that this page "reads endlessly long",
  // and this is the section that made it so.
  const journalOpen = (state.openFolds && state.openFolds.journal) ? ' open' : '';
  if (!j.returned) {
    return (
      '<details class="mem-fold" data-mem-fold="journal"' + journalOpen + '>' +
        '<summary class="mem-fold-summary" id="mem-fold-journal">' + icon('chevronRight', 14) +
          '<span>Recent saves</span><span class="mem-fold-meta">empty</span></summary>' +
        '<div class="mem-fold-body">' +
          renderDescription('No saves recorded under this scope and machine yet.') +
        '</div>' +
      '</details>'
    );
  }

  // Declared INSIDE this function on purpose: scripts/test-next-memory-view.js
  // lifts renderJournal by brace-matching and executes it, so anything it
  // needs must travel with it. A module-level constant would have to be
  // injected by the suite, and an injected copy of a classifier is a second
  // hand-maintained copy of the rule it is supposed to be testing.
  const LOSS_NOTE_RE = /\b(dropped|omitted|truncated|rejected|discarded|lost)\b/i;
  const REPLACED_NOTE_RE = /\boverwrote\b/i;

  const rows = j.entries.map((e) => {
    const meta = [e.harness, e.model].filter(Boolean).map((x) => escapeHtml(x)).join(' · ');
    // THE LABEL, and why it is derived rather than fixed.
    //
    // The persisted field is `rejections` and it KEEPS that name — every
    // journal.jsonl line ever written carries it, so renaming would force a
    // permanent dual-read to fix a word. But almost nothing it holds IS a
    // rejection. The commonest entry by far is an observation saved without a
    // time: the save time was filled in AND disclosed, which is the store
    // doing its job. The shipped label read "N field(s) rejected by the
    // sanitiser", so a user was told their data had been thrown away at
    // precisely the moment it had not been — a word meaning the opposite of
    // what happened, on the one surface where they can see it. Seen in a
    // browser; that is what this replaces.
    //
    // Three outcomes, because the store produces three and collapsing any two
    // makes one of them a lie:
    //   · real loss  — content dropped, omitted or truncated;
    //   · replacement — a LARGER prior handoff deliberately overwritten
    //     (`replace: true`): nothing the caller sent was lost, but something
    //     was, so "nothing was dropped" would be false comfort;
    //   · normalisation — a value filled in and disclosed. Nothing lost.
    //
    // Derived from the note TEXT, exactly as the MCP's own notes_meaning is,
    // so a new note kind is classified without editing a list here. That is
    // sound only because the store BANS loss vocabulary from any note that is
    // not a loss; test-next-memory-view.js mirrors that ban over this
    // rendered output, so a future edit cannot label a non-loss event with a
    // loss word again.
    const notes = (e.rejections || []).map((n) => String(n));
    const lossy = notes.some((n) => LOSS_NOTE_RE.test(n));
    const replaced = notes.some((n) => REPLACED_NOTE_RE.test(n));
    const noteLabel = lossy
      ? ' — some content was dropped or truncated: '
      : replaced
        ? ' — this save replaced a larger handoff: '
        // NOT "nothing was lost". The invariant the store records applies
        // to this label too: a keyword classifier — and a skimming reader —
        // buckets on the WORD, and "nothing was lost" lands in the loss
        // bucket exactly as "content was lost" does. The suite caught this
        // sentence on its first run. Say what happened, positively.
        : ' on how this save was normalised — the content itself was stored in full: ';
    // THE MODIFIER CLASS the palette was waiting for (see memory.css's note on
    // .mem-j-rej). All three outcomes rendered in one neutral grey, so a real
    // loss looked exactly like "we recorded the save time because you sent
    // none". The classification exists only in the note TEXT and CSS cannot
    // select on text — so it is carried out here, as a class, and ONLY for the
    // loss case. The other two keep the neutral treatment on purpose:
    // re-warning on every normalisation is the defect this replaces.
    //
    // Amber arrives as an ICON plus a rule, not as the text colour. Colour is
    // never the only signal (tokens/color.css: "status colour always ships
    // with an icon or label"), and --attention-text measures 3.58:1 on the
    // light surface, which is below the 4.5:1 floor for body text — while an
    // icon and a border are graphical objects held to 3:1. The words stay at a
    // fully legible token and the amber does the signalling.
    const rej = notes.length
      ? '<div class="mem-j-rej' + (lossy ? ' mem-j-rej-loss' : '') + '">' +
          (lossy ? icon('alertTriangle', 12) : '') +
          '<span>' + escapeHtml(notes.length + ' note' +
          (notes.length === 1 ? '' : 's') + noteLabel + notes.join('; ')) + '</span></div>'
      : '';
    return (
      '<li class="mem-j-row">' +
        '<div class="mem-j-when"' + (e.at ? ' title="' + escapeHtml(e.at) + '"' : '') + '>' +
          escapeHtml(e.at ? e.at.slice(0, 16).replace('T', ' ') : 'unknown') + '</div>' +
        '<div class="mem-j-body">' +
          '<div class="mem-j-headline">' + escapeHtml(e.headline || '(no headline)') + '</div>' +
          (meta ? '<div class="mem-j-meta">' + meta + '</div>' : '') +
          rej +
        '</div>' +
      '</li>'
    );
  }).join('');

  // A COUNT, rendered as a count. It was a grey sentence in `.mem-quiet` — the
  // same class as the About fold's static explanation — so the one live figure
  // at the foot of the list read as chrome. renderReadout splits it into the
  // three things it actually is: what was measured, the figure, and how the
  // figure was obtained.
  //
  // A fact and its absence stay apart, exactly as before: `total: null` with
  // totalUnknown means the journal was longer than the tail we read, so we do
  // NOT know the count. The VALUE is then the number we can stand behind (what
  // is shown) and the reason we cannot state a total is provenance — never a
  // total printed as if the tail's length were it.
  let countReadout;
  if (j.totalUnknown) {
    countReadout = renderReadout({
      label: 'Saves shown',
      value: j.returned,
      provenance: 'most recent · full count unknown — ' +
        (j.totalUnknownReason || 'only the end of the journal was read'),
    });
  } else if (typeof j.total === 'number' && j.total > j.returned) {
    countReadout = renderReadout({
      label: 'Saves recorded',
      value: j.total,
      provenance: 'showing the ' + j.returned + ' most recent',
    });
  } else {
    countReadout = renderReadout({
      label: j.returned === 1 ? 'Save recorded' : 'Saves recorded',
      value: j.returned,
    });
  }

  const canExpand = state.journalLimit === JOURNAL_PAGE &&
    (j.totalUnknown || (typeof j.total === 'number' && j.total > j.returned));
  // In the <details> BODY, never in its <summary> — see the header comment.
  const moreBtn = canExpand
    // btn-secondary: same reason as mem-stale-btn above — `.btn` alone used
    // to resolve to native OS button chrome (2px outset bevel over
    // ButtonFace). Named rather than left to the baseline so this reads as a
    // real control.
    ? '<button class="btn btn-secondary btn-xs mem-j-more" id="mem-journal-more">Show more</button>'
    : '';

  return (
    '<details class="mem-fold" data-mem-fold="journal"' + journalOpen + '>' +
      '<summary class="mem-fold-summary" id="mem-fold-journal">' + icon('chevronRight', 14) +
        '<span>Recent saves</span>' +
        '<span class="mem-fold-meta">' + escapeHtml(String(j.returned)) + '</span></summary>' +
      '<div class="mem-fold-body">' +
        // The journal is APPEND-ONLY history, newest first, and any entry
        // MAY HAVE BEEN SUPERSEDED — a blocker named in an old headline can
        // have been fixed three saves ago. Someone skimming this list for
        // "what is blocking us" is exactly the person who would act on that,
        // so the framing is stated once, above the list, rather than left to
        // be inferred. The current handoff above is the authoritative present.
        '<div class="mem-j-framing">' +
          renderDescription('History, newest first. Any entry may since have been ' +
            'superseded — the current handoff above is what is true now.') +
        '</div>' +
        '<ol class="mem-j-list">' + rows + '</ol>' +
        '<div class="mem-j-foot">' + countReadout + moreBtn + '</div>' +
      '</div>' +
    '</details>'
  );
}

/**
 * THE ONE EXPLANATORY SURFACE — now the header's ⓘ panel, not a card.
 *
 * ── WHAT CHANGED, AND WHAT DID NOT ─────────────────────────────────
 * The WORDS are unchanged. What moved is the container: this was a
 * `renderExplainer` <details> appended to all four content branches, so the
 * widest element on the page was the one read once per lifetime, and it sat
 * hard against the journal above it because .tx-explainer declares no margin.
 * renderMain now passes this HTML as the header's `info`, which is the same
 * component family under the same rules and the shape renderViewHeader
 * documents for exactly this content.
 *
 * BOTH LOAD-BEARING PROPERTIES SURVIVE THE MOVE, because the header keeps
 * them: the panel is a real, keyboard-operable control (a <button> with
 * aria-expanded / aria-controls, Escape to close and focus returned), and it
 * is HIDDEN on first paint — needed once per user, then never again.
 *
 * NOTHING HERE WARNS. No caution, no cost, no refusal; v3.16.1's rule is that
 * a warning behind a click is not a warning, and renderViewHeader has no
 * `state` or `warningTone` field to tempt one in. The read-only rule in the
 * last paragraph is a DESIGN FACT, not a caution — the store has no write
 * endpoint for tiers 2 and 3 even if the sentence were missed.
 *
 * THE LINK IS DATA. `docsLinkHtml('memory.overview', …)` resolves through the
 * frozen table in shared/docs-links.js, which scripts/test-docs-links.js
 * checks against the real markdown in docs/ — so a renamed heading reds a
 * commit rather than silently landing a reader at the top of a page.
 *
 * The caller passes `infoHtml: true` and therefore owns escaping. Every byte
 * returned here is a literal or the helper's own escaped output; nothing
 * user-supplied, machine-supplied or store-supplied reaches it.
 */
function aboutInfoHtml() {
  return (
    '<p>A <b>domain</b> is where your knowledge lives — one compounding wiki. A <b>project</b> is a ' +
    'thing you build inside it, and a domain can hold several. Agent memory is kept per project, in ' +
    '<span class="mono">state/</span> beside that domain’s wiki, and synced with it.</p>' +
    '<ul class="mem-about-list">' +
      '<li><b>Standing brief</b> — the part that rarely changes: the goal, the firm decisions, the working ' +
      'model. One per project, returned on every agent read. <b>You write this one</b>, here or in a text ' +
      'editor; saving replaces the whole document.</li>' +
      '<li><b>Current handoff</b> — where things stand right now: what an agent leaves for the next ' +
      'session, so it starts knowing what you already settled. One per <b>work-stream</b> per machine ' +
      '(the files call a work-stream a <i>scope</i>), so parallel threads never overwrite each other. ' +
      'Overwritten on every save, so it never grows stale behind you.</li>' +
      '<li><b>Session journal</b> — one line per save: when, which harness, which model, and the headline. ' +
      'It is history and it accumulates, so an old entry can describe something already resolved.</li>' +
    '</ul>' +
    '<p>Each machine writes to its own folder, so two machines can never overwrite each ' +
    'other over sync. Reading a work-stream with no machine named gives you the most recently written one, ' +
    'whichever machine that was.</p>' +
    '<p>Your agents write the handoff and the journal through the ' +
    '<span class="mono">my-curator</span> MCP tools, and this screen never does — a handoff is worth ' +
    'something because an agent observed it. The brief is yours. Everything here is plain markdown, so a ' +
    'text editor works too.</p>' +
    '<p>' + docsLinkHtml('memory.overview', 'Read more in the guide') + '</p>'
  );
}

// ── Wiring ───────────────────────────────────────────────────────────────

function wire(token) {
  document.querySelectorAll('.mem-row[data-mem-project]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const domain = btn.dataset.memDomain;
      const project = btn.dataset.memProject;
      // Compared on the PAIR. Two domains can each hold a project called
      // `main`, and comparing the project name alone would make clicking the
      // second one do nothing at all.
      if (keyOf(domain, project) === activeKey()) return;
      selectProject(domain, project, token, { revalidateIndex: true })
        .catch((err) => reportAsyncMountFailure(token, err));
    });
  });

  // ── THE WORK-STREAM TABLE ─────────────────────────────────────────────
  // One listener per row button, the same shape the rail rows use, rather
  // than one delegated listener on the table: `wire` runs after every paint
  // and the whole pane is replaced each time, so there is nothing to
  // accumulate on and a per-row handler keeps the data it needs on its own
  // element.
  //
  // FOCUS IS RECORDED EXPLICITLY HERE, and this is the one place in the view
  // that does so. `captureFocus` only remembers an id in FOCUSABLE_IDS, and
  // the button being clicked has NO id unless it is already the open row —
  // ids must be unique and a scope slug is not a safe id fragment. A moment
  // after this click the pressed row IS the open row and carries
  // `mem-ws-active`, so naming that id now is what puts focus back where the
  // keyboard user left it.
  document.querySelectorAll('.mem-ws-open[data-mem-scope]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const scope = btn.dataset.memScope;
      const machine = btn.dataset.memMachine || null;
      // Already open — re-reading would drop the document and repaint a
      // loader over a page that is already correct.
      if (state.detail && state.detail.scope === scope
        && (state.detail.machine || null) === machine) return;
      pendingFocusId = 'mem-ws-active';
      state.journalLimit = JOURNAL_PAGE;
      loadScope(scope, machine, token).catch((err) => reportAsyncMountFailure(token, err));
    });
  });

  document.getElementById('mem-copy-agent')?.addEventListener('click', () => {
    copyAgentInstructions(token).catch((err) => reportAsyncMountFailure(token, err));
  });

  // ── The standing-brief editor ─────────────────────────────────────────
  const briefEdit = document.getElementById('mem-brief-edit');
  if (briefEdit) {
    briefEdit.addEventListener('click', () => {
      const read = state.projectRead;
      const present = !!(read && read.brief && read.brief.present);
      // The WHOLE stored document, preamble included — this is an editor,
      // not a reader, and stripping the title and provenance lines here
      // would save them away on the next write. renderBrief strips them
      // for DISPLAY only.
      const text = present ? (read.brief.text || '') : BRIEF_TEMPLATE;
      state.briefEdit = {
        domain: state.activeDomain,
        project: state.activeProject,
        // `loaded` never moves after this. It is what "is this dirty?" is
        // measured against, and measuring against a re-read would make the
        // answer depend on whether a poll happened to land mid-edit.
        loaded: text,
        text,
        busy: false,
        error: null,
        preview: false,
        confirmDiscard: false,
      };
      render(token);
    });
  }

  const briefText = document.getElementById('mem-brief-text');
  // Written straight into state on every keystroke, WITHOUT a re-render —
  // re-rendering here would rebuild the textarea and lose the caret and the
  // selection. Exactly the pattern views/domains.js's lifecycle form uses,
  // for the same reason; the save handler reads state, never the DOM, so the
  // two cannot disagree.
  briefText?.addEventListener('input', () => {
    if (!state.briefEdit) return;
    state.briefEdit.text = briefText.value;
    // ── THE COUNTER, THE WALL AND SAVE, UPDATED IN PLACE ──────────────────
    // `textContent` and one attribute each, exactly as tickAges does, and for
    // the same reason: a render would rebuild the field under the caret. This
    // is the one place in the view that writes to the DOM outside render(),
    // and it writes only to elements renderBriefEditor emitted for it.
    const stats = briefStats(briefText.value);
    const box = document.getElementById('mem-brief-stats');
    if (box) {
      const set = (key, text) => {
        const el = box.querySelector('[data-brief-stat="' + key + '"]');
        if (el && el.textContent !== text) el.textContent = text;
      };
      set('dirty', briefText.value !== (state.briefEdit.loaded || '') ? 'modified' : 'unchanged');
      set('words', stats.words + ' word' + (stats.words === 1 ? '' : 's'));
      set('bytes', stats.bytes + ' of ' + BRIEF_MAX_BYTES + ' bytes');
      box.classList.toggle('mem-brief-stats-over', stats.over);
    }
    const over = document.getElementById('mem-brief-over');
    if (over) over.hidden = !stats.over;
    // SAVE IS THE POINT OF ALL OF IT. The route refuses above the wall with a
    // 400, so offering a save that cannot land is offering a refusal.
    const save = document.getElementById('mem-brief-save');
    if (save) save.disabled = stats.over;
  });

  // ── THE KEYBOARD CONTRACT, ON THE FIELD ITSELF ────────────────────────
  //
  // Cmd/Ctrl+S and Cmd/Ctrl+Enter save. BOTH, because they mean the same
  // thing to two different kinds of writer: ⌘S is the reflex of anyone who
  // has ever used a text editor, ⌘↵ is the reflex of anyone who has ever
  // used a composer. `preventDefault` on ⌘S is load-bearing — without it the
  // browser opens its "Save page as…" dialog over an app that has just
  // saved, which reads as the save having failed.
  //
  // Escape asks `briefDismissDecision` rather than deciding here, so the
  // three outcomes are a value that can be driven directly and the handler
  // is the one thing that cannot be: a dirty draft raises the inline bar and
  // an in-flight save refuses outright.
  //
  // Bound on the TEXTAREA and not on the document: a document-level key
  // handler would fire while the user is typing in the rail's filter or
  // anywhere else on the page, and it would have to be removed on teardown.
  // This one dies with the element it is on.
  briefText?.addEventListener('keydown', (ev) => {
    const mod = ev.metaKey || ev.ctrlKey;
    if (mod && (ev.key === 's' || ev.key === 'S' || ev.key === 'Enter')) {
      ev.preventDefault();
      saveBrief(token).catch((err) => reportAsyncMountFailure(token, err));
      return;
    }
    if (ev.key === 'Escape') {
      const decision = briefDismissDecision(state.briefEdit);
      if (decision === 'blocked') return;
      ev.preventDefault();
      if (decision === 'confirm') {
        state.briefEdit.confirmDiscard = true;
        render(token);
        return;
      }
      state.briefEdit = null;
      render(token);
    }
  });

  document.getElementById('mem-brief-preview')?.addEventListener('click', () => {
    if (!state.briefEdit) return;
    state.briefEdit.preview = !state.briefEdit.preview;
    render(token);
  });

  document.getElementById('mem-brief-discard')?.addEventListener('click', () => {
    state.briefEdit = null;
    render(token);
  });
  document.getElementById('mem-brief-keep')?.addEventListener('click', () => {
    if (state.briefEdit) state.briefEdit.confirmDiscard = false;
    render(token);
  });

  document.getElementById('mem-brief-save')?.addEventListener('click', () => {
    saveBrief(token).catch((err) => reportAsyncMountFailure(token, err));
  });
  // Cancel goes through the SAME decision as Escape. Two ways out of one
  // editor that answer differently about an unsaved draft is how a draft gets
  // destroyed by the safer-looking control.
  document.getElementById('mem-brief-cancel')?.addEventListener('click', () => {
    const decision = briefDismissDecision(state.briefEdit);
    if (decision === 'blocked') return;
    if (decision === 'confirm') {
      state.briefEdit.confirmDiscard = true;
      render(token);
      return;
    }
    state.briefEdit = null;
    render(token);
  });

  // Record which disclosures are open so the next render can re-open them.
  // `toggle` fires only on a real change, never on parse, so emitting `open`
  // in the markup above does not feed back into this.
  //
  // TWO FOLDS NOW, not three: the standing brief is a BLOCK rather than a
  // <details>, so `data-mem-fold="brief"` no longer exists and the transient
  // "open because nothing else is on the page" state v3.54.0 had to chase is
  // not merely fixed but inexpressible.
  document.querySelectorAll('[data-mem-fold]').forEach((el) => {
    el.addEventListener('toggle', () => {
      if (!state.openFolds) state.openFolds = {};
      const key = el.dataset.memFold;
      if (key) state.openFolds[key] = el.open;
    });
  });

  const refresh = document.getElementById('mem-refresh');
  if (refresh) {
    refresh.addEventListener('click', () => {
      // Both halves, because "refresh" means the screen, not the sidebar:
      // the index (which project rows read from) AND the project actually on
      // display. Fired in parallel — they are independent reads.
      refreshIndex(token).catch((err) => reportAsyncMountFailure(token, err));
      reloadActive(token).catch((err) => reportAsyncMountFailure(token, err));
    });
  }

  const reload = document.getElementById('mem-reload');
  if (reload) {
    reload.addEventListener('click', () => {
      reloadActive(token).catch((err) => reportAsyncMountFailure(token, err));
    });
  }

  const more = document.getElementById('mem-journal-more');
  if (more) {
    more.addEventListener('click', () => {
      state.journalLimit = JOURNAL_MORE;
      // Re-read the SAME machine we are looking at, not the scope default —
      // otherwise expanding the journal could silently swap which machine's
      // history is on screen if another machine wrote in the meantime.
      const m = state.detail ? state.detail.machine : state.machine;
      loadScope(state.scope, m, token).catch((err) => reportAsyncMountFailure(token, err));
    });
  }
}

export const __testing = {
  formatAge, projectMetaLine, splitHandoffPreamble,
  keyOf, initialPick, renderProjectGroups, readRememberedProjects, BRIEF_TEMPLATE,
  // The three pure decisions the v3.55.0 dashboard added. Exported for the
  // same reason `initialPick` is: each is the only part of a path that makes a
  // decision, and the rest around it is I/O or markup.
  briefStats, briefDismissDecision, newerOnAnotherMachine,
};
