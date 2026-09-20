// ═══════════════════════════════════════════════════════════════════════════
//  shared/overview.js — THE OVERVIEW CARD, FOR ANY VIEW
// ═══════════════════════════════════════════════════════════════════════════
//
// An OVERVIEW is the readings ABOUT a screen, in one card, under one eyebrow
// with one ⓘ. It is never a step and it is never numbered: the numbered
// sections below it are the sequence, and this is the instrument above them.
//
// ── WHY IT EXISTS ─────────────────────────────────────────────────────────
// Two screens expressed the same idea with two different components. The
// Domains page drew a grid of stat cards inside `.cur-group` under an
// `OVERVIEW` eyebrow with an ⓘ, plus a row of jump tiles. The Project-context
// page drew a three-cell mono strip of `renderReadout`s with a lone ⓘ pushed
// to the right. The maintainer's question was the whole brief: "how are these
// the same?" — they answer the same question about two screens, so they are
// now ONE function and cannot drift apart again.
//
// The Domains grid is the reference design and it moved here UNCHANGED in
// value: same tile padding, same radius, same 22px figure, same transparent
// chrome inside the group, same hover / focus / pressed / press-nudge
// vocabulary. What the Context view gains is that shape; what the Domains
// page gains is nothing visible at all, which is the acceptance test.
//
// ── THE CLASS NAMES, AND WHY THERE ARE TWO SETS ───────────────────────────
// The kit's own names are `cur-ov-*` and they carry EVERY rule
// (shared/overview.css). The Domains page additionally emits its historical
// `dm-*` tokens on the SAME elements — `dm-stats-grid`, `dm-stat-card`,
// `dm-stat-value`, `dm-jump-row`, `dm-jump-card`, `dm-jump-value`,
// `dm-stats-group`, `dm-section-head-row`, `dm-section-eyebrow` — because
// those strings are pinned BY NAME in shipped suites and are the selectors
// this view's own listeners and its column-patch walk address. They are
// ALIASES: tokens with no rules of their own except the three ink classes
// views/domains.css keeps (`--dm-ink-*` is that view's ramp, not the kit's).
// A view that wants them asks for them with `alias: 'dm'`; the Context view
// does not, so no `dm-` string reaches views/memory.js.
//
// ── EVERY CALLER-SUPPLIED STRING IS ESCAPED, EXCEPT TWO NAMED FIELDS ──────
// `markHtml` (a freshness dot the caller has already composed) and `infoText`
// with `infoHtml: true` are TRUSTED, pre-rendered HTML — the same contract,
// spelled the same way, that `renderReadout` and `renderInfoMark` carry. A
// `toneClass` is a class NAME and is filtered to `[A-Za-z0-9_-]`, never
// escaped-and-hoped: an attribute value that can carry a quote is how a class
// slot becomes an attribute injection.

import { renderInfoMark } from './text.js';

// ── escapeHtml ─────────────────────────────────────────────────────────────
// A byte-for-byte copy of app.js's, for the reason shared/text.js and
// shared/block.js each carry one: app.js touches `document` at import time and
// cannot be imported by a module that must stay executable in an offline
// suite. The equality is PINNED by scripts/test-next-overview-kit.js against
// shared/block.js's copy rather than trusted.
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** A class NAME slot. Anything outside the class-name alphabet is dropped, so
 *  a quote can never reach the attribute. Several names may be given, space
 *  separated; each is filtered on its own. */
function classList(s) {
  if (typeof s !== 'string') return '';
  return s.split(/\s+/).filter((t) => /^[A-Za-z0-9_-]+$/.test(t)).join(' ');
}

/** Two class sets, joined, with the empties dropped — so an aliasless caller
 *  emits exactly the kit's own token and nothing else. */
function cls(kit, alias) {
  return alias ? kit + ' ' + alias : kit;
}

/**
 * ONE overview.
 *
 * @param {{
 *   id: string,               // the ⓘ panel's DOM id, and the block's own class stem
 *   eyebrow: string,          // the word above the card — OVERVIEW, always uppercase by convention
 *   sectionClass?: string,    // the host view's own section class(es), e.g. 'dm-section dm-overview'
 *   infoText?: string,        // the ⓘ's contents; no ⓘ without one
 *   infoLabel?: string,       // the ⓘ's accessible name
 *   infoHtml?: boolean,       // treat `infoText` as trusted markup
 *   alias?: string,           // 'dm' adds the Domains page's historical tokens
 *   cards: Array<{
 *     label: string,          // the small mono caption
 *     value: string,          // the large figure or phrase
 *     sub?: string,           // an optional second line under the value
 *     toneClass?: string,     // an ink class the HOST stylesheet owns
 *     markHtml?: string,      // TRUSTED — a freshness dot, rendered before the value
 *     facet?: string,         // makes the card a toggle over a filter
 *     active?: boolean,       // that toggle's state; only meaningful with `facet`
 *     jump?: string,          // makes the card a jump; `facet` wins if both are given
 *     name?: string,          // the control's accessible name
 *   }>,
 *   jumps?: Array<{ key: string, label: string, value: string, name?: string,
 *                   hidden?: boolean }>,
 * }} o
 * @returns {string} HTML — '' when there is no id, no eyebrow or no card.
 */
export function renderOverview(o) {
  const opts = o && typeof o === 'object' ? o : {};
  const id = typeof opts.id === 'string' ? opts.id.trim() : '';
  const eyebrow = typeof opts.eyebrow === 'string' ? opts.eyebrow.trim() : '';
  const cards = Array.isArray(opts.cards) ? opts.cards.filter(
    (c) => c && typeof c === 'object' && typeof c.label === 'string' && c.value != null) : [];
  // NO READING, NO INSTRUMENT — the readout kit's own rule, applied one level
  // up. An overview with no card is a captioned empty box, which is a worse
  // answer than nothing at all.
  if (!id || !eyebrow || !cards.length) return '';

  const alias = typeof opts.alias === 'string' ? classList(opts.alias) : '';
  const dm = alias === 'dm';

  const info = renderInfoMark(
    id, opts.infoLabel || ('About ' + eyebrow.toLowerCase()),
    typeof opts.infoText === 'string' ? opts.infoText : '',
    opts.infoHtml === true ? { html: true } : undefined);

  // ── A TILE'S INSIDES, ONE SHAPE FOR BOTH VIEWS ─────────────────────────
  // caption, figure, and — new for the Context view — an optional second
  // line. The Domains page passes no `sub`, so its tiles render the bytes
  // they rendered before this module existed.
  const body = (c) => {
    const tone = classList(c.toneClass);
    const mark = typeof c.markHtml === 'string' ? c.markHtml : '';
    return '<div class="cur-eyebrow">' + escapeHtml(c.label) + '</div>' +
      '<div class="' + cls('cur-ov-value', dm ? 'dm-stat-value' : '')
        + (tone ? ' ' + tone : '') + '">' + mark + escapeHtml(String(c.value)) + '</div>' +
      (c.sub ? '<div class="cur-ov-sub">' + escapeHtml(String(c.sub)) + '</div>' : '');
  };

  // ── A FIGURE IS A CONTROL ONLY WHEN IT HAS SOMEWHERE TO GO ─────────────
  // With neither `facet` nor `jump` the tile is the plain `<div>` it has
  // always been in that state: a button whose only possible outcome is
  // nothing is worse than no button, and the geometry is identical either
  // way (same class, same padding, same grid track), so nothing moves when
  // the answer lands. `data-ov-*` is the kit's own hook and is always
  // emitted; `data-stat-*` is the Domains page's, which its listeners and
  // its `aria-pressed` arithmetic already address by name.
  const card = (c) => {
    const klass = cls('cur-ov-card', dm ? 'dm-stat-card' : '');
    const name = typeof c.name === 'string' && c.name ? c.name : c.label;
    if (typeof c.facet === 'string' && c.facet) {
      return '<button type="button" class="' + klass + '"' +
        ' data-ov-facet="' + escapeHtml(c.facet) + '"' +
        (dm ? ' data-stat-facet="' + escapeHtml(c.facet) + '"' : '') +
        ' aria-pressed="' + (c.active === true ? 'true' : 'false') + '"' +
        ' aria-label="' + escapeHtml(name) + '">' + body(c) + '</button>';
    }
    if (typeof c.jump === 'string' && c.jump) {
      // NOT A TOGGLE, so no `aria-pressed` — aria-pressed on a control that
      // does not stay pressed is a lie told to a screen reader only.
      return '<button type="button" class="' + klass + '"' +
        ' data-ov-jump="' + escapeHtml(c.jump) + '"' +
        (dm ? ' data-stat-jump="' + escapeHtml(c.jump) + '"' : '') +
        ' aria-label="' + escapeHtml(name) + '">' + body(c) + '</button>';
    }
    return '<div class="' + klass + '">' + body(c) + '</div>';
  };

  // ── THE JUMP ROW — A SECOND ROW INSIDE THE SAME GROUP ──────────────────
  // These are not figures. They carry a date or a state and they open
  // something further down the page, so they sit outside the equal-width
  // tracks of the grid: a seven-track row would narrow every count to make
  // room for two words, and putting them in the grid would say they are more
  // of the same number. A tile is RENDERED and HIDDEN rather than omitted
  // when its answer has not arrived, because the answer arrives after this
  // paint and a re-render to reveal it would remount whatever the section
  // hosts. `[hidden]` loses to an author `display:` at any specificity, so
  // shared/overview.css carries the counter-rule.
  const jumps = Array.isArray(opts.jumps) ? opts.jumps.filter(
    (j) => j && typeof j === 'object' && typeof j.key === 'string' && j.key) : [];
  const jumpRow = jumps.length
    ? '<div class="' + cls('cur-ov-jumps', dm ? 'dm-jump-row' : '') + '">' +
      jumps.map((j) => '<button type="button" class="'
        + cls('cur-ov-jump', dm ? 'dm-jump-card' : '') + '"' +
        ' data-ov-jump="' + escapeHtml(j.key) + '"' +
        (dm ? ' data-stat-jump="' + escapeHtml(j.key) + '"' : '') +
        ' aria-label="' + escapeHtml(j.name || j.label || j.key) + '"' +
        (j.hidden === true ? ' hidden' : '') + '>' +
        '<div class="cur-eyebrow">' + escapeHtml(j.label || '') + '</div>' +
        '<div class="' + cls('cur-ov-jump-value', dm ? 'dm-jump-value' : '') + '">' +
          escapeHtml(String(j.value == null ? '—' : j.value)) + '</div>' +
      '</button>').join('') +
      '</div>'
    : '';

  const sectionClass = classList(opts.sectionClass);
  return (
    '<section class="cur-ov' + (sectionClass ? ' ' + sectionClass : '') + '">' +
      '<div class="' + cls('cur-ov-head', dm ? 'dm-section-head-row' : '') + '">' +
        '<div class="' + cls('cur-ov-eyebrow cur-group-title',
          dm ? 'dm-section-eyebrow' : '') + '">' + escapeHtml(eyebrow) + '</div>' +
        info.btn +
      '</div>' +
      info.panel +
      '<div class="cur-group ' + cls('cur-ov-group', dm ? 'dm-stats-group' : '') + '">' +
        '<div class="' + cls('cur-ov-grid', dm ? 'dm-stats-grid' : '') + '">' +
          cards.map(card).join('') +
        '</div>' +
        jumpRow +
      '</div>' +
    '</section>'
  );
}
