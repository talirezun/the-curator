/**
 * shared/row.js — THE ROW (kit v1).
 *
 * One row per thing: identity dot · title · one meta line · one status chip ·
 * at most one action · a chevron when it opens. The 2026-11-27 inventory
 * counted 67 `-row` class stems; new views draw this one.
 *
 *   row({ id?, dot?, title, meta?, status?, action?, opens?, href?, label? }) → HTML
 *
 *   dot      an identity CLASS from shared/sidebar.js (identitySlotClass /
 *            domainIdentityClass) — the domain's recorded slot, never a list
 *            position (design rule 5). '' draws no dot.
 *   title    plain text (escaped).
 *   meta     plain text, ONE line (escaped; ellipsised, full text in title=).
 *   status   a chip from shared/status.js (trusted HTML, the kit's own).
 *   action   ONE button: {label, attrs?} (attrs: data- and aria- attributes only). It is
 *            above the row's open target, so pressing it never opens the row.
 *   opens    true when the whole row opens something. With `href` the target
 *            is a link; otherwise a button carrying `data-kit-row-open="id"`,
 *            handled by wireRows().
 *
 * ── THE WHOLE ROW IS THE TARGET, WITHOUT A BUTTON INSIDE A BUTTON ──────────
 * The open target is the TITLE's own <button>/<a>, stretched over the row by a
 * ::after (shared/row.css). So a pointer anywhere on the row opens it, the
 * keyboard reaches ONE control per row (Enter and Space are a button's own;
 * wireRows() adds Space to the link form), a screen reader hears the title as
 * the control's name, and the one action sits above the stretch, separately
 * focusable — no nested interactive content.
 *
 * DOM-free at import; wireRows() touches only the root it is given.
 */

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function classList(s) {
  if (typeof s !== 'string') return '';
  return s.split(/\s+/).filter((t) => /^[A-Za-z0-9_-]+$/.test(t)).join(' ');
}
function attrsHtml(attrs) {
  if (!attrs || typeof attrs !== 'object') return '';
  let out = '';
  for (const k of Object.keys(attrs)) {
    if (!/^(data|aria)-[a-z0-9-]+$/.test(k)) continue;
    out += ' ' + k + '="' + escapeHtml(attrs[k]) + '"';
  }
  return out;
}
/** A safe href: relative, root-relative, a fragment, or http(s). */
function safeHref(h) {
  if (typeof h !== 'string') return null;
  const t = h.trim();
  if (/^(https?:\/\/|\/(?!\/)|#|\.{0,2}\/)/i.test(t) || /^[A-Za-z0-9_-][^:]*$/.test(t)) return t;
  return null;
}

export const ROW_CHEVRON =
  '<svg class="kit-row-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';

export function row(o) {
  const opts = o || {};
  const title = typeof opts.title === 'string' ? opts.title : '';
  if (!title.trim()) throw new Error('row: a title is required');
  const id = typeof opts.id === 'string' ? opts.id : '';
  const dot = classList(opts.dot || '');
  const meta = typeof opts.meta === 'string' && opts.meta.trim() ? opts.meta.trim() : '';
  const href = opts.opens ? safeHref(opts.href) : null;
  if (opts.opens && opts.href !== undefined && href === null) throw new Error('row: unsafe href');
  const opens = !!opts.opens;
  const titleHtml = escapeHtml(title);
  const target = !opens
    ? '<span class="kit-row-title">' + titleHtml + '</span>'
    : href !== null
      ? '<a class="kit-row-title kit-row-open" href="' + escapeHtml(href) + '" data-kit-row-open="' + escapeHtml(id) + '">' + titleHtml + '</a>'
      : '<button type="button" class="kit-row-title kit-row-open" data-kit-row-open="' + escapeHtml(id) + '">' + titleHtml + '</button>';
  const a = opts.action;
  const actionHtml = a && typeof a === 'object' && a.label
    ? '<button type="button" class="btn btn-xs btn-secondary kit-row-act"' + attrsHtml(a.attrs) + '>' + escapeHtml(a.label) + '</button>'
    : '';
  return '<div class="kit-row' + (opens ? ' kit-row-opens' : '') + '"' + (id ? ' data-kit-row="' + escapeHtml(id) + '"' : '') + '>' +
      (dot ? '<span class="kit-row-dot cur-sb-dot ' + dot + '" aria-hidden="true"></span>' : '') +
      '<span class="kit-row-text">' + target +
        (meta ? '<span class="kit-row-meta" title="' + escapeHtml(meta) + '">' + escapeHtml(meta) + '</span>' : '') +
      '</span>' +
      (opts.status ? '<span class="kit-row-status">' + opts.status + '</span>' : '') +
      actionHtml +
      (opens ? ROW_CHEVRON : '') +
    '</div>';
}

/**
 * Delegated open handling for every kit row under `root`. `onOpen(id, el, event)`
 * is called for a press on a row's open target. Returns a function that
 * removes the listeners.
 *
 * For the link form, onOpen is told and the browser then follows the href; a
 * view that handles the navigation itself calls event.preventDefault().
 */
export function wireRows(root, onOpen) {
  if (!root || typeof root.addEventListener !== 'function') return () => {};
  const targetOf = (e) => (e && e.target && typeof e.target.closest === 'function')
    ? e.target.closest('[data-kit-row-open]') : null;
  const click = (e) => {
    const t = targetOf(e);
    if (!t) return;
    if (typeof onOpen === 'function') onOpen(t.getAttribute('data-kit-row-open'), t, e);
  };
  // A <button> already turns Enter and Space into a click. A link turns only
  // Enter into one, so Space is added for the link form (and its page scroll
  // suppressed), which makes every kit row answer the same two keys.
  const key = (e) => {
    const t = targetOf(e);
    if (!t || String(t.tagName).toUpperCase() !== 'A') return;
    if (e.key === ' ' || e.key === 'Spacebar') {
      if (typeof e.preventDefault === 'function') e.preventDefault();
      if (typeof t.click === 'function') t.click();
    }
  };
  root.addEventListener('click', click);
  root.addEventListener('keydown', key);
  return () => { root.removeEventListener('click', click); root.removeEventListener('keydown', key); };
}
