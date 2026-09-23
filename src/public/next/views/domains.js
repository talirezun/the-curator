// View: Domains — "your brain". Lists the compounding wikis and hosts the
// Health panel for whichever domain is selected (design spec screens 2 + 3).
//
// Owns views/domains.css. Backend is 100% pre-existing (see the module's
// own fetch helpers below for the exact endpoints) — this file adds no new
// server-side capability, only wiring + presentation.
//
// Data flow: onEnter -> fetchDomainsStats() -> renderSidebar() (rows) and,
// for whichever domain is active, loadHealth(slug) -> scanWiki report ->
// renderMain() (stat cards + health card). The brokenLinks/orphans AI cost
// estimates are fetched (free — they never call an LLM) alongside the
// scan, but ONLY when the scan already found that category's issues, so
// the Quick maintenance buttons can show their cost inline, per the
// design's hard cost-before-action rule.
//
// The semantic-duplicate estimate is the one exception, fetched ON DEMAND
// instead (see confirmSemanticScan) — it costs no tokens either, but
// unlike the other two it can't be gated on a known issue count (nothing
// short of running it knows how many candidate pairs exist), so computing
// it means a real pairwise-similarity pass over every page in the domain.
// Measured on a 3,251-page domain: ~14.9s of UNBROKEN event-loop block —
// every other request, any in-flight ingest SSE stream, and MCP write-
// registry coordination froze for that long. Auto-firing it here (as it
// used to) meant that ~15s hit on every Domains open and every domain
// switch; it now only runs when the user actually opens that specific
// quick-maintenance action.

import {
  registerView, setSidebar, setMain as shellSetMain, eyebrow, emptyCard, icon, escapeHtml, navigate, isCurrentMount,
  reportAsyncMountFailure, reportAsyncActionFailure, isCurrentReader, openReader,
  beginDomainWrite, consumeDomainRequest, NEW_PROJECT_REASON,
} from '../app.js';

// Second import of the SAME module, as a namespace. It was added for one
// thing — the chat-scope handoff — and the reason it is a NAMESPACE import is
// worth keeping even now that the handoff has moved to
// shared/chat-scope.js: a static named import of an export that does not
// exist is a HARD MODULE-LOAD ERROR in ESM, and it takes the entire /next
// shell down to a blank page, which is the precise failure class v3.1.0's
// boot guard exists for. So anything reached through `shell.` here is
// something this view can survive the ABSENCE of, and the two survivors both
// are: `shell.isAnyWriteBusy()` is called inside a try/catch that fails OPEN
// to the server's own guard, and `shell.navigate('memory')` sits beside a
// `requestProject` that has already been recorded. The module is evaluated
// once regardless of how many times it is imported.
import * as shell from '../app.js';

// The paste-into-your-entry-file block, and the banner that confirms it was
// copied. ONE text, shared with the Agent-memory view, the docs suite and any
// future CLI — see that module's header for why it is frozen and what was
// measured. The view's job here is the button and the clipboard, nothing else:
// composing the words in two places is how two model-read instruction sets
// start disagreeing.
import { composeAgentInstructions, composeAgentInstructionsFull, COPY_SUCCESS_BANNER } from '../shared/agent-instructions.js';
// ── THE HANDOFF INTO PROJECT CONTEXT (P1-10) ─────────────────────────────
//
// `navigate()` takes a view name and nothing else, and the memory view's
// arrival path picks the domain by SAVE RECENCY — so a project created a
// second ago, which has no saves at all, is not reached even with the
// remembered-project map written. Rather than ship a control that lands on the
// right project most of the time (the worst property a navigation can have),
// the destination view exports a one-shot request: a module variable it clears
// on read, consulted by `loadIndex` BEFORE `initialPick`, with no storage key
// and no lifetime past one arrival.
//
// A VIEW IMPORTING A PEER VIEW is new here, and it is safe for the reason
// app.js's own registration block states: this file's import of `../app.js` is
// already a cycle, and the constraint is only that nothing may CALL a shell
// function at import time. `requestProject` is a function declaration — so it
// is hoisted and available whichever of the two views evaluates first — and it
// is called from a click handler, long after both have finished evaluating.
import { requestProject } from './memory.js';

// ── THE TWO PANELS THIS PAGE HOSTS (v3.64.0) ─────────────────────────────
//
// ONE PANEL, TWO HOSTS. `views/ingest.js` and `views/shared.js` are still
// registered views reachable by navigate() and by a stored last view; they
// are ALSO sections of this page, mounted through the fixed exports below.
// Nothing in either file moved or was renamed for this — six offline suites
// brace-match named functions out of those two files, so the seam is
// additive by rule (see each file's own host-seam header).
//
// The BUSY PREDICATES are the whole safety argument for hosting a drop zone
// inside a page with three independent stale-while-revalidate layers; see
// hostedSectionsBusy() and setMain() below.
import { mountIngestSection, unmountIngestSection, ingestSectionBusy } from './ingest.js';
import {
  mountSharedSection, unmountSharedSection, sharedSectionBusy,
} from './shared.js';

// The ONE /next Markdown renderer (next/shared/markdown.js). This view and
// views/chat.js are both callers of the same copy — see that module's header
// for the escape-first cardinal rule and for why a wiki page body, which
// arrives over Personal Sync and Shared Brain mirrors, is treated as hostile
// input. Do not add a local renderer here, ever: scripts/test-next-markdown.js
// §0 WALKS the whole src/public/next tree and fails on a second declaration in
// any module it finds, in any form. (That claim used to be false — §0 tested
// a hardcoded three-file list, so a copy pasted into a fourth view passed
// unnoticed. It is a tree walk now, and mutation-proven.)
import { goToChatScoped } from '../shared/chat-scope.js';
import { docsLinkHtml } from '../shared/docs-links.js';
// ── THE OVERVIEW CARD (v3.64.2) ────────────────────────────────────────────
// This page's OVERVIEW is the app's reference design for "the readings ABOUT
// a screen", and the Project-context view now renders the SAME component —
// so the markup moved to shared/overview.js and this view calls it. Nothing
// it emits moved: every `dm-` token this file's listeners, its column patch
// and four suites address by name is still on the same element, as an alias.
//
// IT IS A NEW FREE IDENTIFIER INSIDE `renderStatCards`, which four offline
// suites lift by brace-matching and execute inside `new Function` against a
// fixed stub list — so those four sandboxes inject it, and they inject the
// REAL function rather than a stub, which is what makes their assertions
// about this card assertions about the shipped component.
import { renderOverview } from '../shared/overview.js';
// ── THE SIDEBAR (v3.65.0) ──────────────────────────────────────────────────
// THIS view's sidebar is the reference design — the maintainer's own words,
// against the Context one: *"I suggest we go with the Domains design, which is
// more polished"* — so what moved into the kit is what this file already
// shipped, unchanged in value, and Context and Settings adopt it from there.
// What THIS file gains is nothing visible at all, which is the acceptance
// test: the rendered sidebar is byte-identical to v3.64.2's modulo exactly two
// normalisations — the `cur-sb-*` tokens added beside each `dm-` one, and
// `type="button"` — plus the KNOWLEDGE eyebrow's inline `style="margin-top:
// 10px"`, the one thing in this sidebar no stylesheet could reach, becoming
// `.cur-sb-group-head`. All three are asserted INERT by
// scripts/test-sidebar-status-rows.js §8b rather than claimed.
//
// THEY ARE NEW FREE IDENTIFIERS INSIDE `renderSidebar`, which five offline
// suites lift by brace-matching and execute inside `new Function` against a
// fixed stub list — so those five sandboxes inject them, and they inject the
// REAL kit functions rather than stubs, which is what makes their assertions
// about this sidebar assertions about the shipped component.
import { renderSidebarHead, renderSidebarGroup, renderSidebarRow,
  identityDotClass } from '../shared/sidebar.js';
import { renderMarkdown } from '../shared/markdown.js';
import { formatUsdHonest } from '../shared/format-usd.js';

// The design system's two-layer progress ring. Health's long AI operations
// (broken-link planning, orphan rescue, the duplicate scan, the batch
// merge, the deterministic fix-all) all run for tens of seconds behind a
// button whose only signal today is the word "…". Three of them ALREADY
// stream a real {processed,total} / {done,total} count over SSE that this
// view was throwing away — so the outer ring here is fed by genuine server
// counts, and is `null` (activity only, orbit alone) for exactly as long as
// the server has reported nothing.
import { progressRingHtml, ringValueFromCounts } from '../shared/progress-ring.js';
import { createLoadingGate, gatedLoader, settleGate } from '../shared/loading-gate.js';
import { loadUiState, durableStorage } from '../shared/ui-state.js';

// The shared TEXT system — the five roles in shared/text.js. This view is the
// first adopter, because it is where the defect that motivated the module was
// reported: `renderHealthPanel` welded an action report, a generated readout
// and a static description into ONE <div class="dm-health-body">, and the
// maintainer's own words were that it "doesn't look like a report — it looks
// like a clarification".
//
// TWO AA FAILURES ARE FIXED BY CONSTRUCTION HERE — measured from
// tokens/color.css with var() chains resolved and rgba tints composited over
// their surface, in both themes (the tool is the one in
// test-next-text-system.js §7), and re-measured through getComputedStyle in a
// real browser on both themes, where the two agreed to the second decimal:
//
//   .dm-health-meta      --text-3 on --surface         4.27 dark / 4.14 light
//   .dm-quick-note-busy  --attention-text over
//                        --accent-tint on --surface    9.75 dark / 3.16 light
//
// against a 4.5 floor for normal text. The first is a MEASUREMENT — the scan's
// own entity/concept/summary/dismissed counts — rendered below the readable
// floor. The second is a WARNING sitting directly above the buttons that
// delete pages: FINDING 2 in text.js's header, live in this view and worse
// than the header's own example because of the accent tint underneath.
// Neither is fixed by a colour edit: the roles carry --text and --text-2
// (measured 6.42-18.27 in the browser across both themes), and renderStatus
// puts the status colour on the RAIL, where the floor is 3:1 and attention
// clears it at 10.70 / 3.58.
//
// WHAT IS *NOT* A CONTRAST FIX, stated because the first draft of this block
// claimed it was. The three runtime errors moved here — the sidebar's, the
// health scan's and the browse listing's — all carried `.dm-error-text`, and
// that rule WON the cascade, so they rendered at --danger-text and measured
// 7.80 dark / 5.41 light. They PASSED. Reproducing the original cascade in
// the browser (re-injecting the deleted rule, in a sheet appended last) gives
// rgb(195,51,69) at 5.41 — not the 4.14 an earlier version of this comment
// asserted, which was `.sidebar-hint` WITHOUT the override and therefore a
// measurement of a different element. Moving them to renderStatus is a
// SEMANTIC fix — a failure and a hint stopped being one class plus a colour —
// and it is not sold as an accessibility one.
//
// Do NOT re-grow a local -desc/-hint/-note class in this file.
// scripts/test-next-domains-text.js asserts the import AND executes the real
// render functions; a hand-rolled replacement goes red naming the site.
import {
  renderReadoutGroup, renderDescription, renderStatus, renderViewHeader, renderBadge,
} from '../shared/text.js';
// The ONE age vocabulary, shared with the Ingest sidebar's destination rows —
// see shared/age.js. The KNOWLEDGE rows and the DESTINATION rows list the same
// domains and answer the same question about them, so they say it in the same
// words rather than in two.
import { formatDayAge, freshnessDotHtml, clockGlyph, freshnessTier } from '../shared/age.js';
// ── THE MONITOR (v3.65.0) ────────────────────────────────────────────────
// The ONE treatment for a live-state reading anywhere in the app. The
// maintainer found four of them wearing four designs — the bridge's
// Connected strip, Context's Last saved and CAPTURE blocks, and THIS
// section's five readouts — and his words were: *"it's really hard to
// understand that this is like a monitor into the specific data and changing
// state ... we are looking for a unified design AND a distinguished design"*.
// This view's one adopter is M6, the wiki-health scan's own report.
import { renderMonitor } from '../shared/monitor.js';
// ── THE OWNERSHIP CHOOSER, SHARED WITH THE AGENT-MEMORY VIEW (v3.61.0) ────
//
// "Where do this project's canonical documents come from" is asked here, on
// the create form, and again in Project context's Foundations block for a project
// that has not answered it. The store sets that ownership ONCE and refuses a
// mismatch on every later write, so two copies of the question would be two
// descriptions of WHICH WRITER OWNS A FILE — and a project created with one
// answer and initialised with the other is a refusal the user cannot act on.
// Imported, never re-implemented: shared/foundations-init.js owns the markup,
// the state shape, the request body and the outcome words.
import {
  freshChooser, chooserBody, chooserOutcomeWords, renderFoundationsChooser,
  bindFoundationsChooser, renderRefusedList, SKELETON_SLUGS,
  // `pickedFiles` COUNTS THE SAME THING THE REQUEST WILL SEND. The create
  // card's consequence line (P2-5) quotes how many documents pressing the
  // primary will copy, and deriving that from anything other than the function
  // that builds the wire's own file list is how a sentence comes to promise
  // four and send three.
  pickedFiles,
} from '../shared/foundations-init.js';

// The icon set this view needs (activity, sparkles, chevron-right,
// alert-circle, lock, check) lives in app.js's shared ICON_BODY — see
// icon() below — there is no view-local icon table.

// ── Domain identity colour ────────────────────────────────────────────────
// Domains aren't typed like pages (no entity/concept/summary triad), but
// the design still gives each one a stable colour dot wherever it is named.
// No backend field carries a per-domain colour, so it is a small fixed
// palette assigned by stable list position. Deliberately excludes brand
// violet (reserved for identity/action per the design's "violet means action
// and nothing else" rule).
//
// THIS VIEW NO LONGER OWNS EITHER HALF OF IT (v3.65.1). It had
// `domainDotClass(i) -> 'dm-row-dot-N'`, a second copy of the kit's own
// arithmetic under a second family of names, and views/domains.css held the
// only copy of the twelve colour rules — which views/memory.css then declared
// a second time, byte for byte, because CSS has no per-view scope. Both are
// now ONE thing in the kit: `identityDotClass(i)` in shared/sidebar.js and
// the `.cur-sb-dot-N` block in shared/sidebar.css. That is what makes the
// same domain the same colour on this rail, on the Context rail and
// breadcrumb, on Chat's domain chips and on Ingest's destination rows —
// CONTINUITY BY IDENTITY, one palette and one mapping.
//
// `dm-row-dot-N` is still EMITTED, by the kit's `ALIASES.dm.dotSlot`, and
// resolves no background; scripts/test-next-domain-dots.js reads the slots by
// running identityDotClass and the rules out of shared/sidebar.css, and
// asserts the alias paints nothing.

// ── The KNOWLEDGE row's second line: WHAT the last write was ─────────────
//
// Returns null when the domain has never been written to, so a fresh domain
// gets ONE line of meta rather than one plus a blank.
//
// THE VERB COMES FROM THE LOG. `lastIngestKind` is 'ingest' | 'compile' |
// null on the wire (getDomainStats refuses to pass through a word it does
// not recognise rather than inventing a verb for it), and it is re-narrowed
// HERE as well, because this view renders the stats rows RAW — it keeps
// whatever `GET /api/domains/stats` returned, unlike views/ingest.js which
// re-maps every field through `fetchDomainStats`. A neutral "Last write" is
// the honest rendering of a kind we do not have; guessing "Ingested" on a
// domain that is only ever compiled into is the small false statement this
// whole anatomy exists to stop making.
function domainLastEventText(d) {
  if (!d || !d.lastIngestDate) return null;
  const kind = (d.lastIngestKind === 'ingest' || d.lastIngestKind === 'compile')
    ? d.lastIngestKind : null;
  const verb = kind === 'compile' ? 'Compiled' : kind === 'ingest' ? 'Ingested' : 'Last write';
  const title = (typeof d.lastIngestTitle === 'string' && d.lastIngestTitle) ? d.lastIngestTitle : null;
  return title ? (verb + ' · ' + title) : verb;
}

// ── Health category definitions ───────────────────────────────────────────
// Order matches the design's chip row. `violet: true` marks the one
// exception to "non-zero chips are amber" — the spec calls out orphans
// specifically getting a violet tint when non-zero.
const HEALTH_CATEGORIES = [
  { key: 'brokenLinks', label: 'Broken links' },
  { key: 'orphans', label: 'Orphan pages', violet: true },
  { key: 'crossFolderDupes', label: 'Cross-folder duplicates' },
  { key: 'hyphenVariants', label: 'Hyphen variants' },
  { key: 'folderPrefixLinks', label: 'Folder-prefix links' },
  { key: 'missingBacklinks', label: 'Missing backlinks' },
];
// Auto-fixable types (mirrors src/brain/health.js AUTO_FIXABLE minus the
// pseudo-types orphanLink/semanticDupe, which scanWiki never emits).
const AUTO_FIX_TYPES = new Set(['brokenLinks', 'folderPrefixLinks', 'crossFolderDupes', 'hyphenVariants', 'missingBacklinks']);
// Per the shipping app's invariant, Dismiss appears ONLY on review-only
// rows — auto-fixable issues get "Fix", never "skip". renderIssueRow's
// `dismissible` flag is set true only for orphans and for brokenLinks rows
// that have no suggestedTarget (the only two review-only shapes scanWiki
// emits); every other type stays un-dismissible by construction.

// ── Recovery copy (v3.9.1) ─────────────────────────────────────────────────
//
// Every one of these surfaces used to promise the change was "revertable from
// Sync". THAT CONTROL DOES NOT EXIST AND NEVER HAS. The backend exposes exactly
// status / setup / push / pull / sync / disconnect (src/routes/sync.js) — no
// revert, no discard, no restore — and neither frontend has such a button. Up
// through v3.23.x the Sync view said so two clicks away, in a "Commit history &
// revert are coming soon" card — which the maintainer flagged (v3.24.0) as
// unexplained roadmap noise on an operational panel and which is now gone; the
// same underlying fact (a git client can revert directly, because every sync is
// a real commit) lives behind that view's header info mark instead. Either way,
// the app has never offered — and does not now offer — an in-app revert on the
// panel that launches its most destructive operations.
//
// What IS true is the part underneath: the wiki folder is a git working tree, so
// the change is genuinely recoverable — from a git client, not from the app. But
// only if Personal Sync is configured, because `.knowledge-git` is created by
// sync setup and by nothing else; a user who has never set it up has no history
// to go back to. The copy is therefore CONDITIONAL, not merely softened.
//
// Two variants, because the honest thing to say differs by stakes:
//   NOTE — informational surfaces (an action bar hint, a non-deleting confirm).
//   WARN — confirms for operations that DELETE a page. There, "otherwise this
//          cannot be undone" is the load-bearing half of the sentence.
// Single-sourced so the two cannot drift into disagreeing about what recovery
// exists, and so the next person to add a Health action inherits the true
// wording instead of copying the old promise from a neighbouring string.
// Kept consistent with docs/ai-health.md's "How to actually undo a Health fix".
const GIT_UNDO_NOTE = 'If you use GitHub Sync, changes can be undone with a git client — the app has no Undo button yet.';
const GIT_UNDO_WARN = 'There is no Undo button in the app. If you use GitHub Sync this is recoverable with a git client; otherwise it cannot be undone.';

// ── What a domain IS, said once ────────────────────────────────────────────
// Static prose: identical for every user, read once, and therefore the
// DESCRIPTION role. Single-sourced for the same reason GIT_UNDO_NOTE is —
// the empty state and the domain header both said it, and two hand-written
// copies of one sentence is how they end up disagreeing.
//
// WHAT THIS REPLACED, AND WHY IT IS NOT A READOUT. The domain header used to
// render a GENERATED sentence through `.view-body dm-scope-desc`:
//
//   "A compounding wiki of 379 pages — 41 entities, 331 concepts, 7 summaries."
//
// A live figure in the same class as static copy is the defect text.js was
// written for, so the obvious move was renderReadoutGroup. It was not taken,
// and the reason is measurable rather than aesthetic: that sentence is built
// from `pages, counts.entities, counts.concepts, counts.summaries, otherCount`
// and renderStatCards twelve lines below renders THE SAME FIVE VARIABLES.
// There is no figure in the sentence that the cards do not already show, so a
// readout group here would be the same instrument twice — and it would be the
// WORSE copy, because the cards carry --type-entity/-concept/-summary, the
// graph colours that tie a count to its node type in Obsidian, which
// .tx-readout-value (correctly, deliberately) does not.
//
// So the figures were not restyled, they were DE-DUPLICATED: the cards are the
// instrument, and what is left of the sentence is what it always actually was
// — an explanation of what a domain is. That is this constant.
const DOMAIN_BLURB = 'A domain is one compounding wiki — a subject you read about often. Everything ingested into it updates the pages already there, so the graph gets denser rather than just bigger.';
// MIRROR_BLURB IS NOT A DESCRIPTION AND MUST NOT GO BEHIND THE INFO MARK.
// Its second half — "changes made here are overwritten on the next Pull" —
// is a data-loss notice about the wiki the user is looking at, and
// v3.16.1's rule is that a warning behind a click is not a warning. It is
// therefore split: the sentence that EXPLAINS what a mirror is joins
// DOMAIN_BLURB behind the mark, and the sentence that WARNS renders as an
// unfolded renderStatus box in the body. renderViewHeader has no tone and
// no warning field, so this split is the only shape it can take.
const MIRROR_INFO = 'A read-only mirror of a Shared Brain — synthesised from every contributor’s opted-in pages.';

// ── ① INGEST'S OWN SENTENCE (v3.65.0, R4) ────────────────────────────────
// It was the first line of the fold's BODY, rendered as a description above
// the drop zone. The rule for every numbered section on both pages is now the
// one the maintainer asked for — *"maybe we don't need the first sentence, we
// just need the information icon beside the title"* — so it lives behind the
// mark on the head, closed, and the body is the panel and nothing else.
// A CONSTANT rather than an inline literal, because `renderMain` is lifted by
// brace-matching and executed by four offline suites: a long string in there
// is a string they all have to carry, and this one is quoted by
// scripts/test-next-domains-text.js.
const INGEST_INFO = 'Drop a PDF, markdown or text file. The model turns it into entities, concepts and a summary, and compounds them into the pages you already have.';
const MIRROR_WARNING = 'Fix issues in your personal contributing domain instead; changes made here are overwritten on the next Pull.';

// ── Module state ───────────────────────────────────────────────────────────
// Kept at module scope (not reset on every onEnter) so switching away to
// another view and back preserves which domain was open — matches how
// app.js's own `state` persists across navigate() calls.
const state = {
  loaded: false,
  loadError: null,
  domains: [],            // raw stats rows from /api/domains/stats, in list order
  readonlySet: new Set(),
  activeSlug: null,

  health: null,           // scanWiki() report for activeSlug, or null
  healthLoading: false,
  // Which domain state.health was scanned FOR. Load-bearing, not
  // bookkeeping: `state` is module-scoped and survives remounts, so
  // without it a cached report could be rendered under a DIFFERENT
  // domain's heading — a correctness bug strictly worse than the flicker
  // the stale-while-revalidate below exists to remove.
  healthSlug: null,
  // True while a cached report is on screen and a rescan is running behind
  // it. Purely a label; it never gates an action.
  healthStale: false,
  healthError: null,
  healthSummary: {},      // slug -> total open issue count, populated as each domain is scanned (sidebar attention dot source — see report)

  aiAvailable: false,
  aiProvider: null,
  aiModel: null,
  estimates: {},          // 'brokenLinks' | 'orphans' | 'semanticDupes' -> result object | 'loading' | 'error'

  expandedGroups: new Set(),   // category keys (+ 'dismissed') currently expanded
  dismissedRecords: null,      // lazily loaded full dismissal list for the active domain

  confirm: null,          // { title, body, confirmLabel, run }
  busyKey: null,          // action key currently in flight, or null
  progressText: null,     // present-participle status line while busy
  // Live SSE counts for the operation named by busyKey, or null.
  //   { key, processed, total }
  // `key` is stamped so a frame arriving late from an operation the user
  // has already moved on from cannot drive the ring of a DIFFERENT one —
  // the same slug-stamp discipline semanticScan uses, for the same reason.
  aiProgress: null,
  banner: null,           // { tone: 'success'|'error'|'info', text }

  pendingPlan: null,      // { kind: 'brokenLinks'|'orphans', plan, summary }

  // Semantic-duplicate scan result. STAMPED WITH THE SLUG IT WAS SCANNED
  // FOR — see activeSemanticScan() for why that stamp is load-bearing and
  // not merely tidy.
  //   { slug, pairs: [{keepFolder, keepSlug, removeFolder, removeSlug,
  //                    confidence, rationale, status}],
  //     cost, previewed: Set<pairKey>, preview: {key, data|error}|null }
  semanticScan: null,

  // Domain create/rename/delete form state (one at a time).
  //   { mode: 'create'|'rename'|'delete', slug?, displayName, description,
  //     template, busy, error, refusal }
  lifecycle: null,

  // Wiki page browser for the active domain. Stamped with its slug for the
  // same reason semanticScan is — see activeBrowse().
  //   { slug, loading, error, entries, truncated, total, filter, folder }
  browse: null,

  // ── Knowledge folder (GET /api/config) ─────────────────────────────────
  // { domainsPath, domainsPathSource } or null before the first read. Read
  // here, in the view an EXISTING user lands on, rather than only in
  // Settings — see the "Where is my knowledge base" section below.
  kb: null,
  kbBusy: false,          // a picker is open, or a switch is being applied
  // The outcome of the LAST folder switch this session, or null.
  //   { state: 'success'|'attention'|'danger', title, detail,
  //     undoPath?: string }
  // `undoPath` is the folder we were pointed at BEFORE the switch, present
  // only when there is somewhere to go back to and going back is useful.
  kbNotice: null,

  // ── Projects inside the active domain (v3.48.0) ────────────────────────
  //
  // A DOMAIN is where knowledge lives; a PROJECT is a thing you build inside
  // it, and it is what agent memory is kept per. Loaded from
  // GET /api/memory/:domain/projects.
  //
  // STAMPED WITH ITS SLUG, for exactly the reason state.semanticScan and
  // state.browse are: `state` here is module-scoped and survives leaving the
  // view, so an unstamped list could be rendered under a DIFFERENT domain's
  // heading — and this list carries a Delete button, so the consequence is
  // not a cosmetic one.
  //   { slug, loading, error, rows, truncated, canWrite, readonly }
  projects: null,

  // Project create/rename/delete/brief form state, one at a time. Mirrors
  // state.lifecycle exactly (same card shape, same busy/error fields, same
  // "read state, never the DOM" rule) rather than inventing a second
  // vocabulary for the same job.
  //   { mode: 'create'|'rename'|'delete'|'brief', slug, project?, name,
  //     brief, confirmText, busy, error, refusal }
  projectLc: null,

  // The last copy outcome from a project row, or null:
  //   { kind: 'marker'|'agent', project, ok, text }
  // Cleared on the next render that changes anything else, because a copy
  // confirmation that outlives the click reads as a state rather than as an
  // acknowledgement.
  //
  // ONE SLOT FOR BOTH ACTIONS, not two. They are mutually exclusive by
  // construction — a click replaces whatever the last one left — so a second
  // field could only ever hold a stale confirmation for the button you did
  // NOT just press, sitting under the one you did. `kind` says which, and
  // `text` is what actually reached the clipboard, which is what the refusal
  // path has to show.
  copied: null,

  // ── THE PER-DOMAIN SESSION CACHE (stale-while-revalidate) ──────────────
  //
  // THE REPORTED DEFECT, measured on the maintainer's 3,445-page `articles`
  // wiki before any of this existed (CDP, 1440x900, a rAF sampler on
  // `.dm-browse-card.getBoundingClientRect().height` plus a MutationObserver
  // on `#view-root`):
  //
  //   ENTERING the view   the card painted FULL at 16 ms from the state this
  //                       module had kept, sat there for eight tenths of a
  //                       second, and then collapsed 585 px -> 26 px at
  //                       834 ms and re-expanded at 844 ms. That late blink
  //                       is the reported one, and its cause was ORDERING:
  //                       loadBrowse ran after `await loadHealth`, i.e. after
  //                       a 750 ms whole-tree scan, and threw away a list it
  //                       was about to re-fetch identically.
  //   SWITCHING domain    26 px for ~60 ms (browse) and 89 px for 380-800 ms
  //                       (health), i.e. a 521-559 px collapse and re-expand,
  //                       seven `#view-root` replacements per switch.
  //
  // So the list and the project rows for a domain are KEPT, per slug, for the
  // session, and a switch back to one paints them immediately while a
  // revalidation runs behind it. `at` is the wall clock of the last
  // successful fill; nothing branches on it today, and it is recorded because
  // a cache with no age is a cache nobody can reason about later.
  //
  //   cache[slug] = { browse: {entries, memory, memoryTruncated, truncated,
  //                            total, window}, projects: {rows, truncated,
  //                            canWrite, readonly}, at }
  //
  // CORRECTNESS. This is a THIRD copy of data that is already slug-stamped
  // twice, so it is deliberately the WEAKEST of the three: it is keyed by
  // slug, it is only ever read for the slug it is keyed under, and what it
  // seeds is re-stamped with that same slug — so activeBrowse() and
  // activeProjects(), the existing LAYER 2, still independently refuse to
  // paint it under any other domain. A cache entry can therefore make the
  // screen STALE (bounded by the revalidation that always follows it); it
  // cannot make the screen WRONG.
  //
  // WHAT IS DELIBERATELY NOT CACHED. The health report — `selectDomain`
  // passes no keep flag to loadHealth and must not, because
  // scripts/test-next-loading-gate.js §7b pins "a domain SWITCH takes the
  // clearing path" as a safety property. The health panel's contribution to
  // the blink is closed by RESERVING ITS HEIGHT instead (see state.reserve),
  // which removes the jump without ever showing a figure that is not the one
  // this domain's own last completed scan produced.
  cache: Object.create(null),

  // The height, in CSS pixels, of the browse card and the health card as they
  // were LAST PAINTED WITH CONTENT. A placeholder that replaces one of them
  // reserves that height instead of collapsing to its own intrinsic size.
  //
  // MEASURED FROM THE DOM rather than hardcoded, because the right number is
  // a property of the domain you are leaving and the one you are arriving at,
  // and those differ: articles' browse card measured 585 px against projects'
  // 547, and their health cards 452 against 333. A fixed reserve would be
  // wrong for one of every two domains. Captured in render(), which runs
  // BEFORE setMain replaces the column, and never from a card that is itself
  // reserving (that would ratchet the number down to the placeholder's own
  // height on the second switch).
  //   { browse: number, health: number }
  reserve: null,

  // ONE-SHOT ENTER-ANIMATION TOKEN. `{ key, used }` — a block whose content
  // lands AFTER the view-enter animation has already ended (a first, uncached
  // page list; a health report after a 750 ms scan) fades itself in on that
  // FILL ONLY. Written by the loader that produced the fill, consumed by the
  // first render that paints it, so a later re-render of the same content
  // does not fade again — a block that re-animates on every repaint is the
  // flicker this release is removing, wearing a nicer coat.
  reveal: null,

  // ── THE DOMAIN PAGE'S READING PREFERENCES (v3.64.0; INSTALL-WIDE v3.64.1)
  // `{ sources?: bool, shared?: bool, lens?: 'wiki'|'context'|'all' }` — ONE
  // row, not one per domain: which folds a domain page opens with, and which
  // lens its page list is showing. Read once at module load (below) and
  // written on every toggle; an ABSENT field is the designed default, never a
  // fallback: INGEST opens on a domain that has never been ingested into and
  // is closed once it has, and the lens starts on the wiki. See
  // SECTION_PREFS_KEY for why this stopped being keyed by domain.
  sectionPrefs: null,

  // The last lens reading views/shared.js reported for the domain on screen
  // — `{enabled, kind, contributingCount, mirrorCount}` or null before the
  // panel has loaded. It decides ONE thing: whether OVERVIEW's SHARED jump
  // is warranted. Never a connection object; the panel owns those.
  sharedLens: null,

  // That reading, derived once by sharedJumpReading() — `{show, value}`. The
  // markup and the no-repaint reveal both read THIS, so the tile the paint
  // draws and the tile the panel reveals cannot disagree.
  sharedJump: null,

  // ④'s head reading (v3.65.3), derived once by sharedHeadReading() from the
  // same report — '' until the panel has reported, and never a guess. The
  // markup reads THIS and the no-repaint write in onSharedLensChange() writes
  // the same string, so the next patch finds the two byte-equal.
  sharedReading: '',
};


// `state` above is DELIBERATELY module-scoped and NOT reset on every
// onEnter (so leaving Domains and coming back preserves which domain was
// open), which means none of the "did the user switch domain?" checks
// already in this file (the `slug !== state.activeSlug` guards below) catch
// the case that actually broke: the user leaves the DOMAINS VIEW entirely
// for another view while a fetch is in flight. `state.activeSlug` doesn't
// change just because the view unmounted, so those existing guards stayed
// satisfied and a stale response clobbered whatever the new view had
// already painted — reproduced by opening Domains, immediately clicking
// Chat, and watching the health scan (or the ~15s semantic-dupe estimate,
// see H4) land on top of Chat a moment later.
//
// H1 re-audit fix: this variable is `myMountToken` and every guard in this
// file used to read it LIVE (`isCurrentMount(myMountToken)`), including
// from inside functions resuming after an await — which is exactly the bug
// this comment used to claim was closed and wasn't. `myMountToken` gets
// OVERWRITTEN by the next mount (including a re-entry into Domains itself),
// so a function that reads it late, after its own await, sees whatever the
// LATEST mount wrote, not the mount it actually started under. Every async
// function below now captures its own token as a local variable at entry
// (before any await) — from onEnter's parameter for the top-level
// loadDomainsList(), or from this variable for anything invoked
// SYNCHRONOUSLY by a real click (safe: nothing can re-mount between a click
// firing and the very next line of JS running) — and threads that local
// through to every render call and nested async call it makes, rather than
// re-deriving it later. Every other same-view raciness guard in this file
// (slug comparisons, `state.dismissedRecords = null` resets, etc.) is
// unrelated and stays exactly as it was.
let myMountToken = 0;

// Delay-gated loading indicators for this view. Built in onEnter, cancelled
// in the teardown. See shared/loading-gate.js.
let loadGate = null;

// MEDIUM-5 fix (re-audit): tracks domains with a destructive WRITE
// genuinely in flight against the real backend. Deliberately survives this
// view's teardown — `busyKey` is reset there (see the M2 fix on
// registerView below) so a fresh mount's buttons aren't stuck disabled
// just because the user navigated away mid-action, but the underlying
// fetch/SSE stream doesn't stop just because the UI stopped watching it.
// Without this, navigating away during "Fix all safe" and back rendered
// every quick-maintenance button on that domain fully enabled while the
// original write was still hitting disk — a second click started a
// genuinely concurrent SECOND write (the backend's write-registry 409s
// it, so nothing corrupts, but the user just sees a confusing error
// instead of "one is already running, please wait"). Keyed by domain slug
// so a write in flight on domain A never disables domain B's own actions.
const inFlightWriteSlugs = new Set();

// MEDIUM-1 fix (this session): the five destructive write flows below —
// runFixSafe, fixAllOfType, applyPendingPlan (both broken-links AND
// orphans), and runMergeSemanticDuplicates — now ALSO register with the
// shell-wide write gate via beginDomainWrite() (app.js), acquired right
// after the operation starts and released unconditionally in each
// function's own `finally`. This is a DIFFERENT mechanism from
// inFlightWriteSlugs above, and this view needs BOTH — deleting either
// on the assumption it's now redundant would reopen a real bug:
//   - inFlightWriteSlugs (this view's own module-level Set) is what keeps
//     THIS view's own quick-maintenance buttons disabled across a remount
//     of THIS view (Domains -> another view -> back to Domains, mid-write)
//     — see the MEDIUM-5 comment above for why a fresh mount's `busyKey`
//     alone can't do that (busyKey resets on teardown; the real backend
//     write doesn't stop just because nobody's watching it).
//   - beginDomainWrite()'s shell-wide gate is what lets OTHER views (Sync,
//     Settings) know a write is running on THIS domain and disable THEIR
//     OWN controls accordingly. Before this fix, Sync's Push/Pull/Sync-now/
//     Disconnect buttons stayed fully enabled for the whole duration of a
//     Health write, and the user got a raw backend 409 (from routes/
//     sync.js's guardConcurrent() -> hasActiveWrites()) instead of a
//     disabled button with an explanation — reproduced live with a hung
//     fix-all-safe: all four Sync buttons [ENABLED] while the shell gate
//     reported { any: false }.
// Domain key: the PLAIN slug string (the `slug` parameter every one of
// these functions already takes), matching exactly what src/routes/
// health.js's own registerWrite(domain, ...) calls key on — `domain` is
// `req.params.domain`, i.e. the same plain slug, in every mutating handler
// in that file: POST /:domain/fix, /broken-links/apply, /orphans/apply,
// /fix-all-safe, /semantic-dupes/merge-batch, /fix-all. Cited by route,
// not by line number — line numbers rot, which is exactly what put a
// false claim here (see below). Never a composite key, so client and
// server can never disagree about which domain is busy.
// CORRECTED (MEDIUM-2, this session): a prior version of this comment
// claimed POST /:domain/fix — the route fixAllOfType below actually
// calls — had "NO registerWrite() of its own" and was unprotected against
// a concurrent sync/update. Re-verified directly against the current
// src/routes/health.js: that route checks isUpdateInProgress(), calls
// registerWrite(domain, 'health-fix'), and acquires the per-domain file
// lock before doing any work — identically to its five siblings above.
// There is no discrepancy and nothing to decide; the prior text sent
// whoever read it to re-open a hole that was already closed. See
// fixAllOfType's own comment below, corrected alongside this one.


// ═══════════════════════════════════════════════════════════════════════════
// THE HOSTED SECTIONS — INGEST and SHARED BRAIN, inside this page (v3.64.0)
// ═══════════════════════════════════════════════════════════════════════════
//
// ── WHY EVERY NEW IDENTIFIER IS REACHED FROM HERE AND NOT FROM renderMain ─
// THREE offline suites lift this file's `renderMain` (and one lifts `render`)
// by brace-matching the source and EXECUTING it inside `new Function` against
// a hand-written list of stubs — scripts/test-next-domain-card-order.js,
// scripts/test-next-domain-pages.js and scripts/test-next-domains-swr.js. A
// new free identifier inside either function is a ReferenceError in those
// sandboxes, i.e. a suite that CRASHES instead of asserting. Two of those
// three are not this package's to edit.
//
// So the seam is placed where every sandbox already stubs it: `setMain`. The
// shell's own setMain is imported under its real name (`shellSetMain`) and
// the name `setMain` is this module's own wrapper — so `renderMain` still
// calls `setMain(html, token)`, exactly as it did, its identifier set is
// byte-for-byte unchanged, and every existing sandbox keeps intercepting the
// paint at the same place. The fold shells themselves are written INLINE in
// renderMain for the same reason, and say so there.
//
// ── THE SAFETY RULE (D-J) ────────────────────────────────────────────────
// v3.46.0's defect: `dragover` fires continuously, the first one re-rendered,
// setMain replaced #view-root's innerHTML, and THE DROP TARGET WAS DESTROYED
// MID-DRAG — drag-and-drop simply did not work in the Mac app. The rule that
// fixed it lives inside views/ingest.js ("while a drag is in progress this
// view MUTATES, it never re-renders"). This page puts that zone under a
// SECOND, unrelated re-render source, so the rule has to become something
// this host obeys rather than a comment in a file it does not read.
//
// EVERY PATH THAT CAN REACH renderMain WHILE A HOSTED PANEL IS LIVE, enumerated
// (the record surveyed them; this is the list):
//   1. loadDomainsList's commit + its gate settle        (:868, :933)
//   2. loadKnowledgeBase / onChooseKnowledgeFolder / applySwitchedFolder /
//      onUndoKnowledgeFolder                             (:1145-:1243)
//   3. loadHealth — entry, revalidation and its settle    (:1374, :1405)
//   4. loadEstimates                                      (:1429, :1439)
//   5. loadProjects — entry and revalidation              (:2460, :2503)
//   6. loadBrowse — entry, revalidation and its settle    (:3884, :3964-5)
//   7. selectDomain (a domain switch)                     (:2345)
//   8. the domain/project lifecycle forms and their runs  (:1629-:1764, :4503-:4775)
//   9. the page-list filter box, facet chips and OVERVIEW tiles (:4925, :4974)
//  10. every health action, AI plan, SSE progress frame and semantic-scan
//      step                                              (:5910-:7012)
//  11. the loading gate's own onChange, on every mount    (:7184)
//  12. app.js's cross-view write gate is NOT one: this view does not
//      subscribe to it (views/ingest.js does).
// All twelve go through render() -> renderMain() -> setMain(), which is why
// ONE wrapper covers all of them.
//
// While either panel is busy this page PATCHES: it replaces the main column's
// changed children one by one and NEVER TOUCHES the two host sections, so the
// drop target keeps its node identity. It never SKIPS a paint — a quiesce
// that skipped would leave the loading gate's placeholder on screen over a
// card that has already loaded (SCENARIOS' "Domains 3"), which is why the
// fallback when a patch cannot map is a full repaint rather than nothing.

/** The one localStorage key this view owns: which of the two hosted folds are
 *  open, and which lens the page list is showing. Validated on read; a blocked
 *  or hostile store degrades to the designed defaults.
 *
 *  ── INSTALL-WIDE SINCE v3.64.1, AND THAT IS THE DEFECT IT CLOSES ─────────
 *  v3.64.0 remembered all three PER DOMAIN, and the maintainer reported the
 *  consequence on the first day: he opened INGEST, switched domain, and it was
 *  shut again — because a preference keyed by domain is not a preference, it
 *  is twelve of them, and a person who wants the ingest drop zone in front of
 *  them wants it in front of them everywhere. The same holds for SHARED BRAIN
 *  and for the PAGES lens: each is a statement about how this person reads a
 *  domain page, not about any one domain.
 *
 *  THE KEY DID NOT MOVE, and the SHAPE did not either — a row is still
 *  `{sources?, shared?, lens?}` under a key, and the key is now the literal
 *  `*`. That keeps `readSectionPrefs`'s validation and every storage-census
 *  entry true, and it is what lets the OLD per-domain shape be read rather
 *  than discarded: a stored file written by v3.64.0 is folded into the one row
 *  on the next read and superseded by the next write.
 *
 *  ① INGEST LEFT THIS KEY IN v3.65.2. It is no longer a fold — always open,
 *  no chevron — so there is nothing to remember about it, and the derived
 *  "open on a never-ingested domain" default went with the fold. The row is
 *  now `{shared?, lens?}`; a stored `sources` from an older copy is ignored
 *  on read and falls out of the file on the next write.
 *
 *  THE WRITE IS DUPLICATED AS A LITERAL in selectBrowseFacet, and that is
 *  deliberate, for the reason views/memory.js records for its own fold key:
 *  that function is LIFTED by brace-matching into a suite sandbox, so a call
 *  to a module-level helper there would be a ReferenceError — a crash rather
 *  than a failing assertion. The literal is pinned against this constant by
 *  scripts/test-next-domain-sections.js. */
const SECTION_PREFS_KEY = 'curator-domain-sections-v1';
const SECTION_LENSES = ['wiki', 'context', 'all'];
/** The one row's key. A literal that no domain slug can collide with:
 *  `isValidDomain` admits letters, digits, hyphens and underscores, never an
 *  asterisk — so a v3.64.0 file's rows and this one can never be confused for
 *  each other, which is what makes the migration below readable at a glance. */
const SECTION_PREFS_ROW = '*';
/** The ids the fold shells carry. The HOST elements are what the panels own;
 *  the FOLD elements are what the patch refuses to touch. */
const SOURCES_FOLD_ID = 'dm-sources-fold';
const SOURCES_HOST_ID = 'dm-sources-host';
const SHARED_FOLD_ID = 'dm-shared-fold';
const SHARED_HOST_ID = 'dm-shared-host';

/**
 * The stored file → ONE row, `{sources?, shared?, lens?}`.
 *
 * ── IT READS BOTH SHAPES, AND THE OLD ONE IS FOLDED RATHER THAN DROPPED ───
 * Every installed copy of v3.64.0 wrote one row per domain. Discarding them
 * would mean the release that makes the preference stick starts by forgetting
 * it, which is the opposite of the complaint. So every row is read in stored
 * order and each of the three fields takes the LAST value that names it.
 *
 * LAST, not first, not a majority, and the honest reason is that the old shape
 * carries NO RECENCY — there is no stamp in it, and key order is insertion
 * order (the order the domains were first touched), not the order they were
 * decided. Any fold of many rows into one has to pick; this one picks
 * deterministically, states that it is a one-time best effort, and is
 * superseded by the very next toggle the user makes. It runs at most once per
 * install: the first write after it replaces the file with the single row.
 *
 * VALIDATION IS UNCHANGED and applies to both shapes: only the literal true or
 * false under a known fold name, only one of three known lens values.
 * Everything else degrades to the designed default rather than to a guess.
 */
function readSectionPrefs() {
  try {
    const raw = localStorage.getItem(SECTION_PREFS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const row = {};
    for (const key of Object.keys(parsed)) {
      const v = parsed[key];
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      // `sources` IS NO LONGER READ (v3.65.2, I1). ① Ingest stopped being a
      // fold, so a stored `sources: true|false` from v3.64.x–v3.65.1 means
      // nothing any more. It is dropped HERE, on read, rather than carried:
      // the row this returns is what the next write stores, so the retired
      // field leaves the file on the next toggle of anything else, and until
      // then it is simply never consulted. No migration write — see below.
      // `shared` IS NO LONGER READ EITHER (v3.65.3). ④ Shared Brain went
      // the way ① did: always open, no fold, nothing to remember. Dropped on
      // read, gone from the file on the next write, no migration write.
      if (SECTION_LENSES.includes(v.lens)) row.lens = v.lens;
    }
    // THE MIGRATED FILE IS NOT WRITTEN HERE. This runs at module load, before
    // anything on screen; writing from a read would mean an install that only
    // ever LOOKS at the domain page rewrites its own storage, and a read that
    // writes is the shape nobody expects to find. The next toggle writes it.
    return row;
  } catch {
    // localStorage THROWS rather than returning null in a private window.
    return {};
  }
}

// ── READ ONCE, AND *HERE*, WHICH IS A CORRECTNESS RULE ────────────────────
// This line lived immediately under the `state` literal in the first cut, a
// few hundred lines ABOVE `SECTION_PREFS_KEY`. `readSectionPrefs` is a
// hoisted function declaration so it was callable — but the `const` it reads
// was still in its TEMPORAL DEAD ZONE, so the call threw, the try/catch that
// exists for a private window swallowed the ReferenceError, and every domain
// read back "no preference at all". FOUND IN THE BROWSER: the fold state was
// written to localStorage correctly and then ignored on the next load, in
// silence, with nothing on screen or in the console to say so. It sits after
// the declarations it depends on, and scripts/test-next-domain-sections.js
// pins that order — a dead zone is a fact about source order, so the guard
// is one too, with the swallow itself driven as its control.
state.sectionPrefs = readSectionPrefs();

/** Write the one row back under the one key, which is also what completes the
 *  migration: whatever per-domain rows the file held are replaced by this. */
function writeSectionPrefs() {
  try {
    localStorage.setItem(SECTION_PREFS_KEY,
      JSON.stringify({ [SECTION_PREFS_ROW]: state.sectionPrefs || {} }));
  } catch { /* private window, blocked site data, quota — the app forgets */ }
}

/** The one row, created on demand. Never returns null, so every caller can
 *  write into it without re-checking.
 *
 *  IT STILL TAKES A SLUG AND STILL IGNORES IT (v3.64.1). The argument is kept
 *  so every call site reads unchanged — three of them sit inside functions
 *  that scripts/test-next-domain-sections.js lifts and executes — and because
 *  the day this becomes per-domain again is a day somebody will want the slug
 *  back. It is documented as ignored rather than deleted so nobody reads a
 *  passed slug as a promise that it is honoured. */
function sectionPrefsFor(_slug) {
  if (!state.sectionPrefs || typeof state.sectionPrefs !== 'object') state.sectionPrefs = {};
  return state.sectionPrefs;
}

// Which element each panel is mounted into, and for which domain. Module
// level, not `state`: this is a fact about the live DOM, and `state`
// deliberately survives a teardown while the DOM does not.
let mountedSourcesEl = null;
let mountedSourcesDomain = null;
let mountedSharedEl = null;
let mountedSharedDomain = null;
// True once a paint has been patched around a busy panel, so the page can
// rebuild itself once, cleanly, the moment the panel goes idle.
let quiescedWhileBusy = false;
// ── FOLD TOGGLES THIS PAGE CAUSED ITSELF (v3.64.1) ────────────────────────
// A `<details>` fires `toggle` for a programmatic `open` change exactly as it
// does for a click, and the listener that hears it writes the user's
// preference. So a page that carries its own DERIVED default across a domain
// switch would record that default as an explicit choice — the same shape as
// the Context view's self-reopening documents fold, found the same day.
//
// A QUEUE, not a boolean and not a timer. The event is fired in a task of its
// own, so a flag cleared synchronously after the assignment would already be
// gone by the time the listener ran; and two folds can be written in one
// paint, so a single flag would suppress one write and leak the other. One
// entry is pushed per programmatic write and one is taken per event, in
// order, which is exactly the arithmetic the DOM guarantees.
const programmaticFolds = [];

/**
 * Would replacing the main column destroy something a hosted panel is in the
 * middle of? (D-J.)
 *
 * The two predicates are the AUTHORITATIVE reading — each panel answers about
 * its own state and each returns false whenever it is not mounted here, so a
 * drag that was in progress when a panel came down cannot quiesce this page
 * for the life of the mount. `onBusyChange` is an edge notification, never
 * the answer.
 */
function hostedSectionsBusy() {
  try {
    return ingestSectionBusy() || sharedSectionBusy();
  } catch {
    // A panel that throws from its own predicate must not take this page
    // down; the fail-safe direction is "not busy", which repaints — the
    // behaviour this page had before the panels existed.
    return false;
  }
}

/**
 * Replace the main column's CHANGED children and leave every unchanged one
 * exactly where it is — same nodes, same listeners, same scroll positions,
 * same drop target.
 *
 * ── IT RUNS ON EVERY PAINT NOW, NOT ONLY WHILE A PANEL IS BUSY (v3.64.1) ──
 * MEASURED ON MAIN, in a browser against a three-domain copy of the real
 * store, counting `#view-root` child replacements per switch: a CACHED switch
 * replaced the whole column 3–4 times and a COLD one SEVEN times. Each of
 * those is `innerHTML =` on the column — every section destroyed and rebuilt,
 * every enter animation replayed, every list scrolled back to the top —
 * because the domain page paints once on the switch and again as each of
 * health, projects and the page list lands. That is the "switching domains
 * flickers, pages and other data visibly repaint" the maintainer reported;
 * the DATA was already right, it was being redrawn three more times than it
 * moved.
 *
 * With the patch on every paint, a landing load replaces only the section it
 * changed. The first paint of a new domain still replaces the column — every
 * section's content genuinely differs — and the three that follow it replace
 * one child each.
 *
 * ── THE BUSY RULE IS UNCHANGED AND STILL ABSOLUTE (D-J) ──────────────────
 * While a hosted panel is busy — a drag held over the INGEST drop zone, a
 * running batch, a Shared Brain push — that fold is SKIPPED entirely, so its
 * node identity survives the paint. While nothing is busy the fold is an
 * ordinary child and is replaced when its markup moved, which is what keeps
 * its summary ("last ingest 3 days ago") honest across a domain switch;
 * `mountHostedSections` re-points the panel afterwards, which its own contract
 * already covers ("A NEW ELEMENT is a real remount").
 *
 * ── AND IT NEVER WRITES A LOADER OVER LOADED CONTENT ─────────────────────
 * Only while a panel is busy, where replacing real content with a ghost
 * mid-drag would be a worse flicker than the one being removed. Outside that,
 * a section going from content to its own loading state IS the honest paint:
 * on a domain switch the content that is there belongs to the domain being
 * left, and this file's oldest invariant is that domain A's rows never appear
 * under domain B's heading.
 *
 * Returns true when the paint has been delivered this way, false when the
 * column's SHAPE moved (a different branch of renderMain, a knowledge notice
 * appearing, a domain that vanished) and a positional patch would therefore
 * put a section in the wrong place. A false answer is a full repaint, never a
 * dropped one — and every check happens BEFORE the first write, so a refused
 * patch never leaves half a column behind.
 */
function patchMainAroundHosts(html, token) {
  if (typeof document === 'undefined' || !document.getElementById || !document.createElement) return false;
  // A paint from an abandoned mount is dropped here exactly as setMain drops
  // it — reporting it as "patched" is correct: nothing should reach the DOM.
  if (!isCurrentMount(token)) return true;
  const root = document.getElementById('view-root');
  const live = root && root.firstElementChild;
  if (!live || !live.classList || !live.classList.contains('main-inner')) return false;
  const next = document.createElement('div');
  next.innerHTML = html;
  // ── THE INCOMING CHILDREN ARE SNAPSHOT INTO AN ARRAY, AND THAT IS A
  // CORRECTNESS RULE RATHER THAN A STYLE ──────────────────────────────────
  // `next.children` is a LIVE HTMLCollection, and `replaceChild` below MOVES
  // a node out of it into the live column — so reading it by index while
  // replacing from it walks a list that is shrinking under the loop. Every
  // index after the first replacement points one element too far, which is
  // how a patch comes to compare the page list against Projects and the
  // INGEST fold against the section above it. FOUND IN THE BROWSER, by the
  // mandatory drag measurement: with only the last section changed the bug
  // is invisible (nothing is removed before the host), and pressing an
  // OVERVIEW figure — which repaints the stat cards, i.e. the FIRST section
  // that differs — shifted every later index by one, the id check refused,
  // and the whole column repainted with a drag held over it. `live.children`
  // is also live but never changes LENGTH here, so it is read directly.
  const incoming = Array.prototype.slice.call(next.children);
  if (incoming.length !== live.children.length) return false;
  // ── THE SHAPE IS CHECKED IN FULL BEFORE ANYTHING IS WRITTEN ─────────────
  // A patch that refused halfway would leave the column half old and half
  // new, which is worse than either. The only refusal reason is a host fold
  // that moved, so this pass looks for exactly that.
  for (let i = 0; i < incoming.length; i++) {
    const before = live.children[i];
    const after = incoming[i];
    const hosted = before.id === SOURCES_FOLD_ID || before.id === SHARED_FOLD_ID
      || after.id === SOURCES_FOLD_ID || after.id === SHARED_FOLD_ID;
    // The one rule. If the two trees disagree about WHICH host sits here, the
    // shape moved and this patch would be a lie.
    if (hosted && before.id !== after.id) return false;
  }
  // `protect` is taken ONCE, before the write, so a panel that goes idle
  // between two children cannot leave one fold skipped and the other
  // replaced. D-J's rule in one variable.
  const protect = hostedSectionsBusy();
  for (let i = 0; i < incoming.length; i++) {
    const before = live.children[i];
    const after = incoming[i];
    const hosted = before.id === SOURCES_FOLD_ID || before.id === SHARED_FOLD_ID
      || after.id === SOURCES_FOLD_ID || after.id === SHARED_FOLD_ID;
    if (hosted) {
      // ── A HOSTED FOLD IS NEVER REPLACED, BUSY OR IDLE ──────────────────
      // While a panel is busy this is D-J: the drop target has to be the same
      // node object it was before the paint. While it is IDLE the reason is
      // different and just as binding — the fold's BODY belongs to the panel,
      // which has written its own markup into the host since this page last
      // composed it, so the freshly-composed fold (an empty host) can never
      // be byte-equal to the live one. Comparing them replaces the fold on
      // every single paint, which remounts the panel on every single paint.
      // MEASURED before this branch existed: on a cached domain switch both
      // folds were replaced twice and on a cold one four times each.
      //
      // So the ownership is split where it actually lies: the panel owns the
      // body, and this page owns the SUMMARY — the numeral, the title and the
      // meta reading ("last ingest 3 days ago"), which belong to the domain
      // and must not go stale across a switch. Only that child is patched.
      if (protect) continue;
      const liveSummary = before.firstElementChild;
      const nextSummary = after.firstElementChild;
      if (liveSummary && nextSummary
        && liveSummary.tagName === 'SUMMARY' && nextSummary.tagName === 'SUMMARY'
        && liveSummary.outerHTML !== nextSummary.outerHTML) {
        before.replaceChild(nextSummary, liveSummary);
      }
      // ── AND THE DERIVED DEFAULT, WHEN THERE IS NO PREFERENCE ───────────
      // With a stored preference the two trees always agree about `open`, so
      // this does nothing. With NONE, the incoming value is the DERIVED
      // default — INGEST opens on a domain that has never been ingested into
      // — and a switch between a mature domain and a fresh one has to carry
      // it across. Written through `programmaticFolds` because a `<details>`
      // fires `toggle` for an attribute change exactly as it does for a
      // click: without the suppression, this page would record its own
      // derived default as the user's explicit choice, which is the shape of
      // the self-reopening fold defect found on the Context view the same
      // day.
      // ONLY A REAL `<details>` HAS AN `open` TO CARRY (v3.65.2). ① Ingest
      // is a `<section>` now: its `before.open` is `undefined`, which is never
      // equal to `hasAttribute('open')`'s `false`, so without this check every
      // idle paint would push a phantom 'sources' echo onto the queue and set
      // an expando on the section — harmless today only by luck.
      if (before.tagName === 'DETAILS' && typeof after.hasAttribute === 'function'
        && before.open !== after.hasAttribute('open')) {
        const key = before.id === SOURCES_FOLD_ID ? 'sources' : 'shared';
        programmaticFolds.push(key);
        before.open = after.hasAttribute('open');
      }
      continue;
    }
    if (before.outerHTML === after.outerHTML) continue;
    live.replaceChild(after, before);
  }
  return true;
}

/**
 * THIS MODULE'S setMain. Every branch of renderMain still calls it by that
 * name (see the header above for why the seam is here).
 *
 * View-mode behaviour is unchanged: the shell's setMain, with its own mount
 * token guard. The two additions are the busy-quiesce and the mount pass,
 * which has to run AFTER the column exists and therefore cannot live in
 * renderMain's own body ahead of the paint.
 */
function setMain(html, token) {
  // THE PATCH IS TRIED FIRST, ALWAYS (v3.64.1) — see patchMainAroundHosts for
  // the measurement. `shellSetMain` is the fallback for a column whose SHAPE
  // moved, and it is still what paints the first frame of a view (there is no
  // `.main-inner` to patch yet, so the patch declines).
  const busy = hostedSectionsBusy();
  if (patchMainAroundHosts(html, token)) {
    // The one clean rebuild once the panel is idle is owed only if a BUSY
    // paint was patched — an ordinary patched paint is complete on its own.
    if (busy) quiescedWhileBusy = true;
  } else {
    shellSetMain(html, token);
  }
  mountHostedSections(token);
}

/** A panel's busy edge. The page consults the predicate itself before every
 *  paint, so the only thing this buys is the ONE clean rebuild once the panel
 *  is idle again — a column that was patched around a drop zone catches up
 *  the moment the drag ends. */
function onHostedBusyChange(busy) {
  if (busy || !quiescedWhileBusy) return;
  quiescedWhileBusy = false;
  if (isCurrentMount(myMountToken)) render(myMountToken);
}

/**
 * The OVERVIEW's SHARED reading, derived in ONE place.
 *
 * A jump is warranted only when this domain is actually part of a Shared
 * Brain — contributing to one, or being the mirror of one. "Enabled on this
 * install" is not enough: a tile whose only possible outcome is "This domain
 * is not part of any Shared Brain" is worse than no tile, which is the same
 * rule renderStatCards already applies to a facet tile with no list under it.
 *
 * `show` and `value` are computed together because they are read in two
 * places that must agree — the markup, on a full paint, and the reveal
 * below, which happens with no repaint at all.
 */
function sharedJumpReading(summary) {
  if (!summary || summary.enabled !== true) return { show: false, value: '—' };
  const mirrors = summary.mirrorCount || 0;
  const contributing = summary.contributingCount || 0;
  if (summary.kind === 'mirror' && mirrors > 0) return { show: true, value: 'mirror' };
  if (contributing > 0) {
    return { show: true, value: contributing === 1 ? '1 cohort' : contributing + ' cohorts' };
  }
  return { show: false, value: '—' };
}

/**
 * What the Shared Brain panel knows about THIS domain, recorded so the
 * OVERVIEW can show or hide its SHARED jump.
 *
 * IT DOES NOT RE-RENDER, and that is not an optimisation. A render replaces
 * the column, which remounts the panel, which reloads and reports again — a
 * loop. So the tile is present in the markup from the first paint and merely
 * REVEALED here, which is one attribute write and no repaint at all.
 */
function onSharedLensChange(summary) {
  state.sharedLens = summary && typeof summary === 'object' ? summary : null;
  state.sharedJump = sharedJumpReading(state.sharedLens);
  state.sharedReading = sharedHeadReading(state.sharedLens);
  if (typeof document === 'undefined' || !document.querySelector) return;
  // ④'s head reading, written the same way the tile is revealed — one text
  // write, no repaint (a repaint would remount the panel, which reports
  // again: the loop the tile's own comment names).
  const reading = document.getElementById('dm-shared-reading');
  if (reading) reading.textContent = state.sharedReading;
  // `.dm-stat-card`, not `.dm-jump-card`: since v3.65.0 a jump IS an ordinary
  // tile in the same grid, so the reveal addresses the tile class every other
  // figure carries and finds it by its `data-stat-jump` hook.
  const tile = document.querySelector('.dm-stat-card[data-stat-jump="shared"]');
  if (!tile) return;
  tile.hidden = !state.sharedJump.show;
  const value = tile.querySelector('.dm-stat-value');
  if (value) value.textContent = state.sharedJump.value;
}

/**
 * ④'s head reading, from the panel's report (v3.65.3).
 *
 * '' while nothing has been reported, and '' when the flag or the list could
 * not be read — "could not tell" must never render as "off" or "not part of
 * any". That was the v3.65.2 defect (D6): the section read "not connected"
 * beside a card showing the connection, because the panel reported its
 * loading state as `enabled: false`.
 */
function sharedHeadReading(summary) {
  if (!summary || typeof summary !== 'object' || summary.error) return '';
  if (summary.enabled !== true) return 'off on this install';
  const label = typeof summary.label === 'string' ? summary.label : '';
  const contributing = summary.contributingCount || 0;
  if (summary.kind === 'contributing' && contributing > 0) {
    return contributing === 1 && label ? 'contributes to ' + label : 'contributes to ' + contributing;
  }
  if (summary.kind === 'mirror' && (summary.mirrorCount || 0) > 0) {
    return label ? 'mirror of ' + label : 'mirror';
  }
  if (summary.orphan) return 'no connection';
  return 'not part of any';
}

/** The fold's `<details>` element, or null when this branch of the page does
 *  not render it (the loading branch, a `shared-*` mirror for INGEST). */
function sectionFoldEl(key) {
  if (typeof document === 'undefined' || !document.getElementById) return null;
  return document.getElementById(key === 'sources' ? SOURCES_FOLD_ID : SHARED_FOLD_ID);
}

/** Open one fold, remember it, and bring it to the top of the column — what
 *  an OVERVIEW jump tile does, and what the onboarding deep link asks for.
 *
 *  ① INGEST HAS NOTHING TO OPEN (v3.65.2): it is always open, so for
 *  `sources` this only LANDS — scrolls its head into view and moves focus to
 *  its title — and writes no preference. ④ Shared Brain is unchanged. */
function openSectionFold(key, opts) {
  const el = sectionFoldEl(key);
  if (!el) return;
  // BOTH SECTIONS ONLY LAND NOW (v3.65.3): ④ Shared Brain went the way ①
  // did — always open — so the SHARED tile, like SOURCES, scrolls the head
  // into view and focuses the title, and writes no preference.
  if (!opts || opts.scroll !== false) {
    if (key === 'sources') landOnSection('.dm-sources-hd', 'dm-sources-title');
    else landOnSection('.dm-shared-hd', 'dm-shared-title');
  }
}

/**
 * Mount, re-point or take down the two panels, and bind the folds.
 *
 * Called from setMain (after the column exists) and from the fold toggle.
 * Idempotent: it does the minimum each panel's own contract asks for.
 *
 *   · A NEW ELEMENT is a real remount — the old one went with the innerHTML.
 *   · A DOMAIN SWITCH on the SAME element re-points the Shared Brain panel
 *     without tearing it down (its mount is idempotent on one element, so a
 *     push in flight and a shown-once admin token both survive), and remounts
 *     Ingest, whose destination is what changed.
 *   · ① INGEST IS ALWAYS WANTED when its section exists (v3.65.2 — it is
 *     no longer a fold). What follows about a CLOSED fold is ④'s alone.
 *   · A CLOSED fold takes its panel down — the same contract as leaving the
 *     view: a live batch is server-backed and is re-adopted, paused, when the
 *     fold is opened again. It is NOT taken down while the panel is busy,
 *     because a fold can only be closed by a click and a busy panel is one
 *     holding something a click should not destroy; the rebuild in
 *     onHostedBusyChange collects it the moment it is idle.
 *   · A `shared-*` MIRROR renders no INGEST section at all (views/ingest.js
 *     refuses a mirror as a destination), so there is nothing to mount and
 *     anything standing is taken down.
 */
function mountHostedSections(token) {
  if (typeof document === 'undefined' || !document.getElementById) return;
  const slug = state.activeSlug;
  const srcFold = document.getElementById(SOURCES_FOLD_ID);
  const srcHost = document.getElementById(SOURCES_HOST_ID);
  const shFold = document.getElementById(SHARED_FOLD_ID);
  const shHost = document.getElementById(SHARED_HOST_ID);

  bindSectionFolds();

  // ── THE ONBOARDING DEEP LINK (package A's requestDomainFold) ───────────
  // Read through the namespace import, never as a named one: a static named
  // import of an export that does not exist is a HARD module-load error in
  // ESM and takes the whole shell to a blank page, and this consumer and its
  // producer land in different packages. The shell's own degradation
  // contract covers the miss — "it can fail to help; it cannot break
  // anything": an unread request leaves the user on Domains with the section
  // in front of them, which is where the request was trying to put them.
  //
  // ① IS ALWAYS OPEN SINCE v3.65.2, so the request no longer OPENS anything:
  // it LANDS the user on the section — its head scrolled into view and focus
  // on its title, so a keyboard or screen-reader user arrives where a
  // sighted one does. Still consumed only once the section exists (a
  // loading-branch paint leaves it pending for the next paint), and still
  // self-clearing, so it fires once.
  if (srcFold && typeof shell.consumeDomainFoldRequest === 'function') {
    const asked = shell.consumeDomainFoldRequest();
    if (asked && asked === (shell.ADD_SOURCES_FOLD || 'add-sources')) {
      landOnSection('.dm-sources-hd', 'dm-sources-title');
    }
  }

  // ── INGEST ────────────────────────────────────────────────────────────
  // Wanted whenever the section exists: there is no closed state to honour.
  const srcWanted = !!(srcFold && srcHost);
  if (!srcWanted) {
    if (mountedSourcesEl && !(mountedSourcesEl === srcHost && ingestSectionBusy())) {
      unmountIngestSection();
      mountedSourcesEl = null;
      mountedSourcesDomain = null;
    }
  } else if (srcHost !== mountedSourcesEl || mountedSourcesDomain !== slug) {
    mountIngestSection(srcHost, { domain: slug, token, onBusyChange: onHostedBusyChange });
    mountedSourcesEl = srcHost;
    mountedSourcesDomain = slug;
  }

  // ── SHARED BRAIN ──────────────────────────────────────────────────────
  // Wanted whenever the section exists (v3.65.3): like ①, ④ has no closed
  // state to honour. The cost is GET /feature-flag + GET /list once per
  // mount — /list is an mtime scan, no LLM, no network (v3.0.4), and a
  // domain switch on the same element re-points without reloading.
  const shWanted = !!(shFold && shHost);
  if (!shWanted) {
    if (mountedSharedEl && !(mountedSharedEl === shHost && sharedSectionBusy())) {
      unmountSharedSection();
      mountedSharedEl = null;
      mountedSharedDomain = null;
    }
  } else if (shHost !== mountedSharedEl || mountedSharedDomain !== slug) {
    mountSharedSection(shHost, {
      domain: slug, token,
      onBusyChange: onHostedBusyChange,
      onLensChange: onSharedLensChange,
      describeDomain: describeDomainForShared,
    });
    mountedSharedEl = shHost;
    mountedSharedDomain = slug;
  }
}

/** What ④ needs to know about a domain it names (v3.65.3): the install's
 *  own domain index — the identity dot's key (design rule 5), the SAME order
 *  the sidebar rows are painted in — and its page count. Read at render
 *  time, so it is never stale after a switch or a pull. */
function describeDomainForShared(slug) {
  const list = Array.isArray(state.domains) ? state.domains : [];
  const index = list.findIndex((d) => d && d.slug === slug);
  const d = index >= 0 ? list[index] : null;
  return { index, pages: d && typeof d.pageCount === 'number' ? d.pageCount : null };
}

/** The fold toggles. Bound per element and marked, because this runs on every
 *  paint AND from the toggle it installs — a second listener on one
 *  `<details>` would mount the panel twice. */
function bindSectionFolds() {
  if (typeof document === 'undefined' || !document.querySelectorAll) return;
  document.querySelectorAll('[data-dm-fold]').forEach((el) => {
    // ── THE BOUND MARK IS AN EXPANDO, NOT A `data-*` ATTRIBUTE (v3.64.1) ──
    // It was `el.dataset.dmFoldBound = '1'`, which is an ATTRIBUTE, and that
    // put the mark inside the live fold's `outerHTML` and nowhere inside the
    // freshly-composed one — so once setMain began patching on every paint,
    // the byte comparison found both folds different every time and replaced
    // them, remounting both panels. MEASURED: two replacements per cached
    // switch and four per cold one, all of them caused by this one attribute.
    if (el.__dmFoldBound) return;
    el.__dmFoldBound = true;
    // ── THE PAINT'S OWN ECHO IS NOT A PRESS (v3.64.1) ──────────────────
    // MEASURED IN A BROWSER: a `<details open>` created by an innerHTML
    // assignment fires `toggle` ONCE, after this listener is attached. That
    // was harmless while the emitted value always equalled the stored one —
    // and it stopped being harmless the moment the preference went
    // install-wide, because the INGEST fold's DERIVED default (open on a
    // domain that has never been ingested into) would then be recorded as an
    // explicit choice the first time such a domain was opened, and would
    // follow the user onto every other domain. A press always CHANGES
    // `el.open` relative to the last recorded state; an echo never does.
    el.__dmFoldWas = !!el.open;
    el.addEventListener('toggle', () => {
      const key = el.dataset ? el.dataset.dmFold : null;
      if (!key) return;
      if (!!el.open === el.__dmFoldWas) return;
      el.__dmFoldWas = !!el.open;
      // A TOGGLE THIS PAGE CAUSED ITSELF IS NOT A PREFERENCE. See
      // `programmaticFolds`: the queue is drained in the order the writes
      // happened, so an entry here means this exact event is the echo of one.
      const echo = programmaticFolds.indexOf(key);
      if (echo !== -1) { programmaticFolds.splice(echo, 1); return; }
      sectionPrefsFor(state.activeSlug)[key] = !!el.open;
      writeSectionPrefs();
      // No render(): the fold is already in the state the user asked for,
      // and repainting the column here would replace the very element the
      // press landed on. Only the panels move.
      mountHostedSections(myMountToken);
    });
  });
}

// ── Fetch helpers ──────────────────────────────────────────────────────────

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON error page etc. */ }
  if (!res.ok) {
    const msg = (body && body.error) || ('Request failed (' + res.status + ')');
    const err = new Error(msg);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// Minimal SSE-over-POST reader. The server writes `event: <type>\ndata:
// <json>\n\n` frames (see src/routes/health.js); this parses the raw
// stream without any library. onEvent(type, payload) fires per frame.
async function streamSSE(url, body, onEvent) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok || !res.body) {
    let msg = 'Request failed (' + res.status + ')';
    let parsedBody = null;
    try { const j = await res.json(); parsedBody = j; if (j && j.error) msg = j.error; } catch { /* ignore */ }
    // L1 fix (this session): mirror fetchJSON's shape (err.status / err.body)
    // on this pre-stream failure path. Without it, classifyDomainError's
    // 409-detection (`err.status === 409 || err.body.conflict`) could never
    // fire for a caller fed by streamSSE, because a bare `new Error(msg)`
    // carries neither field — verified live: a real write-registry 409 on
    // /semantic-dupes/merge-batch (the route refuses BEFORE the SSE stream
    // starts — see routes/health.js's isUpdateInProgress()/registerWrite()
    // check ahead of `res.setHeader('Content-Type', 'text/event-stream')`)
    // rendered as the generic "Could not merge duplicates — …" error banner
    // instead of the dedicated refusal banner, on the single most
    // destructive flow this file has. This branch is genuinely reachable
    // for a 409: only a mid-stream failure (the `type === 'error'` frame
    // handlers in each caller's onEvent) is a plain processing error with
    // no conflict shape, because the backend's write-registry/file-lock
    // refusals all happen before it ever calls res.flushHeaders() — so
    // those throws are deliberately left as bare Errors.
    const err = new Error(msg);
    err.status = res.status;
    err.body = parsedBody;
    throw err;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  // NIT fix (re-audit, third round): every caller's `onEvent` deliberately
  // throws on an `error` frame (`if (type === 'error') throw new Error(...)`)
  // to signal a failure back to streamSSE's own caller — but that throw
  // used to propagate straight out of this function with the reader
  // neither cancelled nor released, leaving the stream lock (and, until
  // GC, the underlying connection) held open longer than necessary.
  // `try/finally` covers BOTH exit paths — the throw, and normal
  // completion via `done` — with one `cancel()` call; cancelling an
  // already-closed reader is a harmless no-op per spec.
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let type = 'message';
        let data = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) type = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data) continue;
        let parsed;
        try { parsed = JSON.parse(data); } catch { continue; }
        onEvent(parsed.type || type, parsed);
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

// ── Formatting helpers ─────────────────────────────────────────────────────

// COST HONESTY: this used to be `n < 0.01 ? n.toFixed(4) : n.toFixed(2)`,
// which rendered every charge below $0.00005 as the literal string
// `$0.0000` — a PAID action (the quick-maintenance badge sits on buttons
// that make real AI calls) labelled as free, on the one surface whose
// entire purpose is to state the cost before the user commits to it.
// Delegated to the shared formatter so the rule "a non-zero cost never
// renders as zero" has exactly one implementation; see format-usd.js for
// why it is imported rather than copied, and for the two byte-pinned
// siblings in ingest-queue-logic.js that could not be fixed with it.
function formatUsd(n) {
  return formatUsdHonest(n);
}

// Cost-readout helper for Health AI estimate/plan payloads (health-ai.js's
// costFields(): {estimatedUsd, priceKnown, costNote}). A known price keeps
// its exact prior rendering via formatUsd(). An UNPRICED model (reachable
// today via the documented LLM_MODEL= override, or a fallback rung with no
// entry in llm.js's price table) used to render as no cost text at all
// (the quick-action badge simply never appeared) or a bare 'unknown' — this
// surfaces the server's own costNote instead, so the wording has one
// source of truth. `compact: true` (the per-button badge, where a full
// sentence would break the pill layout) uses a short 'cost unknown' instead
// of the longer server sentence. Returns null only when there's no
// estimate to report (matching every existing caller's prior null-check).
function costReadout(est, { compact = false } = {}) {
  if (!est || est.error) return null;
  if (typeof est.estimatedUsd === 'number') return formatUsd(est.estimatedUsd);
  // A FREE model's cost is KNOWN and it is zero — `priceKnown: true` with a null
  // `estimatedUsd`. Before this, the compact branch returned before ever reading
  // the note, so the spend button read "cost unknown" on the ONE model whose cost
  // is certain, directly beneath copy promising every AI action shows its cost
  // first. Eighth instance in v3.15.0 of a fact and its ABSENCE collapsed into one
  // value. Never render `$0.00` here: `estimatedUsd: 0` makes the frozen /old
  // renderer print `$0.0000`, which is what format-usd.js exists to prevent.
  if (compact) return est.priceKnown ? 'free' : 'cost unknown';
  return (typeof est.costNote === 'string' && est.costNote) || 'cost unknown';
}

function relTime(iso) {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 5) return 'just now';
  if (sec < 60) return sec + 's ago';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + (min === 1 ? ' minute ago' : ' minutes ago');
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + (hr === 1 ? ' hour ago' : ' hours ago');
  const day = Math.floor(hr / 24);
  return day + (day === 1 ? ' day ago' : ' days ago');
}

function pluralize(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

function countSafeFixable(report) {
  if (!report) return 0;
  const suggested = (report.brokenLinks || []).filter((i) => i.suggestedTarget).length;
  return suggested
    + (report.crossFolderDupes || []).length
    + (report.hyphenVariants || []).length
    + (report.folderPrefixLinks || []).length
    + (report.missingBacklinks || []).length;
}

function totalOpenIssues(report) {
  if (!report) return 0;
  let n = 0;
  for (const cat of HEALTH_CATEGORIES) n += (report[cat.key] || []).length;
  return n;
}

// ── Data loading ───────────────────────────────────────────────────────────

// ── THE ARRIVAL REQUEST, HELD ACROSS ONE await (P1-9) ────────────────
//
// `onEnter` consumes app.js's domain request SYNCHRONOUSLY and writes the
// slug straight into `state.activeSlug` (see the call site for why it has to
// happen before `loadDomainsList` runs). What it cannot do there is CHECK the
// slug: the domain list has not been read yet, and the whole point of the
// early write is that it happens before that read.
//
// So the request's two halves separate. The slug is applied immediately and
// VERIFIED in `loadDomainsList`'s commit, where the list finally exists. This
// variable is what carries it across, and it is cleared at the verification
// whether the slug was found or not — a request is spent when it has been
// ACTED ON, not when it has been granted.
let arrivalRequest = null;

async function loadDomainsList(token) {
  // Capture the gate for THIS call. `loadGate` is module-scoped and the
  // next mount replaces it, so settling the module variable from a stale
  // in-flight load would decrement the NEXT mount's counter and hide a
  // loader that is legitimately up. A cancelled gate ignores settle(), so
  // the stale path becomes a no-op instead.
  const gate = loadGate;
  state.loaded = false;
  state.loadError = null;
  render(token);

  // ── THE AI PROBE RIDES ALONGSIDE THE STATS READ, NOT BEHIND IT ─────────
  //
  // GET /api/health/ai-available is free, local and has no network in it
  // (measured 0.8-2.5 ms), and it depends on nothing this function has yet
  // read. It used to sit between the stats read and the health scan purely
  // because that is the order the lines were written in, which made a serial
  // chain out of two independent reads.
  //
  // .catch HERE, AT CREATION, not at the await below: a promise that rejects
  // before anything is awaiting it is an unhandled rejection, and the
  // fail-safe answer to "can this install call an LLM" is no.
  const aiProbe = fetchJSON('/api/health/ai-available')
    .then((info) => {
      if (!isCurrentMount(token)) return;
      state.aiAvailable = !!info.available;
      state.aiProvider = info.provider || null;
      state.aiModel = info.model || null;
    })
    .catch(() => { if (isCurrentMount(token)) state.aiAvailable = false; });

  // The state commit is captured rather than applied, so `state.loaded`
  // flips at the moment we PAINT rather than the moment the response
  // lands. That is what lets the min-visible clamp actually hold a loader
  // that has been shown — flipping `loaded` early would let the very next
  // render (this function continues on to loadHealth) paint through it.
  let commit;
  try {
    const data = await fetchJSON('/api/domains/stats');
    if (!isCurrentMount(token)) return; // H1 fix
    commit = () => {
      state.domains = Array.isArray(data.domains) ? data.domains : [];
      state.readonlySet = new Set(data.readonlyDomains || []);
      // ── THE REQUESTED DOMAIN IS CHECKED HERE, AND ONLY HERE (P1-9) ────
      //
      // `onEnter` has already written the requested slug into
      // `state.activeSlug`, so the ORDINARY fallback below is also the
      // request's fallback: a slug this install does not have fails
      // `state.domains.some(...)` and is replaced by the first row, which is
      // exactly what an unrequested arrival does. Nothing new can go wrong.
      //
      // But it must not go wrong SILENTLY. A miss is disclosed on the console
      // rather than rendered as a screen about a domain the user did not ask
      // for, with nothing saying so. Never a throw: landing somewhere real is
      // a worse answer than the one that was asked for and a much better one
      // than a broken screen — the argument views/memory.js's
      // `takePendingProject` records for the same shape, one view over.
      const want = arrivalRequest;
      arrivalRequest = null;
      if (!state.activeSlug || !state.domains.some((d) => d.slug === state.activeSlug)) {
        if (want && want.slug) {
          console.warn('[next/domains] requestDomain("' + want.slug + '") named a domain this '
            + 'install does not have — opening '
            + (state.domains.length ? state.domains[0].slug : 'nothing') + ' instead.'
            + (want.reason ? ' (reason: ' + want.reason + ')' : ''));
        }
        state.activeSlug = state.domains.length ? state.domains[0].slug : null;
      } else if (want && want.reason === NEW_PROJECT_REASON) {
        // THE POINTER'S SECOND HALF. `requestDomain(slug, {reason})` is a
        // NAVIGATION, not a write: this opens the create FORM on the domain
        // the caller named, and the POST still only ever happens from
        // `runProjectAction`. One create path — the property
        // docs/roadmap-context-engine.md asks a pointer to preserve.
        //
        // The form is built here rather than through `openProjectLifecycle`
        // because this closure runs inside the single settled paint below and
        // that function renders on its own, which would paint the card once
        // without the form and again with it.
        state.projectLc = freshProjectLifecycle('create');
      }
      state.loaded = true;
      // Measured: the domain card painted at ~15 ms and the health panel's
      // loading state at ~18 ms, from TWO renders ~2 ms apart — a 113 px
      // intermediate step in the entry staircase for no reason at all,
      // since loadHealth() below runs synchronously up to its first await
      // and would have set this a moment later anyway. Declaring the scan
      // here folds both into a single paint. Harmless if loadHealth never
      // runs (no active slug): renderHealthPanel is only reached from a
      // selected domain's body.
      if (state.activeSlug) state.healthLoading = true;
    };
  } catch (err) {
    if (!isCurrentMount(token)) return;
    commit = () => { state.loadError = err.message; state.loaded = true; };
  }

  // Measured at ~6 ms, so in practice this resolves in the same task and
  // nothing is delayed. A torn-down gate never calls back at all, which
  // deliberately abandons the rest of this function — the same outcome as
  // the `if (!isCurrentMount(token)) return;` guards around it.
  await new Promise((resolve) => {
    settleGate(gate, () => { commit(); render(token); resolve(); });
  });
  if (!isCurrentMount(token)) return;

  if (state.activeSlug) {
    // ── THE TWO CHEAP READS START NOW, NOT AFTER THE SCAN ────────────────
    //
    // THE ORDERING WAS THE REPORTED DEFECT. These two calls used to sit
    // AFTER `await loadHealth(...)`, and GET /api/health/:domain is a
    // whole-tree scan with no cache — measured 753-788 ms on the 3,445-page
    // `articles` wiki, three consecutive calls, so it is not a cold-start
    // artefact. The page list is a readdir: 18 ms for the same domain. So
    // the one thing the user came to see was held behind the housekeeping
    // report for three quarters of a second, and because loadBrowse used to
    // blank the card on the way in, what the user actually saw was a fully
    // painted screen that blinked 834 ms after it settled. Measured, before:
    // the browse card at 585 px from 16 ms, 26 px at 834 ms, 585 px again at
    // 844 ms. That late collapse is exactly "it loads like it's having a
    // problem loading".
    //
    // Neither read depends on the scan or on the AI probe, and neither is
    // awaited: each paints itself when it lands, and with the
    // stale-while-revalidate in both of them a re-entry now paints nothing
    // at all unless the answer changed.
    //
    // The project list is a cheap read (one stat walk of state/, no LLM and
    // no network) and it is not paid for, so unlike the semantic scan there
    // is nothing to preserve across a re-entry: re-ask, always.
    loadProjects(state.activeSlug, token).catch(reportAsyncActionFailure);
    // Same again for the page list on a re-entry. Unlike the semantic scan
    // there is nothing paid to preserve, and unlike the health report there
    // is no stale-while-revalidate to arrange in the CALLER: loadBrowse
    // re-stamps its own state with the slug it was called for, keeps a list
    // already painted for that same slug, and activeBrowse() refuses any
    // other — so re-asking is both cheap and the safe direction.
    loadBrowse(state.activeSlug, token).catch(reportAsyncActionFailure);

    // AWAITED, not raced. It resolves in single-digit milliseconds and has
    // almost certainly landed already, but loadHealth's decision to fetch the
    // AI cost estimates reads state.aiAvailable — and "almost certainly" is
    // how a cost figure comes to be missing on a slow machine and present on
    // a fast one, for the same install.
    await aiProbe;
    if (!isCurrentMount(token)) return;

    // Cost honesty: a completed, PAID semantic-duplicate scan for THIS same
    // domain survives the remount instead of being thrown away and charged
    // for again. Its destructive-action gate was already re-armed by the
    // teardown (see disarmSemanticScan) — this only decides whether the
    // pair list itself is kept.
    await loadHealth(state.activeSlug, token, {
      keepSemanticScan: shouldKeepSemanticScanOnReload(state.semanticScan, state.activeSlug),
      // Same shape, same evaluation point, opposite subject. NOTE the
      // asymmetry, which is deliberate: the semantic scan is cleared on
      // every scan / switch / flip because it authorises a DESTRUCTIVE
      // merge, while the health report is read-only and is kept across a
      // same-domain re-entry. Both are slug-gated; only the health one is
      // ever kept.
      keepHealth: shouldKeepHealthOnReload(state.health, state.healthSlug, state.activeSlug),
    });
  } else {
    // No domain to load anything for — but the AI probe is still in flight
    // and still writes state, so it is awaited here too rather than left to
    // land on a torn-down mount.
    await aiProbe;
    render(token);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// "WHERE IS MY KNOWLEDGE BASE?" — the existing user's route into this view
// ═══════════════════════════════════════════════════════════════════════════
//
// ── THE DEFECT, reported from a real packaged-app install ─────────────────
// In bundle mode getDomainsDir() resolves under ~/Library/Application Support,
// and the app now CREATES that folder on first launch. So a long-time user
// with six domains somewhere else opens the app to a correctly-working,
// genuinely empty install: nothing broken, nothing lost, and NO VISIBLE ROUTE
// from the screen they are standing on to the folder they already have. The
// maintainer's words were "there is no way to open existing domains", and the
// conclusion an ordinary user reaches from an empty Domains screen is not
// "wrong folder" — it is "my knowledge base is gone".
//
// ── THIS ADDS NO SERVER CAPABILITY, AND THAT IS THE POINT ─────────────────
// Both endpoints predate this change and are UNMODIFIED:
//   POST /api/config/pick-folder  — opens a folder picker AND, if a path
//                                   comes back, calls setDomainsDir() itself.
//                                   It is a mutation, not a query; there is
//                                   no second call to "apply" the choice.
//   POST /api/config/domains-path — sets a path directly. Used ONLY by the
//                                   undo below.
// This was a discoverability gap, not a capability gap, so the fix is a
// route to an existing control — not a new one, and not a weaker one.
//
// ── WHY A SECOND CALL SITE FOR pick-folder IS NOT THE "TWO COPIES" TRAP ───
// views/settings.js already calls it. That looked, at first, like the shape
// this project has a standing allergy to — the duplicate-create-path
// collision v3.7.0 deleted, which is why views/domains.js holds the ONLY
// `POST /api/domains` call site in the tree. It is not the same shape. That
// rule exists because domain CREATION carries client-side FORM STATE —
// validation, a template list, a slug the server generates — so a second
// caller is a second copy of rules that then drift. `pick-folder` takes NO
// body and returns a settled outcome: every rule (existence, the concurrency
// re-check, the mutation itself) lives server-side, in ONE closure that the
// route's own docblock calls "the ONE set of post-pick rules". A second
// caller of a no-argument endpoint cannot hold a diverging copy of anything,
// because it holds nothing.
//
// ── WHAT IS AND IS NOT MEASURED HERE ─────────────────────────────────────
// MEASURED, not assumed (see scripts/test-next-existing-knowledge-folder.js
// §1, which drives the REAL src/brain/config.js and src/brain/files.js):
// setDomainsDir() takes effect IMMEDIATELY, in the same process, with no
// restart and no reload. getDomainsDir() re-reads .curator-config.json on
// every call, listDomains() calls it on every call, and a tree-wide scan
// found NO module-level capture of either. So the correct client behaviour
// after a successful pick is simply to re-fetch the list.
//
// ALSO MEASURED, and it is the reason describeSwitchOutcome() exists: a
// folder with no domains and a folder that is not a knowledge base AT ALL
// (someone's Pictures folder) both return exactly `[]`, indistinguishably,
// and so does a folder that has been unmounted. The read layer is right to
// collapse them — an absent collection is empty, not broken — but a UI that
// merely repaints an empty list after a pick tells the user NOTHING, and is
// strictly worse than before the pick, because now they have also moved
// their config and believe the feature is broken. So the outcome is
// REPORTED, with the path in it and a way back.

/**
 * PURE. What POST /api/config/pick-folder just told us.
 *
 * CANCELLED IS CHECKED FIRST, and that ordering is a contract with the route
 * rather than a preference: its `accept()` closure notes that a refusal "must
 * never carry that field" precisely because the shipping frontend reads
 * `cancelled` before `res.ok`. Mirroring that order here means the two sides
 * agree about which reply is a cancel, and a future refusal that wrongly grew
 * a `cancelled` field would be a route bug rather than a silent divergence.
 *
 * 409 and 501 are separated from the generic error case because they are the
 * two the user can DO something about, and because 501 is the honest-
 * difference case: a packaged app whose desktop host exposes no picker hook
 * refuses rather than falling back, and carries its own `hint` naming the
 * typed-path route. Surfacing that hint is what keeps the first-run task
 * completable instead of dead-ended.
 *
 * @param {number} status  HTTP status
 * @param {object|null} body  parsed JSON body, or null
 * @returns {{kind:'cancelled'|'switched'|'refused'|'unsupported'|'error',
 *            path?:string, title?:string, detail?:string}}
 */
function classifyPickResponse(status, body) {
  const b = (body && typeof body === 'object') ? body : {};
  // See the docblock: FIRST, unconditionally.
  if (b.cancelled === true) return { kind: 'cancelled' };

  const serverMsg = (typeof b.error === 'string' && b.error.trim()) ? b.error.trim() : '';
  const hint = (typeof b.hint === 'string' && b.hint.trim()) ? b.hint.trim() : '';

  if (status === 409) {
    return {
      kind: 'refused',
      title: 'Something is still writing',
      // The server's OWN sentence, never a paraphrase — it names the domain
      // and the operation, which our copy cannot.
      detail: serverMsg || 'A write is in progress. Wait for it to finish, then try again.',
    };
  }
  if (status === 501) {
    return {
      kind: 'unsupported',
      title: 'This build cannot open a folder picker',
      detail: [serverMsg, hint].filter(Boolean).join(' ') ||
        'Set the folder from Settings → Knowledge base instead.',
    };
  }
  if (status >= 400 || serverMsg) {
    return {
      kind: 'error',
      title: 'The folder picker did not finish',
      detail: [serverMsg, hint].filter(Boolean).join(' ') || 'Request failed (' + status + ')',
    };
  }
  if (typeof b.path === 'string' && b.path.trim()) {
    return { kind: 'switched', path: b.path.trim() };
  }
  // A 200 carrying neither a path nor a cancel. Nothing was changed, but we
  // cannot claim success either — saying so is better than a blank screen.
  return {
    kind: 'error',
    title: 'The folder picker did not finish',
    detail: 'The picker returned no folder and no reason.',
  };
}

/**
 * PURE. What the user is told AFTER the folder has already been switched.
 *
 * The switch has HAPPENED by the time this runs — pick-folder mutates before
 * it replies — so this is a report, never a question. The zero case is
 * therefore `attention` rather than `danger`: nothing failed, and dressing a
 * successful-but-empty pick as an error would be the mirror of the defect
 * this whole section fixes (an empty install reported as a broken one).
 *
 * The detail names WHAT WAS LOOKED FOR, because the read layer cannot tell an
 * empty knowledge folder from a folder of holiday photos and neither can we.
 * Naming the shape ("a folder per domain, each with a CLAUDE.md") is the only
 * honest way to let the user decide which of the two they just did — and it
 * covers the likeliest mistake by far, picking one domain instead of the
 * folder that contains them.
 *
 * @param {string} path      the folder now in use
 * @param {number} count     how many domains were found in it
 * @param {string|null} previousPath  where we were pointed before
 */
function describeSwitchOutcome(path, count, previousPath) {
  const n = Number(count);
  const where = (typeof path === 'string' && path.trim()) ? path.trim() : 'that folder';
  if (Number.isFinite(n) && n > 0) {
    return {
      state: 'success',
      title: 'Opened ' + pluralize(n, 'domain'),
      detail: 'The Curator is now reading ' + where + '. Nothing was copied or converted — ' +
              'your pages, links and history are exactly as they were.',
      undoPath: null,
    };
  }
  // A folder we can no longer distinguish from any other empty folder.
  const back = (typeof previousPath === 'string' && previousPath.trim() && previousPath.trim() !== where)
    ? previousPath.trim() : null;
  return {
    state: 'attention',
    title: 'No domains found there',
    detail: 'The Curator is now reading ' + where + ' and found nothing in it. A knowledge folder ' +
            'holds one folder per domain, each containing a CLAUDE.md file — so pick the folder ' +
            'that CONTAINS your domains, not one of the domains itself.',
    undoPath: back,
  };
}

/** Load the current knowledge-folder path. Free, local, no LLM, no network. */
async function loadKnowledgeBase(token) {
  try {
    const cfg = await fetchJSON('/api/config');
    if (!isCurrentMount(token)) return;
    state.kb = { domainsPath: cfg.domainsPath || '', domainsPathSource: cfg.domainsPathSource || '' };
  } catch {
    // Non-fatal by design. This read only makes the copy MORE specific (it
    // supplies the path we say we looked in); every control below works
    // without it, so a failure here must not block or blank the view.
    if (!isCurrentMount(token)) return;
    state.kb = null;
  }
}

/**
 * Open the folder picker, then report what actually happened.
 *
 * Entered synchronously from a click, so reading myMountToken at the call
 * site is safe; the token is captured ONCE here and threaded through every
 * resumption, per this file's H1 discipline.
 */
async function onChooseKnowledgeFolder(token) {
  if (state.kbBusy) return;
  // Fail OPEN if the shell gate itself throws — the server carries the real
  // guard (guardConcurrent) and will 409, which classifyPickResponse renders
  // as a visible refusal. A broken client-side predicate must not be able to
  // lock a user out of the one action that makes their wiki visible.
  let busyElsewhere = false;
  try { busyElsewhere = shell.isAnyWriteBusy(); }
  catch (err) { console.warn('[domains] isAnyWriteBusy() failed — deferring to the server guard', err); }
  if (busyElsewhere) {
    state.kbNotice = {
      state: 'attention',
      title: 'Something is still writing',
      detail: 'Changing the knowledge folder while pages are being written can scatter that ' +
              'write’s remaining pages into the new folder. Wait for it to finish, then try again.',
      undoPath: null,
    };
    render(token);
    return;
  }

  const previousPath = (state.kb && state.kb.domainsPath) || null;
  state.kbBusy = true;
  state.kbNotice = null;
  render(token);
  try {
    const res = await fetch('/api/config/pick-folder', { method: 'POST' });
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON error page */ }
    if (!isCurrentMount(token)) return;
    const verdict = classifyPickResponse(res.status, body);
    if (verdict.kind === 'cancelled') return;      // the user changed their mind
    if (verdict.kind !== 'switched') {
      state.kbNotice = {
        state: verdict.kind === 'refused' ? 'attention' : 'danger',
        title: verdict.title,
        detail: verdict.detail,
        undoPath: null,
      };
      return;
    }
    // SWITCHED. The mutation already happened server-side; from here we are
    // only re-reading and reporting.
    await applySwitchedFolder(verdict.path, previousPath, token);
  } catch (err) {
    if (!isCurrentMount(token)) return;
    state.kbNotice = { state: 'danger', title: 'The folder picker did not finish', detail: err.message, undoPath: null };
  } finally {
    if (isCurrentMount(token)) { state.kbBusy = false; render(token); }
  }
}

/**
 * Re-read everything the folder decides, then report the outcome.
 *
 * The full loadDomainsList() is deliberately re-run rather than a narrower
 * refresh: the folder switch invalidates the domain list, the active slug,
 * every health report and every per-domain cache in this module's state at
 * once, and that function is the ONE place that rebuilds all of them
 * consistently. It also re-points state.activeSlug at a domain that exists in
 * the NEW folder (or null), which is what stops the main pane rendering a
 * heading for a domain that is no longer there.
 */
async function applySwitchedFolder(newPath, previousPath, token) {
  state.kb = { domainsPath: newPath, domainsPathSource: 'ui' };
  // A report, a scan and a browse listing from the OLD folder are all
  // meaningless now, and two of them are stamped with a slug that may exist
  // in BOTH folders — which is precisely how a stale report gets rendered
  // under a heading it was never scanned for.
  state.health = null;
  state.healthSlug = null;
  state.healthSummary = {};
  state.semanticScan = null;
  state.browse = null;
  state.activeSlug = null;
  await loadDomainsList(token);
  if (!isCurrentMount(token)) return;
  const found = state.loadError ? 0 : state.domains.length;
  state.kbNotice = state.loadError
    ? { state: 'danger', title: 'That folder could not be read', detail: state.loadError, undoPath: previousPath || null }
    : describeSwitchOutcome(newPath, found, previousPath);
}

/**
 * Go back to the folder we were pointed at before the last switch.
 *
 * Uses POST /api/config/domains-path — which REFUSES a path that does not
 * exist, and that refusal is kept rather than pre-empted client-side: the
 * previous folder can genuinely have gone away (an ejected drive is the whole
 * reason someone lands here), and the server's sentence names it.
 */
async function onUndoKnowledgeFolder(targetPath, token) {
  if (state.kbBusy || !targetPath) return;
  const cameFrom = (state.kb && state.kb.domainsPath) || null;
  state.kbBusy = true;
  render(token);
  try {
    const res = await fetch('/api/config/domains-path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: targetPath }),
    });
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON error page */ }
    if (!isCurrentMount(token)) return;
    if (!res.ok) {
      const msg = (body && body.error) || ('Request failed (' + res.status + ')');
      state.kbNotice = { state: 'danger', title: 'Could not go back to that folder', detail: msg, undoPath: null };
      return;
    }
    await applySwitchedFolder((body && body.domainsPath) || targetPath, cameFrom, token);
  } catch (err) {
    if (!isCurrentMount(token)) return;
    state.kbNotice = { state: 'danger', title: 'Could not go back to that folder', detail: err.message, undoPath: null };
  } finally {
    if (isCurrentMount(token)) { state.kbBusy = false; render(token); }
  }
}

// LAYER 1 of the two-layer domain-scoping guard (LAYER 2 is
// activeSemanticScan()/activeBrowse()). Pulled out of loadHealth() as a
// plain synchronous function for one reason: it is the ONLY place any of
// these four per-domain caches is cleared, so it is the thing a test has
// to be able to drive directly to prove "switching domains really does
// empty the previewed-merge gate" — rather than proving only that some
// second check happens to refuse afterwards. Both layers are asserted
// separately, and each is mutation-proven on its own, because two guards
// that mask each other are two guards nobody is testing (v3.4.0's recorded
// lesson: a mutation that stays green because a second layer covers it is
// not coverage, it is a blind spot with a passing test in front of it).
//
// `keepSemanticScan` is opt-in and used by exactly the two per-pair
// semantic actions (merge one, skip one), which refresh the health report
// while the scan that produced the pair list is still meaningful. Without
// it, merging pair 1 of 8 would wipe the whole list and the user would
// have to RE-RUN a paid LLM scan to reach pair 2 — the fine-grained path
// would cost money per pair. THE BATCH MERGE SETS IT TOO (it has since the
// v3.7.0 paid-scan-survival fix, which stopped the batch destroying the
// medium/low-confidence pairs it never touched); this comment claimed the
// opposite for three releases. A domain switch, a plain rescan and every
// other fix do NOT set it — those invalidate the scan for real.
//
// Keeping the scan is a cost decision, never a claim that every surviving
// pair is still mergeable: a merge deletes a page that sibling pairs may
// name, and those are marked `resolved` by resolvePairsTouching.
function resetDomainScopedHealthState(opts) {
  state.estimates = {};
  state.pendingPlan = null;
  if (!(opts && opts.keepSemanticScan)) state.semanticScan = null;
  state.dismissedRecords = null;
}

// ── Paid-scan survival across a view change (cost honesty) ─────────────────
//
// THE DEFECT: a semantic-duplicate scan is the only LLM-billed READ in this
// view — a real measured run produced 8 pairs for $0.0040. Clicking any
// rail item and coming back destroyed the result and forced the user to
// re-scan and RE-PAY. Two places did it: this view's unmount teardown
// (`state.semanticScan = null`) and, on the way back in, loadDomainsList ->
// loadHealth -> resetDomainScopedHealthState with no keepSemanticScan.
//
// THE INVARIANT THAT MUST SURVIVE THE FIX (v3.7.0, recorded): a previewed
// set that outlives a navigate-away can authorise a destructive merge on a
// DIFFERENT domain's pair. So this fix is deliberately asymmetric:
//
//   • THE PAID DATA survives — `pairs`, `cost` and the `slug` stamp. It is
//     inert plain data (no closure over a scan run, unlike `confirm.run`
//     and `pendingPlan`, which the teardown still discards), and LAYER 2
//     (activeSemanticScan) refuses it outright on a different slug.
//
//   • THE DESTRUCTIVE-ACTION GATE IS RE-ARMED — `previewed` is emptied and
//     any open `preview` dropped. Re-previewing is FREE; re-scanning costs
//     money. So the safe direction here costs the user nothing, which is
//     why it is taken even though the domain stamp alone would arguably
//     suffice. After a navigate-away the raw previewed set is EMPTY, not
//     merely refused by a later check — the same standard §2 of
//     test-next-semantic-gate.js already holds the other three clearing
//     paths (new scan, domain switch, flip) to.
//
// Mutating in place rather than rebuilding the object keeps any field this
// function does not know about; the two it does know about are the two
// that arm a file deletion.
function disarmSemanticScan(scan) {
  if (!scan || typeof scan !== 'object') return null;
  if (scan.previewed && typeof scan.previewed.clear === 'function') scan.previewed.clear();
  else scan.previewed = new Set();
  scan.preview = null;
  return scan;
}

// Re-entry half of the same fix. Keeps the scan ONLY when the domain about
// to be loaded is the very domain it was scanned for — evaluated at the
// call site, AFTER loadDomainsList has resolved state.activeSlug (which it
// can change, e.g. when the previously active domain no longer exists), so
// a vanished or switched domain re-takes the clearing path.
function shouldKeepSemanticScanOnReload(scan, slug) {
  return !!(scan && typeof scan === 'object' && slug && scan.slug === slug);
}

/** Stale-while-revalidate for the health report — LAYER 1 (re-entry).
 *
 *  Measured defect this fixes: `state` is module-scoped, so returning to
 *  Domains still had a full health report in memory — and loadHealth threw
 *  it away, collapsing the panel 540 px -> 89 px ("Scanning…") and
 *  re-expanding it ~650 ms later. Two of the four jumps in the entry
 *  staircase, for data we already had.
 *
 *  THE SLUG EQUALITY IS THE WHOLE POINT, not a detail. Showing domain A's
 *  issue counts under domain B's heading is a correctness bug, strictly
 *  worse than the flicker: the user would act on it. So the report is kept
 *  ONLY when it was scanned for this exact domain — evaluated at the call
 *  site, AFTER loadDomainsList has resolved state.activeSlug (which it can
 *  change when the previously active domain no longer exists), exactly as
 *  shouldKeepSemanticScanOnReload above is. LAYER 2 lives in
 *  renderHealthPanel, which independently refuses to paint a report whose
 *  recorded slug is not the domain it is rendering — the same two-layer
 *  shape as the semantic gate, and for the same reason: neither layer may
 *  depend on the other having been remembered.
 */
function shouldKeepHealthOnReload(report, reportSlug, slug) {
  return !!(report && typeof report === 'object' && slug && reportSlug === slug);
}

async function loadHealth(slug, token, opts) {
  const silent = !!(opts && opts.silent);
  // Stale-while-revalidate — LAYER 1. The decision is made BY THE CALLER
  // and handed in, exactly as `keepSemanticScan` above it is, and for the
  // same two reasons: it must be evaluated after state.activeSlug has
  // settled, and the DEFAULT must be the safe one. An absent flag clears,
  // so any call site that has not thought about it — including
  // selectDomain, i.e. every domain SWITCH — takes the clearing path.
  //
  // It is a plain boolean rather than a call to the shared predicate on
  // purpose: scripts/test-next-semantic-gate.js executes this function in
  // a sandbox built from a fixed list of lifted functions, so a new
  // free identifier here makes loadHealth throw mid-clear and silently
  // defeats the destructive-merge gate's own test. That suite's FNS list
  // already carries a comment about the last time this happened.
  const keepStale = !!(opts && opts.keepHealth);
  if (!silent) {
    state.healthLoading = true;
    state.healthError = null;
    if (!keepStale) { state.health = null; state.healthSlug = null; }
    state.healthStale = keepStale;
  }
  resetDomainScopedHealthState(opts);
  render(token);

  try {
    const report = await fetchJSON('/api/health/' + encodeURIComponent(slug));
    if (slug !== state.activeSlug || !isCurrentMount(token)) return; // user switched domains, or left the view, mid-fetch
    // A report that REPLACES the "Scanning…" placeholder has missed the
    // view-enter animation by three quarters of a second, so it fades in on
    // this fill only. A revalidation behind a report already on screen
    // (`keepStale`) does not: that block is already there, and fading an
    // in-place update is how a repaint reads as a flicker. One-shot token,
    // consumed by the render that paints it — see renderHealthPanel.
    if (!keepStale) state.reveal = { key: slug + ':health', used: false };
    state.health = report;
    state.healthSlug = slug;
    state.healthStale = false;
    state.healthSummary[slug] = totalOpenIssues(report);
  } catch (err) {
    if (slug !== state.activeSlug || !isCurrentMount(token)) return;
    state.healthError = err.message;
    // A stale report must never sit under a failed rescan implying it is
    // current — renderHealthPanel shows the error card instead.
    state.healthStale = false;
  } finally {
    // LOW-6 fix (re-audit): unlike busyKey, `healthLoading` IS keyed to a
    // specific domain+mount's own scan — a stale response (wrong slug, or
    // this mount already abandoned) must not clear it, because a genuinely
    // in-flight CURRENT scan could still be running and relying on it
    // staying true until ITS OWN finally runs. An ungated reset here let an
    // old, abandoned loadHealth call silently turn off the "Scanning…"
    // indicator for a brand-new, still-running scan.
    if (slug === state.activeSlug && isCurrentMount(token)) state.healthLoading = false;
    render(token);
  }

  if (state.aiAvailable && state.health && slug === state.activeSlug && isCurrentMount(token)) {
    loadEstimates(slug, token).catch(reportAsyncActionFailure);
  }
}

async function loadEstimates(slug, token) {
  const jobs = [];
  if ((state.health.brokenLinks || []).length > 0) {
    jobs.push(['brokenLinks', '/api/health/' + encodeURIComponent(slug) + '/broken-links/estimate']);
  }
  if ((state.health.orphans || []).length > 0) {
    jobs.push(['orphans', '/api/health/' + encodeURIComponent(slug) + '/orphans/estimate']);
  }
  // H4 fix: the semantic-duplicate estimate used to be pushed here
  // unconditionally on every domain open/switch — see the file-header
  // comment above for why that's the expensive one. It's now fetched only
  // from confirmSemanticScan(), on demand, the first time the user opens
  // that specific quick-maintenance action.
  if (jobs.length === 0) return;

  for (const [key] of jobs) state.estimates[key] = 'loading';
  render(token);

  await Promise.all(jobs.map(async ([key, url]) => {
    try {
      const est = await fetchJSON(url);
      if (slug === state.activeSlug && isCurrentMount(token)) state.estimates[key] = est;
    } catch (err) {
      if (slug === state.activeSlug && isCurrentMount(token)) state.estimates[key] = { error: err.message };
    }
  }));
  if (slug === state.activeSlug && isCurrentMount(token)) render(token);
}

// ── Chat handoff ─────────────────────────────────────────────────────────
//
// "Ask this domain" hands the selected domain to Chat, which owns scope
// selection. This used to write two localStorage keys
// ('curator-next-chat-scope-request', 'curator-next-chat-first-run-request')
// that NOTHING read — dead on arrival, and worse than dead: localStorage
// survives a reload, so a key written by a click the user then abandoned
// sat there until some future Chat entry silently picked it up and scoped
// the conversation to a domain the user had not asked about. Both keys, and
// both writers, are gone; the handoff goes through the shell's own in-memory
// request/consume pair (app.js), which is cleared on read.
//
// THE WRAPPER ITSELF NOW LIVES IN shared/chat-scope.js (v3.62.0, P1-10). It
// was written here, and it stayed here for as long as this view was the only
// producer; the Context view's step ③ gained the same door, and two hand-
// written copies of a three-rule ritual (record, then navigate; exactly one
// navigate; a real slug) is what v3.7.0 deleted. The function is imported
// unchanged in every respect that this view can observe — same degradation
// contract, same single navigate() — with the no-slug hazard app.js names at
// the definition of `requestChatScope` now guarded once, inside it, for every
// producer rather than by each caller happening to hold a real slug.

// ── Domain lifecycle: create / rename / delete ─────────────────────────────
//
// Before this, every /api/domains call in /next was a bare GET: there was no
// way to create, rename or delete a domain at all. The three routes have
// existed since v2.x (src/routes/domains.js) — this is wiring, not new
// server capability — but three of their semantics are easy to get wrong and
// each was verified against that file rather than assumed:
//
//  1. POST returns **201**, not 200. `res.ok` covers both, so nothing here
//     tests the number; it is called out so nobody "fixes" a 201 later.
//  2. The slug is **server-generated** (generateUniqueSlug). The client never
//     sends one. The shipping onboarding wizard does compute and send a
//     `slug` field, which the server silently ignores — a client-computed
//     slug that disagrees with the server's is a bug waiting for the first
//     name collision, so it is deliberately not copied.
//  3. On rename, **newSlug can EQUAL oldSlug** — the display-name-only
//     branch of PUT /api/domains/:domain (routes/domains.js; cited by
//     route, not line number, which rots) returns `{oldSlug, newSlug:
//     oldSlug, …, syncWarning: false}`. Every piece of state re-keying below reads
//     the RESPONSE, never an assumption that the slug moved; assuming it
//     changed makes every subsequent call 404 on the domain that in fact
//     still exists under its old name. Both branches are tested.
//
// PUT and DELETE also 409 when the domain has an active write
// (isDomainActive). That refusal is rendered as its own message inside the
// form card the user is looking at — see the LIFECYCLE REFUSAL note on
// renderLifecycleCard.

const DOMAIN_TEMPLATES = [
  { value: 'generic', label: 'Generic', hint: 'A balanced starting schema. Good default.' },
  { value: 'tech', label: 'Tech', hint: 'Tools, frameworks, architectures, engineering practice.' },
  { value: 'business', label: 'Business', hint: 'Companies, markets, strategy, operations.' },
  { value: 'personal', label: 'Personal', hint: 'Notes, people, ideas from your own life.' },
];
const DOMAIN_TEMPLATE_VALUES = DOMAIN_TEMPLATES.map((t) => t.value);

// Client-side mirror of the server's two 400s (missing displayName, invalid
// template) so the user is told before a round trip. Deliberately NOT a
// slug validator — the server owns slug generation entirely.
function validateDomainForm(form) {
  const name = (form && typeof form.displayName === 'string') ? form.displayName.trim() : '';
  if (!name) return { ok: false, error: 'Give the domain a name.' };
  if (name.length > 120) return { ok: false, error: 'That name is too long — keep it under 120 characters.' };
  const template = (form && form.template) || 'generic';
  if (!DOMAIN_TEMPLATE_VALUES.includes(template)) return { ok: false, error: 'Pick one of the listed templates.' };
  return { ok: true, error: null };
}

// The exact POST body. No `slug` key — see semantic (2) above; a test
// asserts its absence, because "we accidentally started sending one again"
// is invisible until a collision renames someone's domain.
function createRequestBody(form) {
  return {
    displayName: (form.displayName || '').trim(),
    description: (form.description || '').trim(),
    template: form.template || 'generic',
  };
}

// Re-keys every piece of per-domain state off the rename RESPONSE.
// Returns { slugChanged, slug, message } — `slug` is the slug to keep
// using from here on, whichever branch fired.
function applyRenameResult(result) {
  const oldSlug = result.oldSlug;
  const newSlug = result.newSlug;
  const slugChanged = newSlug !== oldSlug;

  if (slugChanged) {
    // Move, don't duplicate: a stale healthSummary entry under the old slug
    // would keep painting an attention dot for a row that no longer exists.
    if (Object.prototype.hasOwnProperty.call(state.healthSummary, oldSlug)) {
      state.healthSummary[newSlug] = state.healthSummary[oldSlug];
      delete state.healthSummary[oldSlug];
    }
    if (state.readonlySet.has(oldSlug)) {
      state.readonlySet.delete(oldSlug);
      state.readonlySet.add(newSlug);
    }
    // Anything stamped with the OLD slug is now unreachable through the
    // active-* accessors anyway, but drop it explicitly rather than relying
    // on that: a scan of the pages under a name that no longer exists is
    // not something to keep offering merges from.
    if (state.semanticScan && state.semanticScan.slug === oldSlug) state.semanticScan = null;
    if (state.browse && state.browse.slug === oldSlug) state.browse = null;
    if (state.activeSlug === oldSlug) state.activeSlug = newSlug;
  }

  const name = result.displayName;
  const message = slugChanged
    ? ('Renamed to “' + name + '” — the folder moved from domains/' + oldSlug + '/ to domains/' + newSlug + '/.')
    : ('Renamed to “' + name + '” — the folder stays at domains/' + oldSlug + '/.');
  return { slugChanged, slug: slugChanged ? newSlug : oldSlug, message };
}

// Drops a deleted domain from every piece of state that references it, and
// picks a surviving domain to show (or none).
function applyDeleteResult(slug) {
  state.domains = state.domains.filter((d) => d.slug !== slug);
  state.readonlySet.delete(slug);
  delete state.healthSummary[slug];
  if (state.semanticScan && state.semanticScan.slug === slug) state.semanticScan = null;
  if (state.browse && state.browse.slug === slug) state.browse = null;
  if (state.activeSlug === slug) {
    state.activeSlug = state.domains.length ? state.domains[0].slug : null;
    state.health = null;
    state.healthError = null;
  }
  return { nextSlug: state.activeSlug };
}

// Turns a thrown fetchJSON error into { refusal, error }: a 409 from the
// write-registry is a REFUSAL (the operation did not happen, the server
// already explains why in a full sentence, and retrying later will work) —
// not a failure, and never a generic "something went wrong". v3.6.0's
// finding 7 is what this exists for: a refused destructive write that
// rendered nothing at all, so the user read the button snapping back as
// "my click didn't register" and clicked the destructive action again.
function classifyDomainError(err) {
  const conflict = err && (err.status === 409 || (err.body && err.body.conflict));
  if (conflict) return { refusal: err.message, error: null };
  return { refusal: null, error: err ? err.message : 'Unknown error' };
}

// Scrolls a just-rendered refusal/error into view if it landed off-screen.
//
// FOUND IN BROWSER VERIFICATION of this very change, which is the point of
// doing it: a 409 on a per-pair merge rendered correctly, on the pair the
// user clicked, with NO overlay anywhere on the page — and at y=1067 in an
// 892px viewport. The user clicks Merge near the top of a long scan list,
// the button re-enables, and the explanation is 175px below the fold. That
// is v3.6.0 finding 7's user experience reached by a different mechanism
// (scroll position rather than a scrim), and "we rendered it" is not the
// same claim as "they can see it" — which is exactly the distinction that
// finding was about. Same lesson as v3.0.14's scrollCardIntoView.
//
// Deliberately a no-op when the element is already fully in view: yanking
// the page around under someone who can already read the message is its own
// small hostility.
function revealMessage(selector) {
  const el = document.querySelector(selector);
  if (!el || typeof el.getBoundingClientRect !== 'function') return false;
  const r = el.getBoundingClientRect();
  if (r.height === 0 && r.width === 0) return false;
  if (r.top >= 0 && r.bottom <= window.innerHeight) return false; // already readable
  if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' });
  return true;
}

function openLifecycle(mode, domain) {
  state.banner = null;
  state.confirm = null;
  if (mode === 'create') {
    state.lifecycle = { mode: 'create', slug: null, displayName: '', description: '', template: 'generic', busy: false, error: null, refusal: null };
  } else {
    state.lifecycle = {
      mode,
      slug: domain.slug,
      displayName: domain.displayName || domain.slug,
      description: '',
      template: 'generic',
      busy: false,
      error: null,
      refusal: null,
    };
  }
  render(myMountToken);
}

function closeLifecycle() {
  state.lifecycle = null;
  render(myMountToken);
}

async function runCreateDomain() {
  const token = myMountToken;
  const form = state.lifecycle;
  if (!form || form.mode !== 'create' || form.busy) return;
  const v = validateDomainForm(form);
  if (!v.ok) { form.error = v.error; form.refusal = null; render(token); return; }

  form.busy = true; form.error = null; form.refusal = null;
  render(token);
  let succeeded = false;
  try {
    // 201 Created. `res.ok` in fetchJSON covers 2xx, so the status number
    // is not special-cased — see semantic (1) in the section comment.
    const result = await fetchJSON('/api/domains', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(createRequestBody(form)),
    });
    if (!isCurrentMount(token)) return;
    state.lifecycle = null;
    // Select the domain the SERVER named, never a slug guessed here.
    state.activeSlug = result.slug;
    state.banner = { tone: 'success', text: 'Created “' + result.displayName + '” at domains/' + result.slug + '/.' };
    succeeded = true;
  } catch (err) {
    if (!isCurrentMount(token)) return;
    const c = classifyDomainError(err);
    if (state.lifecycle) { state.lifecycle.error = c.error; state.lifecycle.refusal = c.refusal; }
  } finally {
    if (state.lifecycle) state.lifecycle.busy = false;
  }
  if (!isCurrentMount(token)) return;
  // The reload is deliberately OUTSIDE the try: it runs AFTER the write has
  // already happened, so a failure in it is a stale-list problem, not a
  // failed create/rename/delete. Reporting it through the catch above would
  // tell the user their domain was not created when it was — the same
  // shape as reporting a refusal as a success, in the other direction.
  if (succeeded) await reloadAfterLifecycleChange(token);
  else { render(token); revealMessage('.dm-lc-refusal, .dm-lc-error'); }
}

async function runRenameDomain() {
  const token = myMountToken;
  const form = state.lifecycle;
  if (!form || form.mode !== 'rename' || form.busy) return;
  const v = validateDomainForm({ displayName: form.displayName, template: 'generic' });
  if (!v.ok) { form.error = v.error; form.refusal = null; render(token); return; }

  // Target the slug the FORM was opened for, never state.activeSlug — see
  // the note in selectDomain(). Second layer; the form is also cleared on
  // any domain switch.
  const target = form.slug;
  form.busy = true; form.error = null; form.refusal = null;
  render(token);
  let succeeded = false;
  const releaseGate = beginDomainWrite(target, 'rename-domain');
  try {
    const result = await fetchJSON('/api/domains/' + encodeURIComponent(target), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: form.displayName.trim() }),
    });
    if (!isCurrentMount(token)) return;
    const applied = applyRenameResult(result);
    state.lifecycle = null;
    state.banner = {
      tone: 'success',
      text: applied.message + (result.syncWarning ? ' This change will propagate to GitHub on your next Sync.' : ''),
    };
    succeeded = true;
  } catch (err) {
    if (!isCurrentMount(token)) return;
    const c = classifyDomainError(err);
    if (state.lifecycle) { state.lifecycle.error = c.error; state.lifecycle.refusal = c.refusal; }
  } finally {
    releaseGate(); // unconditional — a stale mount must not leak a shell-wide write gate
    if (state.lifecycle) state.lifecycle.busy = false;
  }
  if (!isCurrentMount(token)) return;
  if (succeeded) await reloadAfterLifecycleChange(token); // outside the try — see runCreateDomain
  else { render(token); revealMessage('.dm-lc-refusal, .dm-lc-error'); }
}

async function runDeleteDomain() {
  const token = myMountToken;
  const form = state.lifecycle;
  if (!form || form.mode !== 'delete' || form.busy) return;
  const target = form.slug;
  form.busy = true; form.error = null; form.refusal = null;
  render(token);
  let succeeded = false;
  const releaseGate = beginDomainWrite(target, 'delete-domain');
  try {
    const result = await fetchJSON('/api/domains/' + encodeURIComponent(target), { method: 'DELETE' });
    if (!isCurrentMount(token)) return;
    applyDeleteResult(target);
    state.lifecycle = null;
    state.banner = {
      tone: 'success',
      text: 'Deleted “' + (form.displayName || target) + '”.' +
        (result && result.syncWarning ? ' The deletion propagates to GitHub on your next Sync.' : ''),
    };
    succeeded = true;
  } catch (err) {
    if (!isCurrentMount(token)) return;
    const c = classifyDomainError(err);
    if (state.lifecycle) { state.lifecycle.error = c.error; state.lifecycle.refusal = c.refusal; }
  } finally {
    releaseGate(); // unconditional
    if (state.lifecycle) state.lifecycle.busy = false;
  }
  if (!isCurrentMount(token)) return;
  if (succeeded) await reloadAfterLifecycleChange(token); // outside the try — see runCreateDomain
  else { render(token); revealMessage('.dm-lc-refusal, .dm-lc-error'); }
}

// Shared tail for all three: re-fetch the list (page counts, display names
// and readonly flags all come from the server) and rescan whichever domain
// is now active. Never assumes the local list is already correct.
async function reloadAfterLifecycleChange(token) {
  const keepBanner = state.banner;
  await loadDomainsList(token);
  if (!isCurrentMount(token)) return;
  // loadDomainsList -> loadHealth renders several times; re-assert the
  // outcome banner afterwards so the result of a destructive action is not
  // scrolled off or repainted away before the user reads it.
  state.banner = keepBanner;
  render(token);
}

// ── Semantic-duplicate pair gate ───────────────────────────────────────────
//
// WHY THIS SECTION EXISTS AT ALL. The shipping app offers TWO ways to act on
// a semantic-duplicate pair: a per-pair path where Merge is DISABLED until
// the user has opened a Preview diff for that exact pair (and the handler
// hard-refuses without it), and a batch "Merge all N high-confidence" path
// behind a text confirm. /next shipped only the batch path — so the only
// available action on an LLM's duplicate judgement was "merge all of them,
// sight unseen". That merge DELETES a file and rewrites every [[link]] to it
// across the whole domain. Without Flip there was no way to correct a
// high-confidence pair pointing the wrong way (keep the stub, delete the
// rich page); without Skip the same false positive returned on every future
// scan, forever.
//
// TWO INVARIANTS, both with precedent, both of which have already been real
// bugs in this project:
//
//  1. THE PREVIEWED SET IS CLEARED ON: a new scan, a domain switch, and a
//     Flip. `state` in this file is module-scoped and survives leaving the
//     view, so a set that is never cleared can outlive the scan it belongs
//     to and authorise a merge on a DIFFERENT domain's pair. It is defended
//     twice, and the two layers are deliberately independent:
//       LAYER 1 — the set lives INSIDE state.semanticScan, and
//         resetDomainScopedHealthState() nulls that object. Structural: a
//         new scan cannot inherit an old set, because the set is part of the
//         object being replaced. There is no second place holding a copy.
//       LAYER 2 — the scan is STAMPED with the slug it was scanned for, and
//         activeSemanticScan() returns it only while that stamp still
//         matches state.activeSlug. Every reader and every action goes
//         through that accessor.
//     Layer 2 does not depend on anyone remembering layer 1, and the tests
//     assert each SEPARATELY (a mutation that only one layer catches is a
//     blind spot with a passing test in front of it — v3.4.0's lesson).
//
//  2. THE BATCH RUNNER DERIVES ITS PAIR LIST FROM LIVE STATE AT CLICK TIME,
//     never from the array the scan returned. This is not a nicety: the
//     shipping app fixed exactly this in a v3.0.1-beta.15 audit — "a user's
//     Flip / Skip / individual-Merge before clicking 'Merge all' could merge
//     the WRONG direction or re-merge a dismissed pair". It reads the live
//     DOM cards because there the cards ARE the state; here the pairs array
//     IS the state, so liveHighConfidencePairs() reads it at call time and
//     runMergeSemanticDuplicates() re-derives once more at execution, after
//     the confirm dialog the user may have left open while flipping things.
//     Adding Flip/Skip on top of a frozen array would have re-created a bug
//     this project has already paid for once.

function semanticPairKey(pair) {
  return pair.keepFolder + '/' + pair.keepSlug + '||' + pair.removeFolder + '/' + pair.removeSlug;
}

// LAYER 2. The ONLY way any renderer or action reaches the scan.
function activeSemanticScan() {
  const s = state.semanticScan;
  if (!s) return null;
  if (s.slug !== state.activeSlug) return null;
  return s;
}

// Test/observability accessor for LAYER 1: what the previewed set actually
// holds, unfiltered by the slug stamp. Asserting on this is what makes
// "the set is EMPTY after a scan / domain switch / Flip" a real claim
// rather than "some later check happens to refuse".
function rawPreviewedKeys() {
  const s = state.semanticScan;
  if (!s || !s.previewed) return [];
  return [...s.previewed];
}

function markSemanticPreviewed(pair) {
  const s = activeSemanticScan();
  if (!s) return false;
  s.previewed.add(semanticPairKey(pair));
  return true;
}

function isSemanticPreviewed(pair) {
  const s = activeSemanticScan();
  if (!s) return false;
  return s.previewed.has(semanticPairKey(pair));
}

// ── CHAINED MERGES: one merge can resolve several pairs ───────────────────
//
// `findSemanticCandidatePairs` emits EVERY pair above threshold, so a family
// of near-identical pages is a dense CLIQUE — 8 versions of one page produce
// 28 pairs, and every page appears in 7 of them. Merging one pair deletes a
// page that up to N-2 other pairs still name, and before this those siblings
// stayed on screen as ordinary action cards: Preview failed ("Both pages must
// exist"), Merge stayed gated behind "Preview required before Merge", and the
// only way out was to re-run a PAID scan.
//
// So when a page goes, every OPEN pair that names it — on either side — is
// marked `resolved`, with the sentence that explains it. Local, deterministic
// and free: the pair list the user paid an LLM for is preserved (this is NOT
// a reason to drop the scan), and nothing is sent anywhere.
//
// Called from BOTH paths, and the batch is the one that matters most: it
// deletes many pages in a single pass, so most of a clique's later pairs go
// stale mid-run. Fixing only the single-pair path would have left the path
// that runs FIRST, and runs over the most pages, still broken — v3.0.17's
// recorded lesson, where a response-shape fix landed on the fallback while
// the batch path that runs for every ingest kept the original bug.
//
// `byPair` supplies the sentence, so the user reads WHY the card changed
// rather than finding a row that silently rewrote itself. Returns the number
// of pairs it resolved, which is what makes it assertable on its own.
function resolvePairsTouching(scan, gone, byPair) {
  if (!scan || !Array.isArray(scan.pairs) || !gone || !gone.slug || !gone.folder) return 0;
  const goneKey = gone.folder + '/' + gone.slug;
  const by = byPair && byPair.removeSlug && byPair.keepSlug
    ? byPair.removeSlug + ' was merged into ' + byPair.keepSlug
    : 'an earlier merge';
  let resolved = 0;
  for (let i = 0; i < scan.pairs.length; i++) {
    const p = scan.pairs[i];
    if (!p || p.status !== 'open') continue;
    const names = (p.keepFolder + '/' + p.keepSlug) === goneKey ||
                  (p.removeFolder + '/' + p.removeSlug) === goneKey;
    if (!names) continue;
    scan.pairs[i] = Object.assign({}, p, {
      status: 'resolved',
      resolvedBy: by,
      resolvedMissing: goneKey,
      refusal: null,
      error: null,
    });
    // Same defense-in-depth as markSemanticPairStatus: a resolved pair is
    // already refused by the status check, but leaving a previewed key for a
    // page that no longer exists is a stale authorisation, and this costs a
    // delete.
    if (scan.previewed) scan.previewed.delete(semanticPairKey(p));
    if (scan.preview && scan.preview.key === semanticPairKey(p)) scan.preview = null;
    resolved++;
  }
  return resolved;
}

// Marks ONE pair resolved — the pair the server itself just told us is stale
// (a `stale` batch frame, a stale preview, or a merge refused because a page
// is gone). Its siblings are handled by resolvePairsTouching above.
function markSemanticPairResolved(pair, opts) {
  const s = activeSemanticScan();
  if (!s) return false;
  const key = semanticPairKey(pair);
  const idx = s.pairs.findIndex((p) => semanticPairKey(p) === key);
  if (idx === -1) return false;
  s.pairs[idx] = Object.assign({}, s.pairs[idx], {
    status: 'resolved',
    resolvedBy: (opts && opts.by) || 'the page is gone',
    resolvedMissing: (opts && opts.missing) || null,
    refusal: null,
    error: null,
  });
  s.previewed.delete(key);
  if (s.preview && s.preview.key === key) s.preview = null;
  return true;
}

// DEFENCE IN DEPTH for a page deleted OUTSIDE this session — in Obsidian, by
// the MCP, by another Health fix on another tab. The server's refusal keeps a
// stable `no longer exists` substring (staleSemanticPairError in
// src/brain/health.js) precisely so this can recognise it without the client
// re-deriving what "gone" means. Returns { missing } or null.
function semanticStaleFromError(err) {
  const msg = err && err.message ? String(err.message) : '';
  if (!/ no longer exists/.test(msg)) return null;
  const m = /^\s*((?:entities|concepts)\/[^\s]+) no longer exists/.exec(msg);
  return { missing: m ? m[1] : null };
}

// The gate itself. Returns { allowed, reason } so a refusal always has
// something to SAY — a silently-disabled button is how a user concludes
// their click did not register.
function canMergeSemanticPair(pair) {
  const s = activeSemanticScan();
  if (!s) return { allowed: false, reason: 'That scan belongs to a different domain — run a new scan here first.' };
  const idx = s.pairs.indexOf(pair);
  const known = idx !== -1 ? s.pairs[idx] : s.pairs.find((p) => semanticPairKey(p) === semanticPairKey(pair));
  if (!known) return { allowed: false, reason: 'That pair is no longer part of the current scan.' };
  // `resolved` is its own answer, ahead of the generic "already been handled".
  // The user did not handle this pair — a merge they made elsewhere in the
  // same scan did, and the refusal has to say which page went or it reads as
  // the app losing track.
  if (known.status === 'resolved') {
    return {
      allowed: false,
      reason: 'Already resolved by an earlier merge — ' +
        (known.resolvedMissing ? known.resolvedMissing + ' no longer exists.' : 'one of its pages no longer exists.'),
    };
  }
  if (known.status !== 'open') return { allowed: false, reason: 'That pair has already been handled.' };
  if (!s.previewed.has(semanticPairKey(known))) return { allowed: false, reason: 'Open the preview diff for this pair before merging it.' };
  return { allowed: true, reason: null };
}

// Swaps which side of the pair survives, and CLEARS THE WHOLE PREVIEWED SET.
//
// Clearing the whole set (rather than just this pair's key) is deliberate
// and is the fail-closed direction. The shipping app relies on the flipped
// pair getting a different identity key, so the old key simply stops
// matching — correct today, and silently wrong the day anyone makes the key
// direction-insensitive. Clearing outright does not depend on the key
// derivation being right. The cost is that other pairs must be previewed
// again; the preview is a free, local, read-only call (no LLM), so re-doing
// it costs the user nothing but a click, while the failure it prevents is
// deleting a file in the direction the user did not choose.
function flipSemanticPair(pair) {
  const s = activeSemanticScan();
  if (!s) return false;
  const idx = s.pairs.findIndex((p) => semanticPairKey(p) === semanticPairKey(pair));
  if (idx === -1) return false;
  const p = s.pairs[idx];
  s.pairs[idx] = {
    keepFolder: p.removeFolder, keepSlug: p.removeSlug,
    removeFolder: p.keepFolder, removeSlug: p.keepSlug,
    confidence: p.confidence, rationale: p.rationale, status: p.status,
  };
  s.previewed.clear();
  s.preview = null;
  return true;
}

// INVARIANT 2. Read at call time, never captured.
function liveHighConfidencePairs() {
  const s = activeSemanticScan();
  if (!s) return [];
  return s.pairs.filter((p) => p.status === 'open' && p.confidence === 'high');
}

function markSemanticPairStatus(pair, status) {
  const s = activeSemanticScan();
  if (!s) return false;
  const key = semanticPairKey(pair);
  const idx = s.pairs.findIndex((p) => semanticPairKey(p) === key);
  if (idx === -1) return false;
  s.pairs[idx] = Object.assign({}, s.pairs[idx], { status });
  // Defense in depth, not redundancy: canMergeSemanticPair's own
  // `status !== 'open'` check already refuses a merged/skipped pair, so
  // this line's effect is invisible to any assertion that only goes
  // THROUGH the gate. Covered independently in
  // scripts/test-next-semantic-gate.js §2d via rawPreviewedKeys(), the
  // same raw-read escape hatch §2a-§2c use to test LAYER 1 on its own —
  // otherwise a docblock elsewhere in this file claiming "the tests assert
  // each layer separately" would be true of the previewed-set-clearing
  // invariant in general but silently false of this one line.
  s.previewed.delete(key);
  if (s.preview && s.preview.key === key) s.preview = null;
  return true;
}

// The wire shape fixSemanticDuplicate() resolves (keep*/remove*), with no
// client-side extras. `status` is view-local bookkeeping and must never be
// sent — the batch route validates each pair through the same resolver.
function toWirePair(p) {
  return {
    keepFolder: p.keepFolder, keepSlug: p.keepSlug,
    removeFolder: p.removeFolder, removeSlug: p.removeSlug,
    confidence: p.confidence,
  };
}

// ── Sidebar ────────────────────────────────────────────────────────────────

/**
 * The durable route to an existing knowledge base.
 *
 * IT LIVES IN THE SIDEBAR, ON EVERY STATE, and that placement is the load-
 * bearing half of this fix rather than a nicety. If this affordance existed
 * ONLY on the empty-domains card, then the single most likely wrong click —
 * an existing user pressing "New domain" — would create one junk domain in
 * the wrong folder, which makes the domain list non-empty, which DESTROYS THE
 * EMPTY CARD, which takes the only route to their real wiki with it. They
 * would end up worse off than before, with no way back and no error to
 * search for. Here, the route survives every state the view can reach —
 * including the load-error state, where "your configured folder cannot be
 * read" is exactly the condition repointing fixes.
 */
function knowledgeFolderBtn() {
  // ── A DESCRIPTOR SINCE v3.65.0, RENDERED BY THE KIT ────────────────────
  // The values are unchanged: same id, same `dm-kb-btn` class, same two
  // labels, same disabled rule, same 13px folder icon. What changed is WHO
  // writes the `<button>` — shared/sidebar.js's head, so this slot means the
  // same thing on all three sidebars ("the one alternative route": Use
  // existing folder here, Refresh on Context, Updates on Settings) rather
  // than being three hand-written buttons that happen to look alike.
  return {
    label: state.kbBusy ? 'Waiting for the folder picker…' : 'Use existing folder',
    id: 'dm-kb-choose-btn',
    className: 'dm-kb-btn',
    disabled: state.kbBusy,
    iconHtml: icon('folder', 13),
  };
}

/**
 * The outcome of the last switch, rendered wherever the user is looking.
 *
 * v3.6.0's finding 7 is the reason this is never silent: a refused action
 * that renders NOTHING reads as "my click didn't register", and the user
 * repeats it. Every non-cancel outcome — success, empty folder, refusal,
 * capability refusal, transport failure — reaches a visible surface.
 */
function renderKnowledgeNotice() {
  const n = state.kbNotice;
  if (!n) return '';
  const undo = n.undoPath
    ? '<div class="dm-kb-undo">' +
        '<button class="btn btn-secondary" id="dm-kb-undo-btn"' + (state.kbBusy ? ' disabled' : '') + '>' +
          'Go back to the previous folder' +
        '</button>' +
        '<code class="mono dm-kb-path">' + escapeHtml(n.undoPath) + '</code>' +
      '</div>'
    : '';
  return '<div class="dm-kb-notice">' +
    renderStatus({ state: n.state, title: n.title, detail: n.detail }) + undo +
  '</div>';
}

/**
 * "We looked here." One line, and it is the most useful line on an empty
 * screen — it converts "my knowledge base is gone" into "wrong folder",
 * which is a problem a person can act on. Renders nothing when the config
 * read failed, because an invented path would be worse than none.
 */
function renderLookedInLine() {
  const p = state.kb && state.kb.domainsPath;
  if (!p) return '';
  return '<div class="dm-kb-lookedin">Looking in <code class="mono dm-kb-path">' +
    escapeHtml(p) + '</code></div>';
}

// Wired after every render that emits either control, for the same reason
// every other binder in this file is: setSidebar/setMain replace the DOM
// wholesale, so a listener attached last time is attached to a node that no
// longer exists.
function bindKnowledgeListeners() {
  // ── BOUND ONCE PER NODE (v3.64.1) — see bindStatCardListeners. This one is
  // guarded on the TARGETS rather than on a section, because its two buttons
  // live in DIFFERENT branches of renderMain (the knowledge notice, and the
  // empty card's own action row) and a single section selector would be right
  // in one branch and absent in the other.
  const kb = document.getElementById('dm-empty-kb-btn');
  if (kb && !kb.__dmBound) {
    kb.__dmBound = true;
    kb.addEventListener('click', () => onChooseKnowledgeFolder(myMountToken).catch(reportAsyncActionFailure));
  }
  const undo = document.getElementById('dm-kb-undo-btn');
  if (undo && !undo.__dmBound && state.kbNotice && state.kbNotice.undoPath) {
    undo.__dmBound = true;
    // The target is captured HERE, from the notice that produced this button,
    // rather than read out of state when the click lands. state.kbNotice is
    // replaced by every subsequent outcome, and an undo that resolves its own
    // destination late would send the user to whichever folder the LATEST
    // notice happens to name — the same stale-target class as the compile
    // card's captured conversation id.
    const target = state.kbNotice.undoPath;
    undo.addEventListener('click', () => onUndoKnowledgeFolder(target, myMountToken).catch(reportAsyncActionFailure));
  }
}

function renderSidebar(token) {
  if (!isCurrentMount(token)) return;
  // THE TITLE AND THE TWO ACTIONS, THROUGH THE KIT. The primary slot is
  // "create the kind of thing this list holds" and the secondary is the one
  // alternative route; see shared/sidebar.js's head for why those two slots
  // are the whole vocabulary and why there is no ⓘ option on a sidebar title.
  const newBtn = renderSidebarHead({
    title: 'Domains',
    primary: {
      label: 'New domain', id: 'dm-new-domain-btn',
      className: 'dm-new-btn', iconHtml: icon('grid', 13),
    },
    secondary: knowledgeFolderBtn(),
  });

  // THE GROUP HEAD WITH NO GROUP UNDER IT. renderSidebarGroup refuses to
  // render an eyebrow over no rows — "a caption for an empty box reads as a
  // failure" — and it is right, but these three branches are not that case:
  // the eyebrow names the list that IS about to exist, above a loader, an
  // error or the sentence that says why it is empty. So the head is written
  // here, with the kit's own class rather than the inline
  // `style="margin-top:10px"` it carried through v3.64.2 (an inline style is
  // the one declaration no stylesheet and no [data-theme] block can reach).
  const groupHead = '<div class="cur-sb-group-head cur-eyebrow">KNOWLEDGE</div>';

  if (!state.loaded) {
    setSidebar(newBtn + gatedLoader(loadGate, 'Loading…', 'sidebar-hint'), token);
    bindSidebarButtons();
    return;
  }
  if (state.loadError) {
    setSidebar(
      // A RUNTIME ERROR, not a hint. `.sidebar-hint` renders a marketing
      // sentence in sync.js and rendered this failure too, separated only by
      // a colour modifier — one class, two meanings, which is the defect.
      //
      // THIS IS A SEMANTIC FIX, NOT A CONTRAST ONE, and the distinction is
      // measured rather than assumed: `.dm-error-text` won the cascade here,
      // so the old line rendered at --danger-text and measured 7.80 dark /
      // 5.41 light — it PASSED AA. What changes is that a failure is now a
      // STATE with its own shape (rail measured 5.41:1 against its box,
      // above the 3:1 non-text floor) rather than a hint wearing red, and
      // that the server's own message is the DETAIL, so the headline stays
      // constant and the cause is not glued onto the end of our sentence.
      // `.sidebar-hint` still carries the LOADING placeholder above, which is
      // loading-gate.js's role and deliberately not converted to a status.
      // (Its COLOUR is no longer --text-3: this comment used to record 4.27 /
      // 4.14, under AA, as an accepted gap. shell.css now paints both sidebar
      // empty-state roles --text-2 — 8.34 / 7.26 measured — for the reason
      // written at that rule. The semantic point above is unchanged; only the
      // colour claim was corrected, because it had stopped being true.)
      // Wrapped only to carry this view's spacing: text.css owns the type,
      // domains.css owns where it sits.
      newBtn +
      '<div class="dm-sidebar-status">' +
        renderStatus({ state: 'danger', title: 'Could not load domains', detail: state.loadError }) +
      '</div>',
      token
    );
    bindSidebarButtons();
    return;
  }
  if (state.domains.length === 0) {
    setSidebar(
      newBtn + groupHead +
      '<div class="sidebar-note">No domains yet. A domain is one compounding wiki — create your first one above.</div>',
      token
    );
    bindSidebarButtons();
    return;
  }

  // ONE clock for the whole list — see the identical line in views/ingest.js.
  // Reading Date.now() per row lets two rows painted together land on
  // different sides of midnight and disagree about what "today" is.
  const now = Date.now();
  const rows = state.domains.map((d, i) => {
    const readonly = state.readonlySet.has(d.slug);
    const active = d.slug === state.activeSlug;
    const issueCount = state.healthSummary[d.slug];
    const attention = typeof issueCount === 'number' && issueCount > 0;
    // NIT fix: this used to always append the literal word " pages", so a
    // freshly-created domain with exactly one page read "1 pages" — Chat
    // gets this right everywhere else ("1 page in scope").
    const pagesText = typeof d.pageCount === 'number'
      ? d.pageCount.toLocaleString() + ' page' + (d.pageCount === 1 ? '' : 's')
      : '— pages';
    // ── THE STATUS-ROW ANATOMY, NOW THE KIT'S ────────────────────────────
    // name · key figure · freshness mark + clock glyph + relative age · last
    // event. Every slot is optional and the ORDER is fixed by the component,
    // which is the point: the Context rail had the same facts in a different
    // order with no clock at all, and a component that emits the glyph is one
    // a host cannot forget to pass (*"it has clocks showing when it was
    // changed; in Context we don't have that"*).
    //
    // The IDENTITY dot (`.dm-row-dot`, six palette colours) and the ATTENTION
    // dot (`.dm-row-attn`, open health issues) are untouched: three marks,
    // three separate facts, and folding any of them into the others would
    // make one dot answer questions it cannot. The identity COLOUR is the
    // KIT's now (v3.65.1) — `identityDotClass(i)` and shared/sidebar.css's
    // `.cur-sb-dot-N` — so this row, a Context project row, a Chat chip and
    // an Ingest destination row all take the same colour from the same place.
    //
    // `i` IS THE INSTALL'S DOMAIN INDEX, not a position in some filtered
    // view: `state.domains` is GET /api/domains/stats' own order, which is
    // listDomains()'s. A dot that meant "second in the list I happen to be
    // showing" would be a different colour per screen, which is the defect
    // this whole system exists to remove.
    return renderSidebarRow({
      alias: 'dm',
      name: d.displayName || d.slug,
      dotClass: identityDotClass(i),
      figure: pagesText,
      markHtml: freshnessDotHtml(d.lastIngestDate, now),
      age: formatDayAge(d.lastIngestDate, now),
      ageFallback: 'nothing written yet',
      // The absolute date, kept and REACHABLE — visually hidden rather than a
      // `title=`, which is hover-only and therefore invisible to keyboard and
      // touch. This file's hover-only ceiling in
      // scripts/test-next-title-affordances.js is ONE (the Flip button), and
      // this must not raise it.
      ageExact: d.lastIngestDate || '',
      event: domainLastEventText(d) || '',
      active,
      data: { 'domain-slug': d.slug },
      // ── TWO BADGES WHOSE MEANING WAS HOVER-ONLY ───────────────────
      // `RO` was a <span title="Read-only Shared Brain mirror">, and the
      // attention badge was an EMPTY <span> whose entire content was its
      // tooltip — the purest form of the defect: a keyboard user reached
      // nothing, and on touch, where there is no hover, the issue count did
      // not exist.
      //
      // WHY NOT THE INFO-MARK BUTTON USED IN settings.js: both spans are
      // INSIDE the row's own `<button>`, and a <button> inside a <button> is
      // invalid HTML — the browser closes the outer one and the row stops
      // being a single control. So the meaning goes into the row button's own
      // ACCESSIBLE NAME instead, which is reachable precisely because that row
      // IS focusable. `.visually-hidden` is shell.css's existing clip-rect
      // utility; no stylesheet change.
      //
      // STATED RATHER THAN IMPLIED AWAY: this fixes keyboard and screen
      // reader, not sighted-touch, which still sees a glyph. For a sighted
      // user both facts are one tap away on the domain's own detail view —
      // the read-only mirror status box and the `Open issues N` readout —
      // so neither is information that exists nowhere else for them.
      //
      // THEY RIDE `badgesHtml`, which the kit names as TRUSTED: this is host
      // markup by construction, composed here from an escaped slug-free
      // literal and an integer.
      badgesHtml:
        (readonly
          ? '<span class="dm-row-mirror">RO</span>' +
            '<span class="visually-hidden">Read-only Shared Brain mirror</span>'
          : '') +
        (attention
          ? '<span class="dm-row-attn"></span>' +
            '<span class="visually-hidden">' + issueCount + ' open health issue' +
              (issueCount === 1 ? '' : 's') + '</span>'
          : ''),
    });
  }).join('');

  setSidebar(
    newBtn + renderSidebarGroup({ eyebrow: 'KNOWLEDGE', alias: 'dm', rowsHtml: rows }),
    token
  );

  bindSidebarButtons();
  document.querySelectorAll('.dm-row[data-domain-slug]').forEach((btn) => {
    btn.addEventListener('click', () => selectDomain(btn.dataset.domainSlug));
  });
}

// Both sidebar actions, in one place, because both are emitted by all four
// of renderSidebar's branches and a binder that covered only one of them
// would leave a live-looking button dead in three of them.
function bindSidebarButtons() {
  const btn = document.getElementById('dm-new-domain-btn');
  if (btn) btn.addEventListener('click', () => openLifecycle('create'));
  const kb = document.getElementById('dm-kb-choose-btn');
  if (kb) kb.addEventListener('click', () => onChooseKnowledgeFolder(myMountToken).catch(reportAsyncActionFailure));
}

// Entered synchronously by a click handler — reading myMountToken here is
// safe (see the doc comment on it above).
function selectDomain(slug) {
  if (slug === state.activeSlug) return;
  state.activeSlug = slug;
  state.confirm = null;
  state.banner = null;
  state.expandedGroups = new Set();
  // A create/rename/delete form opened for the PREVIOUS domain must not
  // survive a domain switch. Rename and delete both carry a target slug, so
  // a form left standing across a switch is a destructive action pointing
  // at one domain while the whole screen around it describes another. (The
  // action functions independently target `lifecycle.slug` rather than
  // `state.activeSlug`, so even a form that somehow survived could not act
  // on the wrong domain — same two-layer shape as the semantic gate.)
  state.lifecycle = null;
  state.browse = null;
  // Same rule, same reason, for the project surface: a Delete form left
  // standing across a domain switch is a destructive action pointing at one
  // domain while the screen around it describes another. Both layers are
  // kept here too — the form carries its own `slug`, and the list is stamped
  // (see activeProjects()) — so neither depends on the other being
  // remembered.
  state.projectLc = null;
  state.projects = null;
  state.copied = null;

  // ── AND THEN THIS DOMAIN'S OWN LAST-SEEN LISTS COME BACK ───────────────
  //
  // THE CLEARING ABOVE IS UNCONDITIONAL AND STAYS THAT WAY. What is restored
  // here is never the domain we are leaving — it is the slug we are arriving
  // at, read out of a cache keyed by that slug, and re-stamped with it. So
  // the property those two lines exist for ("the previous domain's list was
  // dropped before the ask, never rendered under the new heading") is
  // untouched: there is no arrangement of this code in which domain A's rows
  // can appear under domain B's name, and activeBrowse()/activeProjects()
  // still independently refuse a mismatched stamp at RENDER time.
  //
  // IT HAPPENS HERE, BEFORE THE render() BELOW, AND THAT IS THE WHOLE POINT.
  // Everything in this function runs in one synchronous task, so the browser
  // paints once, at the end of it. Seeding before that single paint is what
  // makes the 26 px collapsed card unobservable rather than merely brief —
  // it was measured on screen for ~60 ms per switch, a 521-559 px jump down
  // and back up.
  //
  // A MISS IS THE STATUS QUO. `state.cache[slug]` is absent on the first
  // visit to a domain in a session, and both fields simply stay null, which
  // is exactly what this function did before.
  const cached = state.cache ? state.cache[slug] : null;
  if (cached && cached.browse) {
    state.browse = {
      slug, loading: false, error: null,
      entries: cached.browse.entries, memory: cached.browse.memory,
      memoryTruncated: cached.browse.memoryTruncated, truncated: cached.browse.truncated,
      total: cached.browse.total,
      // The filter, the facet and the window are a statement about what the
      // user was doing on the LAST visit, not about the domain. They reset,
      // so a switch lands on the whole list the way it always has.
      filter: '', folder: 'all', window: cached.browse.window,
      // THE LENS DOES NOT RESET WITH THEM, and the difference is real: it is
      // a preference the user set and that survives a restart on disk, not a
      // position inside one visit's list. Resetting it here would make a
      // cached switch disagree with the cold one loadBrowse seeds from the
      // same record. INSTALL-WIDE since v3.64.1 — it says which KIND of
      // document this person reads a domain page for, which is not a fact
      // about any one domain.
      lens: (state.sectionPrefs && state.sectionPrefs.lens) || 'wiki',
    };
  }
  if (cached && cached.projects) {
    state.projects = {
      slug, loading: false, error: null,
      rows: cached.projects.rows, truncated: cached.projects.truncated,
      canWrite: cached.projects.canWrite, readonly: cached.projects.readonly,
    };
  }
  // The scan is DECLARED here rather than a moment later inside loadHealth,
  // for the reason loadDomainsList already records at its own copy of this
  // line: loadHealth runs synchronously up to its first await and would set
  // it anyway, so declaring it now folds two states into the single paint
  // this task produces instead of leaving an intermediate one in which the
  // health section has vanished entirely.
  state.healthLoading = true;
  render(myMountToken);
  loadHealth(slug, myMountToken).catch(reportAsyncActionFailure);
  loadProjects(slug, myMountToken).catch(reportAsyncActionFailure);
  // The page list loads WITH the domain (v3.49.0), for the same reason the
  // project list does and on the same terms: it is a readdir, it costs
  // nothing, and it is the one thing on this screen the user actually came
  // to see. Not awaited and not ordered against the two above — each paints
  // itself when it lands.
  loadBrowse(slug, myMountToken).catch(reportAsyncActionFailure);
}

// ── Projects inside a domain (v3.48.0) ─────────────────────────────────────
//
// WHY THIS LIVES ON THE DOMAIN CARD AND NOT IN AGENT MEMORY. Creating,
// renaming and deleting a project is domain ADMINISTRATION — the same kind
// of act as creating a domain, and it belongs beside it. Agent memory is
// where you READ what the agents left; it edits the one thing that is yours
// (the standing brief) and nothing else.
//
// WHAT A PROJECT COSTS TO DELETE, stated because the button is right here:
// its standing brief, every work-stream handoff under it and every journal
// line. Those are frequently the only record of decisions that were never
// written down anywhere else, and there is no in-app undo (see GIT_UNDO_WARN
// — with Personal Sync configured a git client recovers them, and without it
// nothing does). So Delete takes a TYPED confirmation, and the route
// enforces the same confirmation independently: a confirmation that lives
// only in a view is a confirmation every other client skips.

/**
 * The starting brief offered by "Create project", and by the brief editor
 * when there is nothing to edit yet.
 *
 * The four headings are the ones the store renders and every agent read
 * returns. The closing line is load-bearing rather than decorative: a real
 * brief carries whatever headings its owner wants (the maintainer's own has
 * "Roadmap" and "How I want you to work"), and nothing in the store rewrites
 * a brief into these four. Saying so here is what stops the template reading
 * as a schema.
 */
// ── "Read before you…" (v3.62.0) ───────────────────────────────
//
// Tier 0 can now be ROUTED: a foundation flagged `readFirst` is handed to
// every session, and everything else rides as an index the agent opens BY
// NAME. What the flag cannot express is WHICH document for WHICH KIND OF
// WORK — that is a sentence, not a boolean, and it belongs to the owner.
// This heading is where it goes, and the agent-instructions block tells an
// agent to consult it.
//
// THIS IS A SECOND COPY, and it is a knowingly imperfect one. The store has
// its own `briefTemplate(project)` (src/brain/working-state.js) used by the
// MCP path; this array is the one the create FORM seeds, and the two have
// never been byte-equal — the store's headings carry italic prompts and a
// `# <project>` title this form does not want, because the form's field is
// edited in a textarea next to a name the user has just typed. Folding them
// into one is a real piece of work and it is not this release's; what IS
// this release's is that the heading a new project needs in order to use the
// reading plan is present in BOTH, so an owner who starts from either sees
// the place to write the routing table down.
const PROJECT_BRIEF_TEMPLATE = [
  '## Standing brief',
  '',
  'What this project is, and what "done" looks like.',
  '',
  '## Read before you…',
  '',
  'Which Document to open for which kind of work. Documents marked',
  '"read first" arrive with every session; name the rest here and an agent opens',
  'them by name.',
  '',
  '- …change how anything is built: architecture.md',
  '- …re-open a settled question: decisions.md',
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
  '<!-- Add any headings you like — these five are a starting point, not a schema. -->',
  '',
].join('\n');

/** LAYER 2 of the project list's domain scoping. The ONLY reader of state.projects. */
function activeProjects() {
  const p = state.projects;
  if (!p || !state.activeSlug || p.slug !== state.activeSlug) return null;
  return p;
}

async function loadProjects(slug, token) {
  // ── STALE-WHILE-REVALIDATE, the same three states as loadBrowse ────────
  // `painted` = a filled, non-errored list for THIS slug is already on
  // screen, either because this module's state survived leaving the view or
  // because selectDomain seeded it from the session cache a moment ago. Then
  // nothing is blanked and nothing is rendered on the way in; the skeleton
  // rows below are for a genuinely cold first sight of a domain only.
  //
  // WRITTEN INLINE, deliberately, rather than through a shared helper. This
  // function is LIFTED and EXECUTED by scripts/test-next-domain-projects.js
  // inside a sandbox whose collaborators are a fixed hand-written list, so a
  // new free identifier here does not make that suite go red — it makes it
  // CRASH with a ReferenceError, which reads like a passing run in a summary
  // line. That is the v3.11.0 shape this repo has recorded twice. `state` is
  // supplied by every such sandbox, so reaching the cache through it is the
  // one spelling that stays executable in all of them.
  const painted = !!(state.projects && state.projects.slug === slug &&
                     !state.projects.loading && !state.projects.error);
  if (!painted) {
    state.projects = { slug, loading: true, error: null, rows: [], truncated: false, canWrite: false, readonly: false };
    render(token);
  }
  try {
    // fetchJSON THROWS on a non-2xx and returns the parsed body otherwise —
    // it is this file's one fetch shape and is not re-implemented here.
    const body = await fetchJSON('/api/memory/' + encodeURIComponent(slug) + '/projects');
    if (!isCurrentMount(token) || state.activeSlug !== slug) return;
    const next = {
      slug,
      loading: false,
      error: null,
      rows: Array.isArray(body && body.projects) ? body.projects : [],
      truncated: !!(body && body.truncated === true),
      // The SERVER says whether it can write, and the controls render from
      // that rather than from a version string: a capability is a fact about
      // the server that answered.
      canWrite: !!(body && body.canWrite === true),
      readonly: !!(body && body.readonly === true),
    };
    // The whole answer, serialised — not a digest of the fields someone
    // thought the renderer reads. See browseSignature for why.
    const sig = JSON.stringify([next.rows, next.truncated, next.canWrite, next.readonly]);
    const slot = (state.cache && (state.cache[slug] || (state.cache[slug] = {}))) || {};
    // An identical revalidation repaints nothing: setMain() rebuilds the
    // whole column, and a column that comes back identical is pure cost.
    if (painted && slot.projectsSig === sig) return;
    state.projects = next;
    slot.projects = {
      rows: next.rows, truncated: next.truncated, canWrite: next.canWrite, readonly: next.readonly,
    };
    slot.projectsSig = sig;
  } catch (err) {
    if (!isCurrentMount(token) || state.activeSlug !== slug) return;
    // A FAILED BACKGROUND RE-ASK NEVER REPLACES A GOOD LIST WITH AN ERROR.
    // The rows on screen came from a successful read of this same domain and
    // the user did not ask for the re-ask; blanking them would be strictly
    // worse than saying nothing.
    if (painted) return;
    state.projects = {
      slug, loading: false, rows: [], truncated: false, canWrite: false, readonly: false,
      error: err.message,
    };
  }
  render(token);
}

// ── Main column ────────────────────────────────────────────────────────────

/**
 * The list-view header, in ONE place.
 *
 * Four branches of renderMain used to concatenate `eyebrow(...) + '<h1 ...>'`
 * by hand, which is four hand-maintained copies of one header and four places
 * a paragraph could be appended under a title. One builder, four callers, and
 * DOMAIN_BLURB reaches the fold on every branch instead of only the empty one.
 */
function domainsHeader() {
  return renderViewHeader({ eyebrow: 'your brain', title: 'Domains', info: DOMAIN_BLURB });
}

function renderMain(token) {
  if (!isCurrentMount(token)) return;
  if (!state.loaded) {
    // Chrome (eyebrow + title) is known before the fetch and paints
    // immediately, so the column never blanks; only the BODY waits, and
    // only shows a loader if the gate fires.
    setMain(domainsHeader() + gatedLoader(loadGate, 'Loading…'), token);
    return;
  }
  if (state.loadError) {
    setMain(
      domainsHeader() +
      renderKnowledgeNotice() +
      emptyCard({
        title: 'Could not load domains',
        // The path is part of the diagnosis, not decoration: this branch is
        // reached by EACCES, ENOTDIR and an unmounted volume, and every one
        // of those is a statement about a specific folder.
        body: escapeHtml(state.loadError) + renderLookedInLine(),
        actionHtml: knowledgeFolderBtn(),
      }),
      token
    );
    bindKnowledgeListeners();
    return;
  }
  if (state.domains.length === 0) {
    setMain(
      domainsHeader() +
      renderKnowledgeNotice() +
      renderLifecycleCard() +
      emptyCard({
        title: 'No domains here yet',
        // ── WHY THE EXISTING USER IS ADDRESSED FIRST ──────────────────────
        // The two readers of this screen are a brand-new user and a
        // long-time user whose wiki is in another folder, and NOTHING on
        // this screen can tell them apart — the read layer returns the same
        // empty list for a fresh install, an unmounted drive and someone's
        // Pictures folder (measured; see the section header above). So the
        // choice is made on the COST OF BEING WRONG, and it is wildly
        // asymmetric: the new user who reads one extra sentence loses a few
        // seconds, while the existing user who does not see this sentence
        // concludes that years of work are gone. That is the failure this
        // release exists to close, so it is the one the copy is aimed at.
        //
        // Both routes are present and neither is hidden behind a
        // disclosure. "Use existing folder" takes the card's primary
        // styling; "New domain" keeps a primary-styled button of its own in
        // the sidebar, three inches away and visible in this exact state, so
        // the create path is not demoted anywhere on the screen — it simply
        // stops being the only thing the eye lands on.
        body:
          '<div class="dm-empty-lines">' +
            '<div>Already have a knowledge base? If you have used The Curator before — on this Mac, ' +
            'another machine, or a synced folder — point it at that folder and every domain, page and ' +
            'link comes back exactly as it was. Nothing is copied, moved or converted.</div>' +
            '<div>Starting fresh? Create a domain: name it, pick a starting schema, and it is ready to ' +
            'ingest into. Nothing is written until you confirm.</div>' +
          '</div>' + renderLookedInLine(),
        actionHtml:
          '<div class="dm-empty-actions">' +
            '<button class="btn btn-primary" id="dm-empty-kb-btn"' + (state.kbBusy ? ' disabled' : '') + '>' +
              icon('folder', 13) + ' ' +
              (state.kbBusy ? 'Waiting for the folder picker…' : 'Use existing folder') +
            '</button>' +
            '<button class="btn btn-secondary" id="dm-empty-new-btn">' + icon('grid', 13) + ' New domain</button>' +
          '</div>',
      }),
      token
    );
    const emptyNew = document.getElementById('dm-empty-new-btn');
    if (emptyNew && !emptyNew.__dmBound) {
      emptyNew.__dmBound = true;
      emptyNew.addEventListener('click', () => openLifecycle('create'));
    }
    bindKnowledgeListeners();
    bindLifecycleListeners();
    return;
  }

  const domain = state.domains.find((d) => d.slug === state.activeSlug);
  if (!domain) { setMain(domainsHeader(), token); return; }

  const readonly = state.readonlySet.has(domain.slug);
  // MEDIUM-2 fix (re-audit): `pageCounts.other` is a real, additive backend
  // field (files.js) — pages that don't fall under entities/concepts/
  // summaries (a stray root-level note, for example). `pageCount` is
  // DELIBERATELY the recursive total INCLUDING `other`, specifically so
  // the four numbers reconcile — files.js's own comment calls a renderer
  // that shows only three of the four "now the bug, and a visible one".
  // Reproduced before this fix: a domain with 1 stray note rendered
  // "A compounding wiki of 3 pages — 2 entities, 0 concepts, 0 summaries."
  // — a self-contradicting sentence (2 ≠ 3) with the remainder nowhere to
  // be found. `other` must never just be dropped; it's rendered as a
  // fourth stat card AND folded into the scope sentence (only when
  // non-zero, so the common all-zero case reads exactly as before).
  const counts = domain.pageCounts || { entities: 0, concepts: 0, summaries: 0, other: 0 };
  const otherCount = counts.other || 0;
  const pages = typeof domain.pageCount === 'number' ? domain.pageCount : (counts.entities + counts.concepts + counts.summaries + otherCount);

  // The five figures this used to spell out in prose are rendered by
  // renderStatCards below, from these exact variables. See DOMAIN_BLURB for
  // why the sentence was de-duplicated rather than restyled as a readout.
  // The path line stays OUTSIDE renderViewHeader and keeps `.dm-path-eyebrow
  // mono`. It is a PATH, and typography.css gives paths to IBM Plex Mono;
  // routing it through the header's eyebrow slot would render it in the sans
  // face. It is a location, not prose, so it is not what this change is about.
  //
  // ④'s ⓘ (v3.65.3) — ONE paragraph, the same in every state; the
  // explanations its states used to carry inline moved here (rule 3).
  // WRITTEN INLINE, not as a module const, and composed once: three suites
  // lift renderMain by brace-matching and execute it against a fixed stub
  // list, so a new module-level name here is a suite that CRASHES — infoMark
  // is already on every one of those lists.
  const sharedInfo = infoMark('dm-shared-info', 'About Shared Brain',
    'A Shared Brain is a wiki a cohort writes together. A domain takes part in one of two ways: it contributes — ' +
    'Push summarises the pages you changed with your AI provider and sends them to the cohort’s GitHub repository — ' +
    'or it is a mirror, the read-only copy of the merged wiki that Pull writes onto this computer. Which domains ' +
    'contribute is chosen when you join; to change it, leave and join again. Turning the feature on, joining and ' +
    'setting one up happen in the Shared Brain view.');
  const html =
    // A SUCCESSFUL switch lands here, not on the empty card — the whole point
    // is that the list is no longer empty. If the confirmation only rendered
    // in the empty state, the one outcome worth confirming would be the one
    // outcome nobody ever saw.
    renderKnowledgeNotice() +
    '<div class="dm-path-eyebrow mono">domains/' + escapeHtml(domain.slug) + '/</div>' +
    renderViewHeader({
      title: domain.displayName || domain.slug,
      info: readonly ? MIRROR_INFO : DOMAIN_BLURB,
      infoId: 'tx-vh-info-domain',
      actionsHtml:
        (readonly ? '<span class="dm-mirror-pill">' + icon('lock', 11) + ' read-only mirror</span>' : '') +
        '<button class="btn btn-secondary dm-title-btn" id="dm-rename-btn">Rename</button>' +
        '<button class="btn btn-ghost dm-title-btn dm-delete-btn" id="dm-delete-btn">' + icon('trash', 13) + ' Delete</button>' +
        '<button class="btn btn-primary dm-ask-btn" id="dm-ask-btn">' + icon('messageSquare', 14) + ' Ask this domain</button>',
    }) +
    // UNFOLDED, ALWAYS. See MIRROR_WARNING: this is a data-loss notice about
    // the domain on screen, so it renders in the body and not behind the mark.
    (readonly ? renderStatus({ state: 'attention', title: 'Edits here are not kept', detail: MIRROR_WARNING }) : '') +
    renderLifecycleCard() +
    renderStatCards(counts, pages, projectCount(), {
      // A `shared-*` mirror gets NO Ingest section (views/ingest.js refuses a
      // mirror as a destination), so it gets neither jump tile — a tile that
      // scrolls to nothing is the control-with-no-outcome this card already
      // refuses to draw for a facet with no list.
      sources: !readonly,
      lastIngest: domain.lastIngestDate || null,
      shared: state.sharedJump,
    }) +
    // ── INGEST, ABOVE THE INDEX OF WHAT IT ADDED (v3.64.0) ───────────────
    //
    // WHY THE SHELL IS WRITTEN OUT HERE INSTEAD OF BEING A FUNCTION. Three
    // offline suites lift THIS function by brace-matching and execute it
    // inside `new Function` against a fixed list of stubs; a call to a new
    // helper here is a ReferenceError in each of them — a suite that CRASHES
    // rather than asserts — and two of the three belong to other packages.
    // So this function's free identifiers are byte-for-byte the ones it had,
    // and everything new is reached through `setMain`, which every one of
    // those sandboxes already stubs. See the host-seam header above.
    //
    // IT SITS ABOVE THE WIKI for the reason the v3.49.0 order states: the act
    // of adding comes before the index of what was added, and it is the one
    // section a first-time user must find — which is why Ingest was moved to
    // rail slot 2 in v3.49.0 and why losing that slot had to be paid for
    // here.
    //
    // (v3.64.0–v3.65.1 derived an OPEN/CLOSED default here — open on a
    // domain never ingested into — and remembered the user's choice
    // install-wide. v3.65.2 retires both: the section is simply always open.
    // See "① IS NO LONGER A FOLD" below.)
    // ── ONE HEADING RULE FOR ALL FIVE SECTIONS (v3.64.2) ─────────────────
    //
    // THE REPORTED DEFECT, from the maintainer's screenshot of v3.64.1: the
    // numerals sat at TWO x positions. ② PAGES, ③ PROJECTS and ⑤ WIKI HEALTH
    // put the numeral and the title ABOVE their card, at the column's own x;
    // ① INGEST and ④ SHARED BRAIN put them INSIDE the fold's `<summary>`,
    // after a chevron and inside the summary's 14px padding — "one number on
    // the left, another a few pixels to the right". And all five titles were
    // ALL CAPS while the Context view's steps beside them read "① Foundations"
    // in Title case.
    //
    // The rule is now the Context view's, for all five: the numeral badge and
    // a Title-case title sit ABOVE the card, never inside a `<summary>`. The
    // fold keeps its `<details>` — the summary becomes the card's first ROW,
    // carrying the chevron and the one reading that decides whether to open
    // it — so the collapsed card still opens from that row.
    //
    // THE HEAD IS A SIBLING, NOT A WRAPPER, AND THAT IS A CORRECTNESS RULE.
    // `patchMainAroundHosts` identifies a hosted fold by `before.id` over the
    // TOP-LEVEL children of `.main-inner`. Wrapping the `<details>` in a
    // `<section>` would hide that id one level down, so the fold would be
    // compared by `outerHTML` and REPLACED on every paint — remounting the
    // hosted panel on every paint, and destroying the drop target under a
    // held drag, which is the v3.46.0 shape D-J exists to prevent.
    //
    // ④'s SUMMARY CARRIES `aria-label`, because a disclosure control whose
    // only content is a chevron and a date has no accessible name. The name
    // is the section's, so a screen reader hears what it opens. (① has no
    // summary since v3.65.2; its `<section>` is labelled by its own title.)
    // ── R4: THE EXPLANATION SITS IN THE ⓘ, NOT IN THE BODY (v3.65.0) ─────
    // The maintainer's own words about the same shape on the Context view:
    // *"below the Foundations title we have 'Add the documents an agent must
    // not act without' with another information icon, so maybe we don't need
    // the first sentence, we just need the information icon beside the
    // title."* This section's sentence was the first line of the fold's
    // BODY, which is worse rather than better: you only reach it by opening
    // the fold, i.e. at the moment you are about to drop a file and least
    // want a paragraph.
    //
    // THE HEAD BLOCK IS STILL ONE TOP-LEVEL CHILD, and that is the D-J
    // constraint rather than a layout choice: `patchMainAroundHosts` finds a
    // hosted fold by `before.id` over the TOP-LEVEL children of
    // `.main-inner`, so the head and its panel are ONE sibling ABOVE the
    // `<details>` and never a wrapper around it. The inner shape is ③'s,
    // verbatim — `.dm-section-head-row` holding `.dm-section-hd` and the
    // mark at --space-2, then the panel — so the numeral keeps its one x
    // position and the mark sits where OVERVIEW's already does.
    // ── ① IS NO LONGER A FOLD (v3.65.2, I1) ─────────────────────────────
    // The maintainer, on v3.65.1: *"Ingest is number one but hidden below a
    // drop-down. Get rid of it — it's important, not long, it should be
    // exposed."* So the `<details>` became a plain `<section>`: always open,
    // no chevron, and NO stored open/closed preference (readSectionPrefs no
    // longer reads `sources`, so an old stored value is dropped on the next
    // write rather than consulted). ④ Shared Brain stays a fold.
    //
    // THE ID DID NOT MOVE, and that is the D-J constraint again:
    // `patchMainAroundHosts` recognises the host by `id="dm-sources-fold"`
    // among the column's TOP-LEVEL children and never replaces it, so the
    // drop target keeps its node identity through every repaint exactly as
    // it did while this was a `<details>`. The id is a name, not a promise
    // that the element folds.
    //
    // THE READING MOVED UP INTO THE HEAD ROW. "last ingest 3 days ago" lived
    // in the fold's summary row, right-aligned; with no summary left, a row
    // holding nothing but that reading would be a bar of empty card. It sits
    // right-aligned in the section's own head row instead, in the fold
    // meta's face — the same place and the same type the eye already reads
    // for a section's one reading — and because the head block is an
    // ordinary child it is patched like one when the domain changes.
    (readonly ? '' :
      '<div class="dm-section dm-section-hd-block dm-sources-hd">' +
        '<div class="dm-section-head-row">' +
          '<div class="dm-section-hd">' +
            '<span class="dm-section-num" aria-hidden="true">1</span>' +
            '<div class="cur-group-title dm-section-eyebrow" id="dm-sources-title" tabindex="-1">Ingest</div>' +
          '</div>' +
          infoMark('dm-ingest-info', 'About ingest', INGEST_INFO).btn +
          '<span class="dm-fold-meta dm-section-meta">' +
            (domain.lastIngestDate ? 'last ingest ' + escapeHtml(relTime(domain.lastIngestDate))
                                   : 'nothing ingested yet') +
          '</span>' +
        '</div>' +
        infoMark('dm-ingest-info', 'About ingest', INGEST_INFO).panel +
      '</div>' +
      '<section class="dm-fold dm-sources" id="dm-sources-fold" aria-labelledby="dm-sources-title">' +
        '<div class="dm-fold-body">' +
          '<div class="dm-host" id="dm-sources-host"></div>' +
        '</div>' +
      '</section>') +
    // ── THE WIKI COMES FIRST (v3.49.0) ───────────────────────────────────
    // Reported by a power user who could not find "the wiki" at all: the
    // page browser was the LAST thing on this card, behind a "Browse pages"
    // button, under a maintenance report. So the index of his own knowledge
    // — the thing this whole application exists to build — sat below a list
    // of broken links, and the four stat cards above it counted pages he had
    // no way to see.
    //
    // The order is now: what the domain HOLDS (stat cards, then the pages
    // themselves), then what is ABOUT the domain (its projects), then the
    // maintenance report on it. That reads outward from the content, which is
    // what the user came for, to the housekeeping, which is what they came
    // for on the days something is wrong.
    //
    // THIS SUPERSEDES the v3.48.0 placement note, which argued Projects
    // belonged above Health and Browse because "a project is a thing about
    // the domain itself — the same kind of fact as its page counts". That
    // argument is kept and still holds AGAINST HEALTH: Projects is still
    // above the health report, and someone looking for "where does my agent
    // memory live" still finds it without scrolling past one. What the
    // argument got wrong was ranking a fact about the domain above the
    // domain's own contents.
    renderBrowsePanel() +
    renderProjectsPanel(readonly) +
    // ── SHARED BRAIN, BETWEEN THE PROJECTS AND THE HOUSEKEEPING ──────────
    //
    // A fact ABOUT the domain, like Projects, and above the maintenance
    // report for the same reason Projects is.
    //
    // ── ④ IS NO LONGER A FOLD (v3.65.3) ─────────────────────────────────
    // The maintainer, on v3.65.2: *"let's do the same like we did with
    // Ingest — no drop-down, this is an important section, show it without
    // a drop-down."* The same move as ①: the `<details>` became a plain
    // `<section>` (always open, no chevron, no stored preference —
    // readSectionPrefs no longer reads `shared`), the head gained ①'s
    // anatomy (numeral, title, ⓘ, and the one reading right-aligned), and
    // the panel now mounts on EVERY domain page, which is also what makes
    // the OVERVIEW's SHARED tile appear at all (D7).
    //
    // THE ID DID NOT MOVE — `patchMainAroundHosts` recognises the host by
    // `id="dm-shared-fold"` among the column's top-level children and never
    // replaces it, so a push in flight, a shown-once admin token and a typed
    // revoke keep their nodes through every repaint.
    //
    // THE READING is `state.sharedReading`, which onSharedLensChange() also
    // writes straight into `#dm-shared-reading` with no repaint; '' until
    // the panel has reported, never a guess (D6).
    '<div class="dm-section dm-section-hd-block dm-shared-hd">' +
      '<div class="dm-section-head-row">' +
        '<div class="dm-section-hd">' +
          '<span class="dm-section-num" aria-hidden="true">4</span>' +
          '<div class="cur-group-title dm-section-eyebrow" id="dm-shared-title" tabindex="-1">Shared Brain</div>' +
        '</div>' +
        sharedInfo.btn +
        '<span class="dm-fold-meta dm-section-meta" id="dm-shared-reading">' + escapeHtml(state.sharedReading || '') + '</span>' +
      '</div>' +
      sharedInfo.panel +
    '</div>' +
    '<section class="dm-fold dm-shared" id="dm-shared-fold" aria-labelledby="dm-shared-title">' +
      '<div class="dm-fold-body"><div class="dm-host" id="dm-shared-host"></div></div>' +
    '</section>' +
    renderHealthPanel(domain, readonly);

  setMain(html, token);
  // ── THE HEADER'S THREE CONTROLS, BOUND ONCE PER NODE (v3.64.1) ─────────
  // setMain patches now, so the view header survives a paint in which only a
  // section below it moved — and a plain `?.addEventListener` here would add
  // a second listener to the same button on every landing load. Written
  // inline with an expando rather than through a helper for this function's
  // standing reason: three suites lift renderMain by brace-matching and
  // execute it against fixed stub lists, so a new free identifier here is a
  // suite that CRASHES. An expando is invisible to the patch's byte
  // comparison, which a `data-*` mark would not be.
  const askBtn = document.getElementById('dm-ask-btn');
  if (askBtn && !askBtn.__dmBound) {
    askBtn.__dmBound = true;
    askBtn.addEventListener('click', () => goToChatScoped(domain.slug));
  }
  const renameBtn = document.getElementById('dm-rename-btn');
  if (renameBtn && !renameBtn.__dmBound) {
    renameBtn.__dmBound = true;
    renameBtn.addEventListener('click', () => openLifecycle('rename', domain));
  }
  const deleteBtn = document.getElementById('dm-delete-btn');
  if (deleteBtn && !deleteBtn.__dmBound) {
    deleteBtn.__dmBound = true;
    deleteBtn.addEventListener('click', () => openLifecycle('delete', domain));
  }
  bindLifecycleListeners();
  bindProjectListeners();
  bindKnowledgeListeners();
  bindHealthListeners(domain, readonly);
  bindBrowseListeners();
  bindStatCardListeners();
}


// ── An ⓘ mark and its fold, for a section that is not a view header ───────
//
// The domain header already has one (renderViewHeader's `info`), and the
// maintainer's report of the Projects section was precisely that its
// explanation should be "under an ⓘ info icon like the domain header's". This
// is that mark, and it is the SHARED COMPONENT'S CONTRACT rather than a second
// pattern: shared/text.js installs ONE delegated document listener at module
// scope keyed on `[data-tx-info]` + getElementById, with no coupling to
// renderViewHeader at all. Emitting the same two elements inherits, for free
// and with nothing to bind per render: toggle on click, Escape closes AND
// returns focus to the button, outside-click dismisses, click-inside does not,
// one panel open at a time. `.tx-vh-info` and `.tx-vh-panel` are likewise
// unscoped in text.css, so this view's stylesheet gains no rule for them.
// views/settings.js reached the same conclusion and carries the same helper;
// the glyph here is pinned byte-identical to text.js's INFO_GLYPH by this
// view's suite, so the copies cannot drift while they are apart.
//
// WHAT MUST NEVER GO IN `info`: warnings, costs, spend figures,
// irreversibility. v3.16.1's rule — a warning behind a click is not a warning.
// What goes here is neutral explanation of a visible label, which is exactly
// what the Projects paragraph is.
//
// `opts.html === true` treats `info` as a TRUSTED fragment instead of escaping
// it — the same option, spelled the same way, that shared/text.js's
// `renderInfoMark` and `renderViewHeader` already carry, and added here for the
// same reason they have it: the Projects fold is two labelled paragraphs, and
// a labelled paragraph needs a `<strong>` and a `<p>`. The test is `=== true`,
// never truthy, so a stray string cannot switch escaping off — and the licence
// is for markup written IN THIS FILE. Nothing a user, a provider or the store
// typed may be interpolated into a fragment passed here without going through
// escapeHtml first. NO CONTROL may go inside the panel: the delegated listener
// toggles on the BUTTON, so anything focusable in the fold is unreachable
// until the fold is open.
function infoMark(id, label, info, opts) {
  const glyph =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>';
  const text = typeof info === 'string' ? info.trim() : '';
  if (!id || !text) return { btn: '', panel: '' };
  const name = label || 'More information';
  const asHtml = !!opts && opts.html === true;
  return {
    btn:
      '<button type="button" class="tx-vh-info" id="' + escapeHtml(id) + '-btn"' +
        ' data-tx-info="' + escapeHtml(id) + '"' +
        ' aria-expanded="false" aria-controls="' + escapeHtml(id) + '"' +
        ' aria-label="' + escapeHtml(name) + '" title="' + escapeHtml(name) + '">' +
        glyph +
      '</button>',
    panel:
      '<div class="tx-vh-panel" id="' + escapeHtml(id) + '" role="group"' +
        ' aria-label="' + escapeHtml(name) + '" hidden>' +
        (asHtml ? text : escapeHtml(text)) + '</div>',
  };
}

// ── WHAT THE TWO COPY CONTROLS ACTUALLY DO, IN THE APP ────────────────────
//
// Three strings, one subject, and they are module constants so the suite can
// lift them and cross-check the FILE NAMES they quote against the two places
// that define them — `shared/agent-instructions.js` (whose COPY_SUCCESS_BANNER
// is the post-copy confirmation the user sees seconds later) and
// `docs/working-state.md` (§"Where it goes" and §"The `.curator-project`
// marker"). A doc-links-style check: rename a file in the block or the docs
// and `npm test` goes red on the same commit, rather than the app quietly
// telling people to paste into a file nothing reads.
//
// WHAT EACH ONE IS, verified against those sources rather than from memory:
//
//   Copy marker line        -> the literal text `<domain>/<project>`, saved as
//                              a file named `.curator-project` at a repo root.
//                              NO server code and NO MCP tool reads that file;
//                              the continuity SKILL does, as step two of its
//                              three-step ritual (conversation wins, then the
//                              marker, then ask). docs/working-state.md calls
//                              it "a convention, not a mechanism".
//   Copy agent instructions -> composeAgentInstructions({domain, project}) —
//                              the heading `## Working state` plus the frozen
//                              measured paragraph — pasted into the file the
//                              harness auto-loads: CLAUDE.md (Claude Code),
//                              AGENTS.md (Codex, opencode), GEMINI.md (Gemini
//                              CLI), or Cursor rules. It exists because a
//                              harness can decline to activate the skill at
//                              all: 0/4 headless runs saved on Claude Code
//                              with the skill alone, 3/4 with the block.
//
// The wording is deliberately the SAME in the fold and in the post-copy
// banner, because they are read seconds apart and a user comparing them must
// not have to decide which one is right.
const MARKER_INFO_TEXT =
  'Copies this project’s marker line — the text domain/project. Save it as a file called ' +
  '.curator-project at the root of that project’s folder, and an agent that starts there — most ' +
  'often a coding agent — knows which project to resume instead of asking you.';

const AGENT_INFO_TEXT =
  'Copies a short paragraph of instructions naming this project. Paste it into CLAUDE.md, ' +
  'AGENTS.md, GEMINI.md or your Cursor rules — whichever file your agent loads every ' +
  'session — and it will read your Memory before it starts and save a Handoff before ' +
  'it stops.';

// The section fold. TWO LABELLED PARAGRAPHS, and the only fragment in this
// file passed to infoMark with `{html: true}`: every character of it is
// written here, so nothing user-, provider- or store-supplied is interpolated.
const PROJECTS_INFO_HTML =
  '<p><strong>What a project is.</strong> A domain is one compounding wiki; a project is one ' +
  'thing you build inside it. Each project has a standing brief you write, and Handoffs ' +
  'your agents save handoffs into, so a new session resumes where the last one stopped. Both ' +
  'are plain markdown under this domain’s state folder and travel with Personal Sync.</p>' +
  '<p><strong>The two copy buttons.</strong> Copy marker line copies domain/project; save it ' +
  'as a file named .curator-project at the root of that project’s repository, and an agent ' +
  'there knows which project to resume. Copy agent instructions copies a short paragraph ' +
  'instead — paste it into CLAUDE.md, AGENTS.md, GEMINI.md or your Cursor rules, and agents ' +
  'read and save its Memory without being asked.</p>';

// ── The Projects sub-section ───────────────────────────────────────────────

/**
 * One project's row in the inset grouped list.
 *
 * THE PILL IS A PLAIN WORD, and it says the FACT rather than a state name:
 * "Standing brief" / "No brief yet", never `configured` / `not set`. The
 * v3.45.0 Providers pass is the precedent and the reason — a person reading
 * this row is asking "is there a brief?", and a status vocabulary makes them
 * translate.
 *
 * THE THREE FACTS on the row are the three that answer "is this the project
 * I mean?": whether the brief exists, when an agent last saved, and which
 * work-stream that save was in. Nothing else — the whole document lives one
 * click away in Project context, and a row that tried to summarise it would be
 * a worse version of that screen.
 *
 * EACH COPY CONTROL CARRIES ITS OWN ⓘ. Reported by the maintainer — who
 * builds this app — about his own UI: "I do not know what Copy marker line
 * is." Two ghost-ghost buttons side by side, both saying "Copy", neither
 * saying what lands on the clipboard or where it goes. The fold beside each
 * one answers the three questions in order: what it copies, where you paste
 * it, what happens then. The section ⓘ above says the same thing in the
 * plural; these say it at the control, which is where it is asked.
 *
 * Pure, and exported through __testing: this is what the row assertions
 * drive.
 */
function renderProjectRow(row, canWrite, index) {
  const name = String(row.project == null ? '' : row.project);
  const markerInfo = infoMark(projInfoId('marker', name, index),
    'About Copy marker line', MARKER_INFO_TEXT);
  const agentInfo = infoMark(projInfoId('agent', name, index),
    'About Copy agent instructions', AGENT_INFO_TEXT);
  const brief = row.hasBrief
    ? renderBadge({ label: 'Standing brief', tone: 'success' })
    : renderBadge({ label: 'No brief yet', tone: 'neutral' });
  // relTime takes the ISO string and answers "just now" / "4 hours ago".
  // `lastWriteAt` is the FILE's clock, which git rewrites on checkout, so a
  // project synced from another machine dates to the pull — the store also
  // reports the agent's own clock, and it is preferred where it exists. A
  // fact and its absence stay distinguishable: "no saves yet" is a real
  // answer and is never rendered as an age.
  const savedIso = row.writtenAt || row.lastWriteAt || null;
  const saved = savedIso ? relTime(savedIso) : null;
  const facts = [
    saved ? 'last save ' + saved : 'no saves yet',
    row.newestScope ? 'newest Handoff ' + row.newestScope : null,
    // The store's own word, and its own claim: this is where the domain's
    // OWN project lives, permanently — not a pre-v3.48.0 leftover waiting
    // for a migration, which is what "original" invited a reader to think.
    // It is also the one project that can be neither renamed nor deleted.
    row.isDefaultProject ? 'the domain’s own project — it cannot be renamed or deleted' : null,
  ].filter(Boolean).join(' · ');

  return (
    '<div class="cur-group-row dm-proj-row">' +
      '<div class="cur-group-label">' +
        '<b>' + escapeHtml(name) + ' ' + brief + '</b>' +
        '<span>' + escapeHtml(facts) + '</span>' +
      '</div>' +
      '<div class="cur-group-control">' +
        '<button class="btn btn-ghost dm-proj-btn" data-proj-marker="' + escapeHtml(name) + '">' +
          'Copy marker line</button>' +
        markerInfo.btn +
        // THE SECOND HALF OF THE SAME JOB, and the reason it is a second
        // button rather than more words on the first. The marker line says
        // WHICH project a repository is; this says WHAT AN AGENT SHOULD DO
        // ABOUT IT — read at the start, save early, save complete — and it
        // goes in a different file, for a different reader.
        //
        // It is here on every row, the domain's own project included, for the
        // same reason the marker is: both are things you paste into a
        // repository, and the domain's own project is a perfectly ordinary
        // project to be building in. Neither is a write, so neither is gated
        // on `canWrite` — a read-only Shared Brain mirror can still be
        // resumed, it just cannot be renamed.
        '<button class="btn btn-ghost dm-proj-btn" data-proj-agent="' + escapeHtml(name) + '">' +
          'Copy agent instructions</button>' +
        agentInfo.btn +
        // THE DOMAIN'S OWN PROJECT GETS NEITHER CONTROL. Its directory IS the
        // domain's state root, which holds every named project too, so the
        // store refuses both by name (`reason: 'default-project'`) — renaming
        // it would move every other project with it and deleting it would take
        // them all. Rendering the buttons anyway would put two controls on
        // screen whose only possible outcome is a refusal, which this view's
        // own read-only arm already refuses to do. The row's fact line says
        // why they are missing, so their absence is an answer rather than a
        // gap.
        (canWrite && !row.isDefaultProject
          ? '<button class="btn btn-secondary dm-proj-btn" data-proj-rename="' + escapeHtml(name) + '">Rename</button>' +
            '<button class="btn btn-ghost dm-proj-btn dm-delete-btn" data-proj-delete="' + escapeHtml(name) + '">' +
              icon('trash', 12) + ' Delete</button>'
          : '') +
      '</div>' +
      // ── THE TWO FOLDS SIT BELOW THE ROW, AND THAT IS A LAYOUT FACT ───────
      // `renderInfoMark`'s two fragments are an INLINE mark and a BLOCK
      // panel; the mark belongs beside its control, and a block panel inside
      // `.cur-group-control` — a `flex: none` row — would be squeezed into
      // the control strip. `.cur-group-row` is a flex row, so this wrapper
      // takes `flex: 0 0 100%` (domains.css) and drops to its own line under
      // the controls, full row width, where the panel can be read.
      //
      // Both panels are emitted for every row and both ship `hidden`; the
      // shared delegated listener opens at most one at a time, app-wide.
      '<div class="dm-proj-info-panels">' + markerInfo.panel + agentInfo.panel + '</div>' +
    '</div>'
  );
}

/**
 * A DOM id for one project row's ⓘ fold.
 *
 * The NAME is slugified so the id says which row it belongs to, and the row
 * INDEX is appended so two names that slugify alike (`a_b` and `a-b` both
 * reach `a-b`) cannot ship duplicate ids — which is v3.54.0's
 * `renderViewHeader` collision, where `getElementById` returned the first
 * match and one panel became permanently unreachable. The index also keeps
 * the id stable across a re-render, which is what lets render()'s
 * capture/restore re-open the fold the user had open.
 */
function projInfoId(kind, name, index) {
  const slug = String(name == null ? '' : name)
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const i = Number.isFinite(index) ? index : 0;
  return 'dm-proj-' + kind + '-info-' + (slug || 'project') + '-' + i;
}

/**
 * The whole sub-section: caption, rows, and the create control.
 *
 * AN INSET GROUPED LIST (`.cur-group`), not a stack of cards. shell.css's own
 * block says why: a rounded card whose rows are separated by a hairline inset
 * to the label's x-offset is a macOS settings group, and a gap between
 * bordered cards is a web form. These rows belong to each other.
 *
 * EVERY STATE RENDERS SOMETHING. Loading, failed, empty and read-only each
 * say what they are, because a section that vanishes when it has nothing to
 * show is indistinguishable from a section that failed.
 */
/**
 * The confirmation (or the refusal) for whichever of the two copy buttons was
 * pressed last. Pure apart from reading `state`, and lifted out of this
 * file by the suite, which drives it rather than scanning it.
 *
 * THE REFUSAL PATH PRINTS WHAT DID NOT REACH THE CLIPBOARD, in both cases.
 * `navigator.clipboard` is unavailable on a non-secure origin and can be
 * refused outright, and a button that silently did nothing is the worst
 * possible outcome for a user who is about to go and paste. The marker is one
 * line, so it fits in the status text; the agent block is a paragraph, so it
 * gets a selectable mono block underneath instead of being crammed into a
 * sentence.
 */
function renderCopyOutcome() {
  const c = state.copied;
  if (!c) return '';
  const agent = c.kind === 'agent';
  if (c.ok) {
    return renderStatus({
      state: 'success',
      title: agent ? 'Agent instructions copied' : 'Marker line copied',
      // The success wording for the agent block is COPY_SUCCESS_BANNER's own
      // second half: the banner names the four files because the whole point
      // of the block is that it is harness-neutral, and a confirmation that
      // said only "copied" would leave the user looking for somewhere to put
      // it.
      detail: agent
        ? COPY_SUCCESS_BANNER
        : 'Paste it into a file called .curator-project at the root of that project\u2019s repository. '
          + 'An agent that finds it knows which project to resume without being told.',
    });
  }
  return renderStatus({
    state: 'attention',
    title: 'Could not copy',
    detail: agent
      ? 'Your browser refused clipboard access. Select the block below and copy it by hand.'
      : 'Your browser refused clipboard access. The line is ' + c.text + '.',
  }) + (agent
    ? '<pre class="dm-proj-copy-fallback">' + escapeHtml(c.text) + '</pre>'
    : '');
}

function renderProjectsPanel(readonly) {
  // NO `domain` PARAMETER, deliberately, unlike renderHealthPanel beside it.
  // The only correct source of "which domain's projects" is activeProjects(),
  // which re-checks the list's own slug stamp against state.activeSlug — so a
  // domain passed in would be a SECOND answer to that question, free to
  // disagree with the stamp, on a panel that carries a Delete button.
  const p = activeProjects();
  const canWrite = !!(p && p.canWrite) && !readonly;

  let body;
  if (!p || p.loading) {
    // A SHAPE-MATCHED SKELETON, not the word "Loading". The kit's own rule
    // (shell.css's SKELETON ROW block): a placeholder that exists for a few
    // milliseconds communicates nothing and costs two layout jumps, so the
    // section keeps its shape and the shapes themselves say content is
    // coming. Two rows, because that is roughly what a domain has.
    body = '<div class="cur-group-row" aria-hidden="true">' +
        '<span class="cur-skeleton dm-proj-skeleton-name"></span></div>' +
      '<div class="cur-group-row" aria-hidden="true">' +
        '<span class="cur-skeleton dm-proj-skeleton-name"></span></div>';
  } else if (p.error) {
    body = '<div class="cur-group-row"><div class="cur-group-label">' +
      '<b>Could not read this domain’s projects</b><span>' + escapeHtml(p.error) + '</span></div></div>';
  } else if (!p.rows.length) {
    body = '<div class="cur-group-row"><div class="cur-group-label">' +
      '<b>No projects yet</b><span>A project is a thing you build inside this domain. Agents keep their ' +
      'working notes per project, so the next session starts knowing what the last one settled.</span>' +
      '</div></div>';
  } else {
    // The INDEX goes through so each row's two ⓘ folds get a DOM id nothing
    // else can collide with — see projInfoId.
    body = p.rows.map((r, i) => renderProjectRow(r, canWrite, i)).join('');
  }

  const truncated = p && p.truncated
    ? '<div class="cur-group-row"><div class="cur-group-label"><span>Showing the newest ' +
      p.rows.length + '. Older projects are on disk and still readable by your agents.</span></div></div>'
    : '';

  const copied = renderCopyOutcome();

  // ── THE CREATE CONTROL IS THE GROUP'S FOOTER ROW ────────────────────────
  // It shipped in v3.48.0 as a `.btn` in a `<div>` BELOW the card, and the
  // maintainer's report of it is the whole reason this exists: "just thrown
  // somewhere", floating under the group, outside any container. A grouped
  // list's create action is the LAST ROW OF THE LIST — that is what macOS's
  // own inset lists do, and it is what makes the section read as ONE object
  // (rows, then the action on them) rather than a card with an orphan button
  // near it.
  //
  // A <button> that IS a `.cur-group-row`, not a button inside one: the row
  // is the affordance, so the whole 40px band is clickable and the kit's own
  // separator (`.cur-group-row + .cur-group-row::before`) draws above it with
  // no special case. Everything else about it — the hover, the pressed
  // state, the `cursor: default` this app's chrome uses — is in domains.css.
  //
  // AND THE FORM OPENS IN ITS PLACE. A create form that appeared below the
  // card would re-create the same orphan, one step further down, so the
  // footer row is REPLACED by the form inline within the group: the control
  // and the thing it opens occupy one slot. Rename and delete are opened
  // from a ROW's own controls and keep their card below the group, which is
  // where the row they act on can still be seen.
  const lifecycle = renderProjectLifecycleCard();
  // ── PHASE 2 OCCUPIES THE SAME SLOT (v3.61.0, P1-10) ────────────────────
  // `created` is the create form's OUTCOME, and it belongs exactly where the
  // form was: the whole argument above is that this card's home is the
  // group's footer row, and letting the outcome fall through to the
  // below-the-group slot would re-create the orphan v3.48.1 paid to fix — one
  // step later in the flow, where it is if anything more visible.
  const createOpen = !!(state.projectLc
    && (state.projectLc.mode === 'create' || state.projectLc.mode === 'created'));
  const footer = createOpen
    ? '<div class="cur-group-row cur-group-row-stack dm-proj-form-row">' + lifecycle + '</div>'
    : (canWrite
      ? '<button type="button" class="cur-group-row dm-proj-footer" id="dm-proj-new-btn">' +
          '<span class="dm-proj-footer-icon" aria-hidden="true">' + icon('plus', 14) + '</span>' +
          '<span class="dm-proj-footer-label">New project</span>' +
        '</button>'
      : '');

  // TWO LABELLED PARAGRAPHS — what a project is, and what the two copy
  // buttons are for. The text is a module const (PROJECTS_INFO_HTML) rather
  // than inline, which reverses the earlier note here, and for a reason the
  // earlier note could not have: the FILE NAMES in the second paragraph are
  // cross-checked against shared/agent-instructions.js and docs/, so the
  // suite has to be able to lift the string on its own.
  const info = infoMark('dm-proj-info', 'About projects', PROJECTS_INFO_HTML, { html: true });

  return (
    // A SECTION, and a `.dm-section`, like the three around it. The reported
    // defect was that Projects "sits glued to Wiki health with no spacing":
    // it carried `margin-top: 22px` of its own and the health card carried no
    // margin at all, so the gap above it and the gap below it were 22px and
    // 0px. Every gap on this card is now ONE rule (`.dm-section +
    // .dm-section`), which is why they cannot disagree again.
    '<section class="dm-section dm-projects">' +
      // ── THE EYEBROW, THE MARK, AND NOTHING BETWEEN THEM AND THE LIST ────
      // v3.50.0 cut a four-line paragraph here down to one sentence under
      // the eyebrow: "A domain is one compounding wiki; a project is a thing
      // you build inside it." The maintainer's verdict on the survivor is
      // that it still reads as a loose sentence dropped between the heading
      // and the table — which is the SAME complaint, one size smaller, and
      // the reason v3.22.0 records for renderViewHeader having no parameter
      // that puts prose under a title: THE CONTAINER WAS THE PROBLEM, NOT
      // THE WORDING.
      //
      // So the lede goes and the ⓘ carries the definition. That is what the
      // mark is for — it is the dive-in, it ships closed, and the first words
      // inside it are still "A domain is one compounding wiki", so nothing a
      // reader needed has been deleted, only moved behind the control that
      // exists to hold it. The eyebrow stays: a group that does not name
      // itself is worse than one with a sentence too many.
      '<div class="dm-proj-head">' +
        '<div class="dm-section-head-row">' +
          '<div class="dm-section-hd">' +
            '<span class="dm-section-num" aria-hidden="true">3</span>' +
            '<div class="cur-group-title dm-section-eyebrow">Projects in this domain</div>' +
          '</div>' +
          info.btn +
        '</div>' +
        info.panel +
      '</div>' +
      copied +
      '<div class="cur-group">' + body + truncated + footer + '</div>' +
      (readonly
        ? renderDescription('This is a read-only Shared Brain mirror, so projects here cannot be created, '
          + 'renamed or deleted. Work in your own contributing domain instead.')
        : '') +
      ((p && !p.canWrite && !readonly)
        ? renderDescription('This server can list projects but not change them. Update The Curator to '
          + 'create, rename or delete a project from here.')
        : '') +
      // Rendered ONCE, in one of two places — never both, or the form's ids
      // (`#dm-proj-name`, `#dm-proj-submit`) would exist twice and
      // getElementById would wire the listeners to whichever came first.
      (createOpen ? '' : lifecycle) +
    '</section>'
  );
}

/**
 * Create / rename / delete / brief, in the SAME card shape as the domain
 * lifecycle above it — deliberately, not incidentally. Two forms doing the
 * same job in two visual languages on one screen is how a user learns that
 * one of them is more dangerous than it is.
 *
 * DELETE TAKES A TYPED CONFIRMATION and domain delete does not, and that
 * asymmetry is the point rather than an inconsistency: deleting a domain
 * quotes a page count the user can weigh, while a project's handoffs and
 * journals have no equivalent number — they are the notes nobody wrote down
 * anywhere else. The route enforces the same typed confirmation, so this is
 * not the only thing standing between a click and the loss.
 */
function renderProjectLifecycleCard() {
  const f = state.projectLc;
  if (!f) return '';
  const busy = !!f.busy;

  const messages =
    (f.refusal
      ? '<div class="dm-lc-refusal">' + icon('alertCircle', 14) +
        '<span><strong>Not done — the server refused this.</strong> ' + escapeHtml(f.refusal) + '</span></div>'
      : '') +
    (f.error ? '<div class="dm-lc-error">' + icon('alertCircle', 14) + '<span>' + escapeHtml(f.error) + '</span></div>' : '');

  if (f.mode === 'delete') {
    return (
      '<div class="dm-lc-card dm-lc-danger">' +
        '<div class="dm-lc-title">Delete project “' + escapeHtml(f.project) + '”?</div>' +
        '<div class="dm-lc-body">This removes its standing brief, every Handoff under it, and ' +
          'every journal line — the notes your agents left for each other. Those are often the only record ' +
          'of decisions nobody wrote down anywhere else. The wiki in this domain is NOT touched. ' +
          escapeHtml(GIT_UNDO_WARN) +
        '</div>' +
        '<label class="dm-lc-label" for="dm-proj-confirm">Type <span class="mono">' + escapeHtml(f.project) +
          '</span> to confirm</label>' +
        '<input class="dm-lc-input mono" id="dm-proj-confirm" type="text" autocomplete="off" value="' +
          escapeHtml(f.confirmText || '') + '"' + (busy ? ' disabled' : '') + ' />' +
        messages +
        '<div class="dm-lc-actions">' +
          '<button class="btn btn-danger-solid" id="dm-proj-submit"' +
            (busy || f.confirmText !== f.project ? ' disabled' : '') + '>' +
            (busy ? 'Deleting…' : 'Delete permanently') + '</button>' +
          '<button class="btn btn-ghost" id="dm-proj-cancel"' + (busy ? ' disabled' : '') + '>Cancel</button>' +
        '</div>' +
      '</div>'
    );
  }

  if (f.mode === 'rename') {
    return (
      '<div class="dm-lc-card">' +
        '<div class="dm-lc-title">Rename project “' + escapeHtml(f.project) + '”</div>' +
        '<div class="dm-lc-body">The folder moves with the name, and everything in it comes along. ' +
          'Anything that names the old project — a <span class="mono">.curator-project</span> marker in a ' +
          'repository, or a saved prompt — has to be updated by hand.</div>' +
        '<label class="dm-lc-label" for="dm-proj-name">New name</label>' +
        '<input class="dm-lc-input mono" id="dm-proj-name" type="text" value="' + escapeHtml(f.name) + '"' +
          (busy ? ' disabled' : '') + ' />' +
        messages +
        '<div class="dm-lc-actions">' +
          '<button class="btn btn-primary" id="dm-proj-submit"' + (busy ? ' disabled' : '') + '>' +
            (busy ? 'Renaming…' : 'Rename') + '</button>' +
          '<button class="btn btn-ghost" id="dm-proj-cancel"' + (busy ? ' disabled' : '') + '>Cancel</button>' +
        '</div>' +
      '</div>'
    );
  }

  if (f.mode === 'created') return renderProjectCreated(f);

  // ── ONE LEDE, AT MOST THIRTEEN WORDS, AND THE REST BEHIND THE ⓘ (P2-2) ──
  // It was three sentences between the title and the first field: where the
  // folder goes, which characters are legal, and how the brief's save
  // semantics work. Two of those are MECHANISM and one is a CONDITION, and the
  // design system's §3 rule splits them — an eyebrow names the block, a lede
  // is optional and carries an instruction or a condition the reader needs
  // BEFORE acting, and a definition or a mechanism goes behind the mark.
  // "Saving replaces the whole document" is deliberately NOT moved: it
  // qualifies the control it sits above, which is the one place it earns its
  // line (the same refusal `renderBriefEditor` records).
  const cardInfo = infoMark('dm-proj-new-info', 'About creating a project',
    CREATE_INFO_HTML, { html: true });
  return (
    '<div class="dm-lc-card">' +
      '<div class="dm-lc-title dm-proj-new-head">' +
        '<span>New project</span>' + cardInfo.btn +
      '</div>' +
      renderDescription('Use a lowercase name. The brief and the documents can wait.') +
      cardInfo.panel +
      '<label class="dm-lc-label" for="dm-proj-name">Name</label>' +
      '<input class="dm-lc-input mono" id="dm-proj-name" type="text" placeholder="e.g. lumina" value="' +
        escapeHtml(f.name) + '"' + (busy ? ' disabled' : '') + ' />' +
      '<label class="dm-lc-label" for="dm-proj-brief">Standing brief <span class="dm-lc-optional">' +
        '(optional — you can write it later)</span></label>' +
      '<textarea class="dm-lc-textarea mono" id="dm-proj-brief" rows="14"' + (busy ? ' disabled' : '') + '>' +
        escapeHtml(f.brief || '') + '</textarea>' +
      // ── WHERE THE PROJECT'S CANONICAL DOCUMENTS COME FROM (v3.61.0) ─────
      //
      // BELOW THE BRIEF, and the order is the argument: the brief is what YOU
      // tell an agent, the foundations are what the PROJECT tells it. Reading
      // top to bottom is then the same order a session start reads in, which
      // is the order the Project context page already puts its blocks in.
      //
      // The sentence above the chooser is an INSTRUCTION at eight visible
      // words. What a canonical document IS, that the answer cannot be
      // changed afterwards, and that a plain folder with no version control in
      // it works perfectly well as a mirror source are all DEFINITION or
      // MECHANISM, so they are behind the ⓘ beside it — the design system's
      // §3 rule, and the reason this label carries a mark rather than a
      // second paragraph.
      foundationsField(f, busy) +
      messages +
      // ── WHAT THE PRIMARY WILL WRITE, IN ONE LINE (P2-5) ─────────────────
      // Derived from the chosen arm, ABOVE the action row, rather than folded
      // into the button's own label. A label that changes width as the form is
      // answered moves the control the person is aiming at — and a consequence
      // is a reading, not a name.
      '<div class="tx-note">' + icon('alertCircle', 13) + '<span>' +
        escapeHtml(createConsequence(f)) + '</span></div>' +
      '<div class="dm-lc-actions">' +
        '<button class="btn btn-primary" id="dm-proj-submit"' + (busy ? ' disabled' : '') + '>' +
          (busy ? 'Creating…' : 'Create project') + '</button>' +
        '<button class="btn btn-ghost" id="dm-proj-cancel"' + (busy ? ' disabled' : '') + '>Cancel</button>' +
      '</div>' +
    '</div>'
  );
}

/**
 * PHASE 2 — THE OUTCOME, IN THE SLOT THE FORM WAS IN.
 *
 * ── WHY IT IS NOT A BANNER, AND WHY THE OTHER TWO ACTIONS STILL ARE ─────
 * Rename and delete produce a FACT and nothing to do about it, which is what a
 * view-level banner is for. A create produces a fact AND two pieces of work
 * that happen somewhere else: a marker line to save in a repository, and an
 * instructions block to paste into the file the harness loads. Those controls
 * belong beside the outcome, and a banner cannot hold controls.
 *
 * ── NO PRIMARY, DELIBERATELY ────────────────────────────────────────────
 * Nothing on this panel commits anything: two copies, one navigation, one
 * dismissal. Inventing a primary would be the tier-1 slot used dishonestly —
 * the taxonomy's rule is that the primary is *the one action that completes
 * the step in front of the user*, and the step is complete.
 *
 * ── THE TWO COPY CONTROLS ARE THE ROW'S OWN ─────────────────────────────
 * Same `data-proj-marker` / `data-proj-agent` hooks the project rows carry, so
 * `bindProjectListeners` binds them with no new handler, `copyForProject`
 * composes with no new text, and the two ⓘ panels are the same two constants.
 * A second implementation of "copy the marker line" is exactly the
 * template-per-surface defect this release keeps refusing.
 *
 * ── AND A TIER-0 FAILURE IS A SECOND FACT, NOT A SUFFIX ─────────────────
 * The route answers `ok: true` with `foundationsError` when the project and
 * its brief were written and the documents were not. Two facts, so two boxes:
 * a success and an attention, both unfolded (v3.16.1).
 */
function renderProjectCreated(f) {
  const name = String(f.project == null ? '' : f.project);
  const markerInfo = infoMark('dm-proj-done-marker-info',
    'About Copy marker line', MARKER_INFO_TEXT);
  const agentInfo = infoMark('dm-proj-done-agent-info',
    'About Copy agent instructions', AGENT_INFO_TEXT);
  const outcome = renderStatus({
    state: 'success',
    title: 'Created ' + name,
    detail: f.outcomeDetail || 'The project and its brief are saved.',
  });
  const refused = f.outcomeRefusal
    ? renderStatus({
      state: 'attention',
      title: 'No documents were set up',
      detail: f.outcomeRefusal,
    })
    : '';
  // Rendered through the SAME component the Agent-memory block uses, so a
  // refusal reads identically wherever it lands, and unfolded, beside the
  // outcome: the path the person typed and the store's own reason for not
  // copying it belong next to the count that does not include it.
  const notCopied = renderRefusedList(f.outcomeRefused);
  return (
    '<div class="dm-lc-card">' +
      outcome +
      refused +
      notCopied +
      '<div class="dm-lc-title">Connect your agent</div>' +
      renderDescription('Paste these two where your agent works — the project’s folder, once.') +
      '<div class="dm-lc-actions dm-proj-done-copies">' +
        '<button class="btn btn-ghost dm-proj-btn" data-proj-marker="' + escapeHtml(name) + '">' +
          'Copy marker line</button>' +
        markerInfo.btn +
        '<button class="btn btn-ghost dm-proj-btn" data-proj-agent="' + escapeHtml(name) + '">' +
          'Copy agent instructions</button>' +
        agentInfo.btn +
      '</div>' +
      markerInfo.panel +
      agentInfo.panel +
      '<div class="dm-lc-actions">' +
        '<button class="btn btn-secondary btn-xs" id="dm-proj-open-memory">' +
          'Open in Project context</button>' +
        '<button class="btn btn-ghost btn-xs" id="dm-proj-cancel">Done</button>' +
      '</div>' +
    '</div>'
  );
}

// ── WHAT THE CREATE CARD'S ⓘ CARRIES (P2-2) ──────────────────────────────
//
// A module constant for the same reason `PROJECTS_INFO_HTML` is one: the suite
// lifts it and asserts the words a user reads, and a copy typed in a test
// would assert a copy. Every character is written here, so nothing user-,
// provider- or store-supplied is interpolated into the `{html: true}`
// fragment — which is also why the FOLDER PATH is not in it: that would need
// the domain slug, and a mark whose contents vary is a mark the suite cannot
// pin. The path is said by the field's own placeholder and by the row that
// appears afterwards.
const CREATE_INFO_HTML =
  '<p><strong>Where it goes.</strong> The name becomes a folder inside this domain’s state ' +
  'folder, so use lowercase letters, digits, dots, hyphens or underscores. Nothing in the wiki ' +
  'moves or changes.</p>' +
  '<p><strong>The standing brief is yours.</strong> Every agent read returns it, and saving ' +
  'replaces the whole document rather than adding to it — so send the complete text each time. ' +
  'It is optional here and can be written later from Project context.</p>' +
  '<p><strong>The documents choice is answered once.</strong> A project is all mirrored from a ' +
  'folder or all kept here, never a mix, and the store refuses a change afterwards. Decide later ' +
  'is a real answer: the Documents block on the Project context page asks again.</p>';

/**
 * WHAT WAS WRITTEN, IN ONE SENTENCE — from the SERVER'S answer (P1-10).
 *
 * ── WHY NOT `chooserOutcomeWords` ───────────────────────────────────────
 * That function composes a BANNER SUFFIX — a ` · `-joined clause list that
 * appends to "Created project “x”" — and phase 2's box already carries the
 * name in its title, so the suffix would render as a headless fragment
 * ("· 4 skeletons seeded"). Same source, different shape.
 *
 * ── AND WHY NOT THE REQUEST ─────────────────────────────────────────────
 * A create that asked for four skeletons and got three is a fact the owner
 * needs. Everything here is read off `body`; the only thing taken from this
 * side is the import count, because each import is a SEPARATE PUT this view
 * made itself and the create response cannot know about them.
 *
 * ── THE SENTENCE NAMES THE OWNER FIRST (P1-12) ──────────────────────────
 * "Fill them here, or ask an agent to" — a person can start a project with no
 * agent and no repository, so the arm that presumes one is the second one.
 */
function createdOutcomeDetail(body, imported) {
  const b = body && typeof body === 'object' ? body : {};
  const said = [];
  const seeded = Array.isArray(b.seeded) ? b.seeded.length : 0;
  if (seeded) {
    said.push(seeded + ' skeleton document' + (seeded === 1 ? '' : 's')
      + ' seeded. Fill them here, or ask an agent to.');
  }
  const ref = b.refresh && typeof b.refresh === 'object' ? b.refresh : null;
  const copied = ref
    ? (Array.isArray(ref.added) ? ref.added.length : 0)
      + (Array.isArray(ref.refreshed) ? ref.refreshed.length : 0)
    : 0;
  if (copied) {
    said.push(copied + ' document' + (copied === 1 ? '' : 's')
      + ' copied from that folder, byte for byte.');
  }
  const got = Array.isArray(imported) ? imported.length : 0;
  if (got) said.push(got + ' file' + (got === 1 ? '' : 's') + ' you chose was saved.');
  if (!said.length) return 'The project and its brief are saved.';
  return said.join(' ');
}

/**
 * THE CONSEQUENCE OF PRESSING CREATE, IN ONE LINE (P2-5).
 *
 * Read off the chosen arm, and it counts what the request will ASK FOR — the
 * skeletons, the ticked files, the imports — never what came back, because
 * nothing has come back yet. What came BACK is `chooserOutcomeWords`, which
 * reads the server's answer, and the two are deliberately different functions:
 * a sentence built from the request and printed as an outcome is how a create
 * that asked for four and got three reports four.
 *
 * Pure over the form record, so the suite drives it rather than scanning for
 * it.
 */
function createConsequence(f) {
  const c = f && f.foundations;
  if (!c || c.ownership === 'later') return 'Creates the project. You can add documents any time.';
  if (c.ownership === 'curator') {
    const imports = Array.isArray(c.imports) ? c.imports.filter((i) => i && !i.error).length : 0;
    const seeds = c.seed === false ? 0 : SKELETON_SLUGS.length;
    if (!seeds && !imports) return 'Creates the project with no documents yet.';
    const parts = [];
    if (seeds) parts.push('writes ' + seeds + ' skeleton document' + (seeds === 1 ? '' : 's'));
    if (imports) parts.push('saves ' + imports + ' file' + (imports === 1 ? '' : 's') + ' you chose');
    return 'Creates the project and ' + parts.join(' and ') + '.';
  }
  const files = pickedFiles(c).length;
  if (!files) return 'Creates the project. Nothing is copied until you choose files.';
  return 'Creates the project and copies ' + files + ' document' + (files === 1 ? '' : 's')
    + ' from that folder.';
}

// ── THE THREE-LAYER LEGEND (v3.62.0, P1-14) ──────────────────────
//
// ONE PLACE TEACHES THE SET; three places teach the members. The five figures
// this mark sits beside ARE the model in miniature — four that count the wiki
// and one that counts PROJECTS — so a reader wondering what KIND of thing each
// figure counts has the question in front of them here and nowhere else in the
// app. The Project-context view teaches the three verbs one at a time, in the
// ⓘ of the step that carries each; a second copy of the legend there would be
// two hand-maintained descriptions of one thing, which is the rule
// views/memory.js records for why its own header mark exists at all.
//
// AND IT CLOSES A NAMED GAP. v3.58.0's heading-and-ⓘ audit recorded three
// blocks on this view with nothing to explain themselves — OVERVIEW, PAGES ·
// THE WIKI and WIKI HEALTH. This is the first of the three, and the one worth
// having first: the other two describe a list and a report, while this one
// describes the app's data model.
//
// A FUNCTION, NOT A MODULE CONSTANT, and that is deliberate: `docsUrl()`
// THROWS on a key that is not in the map, so composing this at module scope
// would turn a mistyped key into a blank shell for every user rather than a
// broken panel on one screen. Same shape views/memory.js uses for its five.
//
// WHAT IS NOT IN IT, and why:
//   · No diagram. `.tx-vh-panel` is a one-column grid and CSS wraps every
//     contiguous text run in an anonymous grid item, so an inline SVG becomes
//     a row of its own and the prose breaks around it. The diagram exists and
//     belongs in the guide (docs/images/curator-context-model.svg).
//   · No control. The delegated listener toggles on the BUTTON, so anything
//     focusable inside the fold is unreachable until the fold is open.
//   · No warning, no cost, no irreversibility (v3.16.1). This is a
//     DEFINITION, which is exactly what an ⓘ is for and exactly what a lede
//     is not (docs/design-system-source.md §3).
//
// ONE NOUN PER LAYER, AND NO MISMATCH LEFT (v3.65.1, decision 1). Through
// v3.65.0 this panel said "canonical documents" for a block called
// FOUNDATIONS, "working state" for the step now called MEMORY, and "wiki" for
// the layer the Project-context view's third step calls Knowledge — three
// places where the app used two words for one thing. The UI vocabulary is now
// Documents · Memory · Handoffs · Journal · Domain, and this panel uses it;
// the store's own names (`foundations/`, `scope`, `journal.jsonl`) do NOT
// move, because they are the public on-disk spec.
//
// The three nouns here are now EXACTLY the Project-context view's three step
// titles — Documents · Memory · Knowledge — which is the point: the panel that
// explains the three layers and the page that shows them say the same three
// words. "wiki" standing in for a layer (or for a domain) is what decision 1
// removes; the word survives in the app where it means the artefact, as in
// "a domain is one compounding wiki".
//
// Every character is written HERE, so nothing user-, provider- or
// store-supplied is interpolated into the `{html: true}` fragment.
function threeLayersInfoHtml() {
  return '<p><strong>One domain, three kinds of context.</strong> The four figures on the left '
    + 'count this domain\u2019s <strong>knowledge</strong> — the pages ingest and chat write. '
    + 'It <strong>accumulates</strong>: a new source makes an existing page richer rather than '
    + 'adding a second copy.</p>'
    + '<p><strong>Projects</strong> counts the other two. A project\u2019s '
    + '<strong>memory</strong> — its standing brief, its handoffs, its journal — '
    + '<strong>supersedes</strong>: every save replaces the last, so a problem you solved cannot '
    + 'come back. A project\u2019s <strong>documents</strong> — its architecture, '
    + 'decisions, conventions, roadmap — are <strong>replaced whole and read verbatim</strong>, '
    + 'so an agent gets the document rather than a paraphrase.</p>'
    + '<p>All three live in this one folder, sync together, and open to your agents in one '
    + 'call.</p>'
    + '<p>' + docsLinkHtml('domains.three-layers', 'Read more in the guide') + '</p>';
}

// ── THE ⓘ BESIDE THE DOCUMENTS FIELD ─────────────────────────────────────
//
// A module constant for the same reason PROJECTS_INFO_HTML is one: the suite
// lifts it and asserts the words a user reads, and a copy typed in the test
// would assert a copy. Every character of it is written here, so nothing user-,
// provider- or store-supplied is interpolated into the `{html: true}` fragment.
//
// WHAT IT CARRIES, and why none of it is a lede: the DEFINITION of a canonical
// document, the MECHANISM of a mirror (a byte copy, a recorded commit, a
// checksum compared on every read), the fact that a plain folder with no
// version control works as a source — which is the answer to "will this work
// on my project?" and therefore a mechanism question — and the COST, that the
// answer is set once and the store refuses a mix afterwards.
const FOUNDATIONS_INFO_HTML =
  '<p><strong>What these are.</strong> The documents an agent must not act without — the ' +
  'architecture, the decisions, the conventions, the roadmap. The Curator keeps them VERBATIM, ' +
  'not as a summary, so an agent reads what you would read, and they travel with the project ' +
  'the way the standing brief does.</p>' +
  '<p><strong>Mirrored from a folder.</strong> A byte-for-byte copy of files in a folder on ' +
  'this computer, with a checksum compared every time the project is read — which is how the app ' +
  'can tell you a copy has gone out of date. Any folder works; it does NOT have to be a git ' +
  'checkout, and when it is one, the commit each file came from is additionally recorded and ' +
  'shown beside the path.</p>' +
  '<p><strong>Kept by The Curator.</strong> The documents live only here. Setting this up seeds ' +
  'four SKELETONS — documents that carry prompts instead of prose, which an agent is told to ' +
  'answer rather than to believe. You fill one in on the Project context page, or ask an agent to; ' +
  'and you can start from files on this computer instead, or as well. Nothing is uploaded: a ' +
  'file you choose is read in this browser and shown to you before it is saved.</p>' +
  '<p><strong>It is answered once.</strong> A project is all mirrored or all kept here, never a ' +
  'mix, and the store refuses a change afterwards. Decide later is a real answer — and the ' +
  'default one — because the Documents block on the Project context page asks again.</p>';

/**
 * THE DOCUMENTS FIELD ON THE CREATE FORM — a label, a mark, and the chooser.
 *
 * Pure apart from the form record, and lifted by the suite rather than scanned:
 * the assertions that matter here are that the choice reaches the request body
 * and that the ⓘ carries the definition, and a scan of source cannot tell the
 * difference between a mark that opens something and a mark that opens nothing.
 */
function foundationsField(f, busy) {
  const choice = f.foundations;
  if (!choice) return '';
  const info = infoMark('dm-proj-fnd-info', 'About Documents',
    FOUNDATIONS_INFO_HTML, { html: true });
  return (
    '<div class="dm-lc-label dm-proj-fnd-head">' +
      '<span>Documents</span>' + info.btn +
    '</div>' +
    info.panel +
    // ── THE FIELD'S OWN STACK, SO THE RHYTHM IS ONE RULE (v3.61.1) ────────
    // The same 0px gaps the Agent-memory host had, from the same cause: a
    // `<p>` in a form body carries no bottom margin and a `.tx-note` carries
    // no bottom margin either, so the description touched the note and the
    // note touched the option cards. One flex column with one gap, for the
    // reason design-system §2 gives the Settings block — and a wrapper class
    // rather than `.tx-note + .fnd-init`, because shared/text.css owns the
    // `tx-` prefix outright and this stylesheet may not declare a rule on one.
    '<div class="dm-proj-fnd-stack">' +
    renderDescription('Where this project keeps the documents agents read first.') +
    // IRREVERSIBILITY NEVER FOLDS. The same sentence the Agent-memory chooser
    // carries above itself, in the same treatment and for the same reason: the
    // store refuses a mismatch on every later write, and a cost that lives
    // only inside the mark is a cost the person who did not open the mark was
    // never told. The MECHANISM stays behind it; this is the one clause that
    // has to be read before pressing.
    '<div class="tx-note">' + icon('alertCircle', 13) + '<span>' +
      escapeHtml('Set once — a project is mirrored or kept here, never both.') +
      '</span></div>' +
    renderFoundationsChooser({ id: 'dm-proj-fnd', choice, busy: !!busy }) +
    '</div>'
  );
}

/**
 * How many projects this domain holds — the fifth overview figure.
 *
 * TAKEN FROM THE LIST THAT IS ALREADY ON SCREEN, never from a second fetch.
 * The Projects section below renders `activeProjects()`, so deriving the count
 * from anything else would put two answers to one question on one card, free
 * to disagree — which is the shape this view has already paid for twice
 * (`activeBrowse`/`activeProjects` both exist precisely to stop a list
 * rendering under the wrong domain).
 *
 * `total` IS THE STORE'S COUNT, taken before its own cap, and `rows.length`
 * would report a CAP as a measurement on a domain with more than
 * MAX_PROJECTS_PER_DOMAIN projects — the same mistake `distinctScopeCount`
 * exists to stop one layer down.
 *
 * A FACT AND ITS ABSENCE STAY APART. While the list is loading, or if it
 * failed, this returns `null` and the card renders an em dash — never `0`,
 * which is a real and different answer ("this domain has no projects").
 */
function projectCount() {
  const p = activeProjects();
  if (!p || p.loading || p.error) return null;
  if (typeof p.total === 'number' && Number.isFinite(p.total)) return p.total;
  return Array.isArray(p.rows) ? p.rows.length : null;
}

/**
 * The OVERVIEW section: the domain's figures, in ONE card.
 *
 * ── THE REPORTED DEFECT ──────────────────────────────────────
 * "The top number cards float without a card." They did: four bordered tiles
 * sat directly on the view background with no group around them and no
 * eyebrow naming what they were, so the first thing on the domain card was
 * an unlabelled row of numbers. Every OTHER section on this screen is a
 * captioned group; this one was the exception, which is what made it read as
 * loose furniture rather than as the domain's summary.
 *
 * Now it is the kit's inset grouped list (`.cur-group`, the same chrome
 * Projects and — since this release — Pages and Wiki health carry), under
 * its own eyebrow, and the tiles inside it lose their individual borders and
 * shadows: a card inside a card is two objects where the design has one.
 *
 * THE FIFTH FIGURE IS PROJECTS, and it was missing. A project is one of the
 * two things a domain HOLDS — pages and projects — and the section for it
 * was on the card while the count for it was nowhere.
 *
 * ── A FIGURE IS A SHORTCUT TO THE THING IT COUNTS ──────────────────────────
 * Reported by a user reviewing the app on video: he wanted to press ENTITIES
 * and get the list of entities, and said he had not noticed the filter chips
 * under PAGES · THE WIKI "for a long time". The three chips were doing the
 * job; the number above them was where he looked for it.
 *
 * So the four figures that have a matching chip become controls over the chip
 * row — PAGES → All, and the three type figures → their own facet — and
 * PROJECTS, which has no chip, scrolls to the Projects section instead. The
 * chips stay exactly as they were.
 *
 * ONE SOURCE OF TRUTH, AND IT IS THE FILTER STATE. `state.browse.folder`
 * decides both the chip's `.active` and the tile's `aria-pressed`; the tile
 * writes that field and re-renders, which is precisely what the chip already
 * does. A tile that kept its own "selected" flag would be a second state free
 * to disagree with the list under it — the shape `activeBrowse()` and
 * `activeProjects()` both exist to prevent one layer down.
 *
 * A TILE IS A CONTROL ONLY WHILE THERE IS A LIST FOR IT TO ACT ON. With the
 * page list still loading, or failed, the four facet tiles render as the
 * plain `<div>`s they have always been: a button whose only possible outcome
 * is nothing is worse than no button, and the geometry is identical either
 * way (same class, same padding, same grid track), so nothing moves when the
 * list lands. PROJECTS is always a button — it only scrolls, and the section
 * it scrolls to renders in every state.
 *
 * NO `title=`. The tile's accessible name carries the count and what pressing
 * it does, on a real focusable control — views/domains.js's `title=` ceiling
 * in scripts/test-next-title-affordances.js is 0 and stays 0.
 *
 * ── AND SINCE v3.64.2 IT BUILDS DESCRIPTIONS, NOT MARKUP ──────────────────
 * Every decision above is still taken here — which figures exist, which are
 * controls, what each one's accessible name says, when PROJECTS is an em dash
 * rather than a zero, whether the two jump tiles exist at all. What left is
 * the HTML: `renderOverview` emits it, and the Project-context view's three
 * readings go through the same function, so the two screens can no longer
 * drift into two designs for one idea. The maintainer's question was exactly
 * that: "how are these the same?"
 */
function renderStatCards(counts, pages, projects, jumps) {
  const otherCount = counts.other || 0;
  const b = activeBrowse();
  const live = !!(b && !b.loading && !b.error);

  const pagesText = pages.toLocaleString();
  const entText = (counts.entities || 0).toLocaleString();
  const conText = (counts.concepts || 0).toLocaleString();
  const sumText = (counts.summaries || 0).toLocaleString();
  const projText = projects === null || projects === undefined ? '\u2014' : projects.toLocaleString();

  // A figure that SELECTS a chip — but ONLY while there is a list for it to
  // act on. `aria-pressed` is read straight off the filter state, never off a
  // local flag. With the list still loading, or failed, the tile is the plain
  // reading it has always been in that state; the kit renders the identical
  // geometry either way, so nothing moves when the list lands.
  const facet = (label, value, toneClass, key, name) => (live
    ? { label, value, toneClass, facet: key, active: b.folder === key, name }
    : { label, value, toneClass });

  const cards = [
    // PAGES is the RESET, not a narrowing, so its name says so rather than
    // reading "Pages, 3,445 pages — filter the list".
    facet('PAGES', pagesText, '', 'all',
      'Pages, ' + pagesText + ' \u2014 show every page in the list'),
    facet('ENTITIES', entText, 'dm-stat-entity', 'entities',
      'Entities, ' + entText + ' pages \u2014 filter the list'),
    facet('CONCEPTS', conText, 'dm-stat-concept', 'concepts',
      'Concepts, ' + conText + ' pages \u2014 filter the list'),
    facet('SUMMARIES', sumText, 'dm-stat-summary', 'summaries',
      'Summaries, ' + sumText + ' pages \u2014 filter the list'),
    // An em dash, not a zero. See projectCount(). PROJECTS is always a
    // control — it only scrolls, and the section it scrolls to renders in
    // every state.
    { label: 'PROJECTS', value: projText, toneClass: 'dm-stat-project', jump: 'projects',
      name: 'Projects, ' + projText + ' \u2014 go to the projects list' },
  ];
  // MEDIUM-2 fix: shown only when non-zero, so the common case (every page
  // fits entities/concepts/summaries) renders identically to before — but
  // when `other` IS non-zero it is never just dropped: a sixth figure, same
  // shape as the other five, not a footnote. It is NOT a control: there is no
  // "Other" chip, and `all` deliberately does not equal it either.
  if (otherCount > 0) {
    cards.push({ label: 'OTHER', value: otherCount.toLocaleString(), toneClass: 'dm-stat-other' });
  }
  // ── THE TWO JUMPS ARE TILES NOW, NOT A SECOND ROW (v3.65.0) ───────────
  // They were `jumps[]`, a row of their own inside the same card, and they
  // MEASURED as a different object: 92.8 x 46.4 at x=401 beside a 181.8 x
  // 78.9 stat tile at x=385 — a different size, a different height and a
  // 16px indent, inside one card. The maintainer's words were exactly that:
  // *"SOURCES 14 days ago — I don't understand why it is here and why it is
  // an entirely different design than the five on top"*. So the option is
  // gone from the component and a jump is an ordinary card with `jump:` set.
  //
  // SHARED IS RENDERED AND HIDDEN, NEVER OMITTED — the same contract it had
  // in the jump row, and for the same reason: the answer arrives from the
  // Shared Brain panel AFTER this paint, and a re-render to reveal it would
  // remount the panel, which would report again — a loop. `hidden` is one
  // attribute write with no repaint. See sharedJumpReading() and
  // onSharedLensChange().
  //
  // A `shared-*` mirror gets NEITHER: the caller passes `sources: false`,
  // because a mirror gets no Ingest section and a tile that scrolls to
  // nothing is the control-with-no-outcome this card already refuses to draw
  // for a facet with no list.
  if (jumps && jumps.sources) {
    cards.push({ label: 'SOURCES', jump: 'sources',
      value: jumps.lastIngest ? relTime(jumps.lastIngest) : 'nothing yet',
      name: 'Sources \u2014 open the Ingest section' });
    cards.push({ label: 'SHARED', jump: 'shared',
      value: (jumps.shared && jumps.shared.value) || '\u2014',
      hidden: !(jumps.shared && jumps.shared.show),
      name: 'Shared Brain \u2014 open the Shared Brain section' });
  }

  return renderOverview({
    id: 'dm-overview-info',
    eyebrow: 'OVERVIEW',
    // THE SECTION CLASSES STAY THIS VIEW'S. `.dm-overview` is a top-level
    // child of the column and is what `bindStatCardListeners` scopes itself
    // to and what `patchMainAroundHosts` replaces whole or not at all.
    sectionClass: 'dm-section dm-overview',
    infoLabel: 'About these figures',
    infoText: threeLayersInfoHtml(),
    infoHtml: true,
    // Every historical `dm-` token, on the same elements. See the kit's own
    // header for why they are aliases rather than names.
    alias: 'dm',
    cards,
    // ── THE TRACK FLOOR, DERIVED FROM THE WIDEST VALUE ─────────────────
    // The problem the floor solves: at the stylesheet's own 110px default,
    // seven equal tracks are 127px and the two PHRASE values wrap to two
    // lines, which makes EVERY tile 110.797px tall instead of 78.898 —
    // visibly worse than what shipped.
    //
    // 175 IS DERIVED, NOT PICKED. Measured in a browser at the shipped 22px
    // rung, the widest value this card can hold is a relative time:
    // `5 minutes ago` 140.5px, `365 days ago` 135.7, `11 hours ago` 131.2,
    // `71 days ago` 121.9, `nothing yet` 111.8, `12 cohorts` 109.0,
    // `1,234,567` 108.5. The tile's padding is 16px a side, so the VALUE box
    // is the track minus 32 and the floor has to be at least 141 + 32 = 173.
    //
    // WHY A FLOOR IS SELF-CORRECTING, which is what makes 175 safe rather
    // than lucky: raising it REDUCES the track count, which WIDENS the
    // track. At a 10px gap, `n` tracks fit when 185n - 10 <= W, so 175 gives
    // 5 tracks at both 949px (track 181.8 — pixel-identical to the five
    // tiles v3.64.2 shipped) and 960px (184.0), 6 at 1144 (182.3), 3 with
    // the onboarding guide docked at 647 (209.0) and 1 at 568. The narrowest
    // track the floor can ever produce is the floor itself, 175, whose value
    // box is 143 — still 2.5px clear of the widest string.
    //
    // THIS CORRECTS THE KIT PACKAGE'S OWN INSTRUCTION, which was to pass 150.
    // That figure was derived against a 949px grid, where 6*150 + 5*10 = 950
    // is one pixel too wide to fit and five tracks survive. This install's
    // grid measures 960px at the same 1370px window — `.main-inner` is 1026
    // here, not 959 — so 950 DOES fit, auto-fit takes six tracks of 151.664,
    // and `71 days ago` (121.9) overflows its 119.7px box. A one-pixel
    // margin is not a floor; the widest value is.
    minTrack: 175,
  });
}

// ── Wiki browse panel ──────────────────────────────────────────────────────
//
// /next had no way to see what is IN a domain — the only route to a page was
// clicking a citation in Chat, so a page nothing had cited was unreachable.
// Shipping's Wiki tab lists every page; this is that capability, inside the
// domain where the design puts it.
//
// Backed by GET /api/wiki/:domain/list (readdir only; no file bodies), which
// returns { entries: [{slug, folder, path, title}], truncated }. The whole
// list is fetched once and filtered IN MEMORY — ~3,300 entries is ~300 KB in
// one call, versus a request per keystroke.
//
// ACCEPTED TRADE-OFF, stated so nobody "fixes" it: `title` is derived from
// the SLUG, not from the page's frontmatter, because a real title needs the
// file body — the 14 MB whole-domain read this endpoint exists to avoid. A
// page whose frontmatter title differs shows a slightly-off label in this
// list and its correct title the instant it is opened.

const BROWSE_FOLDERS = [
  { key: 'all', label: 'All' },
  { key: 'entities', label: 'Entities' },
  { key: 'concepts', label: 'Concepts' },
  { key: 'summaries', label: 'Summaries' },
  // ── THE FOURTH KIND OF MARKDOWN IN A DOMAIN (v3.50.0) ──────────────────
  // A domain's `state/` tree is markdown too — each project's standing brief
  // and each work-stream's handoff — and until now the only route to any of
  // it was the Project context screen, which is organised around RESUMING work
  // rather than around reading. This is the browse route to the same files.
  //
  // ITS COUNT IS ITS OWN, and `all` deliberately does NOT include it: the
  // stat card above says PAGES and means wiki pages, and a facet labelled
  // "All" that disagreed with the number directly above it would be the
  // self-contradicting-figures defect this card has already been fixed for
  // once (MEDIUM-2, the `other` count).
  { key: 'memory', label: 'Memory' },
];
// How many rows are painted at ONE TIME, and the size of each further step.
//
// ── THE DEAD END THIS REPLACES ─────────────────────────────────────────
// The note under the list used to read "Showing the first 150 of 3,421
// matches — narrow the filter to see the rest", and there was no other way
// to see the rest: a user who did not know what to type could not reach page
// 151 of his own wiki at all. The cap is still here, because painting 3,300
// rows costs more than it tells anyone — but it is now a WINDOW that a
// footer row extends, not a wall.
const BROWSE_RENDER_CAP = 150;

// LAYER 2 for the browse list, same shape as activeSemanticScan(): a list
// fetched for domain A must never render under domain B, even if the
// clearing in selectDomain() were ever removed.
function activeBrowse() {
  const b = state.browse;
  if (!b) return null;
  if (b.slug !== state.activeSlug) return null;
  return b;
}

function filterBrowseEntries(entries, filter, folder) {
  const q = (filter || '').trim().toLowerCase();
  const out = [];
  for (const e of entries) {
    if (folder && folder !== 'all' && e.folder !== folder) continue;
    if (q) {
      const hay = (e.slug + ' ' + (e.title || '')).toLowerCase();
      if (!hay.includes(q)) continue;
    }
    out.push(e);
  }
  return out;
}

/**
 * The same text filter, over MEMORY rows.
 *
 * A SECOND FUNCTION, not a `kind` parameter on the one above: the two lists
 * have different shapes (a wiki entry has `slug` and `folder`; a memory entry
 * has `project`, `scope` and `machine`) and the haystacks are therefore
 * different. Folding them together would mean a folder check that is dead for
 * one caller and a field list that is dead for the other.
 *
 * The haystack is everything the row DISPLAYS — its title and its path — so a
 * user who types a machine name, a scope name or a project name finds the row
 * they can see, which is the only rule a filter box can be judged against.
 */
function filterMemoryEntries(entries, filter) {
  const q = (filter || '').trim().toLowerCase();
  if (!q) return entries.slice();
  return entries.filter((e) => ((e.title || '') + ' ' + (e.path || '')).toLowerCase().includes(q));
}

/**
 * WHICH LIST THE FACETS ARE SHOWING, and how much of it.
 *
 * One place answers it, so the row painter, the "Showing N of M" note and the
 * "Show 150 more" footer cannot disagree about the same three numbers — which
 * they would, being three separate expressions over the same state, the moment
 * one of them was edited.
 */
function browseMatches(b) {
  // ── THE LENS (v3.64.0) ─────────────────────────────────────────────────
  // `lens` is the OUTER reading — which KIND of document this list is
  // showing — and `folder` stays the inner one, the wiki type facet. The
  // effective lens is DERIVED rather than merely read, so the two controls
  // over one list cannot contradict each other: pressing the Memory chip
  // (which predates the lens and is still the fine control) puts the list
  // into the context reading, and the lens row above shows Context active
  // for it. That is the same "two affordances, one field" rule the OVERVIEW
  // tiles and the chip row have followed since v3.58.0.
  const lens = (b.lens === 'context' || b.lens === 'all')
    ? b.lens
    : (b.folder === 'memory' ? 'context' : 'wiki');
  if (lens === 'context') {
    return { lens, kind: 'memory', items: filterMemoryEntries(b.memory || [], b.filter) };
  }
  if (lens === 'all') {
    // The wiki half keeps whatever type facet is selected; `memory` is not a
    // type, so under the All lens it means "no type narrowing".
    return {
      lens,
      kind: 'mixed',
      items: filterBrowseEntries(b.entries, b.filter, b.folder === 'memory' ? 'all' : b.folder)
        .concat(filterMemoryEntries(b.memory || [], b.filter)),
    };
  }
  return { lens, kind: 'wiki', items: filterBrowseEntries(b.entries, b.filter, b.folder) };
}

/** How many rows are painted right now. Never below one step, never a NaN. */
function browseWindow(b) {
  const w = Number(b && b.window);
  return Number.isFinite(w) && w >= BROWSE_RENDER_CAP ? w : BROWSE_RENDER_CAP;
}

/**
 * The page list's per-domain signature, for the revalidation compare.
 *
 * A FULL STRUCTURAL SERIALISATION, not a hand-picked digest of "the fields
 * that matter". A digest is a second, silently-drifting statement about which
 * fields the renderer reads, and this repo's recorded failure shape is exactly
 * that: a check that stopped reaching the thing it protects. JSON.stringify
 * cannot miss a field the renderer uses, so a revalidation that returns
 * anything different at all repaints.
 *
 * MEASURED before choosing it, on the real 3,445-entry `articles` payload in
 * the browser (see the release notes for the figure): the cost is a small
 * fraction of one frame, and it is paid ONCE per revalidation in exchange for
 * not rebuilding the entire main column — which is the far larger bill, and
 * the one the user actually sees.
 */
function browseSignature(entries, memory, truncated, memoryTruncated) {
  return JSON.stringify([entries, memory, !!truncated, !!memoryTruncated]);
}

async function loadBrowse(slug, token) {
  // Capture the gate for THIS call. `loadGate` is module-scoped and the
  // next mount replaces it, so settling the module variable from a stale
  // in-flight load would decrement the NEXT mount's counter and hide a
  // loader that is legitimately up. A cancelled gate ignores settle(), so
  // the stale path becomes a no-op instead.
  const gate = loadGate;

  // ── STALE-WHILE-REVALIDATE: is there anything to blank? ────────────────
  //
  // `painted` means a filled, non-errored list for THIS EXACT SLUG is already
  // in `state.browse` — which happens in two ways, and both are the reported
  // defect:
  //
  //   RE-ENTRY   this module's `state` deliberately survives leaving the
  //              view, so returning to Domains finds the list already there.
  //              The old code discarded it and re-fetched the same bytes,
  //              and because that fetch ran AFTER `await loadHealth` it did
  //              so 834 ms in — long after the screen had settled, which is
  //              what made the blink so visible.
  //   A SWITCH   selectDomain has already seeded this slug's cached list, in
  //              the same synchronous task, so the collapsed card never
  //              reaches a frame.
  //
  // When it is painted we take no gate, blank nothing, and render nothing on
  // the way in: the revalidation below is invisible unless it finds a
  // difference. Only a COLD first sight of a domain shows a placeholder, and
  // even that one reserves the outgoing card's height (renderBrowsePanel).
  const painted = !!(state.browse && state.browse.slug === slug &&
                     !state.browse.loading && !state.browse.error);
  // THE GATE IS BEGUN ONLY IF WE BLANKED. `begin()`/`settle()` are counted,
  // so settling a gate we never began decrements somebody else's outstanding
  // load and hides a loader that is legitimately up — the very hazard the
  // captured-gate comment above exists for.
  const began = !painted;
  let repaint = false;

  if (!painted) {
    state.browse = {
      slug, loading: true, error: null, entries: [], memory: [], memoryTruncated: false,
      truncated: false, total: 0, filter: '', folder: 'all', window: BROWSE_RENDER_CAP,
      // THE LENS IS REMEMBERED INSTALL-WIDE (v3.64.1; it was per domain in
      // v3.64.0 — see SECTION_PREFS_KEY for the defect that changed). Read
      // inline rather than through a helper, for this file's standing reason:
      // this function is lifted into a suite sandbox and executed there.
      lens: (state.sectionPrefs && state.sectionPrefs.lens) || 'wiki',
    };
    if (gate) gate.begin();
    render(token);
  }
  try {
    // `include=memory` is opt-in ON THE SERVER (see src/routes/wiki.js) and
    // this is the caller that wants it: the memory facet needs the list, and
    // its COUNT has to be right on the very first paint or the facet would
    // read "Memory 0" until something else happened to refresh it.
    const data = await fetchJSON('/api/wiki/' + encodeURIComponent(slug) + '/list?include=memory');
    if (!isCurrentMount(token)) return;
    const b = state.browse;
    if (!b || b.slug !== slug) return; // domain switched mid-fetch
    const entries = Array.isArray(data.entries) ? data.entries : [];
    // AN OLDER SERVER ANSWERS WITHOUT IT. A browser tab can be running this
    // shell against a server that predates the flag (the same case the
    // deprecated memory alias exists for), and the honest degradation is an
    // empty facet, never a thrown render.
    const memory = Array.isArray(data.memory) ? data.memory : [];
    const sig = browseSignature(entries, memory, data.truncated, data.memoryTruncated);
    // NULL-SAFE, like loadProjects's copy: a state object without a `cache`
    // gets a throwaway slot rather than a TypeError. Every sandbox in the tree
    // supplies `state` as a bare object, and a crash there reads like a pass
    // in a summary line.
    const slot = (state.cache && (state.cache[slug] || (state.cache[slug] = {}))) || {};

    // ── AN IDENTICAL ANSWER COSTS NOTHING ───────────────────────────────
    // A revalidation that finds the same list must not repaint: setMain()
    // replaces the whole main column, which destroys focus, resets the
    // scroll position of a 3,445-row list and re-runs every binder — for a
    // screen that would come back pixel-identical. The signature is the
    // whole response, so "same" here means genuinely same.
    if (painted && slot.browseSig === sig) { slot.at = Date.now(); return; }

    b.entries = entries;
    b.memory = memory;
    b.memoryTruncated = !!data.memoryTruncated;
    b.truncated = !!data.truncated;
    b.total = b.entries.length;
    b.loading = false;
    // The window is a statement about a match set. A revalidation that
    // CHANGED the list has changed the match set, so it resets — carrying
    // 600 across would make "Showing 600 of 12" expressible, which is the
    // same reasoning the filter and facet handlers already apply.
    if (painted) b.window = BROWSE_RENDER_CAP;
    repaint = true;

    slot.browse = {
      entries, memory, memoryTruncated: b.memoryTruncated, truncated: b.truncated, total: b.total,
      // The WINDOW travels with the cached list rather than being re-derived
      // at the seed site: selectDomain must not name BROWSE_RENDER_CAP, which
      // is this view's constant and not part of what a switch knows about.
      window: BROWSE_RENDER_CAP,
    };
    slot.browseSig = sig;
    slot.at = Date.now();

    // A COLD fill lands after the view-enter animation has already ended, so
    // it fades itself in ONCE rather than appearing. A revalidation that
    // replaced the list does not: the block is already on screen, and fading
    // an update is how a repaint reads as a flicker.
    if (!painted) state.reveal = { key: slug + ':browse', used: false };
  } catch (err) {
    if (!isCurrentMount(token)) return;
    const b = state.browse;
    if (!b || b.slug !== slug) return;
    // A FAILED REVALIDATION NEVER DESTROYS A GOOD LIST. The pages on screen
    // came from a successful read of this same domain; replacing them with
    // an error card because a background re-ask timed out would be strictly
    // worse than saying nothing, and the user did not ask for the re-ask.
    if (painted) return;
    b.loading = false;
    b.error = err.message;
    repaint = true;
  } finally {
    // MUST be a finally: the two `b.slug !== slug` early returns above
    // (domain switched mid-fetch) would otherwise skip settle and leave
    // the gate pending forever — a loader that appears at 200 ms and never
    // leaves, which is worse than the flash this whole change removes.
    //
    // ONLY IF WE BEGAN IT. See `began` above: settling a gate this call
    // never began is what decrements another in-flight load's counter.
    if (began) settleGate(gate, () => render(token));
    else if (repaint) render(token);
  }
}

// The eyebrow every branch of this panel renders.
//
// IT WAS `PAGES · THE WIKI` UNTIL v3.64.0, and the second half is gone
// because it stopped being true. v3.49.0 added "· THE WIKI" for a good
// reason — the stat cards directly above carry their own `PAGES` eyebrow
// over a COUNT, so a bare `PAGES` read as a second heading for the same
// number, and "wiki" was the word the reporting user could not find
// anywhere on the screen. This list now holds the domain's CONTEXT
// documents as well (briefs, handoffs and, this release, foundations), so
// an eyebrow promising the wiki would name one of its three lenses. What
// distinguishes the count from the index is now the LENS ROW directly under
// this eyebrow, which says in three words what the list can show.
// ── THE FIVE SECTIONS ARE NUMBERED (v3.64.1) ──────────────────────────────
//
// THE COMPLAINT, and the measurement behind it. The maintainer's words were
// that the domain page's sections "are not distinguishable". They were not:
// this column named its regions SIX different ways — a bare eyebrow
// (PROJECTS, WIKI HEALTH), a SECOND eyebrow class for the same role (PAGES),
// an eyebrow in a flex head row (OVERVIEW), two fold summaries (INGEST,
// SHARED BRAIN) and a card title bar (the health card) — and every one of
// them was the quietest rung in the type standard, 11px/500. The Context view
// next door reads as a sequence because its steps are numbered and titled at
// 16px/600. Nothing here was broken; there was simply no hierarchy to see.
//
// So the five SECTIONS take a numeral and the block-title face — ① INGEST
// ② PAGES ③ PROJECTS IN THIS DOMAIN ④ SHARED BRAIN ⑤ WIKI HEALTH — and
// OVERVIEW stays unnumbered above them, because it is a reading ABOUT the
// screen rather than a step in it (the same argument the Context view's own
// three-cell strip makes for sitting outside its numbering).
//
// IT IS NOT `renderBlock`, AND THAT IS A CONSTRAINT RATHER THAN A CHOICE.
// The shared numbered-block component lives in shared/block.js and the
// Context view composes all three of its steps through it. Three suites lift
// `renderMain` out of this file by brace-matching and EXECUTE it against
// fixed stub lists, so naming a new import inside it is a ReferenceError —
// a suite that CRASHES rather than one that fails — and two of the three
// belong to other packages. The classes below are this file's own and MATCH
// the component visually (domains.css copies its sizes and colours); moving
// the domain page onto the component itself, with the stub lists edited in
// the same commit, is v3.65.0's.
//
// THE TITLE ELEMENT KEPT ITS CLASSES. `.cur-group-title.dm-section-eyebrow`
// is pinned BY NAME in three suites, two of which are not this package's, so
// the numeral and the larger face are added AROUND it rather than by
// replacing it. `.dm-recent-eyebrow` survives on PAGES for the same reason —
// scripts/test-next-domain-pages.js asserts a CSS rule by that selector — but
// it stops being a second TREATMENT: one rule, `.dm-section-hd
// .dm-section-eyebrow`, now paints every section title.
// THE NUMERAL IS WRITTEN OUT AT EVERY SITE, and a helper was tried and
// REMOVED: `renderMain`, `healthSection` and `renderProjectsPanel` are each
// lifted by brace-matching and executed by at least one suite, so a shared
// `sectionNum()` would be an undefined identifier in all of them. Five
// literals that cannot crash beat one function that can. Each is
// `aria-hidden`, because a numeral is an ordering cue and not a name — a
// screen reader reads "INGEST", not "1 INGEST", which is the same call
// shared/block.js makes about its own.
const BROWSE_EYEBROW = '<div class="dm-section-hd"><span class="dm-section-num" aria-hidden="true">2</span><div class="cur-group-title dm-recent-eyebrow dm-section-eyebrow">Pages</div></div>';

function renderBrowsePanel() {
  const b = activeBrowse();
  // NO GATE. Until v3.49.0 this branch rendered a "Browse pages" button and
  // the list existed only after someone pressed it — which is how a user
  // ended up unable to find his own wiki (see renderMain). The list is now
  // loaded with the domain, alongside the project list and the health scan.
  // It is the SAME placeholder the loading branch below shows, deliberately:
  // a control here would flash a gate the user is not being asked to pass.
  //
  // CORRECTED (v3.57.0): this used to add "so this branch is only ever the
  // instant between the first paint and loadBrowse's own first render". That
  // was the DEFECT, not the reassurance it read as — loadBrowse blanked
  // `state.browse` on every entry and every switch, including for a list it
  // had already fetched and was about to re-fetch identically, and on entry it
  // did so 834 ms in because it ran behind an uncached 750 ms health scan.
  // Measured: 26 px between two 585 px paints. This branch is now reached only
  // on a genuinely COLD first sight of a domain in a session; see loadBrowse.
  //
  // The read is cheap by construction — GET /api/wiki/:domain/list is a
  // readdir with no file bodies (see the section header) — and the render
  // cap below is what keeps a 3,300-page domain from painting 3,300 rows.
  // MEASURED in the browser on the real 3,445-entry payload: 1.4 ms to parse
  // the 483 KB response, 0.3 ms to sign it for the revalidation compare, and
  // 5.6 ms median (8.5 ms worst of twelve) for a WHOLE main-column repaint
  // including this card's 150-row build — inside one frame, so the cap and
  // the v3.50.0 "Show N more" window are doing their job and nothing here
  // needed optimising.
  if (!b || b.loading) {
    // ── THE PLACEHOLDER HOLDS THE CARD'S HEIGHT ─────────────────────────
    //
    // THE BLINK WAS A COLLAPSE, NOT A SPINNER. `gatedLoader` returns the
    // EMPTY STRING below the 200 ms threshold — correctly, and that decision
    // is not being reopened here — so this card painted with no children at
    // all: measured at 26 px between two 585 px paints, a 559 px jump down
    // and back up. What was missing was not a loader; it was the SPACE.
    //
    // The number is the height this card had when it was last painted with
    // content, captured off the live DOM in render() before the column is
    // replaced (state.reserve). It is a measurement of the card the user is
    // looking at, not a guess: the two domains measured here differ by 38 px
    // (585 vs 547), and their health cards by 119, so one hardcoded reserve
    // would be wrong for one of every two domains.
    //
    // ABSENT IS NOT ZERO. With no reserve recorded — the very first paint of
    // a session, before any card has ever had content — no min-height is
    // emitted at all, which is exactly what this branch did before. A
    // fabricated default would reserve space for a card whose size nothing
    // has measured.
    //
    // aria-busy says the same thing to a screen reader that the reserved
    // space says to the eye, and it is the honest one to use here: the
    // region is present and being updated, which is true whether or not the
    // gate has decided the wait is long enough to put words on the screen.
    const reserve = state.reserve && state.reserve.browse;
    return BROWSE_EYEBROW + '<div class="dm-browse-card" aria-busy="true"' +
      (reserve ? ' style="min-height:' + reserve + 'px"' : '') + '>' +
      gatedLoader(loadGate, 'Loading pages…', 'dm-browse-empty') + '</div>';
  }
  if (b.error) {
    return (
      BROWSE_EYEBROW +
      '<div class="dm-browse-card">' +
        // The THIRD runtime error in this view that rendered through a class
        // meaning something else — `.dm-browse-empty` also says "No pages
        // match that filter", i.e. a benign empty state, with only
        // `.dm-error-text` distinguishing a failure from a filter that
        // matched nothing. Fixing the sidebar and the health scan and
        // leaving this one is how a class gets fixed at its reported site
        // and stays broken as a class.
        '<div class="dm-browse-lead">' +
          renderStatus({ state: 'danger', title: 'Could not list pages', detail: b.error }) +
        '</div>' +
        '<button class="btn btn-secondary" id="dm-browse-load-btn">Try again</button>' +
      '</div>'
    );
  }

  const { kind, items, lens } = browseMatches(b);
  const win = browseWindow(b);
  const shown = items.slice(0, win);
  const tabs = BROWSE_FOLDERS.map((f) => {
    const n = f.key === 'memory'
      ? (b.memory || []).length
      : (f.key === 'all' ? b.entries.length : b.entries.filter((e) => e.folder === f.key).length);
    return '<button class="dm-browse-tab' + (b.folder === f.key ? ' active' : '') + '" data-browse-folder="' + f.key + '">' +
      escapeHtml(f.label) + ' <span class="dm-browse-tab-count">' + n + '</span></button>';
  }).join('');

  // ONE ROW, ONE PAINTER, DECIDED PER ROW rather than per list — the All
  // lens interleaves both kinds, and a wiki entry is exactly the entry that
  // carries no `kind` (the wiki inventory has `folder`; the context
  // inventory has `kind`). Same expression in showMoreBrowseRows, which
  // APPENDS rather than re-rendering.
  const rows = shown.map((e) => (e && e.kind ? memoryRowHtml(e) : browseRowHtml(e))).join('') ||
    renderDescription(kind === 'memory'
      ? 'No memory pages match that filter.'
      : 'No pages match that filter.');

  const truncNote = b.truncated
    ? '<div class="dm-browse-note dm-quick-note-busy">' + icon('alertTriangle', 12) + ' This domain has more pages than the listing endpoint returns — the list below is incomplete.</div>'
    : '';

  // ── THE ENTER ANIMATION, FOR CONTENT THAT MISSED IT ───────────────────
  // A cold first fill of this card lands long after the view-enter animation
  // has ended, so it appears abruptly. The one-shot token (state.reveal,
  // written by loadBrowse) fades it in ON THAT FILL ONLY. Consumed here
  // rather than cleared by the loader, because only the render knows the
  // block actually reached the screen — and consumed rather than merely read,
  // because a class that survives into the next repaint would make every
  // subsequent render of this card fade, which is the flicker this release
  // exists to remove wearing a nicer coat. A cache hit never sets the token,
  // so a switch back to a domain you have already seen does not animate.
  const revealKey = b.slug + ':browse';
  let revealCls = '';
  if (state.reveal && state.reveal.key === revealKey && !state.reveal.used) {
    state.reveal.used = true;
    revealCls = ' content-reveal';
  }

  return (
    // A `.dm-section`, so its gap to Projects below is the SAME rule as every
    // other gap on this card. See renderProjectsPanel for the reported defect.
    '<section class="dm-section dm-pages">' +
      BROWSE_EYEBROW +
      '<div class="dm-browse-card' + revealCls + '">' +
        // ── THE LENS ROW (v3.64.0) ────────────────────────────────────
        //
        // Three chips, above the list, above the type facets: WIKI is what
        // the model compounded (entities, concepts, summaries); CONTEXT is
        // what this domain holds ABOUT the work — each project's standing
        // brief, each work-stream's handoff, and its canonical foundations;
        // ALL is both, interleaved.
        //
        // It is a SEPARATE class from `.dm-browse-tab` and not a sixth chip
        // in that row, because it answers a different question: the facets
        // narrow WITHIN the wiki, the lens chooses which inventory is being
        // narrowed. The active chip is read off the EFFECTIVE lens
        // browseMatches computed, never off the stored field, so the row
        // cannot claim Wiki while the list shows briefs.
        // ── NO COUNTS ON THE LENS, AND THAT IS A CORRECTION MADE IN THE
        // BROWSER. The first cut put one on each chip, which rendered
        // `Wiki 767 · Context 73 · All 840` directly above the facet row's
        // `All 767 · Entities 161 · …` — two chips labelled "All" carrying
        // two different numbers, eight pixels apart. That is the
        // self-contradicting-figures defect this card has already been fixed
        // for twice (the `other` count, and the Memory facet `All` does not
        // include), and the lens is a MODE rather than a measurement: the
        // figures for what it selects are the facet row directly beneath it
        // and the OVERVIEW tiles directly above.
        '<div class="dm-lens-row" role="group" aria-label="Which documents to list">' +
          [['wiki', 'Wiki'], ['context', 'Context'], ['all', 'All']]
            .map(([key, label]) =>
              '<button type="button" class="dm-lens-chip' + (lens === key ? ' active' : '') + '"' +
                ' data-browse-lens="' + key + '" aria-pressed="' + (lens === key ? 'true' : 'false') + '">' +
                escapeHtml(label) +
              '</button>').join('') +
        '</div>' +
        '<div class="dm-browse-controls">' +
          '<input class="dm-browse-filter" id="dm-browse-filter" type="text" placeholder="Filter by name…" value="' + escapeHtml(b.filter) + '" />' +
          '<div class="dm-browse-tabs">' + tabs + '</div>' +
        '</div>' +
        truncNote +
        // ── THE FOOTER SITS BELOW THE LIST, NOT INSIDE IT ─────────────────
        // v3.48.1 put "+ New project" INSIDE its group as the last row, and
        // the first draft of this copied that. Rendering it showed why the two
        // cases are not the same: the projects group is not a scroll
        // container, so its last row is at the end of what you can see, while
        // `.dm-browse-list` is capped at 420px with `overflow-y: auto` — so an
        // in-list footer sits roughly 130 rows below the fold, under a note
        // reading "Showing 150 of 400" that offers no visible way past it.
        // Which is the reported defect wearing a control.
        //
        // The row SHAPE is kept (a `.cur-group-row` button, the whole band a
        // target, a hairline above it at the kit's inset) because that is the
        // right shape for a list's own action; only the placement differs, and
        // it differs for a measured reason rather than by drift.
        '<div class="dm-browse-list" id="dm-browse-list">' + rows + '</div>' +
        browseNoteHtml(shown.length, items.length) +
        browseMoreHtml(shown.length, items.length) +
      '</div>' +
    '</section>'
  );
}

/**
 * One wiki page's row. Extracted from renderBrowsePanel because the
 * "Show 150 more" path APPENDS rows into the live list rather than
 * re-rendering the panel, so two places emit this markup — and two copies of
 * it is how the appended rows would quietly stop matching the painted ones.
 */
function browseRowHtml(e) {
  return (
    '<button class="dm-browse-row" data-browse-path="' + escapeHtml(e.path) + '" data-browse-title="' + escapeHtml(e.title || e.slug) + '">' +
      '<span class="dm-browse-dot dm-browse-dot-' + escapeHtml(e.folder) + '"></span>' +
      '<span class="dm-browse-title">' + escapeHtml(e.title || e.slug) + '</span>' +
      '<span class="mono dm-browse-path">' + escapeHtml(e.path) + '</span>' +
    '</button>'
  );
}

/**
 * One memory page's row — a project's standing brief, or one work-stream's
 * handoff on one machine.
 *
 * IT CARRIES THE THREE FACTS THE CLICK NEEDS, not the path: the path is
 * DISPLAYED (it is what tells a person where the file is on disk and in their
 * synced repository), but `openMemoryPageFromBrowse` opens the file through
 * GET /api/memory/:domain/:project, which addresses it by project, scope and
 * machine. Sending a path to a route that takes names would mean parsing the
 * path back apart on the way in, which is a second, weaker copy of the
 * store's own addressing.
 */
function memoryRowHtml(e) {
  const title = e.title || e.path;
  return (
    '<button class="dm-browse-row dm-browse-row-memory"' +
      ' data-mem-kind="' + escapeHtml(e.kind || '') + '"' +
      ' data-mem-project="' + escapeHtml(e.project || '') + '"' +
      ' data-mem-scope="' + escapeHtml(e.scope || '') + '"' +
      ' data-mem-machine="' + escapeHtml(e.machine || '') + '"' +
      // TIER 0 IS ADDRESSED BY SLUG (v3.64.0) — a foundation is not a
      // (scope, machine) pair and its route is a different one. Empty for
      // the other two kinds, exactly as scope and machine are empty here.
      ' data-mem-slug="' + escapeHtml(e.slug || '') + '"' +
      ' data-mem-title="' + escapeHtml(title) + '"' +
      ' data-mem-path="' + escapeHtml(e.path || '') + '">' +
      '<span class="dm-browse-dot dm-browse-dot-memory"></span>' +
      '<span class="dm-browse-title">' + escapeHtml(title) + '</span>' +
      // The store's own readings, SHOWN rather than dropped — this module's
      // recorded dominant defect class is a consumer losing a field the
      // store computed. A skeleton is a document waiting to be filled; a
      // stale mirror is one its repository has moved past.
      (e.skeleton ? '<span class="dm-browse-mark">to fill</span>' : '') +
      (e.freshness === 'stale' ? '<span class="dm-browse-mark">stale</span>' : '') +
      '<span class="mono dm-browse-path">' + escapeHtml(e.path || '') + '</span>' +
    '</button>'
  );
}

/**
 * The count line, and the way past it.
 *
 * ── "Showing N of M", AND A ROW THAT CHANGES N ──────────────────────────
 * The old note said "Showing the first 150 of 3,421 matches — narrow the
 * filter to see the rest" and meant it literally: narrowing the filter was
 * the ONLY way. This says the same two numbers and puts a control under them.
 *
 * THE CONTROL IS THE LIST'S FOOTER ROW, the shape v3.48.1 settled for "+ New
 * project": a `<button>` that IS a row, so the whole band is the target and
 * the kit's own separator draws above it with no special case. It is the same
 * answer to the same question — where does a list's own action live — so it is
 * the same shape, not a second one.
 *
 * Returns '' when everything matching is already on screen, which is the
 * common case on a small domain: a control that can only say "there is
 * nothing more" is worse than no control.
 */
function browseMoreHtml(shownCount, totalCount) {
  if (totalCount <= shownCount) return '';
  const step = Math.min(BROWSE_RENDER_CAP, totalCount - shownCount);
  return (
    '<button type="button" class="cur-group-row dm-browse-more" id="dm-browse-more">' +
      '<span class="dm-browse-more-label">Show ' + step.toLocaleString() + ' more</span>' +
    '</button>'
  );
}

/**
 * "Showing N of M" — and NOTHING when N is M.
 *
 * A list that fits says nothing about its own length, which is what every
 * small domain sees and is the state this note must not clutter.
 */
function browseNoteHtml(shownCount, totalCount) {
  if (totalCount <= shownCount) return '';
  return '<div class="dm-browse-note" id="dm-browse-note">Showing ' +
    shownCount.toLocaleString() + ' of ' + totalCount.toLocaleString() + '</div>';
}

// Opens a page in the shell reader.
//
// The body is rendered as RICH MARKDOWN through next/shared/markdown.js —
// the same single renderer views/chat.js uses for chat answers and for its
// own citation reader. This view previously showed the page's escaped
// Markdown SOURCE in a <pre>, because the renderer only existed inside
// views/chat.js and copying an escape-first security guard into a second
// file is the "two hand-maintained copies of a guard" shape that produced
// the v3.2.0 CRITICAL. Lifting the renderer into next/shared/ removed the
// dilemma rather than picking a side of it.
//
// `page.body` is UNTRUSTED. It is LLM-authored, hand-editable in Obsidian,
// and delivered over Personal Sync and Shared Brain mirrors from other
// machines and other people — so it is handed to renderMarkdown(), which
// escapes the whole string before inserting any tag, and never to innerHTML
// directly. `page.body` also excludes the YAML frontmatter (wiki-read.js's
// parseFrontmatter strips it), so rendering it as Markdown cannot resurrect
// the v3.5.1 "frontmatter rendered as body prose" defect.
async function openWikiPageFromBrowse(path, titleHint) {
  const mount = myMountToken;
  const slug = state.activeSlug;
  const epoch = openReader({ slug: path, title: titleHint || path, loading: true }, mount);
  try {
    const page = await fetchJSON('/api/wiki/' + encodeURIComponent(slug) + '/page?path=' + encodeURIComponent(path));
    if (!isCurrentMount(mount)) return;
    if (!isCurrentReader(epoch)) return; // Esc / scrim / ✕ closed it while we fetched
    const tags = Array.isArray(page.frontmatter && page.frontmatter.tags) ? page.frontmatter.tags : [];
    const plainTags = tags.map((t) => String(t).replace(/^"+|"+$/g, '')).filter((t) => !/^type\//.test(t));
    openReader({
      slug: page.path || path,
      title: page.title || titleHint || path,
      // The one fact the shell reader cannot derive for itself. It drives
      // the RAW-source bar (app.js, "Reader RAW-source bar") — which
      // original document this summary was built from, and whether it is
      // still on this machine. `slug` here is the DOMAIN slug (this view's
      // state.activeSlug), captured before the await; `path` is the page.
      domain: slug,
      type: page.folder,
      typeLabel: page.type,
      tags: plainTags,
      readonly: !!page.readonly,
      bodyHtml: renderMarkdown(page.body || ''),
      backlinks: Array.isArray(page.backlinks)
        ? page.backlinks.map((bl) => ({ path: bl.path, title: bl.title || bl.slug, type: bl.folder }))
        : [],
      onBacklinkClick: (bp, bt) => openWikiPageFromBrowse(bp, bt),
    }, mount);
  } catch (err) {
    if (!isCurrentMount(mount)) return;
    if (!isCurrentReader(epoch)) return;
    openReader({ slug: path, title: titleHint || path, error: err.message }, mount);
  }
}

/**
 * Opens a MEMORY page in the shell reader.
 *
 * ── WHY NOT GET /api/wiki/:domain/page, WHICH THE ROW ABOVE USES ─────────
 * MEASURED, not assumed — scripts/test-wiki-list-memory.js §6 drives the real
 * route against three real `state/` paths. It answers **400**, with the words
 * `"state/project.md" must be inside entities/, concepts/, or summaries/`:
 * `getWikiPage` gates on a FOLDER ALLOW-LIST before it even reaches
 * `resolveInsideWiki`, and `state/` is `wiki/`'s SIBLING, not its child. Both
 * refusals are deliberate and load-bearing (the containment half is the v3.2.0
 * CRITICAL's fix), so the answer is to use the route that owns memory rather
 * than to widen the one that owns the wiki.
 *
 * GET /api/memory/:domain/:project is that route. It already reads, byte-caps
 * and SANITISES both tiers — `neutraliseProtocol` on read, the duplicate-
 * heading check, the read-sanitisation note — and it addresses a handoff by
 * (project, scope, machine), which is exactly the three facts the row carries.
 *
 * ── NO `domain` ON THE READER PAYLOAD, DELIBERATELY ──────────────────────
 * `content.domain` is the one fact that switches on the reader's RAW-source
 * bar (app.js), which asks GET /api/wiki/:domain/source about a wiki page. A
 * memory page has no ingested source document and is not a wiki page at all,
 * so supplying it would buy a request that can only ever answer "no". Omitted
 * is the documented degradation: no bar, no request.
 *
 * The body is UNTRUSTED — agent-written, hand-editable, and arriving over
 * Personal Sync from other machines — so it goes through renderMarkdown(),
 * which escapes the whole string before inserting any tag. Same renderer, same
 * rule, as the wiki row beside it.
 */
async function openMemoryPageFromBrowse(row) {
  const mount = myMountToken;
  const slug = state.activeSlug;
  const title = row.title || row.path;
  const epoch = openReader({ slug: row.path, title, loading: true }, mount);
  try {
    // ── THREE KINDS, TWO ROUTES (v3.64.0) ──────────────────────────────
    // A brief and a handoff are two halves of ONE project read; a foundation
    // is its own document with its own route. The row carries which it is,
    // so nothing here parses a path back apart — the same reason this
    // function was given project/scope/machine rather than the path in
    // v3.50.0.
    let url = '/api/memory/' + encodeURIComponent(slug) + '/' + encodeURIComponent(row.project);
    if (row.kind === 'foundation') {
      url += '/foundations/' + encodeURIComponent(row.slug || '');
    } else if (row.kind === 'handoff') {
      url += '?scope=' + encodeURIComponent(row.scope) + '&machine=' + encodeURIComponent(row.machine);
    }
    const data = await fetchJSON(url);
    if (!isCurrentMount(mount)) return;
    if (!isCurrentReader(epoch)) return; // Esc / scrim / ✕ closed it while we fetched

    if (row.kind === 'foundation') {
      // ── A DELIBERATELY SMALLER COMPOSITION THAN views/memory.js's ──────
      // That view's `foundationReaderContent` is not exported and is not
      // lifted here: it carries an age readout, a commit provenance line and
      // five notes built for the surface that OWNS tier 0, where a reader
      // arrives having chosen a project. This is a page LIST, and what a
      // reader needs from it is the document, what kind it is, and the two
      // readings that change how the text should be read — a skeleton's
      // body is a set of QUESTIONS, and a stale mirror's is behind its
      // source. Both come from the payload's own flags, never from matching
      // the text. The fuller panel stays one click away in Project context.
      const body = typeof data.text === 'string' ? data.text : '';
      const notes = [];
      if (data.skeleton) notes.push('A skeleton — the prompts below are questions, not facts.');
      if (data.freshness === 'stale') {
        notes.push('This copy no longer matches the file it was copied from.');
      }
      if (data.freshness === 'unreachable') {
        notes.push('The folder this was copied from is not on this computer, so the copy '
          + 'could not be compared against it.');
      }
      openReader({
        slug: row.path, title, type: 'memory', typeLabel: 'foundation',
        tags: [
          data.role ? 'role: ' + data.role : null,
          data.source && data.source.kind === 'repo' && data.source.path
            ? 'source: ' + data.source.path : 'written for this project',
          data.readFirst ? 'read first' : null,
          data.truncated ? 'truncated at the read cap' : null,
          data.sanitisedOnRead ? 'sanitised on read' : null,
        ].filter(Boolean),
        readonly: true,
        // ── THE NOTE IS PAYLOAD-DRIVEN, AND IT HAS TO BE ─────────────────
        // The shell's DEFAULT readonly caption is "Read-only Shared Brain
        // mirror" — a sentence about a different feature — and v3.61.0 added
        // `readonlyNote` precisely because tier 0 opened in this reader and
        // every canonical document in the app was captioned with it. SEEN
        // AGAIN HERE in the browser on the first cut of this branch: a
        // curator-authored foundation opened from the page list read
        // "Read-only Shared Brain mirror". Which sentence is right depends
        // on where the document is CHANGED, which is the per-document
        // `source.kind`, never the manifest's `ownership` — a field this
        // route does not send (the other half of the same v3.61.0 defect).
        readonlyNote: (data.source && data.source.kind === 'repo')
          ? 'Mirrored from the folder — edit it there, then refresh.'
          : 'Edit this in Project context, under Documents.',
        bodyHtml: (notes.length ? notes.map((n) => renderDescription(n)).join('') : '')
          + renderMarkdown(body),
        backlinks: [],
      }, mount);
      return;
    }

    const part = row.kind === 'handoff' ? (data && data.current) : (data && data.brief);
    const present = !!(part && part.present);
    const body = present && typeof part.text === 'string' ? part.text : '';

    openReader({
      slug: row.path,
      title,
      type: 'memory',
      typeLabel: row.kind === 'handoff' ? 'handoff' : 'standing brief',
      // The store's own honesty fields, forwarded rather than dropped — this
      // module's recorded dominant defect class is a consumer silently losing
      // a field the store computed. Each renders as a tag chip.
      tags: [
        row.kind === 'handoff' && row.scope ? 'scope: ' + row.scope : null,
        row.kind === 'handoff' && row.machine ? 'machine: ' + row.machine : null,
        part && part.truncated ? 'truncated at the read cap' : null,
        part && part.sanitisedOnRead ? 'sanitised on read' : null,
        part && part.headingsSuspect ? 'repeated headings' : null,
      ].filter(Boolean),
      readonly: !!(data && data.readonly),
      // AN ABSENT FILE IS SAID, NOT RENDERED AS AN EMPTY PAGE. The listing is
      // a snapshot; an agent can move or replace a file between the list and
      // the click, and a blank reader would read as "this handoff is empty".
      bodyHtml: present
        ? renderMarkdown(body)
        : renderDescription('This file is not there any more. The list was read when this domain '
          + 'was opened; an agent may have saved over it or a sync may have moved it since.'),
      backlinks: [],
    }, mount);
  } catch (err) {
    if (!isCurrentMount(mount)) return;
    if (!isCurrentReader(epoch)) return;
    openReader({ slug: row.path, title, error: err.message }, mount);
  }
}

// ── Domain lifecycle card ──────────────────────────────────────────────────
//
// LIFECYCLE REFUSAL (v3.6.0 finding 7). PUT and DELETE both 409 when the
// domain has an active write. That refusal renders as its OWN message,
// visually distinct from an error, inside this card — the surface the user
// is already looking at and the one they cannot scroll away from while the
// form is open. The failure being designed against is not "we forgot to
// handle 409"; it is "we handled it and the user never saw it", after which
// they clicked the destructive action again.
function renderLifecycleCard() {
  const f = state.lifecycle;
  if (!f) return '';
  const busy = !!f.busy;

  const messages =
    (f.refusal
      ? '<div class="dm-lc-refusal">' + icon('alertCircle', 14) +
        '<span><strong>Not done — the server refused this.</strong> ' + escapeHtml(f.refusal) + '</span></div>'
      : '') +
    (f.error ? '<div class="dm-lc-error">' + icon('alertCircle', 14) + '<span>' + escapeHtml(f.error) + '</span></div>' : '');

  if (f.mode === 'delete') {
    const domain = state.domains.find((d) => d.slug === f.slug);
    // pageCount is the RECURSIVE total (files.js's stated invariant:
    // entities + concepts + summaries + other). v3.2.0 recorded that
    // narrowing it made the shipping delete dialog promise 4 pages and then
    // delete 7 — so the number quoted here is deliberately that one.
    const pages = domain && typeof domain.pageCount === 'number' ? domain.pageCount : null;
    const readonly = state.readonlySet.has(f.slug);
    return (
      '<div class="dm-lc-card dm-lc-danger">' +
        '<div class="dm-lc-title">Delete “' + escapeHtml(f.displayName || f.slug) + '”?</div>' +
        '<div class="dm-lc-body">This permanently removes <span class="mono">domains/' + escapeHtml(f.slug) + '/</span>' +
          (pages === null ? '' : ' and all ' + pluralize(pages, 'page') + ' in it') +
          ', including its raw sources and saved conversations. It cannot be undone from inside The Curator.' +
          (readonly ? ' This is a Shared Brain mirror — deleting it removes only your local copy, and a future Pull recreates it.' : '') +
        '</div>' +
        messages +
        '<div class="dm-lc-actions">' +
          '<button class="btn btn-danger-solid" id="dm-lc-submit"' + (busy ? ' disabled' : '') + '>' +
            (busy ? 'Deleting…' : 'Delete permanently') + '</button>' +
          '<button class="btn btn-ghost" id="dm-lc-cancel"' + (busy ? ' disabled' : '') + '>Cancel</button>' +
        '</div>' +
      '</div>'
    );
  }

  if (f.mode === 'rename') {
    // A mirror's slug IS its contract: pullCollective writes to
    // shared-<slug>, and both validateConnection and pushDomain refuse a
    // `shared-*` domain as a contributing domain. Renaming one away from
    // that prefix would leave a domain that the next Pull recreates
    // alongside it AND that those two refusals no longer recognise — so it
    // could be pushed as a contributor. The backend does not block this;
    // this refusal is deliberate UI policy, stated rather than silent.
    if (state.readonlySet.has(f.slug)) {
      return (
        '<div class="dm-lc-card">' +
          '<div class="dm-lc-title">Read-only mirrors cannot be renamed</div>' +
          '<div class="dm-lc-body">' + escapeHtml(f.displayName || f.slug) + ' is a Shared Brain mirror. Its folder name ' +
            '(<span class="mono">' + escapeHtml(f.slug) + '</span>) is what marks it as a mirror — renaming it would make the ' +
            // ── THE OLD SENTENCE POINTED AT A CONTROL THAT DOES NOT EXIST
            // (corrected v3.64.0). It read "Rename the brain from the Shared
            // Brain view instead." There is no rename there, and there never
            // was: nothing in views/shared.js matches /rename/i, and the
            // only PATCH the server makes to a connection is the one an
            // operation writes for itself. The name comes from the cohort
            // that created the Shared Brain, so that is what this says now.
            'next Pull create a second copy alongside it. The name comes from the Shared Brain ' +
            'this mirrors — it is not yours to change from here.</div>' +
          '<div class="dm-lc-actions"><button class="btn btn-ghost" id="dm-lc-cancel">Close</button></div>' +
        '</div>'
      );
    }
    return (
      '<div class="dm-lc-card">' +
        '<div class="dm-lc-title">Rename “' + escapeHtml(f.slug) + '”</div>' +
        '<div class="dm-lc-body">The display name changes immediately. The folder name is chosen by the server and only ' +
          'changes if the new name produces a different one — either way, nothing here assumes which.</div>' +
        '<label class="dm-lc-label" for="dm-lc-name">Display name</label>' +
        '<input class="dm-lc-input" id="dm-lc-name" type="text" value="' + escapeHtml(f.displayName) + '"' + (busy ? ' disabled' : '') + ' />' +
        messages +
        '<div class="dm-lc-actions">' +
          '<button class="btn btn-primary" id="dm-lc-submit"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Renaming…' : 'Rename') + '</button>' +
          '<button class="btn btn-ghost" id="dm-lc-cancel"' + (busy ? ' disabled' : '') + '>Cancel</button>' +
        '</div>' +
      '</div>'
    );
  }

  const templates = DOMAIN_TEMPLATES.map((t) => (
    '<button class="dm-lc-template' + (f.template === t.value ? ' active' : '') + '" data-template="' + t.value + '"' + (busy ? ' disabled' : '') + '>' +
      '<span class="dm-lc-template-label">' + escapeHtml(t.label) + '</span>' +
      '<span class="dm-lc-template-hint">' + escapeHtml(t.hint) + '</span>' +
    '</button>'
  )).join('');

  return (
    '<div class="dm-lc-card">' +
      '<div class="dm-lc-title">New domain</div>' +
      '<div class="dm-lc-body">A domain is one compounding wiki. The template picks the starting schema that tells the ' +
        'AI how to categorise what you ingest — you can edit it later.</div>' +
      '<label class="dm-lc-label" for="dm-lc-name">Name</label>' +
      '<input class="dm-lc-input" id="dm-lc-name" type="text" placeholder="e.g. Articles" value="' + escapeHtml(f.displayName) + '"' + (busy ? ' disabled' : '') + ' />' +
      '<label class="dm-lc-label" for="dm-lc-desc">Description <span class="dm-lc-optional">(optional)</span></label>' +
      '<input class="dm-lc-input" id="dm-lc-desc" type="text" placeholder="What goes in here?" value="' + escapeHtml(f.description) + '"' + (busy ? ' disabled' : '') + ' />' +
      '<div class="dm-lc-label">Template</div>' +
      '<div class="dm-lc-templates">' + templates + '</div>' +
      messages +
      '<div class="dm-lc-actions">' +
        '<button class="btn btn-primary" id="dm-lc-submit"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Creating…' : 'Create domain') + '</button>' +
        '<button class="btn btn-ghost" id="dm-lc-cancel"' + (busy ? ' disabled' : '') + '>Cancel</button>' +
      '</div>' +
    '</div>'
  );
}


// ── Project actions ────────────────────────────────────────────────────────
//
// Each one targets `form.slug` / `form.project`, never `state.activeSlug` —
// the same two-layer discipline the domain lifecycle uses. A form that
// somehow survived a domain switch still could not act on the wrong domain.

/**
 * THE FORM, WITHOUT THE RENDER (extracted v3.62.0, P1-9).
 *
 * `openProjectLifecycle` below is this plus `state.copied = null` plus a
 * render — which is right for a click, and wrong for the ONE other caller:
 * `loadDomainsList`'s commit, which runs inside a single settled paint and
 * would otherwise paint the card twice. Extracted rather than copied, because
 * a second hand-built form object is a second place the ownership chooser's
 * shape can drift from `shared/foundations-init.js`'s.
 */
function freshProjectLifecycle(mode, project) {
  return {
    mode,
    slug: state.activeSlug,
    project: project || null,
    name: mode === 'rename' ? (project || '') : '',
    brief: mode === 'create' ? PROJECT_BRIEF_TEMPLATE : '',
    confirmText: '',
    busy: false,
    error: null,
    refusal: null,
    // ── WHERE THIS PROJECT'S CANONICAL DOCUMENTS WILL LIVE (v3.61.0) ─────
    //
    // Asked on CREATE and nowhere else, because the store sets an ownership
    // ONCE and refuses a mismatch on every later write — so the question has
    // exactly one right moment, and this is it. A rename or a delete has no
    // business restating it.
    //
    // The state shape is shared/foundations-init.js's own; this view never
    // reads inside it except to hand it back to that module, so the Memory
    // view's copy of this question and this one cannot describe two different
    // choices. `allowLater: true` adds the third answer that only makes sense
    // here: on the create form the choice is one field of a bigger form and
    // postponing it costs nothing, while the Foundations block in Project context
    // IS the surface somebody opened in order to answer it.
    foundations: mode === 'create' ? freshChooser({ allowLater: true }) : null,
  };
}

function openProjectLifecycle(mode, project) {
  state.copied = null;
  state.projectLc = freshProjectLifecycle(mode, project);
  render(myMountToken);
}

function closeProjectLifecycle() {
  state.projectLc = null;
  render(myMountToken);
}

/**
 * Turn a fetchJSON rejection into { error, refusal }.
 *
 * A 4xx the SERVER decided (an invalid or reserved name, a missing typed
 * confirmation, a mirror, a project that already exists, a store too old) is
 * a REFUSAL — the request was understood and declined, and the user can act
 * on the reason. Anything else is an error. The distinction is the same one
 * classifyDomainError makes, and it is rendered in the same two styles, so a
 * refusal never reads as a crash.
 */
function classifyProjectError(err) {
  const status = err && typeof err.status === 'number' ? err.status : 0;
  const msg = (err && err.message) || 'Something went wrong.';
  if (status >= 400 && status < 500) return { error: null, refusal: msg };
  return { error: msg, refusal: null };
}

async function runProjectAction() {
  const token = myMountToken;
  const f = state.projectLc;
  if (!f || f.busy) return;

  const slug = f.slug;
  let url = '/api/memory/' + encodeURIComponent(slug) + '/projects';
  let opts;
  let successText;

  if (f.mode === 'create') {
    const name = (f.name || '').trim();
    if (!name) { f.error = 'Give the project a name.'; render(token); return; }
    // An empty brief is sent as ABSENT, not as an empty string: an empty
    // string is a brief the user wrote nothing in, and the store would
    // create the file.
    const payload = (f.brief || '').trim() ? { project: name, brief: f.brief } : { project: name };
    // ── THE DOCUMENTS CHOICE RIDES WITH THE CREATE (v3.61.0) ─────────────
    //
    // `chooserBody` returns NULL for "decide later", and the key is then
    // absent from the body rather than present saying "later": the route's
    // body is an allow-list, a project with no manifest is the state the
    // Agent-memory chooser exists to resolve, and `{ownership: 'later'}` would
    // be a fourth ownership the store has never heard of.
    //
    // A tier-0 failure AFTER the brief is written is DISCLOSED, never a 5xx
    // and never a rollback — the project exists and half-deleting it would
    // lose a brief the person just wrote. The route answers `ok: true` with
    // `foundationsError`, and the banner below carries it on its own line.
    const fndBody = chooserBody(f.foundations);
    if (fndBody) payload.foundations = fndBody;
    opts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    };
    successText = 'Created project “' + name + '”';
  } else if (f.mode === 'rename') {
    const name = (f.name || '').trim();
    if (!name) { f.error = 'Give the project a name.'; render(token); return; }
    if (name === f.project) { closeProjectLifecycle(); return; }
    url += '/' + encodeURIComponent(f.project);
    opts = {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rename: name }),
    };
    successText = 'Renamed “' + f.project + '” to “' + name + '”.';
  } else {
    // THE TYPED CONFIRMATION IS SENT, not merely checked here. The route
    // refuses unless it matches, so a client that skipped this box still
    // cannot delete anything.
    url += '/' + encodeURIComponent(f.project);
    opts = {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: f.confirmText }),
    };
    successText = 'Deleted project “' + f.project + '”.';
  }

  f.busy = true; f.error = null; f.refusal = null;
  render(token);

  let succeeded = false;
  // The shell-wide write gate, for the same reason the domain lifecycle
  // takes it: a rename MOVES a directory inside this domain, and Sync's
  // buttons must be able to say "something is writing here" rather than
  // handing the user a raw 409.
  const releaseGate = beginDomainWrite(slug, 'project-' + f.mode);
  try {
    const body = await fetchJSON(url, opts);
    if (!isCurrentMount(token)) return;
    // ── THE FILES THE OWNER PICKED, ONE PUT EACH (D18) ──────────────────
    //
    // AFTER the create, because they are documents IN a project that has to
    // exist first, and one at a time rather than in one request because each
    // is a whole-document write the store performs atomically and reports on
    // separately. Nothing was uploaded until now: the text has been sitting in
    // this form since the owner picked the file, which is what let them see it
    // before agreeing to save it.
    //
    // A FAILED IMPORT NEVER FAILS THE CREATE. The project exists and its brief
    // is written; a document that did not land is reported by name on the
    // banner's second line, and the owner can add it again from Project context.
    // Refusing the whole outcome for it would be the v3.32.0 shape — a guard
    // routed around by its own error handler — one level up.
    const imported = [];
    const failed = [];
    const replaced = [];
    if (f.mode === 'create' && f.foundations && Array.isArray(f.foundations.imports)) {
      const seeded = f.foundations.ownership === 'curator' && f.foundations.seed !== false;
      for (const file of f.foundations.imports) {
        if (!file || file.error || !file.slug) continue;
        try {
          await fetchJSON('/api/memory/' + encodeURIComponent(slug) + '/' +
            encodeURIComponent((f.name || '').trim()) + '/foundations/' +
            encodeURIComponent(file.slug), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: file.text, title: file.title, role: file.role }),
          });
          imported.push(file.slug);
          if (seeded && SKELETON_SLUGS.includes(file.slug)) replaced.push(file.slug);
        } catch (err) {
          failed.push(file.slug + ' — ' + ((err && err.message) || 'refused'));
        }
      }
    }
    // ── WHAT HAPPENED, FROM THE SERVER'S ANSWER ─────────────────────────
    // Never from the choice that was SENT: a create that asked for four
    // skeletons and got three is a fact the owner needs, and a sentence built
    // from the request would report the ask as the outcome.
    const words = chooserOutcomeWords({
      ...(body && typeof body === 'object' ? body : {}),
      imported, replacedSkeletons: replaced,
    }, f.foundations);
    const fndErr = body && body.foundationsError && typeof body.foundationsError === 'object'
      ? body.foundationsError : null;
    const detailParts = [];
    if (fndErr) {
      detailParts.push('The project was created, but its Documents were not set up: ' +
        (fndErr.message || fndErr.reason || 'the server refused it') +
        '. Choose again from Project context → Documents.');
    }
    if (failed.length) {
      detailParts.push(failed.length + ' file' + (failed.length === 1 ? '' : 's') +
        ' could not be saved: ' + failed.join(' · '));
    }
    if (f.mode === 'create') {
      // ── PHASE 2 TAKES THE SLOT (P1-10) ──────────────────────────────────
      // The form is replaced by its own outcome rather than dismissed in
      // favour of a banner at the top of the page, because the create is the
      // one action of the three that leaves WORK beside its fact: a marker
      // line and an instructions block, both pasted somewhere else, and a
      // navigation to the screen where the documents are added. A banner
      // cannot hold a control.
      //
      // `outcomeDetail` reads the SERVER'S answer (`chooserOutcomeWords`),
      // never the request, so a create that asked for four skeletons and got
      // three says three.
      state.projectLc = {
        mode: 'created', slug, project: (f.name || '').trim(),
        outcomeDetail: createdOutcomeDetail(body, imported),
        outcomeRefusal: detailParts.length ? detailParts.join(' ') : null,
        // WHAT THE STORE WOULD NOT COPY, carried through verbatim. Read off
        // the SERVER'S answer — it is the only place the reason exists — and
        // never assembled here from the request, which knows what was asked
        // and nothing about why one item was declined.
        outcomeRefused: body && body.refresh && Array.isArray(body.refresh.refused)
          ? body.refresh.refused : [],
        busy: false, error: null, refusal: null, foundations: null,
      };
      state.banner = null;
    } else {
      state.projectLc = null;
      state.banner = {
        tone: (fndErr || failed.length) ? 'info' : 'success',
        // The trailing stop is added ONCE, here, after the outcome clause: the
        // three `successText` literals above are sentences, and appending a
        // clause to a finished sentence is how "Renamed “a” to “b”.." ships.
        text: successText.replace(/\.$/, '') + words + '.',
        // NEVER FOLDED, and on its own line rather than appended to the
        // sentence: a refusal is not a suffix to a success (v3.16.1).
        detail: detailParts.length ? detailParts.join(' ') : null,
      };
    }
    succeeded = true;
  } catch (err) {
    if (!isCurrentMount(token)) return;
    const c = classifyProjectError(err);
    if (state.projectLc) { state.projectLc.error = c.error; state.projectLc.refusal = c.refusal; }
  } finally {
    releaseGate();   // unconditional — a stale mount must not leak the gate
    if (state.projectLc) state.projectLc.busy = false;
  }

  if (!isCurrentMount(token)) return;
  if (succeeded) {
    // Re-read rather than patching the row in place: rename and delete both
    // change what the store reports about every remaining project's
    // ordering, and a hand-patched list is a second description of the same
    // data, free to disagree with the server's.
    await loadProjects(slug, token);
  } else {
    render(token);
    revealMessage('.dm-lc-refusal, .dm-lc-error');
  }
}

/**
 * Copy `domain/project` for a `.curator-project` marker file.
 *
 * WHAT THE MARKER IS FOR: an agent starting in a repository reads it and
 * knows which project to resume, instead of guessing or asking. It is a
 * SKILL-level convention — no server code reads this file — so the only
 * thing the app owes it is the exact line, which is why this copies rather
 * than explains.
 *
 * `navigator.clipboard` is unavailable on a non-secure origin and can be
 * refused outright, so the failure path prints the line instead of leaving
 * the user with a button that silently did nothing.
 */
async function copyProjectMarker(project) {
  return copyForProject(project, 'marker');
}

/**
 * Copy the harness-neutral working-state block for `project`.
 *
 * WHAT IT IS FOR, and why it is not the marker: measured on 2026-09-10, an
 * agent on Claude Code with the `curator-continuity` skill installed and
 * listed activated it in 0 of 4 headless runs and therefore never read state
 * and never saved; with this block in the file that harness loads every
 * session, 3 of 4 runs read at start and saved before stopping. On opencode,
 * which activates the skill natively, the block changed nothing (4/4 either
 * way). So this button exists for the harnesses that do not self-activate —
 * and the block, unlike a skill, is just text in a file every one of them
 * already reads. N=4, one task, one model: a shape, not a rate.
 *
 * The TEXT is not composed here — see shared/agent-instructions.js.
 */
async function copyProjectAgentInstructions(project) {
  return copyForProject(project, 'agent');
}

/**
 * The shared body of both copy actions.
 *
 * `state.activeSlug` is read ONCE, before the await, and the composed text is
 * captured with it: everything after the await re-checks the mount, so a
 * domain switch mid-copy cannot label another domain's confirmation with this
 * project's name.
 */
async function copyForProject(project, kind) {
  const domain = state.activeSlug;
  const text = kind === 'agent'
    ? composeAgentInstructionsFull({ domain, project })
    : domain + '/' + project;
  const token = myMountToken;
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch { ok = false; }
  if (!isCurrentMount(token)) return;
  state.copied = { kind, project, ok, text };
  render(token);
}

function bindProjectListeners() {
  // ── BOUND ONCE PER NODE (v3.64.1) ──────────────────────────────────────
  // setMain patches the column now: a section whose markup did not move keeps
  // its NODE, and therefore keeps the listeners bound to it on an earlier
  // paint. This pass runs after every paint, so without this guard a cold
  // domain switch — one paint on the switch and one as each of health,
  // projects and the page list lands — would leave FOUR click listeners on
  // every control that did not move. Most are idempotent; `Show more` and
  // `Rescan` are not, and four rescans is four HTTP requests.
  //
  // THE MARK IS AN EXPANDO, NEVER AN ATTRIBUTE, and that is load-bearing: a
  // `data-*` mark would show up in the live node's `outerHTML` and never in
  // the freshly-composed one, so the patch's byte comparison would find every
  // marked section different and replace it on every paint — the guard would
  // silently re-create the defect it exists to prevent.
  //
  // THE INVARIANT THIS GUARD RESTS ON: every element this function binds
  // lives inside `.dm-projects`, which is a top-level child of the column and is
  // therefore replaced whole or not at all. A listener added here for a
  // target OUTSIDE that section would be skipped once the section stopped
  // moving. scripts/test-next-domain-sections.js drives a patched repaint and
  // asserts each control fires exactly once, which is the property rather
  // than the rule.
  // `typeof` GUARDED, and that is not defensive dressing: three suites lift
  // these functions and execute them against a hand-written `document` that
  // has getElementById and querySelectorAll and NO querySelector, so an
  // unguarded call is a CRASH in a suite rather than a failing assertion —
  // the shape this file warns about. A stand-in with no querySelector simply
  // binds every time, which is what it did before this guard existed.
  const boundScope = typeof document.querySelector === 'function'
    ? document.querySelector('.dm-projects') : null;
  if (boundScope) {
    if (boundScope.__dmBound) return;
    boundScope.__dmBound = true;
  }
  document.getElementById('dm-proj-new-btn')
    ?.addEventListener('click', () => openProjectLifecycle('create'));

  document.querySelectorAll('[data-proj-rename]').forEach((btn) => {
    btn.addEventListener('click', () => openProjectLifecycle('rename', btn.dataset.projRename));
  });
  document.querySelectorAll('[data-proj-delete]').forEach((btn) => {
    btn.addEventListener('click', () => openProjectLifecycle('delete', btn.dataset.projDelete));
  });
  document.querySelectorAll('[data-proj-marker]').forEach((btn) => {
    btn.addEventListener('click', () => {
      copyProjectMarker(btn.dataset.projMarker).catch(reportAsyncActionFailure);
    });
  });
  document.querySelectorAll('[data-proj-agent]').forEach((btn) => {
    btn.addEventListener('click', () => {
      copyProjectAgentInstructions(btn.dataset.projAgent).catch(reportAsyncActionFailure);
    });
  });

  const f = state.projectLc;
  if (!f) return;
  document.getElementById('dm-proj-cancel')?.addEventListener('click', closeProjectLifecycle);

  // ── "Open in Project context" (P1-10) ──────────────────────────────────
  // The request is recorded BEFORE the navigation, because the destination
  // consumes it during its own mount — which `navigate` starts synchronously.
  // Both are one gesture and neither is a write.
  document.getElementById('dm-proj-open-memory')?.addEventListener('click', () => {
    requestProject(f.slug, f.project);
    state.projectLc = null;
    shell.navigate('memory');
  });

  // Written straight into state on every keystroke, WITHOUT a re-render, so
  // the caret survives — the same rule bindLifecycleListeners follows. That
  // includes the delete confirmation, and the exception this block used to
  // carve out for it was the defect:
  //
  // ── THE TYPED CONFIRMATION COULD NOT BE TYPED ────────────────────────────
  // It called render() on every keystroke because its value GATES the submit
  // button. render() replaces `#view-root`'s innerHTML, so the input the user
  // was typing into was destroyed by the FIRST character; `document
  // .activeElement` fell back to <body> and every later keystroke went
  // nowhere. The button therefore never enabled and the project could not be
  // deleted from the app at all — found by driving the real Electron app.
  //
  // The repaint was never needed. The ONLY thing this field changes on screen
  // is that one button's disabled state, so this sets exactly that, on the
  // LIVE node, and the input is never rebuilt. (`#dm-browse-filter` genuinely
  // must repaint — it filters a list — and pays for it with the focus/caret
  // restore this field no longer needs.)
  const nameEl = document.getElementById('dm-proj-name');
  nameEl?.addEventListener('input', () => { f.name = nameEl.value; });
  const briefEl = document.getElementById('dm-proj-brief');
  briefEl?.addEventListener('input', () => { f.brief = briefEl.value; });
  const confirmEl = document.getElementById('dm-proj-confirm');
  confirmEl?.addEventListener('input', () => {
    f.confirmText = confirmEl.value;
    const gated = document.getElementById('dm-proj-submit');
    // The SAME predicate renderProjectLifecycleCard uses, so a repaint from
    // any other cause agrees with what this handler last painted.
    if (gated) gated.disabled = !!f.busy || f.confirmText !== f.project;
  });

  // ── THE DOCUMENTS CHOOSER (v3.61.0) ─────────────────────────────────────
  // The shared module owns the markup and every control's behaviour; this view
  // owns only WHERE the state lives and WHEN to repaint. `f.foundations` is
  // the same object `chooserBody` reads at submit time, so what is on screen
  // and what crosses the wire cannot describe two different choices.
  if (f.foundations) {
    bindFoundationsChooser({
      doc: document,
      id: 'dm-proj-fnd',
      choice: f.foundations,
      onChange: () => render(myMountToken),
      onFailure: reportAsyncActionFailure,
    });
  }

  const submit = document.getElementById('dm-proj-submit');
  submit?.addEventListener('click', () => {
    Promise.resolve().then(() => runProjectAction()).catch(reportAsyncActionFailure);
  });
  // Enter submits the two text forms. Delete deliberately has no keyboard
  // shortcut — it is the action with no undo, and the typed confirmation
  // exists precisely to make it slower.
  if (f.mode !== 'delete') {
    nameEl?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit?.click(); }
    });
  }
}

function bindLifecycleListeners() {
  const f = state.lifecycle;
  if (!f) return;
  // ── BOUND ONCE PER NODE (v3.64.1) — see bindStatCardListeners. The card is
  // a top-level child of the column under `.dm-lc-card`, so its survival is
  // exactly the condition under which its listeners are still attached. The
  // submit handlers here POST, so a duplicate is a duplicate create/rename/
  // delete request.
  // `typeof` GUARDED, and that is not defensive dressing: three suites lift
  // these functions and execute them against a hand-written `document` that
  // has getElementById and querySelectorAll and NO querySelector, so an
  // unguarded call is a CRASH in a suite rather than a failing assertion —
  // the shape this file warns about. A stand-in with no querySelector simply
  // binds every time, which is what it did before this guard existed.
  const boundScope = typeof document.querySelector === 'function'
    ? document.querySelector('.dm-lc-card') : null;
  if (boundScope) {
    if (boundScope.__dmBound) return;
    boundScope.__dmBound = true;
  }
  document.getElementById('dm-lc-cancel')?.addEventListener('click', closeLifecycle);

  const nameEl = document.getElementById('dm-lc-name');
  // Written straight into state on every keystroke, WITHOUT a re-render —
  // re-rendering here would rebuild the input and lose the caret. The
  // submit handlers read state, never the DOM, so the two cannot disagree.
  nameEl?.addEventListener('input', () => { f.displayName = nameEl.value; });
  const descEl = document.getElementById('dm-lc-desc');
  descEl?.addEventListener('input', () => { f.description = descEl.value; });

  document.querySelectorAll('.dm-lc-template[data-template]').forEach((btn) => {
    btn.addEventListener('click', () => { f.template = btn.dataset.template; render(myMountToken); });
  });

  const submit = document.getElementById('dm-lc-submit');
  submit?.addEventListener('click', () => {
    const run = f.mode === 'create' ? runCreateDomain : (f.mode === 'rename' ? runRenameDomain : runDeleteDomain);
    Promise.resolve().then(() => run()).catch(reportAsyncActionFailure);
  });
  // Enter submits the two text forms. Delete deliberately has no keyboard
  // shortcut — it is the one action with no undo.
  if (f.mode !== 'delete') {
    nameEl?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit?.click(); }
    });
  }
}

function bindBrowseListeners() {
  // ── BOUND ONCE PER NODE (v3.64.1) ──────────────────────────────────────
  // setMain patches the column now: a section whose markup did not move keeps
  // its NODE, and therefore keeps the listeners bound to it on an earlier
  // paint. This pass runs after every paint, so without this guard a cold
  // domain switch — one paint on the switch and one as each of health,
  // projects and the page list lands — would leave FOUR click listeners on
  // every control that did not move. Most are idempotent; `Show more` and
  // `Rescan` are not, and four rescans is four HTTP requests.
  //
  // THE MARK IS AN EXPANDO, NEVER AN ATTRIBUTE, and that is load-bearing: a
  // `data-*` mark would show up in the live node's `outerHTML` and never in
  // the freshly-composed one, so the patch's byte comparison would find every
  // marked section different and replace it on every paint — the guard would
  // silently re-create the defect it exists to prevent.
  //
  // THE INVARIANT THIS GUARD RESTS ON: every element this function binds
  // lives inside `.dm-pages`, which is a top-level child of the column and is
  // therefore replaced whole or not at all. A listener added here for a
  // target OUTSIDE that section would be skipped once the section stopped
  // moving. scripts/test-next-domain-sections.js drives a patched repaint and
  // asserts each control fires exactly once, which is the property rather
  // than the rule.
  // `typeof` GUARDED, and that is not defensive dressing: three suites lift
  // these functions and execute them against a hand-written `document` that
  // has getElementById and querySelectorAll and NO querySelector, so an
  // unguarded call is a CRASH in a suite rather than a failing assertion —
  // the shape this file warns about. A stand-in with no querySelector simply
  // binds every time, which is what it did before this guard existed.
  const boundScope = typeof document.querySelector === 'function'
    ? document.querySelector('.dm-pages') : null;
  if (boundScope) {
    if (boundScope.__dmBound) return;
    boundScope.__dmBound = true;
  }
  document.getElementById('dm-browse-load-btn')?.addEventListener('click', () => {
    if (!state.activeSlug) return;
    loadBrowse(state.activeSlug, myMountToken).catch(reportAsyncActionFailure);
  });

  const filterEl = document.getElementById('dm-browse-filter');
  if (filterEl) {
    filterEl.addEventListener('input', () => {
      const b = activeBrowse();
      if (!b) return;
      b.filter = filterEl.value;
      // THE WINDOW RESETS WITH THE QUERY. It counts rows of a SPECIFIC match
      // set; carrying 600 across to a new query would paint 600 rows of a
      // list the user has just narrowed to 12, and would make "Showing 600 of
      // 12" expressible.
      b.window = BROWSE_RENDER_CAP;
      // Re-render repaints the input, so restore focus + caret. Keeping the
      // list in sync with the box on every keystroke is the whole point of
      // holding all entries in memory.
      const caret = filterEl.selectionStart;
      render(myMountToken);
      const again = document.getElementById('dm-browse-filter');
      if (again) { again.focus(); try { again.setSelectionRange(caret, caret); } catch { /* not all inputs support it */ } }
    });
  }

  document.querySelectorAll('.dm-browse-tab[data-browse-folder]').forEach((btn) => {
    btn.addEventListener('click', () => {
      // The chip is unchanged in behaviour and ONE line better: it goes
      // through the same helper the OVERVIEW tile uses, so the two controls
      // over one filter state cannot drift, and it now hands focus back to
      // itself after the repaint instead of dropping it on <body> (the
      // v3.17.1 defect, which this row has carried since it shipped). It does
      // NOT scroll — pressing a chip means you are already looking at the
      // list it filters.
      selectBrowseFacet(btn.dataset.browseFolder, {
        scroll: false,
        refocus: '.dm-browse-tab[data-browse-folder="' + btn.dataset.browseFolder + '"]',
      });
    });
  });

  // THE LENS CHIPS (v3.64.0). Same shape as the facet chips directly below
  // them, same single write path, and the same refocus-after-repaint — a
  // press must not drop focus on <body>, which is the v3.17.1 defect this
  // row's neighbour carried until v3.58.0.
  document.querySelectorAll('.dm-lens-chip[data-browse-lens]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const lens = btn.dataset.browseLens;
      // The lens also moves the TYPE facet, because the two are one
      // selection: Context is the memory facet, and Wiki/All release it.
      const b = activeBrowse();
      const facet = lens === 'context'
        ? 'memory'
        : ((b && b.folder && b.folder !== 'memory') ? b.folder : 'all');
      selectBrowseFacet(facet, {
        lens,
        scroll: false,
        refocus: '.dm-lens-chip[data-browse-lens="' + lens + '"]',
      });
    });
  });

  bindBrowseRowClicks(document);

  document.getElementById('dm-browse-more')?.addEventListener('click', showMoreBrowseRows);
}

/**
 * Select a facet of the page list — the ONE write path both controls use.
 *
 * The chip row and the OVERVIEW tiles are two affordances over one field
 * (`state.browse.folder`). They write it here, together, so "what does
 * pressing this select?" has a single answer in one place: a second copy of
 * the window reset, or of the mount check, is how the two would come to
 * disagree about what "Entities" means.
 *
 * `opts.scroll` brings the Pages section to the top of the scrolling `.main`
 * — for the tile, whose list is a screen further down. `opts.refocus` is a
 * selector re-queried AFTER the repaint, because `render()` replaces the
 * whole column and the node that was pressed no longer exists; focusing with
 * `preventScroll` so the two do not fight over the scroll position.
 */
function selectBrowseFacet(key, opts) {
  const b = activeBrowse();
  if (!b || !key) return;
  const o = opts || {};
  b.folder = key;
  // ── THE LENS RIDES THE SAME WRITE PATH (v3.64.0) ──────────────────────
  // A lens chip is a facet press that ALSO moves the outer reading, so it
  // goes through this function rather than beside it: one place writes the
  // list's selection, which is what stops the chips, the tiles and the lens
  // from ever disagreeing about what is on screen.
  if (o.lens === 'wiki' || o.lens === 'context' || o.lens === 'all') {
    b.lens = o.lens;
    // ── THE KEY IS A LITERAL HERE, ON PURPOSE ───────────────────────────
    // This function is LIFTED by brace-matching into two suite sandboxes
    // and executed there, so naming a module-level helper (or the
    // SECTION_PREFS_KEY constant) would be a ReferenceError — a crash
    // instead of a failing assertion, which is the shape views/memory.js
    // records for its own duplicated fold key. The literal is pinned equal
    // to SECTION_PREFS_KEY by scripts/test-next-domain-sections.js.
    // `localStorage` is undefined in those sandboxes and THROWS in a private
    // window; both land in the same catch, and a store that cannot be
    // written simply forgets.
    try {
      if (!state.sectionPrefs || typeof state.sectionPrefs !== 'object') state.sectionPrefs = {};
      state.sectionPrefs.lens = o.lens;
      // THE ROW KEY IS A LITERAL HERE TOO, and for the same sandbox reason as
      // the key beside it; both are pinned against their constants by
      // scripts/test-next-domain-sections.js.
      localStorage.setItem('curator-domain-sections-v1',
        JSON.stringify({ '*': state.sectionPrefs }));
    } catch { /* private window, blocked site data, quota — the app forgets */ }
  }
  // A facet change is a different match set, so the window resets with it —
  // the same rule and the same reason as the filter box above.
  b.window = BROWSE_RENDER_CAP;
  render(myMountToken);
  if (o.refocus) {
    const again = document.querySelector(o.refocus);
    if (again && typeof again.focus === 'function') {
      try { again.focus({ preventScroll: true }); } catch { again.focus(); }
    }
  }
  if (o.scroll) scrollSectionIntoView('.dm-pages');
}

/**
 * Bring one of this card's sections to the top of the scrolling region.
 *
 * `behavior` is chosen rather than left to the browser: `scrollIntoView`'s
 * smooth scroll does NOT consult `prefers-reduced-motion` on its own, so a
 * user who has asked for no motion would get a 500px glide anyway. This is
 * the one place in this file that reads the query directly — it is a
 * scripted animation, not a CSS one, so tokens/motion.css's zeroed `--dur-*`
 * cannot reach it.
 */
/**
 * Bring a section's head into view AND move focus to its title (v3.65.2) —
 * what the onboarding deep link and the SOURCES jump tile do for ① Ingest,
 * now that there is no fold to open. The title carries `tabindex="-1"` so it
 * can take focus without joining the tab order; `preventScroll` because the
 * smooth scroll above is the one movement the reader should see.
 */
function landOnSection(selector, titleId) {
  scrollSectionIntoView(selector);
  if (typeof document === 'undefined' || !document.getElementById) return;
  const t = document.getElementById(titleId);
  if (t && typeof t.focus === 'function') {
    try { t.focus({ preventScroll: true }); } catch { /* an old engine without the option */ }
  }
}

function scrollSectionIntoView(selector) {
  const el = document.querySelector(selector);
  if (!el || typeof el.scrollIntoView !== 'function') return;
  let reduce = false;
  try {
    reduce = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch { reduce = false; }
  el.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
}

/**
 * The OVERVIEW figures, wired. See renderStatCards for why they are controls.
 */
function bindStatCardListeners() {
  // ── BOUND ONCE PER NODE (v3.64.1) ──────────────────────────────────────
  // setMain patches the column now: a section whose markup did not move keeps
  // its NODE, and therefore keeps the listeners bound to it on an earlier
  // paint. This pass runs after every paint, so without this guard a cold
  // domain switch — one paint on the switch and one as each of health,
  // projects and the page list lands — would leave FOUR click listeners on
  // every control that did not move. Most are idempotent; `Show more` and
  // `Rescan` are not, and four rescans is four HTTP requests.
  //
  // THE MARK IS AN EXPANDO, NEVER AN ATTRIBUTE, and that is load-bearing: a
  // `data-*` mark would show up in the live node's `outerHTML` and never in
  // the freshly-composed one, so the patch's byte comparison would find every
  // marked section different and replace it on every paint — the guard would
  // silently re-create the defect it exists to prevent.
  //
  // THE INVARIANT THIS GUARD RESTS ON: every element this function binds
  // lives inside `.dm-overview`, which is a top-level child of the column and is
  // therefore replaced whole or not at all. A listener added here for a
  // target OUTSIDE that section would be skipped once the section stopped
  // moving. scripts/test-next-domain-sections.js drives a patched repaint and
  // asserts each control fires exactly once, which is the property rather
  // than the rule.
  // `typeof` GUARDED, and that is not defensive dressing: three suites lift
  // these functions and execute them against a hand-written `document` that
  // has getElementById and querySelectorAll and NO querySelector, so an
  // unguarded call is a CRASH in a suite rather than a failing assertion —
  // the shape this file warns about. A stand-in with no querySelector simply
  // binds every time, which is what it did before this guard existed.
  const boundScope = typeof document.querySelector === 'function'
    ? document.querySelector('.dm-overview') : null;
  if (boundScope) {
    if (boundScope.__dmBound) return;
    boundScope.__dmBound = true;
  }
  document.querySelectorAll('.dm-stat-card[data-stat-facet]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.statFacet;
      selectBrowseFacet(key, {
        scroll: true,
        refocus: '.dm-stat-card[data-stat-facet="' + key + '"]',
      });
    });
  });
  // ── THE JUMPS. PROJECTS only scrolls, so it neither writes state nor
  // re-renders — which is why it keeps its own focus for free. The two
  // v3.64.0 tiles OPEN a fold as well as scrolling to it, because a jump to
  // a closed section would land the reader on a summary line and leave them
  // to find the disclosure triangle.
  //
  // `querySelectorAll` over the attribute, not `querySelector` on one class:
  // until this release there was exactly one jump and the selector said so,
  // which would have silently bound the first of three.
  document.querySelectorAll('[data-stat-jump]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const where = btn.dataset.statJump;
      if (where === 'projects') { scrollSectionIntoView('.dm-projects'); return; }
      if (where === 'sources' || where === 'shared') openSectionFold(where);
    });
  });
}

/**
 * Wires the click handlers for the rows inside `root`.
 *
 * `root` is the DOCUMENT on a full paint and the newly-appended FRAGMENT on a
 * "Show 150 more" — which is the whole reason it is a parameter. Re-scanning
 * the document after an append would re-bind every row already on screen, and
 * a second listener on a row opens the reader twice.
 */
function bindBrowseRowClicks(root) {
  root.querySelectorAll('.dm-browse-row[data-browse-path]').forEach((btn) => {
    btn.addEventListener('click', () => {
      Promise.resolve()
        .then(() => openWikiPageFromBrowse(btn.dataset.browsePath, btn.dataset.browseTitle))
        .catch(reportAsyncActionFailure);
    });
  });
  root.querySelectorAll('.dm-browse-row[data-mem-path]').forEach((btn) => {
    btn.addEventListener('click', () => {
      Promise.resolve()
        .then(() => openMemoryPageFromBrowse({
          kind: btn.dataset.memKind,
          project: btn.dataset.memProject,
          scope: btn.dataset.memScope,
          machine: btn.dataset.memMachine,
          slug: btn.dataset.memSlug,
          title: btn.dataset.memTitle,
          path: btn.dataset.memPath,
        }))
        .catch(reportAsyncActionFailure);
    });
  });
}

/**
 * Paints the NEXT window of rows — by APPENDING them, not by re-rendering.
 *
 * ── WHY APPEND ──────────────────────────────────────────────────────────
 * A full render() replaces `#view-root`'s innerHTML. On this list that costs
 * three things a person notices: the scroll position of `.dm-browse-list`
 * jumps back to the top (so pressing "Show more" would throw away the place
 * you were reading), the filter input is destroyed and re-created, and every
 * row already on screen is re-parsed. Appending keeps the scroll position by
 * construction — the rows above the button do not move — and touches only the
 * nodes that are new.
 *
 * The button is REPLACED rather than left and hidden, because it is the list's
 * last row and a hidden row still occupies the separator above it. When
 * nothing is left it goes, and the note goes with it.
 *
 * `state.browse.window` is still the single source of truth: a later full
 * render (a domain reload, a facet change) paints exactly what is on screen
 * now, so the two paths cannot disagree about how much is shown.
 */
function showMoreBrowseRows() {
  const b = activeBrowse();
  if (!b) return;
  const list = document.getElementById('dm-browse-list');
  const moreBtn = document.getElementById('dm-browse-more');
  if (!list || !moreBtn) return;

  const { items } = browseMatches(b);
  const from = browseWindow(b);
  const to = Math.min(items.length, from + BROWSE_RENDER_CAP);
  if (to <= from) { moreBtn.remove(); return; }

  const html = items.slice(from, to)
    .map((e) => (e && e.kind ? memoryRowHtml(e) : browseRowHtml(e))).join('');
  const before = list.children.length;
  list.insertAdjacentHTML('beforeend', html);
  b.window = to;

  // Bind ONLY what was just inserted — see bindBrowseRowClicks. Taken as the
  // tail of the list by INDEX rather than by counting backwards from a
  // sibling, so a row the painter ever renders as two elements cannot make
  // this bind the wrong set.
  const added = Array.prototype.slice.call(list.children, before);
  bindBrowseRowClicks({
    querySelectorAll: (sel) => added.filter((el) => el.matches && el.matches(sel)),
  });

  const note = document.getElementById('dm-browse-note');
  if (to >= items.length) {
    moreBtn.remove();
    if (note) note.remove();
  } else {
    const label = moreBtn.querySelector('.dm-browse-more-label');
    const step = Math.min(BROWSE_RENDER_CAP, items.length - to);
    if (label) label.textContent = 'Show ' + step.toLocaleString() + ' more';
    if (note) note.textContent = 'Showing ' + to.toLocaleString() + ' of ' + items.length.toLocaleString();
  }
}

// ── Health panel ───────────────────────────────────────────────────────────

/**
 * The health header's action, labelled by whether there is a scan to RE-do.
 *
 * ── THE DEFECT, reported by a power user ─────────────────────────────────
 * The button said "Rescan" in every state, including the one where nothing
 * had ever been scanned — a word that asks the reader to remember a scan
 * that never happened, on the screen where they are trying to work out what
 * this panel even is.
 *
 * ── WHERE IT IS ACTUALLY REACHABLE, stated so this is not read as wider
 * than it is ─────────────────────────────────────────────────────────────
 * Entering the view and switching domains both run a scan on their own
 * (loadDomainsList -> loadHealth, and selectDomain -> loadHealth), and
 * GET /api/health/:domain really scans rather than returning a cached
 * report — so by the time the READOUT branch paints, a scan for this domain
 * genuinely has completed and "Rescan" was already the true word there. The
 * branch that was lying is the FAILURE one: a first scan that errors leaves
 * no result at all, and the button under the error offered to redo it.
 *
 * So the label is derived from the one fact that separates the two, in one
 * place, for both branches — rather than being right in one of them by
 * accident. A failure that follows a SUCCESSFUL scan of the same domain
 * still reads "Rescan", because in that case a result does exist; the panel
 * is simply showing the error instead of it.
 *
 * Pure, and lifted by the suite.
 */
function healthScanLabel(hasResult) {
  return hasResult
    ? icon('refresh', 13) + ' Rescan'
    : icon('activity', 13) + ' Scan wiki health';
}

/**
 * The Wiki health section's wrapper — a `.dm-section` with its own eyebrow,
 * like the three above it.
 *
 * ── WHY THE WORD APPEARS TWICE, and why that is the right call ──────────
 * The card keeps its own head (`Wiki health` beside the activity icon and the
 * Rescan button) because that head is the card's TITLE BAR: it carries the
 * action, and the two belong to each other. The eyebrow above it names the
 * SECTION, which is what makes the four sections on this card scannable as
 * four. That is the same decision v3.49.0 recorded for the stat cards' `PAGES`
 * eyebrow sitting above the list's `PAGES · THE WIKI` — naming both is what
 * makes the summary and the thing itself distinguishable at a glance.
 *
 * An EMPTY body renders nothing at all, eyebrow included: renderHealthPanel
 * returns '' when there is no report, and a section heading over nothing is a
 * gap that looks like a failure.
 */
function healthSection(inner) {
  if (!inner) return '';
  return (
    '<section class="dm-section dm-health">' +
      '<div class="dm-section-hd">' +
        '<span class="dm-section-num" aria-hidden="true">5</span>' +
        '<div class="cur-group-title dm-section-eyebrow">Wiki health</div>' +
      '</div>' +
      inner +
    '</section>'
  );
}

function renderHealthPanel(domain, readonly) {
  // Stale-while-revalidate — LAYER 2, independent of LAYER 1 in
  // shouldKeepHealthOnReload. A report is usable here ONLY if it was
  // scanned for the domain being rendered; anything else is treated as if
  // there were no report at all. This layer is what makes it impossible to
  // paint one domain's issue counts under another's heading, and it must
  // keep working even if LAYER 1 is ever changed or forgotten.
  const usable = shouldKeepHealthOnReload(state.health, state.healthSlug, domain.slug);
  const revalidating = state.healthLoading && usable;

  // Only collapse to "Scanning…" when there is genuinely nothing to show.
  // A rescan behind a report we already have keeps that report on screen.
  if (state.healthLoading && !usable) {
    // ── THE SCAN'S PLACEHOLDER HOLDS THE CARD'S HEIGHT ──────────────────
    //
    // WHY THIS PANEL GETS A RESERVE AND NOT A CACHE, stated because the page
    // list beside it got the opposite treatment. `selectDomain` passes NO
    // keep flag to loadHealth, so a domain switch always clears the report —
    // and that is a SAFETY PROPERTY with a guard of its own
    // (scripts/test-next-loading-gate.js §7b), not an oversight: showing one
    // domain's issue counts under another's heading is a correctness bug,
    // and the figures here are ones a user acts on. So the report is genuinely
    // re-scanned on every switch, honestly says "Scanning…" while it is, and
    // what is removed is only the LAYOUT JUMP — measured at 89 px against a
    // filled card of 452 px (articles) and 333 px (projects), held for
    // 380-800 ms because GET /api/health/:domain is a whole-tree scan with no
    // cache (measured 753-788 ms on 3,445 pages, three consecutive calls).
    //
    // The `.dm-health-body` line itself is byte-pinned by that same suite as a
    // measured exemption from the delay-gate rule. Only the card around it
    // gains the reserved height.
    const reserve = state.reserve && state.reserve.health;
    return healthSection(
      '<div class="dm-health-card" aria-busy="true"' +
        (reserve ? ' style="min-height:' + reserve + 'px"' : '') + '>' +
        // ── THE CARD NO LONGER TITLES ITSELF (v3.64.2) ──────────────────
        // "⑤ Wiki health" is written directly above this card by
        // `healthSection`, at the same x and in the same face as the other
        // four section headings. A second "Wiki health" inside the card was
        // the same words twice, eight pixels apart. This branch has no
        // control in its head row either, so the row goes with the title.
        '<div class="dm-health-body">Scanning…</div>' +
      '</div>'
    );
  }
  if (state.healthError) {
    return healthSection(
      '<div class="dm-health-card">' +
        '<div class="dm-health-top">' +
          // The title is the SECTION's (see the loading branch); this row
          // exists for its one control.
          // `usable` is the same predicate the readout branch uses: it is
          // true only when a report for THIS domain is in hand. A first
          // scan that failed leaves none, and this is the branch where the
          // old always-"Rescan" label was actually wrong.
          '<button class="btn btn-secondary" id="dm-rescan-btn">' + healthScanLabel(usable) + '</button>' +
        '</div>' +
        // Third meaning of `.dm-health-body`, after the loading placeholder
        // above and the readout below: a runtime error. It is a STATE, so it
        // is renderStatus, and the server's message is the DETAIL rather than
        // being glued onto the end of our sentence with an em dash.
        renderStatus({ state: 'danger', title: 'Could not scan this domain', detail: state.healthError }) +
      '</div>'
    );
  }
  const report = usable ? state.health : null;
  if (!report) return '';

  const total = totalOpenIssues(report);
  const busy = state.busyKey;
  // MEDIUM-5 fix: a write against THIS domain started by an earlier,
  // already-abandoned mount that hasn't actually finished on disk yet.
  // Distinct from `busy` (this mount's OWN action, reset on unmount) —
  // this one tracks the real backend operation and survives remounts.
  const crossMountBusy = inFlightWriteSlugs.has(domain.slug);

  const chips = HEALTH_CATEGORIES.map((cat) => {
    const count = (report[cat.key] || []).length;
    const cls = count === 0 ? 'dm-chip-zero' : (cat.violet ? 'dm-chip-violet' : 'dm-chip-amber');
    return '<span class="dm-chip ' + cls + '">' + escapeHtml(cat.label) + ' <span class="dm-chip-count">' + count + '</span></span>';
  }).join('');

  // ── THE READOUT ──────────────────────────────────────────────────────────
  // This is the block the maintainer reported: it "doesn't look like a report
  // — it looks like a clarification". It was ONE prose <div> welding an action
  // report ("Re-scanning… showing the previous result.") to a generated
  // measurement ("Found 12 issues, last scanned 10s ago") to a static feature
  // description, plus a SECOND <div class="dm-health-meta"> carrying four more
  // measurements at --text-3 — 4.27 dark / 4.14 light, under the 4.5 AA floor.
  // Three roles, one voice, and the most valuable figures on the screen were
  // the least readable ones.
  //
  // ABSENT IS NOT ZERO, and it is not decorative here. `relTime(undefined)`
  // returns the string 'never', so a report with no `scannedAt` used to render
  // "last scanned never." — a claim about when a scan happened, made from the
  // absence of the field that would say. As a readout the provenance is simply
  // OMITTED instead, which is text.js's rule and is asserted by mutation.
  // `report.counts.dismissed` behaves the same way: a missing count used to
  // render the literal "undefined dismissed", and now drops its entry. A real
  // 0 is a measurement and still renders.
  // ── THE SCAN'S REPORT IS A MONITOR (v3.65.0, catalogue entry M6) ────────
  // It was a five-cell `renderReadoutGroup` with a chip row beneath it, and
  // the maintainer put it beside the bridge's Connected strip and Context's
  // Last saved block and asked why one idea had three designs. It is the same
  // instrument as those now: mono face, a recessed surface, one fact per
  // line, key left and value right, and the freshness dot on the only
  // time-based reading with the age in WORDS beside it.
  //
  // ABSENT IS NOT ZERO, and the monitor keeps the rule the readout group had:
  // `relTime(undefined)` returns the string 'never', so a report with no
  // `scannedAt` used to render "last scanned never." — a claim about when a
  // scan happened, made from the absence of the field that would say. A line
  // whose value is `undefined` is DROPPED by the component (`scalar()`
  // returns null), so `report.counts.dismissed` behaves the same way: a
  // missing count renders no line, while a real 0 is a measurement and does.
  const scannedSec = report.scannedAt
    ? Math.max(0, (Date.now() - new Date(report.scannedAt).getTime()) / 1000) : null;
  const healthMonitor = renderMonitor({
    label: 'Wiki health scan',
    lines: [
      { key: total === 1 ? 'open issue' : 'open issues', value: total,
        // TONE ON THE FIGURE, not a word painted red: the monitor puts a tone
        // on a MARK or a rule, never on text, because --attention-text fails
        // the 4.5 floor as words on that surface in the light theme.
        tone: total > 0 ? 'warn' : undefined },
      { key: 'entities', value: report.counts.entities },
      { key: 'concepts', value: report.counts.concepts },
      { key: 'summaries', value: report.counts.summaries },
      { key: 'dismissed', value: report.counts.dismissed, tone: 'quiet' },
      ...(report.scannedAt
        ? [{ key: 'scanned', value: relTime(report.scannedAt),
             markHtml: '<span class="fresh-dot fresh-' + freshnessTier(scannedSec) +
               '" aria-hidden="true"></span>' }]
        : []),
    ],
  });

  // ── AND IT SITS IN A ROW, LIKE EVERYTHING ELSE IN THIS SECTION ──────────
  // THE STEP-BODY RULE (v3.64.2), applied to the remainder v3.64.2 listed and
  // did not ship. Wiki health's body was a head row, then a bare readout
  // block, then a bare chip row, then an action bar, then folds — five
  // treatments. The counts and the chips are ONE fold row now, whose summary
  // carries the reading that decides whether to open it, and the issue lists
  // below it were already rows.
  //
  // CLOSED BY DEFAULT, which is the same call step ③ Knowledge made in
  // v3.64.2: the headline IS the reading, and the breakdown is the dive-in.
  // `.dm-group` rather than `.dm-fold` because this row lives INSIDE the
  // health card — `.dm-fold` is the card-level fold two of this page's
  // sections are, and a card inside a card is two objects where the design
  // has one.
  //
  // WHAT STAYS OUTSIDE IT, and this is v3.16.1 unmoved: the revalidating
  // caveat below, every banner, every confirm, every plan and the whole Quick
  // maintenance bar. A warning, a COST or an outcome may never sit behind a
  // chevron, and that bar carries a price on every button.
  const scanOpen = state.expandedGroups.has('scan');
  const scanRow =
    '<details class="dm-group dm-group-scan"' + (scanOpen ? ' open' : '') + ' data-group-key="scan">' +
      '<summary class="dm-group-summary">' +
        icon('chevronRight', 13) +
        '<span class="dm-group-label">Scan</span>' +
        '<span class="dm-group-meta">' +
          escapeHtml(pluralize(total, 'open issue') +
            (report.scannedAt ? ' · ' + relTime(report.scannedAt) : '')) +
        '</span>' +
      '</summary>' +
      '<div class="dm-group-body dm-scan-body">' +
        healthMonitor +
        '<div class="dm-chip-row">' + chips + '</div>' +
      '</div>' +
    '</details>';

  // Same one-shot token as the page list's, same reason: a report that lands
  // after a 750 ms scan has missed the view-enter animation entirely, so it
  // fades in on the fill that replaced the placeholder — and only that one.
  // See renderBrowsePanel for why it is consumed here rather than cleared by
  // the loader.
  const healthRevealKey = domain.slug + ':health';
  let healthRevealCls = '';
  if (state.reveal && state.reveal.key === healthRevealKey && !state.reveal.used) {
    state.reveal.used = true;
    healthRevealCls = ' content-reveal';
  }

  return healthSection(
    '<div class="dm-health-card' + healthRevealCls + '">' +
      '<div class="dm-health-top">' +
        // The title is the SECTION's (see the loading branch); this row
        // exists for its one control.
        '<button class="btn btn-secondary" id="dm-rescan-btn"' + ((busy || revalidating) ? ' disabled' : '') + '>' +
          ((busy === 'rescan' || revalidating) ? buttonRingHtml() + ' Scanning…' : healthScanLabel(!!report)) +
        '</button>' +
      '</div>' +
      // Honesty: while revalidating, these counts are the PREVIOUS scan's.
      // Saying so is the price of not collapsing the panel — the figures
      // stay useful, and nothing claims they are current. It is now a STATUS
      // and sits ABOVE the readouts it qualifies, because a caveat printed
      // after the number it qualifies has already been read too late.
      // The wrapper is this view's, and it exists for spacing ONLY.
      // shared/text.css owns the tx- prefix outright and its suite fails on
      // any tx- name appearing in another stylesheet, so domains.css hangs
      // its margins on `.dm-health-summary` instead of reaching into the
      // component. That is the stricter and better arrangement: a view that
      // cannot name a role's class cannot quietly restyle it either.
      // THE WRAPPER EXISTS ONLY WHEN IT HAS SOMETHING IN IT. It carried the
      // readouts too through v3.64.2, so it was always there; with the
      // figures inside the Scan row it would otherwise be an empty box
      // spending its own 16px bottom margin on nothing.
      (revalidating
        ? '<div class="dm-health-summary">' +
            renderStatus({ state: 'attention', title: 'Re-scanning… showing the previous result',
                           detail: 'The figures below are the last completed scan’s until this one finishes.' }) +
          '</div>'
        : '') +
      '<div class="dm-groups dm-groups-scan">' + scanRow + '</div>' +
      (state.banner ? renderBanner() : '') +
      (readonly ? renderMirrorNote() : renderQuickMaintenance(domain, report, crossMountBusy)) +
      (readonly ? '' : renderAiProgressRing()) +
      (state.confirm ? renderConfirmCard() : '') +
      (state.pendingPlan ? renderPendingPlan(crossMountBusy) : '') +
      (activeSemanticScan() ? renderSemanticScanResult(readonly, crossMountBusy) : '') +
      renderIssueGroups(report, readonly, crossMountBusy) +
    '</div>'
  );
}

function renderBanner() {
  const b = state.banner;
  const cls = b.tone === 'error' ? 'dm-banner-error' : (b.tone === 'info' ? 'dm-banner-info' : 'dm-banner-success');
  const ic = b.tone === 'error' ? icon('alertCircle', 14) : icon('check', 14);
  // ── A SECOND LINE, FOR WHAT PARTLY DID NOT HAPPEN (v3.61.0) ────────────
  // Optional and absent on every existing caller. It exists because a project
  // create can now SUCCEED while its canonical documents were refused — the
  // route discloses that in `foundationsError` rather than failing the whole
  // request, and a refusal appended to the success sentence would read as part
  // of the good news. Its own line, never folded (v3.16.1), inside the same
  // banner because it is the same outcome.
  const detail = typeof b.detail === 'string' && b.detail.trim()
    ? '<span class="dm-banner-detail">' + escapeHtml(b.detail.trim()) + '</span>'
    : '';
  return '<div class="dm-banner ' + cls + '">' + ic +
    '<span>' + escapeHtml(b.text) + detail + '</span></div>';
}

// This sits where the Quick maintenance bar would be, i.e. in the place the
// user looks for the buttons that fix things. It is a STATE — "this domain
// cannot be fixed from here" — not a hint, so it is renderStatus.
//
// TONE IS 'neutral' ON PURPOSE. A mirror being read-only is the ORDINARY
// condition of a mirror, and text.css's own note on the neutral rail is that
// the first-run case "must not be dressed as a problem". The consequence
// half ("fixes here would be overwritten") is the detail, so nothing is
// hidden and nothing is escalated into an alarm the user cannot act on. The
// lock glyph is dropped rather than duplicated: the title row already renders
// a `read-only mirror` pill carrying it.
function renderMirrorNote() {
  return renderStatus({
    title: 'This domain is a read-only Shared Brain mirror',
    detail: 'Fixes here would be overwritten on the next Pull — fix issues in your personal contributing domain, then push from Sync.',
  });
}

// The design's smallest size: 16px, activity-only, inside a button that is
// waiting. No stages and no value — a button has no room for either, and
// the real count (when the server sends one) renders in the ring under the
// action bar. This is liveness and nothing more.
function buttonRingHtml() {
  return progressRingHtml({ value: null, size: 16, center: 'none', className: 'dm-btn-ring' });
}

// ── Live progress for the long Health operations ─────────────────────────
// The SSE streams below already carry real counts and this view used to
// drop them on the floor, listening only for `done` and `error`:
//
//   planBrokenLinkFixes / planOrphanRescue / scanSemanticDuplicates
//                              -> { type:'progress', processed, total }
//   applyBrokenLinkFixes / applyOrphanRescue
//                              -> { type:'progress', done, total }
//   fixSemanticDuplicatesBatch -> { type:'progress', done, total, pair, status }
//
// Two different key names for the same quantity, so read BOTH. A frame
// carrying neither (the merge stream's per-pair outcome frames, which are
// consumed elsewhere for their own purpose) leaves the count untouched
// rather than resetting it to zero.
function noteAiProgress(key, ev) {
  const processed = ev && Number.isFinite(ev.processed) ? ev.processed
    : (ev && Number.isFinite(ev.done) ? ev.done : null);
  const total = ev && Number.isFinite(ev.total) ? ev.total : null;
  if (processed == null || total == null || total <= 0) return;
  state.aiProgress = { key, processed, total };
}

// Human-readable name for whatever busyKey names. Anything unrecognised
// gets a neutral "Working…" rather than a guess — this string sits next to
// a spend gate and must not imply an operation the user did not start.
const BUSY_LABELS = {
  rescan: 'Scanning the wiki…',
  fixSafe: 'Applying the safe repairs…',
  brokenLinksPlan: 'Planning broken-link fixes…',
  orphansPlan: 'Finding homes for orphan pages…',
  brokenLinksApply: 'Rewriting links…',
  orphansApply: 'Linking orphan pages…',
  semanticDupesEstimate: 'Counting candidate pairs…',
  semanticDupesScan: 'Comparing pages for duplicates…',
  semanticMerge: 'Merging duplicate pages…',
};
function busyRingLabel(key) {
  if (!key) return null;
  if (Object.prototype.hasOwnProperty.call(BUSY_LABELS, key)) return BUSY_LABELS[key];
  if (key.indexOf('group:') === 0) return 'Applying fixes…';
  return 'Working…';
}

// The progress ring for whatever Health operation is in flight.
//
// `value` is null — activity only, orbit and nothing else — until the
// server sends a count, and for the operations that never send one at all
// (rescan, fix-all, the per-pair actions). That is deliberate and it is the
// component's whole contract: an empty outer ring beside a turning orbit
// says "running, amount genuinely unknown", which is the truth. Do not
// substitute an elapsed-time-derived percentage here.
function renderAiProgressRing() {
  const key = state.busyKey;
  if (!key) return '';
  // The per-pair actions (preview / merge one / skip) are sub-second and
  // render their own inline button label; a ring would be noise.
  if (key.indexOf('semanticPreview:') === 0 || key.indexOf('semanticMergeOne:') === 0 || key.indexOf('semanticSkip:') === 0) return '';
  const p = state.aiProgress && state.aiProgress.key === key ? state.aiProgress : null;
  const value = p ? ringValueFromCounts(p.processed, p.total) : null;
  const sublabel = p ? (p.processed + ' of ' + p.total) : 'no count reported yet';
  return (
    '<div class="dm-ai-progress">' +
      progressRingHtml({
        value,
        size: 32,
        label: busyRingLabel(key),
        sublabel,
        className: 'dm-ai-progress-ring',
      }) +
    '</div>'
  );
}

function renderQuickMaintenance(domain, report, crossMountBusy) {
  const busy = state.busyKey;
  // MEDIUM-5 fix: disable every DESTRUCTIVE quick-maintenance button (not
  // just the read-only Rescan above) while an earlier, already-abandoned
  // mount's write against this SAME domain is still actually running.
  const disableAll = !!busy || crossMountBusy;
  const items = [];

  const safeTotal = countSafeFixable(report);
  if (safeTotal > 0) {
    items.push(
      '<button class="btn btn-secondary btn-xs dm-quick-btn" data-action="fixSafe"' + (disableAll ? ' disabled' : '') + '>' +
        (busy === 'fixSafe' ? buttonRingHtml() : '') +
        '<span class="dm-quick-label">' + (busy === 'fixSafe' ? 'Fixing…' : 'Fix ' + pluralize(safeTotal, 'safe issue')) + '</span>' +
      '</button>'
    );
  }

  if (state.aiAvailable) {
    const brokenCount = (report.brokenLinks || []).length;
    if (brokenCount > 0) items.push(quickAiButton('brokenLinks', 'Fix ' + pluralize(brokenCount, 'broken link'), busy, crossMountBusy));
    const orphanCount = (report.orphans || []).length;
    if (orphanCount > 0) items.push(quickAiButton('orphans', 'Rescue ' + pluralize(orphanCount, 'orphan'), busy, crossMountBusy));
    // H4 fix: always offered, unlike the two above — there's no free,
    // already-known count to gate this on (see the file-header comment on
    // loadEstimates). The button shows no cost until the user opens it;
    // confirmSemanticScan() fetches the (slow, but token-free) estimate at
    // that point and shows a "no likely duplicates" banner instead of a
    // confirm dialog if candidatePairs turns out to be 0.
    items.push(quickAiButton('semanticDupes', 'Find duplicate pages', busy, crossMountBusy));
  }

  if (items.length === 0) {
    if (!state.aiAvailable) {
      return (
        // Static prose, identical for every user without a key — the
        // DESCRIPTION role. The bare <span> inherited a font-size set on the
        // flex container, which is the untracked-treatment shape the module
        // replaces; .tx-desc is a flex item here and keeps its own type.
        '<div class="dm-quick dm-quick-empty">' +
          '<div class="dm-quick-empty-text">' +
            renderDescription('No structural issues to fix right now. Add an AI provider key in Settings to unlock ' +
              'broken-link resolution, orphan rescue and duplicate-page detection.') +
          '</div>' +
          '<button class="btn btn-secondary dm-quick-settings-btn" id="dm-open-settings-btn">Open Settings</button>' +
        '</div>'
      );
    }
    return '';
  }

  return (
    '<div class="dm-quick">' +
      '<div class="dm-quick-eyebrow cur-eyebrow">' + icon('sparkles', 12) + ' QUICK MAINTENANCE</div>' +
      '<div class="dm-quick-actions">' + items.join('') + '</div>' +
      // Wording nit found during live verification: `crossMountBusy` is
      // true for BOTH "some earlier, abandoned mount's write is still
      // running" AND "this exact mount's own action, which it just
      // started, is running" (inFlightWriteSlugs.add(slug) fires the
      // instant any write starts, including this mount's). Only call it
      // an EARLIER fix when it isn't also this mount's own busyKey —
      // otherwise a user who clicks Fix and never left the view sees
      // "an earlier fix is still running" about the very click they just
      // made, which reads as if something is already wrong.
      //
      // TWO ROLES THAT WERE ONE CLASS PLUS A COLOUR MODIFIER. The busy line is
      // a live STATE and is now a status box; the other is static prose that
      // is identical for every user and is now a description. They were
      // `.dm-quick-note` and `.dm-quick-note.dm-quick-note-busy` — the
      // `.sidebar-hint` defect again, in a second place.
      //
      // THE BUSY LINE WAS ALSO THE WORST CONTRAST IN THIS VIEW: it painted
      // --attention-text as TEXT over --accent-tint, measured 3.16:1 in the
      // light theme against a 4.5 floor. That is a warning about an in-flight
      // write, printed directly above the buttons that delete pages, and it
      // was the least readable string on the panel. As a status the amber is
      // the RAIL (non-text, 3:1 floor, clears at 10.70 / 3.58) and the words
      // are --text / --text-2.
      //
      // NEITHER IS FOLDED. renderExplainer was not used here and must not be:
      // the cost promise and the git-recovery note are the disclosure that
      // makes a spend gate a gate, and v3.16.1's rule is that a warning behind
      // a click is not a warning.
      '<div class="dm-quick-footnote">' +
        (crossMountBusy && !busy
          ? renderStatus({ state: 'attention', title: 'An earlier fix on this domain is still running',
                           detail: 'Please wait for it to finish before starting another.' })
          : renderDescription('Every AI action shows its cost before it runs. ' + GIT_UNDO_NOTE)) +
      '</div>' +
    '</div>'
  );
}

function quickAiButton(key, label, busy, crossMountBusy) {
  const est = state.estimates[key];
  let costText = null;
  if (est === 'loading') costText = '…';
  else costText = costReadout(est, { compact: true });
  const disabled = busy || crossMountBusy || est === 'loading' || (est && est.error);
  const running = (busy === key + 'Plan' || busy === key + 'Scan' || busy === key + 'Estimate');
  const label2 = running ? label + '…' : label;
  return (
    '<button class="btn btn-ai btn-xs dm-quick-btn" data-action="' + key + '"' + (disabled ? ' disabled' : '') + '>' +
      // The sparkles mark (token spend) gives way to the ring only while
      // THIS action is the one running — the spend has already happened by
      // then, and liveness is the useful signal. Every other button keeps
      // its sparkles so the cost warning never disappears from the bar.
      (running ? buttonRingHtml() : icon('sparkles', 12)) +
      '<span class="dm-quick-label">' + escapeHtml(label2) + '</span>' +
      (costText ? '<span class="dm-quick-cost">' + escapeHtml(costText) + '</span>' : '') +
    '</button>'
  );
}

function renderConfirmCard() {
  const c = state.confirm;
  return (
    '<div class="dm-confirm-card">' +
      '<div class="dm-confirm-title">' + escapeHtml(c.title) + '</div>' +
      '<div class="dm-confirm-body">' + escapeHtml(c.body) + '</div>' +
      '<div class="dm-confirm-actions">' +
        '<button class="btn btn-primary" id="dm-confirm-yes">' + escapeHtml(c.confirmLabel || 'Confirm') + '</button>' +
        '<button class="btn btn-ghost" id="dm-confirm-no">Cancel</button>' +
      '</div>' +
    '</div>'
  );
}

function renderPendingPlan(crossMountBusy) {
  const p = state.pendingPlan;
  const busy = state.busyKey || crossMountBusy;
  let summaryLine = '';
  let body = '';
  if (p.kind === 'brokenLinks') {
    const s = p.summary;
    summaryLine = pluralize(s.retarget, 'link') + ' will be repointed to an existing page, ' + pluralize(s.strip, 'link') + ' will have the brackets removed (no matching page found).';
    body = pluralize(s.retargetOccurrences, 'occurrence') + ' repointed, ' + pluralize(s.stripOccurrences, 'occurrence') + ' stripped, across the domain.';
  } else {
    const s = p.summary;
    summaryLine = pluralize(s.rescuable, 'orphan') + ' found a home; ' + pluralize(s.noHome, 'orphan') + ' left for manual review.';
    body = 'Each rescued orphan gets one new [[wikilink]] added to the page that should reference it.';
  }
  return (
    '<div class="dm-plan-card">' +
      '<div class="dm-plan-title">Plan ready — nothing written yet</div>' +
      '<div class="dm-plan-summary">' + escapeHtml(summaryLine) + '</div>' +
      '<div class="dm-plan-detail">' + escapeHtml(body) + '</div>' +
      '<div class="dm-plan-actions">' +
        '<button class="btn btn-primary" id="dm-plan-apply-btn"' + (busy ? ' disabled' : '') + '>' + (busy === p.kind + 'Apply' ? 'Applying…' : 'Apply this plan') + '</button>' +
        '<button class="btn btn-ghost" id="dm-plan-discard-btn"' + (busy ? ' disabled' : '') + '>Discard</button>' +
      '</div>' +
      (crossMountBusy ? '<div class="dm-plan-detail dm-quick-note-busy">An earlier operation on this domain is still running.</div>' : '') +
    '</div>'
  );
}

// THREE outcomes on a handled pair, not two. `merged` and `skipped` are the
// user's own actions; `resolved` is neither — an earlier merge in this same
// scan deleted a page this pair named, so it needs nothing from anyone. It
// was previously indistinguishable from `skipped`, which is the word the UI
// uses for the user's own Skip (dismiss), so a merge that never ran was
// presented back as a decision they had made.
function semanticHandledLabel(p) {
  if (p.status === 'merged') return 'merged';
  if (p.status === 'resolved') {
    return 'resolved by an earlier merge' + (p.resolvedMissing ? ' — ' + p.resolvedMissing + ' is gone' : '');
  }
  return 'skipped';
}

function renderSemanticScanResult(readonly, crossMountBusy) {
  const s = activeSemanticScan();
  if (!s) return '';
  const busy = state.busyKey || crossMountBusy;
  const open = s.pairs.filter((p) => p.status === 'open');
  const handled = s.pairs.filter((p) => p.status !== 'open');

  if (s.pairs.length === 0) {
    return '<div class="dm-plan-card"><div class="dm-plan-title">No likely duplicates found</div></div>';
  }

  const high = liveHighConfidencePairs();
  const batchBar = (readonly || high.length === 0) ? '' : (
    '<div class="dm-sem-batch">' +
      '<button class="btn btn-primary" id="dm-semantic-merge-btn"' + (busy ? ' disabled' : '') + '>' +
        (busy === 'semanticMerge' ? 'Merging…' : 'Merge ' + pluralize(high.length, 'high-confidence duplicate')) +
      '</button>' +
      '<span class="dm-sem-batch-note">Merges every high-confidence pair below at once, in the direction currently shown. ' +
      'Use Preview / Flip / Skip on individual pairs first if any of them look wrong.</span>' +
    '</div>'
  );

  const cards = open.map((p) => renderSemanticPairCard(p, readonly, busy)).join('');
  const handledRows = handled.map((p) => (
    '<div class="dm-issue-row dm-sem-handled' + (p.status === 'resolved' ? ' dm-sem-handled-resolved' : '') + '">' +
      '<span class="mono dm-issue-main">' + escapeHtml(p.removeFolder + '/' + p.removeSlug) + ' → ' + escapeHtml(p.keepFolder + '/' + p.keepSlug) + '</span>' +
      '<span class="dm-issue-meta">' + escapeHtml(semanticHandledLabel(p)) + '</span>' +
    '</div>'
  )).join('');

  return (
    '<div class="dm-plan-card">' +
      '<div class="dm-plan-title">' + pluralize(s.pairs.length, 'candidate pair') + ' found</div>' +
      '<div class="dm-plan-summary">Each merge deletes one page and repoints every [[wikilink]] to it across the domain. ' +
      'Preview a pair to enable its Merge button; Flip swaps which side survives; Skip dismisses the pair so it stops ' +
      'coming back on future scans. The scan pairs every candidate, so several versions of one page produce several ' +
      'overlapping pairs — merging one of them can resolve the others, and those move to "Already handled" on their own. ' +
      GIT_UNDO_WARN + '</div>' +
      batchBar +
      '<div class="dm-sem-list">' + cards + '</div>' +
      (handledRows ? ('<div class="dm-plan-detail">Already handled in this scan:</div>' + handledRows) : '') +
    '</div>'
  );
}

// One pair. The four actions mirror the shipping app's per-pair card, which
// is the ONLY place a semantic duplicate can be acted on with judgement
// rather than in bulk.
function renderSemanticPairCard(pair, readonly, busy) {
  const key = semanticPairKey(pair);
  const previewed = isSemanticPreviewed(pair);
  const gate = canMergeSemanticPair(pair);
  const conf = pair.confidence || 'medium';
  const confCls = conf === 'high' ? 'dm-sem-conf-high' : (conf === 'low' ? 'dm-sem-conf-low' : 'dm-sem-conf-med');
  const rowBusy = !!busy;
  const preview = (activeSemanticScan() || {}).preview;
  const showPreview = preview && preview.key === key;

  return (
    '<div class="dm-sem-card" data-sem-key="' + escapeHtml(key) + '">' +
      '<div class="dm-sem-head">' +
        '<span class="mono dm-sem-remove">' + escapeHtml(pair.removeFolder + '/' + pair.removeSlug) + '</span>' +
        '<span class="dm-sem-arrow">→</span>' +
        '<span class="mono dm-sem-keep">' + escapeHtml(pair.keepFolder + '/' + pair.keepSlug) + '</span>' +
        '<span class="dm-sem-conf ' + confCls + '">' + escapeHtml(conf) + ' confidence</span>' +
      '</div>' +
      '<div class="dm-sem-sub">Keeps <span class="mono">' + escapeHtml(pair.keepSlug) + '</span>, deletes <span class="mono">' +
        escapeHtml(pair.removeSlug) + '</span>.</div>' +
      (pair.rationale ? '<div class="dm-sem-rationale">' + escapeHtml(pair.rationale) + '</div>' : '') +
      (readonly ? '' : (
        '<div class="dm-sem-actions">' +
          '<button class="btn btn-secondary dm-sem-btn" data-sem-action="preview" data-sem-key="' + escapeHtml(key) + '"' + (rowBusy ? ' disabled' : '') + '>' +
            (state.busyKey === 'semanticPreview:' + key ? 'Loading…' : 'Preview diff') + '</button>' +
          '<button class="btn btn-secondary dm-sem-btn" data-sem-action="flip" data-sem-key="' + escapeHtml(key) + '"' + (rowBusy ? ' disabled' : '') +
            ' title="Swap which side is kept">↔ Flip</button>' +
          '<button class="btn btn-primary dm-sem-btn" data-sem-action="merge" data-sem-key="' + escapeHtml(key) + '"' +
            // No `title=`. It carried `gate.reason` — but only while the
            // button was `disabled`, i.e. exactly when it is NOT focusable,
            // so the refusal was mouse-only. The same refusal already renders
            // as visible text five lines below ("Preview required before
            // Merge"), and when the gate IS open the tooltip only said
            // "Merge this pair", which is the button's own label.
            ((rowBusy || !gate.allowed) ? ' disabled' : '') + '>' +
            (state.busyKey === 'semanticMergeOne:' + key ? 'Merging…' : 'Merge') + '</button>' +
          '<button class="btn btn-ghost dm-sem-btn" data-sem-action="skip" data-sem-key="' + escapeHtml(key) + '"' + (rowBusy ? ' disabled' : '') + '>' +
            (state.busyKey === 'semanticSkip:' + key ? 'Skipping…' : 'Skip') + '</button>' +
          (previewed
            ? '<span class="dm-sem-gate dm-sem-gate-ok">' + icon('check', 11) + ' previewed</span>'
            : '<span class="dm-sem-gate">Preview required before Merge</span>') +
        '</div>'
      )) +
      (showPreview ? renderSemanticPreview(preview) : '') +
      (pair.refusal ? '<div class="dm-sem-refusal">' + icon('alertCircle', 13) + '<span>' + escapeHtml(pair.refusal) + '</span></div>' : '') +
      (pair.error ? '<div class="dm-sem-error">' + icon('alertCircle', 13) + '<span>' + escapeHtml(pair.error) + '</span></div>' : '') +
    '</div>'
  );
}

// The preview renders INLINE, inside the pair's own card — deliberately not
// in a modal/overlay. v3.6.0 finding 7 was a refused destructive write whose
// error was written to a status line sitting UNDERNEATH a 92%-opaque
// full-screen overlay that stayed up: the user saw the button reset and
// nothing else, read it as "my click didn’t register", and clicked the
// refused destructive action again. An inline card has no overlay that can
// hide its own outcome, and it keeps the pair’s context on screen while the
// user decides.
function renderSemanticPreview(preview) {
  if (preview.error) {
    return '<div class="dm-sem-preview dm-sem-preview-error">' + icon('alertCircle', 13) +
      '<span>Could not build a preview — ' + escapeHtml(preview.error) + '</span></div>';
  }
  const d = preview.data || {};
  const files = Array.isArray(d.affectedFiles) ? d.affectedFiles : [];
  const shown = files.slice(0, 12).map((f) =>
    '<li><span class="mono">' + escapeHtml(f.path) + '</span> — ' + pluralize(f.linkCount || 0, 'link') + '</li>'
  ).join('');
  const more = (d.affectedCount || 0) > shown.length
    ? '<li class="dm-sem-preview-more">…and ' + ((d.affectedCount || 0) - files.slice(0, 12).length) + ' more files</li>'
    : '';
  return (
    '<div class="dm-sem-preview">' +
      '<div class="dm-sem-preview-grid mono">' +
        '<div>keep: ' + escapeHtml(d.keepPath || '') + '</div>' +
        '<div>delete: ' + escapeHtml(d.removePath || '') + '</div>' +
        '<div>' + (d.totalLinksRewritten || 0) + ' link rewrites across ' + pluralize(d.affectedCount || 0, 'file') + '</div>' +
      '</div>' +
      (files.length ? '<ul class="dm-sem-preview-files">' + shown + more + '</ul>' : '') +
      '<div class="cur-eyebrow">MERGED CONTENT (FIRST 4 KB)</div>' +
      '<pre class="dm-sem-preview-body">' + escapeHtml(d.mergedPreview || '') +
        ((d.mergedLength || 0) > 4000 ? '\n…(truncated)' : '') + '</pre>' +
    '</div>'
  );
}

function renderIssueGroups(report, readonly, crossMountBusy) {
  const groups = HEALTH_CATEGORIES.map((cat) => renderIssueGroup(cat, report[cat.key] || [], readonly, crossMountBusy)).join('');
  const dismissedGroup = renderDismissedGroup(report.counts.dismissed);
  return '<div class="dm-groups">' + groups + dismissedGroup + '</div>';
}

function renderIssueGroup(cat, issues, readonly, crossMountBusy) {
  if (issues.length === 0) return '';
  const open = state.expandedGroups.has(cat.key);
  const fixAllCount = cat.key === 'brokenLinks' ? issues.filter((i) => i.suggestedTarget).length : issues.length;
  const canFixAll = !readonly && AUTO_FIX_TYPES.has(cat.key) && fixAllCount > 0;
  const busy = state.busyKey === 'group:' + cat.key;
  // MEDIUM-5 fix: also disabled while ANY write against this domain is in
  // flight from an earlier mount — not just this specific category's own
  // busyKey — since a concurrent fix on a DIFFERENT category still hits
  // the same domain's files on disk and would still 409 against it.
  const disabled = busy || crossMountBusy;
  const rows = issues.slice(0, 50).map((issue) => renderIssueRow(cat.key, issue, readonly)).join('');
  const more = issues.length > 50 ? '<div class="dm-issue-more">…and ' + (issues.length - 50) + ' more</div>' : '';
  return (
    '<details class="dm-group"' + (open ? ' open' : '') + ' data-group-key="' + cat.key + '">' +
      '<summary class="dm-group-summary">' +
        icon('chevronRight', 13) +
        '<span class="dm-group-label">' + escapeHtml(cat.label) + '</span>' +
        '<span class="dm-group-pill">' + issues.length + '</span>' +
        (canFixAll && fixAllCount > 0 ? (
          '<button class="btn btn-secondary dm-group-fixall-btn" data-fixall="' + cat.key + '"' + (disabled ? ' disabled' : '') + '>' +
            (busy ? 'Fixing…' : 'Fix all ' + fixAllCount) +
          '</button>'
        ) : '') +
      '</summary>' +
      '<div class="dm-group-body">' + rows + more + '</div>' +
    '</details>'
  );
}

function renderIssueRow(type, issue, readonly) {
  let main = '';
  let meta = '';
  let dismissible = false;
  switch (type) {
    case 'brokenLinks':
      main = escapeHtml(issue.sourceFile) + ' → [[' + escapeHtml(issue.linkText) + ']]';
      // The SLUG is code-shaped and goes in mono; the word "suggests" is
      // prose and stays in the sans face. `.dm-issue-main` already carried
      // `mono` on every row, so this meta column was the last place in the
      // health table rendering a wiki slug in the body face.
      if (issue.suggestedTarget) meta = 'suggests <span class="mono">' + escapeHtml(issue.suggestedTarget) + '</span>';
      else { meta = 'no suggestion'; dismissible = true; }
      break;
    case 'orphans':
      main = escapeHtml(issue.path);
      meta = escapeHtml(issue.type);
      dismissible = true;
      break;
    case 'crossFolderDupes':
      main = 'keep ' + escapeHtml(issue.keep) + ', remove ' + escapeHtml(issue.remove);
      break;
    case 'hyphenVariants':
      main = escapeHtml((issue.files || []).join(', '));
      meta = '→ <span class="mono">' + escapeHtml(issue.suggestedSlug || '') + '</span>';
      break;
    case 'folderPrefixLinks':
      main = escapeHtml(issue.sourceFile) + ' → [[' + escapeHtml(issue.linkText) + ']]';
      break;
    case 'missingBacklinks':
      main = escapeHtml(issue.summary) + ' ↔ ' + escapeHtml(issue.entity);
      break;
    default:
      // L7 fix: every other branch above escapes its interpolated fields;
      // this one didn't, and was unreachable until a 7th health category
      // is added — the moment that happens, this stops being defense in
      // depth and starts being the only thing standing between a scanned
      // page's own content and raw HTML injection into the issue row.
      main = escapeHtml(JSON.stringify(issue));
  }
  const canDismiss = !readonly && dismissible;
  return (
    '<div class="dm-issue-row">' +
      '<span class="mono dm-issue-main">' + main + '</span>' +
      '<span class="dm-issue-meta">' + meta + '</span>' +
      (canDismiss ? '<button class="btn btn-ghost dm-dismiss-btn" data-dismiss-type="' + type + '" data-dismiss-issue=\'' + escapeHtml(JSON.stringify(issue)) + '\'>Dismiss</button>' : '') +
    '</div>'
  );
}

function renderDismissedGroup(count) {
  if (!count) return '';
  const open = state.expandedGroups.has('dismissed');
  let body;
  if (!open) {
    body = '';
  } else if (state.dismissedRecords === null) {
    body = gatedLoader(loadGate, 'Loading…', 'dm-issue-row dm-issue-meta');
  } else {
    body = state.dismissedRecords.map((r) => (
      '<div class="dm-issue-row">' +
        '<span class="mono dm-issue-main">' + escapeHtml(describeDismissed(r)) + '</span>' +
        '<button class="btn btn-ghost dm-restore-btn" data-restore-key=\'' + escapeHtml(JSON.stringify(r)) + '\'>Restore</button>' +
      '</div>'
    )).join('') || '<div class="dm-issue-row"><span class="dm-issue-meta">Nothing dismissed.</span></div>';
  }
  return (
    '<details class="dm-group dm-group-dismissed"' + (open ? ' open' : '') + ' data-group-key="dismissed">' +
      '<summary class="dm-group-summary">' +
        icon('chevronRight', 13) +
        '<span class="dm-group-label dm-dismissed-label">Dismissed</span>' +
        '<span class="dm-group-pill">' + count + '</span>' +
      '</summary>' +
      '<div class="dm-group-body">' + body + '</div>' +
    '</details>'
  );
}

function describeDismissed(r) {
  switch (r.type) {
    case 'brokenLinks': return r.sourceFile + ' → [[' + r.linkText + ']]';
    case 'orphans': return r.path;
    case 'crossFolderDupes': return 'keep ' + r.keep + ', remove ' + r.remove;
    case 'hyphenVariants': return (r.files || []).join(', ');
    case 'folderPrefixLinks': return r.sourceFile + ' → [[' + r.linkText + ']]';
    case 'missingBacklinks': return r.summary + ' ↔ ' + r.entity;
    case 'semanticDupe': return (r.slugs || []).join(' / ');
    default: return r.type;
  }
}

// ── Event wiring for the health card ───────────────────────────────────────

function bindHealthListeners(domain, readonly) {
  // ── BOUND ONCE PER NODE (v3.64.1) — see bindStatCardListeners for the full
  // argument. The invariant here: every element this function binds lives
  // inside `.dm-health`, the section `healthSection` wraps. It matters more
  // here than anywhere else on this page, because Rescan, Fix-all, Apply plan
  // and Merge are NOT idempotent — a duplicate listener is a duplicate
  // request, and one of them deletes files.
  // `typeof` GUARDED, and that is not defensive dressing: three suites lift
  // these functions and execute them against a hand-written `document` that
  // has getElementById and querySelectorAll and NO querySelector, so an
  // unguarded call is a CRASH in a suite rather than a failing assertion —
  // the shape this file warns about. A stand-in with no querySelector simply
  // binds every time, which is what it did before this guard existed.
  const boundScope = typeof document.querySelector === 'function'
    ? document.querySelector('.dm-health') : null;
  if (boundScope) {
    if (boundScope.__dmBound) return;
    boundScope.__dmBound = true;
  }
  document.getElementById('dm-rescan-btn')?.addEventListener('click', () => rescan(domain.slug));
  document.getElementById('dm-open-settings-btn')?.addEventListener('click', () => navigate('settings'));

  // LOW-3 fix (re-audit, third round): these 5 dispatch sites are the
  // DESTRUCTIVE ones (fix/rescue/merge/apply) — exactly what
  // reportAsyncActionFailure exists for — and each one's target function
  // ends with an un-try-wrapped `render(token)` (or `await loadHealth`)
  // whose own throw would otherwise become a bare, unattributed "Uncaught
  // (in promise)". `Promise.resolve().then(() => fn()).catch(...)` is used
  // uniformly rather than `fn(...).catch(...)` directly because
  // mergeSemanticDuplicates is a plain SYNCHRONOUS function (it only sets
  // state.confirm and calls render()) — it returns `undefined`, and
  // `undefined.catch` would itself throw. Wrapping the call in `.then()`
  // defers it by one microtask (imperceptible; nothing else can run
  // in between) and converts either a synchronous throw OR a rejected
  // promise into the same caught path, so the same wrapper is correct
  // for both the sync and the async targets without special-casing either.
  document.querySelectorAll('.dm-quick-btn[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      Promise.resolve().then(() => onQuickAction(domain.slug, btn.dataset.action)).catch(reportAsyncActionFailure);
    });
  });

  document.getElementById('dm-confirm-yes')?.addEventListener('click', () => {
    const run = state.confirm && state.confirm.run;
    state.confirm = null;
    if (run) Promise.resolve().then(() => run()).catch(reportAsyncActionFailure);
  });
  document.getElementById('dm-confirm-no')?.addEventListener('click', () => { state.confirm = null; render(myMountToken); });

  document.getElementById('dm-plan-apply-btn')?.addEventListener('click', () => {
    Promise.resolve().then(() => applyPendingPlan(domain.slug)).catch(reportAsyncActionFailure);
  });
  document.getElementById('dm-plan-discard-btn')?.addEventListener('click', () => { state.pendingPlan = null; render(myMountToken); });

  document.getElementById('dm-semantic-merge-btn')?.addEventListener('click', () => {
    Promise.resolve().then(() => mergeSemanticDuplicates(domain.slug)).catch(reportAsyncActionFailure);
  });

  // Per-pair semantic actions. The pair object is looked up from LIVE state
  // by key at click time rather than captured in the closure — a pair that
  // was flipped since this markup was painted must be merged in the
  // direction it now shows, not the one it had when the listener bound.
  document.querySelectorAll('.dm-sem-btn[data-sem-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.semAction;
      const key = btn.dataset.semKey;
      Promise.resolve().then(() => {
        const scan = activeSemanticScan();
        if (!scan) return;
        const pair = scan.pairs.find((p) => semanticPairKey(p) === key);
        if (!pair) return;
        if (action === 'preview') return previewSemanticPair(domain.slug, pair);
        if (action === 'flip') { flipSemanticPair(pair); render(myMountToken); return; }
        if (action === 'merge') return mergeOneSemanticPair(domain.slug, pair);
        if (action === 'skip') return skipSemanticPair(domain.slug, pair);
      }).catch(reportAsyncActionFailure);
    });
  });

  document.querySelectorAll('.dm-group-fixall-btn[data-fixall]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation(); // don't toggle the <details> — see v3.0.1-beta.18 note in CLAUDE.md
      // Same wrapper as every other action binding in this function — see the
      // comment above the quick-action loop for why `.then()` is used even for
      // a synchronous target (confirmFixAllOfType only sets state.confirm).
      Promise.resolve().then(() => confirmFixAllOfType(domain.slug, btn.dataset.fixall)).catch(reportAsyncActionFailure);
    });
  });

  document.querySelectorAll('.dm-group[data-group-key]').forEach((el) => {
    el.addEventListener('toggle', () => {
      const key = el.dataset.groupKey;
      if (el.open) state.expandedGroups.add(key); else state.expandedGroups.delete(key);
      if (key === 'dismissed' && el.open && state.dismissedRecords === null) loadDismissedRecords(domain.slug).catch(reportAsyncActionFailure);
    });
  });

  document.querySelectorAll('.dm-dismiss-btn[data-dismiss-type]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.dismissType;
      const issue = JSON.parse(btn.dataset.dismissIssue);
      dismissIssue(domain.slug, type, issue).catch(reportAsyncActionFailure);
    });
  });
  document.querySelectorAll('.dm-restore-btn[data-restore-key]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const record = JSON.parse(btn.dataset.restoreKey);
      undismissIssue(domain.slug, record).catch(reportAsyncActionFailure);
    });
  });
}

function rescan(slug) {
  // Slug-gated like the re-entry path, never a hardcoded `true`: a rescan
  // is the same domain by construction, but hardcoding that makes the
  // guarantee depend on the caller staying correct forever.
  loadHealth(slug, myMountToken, {
    keepHealth: shouldKeepHealthOnReload(state.health, state.healthSlug, slug),
  }).catch(reportAsyncActionFailure);
}

// ── AI privacy disclosure (one-time, browser-local) ─────────────────────────
// Shipping app.js (src/public/app.js) gates its single-row "✨ Ask AI"
// broken-link/orphan suggestion behind a one-time localStorage-backed
// disclosure (ensureAiDisclosure(), key 'curator-ai-health-disclosure-seen-
// v1') before anything is sent to the configured LLM provider. /next has no
// such per-row action — instead, Quick maintenance's three ✨ buttons below
// (brokenLinks / orphans / semanticDupes) are /next's equivalent LLM-backed
// surface. Derived by reading every call in this file that reaches an
// /api/health/*/plan or */scan endpoint (the only ones that make wiki
// content leave the machine): runBrokenLinksPlan, runOrphansPlan, and
// runSemanticScan — reached only via confirmBrokenLinksPlan/
// confirmOrphansPlan/confirmSemanticScan below. applyPendingPlan and
// runMergeSemanticDuplicates do NOT call the LLM (they apply a plan an
// earlier *plan*/*scan* step already computed), same as runFixSafe/
// fixAllOfType (deterministic, no LLM at all) — none of those four are
// gated, matching the shipping app's fix-all-safe (never gated either).
// This gate covers exactly those three plan/scan entry points, the same
// way ensureAiDisclosure covered exactly its one action.
//
// SAME KEY, byte-identical, as the shipping app — deliberately NOT
// namespaced (contrast views/chat.js's LS_STYLE/LS_PROVIDER, which also now
// read the shipping keys, and LS_DOMAIN, which has no shipping counterpart
// and stays namespaced). Reading/writing the same key is what makes a user
// who already accepted this in the shipping app not see it again the
// moment /next becomes `/` at cutover — the single most visible "did the
// update forget me" symptom for a privacy consent. Consent is monotonic
// (accepting on either surface satisfies both; there is no "un-accept"), so
// there is no value format to reconcile — both sides only ever write the
// literal string 'yes'.
const AI_DISCLOSURE_KEY = 'curator-ai-health-disclosure-seen-v1';

// Copy is NOT a verbatim port of the shipping modal's. The shipping copy
// describes ONE action ("a short excerpt (~4 KB) of the wiki page that
// contains the broken link... a list of your wiki's page names"); /next has
// no such action, so reusing that exact text in front of a batch action
// would misdescribe what is actually about to happen — a worse privacy
// representation, not a more faithful one, and the brief for this change is
// explicit that phrasing genuinely wrong for /next's IA should be changed
// rather than forced verbatim. This instead describes what /next's three
// real actions send, checked against src/brain/health-ai.js: broken-link
// and orphan fixes send an excerpt of the specific page plus a slug
// inventory; duplicate-page scanning sends each candidate page's first
// paragraph. All three already show an exact per-action cost/target confirm
// right after this one (confirmBrokenLinksPlan etc.) — this disclosure only
// states the general shape ONCE, it does not repeat those specifics.
const AI_DISCLOSURE_COPY =
  'The ✨ AI actions in Quick maintenance — fixing broken links, rescuing orphan pages, and finding duplicate ' +
  'pages — send excerpts of the relevant wiki pages, and usually a list of your other page names (slugs only, ' +
  'never full page contents beyond what’s excerpted), to your configured AI provider (Google Gemini or ' +
  'Anthropic — whichever you set in Settings). The next step always shows exactly what that specific action ' +
  'sends and its estimated cost before anything runs. The provider’s own privacy policy applies to what it ' +
  'receives. To turn this off entirely, remove your API key in Settings.';

// Fail CLOSED: for a privacy consent, "can't tell" must mean "ask again",
// never "assume yes". localStorage can throw (private/incognito mode,
// storage disabled by policy) — same try/catch idiom as views/chat.js's
// LS_* helpers, but the DEFAULT on catch is deliberately the opposite of
// theirs: chat.js defaults an unreadable style/provider choice to a safe
// in-band value ('balanced', the global provider) because getting a mere
// preference wrong costs nothing. Getting THIS one wrong the same way —
// assuming consent that was never durably recorded — would let wiki content
// reach a third party with no disclosure ever having been shown. So this
// returns false (not seen) on any error, which shows the modal again rather
// than silently skipping it.
// ── DURABLE, NOT MERELY LOCAL (v3.28.0) ────────────────────────────────────
// The consent is now recorded server-side as well as in localStorage, through
// shared/ui-state.js. localStorage is per-PARTITION, and a native shell
// (Electron) gets its own — so without this, the first launch of the packaged
// app re-asks for a privacy consent the user already gave. Of everything in
// this shell's storage, that is the one whose loss is not an inconvenience:
// the app would be stating, falsely, that it has no record of the user's
// decision about sending their wiki content to a third party.
//
// THE FAIL-CLOSED DIRECTION IS UNCHANGED, and it is what the try/catch is
// still for. durableStorage().getItem returns the merged durable value when
// one is recorded, and otherwise falls through to real localStorage AND ITS
// THROW — so "can't tell" still lands on `false` (ask again), never on an
// assumed yes. The merge itself cannot downgrade a consent: either side
// holding 'yes' answers 'yes' (shared/ui-state.js mergeField), and the server
// refuses to overwrite a recorded one (src/brain/config.js, monotonic).
//
// The one behavioural difference, stated: on a page load where the shared GET
// has not landed yet AND localStorage is empty, this reads false and the
// modal is shown. That is the same direction the old code took on a storage
// error, and it is the correct one for a consent.
function aiDisclosureSeen() {
  try {
    return durableStorage().getItem(AI_DISCLOSURE_KEY) === 'yes';
  } catch {
    return false;
  }
}

function markAiDisclosureSeen() {
  // A write failure here just means the modal shows again next time (the
  // fail-closed direction) — never a reason to treat consent as recorded.
  try { durableStorage().setItem(AI_DISCLOSURE_KEY, 'yes'); } catch { /* ignore */ }
}

// Single chokepoint for all three LLM-backed Quick maintenance actions.
// Reuses the SAME state.confirm / renderConfirmCard() plumbing every other
// cost-before-action dialog in this view already uses (#dm-confirm-yes /
// #dm-confirm-no are wired once, unconditionally, in bindHealthListeners) —
// deliberately not a separate overlay/modal component, so the disclosure
// reads as one more step in a pattern the user already knows rather than a
// new kind of UI, per the brief's "make it consistent with [the
// cost-before-action pattern] nearby in this view". `run` marks the key
// seen, THEN opens the real per-action confirm (which itself becomes the
// next state.confirm) — so a first-time AI user sees disclosure -> the
// action's own cost/target confirm -> (SSE) result, while a returning user
// (or one who already accepted in the shipping app pre-cutover) goes
// straight to the per-action confirm. This mirrors the shipping app's
// ensureAiDisclosure() -> runAiSuggest() two-step exactly.
function confirmAiAction(slug, action) {
  const dispatch = () => {
    if (action === 'brokenLinks') confirmBrokenLinksPlan(slug);
    else if (action === 'orphans') confirmOrphansPlan(slug);
    else if (action === 'semanticDupes') confirmSemanticScan(slug);
  };
  if (aiDisclosureSeen()) { dispatch(); return; }
  state.confirm = {
    title: 'Before you use an AI action',
    body: AI_DISCLOSURE_COPY,
    confirmLabel: 'Continue',
    run: () => { markAiDisclosureSeen(); dispatch(); },
  };
  render(myMountToken);
}

function onQuickAction(slug, action) {
  if (action === 'fixSafe') return confirmFixSafe(slug);
  if (action === 'brokenLinks' || action === 'orphans' || action === 'semanticDupes') return confirmAiAction(slug, action);
}

// ── fix-all-safe (free, deterministic) ─────────────────────────────────────

function confirmFixSafe(slug) {
  const total = countSafeFixable(state.health);
  state.confirm = {
    title: 'Fix ' + pluralize(total, 'safe issue') + '?',
    body: 'Applies deterministic repairs only — cross-folder duplicates, hyphen variants, folder-prefix links, ' +
      'missing backlinks, and broken links that already have a known target. Nothing here spends AI tokens. ' +
      GIT_UNDO_NOTE,
    confirmLabel: 'Fix now',
    run: () => runFixSafe(slug),
  };
  render(myMountToken);
}

// Every `run*`/`apply*`/`merge*` action below follows the same shape:
// captured `const token = myMountToken` as the FIRST line (safe — always
// entered synchronously, directly or one hop through a confirm-dialog
// click, from a real user click; see the doc comment on myMountToken
// above), `state.busyKey` reset in a `finally` so it is NEVER left stuck
// (H2 fix — a busyKey that survives a navigate-away-and-back permanently
// disables every quick-maintenance button until a full page reload), and
// every state MUTATION (not just the render) gated on isCurrentMount(token)
// so a response for an abandoned mount can't corrupt state a later, fresh
// mount would otherwise render correctly.
async function runFixSafe(slug) {
  const token = myMountToken;
  state.busyKey = 'fixSafe';
  render(token);
  // MEDIUM-1 fix: acquired right after the operation is committed to (same
  // spot ingest.js's runIngest acquires its own handle), released
  // unconditionally in the `finally` below — see the module-level comment
  // above inFlightWriteSlugs for why this is a SEPARATE mechanism from that
  // Set, not a replacement for it.
  const releaseGate = beginDomainWrite(slug, 'health-fix-all-safe');
  try {
    // LOW-4 fix (re-audit, third round): `add()` moved to be the FIRST
    // statement inside the try (was: add(slug) — render(token) — try {}).
    // If render(token) threw, `add()` had already run, but the matching
    // `finally { delete(slug) }` below was never reached (the throw
    // happened OUTSIDE the try) — the entry leaked permanently, disabling
    // this domain's Fix/Rescue/Merge buttons behind "an earlier fix is
    // still running" for the rest of the session (no reachable trigger
    // found; hardening only). With `add()` INSIDE the try, a throw before
    // this line means `add()` never ran — nothing to leak — and a throw
    // after it is caught by this same try's `finally`.
    inFlightWriteSlugs.add(slug); // MEDIUM-5 fix — see the module-level comment above
    const result = await fetchJSON('/api/health/' + encodeURIComponent(slug) + '/fix-all-safe', { method: 'POST' });
    if (isCurrentMount(token)) state.banner = { tone: 'success', text: 'Fixed ' + result.fixed + ' of ' + result.total + ' safe issues.' };
  } catch (err) {
    if (isCurrentMount(token)) state.banner = { tone: 'error', text: 'Could not fix safe issues — ' + err.message };
  } finally {
    inFlightWriteSlugs.delete(slug); // unconditional — the real write actually finished
    releaseGate(); // MEDIUM-1 fix — unconditional, same reasoning as the delete() above
    state.busyKey = null;
    state.aiProgress = null;
  }
  if (!isCurrentMount(token)) return;
  await loadHealth(slug, token, { silent: true });
}

// ── Single-category "Fix all N" (free, deterministic) ──────────────────────

// Per-section "Fix all N" — confirm first.
//
// The global "Fix N safe issues" button has always confirmed; this one did
// not, and it is the MORE dangerous of the two: `crossFolderDupes` and
// `hyphenVariants` both MERGE two pages and DELETE one of them. A user
// reported reaching a file-deleting merge in one click, with no dialog.
//
// Every fix-all is gated (not only the two destructive types) so the two
// bulk-fix surfaces behave the same way — an inconsistent gate is the thing
// that makes a destructive click feel safe. Reuses the SAME state.confirm /
// renderConfirmCard() plumbing as confirmFixSafe and every cost-before-action
// dialog in this view; #dm-confirm-yes / #dm-confirm-no are already wired
// unconditionally in bindHealthListeners.
const DESTRUCTIVE_FIX_TYPES = new Set(['crossFolderDupes', 'hyphenVariants']);

// ── AN ISSUE IS NOT A PAGE, AND FOR ONE TYPE IT IS NOT EVEN A PAIR ───────
// The number in the TITLE ("Fix all N …") counts ISSUES and is right. The
// number in the destructive SENTENCE has to count PAGES ABOUT TO BE DELETED,
// and those are not the same quantity. MEASURED against the real scanWiki
// and the real fixIssue, not reasoned about:
//
//   crossFolderDupes — issue shape is { keep, remove }: a PAIR. Exactly one
//     `rm` per issue in fixCrossFolderDupe. deletes === issues.length. ✓
//
//   hyphenVariants  — issue shape is { files: [...], suggestedSlug }: a
//     GROUP. On {tali-rezun, dr-tali-rezun, talirezun} scanWiki emits ONE
//     issue with files.length === 3, and fixHyphenVariant deletes
//     files.length - 1 = TWO pages. The old `issues.length` said "1 page
//     will be deleted"; the wiki went 6 pages -> 4. Two deleted, one
//     announced, and the under-report grows without bound as (groupSize - 2).
//
// This is the operation that produced the original bug report, and this
// dialog is the only thing standing between a user and it. A destructive
// confirm that UNDERSTATES the damage is worse than no confirm at all, so
// where the shape is unrecognisable the fallback ROUNDS UP (1, never 0):
// over-stating by one costs a moment's hesitation, under-stating costs a
// page the user did not agree to lose.
function deletedPageCount(type, issues) {
  if (type === 'hyphenVariants') {
    return issues.reduce(
      (n, i) => n + (Array.isArray(i && i.files) ? Math.max(0, i.files.length - 1) : 1),
      0);
  }
  // crossFolderDupes (and any future strict pair type): one page per issue.
  return issues.length;
}

function confirmFixAllOfType(slug, type) {
  if (!AUTO_FIX_TYPES.has(type)) return;
  const cat = HEALTH_CATEGORIES.find((c) => c.key === type);
  const issues = (state.health && state.health[type]) || [];
  const count = type === 'brokenLinks' ? issues.filter((i) => i.suggestedTarget).length : issues.length;
  if (count === 0) return;

  const label = cat ? cat.label.toLowerCase() : type;
  // "group", not "pair": one hyphen-variant issue can hold three or more
  // slugs, and "pair" told the user the wrong thing about the SHAPE as well
  // as the count.
  const body = DESTRUCTIVE_FIX_TYPES.has(type)
    ? 'This MERGES each group and DELETES the duplicate pages, then repoints every '
      + '[[link]] that pointed at them. ' + pluralize(deletedPageCount(type, issues), 'page')
      + ' will be deleted. '
      + GIT_UNDO_WARN
    : 'Applies the deterministic repair to every ' + label.replace(/s$/, '')
      + ' listed here. No AI tokens are spent. ' + GIT_UNDO_NOTE;

  state.confirm = {
    title: 'Fix all ' + count + ' ' + label + '?',
    body,
    confirmLabel: DESTRUCTIVE_FIX_TYPES.has(type) ? 'Merge and delete' : 'Fix now',
    run: () => fixAllOfType(slug, type),
  };
  render(myMountToken);
}

async function fixAllOfType(slug, type) {
  const token = myMountToken;
  state.busyKey = 'group:' + type;
  render(token);
  // MEDIUM-1 fix — this flow really does hit POST /:domain/fix (singular,
  // not /fix-all), and the label below ('health-fix', not 'health-fix-all')
  // matches the backend's own registerWrite(domain, 'health-fix') call
  // inside that exact route — see the corrected module-level comment above
  // inFlightWriteSlugs (MEDIUM-2).
  const releaseGate = beginDomainWrite(slug, 'health-fix');
  try {
    inFlightWriteSlugs.add(slug); // MEDIUM-5 fix — LOW-4: inside the try, see runFixSafe's comment
    const result = await fetchJSON('/api/health/' + encodeURIComponent(slug) + '/fix', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type }),
    });
    if (isCurrentMount(token)) state.banner = { tone: 'success', text: 'Fixed ' + result.fixed + ' of ' + result.total + '.' };
  } catch (err) {
    if (isCurrentMount(token)) state.banner = { tone: 'error', text: 'Could not fix — ' + err.message };
  } finally {
    inFlightWriteSlugs.delete(slug);
    releaseGate(); // MEDIUM-1 fix
    state.busyKey = null;
    state.aiProgress = null;
  }
  if (!isCurrentMount(token)) return;
  await loadHealth(slug, token, { silent: true });
}

// ── Broken-links AI plan/apply ──────────────────────────────────────────────

function confirmBrokenLinksPlan(slug) {
  const est = state.estimates.brokenLinks;
  const provider = state.aiProvider || 'the configured provider';
  const model = state.aiModel || '';
  const cost = costReadout(est);
  state.confirm = {
    title: 'Ask AI to resolve broken links?',
    body: 'Sends each broken link’s context, plus the domain’s slug inventory' +
      (est && !est.error ? ' (' + est.inventorySize + ' entries)' : '') + ', to ' + provider + (model ? '/' + model : '') +
      '. Estimated cost ' + (cost || 'unknown') + ' for ' + (est && !est.error ? est.needAi : '?') + ' link' +
      (est && est.needAi === 1 ? '' : 's') + ' that need AI (' + (est && !est.error ? est.resolveFree : 0) + ' resolve for free locally). ' +
      'This only builds a plan — nothing is written yet.',
    confirmLabel: 'Build plan',
    run: () => runBrokenLinksPlan(slug),
  };
  render(myMountToken);
}

// v3.9.1 — an EMPTY plan is a normal outcome, and this is where that is decided.
//
// THE DEFECT: `if (!result) throw` caught a missing done-frame but not an empty
// `result.plan`, so a zero-entry plan was stored as a pending plan, rendered with
// a live "Apply this plan" button, and POSTed — earning a 400 whose body the
// catch below rendered verbatim in a RED banner: "Could not apply the plan —
// Missing plan[] to apply". The app took its own correct, deliberately
// conservative behaviour and presented it as a failure the user could not act on.
//
// WHY THE PLAN CAN LEGITIMATELY BE EMPTY, per planner (src/brain/health-ai.js):
//   • orphans      — the rescuer only proposes a home when there is a GENUINE
//                    relationship, and drops anything below medium confidence,
//                    hallucinated, or self-linking. On a domain with three
//                    stubborn orphans left, "none of them has a home" is the
//                    EXPECTED answer.
//   • broken links — every AI batch that throws or fails to parse hits
//                    `continue` WITHOUT pushing, so a provider outage can never
//                    bias the plan toward stripping brackets. All batches
//                    failing therefore yields [] with the links left untouched.
// Those two are different facts about the world and must not be reported with
// the same sentence, which is why `batchErrors` is counted below rather than
// assumed to be zero: telling a user "the AI found nothing to fix" when the AI
// was never reached would be the same class of untruth as the red banner.
//
// `batch-error` frames were already on the wire and read by NOTHING in /next —
// this repo's named dead-data shape, and the reason the honest message was not
// available to write before now.
function emptyPlanNotice(kind, summary, batchErrors) {
  if (batchErrors > 0) {
    // NOT pluralize(): this file's pluralize is a bare + 's' and yields
    // "2 batchs". Caught by §8 of test-beta16-broken-links.js, whose sandbox
    // uses the same naive implementation the real view does — which is the
    // point of stubbing it faithfully rather than "correctly".
    return 'Nothing was planned and nothing was written — the AI did not answer for '
      + batchErrors + ' batch' + (batchErrors === 1 ? '' : 'es')
      + '. Your wiki is unchanged; try again in a moment.';
  }
  if (kind === 'orphans') {
    const n = Number(summary && summary.orphans) || 0;
    // Pronoun-free on purpose: the sentence has to read correctly at n = 1 and
    // at n = 213 without a second template.
    return 'No confident home was found for ' + (n ? pluralize(n, 'orphan page') : 'any orphan page')
      + ', so nothing was written. The rescuer only proposes a link where there is a genuine '
      + 'relationship, so this is it working as intended — left for manual review.';
  }
  return 'No broken link could be resolved, so nothing was written and your wiki is unchanged.';
}

async function runBrokenLinksPlan(slug) {
  const token = myMountToken;
  state.busyKey = 'brokenLinksPlan';
  state.progressText = 'Planning…';
  state.aiProgress = null;
  render(token);
  try {
    let result = null;
    let batchErrors = 0;
    await streamSSE('/api/health/' + encodeURIComponent(slug) + '/broken-links/plan', {}, (type, ev) => {
      if (type === 'progress') { noteAiProgress('brokenLinksPlan', ev); render(token); }
      if (type === 'batch-error') batchErrors++;
      if (type === 'done') result = ev;
      if (type === 'error') throw new Error(ev.error || 'Plan failed');
    });
    if (!result) throw new Error('No plan returned');
    // Deliberately NOT `!result.plan.length` on a bare read: a done frame whose
    // `plan` is absent or not an array is also "nothing to apply", and must take
    // the same branch rather than throwing on `.length` of undefined.
    //
    // No early `return` here: the trailing `render(token)` sits AFTER the
    // try/catch/finally, so returning out of the try would reset busyKey in the
    // finally and then never repaint — the banner would be set and invisible
    // until some unrelated event re-rendered the view.
    const plan = Array.isArray(result.plan) ? result.plan : [];
    if (!isCurrentMount(token)) { /* a later mount owns the view; drop the result */ }
    else if (plan.length === 0) {
      state.pendingPlan = null;
      state.banner = { tone: 'info', text: emptyPlanNotice('brokenLinks', result.summary, batchErrors) };
    } else {
      state.pendingPlan = { kind: 'brokenLinks', plan, summary: result.summary };
    }
  } catch (err) {
    if (isCurrentMount(token)) state.banner = { tone: 'error', text: 'Could not build a broken-link plan — ' + err.message };
  } finally {
    state.busyKey = null;
    state.aiProgress = null;
  }
  render(token);
}

// ── Orphan-rescue AI plan/apply ─────────────────────────────────────────────

function confirmOrphansPlan(slug) {
  const est = state.estimates.orphans;
  const provider = state.aiProvider || 'the configured provider';
  const model = state.aiModel || '';
  const cost = costReadout(est);
  state.confirm = {
    title: 'Ask AI to find homes for orphan pages?',
    body: 'Sends each orphan plus the domain’s entity/concept inventory' +
      (est && !est.error ? ' (' + est.inventorySize + ' entries)' : '') + ' to ' + provider + (model ? '/' + model : '') +
      '. Estimated cost ' + (cost || 'unknown') + '. This only builds a plan — nothing is written yet.',
    confirmLabel: 'Build plan',
    run: () => runOrphansPlan(slug),
  };
  render(myMountToken);
}

async function runOrphansPlan(slug) {
  const token = myMountToken;
  state.busyKey = 'orphansPlan';
  state.aiProgress = null;
  render(token);
  try {
    let result = null;
    let batchErrors = 0;
    await streamSSE('/api/health/' + encodeURIComponent(slug) + '/orphans/plan', {}, (type, ev) => {
      if (type === 'progress') { noteAiProgress('orphansPlan', ev); render(token); }
      if (type === 'batch-error') batchErrors++;
      if (type === 'done') result = ev;
      if (type === 'error') throw new Error(ev.error || 'Plan failed');
    });
    if (!result) throw new Error('No plan returned');
    // v3.9.1 — see runBrokenLinksPlan above for the whole reasoning. This is the
    // flow the maintainer actually hit: "Rescue 3 orphans $0.0026" → three
    // orphans with no genuine home → red "Could not apply the plan — Missing
    // plan[] to apply". Same branch, same no-early-return rule.
    const plan = Array.isArray(result.plan) ? result.plan : [];
    if (!isCurrentMount(token)) { /* a later mount owns the view; drop the result */ }
    else if (plan.length === 0) {
      state.pendingPlan = null;
      state.banner = { tone: 'info', text: emptyPlanNotice('orphans', result.summary, batchErrors) };
    } else {
      state.pendingPlan = { kind: 'orphans', plan, summary: result.summary };
    }
  } catch (err) {
    if (isCurrentMount(token)) state.banner = { tone: 'error', text: 'Could not build an orphan-rescue plan — ' + err.message };
  } finally {
    state.busyKey = null;
    state.aiProgress = null;
  }
  render(token);
}

async function applyPendingPlan(slug) {
  const token = myMountToken;
  const p = state.pendingPlan;
  if (!p) return;
  // v3.9.1 — SECOND, INDEPENDENT layer. The plan runners above already refuse to
  // store an empty plan, so this should be unreachable; it is here because the
  // cost of being wrong is asymmetric. `state` is module-scoped and survives
  // leaving the view, so a pendingPlan can outlive the run that produced it, and
  // an empty one arriving here would spend a POST, take the domain's file lock,
  // and hand the user a 400 — the exact defect. It fails LOUDLY-but-calmly (an
  // info banner, the plan discarded) rather than silently: `/old`'s equivalent
  // guard is a bare `return`, which turns the Apply button into a dead control
  // that reports nothing at all, and that is the wrong half of this trade.
  const pendingCount = Array.isArray(p.plan) ? p.plan.length : 0;
  if (pendingCount === 0) {
    state.pendingPlan = null;
    state.banner = { tone: 'info', text: emptyPlanNotice(p.kind, p.summary, 0) };
    render(token);
    return;
  }
  const kind = p.kind;
  state.busyKey = kind + 'Apply';
  state.aiProgress = null;
  render(token);
  const url = '/api/health/' + encodeURIComponent(slug) + '/' + (kind === 'brokenLinks' ? 'broken-links' : 'orphans') + '/apply';
  // MEDIUM-1 fix — label matches src/routes/health.js's own registerWrite()
  // label for whichever endpoint `url` above actually resolves to
  // (POST /:domain/broken-links/apply -> 'broken-links-apply' /
  // POST /:domain/orphans/apply -> 'orphan-rescue-apply'; cited by route,
  // not line number — see the MEDIUM-2 fix on the module-level comment
  // above inFlightWriteSlugs for why).
  const releaseGate = beginDomainWrite(slug, kind === 'brokenLinks' ? 'broken-links-apply' : 'orphan-rescue-apply');
  try {
    inFlightWriteSlugs.add(slug); // MEDIUM-5 fix — LOW-4: inside the try, see runFixSafe's comment
    let result = null;
    await streamSSE(url, { plan: p.plan }, (type, ev) => {
      if (type === 'progress') { noteAiProgress(kind + 'Apply', ev); render(token); }
      if (type === 'done') result = ev;
      if (type === 'error') throw new Error(ev.error || 'Apply failed');
    });
    if (isCurrentMount(token)) {
      if (kind === 'brokenLinks') {
        // v3.9.1 — report the THREE outcomes this endpoint can produce, not one.
        //
        // It used to render `occurrencesReplaced`, which is the SUM of repointed
        // and stripped occurrences, under the single label "Repointed" — so a run
        // that repointed nothing and removed every bracket still reported them all
        // as repoints. Measured: a plan whose one retarget is refused returns
        // { retargeted: 0, stripped: 3, occurrencesReplaced: 3 } and read
        // "Repointed 3 link occurrences".
        //
        // `downgraded` is the count the server-side lexical gate produces when it
        // REFUSES a proposed retarget and degrades it to a strip. Two properties
        // decide the wording, and both are measured rather than assumed:
        //   • it counts LINKS (plan entries), while retargeted/stripped count
        //     OCCURRENCES — so it is never rendered as an occurrence count;
        //   • those occurrences are ALREADY inside `stripped`, so it is a
        //     qualifier on the strip count, never a third addend.
        // Absent (an older server mid-update) it reads 0 and the sentence is
        // omitted entirely — a permanent "0 refused" row is noise, not honesty.
        const rt = Number(result.retargeted) || 0;
        const st = Number(result.stripped) || 0;
        const dg = Number(result.downgraded) || 0;
        let text = 'Repointed ' + pluralize(rt, 'occurrence')
          + ', removed the brackets from ' + pluralize(st, 'occurrence')
          + ', across ' + pluralize(Number(result.filesChanged) || 0, 'file') + '.';
        if (dg > 0) {
          text += ' ' + pluralize(dg, 'link')
            + ' had a proposed target that did not pass the safety check, so the brackets'
            + ' were removed instead of pointing at the wrong page.';
        }
        state.banner = { tone: 'success', text };
      } else {
        state.banner = { tone: 'success', text: 'Rescued ' + (result.rescued || 0) + ' orphans (' + (result.skipped || 0) + ' skipped).' };
      }
    }
  } catch (err) {
    if (isCurrentMount(token)) state.banner = { tone: 'error', text: 'Could not apply the plan — ' + err.message };
  } finally {
    // MEDIUM-4 fix (re-audit): unlike busyKey (which must ALWAYS reset —
    // see the H2 fix note above — or a button stays disabled forever),
    // `pendingPlan` is a piece of DATA a later, fresh mount can legitimately
    // own. If the user leaves this view mid-apply, comes back, and builds a
    // NEW plan before the abandoned apply's stream finishes, this ungated
    // reset used to silently destroy that new plan out from under the user
    // the instant the old apply's finally ran — with no error, no banner,
    // just the plan vanishing. Gate it: only null out the plan this SAME
    // mount is responsible for.
    if (isCurrentMount(token)) state.pendingPlan = null;
    inFlightWriteSlugs.delete(slug);
    releaseGate(); // MEDIUM-1 fix — unconditional, regardless of mount staleness (same as inFlightWriteSlugs.delete above)
    state.busyKey = null;
    state.aiProgress = null;
  }
  if (!isCurrentMount(token)) return;
  await loadHealth(slug, token, { silent: true });
}

// ── Semantic-duplicate scan + batch merge ───────────────────────────────────

// H4 fix: the semantic-duplicate estimate is fetched HERE, on demand, the
// first time the user opens this action for the domain — not prefetched
// on every Domains open/switch (see loadEstimates + the file-header
// comment for why: it's a real pairwise-similarity pass over every page,
// measured at ~14.9s of unbroken event-loop block on a 3,251-page domain,
// even though it spends no tokens). The cost-before-action rule still
// holds: nothing token-spending runs until the SECOND step (the confirm
// dialog below, then Scan now) — this just moves WHEN the free-but-slow
// estimate itself runs, from "always, on view entry" to "once, on request".
async function confirmSemanticScan(slug) {
  const token = myMountToken;
  if (!state.estimates.semanticDupes) {
    state.busyKey = 'semanticDupesEstimate';
    render(token);
    try {
      const est = await fetchJSON('/api/health/' + encodeURIComponent(slug) + '/semantic-dupes/estimate');
      if (slug === state.activeSlug && isCurrentMount(token)) state.estimates.semanticDupes = est;
    } catch (err) {
      if (slug === state.activeSlug && isCurrentMount(token)) state.estimates.semanticDupes = { error: err.message };
    } finally {
      // H2 fix (re-audit finding): previously this reset lived AFTER the
      // try/catch, as a plain sequential statement — but BOTH early
      // returns below (domain switched mid-estimate, or the view left
      // entirely) skipped straight past it. Since this is the only place
      // that ever clears 'semanticDupesEstimate', every quick-maintenance
      // button and Rescan stayed permanently disabled — reproduced by
      // opening this action, switching domains before the ~free-but-slow
      // estimate resolved, and finding every button on this domain (and
      // every OTHER domain, since busyKey is shared module state, not
      // per-domain) still disabled after a full navigate-away-and-back
      // remount; only a page reload recovered. A `finally` runs on EVERY
      // exit from the block above, including a `return` inside it, so
      // this can no longer be skipped.
      state.busyKey = null;
    state.aiProgress = null;
    }
  }

  if (slug !== state.activeSlug || !isCurrentMount(token)) { render(token); return; }

  const est = state.estimates.semanticDupes;
  if (!est) { render(token); return; } // domain changed before the estimate ever resolved
  if (est.error) {
    state.banner = { tone: 'error', text: 'Could not estimate the duplicate scan — ' + est.error };
    render(token);
    return;
  }
  if (!est.candidatePairs) {
    state.banner = { tone: 'info', text: 'No likely duplicate candidates found — nothing to scan.' };
    render(token);
    return;
  }

  const provider = state.aiProvider || 'the configured provider';
  const model = state.aiModel || '';
  const cost = costReadout(est);
  state.confirm = {
    title: 'Scan for duplicate pages?',
    body: 'Scans ' + est.candidatePairs + ' candidate pairs' +
      (est.totalCandidates ? ' (pre-filtered locally from ' + est.totalCandidates + ' total)' : '') +
      ' using ' + provider + (model ? '/' + model : '') + '. Estimated cost ' + (cost || 'unknown') +
      '. This only finds pairs — nothing is merged yet.',
    confirmLabel: 'Scan now',
    run: () => runSemanticScan(slug),
  };
  render(token);
}

async function runSemanticScan(slug) {
  const token = myMountToken;
  state.busyKey = 'semanticDupesScan';
  state.aiProgress = null;
  render(token);
  try {
    let result = null;
    await streamSSE('/api/health/' + encodeURIComponent(slug) + '/semantic-dupes/scan', {}, (type, ev) => {
      if (type === 'progress') { noteAiProgress('semanticDupesScan', ev); render(token); }
      if (type === 'done') result = ev;
      if (type === 'error') throw new Error(ev.error || 'Scan failed');
    });
    if (!result) throw new Error('No scan result returned');
    if (isCurrentMount(token)) {
      // A NEW SCAN GETS A NEW OBJECT, so the previewed set is empty by
      // construction — there is no set from the previous scan to forget to
      // clear (LAYER 1, structural). The slug stamp is LAYER 2.
      state.semanticScan = {
        slug,
        pairs: (result.pairs || []).map((p) => ({
          keepFolder: p.keepFolder, keepSlug: p.keepSlug,
          removeFolder: p.removeFolder, removeSlug: p.removeSlug,
          confidence: p.confidence, rationale: p.rationale,
          status: 'open',
        })),
        cost: result.cost,
        previewed: new Set(),
        preview: null,
      };
    }
  } catch (err) {
    if (isCurrentMount(token)) state.banner = { tone: 'error', text: 'Could not scan for duplicates — ' + err.message };
  } finally {
    state.busyKey = null;
    state.aiProgress = null;
  }
  render(token);
}

function mergeSemanticDuplicates(slug) {
  // Read live — never a captured array. See INVARIANT 2.
  const high = liveHighConfidencePairs();
  if (high.length === 0) return;
  state.confirm = {
    title: 'Merge ' + pluralize(high.length, 'high-confidence duplicate') + '?',
    // DELIBERATELY INLINE, and must stay inline — do not "tidy" this into
    // GIT_UNDO_WARN. test-next-semantic-gate.js builds a sandbox from this
    // file's source with a FIXED const allow-list it extracts (`CONSTS`), and
    // that suite is owned elsewhere; referencing the module constant here throws
    // ReferenceError inside its sandbox and reds the suite. The copy is not
    // unguarded: §8 of test-beta16-broken-links.js asserts that neither frontend
    // contains a revert-from-Sync claim anywhere, and that this exact sentence
    // is byte-identical to GIT_UNDO_WARN — so a drift between the two goes RED.
    body: 'Combines each pair’s bullet sections onto the kept page, retargets every [[wikilink]] across the ' +
      'domain to it, and deletes the removed file. Nothing else changes. ' +
      'There is no Undo button in the app. If you use GitHub Sync this is recoverable with a git client; otherwise it cannot be undone.',
    confirmLabel: 'Merge now',
    // NOTE the missing argument: the pair list is NOT captured here. The
    // confirm card renders inline, so Flip / Skip / single-Merge stay
    // clickable while it is open — capturing `high` now would merge a pair
    // the user has since flipped (wrong direction) or skipped (already
    // dismissed). That is the exact bug the shipping app fixed in a
    // v3.0.1-beta.15 audit. runMergeSemanticDuplicates re-derives at the
    // moment the user actually confirms.
    run: () => runMergeSemanticDuplicates(slug),
  };
  render(myMountToken);
}

// ── Per-pair semantic actions: preview / flip / merge one / skip ───────────

async function previewSemanticPair(slug, pair) {
  const token = myMountToken;
  const key = semanticPairKey(pair);
  state.busyKey = 'semanticPreview:' + key;
  render(token);
  try {
    const data = await fetchJSON('/api/health/' + encodeURIComponent(slug) + '/semantic-dupes/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issue: toWirePair(pair) }),
    });
    if (!isCurrentMount(token)) return;
    const scan = activeSemanticScan();
    if (!scan) return; // domain changed while the preview was in flight
    scan.preview = { key, data };
    // ONLY a SUCCESSFUL preview opens the gate. A failed one must leave
    // Merge disabled — otherwise the guard degrades into "clicking Preview
    // is enough", which is not what it promises.
    markSemanticPreviewed(pair);
  } catch (err) {
    if (!isCurrentMount(token)) return;
    const scan = activeSemanticScan();
    // DEFENCE IN DEPTH. The cascade above covers merges made in THIS session;
    // a page can also go in Obsidian, over the MCP, or in another Health fix
    // on another tab, and then the first thing that notices is this preview.
    // Leaving it as a red "Could not build a preview" under a Merge button
    // gated by "Preview required before Merge" is the dead end this release
    // is about — so the pair is marked resolved instead.
    const stale = semanticStaleFromError(err);
    if (stale) {
      markSemanticPairResolved(pair, { missing: stale.missing, by: 'the page is gone' });
      if (stale.missing) {
        const parts = String(stale.missing).split('/');
        resolvePairsTouching(activeSemanticScan(), { folder: parts[0], slug: parts.slice(1).join('/') }, null);
      }
    } else if (scan) {
      scan.preview = { key, error: err.message };
    }
  } finally {
    state.busyKey = null;
    state.aiProgress = null;
  }
  render(token);
}

async function mergeOneSemanticPair(slug, pair) {
  const token = myMountToken;
  const key = semanticPairKey(pair);
  // Re-check the gate at EXECUTION time, not just at render time. A
  // disabled button is a UI affordance; this is the actual guard, and it is
  // the one a keyboard, a stale render, or a future refactor has to get
  // past. Same reasoning as the shipping app's handler, which refuses even
  // though its button is disabled.
  const gate = canMergeSemanticPair(pair);
  if (!gate.allowed) {
    setSemanticPairMessage(key, { refusal: gate.reason });
    render(token);
    revealSemanticMessage(key);
    return;
  }
  state.busyKey = 'semanticMergeOne:' + key;
  setSemanticPairMessage(key, {});
  render(token);
  const releaseGate = beginDomainWrite(slug, 'semantic-dupe-merge');
  try {
    inFlightWriteSlugs.add(slug);
    const result = await fetchJSON('/api/health/' + encodeURIComponent(slug) + '/fix', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'semanticDupe', issue: toWirePair(pair) }),
    });
    if (isCurrentMount(token)) {
      if (!result || !result.fixed) {
        // Two different "fixed: 0"s. A page of the pair being GONE is the
        // pair already being resolved (fixIssue names it in `missing`), and
        // reporting that as "failed validation on disk" is what made the
        // reported dead end look like a bug in the user's own wiki.
        const gone = result && (result.reason === 'remove-page-missing' || result.reason === 'keep-page-missing');
        if (gone) {
          markSemanticPairResolved(pair, {
            missing: result.missing || null,
            by: 'the page is gone',
          });
          if (result.missing) {
            const parts = String(result.missing).split('/');
            resolvePairsTouching(activeSemanticScan(), { folder: parts[0], slug: parts.slice(1).join('/') }, null);
          }
        } else {
          setSemanticPairMessage(key, { error: 'The server refused this merge (the pair failed validation on disk).' });
        }
      } else {
        markSemanticPairStatus(pair, 'merged');
        // THE CASCADE. `pair.removeSlug` no longer exists on disk, so every
        // other OPEN pair in this scan that names it is resolved too — see
        // resolvePairsTouching. Without this, a version family left N-2
        // cards whose Preview failed and whose Merge stayed gated.
        const alsoResolved = resolvePairsTouching(
          activeSemanticScan(), { folder: pair.removeFolder, slug: pair.removeSlug }, pair);
        state.banner = {
          tone: 'success',
          text: 'Merged ' + pair.removeSlug + ' → ' + pair.keepSlug + '.' +
            (alsoResolved ? ' ' + pluralize(alsoResolved, 'other pair') + ' resolved with it.' : ''),
        };
      }
    }
  } catch (err) {
    if (isCurrentMount(token)) {
      // A 409 is a REFUSAL, not a failure — render it as its own visible
      // message on the pair the user clicked, never a silent button reset.
      const c = classifyDomainError(err);
      setSemanticPairMessage(key, c.refusal ? { refusal: c.refusal } : { error: 'Could not merge — ' + c.error });
    }
  } finally {
    inFlightWriteSlugs.delete(slug);
    releaseGate();
    state.busyKey = null;
    state.aiProgress = null;
  }
  if (!isCurrentMount(token)) return;
  // keepSemanticScan: re-earning this pair list costs a paid LLM pass, so the
  // scan is kept. NOT because "the remaining pairs are still valid" — that is
  // what this comment used to claim and it was false: the scan pairs every
  // candidate, so a version family is a clique and this merge just deleted a
  // page that several sibling pairs still name. Those are marked `resolved`
  // above (resolvePairsTouching) rather than left as cards that cannot be
  // previewed or merged. See resetDomainScopedHealthState.
  await loadHealth(slug, token, { silent: true, keepSemanticScan: true });
  revealSemanticMessage(key);
}

async function skipSemanticPair(slug, pair) {
  const token = myMountToken;
  const key = semanticPairKey(pair);
  state.busyKey = 'semanticSkip:' + key;
  setSemanticPairMessage(key, {});
  render(token);
  try {
    // Dismissal shape mirrors health-dismissed.js's semanticDupe key
    // (slugA/folderA/slugB/folderB), same as the shipping app's Skip.
    await fetchJSON('/api/health/' + encodeURIComponent(slug) + '/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'semanticDupe',
        issue: {
          slugA: pair.keepSlug, folderA: pair.keepFolder,
          slugB: pair.removeSlug, folderB: pair.removeFolder,
        },
      }),
    });
    if (isCurrentMount(token)) markSemanticPairStatus(pair, 'skipped');
  } catch (err) {
    if (isCurrentMount(token)) {
      const c = classifyDomainError(err);
      setSemanticPairMessage(key, c.refusal ? { refusal: c.refusal } : { error: 'Could not skip — ' + c.error });
    }
  } finally {
    state.busyKey = null;
    state.aiProgress = null;
  }
  if (!isCurrentMount(token)) return;
  await loadHealth(slug, token, { silent: true, keepSemanticScan: true });
  revealSemanticMessage(key);
}

// Reveals a per-pair refusal/error after the repaint. Scoped to the pair the
// user actually clicked — see revealMessage for why "rendered" is not
// "visible".
function revealSemanticMessage(key) {
  const sel = '.dm-sem-card[data-sem-key="' + (window.CSS && CSS.escape ? CSS.escape(key) : key) + '"] ';
  return revealMessage(sel + '.dm-sem-refusal') || revealMessage(sel + '.dm-sem-error');
}

// Per-pair message slot (refusal / error), cleared by passing {}.
function setSemanticPairMessage(key, msg) {
  const scan = activeSemanticScan();
  if (!scan) return;
  const idx = scan.pairs.findIndex((p) => semanticPairKey(p) === key);
  if (idx === -1) return;
  scan.pairs[idx] = Object.assign({}, scan.pairs[idx], {
    refusal: msg.refusal || null,
    error: msg.error || null,
  });
}

async function runMergeSemanticDuplicates(slug) {
  const token = myMountToken;
  // INVARIANT 2, second reading: derived HERE, at the moment the user
  // confirmed — not at the moment the confirm dialog opened. Between those
  // two moments the user can flip a pair (changing which page survives) or
  // skip one (dismissing it), and both must be honoured.
  const pairs = liveHighConfidencePairs().map(toWirePair);
  if (pairs.length === 0) {
    state.banner = { tone: 'info', text: 'Nothing left to merge — every high-confidence pair has been handled.' };
    render(token);
    return;
  }
  state.busyKey = 'semanticMerge';
  state.aiProgress = null;
  render(token);
  // MEDIUM-1 fix — label matches src/routes/health.js's own
  // registerWrite(domain, 'semantic-dupes-merge-batch') inside
  // POST /:domain/semantic-dupes/merge-batch; cited by route, not line
  // number — see the MEDIUM-2 fix on the module-level comment above
  // inFlightWriteSlugs for why.
  const releaseGate = beginDomainWrite(slug, 'semantic-dupes-merge-batch');
  try {
    inFlightWriteSlugs.add(slug); // MEDIUM-5 fix — LOW-4: inside the try, see runFixSafe's comment
    let result = null;
    await streamSSE('/api/health/' + encodeURIComponent(slug) + '/semantic-dupes/merge-batch', { pairs }, (type, ev) => {
      // Per-pair outcomes arrive as progress frames. Recording them keeps
      // the pair list truthful about what happened rather than wiping it —
      // see the `finally` below for why wiping was the wrong default.
      if (type === 'progress' && ev.pair && (ev.status === 'merged' || ev.status === 'skipped')) {
        markSemanticPairStatus(ev.pair, ev.status);
        // THE CASCADE, on the path that reaches it FIRST and hardest: the
        // batch deletes many pages in one pass, so within a version family
        // most of its own later pairs go stale mid-run. See
        // resolvePairsTouching.
        if (ev.status === 'merged') {
          resolvePairsTouching(
            activeSemanticScan(), { folder: ev.pair.removeFolder, slug: ev.pair.removeSlug }, ev.pair);
        }
      }
      // `stale` is the server saying a page of THIS pair was already gone
      // when it got there — the pair is resolved, not skipped. `skipped` is
      // the word the UI uses for the user's own Skip, and reporting a merge
      // that never ran as the user's decision is the defect this splits.
      if (type === 'progress' && ev.pair && ev.status === 'stale') {
        markSemanticPairResolved(ev.pair, { missing: ev.missing || null, by: 'an earlier merge' });
        if (ev.missing) {
          const parts = String(ev.missing).split('/');
          resolvePairsTouching(activeSemanticScan(), { folder: parts[0], slug: parts.slice(1).join('/') }, null);
        }
      }
      // Same frames also carry {done, total}. Feeding the ring here is
      // additive — it does not touch the pair-status recording above, which
      // has its own audit history and its own reasons.
      if (type === 'progress') { noteAiProgress('semanticMerge', ev); render(token); }
      if (type === 'done') result = ev;
      if (type === 'error') throw new Error(ev.error || 'Merge failed');
    });
    if (isCurrentMount(token)) state.banner = { tone: 'success', text: 'Merged ' + (result.merged || 0) + ' of ' + (result.total || pairs.length) + ' duplicate pairs.' };
  } catch (err) {
    if (isCurrentMount(token)) {
      const c = classifyDomainError(err);
      state.banner = c.refusal
        ? { tone: 'error', text: c.refusal }
        : { tone: 'error', text: 'Could not merge duplicates — ' + c.error };
    }
  } finally {
    // The scan is NO LONGER discarded here. It used to be, and that made
    // the batch destroy the medium/low-confidence pairs it never touched —
    // pairs that only a paid LLM pass can produce, so the user had to buy
    // them again to review three pages the batch had nothing to do with.
    // Each pair's real outcome is recorded from the progress frames above
    // instead. (The MEDIUM-4 concern that motivated the old reset — an
    // abandoned merge destroying a NEWER scan — is now structurally
    // impossible rather than gated: a newer scan is a different object with
    // a different slug stamp, and markSemanticPairStatus only ever writes
    // through activeSemanticScan().)
    inFlightWriteSlugs.delete(slug);
    releaseGate(); // MEDIUM-1 fix — unconditional, same reasoning as inFlightWriteSlugs.delete above
    state.busyKey = null;
    state.aiProgress = null;
  }
  if (!isCurrentMount(token)) return;
  await loadHealth(slug, token, { silent: true, keepSemanticScan: true });
}

// ── Dismiss / undismiss ──────────────────────────────────────────────────

async function dismissIssue(slug, type, issue) {
  const token = myMountToken;
  try {
    await fetchJSON('/api/health/' + encodeURIComponent(slug) + '/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, issue }),
    });
    state.dismissedRecords = null;
    if (!isCurrentMount(token)) return;
    await loadHealth(slug, token, { silent: true });
  } catch (err) {
    if (!isCurrentMount(token)) return;
    state.banner = { tone: 'error', text: 'Could not dismiss — ' + err.message };
    render(token);
  }
}

async function undismissIssue(slug, record) {
  const token = myMountToken;
  try {
    await fetchJSON('/api/health/' + encodeURIComponent(slug) + '/undismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: record.type, issue: record }),
    });
    state.dismissedRecords = null;
    if (!isCurrentMount(token)) return;
    await loadHealth(slug, token, { silent: true });
  } catch (err) {
    if (!isCurrentMount(token)) return;
    state.banner = { tone: 'error', text: 'Could not restore — ' + err.message };
    render(token);
  }
}

async function loadDismissedRecords(slug) {
  const token = myMountToken;
  // Capture the gate for THIS call. `loadGate` is module-scoped and the
  // next mount replaces it, so settling the module variable from a stale
  // in-flight load would decrement the NEXT mount's counter and hide a
  // loader that is legitimately up. A cancelled gate ignores settle(), so
  // the stale path becomes a no-op instead.
  const gate = loadGate;
  if (gate) gate.begin();
  try {
    const data = await fetchJSON('/api/health/' + encodeURIComponent(slug) + '/dismissed');
    if (slug === state.activeSlug && isCurrentMount(token)) state.dismissedRecords = data.records || [];
  } catch {
    if (slug === state.activeSlug && isCurrentMount(token)) state.dismissedRecords = [];
  }
  settleGate(gate, () => render(token));
}

// ── Render entry point ─────────────────────────────────────────────────────

// ── THE RESERVED HEIGHTS, MEASURED OFF THE CARD THE USER IS LOOKING AT ────
//
// Clamped rather than trusted. A rect can come back 0 (the card is inside a
// `display:none` ancestor, or the window is minimised) and it can come back
// enormous (a 3,445-row list rendered before `.dm-browse-list`'s 420 px cap
// applies, in a browser that has not finished styling). Reserving either
// number would be worse than reserving nothing: the first re-creates the
// collapse this exists to remove, and the second opens a hole in the page.
// Outside the band the previous reading is KEPT, because a reading we do not
// believe is not evidence that the old one stopped being true.
const RESERVE_MIN_PX = 80;
const RESERVE_MAX_PX = 1400;

/**
 * Record the CURRENT height of the two cards that get replaced by a
 * placeholder, so the placeholder can hold their space.
 *
 * WHY IT LIVES IN render() AND NOT IN renderMain(). It has to read the DOM
 * BEFORE setMain() replaces it, and it has to do so from a function that is
 * not lifted into any suite's sandbox: renderMain IS lifted (by
 * scripts/test-next-domain-card-order.js, against a `document` stand-in with
 * neither querySelector nor real elements), so a new free identifier there
 * would make that suite CRASH rather than fail. render() is stubbed by every
 * sandbox in the tree and lifted by none, which makes it the one place this
 * can go without coupling a layout measurement to a test harness.
 *
 * NEVER FROM A CARD THAT IS ITSELF RESERVING. A placeholder carries
 * aria-busy, and reading its height would ratchet the reserve down to the
 * placeholder's own size on the very next switch — the reserve would decay
 * to nothing over a few clicks and the defect would come back looking like a
 * regression somewhere else entirely.
 */
let reserveCapturedThisTask = false;

function captureCardReserve() {
  if (typeof document === 'undefined' || !document.querySelector) return;
  // ── ONCE PER TASK, and that is a correctness rule before it is a cost one.
  //
  // A domain switch calls render() three or four times in ONE synchronous
  // task (selectDomain, then each loader's entry), and every call after the
  // first would be reading a DOM the previous one has just written — so the
  // number it captured would be the PLACEHOLDER's height, not the content
  // card's, and the reserve would decay towards nothing over a few clicks.
  //
  // It is also the expensive reading: measured in the browser on the real
  // 3,445-page domain, this pair of rect reads costs under 0.001 ms against
  // a clean layout and 4.5 ms when it is forced to flush a just-written
  // innerHTML. Taking only the first — which is the one against the clean,
  // already-painted layout — is both the correct number and the free one.
  //
  // The flag resets in a microtask, i.e. at the end of the current task and
  // before any subsequent one, so "this task" needs no clock and no timer.
  if (reserveCapturedThisTask) return;
  reserveCapturedThisTask = true;
  if (typeof queueMicrotask === 'function') queueMicrotask(() => { reserveCapturedThisTask = false; });
  else Promise.resolve().then(() => { reserveCapturedThisTask = false; });
  const next = { browse: 0, health: 0 };
  let any = false;
  for (const [key, sel] of [['browse', '.dm-browse-card'], ['health', '.dm-health-card']]) {
    const el = document.querySelector(sel);
    if (!el || el.getAttribute('aria-busy') === 'true') continue;
    const h = Math.round(el.getBoundingClientRect().height);
    if (h >= RESERVE_MIN_PX && h <= RESERVE_MAX_PX) { next[key] = h; any = true; }
  }
  if (!any) return;
  const prev = state.reserve || { browse: 0, health: 0 };
  state.reserve = {
    browse: next.browse || prev.browse,
    health: next.health || prev.health,
  };
}

/**
 * Keep an OPEN ⓘ fold open across a full repaint.
 *
 * shared/text.js keeps a panel's open state in the DOM only — it flips
 * `hidden` and sets `aria-expanded` on the button and records nothing — so
 * every `render()` closed every fold on this screen. That is v3.53.1's finding
 * verbatim ("the redesigned screen closed its own folds while a test ran"),
 * fixed there for Settings and in v3.54.0 for Agent memory, and it never
 * reached this view. It matters more now than it did: this card carries FOUR
 * kinds of fold (the section mark plus two per project row), and the OVERVIEW
 * tiles added this release re-render the whole column on a click, so an open
 * explanation would be shut by the very control it explains.
 *
 * Captured and restored around the swap, in `render()` rather than
 * `renderMain()`, for the same reason `captureCardReserve` lives here: it must
 * read the live DOM BEFORE `setMain()` replaces it, and `renderMain` is lifted
 * into suite sandboxes with a `document` stand-in that has no
 * `querySelectorAll`.
 *
 * RESTORE ONLY EVER OPENS. It never closes a panel it did not see open, so a
 * fold a later render has legitimately opened itself is not fought — the same
 * rule views/settings.js states for its own capture/restore. A mark whose id
 * is no longer on the page (its project was renamed, or the domain changed) is
 * skipped rather than resurrected.
 */
function captureOpenInfoPanels() {
  if (typeof document === 'undefined' || !document.querySelectorAll) return [];
  return Array.prototype.slice
    .call(document.querySelectorAll('[data-tx-info][aria-expanded="true"]'))
    .map((btn) => btn.getAttribute('data-tx-info'))
    .filter(Boolean);
}

function restoreOpenInfoPanels(ids) {
  if (!ids || !ids.length || typeof document === 'undefined' || !document.getElementById) return;
  for (const id of ids) {
    const btn = document.getElementById(id + '-btn');
    const panel = document.getElementById(id);
    if (!btn || !panel) continue;
    panel.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
  }
}

function render(token) {
  const openInfo = captureOpenInfoPanels();
  captureCardReserve();
  renderSidebar(token);
  renderMain(token);
  restoreOpenInfoPanels(openInfo);
}

registerView('domains', {
  onEnter(mountToken) {
    myMountToken = mountToken;

    // ── THE DOMAIN REQUEST IS CONSUMED FIRST, SYNCHRONOUSLY (P1-9) ─────
    //
    // BEFORE `loadGate`, before `loadDomainsList`, before any `await`, and
    // that ordering is the whole guard. Two separate things rest on it:
    //
    //   1. `loadDomainsList`'s commit resolves the active domain with
    //      `if (!state.activeSlug || !state.domains.some(...))`, so a slug
    //      written HERE survives and a slug written any later loses to
    //      `state.domains[0]`. `state` is module-scoped and deliberately
    //      OUTLIVES the view (see its own comment), so without this the
    //      request would also lose to whatever domain was open last time —
    //      the stale-cached-list case, which is the common one.
    //   2. `consumeDomainRequest()` CLEARS on read. onEnter runs exactly once
    //      per mount and nothing can intervene between `navigate()` invoking
    //      it and this line, whereas a value read after an await could race a
    //      second, faster navigate() to the same view. The same rule app.js
    //      states for `consumeChatScopeRequest`, for the same reason.
    //
    // WHAT THIS DELIBERATELY DOES NOT DO IS CLEAR ANYTHING ELSE. A request
    // for a different domain is a domain switch, and `selectDomain` clears
    // seven fields on one — but every one of them is ALREADY guarded against
    // being painted under the wrong name by the stamp discipline this view
    // was built on: `activeBrowse()` / `activeProjects()` refuse a list whose
    // stamp does not match, `shouldKeepHealthOnReload` compares
    // `state.healthSlug`, and the three forms that carry a target slug
    // (`lifecycle`, `projectLc`, `confirm`) are cleared by this view's own
    // TEARDOWN, so they are already null on any arrival. Re-typing that list
    // here would be a second copy of a clearing rule, which is this file's
    // most reliably repeated defect — and a copy that silently stops
    // matching the day a field is added to one of them.
    //
    // The slug is NOT validated here: the domain list has not been read yet,
    // which is exactly why the write has to come first. It is checked in the
    // commit, which is also where a miss is disclosed. `arrivalRequest` is
    // what carries the request across that await.
    arrivalRequest = consumeDomainRequest();
    if (arrivalRequest && arrivalRequest.slug) state.activeSlug = arrivalRequest.slug;

    loadGate = createLoadingGate({
      onChange: () => { if (isCurrentMount(mountToken)) render(mountToken); },
    });
    loadGate.begin();
    loadDomainsList(mountToken).catch((err) => reportAsyncMountFailure(mountToken, err));

    // The knowledge-folder path, for "Looking in <path>". Deliberately NOT
    // awaited and deliberately NOT a mount failure: it only makes the copy
    // more specific, and gating the whole view on a cosmetic read would turn
    // a nice-to-have into a way to blank the screen. Free, local, no network.
    loadKnowledgeBase(mountToken)
      .then(() => { if (isCurrentMount(mountToken)) render(mountToken); })
      .catch(reportAsyncActionFailure);

    // Prime the durable UI-state record (shared/ui-state.js) so
    // aiDisclosureSeen(), which is SYNCHRONOUS and runs from a click, has the
    // server's answer in hand by the time a ✨ button can be pressed.
    //
    // This costs ZERO extra requests: loadUiState() memoises one GET per page
    // load, and app.js's boot() already calls it through
    // maybeShowCutoverNotice(). Whichever runs first creates the promise; this
    // call exists so the consent does not silently depend on that boot chain
    // having reached its second link. Unawaited and cannot reject — a mount
    // must never be gated on it, and the fail-closed direction (ask again)
    // already covers the case where it has not landed.
    loadUiState();

    // M2 fix (re-audit finding): this view's `state` is DELIBERATELY
    // module-scoped and NOT reset on every onEnter (see the comment above
    // `state` — leaving Domains and coming back should still show which
    // domain was open). But a few of those fields are dangerous to leave
    // behind rather than merely stale: `state.confirm.run` and
    // `state.pendingPlan` close over (or were built from) a specific
    // scan/plan snapshot — if the user leaves this view with a confirm
    // dialog open or a built-but-unapplied plan pending and comes back
    // later, they could be shown, or worse still able to APPLY, a
    // confirmation/plan derived from a scan `loadHealth` has long since
    // discarded (a different domain's issues, or a health report that's
    // been rescanned since). `state.busyKey` is reset here too as a second
    // line of defense alongside the H2 fix in confirmSemanticScan/etc.
    // (every busy-setting function below now also clears it itself, in a
    // `finally`, regardless of mount staleness — this teardown is what
    // still catches ANY spot that pattern was missed). Everything else
    // (expandedGroups, dismissedRecords, the health report itself) is left
    // exactly as it was, matching this file's persist-across-mounts design.
    return () => {
      // ── THE TWO HOSTED PANELS COME DOWN WITH THE PAGE (v3.64.0) ──────
      // Both unmounts are idempotent and both run the panel's FULL
      // teardown, in its own order. For Shared Brain it is load-bearing
      // rather than tidy: its teardown closes the wizard, which is what
      // stops a PAT-holding overlay outliving its mount. For Ingest it stops
      // an activity poll, an attached SSE stream and a set of document-level
      // drag guards from leaking into whatever view comes next.
      unmountIngestSection();
      unmountSharedSection();
      mountedSourcesEl = null;
      mountedSourcesDomain = null;
      mountedSharedEl = null;
      mountedSharedDomain = null;
      // A paint that was patched around a busy panel is not owed a rebuild
      // once the page itself is gone.
      quiescedWhileBusy = false;
      state.confirm = null;
      state.pendingPlan = null;
      // NOT `state.semanticScan = null` any more. That discarded an LLM-
      // BILLED result on a rail click and made the user pay again. The paid
      // pair list is kept (stamped with its domain, and LAYER 2 refuses it
      // elsewhere); only the destructive-merge gate is re-armed. See
      // disarmSemanticScan for why the split falls exactly there.
      disarmSemanticScan(state.semanticScan);
      // A create/rename/delete form must not survive leaving the view: the
      // two destructive ones carry a target slug, and this file's `state`
      // is module-scoped, so an abandoned "Delete X?" card would otherwise
      // be sitting there — armed — the next time the user opens Domains,
      // above whatever domain happens to be selected then.
      state.lifecycle = null;
      state.busyKey = null;
      // Same two reasons the fields above are cleared. `kbBusy` would
      // otherwise leave both folder buttons disabled on the next mount
      // because a picker was open when the user navigated away, and
      // `kbNotice` is a report about something that has already finished —
      // stale news on re-entry, and it carries a live undo button whose
      // target the user has had time to forget. `state.kb` (the path) is
      // NOT cleared: it is a fact about this install, not an event.
      state.kbBusy = false;
      state.kbNotice = null;
    state.aiProgress = null;
      // A one-shot fade token that nothing consumed is a fade waiting to
      // happen on a block that has been on screen since before the user left
      // the view. `state.cache` and `state.reserve` deliberately SURVIVE: the
      // first is what makes coming back instant, and the second is a
      // measurement of a card this view will paint again.
      state.reveal = null;
      // Timer hygiene (load-bearing): an armed delay timer that survives
      // this teardown would paint a loader into whatever view comes next.
      if (loadGate) { loadGate.cancel(); loadGate = null; }
    };
  },
});
