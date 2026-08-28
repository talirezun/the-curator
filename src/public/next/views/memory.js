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
  };
}

let state = freshState();

// Same mount-token discipline as chat.js / domains.js / sync.js: captured as
// a local BEFORE the first await in every async function and threaded
// through, never re-derived afterwards. A boolean cannot distinguish "still
// mounted" from "REmounted", which is the case that actually bites.
let myMountToken = 0;
let loadGate = null;

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

    return () => {
      // Timer hygiene: an armed delay timer surviving teardown would paint a
      // loader into whatever view mounts next.
      if (loadGate) { loadGate.cancel(); loadGate = null; }
    };
  },
});

// ── Load ─────────────────────────────────────────────────────────────────

async function loadIndex(token) {
  const gate = loadGate;                 // capture: the next mount replaces it
  try {
    const res = await fetch('/api/memory');
    const data = await res.json();
    if (!isCurrentMount(token)) return;
    if (!res.ok || !data.ok) {
      state.indexError = data.error || ('HTTP ' + res.status);
      state.projects = [];
    } else {
      state.projects = data.projects || [];
      state.indexError = null;
    }
  } catch (err) {
    if (!isCurrentMount(token)) return;
    state.indexError = err.message;
    state.projects = [];
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

async function selectProject(project, token) {
  state.activeProject = project;
  state.projectRead = null;
  state.detail = null;
  state.detailError = null;
  state.scope = null;
  state.machine = null;
  state.journalLimit = JOURNAL_PAGE;
  state.detailLoading = true;
  render(token);

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
  renderSidebar(token);
  renderMain(token);
  wire(token);
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

  setSidebar(
    head +
    '<div class="cur-eyebrow" style="margin-top:10px">PROJECTS</div>' +
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

  if (!scopes.length && !hasBrief) {
    return header + renderEmptyProject() + renderAbout();
  }

  return (
    header +
    renderScopeControls(scopes) +
    renderHandoff() +
    // The brief opens only when there is no handoff to read — then it is the
    // only content on the page, and folding it away would leave a blank view.
    renderBrief(read, !(d && d.current && d.current.present)) +
    renderJournal() +
    renderAbout()
  );
}

function renderEmptyProject() {
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

  const scopeCtl = scopeNames.length > 1
    ? '<label class="mem-ctl"><span class="mem-ctl-label">Scope</span>' +
        '<select class="mem-select" id="mem-scope-select">' +
          scopeNames.map((s) => '<option value="' + escapeHtml(s) + '"' +
            (s === state.scope ? ' selected' : '') + '>' + escapeHtml(s) + '</option>').join('') +
        '</select></label>'
    : (state.scope
        ? '<span class="mem-ctl"><span class="mem-ctl-label">Scope</span>' +
          '<span class="mem-ctl-static mono">' + escapeHtml(state.scope) + '</span></span>'
        : '');

  const machineCtl = machines.length > 1
    ? '<label class="mem-ctl"><span class="mem-ctl-label">Machine</span>' +
        '<select class="mem-select" id="mem-machine-select">' +
          machines.map((m) => '<option value="' + escapeHtml(m.machine) + '"' +
            (d && m.machine === d.machine ? ' selected' : '') + '>' +
            escapeHtml(m.machine) + ' · ' + escapeHtml(formatAge(m.ageSeconds) || 'unknown age') +
          '</option>').join('') +
        '</select></label>'
    : (d && d.machine
        ? '<span class="mem-ctl"><span class="mem-ctl-label">Machine</span>' +
          '<span class="mem-ctl-static mono">' + escapeHtml(d.machine) + '</span></span>'
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
  const truncated = (state.projectRead && state.projectRead.scopesTruncated)
    ? '<span class="mem-ctl-note">showing the ' + scopes.length + ' most recent saved copies of ' +
      escapeHtml(String(state.projectRead.scopeCount || scopes.length)) + '</span>'
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
  if (!read || !read.brief || !read.brief.present) {
    return (
      '<details class="mem-fold">' +
        '<summary class="mem-fold-summary">' + icon('chevronRight', 14) +
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
    '<details class="mem-fold"' + (openIt ? ' open' : '') + '>' +
      '<summary class="mem-fold-summary">' + icon('chevronRight', 14) +
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
  if (!j.returned) {
    return (
      '<details class="mem-fold">' +
        '<summary class="mem-fold-summary">' + icon('chevronRight', 14) +
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
    const rej = notes.length
      ? '<div class="mem-j-rej">' + escapeHtml(notes.length + ' note' +
          (notes.length === 1 ? '' : 's') + noteLabel + notes.join('; ')) + '</div>'
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
    '<details class="mem-fold">' +
      '<summary class="mem-fold-summary">' + icon('chevronRight', 14) +
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
    '<details class="mem-fold mem-about">' +
      '<summary class="mem-fold-summary">' + icon('chevronRight', 14) + '<span>How this works</span></summary>' +
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
      selectProject(project, token).catch((err) => reportAsyncMountFailure(token, err));
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
