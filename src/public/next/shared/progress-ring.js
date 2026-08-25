// Shared: ProgressRing — the design system's circular progress indicator,
// ported from Design/the_curator_design_system/components/feedback/
// (ProgressRing.jsx + .d.ts + .prompt.md, all PRIVATE and deliberately
// outside this repository). The bundle ships React; /next is vanilla JS
// with no build step (v3.1.3, a settled decision), so this is a PORT — the
// same geometry and the same contract, emitted as an HTML string because
// that is how every /next view renders.
//
// ── THE RULE THIS COMPONENT EXISTS TO ENFORCE ─────────────────────────────
// Two concentric layers with two DIFFERENT jobs. Do not collapse them.
//
//   OUTER — the truth.  One arc segment per stage. A segment fills only
//           when that stage genuinely advances. If a stage reports nothing
//           while it runs, stageProgress stays 0, the segment stays EMPTY,
//           and that is CORRECT, not a bug to paper over.
//
//   INNER — the reassurance.  An arc plus a leading dot orbiting at a
//           constant 1.15s, whatever the progress. It is the only thing
//           moving during a long call.
//
// Never speed the orbit up to imply progress, and NEVER advance the outer
// ring to look busy. That inversion is the exact failure this component
// prevents — and this codebase has already paid for it: v3.0.17, where a
// user reported the app as hung because ingest's Phase 1 is ONE LLM call
// with no sub-progress, so the bar genuinely could not move. The answer
// then was an elapsed clock. The ring is the better answer: the outer ring
// stays honestly empty, the orbit shows the app is alive, and the elapsed
// clock moves into `sublabel` exactly as the design's own example shows
// ("stage 2 of 5 · 0:38 · Gemini 2.5 Flash Lite").
//
// ── WHY THE FUNCTIONS BELOW ARE PURE ──────────────────────────────────────
// Everything that decides geometry, tone, centre text, aria values and the
// ingest phase map is a pure function with no DOM and no fetch, so
// scripts/test-next-progress-ring.js can extract it by brace-matching and
// execute it standalone. The only impure part is `progressRingHtml`, which
// is string concatenation over those results.
//
// ── PERFORMANCE ───────────────────────────────────────────────────────────
// The orbit is a CSS animation (`curator-spin`, already defined in
// tokens/motion.css). There is no requestAnimationFrame loop anywhere in
// this module and there must never be one: this ring can be on screen for
// minutes during a large ingest. Progress updates only re-emit markup; the
// browser animates.
//
// A /next view re-renders by replacing innerHTML, which would normally
// restart the orbit at 12 o'clock on every progress event — a visible jump.
// `orbitDelaySeconds` removes that: a NEGATIVE animation-delay derived from
// a page-lifetime clock starts the fresh element at the same phase of the
// cycle the destroyed one was at, so the orbit reads as continuous across
// re-renders. It is computed once per render, never per frame.

/** Stroke widths, radii and circumferences for a given ring size.
 *  Ported verbatim from the design bundle so the two implementations
 *  cannot drift visually. */
export function ringGeometry(size) {
  const s = Number.isFinite(size) && size > 0 ? size : 48;
  const stroke = Math.max(2.5, Math.round(s * 0.09));
  const gapRing = Math.max(4, Math.round(s * 0.15));
  const rOut = (s - stroke) / 2;
  const rIn = rOut - gapRing;
  return {
    size: s,
    stroke,
    gapRing,
    rOut,
    rIn,
    cOut: 2 * Math.PI * rOut,
    cIn: 2 * Math.PI * rIn,
    c: s / 2,
  };
}

/** True when `stages` is a usable, non-empty array of stage names. */
export function isSegmented(stages) {
  return Array.isArray(stages) && stages.length > 0;
}

/** The finished state: the orbit stops and the ring settles.
 *
 *  `complete: true` is an explicit override for the case where the WORK is
 *  over but the number legitimately is not 100 — a cancelled batch, where
 *  the items never started stay unsettled forever. Without it the orbit
 *  would keep turning on a job that has stopped, which is the same class of
 *  lie as a bar that advances on its own, just pointed the other way.
 *  Never pass it to mean "close enough". */
export function isRingComplete(opts) {
  const o = opts || {};
  if (o.complete === true) return true;
  if (isSegmented(o.stages)) return (Number(o.stage) || 0) >= o.stages.length;
  return o.value != null && Number(o.value) >= 100;
}

/** One descriptor per stage segment.
 *
 *  THE HONESTY INVARIANT LIVES HERE: `fillDash` is derived from
 *  `stageProgress` and from NOTHING ELSE. It does not read a clock, it does
 *  not read the orbit, and it has no floor — a live stage reporting
 *  stageProgress 0 produces fillDash 0, i.e. a segment with no visible fill.
 *  A future "make it look busy" tweak has to break this function to happen,
 *  and the test suite mutation-proves that it would go red. */
export function ringSegments(opts) {
  const o = opts || {};
  if (!isSegmented(o.stages)) return [];
  const n = o.stages.length;
  const g = ringGeometry(o.size);
  const stage = Number.isFinite(o.stage) ? o.stage : 0;
  const raw = Number(o.stageProgress);
  const frac = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
  const gapArc = Math.min(g.cOut * 0.045, g.stroke * 1.7);
  const segLen = g.cOut / n - gapArc;

  const out = [];
  for (let i = 0; i < n; i++) {
    const done = i < stage;
    const live = i === stage;
    out.push({
      index: i,
      name: String(o.stages[i]),
      rotate: -90 + i * (360 / n),
      state: done ? 'done' : live ? 'live' : 'todo',
      trackDash: segLen,
      // No fill element at all for a stage that has not started.
      fillDash: done ? segLen : live ? segLen * frac : null,
    });
  }
  return out;
}

/** The unstaged arc: a plain 0–100 sweep. `null` when there is nothing
 *  honest to report, which renders as track + orbit only. */
export function ringValueArc(opts) {
  const o = opts || {};
  if (o.value == null || !Number.isFinite(Number(o.value))) return null;
  const g = ringGeometry(o.size);
  const v = Math.max(0, Math.min(100, Number(o.value)));
  return { dashArray: g.cOut, dashOffset: g.cOut * (1 - v / 100) };
}

/** Centre readout. 'auto' prints "2/5" when staged, the rounded number when
 *  valued, nothing when activity-only. Suppressed below 40px because the
 *  glyph is illegible at row/button sizes (the design's own specimen card
 *  gates it identically). */
export function ringCenterText(opts) {
  const o = opts || {};
  const center = o.center || 'auto';
  if (center === 'none') return null;
  const g = ringGeometry(o.size);
  if (g.size < 40) return null;
  const seg = isSegmented(o.stages);
  const n = seg ? o.stages.length : 0;
  const stage = Number.isFinite(o.stage) ? o.stage : 0;
  const frac = Number(o.stageProgress);
  if (center === 'stage' || (center === 'auto' && seg)) {
    if (!seg) return null;
    return Math.min(stage + (Number.isFinite(frac) && frac > 0 ? 1 : 0), n) + '/' + n;
  }
  if (center === 'value' || (center === 'auto' && o.value != null)) {
    if (o.value == null || !Number.isFinite(Number(o.value))) return null;
    return String(Math.round(Number(o.value)));
  }
  return null;
}

/** Tone -> modifier class. The class re-points the `--pring-color` custom
 *  property; no colour literal appears anywhere in this module or its
 *  stylesheet. Anything unrecognised falls back to accent. */
export function ringToneClass(tone) {
  if (tone === 'success') return 'pring-tone-success';
  if (tone === 'attention') return 'pring-tone-attention';
  return 'pring-tone-accent';
}

/** ARIA values. `valueNow` is null for the indeterminate case — a
 *  `role="progressbar"` with no `aria-valuenow` is the standard
 *  representation of "running, amount unknown", and inventing a number
 *  there would be the same lie the outer ring refuses to tell. */
export function ringAria(opts) {
  const o = opts || {};
  if (isSegmented(o.stages)) {
    const n = o.stages.length;
    const stage = Number.isFinite(o.stage) ? o.stage : 0;
    const raw = Number(o.stageProgress);
    const frac = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
    const pct = Math.round((Math.min(stage + frac, n) / n) * 100);
    return { determinate: true, valueNow: Math.max(0, Math.min(100, pct)) };
  }
  if (o.value == null || !Number.isFinite(Number(o.value))) {
    return { determinate: false, valueNow: null };
  }
  return { determinate: true, valueNow: Math.round(Math.max(0, Math.min(100, Number(o.value)))) };
}

/** Negative animation-delay, in seconds, that makes a freshly-created orbit
 *  resume mid-cycle instead of snapping back to 12 o'clock after a view
 *  re-render. Pure so it can be tested; the caller supplies the clock.
 *
 *  This affects PHASE ONLY. It cannot change the 1.15s period, so it can
 *  never be repurposed into "spin faster when things are going well". */
export const PRING_ORBIT_PERIOD_S = 1.15;
export function orbitDelaySeconds(nowMs) {
  const t = Number(nowMs);
  if (!Number.isFinite(t) || t < 0) return 0;
  return -((t / 1000) % PRING_ORBIT_PERIOD_S);
}

// ── The ingest phase map ──────────────────────────────────────────────────
// These five names are the phases src/brain/ingest.js ACTUALLY reports, in
// the order it reports them, not a tidy invention:
//
//   pct  4      "Saving source file…"
//   pct  8      "Extracting text from document…"
//   pct 10      "Large document — switching to multi-phase ingest…"
//   pct 12/13   "Phase 1: planning wiki structure…" / "Phase 1: retrying…"
//   pct 15      "AI is analyzing the document…"          (single-pass)
//   pct 20–78   "Phase 2: writing content, batch N of M…" (multi-phase)
//   pct 90      "Writing N wiki pages to disk…"
//   pct 93      "Syncing entity backlinks…"
//   pct 96      "Updating index…"
//   pct 100     "Done!"
//
// Only ONE band carries real sub-progress: 20–78, where the server computes
// `20 + (batchNum / totalBatches) * 58` — a genuine batch fraction. Every
// other band is a step function, so its stageProgress is 0 and its segment
// sits empty while it runs. That is the point.
//
// TWO REAL-DATA MISMATCHES, recorded rather than smoothed over:
//   1. A SINGLE-PASS ingest never enters the 20–78 band at all (15 -> 90),
//      so the "Writing" segment snaps from empty to solid. Honest — that
//      work did complete — but it never fills progressively on that path.
//   2. `wait` sub-events (retry/backoff) re-send the SAME pct, so the outer
//      ring correctly does not move during a retry. The caller signals that
//      with tone="attention"; this map deliberately knows nothing about it.
export const INGEST_STAGES = ['Saving', 'Extracting', 'Planning', 'Writing', 'Merging'];

/** Map a server-sent ingest pct onto {stage, stageProgress}. Out-of-range
 *  and non-numeric input clamp to the start rather than throwing — a
 *  malformed frame must not take the progress display down. */
export function mapIngestPctToStage(pct) {
  const p = Number(pct);
  if (!Number.isFinite(p)) return { stage: 0, stageProgress: 0 };
  if (p >= 100) return { stage: INGEST_STAGES.length, stageProgress: 0 };
  if (p >= 90) return { stage: 4, stageProgress: Math.max(0, Math.min(1, (p - 90) / 10)) };
  // The only band with genuine sub-progress.
  if (p >= 20) return { stage: 3, stageProgress: Math.max(0, Math.min(1, (p - 20) / 58)) };
  if (p >= 10) return { stage: 2, stageProgress: 0 };
  if (p >= 8) return { stage: 1, stageProgress: 0 };
  return { stage: 0, stageProgress: 0 };
}

/** processed/total -> a plain 0–100 value, or null when nothing has been
 *  reported yet. Used by the Health AI flows, whose SSE `progress` frames
 *  carry {processed, total} verbatim. `null` is the honest answer before
 *  the first frame: batch 1 is in flight and has reported nothing. */
export function ringValueFromCounts(processed, total) {
  // Number(null) is 0 and Number('') is 0, both FINITE — so a coercion-only
  // guard turns "the server has told us nothing" into "nothing has been
  // done yet", which is a claim rather than an absence. Reject the
  // non-numeric types before coercing.
  if (typeof processed !== 'number' || typeof total !== 'number') return null;
  const p = Number(processed);
  const t = Number(total);
  if (!Number.isFinite(p) || !Number.isFinite(t) || t <= 0) return null;
  return Math.max(0, Math.min(100, (p / t) * 100));
}

// Local, deliberately: importing app.js's escapeHtml from a shared module
// would couple shared/ back to the shell. Same five-entity policy.
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function attr(name, value) {
  return ' ' + name + '="' + esc(value) + '"';
}

/**
 * Render a progress ring as an HTML string.
 *
 * @param {object} opts
 *   stages        string[]|null  — segment names; the preferred mode
 *   stage         number         — 0-based index in flight; === stages.length when done
 *   stageProgress number         — 0–1 inside the current stage; 0 when it reports nothing
 *   value         number|null    — plain 0–100 when unstaged; null = activity only
 *   size          number         — 20 row · 32 compact · 48 readout · 72 empty state · 16 in a button
 *   tone          'accent'|'success'|'attention'
 *   label         string         — plain text (escaped here); present participle reads best
 *   labelHtml     string         — pre-built, ALREADY-ESCAPED markup; wins over `label`
 *   sublabel      string         — monospace second line: elapsed, counts, provider
 *   sublabelHtml  string         — pre-built, ALREADY-ESCAPED markup; wins over `sublabel`.
 *                                  Exists so a caller can keep an id on a
 *                                  sub-element it patches directly (ingest's
 *                                  #ing-elapsed clock tick) instead of being
 *                                  forced into a full re-render every second.
 *   center        'auto'|'stage'|'value'|'none'
 *   id            string         — optional id on the root span
 *   className     string         — extra classes on the root span
 *   nowMs         number         — clock for the orbit phase (defaults to Date.now())
 *
 * ACCESSIBILITY CONTRACT (asserted by the suite, not just described):
 *   - The <svg> is the progressbar. aria-valuemin/max always; aria-valuenow
 *     ONLY when determinate.
 *   - The sublabel is ALWAYS aria-hidden. It is the elapsed clock; a screen
 *     reader must not read a new number every second.
 *   - When determinate, the visible label is aria-hidden too (the svg's
 *     aria-label already carries it — one announcement, not two).
 *   - When activity-only there is no number to announce, so the root becomes
 *     role="status" aria-live="polite" and the visible label is left
 *     readable, so a change of phase is announced once.
 *   - A ring that is BOTH activity-only AND label-less carries no
 *     information a screen reader can use — the in-button spinner, where
 *     the button's own text already says "Scanning…". That case is marked
 *     aria-hidden and drops both roles, rather than contributing an empty
 *     live region and an extra progressbar to the button's accessible name.
 *     A DETERMINATE ring is never treated this way even without a label:
 *     it has a real number, so it stays a progressbar.
 */
export function progressRingHtml(opts) {
  const o = opts || {};
  const g = ringGeometry(o.size);
  const seg = isSegmented(o.stages);
  const complete = isRingComplete(o);
  const aria = ringAria(o);
  const centerText = ringCenterText(o);
  const toneClass = ringToneClass(o.tone);
  const labelHtml = o.labelHtml ? o.labelHtml : (o.label != null && o.label !== '' ? esc(o.label) : '');
  const labelPlain = o.label != null && o.label !== '' ? String(o.label) : '';
  const sublabelHtml = o.sublabelHtml
    ? o.sublabelHtml
    : (o.sublabel != null && o.sublabel !== '' ? esc(o.sublabel) : '');
  const activityOnly = !aria.determinate;
  // See the ACCESSIBILITY CONTRACT above: indeterminate AND unlabelled is
  // the decorative in-button case.
  const decorative = activityOnly && !labelPlain && !o.labelHtml && !o.sublabel && !o.sublabelHtml;

  const inner = [];

  if (seg) {
    for (const s of ringSegments(o)) {
      const rot = attr('transform', 'rotate(' + s.rotate + ' ' + g.c + ' ' + g.c + ')');
      let group = '<g' + rot + '>';
      group += '<circle class="pring-track" cx="' + g.c + '" cy="' + g.c + '" r="' + g.rOut +
        '" fill="none" stroke-width="' + g.stroke + '" stroke-linecap="butt"' +
        attr('stroke-dasharray', s.trackDash + ' ' + g.cOut) + ' />';
      if (s.fillDash !== null) {
        group += '<circle class="pring-fill" cx="' + g.c + '" cy="' + g.c + '" r="' + g.rOut +
          '" fill="none" stroke-width="' + g.stroke + '" stroke-linecap="butt"' +
          attr('stroke-dasharray', s.fillDash + ' ' + g.cOut) + ' />';
      }
      group += '</g>';
      inner.push(group);
    }
  } else {
    inner.push('<circle class="pring-track" cx="' + g.c + '" cy="' + g.c + '" r="' + g.rOut +
      '" fill="none" stroke-width="' + g.stroke + '" />');
    const arc = ringValueArc(o);
    if (arc) {
      inner.push('<circle class="pring-arc" cx="' + g.c + '" cy="' + g.c + '" r="' + g.rOut +
        '" fill="none" stroke-width="' + g.stroke + '" stroke-linecap="round"' +
        attr('stroke-dasharray', arc.dashArray) + attr('stroke-dashoffset', arc.dashOffset) +
        attr('transform', 'rotate(-90 ' + g.c + ' ' + g.c + ')') + ' />');
    }
  }

  if (complete) {
    inner.push('<circle class="pring-settled" cx="' + g.c + '" cy="' + g.c + '" r="' + g.rIn +
      '" fill="none" stroke-width="' + Math.max(1.5, g.stroke * 0.55) + '" />');
  } else {
    const delay = orbitDelaySeconds(Number.isFinite(o.nowMs) ? o.nowMs : Date.now());
    inner.push(
      '<g class="pring-orbit"' + attr('style', 'animation-delay:' + delay.toFixed(3) + 's') + '>' +
        '<circle class="pring-orbit-arc" cx="' + g.c + '" cy="' + g.c + '" r="' + g.rIn +
          '" fill="none" stroke-width="' + Math.max(1.5, g.stroke * 0.55) + '" stroke-linecap="round"' +
          attr('stroke-dasharray', (g.cIn * 0.2) + ' ' + g.cIn) +
          attr('transform', 'rotate(-90 ' + g.c + ' ' + g.c + ')') + ' />' +
        '<circle class="pring-orbit-dot" cx="' + g.c + '" cy="' + (g.c - g.rIn) + '" r="' +
          Math.max(1.7, g.stroke * 0.52) + '" />' +
      '</g>'
    );
  }

  if (centerText) {
    inner.push('<text class="pring-center" x="' + g.c + '" y="' + g.c +
      '" text-anchor="middle" dominant-baseline="central"' +
      attr('style', 'font-size:' + Math.round(g.size * 0.24) + 'px') + '>' + esc(centerText) + '</text>');
  }

  const svg =
    '<svg class="pring-svg"' +
      attr('width', g.size) + attr('height', g.size) +
      attr('viewBox', '0 0 ' + g.size + ' ' + g.size) +
      (decorative
        ? ' aria-hidden="true"'
        : ' role="progressbar" aria-valuemin="0" aria-valuemax="100"' +
          (aria.valueNow == null ? '' : attr('aria-valuenow', aria.valueNow)) +
          attr('aria-label', labelPlain || 'Progress')) +
    '>' + inner.join('') + '</svg>';

  const textBlock = (labelHtml || sublabelHtml)
    ? '<span class="pring-text">' +
        (labelHtml ? '<span class="pring-label"' + (activityOnly ? '' : ' aria-hidden="true"') + '>' + labelHtml + '</span>' : '') +
        (sublabelHtml ? '<span class="pring-sublabel mono" aria-hidden="true">' + sublabelHtml + '</span>' : '') +
      '</span>'
    : '';

  const cls = ['pring', toneClass];
  if (complete) cls.push('pring-complete');
  if (o.className) cls.push(String(o.className));

  return '<span' + attr('class', cls.join(' ')) +
    (o.id ? attr('id', o.id) : '') +
    (decorative ? '' : (activityOnly ? ' role="status" aria-live="polite"' : '')) +
    '>' + svg + textBlock + '</span>';
}
