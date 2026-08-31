// The Curator — Phase 1 UI redesign shell.
//
// This is a parallel, standalone shell served at /next. It shares nothing
// with src/public/app.js (the shipping app) — no imports, no globals, no
// shared state. Vanilla JS, ES modules (native in every evergreen browser
// — no build step), matching the constraint the design components (React,
// but hookless/stateless-beyond-props) were chosen under: port the
// PATTERN, not the framework.
//
// This file owns the shell infrastructure: a view registry + navigate()
// that enforces two hard rules from the design spec (README.md
// "Interactions & behaviour" + screen 7):
//   1. An overlay (the wiki reader) must never survive a view change.
//   2. Rail navigation always clears the reader AND closes the model
//      picker, unconditionally, before the new view mounts.
// Rule 1 is enforced directly, inline, in navigate() below — the reader is
// global shell state, so there's nothing else to coordinate with.
// Rule 2's other half — the composer's model/length picker — is OWNED by
// whichever view renders it (today: Chat), so navigate() can't reach in
// and close it directly. It's enforced instead via the teardown contract
// every view already gets (see registerView() below): navigate() runs the
// outgoing view's teardown before the next view mounts, and a view holding
// picker-like transient UI state MUST reset it there. See navigate()'s own
// comment for the pointer to where that actually happens today.
//
// Each of the 7 views lives in its own file under views/, imported below
// (see "View registration") for its side effect of calling registerView()
// at its own top level. That import is a real ES-module cycle — every
// views/*.js imports THIS module's exports, and this module imports every
// views/*.js — see the comment at the import block for how that cycle is
// kept safe.
//
// ── Exported shell API — import these from '../app.js' in a view file ──
//
//   registerView(name, { onEnter, onExit })
//     Registers a view under `name`. onEnter(mountToken) runs whenever
//     navigate(name) is called; it may return a teardown function, which
//     navigate() calls right before the NEXT view mounts (use this for
//     timers/listeners that would otherwise outlive one render — most
//     views don't need it). onExit() runs on navigating AWAY from this
//     view, after teardown. Both are optional — omit whichever you don't
//     need. onEnter receives one argument, `mountToken` — see
//     isCurrentMount() below; a view with no async work in onEnter (most
//     of them) can ignore the parameter entirely.
//     If onEnter THROWS, navigate() catches it, renders a visible error
//     card in place of that view (rather than leaving main/sidebar blank —
//     see navigate()'s own comment), and does NOT persist this view as the
//     saved one to restore on the next launch.
//   navigate(name)
//     Switches the active view. Never re-implement the reader/model-picker
//     close rules in a view — navigate() already enforces both before your
//     onEnter runs, unconditionally, for every view.
//   isCurrentMount(mountToken)
//     Returns true iff `mountToken` (the value your onEnter received) still
//     matches the currently mounted view. navigate() bumps the token on
//     EVERY call — including re-entering the same view by name — so a
//     view's async function (a fetch started in onEnter, or in a click
//     handler while the view is mounted) should capture the token ONCE, as
//     a local variable, at the point where it is still known-fresh (the top
//     of onEnter, or the top of a handler invoked synchronously by a real
//     user event — never by re-reading a view's own module-level "current
//     token" variable after an await, which is exactly the bug this
//     paragraph used to invite: that variable gets OVERWRITTEN by the next
//     mount, so a stale continuation that reads it late sees the NEW mount's
//     token and wrongly concludes it is still current. Re-audit finding H1,
//     reproduced in both Chat and Domains before this fix: mount A, navigate
//     to another view (bumping the token, re-running the same file's
//     module-level "myMountToken" to the new value), navigate back — a
//     still-pending fetch from mount A reads the module variable, sees the
//     value the LATEST mount just wrote, and paints A's stale result as if
//     it were current). Thread that captured local through to
//     setSidebar/setMain/openReader as their trailing `token` argument (see
//     below) rather than re-deriving it — those three functions now
//     independently refuse to touch the DOM for a stale token, so getting
//     the capture-and-thread discipline right at even ONE of the two
//     layers (the call site's own early-return, or the primitive's own
//     guard) is enough to stay correct; getting it right at both is what
//     this codebase actually does now, in all four views with real async
//     work. (Settings and Sync used to predate the token primitive and use
//     a hand-rolled `let mounted = false` module flag instead — a THIRD
//     re-audit round found this was not actually equivalent: a boolean can
//     say "is SOME mount of this view still current" but not "is THIS
//     mount still current", which is the entire distinction the token
//     exists to make. Demonstrated live: mount A's abandoned sync push/pull
//     result surfaced under mount B. Both views were migrated to the same
//     token discipline as Chat/Domains; there is no longer a second
//     mechanism anywhere in this shell.)
//   openReader(content, token) / closeReader()
//     Opens/closes the global reader overlay (covers the main column only;
//     rail + sidebar stay live). Any view may open it; only navigate()'s
//     hard rule, Esc, the scrim, and the close button ever close it.
//     `content` is a plain object — every field optional except `slug`:
//       slug              string   — header path chip; also the title
//                                    fallback if `title` is omitted.
//       title             string   — page heading shown in the body.
//       type              string   — 'entities'|'concepts'|'summaries'|null,
//                                    drives the colored type badge.
//       typeLabel         string   — badge text; falls back to `type`, then
//                                    'page'.
//       tags              string[] — plain tag chips rendered after the
//                                    type badge.
//       readonly          boolean  — shows the read-only-mirror banner.
//       loading           boolean  — renders a loading placeholder in place
//                                    of everything below (tags/body/
//                                    backlinks). Call openReader() again
//                                    with the real content once it arrives;
//                                    the scrim/header are patched in place,
//                                    not torn down.
//       error             string   — renders an error message instead of
//                                    content (mutually exclusive with a
//                                    normal render; `loading` wins if both
//                                    are set).
//       bodyHtml          string   — pre-rendered, already-sanitized HTML
//                                    for the page body. The caller owns
//                                    sanitization — this is inserted as-is.
//       backlinks         Array<{path, title, type}> — rendered as
//                                    clickable rows; `type` drives the same
//                                    color dot as the type badge.
//       onBacklinkClick   function(path, title) — called when a backlink
//                                    row is activated. The reader does not
//                                    navigate itself; the caller decides
//                                    (typically by calling openReader()
//                                    again for the new page).
//       domain            string   — the domain this page belongs to. The
//                                    ONE fact the reader cannot derive for
//                                    itself, and the only thing an entry
//                                    point contributes to the RAW-source
//                                    bar (see "Reader RAW-source bar"
//                                    below — all of the behaviour lives
//                                    here, in the shell). Omit it and the
//                                    bar is simply not shown and no
//                                    request is made: degraded, never
//                                    wrong.
//   setSidebar(html, token) / setMain(html, token)
//     Replace the contextual sidebar / main column content for the view
//     currently mounting. Call once each from onEnter. html is raw markup
//     you build yourself — escape untrusted text with escapeHtml first.
//     `token` is the SAME mount-token contract as isCurrentMount() above:
//     pass the token your call site captured (at onEnter, or at the top of
//     the async function that's about to paint) and this function refuses
//     to touch the DOM if that token is no longer the current mount. This
//     is a second, independent guard layer — not a replacement for
//     checking isCurrentMount() yourself where you also need to skip WORK
//     (building a big HTML string, firing a further fetch) on a stale
//     continuation, only for the DOM write itself.
//
//     MEDIUM-3 fix (re-audit, second round): `token` used to be optional —
//     a call site that omitted it got the OLD, unguarded behaviour, which
//     is exactly how Settings/Sync silently opted out of protection (see
//     the isCurrentMount comment above). It is now REQUIRED and fails
//     CLOSED on omission (isCurrentMount(undefined) is always false, and a
//     console.warn names the offending call site) — every real view passes
//     the mountToken its onEnter received, shared.js / memory.js /
//     ingest.js included. (This comment used to call those three
//     "synchronous stub views ... which have no staleness window of their
//     own". They were, once. They are not now: each one awaits real fetches
//     and guards its own continuations with isCurrentMount, so they pass
//     the token because they need it, not as ceremony.) That parameter is
//     already sitting right there for free; there is no longer a way to opt
//     out by forgetting one argument.
//   eyebrow(text)
//     Small-caps label rendered above a view's <h1>. Escapes `text`.
//   emptyCard({ title, body, actionHtml? })
//     The standard "not wired up yet" placeholder card used by every view
//     stub. `title` is escaped here; `body`/`actionHtml` are raw HTML —
//     escape any interpolated text yourself before passing them in.
//   icon(name, size?)
//     Inline SVG for one of the names in ICON_BODY below (defaults to a
//     plain dot for an unknown name). size defaults to 19 (px).
//   escapeHtml(s)
//     HTML-escapes a string. Use before interpolating any data/user text
//     into html you pass to setSidebar/setMain/openReader.
//   beginDomainWrite(domain, opLabel?)
//     Registers one destructive write as in-flight against `domain` and
//     returns a RELEASE FUNCTION — call it exactly when the write finishes
//     (success or failure). There is no separate "end" call that takes a
//     domain string back; the returned function has already closed over
//     the right one, which is what makes the shipping app's H2 leak (see
//     the "Cross-view write gate" comment near the implementation, below
//     setSidebar/setMain) structurally impossible to reproduce here — a
//     caller has no second copy of the domain to let drift from the first.
//     Calling the handle twice is a safe no-op. `opLabel` is a short string
//     ('ingest', 'push', ...) surfaced by getDomainWriteLabel(); omit it
//     for a generic 'write'.
//   isDomainWriteBusy(domain) / isAnyWriteBusy()
//     THE CONTRACT: `true` iff a write is GENUINELY IN PROGRESS this
//     instant — not "an operation exists", not "something was started and
//     might resume later". For a batch ingest job specifically, "in
//     progress" means status === 'running' (see queueBusyTransition,
//     imported by both this file and views/ingest.js — ONE definition of
//     the predicate; a prior version of the shell's own watcher invented
//     a second, narrower one — "not terminal" — and got it wrong: a
//     'paused' job holds no backend write-registry entry either — see
//     src/brain/ingest-queue.js — so treating it as busy made the client
//     STRICTER than the server it is supposed to mirror). Genuinely
//     survives navigating away from and back to ANY view, or a hard page
//     reload — shell state, like the mount token — for every write kind,
//     including a batch job that outlives the view that started it: see
//     reportPossibleActiveJob() below.
//     WHO THIS IS FOR: any view guarding its OWN controls against a write
//     it cares about — either a write IT started (checking its own
//     domain, e.g. an intra-view cross-mount case) or, via isAnyWriteBusy,
//     a write ANY OTHER surface might be making, for a view (Sync,
//     Domains, Settings are the obvious candidates) that wants to disable
//     an action the backend's write-registry would otherwise 409. Which
//     views actually call this today is a fact about the rest of the
//     codebase on any given day — find out with grep, don't trust this
//     comment to have kept it current; it is exactly the kind of claim
//     that goes stale on someone else's unrelated commit.
//   getDomainWriteLabel(domain)
//     The opLabel of the oldest still-open write on `domain`, or null.
//   onWriteGateChange(fn)
//     Subscribe to any begin/release on the write gate (any domain). Returns
//     an unsubscribe function — call it from your view's teardown so a
//     torn-down view doesn't keep reacting to writes after the user has
//     navigated away. A subscriber re-renders its OWN view's controls
//     (setSidebar/setMain as usual); this primitive never touches DOM
//     itself.
//   reportPossibleActiveJob()
//     Tells the shell's active-job watcher (see its own comment near the
//     implementation, below onWriteGateChange) that a batch ingest job
//     might exist and be worth checking — the watcher re-derives truth
//     from GET /api/ingest-queue/active itself rather than trusting the
//     caller (and re-derives "is it BUSY" via queueBusyTransition, not a
//     bespoke check), so this is a cheap, safe-to-call-liberally signal,
//     not a data channel. Safe (a correct no-op) to call for a job that
//     turns out to be paused, pending, or gone. Called by views/ingest.js
//     (from applyQueueJobSnapshot, the one chokepoint every job snapshot
//     flows through, and from checkActiveQueueJob on mount) and once,
//     unconditionally, from boot() below. Never throws, never blocks.
//
// A view file must not import another view file, and must not reach into
// another view's DOM — the rail/sidebar/main/reader are the only shared
// surfaces, and all of them are reached only through the functions above.

// The shell itself is not a "view", so it is not bound by the rule just
// above — this import is FROM the shared logic module (never from a
// views/*.js file) and exists so the active-job watcher (below) answers
// "is this batch writing" with the exact same predicate views/ingest.js's
// own gate handling already uses, rather than a second one that can
// drift from it — see that section's own comment for the regression this
// closed. ../shared/ingest-queue-logic.js imports nothing itself, so this
// creates no cycle.
import { queueBusyTransition } from './shared/ingest-queue-logic.js';

// ── Constants ──────────────────────────────────────────────────────────

const THEME_KEY = 'curator-next-theme';
const VIEW_KEY = 'curator-next-view';
const FONT_SCALE_KEY = 'curator-next-font-scale';

// Rail order matches ARCHITECTURE.md's rail table exactly: your brain
// (Domains) -> your team's brain (Shared Brain) -> your agents' brain
// (Agent memory) -> the way material gets in (Ingest), with Chat as the
// way in to all three ahead of them, then the footer pair.
const NAV_VIEWS = ['chat', 'domains', 'shared', 'memory', 'ingest'];
const FOOTER_VIEWS = ['sync', 'settings'];
const ALL_VIEWS = [...NAV_VIEWS, ...FOOTER_VIEWS];

const VIEW_META = {
  chat:     { label: 'Chat',          icon: 'messageSquare', title: 'Chat' },
  domains:  { label: 'Domains',       icon: 'grid',          title: 'Domains' },
  shared:   { label: 'Shared Brain',  icon: 'users',         title: 'Shared Brain' },
  memory:   { label: 'Agent memory',  icon: 'cpu',           title: 'Agent memory' },
  ingest:   { label: 'Ingest',        icon: 'upload',        title: 'Ingest' },
  sync:     { label: 'Sync',          icon: 'refresh',       title: 'Sync' },
  settings: { label: 'Settings',      icon: 'settings',      title: 'Settings' },
};

// ── Icons ──────────────────────────────────────────────────────────────
// Hand-drawn, Lucide-style (24x24 viewBox, round stroke caps/joins,
// currentColor, stroke-width 1.7) — no icon library dependency, no CDN.
// Each key stands in for a specific real Lucide icon (lucide.dev), named
// here so a later phase can swap in the real path data without having to
// re-derive intent from a hand-drawn approximation:
//   messageSquare -> message-square   grid    -> grid-2x2
//   users         -> users            cpu     -> cpu
//   refresh       -> refresh-cw       settings -> settings
//   upload        -> upload           sun      -> sun
//   moon          -> moon             close    -> x
//   book          -> book-open        layers   -> layers
//   dot           -> (not a Lucide icon; a plain filled circle used as a
//                     small status/marker glyph, e.g. the reader's
//                     "PREVIEW" note)
//
// SHELL GAP #3 fix (this set used to be incomplete — see the historical
// note at the bottom of this comment): every glyph below was independently
// hand-drawn by a view file (chat/domains/settings) in a local table before
// being promoted here. Two rules governed the merge, applied consistently
// rather than case-by-case:
//   - Two views' hand-drawn versions of "the same" icon are collapsed into
//     ONE shared entry only when their path coordinates differ by at most
//     ~0.5 of the 24-unit viewBox (i.e. sub-pixel at every size this app
//     renders icons — genuinely indistinguishable, not just "close enough
//     to eyeball"). That covers chevronDown (identical points, one view
//     had drawn it as a <polyline>, the other as an equivalent <path>) and
//     alertCircle (max coordinate delta 0.5 units between chat's and
//     domains' versions).
//   - Anywhere the delta is larger, or the icon is compositionally
//     different (a different number of sub-shapes), BOTH versions are kept
//     under distinct names so no view's rendered pixels change at all:
//     lock/lockAlt, check/checkAlt, sparkles/star.
//   paperclip     -> paperclip          send      -> send
//   search        -> search             plus      -> plus
//   trash         -> trash-2            chevronDown -> chevron-down
//   alertCircle   -> alert-circle       activity  -> activity
//   chevronRight  -> chevron-right      lock      -> lock (domains' version)
//   lockAlt       -> lock (settings' version, ~12% larger body)
//   check         -> check (domains' version)
//   checkAlt      -> check (settings' version)
//   sparkles      -> sparkles (domains' version — star + 2 mini sparkles)
//   star          -> sparkles, simplified (settings' version — star only)
//   folder        -> folder             x         -> x
//   alertTriangle -> triangle-alert     dotRing   -> (not a Lucide icon;
//                     a plain ring used as a neutral/idle status glyph)
//   copy          -> copy

const ICON_BODY = {
  messageSquare: '<path d="M4 4.5h16a1 1 0 0 1 1 1V16a1 1 0 0 1-1 1H9l-4.6 3.68A.5.5 0 0 1 3.6 20.3V17H4a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1z"/>',
  grid: '<rect x="3.5" y="3.5" width="7.5" height="7.5" rx="1.4"/><rect x="13" y="3.5" width="7.5" height="7.5" rx="1.4"/><rect x="3.5" y="13" width="7.5" height="7.5" rx="1.4"/><rect x="13" y="13" width="7.5" height="7.5" rx="1.4"/>',
  users: '<circle cx="8.5" cy="8" r="3"/><path d="M2.5 20a6 6 0 0 1 12 0"/><circle cx="16.7" cy="9" r="2.4"/><path d="M15 12.2a5 5 0 0 1 6.5 4.8"/>',
  cpu: '<rect x="6.5" y="6.5" width="11" height="11" rx="1.6"/><rect x="10" y="10" width="4" height="4" rx="0.8"/><path d="M9 3v2.3M15 3v2.3M9 18.7V21M15 18.7V21M3 9h2.3M3 15h2.3M18.7 9H21M18.7 15H21"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.5-4.5M4 4.5V9h4.5"/><path d="M4 13a8 8 0 0 0 14.5 4.5M20 19.5V15h-4.5"/>',
  // DEFECT 1 FIX (v3.7.x visual pass): this used to be a circle + 8 short
  // spoke lines with the actual gear-teeth outline hidden behind
  // `opacity="0"` — i.e. it rendered as a smaller, shorter-rayed copy of
  // the `sun` glyph directly below, which is exactly why the theme toggle
  // and the Settings rail button read as the same icon. Replaced with a
  // real cog: a ring + a smaller center hole + 8 short teeth that TOUCH
  // the ring (no gap), as opposed to sun's small dot with long rays that
  // float clear of it — the two are unambiguous at any size, including
  // the 18px the rail footer renders at. Deliberately simple (3 flat
  // primitives, no bezier teeth) rather than a literal Lucide-style cog —
  // an intricate gear turns to mush at 18px.
  settings: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.6"/><path d="M19 12h2.2M17 17l1.5 1.5M12 19v2.2M7 17l-1.5 1.5M5 12h-2.2M7 7l-1.5-1.5M12 5v-2.2M17 7l1.5-1.5"/>',
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.4M12 19.1v2.4M4.2 4.2l1.7 1.7M18.1 18.1l1.7 1.7M2.5 12h2.4M19.1 12h2.4M4.2 19.8l1.7-1.7M18.1 5.9l1.7-1.7"/>',
  moon: '<path d="M20 13.6A8.5 8.5 0 1 1 10.4 4a6.6 6.6 0 0 0 9.6 9.6z"/>',
  close: '<path d="M5 5l14 14M19 5 5 19"/>',
  book: '<path d="M4 4.8A1.8 1.8 0 0 1 5.8 3H12v18H5.8A1.8 1.8 0 0 1 4 19.2z"/><path d="M20 4.8A1.8 1.8 0 0 0 18.2 3H12v18h6.2a1.8 1.8 0 0 0 1.8-1.8z"/>',
  layers: '<path d="M12 3 3 8l9 5 9-5z"/><path d="m3 13 9 5 9-5"/><path d="m3 17.5 9 5 9-5"/>',
  upload: '<path d="M12 16V4M7.5 8.5 12 4l4.5 4.5"/><path d="M4.5 16v2.8A1.7 1.7 0 0 0 6.2 20.5h11.6a1.7 1.7 0 0 0 1.7-1.7V16"/>',
  dot: '<circle cx="12" cy="12" r="3.2"/>',

  // Promoted from views/chat.js's local table (defect 3):
  paperclip: '<path d="M8 12.5 15.5 5a3 3 0 1 1 4.24 4.24L11 17.99a5 5 0 1 1-7.07-7.07L12 2.85"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  send: '<path d="M4.5 19.5 20 12 4.5 4.5 4.5 10.2 14.5 12 4.5 13.8z"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M20 20l-4.8-4.8"/>',
  plus: '<path d="M12 4.5v15M4.5 12h15"/>',
  trash: '<path d="M4.5 6.5h15M9.5 6.5V4.8a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.7M6.5 6.5l.7 12.4a1.5 1.5 0 0 0 1.5 1.4h6.6a1.5 1.5 0 0 0 1.5-1.4l.7-12.4"/>',
  alertCircle: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>',

  // Promoted from views/domains.js's local table (defect 3):
  activity: '<path d="M2 12h4l3-9 6 18 3-9h4"/>',
  sparkles: '<path d="M12 3l1.6 4.9L18.5 9l-4.9 1.6L12 15.5l-1.6-4.9L5.5 9l4.9-1.6z"/><path d="M19 3.2v3.1M20.6 4.75h-3.1"/><path d="M5 17v2.3M6.15 18.15H3.85"/>',
  chevronRight: '<path d="M9 5l7 7-7 7"/>',
  lock: '<rect x="5" y="10.4" width="14" height="9.1" rx="1.8"/><path d="M8 10.4V7.6a4 4 0 0 1 8 0v2.8"/>',
  check: '<path d="M5 12.6l4.6 4.6L19 7.5"/>',

  // Promoted from views/settings.js's local table (defect 3). Kept
  // distinct from domains' lock/check/sparkles — see the merge-rule note
  // above.
  lockAlt: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  star: '<path d="m12 3-1.9 5.8L4 10.5l6.1 1.7L12 18l1.9-5.8L20 10.5l-6.1-1.7z"/>',
  checkAlt: '<path d="M20 6 9 17 4 12"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  alertTriangle: '<path d="M12 9v3.6M12 16.6h.01"/><path d="M10.4 3.6 2.2 18a1.8 1.8 0 0 0 1.55 2.7h16.5A1.8 1.8 0 0 0 21.8 18L13.6 3.6a1.8 1.8 0 0 0-3.2 0z"/>',
  dotRing: '<circle cx="12" cy="12" r="8"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="1.6"/><path d="M4 16V5.6A1.6 1.6 0 0 1 5.6 4H16"/>',
};

// DEFECT 1 FIX, the class-level half: `icon()` used to fall back to
// ICON_BODY.dot for any unrecognised name — a real, legitimate glyph used
// elsewhere as a status marker. That is how a broken/missing icon shipped
// unnoticed: the fallback looked like a plausible glyph instead of an
// obviously-wrong one. `dot` is a single small filled circle; nothing on
// screen would ever flag it as "the icon system failed here". A missing
// name now renders a dashed box with an X through it — a shape that does
// not resemble any real icon in ICON_BODY, so it cannot be silently
// mistaken for one — and logs loudly so it's caught in dev, not guessed
// at from a screenshot. See test-next-icons.js for the companion static
// assertion (every VIEW_META[*].icon name exists in ICON_BODY) that
// catches this class of bug BEFORE it ever reaches icon() at runtime.
const MISSING_ICON_BODY = '<rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="3 2"/><path d="M8 8l8 8M16 8l-8 8"/>';

export function icon(name, size) {
  const known = Object.prototype.hasOwnProperty.call(ICON_BODY, name);
  if (!known) {
    console.error('[icon] unknown icon name: "' + name + '" — rendering the missing-icon placeholder instead of guessing.');
  }
  const body = known ? ICON_BODY[name] : MISSING_ICON_BODY;
  const px = size || 19;
  return (
    '<svg width="' + px + '" height="' + px + '" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" ' +
    'aria-hidden="true">' + body + '</svg>'
  );
}

// ── State ──────────────────────────────────────────────────────────────

const state = {
  view: null,
  theme: 'dark',
  reader: null,          // { slug, title } or null — overlay open/closed
  fontScale: 'default',  // key into FONT_SCALES — see the Text scale section
};

// ── View registry ──────────────────────────────────────────────────────
//
// Each view registers { onEnter, onExit }. onEnter may return a teardown
// function; navigate() calls it before the next view mounts. This is the
// generic replacement for an `if (target === 'x') { ... } else if (...)`
// chain — views are self-contained and don't know about each other.
//
// `registry` is deliberately `var`, left WITHOUT a top-level initializer,
// and lazily created inside registerView()/navigate() — not
// `const registry = new Map()`. Reason: every views/*.js file imports this
// module AND is imported BY this module (see "View registration" below),
// a real ES-module cycle. Per the spec, a module's dependencies are fully
// evaluated before its OWN top-level statements run — so when the view
// files' top-level `registerView(...)` calls execute, none of THIS
// module's own top-level code (including a `const registry = new Map()`
// line) has run yet. A `const`/`let` binding is in its temporal dead zone
// until its declaration statement actually executes, so reading it that
// early throws; `var` avoids the TDZ (it's `undefined` from the start),
// and the `if (!registry)` guards below create the Map on first use,
// whichever caller reaches it first.
var registry;
var currentTeardown = null;

// ── Mount tracking (async-render guard — H2/H3 fix) ─────────────────────
// Bumped by navigate() on EVERY call, including re-entering the view that
// was already active. A view captures the token its onEnter received (or
// reads it fresh at the top of a click handler while it's the mounted
// view) and compares against isCurrentMount() after any await, before
// touching shared shell surfaces. Kept as a plain module-level counter,
// not `state.view`-keyed — comparing view NAMES would wrongly treat a
// leave-and-return to the same view as "still current" for an async
// operation that was actually abandoned when the user first navigated
// away (its response may itself be stale/superseded by then).
let mountToken = 0;

export function isCurrentMount(token) {
  return token === mountToken;
}

export function registerView(name, def) {
  if (!registry) registry = new Map();
  registry.set(name, def || {});
}

// ── View enter motion ────────────────────────────────────────────────────
// The class shell.css hangs the enter animation on. A named constant here
// and a matching literal there is exactly the kind of pair that drifts: a
// rename in one file and not the other kills the motion outright, with no
// error, no console warning and nothing else able to see it. Pinned by
// scripts/test-next-view-enter-motion.js.
const VIEW_ENTER_CLASS = 'view-enter';

// The two STABLE shell containers.
//
// NOT `.main-inner` / `.sidebar-inner`: setMain()/setSidebar() replace those
// on every call, and the two most-used views call setMain TWICE per entry
// (domains.js paints a "Loading…" placeholder and chat.js paints its own
// first frame — VERIFIED 2026-08-26: chat.js contains no "Loading" string,
// so do not go hunting for one — then each replaces
// it with the loaded state), so animating the inner element would double-
// fire on exactly those screens. These two ids persist across both writes.
//
// `view-root`, NOT `main`: a transform on #main becomes the containing block
// for #reader-root's `position: fixed` scrim, silently re-anchoring the
// reader overlay to the main column. #view-root is #reader-root's SIBLING.
// See shell.css's "View enter motion" block for the full reasoning — the
// wrong id here is a reader bug, not a cosmetic one.
const VIEW_ENTER_TARGETS = ['view-root', 'sidebar'];

/** Restart the shell's enter animation on both stable containers.
 *
 *  Purely cosmetic and deliberately inert: it touches no mount token, no
 *  teardown, no view state and no persisted key, it never gates rendering
 *  or changes pointer-events, and nothing it does is observable by a view.
 *
 *  Null-safe on every element — a missing shell container must never throw
 *  out of navigate(). That is this file's standing module-scope discipline:
 *  an unguarded dereference here used to ship a blank page to every user.
 *
 *  remove → forced reflow → add is the restart idiom. Removing and re-adding
 *  a class within one task is otherwise coalesced by the style engine and
 *  the animation never re-runs, so a rail click on the ALREADY-ACTIVE view
 *  would produce no motion at all.
 */
function playViewEnter() {
  for (const id of VIEW_ENTER_TARGETS) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.classList.remove(VIEW_ENTER_CLASS);
    void el.offsetWidth; // force reflow so the re-add restarts the animation
    el.classList.add(VIEW_ENTER_CLASS);
  }
}

export function navigate(name) {
  if (!registry || !registry.has(name)) return;

  // Hard rule (design spec, "Interactions & behaviour"): rail selection
  // clears the reader and closes the model picker. This runs on EVERY
  // navigation, unconditionally, before anything else — a view is never
  // given the chance to leave either open behind it.
  //
  // Reader: global shell state, closed directly, right here.
  //
  // Model/length picker: NOT closed here. It's owned by whichever view
  // renders it (today: Chat's composer, views/chat.js) — this function has
  // no picker state to close. The guarantee instead comes from running the
  // outgoing view's teardown below, BEFORE the next view mounts: chat.js's
  // registerView('chat', ...) returns a teardown that resets its own
  // `state.openPicker` to null. If you're adding a new view with its own
  // popover/dropdown/inline-confirm, reset it in that view's teardown the
  // same way — this is the one place that guarantee is honoured, and nothing
  // here can do it for you.
  closeReader();

  if (currentTeardown) {
    try { currentTeardown(); } catch (err) { console.error('[next] view teardown failed', err); }
    currentTeardown = null;
  }
  const prev = state.view;
  if (prev && registry.has(prev) && typeof registry.get(prev).onExit === 'function') {
    try { registry.get(prev).onExit(); } catch (err) { console.error('[next] onExit failed', err); }
  }

  state.view = name;
  mountToken += 1;
  const myToken = mountToken;

  renderRailActive();

  // Enter motion for the two stable shell containers. Additive and inert —
  // see playViewEnter() above. Fired HERE, once per navigation, rather than
  // from setMain()/setSidebar(), which the busiest views call twice per
  // entry.
  playViewEnter();

  // Rail sync badge, refreshed on every view change. This is the /next
  // equivalent of the shipping app's "refresh on every tab click": the
  // common case is a user doing something that creates pending work (delete
  // a domain, ingest a file, compile a conversation) and then moving to
  // another screen — the badge is correct by the time they land. Never
  // awaited; the function cannot throw.
  refreshSyncBadge();

  const def = registry.get(name);
  let result = null;
  let mountFailed = false;
  try {
    result = typeof def.onEnter === 'function' ? def.onEnter(myToken) : null;
  } catch (err) {
    // A throwing onEnter used to propagate straight out of navigate() —
    // state.view and VIEW_KEY (below) had ALREADY been set by the time it
    // threw, so the rail highlighted this view while main and sidebar
    // stayed exactly as the PREVIOUS view left them (or blank, if this was
    // the very first navigate() of the session). Reproduced by appending a
    // throw to a view's onEnter: the rail lit up, nothing else rendered,
    // and no error was visible anywhere in the UI. Catching here and
    // painting an explicit error card means a broken view degrades loudly
    // instead of silently, and — combined with deferring the VIEW_KEY
    // write below — a reload doesn't land back on the same broken view
    // forever.
    mountFailed = true;
    handleMountFailure(name, err);
  }
  if (typeof result === 'function') currentTeardown = result;

  // Persist the view choice only once onEnter has actually succeeded —
  // see the mountFailed comment above. A failed mount leaves VIEW_KEY
  // pointing at whatever last mounted cleanly, so a reload has an escape
  // hatch instead of reproducing the crash on every launch.
  if (!mountFailed) {
    try { localStorage.setItem(VIEW_KEY, name); } catch { /* private mode etc. */ }
  }
}

// Shared by both failure paths below (the synchronous catch in navigate(),
// and the async reporter a view's own detached background work calls into).
// Renders the error card AND (re-audit finding L1) stops treating the
// broken view as the one to restore on the next launch — previously only a
// SYNCHRONOUS onEnter throw skipped the VIEW_KEY write (mountFailed, above);
// a view that mounted fine yesterday and starts throwing after an update
// (or throws only from its async half, see reportAsyncMountFailure) had
// already been persisted as VIEW_KEY on some earlier, still-good launch, and
// nothing here ever un-persisted it — so every subsequent reload landed
// straight back on the error card with no recovery path but manually
// clearing localStorage. Removing the key (rather than writing 'chat'
// directly) reuses boot()'s own existing fallback-to-chat default, so there
// is exactly one place that decides what "no saved view" means.
function handleMountFailure(name, err) {
  console.error('[next] onEnter failed for view "' + name + '"', err);
  renderMountErrorCard(name, err);
  try { localStorage.removeItem(VIEW_KEY); } catch { /* private mode etc. */ }
  // LOW-8 fix (third re-audit round): a view whose onEnter kicked off
  // MULTIPLE detached loads (or whose `mounted`-boolean predecessor state
  // is still "true") can have a SECOND one resolve after this one already
  // painted the error card — the card's own <div class="main-inner"> has
  // no reader/renderShell of its own to protect it, so that second loader's
  // ordinary render() call silently overwrites it with a half-good view,
  // and VIEW_KEY stays cleared while the card is gone — the failure
  // becomes invisible again. Bumping mountToken here invalidates the
  // failed mount's OWN token retroactively: any isCurrentMount(token)
  // check tied to it — sync or async, this call or a sibling one for the
  // same view — now reads false, same as if the user had already
  // navigated away. The next real navigate() bumps again regardless, so
  // this never collides with a legitimate future mount.
  mountToken += 1;
}

// M1 fix: navigate()'s try/catch above only wraps the SYNCHRONOUS call to
// def.onEnter(myToken) — Chat's boot() and Domains' loadDomainsList() do
// their real work in async functions invoked WITHOUT awaiting (onEnter
// itself is synchronous and returns before either settles), so a throw from
// deep inside one of them becomes a rejected promise that unwinds nowhere
// navigate()'s try/catch can see. Reproduced: appending a throw partway
// through boot() (after its first await) produced a bare console
// "Uncaught (in promise)" entry and otherwise silent UI — no error card,
// mountFailed never flipped, and VIEW_KEY was happily persisted as the
// broken view, so a reload reproduced the crash forever.
//
// A view whose onEnter kicks off detached async work MUST attach
// `.catch((err) => reportAsyncMountFailure(token, err))` to that work,
// passing the SAME token onEnter received (or one captured from it). The
// isCurrentMount() check below is what stops a failure from an ALREADY-
// abandoned mount (the user navigated away before the rejection arrived)
// from painting an error card over whatever view is on screen now — that
// failure genuinely doesn't matter anymore; nothing is showing it.
export function reportAsyncMountFailure(token, err) {
  if (!isCurrentMount(token)) return;
  handleMountFailure(state.view, err);
}

// LOW-7 fix: a user-triggered ACTION (send a message, select a conversation,
// delete one, switch a domain, rescan, run a fix…) that's kicked off
// detached (not awaited by its caller) can ALSO reject unexpectedly — but
// painting the full mount-error card over an otherwise-healthy, still-
// mounted view would be wrong: the view itself didn't fail, one action on
// it did. This is just a console-visible backstop so a genuine bug there
// shows up as a clearly-labelled error instead of a bare, unattributed
// "Uncaught (in promise)" — attach it with `.catch(reportAsyncActionFailure)`
// at any detached action call site that has no more specific handling.
export function reportAsyncActionFailure(err) {
  console.error('[next] action failed:', err);
}

// Rendered by navigate() in place of a view whose onEnter threw. Deliberately
// built here (not via a view's own render helpers, which is exactly what
// just failed) and touches #view-root and #sidebar directly — the same two
// elements setMain()/setSidebar() would have written.
function renderMountErrorCard(name, err) {
  const meta = VIEW_META[name];
  const title = meta ? meta.title : name;
  const detail = err && (err.stack || err.message) ? String(err.stack || err.message) : String(err);

  const sidebar = document.getElementById('sidebar');
  if (sidebar) sidebar.innerHTML = '';

  const root = document.getElementById('view-root');
  if (root) {
    root.innerHTML =
      '<div class="main-inner">' +
        '<div class="mount-error-card" role="alert">' +
          '<div class="mount-error-title">' + escapeHtml(title) + ' hit an error and could not open</div>' +
          '<div class="mount-error-body">Your wiki files on disk are untouched — this is a display problem only. ' +
          'Pick another item in the rail, or reload the page.</div>' +
          '<pre class="mount-error-detail">' + escapeHtml(detail) + '</pre>' +
        '</div>' +
      '</div>';
  }
}

// ── Reader overlay (global — any view can open it) ─────────────────────

// Object.create(null): these are indexed by `p.type`/`b.type`, which comes
// from server-supplied page/backlink data — a page whose folder/type field
// were ever literally "__proto__" (or "constructor", "toString", ...) would
// otherwise resolve to a real Object.prototype member instead of `undefined`
// through a plain `{}`, and the `|| fallback` below wouldn't catch it
// because that member is truthy. A null-prototype object makes every such
// key a normal (missing) own-property lookup — NIT fix, app.js:454.
const READER_TYPE_CLASS = Object.assign(Object.create(null), {
  entities: 'reader-chip-entity',
  concepts: 'reader-chip-concept',
  summaries: 'reader-chip-summary',
});
const READER_TYPE_DOT = Object.assign(Object.create(null), {
  entities: 'background:var(--type-entity)',
  concepts: 'background:var(--type-concept)',
  summaries: 'background:var(--type-summary)',
});

// MEDIUM-3 fix (second re-audit round): `token` used to be OPTIONAL here —
// `if (token !== undefined && !isCurrentMount(token)) return;` — so a call
// site that omitted it entirely got the OLD, unguarded behaviour. That is
// exactly how settings.js and sync.js silently opted out: they kept their
// own hand-rolled `mounted` boolean and never passed a token to
// setSidebar/setMain at all, so the primitive's own guard never even ran
// for them. A boolean can't tell "still mounted" apart from "REmounted"
// (bump the token, re-enter the SAME view by name) — which is the entire
// reason the token exists (see isCurrentMount's doc comment) — so that
// boolean shape reintroduced the identical class of bug this whole
// mechanism exists to close, just in two files instead of none.
//
// Fixed by making the token REQUIRED, not advisory: every real caller now
// passes one, shared.js / memory.js / ingest.js included. Those three were
// once described here as "synchronous stub views ... with no staleness
// window of their own"; that stopped being true as each was built out. All
// three now await real fetches and guard their continuations with
// isCurrentMount, so the token they pass is load-bearing rather than
// ceremony — which is the stronger version of the same point.
// `guardMountToken` below fails CLOSED
// on omission (isCurrentMount(undefined) is always false — mountToken is a
// real number by the time any view can call this) — a forgotten token
// means nothing renders, a loud and immediately visible bug, not a quiet
// reintroduction of the staleness hole — and logs a console.warn naming
// the exact call site, so "make omission impossible" doesn't need a
// SECOND enforcement mechanism on top of the loud failure itself.
function guardMountToken(fnName, token) {
  if (isCurrentMount(token)) return true;
  if (token === undefined) {
    console.warn(
      '[next] ' + fnName + '() called without a mount token — refusing to render. ' +
      'Every caller must pass the token its onEnter received (or captured from it) as the trailing argument.'
    );
  }
  return false;
}

// MEDIUM-3 fix (third re-audit round): the mount token (isCurrentMount)
// only detects a VIEW change — navigate()'s hard rule already closes the
// reader on every one of those, and openWikiReader's captured `mount`
// already covers the case where a citation fetch resolves after the user
// left entirely. But pressing Esc, clicking the scrim, or the ✕ button
// closes the reader WITHOUT any navigation — nothing about the mount
// changes — so a citation click that was still mid-fetch when the user
// closed the reader used to resolve, find the mount still current, and
// call openReader() again, re-opening the overlay on top of whatever the
// user went back to look at. `readerEpoch` is a second, independent piece
// of shell state for exactly this: it bumps on EVERY call to openReader()
// (a new open, or a repaint of the current open — e.g. swapping a loading
// placeholder for fetched content) AND on every closeReader() call. A
// caller captures the value openReader() returns and, after any await,
// checks isCurrentReader(epoch) before painting again — same capture-by-
// value discipline as isCurrentMount, just for "is this reader session
// still the one on screen" rather than "is this view still mounted". This
// also incidentally closes a second race for free: two rapid, DIFFERENT
// citation clicks now correctly let only the later one paint, since the
// second openReader() call bumps past the first one's captured epoch.
let readerEpoch = 0;

// `epoch` must be a value a caller previously got back FROM openReader() —
// see its return-value contract immediately below. Comparing against a
// value from anywhere else (a stale closure variable, a guess) defeats the
// whole mechanism the same way re-reading myMountToken late defeats
// isCurrentMount.
export function isCurrentReader(epoch) {
  return epoch === readerEpoch;
}

export function openReader(content, token) {
  // LOW-2 fix (re-audit, third round): this used to `return readerEpoch`
  // on the guarded (stale-token) path — i.e. the CURRENT epoch, which
  // isCurrentReader() would then report as "yes, still current" to
  // whoever asked. chat.js happens to be safe only because openWikiReader
  // checks isCurrentMount(mount) on the line BEFORE isCurrentReader(epoch)
  // in both its success and catch branches, so a stale-token call here
  // never actually reaches the isCurrentReader check with this bogus
  // "current" value. That ordering is load-bearing and lives in a
  // DIFFERENT file — reorder those two lines, or add a second reader
  // caller that checks isCurrentReader alone, and the Esc race this
  // primitive exists to close comes back silently. Returning -1 instead
  // (readerEpoch only ever increments from 0 and is compared with `===`,
  // so it can never legitimately equal -1) makes a guarded call's return
  // value UNCONDITIONALLY stale, closing the gap without depending on any
  // caller's line order.
  if (!guardMountToken('openReader', token)) return -1;
  readerEpoch += 1;
  state.reader = content || null;
  renderReader();
  return readerEpoch;
}

export function closeReader() {
  readerEpoch += 1;
  if (state.reader === null) return;
  state.reader = null;
  renderReader();
}

// Renders the FULL overlay (scrim + header + body) from `state.reader` on
// every call, including a call that only updates already-open content (e.g.
// a view swapping a loading placeholder for the fetched page, or following
// a backlink to a new page while the overlay stays open). This is safe
// because the "open" class is present in the markup from the very first
// paint (no separate rAF-deferred class toggle drives the entry
// transition), so a full re-paint never restarts or skips an animation —
// verify this holds if that changes. Doing a full re-paint (rather than an
// in-place DOM patch) is what lets this function stay the single source of
// truth for reader markup; no view needs to reach into `.reader-body`.
function renderReader() {
  const root = document.getElementById('reader-root');
  if (!state.reader) {
    root.innerHTML = '';
    return;
  }
  const p = state.reader;
  const title = p.title || (p.slug ? String(p.slug).split('/').pop().replace(/\.md$/, '') : '');

  let bodyInner;
  if (p.loading) {
    bodyInner = '<div class="reader-loading">Loading…</div>';
  } else if (p.error) {
    bodyInner = '<div class="reader-error">' + icon('alertCircle', 15) + ' ' + escapeHtml(p.error) + '</div>';
  } else {
    const typeClass = READER_TYPE_CLASS[p.type] || 'reader-chip-plain';
    const typeDot = READER_TYPE_DOT[p.type] || 'background:var(--border-strong)';
    const typeLabel = p.typeLabel || p.type || 'page';
    const tags = Array.isArray(p.tags) ? p.tags : [];
    const backlinks = Array.isArray(p.backlinks) ? p.backlinks : [];

    const tagsHtml =
      '<div class="reader-tags">' +
        '<span class="reader-tag-chip ' + typeClass + '">' +
          '<span class="reader-type-dot" style="' + typeDot + '"></span>' + escapeHtml(typeLabel) +
        '</span>' +
        tags.map((t) => '<span class="reader-tag-chip reader-chip-plain">' + escapeHtml(t) + '</span>').join('') +
      '</div>';

    // RAW-source bar placeholder. Painted EMPTY and hidden here, then filled
    // in asynchronously by loadReaderSource() below — see that function's
    // header for why the fill is a targeted innerHTML write into this node
    // rather than another openReader() round-trip.

    const backlinksHtml = backlinks.length === 0
      ? '<div class="reader-empty-note">No other page links here yet.</div>'
      : backlinks.map((b, i) => (
          '<button class="reader-backlink-row" data-reader-backlink-index="' + i + '">' +
            '<span class="reader-type-dot" style="' + (READER_TYPE_DOT[b.type] || 'background:var(--border-strong)') + '"></span>' +
            '<span class="mono reader-backlink-slug">' + escapeHtml(b.title || b.path) + '</span>' +
          '</button>'
        )).join('');

    bodyInner =
      (p.readonly ? '<div class="reader-readonly-note">' + icon('alertCircle', 13) + ' Read-only Shared Brain mirror</div>' : '') +
      '<div class="reader-title">' + escapeHtml(title) + '</div>' +
      tagsHtml +
      '<div class="reader-source-bar" id="reader-source-bar" hidden></div>' +
      '<div class="reader-body-text">' + (p.bodyHtml || '') + '</div>' +
      '<div class="reader-backlinks-head">BACKLINKS · ' + backlinks.length + '</div>' +
      '<div class="reader-backlinks">' + backlinksHtml + '</div>';
  }

  root.innerHTML =
    '<div class="reader-scrim open" id="reader-scrim">' +
      '<div class="reader-panel" role="dialog" aria-modal="true" aria-label="Page reader">' +
        '<div class="reader-header">' +
          icon('book', 14) +
          '<span class="reader-path mono">' + escapeHtml(p.slug || '') + '</span>' +
          '<span class="reader-keycap">esc</span>' +
          '<button class="reader-close" id="reader-close-btn" title="Close" aria-label="Close">' + icon('close', 15) + '</button>' +
        '</div>' +
        '<div class="reader-body">' + bodyInner + '</div>' +
      '</div>' +
    '</div>';

  document.getElementById('reader-scrim').addEventListener('click', (e) => {
    if (e.target.id === 'reader-scrim') closeReader();
  });
  document.getElementById('reader-close-btn').addEventListener('click', closeReader);

  if (!p.loading && !p.error && typeof p.onBacklinkClick === 'function') {
    const backlinks = Array.isArray(p.backlinks) ? p.backlinks : [];
    root.querySelectorAll('[data-reader-backlink-index]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const b = backlinks[Number(btn.dataset.readerBacklinkIndex)];
        if (b) p.onBacklinkClick(b.path, b.title);
      });
    });
  }

  if (!p.loading && !p.error) loadReaderSource(p.domain, p.slug, readerEpoch);
}

// ── Reader RAW-source bar (v3.5.0 parity) ──────────────────────────────
//
// "Which original document was this summary built from, and is it still on
// this machine?" v3.5.0 shipped this end to end — a hardened resolver
// (src/brain/raw-store.js), two routes (src/routes/wiki.js), an MCP tool
// and a manifest — and the /next reader was fetching `page.frontmatter`
// and reading only `.tags`, dropping `frontmatter.source` on the floor.
// Cutover without this bar would silently DELETE an in-app feature.
//
// IT LIVES IN THE SHELL, NOT IN A VIEW, ON PURPOSE. The reader is opened
// from two places — a Domains browse row and a Chat citation chip — and a
// second copy of an escape-and-classify guard is the "two hand-maintained
// copies" shape that produced the v3.2.0 CRITICAL. The reader carries the
// whole behaviour; an entry point contributes only the one fact it alone
// knows, the DOMAIN (`content.domain` on the openReader payload). A caller
// that does not supply it gets no bar and no request — degraded, never
// wrong. views/chat.js does not supply it yet; that is one line in its
// paintReaderPage() and is REPORTED, not edited here (file ownership).
//
// describeRawSource() / renderReaderSourceHtml() / formatSourceBytes() are
// deliberately PURE — no DOM, no fetch — so scripts/test-next-raw-source.js
// can extract and execute them standalone. Keep them that way.

function formatSourceBytes(n) {
  if (typeof n !== 'number' || !isFinite(n) || n < 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

// Maps a GET /api/wiki/:domain/source response onto one of the display
// states argued out in v3.5.0, or null to render nothing at all.
//
//   found          — the file is here: name, size, Reveal.
//   missing        — THE NORMAL CASE, not damage. raw/ is gitignored and
//                    never syncs, so a second machine legitimately has the
//                    wiki and not the blobs. The copy has to say that.
//   external       — frontmatter.source is a URL. Classified, shown as
//                    INERT TEXT, never linked and never fetched.
//   no-source      — no `source:` recorded at all (a conversation-compiled
//                    summary, or one written before the field existed).
//                    Renders nothing; classified distinctly anyway so the
//                    suite can prove it was recognised, not fallen through.
//   unsafe         — resolvable name, unopenable target.
//
// Anything NOT explicitly recognised — 'not-a-summary', and any reason a
// future backend adds that this build has never heard of — degrades to
// null. A confidently-wrong bar is worse than no bar; that is the same
// principle raw-store.js applies server-side.
function describeRawSource(result) {
  if (!result || typeof result !== 'object') return null;

  if (result.found === true) {
    return {
      state: 'found',
      filename: typeof result.filename === 'string' ? result.filename : '',
      sizeText: formatSourceBytes(result.bytes),
    };
  }

  const reason = result.reason;

  if (reason === 'external-source') {
    const url = (typeof result.url === 'string' && result.url)
      ? result.url
      : (typeof result.declaredSource === 'string' ? result.declaredSource : '');
    if (!url) return null;
    return { state: 'external', url };
  }

  if (reason === 'missing') {
    const name = typeof result.declaredSource === 'string' ? result.declaredSource : '';
    return {
      state: 'missing',
      text: name
        ? '"' + name + '" isn’t on this machine — raw source files aren’t synced.'
        : 'The original file isn’t on this machine — raw source files aren’t synced.',
    };
  }

  if (reason === 'no-source-recorded') return { state: 'no-source' };

  if (reason === 'unsafe' || reason === 'not-a-file') {
    return { state: 'unsafe', text: 'The recorded source can’t be opened.' };
  }

  return null;
}

// Pure HTML-string builder. `info` is describeRawSource()'s output (or
// null). Every user-controlled string reaches the output ONLY through
// escapeHtml, and never inside an attribute.
//
// THE EXTERNAL CASE IS SECURITY, NOT STYLING. `frontmatter.source` is
// LLM-authored, hand-editable in Obsidian, and arrives over Personal Sync
// and Shared Brain mirrors from other people's machines. Rendering it as
// an <a href> hands a remote author a click-through in the user's app;
// fetching it to preview would make it an SSRF primitive outright. v3.5.0
// asserts that NO HTTP CLIENT EXISTS for this value in either module —
// keep it a plain <span>, and do not add one here either.
function renderReaderSourceHtml(info) {
  if (!info) return '';

  if (info.state === 'found') {
    // Labelled RAW — the maintainer's own call in v3.5.1. `raw/` is the
    // real folder name the code and the docs already use; inventing a
    // second word re-creates the confusion the label was added to fix. A
    // markdown source can produce a summary slug identical to its own
    // filename (the reported case), so without this label the bar looks
    // like it points at the page you are already reading.
    return (
      '<span class="reader-source-label">RAW</span>' +
      '<span class="reader-source-name mono">' + escapeHtml(info.filename) + '</span>' +
      (info.sizeText ? '<span class="reader-source-size">' + escapeHtml(info.sizeText) + '</span>' : '') +
      '<button type="button" class="reader-source-reveal" id="reader-source-reveal">Reveal in Finder</button>' +
      '<span class="reader-source-status" id="reader-source-status"></span>'
    );
  }

  if (info.state === 'external') {
    return (
      '<span class="reader-source-label">RAW</span>' +
      '<span class="reader-source-text">Built from a web page, not a local file:</span>' +
      '<span class="reader-source-url mono">' + escapeHtml(info.url) + '</span>'
    );
  }

  if (info.state === 'missing' || info.state === 'unsafe') {
    return (
      '<span class="reader-source-label">RAW</span>' +
      '<span class="reader-source-text">' + escapeHtml(info.text) + '</span>'
    );
  }

  // 'no-source' — recognised, and deliberately silent.
  return '';
}

// Sequence guard for the async fill. Two rapid opens (a backlink click, a
// second citation chip) must not let the FIRST response paint into the
// SECOND page's bar. `readerEpoch` alone is not enough on its own here
// because a repaint of the same page bumps it too — we check both.
let readerSourceSeq = 0;

// Fills #reader-source-bar in place. Deliberately NOT a re-openReader():
// that repaints the whole overlay, bumps readerEpoch, and would invalidate
// every in-flight caller's captured epoch — including the one that painted
// this page a moment ago.
async function loadReaderSource(domain, pagePath, epoch) {
  const seq = ++readerSourceSeq;
  // Only summary pages can ever record a source. Skipping the request for
  // everything else is not just an optimisation: it keeps the common case
  // (every entity and concept page) free of a round-trip that can only
  // ever come back 'not-a-summary'.
  if (!domain || typeof pagePath !== 'string' || !pagePath.startsWith('summaries/')) return;

  let data = null;
  try {
    const res = await fetch(
      '/api/wiki/' + encodeURIComponent(domain) + '/source?path=' + encodeURIComponent(pagePath)
    );
    data = await res.json().catch(() => null);
    if (!res.ok || !data || data.ok === false) return;
  } catch {
    // The bar sits on top of an already-rendered page. A network hiccup
    // here must not surface as an error over readable content.
    return;
  }

  if (seq !== readerSourceSeq) return;      // superseded by a later open
  if (!isCurrentReader(epoch)) return;      // closed, or repainted, since
  const bar = document.getElementById('reader-source-bar');
  if (!bar) return;

  const html = renderReaderSourceHtml(describeRawSource(data));
  if (!html) { bar.innerHTML = ''; bar.hidden = true; return; }
  bar.innerHTML = html;
  bar.hidden = false;

  const btn = document.getElementById('reader-source-reveal');
  if (btn) btn.addEventListener('click', () => revealReaderSource(domain, pagePath, btn));
}

// Reveal is macOS-only by construction: the route shells out to
// `open -R` and answers 501 everywhere else. Report that honestly in the
// bar rather than leaving a button that just errors.
async function revealReaderSource(domain, pagePath, btn) {
  const statusEl = document.getElementById('reader-source-status');
  const say = (cls, text) => {
    if (!statusEl) return;
    statusEl.className = 'reader-source-status ' + cls;
    statusEl.textContent = text;
  };
  if (btn) btn.disabled = true;
  say('', '');

  try {
    const res = await fetch(
      '/api/wiki/' + encodeURIComponent(domain) + '/source/reveal',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: pagePath }),
      }
    );
    const data = await res.json().catch(() => ({}));
    if (res.status === 501) {
      say('is-error', data.error || 'Revealing a file is only supported on macOS.');
      if (btn) btn.remove();   // it can never work on this machine
      return;
    }
    if (!res.ok || !data.ok) { say('is-error', data.error || 'Could not reveal the file.'); return; }
    say('is-ok', 'Revealed in Finder');
  } catch {
    say('is-error', 'Could not reach the server.');
  } finally {
    if (btn && btn.isConnected) btn.disabled = false;
  }
}

// ── Text scale ─────────────────────────────────────────────────────────
//
// One user-adjustable knob that trades screen real estate against
// legibility across the WHOLE app, not per-view.
//
// HOW IT WORKS. tokens/typography.css's size ramp (--text-2xs .. --text-7xl)
// is now `calc(<base>px * var(--font-scale))`, and --font-scale is defined
// there as 1. Everything downstream — the composed roles (--type-body,
// --type-h1, ...) and every rule in the app that reads a ramp token — moves
// with it for free, because they were already expressed in terms of the
// ramp. This function only ever writes that one custom property on <html>.
//
// WHY DISCRETE PRESETS AND NOT A SLIDER.
//   1. A slider yields values like 1.037, i.e. 14.518px, which the browser
//      renders at sub-pixel sizes that differ per glyph and per platform.
//      Four presets are four layouts, and four layouts can actually be
//      LOOKED AT at both extremes — which is the acceptance criterion here.
//      "It does not break at any point on a continuum" is not checkable.
//   2. It matches what this app already does for presentation choices: the
//      theme control in Settings > General is a segmented control, and the
//      chat Length selector is three named options. A slider would be the
//      only one of its kind.
//   3. It stores as a short enum, so a corrupt value is detectable by
//      exact membership rather than by range-clamping a number.
//
// WHY THE STORED VALUE IS THE NAME AND NOT THE NUMBER. Re-tuning a preset
// later then applies to everyone who chose it, instead of stranding them on
// a numeric literal we no longer ship.
//
// WHY THE RANGE STOPS AT 1.18. Control heights are FIXED (--control-sm 28px
// / --control-md 32px, space.css) and deliberately not scaled — see the
// note there. At 1.18 the largest text that sits inside a 28px control is
// --text-xs 11px -> 12.98px, which at --leading-normal 1.45 is 18.8px and
// clears the box; past roughly 1.25 it does not. Growing the controls too
// would scale the whole chrome, which is browser zoom, not a text setting —
// and browser zoom is already available to anyone who wants it.
//
// WHAT IT DELIBERATELY DOES NOT MOVE. icon() takes a px size as a JS
// ARGUMENT and writes it to the SVG's width/height, and the progress ring
// carries its own geometry — neither reads the type ramp, so both are
// immune by construction rather than by an exception written here. That is
// the intended behaviour: a rail glyph and a ring are diagrams, and a
// diagram that grows with the body text stops lining up with its own row.
//
// KNOWN LIMIT, stated rather than implied away: 22 of the 350 font-size
// declarations under /next are hardcoded px rather than a ramp token (most
// of them in views/chat.css). Those do not scale. They degrade in the safe
// direction — they stay at today's size rather than breaking — and closing
// the gap means editing view CSS owned by other people.

const FONT_SCALES = {
  compact: 0.92,
  default: 1,
  large: 1.09,
  largest: 1.18,
};

const FONT_SCALE_DEFAULT = 'default';

// Presentation order + labels for the Settings control. Kept beside the
// numbers so a new preset cannot be added to one and forgotten in the other.
const FONT_SCALE_OPTIONS = [
  ['compact', 'Compact', 'More on screen'],
  ['default', 'Default', 'As designed'],
  ['large', 'Large', 'Easier to read'],
  ['largest', 'Largest', 'Largest that still fits'],
];

/**
 * Any input -> a scale name that is certainly one of ours.
 *
 * `Object.hasOwn`, NOT truthiness or `in`: FONT_SCALES is a plain object, so
 * `FONT_SCALES['constructor']` is a FUNCTION and `FONT_SCALES['__proto__']`
 * is an object — both truthy, both would sail through a `if (FONT_SCALES[id])`
 * guard and then be written into a CSS custom property as `[object Object]`
 * or the whole source of Object. This repo has shipped that exact bug once
 * (v3.0.9, normalizeResponseStyle) and pre-empted it twice since.
 */
function normalizeFontScale(id) {
  return (typeof id === 'string' && Object.hasOwn(FONT_SCALES, id)) ? id : FONT_SCALE_DEFAULT;
}

/**
 * Apply a scale immediately and remember it. Returns the name actually used,
 * which is not necessarily the one passed in.
 *
 * No reload: writing the custom property on the root element re-resolves
 * every calc() that reads it, in the same frame.
 */
function applyFontScale(id) {
  const chosen = normalizeFontScale(id);
  state.fontScale = chosen;
  document.documentElement.style.setProperty('--font-scale', String(FONT_SCALES[chosen]));
  // Same swallow as applyTheme: private mode / disabled storage must cost
  // the user the persistence, never the setting they just chose.
  try { localStorage.setItem(FONT_SCALE_KEY, chosen); } catch { /* ignore */ }
  return chosen;
}

/** The scale in force, by name. */
export function currentFontScale() {
  return state.fontScale;
}

/** The presets, for a view that renders the control. */
export function fontScaleOptions() {
  return FONT_SCALE_OPTIONS;
}

/**
 * Change the scale from a view. Exported rather than letting a view write
 * the custom property itself, so <html> stays a shell-owned surface (see
 * views/README.md rule 4) and there is one place that both applies and
 * persists — a view that did one without the other is the drift this avoids.
 */
export function setFontScale(id) {
  return applyFontScale(id);
}

// ── Theme ──────────────────────────────────────────────────────────────

function applyTheme(theme) {
  state.theme = theme === 'light' ? 'light' : 'dark';
  // Dark is the unconditional default at bare :root in color.css — there
  // is no [data-theme="dark"] block, so setting the attribute to "dark"
  // is harmless (nothing selects on it) and setting it to "light" is what
  // actually redefines every semantic token. We still set it explicitly
  // both ways so the attribute always reflects the real current state.
  document.documentElement.setAttribute('data-theme', state.theme);
  try { localStorage.setItem(THEME_KEY, state.theme); } catch { /* ignore */ }
  renderRail(); // mark swap is theme-dependent; renderRail() itself calls
  // renderThemeToggleIcon() at its own end (NIT fix — this used to call it
  // again right here, a pure duplicate of the same DOM write).
}

function toggleTheme() {
  applyTheme(state.theme === 'dark' ? 'light' : 'dark');
}

function renderThemeToggleIcon() {
  const btn = document.getElementById('rail-theme-toggle');
  if (!btn) return;
  btn.innerHTML = icon(state.theme === 'dark' ? 'sun' : 'moon', 15);
  btn.title = state.theme === 'dark'
    ? 'Switch to light theme (temporary control — Settings owns this later)'
    : 'Switch to dark theme (temporary control — Settings owns this later)';
}

// ── Rail ───────────────────────────────────────────────────────────────

function renderRail() {
  const rail = document.getElementById('rail');
  // ROOT-ABSOLUTE, and that is load-bearing (found live during the cutover).
  // This was the ONE bare-relative asset reference left in the /next tree, and
  // a relative src resolves against the DIRECTORY OF THE CURRENT URL. While
  // this shell only ever lived at "/next/", 'assets/…' happened to resolve to
  // '/next/assets/…' and looked correct. Post-cutover the same shell is served
  // at "/" and at every SPA path, where it resolved to '/assets/…' and
  // '/some/path/assets/…' — which the SPA catch-all answers with the shell's
  // own HTML at 200 text/html, so the <img> silently rendered broken
  // (measured: naturalWidth 0, and NO 404 to notice in the console).
  //
  // v3.6.1 root-absolutised all 18 references in next/index.html for exactly
  // this reason and pinned them with scripts/test-next-asset-paths.js — but
  // that suite scans index.html, so a ref built in JS was outside its reach.
  // scripts/test-cutover.js now pins this one too.
  const markSrc = state.theme === 'light' ? '/next/assets/mark-small-on-light.svg' : '/next/assets/mark-small-on-dark.svg';

  const navBtns = NAV_VIEWS.map((id) => {
    const meta = VIEW_META[id];
    const badge = id === 'sync' ? '' : ''; // sync badge is in the footer button below
    return (
      '<button class="rail-btn" data-view="' + id + '" title="' + meta.title + '" aria-label="' + meta.title + '">' +
        icon(meta.icon, 19) + badge +
      '</button>'
    );
  }).join('');

  const syncMeta = VIEW_META.sync;
  const settingsMeta = VIEW_META.settings;

  rail.innerHTML =
    '<img class="rail-mark" src="' + markSrc + '" alt="The Curator" width="26" height="26">' +
    navBtns +
    '<div class="rail-spacer"></div>' +
    '<button class="rail-theme-toggle" id="rail-theme-toggle" title="Toggle theme"></button>' +
    '<button class="rail-btn rail-btn-sm" data-view="sync" title="' + syncBadgeTitle(_syncPendingCount) + '" aria-label="' + syncMeta.title + '">' +
      icon(syncMeta.icon, 18) +
      syncBadgeMarkup(_syncPendingCount) +
    '</button>' +
    '<button class="rail-btn rail-btn-sm" data-view="settings" title="' + settingsMeta.title + '" aria-label="' + settingsMeta.title + '">' +
      icon(settingsMeta.icon, 18) +
    '</button>' +
    '<div class="rail-avatar" aria-hidden="true"></div>';

  rail.querySelectorAll('[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => navigate(btn.dataset.view));
  });
  document.getElementById('rail-theme-toggle').addEventListener('click', toggleTheme);
  renderThemeToggleIcon();
  renderRailActive();
  // The innerHTML above paints the LOCAL count only (syncBadgeMarkup takes
  // just that number). Repaint through the one function that knows about
  // both halves, so a rail rebuild never briefly drops the "waiting to
  // pull" part. Cheap and binds nothing — it touches one span and one
  // title attribute.
  applySyncBadge();
}

function renderRailActive() {
  document.querySelectorAll('.rail-btn[data-view]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === state.view);
  });
}

// ── Rail sync badge ─────────────────────────────────────────────────────
// The number of uncommitted local changes, visible from EVERY screen.
//
// This is not decoration. The shipping app grew this badge in
// v3.0.1-beta.5 for one reported failure: a user deleted a domain on one
// machine, assumed it had propagated, and it never had — nothing on any
// other screen told them there was unpushed work. Wiring it back is the
// point of restoring it; `const pendingCount = 0` (what stood here through
// the whole preview) rendered a badge that could only ever be absent, i.e.
// it silently asserted "you are fully synced" to every user, always.
//
// THREE rules, all of which the decision function below enforces and the
// offline suite drives directly:
//
//   1. NOT CONFIGURED ⇒ NO BADGE. A user who has never set up GitHub sync
//      has no "unpushed work" to have; a badge would be noise pointing at
//      a feature they do not use.
//   2. ZERO CHANGES ⇒ NO BADGE. Same shape as the shipping app's.
//   3. FAIL QUIET. Any failure — fetch rejects, non-200, unparseable body,
//      or `getStatus()`'s real `{configured:true, error}` shape (which
//      carries NO changesCount when the git call itself failed) — resolves
//      to 0, i.e. no badge. A badge that LIES about unpushed work is worse
//      than no badge: it is the same false "you are fine" the feature
//      exists to prevent, just with a number on it. Never render a guess.
//
// COST. One GET /api/sync/status, which is a local `git status --porcelain`
// — the same endpoint views/sync.js's own loadStatus() already calls, not a
// second source of truth. It is NOT polled on a tight loop: the refresh is
// event-driven off the same moments the shipping app used (a view change,
// which is this shell's "tab click"; app start; a batch ingest finishing),
// plus one slow 60s safety net for a user who lingers on one screen — the
// identical cadence src/public/app.js has run for many releases.
//
// SCOPE, stated rather than implied: this counts GIT pending changes only.
// The shipping app's badge also adds Shared Brain `pending_pages` from
// /api/sharedbrain/list. That is deliberately NOT carried over here yet —
// it doubles the request count on every refresh, and this defect was about
// the git number being hardcoded to zero. If Shared Brain is added later,
// add it INSIDE syncPendingFromStatus's caller, not as a second badge.
const SYNC_BADGE_REFRESH_MS = 60_000;
let _syncPendingCount = 0;

// ── The other half of the badge: what is waiting on GITHUB ──────────────
//
// The count above is `git status --porcelain` — this machine only. It
// cannot answer the two-machine question ("I pushed from the laptop; does
// the desktop know?"), because nothing local changes when someone else
// pushes. Answering that needs a `git fetch`, which is a network call.
//
// SO IT GETS ITS OWN, MUCH SLOWER CADENCE — this is the cost decision.
// refreshSyncBadge() above runs on a 60s timer AND on every view change;
// putting a GitHub round-trip on that path would mean a network call every
// time the user clicks anything in the rail. Instead:
//
//   - once at boot,
//   - every 10 minutes,
//   - immediately after a push/pull/sync completes (views/sync.js calls
//     the exported refresher, because those are the moments the answer is
//     known to have changed),
//   - and NOT on navigate().
//
// brain/sync.js adds a second, independent bound: a 5-minute server-side
// TTL cache, so a second tab or a future caller that ignores this cadence
// still cannot hammer GitHub.
//
// This is a genuinely separate endpoint, not a second poll of /api/sync/
// status — that route stays local-only and instant, and the guard in
// test-next-recovery-and-badge.js pinning exactly one fetch site for it
// remains true and remains meaningful.
const SYNC_REMOTE_REFRESH_MS = 10 * 60_000;

// Tri-state, matching syncBehindFromRemote(): undefined until the first
// check completes — NOT 0, which would assert "nothing waiting" before we
// have asked anyone.
let _syncBehindCount;

// PURE. Given whatever GET /api/sync/status produced (or null, meaning the
// request did not usably complete), return the number to render. 0 = hide.
function syncPendingFromStatus(status) {
  if (!status || status.configured !== true) return 0;
  const n = status.changesCount;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

// PURE. Both of these are interpolated into an HTML string by renderRail(),
// so neither may ever emit a quote or an angle bracket. They cannot: the
// only variable part is a number that has already been through
// syncPendingFromStatus (finite, > 0, floored), and every other character
// is a literal in this file.
function syncBadgeMarkup(count) {
  return count > 0 ? '<span class="rail-badge">' + count + '</span>' : '';
}
// `behind` is TRI-STATE and every caller must respect all three, because
// collapsing them is the exact defect this feature exists not to have:
//
//   undefined — no remote information at all (never checked yet, or sync is
//               not configured). Say nothing about the remote.
//   null      — we TRIED and could not find out (offline, auth, rate limit,
//               a ref-lock collision). Say that, out loud.
//   a number  — a measured count. 0 is a real, measured "nothing waiting".
//
// A failed check must never render as 0. "We could not ask GitHub" and
// "GitHub has nothing for you" are different facts, and showing the first
// as the second is a confident all-clear we did not earn — the same shape
// as ringValueFromCounts(null, 10) returning 0 because Number(null) is 0.
//
// Called with ONE argument this is byte-identical to the pre-v3.9.1
// function, which is what keeps test-next-recovery-and-badge.js's exact
// string assertions (syncBadgeTitle(0) === 'Sync', and the singular/plural
// local sentences) true. It is also deliberately self-contained — that
// suite extracts this function's source and runs it in a sandbox holding
// only VIEW_META, so calling any helper from here would break it.
function syncBadgeTitle(count, behind) {
  const parts = [];
  if (count > 0) {
    parts.push(count + ' local change' + (count === 1 ? '' : 's') + ' not yet pushed to GitHub');
  }
  if (typeof behind === 'number' && behind > 0) {
    parts.push(behind + ' file' + (behind === 1 ? '' : 's') + ' waiting to pull from GitHub');
  } else if (behind === null) {
    parts.push('could not check GitHub for incoming changes');
  }
  if (!parts.length) return VIEW_META.sync.title;
  return 'Sync — ' + parts.join('; ');
}

// PURE. Turns whatever GET /api/sync/remote-status produced into the
// tri-state above. Distinguishing "not configured" (undefined — the user
// does not use sync, so there is nothing to warn about) from "check failed"
// (null — they do use it and we owe them the truth) is the whole job.
function syncBehindFromRemote(payload) {
  if (!payload || payload.configured !== true) return undefined;
  if (payload.remoteChecked !== true) return null;
  const n = payload.behindFiles;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

// PURE. The badge's visible text.
//
// THE TWO NUMBERS ARE NEVER ADDED. "3 local changes not pushed" and
// "5 files waiting to pull" are different facts about different machines;
// a single "8" would be meaningless and would tell the user to do the wrong
// thing. The down-arrow marks the pull direction and keeps each number
// separately readable in a 15px pill.
//
// A null (failed) or 0 behind adds nothing here — the tooltip carries the
// "could not check" wording, because a badge is too small to be honest in.
function syncBadgeLabel(local, behind) {
  const incoming = (typeof behind === 'number' && behind > 0) ? behind : 0;
  if (local > 0 && incoming > 0) return local + '↓' + incoming;
  if (local > 0) return String(local);
  if (incoming > 0) return '↓' + incoming;
  return '';
}

// Surgical DOM update — deliberately NOT a renderRail() call.
// renderRail() rebuilds rail.innerHTML and re-binds a click listener on
// every [data-view] button; driving a badge refresh through it would
// discard and re-create the whole rail on a 60s timer (and on every
// navigation), which is both wasteful and the classic way to end up with
// duplicate listeners if the rebuild is ever made incremental. This touches
// exactly one <span> and one title attribute, and binds nothing.
function applySyncBadge() {
  const btn = document.querySelector('#rail .rail-btn[data-view="sync"]');
  // Rail not rendered yet — nothing to do; the next renderRail() reads
  // _syncPendingCount for itself and paints the badge from it.
  if (!btn) return;
  const existing = btn.querySelector('.rail-badge');
  btn.title = syncBadgeTitle(_syncPendingCount, _syncBehindCount);
  const label = syncBadgeLabel(_syncPendingCount, _syncBehindCount);
  if (label) {
    if (existing) {
      existing.textContent = label;
    } else {
      const span = document.createElement('span');
      span.className = 'rail-badge';
      span.textContent = label;
      btn.appendChild(span);
    }
  } else if (existing) {
    existing.remove();
  }
}

// Fire-and-forget. NEVER throws and never rejects — every call site below
// invokes it without awaiting, and one of them is inside boot(), where a
// throw would prevent markBooted() from running and paint index.html's
// full-page recovery panel for every user (see boot()'s own comment).
export async function refreshSyncBadge() {
  let next = 0;
  try {
    const res = await fetch('/api/sync/status');
    if (res.ok) next = syncPendingFromStatus(await res.json());
  } catch {
    next = 0; // rule 3: fail quiet, never a stale or guessed number
  }
  _syncPendingCount = next;
  try { applySyncBadge(); } catch { /* rail missing/detached — nothing to show */ }
}

// Fire-and-forget, and NEVER throws — same contract and same reason as
// refreshSyncBadge() above: boot() calls it without awaiting, and a throw
// there would stop markBooted() and paint the recovery panel for everyone.
//
// The catch resolves to null, not undefined: reaching it means the request
// itself failed, which is "we tried and could not find out" — the state the
// tooltip reports honestly — and not "we have not looked yet".
export async function refreshSyncRemoteBadge() {
  let next = null;
  try {
    const res = await fetch('/api/sync/remote-status');
    if (res.ok) next = syncBehindFromRemote(await res.json());
  } catch {
    next = null;
  }
  _syncBehindCount = next;
  try { applySyncBadge(); } catch { /* rail missing/detached — nothing to show */ }
}

// ── Don't poll a window nobody is looking at ────────────────────────────
//
// Both badges above are SHELL-level timers — armed once in boot() for the
// life of the page, unlike a view's own poller, which has a mount/teardown
// to hang a document.hidden check off. In a browser tab that cost nothing,
// because people close tabs. The app now also ships as a window a user may
// leave running all day, so a timer that keeps firing at full cadence while
// that window is hidden is a standing cost paid for nobody: the local one is
// cheap, but refreshSyncRemoteBadge() is a `git fetch` to GitHub — otherwise
// a permanent background network call every 10 minutes for a window nobody
// is looking at.
//
// SKIP the tick, don't stop/restart the interval: SYNC_BADGE_REFRESH_MS and
// SYNC_REMOTE_REFRESH_MS stay exactly as documented above, and each tick
// just declines to fetch while document.hidden is true — the same shape
// views/ingest.js's scheduleActivityPoll() and views/memory.js's
// schedulePoll() already use for their own per-view pollers ("A hidden tab
// reschedules WITHOUT fetching"). Stopping and restarting the interval on
// every visibility flap would mean either re-deriving how long was left
// before the flap, or resetting the cadence outright — which is a change to
// the interval in effect even though the constant is untouched — for no
// benefit a plain skip does not already give.
function refreshSyncBadgeIfVisible() {
  if (typeof document !== 'undefined' && document.hidden) return;
  refreshSyncBadge();
}

function refreshSyncRemoteBadgeIfVisible() {
  if (typeof document !== 'undefined' && document.hidden) return;
  refreshSyncRemoteBadge();
}

// RESUME PROMPTLY ON WAKE, not "whenever the next tick happens to land" —
// same `focus` + `visibilitychange` wake-handler convention as
// views/ingest.js's activityWakeHandler and views/memory.js's wakeHandler
// ("REVALIDATE ON WAKE"). `focus` covers alt-tabbing back; `visibilitychange`
// covers a background tab (or, for the app window, an occluded/minimized
// window) being brought forward, which fires no focus event of its own.
//
// An IMMEDIATE refresh on every wake — not a debounced one — is deliberately
// safe for both calls here, including under someone alt-tabbing repeatedly:
//   - refreshSyncBadge() is a local `git status --porcelain`; cheap no
//     matter how often it's asked.
//   - refreshSyncRemoteBadge() calls GET /api/sync/remote-status, and
//     brain/sync.js already puts a 5-minute server-side TTL cache in front
//     of the actual GitHub network call specifically so "a second tab or a
//     future caller that ignores this [10-minute client] cadence still
//     cannot hammer GitHub" (see SYNC_REMOTE_REFRESH_MS's own comment
//     above). Repeated alt-tabbing re-asks the LOCAL server, not GitHub, so
//     it cannot turn into the network-hammering it looks like at a glance.
//
// Armed once, here, for the page's whole life — these are shell timers with
// no mount/teardown to hang a listener removal off, unlike the per-view wake
// handlers above.
function armSyncBadgeWakeHandler() {
  const wake = () => {
    if (typeof document !== 'undefined' && document.hidden) return;
    refreshSyncBadge();
    refreshSyncRemoteBadge();
  };
  if (typeof window !== 'undefined') window.addEventListener('focus', wake);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', wake);
}

// ── Sidebar + main render helpers shared by view stubs ─────────────────

export function setSidebar(html, token) {
  if (!guardMountToken('setSidebar', token)) return;
  document.getElementById('sidebar').innerHTML = '<div class="sidebar-inner">' + html + '</div>';
}

export function setMain(html, token) {
  if (!guardMountToken('setMain', token)) return;
  document.getElementById('view-root').innerHTML = '<div class="main-inner">' + html + '</div>';
}

/**
 * Run a full re-render WITHOUT throwing the reader back to the top of the
 * page, and with focus returned to the control they were on.
 *
 * THE DEFECT. setMain() replaces #view-root's child wholesale. The scroll
 * container is its PARENT, `.main` (#main, `overflow-y: auto` —
 * shell.css), so the instant innerHTML is cleared the content height is 0,
 * the browser clamps scrollTop to 0, and the replacement content is
 * inserted under a viewport that is now at the top. Focus goes the same
 * way: the focused node no longer exists, document.activeElement falls back
 * to <body>, and the next Tab restarts from the rail.
 *
 * For a view that paints once on entry this is invisible — the user was at
 * the top anyway. For a view that re-renders on ACTION it is the whole
 * defect. Reported against Settings' "Test on my wiki": that panel renders
 * inside an expanded model row a long way down the Providers section and
 * both of its handlers re-render, so pressing the button appeared to eject
 * the user, and pressing Start appeared to eject them again. Note what was
 * NOT wrong there — the fold state survived correctly, so the section was
 * still open the whole time; it was simply off-screen above.
 *
 * THIS IS OPT-IN, and deliberately not folded into setMain() itself.
 * setMain has callers across every view, and views/chat.js drives `.main`'s
 * scroll ITSELF (it pins the thread to the bottom on each new message and
 * scrolls a compile card into view) — a preserve wrapper inside setMain
 * would silently fight that, in someone else's file, with no test in this
 * change able to see it. A view adopts this when its own re-renders are
 * action-driven.
 *
 * It is also why a view does not read #main directly: views/README.md rule
 * 4 says the main column is reached only through the shell functions, and
 * this is that function.
 *
 * FOCUS IS RESTORED BY ID, not by node — the node cannot survive innerHTML
 * replacement. Unlike views/memory.js's version of this (v3.17.1) there is
 * no allow-list of ids, because the containment check below gives the same
 * guarantee structurally: an id is only ever captured if it was focused,
 * inside the two surfaces this shell owns, one turn ago. It can therefore
 * never reach out to the rail or to another view, and it cannot rot the way
 * a hand-listed set of ids does when a control is renamed. A control with
 * no id simply is not restored, which is the safe direction.
 */
export function preserveMainScroll(renderFn) {
  const host = typeof document !== 'undefined' ? document.getElementById('main') : null;
  const top = host ? host.scrollTop : 0;

  let focusId = null;
  const active = typeof document !== 'undefined' ? document.activeElement : null;
  if (active && active.id && typeof active.closest === 'function' &&
      active.closest('#view-root, #sidebar')) {
    focusId = active.id;
  }

  try {
    renderFn();
  } finally {
    // In a `finally` so a throwing render still leaves the user where they
    // were rather than at the top of a half-painted page.
    if (host) {
      // Assigning past the new maximum is clamped by the browser, which is
      // the right degradation: land at the bottom of a page that shrank,
      // never somewhere past its end.
      host.scrollTop = top;
    }
    if (focusId) {
      const el = document.getElementById(focusId);
      // preventScroll: the position was just restored on the line above, and
      // letting the browser scroll the element into view would undo it.
      if (el && typeof el.focus === 'function') {
        try { el.focus({ preventScroll: true }); } catch { /* not focusable in this state */ }
      }
    }
  }
}

/**
 * Send the main column back to the top.
 *
 * The counterpart to preserveMainScroll, and it exists because "preserve"
 * is wrong exactly once: arriving at a DIFFERENT destination. Restoring a
 * scroll offset of 900px into a section the user has never seen lands them
 * in the middle of it with no idea what is above.
 */
export function resetMainScroll() {
  const host = typeof document !== 'undefined' ? document.getElementById('main') : null;
  if (host) host.scrollTop = 0;
}

/**
 * How far `.main` must scroll for [elTop, elBottom] to be fully on screen —
 * the pure decision behind revealInMain, split out so the truth table can be
 * driven exhaustively with no DOM.
 *
 * ZERO WHEN IT IS ALREADY VISIBLE, and that arm is the important one: moving a
 * page the reader did not ask to move is its own defect, so a message that is
 * already on screen must not jolt the view.
 *
 * TWO NON-ZERO ARMS, and they are not symmetric.
 *  · ABOVE the viewport, or TALLER than it — bring the TOP into view. Reading
 *    starts at the first line, and an element scrolled to its last line is
 *    unread even though `getBoundingClientRect` says it intersects.
 *  · BELOW — the SMALLEST move that puts its bottom on screen, so whatever the
 *    reader was looking at (on this screen, the control they just pressed)
 *    stays visible above it wherever the geometry allows.
 *
 * `pad` keeps the element off the exact edge, where a sticky header or a
 * rounded corner can clip the first line of text.
 */
export function mainRevealDelta(hostTop, hostBottom, elTop, elBottom, pad) {
  const nums = [hostTop, hostBottom, elTop, elBottom];
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return 0;
  const p = (typeof pad === 'number' && Number.isFinite(pad)) ? pad : 0;
  const viewport = hostBottom - hostTop;
  const height = elBottom - elTop;
  if (elTop >= hostTop + p && elBottom <= hostBottom - p) return 0;
  if (elTop < hostTop + p || height > viewport - 2 * p) {
    return Math.round(elTop - hostTop - p);
  }
  return Math.round(elBottom - hostBottom + p);
}

/**
 * Scroll `.main` the minimum distance that makes `#<elementId>` visible.
 *
 * WHY THIS IS A SHELL FUNCTION. `.main` is the scroll container and
 * views/README.md rule 4 says a view reaches the main column only through
 * these helpers — the same reason preserveMainScroll lives here rather than in
 * the view that first needed it.
 *
 * WHY IT EXISTS AT ALL. A refusal rendered off-screen is not a refusal. v3.9.0
 * shipped one behind an overlay and the measured consequence was that the user
 * read the unchanged button as "my click didn't register" and clicked again —
 * on a write. Settings reproduced the same shape without an overlay: a build
 * model chosen from a row below the fold rendered its 409 at the top of the
 * block, measured 678px ABOVE the viewport, with nothing at the click site.
 *
 * Returns the applied delta (0 when nothing moved, or when either element is
 * missing) so a caller can be tested on what it actually did.
 */
export function revealInMain(elementId, pad) {
  if (typeof document === 'undefined') return 0;
  const host = document.getElementById('main');
  const el = typeof elementId === 'string' && elementId
    ? document.getElementById(elementId) : null;
  if (!host || !el || typeof el.getBoundingClientRect !== 'function' ||
      typeof host.getBoundingClientRect !== 'function') return 0;
  const h = host.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const delta = mainRevealDelta(h.top, h.bottom, r.top, r.bottom,
    (typeof pad === 'number' && Number.isFinite(pad)) ? pad : 12);
  if (delta !== 0) host.scrollTop += delta;
  return delta;
}

export function eyebrow(text) {
  return '<div class="view-eyebrow cur-eyebrow">' + escapeHtml(text) + '</div>';
}

export function emptyCard({ title, body, actionHtml }) {
  return (
    '<div class="empty-card">' +
      '<div class="empty-title">' + escapeHtml(title) + '</div>' +
      '<div class="empty-body">' + body + '</div>' +
      (actionHtml ? '<div class="empty-action">' + actionHtml + '</div>' : '') +
    '</div>'
  );
}

export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ── Chat scope handoff (Domains -> Chat) ──────────────────────────────────
//
// Two view files, neither owning the other, need to pass one shot of intent
// across a navigate() call: Domains' "Ask this domain" affordance wants the
// NEXT Chat mount to open pre-scoped to a specific domain. This is that
// handoff — MODULE state, deliberately NEVER localStorage. A value written
// to localStorage OUTLIVES the page that asked for it: a stale key from a
// session that clicked "Ask this domain" and then picked a different rail
// item (or reloaded, or just came back an hour later) would silently
// hijack the NEXT time Chat happens to mount, with no relationship to any
// click that actually just happened. Module state has exactly the lifetime
// this needs — gone the instant the tab closes, and (the load-bearing
// half) gone the instant Chat's onEnter actually consumes it.
//
//   requestChatScope(slug)
//     Call with a real domain slug to scope the NEXT Chat mount to that
//     domain. This function only RECORDS the intent — it does not
//     navigate; the caller (Domains) calls navigate('chat') itself
//     immediately after, same division of responsibility as every other
//     cross-view action in this shell.
//
//     Calling with no argument (or any falsy/non-string value) produces
//     firstRun: true on the consumed request instead of a slug — see
//     consumeChatScopeRequest()'s return shape below. NOTHING IN THIS
//     REPO CALLS IT THAT WAY TODAY: `grep -rn "requestChatScope(" src/
//     public/next/` finds exactly one non-definition call site
//     (views/domains.js's goToChatScoped), and it always passes a real
//     slug. Chat originally showed a create-domain panel when a no-slug
//     request arrived (Domains' "+ New domain" button had no domain-
//     creation UI of its own and punted to Chat for it); that panel is
//     gone — Domains creates domains directly now
//     (openLifecycle('create'), a real modal over POST /api/domains), so
//     there is nothing left to hand off. `firstRun` stays part of the
//     return shape rather than being deleted because deleting it would be
//     a breaking change to this function's contract for no present
//     benefit; reviving a Chat-side first-run affordance would mean
//     writing a new producer that calls requestChatScope() with no slug
//     AND a new consumer in chat.js that branches on it again — neither
//     exists today, and this comment is the record of why.
//
//   consumeChatScopeRequest()
//     Returns { slug, firstRun } and CLEARS the pending request in the SAME
//     call. THE INVARIANT THAT MATTERS: if a later, unrelated Chat mount
//     could read the same request again, EVERY subsequent Chat entry would
//     silently re-scope to a stale domain forever — clicking a rail item,
//     reloading, coming back an hour later, all would re-apply a request
//     from one click, long ago. Consume is therefore destructive by
//     construction: reading the pending value and resetting it to null
//     happen as one atomic pair of statements with no `await` between them
//     and no code path that reads without also clearing — there is exactly
//     one function that can observe a pending request, and calling it is
//     what makes it stop being pending. No request pending returns
//     { slug: null, firstRun: false } — the "nothing to apply, mount
//     normally" case, which is also what every SECOND call in a row
//     returns once the first call has consumed it.
//
//     Callers MUST consume synchronously, at the top of onEnter (before any
//     `await`) rather than from inside an async boot() — onEnter runs
//     exactly once per mount and nothing can intervene between navigate()
//     invoking it and the consume happening, whereas a value read after an
//     await could race a second, faster navigate() to the same view. See
//     views/chat.js's onEnter for the real call site.
let _pendingChatScopeRequest = null; // null = nothing pending; else { slug, firstRun }

export function requestChatScope(slug) {
  const clean = (typeof slug === 'string' && slug) ? slug : null;
  _pendingChatScopeRequest = { slug: clean, firstRun: !clean };
}

export function consumeChatScopeRequest() {
  const req = _pendingChatScopeRequest;
  _pendingChatScopeRequest = null;
  if (!req) return { slug: null, firstRun: false };
  return req;
}

// ── Cross-view write gate ────────────────────────────────────────────────
//
// Shell-level replacement for the shipping app's window.__curatorIngestStart
// / __curatorIngestEnd pair (src/public/app.js, "Ingest-busy state" section)
// — a real destructive-write-in-progress signal INTENDED for OTHER views
// (Sync, Domains, Settings are the obvious candidates) to disable
// Push/Pull/Delete/Update while it's true, per the backend's own
// write-registry (src/brain/write-registry.js), which already 409s those
// endpoints mid-write. This section describes the PRIMITIVE and the exact
// guarantee it makes (see the top-of-file docblock's isDomainWriteBusy
// entry for the full contract statement) — which views actually consume
// it is a fact about the rest of the codebase on any given day, not a
// property of this primitive, and is deliberately NOT enumerated here:
// an earlier version of this comment named specific caller counts and an
// independent audit found it had already gone stale once; a docblock
// that promises to track other files' commits is a docblock that lies
// again the next time someone edits one of them without reading this one.
//
// The shipping app tracks the ingest case with two globals that ~8 call
// sites each have to remember to pair correctly — and got it wrong once,
// for real: its own `_queueBusyDomain` comment documents the H2 leak, where
// "enter" was keyed on job.domain but "exit" re-read whatever the
// #ingest-domain dropdown happened to hold at a LATER moment (often '' on a
// page-reload resume, since two un-awaited loads race the select being
// populated) — decrementing the WRONG domain's count and leaving the RIGHT
// one's buttons disabled forever. That bug is a direct consequence of the
// two-call convention: the domain is supplied TWICE, by two different call
// sites, at two different times, and nothing stops them from disagreeing.
//
// This shell's shape makes that specific bug impossible to write, not just
// easier to avoid: beginDomainWrite() does not hand back a domain string for
// a caller to re-supply later. It hands back a RELEASE FUNCTION that has
// already closed over the correct domain — there is no second call site with
// its own copy of the key to drift from the first. Calling the handle twice
// is a harmless no-op (guarded by a private `released` flag in the closure),
// not a double-decrement; losing the handle entirely just leaks that one
// write as permanently "busy" for its domain, which is loud (a button stays
// disabled — matches domains.js's inFlightWriteSlugs failure mode, see its
// MEDIUM-5 comment) rather than silent. An independent adversarial audit
// attacked this core directly — __proto__ as a domain key, a falsy domain,
// double/triple release, a throwing subscriber, refcount drift via equal
// label strings — and could not break it; what it found wrong was the
// guarantee being claimed elsewhere in this file, not this mechanism.
//
// Reference counts are keyed per-domain (a domain slug -> count of open
// handles), same rationale as the shipping app's Map: two concurrent writes
// on DIFFERENT domains must not block each other, and two on the SAME
// domain (a batch queue item + a manually-started single-file ingest, say)
// must both have to release before the domain reads as free.
//
// This state is SHELL state, not view state — declared here, not inside any
// views/*.js — and survives a view's own onEnter/onExit exactly like
// `mountToken` and the reader overlay do. A write started from Ingest and
// still running when the user navigates to Sync and back must still read as
// busy. HOW that holds differs by write kind, and one of the two ways used
// to be wrong: for a SINGLE-FILE ingest it falls out for free — the fetch is
// deliberately never aborted on teardown (views/ingest.js's runIngest has
// its own comment on why), so only ITS OWN `finally`, once the write
// genuinely finishes, ever releases the handle; mount state never enters
// into it. For a BATCH job, teardown deliberately DOES detach the live SSE
// stream on navigate-away (batch jobs are reattachable, unlike single-file,
// so this is the correct choice — see views/ingest.js's file-header
// comment) — and an independent audit found that detach's own `finally`
// was releasing the ONLY handle the batch write held, so the gate read
// false the moment the user left Ingest even though the job kept running.
// Measured live: busy went true -> false -> true across a navigate-away-
// and-back on a still-running batch. Closed by the ACTIVE BATCH-JOB WATCHER
// below (see its own comment), which holds an INDEPENDENT handle sourced
// directly from server truth (GET /api/ingest-queue/active) rather than
// from any one view's stream — the same cross-VIEW generalisation
// domains.js's own inFlightWriteSlugs deliberately does NOT attempt (it is
// module-private to that one file and only guards its own Health writes
// against ITSELF across re-mounts — it has no way to tell Sync or Settings,
// or even a torn-down Ingest, anything).
//
// `onWriteGateChange(fn)` lets a mounted view re-render its OWN controls
// when the gate changes — each view re-renders its own DOM via setSidebar/
// setMain as usual; this primitive never reaches into a view's markup
// itself, keeping the README's "never reach into another view's DOM" rule
// intact. A subscribing view must unsubscribe in its teardown (the function
// its onEnter returns) — same discipline as any other listener a view
// installs, per registerView's own doc comment above.
const _domainWrites = new Map(); // domain -> array of open handles' opLabel strings
const _writeGateSubscribers = new Set(); // Set<() => void>

function _notifyWriteGateSubscribers() {
  for (const fn of _writeGateSubscribers) {
    try { fn(); } catch (err) { console.error('[next] write-gate subscriber failed', err); }
  }
}

// Registers one open write against `domain` and returns a release function.
// `opLabel` is a short human string (e.g. 'ingest', 'push') surfaced by
// getDomainWriteLabel() below for a disabled control's tooltip — purely
// informational, defaults to 'write' if omitted.
export function beginDomainWrite(domain, opLabel) {
  if (!domain) {
    console.warn('[next] beginDomainWrite() called without a domain — refusing to register a write.');
    return () => {}; // still returns a callable no-op handle — never a falsy value a caller might skip calling
  }
  const label = (typeof opLabel === 'string' && opLabel) ? opLabel : 'write';
  const list = _domainWrites.get(domain) || [];
  list.push(label);
  _domainWrites.set(domain, list);
  _notifyWriteGateSubscribers();

  let released = false;
  return function release() {
    if (released) return; // idempotent — calling an already-released handle again is a no-op, never a double-decrement
    released = true;
    const cur = _domainWrites.get(domain);
    if (cur) {
      const i = cur.indexOf(label);
      if (i !== -1) cur.splice(i, 1);
      if (cur.length === 0) _domainWrites.delete(domain);
    }
    _notifyWriteGateSubscribers();
  };
}

export function isDomainWriteBusy(domain) {
  const list = domain && _domainWrites.get(domain);
  return !!(list && list.length);
}

export function isAnyWriteBusy() {
  for (const list of _domainWrites.values()) if (list.length) return true;
  return false;
}

// The opLabel of the OLDEST still-open write on `domain`, or null if none —
// e.g. for a disabled button's title text ("An ingest is in progress…").
export function getDomainWriteLabel(domain) {
  const list = domain && _domainWrites.get(domain);
  return (list && list.length) ? list[0] : null;
}

// Subscribe to any change in the write gate (a begin or a release, on any
// domain). Returns an unsubscribe function — call it from your view's
// teardown. Deliberately fires on EVERY change rather than being scoped to
// one domain: the set of views that care (Sync/Domains/Settings today) each
// want to re-evaluate their own controls, which may span multiple domains
// (e.g. a domain list), so filtering here would just push the same
// domain-by-domain check back onto every subscriber anyway.
export function onWriteGateChange(fn) {
  _writeGateSubscribers.add(fn);
  return () => { _writeGateSubscribers.delete(fn); };
}

// ── Active batch-job watcher (HIGH-2 fix, then a regression fix inside it) ─
//
// An independent adversarial audit found the gate's own headline guarantee
// ("survives navigating away from and back to the view that started the
// write") was FALSE for the one write kind it matters most for: a batch
// ingest job. views/ingest.js's onEnter teardown calls detachQueueStream(),
// whose `finally` releases the write-gate handle the moment the user
// leaves the Ingest view — even though the batch keeps running
// server-side. Measured live: busy went true -> false -> true across a
// navigate-away-and-back while the batch was still genuinely running.
//
// The root cause was architectural, not a missed release call: a batch
// job is SERVER-owned and reattachable (GET /api/ingest-queue/active,
// /:jobId, /:jobId/stream all exist — see views/ingest.js's own
// checkActiveQueueJob/attachQueueStream, unchanged by this fix) — the
// server is the authority on whether it's running, not whichever view
// happens to be mounted. Coupling the gate's truth to view lifecycle was
// the same convention-not-structure trap beginDomainWrite's OWN shape
// exists to close, just one level up.
//
// Fix: a SHELL-level watcher (here, not in views/ingest.js, for the same
// reason the gate itself lives here) that holds its own INDEPENDENT
// write-gate handle sourced directly from server truth, alongside
// whatever handle views/ingest.js's own view-level code holds while it
// happens to be mounted. The two handles compose safely — beginDomainWrite
// is a plain per-domain refcount (see above); this watcher acquiring a
// SECOND handle for the same domain while Ingest is also holding one is
// not a conflict, it's exactly what makes the guarantee survive Ingest's
// own handle releasing on teardown. views/ingest.js's existing gate calls
// are UNCHANGED by this fix.
//
// REGRESSION FOUND INSIDE THIS FIX, by the same audit process, before
// ship: the first version's "is this job worth holding the gate for?"
// test was `status !== 'done' && status !== 'cancelled' && status !==
// 'failed'` — i.e. "not terminal". That is the WRONG question. A 'paused'
// or 'pending' job is not terminal but is also not WRITING anything —
// src/brain/ingest-queue.js only calls registerWrite() inside the actual
// per-item ingest call, so a paused job holds NO backend write-registry
// entry and the server would refuse nothing. Treating "not terminal" as
// "busy" made the client STRICTER than the server it exists to mirror,
// and combined with THREE separate real facts into a standing bug: (1)
// boot() below calls reportPossibleActiveJob() unconditionally, (2) a
// crashed job recovers to 'paused', never 'running', by deliberate
// v3.3.0 design ("never auto-start spend"), and (3) rate-limit pauses and
// the 3-strike circuit breaker both land on 'paused' too, routinely, not
// as an edge case. Net effect: pause a batch, or have it auto-pause, or
// crash-recover into 'paused' — and every subsequent page load acquires
// the gate and never lets go, because "not terminal" stays true forever
// for a job nobody is resuming.
//
// The fix is to stop inventing a second definition of "busy" and use the
// ONE that already exists: queueBusyTransition, imported below from
// ../shared/ingest-queue-logic.js — the same byte-identical-to-app.js
// module views/ingest.js's own applyQueueBusyForStatus already drives
// this exact gate from. Its own doc comment states the real predicate:
// "'running' is the only status where the batch is actually writing to
// the wiki — every other status (pending/paused/done/cancelled/failed,
// and the synthetic null meaning 'not attached') is not-busy." Importing
// it here means there is exactly one place that answers "is this batch
// writing", not two that can independently drift — which is what
// happened the first time.
//
// Event-driven, NOT perpetual polling — the loop is bounded and turns
// itself off, and now ALSO does not run at all for a paused/pending job:
//   - reportPossibleActiveJob() is a cheap, idempotent signal any view can
//     call when it learns a batch job might exist. views/ingest.js calls
//     it from applyQueueJobSnapshot (the one chokepoint every job
//     snapshot already flows through) AND from checkActiveQueueJob (so a
//     fresh mount that finds a paused job still gets its bookkeeping
//     synced, even though a paused job never causes an acquire). Calling
//     it never blocks and never throws.
//   - Every call does ONE fetch against GET /api/ingest-queue/active — the
//     same free, cheap, read-only endpoint views/ingest.js's own
//     checkActiveQueueJob already uses — and feeds the result through
//     queueBusyTransition against the LAST status this watcher itself
//     observed. Only an actual transition into/out of 'running' touches
//     the gate; a job sitting at 'paused' call after call is a no-op both
//     times, by construction, not because of a special case.
//   - The interval runs ONLY while the last-observed status is 'running'
//     — not "not terminal". A job going 'running' -> 'paused' stops the
//     interval in the SAME tick that releases the handle; there is no
//     window where the loop spins for a job that isn't writing.
//   - WHAT RE-ARMS A PAUSED JOB'S GATE ON RESUME: resuming can only
//     happen through views/ingest.js's resumeQueueJob (POST /:jobId/
//     start) — there is no other surface that can resume a job today
//     (see the "three doors" assessment in views/ingest.js's own file
//     header) — and resumeQueueJob already calls applyQueueJobSnapshot on
//     its response, which already calls reportPossibleActiveJob(). So the
//     watcher does not need to keep polling a paused job in the
//     background "just in case": the one path that can change a paused
//     job's status already announces the change. This was a deliberate
//     choice over "poll forever while paused" — polling an indefinitely-
//     paused job forever is the same class of waste the bounded-loop
//     design exists to avoid, and does not buy any correctness here.
//   - A job ID change the poll gap missed (the previous job went terminal
//     and a new one started 'running' between two ticks, so this watcher
//     never observed the old job's own exit) is handled by resetting the
//     transition bookkeeping to a clean slate whenever the observed
//     jobId changes, before computing the transition — so a missed exit
//     can never leave a handle open for a domain that is no longer
//     running anything.
//   - boot() below also calls reportPossibleActiveJob() once,
//     unconditionally, so a hard page reload landing mid-batch is covered
//     too — and, per the regression fix above, a reload landing on a
//     RECOVERED-PAUSED job now correctly acquires nothing.
//
// No server-side (or cross-tab) resource is held by this watcher — the
// gate, the release handle, and the interval are all plain in-memory JS
// state scoped to one page's lifetime, exactly like the rest of this
// module's state (mountToken, the reader, _domainWrites itself). Closing
// or reloading the tab destroys all of it at once (browsers cancel
// pending timers and in-flight fetches on unload) — there is nothing here
// that outlives the page for a closed tab to "leak". The real safety net
// against a truly abandoned write is unchanged and unaffected by any of
// this: the backend's own write-registry (src/brain/write-registry.js),
// which 409s a conflicting request regardless of what any client believes
// its own UI state is.
const ACTIVE_JOB_POLL_MS = 4000;
let _activeJobWatchTimer = null;
let _activeJobRelease = null;
let _activeJobId = null;
let _activeJobLastStatus = null; // feeds queueBusyTransition — the SAME predicate views/ingest.js's applyQueueBusyForStatus uses, not a second one
let _activeJobCheckInFlight = false; // collapses overlapping calls into one in-flight fetch

async function _checkActiveJobOnce() {
  if (_activeJobCheckInFlight) return;
  _activeJobCheckInFlight = true;
  let job = null;
  try {
    const res = await fetch('/api/ingest-queue/active');
    const data = await res.json();
    if (res.ok && data && data.ok && data.job) job = data.job;
  } catch {
    // Network hiccup — leave whatever the watcher already holds alone; the
    // next scheduled tick (if the loop is running) or the next
    // reportPossibleActiveJob() call will retry. Never throws out of here.
    _activeJobCheckInFlight = false;
    return;
  }
  _activeJobCheckInFlight = false;

  const nextStatus = job ? job.status : null;

  // A job swap this poll gap missed needs the same release-before-acquire
  // treatment a normal running -> not-running -> running sequence would
  // get across two separate ticks, collapsed into one: reset to a clean
  // slate before computing the transition below, so a stale handle can
  // never survive under a jobId that no longer exists.
  if (job && job.jobId !== _activeJobId && _activeJobRelease) {
    _activeJobRelease();
    _activeJobRelease = null;
    _activeJobLastStatus = null;
  }

  // THE fix: queueBusyTransition (imported below), not a hand-rolled
  // "not terminal" test — see this section's own comment for the
  // regression this closes. 'running' is the only busy status.
  const decision = queueBusyTransition(_activeJobLastStatus, nextStatus);
  if (decision === 'enter') {
    _activeJobId = job.jobId;
    _activeJobRelease = beginDomainWrite(job.domain, 'batch ingest');
  } else if (decision === 'exit') {
    if (_activeJobRelease) { _activeJobRelease(); _activeJobRelease = null; }
    _activeJobId = null;
    // A batch that just stopped writing has (usually) left new pages on
    // disk, so the pending-change count is stale the moment it exits. This
    // is the /next equivalent of the shipping app's post-ingest badge
    // refresh, hung off the ONE transition that already knows a batch
    // finished rather than a second watcher of its own.
    refreshSyncBadge();
  }
  _activeJobLastStatus = nextStatus;

  // Poll ONLY while genuinely running — see "WHAT RE-ARMS A PAUSED JOB'S
  // GATE ON RESUME" above for why this does not risk leaving the gate
  // permanently wrong for a job that later resumes.
  if (nextStatus === 'running') {
    if (_activeJobWatchTimer == null) {
      _activeJobWatchTimer = setInterval(_checkActiveJobOnce, ACTIVE_JOB_POLL_MS);
    }
  } else if (_activeJobWatchTimer != null) {
    clearInterval(_activeJobWatchTimer);
    _activeJobWatchTimer = null;
  }
}

export function reportPossibleActiveJob() {
  _checkActiveJobOnce();
}

// ── View registration ───────────────────────────────────────────────────
// Each import below runs a views/*.js file purely for its side effect: it
// calls registerView() at its own top level. Every one of these files
// also imports from this module ('../app.js'), which makes this a real
// ES-module import cycle. That's safe here ONLY because every shell
// function a view file can reach at its own top level (registerView, via
// the `var registry` above) tolerates being called before this module's
// own top-level code has run — see the comment on `registry` above. Every
// OTHER exported function (setSidebar, openReader, icon, ...) is only
// ever called from inside a view's onEnter/onExit, which runs later, from
// navigate() — by then this whole module has finished evaluating. Do not
// add a new top-level (call-at-import-time) shell call without checking
// it holds up under the same cyclic-evaluation-order constraint.
import './views/chat.js';
import './views/domains.js';
import './views/shared.js';
import './views/memory.js';
import './views/ingest.js';
import './views/sync.js';
import './views/settings.js';

// NOT a view — it calls no registerView() and owns no rail slot. The
// first-run guidance panel is a SHELL-level layer (it must survive
// navigate(), because its entire job is to point at other views), so it is
// imported here for its export rather than for a registration side effect,
// and it is opened from boot() below rather than from any view's onEnter.
// Same cyclic-evaluation constraint as every import above: this module must
// not call any shell function at its own top level. It does not.
import { maybeShowOnboarding } from './views/onboarding.js';

// Also NOT a view, and the same shell-level shape as onboarding above: the
// cutover notice is a one-time bar telling an EXISTING user that "/" now
// serves this shell and that the previous interface is still at /old. Same
// cyclic-evaluation constraint as every import above — it calls no shell
// function at its own top level.
import { maybeShowCutoverNotice } from './views/cutover-notice.js';

// ── Keyboard ─────────────────────────────────────────────────────────────
// Esc closes the reader — global shell state, handled directly here. The
// composer's model/length picker is view-owned; its own Escape handling
// lives in views/chat.js, wired up only while Chat is the mounted view.

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (state.reader) { closeReader(); return; }
});

// ── Boot ───────────────────────────────────────────────────────────────

function boot() {
  let savedTheme = 'dark';
  let savedView = 'chat';
  let savedFontScale = FONT_SCALE_DEFAULT;
  try {
    const t = localStorage.getItem(THEME_KEY);
    if (t === 'light' || t === 'dark') savedTheme = t;
    const v = localStorage.getItem(VIEW_KEY);
    if (v && ALL_VIEWS.includes(v)) savedView = v;
    // normalizeFontScale absorbs null (never set), a value from an older
    // build, and anything hand-edited into storage — all three land on the
    // default rather than writing junk into a CSS custom property.
    savedFontScale = normalizeFontScale(localStorage.getItem(FONT_SCALE_KEY));
  } catch { /* private mode / disabled storage — defaults are fine */ }

  // BEFORE renderRail()/navigate(), so the first painted text is already at
  // the chosen size. Nothing textual exists at this point — #view-root and
  // #sidebar are empty and the rail has not been built — so there is no
  // frame in which the app is visible at the wrong scale.
  applyFontScale(savedFontScale);
  applyTheme(savedTheme);
  renderRail();
  navigate(savedView);

  // HIGH-2 fix: cover a hard page reload landing mid-batch, not just an
  // in-app navigate-away-and-back — see the active-job watcher's own
  // comment above. Fire-and-forget; the function never throws.
  reportPossibleActiveJob();

  // Rail sync badge: one fetch at start (navigate() above has already fired
  // one, so this is really the slow safety net being armed), plus a 60s
  // refresh for a user who lingers on a single screen without navigating —
  // the same cadence src/public/app.js has used since v3.0.1-beta.5. Both
  // are fire-and-forget for the same markBooted() reason documented below.
  // The interval calls the *IfVisible wrapper (see its own comment above
  // refreshSyncRemoteBadgeIfVisible) so a hidden window skips the fetch.
  setInterval(refreshSyncBadgeIfVisible, SYNC_BADGE_REFRESH_MS);

  // The remote half of the badge — one check now, then every 10 minutes.
  // Deliberately NOT wired into navigate(): see SYNC_REMOTE_REFRESH_MS for
  // why this one is not allowed on the hot path. Fire-and-forget, and the
  // function never throws, for the markBooted() reason documented below.
  // Same *IfVisible wrapper as above, for the same reason — see the comment
  // on refreshSyncBadgeIfVisible/refreshSyncRemoteBadgeIfVisible.
  refreshSyncRemoteBadge();
  setInterval(refreshSyncRemoteBadgeIfVisible, SYNC_REMOTE_REFRESH_MS);

  // Resume promptly on wake rather than waiting out the rest of a skipped
  // interval — see armSyncBadgeWakeHandler's own comment for why an
  // immediate refresh on every wake is safe here.
  armSyncBadgeWakeHandler();

  // First-run guidance (ARCHITECTURE.md R7). Same fire-and-forget shape as
  // the line above, and for a much sharper reason: markBooted() runs
  // IMMEDIATELY after boot() returns, and index.html's <head> guard treats
  // an unset window.__curatorBooted at DOMContentLoaded as proof this
  // module died — it then paints a full-page blank-page recovery panel to
  // EVERY user. So this call must never be able to stop markBooted() from
  // running.
  //
  // Three independent reasons it cannot, none of which relies on the
  // others being remembered:
  //   1. It is NOT awaited, and boot() is NOT async. An `await` here would
  //      require making boot() async, which changes when markBooted() runs
  //      relative to the rest of startup.
  //   2. maybeShowOnboarding() is declared `async`, so its body — including
  //      its synchronous prologue — can only ever produce a rejected
  //      promise, never a synchronous throw at this call site. (An
  //      unhandled rejection arriving later is harmless: __curatorBooted is
  //      already true by then, so the head guard logs it and moves on.)
  //   3. This try/catch, which contains anything the first two miss.
  // scripts/test-next-onboarding.js §6 pins reasons 1 and 3 mechanically.
  //
  // ── CUTOVER: the two first-load surfaces are chained, never parallel ──
  // maybeShowCutoverNotice() resolves TRUE iff it put the bar on screen, and
  // the guidance check only runs when it did not. That is the SECOND of two
  // independent layers keeping the two surfaces off the screen together; the
  // first is that their predicates are logical complements over the same
  // three facts (key / domain / page), so neither layer depends on the other
  // being remembered. scripts/test-cutover.js proves the predicate half by
  // executing BOTH modules' real functions over all eight fact combinations,
  // and the ordering half from this call site.
  //
  // The whole chain keeps the markBooted() safety property described above,
  // by four independent mechanisms: Promise.resolve().then() converts even a
  // synchronous throw from the first call into a rejection; neither function
  // is awaited and boot() is still NOT async; both are declared `async`; and
  // the .catch plus this try/catch absorb anything left. openBar() is the
  // last thing maybeShowCutoverNotice() does, so a rejection here reliably
  // means nothing was rendered — which is why the fall-through to onboarding
  // in that case is safe rather than a way to get both.
  // The guidance call keeps its own try/catch at the call site, unchanged and
  // deliberately still written as one line: it is layer 3 of the three above,
  // and scripts/test-next-onboarding.js §6 reads this exact shape.
  const runGuidanceCheck = () => {
    try { maybeShowOnboarding(); } catch (err) { console.error('[next] onboarding check failed', err); }
  };

  try {
    Promise.resolve()
      .then(() => maybeShowCutoverNotice())
      .then((shownCutover) => { if (shownCutover !== true) runGuidanceCheck(); })
      .catch((err) => { console.error('[next] first-load surfaces failed', err); });
  } catch (err) {
    console.error('[next] first-load surfaces failed', err);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { boot(); markBooted(); });
} else {
  boot();
  markBooted();
}

// ── Boot sentinel (M2 fix) ───────────────────────────────────────────────
// index.html's inline <head> boot guard (ported from src/public/index.html
// — see it for the full rationale) treats "window.__curatorBooted is still
// false at DOMContentLoaded" as proof this module never finished
// evaluating — a syntax error in any views/*.js, or a missing file in the
// import cycle at the bottom of this file, throws before a single line of
// UI renders, and previously left the whole page (rail, sidebar, main —
// EVERY element in #app-shell) at zero bytes with no visible text and no
// recovery path. Reproduced by appending a syntax error to views/settings.js
// and serving it.
//
// Deliberately set AFTER boot(), not as an unconditional last statement —
// unlike the shipping app's index.html (which has no comparable
// readyState branch), this file's `if (document.readyState === 'loading')`
// branch defers boot() to a later event. In every real browser this branch
// is dead (a deferred module script, which this is, only ever runs once
// parsing has finished, so readyState can never observe 'loading' here) —
// kept anyway as defensive symmetry so the sentinel is correctly ordered
// AFTER boot() regardless. A throwing boot() (e.g. applyTheme/renderRail
// touching a missing element — genuinely fatal, unlike a single view's
// onEnter, which navigate() already contains above) still prevents
// markBooted() from running, which is exactly the "module did not finish"
// signal the head guard is watching for.
function markBooted() {
  window.__curatorBooted = true;
}
