/**
 * OpenRouter catalogue eligibility — the pure decision core.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ `eligible: true` means "nothing in the metadata disqualifies this",       │
 * │ never that it works.                                                      │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * That is the governing statement of this file. Every rule, reason code, risk
 * flag and default below is an elaboration of it, and any change that makes
 * `eligible: true` carry more meaning than that sentence is a change this
 * module exists to prevent. Eligibility is the ABSENCE of a disqualifier, which
 * is not the presence of a qualification.
 *
 * ── WHAT THIS MODULE IS, AND THE LINE IT MUST NOT CROSS ──────────────────────
 *
 * This module answers exactly one question: **given the metadata OpenRouter
 * publishes about a model, is that model ELIGIBLE to be shown to a user of The
 * Curator, and if not, precisely why?**
 *
 * Eligibility is a FACT about metadata. It is checkable, reproducible, and
 * derivable from a payload with no network and no clock.
 *
 * SUITABILITY IS NOT. Whether a model can actually plan a 20-page wiki outline
 * and return JSON that parses is a JUDGEMENT that requires MEASUREMENT — nine
 * real runs against the real prompt, which is what `docs/model-lifecycle.md`
 * demands before a model may be offered for a feature. This module therefore
 * emits FACTS and STRUCTURED REASONS and NOTHING ELSE:
 *
 *   - It never scores a model.
 *   - It never ranks or sorts by quality.
 *   - It never recommends.
 *   - It never says "good", "capable", "reliable", or "measured".
 *
 * The project's own rule: *"A machine can honestly emit '7/7 clean JSON, 14
 * pages planned'. It cannot write the verdict."* Passing every rule here means
 * "nothing in the metadata disqualifies this model". It does not mean the model
 * works. A caller that treats `eligible: true` as a quality signal has crossed
 * the line this docblock exists to draw.
 *
 * ── THE BUG CLASS THIS MODULE IS BUILT AGAINST ───────────────────────────────
 *
 * v3.15.0 found A FACT AND ITS ABSENCE COLLAPSED INTO ONE VALUE in EIGHT
 * independent places in a single release. `null` becomes `0` in arithmetic and
 * `''` in string contexts, and `''` is a substring of everything.
 *
 * The live instance that shaped this module:
 *
 *   `nex-agi/nex-n2-mini` burned its ENTIRE 24,576-token output budget on
 *   hidden reasoning and returned nothing parseable, 3 runs of 3. Its metadata
 *   is `reasoning: { "mandatory": false }` with `default_enabled` ABSENT.
 *
 *   `upstage/solar-pro4`, which measured 9/9 perfect and is the shipping
 *   default, has BYTE-IDENTICAL metadata: `reasoning: { "mandatory": false }`,
 *   `default_enabled` absent.
 *
 * A previous session read the absent `default_enabled` as "reasoning is off by
 * default". THE API NEVER CLAIMED THAT. `mandatory: false` means "you may turn
 * it off". An absent `default_enabled` means "we are not telling you what
 * happens if you don't." 74 models in the live snapshot share that shape. It
 * means UNMEASURED, not BROKEN, and it must NEVER be a rejection signal.
 *
 * ⚠ THE MAGNITUDE, WRITTEN DOWN SO NOBODY LATER "CLEANS THIS UP":
 *
 *   In the live 2026-08-28 snapshot (387 catalogue records), **59 of the 193
 *   models that pass every rule** carry `REASONING_DEFAULT_UNSTATED` — just
 *   under a third of the entire eligible set. It is the single most common risk
 *   flag this module emits.
 *
 *   Promoting it to a rejection would eject 59 models on the strength of a
 *   metadata shape that is EMPIRICALLY UNCORRELATED WITH OUTCOME: the shipping
 *   default `upstage/solar-pro4` (9/9 clean JSON) and the rejected
 *   `nex-agi/nex-n2-mini` (0/3, entire output budget spent on hidden
 *   reasoning) publish it byte-for-byte identically. A filter that cannot
 *   separate the best measured model from the worst measured model is not a
 *   filter; it is a coin flip wearing a reason code. The flag is a prompt to
 *   MEASURE, and measurement is the only thing that resolves it.
 *
 * So, throughout this module:
 *
 *   - "the API says NO"  and  "the API DID NOT SAY"  get DIFFERENT reason codes,
 *     even when both fail safe and both reject. `OUTPUT_CEILING_ZERO` is not
 *     `OUTPUT_CEILING_UNKNOWN`. `JSON_MODE_UNSUPPORTED` (an empty
 *     `supported_parameters` array — a positive statement) is not
 *     `JSON_MODE_UNKNOWN` (the key is missing).
 *   - A price of 0 (genuinely free) is NEVER represented the same way as a
 *     price we could not parse. `{ known: true, promptUsdPerMTok: 0 }` vs
 *     `{ known: false, promptUsdPerMTok: null }`.
 *   - `Number('')` is 0 and `Number(null)` is 0. Every numeric coercion in here
 *     goes through `parseNumericString` / `finiteNumberOrNull`, which refuse
 *     empty strings, null, undefined, booleans and NaN rather than silently
 *     producing a zero.
 *   - The ABSENCE of per-endpoint data NEVER reads as "no variance". It is
 *     recorded as `basis: 'model-level-representative'` with
 *     `isGuarantee: false`, and carries a risk flag saying so.
 *
 * ── PRICE IS NOT A QUALITY GATE ──────────────────────────────────────────────
 *
 * Read this before adding anything price-shaped to this module.
 *
 * The previous OpenRouter selection pass chose models BY PRICE ASCENDING, and
 * correcting that is the reason this workstream exists. The point of routing
 * The Curator through OpenRouter is to let people build a second brain on
 * open-weight models from smaller labs instead of closed ones. Whether that
 * costs more than Gemini in a given case is the USER'S decision, not ours.
 *
 * So price enters this module in exactly two places, and neither is a cost test:
 *
 *   1. `checkKnowablePrice` rejects a price of `-1`, an unparseable price, and
 *      a negative price. That is a KNOWABILITY test — can we show the user a
 *      number before they choose? — not a test of whether the number is small.
 *   2. `effectivePriceAt` computes a FACT for the caller to display.
 *
 * There is NO price ceiling here. There is NO cheapness preference. Neither
 * `filterCatalogue` nor `evaluateModel` sorts, ranks or orders by cost, and
 * nothing in this file may start doing so. Capability first; price is
 * information the user weighs.
 *
 * ── MONEY-SAFE DIRECTION ─────────────────────────────────────────────────────
 *
 * Every failure direction on price resolves to the HIGHER number, matching the
 * v3.9.0 rule that the fail-safe direction on money is to warn. If the clock is
 * unknown, a time-windowed model is quoted at its most expensive window. If the
 * prompt size is unknown, a tiered model is quoted at its most expensive tier.
 * The user is never under-quoted.
 *
 * ── PURITY ───────────────────────────────────────────────────────────────────
 *
 * No network. No filesystem. No `Date.now()`, no `new Date()` without an
 * argument, no `Math.random()`. Anything time-dependent takes `opts.now` as an
 * injected parameter so it is exhaustively testable offline. Every threshold is
 * injected via `opts`; `DEFAULT_ELIGIBILITY_OPTS` holds the documented defaults
 * and nothing in the decision path reads a literal threshold.
 *
 * ── ENFORCED ─────────────────────────────────────────────────────────────────
 *
 *   - JSON mode, knowable price, non-moving id, output ceiling, context window,
 *     each as a separately named predicate with its own reason code.
 *   - Worst-endpoint (not representative) evaluation of JSON mode, output
 *     ceiling and context window WHEN per-endpoint data is supplied.
 *   - Effective price at a given prompt size and instant, across both override
 *     kinds (`min_prompt_tokens` tiers and UTC time windows).
 *
 * ── NOT ENFORCED (named rather than implied away) ────────────────────────────
 *
 *   - Whether the model actually returns parseable JSON. `response_format` in
 *     `supported_parameters` says the endpoint ACCEPTS the parameter. It says
 *     nothing about whether the output parses. `gemini-3.5-flash-lite`, demoted
 *     for unrepairable JSON in 2 of 9 real runs, advertises full support.
 *   - Whether hidden reasoning will consume the output budget. See the
 *     solar-pro4 / nex-n2-mini pair above. Risk-flagged, never rejected.
 *   - Rate limits, uptime, throughput, latency, quantisation quality.
 *   - Whether a provider will honour the published ceiling at request time.
 *   - Text-output capability is a RISK FLAG by default, not a rejection. Set
 *     `opts.requireTextOutput` to promote it. No model in the live eligible set
 *     fails it, so switching it on would change nothing today while adding a
 *     way to be wrong tomorrow.
 *   - Expiry DOES reject by default (30-day horizon) — but only when a clock is
 *     supplied, and `opts.now` defaults to `null`. **In the default
 *     configuration the expiry rule is therefore INERT.** That is not a bug we
 *     can fix here without breaking purity: this module may not read a clock.
 *     It is mitigated instead — a declared expiry that cannot be evaluated
 *     raises `EXPIRY_UNEVALUABLE` at HIGH severity whenever a horizon is
 *     active, so a caller that forgets `now` is told loudly rather than handed
 *     a silent pass. A caller that wants the rule enforced MUST inject `now`.
 *   - Whether a far-future `expiration_date` is a genuine retirement date or a
 *     "no planned retirement" sentinel. Five live z-ai models publish
 *     `2098-12-31`; `opts.expirySentinelDays` (10 years) classifies anything
 *     beyond it as a sentinel. A publisher who announces a REAL retirement more
 *     than ten years out would be misclassified. The observed catalogue is
 *     sharply bimodal — real expiries at 3, 33 and 125 days against sentinels
 *     at ~26,000 — so the cutoff sits in the middle of a gap three orders of
 *     magnitude wide, but it is a heuristic and it is named as one here.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Defaults. Every one of these is injectable; the decision path reads only from
// the merged opts object, never from these constants directly.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The app's `MULTI_PHASE_OUTLINE_TOKENS` (src/brain/ingest.js). A model whose
 * output ceiling is below this cannot complete a Phase-1 ingest outline — the
 * call is rejected or truncated by the provider, not by us.
 *
 * Mirrored here rather than imported ON PURPOSE: this module must stay pure and
 * standalone so it can be unit-tested offline and so churn in ingest.js/llm.js
 * cannot break it. `test-openrouter-eligibility.js` asserts the two agree.
 */
export const APP_OUTPUT_FLOOR_TOKENS = 24576;

/**
 * Minimum published context window, in tokens.
 *
 * ── WHERE 200,000 COMES FROM. It is a PARITY RULE, not a round number. ───────
 *
 * `claude-haiku-4-5` is the app's shipped Anthropic default (`DEFAULTS.anthropic`
 * in src/brain/llm.js). OpenRouter's catalogue publishes it as:
 *
 *     anthropic/claude-haiku-4.5   context_length 200000   max_completion_tokens 64000
 *
 * The rule that follows: **we will not offer an OpenRouter model that is worse
 * on context than a model we already ship as a default.** If 200k is good
 * enough for Haiku 4.5, it is the floor; anything below it would be a
 * capability regression against something the user can already select.
 *
 * More is better — a million-token window matters on a large second brain — but
 * 200k is the line below which we do not go.
 *
 * ── WHY THIS IS HARDCODED AND NOT DERIVED AT RUNTIME ────────────────────────
 *
 * Deriving it from the Anthropic capability table would couple the OpenRouter
 * filter to the Anthropic catalogue: a future Anthropic edit would silently move
 * the OpenRouter eligible set, which is a failure mode nobody asked for. The
 * derivation is written down here instead, and the value stays INJECTED via
 * `opts.contextFloorTokens` so it can be revisited deliberately.
 *
 * ── HONEST NOTE ON WHAT THIS FLOOR COSTS ────────────────────────────────────
 *
 * It is a parity policy, not a measurement of what the app needs. The measured
 * requirement is roughly `promptTokens + outputFloor` ≈ 110,000. At 200,000 the
 * floor ejects the entire meta-llama family and `ibm-granite/granite-4.0-h-micro`
 * (131,000) — which is the app's current sole OpenRouter fallback rung and
 * measured 9/9 clean. That is a deliberate policy trade, and it is recorded here
 * rather than discovered later.
 */
export const APP_CONTEXT_FLOOR_TOKENS = 200000;

/**
 * Approximate token count of the app's REAL ingest outline prompt.
 *
 * Derived from the measured prompt length of ~341,005 characters at roughly
 * 4 characters per token. It is an APPROXIMATION used to select a pricing tier,
 * not a billing figure. Tier boundaries in the live catalogue sit at 32,000 /
 * 128,000 / 200,000 / 256,000 / 272,000 tokens, so this value is not near any
 * boundary and small errors in the chars-per-token ratio do not change the tier.
 */
export const APP_INGEST_PROMPT_TOKENS_APPROX = 85000;

export const DEFAULT_ELIGIBILITY_OPTS = Object.freeze({
  /** Minimum published output ceiling, in tokens. */
  outputFloorTokens: APP_OUTPUT_FLOOR_TOKENS,
  /** Minimum published context window, in tokens. */
  contextFloorTokens: APP_CONTEXT_FLOOR_TOKENS,
  /** Prompt size used to resolve `min_prompt_tokens` pricing tiers. */
  promptTokens: APP_INGEST_PROMPT_TOKENS_APPROX,
  /**
   * Which model-level field carries the context window. Legal values are the
   * two field PATHS themselves — see `CONTEXT_FIELDS`.
   *
   *   'context_length'
   *       The catalogue's headline value. It is the MAXIMUM ACROSS PROVIDERS,
   *       so it is OPTIMISTIC in exactly the way `top_provider.
   *       max_completion_tokens` is optimistic — and this module already
   *       refuses to read the optimistic field for the OUTPUT ceiling. Reading
   *       it for context was that same rule applied inconsistently.
   *
   *   'top_provider.context_length'   ← DEFAULT
   *       The value for the provider OpenRouter would route to first. Lower,
   *       and closer to what a request actually gets.
   *
   * ── WHAT THE SWITCH COSTS, MEASURED ────────────────────────────────────────
   *
   * Nine live models pass on the headline field and fail on this one. The worst
   * spread is `thedrummer/unslopnemo-12b`: 1,024,000 against 32,768 — a factor
   * of 31. The others are the qwen3-vl family, `qwen/qwen3-next-80b-a3b-
   * thinking`, `qwen/qwen3-30b-a3b-instruct-2507`, `google/gemma-3-27b-it`
   * and `z-ai/glm-5`. On the 2026-08-28 snapshot the eligible set moves
   * 203 → 194 on this change alone.
   *
   * ── NEITHER FIELD IS A FLOOR. THIS IS THE POINT. ───────────────────────────
   *
   * BOTH values are model-level SUMMARIES of a set of endpoints that disagree.
   * `context_length` summarises by MAXIMUM; `top_provider.context_length`
   * summarises by "whichever provider is first in the routing order right now",
   * which is neither a maximum nor a minimum and can change without the model
   * changing. Choosing the second over the first buys a LESS OPTIMISTIC read,
   * not a guarantee.
   *
   * ONLY per-endpoint data (`opts.endpointsById`) yields a floor, and when it
   * is supplied this field is not consulted at all — the worst endpoint governs
   * and `facts.isGuarantee` becomes true. When it is absent, `facts.basis`
   * names the exact field path that was read, so no consumer has to guess which
   * summary it is looking at.
   *
   * An UNRECOGNISED value does NOT silently fall back to the headline field —
   * that would make a typo silently optimistic. It resolves to the conservative
   * field and raises `CONTEXT_FIELD_UNRECOGNISED`.
   */
  contextField: 'top_provider.context_length',
  /**
   * Per-endpoint payloads, keyed by model id: `{ [id]: Endpoint[] }`.
   * When a model's endpoints are present, JSON mode / output ceiling / context
   * are evaluated at the WORST endpoint and marked as a guarantee. When absent,
   * the model-level representative value is used and explicitly marked NOT a
   * guarantee. Absence NEVER reads as "no variance".
   */
  endpointsById: null,
  /**
   * Injected instant, for UTC time-window pricing. Accepts a Date, an epoch-ms
   * number, or an ISO string. `null` means "we do not know what time it is",
   * which resolves every time-windowed price to its MOST EXPENSIVE window.
   */
  now: null,
  /**
   * Reject any model whose `expiration_date` falls within this many days of
   * `opts.now`. `null` disables the rejection and risk-flags only.
   *
   * ── WHY 30, AND WHY THIS REJECTS RATHER THAN WARNS ─────────────────────────
   *
   * `moonshotai/kimi-k2.5` passes every other rule in the live snapshot and
   * expires THREE DAYS after the fetch. Offering it would hand a user a model
   * that 404s inside the release's own lifetime — and it was already inside a
   * launched measurement pass, i.e. about to consume real money measuring a
   * model that would be dead before the measurement could ship.
   *
   * The precedent is explicit: v3.15.0 rejected an OpenRouter model for exactly
   * "a retirement date inside this release's own lifetime". A risk flag is the
   * right shape for a fact the user should weigh; it is the wrong shape for a
   * model that will stop existing. 30 days is roughly one release cycle.
   *
   * ⚠ REQUIRES `opts.now`. Rejection is proof-based: with no clock we cannot
   * establish that anything expires, so nothing is rejected — but
   * `EXPIRY_UNEVALUABLE` fires at HIGH severity while a horizon is active, so
   * the inability to evaluate is loud rather than a silent pass. Since
   * `opts.now` defaults to `null`, THE DEFAULT CONFIGURATION CANNOT REJECT ON
   * EXPIRY. Callers must inject a clock. This module may not read one.
   *
   * ⚠ KNIFE EDGE, recorded because it is one bad week from mattering:
   * `dots-studio/dots-3-note-preview:free` expires 33 days after the snapshot
   * and clears a 30-day horizon by three days. A release that takes longer than
   * 33 days to reach users would ship it dead. The horizon is injected so it
   * can be raised deliberately rather than discovered afterwards.
   */
  expiryHorizonDays: 30,
  /**
   * Days beyond which a declared `expiration_date` is read as a SENTINEL
   * meaning "no planned retirement" rather than as a retirement date.
   *
   * Five live z-ai models publish `2098-12-31` (~26,400 days out). That is not
   * a plan; it is a null wearing a date. But it is ALSO not an absent field —
   * the publisher chose to fill it in — so collapsing it into either "expires"
   * or "declares nothing" destroys a real distinction. It gets its own state
   * (`EXPIRY_STATES.SENTINEL`) and its own risk code (`EXPIRY_SENTINEL`).
   *
   * 10 years sits in the middle of a gap three orders of magnitude wide: the
   * real expiries in the catalogue are 3, 33 and 125 days out; the sentinels are
   * ~26,400. Injected, and named as a heuristic in NOT ENFORCED above.
   *
   * If a caller sets this at or below `expiryHorizonDays`, REJECTION WINS — an
   * incoherent configuration must not turn into a silent pass.
   */
  expirySentinelDays: 3650,
  /** When true, reject models whose declared output modalities exclude text. */
  requireTextOutput: false,
});

/**
 * Canonical rule order. The cascade funnel attributes each rejected model to the
 * FIRST rule it fails in this order, so the funnel is reproducible. Per-model
 * `reasons` are exhaustive and do NOT short-circuit.
 */
export const RULE_ORDER = Object.freeze([
  'json_mode',
  'knowable_price',
  'not_moving_alias',
  'output_ceiling',
  'context_window',
  'not_expiring',
  'text_output',
]);

/** Every rejection code this module can emit. Machine-readable, stable. */
export const REASON_CODES = Object.freeze({
  // rule: json_mode
  JSON_MODE_UNKNOWN: 'JSON_MODE_UNKNOWN',
  JSON_MODE_UNSUPPORTED: 'JSON_MODE_UNSUPPORTED',
  JSON_MODE_UNSUPPORTED_AT_ENDPOINT: 'JSON_MODE_UNSUPPORTED_AT_ENDPOINT',
  // rule: knowable_price
  PRICE_UNKNOWABLE: 'PRICE_UNKNOWABLE',
  PRICE_UNPARSEABLE: 'PRICE_UNPARSEABLE',
  // rule: not_moving_alias
  ALIAS_TILDE_PREFIX: 'ALIAS_TILDE_PREFIX',
  ALIAS_LATEST_SUFFIX: 'ALIAS_LATEST_SUFFIX',
  ALIAS_TARGET_DECLARED: 'ALIAS_TARGET_DECLARED',
  // rule: output_ceiling
  OUTPUT_CEILING_UNKNOWN: 'OUTPUT_CEILING_UNKNOWN',
  OUTPUT_CEILING_ZERO: 'OUTPUT_CEILING_ZERO',
  OUTPUT_CEILING_BELOW_FLOOR: 'OUTPUT_CEILING_BELOW_FLOOR',
  OUTPUT_CEILING_BELOW_FLOOR_AT_ENDPOINT: 'OUTPUT_CEILING_BELOW_FLOOR_AT_ENDPOINT',
  // rule: context_window
  CONTEXT_UNKNOWN: 'CONTEXT_UNKNOWN',
  CONTEXT_ZERO: 'CONTEXT_ZERO',
  CONTEXT_BELOW_FLOOR: 'CONTEXT_BELOW_FLOOR',
  CONTEXT_BELOW_FLOOR_AT_ENDPOINT: 'CONTEXT_BELOW_FLOOR_AT_ENDPOINT',
  // rule: not_expiring
  /** Expires in the future, but inside the horizon. */
  EXPIRING_WITHIN_HORIZON: 'EXPIRING_WITHIN_HORIZON',
  /**
   * The declared expiry is ALREADY IN THE PAST relative to the injected clock.
   * A separate code from EXPIRING_WITHIN_HORIZON because "it will stop working"
   * and "it has stopped working" are different facts, and a caller may want to
   * surface them differently. Both reject.
   */
  EXPIRED: 'EXPIRED',
  // rule: text_output (opt-in)
  NO_TEXT_OUTPUT: 'NO_TEXT_OUTPUT',
  // structural
  RECORD_MALFORMED: 'RECORD_MALFORMED',
});

/** Every risk code. A risk NEVER rejects — it is a fact the caller must weigh. */
export const RISK_CODES = Object.freeze({
  REASONING_MANDATORY: 'REASONING_MANDATORY',
  REASONING_DEFAULT_ON: 'REASONING_DEFAULT_ON',
  REASONING_DEFAULT_UNSTATED: 'REASONING_DEFAULT_UNSTATED',
  ENDPOINT_DATA_ABSENT: 'ENDPOINT_DATA_ABSENT',
  ENDPOINT_OUTPUT_CEILING_SPREAD: 'ENDPOINT_OUTPUT_CEILING_SPREAD',
  ENDPOINT_JSON_MODE_SPREAD: 'ENDPOINT_JSON_MODE_SPREAD',
  CONTEXT_FIELD_DISAGREEMENT: 'CONTEXT_FIELD_DISAGREEMENT',
  /** `opts.contextField` was not a recognised field path; the CONSERVATIVE field was used. */
  CONTEXT_FIELD_UNRECOGNISED: 'CONTEXT_FIELD_UNRECOGNISED',
  PRICE_TIERED_ABOVE_HEADLINE: 'PRICE_TIERED_ABOVE_HEADLINE',
  PRICE_TIME_VARIABLE: 'PRICE_TIME_VARIABLE',
  PRICE_CLOCK_UNKNOWN: 'PRICE_CLOCK_UNKNOWN',
  /** A retirement date is declared and lies inside the planning horizon's world. */
  EXPIRY_DECLARED: 'EXPIRY_DECLARED',
  /**
   * A date is declared so far out that it means "no planned retirement".
   * DELIBERATELY NOT `EXPIRY_DECLARED` (which would read as a real expiry) and
   * deliberately not silence (which would read as an absent field). Third fact,
   * third code.
   */
  EXPIRY_SENTINEL: 'EXPIRY_SENTINEL',
  /**
   * A date is declared and we COULD NOT EVALUATE IT — either no clock was
   * injected, or the string does not parse. Never rejects (rejection requires
   * proof) but fires at HIGH severity while a horizon is active, so an
   * unevaluable expiry can never read as a clean pass. `detail.reason` is
   * `'clock-unknown'` or `'unparseable-date'`.
   *
   * Before this code existed, an unparseable `expiration_date` produced NO risk
   * at all and was indistinguishable from a model that declared nothing — the
   * fact-and-its-absence collapse, inside the rule written to catch expiries.
   */
  EXPIRY_UNEVALUABLE: 'EXPIRY_UNEVALUABLE',
  NO_MAX_TOKENS_PARAM: 'NO_MAX_TOKENS_PARAM',
  NO_TEXT_OUTPUT_DECLARED: 'NO_TEXT_OUTPUT_DECLARED',
  NO_STRUCTURED_OUTPUTS: 'NO_STRUCTURED_OUTPUTS',
});

/**
 * The two legal values of `opts.contextField`, spelled as the field paths they
 * name so a caller cannot mistake one for the other. Both are model-level
 * SUMMARIES; neither is a floor. Only per-endpoint data gives a floor.
 */
export const CONTEXT_FIELDS = Object.freeze({
  /** `record.context_length` — maximum across providers. OPTIMISTIC. */
  HEADLINE: 'context_length',
  /** `record.top_provider.context_length` — first-routed provider. The default. */
  TOP_PROVIDER: 'top_provider.context_length',
});

/**
 * Expiry is a SIX-state fact, and five of the six are routinely collapsed into
 * "has an expiry / does not". Each state below is a different thing the
 * catalogue told us, or a different way it failed to tell us.
 */
export const EXPIRY_STATES = Object.freeze({
  /** No `expiration_date` field, or it is null/empty. The publisher said nothing. */
  ABSENT: 'absent',
  /** A real retirement date we could place on a timeline. */
  DECLARED: 'declared',
  /** Declared, and ALREADY PAST relative to the injected clock. */
  EXPIRED: 'expired',
  /** Declared so far out it means "no planned retirement" (see expirySentinelDays). */
  SENTINEL: 'sentinel',
  /** Declared, parseable, but NO CLOCK was injected — we cannot place it. */
  CLOCK_UNKNOWN: 'clock-unknown',
  /** Declared but the string does not parse as a date. NOT the same as absent. */
  MALFORMED: 'malformed',
});

/** Reasoning is a FIVE-state fact. Collapsing any pair of these is the bug. */
export const REASONING_STATES = Object.freeze({
  /** `reasoning` key absent entirely — the API declares no reasoning concept. */
  ABSENT: 'absent',
  /** `mandatory: true` — reasoning cannot be turned off. */
  MANDATORY: 'mandatory',
  /** optional, and the API says it IS on unless disabled. */
  OPTIONAL_DEFAULT_ON: 'optional-default-on',
  /** optional, and the API says it is OFF unless enabled. */
  OPTIONAL_DEFAULT_OFF: 'optional-default-off',
  /**
   * optional, and the API DID NOT SAY what happens by default.
   * 74 models in the live snapshot. Shared byte-for-byte by a model that
   * measured 9/9 clean and one that measured 0/3. UNMEASURED, not broken.
   */
  OPTIONAL_DEFAULT_UNSTATED: 'optional-default-unstated',
  /** `reasoning` present but not an object we recognise. */
  MALFORMED: 'malformed',
});

const MS_PER_DAY = 86400000;
const TOKENS_PER_MTOK = 1e6;
const UTC_DAY_NAMES = Object.freeze([
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Coercion helpers. These exist SOLELY to stop a fact and its absence collapsing.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A finite number, or null. Never coerces. `finiteNumberOrNull(null)` is null,
 * NOT 0 — which is the entire point, because `null >= 24576` is false but
 * `Number(null) >= 0` is true and that difference has shipped bugs here.
 */
export function finiteNumberOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Parse a price string ("0.00000003", "0", "-1") to a number, or null.
 *
 * REFUSES: null, undefined, '', '   ', booleans, arrays, objects, NaN.
 * `Number('')` is 0 and `Number(null)` is 0; a free model and an unparseable
 * one would then be indistinguishable, which is the eight-places defect.
 * '0' IS accepted and returns 0 — free is a known price.
 */
export function parseNumericString(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Normalise an injected instant to epoch ms, or null if it is not knowable. */
export function resolveInstant(now) {
  if (now === null || now === undefined) return null;
  if (now instanceof Date) {
    const t = now.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof now === 'number') return Number.isFinite(now) ? now : null;
  if (typeof now === 'string') {
    const t = Date.parse(now);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

function mergeOpts(opts) {
  return { ...DEFAULT_ELIGIBILITY_OPTS, ...(opts && typeof opts === 'object' ? opts : {}) };
}

function reason(rule, code, message, detail) {
  const r = { rule, code, message, severity: 'reject' };
  if (detail !== undefined) r.detail = detail;
  return r;
}

function risk(code, message, severity, detail) {
  const r = { code, message, severity };
  if (detail !== undefined) r.detail = detail;
  return r;
}

// ─────────────────────────────────────────────────────────────────────────────
// Endpoint helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract an endpoint array from whatever shape the caller supplies: the raw
 * `/models/:id/endpoints` payload (`{data:{endpoints:[…]}}`), a bare
 * `{endpoints:[…]}`, or the array itself. Returns null when there is NO
 * endpoint data — which is a distinct fact from "an empty endpoint list".
 */
export function extractEndpoints(payload) {
  if (payload === null || payload === undefined) return null;
  if (Array.isArray(payload)) return payload;
  if (typeof payload !== 'object') return null;
  if (Array.isArray(payload.endpoints)) return payload.endpoints;
  if (payload.data && Array.isArray(payload.data.endpoints)) return payload.data.endpoints;
  return null;
}

function endpointsFor(record, opts) {
  const map = opts.endpointsById;
  if (!map || typeof map !== 'object') return null;
  const id = typeof record?.id === 'string' ? record.id : null;
  const slug = typeof record?.canonical_slug === 'string' ? record.canonical_slug : null;
  let raw;
  if (id !== null && Object.hasOwn(map, id)) raw = map[id];
  else if (slug !== null && Object.hasOwn(map, slug)) raw = map[slug];
  else return null;
  return extractEndpoints(raw);
}

// ─────────────────────────────────────────────────────────────────────────────
// PRICING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Does an override entry declare a UTC time constraint?
 * `utc_days` ABSENT (or an empty array) means "all days" — `tencent/hy3` in the
 * live snapshot omits the key entirely and its two windows tile a full 24h.
 */
function hasTimeConstraint(o) {
  return Object.hasOwn(o, 'utc_start') || Object.hasOwn(o, 'utc_end')
    || (Array.isArray(o.utc_days) && o.utc_days.length > 0);
}

/**
 * Is `hhmm` (0..2359) inside the window [start, end)?
 * When `end <= start` the window WRAPS past midnight: `1000 -> 0` means
 * 10:00 through the end of the day. Live data contains exactly that shape.
 * End is EXCLUSIVE — the live windows share boundary values (…0-100, 100-400…)
 * and only an exclusive end makes them non-overlapping.
 */
function inWindow(hhmm, start, end) {
  if (start === null && end === null) return true;
  const s = start === null ? 0 : start;
  const e = end === null ? 2400 : end;
  if (e > s) return hhmm >= s && hhmm < e;
  if (e === s) return true;           // degenerate: covers the whole day
  return hhmm >= s || hhmm < e;       // wraps midnight
}

/**
 * Applicability of one override entry given what we know.
 *   'yes'     — every constraint it declares is satisfied.
 *   'no'      — a constraint it declares is definitively violated.
 *   'unknown' — a constraint could not be evaluated (e.g. clock unknown).
 */
function overrideApplicability(o, promptTokens, instantMs) {
  let anyUnknown = false;

  if (Object.hasOwn(o, 'min_prompt_tokens')) {
    const min = finiteNumberOrNull(o.min_prompt_tokens);
    if (min === null) {
      anyUnknown = true;                       // malformed tier: cannot exclude
    } else if (promptTokens === null) {
      anyUnknown = true;                       // prompt size unknown
    } else if (promptTokens < min) {
      return 'no';
    }
  }

  if (hasTimeConstraint(o)) {
    if (instantMs === null) {
      anyUnknown = true;
    } else {
      const d = new Date(instantMs);
      const day = UTC_DAY_NAMES[d.getUTCDay()];
      const hhmm = d.getUTCHours() * 100 + d.getUTCMinutes();
      if (Array.isArray(o.utc_days) && o.utc_days.length > 0) {
        const days = o.utc_days.map(s => String(s).toLowerCase());
        if (!days.includes(day)) return 'no';
      }
      const start = Object.hasOwn(o, 'utc_start') ? finiteNumberOrNull(o.utc_start) : null;
      const end = Object.hasOwn(o, 'utc_end') ? finiteNumberOrNull(o.utc_end) : null;
      if (!inWindow(hhmm, start, end)) return 'no';
    }
  }

  return anyUnknown ? 'unknown' : 'yes';
}

/**
 * Effective USD-per-million-token price at a given prompt size and instant.
 *
 * ── Selection semantics, and why ─────────────────────────────────────────────
 *
 * If ANY override entry DEFINITIVELY applies, the base price is SUPERSEDED and
 * the answer is the MAX over the definitively-applicable entries. If none does
 * — either none matches, or applicability could not be determined — the answer
 * is the MAX over the base price and every POSSIBLY-applicable entry.
 *
 * Worked against the live catalogue:
 *   qwen/qwen3.7-flash @ 85,000 tok  → the 32,000 tier definitively applies;
 *     base ($0.03/$0.13) is superseded → $0.10/$0.40. 3.3x the headline.
 *   qwen/qwen3.7-flash @ 1,000 tok   → no tier applies → base → $0.03/$0.13.
 *   tencent/hy3 @ 18:00 UTC          → the 16:00→00:00 window applies → the
 *     CHEAPER $0.0825, correctly, because base is superseded.
 *   tencent/hy3 @ unknown clock      → nothing definitive → MAX(base, both
 *     windows) → the DEARER $0.132.
 *   deepseek/deepseek-v4-pro-0813 @ unknown clock → MAX over all windows → the
 *     doubled weekday-peak price.
 *
 * MAX (never MIN, never average) is the money-safe direction: an unresolvable
 * constraint over-quotes, it never under-quotes.
 *
 * ── Free is a price; unparseable is not ──────────────────────────────────────
 *
 * A free model returns `{ known: true, promptUsdPerMTok: 0 }`. A model whose
 * price we could not read returns `{ known: false, promptUsdPerMTok: null }`.
 * Callers MUST branch on `known`, never on truthiness of the number — `0` is
 * falsy and that conflation is the defect this module is built against.
 *
 * @param {object} record  a raw OpenRouter model record
 * @param {number|null} promptTokens  prompt size, or null if unknown
 * @param {object} [opts]  `{ now }` — injected instant; null means unknown clock
 * @returns {{known:boolean, promptUsdPerMTok:number|null,
 *            completionUsdPerMTok:number|null, basis:string,
 *            headlinePromptUsdPerMTok:number|null,
 *            headlineCompletionUsdPerMTok:number|null,
 *            tiered:boolean, timeVariable:boolean, clockKnown:boolean,
 *            appliedOverrideCount:number, unresolvedConstraint:boolean}}
 */
export function effectivePriceAt(record, promptTokens, opts) {
  const o = mergeOpts(opts);
  const instantMs = resolveInstant(o.now);
  const pricing = (record && typeof record === 'object' && record.pricing && typeof record.pricing === 'object')
    ? record.pricing : null;

  const basePrompt = pricing ? parseNumericString(pricing.prompt) : null;
  const baseCompletion = pricing ? parseNumericString(pricing.completion) : null;

  const headlinePromptUsdPerMTok = basePrompt === null ? null : basePrompt * TOKENS_PER_MTOK;
  const headlineCompletionUsdPerMTok = baseCompletion === null ? null : baseCompletion * TOKENS_PER_MTOK;

  const overrides = pricing && Array.isArray(pricing.overrides) ? pricing.overrides : [];
  const usable = overrides.filter(x => x && typeof x === 'object');

  const tiered = usable.some(x => Object.hasOwn(x, 'min_prompt_tokens'));
  const timeVariable = usable.some(hasTimeConstraint);
  const tokens = finiteNumberOrNull(promptTokens);

  // A price we cannot read at all is NOT a zero and NOT a guess.
  if (basePrompt === null || baseCompletion === null) {
    return {
      known: false,
      promptUsdPerMTok: null,
      completionUsdPerMTok: null,
      basis: 'unparseable',
      headlinePromptUsdPerMTok,
      headlineCompletionUsdPerMTok,
      tiered, timeVariable,
      clockKnown: instantMs !== null,
      appliedOverrideCount: 0,
      unresolvedConstraint: false,
    };
  }

  const definite = [];
  const possible = [];
  for (const entry of usable) {
    const a = overrideApplicability(entry, tokens, instantMs);
    if (a === 'yes') definite.push(entry);
    else if (a === 'unknown') possible.push(entry);
  }

  let candidates;
  let basis;
  let unresolvedConstraint = false;
  if (definite.length > 0) {
    candidates = definite;
    basis = 'override-applied';
  } else if (possible.length > 0) {
    // Base is retained here because we cannot prove any override supersedes it.
    candidates = [{ prompt: pricing.prompt, completion: pricing.completion }, ...possible];
    basis = 'override-unresolved-max';
    unresolvedConstraint = true;
  } else {
    candidates = [{ prompt: pricing.prompt, completion: pricing.completion }];
    basis = 'base';
  }

  // MAX over candidates. A candidate that omits a field falls back to base for
  // that field only — overrides in the live data always carry both, but an
  // entry that omitted `completion` must not silently price completion at 0.
  let maxPrompt = -Infinity;
  let maxCompletion = -Infinity;
  for (const c of candidates) {
    const p = Object.hasOwn(c, 'prompt') ? parseNumericString(c.prompt) : null;
    const q = Object.hasOwn(c, 'completion') ? parseNumericString(c.completion) : null;
    maxPrompt = Math.max(maxPrompt, p === null ? basePrompt : p);
    maxCompletion = Math.max(maxCompletion, q === null ? baseCompletion : q);
  }

  return {
    known: true,
    promptUsdPerMTok: maxPrompt * TOKENS_PER_MTOK,
    completionUsdPerMTok: maxCompletion * TOKENS_PER_MTOK,
    basis,
    headlinePromptUsdPerMTok,
    headlineCompletionUsdPerMTok,
    tiered,
    timeVariable,
    clockKnown: instantMs !== null,
    appliedOverrideCount: definite.length,
    unresolvedConstraint,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// REASONING (never a rejection — a five-state fact)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classify a record's `reasoning` block into one of REASONING_STATES.
 *
 * The load-bearing distinction: `{mandatory:false}` with `default_enabled`
 * ABSENT is OPTIONAL_DEFAULT_UNSTATED — never OPTIONAL_DEFAULT_OFF. Reading it
 * as "off" is the error this module exists to prevent; solar-pro4 (9/9) and
 * nex-n2-mini (0/3) are byte-identical in that field.
 */
export function classifyReasoning(record) {
  const r = record && typeof record === 'object' ? record.reasoning : undefined;
  if (r === undefined || r === null) {
    return { state: REASONING_STATES.ABSENT, mandatory: null, defaultEnabled: null };
  }
  if (typeof r !== 'object' || Array.isArray(r)) {
    return { state: REASONING_STATES.MALFORMED, mandatory: null, defaultEnabled: null };
  }
  const mandatory = typeof r.mandatory === 'boolean' ? r.mandatory : null;
  const hasDefault = Object.hasOwn(r, 'default_enabled');
  const defaultEnabled = hasDefault && typeof r.default_enabled === 'boolean' ? r.default_enabled : null;

  if (mandatory === true) {
    return { state: REASONING_STATES.MANDATORY, mandatory, defaultEnabled };
  }
  if (!hasDefault || defaultEnabled === null) {
    // Includes `mandatory` absent or non-boolean: we still know nothing about
    // the default, and "we were not told" is its own state.
    return { state: REASONING_STATES.OPTIONAL_DEFAULT_UNSTATED, mandatory, defaultEnabled: null };
  }
  return {
    state: defaultEnabled ? REASONING_STATES.OPTIONAL_DEFAULT_ON : REASONING_STATES.OPTIONAL_DEFAULT_OFF,
    mandatory,
    defaultEnabled,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// INDIVIDUAL RULE PREDICATES
// Each returns { pass, reasons, facts, risks } and is independently testable.
// ─────────────────────────────────────────────────────────────────────────────

/** Rule 1 — JSON mode (`response_format` in `supported_parameters`). */
export function checkJsonMode(record, opts) {
  const o = mergeOpts(opts);
  const reasons = [], risks = [];
  const params = record?.supported_parameters;

  let modelSupports = null;              // null = "we were not told"
  if (Array.isArray(params)) {
    // An EMPTY array is a positive statement ("this model supports nothing"),
    // not an absence. 3 live models are shaped that way.
    modelSupports = params.includes('response_format');
  }
  const structuredOutputs = Array.isArray(params) ? params.includes('structured_outputs') : null;

  const eps = endpointsFor(record, o);
  let endpointSupport = null;
  if (eps !== null && eps.length > 0) {
    const flags = eps.map(e => (Array.isArray(e?.supported_parameters)
      ? e.supported_parameters.includes('response_format')
      : null));
    endpointSupport = {
      total: flags.length,
      supporting: flags.filter(f => f === true).length,
      notSupporting: flags.filter(f => f === false).length,
      unknown: flags.filter(f => f === null).length,
      all: flags.every(f => f === true),
      any: flags.some(f => f === true),
    };
  }

  const basis = endpointSupport ? 'endpoint-worst-case' : 'model-level-representative';

  if (modelSupports === null) {
    reasons.push(reason('json_mode', REASON_CODES.JSON_MODE_UNKNOWN,
      'supported_parameters is missing or not an array — the API did not tell us whether JSON mode is accepted. Refused because unknown is not the same as supported.'));
  } else if (modelSupports === false) {
    reasons.push(reason('json_mode', REASON_CODES.JSON_MODE_UNSUPPORTED,
      'supported_parameters does not include response_format — the model does not accept JSON mode.'));
  }

  if (endpointSupport && !endpointSupport.all) {
    reasons.push(reason('json_mode', REASON_CODES.JSON_MODE_UNSUPPORTED_AT_ENDPOINT,
      `${endpointSupport.notSupporting + endpointSupport.unknown} of ${endpointSupport.total} endpoints do not confirm response_format support; a request routed there cannot use JSON mode.`,
      { total: endpointSupport.total, notSupporting: endpointSupport.notSupporting, unknown: endpointSupport.unknown }));
    risks.push(risk(RISK_CODES.ENDPOINT_JSON_MODE_SPREAD,
      'JSON-mode support varies across this model\'s endpoints.', 'high',
      { supporting: endpointSupport.supporting, total: endpointSupport.total }));
  }

  if (modelSupports === true && structuredOutputs === false) {
    risks.push(risk(RISK_CODES.NO_STRUCTURED_OUTPUTS,
      'Accepts response_format but does not advertise structured_outputs — schema-constrained decoding is unavailable; JSON validity is not enforced by the provider.',
      'low'));
  }

  return {
    pass: reasons.length === 0,
    reasons,
    risks,
    facts: {
      responseFormat: modelSupports,
      structuredOutputs,
      basis,
      isGuarantee: endpointSupport !== null,
      endpointSupport,
    },
  };
}

/** Rule 2 — the price must be knowable BEFORE the call. */
export function checkKnowablePrice(record) {
  const reasons = [];
  const pricing = record?.pricing;
  const rawPrompt = pricing?.prompt;
  const rawCompletion = pricing?.completion;

  // `-1` is OpenRouter's explicit "this is a router; the price depends on where
  // it lands, and you will only find out afterwards". Distinct from unparseable.
  const sentinel = v => (typeof v === 'string' && v.trim() === '-1') || v === -1;
  if (sentinel(rawPrompt) || sentinel(rawCompletion)) {
    reasons.push(reason('knowable_price', REASON_CODES.PRICE_UNKNOWABLE,
      'Price is published as -1: unknowable until after the call. Incompatible with showing a price before the user chooses.'));
  } else {
    const p = parseNumericString(rawPrompt);
    const c = parseNumericString(rawCompletion);
    if (p === null || c === null) {
      reasons.push(reason('knowable_price', REASON_CODES.PRICE_UNPARSEABLE,
        'pricing.prompt or pricing.completion is missing, empty or not a number. Note this is NOT the same as a price of zero — a free model publishes "0".',
        { prompt: rawPrompt === undefined ? null : rawPrompt, completion: rawCompletion === undefined ? null : rawCompletion }));
    } else if (p < 0 || c < 0) {
      reasons.push(reason('knowable_price', REASON_CODES.PRICE_UNKNOWABLE,
        'Price is negative, which cannot be quoted to a user.', { prompt: p, completion: c }));
    }
  }

  return { pass: reasons.length === 0, reasons, risks: [], facts: {} };
}

/**
 * Rule 3 — the id must not be a moving target.
 *
 * THREE independent signals, because keying on the `~` prefix alone is WRONG:
 * `openai/gpt-chat-latest` is documented as always resolving to the latest
 * Instant model and carries NO `~` prefix, so a tilde-only filter admits it.
 * A user who pins that id gets a different model silently, at a different
 * price, with different measured behaviour.
 */
export function checkNotMovingAlias(record) {
  const reasons = [];
  const id = typeof record?.id === 'string' ? record.id : '';
  const tilde = id.startsWith('~');
  const latest = /-latest$/.test(id);
  const declared = record !== null && typeof record === 'object'
    && Object.hasOwn(record, 'alias_target') && record.alias_target !== null
    && record.alias_target !== undefined;

  if (tilde) {
    reasons.push(reason('not_moving_alias', REASON_CODES.ALIAS_TILDE_PREFIX,
      'The ~ prefix marks a moving alias: what it resolves to changes without notice.'));
  }
  if (latest) {
    reasons.push(reason('not_moving_alias', REASON_CODES.ALIAS_LATEST_SUFFIX,
      'The -latest suffix marks a moving alias. Checked independently of the ~ prefix because at least one live id carries the suffix WITHOUT the prefix.'));
  }
  if (declared) {
    reasons.push(reason('not_moving_alias', REASON_CODES.ALIAS_TARGET_DECLARED,
      'The record declares alias_target: the API itself says this id points at another model.'));
  }

  return {
    pass: reasons.length === 0,
    reasons,
    risks: [],
    facts: { tildePrefix: tilde, latestSuffix: latest, aliasTargetDeclared: declared },
  };
}

/**
 * Rule 4 — the published output ceiling must reach the app's floor.
 *
 * `top_provider.max_completion_tokens` is a REPRESENTATIVE value, not a floor.
 * `meta-llama/llama-3.3-70b-instruct` publishes 115,200 while 7 of its 13
 * endpoints sit below 24,576, the lowest at 2,048. So when endpoint data is
 * supplied the WORST endpoint governs and the result is a guarantee; when it is
 * not, the model-level value governs and the result is explicitly NOT one.
 *
 * `context_length` is NOT a substitute: across all 374 live models publishing
 * both, `max_completion_tokens < context_length` in 374/374 cases, so
 * substituting would falsely admit 59 models.
 */
export function checkOutputCeiling(record, opts) {
  const o = mergeOpts(opts);
  const floor = finiteNumberOrNull(o.outputFloorTokens);
  const reasons = [], risks = [];
  const rawModel = record?.top_provider?.max_completion_tokens;
  const modelLevel = finiteNumberOrNull(rawModel);

  const eps = endpointsFor(record, o);
  let endpointMin = null, endpointMax = null, endpointsBelowFloor = null, endpointUnknown = null;
  if (eps !== null && eps.length > 0) {
    const vals = eps.map(e => finiteNumberOrNull(e?.max_completion_tokens));
    const nums = vals.filter(v => v !== null);
    endpointUnknown = vals.length - nums.length;
    if (nums.length > 0) {
      endpointMin = Math.min(...nums);
      endpointMax = Math.max(...nums);
    }
    endpointsBelowFloor = floor === null ? null : vals.filter(v => v === null || v < floor).length;
  }

  const haveEndpoints = eps !== null && eps.length > 0;
  const basis = haveEndpoints ? 'endpoint-worst-case' : 'model-level-representative';

  // The value the rule is decided on.
  const governing = haveEndpoints
    ? (endpointUnknown > 0 ? null : endpointMin)
    : modelLevel;

  if (rawModel === null) {
    // `openrouter/free` publishes a literal null: the ceiling is UNKNOWN, which
    // is not the same as large, and not the same as zero.
    reasons.push(reason('output_ceiling', REASON_CODES.OUTPUT_CEILING_UNKNOWN,
      'top_provider.max_completion_tokens is null — the ceiling is unknown. Unknown is not "large"; refused.'));
  } else if (modelLevel === null) {
    reasons.push(reason('output_ceiling', REASON_CODES.OUTPUT_CEILING_UNKNOWN,
      'top_provider.max_completion_tokens is missing or not a number — the ceiling is unknown.',
      { raw: rawModel === undefined ? null : rawModel }));
  } else if (modelLevel === 0) {
    // A LITERAL zero: key present, value zero. Amazon Bedrock serves at least
    // one endpoint this way. Distinct code from "unknown" on purpose.
    reasons.push(reason('output_ceiling', REASON_CODES.OUTPUT_CEILING_ZERO,
      'top_provider.max_completion_tokens is 0 — the provider states no output capacity.'));
  } else if (floor !== null && modelLevel < floor) {
    reasons.push(reason('output_ceiling', REASON_CODES.OUTPUT_CEILING_BELOW_FLOOR,
      `Published output ceiling ${modelLevel} is below the required ${floor} tokens.`,
      { value: modelLevel, floor }));
  }

  if (haveEndpoints && floor !== null && endpointsBelowFloor > 0) {
    reasons.push(reason('output_ceiling', REASON_CODES.OUTPUT_CEILING_BELOW_FLOOR_AT_ENDPOINT,
      `${endpointsBelowFloor} of ${eps.length} endpoints publish an output ceiling below ${floor} (lowest known: ${endpointMin === null ? 'unknown' : endpointMin}). A request routed there would be truncated.`,
      { endpointsBelowFloor, total: eps.length, endpointMin, endpointMax, floor }));
    risks.push(risk(RISK_CODES.ENDPOINT_OUTPUT_CEILING_SPREAD,
      'Output ceiling varies across this model\'s endpoints.', 'high',
      { endpointMin, endpointMax, modelLevel }));
  }

  return {
    pass: reasons.length === 0,
    reasons,
    risks,
    facts: {
      value: governing,
      modelLevel,
      basis,
      isGuarantee: haveEndpoints && endpointUnknown === 0,
      endpointCount: haveEndpoints ? eps.length : null,
      endpointMin,
      endpointMax,
      endpointsBelowFloor,
      endpointUnknown,
      floor,
    },
  };
}

/**
 * Rule 5 — the context window must reach the app's floor.
 *
 * ⚠ `context_length` is the MAX across providers, so it is OPTIMISTIC in
 * exactly the way `top_provider.max_completion_tokens` is optimistic. Nine live
 * models pass on `context_length` and fail on `top_provider.context_length`
 * (worst spread `thedrummer/unslopnemo-12b`: 1,024,000 vs 32,768). The output
 * ceiling has always refused to read the optimistic field; reading it for
 * context was the same rule applied inconsistently, so the DEFAULT is now
 * `CONTEXT_FIELDS.TOP_PROVIDER`.
 *
 * BOTH fields are model-level summaries and NEITHER is a floor:
 * `context_length` summarises the endpoint set by MAXIMUM, and
 * `top_provider.context_length` reports whichever provider happens to be first
 * in the routing order — neither a maximum nor a minimum, and free to change
 * without the model changing. The switch buys a less optimistic read, not a
 * guarantee. Only per-endpoint data is a floor, and when endpoints are supplied
 * this field is not consulted at all.
 *
 * A disagreement between the two ALWAYS raises a risk flag, whichever field
 * governs — including on models that clear the floor on both, because the
 * spread itself is a fact about how little the headline number promises.
 */
export function checkContextWindow(record, opts) {
  const o = mergeOpts(opts);
  const floor = finiteNumberOrNull(o.contextFloorTokens);
  const reasons = [], risks = [];

  const rawTop = record?.context_length;
  const rawProvider = record?.top_provider?.context_length;
  const contextLength = finiteNumberOrNull(rawTop);
  const topProviderContextLength = finiteNumberOrNull(rawProvider);

  // An unrecognised token must NOT silently select the OPTIMISTIC field: a typo
  // in a caller's opts would then quietly widen the eligible set with no signal.
  // It resolves to the conservative field and raises a risk.
  const fieldRequested = o.contextField;
  const fieldRecognised = fieldRequested === CONTEXT_FIELDS.HEADLINE
    || fieldRequested === CONTEXT_FIELDS.TOP_PROVIDER;
  const useProvider = fieldRecognised ? fieldRequested === CONTEXT_FIELDS.TOP_PROVIDER : true;
  const fieldUsed = useProvider ? CONTEXT_FIELDS.TOP_PROVIDER : CONTEXT_FIELDS.HEADLINE;
  const rawModel = useProvider ? rawProvider : rawTop;
  const modelLevel = useProvider ? topProviderContextLength : contextLength;

  const eps = endpointsFor(record, o);
  let endpointMin = null, endpointMax = null, endpointsBelowFloor = null, endpointUnknown = null;
  if (eps !== null && eps.length > 0) {
    const vals = eps.map(e => finiteNumberOrNull(e?.context_length));
    const nums = vals.filter(v => v !== null);
    endpointUnknown = vals.length - nums.length;
    if (nums.length > 0) {
      endpointMin = Math.min(...nums);
      endpointMax = Math.max(...nums);
    }
    endpointsBelowFloor = floor === null ? null : vals.filter(v => v === null || v < floor).length;
  }

  const haveEndpoints = eps !== null && eps.length > 0;
  const basis = haveEndpoints ? 'endpoint-worst-case' : `model-level-representative:${fieldUsed}`;
  const governing = haveEndpoints ? (endpointUnknown > 0 ? null : endpointMin) : modelLevel;

  if (rawModel === null) {
    reasons.push(reason('context_window', REASON_CODES.CONTEXT_UNKNOWN,
      'The context window is published as null — unknown, which is not the same as large.'));
  } else if (modelLevel === null) {
    reasons.push(reason('context_window', REASON_CODES.CONTEXT_UNKNOWN,
      'The context window is missing or not a number.',
      { raw: rawModel === undefined ? null : rawModel }));
  } else if (modelLevel === 0) {
    reasons.push(reason('context_window', REASON_CODES.CONTEXT_ZERO,
      'The context window is published as 0.'));
  } else if (floor !== null && modelLevel < floor) {
    reasons.push(reason('context_window', REASON_CODES.CONTEXT_BELOW_FLOOR,
      `Published context window ${modelLevel} is below the required ${floor} tokens.`,
      { value: modelLevel, floor }));
  }

  if (haveEndpoints && floor !== null && endpointsBelowFloor > 0) {
    reasons.push(reason('context_window', REASON_CODES.CONTEXT_BELOW_FLOOR_AT_ENDPOINT,
      `${endpointsBelowFloor} of ${eps.length} endpoints publish a context window below ${floor} (lowest known: ${endpointMin === null ? 'unknown' : endpointMin}).`,
      { endpointsBelowFloor, total: eps.length, endpointMin, endpointMax, floor }));
  }

  if (!fieldRecognised) {
    risks.push(risk(RISK_CODES.CONTEXT_FIELD_UNRECOGNISED,
      `opts.contextField was ${JSON.stringify(fieldRequested)}, which is not a recognised field path; the conservative field (${CONTEXT_FIELDS.TOP_PROVIDER}) was used. An unrecognised value never falls back to the optimistic field.`,
      'high', { requested: fieldRequested === undefined ? null : fieldRequested, used: fieldUsed }));
  }

  if (contextLength !== null && topProviderContextLength !== null
      && contextLength !== topProviderContextLength) {
    // 'high' when the two fields STRADDLE the floor — there, the choice of field
    // decides the verdict, so the reader is one config change from a different
    // eligible set. Otherwise the spread is real but not verdict-bearing.
    const straddles = floor !== null
      && (contextLength >= floor) !== (topProviderContextLength >= floor);
    risks.push(risk(RISK_CODES.CONTEXT_FIELD_DISAGREEMENT,
      `context_length (${contextLength}) and top_provider.context_length (${topProviderContextLength}) disagree; the headline figure is the maximum across providers and neither field is a floor.`,
      straddles ? 'high' : 'medium',
      { contextLength, topProviderContextLength, straddlesFloor: straddles, governingField: fieldUsed }));
  }

  return {
    pass: reasons.length === 0,
    reasons,
    risks,
    facts: {
      value: governing,
      modelLevel,
      contextLength,
      topProviderContextLength,
      field: fieldUsed,
      fieldRecognised,
      basis,
      isGuarantee: haveEndpoints && endpointUnknown === 0,
      endpointCount: haveEndpoints ? eps.length : null,
      endpointMin,
      endpointMax,
      endpointsBelowFloor,
      endpointUnknown,
      floor,
    },
  };
}

/**
 * Rule 6 — the model must not expire inside the planning horizon.
 *
 * ── WHY THIS REJECTS ────────────────────────────────────────────────────────
 *
 * `moonshotai/kimi-k2.5` passes every other rule in the live snapshot and
 * expires THREE DAYS after the fetch. It was already inside a launched
 * measurement pass — i.e. real money was about to be spent measuring a model
 * that would be dead before the measurement could ship. A risk flag is the
 * right shape for a fact a user should weigh; it is the wrong shape for a model
 * that will stop existing. v3.15.0 set the precedent explicitly, rejecting an
 * OpenRouter model for "a retirement date inside this release's own lifetime".
 *
 * ── SIX STATES, BECAUSE FIVE OF THEM ARE ROUTINELY COLLAPSED ────────────────
 *
 *   ABSENT         no field, or null/empty. The publisher said nothing.
 *   DECLARED       a real date we could place on a timeline.
 *   EXPIRED        declared, and already past. Rejects, with its own code.
 *   SENTINEL       `2098-12-31` and friends — a date meaning "no planned
 *                  retirement". Five live z-ai models publish it. It is NOT an
 *                  expiry (rejecting it would eject working models) and it is
 *                  NOT an absent field (the publisher chose to fill it in), so
 *                  it gets its own state and its own risk code. Never rejects.
 *   CLOCK_UNKNOWN  parseable, but no `opts.now` — we cannot place it.
 *   MALFORMED      a string that is not a date. Before this rewrite it produced
 *                  NO risk at all and read exactly like ABSENT: the
 *                  fact-and-its-absence collapse, inside the expiry rule.
 *
 * ── FAIL-SAFE DIRECTION ─────────────────────────────────────────────────────
 *
 * Rejection is PROOF-BASED. Without a clock, or with an unparseable date, we
 * cannot establish that anything expires, so nothing is rejected — the module
 * never rejects on its own inability to evaluate, which would eject every
 * sentinel the moment a caller forgot `opts.now`. But it must not read as a
 * clean pass either, so `EXPIRY_UNEVALUABLE` fires, at HIGH severity whenever a
 * horizon is active. Flag loudly; do not silently pass; do not guess.
 *
 * ── INCOHERENT CONFIG ───────────────────────────────────────────────────────
 *
 * If `expirySentinelDays <= expiryHorizonDays` a date could satisfy both
 * "sentinel" and "inside the horizon". REJECTION WINS: the sentinel branch is
 * only reached for dates strictly beyond the sentinel threshold, and the
 * horizon test runs on `daysRemaining` regardless of state.
 */
export function checkNotExpiring(record, opts) {
  const o = mergeOpts(opts);
  const reasons = [], risks = [];

  const raw = record?.expiration_date;
  // '' is not a date, and `Date.parse('')` is NaN — but an empty string is also
  // not "the publisher declared something", so it is treated as ABSENT, not as
  // MALFORMED. A non-empty unparseable string IS a declaration we failed to read.
  const rawPresent = raw !== null && raw !== undefined
    && !(typeof raw === 'string' && raw.trim() === '');
  const parsedMs = rawPresent ? Date.parse(String(raw)) : NaN;
  const parseable = Number.isFinite(parsedMs);

  const instantMs = resolveInstant(o.now);
  const clockKnown = instantMs !== null;

  const daysRemaining = (parseable && clockKnown)
    ? (parsedMs - instantMs) / MS_PER_DAY
    : null;

  const horizon = finiteNumberOrNull(o.expiryHorizonDays);
  const sentinelDays = finiteNumberOrNull(o.expirySentinelDays);

  let state;
  if (!rawPresent) state = EXPIRY_STATES.ABSENT;
  else if (!parseable) state = EXPIRY_STATES.MALFORMED;
  else if (!clockKnown) state = EXPIRY_STATES.CLOCK_UNKNOWN;
  else if (daysRemaining < 0) state = EXPIRY_STATES.EXPIRED;
  else if (sentinelDays !== null && daysRemaining > sentinelDays) state = EXPIRY_STATES.SENTINEL;
  else state = EXPIRY_STATES.DECLARED;

  if (state === EXPIRY_STATES.MALFORMED || state === EXPIRY_STATES.CLOCK_UNKNOWN) {
    const why = state === EXPIRY_STATES.MALFORMED ? 'unparseable-date' : 'clock-unknown';
    risks.push(risk(RISK_CODES.EXPIRY_UNEVALUABLE,
      state === EXPIRY_STATES.MALFORMED
        ? `Declares an expiration_date of ${JSON.stringify(raw)}, which does not parse as a date. A declaration we cannot read is not the same as no declaration.`
        : `Declares an expiration_date of ${raw}; no clock was injected, so the remaining lifetime could not be computed and the horizon could not be applied.`,
      // HIGH while a horizon is active: the rule the caller asked for could not
      // run, and that must never look like the model having passed it.
      horizon !== null ? 'high' : 'medium',
      { expirationDate: rawPresent ? raw : null, reason: why, horizon }));
  } else if (state === EXPIRY_STATES.SENTINEL) {
    risks.push(risk(RISK_CODES.EXPIRY_SENTINEL,
      `Declares an expiration_date of ${raw}, ${Math.round(daysRemaining)} days out — beyond the ${sentinelDays}-day sentinel threshold, so it is read as "no planned retirement" rather than as a retirement date.`,
      'low',
      { expirationDate: raw, daysRemaining, sentinelDays }));
  } else if (state === EXPIRY_STATES.DECLARED || state === EXPIRY_STATES.EXPIRED) {
    risks.push(risk(RISK_CODES.EXPIRY_DECLARED,
      state === EXPIRY_STATES.EXPIRED
        ? `Declares an expiration_date of ${raw}, which is ${Math.abs(Math.round(daysRemaining))} days in the PAST.`
        : `Declares an expiration_date of ${raw} (${Math.round(daysRemaining)} days remaining).`,
      daysRemaining < 90 ? 'high' : 'low',
      { expirationDate: raw, daysRemaining }));
  }

  if (horizon !== null && daysRemaining !== null && daysRemaining <= horizon) {
    if (daysRemaining < 0) {
      reasons.push(reason('not_expiring', REASON_CODES.EXPIRED,
        `Expired ${raw}, ${Math.abs(Math.round(daysRemaining))} days ago.`,
        { expirationDate: raw, daysRemaining, horizon }));
    } else {
      reasons.push(reason('not_expiring', REASON_CODES.EXPIRING_WITHIN_HORIZON,
        `Expires ${raw}, within the ${horizon}-day horizon.`,
        { expirationDate: raw, daysRemaining, horizon }));
    }
  }

  return {
    pass: reasons.length === 0,
    reasons,
    risks,
    facts: {
      expirationDate: rawPresent ? raw : null,
      daysRemaining,
      state,
      /** A date string is PRESENT. True for a sentinel; `state` is the discriminator. */
      hasExpiry: rawPresent,
      isSentinel: state === EXPIRY_STATES.SENTINEL,
      clockKnown,
      horizon,
      sentinelDays,
    },
  };
}

/**
 * Rule 7 (opt-in) — the model must be able to emit text.
 *
 * Off by default: no model in the live eligible set fails it, so switching it on
 * would change nothing today while adding a way to be wrong tomorrow. Always
 * risk-flagged when the declaration is absent or excludes text.
 */
export function checkTextOutput(record, opts) {
  const o = mergeOpts(opts);
  const reasons = [], risks = [];
  const mods = record?.architecture?.output_modalities;
  const declared = Array.isArray(mods) ? mods.map(String) : null;
  const emitsText = declared === null ? null : declared.includes('text');

  if (emitsText === null) {
    risks.push(risk(RISK_CODES.NO_TEXT_OUTPUT_DECLARED,
      'architecture.output_modalities is missing — whether the model emits text was not stated.', 'medium'));
    if (o.requireTextOutput) {
      reasons.push(reason('text_output', REASON_CODES.NO_TEXT_OUTPUT,
        'Output modalities were not declared, so text output could not be confirmed.'));
    }
  } else if (emitsText === false) {
    risks.push(risk(RISK_CODES.NO_TEXT_OUTPUT_DECLARED,
      `Declared output modalities (${declared.join(', ')}) do not include text.`, 'high', { declared }));
    if (o.requireTextOutput) {
      reasons.push(reason('text_output', REASON_CODES.NO_TEXT_OUTPUT,
        `Declared output modalities (${declared.join(', ')}) do not include text.`, { declared }));
    }
  }

  return { pass: reasons.length === 0, reasons, risks, facts: { outputModalities: declared, emitsText } };
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Evaluate one model record against every rule.
 *
 * EXHAUSTIVE: it does not short-circuit, so `reasons` carries EVERY rule the
 * model fails. (The cascade funnel in `filterCatalogue` attributes a model to
 * its first failing rule, which is a different question.)
 *
 * @param {object} record  one entry from OpenRouter's `/models` `data` array
 * @param {object} [opts]  see DEFAULT_ELIGIBILITY_OPTS
 * @returns {{id:string|null, eligible:boolean, reasons:Array, facts:object, riskFlags:Array}}
 */
export function evaluateModel(record, opts) {
  const o = mergeOpts(opts);

  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return {
      id: null,
      eligible: false,
      reasons: [reason('json_mode', REASON_CODES.RECORD_MALFORMED,
        'The catalogue entry is not an object and could not be evaluated.')],
      facts: {},
      riskFlags: [],
    };
  }

  const id = typeof record.id === 'string' ? record.id : null;

  const checks = {
    json_mode: checkJsonMode(record, o),
    knowable_price: checkKnowablePrice(record),
    not_moving_alias: checkNotMovingAlias(record),
    output_ceiling: checkOutputCeiling(record, o),
    context_window: checkContextWindow(record, o),
    not_expiring: checkNotExpiring(record, o),
    text_output: checkTextOutput(record, o),
  };

  const reasons = [];
  const riskFlags = [];
  for (const rule of RULE_ORDER) {
    const c = checks[rule];
    reasons.push(...c.reasons);
    riskFlags.push(...c.risks);
  }

  if (id === null) {
    reasons.unshift(reason('json_mode', REASON_CODES.RECORD_MALFORMED,
      'The catalogue entry has no string id.'));
  }

  // ── Facts that are never rejections ────────────────────────────────────────
  const reasoning = classifyReasoning(record);
  if (reasoning.state === REASONING_STATES.MANDATORY) {
    riskFlags.push(risk(RISK_CODES.REASONING_MANDATORY,
      'Reasoning cannot be disabled. Hidden reasoning tokens are billed as output and share the answer\'s budget, so the usable output is smaller than the published ceiling.',
      'high'));
  } else if (reasoning.state === REASONING_STATES.OPTIONAL_DEFAULT_ON) {
    riskFlags.push(risk(RISK_CODES.REASONING_DEFAULT_ON,
      'Reasoning is on unless explicitly disabled; hidden reasoning tokens share the output budget.', 'medium'));
  } else if (reasoning.state === REASONING_STATES.OPTIONAL_DEFAULT_UNSTATED) {
    riskFlags.push(risk(RISK_CODES.REASONING_DEFAULT_UNSTATED,
      'Reasoning is optional but the API does not state what happens by default. This is UNMEASURED, not broken: one model with exactly this metadata measured 9/9 clean and another spent its entire output budget on hidden reasoning. Only a real run can tell them apart.',
      'medium'));
  }

  const price = effectivePriceAt(record, o.promptTokens, o);
  if (price.known && price.tiered
      && price.headlinePromptUsdPerMTok !== null
      && price.promptUsdPerMTok > price.headlinePromptUsdPerMTok) {
    riskFlags.push(risk(RISK_CODES.PRICE_TIERED_ABOVE_HEADLINE,
      `Tiered pricing: at ${o.promptTokens} prompt tokens the effective input price is $${price.promptUsdPerMTok.toFixed(4)}/Mtok against a headline of $${price.headlinePromptUsdPerMTok.toFixed(4)}/Mtok.`,
      'high',
      { effective: price.promptUsdPerMTok, headline: price.headlinePromptUsdPerMTok, promptTokens: o.promptTokens }));
  }
  if (price.timeVariable) {
    riskFlags.push(risk(RISK_CODES.PRICE_TIME_VARIABLE,
      'Price varies by UTC time of day and/or day of week.', 'medium'));
    if (!price.clockKnown) {
      riskFlags.push(risk(RISK_CODES.PRICE_CLOCK_UNKNOWN,
        'The clock was not supplied, so this model is quoted at its most expensive window. The real price may be lower; it will never be higher.',
        'low'));
    }
  }

  const params = record.supported_parameters;
  if (Array.isArray(params) && !params.includes('max_tokens')) {
    riskFlags.push(risk(RISK_CODES.NO_MAX_TOKENS_PARAM,
      'Does not accept max_tokens. Every Curator call passes an output cap, so the cap would be silently ignored.',
      'high'));
  }

  const eps = endpointsFor(record, o);
  if (eps === null) {
    riskFlags.push(risk(RISK_CODES.ENDPOINT_DATA_ABSENT,
      'No per-endpoint data was supplied. JSON mode, output ceiling and context window were read from representative model-level values, which are NOT floors. This is not a guarantee — absence of endpoint data is not evidence of no variance.',
      'medium'));
  }

  return {
    id,
    eligible: reasons.length === 0,
    reasons,
    riskFlags,
    facts: {
      jsonMode: checks.json_mode.facts,
      alias: checks.not_moving_alias.facts,
      outputCeiling: checks.output_ceiling.facts,
      context: checks.context_window.facts,
      expiry: checks.not_expiring.facts,
      modality: checks.text_output.facts,
      reasoning,
      price,
      endpoints: { supplied: eps !== null, count: eps === null ? null : eps.length },
    },
  };
}

/**
 * Evaluate a whole catalogue and report a cascade funnel.
 *
 * The funnel attributes each rejected model to the FIRST rule it fails in
 * `RULE_ORDER`, so the per-stage counts compose: each stage's `out` is the next
 * stage's `in`. That is what makes "where did models go" answerable for a user
 * and for the maintainer. Per-model `reasons` remain exhaustive.
 *
 * @param {Array} records  the `data` array from `/models`
 * @param {object} [opts]  see DEFAULT_ELIGIBILITY_OPTS
 * @returns {{total:number, eligible:Array, rejected:Array, funnel:Array, opts:object}}
 */
export function filterCatalogue(records, opts) {
  const o = mergeOpts(opts);
  const list = Array.isArray(records) ? records : [];

  const evaluated = list.map(r => evaluateModel(r, o));

  const firstFailedRule = ev => {
    for (const rule of RULE_ORDER) {
      if (ev.reasons.some(x => x.rule === rule)) return rule;
    }
    return null;
  };

  const funnel = [];
  let remaining = evaluated.length;
  for (const rule of RULE_ORDER) {
    const lost = evaluated.filter(ev => firstFailedRule(ev) === rule);
    funnel.push({
      rule,
      in: remaining,
      out: remaining - lost.length,
      lost: lost.length,
      lostIds: lost.map(ev => ev.id),
    });
    remaining -= lost.length;
  }

  return {
    total: evaluated.length,
    eligible: evaluated.filter(ev => ev.eligible),
    rejected: evaluated.filter(ev => !ev.eligible),
    funnel,
    opts: {
      outputFloorTokens: o.outputFloorTokens,
      contextFloorTokens: o.contextFloorTokens,
      promptTokens: o.promptTokens,
      contextField: o.contextField,
      expiryHorizonDays: o.expiryHorizonDays,
      expirySentinelDays: o.expirySentinelDays,
      requireTextOutput: o.requireTextOutput,
      endpointDataSupplied: !!(o.endpointsById && typeof o.endpointsById === 'object'),
      clockSupplied: resolveInstant(o.now) !== null,
    },
  };
}
