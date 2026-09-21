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

/** The four tones the KIT owns. A caller's `tone` is looked up here rather
 *  than interpolated: an unknown word yields NO class, so the line renders in
 *  the default ink instead of carrying an attribute the caller composed. */
const TONES = Object.freeze({
  ok: 'cur-mon-ok',
  warn: 'cur-mon-warn',
  danger: 'cur-mon-danger',
  quiet: 'cur-mon-quiet',
});

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
 *     tone?: 'ok'|'warn'|'danger'|'quiet',
 *     sub?: string,                  // one qualifying clause under the value
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
        const tone = toneClass(l.tone);
        const sub = typeof l.sub === 'string' ? l.sub.trim() : '';
        return '<div class="cur-mon-line' + (tone ? ' ' + tone : '') + '">' +
          '<span class="cur-mon-key">' + escapeHtml(l.key) + '</span>' +
          // The mark rides INSIDE the value, before the figure, so the dot
          // sits beside the reading it qualifies rather than floating in a
          // column of its own — the placement `renderReadout` already uses.
          '<span class="cur-mon-value">' + trusted(l.markHtml) +
            escapeHtml(scalar(l.value)) + '</span>' +
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
