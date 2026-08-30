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

// ── 6. VIEW HEADER ──────────────────────────────────────────────────────────

/**
 * The top of a view: EYEBROW + TITLE + an INFO AFFORDANCE. Nothing else.
 *
 * ── THE DEFECT THIS EXISTS TO REMOVE ────────────────────────────────────────
 *
 * Every view in /next put a paragraph of static prose directly under its <h1>.
 * The maintainer has raised it repeatedly — "text floating around", "truly bad
 * UX" — and v3.20.0 did NOT fix it. That release built renderDescription and
 * adopted it in these very headers, which changed the WORDING and kept the
 * defect: on Domains the line went from a generated sentence to a static one,
 * in the same position, still a paragraph under a title.
 *
 * THE CONTAINER WAS THE PROBLEM, NOT THE WORDING. So this component owns the
 * whole header and there is NO PARAMETER THAT PUTS PROSE UNDER THE TITLE.
 * `info` is the only prose field and it renders inside a panel that is `hidden`
 * on first paint. An author who reaches for this component to add a subtitle
 * finds no field for one. That is the same technique renderExplainer uses for
 * `warning` — the wrong call produces the right output — and the same technique
 * v3.13.0 used for the <summary> hazard: remove the PATH, not the symptom.
 *
 * ── WHY AN ICON AND NOT A COLLAPSED STRIP ───────────────────────────────────
 *
 * renderExplainer already hides prose, and was NOT reused here: its <summary>
 * is a row of text ("About this view"), so adopting it would replace one line
 * of prose under the title with another line of prose under the title. The
 * affordance has to be a MARK, not a sentence. This is the macOS convention —
 * Finder, System Settings and Mail put the explanation behind a control.
 *
 * ── THE AFFORDANCE IS A REAL CONTROL ────────────────────────────────────────
 *
 * A <button>, not `title=` on a <span>. v3.20.0 recorded 11 pieces of
 * information in this app carried ONLY by a hover tooltip — invisible to
 * keyboard and to touch — and this must not become the twelfth. So: focusable,
 * Enter/Space operable for free because it is a real button, aria-expanded
 * reflecting state, aria-controls naming the panel, an accessible name, and
 * Escape closes it and returns focus to the button.
 *
 * ── WHY THE PANEL IS IN FLOW AND NOT A FLOATING POPOVER ─────────────────────
 *
 * A floating popover is the more Apple-like shape and was rejected on risk: it
 * needs positioning, overflow and z-index handling against a shell that already
 * has a fixed rail, a scrolling `.main` and a reader overlay. The native
 * `popover` attribute would give dismissal and top-layer for free, but its
 * NO-SUPPORT FALLBACK IS AN ALWAYS-VISIBLE DIV — i.e. exactly the defect being
 * removed, restored silently on any engine that does not implement it. An
 * in-flow panel fails in the safe direction and cannot be clipped. It is also
 * the house pattern: memory.js's renderAbout() is an in-flow <details>.
 *
 * ── LISTENERS ARE DELEGATED, ONCE, AT MODULE SCOPE ──────────────────────────
 *
 * Views call one render function and bind nothing. A per-view bind step is an
 * adoption bug waiting to happen — a view that forgets it ships a dead button —
 * and repeated binds are how listeners stack across re-mounts (the hazard
 * ingest.js and chat.js both guard by hand). One document-level handler, added
 * once, guarded on `typeof document` so this module still imports in Node.
 *
 * ── ACTIONS ARE CONTROLS, AND THAT IS ENFORCED ──────────────────────────────
 *
 * `actionsHtml` is the one caller-supplied HTML slot (Domains needs Rename /
 * Delete / Ask this domain beside its title). It is the only way prose could
 * re-enter the header, so prose passed there is DROPPED rather than rendered:
 * a <p>, or a known prose class, and the slot renders nothing. Narrow by
 * construction — it cannot catch a bare <div> of prose — so it is a floor, not
 * a proof, and the suite says so in its NOT ENFORCED block.
 *
 * ── WHAT MUST NEVER GO IN `info` ────────────────────────────────────────────
 *
 * Warnings, costs, spend figures, irreversibility notices. v3.16.1's rule is
 * that a warning behind a click is not a warning. There is deliberately no
 * `warningTone` or `state` field here: a header carrying something that warns
 * renders renderStatus BESIDE it, in the body, where it is unfoldable — see
 * views/domains.js, whose read-only-mirror notice ("changes made here are
 * overwritten on the next Pull") is a status box for exactly this reason and
 * was NOT put behind the icon.
 *
 * ── TWO DENSITIES, ONE VOCABULARY ──────────────────────────────────────────
 *
 * `variant: 'sidebar'` renders the title as a <div class="sidebar-title">
 * rather than an <h1>, because the sidebar sits BESIDE the main region and a
 * second <h1> on one screen is a document-outline error, not a style choice.
 * Everything else — the mark, the panel, the delegated behaviour — is the same
 * component, so the two surfaces cannot drift into two answers about where
 * explanatory prose lives. This mirrors the deliberate Settings/composer split
 * v3.16.1 recorded: different density, same vocabulary.
 *
 * Because that pattern puts two headers of the same view — and usually the same
 * TITLE — on one screen, THE VARIANT IS PART OF THE DERIVED PANEL ID. Deriving
 * from the title alone shipped duplicate DOM ids on Sync and made one panel
 * permanently unreachable; the reasoning is at the derivation itself.
 *
 * @param {{eyebrow?:string, title:string, info?:string, infoHtml?:boolean,
 *          infoId?:string, actionsHtml?:string, variant?:string}} o
 *   `infoId` overrides the derived panel id. It is needed only when the title
 *   is DYNAMIC (views/domains.js renders a domain's own name, which could be
 *   the literal word "Domains"); the sidebar-vs-main case derives correctly on
 *   its own and no longer needs one.
 * @returns {string} HTML, or '' when there is no title
 */
export function renderViewHeader(o) {
  if (!o || typeof o !== 'object') return '';
  const title = str(o.title);
  if (title === null) return '';
  const eyebrowText = str(o.eyebrow);
  const info = str(o.info);
  const actions = safeActions(o.actionsHtml);
  const sidebar = o.variant === 'sidebar';
  // THE VARIANT IS PART OF THE ID, AND THAT IS THE FIX FOR A MEASURED BUG.
  // See "TWO DENSITIES, ONE VOCABULARY" above: this component actively invites
  // a sidebar header and a main header of the SAME view — and therefore very
  // often the same TITLE — to sit on one screen. Deriving the panel id from the
  // title alone made that blessed call pattern emit DUPLICATE DOM ids, and
  // `document.getElementById` returns the first in document order: measured on
  // Sync, clicking the MAIN header's mark opened the SIDEBAR's panel (243x58,
  // hidden=false) while the main panel stayed hidden with a 0x0 rect. Its prose
  // — the git-recovery route, the one sentence a user needs when something has
  // gone wrong — existed in the DOM and could not be reached by anyone.
  // `aria-controls` was ambiguous too, so AT was routed to the wrong panel.
  //
  // `infoId` already existed as an escape hatch and TWO adopters had reached for
  // it by hand (domains.js, ingest.js). The third forgot, and every one of the
  // 120 offline suites stayed green — including this component's own, which
  // asserts the OVERRIDE WORKS but never that an adopter uses it. That is the
  // v3.20.0 shape verbatim: a guard that proves a mechanism exists proves
  // nothing about adoption. So the collision is removed by CONSTRUCTION rather
  // than by remembering, which is v3.22.0's rule (make wrong output
  // inexpressible) and v3.13.0's (remove the PATH, not the symptom).
  //
  // The MAIN variant's id is deliberately BYTE-IDENTICAL to before — only a
  // sidebar header moves. That keeps the blast radius to the two sidebar
  // headers that carry `info` at all, one of which already overrides to exactly
  // the string this now derives. RESIDUAL, stated rather than implied away: two
  // headers sharing BOTH title and variant in one view still collide. Nothing
  // renders that today, and it is covered by the class scan in
  // scripts/test-next-view-header.js §4b rather than assumed away.
  const panelId = str(o.infoId) ||
    ('tx-vh-info-' + slugForId(title) + (sidebar ? '-sidebar' : ''));
  const btnId = panelId + '-btn';
  const name = 'About ' + title;

  return (
    '<header class="tx-vh' + (sidebar ? ' tx-vh-sidebar' : '') + '">' +
      (eyebrowText
        ? '<div class="view-eyebrow cur-eyebrow tx-vh-eyebrow">' + escapeHtml(eyebrowText) + '</div>'
        : '') +
      '<div class="tx-vh-row">' +
        (sidebar
          ? '<div class="sidebar-title tx-vh-title">' + escapeHtml(title) + '</div>'
          : '<h1 class="view-title tx-vh-title">' + escapeHtml(title) + '</h1>') +
        (info
          ? '<button type="button" class="tx-vh-info" id="' + escapeHtml(btnId) + '"' +
              ' data-tx-info="' + escapeHtml(panelId) + '"' +
              ' aria-expanded="false" aria-controls="' + escapeHtml(panelId) + '"' +
              ' aria-label="' + escapeHtml(name) + '" title="' + escapeHtml(name) + '">' +
              INFO_GLYPH +
            '</button>'
          : '') +
        (actions ? '<div class="tx-vh-actions">' + actions + '</div>' : '') +
      '</div>' +
      (info
        ? '<div class="tx-vh-panel" id="' + escapeHtml(panelId) + '" role="group"' +
            ' aria-label="' + escapeHtml(name) + '" hidden>' +
            (o.infoHtml === true ? info : escapeHtml(info)) +
          '</div>'
        : '') +
    '</header>'
  );
}

/**
 * The circled-i, inlined.
 *
 * app.js's icon() cannot be imported — this module takes no imports so it stays
 * executable in an offline suite (see "WHY IT HAS NO IMPORTS" above) — and
 * app.js's ICON_BODY has no `info` entry to import anyway; the nearest is
 * `alertCircle`, which means something else. Same geometry contract as icon():
 * 24-unit viewBox, currentColor stroke, 1.7 width, aria-hidden.
 */
const INFO_GLYPH =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>';

/** A stable DOM id fragment. Non-ASCII titles collapse rather than emit junk. */
function slugForId(title) {
  const s = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'view';
}

/**
 * The actions slot accepts CONTROLS. Prose is dropped, not rendered.
 *
 * This is the only caller-supplied HTML in the header, so it is the only way
 * the paragraph-under-the-title could return. Rather than documenting a rule
 * nobody reads, the wrong call produces the right output.
 *
 * NARROW BY CONSTRUCTION, and stated rather than implied away: it matches a <p>
 * and the four prose class names this tree actually uses. A bare <div> of prose
 * walks past it. It is a floor.
 */
const PROSE_IN_ACTIONS = /<p[\s>]|class="[^"]*\b(?:tx-desc|view-body|sidebar-hint|settings-hint-text)\b/i;
function safeActions(html) {
  const h = str(html);
  if (h === null) return null;
  return PROSE_IN_ACTIONS.test(h) ? null : h;
}

// ── The info affordance's behaviour: ONE delegated listener, installed once ──
//
// Guarded on `typeof document` so importing this module in Node — which every
// offline suite does — cannot throw. That guard is why the module still has no
// imports and still runs headless.
let txInfoWired = false;
function wireInfoToggles() {
  if (txInfoWired || typeof document === 'undefined') return;
  txInfoWired = true;

  const panelFor = (btn) => document.getElementById(btn.getAttribute('data-tx-info') || '');

  const close = (btn) => {
    const panel = panelFor(btn);
    if (panel) panel.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  };

  const openPanels = () =>
    Array.prototype.slice.call(document.querySelectorAll('[data-tx-info][aria-expanded="true"]'));

  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('[data-tx-info]') : null;
    if (btn) {
      const panel = panelFor(btn);
      if (!panel) return;
      const willOpen = btn.getAttribute('aria-expanded') !== 'true';
      // Only one at a time, so a second header's panel cannot leave the first
      // one open off-screen.
      openPanels().forEach((b) => { if (b !== btn) close(b); });
      panel.hidden = !willOpen;
      btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
      return;
    }
    // Light dismiss: a click anywhere that is not inside an open panel closes
    // it. Clicks INSIDE the panel are left alone — the prose is selectable.
    openPanels().forEach((b) => {
      const panel = panelFor(b);
      if (!panel || !(e.target && panel.contains(e.target))) close(b);
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = openPanels();
    if (open.length === 0) return;
    open.forEach(close);
    // Focus goes back to the control that opened it, not to <body>. Dropping
    // focus to body is the v3.17.1 defect that stranded keyboard users on the
    // memory view.
    const last = open[open.length - 1];
    if (last && typeof last.focus === 'function') last.focus();
  });
}
wireInfoToggles();
