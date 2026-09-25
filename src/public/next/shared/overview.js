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
// vocabulary.
//
// ── v3.65.0: ONE TILE, ONE RUNG ───────────────────────────────────────────
// Two things that had made the two hosts still look unlike each other are
// gone, and both were measured rather than argued (see the two blocks in
// renderOverview): the separate JUMP ROW, which drew SOURCES / SHARED /
// CAPTURE at 92.8 x 46.4 beside 181.8 x 78.9 stat tiles inside one card —
// *"an entirely different design than the five on top"* — and the second
// FIGURE RUNG (`figure: 'phrase'`), which made the Context values 17px beside
// the Domains values' 22px. A jump is now an ordinary card with `jump:` set,
// and a host whose values are phrases raises the grid's track FLOOR
// (`minTrack`) instead of dropping its type. The Domains OVERVIEW therefore
// changes VISIBLY for the first time — its SOURCES and SHARED tiles join the
// grid at tile geometry — and that is the decision, not a regression.
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
 *   minTrack?: number,        // px: the grid's track FLOOR (--cur-ov-min).
 *                             // Omitted, the stylesheet's 110px stands. The
 *                             // only thing a host may tune, and it exists so
 *                             // a view whose values are PHRASES gets wider
 *                             // tracks rather than a smaller type rung.
 *   cards: Array<{
 *     label: string,          // the small mono caption
 *     value: string,          // the figure or phrase, at the ONE display rung
 *     sub?: string,           // an optional second line under the value
 *     toneClass?: string,     // an ink class the HOST stylesheet owns
 *     markHtml?: string,      // TRUSTED — a freshness dot, rendered before the value
 *     ageAt?: string,         // ISO stamp: the value is an age that ticks (age-ticker.js)
 *     agePrefix?: string,     // the words before the age in `value` ("saved")
 *     facet?: string,         // makes the card a toggle over a filter
 *     active?: boolean,       // that toggle's state; only meaningful with `facet`
 *     jump?: string,          // makes the card a jump; `facet` wins if both are given
 *     hidden?: boolean,       // rendered but not shown, for a reading not yet in
 *     name?: string,          // the control's accessible name
 *   }>,
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
  // ── THE SECOND FIGURE RUNG IS GONE, AND THE MEASUREMENT THAT KILLED IT ──
  // v3.64.2 added `figure: 'phrase'` — one rung down, 22px -> 17px — because
  // "at --text-2xl in a three-track grid at 1370px, 'saved 57 min ago' broke
  // after 'min'". RE-MEASURED at the real column width, that wrap does not
  // happen: with the value's own content box at 277.7px (the 3-track grid at
  // 1370), every realistic value renders on ONE line at 22px — `saved 57 min
  // ago` 174.8px, `no agent session` 167.2, `saved 15 hr ago` 158.9, `24
  // documents` 144.6, `not set up yet` 134.4, `1,980 pages` 126.9 (intrinsic
  // widths, dot included). It wraps only below ~207px of track content, which
  // is a 1024px window — or a 1370px one with the ONBOARDING GUIDE DOCKED,
  // narrowing `.main-inner` from 959px to 647px (shell.css:1274). That is
  // almost certainly the state the original figure was taken in.
  //
  // So the narrow case is fixed where it actually lives — the TRACK — with a
  // host-settable floor (`minTrack` -> `--cur-ov-min`, default 110px) rather
  // than with a second type rung. One rung, one instrument: two views whose
  // figures are different sizes are two designs, which is the whole report.

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
    // A TICKING AGE (v3.76.0, truth audit F4). When the value IS an age —
    // "saved 3 min ago" — the host passes the stamp it was computed from as
    // `ageAt` and the words before the age as `agePrefix`, and the figure is
    // wrapped in the shared clock's contract (shared/age-ticker.js): it goes
    // on moving once a second with no repaint, instead of reading "3 min ago"
    // until something else happens to redraw the card. The span is INSIDE the
    // value, after the mark, so the clock's text write can never delete the
    // freshness dot. An unparseable stamp gets no hook — nothing to recount.
    const ageAt = typeof c.ageAt === 'string' && c.ageAt && Number.isFinite(Date.parse(c.ageAt))
      ? c.ageAt : '';
    const figure = ageAt
      ? '<span data-age-at="' + escapeHtml(ageAt) + '"' +
          (typeof c.agePrefix === 'string' && c.agePrefix.trim()
            ? ' data-age-prefix="' + escapeHtml(c.agePrefix.trim()) + '"' : '') +
          ' data-age-text>' + escapeHtml(String(c.value)) + '</span>'
      : escapeHtml(String(c.value));
    return '<div class="cur-eyebrow">' + escapeHtml(c.label) + '</div>' +
      '<div class="' + cls('cur-ov-value', dm ? 'dm-stat-value' : '')
        + (tone ? ' ' + tone : '') + '">' + mark + figure + '</div>' +
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
  //
  // THE CLASS LIST IS WRITTEN AS A LITERAL PREFIX, not assembled into a
  // variable first, and that is a REQUIREMENT rather than a style:
  // scripts/test-next-button-chrome.js scans every `<button … class="…">` in
  // /next and fails any whose class list resolves no author border, because
  // a bare `<button>` falls through to Chromium's 2px outset UA bevel. It
  // reads the SOURCE, so `class="' + klass + '"` is a button with no
  // readable class at all — which is exactly what it reported the first time
  // this file was written that way.
  // ── A TILE IS RENDERED AND HIDDEN, NEVER OMITTED ───────────────────────
  // When a card's answer has not arrived yet, it ships with the `hidden`
  // attribute and is revealed by one attribute write with NO repaint —
  // because a re-render to reveal it would remount whatever the section
  // hosts, and on the domain page that is a live ingest drop target. An
  // OMITTED tile means the reading simply never appears, which is the
  // green-first mutation v3.64.2 closed. `[hidden]` loses to an author
  // `display:` at any specificity, so shared/overview.css carries the
  // counter-rule for the card.
  const card = (c) => {
    const alias2 = dm ? ' dm-stat-card' : '';
    const name = typeof c.name === 'string' && c.name ? c.name : c.label;
    const hidden = c.hidden === true ? ' hidden' : '';
    if (typeof c.facet === 'string' && c.facet) {
      return '<button type="button" class="cur-ov-card' + alias2 + '"' +
        ' data-ov-facet="' + escapeHtml(c.facet) + '"' +
        (dm ? ' data-stat-facet="' + escapeHtml(c.facet) + '"' : '') +
        ' aria-pressed="' + (c.active === true ? 'true' : 'false') + '"' +
        ' aria-label="' + escapeHtml(name) + '"' + hidden + '>' + body(c) + '</button>';
    }
    if (typeof c.jump === 'string' && c.jump) {
      // NOT A TOGGLE, so no `aria-pressed` — aria-pressed on a control that
      // does not stay pressed is a lie told to a screen reader only.
      return '<button type="button" class="cur-ov-card' + alias2 + '"' +
        ' data-ov-jump="' + escapeHtml(c.jump) + '"' +
        (dm ? ' data-stat-jump="' + escapeHtml(c.jump) + '"' : '') +
        ' aria-label="' + escapeHtml(name) + '"' + hidden + '>' + body(c) + '</button>';
    }
    return '<div class="cur-ov-card' + alias2 + '"' + hidden + '>' + body(c) + '</div>';
  };

  // ── THE JUMP ROW IS GONE. A JUMP IS AN ORDINARY CARD. ──────────────────
  // It was a second row inside the same group, with its own classes, its own
  // padding and its own type rung, and it MEASURED as a different object:
  // 92.8 x 46.4 at x=401, beside a 181.8 x 78.9 stat tile at x=385 — a
  // different size, a different height and a 16px indent, inside one card.
  // The report was exactly that: *"SOURCES 14 days ago — I don't understand
  // why it is here and why it is an entirely different design than the five
  // on top"*.
  //
  // The argument for the separate row was that a seven-track grid would
  // narrow every count to make room for two words. `auto-fit` with a floor
  // answers that properly: the tracks are equal, the host raises the floor
  // when its values are phrases (`minTrack`), and the row wraps to a second
  // line of the SAME tiles rather than becoming a different object.
  //
  // Nothing else had to move: `data-ov-jump` / `data-stat-jump` are emitted
  // by the card path above, which is what `bindStatCardListeners` already
  // addresses.

  // ── THE TRACK FLOOR, THE ONE THING A HOST MAY TUNE ─────────────────────
  // A number of PIXELS, validated and re-formatted here — never interpolated
  // as a string, because a custom property's value lands in a `style`
  // attribute and a caller-composed one is an attribute injection with a
  // paint. Out of range or not a number: the stylesheet's own 110px default
  // stands, and the attribute is not emitted at all.
  const minTrack = Number.isFinite(opts.minTrack)
    && opts.minTrack >= 60 && opts.minTrack <= 400
    ? Math.round(opts.minTrack) : null;

  const sectionClass = classList(opts.sectionClass);
  return (
    '<section class="cur-ov' + (sectionClass ? ' ' + sectionClass : '') + '"' +
      (minTrack ? ' style="--cur-ov-min:' + minTrack + 'px"' : '') + '>' +
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
      '</div>' +
    '</section>'
  );
}
