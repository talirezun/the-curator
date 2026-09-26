// Context › project › step 5 "Setup" (v3.77.0) — the words and the markup.
//
// DOM-FREE AT IMPORT, the ws-delete.js / chat-list.js rule: an offline suite
// imports the REAL builders in plain Node (scripts/test-next-setup-step.js)
// instead of lifting them out of memory.js by brace-matching. memory.js owns
// the state, the request (GET /api/setup/projects/:domain/:project) and the
// listeners; this module owns what the step SAYS.
//
// ── WHAT IT IS FOR ─────────────────────────────────────────────────────────
// A project worked on by several agent tools, on several computers, works
// only while a list of preconditions holds (the user guide's §13d checklist).
// This step shows which of them is false RIGHT NOW, for this project, on this
// computer, and the one safe action for each: copy, reveal, or Sync now.
//
// ── THE SIX DESIGN RULES, HERE ─────────────────────────────────────────────
//  1 one overview card — the SETUP tile is a sixth card of the project's
//    overview (memory.js renderLayerStrip), jumping here.
//  2 one heading rule — `memStep({num: 5, title: 'Setup'})` in memory.js.
//  3 the step-body rule — fold rows; the explanation is the ⓘ
//    (`context.setup`). Every "to fix" line is a LOUD monitor entry, never
//    behind a chevron (v3.16.1).
//  4 the monitor — the to-fix readings are one `renderMonitor`.
//  5 continuity by identity — a TOOL and a COMPUTER carry no colour: colour is
//    the domain's, and no second palette is invented here.
//  6 the depth bar — none: nothing here is a share.
//
// ── EVIDENCE FIRST ─────────────────────────────────────────────────────────
// "Saved" is the project's own record, from every computer; every other
// column reads files on THIS computer. When a config entry is not found but a
// save from this computer proves the tool works, the cell says "working".

import { renderMonitor } from '../shared/monitor.js';
import { ageWordsFor } from '../shared/age-ticker.js';

/** A ticking age, with its words already written (age-ticker keeps them current). */
export function ageSpan(iso, prefix, cls = '') {
  const words = ageWordsFor(iso, Date.now(), prefix || null) || (prefix || '');
  return '<span' + (cls ? ' class="' + cls + '"' : '') + ' data-age-at="' + escapeHtml(iso) + '"'
    + (prefix ? ' data-age-prefix="' + escapeHtml(prefix) + '"' : '') + ' data-age-text>' + escapeHtml(words) + '</span>';
}

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export const SETUP_JUMP = 'context-setup';

/** State word → the class that inks it (memory.css owns the classes). */
export function stateClass(st) {
  return {
    ok: 'cur-setup-st-ok',
    fix: 'cur-setup-st-fix',
    'cant-check': 'cur-setup-st-q',
    'not-checked': 'cur-setup-st-q',
    unmeasured: 'cur-setup-st-q',
    none: 'cur-setup-st-none',
  }[st] || 'cur-setup-st-none';
}

/** One cell: the state word, and one quiet qualifying line. */
export function cellHtml(cell, ageAt) {
  if (!cell) return '<span class="cur-setup-st cur-setup-st-none">—</span>';
  const word = typeof cell.word === 'string' && cell.word ? cell.word : '—';
  const main = ageAt
    ? '<span class="cur-setup-st ' + stateClass(cell.state) + '" data-age-at="' + escapeHtml(ageAt) + '" data-age-text>'
      + escapeHtml(word) + '</span>'
    : '<span class="cur-setup-st ' + stateClass(cell.state) + '">' + escapeHtml(word) + '</span>';
  const sub = typeof cell.note === 'string' && cell.note ? '<span class="cur-setup-sub">' + escapeHtml(cell.note) + '</span>' : '';
  return main + sub;
}

/** The overview tile's three facts, from the route payload (or null). */
export function setupTile(data) {
  if (!data || !data.ok) return { value: 'not checked', sub: null, warn: false };
  const n = Array.isArray(data.toFix) ? data.toFix.length : 0;
  const tools = (data.tools || []).map((t) => t.label);
  const comps = (data.computers || []).length;
  const sub = [
    tools.length ? tools.join(' · ') : 'no agent tool yet',
    comps ? comps + (comps === 1 ? ' computer' : ' computers') : null,
  ].filter(Boolean).join(' · ');
  if (n) return { value: n + ' to fix', sub, warn: true };
  if (!data.repo) return { value: 'not checked', sub: 'no repository on this computer', warn: false };
  return { value: 'nothing to fix here', sub, warn: false };
}

/** The label a fix button carries. Pure. */
export function fixButtons(f, repo) {
  const fix = f && f.fix ? f.fix : {};
  const b = (act, label, extra = '') => '<button type="button" class="btn btn-secondary btn-xs" data-setup-act="' + act + '"' + extra + '>' + escapeHtml(label) + '</button>';
  const out = [];
  if (fix.kind === 'copy-block') out.push(b('copy-block', 'Copy block' + (f.file ? ' for ' + f.file : '')));
  if (fix.kind === 'copy-marker') out.push(b('copy-marker', 'Copy marker line'));
  if (fix.kind === 'copy-command' && fix.command) out.push(b('copy-command', 'Copy command', ' data-cmd="' + escapeHtml(fix.command) + '"'));
  if (fix.kind === 'sync') out.push(b('sync', 'Sync now'));
  if (fix.kind === 'settings' || fix.kind === 'skills') out.push(b('settings', 'Open Tools on this Mac'));
  const revealName = fix.reveal || (fix.kind === 'reveal' ? f.file : null);
  if (revealName && repo && repo.path) {
    out.push(b('reveal', 'Reveal ' + revealName, ' data-path="' + escapeHtml(repo.path.replace(/\/+$/, '') + '/' + revealName) + '"'));
  }
  return out.join('');
}

function fold(key, title, meta, body, openFolds) {
  const open = openFolds && openFolds[key] ? ' open' : '';
  return '<details class="mem-fold" data-mem-fold="' + escapeHtml(key) + '"' + open + '>'
    + '<summary class="mem-fold-summary" id="mem-fold-' + escapeHtml(key) + '">'
    + '<svg class="icon" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    + '<span>' + escapeHtml(title) + '</span>'
    + '<span class="mem-fold-meta">' + escapeHtml(meta) + '</span>'
    + '</summary>'
    + '<div class="mem-fold-body">' + body + '</div>'
    + '</details>';
}

function toolsTable(data) {
  const rows = (data.tools || []).map((t) => {
    const saved = t.saved && t.saved.at
      ? { state: t.saved.state, word: t.saved.at ? 'saved' : '—',
        note: [t.saved.thisMachine ? 'this computer' : (t.saved.machine || null),
          t.saved.scope ? 'as ' + t.saved.scope + (t.saved.wrongScope ? ' — not its own' : '') : null].filter(Boolean).join(' · ') }
      : { state: 'none', word: 'no save yet' };
    const savedHtml = t.saved && t.saved.at
      ? ageSpan(t.saved.at, 'saved', 'cur-setup-st ' + stateClass(saved.state))
        + '<span class="cur-setup-sub">' + escapeHtml(saved.note) + '</span>'
      : cellHtml(saved);
    const hooks = t.hooks ? { ...t.hooks, note: t.hooks.note || (t.hooks.evidence && t.hooks.evidence.stop
      ? 'stop hook last fired, ' + (t.hooks.evidence.stop.decision === 'ask' ? 'asked' : 'did not ask')
      : (t.hooks.evidence && t.hooks.evidence.start ? 'start hook seen firing' : null)) } : null;
    return '<tr>'
      + '<th scope="row" class="cur-setup-tool">' + escapeHtml(t.label) + '</th>'
      + '<td>' + savedHtml + '</td>'
      + '<td>' + cellHtml(t.bridge) + '</td>'
      + '<td>' + cellHtml(t.skills) + '</td>'
      + '<td>' + cellHtml(t.block) + '</td>'
      + '<td>' + cellHtml(hooks) + '</td>'
      + '</tr>';
  }).join('');
  if (!rows) return '<p class="mem-setup-empty">No agent tool has saved to this project or is set up on this computer. Add one with <strong>+ Add a tool</strong>.</p>';
  return '<div class="cur-setup-scroll"><table class="cur-setup-table">'
    + '<thead><tr><th scope="col">Tool</th><th scope="col">Saved</th><th scope="col">Bridge · this computer</th>'
    + '<th scope="col">Skills · this computer</th><th scope="col">Block · repository</th><th scope="col">Hooks</th></tr></thead>'
    + '<tbody>' + rows + '</tbody></table></div>';
}

function repoRows(data) {
  const r = data.repo;
  if (!r) return '';
  const m = r.marker || null;
  const kv = (k, v, act = '') => '<div class="mem-setup-kv"><span class="mem-setup-k">' + escapeHtml(k) + '</span>'
    + '<span class="mem-setup-v">' + v + '</span><span class="mem-setup-a">' + act + '</span></div>';
  const st = (state, word) => '<span class="cur-setup-st ' + stateClass(state) + '">' + escapeHtml(word) + '</span>';
  let markerV;
  if (!r.exists) markerV = st('fix', 'the folder is not on this computer');
  else if (!m || !m.present) markerV = st('fix', 'not in this folder');
  else if (!m.namesThis) markerV = st('fix', 'names ' + (m.line || '?'));
  else {
    const g = m.git || {};
    markerV = st('ok', 'names this project')
      + (g.repo === false ? ' ' + st('none', 'not a git repository')
        : g.tracked === false || g.uncommitted === true ? ' ' + st('fix', 'not committed')
          : g.unpushed === true ? ' ' + st('fix', 'not pushed') : g.upstream ? ' ' + st('ok', 'committed and pushed') : ' ' + st('ok', 'committed'));
  }
  const files = new Map();
  for (const t of data.tools || []) {
    for (const f of (t.block && t.block.files) || []) {
      const cur = files.get(f.name) || { ...f, tools: [] };
      cur.tools.push(t.label);
      files.set(f.name, cur);
    }
  }
  const fileRows = [...files.values()].map((f) => {
    const v = !f.present ? st('none', 'no such file')
      : !f.hasBlock ? st('fix', 'no Curator block')
        : f.wrongProject ? st('fix', 'names ' + f.namesProject)
          : !f.current ? st('fix', 'block outdated')
            : st('ok', f.atTop ? 'block current · at the top' : 'block current');
    return kv(f.name, v + '<span class="cur-setup-sub">read by ' + escapeHtml(f.tools.join(', ')) + '</span>',
      '<button type="button" class="btn btn-ghost btn-xs" data-setup-act="reveal" data-path="' + escapeHtml(r.path.replace(/\/+$/, '') + '/' + f.name) + '">Reveal</button>');
  }).join('');
  return kv('Folder', '<span class="cur-setup-path">' + escapeHtml(r.display || r.path) + '</span><span class="cur-setup-sub">set by you, on this computer</span>',
    '<button type="button" class="btn btn-ghost btn-xs" data-setup-act="change-repo">Change</button>')
    + kv('.curator-project', markerV, '<button type="button" class="btn btn-ghost btn-xs" data-setup-act="copy-marker">Copy marker line</button>')
    + fileRows;
}

/** The "where is it checked out" form — shown UNFOLDED while no folder is set. */
export function repoForm(data, draft, err) {
  const sugg = (data.repoSuggestions || []).map((s) => '<div class="mem-setup-suggest' + (s.reachable ? '' : ' mem-setup-suggest-away') + '">'
    + '<span class="cur-setup-path">' + escapeHtml(s.rootDisplay || s.root) + '</span>'
    + '<span class="cur-setup-sub">' + escapeHtml(s.reachable ? (s.inGit ? 'a document source of this project · a git checkout here' : 'a document source of this project') : 'recorded on another computer · not on this one') + '</span>'
    + (s.reachable ? '<button type="button" class="btn btn-secondary btn-xs" data-setup-act="use-repo" data-path="' + escapeHtml(s.root) + '">Use</button>' : '')
    + '</div>').join('');
  return '<div class="mem-setup-repo-form">'
    + '<label class="mem-setup-q" for="mem-setup-repo-input">Where is <strong>' + escapeHtml(data.project) + '</strong> checked out on this computer?</label>'
    + '<div class="mem-setup-path-row">'
    + '<input type="text" id="mem-setup-repo-input" class="mem-setup-input" spellcheck="false" autocomplete="off" placeholder="/Users/you/code/' + escapeHtml(data.project) + '" value="' + escapeHtml(draft || '') + '">'
    + '<button type="button" class="btn btn-primary btn-xs" data-setup-act="save-repo">Use this folder</button>'
    + '</div>'
    + (err ? '<p class="mem-setup-err" role="alert">' + escapeHtml(err) + '</p>' : '')
    + '<p class="cur-setup-hint">Kept on this computer only, never synced. A folder inside Documents or Desktop makes macOS ask once whether The Curator may read it.</p>'
    + (sugg ? '<div class="mem-setup-suggestions"><span class="mem-setup-k">Suggested</span>' + sugg + '</div>' : '')
    + '</div>';
}

function computersTable(data) {
  const comps = data.computers || [];
  if (!comps.length) return '<p class="mem-setup-empty">No computer has saved to this project.</p>';
  const sync = data.sync || {};
  const rows = comps.map((c) => {
    const version = c.curator ? '<span class="cur-setup-mono">' + escapeHtml(c.curator) + '</span>'
      : '<span class="cur-setup-st cur-setup-st-q">not recorded</span>';
    let syncCell;
    if (c.thisMachine) {
      syncCell = !sync.configured ? '<span class="cur-setup-st cur-setup-st-none">Personal Sync not set up</span>'
        : (sync.lastSync ? ageSpan(sync.lastSync, 'synced') : 'never synced')
          + (Number.isInteger(sync.pending) && sync.pending > 0 ? '<span class="cur-setup-sub">' + sync.pending + ' change' + (sync.pending === 1 ? '' : 's') + ' not on GitHub</span>' : '');
    } else if (c.waiting) {
      syncCell = '<span class="cur-setup-st cur-setup-st-fix">a newer handoff is waiting on GitHub</span>';
    } else {
      syncCell = '<span class="cur-setup-sub">its own sync time is not recorded</span>';
    }
    return '<tr>'
      + '<th scope="row"><span class="cur-setup-mono">' + escapeHtml(c.machine) + '</span>'
      + (c.thisMachine ? ' <span class="mem-badge mem-badge-quiet">this computer</span>' : '') + '</th>'
      + '<td>' + escapeHtml((c.tools || []).join(', ') || '—') + '</td>'
      + '<td>' + (c.newestAt ? ageSpan(c.newestAt, null) : '—') + '</td>'
      + '<td>' + version + '</td>'
      + '<td>' + syncCell + '</td>'
      + '</tr>';
  }).join('');
  const split = data.machine && data.machine.split
    ? '<p class="cur-setup-hint">This computer has two installs of The Curator, so it saves under two machine names (' + escapeHtml((data.machine.ids || []).join(', ')) + ').</p>' : '';
  const remote = sync.configured
    ? (Array.isArray(sync.incoming)
      ? '<p class="cur-setup-hint">Waiting on GitHub: as of the app’s last check.</p>'
      : '<p class="cur-setup-hint">GitHub was not checked recently. <button type="button" class="btn btn-ghost btn-xs" data-setup-act="check-github">Check GitHub</button></p>')
    : '';
  return '<div class="cur-setup-scroll"><table class="cur-setup-table">'
    + '<thead><tr><th scope="col">Computer</th><th scope="col">Tools that saved</th><th scope="col">Newest save here</th>'
    + '<th scope="col">Curator at that save</th><th scope="col">Sync</th></tr></thead>'
    + '<tbody>' + rows + '</tbody></table></div>' + split + remote
    + (sync.configured ? '<div class="mem-setup-actions"><button type="button" class="btn btn-primary btn-xs" data-setup-act="sync">Sync now</button></div>' : '');
}

/**
 * The step's body. `s` is `{data, error, loading}`; `ui` carries the fold
 * state and the repo form's draft.
 */
export function renderSetupBody(s, ui = {}) {
  const data = s && s.data;
  if (!data) {
    if (s && s.error) return '<div class="mem-setup-stack"><p class="mem-setup-err" role="alert">Could not check this computer: ' + escapeHtml(s.error) + '</p></div>';
    return '<div class="mem-setup-stack"><p class="cur-setup-hint" aria-busy="true">Checking this computer…</p></div>';
  }
  const toFix = Array.isArray(data.toFix) ? data.toFix : [];
  const tools = data.tools || [];
  const mon = renderMonitor({
    id: 'mem-setup-monitor',
    label: 'Setup on this computer',
    head: { stateWord: toFix.length ? toFix.length + ' to fix on this computer' : 'Nothing to fix on this computer', tone: toFix.length ? 'warn' : 'ok' },
    lines: [
      { key: 'Tools', value: tools.length ? tools.map((t) => t.label).join(' · ') : 'none yet' },
      { key: 'Repository', value: data.repo ? (data.repo.display || data.repo.path) : 'not set on this computer' },
      { key: 'Computers', value: String((data.computers || []).length) },
    ],
    loud: toFix.map((f) => ({ tone: 'warn', text: f.text + (f.detail ? ' ' + f.detail : '') })),
  });
  const fixes = toFix.length
    ? '<div class="mem-setup-fixes">' + toFix.map((f, i) => '<div class="mem-setup-fix" data-setup-fix="' + i + '">'
      + '<span class="mem-setup-fix-what">' + escapeHtml(f.text) + '</span>'
      + '<span class="mem-setup-fix-acts">' + fixButtons(f, data.repo) + '</span></div>').join('') + '</div>'
    : '';
  const form = !data.repo ? repoForm(data, ui.repoDraft, ui.repoError) : (ui.editRepo ? repoForm(data, ui.repoDraft ?? data.repo.path, ui.repoError) : '');
  const toolsFixN = toFix.filter((f) => f.tool).length;
  const toolsMeta = [
    tools.length + (tools.length === 1 ? ' tool' : ' tools'),
    (() => { const n = tools.filter((t) => t.saved && t.saved.at).length; return n ? n + ' saved' : 'none saved'; })(),
    toolsFixN ? toolsFixN + ' to fix' : null,
  ].filter(Boolean).join(' · ');
  const repoMeta = data.repo ? (data.repo.display || data.repo.path) : 'not set on this computer';
  const comps = data.computers || [];
  const waiting = comps.filter((c) => !c.thisMachine && c.waiting).length;
  const compMeta = [comps.length + (comps.length === 1 ? ' computer' : ' computers'),
    waiting ? waiting + ' with a handoff waiting on GitHub' : null].filter(Boolean).join(' · ');
  return '<div class="mem-setup-stack">'
    + mon + fixes + form
    + fold('setup-tools', 'Tools', toolsMeta, toolsTable(data)
      + '<p class="cur-setup-hint">“Saved” is this project’s own record, from every computer. The other columns read files on this computer.</p>', ui.openFolds)
    + (data.repo ? fold('setup-repo', 'Repository on this computer', repoMeta, repoRows(data), ui.openFolds) : '')
    + fold('setup-computers', 'Computers', compMeta, computersTable(data), ui.openFolds)
    + '</div>';
}

/** The head row's controls: when it was checked, Check again, + Add a tool. */
export function setupHeadHtml(s, addOpen) {
  const data = s && s.data;
  const at = data && data.checkedAt;
  const addable = (data && data.addable) || [];
  const menu = addOpen && addable.length
    ? '<div class="mem-setup-addmenu" role="menu">' + addable.map((a) => '<button type="button" role="menuitem" class="mem-setup-additem" data-setup-act="add-tool" data-tool="' + escapeHtml(a.id) + '">' + escapeHtml(a.label) + '</button>').join('') + '</div>'
    : '';
  return (at ? ageSpan(at, 'checked', 'mem-setup-checked') : '')
    + '<button type="button" class="btn btn-ghost btn-xs" data-setup-act="check"' + (s && s.loading ? ' disabled' : '') + '>Check again</button>'
    + '<span class="mem-setup-add"><button type="button" class="btn btn-secondary btn-xs" data-setup-act="add-open" aria-haspopup="menu" aria-expanded="' + (addOpen ? 'true' : 'false') + '"' + (addable.length ? '' : ' disabled') + '>+ Add a tool</button>' + menu + '</span>';
}
