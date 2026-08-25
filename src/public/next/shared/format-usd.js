/**
 * format-usd.js — the ONE honest USD renderer for the /next frontend.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Every token-spending action in this app is supposed to show its cost
 * BEFORE it runs. A four-decimal `toFixed(4)` breaks that promise silently:
 * any charge below $0.00005 renders as the string `$0.0000`, which a user
 * reads as FREE. That is not a rounding nit — it is a paid action labelled
 * as costing nothing, on the exact surface whose whole job is to say what
 * something costs. (Measured: the Health quick-maintenance badge on a
 * broken-link fix — four real AI calls, a real charge — could render
 * `$0.0000`.)
 *
 * The rule this module enforces:
 *
 *     A NON-ZERO COST NEVER RENDERS AS ZERO.
 *
 * A genuine zero still reads as zero (`$0.00`). Anything that would round
 * away to `$0.0000` renders as `< $0.0001` instead — which is both true and
 * unmistakably not free.
 *
 * WHY A SHARED MODULE AND NOT A COPY IN EACH VIEW
 * ------------------------------------------------
 * This repo's recorded failure shape is "a guard applied to one call site
 * rather than to the class" (v3.6.0 names four instances in one release;
 * v3.2.0's CRITICAL was two hand-maintained copies of one containment
 * check drifting apart). Two views need this formatter, so it lives in one
 * place and both IMPORT it. scripts/test-next-cost-honesty.js asserts both
 * import sites AND that neither view has re-grown a local `toFixed(4)`
 * dollar formatter.
 *
 * NOT COVERED BY THIS MODULE — stated, not implied
 * -------------------------------------------------
 * Two further `toFixed(4)` dollar renderers live in
 * src/public/next/shared/ingest-queue-logic.js (`formatUsdRange` and
 * `computeQueueSpentLabel`). Both carry the SAME defect
 * (`formatUsdRange(0.00001)` -> `$0.0000`; `computeQueueSpentLabel(0.00001,
 * true)` -> `$0.0000 spent`). They are deliberately NOT fixed here because
 * scripts/test-next-ingest-logic-drift.js pins them BYTE-IDENTICAL to their
 * originals in src/public/app.js — the shipping frontend — so fixing them
 * requires editing the shipping bundle, which is frozen. They are recorded
 * as a known follow-up rather than half-fixed in one frontend, because a
 * half-applied fix across two frontends is precisely what that drift suite
 * exists to catch.
 */

/**
 * Render a USD amount honestly.
 *
 * @param {number} n  amount in USD
 * @returns {string|null} formatted string, or null when there is no number
 *   to report (every caller already null-checks and hides the readout).
 *
 *   n is not a finite number -> null      ("no figure available")
 *   n === 0                  -> '$0.00'   (genuinely free)
 *   0 < n < 0.00005          -> '< $0.0001'  (would have been '$0.0000')
 *   0.00005 <= n < 0.01      -> '$0.0001' … '$0.0099'  (4dp, as before)
 *   n >= 0.01                -> '$0.01' …            (2dp, as before)
 *
 * The 0.00005 boundary is not arbitrary: it is exactly the point at which
 * `toFixed(4)` stops rounding to zero, so this changes the rendering of
 * precisely the values that were lying and of nothing else. Every value
 * that already rendered correctly renders byte-identically.
 *
 * A negative amount is impossible in this app (spend only accumulates), so
 * it is not special-cased into looking normal — it keeps its sign and stays
 * visibly odd rather than being silently absorbed into '$0.00'.
 */
export function formatUsdHonest(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  if (n === 0) return '$0.00';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs < 0.00005) return sign + '< $0.0001';
  if (abs < 0.01) return sign + '$' + abs.toFixed(4);
  return sign + '$' + abs.toFixed(2);
}
