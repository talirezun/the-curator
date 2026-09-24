// shared/foundations-add.js — THE TWO DOORS INTO A PROJECT'S DOCUMENTS (v3.68.0)
//
// The maintainer, on v3.67.1's Documents step: "add foundational files to
// context locally from a computer OR from GitHub. From a computer: choose a
// folder, select files from it, drop them in, that's it. From GitHub: add a
// root, it finds the documents, you select them and mirror them."
//
// So step ① always shows two doors — **Add from this computer** and **Add
// from GitHub** — at 0 documents and at 20, and both lead to the SAME
// checklist: list what is there, tick, add. What a door DOES depends on the
// one ownership the project already has, and the store decides it; this
// module only says it honestly, before the press:
//
//   project state                 this computer              GitHub
//   ─────────────────────────────  ─────────────────────────  ───────────────────────────
//   no documents yet               copy in (curator-kept)     mirror (repo, from GitHub)
//   kept here (curator)            copy in, appended          NOT AVAILABLE — one source
//   mirrors a folder               mirror more, from inside   switch the source to GitHub
//                                  that folder only
//   mirrors a GitHub repository    NOT AVAILABLE — one source add more from that repository
//                                                             (another repository = switch)
//
// A door that cannot work is shown DISABLED WITH ITS REASON, never hidden
// (the app's "disabled, never hidden" rule): pressing it answers with the
// sentence as a toast, and the same sentence is its tooltip.
//
// DOM-FREE, like shared/foundations-init.js, so a plain Node suite imports it
// and drives every rule here without a browser. It imports only from the
// DOM-free kit.
import { formatBytes, remoteRefusalText, selectedTokenSource } from './foundations-init.js';

/** The store's `FOUNDATIONS_BUDGET_BYTES` — a DISCLOSURE, never a wall. */
export const PROJECT_BUDGET_BYTES = 200 * 1024;
/** The store's `MAX_FOUNDATION_BYTES` — a WALL. */
export const MAX_DOCUMENT_BYTES = 512 * 1024;

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ═════════════════════════════════════════════════════════════════════════
// WHAT EACH DOOR DOES FOR THIS PROJECT
// ═════════════════════════════════════════════════════════════════════════

/** `{owner, repo, ref, path}` recorded on a mirror, or null. */
function recordedRemote(facts) {
  const r = facts && facts.repo && facts.repo.remote;
  if (!r || typeof r !== 'object' || !r.owner || !r.repo) return null;
  return { owner: String(r.owner), repo: String(r.repo), ref: r.ref || null, path: r.path || null };
}

/**
 * THE TWO DOORS, AS FACTS — `{local, github}`, each
 * `{available, mode, why}`. `mode` is what a commit will do:
 *   local:  'copy' | 'mirror'
 *   github: 'init' | 'add' | 'switch'
 * `why` is the sentence for a door that is not available (and null for one
 * that is). `note` is the honest one-line description the open panel leads
 * with.
 *
 * @param {object} facts   the view's `foundationsFacts(read)`
 * @param {{readonly?: boolean, sourceMissing?: boolean}} [opts]
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
    const why = 'The documents list for this project cannot be read, so nothing can be added until it is fixed.';
    return { local: off(why), github: off(why) };
  }
  const count = Number.isInteger(f.count) ? f.count : 0;
  const remote = recordedRemote(f);
  const root = f.repo && typeof f.repo.root === 'string' && f.repo.root ? f.repo.root : null;
  // ── NOTHING IN IT YET: BOTH DOORS, NOTHING DECIDED ──────────────────────
  if (!f.present || count === 0) {
    return {
      local: { available: true, mode: 'copy', why: null,
        note: 'Pick a folder, tick the documents, add them. They are copied into this project; '
          + 'add more later from the same folder or another one.' },
      github: { available: true, mode: 'init', why: null, rechoose: !!f.present,
        note: 'Name the repository, tick the documents, mirror them. They are re-read from GitHub '
          + 'whenever you refresh.' },
    };
  }
  if (f.ownership === 'curator') {
    return {
      local: { available: true, mode: 'copy', why: null,
        note: 'Pick a folder, tick the documents, add them. They are copied in beside the ones '
          + 'already here; nothing is replaced.' },
      github: off('This project keeps its own copies of its documents, so it cannot also mirror a '
        + 'GitHub repository — a project has one source. Start a new project to mirror a repository.'),
    };
  }
  // REPO-OWNED — a mirror.
  if (root) {
    const github = { available: true, mode: 'switch', why: null,
      note: 'This project mirrors the folder ' + root + '. Mirroring from GitHub makes the '
        + 'repository its source instead: its ' + count + ' document' + (count === 1 ? ' is' : 's are')
        + ' re-read from there by the same paths, and the folder stops being used.' };
    if (o.sourceMissing) {
      return {
        local: off('The folder this project mirrors (' + root + ') is not on this computer, so '
          + 'nothing can be added from it here. Add from GitHub instead, or open the project on the '
          + 'machine that has the folder.'),
        github,
      };
    }
    return {
      local: { available: true, mode: 'mirror', why: null, fixedRoot: root,
        note: 'This project mirrors the folder ' + root + '. Documents are added from inside it '
          + 'and stay in step with it on every refresh; a file from another folder cannot join a mirror.' },
      github,
    };
  }
  const label = remote ? remote.owner + '/' + remote.repo : 'a GitHub repository';
  return {
    local: off('This project mirrors ' + label + ' on GitHub, so its documents come from there — '
      + 'add more with Add from GitHub. A project has one source.'),
    github: { available: true, mode: 'add', why: null, remote,
      note: 'This project mirrors ' + label + '. Add more documents from it; naming a different '
        + 'repository switches the project’s source to that one.' },
  };
}

// ═════════════════════════════════════════════════════════════════════════
// THE PANEL'S STATE
// ═════════════════════════════════════════════════════════════════════════

/** A fresh panel record for one door. */
export function freshAddPanel(door, info, facts) {
  const d = door === 'github' ? 'github' : 'local';
  const i = info && typeof info === 'object' ? info : {};
  const remote = d === 'github' && i.remote ? i.remote : null;
  return {
    door: d,
    mode: i.mode || (d === 'github' ? 'init' : 'copy'),
    // local
    root: d === 'local' && i.fixedRoot ? String(i.fixedRoot) : '',
    fixedRoot: d === 'local' && i.fixedRoot ? String(i.fixedRoot) : null,
    listedRoot: null,
    picking: false, pickError: null, pickUnavailable: null,
    // github
    remote: remote ? remote.owner + '/' + remote.repo : '',
    ref: remote && remote.ref ? remote.ref : '',
    path: remote && remote.path ? remote.path : '',
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
 *   · a COPY is keyed by the document name it would land on (the server's
 *     `suggestedSlug`, the same derivation the copy uses): a second file of
 *     that name would be refused "already added", so it is never tickable;
 *   · a folder MIRROR by source path, rebased from the listed folder to the
 *     mirrored one;
 *   · a GitHub mirror by repository path.
 * @returns {Set<string>}
 */
export function alreadyAdded(rec, facts) {
  const out = new Set();
  const r = rec && typeof rec === 'object' ? rec : null;
  const docs = facts && Array.isArray(facts.docs) ? facts.docs : [];
  const cands = r && Array.isArray(r.candidates) ? r.candidates : [];
  if (!r || !cands.length) return out;
  if (r.door === 'local' && r.mode === 'copy') {
    const slugs = new Set(docs.map((d) => String(d && d.slug || '')));
    for (const c of cands) if (c && c.suggestedSlug && slugs.has(c.suggestedSlug)) out.add(c.path);
    return out;
  }
  const srcPaths = new Set(docs
    .map((d) => (d && d.source && typeof d.source.path === 'string' ? d.source.path : null))
    .filter(Boolean));
  let prefix = '';
  if (r.door === 'local' && r.mode === 'mirror') {
    const base = String(r.fixedRoot || '').replace(/\/+$/, '');
    const listed = String(r.listedRoot || '').replace(/\/+$/, '');
    if (base && listed && listed !== base && listed.startsWith(base + '/')) prefix = listed.slice(base.length + 1) + '/';
  }
  for (const c of cands) if (c && srcPaths.has(prefix + c.path)) out.add(c.path);
  return out;
}

/** The ticked, addable paths, in list order. */
export function tickedPaths(rec, facts) {
  const r = rec && typeof rec === 'object' ? rec : null;
  if (!r || !Array.isArray(r.candidates)) return [];
  const done = alreadyAdded(r, facts);
  return r.candidates
    .filter((c) => c && r.picks[c.path] === true && !c.tooLarge && !done.has(c.path))
    .map((c) => c.path);
}

/** Bytes of the ticked rows. */
export function tickedBytes(rec, facts) {
  const r = rec && typeof rec === 'object' ? rec : null;
  if (!r || !Array.isArray(r.candidates)) return 0;
  const on = new Set(tickedPaths(r, facts));
  return r.candidates.reduce((n, c) => n + (c && on.has(c.path) && Number.isFinite(c.bytes) ? c.bytes : 0), 0);
}

/** Does the GitHub panel name the repository this project already mirrors? */
export function namesRecordedRemote(rec, facts) {
  const rem = recordedRemote(facts);
  const typed = parseRepoInput(rec && rec.remote);
  if (!rem || !typed) return false;
  return rem.owner.toLowerCase() === typed.owner.toLowerCase()
    && rem.repo.toLowerCase() === typed.repo.toLowerCase()
    && cleanRef(rec.ref) === String(rem.ref || '')
    && cleanPath(rec.path) === String(rem.path || '');
}

/** The primary's words: "Add 3 documents" / "Mirror 1 document". */
export function commitWord(rec, facts) {
  const n = tickedPaths(rec, facts).length;
  const docs = n ? n + ' document' + (n === 1 ? '' : 's') : 'documents';
  if (rec && rec.busy) return rec.door === 'github' ? 'Mirroring…' : 'Adding…';
  if (rec && rec.door === 'github') return 'Mirror ' + docs;
  return (rec && rec.mode === 'mirror' ? 'Mirror ' : 'Add ') + docs;
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
export function commitBlockedReason(rec, facts) {
  const r = rec && typeof rec === 'object' ? rec : {};
  if (!Array.isArray(r.candidates)) return listBlockedReason(r) || 'List the documents first.';
  if (!tickedPaths(r, facts).length) return 'Tick at least one document.';
  return null;
}

/** The count line: ticks and bytes, and the project total against its budget. */
export function countLine(rec, facts) {
  const n = tickedPaths(rec, facts).length;
  const b = tickedBytes(rec, facts);
  const total = (rec.projectBytes || 0) + b;
  return n + ' ticked · ' + formatBytes(b) + ' — the project would hold '
    + formatBytes(total) + ' of its ' + formatBytes(rec.budgetBytes || PROJECT_BUDGET_BYTES) + ' budget';
}

/** The over-budget sentence (with the numbers), or ''. A cost: never folds. */
export function budgetWarning(rec, facts) {
  const b = tickedBytes(rec, facts);
  const total = (rec.projectBytes || 0) + b;
  const budget = rec.budgetBytes || PROJECT_BUDGET_BYTES;
  if (!b || total <= budget) return '';
  return 'These bring the project to ' + formatBytes(total) + ', over its ' + formatBytes(budget)
    + ' budget by ' + formatBytes(total - budget) + '. They are still added; a session start sends '
    + 'only what its reading budget allows, and says which documents it left out.';
}

// ═════════════════════════════════════════════════════════════════════════
// THE REQUESTS
// ═════════════════════════════════════════════════════════════════════════

/** The list request's URL. */
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
  }
  return '/api/memory/repo-scan?' + q.join('&');
}

/**
 * THE COMMIT, as `{url, body}` — one of four routes, chosen by the door's
 * mode and the facts. NO TOKEN is ever in a body: `tokenSource` names which
 * saved file the server reads it from.
 */
export function buildAddCommit(rec, facts, domain, project) {
  const base = '/api/memory/' + encodeURIComponent(domain) + '/' + encodeURIComponent(project) + '/foundations/';
  const files = tickedPaths(rec, facts).map((p) => ({ path: p }));
  if (rec.door === 'local') {
    return { url: base + 'add-local', body: { root: String(rec.listedRoot || rec.root || '').trim(), files } };
  }
  const p = parseRepoInput(rec.remote) || { owner: '', repo: String(rec.remote || '').trim() };
  const remote = { owner: p.owner, repo: p.repo };
  if (cleanRef(rec.ref)) remote.ref = cleanRef(rec.ref);
  if (cleanPath(rec.path)) remote.path = cleanPath(rec.path);
  const tokenSource = selectedTokenSource(rec) === 'sync' ? 'sync' : 'config';
  if (rec.mode === 'init') {
    const body = { ownership: 'repo', remote, tokenSource, files };
    if (facts && facts.present) body.rechooseEmpty = true;
    return { url: base + 'init', body };
  }
  if (rec.mode === 'add' && namesRecordedRemote(rec, facts)) {
    return { url: base + 'refresh', body: { source: 'remote', tokenSource, files } };
  }
  return { url: base + 'source', body: { remote, tokenSource, files } };
}

/**
 * WHAT CAME BACK, from any of the four routes, as `{added, refused, error}`.
 * `error` is set for a refusal of the whole request, in plain words.
 */
export function readCommitResponse(status, data, rec) {
  const d = data && typeof data === 'object' ? data : {};
  const list = (v) => (Array.isArray(v) ? v : []);
  const refresh = d.refresh && typeof d.refresh === 'object' ? d.refresh : null;
  const added = list(d.added).concat(refresh ? list(refresh.added) : []).filter((x) => typeof x === 'string');
  const refreshed = list(d.refreshed).concat(refresh ? list(refresh.refreshed) : []).filter((x) => typeof x === 'string');
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

/** The toast after a commit: "3 documents added". */
export function outcomeToast(rec, out) {
  const n = out.added.length;
  const what = n + ' document' + (n === 1 ? '' : 's');
  if (rec.door === 'github') {
    const p = parseRepoInput(rec.remote);
    return { title: what + ' mirrored' + (p ? ' from ' + p.owner + '/' + p.repo : ''),
      lines: rec.mode === 'switch' || (rec.mode === 'add' && out.refreshed.length)
        ? ['The project now reads its documents from GitHub.'] : [] };
  }
  return { title: what + (rec.mode === 'mirror' ? ' mirrored from the folder' : ' added'), lines: [] };
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
    return '<div class="fnd-init-cand is-mirrored" data-fadd-row="' + escapeHtml(path) + '">'
      + '<label class="fnd-init-cand-main">'
      + '<input type="checkbox" class="cur-check" checked disabled aria-label="' + escapeHtml(path + ' — already added') + '" />'
      + '<span class="fnd-init-cand-path">' + escapeHtml(path) + '</span>'
      + '<span class="mem-badge mem-badge-quiet">already added</span>'
      + '</label>' + size + '</div>';
  }
  if (cand && cand.tooLarge) {
    return '<div class="fnd-init-cand is-refused" data-fadd-row="' + escapeHtml(path) + '">'
      + '<label class="fnd-init-cand-main">'
      + '<input type="checkbox" class="cur-check" disabled aria-label="' + escapeHtml(path + ' — too large') + '" />'
      + '<span class="fnd-init-cand-path">' + escapeHtml(path) + '</span>'
      + '</label>' + size
      + '<span class="fnd-init-cand-why">' + escapeHtml(formatBytes(cand.bytes) + ' is over the '
        + formatBytes(MAX_DOCUMENT_BYTES) + ' per-document limit — it cannot be added') + '</span>'
      + '</div>';
  }
  const on = rec.picks[path] === true;
  return '<div class="fnd-init-cand" data-fadd-row="' + escapeHtml(path) + '">'
    + '<label class="fnd-init-cand-main">'
    + '<input type="checkbox" class="cur-check" data-fadd-pick="' + escapeHtml(path) + '"'
    + (on ? ' checked' : '') + (dis ? ' disabled' : '') + ' />'
    + '<span class="fnd-init-cand-path">' + escapeHtml(path) + '</span>'
    + (cand && cand.firstHeading ? '<span class="fnd-init-cand-head">' + escapeHtml(String(cand.firstHeading)) + '</span>' : '')
    + '</label>' + size + '</div>';
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
  const note = door && door.note ? door.note : '';
  const switching = gh && (rec.mode === 'switch' || (rec.mode === 'add' && String(rec.remote || '').trim()
    && !namesRecordedRemote(rec, facts)));

  let source;
  if (gh) {
    source = '<div class="fnd-init-remote-fields">'
      + field('fadd-remote', 'Repository', 'owner/repo', rec.remote, dis)
      + field('fadd-ref', 'Branch or tag', 'the default branch', rec.ref, dis)
      + field('fadd-path', 'Folder', 'the whole repository', rec.path, dis)
      + '</div>' + tokenRadios(rec, dis, host);
  } else if (rec.mode === 'mirror') {
    source = '<div class="fnd-init-field">'
      + '<label class="fnd-init-label cur-eyebrow" for="fadd-root">Folder (inside the mirrored folder)</label>'
      + '<div class="fnd-init-row">'
      + '<input class="fnd-init-path" id="fadd-root" type="text" autocomplete="off" spellcheck="false"'
      + ' value="' + escapeHtml(rec.root) + '"' + (dis ? ' disabled' : '') + ' />'
      + (rec.pickUnavailable ? '' : '<button type="button" class="btn btn-secondary btn-xs" id="fadd-pick"'
        + (dis || rec.picking ? ' disabled' : '') + '>' + (rec.picking ? 'Choosing…' : 'Choose folder…') + '</button>')
      + '</div></div>';
  } else {
    source = '<div class="fnd-init-field">'
      + '<label class="fnd-init-label cur-eyebrow" for="fadd-root">Folder on this computer</label>'
      + '<div class="fnd-init-row">'
      + '<input class="fnd-init-path" id="fadd-root" type="text" autocomplete="off" spellcheck="false"'
      + ' placeholder="/Users/you/Documents/project-notes" value="' + escapeHtml(rec.root) + '"'
      + (dis ? ' disabled' : '') + ' />'
      + (rec.pickUnavailable ? '' : '<button type="button" class="btn btn-secondary btn-xs" id="fadd-pick"'
        + (dis || rec.picking ? ' disabled' : '') + '>' + (rec.picking ? 'Choosing…' : 'Choose folder…') + '</button>')
      + '</div></div>';
  }
  const listBlocked = listBlockedReason(rec);
  const listBtn = '<div class="fnd-init-row">'
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
  if (Array.isArray(rec.candidates)) {
    const cands = rec.candidates;
    const done = alreadyAdded(rec, facts);
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
        + '<span class="mem-fnd-add-count" id="fadd-count">' + escapeHtml(countLine(rec, facts)) + '</span>'
        + '</div>'
        + '<div class="fnd-init-cands" id="fadd-cands">'
        + cands.map((c) => candidateRow(rec, c, done.has(c && c.path), dis)).join('')
        + '</div>'
        + (rec.truncated ? '<div class="tx-note"><span>Only the first ' + cands.length
          + ' documents are listed. Name a folder inside it to see the rest.</span></div>' : '')
        + '<div class="fnd-init-note fnd-init-note-loud mem-fnd-add-loud" id="fadd-budget"' + (budgetWarning(rec, facts) ? '' : ' hidden') + '>'
        + '<span>' + escapeHtml(budgetWarning(rec, facts)) + '</span></div>';
    }
  }

  const refused = Array.isArray(rec.refused) && rec.refused.length
    ? '<div class="fnd-init-note fnd-init-note-loud mem-fnd-add-loud" id="fadd-refused" role="alert"><span>'
      + escapeHtml(rec.refused.length + ' not added:') + '</span></div>'
      + '<ul class="mem-fnd-add-refused">' + rec.refused.map((r) => '<li><span class="fnd-init-cand-path">'
        + escapeHtml(r.path) + '</span> — ' + escapeHtml(r.reason) + '</li>').join('') + '</ul>'
    : '';
  const error = rec.error ? loud('fadd-error', rec.error) : '';
  const blocked = commitBlockedReason(rec, facts);
  const actions = '<div class="mem-fnd-init-actions">'
    + (Array.isArray(rec.candidates) && rec.candidates.length
      ? '<button type="button" class="btn btn-primary" id="fadd-go"' + (busy || blocked ? ' disabled' : '') + '>'
        + escapeHtml(commitWord(rec, facts)) + '</button>' : '')
    + '<button type="button" class="btn btn-ghost btn-xs" id="fadd-cancel"' + (busy ? ' disabled' : '') + '>Cancel</button>'
    + '</div>';
  const why = '<div class="tx-note fnd-init-why" id="fadd-why"'
    + ((Array.isArray(rec.candidates) ? blocked : listBlocked) ? '' : ' hidden') + '><span>'
    + escapeHtml((Array.isArray(rec.candidates) ? blocked : listBlocked) || '') + '</span></div>';

  return '<div class="mem-fnd-panel mem-fnd-add" id="fadd-panel" data-fadd-door="' + rec.door + '">'
    + '<div class="mem-fnd-panel-eyebrow cur-group-title">' + (gh ? 'ADD FROM GITHUB' : 'ADD FROM THIS COMPUTER') + '</div>'
    + '<div class="mem-fnd-init-body">'
    + (note ? '<p class="tx-desc mem-fnd-add-note">' + escapeHtml(note) + '</p>' : '')
    + source + listBtn + notes + list
    + (switching ? '<div class="tx-note"><span>' + escapeHtml('Mirroring from a repository this project does not '
      + 'mirror yet switches its source: its existing documents are re-read from there by the same paths. '
      + 'Nothing is written unless every document can be read.') + '</span></div>' : '')
    + error + refused + actions + why
    + '</div></div>';
}
