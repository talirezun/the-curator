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
  registerView, setSidebar, setMain, eyebrow, emptyCard, icon, escapeHtml, navigate, isCurrentMount,
  reportAsyncMountFailure, reportAsyncActionFailure, isCurrentReader, openReader,
  beginDomainWrite,
} from '../app.js';

// Second import of the SAME module, as a namespace, for exactly one thing:
// the chat-scope handoff (see goToChatScoped below). A static named import
// of an export that does not exist is a HARD MODULE-LOAD ERROR in ESM — it
// takes the entire /next shell down to a blank page, which is the precise
// failure class v3.1.0's boot guard exists for. The chat-scope function is
// owned by app.js and lands in a different edit than this one, so a named
// import here would couple "did that edit land yet" to "does the app boot
// at all". A namespace import cannot fail that way, and the call site below
// degrades loudly (console.warn) + usefully (unscoped Chat) rather than
// silently, so a rename can never become an invisible dead button. The
// module is evaluated once regardless of how many times it is imported.
import * as shell from '../app.js';

// The ONE /next Markdown renderer (next/shared/markdown.js). This view and
// views/chat.js are both callers of the same copy — see that module's header
// for the escape-first cardinal rule and for why a wiki page body, which
// arrives over Personal Sync and Shared Brain mirrors, is treated as hostile
// input. Do not add a local renderer here, ever: scripts/test-next-markdown.js
// §0 WALKS the whole src/public/next tree and fails on a second declaration in
// any module it finds, in any form. (That claim used to be false — §0 tested
// a hardcoded three-file list, so a copy pasted into a fourth view passed
// unnoticed. It is a tree walk now, and mutation-proven.)
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
  renderReadoutGroup, renderDescription, renderStatus, renderViewHeader,
} from '../shared/text.js';

// The icon set this view needs (activity, sparkles, chevron-right,
// alert-circle, lock, check) lives in app.js's shared ICON_BODY — see
// icon() below — there is no view-local icon table.

// ── Domain identity colour ────────────────────────────────────────────────
// Domains aren't typed like pages (no entity/concept/summary triad), but
// the design still gives each one a stable colour dot in the sidebar list
// and header. No backend field carries a per-domain colour, so this is a
// small fixed palette assigned by stable list position. Deliberately
// excludes brand violet (reserved for identity/action per the design's
// "violet means action and nothing else" rule) even though the design
// bundle's OWN placeholder DOMAINS array uses a violet dot for one entry —
// treated here as a placeholder-data inconsistency, not a rule to copy.
const DOMAIN_DOT_PALETTE = ['#3FBFD8', '#79C752', '#E0A33A', '#2FB88A', '#F87F8D', '#A8A8BC'];
function domainDotColor(index) {
  return DOMAIN_DOT_PALETTE[index % DOMAIN_DOT_PALETTE.length];
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
      if (!state.activeSlug || !state.domains.some((d) => d.slug === state.activeSlug)) {
        state.activeSlug = state.domains.length ? state.domains[0].slug : null;
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

  // AI availability is a free, local, no-network check — safe to fetch
  // every time the view mounts.
  try {
    const info = await fetchJSON('/api/health/ai-available');
    if (!isCurrentMount(token)) return;
    state.aiAvailable = !!info.available;
    state.aiProvider = info.provider || null;
    state.aiModel = info.model || null;
  } catch {
    if (!isCurrentMount(token)) return;
    state.aiAvailable = false;
  }

  if (!isCurrentMount(token)) return;
  if (state.activeSlug) {
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
  } else render(token);
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
// would cost money per pair. It is deliberately NOT set for the batch
// merge, a domain switch, a plain rescan, or any other fix, all of which
// invalidate the scan for real.
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
// both writers, are gone; the handoff now goes through the shell's own
// in-memory request/consume pair (app.js), which is cleared on read.
//
// The second of those two functions (requestChatFirstRun) is deleted
// outright rather than rewired: its only caller was the "New domain"
// button, which punted to Chat because this view had no way to create a
// domain. It does now — openLifecycle('create') below — so there is
// nothing left to hand off.
//
// Degradation contract: if app.js's requestChatScope is missing (renamed,
// or not landed yet), warn LOUDLY on the console and still navigate to
// Chat unscoped. A dead button that does nothing is the failure this
// project keeps recording; a button that works slightly less well and says
// so in the console is not.
function goToChatScoped(slug) {
  // VERIFIED against app.js rather than assumed: requestChatScope(slug) only
  // RECORDS the pending request (`_pendingChatScopeRequest = {slug, firstRun}`)
  // — it does NOT navigate. So this call site owns the navigation, and must
  // do it, or the button records a scope nobody goes to see. The record must
  // happen FIRST: chat.js consumes the request synchronously at the top of
  // its onEnter, which navigate() invokes before returning.
  //
  // Exactly ONE navigate() call, deliberately. navigate() does not
  // early-return when the target view is already current — it re-mounts —
  // and consumeChatScopeRequest() CLEARS on read, so a second navigate would
  // find nothing pending and silently drop the scope.
  if (typeof shell.requestChatScope === 'function') {
    shell.requestChatScope(slug);
  } else {
    console.warn('[next/domains] app.js does not export requestChatScope() — opening Chat without a domain scope.');
  }
  navigate('chat');
}

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

// The gate itself. Returns { allowed, reason } so a refusal always has
// something to SAY — a silently-disabled button is how a user concludes
// their click did not register.
function canMergeSemanticPair(pair) {
  const s = activeSemanticScan();
  if (!s) return { allowed: false, reason: 'That scan belongs to a different domain — run a new scan here first.' };
  const idx = s.pairs.indexOf(pair);
  const known = idx !== -1 ? s.pairs[idx] : s.pairs.find((p) => semanticPairKey(p) === semanticPairKey(pair));
  if (!known) return { allowed: false, reason: 'That pair is no longer part of the current scan.' };
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

function renderSidebar(token) {
  if (!isCurrentMount(token)) return;
  const newBtn =
    '<button class="btn btn-primary dm-new-btn" id="dm-new-domain-btn">' + icon('grid', 13) + ' New domain</button>';

  if (!state.loaded) {
    setSidebar('<div class="sidebar-title">Domains</div>' + newBtn + gatedLoader(loadGate, 'Loading…', 'sidebar-hint'), token);
    bindNewDomainBtn();
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
      // domains.css owns where it sits. The wrapper sets no type of its own.
      '<div class="sidebar-title">Domains</div>' + newBtn +
      '<div class="dm-sidebar-status">' +
        renderStatus({ state: 'danger', title: 'Could not load domains', detail: state.loadError }) +
      '</div>',
      token
    );
    bindNewDomainBtn();
    return;
  }
  if (state.domains.length === 0) {
    setSidebar(
      '<div class="sidebar-title">Domains</div>' + newBtn +
      '<div class="cur-eyebrow" style="margin-top:10px">KNOWLEDGE</div>' +
      '<div class="sidebar-note">No domains yet. A domain is one compounding wiki — create your first one above.</div>',
      token
    );
    bindNewDomainBtn();
    return;
  }

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
    return (
      '<button class="dm-row' + (active ? ' active' : '') + '" data-domain-slug="' + escapeHtml(d.slug) + '">' +
        '<span class="dm-row-dot" style="background:' + domainDotColor(i) + '"></span>' +
        '<span class="dm-row-main">' +
          '<span class="dm-row-name">' + escapeHtml(d.displayName || d.slug) + '</span>' +
          '<span class="dm-row-meta mono">' + pagesText + '</span>' +
        '</span>' +
        // ── TWO BADGES WHOSE MEANING WAS HOVER-ONLY ───────────────────
        // `RO` was a <span title="Read-only Shared Brain mirror">, and the
        // attention badge was an EMPTY <span> whose entire content was its
        // tooltip — the purest form of the defect: a keyboard user reached
        // nothing, and on touch, where there is no hover, the issue count did
        // not exist.
        //
        // WHY NOT THE INFO-MARK BUTTON USED IN settings.js: both spans are
        // INSIDE `<button class="dm-row">`, and a <button> inside a <button>
        // is invalid HTML — the browser closes the outer one and the row
        // stops being a single control. So the meaning goes into the row
        // button's own ACCESSIBLE NAME instead, which is reachable precisely
        // because that row IS focusable. `.visually-hidden` is shell.css's
        // existing clip-rect utility; no stylesheet change.
        //
        // STATED RATHER THAN IMPLIED AWAY: this fixes keyboard and screen
        // reader, not sighted-touch, which still sees a glyph. For a sighted
        // user both facts are one tap away on the domain's own detail view —
        // the read-only mirror status box and the `Open issues N` readout —
        // so neither is information that exists nowhere else for them.
        (readonly
          ? '<span class="dm-row-mirror">RO</span>' +
            '<span class="visually-hidden">Read-only Shared Brain mirror</span>'
          : '') +
        (attention
          ? '<span class="dm-row-attn"></span>' +
            '<span class="visually-hidden">' + issueCount + ' open health issue' +
              (issueCount === 1 ? '' : 's') + '</span>'
          : '') +
      '</button>'
    );
  }).join('');

  setSidebar(
    '<div class="sidebar-title">Domains</div>' + newBtn +
    '<div class="cur-eyebrow" style="margin-top:10px">KNOWLEDGE</div>' +
    '<div class="dm-row-list">' + rows + '</div>',
    token
  );

  bindNewDomainBtn();
  document.querySelectorAll('.dm-row[data-domain-slug]').forEach((btn) => {
    btn.addEventListener('click', () => selectDomain(btn.dataset.domainSlug));
  });
}

function bindNewDomainBtn() {
  const btn = document.getElementById('dm-new-domain-btn');
  if (btn) btn.addEventListener('click', () => openLifecycle('create'));
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
  render(myMountToken);
  loadHealth(slug, myMountToken).catch(reportAsyncActionFailure);
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
      emptyCard({ title: 'Could not load domains', body: escapeHtml(state.loadError) }),
      token
    );
    return;
  }
  if (state.domains.length === 0) {
    setMain(
      domainsHeader() +
      renderLifecycleCard() +
      emptyCard({
        title: 'No domains yet',
        body: 'Name it, pick a starting schema, and it is ready to ingest into. Nothing is written until you confirm.',
        actionHtml: '<button class="btn btn-primary" id="dm-empty-new-btn">' + icon('grid', 13) + ' New domain</button>',
      }),
      token
    );
    document.getElementById('dm-empty-new-btn')?.addEventListener('click', () => openLifecycle('create'));
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
  const html =
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
    renderStatCards(counts, pages) +
    renderHealthPanel(domain, readonly) +
    renderBrowsePanel();

  setMain(html, token);
  document.getElementById('dm-ask-btn')?.addEventListener('click', () => goToChatScoped(domain.slug));
  document.getElementById('dm-rename-btn')?.addEventListener('click', () => openLifecycle('rename', domain));
  document.getElementById('dm-delete-btn')?.addEventListener('click', () => openLifecycle('delete', domain));
  bindLifecycleListeners();
  bindHealthListeners(domain, readonly);
  bindBrowseListeners();
}

function renderStatCards(counts, pages) {
  const otherCount = counts.other || 0;
  return (
    '<div class="dm-stats-grid">' +
      '<div class="dm-stat-card"><div class="cur-eyebrow">PAGES</div><div class="dm-stat-value mono">' + pages.toLocaleString() + '</div></div>' +
      '<div class="dm-stat-card"><div class="cur-eyebrow">ENTITIES</div><div class="dm-stat-value mono dm-stat-entity">' + (counts.entities || 0).toLocaleString() + '</div></div>' +
      '<div class="dm-stat-card"><div class="cur-eyebrow">CONCEPTS</div><div class="dm-stat-value mono dm-stat-concept">' + (counts.concepts || 0).toLocaleString() + '</div></div>' +
      '<div class="dm-stat-card"><div class="cur-eyebrow">SUMMARIES</div><div class="dm-stat-value mono dm-stat-summary">' + (counts.summaries || 0).toLocaleString() + '</div></div>' +
      // MEDIUM-2 fix: shown only when non-zero, so the common case (every
      // page fits entities/concepts/summaries) renders identically to
      // before — but when `other` IS non-zero it is never just dropped
      // (see the caller's comment): a fifth stat card, same shape as the
      // other three, not a footnote.
      (otherCount > 0
        ? '<div class="dm-stat-card"><div class="cur-eyebrow">OTHER</div><div class="dm-stat-value mono dm-stat-other">' + otherCount.toLocaleString() + '</div></div>'
        : '') +
    '</div>'
  );
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
];
// How many rows are painted at once. The filter box is the way to reach
// past it; painting 3,300 rows costs more than it tells anyone.
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

async function loadBrowse(slug, token) {
  // Capture the gate for THIS call. `loadGate` is module-scoped and the
  // next mount replaces it, so settling the module variable from a stale
  // in-flight load would decrement the NEXT mount's counter and hide a
  // loader that is legitimately up. A cancelled gate ignores settle(), so
  // the stale path becomes a no-op instead.
  const gate = loadGate;
  state.browse = { slug, loading: true, error: null, entries: [], truncated: false, total: 0, filter: '', folder: 'all' };
  if (gate) gate.begin();
  render(token);
  try {
    const data = await fetchJSON('/api/wiki/' + encodeURIComponent(slug) + '/list');
    if (!isCurrentMount(token)) return;
    const b = state.browse;
    if (!b || b.slug !== slug) return; // domain switched mid-fetch
    b.entries = Array.isArray(data.entries) ? data.entries : [];
    b.truncated = !!data.truncated;
    b.total = b.entries.length;
    b.loading = false;
  } catch (err) {
    if (!isCurrentMount(token)) return;
    const b = state.browse;
    if (!b || b.slug !== slug) return;
    b.loading = false;
    b.error = err.message;
  } finally {
    // MUST be a finally: the two `b.slug !== slug` early returns above
    // (domain switched mid-fetch) would otherwise skip settle and leave
    // the gate pending forever — a loader that appears at 200 ms and never
    // leaves, which is worse than the flash this whole change removes.
    settleGate(gate, () => render(token));
  }
}

function renderBrowsePanel() {
  const b = activeBrowse();
  if (!b) {
    return (
      '<div class="cur-eyebrow dm-recent-eyebrow">PAGES</div>' +
      '<div class="dm-browse-card">' +
        '<div class="dm-browse-lead">' +
          renderDescription('Browse every page in this domain — entities, concepts and summaries.') +
        '</div>' +
        '<button class="btn btn-secondary" id="dm-browse-load-btn">' + icon('book', 13) + ' Browse pages</button>' +
      '</div>'
    );
  }
  if (b.loading) {
    return '<div class="cur-eyebrow dm-recent-eyebrow">PAGES</div><div class="dm-browse-card">' +
      gatedLoader(loadGate, 'Loading pages…', 'dm-browse-empty') + '</div>';
  }
  if (b.error) {
    return (
      '<div class="cur-eyebrow dm-recent-eyebrow">PAGES</div>' +
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

  const matches = filterBrowseEntries(b.entries, b.filter, b.folder);
  const shown = matches.slice(0, BROWSE_RENDER_CAP);
  const tabs = BROWSE_FOLDERS.map((f) => {
    const n = f.key === 'all' ? b.entries.length : b.entries.filter((e) => e.folder === f.key).length;
    return '<button class="dm-browse-tab' + (b.folder === f.key ? ' active' : '') + '" data-browse-folder="' + f.key + '">' +
      escapeHtml(f.label) + ' <span class="mono dm-browse-tab-count">' + n + '</span></button>';
  }).join('');

  const rows = shown.map((e) => (
    '<button class="dm-browse-row" data-browse-path="' + escapeHtml(e.path) + '" data-browse-title="' + escapeHtml(e.title || e.slug) + '">' +
      '<span class="dm-browse-dot dm-browse-dot-' + escapeHtml(e.folder) + '"></span>' +
      '<span class="dm-browse-title">' + escapeHtml(e.title || e.slug) + '</span>' +
      '<span class="mono dm-browse-path">' + escapeHtml(e.path) + '</span>' +
    '</button>'
  )).join('') || renderDescription('No pages match that filter.');

  const capNote = matches.length > shown.length
    ? '<div class="dm-browse-note">Showing the first ' + shown.length + ' of ' + matches.length.toLocaleString() + ' matches — narrow the filter to see the rest.</div>'
    : '';
  const truncNote = b.truncated
    ? '<div class="dm-browse-note dm-quick-note-busy">' + icon('alertTriangle', 12) + ' This domain has more pages than the listing endpoint returns — the list below is incomplete.</div>'
    : '';

  return (
    '<div class="cur-eyebrow dm-recent-eyebrow">PAGES</div>' +
    '<div class="dm-browse-card">' +
      '<div class="dm-browse-controls">' +
        '<input class="dm-browse-filter" id="dm-browse-filter" type="text" placeholder="Filter by name…" value="' + escapeHtml(b.filter) + '" />' +
        '<div class="dm-browse-tabs">' + tabs + '</div>' +
      '</div>' +
      truncNote +
      '<div class="dm-browse-list">' + rows + '</div>' +
      capNote +
    '</div>'
  );
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
          '<button class="btn btn-primary dm-lc-danger-btn" id="dm-lc-submit"' + (busy ? ' disabled' : '') + '>' +
            (busy ? 'Deleting…' : 'Delete permanently') + '</button>' +
          '<button class="btn btn-secondary" id="dm-lc-cancel"' + (busy ? ' disabled' : '') + '>Cancel</button>' +
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
            'next Pull create a second copy alongside it. Rename the brain from the Shared Brain view instead.</div>' +
          '<div class="dm-lc-actions"><button class="btn btn-secondary" id="dm-lc-cancel">Close</button></div>' +
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
          '<button class="btn btn-secondary" id="dm-lc-cancel"' + (busy ? ' disabled' : '') + '>Cancel</button>' +
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
        '<button class="btn btn-secondary" id="dm-lc-cancel"' + (busy ? ' disabled' : '') + '>Cancel</button>' +
      '</div>' +
    '</div>'
  );
}

function bindLifecycleListeners() {
  const f = state.lifecycle;
  if (!f) return;
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
      const b = activeBrowse();
      if (!b) return;
      b.folder = btn.dataset.browseFolder;
      render(myMountToken);
    });
  });

  document.querySelectorAll('.dm-browse-row[data-browse-path]').forEach((btn) => {
    btn.addEventListener('click', () => {
      Promise.resolve()
        .then(() => openWikiPageFromBrowse(btn.dataset.browsePath, btn.dataset.browseTitle))
        .catch(reportAsyncActionFailure);
    });
  });
}

// ── Health panel ───────────────────────────────────────────────────────────

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
    return (
      '<div class="dm-health-card">' +
        '<div class="dm-health-top"><div class="dm-health-head">' + icon('activity', 17) + '<span class="dm-health-title">Wiki health</span></div></div>' +
        '<div class="dm-health-body">Scanning…</div>' +
      '</div>'
    );
  }
  if (state.healthError) {
    return (
      '<div class="dm-health-card">' +
        '<div class="dm-health-top">' +
          '<div class="dm-health-head">' + icon('activity', 17) + '<span class="dm-health-title">Wiki health</span></div>' +
          '<button class="btn btn-secondary" id="dm-rescan-btn">' + icon('refresh', 13) + ' Rescan</button>' +
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
    return '<span class="dm-chip ' + cls + '">' + escapeHtml(cat.label) + ' <span class="mono dm-chip-count">' + count + '</span></span>';
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
  const stamp = report.scannedAt ? 'scanned ' + relTime(report.scannedAt) : null;
  const healthReadouts = renderReadoutGroup([
    { label: total === 1 ? 'Open issue' : 'Open issues', value: total, provenance: stamp },
    { label: 'Entities', value: report.counts.entities },
    { label: 'Concepts', value: report.counts.concepts },
    { label: 'Summaries', value: report.counts.summaries },
    { label: 'Dismissed', value: report.counts.dismissed },
  ]);

  return (
    '<div class="dm-health-card">' +
      '<div class="dm-health-top">' +
        '<div class="dm-health-head">' + icon('activity', 17) + '<span class="dm-health-title">Wiki health</span></div>' +
        '<button class="btn btn-secondary" id="dm-rescan-btn"' + ((busy || revalidating) ? ' disabled' : '') + '>' +
          ((busy === 'rescan' || revalidating) ? buttonRingHtml() + ' Scanning…' : icon('refresh', 13) + ' Rescan') +
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
      '<div class="dm-health-summary">' +
        (revalidating
          ? renderStatus({ state: 'attention', title: 'Re-scanning… showing the previous result',
                           detail: 'The figures below are the last completed scan’s until this one finishes.' })
          : '') +
        healthReadouts +
      '</div>' +
      '<div class="dm-chip-row">' + chips + '</div>' +
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
  return '<div class="dm-banner ' + cls + '">' + ic + '<span>' + escapeHtml(b.text) + '</span></div>';
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
      '<button class="dm-quick-btn" data-action="fixSafe"' + (disableAll ? ' disabled' : '') + '>' +
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
    '<button class="dm-quick-btn dm-quick-btn-ai" data-action="' + key + '"' + (disabled ? ' disabled' : '') + '>' +
      // The sparkles mark (token spend) gives way to the ring only while
      // THIS action is the one running — the spend has already happened by
      // then, and liveness is the useful signal. Every other button keeps
      // its sparkles so the cost warning never disappears from the bar.
      (running ? buttonRingHtml() : icon('sparkles', 12)) +
      '<span class="dm-quick-label">' + escapeHtml(label2) + '</span>' +
      (costText ? '<span class="mono dm-quick-cost">' + escapeHtml(costText) + '</span>' : '') +
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
        '<button class="btn btn-secondary" id="dm-confirm-no">Cancel</button>' +
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
      '<div class="dm-plan-detail mono">' + escapeHtml(body) + '</div>' +
      '<div class="dm-plan-actions">' +
        '<button class="btn btn-primary" id="dm-plan-apply-btn"' + (busy ? ' disabled' : '') + '>' + (busy === p.kind + 'Apply' ? 'Applying…' : 'Apply this plan') + '</button>' +
        '<button class="btn btn-secondary" id="dm-plan-discard-btn"' + (busy ? ' disabled' : '') + '>Discard</button>' +
      '</div>' +
      (crossMountBusy ? '<div class="dm-plan-detail mono dm-quick-note-busy">An earlier operation on this domain is still running.</div>' : '') +
    '</div>'
  );
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
    '<div class="dm-issue-row dm-sem-handled">' +
      '<span class="mono dm-issue-main">' + escapeHtml(p.removeFolder + '/' + p.removeSlug) + ' → ' + escapeHtml(p.keepFolder + '/' + p.keepSlug) + '</span>' +
      '<span class="dm-issue-meta">' + (p.status === 'merged' ? 'merged' : 'skipped') + '</span>' +
    '</div>'
  )).join('');

  return (
    '<div class="dm-plan-card">' +
      '<div class="dm-plan-title">' + pluralize(s.pairs.length, 'candidate pair') + ' found</div>' +
      '<div class="dm-plan-summary">Each merge deletes one page and repoints every [[wikilink]] to it across the domain. ' +
      'Preview a pair to enable its Merge button; Flip swaps which side survives; Skip dismisses the pair so it stops ' +
      'coming back on future scans. ' + GIT_UNDO_WARN + '</div>' +
      batchBar +
      '<div class="dm-sem-list">' + cards + '</div>' +
      (handledRows ? ('<div class="dm-plan-detail mono">Already handled in this scan:</div>' + handledRows) : '') +
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
  const more = issues.length > 50 ? '<div class="dm-issue-more mono">…and ' + (issues.length - 50) + ' more</div>' : '';
  return (
    '<details class="dm-group"' + (open ? ' open' : '') + ' data-group-key="' + cat.key + '">' +
      '<summary class="dm-group-summary">' +
        icon('chevronRight', 13) +
        '<span class="dm-group-label">' + escapeHtml(cat.label) + '</span>' +
        '<span class="dm-group-pill mono">' + issues.length + '</span>' +
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
      if (issue.suggestedTarget) meta = 'suggests ' + escapeHtml(issue.suggestedTarget);
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
      meta = '→ ' + escapeHtml(issue.suggestedSlug || '');
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
        '<span class="dm-group-pill mono">' + count + '</span>' +
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
function aiDisclosureSeen() {
  try {
    return localStorage.getItem(AI_DISCLOSURE_KEY) === 'yes';
  } catch {
    return false;
  }
}

function markAiDisclosureSeen() {
  // A write failure here just means the modal shows again next time (the
  // fail-closed direction) — never a reason to treat consent as recorded.
  try { localStorage.setItem(AI_DISCLOSURE_KEY, 'yes'); } catch { /* ignore */ }
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
    if (scan) scan.preview = { key, error: err.message };
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
        setSemanticPairMessage(key, { error: 'The server refused this merge (the pair failed validation on disk).' });
      } else {
        markSemanticPairStatus(pair, 'merged');
        state.banner = { tone: 'success', text: 'Merged ' + pair.removeSlug + ' → ' + pair.keepSlug + '.' };
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
  // keepSemanticScan: the remaining pairs in this scan are still valid and
  // re-earning them costs a paid LLM pass. See resetDomainScopedHealthState.
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

function render(token) {
  renderSidebar(token);
  renderMain(token);
}

registerView('domains', {
  onEnter(mountToken) {
    myMountToken = mountToken;
    loadGate = createLoadingGate({
      onChange: () => { if (isCurrentMount(mountToken)) render(mountToken); },
    });
    loadGate.begin();
    loadDomainsList(mountToken).catch((err) => reportAsyncMountFailure(mountToken, err));

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
    state.aiProgress = null;
      // Timer hygiene (load-bearing): an armed delay timer that survives
      // this teardown would paint a loader into whatever view comes next.
      if (loadGate) { loadGate.cancel(); loadGate = null; }
    };
  },
});
