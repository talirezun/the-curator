/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE MODEL-GONE ERROR — one sentence, one set of tags, one module.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Raised when the model a user is pinned to is no longer offered by its
 * provider. Four call sites produce it today — the OpenRouter adapter's HTTP 400
 * branch, the ingest route's pre-spend gate, the batch queue's per-item gate, and
 * the qualification preflight — and they must produce the SAME object, because
 * every one of them is read by a classifier that decides whether to spend money.
 *
 * ── WHY IT IS A LEAF MODULE WITH NO IMPORTS ────────────────────────────────
 *
 * The natural home is `llm.js`, which owns the model layer. It cannot live there
 * and also be used by `openrouter-adapter.js`: `llm.js` imports the adapter AND
 * reads one of its exports at its own top level, so importing back closes a
 * cycle that fails to load outright in the adapter-first order (measured:
 * `Cannot access 'RETRY_CLASSIFIER_TOKENS' before initialization`). A leaf module
 * has no edge to close. `llm.js` re-exports a provider-aware wrapper over this,
 * so callers there keep one import.
 *
 * ── THE WORDING IS A CONTRACT, NOT PROSE ───────────────────────────────────
 *
 * It must avoid every substring this codebase's recovery classifiers key on —
 * the rule `getProviderInfo`'s "no model is configured" throw already states.
 * Concretely, it may not contain:
 *
 *   "output token limit"  `isOutputTokenLimit` (llm.js) would route it into
 *                         ingest's and compile's fallback ladders.
 *   "not found" / "does not exist" / "model_not_found" / "404"
 *                         `isModelNotFound` (llm.js) would walk the FALLBACK
 *                         CHAIN — real calls, on a model the user never chose.
 *   "HTTP 429" / "HTTP 503" / "overloaded"
 *                         `is429`/`is503` (llm.js) would retry with backoff, and
 *                         `TRANSIENT_PATTERNS` (ingest-queue.js) would PAUSE THE
 *                         WHOLE BATCH — and pause again on every Resume, forever,
 *                         because this condition never clears with time.
 *
 * "no longer offers" carries the meaning without any of them. An offline suite
 * drives the real predicates over the real message rather than trusting this
 * comment.
 *
 * ── THE TAGS ARE THE STRUCTURAL HALF, AND THEY DO THE ACTUAL WORK ──────────
 *
 * `curatorDeterministic` is what `callLLM` checks BEFORE `isModelNotFound`, so
 * it — not the wording — is what stops the chain walk; the wording is the
 * backstop for a caller that re-wraps the error and loses the properties (the
 * case `ingest-queue.js`'s text fallback exists for). `curatorModelGone` is the
 * specific half, so a consumer can tell this from a routing-constraint refusal
 * without reading prose. `code` is the wire value the SSE frames carry.
 */

/** The wire/classification code every layer uses for this condition. */
export const MODEL_GONE_CODE = 'MODEL_GONE';

/**
 * @param {string} providerLabel  human-readable provider name, already resolved
 *   by the caller ('OpenRouter', 'Gemini', 'Claude'). Taken as a parameter
 *   rather than looked up, so this module keeps no provider table of its own —
 *   a second copy of `providerDisplayName` is exactly the drift this file exists
 *   to prevent.
 * @param {unknown} modelId
 * @returns {Error} tagged `curatorModelGone` + `curatorDeterministic`.
 */
export function modelGoneError(providerLabel, modelId) {
  // Bounded and newline-stripped. Model ids come from our own catalogue on every
  // path that reaches here, but this string is rendered and logged, and this repo
  // has a recorded log-forgery finding from echoing a caller-supplied value into
  // a user-facing message (v3.0.1-beta.20). Cheap, and it cannot be wrong.
  const shown = typeof modelId === 'string' && modelId.length > 0
    ? modelId.replace(/[\r\n]+/g, ' ').slice(0, 120)
    : 'that model';
  const label = typeof providerLabel === 'string' && providerLabel.length > 0
    ? providerLabel.replace(/[\r\n]+/g, ' ').slice(0, 40)
    : 'The provider';
  const err = new Error(`${label} no longer offers \`${shown}\` — pick another model in Settings.`);
  err.curatorModelGone = true;
  err.curatorDeterministic = true;
  err.code = MODEL_GONE_CODE;
  return err;
}
