/**
 * shared/model-row.js — THE ONE BODY of a model row (v3.72.0, P4).
 *
 * Two surfaces describe a model to someone choosing one for CHAT: the
 * composer's Model menu (a shared-listbox `[role="option"]`, which owns the
 * row element, the keyboard and the ARIA) and the browse dialog (a plain
 * `<button>` per row, with the star as a sibling). Both take their body from
 * `modelRowBodyHtml` here, so the price, the promotion and the facts cannot
 * say two different things about one model on two lists the user compares
 * across — two hand-kept descriptions of one fact is this repo's named cause
 * of the v3.2.0 CRITICAL.
 *
 * ── THE ROW IS THE APP'S TYPE HIERARCHY, NOT A BADGE STRIP ────────────────
 * The maintainer's report (2026-09-25, point 4): the list was dense and did
 * not look like the rest of the app. It now reads like a sidebar row:
 *
 *   line 1  the model's name (--text-md, medium, --text)     price, right
 *   line 2  provider · default · thinks · 1M context   (--text-2xs, --text-2)
 *   line 3  only while a promotion is live: [promo] until <day>, then $x / $y
 *
 * The browse dialog, which a user opened ON PURPOSE to compare, adds the
 * model id (mono), the full thinking clause, the exact context size and — the
 * one place it appears in Chat — what our INGEST tests found, labelled as
 * such (see `ingestNoteText`).
 *
 * ── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────
 *   • "caution", "out-performed" and the ingest speed. They are verdicts about
 *     BUILDING THE WIKI (a ~300,000-character outline call), not about a chat
 *     turn. Chat's own header comment already removed the chat-only badge for
 *     this reason ("there is no ingest decision on this screen"). They stay in
 *     Settings, where the decision is an ingest one. The browse dialog keeps
 *     the reason text, labelled with what it measured.
 *   • A coloured provider dot. The old dots re-used the page-type hues
 *     (Gemini = entity cyan, Anthropic = concept green), so one hue meant two
 *     things on one screen (DESIGN.md M-c). The provider is a WORD.
 *   • Any price, date or promotion typed here. Every figure is read off the
 *     catalogue entry llm.js serves (`input`/`output` are its promotion-
 *     resolved getters; `standardInput`/`standardOutput`/`promotionUntilIso`/
 *     `standardPriceFromIso` its own fields). This module formats; it never
 *     knows a price.
 *
 * DOM-free and import-free, so an offline suite imports it directly.
 */

/**
 * Escaper, local on purpose: this module must import nothing so a Node suite
 * can load it without a DOM or the shell (sidebar.js makes the same choice).
 * Same contract as the shell's `escapeHtml`.
 */
function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The provider as a WORD, the same word Settings → Providers & keys uses for
 * the key that pays for it. Null-prototype, and read with `Object.hasOwn`, so
 * a payload string such as `__proto__` is simply an unknown provider and is
 * shown as its own (escaped) text.
 */
export const PROVIDER_WORDS = Object.freeze(Object.assign(Object.create(null), {
  gemini: 'Gemini',
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
}));

export function providerWord(provider) {
  if (typeof provider !== 'string' || !provider) return '';
  return Object.hasOwn(PROVIDER_WORDS, provider) ? PROVIDER_WORDS[provider] : provider;
}

/**
 * A price per 1M tokens, EXACT — or null for anything that is not a finite,
 * non-negative number. Never a placeholder 0.
 *
 * At least two decimals (so a column of prices lines up: `$2.00`, `$0.10`),
 * and as many more as the catalogue's figure needs, up to six. The previous
 * composer rounded to cents, so GLM 5.3 Flash's $0.075 read "$0.08" and
 * Granite's $0.017 read "$0.02" — a 7% and 18% misstatement of a price on the
 * one surface whose job is saying what a model costs.
 */
export function formatPricePerM(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  for (let d = 2; d <= 6; d++) {
    const s = n.toFixed(d);
    if (Math.abs(Number(s) - n) < 1e-12) return '$' + s;
  }
  return '$' + n.toFixed(6);
}

/**
 * The price column, as one of THREE different facts that must never collapse:
 *   { kind: 'free' }    — llm.js reports this model bills nothing
 *                         (`entry.free === true`; its prices are null BY DESIGN)
 *   { kind: 'paid', text: '$0.10 / $0.40' } — input / output per 1M, live
 *   { kind: 'unknown' } — the catalogue did not tell us; "price unavailable"
 * Free is decided by the flag alone — never a price of 0, never a provider,
 * never a ":free" id suffix (llm.js's FREE_MODELS docblock says why).
 */
export function priceFact(entry) {
  if (entry && entry.free === true) return { kind: 'free', text: 'free' };
  const inp = formatPricePerM(entry && entry.input);
  const out = formatPricePerM(entry && entry.output);
  if (inp === null || out === null) return { kind: 'unknown', text: 'price unavailable' };
  return { kind: 'paid', text: inp + ' / ' + out };
}

/**
 * '2027-01-01' -> '1 Jan 2027', from the ISO components — never through
 * `new Date(iso)`, which reads UTC midnight and, west of Greenwich, would say
 * a price changes the day before it does. Unparseable input comes back as-is.
 */
export function formatIsoDay(iso) {
  if (typeof iso !== 'string') return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return iso;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const mi = Number(m[2]) - 1;
  if (mi < 0 || mi > 11) return iso;
  return String(Number(m[3])) + ' ' + MONTHS[mi] + ' ' + m[1];
}

/**
 * The live promotion as one line of words, or '' when there is none.
 *
 * SUPPRESSED ONLY ON POSITIVE EVIDENCE OF EXPIRY: `promotionUntilIso` stays on
 * the entry after the promotion ends, when llm.js's getters already return the
 * standing price — so all four figures present and equal means "over". If any
 * figure is missing we cannot tell, and the fail-safe on money is to say a rise
 * is coming (v3.9.0's rule).
 *
 * Worded from the promotion's LAST day ("until 31 Dec 2026, then $x / $y");
 * `standardPriceFromIso` is added only when it is not simply the next day.
 */
export function promotionText(entry) {
  if (!entry || typeof entry.promotionUntilIso !== 'string' || !entry.promotionUntilIso) return '';
  const known = typeof entry.input === 'number' && typeof entry.standardInput === 'number' &&
    typeof entry.output === 'number' && typeof entry.standardOutput === 'number';
  if (known && entry.input === entry.standardInput && entry.output === entry.standardOutput) return '';
  const until = formatIsoDay(entry.promotionUntilIso);
  const inp = formatPricePerM(entry.standardInput);
  const out = formatPricePerM(entry.standardOutput);
  if (inp === null || out === null) return 'until ' + until + ', then the price rises';
  // "until 31 Dec 2026, then $1.50 / $7.50" already says the new price
  // starts the next day; the standard-price day is added only when llm.js
  // records a DIFFERENT one (a gap between the two), never as a repeat.
  const fromIso = typeof entry.standardPriceFromIso === 'string' ? entry.standardPriceFromIso : '';
  const from = fromIso && fromIso !== nextIsoDay(entry.promotionUntilIso)
    ? ' from ' + formatIsoDay(fromIso) : '';
  return 'until ' + until + ', then ' + inp + ' / ' + out + from;
}

/** '2026-12-31' -> '2027-01-01' (calendar arithmetic in UTC, zone-proof); '' if unparseable. */
function nextIsoDay(iso) {
  const m = typeof iso === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim()) : null;
  if (!m) return '';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1));
  return d.toISOString().slice(0, 10);
}

/**
 * A context window in the vendor's own units: 1,048,576 -> '1M', 524,288 ->
 * '512K', 200,000 -> '200K', 131,000 -> '131K'. A power-of-two size is named
 * in binary units (that is how the vendor names it — Google's "1M context" is
 * 1,048,576), anything else in decimal. '' when the catalogue has no size;
 * the browse dialog carries the exact count.
 */
export function contextWords(n) {
  if (!Number.isInteger(n) || n <= 0) return '';
  const binary = n % 1024 === 0;
  const M = binary ? 1048576 : 1000000;
  const K = binary ? 1024 : 1000;
  const fmt = (v) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10));
  if (n >= M) return fmt(n / M) + 'M';
  if (n >= K) return fmt(Math.round((n / K) * 10) / 10) + 'K';
  return String(n);
}

/** 1048576 -> '1,048,576'. */
function groupDigits(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * The meta line's parts, in order. Each is a fact that holds for a CHAT turn:
 *   provider — whose key pays;
 *   default  — the model a question uses when nothing is picked (the build
 *              model: a model-less chat turn is answered by it);
 *   thinks   — hidden reasoning billed as OUTPUT, which a chat turn pays too;
 *   context  — the catalogue's own `contextLength`.
 * `detailed` (the browse dialog) spells the last two out in full.
 */
export function metaParts(provider, entry, o) {
  const opts = o || {};
  const parts = [];
  const pw = providerWord(provider);
  if (pw) parts.push(pw);
  if (opts.isDefault === true) parts.push('default');
  if (entry && entry.thinks === true) {
    parts.push(opts.detailed ? 'thinks — reasoning billed as output' : 'thinks');
  }
  const ctx = entry ? entry.contextLength : null;
  if (Number.isInteger(ctx) && ctx > 0) {
    parts.push(opts.detailed ? groupDigits(ctx) + '-token context' : contextWords(ctx) + ' context');
  }
  return parts;
}

/**
 * What our INGEST testing found, labelled as such — or '' for a model we have
 * nothing to say about. Browse dialog only.
 *
 * `summary` is shared/model-summary.js's compact line (its first clause is
 * `cautionReason`, then the ingest-call speed, itself worded "per ingest call
 * in our testing"). Every one of those facts was measured on — or is a verdict
 * about — BUILDING THE WIKI, so the line says that before it says anything.
 */
export function ingestNoteText(summary) {
  const s = typeof summary === 'string' ? summary.trim() : '';
  return s ? 'For building the wiki: ' + s : '';
}

/**
 * THE BODY of one model row — everything inside the row element, none of its
 * wrapper. Every interpolated value is escaped.
 *
 * @param {string} provider  the provider that serves this row
 * @param {object} entry     the catalogue entry, verbatim from the server
 * @param {object} [o]
 *   o.surface  'menu' (default) or 'browse'
 *   o.isDefault  true when this row is the model a question uses with no pick
 *   o.summary  browse only: model-summary.js's compact line for this entry
 */
export function modelRowBodyHtml(provider, entry, o) {
  const opts = o || {};
  const e = entry && typeof entry === 'object' ? entry : {};
  const browse = opts.surface === 'browse';
  const name = (typeof e.label === 'string' && e.label) ? e.label : (e.id || '');
  const price = priceFact(e);
  const priceHtml = price.kind === 'free'
    ? '<span class="mr-price"><span class="tx-badge tx-badge-success mr-badge">free</span></span>'
    : '<span class="mr-price' + (price.kind === 'unknown' ? ' is-unknown' : '') + '">' +
        esc(price.text) +
        (price.kind === 'paid' ? '<span class="visually-hidden"> per 1M tokens, input / output</span>' : '') +
      '</span>';
  const meta = metaParts(provider, e, { isDefault: opts.isDefault === true, detailed: browse });
  const metaHtml = meta.length
    ? '<span class="mr-meta">' +
        meta.map(esc).join('<span class="mr-sep" aria-hidden="true"> · </span>') +
      '</span>'
    : '';
  const promo = promotionText(e);
  const promoHtml = promo
    ? '<span class="mr-promo"><span class="tx-badge tx-badge-attention mr-badge">promo</span>' +
        '<span>' + esc(promo) + '</span></span>'
    : '';
  // The id: at rest in the menu it would be noise beside a name, so it goes to
  // the row's accessible name there and on screen in the browse dialog.
  const idHtml = browse
    ? '<span class="mr-id mono">' + esc(e.id || '') + '</span>'
    : '';
  const srId = !browse && e.id && e.id !== name ? '<span class="visually-hidden">, ' + esc(e.id) + '</span>' : '';
  const note = browse ? ingestNoteText(opts.summary) : '';
  const noteHtml = note ? '<span class="mr-note">' + esc(note) + '</span>' : '';
  return (
    '<span class="mr-body' + (browse ? ' is-browse' : '') + '">' +
      '<span class="mr-title">' + esc(name) + srId + '</span>' +
      priceHtml +
      idHtml +
      metaHtml +
      promoHtml +
      noteHtml +
    '</span>'
  );
}

/**
 * The menu's one foot line: the unit (so no row has to repeat it), where the
 * choice is kept, and — only when the server gave one — the OpenRouter
 * catalogue's own sync stamp. Gemini and Anthropic prices are shipped with
 * the app and carry no date on the wire, so no date is claimed for them.
 *
 * @param {{syncedAt?: string|null}} [o]
 */
export function modelMenuFootHtml(o) {
  const opts = o || {};
  const parts = ['Prices per 1M tokens, input / output', 'remembered on this computer across chats'];
  const day = syncedDay(opts.syncedAt);
  if (day) parts.push('OpenRouter catalogue synced ' + day);
  return '<p class="mr-foot">' + parts.map(esc).join(' · ') + '</p>';
}

/** An ISO instant -> '30 Aug 2026' in the viewer's zone, or '' if unusable. */
export function syncedDay(iso) {
  if (typeof iso !== 'string' || !iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear();
}
