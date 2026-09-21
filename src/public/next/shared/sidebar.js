// ═══════════════════════════════════════════════════════════════════════════
//  shared/sidebar.js — THE SIDEBAR, FOR ANY VIEW
// ═══════════════════════════════════════════════════════════════════════════
//
// A sidebar in this app is one thing: a title, at most two actions under it,
// and groups of rows you select from. Three views had three answers to that
// one sentence.
//
// ── WHY IT EXISTS ─────────────────────────────────────────────────────────
// Measured at a 1370px window, all three sidebars sit at `x=89 w=248` inside
// the same 272px rail column, and there the resemblance stopped:
//
//   Domains   title (no ⓘ) · a `btn-primary` and a `btn-secondary` stacked
//             under it · a KNOWLEDGE eyebrow · rows 63.8px tall carrying
//             identity dot, name, key figure, freshness mark, clock glyph,
//             age and a last-event line · active = the filled row.
//   Context   a view HEADER with an ⓘ · two `btn-ghost btn-xs` beside an
//             eyebrow · rows 56px tall with a SQUARE mark, the headline on
//             line two and the figure on line three · NO clock, no age glyph
//             · active = an accent tint.
//   Settings  a title · no actions at all (Updates sat in the footer) · rows
//             48.8px with a label and a mono hint · active = a filled row
//             PLUS a 2px × 32.75px violet bar drawn by `::before`.
//
// The maintainer's words: *"two middle menus, Domains and Context, in totally
// different designs — I also think different fonts ... I suggest we go with
// the Domains design, which is more polished ... It is extremely important
// that we unify the design between sections."* And on the third: *"The same
// goes for the Settings sidebar: follow the Domains pattern ... we don't need
// this line, it is a completely other design which got in during
// development."*
//
// So the DOMAINS sidebar is the reference design, it moved here unchanged in
// value, and the other two adopt it. What the Domains page gains is nothing
// visible at all, which is the acceptance test.
//
// ── THE CLASS NAMES, AND WHY THERE ARE TWO SETS ───────────────────────────
// The kit's own names are `cur-sb-*` and they carry EVERY rule
// (shared/sidebar.css). A host may additionally ask for its own historical
// tokens on the SAME elements with `alias: '<name>'` — the pattern
// shared/overview.js established with `alias: 'dm'`, and for the same reason:
// those strings are pinned BY NAME in shipped suites and are what each view's
// own listeners and stylesheets address.
//
// ALIASES is a THREE-ENTRY TABLE and it may only ever SHRINK. Each entry is
// a transition, not a feature: when a view's pins move to the kit's names,
// its entry is deleted. It is data — a frozen object, no behaviour — and it
// is the one place the transition is enumerated rather than three places
// discovering each other.
//
// ── THE IDENTITY DOT'S COLOUR IS THE HOST'S, AND THAT IS A MEASURED LIMIT ──
// `dotClass` is a class NAME, filtered to the class alphabet exactly as
// `toneClass` is in shared/overview.js. The six identity colours themselves
// CANNOT live in shared/sidebar.css: three of the six light-theme values are
// derived literals (`#16768C` / `#438126` / `#925E13` — there is no
// `--entity-700`), and scripts/test-next-design-kit.js §10 allows a colour
// literal in exactly TWO /next stylesheets and asserts that the baseline
// holds exactly two files. Putting them here would have meant widening an
// anti-drift ratchet to ship a kit, which is backwards.
//
// So the palette stays in views/domains.css, where it is already baselined
// and already measured (that file's `.dm-row-dot-N` block records the
// contrast arithmetic), and what moves here is the MAPPING — `identityDotClass`
// — so a second view can colour a dot without importing from another view.
// See its own docblock for what the adopting host must add.
//
// ── EVERY CALLER-SUPPLIED STRING IS ESCAPED, EXCEPT THREE NAMED FIELDS ────
// `markHtml` (a freshness dot the caller has already composed, the same
// contract `renderReadout` and `renderOverview` carry), `badgesHtml` (a
// host's trailing badges, which are host markup by construction) and
// `iconHtml` on a head button (the kit cannot import `icon()` — app.js
// touches `document` at import time, which would make this module
// un-importable in an offline suite). Everything else is escaped
// unconditionally. A class NAME is FILTERED to `[A-Za-z0-9_-]`, never
// escaped-and-hoped: an attribute value that can carry a quote is how a class
// slot becomes an attribute injection.

import { clockGlyph } from './age.js';

// ── escapeHtml ─────────────────────────────────────────────────────────────
// A byte-for-byte copy of app.js's, for the reason shared/text.js,
// shared/block.js and shared/overview.js each carry one: app.js touches
// `document` at import time and cannot be imported by a module that must stay
// executable in an offline suite. The equality is PINNED by
// scripts/test-next-sidebar-kit.js against shared/overview.js's copy rather
// than trusted.
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

/** Kit token plus an optional alias token, empties dropped — so an aliasless
 *  caller emits exactly the kit's own name and nothing else. */
function cls(kit, alias) {
  return alias ? kit + ' ' + alias : kit;
}

/** A trusted, pre-rendered fragment. A non-string is DROPPED rather than
 *  coerced, so the trust extends only to a caller that meant to pass one —
 *  the same `str()` discipline shared/text.js applies to `markHtml`. */
function trusted(v) {
  return typeof v === 'string' ? v : '';
}

// ═══════════════════════════════════════════════════════════════════════════
//  THE ALIAS TABLE — three entries, and it may only ever SHRINK
// ═══════════════════════════════════════════════════════════════════════════
//
// Keyed by the name a host passes as `alias`. Every value is a class the kit
// emits ALONGSIDE its own on that part. A missing key means the part carries
// the kit token alone, which is why Settings' rows need no `figure` or `age`
// entry — it renders neither.
//
// WHY EACH ENTRY EXISTS, so deleting one is an argument and not a guess:
//
//  dm        views/domains.js is the REFERENCE. `dm-row` is addressed by
//            `document.querySelectorAll('.dm-row[data-domain-slug]')` in that
//            view's own binder, and the nine tokens are pinned by name across
//            scripts/test-sidebar-status-rows.js, -next-domain-dots.js,
//            -next-domains-text.js, -next-domains-swr.js and
//            -next-existing-knowledge-folder.js.
//  mem       views/memory.js's `.mem-row` states are pinned by
//            scripts/test-next-views-kit.js §8 (`.mem-row:hover` must resolve
//            `--mat-row-hover`) and its rows are lifted by 47 sandboxes in
//            scripts/test-next-memory-view.js.
//  settings  `button.settings-nav-row` is FROZEN at 13.33px by
//            scripts/test-visual-contrast-math.js:243 and is one of two names
//            in scripts/test-next-press-motion.js's press-transform census.
//            Its `::before` selection bar is deleted in v3.65.0 (R10) — the
//            ROW class survives that deletion, which is why it is here.
//
// FROZEN so a caller cannot mutate the table at runtime and give one view
// another's tokens.
export const ALIASES = Object.freeze({
  dm: Object.freeze({
    list: 'dm-row-list', row: 'dm-row', dot: 'dm-row-dot', main: 'dm-row-main',
    name: 'dm-row-name', meta: 'dm-row-meta', figure: 'dm-row-figure',
    sep: 'dm-row-sep', age: 'dm-row-age', event: 'dm-row-event',
  }),
  mem: Object.freeze({
    list: 'mem-row-list', row: 'mem-row', dot: 'mem-row-mark', main: 'mem-row-main',
    name: 'mem-row-name', meta: 'mem-row-meta', event: 'mem-row-head',
  }),
  settings: Object.freeze({
    list: 'settings-nav-list', row: 'settings-nav-row',
    name: 'row-label', event: 'row-hint',
  }),
});

function aliasSet(alias) {
  const key = typeof alias === 'string' ? alias.trim() : '';
  return Object.prototype.hasOwnProperty.call(ALIASES, key) ? ALIASES[key] : null;
}

// ═══════════════════════════════════════════════════════════════════════════
//  THE IDENTITY PALETTE'S MAPPING
// ═══════════════════════════════════════════════════════════════════════════

/** Six slots, because views/domains.css declares six and their pairwise
 *  CIEDE2000 minimum (14.58 light / 16.14 dark, measured) is what keeps them
 *  tellable apart. A seventh would have to be derived and measured, not
 *  invented. */
export const IDENTITY_DOT_SLOTS = 6;

/**
 * index -> the class NAME that paints an identity dot.
 *
 * THIS FUNCTION IS THE WHOLE POINT OF EXPORTING IT: views/domains.js had the
 * only copy, and a second view may not import from a view. It returns the
 * KIT's name (`cur-sb-dot-N`), so an adopting view emits no foreign token.
 *
 * WHAT THE HOST OWES IT, and why it is not here: the six COLOURS are three
 * system tokens plus three derived light-theme literals, and
 * scripts/test-next-design-kit.js §10 permits a colour literal in exactly two
 * /next stylesheets — neither of them a shared one. views/domains.css already
 * declares all six, already carries the measured contrast argument for them,
 * and is already one of the two baselined files. So the adopting release adds
 * the kit's names to THAT rule's selector list:
 *
 *     .dm-row-dot-1, .cur-sb-dot-1 { background: var(--entity-500); }
 *     [data-theme="light"] .dm-row-dot-1,
 *     [data-theme="light"] .cur-sb-dot-1 { background: var(--dm-ink-entity); }
 *
 * — a selector-list addition: zero new literals, zero changed values, and
 * views/domains.js's own `domainDotClass` may then call this and drop its
 * copy. Recorded here because it is the one thing this module cannot do for
 * itself.
 */
export function identityDotClass(index) {
  const n = Number.isFinite(index) ? Math.abs(Math.trunc(index)) : 0;
  return 'cur-sb-dot-' + ((n % IDENTITY_DOT_SLOTS) + 1);
}

// ═══════════════════════════════════════════════════════════════════════════
//  THE HEAD — a title and at most two actions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ONE ACTION PAIR, AND THE SLOTS MEAN SOMETHING.
 *
 * The PRIMARY slot is "create the kind of thing this list holds" — New domain
 * on Domains, + New project on Context. The SECONDARY slot is the one
 * alternative route — Use existing folder on Domains, Refresh on Context,
 * Updates on Settings. A version string is not an action and does not go
 * here (R6); it stays at the sidebar's foot.
 *
 * NO ⓘ ON A SIDEBAR TITLE. Context had one, and its sentence is already said
 * by the main header's own mark on the same screen — *"we definitely don't
 * need it in this small section"*. The option is not offered rather than
 * offered and discouraged.
 *
 * THE CLASS LIST IS WRITTEN AS A LITERAL PREFIX on every `<button>`, and that
 * is a REQUIREMENT rather than a style: scripts/test-next-button-chrome.js
 * scans the SOURCE of every `<button … class="…">` in /next and fails any
 * whose tokens resolve no author border, because a bare `<button>` falls
 * through to Chromium's 2px outset UA bevel. `class="' + klass + '"` is,
 * to that scanner, a button with no readable class at all.
 *
 * @param {{
 *   title: string,
 *   primary?:   { label: string, id?: string, iconHtml?: string,
 *                 className?: string, disabled?: boolean },
 *   secondary?: { label: string, id?: string, iconHtml?: string,
 *                 className?: string, disabled?: boolean },
 * }} o  `iconHtml` is TRUSTED, pre-rendered markup (see the header).
 * @returns {string} HTML — '' when there is no title.
 */
export function renderSidebarHead(o) {
  const opts = o && typeof o === 'object' ? o : {};
  const title = typeof opts.title === 'string' ? opts.title.trim() : '';
  if (!title) return '';

  const action = (a, variant, kitClass) => {
    if (!a || typeof a !== 'object') return '';
    const label = typeof a.label === 'string' ? a.label : '';
    if (!label) return '';
    const extra = classList(a.className);
    const ico = trusted(a.iconHtml);
    return '<button type="button" class="btn ' + variant + ' ' + kitClass +
      (extra ? ' ' + extra : '') + '"' +
      (typeof a.id === 'string' && a.id ? ' id="' + escapeHtml(a.id) + '"' : '') +
      (a.disabled === true ? ' disabled' : '') + '>' +
      (ico ? ico + ' ' : '') + escapeHtml(label) +
    '</button>';
  };

  return '<div class="sidebar-title">' + escapeHtml(title) + '</div>' +
    action(opts.primary, 'btn-primary', 'cur-sb-primary') +
    action(opts.secondary, 'btn-secondary', 'cur-sb-secondary');
}

// ═══════════════════════════════════════════════════════════════════════════
//  THE GROUP — an eyebrow and the rows under it
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A HEADING, NOT A BUTTON. Selecting the group is not a thing any of these
 * three screens does: Domains' one group names what the list IS (KNOWLEDGE),
 * Context's names the domain a set of projects lives in, and a clickable
 * heading would either do nothing or invent a second selection model.
 *
 * The eyebrow's own uppercasing is `.cur-eyebrow`'s, from shell.css, so a
 * domain literally named `projects` reads as PROJECTS — which is correct and
 * is NOT the duplicate-word defect it was reported as (the other PROJECTS on
 * that screen is the actions eyebrow).
 *
 * `rowsHtml` is the output of renderSidebarRow, i.e. this module's own
 * markup, so it is not re-escaped.
 *
 * NO WRAPPER ELEMENT. The head and the list are SIBLINGS, which is the shape
 * views/domains.js already ships and the shape that keeps the head's spacing
 * expressible as `.cur-sb-group-head { margin-top }` — that spacing is an
 * INLINE `style="margin-top:10px"` on the reference today, the one thing in
 * that sidebar a stylesheet could not reach. A wrapper would also put a
 * second box between the rail's own column and the rows, which is where a
 * "why is there a gap here" defect comes from.
 *
 * @param {{ eyebrow?: string, rowsHtml: string, alias?: string, id?: string }} o
 * @returns {string} HTML — '' when there are no rows.
 */
export function renderSidebarGroup(o) {
  const opts = o && typeof o === 'object' ? o : {};
  const rowsHtml = typeof opts.rowsHtml === 'string' ? opts.rowsHtml : '';
  // NO ROWS, NO GROUP — the readout kit's rule one level up. An eyebrow over
  // nothing is a caption for an empty box, which reads as a failure.
  if (!rowsHtml) return '';
  const a = aliasSet(opts.alias);
  const eyebrow = typeof opts.eyebrow === 'string' ? opts.eyebrow.trim() : '';
  return (eyebrow
      ? '<div class="cur-sb-group-head cur-eyebrow">' + escapeHtml(eyebrow) + '</div>'
      : '') +
    '<div class="' + cls('cur-sb-list', a && a.list) + '"' +
      (typeof opts.id === 'string' && opts.id ? ' id="' + escapeHtml(opts.id) + '"' : '') +
    '>' + rowsHtml + '</div>';
}

// ═══════════════════════════════════════════════════════════════════════════
//  THE ROW
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ONE ROW, SIX SLOTS, EVERY ONE OPTIONAL EXCEPT THE NAME.
 *
 *   identity dot · name · figure · freshness mark · clock glyph + age
 *                                                 · last-event line
 *
 * That is the Domains anatomy and the order is the reference order. The
 * Context rows have to MOVE their headline: it sat on line two, above the
 * figure, and it is a last-event line, so it goes to line three where
 * Domains' "Ingested · <title>" already sits. Settings renders the name and
 * the hint only, and the hint is the same slot.
 *
 * ACTIVE IS THE FILLED ROW, NEVER A LEFT LINE (R10). The `active` flag adds
 * the state class and nothing else; shared/sidebar.css paints it with the
 * `--mat-row-active` alpha overlay, because an opaque fill on the translucent
 * sidebar plane stops the blur for the width of the row and reads as a hole
 * punched in it (scripts/test-next-views-kit.js §8's rule).
 *
 * THE CLOCK GLYPH IS EMITTED BY THE KIT, not passed in. It repeats the words
 * beside it and carries `aria-hidden`, and a host that had to supply it would
 * be a host that could forget it — which is exactly the difference the
 * maintainer named between the two sidebars (*"it has clocks showing when it
 * was changed; in Context we don't have that"*).
 *
 * THE ABSOLUTE DATE IS VISUALLY HIDDEN, NOT A `title=`. A `title=` is
 * hover-only and therefore invisible to keyboard and to touch;
 * scripts/test-next-title-affordances.js caps hover-only affordances per file
 * and this component adds none.
 *
 * @param {{
 *   name: string,
 *   dotClass?: string,     // a class NAME (see identityDotClass); '' = no dot
 *   figure?: string,       // the key count — "3,428 pages", "18 scopes"
 *   markHtml?: string,     // TRUSTED — the freshness dot
 *   age?: string,          // "3 days ago"; the clock glyph rides with it
 *   ageFallback?: string,  // what the age slot says when `age` is empty
 *   ageExact?: string,     // the absolute date, visually hidden beside it
 *   clock?: boolean,       // default true whenever an age line renders
 *   event?: string,        // line three — the last event, or the headline
 *   active?: boolean,
 *   stateClass?: string,   // one extra host state class (e.g. a quiet row)
 *   badgesHtml?: string,   // TRUSTED — trailing badges, after the main block
 *   ariaCurrent?: boolean,
 *   ariaLabel?: string,    // overrides the accessible name when the visible
 *                          // one is not the whole of it
 *   alias?: string,
 *   data?: Object,         // data-* attributes, keys filtered, values escaped
 * }} o
 * @returns {string} HTML — '' when there is no name.
 */
export function renderSidebarRow(o) {
  const opts = o && typeof o === 'object' ? o : {};
  const name = typeof opts.name === 'string' ? opts.name : '';
  // NO NAME, NO ROW. A row whose label is empty is a control a user cannot
  // name, aim at or hear announced.
  if (!name) return '';

  const a = aliasSet(opts.alias);
  const dot = classList(opts.dotClass);
  const figure = typeof opts.figure === 'string' ? opts.figure.trim() : '';
  const mark = trusted(opts.markHtml);
  const age = typeof opts.age === 'string' ? opts.age.trim() : '';
  const ageFallback = typeof opts.ageFallback === 'string' ? opts.ageFallback.trim() : '';
  const ageText = age || ageFallback;
  const event = typeof opts.event === 'string' ? opts.event.trim() : '';
  const stateClass = classList(opts.stateClass);

  // The meta line renders only when it has something in it. A row with a name
  // and nothing else (Settings, before its hint) must not paint an empty
  // 11px line under the label and open a gap the design did not ask for.
  const wantsMeta = !!(figure || mark || ageText);
  const wantsClock = wantsMeta && !!ageText && opts.clock !== false;

  const data = [];
  if (opts.data && typeof opts.data === 'object') {
    for (const [k, v] of Object.entries(opts.data)) {
      // The KEY is a filtered name, not an escaped string: a key that can
      // carry a quote or a space is a second attribute.
      if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(k) || v == null) continue;
      data.push(' data-' + k + '="' + escapeHtml(String(v)) + '"');
    }
  }

  const meta = wantsMeta
    ? '<span class="' + cls('cur-sb-meta', a && a.meta) + '">' +
        (figure
          ? '<span class="' + cls('cur-sb-figure', a && a.figure) + '">' +
              escapeHtml(figure) + '</span>'
          : '') +
        // The separator renders ONLY between two things. It is aria-hidden:
        // it is punctuation, and a screen reader announcing "middle dot"
        // between every figure and every age is noise.
        (figure && (mark || ageText)
          ? '<span class="' + cls('cur-sb-sep', a && a.sep) + '" aria-hidden="true">·</span>'
          : '') +
        mark +
        (wantsClock ? clockGlyph(12) : '') +
        (ageText
          ? '<span class="' + cls('cur-sb-age', a && a.age) + '">' + escapeHtml(ageText) + '</span>'
          : '') +
        (typeof opts.ageExact === 'string' && opts.ageExact
          ? '<span class="visually-hidden"> (' + escapeHtml(opts.ageExact) + ')</span>'
          : '') +
      '</span>'
    : '';

  // THE CLASS LIST OPENS WITH A LITERAL, not with `cls(...)`, and that is a
  // REQUIREMENT rather than a style: scripts/test-next-button-chrome.js reads
  // the SOURCE of every `<button … class="…">` in /next and resolves its
  // tokens against every /next stylesheet, because a <button> whose class
  // list receives no author `border` falls through to Chromium's 2px OUTSET
  // UA bevel — the "button with some sort of shadow" report. A class
  // attribute assembled entirely from a call yields that scanner NO tokens at
  // all, and it SKIPS the occurrence rather than failing it, so the check
  // silently stops covering this button.
  return '<button type="button" class="cur-sb-row' +
      (a && a.row ? ' ' + a.row : '') +
      (opts.active === true ? ' active' : '') + (stateClass ? ' ' + stateClass : '') + '"' +
      data.join('') +
      (opts.ariaCurrent === true ? ' aria-current="true"' : '') +
      (typeof opts.ariaLabel === 'string' && opts.ariaLabel
        ? ' aria-label="' + escapeHtml(opts.ariaLabel) + '"' : '') + '>' +
    (dot ? '<span class="' + cls('cur-sb-dot', a && a.dot) + ' ' + dot + '"></span>' : '') +
    '<span class="' + cls('cur-sb-main', a && a.main) + '">' +
      '<span class="' + cls('cur-sb-name', a && a.name) + '">' + escapeHtml(name) + '</span>' +
      meta +
      (event
        ? '<span class="' + cls('cur-sb-event', a && a.event) + '">' + escapeHtml(event) + '</span>'
        : '') +
    '</span>' +
    trusted(opts.badgesHtml) +
  '</button>';
}
