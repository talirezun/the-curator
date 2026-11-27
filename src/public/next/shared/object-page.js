/**
 * shared/object-page.js — THE PAGE ANATOMY for one thing (kit v1, owner
 * decision D2): a project, a domain. Header → ONE status sentence → tab strip
 * → body. No numbered sections.
 *
 *   objectPage({ identityDot?, kicker?, title, statusSentence?, primaryAction?,
 *                moreMenu?, strip?, tabs?, body? }) → HTML
 *
 *   identityDot     an identity CLASS (shared/sidebar.js identitySlotClass) —
 *                   the domain's recorded slot, never a list position.
 *   kicker          plain text above the title (the kind of thing, or its
 *                   domain), escaped.
 *   title           plain text, escaped; the page's one <h1>.
 *   statusSentence  plain text, escaped: ONE sentence that says where the
 *                   thing stands ("Two agents are connected; the last note
 *                   was left 27 min ago."). Never a paragraph.
 *   primaryAction   TRUSTED HTML: one button (the kit's .btn-primary).
 *   moreMenu        TRUSTED HTML: the "···" menu (shared/listbox.js), where
 *                   rename/delete live with their confirms unchanged.
 *   strip           TRUSTED HTML: an optional figure strip between the status
 *                   sentence and the tabs (shared/overview.js renderOverview —
 *                   Projects' Pro tiles, phase 2). Readings only, never a notice.
 *   tabs            TRUSTED HTML: shared/tabs.js tabs().
 *   body            TRUSTED HTML: the selected tab's panel (wrap it with
 *                   tabPanelAttrs()).
 *
 * The TRUSTED fields follow shared/section.js's contract: they are markup the
 * view composed from kit parts, never text a user or a provider typed.
 *
 * Not used by any view in kit v1 — the kit page renders it as the
 * acceptance picture; phase 2 rebuilds Context on it.
 *
 * DOM-free: returns a string.
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
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');

export function objectPage(o) {
  const opts = o || {};
  const title = str(opts.title);
  if (!title) throw new Error('objectPage: a title is required');
  const dot = classList(opts.identityDot || '');
  const kicker = str(opts.kicker);
  const status = str(opts.statusSentence);
  const acts = (opts.primaryAction || '') + (opts.moreMenu || '');
  return '<article class="kit-op">' +
      '<header class="kit-op-head">' +
        '<div class="kit-op-titles">' +
          (kicker || dot
            ? '<p class="kit-op-kicker">' +
                (dot ? '<span class="cur-sb-dot ' + dot + '" aria-hidden="true"></span>' : '') +
                (kicker ? '<span>' + escapeHtml(kicker) + '</span>' : '') +
              '</p>'
            : '') +
          '<h1 class="kit-op-title">' + escapeHtml(title) + '</h1>' +
        '</div>' +
        (acts ? '<div class="kit-op-acts">' + acts + '</div>' : '') +
      '</header>' +
      (status ? '<p class="kit-op-status">' + escapeHtml(status) + '</p>' : '') +
      (opts.strip ? '<div class="kit-op-strip">' + opts.strip + '</div>' : '') +
      (opts.tabs ? '<div class="kit-op-tabs">' + opts.tabs + '</div>' : '') +
      (opts.body ? '<div class="kit-op-body">' + opts.body + '</div>' : '') +
    '</article>';
}
