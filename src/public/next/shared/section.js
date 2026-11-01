// ═══════════════════════════════════════════════════════════════════════════
//  shared/section.js — A NUMBERED SECTION AND WHAT GOES IN IT, FOR ANY VIEW
// ═══════════════════════════════════════════════════════════════════════════
//
// The Domain page's building blocks, promoted (v3.89.0) so another view can
// draw the same objects instead of a look-alike copy. Nothing here is new:
// every renderer is a function the Domain page already had inline, and every
// rule in shared/section.css moved out of views/domains.css (and the Shared
// Brain section's copies in views/shared.css) UNCHANGED IN VALUE. The Domain
// page renders the same pixels it did before the move — measured, not
// argued: a before/after pixel comparison at 1280 and 375 px, both themes.
//
//   renderSectionHead   ①'s head block: numeral · title · ⓘ · right meta,
//                       then the ⓘ panel. A SIBLING of its card, never a
//                       wrapper (views/domains.js renderMain says why).
//   renderSectionTitle  the numeral + title row alone, for a head that owns
//                       its own wrapper (② Pages, ③ Projects, ⑤ Wiki health).
//   renderCard          the one card chrome (the kit group's: hairline,
//                       elev-1, radius-lg) — Wiki health's card.
//   renderControlRow    the card's first row, for its one plain action
//                       (Rescan).
//   renderFoldRows / renderFoldRow / renderFoldItem
//                       a stack of fold rows: chevron · label · count pill
//                       or a one-line reading · an optional action, closed by
//                       default; and one row inside a fold's body.
//   renderActionCard / actionChip
//                       the tinted action card (Quick maintenance): eyebrow,
//                       a chip row with a cost slot per chip, a run line, a
//                       footnote — the footnote is the card's last line.
//   renderStatusLine    the tinted one-line status card: one sentence left,
//                       one door right. For an EMPTY or OFF state only.
//
// ── THE CLASS NAMES, AND WHY THERE ARE TWO SETS ───────────────────────────
// The kit's names are `cur-section-*`, `cur-card*`, `cur-fold*`,
// `cur-action*` and `cur-status-line*`, and they carry EVERY moved rule
// (shared/section.css). The Domain page's historical `dm-*` names — and the
// Shared Brain section's `sb-sec-*` — are still emitted on the same elements
// when a host asks with `alias: 'dm'` / `alias: 'sb'`, exactly as
// renderOverview does, because those strings are the selectors their
// listeners, their context rules (`.dm-sources-hd .dm-section-head-row`,
// `.sb-sec-row-body`'s gap) and their shipped suites address by name. An
// aliasless caller emits only kit names.
//
// ── TRUST ─────────────────────────────────────────────────────────────────
// Every plain string is escaped. A field whose name ends in `Html` (and
// `body`, `info.btn` / `info.panel`, `attrs`) is TRUSTED, pre-rendered
// markup the caller composed — the same contract renderOverview's
// `markHtml` and renderInfoMark's `html` carry. A class slot is filtered to
// the class-name alphabet, never escaped-and-hoped.
//
// DOM-free on purpose, like shared/overview.js: an offline suite imports it.

// A byte-for-byte copy of shared/overview.js's escapeHtml (pinned equal by
// scripts/test-next-section-kit.js): app.js touches `document` at import.
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** A class NAME slot: anything outside the class-name alphabet is dropped. */
function classList(s) {
  if (typeof s !== 'string') return '';
  return s.split(/\s+/).filter((t) => /^[A-Za-z0-9_-]+$/.test(t)).join(' ');
}

/** Join class sets, dropping the empties. */
function cls(...parts) {
  return parts.map(classList).filter(Boolean).join(' ');
}

/** An element id slot. */
function idAttr(id) {
  return typeof id === 'string' && /^[A-Za-z][A-Za-z0-9_-]*$/.test(id) ? ' id="' + id + '"' : '';
}

// The chevron, byte-identical to app.js's `icon('chevronRight', 13)` (pinned
// by scripts/test-next-section-kit.js against app.js's ICON_BODY). Carried
// here so a fold row needs nothing from app.js.
export const FOLD_CHEVRON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" ' +
  'aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>';

// The historical names each host keeps on the kit's elements.
const ALIASES = Object.freeze({
  dm: Object.freeze({
    head: 'dm-section dm-section-hd-block', headRow: 'dm-section-head-row',
    hd: 'dm-section-hd', num: 'dm-section-num', title: 'dm-section-eyebrow',
    meta: 'dm-fold-meta dm-section-meta',
    card: 'dm-health-card', top: 'dm-health-top',
    folds: 'dm-groups', fold: 'dm-group', summary: 'dm-group-summary', label: 'dm-group-label',
    foldMeta: 'dm-group-meta', pill: 'dm-group-pill', body: 'dm-group-body',
    item: 'dm-issue-row', itemMain: 'dm-issue-main', itemMeta: 'dm-issue-meta',
    action: 'dm-quick', eyebrow: 'dm-quick-eyebrow', chips: 'dm-quick-actions',
    chip: 'dm-quick-btn', chipLabel: 'dm-quick-label', chipCost: 'dm-quick-cost',
    run: 'dm-quick-run', foot: 'dm-quick-footnote',
    keyAttr: 'data-group-key',
  }),
  sb: Object.freeze({
    folds: 'sb-sec-rows', fold: 'sb-sec-row', summary: 'sb-sec-row-summary', label: 'sb-sec-row-label',
    foldMeta: 'sb-sec-row-meta', body: 'sb-sec-row-body',
    status: 'sb-sec-empty', statusText: 'sb-sec-line sb-sec-empty-text',
    keyAttr: 'data-sb-sec-row',
  }),
});

/** The alias table for a host, or an empty one. */
function aliasOf(o) {
  const a = o && typeof o.alias === 'string' ? ALIASES[o.alias] : null;
  return a || {};
}

/**
 * The numeral + title row: `<div class="cur-section-hd">`.
 *
 * @param {{ num: number|string, title: string, titleId?: string,
 *   focusable?: boolean,        // tabindex="-1", so a jump can focus the title
 *   titleClass?: string,        // the host's extra class(es) on the title
 *   infoBtnHtml?: string,       // TRUSTED: an ⓘ button placed INSIDE the row
 *   alias?: 'dm' }} o
 * @returns {string}
 */
export function renderSectionTitle(o) {
  const opts = o && typeof o === 'object' ? o : {};
  const a = aliasOf(opts);
  return '<div class="' + cls('cur-section-hd', a.hd) + '">' +
      '<span class="' + cls('cur-section-num', a.num) + '" aria-hidden="true">' + escapeHtml(opts.num) + '</span>' +
      '<div class="' + cls('cur-group-title cur-section-title', opts.titleClass, a.title) + '"' +
        idAttr(opts.titleId) + (opts.focusable ? ' tabindex="-1"' : '') + '>' + escapeHtml(opts.title) + '</div>' +
      (typeof opts.infoBtnHtml === 'string' ? opts.infoBtnHtml : '') +
    '</div>';
}

/**
 * A section's head block — ①'s anatomy: one row holding the numeral, the
 * title, the ⓘ and the section's one reading right-aligned; the ⓘ panel
 * under it. A head never carries a button.
 *
 * @param {{ num: number|string, title: string, titleId?: string, focusable?: boolean,
 *   info?: { btn: string, panel: string },   // TRUSTED: an explainer pair
 *   meta?: string,                           // the right-hand reading ('' keeps the slot)
 *   metaId?: string,                         // so a host can rewrite the reading in place
 *   lede?: string, ledeIsHtml?: boolean,     // v3.90.0: one sentence under the row (ledeIsHtml: TRUSTED)
 *   hostClass?: string, alias?: 'dm' }} o
 * @returns {string}
 */
export function renderSectionHead(o) {
  const opts = o && typeof o === 'object' ? o : {};
  const a = aliasOf(opts);
  const info = opts.info && typeof opts.info === 'object' ? opts.info : {};
  const hasMeta = opts.meta != null;
  return '<div class="' + cls('cur-section-head', a.head, opts.hostClass) + '">' +
      '<div class="' + cls('cur-section-head-row', a.headRow) + '">' +
        renderSectionTitle({ num: opts.num, title: opts.title, titleId: opts.titleId,
          focusable: opts.focusable, alias: opts.alias }) +
        (typeof info.btn === 'string' ? info.btn : '') +
        (hasMeta
          ? '<span class="' + cls('cur-section-meta', a.meta) + '"' + idAttr(opts.metaId) + '>' +
              escapeHtml(opts.meta) + '</span>'
          : '') +
      '</div>' +
      // v3.90.0 — a section's one-sentence lede, under the head row (an
      // optional field: absent, the head is byte-identical to before).
      (typeof opts.lede === 'string' && opts.lede
        ? '<p class="cur-section-lede">' + (opts.ledeIsHtml === true ? opts.lede : escapeHtml(opts.lede)) + '</p>' : '') +
      (typeof info.panel === 'string' ? info.panel : '') +
    '</div>';
}

/**
 * The one card chrome.
 * @param {string} innerHtml  TRUSTED
 * @param {{ hostClass?: string, busy?: boolean, minHeight?: number, alias?: 'dm' }} [o]
 */
export function renderCard(innerHtml, o) {
  const opts = o && typeof o === 'object' ? o : {};
  const a = aliasOf(opts);
  // A pixel count (a measured height, so it may be fractional), validated as
  // a number — never a caller's string in a style attribute.
  const minH = Number.isFinite(opts.minHeight) && opts.minHeight > 0 && opts.minHeight < 20000
    ? opts.minHeight : 0;
  return '<div class="' + cls('cur-card', a.card, opts.hostClass) + '"' +
      (opts.busy ? ' aria-busy="true"' : '') +
      (minH ? ' style="min-height:' + minH + 'px"' : '') + '>' +
      (typeof innerHtml === 'string' ? innerHtml : '') +
    '</div>';
}

/** The card's control row — its first child, holding the section's plain
 *  action(s). `buttonsHtml` is TRUSTED. */
export function renderControlRow(buttonsHtml, o) {
  const a = aliasOf(o);
  return '<div class="' + cls('cur-card-top', a.top) + '">' +
    (typeof buttonsHtml === 'string' ? buttonsHtml : '') + '</div>';
}

/** A stack of fold rows. `rowsHtml` is TRUSTED (renderFoldRow output). */
export function renderFoldRows(rowsHtml, o) {
  const opts = o && typeof o === 'object' ? o : {};
  const a = aliasOf(opts);
  return '<div class="' + cls('cur-folds', a.folds, opts.hostClass) + '">' +
    (typeof rowsHtml === 'string' ? rowsHtml : '') + '</div>';
}

/**
 * One fold row: chevron · label · a count pill and/or a one-line reading ·
 * an optional action, over a body. Closed unless `open`.
 *
 * @param {{ key?: string,          // the host's open-state key (data-group-key / data-sb-sec-row)
 *   label: string, labelClass?: string,
 *   labelHtml?: string,            // v3.90.0, TRUSTED: replaces `label` (a mono name beside its sans words)
 *   pill?: string|number,          // a count
 *   meta?: string, metaHtml?: string,   // the reading (metaHtml is TRUSTED)
 *   actionHtml?: string,           // TRUSTED: a control at the summary's end
 *   open?: boolean, bodyHtml?: string, bodyClass?: string,
 *   hostClass?: string, alias?: 'dm'|'sb' }} o
 */
export function renderFoldRow(o) {
  const opts = o && typeof o === 'object' ? o : {};
  const a = aliasOf(opts);
  const keyAttr = a.keyAttr || 'data-fold-key';
  const key = typeof opts.key === 'string' && opts.key ? ' ' + keyAttr + '="' + escapeHtml(opts.key) + '"' : '';
  const meta = typeof opts.metaHtml === 'string' ? opts.metaHtml
    : opts.meta != null ? escapeHtml(opts.meta) : null;
  return '<details class="' + cls('cur-fold', a.fold, opts.hostClass) + '"' + key + (opts.open ? ' open' : '') + '>' +
      '<summary class="' + cls('cur-fold-summary', a.summary) + '">' + FOLD_CHEVRON +
        '<span class="' + cls('cur-fold-label', a.label, opts.labelClass) + '">' +
          (typeof opts.labelHtml === 'string' ? opts.labelHtml : escapeHtml(opts.label)) + '</span>' +
        (opts.pill != null ? '<span class="' + cls('cur-fold-pill', a.pill) + '">' + escapeHtml(opts.pill) + '</span>' : '') +
        (meta != null ? '<span class="' + cls('cur-fold-meta', a.foldMeta) + '">' + meta + '</span>' : '') +
        (typeof opts.actionHtml === 'string' ? opts.actionHtml : '') +
      '</summary>' +
      '<div class="' + cls('cur-fold-body', a.body, opts.bodyClass) + '">' +
        (typeof opts.bodyHtml === 'string' ? opts.bodyHtml : '') + '</div>' +
    '</details>';
}

/**
 * One row inside a fold's body: a mono identifier · a sans fact · a ghost
 * action. Each part is omitted when not given (null/undefined); '' keeps the
 * slot. `mainHtml` / `metaHtml` / `actionHtml` are TRUSTED.
 *
 * @param {{ main?: string, mainHtml?: string, meta?: string, metaHtml?: string,
 *   actionHtml?: string, hostClass?: string, alias?: 'dm' }} o
 */
export function renderFoldItem(o) {
  const opts = o && typeof o === 'object' ? o : {};
  const a = aliasOf(opts);
  const main = typeof opts.mainHtml === 'string' ? opts.mainHtml : opts.main != null ? escapeHtml(opts.main) : null;
  const meta = typeof opts.metaHtml === 'string' ? opts.metaHtml : opts.meta != null ? escapeHtml(opts.meta) : null;
  return '<div class="' + cls('cur-fold-item', a.item, opts.hostClass) + '">' +
      (main != null ? '<span class="' + cls('mono cur-fold-item-main', a.itemMain) + '">' + main + '</span>' : '') +
      (meta != null ? '<span class="' + cls('cur-fold-item-meta', a.itemMeta) + '">' + meta + '</span>' : '') +
      (typeof opts.actionHtml === 'string' ? opts.actionHtml : '') +
    '</div>';
}

/**
 * One chip in an action card's chip row: a label and, optionally, its cost
 * or consequence in the cost slot.
 *
 * @param {{ label: string, cost?: string,
 *   tier?: 'secondary'|'ai',       // the button tier; 'ai' is the token-spend face
 *   action?: string,               // data-action
 *   disabled?: boolean,
 *   attrs?: string,                // TRUSTED extra attributes (leading space), REPLACING `disabled`
 *   leadHtml?: string,             // TRUSTED: a mark before the label (sparkles, a ring)
 *   alias?: 'dm' }} o
 */
export function actionChip(o) {
  const opts = o && typeof o === 'object' ? o : {};
  const a = aliasOf(opts);
  const extra = cls('cur-action-chip', a.chip);
  const action = typeof opts.action === 'string' && opts.action ? ' data-action="' + escapeHtml(opts.action) + '"' : '';
  const attrs = typeof opts.attrs === 'string' && opts.attrs ? opts.attrs : (opts.disabled ? ' disabled' : '');
  // Written as two literal class prefixes rather than one assembled string:
  // scripts/test-next-button-chrome.js reads `<button … class="btn …">` in
  // the SOURCE to prove every button resolves an author border.
  const open = opts.tier === 'ai'
    ? '<button class="btn btn-ai btn-xs ' + extra + '"'
    : '<button class="btn btn-secondary btn-xs ' + extra + '"';
  return open + action + attrs + '>' +
      (typeof opts.leadHtml === 'string' ? opts.leadHtml : '') +
      '<span class="' + cls('cur-action-label', a.chipLabel) + '">' + escapeHtml(opts.label) + '</span>' +
      (opts.cost != null && opts.cost !== ''
        ? '<span class="' + cls('cur-action-cost', a.chipCost) + '">' + escapeHtml(opts.cost) + '</span>' : '') +
    '</button>';
}

/**
 * The tinted action card — Quick maintenance's anatomy.
 *
 * @param {{ eyebrow: string,       // the caption, uppercase by convention
 *   iconHtml?: string,             // TRUSTED: a mark before the eyebrow
 *   chipsHtml?: string,            // TRUSTED: actionChip outputs, joined
 *   runHtml?: string,              // TRUSTED: the run line under the chips ('' omits it)
 *   footnoteHtml?: string,         // TRUSTED: the card's last line ('' omits it)
 *   eyebrowCase?: 'sentence',      // v3.90.0: the eyebrow as written (sans, no uppercase)
 *   hostClass?: string, alias?: 'dm' }} o
 */
export function renderActionCard(o) {
  const opts = o && typeof o === 'object' ? o : {};
  const a = aliasOf(opts);
  const run = typeof opts.runHtml === 'string' ? opts.runHtml : '';
  const foot = typeof opts.footnoteHtml === 'string' ? opts.footnoteHtml : '';
  // v3.90.0 — a SENTENCE-case card (eyebrowCase: 'sentence') leaves out an
  // empty eyebrow and an empty chip row; every other caller is byte-identical.
  const sentence = opts.eyebrowCase === 'sentence';
  const chips = typeof opts.chipsHtml === 'string' ? opts.chipsHtml : '';
  const eyebrowDiv = sentence && !opts.eyebrow ? ''
    : '<div class="' + (sentence ? cls('cur-action-eyebrow', 'cur-action-eyebrow-sentence', a.eyebrow)
      : cls('cur-action-eyebrow', a.eyebrow, 'cur-eyebrow')) + '">' +
      (typeof opts.iconHtml === 'string' ? opts.iconHtml + ' ' : '') + escapeHtml(opts.eyebrow) + '</div>';
  return '<div class="' + cls('cur-action', a.action, opts.hostClass) + '">' +
      eyebrowDiv +
      (sentence && !chips ? '' : '<div class="' + cls('cur-action-chips', a.chips) + '">' + chips + '</div>') +
      (run ? '<div class="' + cls('cur-action-run', a.run) + '">' + run + '</div>' : '') +
      (foot ? '<div class="' + cls('cur-action-footnote', a.foot) + '">' + foot + '</div>' : '') +
    '</div>';
}

/**
 * The tinted one-line status card: one sentence left, one door right. For an
 * EMPTY or OFF state only — a fault with actions is renderActionCard, and a
 * fault without one is renderStatus.
 *
 * @param {string} text            the sentence (escaped unless `textIsHtml`)
 * @param {string} [buttonHtml]    TRUSTED: the door
 * @param {{ textIsHtml?: boolean, hostClass?: string, alias?: 'sb' }} [o]
 */
export function renderStatusLine(text, buttonHtml, o) {
  const opts = o && typeof o === 'object' ? o : {};
  const a = aliasOf(opts);
  return '<div class="' + cls('cur-status-line', a.status, opts.hostClass) + '">' +
      '<p class="' + cls('cur-status-line-text', a.statusText) + '">' +
        (opts.textIsHtml ? String(text == null ? '' : text) : escapeHtml(text)) + '</p>' +
      (typeof buttonHtml === 'string' ? buttonHtml : '') +
    '</div>';
}

/**
 * v3.90.0 — a SENTENCE with its buttons, in a fold body or a card: the text
 * wraps inside its card, the buttons wrap under it when the card is narrow.
 * `textHtml` and `actionHtml` are TRUSTED; `text` is escaped.
 * @param {{ text?: string, textHtml?: string, actionHtml?: string, quiet?: boolean }} o
 */
export function renderFoldLine(o) {
  const opts = o && typeof o === 'object' ? o : {};
  const text = typeof opts.textHtml === 'string' ? opts.textHtml : escapeHtml(opts.text);
  const acts = typeof opts.actionHtml === 'string' && opts.actionHtml ? opts.actionHtml : '';
  return '<div class="' + cls('cur-fold-line', opts.quiet ? 'cur-fold-line-quiet' : '') + '">' +
      '<p class="cur-fold-line-text">' + text + '</p>' +
      (acts ? '<span class="cur-fold-line-acts">' + acts + '</span>' : '') +
    '</div>';
}

/**
 * v3.90.0 — a page's one-line lede: the column's first block under the view
 * header (renderViewHeader keeps no prose slot — scripts/test-next-view-header.js).
 * @param {string} text  escaped
 */
export function renderPageLede(text) {
  return '<p class="cur-section-intro">' + escapeHtml(text) + '</p>';
}

/**
 * v3.90.0 — the page's closing line: one muted sentence after the last
 * section's card, a block of the column of its own (never inside a card).
 * @param {string} text  escaped
 */
export function renderPageFoot(text) {
  return '<p class="cur-section-foot">' + escapeHtml(text) + '</p>';
}
