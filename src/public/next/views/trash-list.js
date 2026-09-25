// ═══════════════════════════════════════════════════════════════════════════
//  views/trash-list.js — SETTINGS › TRASH, the words and the one predicate
//  (v3.76.0)
// ═══════════════════════════════════════════════════════════════════════════
//
// Since v3.73.0 (domains, projects) and v3.75.0 (handoffs) a delete MOVES the
// folder into The Curator's trash, and the only way back was by hand. This is
// the list of what is there, with Restore and Delete forever on each entry.
//
// DOM-FREE AT IMPORT, for the reason views/ws-delete.js gives: the offline
// suite (scripts/test-trash-restore.js) imports the REAL builders in plain
// Node. views/settings.js owns the state, the three requests and the
// listeners; this module owns the words.
//
// ── WHAT EACH ROW SAYS, AND WHERE IT COMES FROM ──────────────────────────
// Every fact is the SERVER's (GET /api/trash, src/brain/trash-items.js): what
// the entry is, where it goes back to, when it was deleted (from the folder's
// own UTC stamp), what it held and its size. A row that cannot be restored as
// it stands says WHY in words, unfolded (v3.16.1: a warning is never behind a
// chevron) — the name is taken now, the domain or project it belonged to is
// gone, or its origin cannot be read.
//
// ── THE TWO ACTIONS ──────────────────────────────────────────────────────
// · RESTORE is one press: it never overwrites (the server refuses a taken
//   name), so it needs no confirmation. When the name IS taken, the button
//   becomes "Restore as <name>-restored" — the other name is stated on the
//   button itself, never applied silently.
// · DELETE FOREVER is the ONE PERMANENT ERASE in the app. The row carries the
//   one neutral trash glyph (the row-action rule, shared/row-action.css); it
//   opens a card that says it cannot be undone and asks for the entry's name
//   typed exactly. Red appears only on that card's button.

import { formatAge } from '../shared/age.js';

// A byte-for-byte copy of app.js's escapeHtml, for the reason
// views/chat-list.js carries one: this module must import in plain Node.
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function plural(n, one, many) {
  return n + ' ' + (n === 1 ? one : many);
}

/** What the rows call each kind. The store's `scopes` is a HANDOFF on screen. */
export const TRASH_NOUN = Object.freeze({ domains: 'domain', projects: 'project', scopes: 'handoff' });

/** 1234567 → "1.2 MB". Exact below 1 KB. */
export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return null;
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10) + ' ' + units[i];
}

/** "2026-09-25 16:04 UTC" from an ISO instant. */
function utcStamp(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

/** What an entry held, in words. Only facts the server counted. */
export function trashContainsText(e) {
  const c = e && e.contains && typeof e.contains === 'object' ? e.contains : {};
  const parts = [];
  if (e.kind === 'domains') {
    if (Number.isInteger(c.pages)) parts.push(plural(c.pages, 'page', 'pages'));
    if (c.conversations) parts.push(plural(c.conversations, 'conversation', 'conversations'));
    if (c.rawSources) parts.push(plural(c.rawSources, 'raw source', 'raw sources'));
    if (c.projects) parts.push(plural(c.projects, 'project', 'projects'));
    if (c.handoffs) parts.push(plural(c.handoffs, 'saved handoff', 'saved handoffs'));
  } else if (e.kind === 'projects') {
    if (c.hasBrief) parts.push('standing brief');
    if (Number.isInteger(c.scopes)) parts.push(plural(c.scopes, 'handoff', 'handoffs'));
  } else if (e.kind === 'scopes') {
    if (Number.isInteger(c.machines)) parts.push(plural(c.machines, 'saved copy', 'saved copies'));
  }
  const size = formatBytes(e.bytes);
  if (size) parts.push(size + (Number.isInteger(e.files) ? ' in ' + plural(e.files, 'file', 'files') : '') + (e.approximate ? ' or more' : ''));
  return parts.join(' · ');
}

/** The entry's title words: the name, and for a handoff or project its owner. */
function titleHtml(e) {
  const name = e.name || e.id;
  let owner = '';
  if (e.kind === 'projects' && e.domain) owner = ' <span class="trash-owner">in ' + escapeHtml(e.domain) + '</span>';
  if (e.kind === 'scopes' && e.domain) {
    owner = ' <span class="trash-owner">in ' + escapeHtml(e.isDefaultProject || e.project === e.domain
      ? e.domain : e.domain + ' / ' + e.project) + '</span>';
  }
  const display = e.kind === 'domains' && e.displayName && e.displayName !== name
    ? ' <span class="trash-owner">' + escapeHtml(e.displayName) + '</span>' : '';
  return '<span class="trash-name">' + escapeHtml(name) + '</span>' + display + owner;
}

/** The word the Delete-forever card asks for: the name, or the id when unknown. */
export function trashConfirmWord(e) {
  return e && typeof e.name === 'string' && e.name ? e.name : (e && e.id) || '';
}

/** The ONE predicate: exact, no trim, no case folding. */
export function trashDeleteConfirmMatches(action, entry) {
  const word = trashConfirmWord(entry);
  return !!action && action.mode === 'delete' && word !== ''
    && typeof action.confirmText === 'string' && action.confirmText === word;
}

/** The DELETE request body. The typed text is SENT, not merely checked here. */
export function trashDeleteBody(action) {
  return JSON.stringify({ confirm: action && typeof action.confirmText === 'string' ? action.confirmText : '' });
}

/**
 * What the Restore press does for this entry, or null when it cannot:
 *   { as: undefined, label: 'Restore' }            — back under its own name
 *   { as: '<name>-restored', label: 'Restore as …' } — the name is taken now
 */
export function trashRestorePlan(e) {
  if (!e) return null;
  if (e.status === 'ready') return { as: undefined, label: 'Restore' };
  if (e.status === 'exists' && typeof e.suggestedName === 'string' && e.suggestedName) {
    return { as: e.suggestedName, label: 'Restore as ' + e.suggestedName };
  }
  return null;
}

/** The POST body for a restore plan. */
export function trashRestoreBody(plan) {
  return JSON.stringify(plan && plan.as ? { as: plan.as } : {});
}

function deleteCardHtml(e, action) {
  const word = trashConfirmWord(e);
  const busy = !!action.busy;
  const can = !busy && trashDeleteConfirmMatches(action, e);
  const size = formatBytes(e.bytes);
  return (
    '<div class="trash-del-card" role="group" aria-labelledby="trash-del-title">' +
      '<div class="trash-del-title" id="trash-del-title">Delete <span class="trash-name">' + escapeHtml(word) +
        '</span> forever?</div>' +
      '<div class="trash-del-body">This erases it from The Curator’s trash' +
        (size ? ' — ' + escapeHtml(plural(e.files || 0, 'file', 'files')) + ', ' + escapeHtml(size) : '') +
        '. It cannot be undone: it does not go to the Mac’s Trash, and Sync never had a copy of it.</div>' +
      '<label class="trash-del-label" for="trash-del-input">Type <span class="trash-name">' + escapeHtml(word) +
        '</span> to confirm</label>' +
      '<input class="trash-del-input" id="trash-del-input" type="text" autocomplete="off" spellcheck="false" value="' +
        escapeHtml(action.confirmText || '') + '"' + (busy ? ' disabled' : '') + ' />' +
      (action.error ? '<div class="trash-error" role="alert"><strong>Not deleted.</strong> ' + escapeHtml(action.error) + '</div>' : '') +
      '<div class="trash-del-actions">' +
        '<button type="button" class="btn btn-danger-solid btn-xs" id="trash-del-go"' + (can ? '' : ' disabled') + '>' +
          (busy ? 'Deleting…' : 'Delete forever') + '</button>' +
        '<button type="button" class="btn btn-ghost btn-xs" id="trash-del-no"' + (busy ? ' disabled' : '') + '>Keep it</button>' +
      '</div>' +
    '</div>'
  );
}

/**
 * ONE ROW. `opts`:
 *   nowMs, trashIconHtml (trusted — app.js's icon('trash')),
 *   action (settings' state.trashAction), writeBusy(domain) → string|null
 */
export function trashRowHtml(e, opts = {}) {
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const action = opts.action && opts.action.kind === e.kind && opts.action.id === e.id ? opts.action : null;
  const t = Date.parse(e.deletedAt);
  const age = Number.isFinite(t) ? formatAge(Math.max(0, Math.round((nowMs - t) / 1000))) : null;
  const stamp = utcStamp(e.deletedAt);
  const when = age ? 'deleted ' + age + (stamp ? ' (' + stamp + ')' : '') : (stamp ? 'deleted ' + stamp : 'deletion time unknown');
  const where = e.restoreTo ? 'from ' + e.restoreTo : null;
  const contains = trashContainsText(e);

  const plan = trashRestorePlan(e);
  const busyDomain = typeof opts.writeBusy === 'function' && e.domain ? opts.writeBusy(e.domain) : null;
  const restoring = !!(action && action.mode === 'restore' && action.busy);
  const anyBusy = !!(opts.action && opts.action.busy);
  const restoreDisabled = !plan || anyBusy || !!busyDomain;

  const status = e.status !== 'ready' && e.message
    ? '<div class="trash-status" role="note">' + escapeHtml(e.message) + '</div>' : '';
  const busyNote = plan && busyDomain
    ? '<div class="trash-status" role="note">' + escapeHtml(busyDomain) + ' is running on ' + escapeHtml(e.domain) +
      '. Restore when it finishes.</div>' : '';
  const restoreErr = action && action.mode === 'restore' && action.error
    ? '<div class="trash-error" role="alert"><strong>Not restored.</strong> ' + escapeHtml(action.error) + '</div>' : '';

  return (
    '<li class="trash-row" data-trash-kind="' + escapeHtml(e.kind) + '" data-trash-id="' + escapeHtml(e.id) + '">' +
      '<div class="trash-row-line">' +
        '<div class="trash-row-main">' +
          '<div class="trash-row-title"><span class="trash-kind">' + escapeHtml(TRASH_NOUN[e.kind] || e.kind) + '</span> ' +
            titleHtml(e) + '</div>' +
          '<div class="trash-row-meta">' + escapeHtml([when, where].filter(Boolean).join(' · ')) + '</div>' +
          (contains ? '<div class="trash-row-meta">' + escapeHtml(contains) + '</div>' : '') +
        '</div>' +
        '<div class="trash-row-acts">' +
          (plan || e.status === 'exists'
            ? '<button type="button" class="btn btn-ghost btn-xs trash-restore" data-trash-restore' +
              (restoreDisabled ? ' disabled' : '') + '>' + escapeHtml(restoring ? 'Restoring…' : (plan ? plan.label : 'Restore')) + '</button>'
            : '') +
          '<button type="button" class="row-act trash-forever" data-trash-delete aria-label="' +
            escapeHtml('Delete ' + trashConfirmWord(e) + ' forever') + '"' + (anyBusy ? ' disabled' : '') + '>' +
            (opts.trashIconHtml || '') + '</button>' +
        '</div>' +
      '</div>' +
      status + busyNote + restoreErr +
      (action && action.mode === 'delete' ? deleteCardHtml(e, action) : '') +
    '</li>'
  );
}

/**
 * THE SECTION BODY. `ts`:
 *   { data: GET /api/trash payload | null, error, action, outcome }
 * `opts` as trashRowHtml, plus `loadingHtml` for the not-yet-loaded state.
 */
export function trashSectionHtml(ts, opts = {}) {
  const t = ts || {};
  const outcome = t.outcome && t.outcome.text
    ? '<div class="trash-outcome" role="status">' + escapeHtml(t.outcome.text) +
      ' <button type="button" class="btn btn-ghost btn-xs" id="trash-outcome-ok">OK</button></div>'
    : '';
  if (t.error && !t.data) {
    return outcome + '<div class="settings-inline-error">Could not read the trash: ' + escapeHtml(t.error) + '</div>';
  }
  if (!t.data) return outcome + (opts.loadingHtml || '');
  const entries = Array.isArray(t.data.entries) ? t.data.entries : [];
  const syncLine = '<div class="trash-note">The trash is on this computer only and is never synced. ' +
    (t.data.syncConfigured
      ? 'A restore puts the folder back where it was, and your next Sync carries it to GitHub and your other computers.'
      : 'A restore puts the folder back where it was.') + '</div>';
  if (!entries.length) {
    return outcome + '<div class="trash-empty">Nothing in the trash.</div>' + syncLine;
  }
  return outcome +
    '<ul class="trash-list" aria-label="' + escapeHtml(plural(entries.length, 'item', 'items') + ' in the trash') + '">' +
      entries.map((e) => trashRowHtml(e, { ...opts, action: t.action })).join('') +
    '</ul>' +
    syncLine +
    (t.data.trashDir
      ? '<div class="trash-note">Folder: <code class="mono">' + escapeHtml(t.data.trashDir) + '</code></div>' : '');
}

/** The outcome sentence after a restore, from the SERVER's answer. */
export function trashRestoreOutcomeText(r) {
  const x = r && typeof r === 'object' ? r : {};
  const noun = TRASH_NOUN[x.kind] || 'item';
  const where = { domains: 'Domains', projects: 'Context', scopes: 'Context' }[x.kind] || 'the app';
  let text = 'Restored ' + noun + ' “' + (x.name || '') + '” to ' + (x.restoredTo || 'where it was') + '.';
  if (x.renamed) text += ' Its old name was taken, so it came back under this new one.';
  text += ' It is back in ' + where + '.';
  if (x.syncConfigured) text += ' Your next Sync carries it to GitHub.';
  return text;
}

/** The outcome sentence after a permanent delete. */
export function trashDeleteOutcomeText(r) {
  const x = r && typeof r === 'object' ? r : {};
  const size = formatBytes(x.bytes);
  return 'Deleted “' + (x.name || x.id || '') + '” forever' +
    (Number.isInteger(x.files) ? ' — ' + plural(x.files, 'file', 'files') + (size ? ', ' + size : '') : '') + '.';
}
