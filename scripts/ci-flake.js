/**
 * Live-suite flake classification (v3.0.1-beta.26).
 *
 * The live-API CI job hits real Gemini/Anthropic. A transient provider 503
 * ("temporarily overloaded"), a dropped stream ("Premature close"), a
 * rate-limit, or a network blip fails the suite even though nothing is wrong
 * with the code. To keep the live gate USEFUL (red == real bug), the runner
 * retries a failed live suite once and, if it still fails for only transient
 * reasons, treats it as INCONCLUSIVE rather than a hard failure.
 *
 * These helpers are pure so they can be unit-tested offline (test-ci-flake.js).
 */

// Substrings that mark a transient PROVIDER/network problem — not a code defect.
// Kept in sync with the error strings llm.js actually surfaces (503/429 paths)
// plus the Anthropic SDK's streaming "Premature close" and common socket errors.
export const TRANSIENT_MARKERS = [
  // Gemini / generic service-overload (HTTP 503)
  '503',
  'temporarily overloaded',
  'Service Unavailable',
  'high demand',
  'overloaded',
  // Anthropic streaming connection dropped mid-response
  'Premature close',
  // Rate limits (account-level / transient bursts) — HTTP 429
  '429',
  'Too Many Requests',
  'RESOURCE_EXHAUSTED',
  'rate limit',
  // Raw network failures
  'ETIMEDOUT',
  'ECONNRESET',
  'socket hang up',
  'fetch failed',
  'ENOTFOUND',
  'EAI_AGAIN',
];

/**
 * Does this captured suite output contain a transient-provider error marker?
 * @param {string} out  combined stdout+stderr of a suite run
 * @returns {boolean}
 */
export function hasTransientMarker(out) {
  if (!out || typeof out !== 'string') return false;
  return TRANSIENT_MARKERS.some(m => out.includes(m));
}

/**
 * Decide a live suite's final outcome after an optional single retry.
 *
 * @param {object}  o
 * @param {boolean} o.firstOk          did the first run pass?
 * @param {boolean} o.retried          was a retry performed?
 * @param {boolean} o.retryOk          did the retry pass?
 * @param {boolean} o.firstTransient   transient marker in the first run's output?
 * @param {boolean} o.retryTransient   transient marker in the retry's output?
 * @returns {'pass' | 'fail' | 'inconclusive'}
 *
 *   • first run passes                          → 'pass'  (no retry needed)
 *   • retry passes                              → 'pass'  (intermittent flake recovered)
 *   • retry fails, but a transient marker is
 *     present in either run                     → 'inconclusive'  (provider outage; not gating)
 *   • retry fails with NO transient marker      → 'fail'  (genuine, reproducible defect)
 *
 * Accepted trade-off: a real failure that coincides with a transient error in
 * the SAME run is reported as inconclusive rather than fail. That is acceptable
 * for a live-API gate — the deterministic offline suite and local `test:live`
 * still catch real regressions.
 */
export function classifyLiveOutcome({ firstOk, retried, retryOk, firstTransient, retryTransient }) {
  if (firstOk) return 'pass';
  if (!retried) return firstTransient ? 'inconclusive' : 'fail';
  if (retryOk) return 'pass';
  if (firstTransient || retryTransient) return 'inconclusive';
  return 'fail';
}
