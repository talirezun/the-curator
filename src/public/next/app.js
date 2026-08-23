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
//     console.warn names the offending call site) — every real view,
//     including the three synchronous stub views (shared.js/memory.js/
//     ingest.js, which have no staleness window of their own), passes the
//     mountToken its onEnter received. That parameter is already sitting
//     right there for free; there is no longer a way to opt out by
//     forgetting one argument.
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
//
// A view file must not import another view file, and must not reach into
// another view's DOM — the rail/sidebar/main/reader are the only shared
// surfaces, and all of them are reached only through the functions above.

// ── Constants ──────────────────────────────────────────────────────────

const THEME_KEY = 'curator-next-theme';
const VIEW_KEY = 'curator-next-view';

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
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 13.5a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.04 1.56V19.7a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.1-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06A2 2 0 1 1 4.16 15.6l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.04H2.9a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.55 7.6a1.7 1.7 0 0 0-.34-1.87l-.06-.06A2 2 0 1 1 6.98 2.84l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.04-1.56V1.55a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.04 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1.04h.09a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.56 1.46z" opacity="0"/><path d="M12 4.2v1.9M12 17.9v1.9M4.2 12h1.9M17.9 12h1.9M6.7 6.7l1.3 1.3M16 16l1.3 1.3M6.7 17.3 8 16M16 8l1.3-1.3"/>',
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

export function icon(name, size) {
  const body = ICON_BODY[name] || ICON_BODY.dot;
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
// passes one, including the three synchronous stub views (shared.js /
// memory.js / ingest.js), which have no staleness window of their own but
// pass their onEnter's mountToken anyway at zero real cost — one already-
// available argument, not "ceremony". `guardMountToken` below fails CLOSED
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
  const markSrc = state.theme === 'light' ? 'assets/mark-small-on-light.svg' : 'assets/mark-small-on-dark.svg';

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
  const pendingCount = 0; // no backend wiring in Phase 1 — badge hides at zero, per spec

  rail.innerHTML =
    '<img class="rail-mark" src="' + markSrc + '" alt="The Curator" width="26" height="26">' +
    navBtns +
    '<div class="rail-spacer"></div>' +
    '<button class="rail-theme-toggle" id="rail-theme-toggle" title="Toggle theme"></button>' +
    '<button class="rail-btn rail-btn-sm" data-view="sync" title="' + syncMeta.title + '" aria-label="' + syncMeta.title + '">' +
      icon(syncMeta.icon, 18) +
      (pendingCount > 0 ? '<span class="rail-badge">' + pendingCount + '</span>' : '') +
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
}

function renderRailActive() {
  document.querySelectorAll('.rail-btn[data-view]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === state.view);
  });
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
  try {
    const t = localStorage.getItem(THEME_KEY);
    if (t === 'light' || t === 'dark') savedTheme = t;
    const v = localStorage.getItem(VIEW_KEY);
    if (v && ALL_VIEWS.includes(v)) savedView = v;
  } catch { /* private mode / disabled storage — defaults are fine */ }

  applyTheme(savedTheme);
  renderRail();
  navigate(savedView);
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
