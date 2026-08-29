/**
 * ── THE TEXT SYSTEM: FIVE ROLES, ONE VOCABULARY ─────────────────────────────
 *
 * The first shared component in /next that renders TEXT. Six others exist —
 * confirm, listbox, progress-ring, loading-gate, markdown, ingest-queue-logic —
 * and not one of them puts a sentence on screen, so every view has been
 * inventing its own. Measured over src/public/next/**.css before this file
 * existed: 744 rules carry a text treatment, 84 of them on 81 DISTINCT class
 * names ending -desc/-hint/-note/-body/-lede/-sub, resolving to 93 distinct
 * (size, colour, weight) combinations — against a design system that defines
 * 13 sizes and 4 text colours.
 *
 * That is not untidiness. It is a semantic failure with a name:
 *
 *     THE APP RENDERS A MEASUREMENT AND AN EXPLANATION IN THE SAME VOICE.
 *
 * A measurement is computed from the user's own wiki and is the more valuable
 * of the two; an explanation is static copy that is identical for every user
 * and is read once. Three observed consequences, each a real screen:
 *
 *   • `.view-body` carries FOUR unrelated meanings — a static description
 *     (domains.js:1347), a GENERATED scan sentence (domains.js:1396's
 *     `dm-scope-desc`), a loading placeholder (loading-gate.js:220), and an
 *     empty state (chat.js:2111). The live figure therefore reads as a
 *     subtitle.
 *   • `.sidebar-hint` renders both a marketing sentence (sync.js:312) and a
 *     RUNTIME ERROR (domains.js:1244), separated only by a colour modifier.
 *   • domains.js:1879-1882 welds THREE semantic roles into ONE <div>: an
 *     action report ("Re-scanning… showing the previous result."), a generated
 *     readout ("Found 12 issues, last scanned 10s ago") and a static feature
 *     description ("Structural repairs run locally and free…").
 *
 * The five roles below are the vocabulary those sites are missing. They are
 * distinguished by SIZE, WEIGHT and FAMILY — not by dimming, for a measured
 * reason recorded under CONTRAST.
 *
 * ── WHY A SHARED MODULE, AND WHY IT OWNS THE MARKUP ─────────────────────────
 *
 * format-usd.js is the precedent: one module, every view imports it, and a
 * suite asserts no view has re-grown a local copy. Two hand-maintained copies
 * of one fact is this repo's named cause of the v3.2.0 CRITICAL.
 *
 * This module goes one step further than format-usd.js: it returns HTML, not
 * plain text, and it escapes internally. That is a deliberate departure and it
 * is the whole point. If it returned plain text, every call site would keep
 * writing its own `<div class="…">` wrapper and the 81 class names would grow
 * back immediately — the module would standardise vocabulary while leaving
 * TREATMENT fragmented, which is the actual defect. Owning the element means
 * owning the class, which means owning the escaping.
 *
 * ── WHY IT HAS NO IMPORTS ───────────────────────────────────────────────────
 *
 * app.js exports `escapeHtml`, and shared/listbox.js imports it from there. It
 * is copied here instead, which needs justifying because copying an escaper is
 * exactly the shape above.
 *
 * MEASURED, not assumed: `node -e "import('./app.js')"` throws
 * `ReferenceError: document is not defined` — app.js touches `document` at
 * module scope. So does anything importing it: importing shared/listbox.js in
 * Node fails identically, which is why v3.18.0 records its keyboard contract
 * as resting on SOURCE SCANS. A source scan is the decorative-guard shape this
 * repo has shipped repeatedly.
 *
 * This module must be EXECUTABLE in an offline suite, so it takes no imports at
 * all. The duplication is not left on trust: test-next-text-system.js extracts
 * app.js's `escapeHtml` by brace-match and asserts both implementations agree
 * over a corpus, so a change to either side goes red naming the input — the
 * same technique v3.8.0 used to prove the lifted markdown renderer was
 * byte-identical. The right long-term fix is a shared escape module both sides
 * import; that requires editing app.js and is recorded for the adoption wave.
 *
 * ── CONTRAST: MEASURED, AND TWO FINDINGS CHANGED THE DESIGN ─────────────────
 *
 * Ratios below are computed from tokens/color.css with var() chains resolved
 * and rgba tints composited over their surface, in BOTH themes. (The first run
 * of that tool reported dark and light as IDENTICAL, because
 * `[data-theme="light"]` also appears in color.css's header COMMENT and a bare
 * indexOf returned the :root block twice. Identical columns are impossible, so
 * the tool was wrong and was fixed. Numbers here are from the fixed tool.)
 *
 *   --text    on --surface        16.71 dark / 18.27 light   AA
 *   --text-2  on --surface         8.34 dark /  7.26 light   AA
 *   --text-3  on --surface         4.27 dark /  4.14 light   FAILS AA (4.5)
 *   --text-faint on --surface      2.26 dark /  2.34 light   FAILS
 *
 * FINDING 1 — `--text-3` is under the AA floor for normal text in BOTH themes,
 * and 181 rules in /next currently use it as a text colour. No role here uses
 * it. Hierarchy therefore comes from size, weight and family; the system's own
 * fourth text colour is not usable for prose, so dimming is not available as a
 * hierarchy device and this file does not pretend otherwise.
 *
 * FINDING 2 — UNBRIEFED, and it stopped a precedent being propagated intact.
 * `.model-badge-flag` (settings.css:939) sets `--attention-text` as TEXT on
 * `--attention-tint`. Measured: 9.11 dark but **3.21 light** — failing AA for
 * text, at --text-2xs (10px), which is nowhere near the large-text exemption.
 * The same holds for `--success-text` (8.73 / 3.59) and on every tint in the
 * palette (3.13–3.63 light, across four tints).
 *
 * So the badge here keeps the precedent's REASONING and changes its execution:
 * the status colour still carries the meaning, but as the 1px BORDER and the
 * background tint — non-text, whose floor is 3:1, which they clear in both
 * themes (attention 10.70/3.58, success 10.07/4.05 against --surface-raised) —
 * while the LABEL sits at `--text`, measured 13.81–16.39 across all four tints
 * in both themes. Nothing is decoded by colour alone in either case, which is
 * what color.css's own header already requires: "Status color always ships
 * with an icon or label, never as color alone."
 *
 * FINDING 3 — elevation is 1.03:1 dark and **1.00:1 light**: `--surface-raised`
 * is byte-identical to `--surface` in the light theme. A "raised" card is
 * therefore invisible in light unless it is also bordered. Every boxed role
 * here carries `border: 1px solid var(--border)` for that reason, not for
 * decoration.
 *
 * ── ABSENT IS NOT ZERO ──────────────────────────────────────────────────────
 *
 * Inherited verbatim from model-summary.js and it is the most load-bearing rule
 * in this file. A field that was not supplied is OMITTED. A readout with no
 * provenance renders no provenance line — never "never scanned", never "—",
 * never a zero — because those state a measurement nobody took. Every role has
 * a mutation test for it.
 *
 * ── ORDER IS A PRIORITY ORDER ───────────────────────────────────────────────
 *
 * Also inherited: the warning comes first, everywhere it can appear. A user
 * scanning a screen reads from the top and stops early.
 *
 * ── OUTPUT ─────────────────────────────────────────────────────────────────
 *
 * Every function returns an HTML string with all interpolated values escaped,
 * or '' when there is nothing to render — so a caller can concatenate
 * unconditionally without emitting an empty element.
 */

// ── escapeHtml ──────────────────────────────────────────────────────────────
// A byte-for-byte copy of app.js:1728. See "WHY IT HAS NO IMPORTS" above for
// why it is copied rather than imported, and how the equality is pinned rather
// than trusted. Do not "improve" this independently: the suite compares it
// against app.js's copy over a corpus and will go red naming the input.
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * A usable string, or null. Whitespace-only is null: it is a field nobody
 * filled in, and rendering it produces an empty element with padding — a
 * visible artefact claiming there is something to read.
 */
function str(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

/**
 * The four tones, and the ONE place the set is defined.
 *
 * 'neutral' is the default and is not a failure state: most things on screen
 * are ordinary. An unrecognised tone falls back to neutral rather than
 * throwing — a view passing a typo should render a plain, correct element, not
 * take the mount down. It fails toward "no claim", which is the safe direction
 * for a component whose job is stating what is true.
 */
const TONES = ['neutral', 'success', 'attention', 'danger'];
function tone(v) {
  return TONES.indexOf(v) > 0 ? v : 'neutral';
}

// ── 1. READOUT ──────────────────────────────────────────────────────────────

/**
 * A value computed from the user's own data, or produced by an action.
 *
 * THE HEADLINE ROLE. It must read as an INSTRUMENT, not a sentence, because
 * these are the most valuable strings in the app and they are currently
 * rendered in the same voice as static marketing copy. Three parts, three
 * treatments:
 *
 *   label       what was measured        sans, --text-2, small
 *   value       THE FIGURE               mono, --text, medium weight
 *   provenance  when/how it was taken    mono, --text-2, --text-xs
 *
 * Mono for the figure and the stamp is the design system's own rule, not a
 * preference: typography.css says IBM Plex Mono owns "counts, versions,
 * tokens, timestamps" and that "the mono/sans split IS the brand voice".
 *
 * PROVENANCE IS AT --text-2, NOT --text-3, even though it is the quietest part.
 * --text-3 measures 4.27/4.14 and the AA floor is 4.5 (see CONTRAST above), so
 * the quiet step is made with SIZE and FAMILY instead of with dimming. This is
 * the single most-copied mistake in the existing tree — 181 rules — and it is
 * not reproduced here.
 *
 * THERE IS DELIBERATELY NO `tone`. Colouring a number is a JUDGEMENT about the
 * number, and judgement is renderStatus's role. Keeping them separate also
 * keeps this element clear of the light-theme text-contrast trap that
 * FINDING 2 records, because it never renders a status colour as text.
 *
 * NO VALUE, NO READOUT. `value` is the only required field: an instrument with
 * nothing to display is not a quiet instrument, it is a lie about there being a
 * reading. Returns ''.
 *
 * @param {{label?:string, value:string|number, provenance?:string}} o
 * @returns {string} HTML, or '' when there is no value
 */
export function renderReadout(o) {
  if (!o || typeof o !== 'object') return '';
  const value = typeof o.value === 'number' && Number.isFinite(o.value)
    ? String(o.value)
    : str(o.value);
  if (value === null) return '';
  const label = str(o.label);
  const prov = str(o.provenance);
  return (
    '<div class="tx-readout">' +
      (label ? '<span class="tx-readout-label">' + escapeHtml(label) + '</span>' : '') +
      '<span class="tx-readout-value">' + escapeHtml(value) + '</span>' +
      (prov ? '<span class="tx-readout-prov">' + escapeHtml(prov) + '</span>' : '') +
    '</div>'
  );
}

/**
 * Several readouts as one instrument cluster — the Wiki-health counts case,
 * where "Found 12 issues" and "last scanned 10s ago" are currently one prose
 * sentence welded to a static description.
 *
 * Entries that render nothing are dropped, and a group with nothing left
 * returns '' rather than an empty container. Same rule as a single readout:
 * no reading, no instrument.
 *
 * @param {Array} items
 * @returns {string}
 */
export function renderReadoutGroup(items) {
  if (!Array.isArray(items)) return '';
  const html = items.map(renderReadout).filter(Boolean).join('');
  return html ? '<div class="tx-readout-group">' + html + '</div>' : '';
}

// ── 2. DESCRIPTION ──────────────────────────────────────────────────────────

/**
 * Static prose explaining what a thing IS. ONE treatment, replacing the many.
 *
 * This is the role that must be BORING. It is identical for every user, it is
 * read once, and it is currently competing for attention with live figures — in
 * `.view-body` it is literally the same class as one. Body-sized sans at
 * --text-2 (8.34 dark / 7.26 light), one width limit, nothing else.
 *
 * `html: true` is for the handful of existing strings carrying inline <span
 * class="mono"> or <strong> — settings.js:1709 and ingest.js:651 both do. It
 * is opt-in and the caller then owns escaping, which is stated here rather
 * than discovered later. It is NOT the default, so the ordinary call is safe.
 *
 * @param {string} text
 * @param {{html?:boolean}} [opts]
 * @returns {string}
 */
export function renderDescription(text, opts) {
  const t = str(text);
  if (t === null) return '';
  const raw = !!(opts && opts.html);
  return '<p class="tx-desc">' + (raw ? t : escapeHtml(t)) + '</p>';
}

// ── 3. STATUS ───────────────────────────────────────────────────────────────

/**
 * State, encoded WITHOUT a sentence.
 *
 * Adopted from `.build-current` (settings.css:1241-1256), which the maintainer
 * singled out as working: a raised, bordered box with a 3px left rail whose
 * colour is the whole message. Its own comment records the reasoning this
 * inherits — a refused pin is amber because it IS a finding, while "no pin" is
 * neutral because it is the ordinary first-run case "and must not be dressed as
 * a problem". That distinction is why 'neutral' is the default here.
 *
 * The rail is a BORDER, so its colour is non-text and its floor is 3:1, which
 * success (10.07/4.05) and attention (10.70/3.58) clear in both themes — where
 * the same tokens used as TEXT would fail light (FINDING 2). The title and
 * detail carry --text and --text-2, both AA in both themes, so the state is
 * never decoded from colour alone.
 *
 * KNOWN LIMIT, recorded not hidden: the 'neutral' rail uses --border-strong,
 * measured 1.54 dark / 1.64 light against --surface-raised — below the 3:1
 * non-text floor. It is kept because it is inherited from the precedent and
 * because the neutral state's meaning is precisely "nothing to report", so a
 * near-invisible rail under-states nothing. It is called out in the suite's
 * NOT ENFORCED block rather than quietly propagated as if it passed.
 *
 * @param {{state?:string, title:string, detail?:string}} o
 * @returns {string}
 */
export function renderStatus(o) {
  if (!o || typeof o !== 'object') return '';
  const title = str(o.title);
  if (title === null) return '';
  const t = tone(o.state);
  const detail = str(o.detail);
  return (
    '<div class="tx-status tx-status-' + t + '" role="group">' +
      '<div class="tx-status-title">' + escapeHtml(title) + '</div>' +
      (detail ? '<div class="tx-status-detail">' + escapeHtml(detail) + '</div>' : '') +
    '</div>'
  );
}

// ── 4. BADGE ────────────────────────────────────────────────────────────────

/**
 * A one-or-two-word flag on a row.
 *
 * Adopted from `.model-badge-*` (settings.css:923-939) INCLUDING the reasoning
 * in its comment at :932, which is the valuable part: every flag is one colour
 * on purpose, because `chat only`, `caution` and `out-performed` are different
 * findings but the same instruction to the reader, "and three colours would
 * invite ranking them against each other". That property is preserved — a
 * caller choosing a tone chooses an INSTRUCTION, not a severity rank.
 *
 * Execution differs from the precedent for a measured reason: see FINDING 2.
 * The tint and the 1px border carry the tone (non-text, 3:1, clears in both
 * themes); the LABEL is --text, measured 13.81-16.39 across all four tints in
 * both themes, where the precedent's --attention-text label measures 3.21 in
 * light and fails AA.
 *
 * @param {{label:string, tone?:string}} o
 * @returns {string}
 */
export function renderBadge(o) {
  if (!o || typeof o !== 'object') return '';
  const label = str(o.label);
  if (label === null) return '';
  return '<span class="tx-badge tx-badge-' + tone(o.tone) + '">' + escapeHtml(label) + '</span>';
}

// ── 5. EXPLAINER ────────────────────────────────────────────────────────────

/**
 * Prose that should not be on screen by default.
 *
 * Generalised from memory.js:1479's `renderAbout()`, which uses a native
 * <details>: keyboard operation and screen-reader announcement come free, and
 * it defaults CLOSED because the content is "needed once, then never again".
 * Both properties are kept.
 *
 * ── HOW HIDING A WARNING WAS MADE STRUCTURALLY AWKWARD ──────────────────────
 *
 * v3.16.1's rule is that a warning behind a click is not a warning, and it
 * cost a release to learn: a measured `cautionReason` was collapsed into a
 * disclosure on 199 of 206 rows. The rule has to survive contact with a
 * component whose entire job is hiding text.
 *
 * A wordlist that scans `body` for warning-ish language was rejected: it is a
 * lint, it is defeated by paraphrase, and a guard that can be walked past
 * teaches people to walk past it.
 *
 * What is done instead is structural, and it follows v3.13.0's answer to the
 * <summary> hazard — that release removed a click-propagation bug by making
 * the propagation PATH not exist, rather than by suppressing it, so no later
 * edit could drop the suppression. Here:
 *
 *   THERE IS NO PARAMETER THAT PLACES TEXT INSIDE THE FOLD WITH A TONE.
 *
 * `body` is prose and takes no tone. A caller holding something that warns has
 * exactly one field for it — `warning` — and that field renders a
 * renderStatus box BEFORE the <details> element, outside it, unfolded, always.
 * The wrong call therefore produces the RIGHT output: an author who reaches for
 * the explainer to tuck a warning away gets it displayed. Making the mistake
 * inexpressible beats forbidding it.
 *
 * The suite asserts the warning's index precedes the '<details' index in the
 * returned string, and that the warning survives with `open` false — i.e. it is
 * not merely rendered but rendered OUTSIDE the collapsed region. A mutation
 * moving it inside goes red for that reason.
 *
 * @param {{summary:string, body:string, warning?:string, warningTone?:string,
 *          open?:boolean, id?:string, html?:boolean}} o
 * @returns {string}
 */
export function renderExplainer(o) {
  if (!o || typeof o !== 'object') return '';
  const summary = str(o.summary);
  const body = str(o.body);
  if (summary === null || body === null) return '';
  const raw = !!o.html;
  // FIRST, ALWAYS, AND OUTSIDE THE <details>. Defaults to 'attention' rather
  // than 'neutral': a caller reaching for a field named `warning` is telling us
  // something needs attention, and the neutral default of `tone()` would
  // silently downgrade it to the ordinary case.
  const warning = str(o.warning)
    ? renderStatus({ state: tone(o.warningTone) === 'neutral' ? 'attention' : o.warningTone,
                     title: o.warning })
    : '';
  const id = str(o.id);
  return (
    warning +
    '<details class="tx-explainer"' +
      (id ? ' data-tx-explainer="' + escapeHtml(id) + '"' : '') +
      (o.open === true ? ' open' : '') + '>' +
      '<summary class="tx-explainer-summary">' + escapeHtml(summary) + '</summary>' +
      '<div class="tx-explainer-body">' + (raw ? body : escapeHtml(body)) + '</div>' +
    '</details>'
  );
}
