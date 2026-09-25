// ═══════════════════════════════════════════════════════════════════════════
//  views/chat-list.js — CHAT'S CONVERSATION PANE (v3.72.0)
// ═══════════════════════════════════════════════════════════════════════════
//
// Extracted from views/chat.js, where the row, the grouping, the bulk strip
// and their wiring were ~500 lines inside an 8,000-line view. It is a module
// of its own for two reasons, and both are properties rather than tidiness:
//
//   1. IT IS DOM-FREE AT IMPORT. It imports no app.js (which touches
//      `document` at load), so an offline suite imports the REAL builders in
//      plain Node — scripts/test-next-chat-list.js — instead of lifting
//      functions out of chat.js by brace-matching into a sandbox with a
//      hand-kept binding list. That harness is how a new helper used to red
//      an unrelated suite (see the history in test-next-chat-filter.js).
//   2. IT IS THE ONE SIDEBAR COMPONENT. Every row is shared/sidebar.js's
//      `renderSidebarRow` — the Domains reference anatomy Context and Settings
//      already adopted — so Chat stops being the fourth sidebar design
//      (DESIGN.md C10).
//
// ── WHAT A ROW SAYS (maintainer decision M1, 2026-09-25) ──────────────────
// The list spans ALL domains (GET /api/chat), so each row carries:
//   · the domain's IDENTITY DOT (`identitySlotClass(identitySlot)`, the one palette —
//     rule 5, continuity by identity) — it only means something because the
//     list is no longer one domain's;
//   · the title;
//   · `N messages`, the server's real count, then the clock glyph and a LIVE
//     age (`data-age-at` + shared/age-ticker.js). The age is last use
//     (`updatedAt`) when the file recorded one, and otherwise reads "started …
//     ago" from `createdAt` — a pre-v3.72 file never had a last-use time, and
//     presenting its start as its last use would be a false fact;
//   · line three: the domain in WORDS (the dot is never the only carrier),
//     then — only when the LAST answer recorded a pinned project — the hollow
//     grey square and the project's NAME. An older conversation, or one whose
//     last answer recorded no project, shows no mark: nothing is guessed.
//
// ── THE ONE ROW-ACTION RULE (maintainer decision M3) ──────────────────────
// A neutral `.row-act` trash, visible at rest, `--text-3`, never red on
// hover (shared/row-action.css). Red appears only on the confirm. Bulk delete
// is a MODE: "Select" in the list head shows checkboxes and a contextual bar
// (`Select all · N selected · Delete N · Done`) and hides the per-row icons
// (`.row-select-mode .row-act { display: none }`, the rule row-action.css owns).
//
// ── WHY THE ROW ACTION IS A SIBLING, NOT A CHILD ──────────────────────────
// renderSidebarRow returns a <button>, and a <button> may not contain another
// interactive element. The trash and the checkbox therefore sit BESIDE the
// row button inside `.chat-conv-item`, so each is a real, separately
// focusable control and none of them passes through the row's own click.

import { renderSidebarRow, renderSidebarGroup, identitySlotClass } from '../shared/sidebar.js';
import { ageWordsFor } from '../shared/age-ticker.js';

// A byte-for-byte copy of app.js's escapeHtml, for the reason shared/sidebar.js
// carries one: this module must import in plain Node.
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * The ONE trash glyph's path — app.js's `ICON_BODY.trash`, copied because
 * app.js cannot be imported here. Pinned byte-identical to app.js by
 * scripts/test-next-chat-list.js, the way test-row-actions.js pins
 * shared/foundations-sources.js's copy (DESIGN.md C9: one glyph).
 */
export const TRASH_PATH_D = 'M4.5 6.5h15M9.5 6.5V4.8a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.7M6.5 6.5l.7 12.4a1.5 1.5 0 0 0 1.5 1.4h6.6a1.5 1.5 0 0 0 1.5-1.4l.7-12.4';

function trashGlyph() {
  return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="' + TRASH_PATH_D + '"/></svg>';
}

/** A conversation's identity across domains. Ids are UUIDs and unique only
 *  within one domain's folder, so the domain is part of the key. A slug never
 *  contains '/', so the pair cannot be forged into another pair. */
export function convKey(domain, id) {
  return String(domain || '') + '/' + String(id || '');
}

// ── Time ──────────────────────────────────────────────────────────────────

/** The timestamp a row is aged and grouped by, and whether it is last use. */
export function rowTime(c) {
  const u = c && typeof c.updatedAt === 'string' && Number.isFinite(Date.parse(c.updatedAt)) ? c.updatedAt : null;
  if (u) return { iso: u, lastUse: true };
  const s = c && typeof c.createdAt === 'string' && Number.isFinite(Date.parse(c.createdAt)) ? c.createdAt : null;
  return { iso: s, lastUse: false };
}

function startOfLocalDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Which group a timestamp falls in at `now`, by LOCAL calendar day:
 * 'today' | 'yesterday' | 'week' (the six days before yesterday) | 'earlier'.
 * An unreadable time, or one AHEAD of this clock, is 'today' for a future
 * stamp (it cannot be older than today) and 'earlier' for no stamp at all —
 * the group that claims nothing about recency.
 */
export function dayBucket(iso, now) {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return 'earlier';
  const today = startOfLocalDay(now);
  if (t >= today) return 'today';
  const yesterday = startOfLocalDay(today - 1);
  if (t >= yesterday) return 'yesterday';
  // Seven calendar days back from the start of yesterday, walked day by day
  // so a daylight-saving change never shortens the window by an hour.
  let edge = yesterday;
  for (let i = 0; i < 6; i++) edge = startOfLocalDay(edge - 1);
  if (t >= edge) return 'week';
  return 'earlier';
}

export const GROUP_LABELS = Object.freeze({
  today: 'Today', yesterday: 'Yesterday', week: 'Previous 7 days', earlier: 'Earlier',
});
const GROUP_ORDER = ['today', 'yesterday', 'week', 'earlier'];

/** The list, grouped at `now`. Order inside a group is the server's (newest
 *  first by `updatedAt ?? createdAt`), never re-sorted here. */
export function groupConversations(list, now) {
  const buckets = { today: [], yesterday: [], week: [], earlier: [] };
  for (const c of Array.isArray(list) ? list : []) buckets[dayBucket(rowTime(c).iso, now)].push(c);
  return GROUP_ORDER.filter((k) => buckets[k].length).map((k) => ({ key: k, label: GROUP_LABELS[k], rows: buckets[k] }));
}

function exactStamp(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

// ── The row ───────────────────────────────────────────────────────────────

function domainIndexOf(domains, slug) {
  return Array.isArray(domains) ? domains.findIndex((d) => d && d.slug === slug) : -1;
}
function domainName(domains, slug) {
  const i = domainIndexOf(domains, slug);
  const d = i >= 0 ? domains[i] : null;
  return (d && (d.displayName || d.slug)) || String(slug || '');
}

/** The project a row may name: a string the server kept (it drops non-strings
 *  and names over 64 characters), or nothing. `null` means "recorded: no
 *  project" and an absent key means "not recorded"; both render no mark. */
export function rowProject(c) {
  return c && typeof c.lastProject === 'string' && c.lastProject ? c.lastProject : null;
}

/**
 * One conversation row.
 * @param {object} c    a row from GET /api/chat (`domain` is from the storage path)
 * @param {object} ctx  { domains, activeDomain, activeConversationId,
 *                        selectMode, selectedKeys:Set, answeringConvId,
 *                        answeringDomain, now }
 */
export function conversationRowHtml(c, ctx) {
  const x = ctx || {};
  if (!c || typeof c.id !== 'string' || !c.id) return '';
  const domain = typeof c.domain === 'string' ? c.domain : (x.activeDomain || '');
  const key = convKey(domain, c.id);
  const title = c.title || 'Untitled';
  const count = typeof c.messageCount === 'number' && c.messageCount >= 0 ? c.messageCount : 0;
  const active = c.id === x.activeConversationId && domain === x.activeDomain;
  const selecting = x.selectMode === true;
  const selected = selecting && x.selectedKeys instanceof Set && x.selectedKeys.has(key);
  // BOTH fields, because an id is unique only within one domain's folder.
  const answering = !!x.answeringConvId && x.answeringConvId === c.id && x.answeringDomain === domain;
  const idx = domainIndexOf(x.domains, domain);
  // The domain's RECORDED slot (v3.76.0), carried on its stats row — never idx.
  const slot = idx >= 0 && x.domains[idx] ? x.domains[idx].identitySlot : null;
  const t = rowTime(c);
  const now = typeof x.now === 'number' ? x.now : Date.now();
  const prefix = t.lastUse ? '' : 'started';
  const ageText = t.iso ? (ageWordsFor(t.iso, now, prefix) || '') : '';
  const project = rowProject(c);
  const matched = c.matchField === 'message' ? ' · matched in a message' : '';

  const row = renderSidebarRow({
    name: title,
    dotClass: identitySlotClass(slot),
    figure: count + ' message' + (count === 1 ? '' : 's'),
    // The live "answering" state, in WORDS — `role="status"` because it
    // appears without the user doing anything to this row. No animation.
    markHtml: answering
      ? '<span class="chat-conv-answering" role="status"><span class="chat-conv-answering-dot" aria-hidden="true"></span>answering</span>'
      : '',
    age: ageText,
    ageExact: t.iso ? (t.lastUse ? 'last message ' : 'started ') + exactStamp(t.iso) : '',
    event: domainName(x.domains, domain) + matched,
    eventDetail: project || '',
    eventMarkClass: project ? 'chat-pmark' : '',
    active,
    ariaCurrent: active,
    stateClass: 'chat-conv-row' + (selected ? ' selected' : '') + (answering ? ' answering' : ''),
    data: Object.assign(
      { 'conv-select': c.id, 'conv-domain': domain },
      t.iso ? { 'age-at': t.iso } : {},
      t.iso && prefix ? { 'age-prefix': prefix } : {},
    ),
  });

  return (
    '<div class="chat-conv-item' + (selected ? ' selected' : '') + '" data-conv-key="' + escapeHtml(key) + '">' +
      (selecting
        // A WRAPPING LABEL, purely to give the 13x13 input a real target:
        // Chrome draws no ::before on an <input>, so the kit's "grow the
        // target" technique cannot reach it (shared/checkbox.css records it).
        ? '<label class="chat-conv-check-hit">' +
            '<input type="checkbox" class="cur-check cur-check-sm chat-conv-check" data-conv-check="' + escapeHtml(key) + '"' +
              (selected ? ' checked' : '') + ' aria-label="' + escapeHtml('Select ' + title) + '">' +
          '</label>'
        : '') +
      row +
      '<button type="button" class="row-act chat-conv-act" data-conv-delete="' + escapeHtml(c.id) + '"' +
        ' data-conv-domain="' + escapeHtml(domain) + '" data-conv-title="' + escapeHtml(c.title || '') + '"' +
        ' aria-label="' + escapeHtml('Delete ' + title) + '">' + trashGlyph() +
      '</button>' +
    '</div>'
  );
}

// ── The list ──────────────────────────────────────────────────────────────

/**
 * The grouped list, or the reason there is none.
 * ctx adds: { conversations, loadError, searchQuery, domainFilter,
 *             emptyExtraHtml (TRUSTED — the host's "Ask this in a new chat") }
 */
export function conversationListHtml(ctx) {
  const x = ctx || {};
  if (x.loadError) return '<div class="chat-sidebar-error">' + escapeHtml(x.loadError) + '</div>';
  const list = Array.isArray(x.conversations) ? x.conversations : [];
  const query = typeof x.searchQuery === 'string' ? x.searchQuery.trim() : '';
  if (list.length === 0) {
    const where = x.domainFilter ? ' in ' + domainName(x.domains, x.domainFilter) : '';
    return '<div class="sidebar-hint chat-list-empty">' +
      (query
        ? 'No conversations' + where + ' match “' + escapeHtml(x.searchQuery) + '”.'
        : 'No conversations' + where + ' yet.') +
      '</div>' + (typeof x.emptyExtraHtml === 'string' ? x.emptyExtraHtml : '');
  }
  const now = typeof x.now === 'number' ? x.now : Date.now();
  // NOT filtered here: the list IS the server's answer for the last completed
  // search (titles AND bodies). Re-filtering would drop body matches.
  return groupConversations(list, now).map((g) => renderSidebarGroup({
    eyebrow: g.label,
    rowsHtml: g.rows.map((c) => conversationRowHtml(c, x)).join(''),
  })).join('');
}

/**
 * The list head: the domain filter's host (the host view mounts a shared
 * listbox into it — this module cannot import listbox.js, which imports
 * app.js), the true count, and the Select toggle.
 * ctx adds: { total, selectMode }
 */
export function listHeadHtml(ctx) {
  const x = ctx || {};
  const list = Array.isArray(x.conversations) ? x.conversations : [];
  const total = Number.isInteger(x.total) && x.total >= list.length ? x.total : list.length;
  const canSelect = !x.loadError && list.length > 0;
  return (
    '<div class="chat-list-head">' +
      '<span class="chat-list-filter" id="chat-domain-filter-host"></span>' +
      '<span class="chat-list-count chat-num" aria-label="' + escapeHtml(total + ' conversation' + (total === 1 ? '' : 's')) + '">' + total + '</span>' +
      '<span class="chat-list-spacer"></span>' +
      (x.selectMode === true
        ? ''
        : '<button type="button" class="btn btn-ghost btn-xs chat-select-btn" id="chat-select-btn"' +
            (canSelect ? '' : ' disabled') + '>Select</button>') +
    '</div>'
  );
}

/** "Showing the newest N of M" — only when the server said there are more. */
export function truncationHintHtml(ctx) {
  const x = ctx || {};
  const list = Array.isArray(x.conversations) ? x.conversations : [];
  if (!Number.isInteger(x.total) || x.total <= list.length || list.length === 0) return '';
  return '<div class="sidebar-hint chat-list-more">Showing the newest ' + list.length + ' of ' + x.total + '.</div>';
}

/** Domains whose conversations folder could not be read, named — never
 *  silently counted as "no conversations". */
export function unreadableHintHtml(ctx) {
  const x = ctx || {};
  const u = Array.isArray(x.unreadable) ? x.unreadable.filter((s) => typeof s === 'string' && s) : [];
  if (u.length === 0) return '';
  return '<div class="sidebar-hint chat-list-unreadable" role="status">Could not read the conversations in ' +
    u.map((s) => escapeHtml(domainName(x.domains, s))).join(', ') + '.</div>';
}

/**
 * The Select mode's contextual bar: Select all · N selected · Delete N · Done.
 * NEUTRAL buttons — the destructive colour belongs to the confirm alone (M3).
 */
export function selectBarHtml(ctx) {
  const x = ctx || {};
  if (x.selectMode !== true) return '';
  const list = Array.isArray(x.conversations) ? x.conversations : [];
  const sel = x.selectedKeys instanceof Set ? x.selectedKeys : new Set();
  const n = list.filter((c) => sel.has(convKey(c.domain, c.id))).length;
  const all = n > 0 && n === list.length;
  return (
    '<div class="chat-bulk-bar" role="toolbar" aria-label="Selected conversations">' +
      '<label class="chat-bulk-all">' +
        '<input type="checkbox" class="cur-check cur-check-sm" id="chat-bulk-all"' + (all ? ' checked' : '') +
          (list.length === 0 ? ' disabled' : '') + ' aria-label="Select all conversations">' +
        '<span class="chat-num">' + (n === 0 ? 'Select all' : n + ' selected') + '</span>' +
      '</label>' +
      '<span class="chat-list-spacer"></span>' +
      '<button type="button" class="btn btn-secondary btn-xs" id="chat-bulk-delete"' + (n === 0 ? ' disabled' : '') +
        ' aria-label="' + escapeHtml('Delete ' + n + ' selected conversation' + (n === 1 ? '' : 's')) + '">' +
        'Delete' + (n > 0 ? ' ' + n : '') +
      '</button>' +
      '<button type="button" class="btn btn-ghost btn-xs" id="chat-select-done">Done</button>' +
    '</div>'
  );
}

export function bulkNoticeHtml(notice) {
  if (!notice || !notice.text) return '';
  return '<div class="chat-bulk-notice' + (notice.tone === 'error' ? ' error' : '') + '" role="status">' +
    escapeHtml(notice.text) + '</div>';
}

/** The whole pane body the host replaces on a light repaint. */
export function conversationPaneHtml(ctx) {
  const x = ctx || {};
  return (
    listHeadHtml(x) +
    selectBarHtml(x) +
    bulkNoticeHtml(x.bulkNotice) +
    unreadableHintHtml(x) +
    '<div class="chat-conv-list' + (x.selectMode === true ? ' row-select-mode' : '') + '">' +
      conversationListHtml(x) +
    '</div>' +
    truncationHintHtml(x)
  );
}

// ── Wiring ────────────────────────────────────────────────────────────────

/**
 * Bind everything inside the pane. `root` is the pane element; nothing here
 * reaches for `document`, so a suite drives it with a fake root.
 * @param {object} root
 * @param {{ onOpen(id, domain), onDelete(id, domain, title), onToggle(key, on),
 *           onToggleAll(on), onDeleteSelected(), onSelectMode(on), onAsk?() }} h
 * @param {{ selectMode?: boolean }} [opts]
 */
export function wireConversationPane(root, h, opts) {
  if (!root || typeof root.querySelectorAll !== 'function' || !h) return;
  const selecting = !!(opts && opts.selectMode === true);

  root.querySelectorAll('[data-conv-select]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.getAttribute('data-conv-select');
      const domain = el.getAttribute('data-conv-domain');
      // In Select mode a row press toggles its selection — the row IS the
      // bigger target, and opening a thread from inside a bulk action would
      // throw the selection away with the list it belongs to.
      if (selecting) { h.onToggle(convKey(domain, id), null); return; }
      h.onOpen(id, domain);
    });
  });
  root.querySelectorAll('[data-conv-delete]').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
      h.onDelete(el.getAttribute('data-conv-delete'), el.getAttribute('data-conv-domain'), el.getAttribute('data-conv-title'));
    });
  });
  root.querySelectorAll('[data-conv-check]').forEach((el) => {
    el.addEventListener('change', () => h.onToggle(el.getAttribute('data-conv-check'), !!el.checked));
  });
  const all = root.querySelector('#chat-bulk-all');
  if (all) all.addEventListener('change', () => h.onToggleAll(!!all.checked));
  const del = root.querySelector('#chat-bulk-delete');
  if (del) del.addEventListener('click', () => h.onDeleteSelected());
  const sel = root.querySelector('#chat-select-btn');
  if (sel) sel.addEventListener('click', () => h.onSelectMode(true));
  const done = root.querySelector('#chat-select-done');
  if (done) done.addEventListener('click', () => h.onSelectMode(false));
  const ask = root.querySelector('#chat-filter-ask');
  if (ask && typeof h.onAsk === 'function') ask.addEventListener('click', () => h.onAsk());
}
