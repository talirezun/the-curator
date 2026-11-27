/**
 * shared/table.js — THE DATA TABLE (kit v1).
 *
 * One table for "a list of records to compare": 9 table families in the
 * 2026-11-27 inventory (mem-ws-table, fnd-table, browse-table, …) become this.
 *
 *   table({ id, caption?, columns, rows, sortBy?, opens?, pro? }) → HTML
 *
 *   columns  [{ id, label, align?: 'left'|'right', numeric?, sort?, pro? }]
 *            `numeric` right-aligns the column in tabular figures (and sorts it
 *            as numbers); `align: 'right'` alone right-aligns text.
 *            `sort: true` makes the head a button (wireTable → onSort).
 *            `pro: true` columns are DRAWN only while Pro is on (defaults to
 *            shared/pro.js isPro()). The never-hide rule of shared/tabs.js
 *            applies: a warning, cost, refusal or outcome is never a Pro-only
 *            column.
 *   rows     [{ id, cells: { [columnId]: cell } }] where a cell is a string,
 *            a number (written with fmtCount), or
 *            { text?, html?, sort? } — `html` is TRUSTED kit markup (a status
 *            chip); `sort` is the value it sorts by (a number or a string).
 *   sortBy   { id, dir: 'asc'|'desc' } — the rows are sorted here, stably;
 *            the sorted head carries aria-sort, the others none (WAI-ARIA:
 *            one sorted column at a time).
 *   opens    true when a row opens the reader: the first cell's text becomes
 *            a button with `data-kit-row-open="<row id>"`, the keyboard's way
 *            in; a pointer press anywhere on the row opens it too
 *            (wireTable → onOpen), except on another control in the row.
 *
 * BELOW 900 px THE TABLE STACKS (shared/table.css): each row becomes a card
 * of "label  value" lines (every cell carries data-label), so nothing scrolls
 * sideways and no column is dropped for width.
 *
 * DOM-free at import; wireTable() touches only the root it is given.
 */

import { isPro } from './pro.js';
import { fmtCount } from './format.js';

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
const ID_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** The columns this mode draws. */
export function drawnColumns(columns, pro) {
  const on = pro === undefined ? isPro() : !!pro;
  return (Array.isArray(columns) ? columns : []).filter((c) => c && (!c.pro || on));
}

function cellParts(cell) {
  if (cell === null || cell === undefined) return { html: '', sort: null };
  if (typeof cell === 'number') {
    const t = fmtCount(cell);
    return { html: t === null ? '—' : t, sort: Number.isFinite(cell) ? cell : null };
  }
  if (typeof cell === 'string') return { html: escapeHtml(cell), sort: cell };
  if (typeof cell === 'object') {
    const html = typeof cell.html === 'string' ? cell.html : escapeHtml(cell.text);
    const sort = cell.sort !== undefined ? cell.sort : (typeof cell.text === 'string' ? cell.text : null);
    return { html, sort };
  }
  return { html: escapeHtml(cell), sort: null };
}

/** Rows sorted by `sortBy`, stably; unknown values (null) always last. */
export function sortRows(rows, columns, sortBy) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  const col = sortBy && (columns || []).find((c) => c && c.id === sortBy.id && c.sort);
  if (!col) return list;
  const dir = sortBy.dir === 'desc' ? -1 : 1;
  const keyed = list.map((r, i) => ({ r, i, v: cellParts(r && r.cells ? r.cells[col.id] : null).sort }));
  keyed.sort((a, b) => {
    const an = a.v === null || a.v === undefined, bn = b.v === null || b.v === undefined;
    if (an || bn) return an === bn ? a.i - b.i : (an ? 1 : -1);
    let c;
    if (typeof a.v === 'number' && typeof b.v === 'number') c = a.v - b.v;
    else c = String(a.v).localeCompare(String(b.v), 'en', { numeric: true, sensitivity: 'base' });
    return c === 0 ? a.i - b.i : c * dir;
  });
  return keyed.map((k) => k.r);
}

/** The sort a press on column `id` asks for, from the current one. A column's
 *  first press sorts numbers descending (largest first) and text ascending. */
export function nextSort(current, id, columns) {
  const col = (columns || []).find((c) => c && c.id === id);
  if (current && current.id === id) return { id, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { id, dir: col && col.numeric ? 'desc' : 'asc' };
}

const SORT_GLYPH = {
  asc: '<path d="m7 14 5-5 5 5"/>',
  desc: '<path d="m7 10 5 5 5-5"/>',
  none: '<path d="m8 10 4-4 4 4M8 14l4 4 4-4"/>',
};
function sortGlyph(state) {
  return '<svg class="kit-th-sort" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + SORT_GLYPH[state] + '</svg>';
}

export function table(o) {
  const opts = o || {};
  if (typeof opts.id !== 'string' || !ID_RE.test(opts.id)) throw new Error('table: a valid id is required');
  const cols = drawnColumns(opts.columns, opts.pro);
  if (!cols.length) throw new Error('table: no columns to draw');
  for (const c of cols) if (!ID_RE.test(String(c.id))) throw new Error('table: bad column id "' + c.id + '"');
  const sortBy = opts.sortBy && cols.some((c) => c.id === opts.sortBy.id && c.sort) ? opts.sortBy : null;
  const rows = sortRows(opts.rows, cols, sortBy);
  const right = (c) => c.numeric || c.align === 'right';
  const head = cols.map((c) => {
    const cls = 'kit-th' + (right(c) ? ' kit-num' : '');
    if (!c.sort) return '<th scope="col" class="' + cls + '">' + escapeHtml(c.label) + '</th>';
    const state = sortBy && sortBy.id === c.id ? (sortBy.dir === 'desc' ? 'desc' : 'asc') : 'none';
    return '<th scope="col" class="' + cls + '"' +
      (state === 'none' ? '' : ' aria-sort="' + (state === 'asc' ? 'ascending' : 'descending') + '"') + '>' +
      '<button type="button" class="kit-th-btn" data-kit-sort="' + c.id + '">' +
        escapeHtml(c.label) + sortGlyph(state) +
      '</button></th>';
  }).join('');
  const body = rows.map((r) => {
    const rid = r && typeof r.id === 'string' ? r.id : '';
    const opens = !!opts.opens && !!rid;
    const tds = cols.map((c, i) => {
      const p = cellParts(r && r.cells ? r.cells[c.id] : null);
      const inner = opens && i === 0
        ? '<button type="button" class="kit-td-open"' + (r && typeof r.targetId === 'string' && /^[A-Za-z][A-Za-z0-9_-]*$/.test(r.targetId) ? ' id="' + r.targetId + '"' : '') + ' data-kit-row-open="' + escapeHtml(rid) + '">' + p.html + '</button>'
        : p.html;
      return '<td class="kit-td' + (right(c) ? ' kit-num' : '') + '" data-label="' + escapeHtml(c.label) + '">' + inner + '</td>';
    }).join('');
    return '<tr class="kit-tr' + (opens ? ' kit-tr-opens' : '') + '"' + (rid ? ' data-kit-row="' + escapeHtml(rid) + '"' : '') + '>' + tds + '</tr>';
  }).join('');
  return '<div class="kit-table-wrap" data-kit-table="' + opts.id + '">' +
    '<table class="kit-table">' +
      (opts.caption ? '<caption class="kit-table-caption">' + escapeHtml(opts.caption) + '</caption>' : '') +
      '<thead><tr>' + head + '</tr></thead>' +
      '<tbody>' + body + '</tbody>' +
    '</table></div>';
}

/**
 * Delegated wiring for every kit table under `root`:
 *   onSort(columnId, tableId)  a sortable head was pressed (the view computes
 *                              nextSort() and re-renders)
 *   onOpen(rowId, rowEl, e)    a row that opens was pressed (anywhere on the
 *                              row but another control), or its first-cell
 *                              button was pressed or activated by keyboard
 */
export function wireTable(root, { onSort, onOpen } = {}) {
  if (!root || typeof root.addEventListener !== 'function') return () => {};
  const click = (e) => {
    const t = e && e.target;
    if (!t || typeof t.closest !== 'function') return;
    const sortBtn = t.closest('[data-kit-sort]');
    if (sortBtn) {
      const wrap = sortBtn.closest('[data-kit-table]');
      if (typeof onSort === 'function') onSort(sortBtn.getAttribute('data-kit-sort'), wrap ? wrap.getAttribute('data-kit-table') : null);
      return;
    }
    const tr = t.closest('.kit-tr-opens');
    if (!tr) return;
    const control = t.closest('button, a, input, select, textarea, summary, [role="button"]');
    if (control && !control.hasAttribute('data-kit-row-open')) return;
    if (typeof onOpen === 'function') onOpen(tr.getAttribute('data-kit-row'), tr, e);
  };
  root.addEventListener('click', click);
  return () => root.removeEventListener('click', click);
}
