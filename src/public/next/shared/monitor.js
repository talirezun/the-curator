// ═══════════════════════════════════════════════════════════════════════════
//  shared/monitor.js — THE MONITOR: every live-state reading in the app
// ═══════════════════════════════════════════════════════════════════════════
//
// A MONITOR is an instrument you go and READ. It shows data that is changing
// — what was saved and when, what the bridge is connected to, how many pages
// a domain holds, when a scan last ran — and it is deliberately drawn so that
// a reader can tell at a glance that this block is a live reading and not
// prose, not a card of links, not a form.
//
// ── WHY IT EXISTS ─────────────────────────────────────────────────────────
// The maintainer, with three screenshots in front of him: *"these active-state
// cards, which are throughout the app — I think I found them all. These cards
// show specific data, the data that is changing, and my idea was to make this
// similar to a CLI, a terminal kind of data input or output, so it has a
// distinguished design so people can immediately see what's going on — but
// this must be in colour of course, equipped with the colour dots based on
// time ... All these three cards show something different but the design could
// be the same ... we are looking for a unified design AND a distinguished
// design."*
//
// It is not a fourth treatment. It REPLACES three, and the evidence that they
// were already one pattern is that two of them are hand copies of each other:
//
//   views/settings.js:8673-8677   `.settings-status-card` > a status pill +
//                                 `<code class="mono mcp-path-line">`
//   views/sync.js:582-588         `.sync-status-card` > `.sync-status-top` >
//                                 the IDENTICAL pill + `<code class="mono
//                                 sync-repo">` + `.sync-last`
//
// plus `renderReadout` / `renderReadoutGroup` standing alone as a block (the
// Knowledge readouts, the health counts) and the bespoke `.mem-capture` block.
// Two hand copies of one pattern is the definition this project has used since
// v3.55.0.
//
// ── WHY IT DOES NOT CALL renderReadout, WHICH THE CONTRACT RECOMMENDED ────
// Two measured obstacles, either one sufficient:
//
//  1. `.tx-readout` is a COLUMN — `flex-direction: column`, label ABOVE value
//     (shared/text.css:78-83). The monitor's binding anatomy is key LEFT,
//     value RIGHT, on one line, which is what makes a stack of them read as a
//     terminal rather than as a row of stat tiles.
//  2. A container cannot re-lay-out that child from here:
//     scripts/test-next-text-system.js §8 fails ANY /next stylesheet other
//     than shared/text.css that declares a rule matching `.tx-[a-z]`, and it
//     proves that guard by planting a REAL FILE, not only a string. So
//     `.cur-mon-line .tx-readout { flex-direction: row }` is not available.
//
// The remaining route would have been to change `renderReadout`'s own markup,
// and v3.65.0's contract forbids exactly that, for a good reason: changing the
// container and the line in one release is how a shared kit change becomes
// unreviewable. So the monitor emits its OWN line, `renderReadout` keeps its
// name, its contract and its ten call sites, and a later release may retire
// one in favour of the other with a single diff to review.
//
// ── THE RULES THIS COMPONENT CARRIES ──────────────────────────────────────
// · ONE FACT PER LINE. `key` left in --text-2, `value` right in --text with
//   tabular figures, an optional qualifying `sub` under the value.
// · THE APP'S FRESHNESS DOT, not a second one. A time-based reading takes a
//   `.fresh-dot` through the TRUSTED `markHtml` field, with the age IN WORDS
//   beside it — never a dot alone. shared/freshness.css owns the `.fresh-`
//   prefix and scripts/test-freshness-scale.js §4 forbids a kit or view
//   stylesheet declaring one, so shared/monitor.css declares NONE.
// · COLOUR ONLY WHERE THE READING CARRIES STATE. `tone` is one of
//   ok | warn | danger | quiet, and it is a class NAME the kit owns —
//   FILTERED, never escaped-and-hoped.
// · v3.16.1, UNMOVED: a warning, a cost or an outcome is never behind a
//   chevron. Inside a monitor those are `loud` entries: rendered OUTSIDE the
//   line list, always, in colour, and there is no parameter that puts one
//   inside. This component emits no `<details>` at all.
// · A MONITOR IS NEVER NUMBERED and never carries a section title. It is the
//   instrument inside the thing that names it — a step, a fold row's body, a
//   block. The heading rule belongs to its host.
//
// ── EVERY CALLER-SUPPLIED STRING IS ESCAPED, EXCEPT ONE NAMED FIELD ───────
// `markHtml` is TRUSTED, pre-rendered HTML — the same contract, spelled the
// same way, that `renderReadout`, `renderInfoMark` and `renderOverview` carry.
// `strongText` on a loud entry is NOT trusted: it is escaped and wrapped in
// `<strong>` by this module, because the one producer of it (the stale-bridge
// remedy sentence) is a ROUTE PAYLOAD and a route payload is data.

// ── escapeHtml ─────────────────────────────────────────────────────────────
// A byte-for-byte copy of app.js's, for the reason shared/text.js,
// shared/overview.js and shared/sidebar.js each carry one: app.js touches
// `document` at import time and cannot be imported by a module that must stay
// executable in an offline suite. The equality is PINNED by
// scripts/test-next-monitor-kit.js rather than trusted.
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ═══════════════════════════════════════════════════════════════════════════
//  TONE — the app's FOURTH visual channel, and its ONE alphabet (v3.66.0)
// ═══════════════════════════════════════════════════════════════════════════
//
// TONE says how an OUTCOME went — ok · warn · danger · quiet — and it is drawn
// only as a MARK: a state dot beside a word, a gutter rule on a line or a loud
// entry, a glyph, a 1px border, or a depth bar's danger fill. The words stay
// in --text / --text-2. Tone never names a domain (that is the identity dot),
// never encodes time (the freshness dot), and is never the only carrier: the
// outcome is always also in words. The one carve-out is a DESTRUCTIVE
// CONTROL's label (`.btn-danger` and its kin), which is an action affordance,
// not a reading. scripts/test-tone-channel.js is the census that holds it.
//
// Until v3.66.0 the app had five tone vocabularies — this component's four
// words, the progress ring's success/attention/accent, renderStatus's
// `state`, confirm's `tone:'danger'` and Shared Brain's outcomes. These are
// now the words; `normalizeTone` maps the older spellings onto them so a
// caller migrates without a flag day, and a word it does not know is NOT a
// tone (null), never a guess.

/** The one outcome alphabet, in order of severity. */
export const TONE_WORDS = Object.freeze(['ok', 'warn', 'danger', 'quiet']);

/** The four tones the KIT owns, word -> this component's class. A caller's
 *  `tone` is looked up here rather than interpolated: an unknown word yields
 *  NO class, so the line renders in the default ink instead of carrying an
 *  attribute the caller composed. Exported so every other surface that
 *  paints an outcome reads ONE table. */
export const TONES = Object.freeze({
  ok: 'cur-mon-ok',
  warn: 'cur-mon-warn',
  danger: 'cur-mon-danger',
  quiet: 'cur-mon-quiet',
});

/** Older spellings of the same four outcomes, as the app's other surfaces
 *  wrote them before v3.66.0. Own-property lookup only, so `__proto__` and
 *  `constructor` are not tones. */
const TONE_ALIASES = Object.freeze({
  success: 'ok',
  attention: 'warn',
  error: 'danger',
  neutral: 'quiet',
  info: 'quiet',
  default: 'quiet',
});

/**
 * Any tone spelling -> one of TONE_WORDS, or null when the word is not an
 * outcome at all (e.g. the ring's `busy`/`accent`, which are "in progress").
 * @param {unknown} t
 * @returns {'ok'|'warn'|'danger'|'quiet'|null}
 */
export function normalizeTone(t) {
  if (typeof t !== 'string') return null;
  if (Object.prototype.hasOwnProperty.call(TONES, t)) return t;
  if (Object.prototype.hasOwnProperty.call(TONE_ALIASES, t)) return TONE_ALIASES[t];
  return null;
}

function toneClass(t) {
  return typeof t === 'string' && Object.prototype.hasOwnProperty.call(TONES, t)
    ? TONES[t] : '';
}

/** A trusted, pre-rendered fragment. A non-string is DROPPED rather than
 *  coerced, so the trust extends only to a caller that meant to pass one. */
function trusted(v) {
  return typeof v === 'string' ? v : '';
}

/** A displayable scalar, or null. A number is rendered; an object, an array
 *  or a function is DROPPED rather than stringified into `[object Object]`. */
function scalar(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
//  THE DEPTH BAR — the app's THIRD visual channel (v3.65.1)
// ═══════════════════════════════════════════════════════════════════════════
//
// The maintainer's proposal, from an exchange order book: a tinted bar behind
// each row's value, right-anchored, its length proportional to that row's
// magnitude. Agreed, with one rule attached, which is what this comment is
// for — because the value of a third channel is entirely in never confusing
// it with the two the app already has:
//
//   | channel      | glyph                  | answers         | owner               |
//   |--------------|------------------------|-----------------|---------------------|
//   | TIME         | the freshness dot      | how old         | shared/freshness.css|
//   | WHICH DOMAIN | the identity dot       | whose           | shared/sidebar.css  |
//   | SIZE / SHARE | the DEPTH BAR          | how much, of what| shared/depth-bar.css|
//
// · IT NEVER ENCODES TIME. No bar in the journal, the handoffs list, a
//   `lastIngest` line or any age. The dot owns age, and a bar whose length
//   was an age would be a second ladder wearing the first's meaning — the
//   same mistake `renderCaptureMeter`'s own note refuses for its mark.
// · IT NEVER APPEARS IN A `<summary>` OR A SIDEBAR ROW. Both are one line of
//   text read at a glance; a background there competes with the row's own
//   active fill (`--mat-row-active`) and with the identity dot beside it.
// · IT LIVES INSIDE MONITORS AND TABLES, where there is a numeric column to
//   anchor to.
// · ITS DENOMINATOR IS STATED, NEVER IMPLIED: `value ÷ budget` where a budget
//   exists, otherwise `value ÷ max(visible rows)`. A bar whose denominator the
//   reader cannot name is decoration, so `label` is a visually-hidden sentence
//   naming it and the host prints the same fact in words nearby.
// · A COST IS NEVER ONLY A COLOUR (v3.16.1). Wherever a bar takes the danger
//   tone, the same fact is also on screen in words, unfolded.
//
// ── ITS PUBLIC ADDRESS IS shared/depth-bar.js (v3.66.0) ───────────────────
// v3.65.1 recorded that a module of its own is correct "the moment a third
// host outside a monitor appears". v3.66.0 has four (the Documents table, the
// Handoffs table, the Chat footer, the Ingest panel), so hosts import
// `renderDepthCell` — and the identity tone, `depthIdentityClass` — from
// shared/depth-bar.js. The FUNCTION still lives here, and that is a measured
// constraint, not a preference: scripts/test-next-foundations-editor.js pins
// this file to ZERO import statements (the proof that the add panel's second
// allowed import stays DOM-free), and `renderMonitor` below calls
// `renderDepthCell` for a line's `depth`, which it could not do through an
// import. So depth-bar.js re-exports from here. Flipping the direction is a
// one-line move of that pin (allow `./depth-bar.js`, itself import-free
// apart from the palette), and every caller keeps its address either way.

/** The class alphabet a tone may use. A NAME is filtered, never escaped and
 *  hoped — shared/overview.js's rule, and the reason is that an escaped class
 *  attribute is still an attribute the caller composed. */
function depthTone(t) {
  return typeof t === 'string' && /^[A-Za-z0-9_-]+$/.test(t) ? t : '';
}

/**
 * ONE FIGURE, WITH ITS SHARE DRAWN BEHIND IT.
 *
 * @param {{
 *   value: string|number,   // the figure to PRINT (escaped; a non-scalar is dropped)
 *   amount?: number,        // the figure to MEASURE, when it is not `value` itself
 *                           //   (e.g. value "62 KB", amount 63488)
 *   max?: number,           // the denominator when there is no budget
 *   budget?: number,        // optional; REPLACES max as the denominator
 *   toneClass?: string,     // a class NAME, filtered to [A-Za-z0-9_-]
 *   label?: string,         // the visually-hidden sentence naming the denominator
 * }} o
 * @returns {string} HTML — the value alone, with NO bar, when the denominator
 *   is absent, zero or not finite, or when the amount is not a finite number.
 */
export function renderDepthCell(o) {
  const opts = o && typeof o === 'object' ? o : {};
  const printed = scalar(opts.value);
  if (printed === null) return '';
  const amount = Number.isFinite(opts.amount) ? opts.amount
    : (typeof opts.value === 'number' && Number.isFinite(opts.value) ? opts.value : null);
  const budget = Number.isFinite(opts.budget) && opts.budget > 0 ? opts.budget : null;
  const max = Number.isFinite(opts.max) && opts.max > 0 ? opts.max : null;
  const denom = budget !== null ? budget : max;

  const valueHtml = '<span class="cur-depth-value">' + escapeHtml(printed) + '</span>';
  // NO DENOMINATOR, NO BAR. A bar drawn against nothing is decoration, and a
  // zero-width one reads as "none of it" rather than as "unknown".
  if (denom === null || amount === null || amount < 0) return valueHtml;

  // CLAMPED TO [0, 100] and rounded to one decimal, so a value over its budget
  // FILLS the cell rather than overflowing it. `budget` present AND
  // `amount > budget` is the ONLY condition that may set the danger tone by
  // itself: an over-run against a stated budget is a fact, while being the
  // largest of a set of visible rows is not.
  const pct = Math.min(100, Math.max(0, Math.round((amount / denom) * 1000) / 10));
  const over = budget !== null && amount > budget;
  const tone = depthTone(opts.toneClass) || (over ? 'cur-depth-danger' : '');
  const label = typeof opts.label === 'string' && opts.label.trim() ? opts.label.trim() : '';

  // `width` IS AN INLINE STYLE, and it is the one place this component writes
  // one — unavoidable, because the length IS the data. It is a number this
  // function computed from two numbers it validated; a caller's string never
  // reaches it.
  return '<span class="cur-depth">' +
    '<span class="cur-depth-bar' + (tone ? ' ' + tone : '') + '"' +
      ' style="width:' + pct + '%" aria-hidden="true"></span>' +
    valueHtml +
    (label ? '<span class="visually-hidden"> ' + escapeHtml(label) + '</span>' : '') +
  '</span>';
}

/**
 * ONE MONITOR.
 *
 * @param {{
 *   id?: string,                     // a patch target for the host
 *   head?: { stateWord: string,      // 'Connected', 'Fresh', 'Not set up'
 *            tone?: 'ok'|'warn'|'danger'|'quiet' },
 *   lines: Array<{
 *     key: string,                   // the mono caption, left
 *     value: string|number,          // the reading, right
 *     markHtml?: string,             // TRUSTED — a .fresh-dot, before the value
 *     tone?: 'ok'|'warn'|'danger'|'quiet',  // IGNORED when markHtml is set
 *     sub?: string,                  // one qualifying clause under the value
 *     depth?: {                      // DATA, never markup — the SHARE behind
 *       amount?: number, max?: number, budget?: number,
 *       toneClass?: string, label?: string,
 *     },                             //   the figure; see renderDepthCell
 *   }>,
 *   loud?: Array<{ tone?: 'ok'|'warn'|'danger'|'quiet',
 *                  text: string, strongText?: string }>,
 *   note?: string,                   // the producer's own sentence, verbatim
 *   label?: string,                  // the block's accessible name
 * }} o
 * @returns {string} HTML — '' when there is no line, no loud entry and no note.
 */
export function renderMonitor(o) {
  const opts = o && typeof o === 'object' ? o : {};

  const lines = (Array.isArray(opts.lines) ? opts.lines : []).filter(
    (l) => l && typeof l === 'object' && typeof l.key === 'string' && l.key
      && scalar(l.value) !== null);

  // A LOUD ENTRY IS NEVER A LINE, and the separation is structural rather
  // than a convention: they are built from a different array, rendered into a
  // different container, and there is no field on a line that can make one
  // loud. scripts/test-next-monitor-kit.js §4 drives a fixture carrying both
  // and asserts every loud text falls OUTSIDE the line list; the mutation
  // that appends `loud` onto `lines` reds it.
  const loud = (Array.isArray(opts.loud) ? opts.loud : []).filter(
    (w) => w && typeof w === 'object' && typeof w.text === 'string' && w.text);

  const note = typeof opts.note === 'string' ? opts.note.trim() : '';
  const head = opts.head && typeof opts.head === 'object'
    && typeof opts.head.stateWord === 'string' && opts.head.stateWord.trim()
    ? opts.head : null;

  // NO READING, NO INSTRUMENT — the readout kit's own rule. An empty bordered
  // box captioned as a monitor says "this broke", which is worse than saying
  // nothing. A head ALONE is not a monitor either: a state word with nothing
  // under it is a pill, and the app already has one of those.
  if (!lines.length && !loud.length && !note) return '';

  const headHtml = head
    ? '<div class="cur-mon-head">' +
        '<span class="cur-mon-state' +
          (toneClass(head.tone) ? ' ' + toneClass(head.tone) : '') + '">' +
          '<span class="cur-mon-state-dot" aria-hidden="true"></span>' +
          escapeHtml(head.stateWord.trim()) +
        '</span>' +
      '</div>'
    : '';

  const lineHtml = lines.length
    ? '<div class="cur-mon-lines">' + lines.map((l) => {
        // A LINE CARRIES A FRESHNESS MARK OR A TONE, NEVER BOTH (v3.66.0).
        // Tone and time share inks — ok is teal like fresh-hot, warn is amber
        // like fresh-mid — and they are told apart by POSITION: the freshness
        // dot sits before an age, the tone is the line's gutter rule. A line
        // with both would put a teal dot beside a teal rule and ask the reader
        // which one is the time. The mark wins because it is the reading's own
        // qualifier; a caller that needs an outcome says it in a `loud` entry.
        const mark = trusted(l.markHtml);
        const tone = mark ? '' : toneClass(l.tone);
        const sub = typeof l.sub === 'string' ? l.sub.trim() : '';
        // ── A LINE MAY CARRY ITS SHARE (v3.65.1) ──────────────────────
        // `depth` is DATA — `{amount, max, budget, label, toneClass}` — and
        // the component draws the bar from it. It is deliberately NOT a
        // second trusted HTML field: a caller that could hand over markup for
        // the VALUE would be a caller that could hand over anything, and the
        // one trusted field on this component (`markHtml`) is the whole of
        // what its escaping discipline has to reason about. `renderDepthCell`
        // escapes the figure itself and computes the width from two numbers
        // it validated.
        const depth = l.depth && typeof l.depth === 'object' ? l.depth : null;
        const figure = depth
          ? renderDepthCell({ ...depth, value: scalar(l.value) })
          : escapeHtml(scalar(l.value));
        return '<div class="cur-mon-line' + (tone ? ' ' + tone : '') + '">' +
          '<span class="cur-mon-key">' + escapeHtml(l.key) + '</span>' +
          // The mark rides INSIDE the value, before the figure, so the dot
          // sits beside the reading it qualifies rather than floating in a
          // column of its own — the placement `renderReadout` already uses.
          '<span class="cur-mon-value">' + mark + figure + '</span>' +
          (sub ? '<span class="cur-mon-sub">' + escapeHtml(sub) + '</span>' : '') +
        '</div>';
      }).join('') + '</div>'
    : '';

  // `role="status"` on the loud block, not on the monitor: the readings change
  // on every paint and announcing all of them would make the screen unusable
  // with a screen reader, while a warning or an outcome appearing IS the thing
  // a user needs told. The default tone is `warn` — a loud entry with no tone
  // is still not ordinary text.
  const loudHtml = loud.map((w) => {
    const tone = toneClass(w.tone) || TONES.warn;
    const strongText = typeof w.strongText === 'string' ? w.strongText.trim() : '';
    return '<div class="cur-mon-loud ' + tone + '" role="status">' +
      escapeHtml(w.text) +
      // ESCAPED, NOT TRUSTED. The one producer of this field is a route
      // payload (the stale-bridge remedy sentence), and a payload is data.
      (strongText ? ' <strong>' + escapeHtml(strongText) + '</strong>' : '') +
    '</div>';
  }).join('');

  const noteHtml = note
    ? '<div class="cur-mon-note">' + escapeHtml(note) + '</div>'
    : '';

  const id = typeof opts.id === 'string' && opts.id ? opts.id.trim() : '';
  const label = typeof opts.label === 'string' && opts.label.trim()
    ? opts.label.trim() : '';
  return '<div class="cur-mon"' +
      (id ? ' id="' + escapeHtml(id) + '"' : '') +
      (label ? ' role="group" aria-label="' + escapeHtml(label) + '"' : '') + '>' +
    headHtml + lineHtml + loudHtml + noteHtml +
  '</div>';
}
