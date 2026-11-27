/**
 * shared/status.js — THE STATUS CHIP (kit v1, owner decision D9, 2026-11-27).
 *
 * ONE closed vocabulary for "what state is this in", app-wide. The 2026-11-27
 * inventory counted ~30 pill/badge families, 16 dot families and 15+ status
 * words with no shared list; every new status from here on is one of these
 * six kinds, and scripts/test-kit-parts.js fails a kind or a word outside it.
 *
 *   kind        word(s) it may say      tone             shape (never colour alone)
 *   ready       Ready                   --status-ok      filled dot
 *   needs-you   Needs you               --status-attn    diamond
 *   working     Working                 --status-work    turning ring (still under
 *                                                        prefers-reduced-motion)
 *   off         Not connected · Off     --status-off     hollow ring
 *   unknown     Unknown                 --status-off     dashed ring
 *   error       Failed                  --status-err     square
 *
 * Every chip is SHAPE + WORD + TONE: the word is always rendered (there is no
 * dot-only form), the shape differs per kind, and the tone is the third,
 * redundant carrier. The tone tokens are tokens/color.css's `--status-*`,
 * defined for both themes at ≥ 4.5:1 against `--surface` and against the
 * chip's own tint (measured there and re-computed by the suite).
 *
 * THE COUNT FORM: `statusChip('needs-you', {count: 21, label: 'to review'})`
 * → "21 to review", in the kind's tone and shape. The label there is a noun
 * phrase about what is counted, so it is free text; the bare form's word is
 * NOT free — it must be one of the kind's words above.
 *
 * IDENTITY IS NOT STATUS (D9): a domain's identity colour stays on its
 * identity dot (shared/sidebar.js identitySlotClass) and never on a chip.
 *
 * An unknown kind or an off-list word THROWS, like docsUrl(): a typo is a
 * blank screen in development, never a seventh status word in production.
 *
 * DOM-free: returns a string.
 */

import { fmtCount } from './format.js';

/** kind → the words the bare chip may say (the first is the default). */
export const STATUS_WORDS = Object.freeze({
  'ready': Object.freeze(['Ready']),
  'needs-you': Object.freeze(['Needs you']),
  'working': Object.freeze(['Working']),
  'off': Object.freeze(['Not connected', 'Off']),
  'unknown': Object.freeze(['Unknown']),
  'error': Object.freeze(['Failed']),
});

/** The closed list of kinds, in the order the kit page shows them. */
export const STATUS_KINDS = Object.freeze(Object.keys(STATUS_WORDS));

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * @param {string} kind  one of STATUS_KINDS
 * @param {{label?: string, count?: number}} [o]
 * @returns {string} HTML
 */
export function statusChip(kind, o) {
  if (!Object.prototype.hasOwnProperty.call(STATUS_WORDS, kind)) {
    throw new Error('statusChip: unknown status kind "' + kind + '" (the vocabulary is closed: ' + STATUS_KINDS.join(', ') + ')');
  }
  const opts = o || {};
  let text;
  if (opts.count !== undefined && opts.count !== null) {
    const n = fmtCount(opts.count);
    const what = typeof opts.label === 'string' ? opts.label.trim() : '';
    if (n === null || !what) throw new Error('statusChip: the count form needs a number and a label');
    text = n + ' ' + what;
  } else if (opts.label !== undefined) {
    if (STATUS_WORDS[kind].indexOf(opts.label) === -1) {
      throw new Error('statusChip: "' + opts.label + '" is not a word of "' + kind + '" (' + STATUS_WORDS[kind].join(' · ') + ')');
    }
    text = opts.label;
  } else {
    text = STATUS_WORDS[kind][0];
  }
  return '<span class="kit-chip kit-chip-' + kind + '" data-status="' + kind + '">' +
    '<span class="kit-chip-mark" aria-hidden="true"></span>' +
    '<span class="kit-chip-label">' + escapeHtml(text) + '</span>' +
  '</span>';
}
