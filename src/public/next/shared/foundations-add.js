// shared/foundations-add.js — THE TWO DOORS INTO A PROJECT'S DOCUMENTS (v3.68.0)
//
// The maintainer, on v3.67.1's Documents step: "add foundational files to
// context locally from a computer OR from GitHub. From a computer: choose a
// folder, select files from it, drop them in, that's it. From GitHub: add a
// root, it finds the documents, you select them and mirror them."
//
// So step ① always shows two doors — **Add from this computer** and **Add
// from GitHub** — at 0 documents and at 20, and both lead to the SAME
// checklist: list what is there, tick, add.
//
// ── v3.69.0: ONE PROJECT, MANY SOURCES ──────────────────────────────────
// Through v3.68.0 what a door DID depended on the one ownership the project
// already had, and a door that could not work was disabled ("a project has
// one source"). The maintainer retired that rule: the source is recorded PER
// DOCUMENT, and one project may hold written documents, copies and mirrors of
// several folders and GitHub repositories at once (up to 8 source groups). So
// both doors are ALWAYS enabled — the only exceptions are a read-only Shared
// Brain mirror and an unreadable manifest — and what a commit does is chosen
// INSIDE the panel:
//
//   this computer   Keep in sync (a folder mirror) or Copy once — the radio
//                   defaults to Keep in sync when the folder is inside a git
//                   checkout, Copy once otherwise (maintainer decision D2)
//   GitHub          mirror the ticked files; a repository this project
//                   already mirrors takes them into the same source, any
//                   other becomes a new source
//
// "Already added" and the name each file would land on are the SERVER's
// answers (`alreadyAdded`, `alreadyAs`, `landsAs` on every scanned candidate,
// CONTRACT §4.3): the view reads them and derives nothing. A cap reached (200
// documents, 8 sources) is a refusal at commit, listed, never a disabled door.
//
// DOM-FREE, like shared/foundations-init.js, so a plain Node suite imports it
// and drives every rule here without a browser. It imports only from the
// DOM-free kit.
import {
  formatBytes, remoteRefusalText, selectedTokenSource, FOUNDATIONS_BUDGET_BYTES, MAX_FOUNDATION_BYTES,
} from './foundations-init.js';

/** The store's `FOUNDATIONS_BUDGET_BYTES` — a DISCLOSURE, never a wall.
 *  v3.72.1 (truth audit tray-copy F9): ONE client copy, foundations-init.js's,
 *  which test-next-memory-view.js pins to the store — never a third literal. */
export const PROJECT_BUDGET_BYTES = FOUNDATIONS_BUDGET_BYTES;
/** The store's `MAX_FOUNDATION_BYTES` — a WALL. The fallback only: a refused
 *  candidate carries the server's own `cap`, and the sentence quotes that. */
export const MAX_DOCUMENT_BYTES = MAX_FOUNDATION_BYTES;

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ═════════════════════════════════════════════════════════════════════════
// WHAT EACH DOOR DOES FOR THIS PROJECT
// ═════════════════════════════════════════════════════════════════════════

/**
 * THE TWO DOORS, AS FACTS — `{local, github}`, each `{available, mode, why,
 * note}`. v3.69.0: both are available on every project; `why` is set only on
 * a read-only mirror and on an unreadable manifest. The local door's mode is
 * chosen in the panel (the Keep in sync / Copy once radio), so it is `null`
 * here; the GitHub door always ADDS (`mode: 'add'`) — naming another
 * repository adds a source rather than switching one.
 *
 * NEVER READS `ownership` (CONTRACT §1.6): what a door does no longer depends
 * on what the project already holds.
 *
 * @param {object} facts   the view's `foundationsFacts(read)`
 * @param {{readonly?: boolean}} [opts]
 */
export function doorsFor(facts, opts) {
  const f = facts && typeof facts === 'object' ? facts : {};
  const o = opts && typeof opts === 'object' ? opts : {};
  const off = (why) => ({ available: false, mode: null, why, note: null });
  if (o.readonly) {
    const why = 'A read-only mirror — documents here are copied in, never added.';
    return { local: off(why), github: off(why) };
  }
  if (f.manifestError) {
    const why = f.manifestNewer   // v3.68.1: a newer app wrote it; nothing is broken
      ? 'These documents were saved by a newer version of The Curator, so nothing can be added until this app is updated.'
      : 'The documents list for this project cannot be read, so nothing can be added until it is fixed.';
    return { local: off(why), github: off(why) };
  }
  return {
    local: { available: true, mode: null, why: null, note: null },
    github: { available: true, mode: 'add', why: null,
      note: 'Name the repository, tick the documents, mirror them. They are re-read from GitHub whenever '
        + 'you refresh that source. A repository this project already mirrors takes them into the same '
        + 'source; any other repository becomes a new source beside the ones already here.' },
  };
}

/**
 * THE LOCAL PANEL'S LEAD SENTENCE — the chosen outcome, in one sentence (§4.2).
 */
export function localModeNote(rec) {
  const r = rec && typeof rec === 'object' ? rec : {};
  const auto = r.modeChosen !== true && r.inGitCheckout === true && r.mode === 'mirror';
  if (r.mode === 'mirror') {
    return (auto ? 'This folder is inside a git checkout, so the files are kept in sync: ' : 'Kept in sync: ')
      + 'the ticked files are mirrored, and every Refresh re-reads them from this folder.';
  }
  return 'Copied once: the ticked files are copied into this project and never change on their own.';
}

// ═════════════════════════════════════════════════════════════════════════
// THE PANEL'S STATE
// ═════════════════════════════════════════════════════════════════════════

/**
 * A fresh panel record for one door.
 *
 * `info.mode === 'switch'` (with `info.group` and `info.remote`) is the
 * sources strip's "Read from GitHub instead" — v3.65.1's switch, now per
 * source group: the GitHub panel opens on that group's recorded repository and
 * its commit re-reads the group's documents from there (`…/foundations/source
 * {group, remote, tokenSource}`). Nothing is listed or ticked in that mode.
 */
export function freshAddPanel(door, info, facts) {
  const d = door === 'github' ? 'github' : 'local';
  const i = info && typeof info === 'object' ? info : {};
  const remote = d === 'github' && i.remote ? i.remote : null;
  const switching = d === 'github' && i.mode === 'switch';
  return {
    door: d,
    // local: 'copy' | 'mirror' (the radio); github: 'add' | 'switch'
    mode: d === 'github' ? (switching ? 'switch' : 'add') : (i.mode === 'mirror' ? 'mirror' : 'copy'),
    // THE RADIO WAS PRESSED — once true, a listing never changes the mode
    // again (the D2 default applies only until the owner chooses).
    modeChosen: false,
    inGitCheckout: null,
    group: switching && typeof i.group === 'string' ? i.group : null,
    groupLabel: switching && typeof i.groupLabel === 'string' ? i.groupLabel : null,
    groupCount: switching && Number.isInteger(i.groupCount) ? i.groupCount : null,
    // local
    root: '',
    listedRoot: null,
    picking: false, pickError: null, pickUnavailable: null,
    // github
    remote: remote ? remote.owner + '/' + remote.repo : '',
    ref: remote && remote.ref ? remote.ref : '',
    path: '',
    tokenSource: null, hasReadToken: undefined, readTokenLast4: null, hasSyncToken: undefined,
    // the list
    scanning: false, scanError: null,
    candidates: null, truncated: false,
    picks: {},
    // the commit
    busy: false, error: null, refused: [],
    projectBytes: facts && Number.isFinite(facts.bytes) ? facts.bytes : 0,
    projectCount: facts && Number.isInteger(facts.count) ? facts.count : 0,
    budgetBytes: facts && Number.isInteger(facts.budgetBytes) && facts.budgetBytes > 0
      ? facts.budgetBytes : PROJECT_BUDGET_BYTES,
  };
}

/** `owner/repo`, or a github.com URL, as `{owner, repo}` — or null. */
export function parseRepoInput(s) {
  const raw = String(s || '').trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  let m = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/.exec(raw);
  if (!m) m = /^(?:https?:\/\/)?(?:www\.)?github\.com[/:]([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/i.exec(raw);
  if (!m) m = /^git@github\.com:([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/i.exec(raw);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** The typed ref/path, trimmed, `''` for "the default"/"the whole repository". */
function cleanRef(s) { return String(s || '').trim(); }
function cleanPath(s) { return String(s || '').trim().replace(/^\.?\/+/, '').replace(/\/+$/, ''); }

/**
 * WHICH LISTED PATHS ARE ALREADY IN THE PROJECT — shown ticked and disabled.
 *
 * v3.69.0: a READER of the server's `alreadyAdded` field, and nothing else
 * (CONTRACT §4.3). Through v3.68.0 this module derived it — a copy by the
 * document NAME it would land on, a mirror by source path — and a name is the
 * wrong key once a project holds several sources: `architecture.md` from
 * repository B is not "already added" because repository A's
 * `architecture.md` is. The store knows which group a path came through and
 * which other group reaches the same repository path; the view does not.
 * @returns {Set<string>}
 */
export function alreadyAdded(rec) {
  const out = new Set();
  const r = rec && typeof rec === 'object' ? rec : null;
  const cands = r && Array.isArray(r.candidates) ? r.candidates : [];
  for (const c of cands) if (c && c.alreadyAdded === true && typeof c.path === 'string') out.add(c.path);
  return out;
}

/** The document name a listed file would arrive under if nothing collided. */
export function naturalSlug(cand) {
  if (cand && typeof cand.suggestedSlug === 'string' && cand.suggestedSlug) return cand.suggestedSlug;
  const p = String(cand && cand.path || '');
  return p.slice(p.lastIndexOf('/') + 1).toLowerCase();
}

/**
 * THE NAME A TICKED FILE WILL LAND ON WHEN IT IS NOT ITS OWN — the server's
 * `landsAs` (§4.5), shown before the commit so a collision is never a silent
 * rename. `null` when it lands under its natural name.
 */
export function landsAsBadge(cand) {
  const l = cand && typeof cand.landsAs === 'string' && cand.landsAs ? cand.landsAs : null;
  if (!l) return null;
  return l !== naturalSlug(cand) ? l : null;
}

/** The ticked, addable paths, in list order. */
export function tickedPaths(rec) {
  const r = rec && typeof rec === 'object' ? rec : null;
  if (!r || !Array.isArray(r.candidates)) return [];
  const done = alreadyAdded(r);
  return r.candidates
    .filter((c) => c && r.picks[c.path] === true && !c.tooLarge && !done.has(c.path))
    .map((c) => c.path);
}

/** Bytes of the ticked rows. */
export function tickedBytes(rec) {
  const r = rec && typeof rec === 'object' ? rec : null;
  if (!r || !Array.isArray(r.candidates)) return 0;
  const on = new Set(tickedPaths(r));
  return r.candidates.reduce((n, c) => n + (c && on.has(c.path) && Number.isFinite(c.bytes) ? c.bytes : 0), 0);
}

/** The primary's words: "Copy 3 documents" / "Mirror 1 document" (§4.2). */
export function commitWord(rec) {
  const r = rec && typeof rec === 'object' ? rec : {};
  if (r.door === 'github' && r.mode === 'switch') {
    if (r.busy) return 'Reading from GitHub…';
    const n = Number.isInteger(r.groupCount) ? r.groupCount : null;
    return n === null ? 'Read from GitHub' : 'Read ' + n + ' document' + (n === 1 ? '' : 's') + ' from GitHub';
  }
  const n = tickedPaths(r).length;
  const docs = n ? n + ' document' + (n === 1 ? '' : 's') : 'documents';
  if (r.busy) return r.door === 'local' && r.mode === 'copy' ? 'Copying…' : 'Mirroring…';
  if (r.door === 'github') return 'Mirror ' + docs;
  return (r.mode === 'mirror' ? 'Mirror ' : 'Copy ') + docs;
}

/** Why the LIST step cannot run yet, or null. */
export function listBlockedReason(rec) {
  const r = rec && typeof rec === 'object' ? rec : {};
  if (r.door === 'github') {
    if (!String(r.remote || '').trim()) return 'Name the repository first — owner/repo, or its URL.';
    if (!parseRepoInput(r.remote)) return 'That is not a repository this can read. Use owner/repo, or the repository’s URL.';
    if (selectedTokenSource(r) === null) return 'Choose which saved token to read the repository with.';
    return null;
  }
  const root = String(r.root || '').trim();
  if (!root) return 'Choose a folder first.';
  if (!/^(\/|[A-Za-z]:[\\/])/.test(root)) return 'The folder must be a full path on this computer, like /Users/you/notes.';
  return null;
}

/** Why the COMMIT cannot run yet, or null. */
export function commitBlockedReason(rec) {
  const r = rec && typeof rec === 'object' ? rec : {};
  // THE SWITCH lists nothing: it re-reads the group's own documents, so the
  // only thing it needs is the token to read them with.
  if (r.door === 'github' && r.mode === 'switch') return listBlockedReason(r);
  if (!Array.isArray(r.candidates)) return listBlockedReason(r) || 'List the documents first.';
  if (!tickedPaths(r).length) return 'Tick at least one document.';
  return null;
}

/** The count line: ticks and bytes, and what the project would then hold —
 *  said NEUTRALLY (v3.70.0). The 200 KB project figure only ever warned; what
 *  an agent is handed is the reading budget's question (Context, step ④). */
export function countLine(rec) {
  const n = tickedPaths(rec).length;
  const b = tickedBytes(rec);
  const total = (rec.projectBytes || 0) + b;
  return n + ' ticked · ' + formatBytes(b) + ' — the project would hold '
    + formatBytes(total) + ' of documents';
}

/** v3.70.0: WITHDRAWN as an alarm with the 200 KB project figure — always ''.
 *  Kept as an export (and its hidden slot in the panel) so a host that still
 *  asks gets "nothing to warn about" rather than a ReferenceError. A stored
 *  total is never "over budget": the reading budget is the limit that decides
 *  what an agent is handed, and step ④ draws it. */
export function budgetWarning() {
  return '';
}

// ═════════════════════════════════════════════════════════════════════════
// THE REQUESTS
// ═════════════════════════════════════════════════════════════════════════

/**
 * The list request's URL. With the project named (`rec.domain`,
 * `rec.project`) the server annotates every candidate with `alreadyAdded`,
 * `alreadyAs` and `landsAs` (§4.3); the local door also says which listing
 * it is (`mode=copy|mirror`), because "already added" means a different thing
 * for a copy (a copy of this file from this folder) than for a mirror (this
 * path, through any source of the same repository).
 */
export function listUrl(rec) {
  const q = ['all=1'];
  if (rec.door === 'github') {
    const p = parseRepoInput(rec.remote);
    q.push('source=remote');
    q.push('remote=' + encodeURIComponent(p ? p.owner + '/' + p.repo : String(rec.remote || '').trim()));
    if (cleanRef(rec.ref)) q.push('ref=' + encodeURIComponent(cleanRef(rec.ref)));
    if (cleanPath(rec.path)) q.push('path=' + encodeURIComponent(cleanPath(rec.path)));
    q.push('tokenSource=' + (selectedTokenSource(rec) === 'sync' ? 'sync' : 'config'));
  } else {
    q.push('root=' + encodeURIComponent(String(rec.root || '').trim()));
    q.push('mode=' + (rec.mode === 'mirror' ? 'mirror' : 'copy'));
  }
  if (rec.domain && rec.project) {
    q.push('domain=' + encodeURIComponent(rec.domain));
    q.push('project=' + encodeURIComponent(rec.project));
  }
  return '/api/memory/repo-scan?' + q.join('&');
}

/**
 * THE COMMIT, as `{url, body}` — one of three routes (v3.69.0):
 *
 *   this computer             POST …/add-local  {root, files, mode}
 *   GitHub                    POST …/add-remote {remote, tokenSource, files}
 *   "Read from GitHub instead"  POST …/source   {group, remote, tokenSource}
 *
 * NO TOKEN is ever in a body: `tokenSource` names which saved file the server
 * reads it from. `remote` carries owner, repo and the typed ref; the typed
 * folder is a LISTING scope only (the scan returns repository-relative paths,
 * §3.2), so it never rides on the commit.
 */
export function buildAddCommit(rec, facts, domain, project) {
  const base = '/api/memory/' + encodeURIComponent(domain) + '/' + encodeURIComponent(project) + '/foundations/';
  const files = tickedPaths(rec).map((p) => ({ path: p }));
  if (rec.door === 'local') {
    return { url: base + 'add-local', body: {
      root: String(rec.listedRoot || rec.root || '').trim(), files, mode: rec.mode === 'mirror' ? 'mirror' : 'copy' } };
  }
  const p = parseRepoInput(rec.remote) || { owner: '', repo: String(rec.remote || '').trim() };
  const remote = { owner: p.owner, repo: p.repo };
  if (cleanRef(rec.ref)) remote.ref = cleanRef(rec.ref);
  const tokenSource = selectedTokenSource(rec) === 'sync' ? 'sync' : 'config';
  if (rec.mode === 'switch') {
    return { url: base + 'source', body: { group: String(rec.group || ''), remote, tokenSource } };
  }
  return { url: base + 'add-remote', body: { remote, tokenSource, files } };
}

/** An `added`/`refreshed` entry as a document name: a slug string, or `{slug}`/`{path}`. */
function nameOf(x) {
  if (typeof x === 'string') return x;
  if (x && typeof x === 'object') return typeof x.slug === 'string' ? x.slug : (typeof x.path === 'string' ? x.path : null);
  return null;
}

/**
 * WHAT CAME BACK, from any of the three routes, as `{added, refused, error}`.
 * `error` is set for a refusal of the whole request, in plain words.
 */
export function readCommitResponse(status, data, rec) {
  const d = data && typeof data === 'object' ? data : {};
  const list = (v) => (Array.isArray(v) ? v : []);
  const refresh = d.refresh && typeof d.refresh === 'object' ? d.refresh : null;
  const added = list(d.added).concat(refresh ? list(refresh.added) : []).map(nameOf).filter((x) => typeof x === 'string');
  const refreshed = list(d.refreshed).concat(refresh ? list(refresh.refreshed) : []).map(nameOf).filter((x) => typeof x === 'string');
  const refused = list(d.refused).concat(refresh ? list(refresh.refused) : [])
    .filter((r) => r && typeof r === 'object')
    .map((r) => ({ path: String(r.path || ''), reason: String(r.reason || '') }));
  const okStatus = status >= 200 && status < 300 && d.ok !== false;
  let error = null;
  if (!okStatus) {
    const code = typeof d.reason === 'string' ? d.reason : null;
    error = (rec && rec.door === 'github' ? remoteRefusalText(code, { tokenSource: selectedTokenSource(rec) }) : null)
      || d.error || d.message || ('The request failed (HTTP ' + status + ').');
  } else if (refresh && refresh.ok === false) {
    error = 'The repository could not be read, so nothing was copied.';
  }
  return { ok: okStatus && !error, added, refreshed, refused, error };
}

/**
 * The toast after a commit: "3 documents mirrored from acme/lumina", plus one
 * line per ticked file that landed under a name of its own (`landsAs`) — the
 * rename was shown before the press and is said again after it.
 */
export function outcomeToast(rec, out) {
  const n = rec && rec.mode === 'switch' ? out.refreshed.length + out.added.length : out.added.length;
  const what = n + ' document' + (n === 1 ? '' : 's');
  const renamed = (Array.isArray(rec && rec.candidates) ? rec.candidates : [])
    .filter((c) => c && rec.picks && rec.picks[c.path] === true && landsAsBadge(c))
    .map((c) => c.path + ' landed as ' + c.landsAs);
  if (rec.door === 'github') {
    const p = parseRepoInput(rec.remote);
    if (rec.mode === 'switch') {
      return { title: what + ' now read from GitHub' + (p ? ' (' + p.owner + '/' + p.repo + ')' : ''),
        lines: [(rec.groupLabel ? 'The folder ' + rec.groupLabel : 'The folder') + ' is no longer used for them.'] };
    }
    return { title: what + ' mirrored' + (p ? ' from ' + p.owner + '/' + p.repo : ''), lines: renamed };
  }
  const folder = String(rec.listedRoot || rec.root || '').replace(/[\\/]+$/, '');
  const base = folder.slice(Math.max(folder.lastIndexOf('/'), folder.lastIndexOf('\\')) + 1);
  return { title: what + (rec.mode === 'mirror' ? ' mirrored from ' + (base || 'the folder') : ' copied in'),
    lines: renamed };
}

// ═════════════════════════════════════════════════════════════════════════
// THE MARKUP
// ═════════════════════════════════════════════════════════════════════════

/**
 * THE TWO DOORS, for the step's head row. Always both. A door that cannot
 * work is `aria-disabled` (so the press still arrives and can be answered
 * with its reason) and carries the reason as its tooltip.
 */
export function renderDoors(doors, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const busy = o.busy === true;
  const open = o.open || null;
  const one = (key, id, label) => {
    const d = doors && doors[key] ? doors[key] : { available: false, why: null };
    const pressed = open === key;
    if (!d.available) {
      return '<button type="button" class="btn btn-secondary btn-xs mem-fnd-door mem-fnd-blocked" id="' + id + '"'
        + ' aria-disabled="true" data-fnd-door-why="' + escapeHtml(d.why || '') + '"'
        + ' title="' + escapeHtml(d.why || '') + '">' + escapeHtml(label) + '</button>';
    }
    return '<button type="button" class="btn btn-secondary btn-xs mem-fnd-door" id="' + id + '"'
      + ' data-fnd-door="' + key + '" aria-expanded="' + (pressed ? 'true' : 'false') + '"'
      + (busy ? ' disabled aria-disabled="true"' : '') + '>' + escapeHtml(label) + '</button>';
  };
  return one('local', 'mem-fnd-door-local', 'Add from this computer')
    + one('github', 'mem-fnd-door-github', 'Add from GitHub');
}

/**
 * THE AT-SESSION-START LEGEND — one compact line near the table, plain words.
 * A full explainer is a later release.
 */
export function startLegendHtml() {
  return '<p class="mem-fnd-legend" id="mem-fnd-legend">'
    + '<b>Read first</b> — sent in full when a session starts (counts against the reading budget). '
    + '<b>On request</b> — listed by name; the agent opens it only when needed (no budget cost). '
    + '<b>Not at start</b> — hidden at the start; opened by name only.'
    + '</p>';
}

function field(id, label, placeholder, value, dis, extraAttrs) {
  return '<div class="fnd-init-field">'
    + '<label class="fnd-init-label cur-eyebrow" for="' + id + '">' + escapeHtml(label) + '</label>'
    + '<input class="fnd-init-path" id="' + id + '" type="text" autocomplete="off" spellcheck="false"'
    + ' placeholder="' + escapeHtml(placeholder) + '" value="' + escapeHtml(value || '') + '"'
    + (dis ? ' disabled' : '') + (extraAttrs || '') + ' />'
    + '</div>';
}

function tokenRadios(rec, dis, host) {
  const src = selectedTokenSource(rec);
  const last4 = typeof rec.readTokenLast4 === 'string' && /^[A-Za-z0-9_]{1,4}$/.test(rec.readTokenLast4)
    ? rec.readTokenLast4 : '';
  const cfgState = rec.hasReadToken === true ? (last4 ? 'ends in …' + last4 : 'saved')
    : rec.hasReadToken === false ? 'not saved yet' : '';
  const syncState = rec.hasSyncToken === true ? 'connected' : rec.hasSyncToken === false ? 'not connected' : '';
  const opt = (value, name, where, state, off, after) =>
    '<div class="fnd-init-token-line"><label class="fnd-init-token-opt">'
    + '<input type="radio" name="fadd-token" value="' + value + '" data-fadd-token="' + value + '"'
    + (src === value ? ' checked' : '') + (dis || off ? ' disabled' : '') + ' />'
    + '<span class="fnd-init-token-text"><span class="fnd-init-token-head">'
    + '<span class="fnd-init-token-name">' + escapeHtml(name) + '</span>'
    + '<span class="fnd-init-token-where">' + escapeHtml(where) + '</span>'
    + (state ? '<span class="fnd-init-token-sep" aria-hidden="true">·</span><span class="fnd-init-token-state">'
      + escapeHtml(state) + '</span>' : '')
    + '</span></span></label>' + (after || '') + '</div>';
  const door = rec.hasReadToken === false
    ? '<button type="button" class="btn btn-secondary btn-xs" id="fadd-token-door"' + (dis ? ' disabled' : '')
      + '>Add one in Settings</button>' : '';
  return '<div class="fnd-init-readwith"><span class="fnd-init-label cur-eyebrow">Read with</span>'
    + (host && host.readWithInfo ? host.readWithInfo.btn || '' : '') + '</div>'
    + (host && host.readWithInfo ? host.readWithInfo.panel || '' : '')
    + '<div class="fnd-init-tokens" role="radiogroup" aria-label="Which saved token to read the repository with">'
    + opt('config', 'Read-only token', '— Settings › Knowledge base', cfgState, false, door)
    + opt('sync', 'Personal Sync’s token', '— the one that syncs your knowledge base', syncState,
      rec.hasSyncToken === false && src !== 'sync', '')
    + '</div>';
}

function candidateRow(rec, cand, done, dis) {
  const path = String(cand && cand.path || '');
  const size = '<span class="fnd-init-cand-size">' + escapeHtml(formatBytes(cand && cand.bytes)) + '</span>';
  if (done) {
    // "already added", and — when the server says it arrived under a name of
    // its own — which name, so the owner can find the row in the table.
    const as = cand && typeof cand.alreadyAs === 'string' && cand.alreadyAs && cand.alreadyAs !== naturalSlug(cand)
      ? cand.alreadyAs : null;
    return '<div class="fnd-init-cand is-mirrored" data-fadd-row="' + escapeHtml(path) + '">'
      + '<label class="fnd-init-cand-main">'
      + '<input type="checkbox" class="cur-check" checked disabled aria-label="' + escapeHtml(path + ' — already added') + '" />'
      + '<span class="fnd-init-cand-path">' + escapeHtml(path) + '</span>'
      + '<span class="mem-badge mem-badge-quiet">' + escapeHtml(as ? 'already added as ' + as : 'already added') + '</span>'
      + '</label>' + size + '</div>';
  }
  if (cand && cand.tooLarge) {
    return '<div class="fnd-init-cand is-refused" data-fadd-row="' + escapeHtml(path) + '">'
      + '<label class="fnd-init-cand-main">'
      + '<input type="checkbox" class="cur-check" disabled aria-label="' + escapeHtml(path + ' — too large') + '" />'
      + '<span class="fnd-init-cand-path">' + escapeHtml(path) + '</span>'
      + '</label>' + size
      + '<span class="fnd-init-cand-why">' + escapeHtml(formatBytes(cand.bytes) + ' is over the '
        + formatBytes(Number.isInteger(cand.cap) && cand.cap > 0 ? cand.cap : MAX_DOCUMENT_BYTES)
        + ' per-document limit — it cannot be added') + '</span>'
      + '</div>';
  }
  const on = rec.picks[path] === true;
  // THE NAME IT WILL LAND ON, when that is not its own (§4.5) — a quiet badge
  // BEFORE the commit, never a silent rename after it.
  const lands = landsAsBadge(cand);
  return '<div class="fnd-init-cand" data-fadd-row="' + escapeHtml(path) + '">'
    + '<label class="fnd-init-cand-main">'
    + '<input type="checkbox" class="cur-check" data-fadd-pick="' + escapeHtml(path) + '"'
    + (on ? ' checked' : '') + (dis ? ' disabled' : '') + ' />'
    + '<span class="fnd-init-cand-path">' + escapeHtml(path) + '</span>'
    + (lands ? '<span class="mem-badge mem-badge-quiet fnd-lands-as">' + escapeHtml('lands as ' + lands) + '</span>' : '')
    + (cand && cand.firstHeading ? '<span class="fnd-init-cand-head">' + escapeHtml(String(cand.firstHeading)) + '</span>' : '')
    + '</label>' + size + '</div>';
}

/**
 * THE KEEP IN SYNC / COPY ONCE CONTROL (§4.2, maintainer decision D2). Both
 * options always visible; the default is Keep in sync when the listed folder
 * is inside a git checkout (the scan's `inGitCheckout`) and Copy once
 * otherwise, until the owner presses one.
 */
function modeRadios(rec, dis) {
  const opt = (value, name, what) =>
    '<label class="fnd-init-token-opt mem-fnd-add-mode-opt">'
    + '<input type="radio" name="fadd-mode" value="' + value + '" data-fadd-mode="' + value + '"'
    + (rec.mode === value ? ' checked' : '') + (dis ? ' disabled' : '') + ' />'
    + '<span class="fnd-init-token-text"><span class="fnd-init-token-head">'
    + '<span class="fnd-init-token-name">' + escapeHtml(name) + '</span>'
    + '<span class="fnd-init-token-where">' + escapeHtml(what) + '</span>'
    + '</span></span></label>';
  return '<div class="fnd-init-field">'
    + '<span class="fnd-init-label cur-eyebrow" id="fadd-mode-label">What the files become</span>'
    + '<div class="fnd-init-tokens mem-fnd-add-mode" role="radiogroup" aria-labelledby="fadd-mode-label">'
    + opt('mirror', 'Keep in sync with this folder', '— a mirror: Refresh re-reads the files')
    + opt('copy', 'Copy once', '— the text is copied in and never changes on its own')
    + '</div></div>';
}

/**
 * THE OPEN PANEL — source, list, checklist, commit. One box, one primary.
 * @param {object} rec    the panel record (`freshAddPanel`)
 * @param {object} facts  the view's facts
 * @param {object} door   this door's `doorsFor(...)` entry
 * @param {{readWithInfo?: {btn, panel}}} [host]
 */
export function renderAddPanel(rec, facts, door, host) {
  const busy = rec.busy === true;
  const dis = busy;
  const gh = rec.door === 'github';
  const switching = gh && rec.mode === 'switch';
  const note = switching
    ? 'These ' + (Number.isInteger(rec.groupCount) ? rec.groupCount + ' ' : '') + 'documents are re-read from '
      + 'GitHub by the same paths, and the folder' + (rec.groupLabel ? ' ' + rec.groupLabel : '')
      + ' is no longer used for them. Nothing is written unless every document can be read.'
    : gh ? (door && door.note ? door.note : '') : localModeNote(rec);

  let source;
  if (gh) {
    source = '<div class="fnd-init-remote-fields">'
      + field('fadd-remote', 'Repository', 'owner/repo', rec.remote, dis || switching)
      + field('fadd-ref', 'Branch or tag', 'the default branch', rec.ref, dis || switching)
      + (switching ? '' : field('fadd-path', 'Folder', 'the whole repository', rec.path, dis))
      + '</div>' + tokenRadios(rec, dis, host);
  } else {
    source = '<div class="fnd-init-field">'
      + '<label class="fnd-init-label cur-eyebrow" for="fadd-root">Folder on this computer</label>'
      + '<div class="fnd-init-row">'
      + '<input class="fnd-init-path" id="fadd-root" type="text" autocomplete="off" spellcheck="false"'
      + ' placeholder="/Users/you/Documents/project-notes" value="' + escapeHtml(rec.root) + '"'
      + (dis ? ' disabled' : '') + ' />'
      + (rec.pickUnavailable ? '' : '<button type="button" class="btn btn-secondary btn-xs" id="fadd-pick"'
        + (dis || rec.picking ? ' disabled' : '') + '>' + (rec.picking ? 'Choosing…' : 'Choose folder…') + '</button>')
      + '</div></div>' + modeRadios(rec, dis);
  }
  const listBlocked = listBlockedReason(rec);
  const listBtn = switching ? '' : '<div class="fnd-init-row">'
    + '<button type="button" class="btn btn-secondary btn-xs" id="fadd-list"'
    + (dis || rec.scanning || listBlocked ? ' disabled' : '') + '>'
    + (rec.scanning ? 'Looking…' : (Array.isArray(rec.candidates) ? 'List again' : 'List documents')) + '</button>'
    + '</div>';

  const loud = (id, text) => '<div class="fnd-init-note fnd-init-note-loud mem-fnd-add-loud" role="alert"' + (id ? ' id="' + id + '"' : '') + '>'
    + '<span>' + escapeHtml(text) + '</span></div>';
  const notes = []
    .concat(rec.pickUnavailable ? ['<div class="tx-note"><span>' + escapeHtml(String(rec.pickUnavailable)) + '</span></div>'] : [])
    .concat(rec.pickError ? [loud('fadd-pick-error', String(rec.pickError))] : [])
    .concat(rec.scanError ? [loud('fadd-scan-error', 'Nothing was listed: ' + rec.scanError)] : [])
    .join('');

  let list = '';
  if (!switching && Array.isArray(rec.candidates)) {
    const cands = rec.candidates;
    const done = alreadyAdded(rec);
    if (!cands.length) {
      list = '<div class="tx-note"><span>' + escapeHtml(gh
        ? 'No .md or .txt documents in that repository' + (cleanPath(rec.path) ? ' folder' : '') + '.'
        : 'No .md or .txt documents in that folder (hidden folders, node_modules and build output are skipped).')
        + '</span></div>';
    } else {
      const selectable = cands.filter((c) => c && !c.tooLarge && !done.has(c.path));
      const allOn = selectable.length > 0 && selectable.every((c) => rec.picks[c.path] === true);
      list = '<div class="mem-fnd-add-listhead">'
        + '<label class="cur-check-label mem-fnd-add-all"><input type="checkbox" class="cur-check" id="fadd-all"'
        + (allOn ? ' checked' : '') + (dis || !selectable.length ? ' disabled' : '') + ' />'
        + '<span>Select all (' + selectable.length + ')</span></label>'
        + '<span class="mem-fnd-add-count" id="fadd-count">' + escapeHtml(countLine(rec)) + '</span>'
        + '</div>'
        + '<div class="fnd-init-cands" id="fadd-cands">'
        + cands.map((c) => candidateRow(rec, c, done.has(c && c.path), dis)).join('')
        + '</div>'
        + (rec.truncated ? '<div class="tx-note"><span>Only the first ' + cands.length
          + ' documents are listed. Name a folder inside it to see the rest.</span></div>' : '')
        + '<div class="fnd-init-note fnd-init-note-loud mem-fnd-add-loud" id="fadd-budget"' + (budgetWarning(rec) ? '' : ' hidden') + '>'
        + '<span>' + escapeHtml(budgetWarning(rec)) + '</span></div>';
    }
  }

  const refused = Array.isArray(rec.refused) && rec.refused.length
    ? '<div class="fnd-init-note fnd-init-note-loud mem-fnd-add-loud" id="fadd-refused" role="alert"><span>'
      + escapeHtml(rec.refused.length + ' not added:') + '</span></div>'
      + '<ul class="mem-fnd-add-refused">' + rec.refused.map((r) => '<li><span class="fnd-init-cand-path">'
        + escapeHtml(r.path) + '</span> — ' + escapeHtml(r.reason) + '</li>').join('') + '</ul>'
    : '';
  const error = rec.error ? loud('fadd-error', rec.error) : '';
  const blocked = commitBlockedReason(rec);
  const showGo = switching || (Array.isArray(rec.candidates) && rec.candidates.length);
  const actions = '<div class="mem-fnd-init-actions">'
    + (showGo
      ? '<button type="button" class="btn btn-primary" id="fadd-go"' + (busy || blocked ? ' disabled' : '') + '>'
        + escapeHtml(commitWord(rec)) + '</button>' : '')
    + '<button type="button" class="btn btn-ghost btn-xs" id="fadd-cancel"' + (busy ? ' disabled' : '') + '>Cancel</button>'
    + '</div>';
  const whyText = (switching || Array.isArray(rec.candidates)) ? blocked : listBlocked;
  const why = '<div class="tx-note fnd-init-why" id="fadd-why"' + (whyText ? '' : ' hidden') + '><span>'
    + escapeHtml(whyText || '') + '</span></div>';

  return '<div class="mem-fnd-panel mem-fnd-add" id="fadd-panel" data-fadd-door="' + rec.door + '">'
    + '<div class="mem-fnd-panel-eyebrow cur-group-title">'
    + (switching ? 'READ FROM GITHUB INSTEAD' : gh ? 'ADD FROM GITHUB' : 'ADD FROM THIS COMPUTER') + '</div>'
    + '<div class="mem-fnd-init-body">'
    + (note ? '<p class="tx-desc mem-fnd-add-note" id="fadd-note">' + escapeHtml(note) + '</p>' : '')
    + source + listBtn + notes + list
    + error + refused + actions + why
    + '</div></div>';
}
