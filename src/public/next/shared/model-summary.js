/**
 * ── THE ONE-LINE MODEL SUMMARY, DERIVED ─────────────────────────────────────
 *
 * Both model pickers — the chat composer's dropdown and Settings' provider
 * sections — render one short line per model saying how that model relates to
 * THIS app. This module builds it, and it is the ONLY place it is built.
 *
 * WHY IT EXISTS. Every offerable model carries a `note`: the measured finding,
 * written to be read verbatim, and required by `defineOfferableModel` on the
 * reasoning that "a model nobody has measured must not be offered at all". Those
 * notes are two hundred words. The composer rendered one INLINE on every flagged
 * row, and once the live OpenRouter catalogue landed, "flagged" included every
 * fetched chat-only model — so a dropdown became several screens of prose. The
 * maintainer's report was exactly that.
 *
 * The answer is NOT to shorten the notes. A measured claim cut mid-sentence can
 * invert its meaning, and deleting one would delete the evidence for a warning.
 * The note is kept whole and moved behind a disclosure; this line stands in its
 * place, unfolded.
 *
 * WHY DERIVED RATHER THAN HAND-WRITTEN. Two hand-maintained descriptions of one
 * fact is this repo's named cause of the v3.2.0 CRITICAL, and here the fact is a
 * measurement a user makes a spending decision from. Every quantitative clause
 * below reads a STRUCTURED FIELD — `outlinePagesLow/High/Median`,
 * `medianLatencyMs` — so it cannot drift from the measurement, and no number is
 * ever parsed back out of `note` prose.
 *
 * THE ONE CLAUSE THAT IS NOT DERIVED, AND WHY. `cautionReason` is a short
 * hand-written string, required by `defineOfferableModel` for any flagged model.
 * It is not a second description of the model; it is the headline of `note`,
 * length-capped so it cannot become one. It is hand-written because the reason a
 * model is flagged is a judgement rather than a number, and the two sharpest
 * warnings in the catalogue are invisible in every field here:
 * `moonshotai/kimi-k2-0905` runs away about once in nine documents, and
 * `minimax/minimax-m3:free` draws on a shared upstream pool. A derived reason
 * would have produced a confident, complete-looking line for both while omitting
 * the actual warning — which is worse than the prose it replaced.
 *
 * ABSENT IS NOT ZERO. A clause whose field is missing is OMITTED. It never
 * renders "0 pages" or "0s", which would state a measurement nobody took. Gemini
 * and Anthropic carry no latency figure because those sessions recorded none, so
 * their rows simply have no speed clause. This is the single most load-bearing
 * property in the file and it has its own mutation test.
 *
 * ORDER IS FIXED AND IT IS A PRIORITY ORDER: the warning first, then how much of
 * a wiki this plans, then how long that takes. A user scanning a dropdown reads
 * left to right and stops early.
 *
 * WHAT IS DELIBERATELY NOT HERE:
 *   • THE PRICE. It is never folded and never summarised — both surfaces render
 *     it as its own element, and a spending decision needs it unabbreviated.
 *   • `thinks`, `dominated`, `suitability`, the promotional rise. Each already
 *     has its own badge or line on BOTH surfaces; repeating them here would add
 *     text to a change whose entire purpose is removing it.
 *   • Any comparison against another model. It was tried and refused on
 *     evidence: `upstage/solar-pro4` is recorded at "median 23" in its own note
 *     and at median 25 in the second measurement session, so a computed
 *     "N pages vs the default's 23" would have contradicted the very note
 *     rendered beneath it for models measured in that later session. Each row
 *     states its OWN coverage; the rows sit in one list, so the comparison is
 *     the user's to read rather than ours to invent.
 *
 * OUTPUT IS PLAIN TEXT, NOT HTML. Callers escape. Every value here originates in
 * llm.js but arrives over an HTTP response, so neither surface may interpolate
 * it raw.
 */

/**
 * Strip ONE trailing full stop, so the clause joins cleanly with ' · '.
 *
 * Punctuation normalisation, never truncation: it removes a single '.' and only
 * when the string ends with exactly one, so an ellipsis or an abbreviation
 * survives untouched and no word is ever cut. Everything else is verbatim.
 */
function trimTrailingPeriod(s) {
  const t = String(s).trim();
  return /[^.]\.$/.test(t) ? t.slice(0, -1) : t;
}

/** A positive integer, or null. Anything else — 0, NaN, '9', null — is null. */
function posInt(v) {
  return Number.isInteger(v) && v > 0 ? v : null;
}

/**
 * How detailed a wiki this model plans from one source.
 *
 * Median when one was computed, otherwise the observed range; nothing at all
 * when neither was measured. A midpoint is NEVER invented from a range — that
 * would be a statistic nobody produced, rendered with the same confidence as one
 * that was.
 */
function coverageClause(entry) {
  const median = posInt(entry.outlinePagesMedian);
  if (median !== null) return 'plans about ' + median + ' pages per source';
  const low = posInt(entry.outlinePagesLow);
  const high = posInt(entry.outlinePagesHigh);
  // Both or neither: llm.js refuses to build an entry carrying half a range, so
  // this is belt-and-braces against a hand-built fixture rather than a real
  // entry — and it fails by omitting the clause, which is the safe direction.
  if (low === null || high === null) return '';
  if (low === high) return 'plans ' + low + ' pages per source';
  return 'plans ' + low + '-' + high + ' pages per source';
}

/**
 * A duration as "6m 22s" / "48s".
 *
 * BEHAVIOURALLY IDENTICAL TO ingest.js's `formatElapsedMs`, deliberately: that
 * function is v3.0.17's answer to "nothing happens and then suddenly something
 * happens" on ingest, and the chat thinking indicator now runs the same clock
 * for the same reason. It is re-implemented here rather than imported because
 * ingest.js keeps it private and this release does not own that file — but the
 * equality is not left to trust: the composer suite lifts ingest.js's copy out
 * by brace-match and asserts both agree across a range of inputs, so a change to
 * either side goes red naming the input.
 *
 * ONE DELIBERATE DIVERGENCE, and it is the point of this release. ingest.js
 * coerces a non-finite input to 0 and renders "0s"; this returns ''. That is
 * correct there — its input is `Date.now() - phaseStartedAt`, a duration that is
 * definitely elapsing — and wrong here, where a caller may be formatting a
 * measurement that DOES NOT EXIST, and "0s" would state a speed nobody measured.
 * Over the shared domain (finite ms >= 0) the two agree exactly, `Math.floor`
 * included, and the suite asserts that across a range.
 *
 * @param {number} ms
 * @returns {string} '' for a non-finite or negative input; "0s" for 0
 */
export function formatDurationMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? (m + 'm ' + s + 's') : (s + 's');
}

/**
 * How long one call to this model took when we measured it.
 *
 * THE CLAUSE A LIVE BUG REPORT ASKED FOR. The maintainer picked the slowest
 * model we have ever measured, waited minutes at a bare spinner, and reported
 * the app as broken; the model was answering correctly the whole time. We had
 * the number — 382s — and it appeared on no screen he was looking at. It is
 * arguably the most useful thing this line can carry, because it is the one
 * property the user will physically feel.
 *
 * It is stated as what it is — a measurement of one call — and NOT extrapolated.
 * The figure comes from an ingest outline call on a very large prompt, so a chat
 * turn on the same model will usually be quicker; claiming otherwise would be
 * over-reading our own data. Saying "per call when we measured it" keeps the
 * claim inside the evidence.
 *
 * ABSENT FOR MOST MODELS AND THAT IS CORRECT. Roughly 14 ids have a figure
 * against a synced catalogue of ~190. The rest render NO clause — never "0s",
 * never "unknown speed", and never a guess derived from price or parameter
 * count, which would be a fabricated expectation dressed as a measurement.
 */
function speedClause(entry) {
  const ms = entry.medianLatencyMs;
  // `>= 1000`, not `> 0`: below a second `formatDurationMs` renders "0s", and
  // "measured at about 0s per call" is the zero-for-absent claim this whole
  // module exists to refuse — arriving through rounding instead of a null.
  if (!Number.isFinite(ms) || ms < 1000) return '';
  return 'measured at about ' + formatDurationMs(ms) + ' per call';
}

/**
 * The clauses for one model, in priority order, with unmeasured ones omitted.
 * Returns [] for an entry carrying none — a fetched chat-only model, typically,
 * whose row then renders name, id, price and badges and nothing else.
 *
 * @param {object} entry one `OFFERABLE_MODELS` entry as served on the wire
 * @returns {string[]} plain-text clauses; the caller escapes
 */
export function modelSummaryClauses(entry, opts) {
  if (!entry || typeof entry !== 'object') return [];
  // ── TWO DENSITIES, ONE BUILDER ────────────────────────────────────────────
  // Settings is a screen someone opened deliberately to manage models; the
  // composer dropdown is a menu opened mid-thought to switch one. A collapsed
  // row should show only what a CHOICE needs — which model, what it costs, and
  // any warning — so `compact` drops the coverage clause, which is a fact you
  // consult AFTER narrowing to a candidate.
  //
  // The two surfaces must agree on VOCABULARY and on what a badge means; making
  // them identical in DENSITY is a different thing and is a mistake. One builder
  // with a flag keeps the first property while allowing the second, where two
  // hand-written variants would drift.
  //
  // THE WARNING AND THE SPEED SURVIVE COMPACT, DELIBERATELY. `cautionReason` is
  // the reason for a badge already on the row and a warning behind a click is
  // not a warning. The speed clause survives because it is four words and it is
  // the fact a live bug report proved a user needs before choosing, not after.
  const compact = !!(opts && opts.compact);
  const out = [];
  // FIRST, ALWAYS. This is the reason for a badge already on the row, and the
  // whole point of the disclosure redesign is that it stays readable without
  // opening anything. If it is ever moved below another clause, a long summary
  // can push it out of a narrow dropdown.
  if (typeof entry.cautionReason === 'string' && entry.cautionReason.trim()) {
    out.push(trimTrailingPeriod(entry.cautionReason));
  }
  if (!compact) {
    const coverage = coverageClause(entry);
    if (coverage) out.push(coverage);
  }
  const speed = speedClause(entry);
  if (speed) out.push(speed);
  return out;
}

/**
 * The clauses as one line. '' when there is nothing measured to say, so a caller
 * can render nothing rather than an empty element.
 *
 * @param {object} entry
 * @returns {string} plain text; the caller escapes
 */
export function formatModelSummary(entry, opts) {
  return modelSummaryClauses(entry, opts).join(' · ');
}
