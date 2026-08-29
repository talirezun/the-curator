// View: Agent memory — "your agents' brain".
//
// Renders the working-state store (src/brain/working-state.js) that coding
// agents read and write over MCP: a standing project brief, a per-scope /
// per-machine handoff, and an append-only journal of saves.
//
// Backend used (read-only, this session — see src/routes/memory.js):
//   GET /api/memory                         -> { projects: [...] } index
//   GET /api/memory/:project                -> brief + scope index
//   GET /api/memory/:project?scope=&machine=&journalLimit=
//                                           -> brief + current.md + journal
//
// ─────────────────────────────────────────────────────────────────────────
// THIS VIEW NEVER WRITES, AND THAT IS THE FEATURE
// ─────────────────────────────────────────────────────────────────────────
// The store has exactly one writer — an agent, through the MCP tools. Its
// whole per-machine layout is safe BECAUSE of that (working-state.js's
// LAYOUT block: two machines never touch one file, so `git pull -X theirs`
// has no conflicting hunk to silently resolve away). A browser write path
// would make the app a second writer to the same files, and would put a
// human edit behind the last agent's harness/model provenance line.
//
// So: show, do not edit. There is no Save, no inline editor, no textarea,
// and the route this view calls has no write endpoint to reach even if one
// were added here. `state/project.md` is plain markdown in the user's own
// folder — Obsidian opens it. That is the answer, not a gap.
//
// Because nothing here writes, this view does NOT participate in the
// cross-view write gate (app.js's isAnyWriteBusy / beginDomainWrite) the way
// Sync and Ingest do. There is no button to disable: an ingest running in
// another view cannot conflict with a read, and refusing to READ during a
// write would be inventing a restriction the backend does not enforce.
//
// ─────────────────────────────────────────────────────────────────────────
// DESIGN
// ─────────────────────────────────────────────────────────────────────────
// Dense information, quiet presentation. What a person coming here actually
// wants is one thing — "where did my agent leave this?" — so the handoff is
// the only thing on screen by default. Everything that is context rather
// than answer sits behind a native <details>:
//
//   · the standing brief (rarely changes; the handoff is what churns) —
//     EXCEPT when there is no handoff, where it opens, because then it is
//     the only content there is;
//   · the journal (history, not state);
//   · "How this works" (explains the three tiers and the read-only rule —
//     needed exactly once per user, then never again).
//
// Native <details> rather than a hand-rolled disclosure: keyboard operation
// and screen-reader announcement come free, which is the same reasoning
// settings.js's model picker records.
//
// THE <summary> HAZARD (v3.0.1-beta.18, and settings.js's model picker):
// an interactive control placed inside a <summary> toggles its own section
// when clicked. Every control in this view — the two selects, the journal's
// "Show more" button — is a SIBLING of its <details>, or lives in the
// <details> BODY. There is therefore no propagation path to suppress, so no
// later edit can drop a stopPropagation that isn't there.
//
// SQUARE marker, not round: agent memory is a different KIND of thing from a
// knowledge domain, and the rail already puts them side by side. Domains use
// a round dot (.dm-row-dot border-radius: 50%); this uses a square
// (.mem-row-mark, radius 2px). Both docs/architecture.md and this view's own
// previous placeholder promised that distinction; it is honoured here.

import {
  registerView, setSidebar, setMain, eyebrow, escapeHtml, icon,
  isCurrentMount, reportAsyncMountFailure,
} from '../app.js';
import { renderMarkdown } from '../shared/markdown.js';
import { createLoadingGate, gatedLoader, settleGate } from '../shared/loading-gate.js';

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

function freshState() {
  return {
    loading: true,
    projects: [],          // GET /api/memory -> projects[]
    indexError: null,

    activeProject: null,
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
    // default (the brief opens when it is the only content there is).
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
    // An index refresh saw a write NEWER than that read. Rendered as an
    // offer to reload, never as an automatic replacement — see
    // renderStaleNotice for why the document is not swapped underneath a
    // reader.
    staleWrite: false,
    refreshing: false,
    // How long the last index refresh took, in ms. Feeds nextPollDelay.
    lastRefreshMs: 0,
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
 * <select> is absent from the first of those (state.detail is dropped before
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
  'mem-scope-select', 'mem-machine-select', 'mem-journal-more',
  'mem-fold-brief', 'mem-fold-journal', 'mem-fold-about',
  // Both revalidation controls. `mem-reload` is the one that matters: it
  // REMOVES itself on success (the notice it lives in is gone once the
  // reload lands), so it needs the same fallback treatment as "Show more".
  'mem-refresh', 'mem-reload',
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
};

// Same mount-token discipline as chat.js / domains.js / sync.js: captured as
// a local BEFORE the first await in every async function and threaded
// through, never re-derived afterwards. A boolean cannot distinguish "still
// mounted" from "REmounted", which is the case that actually bites.
let myMountToken = 0;
let loadGate = null;
let pollTimer = null;
let wakeHandler = null;
// The signature of what render() last painted. Compared against a freshly
// computed one so a revalidation that changed nothing costs no render at
// all — see screenSignature.
let renderedSignature = null;

registerView('memory', {
  onEnter(mountToken) {
    state = freshState();
    myMountToken = mountToken;
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
    if (!res.ok || !data.ok) return { projects: [], error: data.error || ('HTTP ' + res.status) };
    return { projects: data.projects || [], error: null };
  } catch (err) {
    if (!isCurrentMount(token)) return null;
    return { projects: [], error: err.message };
  }
}

/**
 * WHAT THE SCREEN CURRENTLY SAYS, as a comparable string.
 *
 * A poll that re-renders unconditionally is worse than no poll: every render
 * replaces the whole main pane, so it would close a native <select> the user
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
  return JSON.stringify([
    state.activeProject,
    state.staleWrite,
    state.indexError,
    state.projects.map((p) => [p.project, p.hasBrief, p.scopeCount > 0, projectMetaLine(p)]),
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
    state.indexError = null;

    // Has anything been written since the read that produced what is on
    // screen? Compared against the read's START time — see detailFetchedAt.
    const row = state.projects.find((p) => p.project === state.activeProject);
    const wroteAt = row && row.lastWriteAt ? Date.parse(row.lastWriteAt) : NaN;
    state.staleWrite = Number.isFinite(wroteAt) &&
      state.detailFetchedAt > 0 && wroteAt > state.detailFetchedAt;

    const before = renderedSignature;
    if (screenSignature() !== before) render(token);
  } finally {
    state.refreshing = false;
  }
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
  const project = state.activeProject;
  if (!project) return;
  const wantScope = state.scope;
  const wantMachine = state.detail ? state.detail.machine : state.machine;

  state.detailFetchedAt = Date.now();
  state.staleWrite = false;
  state.detailLoading = true;
  render(token);

  const read = await fetchState(project, {}, token);
  if (!isCurrentMount(token) || state.activeProject !== project) return;
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

async function loadIndex(token) {
  const gate = loadGate;                 // capture: the next mount replaces it
  const got = await fetchIndex(token);
  if (!isCurrentMount(token)) return;
  if (got) {
    state.projects = got.projects;
    state.indexError = got.error;
  }

  // Open on the project whose agent memory is FRESHEST — nearly always the
  // one the user just came from. The list itself stays in domain order (a
  // picker that reorders itself between visits is disorienting); only the
  // initial selection is by recency, and it is computed here rather than
  // taken as the first row with any state, which would just be alphabetical.
  // A project with nothing saved is still selectable — "nothing saved yet"
  // is a real answer worth being able to ask for.
  const withState = state.projects.filter((p) => p.lastWriteAt);
  withState.sort((a, b) => String(b.lastWriteAt).localeCompare(String(a.lastWriteAt)));
  const pick = withState.length ? withState[0] : (state.projects[0] || null);

  settleGate(gate, () => {
    state.loading = false;
    render(token);
  });

  if (pick) await selectProject(pick.project, token);
}

async function selectProject(project, token, opts = {}) {
  state.activeProject = project;
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
  state.staleWrite = false;
  render(token);

  // A user-initiated selection is the cheapest honest moment to re-ask the
  // index: the detail fetch below is happening anyway, so the two land
  // together and the sidebar row cannot contradict the picker it sits next
  // to. NOT done for the initial pick, which loadIndex just fetched.
  if (opts.revalidateIndex) {
    refreshIndex(token).catch((err) => reportAsyncMountFailure(token, err));
  }

  const read = await fetchState(project, {}, token);
  if (!isCurrentMount(token) || state.activeProject !== project) return;
  state.projectRead = read.data;
  state.detailError = read.error;

  const scopes = (read.data && read.data.scopes) || [];
  if (!scopes.length) {
    state.detailLoading = false;
    render(token);
    return;
  }
  // Newest-first from the store, so [0] is the freshest handoff.
  await loadScope(scopes[0].scope, null, token);
}

async function loadScope(scope, machine, token) {
  const project = state.activeProject;
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

  const read = await fetchState(project, q, token);
  if (!isCurrentMount(token) || state.activeProject !== project || state.scope !== scope) return;
  state.detail = read.data;
  state.detailError = read.error;
  state.detailLoading = false;
  render(token);
}

/** One fetch shape for both reads. Never throws; returns {data, error}. */
async function fetchState(project, query, token) {
  const qs = new URLSearchParams(query).toString();
  try {
    const res = await fetch('/api/memory/' + encodeURIComponent(project) + (qs ? '?' + qs : ''));
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
 * One-line summary of a project's memory for the sidebar row.
 *
 * "No state saved yet" and "a brief, no sessions yet" are DIFFERENT facts and
 * are said differently — a project carrying a standing brief but no handoff
 * is a real, deliberate configuration (someone wrote the brief before the
 * first agent session), not an empty one.
 */
export function projectMetaLine(p) {
  if (!p) return '';
  const age = formatAge(p.ageSeconds);
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

function render(token) {
  if (!isCurrentMount(token)) return;
  renderedSignature = screenSignature();
  captureFocus();
  renderSidebar(token);
  renderMain(token);
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
  if (id && FOCUSABLE_IDS.includes(id)) pendingFocusId = id;
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

function renderSidebar(token) {
  const head =
    '<div class="sidebar-title">Agent memory</div>' +
    '<div class="sidebar-hint">The working brief your coding agents leave for each other — read here, written by them.</div>';

  if (state.loading) {
    setSidebar(head + gatedLoader(loadGate, 'Loading…', 'sidebar-hint'), token);
    return;
  }
  if (state.indexError) {
    setSidebar(head + '<div class="sidebar-hint mem-error-text">Could not load agent memory — ' +
      escapeHtml(state.indexError) + '</div>', token);
    return;
  }
  if (!state.projects.length) {
    setSidebar(head + '<div class="cur-eyebrow" style="margin-top:10px">PROJECTS</div>' +
      '<div class="sidebar-note">No domains yet. Agent memory is kept per domain — create one in Domains first.</div>',
      token);
    return;
  }

  const rows = state.projects.map((p) => {
    const active = p.project === state.activeProject;
    const has = p.scopeCount > 0 || p.hasBrief;
    return (
      '<button class="mem-row' + (active ? ' active' : '') + (has ? '' : ' mem-row-quiet') + '"' +
        ' data-mem-project="' + escapeHtml(p.project) + '"' +
        (active ? ' aria-current="true"' : '') + '>' +
        // SQUARE, not round — see this file's header comment.
        '<span class="mem-row-mark' + (has ? '' : ' mem-row-mark-off') + '"></span>' +
        '<span class="mem-row-main">' +
          '<span class="mem-row-name">' + escapeHtml(p.project) + '</span>' +
          '<span class="mem-row-meta mono">' + escapeHtml(projectMetaLine(p)) + '</span>' +
        '</span>' +
      '</button>'
    );
  }).join('');

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
      '<button type="button" class="mem-refresh" id="mem-refresh"' +
        ' title="Re-read what agents have saved. This screen also re-checks by itself when you come back to it.">' +
        'Refresh</button>' +
    '</div>';

  setSidebar(
    head + projectsHead +
    '<div class="mem-row-list">' + rows + '</div>' +
    '<div class="mem-sidebar-foot">' + icon('lockAlt', 12) +
      '<span>Read-only here. Agents write this through MCP.</span></div>',
    token
  );
}

function renderMain(token) {
  let body;
  if (state.loading) {
    body = gatedLoader(loadGate, 'Loading agent memory…');
  } else if (state.indexError) {
    body = '<div class="mem-inline-error">Could not load agent memory — ' + escapeHtml(state.indexError) + '</div>';
  } else if (!state.activeProject) {
    body = renderNoProjects();
  } else {
    body = renderProject();
  }

  setMain(
    eyebrow('your agents’ brain') +
    '<h1 class="view-title">Agent memory</h1>' +
    body,
    token
  );
}

function renderNoProjects() {
  return (
    '<div class="empty-card">' +
      '<div class="empty-title">No domains yet</div>' +
      '<div class="empty-body">Agent memory is kept per domain, under <code>state/</code> beside that domain’s wiki. ' +
      'Create a domain first, then point a coding agent at it — the brief appears here the moment one saves.</div>' +
    '</div>'
  );
}

function renderProject() {
  const read = state.projectRead;
  const d = state.detail;

  const header =
    '<div class="mem-project-head">' +
      '<span class="mem-project-mark"></span>' +
      '<span class="mem-project-name">' + escapeHtml(state.activeProject) + '</span>' +
      (d && d.readonly
        ? '<span class="mem-badge mem-badge-quiet" title="A read-only Shared Brain mirror — this state can have been written by someone else on your cohort.">shared mirror</span>'
        : '') +
    '</div>';

  if (state.detailError) {
    return header + '<div class="mem-inline-error">' + escapeHtml(state.detailError) + '</div>' + renderAbout();
  }
  if (state.detailLoading && !read) {
    return header + gatedLoader(loadGate, 'Reading state…');
  }

  const scopes = (read && read.scopes) || [];
  const hasBrief = !!(read && read.brief && read.brief.present);
  const unlisted = unlistedCount(read);

  // Placed immediately under the header, ABOVE the controls, in every state:
  // it qualifies the claim the pickers below it are about to make. A static
  // "Scope main" label affirms "there is exactly one scope", and it must not
  // say that while a second scope directory sits unread on disk.
  const unlistedNote = renderUnlistedNote(read, d);
  // Sits with the unlisted note, above the controls, for the same reason: it
  // qualifies the claim everything below it is about to make. Present in
  // every content branch — the empty-project one most of all, where "nothing
  // saved yet" is precisely the sentence a just-written handoff falsifies.
  const staleNote = renderStaleNotice();

  if (!scopes.length && !hasBrief) {
    return header + staleNote + unlistedNote + renderEmptyProject(unlisted) + renderAbout();
  }

  // A brief with no handoff: the store says so (`message`) and the view used
  // to drop it, so the page rendered the brief and simply never mentioned
  // that the thing this screen exists to show is missing. Absence communicated
  // by absence — and the SIDEBAR row for the same project says "brief only —
  // no sessions yet", so the two surfaces disagreed about how much explaining
  // was owed. This is also the documented happy path (write the brief, then
  // let agents save), so it is a common first experience.
  if (!scopes.length) {
    return (
      header + staleNote + unlistedNote + renderBriefOnlyNotice(read, unlisted) +
      renderBrief(read, true) + renderAbout()
    );
  }

  return (
    header +
    staleNote +
    unlistedNote +
    renderScopeControls(scopes) +
    renderHandoff() +
    // The brief opens only when there is no handoff to read — then it is the
    // only content on the page, and folding it away would leave a blank view.
    renderBrief(read, !(d && d.current && d.current.present)) +
    renderJournal() +
    renderAbout()
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
  return (
    '<div class="mem-stale" role="status">' +
      '<span class="mem-stale-text">An agent has saved to this project since you opened it — ' +
        'what is below may not be the latest.</span>' +
      '<button type="button" class="btn btn-xs mem-stale-btn" id="mem-reload">Reload</button>' +
    '</div>'
  );
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
    '<div class="mem-doc-card mem-doc-empty">' +
      '<div class="mem-doc-empty-title">No handoff saved yet</div>' +
      '<div class="mem-doc-empty-body">' + escapeHtml(msg) +
        (unlisted ? '' :
          ' The brief below is what every agent read returns. A handoff appears here the first time ' +
          'a coding agent saves its working state at the end of a session.') +
      '</div>' +
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
      '<div class="empty-card">' +
        '<div class="empty-title">Nothing readable for this project yet</div>' +
        '<div class="empty-body">No handoff could be read here — but this project’s ' +
        '<span class="mono">state/</span> folder is not empty, and the note above says why. ' +
        'Rename those entries so they can be read. Do not save over them: a new save is written under a ' +
        'different, generated name and would leave what is already there stranded.</div>' +
      '</div>'
    );
  }

  return (
    '<div class="empty-card">' +
      '<div class="empty-title">Nothing saved for this project yet</div>' +
      '<div class="empty-body">No agent has written a handoff here. Ask a coding agent connected through ' +
      '<span class="mono">my-curator</span> to save its working state for ' +
      '<span class="mono">' + escapeHtml(state.activeProject) + '</span> at the end of a session, and it will show up here.</div>' +
    '</div>'
  );
}

/**
 * Scope + machine pickers.
 *
 * Both are plain <select>s and both are SIBLINGS of every <details> on the
 * page (see the <summary> hazard note in this file's header). Each appears
 * only when there is genuinely something to choose: one scope with one
 * machine renders as a quiet label, not a dropdown with a single option.
 */
function renderScopeControls(scopes) {
  const d = state.detail;
  const machines = (d && d.machines) || [];
  const scopeNames = [];
  for (const s of scopes) if (!scopeNames.includes(s.scope)) scopeNames.push(s.scope);

  // The <select> is wrapped so a chevron can be drawn over it. It stays a
  // real <select> — see the note on .mem-select in memory.css for why the
  // native control is kept and only its CHROME is replaced.
  const scopeCtl = scopeNames.length > 1
    ? '<label class="mem-ctl"><span class="mem-ctl-label">Scope</span>' +
        '<span class="mem-select-wrap">' +
        '<select class="mem-select" id="mem-scope-select">' +
          scopeNames.map((s) => '<option value="' + escapeHtml(s) + '"' +
            (s === state.scope ? ' selected' : '') + '>' + escapeHtml(s) + '</option>').join('') +
        '</select></span></label>'
    : (state.scope
        ? '<span class="mem-ctl"><span class="mem-ctl-label">Scope</span>' +
          '<span class="mem-ctl-static mono">' + escapeHtml(state.scope) + '</span></span>'
        : '');

  // "WHICH OF THESE IS MINE?" — on a feature whose whole premise is
  // cross-machine continuity, two opaque hex-suffixed ids with neither marked
  // was a real gap. The payload carries `machineIsThisMachine` for the
  // SELECTED machine only, so that is the only entry that can be marked, and
  // only on an explicit `true` — the same positive-evidence rule as the badge
  // below. The negative case is already covered: an explicit `false` renders
  // the amber "from <machine>" badge. An unselected entry is left unmarked
  // because the response says nothing about it, and guessing would be the
  // fact-and-absence collapse this view exists to refuse.
  const selectedIsMine = !!(d && d.machineIsThisMachine === true);
  const MINE = ' · this machine';

  const machineCtl = machines.length > 1
    ? '<label class="mem-ctl"><span class="mem-ctl-label">Machine</span>' +
        '<span class="mem-select-wrap">' +
        '<select class="mem-select" id="mem-machine-select">' +
          machines.map((m) => {
            const sel = !!(d && m.machine === d.machine);
            return '<option value="' + escapeHtml(m.machine) + '"' +
              (sel ? ' selected' : '') + '>' +
              escapeHtml(m.machine) + ' · ' + escapeHtml(formatAge(m.ageSeconds) || 'unknown age') +
              (sel && selectedIsMine ? MINE : '') +
            '</option>';
          }).join('') +
        '</select></span></label>'
    : (d && d.machine
        ? '<span class="mem-ctl"><span class="mem-ctl-label">Machine</span>' +
          '<span class="mem-ctl-static mono">' + escapeHtml(d.machine) +
          (selectedIsMine ? MINE : '') + '</span></span>'
        : '');

  // "Written on another machine" is a real signal, not decoration: it tells
  // you the next steps below were observed somewhere else, so paths, running
  // processes and local checkouts may not match what is in front of you.
  // Rendered ONLY on positive evidence (an explicit `false`) — an older
  // response that omits the field must not be reported as either.
  const elsewhere = d && d.machineIsThisMachine === false
    ? '<span class="mem-badge mem-badge-attn" title="Saved on a different machine and synced here — local paths and processes may differ.">' +
      'from ' + escapeHtml(d.machine || 'another machine') + '</span>'
    : '';

  // The index cap applies to (scope, machine) PAIRS, so the note compares
  // pairs against pairs. Comparing the shown pair count against a work-stream
  // count would be apples to oranges and could read as "showing 3 of 2".
  //
  // `savedCopies` is preferred over `scopeCount` because the two endpoints
  // currently use `scopeCount` for two DIFFERENT quantities: the index route
  // derives it as DISTINCT scopes, while the store's unscoped read sets it to
  // the PAIR total. Reading whichever pair-count field is actually present
  // keeps the note comparing pairs to pairs whichever way that name settles.
  const pr = state.projectRead;
  const pairTotal = pr && (typeof pr.savedCopies === 'number' ? pr.savedCopies : pr.scopeCount);
  const truncated = (pr && pr.scopesTruncated)
    ? '<span class="mem-ctl-note">showing the ' + scopes.length + ' most recent saved copies of ' +
      escapeHtml(String(pairTotal || scopes.length)) + '</span>'
    : '';

  if (!scopeCtl && !machineCtl && !elsewhere && !truncated) return '';
  return '<div class="mem-controls">' + scopeCtl + machineCtl + elsewhere + truncated + '</div>';
}

/** The handoff itself — the one thing on screen by default. */
function renderHandoff() {
  const d = state.detail;
  if (state.detailLoading) return '<div class="mem-doc-card">' + gatedLoader(loadGate, 'Reading handoff…') + '</div>';
  if (!d) return '';
  if (!d.current || !d.current.present) {
    return (
      '<div class="mem-doc-card mem-doc-empty">' +
        '<div class="mem-doc-empty-title">No handoff under this scope yet</div>' +
        '<div class="mem-doc-empty-body">' +
          escapeHtml(d.message || 'Nothing has been saved here.') +
        '</div>' +
      '</div>'
    );
  }

  const savedAge = formatAge(
    d.current.savedAt ? Math.max(0, Math.round((Date.now() - Date.parse(d.current.savedAt)) / 1000)) : null
  );
  const stamp = d.current.savedAt
    ? '<span class="mem-doc-stamp mono" title="' + escapeHtml(d.current.savedAt) + '">' +
      escapeHtml(savedAge || d.current.savedAt) + '</span>'
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

  // Harness and model come from the journal's newest entry — STRUCTURED
  // fields, never scraped out of the document's prose provenance line. A
  // parser over that sentence would break the first time its wording moved.
  const j0 = d.journal && d.journal.entries && d.journal.entries.length ? d.journal.entries[0] : null;
  const who = j0 ? [j0.harness, j0.model].filter(Boolean).map((x) => escapeHtml(x)).join(' · ') : '';

  // renderMarkdown (shared/markdown.js) HTML-escapes the whole string before
  // emitting any markup — the escape-first invariant that module's own suite
  // pins. State text is untrusted (syncs from other machines; inside a
  // shared-* mirror it can be another person's), so it must never reach the
  // DOM any other way.
  return (
    '<section class="mem-doc-card" aria-label="Current handoff">' +
      '<div class="mem-doc-head"><span class="cur-eyebrow">CURRENT HANDOFF</span>' + stamp + '</div>' +
      (headline ? '<div class="mem-doc-headline">' + escapeHtml(headline) + '</div>' : '') +
      (who ? '<div class="mem-doc-who mono">' + who + '</div>' : '') +
      noteHtml +
      '<div class="mem-doc">' + renderMarkdown(body) + '</div>' +
    '</section>'
  );
}

function renderBrief(read, openIt) {
  // The user's own toggle wins over the default when they have expressed one;
  // `undefined` (never touched) falls through to `openIt`, so the "this is the
  // only content on the page" rule below still applies on first paint.
  const remembered = state.openFolds ? state.openFolds.brief : undefined;
  const isOpen = remembered === undefined ? !!openIt : remembered;
  const openAttr = isOpen ? ' open' : '';

  if (!read || !read.brief || !read.brief.present) {
    return (
      '<details class="mem-fold" data-mem-fold="brief"' + openAttr + '>' +
        '<summary class="mem-fold-summary" id="mem-fold-brief">' + icon('chevronRight', 14) +
          '<span>Standing brief</span><span class="mem-fold-meta">not written</span></summary>' +
        '<div class="mem-fold-body"><p class="mem-quiet">No standing brief for this project. It is the part that ' +
        'rarely changes — the goal, the firm decisions, the working model — and every agent read returns it, so it is ' +
        'worth writing once.</p></div>' +
      '</details>'
    );
  }
  const b = read.brief;
  const age = formatAge(b.updatedAt ? Math.max(0, Math.round((Date.now() - Date.parse(b.updatedAt)) / 1000)) : null);
  return (
    '<details class="mem-fold" data-mem-fold="brief"' + openAttr + '>' +
      '<summary class="mem-fold-summary" id="mem-fold-brief">' + icon('chevronRight', 14) +
        '<span>Standing brief</span>' +
        '<span class="mem-fold-meta mono"' + (b.updatedAt ? ' title="' + escapeHtml(b.updatedAt) + '"' : '') + '>' +
          escapeHtml(age || 'updated') + '</span></summary>' +
      '<div class="mem-fold-body">' +
        (b.truncated ? '<div class="mem-note">' + icon('alertTriangle', 13) +
          '<span>Longer than the brief budget — the tail is not shown.</span></div>' : '') +
        // Same preamble strip as the handoff: this fold's own header already
        // says "Standing brief" and when it was updated, so the document's
        // title and `_Updated: …_` line are duplicate chrome here too.
        '<div class="mem-doc">' + renderMarkdown(splitHandoffPreamble(b.text || '').body) + '</div>' +
      '</div>' +
    '</details>'
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
  const journalOpen = (state.openFolds && state.openFolds.journal) ? ' open' : '';
  if (!j.returned) {
    return (
      '<details class="mem-fold" data-mem-fold="journal"' + journalOpen + '>' +
        '<summary class="mem-fold-summary" id="mem-fold-journal">' + icon('chevronRight', 14) +
          '<span>Session journal</span><span class="mem-fold-meta">empty</span></summary>' +
        '<div class="mem-fold-body"><p class="mem-quiet">No saves recorded under this scope and machine yet.</p></div>' +
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
        '<div class="mem-j-when mono"' + (e.at ? ' title="' + escapeHtml(e.at) + '"' : '') + '>' +
          escapeHtml(e.at ? e.at.slice(0, 16).replace('T', ' ') : 'unknown') + '</div>' +
        '<div class="mem-j-body">' +
          '<div class="mem-j-headline">' + escapeHtml(e.headline || '(no headline)') + '</div>' +
          (meta ? '<div class="mem-j-meta mono">' + meta + '</div>' : '') +
          rej +
        '</div>' +
      '</li>'
    );
  }).join('');

  // A fact and its absence, kept apart: `total: null` with totalUnknown means
  // the journal was longer than the tail we read, so we do NOT know the count
  // and must not print the tail's length as if we did.
  let countLine;
  if (j.totalUnknown) {
    countLine = 'Showing the ' + j.returned + ' most recent. The full count is unknown — ' +
      (j.totalUnknownReason || 'only the end of the journal was read') + '.';
  } else if (typeof j.total === 'number' && j.total > j.returned) {
    countLine = 'Showing the ' + j.returned + ' most recent of ' + j.total + '.';
  } else {
    countLine = j.returned + ' save' + (j.returned === 1 ? '' : 's') + ' recorded.';
  }

  const canExpand = state.journalLimit === JOURNAL_PAGE &&
    (j.totalUnknown || (typeof j.total === 'number' && j.total > j.returned));
  // In the <details> BODY, never in its <summary> — see the header comment.
  const moreBtn = canExpand
    ? '<button class="btn btn-xs mem-j-more" id="mem-journal-more">Show more</button>'
    : '';

  return (
    '<details class="mem-fold" data-mem-fold="journal"' + journalOpen + '>' +
      '<summary class="mem-fold-summary" id="mem-fold-journal">' + icon('chevronRight', 14) +
        '<span>Session journal</span>' +
        '<span class="mem-fold-meta mono">' + escapeHtml(String(j.returned)) + '</span></summary>' +
      '<div class="mem-fold-body">' +
        // The journal is APPEND-ONLY history, newest first, and any entry
        // MAY HAVE BEEN SUPERSEDED — a blocker named in an old headline can
        // have been fixed three saves ago. Someone skimming this list for
        // "what is blocking us" is exactly the person who would act on that,
        // so the framing is stated once, above the list, rather than left to
        // be inferred. The current handoff above is the authoritative present.
        '<p class="mem-quiet mem-j-framing">History, newest first. Any entry may since have been ' +
        'superseded — the current handoff above is what is true now.</p>' +
        '<ol class="mem-j-list">' + rows + '</ol>' +
        '<div class="mem-j-foot"><span class="mem-quiet">' + escapeHtml(countLine) + '</span>' + moreBtn + '</div>' +
      '</div>' +
    '</details>'
  );
}

/**
 * The one explanatory surface. Closed by default and last on the page:
 * needed once, then never again. Contains no interactive control, so its
 * <summary> has nothing to swallow.
 */
function renderAbout() {
  return (
    '<details class="mem-fold mem-about" data-mem-fold="about"' +
        ((state.openFolds && state.openFolds.about) ? ' open' : '') + '>' +
      '<summary class="mem-fold-summary" id="mem-fold-about">' + icon('chevronRight', 14) +
        '<span>How this works</span></summary>' +
      '<div class="mem-fold-body">' +
        '<p class="mem-quiet">Agent memory is three files per project, kept in <span class="mono">state/</span> ' +
        'beside that project’s wiki, and synced with it.</p>' +
        '<ul class="mem-about-list">' +
          '<li><b>Standing brief</b> — the part that rarely changes: the goal, the firm decisions, the working ' +
          'model. One per project, returned on every agent read.</li>' +
          '<li><b>Current handoff</b> — where things stand right now, per scope and per machine. A ' +
          '<i>scope</i> is one work-stream, so parallel threads never overwrite each other. Overwritten on ' +
          'every save, so it never grows stale behind you.</li>' +
          '<li><b>Session journal</b> — one line per save: when, which harness, which model, and the headline. ' +
          'It is history and it accumulates, so an old entry can describe something already resolved.</li>' +
        '</ul>' +
        '<p class="mem-quiet">Each machine writes to its own folder, so two machines can never overwrite each ' +
        'other over sync. Reading a scope with no machine named gives you the most recently written one, whichever ' +
        'machine that was.</p>' +
        '<p class="mem-quiet">This screen only reads. Your agents write it through the ' +
        '<span class="mono">my-curator</span> MCP tools — the files are plain markdown, so a text editor works too.</p>' +
      '</div>' +
    '</details>'
  );
}

// ── Wiring ───────────────────────────────────────────────────────────────

function wire(token) {
  document.querySelectorAll('.mem-row[data-mem-project]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const project = btn.dataset.memProject;
      if (project === state.activeProject) return;
      selectProject(project, token, { revalidateIndex: true })
        .catch((err) => reportAsyncMountFailure(token, err));
    });
  });

  // Record which disclosures are open so the next render can re-open them.
  // `toggle` fires only on a real change, never on parse, so emitting `open`
  // in the markup above does not feed back into this.
  document.querySelectorAll('[data-mem-fold]').forEach((el) => {
    el.addEventListener('toggle', () => {
      if (!state.openFolds) state.openFolds = {};
      state.openFolds[el.dataset.memFold] = el.open;
    });
  });

  const scopeSel = document.getElementById('mem-scope-select');
  if (scopeSel) {
    scopeSel.addEventListener('change', () => {
      state.journalLimit = JOURNAL_PAGE;
      loadScope(scopeSel.value, null, token).catch((err) => reportAsyncMountFailure(token, err));
    });
  }

  const machineSel = document.getElementById('mem-machine-select');
  if (machineSel) {
    machineSel.addEventListener('change', () => {
      state.journalLimit = JOURNAL_PAGE;
      loadScope(state.scope, machineSel.value, token).catch((err) => reportAsyncMountFailure(token, err));
    });
  }

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
};
