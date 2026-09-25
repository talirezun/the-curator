/**
 * buildTrayModel() — the menubar widget's rows, as plain data.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  WHY THIS IS A SEPARATE, ELECTRON-FREE, src-FREE MODULE                   ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * Electron is deliberately not an offline-suite dependency, so `main.js` can
 * never be imported, evaluated or run by `npm test` — a guard on it can only
 * ever be a source scan, which proves a line was WRITTEN and nothing else
 * (v3.0.17). Every module in `desktop/lib/` exists to move the provable part
 * out of main.js, and this one is no different: the entire ROW MODEL — what a
 * row says, which column carries the harness and which carries the machine,
 * how a cap is disclosed, which ages are trustworthy — is ordinary data that
 * `scripts/test-tray-shell.js` computes and inspects for real.
 *
 * It imports nothing from `src/` for the same reason `menu.js` and
 * `quit-decision.js` do not: `src/public/next/views/memory.js` registers a view
 * at module scope and reaches for a DOM, so importing it here would fail in
 * Node. Where a value has to agree with `src/`, it is duplicated and PINNED BY
 * A CROSS-FILE ASSERTION in the suite — the same trade `menu.js` makes for
 * RELEASES_URL, and here it is stronger than a string compare: the suite
 * extracts the real `formatAge` out of `memory.js`, evaluates it, and runs both
 * copies over the same matrix.
 *
 * ── THE INPUT IS THE FIXED CONTRACT ────────────────────────────────────────
 *
 * `getTraySummary({ limit })` is implemented elsewhere (the data layer) and
 * called by main.js as a PLAIN FUNCTION — the shell and the server share one
 * Node realm, so there is no HTTP hop and no IPC. It returns:
 *
 *   { ok, lastSave | null, scopes: [...], projects: [...] | null,
 *     pulse | null, domains | null, brief | null, remote | null,
 *     warnings: [] }
 *
 * and each scope carries `project, scope, machine, harness, writtenAt,
 * writtenAgeSeconds, ageSource ('agent'|'file'), headline, isThisMachine,
 * harnessShared`.
 *
 * v3.74.0 (Layout A) reads two more fields, BOTH OPTIONAL:
 *
 *   projects[].latest  the newest save per (project × harness), across every
 *                      scope and machine, newest first — `{harness, harnessId,
 *                      harnessRaw, model, scope, machine, isThisHost,
 *                      isThisMachine, writtenAt, ageSource, headline, kind}`.
 *                      Absent → the rows are derived from `scopes[]`, which
 *                      is the 40 newest pairs overall, so an idle project
 *                      whose saves fell outside that window is simply not
 *                      listed rather than listed with a guessed age.
 *   pulse.byHarness    `{[id]: {label, buckets, events, lastSeenAt}}`, the
 *                      "Saves by tool" submenu. Absent → the pulse row is a
 *                      plain item with no submenu, as before.
 *
 * THIS MODULE TREATS THAT INPUT AS UNTRUSTED. Not because the data layer is
 * suspect, but because it is being written in parallel with this file and
 * because a menubar that throws is a menubar that is simply absent, with no
 * error anywhere a user will look. Every field is read defensively and every
 * absence has a rendering.
 *
 * ── THE ONE RULE THAT SHAPES EVERY LINE HERE ───────────────────────────────
 *
 * `null` IS NEVER `0` AND NEVER A FAKE STRING. An unknown age renders as
 * "time unknown", never as "just now". An age that came from a filesystem
 * timestamp — `ageSource: 'file'`, which git rewrites on checkout, so on a
 * second machine every pulled handoff reads as brand new — renders as
 * "changed 4 min ago", never as "4 min ago", because *written* is a claim
 * about the agent's clock and *changed* is a claim about this disk's.
 * A fact and its absence must never share a presentation.
 *
 * ── AGES ARE RE-DERIVED AT RENDER TIME, NOT READ OUT OF THE SNAPSHOT ───────
 *
 * `writtenAgeSeconds` in the summary is a number the DATA LAYER computed
 * against the clock it held when it read the disk. This model is rendered far
 * more often than the disk is read — `mouse-enter` re-renders from the
 * in-memory snapshot precisely so a hover costs no I/O, and the one-shot glyph
 * corrector re-renders with no read at all — so taking that number verbatim
 * pins every age to the last read while `renderedAtText`, the absolute stamp
 * beside it, moves.
 *
 * That inverts the purpose of the stamp. `tray-menu.js` justifies the absolute
 * "Updated HH:MM" as the thing that makes a dead watch visible; a stale age
 * sitting under a moving stamp says "fresh" about a reading that is not.
 *
 * So `effectiveAgeSeconds()` re-runs the producer's own arithmetic against the
 * RENDER clock, over the absolute timestamp the snapshot already carries. It
 * is the same expression working-state.js uses, character for character —
 * `Math.max(0, Math.round((now - Date.parse(at)) / 1000))` — so this is not a
 * second opinion about age, it is the first opinion evaluated later.
 *
 * WHAT IT MUST NOT DO IS INVENT PRECISION. `ageSource: 'file'` still has an
 * absolute time to derive from (the store puts the mtime in `writtenAt` when
 * it falls back to the file clock), so a `file` row is re-derived too and
 * keeps its "changed …" wording — the clock it came from is unchanged by
 * recomputing against a newer now. But a row with NO parseable timestamp is
 * left exactly as it was: it falls back to the snapshot's number if there is
 * one, and to null — "time unknown" — if there is not. An unknown age must
 * stay unknown; re-deriving is a way to be more accurate about a fact, never
 * a way to manufacture one.
 */

/**
 * ── THE SIBLING MODULES ARE READ DEFENSIVELY, AND ON PURPOSE ───────────────
 *
 * `pulse-strip.js`, `menu-dots.js` and `menu-bars.js` DRAW the pictures this
 * menu carries. They are read through a namespace import and guarded dynamic
 * ones: a NAMED import of an export that is not there fails at link time and
 * takes the whole module with it, and a menubar module that fails to import
 * is a menubar that is simply ABSENT — no error, no icon, nothing anywhere a
 * user will look.
 *
 * No picture is load-bearing. A missing renderer costs a dot, a strip or a
 * bar and never a reading: every row still says what it says, and the width
 * budget below is computed from RESERVED gutters rather than from whatever a
 * renderer happened to return, so a label cannot change width depending on
 * whether an image module was present.
 */
import * as pulseStrip from './pulse-strip.js';

/** The freshness dot renderer, or null. Resolved once, at import. */
let _renderRecencyDot = null;
try {
  const dots = await import('./menu-dots.js');
  if (dots && typeof dots.renderRecencyDot === 'function') _renderRecencyDot = dots.renderRecencyDot;
} catch { _renderRecencyDot = null; }

/** The depth-bar renderer (v3.66.0), or null — read the same guarded way, for
 *  the same reason: a missing picture must cost a bar, never the menu. */
let _renderGutterBar = null;
try {
  const bars = await import('./menu-bars.js');
  if (bars && typeof bars.renderGutterBar === 'function') _renderGutterBar = bars.renderGutterBar;
} catch { _renderGutterBar = null; }

/** Read off the namespace for the same reason: a renderer that has not grown
 *  an option yet simply ignores it rather than failing. */
const _renderPulseStrip = typeof pulseStrip.renderPulseStrip === 'function'
  ? pulseStrip.renderPulseStrip : null;
const _pulseLabel = typeof pulseStrip.pulseLabel === 'function' ? pulseStrip.pulseLabel : null;
const _pulseToolTip = typeof pulseStrip.pulseToolTip === 'function' ? pulseStrip.pulseToolTip : null;
const _harnessPulses = typeof pulseStrip.harnessPulses === 'function' ? pulseStrip.harnessPulses : null;
const _harnessPulseLabel = typeof pulseStrip.harnessPulseLabel === 'function' ? pulseStrip.harnessPulseLabel : null;

// ── Caps ────────────────────────────────────────────────────────────────────
//
// ── LAYOUT A (v3.74.0): THE FACE OF THE MENU IS "WHAT IS ACTIVE" ───────────
//
// The maintainer's complaint about the v3.66–v3.72 menu was that it was hard
// to see WHICH PROJECTS ARE ACTIVE: the newest save was said three times (the
// "Working on" headline, its grey harness line, the group header), the
// project header carried a 30-day capture ratio instead of a time, and two
// configuration readings (Documents, Session start) sat between a header and
// its rows. Layout A replaces all of it with ONE LINE PER (PROJECT × HARNESS)
// THAT SAVED IN THE LAST 24 HOURS — where, who and when on line one, the
// model and the agent's own sentence on line two — and folds everything else
// into three submenus: Saves by tool, Idle and Knowledge.
//
// FIVE ACTIVE ROWS, the same cap the scope rows had and for the same reason
// (the maintainer asked for five, and five is what makes a section rather
// than a list). It is a CAP, so it is disclosed: rows past it go to a
// `+N more active projects` submenu, never silently.
//
// ── THE CAP IS SPENT A WHOLE PROJECT AT A TIME ─────────────────────────────
//
// A project's rows are adjacent and newest first, and the repeated project
// name IS the handover signal (Claude Code above Antigravity on `ott`). A cap
// that split a project across the face and the overflow would hide exactly
// that signal, and would make the overflow's unit unnameable — "+1 more" of
// what? So projects are taken whole, in recency order, while they fit; the
// first project always shows (clipped to the cap only in the pathological
// case of more than five tools saving one project in a day), and the
// overflow counts PROJECTS (D8), not (scope, machine) pairs.
export const MAX_ROWS = 5;

/** The Idle submenu lists at most this many projects; past it, one item names
 *  the true remainder in PROJECTS and opens Project Context. */
export const MAX_IDLE_ROWS = 12;

/** How many idle project names the Idle row's second line spells out before
 *  it says `+N more`. Two, as in the approved mockup. */
export const IDLE_NAMES_SHOWN = 2;

/** A row's "Other work-streams" section holds at most this many; past it one
 *  item names the remainder and opens Project Context. */
export const MAX_OTHER_STREAMS = 5;

/**
 * How many rows the SHELL asks the data layer for.
 *
 * ── IT IS NOT `MAX_ROWS` ANY MORE, AND THAT IS THE WHOLE POINT ─────────────
 *
 * `main.js` used to request exactly five, because the model rendered exactly
 * five. Grouping breaks that: the model can only put a project on screen if the
 * summary handed it a row from that project, and the summary's own slice is
 * newest-first ACROSS ALL PROJECTS. Ask for five, and a project that saved six
 * times this hour returns five rows of itself and every other project is
 * invisible — the model would then dutifully render one group and call it the
 * whole store.
 *
 * 40 is `TRAY_MAX_LIMIT` in `src/brain/tray-summary.js`: the largest window that
 * module is willing to rank, and therefore everything it will ever show anyone.
 * It is duplicated rather than imported — `desktop/` must not import from
 * `src/`, which is this file's founding constraint — and PINNED against that
 * module by a cross-file assertion in the suite, the same trade `MENU_CHAR_POINTS`
 * and `ROW_ICON_POINTS` already make.
 *
 * The cost is an array, not I/O: `listWorkingScopes` reads the same journals for
 * the same pairs whatever the limit is, and the limit only slices the ranked
 * result. A store busy enough to fill all forty with one project is still
 * disclosed, by `hiddenRows` and the overflow item, exactly as before.
 */
export const TRAY_FETCH_ROWS = 40;

// ── The width budget ────────────────────────────────────────────────────────
//
// ── WHY THIS IS ARITHMETIC AND NOT A HOPE ──────────────────────────────────
//
// v3.37.0 tried to narrow this menu by DROPPING tokens that carried no
// information, and every lever it built was correct. It still did not narrow on
// the maintainer's own machine, because dropping tokens is a lever with no
// FLOOR: when the remaining text is long, the menu is still wide. A budget is
// the missing half — a number every label is measured against and clipped to,
// so no arrangement of data can produce a 74-character row again.
//
// The target came from the two surfaces he supplied as references: iStat
// Menus' panels run about 270 points and Little Snitch's menu about 240.
//
// ── AND THEN THE MENU WAS PHOTOGRAPHED, WHICH ENDED THE GUESSING ───────────
//
// Every number here used to be an ASSUMPTION, stated as one, because nothing
// had ever been rendered and neither Electron nor AppKit's maximum direction
// offers a width to ask for. The redesigned menu has now been built through a
// real `Tray` and captured; the figures below are taken off that photograph,
// MEASURED FROM A 2x CAPTURE ON 2026-09-02 (`probe-menu-wide.png`, 727 device
// pixels of menu at scale 2).
//
// THE MEASUREMENT, in points from the menu's own left edge:
//
//   menu edge to edge                                        363.5
//   leading inset (the strip image's left edge, and the        14.5
//     left edge of every plain item's text)
//   widest text ink (a row's 46-character sublabel)  ends at  293.5
//   the submenu chevron                             ends at  347.5
//   trailing inset after the accessory column                  16.0
//
// The strip image measured 55.0 points wide against `renderPulseStrip`'s
// declared `widthPoints: 55` — so Electron really does draw a menu icon at 1:1,
// and the leading inset above is a reading of a known quantity rather than an
// inference.
//
// THE COMPONENTS AS THEY NOW STAND:
//
//   MENU_WIDTH_POINTS   363.5  MEASURED. The whole item, edge to edge.
//   MENU_CHROME_POINTS   84.5  MEASURED. 14.5 leading inset + 70.0 of trailing
//                              accessory column and padding (363.5 - 293.5),
//                              which is the submenu chevron on a row, the ⌘Q
//                              key equivalent on Quit, and the gap AppKit keeps
//                              between the title column and that column. It is
//                              ONE number because the photograph cannot
//                              separate the gap from the column; what it can
//                              measure exactly is how much width the title
//                              never gets, which is what a budget needs.
//   MENU_ICON_GAP_POINTS    4  STILL ASSUMED, and the only one. Ink-to-ink the
//                              gap measured 7.0pt at the strip and 6.5pt at a
//                              row dot — but that includes the following
//                              glyph's left side bearing, which a photograph
//                              cannot separate from the layout gap, so the
//                              4-point assumption is left standing rather than
//                              replaced with a number it cannot support.
//   ROW_ICON_POINTS        13  the gutter a row's recency dot occupies
//   MENU_CHAR_POINTS      6.5  CORROBORATED. Ink width over character count on
//                              nine rendered labels ran 5.8 to 7.4 points per
//                              character (mean 6.3): "installer-gate · 3 days
//                              ago" 5.78, the pulse reading exactly 6.50,
//                              "Open Agent Memory…" 7.39 — proportional text,
//                              so the spread is the letters and not an error.
//                              6.5 sits just above the mean and is kept.
//   MENU_SUBLABEL_CHAR_POINTS
//                        5.65  MEASURED, and it was WRONG at 5.0. Three rows'
//                              46-character sublabels measured 255.0, 256.5 and
//                              259.5 points of ink — 5.54 to 5.64 per glyph
//                              against an assumed 5.0. That 13% error, times 46
//                              characters, is 30 points of menu the old
//                              arithmetic never charged for.
//
// `MENU_CHAR_POINTS` is pulse-strip.js's own number and is READ FROM THERE
// rather than retyped, so the two files cannot disagree about the font. It is
// still the largest source of error in everything below, which is why
// `labelBudgetChars` takes it as a PARAMETER and the suite reports the budget
// across the whole plausible range instead of asserting one number.
//
// ── 285 -> 363.5, AND NO ROW LOSES A CHARACTER ─────────────────────────────
//
// 285 was not a width the menu had; it was a width the arithmetic BELIEVED,
// with two of its terms wrong in the same direction — chrome under by 48
// points, the sublabel advance under by 13%. The photographed menu is 363.5,
// and the visible result is the one the maintainer looked at and called well
// proportioned, so what changes here is the model and not the menu.
//
// The corrected constants REPRODUCE the shipped sublabel cap exactly:
// (363.5 - 84.5 - 17) / 5.65 = 46.4 -> 46, which is the number that was
// rendered. That is the check on the whole decomposition — three independently
// measured terms landing on the shipped answer — and it is asserted rather than
// merely stated. Nothing narrows: the label budgets GROW (a row 35 -> 40, a
// plain item 38 -> 42), which costs no width, because the widest thing on a row
// is its sublabel and that cap is unchanged.
export const MENU_WIDTH_POINTS = 363.5;
export const MENU_CHROME_POINTS = 84.5;
export const MENU_ICON_GAP_POINTS = 4;
// ── 11 -> 13, AND IT IS THE MARK THAT NEEDED IT, NOT THE BOX ────────────────
//
// At 11pt the largest recency mark was r 3.0 — a 6-point drawing inside an
// 11-point box — and three of the five states were rings separated by 0.5pt of
// radius, which is ONE DEVICE PIXEL at 1x. 13 keeps the odd-canvas argument
// (see menu-dots.js: an even canvas centres a circle on a pixel corner, so the
// smallest filled dot has no opaque pixel anywhere) and gives the ladder room
// to be a ladder.
export const ROW_ICON_POINTS = 13;

/** pulse-strip.js's assumption, not a second one. Defaulted only so a sibling
 *  module that has not landed yet cannot take this one down. */
export const MENU_CHAR_POINTS = typeof pulseStrip.MENU_CHAR_POINTS === 'number'
  && pulseStrip.MENU_CHAR_POINTS > 0 ? pulseStrip.MENU_CHAR_POINTS : 6.5;

/**
 * The sublabel's advance. macOS draws a sublabel in a SMALLER face, so the same
 * budget in points buys MORE characters there — which is why the headline cap
 * below comes out larger than the row-label cap rather than smaller.
 *
 * MEASURED, and it replaces an assumption that was wrong. It was taken as 5.0
 * against the label's 6.5 — "about the 11pt-versus-14pt ratio AppKit uses" —
 * and the photograph says otherwise: three rows whose sublabels were all
 * clipped to exactly 46 characters measured 255.0, 256.5 and 259.5 points of
 * ink, which is 5.54, 5.58 and 5.64 points per glyph. 5.65 is the widest of the
 * three, because a budget that under-charges is the defect being fixed here.
 *
 * It is still smaller than the label advance, which is the property the layout
 * depends on and the easiest one to get backwards: the same points buy MORE
 * characters in the smaller face, which is why the headline cap comes out
 * larger than the row-label cap.
 */
export const MENU_SUBLABEL_CHAR_POINTS = 5.65;

/**
 * How many characters fit on one menu item, given what its icon costs.
 *
 * @param {number} [iconPoints]  the width of the item's icon, 0 for none
 * @param {number} [charPoints]  the assumed average glyph advance
 * @returns {number} a whole number of characters, never below 12 — a budget
 *   that clips a label to nothing is not a narrower menu, it is a broken one.
 */
export function labelBudgetChars(iconPoints = 0, charPoints = MENU_CHAR_POINTS) {
  const icon = Number.isFinite(iconPoints) && iconPoints > 0
    ? iconPoints + MENU_ICON_GAP_POINTS : 0;
  const cp = Number.isFinite(charPoints) && charPoints > 0 ? charPoints : MENU_CHAR_POINTS;
  return Math.max(12, Math.floor((MENU_WIDTH_POINTS - MENU_CHROME_POINTS - icon) / cp));
}

/** An item with no icon: the headline, the commands, the notices, the stamp. */
export const PLAIN_LABEL_CHARS = labelBudgetChars(0);

/**
 * The pulse row's budget, which is the ONE label on this menu that a width may
 * not decide.
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────
 *
 * The photographed menu read `5 days known · 55 saves…`. Nothing was wrong with
 * the reading: `pulseLabel` had emitted `5 days known · 55 saves · 2 tools`, 33
 * characters, complete and true. The width budget at the time was 29, so
 * `clipClauses` dropped `· 2 tools` — a whole fact, silently, off the one row
 * whose entire job is to say honestly what the picture beside it does and does
 * not cover. Two of that sentence's clauses ARE its honesty caveats; a budget
 * that eats them is a budget that has inverted the item's purpose.
 *
 * ── THE FIX IS A FLOOR, NOT AN EXEMPTION ───────────────────────────────────
 *
 * Exempting the row from clipping entirely would leave nothing at all standing
 * between an unexpected producer string and an unbounded menu item. Instead the
 * budget is the LARGER of two numbers:
 *
 *   1. what the width arithmetic allows, given what the strip image costs, and
 *   2. how long the producer's own longest reading actually is — obtained by
 *      RUNNING `pulseLabel` over its widest branches (see `longestPulseLabel`),
 *      never by composing the sentence a second time here.
 *
 * So no shape this producer is known to emit is ever cut, and `clipClauses`
 * remains in place as the backstop for a shape it is not known to emit — where
 * it still drops whole clauses, because `69 s…` reads as `69 seconds` and a
 * clip that produces a DIFFERENT fact is worse than one that produces less.
 *
 * ── THE COST, STATED RATHER THAN DISCOVERED LATER ──────────────────────────
 *
 * At the measured constants the width arithmetic allows 33 characters, and the
 * producer's longest reading is 48 — `the recent past · at least 9999 saves ·
 * 99 tools`, every caveat firing at once with four digits of saves. Rendering
 * that whole would make the pulse item about 455 points, roughly 25% wider than
 * the photographed menu, and it would then be the widest item on it. That is
 * the accepted price of never cutting a caveat, and it is a price paid only by
 * a store that has genuinely earned every one of those clauses; on the
 * maintainer's own store the reading is 33 characters and the item comes out at
 * about 358 points — narrower than the menu around it, which is asserted rather
 * than hoped.
 *
 * @param {number} stripWidthPoints  the picture's own width, from the renderer
 * @returns {number} characters
 */
export function pulseLabelBudget(stripWidthPoints) {
  const width = labelBudgetChars(stripWidthPoints);
  const longest = typeof pulseStrip.longestPulseLabel === 'function'
    ? stripPulseNoun(pulseStrip.longestPulseLabel()) : null;
  return Math.max(width, typeof longest === 'string' ? longest.length : 0);
}

/**
 * A scope row. It carries a recency dot, so it has LESS text budget than a plain
 * item — the gutter is ADDED to the label width, not overlaid on it.
 *
 * ── WHY THE GUTTER IS RESERVED AND NOT MEASURED ────────────────────────────
 *
 * `ROW_ICON_POINTS` is a fixed reservation rather than `dot.widthPoints` read
 * back off whatever the renderer returned. If it were measured, a row's TEXT
 * WIDTH would depend on whether the drawing module was present — the label
 * would silently gain three characters on a build where `menu-dots.js` failed
 * to import, which is a width that changes for a reason having nothing to do
 * with the width.
 *
 * It is 13 because that is `menu-dots.js`'s own `DOT_POINTS`, and the suite
 * PINS it against that module rather than trusting this sentence: a reservation
 * smaller than the thing reserved is a budget that is quietly wrong on every
 * row.
 */
export const ROW_LABEL_CHARS = labelBudgetChars(ROW_ICON_POINTS);

/**
 * The fewest characters of the agent's own sentence the sublabel will settle
 * for before it starts dropping PROVENANCE tokens.
 *
 * Fourteen is roughly two words. Below that the headline stops being a sentence
 * and becomes a stub — `assertLoad…` says less than nothing — so the tokens
 * beside it give way first. It is a FLOOR the drop loop aims at, not a
 * guarantee: a row whose non-droppable tokens alone fill the line keeps them
 * and loses the headline to the tooltip, because a handover mark and a
 * completeness warning outrank a sentence the app shows in full one click away.
 */
export const MIN_HEADLINE_CHARS = 14;


/**
 * The headline cap, now DERIVED rather than chosen.
 *
 * It was 72, then 54 "because 54 is the width of the longest row label". That
 * reasoning was right and its arithmetic was done by hand; this is the same
 * reasoning as a calculation, against the same 260-point item, in the
 * sublabel's own smaller face. The full headline stays reachable — it is what
 * the Agent memory view shows, one click away on the same row.
 */
export const MAX_HEADLINE_CHARS = labelBudgetChars(ROW_ICON_POINTS, MENU_SUBLABEL_CHAR_POINTS);

/** Tier B lines: shown only when they have something to say, and bounded so a
 *  pathological warning list cannot become the whole menu. */
export const MAX_NOTICES = 4;

// ── THE DEPTH BARS (v3.66.0) ─────────────────────────────────────────────────
//
// SIZE/SHARE against a NAMED denominator, drawn in an item's icon gutter
// (`menu-bars.js`). From v3.74.0 (Layout A) ONE placement remains on the
// menu: each domain's pages against the largest domain's, in that domain's
// identity colour (design rule 5), inside the `Knowledge · N domains`
// submenu. The capture bar on the project header and the documents and
// session-start lines left the menu with the headers and lines that carried
// them; the app keeps all three readings.
//
// REFUSED, still: a bar for age (the freshness dot and the pulse strip own
// time), and a bar on the commands.

/**
 * The gutter a bar occupies — RESERVED, not measured off the renderer, for the
 * reason `ROW_ICON_POINTS` gives: a label's width must not depend on whether a
 * drawing module happened to load. Pinned equal to `menu-bars.js`'s
 * `BAR_CANVAS_POINTS` by the menu-bars suite in scripts/.
 */
export const BAR_ICON_POINTS = 28;

/**
 * The title budget of an item carrying a bar: 38 at the measured constants
 * (−2 against a 13pt-dot row, −4 against a plain item). Kept to, the menu does
 * not widen — its widest item is still a scope row's 46-character sublabel.
 */
export const BAR_LABEL_CHARS = labelBudgetChars(BAR_ICON_POINTS);

/** The fewest characters a project or domain name is clipped to so that the
 *  reading beside it (the figure the bar is drawn from) survives. */
export const BAR_NAME_MIN_CHARS = 12;

export const HEADER_DOMAINS = 'Domains · pages';

// ── KEPT FOR ITS PINNED WORDING, NOT DRAWN (v3.74.0) ───────────────────────
//
// The capture reading (`N of M saved`) left the menu: D5 measured that it
// counts MCP process ids, not agent sessions. The two exports below are
// pinned by scripts/test-sync-sb-truth.js (not this package's suite), so they
// stay until that pin moves with the app's own relabel of the reading.
/**
 * Said when a log EXISTS and holds no session for this project in the window.
 *
 * It was `no sessions`, the line's leading reading, and the maintainer's first
 * photograph showed why that was wrong: `projects / lumina · no sessions`
 * sat directly above a handoff saved "1 week ago". Those saves came through a
 * bridge that wrote no session line, so both lines were true and together
 * they read as a contradiction. The words now say whose count it is (the
 * LOGGED sessions) and over which window, and the clause is the LAST and
 * cuttable one, since the saves listed underneath matter more than the empty
 * count. The tooltip keeps the full sentence. It stayed distinct from the
 * absent-log wording: a measured zero and an absent log are two facts and
 * never share a wording.
 */
export const CAPTURE_NONE_IN_WINDOW = 'no logged sessions · 30 d';

/**
 * v3.72.1 (truth audit tray F5): the same clause built from the window the
 * payload names (`capture.windowDays`, = TRAY_CAPTURE_WINDOW_DAYS), so the
 * label and the tooltip beside it can never state two windows. With no
 * window in the payload the day clause is dropped rather than guessed.
 * `CAPTURE_NONE_IN_WINDOW` above is this at 30, kept as the pinned wording.
 */
export function captureNoneInWindow(windowDays) {
  return Number.isInteger(windowDays) && windowDays > 0
    ? 'no logged sessions · ' + windowDays + ' d'
    : 'no logged sessions';
}

/**
 * `name · reading` fitted to `budget` WITHOUT losing the reading — the name is
 * what gets shortened (down to `BAR_NAME_MIN_CHARS`), because the reading is
 * the figure the bar beside it is drawn from, and a bar whose number has been
 * clipped away is a picture with no caption. `extras` follow and are dropped
 * whole, clause by clause, from the end. Everything cut is in the tooltip.
 */
export function composeBarLabel(name, reading, extras, budget) {
  const n = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : '';
  const r = typeof reading === 'string' ? reading.trim() : '';
  if (!r) return clipClauses([n, ...(extras || [])].filter(Boolean).join(' · '), budget);
  const tail = ' · ' + r;
  const room = Math.max(BAR_NAME_MIN_CHARS, budget - tail.length);
  const head = (n.length > room ? clip(n, room) : n) + tail;
  if (head.length > budget) return clip(head, budget);
  const rest = (extras || []).filter(Boolean);
  let out = head;
  for (const e of rest) {
    const next = out + ' · ' + e;
    if (next.length > budget) break;
    out = next;
  }
  return out;
}

/** "Live" — an agent has written in this scope within this many seconds.
 *  Two minutes, from the recency table in docs/roadmap-menubar-widget.md.
 *  Exported because main.js arms a ONE-SHOT timer at exactly this boundary
 *  (see `liveExpiresInMs` below) rather than polling to find out. */
export const LIVE_WINDOW_SECONDS = 120;

// ── Age formatting ──────────────────────────────────────────────────────────

/**
 * The largest minute count the `'minute'` floor will print.
 *
 * Two hours, because that is where a minute count stops being read as a time
 * and starts being read as a number: `119 min ago` is late this morning,
 * `1271 min ago` is arithmetic homework. The photograph that produced this
 * release carried exactly that string on two rows at once.
 *
 * It is a CEILING ON THE FLOOR and not a second ladder: past it, `formatAge`
 * falls to the `'hour'` floor, which is the rung immediately above and is
 * already defined here.
 */
export const MINUTE_PRECISION_MAX_MINUTES = 120;

/**
 * Relative age from a whole-second count.
 *
 * ── THE DEFAULT ARM IS A VERBATIM COPY, AND IT MUST STAY ONE ───────────────
 *
 * Called with ONE argument this is `formatAge` from
 * `src/public/next/views/memory.js`, unchanged. The duplication is deliberate:
 * that module registers a view and touches the DOM at import time, so it cannot
 * be imported here. Two functions rendering "4 min ago" differently is the
 * smallest possible version of the two-surfaces-drift problem, so the suite
 * does not merely diff the text — it extracts the real one, evaluates it, and
 * asserts both agree on a matrix that crosses every boundary in the ladder.
 *
 * ── AND `precision` EXTENDS IT RATHER THAN BRANCHING AROUND IT ─────────────
 *
 * A second age formatter living beside this one would be that same drift
 * problem, created deliberately, to solve a narrower problem. So the ladder
 * gained a FLOOR instead: `precision` names the coarsest unit the answer is
 * allowed to use, and everything below that floor is the existing ladder
 * untouched.
 *
 *   undefined  the ordinary ladder            "1 day ago"
 *   'hour'     never coarser than hours       "34 hr ago"
 *   'minute'   never coarser than minutes     "62 min ago"
 *
 * ── AND THE MINUTE FLOOR HAS A CEILING, BECAUSE 1266 IS NOT A READING ──────
 *
 * The photographed menu read `1271 min ago`. That is a number nobody writes and
 * nobody reads: at a glance it is indistinguishable from a bug, and the reader
 * has to divide by sixty to learn the thing the row exists to tell them. A
 * floor that is allowed to run unbounded stops being a finer reading of the
 * same fact and becomes an unreadable one.
 *
 * So `'minute'` holds only while minutes still READ as minutes — under
 * `MINUTE_PRECISION_MAX_MINUTES` — and above that it degrades to `'hour'`,
 * which is the next rung of this same ladder rather than a second opinion. The
 * degradation is to a FLOOR and not to the ordinary ladder, so the answer never
 * gets COARSER than hours either: a two-day-old row under a minute floor reads
 * `48 hr ago`, never `2 days ago`, and the escalation stays monotonic.
 *
 * It is the SAME FACT at a finer resolution, never a different fact. Its only
 * caller was the v3.37–v3.72 collision resolver, which Layout A (v3.74.0) no
 * longer needs — two face rows are two (project × tool) pairs and differ on
 * line one by construction. The floor is kept because it is pinned (the shell
 * suite drives its ceiling) and the one-argument arm is the app's `formatAge`.
 *
 * Every arm still returns `null` for an absent age. A null/absent age is NOT
 * rendered as "0s ago"; callers get null and render their own words.
 */
export function formatAge(seconds, precision) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return 'just now';
  const m = Math.floor(seconds / 60);
  // The minute floor holds only while a minute count still reads as one. Past
  // the ceiling it becomes the HOUR floor — the next rung up, never the
  // unfloored ladder, so the reading can still not get coarser than hours.
  const floor = precision === 'minute' && m >= MINUTE_PRECISION_MAX_MINUTES ? 'hour' : precision;
  if (floor === 'minute') return m + ' min ago';
  if (m < 60) return m + ' min ago';
  const h = Math.floor(m / 60);
  if (floor === 'hour') return h + ' hr ago';
  if (h < 24) return h + ' hr ago';
  const d = Math.floor(h / 24);
  if (d < 7) return d + ' day' + (d === 1 ? '' : 's') + ' ago';
  const w = Math.floor(d / 7);
  if (w < 5) return w + ' week' + (w === 1 ? '' : 's') + ' ago';
  const mo = Math.floor(d / 30);
  if (mo < 12) return mo + ' month' + (mo === 1 ? '' : 's') + ' ago';
  const y = Math.floor(d / 365);
  return y + ' year' + (y === 1 ? '' : 's') + ' ago';
}

/**
 * The age phrase for a row, qualified by WHICH CLOCK it came from.
 *
 *   'agent' -> "4 min ago"           the agent's own clock, from the journal
 *   'file'  -> "changed 4 min ago"   this disk's mtime, which git rewrites
 *   absent  -> "time unknown"        never "just now"
 *
 * The `file` wording is the whole point of `ageSource` existing. A handoff
 * that arrived over Personal Sync carries the mtime of the PULL, so an
 * unqualified "just now" over a day-old handoff is not merely imprecise — it
 * is the exact reading that stops someone looking.
 */
export function ageText(ageSeconds, ageSource, precision) {
  const rel = formatAge(ageSeconds, precision);
  if (rel === null) return 'time unknown';
  return ageSource === 'file' ? 'changed ' + rel : rel;
}

/**
 * The age of one record AT THE RENDER CLOCK, in whole seconds.
 *
 * See "AGES ARE RE-DERIVED AT RENDER TIME" in this file's header for why this
 * exists. In one line: the snapshot's `writtenAgeSeconds` was measured against
 * a clock that has since moved, and this model is rendered from that snapshot
 * on hover, on a glyph expiry and on a mode change without any new read.
 *
 * PRECEDENCE, and the order is the whole contract:
 *
 *  1. A parseable absolute `at` wins. The arithmetic is byte-for-byte the one
 *     `working-state.js` uses to produce `writtenAgeSeconds` in the first
 *     place, including the `Math.max(0, …)` clamp — so a clock skewed a few
 *     seconds into the future (ordinary between two machines, which is the
 *     scenario this widget was built for) reads "just now" rather than
 *     collapsing to "time unknown".
 *  2. Otherwise the snapshot's own number, unchanged. It is stale by however
 *     long ago the read was, which is exactly as good as today's behaviour and
 *     is the best available when there is no timestamp to do better with.
 *  3. Otherwise null. NOT zero, NOT "just now" — see the header's one rule.
 *
 * @param {string|null} at        an absolute ISO timestamp, or anything else
 * @param {number|null} fallback  the snapshot's precomputed age in seconds
 * @param {number} nowMs          the render clock, in epoch ms
 * @returns {number|null}
 */
export function effectiveAgeSeconds(at, fallback, nowMs) {
  if (typeof at === 'string' && at) {
    const ms = Date.parse(at);
    if (Number.isFinite(ms) && Number.isFinite(nowMs)) {
      return Math.max(0, Math.round((nowMs - ms) / 1000));
    }
  }
  return typeof fallback === 'number' && Number.isFinite(fallback) && fallback >= 0
    ? fallback
    : null;
}

// ── The freshness scale — THE APP'S, copied and pinned (v3.74.0, D6) ────────
//
// Up to v3.72 the tray cut its own ladder (`ageBucket`: 2 min / 30 min / 12 h
// / 7 d) and drew it as a draining pie. Two defects, both measured in the
// design audit: the pie reads as a FILL GAUGE — a battery, a context meter,
// the exact "am I out of context?" question it does not answer — and its cut
// points disagreed with the app's own scale, so a row the app painted
// `today` could be a ½-pie here and a ¼-pie there.
//
// The tray now wears the APP'S dot on the APP'S scale:
// `src/public/next/shared/age.js` `freshnessStep` / `freshnessTier`, cut on
// `formatAge`'s own unit bands so the mark and the words beside it change at
// the same instant. It is COPIED, not imported, for this module's founding
// reason (no `src/` imports), and the suite runs the real one beside this one
// over a matrix — the `formatAge` trade, made again.

// BYTE-IDENTICAL to src/public/next/shared/age.js's body (pinned).
export function freshnessStep(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return 4;
  if (seconds < 3600) return 3;
  if (seconds < 86400) return 2;
  if (seconds < 604800) return 1;
  return 0;
}

const TIER_BY_STEP = ['dormant', 'week', 'today', 'recent', 'live'];

/** Tier name for a second-resolution age. null seconds -> 'unknown'. */
export function freshnessTier(seconds) {
  const step = freshnessStep(seconds);
  return step === null ? 'unknown' : TIER_BY_STEP[step];
}

/**
 * The tiers that make a project ACTIVE: saved in the last 24 hours.
 *
 * Not a threshold of its own. It is the app's `today` boundary — the tiers
 * `freshnessTier` returns under 86,400 seconds — so "active" in the widget
 * and "today" in the app are one cut, and a row cannot be Active here and
 * `week` there.
 */
export const ACTIVE_TIERS = Object.freeze(['live', 'recent', 'today']);

/** Is this age inside the Active window? An unknown age is NOT active: a save
 *  we cannot place in time cannot be claimed as today's. */
export function isActiveAge(seconds) {
  return ACTIVE_TIERS.includes(freshnessTier(seconds));
}

/**
 * THE GLYPH'S WINDOW IS A DIFFERENT QUESTION, AND KEEPS ITS OWN NUMBER.
 *
 * The design left open whether the menubar glyph's `live` follows the app's
 * 60-second tier. It does not, deliberately: the glyph is always visible and
 * answers "is an agent writing on THIS Mac right now", armed by a one-shot
 * timer at `LIVE_WINDOW_SECONDS`. At 60 s a save that took a minute to
 * compose would flicker the glyph off between two saves of one session.
 * The ROW's dot is the app's scale; the GLYPH's bit is the glyph's.
 */
export function glyphLiveAge(seconds) {
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0
    && seconds < LIVE_WINDOW_SECONDS;
}

/**
 * A `formatAge` reading, compacted for the Idle row's second line
 * (`field-notes 9 d · lumina 2 wk`).
 *
 * DERIVED FROM `formatAge`'S OUTPUT, never re-cut from seconds: a second
 * ladder would be a second opinion about where "days" becomes "weeks". Each
 * unit keeps its band; only the words shorten. Anything it does not
 * recognise ("time unknown") is returned whole rather than guessed at.
 */
export function compactAge(text) {
  if (typeof text !== 'string' || !text) return null;
  if (text === 'just now') return 'now';
  const m = /^(changed )?(\d+) (min|hr|days?|weeks?|months?|years?) ago$/.exec(text);
  if (!m) return text;
  const unit = { min: 'min', hr: 'hr', day: 'd', days: 'd', week: 'wk', weeks: 'wk', month: 'mo', months: 'mo', year: 'yr', years: 'yr' }[m[3]];
  // The FILE-CLOCK qualifier survives compaction: "changed 9 d" and "9 d" are
  // two different claims (this disk's mtime versus the agent's clock), and a
  // shorter line is not allowed to merge them.
  return (m[1] ? 'changed ' : '') + m[2] + ' ' + unit;
}

// ── Machine names ───────────────────────────────────────────────────────────

/**
 * A machine folder is `<hostname-slug>-<install-id>` — far too long for a menu
 * row, and the install id is not the interesting half. Show the HOST part.
 *
 * The install id is stripped only when the trailing hyphen-segment actually
 * LOOKS like one (4+ hex characters and nothing else). A host legitimately
 * called `build-box` keeps both words, because `box` is not hex. This is a
 * display heuristic and it is allowed to be conservative: the cost of not
 * stripping is a slightly longer label, and the cost of over-stripping is a
 * machine name that is missing a word.
 */
export function hostPart(machine) {
  if (typeof machine !== 'string' || !machine) return null;
  const i = machine.lastIndexOf('-');
  if (i <= 0) return machine;
  const tail = machine.slice(i + 1);
  return /^[0-9a-f]{4,}$/i.test(tail) ? machine.slice(0, i) : machine;
}

/**
 * The FULL trailing installation id of a `<hostname-slug>-<install-id>` folder,
 * or null when there is not one.
 *
 * ── WHY THE WHOLE TAIL AND NOT `installTag`'s FOUR CHARACTERS ──────────────
 *
 * `installTag` produces a four-character DISPLAY suffix; this produces an
 * IDENTITY. Two genuinely different installations sharing the first four hex
 * characters is unlikely and not impossible, and the consequence of collapsing
 * them would be a second computer's handoffs rendering as if they were written
 * here — the one direction this widget must never be wrong in.
 *
 * The rule itself is not new: `src/brain/tray-summary.js`'s `machineIdentity()`
 * already matches two folder names on their trailing installation id and
 * nothing else, which is how one laptop whose hostname flapped under DHCP stops
 * reading as two machines. This is that comparison, applied to a second
 * question — see `machineIdentityKey`.
 */
export function installIdPart(machine) {
  if (typeof machine !== 'string' || !machine) return null;
  const i = machine.lastIndexOf('-');
  if (i <= 0) return null;
  const tail = machine.slice(i + 1);
  return /^[0-9a-f]{4,}$/i.test(tail) ? tail.toLowerCase() : null;
}

/**
 * WHICH COMPUTER a row came from, as one comparable key.
 *
 * ── THIS IS THE FIX FOR THE READER'S VIEW, AND IT IS WORTH STATING WHY ─────
 *
 * v3.37.0 dropped the machine name from a row when `isThisMachine` was true.
 * On the maintainer's own setup that field is FALSE ON EVERY ROW, because the
 * installed `.app` and his repo checkout are two different INSTALLATIONS on one
 * computer: the app runs under one installation id and his agents write state
 * under another. So the reader classified every row as a foreign machine and
 * printed its name, and the widest label was 74 characters where the suites —
 * every one of which took the WRITER's view — measured 54.
 *
 * `isThisMachine` is the wrong question for a WIDTH decision. The right one is
 * whether the token VARIES ACROSS THE VISIBLE ROWS, which is the rule that
 * already governs the project token and the harness. This key is what that rule
 * is measured over: rows sharing an installation id are ONE identity, whether
 * or not that identity happens to be the reader's own.
 *
 * `isThisMachine` keeps its OTHER job — deciding whether the provenance slot
 * holds a harness or a machine — untouched. One field, two questions, and only
 * the width question changes here.
 */
export const THIS_MAC_KEY = 'mac:@this';

/**
 * ── THE PROPOSAL FOR THIS FUNCTION WAS WRONG, AND THE HOLE IS WORTH KEEPING ─
 *
 * The design sketch said: prefer `host:@this` when `isThisHost` is true, and
 * "a hostname that flapped under DHCP (`mac-9f3c1a` vs
 * `alices-macbook-pro-9f3c1a`) is still caught by the id arm underneath."
 *
 * IT IS NOT. Those two folders are one installation whose hostname changed, so
 * only ONE of them matches today's host slug — the flapped one takes the host
 * arm, the other falls through to `id:9f3c1a`, and the pair lands in two
 * buckets. That is precisely the phantom second computer v3.37.0 removed,
 * reasserted by the fix that was supposed to remove a different one, on the
 * maintainer's own store.
 *
 * So the ID ARM COMES FIRST, because an installation id is the strongest
 * evidence available and it already unifies a flapped hostname. `isThisHost`
 * then does the job it is genuinely needed for: it MARKS AN ID AS BELONGING TO
 * THIS MAC, through `localIds` — so a second installation on this computer
 * collapses into the same identity as the first, which is the whole of D2's
 * real content, without splitting anything the id arm had already joined.
 *
 * @param {object|string} scope
 * @param {Set<string>} [localIds]  installation ids known to be THIS computer,
 *   computed once over the shown rows by `buildTrayModel`. Omitted, this
 *   degrades to the id-only comparison, which is the safe direction: it can
 *   report two identities where there is one (a slightly wider menu) and never
 *   one where there are two (a foreign handoff rendered as local).
 */
export function machineIdentityKey(scope, localIds) {
  const m = typeof scope === 'string' ? scope : (scope && typeof scope.machine === 'string' ? scope.machine : null);
  const id = installIdPart(m);
  if (id) return (localIds instanceof Set && localIds.has(id)) ? THIS_MAC_KEY : 'id:' + id;
  // No parseable id. The producer's two identity facts are all the evidence
  // there is, and a bare folder name is the fallback below them.
  if (scope && typeof scope === 'object'
      && (scope.isThisHost === true || scope.isThisMachine === true)) return THIS_MAC_KEY;
  return m ? 'name:' + m : '@unknown';
}

/**
 * The installation ids that belong to THIS computer, over a set of rows.
 *
 * ── WHY THE TWO FACTS ARE UNIONED RATHER THAN RANKED ───────────────────────
 *
 * They fail in opposite directions and neither is sufficient alone.
 *
 *   `isThisMachine`  an INSTALLATION match (exact, or the same trailing id).
 *                    False for a second installation on this Mac — which is
 *                    the maintainer's own configuration, and is what made every
 *                    row of his menu print a machine name.
 *   `isThisHost`     a HOSTNAME-SLUG match. False for a folder written before
 *                    the hostname flapped under DHCP, which is the other half
 *                    of the same store.
 *
 * Either one being true says this row came from this computer, so the union is
 * the answer and the id it carries is an id this Mac owns. Every other row
 * sharing that id is then this Mac too, whichever of the two facts it happens
 * to satisfy — which is what joins the flapped folder to the current one and
 * the app's own installation to the agents'.
 */
export function localInstallIds(scopes) {
  const out = new Set();
  for (const s of Array.isArray(scopes) ? scopes : []) {
    if (!s || typeof s !== 'object') continue;
    if (s.isThisHost !== true && s.isThisMachine !== true) continue;
    const id = installIdPart(typeof s.machine === 'string' ? s.machine : null);
    if (id) out.add(id);
  }
  return out;
}

/** The disambiguator appended when two VISIBLE rows share a host part —
 *  exactly the hostname-split condition docs/working-state.md describes. */
function installTag(machine) {
  if (typeof machine !== 'string') return '';
  const i = machine.lastIndexOf('-');
  if (i <= 0) return '';
  const tail = machine.slice(i + 1);
  return /^[0-9a-f]{4,}$/i.test(tail) ? tail.slice(0, 4) : '';
}

/**
 * Short machine labels for a set of rows, disambiguated only where needed.
 *
 * Computed over the ROWS THAT WILL BE SHOWN, not over every machine on disk:
 * a suffix that disambiguates against something the user cannot see is noise.
 */
export function shortMachineNames(machines) {
  const list = (Array.isArray(machines) ? machines : []).filter((m) => typeof m === 'string' && m);
  // Count DISTINCT machines per host part — the same machine appearing on
  // three rows is one machine and must not disambiguate against itself.
  const distinct = new Map();
  for (const m of list) {
    const h = hostPart(m) || m;
    if (!distinct.has(h)) distinct.set(h, new Set());
    distinct.get(h).add(m);
  }
  const out = new Map();
  for (const m of list) {
    const h = hostPart(m) || m;
    const tag = installTag(m);
    out.set(m, distinct.get(h).size > 1 && tag ? h + '·' + tag : h);
  }
  return out;
}

// ── Scope names ─────────────────────────────────────────────────────────────

/**
 * Prefixes that carry no information in a list where every row is a scope.
 *
 * `session-` is the one the skill's own examples produce, and it is shared by
 * every single row of the maintainer's real store. A token every row carries is
 * a token that distinguishes nothing; it is pure width.
 *
 * The DATE that usually follows it is stripped separately, by
 * `scopeCandidates`, because it is a different kind of redundancy: the prefix
 * is redundant against the other ROWS, and the date is redundant against the
 * AGE on its own row.
 */
export const SCOPE_DISPLAY_PREFIXES = ['session-'];

/**
 * Display names for a set of scopes, shortened only where it stays lossless.
 *
 * ── THE COLLISION GUARD IS THE WHOLE REASON THIS IS A SET OPERATION ────────
 *
 * Stripping a prefix per-row in isolation can make two DIFFERENT scopes render
 * identically — a store holding both `deploy` and `session-deploy` would show
 * two rows reading `deploy`, and a list in which two rows are the same row is
 * worse than a list that is slightly too wide. So the strip is computed over
 * all the scopes that will be SHOWN together, and any scope whose shortened
 * form collides with another shown scope's displayed form keeps its full name.
 *
 * Computed over the shown rows and not over the whole store for the same
 * reason `shortMachineNames` is: disambiguating against something the user
 * cannot see is noise.
 *
 * The full scope always remains in the row's tooltip. Nothing becomes
 * unreachable — that rule is absolute here.
 *
 * @param {string[]} scopes
 * @returns {Map<string, string>} raw scope -> displayed scope
 */
export function shortScopeNames(scopes) {
  const list = (Array.isArray(scopes) ? scopes : []).filter((s) => typeof s === 'string' && s);
  const taken = new Set(list);

  // Most compact first. `candidates[0]` is what a row would say if nothing
  // collided; the last entry is always the untouched scope.
  const candidates = new Map();
  for (const s of list) candidates.set(s, scopeCandidates(s));

  // ── ONE LEVEL FOR THE WHOLE LIST, NOT ONE PER ROW ──────────────────────
  //
  // Per-row back-off would leave one row carrying a date and its neighbour not,
  // which reads as two different KINDS of scope rather than one list at two
  // resolutions. The list steps back together, and it steps back only as far as
  // the first level at which every shown scope reads differently from every
  // other — and from every other scope's full name, which is the pre-existing
  // rule for `session-` and is unchanged.
  const depth = Math.max(1, ...[...candidates.values()].map((c) => c.length));
  for (let level = 0; level < depth; level++) {
    const out = new Map();
    const counts = new Map();
    for (const [raw, cands] of candidates) {
      const short = cands[Math.min(level, cands.length - 1)];
      out.set(raw, short);
      counts.set(short, (counts.get(short) || 0) + 1);
    }
    const clean = [...out].every(([raw, short]) =>
      short === raw || (!taken.has(short) && counts.get(short) === 1));
    if (clean || level === depth - 1) {
      // The last level is every scope's own full name, which cannot collide
      // with anything (two identical raw scopes are one Map entry), so the loop
      // always terminates on a list nobody can misread.
      if (clean) return out;
    }
  }
  return new Map(list.map((s) => [s, s]));
}

/**
 * The display ladder for one scope, MOST COMPACT FIRST.
 *
 * Two strips, applied in order, each losing something the row says elsewhere:
 *
 *   session-2026-08-30-chat-streaming   the scope, as written
 *   2026-08-30-chat-streaming           minus a prefix every row shares
 *   chat-streaming                      minus a date the row's AGE already gives
 *
 * ── WHY THE DATE GOES, AND WHAT BRINGS IT BACK ─────────────────────────────
 *
 * Every row already carries a relative age, computed from the agent's own
 * clock, in the same label. A leading `YYYY-MM-DD-` is therefore the same fact
 * a second time in eleven characters — on the maintainer's store it was eleven
 * characters on eight of eight rows. It comes straight back the moment two
 * shown scopes would read the same without it, through the collision machinery
 * above rather than through a second rule written beside it.
 *
 * A scope that is ONLY a date keeps it: `cur.length > m[0].length` refuses to
 * shorten to nothing, exactly as the prefix strip already refuses.
 */
export function scopeCandidates(scope) {
  if (typeof scope !== 'string' || !scope) return [''];
  let cur = scope;
  const ladder = [scope];
  for (const p of SCOPE_DISPLAY_PREFIXES) {
    if (cur.length > p.length && cur.slice(0, p.length) === p) { cur = cur.slice(p.length); ladder.push(cur); break; }
  }
  const m = SCOPE_DATE_PREFIX_RE.exec(cur);
  if (m && cur.length > m[0].length) ladder.push(cur.slice(m[0].length));
  return ladder.reverse();
}

/** A leading ISO date on a scope name. Anchored and fixed-width on purpose: a
 *  looser `\d+-\d+-\d+` would eat the front of a scope like `3-2-1-launch`. */
export const SCOPE_DATE_PREFIX_RE = /^\d{4}-\d{2}-\d{2}-/;

// ── Projects ────────────────────────────────────────────────────────────────

/**
 * What a project is CALLED on a line that has room for one identity.
 *
 * `domain / project` when the domain holds more than one project; the bare
 * project name when it holds exactly one — the drop-constant rule again, one
 * level up from the row tokens. A user whose `articles` domain holds a single
 * project called `articles` (the legacy default, whose slug IS its domain)
 * would otherwise read `articles / articles` on every header of every menu.
 *
 * ── THE PRODUCER'S ANSWER WINS, AND THIS IS THE FALLBACK ───────────────────
 *
 * `src/brain/tray-summary.js` computes `projectLabel` on every row, because the
 * count it depends on — how many projects that DOMAIN holds — is a fact about
 * the store rather than about the rows that survived a cap, and only the
 * producer can see it. This function is what happens when a summary arrives
 * without one: the same expression, over the same fields, so a producer that
 * stops supplying the label costs nothing.
 *
 * It is duplicated rather than imported for this module's founding reason —
 * `desktop/` may not import `src/` — and the suite pins the two against each
 * other by running BOTH over the same rows, rather than trusting this sentence.
 */
export function projectLabelOf(scope) {
  if (!scope || typeof scope !== 'object') return '(unnamed)';
  const supplied = str(scope.projectLabel);
  if (supplied) return supplied;
  const d = str(scope.domain);
  const p = str(scope.project);
  if (!p) return d || '(unnamed)';
  if (!d) return p;
  return Number.isInteger(scope.projectsInDomain) && scope.projectsInDomain > 1
    ? d + ' / ' + p : p;
}

/** The fully-qualified identity, for a tooltip. Never shortened, never
 *  conditional — a tooltip has no width problem, and `domain / project` is the
 *  pair a user needs to type into `.curator-project` or into the app. */
export function projectFullName(scope) {
  if (!scope || typeof scope !== 'object') return null;
  const d = str(scope.domain);
  const p = str(scope.project);
  if (d && p) return d + ' / ' + p;
  return p || d || null;
}

/**
 * Which PROJECT a row belongs to, as one comparable key.
 *
 * `domain` and `project` both, joined on NUL: two domains may each hold a
 * project called `main`, and grouping them together would put one project's
 * saves under another project's header — the identity error this whole release
 * exists to remove, committed by the code that renders it.
 */
export function rowGroupKey(scope) {
  const d = (scope && typeof scope.domain === 'string' ? scope.domain : '');
  const p = (scope && typeof scope.project === 'string' ? scope.project : '');
  return d + "\u0000" + p;
}

/** The hover tooltip's opening words. It was the menu's first line,
 *  `Working on: …`, which read in the present tense for something that
 *  happened in the past ("Working on: X · 3 days ago" after a weekend) and
 *  said the same save three times. The menu no longer carries it (Layout A:
 *  the first Active row says it once, with a noun for each fact); the ICON'S
 *  tooltip keeps the fast answer, worded as what it is. */
export const HEADLINE_PREFIX = 'Last save: ';

/** The floor a project name on line one is never clipped below. A project
 *  clipped to two characters is not a shorter line, it is an unreadable one.
 *  The age and the harness are never clipped; the project is. */
export const PROJECT_MIN_CHARS = 10;

// ── Harness names (D1) — a COPY of src/brain/harness-names.js ─────────────
//
// The store holds the harness as FREE TEXT the agent typed: `Claude Code`,
// `Claude Code (desktop)`, `claude-code`, `Antigravity`. Grouping rows per
// (project × harness) on raw strings would put one tool on three rows, and
// the handover mark would announce `Claude Code ← Claude Code (desktop)`.
//
// The data layer normalises (`harnessId` / `harnessLabel` on every scope row,
// `harness` / `harnessId` on every `latest` entry) and THAT answer wins
// wherever it is present. This copy exists for what arrives without it — a
// pre-v3.74 summary's rows, and `previousHarness`, which the store keeps as
// the agent's spelling — because this module may not import `src/` (see the
// header). The table and the function are the data layer's, verbatim in
// behaviour: an unknown name PASSES THROUGH (never merged into a known one),
// and `claude-desktop` stays distinct from `claude-code` (two surfaces, two
// tools — the mcp-clients.js rule).
//
// PINNED CROSS-FILE: the suite runs this copy and the real
// `src/brain/harness-names.js` `normaliseHarness` over one matrix, as it does
// for `formatAge` — a copy that drifts goes red.
const HARNESS_PRODUCTS = [
  { id: 'claude-code', label: 'Claude Code', aliases: ['claude-code', 'claudecode'] },
  { id: 'claude-desktop', label: 'Claude Desktop', aliases: ['claude-desktop', 'claude-ai'] },
  { id: 'codex', label: 'OpenAI Codex CLI', aliases: ['codex', 'codex-cli', 'openai-codex', 'openai-codex-cli', 'codex-mcp-client'] },
  { id: 'gemini-cli', label: 'Gemini CLI', aliases: ['gemini-cli', 'gemini-cli-mcp-client'] },
  { id: 'cursor', label: 'Cursor', aliases: ['cursor', 'cursor-vscode'] },
  { id: 'copilot-cli', label: 'GitHub Copilot CLI', aliases: ['copilot-cli', 'github-copilot-cli', 'copilot', 'github-copilot-developer'] },
  { id: 'cline', label: 'Cline', aliases: ['cline', '@cline-core'] },
  { id: 'opencode', label: 'OpenCode', aliases: ['opencode'] },
  { id: 'goose', label: 'goose', aliases: ['goose', 'goose-desktop'] },
  { id: 'kilo', label: 'Kilo', aliases: ['kilo'] },
  { id: 'dsh', label: 'DeepSeek Harness', aliases: ['dsh', 'deepseek-harness', 'dsh-mcp-client'] },
  { id: 'windsurf', label: 'Windsurf / Devin Desktop', aliases: ['windsurf', 'windsurf-devin-desktop'] },
  { id: 'zed', label: 'Zed', aliases: ['zed'] },
  { id: 'aider', label: 'Aider', aliases: ['aider'] },
  { id: 'antigravity', label: 'Antigravity', aliases: ['antigravity', 'google-antigravity'] },
];
const HARNESS_BY_ALIAS = new Map();
for (const p of HARNESS_PRODUCTS) for (const a of p.aliases) if (!HARNESS_BY_ALIAS.has(a)) HARNESS_BY_ALIAS.set(a, p);

/** id → label for the products the store is known to see. */
export const HARNESS_LABELS = Object.freeze(Object.fromEntries(HARNESS_PRODUCTS.map((p) => [p.id, p.label])));

/** The longest raw string considered — the data layer's `MAX_RAW`. */
const HARNESS_MAX_RAW = 80;

function harnessLookupKey(base) {
  return base.toLowerCase().replace(/[\s_/-]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * `raw` → `{id, label, variant, raw}`, or null for no harness at all.
 *
 *   'Claude Code (desktop)'  → {id:'claude-code', label:'Claude Code', variant:'desktop'}
 *   'claude-code'            → {id:'claude-code', label:'Claude Code', variant:null}
 *   'claude-desktop'         → {id:'claude-desktop', …}      never Claude Code
 *   'harness-two'            → {id:'harness-two', label:'harness-two'}  passes through
 */
export function normaliseHarness(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().slice(0, HARNESS_MAX_RAW).trim();
  if (!trimmed) return null;
  let base = trimmed;
  let variant = null;
  const m = /^(.*?)\s*\(([^()]*)\)$/.exec(trimmed);
  if (m && m[1].trim()) {
    base = m[1].trim();
    variant = m[2].trim() || null;
  }
  const known = HARNESS_BY_ALIAS.get(harnessLookupKey(base));
  if (known) return { id: known.id, label: known.label, variant, raw: trimmed };
  const label = base.replace(/\s+/g, ' ');
  return { id: label.toLowerCase(), label, variant, raw: trimmed };
}

/**
 * The harness as LINE ONE carries it.
 *
 * The design's rule is that the harness and the age never clip. That holds
 * for every known product, which is why the three labels too long for a
 * menu line get a short form here (the full label stays in the tooltip):
 * the harness token is then at most `HARNESS_TOKEN_CHARS`, and the width
 * arithmetic has a bound to work with. A FREE-TEXT name the store has never
 * seen is the one thing that may clip — visibly, with an ellipsis, whole in
 * the tooltip — because an unbounded string an agent typed must not be able
 * to set the width of the menu.
 */
export const HARNESS_SHORT = Object.freeze({
  codex: 'Codex CLI',
  'copilot-cli': 'Copilot CLI',
  dsh: 'DeepSeek',
  windsurf: 'Windsurf',
});
export const HARNESS_TOKEN_CHARS = 14;
/** Said when a save names no harness at all. Absent is not a tool, and it is
 *  not dropped either: a row per harness with a blank where the harness goes
 *  would read as the same tool as its neighbour. */
export const UNKNOWN_HARNESS = 'unknown tool';

export function harnessToken(id, label) {
  if (typeof id === 'string' && HARNESS_SHORT[id]) return HARNESS_SHORT[id];
  if (typeof label !== 'string' || !label.trim()) return UNKNOWN_HARNESS;
  return clip(label, HARNESS_TOKEN_CHARS) || UNKNOWN_HARNESS;
}

// ── Models ──────────────────────────────────────────────────────────────────

/**
 * Vendor words that are not the model's identity. `claude-haiku-4-5` names
 * one model and one vendor; `haiku-4.5` is the half a reader recognises. A
 * `vendor/model` prefix (the OpenRouter form) is stripped the same way.
 */
const MODEL_VENDOR_WORDS = new Set(['claude', 'anthropic', 'google', 'openai', 'models', 'meta', 'mistral']);

/**
 * The FAMILY token for a model id — what reaches line two.
 *
 * ── D2: THE MINOR VERSION WAS BEING DROPPED ────────────────────────────────
 *
 * The v3.37 rule kept "the second segment when it starts with a digit and is
 * at most three characters", which read `claude-opus-5-5` as `opus-5`,
 * `claude-opus-4-8` as `opus-4`, `claude-fable-5-1` as `fable-5`, and
 * `claude-opus-5[1m]` as bare `opus` (the `[1m]` suffix hid the generation
 * entirely). Anthropic spells a version as HYPHENATED DIGITS, so the minor
 * version was the segment being thrown away. Now:
 *
 *   1. strip a `[...]` suffix (`[1m]` is a context-window flag, not a model)
 *   2. drop a `vendor/` path and ONE leading vendor word
 *   3. the NAME is the first word; the VERSION is the run of 1–2-digit
 *      segments after it, joined with `.` (`5-5` → `5.5`), or one segment
 *      that already reads as a version (`3.7`, `4o`)
 *   4. ONE short tier word after the version is kept (≤ 5 letters: `flash`,
 *      `pro`, `lite`, `mini`, `codex`)
 *
 *   claude-opus-5-5          → opus-5.5
 *   claude-opus-4-8          → opus-4.8
 *   claude-opus-5[1m]        → opus-5
 *   claude-fable-5-1         → fable-5.1
 *   claude-haiku-4-5-20251001→ haiku-4.5      (an 8-digit date is not a version)
 *   claude-3-5-sonnet        → sonnet-3.5     (the old naming, version first)
 *   gemini-3.7-flash         → gemini-3.7-flash
 *   gemini-2.5-flash-lite    → gemini-2.5-flash
 *   gpt-4o                   → gpt-4o
 *
 * ── WHY `gemini-3.7-flash` KEEPS `flash` ───────────────────────────────────
 *
 * For Claude the TIER is the name (opus / sonnet / haiku) and comes first, so
 * it survives step 3. For Gemini and GPT the tier comes AFTER the version,
 * and `gemini-3.7` names two different models — Flash and Pro differ in
 * capability and price far more than two Claude minor versions do. Dropping
 * it would make a Flash row and a Pro row read the same. The tier is kept
 * only when it is a short product word (≤ 5 letters): long trailing words
 * (`preview`, `latest`, `thinking`, `instruct`) are snapshots and modes of
 * the same model, and a date segment is never a tier. The exact id is always
 * in the row's tooltip.
 */
export const MODEL_LABEL_CHARS = 18;
export function familyOfModel(model) {
  if (typeof model !== 'string') return null;
  let flat = model.trim().toLowerCase();
  if (!flat) return null;
  flat = flat.replace(/\[[^\]]*\]\s*$/, '').trim();
  if (!flat) return null;
  const bare = flat.slice(flat.lastIndexOf('/') + 1);
  const parts = bare.split('-').filter(Boolean);
  if (!parts.length) return null;
  // Only ONE leading vendor word is dropped, and only when something follows
  // it: `claude` on its own is the best name available and must not shorten
  // to nothing.
  if (parts.length > 1 && MODEL_VENDOR_WORDS.has(parts[0])) parts.shift();
  const isMinorRun = (s) => /^\d{1,2}$/.test(s);
  const isVersion = (s) => /^\d{1,2}(\.\d{1,2})*[a-z]?$/.test(s);
  const readVersion = (from) => {
    if (from >= parts.length) return { v: null, next: from };
    if (isMinorRun(parts[from])) {
      let i = from;
      const run = [];
      while (i < parts.length && isMinorRun(parts[i])) run.push(parts[i++]);
      return { v: run.join('.'), next: i };
    }
    if (isVersion(parts[from])) return { v: parts[from], next: from + 1 };
    return { v: null, next: from };
  };
  let name;
  let version;
  let next;
  if (isVersion(parts[0]) && parts.length > 1) {
    // Version first (`3-5-sonnet`): read it, then the name after it.
    const r = readVersion(0);
    if (r.next < parts.length && /^[a-z]/.test(parts[r.next])) {
      name = parts[r.next];
      version = r.v;
      next = r.next + 1;
      return clip(name + (version ? '-' + version : ''), MODEL_LABEL_CHARS);
    }
  }
  name = parts[0];
  const r = readVersion(1);
  version = r.v;
  next = r.next;
  let out = name + (version ? '-' + version : '');
  if (version && next < parts.length && /^[a-z]{2,5}$/.test(parts[next])) out += '-' + parts[next];
  return clip(out, MODEL_LABEL_CHARS);
}

// ── Text helpers ────────────────────────────────────────────────────────────

/** Collapse whitespace and clip, with a VISIBLE ellipsis. A headline is the
 *  agent's own sentence and can contain newlines; a menu label containing a
 *  newline renders as a mangled single line on macOS. */
export function clip(text, max) {
  if (typeof text !== 'string') return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  if (flat.length <= max) return flat;
  return flat.slice(0, Math.max(1, max - 1)).trimEnd() + '…';
}

/**
 * Fit a ` · `-separated reading into a budget WITHOUT cutting inside a clause.
 *
 * ── WHY AN ORDINARY CLIP IS NOT SAFE ON A READING ──────────────────────────
 *
 * `clip('4 days known · 69 saves', 21)` yields `4 days known · 69 s…`, and
 * `69 s…` is not a shortened `69 saves` to a reader — it is plausibly
 * `69 seconds`. A clip that produces a DIFFERENT FACT is worse than a clip that
 * produces less of one, and this menu's whole argument is that a fact and its
 * absence must never share a presentation.
 *
 * So whole clauses are dropped from the end and the ellipsis stands where they
 * were. Everything dropped is in the item's tooltip, which is where the full
 * reading already lives.
 */
export function clipClauses(text, max, sep = ' · ') {
  if (typeof text !== 'string') return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  if (flat.length <= max) return flat;
  const parts = flat.split(sep);
  // Nothing to drop, or even the first clause is over budget: fall back to the
  // ordinary visible clip rather than returning something over the budget.
  if (parts.length < 2) return clip(flat, max);
  let kept = '';
  for (const part of parts) {
    const next = kept ? kept + sep + part : part;
    if (next.length + 1 > max) break;
    kept = next;
  }
  return kept ? kept + '…' : clip(flat, max);
}

/**
 * The constant noun `pulse-strip.js` opens every one of its readings with.
 *
 * Pinned as a LITERAL here and asserted against that module's real output by
 * the suite, rather than matched with a loose regex over its prose: this repo
 * has already shipped a suppression that matched the word "harness" against a
 * producer whose message never contains it, and passed its own test because the
 * fixture was the fiction. A literal that stops matching is a no-op; a regex
 * that stops matching is a silent one.
 */
/** The remote check's own failure line. Written to fit the width budget rather
 *  than be clipped into it — an ellipsis lands on "handoffs", which is the only
 *  word that makes the sentence mean anything. */
export const REMOTE_CHECK_FAILED = 'Could not check GitHub handoffs';

/** The derived harness-collision line. Long by nature — it names a project and
 *  a scope — so it is clipped for the label and kept whole for the tooltip. */
/**
 * The identity a per-work-stream notice is deduped on.
 *
 * `domain`, `project` and `scope` — all three, joined on NUL. It was project
 * and scope, which was right while a "project" WAS a domain and could not
 * repeat. Two domains may each hold a project called `main` with a scope called
 * `main`, and deduping on two of the three would silence a real collision in
 * one domain because an unrelated one had been reported in the other.
 *
 * A producer that supplies no domain (anything before v3.48.0) contributes an
 * empty first segment, which groups exactly as it used to — so the older shape
 * keeps its old behaviour rather than falling into a bucket with everything.
 */
function noticeKey(r) {
  const d = r && typeof r.domain === 'string' ? r.domain : '';
  const p = r && typeof r.project === 'string' ? r.project : '';
  const s = r && typeof r.scope === 'string' ? r.scope : '';
  return d + '\u0000' + p + '\u0000' + s;
}

/**
 * ONE collision line per (domain, project, scope), in the app's words.
 *
 * ── THE DEFECT THIS REPLACES, FROM THE MAINTAINER'S REAL MENU ──────────────
 *
 * One scope written A-B-A-B by two tools drew the notice TWICE: the derived
 * "Two harnesses are writing projects / fiel…" and the producer's "Two agent
 * tools are writing projects / fi…". The dedupe keyed the derived line on
 * project + scope with NO DOMAIN, while the producer's warning carries its
 * domain — so the two keys never met. Both were clipped before the scope, the
 * one word that says which work-stream.
 *
 * Now both sources resolve to the SAME record, keyed on all three fields, and
 * the words are composed here from the fields rather than taken from either
 * producer's prose: `Two tools are writing <project> / <scope>` — the app's
 * Memory notice ("Two tools are writing …"). The head up to and including the
 * project is never clipped; the SCOPE's tail is, so the verb and the project
 * always survive. The whole sentence, with the tools named, is the tooltip.
 */
export const COLLISION_PREFIX = 'Two tools are writing ';
/**
 * The collision line's OWN cap, wider than a plain item's 42 on purpose.
 *
 * The maintainer's photograph of Layout A read "Two tools are writing
 * field-notes / s2-co…" — a notice nobody can act on. The orchestrator
 * accepted up to ~30 pt of widening FOR NOTICES ONLY (rows keep their caps).
 * The cap is derived from that allowance rather than typed: 30 pt beyond the
 * measured 363.5 pt menu buys floor((363.5 + 30 − 84.5) / 6.5) = 47 … and the
 * measured case is 48 characters, so the allowance is taken as 33 pt (the
 * width a 48-character plain line costs: 396.5 pt). A suggested 60 was
 * measured and refused: 474.5 pt, +111 pt, the widest line on the menu by far.
 */
export const COLLISION_WIDEN_POINTS = 33;
export const COLLISION_LABEL_CHARS = Math.floor(
  (MENU_WIDTH_POINTS + COLLISION_WIDEN_POINTS - MENU_CHROME_POINTS) / MENU_CHAR_POINTS);
export function collisionLine(name, scope, budget = COLLISION_LABEL_CHARS) {
  const head = COLLISION_PREFIX + (name || '(unnamed)') + ' / ';
  // The scope as a row shows it: `session-` and a leading date dropped (the
  // tooltip carries the full name), so the budget is spent on the topic.
  const sc = typeof scope === 'string' && scope ? scopeCandidates(scope)[0] : '(unnamed)';
  if ((head + sc).length <= budget) return head + sc;
  const room = budget - head.length;
  // Keep at least a few characters of the scope; past that the line may run
  // over rather than lose the project or the verb.
  return head + (clip(sc, Math.max(6, room)) || sc);
}
function collisionText(r) {
  return collisionLine(r.projectLabel || r.project, r.scope);
}

/**
 * The sublabel's completeness warning, and it is the ONLY save verdict that
 * reaches a label.
 *
 * `lastSaveKind` has five values. `trimmed` means the store could not hold the
 * whole handoff, which is the one thing a widget about carrying context must
 * not hide. `clipped` — a shortened one-line SUMMARY over a handoff stored in
 * full — stays silent, because v3.39.0 exists precisely because those two were
 * being reported with one alarm, and re-collapsing them here would undo it.
 */
export const SUBLABEL_TRIMMED = 'handoff trimmed';

export const PULSE_LABEL_NOUN = 'Save pulse · ';

/** Drop the noun when the section header above the item already carries it. */
export function stripPulseNoun(label) {
  if (typeof label !== 'string' || !label) return label;
  return label.startsWith(PULSE_LABEL_NOUN) ? label.slice(PULSE_LABEL_NOUN.length) : label;
}

/** Two-digit local clock time. The menu's own freshness stamp is ABSOLUTE and
 *  the rows' ages are RELATIVE, deliberately: they answer different questions
 *  (how old is this event / how old is this reading), and conflating them is
 *  how a widget comes to display a confidently stale list. Taken from the open
 *  bug filed against OpenAI's Codex menubar app, whose proposed remedy is
 *  exactly a "last updated at HH:MM" stamp. */
export function clockText(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes());
}

// ── The model ───────────────────────────────────────────────────────────────

function readScopes(summary) {
  const raw = summary && Array.isArray(summary.scopes) ? summary.scopes : [];
  return raw.filter((s) => s && typeof s === 'object');
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

function str(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * The remote line — rendered as ONE footer line and only when it has something
 * to say.
 *
 * `remote: null` means WE DID NOT CHECK, and that is rendered as nothing. It
 * is not rendered as "up to date", because the widget does not know that. The
 * distinction matters here more than anywhere else in this file: "0 waiting"
 * and "not checked" are the fact and its absence, and the remote check is on
 * menu-open only, so "not checked" is the NORMAL state of this field rather
 * than an error.
 */
export function remoteNotice(remote) {
  if (!remote || typeof remote !== 'object') return null;
  if (remote.ok === false) {
    return {
      kind: 'remote', ok: false,
      // Reworded to fit the budget rather than clipped into it: "handoffs" is
      // the noun that makes the sentence mean anything, and it is the word an
      // ellipsis would have eaten. A supplied message is clipped and its full
      // form carried on `full` for the item's tooltip.
      text: clip(str(remote.message) || REMOTE_CHECK_FAILED, PLAIN_LABEL_CHARS),
      full: str(remote.message) || REMOTE_CHECK_FAILED,
    };
  }
  const files = num(remote.behindFiles) ?? num(remote.waiting);
  const n = files ?? num(remote.behindCommits);
  if (n === null || n === 0) return null;
  const unit = files !== null
    ? (n === 1 ? 'handoff' : 'handoffs')
    : (n === 1 ? 'commit' : 'commits');
  const text = n + ' ' + unit + ' waiting on GitHub';
  return { kind: 'remote', ok: true, text: clip(text, PLAIN_LABEL_CHARS), full: text };
}

/** The data layer's warning codes this model has an opinion about. They are
 *  the `code` field on `getTraySummary()`'s `warnings[]` entries, and they are
 *  a CONTRACT — see `dedupeAgainstSuppliedWarnings` for why matching on the
 *  message text instead is what this fix exists to undo. Pinned by the suite
 *  against the real producer's own emissions. */
export const WARNING_HARNESS_COLLISION = 'harness-collision';
export const WARNING_SCOPES_TRUNCATED = 'scopes-truncated';

/**
 * Normalise `summary.warnings[]` into records that keep the STRUCTURE.
 *
 * The data layer emits `{code, message, project, scope, …}`. The previous
 * version of this file flattened every warning to its message string at the
 * top of `buildTrayModel`, which threw the code away before anything could use
 * it — and the deduplication below then had nothing left to match on but
 * prose. Defensive as ever: a bare string is accepted and simply carries no
 * code, and anything unusable is dropped.
 */
function readWarnings(summary) {
  const raw = summary && Array.isArray(summary.warnings) ? summary.warnings : [];
  const out = [];
  for (const w of raw) {
    if (typeof w === 'string') {
      if (w.trim()) out.push({ code: null, message: w.trim(), project: null, scope: null });
      continue;
    }
    if (!w || typeof w !== 'object') continue;
    const message = typeof w.message === 'string' && w.message.trim() ? w.message.trim() : null;
    if (!message) continue;
    out.push({
      code: typeof w.code === 'string' && w.code ? w.code : null,
      message,
      // `domain` joins `project` because two domains may each hold a project
      // called `main`: deduping on the project alone would silence a real
      // collision in one domain because an unrelated one was reported in the
      // other. Absent on a pre-v3.48.0 producer, which the key handles.
      domain: str(w.domain),
      project: str(w.project),
      scope: str(w.scope),
      harnesses: Array.isArray(w.harnesses) ? w.harnesses : [],
    });
  }
  return out;
}

/**
 * The collision warning: two harnesses on one machine resolve to the same
 * `<machine>` folder and silently overwrite each other's handoff.
 *
 * The widget cannot fix it — the remedy, give them separate scopes, is the
 * user's — and it must not propose one in six words. It names the scope and
 * says nothing else.
 *
 * DERIVED HERE rather than taken from `warnings[]`, because `harnessShared` is
 * per-row data this module already holds and a per-row fact belongs with the
 * row. `dedupeAgainstSuppliedWarnings` then removes whichever copy is
 * redundant, so the two sources cannot both speak about one scope.
 */
function collisionNotice(domain, project, name, scope, harnesses) {
  const labels = [...new Set((Array.isArray(harnesses) ? harnesses : [])
    .map((h) => (normaliseHarness(typeof h === 'string' ? h : null) || {}).label).filter(Boolean))];
  const full = COLLISION_PREFIX + (domain ? domain + ' / ' : '') + (project || name) + ' / ' + scope
    + (labels.length > 1 ? ' — ' + labels.join(' and ') : '')
    + '. Each save overwrites the other\'s handoff in this work-stream.';
  return {
    kind: 'collision',
    domain: domain || null,
    project,
    scope,
    // A notice that names a project can OPEN it: the same route a row carries.
    route: domain ? domain + '/' + project : project,
    text: collisionLine(name, scope),
    full,
  };
}

function collisionNotices(rows) {
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    if (r.harnessShared !== true) continue;
    const key = noticeKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(collisionNotice(r.domain, r.project, r.projectLabel || r.project, r.scope, r.harnessesSeen || []));
  }
  return out;
}

/**
 * `<machine> saved after this Mac` — a handoff is waiting for you, stated as a
 * fact rather than as an instruction.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  AGENT CLOCKS ONLY. A FILE CLOCK HERE WOULD FIRE ON EVERY `git pull`.     ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * `ageSource: 'file'` is this disk's mtime, and Personal Sync rewrites mtime on
 * checkout — so every handoff that arrives over sync reads as brand new the
 * instant it lands. A notice built on that would announce "the other computer
 * just saved" at the moment YOU pulled, every time, forever. Rows whose age
 * came from the file clock are therefore not merely deprioritised here; they
 * are not counted on either side of the comparison.
 *
 * ── AND IT IS `isThisHost`, NOT `isThisMachine` ────────────────────────────
 *
 * A second installation on this Mac is this Mac. Comparing on installations
 * would make the maintainer's own repo checkout "another computer" and put a
 * permanent line in his menu saying a machine he is sitting at saved after
 * himself. See `machineIdentityKey`.
 *
 * ── AND BOTH SIDES MUST EXIST ──────────────────────────────────────────────
 *
 * "After this Mac" is meaningless when this Mac has written nothing with an
 * agent clock: there is no "after". That case renders NOTHING rather than a
 * degraded sentence — a user with a fresh install and a synced repo is not
 * behind, they simply have not started.
 *
 * @param {Array} rows  the built rows, newest first
 */
export function newerElsewhereNotice(rows) {
  const usable = (Array.isArray(rows) ? rows : [])
    .filter((r) => r && r.ageSource === 'agent' && typeof r.ageSeconds === 'number');
  const local = usable.filter((r) => r.isThisHost === true);
  const foreign = usable.filter((r) => r.isThisHost !== true);
  if (!local.length || !foreign.length) return null;
  // Smallest age = newest. Both sides came from agent clocks, so this compares
  // two agents' own timestamps and never two filesystems'.
  const newestLocal = Math.min(...local.map((r) => r.ageSeconds));
  const best = foreign.reduce((a, b) => (b.ageSeconds < a.ageSeconds ? b : a));
  if (!(best.ageSeconds < newestLocal)) return null;
  const name = best.machineShort || best.machine;
  if (!name) return null;
  const text = name + ' saved after this Mac';
  return {
    kind: 'newer-elsewhere',
    machine: best.machine,
    text: clip(text, PLAIN_LABEL_CHARS),
    // The tooltip names the work-stream, because "which computer" without
    // "which work-stream" is not yet actionable.
    full: text + ' — ' + (best.projectFull || best.projectLabel || best.project)
      + ' · ' + best.scope + ', ' + best.ageText,
  };
}

/**
 * Drop the supplied warnings that something else in this menu already says.
 *
 * ── WHY THIS MATCHES ON `code` AND NEVER ON WORDING ────────────────────────
 *
 * The previous suppression was `/harness/i.test(w) && w.includes(project) &&
 * w.includes(scope)` over the warning's MESSAGE. The only producer of that
 * warning is `tray-summary.js`'s `harness-collision`, and its message reads
 * "Two agent tools are writing alpha · main." — the word "harness" does not
 * appear in it anywhere. So the suppression was dead against the sole case it
 * was written for, and every collision emitted BOTH lines, burning two of the
 * four notice slots to say one thing twice.
 *
 * It passed its own test because the fixture in the suite was a hand-written
 * string that happened to contain "harnesses". A regex over user-facing copy
 * is a coupling to a sentence nobody knows they must not reword; the `code`
 * field exists precisely to be matched on, and is asserted against the real
 * producer's emissions rather than against a fixture.
 *
 * TWO PAIRS ARE DEDUPED, and the second is the same shape one notch milder:
 *
 *  - `harness-collision` versus the derived collision line. The SUPPLIED one
 *    wins, because the data layer saw the whole store and its message is the
 *    better sentence; the derived line exists for a summary that reports
 *    `harnessShared` on a row without emitting the warning.
 *  - `scopes-truncated`, when every listed project came with
 *    `projects[].latest` (v3.74.0). The producer truncates `scopes[]` to its
 *    40 newest pairs; with `latest` the menu does not read its rows from
 *    that window at all, so the truncation hides nothing the menu would
 *    show, and saying it would be a caveat about a list that is not drawn.
 *    Without `latest` the rows DO come from that window, and the warning
 *    stays.
 *
 * @param {Array} supplied   readWarnings() output
 * @param {Array} derived    the collision notices this model computed
 * @param {boolean} coverageComplete  whether the rows came from `latest`
 */
function dedupeAgainstSuppliedWarnings(supplied, derived, coverageComplete) {
  const derivedKeys = new Set(derived.map(noticeKey));
  const keptSupplied = [];
  const supersededDerived = new Set();

  for (const w of supplied) {
    if (w.code === WARNING_SCOPES_TRUNCATED && coverageComplete) continue;
    if (w.code === WARNING_HARNESS_COLLISION) {
      // Matched on the warning's OWN domain/project/scope fields, never by
      // searching its prose — the same reason the code is matched rather than
      // the wording. A collision warning that names a scope we did not derive
      // (it was past the row cap, say) still gets through.
      const key = noticeKey(w);
      if (derivedKeys.has(key)) supersededDerived.add(key);
      keptSupplied.push(w);
      continue;
    }
    keptSupplied.push(w);
  }

  return {
    supplied: keptSupplied,
    derived: derived.filter((d) => !supersededDerived.has(noticeKey(d))),
  };
}

/** The Active section's header, and what it says when nothing qualifies. */
export const HEADER_ACTIVE = 'Active · last 24 h';
export const NO_ACTIVE_LABEL = 'No saves in the last 24 h';

/** The noun a count of projects wears. One place, so the overflow, the Idle
 *  row and its remainder item cannot spell the unit three ways. */
export function projectsNoun(n) {
  return n === 1 ? 'project' : 'projects';
}

/** The Knowledge row: every domain behind one submenu (v3.74.0). */
export function knowledgeLabel(n) {
  return 'Knowledge · ' + n + (n === 1 ? ' domain' : ' domains');
}

/** `+N more active projects`, the overflow's label — the unit is NAMED (D8).
 *  `rowsOfShown` is the pathological case of one project with more tools
 *  saving today than the whole cap: those rows are not a project, so they are
 *  not counted as one. */
export function overflowLabel(hiddenProjects, rowsOfShown = 0) {
  const parts = [];
  if (hiddenProjects > 0) parts.push(hiddenProjects + ' more active ' + projectsNoun(hiddenProjects));
  if (rowsOfShown > 0) parts.push(rowsOfShown + ' more ' + (rowsOfShown === 1 ? 'tool' : 'tools') + ' on a shown project');
  return parts.length ? '+' + parts.join(' · ') : null;
}

/** Warning codes the model no longer shows. The Session start line left the
 *  menu (the maintainer's decision; the app keeps it in Context step ④), and
 *  main.js stops asking for the measurement — so its failure is not news the
 *  menu can act on. Listed, not silently matched. */
export const WARNING_SESSION_START = 'session-start-unavailable';
const SILENT_WARNING_CODES = new Set([WARNING_SESSION_START]);

/**
 * Documents notice text, for one project: `ott · 2 docs stale`,
 * `curator · 1 doc not checked`, or both clauses.
 *
 * TWO DIFFERENT FACTS, NEVER ONE WORD (v3.76.0, truth audit F6). "Stale" is a
 * measurement: the source was read and it differs from the stored copy.
 * "Not checked" is its absence: the source could not be reached from this Mac
 * (a GitHub document with no read token — the app says "GitHub · not
 * checked"). Summing the two under "stale" told the maintainer a document had
 * changed when nothing had been compared at all.
 */
export function staleDocsText(name, stale, unchecked = 0) {
  const s = Number.isInteger(stale) && stale > 0 ? stale : 0;
  const u = Number.isInteger(unchecked) && unchecked > 0 ? unchecked : 0;
  if (!s && !u) return null;
  const parts = [];
  if (s) parts.push(s === 1 ? '1 doc stale' : s + ' docs stale');
  if (u) parts.push(s ? u + ' not checked' : (u === 1 ? '1 doc not checked' : u + ' docs not checked'));
  return name + ' · ' + parts.join(' · ');
}

/** The notice's tooltip — what each clause of `staleDocsText` means. */
export function staleDocsFull(name, stale, unchecked = 0) {
  const s = Number.isInteger(stale) && stale > 0 ? stale : 0;
  const u = Number.isInteger(unchecked) && unchecked > 0 ? unchecked : 0;
  const parts = [];
  if (s) parts.push(s + ' curator-owned document' + (s === 1 ? ' differs from its source' : 's differ from their sources'));
  if (u) parts.push(u + ' could not be checked from this Mac (its source was not reachable, e.g. a GitHub document with no read token)');
  return parts.length ? name + ': ' + parts.join('; ') : null;
}

/**
 * Build the whole menu model from one `getTraySummary()` result.
 *
 * @param {object} summary  a getTraySummary() result, or anything at all —
 *                          garbage in produces the empty state, never a throw.
 * @param {object} [opts]
 * @param {Date}   [opts.now]      the render clock, injected so the suite can
 *                                 assert the absolute stamp deterministically.
 * @param {number} [opts.maxRows]  a SHRINK-ONLY seam: clamped to `MAX_ROWS`,
 *                                 never able to raise the display cap.
 * @param {boolean} [opts.dark]    the menu's appearance, read by main.js.
 * @returns {object} the model consumed by tray-menu.js.
 */
export function buildTrayModel(summary, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  // `maxRows` can LOWER the cap and never raise it — v3.50.0 shipped it as a
  // two-way override, the shell handed it the FETCH limit, and the menu drew
  // 23 rows. The display cap is `MAX_ROWS`, in code.
  const maxRows = Number.isInteger(opts.maxRows) && opts.maxRows > 0
    ? Math.min(opts.maxRows, MAX_ROWS) : MAX_ROWS;

  // ── THE THEME IS PASSED IN, NEVER READ HERE ────────────────────────────
  // Anything other than a literal `true` is light, the safe direction: a
  // light-palette image on a dark menu is dim, a dark one on a light menu is
  // invisible.
  const dark = opts.dark === true;

  // ── THE RENDERERS, INJECTABLE AND WRAPPED ──────────────────────────────
  // A renderer that throws must cost a picture, never the menu.
  const dotFn = typeof opts.renderDot === 'function' ? opts.renderDot : _renderRecencyDot;
  const stripFn = typeof opts.renderStrip === 'function' ? opts.renderStrip : _renderPulseStrip;
  const renderDot = (tier) => {
    if (!dotFn) return null;
    try { return dotFn(tier, { dark }) || null; } catch { return null; }
  };
  const renderStrip = (raw) => {
    if (!stripFn) return null;
    try { return stripFn(raw, { dark }) || null; } catch { return null; }
  };
  const barFn = typeof opts.renderBar === 'function' ? opts.renderBar : _renderGutterBar;
  const renderBar = (o) => {
    if (!barFn) return null;
    try { return barFn({ ...o, dark }) || null; } catch { return null; }
  };
  // The identity colour is the kit's (`identityHex(index, theme)` from
  // src/brain/identity-palette.js), handed in by main.js. Absent, a domain's
  // bar is drawn in the neutral ink: a missing colour is never a guessed one.
  const identityHexFn = typeof opts.identityHex === 'function' ? opts.identityHex : null;
  // v3.76.0: keyed on the domain's RECORDED slot (1-based, `domains[].slot`
  // from the data layer), never on its list position. identityHex takes a
  // 0-based palette index, so slot N is index N-1.
  const identityInk = (slot) => {
    if (!identityHexFn || !Number.isInteger(slot) || slot < 1) return null;
    try {
      const h = identityHexFn(slot - 1, dark ? 'dark' : 'light');
      return typeof h === 'string' && /^#[0-9a-fA-F]{6}$/.test(h) ? h : null;
    } catch { return null; }
  };

  const nowMs = now.getTime();
  const ok = !!(summary && summary.ok !== false);
  const scopesIn = readScopes(summary);
  const projectsIn = summary && Array.isArray(summary.projects) ? summary.projects : null;

  // ── 1. THE PROJECTS, AND EVERY SAVE WE KNOW OF FOR EACH ────────────────
  //
  // A project is `domain` + `project`, joined on NUL (`rowGroupKey`): two
  // domains may each hold a project called `main`.
  //
  // Its ENTRIES are one per harness — the newest save that tool made in it,
  // across every scope and machine. `projects[].latest` is that list,
  // computed by the data layer for EVERY project (D3). Without it the
  // entries are derived from `scopes[]`, the 40 newest pairs overall: a
  // project with no pair in that window is not listed, which is an absence,
  // never an invented age.
  const projects = new Map();
  const order = [];
  const projectOf = (src) => {
    const key = rowGroupKey(src);
    if (!projects.has(key)) {
      projects.set(key, {
        key,
        domain: str(src.domain),
        project: str(src.project) || '(unnamed)',
        projectLabel: projectLabelOf(src),
        projectFull: projectFullName(src),
        isDefaultProject: src.isDefaultProject === true,
        fromLatest: false,
        latestIn: null,
        scopeRows: [],
        foundations: null,
        // The store's true count of this project's work-streams (F5), or null.
        scopeCount: null,
      });
      order.push(key);
    }
    const p = projects.get(key);
    if (src.isDefaultProject === true) p.isDefaultProject = true;
    return p;
  };
  for (const p of projectsIn || []) {
    if (!p || typeof p !== 'object' || !str(p.project)) continue;
    const rec = projectOf(p);
    if (Number.isInteger(p.scopeCount) && p.scopeCount >= 0) rec.scopeCount = p.scopeCount;
    if (Array.isArray(p.latest)) {
      rec.fromLatest = true;
      rec.latestIn = p.latest.filter((e) => e && typeof e === 'object');
    }
  }
  for (const s of scopesIn) {
    const rec = projectOf(s);
    rec.scopeRows.push(s);
    if (!rec.foundations && s.foundations && typeof s.foundations === 'object') rec.foundations = s.foundations;
  }

  const sourceOf = (s) => (s.ageSource === 'file' ? 'file' : (s.ageSource === 'agent' ? 'agent' : null));
  const harnessOfRaw = (s) => {
    // The data layer's normalised answer wins. The two record shapes spell it
    // differently: a `latest` entry carries `harness` = the LABEL beside
    // `harnessRaw`; a scope row keeps `harness` = the agent's RAW spelling
    // beside `harnessLabel`. The raw string is kept for the tooltip.
    const id = str(s.harnessId);
    if (id) {
      const isLatest = Object.prototype.hasOwnProperty.call(s, 'harnessRaw');
      const label = str(s.harnessLabel) || (isLatest ? str(s.harness) : null)
        || HARNESS_LABELS[id] || (normaliseHarness(str(s.harness)) || {}).label || id;
      return { id, label, raw: isLatest ? (str(s.harnessRaw) || str(s.harness)) : str(s.harness) };
    }
    const n = normaliseHarness(str(s.harness));
    return n ? { id: n.id, label: n.label, raw: n.raw } : { id: null, label: null, raw: null };
  };

  /** One save, as every surface reads it. `src` is a latest entry or a scope
   *  row; `match` is the scope row for the same (scope, machine), which
   *  carries the per-pair facts a latest entry does not (handover, collision,
   *  foundations). */
  const recordOf = (proj, src, match) => {
    const m = match || {};
    const h = harnessOfRaw(src);
    const prevRaw = str(src.previousHarness) || str(m.previousHarness);
    const prev = prevRaw ? normaliseHarness(prevRaw) : null;
    const age = effectiveAgeSeconds(str(src.writtenAt), num(src.writtenAgeSeconds ?? m.writtenAgeSeconds), nowMs);
    return {
      proj,
      domain: proj.domain,
      project: proj.project,
      projectFull: proj.projectFull,
      isDefaultProject: proj.isDefaultProject,
      scope: str(src.scope) || '(unnamed)',
      machine: str(src.machine),
      harnessId: h.id,
      harness: h.label,
      harnessRaw: h.raw,
      // The handover — only when the save before came from a DIFFERENT tool,
      // compared on the normalised id so `Claude Code (desktop)` after
      // `Claude Code` is not a handover.
      previousHarness: prev && prev.id !== h.id ? prev.label : null,
      model: str(src.model) || str(m.model),
      headline: str(src.headline) || str(m.headline),
      kind: str(src.kind) || str(m.kind),
      writtenAt: str(src.writtenAt) || str(m.writtenAt),
      ageSource: sourceOf(src.ageSource ? src : m),
      ageSeconds: age,
      isThisMachine: (src.isThisMachine ?? m.isThisMachine) === true,
      isThisHost: (src.isThisHost ?? m.isThisHost) === true,
      harnessShared: (src.harnessShared ?? m.harnessShared) === true,
      // Every tool the journal saw on this pair — the collision line names them.
      harnessesSeen: Array.isArray(src.harnesses) ? src.harnesses : (Array.isArray(m.harnesses) ? m.harnesses : []),
      foundations: (m.foundations && typeof m.foundations === 'object') ? m.foundations
        : (src.foundations && typeof src.foundations === 'object' ? src.foundations : null),
    };
  };
  const byAge = (a, b) => {
    if (a.ageSeconds === null && b.ageSeconds === null) return 0;
    if (a.ageSeconds === null) return 1;
    if (b.ageSeconds === null) return -1;
    return a.ageSeconds - b.ageSeconds;
  };
  const pairKey = (r) => r.scope + '\u0000' + (r.machine || '');

  for (const key of order) {
    const p = projects.get(key);
    // An EMPTY `latest` beside scope rows of the same project is the producer
    // contradicting itself (`latest` is taken over every pair it read); the
    // rows are evidence, so they are used rather than listing nothing.
    if (p.fromLatest && p.latestIn.length === 0 && p.scopeRows.length > 0) p.fromLatest = false;
    const pairs = new Map();
    for (const s of p.scopeRows) {
      const r = recordOf(p, s, null);
      const k = pairKey(r);
      if (!pairs.has(k)) pairs.set(k, { rec: r, row: s });
    }
    let entries;
    if (p.fromLatest) {
      entries = p.latestIn.map((e) => {
        const probe = { scope: str(e.scope) || '(unnamed)', machine: str(e.machine) };
        const hit = pairs.get(pairKey(probe));
        return recordOf(p, e, hit ? hit.row : null);
      });
    } else {
      // Derived: the newest pair per harness id among this project's rows.
      entries = [...pairs.values()].map((x) => x.rec);
    }
    entries.sort(byAge);
    const seen = new Set();
    p.entries = entries.filter((e) => {
      const hk = e.harnessId || '\u0000none';
      if (seen.has(hk)) return false;
      seen.add(hk);
      return true;
    });
    p.pairs = [...pairs.values()].map((x) => x.rec).sort(byAge);
    p.newest = p.entries[0] || null;
    if (!p.foundations && p.newest && p.newest.foundations) p.foundations = p.newest.foundations;
  }

  const listed = order.map((k) => projects.get(k)).filter((p) => p.newest);
  listed.sort((a, b) => byAge(a.newest, b.newest));

  // ── 2. WHAT A PROJECT IS CALLED ON LINE ONE ────────────────────────────
  //
  // The bare project name — `ott`, not `projects / ott`. The domain prefix
  // was constant on every header of the maintainer's menu (all four active
  // projects live in `projects`), and it is the drop-constant rule again. It
  // comes back, as `domain / project`, only when two listed projects share a
  // bare name — two identical names are the same defect as two identical
  // rows. The submenu header and every tooltip carry the full pair always.
  {
    const counts = new Map();
    for (const p of listed) counts.set(p.project, (counts.get(p.project) || 0) + 1);
    for (const p of listed) {
      p.name = counts.get(p.project) > 1 && p.projectFull ? p.projectFull : p.project;
    }
  }

  // ── 3. ACTIVE AND IDLE ─────────────────────────────────────────────────
  const activeProjects = listed.filter((p) => isActiveAge(p.newest.ageSeconds));
  const idleProjects = listed.filter((p) => !isActiveAge(p.newest.ageSeconds));

  // ── WHICH COMPUTER, ON LINE TWO ────────────────────────────────────────
  //
  // A machine name is shown on a row from ANOTHER computer, and only when the
  // store's records actually come from more than one computer. Measured over
  // every record the menu knows of (not only the rows on the face): a face
  // whose only row came from the studio is still a row from the studio when
  // this Mac's own saves sit one submenu down. Computers are IDENTITIES
  // (`machineIdentityKey`): folders sharing an install id are one computer,
  // and an id seen on a this-host row is this Mac — the reader's-view rule,
  // unchanged. With one identity in the whole store the name is width.
  const allRecords = listed.flatMap((p) => p.pairs.concat(p.entries));
  const localIds = localInstallIds(allRecords);
  const machineLabels = shortMachineNames(allRecords.map((r) => r.machine));
  const machineKey = (r) => machineIdentityKey(r, localIds);
  const multiComputer = new Set(allRecords.map(machineKey)).size > 1;
  const namesMachine = (r) => multiComputer && machineKey(r) !== THIS_MAC_KEY;

  let idSeq = 0;
  const allRows = [];

  /**
   * LINE TWO: `[handoff trimmed · ][A ← B · ][machine · ]model — headline`.
   *
   * Tokens drop WHOLE, never clipped (`son…` is not a shorter `sonnet`), in
   * importance order, lowest first — model, then machine — and only while
   * the headline is below its floor. The two warnings do not drop: a save the
   * store had to trim, and a handover (`Claude Code ← Antigravity`), are facts
   * about whether context survived, which is this widget's one job. Everything
   * dropped is in the tooltip.
   */
  const composeSublabel = (r, showMachine, budget = MAX_HEADLINE_CHARS) => {
    const tokens = [];
    if (r.kind === 'trimmed') tokens.push({ key: 'trimmed', text: SUBLABEL_TRIMMED });
    if (r.previousHarness && r.harness) {
      tokens.push({ key: 'handover', text: r.harness + ' ← ' + r.previousHarness });
    }
    if (showMachine) {
      const m = machineLabels.get(r.machine) || r.machine;
      if (m) tokens.push({ key: 'machine', text: m, drop: 3 });
    }
    const fam = familyOfModel(r.model);
    if (fam) tokens.push({ key: 'model', text: fam, drop: 1 });
    const headline = clip(r.headline, budget);
    const kept = tokens.slice();
    const whoOf = () => kept.map((t) => t.text).join(' · ');
    for (let rank = 1; rank <= 4; rank++) {
      if (!headline) break;
      if (budget - whoOf().length - 3 >= MIN_HEADLINE_CHARS) break;
      const i = kept.findIndex((t) => t.drop === rank);
      if (i >= 0) kept.splice(i, 1);
    }
    const who = whoOf();
    const keys = new Set(kept.map((t) => t.key));
    if (!who) return { text: headline, keys };
    const room = budget - who.length - 3;
    if (!headline || room < 8) return { text: clipClauses(who, budget), keys };
    return { text: who + ' — ' + clip(headline, room), keys };
  };

  /**
   * LINE ONE: `<head> · <harness> · <age>`. The age and the harness token are
   * never clipped; the HEAD (a project name, or a scope in a submenu) is, to
   * `PROJECT_MIN_CHARS` at the least. Past that floor the line is allowed to
   * run over the budget rather than destroy the name — bounded, because the
   * harness token and the age are both bounded (see HARNESS_TOKEN_CHARS).
   */
  const composeLine = (head, harness, ageWords, budget = ROW_LABEL_CHARS) => {
    const tail = (harness ? ' · ' + harness : '') + ' · ' + ageWords;
    const room = budget - tail.length;
    const h = head.length <= room ? head : (clip(head, Math.max(PROJECT_MIN_CHARS, room)) || head);
    return h + tail;
  };

  const toolTipOf = (r) => [
    (r.projectFull || r.project) + ' · ' + r.scope,
    r.machine ? 'machine: ' + r.machine : null,
    r.isThisHost && !r.isThisMachine && r.machine ? 'other install on this Mac: ' + r.machine : null,
    r.harness ? 'harness: ' + r.harness
      + (r.harnessRaw && r.harnessRaw !== r.harness ? ' (recorded as “' + r.harnessRaw + '”)' : '')
      : 'harness: not recorded',
    r.previousHarness ? 'the save before it came from ' + r.previousHarness : null,
    r.model ? 'model: ' + r.model : null,
    r.kind === 'trimmed' ? 'this save did not all fit — part of the handoff was not stored' : null,
    r.headline && r.headline.length > 0 ? r.headline : null,
    r.ageSource === 'agent' && r.writtenAt ? 'written: ' + r.writtenAt : null,
    r.ageSource === 'file'
      ? 'this age is the file timestamp on this disk, which git rewrites on checkout, not the agent’s clock'
      : null,
    r.ageSeconds === null ? 'no save time is recorded for this work-stream' : null,
  ].filter(Boolean).join('\n');

  /** The fields every drawn row carries, whatever section it is in. */
  const rowOf = (r, place, extra = {}) => {
    const tier = freshnessTier(r.ageSeconds);
    const ageWords = ageText(r.ageSeconds, r.ageSource);
    const foreign = r.isThisHost !== true;
    const row = {
      id: 'tray-row-' + (idSeq++),
      place,
      domain: r.domain,
      project: r.project,
      projectLabel: r.proj.name,
      projectName: r.proj.name,
      projectFull: r.projectFull,
      // `<domain>/<project>` — the app's dispatch attribute and the
      // `.curator-project` marker line, the same pair, never collapsed.
      route: r.domain ? r.domain + '/' + r.project : r.project,
      marker: r.domain ? r.domain + '/' + r.project : r.project,
      isDefaultProject: r.isDefaultProject,
      // `latest` IS A CLAIM THE RESUME PROMPT MAKES (`scope: "latest"`), so it
      // is true only on the project's NEWEST save across every tool, scope
      // and machine. A second harness's row is NOT latest — "latest" would
      // resolve to the other tool's scope and the agent would resume the
      // wrong work-stream.
      latest: r.proj.newest === r,
      scope: r.scope,
      scopeShort: r.scope,
      machine: r.machine,
      machineShort: machineLabels.get(r.machine) || r.machine,
      harness: r.harness,
      harnessId: r.harnessId,
      harnessRaw: r.harnessRaw,
      previousHarness: r.previousHarness,
      model: r.model,
      modelFamily: familyOfModel(r.model),
      kind: r.kind,
      isThisMachine: r.isThisMachine,
      isThisHost: r.isThisHost,
      harnessShared: r.harnessShared,
      harnessesSeen: r.harnessesSeen,
      foundations: r.foundations,
      tier,
      glyphLive: glyphLiveAge(r.ageSeconds),
      ageSeconds: r.ageSeconds,
      ageSource: r.ageSource,
      ageText: ageWords,
      headline: clip(r.headline, MAX_HEADLINE_CHARS),
      writtenAt: r.writtenAt,
      foreign,
      // `unknown` is drawn by the renderer as the app's dashed ring — a
      // different KIND of mark, never the coldest one.
      dot: renderDot(tier),
      toolTip: toolTipOf(r),
      streams: [],
      streamsHidden: 0,
      ...extra,
    };
    allRows.push(row);
    return row;
  };

  /** The header a row's submenu opens on: the fully-qualified work-stream
   *  (`projects / ott · main`). A submenu is its own menu, so it cannot widen
   *  the menu it hangs from — but it is budgeted all the same: past the plain
   *  budget the DOMAIN goes first (it is on the row's tooltip), then the line
   *  is clipped visibly. */
  const submenuHeaderOf = (r) => {
    const full = (r.projectFull || r.project) + ' · ' + r.scope;
    if (full.length <= PLAIN_LABEL_CHARS) return full;
    const short = r.proj.name + ' · ' + r.scope;
    if (short.length <= PLAIN_LABEL_CHARS) return short;
    return clip(short, PLAIN_LABEL_CHARS) || short;
  };

  /** A primary row: a project × harness, on the face, in the overflow or in
   *  the Idle submenu. Its label is `project · harness · age`. */
  const primaryRow = (r, place) => {
    const row = rowOf(r, place);
    row.label = composeLine(r.proj.name, harnessToken(r.harnessId, r.harness), row.ageText);
    row.submenuHeader = submenuHeaderOf(r);
    return row;
  };

  // ── 4. THE FACE: ACTIVE ROWS, A WHOLE PROJECT AT A TIME ────────────────
  const activeGroups = activeProjects.map((p) => ({
    p, recs: p.entries.filter((e) => isActiveAge(e.ageSeconds)),
  }));
  const shownRecs = [];
  const overflowRecs = [];
  let budget = maxRows;
  let hiddenProjects = 0;
  let rowsOfShown = 0;
  for (let gi = 0; gi < activeGroups.length; gi++) {
    const g = activeGroups[gi];
    if (gi === 0 && g.recs.length > budget) {
      shownRecs.push(...g.recs.slice(0, budget));
      overflowRecs.push(...g.recs.slice(budget));
      rowsOfShown = g.recs.length - budget;
      budget = 0;
      continue;
    }
    if (budget > 0 && g.recs.length <= budget && overflowRecs.length === 0) {
      shownRecs.push(...g.recs);
      budget -= g.recs.length;
    } else {
      // Once one project does not fit, every later one goes too: the face is
      // strictly newest-first, and skipping ahead to a smaller, older project
      // would put it above one that saved more recently.
      overflowRecs.push(...g.recs);
      hiddenProjects++;
    }
  }

  const activeRows = shownRecs.map((r) => primaryRow(r, 'active'));
  const overflowRows = overflowRecs.map((r) => primaryRow(r, 'overflow'));

  // ── 5. IDLE — ONE ROW PER PROJECT, ITS NEWEST SAVE ─────────────────────
  const idleShown = idleProjects.slice(0, MAX_IDLE_ROWS);
  const idleRows = idleShown.map((p) => primaryRow(p.newest, 'idle'));

  // ── 6. EACH ROW'S "OTHER WORK-STREAMS" ─────────────────────────────────
  //
  // Everything else known about the row's project, so nothing a cap removes
  // becomes unreachable: the project's other scopes and its other tools'
  // saves. Assigned WITHOUT DUPLICATION — a save goes under the row of the
  // tool that made it when that tool has a row, and under the project's
  // first row otherwise — so two rows of one project never list one stream
  // twice. Newest first; capped, with the remainder named.
  const rowsByProject = new Map();
  for (const row of activeRows.concat(overflowRows, idleRows)) {
    const k = rowGroupKey(row);
    if (!rowsByProject.has(k)) rowsByProject.set(k, []);
    rowsByProject.get(k).push(row);
  }
  // ONE STREAM PER WORK-STREAM PER COMPUTER. A scope is a work-stream; two
  // `<machine>` folders of it on ONE computer (a hostname that flapped under
  // DHCP, or two installations on this Mac) are one work-stream saved twice,
  // and the newest copy wins — the v3.51 rule that stopped a group showing
  // one work-stream twice. The same scope on ANOTHER computer is kept: that
  // copy is the news, and its line two names the machine.
  const streamKey = (r) => r.scope + '\u0000' + machineKey(r);
  for (const [k, rowsHere] of rowsByProject) {
    const p = projects.get(k);
    if (!p) continue;
    const taken = new Set(rowsHere.map(streamKey));
    const candidates = new Map();
    for (const r of p.pairs.concat(p.entries).sort(byAge)) {
      const pk = streamKey(r);
      if (taken.has(pk) || candidates.has(pk)) continue;
      candidates.set(pk, r);
    }
    const sorted = [...candidates.values()].sort(byAge);
    for (const r of sorted) {
      const owner = rowsHere.find((x) => x.harnessId && x.harnessId === r.harnessId) || rowsHere[0];
      owner._streamRecs = owner._streamRecs || [];
      owner._streamRecs.push(r);
    }
  }
  for (const row of activeRows.concat(overflowRows, idleRows)) {
    const recs = row._streamRecs || [];
    delete row._streamRecs;
    const shown = recs.slice(0, MAX_OTHER_STREAMS);
    row._streamsOverflow = recs.slice(MAX_OTHER_STREAMS);
    row.streamsHidden = 0;
    row.streamsMoreLabel = null;
    const scopeLabels = shortScopeNames([row.scope, ...shown.map((r) => r.scope)]);
    row.scopeShort = scopeLabels.get(row.scope) || row.scope;
    row.streams = shown.map((r) => {
      const s = rowOf(r, 'stream');
      s.scopeShort = scopeLabels.get(r.scope) || r.scope;
      // The harness is named only when it is NOT the parent row's tool: under
      // `ott · Claude Code`, a stream saying "Claude Code" again is width.
      const otherTool = r.harnessId !== row.harnessId;
      s.label = composeLine(s.scopeShort, otherTool ? harnessToken(r.harnessId, r.harness) : null, s.ageText);
      s.submenuHeader = submenuHeaderOf(r);
      const sub = composeSublabel(r, namesMachine(r));
      s.sublabel = sub.text;
      s.showsMachine = sub.keys.has('machine');
      s.showsModel = sub.keys.has('model');
      s.parentId = row.id;
      return s;
    });
  }
  // ── HOW MANY MORE, COUNTED AGAINST THE PROJECT'S TRUE TOTAL (F5) ──────
  //
  // The streams above are drawn from the pairs this summary FETCHED — the
  // newest `limit` across every project — so counting the "more" line from
  // them reported the fetch as the measurement: `8 more` under curator, which
  // had 22 work-streams with 6 shown (16 more). The count is now the store's
  // `scopeCount` minus the DISTINCT work-streams this menu shows for the
  // project (the rows and their streams; a second computer's copy of a shown
  // work-stream is not another one), and it is said ONCE per project, on its
  // first row, so two rows of one project never count the same remainder
  // twice. Another row of the project whose own list was capped says "More
  // in Project Context…" with no number. When the store gave no total, the
  // fetched remainder is exact only if nothing was fetched short; otherwise
  // it reads "at least N".
  const fetchedShort = !!(summary && summary.truncated === true);
  for (const [k, rowsHere] of rowsByProject) {
    const p = projects.get(k);
    const shownScopes = new Set();
    for (const r of rowsHere) {
      shownScopes.add(r.scope);
      for (const st of r.streams || []) shownScopes.add(st.scope);
    }
    let count;
    let atLeast = false;
    if (p && Number.isInteger(p.scopeCount)) {
      count = Math.max(0, p.scopeCount - shownScopes.size);
    } else {
      const hidden = new Set();
      for (const r of rowsHere) {
        for (const x of r._streamsOverflow || []) if (!shownScopes.has(x.scope)) hidden.add(x.scope);
      }
      count = hidden.size;
      atLeast = fetchedShort;
    }
    const first = rowsHere[0];
    if (count > 0) {
      first.streamsHidden = count;
      first.streamsMoreLabel = (atLeast ? 'At least ' : '') + count + ' more in Project Context…';
    }
    for (const r of rowsHere) {
      if (r !== first && (r._streamsOverflow || []).length > 0) r.streamsMoreLabel = 'More in Project Context…';
    }
  }
  for (const row of activeRows.concat(overflowRows, idleRows)) delete row._streamsOverflow;

  for (const row of activeRows.concat(overflowRows, idleRows)) {
    const sub = composeSublabel(row, namesMachine(row));
    row.sublabel = sub.text;
    row.showsMachine = sub.keys.has('machine');
    row.showsModel = sub.keys.has('model');
  }

  const overflow = overflowRows.length ? {
    id: 'tray-overflow',
    label: overflowLabel(hiddenProjects, rowsOfShown),
    rows: overflowRows,
    hiddenProjects,
  } : null;

  // The Idle row: `Idle · N projects`, and the first names on line two with
  // their compact ages — `field-notes 9 d · lumina 2 wk · +2 more`.
  let idle = null;
  if (idleProjects.length) {
    const n = idleProjects.length;
    const names = idleProjects.map((p) => p.name + ' ' + compactAge(ageText(p.newest.ageSeconds, p.newest.ageSource)));
    let sub = '';
    let used = 0;
    for (let i = 0; i < names.length && i < IDLE_NAMES_SHOWN; i++) {
      const rest = n - (i + 1);
      const candidate = (sub ? sub + ' · ' : '') + names[i];
      const withRest = candidate + (rest > 0 ? ' · +' + rest + ' more' : '');
      if (withRest.length > MAX_HEADLINE_CHARS && sub) break;
      sub = candidate;
      used = i + 1;
    }
    const rest = n - used;
    const hidden = Math.max(0, n - idleShown.length);
    idle = {
      id: 'tray-idle',
      label: 'Idle · ' + n + ' ' + projectsNoun(n),
      sublabel: clip(sub + (rest > 0 ? ' · +' + rest + ' more' : ''), MAX_HEADLINE_CHARS),
      // The NEWEST idle project's tier: the mark says how recently anything
      // in this fold was touched, the same scale as every other dot.
      tier: freshnessTier(idleProjects[0].newest.ageSeconds),
      dot: renderDot(freshnessTier(idleProjects[0].newest.ageSeconds)),
      toolTip: 'Idle — no save in the last 24 hours:\n' + idleProjects.map((p) =>
        (p.projectFull || p.project) + ' · ' + ageText(p.newest.ageSeconds, p.newest.ageSource)).join('\n'),
      rows: idleRows,
      count: n,
      hidden,
      moreLabel: hidden > 0 ? hidden + ' more ' + projectsNoun(hidden) + ' in Project Context…' : null,
    };
  }

  // ── 7. THE HEADLINE — FOR THE ICON'S TOOLTIP ONLY ──────────────────────
  //
  // The menu no longer draws a headline (Layout A). The icon's hover keeps
  // the fast answer — the newest save in the store — worded as what it is:
  // `Last save: ott · Claude Code · 8 min ago`.
  const newest = listed.length ? listed[0].newest : null;
  let headline;
  if (newest) {
    // A TOOLTIP, so it is not width-budgeted: it is drawn only on hover and
    // has no menu to widen. The project is never clipped here.
    const tail = ' · ' + (newest.harness || UNKNOWN_HARNESS) + ' · ' + ageText(newest.ageSeconds, newest.ageSource);
    const name = newest.proj.name;
    headline = {
      known: newest.ageSeconds !== null,
      ageSeconds: newest.ageSeconds,
      ageSource: newest.ageSource,
      domain: newest.domain,
      project: newest.project,
      projectLabel: newest.proj.name,
      projectFull: newest.projectFull,
      route: newest.domain ? newest.domain + '/' + newest.project : newest.project,
      text: HEADLINE_PREFIX + name + tail,
      tier: freshnessTier(newest.ageSeconds),
    };
  } else {
    headline = {
      known: false, ageSeconds: null, ageSource: null,
      domain: null, project: null, projectLabel: null, projectFull: null, route: null,
      text: ok ? 'No project context yet' : 'Project context could not be read',
      tier: 'unknown',
    };
  }

  // ── 8. NOTICES — ONLY WHEN TRUE ────────────────────────────────────────
  const drawnRows = activeRows.concat(overflowRows, idleRows);
  const everyStream = drawnRows.flatMap((r) => r.streams);
  const notices = [];
  const remote = remoteNotice(summary && summary.remote);
  if (remote) notices.push(remote);
  // Over every save the menu knows of, not only the ones on its face: a
  // handoff waiting from another computer is news wherever it is filed.
  const newerElsewhere = newerElsewhereNotice(listed.flatMap((p) => p.pairs.concat(p.entries)).map((r) => ({
    ...r,
    projectLabel: r.proj.name,
    machineShort: machineLabels.get(r.machine) || r.machine,
    ageText: ageText(r.ageSeconds, r.ageSource),
  })));
  if (newerElsewhere) notices.push(newerElsewhere);
  // Every scope of the projects on screen is a row somewhere in the menu, so
  // coverage is complete when every project came with `latest`. Then the
  // producer's "scopes truncated" is not news: nothing it truncated is
  // missing from this menu.
  // Over EVERY project the summary named, not only the listed ones: a project
  // whose `latest` is null was NOT READ, so its saves are unknown and coverage
  // is not complete while any such project exists.
  const coverageComplete = listed.length > 0 && [...projects.values()].every((p) => p.fromLatest);
  const deduped = dedupeAgainstSuppliedWarnings(
    readWarnings(summary), collisionNotices(drawnRows.concat(everyStream)), coverageComplete);
  notices.push(...deduped.derived);
  // Stale documents on an ACTIVE project — the one part of the retired
  // Documents line worth an alert. Only when true.
  for (const p of activeProjects) {
    const f = p.foundations;
    if (!f || typeof f !== 'object') continue;
    const text = staleDocsText(p.name, f.staleCount, f.unreachableCount);
    if (text) {
      notices.push({
        kind: 'docs-stale', project: p.project, domain: p.domain,
        text: clip(text, PLAIN_LABEL_CHARS),
        full: staleDocsFull(p.projectFull || p.project, f.staleCount, f.unreachableCount),
      });
    }
  }
  const seenText = new Set(notices.map((n) => n.full || n.text));
  const collisionKeys = new Set(notices.filter((n) => n.kind === 'collision').map(noticeKey));
  const nameOf = (domain, project) => {
    const p = projects.get(rowGroupKey({ domain, project }));
    return p && p.name ? p.name : project;
  };
  for (const w of deduped.supplied) {
    if (w.code && SILENT_WARNING_CODES.has(w.code)) continue;
    if (w.code === WARNING_HARNESS_COLLISION && w.project && w.scope) {
      // ONE line per collided work-stream, whichever source said it first.
      const key = noticeKey(w);
      if (collisionKeys.has(key)) continue;
      collisionKeys.add(key);
      notices.push(collisionNotice(w.domain, w.project, nameOf(w.domain, w.project), w.scope, w.harnesses));
      continue;
    }
    if (seenText.has(w.message)) continue;
    seenText.add(w.message);
    notices.push({
      kind: 'warning', code: w.code,
      text: clip(w.message, PLAIN_LABEL_CHARS) || w.message,
      full: w.message,
    });
  }

  // One order for the block, whichever source produced a line: what is
  // waiting elsewhere, then the collisions (a live hazard to a handoff), then
  // stale documents, then anything else the data layer said.
  const NOTICE_RANK = { remote: 0, 'newer-elsewhere': 1, collision: 2, 'docs-stale': 3 };
  notices.sort((a, b) => (NOTICE_RANK[a.kind] ?? 4) - (NOTICE_RANK[b.kind] ?? 4));

  // ── 9. THE STANDING BRIEF — the icon's tooltip, as before ──────────────
  const rawBrief = summary && typeof summary.brief === 'object' && summary.brief ? summary.brief : null;
  const briefAge = rawBrief
    ? effectiveAgeSeconds(str(rawBrief.updatedAt), num(rawBrief.ageSeconds), nowMs)
    : null;
  // The summary's contract is the string 'agent' | 'human' | null; the store's
  // own shape (`{kind, …}`) is accepted too, because comparing that object to
  // a string is exactly how the "by an agent" clause went missing (truth audit
  // F3, v3.76.0).
  const briefKind = rawBrief && rawBrief.authoredBy && typeof rawBrief.authoredBy === 'object'
    ? rawBrief.authoredBy.kind : (rawBrief ? rawBrief.authoredBy : null);
  const briefAuthor = briefKind === 'agent' ? 'agent' : (briefKind === 'human' ? 'human' : null);
  // WHICH CLOCK (F2): the brief's own recorded write time, or — only when
  // none was recorded — the file's mtime, which a restore or a sync resets.
  // The fallback is worded as the FILE's age, never as the brief's.
  const briefFromFile = rawBrief ? rawBrief.ageSource === 'file' : false;
  const brief = rawBrief ? {
    domain: str(rawBrief.domain),
    project: str(rawBrief.project),
    projectLabel: str(rawBrief.projectLabel) || projectLabelOf(rawBrief),
    ageSeconds: briefAge,
    ageSource: briefFromFile ? 'file' : (rawBrief.ageSource === 'recorded' ? 'recorded' : null),
    authoredBy: briefAuthor,
    ageText: ageText(briefAge, null),
    text: briefAge === null ? null
      : (briefFromFile ? 'Brief file changed ' : 'Brief updated ') + ageText(briefAge, null)
        + (briefAuthor === 'agent' ? ' by an agent' : ''),
  } : null;

  // ── 10. THE PULSE, ON TOP, WITH "SAVES BY TOOL" ────────────────────────
  //
  // It moves to the top only because the headline went: the newest save is
  // then the SECOND line, not the fourth. The section header is gone too —
  // the label reads as a sentence about saves on its own, and the submenu
  // header says what the lanes are.
  const rawPulse = summary && typeof summary.pulse === 'object' && summary.pulse ? summary.pulse : null;
  const strip = renderStrip(rawPulse);
  let pulse = null;
  if (strip) {
    const tools = _harnessPulses ? (_harnessPulses(rawPulse) || []) : [];
    const toolBudget = pulseLabelBudget(strip.widthPoints);
    pulse = {
      strip,
      label: clipClauses(stripPulseNoun(_pulseLabel ? _pulseLabel(rawPulse) : null),
        pulseLabelBudget(strip.widthPoints)),
      toolTip: _pulseToolTip ? _pulseToolTip(rawPulse) : null,
      toolsHeader: 'Saves by tool · ' + (pulseStrip.windowWords ? pulseStrip.windowWords(rawPulse) : '7 days'),
      tools: tools.map((t, i) => {
        const s = renderStrip(t.pulse);
        const words = _harnessPulseLabel ? _harnessPulseLabel(t, rawPulse) : t.label;
        return {
          id: 'tray-pulse-tool-' + i,
          harnessId: t.id,
          label: clipClauses(words, toolBudget) || t.label,
          strip: s,
          toolTip: [words, t.note].filter(Boolean).join('\n'),
          events: t.events,
        };
      }),
    };
  }

  // ── 11. KNOWLEDGE · N DOMAINS — every domain, behind one row ───────────
  let domainsSection = null;
  const domainsIn = summary && Array.isArray(summary.domains) ? summary.domains : null;
  if (domainsIn && domainsIn.length) {
    const list = domainsIn
      .filter((d) => d && typeof d === 'object' && str(d.domain))
      .map((d, i) => ({
        domain: str(d.domain),
        name: str(d.displayName) || str(d.domain),
        index: Number.isInteger(d.index) && d.index >= 0 ? d.index : null,
        slot: Number.isInteger(d.slot) && d.slot >= 1 ? d.slot : null,
        pageCount: Number.isInteger(d.pageCount) && d.pageCount >= 0 ? d.pageCount : null,
        entities: Number.isInteger(d.entities) ? d.entities : null,
        concepts: Number.isInteger(d.concepts) ? d.concepts : null,
        summaries: Number.isInteger(d.summaries) ? d.summaries : null,
        order: i,
      }));
    // The denominator is the largest over EVERY domain (design rule 5's bars,
    // unchanged — they only moved into the submenu).
    const counted = list.filter((d) => d.pageCount !== null);
    const largest = counted.length ? Math.max(...counted.map((d) => d.pageCount)) : null;
    const largestName = counted.find((d) => d.pageCount === largest);
    list.sort((a, b) => {
      if (a.pageCount === null && b.pageCount === null) return a.order - b.order;
      if (a.pageCount === null) return 1;
      if (b.pageCount === null) return -1;
      if (a.pageCount !== b.pageCount) return b.pageCount - a.pageCount;
      return a.order - b.order;
    });
    const rowsOut = list.map((d) => {
      const pages = d.pageCount === null ? null
        : d.pageCount.toLocaleString('en-US') + (d.pageCount === 1 ? ' page' : ' pages');
      const frac = d.pageCount === null || largest === null ? null
        : (largest === 0 ? 0 : d.pageCount / largest);
      const ink = identityInk(d.slot);
      const b = frac === null ? null : renderBar({ frac, ...(ink ? { ink } : {}) });
      const split = [d.entities, d.concepts, d.summaries].every((v) => v !== null)
        ? d.entities + ' entities · ' + d.concepts + ' concepts · ' + d.summaries + ' summaries' : null;
      return {
        id: 'tray-domain-' + (d.index !== null ? d.index : 'x' + d.order),
        domain: d.domain,
        index: d.index,
        slot: d.slot,
        pageCount: d.pageCount,
        frac,
        ink,
        bar: b,
        label: composeBarLabel(d.name, pages || 'pages unknown', [], b ? BAR_LABEL_CHARS : PLAIN_LABEL_CHARS),
        toolTip: [d.name !== d.domain ? d.name + ' (' + d.domain + ')' : d.domain,
          pages || 'page count could not be read', split,
          largestName && largest !== null
            ? 'Bar: against the largest domain, ' + largestName.name + ' (' + largest.toLocaleString('en-US') + ' pages)'
            : null].filter(Boolean).join(' · '),
      };
    });
    const totalPages = counted.reduce((a, d) => a + d.pageCount, 0);
    domainsSection = {
      id: 'tray-knowledge',
      label: knowledgeLabel(rowsOut.length),
      header: HEADER_DOMAINS,
      toolTip: rowsOut.length + (rowsOut.length === 1 ? ' domain' : ' domains')
        + (counted.length ? ' · ' + totalPages.toLocaleString('en-US') + ' pages'
          + (counted.length < list.length ? ' counted (' + (list.length - counted.length) + ' could not be read)' : '')
          : ''),
      rows: rowsOut,
      total: list.length,
      largest,
    };
  }

  return {
    ok,
    empty: listed.length === 0,
    headline,
    pulse,
    active: { header: HEADER_ACTIVE, rows: activeRows, emptyLabel: activeRows.length ? null : NO_ACTIVE_LABEL },
    overflow,
    idle,
    domains: domainsSection,
    // Every row the menu draws, anywhere — the face, the overflow, the Idle
    // submenu and every "Other work-streams" section. The glyph, its expiry
    // timer and the suites read this; nothing is drawn from it directly.
    rows: drawnRows.concat(everyStream),
    projectsListed: listed.length,
    activeProjects: activeProjects.length,
    idleProjects: idleProjects.length,
    notices: notices.slice(0, MAX_NOTICES),
    noticesHidden: Math.max(0, notices.length - MAX_NOTICES),
    brief,
    // ── THE GLYPH CARRIES AT MOST ONE BIT BEYOND PRESENCE ───────────────
    // `live` = an agent wrote ON THIS MACHINE inside LIVE_WINDOW_SECONDS.
    // Remote rows are excluded: a pulled handoff is not an agent at work here.
    glyph: drawnRows.concat(everyStream).some((r) => r.isThisMachine && r.glyphLive) ? 'live' : 'idle',
    renderedAt: now.toISOString(),
    renderedAtText: clockText(now),
    // v3.72.1 (F7): the time the DATA was read — the stamp the menu prints.
    readAt: summary && typeof summary.readAt === 'string' && clockText(summary.readAt) ? summary.readAt : null,
    readAtText: summary && typeof summary.readAt === 'string' ? clockText(summary.readAt) : null,
  };
}

/**
 * How long until the model's `glyph` would change on its own, in ms — or null
 * if it would not. main.js arms ONE `setTimeout` at exactly this boundary,
 * only while the glyph is `live`, doing no I/O when it fires. A scheduled
 * correction, not a poll.
 */
export function liveExpiresInMs(model) {
  if (!model || model.glyph !== 'live' || !Array.isArray(model.rows)) return null;
  const ages = model.rows
    .filter((r) => r.isThisMachine && r.glyphLive && typeof r.ageSeconds === 'number')
    .map((r) => r.ageSeconds);
  if (!ages.length) return null;
  const youngest = Math.min(...ages);
  // +1s so the timer fires just PAST the boundary rather than on it.
  return Math.max(1000, Math.round((LIVE_WINDOW_SECONDS - youngest + 1) * 1000));
}
