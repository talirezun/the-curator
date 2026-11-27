/**
 * shared/notice.js — THE NOTICE (kit v1).
 *
 * One shape for "something on this page you should know": ~60 note, warning
 * and hint families (inventory, 2026-11-27) become this one.
 *
 *   notice({ tone, title, line?, actions?, why?, id? }) → HTML
 *
 *   tone     'info' | 'attention' | 'error' — anything else THROWS
 *   title    one sentence, ≤ 12 words. A longer one still renders (a warning
 *            is never dropped for being wordy) and logs ONE console warning
 *            per distinct title, so it is found in development.
 *   line     one optional plain line under the title. Never a paragraph.
 *   actions  at most TWO: [{label, attrs?, primary?}], rendered as buttons in
 *            the kit's button classes. A third THROWS: a notice with three
 *            choices is a dialog, and the cap is the point.
 *            `attrs` is a map of data-* attributes the view's delegated
 *            listener keys on, e.g. {'data-sync-now': ''}.
 *   why      an EXPLAINERS key (shared/explainers.js): a "Why?" text button
 *            that opens that explainer in place, through the one ⓘ mechanism
 *            (shared/text.js's renderInfoMark, via explainer.js's
 *            explainerWordMark) — never a second disclosure. An unknown key
 *            throws, like explainerMark.
 *   id       stable id prefix for the "Why?" panel (defaults from the key).
 *
 * Roles: an error is `role="alert"` (assertive); info and attention are
 * `role="status"` (polite) — attention asks for a decision, not an
 * interruption.
 *
 * Shape + word + tone, like the chip: each tone has its own glyph (note card,
 * triangle, octagon), the title says the thing, and colour is the third
 * carrier. (The info glyph is a note card, not the circled-i: ⓘ is the
 * explainer's control everywhere else.) Never Pro-only: a notice is on the never-hide list.
 *
 * DOM-free: returns a string.
 */

import { explainerWordMark } from './explainer.js';

export const NOTICE_TONES = Object.freeze(['info', 'attention', 'error']);
export const NOTICE_MAX_ACTIONS = 2;
export const NOTICE_TITLE_WORDS = 12;

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const GLYPH = {
  // NOT the circled-i: in this app ⓘ is the explainer's mark, a control.
  // A notice's info glyph is a note card, so the two never read alike.
  info: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 10h8M8 14h5"/>',
  attention: '<path d="M12 3.5 21 19.5H3z"/><path d="M12 10v4M12 17h.01"/>',
  error: '<path d="M8.3 3h7.4L21 8.3v7.4L15.7 21H8.3L3 15.7V8.3z"/><path d="M9.5 9.5l5 5M14.5 9.5l-5 5"/>',
};
function glyph(tone) {
  return '<svg class="kit-notice-ic" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + GLYPH[tone] + '</svg>';
}

const warned = new Set();
/** Words in a title, as a reader counts them. */
export function titleWords(title) {
  return String(title || '').trim().split(/\s+/).filter(Boolean).length;
}

/** A data-* / aria-* attribute map → markup. Other names are dropped. */
function attrsHtml(attrs) {
  if (!attrs || typeof attrs !== 'object') return '';
  let out = '';
  for (const k of Object.keys(attrs)) {
    if (!/^(data|aria)-[a-z0-9-]+$/.test(k)) continue;
    out += ' ' + k + '="' + escapeHtml(attrs[k]) + '"';
  }
  return out;
}

function idFrom(key) {
  return 'kit-why-' + String(key).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function notice(o) {
  const opts = o || {};
  const tone = opts.tone;
  if (NOTICE_TONES.indexOf(tone) === -1) {
    throw new Error('notice: unknown tone "' + tone + '" (' + NOTICE_TONES.join(', ') + ')');
  }
  const title = typeof opts.title === 'string' ? opts.title.trim() : '';
  if (!title) throw new Error('notice: a title is required');
  if (titleWords(title) > NOTICE_TITLE_WORDS && !warned.has(title)) {
    warned.add(title);
    try { console.warn('[kit] notice title over ' + NOTICE_TITLE_WORDS + ' words: "' + title + '"'); } catch { /* no console */ }
  }
  const actions = Array.isArray(opts.actions) ? opts.actions : [];
  if (actions.length > NOTICE_MAX_ACTIONS) {
    throw new Error('notice: at most ' + NOTICE_MAX_ACTIONS + ' actions (got ' + actions.length + ')');
  }
  const line = typeof opts.line === 'string' && opts.line.trim() ? opts.line.trim() : '';
  const why = opts.why ? explainerWordMark(opts.id || idFrom(opts.why), opts.why, 'Why?') : null;
  const buttons = actions.map((a) =>
    '<button type="button" class="btn btn-xs ' + (a && a.primary ? 'btn-primary' : 'btn-secondary') + ' kit-notice-btn"' +
      attrsHtml(a && a.attrs) + '>' + escapeHtml(a && a.label) + '</button>'
  ).join('');
  const side = buttons || (why && why.btn) ? '<div class="kit-notice-acts">' + (why ? why.btn : '') + buttons + '</div>' : '';
  return '<div class="kit-notice kit-notice-' + tone + '" role="' + (tone === 'error' ? 'alert' : 'status') + '">' +
      '<div class="kit-notice-main">' +
        glyph(tone) +
        '<div class="kit-notice-text">' +
          '<p class="kit-notice-title">' + escapeHtml(title) + '</p>' +
          (line ? '<p class="kit-notice-line">' + escapeHtml(line) + '</p>' : '') +
        '</div>' +
        side +
      '</div>' +
      (why ? why.panel : '') +
    '</div>';
}

/** Test seam: forget which long titles were already warned about. */
export function __resetNoticeWarnings() { warned.clear(); }
