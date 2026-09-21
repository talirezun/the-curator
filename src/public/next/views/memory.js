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
// DESIGN — A DASHBOARD, IN FOUR BLOCKS (v3.55.0, narrowed v3.56.0)
// ─────────────────────────────────────────────────────────────────────────
// The maintainer's verdict on the v3.54.0 page was "not okay", in six parts,
// and the shape below is each of them answered. See `renderProject` for the
// list and for which block answers which.
//
//   ① STATUS         — "Working on:", the Last-saved reading, every caveat
//   ② WORK-STREAMS   — a TABLE of the project's (scope, machine) pairs,
//                      the newest FIVE with a "Show N more" footer; press a
//                      row and its handoff opens in the shell's READER
//   ③ STANDING BRIEF — yours, with a pencil beside the title and an editor
//   ④ SESSION JOURNAL— history, folded, last
//
// THERE IS NO "CURRENT HANDOFF" BLOCK (v3.56.0). It printed the whole document
// under the table, which made a dashboard into a document viewer: the thing
// that answers "where does this project stand" was sitting on top of fifteen
// hundred words about ONE work-stream. The wiki settled this years ago — a list
// of pages, and a press opens one in the right-hand reader — and a handoff is
// the same shape of thing. `handoffReaderContent` composes the payload;
// `openWorkStream` performs the press. Nothing new was added to the backend:
// the read is the one `loadScope` already made, and views/domains.js has opened
// a memory row in that same reader through that same route since v3.50.0.
//
// ONE COLUMN, ONE RIGHT EDGE, ONE RHYTHM. The four blocks are
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
// ONE FOLD. The journal keeps its <details> — fifty rows of history, and it is
// the section that made the page long. The standing brief is NOT a fold: a
// block head is a heading, and a pencil in a <summary> would be the hazard
// below. The handoff's fold went with the block it led: a document that opens
// in an overlay has no collapsed state to remember, and the reader's own ✕ and
// `esc` are the close.
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
// buttons, its "Show N more" footer, the journal's "Show more", the brief's
// pencil, Save, Preview, Cancel — is a SIBLING of its <details>, or lives in a
// <details> BODY, or sits in a block that is not a <details> at all. The one
// remaining <summary>, the journal's, holds spans only. There is therefore no
// propagation path to suppress, so no later edit can drop a stopPropagation
// that isn't there.
//
// SQUARE marker, not round: agent memory is a different KIND of thing from a
// knowledge domain, and the rail already puts them side by side. Domains use
// a round dot (.dm-row-dot border-radius: 50%); this uses a square
// (.mem-row-mark, radius 2px). Both docs/architecture.md and this view's own
// previous placeholder promised that distinction; it is honoured here.

import {
  registerView, setSidebar, setMain, escapeHtml, icon,
  isCurrentMount, reportAsyncMountFailure,
  // THE SHELL'S READER, the panel the wiki opens a page in. A work-stream row
  // opens its handoff there instead of the page printing it (see
  // handoffReaderContent). `isCurrentReader` is the epoch guard every caller of
  // openReader owes it: the loading panel is painted BEFORE the fetch, and a
  // user who presses Escape while it is in flight must not have the document
  // reopened on top of whatever they went back to.
  openReader, isCurrentReader,
  // THE SHELL'S ONE NAVIGATION CHOKEPOINT. Used by the POINTER this view
  // carries — "Create a project in Domains", on the screen `renderMain`
  // reaches when there is no project to select — which is a pointer rather
  // than a second write path.
  navigate,
  // ── WHICH DOMAIN THE DOMAINS VIEW SHOULD LAND ON (v3.62.0, P1-9) ──────
  // `views/domains.js` keeps its active slug in module state and falls back
  // to `state.domains[0]` when it is unset or gone. This view is app-wide
  // across domains, so a bare `navigate('domains')` from a project in domain
  // B lands on whatever Domains last had — silently, and with every figure on
  // the screen belonging to a different wiki. The shell carries the request;
  // `views/domains.js` consumes it in onEnter before it resolves its own slug.
  requestDomain,
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
  // `renderReadoutGroup` LEFT THIS LIST in v3.65.0. Its one call site was step
  // ③'s five cells, and those are a `renderMonitor` now — the one instrument
  // every live reading in the app takes. An unused import is an unadopted
  // component, which is the state `fetchOpenRouterCatalogue` shipped in.
  renderDescription, renderStatus, renderReadout,
  renderViewHeader, renderInfoMark,
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
// ── THE OVERVIEW CARD (v3.64.2) ────────────────────────────────────────────
// The three readings above the three steps used to be a three-cell mono strip
// of `renderReadout`s with a lone ⓘ pushed to the right, while the domain page
// answered the same question — "what are the readings about this screen?" —
// with a grid of stat cards under an eyebrow with an ⓘ. The maintainer's
// question was the whole brief: "how are these the same?" They are one
// component now, and the domain page's card is the design that won.
import { renderOverview } from '../shared/overview.js';
// ── THE SIDEBAR IS THE KIT'S NOW (v3.65.0, R2) ──────────────────────────────
// The maintainer, with both rails in front of him: *"We have two middle menus,
// Domains and Context, in totally different designs ... I suggest we go with
// the Domains design, which is more polished: it has clocks showing when it
// was changed; in Context we don't have that."* `shared/sidebar.js` IS that
// design, extracted; this view passes content and nothing else. `mem-` rides
// as an ALIAS on the same elements, so the four suites that address this
// rail's rows by name keep addressing them.
import { renderSidebarHead, renderSidebarGroup, renderSidebarRow,
  identityDotClass } from '../shared/sidebar.js';
// ── EVERY LIVE READING ON THIS PAGE IS ONE COMPONENT (v3.65.0) ──────────────
// The maintainer, with three screenshots of three different report cards:
// *"these active-state cards ... show specific data, the data that is
// changing, and my idea was to make this similar to a CLI, a terminal kind of
// data input or output, so it has a distinguished design so people can
// immediately see what's going on ... All these three cards show something
// different but the design could be the same."* Two of the three were on this
// screen (the "Last saved" card and the CAPTURE block) and the third was step
// ③'s readouts. All three are `renderMonitor` now.
import { renderMonitor } from '../shared/monitor.js';
// ── THE ONE PICKER ON THIS SCREEN (v3.65.0, P10) ───────────────────────────
// Step ③'s "+ Add a wiki". The shared listbox, ADD ONE AT A TIME: the
// component implements no multi-select and says so in its own header, and
// building a second selection paradigm here is the shape this release exists
// to remove. `closeAllListboxes` is called on teardown, because navigate()
// does not reach into view-owned popovers.
import { renderListboxHtml, mountListbox, closeAllListboxes } from '../shared/listbox.js';

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
// `formatDayAge`, `dayFreshnessTier` and `freshnessDotHtml` come with them for
// step ③: `lastIngestDate` is a `YYYY-MM-DD` heading with no time of day, so it
// is read on the CALENDAR-DAY ladder rather than the second-resolution one —
// two ladders would be two scales, one ladder read two ways is the design
// system's own arrangement (design-system-source.md §6).
import {
  freshnessStep, freshnessTier, formatDayAge, dayFreshnessTier, freshnessDotHtml,
} from '../shared/age.js';

// ── "ASK THIS DOMAIN", THE EXISTING WRAPPER RATHER THAN A SECOND ONE ─────
// `requestChatScope` + `navigate('chat')` is a producer/consumer pair with a
// documented no-slug hazard (app.js). views/domains.js has wrapped it since
// v3.55.0; that wrapper is LIFTED to shared/ rather than copied here, so the
// hazard stays guarded once and the two hosts cannot drift.
import { goToChatScoped } from '../shared/chat-scope.js';

// The paste-into-your-entry-file block. ONE text, shared with the Domains
// view — see that module's header for what was measured and why the wording
// is frozen. This screen offers it because this screen is where someone ends
// up when they are wondering why a project has no state: the answer is often
// that the agent's harness never activated the skill, and this is the fix.
import { composeAgentInstructions, composeAgentInstructionsFull, COPY_SUCCESS_BANNER } from '../shared/agent-instructions.js';

// ── THE OWNERSHIP CHOOSER, SHARED WITH THE DOMAINS VIEW ──────────────────
//
// Where a project's canonical documents come from is asked in TWO places: on
// the "New project" form (views/domains.js) and here, on a project that has no
// manifest yet. The store sets that ownership ONCE and refuses a mismatch on
// every later write, so two copies of the question would be two descriptions
// of WHICH WRITER OWNS A FILE — and a project created with one answer and
// initialised with the other is a refusal the user cannot act on. Imported,
// never re-implemented: shared/foundations-init.js owns the markup, the state
// shape, the request body and the outcome words.
//
// The four store mirrors — the slug grammar, the seven role names, the
// per-document byte wall and the project budget — come from there for the same
// reason `BRIEF_MAX_BYTES` is a constant in this file rather than a literal at
// its call sites: they are numbers the SERVER enforces, and a copy that drifts
// either blocks a save the server would accept or offers one it refuses with a
// 400 the user cannot act on. scripts/test-next-foundations-editor.js pins
// every one of them against src/brain/working-state.js.
// ── THE DRAFTING REQUEST'S ONE SOURCE (P2-8) ─────────────────────────────
// Model-read instruction text, sha-pinned in shared/agent-instructions.js
// beside its three siblings, and IMPORTED here rather than typed: a second
// copy of model-read text is this repository's most reliably recurring defect,
// and scripts/test-agent-instructions.js §S9 scans this file for its sentences
// and fails on one. It is deliberately NOT part of
// `composeAgentInstructionsFull` — that output is pasted into CLAUDE.md, where
// "draft these now" would become a standing instruction to keep re-drafting.
import { composeDraftingAsk } from '../shared/agent-instructions.js';
import {
  FOUNDATION_SLUG_RE, FOUNDATION_ROLES, MAX_FOUNDATION_BYTES, FOUNDATIONS_BUDGET_BYTES,
  freshChooser, chooserBody, chooserOutcomeWords, renderFoundationsChooser,
  bindFoundationsChooser, renderRoleOptions, renderRefusedList,
  readPickedFile, slugForFilename, roleForBasename, titleFromText, formatBytes,
  // ── THE REMOTE MIRROR'S REFUSAL VOCABULARY (v3.65.0) ───────────────────
  // Nine store codes, nine sentences, every one naming the token's SOURCE
  // rather than the token — which is the store's own rule and the one a view
  // is in a position to break.
  remoteRefusalText,
  // ── ONE PREDICATE FOR THE COMMIT, SHARED WITH THE OTHER HOST (v3.61.1) ──
  // What makes "Set up documents" pressable is a fact about the CHOICE, not
  // about this view, so the rule lives beside the choice. This view calls it
  // twice — once for the disabled flag at render, once in the patch the
  // chooser's `onSelect` triggers — and both answers come from the same
  // function, which is what stops a button and the sentence under it
  // disagreeing.
  commitBlockedReason,
} from '../shared/foundations-init.js';

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
// pair, newest first, each row a button — no picker, no cfg, no menu.
//
// ── ONE ADOPTION IS BACK, AND IT IS A DIFFERENT QUESTION (v3.65.0) ────────
// Step ③'s "+ Add a wiki" IS a listbox, and it is the shape the component was
// built for: a short, closed set of names, one of which is chosen, with a
// real commit behind it. What was wrong about the two pickers this file
// deleted was that they hid a LIST the user needed to see; this one adds to a
// list that is already on screen as rows. scripts/test-next-listbox.js counts
// this view's adoptions and expects exactly ONE.
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

// ── THE SESSION BUDGET, MIRRORED (v3.62.0) ───────────────────────────────
//
// The store's `CONTEXT_MAX_BYTES_DEFAULT`: how many bytes of document BODIES a
// single `get_project_context` hands an agent. It is NOT
// `FOUNDATIONS_BUDGET_BYTES` (200 KB), which is about what a project may
// STORE — two budgets, two questions, and conflating them warns about the
// wrong set. Only ever a FALLBACK: `foundationsFacts` prefers the server's own
// `readFirstBudgetBytes` wherever it sent one, for the same reason `bytes`
// prefers `totalBytes`. Mirrored rather than imported because
// `shared/foundations-init.js` mirrors only the project budget, and a view may
// not add an export to a module two views share.
const READ_FIRST_BUDGET_BYTES = 120 * 1024;

// ── THE HONESTY METER'S WINDOW, AND THE LIST UNDER IT (v3.63.0) ──────────
//
// The one question the memory layer exists for is "did this session start with
// the bootstrap, and did it save before it stopped?", and it is asked PER
// PROJECT — which is why the reading lives inside step ② rather than beside
// the tool map on the MCP bridge page. That page is per TOOL and app-wide;
// this one is about this project.
//
// THIRTY DAYS, NOT SEVEN, and the divergence is deliberate. `mcp-usage.js`'s
// own `RECENT_WINDOW_MS` is seven days and the design record proposed seven
// here too; the route takes `since` from the CALLER precisely so the window is
// the reader's decision rather than the log's. Seven days on a project someone
// picks up on alternate weekends reads "no agent session" about a project that
// is being worked on, and a meter whose whole subject is honesty must not say
// that. The phrase on screen is DERIVED from this constant (see
// `renderCaptureMeter`), so the number and the words cannot drift apart.
const CAPTURE_WINDOW_DAYS = 30;
// How many session rows the fold ASKS the route for. The route caps and
// answers `sessionsTruncated` / `sessionsShown`; the disclosure under the table
// is that answer, never this number — a view that printed its own request back
// as a measurement would be reporting a CAP as a reading, which is the defect
// `distinctScopeCount` is counted before the index slice to avoid.
const CAPTURE_SESSION_LIMIT = 20;

// Journal page sizes. The store clamps journalLimit to [1, 50] itself
// (MAX_JOURNAL_ENTRIES); these are just the two steps this view offers, and
// the store stays the authority on the ceiling.
const JOURNAL_PAGE = 10;
const JOURNAL_MORE = 50;

// ── THE WORK-STREAMS TABLE SHOWS THE LATEST FIVE ─────────────────────────
//
// v3.55.0 put every (scope, machine) pair on screen, which was right against
// the two pickers it replaced and wrong at the size a real project reaches: a
// project that has run for a month across two machines is twenty rows, and the
// table then owns the page the same way the journal did before it was folded.
// Five is what the menubar widget shows for the same reason, and it is enough
// to answer the question the table exists for — "which of these moved today?".
//
// THE FOOTER IS THE LIST'S OWN ROW, the shape views/domains.js settled for
// "Show 150 more": a <button> that IS a row, OUTSIDE the scroll container so it
// cannot sit below the fold of the thing it extends. Pressing it APPENDS the
// next window rather than re-rendering, so the rows already read do not move.
//
// THE STEP IS "ALL THE REST", NOT ANOTHER FIVE, up to a point. A project with
// seven work-streams has two hidden, and asking someone to press twice for two
// rows is the friction, not the rows. Past WS_STEP_ALL_MAX the same press would
// paint a wall, so it becomes WS_STEP — the same judgement domains.js makes
// with a fixed 150 over a list that runs to thousands, at the scale this one
// actually reaches.
const WS_WINDOW = 5;
const WS_STEP_ALL_MAX = 20;
const WS_STEP = 10;

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
    // ── THE INSTALL'S DOMAINS, IN listDomains() ORDER (v3.65.0) ──────────
    // `null` until `GET /api/domains` answers, and `null` forever if it
    // refuses. TWO readers, which is why it is fetched at all rather than
    // derived: the rail's identity colours need the domain's place in THIS
    // list (the same list the Domains page paints from, so one domain is one
    // colour everywhere), and step ③'s picker needs the set of domains a
    // project may draw on. `readonly` is kept beside it because a `shared-*`
    // mirror is an allowed knowledge domain and a refused ingest target, and
    // conflating the two is how a picker comes to hide a legitimate choice.
    domainList: null,
    domainListReadonly: [],
    // TRUE only once a read has been ATTEMPTED and refused. `domainList`
    // stays null in both cases — "not asked yet" and "asked and refused" —
    // and step ③'s picker says something different about each, because
    // "reading…" over a permanent refusal is a spinner that never stops.
    domainListRefused: false,
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
    // The last "Refresh from repo" attempt, or null:
    //   { domain, project, busy, error, result: {refreshed, added, unchanged, missing} }
    // STAMPED with its pair for the same reason `copied` and `briefEdit` are:
    // this view switches project without unmounting, and an unstamped outcome
    // would sit under the next project's header claiming its documents had been
    // re-copied. Cleared implicitly — the stamp comparison in renderFoundations
    // is what withholds it — so a switch back to the project that was actually
    // refreshed still shows its own result.
    fnd: null,
    // ── THE OWNERSHIP CHOICE, WHILE IT IS BEING MADE (v3.61.0) ───────────
    //   { domain, project, choice, busy, error, refused }
    // `choice` is shared/foundations-init.js's own state shape — this view
    // never reads inside it except to hand it back to that module. STAMPED
    // for the reason every other record here is: this view switches project
    // without unmounting, and an ownership choice half-made for one project
    // must not be posted against the next.
    fndInit: null,
    // ── THE FOUNDATION EDITOR, or null when nothing is being edited ──────
    //   { domain, project, slug, isNew, loading, loaded, text, title, role,
    //     busy, error, preview, confirmDiscard, confirmShrink, confirmDelete,
    //     deleting, importError, notes, budgetExceeded }
    //
    // ONE DOCUMENT AT A TIME, and it REPLACES the table inside the fold while
    // it is open — the standing brief's own precedent one block up. Two
    // editors on one screen would each carry a Save, and the block's taxonomy
    // allows one primary per card.
    //
    // `loaded` is the RAW document the editor opened on and never moves after
    // that: it is what "is this dirty?" and the shrink confirm are measured
    // against, and re-reading it would make both answers depend on whether a
    // poll happened to land mid-edit. It is the verbatim bytes (`?raw=1`),
    // never the defanged read the reader shows — see `loadFoundationDraft`.
    fndEdit: null,
    // ── THE FOUNDATIONS FOLD'S FORCED-OPEN STATE, TRANSIENT (v3.64.1) ────
    //
    // Opening an editor inside a collapsed section is a press that visibly
    // does nothing (v3.58.0's finding on the brief), so four handlers force
    // the documents fold open. Through v3.64.0 they did it by writing
    // `state.openFolds.foundations = true` AND PERSISTING it, which produced
    // the defect the maintainer reported the day v3.64.0 shipped: the fold
    // reopening itself however often he closed it. Reproduced in a browser
    // against the real store — press Edit, close the fold (the toggle
    // listener writes `false` and persists it), then cause any render, and
    // `renderFoundations`'s `editing || adding ||` disjunction re-forced
    // `open`; the SAME toggle listener then recorded the forced state as
    // `true`, so the user's close was overwritten by the very thing that had
    // ignored it, and every later paint reopened the fold.
    //
    // The force is a TRANSIENT and lives here. It is not a FOLD_KEYS name, so
    // it can never be serialised: an Edit press no longer leaves a mark on
    // `curator-memory-folds-v1`, and only a real toggle writes that. An
    // explicit close CLEARS it, which is what makes the close final while an
    // editor is still up. freshState drops it, so the next visit to this view
    // honours the remembered preference and nothing else.
    //
    // WHY IT IS NOT CLEARED THE MOMENT THE EDITOR CLOSES, which is the other
    // reading of the design note: a document saved from the editor would then
    // vanish behind a chevron on the frame the save landed. The close is
    // final the instant the user asks for it, and on every later visit; it is
    // not made final by an act the user did not perform.
    fndForceOpen: false,
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

    // HOW MANY WORK-STREAM ROWS ARE PAINTED. The single source of truth for
    // the table, the footer's label and the "showing N of M" clause, so a full
    // render after a "Show more" paints exactly what the append left on screen.
    // Reset to WS_WINDOW on every project change (selectProject) — a window
    // opened on one project is not a statement about the next one.
    wsWindow: WS_WINDOW,

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
    // `undefined` still means "no opinion" and the fold keeps its default,
    // which for both of them is CLOSED.
    //
    // TWO KEYS SINCE v3.58.0: `journal` (history, and the section that first
    // made this page long) and `brief` (a page or more of the document that
    // changes least — 65% of the measured page height on this repo's own
    // project). The HANDOFF fold is still gone with the block it led: that
    // document opens in the shell's reader, which has its own open state and
    // its own Escape.
    //
    // SEEDED FROM localStorage, not from `{}`: a fold you opened has to still
    // be open when you come back from the Wiki. The default when storage is
    // empty, unreadable or hand-mangled is `{}` — closed — and it is NEVER
    // derived from loading state, which is the v3.54.0 defect (a transient
    // render made the brief the only content on the page, Chrome queued a
    // `toggle` for the <details> it had just parsed `open`, and the transient
    // became permanent).
    openFolds: readRememberedFolds(),

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

    // ── STEP ③'s ONE READING, AND THE DOMAIN IT BELONGS TO (v3.62.0) ────
    //
    // `GET /api/domains/:domain/stats` — one request, no LLM, and no read of
    // any page's CONTENT: a CLAUDE.md read, a dirent-only recursive walk of
    // `wiki/`, a readdir of `conversations/` and a `stat` of `log.md` that
    // becomes a read only when it changed (src/brain/files.js). Every other
    // surface that could answer this was ruled out by cost and the reasons are
    // at `loadKnowledge`.
    //
    // ── A MAP, KEYED BY DOMAIN (v3.65.0, P10) ──────────────────────────
    // A project draws on N wikis now, so N answers arrive on N clocks and a
    // single `{domain, data, error}` slot could only ever describe the last
    // one to land. Each entry is `{data, error, gone}`; `gone` is the 404
    // arm, which is a DIFFERENT fact from a read that failed — the store
    // keeps a slug whose domain this install does not have, and the row says
    // so rather than reporting a failure.
    //
    // An ABSENT entry means nothing has been asked for yet, which is neither
    // loading nor an error and must not be rendered as either.
    knowledge: new Map(),
    // The write step ③ makes, and its refusal. Both null/false until somebody
    // adds or removes a wiki.
    knowledgeSaving: false,
    knowledgeSaveError: null,

    // ── THE HONESTY METER'S ONE READ (v3.63.0) ─────────────────────────
    //
    // `GET /api/memory/:domain/:project/capture` — an aggregation over the
    // local, content-free MCP usage log. STAMPED WITH ITS PAIR, not just its
    // domain like `knowledge` above: this reading is about ONE PROJECT, and a
    // payload for the project the user has just left would paint another
    // project's sessions under this one's heading — the exact false-reading
    // class the strip the memory layer exists for was built to avoid.
    // `null` means nothing has been asked for yet, which is neither loading
    // nor an error and must not be rendered as either.
    capture: null,
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
  // THE TABLE'S FOOTER. Like "Show more" on the journal it can REMOVE itself
  // (the last press exhausts the list), so it needs the fallback below.
  'mem-ws-more',
  // BOTH FOLD SUMMARIES. A <summary> is focusable and a render replaces the
  // pane it sits in, so without these a keyboard user who has just toggled one
  // is dropped to <body>. `mem-fold-brief` joined when the brief became a fold
  // again in v3.58.0.
  // `mem-fold-foundations` joined in v3.59.0 with tier 0's own fold. The rows
  // INSIDE it deliberately do not: each carries a stable id derived from its
  // slug, and a row press causes no render at all, so there is nothing for the
  // capture/restore pass to do — see fndRowHtml.
  // `mem-fold-streams` joined in v3.62.0 with the work-stream table's own fold.
  'mem-fold-journal', 'mem-fold-brief', 'mem-fold-foundations', 'mem-fold-streams',
  // `mem-fold-capture` joined in v3.63.0 with the honesty meter's session
  // list, for the same reason as its four siblings: a <summary> is focusable,
  // and this screen re-renders on a poll.
  'mem-fold-capture',
  // THE METER'S OWN ⓘ. A real <button> emitted by `renderInfoMark`, and the
  // panel it opens carries the limits of the reading — what a session is, that
  // a client label is self-reported, and what the log cannot see. Without this
  // entry a keyboard user reading that panel is dropped to <body> on the next
  // poll, which is the case the strip's own mark is here for.
  // The capture reading's ⓘ button left this list with the mark in v3.65.1 —
  // what a session IS is step ②'s explanation now, and mem-layers-info-btn two
  // lines down is the page's other mark. A stale id here would be a focus
  // target that resolves to nothing, which is why it is deleted rather than
  // left "harmlessly" behind.
  // ── THE STRIP'S ⓘ AND STEP ③'s TWO DOORS (v3.62.0) ───────────────────
  // The mark explains every age on the page and is a real <button>; a render
  // replaces the pane it sits in, so without it a keyboard user reading the
  // panel is dropped to <body> on the next poll — the same reason the two
  // header marks below are here. The two doors LEAVE the view, which is a
  // render of its own; neither removes itself, so neither needs a fallback.
  'mem-layers-info-btn', 'mem-k-domains', 'mem-k-chat',
  // The sidebar's pointer to the one create path. It causes a view change.
  'mem-new-project',
  // "Refresh from repo". It survives its own click (it is disabled while the
  // copy runs and comes back enabled), so it needs no fallback below — but it
  // DOES need to be captured, because the click causes two renders.
  'mem-fnd-refresh',
  // ── TIER 0'S OWN EDITOR (v3.61.0) ─────────────────────────────────────
  // Every control here that REMOVES itself on click also has an entry in
  // FOCUS_FALLBACK below; the ones that survive their own click are captured
  // only because the click causes a render that would otherwise drop focus to
  // <body>. `mem-fnd-add` and `mem-fnd-addrepo` open something in their own
  // place; the three confirm strips replace themselves with an outcome.
  'mem-fnd-add', 'mem-fnd-addrepo', 'mem-fnd-mirror',
  'mem-fnd-slug', 'mem-fnd-title', 'mem-fnd-text',
  'mem-fnd-save', 'mem-fnd-cancel', 'mem-fnd-preview',
  'mem-fnd-discard', 'mem-fnd-keep',
  'mem-fnd-delete', 'mem-fnd-delete-go', 'mem-fnd-delete-no',
  'mem-fnd-shrink-go', 'mem-fnd-shrink-no',
  // The ownership chooser's own commit, on a project that has no manifest.
  'mem-fnd-init-go',
  // ── WP-V2's NEW CONTROLS ──────────────────────────────────────────────
  // `mem-fnd-file-btn` and `mem-fnd-init-files-btn` are the real <button>s
  // that click a `hidden` file input (P1-7): the input itself is out of the
  // tab order, so the BUTTON is what focus can be on when the file dialog
  // returns and a render repaints the pane.
  'mem-fnd-file-btn', 'mem-fnd-init-files-btn',
  // The drafting ask and the Domains pointer. Neither removes itself, but each
  // causes a render (a copy outcome; a view change), and a render replaces the
  // pane they sit in.
  'mem-fnd-ask', 'mem-fnd-to-domains',
  // The ⓘ beside the drafting ask, for the reason the two header marks below
  // are here: a keyboard user reading the panel is dropped to <body> on the
  // next poll without it.
  'mem-fnd-ask-info-btn',
  // BOTH ⓘ MARKS. They are real <button>s emitted by renderViewHeader, and a
  // render replaces the pane they sit in — so without these two entries a
  // keyboard user reading either panel is dropped to <body> on the next poll.
  // The ids are the component's own derivation from the title (and, for the
  // rail, from the variant): see renderViewHeader's panelId block.
  // ── DERIVED FROM THE TITLE, SO THEY MOVED WITH IT (v3.62.0, A4) ──────
  // renderViewHeader builds the panel id as
  // `'tx-vh-info-' + slugForId(title) + (sidebar ? '-sidebar' : '')`, so the
  // rename Agent memory → Project context RE-DERIVES both ids. They are
  // changed in the SAME commit as the two titles deliberately: a title
  // landing without them kills keyboard focus restoration for both marks, and
  // the failure is invisible and permanent — nothing throws, nothing paints
  // differently, a keyboard user is simply dropped to <body> on the next poll.
  'tx-vh-info-project-context-btn', 'tx-vh-info-project-context-sidebar-btn',
  // Both revalidation controls. `mem-reload` is the one that matters: it
  // REMOVES itself on success (the notice it lives in is gone once the
  // reload lands), so it needs the same fallback treatment as "Show more".
  'mem-refresh', 'mem-reload',
  // The brief editor. `mem-brief-edit` REMOVES itself when clicked (the editor
  // replaces it — see renderBrief on why it is withheld while one is open), so
  // it needs the same fallback treatment as "Show more" below; the textarea is
  // where the user actually is.
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
  // The last "Show N more" press paints the remaining rows and takes the
  // button with them. The newly-revealed last row is what the user was
  // reaching for, and it is the nearest stable thing to it.
  'mem-ws-more': '.mem-ws-table tbody tr:last-child .mem-ws-open',
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
  // ── TIER 0'S EDITOR (v3.61.0) ─────────────────────────────────────────
  // "Add document" and "Add from repository" are both replaced by what they
  // open, so restoring by id would drop focus every time they WORKED. The
  // field the person asked for is where they should land.
  'mem-fnd-add': '#mem-fnd-text',
  'mem-fnd-addrepo': '.fnd-init-path',
  'mem-fnd-mirror': '.fnd-init-remote-fields .fnd-init-path',
  // Save and Cancel both dismiss the editor; the row's own Edit control is
  // gone with the row that is about to be re-read, so the nearest stable
  // thing that does the same KIND of thing is the fold the table sits in.
  'mem-fnd-save': '#mem-fold-foundations',
  'mem-fnd-cancel': '#mem-fold-foundations',
  // Discard closes the editor; Keep editing dismisses only the bar.
  'mem-fnd-discard': '#mem-fold-foundations',
  'mem-fnd-keep': '#mem-fnd-text',
  // The three confirm strips. Each replaces itself: a taken confirm performs
  // the action and the strip goes with it, a declined one just closes.
  'mem-fnd-delete': '#mem-fnd-text',
  'mem-fnd-delete-go': '#mem-fold-foundations',
  'mem-fnd-delete-no': '#mem-fnd-text',
  'mem-fnd-shrink-go': '#mem-fold-foundations',
  'mem-fnd-shrink-no': '#mem-fnd-text',
  // Choosing an ownership replaces the whole block body with a table.
  'mem-fnd-init-go': '#mem-fold-foundations',
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

// ═════════════════════════════════════════════════════════════════════════
// THE PROJECT CACHE — why a screen that revalidates also remembers
// ═════════════════════════════════════════════════════════════════════════
//
// Reported from production: *"when you go from project to project, the main
// content of the project is loaded on the right side with some delay — not
// good UX."* Measured in a browser against a real store (four projects, up to
// 22 work-streams), on the shipped code: ONE switch cost THREE requests, THREE
// whole-column repaints, and the column collapsed from 5,062px to **215px**
// for a frame in between. Going BACK to a project cost exactly the same as
// arriving at it the first time, although nothing about it had changed.
//
// So this holds what has already been read, for the life of the page:
//
//   'p:<domain>/<project>'                    -> the index read (+ its `open`)
//   's:<domain>/<project>/<scope>/<machine>'  -> one scoped read
//
// ── WHY IT IS SAFE TO CACHE AT ALL ──────────────────────────────────────
// This is READ-ONLY data and the screen already has the machinery to keep it
// honest: every cached paint is followed by a revalidation of the same read,
// and the index poll keeps `staleWrite` truthful independently. A cache hit is
// therefore not "show something old and hope" — it is "show what you had a
// moment ago while asking again", which is the only way to make a return trip
// cost nothing visible.
//
// ── WHAT IS STAMPED, AND WHY THE STAMP IS THE WHOLE POINT ───────────────
// Each entry carries `at`, the ms at which the READ WAS ISSUED, and a cached
// paint adopts it as `state.detailFetchedAt` rather than resetting the mark to
// now. That is the fail-safe direction: a save that landed while the entry was
// sitting in this Map is then reported as stale (the Reload offer appears)
// rather than hidden behind a fresh-looking timestamp. Resetting the mark on a
// cache hit would make the screen quietly claim a five-minute-old document was
// read just now — the exact fact-and-absence collapse this view refuses
// everywhere else.
//
// ── IT SURVIVES freshState(), AND ONLY IT DOES ──────────────────────────
// `onEnter` reassigns `state = freshState()`, which is right: the selection,
// the folds, the editor and every loading flag belong to one visit. The cache
// is not UI state — it is a copy of what the server said — so it lives out
// here and a re-entry into the view repaints instantly instead of re-fetching
// the whole install. It is cleared by a reload of the page, and by nothing
// else; on a write it is INVALIDATED for that project (see `forgetProject`),
// because a brief save is the one moment this view knows its own copy is out
// of date before the server says so.
//
// BOUNDED. `MAX_CACHE` entries, oldest-inserted evicted first (a Map iterates
// in insertion order, and re-reading a project REPLACES its entry, so the
// order is genuinely "least recently fetched"). A number rather than no
// number: a user who clicks through two hundred projects should not be
// carrying two hundred handoff documents in memory for the life of the tab.
const readCache = new Map();
// ── STEP ③'s ONE READ, CACHED PER DOMAIN (v3.62.0, P1-8) ────────────────
// Two projects of one domain draw on ONE wiki, so switching between them must
// not re-issue the request; switching domain must not paint the previous
// domain's figures. Unbounded on purpose: one small object per domain the user
// has visited in this mount, and an install has tens of domains rather than
// thousands of projects — the LRU below exists because a project read carries
// a whole handoff document, which this does not.
const knowledgeCache = new Map();
// The domains a stats read is in flight for, so two project switches inside
// one domain — or two rows naming one domain — do not issue two requests.
// A SET since v3.65.0, because a project draws on N wikis and a single slot
// could only ever hold the last one asked for.
const knowledgeInFlight = new Set();

// ── THE METER'S READ, CACHED PER (DOMAIN, PROJECT) (v3.63.0) ────────────
// The same discipline as `knowledgeCache` one line up, keyed one level finer
// because the reading is per project. Switching back to a project already read
// paints the meter in the frame the click lands; only a genuine miss costs a
// second paint. Unbounded for the same reason: one small object per project
// visited in this mount, carrying counts and at most CAPTURE_SESSION_LIMIT
// rows — never a document, which is what the LRU above exists for.
const captureCache = new Map();
// The (domain, project) a capture read is in flight for, so two rapid switches
// back and forth do not issue two requests. Cleared when that read settles.
let captureInFlight = null;

// ── THE INSTALL'S DOMAIN LIST (v3.65.0) ────────────────────────────────
// Read ONCE per mount and held in `state.domainList`, so the in-flight mark
// is a bare boolean rather than a key: there is one list and it does not
// change while a mount lives (a domain created in another view arrives with
// the next mount, which is the same staleness every other list on this
// screen accepts).
let domainListInFlight = false;

const MAX_CACHE = 24;

// Written across three lines rather than one because `extractFunction` in
// scripts/test-next-memory-view.js lifts a function by brace-matching and
// requires its closing brace to start a line — a one-liner reads as a desync.
function cacheKeyProject(domain, project) {
  return 'p:' + keyOf(domain, project);
}
function cacheKeyScope(domain, project, scope, machine) {
  // The machine the caller ASKED for, not the one the server resolved: with no
  // machine named the store picks the newest, and which one that is can change
  // between reads. Keying on the resolved name would hand a later "let the
  // server choose" request an answer that was pinned to one folder.
  return 's:' + keyOf(domain, project) + '/' + String(scope) + '/' + (machine || '');
}

function cacheGet(key) {
  return readCache.get(key) || null;
}

function cachePut(key, data, at) {
  if (!data) return;
  if (readCache.has(key)) readCache.delete(key);
  readCache.set(key, { data, at });
  while (readCache.size > MAX_CACHE) {
    const oldest = readCache.keys().next();
    if (oldest.done) break;
    readCache.delete(oldest.value);
  }
}

/** Drop every entry for one project. Called wherever this view learns its copy is wrong. */
function forgetProject(domain, project) {
  const exact = cacheKeyProject(domain, project);
  const prefix = 's:' + keyOf(domain, project) + '/';
  for (const k of [...readCache.keys()]) {
    if (k === exact || k.indexOf(prefix) === 0) readCache.delete(k);
  }
}

/**
 * Is this payload the same one we are already painting?
 *
 * Compared as JSON rather than field by field, and over the WHOLE payload
 * rather than over a chosen projection: a revalidation exists to notice a
 * change, and a comparator that knows which fields matter is a second copy of
 * `screenSignature` free to disagree with it. The one thing excluded is the
 * family of age figures, which the server recomputes against its own `now` on
 * every read — leave them in and no two responses are ever equal, so every
 * revalidation would repaint and the cache would buy nothing. The STAMPS they
 * are derived from (`writtenAt`, `lastWriteAt`, `savedAt`) stay in the
 * comparison, so a genuinely newer save still differs.
 */
function payloadSignature(data) {
  return JSON.stringify(data, (k, v) => (
    (k === 'ageSeconds' || k === 'writtenAgeSeconds' || k === 'arrivedAgeSeconds') ? 0 : v));
}

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
      // ── ONE POPOVER TO CLOSE AGAIN (v3.65.0) ───────────────────────
      // The scope and machine pickers were deleted in v3.55.0 and this step
      // went with them; step ③'s wiki picker brings it back, and the reason
      // is unchanged: `navigate()` explicitly does not reach into view-owned
      // popovers, so a menu left open on a rail click is this view's to shut
      // or it outlives the view that opened it.
      closeAllListboxes();
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

// ── Remembering which of the two folds you had open (v3.58.0) ─────────────
//
// THE DEFAULT IS CLOSED, AND IT IS A DEFAULT RATHER THAN A STATE. The
// maintainer's report on the v3.56.0 page was that the standing brief "is
// usually a page or more and takes a lot of scrolling", and the measurement
// agreed: on this repo's own `curator` project the brief block was 2,100px of
// a 3,241px page — 65% of the screen given to the one section that changes
// least. Both long sections are folds now, both start shut, and the summary
// line carries enough to decide whether to open.
//
// WHY THIS IS PERSISTED AND `openFolds` ALONE IS NOT ENOUGH. `state.openFolds`
// is rebuilt by `freshState()` on every mount, so a fold opened before a walk
// to the Wiki and back would be shut again — which is the same "the app forgot
// what I was doing" complaint one layer up from the one the last-project map
// already answers. Same key shape, same discipline, same failure mode: this is
// a convenience, so a browser that refuses storage must make the app FORGET,
// never break.
//
// ONLY `true` IS KEPT ON READ. Closed is the default, so an absent key and a
// stored `false` mean exactly the same thing, and storing the difference would
// invent a third state ("deliberately closed") that nothing reads. That also
// bounds what a hand-edited value can do to `renderBrief`/`renderJournal`: the
// map they see holds nothing but `true` under a known name.
//
// THE WRITE IS NOT HERE. It is inlined in `wire()`'s toggle listener, which may
// not name a module-level helper — that function is lifted by brace-matching
// and EXECUTED against a hand-written set of stubs in
// scripts/test-agent-instructions.js, so a call to `rememberFold(...)` there
// would be a ReferenceError, i.e. a crash rather than a failing assertion (the
// v3.11.0 shape this file warns about twice). The duplicated key literal is
// pinned against this constant by scripts/test-next-memory-view.js §19.
const FOLDS_KEY = 'curator-memory-folds-v1';
// `streams` joined in v3.62.0, when the work-stream table became a fold of its
// own inside step ②. It is the one long list on this page that could not be put
// away — WS_STEP_ALL_MAX is 20 rows — and v3.58.0's measurement (the page
// 3,241 → 1,278px once the brief and the journal folded) is the reason.
// `capture` joined in v3.63.0 with the honesty meter's session list. The
// READING above it never folds (v3.16.1) — only the per-session detail does.
// `saved` joined in v3.64.2 and its ROW LEFT in v3.65.1 — "Last saved" said what
// the MEMORY overview tile and the Handoffs row's own summary already say, in a
// second shape (a card wrapping a row, whose reading ended 15px short of every
// other row's). The NAME stays for the same reason `knowledge` does, one line
// down: a user who had it open before updating has `{"saved": true}` on disk,
// and dropping the name would make that value unreadable rather than harmless.
// `knowledge` stays in the list although step ③ no longer uses it, for exactly
// that reason.
const FOLD_KEYS = ['brief', 'journal', 'foundations', 'streams', 'capture', 'saved', 'knowledge'];
// The per-domain form step ③ writes since v3.65.0, and the ONLY dynamic key
// this map accepts. The alphabet is the domain-name one and the length bound
// is the store's, so a hand-edited value can add at most a bounded number of
// `true`s under names nothing else reads.
const KNOWLEDGE_FOLD_RE = /^knowledge-[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function readRememberedFolds() {
  try {
    const raw = localStorage.getItem(FOLDS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    for (const k of FOLD_KEYS) if (parsed[k] === true) out[k] = true;
    // ── ONE KEY PER KNOWLEDGE DOMAIN (v3.65.0, P10) ───────────────────
    // Step ③ is one row per chosen wiki, so its keys carry the domain:
    // `knowledge-<slug>`. NO NEW localStorage KEY — these live in the same
    // map under the same name, so scripts/test-ui-state.js's registry does
    // not move. The grammar is what bounds a hand-edited value: the slug is
    // the domain-name alphabet and at most 64 characters, and only `true`
    // survives, exactly as for the six fixed names above.
    for (const k of Object.keys(parsed)) {
      if (parsed[k] === true && KNOWLEDGE_FOLD_RE.test(k)) out[k] = true;
    }
    return out;
  } catch {
    return {};
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
  //
  // ── AND IT PAINTS A WINDOW, SO THE MARK IS THE WINDOW ──────────────────
  // v3.56.0 cut the table to the newest five with a "Show N more" footer. The
  // mark is therefore the rows that are ON SCREEN plus the NUMBER that is not:
  // folding in every row would repaint the pane when a hidden row's age crossed
  // a band — no pixel moves, and the repaint would close the ⓘ and churn focus
  // — while folding in the shown rows ALONE would miss a save appearing behind
  // the footer, whose count line and label both have to move. The hidden count
  // is a number rather than a projection for the same reason: what those rows
  // SAY is not on screen, only how many of them there are.
  const pr = state.projectRead;
  const wsOrdered = pr && Array.isArray(pr.scopes) ? workStreamOrder(pr.scopes) : null;
  const wsPainted = wsOrdered ? wsShownCount(wsOrdered, state.detail, state.wsWindow) : 0;
  const tableRows = wsOrdered
    ? wsOrdered.slice(0, wsPainted).map((s) => [
      s && s.scope, (s && s.machine) || null, (s && s.headline) || null,
      formatAge(effectiveSave(s).seconds),
      (s && s.harness) || null, (s && s.model) || null,
    ])
    : null;
  const wsHidden = wsOrdered ? wsOrdered.length - wsPainted : 0;
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
  // THE SIZE RIDES WITH THE AGE (v3.58.0). The brief's fold summary quotes a
  // word count, and a save that lands inside the same age band as the last one
  // ("just now" twice) would otherwise move nothing here — the closed summary
  // would go on quoting the size of a document that is no longer on disk.
  //
  // IT IS THE CHARACTER LENGTH, NOT `briefStats(...).words`, and that is
  // deliberate twice over. It is a plain expression rather than a call, so this
  // function keeps naming no collaborator beyond the ones every harness that
  // lifts it already injects (scripts/test-memory-truth.js §8b executes
  // `screenSignature` against a fixed set, and a free identifier there is a
  // CRASH rather than a failing assertion — the v3.11.0 shape). And it is
  // STRICTLY MORE sensitive than the word count it stands in for: every edit
  // that changes the word count changes the length, and some that do not also
  // trip it. Erring towards one extra repaint is the fail-safe direction; a
  // figure that has quietly stopped being true is not.
  const briefMark = pr && pr.brief && pr.brief.present
    ? [formatAge(effectiveSave({ savedAt: pr.brief.updatedAt }).seconds),
      (pr.brief.text || '').length] : null;

  // ── TIER 0 IS A PANE, AND ITS FRESHNESS IS A COMPUTED READING ──────────
  //
  // The same lesson as the picker and the save strip, one block further down: a
  // no-op guard that cannot see a pane is not a guard for that pane. And this
  // pane is the one whose figures can change with NOTHING ELSE on the screen
  // moving — `freshness` is recomputed by the store on every read against the
  // file in the checkout, so a colleague's `git pull` turns six rows from
  // `fresh` to `stale`, the summary line's word changes, the Status block's
  // reading changes, and not one timestamp, byte count or work-stream has
  // moved. Without the freshness in this mark the block would go on painting
  // "fresh" over documents that had stopped being it.
  //
  // A PLAIN EXPRESSION, naming no collaborator this function does not already
  // use. `screenSignature` is LIFTED and EXECUTED against a fixed set of
  // injected functions (scripts/test-memory-truth.js §8b), so a call to a
  // foundations helper here would be a ReferenceError — a CRASH rather than a
  // failing assertion, which is the v3.11.0 shape this file warns about.
  // `formatAge` + `effectiveSave` are both in that set and are used the same
  // way `briefMark` uses them, so the age moves the mark exactly when the
  // painted words do.
  const fnd = pr && pr.foundations && typeof pr.foundations === 'object' ? pr.foundations : null;
  const fndMark = fnd
    ? [fnd.ownership || null, fnd.manifestError || null,
      (Array.isArray(fnd.orphanFiles) ? fnd.orphanFiles.length : 0),
      (Array.isArray(fnd.documents) ? fnd.documents : []).map((d) => [
        d && d.slug, (d && d.title) || null, (d && d.role) || null,
        (d && d.freshness) || null, (d && d.bytes) || 0,
        (d && d.commit) || null,
        d && d.updatedAt ? formatAge(effectiveSave({ savedAt: d.updatedAt }).seconds) : null,
      ])]
    : null;
  // The Refresh control's own three states — absent, offered, working — each of
  // which is a different set of pixels. Stamped, so a result belonging to
  // another project cannot hold this one's paint.
  const fndActionMark = state.fnd
    ? [state.fnd.domain, state.fnd.project, !!state.fnd.busy, state.fnd.error || null,
      state.fnd.result ? Object.keys(state.fnd.result).map((k) => [k, state.fnd.result[k].length]) : null]
    : null;
  // ── TIER 0'S EDITOR AND ITS CHOOSER ARE PANES TOO (v3.61.0) ────────────
  //
  // Same rule as the brief editor below: only the fields that CHANGE PIXELS
  // are folded in — notably NOT the draft text, which moves on every keystroke
  // and is written straight into state without a render so the caret survives.
  // The TITLE and the SLUG are the same case and are excluded for the same
  // reason; what IS folded in is whether the slug is currently VALID, because
  // that flips Save's disabled state, and the draft's byte count, because that
  // crosses the wall.
  //
  // PLAIN EXPRESSIONS, naming no collaborator this function does not already
  // use. `screenSignature` is LIFTED and EXECUTED against a fixed set of
  // injected functions (scripts/test-memory-truth.js §8b), so a call to
  // `fndStats` or to the chooser's own helpers here would be a ReferenceError
  // — a CRASH rather than a failing assertion, the v3.11.0 shape this file
  // warns about three times. `.length` on the draft stands in for the byte
  // count for the same reason `briefMark` uses it: strictly more sensitive
  // than the figure it stands for, and one extra repaint is the fail-safe
  // direction.
  // THE FOUNDATIONS FOLD'S FORCED-OPEN TRANSIENT (v3.64.1) is a thing ON
  // SCREEN — it decides whether the documents fold paints open — and it is
  // not derivable from anything else here: an explicit close clears it while
  // `state.fndEdit` stays exactly as it was. Every writer of it already calls
  // render, so this buys the poll rather than the press; it is folded in
  // because a signature that cannot see a pane is not a guard for that pane.
  const fndForceMark = state.fndForceOpen === true;
  const fe = state.fndEdit;
  const fndEditMark = fe
    ? [fe.domain, fe.project, fe.slug || null, !!fe.isNew, !!fe.loading, !!fe.busy,
      fe.error || null, !!fe.preview, !!fe.confirmDiscard, !!fe.confirmShrink,
      !!fe.confirmDelete, !!fe.deleting, fe.importError || null,
      fe.role || null, (fe.text || '').length, (fe.title || '').length, (fe.slug || '').length]
    : null;
  const fi = state.fndInit;
  const fndInitMark = fi
    ? [fi.domain, fi.project, !!fi.busy, fi.error || null,
      fi.choice ? [fi.choice.ownership, !!fi.choice.seed, !!fi.choice.scanning,
        fi.choice.scanError || null,
        Array.isArray(fi.choice.candidates) ? fi.choice.candidates.length : null,
        Object.keys(fi.choice.picks || {}).length,
        Object.keys(fi.choice.roles || {}).map((k) => [k, fi.choice.roles[k]]),
        fi.choice.roleOpenFor || null,
        (fi.choice.extras || []).map((e) => [e.path, e.role]),
        fi.choice.extraRole || null,
        (fi.choice.imports || []).map((f) => [f.slug || f.name, f.role || null, f.error || null]),
        fi.choice.importError || null] : null,
      Array.isArray(fi.refused) ? fi.refused.map((r) => [r.path, r.reason]) : null]
    : null;

  // THE EDITOR IS A PANE TOO, and the same rule applies to it as to the
  // picker and the save strip: a no-op guard that cannot see a pane is not a
  // guard for that pane. Only the fields that CHANGE PIXELS are folded in —
  // notably NOT the draft text, which changes on every keystroke and is
  // written straight into state without a re-render (see wire()), exactly as
  // the Domains lifecycle form does, so that the caret survives.
  // ── STEP ③ IS A PANE, AND ITS FIGURES COME FROM A DIFFERENT READ ──────
  //
  // The same lesson as every mark above it: a no-op guard that cannot see a
  // pane is not a guard for that pane. Nothing else in this signature can see
  // `state.knowledge` — it is filled by its own request, on a different clock
  // from the project read — so the stats landing, or a later ingest moving the
  // page count, would leave step ③ painting a figure that had stopped being
  // true and the poll would skip the render that fixes it.
  //
  // THE FOUR FIELDS THE STEP ACTUALLY PAINTS, plus the domain stamp and the
  // error, and nothing else: a whole payload folded in would repaint the page
  // when `conversationCount` moved, which this step does not show.
  // `lastIngestDate` is a `YYYY-MM-DD` string, so the day-age WORD and the
  // day-freshness DOT both change exactly when it does — folding the rendered
  // age in as well would be a second copy of one fact, the same call the rail
  // rows make about their own dot.
  //
  // A PLAIN EXPRESSION, naming no collaborator this function does not already
  // use. `screenSignature` is LIFTED and EXECUTED against a fixed set of
  // injected functions (scripts/test-memory-truth.js §8b), so a call to
  // `formatDayAge` or to `renderKnowledge` here would be a ReferenceError — a
  // CRASH rather than a failing assertion, which is the v3.11.0 shape this
  // file warns about four times.
  //
  // THE STRIP'S OTHER TWO TIERS ARE NOT FOLDED IN, and that is deliberate.
  // Cell ①'s tier is cut on `facts.stale` / `facts.unreachable` / `facts.fresh`,
  // every one of which is derived from `fndMark`'s per-document freshness
  // above; cell ②'s is `freshnessTier`, which is cut on `formatAge`'s own unit
  // bands, and `savedMark` and `newestMark` already fold that word through
  // `formatAge`. Neither dot can change without something already in this
  // signature changing first — folding them in would be a second copy of one
  // fact, which is the call this function already makes about the rail's dot.
  //
  // A MAP SINCE v3.65.0, because a project draws on N wikis. Every entry is
  // folded in, keyed by its domain, so a second wiki's figures landing is a
  // change this signature can see — the whole lesson this block records, one
  // row wider. The keys are sorted so two identical sets in different
  // insertion orders produce one signature.
  const kn = state.knowledge instanceof Map ? state.knowledge : null;
  const knowledgeMark = kn
    ? [...kn.keys()].sort().map((d) => {
      const e = kn.get(d);
      return [d, e.error || null, e.gone === true,
        e.data ? [e.data.pageCount, (e.data.pageCounts || {}).entities,
          (e.data.pageCounts || {}).concepts, (e.data.pageCounts || {}).summaries,
          e.data.lastIngestDate || null, e.data.lastIngestKind || null,
          e.data.lastIngestTitle || null] : null];
    })
    : null;

  // ── THE HONESTY METER IS A PANE, AND ITS FIGURES COME FROM A THIRD READ
  //    (v3.63.0) ─────────────────────────────────────────────────────────
  //
  // The same lesson this function has now learned six times: a no-op guard
  // that cannot see a pane is not a guard for that pane. `state.capture` is
  // filled by its own request against its own clock, and nothing else in this
  // signature can see it — so the reading landing, or a session that saved
  // arriving from an agent working in another window, would leave the meter
  // painting a figure that had stopped being true and the poll would skip the
  // render that fixes it. MISS THIS AND THE STEP PAINTS A STALE FIGURE, which
  // on the one reading whose subject is honesty is worse than no reading.
  //
  // THE AGE OF THE NEWEST SESSION RIDES WITH IT, folded through `formatAge`
  // for the reason every other age here is: the mark must move exactly when
  // the PIXELS do. A raw timestamp never changes (so the row's clock would
  // freeze between bands) and a raw age in seconds changes every tick (so
  // every poll would repaint, closing the ⓘ somebody is reading).
  //
  // A PLAIN EXPRESSION, naming no collaborator this function does not already
  // use. `screenSignature` is LIFTED and EXECUTED against a fixed set of
  // injected functions (scripts/test-memory-truth.js §8b), so a call to
  // `captureFacts` or `renderCaptureMeter` here would be a ReferenceError — a
  // CRASH rather than a failing assertion, the v3.11.0 shape this file warns
  // about five times. `effectiveSave({ savedAt })` is the same borrowing
  // `briefMark` makes of a plain ISO stamp: only `.seconds` is read, and the
  // `source` it also computes is meaningless for a session and is not used.
  const cap = state.capture && state.capture.domain === state.activeDomain
    && state.capture.project === state.activeProject ? state.capture : null;
  const capData = cap && cap.data && typeof cap.data === 'object' ? cap.data : null;
  const capTotals = capData && capData.totals && typeof capData.totals === 'object'
    ? capData.totals : null;
  const capRows = capData && Array.isArray(capData.sessions) ? capData.sessions : [];
  const captureMark = cap
    ? [cap.domain, cap.project, cap.error || null,
      capData
        ? [capData.logPresent === true, capData.note || null,
          // v3.64.1: the stale-bridge flag also moves the LIMITS line under
          // the note (the legacy clause defers to the two log-limit notes and
          // not to this one), so it is a second pixel-moving fact rather than
          // a restatement of `note`.
          capData.noSessionsButSaves === true,
          capTotals
            ? [capTotals.sessions, capTotals.sessionsRead, capTotals.sessionsSaved,
              capTotals.sessionsReadNotSaved, capTotals.legacyLines, capTotals.selfTestLines]
            : null,
          capData.sessionsTruncated === true, capData.sessionsShown,
          capRows.map((r) => [r && r.sid, (r && r.client) || null, (r && r.calls) || 0,
            r && r.read === true, r && r.saved === true,
            formatAge(effectiveSave({ savedAt: (r && (r.endedAt || r.startedAt)) || null }).seconds)])]
        : null]
    : null;

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
    wsHidden,
    savedMark,
    newestMark,
    sharedMark,
    briefMark,
    fndMark,
    fndActionMark,
    fndForceMark,
    fndEditMark,
    fndInitMark,
    knowledgeMark,
    captureMark,
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
  // This path proves the project's work-stream list has MOVED since the cached
  // copy was taken, and it cannot replace that copy itself — its read carries
  // no `open`, so an entry written from here would be unadoptable anyway.
  // Dropping it is the honest outcome: a later return to this project pays one
  // request rather than painting a list this function has just proved wrong.
  forgetProject(domain, project);
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
  // opens a pair it chose rather than one the user did — it passes
  // `{deliberate: false}`, so `state.machine` stays null and the machine that
  // came back sits only in `state.detail.machine`; reading it back here turned
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

  // RELOAD MEANS "MY COPY IS STALE". Every cached read for this project goes,
  // before the first request rather than after the last: a cache hit inside
  // this call, or one served to a project switch that happens while it is in
  // flight, would make the one control whose entire meaning is "go and look
  // again" inert — which is the defect this button exists to answer.
  forgetProject(domain, project);

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
  // freshest, which is what selectProject would have chosen anyway — and
  // "freshest" means the same thing in both places or the claim is empty, so
  // this takes the head of `workStreamOrder` rather than `scopes[0]`, for the
  // reasons written out at that call site.
  if (scopes.some((s) => s.scope === wantScope)) {
    await loadScope(wantScope, wantMachine, token);
    return;
  }
  const pick = workStreamOrder(scopes)[0];
  await loadScope(pick.scope, pick.machine || null, token, { deliberate: false });
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
  //
  // THE CACHE GOES FIRST, unconditionally — including when the user has
  // already moved to another project, which is the branch that does NOT
  // re-read. This is the one moment the view knows its own copy is wrong
  // before any server says so: a stale entry would otherwise paint the
  // pre-save brief the next time they came back, and the revalidation behind
  // it would correct it a frame later, which reads as the save having failed.
  forgetProject(e.domain, e.project);
  state.briefEdit = null;
  if (activeKey() === key) {
    await reloadActive(token);
    refreshIndex(token).catch((err) => reportAsyncMountFailure(token, err));
  } else {
    render(token);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// THE HANDOFF FROM ANOTHER VIEW — one project, once (P1-10)
// ══════════════════════════════════════════════════════════════════════════
//
// ── THE PROBLEM ─────────────────────────────────────────────────────────
// `navigate()` takes ONE argument — a view name, no parameters — and this
// view's arrival path picks the domain by SAVE RECENCY and then the project
// from a remembered-per-domain map. A project created a second ago has no
// saves, so it loses the recency question outright: "Open in Agent memory"
// after a create would land on whichever project last had an agent write to
// it, which is a navigation that works most of the time. That is the worst
// property a navigation can have, and it is why writing the remembered map
// was rejected as the cheap fix.
//
// ── WHY A MODULE VARIABLE IS THE RIGHT ANSWER, NOT A STOPGAP ────────────
// Three properties, and each one is the reason a more obvious option was not
// taken:
//
//   · IT CANNOT GO STALE, because it is CLEARED ON READ. A parameter left in
//     `localStorage` would re-open a project the owner had navigated away from
//     three days later; this survives exactly one arrival.
//   · IT NEEDS NO STORAGE. No new key, and nothing to migrate or forget.
//   · IT LEAVES `initialPick` PURE. The decision function keeps its whole
//     suite and its whole contract; this is consulted BEFORE it, so the
//     ordinary arrival is byte-identical to what it was.
//
// The alternative — `navigate(name, params)` — is the correct long-term shape
// and touches the shell's single navigation chokepoint and every call site's
// assertions. It is not this release's work.
//
// ── THE HAZARD THIS SHAPE RESPECTS ──────────────────────────────────────
// `wire()` in this file is LIFTED by brace-matching and EXECUTED against a
// hand-written stub set in scripts/test-agent-instructions.js, so a free
// identifier named inside it is a CRASH there rather than a failing assertion.
// This function is named inside `loadIndex` only — never `wire()` — and the
// WRITER is views/domains.js, which calls the export.
let pendingProject = null;

/**
 * ASK THIS VIEW TO OPEN ONE PROJECT ON ITS NEXT ARRIVAL.
 *
 * Called by views/domains.js immediately before `navigate('memory')`, so the
 * mount that follows consumes it. Both names are required: a request naming
 * only a project would have to guess the domain, which is the ambiguity
 * `list_projects` refuses to guess at one layer down.
 *
 * Exported rather than reached for, and consumed rather than read, so there is
 * exactly one writer, one reader and no lifetime longer than one navigation.
 */
export function requestProject(domain, project) {
  const d = String(domain == null ? '' : domain).trim();
  const p = String(project == null ? '' : project).trim();
  if (!d || !p) { pendingProject = null; return; }
  pendingProject = { domain: d, project: p };
}

/**
 * THE REQUEST, IF THERE IS ONE, AND ONLY ONCE.
 *
 * Clearing here — at the READ, not at the use — is what makes the staleness
 * argument hold: whatever `loadIndex` then does with it, including deciding it
 * names a project this index does not have, the request is spent.
 */
function takePendingProject() {
  const want = pendingProject;
  pendingProject = null;
  return want;
}

async function loadIndex(token) {
  const gate = loadGate;                 // capture: the next mount replaces it
  // ── THE DOMAIN LIST, IN PARALLEL AND UNAWAITED (v3.65.0) ─────────────
  // It is needed by the rail (the identity colour is the domain's place in
  // THIS list) and by step ③'s picker, and it is independent of the index —
  // so it goes out beside it rather than behind it, and a slow answer never
  // delays the first paint. Its own arrival renders; until then the rail
  // falls back to its local order.
  loadDomainList(token).catch((err) => reportAsyncMountFailure(token, err));
  const got = await fetchIndex(token);
  if (!isCurrentMount(token)) return;
  if (got) {
    state.projects = got.projects;
    state.domainsScanned = got.domainsScanned;
    state.indexError = got.error;
  }

  // ── THE HANDOFF IS CONSULTED BEFORE THE ORDINARY DECISION (P1-10) ──────
  // And it is VERIFIED against the index rather than trusted: a project
  // created a moment ago should be in this list, but if the create succeeded
  // and the index read raced it, opening a project that is not there would
  // paint an error under a name nothing can answer about. When the row is
  // missing the ordinary arrival takes over — the owner lands somewhere real,
  // which is a worse answer than the one they asked for and a much better one
  // than a broken screen.
  const want = takePendingProject();
  const asked = want && Array.isArray(state.projects)
    ? state.projects.find((r) => r && r.domain === want.domain && r.project === want.project)
    : null;
  const pick = asked || initialPick(state.projects, readRememberedProjects());

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

/**
 * OPEN A PROJECT — one request, one code path, and no blank column.
 *
 * ── THE REPORT, AND WHAT WAS MEASURED ────────────────────────────────────
 * *"When you go from project to project, the main content of the project is
 * loaded on the right side with some delay — not good UX, missing
 * transitions."* Reproduced in a browser on a real store (four projects, up
 * to 22 work-streams). The shipped path cost, per switch:
 *
 *   · THREE requests — the index, the project's scope list, and then the
 *     scoped read, the last two strictly in series because the third's URL
 *     is not knowable until the second has answered;
 *   · TWO whole-column repaints, the FIRST of them of an empty column;
 *   · a main column that collapsed 3,821px -> **215px** for a frame and then
 *     jumped back, which is what the eye reads as "delay" at 30 ms.
 *
 * Going BACK to a project you had just left cost exactly the same as arriving
 * at it for the first time, although nothing about it had changed.
 *
 * ── THE THREE THINGS THAT CHANGED ────────────────────────────────────────
 *
 *  1. ONE ROUND TRIP. `GET …?open=newest` answers with the work-stream index
 *     AND the pair the table puts first, picked SERVER-SIDE by the same order
 *     rule this view sorts the table by (src/routes/memory.js's
 *     `tableFirstPair`, pinned against `workStreamOrder`). The second request
 *     is gone in the ordinary case — and is still there as a fallback, taken
 *     whenever the server did not answer `open` (an older build) or answered
 *     with a pair this view would not have put first. The view keeps the
 *     decision; the server only offers it the answer in advance.
 *
 *  2. A CACHE, so a return trip costs nothing visible. See `readCache`.
 *
 *  3. NO EMPTY COLUMN. When there is nothing cached the first paint is a
 *     SKELETON built from the index row this view already holds — the real
 *     "Working on" line and the real last-saved reading, with the table and
 *     the brief reserved at their approximate heights — so the click is
 *     acknowledged in its own frame and the column never collapses. See
 *     `renderProjectSkeleton`.
 *
 * WHAT IS UNCHANGED, DELIBERATELY. `loadScope` still drops `state.detail`
 * before painting on the paths that go through it, because showing the old
 * machine list and the old handoff under a new scope's label is a wrong
 * answer stated confidently. This function no longer NEEDS that path in the
 * ordinary case — it never paints a half-resolved project at all.
 */
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
  state.detailError = null;
  state.journalLimit = JOURNAL_PAGE;
  // A window opened on one project says nothing about the next. Reset with the
  // journal's page size and for the same reason: both are "how much of this
  // list have I asked to see", and the answer does not travel.
  state.wsWindow = WS_WINDOW;
  state.staleWrite = false;

  // ── A PROJECT ALREADY READ PAINTS IN THIS FRAME ───────────────────────
  //
  // An entry is ADOPTED only when it can paint the WHOLE screen on its own —
  // index and opened pair together. One that cannot (a payload from a server
  // that does not answer `open`) is treated as a miss rather than half-used,
  // so there is exactly one path that resolves a pair and one place it can go
  // wrong.
  const pKey = cacheKeyProject(domain, project);
  const hit = cacheGet(pKey);
  const fromCache = !!(hit && applyProjectRead(hit.data, hit.at).opened);
  // ── THE CHOSEN WIKIS, AT THE CALL SITE (v3.65.0, P10) ────────────────
  // NOT inside `applyProjectRead`: that function is lifted by brace-matching
  // and executed against a fixed set of injected collaborators, so a new free
  // identifier in its body is a ReferenceError — a CRASH rather than a
  // failing assertion. The v3.64.0 lesson, applied: a new free variable goes
  // at the CALL SITE. There are two (a cache hit here, a fresh read below)
  // and each asks with what it just applied.
  if (fromCache && state.projectRead && Array.isArray(state.projectRead.knowledgeDomains)
    && state.projectRead.knowledgeDomains.length) {
    loadKnowledge(state.projectRead.knowledgeDomains, token)
      .catch((err) => reportAsyncMountFailure(token, err));
  }
  if (!fromCache) {
    state.projectRead = null;
    state.detail = null;
    state.scope = null;
    state.machine = null;
    state.detailLoading = true;
    // The START of the read that is about to produce what goes on screen.
    // Conservative on purpose: a write landing mid-fetch is reported as
    // stale, which costs one reload the user did not strictly need, rather
    // than leaving a stale document presenting itself as current.
    state.detailFetchedAt = Date.now();
    // The one read below produces the scope list as well as the handoff, so
    // the picker's mark starts here too. Set before the await, like its
    // sibling, so a write landing mid-fetch is reported rather than missed.
    state.scopesFetchedAt = state.detailFetchedAt;
  }
  // ── STEP ③'s FIGURES, ASKED FOR BEFORE THE FIRST PAINT (v3.62.0) ─────
  // Deliberately NOT awaited, and deliberately BEFORE the render: an async
  // function runs synchronously up to its first await, and `loadKnowledge`'s
  // cache-hit arm has none — so moving between two projects of one domain
  // paints step ③ filled on the frame the click lands, and only a genuine
  // miss costs a second paint.
  //
  // WITH THE CONTAINING DOMAIN, WHICH IS THE STORE'S OWN DEFAULT. The chosen
  // set rides on the project read and has not landed yet at this point, so
  // this asks for the one wiki that is right unless the owner has chosen
  // otherwise; `applyProjectRead` asks for the rest the moment it knows.
  loadKnowledge([domain], token).catch((err) => reportAsyncMountFailure(token, err));
  // ── AND THE HONESTY METER'S, FOR THE SAME REASON (v3.63.0) ──────────
  // Not awaited and BEFORE the render, exactly like its sibling above: an
  // async function runs synchronously up to its first await and
  // `loadCapture`'s cache-hit arm has none, so returning to a project
  // already read paints the meter on the frame the click lands. Its key is
  // the PAIR rather than the domain, because the reading is per project.
  loadCapture(domain, project, token).catch((err) => reportAsyncMountFailure(token, err));
  render(token);

  // A user-initiated selection is the cheapest honest moment to re-ask the
  // index: the detail fetch below is happening anyway, so the two land
  // together and the sidebar row cannot contradict the picker it sits next
  // to. NOT done for the initial pick, which loadIndex just fetched.
  if (opts.revalidateIndex) {
    refreshIndex(token).catch((err) => reportAsyncMountFailure(token, err));
  }

  // ── THE ONE READ ──────────────────────────────────────────────────────
  //
  // It is the FIRST FILL on a miss and a background REVALIDATION on a hit,
  // and it is deliberately the same request either way: two code paths that
  // must agree about what a project read looks like is how the two would
  // drift.
  const startedAt = Date.now();
  // ── `as: 'project'` IS LOAD-BEARING (v3.62.0, D-G) ────────────────────
  // `GET /:domain/projects` is the PROJECT LIST, and a domain literally named
  // `projects` — the maintainer's own — collides with it: Express matches the
  // list route first and this view gets a payload with no `scopes` in it. The
  // route disambiguates on `?as=project`, which falls through to
  // `GET /:domain/:project`; an unmarked call is byte-identical to every call
  // shipped before it, and any other value is a 400.
  const read = await fetchState(domain, project, { open: 'newest', as: 'project' }, token);
  // STALE-DROP. A reply for a project the user has already left is discarded
  // at the point of use, not merely guarded at the point of render: it must
  // never be written into state at all, or the next render would paint one
  // project's document under another project's header.
  if (!isCurrentMount(token) || activeKey() !== key) return;

  if (!read.data) {
    // A FAILED REVALIDATION CHANGES NOTHING — the same rule refreshIndex
    // follows. What is on screen is still broadly true; report the error only
    // when there is nothing on screen for it to contradict.
    if (!fromCache) {
      state.detailError = read.error;
      state.detailLoading = false;
      render(token);
    }
    return;
  }

  cachePut(pKey, read.data, startedAt);

  // AN IDENTICAL REVALIDATION COSTS NO RENDER AT ALL. The same discipline
  // `screenSignature` applies to the poll: a repaint that changes no pixel
  // still closes an open ⓘ panel and churns focus.
  if (fromCache && payloadSignature(read.data) === payloadSignature(hit.data)) return;

  const applied = applyProjectRead(read.data, startedAt);
  // THE SECOND CALL SITE — see the first, on the cache-hit path above. The
  // chosen wikis ride on the project read and this is the first moment the
  // real set is known; `loadKnowledge` is cached per domain, so the
  // containing domain asked for before the first paint costs nothing here.
  if (Array.isArray(read.data.knowledgeDomains) && read.data.knowledgeDomains.length) {
    loadKnowledge(read.data.knowledgeDomains, token)
      .catch((err) => reportAsyncMountFailure(token, err));
  }
  render(token);
  if (!applied.opened && applied.pick) {
    // The fallback: an older server, or one that picked a pair this view would
    // not have put first. `{deliberate: false}` because the user chose nothing
    // here — see loadScope.
    await loadScope(applied.pick.scope, applied.pick.machine || null, token, { deliberate: false });
  }
}

/**
 * Put ONE project payload on screen — the index half and the pair it opened.
 *
 * Writes state and returns what the caller still has to do; it never renders,
 * because both of its callers know something it does not about whether this is
 * the paint or the revalidation.
 *
 * `at` is when the read that produced `data` was ISSUED, and it becomes both
 * freshness marks. On a cache hit that is a time in the past, deliberately:
 * the Reload offer then appears for a save that landed while the entry sat in
 * the Map, which is the fail-safe direction. Stamping a cached paint with
 * `now` would make the screen claim it had just read a document it had not.
 *
 * @returns {{opened: boolean, pick?: object}} `opened` false means the caller
 *          must still read the pair named by `pick`.
 */
function applyProjectRead(data, at) {
  state.projectRead = data;
  state.detailError = null;
  state.detailFetchedAt = at;
  state.scopesFetchedAt = at;

  const scopes = (data && data.scopes) || [];
  if (!scopes.length) {
    state.detail = null;
    state.scope = null;
    state.machine = null;
    state.detailLoading = false;
    return { opened: true };
  }

  // THE PAIR THIS OPENS IS THE ONE THE TABLE PUTS FIRST, and that is not what
  // the store hands back.
  //
  // ── THE DEFECT (v3.56.0) ───────────────────────────────────────────────
  // This read `scopes[0]` — the store's own order, which is mtime — on the
  // stated grounds that it resolves to the same pair the route's
  // `scope=latest` would. Both are true and both are the wrong clock. **git
  // sets mtime to the moment it wrote the file locally**, so on every synced
  // machine (and on any copied store) mtime says "when this checkout landed"
  // while the table, the dot and the words all read the AGENT'S clock through
  // `effectiveSave`. Measured on a copied 16-pair store: the mtime-first pair
  // was the agent-OLDEST, so the page opened on a two-week-old handoff under a
  // first row reading "5 hr ago", the window STRETCHED to keep that open row
  // visible (all sixteen rows, no "Show more" footer), and the Status block —
  // which the route computes on the agent clock — named a different, fresher
  // work-stream two blocks above. One screen, two clocks, three disagreements.
  //
  // `workStreamOrder` is the order the table PAINTS, so its head is the row the
  // user sees first and the one `wsShownCount` needs no stretch to reach.
  //
  // ── AND WHY THE SERVER'S ANSWER IS CHECKED RATHER THAN TRUSTED ─────────
  // `?open=newest` asks the route to pick by the SAME rule, so in the ordinary
  // case the two agree and the second request is gone. They are still compared
  // here, on the PAIR — scope AND machine, because the table marks its open row
  // off `state.detail` and naming only the scope would let a different copy of
  // it be highlighted far down the list. A disagreement is not an error and is
  // not reported as one: the view falls back to reading the pair IT chose,
  // which is exactly what it did before this option existed. The fallback is
  // also what an older server gets, and what a `null` open (a project whose
  // inner read failed) gets.
  const pick = workStreamOrder(scopes)[0];
  const pre = data && data.open;
  if (pre && pre.scope === pick.scope && (pre.machine || null) === (pick.machine || null)) {
    state.scope = pick.scope;
    // NOT `pick.machine`. `state.machine` means "a machine the USER picked",
    // and nobody picked this one — the same `{deliberate: false}` contract
    // loadScope documents, applied at the site that no longer calls it.
    state.machine = null;
    state.detail = pre;
    state.detailLoading = false;
    return { opened: true };
  }

  state.scope = null;
  state.machine = null;
  state.detail = null;
  state.detailLoading = true;
  return { opened: false, pick };
}

/**
 * Read one (scope, machine) pair and put it on screen.
 *
 * `opts.deliberate === false` REQUESTS the machine without RECORDING it as a
 * choice. The distinction is the whole of the v3.34.0 defect: `state.machine`
 * means "a machine the user picked", and `reloadActive` re-resolves to the
 * newest copy precisely when it is null. The default open (selectProject, and
 * reloadActive's own fallback) names a machine so the pair it opens is the pair
 * it ranked — but nobody chose it, so a later save into a DIFFERENT machine
 * folder must still be what Reload finds. A row press and the machine picker
 * pass no opts and are recorded, because there the pair IS the user's.
 *
 * ── `opts.reader === true` — THE PRESS OPENED AN OVERLAY ────────────────
 * Reported from production: *"accessing the scopes is not fluent and feels
 * buggy."* Measured: a row press repainted the whole main column TWICE
 * underneath the reader — once into an EMPTY column (this function drops
 * `state.detail` and renders before its fetch) and once with the result.
 *
 * Under `reader`, neither happens. The previous pair stays on screen for the
 * length of the fetch — there is no new label above it claiming to describe it,
 * because the document the user is reading is in the overlay — and the arrival
 * is applied by `patchOpenPair`, four targeted DOM writes rather than a
 * `setMain`. The full-render fallback is taken whenever any of that function's
 * preconditions does not hold, so the screen is never left half-updated.
 *
 * ── `opts.cache === true` — MAY THIS READ COME OUT OF THE MAP? ─────────
 * Opt-IN, not opt-out, and the reason is `reloadActive`: the whole meaning of
 * that button is "my copy is stale, go and look again", and a cache hit there
 * would make it inert. Only the row press asks for it. A paginated read (a
 * journal "show more") is never cached at all — the payload is a different
 * page size under the same pair, and one key cannot mean two page sizes.
 */
async function loadScope(scope, machine, token, opts = {}) {
  const domain = state.activeDomain;
  const project = state.activeProject;
  const key = keyOf(domain, project);
  state.scope = scope;
  state.machine = opts.deliberate === false ? null : machine;

  const q = { scope };
  if (machine) q.machine = machine;
  if (state.journalLimit !== JOURNAL_PAGE) q.journalLimit = String(state.journalLimit);
  // Only the DEFAULT journal page is cacheable — see the header.
  const sKey = state.journalLimit === JOURNAL_PAGE
    ? cacheKeyScope(domain, project, scope, machine) : null;
  const hit = (opts.cache && sKey) ? cacheGet(sKey) : null;

  if (hit) {
    state.detail = hit.data;
    state.detailError = null;
    state.detailLoading = false;
    // The read's own time, not now. Same rule as applyProjectRead: a cached
    // paint must not claim to have just read the file.
    state.detailFetchedAt = hit.at;
    if (opts.reader) patchOpenPair(token); else render(token);
  } else if (!opts.reader && !opts.keepDetail) {
    // Drop the previous scope's read before painting: keeping it would render
    // the OLD machine list and the OLD handoff under the NEW scope's label for
    // the duration of the fetch, which is a wrong answer stated confidently.
    state.detail = null;
    state.detailLoading = true;
    render(token);
  }
  // ── `keepDetail`: THE SAME PAIR, MORE OF IT (v3.65.0) ─────────────────
  //
  // THE DEFECT, and it is the maintainer's: *"below Recent saves there is
  // another report card, '24 recorded', and you can Show more, and if I click
  // Show more I'm dropped at the top of the recent saves, which is not good
  // UX."* The mechanism, read from code and then measured in a browser: this
  // function's uncached branch nulls `state.detail` and renders BEFORE the
  // fetch; `renderJournal` opens with `if (!d || !d.journal) return ''`, so
  // the fold the user is reading DISAPPEARS for the whole round trip, the
  // column shrinks, `main.main` clamps its `scrollTop` to the new maximum,
  // and the taller content comes back under a reader who is now above where
  // they were. `restoreFocus` then focuses `#mem-fold-journal` with
  // `preventScroll: true`, so nothing brings the viewport back either.
  //
  // TWO CONTROLS WERE MEASURED so the next reader does not chase the wrong
  // thing: a full `render()` alone does NOT reset scroll, and a work-stream
  // row press goes through `patchOpenPair` and moves neither height nor
  // scroll. The SHRINK is the whole mechanism.
  //
  // So the fix is one word: do not empty the pane you are about to refill.
  // "Show more" is not a scope change — it is the SAME (scope, machine) with
  // a larger `journalLimit` — so the drop-before-paint rule that protects a
  // scope SWITCH from showing the old handoff under the new label has nothing
  // to protect here. The precedent is `showMoreWorkStreams`, which appends in
  // place and renders nothing at all; this keeps the render (the journal's
  // rows, its foot and its summary all move) and only stops the blank frame.
  //
  // A FAILED read still clears the fold, exactly as before: `state.detail` is
  // assigned the answer below whatever this flag said.

  const startedAt = Date.now();
  const read = await fetchState(domain, project, q, token);
  if (!isCurrentMount(token) || activeKey() !== key || state.scope !== scope) return;

  if (hit) {
    // A REVALIDATION. A failure keeps what is on screen; an identical answer
    // costs no paint at all.
    if (!read.data) return;
    cachePut(sKey, read.data, startedAt);
    if (payloadSignature(read.data) === payloadSignature(hit.data)) return;
    state.detail = read.data;
    state.detailFetchedAt = startedAt;
    if (opts.reader) patchOpenPair(token); else render(token);
    return;
  }

  state.detail = read.data;
  state.detailError = read.error;
  state.detailLoading = false;
  if (sKey && read.data) cachePut(sKey, read.data, startedAt);
  if (opts.reader) patchOpenPair(token); else render(token);
}

/**
 * MOVE THE OPEN PAIR WITHOUT REPAINTING THE COLUMN.
 *
 * ── WHY A PATCH AT ALL, WHEN THIS VIEW REPAINTS FOR EVERYTHING ELSE ────
 * Because the column is UNDERNEATH AN OVERLAY at the moment this runs. A
 * `setMain` replaces the pane by innerHTML: it closes every open ⓘ panel,
 * drops the journal fold, moves the scroll position and churns focus — all
 * behind a scrim, for a user who is reading a document and will close it in a
 * moment and find their page rearranged. v3.27.0's rule that a press must be
 * acknowledged in its own frame is satisfied by the reader opening, not by the
 * page behind it flinching.
 *
 * ── WHAT DEPENDS ON `state.detail`, ENUMERATED ─────────────────────────
 * This is a complete list of what `renderProject` computes from the open pair,
 * taken by reading it rather than by guessing, and each one is either patched
 * or proven not to move:
 *
 *   · the breadcrumb's `shared mirror` badge — `d.readonly`, a property of the
 *     DOMAIN, identical for every pair in a project;
 *   · step ②'s NOTICE stack, `renderSaveStatus` + `renderStaleNotice` +
 *     `renderUnlistedNote` — PATCHED, as the one expression `renderProject`
 *     itself composes, so the two cannot drift. It was block ①'s body until
 *     v3.62.0 and is step ②'s `noticeHtml` now; the WRAPPER kept its class
 *     (`.mem-status-stack`) precisely so this selector survived the move;
 *   · `wsShownCount` — GUARDED: if the new pair would change how many rows are
 *     painted, this refuses and a full render happens instead;
 *   · the work-stream rows — PATCHED through the same `wsRowHtml` the painter
 *     and the "Show more" append both use;
 *   · the count line — PATCHED, rebuilt whole rather than edited, for the
 *     reason `showMoreWorkStreams` records;
 *   · the journal fold — PATCHED, and its PRESENCE is guarded: a pair with no
 *     journal at all removes the fold, which is a layout change this cannot
 *     make in place. It is a fold inside step ② since v3.62.0, so the selector
 *     is `.settings-block-context-state [data-mem-fold="journal"]`;
 *   · the standing brief, and step ②'s lede, ⓘ and empty card — all computed
 *     from `read` (the project index) alone, which does not move here;
 *   · THE STRIP — proven not to move rather than patched. Cell ① reads the
 *     foundations index, cell ③ reads the domain's stats, and cell ② reads the
 *     NEWEST pair in the project. Opening a different row changes which pair is
 *     OPEN and never which is newest, so no cell of the strip can move on a row
 *     press. That is the whole reason the strip took the newest pair rather
 *     than the open one;
 *   · the work-stream fold's SUMMARY — proven not to move for the same reason:
 *     its headline is `projectHeadline` (the newest pair's) and its two counts
 *     are the store's uncapped totals.
 *
 * ── IT RETURNS WHY, BECAUSE THE FAILURE IS SILENT (§6.6) ───────────────
 * Every bail is `render(token); return;` — the page stays CORRECT and the
 * measured win (2 repaints → 0 on a row press) is quietly gone, with nothing
 * on screen to say so. A returned reason is what lets an offline suite assert
 * the patch path was TAKEN rather than merely that the DOM ended up right.
 * Callers ignore it; it exists to be observable.
 *
 * @returns {'patched'|string} 'patched', or 'fell-back:<precondition>'.
 *
 * ANY precondition that does not hold falls through to ONE full render, which
 * is still half what the shipped code did. A partial patch is never left on
 * screen: every write happens after every check.
 *
 * `renderedSignature` is re-taken at the end. The signature must always
 * describe what is PAINTED — leaving it stale would make the next poll either
 * repaint needlessly (closing the reader's own page underneath it) or skip a
 * repaint it owed.
 */
function patchOpenPair(token) {
  if (!isCurrentMount(token)) return 'fell-back:unmounted';
  if (typeof document === 'undefined'
    || typeof document.getElementById !== 'function'
    || typeof document.createElement !== 'function') {
    render(token);
    return 'fell-back:no-dom';
  }
  const pr = state.projectRead;
  const d = state.detail;
  const tbody = document.getElementById('mem-ws-body');
  const stack = document.querySelector('.mem-status-stack');
  const scopes = (pr && Array.isArray(pr.scopes)) ? pr.scopes : null;
  if (!tbody || !scopes || !scopes.length) { render(token); return 'fell-back:no-table'; }

  const ordered = workStreamOrder(scopes);
  const shown = wsShownCount(ordered, d, state.wsWindow);
  // The window would have to GROW (or shrink) to hold the new pair. That is a
  // structural change to the table, its footer and its count line together —
  // one full render says it once instead of three patches agreeing.
  if (shown !== tbody.children.length) { render(token); return 'fell-back:window'; }

  const statusHtml = renderSaveStatus(pr, d) + renderStaleNotice() + renderUnlistedNote(pr, d);
  // PRESENCE, not truthiness (v3.62.0). The old form bailed whenever the new
  // markup was empty, which was right while the standing-brief line made that
  // stack unconditional — it never was empty. Deleting that line made an empty
  // stack reachable, and the stack is now a `noticeHtml` that APPEARS and
  // DISAPPEARS with its content, so the honest question is the same one the
  // journal half asks: does what we are about to write and what is on screen
  // agree about existing at all. Adding or removing the notice slot is a
  // layout change this cannot make in place.
  if (!!statusHtml !== !!stack) { render(token); return 'fell-back:status-presence'; }

  const journalHtml = renderJournal();
  // ── THE JOURNAL IS A FOLD INSIDE STEP ② NOW (v3.62.0, §6.6) ───────────
  // It was `.settings-block-memory-journal .settings-block-body` — a block
  // that no longer exists. A selector that stops matching does not throw and
  // does not red a suite: it bails to `render(token)` SILENTLY, leaving the
  // page correct and v3.57.0's measured win quietly gone. Scoped to the step
  // rather than to the document so it cannot match a fold of the same name
  // somewhere else on the page.
  const liveFold = document.querySelector(
    '.settings-block-context-state [data-mem-fold="journal"]');
  // PRESENCE, not content: the fold appears and disappears with the journal,
  // and neither adding nor removing it is an in-place edit.
  if (!!journalHtml !== !!liveFold) { render(token); return 'fell-back:journal-presence'; }

  // ── THE FOLD ELEMENT ITSELF MUST SURVIVE ───────────────────────────────
  // `wire` binds `toggle` on the `<details>`, and that listener is the only
  // record of whether the user has the journal open; replacing the element
  // would drop it silently and the fold would stop remembering itself on the
  // next render. So the swap below writes the details' INNARDS and keeps the
  // node — which also means the ONE listener inside it, "Show more", is the
  // only thing to re-attach.
  //
  // Parsed HERE, in the check phase, because a parse that does not yield a
  // fold is a reason to abandon the patch and the abandonment must happen
  // before anything has been written.
  let nextFold = null;
  if (journalHtml) {
    const parsed = document.createElement('div');
    parsed.innerHTML = journalHtml;
    nextFold = parsed.querySelector('[data-mem-fold="journal"]');
    if (!nextFold) { render(token); return 'fell-back:journal-parse'; }
  }

  // ── Every check has passed; write. ────────────────────────────────────
  const openScope = (d && d.scope) || null;
  const openMachine = (d && d.machine) || null;
  const mineMachine = d && d.machineIsThisMachine === true ? d.machine : null;
  tbody.innerHTML = ordered.slice(0, shown)
    .map((row) => wsRowHtml(row, openScope, openMachine, mineMachine)).join('');
  // The rows are new elements, so their listeners are too. Scoped to the
  // tbody, the same way the "Show more" append scopes its own binding.
  bindWorkStreamRows(tbody, token);

  if (stack) {
    // ── NO FOLD IN HERE ANY MORE, SO NO LISTENER TO RE-ATTACH (v3.65.1) ──
    // Through v3.65.0 this write replaced a `<details data-mem-fold="saved">`
    // that `wire` had bound on the last render, so the arm below re-attached
    // its `toggle` listener by hand — otherwise the row stopped remembering
    // itself after one row press. `statusHtml` is warnings and disclosures
    // now, with no `<details>` in it at all (`renderMonitor` emits none, by
    // contract), so there is nothing here to re-bind. The write stays: the
    // disclosures are per-pair and a row press changes which pair they are
    // about.
    stack.innerHTML = statusHtml;
  }

  const count = document.getElementById('mem-ws-count');
  if (count) count.outerHTML = workStreamCounts(pr, scopes.length, shown);

  if (liveFold && nextFold) {
    // `open` is deliberately not copied across: the live element already
    // carries what the user chose, and `renderJournal` derives the same value
    // from `state.openFolds`, so writing it would be a second copy of one fact.
    liveFold.innerHTML = nextFold.innerHTML;
    // THE SECOND OF THE TWO "Show more" CALL SITES — see `wire()`, which
    // carries the first and says why they are not one function. Four lines,
    // and scripts/test-next-memory-switch.js drives both of them and requires
    // them to do the same thing.
    const jm = liveFold.querySelector('#mem-journal-more');
    if (jm) {
      jm.addEventListener('click', () => {
        state.journalLimit = JOURNAL_MORE;
        const m = state.detail ? state.detail.machine : state.machine;
        // `keepDetail` — see loadScope. Without it the fold the user is
        // reading is removed for the length of the fetch and the column
        // shrinks under them.
        loadScope(state.scope, m, token, { keepDetail: true })
          .catch((err) => reportAsyncMountFailure(token, err));
      });
    }
  }

  renderedSignature = screenSignature();
  return 'patched';
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
export function renderProjectGroups(projects, activeDomain, activeProject, domainOrder) {
  const rows = Array.isArray(projects) ? projects.filter(Boolean) : [];
  const order = [];
  const byDomain = new Map();
  for (const p of rows) {
    const d = p.domain == null ? '' : String(p.domain);
    if (!byDomain.has(d)) { byDomain.set(d, []); order.push(d); }
    byDomain.get(d).push(p);
  }
  // ── THE IDENTITY COLOUR IS THE DOMAIN'S OWN, NOT THIS LIST'S POSITION ──
  //
  // `identityDotClass(i)` is the SAME mapping views/domains.js paints its
  // KNOWLEDGE rows with, so a domain has one colour across the whole app —
  // which is the entire value of an identity mark and is the reason it is a
  // kit function rather than a second copy. The index has to be the domain's
  // place in the INSTALL's list, not in this screen's: a domain with no
  // project context at all is absent here and present there, and taking the
  // local position would slide every colour below it by one.
  //
  // `domainOrder` is that list, from `GET /api/domains` (the same
  // `listDomains()` order `GET /api/domains/stats` hands the Domains page).
  // It is a PARAMETER rather than a read of module state because this
  // function is lifted and executed by four suites; when it has not arrived
  // yet the local order stands in, which is right far more often than not and
  // is never wrong about which SET of colours is in use.
  const slots = Array.isArray(domainOrder) && domainOrder.length ? domainOrder : order;
  return order.map((domain) => {
    const slot = slots.indexOf(domain);
    const rowsHtml = byDomain.get(domain).map((p) => {
      const active = p.domain === activeDomain && p.project === activeProject;
      const has = p.scopeCount > 0 || p.hasBrief;
      // THE FRESHNESS DOT, on the app-wide scale. The rail said "3 scopes ·
      // 2 hr ago" and made you READ it to rank two projects; the dot answers
      // the same question pre-attentively, from `freshnessTier` — the same
      // function the work-stream table's dots and the save row's own mark are
      // cut on, so a project row and its own newest work-stream can never
      // disagree about how fresh it is. It is aria-hidden: the words beside
      // it say the same thing.
      const eff = effectiveSave(p);
      const tier = freshnessTier(eff.seconds);
      // THE FIGURE AND THE AGE ARE TWO SLOTS, NOT ONE SENTENCE — and that is
      // the whole of what the maintainer was pointing at. `projectMetaLine`
      // composes "18 scopes · 15 hr ago" as a STRING, so there was nowhere
      // for a clock glyph to go: *"it has clocks showing when it was changed;
      // in Context we don't have that, we have some sort of colours but no
      // clocks."* The kit puts the mark and the glyph BETWEEN the figure and
      // the age, which cannot be done by splitting a formatted line, and it
      // emits the glyph itself so a host cannot forget it.
      const n = Number.isInteger(p.scopeCount) ? p.scopeCount : null;
      const figure = n === null ? '' : n + ' scope' + (n === 1 ? '' : 's');
      return renderSidebarRow({
        alias: 'mem',
        name: p.project,
        // NO DOT AT ALL on a project with neither a brief nor a save: the
        // hollow ring `.mem-row-mark-off` painted was a SECOND state on the
        // identity mark, and identity does not have states. The quiet row
        // class already says it, in the name's own ink.
        dotClass: has && slot >= 0 ? identityDotClass(slot) : '',
        figure,
        markHtml: '<span class="fresh-dot fresh-' + tier + '" aria-hidden="true"></span>',
        age: formatAge(eff.seconds),
        // A PROJECT WITH NO SAVE HAS NO AGE, and says so rather than
        // borrowing "nothing written yet" from a domain that has no pages.
        ageFallback: 'no save yet',
        // "WORKING ON:" IN THE RAIL, on line THREE. `headline` rides on every
        // index row and nothing had ever rendered it; the menubar widget
        // leads with it. It sat on line TWO, ABOVE the figure — the one place
        // the two rails' anatomy really differed — and it is a LAST EVENT,
        // which is the slot Domains' "Ingested · <title>" already occupies.
        // OMITTED rather than filled with a placeholder when there is none.
        event: p.headline || '',
        active,
        stateClass: has ? '' : 'mem-row-quiet',
        ariaCurrent: active,
        data: { 'mem-domain': domain, 'mem-project': p.project },
      });
    }).join('');
    // THE GROUP HEAD IS THE DOMAIN, and `.cur-eyebrow` upper-cases it — so
    // the maintainer's own domain, which is literally named `projects`, reads
    // PROJECTS. That is correct and is not the duplicate-word defect it was
    // reported as: the OTHER PROJECTS on that screen was the actions eyebrow,
    // which this release retires with the row of ghost buttons it captioned.
    return renderSidebarGroup({ eyebrow: domain, alias: 'mem', rowsHtml });
  }).join('');
}

function renderSidebar(token) {
  // ── THE KIT'S HEAD: A TITLE, A PRIMARY, A SECONDARY (v3.65.0, R2/R7) ────
  //
  // NO ⓘ. The maintainer: *"we have an information icon in the Project
  // context sidebar which should not be here, because we have another one on
  // the right side beside Copy agent instructions — we definitely don't need
  // it in this small section."* `renderSidebarHead` takes no `info` option at
  // all, so this is enforced by the component rather than remembered by a
  // caller; the sentence the rail's panel carried is the second paragraph of
  // the MAIN header's own ⓘ (`aboutInfoHtml`), which is where it was already
  // half-said.
  //
  // THE TWO SLOTS MEAN SOMETHING, and that is why the pair swapped rungs. The
  // primary slot is "create the kind of thing this list holds" — `New domain`
  // on Domains, `+ New project` here — and the secondary is the one
  // alternative route. Both used to be `btn-ghost btn-xs` inside a
  // `.mem-projects-head` row under an eyebrow, which is the *"Refresh without
  // a button — it is a button but not visible as one"* the report names.
  //
  // `+ New project` NAVIGATES TO DOMAINS, by design: Domains stays the one
  // place a project is created, one form and one set of refusals. A primary
  // face is honest about intent and its accessible name keeps "in Domains",
  // so the destination is announced before the press rather than discovered
  // after it.
  const head = renderSidebarHead({
    title: 'Project context',
    primary: {
      label: '+ New project',
      id: 'mem-new-project',
      className: 'mem-new-project',
    },
    secondary: {
      label: 'Refresh',
      id: 'mem-refresh',
      className: 'mem-refresh',
    },
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
      title: 'Could not load this project’s context',
      detail: state.indexError,
    }), token);
    return;
  }
  if (!state.projects.length) {
    setSidebar(head +
      renderDescription('No domains yet. Project context is kept per domain — create one in Domains first.'),
      token);
    return;
  }

  // Hoisted into a local rather than inlined into the setSidebar() call
  // below: test-next-memory-view §9 reads the token argument within a
  // 12-line window of the call, and it is right to — a call whose arguments
  // no longer fit on a screen is a call whose token is easy to drop.
  const rows = renderProjectGroups(
    state.projects, state.activeDomain, state.activeProject, state.domainList);

  // NO FOOT CARD, and no `.mem-projects-head` either. The first was a lock
  // glyph and a sentence under the list, belonging to nothing; the second was
  // an eyebrow captioning two ghost buttons. Both are gone, and what is left
  // is the shape all three sidebars share: a title, two actions, and groups.
  setSidebar(head + rows, token);
}

function renderMain(token) {
  let body;
  if (state.loading) {
    body = gatedLoader(loadGate, 'Loading project context…');
  } else if (state.indexError) {
    body = renderStatus({
      state: 'danger', title: 'Could not load this project’s context', detail: state.indexError,
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
      title: 'Project context',
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
      // ── THE ONE PRIMARY, TOP RIGHT (v3.65.0, R7/§2(5)) ────────────────
      // The maintainer, with both headers side by side: *"The Copy agent
      // instructions button should be on the top right in a violet button
      // like Ask this domain — the same design pattern."* So it takes
      // `dm-ask-btn`'s slot and `dm-ask-btn`'s rung: `btn-primary`, the md
      // (32px) size rather than `btn-xs`, and `margin-left: auto` in this
      // view's own stylesheet, exactly as views/domains.css declares it for
      // its own trailing primary. The id and the clipboard behaviour are
      // untouched — `composeAgentInstructionsFull` is not this release's
      // subject and the block it copies is byte-frozen.
      actionsHtml: state.activeProject
        ? '<button type="button" class="btn btn-primary mem-ask-btn" id="mem-copy-agent">'
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
  const title = noDomains ? 'No domains yet' : 'No project context yet';
  // `html: true` because these sentences carry an inline <code>. The caller
  // owns escaping when it opts in; every value here is a literal or a
  // server-supplied INTEGER, which is why `n` is checked with Number.isInteger
  // before it is used and rendered as a count rather than interpolated raw.
  const body = noDomains
    ? 'Project context is kept per domain, under <code>state/</code> beside that domain’s knowledge. ' +
      'Create a domain first, then point an agent at it — the brief appears here the moment one saves.'
    : (Number.isInteger(n) && n > 0
        ? 'Nothing has been saved in ' + (n === 1 ? 'your domain' : 'any of your ' + n + ' domains') + ' yet. '
        : 'Nothing has been saved yet. ') +
      'Project context lives under <code>state/</code> beside a domain’s knowledge, and a project appears here ' +
      'the moment an agent saves a handoff or you write it a standing brief in Domains → Projects.';
  // ── WHO THIS IS FOR, SAID ON THE SCREEN WHERE THE QUESTION IS ASKED ───
  // v3.64.0, §5.2. The rail cannot carry prose — its captions are one word
  // — and `title`/`aria-label` already read "Project context", which names
  // the thing without saying who needs it. So a researcher with no agents
  // meets a third rail button and has no way to find out what it is for
  // except by pressing it. This is where they land when they do, and it is
  // the one sentence that answers them: the second audience is the first
  // audience's future, said once, here.
  const audience = 'Project context is for work that outlives one session: a book, a research programme, a codebase.';
  // ── §8(e): THE POINTER LIVES WHERE THE MISSING THING IS A PROJECT ──────
  // Moved here from `renderFoundations`'s no-manifest arm (v3.62.0): that
  // state is reached INSIDE a project that has already been selected — the
  // chooser right there IS the way to answer it, and a pointer away from the
  // page would send the person who came to make that choice somewhere else.
  // Here the project itself does not exist yet — by definition, this is the
  // one screen `renderMain` reaches only when `!state.activeProject` — so
  // "Create a project in Domains" is the true next step whichever of the two
  // sentences above is on screen, and `mem-fnd-to-domains` is the one control
  // id `bindFoundationRows` already wires, never a second navigation path.
  return (
    '<div class="empty-card">' +
      '<div class="empty-title">' + title + '</div>' +
      renderDescription(body + ' ' + audience, { html: true }) +
      '<div class="mem-fnd-elsewhere">' +
        '<button type="button" class="btn btn-secondary btn-xs" id="mem-fnd-to-domains">' +
        'Create a project in Domains</button>' +
      '</div>' +
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
  // ── TWO CONTROLS NOW WRITE THIS RECORD (P2-8) ──────────────────────────
  // The header's "Copy agent instructions" and the Foundations block's "Copy
  // the drafting request" put two DIFFERENT texts on the clipboard for two
  // different files, so one confirmation cannot describe both: an owner who
  // pressed the drafting ask and read "paste it into CLAUDE.md" has been told
  // the wrong thing about the thing they are holding. `kind` is the
  // discriminator, and an ABSENT kind means the header's control — the
  // pre-v3.61.0 record shape, so the success and refusal arms it produces stay
  // byte-identical.
  const draft = c.kind === 'draft';
  if (c.ok) {
    return '<div class="mem-section">' + renderStatus({
      state: 'success',
      title: draft ? 'Drafting request copied' : 'Agent instructions copied',
      detail: draft
        ? 'Paste it into any assistant with the my-curator bridge installed.'
        : COPY_SUCCESS_BANNER,
    }) + '</div>';
  }
  // THE TEXT IS PRINTED, not merely lamented. A button that silently did
  // nothing is the worst outcome here, so the refusal hands over exactly what
  // would have been on the clipboard, to be selected by hand.
  return '<div class="mem-section">' + renderStatus({
    state: 'attention',
    title: 'Could not copy',
    detail: draft
      ? 'Your browser refused clipboard access. Select the text below and copy it by hand.'
      : 'Your browser refused clipboard access. Select the block below and copy it by hand.',
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
  const text = composeAgentInstructionsFull({ domain, project });
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
 * "COPY THE DRAFTING REQUEST" — the same discipline, a different text (P2-8).
 *
 * ── THE DOCUMENTS IT NAMES ARE THE PROJECT'S OWN ────────────────────────
 * Q8's decision: the sentence lists this project's UNFILLED documents, read off
 * the payload's `skeleton` flags, so an owner with three skeletons does not
 * paste a request for four — and when every document is written it lists them
 * all, because asking for a rewrite of a named set is legitimate and asking
 * for a rewrite of "the foundations" is not actionable. An empty list is not
 * passed as empty: `composeDraftingAsk` falls back to the four default roles a
 * seeded project carries, which is the right answer for a project whose owner
 * unticked the seeding and has nothing at all.
 *
 * The pair is captured BEFORE the await and the outcome is STAMPED with it, so
 * a project switch during the copy leaves the confirmation belonging to the
 * project it was pressed on — where `renderCopyOutcome` declines to paint it —
 * rather than re-labelling it as the new one's. Same rule, same reason, as the
 * control above.
 */
async function copyDraftingAsk(token) {
  const domain = state.activeDomain;
  const project = state.activeProject;
  const facts = foundationsFacts(state.projectRead);
  const unfilled = facts.docs.filter((d) => skeletonOf(d));
  const documents = (unfilled.length ? unfilled : facts.docs).map((d) => ({
    slug: d.slug, role: d.role, title: d.title,
  }));
  let text = '';
  try {
    text = composeDraftingAsk({ domain, project, documents });
  } catch {
    // IT REFUSES AN EMPTY DOMAIN OR PROJECT rather than composing a sentence
    // telling an agent to save into a project that cannot exist. Reaching this
    // means the view is painting a project it does not have a name for, which
    // is a bug elsewhere — so nothing is copied and nothing is claimed.
    return;
  }
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch { ok = false; }
  if (!isCurrentMount(token)) return;
  state.copied = { domain, project, ok, text, kind: 'draft' };
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
// ═════════════════════════════════════════════════════════════════════════
// THREE NUMBERED STEPS, AND THE NUMERAL IS THE ARGUMENT (v3.62.0, P1-1)
// ═════════════════════════════════════════════════════════════════════════
//
// Until this release the page was FIVE unnumbered blocks — Status,
// Work-streams, Standing brief, Foundations, Session journal — and
// scripts/test-next-memory-view.js §18i pinned that by name: "a numeral is an
// argument for SEQUENCE, and these five are readings about one project rather
// than steps." That was a true description of the page as built, and the page
// as built was the complaint: five readings in no stated order, with the
// documents an agent must not act without in position four.
//
// The three steps ARE an order, and it is the order a session start reads in:
//
//   ①  FOUNDATIONS     what the PROJECT tells an agent   — replaced whole
//   ②  WORKING STATE   what the last session left        — supersedes
//   ③  KNOWLEDGE       what the wiki has compounded      — accumulates
//
// Step ① leads because a document an agent must not act without is the thing a
// new project does not have: on a fresh project it is the only step that can
// do anything, which is the Providers block-1 test verbatim.
//
// ══════════════════════════════════════════════════════════════════════════
//  THE STEP HEAD — a numeral, a Title-case title, and the ⓘ BESIDE IT
// ══════════════════════════════════════════════════════════════════════════
//
// ── THE THREE LEDES ARE GONE (v3.65.0, R4) ────────────────────────────────
// `LEDE_CANONICAL` / `LEDE_STATE` / `LEDE_KNOWLEDGE` were three sentences
// under three numbered titles. The maintainer, looking at step ①: *"below the
// Foundations title we have 'Add the documents an agent must not act without'
// with another information icon, so maybe we don't need the first sentence,
// we just need the information icon beside the title."* Each sentence is now
// the FIRST PARAGRAPH of that step's own ⓘ — moved, not deleted — and the
// mark sits in the head row beside the numeral and the title.
//
// ── WHY THIS IS A LOCAL FUNCTION AND NOT `renderBlock` ────────────────────
// `shared/block.js` emits the ⓘ INSIDE the lede paragraph and emits NOTHING
// at all when there is no lede (`renderBlock` :38-41), so "no lede, ⓘ beside
// the title" is not expressible through it. That file is owned by no package
// in this release, and BUILDER-RULES rule 2 is that a builder who needs
// another package's file stops and reports rather than widening — so the head
// is composed here, from the SAME shell.css classes `renderBlock` uses
// (`.settings-job-block`, `.settings-block-hd`, `.settings-block-num`,
// `.settings-job-title`, `.settings-block-info`, `.settings-block-body`), and
// nothing about shell.css moves. `views/domains.js` already hand-builds its
// five numbered heads for its own reasons; when `shared/block.js` gains the
// parameter both callers collapse into it in one reviewable diff.
//
// `.settings-block-hd` is `display: flex; align-items: baseline; gap: 12px`,
// so the mark is a third child of the head row and needs no rule of its own —
// which matters, because `shared/text.css` owns the whole `tx-` prefix and
// scripts/test-next-text-system.js §8 fails any other /next stylesheet that
// declares a `tx-` selector, comments included.
//
// THE HEAD IS THE CARD'S SIBLING, NEVER ITS WRAPPER — the standing heading
// rule (v3.64.2) — and this composition keeps it so: head, then panel, then
// body, three siblings inside the block.
//
// `bodyHtml`, `noticeHtml` and `infoHtml` are TRUSTED, exactly as
// `renderBlock`'s are; `title` is escaped.
function memStep(o) {
  const id = String(o.id);
  const info = renderInfoMark(
    'settings-block-info-' + id, 'More about ' + o.title, o.infoText || '', { html: true });
  return (
    '<div class="settings-job-block settings-block settings-block-' + escapeHtml(id) + '">' +
      (o.noticeHtml || '') +
      '<div class="settings-block-hd">' +
        '<span class="settings-block-num" aria-hidden="true">' + escapeHtml(String(o.num)) + '</span>' +
        '<h2 class="settings-job-title">' + escapeHtml(o.title) + '</h2>' +
        info.btn +
      '</div>' +
      (info.panel ? '<div class="settings-block-info">' + info.panel + '</div>' : '') +
      '<div class="settings-block-body">' + (o.bodyHtml || '') + '</div>' +
    '</div>'
  );
}

/**
 * THE THREE-CELL STRIP — one reading per layer, above the three steps.
 *
 * ── IT REPLACES THE STATUS BLOCK, AND REPLACES IS THE WORD ──────────────
 * Block ① used to be a section titled "Status" whose lede — "Where this
 * project stands right now, across every machine" — described the PAGE rather
 * than a layer of it, and whose body mixed a tier-0 reading, a tier-2 reading,
 * four tier-2 warnings and a tier-1 line. One block, four layers' worth of
 * content: it was the "everything mixed together" complaint in one place. Its
 * readings are here, its notices are on the step each one qualifies, and
 * nothing was dropped.
 *
 * The documented reason it came FIRST is preserved and made cheaper: it
 * answers "am I saved?", asked by someone with almost no context left, so it
 * must not sit under two conditional notes and a table. Three cells answer it
 * in one line instead of a block — and answer it for all three layers rather
 * than for one.
 *
 * ── IT IS NOT A NUMBERED BLOCK, BECAUSE IT IS NOT A STEP ────────────────
 * It is an instrument about the page. It sits between the breadcrumb and step
 * ① as a `.mem-section`, so `.mem-section + .settings-job-block` already
 * spaces it and the page has exactly one unnumbered element above the steps.
 *
 * ── THE DOT PAINTS A COMPARISON, AND ONLY WHERE ONE WAS MADE ────────────
 * `markHtml` on the shared readout (v3.62.0's one kit change) puts the app's
 * freshness dot inside `.tx-readout-value`. The dot carries NO reading on its
 * own — it is aria-hidden and the word beside it is the reading — and no tier
 * is ever painted as a colour without its word. An age nobody could take is
 * the dashed unknown ring and the words that say so, NEVER age zero.
 *
 * A curator-owned document set takes no dot at all, exactly as its row in the
 * table does: there is no upstream to be fresh against, and a grey dot beside
 * "written" reads as a stale one at a glance.
 *
 * `read` is null while the project read is in flight. Cell ① is then OMITTED
 * rather than guessed — "no reading, no instrument" is the readout kit's own
 * rule, and "not set up yet" is a claim that frame cannot make.
 */
function renderLayerStrip(read) {
  const cards = [];

  // ── CARD ① — FOUNDATIONS ──────────────────────────────────────────────
  if (read) {
    const facts = foundationsFacts(read);
    let value = null;
    let sub = null;
    let tier = null;
    if (facts.manifestError) { value = 'manifest unreadable'; tier = 'unknown'; } else if (!facts.present) { value = 'not set up yet'; tier = 'unknown'; } else if (!facts.count) { value = 'no documents yet'; tier = 'unknown'; } else {
      // THE FIGURE AND ITS QUALIFIER, ON TWO LINES RATHER THAN ONE. They were
      // "24 documents · 4 stale" in a single mono cell; the card has a second
      // line for exactly this, and the figure is what the eye is looking for.
      value = facts.count.toLocaleString('en-US') + ' document' + (facts.count === 1 ? '' : 's');
      sub = foundationsWord(facts);
      // The same three-way mapping `fndRowHtml` uses, taken over the SET: a
      // stale copy is the thing to act on, a checkout that is not here is a
      // reading nobody could take, and everything else compared clean. A set
      // with no comparison in it at all (curator-owned) gets no mark.
      tier = facts.stale ? 'week'
        : facts.unreachable ? 'unknown'
          : facts.fresh ? 'recent' : null;
    }
    cards.push({
      label: 'DOCUMENTS',
      value,
      sub,
      markHtml: tier ? '<span class="fresh-dot fresh-' + tier + '" aria-hidden="true"></span>' : '',
      jump: 'context-canonical',
      name: 'Documents, ' + value + ' — go to step 1',
    });
  }

  // ── CARD ② — WORKING STATE ────────────────────────────────────────────
  // The NEWEST pair in the project, not the open one: this is the project's
  // answer, and the table inside step ② gives every row its own. Falling back
  // to the index row covers the frame in which `projectRead` has not landed.
  const scopes = (read && Array.isArray(read.scopes)) ? read.scopes : [];
  const newest = newestPair(scopes);
  const indexRow = (state.projects || []).find(
    (p) => p && p.domain === state.activeDomain && p.project === state.activeProject) || null;
  const savedEff = effectiveSave(newest || indexRow || {});
  const savedAge = formatAge(savedEff.seconds);
  const savedValue = savedAge ? 'saved ' + savedAge : 'nothing saved yet';
  cards.push({
    label: 'MEMORY',
    value: savedValue,
    // WHICH work-stream that save belongs to. A save age with no work-stream
    // beside it is the reading the work-stream fold had to be opened to
    // resolve; it is one field on the row that produced the age.
    sub: newest && typeof newest.scope === 'string' && newest.scope ? newest.scope : null,
    markHtml: '<span class="fresh-dot fresh-'
      + (savedAge ? freshnessTier(savedEff.seconds) : 'unknown') + '" aria-hidden="true"></span>',
    jump: 'context-state',
    name: 'Memory, ' + savedValue + ' — go to step 2',
  });

  // ── CARD ③ — KNOWLEDGE ────────────────────────────────────────────────
  // Omitted until the one request lands. A card reading "—" while a fetch is
  // in flight is an instrument claiming a reading it does not have; step ③
  // below carries the loading and the error, where there is room to say why.
  //
  // ── IT SUMS THE CHOSEN WIKIS NOW (v3.65.0, P10) ─────────────────────
  // A project can draw on several, so the card is the TOTAL and its second
  // line names how many and when any of them was last written to. It is
  // omitted until at least one answer has landed: a card reading "—" while a
  // fetch is in flight is an instrument claiming a reading it does not have,
  // and step ③ below carries the loading and the error, where there is room
  // to say why.
  // `read` RATHER THAN `state.projectRead`: this function takes the project
  // read as its argument precisely so the SKELETON can call it with null, and
  // reading module state instead would make the two paints disagree about
  // which project they are describing.
  const kmap = state.knowledge instanceof Map ? state.knowledge : null;
  const kchosen = (read && Array.isArray(read.knowledgeDomains) && read.knowledgeDomains.length)
    ? read.knowledgeDomains
    : (state.activeDomain ? [state.activeDomain] : []);
  const kread = kmap ? kchosen.map((d) => kmap.get(d)).filter((e) => e && e.data) : [];
  if (kread.length) {
    const pages = kread.reduce(
      (n, e) => n + (Number.isInteger(e.data.pageCount) ? e.data.pageCount : 0), 0);
    // THE NEWEST WRITE ACROSS THE SET. A date string sorts lexically because
    // it is `YYYY-MM-DD`, which is the same property the day-freshness ladder
    // relies on one line down.
    const newestDay = kread.map((e) => e.data.lastIngestDate)
      .filter((x) => typeof x === 'string' && x).sort().pop() || null;
    const day = formatDayAge(newestDay);
    const pagesValue = pages.toLocaleString('en-US') + ' page' + (pages === 1 ? '' : 's');
    cards.push({
      label: 'KNOWLEDGE',
      value: pagesValue,
      // HOW MANY WIKIS, because this is the one layer the project READS
      // rather than owns: a figure with no owner beside it reads as the
      // project's own, and the owner may now be several.
      // ONE WIKI IS NAMED; SEVERAL ARE COUNTED. A figure with no owner beside
      // it reads as the project's own, and the owner may now be several.
      sub: [day || 'nothing ingested yet',
        kread.length === 1 ? (kchosen[0] || null) : kread.length + ' domains']
        .filter(Boolean).join(' · '),
      // The CALENDAR-DAY ladder, because `lastIngestDate` is a `YYYY-MM-DD`
      // heading with no time of day in it. A null date resolves to the dashed
      // unknown ring through `dayFreshnessTier`'s own null arm.
      markHtml: freshnessDotHtml(newestDay),
      jump: 'context-knowledge',
      name: 'Knowledge, ' + pagesValue + ' — go to step 3',
    });
  }

  if (!cards.length) return '';

  // ── CAPTURE IS A CARD IN THE SAME GRID (v3.65.0, R5) ──────────────────
  //
  // IT WAS A JUMP TILE, and the jump tile is the thing the maintainer was
  // pointing at: *"we have some additional information, SOURCES 14 days ago —
  // I don't understand why it is here and why it is an entirely different
  // design than the five on top"*. Measured on v3.64.2: a jump tile was
  // 92.8 x 46.4 at x=401 while a stat tile beside it was 181.8 x 78.9 at
  // x=385 — a different size, a different height and a 16px indent, inside
  // one card. `jumps[]` is gone from shared/overview.js entirely; a jump is
  // an ordinary card carrying `jump:`, at the one tile geometry.
  //
  // RENDERED AND HIDDEN, NEVER OMITTED. The meter's own request lands after
  // this paint, and an omitted tile means the reading simply never appears
  // unless something repaints the strip — the green-first mutation v3.64.2
  // closed on the jump row. `hidden` ships the tile and one attribute write
  // reveals it, with no repaint; shared/overview.css carries the `[hidden]`
  // counter-rule for the card, because `[hidden]` loses to an author
  // `display:` at any specificity (the v3.62.0 defect).
  const cap = state.capture && state.capture.domain === state.activeDomain
    && state.capture.project === state.activeProject && state.capture.data
    ? state.capture.data : null;
  const capTotals = cap && cap.totals && typeof cap.totals === 'object' ? cap.totals : null;
  const capSessions = capTotals && Number.isInteger(capTotals.sessions) ? capTotals.sessions : null;
  const capValue = capSessions === null
    ? 'not counted'
    : capSessions.toLocaleString('en-US') + ' session' + (capSessions === 1 ? '' : 's');
  //
  // NO SECOND LINE, AND NOT FOR TIDINESS: `renderLayerStrip` is LIFTED by
  // brace-matching and EXECUTED by scripts/test-next-overview-kit.js, which
  // this package does not own, so a module-level constant named in this body
  // (`CAPTURE_WINDOW_DAYS`, for "in the last 30 days") is a ReferenceError
  // there — a suite that CRASHES rather than asserts. The window is stated in
  // words in step ②'s own row summary, which is where the jump lands.
  cards.push({
    label: 'CAPTURE',
    value: cap ? capValue : 'not counted',
    hidden: !cap,
    jump: 'capture',
    name: 'Capture — open the session reading in step 2',
  });

  // ── THE ⓘ BELONGS TO THE INSTRUMENT, NOT TO A STEP ────────────────────
  // It explains every age on this page — the two clocks, and what "last
  // saved" does not claim — so it sits on the thing that shows them all, on
  // the eyebrow, which is where the domain page's OVERVIEW has always put it.
  return renderOverview({
    id: 'mem-layers-info',
    eyebrow: 'OVERVIEW',
    sectionClass: 'mem-section mem-overview',
    // ── ONE FIGURE RUNG, AND A WIDER TRACK INSTEAD (v3.65.0, R8) ───────
    //
    // v3.64.2 dropped these values one rung (22px -> 17px) because "saved 57
    // min ago" broke after "min". That wrap is real; the second TYPE RUNG was
    // the wrong fix, because two views whose figures are different sizes are
    // two designs, which is the whole of the report this release answers. The
    // narrow case belongs to the TRACK.
    //
    // 253 IS DERIVED FROM THE WIDEST VALUE, not from a track count — the rule
    // the domain page's own floor follows. Measured in the browser, in the
    // real shell, at this view's real column: the widest value this strip can
    // paint is `manifest unreadable` at 204.5px, and the value box adds the
    // freshness dot (8) and its gap (8) while the card adds 16px of padding a
    // side. 204.5 + 8 + 8 + 32 = 252.5, rounded up.
    //
    // WHAT IT PRODUCES, measured: at a 1370px window the grid is 893px and
    // this yields THREE tracks of 291px with CAPTURE on a second row — the
    // same "second row of the same tiles" the domain page's two jumps take,
    // rather than four cramped tracks in which `saved 41 min ago` wraps after
    // `min`. A smaller floor silently re-creates exactly that wrap, which is
    // why the number is pinned rather than the arrangement.
    minTrack: 253,
    infoLabel: 'About the readings on this page',
    infoText:
      '<p>The first three are the project’s three layers of context, and pressing one goes to the '
      + 'step that owns it; CAPTURE reads whether agents are using them. They are READINGS, not a '
      + 'filter — nothing on this page narrows when '
      + 'you press one, unlike the figures on a domain page, which also select what the list '
      + 'below them shows.</p>'
      + '<p>There are TWO clocks behind every age on this page. The <b>agent’s clock</b> is the time the '
      + 'agent itself recorded when it saved, taken from the journal line it wrote. The <b>file’s clock</b> '
      + 'is when the file last changed on this disk — and on a computer that syncs, that is when the file '
      + 'ARRIVED here, not when it was written. The agent’s clock is used whenever there is one, and a '
      + 'reading that had to fall back says “file time” in its own provenance line, in words, rather '
      + 'than in a tooltip.</p>'
      + '<p>MEMORY reads when the last save happened, not whether anything has changed since — no '
      + 'screen can know that — so it never says you ARE saved, and the inference stays with you.</p>'
      + '<p>Each mark is a COMPARISON that was actually made. Documents kept by The Curator have no '
      + 'upstream to compare against and carry no mark at all; a reading nobody could take is the dashed '
      + 'ring and the words beside it, never a zero.</p>'
      + '<p>' + docsLinkHtml('memory.handoff', 'Read more in the guide') + '</p>',
    infoHtml: true,
    cards,
  });
}

/**
 * THE HEADLINE THE NEWEST SAVE CARRIED — one derivation, two readers.
 *
 * It was the first line of the Status block ("Working on: …") and it is now
 * the leading clause of the work-stream fold's summary, which is where the row
 * that wrote it lives. THE PROJECT'S ANSWER, not the open row's: the fold is
 * about every work-stream, and each row in the table carries its own.
 *
 * Falls back to the index row, which covers the frame before `projectRead` has
 * landed — the skeleton paints this summary too.
 */
function projectHeadline(read) {
  const scopes = (read && Array.isArray(read.scopes)) ? read.scopes : [];
  const newest = newestPair(scopes);
  const indexRow = (state.projects || []).find(
    (p) => p && p.domain === state.activeDomain && p.project === state.activeProject) || null;
  return (newest && newest.headline) || (indexRow && indexRow.headline) || null;
}

/**
 * THE WORK-STREAM TABLE, IN A FOLD OF ITS OWN (v3.62.0, P1-6).
 *
 * ── WHY IT FOLDS NOW, WHEN IT DID NOT ─────────────────────────────────
 * It is the one long list on this page that could not be put away:
 * `WS_STEP_ALL_MAX` is 20 rows, and v3.58.0's measurement — the page
 * 3,241 → 1,278px once the brief and the journal became closed folds — is the
 * whole argument, applied to the section that release missed.
 *
 * ── THE SUMMARY CARRIES THE DECISION TO OPEN ──────────────────────────
 * `Work-streams · <headline> · 3 work-streams · 5 saved copies`. The headline
 * is what the Status block's "Working on" line carried, and the two counts are
 * `workStreamCounts`' own two facts. It names ITSELF rather than restating the
 * step above it — the step is "Working state", the fold is the work-streams —
 * which is the v3.50.0 "a section that names itself twice" rule the journal's
 * summary already followed and its two siblings did not.
 *
 * ── THE MISSING THING IS STILL MISSING WHERE YOU LOOKED FOR IT ────────
 * A project with nothing saved gets the FLAT card (no chevron), exactly as
 * `renderBrief` and `renderFoundations` do in their empty states: hiding the
 * sentence that explains what is missing behind a chevron is v3.17.1 read
 * backwards.
 */
function renderWorkStreamsFold(read, d) {
  const scopes = (read && Array.isArray(read.scopes)) ? read.scopes : [];
  const unlisted = unlistedCount(read);
  const hasBrief = !!(read && read.brief && read.brief.present);
  if (!scopes.length) {
    return '<div class="mem-fold mem-fold-flat"><div class="mem-fold-body">'
      + (hasBrief ? renderBriefOnlyNotice(read, unlisted) : renderEmptyProject(unlisted))
      + '</div></div>';
  }
  const shown = wsShownCount(workStreamOrder(scopes), d, state.wsWindow);
  const headline = projectHeadline(read);
  const streams = read && Number.isInteger(read.distinctScopeCount)
    ? read.distinctScopeCount : null;
  const pairs = read && Number.isInteger(read.savedCopies) ? read.savedCopies : scopes.length;
  const meta = [
    headline || null,
    streams === null ? null : streams + ' handoff' + (streams === 1 ? '' : 's'),
    pairs + ' saved cop' + (pairs === 1 ? 'y' : 'ies'),
  ].filter(Boolean).join(' · ');
  const open = (state.openFolds && state.openFolds.streams) ? ' open' : '';
  return (
    '<details class="mem-fold" data-mem-fold="streams"' + open + '>'
      + '<summary class="mem-fold-summary" id="mem-fold-streams">' + icon('chevronRight', 14)
        + '<span>Handoffs</span>'
        + '<span class="mem-fold-meta">' + escapeHtml(meta) + '</span>'
      + '</summary>'
      + '<div class="mem-fold-body">'
        + renderWorkStreams(scopes, d, state.wsWindow)
        + workStreamCounts(read, scopes.length, shown)
      + '</div>'
    + '</details>'
  );
}

/**
 * STEP ③ — THE WIKI THIS PROJECT DRAWS ON, IN FIVE FIGURES AND TWO DOORS.
 *
 * ── IT IS A SUMMARY AND A DOOR, AND NOTHING ELSE (P1-8) ────────────────
 * No page list, no health report, no chips. The page list belongs to Domains
 * and is three thousand rows on a real domain; the health scan is 735-800 ms
 * cold and a view that issues no health request today must not start paying
 * one to draw a summary. Both doors LEAVE this view.
 *
 * ── ONE REQUEST, AND NO LLM ───────────────────────────────────────────
 * Every figure comes from `GET /api/domains/:domain/stats` — see
 * `loadKnowledge` for what that costs and for the four surfaces that were
 * ruled out by name.
 *
 * ── THE VERB COMES FROM THE LOG, NEVER FROM THE VIEW'S NAME ───────────
 * `lastIngestKind` is 'ingest' | 'compile' | null, and a null renders the
 * neutral "Last write" rather than a guessed "Ingested". The producer states
 * that a consumer must treat a null as "not known" and never invent a verb
 * from the date's existence.
 *
 * ── NEITHER DOOR IS THE PRIMARY ───────────────────────────────────────
 * Neither completes a step, so both are `btn-secondary btn-xs`. "Ask this
 * domain" is `.btn-primary` on Domains only because it is that card's one
 * commit; here it is one of two ways out.
 */
function renderKnowledge() {
  // ── WHICH WIKIS, AND IT IS A CHOICE NOW (v3.65.0, P10) ────────────────
  //
  // THE REPORT: *"This knowledge section should be the compounding wiki — how
  // do I select exactly which domain I want my project to use? I can have a
  // compounding wiki domain with specific knowledge that coding agents would
  // need and I have no way to select it here ... Where do I select which
  // domain gets sourced — is this even an option?"* It was not. The step drew
  // the CONTAINING domain, always, with no control.
  //
  // The store answers it: `knowledgeDomains` rides the project read, and
  // `knowledgeDomainsDefaulted` says whether anyone chose. ONE ROW PER
  // DOMAIN, in the same chrome as step ②'s five, each one a summary you can
  // decide with and a monitor plus that domain's own two doors behind it.
  //
  // IT IS CURATOR METADATA ABOUT THE PROJECT, and writing it from this screen
  // does not touch the single-writer rule the memory layer rests on: the
  // PATCH writes `project.json` and nothing else — not the brief (tier 1),
  // not a handoff or a journal line (tiers 2 and 3, agent-only over MCP), not
  // a foundation's bytes. It is the same shape as v3.62.0's `readFirst`: an
  // instruction ABOUT documents, never part of them, so every file an agent
  // owns stays byte-for-byte what the agent wrote.
  const read = state.projectRead;
  const listed = read && Array.isArray(read.knowledgeDomains)
    ? read.knowledgeDomains.filter((d) => typeof d === 'string' && d) : [];
  const defaulted = !read || read.knowledgeDomainsDefaulted !== false;
  // THE CONTAINING DOMAIN STANDS IN while the project read is in flight: it
  // is what the store defaults to, so the first frame paints the row the
  // answer will almost always confirm rather than an empty step.
  const domains = listed.length ? listed
    : (state.activeDomain ? [state.activeDomain] : []);

  const rows = domains.map((domain) => renderKnowledgeRow(domain)).join('');
  // A malformed `project.json` is the store's own disclosure and is loud: it
  // means the chosen set could not be read, so the rows below are the DEFAULT
  // rather than the choice, and saying nothing would present one as the other.
  const err = read && typeof read.knowledgeDomainsError === 'string' && read.knowledgeDomainsError
    ? renderStatus({ state: 'attention',
      title: 'This project’s chosen domains could not be read',
      detail: read.knowledgeDomainsError + ' Showing the domain this project lives in instead.' })
    : '';
  return err + (rows || renderDescription('No domain is chosen for this project yet.'))
    + renderKnowledgePicker(domains, defaulted);
}

/**
 * ONE KNOWLEDGE DOMAIN, AS A ROW.
 *
 * Summary: the domain, its page count, the age of its last ingest and the
 * shared freshness mark — the four facts that decide whether to open it.
 * Body: the MONITOR (M3) carrying the other four figures and the last write,
 * then that domain's own two doors.
 *
 * A READING STILL IN FLIGHT AND A FAILED READ ARE NOT ROWS, which is the call
 * v3.64.2 made for this step and the same one `renderCaptureMeter` makes for
 * its idle state: a chevron over a ghost opens on nothing.
 *
 * A DOMAIN THAT NO LONGER EXISTS IS A ROW THAT SAYS SO, never a silent drop.
 * The store keeps the slug deliberately — a domain deleted by accident, or a
 * project synced from a machine that has one this one does not, is a fact the
 * owner has to be able to see and act on.
 */
function renderKnowledgeRow(domain) {
  // BOTH DOORS ARE OFFERED IN EVERY STATE, including the one where the
  // figures failed to arrive: a domain's wiki does not stop existing because
  // a stats read did, and a door withheld for the duration of a failed fetch
  // is a control that disappears exactly when somebody wants to go and look.
  //
  // THE IDS BECAME DATA ATTRIBUTES (v3.65.0). `mem-k-domains` / `mem-k-chat`
  // were bound by id in `wire()`, and an id must be unique — N rows means N
  // pairs. The pattern is `bindFoundationRows`'s: one delegated listener over
  // the attribute, which also survives the row being re-rendered.
  const doors =
    '<div class="mem-k-doors">'
      + '<button type="button" class="btn btn-secondary btn-xs" data-mem-k-domains="'
        + escapeHtml(domain) + '">Open in Domains</button>'
      + '<button type="button" class="btn btn-secondary btn-xs" data-mem-k-chat="'
        + escapeHtml(domain) + '">Ask this domain</button>'
    + '</div>';

  const k = state.knowledge instanceof Map ? state.knowledge.get(domain) : null;
  if (!k || (!k.data && !k.error)) {
    // RESERVE THE HEIGHT, exactly as the project skeleton does one level up:
    // the figures land in one local request, and a column that empties and
    // refills is the defect that frame exists to remove.
    return '<div class="mem-k-wrap" aria-busy="true">'
      + '<div class="mem-ghost mem-ghost-line"></div></div>' + doors;
  }
  if (k.error) {
    // A 404 IS A DIFFERENT SENTENCE FROM A FAILURE. `gone` is the store
    // keeping a slug whose domain this install no longer has; anything else
    // is a read that did not work, and telling the second as the first would
    // send somebody looking for a domain that is fine.
    return renderStatus({
      state: k.gone ? 'attention' : 'danger',
      title: k.gone
        ? '“' + domain + '” is not a domain on this computer'
        : 'Could not read “' + domain + '”',
      detail: k.gone
        ? 'This project still lists it. It may have been deleted, or it may live on another '
          + 'computer that has not synced here yet — remove it below if it is gone for good.'
        : k.error,
    }) + doors;
  }

  const d = k.data;
  const counts = (d && d.pageCounts) || {};
  const num = (n) => (Number.isInteger(n) ? n : 0).toLocaleString('en-US');
  const day = formatDayAge(d.lastIngestDate);
  const verb = d.lastIngestKind === 'ingest' ? 'Ingested'
    : d.lastIngestKind === 'compile' ? 'Compiled' : 'Last write';
  // ── THE MONITOR (M3) ──────────────────────────────────────────────────
  // It was a `renderReadoutGroup` of five cells — the third of the three
  // report treatments the maintainer counted on this screen, and the one he
  // named outright: *"again two different designs here: pages, entities,
  // concepts, summaries and then Last ingest — another information card."*
  // Same five figures, same vocabulary the Domains screen's own tiles use, in
  // the one instrument every live reading in the app now takes.
  const figures = renderMonitor({
    label: 'The ' + domain + ' domain',
    lines: [
      { key: 'pages', value: num(d.pageCount) },
      { key: 'entities', value: num(counts.entities) },
      { key: 'concepts', value: num(counts.concepts) },
      { key: 'summaries', value: num(counts.summaries) },
      {
        key: 'last ingest',
        value: day || 'nothing ingested yet',
        markHtml: freshnessDotHtml(d.lastIngestDate),
        sub: d.lastIngestDate
          ? [verb, d.lastIngestTitle || null].filter(Boolean).join(' · ')
          : undefined,
      },
    ],
  });
  const pagesText = num(d.pageCount) + ' page' + (d.pageCount === 1 ? '' : 's');
  const meta = [pagesText, day || 'nothing ingested yet'].filter(Boolean).join(' · ');
  // PER-DOMAIN FOLD KEY. `readRememberedFolds` accepts `knowledge-<slug>` on
  // the same storage key the other five folds use — no new localStorage key,
  // and the grammar bounds what a hand-edited value can put in the map.
  const key = 'knowledge-' + domain;
  const open = (state.openFolds && state.openFolds[key]) ? ' open' : '';
  return '<details class="mem-fold" data-mem-fold="' + escapeHtml(key) + '"' + open + '>'
    + '<summary class="mem-fold-summary" id="mem-fold-' + escapeHtml(key) + '">'
      + icon('chevronRight', 14)
      + '<span>' + escapeHtml(domain) + '</span>'
      + '<span class="mem-fold-meta">' + freshnessDotHtml(d.lastIngestDate)
        + escapeHtml(meta) + '</span>'
    + '</summary>'
    + '<div class="mem-fold-body">'
      + '<div class="mem-k-wrap">' + figures + '</div>' + doors
    + '</div>'
  + '</details>';
}

/**
 * THE PICKER — one add at a time, and a Remove on every row.
 *
 * ── WHY NOT A MULTI-SELECT ───────────────────────────────────────────────
 * Because `shared/listbox.js` is not one, and says so in its own header:
 * *"This does not implement multi-select."* Building a second selection
 * paradigm here — a menu of checkboxes with an implicit commit — is the
 * shape this release exists to remove, and adopting the component honestly
 * means adopting what it does. So the control is ADD ONE, the menu offers
 * only domains not already chosen, and each row carries its own Remove.
 *
 * `shared-*` MIRRORS ARE OFFERED. A read-only Shared Brain mirror is a
 * perfectly good thing for a project to draw on — it is a refused INGEST
 * target, which is a different question — and the store allows it.
 *
 * NOTHING IS OFFERED WHILE THE LIST HAS NOT BEEN READ. `state.domainList` is
 * null until `GET /api/domains` answers and stays null if it refuses, so the
 * control says it could not read the list rather than presenting an empty
 * menu as "there are no other domains".
 */
function renderKnowledgePicker(chosen, defaulted) {
  const all = Array.isArray(state.domainList) ? state.domainList : null;
  const busy = state.knowledgeSaving === true;
  const err = state.knowledgeSaveError
    ? renderStatus({ state: 'danger', title: 'That domain was not added', detail: state.knowledgeSaveError })
    : '';
  if (!all) {
    return err + renderDescription(
      state.domainListRefused
        ? 'The list of domains could not be read, so there is nothing to choose from here yet.'
        : 'Reading the domains on this computer…');
  }
  const rest = all.filter((d) => !chosen.includes(d));
  const removable = chosen.map((d) =>
    '<button type="button" class="btn btn-ghost btn-xs mem-k-drop" data-mem-k-drop="'
      + escapeHtml(d) + '"' + (busy ? ' disabled' : '') + '>Remove ' + escapeHtml(d) + '</button>').join('');
  // EVERY DISABLED CONTROL STATES ITS REASON (v3.61.1's finding), and the
  // two reasons here are different facts: nothing left to add, and a write in
  // flight.
  const note = !rest.length
    ? renderDescription('Every domain on this computer is already chosen.')
    : '';
  const cfg = knowledgePickerCfg(rest, busy);
  return err
    + '<div class="mem-k-pick">'
      + (rest.length ? renderListboxHtml(cfg) : '')
      + removable
    + '</div>'
    + note
    + (defaulted && chosen.length
      ? renderDescription('Nothing has been chosen yet, so this project draws on the domain it '
        + 'lives in. Adding a domain keeps it and adds to it; removing the last one puts the '
        + 'default back.')
      : '');
}

/** ONE cfg object, used by both `renderListboxHtml` and `mountListbox` — two
 *  literals is the two-hand-maintained-copies shape the component's own
 *  header warns about. */
function knowledgePickerCfg(options, busy) {
  return {
    id: 'mem-k-add',
    value: null,
    placeholder: '+ Add a domain',
    ariaLabel: 'Add a domain this project draws on',
    disabled: busy === true,
    triggerClass: 'btn btn-secondary btn-xs',
    options: options.map((d) => ({ value: d, label: d })),
  };
}

/**
 * THE FIVE FIGURES, FROM ONE REQUEST (P1-8).
 *
 * ── WHAT IT COSTS, MEASURED AT THE PRODUCER ───────────────────────────
 * `GET /api/domains/:domain/stats` is one `CLAUDE.md` read, one dirent-only
 * recursive walk of `wiki/` (`countWikiPages` reads no file's CONTENT), one
 * `readdir` of `conversations/`, and one `stat` of `log.md` that becomes a
 * `readFile` only when `mtimeNs:size` changed. `pageCount === entities +
 * concepts + summaries + other` is an invariant the producer states, so the
 * five figures cannot disagree with each other.
 *
 * ── AND WHAT WAS RULED OUT, BY NAME ───────────────────────────────────
 *   · `GET /api/wiki/:domain` — reads EVERY page's full content; ~14 MB on
 *     the real `articles` domain.
 *   · `GET /api/wiki/:domain/list` — cheap, but a 3,300-entry ~300 KB payload
 *     whose only use here would be to recount what `pageCounts` carries.
 *   · `GET /api/health/:domain` — 735-800 ms cold. A view that issues no
 *     health request must not start paying a cold scan to draw a summary.
 *   · every `…/ai-suggest`, `…/semantic-dupes/scan`, `…/broken-links/plan`,
 *     `…/orphans/plan` — LLM calls. This step never makes one.
 *
 * ── CACHED PER DOMAIN, AND STAMPED ────────────────────────────────────
 * Switching between two projects of one domain must not re-fetch; switching
 * domain must not paint the previous domain's figures. The Map is keyed by
 * domain and every write checks the stamp, the same discipline the project
 * read cache already follows. An in-flight domain is recorded so two project
 * switches in the same domain do not issue two requests.
 *
 * NEVER THROWS, and a failure is a DISCLOSURE rather than a blank: the step
 * says it could not read, and both doors stay offered.
 */
/**
 * THE INSTALL'S DOMAIN LIST — one cheap read, once per mount (v3.65.0).
 *
 * `GET /api/domains` is a `readdir` plus one readonly probe per domain. No
 * stats, no wiki read, no LLM. `GET /api/domains/stats` (what the Domains
 * page calls) walks every wiki folder to count pages, and this view needs
 * only the NAMES and their ORDER, so it asks for the cheaper of the two.
 *
 * WHY THE ORDER MATTERS AND IS NOT INCIDENTAL: both routes answer out of
 * `listDomains()`, so position N here is position N on the Domains page, and
 * `identityDotClass(N)` therefore paints one domain the same colour on both
 * screens. Deriving the index from THIS view's own grouping instead would
 * slide every colour below a domain that has no project context yet.
 *
 * NEVER THROWS, and a failure leaves `domainList` null rather than empty: the
 * rail then falls back to its local order (right far more often than not) and
 * step ③'s picker says it could not read the list instead of offering none.
 */
async function loadDomainList(token) {
  if (state.domainList || domainListInFlight) return;
  domainListInFlight = true;
  try {
    const res = await fetch('/api/domains');
    const data = await res.json();
    if (!isCurrentMount(token)) return;
    if (res.ok && Array.isArray(data.domains)) {
      state.domainList = data.domains.filter((d) => typeof d === 'string');
      state.domainListReadonly = Array.isArray(data.readonlyDomains)
        ? data.readonlyDomains.filter((d) => typeof d === 'string') : [];
      render(token);
    } else {
      state.domainListRefused = true;
      render(token);
    }
  } catch {
    // The rail keeps its local order and the picker says it could not read
    // the list — never an empty menu, which would read as "there are no
    // other domains".
    state.domainListRefused = true;
  } finally {
    domainListInFlight = false;
  }
}

async function loadKnowledge(domains, token) {
  // ── N DOMAINS, N REQUESTS, AND THE COST IS STATED ─────────────────────
  // One `GET /api/domains/:domain/stats` per CHOSEN domain, not per project
  // and not per paint: the Map is keyed by domain and survives a project
  // switch, so moving between two projects of one domain costs nothing and a
  // project drawing on three wikis costs three cheap reads once. The producer
  // is a dirent-only walk — no page content, no health scan, no model call.
  const want = (Array.isArray(domains) ? domains : [domains])
    .filter((d) => typeof d === 'string' && d);
  if (!want.length) return;
  // STATE IS A MAP NOW, not one {domain, data, error}: N rows need N answers,
  // and a single slot could only ever describe the last one to land.
  if (!(state.knowledge instanceof Map)) state.knowledge = new Map();
  let painted = false;
  for (const domain of want) {
    const hit = knowledgeCache.get(domain);
    if (hit) { state.knowledge.set(domain, { data: hit, error: null, gone: false }); continue; }
    if (knowledgeInFlight.has(domain)) continue;
    knowledgeInFlight.add(domain);
    if (!state.knowledge.has(domain)) {
      state.knowledge.set(domain, { data: null, error: null, gone: false });
    }
    // NOT AWAITED IN SEQUENCE. Three wikis must not paint one after another
    // over three round trips; each answer writes its own row and asks for one
    // repaint, and the stamp below drops any that arrives after the mount or
    // the chosen set has moved on.
    (async () => {
      let next;
      try {
        const res = await fetch('/api/domains/' + encodeURIComponent(domain) + '/stats');
        const data = await res.json();
        next = res.ok
          ? { data, error: null, gone: false }
          // A 404 IS A DIFFERENT FACT and is carried as one: the store keeps a
          // slug whose domain this install does not have, and the row says so
          // rather than reporting a read failure.
          : { data: null, gone: res.status === 404,
            error: data && data.error ? data.error : 'HTTP ' + res.status };
      } catch (err) {
        next = { data: null, error: err.message, gone: false };
      }
      knowledgeInFlight.delete(domain);
      if (!isCurrentMount(token)) return;
      if (next.data) knowledgeCache.set(domain, next.data);
      state.knowledge.set(domain, next);
      render(token);
    })().catch((err) => reportAsyncMountFailure(token, err));
    painted = true;
  }
  if (painted) return;
}

/**
 * WHICH WIKIS THIS PROJECT DRAWS ON — the one write this step makes.
 *
 * `PATCH /api/memory/:domain/:project/knowledge/domains` with the WHOLE list,
 * never a delta: the store's body is strict and one field, and a partial
 * write is the shape that makes two clients disagree about a set.
 *
 * IT IS CURATOR METADATA, AND SAYING SO IS NOT A FORMALITY. The route writes
 * `project.json` and nothing else — not the standing brief, not a handoff,
 * not a journal line, not a foundation's bytes. The single-writer rule the
 * memory layer rests on is "one writer per FILE, with provenance that
 * matches", and this file has exactly one writer (the app) for exactly one
 * kind of fact (the owner's choice about which wikis to draw on). Tiers 2 and
 * 3 stay agent-only over MCP, unchanged.
 *
 * EVERY REFUSAL BECOMES A SENTENCE. The store names nine, and two of them
 * carry data the user needs — the cap, and which domain was not recognised —
 * so those are read off the payload rather than paraphrased.
 */
async function saveKnowledgeDomains(next, token) {
  const domain = state.activeDomain;
  const project = state.activeProject;
  if (!domain || !project || state.knowledgeSaving) return;
  state.knowledgeSaving = true;
  state.knowledgeSaveError = null;
  render(token);
  let error = null;
  let applied = null;
  try {
    const res = await fetch('/api/memory/' + encodeURIComponent(domain) + '/'
      + encodeURIComponent(project) + '/knowledge/domains', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      // `null` CLEARS, which is what removing the last one means: the project
      // goes back to drawing on the domain it lives in. An empty ARRAY is a
      // refusal at the store (`empty-list`), deliberately — "none at all" is
      // not a state a project can be in.
      body: JSON.stringify({ knowledgeDomains: next && next.length ? next : null }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data && data.ok) {
      applied = data;
    } else {
      const code = data && data.error ? String(data.error) : 'HTTP ' + res.status;
      error = code === 'too_many_domains'
        ? 'A project can draw on at most ' + (data.cap || 12) + ' domains.'
        : code === 'unknown_domain'
          ? 'Not a domain on this computer: '
            + (Array.isArray(data.domains) ? data.domains.join(', ') : 'unknown') + '.'
          : code === 'invalid_domain' ? 'That is not a usable domain name.'
            : code === 'readonly'
              ? 'This project is a read-only Shared Brain mirror, so its choices cannot be changed here.'
              : code === 'project_not_found' ? 'This project no longer exists.'
                : code === 'locked'
                  ? 'Another write is in progress on this project. Try again in a moment.'
                  : code;
    }
  } catch (err) {
    error = err.message;
  }
  if (!isCurrentMount(token)) return;
  state.knowledgeSaving = false;
  state.knowledgeSaveError = error;
  if (applied) {
    // THE ROUTE'S OWN ANSWER, not the list we sent: it carries the normalised
    // set and whether the project is back on its default, which is enough to
    // repaint without a second read.
    if (state.projectRead) {
      state.projectRead = { ...state.projectRead,
        knowledgeDomains: Array.isArray(applied.knowledgeDomains) ? applied.knowledgeDomains : [],
        knowledgeDomainsDefaulted: applied.knowledgeDomainsDefaulted === true };
    }
    // The project read is cached; a stale copy would put the old set back on
    // the next visit.
    forgetProject(domain, project);
    loadKnowledge(
      (state.projectRead && state.projectRead.knowledgeDomains) || [], token)
      .catch((err) => reportAsyncMountFailure(token, err));
  }
  render(token);
}

/**
 * THE HONESTY METER'S NUMBERS, READ OFF THE ROUTE WITHOUT INVENTING ANY.
 *
 * Every count is an integer OR NULL, never a defaulted zero: "the route did
 * not say" and "it happened no times" are two different facts, and collapsing
 * them here would print a clean `0 read and did not save` over a reading that
 * was never taken. That collapse is this repository's most reliably recurring
 * defect class — `domainsScanned`, `lastIngestKind` and `scopeCount` all carry
 * the same rule — and it costs the most on this particular reading, whose
 * entire subject is what the log can and cannot see.
 *
 * `readNotSaved` is taken from the route and NOT re-derived. It is not
 * `read - saved`: a session may save without ever having read (an agent that
 * never bootstrapped still hands off), so the subtraction would be a different
 * quantity wearing this one's name. src/routes/memory.js computes it from the
 * per-session facts, which is the only place both halves are in hand.
 */
function captureFacts(payload) {
  const p = payload && typeof payload === 'object' ? payload : null;
  const t = p && p.totals && typeof p.totals === 'object' ? p.totals : {};
  const num = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
  const rows = p && Array.isArray(p.sessions)
    ? p.sessions.filter((r) => r && typeof r === 'object') : [];
  return {
    // POSITIVE EVIDENCE ONLY, like the work-stream table's `machineIsThisMachine`:
    // the log is treated as present because the route SAID so, never because
    // the field was missing.
    logPresent: p ? p.logPresent === true : false,
    sessions: num(t.sessions),
    read: num(t.sessionsRead),
    saved: num(t.sessionsSaved),
    readNotSaved: num(t.sessionsReadNotSaved),
    legacyLines: num(t.legacyLines),
    selfTestLines: num(t.selfTestLines),
    rows,
    shown: num(p && p.sessionsShown) === null ? rows.length : p.sessionsShown,
    truncated: p ? p.sessionsTruncated === true : false,
    note: p && typeof p.note === 'string' && p.note.trim() ? p.note.trim() : null,
    // ── THE CONTRADICTION FLAG (v3.64.1) ───────────────────────────────
    // POSITIVE EVIDENCE ONLY, like `logPresent` above: true because the route
    // SAID so. It says that this project HAS saves inside the window and the
    // log recorded no session to attribute them to — the reading that used to
    // leave "saved 47 min ago" and "no agent session in the last 30 days" on
    // screen together with nothing to reconcile them.
    noSessionsButSaves: p ? p.noSessionsButSaves === true : false,
  };
}

/**
 * STEP 2's SECOND READING — THE HONESTY METER (v3.63.0).
 *
 * It sits under the "Last saved" reading, which joined it inside the body in
 * v3.64.1 (it used to render above the step's heading). The two answer about
 * the same layer — what the last session left, and whether the sessions that
 * touched it read and saved — so they open the step together.
 *
 * ── IT REPORTS, AND IT NEVER BLOCKS (Decision G) ───────────────────────
 * Nothing here refuses a session, delays one or warns an agent. A meter that
 * could refuse a session would be the enforcement the capture design forbids,
 * and the ⓘ says so in as many words so nobody reads a low figure as a gate.
 *
 * ── THE READING NEVER FOLDS; THE DETAIL DOES ───────────────────────────
 * v3.16.1's rule. The four numbers and the route's own `note` are in the open;
 * the per-session list is a closed `<details>` like its four siblings, because
 * twenty rows of history is the shape v3.58.0 measured this page at 3,241px
 * for.
 *
 * ── "READ AND DID NOT SAVE" IS THE POINT, SO IT IS NAMED ───────────────
 * Not a percentage, not a bar, not `4/6`. A ratio hides the one number the
 * reading exists to surface, and it hides it in the direction that flatters:
 * `67%` reads as a grade, `2 read and did not save` reads as two sessions
 * whose work is not in the store. The clause is dropped only when the route
 * did not send the figure — never printed as zero.
 *
 * ── THE DOT IS AN AGE, NOT A RATIO, AND THAT IS A CORRECTION ───────────
 * The design record says the mark's tier comes "from the ratio". The shared
 * scale (design-system-source.md §6) is an AGE ladder whose first rule is that
 * tiers are "cut on `formatAge`'s own bands, never a second threshold table" —
 * so a ratio painted in `--fresh-*` would be a second ladder wearing the
 * first's colours, and `4 of 6` in amber would read as "four hours ago" at a
 * glance. The mark therefore reports WHEN THE LAST SESSION WAS, which is a
 * real age on the real ladder, and a reading nobody could take (no log, no
 * session, no stamp) is the dashed unknown ring with the words beside it —
 * never age zero.
 */
// ── WHAT A SESSION IS — ONE COPY, READ BY STEP ②'s ⓘ (v3.65.1, D4) ───────
// Through v3.65.0 this text sat behind a mark of its own, alone on the first
// line of the CAPTURE row's body, above the instrument and the table — three
// treatments in one row. The maintainer's word for that body: *"two different
// designs."* The words are unchanged, byte for byte; what moved is the mark
// that opens them, into step ②'s own ⓘ, where the rest of the step's
// explanation is. A step has ONE explanatory mark on this page and a reading
// inside it is not a step.
const CAPTURE_INFO_HTML =
  '<p>A <b>session</b> is one bridge process — one run of the MCP server, from the moment an '
  + 'agent connects to the moment its window closes. It is identified by a random id the bridge '
  + 'mints for itself, so two sessions are never merged and one session is never split in two.</p>'
  + '<p>A session <b>started with the context</b> when it asked for this project’s brief, '
  + 'handoff or documents before it saved anything — at any point before that first save, not '
  + 'necessarily as its first call. It <b>saved before stopping</b> when a save succeeded; a '
  + 'refused save is not a save.</p>'
  + '<p><b>What this cannot see.</b> Only calls that came through the bridge are here. A save '
  + 'written by the command line, by a hook, or by hand in a text editor is a real save and does '
  + 'not appear in this count unless it went through the bridge. A session that never opened the '
  + 'bridge at all is not in the denominator either — so this reading is about agent sessions '
  + 'that used The Curator, and never a claim about your whole week.</p>'
  + '<p>The <b>harness name</b> beside each session is <b>self-reported</b>: the client chooses '
  + 'the name it sends, it is matched against a list of harnesses that have actually been '
  + 'measured, and anything else is shown as unknown. Nothing in the app behaves differently '
  + 'because of it — it is a label on a row and nothing more.</p>'
  + '<p>It comes from a local file beside your settings, never inside your knowledge folder, so '
  + 'nothing here is ever synced. A line carries the tool’s name, the domain and project it '
  + 'touched, whether it succeeded and how long it took — never an argument, never a result, '
  + 'never a file path. Calls made by the bridge’s own self-test are excluded.</p>'
  + '<p><b>Nothing here stops a session.</b> This reading reports; it never refuses, delays or '
  + 'warns an agent, and no number on it can.</p>';

function renderCaptureMeter() {
  const c = state.capture && state.capture.domain === state.activeDomain
    && state.capture.project === state.activeProject ? state.capture : null;

  // ── THE ⓘ HAS LEFT THIS READING (v3.65.1, D4) ────────────────────────
  // It was a mark of its own, alone on the first line of the row's body, above
  // an instrument and a table — the *"two different designs"* the maintainer
  // counted, with a third floating above them. What a session IS, what the log
  // cannot see and that nothing here stops a session are explanations of the
  // STEP, so they are the last paragraphs of step ②'s own ⓘ now. There is one
  // explanatory mark per step on this page and this reading is not a step.
  //
  // IT COULD NOT MOVE INTO THE `<summary>`: an interactive control there
  // toggles its own section when clicked (the v3.0.1-beta.18 hazard, named at
  // this function's own head), and the fix this file uses everywhere is the one
  // no later edit can undo — there is no propagation path, because the control
  // is not there.
  const shell = (bodyHtml) => '<div class="mem-capture">'
    + '<div class="mem-capture-head">'
      + '<div class="mem-capture-cells">' + bodyHtml + '</div>'
    + '</div>';

  if (!c || (!c.data && !c.error)) {
    // RESERVE THE HEIGHT, exactly as step 3 does: the reading lands in one
    // local request, and a step that grows a row under the reader's eye is the
    // defect the project skeleton exists to remove.
    return shell('<div class="mem-ghost mem-ghost-line" aria-busy="true"></div>') + '</div>';
  }
  if (c.error) {
    // NEUTRAL, NOT DANGER, and the distinction is the honest one. Step 3 paints
    // a failed stats read red because that domain's wiki certainly exists; this
    // route may legitimately be absent — an install running a server older than
    // v3.63.0 has no capture endpoint at all — and dressing an optional reading
    // that is simply not there as a fault would be the app claiming a problem
    // it has not diagnosed.
    return shell(renderStatus({
      state: 'neutral',
      title: 'No capture reading for this project',
      detail: c.error,
    })) + '</div>';
  }

  const f = captureFacts(c.data);
  const win = CAPTURE_WINDOW_DAYS + ' days';

  // ── THE HEADLINE FIGURE, AND THE THREE STATES IT HAS TO TELL APART ────
  // "no log on this computer", "a log, and nothing ran" and "N sessions" are
  // three different facts and the first two are not failures. Only the third
  // takes an age mark off a real stamp.
  let value;
  let tier = 'unknown';
  let prov = null;
  if (!f.logPresent) {
    value = 'no usage log on this computer yet';
  } else if (f.sessions === null) {
    value = 'sessions could not be counted';
  } else if (f.sessions === 0) {
    value = 'no agent session in the last ' + win;
  } else {
    value = f.sessions.toLocaleString('en-US')
      + ' session' + (f.sessions === 1 ? '' : 's') + ' in the last ' + win;
    // THE SENTENCE, WITH THE UNCOMFORTABLE NUMBER IN IT. Each clause is
    // dropped INDIVIDUALLY when the route did not send its figure, so a
    // partial answer prints what it knows and claims nothing else.
    prov = [
      f.read === null ? null : f.read + ' started with the context',
      f.saved === null ? null : f.saved + ' saved before stopping',
      f.readNotSaved === null ? null : f.readNotSaved + ' read and did not save',
    ].filter(Boolean).join(' · ') || null;
    const newest = f.rows.length ? (f.rows[0].endedAt || f.rows[0].startedAt) : null;
    const secs = effectiveSave({ savedAt: newest }).seconds;
    if (secs !== null) tier = freshnessTier(secs);
  }


  // ── THE ROUTE'S OWN NOTE, UNFOLDED ────────────────────────────────────
  // Whatever the route needs to say about the reading it just gave — an absent
  // log, a log that began after the window opened, or (v3.64.1) saves in this
  // window that no session accounts for — is an OUTCOME, and an outcome may
  // not sit behind a chevron (v3.16.1). It is rendered as the route sent it
  // rather than paraphrased: the producer knows which limit applied and this
  // view does not. The third tenant is the one that reconciles the reading
  // ABOVE this one — "Last saved 47 min ago" beside "no agent session in the
  // last 30 days", both true — and it names the remedy, which is why it
  // outranks the other two rather than queueing behind them.
  const notice = f.note
    ? renderStatus({ state: 'neutral', title: f.note })
    : '';

  // ── THE TWO LINE CLASSES THIS READING DOES NOT COUNT ──────────────────
  // Stated in the open rather than only in the ⓘ, because both change what the
  // figures are taken over. `legacyLines` are calls written before the bridge
  // recorded a session id at all — real work that cannot be attributed to any
  // session — and `selfTestLines` are the app's own "Test all N tools" run,
  // which is the exact contamination `via: 'self-test'` was invented to keep
  // out.
  //
  // THE LEGACY CLAUSE DEFERS TO THE ROUTE'S NOTE, and this is the one thing a
  // browser found that no fixture could: src/routes/memory.js emits ONE note
  // "naming whichever honest limit applies", and on a real log that note IS the
  // legacy count — so the two sentences landed four pixels apart saying the
  // same number in different words. The route is the producer and owns that
  // disclosure; this line says it only where the route stayed silent. The
  // SELF-TEST count is never in the route's note at all, so it is always this
  // line's. Written as "is there a note" rather than as a match against the
  // producer's prose, which would be a copy of a sentence this file does not own.
  //
  // AND IT DEFERS TO THE LOG-LIMIT NOTES ONLY (v3.64.1). The note slot gained
  // a third tenant — the stale-bridge clause — which says nothing about
  // legacy lines, so deferring to it would drop a disclosure the route still
  // owes. The test is therefore "is the route's note ABOUT this", answered
  // structurally from the flag rather than by matching the producer's prose.
  const limits = [
    // ── THE SESSION CAP, MOVED OUT OF THE DELETED TABLE (v3.65.1) ───────
    // `renderCaptureSessions` owned this sentence and went with the table.
    // It is a DISCLOSURE about what the figures are taken over — the same
    // class as the two below it — so it belongs where they are: outside the
    // chevron, never inside a body a reader may not open. THE CAP IS THE
    // ROUTE'S ANSWER, NOT THE REQUEST: `sessionsTruncated` is what the
    // producer said it had to leave out, and printing CAPTURE_SESSION_LIMIT
    // here instead would report a cap as a measurement.
    f.truncated
      ? 'showing the ' + f.shown + ' most recent of '
        + (f.sessions === null ? f.shown : f.sessions) + ' sessions' : null,
    ((!f.note || f.noSessionsButSaves) && f.legacyLines)
      ? f.legacyLines.toLocaleString('en-US') + ' earlier call'
      + (f.legacyLines === 1 ? '' : 's') + ' carried no session id and cannot be counted' : null,
    f.selfTestLines ? f.selfTestLines.toLocaleString('en-US') + ' self-test call'
      + (f.selfTestLines === 1 ? '' : 's') + ' excluded' : null,
  ].filter(Boolean).join(' · ');
  const limitsHtml = limits
    ? '<p class="mem-capture-limits">' + escapeHtml(limits) + '</p>' : '';

  // ── CAPTURE IS ONE ROW NOW (v3.65.0, R2) ──────────────────────────────
  //
  // IT WAS A BLOCK PLUS A FOLD, and that is what the maintainer was reading
  // when he wrote *"I have no clue what a session is ... I see that the top
  // card 'captured one session in the last 30 days' is an overview for the
  // Sessions dropdown."* He is right: one reading was being told twice, under
  // two names, in two designs — a bespoke `.mem-capture` card above four
  // `.mem-fold` rows, with a fifth fold called "Sessions" underneath it
  // carrying the same four numbers again.
  //
  // So it is ONE row in the same chrome as its four siblings. The SUMMARY is
  // the whole reading — the headline and the three clauses — which is what a
  // closed row has to carry to be worth opening; the BODY is the instrument
  // and the per-session table. The word "Sessions" leaves the screen: it
  // survives in the ⓘ, which is where what a session IS belongs, and as the
  // table's own column heading.
  //
  // WHAT STAYS OUTSIDE THE CHEVRON, and this is v3.16.1 rather than a
  // preference: the route's own `note` and the two line-class disclosures.
  // The note is an OUTCOME — on a real log it names the limit that applied,
  // and since v3.64.1 it can name a stale bridge and the remedy for it — and
  // an outcome may never sit behind a chevron. The disclosures qualify what
  // the figures are taken OVER, so a reader who never opens the row must
  // still have them.
  //
  // THE ⓘ MOVES INTO THE BODY. An interactive control inside a `<summary>`
  // toggles its own section when clicked (the v3.0.1-beta.18 hazard), and the
  // fix this file uses everywhere is the one no later edit can undo: there is
  // no propagation path, because the control is not there.
  const meta = '<span class="fresh-dot fresh-' + tier + '" aria-hidden="true"></span>'
    + escapeHtml(value + (prov ? ' · ' + prov : ''));
  // ── THE INSTRUMENT (M2) ───────────────────────────────────────────────
  // The three clauses again, keyed and valued, plus the newest session's age
  // on the shared scale. It is not a repetition of the summary for its own
  // sake: the summary is one line to decide with, this is the reading laid
  // out so each figure can be found, and the `read and did not save` line
  // carries a tone when it is not zero. Every figure is dropped INDIVIDUALLY
  // when the route did not send it — a partial answer prints what it knows.
  // ── THE BODY IS THE MONITOR, AND ONLY THE MONITOR (v3.65.1, D4) ───────
  //
  // The maintainer, on the shipped body: *"two different designs, one row-like
  // then table-like"* — a `.mem-capture-info` ⓘ alone on its own line, then
  // the monitor, then a five-column `<table class="mem-cap-table">` (Started ·
  // Harness · Calls · Read · Saved). Three treatments inside one row, for one
  // reading. Measured at 1370: the ⓘ 421×893×25.3, the monitor 421×893×130.1,
  // the table below both.
  //
  // So `renderCaptureSessions` and its `.mem-cap-*` CSS are DELETED, and the
  // monitor carries every fact the table carried rather than losing one:
  // `calls` is the sum of the window's per-session calls — the table's only
  // figure that had nowhere else to live — and `newest` gains the newest
  // session's HARNESS as its qualifying clause, in the table's own words
  // ("not reported" when the log has no client name for it), which is the
  // reading the maintainer went to the table for when his Claude Code
  // sessions came back as `other`.
  //
  // WHAT IS NOT IN HERE, and both are deliberate: `self-test calls excluded`
  // stays OUTSIDE the row in `.mem-capture-limits`, and the route's own
  // `note` stays outside it too — they are disclosures and an outcome, and
  // v3.16.1 is that neither sits behind a chevron. The ⓘ leaves the body
  // altogether: what a session IS belongs in the STEP's explanation, and it
  // cannot go in the `<summary>` because an interactive control there toggles
  // its own section (the v3.0.1-beta.18 hazard).
  const newest = f.rows.length ? f.rows[0] : null;
  const newestAt = newest ? (newest.endedAt || newest.startedAt) : null;
  const newestSecs = effectiveSave({ savedAt: newestAt }).seconds;
  // THE TABLE'S ONLY LOST FIGURE. Summed over the UNCAPPED rows the route
  // sent; `sessionsTruncated` is disclosed separately by `.mem-capture-limits`,
  // so a partial list is never reported as a total — the value is dropped
  // entirely when the route sent no usable per-session calls at all.
  const callsTotal = f.rows.reduce(
    (n, r) => n + (Number.isInteger(r && r.calls) && r.calls >= 0 ? r.calls : 0), 0);
  const hasCalls = f.rows.some((r) => Number.isInteger(r && r.calls));
  const monitor = renderMonitor({
    label: 'The capture reading',
    lines: [
      f.sessions === null ? null
        : { key: 'sessions', value: f.sessions, sub: 'in the last ' + win },
      f.read === null ? null : { key: 'started with the context', value: f.read },
      f.saved === null ? null : { key: 'saved before stopping', value: f.saved },
      f.readNotSaved === null ? null
        : { key: 'read and did not save', value: f.readNotSaved,
          tone: f.readNotSaved ? 'warn' : undefined },
      !hasCalls ? null
        : { key: callsTotal === 1 ? 'tool call' : 'tool calls', value: callsTotal,
          sub: f.truncated ? 'over the sessions listed' : undefined },
      newestSecs === null ? null
        : { key: 'newest', value: formatAge(newestSecs) || 'time unknown',
          markHtml: '<span class="fresh-dot fresh-' + freshnessTier(newestSecs)
            + '" aria-hidden="true"></span>',
          sub: (newest && typeof newest.client === 'string' && newest.client)
            ? newest.client : 'not reported' },
    ].filter(Boolean),
  });
  // NOTHING TO OPEN, NO CHEVRON — the call this function already made for its
  // own idle state, and the one `renderSaveStatus` makes for a healthy save.
  const body = monitor;
  const open = (state.openFolds && state.openFolds.capture) ? ' open' : '';
  const row = body
    ? '<details class="mem-fold" data-mem-fold="capture"' + open + '>'
      + '<summary class="mem-fold-summary" id="mem-fold-capture">' + icon('chevronRight', 14)
        + '<span>Capture</span>'
        + '<span class="mem-fold-meta">' + meta + '</span>'
      + '</summary>'
      + '<div class="mem-fold-body">' + body + '</div>'
    + '</details>'
    : '<div class="mem-fold mem-fold-flat"><div class="mem-fold-body mem-save-flat">'
      + '<span>Capture</span>'
      + '<span class="mem-fold-meta">' + meta + '</span>'
    + '</div></div>';
  return row + notice + limitsHtml;
}


/**
 * THE METER'S ONE REQUEST (v3.63.0).
 *
 * ── WHAT IT COSTS, AT THE PRODUCER ────────────────────────────────────
 * `GET /api/memory/:domain/:project/capture` reads one local JSONL file,
 * rotated at 1 MB, and aggregates it. No LLM, no network, no read of any wiki
 * page or handoff — opening this screen costs one file scan.
 *
 * ── WHY `since` IS SENT RATHER THAN DEFAULTED ─────────────────────────
 * The window is a reading decision, not a storage one, so the view names it
 * (CAPTURE_WINDOW_DAYS) and the route honours it. Computed at REQUEST time and
 * cached with its answer: a window recomputed on every paint would make two
 * consecutive reads of an unchanged log differ, which is exactly what the
 * cache exists to prevent.
 *
 * ── CACHED PER (DOMAIN, PROJECT), AND STAMPED ─────────────────────────
 * Same discipline as `loadKnowledge` one level up, one key finer. NEVER
 * THROWS, and a failure is a DISCLOSURE rather than a blank.
 */
async function loadCapture(domain, project, token) {
  if (!domain || !project) return;
  const key = keyOf(domain, project);
  const hit = captureCache.get(key);
  if (hit) {
    state.capture = { domain, project, data: hit, error: null };
    return;
  }
  if (captureInFlight === key) return;
  captureInFlight = key;
  state.capture = { domain, project, data: null, error: null };
  const since = new Date(Date.now() - CAPTURE_WINDOW_DAYS * 86400000).toISOString();
  let next;
  try {
    const res = await fetch('/api/memory/' + encodeURIComponent(domain) + '/'
      + encodeURIComponent(project) + '/capture?since=' + encodeURIComponent(since)
      + '&limit=' + CAPTURE_SESSION_LIMIT);
    const data = await res.json();
    next = res.ok && data && data.ok
      ? { domain, project, data, error: null }
      : { domain,
        project,
        data: null,
        error: (data && data.error) ? data.error : 'HTTP ' + res.status };
  } catch (err) {
    next = { domain, project, data: null, error: err.message };
  }
  if (captureInFlight === key) captureInFlight = null;
  if (!isCurrentMount(token)) return;
  // STAMPED AT THE POINT OF USE. This view switches project without
  // unmounting, so a reply for a project the user has already left must never
  // be written into state at all.
  if (state.activeDomain !== domain || state.activeProject !== project) return;
  if (next.data) captureCache.set(key, next.data);
  state.capture = next;
  render(token);
}

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
      state: 'danger', title: 'Could not read this project’s context', detail: state.detailError,
    }) + '</div>';
  }
  if (state.detailLoading && !read) {
    return header + renderProjectSkeleton();
  }

  const scopes = (read && read.scopes) || [];
  const fndFacts = foundationsFacts(read);

  // ── STEP ① — FOUNDATIONS ─────────────────────────────────────────────────
  //
  // FIRST, and the position is the argument — the argument this block has been
  // making from position four since v3.59.0: the brief is what YOU tell an
  // agent, the foundations are what the PROJECT tells it, and the journal is
  // history. Reading top to bottom is then the same order a session start
  // reads in. The step order makes that true rather than aspirational.
  //
  // THE LEDE IS AN INSTRUCTION, NOT A DEFINITION (the v3.58.0 rule): what a
  // canonical document IS lives in the ⓘ, along with the two ways one arrives.
  // The "Start here." prefix drops the moment one document exists and the tail
  // is BYTE-IDENTICAL either way — Providers block 1's own rule, so the
  // sentence a returning user reads is the sentence they read last time with
  // one clause gone, rather than a different sentence.
  //
  // THE FOUR NEVER-FOLD NOTICES ARE IN `noticeHtml` (P1-7), which puts them
  // above the heading inside the block's wrapper rather than inside the body's
  // 32px prose indent. That slot is what `shared/block.js` built them for, and
  // no block on this page had ever passed one.
  const canonicalBlock = memStep({
    num: 1,
    id: 'context-canonical',
    title: 'Documents',
    infoText:
      // THE LEDE, MOVED (R4). It was the sentence under the title; it is the
      // first thing behind the mark now, and it keeps the "Start here."
      // prefix that drops the moment one document exists.
      '<p>' + (fndFacts.count ? '' : '<b>Start here.</b> ')
      + 'Add the documents an agent must not act without.</p>'
      + '<p>These are <b>canonical documents</b> — this project carries each one VERBATIM: the '
      + 'architecture, the decisions, the conventions, the roadmap. Not a summary of one: the '
      + 'bytes, so an agent reads what you would read. Each one is <b>replaced whole</b> on every '
      + 'write and never merged, which is what makes it quotable.</p>'
      + '<p>Until now those lived only inside a code repository, which meant an agent without a '
      + 'checkout could not see them, and an ingested copy did not travel because source files are '
      + 'not synced. These do travel, beside the brief and the handoffs.</p>'
      + '<p>Every project answers <b>one question once</b>: does The Curator keep these documents, '
      + 'or are they <b>mirrored</b> from a repository on this computer? The store refuses a mix, '
      + 'and the answer cannot be changed afterwards — so a project that has not answered it yet '
      + 'shows the choice here rather than an empty table.</p>'
      + '<p><b>Mirrored</b> means a byte-for-byte copy of a file in a checkout, with the commit it '
      + 'came from recorded and a checksum compared on every read — that is what the freshness '
      + 'column reports. A plain folder with no version control in it works perfectly well as a '
      + 'source; the source line then shows the path with no commit beside it. A mirrored document '
      + 'belongs to its repository, so it is changed THERE and re-copied here.</p>'
      + '<p><b>Kept by The Curator</b> means the document lives only here, and there are three ways '
      + 'one arrives: you write or paste it, you import a file from this computer — <b>each file '
      + 'you choose becomes one document</b>, read in this browser and shown to you before '
      + 'anything is saved, never uploaded anywhere — or an '
      + '<b>agent you ask</b> writes it — a commissioned write, the same permission the standing '
      + 'brief needs, and nothing writes one on its own. Setting this up seeds four '
      + '<b>skeletons</b>: documents that carry prompts rather than prose, which an agent is told '
      + 'to answer rather than to believe.</p>'
      // THE SENTENCE THAT USED TO SIT UNDER THE TABLE (v3.65.0). A standing
      // fact about ownership, not an outcome, and ownership is set once — so
      // it belongs where the rest of the ownership explanation is.
      + '<p>On a <b>mirrored</b> project an agent’s save here is <b>refused</b>: the documents '
      + 'belong to the folder they are copied from, so an agent asked to write one is told to '
      + 'change it there and refresh. The row’s own summary says <b>mirrored</b>, which is the '
      + 'one-word form of the same fact.</p>'
      + '<p>An edit here is <b>yours</b>, stamped as a human write and never as an agent’s — the '
      + 'same rule the standing brief follows. One cost comes with it: this tier has no per-machine '
      + 'copy, so two computers editing one document converge to whichever saved last. Edit rarely, '
      + 'then sync.</p>'
      + '<p>' + docsLinkHtml('memory.foundations', 'Read more in the guide') + ' · '
      + docsLinkHtml('memory.foundations-edit', 'Starting a project') + '</p>',
    noticeHtml: foundationsNotices(read),
    bodyHtml: renderFoundations(read),
  });

  // ── STEP ② — WORKING STATE ───────────────────────────────────────────────
  //
  // THREE FOLDS, IN OWNERSHIP-AND-RECENCY ORDER: what the last session left,
  // then what you told it, then the history. All three CLOSED by default and
  // remembered per fold — v3.58.0's measurement (3,241 → 1,278px) is the
  // reason, and re-opening any of them by default re-opens that defect.
  //
  // THE STATUS STACK IS THE STEP'S FIRST ROW, INSIDE THE BODY (v3.64.1).
  // It was `noticeHtml`, and `shared/block.js` places `noticeHtml` ABOVE the
  // heading inside the wrapper (its own docblock says so) — so the "Last
  // saved" reading rendered above "② Working state" and read as a card of its
  // own, while CAPTURE, the other reading about the same layer, was the first
  // thing INSIDE the body. The maintainer's report was a literal description
  // of that markup: a summary above one step and a report inside it. Both
  // readings now open the body, in that order, and nothing renders above a
  // step heading on this page.
  //
  // THE WHOLE STACK MOVED, not the reading out of it, and that is a
  // deliberate refusal to split. `patchOpenPair` re-composes this ONE
  // expression into `.mem-status-stack` by selector and
  // scripts/test-next-memory-switch.js §8 compares the two byte-for-byte;
  // splitting the reading from the warnings means splitting that patch, which
  // is the one edit on this screen that silently breaks a shipped no-repaint
  // guarantee. Everything in the stack is still unfolded, so v3.16.1's rule
  // — a warning, a cost or an outcome may never fold — is untouched by the
  // move; only its position relative to the heading changed.
  //
  // WHAT IS NOT HERE any more: the "Working on" line (the strip carries its
  // age, the work-stream fold's summary carries its words) and the "Standing
  // brief — updated …" line, which the brief fold's own summary already says.
  // A figure in a sentence that the card below already shows is the
  // de-duplication `views/domains.js` performs on the domain header.
  //
  // `.mem-status-stack` IS THE SAME WRAPPER under the same class, and that is
  // deliberate rather than incidental: `patchOpenPair` writes into it by that
  // selector, so keeping the name keeps v3.57.0's targeted row-press patch
  // working through the restructure. The expression below is the one
  // `patchOpenPair` re-composes; the two are compared byte-for-byte by
  // scripts/test-next-memory-switch.js §8.
  const statusHtml = renderSaveStatus(read, d) + renderStaleNotice() + renderUnlistedNote(read, d);
  const stateBlock = memStep({
    num: 2,
    id: 'context-state',
    title: 'Memory',
    infoText:
      // THE LEDE, MOVED (R4).
      '<p>You write the brief; agents write handoffs and the journal.</p>'
      + '<p>State <b>supersedes</b>. Every save REPLACES the last one rather than being merged into '
      + 'it, which is the whole point: state has to be able to say “no longer true”, and a store '
      + 'that only accumulates cannot.</p>'
      + '<p>You own the <b>standing brief</b> — the one tier a human owns. Agents READ it on every '
      + 'call and, unless you ask one to, never write it; you edit it here with the pencil, or open '
      + '<span class="mono">state/&lt;project&gt;/project.md</span> in any text editor. Saving '
      + 'replaces the whole document, so send the complete brief rather than an addition. It is the '
      + 'part that <b>rarely changes</b>: the goal, the firm decisions not to re-litigate, the '
      + 'working model, and pointers to where the depth lives — so an OLD brief is not a stale one, '
      + 'which is why it carries a date and deliberately no freshness mark.</p>'
      + '<p>Agents own the rest. A <b>handoff</b> is what the last session left for the next one, one '
      + 'per thread of work — the files call that thread a <i>scope</i>, and the slug is still shown '
      + 'as one — and parallel threads get their own, so they never overwrite each other. Press a row '
      + 'to read it. Each machine writes to its OWN folder, which is what makes two computers safe '
      + 'over sync: no two of them ever touch one file. So one thread can appear as several rows — '
      + 'one saved copy per machine — and the count under the table says both numbers.</p>'
      + '<p>Two rows sharing a thread AND a machine cannot happen; two <b>harnesses</b> on one '
      + 'machine can, and they overwrite each other, because the folder has no harness segment. '
      + 'This step says so when the journal shows it, and the remedy is to give each tool its own '
      + 'handoff.</p>'
      + '<p>The <b>journal</b> is append-only and it accumulates, so any entry MAY SINCE HAVE BEEN '
      + 'SUPERSEDED — a blocker named in an old headline can have been fixed three saves ago. It '
      + 'survives what a handoff cannot: two agent tools writing one thread overwrite each '
      + 'other’s handoff, and both trails are still here.</p>'
      // ── AND WHAT CAPTURE IS READING (v3.65.1, D4) ───────────────────
      // One copy, defined beside the meter it describes; the mark that used
      // to open it inside the CAPTURE row's body is gone, because a step has
      // one explanatory mark and a reading inside it is not a step.
      + CAPTURE_INFO_HTML
      + '<p>' + docsLinkHtml('memory.standing-brief', 'The standing brief') + ' · '
      + docsLinkHtml('memory.handoff', 'Handoffs') + ' · '
      + docsLinkHtml('memory.session-journal', 'The journal') + '</p>',
    // EMPTY, AND THAT IS THE POINT (v3.64.1) — nothing renders above this
    // step's heading. The slot stays available; this caller simply has
    // nothing that belongs above a heading.
    noticeHtml: '',
    bodyHtml:
      '<div class="mem-state-stack">'
        // ── THE TWO READINGS ABOUT THIS LAYER, IN ORDER ───────────────
        // "Last saved" (with the warnings that qualify it) and then CAPTURE.
        // Both are readings about the working state, so both belong to the
        // step that owns it, above the three folds they qualify.
        + (statusHtml ? '<div class="mem-status-stack">' + statusHtml + '</div>' : '')
        // ── THE HONESTY METER, SECOND (v3.63.0) ───────────────────────
        // Inside step 2 rather than in a block of its own or as a fourth
        // cell on the strip: the strip is three cells because there are
        // three LAYERS, and a fourth would break that mapping. This is a
        // reading ABOUT the working state — did the sessions that touched
        // it start with it, and did they save it — so it belongs to the
        // step that owns it, above the three folds it qualifies.
        + renderCaptureMeter()
        + renderWorkStreamsFold(read, d)
        + renderBrief(read)
        + renderJournal()
      + '</div>',
  });

  // ── STEP ③ — KNOWLEDGE ───────────────────────────────────────────────────
  //
  // THE ONE LAYER THIS PROJECT READS RATHER THAN OWNS. The wiki belongs to the
  // DOMAIN — every project in the domain draws on the same one — so this step
  // is a summary and two doors, and both doors leave the view.
  //
  // NO DOCS LINK YET, and that is a stated gap rather than an oversight: the
  // key this panel wants (`memory.knowledge`) lives in shared/docs-links.js,
  // which this release's shell package owns. A hand-typed URL here would be
  // the one thing scripts/test-docs-links.js cannot check.
  const knowledgeBlock = memStep({
    num: 3,
    id: 'context-knowledge',
    title: 'Knowledge',
    infoText:
      // THE LEDE, MOVED (R4).
      '<p>The domains this project draws on. Open one in Domains, or ask it in Chat.</p>'
      + '<p>A domain <b>accumulates</b>. A new source deepens the pages that are already there '
      + 'rather than adding a copy beside them — which is the difference between this layer and the '
      + 'two above it, where a save replaces what was there and a document is carried word for '
      + 'word.</p>'
      + '<p>Ingest and chat write it; nothing on this page does. It belongs to the <b>domain</b> '
      + 'rather than to this project, so every project in this domain draws on the same pages and '
      + 'these figures move when you ingest, not when an agent saves.</p>'
      + '<p>The counts are taken by walking the folder rather than by reading any page, and no '
      + 'model is called to draw them — opening this screen costs nothing.</p>',
    bodyHtml: renderKnowledge(),
  });

  return header + renderLayerStrip(read) + canonicalBlock + stateBlock + knowledgeBlock;
}

/**
 * THE FIRST FRAME OF A PROJECT NOBODY HAS READ YET.
 *
 * ── WHAT IT REPLACES, AND WHY THAT WAS THE REPORTED DEFECT ──────────────
 * A bare `gatedLoader` in a `.mem-section`. Measured in a browser: the main
 * column went from 5,062px to **215px** on the frame the click landed, sat
 * there for the round trip, then jumped back. The loading gate means nothing
 * is even DRAWN in that space for the first 200ms, so what the eye gets is a
 * column that empties and refills — which is what "loaded with some delay"
 * describes, at a delay of 30ms.
 *
 * ── IT IS NOT A DECORATION, IT IS THE ANSWER, EARLY ─────────────────────
 * `GET /api/memory` has ALREADY told this view, for every project: the
 * headline the newest save carried, which work-stream it was, that save's
 * clock, harness, model and verdict, how many work-streams and saved copies
 * there are, and whether there is a standing brief. That is most of block ①
 * and the SHAPE of blocks ② and ③. So the skeleton paints the real Status
 * reading from the row it already holds and reserves the rest — one ghost row
 * per saved copy, up to the window — rather than painting a spinner over
 * facts it is holding in its hand.
 *
 * NOTHING HERE IS INVENTED. Every figure comes off the index row; when the row
 * is missing (the project was selected from a stale list) the ghosts stand
 * alone and no reading is claimed. `aria-busy` says the region is still
 * filling, so a screen reader is not told a partial table is the table.
 *
 * ── NO PULSE, AND NO FADE ON THE FILL EITHER ───────────────────────────
 * The ghosts are flat, and the real content that replaces them is not faded
 * in. Both were considered and both are refused for the same measured reason:
 * this frame is on screen for 15-40ms. A shimmer is motion that says "wait"
 * for less time than it takes to read the word, and a 120ms cross-fade over a
 * 30ms wait makes the screen demonstrably SLOWER than the swap it decorates.
 * The transition this screen was missing is not an animation — it is the
 * column keeping its size, which is what this function is for.
 */
function renderProjectSkeleton() {
  const row = state.projects.find((p) => p && p.domain === state.activeDomain
    && p.project === state.activeProject) || null;

  // ONE GHOST PER SAVED COPY, capped at the window the table itself paints, so
  // the reserved height is the height the table will actually take. Never
  // fewer than one: a project in this branch has been selected, and a table
  // with no rows at all is the shape of the EMPTY state, which is a different
  // screen and must not be implied while a read is in flight.
  const copies = row && Number.isInteger(row.savedCopies) ? row.savedCopies
    : (row && Number.isInteger(row.scopeCount) ? row.scopeCount : 1);
  const ghostRows = Math.max(1, Math.min(WS_WINDOW, copies || 1));
  let rows = '';
  for (let i = 0; i < ghostRows; i++) rows += '<div class="mem-ghost mem-ghost-row"></div>';

  // THE THREE STEPS ARE THE SAME COMPONENT, with the same numerals, ids and
  // titles as the real ones — so the skeleton and the fill differ only in
  // their bodies and the block chrome does not move at all between the two
  // paints. The ledes are GONE from both (R4), which is one fewer thing that
  // could differ between the two paints rather than one more. The ⓘ panels
  // are deliberately omitted here: a help panel a user could open and have
  // torn away 30ms later is worse than one that arrives with the content —
  // and `memStep` emits no mark at all when `infoText` is empty, so the head
  // row is the numeral and the title in both frames.
  //
  // ── THE STRIP PAINTS FOR REAL, WITH THE HALF OF THE DATA WE HAVE ──────
  // `GET /api/memory` has ALREADY told this view, for every project, when the
  // last save landed — so `renderLayerStrip(null)` paints cell ② off the index
  // row rather than a spinner over a fact it is holding in its hand, and cell
  // ③ too when the domain's figures are already cached. Cell ① is OMITTED: the
  // index carries nothing at all about foundations, and "not set up yet" is a
  // claim this frame cannot make. It arrives with the read, which is the one
  // small growth this frame allows and the honest one.
  return (
    renderLayerStrip(null) +
    memStep({
      num: 1, id: 'context-canonical', title: 'Documents',
      bodyHtml: '<div class="mem-ghost-wrap" aria-busy="true">'
        + '<div class="mem-ghost mem-ghost-line"></div></div>',
    }) +
    memStep({
      num: 2, id: 'context-state', title: 'Memory',
      bodyHtml: '<div class="mem-state-stack">'
        + '<div class="mem-ghost-wrap" aria-busy="true">' + rows + '</div>'
        // ONLY WHEN THE INDEX SAYS THERE IS ONE. Reserving space for a standing
        // brief that does not exist would make the column shrink on arrival,
        // which is the jump this whole function exists to remove, in the other
        // direction. `hasBrief` rides on every index row, so this is knowledge
        // rather than a guess.
        + (row && row.hasBrief
          ? '<div class="mem-ghost-wrap" aria-busy="true">'
            + '<div class="mem-ghost mem-ghost-para"></div></div>'
          : '')
        + '</div>',
    }) +
    // ── STEP ③ IS NOT RESERVED, IT IS PAINTED ───────────────────────────
    // Its figures belong to the DOMAIN, not to the project being read, so on
    // a switch inside one domain they are already in hand and the step lands
    // filled on the first frame. `renderKnowledge` reserves its own height
    // when they are not.
    memStep({
      num: 3, id: 'context-knowledge', title: 'Knowledge',
      bodyHtml: renderKnowledge(),
    })
  );
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

  // TWO LISTS, because v3.16.1 splits them, and since v3.65.0 both hold DATA
  // rather than markup: `lines` are the WARNINGS — `renderMonitor` `loud`
  // entries, unfolded, below the row — and `detail` are the monitor LINES,
  // one fact each, which expand. The split is why they are two arrays and not
  // one with a flag: a flag is something a later edit can flip, and flipping
  // it would put a warning behind a chevron.
  const lines = [];
  const detail = [];

  // ── "WORKING ON" LEFT THIS FUNCTION (v3.62.0) ───────────────────────────
  //
  // It was the first line here: the newest save's headline, pip and age, under
  // a block titled "Status". That block is gone. The AGE is the strip's cell ②
  // and the WORDS are the work-stream fold's summary, where the row that wrote
  // them lives — `projectHeadline` is the one derivation both read, so the two
  // cannot name different saves. What is left in this function is the reading
  // for the pair you are LOOKING AT, and the warnings that qualify it.

  if (cur) {
    const eff = effectiveSave(cur);
    // `freshnessStep` LEFT THIS FUNCTION with the reading it cut (v3.65.1, D2).
    // It was this view's own six-rung ladder beside `freshnessTier`, the
    // app-wide one, on the same quantity — v3.65.0 moved the MARK to the shared
    // tier and left the step computed for a `.mem-save-pip` that no longer
    // existed. The reading is gone now, so the computation goes too:
    // shared/age.js still exports it, and this view no longer cuts a mark on
    // any ladder of its own.
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

    // ── THE READING ITSELF IS GONE (v3.65.1, D2) ─────────────────────────
    //
    // It was a dot, an age, the pair and the tool that wrote it, and a
    // completeness badge — and every one of those facts is already on this
    // screen twice. The MEMORY overview tile carries `saved <age>` with the
    // work-stream under it; the Handoffs row's summary carries the newest
    // handoff's age beside its count; the Handoffs TABLE carries the pair, the
    // machine and the harness per row. The maintainer's verdict on the row
    // that repeated them: *"no clue why it is here, what it communicates."*
    //
    // Two costs came with it and both leave with it. It was a CARD wrapping a
    // ROW — measured at 1370, its reading ended at x=1301 against 1316 for
    // every other row on the page, because `.mem-save`'s `12px 14px` padding
    // and 1px border cost 15px a side. And it was the one row whose title said
    // what the step above it already says.
    //
    // `age`, `prov`, `clock` and `freshnessTier` are still computed above:
    // `clock` decides one of the disclosure lines below, and the rest are what
    // the four save KINDS are told apart by. Nothing reads `primary` any more,
    // so there is no `primary`.
    void age; void prov;

    if (kind === 'trimmed') {
      lines.push({
        tone: 'danger',
        text: 'Part of this handoff did not survive the save — content named in the note below was '
          + 'dropped or cut short before it was written, so what you are reading beneath is missing '
          + 'it. Ask the agent to save that content again. ' + firstNote(cur.lastSaveNotes),
      });
    } else if (kind === 'clipped') {
      // Deliberately NOT the 'loud' tone `trimmed` gets, and deliberately
      // avoids "missing" / "budget" / "save again" — each was part of the
      // false alarm this verdict replaces. See the real case recorded on
      // `classifySaveNotes`: a 244-char headline clipped to 200 chars, body
      // untouched, badged and worded as if content had been lost.
      detail.push({
        key: 'wrote',
        value: 'the handoff in full',
        sub: 'What got shortened is a label attached to the save — most often its one-line summary '
          + '— not the handoff’s content. That label is the only thing a future session sees before '
          + 'deciding whether to open this state. ' + firstNote(cur.lastSaveNotes),
      });
    } else if (kind === 'replaced') {
      lines.push({
        text: 'That save deliberately replaced a larger handoff. Nothing the agent sent was lost, '
          + 'but the longer document it overwrote is not recoverable. ' + firstNote(cur.lastSaveNotes),
      });
    }

    if (eff.source === 'filesystem') {
      detail.push({
        key: 'clock',
        value: 'the file’s own',
        sub: 'No journal entry carried a save time for this handoff. On a computer that syncs, a '
          + 'file’s own timestamp is when it ARRIVED here, not when it was written.',
      });
    } else {
      // NO `clock: the agent's own` LINE, and the omission is deliberate.
      // Adding one would make `detail` non-empty on EVERY save, which would
      // give the healthy reading a chevron that opens on one uninteresting
      // line — and v3.64.2 chose the flat row for exactly that reason ("an
      // empty chevron invites a click that does nothing"). The good clock is
      // the default the ⓘ above already describes; only the fallback is news.
      // BOTH CLOCKS, when they genuinely disagree. Under two minutes they are
      // the same event to a human — a save's own write takes milliseconds — so
      // a gap larger than that means the file changed on this disk well after
      // the agent wrote it, which is what a pull looks like.
      const arrived = effectiveSave({ savedAt: cur.arrivedAt || cur.savedAt || cur.lastWriteAt });
      if (arrived.seconds !== null && eff.seconds !== null && eff.seconds - arrived.seconds > 120) {
        detail.push({
          key: 'arrived here',
          value: formatAge(arrived.seconds) || 'recently',
          markHtml: '<span class="fresh-dot fresh-' + freshnessTier(arrived.seconds)
            + '" aria-hidden="true"></span>',
          sub: 'The reading above is the agent’s own clock, not the file’s.',
        });
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
    const who = (s.harnesses || []).slice(0, 4).join(' and ');
    lines.push({
      tone: 'danger',
      // THE SCOPE NAME RIDES IN `strongText`, WHICH THE COMPONENT ESCAPES.
      // It came off disk and it used to be interpolated into a `<b><span>`
      // by hand here; the monitor escapes both fields and emphasises this
      // one, so the emphasis survives and the hand-built markup does not.
      strongText: 'Give each tool its own handoff.',
      text: 'Two tools are writing ' + s.scope + '. '
        + (who ? who + ' have ' : 'They have ')
        + 'both saved into the same handoff file, and a save overwrites — so each one has replaced '
        + 'the other’s. The journal below keeps both trails.',
    });
  }

  // ── NEWER STATE SOMEWHERE ELSE IN THIS PROJECT ──────────────────────────
  const newest = newestPair(scopes);
  if (newest && cur) {
    const here = effectiveSave(cur).seconds;
    const there = effectiveSave(newest).seconds;
    const samePair = newest.scope === shownScope && newest.machine === shownMachine;
    if (!samePair && there !== null && (here === null || there < here - 60)) {
      lines.push({
        text: 'Newer state in this project: ' + newest.scope
          + (newest.machine && newest.machine !== shownMachine ? ' on ' + newest.machine : '')
          + ' — ' + (formatAge(there) || 'unknown age') + '.',
      });
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
    detail.push({
      key: 'written on',
      value: d.machine || 'another machine',
      sub: 'Synced here — local paths and processes may differ from what the handoff describes.',
    });
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
    lines.push({
      strongText: 'Pull before you continue, or that work will be waiting there.',
      text: elsewhere.machine + ' saved after this computer — ' + elsewhere.scope + ', '
        + (formatAge(effectiveSave(elsewhere).seconds) || 'unknown age') + '.',
    });
  }

  // ── THE STANDING-BRIEF LINE IS DELETED (v3.62.0) ────────────────────────
  //
  // It read "Standing brief — updated 23 hr ago" / "— not written yet", and
  // the brief fold's own summary one step down says exactly that, from the
  // same two fields. A figure in a sentence that the card below already shows
  // is the de-duplication views/domains.js performs on the domain header: no
  // figure in the sentence that the cards do not already show. Deleted rather
  // than moved, because there was nowhere to move it that did not already
  // carry it.
  //
  // `brief` is still read above for nothing else, so it goes with the line.

  if (!lines.length && !detail.length) return '';

  // ── THE BODY IS A MONITOR (v3.65.0, M1) ──────────────────────────────
  //
  // It was four hand-built sentences in `.mem-save-line` divs — one about
  // which clock the figure came from, one about when the file arrived, one
  // about which machine wrote it, one about what "summary shortened" means.
  // The maintainer, on this exact card and two like it elsewhere in the app:
  // *"it's really hard to understand that this is like a monitor into the
  // specific data and changing state ... we are looking for a unified design
  // AND a distinguished design."* So the explanations become an INSTRUMENT:
  // one fact per line, key left, reading right, the prose demoted to the
  // qualifying clause under the reading it qualifies.
  //
  // WHAT IS A LINE AND WHAT IS A `loud` ENTRY is v3.16.1's split, unmoved: a
  // line is something you went and read, a loud entry is a warning, a cost or
  // an outcome — and a loud entry may NEVER sit behind a chevron. So the
  // monitor in the BODY carries lines only, and the warnings are a second
  // monitor rendered OUTSIDE the fold, below the row, where they are today.
  // Two blocks, one component, and the split is structural rather than a
  // convention: `renderMonitor` builds the two from different arrays and has
  // no field that can move one into the other.
  // ── ONE INSTRUMENT, UNFOLDED, AND NOTHING WHEN THERE IS NOTHING TO SAY ─
  //
  // WHAT IS LEFT after the "Last saved" row is deleted is the part that was
  // never a duplicate: the DISCLOSURES. `detail` holds the qualifications the
  // store honestly computed and this view would otherwise drop — which clock
  // the figure came from, that the file arrived here long after it was
  // written, that a clipped save wrote the handoff in full and shortened only
  // a label — and `lines` holds the warnings: a trimmed handoff, a replaced
  // one, two harnesses overwriting one file, a newer save on another machine.
  //
  // They are ONE monitor now rather than a fold body plus a block beside it,
  // and it is NOT behind a chevron. v3.16.1 covers `lines`; `detail` joins
  // them outside the chevron because the row that used to open is gone, and a
  // disclosure whose only door has been removed is a dropped field — the
  // dominant defect class the memory layer records against itself.
  //
  // AND IT RENDERS NOTHING ON AN ORDINARY PROJECT. A save on the agent's own
  // clock, complete, with one harness, produces no line and no warning, so
  // step ② opens on its four rows with nothing above them. That is the
  // acceptance picture, and it is reached by having nothing to say rather than
  // by hiding something.
  if (!detail.length && !lines.length) return '';
  const instrument = renderMonitor({
    label: 'About the last save', lines: detail, loud: lines,
  });
  if (!instrument) return '';
  // NO `.mem-section`. This is the first thing inside step ②'s body, not a
  // top-level sibling, so the page's 24px block rhythm must not apply to it —
  // `.mem-status-stack` in memory.css owns the spacing inside a block.
  return '<section class="mem-save" aria-label="About the last save">' + instrument + '</section>';
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
// `saveLine` IS GONE (v3.65.0). It built one of three hand-styled sentence
// rows — `.mem-save-line`, `-loud`, `-brief` — and every one of its callers
// now hands `renderMonitor` a LINE or a `loud` entry instead. The escaping
// went with it: it took a trailing `html = false` flag and four of its six
// call sites passed `true`, so four sentences interpolated a scope name, a
// machine id and a store note into hand-written `<b>` and `<span>` markup.
// The component escapes every field and emphasises exactly one named one.

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
          'an agent saves a handoff at the end of a session.')) +
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
        '<span class="mono">my-curator</span> to save a handoff for ' +
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
 * `state.projectRead.scopes` is the fetched response, read by `newestPair`, by
 * `newerOnAnotherMachine` and by `workStreamCounts`, each of which asks its own
 * question of it. Sorting in place would answer all of them with this one.
 * This returns a new array and the response is left exactly as it arrived.
 *
 * SINCE v3.56.1 THIS IS ALSO THE DEFAULT-OPEN PICK. `selectProject` and
 * `reloadActive`'s fallback used to take `scopes[0]` — the response's own mtime
 * order, chosen to match what the route resolves `scope=latest` to. On a synced
 * or copied store those are two different pairs, and the view was opening one
 * while painting the other as first; the head of this order is now what opens,
 * and the route is untouched.
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
/**
 * HOW MANY ROWS THIS PAINT SHOWS, given the window and which pair is open.
 *
 * ── THE OPEN PAIR IS NEVER HIDDEN, AND THE WINDOW IS STRETCHED TO REACH IT
 *    RATHER THAN THE ROW HOISTED TO THE TOP ──────────────────────────────
 * Both were on the table. Hoisting is rejected: the header of this table says
 * "newest first", and v3.55.0's third defect was that same table claiming an
 * order it did not render — a highlighted row sitting above one three minutes
 * younger is the identical lie in a smaller font. Stretching keeps every row in
 * one order and costs at most a few extra rows on the one project where the
 * user has deliberately opened an old work-stream.
 *
 * Pure, and takes the ordered list, so the window arithmetic is drivable
 * without a DOM.
 */
function wsShownCount(ordered, open, windowSize) {
  const total = ordered.length;
  const want = Number.isFinite(windowSize) ? Math.max(1, Math.floor(windowSize)) : total;
  let n = Math.min(total, want);
  if (open && open.scope) {
    const openMachine = open.machine || null;
    const i = ordered.findIndex((s) => s && s.scope === open.scope
      && ((s.machine || null) === openMachine));
    if (i >= n) n = i + 1;
  }
  return n;
}

/**
 * "Show N more" — the list's own last row, and NOTHING when nothing is left.
 *
 * Emitted by renderWorkStreams OUTSIDE `.mem-ws-wrap`: that element scrolls
 * (`overflow-x: auto`), and a control for extending a list must not be able to
 * end up inside the box it extends. Same reason views/domains.js keeps its
 * footer outside `.dm-browse-list`, where the builder measured the row landing
 * ~130 rows below the fold.
 */
function wsMoreHtml(shown, total) {
  if (total <= shown) return '';
  const rest = total - shown;
  const step = rest <= WS_STEP_ALL_MAX ? rest : WS_STEP;
  return (
    '<button type="button" class="cur-group-row mem-ws-more" id="mem-ws-more">' +
      '<span class="mem-ws-more-label">Show ' + step.toLocaleString() + ' more</span>' +
    '</button>'
  );
}

function renderWorkStreams(scopes, open, windowSize = WS_WINDOW) {
  const ordered = workStreamOrder(scopes);
  if (!ordered.length) return '';
  const shown = wsShownCount(ordered, open, windowSize);
  const rows = ordered.slice(0, shown);
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

  const body = rows.map((s) => wsRowHtml(s, openScope, openMachine, mineMachine)).join('');

  return (
    '<div class="mem-ws-wrap">' +
      '<table class="mem-ws-table">' +
        '<thead><tr>' +
          '<th scope="col">Handoff</th>' +
          '<th scope="col">Working on</th>' +
          '<th scope="col">Last saved</th>' +
          '<th scope="col">Machine</th>' +
          '<th scope="col">Harness</th>' +
        '</tr></thead>' +
        '<tbody id="mem-ws-body">' + body + '</tbody>' +
      '</table>' +
    '</div>' +
    wsMoreHtml(shown, ordered.length)
  );
}

/**
 * ONE ROW. Extracted from renderWorkStreams for the same reason domains.js
 * extracted `browseRowHtml`: the "Show N more" path APPENDS rows into the live
 * <tbody> rather than repainting the table, so two call sites emit this markup
 * and two hand-maintained copies is how the appended rows quietly stop matching
 * the painted ones.
 */
function wsRowHtml(s, openScope, openMachine, mineMachine) {
  {
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
          // THE ROW IS THE CONTROL, AND IT SAYS SO. Its visible text is the
          // work-stream slug, which names the row but not the ACTION — and the
          // action is no longer "select this scope", it is "open this handoff".
          // An `aria-label` states it for anyone who reaches the row without the
          // block's lede in view, and it names the machine too, because two rows
          // can carry the same slug and a screen reader hears only this button.
          // Deliberately NOT a visible chevron: the first cell already carries
          // the freshness dot and the slug in a column v3.53.1 measured as tight
          // at 140px, and a third mark there costs more than it says.
          '<button type="button" class="mem-ws-open"' +
            ' aria-label="' + escapeHtml('Open the handoff for ' + s.scope
              + (s.machine ? ' on ' + s.machine : '')) + '"' +
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
  }
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
function workStreamCounts(read, listed, painted) {
  if (!read) return '';
  const pairs = typeof read.savedCopies === 'number' ? read.savedCopies : listed;
  const streams = typeof read.distinctScopeCount === 'number' ? read.distinctScopeCount : null;
  const parts = [];
  if (streams !== null) parts.push(streams + ' handoff' + (streams === 1 ? '' : 's'));
  parts.push(pairs + ' saved cop' + (pairs === 1 ? 'y' : 'ies'));
  const truncated = read.scopesTruncated
    ? ' · showing the ' + listed + ' most recently saved'
    : '';
  // ── "SHOWING N OF M", AND ONLY WHILE IT IS TRUE ────────────────────────
  // A THIRD number, because the window is a third fact: `listed` is what the
  // store handed over and `painted` is what the table is showing of it. It is
  // withheld when they are equal — a list that fits says nothing about its own
  // length, which is what every small project sees — and it is deliberately
  // separate from the `scopesTruncated` clause above, which is about the
  // STORE's cap rather than about this table's window. Two caps, two sentences;
  // collapsing them would report one as the other.
  const windowed = (typeof painted === 'number' && painted < listed)
    ? ' · showing ' + painted + ' of ' + listed
    : '';
  return '<div class="mem-ws-count" id="mem-ws-count">' +
    escapeHtml(parts.join(' · ') + truncated + windowed) + '</div>';
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
 * THE HANDOFF OPENS IN THE READER, AND IS NO LONGER PRINTED ON THE PAGE.
 *
 * ── WHAT THIS REPLACES, AND WHY ──────────────────────────────────────────
 * v3.55.0 gave this screen a work-streams TABLE and left the handoff below it
 * as block ③ — a lead fold carrying the whole document. The maintainer's
 * verdict on that page in production: a dashboard should say where things
 * stand, and reading fifteen hundred words of one work-stream is a different
 * act that should not be happening underneath the summary of all of them. The
 * wiki answered the same question years ago — a list of pages, and a press
 * opens ONE in the right-hand reader — and this screen now uses that answer.
 *
 * So there is no block ③. The table is the index, a row press is the open, and
 * the shell's reader overlay (app.js `openReader`) is where the document goes:
 * a slide-in panel over the main column with an `esc` chip, a ✕, the file's
 * path in mono along the top and the rendered markdown below. The rail and the
 * sidebar stay live behind it, which is exactly right for a document you are
 * reading ABOUT a project you are still looking at.
 *
 * ── NO NEW ROUTE, AND NO SECOND FETCH ────────────────────────────────────
 * `GET /api/memory/:domain/:project?scope=&machine=` is the read this view
 * already performs when a row is pressed, and `state.detail.current` is the
 * result. views/domains.js opens a memory row in the same reader through the
 * same route (v3.50.0) — this is the second consumer of that decision, not a
 * new one. What this function does is COMPOSE the payload; the fetch is
 * `loadScope`'s, unchanged.
 *
 * ── WHAT TRAVELS WITH THE DOCUMENT ───────────────────────────────────────
 * Everything block ③'s summary carried, because each of those facts qualifies
 * the document rather than decorating it:
 *   · the SAVED reading — the age words, and harness · model beside them,
 *     through the same `effectiveSave` + `renderReadout` the Status block uses,
 *     so the two can never name different times for one save;
 *   · the `incomplete` / `summary shortened` badges off `lastSaveKind`, on the
 *     reading rather than under it (v3.55.0's own rule: a completeness caveat
 *     below the figure is one the glance never reaches);
 *   · the truncation and read-sanitisation notes, in full, because they are
 *     warnings and warnings never fold (v3.16.1);
 *   · the scope and the machine — in the header path line AND as chips, since
 *     "which work-stream, on which computer" is the whole reason two rows can
 *     carry the same name.
 *
 * ── `data-mem-age-at` RIDES ALONG ────────────────────────────────────────
 * The age in the reader is the same instrument as the age on the page, so it
 * ticks the same way: tickAges walks the whole document once a second and
 * writes into `.tx-readout-value` inside any `[data-mem-age-at]`, and the
 * overlay is in that document. The claim "· updates live" is still made only
 * off `state.ageTickerArmed`, never off the attribute's presence.
 *
 * ── UNTRUSTED TEXT ───────────────────────────────────────────────────────
 * The body goes through renderMarkdown (shared/markdown.js), which escapes the
 * whole string before emitting any markup. State text arrives over sync from
 * other machines and, inside a shared mirror, from other people; the reader
 * inserts `bodyHtml` as-is and says so, so the escaping duty is here.
 *
 * Returns the openReader payload, or null when there is nothing to open.
 */
function handoffReaderContent() {
  const d = state.detail;
  if (!d) return null;
  const scope = d.scope || state.scope || '';
  const machine = d.machine || state.machine || '';
  // The file's real location, which is what the reader's path chip is for and
  // what a person needs in order to find it in Obsidian or in their synced
  // repository. Built from the same three names the request was addressed by.
  const slug = 'state/' + (state.activeProject || '') + '/' + scope
    + (machine ? '/' + machine : '') + '/current.md';

  const present = !!(d.current && d.current.present);
  const cur = present ? d.current : null;
  const split = splitHandoffPreamble((cur && cur.text) || '');
  const headline = split.headline;

  // ── THE SAVED READING ──────────────────────────────────────────────────
  const savedWhen = cur ? effectiveSave(cur) : { seconds: null, at: null, source: null };
  const savedAge = formatAge(savedWhen.seconds);
  // ABSENT IS NOT ZERO. With no savedAt and no journal entry there is no
  // reading, so nothing renders — never "unknown", never a dash.
  const savedValue = savedAge || (cur && cur.savedAt) || null;
  // Harness and model come from the journal's newest entry — STRUCTURED
  // fields, never scraped out of the document's prose provenance line.
  const j0 = d.journal && d.journal.entries && d.journal.entries.length ? d.journal.entries[0] : null;
  const who = j0 ? [j0.harness, j0.model].filter(Boolean).join(' · ') : '';
  const clock = savedWhen.source === 'filesystem' ? 'file time' : null;
  const live = savedAge && state.ageTickerArmed ? '· updates live' : '';
  const prov = [who, clock, live].filter(Boolean).join(' ');
  const readout = savedValue
    ? renderReadout({ label: 'Saved', value: savedValue, provenance: prov || undefined })
    : (who ? renderReadout({ label: 'Written by', value: who }) : '');
  const kind = (cur && cur.lastSaveKind) || null;
  // Same two badges, same two classes, as the Status block: `clipped` is the
  // QUIET badge (a label was shortened, nothing was lost) and `trimmed` the
  // attention one (content did not survive the save). Sharing one class is the
  // exact false alarm the two verdicts exist to keep apart.
  const badges =
    (kind === 'trimmed' ? '<span class="mem-badge mem-badge-attn">incomplete</span>'
      : kind === 'clipped' ? '<span class="mem-badge mem-badge-quiet">summary shortened</span>' : '');
  const ageAttr = savedAge && savedWhen.at
    ? ' data-mem-age-at="' + escapeHtml(savedWhen.at) + '"' : '';
  // THE EXACT STAMP, AS TEXT RATHER THAN AS A TOOLTIP. The fold this replaces
  // carried it on `title=`, which v3.20.0 counted as one of eleven facts in this
  // app reachable only by hover. The work-stream table already had to promote
  // the same fact into a `.visually-hidden` span; this is the third and it is
  // promoted the same way, so memory.js's `title=` ratchet SHRINKS from three
  // allowances to one rather than being spent again.
  const exact = savedAge && savedWhen.at
    ? '<span class="visually-hidden"> (' + escapeHtml(savedWhen.at) +
      (savedWhen.source === 'filesystem' ? ', file time' : '') +
      (cur && cur.arrivedAt ? '; arrived here ' + escapeHtml(cur.arrivedAt) : '') + ')</span>'
    : '';
  // NO READING IS STILL A READING TO REPORT, and the rule survives the move.
  // With neither an age nor an author there is no instrument — a readout states
  // a READING, and inventing "unknown" as its value would be the fact-and-
  // absence collapse this view exists to refuse — but the document must still
  // say that its time is not known, in words. The fold said it beside a dashed
  // pip; there is no pip in the reader, so the words stand alone.
  const unknown = (!readout && present)
    ? '<span class="mem-reader-unknown">Saved — time unknown</span>' : '';
  // ONLY WHEN THERE IS A DOCUMENT. A save reading is a statement about the
  // handoff in front of you; with no handoff to read, a journal line naming a
  // harness would print "Written by claude-code" over a panel that says nothing
  // was ever written here — a reading invented for a document that is not
  // there, which is the same collapse the `unknown` branch above refuses.
  const meta = (present && (readout || badges || unknown))
    ? '<div class="mem-reader-meta"' + ageAttr + '>' + readout + exact + badges + unknown + '</div>'
    : '';

  const notes = [];
  if (cur && cur.truncated) {
    notes.push('This handoff was longer than the state budget — the tail is not shown. ' +
      'The file on disk is complete up to that budget; nothing below it was ever written.');
  }
  if (cur && cur.sanitisedOnRead) {
    notes.push('Protocol-shaped text in this file was neutralised on read (it can arrive over sync from another ' +
      'machine, or from another person inside a shared mirror). The words are unchanged; only their markup is.');
  }
  const noteHtml = notes.map((n) =>
    '<div class="mem-note">' + icon('alertTriangle', 13) + '<span>' + escapeHtml(n) + '</span></div>').join('');

  // AN ABSENT HANDOFF IS SAID, NOT RENDERED AS AN EMPTY PAGE. A pair can be
  // listed and its `current.md` still be unreadable — and a blank panel would
  // read as "this handoff is empty", which is a different claim.
  const bodyHtml = present
    ? meta + noteHtml + '<div class="mem-reader-doc">' + renderMarkdown(split.body) + '</div>'
    : meta + noteHtml + renderDescription(d.message
      || 'Nothing has been saved under this handoff on this machine yet.');

  return {
    slug,
    // The handoff's own first line is the best title it has; the scope is the
    // fallback, because a document titled after its file is still addressable.
    title: headline || (scope ? 'Handoff — ' + scope : 'Handoff'),
    type: 'memory',
    typeLabel: 'handoff',
    tags: [
      scope ? 'handoff: ' + scope : null,
      machine ? 'machine: ' + machine : null,
      d.machineIsThisMachine === true ? 'this machine' : null,
      d.machineIsThisMachine === false ? 'synced from another machine' : null,
      cur && cur.truncated ? 'truncated at the read cap' : null,
      cur && cur.sanitisedOnRead ? 'sanitised on read' : null,
    ].filter(Boolean),
    readonly: !!d.readonly,
    bodyHtml,
    backlinks: [],
    // ESCAPE AND THE ✕ PUT FOCUS BACK ON THE ROW. `mem-ws-active` is the id the
    // OPEN row carries — the row that was just pressed, by the time this closes
    // — and it is an id rather than a node because every render on this screen
    // replaces the pane by innerHTML while the reader is up. See app.js's
    // `dismissReader` for why a navigation deliberately does not do this.
    returnFocusTo: 'mem-ws-active',
    // NO `domain`, DELIBERATELY. That field switches on the reader's RAW-source
    // bar, which asks GET /api/wiki/:domain/source about a wiki page. A handoff
    // is not a wiki page and has no ingested source, so supplying it would buy
    // a request that can only ever answer "no". views/domains.js omits it for
    // the same reason on the same kind of row.
  };
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
      'Shorten it, or move the detail into a page in your domain and point at it from here.</span></div>';

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
      // ── ONE SENTENCE, AND IT IS THE ONE ABOUT THE WRITE (v3.58.0) ────────
      // This was two. The first — "The standing brief is yours to write —
      // agents read it, they do not own it." — is a DEFINITION of the tier,
      // and the block's ⓘ opens with the same claim in more detail, so it was
      // the same words twice on one screen.
      //
      // The second STAYS, and the audit that asked for both to go is refused
      // here with a reason. "Saving replaces the whole document" is not a
      // definition: it is a condition on the button six pixels above it, and
      // the consequence of missing it is a user sending an addition and
      // deleting their own brief. Moving it into the ⓘ would put it behind a
      // click, which is v3.16.1's rule about exactly this — and this file's
      // own header states that a warning never folds. A guard already pinned
      // it (test-next-memory-view.js §16g asserts the editor "says REPLACE
      // rather than implying an append"); that guard is right.
      renderDescription('Saving replaces the whole document — send the complete brief, not an addition.') +
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
  // ── THE OWNER'S ROUTING TABLE (v3.62.0) ────────────────────────────────
  // The store's own `briefTemplate` gained this section in the same release,
  // and the two templates are read by the same agents: the foundations flagged
  // "read first" arrive with every session, and the rest are opened BY NAME on
  // the brief's instruction. A template that never asks the question leaves an
  // agent to guess which document a task needs.
  //
  // THE HEADING IS THE STORE'S, BYTE FOR BYTE. The prompts under it are
  // shorter here because this template is what the pencil puts in an editor
  // rather than what a create writes to disk.
  '## Read before you…',
  '',
  'Which document to open for which kind of work.',
  '',
  '- ',
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
 * BLOCK ③'s BODY — the standing brief, folded shut, with a pencil on its head.
 *
 * ── IT IS A FOLD AGAIN, AND THAT IS NOT A REVERSAL OF v3.55.0 ────────────
 * v3.55.0 took the brief OUT of a <details> for one reason and one only: its
 * `<summary>` had to carry the edit control, and an interactive control inside
 * a summary toggles its own section when clicked (the v3.0.1-beta.18 hazard).
 * That argument is about where the PENCIL lives, not about whether the
 * document is collapsible — and the pencil is not in the summary here. It is a
 * SIBLING of the <details>, anchored over the summary row by memory.css, so
 * there is again no propagation path to suppress and no stopPropagation for a
 * later edit to drop.
 *
 * What brought the fold back is a measurement. On this repo's own `curator`
 * project, at a 1370px window (a 1,015px main column), the page was 3,241px
 * and this block was 2,100px of it — 65% of everything you scroll past, spent
 * on the section that changes least. The maintainer's words were that the
 * brief "is usually a page or more and takes a lot of scrolling".
 *
 * ── CLOSED BY DEFAULT, REMEMBERED AFTERWARDS ────────────────────────────
 * `open` is emitted from `state.openFolds.brief` and from NOTHING else — never
 * from "there is a brief", never from "the editor is open", never from "this
 * is the only content on the page". That last one is the v3.54.0 defect by
 * name: a transient loading render made the brief the only section, the code
 * opened it for that reason, Chrome queued a `toggle` for the <details> it had
 * just parsed `open`, and the transient was recorded as a user decision.
 * Deriving `open` from one field that only a real toggle (or the Edit button,
 * which is a real decision to read it) ever writes makes that inexpressible.
 *
 * ── THE SUMMARY HAS TO BE ENOUGH TO DECIDE WITH ─────────────────────────
 * "The brief · updated 23 hr ago · 1,309 words". Age answers "is this the one
 * I wrote last week"; the word count answers "is this two lines or four
 * screens", which is the question a collapsed section creates. It does NOT
 * repeat the block's own title — the journal's summary says "Recent saves"
 * under a head reading "Session journal" for the same reason, and a section
 * that names itself twice is the v3.50.0 finding on Wiki health.
 *
 * The word count is `briefStats` over the WHOLE stored document, which is the
 * same figure the editor's own counter shows, so the closed summary and the
 * open editor cannot quote two different sizes for one file.
 *
 * ── THE AGE, AND DELIBERATELY NO PIP ────────────────────────────────────
 * The brief changes on the order of weeks; an old brief is not a stale one,
 * and marking it the way a handoff is marked would state something false. It
 * carries `data-mem-age-at` + `.mem-age-words` so `tickAges` keeps it moving
 * without a render, exactly as the table's age cells do.
 *
 * ── THE PENCIL IS ICON-ONLY ─────────────────────────────────────────────
 * It was a glyph plus the word "Edit", and the maintainer's report is that it
 * "reads as unattached" — floating at the far right of a toolbar row with a
 * short age phrase at the other end and 800px of nothing between them. The row
 * is gone; the control sits on the fold's own head, at the block's right edge,
 * inside the card it edits. A word is no longer paying for itself there: the
 * button is next to the thing it acts on and the accessible name carries the
 * meaning.
 *
 * `aria-label` is the accessible name and there is NO visually-hidden twin of
 * it. Both would occupy the same channel — an `aria-label` overrides element
 * text outright — so a hidden span would be markup that nothing can ever
 * announce. There is no `title=` either: memory.js's tooltip budget is 1 and
 * may not grow (scripts/test-next-header-adoption.js), and a tooltip is
 * unreachable by keyboard and by touch anyway.
 *
 * THE GLYPH IS NOT `icon('pencil')`: app.js's ICON_BODY has no such entry and
 * `icon()` renders a loud placeholder for a name it does not know rather than
 * guessing (v3.9.0), so inventing one would ship a broken glyph. It follows
 * the kit's own geometry exactly — 24-unit viewBox, `fill: none`,
 * `currentColor` stroke, width 1.7, round caps — so it reads as a member of
 * the same set.
 *
 * ── IT IS WITHHELD WHILE THE EDITOR IS UP ───────────────────────────────
 * Not tidiness: the click handler builds a FRESH `state.briefEdit` from the
 * last read, so pressing it during an edit silently discarded an unsaved
 * draft. The editor's own Cancel is the way out, and it asks (v3.55.0's
 * `briefDismissDecision`). A read-only mirror gets no pencil at all — the
 * backend answers 403, and a control whose only outcome is a refusal is worse
 * than no control.
 */
function renderBrief(read) {
  const readonly = !!(state.detail && state.detail.readonly) || !!(read && read.readonly);
  const has = !!(read && read.brief && read.brief.present);
  const b = has ? read.brief : null;
  const editing = !!state.briefEdit;
  const age = b && b.updatedAt
    ? formatAge(Math.max(0, Math.round((Date.now() - Date.parse(b.updatedAt)) / 1000)))
    : null;

  const pencil = (readonly || editing) ? '' :
    '<button type="button" class="btn btn-ghost btn-xs mem-brief-edit" id="mem-brief-edit"' +
      ' aria-label="' + (has ? 'Edit standing brief' : 'Write a standing brief') + '">' +
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3z"/><path d="M14.5 6.5l3 3"/></svg>' +
    '</button>';

  // NO BRIEF, NO FOLD. There is one sentence to show and it is the sentence
  // that makes the case for writing one — hiding the motivation behind a
  // chevron while leaving the control beside it is the "the missing thing has
  // to be missing where you looked for it" rule (v3.17.1) read backwards. It
  // keeps the SAME card chrome so the pencil is anchored identically in both
  // states, and the editor branch below is reached from here too.
  if (!has && !editing) {
    return (
      '<div class="mem-brief-row">' +
        '<div class="mem-fold mem-fold-flat"><div class="mem-fold-body">' +
          renderDescription('No standing brief for this project. It is the part that rarely changes — the goal, '
            + 'the firm decisions, the working model — and every agent read returns it, so it is worth writing once.') +
        '</div></div>' +
        pencil +
      '</div>'
    );
  }

  const words = has ? briefStats(b.text || '').words : 0;
  const summary =
    '<summary class="mem-fold-summary" id="mem-fold-brief">' + icon('chevronRight', 14) +
      '<span>The brief</span>' +
      '<span class="mem-fold-meta"' +
        (has && b.updatedAt ? ' data-mem-age-at="' + escapeHtml(b.updatedAt) + '"' : '') + '>' +
        (has
          ? (age
            ? 'updated <span class="mem-age-words">' + escapeHtml(age) + '</span>'
            : 'updated at an unknown time')
            + ' · ' + escapeHtml(Number(words).toLocaleString('en-US')) +
            ' word' + (words === 1 ? '' : 's')
          : 'not written yet') +
      '</span>' +
    '</summary>';

  const body = editing
    ? renderBriefEditor(read, readonly)
    : ((b && b.truncated ? '<div class="mem-note">' + icon('alertTriangle', 13) +
        '<span>Longer than the brief budget — the tail is not shown.</span></div>' : '') +
      // Same preamble strip as the handoff: the block head already says
      // "Standing brief" and the summary says when it was updated, so the
      // document's own title and `_Updated: …_` line are duplicate chrome here.
      '<div class="mem-doc">' + renderMarkdown(splitHandoffPreamble((b && b.text) || '').body) + '</div>');

  const open = (state.openFolds && state.openFolds.brief) ? ' open' : '';
  return (
    '<div class="mem-brief-row">' +
      '<details class="mem-fold" data-mem-fold="brief"' + open + '>' +
        summary +
        '<div class="mem-fold-body">' + body + '</div>' +
      '</details>' +
      pencil +
    '</div>'
  );
}

// ═════════════════════════════════════════════════════════════════════════
// TIER 0 — FOUNDATIONS, THE CANONICAL DOCUMENTS THAT TRAVEL
// ═════════════════════════════════════════════════════════════════════════
//
// There are three kinds of context a project carries, and until now this
// screen could show two of them. VOLATILE STATE is the brief, the handoff and
// the journal — tiers 1 to 3, above. COMPOUNDED KNOWLEDGE is the wiki, one
// view over. CANONICAL DOCUMENTS — the architecture note, the decisions log,
// the conventions, the roadmap — lived only inside a code repository, which
// means they were invisible to any agent without a checkout, and `raw/` is
// gitignored so an ingested copy never travelled either.
//
// Tier 0 stores them VERBATIM beside the state, so they travel with the
// project and an agent reads them in one call. This block is the window onto
// that: what is here, how big, where each one came from, and — for a mirror —
// whether the copy still matches the file it was copied from.
//
// ── TWO OWNERSHIP MODES, AND THE APP WRITES NEITHER ──────────────────────
// A project's documents are all CURATOR-owned or all REPO-owned, never mixed.
//
//   · CURATOR-owned — written by an agent the owner commissioned, through the
//     `save_foundation` MCP tool. Nothing in this view writes one, and there
//     is no route that could: the single-writer property that protects a
//     handoff protects these the same way.
//   · REPO-owned — a MIRROR of a file in a code repository. "Refresh from
//     repo" re-copies the bytes, compares sha256 and stamps the commit. That
//     is a copy, not an authorship, which is the whole argument for the one
//     control on this block that reaches a write route (src/routes/memory.js
//     records it at the route).
//
// ── FRESHNESS IS COMPUTED, NOT REMEMBERED ────────────────────────────────
// `fresh` / `stale` / `unreachable` come off a sha256 comparison the store
// makes at read time against the file at `repo.root`. `unreachable` is a fact
// about THIS computer — the checkout is not here — and it is never smoothed
// into `stale`, which would claim a comparison that was not made. A
// curator-authored document has no upstream and gets no reading at all rather
// than a fabricated one.

/**
 * EVERY FIGURE THIS BLOCK QUOTES, DERIVED ONCE.
 *
 * Three consumers read it — the fold's summary line, the Status block's
 * one-line reading and the Refresh control's own decision — and they must not
 * be able to disagree about how many documents are stale. Pure over the
 * payload, so it is drivable without a DOM.
 *
 * COUNTS ARE OVER WHAT THE STORE LISTED. `totalBytes` is preferred over the
 * sum of the rows because the store takes it before any cap of its own; the
 * sum is the fallback for a server that does not send it, and the two agree
 * on every uncapped read.
 */
function foundationsFacts(read) {
  const f = read && read.foundations && typeof read.foundations === 'object' ? read.foundations : null;
  const docs = f && Array.isArray(f.documents) ? f.documents.filter(Boolean) : [];
  let fresh = 0;
  let stale = 0;
  let unreachable = 0;
  let unrated = 0;
  // HOW MANY ARE STILL PROMPTS RATHER THAN DOCUMENTS (v3.61.0). Counted here
  // rather than taken from the payload's `skeletonCount` when the rows are
  // present, for the reason `bytes` prefers `totalBytes`: the figure and the
  // rows on screen must be one reading, and a server count over a capped row
  // list would report a number the table cannot show. The payload's own count
  // is the fallback for a build that sends no `skeleton` flag per row.
  let skeletons = 0;
  // ── THE READ-FIRST SET (v3.62.0) ──────────────────────────────────────
  // A document flagged `readFirst` is one whose BODY arrives with every
  // session; the rest ride as an index the agent opens by name. So there are
  // two budgets on this block and they are not the same number: the project
  // budget (200 KB) is about what is STORED, and the read-first budget
  // (120 KB) is about what an agent RECEIVES. Conflating them would warn about
  // the wrong set — see `foundationsSummaryMeta`.
  let readFirst = 0;
  let readFirstBytes = 0;
  for (const d of docs) {
    // `=== true` rather than truthiness, for the reason `skeletonOf` states:
    // a build that sends no flag at all reads FALSE rather than
    // undefined-as-maybe, and a fact and its absence stay apart.
    if (d.readFirst === true) {
      readFirst++;
      readFirstBytes += Number.isInteger(d.bytes) ? d.bytes : 0;
    }
    // THE FLAG, THROUGH THE ONE PREDICATE (P1-2). Never the banner's text.
    if (skeletonOf(d)) skeletons++;
    if (d.freshness === 'stale') stale++;
    else if (d.freshness === 'unreachable') unreachable++;
    else if (d.freshness === 'fresh') fresh++;
    // 'n/a', null, or a word this build does not know: NOT counted as fresh.
    // A reading that was never taken is not a passing reading, and rounding it
    // up is how a screen ends up claiming a comparison nobody made.
    else unrated++;
  }
  if (!skeletons && f && Number.isInteger(f.skeletonCount) && f.skeletonCount > 0
      && !docs.some((d) => d && typeof d.skeleton === 'boolean')) {
    skeletons = Math.min(f.skeletonCount, docs.length);
  }
  return {
    present: !!(f && f.present),
    ownership: (f && f.ownership) || null,
    repo: (f && f.repo) || null,
    docs,
    count: docs.length,
    bytes: f && Number.isInteger(f.totalBytes) && f.totalBytes > 0
      ? f.totalBytes
      : docs.reduce((a, d) => a + (Number.isInteger(d.bytes) ? d.bytes : 0), 0),
    fresh,
    stale,
    unreachable,
    unrated,
    skeletons,
    // ── FIVE READINGS, THE SERVER'S WHERE IT SENT THEM ─────────────────
    // The store computes all five and the route forwards them; they are
    // preferred over the row-derived figures for the reason `bytes` prefers
    // `totalBytes` — the store takes them before any cap of its own, and a
    // sum over a capped row list would report a number the table cannot show.
    // The derivation is the fallback for a build that sends none, which is
    // also every offline fixture written before this release.
    readFirstCount: f && Number.isInteger(f.readFirstCount) ? f.readFirstCount : readFirst,
    onRequestCount: f && Number.isInteger(f.onRequestCount)
      ? f.onRequestCount : Math.max(0, docs.length - readFirst),
    readFirstBytes: f && Number.isInteger(f.readFirstBytes) ? f.readFirstBytes : readFirstBytes,
    readFirstBudgetBytes: f && Number.isInteger(f.readFirstBudgetBytes) && f.readFirstBudgetBytes > 0
      ? f.readFirstBudgetBytes : READ_FIRST_BUDGET_BYTES,
    readFirstBudgetExceeded: f && typeof f.readFirstBudgetExceeded === 'boolean'
      ? f.readFirstBudgetExceeded
      : (readFirst > 0 && readFirstBytes > READ_FIRST_BUDGET_BYTES),
    // The project budget is a DISCLOSURE, never a wall (D6): the store accepts
    // a save that crosses it and says so, and a UI that refused what the store
    // accepts would be the only thing standing between the owner and their
    // own document. `budgetBytes` is the server's figure where it sent one.
    budgetBytes: f && Number.isInteger(f.budgetBytes) && f.budgetBytes > 0
      ? f.budgetBytes : FOUNDATIONS_BUDGET_BYTES,
    manifestError: (f && f.manifestError) || null,
    orphanFiles: f && Array.isArray(f.orphanFiles) ? f.orphanFiles : [],
  };
}

/**
 * WHO OWNS THESE DOCUMENTS — one clause, and it is UNCONDITIONAL (P1-11).
 *
 * ── WHY THIS IS NOT THE LAST CLAUSE OF `foundationsWord` ────────────────
 * It used to be: `Curator-authored` sat inside the worst-first ladder below,
 * which means the ownership fact DISAPPEARED exactly when anything else
 * applied. On a curator-owned project with two skeletons the line read
 * "2 skeletons to fill" and never said who owned them — and ownership is the
 * one fact that decides whether *Refresh* or *Edit* is the control to reach
 * for. Ownership is not a state; splitting the slot costs four characters and
 * makes the answer always present.
 *
 * `null` when there is no manifest: an absent mode is not a third mode, and
 * the no-manifest summary (`foundationsSummaryMeta`) says so in its own words.
 */
function foundationsOwnershipWord(facts) {
  if (facts.ownership === 'repo') return 'mirrored';
  if (facts.ownership === 'curator') return 'kept here';
  return null;
}

/**
 * THE WHOLE SUMMARY LINE — four clauses, in one place (P1-11, P2-3).
 *
 *   4 documents · 12 KB · kept here · 2 skeletons to fill
 *   └ count ───┘ └ size ┘ └ ownership ┘ └ state, worst-first ┘
 *
 * ── THREE ANSWERS THAT ARE NOT ONE ANSWER ──────────────────────────────
 * `0 documents` was rendered "none yet" whatever the cause, which collapsed
 * three different situations a person has to act on differently: no mode
 * chosen at all, a mirror with nothing copied, and a project kept here with
 * nothing written. Each gets its own reading, and the ownership clause is what
 * distinguishes the last two.
 *
 * ── THE BUDGET IS A READING ON THE BLOCK, NOT ONLY IN THE EDITOR (P2-3) ─
 * The 200 KB project budget is a DISCLOSURE the store makes on every save, and
 * a disclosure the owner only sees inside an editor they have just closed is a
 * disclosure that expires. When it is exceeded the size clause carries it —
 * one clause, and the only place the condition survives a closed editor.
 */
function foundationsSummaryMeta(facts) {
  if (facts.manifestError) return 'manifest unreadable';
  if (!facts.present) return 'not set up · choose how documents arrive';
  const own = foundationsOwnershipWord(facts);
  if (!facts.count) {
    if (facts.ownership === 'repo') return 'mirrored · no documents copied yet';
    if (facts.ownership === 'curator') return 'kept here · no documents yet';
    return 'not set up · choose how documents arrive';
  }
  // ── WHICH BUDGET THE SIZE CLAUSE IS ABOUT (v3.62.0) ────────────────
  //
  // TWO BUDGETS, AND THEY ARE NOT THE SAME NUMBER. The project budget
  // (200 KB) is about what is STORED. The read-first budget (120 KB) is about
  // what an agent RECEIVES in a session — and once ANY document is flagged,
  // that is the set whose size decides whether something is dropped. Warning
  // about the stored total there would name a figure nobody can act on: a
  // project can hold 400 KB of documents and hand an agent 40 KB, and a
  // project can hold 130 KB and drop half of it.
  //
  // WHEN NOTHING IS FLAGGED the behaviour is v3.61.0's, unchanged: the store
  // sends every body within the session budget, so the applicable set is all
  // documents and the applicable figure is the project budget.
  const flagged = facts.readFirstCount > 0;
  const size = flagged
    ? (facts.readFirstBytes > facts.readFirstBudgetBytes
      ? fndSize(facts.readFirstBytes) + ' read first, of a '
        + fndSize(facts.readFirstBudgetBytes) + ' budget'
      : fndSize(facts.bytes))
    : (facts.bytes > facts.budgetBytes
      ? fndSize(facts.bytes) + ' of a ' + fndSize(facts.budgetBytes) + ' budget'
      : fndSize(facts.bytes));
  return [
    facts.count.toLocaleString('en-US') + ' document' + (facts.count === 1 ? '' : 's'),
    size,
    own,
    // ── "N read first · M on request" ────────────────────────────────
    // Withheld entirely when nothing is flagged: "0 read first · 4 on
    // request" would report the ABSENCE of a decision as a decision, and the
    // absence is the ordinary state of every project that predates the flag.
    flagged
      ? facts.readFirstCount + ' read first · ' + facts.onRequestCount + ' on request'
      : null,
    foundationsWord(facts),
  ].filter(Boolean).join(' · ');
}

/**
 * THE OVER-BUDGET WARNING, NAMING THE SET IT IS ABOUT (v3.62.0, §5(5)).
 *
 * Never folds — it is a cost, and design-system §3 (from v3.16.1) puts costs
 * on the never-fold list. Returns '' when there is nothing to warn about, so
 * the caller concatenates it unconditionally.
 *
 * The consequence is named rather than the condition: a person who reads
 * "over budget" and shrugs is right to, and a person who reads "and the rest
 * is dropped, last in reading order first" un-flags a document. The sentence
 * is shared_with `shared/foundations-init.js`'s `budgetWarning`, which says the
 * same thing about the same limit on the chooser — one wording, two hosts.
 */
function foundationsBudgetWarning(facts) {
  const flagged = facts.readFirstCount > 0;
  if (flagged) {
    if (!facts.readFirstBudgetExceeded) return '';
    return 'The ' + facts.readFirstCount + ' documents flagged “read first” come to '
      + fndSize(facts.readFirstBytes) + ', over the ' + fndSize(facts.readFirstBudgetBytes)
      + ' budget: agents receive ' + fndSize(facts.readFirstBudgetBytes)
      + ' per session and the rest is dropped, last in reading order first.';
  }
  if (facts.bytes <= facts.budgetBytes) return '';
  return 'Over the ' + fndSize(facts.budgetBytes) + ' budget: agents receive '
    + fndSize(READ_FIRST_BUDGET_BYTES)
    + ' per session and the rest is dropped, last in reading order first.';
}

/** Bytes, in the two units this block quotes them in. One derivation. */
function fndSize(bytes) {
  const b = Number.isInteger(bytes) && bytes > 0 ? bytes : 0;
  return b < 1024 ? b + ' bytes' : Math.round(b / 1024).toLocaleString('en-US') + ' KB';
}

/**
 * THE STATE WORD AT THE END OF THE SUMMARY LINE.
 *
 * Ordered worst-first, because the summary is read at a glance and the glance
 * has to land on the thing that needs a decision. A manifest that will not
 * parse outranks everything: every other figure on this block is derived from
 * it, so saying "6 documents · fresh" over an unreadable manifest would be
 * confident nonsense.
 *
 * OWNERSHIP IS NO LONGER IN THIS LADDER (P1-11) — it is its own clause, so
 * `Curator-authored` is gone from here and `written` takes its place: the
 * question this word answers is "does anything need attention", and "these
 * were written rather than copied" is an answer to a different question the
 * clause before it already gives.
 */
function foundationsWord(facts) {
  if (facts.manifestError) return 'manifest unreadable';
  if (!facts.count) return 'none yet';
  if (facts.stale) return facts.stale + ' stale';
  if (facts.unreachable) return 'source unreachable';
  // ── SKELETONS RANK BELOW A BROKEN COMPARISON AND ABOVE "Curator-authored"
  //    (v3.61.0) ───────────────────────────────────────────────────────────
  // A skeleton is not a fault and it is not a document either: it is a set of
  // prompts nobody has answered, which an agent reading this project will be
  // told to treat as questions rather than facts. So it outranks the two words
  // that merely describe where a document came from — "Curator-authored" over
  // four unfilled prompts is confident nonsense of the same shape as "6
  // documents · fresh" over an unreadable manifest — and it ranks BELOW a
  // stale copy or a checkout that is not here, because those are comparisons
  // the store tried to make and could not.
  if (facts.skeletons) {
    return facts.skeletons + ' skeleton' + (facts.skeletons === 1 ? '' : 's') + ' to fill';
  }
  if (facts.fresh) return 'fresh';
  if (facts.ownership === 'curator') return 'written';
  return 'no freshness reading';
}

// ── `foundationsRefreshOffer` IS GONE (v3.61.0, P1-4) ────────────────────
// It answered "may this project be refreshed, and if not why not" for ONE head
// slot. The head now carries up to three controls and the question became
// "which of them does this state get", which is the function below — and a
// helper kept alive only because a suite pinned it is worse than no helper:
// scripts/test-next-memory-view.js drives the successor instead.

/**
 * WHICH HEAD CONTROLS THIS STATE GETS — one table, five rows (P1-4, §3.5).
 *
 * ── WHY "NEVER BOTH" WAS WRONG ──────────────────────────────────────────
 * The first cut gave the head ONE slot filled by ownership: a mirror got
 * "Refresh from repo", a curator-owned project got "Add document". That closes
 * the door on the ordinary case: a mirror set up with three documents can be
 * re-copied for ever and never EXTENDED, so the only way to add a fourth
 * becomes an agent's `save_working_state({repo_root})` — which is exactly the
 * "the app writes nothing on this tier" complaint this release exists to fix.
 *
 * Two secondaries and no primary is the correct taxonomy here: neither
 * completes a step in front of the owner, and both act.
 *
 * | state                                     | controls                    |
 * |-------------------------------------------|-----------------------------|
 * | curator-owned                             | Add document                |
 * | repo-owned, >= 1 document, root reachable | Refresh from repo · Add from folder |
 * | repo-owned, 0 documents, root reachable   | Add from folder             |
 * | repo-owned, root unreachable              | none; the withheld reason   |
 * | read-only mirror                          | none; the mirror note       |
 */
function foundationsControlOffer(facts, readonly) {
  // A READ-ONLY SHARED BRAIN MIRROR GETS NOTHING (P1-3). Every route this
  // block can reach answers 403 (`refuseMirror`), and a control whose only
  // outcome is a refusal is worse than none (v3.16.1). The reason is a note,
  // not an absence (v3.17.1).
  if (readonly) {
    return {
      refresh: false, add: false, mirror: false,
      reason: 'A read-only mirror — documents here are copied in, never edited.',
    };
  }
  if (facts.manifestError) return { refresh: false, add: false, mirror: false, reason: null };
  if (!facts.present) return { refresh: false, add: false, mirror: false, reason: null };
  if (facts.ownership === 'curator') return { refresh: false, add: true, mirror: false, reason: null };
  // REPO-OWNED. Reachability is read off the DOCUMENTS, never off `repo.root`
  // — the manifest records a path on the machine that last refreshed, which on
  // any other machine is a hint, while each document's own `freshness` is what
  // the store actually measured.
  const reachable = !facts.count
    || facts.docs.some((d) => d.freshness === 'fresh' || d.freshness === 'stale');
  if (!reachable) {
    // ── AND THIS IS THE ARM THAT MOST NEEDS THE GITHUB CONTROL ──────────
    // Through v3.65.0 this arm offered NOTHING — and it is exactly the machine
    // the store's remote arm was built for: `refreshFoundationsFromRepo` takes
    // the remote path when the checkout is not reachable
    // (src/brain/working-state.js:5856-5869), so the app had a shipped
    // capability with no control on the only computer that needs it. The
    // reason still stands beside it: the FOLDER is not here, and that is why
    // the two folder controls are withheld.
    return {
      refresh: false, add: false, mirror: true,
      reason: 'The folder these were copied from is not on this computer, so they can neither '
        + 'be re-copied nor added to here. Mirror it from GitHub instead, or open the '
        + 'project on the machine that has the folder.',
    };
  }
  return { refresh: facts.count > 0, add: true, mirror: true, reason: null };
}

/**
 * IS THIS DOCUMENT STILL A SET OF PROMPTS — from the FLAG, never the text (P1-2).
 *
 * The store writes a skeleton whose first line is a bold banner naming itself,
 * and it would be very easy to recognise one by matching that sentence. That
 * is the mistake this function exists to make impossible: the banner is COPY,
 * the owner is invited to delete it the moment they answer the prompts, and a
 * view that read the identity out of it would call a half-filled document a
 * skeleton and a filled one whose owner left the line in place a skeleton for
 * ever. `skeleton` is a boolean the store computes and the wire carries; it is
 * the only thing this view may read.
 *
 * `=== true` rather than truthiness so a build that sends no flag at all reads
 * FALSE rather than `undefined`-as-maybe — a fact and its absence stay apart.
 */
function skeletonOf(d) {
  return !!d && d.skeleton === true;
}

/**
 * "STOP MIRRORING THIS DOCUMENT?" — the confirm strip for a row Remove.
 *
 * ── IN FLOW, UNDER THE TABLE, NEVER A DIALOG (v3.61.1) ──────────────────
 * The same rule the editor's own delete strip and the brief's unsaved-draft
 * bar follow: the thing under discussion has to stay on screen while the owner
 * decides about it. A modal would cover the row they are looking at.
 *
 * ── AND IT NAMES THE OUTCOME, WHICH IS NOT "DELETED" ────────────────────
 * On a mirror the copy goes and the SOURCE FILE DOES NOT. That is the whole
 * difference between this strip and the editor's, and it is the sentence
 * somebody needs before pressing: "are you sure?" over 25 rows is a question
 * about none of them, and "cannot be undone" would be false here — the file is
 * still in the folder and can be mirrored again from the same picker.
 *
 * `.btn-danger-solid` is the taxonomy's one sanctioned filled-danger use: a
 * confirm whose primary action IS the destruction. The row's own opener stays
 * tinted.
 */
function renderFoundationStop(facts) {
  const st = state.fndStop;
  if (!st || st.domain !== state.activeDomain || st.project !== state.activeProject) return '';
  const slug = String(st.slug || '');
  // A SLUG THAT IS NO LONGER IN THE TABLE IS NOT A QUESTION. A refresh that
  // dropped the document, or a second tab, would otherwise leave a confirm
  // about a row nobody can see — answered against a document already gone.
  if (!facts.docs.some((d) => String(d.slug || '') === slug)) return '';
  const mirrored = facts.ownership === 'repo';
  return (
    '<div class="mem-fnd-delete-bar" role="alertdialog" aria-label="Stop mirroring this document">' +
      '<span>' + (mirrored
    ? 'Stop mirroring <b>' + escapeHtml(slug) + '</b>? The copy is removed and your agents '
          + 'stop reading it; the file in your folder is untouched, and you can mirror it again '
          + 'from the same picker.'
    : 'Remove <b>' + escapeHtml(slug) + '</b>? The document is removed from this project and '
          + 'from your agents\u2019 next session. It cannot be undone from inside The Curator; if '
          + 'you sync, a git client can still recover it.') + '</span>' +
      '<button type="button" class="btn btn-danger-solid btn-xs" id="mem-fnd-stop-go"' +
        (st.busy ? ' disabled' : '') + '>' +
        escapeHtml(st.busy ? 'Removing\u2026' : (mirrored ? 'Stop mirroring' : 'Remove permanently')) +
      '</button>' +
      '<button type="button" class="btn btn-ghost btn-xs" id="mem-fnd-stop-no"' +
        (st.busy ? ' disabled' : '') + '>Keep it</button>' +
      (st.error
        ? '<span class="mem-fnd-stop-error">' + escapeHtml(String(st.error)) + '</span>'
        : '') +
    '</div>'
  );
}

function fndRowHtml(d, editable, readonly) {
  const slug = String(d.slug || '');
  const rowId = 'mem-fnd-' + slug.replace(/[^a-z0-9]+/gi, '-');
  // `.fnd-src-path`, NOT the shared `.mono` utility span. The work-stream slug
  // one table up takes the code face through a class of its own for the same
  // reason: this is a piece of DATA with a role, not a fragment of prose that
  // happens to be monospaced, and scripts/test-next-views-kit.js ratchets this
  // view's `.mono` spans precisely so a table of them cannot accumulate.
  const src = d.source && d.source.kind === 'repo' && d.source.path
    ? '<span class="fnd-src-path">' + escapeHtml(d.source.path) + '</span>'
      + (d.commit ? '<span class="fnd-commit"> @ ' + escapeHtml(String(d.commit).slice(0, 7)) + '</span>' : '')
    : 'Curator-authored';
  // ── WHAT A CURATOR-OWNED ROW SAYS INSTEAD (P2-1) ───────────────────────
  // Not "Curator-authored" and "—" in two columns whose every cell says the
  // same thing: on a curator-owned project `Source` has one value and `Copy`
  // has one value, and a column with one value is the table equivalent of a
  // flag on 100 % of a list (v3.53.1). The two columns collapse into ONE that
  // carries the row's only variable fact — is this written, and by whom, or is
  // it still a set of prompts.
  const stateWord = skeletonOf(d) ? 'skeleton · to fill'
    : (d.authoredBy && d.authoredBy.kind === 'human') ? 'written by you'
      : (d.authoredBy && d.authoredBy.kind) ? 'written by an agent' : 'written';
  // THE SHARED SCALE, AND ONLY ON THE TIERS THAT HAVE A READING. fresh and
  // stale are the two ends of a comparison that was actually made;
  // `unreachable` is the dashed unknown ring, which is exactly what it means
  // everywhere else in the app. A curator-authored document gets NO dot: there
  // is no upstream to be fresh against, and a grey dot beside "—" would read
  // as a stale one at a glance.
  //
  // ── A SKELETON READS "skeleton · to fill", AND IT TAKES NO DOT (v3.61.0)
  // A skeleton is a curator-owned document, so it has no upstream and would
  // have got the em dash. The dash is right for a written one and wrong here:
  // an unfilled prompt IS the one fact on this row somebody needs, and "—"
  // says nothing. It stays dotless for the reason a written curator document
  // is: the scale paints a COMPARISON, and there is nothing to compare this
  // against. The word carries it instead.
  const skeleton = skeletonOf(d);
  const tier = skeleton ? null
    : d.freshness === 'fresh' ? 'recent'
      : d.freshness === 'stale' ? 'week'
        : d.freshness === 'unreachable' ? 'unknown' : null;
  const word = skeleton ? 'skeleton · to fill'
    : d.freshness === 'fresh' ? 'fresh'
      : d.freshness === 'stale' ? 'stale'
        : d.freshness === 'unreachable' ? 'source not here' : '—';
  const ageSecs = d.updatedAt
    ? Math.max(0, Math.round((Date.now() - Date.parse(d.updatedAt)) / 1000)) : null;
  const age = Number.isFinite(ageSecs) ? formatAge(ageSecs) : null;
  const bytes = Number.isInteger(d.bytes) ? d.bytes : 0;
  const size = bytes < 1024 ? bytes + ' bytes' : Math.round(bytes / 1024).toLocaleString('en-US') + ' KB';
  return (
    '<tr class="fnd-row">' +
      '<td class="fnd-cell-role"><span class="fnd-role">' + escapeHtml(d.role || 'other') + '</span></td>' +
      '<td class="fnd-cell-title">' +
        '<button type="button" class="fnd-open" id="' + escapeHtml(rowId) + '"' +
          ' aria-label="' + escapeHtml('Open ' + (d.title || slug)) + '"' +
          ' data-fnd-slug="' + escapeHtml(slug) + '">' +
          escapeHtml(d.title || slug) +
        '</button>' +
      '</td>' +
      '<td class="fnd-cell-size">' + escapeHtml(size) + '</td>' +
      // ── "READ FIRST" — WHAT AN AGENT IS HANDED WITHOUT ASKING ────────
      //
      // A flagged document's BODY arrives with every session; an unflagged one
      // rides as an index line the agent opens BY NAME on the brief's
      // instruction. That is the one fact on this row a person changes their
      // mind about, so it is a control rather than a reading.
      //
      // ALLOWED ON BOTH OWNERSHIPS. The flag is curator METADATA ABOUT a
      // document, never part of it, so setting it on a mirror writes nothing
      // into the copy and cannot make the app a second author of the file. It
      // is withheld only on a read-only Shared Brain mirror, where every route
      // answers 403 and a control whose only outcome is a refusal is worse
      // than none (v3.16.1).
      //
      // `aria-pressed` rather than a checkbox: it is a toggle that stays
      // pressed, which is exactly what that attribute means — and unlike the
      // OVERVIEW tiles' case, this one really does stay. The WORD is the
      // reading; the tick is the affordance, and neither carries it alone.
      (readonly ? '' : '<td class="fnd-cell-first">'
        + '<button type="button" class="fnd-first' + (d.readFirst === true ? ' fnd-first-on' : '')
        + '" data-fnd-first="' + escapeHtml(slug) + '"'
        + ' aria-pressed="' + (d.readFirst === true ? 'true' : 'false') + '"'
        + ' aria-label="' + escapeHtml((d.readFirst === true ? 'Stop reading ' : 'Read ')
          + (d.title || slug) + ' first') + '">'
        + (d.readFirst === true ? 'read first' : 'on request')
        + '</button></td>') +
      // THE COLUMN VARIANT (P2-1). `editable` is the curator-owned arm, and it
      // is the same flag that decides whether this row gets a pencil — one
      // condition, so the head and the body cannot disagree about which table
      // this is.
      (editable
        ? '<td class="fnd-cell-state">' + escapeHtml(stateWord) + '</td>'
        : '<td class="fnd-cell-source">' + src + '</td>' +
      // THE DOT AND THE WORD IN ONE WRAPPER, and the wrapper is what this view
      // styles. shared/freshness.css owns the `.fresh-` prefix outright — no
      // other stylesheet may declare a rule on it (scripts/test-freshness-scale.js
      // fails one that does) — so the gap between mark and word belongs to a
      // class of this view's own rather than to a `.fresh-dot` selector here.
      '<td class="fnd-cell-fresh"><span class="fnd-fresh">' +
        (tier ? '<span class="fresh-dot fresh-' + tier + '" aria-hidden="true"></span>' : '') +
        '<span class="fnd-fresh-word">' + escapeHtml(word) + '</span>' +
      '</span></td>') +
      // The same hook every other age on this page carries, so tickAges
      // rewrites it once a second without a render. No stamp, no hook — an
      // unknown age has nothing to move.
      '<td class="fnd-cell-age"' +
        (age && d.updatedAt ? ' data-mem-age-at="' + escapeHtml(d.updatedAt) + '"' : '') + '>' +
        '<span class="mem-age-words">' + escapeHtml(age || 'unknown') + '</span>' +
      '</td>' +
      // ── THE EDIT CONTROL, ON CURATOR-OWNED ROWS ONLY (v3.61.0) ─────────
      //
      // VISIBLE AT REST, never hover-only: touch has no hover, and v3.58.0
      // recorded a guard that went green while a later `opacity: 0` made a
      // copy control hover-only. `aria-label` carries the meaning because the
      // glyph carries none, and there is NO `title=` — this view's tooltip
      // budget is 1 and may not grow (scripts/test-next-header-adoption.js).
      //
      // A MIRRORED ROW GETS NO CONTROL AT ALL. The route answers 400
      // `repo_owned` on a PUT to one, and a control whose only outcome is a
      // refusal is worse than no control (v3.16.1) — the reader's own note
      // says where that document IS edited instead.
      // THE CELL ITSELF IS WITHHELD, not merely emptied (v3.61.0, P2-1). The
      // head emits no `<th>` for it on the mirrored arm, so an empty `<td>`
      // here would make a six-column head sit over a seven-cell body — the
      // browser tolerates it and the columns quietly stop lining up, which is
      // exactly the class of defect only a rendered look finds.
      (readonly ? '' : '<td class="fnd-cell-edit">' +
        (editable
          ? '<button type="button" class="btn btn-ghost btn-xs fnd-edit"' +
            ' data-fnd-edit="' + escapeHtml(slug) + '"' +
            ' aria-label="' + escapeHtml('Edit ' + (d.title || slug)) + '">' +
            '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
            'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3z"/><path d="M14.5 6.5l3 3"/></svg>' +
          '</button>'
          // ── STOP MIRRORING, ON A MIRRORED ROW (v3.61.1) ────────────────
          //
          // THE DEFECT: a mirrored project's document list could not be
          // edited AT ALL. The maintainer mirrored his own repository, got 25
          // rows including files he never meant to carry, and had no way to
          // remove one — the route answered 400 `repo_owned` on a DELETE, a
          // refusal v3.61.0 itself recorded as "arguably wrong".
          //
          // It is a `.btn-danger` and not a ghost because the taxonomy is
          // explicit that the tinted danger face means DESTROYS DATA, and
          // this destroys the copy. It is LABELLED rather than a glyph, for
          // the reason this table's own header records: a pencil on a
          // document is unambiguous and "stop copying this file across from a
          // folder" is not, so a mark for it would be a guess.
          //
          // The word is "Remove" and not "Delete", because what goes is the
          // COPY: the file in the folder is untouched, which the confirm
          // strip says in full before anything happens.
          : '<button type="button" class="btn btn-danger btn-xs fnd-stop"' +
            ' data-fnd-stop="' + escapeHtml(slug) + '"' +
            ' aria-label="' + escapeHtml('Stop mirroring ' + (d.title || slug)) + '">' +
            'Remove</button>') +
        '</td>') +
    '</tr>'
  );
}

// ═════════════════════════════════════════════════════════════════════════
// THE FOUNDATION EDITOR — the OWNER's pen on a curator-owned document
// ═════════════════════════════════════════════════════════════════════════
//
// ── WHY THE APP MAY WRITE THIS AT ALL, WHEN IT MAY NOT WRITE A HANDOFF ───
//
// The property tiers 2 and 3 rest on was never "one process": it is ONE
// WRITER PER FILE and PROVENANCE THAT MATCHES. A handoff has exactly one
// writer — the agent that owns that (work-stream, machine) folder — and a
// browser write there would be a SECOND writer stamping a human edit with the
// last agent's provenance line.
//
// Tier 0 splits on OWNERSHIP instead, and the store enforces it before any
// write: a project's documents are all curator-owned or all repo-owned, and a
// mismatch is refused. So
//
//   · on a MIRROR the app is a COPIER, never an author — "Refresh from repo"
//     re-copies bytes the repository already wrote, and two copiers of one
//     byte string converge rather than conflict (the v3.59.0 argument);
//   · on a CURATOR-OWNED document the app is the OWNER'S PEN, exactly as it
//     is on the standing brief: the write carries `authoredBy.kind: 'human'`,
//     so it can never be mistaken for a commissioned agent's, and it is
//     structurally impossible for it to land on a mirror because the store
//     refuses the ownership mismatch;
//   · on tiers 2 and 3 it is NEITHER, and those stay agent-only.
//
// THE COST, STATED. Tier 0 has no `<machine>` segment, so two machines editing
// one curator-owned document converge to whichever SAVED LAST under Personal
// Sync's `pull -X theirs` — and unlike a mirror there is no upstream to
// re-assert it on the next save and no journal behind it. That is the same
// carve-out `state/project.md` has carried since v3.48.0: edit rarely, sync
// after. docs/sync.md records it.
//
// ── IT LOADS RAW BYTES, AND THAT IS A CORRECTNESS PROPERTY ───────────────
//
// The read path DEFANGS protocol-shaped text (a URL, a `<tool_use>` tag, a
// role marker) because these bytes arrive over sync from other machines and,
// in a shared mirror, from other people. The WRITE path is verbatim, because a
// canonical document cannot be trimmed or rewritten honestly. Load the defanged
// read into an editor and the first save writes the defanged text back — the
// document is corrupted by opening it. So the editor asks for `?raw=1`, which
// answers the verbatim file with `sanitisedOnRead: false`, and the round trip
// is byte-exact. The READER keeps the defanged default: it renders markdown
// into the page, which is where the escaping duty belongs.

/**
 * HOW BIG THE DRAFT IS, in the two units that matter — tier 0's own wall.
 *
 * The same shape as `briefStats` one block down and NOT the same function,
 * because they measure against two different walls the SERVER enforces
 * separately: 32 KB for a standing brief, 512 KB for a canonical document.
 * One function taking a limit would be tidier and would put the two numbers
 * one argument apart at every call site; the value here is that a call site
 * cannot pass the wrong wall at all.
 */
function fndStats(text) {
  const s = typeof text === 'string' ? text : '';
  const bytes = new TextEncoder().encode(s).length;
  const words = s.trim() ? s.trim().split(/\s+/).length : 0;
  return { bytes, words, over: bytes > MAX_FOUNDATION_BYTES };
}

/**
 * IS THIS SLUG ONE THE STORE WILL TAKE — and if not, why, in words.
 *
 * Only asked on "Add document": an existing document's slug is the file's own
 * name and is not editable, because a rename is a delete plus a create and
 * neither the store nor this editor pretends otherwise.
 *
 * `FOUNDATION_SLUG_RE` is the store's own pattern, mirrored in
 * shared/foundations-init.js and pinned equal to it. A view refusing at a
 * DIFFERENT grammar from the server would either block a name the server
 * accepts or offer one it refuses with a 400 the owner cannot act on.
 */
function fndSlugError(slug, taken) {
  const s = String(slug == null ? '' : slug).trim();
  if (!s) return 'Give the document a file name, ending in .md.';
  if (!FOUNDATION_SLUG_RE.test(s)) {
    return 'A file name is lowercase letters, digits and hyphens, and ends in .md — '
      + 'for example architecture.md.';
  }
  if (Array.isArray(taken) && taken.indexOf(s) >= 0) {
    return 'This project already has a document called ' + s + '. Edit that one, or pick another name.';
  }
  return null;
}

/**
 * IS THIS SAVE A SHRINK THE OWNER SHOULD CONFIRM — D5.
 *
 * The store carries a 10 % shrink guard that needs `replace: true`, and the
 * route passes it: the guard is advice a person in a browser cannot take, and
 * a 400 that says "pass replace: true" is a refusal an owner cannot act on.
 * So the HONESTY moves here, where the two sizes are both in hand and a
 * sentence can name them.
 *
 * TWO CONDITIONS, and the second is what stops this firing constantly: the
 * draft is under 90 % of what was loaded AND the loaded document was at least
 * 1 KB. Cutting a 200-byte stub in half is ordinary editing; cutting a
 * 40 KB architecture note in half is a thing to be sure about.
 */
function fndShrinkWarn(e) {
  if (!e) return null;
  const before = new TextEncoder().encode(String(e.loaded || '')).length;
  const after = new TextEncoder().encode(String(e.text || '')).length;
  if (before < 1024) return null;
  if (after >= before * 0.9) return null;
  return { before, after };
}

/**
 * BLOCK ⑤'s BODY — the fold, the table and the one control.
 *
 * CLOSED BY DEFAULT, like the brief above it and the journal below it: this is
 * a page somebody opens to answer "where does this project stand", and a table
 * of reference documents is not that answer. The summary line carries the
 * decision to open it — how many, how big, and the one word that says whether
 * anything needs attention.
 *
 * WHAT IS NEVER INSIDE THE FOLD: the manifest error, the orphan-file note and
 * the outcome of a refresh. v3.16.1's rule — a warning behind a click is not a
 * warning — and all three are warnings or the results of an action the user
 * just took.
 */
/**
 * THE FOUR THINGS THAT NEVER FOLD, AND NOW SIT WHERE THEY BELONG (P1-7).
 *
 * A manifest that will not parse, files in the folder with no manifest entry,
 * the outcome of a re-copy, and the refusal of an ownership choice. Every one
 * of them is a warning, an outcome or a refusal, which design-system §3 (from
 * v3.16.1) says may never fold — and until this release all four were emitted
 * at the top of the block's BODY, inside its 32px prose indent, because the
 * slot built for them had never been used by any block on this page.
 *
 * They are step ①'s `noticeHtml` now: above the heading, inside the block's
 * own wrapper, which is what `shared/block.js` documents that slot for. Split
 * into a function of its own rather than returned as a second value, because
 * `renderBlock` takes the two through two different arguments and a renderer
 * that returned a pair would have one caller and one shape.
 */
function foundationsNotices(read) {
  const facts = foundationsFacts(read);
  const readonly = !!(state.detail && state.detail.readonly) || !!(read && read.readonly);
  let notes = '';
  if (facts.manifestError) {
    notes += '<div class="mem-note">' + icon('alertTriangle', 13) +
      '<span>This project’s documents manifest could not be read, so nothing below it can be ' +
      'trusted: ' + escapeHtml(String(facts.manifestError)) + '</span></div>';
  }
  if (facts.orphanFiles.length) {
    notes += '<div class="mem-note">' + icon('alertTriangle', 13) +
      '<span>' + escapeHtml(facts.orphanFiles.length + ' file' +
        (facts.orphanFiles.length === 1 ? ' is' : 's are') + ' in the documents folder with no ' +
        'manifest entry (' + facts.orphanFiles.slice(0, 3).join(', ') + '). ' +
        'The manifest is written last, so a save that was interrupted leaves the document behind ' +
        'rather than an entry pointing at nothing.') + '</span></div>';
  }
  // THE REFRESH OUTCOME, STAMPED with the pair it was asked for — the same
  // discipline `copied` and `briefEdit` use, and for the same reason: this
  // view switches project without unmounting, and an unstamped result would
  // sit under the next project's header claiming its documents had been
  // re-copied.
  const fnd = state.fnd && state.fnd.domain === state.activeDomain
    && state.fnd.project === state.activeProject ? state.fnd : null;
  if (fnd && fnd.error) {
    notes += '<div class="mem-note">' + icon('alertTriangle', 13) +
      '<span>' + escapeHtml('Nothing was copied: ' + fnd.error) + '</span></div>';
  } else if (fnd && fnd.result) {
    const r = fnd.result;
    const said = [];
    if (r.refreshed.length) said.push(r.refreshed.length + ' re-copied');
    if (r.added.length) said.push(r.added.length + ' added');
    if (r.unchanged.length) said.push(r.unchanged.length + ' already current');
    if (r.missing.length) said.push(r.missing.length + ' no longer in that folder (the copy is kept)');
    notes += '<div class="mem-note">' + icon('check', 13) +
      '<span>' + escapeHtml(said.length ? said.join(' · ') : 'Nothing to copy.') + '</span></div>';
  }

  // ── THE OWNERSHIP CHOICE'S OWN OUTCOME (v3.61.0) ──────────────────────
  // Stamped like every other outcome on this screen, and never folded: a
  // refusal from `…/foundations/init` is the reason nothing happened, and the
  // `refused[]` a mirror comes back with names the files that were NOT copied.
  const ini = state.fndInit && state.fndInit.domain === state.activeDomain
    && state.fndInit.project === state.activeProject ? state.fndInit : null;
  if (ini && ini.error) {
    // TWO TITLES, BECAUSE THEY ARE TWO REFUSALS (v3.65.1). "Nothing was set up"
    // is the init arm's — an ownership that was not recorded. A refused SWITCH
    // set nothing up either way: the project keeps the source it had, and
    // saying so is what tells the owner nothing is half-done. The store makes
    // that true rather than this sentence: `refreshRemoteCore` writes nothing
    // until every blob is in hand, so a failed read leaves the mirror exactly
    // as it was.
    notes += renderStatus({
      state: 'danger',
      title: ini.switching ? 'The source was not changed' : 'Nothing was set up',
      detail: ini.error,
    });
  }
  if (ini && Array.isArray(ini.refused) && ini.refused.length) {
    notes += renderRefusedList(ini.refused);
  }
  return notes;
}

function renderFoundations(read) {
  const facts = foundationsFacts(read);
  // A READ-ONLY SHARED BRAIN MIRROR (P1-3). Read exactly where `renderBrief`
  // reads it, off the same two fields, so the two blocks cannot disagree about
  // whether this domain may be written to.
  const readonly = !!(state.detail && state.detail.readonly) || !!(read && read.readonly);
  // THE REFRESH OUTCOME'S STAMP, read again here because the control row below
  // needs its `busy` flag. `foundationsNotices` owns the WORDS; this owns the
  // control's state, and the two read the same stamped object.
  const fnd = state.fnd && state.fnd.domain === state.activeDomain
    && state.fnd.project === state.activeProject ? state.fnd : null;

  // ── THE CONTROL ROW (P1-4, P1-8, P2-8) ────────────────────────────────
  //
  // A ROW, not one absolutely-positioned slot. The release needs up to THREE
  // controls here — Refresh, Add, and the drafting ask — and a `padding-right:
  // 150px` reserve for a variable number of them is a literal that goes wrong
  // silently (the class `--ing-col` is recorded against in the design doc).
  // The controls are in flow after the `<details>` and `.mem-fnd-head` is a
  // wrapping flex row; see views/memory.css.
  const busy = !!(fnd && fnd.busy);
  const editing = !!(state.fndEdit && state.fndEdit.domain === state.activeDomain
    && state.fndEdit.project === state.activeProject);
  const curator = facts.ownership === 'curator';
  const controls = foundationsControlOffer(facts, readonly);
  const refreshBtn = controls.refresh
    ? '<button type="button" class="btn btn-secondary btn-xs mem-fnd-refresh" id="mem-fnd-refresh"' +
      (busy ? ' disabled aria-disabled="true"' : '') + '>' +
      escapeHtml(busy ? 'Refreshing…' : 'Refresh from repo') + '</button>'
    : '';
  // "Add from folder" on a MIRROR and "Add document" on a curator-owned
  // project are the same control with the reader's own word for what arrives:
  // one copies a file that is already on disk, the other opens an empty
  // document. Both are `btn-secondary btn-xs` — neither completes a step.
  //
  // OFFERED AT COUNT 0 TOO, on both arms: a curator-owned project whose owner
  // unticked the seeding, and a mirror whose ownership was set a second ago,
  // are exactly the two states in which the one action that puts a document in
  // must be reachable — the mistake v3.59.0 made with Refresh, one arm over.
  const addBtnId = curator ? 'mem-fnd-add' : 'mem-fnd-addrepo';
  const addBtn = controls.add
    ? '<button type="button" class="btn btn-secondary btn-xs mem-fnd-action" id="' + addBtnId + '"' +
      (busy ? ' disabled aria-disabled="true"' : '') + '>' +
      (curator ? 'Add document' : 'Add from folder') + '</button>'
    : '';
  // ── "Mirror from GitHub instead" (v3.65.1, D6) ────────────────────────
  // ONE SOURCE PER PROJECT, and this is how it moves: the ownership stays
  // `repo` — the store's one-ownership-per-project rule is untouched — and
  // what changes is WHERE the bytes are read from. `repo.root` is cleared and
  // `repo.remote` is set, in the same manifest write the re-copy performs.
  //
  // Offered on BOTH repo-owned arms, including the one where the checkout is
  // not on this computer: see `foundationsControlOffer`.
  const mirrorBtn = controls.mirror
    ? '<button type="button" class="btn btn-secondary btn-xs mem-fnd-mirror" id="mem-fnd-mirror"' +
      (busy ? ' disabled aria-disabled="true"' : '') + '>Mirror from GitHub instead</button>'
    : '';
  const askBtn = foundationsDraftAsk(facts, readonly);
  const action = editing ? '' : (refreshBtn + addBtn + mirrorBtn + askBtn.btn);
  // A WITHHELD CONTROL SAYS WHY (v3.17.1). Two reasons can stand here — the
  // folder is not on this computer, or this is a read-only mirror — and both
  // are `.tx-note`, unfolded: a reason behind a chevron is not a reason.
  const withheld = controls.reason
    ? '<div class="tx-note">' + icon('alertCircle', 13) + '<span>' + escapeHtml(controls.reason) + '</span></div>'
    : '';

  // ── NOTHING CHOSEN YET: THE CHOOSER, WHERE THE ANSWER IS MISSING ───────
  //
  // Until this release this state showed one sentence naming the two ways a
  // document arrives — and neither of them was reachable from the app: the
  // refresh route passed no file list, so a mirror could only be created from
  // a test, and only the `save_foundation` MCP tool wrote a curator document.
  // So the sentence was true and the screen was a dead end.
  //
  // The chooser replaces it. It is the SAME control the "New project" form
  // renders (shared/foundations-init.js) because the choice is the same choice,
  // and it is made ONCE — the store refuses a mismatch on every later write,
  // which is why the commit below is the one primary in this block.
  if (!facts.present && !facts.manifestError) {
    // ── WITHHELD ON A READ-ONLY MIRROR (P1-3) ──────────────────────────
    // Every init this chooser could POST answers 403 on a `shared-*` mirror,
    // so the choice is not the user's to make here. The note takes its place
    // and the summary line still says what is there.
    if (readonly) {
      return '<div class="tx-note">' + icon('alertCircle', 13) + '<span>' +
          escapeHtml('A read-only mirror — documents here are copied in, never edited.') +
        '</span></div>' +
        '<div class="mem-fnd-row"><div class="mem-fold mem-fold-flat"><div class="mem-fold-body">' +
          renderDescription('No canonical documents in this mirror yet.') +
        '</div></div></div>';
    }
    // ── NO POINTER HERE: THE PROJECT ALREADY EXISTS ──────────────────────
    // This state is reached INSIDE a project that has been selected — the
    // sidebar, the brief and the work-stream table above it all agree the
    // project is real. The missing thing is the ownership answer, and the
    // chooser right above IS the way to give it; a "Create a project in
    // Domains" pointer here would send the person who came to answer that
    // question away from the one control that answers it. The pointer
    // belongs to `renderNoProjects()`, where a project genuinely does not
    // exist yet (§8(e)).
    return renderFoundationsInit(facts);
  }
  // ── AND WITHHELD ON AN UNREADABLE MANIFEST (P1-3) ────────────────────
  // An unreadable manifest is a PRESENT manifest: `…/foundations/init`
  // answers `ownership_set`, so painting a two-way choice would offer a
  // decision that cannot be taken. The error note above is already unfolded;
  // what is withheld here is the chooser, and the summary says
  // "manifest unreadable" rather than a count nothing can stand behind.
  if (facts.manifestError) {
    return '<div class="mem-fnd-row">' +
        '<div class="mem-fold mem-fold-flat"><div class="mem-fold-body">' +
          renderDescription('Nothing below the manifest can be trusted, so no choice is '
            + 'offered here. Fix or remove the manifest file and re-open this project.') +
        '</div></div>' +
      '</div>';
  }

  // ── CHOSEN, REPO-OWNED, NOTHING MIRRORED YET ──────────────────────────
  // The scan picker on its own: the ownership is settled, so the two-way
  // choice is withheld (it cannot be made) and what is left is the one action
  // that puts documents in — "Add from repository".
  if (!facts.count && facts.ownership === 'repo' && !readonly) {
    return renderFoundationsInit(facts);
  }

  // ── NO DOCUMENTS, NO FOLD ─────────────────────────────────────────────
  // The same shape `renderBrief` uses for a project with no brief, and for the
  // same reason: there is one sentence to show, and hiding the sentence that
  // explains what is missing behind a chevron is "the missing thing has to be
  // missing where you looked for it" read backwards.
  if (!facts.count) {
    // ── THE OWNER IS NAMED FIRST (P1-12) ──────────────────────────────
    // A person can start a project here with no agent and no repository and
    // write the first document by hand — a first-class path, not a fallback —
    // so the body names BOTH ways in, and the owner's way first. The summary
    // meta beside it already distinguishes "kept here · no documents yet"
    // from "mirrored · no documents copied yet" (P1-11).
    const emptyBody = facts.ownership === 'repo'
      ? 'Mirrored from ' + ((facts.repo && facts.repo.root) || 'a folder on this Mac')
        + '. Nothing copied yet.'
      : 'Kept here. No documents yet. Write the first one yourself, or ask an agent to draft them.';
    return '<div class="mem-fnd-row">' +
        '<div class="mem-fold mem-fold-flat"><div class="mem-fold-body">' +
          (editing ? renderFoundationEditor(facts) : renderDescription(emptyBody)) +
        '<div class="mem-fnd-head-controls">' + action + '</div>' +
        '<div class="mem-fold mem-fold-flat"><div class="mem-fold-body">' +
          (editing ? renderFoundationEditor(facts) : renderDescription(emptyBody)) +
        '</div></div>' +
      '</div>' + askBtn.panel + withheld;
  }

  const summary =
    '<summary class="mem-fold-summary" id="mem-fold-foundations">' + icon('chevronRight', 14) +
      '<span>The documents</span>' +
      '<span class="mem-fold-meta">' +
        escapeHtml(foundationsSummaryMeta(facts)) +
      '</span>' +
    '</summary>';

  const rows = facts.docs.map((d) => fndRowHtml(d, curator, readonly)).join('');
  // ── THE EDITOR REPLACES THE TABLE, IT DOES NOT SIT UNDER IT ────────────
  // The standing brief's own precedent one block up, and the same reason: two
  // views of one set of documents on screen at once, one of them describing a
  // size that is no longer true the moment a key is pressed. The fold is
  // FORCED OPEN when an editor is OPENED — and that force is a transient
  // (`state.fndForceOpen`, v3.64.1), never the persisted preference: through
  // v3.64.0 the Edit press wrote `state.openFolds.foundations = true` to
  // localStorage, so one press marked the fold open on every later visit, and
  // the `editing || adding ||` disjunction that used to be in the `open`
  // expression below re-forced it on every paint — which is how a close the
  // user had just made was overwritten by the renderer that ignored it.
  // ── "Add from folder" ON A POPULATED MIRROR (P1-4) ────────────────────
  // The chooser's repo arm under the table rather than in place of it: a
  // mirror with six documents that hid them in order to ask about a seventh
  // would be describing a state the owner is not in. `adding` is set only by
  // the head control, so the ordinary paint is unaffected.
  const adding = !!(state.fndInit && state.fndInit.domain === state.activeDomain
    && state.fndInit.project === state.activeProject && state.fndInit.adding);
  const body = editing
    ? renderFoundationEditor(facts)
    : '<div class="fnd-wrap"><table class="fnd-table">' +
        '<thead><tr>' +
          '<th scope="col">Role</th>' +
          '<th scope="col">Document</th>' +
          '<th scope="col">Size</th>' +
          // Withheld on a read-only mirror, where the toggle is too — a head
          // cell over a column the body does not emit makes the columns
          // quietly stop lining up, which is the class of defect only a
          // rendered look finds (v3.61.0's own note, one column over).
          (readonly ? '' : '<th scope="col">Read</th>') +
          // ── FIVE COLUMNS OR SIX, BY OWNERSHIP (P2-1) ─────────────────
          // A curator-owned project's `Source` is always "Curator-authored"
          // and its `Copy` is always "—", so the two collapse into one State
          // column carrying the row's real variable: written by whom, or
          // still a prompt. Three things follow at once — two dead columns
          // go, the pencil gets a cell without a seventh column, and the
          // curator-owned table comes in UNDER the 568 px overflow v3.59.0
          // recorded (5 columns, not 6). The REPO-owned table keeps its six
          // and keeps that overflow; `overflow-x: auto` still carries it and
          // this release does not claim to have fixed it.
          (curator
            ? '<th scope="col">State</th>'
            : '<th scope="col">Source</th><th scope="col">Copy</th>') +
          '<th scope="col">Updated</th>' +
          // A COLUMN WITH A BLANK HEADER WOULD BE A COLUMN NOBODY NAMED. It
          // holds an icon-only control, so the heading is visually hidden
          // rather than absent: a screen reader reading the row still hears
          // which column the button is in. Emitted only on the arm that HAS
          // a row control — a column reserved for nothing is furniture.
          // ── AND ON THE MIRRORED ARM TOO, SINCE v3.61.1 ───────────────
          // It used to be curator-only, because a mirror had no row control:
          // the DELETE route refused one. It has a control now — Remove,
          // meaning stop mirroring — so the column exists on both arms and is
          // withheld only where NOTHING may be written, which is a read-only
          // Shared Brain mirror. The cost is stated rather than hidden: the
          // repo-owned table is seven columns wide now and still scrolls
          // horizontally under ~600 px, which `overflow-x: auto` carries and
          // this release does not claim to have fixed.
          (readonly ? '' : '<th scope="col"><span class="visually-hidden">Actions</span></th>') +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table></div>' + renderFoundationStop(facts)
      + (adding ? renderFoundationsInit(facts) : '');
  // ── THE BUDGET WARNING — A COST, SO IT NEVER FOLDS ────────────────────
  // Emitted always and `hidden` when there is nothing to say, because
  // `toggleReadFirst` patches it in place rather than re-rendering: a node
  // that has to be CREATED on a tick is a node that tick has to render for.
  const budgetSentence = foundationsBudgetWarning(facts);
  // ── AND IT GAINS SOMETHING TO DO ABOUT IT (v3.65.0, record §D.6) ──────
  // It named a consequence and offered nothing. The maintainer's own project
  // mirrors 24 documents at 1,980 KB against a 200 KB budget, so this is the
  // sentence he reads every time he opens the screen — correct, and inert.
  //
  // "Choose documents" is a DOOR, not a second write path: it opens the
  // documents row (through the same transient force the editor uses, never
  // the persisted key, so a close stays closed) and puts the reader in front
  // of the `read first` column, whose per-row tick is v3.62.0's shipped
  // `PATCH …/foundations/:slug {readFirst}` — manifest-only, both ownerships.
  // No new route, no new write.
  const budgetNote = '<div class="tx-note mem-fnd-budget" id="mem-fnd-budget"'
    + (budgetSentence ? '' : ' hidden') + '>' + icon('alertTriangle', 13)
    + '<span>' + escapeHtml(budgetSentence) + '</span>'
    + '<button type="button" class="btn btn-secondary btn-xs mem-fnd-budget-go" '
      + 'id="mem-fnd-budget-go">Choose documents</button>'
    + '</div>';
  // ── `open` COMES FROM TWO PLACES AND ONLY TWO (v3.64.1) ────────────────
  // The user's remembered preference, and the transient set by the press that
  // opened an editor. NOT from `editing`/`adding` themselves: a state derived
  // from the editor's PRESENCE is re-derived on every paint, so it cannot be
  // overruled — and the toggle listener then writes the un-overrulable value
  // back as if the user had chosen it. An explicit close clears the transient
  // (see wire()'s toggle listener), which is what makes a close final while
  // the editor is still on screen. The brief's twin expression above has
  // always read from one field alone; this one now does too.
  const open = (state.fndForceOpen === true
    || (state.openFolds && state.openFolds.foundations)) ? ' open' : '';
  // ── THE CONTROLS ARE A HEAD ROW, ABOVE THE ROWS (v3.65.1) ─────────────
  // Wiki health's `.dm-health-top` anatomy, which is the one shipped instance
  // of the pattern and the model the maintainer named: a section's controls sit
  // BENEATH the heading and ABOVE the rows, left-aligned at the rows' own x.
  // Through v3.65.0 this row was the LAST child of `.mem-fnd-row` — measured at
  // 1370, the two controls sat at y=511, below a fold whose summary was at
  // y=479 — so the only section on this page with controls put them where
  // nothing else on the page puts them. Same class, same markup, one position.
  // ── AND THE COST GOES UNDER THE ROW, STILL UNFOLDED (v3.65.1) ─────────
  // It was emitted BEFORE the row, which put it between the step's heading and
  // the section's controls — the one place on this page where a sentence sits
  // under a heading, which is what the head-row rule exists to stop. It is a
  // SIBLING of the fold, not a child of it: v3.16.1's rule is that a cost may
  // never sit behind a chevron, so it stays outside the `<details>` and is read
  // whether the documents are open or not. What changed is its position among
  // the section's siblings, and nothing else — `toggleReadFirst` still patches
  // `#mem-fnd-budget` in place by id.
  return '<div class="mem-fnd-row">' +
      '<div class="mem-fnd-head-controls">' + action + '</div>' +
      '<details class="mem-fold" data-mem-fold="foundations"' + open + '>' +
        summary +
        '<div class="mem-fold-body">' + body + '</div>' +
      '</details>' +
    '</div>' + budgetNote + askBtn.panel + withheld;
}

/**
 * "COPY THE DRAFTING REQUEST" — the third member of the copy family (P2-8).
 *
 * ── THE GAP IT CLOSES ───────────────────────────────────────────────────
 * A curator-owned project with four skeletons is a project with four questions
 * and no obvious way to get them answered. The owner can write them by hand
 * (the editor, one block down) or tell an agent to — and the second needs a
 * sentence naming the tool, the project and the approval gate, which a user
 * who has to compose it usually does not.
 *
 * ── WHERE THE TEXT LIVES, AND WHY NOT HERE ──────────────────────────────
 * `composeDraftingAsk` in shared/agent-instructions.js, sha-pinned beside its
 * three siblings. It is MODEL-READ instruction text, and a second copy of
 * model-read text is this repository's most reliably recurring defect —
 * scripts/test-agent-instructions.js §S9 scans this file for its sentences and
 * fails on one. So this function composes, never writes; and the documents it
 * names are the project's REAL unfilled slugs, so an owner with three
 * skeletons does not paste a sentence asking for four.
 *
 * ── AND WHY IT IS NOT IN `composeAgentInstructionsFull` ─────────────────
 * That output is pasted into CLAUDE.md, which an agent re-reads every session.
 * "Draft these now" belongs in a chat message once, not in a standing
 * instruction that would ask for a re-draft for ever.
 *
 * ── THE STATES ──────────────────────────────────────────────────────────
 * Offered on every curator-owned state including zero documents (where it is
 * the most useful control on the screen) and on all-written (asking for a
 * rewrite is legitimate). WITHHELD with its reason on a mirror — an agent's
 * `save_foundation` there is refused as an ownership mismatch — and withheld
 * silently under the mirror note on a read-only Shared Brain domain, which
 * already carries one sentence saying nothing here may be written.
 */
function foundationsDraftAsk(facts, readonly) {
  if (readonly) return { btn: '', panel: '' };
  if (!facts.present) return { btn: '', panel: '' };
  if (facts.manifestError) return { btn: '', panel: '' };
  if (facts.ownership !== 'curator') {
    // ── IT LEAVES THE STEP BODY (v3.65.0) ──────────────────────────────
    // The maintainer, pointing at it: *"then we have some clarification below
    // — 'an agent's save here is refused, this project is mirrored from a
    // folder' and the clock — I don't know why this is here, is this a static
    // message or something that changes."* It is STATIC: a standing fact
    // about this project's ownership, which never changes, because ownership
    // is set once and refused afterwards. A standing fact is not an outcome,
    // so v3.16.1 does not hold it on the page — the full sentence is a
    // paragraph of step ①'s ⓘ, and the row's own summary already reads
    // `mirrored`, which is the one-word form of it.
    return { btn: '', panel: '' };
  }
  const info = renderInfoMark('mem-fnd-ask-info', 'About the drafting request',
    DRAFT_ASK_INFO_HTML, { html: true });
  return {
    btn: '<button type="button" class="btn btn-ghost btn-xs" id="mem-fnd-ask">' +
      'Copy the drafting request</button>' + info.btn,
    panel: info.panel,
  };
}

// ── THE ⓘ BESIDE IT ──────────────────────────────────────────────────────
// Definition, then mechanism, then what is and is not saved — the order this
// app's ⓘ panels follow. A module constant so the suite can lift the words a
// user reads rather than asserting a copy typed in a test, and every character
// of it is written here, so nothing user- or store-supplied is interpolated
// into a fragment that is emitted as HTML.
//
// THE PRIVACY CLAIM IS THE POINT OF THE SECOND PARAGRAPH. The drafting model
// is the HARNESS'S, because the harness has the code and The Curator does not:
// it holds markdown under one folder and has no checkout, no build and no
// repository access. Saying so is what stops a reader assuming this button
// sends their codebase somewhere.
const DRAFT_ASK_INFO_HTML =
  '<p><strong>What it copies.</strong> One sentence for your agent, naming this project ' +
  'and the <code>save_foundation</code> tool. Paste it into any assistant that has the ' +
  'my-curator bridge installed — Claude Code, Claude Desktop, Cursor.</p>' +
  '<p><strong>Your agent’s own model does the drafting</strong>, from the code and documents it ' +
  'can see. The Curator sends nothing to a model for this and has no access to your code; it ' +
  'only stores what comes back.</p>' +
  '<p><strong>Nothing is saved until you approve each document.</strong> The sentence asks the ' +
  'agent to show you first, and the tool refuses unless it is told the owner commissioned it.</p>';

/**
 * THE OWNERSHIP CHOICE, IN THE PLACE THE ANSWER IS MISSING.
 *
 * Two shapes, one renderer: a project with no manifest gets the full two-way
 * (plus nothing — "decide later" is the create form's third answer and is
 * meaningless here, because this screen IS the later), and a repo-owned
 * project with nothing mirrored gets the scan arm alone under a heading that
 * says what is being added rather than what is being decided.
 *
 * ── WHAT IS A LEDE AND WHAT IS AN ⓘ HERE ────────────────────────────────
 * The sentence above the chooser is an INSTRUCTION at ten words. What a
 * canonical document IS, that the choice cannot be changed afterwards, and
 * that a plain folder with no git in it works perfectly well as a mirror
 * source are all DEFINITIONS or MECHANISM, and they are in the block's ⓘ —
 * which this function does not emit, because the block above it already has
 * one and a second mark beside it would be a second voice.
 */
function renderFoundationsInit(facts) {
  const ini = state.fndInit && state.fndInit.domain === state.activeDomain
    && state.fndInit.project === state.activeProject ? state.fndInit : null;
  const repoOnly = facts.ownership === 'repo';
  // ── SWITCHING THIS PROJECT'S SOURCE TO GITHUB (v3.65.1, D6) ────────────
  // A transient on the same stamped record every other state of this panel
  // rides, so a project switch drops it with the rest. It selects the GitHub
  // arm, changes the primary's word and the sentence above it, and routes the
  // commit at `POST …/foundations/source` instead of `…/foundations/init`.
  const switching = !!(ini && ini.switching);
  const choice = ini && ini.choice
    ? ini.choice
    // A FRESH CHOICE PAINTED FROM NOTHING, so the block renders its own first
    // frame without a click: `state.fndInit` is written by the first
    // interaction, and until then this is a pure function of the payload.
    : freshChooser({ allowLater: false });
  if (switching) choice.ownership = 'remote';
  else if (repoOnly) choice.ownership = 'repo';
  const busy = !!(ini && ini.busy);
  // ── AND ONE MORE CONDITION, WITH ITS REASON (v3.61.1) ──────────────────
  // A mirror that has been SCANNED and has nothing ticked would set the
  // ownership and copy no documents — `chooserBody` omits an empty `files`, so
  // the wire would carry a decision nobody made. `commitBlockedReason` is the
  // shared rule (it keys on `candidates` being a non-empty array, so pointing
  // at a folder WITHOUT scanning stays a complete answer), and the same call
  // decides both the disabled flag and the sentence under the button — one
  // predicate, so the control and its explanation cannot come apart.
  const blocked = commitBlockedReason(choice);
  const ready = (switching
    ? !!String(choice.remote || '').trim()
    : repoOnly
      ? !!String(choice.repoRoot || '').trim()
      : (choice.ownership === 'curator' || !!String(choice.repoRoot || '').trim())) && !blocked;

  return (
    // ── THE STATE'S OWN STACK, SO THE RHYTHM IS ONE RULE (v3.61.1) ───────
    // Measured before this: the "Set once" note and the card below it were
    // **0px** apart, and so were the card's question line and the option
    // cards under it. Both were the default — a `.tx-note` carries a top
    // margin and no bottom one, and a `<p>` in a block body carries neither —
    // so the gaps were nobody's decision. A flex column with one gap is the
    // fix rather than a margin per element, for the reason
    // design-system §2 gives the Settings block: a rhythm is a property of
    // the stack, and a margin on a child is a property of the child.
    //
    // The class also exists because the shared text kit's names are OFF
    // LIMITS to this stylesheet — scripts/test-next-text-system.js fails any
    // stylesheet but shared/text.css that declares a `tx-` rule — so
    // `.tx-note + .mem-fnd-row` could not have been written here even though
    // it is the obvious selector.
    '<div class="mem-fnd-init-wrap">' +
    // ── IRREVERSIBILITY NEVER FOLDS (§3.10) ──────────────────────────────
    // The store refuses a mismatch on every later write, so this choice is
    // made once. That is on the never-fold list: a cost, a refusal and an
    // outcome are read at the moment of acting, and a chevron is a decision to
    // read something later. The MECHANISM — what a mirror actually does, why a
    // plain folder with no git in it works — is in the block's ⓘ, which this
    // function does not emit, because a second mark beside the block's own
    // would be a second voice.
    (repoOnly ? ''
      : '<div class="tx-note">' + icon('alertCircle', 13) + '<span>' +
        escapeHtml('Set once — a project is mirrored or kept here, never both.') +
        '</span></div>') +
    // ── ONE BOX, AT THE ROWS' OWN WIDTH (v3.65.1) ────────────────────────
    // The maintainer, on the shipped v3.65.0 panel: *"a truly bad
    // implementation of the design"* — an inner box narrower than the card,
    // buttons at the right edge, placeholders cramped. Measured at 1370: the
    // panel sat 421→1314 inside a row that runs 405→1330, so THREE left edges
    // (405 / 421 / 436) and three right edges stacked inside one another, and
    // `.fnd-init-arm` carried `padding: 8px 0 8px 16px` — ZERO on the right
    // — so its controls ended flush against a visible tinted edge that itself
    // stopped 31px short of the row above.
    //
    // It takes Wiki health's QUICK MAINTENANCE anatomy instead, which is the
    // panel the maintainer called *"designed properly"*: ONE box at the rows'
    // own width, 14px on all four sides, an eyebrow row, a content stack and a
    // footnote. `.dm-quick`'s RULES are not copied here — a second copy of a
    // panel is the shape this release removes — `.mem-fnd-panel` declares the
    // same five properties with views/domains.css:753-759 named as the source
    // of the values, and promoting one kit panel is recorded for v3.66.0.
    '<div class="mem-fnd-panel">' +
      '<div class="mem-fnd-panel-eyebrow cur-group-title">' +
        escapeHtml(switching ? 'MIRROR FROM GITHUB'
          : repoOnly ? 'ADD FROM FOLDER' : 'SET UP DOCUMENTS') +
      '</div>' +
      '<div class="mem-fnd-init-body">' +
        // ── THE SENTENCE SPLITS ON THE COUNT (v3.65.1) ──────────────────
        // Through v3.65.0 the `repoOnly` arm said "Nothing mirrored yet" on
        // EVERY repo-owned project — including one mirroring three documents,
        // because this panel is also what the head control's "Add from folder"
        // opens. Measured on the maintainer's own fixture: 1 document, 116 KB,
        // and the panel said nothing was mirrored. Both arms ride the SAME
        // renderDescription call, so the tail stays byte-identical.
        renderDescription(switching
          ? 'Name the repository this project mirrors from now. The documents are re-copied '
            + 'from GitHub and the folder on this Mac stops being the source.'
          : repoOnly
            ? (facts.count
              ? 'Add more files from the folder this project mirrors.'
              : 'Nothing mirrored yet. Point at the folder and choose which files to copy.')
            : 'No canonical documents yet. Choose how they arrive.') +
        renderFoundationsChooser({
          id: 'mem-fnd-init', choice, busy, optionsHidden: repoOnly || switching,
          existingProject: true,
        }) +
        '<div class="mem-fnd-init-actions">' +
          // ── THE PRIMARY IS THE HOST'S DECISION (P2-6) ──────────────────
          // The shared chooser emits NO primary of its own, because the other
          // host — the "New project" form — already has one ("Create
          // project") and a card with two primaries has not decided what it is
          // asking for. Here the commit is this block's, so this block emits
          // it. The editor is never open at the same time (a project with no
          // documents has nothing to edit, and the moment it has one this
          // branch is gone), so "at most one primary per card" holds by
          // construction rather than by care.
          '<button type="button" class="btn btn-primary" id="mem-fnd-init-go"' +
            (busy || !ready ? ' disabled' : '') + '>' +
            escapeHtml(busy
              ? (switching ? 'Mirroring…' : repoOnly ? 'Copying…' : 'Setting up…')
              : (switching ? 'Mirror from GitHub'
                : repoOnly ? 'Add from folder' : 'Set up documents')) +
          '</button>' +
        '</div>' +
        // ── WHY THE COMMIT IS OFF (v3.61.1) ────────────────────────────
        // Emitted ALWAYS and merely `hidden`, because a tick does NOT
        // re-render this block any more — the chooser's binder hands the
        // reason back through `onSelect` and this node is patched in place.
        // A conditional emit would give the patch nothing to write into.
        // `.fnd-init-why` carries the `[hidden]` counter-rule `.tx-note`
        // needs (design-system §9).
        '<div class="tx-note fnd-init-why" id="mem-fnd-init-why"' +
          (blocked ? '' : ' hidden') + '>' +
          '<span>' + escapeHtml(blocked) + '</span>' +
        '</div>' +
        // ── WHAT THE SWITCH COSTS, UNFOLDED (v3.16.1) ──────────────────
        // A consequence, so it is on screen at the moment of acting rather
        // than behind the block's ⓘ. Nothing is written until every blob is
        // in hand — the store's remote arm fetches the whole tree first —
        // so a failed switch leaves the mirror exactly as it was.
        (switching
          ? '<div class="tx-note mem-fnd-switch-note">' + icon('alertCircle', 13) + '<span>' +
            escapeHtml('The folder on this Mac stops being this project’s source. Nothing is '
              + 'written unless every document is read, and "read first" is kept by name.') +
            '</span></div>'
          : '') +
      '</div>' +
    '</div>'
  );
}

/**
 * ONE DOCUMENT, OPEN FOR EDITING.
 *
 * ── THE FOUR CONFIRMS, AND WHY NONE OF THEM IS A MODAL ──────────────────
 * The unsaved-draft bar, the shrink strip and the delete strip are all IN
 * FLOW, under the field, for the reason the standing brief's own bar records:
 * the text under discussion has to stay on screen while the owner decides
 * whether to lose it. A dialog would cover it.
 *
 * ── WHAT IS NEVER FOLDED (v3.16.1, and this file's header) ──────────────
 * The 512 KB wall, the project-budget disclosure, every refusal and every
 * confirm. All four are painted in the editor's own flow, and the wall is
 * emitted ALWAYS and merely `hidden`, because the input handler flips it
 * WITHOUT a render — a render here would rebuild the textarea and take the
 * caret and the selection with it (the brief editor's own rule, and
 * views/domains.js's lifecycle form before it).
 *
 * ── THE WALL IS A WALL; THE BUDGET IS A DISCLOSURE ──────────────────────
 * D6, and the asymmetry is the store's rather than a choice made here: a
 * document over `MAX_FOUNDATION_BYTES` is REFUSED with the size named,
 * because a verbatim document cannot be trimmed honestly, so Save is disabled
 * before the request. The 200 KB project budget is ACCEPTED and disclosed —
 * so this screen must NOT refuse what the store accepts, and says the figure
 * instead.
 */
function renderFoundationEditor(facts) {
  const e = state.fndEdit;
  if (!e) return '';
  if (e.loading) {
    return '<div class="mem-fnd-editor" aria-busy="true">' +
      renderDescription('Reading the document…') + '</div>';
  }
  const stats = fndStats(e.text || '');
  const dirty = (e.text || '') !== (e.loaded || '');
  const taken = e.isNew ? facts.docs.map((d) => String(d.slug || '')) : [];
  const slugErr = e.isNew ? fndSlugError(e.slug, taken) : null;
  const shrink = fndShrinkWarn(e);
  const role = FOUNDATION_ROLES.includes(e.role) ? e.role : 'other';

  // ── THE HEADING ───────────────────────────────────────────────────────
  // The document's own title with its role beside it, so the owner can see at
  // a glance WHICH of six documents is in the box. On "Add" there is no title
  // yet, so the heading says what is being done instead of quoting an empty
  // field back at them.
  const head =
    '<div class="mem-fnd-editor-head">' +
      '<span class="mem-fnd-editor-title">' +
        escapeHtml(e.isNew ? 'New document' : (e.title || e.slug || 'Document')) + '</span>' +
      '<span class="fnd-role">' + escapeHtml(role) + '</span>' +
    '</div>';

  // The slug, the title and the role are asked for ONLY on "Add": an existing
  // document's file name is the file's own name, and a rename is a delete plus
  // a create — which neither the store nor this editor pretends otherwise
  // about. The TITLE and the ROLE of an existing document ARE editable,
  // because both are manifest fields the PUT carries.
  const fields =
    (e.isNew
      ? '<label class="mem-fnd-label cur-eyebrow" for="mem-fnd-slug">File name</label>' +
        '<input class="mem-fnd-input" id="mem-fnd-slug" type="text" autocomplete="off"' +
          ' spellcheck="false" placeholder="architecture.md" value="' + escapeHtml(e.slug || '') + '"' +
          (e.busy ? ' disabled' : '') + ' />' +
        (slugErr
          ? '<div class="mem-note mem-note-loud">' + icon('alertTriangle', 13) +
            '<span>' + escapeHtml(slugErr) + '</span></div>'
          : '')
      : '') +
    '<label class="mem-fnd-label cur-eyebrow" for="mem-fnd-title">Title</label>' +
    '<input class="mem-fnd-input" id="mem-fnd-title" type="text" autocomplete="off"' +
      ' placeholder="Architecture" value="' + escapeHtml(e.title || '') + '"' +
      (e.busy ? ' disabled' : '') + ' />' +
    '<div class="mem-fnd-label cur-eyebrow">Role</div>' +
    renderRoleOptions({ value: role, hook: 'fnd-edit-role', disabled: !!e.busy,
      label: 'Role for this document' });

  // ── FILES FROM DISK (D18) ─────────────────────────────────────────────
  // Offered on "Add" only, and the text lands in the FIELD rather than on the
  // server: the owner sees exactly what will be saved before anything is
  // written, and the save is the ordinary PUT. Nothing is uploaded.
  // ── A REAL BUTTON, AND AN INPUT THAT IS `hidden` (P1-7) ───────────────
  // A `.visually-hidden` input inside a `<label class="btn">` is focusable
  // while the thing that looks like a button is not, so keyboard focus lands
  // on something invisible and `--ring-focus` never paints. The app's shipped
  // pattern — a `hidden` input plus a `<button>` that clicks it — is reused,
  // and the button is in FOCUSABLE_IDS.
  //
  // ── AND THE OWNER'S WAY IN COMES FIRST (P1-12) ────────────────────────
  // The sentence leads with the box, not with the file: for the person who
  // started a project here with no agent and no repository, writing it is the
  // primary way in, and the order of two equal-looking affordances is the only
  // thing on screen that says so.
  const picker = e.isNew
    ? '<div class="mem-fnd-pick">' +
        '<span class="fnd-init-file-hint">Write the document in the box below — or start from a ' +
          'file on this computer, read here and dropped into the box. Nothing is sent until you ' +
          'save.</span>' +
        '<input type="file" id="mem-fnd-file" accept=".md,.txt,text/markdown,text/plain" hidden' +
          (e.busy ? ' disabled' : '') + ' />' +
        '<button type="button" class="btn btn-secondary btn-xs fnd-init-file" id="mem-fnd-file-btn"' +
          (e.busy ? ' disabled' : '') + '>Choose a file…</button>' +
      '</div>' +
      (e.importError
        ? '<div class="mem-note mem-note-loud">' + icon('alertTriangle', 13) +
          '<span>' + escapeHtml(e.importError) + '</span></div>'
        : '')
    : '';

  // ── THE COUNTER, THE WALL AND THE BUDGET ──────────────────────────────
  const budget = facts.budgetBytes;
  const projected = Math.max(0, facts.bytes -
    (e.isNew ? 0 : new TextEncoder().encode(String(e.loaded || '')).length)) + stats.bytes;
  const statusLine =
    '<div class="mem-brief-stats' + (stats.over ? ' mem-brief-stats-over' : '') + '" id="mem-fnd-stats">' +
      '<span data-fnd-stat="dirty">' + (dirty ? 'modified' : 'unchanged') + '</span>' +
      '<span data-fnd-stat="words">' + escapeHtml(String(stats.words)) +
        ' word' + (stats.words === 1 ? '' : 's') + '</span>' +
      '<span data-fnd-stat="bytes">' + escapeHtml(String(stats.bytes)) + ' of ' +
        escapeHtml(String(MAX_FOUNDATION_BYTES)) + ' bytes</span>' +
    '</div>' +
    '<div class="mem-note mem-note-loud" id="mem-fnd-over"' + (stats.over ? '' : ' hidden') + '>' +
      icon('alertTriangle', 13) +
      '<span><b>Too long to save.</b> A single document is capped at ' +
      escapeHtml(String(MAX_FOUNDATION_BYTES)) + ' bytes (' +
      escapeHtml(formatBytes(MAX_FOUNDATION_BYTES)) + ') — this draft is ' +
      escapeHtml(String(stats.bytes)) + '. A canonical document cannot be trimmed for you, so ' +
      'split it or point at the part that matters.</span></div>' +
    // THE BUDGET IS SAID, NEVER ENFORCED. The store accepts the save and
    // discloses the overrun; refusing here would be the app standing between
    // the owner and a write the server would have taken.
    (projected > budget
      ? '<div class="mem-note">' + icon('alertCircle', 13) +
        '<span>Saving this takes the project to about ' + escapeHtml(formatBytes(projected)) +
        ' of canonical documents, over the ' + escapeHtml(formatBytes(budget)) +
        ' an agent reads in one call. It will still be saved — the read is what gets ' +
        'trimmed, oldest-listed last.</span></div>'
      : '');

  const discardBar = e.confirmDiscard
    ? '<div class="mem-brief-discard" role="alertdialog" aria-label="Unsaved changes">' +
        '<span>You have unsaved changes to this document.</span>' +
        '<button type="button" class="btn btn-ghost btn-xs" id="mem-fnd-discard">Discard</button>' +
        '<button type="button" class="btn btn-secondary btn-xs" id="mem-fnd-keep">Keep editing</button>' +
      '</div>'
    : '';

  // ── THE SHRINK CONFIRM (D5) ───────────────────────────────────────────
  // Raised by the SAVE press, never by a timer and never by the poll, and it
  // names both sizes: the store's own 10 % guard is bypassed by the route
  // (`replace: true`), because "pass replace: true" is not advice a person in
  // a browser can act on — so the question is asked here, where both figures
  // are in hand and a sentence can carry them.
  // ── EXACTLY ONE PRIMARY, AND IT IS ALWAYS THE CONTROL THAT COMMITS
  //    (P1-6) ──────────────────────────────────────────────────────────────
  // The first cut left Save in place beside this strip, which gives the card
  // either two primaries or a DISABLED primary sitting next to a live
  // secondary that actually writes — the tier-1 slot lying about itself. So
  // the strip's own confirm takes `btn-primary` and Save is WITHHELD while the
  // strip is up (not disabled: a disabled control still claims the slot).
  const shrinking = !!(e.confirmShrink && shrink);
  const shrinkBar = shrinking
    ? '<div class="mem-brief-discard" role="alertdialog" aria-label="Much shorter than before">' +
        '<span>Unsaved: this draft is ' +
        escapeHtml(String(Math.round((1 - shrink.after / shrink.before) * 100))) + ' % shorter — ' +
        escapeHtml(formatBytes(shrink.after)) + ', from the ' +
        escapeHtml(formatBytes(shrink.before)) + ' on disk. Saving replaces it.</span>' +
        '<button type="button" class="btn btn-primary btn-xs" id="mem-fnd-shrink-go">' +
          'Replace with the shorter version</button>' +
        '<button type="button" class="btn btn-ghost btn-xs" id="mem-fnd-shrink-no">Keep editing</button>' +
      '</div>'
    : '';

  // ── DELETE, NAMED, BEHIND A CONFIRM STRIP ─────────────────────────────
  // A ghost control in the footer rather than beside Save: it destroys a
  // document and must not sit where the commit is. The strip NAMES the
  // document, because "are you sure?" over six rows is a question about none
  // of them, and the request carries the slug as its own confirmation so a
  // client that skipped the strip still deletes nothing.
  const deleteBar = e.confirmDelete
    ? '<div class="mem-fnd-delete-bar" role="alertdialog" aria-label="Delete this document">' +
        // NOT "are you sure?" — the document is NAMED, because a question
        // about six rows is a question about none of them. And it says what
        // recovery there is: "cannot be undone" alone is false for a user with
        // Personal Sync configured and true for everyone else, so both halves
        // are stated rather than one of them guessed at.
        '<span>Delete <b>' + escapeHtml(e.slug || '') + '</b>? The document is removed from this ' +
        'project and from your agents’ next session. It cannot be undone from inside The ' +
        'Curator; if you sync, a git client can still recover it.</span>' +
        // ── THE ONE SANCTIONED USE OF THE FILLED DANGER FACE (P1-5) ─────
        // `.btn-danger-solid` is reserved by the taxonomy for a confirm whose
        // PRIMARY ACTION IS THE DELETION, which is exactly this strip: the
        // question has been asked, the document is named, and this is the
        // control that answers yes. The opener in the footer stays tinted.
        // Never a hand-built colour override — `domains.js`'s surviving
        // `.dm-delete-btn { color: var(--danger-text) }` is the last of that
        // pattern and this release does not extend it.
        '<button type="button" class="btn btn-danger-solid btn-xs" id="mem-fnd-delete-go"' +
          (e.deleting ? ' disabled' : '') + '>' +
          escapeHtml(e.deleting ? 'Deleting…' : 'Delete permanently') + '</button>' +
        '<button type="button" class="btn btn-ghost btn-xs" id="mem-fnd-delete-no"' +
          (e.deleting ? ' disabled' : '') + '>Keep it</button>' +
      '</div>'
    : '';

  const field = e.preview
    ? '<div class="mem-doc mem-brief-preview" aria-label="Document preview">' +
        renderMarkdown(e.text || '') + '</div>'
    : '<textarea class="mem-fnd-text" id="mem-fnd-text" rows="20" spellcheck="true"' +
        (e.busy ? ' disabled' : '') + '>' + escapeHtml(e.text || '') + '</textarea>';

  return (
    '<div class="mem-fnd-editor">' +
      (e.error ? renderStatus({ state: 'danger', title: 'Not saved', detail: e.error }) : '') +
      head +
      fields +
      picker +
      '<label class="mem-fnd-label cur-eyebrow" for="mem-fnd-text">Document (Markdown, saved verbatim)</label>' +
      field +
      statusLine +
      discardBar +
      shrinkBar +
      '<div class="mem-brief-buttons">' +
        // WITHHELD, NOT DISABLED, while the shrink strip is up (P1-6).
        (shrinking ? ''
          : '<button type="button" class="btn btn-primary" id="mem-fnd-save"' +
            (e.busy || stats.over || !!slugErr || !!e.confirmDelete ? ' disabled' : '') + '>' +
            escapeHtml(e.busy ? 'Saving…' : (e.isNew ? 'Save document' : 'Save changes')) + '</button>') +
        '<button type="button" class="btn btn-secondary btn-xs" id="mem-fnd-preview"' +
          (e.busy ? ' disabled' : '') + '>' +
          (e.preview ? 'Back to editing' : 'Preview') + '</button>' +
        '<button type="button" class="btn btn-ghost" id="mem-fnd-cancel"' +
          (e.busy ? ' disabled' : '') + '>Cancel</button>' +
        // ── THE OPENER IS `btn-danger`, NOT `btn-ghost` (P1-5) ──────────
        // The taxonomy is explicit: `.btn-danger` = DESTROYS DATA. A ghost
        // face on the one control in this editor that removes a document
        // makes it read as quiet-and-harmless, which is the opposite of what
        // it is. Tinted, never filled — the filled face belongs to the
        // confirm below.
        (e.isNew ? '' :
          '<button type="button" class="btn btn-danger btn-xs mem-fnd-delete" id="mem-fnd-delete"' +
            (e.busy || e.confirmDelete ? ' disabled' : '') + '>Delete…</button>') +
      '</div>' +
      deleteBar +
      // ONE SENTENCE, AND IT IS THE ONE ABOUT THE WRITE. Not a definition —
      // a condition on the button above it, whose consequence if missed is an
      // owner sending a fragment and losing the rest of their own document.
      // The brief editor carries the same sentence for the same reason, and
      // this file's header states that a warning never folds.
      renderDescription('Saving replaces the whole document, byte for byte — send the complete '
        + 'text, not an addition.') +
    '</div>'
  );
}

// ── `renderFoundationsStatus` IS GONE (v3.62.0) ──────────────────────────
// It was the Status block's one line about tier 0 — `4 documents · fresh` on
// the shared readout — and the Status block is REPLACED by the three-cell
// strip, whose cell ① is that same reading with the app's freshness dot beside
// it. The old line could not carry the dot at all: `renderReadout` escaped its
// value until v3.62.0's one kit change added `markHtml`, which is why the
// shipped line was the only figure on this page with no mark.
//
// One behaviour changed with the move and it is deliberate. The line was
// SILENT on a project with no documents ("a dash in the status strip is noise
// on every project that has not adopted the tier") — right for a line inside a
// four-line block, wrong for one of three readings the page exists to give: a
// missing cell is a fourth thing to wonder about. `renderLayerStrip` says
// "not set up yet" and "no documents yet" instead, which are different states
// and now read differently.
//
// Deleted rather than left calling nothing: a renderer nothing calls is the
// same claim about the screen that a CSS rule nothing can match is.

/**
 * FLIP ONE DOCUMENT'S "read first" FLAG, IN PLACE.
 *
 * ── WHY THIS IS A PATCH AND NOT A RENDER (v3.61.1's rule) ───────────────
 * Measured on this very table one release ago: a tick that re-rendered took
 * the fold's `scrollTop` from 1105 to 0, came back as a different node and
 * dropped focus. A person deciding which of twenty documents an agent should
 * read first ticks several in a row, and each tick throwing them to the top is
 * the defect that rule exists to prevent. So this writes the pressed row's own
 * label and state, the summary line's counts, and the block's budget warning —
 * every node checked before it is touched, and nothing else on the page.
 *
 * ── THE STATE IS UPDATED FROM THE ANSWER, NEVER FROM THE GUESS ─────────
 * `state.projectRead` is mutated with what the route REPORTS (`readFirst`, and
 * the five readings), not with what the click intended. The two agree on a
 * success and only the answer is true on a refusal — and the next poll's
 * `screenSignature` must describe what is painted, so it is re-taken here.
 *
 * ── A REFUSAL IS A DISCLOSURE, and it is unfolded ──────────────────────
 * The route answers 400 `no_manifest` before init and 404 for a slug the
 * manifest does not hold. Either way the flag on screen is put BACK where it
 * was and the reason is rendered — a control that silently did nothing is the
 * one outcome a toggle may not have.
 */
async function toggleReadFirst(btn, token) {
  if (!btn || !btn.dataset) return;
  const slug = btn.dataset.fndFirst;
  const domain = state.activeDomain;
  const project = state.activeProject;
  if (!slug || !domain || !project) return;
  const want = btn.getAttribute('aria-pressed') !== 'true';
  // Optimistic on the one node the finger is on, because the round trip is
  // local and a control that waits 30ms to acknowledge a press reads as broken
  // (v3.27.0). Everything else waits for the answer.
  btn.disabled = true;
  let out = null;
  let error = null;
  try {
    const res = await fetch('/api/memory/' + encodeURIComponent(domain) + '/'
      + encodeURIComponent(project) + '/foundations/' + encodeURIComponent(slug), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ readFirst: want }),
    });
    const data = await res.json();
    if (res.ok && data && data.ok) out = data; else error = (data && data.error) || ('HTTP ' + res.status);
  } catch (err) {
    error = err.message;
  }
  if (!isCurrentMount(token)) return;
  // STAMPED AT THE POINT OF USE, like every other async result on this screen:
  // an answer for a project the user has left must not touch this one's rows.
  if (state.activeDomain !== domain || state.activeProject !== project) return;
  if (typeof document === 'undefined') return;
  btn.disabled = false;

  if (error) {
    state.fnd = { domain, project, busy: false, error, result: null };
    render(token);
    return;
  }

  // ── ONE ROW, ONE SUMMARY LINE, ONE WARNING ─────────────────────────────
  const now = out.readFirst === true;
  btn.setAttribute('aria-pressed', now ? 'true' : 'false');
  btn.textContent = now ? 'read first' : 'on request';
  if (btn.classList) btn.classList.toggle('fnd-first-on', now);

  const f = state.projectRead && state.projectRead.foundations;
  if (f && Array.isArray(f.documents)) {
    const row = f.documents.find((d) => d && d.slug === slug);
    if (row) row.readFirst = now;
    // The five readings come off the ANSWER rather than being recomputed here:
    // the store takes them before any cap of its own, and a second derivation
    // is a second thing that can disagree with the table.
    f.readFirstCount = out.readFirstCount;
    f.onRequestCount = out.onRequestCount;
    f.readFirstBytes = out.readFirstBytes;
    f.readFirstBudgetBytes = out.readFirstBudgetBytes;
    f.readFirstBudgetExceeded = out.readFirstBudgetExceeded;
  }
  const facts = foundationsFacts(state.projectRead);
  const meta = document.querySelector('#mem-fold-foundations .mem-fold-meta');
  if (meta) meta.textContent = foundationsSummaryMeta(facts);
  const warn = document.getElementById('mem-fnd-budget');
  if (warn) {
    const sentence = foundationsBudgetWarning(facts);
    const span = warn.querySelector ? warn.querySelector('span') : null;
    if (span) span.textContent = sentence;
    warn.hidden = !sentence;
  }
  // The signature must always describe what is PAINTED: leaving it stale would
  // make the next poll either repaint needlessly or skip a repaint it owed.
  renderedSignature = screenSignature();
}

/**
 * THE READER PAYLOAD FOR ONE DOCUMENT.
 *
 * Same shape as `handoffReaderContent` and for the same reasons — including
 * the deliberate absence of `domain`, which would switch on the reader's
 * raw-source bar and buy a request that can only answer "no".
 *
 * `readonly: true` ALWAYS, on both ownership modes — and STILL true now that
 * a curator-owned document IS editable, because the READER is not where it is
 * edited (D2): it patches `.reader-body.innerHTML` without rebinding and has
 * no dirty guard, so a field inside it would lose its listeners on the next
 * patch and its draft on the next Escape. The editor lives in the Foundations
 * table, and the note below says so.
 *
 * ── THE NOTE THE READER PAINTED WAS WRONG ON EVERY FOUNDATION ───────────
 * `readonly: true` made app.js print "Read-only Shared Brain mirror" — a
 * sentence about a completely different feature, on a document that is
 * usually neither shared nor a mirror. The flag stays; the COPY is now the
 * payload's, through `readonlyNote`, and app.js falls back to the Shared Brain
 * sentence byte-for-byte when a caller sends none. So the two ownerships each
 * say what is true of them, and no other caller of `openReader` changes.
 *
 * The body goes through `renderMarkdown`, which escapes the whole string
 * before emitting any markup. These bytes arrive over sync from other machines
 * and, in a shared mirror, from other people; the escaping duty is here.
 */
function foundationReaderContent(doc, project) {
  if (!doc || !doc.slug) return null;
  const slug = String(doc.slug);
  const readout = doc.updatedAt
    ? renderReadout({
      label: 'Updated',
      value: formatAge(Math.max(0, Math.round((Date.now() - Date.parse(doc.updatedAt)) / 1000)))
        || doc.updatedAt,
      provenance: doc.commit ? 'commit ' + String(doc.commit).slice(0, 7) : undefined,
    })
    : '';
  const meta = readout
    ? '<div class="mem-reader-meta"' +
      ' data-mem-age-at="' + escapeHtml(doc.updatedAt) + '">' + readout + '</div>'
    : '';
  // ── OWNERSHIP, FROM THE FIELD THE ROUTE ACTUALLY SENDS ──────────────────
  // `ownership` is a property of the MANIFEST and the single-document route
  // does not send it; `source.kind` is the per-document fact it does. Reading
  // `doc.ownership` alone made every curator-owned document in the app print
  // the MIRROR sentence — found in the browser, and invisible offline because
  // a hand-written payload carries the field the server never sends. An
  // explicit `ownership` still wins where a build provides one, so the two
  // payload shapes cannot resolve to two different answers.
  const curatorOwned = doc.ownership
    ? doc.ownership === 'curator'
    : !(doc.source && doc.source.kind === 'repo');
  const notes = [];
  if (doc.freshness === 'stale') {
    notes.push('This copy no longer matches the file it was copied from. Refresh from the '
      + 'folder to bring it up to date — what is below is what your agents currently read.');
  }
  if (doc.freshness === 'unreachable') {
    notes.push('The folder this was copied from is not on this computer, so the copy could '
      + 'not be compared against it. It may or may not still match.');
  }
  if (doc.truncated) {
    notes.push('This document was longer than the read budget — the tail is not shown.');
  }
  if (doc.sanitisedOnRead) {
    notes.push('Protocol-shaped text in this file was neutralised on read. The words are '
      + 'unchanged; only their markup is.');
  }
  // ── A SKELETON SAYS SO IN THE READER (P2-4) ──────────────────────────
  // The most consequential note on this panel: the body below is a set of
  // QUESTIONS, and a reader who takes the prompts for facts has been misled by
  // the one surface tier 0 exists to make trustworthy. From the FLAG, never
  // from matching the banner's own sentence (P1-2).
  if (skeletonOf(doc)) {
    notes.push('A skeleton — the prompts below are questions, not facts.');
  }
  const noteHtml = notes.map((n) =>
    '<div class="mem-note">' + icon('alertTriangle', 13) + '<span>' + escapeHtml(n) + '</span></div>').join('');
  return {
    slug: 'state/' + String(project || '') + '/foundations/' + slug,
    title: doc.title || slug,
    type: 'memory',
    typeLabel: 'foundation',
    // ROLE · SOURCE · COMMIT · OWNERSHIP, in that order — what the document
    // IS, where it came from, which version of there, and who is allowed to
    // change it. Every one of them qualifies the text rather than decorating
    // it, which is the rule this app's reader chips follow.
    tags: [
      doc.role ? 'role: ' + doc.role : null,
      doc.source && doc.source.kind === 'repo' && doc.source.path
        ? 'source: ' + doc.source.path : 'written for this project',
      doc.commit ? 'commit ' + String(doc.commit).slice(0, 7) : null,
      curatorOwned ? 'Curator-authored' : 'mirrored from a folder',
      // THE FIFTH FACT OF THE SAME KIND (P2-4). role · source · commit ·
      // ownership already qualify the text rather than decorating it, and
      // whether it has been WRITTEN is the same kind of fact — arguably the
      // one that most changes how the body should be read.
      skeletonOf(doc) ? 'skeleton' : null,
      doc.freshness === 'stale' ? 'out of date' : null,
      doc.freshness === 'unreachable' ? 'source not on this computer' : null,
    ].filter(Boolean),
    readonly: true,
    // WHICH WRITER OWNS THIS FILE, in one sentence, where the read-only mark
    // is. A mirrored document belongs to its repository and is changed THERE;
    // a curator-owned one is the owner's and is changed in the table this
    // reader was opened from. Either way the answer is "not here", which is
    // what `readonly` says — but "not here, and there instead" is the half a
    // person actually needs.
    readonlyNote: curatorOwned
      ? 'Edit this in the Documents table behind this panel.'
      : 'Mirrored from the folder — edit it there, then refresh.',
    bodyHtml: meta + noteHtml + '<div class="mem-reader-doc">' +
      renderMarkdown(typeof doc.text === 'string' ? doc.text : '') + '</div>',
    backlinks: [],
    returnFocusTo: 'mem-fnd-' + slug.replace(/[^a-z0-9]+/gi, '-'),
  };
}

/**
 * A ROW PRESS: fetch the document and open it in the shell's reader.
 *
 * ── NO MAIN-COLUMN REPAINT, EVER ────────────────────────────────────────
 * Nothing here writes a field `render()` paints. The reader opens LOADING in
 * the frame the press happened in (v3.27.0's finding: a press that is
 * acknowledged a round trip later reads as a press that did nothing), the
 * document replaces it when it lands, and the page behind is untouched. That
 * is only possible because a foundation row carries its own stable id — see
 * `fndRowHtml` — so there is no "which row is open" state to record.
 *
 * `isCurrentReader(epoch)` is the guard `openReader` owes: a user who presses
 * Escape while the fetch is in flight must not have the document reopened on
 * top of whatever they went back to. `isCurrentMount(token)` answers the other
 * question — did they leave the view entirely — and both are asked.
 */
async function openFoundation(slug, token) {
  const domain = state.activeDomain;
  const project = state.activeProject;
  if (!domain || !project || !slug) return;
  const epoch = openReader({
    slug: 'state/' + project + '/foundations/' + slug,
    title: slug,
    loading: true,
    returnFocusTo: 'mem-fnd-' + String(slug).replace(/[^a-z0-9]+/gi, '-'),
  }, token);

  let data = null;
  let error = null;
  try {
    const res = await fetch('/api/memory/' + encodeURIComponent(domain) + '/' +
      encodeURIComponent(project) + '/foundations/' + encodeURIComponent(slug));
    const body = await res.json();
    if (!res.ok || !body.ok) error = body.error || body.message || ('HTTP ' + res.status);
    else data = body;
  } catch (err) {
    error = err.message;
  }
  if (!isCurrentMount(token)) return;
  if (!isCurrentReader(epoch)) return;

  const content = data ? foundationReaderContent(data, project) : null;
  if (content) openReader(content, token);
  else {
    openReader({
      slug: 'state/' + project + '/foundations/' + slug,
      title: slug,
      error: error || 'That document could not be read.',
    }, token);
  }
}

/**
 * RE-COPY THE MIRROR, then show what changed.
 *
 * ── BUSY IS PAINTED, SUCCESS REPAINTS ONCE ──────────────────────────────
 * One render to disable the control and say it is working, then — on success —
 * exactly one more, carrying BOTH the outcome note and the re-read index. The
 * shape refused here is the obvious one: render the outcome, then reload and
 * render again, which paints the old figures under a note saying they changed.
 *
 * ── STAMPED, AND DROPPED IF THE USER MOVED ON ───────────────────────────
 * A refresh is a round trip over a filesystem read per document, so a project
 * switch mid-flight is ordinary rather than exotic. The reply is applied only
 * when the selection is still the one it was asked for.
 *
 * ── THE FAILURE IS INLINE, NEVER AN ALERT ───────────────────────────────
 * The two refusals this can legitimately get — a curator-owned project, a
 * checkout that is not on this computer — are both facts about the project in
 * front of the user, and they belong on it. `alert()` would put a fact about a
 * project into a modal the user must dismiss before they can look at it.
 */
async function refreshFoundations(token, files) {
  const domain = state.activeDomain;
  const project = state.activeProject;
  if (!domain || !project) return;
  if (state.fnd && state.fnd.busy) return;
  const key = keyOf(domain, project);
  state.fnd = { domain, project, busy: true, error: null, result: null };
  render(token);

  let data = null;
  let error = null;
  try {
    const res = await fetch('/api/memory/' + encodeURIComponent(domain) + '/' +
      encodeURIComponent(project) + '/foundations/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // ── THE ONE FIELD THAT MAY CROSS, AND ONLY WHEN THE OWNER PICKED ────
      // Until v3.61.0 this body was the literal '{}' and the guard on it was
      // that NOTHING crossed at all. `files` is the one field the mirror needs
      // in order to be created or extended from the app: an ARRAY OF PATHS
      // INSIDE THE REPOSITORY the manifest already names, which the store
      // validates with its own `sourceDigest` rules (inside the root, no
      // symlink out, markdown, under the per-document cap) and reports back in
      // `refused[]`. No document BODY crosses on this route in either
      // direction — that is what keeps "the app is a copier, never an author"
      // true of it. A curator document's bytes go through the PUT, which is a
      // different route with a different ownership.
      body: JSON.stringify(Array.isArray(files) && files.length ? { files } : {}),
    });
    const body = await res.json();
    if (!res.ok || !body.ok) error = body.error || body.message || ('HTTP ' + res.status);
    else data = body;
  } catch (err) {
    error = err.message;
  }
  if (!isCurrentMount(token) || activeKey() !== key) return;

  if (error) {
    state.fnd = { domain, project, busy: false, error, result: null };
    render(token);
    return;
  }
  state.fnd = {
    domain,
    project,
    busy: false,
    error: null,
    result: {
      refreshed: Array.isArray(data.refreshed) ? data.refreshed : [],
      added: Array.isArray(data.added) ? data.added : [],
      unchanged: Array.isArray(data.unchanged) ? data.unchanged : [],
      missing: Array.isArray(data.missing) ? data.missing : [],
    },
  };
  // WHAT THE STORE WOULD NOT COPY, KEPT SEPARATE FROM WHAT IT DID (v3.61.0).
  // A refusal is not a result: a path the owner typed that turned out to be
  // outside the root, a symlink pointing out of it, or a file over the
  // per-document cap each come back with the store's own reason, and they are
  // rendered unfolded beside the outcome rather than counted into it. Held on
  // `fndInit` because that is where the picker's own state lives, so a typed
  // path and the refusal it earned are on one record.
  {
    const refused = Array.isArray(data.refused) ? data.refused : [];
    if (refused.length) {
      state.fndInit = state.fndInit && state.fndInit.domain === domain
        && state.fndInit.project === project
        ? { ...state.fndInit, busy: false, refused }
        : { domain, project, choice: null, busy: false, error: null, refused };
    } else if (state.fndInit && state.fndInit.domain === domain
        && state.fndInit.project === project) {
      state.fndInit = { ...state.fndInit, busy: false, refused: [] };
    }
  }
  // THE CACHED READ IS NOW WRONG — bytes on disk changed — so it goes before
  // the request rather than after it, exactly as `reloadActive` drops it.
  forgetProject(domain, project);
  const read = await fetchState(domain, project, {}, token);
  if (!isCurrentMount(token) || activeKey() !== key) return;
  if (read.data) state.projectRead = read.data;
  render(token);
}

/**
 * SET THE OWNERSHIP, OR EXTEND A MIRROR THAT HAS NOTHING IN IT YET.
 *
 * ── ONE CONTROL, TWO ROUTES, AND THE FACTS DECIDE WHICH ─────────────────
 * A project with NO manifest is being given one: `POST …/foundations/init`,
 * which is the only route that sets an ownership and the only one the store
 * lets run once. A project that is already repo-owned and has nothing
 * mirrored has its ownership settled, so the same press is a `refresh` with a
 * file list. Rendering two controls for that would put a decision on screen
 * that the store has already made.
 *
 * ── STAMPED, AND DROPPED IF THE USER MOVED ON ───────────────────────────
 * The reply is applied only when the selection is still the one it was asked
 * for. A project switch mid-flight is ordinary: an init that seeds four
 * documents is four atomic writes plus a manifest.
 *
 * ── THE REFUSAL IS INLINE, NEVER AN ALERT ───────────────────────────────
 * Every refusal this can get — an ownership already set, a root that is not
 * on this computer, a curator arm carrying a repoRoot — is a fact about the
 * project in front of the owner, and it belongs on it.
 */
async function initFoundations(token, facts) {
  const domain = state.activeDomain;
  const project = state.activeProject;
  if (!domain || !project) return;
  const cur = state.fndInit && state.fndInit.domain === domain
    && state.fndInit.project === project ? state.fndInit : null;
  if (cur && cur.busy) return;
  const choice = (cur && cur.choice) || freshChooser({ allowLater: false });
  const body = chooserBody(choice);
  if (!body) return;
  const key = keyOf(domain, project);
  const mirrorOnly = !!(facts && facts.present && facts.ownership === 'repo');
  // `adding` SURVIVES EVERY WRITE TO THIS RECORD while the request is in
  // flight and on a refusal: it is the flag that decides whether the picker is
  // painted at all on a populated mirror, and a refused request that also made
  // the form vanish would throw away the path the owner typed (the same rule
  // the project lifecycle form follows on a 4xx).
  const keepAdding = !!(cur && cur.adding);
  // THE SWITCH SURVIVES THE ROUND TRIP for the same reason `adding` does: a
  // refused switch that also closed the panel would throw away the repository
  // the owner named.
  const keepSwitching = !!(cur && cur.switching);
  state.fndInit = {
    domain, project, choice, busy: true, error: null, refused: [], adding: keepAdding,
    switching: keepSwitching,
  };
  render(token);

  // AN ALREADY-OWNED MIRROR TAKES THE REFRESH ROUTE, which has its own
  // outcome rendering and its own stamped record — so this hands off rather
  // than duplicating it.
  if (mirrorOnly && !keepSwitching) {
    // `adding` IS PRESERVED THROUGH THE COPY. On a populated mirror the picker
    // sits under the table, and dropping the flag here would take it off
    // screen the instant the button was pressed — which reads as the press
    // having cancelled rather than started something (v3.27.0's finding).
    // `refreshFoundations`'s own stamped outcome is what clears it.
    state.fndInit = {
      domain, project, choice, busy: false, error: null, refused: [], adding: keepAdding,
      switching: false,
    };
    await refreshFoundations(token, body.files || []);
    return;
  }

  let data = null;
  let error = null;
  try {
    // ── TWO ROUTES, ONE CONTROL, AND THE FACTS DECIDE (v3.65.1) ────────
    // `…/foundations/init` is the only route that SETS an ownership and the
    // store lets it run once. A project whose ownership is already settled and
    // is moving its source to GitHub takes `…/foundations/source`, which
    // leaves `ownership: 'repo'` where it is, clears `repo.root` and sets
    // `repo.remote` in the SAME manifest write the re-copy performs — so a
    // failed read cannot leave a stale root beside a fresh remote.
    const res = await fetch('/api/memory/' + encodeURIComponent(domain) + '/' +
      encodeURIComponent(project) + '/foundations/' + (keepSwitching ? 'source' : 'init'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // ── THE SOURCE ROUTE TAKES THREE FIELDS AND REFUSES A FOURTH ────
      // `SOURCE_BODY_FIELDS` is a strict allow-list — `remote`,
      // `tokenSource`, `files` — and `chooserBody` composes an `ownership`
      // beside them because `…/foundations/init` needs one. Sending it here
      // would be a 400 `unexpected_fields`, so the three are picked out
      // explicitly rather than the object being passed through and hoped for.
      // NOTHING ELSE MAY BE ADDED HERE: there is no token field on this form
      // and there may never be one — the store reads a token from a FILE, and
      // `tokenSource` names WHICH file.
      body: JSON.stringify(keepSwitching
        ? {
          remote: body.remote,
          tokenSource: body.tokenSource,
          ...(body.files ? { files: body.files } : {}),
        }
        : body),
    });
    const got = await res.json();
    // ── A REMOTE REFUSAL NAMES THE TOKEN'S SOURCE, NEVER THE TOKEN ──────
    // The store answers a failed remote read with one of nine codes; printing
    // the code would show a person a word from a protocol. `remoteRefusalText`
    // turns each into a sentence saying which FILE the token was read from and
    // what to do about it — and returns null for a code it does not know, so
    // an unrecognised refusal falls back to the PRODUCER's own message rather
    // than to a guess. Nothing here can print a token, because nothing here
    // has one: the store reads it from a file and never returns it.
    if (!res.ok || !got.ok) {
      // ── THE CODE IS `reason`, NOT `error` (corrected v3.65.1) ─────────
      // `error` is PROSE — `withErrorProse` copies the store's `message` into
      // it when the route did not compose one — so keying the nine sentences
      // on it matched nothing and every remote refusal fell through to the
      // producer's own words. The wire CODE is `reason`, and the GitHub-read
      // refusals deliberately cross it in the store's own dash spelling
      // (`no-token`, `rate-limited`, `remote-tree-truncated`, …) precisely so
      // one client branch reads both doors — src/routes/memory.js:919-923 says
      // so in the table that excludes them. `error` is still tried, because it
      // carried a code on some paths and trying both costs nothing.
      error = remoteRefusalText(got && got.reason, { tokenSource: body.tokenSource })
        || remoteRefusalText(got && got.error, { tokenSource: body.tokenSource })
        || got.message || got.error || ('HTTP ' + res.status);
    } else data = got;
  } catch (err) {
    error = err.message;
  }
  if (!isCurrentMount(token) || activeKey() !== key) return;

  if (error) {
    // THE CHOICE SURVIVES THE REFUSAL. A path typed, a scan read and eight
    // boxes ticked are not thrown away because the server said no — that is
    // the same rule the project lifecycle form follows on a 4xx.
    state.fndInit = {
      domain, project, choice, busy: false, error, refused: [], adding: keepAdding,
      switching: keepSwitching,
    };
    render(token);
    return;
  }
  const refresh = data.refresh && typeof data.refresh === 'object' ? data.refresh : null;
  state.fndInit = {
    domain, project, choice: null, busy: false, error: null,
    refused: refresh && Array.isArray(refresh.refused) ? refresh.refused : [],
  };
  // The cached read is now wrong — a manifest and up to four documents exist
  // that did not a moment ago — so it goes before the re-read, exactly as
  // `refreshFoundations` and `reloadActive` drop it.
  forgetProject(domain, project);
  const read = await fetchState(domain, project, {}, token);
  if (!isCurrentMount(token) || activeKey() !== key) return;
  if (read.data) state.projectRead = read.data;
  render(token);
}

/**
 * OPEN ONE DOCUMENT FOR EDITING — the RAW bytes, never the defanged read.
 *
 * `?raw=1` is the whole correctness argument of this function. The ordinary
 * read defangs protocol-shaped text (a URL, a `<tool_use>` tag, a role
 * marker) because these bytes arrive over sync from other machines and, in a
 * shared mirror, from other people. The write path is verbatim. Load the
 * DEFANGED text into an editor and the first save writes it back: the document
 * is corrupted by the act of opening it, silently, in a way nothing else on
 * this screen would reveal. So the editor asks for the file and the round trip
 * is byte-exact — scripts/test-next-foundations-editor.js pins it by sha256.
 *
 * The reader keeps the default: it renders markdown INTO the page, which is
 * where the escaping duty belongs.
 *
 * A BUSY FIRST PAINT, not an empty one. The editor opens with `loading: true`
 * in the frame the press happened in (v3.27.0's finding: a press acknowledged
 * a round trip later reads as a press that did nothing), and the draft lands
 * in it.
 */
async function loadFoundationDraft(slug, token) {
  const domain = state.activeDomain;
  const project = state.activeProject;
  if (!domain || !project || !slug) return;
  const key = keyOf(domain, project);
  // THE FORCE IS A TRANSIENT (v3.64.1). It opens the fold for this press and
  // NEVER reaches `curator-memory-folds-v1` — see `fndForceOpen` in freshState
  // for the defect that made this the rule.
  state.fndForceOpen = true;
  state.fndEdit = {
    domain, project, slug: String(slug), isNew: false, loading: true,
    loaded: '', text: '', title: '', role: 'other',
    busy: false, error: null, preview: false,
    confirmDiscard: false, confirmShrink: false, confirmDelete: false,
    deleting: false, importError: null,
  };
  render(token);

  let data = null;
  let error = null;
  try {
    const res = await fetch('/api/memory/' + encodeURIComponent(domain) + '/' +
      encodeURIComponent(project) + '/foundations/' + encodeURIComponent(slug) + '?raw=1');
    const got = await res.json();
    if (!res.ok || !got.ok) error = got.message || got.error || ('HTTP ' + res.status);
    else data = got;
  } catch (err) {
    error = err.message;
  }
  if (!isCurrentMount(token)) return;
  // The reply belongs to the document it was asked for. A second Edit press
  // on another row while this was in flight must win.
  if (!state.fndEdit || keyOf(state.fndEdit.domain, state.fndEdit.project) !== key
      || state.fndEdit.slug !== String(slug)) return;

  if (error || !data) {
    state.fndEdit.loading = false;
    state.fndEdit.error = error || 'That document could not be read.';
    render(token);
    return;
  }
  const text = typeof data.text === 'string' ? data.text : '';
  state.fndEdit.loading = false;
  state.fndEdit.loaded = text;
  state.fndEdit.text = text;
  state.fndEdit.title = typeof data.title === 'string' ? data.title : String(slug);
  state.fndEdit.role = FOUNDATION_ROLES.includes(data.role) ? data.role : 'other';
  render(token);
}

/**
 * WRITE ONE CURATOR-OWNED DOCUMENT. The PUT, and nothing else.
 *
 * FIVE PROPERTIES, each of which had to be deliberate — the same five
 * `saveBrief` above records, because this is the same kind of write:
 *
 *   · STAMPED with (domain, project, slug). A reply that lands after the
 *     owner has moved on is DROPPED, so a slow save cannot report success
 *     over a document nobody is looking at.
 *   · ONE AT A TIME. `busy` disables the field and every button; a second
 *     press is a second whole-document write and the last to arrive wins,
 *     which is not what pressing twice means.
 *   · REPLACE, NOT MERGE, and the copy says so under the button.
 *   · A FAILURE KEEPS THE DRAFT. `state.fndEdit` is not cleared on error —
 *     the text stays in the box with the reason above it, because it is the
 *     only copy.
 *   · THE HUMAN'S STAMP. The route sets `authoredBy: {kind: 'human'}`; this
 *     sends only the text, the title and the role, so there is no field here
 *     through which an agent line could be forged.
 */
async function saveFoundation(token) {
  const e = state.fndEdit;
  if (!e || e.busy || e.loading) return;
  const stats = fndStats(e.text || '');
  if (stats.over) return;
  const slug = String(e.slug || '').trim();
  if (e.isNew && fndSlugError(slug, null)) return;
  const key = keyOf(e.domain, e.project) + '/' + slug;
  e.busy = true;
  e.error = null;
  e.confirmShrink = false;
  render(token);

  let ok = false;
  let error = null;
  let data = null;
  try {
    const res = await fetch('/api/memory/' + encodeURIComponent(e.domain) + '/' +
      encodeURIComponent(e.project) + '/foundations/' + encodeURIComponent(slug), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: e.text || '', title: e.title || '', role: e.role || 'other' }),
    });
    try { data = await res.json(); } catch { /* non-JSON error page */ }
    ok = res.ok && !!(data && data.ok);
    if (!ok) error = (data && (data.message || data.error)) || ('HTTP ' + res.status);
  } catch (err) {
    error = err.message;
  }

  if (!isCurrentMount(token)) return;
  if (!state.fndEdit
      || keyOf(state.fndEdit.domain, state.fndEdit.project) + '/' + String(state.fndEdit.slug || '').trim() !== key) return;

  state.fndEdit.busy = false;
  if (!ok) {
    state.fndEdit.error = error;
    render(token);
    return;
  }
  const domain = state.fndEdit.domain;
  const project = state.fndEdit.project;
  // THE CACHE GOES FIRST, unconditionally — including when the owner has
  // already moved on, which is the branch that does NOT re-read. This is the
  // one moment this view knows its own copy is wrong before any server says
  // so, and a stale entry would paint the pre-save document the next time they
  // came back.
  forgetProject(domain, project);
  state.fndEdit = null;
  if (activeKey() === keyOf(domain, project)) {
    await reloadActive(token);
    refreshIndex(token).catch((err) => reportAsyncMountFailure(token, err));
  } else {
    render(token);
  }
}

/**
 * REMOVE ONE CURATOR-OWNED DOCUMENT.
 *
 * The slug is sent as its own confirmation (`{confirm: slug}`) and the route
 * refuses without it, so a client that skipped the strip deletes nothing —
 * the same discipline the project delete has carried since v3.48.0, and for
 * the same reason: a confirmation that lives only in a view is a confirmation
 * every other client skips.
 *
 * WHAT IT COSTS, stated on the strip rather than here: your agents stop
 * reading that document. There is no in-app undo; with Personal Sync
 * configured a git client recovers it, and without it nothing does.
 */
/**
 * REMOVE ONE DOCUMENT FROM THE TABLE — the row control's request (v3.61.1).
 *
 * The SAME route the editor's delete uses, with the same typed confirmation:
 * `DELETE …/foundations/:slug` with `{confirm: slug}`. Since v3.61.1 that
 * route accepts both ownerships, because removing a mirrored entry is the
 * decision to stop mirroring it rather than an edit to a file whose author is
 * the folder (the argument is at `requireManifest` in routes/memory.js, and
 * `refreshCore` builds its work list from the manifest, so the entry stays
 * gone).
 *
 * ── THE TWO PRECONDITIONS, CHECKED AGAIN AFTER THE AWAIT ────────────────
 * The mount token, and that `state.fndStop` still names the SAME document —
 * the request takes a round trip during which a project switch or a second
 * press can land, and applying this answer to another project's table is the
 * class of defect `activeBrowse`/`activeProjects` exist to stop one view up.
 */
async function stopMirroringFoundation(token) {
  const st = state.fndStop;
  if (!st || st.busy) return;
  const { domain, project, slug } = st;
  st.busy = true;
  st.error = null;
  render(token);

  let ok = false;
  let error = null;
  let sourceKept = false;
  try {
    const res = await fetch('/api/memory/' + encodeURIComponent(domain) + '/' +
      encodeURIComponent(project) + '/foundations/' + encodeURIComponent(slug), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: slug }),
    });
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON error page */ }
    ok = res.ok && !!(data && data.ok);
    sourceKept = !!(data && data.sourceKept);
    if (!ok) error = (data && (data.message || data.error)) || ('HTTP ' + res.status);
  } catch (err) {
    error = err.message;
  }

  if (!isCurrentMount(token)) return;
  if (!state.fndStop || state.fndStop.domain !== domain
      || state.fndStop.project !== project || state.fndStop.slug !== slug) return;

  if (!ok) {
    // THE STRIP STAYS OPEN WITH THE REASON IN IT. A refusal that closed the
    // question would leave the row exactly as it was with nothing said.
    state.fndStop.busy = false;
    state.fndStop.error = error;
    render(token);
    return;
  }
  state.fndStop = null;
  // The table is re-read rather than patched: the manifest's totals, the
  // summary's four clauses and the freshness of every remaining row are the
  // store's answers, and a client that subtracted one row from its own copy
  // would be publishing an arithmetic result as a measurement.
  forgetProject(domain, project);
  // THE SAME TWO CALLS THE EDITOR'S DELETE MAKES, and no invented banner. The
  // outcome is on screen already: the row is gone and the summary's counts
  // move with it. The one fact a banner could add — that the SOURCE FILE was
  // not touched — is said in the confirm strip BEFORE the press, which is
  // where somebody deciding needs it rather than after the decision.
  // `sourceKept` is read off the response all the same, because a route that
  // stopped reporting it would be a silent change to what this control means.
  void sourceKept;
  if (activeKey() === keyOf(domain, project)) {
    await reloadActive(token);
    refreshIndex(token).catch((err) => reportAsyncMountFailure(token, err));
  } else {
    render(token);
  }
}

async function deleteFoundation(token) {
  const e = state.fndEdit;
  if (!e || e.busy || e.deleting || e.isNew) return;
  const slug = String(e.slug || '');
  const key = keyOf(e.domain, e.project) + '/' + slug;
  e.deleting = true;
  e.error = null;
  render(token);

  let ok = false;
  let error = null;
  try {
    const res = await fetch('/api/memory/' + encodeURIComponent(e.domain) + '/' +
      encodeURIComponent(e.project) + '/foundations/' + encodeURIComponent(slug), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: slug }),
    });
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON error page */ }
    ok = res.ok && !!(data && data.ok);
    if (!ok) error = (data && (data.message || data.error)) || ('HTTP ' + res.status);
  } catch (err) {
    error = err.message;
  }

  if (!isCurrentMount(token)) return;
  if (!state.fndEdit
      || keyOf(state.fndEdit.domain, state.fndEdit.project) + '/' + String(state.fndEdit.slug || '') !== key) return;

  state.fndEdit.deleting = false;
  if (!ok) {
    state.fndEdit.confirmDelete = false;
    state.fndEdit.error = error;
    render(token);
    return;
  }
  const domain = state.fndEdit.domain;
  const project = state.fndEdit.project;
  forgetProject(domain, project);
  state.fndEdit = null;
  if (activeKey() === keyOf(domain, project)) {
    await reloadActive(token);
    refreshIndex(token).catch((err) => reportAsyncMountFailure(token, err));
  } else {
    render(token);
  }
}

/**
 * EVERY TIER-0 LISTENER, BOUND FROM ONE PLACE.
 *
 * ── WHY THIS FUNCTION CARRIES THE WHOLE TIER AND wire() DOES NOT ────────
 * `wire()` is LIFTED by brace-matching and EXECUTED against a hand-written set
 * of stubs in scripts/test-agent-instructions.js, so any module-level helper
 * NAMED inside it that the stub set does not carry is a ReferenceError there —
 * a CRASH rather than a failing assertion, which is the v3.11.0 shape this
 * file warns about four times. That suite is not this package's to change.
 *
 * `bindFoundationRows` is already in its stub set and is already the tier's
 * binder, so everything v3.61.0 adds is bound HERE and `wire()` grows no new
 * identifier at all. The trade is that this function is longer than a binder
 * usually is; the alternative was a crash in somebody else's suite.
 *
 * One listener per control, re-attached after every paint: the whole pane is
 * replaced each time, so there is nothing to accumulate on and a per-element
 * handler keeps the data it needs on its own element.
 */
function bindFoundationRows(root, token) {
  root.querySelectorAll('.fnd-open[data-fnd-slug]').forEach((btn) => {
    btn.addEventListener('click', () => {
      openFoundation(btn.dataset.fndSlug, token)
        .catch((err) => reportAsyncMountFailure(token, err));
    });
  });

  // ── THE "READ FIRST" TOGGLE — A TICK PATCHES, IT DOES NOT RENDER ──────
  // v3.61.1's rule, from the maintainer's own hour on a 25-document mirror:
  // "when I select or deselect a document I'm always thrown at the top". A
  // render replaces the pane, so the fold's scroll position goes, the node
  // changes identity and focus is lost. `toggleReadFirst` writes ONE row, the
  // summary line and the block's warning, and nothing else.
  root.querySelectorAll('.fnd-first[data-fnd-first]').forEach((btn) => {
    btn.addEventListener('click', () => {
      toggleReadFirst(btn, token).catch((err) => reportAsyncMountFailure(token, err));
    });
  });

  // ── THE OWNERSHIP CHOOSER ──────────────────────────────────────────────
  // The shared module owns the markup and the per-control behaviour; this
  // view owns only WHEN to repaint and WHERE the state lives. The choice
  // object is created on first interaction and stamped, so a project switch
  // cannot post one project's answer against another.
  const facts = foundationsFacts(state.projectRead);
  const initBox = root.querySelector
    ? root.querySelector('[data-fnd-init="mem-fnd-init"]') : null;
  if (initBox) {
    if (!state.fndInit || state.fndInit.domain !== state.activeDomain
        || state.fndInit.project !== state.activeProject) {
      state.fndInit = {
        domain: state.activeDomain, project: state.activeProject,
        choice: freshChooser({ allowLater: false }), busy: false, error: null, refused: [],
      };
    }
    if (!state.fndInit.choice) state.fndInit.choice = freshChooser({ allowLater: false });
    // ── THE SAME FORCING THE RENDERER DOES, IN THE SAME ORDER (v3.65.1) ──
    // `renderFoundationsInit` sets `remote` when the panel is switching this
    // project's source to GitHub and `repo` otherwise. This line ran AFTER the
    // render and knew only about `repo`, so it put the ownership back — and
    // the binder then held a choice whose `ownership` disagreed with the arm
    // on screen: measured, the remote arm painted while `scanBlockedReason`
    // answered out of its `repoRoot` branch and the scan stayed disabled
    // saying "Type or choose the folder first." over a field asking for a
    // repository. Two writers of one field, and this one is the copy.
    if (state.fndInit.switching) state.fndInit.choice.ownership = 'remote';
    else if (facts.ownership === 'repo') state.fndInit.choice.ownership = 'repo';
    bindFoundationsChooser({
      doc: root,
      id: 'mem-fnd-init',
      choice: state.fndInit.choice,
      onChange: () => render(token),
      // ── A TICK PATCHES; IT DOES NOT RENDER (v3.61.1) ──────────────────
      //
      // THE DEFECT: `onChange` is `render(token)` — a full view render — and
      // every tick went through it. Measured on a 44-candidate folder, the
      // list's own scrollTop went 1105 → 0, the container came back a
      // different node and the focused checkbox lost focus. The maintainer's
      // words: "when I select or deselect a document I'm always thrown at the
      // top — confusing with 50 documents."
      //
      // The chooser now patches its own count, budget line and row controls
      // and hands back only what THIS view owns: whether its primary can be
      // pressed, and the sentence saying why not. Two `textContent` writes and
      // two flags, with every node checked before it is touched — the same
      // shape v3.57.0's row press uses, and the reason it takes no render.
      onSelect: (reason) => {
        const go = root.getElementById ? root.getElementById('mem-fnd-init-go') : null;
        const why = root.getElementById ? root.getElementById('mem-fnd-init-why') : null;
        // `busy` is the request in flight and outranks the tick state: a
        // disabled-because-saving button must not be re-armed by a tick.
        const saving = !!(state.fndInit && state.fndInit.busy);
        if (go) go.disabled = saving || !!reason;
        if (why) {
          const span = why.querySelector ? why.querySelector('span') : null;
          if (span) span.textContent = reason || '';
          why.hidden = !reason;
        }
      },
      onFailure: (err) => reportAsyncMountFailure(token, err),
    });
  }
  const initGo = root.getElementById ? root.getElementById('mem-fnd-init-go') : null;
  if (initGo) {
    initGo.addEventListener('click', () => {
      initFoundations(token, facts).catch((err) => reportAsyncMountFailure(token, err));
    });
  }

  // ── "Add from folder" ON A MIRROR THAT ALREADY HAS DOCUMENTS (P1-4) ────
  // Distinct from the chooser's own commit above, which serves a mirror with
  // NOTHING in it: this control belongs to the table state, where the head now
  // carries Refresh and Add side by side. Pressing it re-enters the chooser
  // through the same state field the chooser's own first interaction writes,
  // with `repo` forced — so there is one state shape, one renderer and one
  // request body, and the two entrances cannot describe two different asks.
  const addRepoBtn = root.getElementById ? root.getElementById('mem-fnd-addrepo') : null;
  if (addRepoBtn) {
    addRepoBtn.addEventListener('click', () => {
      state.fndInit = {
        domain: state.activeDomain, project: state.activeProject,
        choice: freshChooser({ allowLater: false }), busy: false, error: null, refused: [],
        // THE TABLE STAYS ON SCREEN BEHIND IT. `adding` is what tells
        // renderFoundations to paint the chooser BESIDE the documents rather
        // than instead of them: a mirror with six documents that hid them to
        // ask about a seventh would be answering with a state the owner is not
        // in (v3.17.1).
        adding: true,
      };
      state.fndInit.choice.ownership = 'repo';
      // THE FORCE IS A TRANSIENT (v3.64.1) — see `fndForceOpen` in freshState.
      state.fndForceOpen = true;
      render(token);
    });
  }

  // ── "Mirror from GitHub instead" (v3.65.1, D6) ─────────────────────────
  // The SAME transient record the two folder controls write, with one more
  // field: `switching`. It opens the panel with the GitHub arm selected and
  // routes the commit at the source route; the documents table stays on screen
  // behind it, for the reason `adding` exists.
  const mirrorBtn = root.getElementById ? root.getElementById('mem-fnd-mirror') : null;
  if (mirrorBtn) {
    mirrorBtn.addEventListener('click', () => {
      state.fndInit = {
        domain: state.activeDomain, project: state.activeProject,
        choice: freshChooser({ allowLater: false }), busy: false, error: null, refused: [],
        adding: true, switching: true,
      };
      state.fndInit.choice.ownership = 'remote';
      state.fndForceOpen = true;
      render(token);
    });
  }

  // ── "Create a project in Domains" (§8(e)) ──────────────────────────────
  // A POINTER, not a second create path. `navigate` is the shell's single
  // navigation chokepoint and this is an ordinary use of it.
  const toDomains = root.getElementById ? root.getElementById('mem-fnd-to-domains') : null;
  if (toDomains) toDomains.addEventListener('click', () => { navigate('domains'); });

  // ── "Copy the drafting request" (P2-8) ─────────────────────────────────
  // The text is composed by shared/agent-instructions.js from THIS project's
  // real unfilled slugs, so an owner with three skeletons does not paste a
  // sentence asking for four. The outcome — success or a clipboard refusal
  // that prints the text to be selected by hand — goes through the same
  // `state.copied` record the header's own copy control uses, with a `kind`
  // that says which control it belongs to.
  const askBtn2 = root.getElementById ? root.getElementById('mem-fnd-ask') : null;
  if (askBtn2) {
    askBtn2.addEventListener('click', () => {
      copyDraftingAsk(token).catch((err) => reportAsyncMountFailure(token, err));
    });
  }

  // ── THE ROW EDIT CONTROLS ──────────────────────────────────────────────
  root.querySelectorAll('[data-fnd-edit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const slug = btn.dataset ? btn.dataset.fndEdit : btn.getAttribute('data-fnd-edit');
      if (!slug) return;
      loadFoundationDraft(slug, token).catch((err) => reportAsyncMountFailure(token, err));
    });
  });

  // ── THE ROW REMOVE CONTROLS (v3.61.1) ──────────────────────────────────
  // A press only ASKS: it records which row and re-renders, which paints the
  // confirm strip under the table with that document named. Nothing is
  // requested until the strip's own primary is pressed, and the request
  // carries the slug as its own confirmation so a client that skipped the
  // strip still removes nothing.
  root.querySelectorAll('[data-fnd-stop]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const slug = btn.dataset ? btn.dataset.fndStop : btn.getAttribute('data-fnd-stop');
      if (!slug) return;
      state.fndStop = {
        domain: state.activeDomain, project: state.activeProject, slug,
        busy: false, error: null,
      };
      // THE FORCE IS A TRANSIENT (v3.64.1) — see `fndForceOpen` in freshState.
      state.fndForceOpen = true;
      render(token);
    });
  });
  const stopNo = root.getElementById ? root.getElementById('mem-fnd-stop-no') : null;
  if (stopNo) {
    stopNo.addEventListener('click', () => {
      if (state.fndStop && state.fndStop.busy) return;
      state.fndStop = null;
      render(token);
    });
  }
  const stopGo = root.getElementById ? root.getElementById('mem-fnd-stop-go') : null;
  if (stopGo) {
    stopGo.addEventListener('click', () => {
      stopMirroringFoundation(token).catch((err) => reportAsyncMountFailure(token, err));
    });
  }

  // ── "Add document" ─────────────────────────────────────────────────────
  // An EMPTY editor, opened in the frame of the press with no request at all:
  // there is nothing to read. The fold is forced open through the same field a
  // real toggle writes, because opening an editor inside a collapsed section
  // is a press that visibly does nothing (v3.58.0's finding on the brief).
  const addBtn = root.getElementById ? root.getElementById('mem-fnd-add') : null;
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      // THE FORCE IS A TRANSIENT (v3.64.1) — see `fndForceOpen` in freshState.
      state.fndForceOpen = true;
      state.fndEdit = {
        domain: state.activeDomain, project: state.activeProject,
        slug: '', isNew: true, loading: false,
        loaded: '', text: '', title: '', role: 'other',
        busy: false, error: null, preview: false,
        confirmDiscard: false, confirmShrink: false, confirmDelete: false,
        deleting: false, importError: null,
      };
      render(token);
    });
  }

  const e = state.fndEdit;
  if (!e) return;

  // ── THE THREE FIELDS: straight into state, no repaint ──────────────────
  // A render would rebuild the input and take the caret and the selection with
  // it — the rule the brief editor and views/domains.js's lifecycle form both
  // follow. The ONLY things on screen these change are the counter, the wall
  // and Save's disabled state, and each is set on the LIVE node with the SAME
  // predicate the renderer uses.
  const slugEl = root.getElementById ? root.getElementById('mem-fnd-slug') : null;
  if (slugEl) {
    slugEl.addEventListener('input', () => {
      if (!state.fndEdit) return;
      state.fndEdit.slug = slugEl.value;
      render(token);
    });
  }
  const titleEl = root.getElementById ? root.getElementById('mem-fnd-title') : null;
  if (titleEl) {
    titleEl.addEventListener('input', () => {
      if (state.fndEdit) state.fndEdit.title = titleEl.value;
    });
  }
  const textEl = root.getElementById ? root.getElementById('mem-fnd-text') : null;
  if (textEl) {
    textEl.addEventListener('input', () => {
      if (!state.fndEdit) return;
      state.fndEdit.text = textEl.value;
      const stats = fndStats(textEl.value);
      const box = root.getElementById ? root.getElementById('mem-fnd-stats') : null;
      if (box) {
        const set = (k, t) => {
          const el = box.querySelector('[data-fnd-stat="' + k + '"]');
          if (el && el.textContent !== t) el.textContent = t;
        };
        set('dirty', textEl.value !== (state.fndEdit.loaded || '') ? 'modified' : 'unchanged');
        set('words', stats.words + ' word' + (stats.words === 1 ? '' : 's'));
        set('bytes', stats.bytes + ' of ' + MAX_FOUNDATION_BYTES + ' bytes');
        if (box.classList) box.classList.toggle('mem-brief-stats-over', stats.over);
      }
      const over = root.getElementById ? root.getElementById('mem-fnd-over') : null;
      if (over) over.hidden = !stats.over;
      const save = root.getElementById ? root.getElementById('mem-fnd-save') : null;
      if (save) save.disabled = stats.over;
    });

    // THE KEYBOARD CONTRACT, ON THE FIELD ITSELF. ⌘S and ⌘↵ both save, for
    // the two kinds of writer the brief editor's own block names, and Escape
    // asks `briefDismissDecision` — the SAME function, parametrised over the
    // record rather than copied, because a draft is a draft whichever tier it
    // belongs to and two answers to "may I close this?" is how a draft gets
    // destroyed by the safer-looking control.
    textEl.addEventListener('keydown', (ev) => {
      const mod = ev.metaKey || ev.ctrlKey;
      if (mod && (ev.key === 's' || ev.key === 'S' || ev.key === 'Enter')) {
        if (typeof ev.preventDefault === 'function') ev.preventDefault();
        const warn = fndShrinkWarn(state.fndEdit);
        if (warn && state.fndEdit && !state.fndEdit.confirmShrink) {
          state.fndEdit.confirmShrink = true;
          render(token);
          return;
        }
        saveFoundation(token).catch((err) => reportAsyncMountFailure(token, err));
        return;
      }
      if (ev.key === 'Escape') {
        const decision = briefDismissDecision(state.fndEdit);
        if (decision === 'blocked') return;
        if (typeof ev.preventDefault === 'function') ev.preventDefault();
        if (decision === 'confirm') {
          state.fndEdit.confirmDiscard = true;
          render(token);
          return;
        }
        state.fndEdit = null;
        render(token);
      }
    });
  }

  root.querySelectorAll('[data-fnd-edit-role]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const role = btn.dataset ? btn.dataset.fndEditRole : btn.getAttribute('data-fnd-edit-role');
      if (!role || !state.fndEdit || !FOUNDATION_ROLES.includes(role)) return;
      state.fndEdit.role = role;
      render(token);
    });
  });

  // THE BUTTON OPENS THE HIDDEN INPUT (P1-7). One line, and it is the whole
  // reason the input may be `hidden` — out of the tab order — rather than
  // merely invisible and still focusable.
  const fileBtn = root.getElementById ? root.getElementById('mem-fnd-file-btn') : null;

  // ── A FILE FROM DISK (D18) ─────────────────────────────────────────────
  // Read in the browser, dropped into the FIELD, and saved by the ordinary
  // PUT. The wall is checked on `file.size` before the read, so a 40 MB file
  // is refused with both numbers and never read into memory — that decision
  // lives in shared/foundations-init.js's `readPickedFile`, which returns the
  // refusal as data rather than throwing.
  const fileEl = root.getElementById ? root.getElementById('mem-fnd-file') : null;
  if (fileBtn && fileEl) {
    fileBtn.addEventListener('click', () => {
      if (typeof fileEl.click === 'function') fileEl.click();
    });
  }
  if (fileEl) {
    fileEl.addEventListener('change', () => {
      const files = fileEl.files ? Array.prototype.slice.call(fileEl.files) : [];
      if (!files.length) return;
      readPickedFile(files[0]).then((got) => {
        if (!isCurrentMount(token) || !state.fndEdit || !state.fndEdit.isNew) return;
        // A KIND REFUSAL IS A WHOLE SENTENCE (contract §10): a PDF was never a
        // candidate document, and "notes.pdf is a PDF — not read." is a worse
        // answer than the sentence that names the two ways forward. A SIZE
        // refusal keeps the fragment shape, because that file WAS the right
        // kind and one fact about it disqualified it.
        if (got.refusal) {
          state.fndEdit.importError = got.refusal;
          render(token);
          return;
        }
        if (got.error) {
          state.fndEdit.importError = (got.name || 'That file') + ' ' + got.error + '.';
          render(token);
          return;
        }
        state.fndEdit.importError = null;
        state.fndEdit.text = got.text;
        // THE DRAFT IS DIRTY THE MOMENT A FILE LANDS, and `loaded` stays
        // empty: this is a NEW document, so there is nothing it was loaded
        // from, and the Escape decision must ask rather than close silently.
        if (!String(state.fndEdit.slug || '').trim() && got.slug) state.fndEdit.slug = got.slug;
        if (!String(state.fndEdit.title || '').trim()) state.fndEdit.title = got.title;
        if (state.fndEdit.role === 'other' && got.role) state.fndEdit.role = got.role;
        render(token);
      }).catch((err) => reportAsyncMountFailure(token, err));
    });
  }

  const on = (id, fn) => {
    const el = root.getElementById ? root.getElementById(id) : null;
    if (el) el.addEventListener('click', fn);
  };

  on('mem-fnd-preview', () => {
    if (!state.fndEdit) return;
    state.fndEdit.preview = !state.fndEdit.preview;
    render(token);
  });
  on('mem-fnd-save', () => {
    const warn = fndShrinkWarn(state.fndEdit);
    if (warn && state.fndEdit && !state.fndEdit.confirmShrink) {
      state.fndEdit.confirmShrink = true;
      render(token);
      return;
    }
    saveFoundation(token).catch((err) => reportAsyncMountFailure(token, err));
  });
  on('mem-fnd-shrink-go', () => {
    saveFoundation(token).catch((err) => reportAsyncMountFailure(token, err));
  });
  on('mem-fnd-shrink-no', () => {
    if (state.fndEdit) state.fndEdit.confirmShrink = false;
    render(token);
  });
  // Cancel goes through the SAME decision as Escape. Two ways out of one
  // editor that answer differently about an unsaved draft is how a draft gets
  // destroyed by the safer-looking control.
  on('mem-fnd-cancel', () => {
    const decision = briefDismissDecision(state.fndEdit);
    if (decision === 'blocked') return;
    if (decision === 'confirm') {
      state.fndEdit.confirmDiscard = true;
      render(token);
      return;
    }
    state.fndEdit = null;
    render(token);
  });
  on('mem-fnd-discard', () => { state.fndEdit = null; render(token); });
  on('mem-fnd-keep', () => {
    if (state.fndEdit) state.fndEdit.confirmDiscard = false;
    render(token);
  });
  on('mem-fnd-delete', () => {
    if (state.fndEdit) state.fndEdit.confirmDelete = true;
    render(token);
  });
  on('mem-fnd-delete-no', () => {
    if (state.fndEdit) state.fndEdit.confirmDelete = false;
    render(token);
  });
  on('mem-fnd-delete-go', () => {
    deleteFoundation(token).catch((err) => reportAsyncMountFailure(token, err));
  });
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
          '<span>Journal</span><span class="mem-fold-meta">empty</span></summary>' +
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
  // ── IT IS A MONITOR LINE NOW (v3.65.0, M4) ──────────────────────────
  // A live figure with a provenance clause is exactly what the monitor is
  // for, and this page draws three other readings with it — so a `.tx-readout`
  // standing alone at the foot of a list was the fourth treatment the
  // maintainer counted. The three arms are unchanged and each still keeps a
  // FACT apart from its ABSENCE: `total: null` with `totalUnknown` means the
  // journal was longer than the tail we read, so the VALUE is the number we
  // can stand behind and the reason we cannot state a total is the clause —
  // never a total printed as if the tail's length were it.
  //
  // Composed INLINE rather than through a helper: this function is lifted by
  // brace-matching and executed, so a module-level helper named here would be
  // a ReferenceError there.
  // ── THE COUNT IS THE SUMMARY'S, NOT A CARD AT THE FOOT (v3.65.1, D3) ──
  //
  // THE REPORTED DEFECT, in the maintainer's words: the journal's footer was a
  // monitor card reading "SAVES RECORDED 15 · showing the 10 most recent" with
  // a floating "Show more" button beside it — *"from another dimension"* —
  // while the Handoffs list one row up ends in a full-width inline row that
  // says "Show 17 more". Measured at 1370: the footer monitor ran 421→723.5
  // and the button floated at x=735.5 w=77, against a list 893px wide.
  //
  // So the count moves into the row's own summary, where every other row on
  // this page puts its reading, and "Show N more" becomes the ONE
  // implementation — `wsMoreHtml`'s `cur-group-row`, the list's own last row.
  // THE THREE ARMS ARE UNCHANGED and each still keeps a FACT apart from its
  // ABSENCE: `total: null` with `totalUnknown` means the journal was longer
  // than the tail we read, so the figure we print is the one we can stand
  // behind and the reason we cannot state a total rides beside it — never a
  // total printed as if the tail's length were it.
  let countClause;
  if (j.totalUnknown) {
    countClause = j.returned + ' save' + (j.returned === 1 ? '' : 's') + ' shown'
      + ' · full count unknown';
  } else if (typeof j.total === 'number' && j.total > j.returned) {
    countClause = j.total + ' save' + (j.total === 1 ? '' : 's')
      + ' · showing ' + j.returned;
  } else {
    countClause = j.returned + ' save' + (j.returned === 1 ? '' : 's');
  }

  const canExpand = state.journalLimit === JOURNAL_PAGE &&
    (j.totalUnknown || (typeof j.total === 'number' && j.total > j.returned));
  // ── ONE "Show N more", AND IT IS THE HANDOFFS LIST'S (v3.65.1, D3) ────
  // The same `cur-group-row` shape `wsMoreHtml` emits: the list's own last
  // ROW, full width, in flow — never a floating `btn-xs` beside a card. The
  // maintainer named the Handoffs implementation as the right one by name, so
  // this is not a third opinion; it is that one, here. The id and the class
  // `mem-j-more` are kept because BOTH binder call sites (`wire` and
  // `patchOpenPair`) find the control by them, and the number is named where
  // it can be: with a known total we can say how many more there are, and with
  // `totalUnknown` we honestly cannot.
  // In the <details> BODY, never in its <summary> — see the header comment.
  const moreRest = (!j.totalUnknown && typeof j.total === 'number')
    ? Math.max(0, j.total - j.returned) : null;
  const moreBtn = canExpand
    ? '<button type="button" class="cur-group-row mem-j-more" id="mem-journal-more">'
      + '<span class="mem-ws-more-label">'
      + (moreRest ? 'Show ' + moreRest.toLocaleString('en-US') + ' more' : 'Show more')
      + '</span></button>'
    : '';

  // ── THE META HAS TO BE ENOUGH TO DECIDE WITH (v3.58.0) ──────────────────
  // It was the bare figure `31`, which answers "how many" and not "is any of
  // this recent" — and the second question is the one that decides whether a
  // closed section is worth opening. The newest entry's age answers it, in the
  // same words and on the same bands as every other age on this page, and it
  // rides on `data-mem-age-at` + `.mem-age-words` so `tickAges` keeps it
  // moving without a render (the summary is not folded into screenSignature,
  // deliberately — the journal's own rows are not either).
  const latest = j.entries && j.entries.length && j.entries[0] && j.entries[0].at
    ? j.entries[0].at : null;
  const latestAge = latest
    ? formatAge(Math.max(0, Math.round((Date.now() - Date.parse(latest)) / 1000))) : null;
  const journalMeta =
    escapeHtml(countClause) +
    (latestAge ? ' · latest <span class="mem-age-words">' + escapeHtml(latestAge) + '</span>' : '');

  return (
    '<details class="mem-fold" data-mem-fold="journal"' + journalOpen + '>' +
      '<summary class="mem-fold-summary" id="mem-fold-journal">' + icon('chevronRight', 14) +
        '<span>Journal</span>' +
        '<span class="mem-fold-meta"' +
          (latest && latestAge ? ' data-mem-age-at="' + escapeHtml(latest) + '"' : '') + '>' +
          journalMeta + '</span></summary>' +
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
        '<ol class="mem-j-list">' + rows + '</ol>' + moreBtn +
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
    '<p>A <b>domain</b> is where your knowledge lives — one compounding set of pages. A <b>project</b> ' +
    'is a thing you build inside it, and a domain can hold several. Project context is kept per project, ' +
    'in <span class="mono">state/</span> beside that domain’s pages, and synced with it.</p>' +
    // ── THE RAIL'S OWN SENTENCE, MOVED HERE (v3.65.0, R2) ─────────────
    // The sidebar had a second ⓘ carrying this line, and the maintainer
    // asked for it to go: *"we have an information icon in the Project
    // context sidebar which should not be here, because we have another one
    // on the right side beside Copy agent instructions — we definitely
    // don't need it in this small section."* The MARK went; the SENTENCE
    // did not, and this is the panel it belongs in — the paragraph below
    // already says the same thing about the same two writers at length, so
    // this is the one-line form of it, kept verbatim because it is the form
    // a reader who opens the panel and reads nothing else gets.
    '<p>Agents save handoffs here over MCP; you write the standing brief. ' +
    'This screen re-checks by itself when you come back to it, so Refresh is rarely needed.</p>' +
    '<ul class="mem-about-list">' +
      '<li><b>Standing brief</b> — the part that rarely changes: the goal, the firm decisions, the working ' +
      'model. One per project, returned on every agent read. <b>You write this one</b>, here or in a text ' +
      'editor; saving replaces the whole document.</li>' +
      '<li><b>Current handoff</b> — where things stand right now: what an agent leaves for the next ' +
      'session, so it starts knowing what you already settled. One per thread of work per machine ' +
      '(the files call that thread a <i>scope</i>), so parallel threads never overwrite each other. ' +
      'Overwritten on every save, so it never grows stale behind you.</li>' +
      '<li><b>Session journal</b> — one line per save: when, which harness, which model, and the headline. ' +
      'It is history and it accumulates, so an old entry can describe something already resolved.</li>' +
    '</ul>' +
    '<p>Each machine writes to its own folder, so two machines can never overwrite each ' +
    'other over sync. Reading a handoff with no machine named gives you the most recently written one, ' +
    'whichever machine that was.</p>' +
    '<p>Your agents write the handoff and the journal through the ' +
    '<span class="mono">my-curator</span> MCP tools, and this screen never does — a handoff is worth ' +
    'something because an agent observed it. The brief is yours. Everything here is plain markdown, so a ' +
    'text editor works too.</p>' +
    '<p>' + docsLinkHtml('memory.overview', 'Read more in the guide') + '</p>'
  );
}

// ── Wiring ───────────────────────────────────────────────────────────────

/**
 * Binds the work-stream rows inside `root`.
 *
 * `root` is the DOCUMENT on a full paint and the newly-appended rows on a
 * "Show N more" — which is the whole reason it is a parameter, and the shape
 * views/domains.js's `bindBrowseRowClicks` settled on: re-scanning the document
 * after an append would re-bind every row already on screen, and a second
 * listener on a row opens the reader twice.
 *
 * One listener per row rather than one delegated listener on the table: `wire`
 * runs after every paint and the whole pane is replaced each time, so there is
 * nothing to accumulate on, and a per-row handler keeps the data it needs on
 * its own element.
 */
/**
 * STEP ③'s PICKER AND ITS REMOVES (v3.65.0, P10).
 *
 * The shared listbox, ADD ONE AT A TIME: `shared/listbox.js` says in its own
 * header that it implements no multi-select, and building a second selection
 * paradigm here is the shape this release exists to remove. The WHOLE list is
 * sent on every write, never a delta — the store's body is strict and one
 * field, and a partial write is how two clients come to disagree about a set.
 *
 * ONE cfg OBJECT for both halves. `renderKnowledgePicker` composed the markup
 * from `knowledgePickerCfg` and this mounts from the same function; two cfg
 * literals is the two-hand-maintained-copies shape the component's own header
 * warns about.
 */
function bindKnowledgeRows(root, token) {
  const chosen = (state.projectRead && Array.isArray(state.projectRead.knowledgeDomains)
    && state.projectRead.knowledgeDomains.length)
    ? state.projectRead.knowledgeDomains.slice()
    : (state.activeDomain ? [state.activeDomain] : []);
  const all = Array.isArray(state.domainList) ? state.domainList : [];
  const rest = all.filter((d) => !chosen.includes(d));
  if (rest.length && typeof document !== 'undefined'
    && typeof document.getElementById === 'function' && document.getElementById('mem-k-add')) {
    const cfg = knowledgePickerCfg(rest, state.knowledgeSaving === true);
    cfg.onSelect = (value) => {
      if (!value || chosen.includes(value)) return;
      saveKnowledgeDomains(chosen.concat([value]), token)
        .catch((err) => reportAsyncMountFailure(token, err));
    };
    mountListbox(cfg);
  }
  root.querySelectorAll('[data-mem-k-drop]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const gone = btn.dataset.memKDrop;
      if (!gone) return;
      // REMOVING THE LAST ONE CLEARS THE CHOICE rather than emptying it: the
      // project goes back to drawing on the domain it lives in, which is the
      // store's own default and the only honest meaning of "none".
      saveKnowledgeDomains(chosen.filter((d) => d !== gone), token)
        .catch((err) => reportAsyncMountFailure(token, err));
    });
  });
}

function bindWorkStreamRows(root, token) {
  root.querySelectorAll('.mem-ws-open[data-mem-scope]').forEach((btn) => {
    btn.addEventListener('click', () => {
      openWorkStream(btn.dataset.memScope, btn.dataset.memMachine || null, token)
        .catch((err) => reportAsyncMountFailure(token, err));
    });
  });
}

/**
 * A ROW PRESS: select the pair, then open its handoff in the shell's reader.
 *
 * ── WHY THE READER OPENS FIRST, EMPTY ────────────────────────────────────
 * The read behind a row takes a round trip, and the wiki's own rows have
 * answered that with a `loading: true` panel since the reader existed. Painting
 * it here means the press is acknowledged in the frame it happened in rather
 * than up to a second later (v3.27.0's finding, one screen over).
 *
 * `isCurrentReader(epoch)` is the guard that goes with it: a user who presses
 * Escape while the fetch is in flight must not have the document reopened on
 * top of whatever they went back to. `isCurrentMount(token)` covers leaving the
 * view entirely; the two are different questions and both are asked.
 *
 * ── PRESSING THE OPEN ROW RE-OPENS THE READER ───────────────────────────
 * It used to return early — re-reading would have dropped the document and
 * painted a loader over a page that was already correct. That was right while
 * the handoff was ON the page; now the press IS the open, so a press on the
 * row that is already selected must still produce the document. It does so
 * from `state.detail`, with no request at all.
 *
 * FOCUS IS RECORDED EXPLICITLY, and this is the one place in the view that
 * does so: `captureFocus` only remembers an id in FOCUSABLE_IDS, and the button
 * being pressed has NO id unless it is already the open row (ids must be unique
 * and a scope slug is not a safe id fragment). A moment after this press the
 * pressed row IS the open row and carries `mem-ws-active`, which is also the id
 * the reader returns focus to when it is dismissed.
 */
async function openWorkStream(scope, machine, token) {
  pendingFocusId = 'mem-ws-active';
  const wanted = machine || null;
  const already = !!(state.detail && state.detail.scope === scope
    && (state.detail.machine || null) === wanted);

  if (already) {
    const content = handoffReaderContent();
    if (content) openReader(content, token);
    return;
  }

  const epoch = openReader({
    slug: 'state/' + (state.activeProject || '') + '/' + scope
      + (wanted ? '/' + wanted : '') + '/current.md',
    title: scope,
    loading: true,
    returnFocusTo: 'mem-ws-active',
  }, token);

  state.journalLimit = JOURNAL_PAGE;
  // `reader: true` — the main column must not be repainted underneath the
  // overlay this press just opened; `cache: true` — a pair read earlier in this
  // session opens with no request at all. Both are documented on loadScope.
  // NO `deliberate: false`: a row press IS the user choosing this machine.
  await loadScope(scope, wanted, token, { reader: true, cache: true });
  if (!isCurrentMount(token)) return;
  if (!isCurrentReader(epoch)) return; // Esc / scrim / ✕ closed it while we read

  const content = handoffReaderContent();
  if (content) openReader(content, token);
  else openReader({
    slug: scope, title: scope,
    error: state.detailError || 'That handoff could not be read.',
  }, token);
}

/**
 * Paints the NEXT window of work-stream rows — by APPENDING them.
 *
 * ── WHY APPEND, NOT RENDER ───────────────────────────────────────────────
 * The same three costs views/domains.js measured on its own list: a render
 * replaces the whole main pane by innerHTML, so the page's scroll position
 * moves, any open ⓘ panel is rebuilt, and every row already on screen is
 * re-parsed. Appending touches only the nodes that are new, and the rows above
 * the button do not move.
 *
 * `state.wsWindow` stays the single source of truth, so a later full render — a
 * poll, a save landing, a brief edit — paints exactly what is on screen now.
 * The two paths cannot disagree about how much is shown.
 *
 * The button is REPLACED rather than hidden, because it is the list's last row
 * and a hidden row still occupies the rule above it.
 */
function showMoreWorkStreams(token) {
  const pr = state.projectRead;
  const scopes = (pr && pr.scopes) || [];
  const tbody = document.getElementById('mem-ws-body');
  const moreBtn = document.getElementById('mem-ws-more');
  if (!tbody || !moreBtn || !scopes.length) return;

  const ordered = workStreamOrder(scopes);
  const from = wsShownCount(ordered, state.detail, state.wsWindow);
  const rest = ordered.length - from;
  if (rest <= 0) { moreBtn.remove(); return; }
  const to = from + (rest <= WS_STEP_ALL_MAX ? rest : WS_STEP);

  const open = state.detail;
  const openScope = (open && open.scope) || null;
  const openMachine = (open && open.machine) || null;
  const mineMachine = open && open.machineIsThisMachine === true ? open.machine : null;

  const before = tbody.children.length;
  tbody.insertAdjacentHTML('beforeend', ordered.slice(from, to)
    .map((row) => wsRowHtml(row, openScope, openMachine, mineMachine)).join(''));
  // `wsWindow` records what was ASKED for, which `wsShownCount` may still
  // stretch to reach an open row further down. Storing the stretched figure
  // would silently make the open row's position part of the user's request.
  state.wsWindow = to;

  // Bind ONLY what was just inserted — see bindWorkStreamRows. Taken as the
  // tail of the list by INDEX rather than by counting back from a sibling, so
  // a row the painter ever renders as two elements cannot bind the wrong set.
  const added = Array.prototype.slice.call(tbody.children, before);
  bindWorkStreamRows({
    querySelectorAll: (sel) => added.reduce((acc, el) => (
      el.querySelectorAll ? acc.concat(Array.prototype.slice.call(el.querySelectorAll(sel))) : acc), []),
  }, token);

  const count = document.getElementById('mem-ws-count');
  if (to >= ordered.length) {
    moreBtn.remove();
  } else {
    const label = moreBtn.querySelector('.mem-ws-more-label');
    const left = ordered.length - to;
    if (label) label.textContent = 'Show ' + (left <= WS_STEP_ALL_MAX ? left : WS_STEP).toLocaleString() + ' more';
  }
  // The count line is rebuilt rather than patched: it is ONE escaped string
  // over four facts (work-streams, saved copies, the store's own cap, this
  // window), and patching a clause out of the middle of it is how the two
  // would start to disagree.
  if (count) {
    count.outerHTML = workStreamCounts(pr, scopes.length,
      wsShownCount(ordered, state.detail, state.wsWindow));
  }
}

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
  bindWorkStreamRows(document, token);

  // ── "SHOW N MORE" ─────────────────────────────────────────────────────
  document.getElementById('mem-ws-more')?.addEventListener('click', () => {
    showMoreWorkStreams(token);
  });

  // ── TIER 0: THE DOCUMENT ROWS AND THE ONE CONTROL ─────────────────────
  // The rows go through the same per-row binder shape the work-stream table
  // uses. NO focus id is recorded here, and that is the difference between the
  // two tables: a foundation row press causes no render at all, because every
  // row already carries a stable id derived from its slug — so there is
  // nothing for the capture/restore pass to put back.
  bindFoundationRows(document, token);

  document.getElementById('mem-fnd-refresh')?.addEventListener('click', () => {
    refreshFoundations(token).catch((err) => reportAsyncMountFailure(token, err));
  });

  // ── "CHOOSE DOCUMENTS" — A DOOR, NOT A SECOND WRITE PATH (v3.65.0) ────
  // The budget warning named a consequence and offered nothing to do about
  // it. This opens the documents row and puts the reader in front of the
  // `read first` column, whose per-row tick is the shipped
  // `PATCH …/foundations/:slug {readFirst}`. THE TRANSIENT, never the
  // persisted key: `state.fndForceOpen` is what the editor already uses, and
  // an explicit close clears it (see the toggle listener below), which is
  // what keeps a close final — the v3.64.1 "it reopens itself" loop.
  //
  // Inline, for the reason this function documents four times: it is lifted
  // by brace-matching and executed against a hand-written set of stubs, so a
  // module-level helper named here would be a ReferenceError there.
  document.getElementById('mem-fnd-budget-go')?.addEventListener('click', () => {
    state.fndForceOpen = true;
    render(token);
    // AFTER the paint, not before it: the column does not exist until the
    // fold is open, and scrolling to a node that is not there is a press that
    // visibly does nothing. The focus target is the first tick, which is the
    // control the sentence is about.
    const first = typeof document.querySelector === 'function'
      ? document.querySelector('[data-fnd-first]') : null;
    if (first) {
      let reduce = false;
      try {
        reduce = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
          && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      } catch { reduce = false; }
      if (typeof first.scrollIntoView === 'function') {
        first.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
      }
      if (typeof first.focus === 'function') first.focus();
    }
  });

  // ── STEP ③'s TWO DOORS, AND THE SIDEBAR'S POINTER (v3.62.0) ──────────
  //
  // BOTH DOORS NAME THE DOMAIN. This view is app-wide across domains and
  // views/domains.js keeps its active slug in module state, falling back to
  // its first row when that slug is unset or gone — so a bare
  // `navigate('domains')` from a project in domain B lands on whatever
  // Domains last had, silently, with every figure on the screen belonging to
  // a different wiki. `requestDomain` is the shell pair that removes the
  // PATH rather than the symptom, and it is consumed once, in that view's
  // onEnter, before it resolves its own slug.
  //
  // `goToChatScoped` is the EXISTING wrapper, lifted to shared/ rather than
  // copied: `requestChatScope` has a documented no-slug hazard and it stays
  // guarded once, in one function, for both hosts.
  //
  // ── ONE PAIR PER ROW (v3.65.0, P10) ──────────────────────────────────
  // A project draws on N wikis, so there are N pairs of doors, and an id must
  // be unique. Each door carries its OWN domain in a data attribute — the
  // pattern `bindFoundationRows` already uses — so a row's doors name the row
  // rather than whichever domain the project happens to live in.
  document.querySelectorAll('[data-mem-k-domains]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const domain = btn.dataset.memKDomains;
      if (!domain) return;
      requestDomain(domain, { reason: 'knowledge' });
      navigate('domains');
    });
  });
  document.querySelectorAll('[data-mem-k-chat]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const domain = btn.dataset.memKChat;
      if (!domain) return;
    // ── AND THE PROJECT, WHEN ONE IS OPEN (v3.64.0, §4.1) ──────────────
    // This door is pressed FROM a project's page. Handing Chat the domain
    // and dropping the project on the way would make the user re-choose,
    // on the next screen, the thing they were already looking at — and the
    // project is what Chat's pill needs in order to read the standing
    // brief, the latest handoff and the read-first foundations alongside
    // the wiki. `state.activeProject` is null on the domain-level arm of
    // this view, and app.js's single writer drops a null rather than
    // recording a project that names nothing, so this is one shape in both
    // states. Still exactly one navigate(), still record-then-navigate —
    // the wrapper owns that ritual and this passes through it.
      goToChatScoped(domain, { project: state.activeProject });
    });
  });

  // ── STEP ③'s PICKER AND ITS REMOVES (v3.65.0, P10) ───────────────────
  // ONE binder, exactly as `bindFoundationRows` and `bindWorkStreamRows` are,
  // and the reason is mechanical rather than tidy: this function is lifted by
  // brace-matching and EXECUTED against a hand-written set of stubs in
  // scripts/test-agent-instructions.js, so every name it calls has to be one
  // that suite supplies — and one new name is one stub rather than three.
  bindKnowledgeRows(document, token);

  document.getElementById('mem-new-project')?.addEventListener('click', () => {
    const domain = state.activeDomain;
    // NO DOMAIN, NO REQUEST — but still the pointer. A user with no project
    // selected still wants the create form; what cannot be claimed is which
    // domain it should open on.
    // `openCreate: true` rather than a bare request: the pointer's whole job
    // is to land on the CREATE FORM of this domain, and B's shell normalises
    // the flag to that. A request with no flag would land on the domain and
    // leave the person looking for the form they pressed a button to reach.
    if (domain) requestDomain(domain, { openCreate: true });
    navigate('domains');
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
      // ── ONE GESTURE OPENS BOTH (v3.58.0) ──────────────────────────────
      // The brief is a fold and it starts shut, so the pencil is usually
      // pressed against a collapsed section. Opening the editor INSIDE a
      // section that stays collapsed would be a press that visibly does
      // nothing, and asking for a second click on the chevron first is the
      // "buried" complaint in a new place. So Edit records the same decision a
      // toggle records — and through the same field, because a second way of
      // saying "open" is a second thing that can disagree.
      //
      // WRITTEN THROUGH, so it survives leaving the view: the toggle listener
      // persists on a real toggle, and this path fires no toggle (the next
      // render PARSES the <details> open, and `toggle` does not fire on parse).
      // Inline and with the literal key for the reason the listener below
      // states — `wire` may not name a module-level helper.
      if (!state.openFolds) state.openFolds = {};
      state.openFolds.brief = true;
      try {
        localStorage.setItem('curator-memory-folds-v1', JSON.stringify(state.openFolds));
      } catch { /* private window, blocked site data, quota — the app forgets */ }
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
  // TWO FOLDS, `brief` and `journal`. The v3.54.0 "open because nothing else
  // is on the page" state is still inexpressible, for a better reason than the
  // one v3.56.0 had: `open` is derived from `state.openFolds[key]` alone, and
  // the only two things that ever write that key are a real `toggle` (below)
  // and the Edit button (above), both of which are decisions a user made.
  //
  // ── THE WRITE-THROUGH IS INLINE, AND SO IS THE KEY ────────────────────
  // A fold you opened has to still be open when you come back from another
  // view, so the map is persisted. `readRememberedFolds` reads it; the write
  // cannot call its sibling `rememberFold` because THERE IS NONE — see the
  // reason above this block for why `wire` may not name a module-level helper.
  // The key literal is therefore duplicated from `FOLDS_KEY`, and
  // scripts/test-next-memory-view.js §19 pins the two against each other so
  // the copies cannot drift. The try/catch is the same contract the
  // last-project map has: storage that refuses (private window, blocked site
  // data, quota) must make the app FORGET, never break — and in a Node harness
  // with no `localStorage` at all the ReferenceError lands in the same catch.
  //
  // DELIBERATELY INLINE, AND NOT SHARED WITH `patchOpenPair`. That function
  // replaces the journal's contents without a render and has to re-reach the
  // "Show more" button afterwards, which is the ordinary argument for lifting
  // these two listeners into one helper. It is refused for the reason this
  // file's header states twice: `wire` is LIFTED by brace-matching and
  // EXECUTED by scripts/test-agent-instructions.js against a hand-written set
  // of stubs, so any module-level helper named here is an undefined
  // identifier there — a CRASH rather than a failing assertion, which is the
  // v3.11.0 shape. `patchOpenPair` keeps the <details> ELEMENT alive across
  // its swap precisely so only ONE of the two listeners below has to be
  // re-attached there, and that one names this block.
  // ── THE OVERVIEW'S DOORS (v3.64.2) ──────────────────────────────────────
  // Each of the three cards above the steps opens the step that owns its
  // layer, and the CAPTURE jump opens the session reading inside step ②.
  //
  // WRITTEN INLINE, WITH NO HELPER, for this function's standing reason:
  // `wire` is LIFTED by brace-matching and EXECUTED by
  // scripts/test-agent-instructions.js against a hand-written set of stubs,
  // so any module-level helper named here is an undefined identifier there —
  // a CRASH rather than a failing assertion. Every global it touches is
  // `typeof`-guarded for the same reason: that stand-in document has
  // getElementById and querySelectorAll and not necessarily querySelector.
  //
  // BOUND ONCE PER NODE, through an EXPANDO rather than an attribute: a
  // `data-*` mark would appear in the live node's outerHTML and never in a
  // freshly-composed one, so any markup comparison would find the section
  // different on every paint.
  //
  // THE FOCUS MOVES TO THE STEP'S OWN HEADING, not to the block, because a
  // scroll that does not move focus leaves a keyboard user where they were
  // and a screen reader saying nothing. `preventScroll` so the focus call
  // cannot fight the smooth scroll it follows.
  document.querySelectorAll('[data-ov-jump]').forEach((btn) => {
    if (btn.__ovBound) return;
    btn.__ovBound = true;
    btn.addEventListener('click', () => {
      const where = btn.dataset && btn.dataset.ovJump;
      if (!where) return;
      const q = typeof document.querySelector === 'function'
        ? (sel) => document.querySelector(sel) : () => null;
      const block = q('.settings-block-' + (where === 'capture' ? 'context-state' : where));
      // The capture meter is the one target that is not a whole step: it is a
      // reading INSIDE step ②, so the jump lands on the reading when it is on
      // screen and on the step that holds it when it is not.
      // CAPTURE IS A ROW INSIDE STEP ② (v3.65.0), not a card above it, so the
      // jump lands on the ROW when it is on screen and on the step that holds
      // it when it is not — the same two-step fallback, re-pointed at the
      // element that carries the reading now.
      const target = (where === 'capture' && q('[data-mem-fold="capture"]')) || block;
      if (!target) return;
      let reduce = false;
      try {
        reduce = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
          && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      } catch { reduce = false; }
      if (typeof target.scrollIntoView === 'function') {
        target.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
      }
      const head = block && typeof block.querySelector === 'function'
        ? block.querySelector('.settings-job-title') : null;
      if (head && typeof head.focus === 'function') {
        if (typeof head.setAttribute === 'function') head.setAttribute('tabindex', '-1');
        try { head.focus({ preventScroll: true }); } catch { head.focus(); }
      }
    });
  });

  document.querySelectorAll('[data-mem-fold]').forEach((el) => {
    // ── THE PAINT'S OWN ECHO IS NOT A PRESS (v3.64.1) ────────────────────
    // MEASURED IN A BROWSER: a `<details open>` created by an innerHTML
    // assignment fires `toggle` ONCE, after this listener is attached — the
    // probe is one line and the answer is unambiguous (open: 1 event, closed:
    // 0). So every paint of an OPEN fold arrives here as a toggle nobody
    // performed. While the emitted value always equalled the stored one that
    // was harmless noise; it stopped being harmless the moment a fold could
    // be opened by a TRANSIENT (`state.fndForceOpen`), because the echo then
    // wrote that transient into `curator-memory-folds-v1` as the user's own
    // choice and one Edit press marked the documents fold open for good.
    //
    // A press always CHANGES `el.open` relative to what the last recorded
    // state was; an echo never does. The mark is an expando, so it is
    // invisible to anything that compares markup.
    el.__memFoldWas = !!el.open;
    el.addEventListener('toggle', () => {
      if (!state.openFolds) state.openFolds = {};
      const key = el.dataset.memFold;
      if (!key) return;
      if (!!el.open === el.__memFoldWas) return;
      el.__memFoldWas = !!el.open;
      state.openFolds[key] = el.open;
      // ── AN EXPLICIT CLOSE CLEARS THE FOUNDATIONS FORCE (v3.64.1) ──────
      // The one line that makes a close FINAL while an editor is still open.
      // Without it the transient re-forces `open` on the next paint and this
      // listener then records that forced value as the user's own — the loop
      // the maintainer reported as "it reopens itself". Written inline for
      // the reason this block already states twice: `wire` is lifted by
      // brace-matching and executed against a hand-written set of stubs, so a
      // module-level helper named here would be a ReferenceError there.
      if (key === 'foundations' && !el.open) state.fndForceOpen = false;
      try {
        localStorage.setItem('curator-memory-folds-v1', JSON.stringify(state.openFolds));
      } catch { /* private window, blocked site data, quota — the app forgets */ }
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

  // ── "SHOW MORE" ON THE JOURNAL ────────────────────────────────────────
  // Inline, like the fold above it and for the same reason: `wire` is lifted
  // and executed against hand-written stubs, so it may not name a helper. The
  // SECOND copy of these four lines is in `patchOpenPair`, which re-attaches
  // this one listener after it swaps the journal's contents without a render;
  // each site names the other, and `scripts/test-next-memory-switch.js` drives
  // BOTH and requires them to do the same thing, so a change to one that is
  // not made to the other goes red rather than going unnoticed.
  const more = document.getElementById('mem-journal-more');
  if (more) {
    more.addEventListener('click', () => {
      state.journalLimit = JOURNAL_MORE;
      // Re-read the SAME machine we are looking at, not the scope default —
      // otherwise expanding the journal could silently swap which machine's
      // history is on screen if another machine wrote in the meantime.
      const m = state.detail ? state.detail.machine : state.machine;
      // `keepDetail` — see loadScope for the measured mechanism. This is the
      // FIRST of the two "Show more" call sites; the second is in
      // `patchOpenPair`, each names the other, and
      // scripts/test-next-memory-switch.js drives both and requires them to
      // do the same thing — so a flag added to one and not the other is red.
      loadScope(state.scope, m, token, { keepDetail: true })
        .catch((err) => reportAsyncMountFailure(token, err));
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
