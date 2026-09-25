// shared/foundations-sources.js — ONE PROJECT, MANY SOURCES (v3.69.0)
//
// Until v3.68.0 a project had ONE source: every document was kept here, or
// every document was mirrored from one folder or one GitHub repository, and
// the view read that single `ownership` word to decide which controls a row
// got. The maintainer retired the rule: a project may now hold documents
// WRITTEN here, COPIED in from a folder, and MIRRORED from any number of
// folders and GitHub repositories (up to 8 source groups), at the same time.
// The source is recorded PER DOCUMENT (`source.kind`, and `source.group` for a
// mirror) and every decision this view makes moves from the project to the
// document.
//
// So `ownership` is DISPLAY-ONLY from here on (CONTRACT v3.69.0 §1.6), and
// every rule about "what is this row, what does it say, and what does
// deleting it do" lives in this one DOM-free module, where a plain Node suite
// drives it directly (scripts/test-foundations-sources-view.js):
//
//   sourcesOf(foundations)      the project's source groups, normalised
//   groupOf(doc, sources)       which group a mirrored document belongs to
//   rowKind(doc, sources)       'written' | 'copied' | 'folder' | 'github'
//   rowFreshWord(doc, sources)  the per-row freshness word (§3.4)
//   uncheckedWhy(doc, sources)  the toast behind an unchecked word
//   deleteConfirmCopy(row, sources)  the ONE delete sentence (§5.2), shared
//                               by the row's trash icon and the editor
//   originWord(facts)           the summary's origin clause
//   sourcesStripModel(sources)  the sources strip under the head row (§4.4)
//
// It imports only DOM-free modules, like shared/foundations-add.js.
import { formatAge } from './age.js';

/** The store's `MAX_SOURCES_PER_PROJECT` — a refusal at commit, never a disabled door. */
export const MAX_SOURCES_PER_PROJECT = 8;

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function str(v) { return typeof v === 'string' && v.trim() ? v.trim() : null; }

function normRemote(r) {
  if (!r || typeof r !== 'object') return null;
  const owner = str(r.owner);
  const repo = str(r.repo);
  if (!owner || !repo) return null;
  return { owner, repo, ref: str(r.ref), path: str(r.path) };
}

function basename(p) {
  const s = String(p || '').replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}

function docsOf(f) {
  if (!f || typeof f !== 'object') return [];
  if (Array.isArray(f.documents)) return f.documents.filter((d) => d && typeof d === 'object');
  if (Array.isArray(f.docs)) return f.docs.filter((d) => d && typeof d === 'object');
  return [];
}

function isMirror(d) { return !!(d && d.source && d.source.kind === 'repo'); }

/**
 * THE PROJECT'S SOURCE GROUPS, one normalised shape (§1.3, §3.4).
 *
 *   { id, kind: 'folder'|'github', label, reachableHere: boolean|null,
 *     remote: {owner, repo, ref, path}|null, lastRefreshAt, lastRefreshCommit,
 *     documentCount }
 *
 * From the server's `sources[]` when it sent one — `kind`, `label` and
 * `reachableHere` are the STORE's words, never re-derived here. A build that
 * predates v3.69.0 sends only v1's single `repo`, which is read as the one
 * group `s1` (the same mapping the store's model makes, §1.6): that is the
 * fallback, and every offline fixture older than this release takes it.
 *
 * NEVER READS `ownership`. A v1 curator manifest carries `repo: null` and no
 * mirrored document, so it has no group by either route.
 */
export function sourcesOf(foundations) {
  const f = foundations && typeof foundations === 'object' ? foundations : {};
  // No manifest, no sources — whatever a stale `repo` field says.
  if (f.present === false) return [];
  const docs = docsOf(f);
  const countIn = (id, only) => docs.filter((d) => isMirror(d)
    && (d.source.group === id || (only && !str(d.source.group)))).length;
  if (Array.isArray(f.sources)) {
    const list = f.sources.filter((g) => g && typeof g === 'object' && str(g.id));
    const only = list.length === 1;
    return list.map((g) => {
      const remote = normRemote(g.remote);
      const kind = g.kind === 'github' || g.kind === 'folder' ? g.kind : (remote && !str(g.root) ? 'github' : 'folder');
      return {
        id: String(g.id),
        kind,
        label: str(g.label) || (kind === 'github' && remote ? remote.owner + '/' + remote.repo : null),
        reachableHere: typeof g.reachableHere === 'boolean' ? g.reachableHere : null,
        remote,
        lastRefreshAt: str(g.lastRefreshAt),
        lastRefreshCommit: str(g.lastRefreshCommit),
        documentCount: Number.isInteger(g.documentCount) ? g.documentCount : countIn(String(g.id), only),
      };
    });
  }
  // ── THE v1 FALLBACK: `repo` IS THE ONE GROUP ──────────────────────────
  const mirrored = docs.filter(isMirror);
  const repo = f.repo && typeof f.repo === 'object' ? f.repo : null;
  const root = repo ? str(repo.root) : null;
  const remote = repo ? normRemote(repo.remote) : null;
  if (!mirrored.length && !root && !remote) return [];
  const kind = root ? 'folder' : (remote ? 'github' : 'folder');
  const reachable = mirrored.some((d) => d.freshness === 'fresh' || d.freshness === 'stale');
  return [{
    id: 's1',
    kind,
    label: root ? basename(root) : (remote ? remote.owner + '/' + remote.repo : null),
    reachableHere: kind === 'github' ? false : (mirrored.length ? reachable : null),
    remote,
    lastRefreshAt: repo ? str(repo.lastRefreshAt) : null,
    lastRefreshCommit: repo ? str(repo.lastRefreshCommit) : null,
    documentCount: mirrored.length,
  }];
}

/**
 * WHICH GROUP A DOCUMENT CAME FROM, or null. A mirror names its group
 * (`source.group`); a v1-read row that names none belongs to the ONE group
 * when there is exactly one. A written or copied document has no group.
 */
export function groupOf(doc, sources) {
  if (!isMirror(doc)) return null;
  const list = Array.isArray(sources) ? sources : [];
  const id = str(doc.source.group);
  if (id) return list.find((g) => g && g.id === id) || null;
  return list.length === 1 ? list[0] : null;
}

/** 'written' | 'copied' | 'folder' | 'github' — one per document (§1.1). */
export function rowKind(doc, sources) {
  if (isMirror(doc)) {
    const g = groupOf(doc, sources);
    return g && g.kind === 'github' ? 'github' : 'folder';
  }
  return doc && str(doc.copiedFrom) ? 'copied' : 'written';
}

/** Is this row KEPT here (written or copied) — the only kind the pencil edits? */
export function isKept(doc) { return !isMirror(doc); }

/** `owner/repo` for a group, or its label. */
function repoLabel(g) {
  if (g && g.remote) return g.remote.owner + '/' + g.remote.repo;
  return g && g.label ? g.label : null;
}

/** The kept document's state word — today's words, unchanged (v3.61.0, v3.68.0). */
function keptWord(doc) {
  if (doc && doc.skeleton === true) return 'skeleton · to fill';
  const copied = doc && str(doc.copiedFrom);
  if (copied) return 'copied from ' + copied;
  const a = doc && doc.authoredBy;
  if (a && a.kind === 'human') return 'written by you';
  if (a && a.kind) return 'written by an agent';
  return 'written';
}

export const NOT_CHECKED = 'GitHub · not checked';
export const NOT_HERE = 'source not here';

/**
 * THE PER-ROW FRESHNESS WORD (§3.4) — from the document's OWN group.
 *
 *   folder group, reachable here           fresh / stale (with the dot)
 *   folder group, not here, remote known   GitHub · not checked
 *   folder group, not here, no remote      source not here
 *   github group                           GitHub · not checked
 *   written / copied / skeleton            the kept state word, no dot
 *
 * `{word, tier, why}` — `tier` is the shared freshness scale's name (or null
 * for no dot) and `why` says the word is a door to its reason.
 */
export function rowFreshWord(doc, sources) {
  if (!isMirror(doc)) return { word: keptWord(doc), tier: null, why: false };
  const g = groupOf(doc, sources);
  const unchecked = (g && g.remote) ? NOT_CHECKED : NOT_HERE;
  if (g && g.kind === 'github') return { word: NOT_CHECKED, tier: 'unknown', why: true };
  if (doc.freshness === 'fresh') return { word: 'fresh', tier: 'recent', why: false };
  if (doc.freshness === 'stale') return { word: 'stale', tier: 'week', why: false };
  if (doc.freshness === 'unreachable' || (g && g.reachableHere === false)) {
    return { word: unchecked, tier: 'unknown', why: true };
  }
  return { word: '—', tier: null, why: false };
}

/** The Source cell's words for a row in the unified table. */
export function sourceWord(doc) {
  if (isMirror(doc)) return str(doc.source.path) || 'path not recorded';
  return str(doc && doc.copiedFrom) ? 'copied in' : 'written here';
}

/**
 * WHY A ROW READS "GitHub · not checked" / "source not here" — the toast its
 * word opens (v3.67.2's press-for-why, now per document's GROUP, §3.4).
 */
export function uncheckedWhy(doc, sources) {
  const g = groupOf(doc, sources);
  const rl = repoLabel(g);
  if (g && g.kind === 'github') {
    return {
      title: 'Mirrored from GitHub' + (rl ? ' (' + rl + ')' : ''),
      lines: [
        'Freshness is not checked on a read — only when the documents are refreshed.',
        'Refresh this source to re-copy them from GitHub.',
      ],
    };
  }
  const where = g && g.label ? 'The folder ' + g.label : 'The source folder';
  if (g && g.remote) {
    return {
      title: where + ' is not on this computer',
      lines: [
        'Freshness is compared only against the folder, on a computer that has it.',
        'Refresh this source to re-copy it from GitHub (' + rl + '), or read it from GitHub instead.',
      ],
    };
  }
  return {
    title: where + ' is not on this computer',
    lines: [
      'So these documents can neither be compared nor re-copied here.',
      'Open the project on the computer that has the folder, or delete them and add them again from GitHub.',
    ],
  };
}

/**
 * THE ONE DELETE SENTENCE (§5.2) — the row's trash icon and the editor's
 * Delete open the SAME strip with the SAME words, from here.
 *
 * `row` is the document (its manifest entry); `sources` the project's groups.
 * Returns `{kind, html, primary}` — `html` is the sentence, ESCAPED except for
 * the `<b>` spans this function writes itself.
 *
 * The one fact each sentence exists for: what goes is THIS PROJECT'S copy,
 * and — for anything that came from somewhere — the original is NOT touched,
 * named by where it is. A mirror also says the thing a person would otherwise
 * guess wrong: a refresh does NOT bring it back.
 */
export function deleteConfirmCopy(row, sources) {
  const d = row && typeof row === 'object' ? row : {};
  const slug = '<b>' + escapeHtml(d.slug || '') + '</b>';
  const kind = rowKind(d, sources);
  const g = groupOf(d, sources);
  const path = str(d.source && d.source.path);
  const pathHtml = path ? '<span class="fnd-src-path">' + escapeHtml(path) + '</span>' : null;
  const lastClause = () => {
    if (!g || g.documentCount !== 1) return '';
    const label = kind === 'github' ? repoLabel(g) : g.label;
    return label ? ' This was the last document from <b>' + escapeHtml(label)
      + '</b>, so that source is removed from the project too.' : '';
  };
  if (kind === 'written' && d.skeleton === true) {
    return { kind: 'skeleton', primary: 'Delete template',
      html: 'Delete ' + slug + '? It is an unfilled template. It is removed from this project and from '
        + 'your agents’ next session.' };
  }
  if (kind === 'written') {
    return { kind, primary: 'Delete permanently',
      html: 'Delete ' + slug + '? It was written in this project, so this is the only copy. It is removed '
        + 'from this project and from your agents’ next session, and cannot be undone from inside The '
        + 'Curator; if you sync, a git client can still recover it.' };
  }
  if (kind === 'copied') {
    return { kind, primary: 'Delete copy',
      html: 'Delete ' + slug + '? Only this project’s copy is removed. The original in the folder <b>'
        + escapeHtml(str(d.copiedFrom) || '') + '</b> is not touched. This copy was never kept in sync, '
        + 'so you can add it again at any time with Add from this computer.' };
  }
  if (kind === 'github') {
    const rl = repoLabel(g);
    return { kind, primary: 'Delete copy',
      html: 'Delete ' + slug + '? Only this project’s copy is removed. The original'
        + (pathHtml ? ', ' + pathHtml : '') + (rl ? ' on GitHub <b>' + escapeHtml(rl) + '</b>' : ' on GitHub')
        + ', is not touched. A refresh will <b>not</b> bring it back: it stops being mirrored. Add it '
        + 'again with Add from GitHub.' + lastClause() };
  }
  const label = g && g.label ? g.label : null;
  return { kind: 'folder', primary: 'Delete copy',
    html: 'Delete ' + slug + '? Only this project’s copy is removed. The original'
      + (pathHtml ? ', ' + pathHtml : '') + (label ? ' in the folder <b>' + escapeHtml(label) + '</b>' : ' in its folder')
      + ', is not touched. A refresh will <b>not</b> bring it back: it stops being mirrored. Add it '
      + 'again with Add from this computer.' + lastClause() };
}

/** Per-kind counts over the documents. */
export function kindCounts(docs, sources) {
  const out = { written: 0, copied: 0, folder: 0, github: 0 };
  for (const d of Array.isArray(docs) ? docs : []) out[rowKind(d, sources)]++;
  return out;
}

function andList(parts) {
  if (parts.length <= 1) return parts.join('');
  return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
}

/**
 * THE ORIGIN CLAUSE of the summary line — where the documents came from,
 * from the DOCUMENTS (never from `ownership`, §1.6).
 *
 *   all kept (written and/or copied)       kept here
 *   all mirrored, one source               mirrored
 *   all mirrored, several sources          mirrored from 3 sources
 *   a mix                                  written, copied and mirrored
 *                                          written and 3 from GitHub
 *
 * `null` with no documents (the empty readings say it their own way).
 */
export function originWord(facts) {
  const f = facts && typeof facts === 'object' ? facts : {};
  const docs = Array.isArray(f.docs) ? f.docs : [];
  if (!docs.length) return null;
  const sources = Array.isArray(f.sources) ? f.sources : [];
  const k = kindCounts(docs, sources);
  const mirrored = k.folder + k.github;
  const usedGroups = new Set(docs.filter(isMirror).map((d) => {
    const g = groupOf(d, sources);
    return g ? g.id : '?';
  }));
  const kept = k.written + k.copied;
  if (!mirrored) return 'kept here';
  const mirrorPart = usedGroups.size >= 2 ? 'mirrored from ' + usedGroups.size + ' sources'
    : (k.github && !k.folder ? k.github + ' from GitHub' : 'mirrored');
  if (!kept) return usedGroups.size >= 2 ? mirrorPart : 'mirrored';
  const parts = [];
  if (k.written) parts.push('written');
  if (k.copied) parts.push('copied');
  parts.push(mirrorPart);
  return andList(parts);
}

/** The words a group's line in the strip carries. */
function groupWhen(g, nowMs) {
  if (!g.lastRefreshAt) return 'never refreshed';
  const t = Date.parse(g.lastRefreshAt);
  if (!Number.isFinite(t)) return null;
  const age = formatAge(Math.max(0, Math.round((nowMs - t) / 1000)));
  return age ? 'refreshed ' + age : null;
}

/**
 * THE SOURCES STRIP, AS DATA (§4.4) — one line per group, and "Refresh all"
 * when there are two or more. Empty when the project mirrors nothing: copies
 * and written documents never refresh, so a strip for them would be a
 * control whose only outcome is `no_sources`.
 *
 * @returns {{groups: Array<{id, kind, kindWord, label, count, meta: string[],
 *   canReadFromGitHub: boolean, remote}>, refreshAll: boolean}}
 */
export function sourcesStripModel(sources, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const list = (Array.isArray(sources) ? sources : []).filter((g) => g && g.id);
  const groups = list.map((g) => {
    const count = Number.isInteger(g.documentCount) ? g.documentCount : 0;
    const meta = [count + ' document' + (count === 1 ? '' : 's')];
    const when = groupWhen(g, now);
    // v3.72.1 (truth audit F11): WHICH meta entry is the age, and its stamp,
    // so the renderer can hand it to Context's one-second age clock. It used
    // to be words computed once at render — "refreshed 2 min ago" stayed
    // "2 min ago" until something else repainted the page.
    let ageAt = null;
    let ageIndex = -1;
    if (g.kind === 'github') {
      meta.push('not checked');
      if (when && g.lastRefreshAt) { ageIndex = meta.length; ageAt = g.lastRefreshAt; meta.push(when); }
    } else if (g.reachableHere === false) {
      meta.push(g.remote ? 'not on this computer · read from GitHub on refresh' : 'not on this computer');
    } else if (when) {
      if (g.lastRefreshAt && when !== 'never refreshed') { ageIndex = meta.length; ageAt = g.lastRefreshAt; }
      meta.push(when);
    }
    return {
      id: g.id,
      kind: g.kind,
      kindWord: g.kind === 'github' ? 'GitHub' : 'Folder',
      label: (g.kind === 'github' ? repoLabel(g) : g.label) || 'source not recorded',
      count,
      meta,
      ageAt,
      ageIndex,
      canReadFromGitHub: g.kind === 'folder' && !!g.remote,
      remote: g.remote || null,
    };
  });
  return { groups, refreshAll: groups.length >= 2 };
}

/**
 * THE STRIP'S MARKUP — a list under the head row, one line per source, each
 * with its own Refresh. Plain rows, never a fold: an outcome of these controls
 * is a notice above the heading (the never-fold rule, v3.16.1).
 *
 * @param {ReturnType<typeof sourcesStripModel>} model
 * @param {{busy?: boolean, busyGroup?: string|null}} [opts]
 */
/**
 * A group's meta line. The "refreshed N ago" entry is wrapped for Context's
 * age clock (views/memory.js `tickAges`): the stamp on `data-mem-age-at`, the
 * words in `.mem-age-words`, and the fixed word "refreshed" outside it, so
 * the clock rewrites only the age (v3.72.1, truth audit F11). Every other
 * entry is escaped text, as before.
 */
function metaHtml(g) {
  const meta = Array.isArray(g.meta) ? g.meta : [];
  return meta.map((m, i) => {
    const text = String(m);
    if (i !== g.ageIndex || !g.ageAt || text.indexOf('refreshed ') !== 0) return escapeHtml(text);
    return '<span data-mem-age-at="' + escapeHtml(String(g.ageAt)) + '">refreshed '
      + '<span class="mem-age-words">' + escapeHtml(text.slice('refreshed '.length)) + '</span></span>';
  }).join(' · ');
}

export function renderSourcesStrip(model, opts) {
  const m = model && Array.isArray(model.groups) ? model : { groups: [], refreshAll: false };
  if (!m.groups.length) return '';
  const o = opts && typeof opts === 'object' ? opts : {};
  const busy = o.busy === true;
  const dis = busy ? ' disabled aria-disabled="true"' : '';
  const line = (g) => {
    const mine = busy && o.busyGroup === g.id;
    return '<li class="mem-fnd-source" data-fnd-source="' + escapeHtml(g.id) + '">'
      + '<span class="mem-fnd-source-kind">' + escapeHtml(g.kindWord) + '</span>'
      + '<span class="mem-fnd-source-label">' + escapeHtml(g.label) + '</span>'
      + '<span class="mem-fnd-source-meta">' + metaHtml(g) + '</span>'
      + '<span class="mem-fnd-source-actions">'
      + '<button type="button" class="btn btn-secondary btn-xs" data-fnd-refresh="' + escapeHtml(g.id) + '"'
      + ' aria-label="' + escapeHtml('Refresh ' + g.kindWord + ' ' + g.label) + '"' + dis + '>'
      + (mine ? 'Refreshing…' : 'Refresh') + '</button>'
      + (g.canReadFromGitHub
        ? '<button type="button" class="btn btn-ghost btn-xs" data-fnd-read-gh="' + escapeHtml(g.id) + '"' + dis + '>'
          + 'Read from GitHub instead</button>'
        : '')
      + '</span></li>';
  };
  return '<div class="mem-fnd-sources-wrap">'
    + '<ul class="mem-fnd-sources" id="mem-fnd-sources" aria-label="Sources this project mirrors">'
    + m.groups.map(line).join('') + '</ul>'
    + (m.refreshAll
      ? '<button type="button" class="btn btn-secondary btn-xs mem-fnd-refresh-all" id="mem-fnd-refresh-all"' + dis + '>'
        + (busy && !o.busyGroup ? 'Refreshing…' : 'Refresh all') + '</button>'
      : '')
    + '</div>';
}

/**
 * WHAT A FINISHED REFRESH SAYS, per group (§3.1's `groups[]`). A group whose
 * read failed was left exactly as it was — that is the store's promise, and
 * the line says so rather than folding it into a total.
 * @returns {{said: string[], failed: string[]}}
 */
export function refreshOutcome(data, sources) {
  const d = data && typeof data === 'object' ? data : {};
  const arr = (v) => (Array.isArray(v) ? v : []);
  const said = [];
  if (arr(d.refreshed).length) said.push(arr(d.refreshed).length + ' re-copied');
  if (arr(d.added).length) said.push(arr(d.added).length + ' added');
  if (arr(d.unchanged).length) said.push(arr(d.unchanged).length + ' already current');
  if (arr(d.missing).length) said.push(arr(d.missing).length + ' no longer at the source (the copy is kept)');
  const failed = arr(d.groups).filter((g) => g && g.ok === false).map((g) => {
    const known = (Array.isArray(sources) ? sources : []).find((s) => s && s.id === g.id);
    const label = str(g.label) || (known ? (known.kind === 'github' ? repoLabel(known) : known.label) : null) || g.id;
    return label + ' was not refreshed and is unchanged'
      + (str(g.message) ? ': ' + str(g.message) : (str(g.reason) ? ' (' + str(g.reason) + ')' : '.'));
  });
  return { said, failed };
}

// THE ONE TRASH GLYPH (v3.72.0, C9 / M3). Before this release, this file
// drew its own trash outline, different from app.js's `icon('trash')` body
// (`ICON_BODY.trash`, app.js:481) — two shapes for one meaning. This module
// is deliberately DOM-free and imports nothing from app.js (importing app.js
// from here fails under plain Node: it reaches `document` at module load,
// which is exactly why scripts/test-foundations-sources-view.js can drive
// this file directly with no DOM shim), so the path data below is a literal,
// byte-identical COPY of `ICON_BODY.trash`'s `d` attribute rather than a
// shared import. scripts/test-row-actions.js pins the two strings equal, so
// they cannot drift back apart unnoticed.
const TRASH_PATH_D = 'M4.5 6.5h15M9.5 6.5V4.8a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.7M6.5 6.5l.7 12.4a1.5 1.5 0 0 0 1.5 1.4h6.6a1.5 1.5 0 0 0 1.5-1.4l.7-12.4';

/** The trash icon's markup (§5.1). Visible at rest; `aria-label`, no `title=`.
 *  Emits `.row-act` (shared/row-action.css) — the ONE row-action rule
 *  app-wide (v3.72.0, M3): neutral at rest and on hover, colour only at the
 *  confirm this row's click opens. */
export function deleteIconHtml(doc) {
  const d = doc && typeof doc === 'object' ? doc : {};
  const slug = String(d.slug || '');
  return '<button type="button" class="btn btn-ghost btn-xs fnd-delete row-act"'
    + ' data-fnd-delete="' + escapeHtml(slug) + '"'
    + ' aria-label="' + escapeHtml('Delete ' + (d.title || slug)) + '">'
    + '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="' + TRASH_PATH_D + '"/></svg>'
    + '</button>';
}
