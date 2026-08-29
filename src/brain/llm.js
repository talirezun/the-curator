/**
 * LLM abstraction layer — supports Anthropic Claude and Google Gemini.
 *
 * Provider selection (automatic):
 *   1. .curator-config.json keys (set via Settings UI)
 *   2. .env file keys (developer fallback)
 *   Gemini takes priority if both providers have keys.
 *
 * Optional override:
 *   LLM_MODEL=<model-id>   override the default model for whichever provider is active
 */

import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { getEffectiveKey, getActiveProvider, getApiKeys, getSelectedModel } from './config.js';
// RETRY_CLASSIFIER_TOKENS / MODEL_NOT_FOUND_CLAUSES are the census of message
// substrings the recovery classifiers below key on. They are DECLARED in the
// adapter, beside the neutralisers that must strip them, and imported here so
// the load-time guard beside `is429`/`is503` can prove the two ends still agree.
// The import direction is the only one available — the adapter's sole import is
// the (itself import-free) eligibility module, so it cannot reach back into this
// file without forming a cycle.
import {
  OpenRouterAdapter,
  RETRY_CLASSIFIER_TOKENS,
  MODEL_NOT_FOUND_CLAUSES,
  fetchOpenRouterCatalogue,
  buildOpenRouterCatalogue,
} from './openrouter-adapter.js';
// User-data path + atomic write for the persisted OpenRouter catalogue. `fs` is
// already on the MCP child's import graph (config.js), so this adds no new
// capability to that process; `userDataPath` is resolved PER CALL, never
// snapshotted at module load (v3.1.0).
import { readFileSync } from 'fs';
import { userDataPath } from './paths.js';
import { writeFileAtomicSync } from './atomic-write.js';
// The absolute-path scrubber, from its own LEAF module. Deliberately not from
// ingest-queue.js, where it used to live: that module imports THIS one, so the
// import would be a cycle and would drag the ingest queue and health.js into
// the MCP child's import graph, where a stray stdout write corrupts JSON-RPC.
import { scrubPaths } from './scrub-paths.js';

/**
 * The providers this module can dispatch to.
 *
 * ONE PREDICATE, NOT ELEVEN HAND-MAINTAINED COPIES. Before OpenRouter this file
 * carried the literal test `provider !== 'gemini' && provider !== 'anthropic'`
 * (and its ternary forms) in about a dozen places. Every one of them would have
 * needed the same edit to admit a third provider, and the ones that were MISSED
 * would not have failed loudly — they would have quietly resolved a third
 * provider to the Anthropic arm of a binary ternary. That is exactly the
 * `p.id === 'gemini' ? A : B` shape that produced the v3.10.1 credential bug,
 * where a third provider's key would have been POSTed into the Anthropic slot
 * and silently overwritten a real credential.
 *
 * Order is NOT precedence — precedence lives in resolveProviderDefault.
 */
const KNOWN_PROVIDERS = Object.freeze(['gemini', 'anthropic', 'openrouter']);

/**
 * Is this a provider this module can dispatch to?
 *
 * Membership is tested with `includes` over a frozen array of literals, so
 * `'__proto__'`, `'constructor'` and `'toString'` are structurally unable to
 * pass — there is no object indexed by the caller's string anywhere on this
 * path (the v3.0.9 normalizeResponseStyle bug shape, closed by construction
 * rather than by remembering to call Object.hasOwn).
 */
export function isKnownProvider(provider) {
  return typeof provider === 'string' && KNOWN_PROVIDERS.includes(provider);
}

/** Human-facing provider name for error messages. Never used for dispatch. */
function providerDisplayName(provider) {
  switch (provider) {
    case 'gemini':     return 'Gemini';
    case 'anthropic':  return 'Claude';
    case 'openrouter': return 'OpenRouter';
    default:           return 'AI provider';
  }
}

/**
 * ── PER-PROVIDER REMEDY LINKS ────────────────────────────────────────────────
 *
 * A transient-failure message has to tell the user where to look NEXT, and that
 * destination is provider-specific. Before this table both the 429 and the 503
 * message interpolated the provider NAME correctly and then hardcoded GOOGLE's
 * remedy — so an OpenRouter user who hit a rate limit was told to "consider
 * upgrading at ai.google.dev/pricing", and an Anthropic outage sent them to
 * status.cloud.google.com.
 *
 * WHY IT READ AS FIXED FOR SO LONG: v3.0.4 made the provider NAME dynamic and
 * left the figures and the links Google's. The sentence therefore named the
 * right provider and the wrong vendor in one breath, which is far harder to
 * notice than a message that is wrong throughout — and it survived every later
 * pass because the obvious tell (a hardcoded "Gemini") was already gone.
 * Fixing the name is not fixing the message. This table exists so the two
 * halves cannot drift apart again.
 *
 * DELIBERATELY NO RATE-LIMIT FIGURES. The removed text asserted "~15
 * requests/min and ~20-50 requests/day" for EVERY provider. Those are Google
 * free-tier numbers, they move, and v3.15.0 records this project declining to
 * print free-tier limits precisely because they could not be verified. An
 * unverifiable number on an error screen is worse than none: it is the one
 * thing a frustrated user will act on. We link the provider's own limits page,
 * which is authoritative and stays current without us having to track it.
 *
 * UNKNOWN PROVIDER ⇒ NO LINK, never a default one. `null` here makes the
 * message degrade to generic advice that is still correct ("check your
 * provider's own status page"). Falling back to any one vendor is exactly the
 * defect being fixed, so a future provider added to KNOWN_PROVIDERS without an
 * entry here says less rather than something false.
 *
 * URLs verified 2026-08-29: each returned HTTP 200.
 */
const PROVIDER_REMEDIES = Object.freeze({
  gemini: Object.freeze({
    statusUrl: 'https://status.cloud.google.com',
    limitsUrl: 'https://ai.google.dev/gemini-api/docs/rate-limits',
  }),
  anthropic: Object.freeze({
    statusUrl: 'https://status.anthropic.com',
    limitsUrl: 'https://docs.anthropic.com/en/api/rate-limits',
  }),
  openrouter: Object.freeze({
    statusUrl: 'https://status.openrouter.ai',
    limitsUrl: 'https://openrouter.ai/docs/api-reference/limits',
  }),
});

/**
 * Remedy links for a provider id, or null when we have none.
 *
 * Own-property lookup rather than a bare `PROVIDER_REMEDIES[provider]`: a bare
 * index returns Object.prototype members for `__proto__` / `constructor` /
 * `toString`, and this repo has shipped that exact bug twice (v3.0.9's
 * prototype-key finding; v3.13.0, where a naive index returned a FUNCTION).
 * A function reaching the template literal below would render
 * "[object Function]" into the user's error message.
 */
function providerRemedies(provider) {
  if (typeof provider !== 'string') return null;
  if (!Object.hasOwn(PROVIDER_REMEDIES, provider)) return null;
  return PROVIDER_REMEDIES[provider];
}

/**
 * ── THE TWO TRANSIENT-FAILURE MESSAGES ───────────────────────────────────────
 *
 * Pure builders, extracted from `generateText` so a suite can execute them for
 * every provider — including ones whose SDK has no injectable client — instead
 * of proving their content with a source regex. A test that asserts a line of
 * source exists proves nothing about what it renders (v3.0.17).
 *
 * LOAD-BEARING LITERALS, none of which may be reworded. Several classifiers
 * read these finished messages as text:
 *   - "(HTTP 429)" / "(HTTP 503)" — `ingest-queue.js` MESSAGE_PATTERNS, the
 *     fallback used when a wrapped error has lost the structured tag. Losing
 *     these stops a rate limit PAUSING the batch, so 30 files would fail one
 *     by one against a provider that has said stop.
 *   - "429" / "503" / "temporarily overloaded" — `is429`/`is503` here,
 *     `isTransientLlmError` in sharedbrain.js (which uses them to keep a
 *     provider blip off a page's permanent-skip strike counter), and
 *     `hasTransientMarker` in scripts/ci-flake.js (which keeps a provider
 *     outage from reddening the live CI gate).
 * The remedy CLAUSES are free to change; the diagnosis clauses are not.
 */
function buildRateLimitMessage(providerName, providerId, delaySec) {
  const remedies = providerRemedies(providerId);
  const limitsAdvice = remedies
    ? `${providerName}'s current limits for your account tier are documented at ${remedies.limitsUrl}.`
    : `Check your provider's own rate-limit documentation for the limits that apply to your account.`;
  return (
    `⚠ Rate limit hit on ${providerName} (HTTP 429). This is an upstream limit on your API account, ` +
    `not an issue with The Curator. Limits differ by provider and by the tier your account is on, and a ` +
    `bulk operation such as a large ingest can reach them even on a paid plan. ` +
    `Please wait ${delaySec} seconds and try again. ${limitsAdvice} ` +
    `You can also switch to a different provider in Settings.`
  );
}

function buildServiceUnavailableMessage(providerName, providerId) {
  const remedies = providerRemedies(providerId);
  const statusAdvice = remedies
    ? `check ${remedies.statusUrl}`
    : `check your provider's own status page`;
  return (
    `⚠ ${providerName} infrastructure is temporarily overloaded (HTTP 503). This is a transient backend ` +
    `issue on the provider's side — it affects ALL accounts equally (free and paid), and is NOT a ` +
    `problem with The Curator or your API key. The Curator already retried 4 times with backoff over ` +
    `~40 seconds. What to do: wait 2–3 minutes and try again; if the issue persists, ${statusAdvice} ` +
    `or temporarily switch to a different provider in Settings.`
  );
}

// DELIBERATELY UNCHANGED in the 2026-08-24 chain repair. Both ids were probed
// live that day and both remain the CHEAPEST working model on their provider
// (gemini-2.5-flash-lite $0.10/$0.40; claude-haiku-4-5 $1/$5 — every live
// alternative on each provider costs strictly more). Project policy is explicit
// that the fallback chain is INSURANCE, not a migration: repairing dead rungs
// must never quietly move users onto a newer or costlier default. Bump these
// only when the pinned model is actually retired, or on a deliberate, separately
// justified cost/quality decision.
const DEFAULTS = {
  gemini:    'gemini-2.5-flash-lite',
  // Haiku is the low-cost tier, matching the cost profile of
  // gemini-2.5-flash-lite. See docs/model-lifecycle.md for rationale.
  //
  // ⚠ JSON FENCING (measured 2026-08-26 with the real buildOutlinePrompt via
  // ingest.js's __testing export): claude-haiku-4-5 wraps its ingest-outline
  // response in ```json fences 3/3 live runs, so raw JSON.parse fails 3/3 and
  // every ingest on this default depends on parseJSON's jsonrepair fallback to
  // strip the fence. claude-sonnet-4-5 and claude-opus-4-5 showed the same 3/3
  // fenced behaviour; everything 4.6-and-later (claude-sonnet-4-6,
  // claude-sonnet-5) returned bare JSON and parsed raw 3/3. This is benign
  // today — parseJSON is deliberately lenient for exactly this reason — but it
  // means the fence-stripping path is not a rare edge case on Anthropic, it is
  // the normal case for the pinned default. Do not "simplify" parseJSON to a
  // bare JSON.parse without re-measuring this.
  anthropic: 'claude-haiku-4-5',
  /**
   * `DEFAULTS[provider]` is the model that ingest, Health and Compile run on,
   * so this id is chosen on MEASURED reliability first and price second.
   *
   * Pinned 2026-08-27 after a live pass against this repo's real ingest outline
   * prompt (see OFFERABLE_MODELS.openrouter for the method). solar-pro4 was
   * 9/9 raw-parseable JSON with zero hidden reasoning tokens and a median of 23
   * outline pages — the only candidate that was simultaneously clean, richly
   * covering and reliably reachable.
   *
   * The two it beat, and why neither is the default:
   *   • minimax/minimax-m3:free is FREE and covered slightly wider (median 21,
   *     range 15-40), but free ids draw on a SHARED upstream pool. In the same
   *     session four of its free siblings returned "temporarily rate-limited
   *     upstream" on 8 of 8 polls. A default is what runs when the user has
   *     chosen nothing, and it must not be a shared queue that can stall a
   *     40-call multi-phase ingest. It stays offerable as a deliberate pick.
   *   • ibm-granite/granite-4.0-h-micro is ~43% cheaper on input and equally
   *     clean, but plans a median of 9 pages against solar-pro4's 23 on the
   *     identical prompt. Halving outline coverage by default would degrade
   *     every wiki built on it to save a fraction of a cent per call.
   *
   * Still an affordability win: $0.03/$0.12 per 1M tokens is roughly a third of
   * gemini-2.5-flash-lite ($0.10/$0.40), previously the cheapest model here.
   *
   * Chat is a separate lane and is unaffected: it passes an explicit per-call
   * model, so it never reads this value.
   */
  openrouter: 'upstage/solar-pro4',
};

/**
 * CONSERVATIVE default output cap for an Anthropic model we do not recognise.
 *
 * Our ingest/compile call sites request 65536 (correct for Gemini 2.5 Flash,
 * which allows it) and the Anthropic API rejects anything above the model's own
 * ceiling with "max_tokens: N > <cap>" — so the Anthropic branch clamps.
 * Anthropic is the ONLY provider clamped; Gemini keeps the full 65536.
 *
 * The value 64000 is the cap of the Curator's Anthropic default
 * (claude-haiku-4-5) and is deliberately the FALLBACK for any id absent from
 * the table below. The asymmetry is the whole point: guessing HIGH produces a
 * hard 400 that fails the call outright, while guessing LOW merely truncates —
 * and truncation already degrades gracefully (handleOutputTokenLimit returns a
 * partial answer in text mode, and ingest/compile have fallback ladders in JSON
 * mode). An unknown model must therefore resolve to this, never to 128000.
 *
 * The symbol keeps its original name, value and meaning so every existing
 * consumer is unaffected; per-model caps are read via anthropicMaxOutputTokens().
 */
export const ANTHROPIC_MAX_OUTPUT_TOKENS = 64000;

/**
 * Per-model output ceilings, keyed by EXACT model id.
 *
 * Scope mirrors MODEL_PRICES_USD_PER_MTOK: DEFAULTS.anthropic, every rung of
 * FALLBACK_CHAINS.anthropic, every entry of OFFERABLE_MODELS.anthropic, plus the
 * dated snapshot each alias resolves to (a user can pin one through the
 * LLM_MODEL dev override). `defineOfferableModel` REFUSES to build an entry for
 * an id absent from this map, so "offerable but uncapped" is unrepresentable.
 *
 * A flat 64000 constant was correct while Haiku was the only Anthropic model the
 * app could ever run. It is NOT correct now that the fallback chain lands on
 * Sonnet: claude-sonnet-5 and claude-sonnet-4-6 both allow 128,000, so a flat
 * clamp silently halved their real ceiling. Verified 2026-08-24 against the live
 * API — both `GET /v1/models/{id}`.max_tokens and the API's own validation error
 * ("max_tokens: 999999 > 128000") agree, and a 128000 request through the app's
 * exact messages.stream() shape was accepted.
 *
 * NOTE the ceiling is NOT monotonic with recency: claude-sonnet-4-5 is newer than
 * Haiku 3.5 yet caps at 64,000 like Haiku 4.5, while the older-numbered
 * claude-sonnet-4-6 allows 128,000. Do not infer a cap from a family or version
 * word — look it up, exactly as the price table exists for the same reason.
 */
const ANTHROPIC_MODEL_MAX_OUTPUT_TOKENS = {
  'claude-haiku-4-5':           64000,   // current default
  'claude-haiku-4-5-20251001':  64000,   // dated snapshot the alias resolves to
  'claude-sonnet-5':           128000,   // fallback rung 1
  'claude-sonnet-4-6':         128000,   // fallback rung 2
  'claude-sonnet-4-5':          64000,   // fallback rung 3 — NOT 128k, despite being Sonnet
  'claude-sonnet-4-5-20250929': 64000,   // dated snapshot the alias resolves to
  // Offerable-only ids (never reached by the fallback chain, pickable by a user).
  // The pattern here is GENERATIONAL, not chronological: everything in the "4.5
  // generation" caps at 64,000 and everything 4.6-and-later at 128,000 — which is
  // why claude-opus-4-5 sits at 64,000 while the numerically-adjacent
  // claude-opus-4-8 doubles it. Verified against the provider's published caps
  // 2026-08-26. Still keyed EXACTLY, never derived from the version word: the
  // moment a cap is inferred from a family name it is a heuristic, and this repo
  // has already been bitten twice by exactly that (the price-tier heuristic below,
  // and the pre-2026-08-24 flat 64000 clamp that silently halved Sonnet's ceiling).
  'claude-opus-5':             128000,
  'claude-opus-4-8':           128000,
  'claude-opus-4-5':            64000,   // NOT 128k — the 4.5 generation caps low
};
Object.freeze(ANTHROPIC_MODEL_MAX_OUTPUT_TOKENS);

/**
 * Per-model output ceilings for Gemini.
 *
 * ⚠ READ THIS BEFORE WIRING IT INTO callProvider: it is DECLARATIVE DATA for the
 * offerable-model catalogue only, and is deliberately NOT used to clamp a Gemini
 * request. Gemini CLAMPS an over-large `maxOutputTokens` server-side rather than
 * rejecting it (the Anthropic API returns a hard 400 — "max_tokens: 65536 >
 * 64000" — which is the entire reason the Anthropic clamp exists). Adding a
 * client-side Gemini clamp would be a behaviour change with no failure to fix,
 * so this map exists so the UI can TELL a user what ceiling a model has, and for
 * nothing else.
 *
 * Every Flash-line model probed on 2026-08-26 reported the same 65,536 ceiling.
 * The map is still per-id rather than one shared constant for the same reason
 * the Anthropic map is: the day a Gemini model ships with a different ceiling,
 * a constant would be silently wrong for it while a missing key makes
 * `defineOfferableModel` refuse the model outright.
 */
const GEMINI_MODEL_MAX_OUTPUT_TOKENS = {
  'gemini-2.5-flash-lite': 65536,   // current default
  'gemini-3.1-flash-lite': 65536,
  'gemini-3.5-flash-lite': 65536,
  'gemini-2.5-flash':      65536,
  'gemini-3.7-flash':      65536,
  'gemini-3.6-flash':      65536,
  'gemini-3.5-flash':      65536,
};
Object.freeze(GEMINI_MODEL_MAX_OUTPUT_TOKENS);

/**
 * Per-model output ceilings for OpenRouter — EMPTY, and empty on purpose.
 *
 * OpenRouter publishes `top_provider.max_completion_tokens` per model (411 of
 * 417 carry one; 6 are null), so a ceiling is READABLE for most ids. It is not
 * hardcoded here because an OpenRouter id routes over rotating upstream hosts:
 * the same id can be served by a different provider tomorrow, so a value frozen
 * into this file is a snapshot of a fact that can move WITHOUT the id changing.
 * Dynamically-admitted entries carry their own measured/read ceiling instead
 * (see defineOfferableModel's `spec.maxOutput`).
 */
const OPENROUTER_MODEL_MAX_OUTPUT_TOKENS = Object.freeze({});

/**
 * The provider's output-cap map, or null for a provider we do not dispatch to.
 *
 * Replaces `provider === 'gemini' ? GEMINI_CAPS : ANTHROPIC_CAPS` — a BINARY
 * ternary with no third arm and an unvalidated `provider`, which resolved every
 * unknown provider to the Anthropic map. Harmless while a third provider was
 * unreachable; a silent wrong answer the moment one existed.
 */
function capsFor(provider) {
  switch (provider) {
    case 'gemini':     return GEMINI_MODEL_MAX_OUTPUT_TOKENS;
    case 'anthropic':  return ANTHROPIC_MODEL_MAX_OUTPUT_TOKENS;
    case 'openrouter': return OPENROUTER_MODEL_MAX_OUTPUT_TOKENS;
    default:           return null;
  }
}

/**
 * ── PRICE POSTURE: a model must be PRICED or EXPLICITLY FREE ─────────────────
 *
 * `{input: 0, output: 0}` looks like the natural way to record a free model and
 * is the single most dangerous shape available here. It is TRUTHY, so:
 *   • `getModelPrice()` returns an object rather than null;
 *   • the ingest estimator's `usdHigh` becomes 0;
 *   • `createJob`'s budget guard ACCEPTS a `budgetUsd` it believes it can
 *     enforce, then tracks spend at zero forever while every flag reports
 *     success. That is v3.3.0's inert-cap defect re-armed — and worse, because
 *     there the number at least moved.
 *   • `compareModelCost` answers 'similar' instead of 'unknown', so the
 *     fallback banner asserts parity it has not established.
 *
 * So a free model is recorded by MEMBERSHIP here, never by a zero price, and
 * `getModelPrice()` keeps returning **null** for it. That part is right and is
 * the whole design.
 *
 * ⚠ THIS BLOCK ONCE CLAIMED "every downstream consequence of that null is
 * already implemented and already correct", and named three. ALL THREE WERE
 * WRONG. Nobody noticed until the first free model was actually admitted to the
 * catalogue and the paths were EXECUTED — which is the entire argument for
 * shipping a free model rather than reasoning about one:
 *
 *   1. `chargeForItem` did NOT merely flip `spendIsEstimated`. Falling past the
 *      priced branch, it returned `estimate.usdHigh / plannedCount` — an
 *      INVENTED figure, measured at $0.14 for a model that bills nothing, and
 *      identical for every token shape including the {0,0,0,0} sentinel,
 *      because it is decoupled from usage entirely. Now guarded by
 *      `isFreeModel` BEFORE the priced branch: a free model charges a true 0
 *      and the flag stays false, because zero-for-free is a MEASUREMENT, not an
 *      estimate.
 *   2. `createJob` refusing a dollar cap on a free model was not "meaningless",
 *      it was actively LESS SAFE. The refusal is a 400, so the user retries
 *      with NO cap — and if the run then walks onto a priced fallback rung they
 *      have no protection at all. A cap is now accepted for a free model: it
 *      sits trivially unreached while the model is free and engages for real
 *      the moment a priced model answers. An unpriced NON-free model is still
 *      refused.
 *   3. The cost readouts did NOT "render nothing". The chat composer rendered
 *      "price unavailable" and Settings rendered blank — both claiming we do
 *      not know a price we know exactly. `free: true` was on the wire and read
 *      by nobody: this repo's dead-data shape, sixth instance.
 *
 * The v3.14.0 rule still governs and is unchanged: a figure is reported or
 * absent, NEVER inferred. Free is *reported* zero, which is why it may render
 * as free and must never render as `$0.00`.
 *
 * DO NOT restore a summary sentence here asserting the downstream is "correct".
 * State what is enforced and where, so the next reader can check it.
 *
 * IDENTIFY FREE BY THE `:free` SUFFIX, NEVER BY PRICE === 0. Measured on
 * OpenRouter's live catalogue 2026-08-27: 17 ids carry `:free`, 20 are
 * zero-priced, and the 3 zero-priced ids that are NOT `:free` are two audio
 * models and `openrouter/free` — a ROUTER, whose real price is unknown until it
 * has routed. Treating "price is 0" as "free" would admit a router with an
 * unknowable bill.
 *
 * Membership is HAND-TYPED from the `:free` suffix on a model we measured, so
 * that admitting one can never be done by typing a zero into the price table.
 */
const FREE_MODELS = Object.freeze(new Set([
  // Measured live 2026-08-27 against the real buildOutlinePrompt (341,005 chars
  // built from the real `articles` domain — 127,666-char index, 607 entities,
  // 2,685 concepts, plus an 80,000-char source at ingest's own TEXT_CAP).
  // 9 runs: 8 raw-clean JSON, 1 needing jsonrepair, 0 unrepairable, 15-40
  // outline pages. Deliberately absent from MODEL_PRICES_USD_PER_MTOK so
  // getModelPrice() keeps returning null for it.
  'minimax/minimax-m3:free',
]));

/**
 * Free ids admitted through `defineOfferableModel`, split by LIFETIME.
 *
 * `_dynamicFree` holds ids from OpenRouter's runtime catalogue and is on
 * exactly the same lifecycle as `_dynamicPrices`: `setOpenRouterCatalogue`
 * CLEARS it and rebuilds it, so a free registration can never outlive the offer
 * it came with. That matters in the money-LOSING direction — an id that is free
 * today and PAID in tomorrow's catalogue would otherwise keep `isFreeModel`
 * true, and `chargeForItem` checks freeness first and returns a hard 0, so a
 * real bill would be recorded as $0.00.
 *
 * `_staticFree` holds ids from the hand-typed table, which is built once at
 * module load and never reloaded, so clearing it would silently un-free a
 * shipped entry the first time a catalogue arrived. Two sets rather than one
 * flag, because the two really do have different lifetimes.
 *
 * Neither replaces FREE_MODELS: that stays the hand-typed, MEASURED list, and
 * it is what `isFreeModel` answers from for every shipped id.
 */
const _staticFree = new Set();
const _dynamicFree = new Set();

/**
 * True for a model we know bills nothing. MEMBERSHIP, never a price test.
 *
 * ── ONE AUTHORITY, BECAUSE TWO DISAGREED ────────────────────────────────────
 * `entry.free` (the flag every UI reads) and this function (what `chargeForItem`
 * reads) were two independent derivations of one fact, bound by nothing.
 * MEASURED with the real `chargeForItem` on an entry carrying `free: true`
 * whose id was absent here: **$0.140000 charged, `spendIsEstimated: true`** —
 * an invented figure for a model every surface in the app labelled "free",
 * which is precisely the defect v3.15.0 shipped to close, arriving through a
 * different door. And it was not a hypothetical maintainer slip: the runtime
 * catalogue mints `free: true` for EVERY `:free` id OpenRouter publishes, and
 * none of those are in the hand-typed set.
 *
 * They cannot disagree now because `defineOfferableModel` REGISTERS a
 * dynamically-admitted free id here and then reads `entry.free` back OUT of
 * this function — the flag is no longer derived in parallel, it is a copy of
 * this answer. On the static path a mismatch is refused at module load instead.
 */
export function isFreeModel(modelId) {
  if (typeof modelId !== 'string') return false;
  return FREE_MODELS.has(modelId) || _staticFree.has(modelId) || _dynamicFree.has(modelId);
}

/**
 * Register an id admitted through the offer factory as free.
 *
 * Gated on the `:free` SUFFIX — the project's OWN structural identification
 * rule, stated in FREE_MODELS' docblock ("IDENTIFY FREE BY THE `:free` SUFFIX,
 * NEVER BY PRICE === 0") and the same test `openrouter-adapter.js` uses to
 * decide freeness in the first place. Measured there on the live catalogue:
 * 17 ids carry `:free` while 20 are zero-priced, and the three zero-priced ids
 * that are not `:free` include a ROUTER whose real bill is unknowable.
 *
 * The gate is load-bearing, not decorative, and it guards the one direction
 * that LOSES money: without it a spec claiming `free: true` on a PAID id would
 * make `isFreeModel` true and `chargeForItem` would return a hard 0 against a
 * real invoice. Refusing here makes `defineOfferableModel`'s agreement check
 * fail for such a spec, so the entry is dropped with a named reason instead of
 * being admitted as a $0.00 lie.
 */
function registerFreeModel(modelId, { dynamic }) {
  if (typeof modelId !== 'string' || !/:free$/.test(modelId)) return false;
  (dynamic ? _dynamicFree : _staticFree).add(modelId);
  return true;
}

/**
 * A model has a KNOWN PRICE POSTURE when it is either priced or explicitly free.
 * Anything else is a model whose bill we cannot describe, and
 * `defineOfferableModel` refuses to build an entry for it.
 */
function hasKnownPricePosture(modelId, spec) {
  if (spec && spec.free === true) return true;
  if (spec && spec.price) return true;
  return Object.hasOwn(MODEL_PRICES_USD_PER_MTOK, modelId) || isFreeModel(modelId);
}

/**
 * The output ceiling to clamp to for a given Anthropic model id.
 *
 * Unknown / non-string / prototype-key input returns ANTHROPIC_MAX_OUTPUT_TOKENS
 * — the CONSERVATIVE value. `Object.hasOwn` rather than a truthiness check so
 * `'__proto__'` and `'constructor'` cannot resolve through the plain object and
 * yield a bogus ceiling (the v3.0.9 normalizeResponseStyle bug shape).
 */
export function anthropicMaxOutputTokens(modelId) {
  if (typeof modelId !== 'string') return ANTHROPIC_MAX_OUTPUT_TOKENS;
  return Object.hasOwn(ANTHROPIC_MODEL_MAX_OUTPUT_TOKENS, modelId)
    ? ANTHROPIC_MODEL_MAX_OUTPUT_TOKENS[modelId]
    : ANTHROPIC_MAX_OUTPUT_TOKENS;
}

/**
 * Model-lifecycle safety net.
 *
 * When a provider retires the pinned default (e.g., Google removes
 * `gemini-2.5-flash-lite` in a future release), we don't want end-user
 * installations to break before the next Curator update lands. On a
 * model-not-found error, we try a small ordered chain of next-best models.
 * Successful fallback is logged and exposed via getFallbackStatus() so the
 * Settings UI can prompt the user to update.
 *
 * Order: FORWARD IN TIME, cheapest-first. A chain exists because the primary
 * was RETIRED, so escalating backwards to an older generation is the wrong
 * direction — an older model is more likely to be retired than the one that
 * just replaced it. Each rung is therefore the closest-priced live successor
 * first, then progressively pricier ones, so a user whose default disappears
 * lands on the cheapest still-working model rather than on one that is also
 * dead. Note "closest-priced" is not "same-priced": every Gemini rung costs
 * MORE than the default, which is why getFallbackStatus() reports a costTier.
 *
 * Rate-limit (429) and service-unavailable (503) errors DO NOT trigger
 * fallback — those are handled by the existing retry loop.
 */
const FALLBACK_CHAINS = {
  // Verified against the live Gemini API (2026-08-22) with the Curator's exact
  // call shape (JSON mode + maxOutputTokens: 65536). The previous chain's
  // `gemini-1.5-flash` and `gemini-1.5-flash-latest` rungs both 404 — two of
  // three rungs were already dead — and have been removed.
  //
  // ⚠ `gemini-3.5-flash-lite` was REMOVED here on 2026-08-26 — not a reorder,
  // a deletion, so the chain stays cheapest-first ($0.25 → $0.30). It is
  // STRICTLY DOMINATED by `gemini-2.5-flash`, the rung that now follows it
  // directly: identical price ($0.30/$2.50 on both), but measurably worse on
  // both axes that matter for a fallback rung. Measured live against this
  // repo's REAL buildOutlinePrompt (src/brain/ingest.js __testing export, not
  // a toy prompt) over 9 runs each:
  //   - JSON reliability: 2 of 9 runs produced JSON that neither JSON.parse
  //     NOR jsonrepair can fix (a dropped object key —
  //     `{ "concepts/knowledge-graph.md", "summary": "..." }` — unrecoverable
  //     because repair would have to invent the "path": key). finishReason
  //     was STOP both times, i.e. NOT truncation — a genuine generation
  //     defect, not a budget problem `isOutputTokenLimit` could route around.
  //     3.1-flash-lite and 2.5-flash were 3/3 and 3/3 clean on the same probe.
  //   - Outline coverage on an identical source: 3.1-flash-lite planned 5-12
  //     pages, 2.5-flash planned 17-19 pages, and 3.5-flash-lite sat in
  //     between at 12-16 — so it does not even fill a coverage gap between
  //     its neighbours.
  // In production this rung fired ingest's Phase-1 stricter-retry ladder on
  // ~22% of the runs that reached it — silent extra latency and cost on a
  // rung that was never the cheapest option available at its price point.
  // Do NOT re-add it without re-measuring live with the real ingest prompt —
  // a toy "return this JSON" probe will not reproduce the failure (see the
  // Anthropic thinking-block lesson in docs/model-lifecycle.md for why prompt
  // realism matters when probing a fallback rung).
  gemini: [
    'gemini-3.1-flash-lite',        // closest live successor — verified drop-in, but 2.5x in / 3.75x out
    // ⚠ THINKING TOKENS: gemini-2.5-flash spends hidden reasoning tokens out of
    // the SAME maxOutputTokens budget, and they are billed as output. Probed
    // 2026-08-24: at maxOutputTokens 30 it returned finishReason MAX_TOKENS with
    // ZERO visible tokens and 26 thoughtsTokenCount — the entire budget consumed
    // before a single character of answer; at 64 it produced 2 visible against 58
    // thoughts. The flash-lite rung and the default showed 0-2 thought tokens on
    // the same prompts, so this rung alone behaves differently. Nothing here
    // compensates for it (a budget nudge would be guesswork), but a caller
    // debugging "MAX_TOKENS with an empty response on the last fallback rung"
    // should know the budget is shared, not reserved for visible output.
    'gemini-2.5-flash',             // higher (costlier) tier — last resort
  ],
  // Repaired 2026-08-24. FOUR of the five previous rungs were dead — probed with
  // the Curator's exact call shape (messages.stream().finalMessage()), all four
  // returned 404 not_found_error, and none appear in GET /v1/models:
  //   claude-3-5-haiku-latest · claude-3-5-haiku-20241022
  //   claude-3-7-sonnet-latest · claude-3-5-sonnet-latest
  // This is the v3.0.15 Gemini bug repeating on the Anthropic side. It failed
  // SAFE (404 → skip → land on Sonnet 4.5) but not CHEAP: the chain's documented
  // promise is the cheapest still-working model, and it was delivering the
  // priciest of the three live options at 3x the default.
  //
  // There is NO cheaper live Haiku — the entire 3.5 family is retired and 4.5 is
  // the default itself — so the chain must jump straight to Sonnet. Ordered
  // cheapest-first among models verified alive today; 4.6 and 4.5 tie on price,
  // and the forward-in-time rule breaks the tie toward 4.6 (which also carries
  // the larger 128k output ceiling).
  anthropic: [
    'claude-sonnet-5',              // $2/$10 — cheapest live non-Haiku AND the newest
    'claude-sonnet-4-6',            // $3/$15 — tie on price with 4.5, newer, 128k output
    'claude-sonnet-4-5',            // $3/$15 — oldest live rung, 64k output
  ],
  /**
   * A fallback chain picks FOR the user, silently, on the day their model
   * disappears — so every rung must be a model we have measured and would be
   * willing to spend their money on without asking. This chain has exactly one
   * rung, and both the inclusion and the exclusions are deliberate.
   *
   * ibm-granite/granite-4.0-h-micro qualifies on all three counts: measured
   * 9/9 raw-parseable JSON on the real ingest prompt, PAID (so its availability
   * does not depend on a shared free queue), and CHEAPER than the default it
   * backs up ($0.017/$0.112 vs $0.03/$0.12) — a net that cannot cost more than
   * the thing it replaces. Its measured weakness is coverage, not correctness:
   * a median of 9 outline pages against solar-pro4's 23. Degrading to a thinner
   * plan is the right trade when the alternative is not ingesting at all, and
   * it mirrors what the Gemini chain already does.
   *
   * ⚠ minimax/minimax-m3:free is offerable but is deliberately NOT a rung, and
   * the reason is stated at the strength it was actually established.
   *
   * WHAT WAS OBSERVED: a `:free` id is gated by an OpenRouter ACCOUNT SETTING
   * about free-model training — a request for one can be refused outright with
   * "No endpoints found matching your data policy (Free model training)". So a
   * free model's reachability, and the data-policy permission it is filed
   * under, are not the same as a paid model's.
   *
   * WHAT WAS NOT ESTABLISHED, and is therefore NOT asserted here: whether free
   * models REQUIRE that permission, and what OpenRouter's own retention policy
   * is. This comment previously stated as fact that "free OpenRouter variants
   * are free because their upstreams may train on the request" — the same claim
   * `docs/user-guide.md` explicitly declines to make, saying it could not be
   * verified. Two files in one repo disagreeing about a PRIVACY property is
   * worse than either answer, and the confident one had no evidence behind it.
   *
   * The decision does not depend on the unverified half. A fallback walks the
   * user onto a model they did not choose, silently, on the day their default
   * dies; walking them from a paid id onto one whose availability turns on a
   * data-policy toggle changes the terms their ingest runs under without them
   * agreeing to it. A chain may degrade capability; it may not quietly move the
   * request into a different data-handling regime.
   *
   * A chain is still narrower than it looks: every request carries
   * `allow_fallbacks: false`, so OpenRouter itself cannot re-route us to an
   * upstream we did not pick. This list is the ONLY substitution that can
   * happen, which is why it is short and hand-checked.
   */
  openrouter: ['ibm-granite/granite-4.0-h-micro'],
};

/**
 * Published API prices, USD per 1M tokens, keyed by EXACT model id.
 *
 * ⚠ THESE ARE STANDARD PRICES. Where a model is currently on a promotional rate
 * the STANDARD (post-promotional) number lives here and the discount lives in
 * PROMOTIONAL_PRICES below, resolved by date. Never write a promotional price
 * into this table — see the long note on PROMOTIONAL_PRICES for why.
 *
 * Scope is the ids this app can actually run — DEFAULTS, every rung of
 * FALLBACK_CHAINS, and every entry of OFFERABLE_MODELS (the models a user may
 * pick for themselves). Those are ids WE choose and change
 * deliberately, so staleness is bounded by our own release process (see the
 * release checklist in docs/model-lifecycle.md: adding a rung means adding its
 * price here). Symmetrically, REMOVING a rung means removing its price entry
 * too — the offline invariant in test-chat-model.js §5 asserts this table has
 * no entries beyond the ids currently shipped, precisely so a dead-weight
 * price for a model we no longer run can't linger unnoticed (see the
 * `gemini-3.5-flash-lite` removal below).
 *
 * This replaced a family-name heuristic (flash-lite/flash, haiku/sonnet) that
 * looked reasonable and was structurally wrong: the family word is stable
 * ACROSS generations while the price is not. It scored
 * gemini-2.5-flash-lite → gemini-3.1-flash-lite as "same tier" when that
 * successor is 2.5x the input and 3.75x the output price — i.e. it stayed
 * silent on the exact rung the chain reaches FIRST. Only an exact-id table can
 * see a within-family price change.
 *
 * ⚠ THESE NUMBERS ARE NOW USER-VISIBLE. Until the multi-model work they fed only
 * the fallback banner's costlier/similar/unknown ordering, so a stale absolute
 * value was harmless. They now surface through OFFERABLE_MODELS into a picker
 * whose entire purpose is showing a user what a model costs BEFORE they choose
 * it, so an absolute value being right matters as much as the ordering does.
 *
 * Verified 2026-08-26 against ai.google.dev/gemini-api/docs/pricing and
 * platform.claude.com/docs/en/about-claude/pricing (standard tier, text) — the
 * LIVE pages, never a cached table. That is a standing rule, not a formality:
 * a cached copy asserting a scheduled Sonnet 5 price RISE that had in fact been
 * cancelled would have inverted the Anthropic chain's cost ordering a week after
 * shipping, silently (see the claude-sonnet-5 note below).
 */
const MODEL_PRICES_USD_PER_MTOK = {
  // ── Gemini ──
  'gemini-2.5-flash-lite':     { input: 0.10, output: 0.40 },   // current default
  'gemini-3.1-flash-lite':     { input: 0.25, output: 1.50 },   // 2.5x in / 3.75x out vs default
  'gemini-2.5-flash':          { input: 0.30, output: 2.50 },
  // gemini-3.5-flash-lite is priced again as of 2026-08-26 — NOT a reversal of
  // its removal from FALLBACK_CHAINS, which stands. It is priced because it is
  // OFFERABLE (a user may pick it deliberately, with its measured JSON defect
  // shown) while remaining banned from the chain (which picks FOR the user).
  // Those are two different lists with two different rules; see DOMINATED_MODELS.
  'gemini-3.5-flash-lite':     { input: 0.30, output: 2.50 },
  // ⚠ PROMOTIONAL — the numbers here are the STANDARD prices that take effect
  // 2027-01-01. Both models bill at $0.75/$3.75 through 2026-12-31; that
  // discount lives in PROMOTIONAL_PRICES and getModelPrice() switches over on
  // the date by itself.
  'gemini-3.7-flash':          { input: 1.50, output: 7.50 },
  'gemini-3.6-flash':          { input: 1.50, output: 7.50 },
  'gemini-3.5-flash':          { input: 1.50, output: 9.00 },
  // ── Anthropic ── (re-verified 2026-08-24; the four retired 3.x rungs and their
  // prices were removed together with the dead chain entries)
  'claude-haiku-4-5':          { input: 1.00, output: 5.00 },   // current default
  // ⚠ Sonnet 5 is CHEAPER than both Sonnet 4.6 and Sonnet 4.5 despite being the
  // newest of the three — a within-family price DROP, the mirror image of the
  // Gemini flash-lite rise above, and the second independent proof that only an
  // exact-id table can be trusted here.
  //
  // Read the source carefully before touching this number: $2/$10 launched in
  // June 2026 labelled INTRODUCTORY through 2026-08-31, and a cached copy of the
  // pricing table still carries that wording. Anthropic announced on 2026-08-10
  // that it is now the standard price and the scheduled 2026-09-01 rise to
  // $3/$15 will NOT occur — confirmed against the live pricing page. Had the
  // introductory framing been current, hard-coding $2/$10 would have inverted
  // this chain's cost ordering one week later.
  'claude-sonnet-5':           { input: 2.00, output: 10.00 },
  'claude-sonnet-4-6':         { input: 3.00, output: 15.00 },
  'claude-sonnet-4-5':         { input: 3.00, output: 15.00 },
  // Offerable-only (never a fallback rung). ⚠ The headline $5 UNDERSTATES what
  // these cost against a Haiku baseline for two of the three: claude-opus-5 and
  // claude-opus-4-8 use a newer tokenizer measured at 1.329x more input tokens
  // on real Curator prose, so $5/1M is really ~$6.65/1M of the same text. That
  // multiplier is carried per-model as `tokenizerFactor` on the OFFERABLE_MODELS
  // entry rather than folded into the price here, because it is a property of
  // the TEXT-to-token conversion, not of the published rate — folding it in
  // would make this table disagree with the provider's own invoice.
  'claude-opus-5':             { input: 5.00, output: 25.00 },
  'claude-opus-4-8':           { input: 5.00, output: 25.00 },
  'claude-opus-4-5':           { input: 5.00, output: 25.00 },

  // ── OpenRouter (PAID entries only) ──
  // Read verbatim from OpenRouter's public catalogue on 2026-08-27 and
  // CROSS-CHECKED against the bill: `usage.cost` returned on every live call
  // matched the figure these numbers produce to six decimal places
  // (e.g. computed $0.001391 vs reported 0.001391284), which also settles the
  // previously-unverified question of whether an OpenRouter credit is a USD
  // cent. `pricing.prompt`/`.completion` are decimal STRINGS in USD PER TOKEN,
  // so these are x1e6; typing the per-token figure here would under-price by a
  // million.
  //
  // ⚠ Neither carries `pricing.overrides`, i.e. neither is tiered — verified on
  // the live payload the same day. That is a precondition of build-lane
  // admission, not a nicety: a tiered rate would under-state the bill on
  // exactly the large ingests this lane produces.
  //
  // minimax/minimax-m3:free is DELIBERATELY ABSENT. It is free, it lives in
  // FREE_MODELS, and `getModelPrice()` must keep returning null for it — an
  // `{input: 0, output: 0}` entry here is truthy and would silently re-arm
  // v3.3.0's inert budget cap.
  'ibm-granite/granite-4.0-h-micro': { input: 0.017, output: 0.112 },
  'upstage/solar-pro4':              { input: 0.03,  output: 0.12  },
  //
  // ── ADDED 2026-08-28. THE PRICE OF AN OPENROUTER ID IS A PROPERTY OF THE
  //    ENDPOINT THAT SERVES IT, NOT OF THE ID ────────────────────────────────
  // The two figures below are the CHEAPEST JSON-capable endpoint's published
  // rate, and both were confirmed against the BILL on a cold (uncached) call:
  // computed cost equalled `usage.cost` to six decimal places on every
  // cold run in the probe (glm-5.3-flash 2 cold runs, kimi-k2-0905 3).
  //
  // That check is not a formality here, and two rejected candidates are why.
  // `qwen/qwen3-235b-a22b-2507` publishes $0.0875/$0.35 on its cheapest
  // endpoint and BILLED $0.011801 for 77,823 in / 1,132 out — which is
  // Parasail's $0.14/$0.80 to the last decimal, i.e. 1.64x what that table
  // entry would have quoted, on the very first call. `moonshotai/kimi-k2.6`
  // went the other way: the catalogue headline is $0.95/$4.00, it billed
  // Decart's $0.5372/$2.2618, and one of its 19 endpoints charges $1.09.
  // Neither has a number this table could state truthfully, so neither is here.
  //
  // What makes these two safe is STRUCTURAL, not luck:
  //   moonshotai/kimi-k2-0905 has exactly ONE endpoint, so its price cannot
  //     route anywhere else — the same property `ibm-granite/granite-4.0-h-micro`
  //     has, and `upstage/solar-pro4` has in effect (2 endpoints, both $0.03).
  //   z-ai/glm-5.3-flash has three endpoints at $0.075 and twelve at $0.150,
  //     and billed the $0.075 tier on both cold runs. That is the observed
  //     figure and it is what is quoted — but it is the ONE entry here whose
  //     price could double without the id changing, so its note says so.
  'z-ai/glm-5.3-flash':              { input: 0.075, output: 0.25  },
  'moonshotai/kimi-k2-0905':         { input: 0.60,  output: 2.50  },
};

// Frozen at definition: this table is exported through `__testing` for the
// offline price-coverage invariant, and a test that mutated it would corrupt
// every later cost comparison in the same process. Entries are frozen too, so
// `MODEL_PRICES_USD_PER_MTOK['x'].input = 0` is a no-op rather than a silent
// cross-test leak.
for (const price of Object.values(MODEL_PRICES_USD_PER_MTOK)) Object.freeze(price);
Object.freeze(MODEL_PRICES_USD_PER_MTOK);

/**
 * Time-limited promotional prices, keyed by EXACT model id.
 *
 * WHY THIS EXISTS AS A MECHANISM RATHER THAN A COMMENT. `gemini-3.6-flash` and
 * `gemini-3.7-flash` bill at $0.75/$3.75 through 2026-12-31 and DOUBLE to
 * $1.50/$7.50 on 2027-01-01. There were three ways to handle that and only one
 * of them is safe:
 *
 *   • Hard-code $0.75/$3.75 as if permanent. REJECTED. This is v3.6.0's recorded
 *     near-miss in the opposite direction — there, a cached table claimed a
 *     Sonnet 5 price RISE that had actually been cancelled, and trusting it would
 *     have inverted the fallback chain's cost ordering one week after shipping,
 *     silently. A promotional number frozen into the standard table is the same
 *     failure with the clock running the other way: on 2027-01-01 the picker
 *     would quote every user HALF of what they are actually billed, on the one
 *     surface whose entire job is cost honesty, and no ordering assertion would
 *     notice (the array order happens to survive the doubling, so a
 *     cheapest-first test stays green over a wrong number — this project's named
 *     "green over a wrong number" shape).
 *   • Don't offer the two models at all. REJECTED as over-correction: they are
 *     the modern non-lite Flash tier at a genuinely good rate today, and
 *     excluding them for four months only to add them back later trades a real
 *     capability for a problem that is nine lines of code to solve properly.
 *   • Resolve by DATE, and state the expiry in the record. CHOSEN, and both
 *     halves are load-bearing: the date resolution means nobody has to remember
 *     to ship a release on New Year's Day, and the stated expiry means a human
 *     reading the entry cannot mistake $0.75 for a stable price.
 *
 * FAIL-SAFE DIRECTION. The standard (HIGHER) price is the one in
 * MODEL_PRICES_USD_PER_MTOK, and a promotion is a narrowing exception applied on
 * top. So every way this can break — a wrong system clock, this table being
 * dropped, an id typo'd here — degrades to quoting the HIGHER price. That is
 * deliberate and matches the direction this repo already takes on money
 * (v3.9.0: an unrecognised cost tier resolves to 'unknown', never 'similar',
 * "because the fail-safe direction on money is to warn"). A user who is quoted
 * more than they are billed picks a cheaper model than they needed; a user
 * quoted less than they are billed was lied to.
 *
 * `untilMs` is INCLUSIVE and pinned to UTC. A promotion is a published calendar
 * fact, not a local-time one, so parsing it in the machine's timezone would make
 * two users disagree about the price for up to a day.
 */
const PROMOTIONAL_PRICES = {
  'gemini-3.7-flash': {
    price: Object.freeze({ input: 0.75, output: 3.75 }),
    untilIso: '2026-12-31',
    untilMs: Date.parse('2026-12-31T23:59:59.999Z'),
    standardFromIso: '2027-01-01',
  },
  'gemini-3.6-flash': {
    price: Object.freeze({ input: 0.75, output: 3.75 }),
    untilIso: '2026-12-31',
    untilMs: Date.parse('2026-12-31T23:59:59.999Z'),
    standardFromIso: '2027-01-01',
  },
};
for (const promo of Object.values(PROMOTIONAL_PRICES)) Object.freeze(promo);
Object.freeze(PROMOTIONAL_PRICES);

/**
 * Price for an exact model id AT A GIVEN INSTANT, or null if we don't ship it.
 *
 * Exported (rather than kept private behind getModelPrice) so the offline suite
 * can assert BOTH sides of a promotional boundary today, instead of asserting
 * one side and hoping someone re-reads the comment in January. A guard that can
 * only be exercised on the day it matters is a comment, not a guard.
 *
 * @param {string} modelId
 * @param {number} [atMs]  epoch ms; defaults to now. Non-finite input falls back
 *   to now rather than throwing — a bad clock must not take down an LLM call.
 * @returns {null | {input: number, output: number}}
 */
export function resolveModelPrice(modelId, atMs = Date.now()) {
  if (typeof modelId !== 'string') return null;
  // Dynamically-admitted models (the OpenRouter catalogue) carry their price on
  // the registered entry rather than in the static table, because the static
  // table's stated contract — and the offline invariant that enforces it — is
  // "exactly the ids we ship in this release". Consulted BEFORE the static
  // table only to keep the lookup a single expression; the two sets are
  // disjoint by construction (registerDynamicPrice refuses a statically-priced
  // id, so a dynamic entry can never shadow a hand-verified number).
  if (_dynamicPrices.has(modelId)) return _dynamicPrices.get(modelId);
  if (!Object.hasOwn(MODEL_PRICES_USD_PER_MTOK, modelId)) return null;
  const standard = MODEL_PRICES_USD_PER_MTOK[modelId];
  if (!Object.hasOwn(PROMOTIONAL_PRICES, modelId)) return standard;
  const promo = PROMOTIONAL_PRICES[modelId];
  const t = Number.isFinite(atMs) ? atMs : Date.now();
  return t <= promo.untilMs ? promo.price : standard;
}

/**
 * Published price for an exact model id RIGHT NOW, or null if we don't ship it.
 * Signature and return shape unchanged from before promotional pricing existed,
 * so all existing consumers (health-ai.js, ingest-queue.js, the fallback cost
 * banner) keep working untouched and simply become date-correct for free.
 * @returns {null | {input: number, output: number}}
 */
export function getModelPrice(modelId) {
  return resolveModelPrice(modelId, Date.now());
}

/**
 * ── Prices for dynamically-admitted models ───────────────────────────────────
 *
 * OpenRouter's catalogue is 417 models and moves without our release process,
 * so its chat-lane entries are admitted at RUNTIME from the provider's public
 * API rather than hand-typed here. Their prices therefore cannot live in
 * MODEL_PRICES_USD_PER_MTOK, whose contract (and whose offline invariant) is
 * "no entries beyond the ids we actually ship in this release".
 *
 * They still have to be readable through `getModelPrice()`, because that one
 * function is what every cost surface in the app calls — the ingest estimator,
 * `chargeForItem`, `compareModelCost`, the chat cost line. A separate price
 * lookup for one provider would be a second hand-maintained copy of the money
 * path, which is this repo's named cause of the v3.2.0 CRITICAL.
 *
 * Populated ONLY through `setOpenRouterCatalogue`, so a price and an offer are
 * admitted by the same call and cannot disagree. It is therefore empty until
 * the first catalogue arrives and is REBUILT on every one after that — never
 * "empty in this release", which is what this line used to say and which stops
 * being true the moment the runtime overlay is fetched.
 */
const _dynamicPrices = new Map();

/**
 * Register a dynamic price. Refuses to shadow a statically-priced id, refuses a
 * non-positive or non-finite figure, and freezes what it stores.
 *
 * A free model registers NOTHING: `getModelPrice()` must keep returning null for
 * it (see FREE_MODELS), and storing `{input: 0, output: 0}` here is precisely the
 * inert-budget-cap bug that posture exists to prevent.
 */
function registerDynamicPrice(modelId, price) {
  if (typeof modelId !== 'string' || modelId.length === 0) return false;
  if (Object.hasOwn(MODEL_PRICES_USD_PER_MTOK, modelId)) return false;
  if (!price || typeof price !== 'object') return false;
  const { input, output } = price;
  if (!Number.isFinite(input) || !Number.isFinite(output) || input <= 0 || output <= 0) return false;
  _dynamicPrices.set(modelId, Object.freeze({ input, output }));
  return true;
}

/**
 * ── TIERED (long-context) PRICING — a flat price is a LIE for these models ────
 *
 * 60 of OpenRouter's 417 models carry `pricing.overrides`: the rate CHANGES
 * above a prompt-token threshold. `anthropic/claude-sonnet-4.5` DOUBLES above
 * 200,000 prompt tokens — $3→$6 in, $15→$22.50 out.
 *
 * WHY THIS IS WORSE THAN THE PROMOTIONAL-PRICE TRAP IT RESEMBLES. A promotion
 * expires on a DATE, which is knowable in advance and resolvable by clock (see
 * PROMOTIONAL_PRICES). A tier fires on the SIZE OF THE REQUEST — and the
 * requests that cross it are exactly this app's large ingests, the ones where a
 * user is spending most. A flat entry would quote half the real rate on the
 * calls that cost the most, on a spend surface, and no ordering assertion would
 * notice: the array order survives a doubling, this project's named "green over
 * a wrong number" shape.
 *
 * HOW IT IS HANDLED IN THIS PASS — stated plainly rather than half-solved.
 * The Curator's price model is a single `{input, output}` pair, and every
 * consumer (`chargeForItem`, the estimator, `compareModelCost`, and the
 * composer's MIRRORED copy of the charge formula that a 126-case suite pins to
 * exact-dollar equality) assumes one rate per model. Threading a threshold
 * through all of that is a money-path change that deserves its own release and
 * its own proof.
 *
 * So: a model with tiered pricing is admitted for CHAT ONLY, structurally.
 * `defineOfferableModel` REFUSES to build a 'general' or 'caution' entry for one.
 * That is safe for the specific reason that chat's prompt is bounded and small —
 * chat.js caps loaded content at 60 KB plus a 12 KB catalogue, on the order of
 * 20k tokens, an order of magnitude under the lowest threshold seen (200k) — so
 * the flat rate we quote for chat is the rate that is actually billed. The build
 * lane, which is the only lane that can cross a threshold, cannot reach these
 * models at all.
 *
 * Empty today: this release admits no tiered model. The mechanism exists so the
 * next one cannot be admitted by omission.
 */
const TIERED_PRICE_MODELS = Object.freeze(new Set([]));

/**
 * True when a model's published rate changes above some prompt size — either
 * because it is on the static list or because the entry being admitted declares
 * a threshold read from the provider.
 */
function hasTieredPricing(modelId, spec) {
  // `tiered: true` is the PRODUCER this predicate lacked. Until it existed, the
  // only two ways to be tiered were a `priceTierThresholdTokens` nobody set and
  // an empty static Set — so the refusal below was vacuous, and the real
  // `anthropic/claude-sonnet-4.5` (which DOUBLES above 200k prompt tokens) was
  // admitted to the BUILD lane at a flat rate. `openRouterRecordToSpec()` now
  // reads `pricing.overrides` off the provider's payload and sets this flag.
  //
  // PRESENCE, not a threshold: the exact JSON shape of `pricing.overrides` is
  // unverified, so the mapper reports THAT a rate changes without inventing
  // WHERE. Presence is everything the refusal needs; a guessed threshold would
  // be a made-up number on a spend surface.
  if (spec && spec.tiered === true) return true;
  if (spec && Number.isFinite(spec.priceTierThresholdTokens)) return true;
  return typeof modelId === 'string' && TIERED_PRICE_MODELS.has(modelId);
}

/**
 * Does this id LOOK like a moving alias?
 *
 * The authoritative signal is OpenRouter's `alias_target`, read by
 * `openRouterRecordToSpec()`. This is the second, independent layer: it works on
 * an id ALONE, so it also covers a hand-written spec that never went through the
 * mapper, and it covers the other providers, whose `*-latest` ids are moving
 * aliases in exactly the same way (`claude-3-5-haiku-latest` was one, until a
 * live probe found the whole generation 404'd in v3.6.0).
 *
 * A moving id is refused because the user does not know what they picked and the
 * price we quote is the alias's, not the target's.
 *
 * VERIFIED SAFE AT MODULE LOAD: 0 of the 17 ids this app currently ships —
 * defaults, fallback rungs, priced entries and offerable entries — match. A
 * false positive here would be a throw at import time, i.e. the whole app.
 */
function looksLikeMovingAlias(modelId) {
  return typeof modelId === 'string' && /[-:]latest$/i.test(modelId);
}

/**
 * ── DOMINATED: alive, fairly priced, and measurably worse than a same-priced
 *    sibling ────────────────────────────────────────────────────────────────
 *
 * The companion to the RETIRED list in test-chat-model.js §9, and deliberately a
 * SEPARATE concept:
 *
 *   RETIRED   — the id 404s. Shipping it does nothing at all.
 *   DOMINATED — the id works and is honestly priced, but another model at the
 *               SAME price measured better on every axis we tested. Shipping it
 *               works; it just costs the user quality for no saving.
 *
 * THE TWO LISTS THIS CONSTRAINS ARE NOT THE SAME LIST, and the distinction is
 * the whole reason this exists rather than a single ban:
 *
 *   FALLBACK_CHAINS — the app picks FOR the user, silently, on the worst day
 *     (their pinned default has just been retired). A dominated rung there is
 *     indefensible: nobody chose it, nobody was told, and its documented promise
 *     is "the cheapest model that still WORKS". A DOMINATED id must therefore
 *     never appear in a chain — asserted in test-chat-model.js.
 *   OFFERABLE_MODELS — the USER picks, deliberately, with the measured reason on
 *     screen. Hiding a working model there would be deciding for someone what
 *     they may spend their own API key on. The honest answer is to show it and
 *     label it, which is what `suitability` + `note` + this list are for.
 *
 * So DOMINATED ∩ FALLBACK_CHAINS = ∅, while DOMINATED ⊆ OFFERABLE is fine.
 *
 * `gemini-3.5-flash-lite` is the founding entry: it was pulled from the Gemini
 * chain on 2026-08-26 by an ad-hoc pair of assertions naming it specifically.
 * Those assertions are folded into this list, so the next dominated model is
 * caught by the same invariant instead of needing its own bespoke pair.
 */
export const DOMINATED_MODELS = Object.freeze({
  'gemini-3.5-flash-lite': Object.freeze({
    dominatedBy: 'gemini-2.5-flash',
    reason:
      'Identical published price ($0.30/$2.50) to gemini-2.5-flash, but 2 of 9 live runs against ' +
      'this repo\'s REAL ingest outline prompt returned JSON that neither JSON.parse nor jsonrepair ' +
      'could fix — a dropped object key, with finishReason STOP, so a generation defect rather than ' +
      'truncation that the output-token-limit ladder could route around. gemini-2.5-flash was 3/3 ' +
      'clean on the identical probe and plans wider outlines (17-19 pages vs 12-16).',
  }),
  'claude-opus-4-5': Object.freeze({
    dominatedBy: 'claude-opus-5',
    reason:
      'Identical published price ($5/$25) to claude-opus-5 and behind it on all three measured axes: ' +
      'half the output ceiling (64,000 vs 128,000), fenced JSON that only parses via jsonrepair ' +
      '(3/3) where opus-5 returned bare JSON (3/3), and 12-13 outline pages against opus-5\'s 25-27. ' +
      'It also plans more thinly than claude-sonnet-5 does at two-fifths of the price.',
  }),
});

/**
 * ── AWAITING MEASUREMENT: real models we deliberately do NOT offer ───────────
 *
 * Price and output ceiling for both were read off the provider's documentation,
 * but neither has been probed live against this repo's real ingest outline
 * prompt. That is disqualifying, not a formality — a model may not be offered
 * for a feature it has never been measured against, and the sharpest evidence
 * for that rule is in the data this table was built from:
 *
 *   THINKING BEHAVIOUR IS PER-MODEL, NOT PER-GENERATION. `claude-opus-5` was
 *   released AFTER `claude-sonnet-5` and thinks 0/3, while sonnet-5 thinks 7/7.
 *   Two models one release apart, opposite behaviour. So for any unprobed id the
 *   `thinks` flag is genuinely UNKNOWN, and a guess there is a guess about
 *   billed output tokens drawn from the same budget as the answer.
 *
 * These ids must not be offerable, must not be a default, must not be a fallback
 * rung, and must carry no price entry — all four asserted in test-chat-model.js.
 * To promote one: probe it live with the REAL prompt (a toy "return this JSON"
 * probe will not reproduce the failures this table records), then add its price,
 * cap and measured fields together.
 */
export const AWAITING_MEASUREMENT = Object.freeze({
  'claude-opus-4-7': Object.freeze({
    reason:
      'Provider docs give $5/$25 and a 128,000 output ceiling, and describe the newer 1.329x ' +
      'tokenizer — but it has never been run against the real ingest outline prompt, so its JSON ' +
      'reliability, outline coverage and thinking behaviour are all unmeasured.',
  }),
  'claude-opus-4-6': Object.freeze({
    reason:
      'Provider docs give $5/$25 and a 128,000 output ceiling; never probed live. Same gap as ' +
      'claude-opus-4-7 — nothing about its behaviour under a real ingest prompt is known.',
  }),
});

/**
 * The three suitability verdicts an offerable model can carry.
 *
 * These describe FITNESS FOR A FEATURE and nothing else. Cost lives in the price
 * fields, and hidden reasoning spend lives in `thinks` — deliberately kept as
 * separate axes, because folding "this is expensive" or "this thinks" into
 * `caution` would put five of seven Gemini models in the same bucket and the
 * label would stop meaning anything.
 *
 *   'general'   — measured clean for every feature, ingest included.
 *   'chat-only' — measured UNFIT for ingest specifically. Ingest is JSON mode;
 *                 chat is text mode and is unaffected by a JSON defect, so the
 *                 model stays genuinely useful for chat rather than being hidden.
 *   'caution'   — usable everywhere, but carries a measured downside (a scheduled
 *                 price rise, thinner outlines than a cheaper model, a
 *                 same-priced sibling that beat it) the user must see BEFORE
 *                 choosing it.
 */
const OFFERABLE_SUITABILITY = Object.freeze(['general', 'chat-only', 'caution']);

/**
 * ── MEASURED MEDIAN LATENCY, INCLUDING FOR MODELS WE DID NOT ADMIT ──────────
 *
 * Median wall-clock for ONE ingest outline call, in milliseconds, keyed by model
 * id. `defineOfferableModel` reads it for any entry that does not carry its own
 * `medianLatencyMs`, so it reaches the RUNTIME OpenRouter catalogue as well as
 * the hand-typed table.
 *
 * THAT REACH IS THE POINT, AND IT CAME FROM A LIVE REPORT. The maintainer picked
 * `deepseek/deepseek-v4-flash-0731` in the chat composer and got a bare spinner
 * for minutes; he reported the app as broken. It was not — the conversation
 * record shows the model answered and was billed and attributed correctly. It is
 * simply the slowest thing we have ever measured, and we had measured it: this
 * very file's refusal notes record it. The number existed and never reached the
 * one screen where it would have changed his mind. A model can be REFUSED for
 * the build lane and still be freely pickable for CHAT, so its measurement has
 * to survive the refusal — which is why this map is keyed by id and is separate
 * from the offer table.
 *
 * ONLY RUNS THAT PRODUCED A USABLE RESULT COUNT. `z-ai/glm-4.7` returned in a
 * median of 34s and `minimax/minimax-m3` in 6s — and both produced JSON that
 * nothing could repair in 9 of 9 runs. Publishing those as speed figures would
 * advertise a fast FAILURE as a fast model, so a model with no usable run gets
 * NO ENTRY HERE rather than a number. Absent means unmeasured, and every surface
 * omits the clause rather than rendering a zero.
 *
 * Figures are transcribed from the probe records of the 2026-08-27/28 sessions
 * (and, where an entry's own `note` states a median, from the note, so the field
 * and the paragraph beneath it on screen cannot disagree).
 */
const MEASURED_LATENCY_MS = Object.freeze({
  // ── Offered for the build lane ──
  'upstage/solar-pro4': 48000,          // 18 usable runs, 24-88s
  'z-ai/glm-5.3-flash': 188000,         // 8 usable of 9; the entry's own note states median 188s
  'moonshotai/kimi-k2-0905': 33000,     // 9 usable runs, 25-43s plus one 467s runaway
  // ── MEASURED AND REFUSED for the build lane; still pickable for chat ──
  // Every one of these was probed with the identical prompt and turned down for
  // a reason recorded beside OFFERABLE_MODELS.openrouter. None of those reasons
  // makes the timing untrue, and the timing is what a user feels.
  'deepseek/deepseek-v4-flash-0731': 382000, // the single usable run of 2; the other never returned inside the adapter's 600s ceiling
  'qwen/qwen3-235b-a22b-2507': 40000,   // 9 usable runs, 31-50s
  'moonshotai/kimi-k2.6': 22000,        // 9 usable runs, 18-38s
  'qwen/qwen3-30b-a3b-instruct-2507': 16000, // 8 usable of 9, 13-22s
});

/**
 * Build one frozen OFFERABLE_MODELS entry, or REFUSE to build it.
 *
 * This is the structural half of "a model may not be offerable unless it is
 * fully specified". Every required field is checked here and a missing one
 * throws AT MODULE LOAD — so an under-specified model does not merely fail a
 * test, it fails to exist, and the app refuses to boot rather than shipping a
 * picker entry with a blank price or an unknown output ceiling. The table is
 * static, so this is unreachable in production by construction; it is a
 * developer-time tripwire that cannot be forgotten the way a convention can.
 *
 * PRICE AND CEILING ARE DERIVED, NEVER RE-TYPED. `input`/`output` come from
 * MODEL_PRICES_USD_PER_MTOK and `maxOutput` from the provider's cap map. Copying
 * either number into the entry would create two hand-maintained copies of the
 * same fact — this repo's named cause of the v3.2.0 CRITICAL — and the copies
 * would drift silently, in a picker, on the numbers a user makes a spending
 * decision from.
 *
 * `input`/`output` are GETTERS, not snapshots, so a promotional price that
 * expires while the process is running resolves correctly on the next read
 * rather than serving a stale number until the next restart. JSON.stringify
 * invokes them, so the route serialises plain numbers to the wire exactly as if
 * they were data properties.
 */
function defineOfferableModel(provider, spec, opts = {}) {
  const id = spec && typeof spec.id === 'string' ? spec.id : '(no id)';
  const where = `OFFERABLE_MODELS.${provider} entry "${id}"`;
  const need = (cond, what) => {
    if (!cond) throw new Error(`[llm] ${where} is not offerable: ${what}`);
  };

  need(spec && typeof spec === 'object', 'spec must be an object');
  need(typeof spec.id === 'string' && spec.id.length > 0, 'missing `id`');
  need(typeof spec.label === 'string' && spec.label.length > 0, 'missing `label`');
  need(typeof spec.thinks === 'boolean',
    'missing measured `thinks` — it is PER-MODEL and cannot be inferred from a family or a release date (claude-opus-5 is newer than claude-sonnet-5 and thinks 0/3 where sonnet-5 thinks 7/7)');
  need(typeof spec.tokenizerFactor === 'number' && Number.isFinite(spec.tokenizerFactor) && spec.tokenizerFactor >= 1,
    'missing/invalid `tokenizerFactor` (>= 1; 1.0 means no measured premium over its provider baseline)');
  need(OFFERABLE_SUITABILITY.includes(spec.suitability),
    `\`suitability\` must be one of ${OFFERABLE_SUITABILITY.join(' | ')}`);
  need(typeof spec.note === 'string' && spec.note.trim().length > 0,
    'missing `note` — the measured reason shown to the user. A model nobody has measured must not be offered at all');

  // ── MEASUREMENTS PROMOTED OUT OF PROSE ────────────────────────────────────
  // Outline coverage and latency were measured for these models and then
  // recorded ONLY inside `note`, as English. Both surfaces need them to build a
  // one-line summary, and the alternative — regexing a number back out of a
  // paragraph — is parsing prose as an API: it fails silently the day someone
  // rewords a sentence, and it fails by producing a NUMBER rather than an error.
  // So they are fields.
  //
  // EVERY ONE IS OPTIONAL AND ABSENT MEANS UNMEASURED. Never 0, never a
  // midpoint invented from a range, never a value carried across from a sibling
  // id (the v3.16.0 minimax-m3 finding: the free and paid routes of one base
  // model measured 8/9 and 0/9). A summary clause whose field is absent is
  // OMITTED — it does not render "0 pages", which would state a measurement
  // nobody took. Gemini and Anthropic carry no latency figure at all for exactly
  // this reason: those sessions did not record one.
  //
  // TRANSCRIBED FROM EACH ENTRY'S OWN `note`, never from a fresher session, so
  // the derived line and the paragraph it summarises cannot disagree on screen.
  const pageField = (v, name) => {
    if (v === undefined || v === null) return null;
    need(Number.isInteger(v) && v > 0,
      `\`${name}\` must be a positive integer or absent — absent means UNMEASURED, and 0 would assert a measurement of zero pages`);
    return v;
  };
  const outlinePagesLow = pageField(spec.outlinePagesLow, 'outlinePagesLow');
  const outlinePagesHigh = pageField(spec.outlinePagesHigh, 'outlinePagesHigh');
  const outlinePagesMedian = pageField(spec.outlinePagesMedian, 'outlinePagesMedian');
  need((outlinePagesLow === null) === (outlinePagesHigh === null),
    'outline coverage must carry BOTH `outlinePagesLow` and `outlinePagesHigh` or neither — half a range cannot be rendered honestly');
  need(outlinePagesLow === null || outlinePagesLow <= outlinePagesHigh,
    '`outlinePagesLow` exceeds `outlinePagesHigh`');
  need(spec.medianLatencyMs === undefined || spec.medianLatencyMs === null ||
    (Number.isFinite(spec.medianLatencyMs) && spec.medianLatencyMs > 0),
    '`medianLatencyMs` must be a positive number or absent — absent means UNMEASURED, and 0 would claim an instant response');

  // ── TWO PROVIDER-PUBLISHED FACTS: OPTIONAL, ADDITIVE, ABSENT MEANS ABSENT ─
  // Carried so a picker can offer a "Newest" and a "Largest context" sort.
  //
  // OPTIONAL IS STRUCTURAL, NOT LAZINESS. `OFFERABLE_MODELS`'s shape is a
  // declared public contract (see the table's docblock) and this factory THROWS
  // AT MODULE LOAD on a malformed entry — so requiring either field would make
  // all fourteen hand-typed Gemini and Anthropic entries, and all five
  // hand-measured OpenRouter ones, fail to build. The module would refuse to
  // load and the app would not boot. A hand-measured table records what we
  // measured; it is not a release calendar and never was.
  //
  // NEITHER MAY EVER BE DERIVED, AND `maxOutput` IS NOT A CONTEXT WINDOW. It is
  // the OUTPUT ceiling — a different fact. Across the 374 live models publishing
  // both, `max_completion_tokens < context_length` in 374 of 374 cases, so
  // substituting one for the other would rank every model by the wrong number
  // while looking entirely plausible on screen.
  //
  // `createdUnixSec` IS RANGE-CHECKED AS SECONDS BECAUSE THE UNIT IS THE BUG.
  // A milliseconds value (1.7e12) is roughly the year 55000 and would sit at the
  // top of "Newest" forever; a 0 is 1970-01-01 and would sit at the bottom.
  // Neither is missing data — both are FABRICATED DATES that render as real
  // ones, which is the failure mode a nullable numeric field invites. So they
  // fail to build rather than reaching a screen. The window is deliberately wide:
  // this is a units tripwire, not an opinion about when models are released.
  const CREATED_MIN_UNIX_SEC = 946684800;   // 2000-01-01T00:00:00Z
  const CREATED_MAX_UNIX_SEC = 4102444800;  // 2100-01-01T00:00:00Z
  need(spec.createdUnixSec === undefined || spec.createdUnixSec === null
    || (Number.isFinite(spec.createdUnixSec)
      && spec.createdUnixSec >= CREATED_MIN_UNIX_SEC
      && spec.createdUnixSec <= CREATED_MAX_UNIX_SEC),
    '`createdUnixSec` must be a plausible epoch-SECONDS value or absent — absent means the provider publishes no release date. 0 is 1970 and a milliseconds value is the year 55000; both are fabricated dates that would rank as though real');
  need(spec.contextLength === undefined || spec.contextLength === null
    || (Number.isInteger(spec.contextLength) && spec.contextLength > 0),
    '`contextLength` must be a positive integer of INPUT tokens or absent — absent means unpublished, and 0 is what OpenRouter publishes for "unknown", which is not a size. It is never `maxOutput`, which is the OUTPUT ceiling');

  // ── A FLAG THE USER CANNOT SEE THE REASON FOR IS NOT A WARNING ────────────
  // `suitability: 'caution'` and `dominated` put a badge on a row, and the badge
  // word ('caution', 'out-performed') says a verdict without saying why. Until
  // now the WHY lived only in the multi-paragraph `note`, which both surfaces
  // are about to fold behind a disclosure — and a warning you have to open
  // something to discover is not a warning.
  //
  // So a flagged model must carry a SHORT reason that renders unfolded.
  // Required HERE, at module load, rather than asserted in a suite: flagging a
  // model without saying why becomes impossible rather than merely discouraged,
  // which is the same standard `note` itself is held to.
  //
  // IT IS THE HEADLINE OF `note`, NOT A SECOND DESCRIPTION OF THE MODEL. That
  // distinction is what keeps this from being the two-hand-maintained-copies
  // shape this repo keeps hitting, and the length cap is what enforces it
  // structurally — a field that cannot exceed one line cannot grow into a rival
  // account of the model. It is deliberately NOT derived from the other fields:
  // `moonshotai/kimi-k2-0905` is flagged for a runaway generation that happens
  // about once in nine documents and `minimax/minimax-m3:free` for a shared
  // upstream pool, and NEITHER is visible in any number here. A derived reason
  // would have rendered a confident, complete-looking line for both while
  // omitting the actual warning.
  //
  // DYNAMIC ENTRIES ARE EXEMPT. A fetched catalogue entry is `chat-only` by
  // construction and nobody measured it, so there is no reason to state; the
  // 'chat only — not for ingest' badge is its own reason. Requiring one would
  // force the catalogue builder to invent a caveat, which is the failure this
  // whole factory exists to prevent.
  const CAUTION_REASON_MAX = 120;
  const flagged = spec.suitability === 'caution' || Object.hasOwn(DOMINATED_MODELS, spec.id);
  if (spec.cautionReason !== undefined && spec.cautionReason !== null) {
    need(typeof spec.cautionReason === 'string' && spec.cautionReason.trim().length > 0,
      '`cautionReason` must be a non-empty string when present');
    need(spec.cautionReason.length <= CAUTION_REASON_MAX,
      `\`cautionReason\` is ${spec.cautionReason.length} chars, over the ${CAUTION_REASON_MAX}-char cap. It is the one-line HEADLINE of \`note\`, shown unfolded beside the price; if it needs more room it belongs in \`note\``);
    need(!/[\r\n]/.test(spec.cautionReason),
      '`cautionReason` must be a single line — it renders inline beside the price');
  }
  need(!flagged || opts.dynamic || (typeof spec.cautionReason === 'string' && spec.cautionReason.trim().length > 0),
    'is FLAGGED (`suitability: "caution"` or listed in DOMINATED_MODELS) but carries no `cautionReason`. The badge states a verdict; without this the reason for it is only inside `note`, which both pickers fold behind a disclosure — and a warning the user must open something to discover is not a warning');

  // A MOVING ALIAS IS NEVER OFFERABLE. Applies to every provider and every
  // admission path, because it is decidable from the id alone. See
  // looksLikeMovingAlias for why an id that resolves elsewhere cannot be priced
  // or measured, and for the check that no shipped id matches.
  need(!looksLikeMovingAlias(spec.id),
    'is a MOVING ALIAS (`*-latest`) — the id resolves to a different model that can change under the user, so neither the price we quote nor any measurement we record stays true for it');

  // ── THE OVERLAY IS THE CHAT LANE, STRUCTURALLY ────────────────────────────
  // `opts.dynamic` marks an entry admitted at RUNTIME from a provider's public
  // catalogue rather than hand-typed into the static table.
  //
  // THE BUG THIS CLOSES. The overlay's docblock claimed it "can only ever ADD
  // chat-lane offers" and NOTHING enforced it: `setOpenRouterCatalogue` passed
  // its spec straight through here with no constraint on `suitability`, so a
  // fabricated `{suitability:'general', jsonRaw:true, price, maxOutput}` was
  // admitted with `isBuildLaneModel` TRUE — verified by execution. The release's
  // central claim, "BUILD: hand-measured only", was resting on the discipline of
  // whoever wrote the catalogue-builder next.
  //
  // REFUSE rather than silently coerce to 'chat-only', and the reason is which
  // failure a caller can SEE. A refusal is counted in the returned `refused`
  // tally and named on stderr, so a builder that mis-declares 300 entries finds
  // out immediately. Coercion would admit all 300 quietly demoted, leaving the
  // builder believing the build lane had been populated over the network —
  // precisely the false belief this guard exists to destroy. Refusal is already
  // per-entry, so this drops one record, never the catalogue.
  //
  // This SUBSUMES the tiered-price refusal below for every dynamic entry (a
  // tiered model can only ever be chat-only anyway). That one's remaining job is
  // the hand-typed static table, where TIERED_PRICE_MODELS is the producer —
  // the same kind of hand-curated list as DOMINATED_MODELS.
  need(!opts.dynamic || spec.suitability === 'chat-only',
    'was admitted at RUNTIME from a provider catalogue and declared a BUILD-lane suitability. Only a HAND-MEASURED entry in the static table may serve ingest, Wiki Health or Compile; a fetched entry may only be `suitability: "chat-only"`');

  // ── LANE-SCOPED REQUIREMENTS ──────────────────────────────────────────────
  // `jsonRaw` records whether a raw JSON.parse of the INGEST OUTLINE succeeds
  // without the jsonrepair fallback. It is a measurement of JSON-mode ingest
  // behaviour and it is MEANINGLESS FOR CHAT, which is text mode. Requiring it
  // of a chat-only entry would force whoever admits one to invent a boolean
  // about a thing they never measured — the precise failure this factory exists
  // to prevent — so a 'chat-only' entry may omit it and carries `null`,
  // meaning "not measured", never `false`, which would read as "measured bad".
  //
  // Everything a BUILD-lane entry ('general' | 'caution') had to carry before
  // OpenRouter existed, it still has to carry. That half is unchanged.
  const buildLane = spec.suitability !== 'chat-only';
  if (buildLane) {
    need(typeof spec.jsonRaw === 'boolean',
      'missing measured `jsonRaw` — whether a raw JSON.parse of the ingest outline succeeds without the jsonrepair fallback. Required for any model offered for ingest/Health/Compile');
  } else {
    need(spec.jsonRaw === undefined || spec.jsonRaw === null || typeof spec.jsonRaw === 'boolean',
      '`jsonRaw` must be a boolean or omitted');
  }

  // A model whose rate changes above a prompt-size threshold cannot be
  // described by the single flat {input, output} pair every cost surface in
  // this app consumes. The build lane is the only lane that can cross such a
  // threshold, so tiered models are refused there STRUCTURALLY rather than by
  // convention. See TIERED_PRICE_MODELS for the full reasoning.
  const tiered = hasTieredPricing(spec.id, spec);
  need(!(tiered && buildLane),
    'has tiered (long-context) pricing, so a flat price would UNDER-STATE the bill on exactly the large ingests the build lane produces. Such a model may only be admitted as `suitability: "chat-only"`');

  need(hasKnownPricePosture(spec.id, spec),
    'no known price posture — a model may not be offerable unless it is either priced or explicitly free (see FREE_MODELS; a free model must NEVER be recorded as {input: 0, output: 0})');

  // A dynamically-admitted entry (the OpenRouter catalogue) brings its own price
  // and ceiling; a statically-admitted one DERIVES both, never re-types them,
  // because two hand-maintained copies of one fact is this repo's named cause of
  // the v3.2.0 CRITICAL — and here the copies would be money in a picker.
  // ── "THIS MODEL BILLS NOTHING" HAS EXACTLY ONE AUTHORITY ──────────────────
  // Register FIRST, then read the flag back out of `isFreeModel`, so `entry.free`
  // is a COPY of that answer rather than a second derivation of it. Written as
  // `spec.free === true || isFreeModel(spec.id)`, the two could — and did —
  // disagree: the runtime catalogue mints `free: true` for every `:free` id, none
  // of which are in the hand-typed FREE_MODELS, so `entry.free` said free while
  // `chargeForItem`'s `isFreeModel` said not-free and billed an invented $0.14.
  //
  // The `need()` below is what covers the STATIC path, where there is nothing to
  // register: a hand-typed spec claiming `free: true` for an id missing from
  // FREE_MODELS refuses to build at module load, in the house style — the same
  // answer `defineOfferableModel` already gives to a model with no price posture,
  // and strictly better than a test, because it cannot be skipped.
  // Registers only what the spec DECLARES, and only when `registerFreeModel`'s
  // `:free` test structurally confirms the declaration — so a spec claiming
  // `free: true` on a paid id registers nothing and is refused below, rather
  // than being billed at $0.00 against a real invoice.
  if (spec.free === true) registerFreeModel(spec.id, { dynamic: !!opts.dynamic });
  const free = isFreeModel(spec.id);
  need(spec.free !== true || free,
    'declares `free: true` but its id does not carry the `:free` suffix and is not in FREE_MODELS, so nothing here can confirm the claim. Admitting it would let `entry.free` (what every price surface reads) disagree with `isFreeModel()` (what the spend arithmetic reads) — which charges an invented figure for a model shown as free, or a hard $0.00 against a real bill');
  if (spec.price && !free) registerDynamicPrice(spec.id, spec.price);
  // `Object.hasOwn`, NOT a bare index. `MODEL_PRICES_USD_PER_MTOK['__proto__']`
  // returns the prototype OBJECT — truthy — so a bare `A[id] || B.get(id)`
  // short-circuited on it and resolved `standard.input` to `undefined`, which
  // `JSON.stringify` then dropped from the wire entirely: an entry served to the
  // picker with NO price field at all while `getModelPrice()` answered normally
  // from the Map. Measured on `__proto__`, `constructor` and `toString`, all
  // three of which were admitted. This is the v3.0.9 normalizeResponseStyle bug
  // shape; `resolveModelPrice` and `hasKnownPricePosture` already guard it and
  // this site did not. The id is caller-controlled on the dynamic path in
  // exactly the way `findOfferableModel`'s scan is not.
  const staticPrice = Object.hasOwn(MODEL_PRICES_USD_PER_MTOK, spec.id)
    ? MODEL_PRICES_USD_PER_MTOK[spec.id] : null;
  const standard = free ? null : (staticPrice || _dynamicPrices.get(spec.id) || null);
  need(free || standard, 'priced model resolved to no price — refusing to build an entry with a blank price');

  let maxOutput;
  if (Number.isFinite(spec.maxOutput) && spec.maxOutput > 0) {
    maxOutput = spec.maxOutput;
  } else {
    const caps = capsFor(provider);
    need(caps !== null, 'unknown provider — there is no output-cap map to read a ceiling from');
    need(Object.hasOwn(caps, spec.id),
      'no entry in the provider output-cap map — a model may not be offerable unless its output ceiling is known');
    maxOutput = caps[spec.id];
  }

  const promo = Object.hasOwn(PROMOTIONAL_PRICES, spec.id) ? PROMOTIONAL_PRICES[spec.id] : null;

  const entry = {
    id: spec.id,
    provider,
    label: spec.label,
    /** Hard output ceiling for this model, in tokens. */
    maxOutput,
    /** Measured: does it spend hidden reasoning tokens (billed as OUTPUT, drawn from the same budget as the answer)? */
    thinks: spec.thinks,
    /**
     * Measured: does a raw JSON.parse of the ingest outline succeed, or is the
     * jsonrepair fallback load-bearing? `null` means NOT MEASURED — only legal
     * on a 'chat-only' entry, where the question does not arise. Never coerce a
     * null here to `false`: "we never measured it" and "it measured badly" are
     * different facts and only one of them is a reason to warn a user.
     */
    jsonRaw: typeof spec.jsonRaw === 'boolean' ? spec.jsonRaw : null,
    /**
     * Measured INPUT-side token multiplier against this provider's older
     * tokenizer, on real Curator prose. 1.0 = no premium. It is deliberately NOT
     * applied to `output` anywhere: the 1.329x figure was measured on prompt
     * text, and silently extending an input measurement to output would be
     * over-claiming. It is also PROVIDER-RELATIVE — it compares models within one
     * provider and says nothing about Gemini-vs-Anthropic token counts.
     */
    tokenizerFactor: spec.tokenizerFactor,
    /** 'general' | 'chat-only' | 'caution' — see OFFERABLE_SUITABILITY. */
    suitability: spec.suitability,
    /** The measured reason behind `suitability`, written to be shown verbatim to a user. */
    note: spec.note,
    /**
     * Price after any promotion ends. Equal to input/output when there is no
     * promotion, and `null` for an explicitly-free model — never 0, which is a
     * truthy figure a budget guard would happily "enforce" (see FREE_MODELS).
     */
    standardInput: standard ? standard.input : null,
    standardOutput: standard ? standard.output : null,
    /** True when this model bills nothing. getModelPrice() returns null for it. */
    free,
    /**
     * Prompt-token threshold above which the published rate changes, or null.
     * Present so a UI can say so; a model carrying one can only ever be
     * 'chat-only' (see TIERED_PRICE_MODELS).
     */
    priceTierThresholdTokens: Number.isFinite(spec.priceTierThresholdTokens)
      ? spec.priceTierThresholdTokens : null,
    /** Last day of the current promotional price (ISO date), or null. */
    promotionUntilIso: promo ? promo.untilIso : null,
    /** First day the standard price applies (ISO date), or null. */
    standardPriceFromIso: promo ? promo.standardFromIso : null,
    /** True when a same-priced sibling measured better — see DOMINATED_MODELS. */
    dominated: Object.hasOwn(DOMINATED_MODELS, spec.id),
    /**
     * ── MEASURED OUTLINE COVERAGE: how detailed a wiki this plans ───────────
     * Pages this model planned from ONE source against the real ingest outline
     * prompt. `Low`/`High` are the observed range and travel together; `Median`
     * is present only where a median was actually computed (the OpenRouter
     * sessions recorded per-run page counts; the Gemini and Anthropic sessions
     * recorded a range only).
     *
     * `null` means UNMEASURED and MUST render as an omitted clause, never as 0
     * and never as an invented midpoint of the range.
     */
    outlinePagesLow,
    outlinePagesHigh,
    outlinePagesMedian,
    /**
     * Median wall-clock for one outline call, in milliseconds, or `null` when
     * that session did not record timings. It is a Curator-shaped fact rather
     * than a provider benchmark: ingest makes one such call to plan a document
     * and one per content batch after it, so this multiplies.
     */
    medianLatencyMs: (Number.isFinite(spec.medianLatencyMs) && spec.medianLatencyMs > 0)
      ? spec.medianLatencyMs
      // `Object.hasOwn`, never a bare index: `MEASURED_LATENCY_MS['__proto__']`
      // returns the prototype OBJECT, which is truthy, and the id is
      // caller-controlled on the dynamic path. Same guard, same reason, as the
      // price lookup below.
      : (Object.hasOwn(MEASURED_LATENCY_MS, spec.id) ? MEASURED_LATENCY_MS[spec.id] : null),
    /**
     * Provider-published release date, epoch SECONDS, or `null` when none is
     * published — which is every hand-typed entry in this table.
     *
     * `null` means UNKNOWN and must never be rendered or ranked as 1970. A
     * surface that sorts on this GROUPS the unknowns and states how many, rather
     * than handing them a date nobody published. See `orderModels` in
     * views/settings.js, which is the only consumer today.
     */
    createdUnixSec: Number.isFinite(spec.createdUnixSec) ? spec.createdUnixSec : null,
    /**
     * Published context window, in INPUT tokens, or `null` when unpublished.
     *
     * Read from the CONSERVATIVE `top_provider.context_length`, never the
     * optimistic headline `context_length` — see openRouterRecordToSpec for the
     * 39-of-387 disagreement that makes the choice matter.
     *
     * A DIFFERENT FACT FROM `maxOutput`, which is the OUTPUT ceiling. The two
     * must never substitute for one another: across the 374 live models
     * publishing both, output < context in 374 of 374 cases.
     */
    contextLength: Number.isInteger(spec.contextLength) ? spec.contextLength : null,
    /**
     * One-line headline of `note`, required for any flagged model, shown
     * UNFOLDED beside the price on both pickers. See the requirement in
     * defineOfferableModel for why this is a field and not a derivation.
     */
    cautionReason: (typeof spec.cautionReason === 'string' && spec.cautionReason.trim())
      ? spec.cautionReason.trim() : null,
  };

  // Resolved at READ time, so a promotion expiring mid-process cannot serve a
  // stale price. Enumerable + JSON-visible; see the docblock above.
  // `?? null` rather than a bare dereference: a free model resolves to no price
  // at all, and reading `.input` off null would throw at JSON.stringify time —
  // i.e. inside the route that serialises this table, taking the whole
  // /api/config/api-keys response down.
  Object.defineProperty(entry, 'input', {
    enumerable: true, configurable: false,
    get: () => resolveModelPrice(spec.id)?.input ?? null,
  });
  Object.defineProperty(entry, 'output', {
    enumerable: true, configurable: false,
    get: () => resolveModelPrice(spec.id)?.output ?? null,
  });

  return Object.freeze(entry);
}

/**
 * ── OFFERABLE_MODELS: the models a user may pick with their own key ─────────
 *
 * Until this table existed The Curator could run exactly two models, one per
 * provider, both the cheapest tier. That kept ingestion of large libraries
 * affordable and it stays the DEFAULT — but it also meant a user who wanted more
 * capability out of a big wiki, and was willing to pay for it on their own key,
 * had no way to ask. This table is that ask: every model here was probed live on
 * 2026-08-26 with this repo's REAL buildOutlinePrompt on real prose, and every
 * entry carries what that probe measured so the cost and the trade-off are both
 * visible at the moment of choosing.
 *
 * SHAPE IS A PUBLIC CONTRACT. `src/routes/config.js` serialises these entries
 * VERBATIM onto `GET /api/config/api-keys` → `offerable`, so every field here is
 * user-facing wire format. Add fields freely (additive); never rename or remove
 * one without checking that route and its consumers.
 *
 * ORDER IS CHEAPEST-FIRST within each provider and is asserted, because a picker
 * that leads with the priciest model is a cost trap. Ordering is on the STANDARD
 * price so the array cannot silently re-order itself when a promotion expires;
 * the suite additionally checks the order holds at the promotional price too.
 * Ties are broken by suitability (general before caution before chat-only) and
 * then newest-first — the same forward-in-time tie-break FALLBACK_CHAINS uses.
 *
 * WHAT IS DELIBERATELY ABSENT:
 *   • Gemini Pro — the maintainer's call, and the measured picture agrees: it is
 *     a different price class again and nothing in this list is coverage-starved.
 *   • claude-opus-4-7 / claude-opus-4-6 — real, documented, never probed. See
 *     AWAITING_MEASUREMENT.
 *   • Every RETIRED id (test-chat-model.js §9) — those 404.
 */
export const OFFERABLE_MODELS = Object.freeze({
  gemini: Object.freeze([
    defineOfferableModel('gemini', {
      id: 'gemini-2.5-flash-lite',
      label: 'Flash Lite 2.5',
      thinks: false, jsonRaw: true, tokenizerFactor: 1.0,
      suitability: 'general',
      outlinePagesLow: 18, outlinePagesHigh: 20,
      note:
        'The default, and the cheapest model on either provider. Measured 3/3 clean raw JSON, no ' +
        'hidden reasoning tokens, and the widest outline coverage of any Gemini model probed ' +
        '(18-20 pages on the reference source). Nothing here beats it on value for ingest.',
    }),
    defineOfferableModel('gemini', {
      id: 'gemini-3.1-flash-lite',
      label: 'Flash Lite 3.1',
      thinks: false, jsonRaw: true, tokenizerFactor: 1.0,
      suitability: 'caution',
      outlinePagesLow: 5, outlinePagesHigh: 12,
      cautionReason:
        'Dearer than the default and plans thinner outlines.',
      note:
        '2.5x the input and 3.75x the output price of the default, and measured THINNER than it: ' +
        '5-12 outline pages where the default plans 18-20 on the same source. Clean JSON (3/3) and ' +
        'no hidden reasoning tokens, so it is safe — just a worse deal for ingest. It is here ' +
        'because it is the closest live successor to the default and the first fallback rung.',
    }),
    defineOfferableModel('gemini', {
      id: 'gemini-2.5-flash',
      label: 'Flash 2.5',
      thinks: true, jsonRaw: true, tokenizerFactor: 1.0,
      suitability: 'general',
      outlinePagesLow: 17, outlinePagesHigh: 19,
      note:
        'Clean raw JSON 3/3 and 17-19 outline pages — coverage on a par with the default at 3x the ' +
        'input price. Spends 1,700-2,629 hidden reasoning tokens per call: those are billed as ' +
        'OUTPUT and drawn from the SAME output budget as the answer, so leave headroom.',
    }),
    defineOfferableModel('gemini', {
      id: 'gemini-3.5-flash-lite',
      label: 'Flash Lite 3.5',
      thinks: false, jsonRaw: false, tokenizerFactor: 1.0,
      suitability: 'chat-only',
      cautionReason:
        '2 of 9 ingest runs returned JSON that nothing could repair.',
      note:
        'Not recommended for ingest. 2 of 9 live runs against the real ingest outline prompt ' +
        'returned JSON that neither JSON.parse nor jsonrepair could repair (a dropped object key, ' +
        'finishReason STOP — a generation defect, not truncation). Chat is text mode and is ' +
        'unaffected, so it stays pickable there. gemini-2.5-flash costs exactly the same and was ' +
        '3/3 clean on the identical probe.',
    }),
    defineOfferableModel('gemini', {
      id: 'gemini-3.7-flash',
      label: 'Flash 3.7',
      thinks: true, jsonRaw: true, tokenizerFactor: 1.0,
      suitability: 'caution',
      outlinePagesLow: 12, outlinePagesHigh: 16,
      cautionReason:
        'Thinner outlines than the far cheaper default, and the promotional price doubles when it ends.',
      note:
        'PROMOTIONAL PRICE: $0.75/$3.75 per 1M tokens through 2026-12-31, then $1.50/$7.50 from ' +
        '2027-01-01 — the standard price is what standardInput/standardOutput carry, and it applies ' +
        'itself on the date. Measured 3/3 clean raw JSON and 12-16 outline pages (thinner than the ' +
        'far cheaper default). Spends 915-1,066 hidden reasoning tokens per call, billed as output ' +
        '— the least of any thinking model here.',
    }),
    defineOfferableModel('gemini', {
      id: 'gemini-3.6-flash',
      label: 'Flash 3.6',
      thinks: true, jsonRaw: true, tokenizerFactor: 1.0,
      suitability: 'caution',
      outlinePagesLow: 12, outlinePagesHigh: 16,
      cautionReason:
        'Same price and coverage as Flash 3.7, but spends more hidden reasoning.',
      note:
        'PROMOTIONAL PRICE: $0.75/$3.75 per 1M tokens through 2026-12-31, then $1.50/$7.50 from ' +
        '2027-01-01. Measured 3/3 clean raw JSON and 12-16 outline pages. Spends 1,293-1,573 hidden ' +
        'reasoning tokens per call, billed as output — more than gemini-3.7-flash for the same ' +
        'measured coverage and the same price.',
    }),
    defineOfferableModel('gemini', {
      id: 'gemini-3.5-flash',
      label: 'Flash 3.5',
      thinks: true, jsonRaw: true, tokenizerFactor: 1.0,
      suitability: 'caution',
      outlinePagesLow: 8, outlinePagesHigh: 14,
      cautionReason:
        'The dearest Gemini here, and it plans thinner outlines than the default.',
      note:
        'The most expensive Gemini model here and not the strongest: 15x the input and 22.5x the ' +
        'output price of the default, yet measured THINNER than it at 8-14 outline pages against ' +
        '18-20. Clean JSON 3/3, but it also spends 1,614-2,067 hidden reasoning tokens per call, ' +
        'billed as output. Pick it only for a specific reason.',
    }),
  ]),
  anthropic: Object.freeze([
    defineOfferableModel('anthropic', {
      id: 'claude-haiku-4-5',
      label: 'Haiku 4.5',
      thinks: false, jsonRaw: false, tokenizerFactor: 1.0,
      suitability: 'general',
      outlinePagesLow: 5, outlinePagesHigh: 13,
      note:
        'The default and the cheapest Anthropic model. No hidden reasoning tokens, but it wraps its ' +
        'ingest-outline JSON in ```json fences 3/3, so every ingest on it depends on the jsonrepair ' +
        'fence-stripping fallback (benign — that is what the fallback is for). Its outline coverage ' +
        'is the MOST VARIABLE measured, 5 to 13 pages on the same source, so a long document may be ' +
        'planned much more thinly on one run than the next. That variability is the single best ' +
        'reason to reach for a stronger model on a big wiki.',
    }),
    defineOfferableModel('anthropic', {
      id: 'claude-sonnet-5',
      label: 'Sonnet 5',
      thinks: true, jsonRaw: true, tokenizerFactor: 1.329,
      suitability: 'general',
      outlinePagesLow: 16, outlinePagesHigh: 18,
      note:
        'The strongest value here: cheaper than both Sonnet 4.6 and 4.5 while measuring better than ' +
        'either — 7/7 clean raw JSON, a steady 16-18 outline pages, and a 128,000 output ceiling. ' +
        'Two costs the headline price hides: it is the only model measured running adaptive thinking ' +
        'on every single call (7/7, billed as output), and its newer tokenizer produced 1.329x more ' +
        'input tokens than Haiku 4.5 on the same prose — so $2 per 1M input is really ~$2.66 of the ' +
        'same text.',
    }),
    defineOfferableModel('anthropic', {
      id: 'claude-sonnet-4-6',
      label: 'Sonnet 4.6',
      thinks: false, jsonRaw: true, tokenizerFactor: 1.0,
      suitability: 'general',
      outlinePagesLow: 17, outlinePagesHigh: 17,
      note:
        'The most predictable model measured: 3/3 clean raw JSON, no hidden reasoning tokens at all, ' +
        'a 128,000 output ceiling and a steady 17-page outline every run. At $3/$15 it is 50% dearer ' +
        'than claude-sonnet-5, which measured stronger — choose this when you specifically want zero ' +
        'thinking-token spend and no tokenizer premium.',
    }),
    defineOfferableModel('anthropic', {
      id: 'claude-sonnet-4-5',
      label: 'Sonnet 4.5',
      thinks: false, jsonRaw: false, tokenizerFactor: 1.0,
      suitability: 'caution',
      outlinePagesLow: 15, outlinePagesHigh: 16,
      cautionReason:
        'Behind the same-priced Sonnet 4.6 on three measured axes.',
      note:
        'Same $3/$15 as claude-sonnet-4-6 but behind it on three measured axes: half the output ' +
        'ceiling (64,000 vs 128,000), fenced JSON rather than raw, and 15-16 outline pages against ' +
        '17. claude-sonnet-5 is cheaper AND measured stronger than both. It is here because it is ' +
        'the last rung of the Anthropic fallback chain; there is no reason to choose it deliberately.',
    }),
    defineOfferableModel('anthropic', {
      id: 'claude-opus-5',
      label: 'Opus 5',
      thinks: false, jsonRaw: true, tokenizerFactor: 1.329,
      suitability: 'general',
      outlinePagesLow: 25, outlinePagesHigh: 27,
      note:
        'The richest planner measured — 25-27 outline pages where the default plans 5-13 on the same ' +
        'source — with 3/3 clean raw JSON, no hidden reasoning tokens and a 128,000 output ceiling. ' +
        'Also the most expensive: $5/$25 headline, and its newer tokenizer produced 1.329x more input ' +
        'tokens than Haiku 4.5 on the same prose, so the real input cost is ~$6.65 per 1M ' +
        'Haiku-equivalent tokens — 6.6x the default, not the 5x the headline implies.',
    }),
    defineOfferableModel('anthropic', {
      id: 'claude-opus-4-8',
      label: 'Opus 4.8',
      thinks: false, jsonRaw: true, tokenizerFactor: 1.329,
      suitability: 'caution',
      outlinePagesLow: 19, outlinePagesHigh: 20,
      cautionReason:
        'Plans thinner outlines than Opus 5 at the identical price.',
      note:
        'Priced identically to claude-opus-5 ($5/$25), same 128,000 ceiling, same clean raw JSON, no ' +
        'thinking, same 1.329x tokenizer premium — but measured 19-20 outline pages against opus-5\'s ' +
        '25-27 on the identical source. No axis measured better than opus-5. Flagged rather than ' +
        'listed as dominated because that verdict rests on outline coverage alone from a small ' +
        'sample, and an over-claimed domination is worth less than an honest number.',
    }),
    defineOfferableModel('anthropic', {
      id: 'claude-opus-4-5',
      label: 'Opus 4.5',
      thinks: false, jsonRaw: false, tokenizerFactor: 1.0,
      suitability: 'caution',
      outlinePagesLow: 12, outlinePagesHigh: 13,
      cautionReason:
        'Out-performed by Opus 5 at the identical price.',
      note:
        'Dominated by claude-opus-5 at the identical $5/$25: half the output ceiling (64,000 vs ' +
        '128,000), fenced JSON rather than raw, and 12-13 outline pages against 25-27 — thinner than ' +
        'claude-sonnet-5 plans at two-fifths of the price. Offered because the choice is yours, but ' +
        'nothing measured supports paying $5 per 1M for it.',
    }),
  ]),
  /**
   * OpenRouter's catalogue is 417 models and moves independently of our release
   * process, so it splits into two lanes with two admission standards:
   *
   *   BUILD (ingest / Health / Compile) — must be HAND-MEASURED against this
   *     repo's real ingest outline prompt, exactly as every entry above was.
   *     The THREE entries below are that measurement; the session is recorded
   *     immediately underneath. Nothing here may be filled in from the
   *     provider's metadata: `thinks`, `jsonRaw`, `suitability` and `note` are
   *     MEASUREMENTS, and OpenRouter's API reports capability flags
   *     (`supported_parameters`, `reasoning.mandatory`) which are a UNION ACROSS
   *     UPSTREAM PROVIDERS — candidacy, never a guarantee.
   *
   *   CHAT — admitted at RUNTIME from the provider's public catalogue via
   *     setOpenRouterCatalogue(), because a static list of 417 entries would be
   *     stale the week it shipped. Those entries are additive to this table and
   *     are read through listOfferableModels(), not from here.
   *
   * ⚠ THIS BLOCK OPENED "EMPTY IN THIS RELEASE … that measurement session has
   * not happened yet, so nothing is listed" — directly above three populated,
   * measured entries, and directly above its OWN "WHAT WAS MEASURED, 2026-08-27"
   * section describing how they were probed. It contradicted the code and
   * itself. It is corrected rather than deleted because the lane split it
   * explains is still exactly right and is the reason the table has the shape
   * it has; only the count was stale. The FAIL-SAFE argument it used to make —
   * that an empty array refuses everything, so a half-wired provider costs
   * nobody money — was true of the empty state and no longer describes this one,
   * so it is gone rather than left to reassure a reader about a property the
   * table no longer has.
   *
   * ── WHAT WAS MEASURED, 2026-08-27 ────────────────────────────────────────
   * Every entry below was probed with this repo's REAL `buildOutlinePrompt`
   * (via ingest.js's `__testing` export), built READ-ONLY from the real
   * `articles` domain: a 127,666-char index, 607 entity and 2,685 concept
   * filenames, plus a real 158,992-char source document truncated to ingest's
   * own TEXT_CAP of 80,000. The assembled prompt was 341,005 chars (~77-80k
   * provider-counted tokens) and was BYTE-IDENTICAL across every model, which
   * is what makes the page counts and `tokenizerFactor` below comparable to
   * each other. Requests went through OpenRouterAdapter, so they carried the
   * production `provider: {allow_fallbacks:false, require_parameters:true}`
   * and `response_format: {type:'json_object'}` at maxTokens 24,576.
   *
   * `tokenizerFactor` is PROVIDER-RELATIVE and baselined on the pinned default
   * (upstage/solar-pro4, 77,080 prompt tokens = 1.0) — it says nothing about
   * Gemini or Anthropic token counts.
   *
   * ── WHAT WAS REFUSED, and why it is not a short list by accident ─────────
   *   nex-agi/nex-n2-mini      3 of 3 runs UNREPAIRABLE. It spent its ENTIRE
   *                            24,576-token output budget on hidden reasoning
   *                            (reasoning_tokens 24,576, finishReason "length")
   *                            and returned no parseable outline at all, at
   *                            ~$0.0045 and ~160s per attempt. NOTHING in its
   *                            catalogue metadata could have predicted that in
   *                            either direction: it reads {"mandatory": false},
   *                            byte-identical to upstage/solar-pro4, which
   *                            measured 9/9 CLEAN — and `default_enabled`, the
   *                            field that would signal reasoning-on-by-default,
   *                            is ABSENT on both rather than false (74 of the
   *                            380 catalogued models carry that exact shape).
   *                            An absent field is not a "no": only a real
   *                            probe could have found this.
   *   openai/gpt-oss-20b       18 of 18 runs HTTP 429, across 1.5s and 45s
   *                            spacings, while a trivial prompt to the same id
   *                            succeeded — a throughput limit that makes it
   *                            unmeasurable on a real ingest prompt. A model we
   *                            could not measure may not be offered.
   *   ibm-granite/granite-4.1-8b  Measured CLEAN (9/9 raw JSON, 10-28 pages)
   *                            and still not admitted: upstage/solar-pro4 is
   *                            cheaper on input ($0.03 vs $0.05 — and input is
   *                            ~98% of an outline call's tokens), plans wider
   *                            outlines (median 23 vs 13) and is equally clean.
   *   liquid/lfm-2.5-2.6b:free 8,192 output ceiling, below the 24,576 the
   *                            outline requests — structurally unable to serve.
   *   dots-studio/dots-3-note-preview:free  carries `expiration_date`
   *                            2026-09-30, i.e. it retires inside this release's
   *                            own lifetime.
   *
   * ── SECOND SESSION, 2026-08-28 — 9 more candidates, 2 admitted ───────────
   * Same harness, same method, one difference worth knowing: the assembled
   * prompt was 343,716 chars this time (341,005 in the first session, the
   * `articles` domain having grown), so the prompt-token BASELINE moved and
   * `tokenizerFactor` is a RATIO against that session's own solar-pro4 figure
   * (74,521 prompt tokens = 1.0) rather than against the first session's.
   * upstage/solar-pro4 was re-run as a positive control and reproduced its
   * recorded behaviour — 9/9 raw JSON — at a median of 25 pages against the 23
   * recorded in v3.15.0, which is the run-to-run spread of the same model, not
   * a change in it.
   *
   * SEVEN REFUSED. The first four are generation or availability defects; the
   * last three passed on JSON and were refused on facts about the ID ITSELF,
   * which is the lesson of this session:
   *
   *   z-ai/glm-4.7             0 of 9 runs parseable — all 9 UNREPAIRABLE by
   *                            both JSON.parse and jsonrepair. It passes every
   *                            structural filter, is fast (34-64s), and is
   *                            priced like a serious model ($0.40/$1.75). Only
   *                            the real prompt caught it.
   *   minimax/minimax-m3       0 of 9 runs parseable, all 9 UNREPAIRABLE — and
   *                            its FREE sibling `minimax/minimax-m3:free` is
   *                            SHIPPED above on 8/9 raw + 1 repaired. Same base
   *                            model, opposite result. RECORD THIS: reliability
   *                            here is a property of the ROUTE, not of the
   *                            model's identity, so no measurement of one id
   *                            may ever be carried across to a sibling id.
   *   deepseek/deepseek-v4-flash-0731  Abandoned after 2 runs. The first took
   *                            382 SECONDS for a single outline call (~8x the
   *                            control's median 48s) and the second never
   *                            returned a body inside the adapter's 600-second
   *                            ceiling. Not a JSON defect — a latency one.
   *                            ⚠ THIS ROW READ "491 SECONDS" AND THAT NUMBER
   *                            WAS IN NO RUN. The probe records hold 381,987 ms
   *                            and 600,008 ms; 491s is their mean, written up as
   *                            if it were the first call's time. Corrected while
   *                            transcribing it into MEASURED_LATENCY_MS, where
   *                            the figure is now 382,000 — the ONE run that
   *                            produced a usable result, which is the only run a
   *                            latency may be quoted from. The verdict is
   *                            unchanged; only the number was wrong.
   *   z-ai/glm-5.2:free        3 of 3 attempts HTTP 429 before any work began.
   *                            NOT_MEASURED — which is neither a defect nor a
   *                            pass. A model we could not measure may not be
   *                            offered, the same verdict openai/gpt-oss-20b got
   *                            above.
   *   qwen/qwen3-235b-a22b-2507  MEASURED CLEAN — 9/9 raw JSON, 20-29 pages,
   *                            median 23, no reasoning tokens, ~40s. Refused on
   *                            PRICE HONESTY. Its cheapest JSON-capable
   *                            endpoint (GMICloud) publishes $0.0875/$0.35, but
   *                            the one cold call billed $0.011801 for 77,823 in
   *                            / 1,132 out, which is Parasail's $0.14/$0.80
   *                            exactly — 1.64x what a table entry would have
   *                            quoted, on the first request. An id that can
   *                            silently route off its cheapest endpoint has no
   *                            single number this app can put in front of a
   *                            user before they spend, which is the same harm
   *                            TIERED_PRICE_MODELS exists to refuse, arriving
   *                            through a different door.
   *   moonshotai/kimi-k2.6     MEASURED CLEAN — 9/9 raw JSON, 20-43 pages,
   *                            median 25, no reasoning tokens, and the fastest
   *                            wide planner tested (22-38s). Refused for the
   *                            same reason in the opposite direction: 19
   *                            JSON-capable endpoints spanning $0.5372 to
   *                            $1.0900 on input (2.03x), and the cold run
   *                            billed Decart's $0.5372/$2.2618 while the
   *                            catalogue headline reads $0.95/$4.00. Quoting
   *                            the headline over-states by 77% today and
   *                            under-states on the $1.09 endpoint tomorrow.
   *                            Over-quoting is the safe direction and it is
   *                            still a number we would be making up.
   *   qwen/qwen3-30b-a3b-instruct-2507  MEASURED CLEAN and CHEAP — 8/8 of the
   *                            runs that started returned raw JSON (a 9th was
   *                            429'd before it began), 17-25 pages, no
   *                            reasoning tokens, and the fastest of everything
   *                            tested at 13-22s. Its price was exact on all 8
   *                            runs. Refused on CONTEXT: the endpoint that
   *                            serves and bills it at $0.04815 (StreamLake)
   *                            carries a 128,000-token context window and a
   *                            32,000-token completion ceiling. The four
   *                            endpoints that do offer 262,144 cost $0.09-$0.13,
   *                            so the cheap price and the large window are not
   *                            available at the same time. 128,000 is below the
   *                            200,000 floor every other build-lane model
   *                            clears, and a wiki whose index outgrows it
   *                            starts failing on the largest domains — the ones
   *                            most likely to be reaching for a second opinion.
   *
   * WHAT THIS SESSION ACTUALLY ADDED TO THE METHOD. The first session verified
   * that a computed price matched `usage.cost`. That check was treated as a
   * confirmation; it turns out to be a FILTER, and the sharpest one available.
   * Three of the five candidates that passed every JSON, ceiling and reasoning
   * test failed it or the context floor. Cost the check nothing — the probe
   * already records `reported_cost_usd` — and only a COLD run can perform it,
   * because a cached run bills a fraction and matches nothing.
   */
  openrouter: Object.freeze([
    defineOfferableModel('openrouter', {
      id: 'minimax/minimax-m3:free',
      label: 'MiniMax M3 (free)',
      maxOutput: 943718, free: true,
      thinks: false, jsonRaw: false, tokenizerFactor: 1.015,
      suitability: 'caution',
      outlinePagesLow: 15, outlinePagesHigh: 40, outlinePagesMedian: 21,
      cautionReason:
        'Free models share an upstream pool — availability is real but not promised.',
      note:
        'FREE, and the widest outlines measured on OpenRouter: 15-40 pages (median 21) against the ' +
        'real ingest prompt, with no hidden reasoning tokens in any of 9 runs. Two measured caveats. ' +
        '(1) 8 of 9 runs parsed as raw JSON and 1 needed the jsonrepair fallback — none were ' +
        'unrepairable, so it is safe, but the repair path is load-bearing. (2) Free models draw on a ' +
        'SHARED upstream pool: over a 10-round availability poll it served 8/8, but four of its free ' +
        'siblings served 0/8 and returned "temporarily rate-limited upstream" throughout. A free ' +
        'model is a real option, not a guaranteed one — nothing is billed, and nothing is promised.',
    }),
    defineOfferableModel('openrouter', {
      id: 'ibm-granite/granite-4.0-h-micro',
      label: 'Granite 4.0 H Micro',
      maxOutput: 117900,
      thinks: false, jsonRaw: true, tokenizerFactor: 1.036,
      suitability: 'caution',
      outlinePagesLow: 7, outlinePagesHigh: 13, outlinePagesMedian: 9,
      cautionReason:
        'The thinnest outlines measured here — a less detailed wiki from the same source.',
      note:
        'The cheapest paid model here and the cheapest The Curator offers anywhere: $0.017/$0.112 per ' +
        '1M tokens, roughly a sixth of the cheapest Gemini option on input. Perfectly clean — 9 of 9 runs ' +
        'parsed as raw JSON with no jsonrepair and no hidden reasoning tokens — but THIN: 7-13 outline ' +
        'pages (median 9) where solar-pro4 plans a median of 23 on the identical prompt. Fewer planned ' +
        'pages means a less detailed wiki from the same source, so pick it when cost dominates.',
    }),
    defineOfferableModel('openrouter', {
      id: 'upstage/solar-pro4',
      label: 'Solar Pro 4',
      maxOutput: 131072,
      thinks: false, jsonRaw: true, tokenizerFactor: 1.0,
      suitability: 'general',
      outlinePagesLow: 14, outlinePagesHigh: 36, outlinePagesMedian: 23,
      note:
        'The pinned OpenRouter default. 9 of 9 runs returned raw JSON that parsed WITHOUT jsonrepair ' +
        '— stricter than our own Anthropic default, which fences its JSON 3/3 and depends entirely on ' +
        'the repair path — and 14-36 outline pages (median 23), coverage comparable to the cheapest ' +
        'Gemini option at roughly a third of its price ($0.03/$0.12 against $0.10/$0.40). No hidden ' +
        'reasoning tokens in any run, so the whole output budget goes to the answer.',
    }),
    defineOfferableModel('openrouter', {
      id: 'z-ai/glm-5.3-flash',
      label: 'GLM 5.3 Flash',
      maxOutput: 131072,
      thinks: true, jsonRaw: true, tokenizerFactor: 1.041,
      suitability: 'caution',
      outlinePagesLow: 25, outlinePagesHigh: 28, outlinePagesMedian: 27,
      cautionReason:
        'Far slower than the default, and most of its output is hidden reasoning you never see.',
      note:
        'Clean but SLOW, and it thinks. 8 of 9 runs returned a body and all 8 parsed as raw JSON with ' +
        'no jsonrepair and nothing unrepairable, planning 25-28 outline pages (median 27) — wider ' +
        'than the pinned default. Two measured costs to weigh first. (1) SPEED: those 8 runs took ' +
        '120-231 seconds each (median 188s) against 23-88s (median 48s) for upstage/solar-pro4 on the ' +
        'byte-identical prompt, and the 9th never came back at all — the adapter\'s 600-second body ' +
        'ceiling elapsed. Ingest makes one such call to plan a document and one per content batch ' +
        'after it, so a document that takes a minute on the default can take five here, and roughly ' +
        '1 call in 9 will time out and be retried. (2) HIDDEN REASONING: every run spent 4,976-9,781 ' +
        'tokens on reasoning the user never sees — 79-86% of its entire output — billed as output ' +
        'and drawn from the same 24,576-token budget as the answer. Priced $0.075/$0.25 on the ' +
        'cheapest of its 15 endpoints, which is what it billed on both cold runs; 12 of those 15 ' +
        'charge $0.150/$0.50, so this is the one entry here whose real rate could double without ' +
        'the model id changing.',
    }),
    defineOfferableModel('openrouter', {
      id: 'moonshotai/kimi-k2-0905',
      label: 'Kimi K2 0905',
      maxOutput: 100352,
      thinks: false, jsonRaw: false, tokenizerFactor: 1.022,
      suitability: 'caution',
      outlinePagesLow: 21, outlinePagesHigh: 44, outlinePagesMedian: 30,
      cautionReason:
        'Runs away about once in nine documents, planning hundreds of pages instead of ~30.',
      note:
        'The widest outlines measured on OpenRouter — 21-44 pages, median 30, against the pinned ' +
        'default\'s median 25 on the byte-identical prompt — with no hidden reasoning tokens in any ' +
        'of 9 runs and 25-43 second latency. All 9 were usable: 8 parsed as raw JSON and 1 needed ' +
        'jsonrepair. ⚠ THAT ONE REPAIRED RUN IS THE REASON THIS IS FLAGGED, and it is not an ' +
        'ordinary repair. It ran away: it consumed the ENTIRE 24,576-token output budget ' +
        '(finishReason "length"), took 467 seconds instead of ~30, planned 903 pages instead of ~30, ' +
        'and cost $0.107 against ~$0.048 for a normal run. jsonrepair salvaged the truncated JSON so ' +
        'nothing was lost, but a 903-page plan is a generation defect and ingest would try to write ' +
        'it. Budget for that happening about once in nine documents. Also the dearest OpenRouter ' +
        'option here at $0.60/$2.50 — 20x the pinned default on input, which is ~98% of an outline ' +
        'call\'s tokens. Its price at least cannot surprise you: it has exactly one endpoint.',
    }),
  ]),
});

/**
 * ── The LIVE OpenRouter chat catalogue ───────────────────────────────────────
 *
 * Additive overlay on OFFERABLE_MODELS.openrouter, populated at runtime from
 * `fetchOpenRouterCatalogue()`. Empty until something populates it, so the
 * default state of this module is "OpenRouter offers nothing", which is what
 * makes a partially-wired provider harmless.
 *
 * WHY AN OVERLAY RATHER THAN A MUTABLE TABLE. OFFERABLE_MODELS is frozen and is
 * serialised verbatim onto the wire; keeping it frozen means the hand-measured
 * build-lane entries can never be replaced by something fetched over the
 * network. The overlay can only ever ADD chat-lane offers.
 *
 * THAT LAST SENTENCE WAS FALSE WHEN IT WAS WRITTEN, and is now enforced. Nothing
 * constrained `suitability` on the way in, so a fetched entry declaring
 * `'general'` was admitted with `isBuildLaneModel` true — the overlay could
 * reach the lane that WRITES the user's wiki. `setOpenRouterCatalogue` now
 * refuses any dynamic entry that is not `'chat-only'`, at the admission function
 * and again on the built entry. See both for the reasoning.
 */
let _openrouterCatalogue = Object.freeze([]);

// Provenance of whatever is in `_openrouterCatalogue` right now. Declared HERE,
// beside the thing they describe, so there is no order in which one can be read
// without the other having been initialised.
let _openrouterCatalogueSyncedAt = null;
let _openrouterCatalogueSource = null; // 'network' | 'disk' | null

/**
 * Replace the live OpenRouter chat catalogue.
 *
 * Every entry goes through `defineOfferableModel`, the SAME admission function
 * the hand-measured entries use, so a fetched model is held to the same
 * structural standard: it must carry a label, a `thinks` verdict, a price
 * posture, an output ceiling and a `note`, or it does not become an offer.
 *
 * REFUSAL IS PER-ENTRY, NOT ALL-OR-NOTHING: one malformed record in a
 * 417-element response must not take the whole catalogue down, so a rejected
 * entry is dropped with a stderr line and the rest are admitted. Refusing the
 * lot would hand a third party a switch that disables the feature.
 *
 * @param {Array<object>} specs
 * @returns {{admitted: number, refused: number}}
 */
export function setOpenRouterCatalogue(specs) {
  // ── THE PRICE REGISTRY IS REBUILT, NOT APPENDED TO ────────────────────────
  // `_dynamicPrices` used to be write-only: `registerDynamicPrice` added and
  // nothing ever removed, while THIS function replaced `_openrouterCatalogue`
  // wholesale. So a price outlived the offer it belonged to. Measured:
  //
  //   load 1: 'z/model' priced $1/$5      -> getModelPrice = {input:1,output:5}
  //   load 2: same id, now free:true      -> entry.free true, standardInput null,
  //                                          getModelPrice STILL {input:1,output:5}
  //   load 3: setOpenRouterCatalogue([])  -> getModelPrice STILL {input:1,output:5}
  //
  // That breaks the invariant the whole price posture rests on — `getModelPrice()`
  // MUST return null for a free model — and it breaks it in the exact direction
  // the posture exists to prevent: a non-null price on a model that bills nothing
  // re-arms `createJob`'s budget cap and renders a dollar figure on a free row.
  //
  // Clearing FIRST and pruning to the admitted set afterwards makes the registry
  // a function of the current catalogue rather than of every catalogue ever
  // loaded. The prune matters on its own: `registerDynamicPrice` runs before the
  // last few `need()` checks, so a REFUSED entry can still have written a price,
  // and a price for a model nobody can select is the same stale-money surface in
  // a smaller font. Synchronous throughout, so no caller can observe the gap.
  _dynamicPrices.clear();
  // Same lifecycle, same reason, and the direction of harm is the sharper one.
  // A stale PRICE renders a dollar figure on a model that bills nothing; a stale
  // FREE registration does the opposite — it makes `isFreeModel` true for an id
  // that has since become PAID, and `chargeForItem` checks freeness FIRST and
  // returns a hard 0, so a real bill would be recorded as $0.00 with
  // `spendIsEstimated` left false. Under-reporting money while asserting the
  // figure is measured is the worst available combination (v3.9.0).
  _dynamicFree.clear();

  // ── A HAND-MEASURED ID IS NEVER SUPERSEDED BY A FETCHED ONE ───────────────
  // FOUND BY THE FIRST LIVE SYNC, not by reading: OpenRouter's public catalogue
  // of course lists the very models we hand-measured, so 2 of the 3 static
  // entries came back as dynamic specs too. `listOfferableModels` concatenates
  // `[...static, ...dynamic]`, so the picker rendered `upstage/solar-pro4`
  // TWICE — once as the pinned build-lane default ("9 of 9 runs returned raw
  // JSON… 14-36 outline pages") and once, immediately below, as "Chat only —
  // never measured against The Curator's ingest prompt". Two rows, one id,
  // contradicting each other about whether the model has been measured, on the
  // screen where a user picks what to spend money through.
  //
  // Routing was never at risk — `findOfferableModel` uses `.find()` and static
  // comes first, and `registerDynamicPrice` already refuses a statically-priced
  // id — so this was a pure reporting defect, which is exactly the kind this
  // repo keeps finding late. The static entry wins because it carries a real
  // measurement and the fetched one explicitly carries none.
  //
  // Counted SEPARATELY from `refused`: nothing failed here. Folding it into the
  // refusal tally would report our own shipping defaults as rejected models
  // every time a user syncs.
  const staticIds = new Set((OFFERABLE_MODELS.openrouter || []).map(e => e.id));

  // ── AN ID IS A KEY, AND SEVERAL OF THE LOOKUPS IT KEYS ARE NOT PROVIDER-
  //    SCOPED ────────────────────────────────────────────────────────────────
  // `getModelPrice(id)`, `isFreeModel(id)` and `anthropicMaxOutputTokens(id)`
  // take an id and nothing else, and `chargeForItem` keys on `tokenUsage.model`
  // — the model that actually RAN. So a fetched entry claiming a BUILT-IN id
  // from ANOTHER provider would be offered under `openrouter` while every
  // id-keyed money lookup answered with the built-in's figures.
  //
  // NOT A LIVE EXPLOIT, and the comment says so rather than dressing it up:
  // measured against the real provider list, all 198 live specs carry a
  // `vendor/` prefix and no built-in id does, so nothing OpenRouter publishes
  // today can collide. This is a structural floor under an id namespace we do
  // not control, not a fix for an observed failure.
  //
  // OpenRouter's OWN static ids are excluded — they collide by design (the
  // provider of course lists the models we hand-measured) and are already
  // handled as `superseded` above, which is not a failure.
  const builtInIds = new Set();
  for (const list of Object.values(OFFERABLE_MODELS)) {
    for (const e of list || []) if (e && typeof e.id === 'string') builtInIds.add(e.id);
  }
  for (const id of Object.keys(MODEL_PRICES_USD_PER_MTOK)) builtInIds.add(id);
  for (const id of staticIds) builtInIds.delete(id);

  const out = [];
  const seenIds = new Set();
  let refused = 0;
  let superseded = 0;
  for (const spec of Array.isArray(specs) ? specs : []) {
    const specId = spec && typeof spec.id === 'string' ? spec.id : null;
    if (specId !== null && staticIds.has(specId)) { superseded++; continue; }
    // ── UNIQUENESS, BEFORE ADMISSION ─────────────────────────────────────────
    // Nothing deduped: two specs sharing an id were BOTH admitted, so the
    // picker rendered the same model twice while `registerDynamicPrice` and the
    // free registry kept only the LAST — an offer and its price describing
    // different records. Refused BEFORE `defineOfferableModel` so the duplicate
    // never registers a price or a freeness at all.
    //
    // The FIRST occurrence wins because `findOfferableModel` uses `.find()`:
    // that entry is already the one routing and pricing resolve, so keeping it
    // makes the registries agree with what was always being used, rather than
    // changing which model a user gets.
    //
    // Counted as `refused` rather than as a new field: the route's contract for
    // that number is "passed eligibility, failed to become an offer", which a
    // duplicate and a collision both did. A separate counter would reach no
    // rendered surface — dead data — and the stderr line below carries the
    // reason for anyone reading a log.
    if (specId !== null && (seenIds.has(specId) || builtInIds.has(specId))) {
      refused++;
      console.error(
        seenIds.has(specId)
          ? `[llm] OpenRouter catalogue entry refused: duplicate id "${specId}" — the first occurrence is kept`
          : `[llm] OpenRouter catalogue entry refused: id "${specId}" collides with a built-in model id`,
      );
      continue;
    }
    try {
      // `{dynamic: true}` is what makes the overlay's chat-lane claim structural
      // rather than a comment — see defineOfferableModel.
      const entry = defineOfferableModel('openrouter', spec, { dynamic: true });
      // Second layer, and deliberately NOT independently mutation-provable: the
      // check above is the one that fails loudly with a named reason. This one
      // holds even if a future refactor changes HOW the factory decides a lane,
      // because it inspects the BUILT entry rather than the declared spec. The
      // property it guarantees is flat: nothing in `_openrouterCatalogue` can
      // ever make `isBuildLaneModel` true.
      if (entry.suitability !== 'chat-only') {
        throw new Error(`[llm] built entry "${entry.id}" is not chat-only — the runtime overlay may not reach the build lane`);
      }
      out.push(entry);
      seenIds.add(entry.id);
    } catch (err) {
      refused++;
      // stderr, never stdout — this module is imported by the MCP child
      // process, which reserves stdout for JSON-RPC frames (v2.5.2/v3.9.1).
      console.error(`[llm] OpenRouter catalogue entry refused: ${err && err.message}`);
    }
  }

  const admittedIds = new Set(out.map(e => e.id));
  for (const id of [..._dynamicPrices.keys()]) {
    if (!admittedIds.has(id)) _dynamicPrices.delete(id);
  }
  // The free registry needs the same prune for the same reason the price one
  // does: registration happens BEFORE the last few `need()` checks, so a REFUSED
  // entry can still have written itself in. A free id nobody can select is not
  // inert — `chargeForItem` keys on `tokenUsage.model`, which is the model that
  // actually RAN, so a lingering registration would zero a real charge.
  for (const id of [..._dynamicFree]) {
    if (!admittedIds.has(id)) _dynamicFree.delete(id);
  }

  _openrouterCatalogue = Object.freeze(out);
  // SAME LIFECYCLE ARGUMENT AS THE PRICE AND FREE REGISTRIES ABOVE. This is the
  // only writer of `_openrouterCatalogue`, so provenance is cleared here and
  // re-stated by whichever caller actually knows it (`syncOpenRouterCatalogue`
  // -> 'network', `restoreOpenRouterCatalogue` -> 'disk'). Left un-cleared, a
  // direct call — a test tearing down, or any future caller — would leave a
  // `syncedAt` describing a catalogue that is no longer loaded, i.e. a UI
  // reading "synced 2 minutes ago" over a list that had just been emptied.
  _openrouterCatalogueSyncedAt = null;
  _openrouterCatalogueSource = null;
  return { admitted: out.length, refused, superseded };
}

// ── PERSISTENCE: the synced catalogue survives a restart ─────────────────────
//
// WHY A SIDECAR FILE AND NOT `.curator-config.json`. Three reasons, and the
// first is the decisive one:
//   1. That file is the CREDENTIAL store — API keys, chmod 0600, rewritten
//      atomically on every Settings save and every onboarding step. Appending a
//      ~200 KB fetched catalogue to it puts hundreds of kilobytes of third-party
//      data in the blast radius of every key write. A truncated write there
//      costs the user their API keys.
//   2. It is 538 bytes today and is `sha256`-verified byte-for-byte across live
//      test runs precisely BECAUSE it should not move for reasons unrelated to
//      credentials.
//   3. The catalogue is public, non-secret, and fully re-derivable from one
//      unauthenticated GET. Losing it costs one button press; losing a key does
//      not.
// So: `<user-data>/.openrouter-catalogue.json`, resolved through `paths.js` like
// every other user-data path (v3.1.0's rule), never inside `domains/` (which is
// Personal Sync's git work-tree — the v3.3.0 rule that kept the ingest queue
// out of the user's public GitHub repo).
const OPENROUTER_CATALOGUE_FILENAME = '.openrouter-catalogue.json';

function openRouterCataloguePath() {
  // Resolved PER CALL, never snapshotted at module load — v3.1.0's source-guard
  // rule, because a snapshot makes every test override import-order dependent.
  return userDataPath(OPENROUTER_CATALOGUE_FILENAME);
}

/**
 * ── HOW OLD A CATALOGUE MAY BE BEFORE WE REFRESH IT ─────────────────────────
 *
 * 24 hours, and the number is bounded from BOTH sides rather than picked for
 * roundness:
 *
 *   • It must be much LONGER than an app restart cadence. The Curator is
 *     relaunched from the Dock several times a day, and the auto-sync below
 *     fires on module load; a threshold of minutes would turn every launch into
 *     a network fetch of ~400 records for no new information.
 *   • It must be much SHORTER than the interval over which the offer actually
 *     changes. OpenRouter adds and retires routes most weeks, so a threshold of
 *     weeks would leave a user picking from a list that no longer matches what
 *     their key can reach — which is the "sometimes they show, other times they
 *     do not" complaint in a slower form.
 *
 * A day sits roughly an order of magnitude clear of both. It is deliberately
 * NOT tuned to price freshness: prices are re-derived at admission on every
 * sync AND on every boot restore, and a stale price is a displayed FACT the
 * `syncedAt` stamp already dates — this constant governs MEMBERSHIP, which is
 * the thing a user notices missing.
 */
export const OPENROUTER_CATALOGUE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Should the OpenRouter catalogue be refreshed right now?
 *
 * PURE — takes the clock as an argument and reads only module state, so the
 * policy is decidable offline in every branch. The caller owns the side effects
 * (the key check, the write-registry check, the actual fetch); this owns only
 * the question "is what we hold good enough".
 *
 * `reason` is returned even when `needed` is false so a caller can log or
 * surface WHY without re-deriving it — the field is the answer, not a flag the
 * consumer has to reconstruct.
 *
 *   'absent'     nothing is loaded at all — the state in which chat offers the
 *                5 hand-measured routes and nothing says so.
 *   'undated'    entries are loaded but carry no `syncedAt`. Treated as STALE,
 *                not as fresh: an unknown age cannot be asserted to be young,
 *                and the fail-safe direction here is one extra free public GET.
 *   'stale'      older than OPENROUTER_CATALOGUE_MAX_AGE_MS.
 *   'fresh'      within the window; `needed` is false.
 */
export function openRouterCatalogueNeedsSync(nowMs = Date.now()) {
  if (_openrouterCatalogue.length === 0) {
    return { needed: true, reason: 'absent', ageMs: null };
  }
  const ageMs = openRouterCatalogueAgeMs(nowMs);
  if (ageMs === null) return { needed: true, reason: 'undated', ageMs: null };
  if (ageMs > OPENROUTER_CATALOGUE_MAX_AGE_MS) {
    return { needed: true, reason: 'stale', ageMs };
  }
  return { needed: false, reason: 'fresh', ageMs };
}

/**
 * Age of the loaded catalogue in ms, or null when it carries no usable stamp.
 *
 * A stamp we cannot parse, and a stamp in the FUTURE, both resolve to null
 * rather than to a number. A future stamp arises from a clock change or a
 * hand-edited sidecar and would otherwise compute a NEGATIVE age, which passes
 * every "younger than a day" test forever — a stale catalogue that can never be
 * refreshed. Unknown is the honest answer and, via 'undated' above, the one
 * that costs a free refresh instead of silence.
 */
function openRouterCatalogueAgeMs(nowMs = Date.now()) {
  if (typeof _openrouterCatalogueSyncedAt !== 'string' || !_openrouterCatalogueSyncedAt) return null;
  const t = Date.parse(_openrouterCatalogueSyncedAt);
  if (!Number.isFinite(t)) return null;
  const age = nowMs - t;
  return age < 0 ? null : age;
}

/**
 * Provenance of the OpenRouter half of the offerable list.
 *
 * `syncedAt` / `source` / `count` are unchanged. `ageMs` / `stale` / `reason`
 * are ADDITIVE and exist so a view can say the list is partial or stale WITHOUT
 * re-implementing the threshold client-side — a second copy of a freshness rule
 * is this repo's v3.2.0 drift shape, and the client half would be the one that
 * rots.
 *
 * `loaded` is stated explicitly rather than left as `count > 0` for the caller
 * to infer: "the catalogue is absent" and "the catalogue is present and holds
 * nothing" are different facts and only the first is reachable today, but a
 * consumer that infers absence from a zero will read the second as the first
 * the day it becomes possible.
 */
export function getOpenRouterCatalogueMeta(nowMs = Date.now()) {
  const verdict = openRouterCatalogueNeedsSync(nowMs);
  return {
    syncedAt: _openrouterCatalogueSyncedAt,
    source: _openrouterCatalogueSource,
    count: _openrouterCatalogue.length,
    loaded: _openrouterCatalogue.length > 0,
    ageMs: verdict.ageMs,
    stale: verdict.needed,
    reason: verdict.reason,
    maxAgeMs: OPENROUTER_CATALOGUE_MAX_AGE_MS,
  };
}

/**
 * ── WHO MEASURED THIS MODEL AGAINST THE REAL INGEST PROMPT ──────────────────
 *
 * Three states, one field, computed in ONE place:
 *
 *   'curator'  hand-measured by us against this repo's real `buildOutlinePrompt`
 *              on real prose, and typed into the static `OFFERABLE_MODELS`
 *              table. `defineOfferableModel` REFUSES to build a static entry
 *              without a non-empty `note` ("a model nobody has measured must
 *              not be offered at all"), so membership of that table IS the
 *              measurement claim — there is nothing to keep in step.
 *   'user'     this installation measured it, on its own pages, via "Test on my
 *              wiki", and the record still passes (`isLocallyQualified`
 *              re-checks liveness on every read).
 *   null       nobody has. A fetched catalogue entry with no local run: it
 *              exists and we can quote its price, and that is all we claim.
 *
 * WHY THIS IS NOT A FROZEN FIELD ON THE ENTRY. The third state depends on live
 * per-user state that a frozen table cannot know, so an entry-level field could
 * only ever carry two of the three — and a consumer joining the missing half
 * back on would be re-deriving a rule that already exists here. Worse, a field
 * whose value on the entry differs from its value on the wire is the "one field
 * name, two quantities" defect v3.17.1 records. One producer, one meaning.
 *
 * WHY MEMBERSHIP RATHER THAN A MARKER. "Was this admitted from a fetched
 * catalogue" is answered by IDENTITY against `_openrouterCatalogue` — the array
 * `listOfferableModels` splices in — so there is no second flag to set, and no
 * way for a marker and the list it describes to disagree.
 *
 * NOT A QUALITY SCORE, and deliberately says nothing about price. `null` means
 * UNMEASURED, never BAD: `z-ai/glm-5.3-flash` is hand-measured AND flagged
 * `caution`, while a fetched entry may well be excellent and simply unprobed.
 * The measured/unmeasured axis and the good/bad axis are different questions
 * and collapsing them is what this whole catalogue exists to avoid.
 *
 * Fails closed: an unknown provider or an id we do not offer returns null.
 */
export function measurementProvenance(provider, modelId) {
  const entry = findOfferableModel(provider, modelId);
  if (entry === null) return null;
  // Identity, not `id` equality: two entries can never share an id (the static
  // table is hand-ordered and the dynamic half is built from a Map), but
  // identity cannot be fooled by one anyway.
  if (!_openrouterCatalogue.includes(entry)) return 'curator';
  return isLocallyQualified(provider, modelId) ? 'user' : null;
}

/**
 * Persist the admitted catalogue. Best-effort by design: a disk failure must
 * never fail a sync that already succeeded over the network and is already live
 * in memory. The user's models work this session either way; the only cost of a
 * failed write is that they work again after a restart.
 */
function persistOpenRouterCatalogue(specs, syncedAt) {
  try {
    writeFileAtomicSync(
      openRouterCataloguePath(),
      JSON.stringify({ version: 1, syncedAt, specs }, null, 0),
      'utf8',
    );
    return true;
  } catch (err) {
    // stderr, never stdout — this module is imported by the MCP child process,
    // which reserves stdout for JSON-RPC frames (v2.5.3).
    // SCRUBBED: a failed write throws a raw `fs` error carrying the sidecar's
    // ABSOLUTE path, i.e. the user's home directory. This line is now reached
    // from the BOOT-TIME auto-sync as well as from the Settings button, so it
    // fires with nobody watching, into the log users paste into bug reports.
    console.error(`[llm] could not persist the OpenRouter catalogue: ${scrubPaths(String((err && err.message) || err))}`);
    return false;
  }
}

/**
 * ── Re-admit a persisted catalogue at boot ───────────────────────────────────
 *
 * A PERSISTED ENTRY GETS NO MORE TRUST THAN A FRESHLY FETCHED ONE. The stored
 * specs are fed back through `setOpenRouterCatalogue`, i.e. through
 * `defineOfferableModel({dynamic: true})` — the SAME admission function, with
 * the SAME chat-only constraint and the SAME price-posture requirements. Three
 * consequences, all deliberate:
 *   • A model that has since become inadmissible is DROPPED on reload rather
 *     than grandfathered in by having once been on disk.
 *   • A hand-edited file claiming `suitability: 'general'` cannot promote itself
 *     into the lane that WRITES the user's wiki — the file is not a trusted
 *     input just because it is local. Every entry is refused per-entry and
 *     counted, exactly as a network response would be.
 *   • The price and free registries are rebuilt from the reload, so they cannot
 *     drift from what is offered.
 *
 * Returns `{restored:false}` and touches NOTHING when the file is absent,
 * unreadable or malformed. Never throws: it is called at boot, and a corrupt
 * cache file must not be able to stop the app from starting.
 */
export function restoreOpenRouterCatalogue() {
  let raw;
  try {
    raw = readFileSync(openRouterCataloguePath(), 'utf8');
  } catch {
    return { restored: false, reason: 'no persisted catalogue' };
  }
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch {
    return { restored: false, reason: 'persisted catalogue is not valid JSON' };
  }
  if (!parsed || !Array.isArray(parsed.specs) || parsed.specs.length === 0) {
    return { restored: false, reason: 'persisted catalogue has no entries' };
  }
  const { admitted, refused } = setOpenRouterCatalogue(parsed.specs);
  _openrouterCatalogueSyncedAt = typeof parsed.syncedAt === 'string' ? parsed.syncedAt : null;
  _openrouterCatalogueSource = 'disk';
  return { restored: true, admitted, refused, syncedAt: _openrouterCatalogueSyncedAt };
}

/**
 * ── THE LIVE SYNC: the one thing that joins the fetcher to the picker ────────
 *
 * fetch -> eligibility filter -> record-to-spec mapper -> admission -> persist.
 *
 * A FAILED SYNC LEAVES THE PREVIOUS CATALOGUE INTACT. `setOpenRouterCatalogue`
 * is reached only after a fetch AND a build have both succeeded, so a network
 * error, a timeout, a cancel or an unreadable eligibility report all throw with
 * the user's existing models still selectable. The alternative — clearing on
 * failure — would let one transient 503 read to the user as "OpenRouter no
 * longer offers anything", on the screen where they choose what to spend money
 * through.
 *
 * AN EMPTY FETCH IS A FAILURE, NOT AN ANSWER, and this is the sharp edge.
 * `fetchOpenRouterCatalogue` returns `[]` — it does NOT throw — when the response
 * body is not the shape it expects (`Array.isArray(body?.data)` false). That is
 * the right call there: reporting what the provider said is its whole job. But
 * an empty array flowing on into admission would wipe a working catalogue to
 * nothing on an HTTP 200 with a changed body shape, and every layer would report
 * success. OpenRouter publishing genuinely zero models is not a state that
 * exists; a body we cannot read is. So zero records REFUSES, before anything is
 * replaced.
 *
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl]  injected for offline tests
 * @param {string}   [opts.baseUrl]
 * @param {AbortSignal} [opts.signal]
 * @param {number}   [opts.timeoutMs]
 * @param {object}   [opts.eligibility]  passed through to the eligibility filter
 * @returns {Promise<{syncedAt:string,total:number,eligible:number,admitted:number,refused:number,persisted:boolean,funnel:Array}>}
 */
export async function syncOpenRouterCatalogue(opts = {}) {
  const records = await fetchOpenRouterCatalogue({
    fetchImpl: opts.fetchImpl || null,
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    signal: opts.signal || null,
    ...(Number.isFinite(opts.timeoutMs) ? { timeoutMs: opts.timeoutMs } : {}),
  });

  if (!Array.isArray(records) || records.length === 0) {
    const e = new Error(
      'OpenRouter returned no models. Nothing was changed — your existing model list is untouched. ' +
      'This usually means a temporary problem at OpenRouter; try again in a moment.',
    );
    e.code = 'OPENROUTER_EMPTY_CATALOGUE';
    throw e;
  }

  // ── THE CLOCK IS INJECTED HERE, AT THE IMPURE BOUNDARY ────────────────────
  // `openrouter-eligibility.js` is deliberately pure: it may not call
  // `Date.now()`, so with no `opts.now` it cannot evaluate `expiration_date` and
  // ABSTAINS rather than rejecting. Measured on the live catalogue: 194 eligible
  // with no clock, 193 with one — and the single differing model expires three
  // days after this was written. Shipping a model that dies inside this
  // release's own lifetime is precisely what v3.15.0 rejected another model for.
  //
  // This function already touches the network, so it is the right place for the
  // wall clock; `opts.now` stays overridable so a suite can pin a date without
  // the module ever reading a clock itself.
  const eligibilityOpts = { ...(opts.eligibility || {}) };
  if (eligibilityOpts.now === undefined) eligibilityOpts.now = new Date();

  // Throws OPENROUTER_NO_ELIGIBILITY rather than admitting an unfiltered list.
  const built = buildOpenRouterCatalogue(records, { eligibility: eligibilityOpts });

  // ── A TYPO IN AN OPTION NAME MUST FAIL LOUDLY, NOT DEGRADE ────────────────
  // Options are passed by STRING NAME, and the module's author has already been
  // bitten twice by that: a misspelt `contextField` silently selected the
  // OPTIMISTIC field instead of erroring, and a malformed `expiration_date`
  // raised zero risk flags — indistinguishable from the field being absent. So
  // the one option this path depends on is verified to have LANDED, by reading
  // the module's own report rather than by trusting that we spelt it right.
  // Refusing is the fail-safe direction: an unevaluated expiry ships models
  // that are about to die, and "we could not check" must never be served as
  // "we checked".
  if (built.clockSupplied !== true) {
    const e = new Error(
      'The model catalogue could not be checked for expiring models, so nothing was changed. ' +
      'Your existing model list is untouched. This is a bug in The Curator, not a problem with OpenRouter — ' +
      'please report it.',
    );
    e.code = 'OPENROUTER_EXPIRY_UNEVALUATED';
    throw e;
  }

  const { admitted, refused: admissionRefused, superseded } = setOpenRouterCatalogue(built.specs);
  const syncedAt = new Date().toISOString();
  _openrouterCatalogueSyncedAt = syncedAt;
  _openrouterCatalogueSource = 'network';

  // Persist the SPECS, not the built entries: entries carry price GETTERS that
  // JSON.stringify would flatten into today's number, freezing a promotional
  // price past its expiry. Specs are plain data and are re-admitted through the
  // same factory on the way back in.
  const persisted = persistOpenRouterCatalogue(built.specs, syncedAt);

  return {
    syncedAt,
    total: built.total,
    eligible: built.eligible,
    admitted,
    // ONE NUMBER, ONE MEANING: of the models that PASSED eligibility, how many
    // failed to become an offer — whether at the mapper or at admission. It is
    // deliberately not "everything the funnel dropped": those losses are already
    // attributed, rule by rule, in `funnel`, and adding them here would double-
    // count them on screen.
    refused: built.mapperRefused + admissionRefused,
    // Models the provider lists that we have ALREADY hand-measured. Not a
    // refusal and not a loss — the better entry is already on offer.
    superseded,
    persisted,
    funnel: built.funnel,
  };
}

// ── THE THIRD LANE: LOCALLY-QUALIFIED MODELS ─────────────────────────────────
//
// There are now three answers to "may this model build the user's wiki", not
// two, and keeping them three is the whole design:
//
//   HAND-MEASURED  `suitability !== 'chat-only'` on a static-table entry. We
//                  measured it, across documents and against siblings, and a
//                  human wrote the verdict. Unchanged by this release.
//
//   CHAT-ONLY      Everything admitted at runtime from the provider catalogue,
//                  plus hand-measured entries we found unfit. Unchanged.
//
//   LOCALLY        A catalogue entry the USER measured against THEIR OWN wiki,
//   QUALIFIED      nine times, with no defect observed. New here.
//
// ── WHY A SEPARATE DISJUNCT AND NOT A WIDER `suitability` TEST ──────────────
// Widening `suitability !== 'chat-only'` — or letting a qualification rewrite
// `suitability` on the entry — would defeat the two layers that exist to stop a
// FETCHED entry reaching the build lane (`defineOfferableModel`'s `opts.dynamic`
// refusal, and `setOpenRouterCatalogue`'s post-build re-check). Those layers are
// the release-defining guarantee of v3.15.0 and they are untouched here: nothing
// in `_openrouterCatalogue` can still make `entry.suitability !== 'chat-only'`
// true. This adds a SECOND, independent reason, sourced from evidence the user
// paid for, and leaves the first exactly as strict as it was.
//
// It also keeps the two claims DISTINGUISHABLE ON SCREEN, which is the deeper
// reason. `suitability` is serialised onto the wire and rendered as a badge. If
// a user-probed model carried `'general'` it would badge IDENTICALLY to a
// hand-measured one, collapsing "we measured this across many documents and
// models" into "you ran nine of these last Tuesday". Those are different
// epistemic claims and the UI must never state them the same way.
//
// ── WHAT MAY BE LOCALLY QUALIFIED, AND WHAT MAY NOT ────────────────────────
// Only an OpenRouter entry that WE HAVE NEVER MEASURED (`jsonRaw === null`,
// llm.js's own documented marker for "not measured here"). A local run must not
// be able to override our own NEGATIVE finding: `gemini-3.5-flash-lite` is
// chat-only with `jsonRaw: false` because nine live runs against the real
// outline prompt produced JSON neither the parser nor the repair pass could fix
// in 2 of them. A user who happens to get nine clean runs on their own wiki has
// not refuted that; they have sampled the other 78%. So a measured-bad model
// stays chat-only whatever any local record says.
const OPENROUTER_QUALIFICATIONS_FILENAME = '.openrouter-qualifications.json';

/**
 * modelId -> record. Populated by `recordLocalQualification` (a completed run)
 * and by `restoreLocalQualifications` (boot). Empty by default, so the default
 * state of this module is "no model is locally qualified", which is what makes a
 * partially-wired feature harmless.
 */
let _localQualifications = new Map();

function localQualificationsPath() {
  // Resolved PER CALL, never snapshotted at module load — v3.1.0's source-guard
  // rule, because a snapshot makes every test override import-order dependent.
  return userDataPath(OPENROUTER_QUALIFICATIONS_FILENAME);
}

/**
 * Structural validation of a record read from disk or handed in.
 *
 * `isPassingRecord` (openrouter-qualify.js) owns whether the EVIDENCE is good
 * enough. This owns whether the OBJECT is a record at all, so a truncated write
 * or a hand-edited file degrades to "not qualified" rather than to a throw at
 * boot or a TypeError inside a predicate. Deliberately two functions: the
 * evidence rule is a measurement question and belongs with the measurer; the
 * shape rule is a persistence question and belongs here.
 */
function isRecordShaped(r) {
  return !!r && typeof r === 'object'
    && typeof r.modelId === 'string' && r.modelId.length > 0
    && typeof r.domain === 'string' && r.domain.length > 0
    && typeof r.measuredAt === 'string' && r.measuredAt.length > 0
    && !!r.counts && typeof r.counts === 'object';
}

function persistLocalQualifications() {
  try {
    const records = [..._localQualifications.values()];
    writeFileAtomicSync(
      localQualificationsPath(),
      JSON.stringify({ version: 1, records }, null, 0),
      'utf8',
    );
    return true;
  } catch (err) {
    // stderr, never stdout — this module is imported by the MCP child process,
    // which reserves stdout for JSON-RPC frames (v2.5.3).
    // Same shape, same reason as the catalogue sidecar above: a raw `fs` error
    // carries the absolute path of a file under the user's home directory.
    console.error(`[llm] could not persist local model qualifications: ${scrubPaths(String((err && err.message) || err))}`);
    return false;
  }
}

/**
 * Store the outcome of one completed qualification run.
 *
 * ONE RECORD PER MODEL — a re-run REPLACES its predecessor rather than
 * accumulating, because the newer measurement is the one that describes the
 * current routing. Keeping both and taking the best would let a user re-roll a
 * failing model until it passed, which is the opposite of a measurement.
 *
 * A DEFECT RECORD IS STORED TOO, and that is deliberate: `z-ai/glm-4.7` failing
 * 9 of 9 is the most valuable thing this feature can tell a user, and throwing
 * it away would invite them to pay for the same 6 minutes again next week.
 */
export function recordLocalQualification(record) {
  if (!isRecordShaped(record)) {
    return { stored: false, reason: 'not a qualification record' };
  }
  _localQualifications.set(record.modelId, record);
  const persisted = persistLocalQualifications();
  return { stored: true, persisted, modelId: record.modelId };
}

/**
 * Re-admit persisted qualifications at boot.
 *
 * Never throws: it is called at startup and a corrupt cache must not be able to
 * stop the app from starting. A malformed record is DROPPED, not repaired —
 * the file is local and hand-editable, and "we could not read it" must resolve
 * to "not qualified", which is the direction that costs the user a re-run rather
 * than a wiki built by a model nothing measured.
 */
export function restoreLocalQualifications() {
  let raw;
  try {
    raw = readFileSync(localQualificationsPath(), 'utf8');
  } catch {
    return { restored: false, reason: 'no persisted qualifications' };
  }
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch {
    return { restored: false, reason: 'persisted qualifications are not valid JSON' };
  }
  if (!parsed || !Array.isArray(parsed.records)) {
    return { restored: false, reason: 'persisted qualifications have no records' };
  }
  const next = new Map();
  let dropped = 0;
  for (const r of parsed.records) {
    if (isRecordShaped(r)) next.set(r.modelId, r); else dropped++;
  }
  _localQualifications = next;
  return { restored: true, count: next.size, dropped };
}

/** The record for one model, or null. Never throws. */
export function getLocalQualification(modelId) {
  if (typeof modelId !== 'string') return null;
  // `Object.hasOwn`-equivalent by construction: a Map cannot resolve
  // `__proto__` / `constructor` through a prototype, which is the v3.0.9
  // prototype-key shape this repo has hit before.
  return _localQualifications.get(modelId) || null;
}

/** Every stored record, newest measurement irrelevant — the UI sorts. */
export function listLocalQualifications() {
  return [..._localQualifications.values()];
}

/** Test seam and Disconnect path: forget everything measured. */
export function clearLocalQualifications() {
  _localQualifications = new Map();
  return persistLocalQualifications();
}

/**
 * ── HOW MANY RUNS A LOCAL QUALIFICATION NEEDS ───────────────────────────────
 *
 * Nine. One run cannot distinguish a model that emits clean JSON from one that
 * got lucky, and the defect class this exists to catch showed up in this
 * project's own Gemini catalogue at 2-in-9 — so a single probe passes such a
 * model about 78% of the time, laundering a coin-flip into a badge.
 *
 * FEWER RUNS ARE RECORDED BUT QUALIFY NOTHING: a short record is real evidence
 * of something and is shown with its run count; it simply does not satisfy
 * `isPassingRecord`.
 */
export const QUALIFY_MIN_RUNS = 9;

/**
 * Does this record's EVIDENCE justify the build lane?
 *
 * ── WHY THIS LIVES IN llm.js AND NOT BESIDE THE MEASURER ────────────────────
 * It is part of the definition of the lane, and the lane has exactly one home.
 * The mechanical reason is also decisive: `openrouter-qualify.js` imports
 * `ingest.js` (for the real `buildOutlinePrompt` and `usablePageArray`) and
 * `ingest.js` imports THIS file, so importing the predicate the other way would
 * close a module cycle — the same architecture constraint that already forces
 * `providerCanBuild` to live in `routes/config.js` rather than in
 * `brain/config.js`. `openrouter-qualify.js` re-exports this so callers have one
 * name for it, and there is exactly one definition.
 *
 * THE DECISION RULE: any unrepairable output, any parsed-but-unusable output,
 * any outright call failure, any abort, or fewer than `QUALIFY_MIN_RUNS`
 * completed runs — refused. The asymmetry is deliberate: a false rejection costs
 * a candidate; a false acceptance ships a model that silently writes broken
 * wikis and bills the user for it.
 *
 * `repaired` IS NOT A DEFECT and is deliberately absent from the checks below.
 * `claude-haiku-4-5`, the shipping Anthropic default, fences its outline JSON
 * 3 times out of 3 — a raw parse fails on 100% of its responses and every
 * Anthropic ingest already depends on the repair path. Rejecting on `repaired`
 * would reject the model this app ships.
 *
 * EVERY FAILURE DIRECTION IS CLOSED — a malformed record, a missing count, a
 * NaN, a count hand-edited to a string, a non-object — all false. That matters
 * because the record file is local and hand-editable: structural validity is the
 * part that CAN be checked, so it is checked.
 */
export function isPassingRecord(record) {
  if (!record || typeof record !== 'object') return false;
  if (record.outcome !== 'NO_DEFECT_FOUND') return false;
  if (!Number.isFinite(record.runsCompleted) || record.runsCompleted < QUALIFY_MIN_RUNS) return false;
  const c = record.counts;
  if (!c || typeof c !== 'object') return false;
  for (const k of ['unrepairable', 'unusable', 'failed']) {
    if (!Object.hasOwn(c, k)) return false;
    if (!Number.isFinite(c[k]) || c[k] !== 0) return false;
  }
  if (record.aborted) return false;
  if (record.cancelled) return false;
  if (typeof record.modelId !== 'string' || !record.modelId) return false;
  if (typeof record.domain !== 'string' || !record.domain) return false;
  if (typeof record.measuredAt !== 'string' || !record.measuredAt) return false;
  return true;
}

/**
 * ── THE THIRD LANE PREDICATE ────────────────────────────────────────────────
 *
 * Every clause is a REFUSAL, and each closes a different hole:
 *
 *  1. OpenRouter only. The other providers' catalogues are hand-typed and
 *     complete; there is no "never measured here" entry to qualify.
 *  2. The id must be OFFERABLE RIGHT NOW. This is the invalidation rule, and it
 *     is a LIVE CHECK rather than a prune: a model that has left the eligible
 *     catalogue stops granting the lane the instant it leaves, with no cleanup
 *     step that could be skipped. Deliberately NOT implemented by deleting the
 *     record — a qualification cost the user real money and up to an hour, and
 *     destroying that evidence because a catalogue fetch came back short would
 *     be unrecoverable. The record survives and is shown as void.
 *  3. The entry must still be `chat-only`. If a model is ever hand-measured into
 *     the build lane, that verdict governs and this predicate is not consulted.
 *  4. `jsonRaw === null` — WE have never measured it. A local run may fill a
 *     gap in our knowledge; it may not overturn a negative finding of ours.
 *  5. The record must be structurally sound AND show no defect over at least
 *     `QUALIFY_MIN_RUNS` runs (`isPassingRecord`).
 *
 * FAILS CLOSED at every step, so the cost of any doubt is that the user spends
 * less than they asked for — the same direction as `applyModelOverride`.
 */
export function isLocallyQualified(provider, modelId) {
  if (provider !== 'openrouter') return false;
  if (typeof modelId !== 'string' || !modelId) return false;
  const record = _localQualifications.get(modelId);
  if (!record) return false;
  const entry = findOfferableModel(provider, modelId);
  if (entry === null) return false;                       // no longer eligible
  if (entry.suitability !== 'chat-only') return false;    // hand-measured wins
  if (entry.jsonRaw !== null) return false;               // we measured it ourselves
  return isPassingRecord(record);
}

/**
 * The models a user may currently pick on a provider — the static table plus,
 * for OpenRouter, whatever the live catalogue admitted.
 *
 * This is the accessor every consumer should read (including the route that
 * serialises the picker), because OFFERABLE_MODELS alone is a partial view for
 * OpenRouter. Returns a frozen array, never null, so a caller can iterate
 * without a guard.
 */
export function listOfferableModels(provider) {
  if (!isKnownProvider(provider)) return Object.freeze([]);
  const stat = OFFERABLE_MODELS[provider] || Object.freeze([]);
  if (provider !== 'openrouter') return stat;
  if (_openrouterCatalogue.length === 0) return stat;
  // ── THE MERGE IS THE ONLY PLACE THE ORDER CAN BE ESTABLISHED ─────────────
  // This used to be a bare `[...stat, ...dynamic]`. Both halves are internally
  // cheapest-first — the static table is hand-ordered and asserted so; the
  // dynamic half arrives in OpenRouter's own arbitrary API order — but a
  // concatenation of two ordered lists is NOT ordered. After a sync, ~190
  // entries sat after the static three in provider order, so `renderModelPicker`'s
  // "cheapest-first, asserted upstream" became false and its `cheapest` badge,
  // computed as INDEX 0, was correct only by the accident that index 0 happened
  // to be a free entry. A `cheapest` badge on a model that is not cheapest is a
  // false statement on a SPENDING surface.
  //
  // SORTED HERE, NOT AT ADMISSION, and that is forced rather than preferred:
  // `setOpenRouterCatalogue` only ever sees the DYNAMIC half, so sorting there
  // cannot order the merged list — it would leave the same defect and add a
  // second sort to keep in step with this one, which is the v3.2.0
  // two-hand-maintained-copies shape. This function is the documented accessor
  // every consumer reads, so ordering here makes an unsorted list unobservable.
  return Object.freeze([...stat, ..._openrouterCatalogue].sort(compareOfferablePrice));
}

/**
 * Order two offerable entries cheapest-first for display.
 *
 * ── FREE IS A CLASS, NOT A NUMBER ────────────────────────────────────────────
 * A free entry's price is `null` BY DESIGN (membership, never `{0,0}` — a
 * truthy zero makes a budget cap inert). `null` in arithmetic coerces to 0, so
 * `a.input - b.input` on a free entry silently compares 0 and "works" — the
 * exact coercion §11 of test-chat-model.js found already sitting in a green
 * assertion, passing only because free genuinely happened to be cheapest.
 * Correct by accident is how these survive, so no `null` ever reaches a
 * subtraction here: freeness is decided by MEMBERSHIP first and the arithmetic
 * runs only between two entries that both carry numbers.
 *
 * FREE SORTS FIRST — the same answer §11 already pinned for the static table
 * ("a free model must not be listed after a paid one"), so the runtime merge and
 * the hand-typed table state one rule, not two.
 *
 * AN ENTRY THAT IS NEITHER FREE NOR PRICED SORTS LAST. `defineOfferableModel`
 * refuses to build one, so this is unreachable today; it is written down anyway
 * because the fail-safe direction on a spend surface is that an entry we cannot
 * price must never be badged the cheapest thing on offer.
 *
 * Compared on the price billed TODAY (`input`/`output` are getters that resolve
 * a live promotion), because that is the number rendered beside the badge.
 */
function compareOfferablePrice(a, b) {
  const rank = (e) => (e.free === true ? 0 : (typeof e.input === 'number' ? 1 : 2));
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra !== 1) return 0;                  // free-vs-free / unpriced-vs-unpriced: stable
  if (a.input !== b.input) return a.input - b.input;
  const ao = typeof a.output === 'number' ? a.output : 0;
  const bo = typeof b.output === 'number' ? b.output : 0;
  return ao - bo;
}

/**
 * Is this exact model id one the user is allowed to select on this provider?
 *
 * THE ALLOW-LIST LIVES HERE AND IS APPLIED IN getProviderInfo(), the single
 * producer of the model string both SDKs receive — NOT at a route. There are
 * seven other entry points into generateText (ingest, compile, chat, query,
 * health-ai, shared-brain, diagnostics), so validating at one route would leave
 * the rest open and create a second hand-maintained copy of the guard, which is
 * exactly what produced the v3.2.0 CRITICAL.
 *
 * The lookup is an array scan comparing with `===`, so `'__proto__'`,
 * `'constructor'` and `'toString'` are structurally unable to resolve to
 * anything — there is no object indexed by the caller's string at any point
 * (the v3.0.9 normalizeResponseStyle bug shape, closed by construction rather
 * than by remembering to call Object.hasOwn).
 */
function findOfferableModel(provider, modelId) {
  if (!isKnownProvider(provider)) return null;
  if (typeof modelId !== 'string' || modelId.length === 0) return null;
  return listOfferableModels(provider).find(entry => entry.id === modelId) || null;
}

export function isOfferableModel(provider, modelId) {
  return findOfferableModel(provider, modelId) !== null;
}

/**
 * ── THE BUILD LANE ───────────────────────────────────────────────────────────
 *
 * May this model serve ingest, Wiki Health and Compile — the features that
 * WRITE the wiki?
 *
 * THE BUG THIS CLOSES. `suitability: 'chat-only'` has existed since the
 * multi-model work and was read in exactly three places, all of them BADGE
 * RENDERING. Nothing enforced it. `POST /api/config/api-keys/model` gated on
 * `isOfferableModel` plus a saved key and nothing else — so a user could pin
 * `gemini-3.5-flash-lite` as their BUILD model and the app would let them,
 * while the picker sat there displaying "not recommended for ingest" beside the
 * choice it had just accepted. That model emits JSON that neither JSON.parse
 * nor jsonrepair can fix in 2 of 9 live runs against the real ingest outline
 * prompt. A label the code does not honour is worse than no label: it tells the
 * user a decision was checked when it was not.
 *
 * The verdict derives from `suitability` and nothing else, so there is exactly
 * one place a model's lane is decided. `defineOfferableModel` refuses to admit
 * a tiered-price model as anything but 'chat-only', which is how the pricing
 * hazard reaches this predicate without giving it a second meaning.
 *
 * FAILS CLOSED: an unknown provider, an unknown id, or an id we do not offer
 * all return false. The caller's response to false is to fall back to the
 * provider default (see applyModelOverride) — never to throw — so the cost of a
 * false negative is spending LESS than the user asked for.
 */
export function isBuildLaneModel(provider, modelId) {
  // Shares findOfferableModel with isOfferableModel deliberately: the allow-list
  // must have exactly ONE scan. A second `listOfferableModels(...).find(...)`
  // here would be a hand-maintained copy of the membership test — the v3.2.0
  // CRITICAL's shape, and there is a standing offline guard against it.
  const entry = findOfferableModel(provider, modelId);
  if (entry === null) return false;
  // CLAUSE 1 — the hand-measured lane, BYTE-UNCHANGED. This test is deliberately
  // NOT widened: `suitability !== 'chat-only'` still means exactly what it meant
  // before, and the two layers that stop a FETCHED entry ever satisfying it
  // (defineOfferableModel's `opts.dynamic` refusal and setOpenRouterCatalogue's
  // post-build re-check) are untouched and still independently provable.
  if (entry.suitability !== 'chat-only') return true;
  // CLAUSE 2 — the third lane, a SEPARATE reason sourced from evidence the user
  // paid for on their own wiki. Kept as its own disjunct precisely so that
  // widening one can never silently widen the other, and so the two claims stay
  // distinguishable on screen: a locally-qualified model still reports
  // `suitability: 'chat-only'` on the wire, and the UI badges it as measured by
  // the user rather than by us. See isLocallyQualified for what it refuses.
  return isLocallyQualified(provider, modelId);
}

/**
 * Compare what the user CONFIGURED against what they are actually being billed
 * for right now. Three states, because two would force us to lie:
 *
 *   'costlier' — confirmed higher on input and/or output. Warn plainly. This
 *                INCLUDES a free model falling back onto a priced one, which is
 *                the biggest jump available (see the free branch below).
 *   'similar'  — confirmed same-or-cheaper. Say nothing about cost. Reached by
 *                free -> free and by paid -> free; the word means
 *                same-or-cheaper, not equal.
 *   'unknown'  — at least one id has NO KNOWN PRICE POSTURE: not priced, and not
 *                free either. NEVER imply parity here: any fallback means the
 *                user is off the model they chose, so the honest line is
 *                "pricing may differ", not silence. A FREE model does not land
 *                here — free is a price we know exactly, and filing it under
 *                "no price" is what this function used to do.
 *
 * @returns {'costlier'|'similar'|'unknown'}
 */
export function compareModelCost(requestedModel, usingModel) {
  // ── FREE IS A KNOWN PRICE, NOT A MISSING ONE ──────────────────────────────
  // `getModelPrice()` returns null for a free model BY DESIGN (see FREE_MODELS:
  // a free model is recorded by MEMBERSHIP, never as `{input:0,output:0}`), so
  // the `!a || !b` test below read that null as "we have no idea" and answered
  // 'unknown'. MEASURED: `compareModelCost('minimax/minimax-m3:free',
  // 'claude-haiku-4-5')` returned **'unknown'**, which renders as "pricing for
  // this model is not known here" — on a fallback from a model that bills $0.00
  // to one that bills real money. That is the LARGEST cost transition the app
  // can make, both of its facts are known exactly, and the honest sentence is
  // "you were on a free model and are now being billed."
  //
  // Resolved before the price lookup, because membership is the authority over
  // any price a table might hold for a free id — the same ordering, for the same
  // reason, as `chargeForItem`'s free branch sitting ahead of its priced one.
  const aFree = isFreeModel(requestedModel);
  const bFree = isFreeModel(usingModel);
  if (aFree || bFree) {
    // free -> free: identical, and both figures are known. Nothing to warn about.
    // paid -> free: strictly cheaper, which 'similar' already means here
    //               ("confirmed same-or-cheaper", not "confirmed equal").
    // free -> paid: the transition above. Warn.
    if (bFree) return 'similar';
    return getModelPrice(usingModel) ? 'costlier' : 'unknown';
  }
  const a = getModelPrice(requestedModel);
  const b = getModelPrice(usingModel);
  if (!a || !b) return 'unknown';
  return (b.input > a.input || b.output > a.output) ? 'costlier' : 'similar';
}

/**
 * Boolean form of the 'costlier' verdict. Kept as a separate export because the
 * fallback payload carries `costlier` for backwards compatibility; new code
 * should prefer compareModelCost() so the 'unknown' state isn't collapsed into
 * a misleading `false`.
 */
export function isCostlierModel(requestedModel, usingModel) {
  return compareModelCost(requestedModel, usingModel) === 'costlier';
}

/**
 * Module-level snapshot of the most recent fallback event.
 * null when the primary model is working; populated when a fallback is in use.
 * Cleared automatically when a subsequent primary call succeeds.
 */
let _activeFallback = null;

/**
 * @returns {null | {provider: string, requestedModel: string, usingModel: string,
 *                   at: string, costTier: 'costlier'|'similar'|'unknown',
 *                   costlier: boolean}}
 *
 * `costlier` is DERIVED here (not stored on _activeFallback) so the flag always
 * reflects the current tier heuristic, and so the stored record keeps the exact
 * shape it has had since v2.4.0. It is additive: every pre-existing field is
 * returned unchanged, and `/api/config/api-keys` passes this object straight
 * through, so the frontend gets the flag with no route change.
 */
export function getFallbackStatus() {
  if (!_activeFallback) return null;
  const costTier = compareModelCost(_activeFallback.requestedModel, _activeFallback.usingModel);
  return {
    ..._activeFallback,
    costTier,
    // Legacy boolean kept so anything reading `costlier` keeps working. It
    // collapses 'similar' and 'unknown' into false, which is exactly why the
    // banner drives off costTier instead.
    costlier: costTier === 'costlier',
  };
}

/**
 * ── The user's PERSISTED model choice (Settings) ─────────────────────────────
 *
 * The stored id, or null. Two gates, both load-bearing, both applied on every
 * read because a config change must take effect without a restart.
 *
 * GATE 1 — the key must be SAVED IN CONFIG, read via getApiKeys() and NEVER
 * getEffectiveKey(). This is the v3.0.13 rule and it is not cosmetic here.
 * resolveProviderDefault selects a PROVIDER off getEffectiveKey (config OR
 * .env), so a provider whose key the user Disconnected in Settings can still
 * resolve from a lingering .env key. Honouring the model they picked *before*
 * Disconnecting would be exactly the v3.0.13 bug in a new place — a setting the
 * user believes they removed still steering their spend. The write side (the
 * /api-keys/model route) gates the same config-only way, so the contract is
 * closed at both ends: you can only store a selection for a provider whose key
 * is saved, and it is only honoured while that key remains saved.
 *
 * GATE 2 — the allow-list, applied by the caller via applyModelOverride (see
 * defaultModelFor). Not re-implemented here: isOfferableModel has exactly one
 * application point and two hand-maintained copies of a guard is what produced
 * the v3.2.0 CRITICAL.
 */
function storedSelection(provider) {
  if (!isKnownProvider(provider)) return null;
  const keys = getApiKeys();
  // Explicit branches rather than an object index: this used to be a BINARY
  // ternary (`provider === 'gemini' ? gemini : anthropic`) whose "else" arm
  // silently claimed the Anthropic key for any other provider — the v3.10.1
  // credential-crossing shape.
  let savedKey = null;
  switch (provider) {
    case 'gemini':     savedKey = keys.geminiApiKey; break;
    case 'anthropic':  savedKey = keys.anthropicApiKey; break;
    case 'openrouter': savedKey = keys.openrouterApiKey; break;
    default:           savedKey = null;
  }
  if (!savedKey) return null;
  return getSelectedModel(provider);
}

/**
 * The model a provider should DEFAULT to, with the user's stored Settings
 * choice applied.
 *
 * PRECEDENCE, and why. `envModel` is the LLM_MODEL value THIS call site would
 * have used, passed in rather than re-derived, so each site keeps its exact
 * pre-existing LLM_MODEL semantics (getDefaultModel gates LLM_MODEL on the
 * active provider; resolveProviderDefault's branches do not — a pre-existing
 * asymmetry this change deliberately does NOT "fix", because the whole safety
 * claim here is that nothing moves for a user with nothing stored).
 *
 *   per-call preferModel  >  LLM_MODEL  >  stored selection  >  DEFAULTS
 *
 * LLM_MODEL beats the stored selection because they occupy the SAME slot: both
 * reshape the provider default. LLM_MODEL is the unrestricted developer escape
 * hatch (it deliberately bypasses the allow-list); letting a Settings click
 * silently override it would remove the escape hatch and make it untestable.
 * The per-call picker still beats both, because applyModelOverride runs last in
 * getProviderInfo — that ordering is unchanged and already documented there.
 *
 * A stale or non-offerable stored id resolves to DEFAULTS[provider] — the
 * CHEAPEST model on that provider (OFFERABLE_MODELS is cheapest-first and its
 * head IS the default), so the worst case of any refusal is spending less than
 * the user asked for, never more.
 *
 * With NOTHING stored, storedSelection returns null and applyModelOverride
 * returns `defaultModel` on its first line — so this is byte-identical to the
 * pre-v3.12.x expression at every call site. That is the assertion protecting
 * every existing user, and the suite pins it explicitly.
 */
function defaultModelFor(provider, envModel) {
  if (envModel) return envModel;
  // `requireBuildLane: true` — this resolves the PROVIDER DEFAULT, which is what
  // ingest, Health and Compile run on. A stored 'chat-only' pin must not become
  // the build model just because it was allow-listed at the moment it was
  // saved; it falls back to the provider default instead. The per-call chat
  // picker (applied in getProviderInfo) passes no such flag and is unaffected.
  return applyModelOverride(provider, DEFAULTS[provider], storedSelection(provider), true);
}

/**
 * The default model id for a provider (respecting a global LLM_MODEL override
 * only for the currently-active provider, then the user's stored Settings
 * choice). Exported so the UI can display the CURRENT model per provider — when
 * we bump DEFAULTS to a newer model, the chat model selector's label updates
 * automatically with no frontend change.
 */
export function getDefaultModel(provider) {
  if (!isKnownProvider(provider)) return null;
  // LLM_MODEL is a single global dev override tied to the active provider; only
  // surface it for that provider so we never label Gemini with a Claude id.
  const envModel = (process.env.LLM_MODEL && getActiveProvider() === provider)
    ? process.env.LLM_MODEL
    : null;
  return defaultModelFor(provider, envModel);
}

/**
 * Apply a caller's per-call MODEL choice on top of the resolved provider default,
 * enforcing the OFFERABLE_MODELS allow-list.
 *
 * REFUSAL IS A FALL-BACK, NOT A THROW, and the direction is chosen deliberately.
 * A stored selection can outlive the model it names — a user picks Opus 4.8, we
 * later pull it after a bad live probe, and their saved preference now points at
 * an id we refuse. Throwing would hard-fail every chat and every ingest for that
 * user until they noticed a picker somewhere; falling back to the provider's
 * default keeps them working. It is also the safe direction on money: a refusal
 * resolves to the CHEAPEST model on that provider, so the worst case is spending
 * less than the user asked for, never more. This mirrors normalizeChatProvider
 * (invalid provider -> null -> global) and anthropicMaxOutputTokens (unknown id
 * -> conservative cap), both of which fail toward the safe outcome rather than
 * toward an error.
 *
 * Callers who need to KNOW a refusal happened can see it directly: getProviderInfo
 * returns the model it actually resolved, so `result.model !== requested` is the
 * signal. The return shape is deliberately unchanged (no new field) because
 * `{provider, model}` is destructured at ~15 call sites across src/ and mcp/.
 */
function applyModelOverride(provider, defaultModel, preferModel, requireBuildLane = false) {
  if (preferModel === null || preferModel === undefined) return defaultModel;
  // Bounded and newline-stripped: this string is caller-supplied and this repo
  // has a recorded log-forgery finding (v3.0.1-beta.20, connection labels).
  // stderr, never stdout — llm.js is imported by the MCP child process, which
  // reserves stdout for JSON-RPC frames (v2.5.2/v3.9.1).
  const shown = String(preferModel).replace(/[\r\n]+/g, ' ').slice(0, 80);
  if (isOfferableModel(provider, preferModel)) {
    // LANE CHECK, and it is deliberately SEPARATE from the allow-list rather
    // than folded into it: `isOfferableModel` answers "may the user pick this
    // at all", which for a chat-only model is still YES. Merging the two would
    // hide a measured-good chat model from the chat picker, which is the
    // over-correction the 'chat-only' verdict exists to avoid.
    if (!requireBuildLane || isBuildLaneModel(provider, preferModel)) return preferModel;
    console.error(
      `[llm] Refusing model "${shown}" as the ${provider} BUILD model — it is measured unfit for ` +
      `ingest/Health/Compile (suitability "chat-only"). Using "${defaultModel}" instead. ` +
      `It remains selectable for chat.`
    );
    return defaultModel;
  }
  console.error(
    `[llm] Refusing model "${shown}" for provider "${provider}" — not in OFFERABLE_MODELS. ` +
    `Using the provider default "${defaultModel}" instead.`
  );
  return defaultModel;
}

/**
 * @param {('gemini'|'anthropic'|null)} preferProvider - optional per-call
 *   provider override (e.g. the chat model selector). Used ONLY if that
 *   provider has a usable key; otherwise falls through to the global active
 *   provider.
 * @param {(string|null)} preferModel - optional per-call MODEL override (the
 *   multi-model picker). Honoured ONLY if it is in OFFERABLE_MODELS for the
 *   resolved provider; anything else falls back to that provider's default (see
 *   applyModelOverride). It is applied LAST, so an explicit user choice also
 *   outranks the LLM_MODEL dev override — a deliberate ordering: LLM_MODEL exists
 *   to reshape the DEFAULT, and a developer who set it would be surprised to find
 *   it silently overriding a selection made in the UI.
 */
export function getProviderInfo(preferProvider = null, preferModel = null) {
  const base = resolveProviderDefault(preferProvider);
  const model = applyModelOverride(base.provider, base.model, preferModel);
  // ── THE MODEL MUST EXIST ──────────────────────────────────────────────────
  // Every provider currently carries a pinned DEFAULT, so in the shipping
  // configuration this refusal does not fire. It is not therefore decorative:
  // `resolveProviderDefault` reads a STORED per-provider selection and the
  // `LLM_MODEL` env override before falling back to `DEFAULTS`, and a provider
  // added without a default — `local`, already scaffolded — resolves to nothing
  // at all.
  //
  // ⚠ This comment used to assert that OpenRouter "deliberately does not" carry
  // a default because "it has no measured build-lane model". Both halves are
  // false: `DEFAULTS.openrouter` is 'upstage/solar-pro4', which is admitted
  // `suitability: 'general'` — the build lane — on 9 measured runs. The claim
  // dated from before those measurements landed and would have sent the next
  // reader looking for a hole that had been filled.
  //
  // This is the single producer of the model string both SDKs and the adapter
  // receive, so it is the only correct place to refuse. Failing HERE means the
  // failure is loud, free and actionable; passing a null model through would
  // put `"model": null` on the wire and turn a configuration problem into an
  // opaque provider 400 several layers away.
  //
  // The wording deliberately avoids every substring the recovery classifiers
  // key on — no "output token limit" (isOutputTokenLimit), no "not found"
  // (isModelNotFound), no 429/503/"overloaded" (is429/is503) — so this cannot
  // be mistaken for a recoverable condition, retried four times with backoff,
  // or used to walk a fallback chain.
  if (typeof model !== 'string' || model.length === 0) {
    throw new Error(
      `No model is configured for ${providerDisplayName(base.provider)}. ` +
      `This provider has no default model for building your wiki — pick one in Settings, ` +
      `or switch the active provider.`
    );
  }
  return { provider: base.provider, model };
}

/**
 * Provider + its DEFAULT model, with no model override applied. Split out of
 * getProviderInfo verbatim so the allow-list has exactly one application point;
 * the body below is unchanged, including which branch throws.
 */
function resolveProviderDefault(preferProvider) {
  // Per-call override (v3.0.11: chat model selector). Never honours a stale
  // override whose key is missing — falls through to the global logic below.
  if (isKnownProvider(preferProvider) && getEffectiveKey(preferProvider)) {
    return { provider: preferProvider, model: getDefaultModel(preferProvider) };
  }
  // Honour the user's last-saved active provider (v2.4.2+). Falls back to
  // Gemini-first-if-both behaviour for legacy configs via getActiveProvider().
  const active = getActiveProvider();
  if (active === 'gemini' && getEffectiveKey('gemini')) {
    return { provider: 'gemini', model: defaultModelFor('gemini', process.env.LLM_MODEL) };
  }
  if (active === 'anthropic' && getEffectiveKey('anthropic')) {
    return { provider: 'anthropic', model: defaultModelFor('anthropic', process.env.LLM_MODEL) };
  }
  if (active === 'openrouter' && getEffectiveKey('openrouter')) {
    return { provider: 'openrouter', model: defaultModelFor('openrouter', process.env.LLM_MODEL) };
  }
  // Defensive fallback: active provider is stored but its key is missing.
  // Prefer whichever provider still has a usable key.
  //
  // ORDER IS UNCHANGED for the two original providers, deliberately: this arm
  // decides what an existing user gets when their active provider's key
  // disappears, and nothing about that should move because a third provider
  // exists. OpenRouter is tried LAST, after both — and reaching it produces a
  // named "no model configured" error from getProviderInfo rather than silent
  // spend, which is still strictly more actionable than "No LLM API key found"
  // for a user who does have a key.
  if (getEffectiveKey('gemini')) {
    return { provider: 'gemini', model: defaultModelFor('gemini', process.env.LLM_MODEL) };
  }
  if (getEffectiveKey('anthropic')) {
    return { provider: 'anthropic', model: defaultModelFor('anthropic', process.env.LLM_MODEL) };
  }
  if (getEffectiveKey('openrouter')) {
    return { provider: 'openrouter', model: defaultModelFor('openrouter', process.env.LLM_MODEL) };
  }
  throw new Error(
    'No LLM API key found. Add one in Settings, or set GEMINI_API_KEY / ANTHROPIC_API_KEY in .env.'
  );
}

/**
 * Extract the retry-after delay in milliseconds from a 429 error.
 * The Gemini API embeds this in the error message as e.g. "retry in 27.136s"
 * or in a structured RetryInfo field.
 */
function parseRetryDelay(err) {
  const msg = err?.message ?? '';

  // Structured: "retryDelay":"27s" or "retryDelay": "27.136533819s"
  const structuredMatch = msg.match(/"retryDelay"\s*:\s*"([\d.]+)s"/);
  if (structuredMatch) return Math.ceil(parseFloat(structuredMatch[1]) * 1000);

  // Plain text: "Please retry in 27.136533819s"
  const plainMatch = msg.match(/retry in ([\d.]+)s/i);
  if (plainMatch) return Math.ceil(parseFloat(plainMatch[1]) * 1000);

  // Default fallback: 60 seconds
  return 60_000;
}

function is429(err) {
  const msg = err?.message ?? '';
  return msg.includes('429') || msg.includes('Too Many Requests') || msg.includes('RESOURCE_EXHAUSTED');
}

function is503(err) {
  const msg = err?.message ?? '';
  return msg.includes('503') || msg.includes('Service Unavailable') || msg.includes('high demand') || msg.includes('overloaded');
}

/**
 * ── LOAD-TIME PROOF THAT THE ADAPTER'S CENSUS STILL DESCRIBES THESE ──────────
 *
 * `openrouter-adapter.js` neutralises upstream prose so a third party's error
 * text cannot make the two functions above (and `isModelNotFound` below) say
 * "retry" or "the model is gone" — either of which SPENDS THE USER'S MONEY.
 * It works from a declared census, and a census can go stale in two directions.
 * The adapter closes one at its own load (every listed token is really stripped).
 * This closes the other: every listed token really is a token these classifiers
 * trip on, so the list can never quietly describe a signal they stopped caring
 * about — which would leave the neutraliser defending a door that moved.
 *
 * Kept as a behavioural probe rather than a shared constant the classifiers
 * read, deliberately: the offline suite extracts these literals from this
 * file's SOURCE with `/\.includes\('([^']+)'\)/`, so rewriting the bodies to
 * loop over an array would silently blind a guard another file owns. The
 * literals stay inline; the agreement is proven by execution instead.
 *
 * NOT ENFORCED, and it is the honest residual: COMPLETENESS. Nothing can
 * enumerate the substrings a function matches, so a token added to `is429`,
 * `is503` or `isModelNotFound` and to neither the census nor a probe is
 * invisible to both halves of this guard. Closing that needs a source-reading
 * assertion, which belongs in the offline suite and not in a module the MCP
 * child process imports.
 */
{
  const missed = [];
  for (const token of RETRY_CLASSIFIER_TOKENS) {
    const probe = { message: `upstream said ${token} for this request` };
    if (!is429(probe) && !is503(probe)) missed.push(`retry token "${token}"`);
  }
  for (const clause of MODEL_NOT_FOUND_CLAUSES) {
    if (!isModelNotFound({ message: clause.join(' ') })) {
      missed.push(`not-found clause [${clause.join(' + ')}]`);
    }
  }
  if (missed.length > 0) {
    throw new Error(
      '[llm] openrouter-adapter.js declares a recovery signal that these classifiers no longer ' +
      'detect, so its neutraliser is defending a door that moved: ' + missed.join('; ') +
      '. Reconcile the census with is429/is503/isModelNotFound.',
    );
  }
}

/**
 * ── A FAILURE THAT CANNOT SUCCEED ON RETRY ───────────────────────────────────
 *
 * `is429`/`is503` classify by MESSAGE SUBSTRING, which is the only thing two
 * vendor SDKs give us in common. That is fine for a genuine outage and wrong for
 * a failure that is deterministic by construction — and OpenRouter produces one:
 * with `allow_fallbacks:false` + `require_parameters:true`, HTTP 503 means "no
 * upstream provider met the required parameters". A capability mismatch does not
 * resolve during a backoff.
 *
 * MEASURED BEFORE THIS EXISTED: the adapter wrote an accurate, specific message
 * naming the real cause; `is503` matched the "503" inside it; the ladder retried
 * four times over ~39 seconds and then REPLACED that message with the generic
 * "infrastructure is temporarily overloaded … affects ALL accounts equally".
 * The user was told the provider was down when the answer was "pick a different
 * model", and on a 40-call multi-phase ingest that is ~26 minutes of apparent
 * hang — the v3.0.17 "the app is hung" complaint, re-armed.
 *
 * A STRUCTURAL TAG, NOT A REWORDED MESSAGE. The producer states the fact as a
 * property; this reads the property. Nothing here parses text, so an upstream
 * cannot acquire or shed the tag by changing its own prose — which is the whole
 * failure mode substring classification has.
 *
 * FAIL-SAFE DIRECTION: absent tag ⇒ classified exactly as before, so every
 * existing provider path is byte-unchanged. A wrongly-tagged transient error
 * surfaces to the user immediately; an untagged deterministic one merely costs
 * the retries it costs today.
 */
function isDeterministicProviderError(err) {
  return !!err && err.curatorDeterministic === true;
}

/**
 * ── Cancellation (v3.3.x, batch-ingest queue) ────────────────────────────────
 *
 * `opts.signal` threads an AbortSignal from the caller (the ingest queue's
 * per-item AbortController) down to the provider SDKs, so a user's Cancel
 * stops at the NEXT LLM call boundary — seconds — instead of after the current
 * FILE finishes, which on a large multi-phase ingest is minutes of API spend
 * the user has already asked us to stop.
 *
 * Everything cancellation-related is tagged with `curatorAborted === true` so
 * callers can tell "the user stopped this" apart from every other failure.
 * That distinction is load-bearing in ingest.js: its three recovery ladders
 * (Phase 1 stricter retry, Phase 2 page-by-page, single-pass -> multi-phase)
 * all exist to DEGRADE rather than fail, and a cancel that got "recovered"
 * would keep spending and write stub pages — the exact opposite of a cancel.
 *
 * NOTE (honest scope): an AbortSignal is client-side. It stops us WAITING for
 * an in-flight response and, far more importantly, stops every SUBSEQUENT call
 * — which is where the money is on a 10-40 call multi-phase ingest. The single
 * in-flight request may still be billed by the provider.
 */
export const ABORT_MESSAGE = '⚠ Cancelled — the operation was stopped before the AI call finished.';

/**
 * The canonical cancellation error. The message deliberately contains none of
 * the substrings any other classifier keys on — not "output token limit"
 * (isOutputTokenLimit), not 429/503/"overloaded" (is429/is503 and the queue's
 * TRANSIENT_PATTERNS), not "not found"/"model" (isModelNotFound) — so a cancel
 * can never be mistaken for a recoverable condition and retried.
 */
export function makeAbortError() {
  const e = new Error(ABORT_MESSAGE);
  e.curatorAborted = true;
  e.name = 'AbortError';
  return e;
}

/**
 * True for our own tagged cancellation AND for a raw `AbortError` thrown by a
 * provider SDK / undici before we get a chance to translate it. Deliberately
 * wide in the SAFE direction: a false positive propagates a fatal error the
 * user sees, while a false negative would let a cancel fall into a recovery
 * ladder and silently produce stub pages.
 */
export function isAbortError(err) {
  if (!err) return false;
  if (err.curatorAborted === true) return true;
  return err.name === 'AbortError';
}

/** Duck-typed so a test double works without constructing a real AbortSignal. */
function normalizeSignal(signal) {
  return (signal && typeof signal.aborted === 'boolean'
    && typeof signal.addEventListener === 'function') ? signal : null;
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw makeAbortError();
}

/**
 * `signal` is optional and, when present, makes the wait itself cancellable.
 * That matters: the 429/503 ladder below waits up to ~40s across its retries,
 * and a cancel that had to sit out a 27-second backoff would look exactly like
 * the "Cancelling…" hang this whole change exists to remove.
 */
function sleep(ms, signal = null) {
  if (!signal) return new Promise(resolve => setTimeout(resolve, ms));
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(makeAbortError()); return; }
    let timer = null;
    const onAbort = () => { if (timer) clearTimeout(timer); reject(makeAbortError()); };
    timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Call the active LLM with a system prompt and user message.
 * Automatically retries on:
 *   - 429 rate-limit errors (respects the Retry-After delay from the API)
 *   - 503 service unavailable (exponential backoff: 3 s → 9 s → 27 s)
 *
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {number} maxTokens
 * @param {'text'|'json'} responseFormat  - 'json' enables native JSON mode (Gemini only)
 * @param {function|null} onWait          - optional callback(message) called before each retry wait
 * @param {object} opts                   - {provider, onUsage, cachePrefixChars} — all optional
 * @returns {Promise<string>}  the model's text. The RETURN TYPE IS A BARE STRING
 *   and must stay that way: ~18 call sites across src/ and mcp/ depend on it.
 *   Token usage is delivered out-of-band via opts.onUsage instead.
 */
export async function generateText(systemPrompt, userPrompt, maxTokens = 8192, responseFormat = 'text', onWait = null, opts = {}) {
  const MAX_RETRIES = 4; // up to 4 attempts (3 retries)
  // v3.0.11: optional per-call provider override (chat model selector). Ignored
  // unless it names a provider with a usable key (getProviderInfo enforces this).
  const providerOverride = (opts && isKnownProvider(opts.provider)) ? opts.provider : null;
  // Per-call MODEL override (multi-model picker). Only a non-empty string is
  // even a candidate; getProviderInfo then enforces the OFFERABLE_MODELS
  // allow-list and falls back to the provider default if it does not pass.
  const modelOverride = (opts && typeof opts.model === 'string' && opts.model.length > 0)
    ? opts.model : null;

  // v3.0.16: observability + cost controls, both additive and both optional.
  //   onUsage          — real token counts, once per completed provider call
  //                      (retries and fallback rungs included, so the callback
  //                      sees TOTAL spend, not just the successful attempt).
  //   cachePrefixChars — caller-declared stable-prefix length for Anthropic
  //                      prompt caching. The caller owns the "is this prefix
  //                      reused enough to beat the 1.25x write premium?"
  //                      decision; llm.js only enforces the size floor.
  const callOpts = {
    onUsage: typeof opts?.onUsage === 'function' ? opts.onUsage : null,
    cachePrefixChars: Number.isInteger(opts?.cachePrefixChars) ? opts.cachePrefixChars : 0,
    // v3.3.x: optional AbortSignal. null when absent, so every branch below
    // behaves exactly as it did before for callers that pass no signal.
    signal: normalizeSignal(opts?.signal),
    // Read by callLLM when it resolves the provider; ignored by callProvider,
    // which is handed the already-resolved model id as a positional argument.
    model: modelOverride,
  };
  const signal = callOpts.signal;

  // Resolve provider name once for consistent error messaging. If this fails
  // (e.g. no key configured), let the underlying call throw the original
  // "No LLM API key found" message — don't shadow it here.
  let providerName = 'AI provider';
  // The provider ID, not the display name, keys the remedy table: the display
  // name is prose ('Claude' for `anthropic`) and must never be a lookup key.
  // Stays null when resolution fails, which degrades the messages below to
  // generic advice rather than to some other vendor's links.
  let providerId = null;
  try {
    const info = getProviderInfo(providerOverride, modelOverride);
    providerName = providerDisplayName(info.provider);
    providerId = info.provider;
  } catch { /* surface real error from callLLM below */ }

  // Already cancelled before we even dispatch: never spend on a call the user
  // has already asked us to stop.
  throwIfAborted(signal);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await callLLM(systemPrompt, userPrompt, maxTokens, responseFormat, providerOverride, callOpts);
    } catch (err) {
      // ABORT WINS OVER EVERYTHING, and must be checked BEFORE is429/is503:
      // an aborted fetch can surface with a message we would otherwise
      // classify as retryable, and retrying is precisely what a cancel must
      // not do. Normalised to our tagged error so callers get one shape.
      if (isAbortError(err) || (signal && signal.aborted)) throw makeAbortError();
      // A DETERMINISTIC failure is neither retried NOR re-messaged. Both halves
      // matter: gating only `retryable` would still let the `is503(err)` branch
      // below overwrite an accurate, actionable message with a generic outage
      // claim. Hoisted into two locals so every downstream use — the gate, the
      // two message rewrites, the delay and the log line — reads ONE decision
      // instead of re-asking three classifiers that could drift apart.
      const deterministic = isDeterministicProviderError(err);
      const rateLimited = !deterministic && is429(err);
      const unavailable = !deterministic && is503(err);
      const retryable = rateLimited || unavailable;
      if (!retryable || attempt === MAX_RETRIES) {
        // Out of retries or non-retryable error — surface a clean message that
        // makes clear whether the issue is in The Curator or upstream at the
        // AI provider, and what the user should do next (v3.0.1-beta.4).
        if (rateLimited) {
          const delaySec = Math.ceil(parseRetryDelay(err) / 1000);
          // v3.2.x (batch-ingest queue): tag the error so a caller that only
          // sees the final thrown Error (not the raw provider error) can
          // still tell "retries exhausted, upstream limit" apart from any
          // other failure — e.g. the queue worker pauses the whole batch on
          // a rate limit instead of failing just the one item. Message text
          // is UNCHANGED (existing tests assert on it); this only adds
          // properties.
          const e = new Error(buildRateLimitMessage(providerName, providerId, delaySec));
          e.curatorTransient = 'rate_limit';
          e.curatorRetryAfterMs = parseRetryDelay(err);
          throw e;
        }
        if (unavailable) {
          const e = new Error(buildServiceUnavailableMessage(providerName, providerId));
          e.curatorTransient = 'service_unavailable';
          throw e;
        }
        throw err;
      }

      // Calculate delay: 429 respects API hint; 503 uses exponential backoff (3s, 9s, 27s)
      const delayMs = rateLimited
        ? parseRetryDelay(err)
        : Math.min(3000 * Math.pow(3, attempt - 1), 60_000);

      const delaySec = Math.ceil(delayMs / 1000);
      const reason = rateLimited ? 'Rate limit' : 'Service busy';
      console.warn(
        `[llm] ${reason} (attempt ${attempt}/${MAX_RETRIES}). Waiting ${delaySec}s...`
      );
      onWait?.(`${reason} — retrying in ${delaySec}s… (attempt ${attempt}/${MAX_RETRIES - 1})`);
      // Abortable: rejects immediately on cancel instead of serving out a
      // backoff of up to 60s.
      await sleep(delayMs, signal);
    }
  }
}

/**
 * Detect "model not found" errors across both provider SDKs.
 *
 * Anthropic throws `NotFoundError` with status 404 and a message containing
 * "not_found_error" / "model".
 * Gemini returns an error whose message includes "404", "not found",
 * "is not supported", or "model_not_found" depending on the API surface.
 *
 * Rate limits (429) and service-unavailable (503) are deliberately excluded —
 * those go through the existing retry path, not the fallback chain.
 */
function isModelNotFound(err) {
  if (!err) return false;
  if (err.status === 404) return true;
  const msg = (err.message || '').toLowerCase();
  if (msg.includes('404') && (msg.includes('not found') || msg.includes('is not supported'))) return true;
  if (msg.includes('model_not_found') || msg.includes('model not found')) return true;
  if (msg.includes('not_found_error') && msg.includes('model')) return true;
  if (msg.includes('model') && msg.includes('does not exist')) return true;
  return false;
}

/**
 * Minimum length, in CHARACTERS, of a stable prompt prefix before it is worth
 * marking with an Anthropic `cache_control` breakpoint.
 *
 * Anthropic's minimum cacheable prefix is model-dependent and NOT monotonic
 * across generations: it is 4096 tokens on claude-haiku-4-5 — the Curator's
 * Anthropic default — and 1024 on every CURRENT fallback rung (sonnet-5,
 * sonnet-4-6, sonnet-4-5), i.e. four times LOWER, not higher. (This comment
 * previously cited 2048 on the claude-3-5-haiku rungs; those were removed in
 * 2026-08 after a live probe found all four returned 404.) Note the floor
 * below is applied without reference to the active model, so a cacheable
 * Sonnet prefix between ~4k and 16k chars is skipped — benign while Sonnet is
 * only ever a fallback, worth revisiting if that changes. A prefix
 * below the model's minimum is silently NOT cached (no error, no write charge,
 * `cache_creation_input_tokens: 0`), so a too-short breakpoint is harmless but
 * pointless. 16,000 chars is ~4,000 tokens at the ~4 chars/token typical of
 * English prose, i.e. the floor at which the default model can cache at all.
 * Being wrong in either direction is cheap: too low → a no-op marker, too high
 * → we skip a cache we could have had.
 *
 * The COSTLY mistake is caching a prefix that is used exactly once — a cache
 * write is billed at 1.25x the base input rate (5-minute TTL), so a single-use
 * breakpoint makes the call 25% MORE expensive. That decision (is this prefix
 * reused?) belongs to the caller, which is why llm.js only enforces the size
 * floor and never sets a breakpoint on its own. Break-even is two calls:
 * 1.25x + 0.1x = 1.35x versus 2.0x uncached.
 */
export const ANTHROPIC_CACHE_MIN_PREFIX_CHARS = 16_000;

/**
 * Build the Anthropic user-message content for a prompt, optionally splitting it
 * into [stable prefix | volatile suffix] with a cache breakpoint on the prefix.
 *
 * Returns the plain string (i.e. today's exact payload) unless ALL hold:
 *   • cachePrefixChars is a positive integer strictly inside the prompt, and
 *   • the prefix is at least ANTHROPIC_CACHE_MIN_PREFIX_CHARS long.
 * Concatenating the two blocks reproduces the original prompt byte for byte.
 *
 * Exported for offline testing.
 */
export function buildAnthropicUserContent(userPrompt, cachePrefixChars) {
  const text = typeof userPrompt === 'string' ? userPrompt : '';
  const n = Number.isInteger(cachePrefixChars) ? cachePrefixChars : 0;
  if (n < ANTHROPIC_CACHE_MIN_PREFIX_CHARS) return text;
  if (n >= text.length) return text;             // nothing volatile left to vary
  return [
    { type: 'text', text: text.slice(0, n), cache_control: { type: 'ephemeral' } },
    { type: 'text', text: text.slice(n) },
  ];
}

/**
 * THE CURATOR'S USAGE CONVENTION (both providers, no exceptions):
 *
 *   inputTokens       tokens processed at FULL price — CACHED TOKENS EXCLUDED
 *   cachedReadTokens  tokens served from cache (~0.1x on Anthropic)
 *   cacheWriteTokens  tokens written to cache (1.25x on Anthropic)
 *
 *   total prompt size = inputTokens + cachedReadTokens + cacheWriteTokens
 *
 * The two providers disagree on the wire and a consumer must never have to know
 * that: Gemini's `promptTokenCount` INCLUDES `cachedContentTokenCount`, while
 * Anthropic's `input_tokens` EXCLUDES its cached counterpart. We normalise to
 * the EXCLUSIVE (Anthropic) convention, so `inputTokens` means one thing
 * everywhere and a cost calculation never has to branch on provider. Keeping
 * both wire conventions would have made `inputTokens + cachedReadTokens * 0.1`
 * double-count on Gemini — silently, in whatever meters this first.
 *
 * Normalise Gemini's `usageMetadata` into that shape. Every field is optional on
 * the wire (older responses, partial candidates), so anything missing degrades
 * to 0 rather than throwing.
 */
export function normalizeGeminiUsage(md) {
  const u = md && typeof md === 'object' ? md : {};
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const cached = num(u.cachedContentTokenCount);
  return {
    // Subtract the cached portion so this field carries the same meaning as
    // Anthropic's input_tokens. Clamped at 0 — a provider that ever reports
    // cached > prompt must not produce a negative that corrupts a running total.
    inputTokens:      Math.max(0, num(u.promptTokenCount) - cached),
    outputTokens:     num(u.candidatesTokenCount),
    cachedReadTokens: cached,
    // Gemini 2.5 implicit caching has no separate write charge, and the explicit
    // context-cache API (which does) is deliberately not used here.
    cacheWriteTokens: 0,
  };
}

/**
 * Normalise Anthropic's `usage` block into the same shape. Anthropic already
 * uses the exclusive convention documented on normalizeGeminiUsage —
 * `input_tokens` counts only what was billed at full price — so this is a
 * straight field rename.
 */
export function normalizeAnthropicUsage(usage) {
  const u = usage && typeof usage === 'object' ? usage : {};
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    inputTokens:      num(u.input_tokens),
    outputTokens:     num(u.output_tokens),
    cachedReadTokens: num(u.cache_read_input_tokens),
    cacheWriteTokens: num(u.cache_creation_input_tokens),
  };
}

/**
 * Normalise OpenRouter's OpenAI-shaped `usage` block into the same shape.
 *
 * ⚠ OPENROUTER FOLLOWS THE GEMINI CONVENTION, NOT ANTHROPIC'S: `prompt_tokens`
 * INCLUDES the cached portion. So this SUBTRACTS, exactly as
 * normalizeGeminiUsage does. Getting this wrong does not throw and does not
 * warn — it silently double-counts cached tokens in every cost calculation
 * downstream, because `chargeForItem` adds `inputTokens` and
 * `cachedReadTokens * 0.1` together.
 *
 * `cache_write_tokens` is reported separately but it is UNVERIFIED whether
 * `prompt_tokens` includes it. It is NOT subtracted, and that choice is
 * deliberate: if it is included, `chargeForItem` bills those tokens at
 * 1.0 + 1.25 = 2.25x instead of 1.25x, i.e. we OVER-report. This repo's
 * standing rule on money is that the fail-safe direction is to warn (v3.9.0:
 * an unrecognised cost tier resolves to 'unknown', never 'similar'), and a user
 * quoted more than they are billed picks a cheaper model than they needed,
 * while a user quoted less was lied to. Re-measure and revisit when a live call
 * with a cache write is available.
 *
 * `reasoning_tokens` is surfaced as an EXTRA field, not folded into anything.
 * By the OpenAI convention it is ALREADY INCLUDED in `completion_tokens`, so
 * adding it to `outputTokens` would bill hidden reasoning twice. It is reported
 * so a caller can show a user how much of a paid answer they never saw — the
 * same fact `thinks` records statically.
 */
export function normalizeOpenRouterUsage(usage) {
  const u = usage && typeof usage === 'object' ? usage : {};
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const obj = v => (v && typeof v === 'object' ? v : {});
  const pd = obj(u.prompt_tokens_details);
  const cd = obj(u.completion_tokens_details);
  const cached = num(pd.cached_tokens);
  return {
    // Clamped at 0 — a provider that ever reports cached > prompt must not
    // produce a negative that corrupts a running total.
    inputTokens:      Math.max(0, num(u.prompt_tokens) - cached),
    outputTokens:     num(u.completion_tokens),
    cachedReadTokens: cached,
    cacheWriteTokens: num(pd.cache_write_tokens),
    reasoningTokens:  num(cd.reasoning_tokens),
  };
}

/**
 * Invoke an optional usage callback. Contract (mirrors the v3.0.4 adapter
 * `onWarn` rule): a throwing callback must NEVER break the LLM call — usage
 * reporting is observability, not correctness. Diagnostics go to stderr because
 * this module is imported by the MCP child process, which reserves stdout for
 * JSON-RPC frames (v2.5.2).
 */
function reportUsage(onUsage, payload) {
  if (typeof onUsage !== 'function') return;
  try { onUsage(payload); }
  catch (err) { console.error(`[llm] onUsage callback threw (ignored): ${err && err.message}`); }
}

/**
 * Handle an output-token-limit (MAX_TOKENS) truncation, uniformly across
 * providers and response formats. Exported for offline unit testing.
 *
 * The behaviour DIFFERS by responseFormat, which is the whole point:
 *
 *   • JSON mode — a truncated JSON body is unparseable garbage, so we THROW.
 *     The message deliberately keeps the phrase "output token limit" so that
 *     `isOutputTokenLimit(err)` in ingest.js (and its consumers compile.js /
 *     the single-pass→multi-phase switch) keeps firing and the fallback
 *     ladders recover. The wording is CONTEXT-NEUTRAL — it no longer tells the
 *     caller to "split the source by chapter and ingest each separately" or to
 *     tune "the Phase 2 batch size in src/brain/ingest.js", because this single
 *     chokepoint is shared by chat, query, health-AI, shared-brain, compile and
 *     ingest. Callers that want feature-specific guidance (ingest, compile) add
 *     it at their own level.
 *
 *   • Text mode — a truncated PROSE answer is still useful (a 95%-complete chat
 *     answer beats a hard error). We RETURN the partial text with a clear,
 *     human-readable note appended, instead of discarding it. This is why the
 *     Chat tab used to surface the misleading ingest error on a long question
 *     (see the v3.0.7 fix): chat is text mode, and text mode should degrade,
 *     not fail.
 *
 * @param {string} providerName  'Gemini' | 'Claude'
 * @param {number} maxTokens     the budget that was hit (post-clamp for Anthropic)
 * @param {'text'|'json'} responseFormat
 * @param {string} partialText   whatever text was generated before truncation
 * @returns {string}             text-mode partial answer + note (json mode throws)
 */
export function handleOutputTokenLimit(providerName, maxTokens, responseFormat, partialText) {
  if (responseFormat === 'json') {
    throw new Error(
      `⚠ ${providerName} hit the output token limit (${maxTokens} tokens) on this call. ` +
      `The structured response was cut off before it could be completed and cannot be parsed. ` +
      `This is not a transient error — retrying identically will hit the same limit.`
    );
  }
  const text = typeof partialText === 'string' ? partialText : '';
  const note =
    `\n\n_[⚠ This answer was cut off because it reached the response length limit ` +
    `(${maxTokens} tokens). Ask a more specific or narrower question to see the rest.]_`;
  return text.trimEnd() + note;
}

/**
 * Extract the assistant's answer text from an Anthropic `Message.content` array.
 *
 * THE BUG THIS EXISTS TO CLOSE (v3.9.1). Both call sites used to read
 * `content[0].text`. That is only correct while the FIRST block is the text
 * block — and on `claude-sonnet-5` it routinely is not:
 *
 *   • The Curator never sends a `thinking` parameter. On Sonnet 5 (and the
 *     Opus 4.7+/Fable family) omitting it runs ADAPTIVE thinking, so the model
 *     decides per-prompt whether to think. On `claude-sonnet-4-6` and
 *     `claude-haiku-4-5` omitting it means no thinking at all. That asymmetry
 *     is the whole defect: measured over 3 trials with an ingest-shaped JSON
 *     prompt, sonnet-5 returned [thinking, text] 3/3 while 4-6 and haiku-4-5
 *     returned [text] 3/3.
 *   • A `thinking` block carries `.thinking`, never `.text`, so `content[0].text`
 *     was `undefined` and EVERY call threw the "returned no text content" error.
 *   • `claude-sonnet-5` is FALLBACK_CHAINS.anthropic[0]. The chain exists to keep
 *     users working the day the default is retired; rung 1 was dead on arrival.
 *   • It went uncaught because adaptive thinking is PROMPT-DEPENDENT: a trivial
 *     `Return {"ok":true}` smoke probe returns [text] and passes green while a
 *     real ingest prompt fails. Do not "verify" this path with a toy prompt.
 *
 * WHY IT CONCATENATES rather than taking the first text block. One response can
 * legitimately carry SEVERAL text blocks — citations split a reply into multiple
 * text blocks, and a server-side refusal fallback interleaves a `fallback` block
 * between them. Taking only the first would silently truncate: unparseable JSON
 * in json mode, and a partial prose answer presented as complete in text mode —
 * i.e. paid-for content dropped with a green result, this project's recorded
 * silent-data-loss shape. Blocks are contiguous pieces of one string, so they
 * join with '' (a separator would corrupt JSON). With a single text block this
 * is byte-identical to picking that block, so the common path is unchanged.
 *
 * Matching is on `type === 'text'`, the documented discriminant of the content
 * union — NOT on "has a .text string". A future block type that happens to carry
 * a `.text` field would otherwise be spliced into the answer.
 *
 * @param {unknown} content  `message.content`
 * @returns {string|null}  concatenated text, or null when there is NO text-typed
 *   block at all. null is the caller's signal to throw: a tool-use-only or empty
 *   response is a real failure and must never degrade to a silent empty string.
 *   A present-but-empty text block returns '' — matching the pre-fix behaviour
 *   for that shape, which is a genuine (if odd) model output, not an absence.
 */
export function extractAnthropicText(content) {
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.length === 0 ? null : parts.join('');
}

/**
 * TEST-ONLY seam. Replaces the Anthropic client constructor so an OFFLINE suite
 * can drive the real generateText → callLLM → callProvider path (retry loop and
 * fallback chain included) against synthetic `finalMessage()` shapes, with no
 * network and no spend. Null in production, where `new Anthropic(...)` is used
 * exactly as before — same pattern and rationale as config.js's
 * `__setDomainsDirOverride` and compile.js's `opts.generateText`.
 *
 * Resolved PER CALL, never snapshotted at module load: a top-level
 * `const client = ...` would make the override silently import-order dependent
 * (the v3.1.0 finding).
 */
let _anthropicClientFactoryOverride = null;
export function __setAnthropicClientFactory(factory) {
  _anthropicClientFactoryOverride = typeof factory === 'function' ? factory : null;
}

/**
 * ── ONE RULE FOR EVERY FATAL PROVIDER MESSAGE ────────────────────────────────
 *
 * Several throws in this file interpolate a value into their message, and both
 * `generateText`'s retry gate and `callLLM`'s fallback walk are MESSAGE-
 * SUBSTRING classifiers. So an interpolated value carrying classifier
 * vocabulary silently converts a FATAL error into four automatic retries with
 * ~40s of backoff, or a walk down the provider's fallback chain — real spend,
 * on a request already known to be dead.
 *
 * Measured on this file before these guards existed:
 * `callProvider('model not found', …)` threw a message `isModelNotFound()`
 * returns TRUE for, `'503 Service Unavailable'` satisfied is503, and
 * `'429 Too Many Requests'` satisfied is429. Each throw's own comment claimed
 * the wording "avoids every substring the recovery classifiers key on" — true
 * of the fixed literal, false of the interpolation beneath it. A comment
 * asserting a safety property its own code lacks is this repo's most-recurring
 * early-warning shape (v3.7.0 found four such docblocks; v3.13.1 four more
 * within a day of being written), so the CODE is made true rather than the
 * comment weakened to describe the gap.
 *
 * DELIBERATELY NOT A BLACKLIST of today's classifier vocabulary. A substring
 * stripper is precisely what rots: the day is429/is503/isModelNotFound gains a
 * token, a hand-maintained list silently stops covering it and the claim is
 * quietly false again, with nothing failing. This asks the REAL classifiers
 * instead, so the guard tracks them automatically and cannot drift from them.
 * It asks about the FINISHED message rather than the interpolated fragment,
 * because isModelNotFound ANDs two independent `includes` over the whole string
 * ('404' + 'not found') — a fragment can be clean while the concatenation is
 * not.
 *
 * openrouter-adapter.js's neutralizeRetrySignals was considered and rejected on
 * two counts. It is reachable only through that module's `__testing` surface,
 * and a test-only export has no business on a production dispatch path; and it
 * strips only 429/503/"too many requests"/"service unavailable"/"overloaded"/
 * "high demand" — not "not found", "model_not_found", "does not exist",
 * "is not supported", RESOURCE_EXHAUSTED or "output token limit", i.e. not the
 * first case measured above. Its own docblock scopes it to the echoed detail of
 * a non-transient OpenRouter status, which is a different job from this one.
 *
 * isOutputTokenLimit lives in ingest.js and importing it here would be a cycle
 * (ingest.js imports this module). Testing the phrase locally is not a second
 * copy of someone else's guard: llm.js is the PRODUCER of that literal —
 * handleOutputTokenLimit emits it deliberately so ingest's three recovery
 * ladders and compile's fire — so this is the producer refusing to emit its own
 * sentinel by accident.
 */
function readsAsRecoverable(message) {
  return is429({ message }) || is503({ message }) || isModelNotFound({ message }) ||
    /output token limit/i.test(message);
}

/**
 * Last resort if EVERY rendering offered below is claimed by a classifier —
 * which can only mean a FIXED literal in one of them has acquired classifier
 * vocabulary. That is a source defect, not a runtime condition, so this says
 * the minimum that cannot carry any.
 */
const INERT_FATAL_MESSAGE =
  'The Curator hit a provider error it cannot recover from. This is a defect in The Curator. Please report it.';

/**
 * Return the first rendering no classifier claims.
 *
 * `renderings` is ordered MOST INFORMATIVE FIRST, and the last should
 * interpolate nothing so the ladder normally terminates there. Every rung is
 * checked rather than assumed safe, because "a fixed literal is obviously fine"
 * is exactly the assumption that made the original comments false the moment an
 * interpolation was added beneath them.
 *
 * WITHHOLDING IS BINARY on purpose. A partially-redacted value ("model ###
 * found") reads worse in the bug report these messages ask for than an honest
 * statement that it was withheld, because a mangled value invites the reader to
 * debug the mangling instead of the defect.
 */
function firstInertMessage(renderings) {
  for (const m of renderings) if (!readsAsRecoverable(m)) return m;
  return INERT_FATAL_MESSAGE;
}

/**
 * The fatal "cannot dispatch" message for callProvider's totality throw. The
 * provider id is echoed while it is inert — it is the one thing a bug report
 * needs — and withheld when the finished message would read as recoverable.
 * See readsAsRecoverable above for the rule and the measurement behind it.
 *
 * This is the LEAST exposed of the three sites using that rule: `provider` here
 * can only be what getProviderInfo() resolved, i.e. a member of KNOWN_PROVIDERS.
 * It is guarded anyway because the claim in the throw's own comment should be
 * true as written, rather than true only for the inputs we happen to produce.
 */
function undispatchableProviderMessage(provider) {
  const build = (shown) =>
    `⚠ The Curator cannot dispatch to the AI provider ${shown}. ` +
    `This is a defect in The Curator, not a problem with your API key. Please report it.`;

  const raw = String(provider).replace(/[\r\n]+/g, ' ').slice(0, 40);
  return firstInertMessage([
    build(`"${raw}"`),
    build('(withheld: its name reads as a provider fault)'),
  ]);
}

/**
 * Invoke a specific provider+model. No retry/fallback here — pure dispatch.
 * Called by `callLLM` which handles fallback, and by the retry loop in `generateText`.
 *
 * @param {{onUsage?: function, cachePrefixChars?: number}} [opts]
 *   onUsage          — invoked once per COMPLETED provider call with normalised
 *                      token counts (see reportUsage). Fired before the
 *                      truncation check, because a truncated response is a call
 *                      that ran and was billed.
 *   cachePrefixChars — Anthropic only. Length of the stable leading portion of
 *                      userPrompt; a `cache_control` breakpoint is placed there
 *                      when it clears ANTHROPIC_CACHE_MIN_PREFIX_CHARS. Gemini
 *                      ignores it (2.5-family models do implicit prefix caching
 *                      with no API change).
 */
async function callProvider(provider, model, systemPrompt, userPrompt, maxTokens, responseFormat, opts = {}) {
  // v3.3.x: null unless the caller threaded one through generateText.
  const signal = opts.signal || null;
  // Cheapest possible cancellation point — before the client is even built.
  throwIfAborted(signal);

  // ── Google Gemini ────────────────────────────────────────────────────────
  if (provider === 'gemini') {
    const genAI = new GoogleGenerativeAI(getEffectiveKey('gemini'));
    const geminiModel = genAI.getGenerativeModel({
      model,
      systemInstruction: systemPrompt,
    });
    const generationConfig = { maxOutputTokens: maxTokens };
    if (responseFormat === 'json') {
      // Forces Gemini to output structurally valid JSON, preventing
      // unescaped markdown characters (backticks, quotes) from breaking parsing.
      generationConfig.responseMimeType = 'application/json';
    }
    // The two-branch call (rather than passing `{signal: undefined}`) keeps the
    // no-signal path byte-identical to the pre-cancellation code: the SDK sees
    // exactly the same one-argument invocation it always did.
    const geminiRequest = {
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig,
    };
    const result = signal
      ? await geminiModel.generateContent(geminiRequest, { signal })
      : await geminiModel.generateContent(geminiRequest);
    // v3.0.1-beta.8: detect output-budget truncation. Gemini returns
    // `finishReason: "MAX_TOKENS"` on the first candidate when its response
    // exceeded `maxOutputTokens`. Pre-fix this surfaced as the
    // "AI returned malformed JSON twice in a row" message at parseJSON time —
    // misleadingly framed as "transient" when in fact the next attempt would
    // hit the same wall.
    //
    // v3.0.7: routed through handleOutputTokenLimit — JSON mode still throws
    // (so ingest/compile fallbacks recover), but TEXT mode (chat, query) now
    // returns the partial answer with a note instead of hard-failing on a
    // misleading ingest-specific error.
    reportUsage(opts.onUsage, {
      provider: 'gemini', model,
      ...normalizeGeminiUsage(result?.response?.usageMetadata),
    });
    const finishReason = result?.response?.candidates?.[0]?.finishReason;
    if (finishReason === 'MAX_TOKENS') {
      let partial = '';
      try { partial = result.response.text(); } catch { /* candidate had no text part */ }
      return handleOutputTokenLimit('Gemini', maxTokens, responseFormat, partial);
    }
    return result.response.text();
  }

  // ── OpenRouter (OpenAI-compatible) ───────────────────────────────────────
  if (provider === 'openrouter') {
    return await callOpenRouter(model, systemPrompt, userPrompt, maxTokens, responseFormat, opts, signal);
  }

  // ── Anthropic Claude ─────────────────────────────────────────────────────
  if (provider === 'anthropic') {
    return await callAnthropic(model, systemPrompt, userPrompt, maxTokens, responseFormat, opts, signal);
  }

  // ── Unknown provider — THE `else` THAT IS THE POINT OF THIS STRUCTURE ─────
  // Until v3.15.0 the Anthropic call was UNCONDITIONAL: `if (provider ===
  // 'gemini') {…}` and then straight into
  // `new Anthropic({apiKey: getEffectiveKey('anthropic')})` with no test on
  // `provider` at all. It was unreachable only because resolveProviderDefault
  // could not return a third value.
  //
  // The moment a third provider existed, an OpenRouter request would have gone
  // to api.anthropic.com on the user's ANTHROPIC key, 404'd on an unrecognised
  // model id, been classified retryable by isModelNotFound, and WALKED THE
  // ANTHROPIC FALLBACK CHAIN — spending real Anthropic money on Sonnet while
  // the user believed they were on a free OpenRouter model. Silent, mis-billed,
  // and reported as success.
  //
  // Dispatch is now explicit and TOTAL: every arm names its provider and there
  // is no fall-through body. Adding a fourth provider to KNOWN_PROVIDERS
  // without a branch here lands on this throw — loudly, before any spend —
  // instead of being absorbed by whichever branch happened to be last.
  //
  // The message avoids every substring the recovery classifiers key on (no
  // "not found", no 429/503/"overloaded", no "output token limit") so it can
  // never be retried, nor used to walk a fallback chain.
  //
  // That claim used to cover only the FIXED literal, while the interpolated
  // provider id sailed straight past it — see undispatchableProviderMessage,
  // which now asks the real classifiers about the finished string and withholds
  // the id rather than let this throw be mistaken for a recoverable condition.
  throw new Error(undispatchableProviderMessage(provider));
}

/**
 * OpenRouter dispatch. Split out so `callProvider` reads as pure, total
 * dispatch — see the throw above for why that totality is load-bearing.
 *
 * Everything wire-shaped lives in openrouter-adapter.js; this function owns only
 * the three things that are llm.js's business: usage normalisation, the
 * truncation ladder, and refusing an empty answer.
 */
async function callOpenRouter(model, systemPrompt, userPrompt, maxTokens, responseFormat, opts, signal) {
  const apiKey = getEffectiveKey('openrouter');
  if (!apiKey) {
    throw new Error(
      '⚠ No OpenRouter API key found. Add one in Settings (it looks like "sk-or-v1-…").'
    );
  }
  const adapter = _openrouterAdapterFactory
    ? _openrouterAdapterFactory({ apiKey })
    : new OpenRouterAdapter({ apiKey });

  const res = await adapter.createChatCompletion({
    model, systemPrompt, userPrompt, maxTokens, responseFormat, signal,
  });

  // Fired BEFORE the truncation check, matching both other providers: a
  // truncated response is a call that ran and was billed.
  //
  // `model:` carries the RESOLVED model from the response body, falling back to
  // the requested id only when the provider did not say. That is the v3.13.2
  // rule — report the outcome, never the request — and it matters more here
  // than anywhere else, because OpenRouter is a router: the id that answers is
  // the id that is billed, and it is what a cost line must name.
  reportUsage(opts.onUsage, {
    provider: 'openrouter',
    model: res.model || model,
    ...normalizeOpenRouterUsage(res.usage),
  });

  // OpenAI-compatible `finish_reason: "length"` is the output-budget
  // truncation. Routed through the same shared handler as the other two
  // providers so JSON mode still throws with the literal phrase "output token
  // limit" that isOutputTokenLimit() matches on — which is what makes ingest's
  // three recovery ladders and compile's full→concise→summary-only ladder fire.
  if (res.finishReason === 'length') {
    return handleOutputTokenLimit('OpenRouter', maxTokens, responseFormat, res.text);
  }

  // Defensive, and NOT the same condition as an empty string: a completion that
  // finished normally with no content at all is a real failure and must never
  // degrade into a silent empty answer written to a wiki page.
  if (typeof res.text !== 'string' || res.text.length === 0) {
    // `finishReason` is PROVIDER-CONTROLLED text arriving off the wire, which
    // makes it strictly MORE exposed than the dispatch throw's provider id: that
    // one can only be a value our own config resolved, whereas this is whatever
    // an aggregator echoes back, from an upstream set that rotates. Echoed while
    // it is inert — it is the single most useful field for diagnosing an empty
    // completion — and withheld when the finished message would read as
    // recoverable. That distinction matters here precisely BECAUSE this message
    // says "usually transient — try again": that is an instruction to the USER,
    // and a classifier claiming it would convert a MANUAL retry into four
    // automatic ones with backoff, or a walk down the fallback chain, spending
    // real money on a completion we already know came back empty.
    const shown = String(res.finishReason || 'unknown').replace(/[\r\n]+/g, ' ').slice(0, 40);
    const build = (reason) =>
      `⚠ OpenRouter returned an empty response (finish reason: ${reason}). ` +
      `This is usually transient — try again. If it persists, pick a different model in Settings.`;
    throw new Error(firstInertMessage([
      build(shown),
      build('withheld — it reads as a provider fault'),
    ]));
  }
  return res.text;
}

/**
 * TEST-ONLY seam, mirroring `__setAnthropicClientFactory`. Null in production,
 * where `new OpenRouterAdapter(...)` is used exactly as written. Resolved PER
 * CALL, never snapshotted at module load — a top-level `const adapter = …`
 * would make the override silently import-order dependent (the v3.1.0 finding).
 *
 * Note the adapter ALSO accepts an injected `fetchImpl`, so a suite has two
 * seams available: this one to swap the whole adapter, and that one to drive
 * the real adapter's real classifier against synthetic HTTP responses.
 */
let _openrouterAdapterFactory = null;
export function __setOpenRouterAdapterFactory(factory) {
  _openrouterAdapterFactory = typeof factory === 'function' ? factory : null;
}

/**
 * Anthropic dispatch. Body moved verbatim out of `callProvider` when dispatch
 * was made total; the logic, the clamp, the cache breakpoint, the streaming
 * transport and every comment below are unchanged.
 */
async function callAnthropic(model, systemPrompt, userPrompt, maxTokens, responseFormat, opts, signal) {
  // Note: Anthropic's API has no native JSON mode equivalent. Prompts that ask
  // for JSON rely on the "Return ONLY valid JSON" directive in the system prompt
  // plus the jsonrepair fallback in parseJSON (see src/brain/ingest.js).
  const anthropicOptions = { apiKey: getEffectiveKey('anthropic') };
  const client = _anthropicClientFactoryOverride
    ? _anthropicClientFactoryOverride(anthropicOptions)
    : new Anthropic(anthropicOptions);

  // Clamp to THIS model's hard output cap. Call sites pass 65536 (right for
  // Gemini), which the Anthropic API rejects outright as "max_tokens: 65536 >
  // 64000" on Haiku. Per-model since 2026-08-24: a flat 64000 silently halved
  // the real 128,000 ceiling of the Sonnet 5 / Sonnet 4.6 fallback rungs. An
  // unrecognised id resolves to the conservative 64000 — see
  // anthropicMaxOutputTokens.
  const effectiveMaxTokens = Math.min(maxTokens, anthropicMaxOutputTokens(model));

  // Use the streaming transport, NOT messages.create(). The SDK (>=0.39) throws
  // "Streaming is strongly recommended for operations that may take longer than
  // 10 minutes" for ANY non-streaming call whose max_tokens implies a computed
  // timeout over 10 min — which fires for any budget above ~21,333 tokens,
  // regardless of model or actual response time. messages.stream() uses a fixed
  // 600s timeout and skips that guard. .finalMessage() assembles and returns the
  // identical Message object, so the stop_reason / content checks below are
  // unchanged. (Compile + single-pass ingest both request 65536 → both hit this
  // on Anthropic before this fix.)
  const anthropicBody = {
    model,
    max_tokens: effectiveMaxTokens,
    system: systemPrompt,
    // Either the plain prompt string (unchanged payload) or a two-block split
    // with a cache breakpoint on the stable prefix — see buildAnthropicUserContent.
    messages: [{ role: 'user', content: buildAnthropicUserContent(userPrompt, opts.cachePrefixChars) }],
  };
  // Same two-branch shape as the Gemini call above, and for the same reason:
  // with no signal the SDK is invoked exactly as before. `RequestOptions.signal`
  // is honoured by messages.stream() (SDK 0.39) and aborts the HTTP request.
  const message = await (signal
    ? client.messages.stream(anthropicBody, { signal })
    : client.messages.stream(anthropicBody)
  ).finalMessage();
  // `.finalMessage()` assembles the streamed events into the same Message object
  // a non-streaming call returns, including the accumulated `usage` block.
  reportUsage(opts.onUsage, {
    provider: 'anthropic', model,
    ...normalizeAnthropicUsage(message?.usage),
  });
  // v3.0.1-beta.8: detect Anthropic output-budget truncation. When the model
  // hits `max_tokens` mid-response, Anthropic returns
  // `stop_reason: "max_tokens"` and the `text` field contains the partial
  // JSON. Pre-fix this manifested as a deterministic JSON parse failure that
  // the v3.0.1-beta.7 retry-with-stricter-JSON path could never resolve
  // (because the underlying issue was budget, not prompt obedience).
  //
  // Especially impactful for Anthropic users because they have no JSON-mode
  // safety net — Gemini's MAX_TOKENS check (above) catches the analogous
  // condition there.
  // v3.0.7: routed through handleOutputTokenLimit — JSON mode still throws
  // (preserving the "output token limit" phrase isOutputTokenLimit matches on,
  // so ingest/compile fallbacks recover), but TEXT mode (chat, query) returns
  // the partial answer with a note instead of a misleading ingest error.
  if (message.stop_reason === 'max_tokens') {
    // Position-independent: a truncated Sonnet 5 response is [thinking, text],
    // so first-block indexing handed handleOutputTokenLimit an EMPTY partial and
    // a cut-off-but-useful chat answer arrived as nothing but the truncation note.
    const partial = extractAnthropicText(message?.content) ?? '';
    return handleOutputTokenLimit('Claude', effectiveMaxTokens, responseFormat, partial);
  }
  // Defensive: there may be no text block at all if the assistant produced only
  // tool-use blocks (shouldn't happen for these prompts, but better to
  // surface a clear error than to throw an obscure "undefined.text"). This is
  // the ONLY remaining throw case — a text block that is merely not first is a
  // normal response and now extracts correctly.
  const answerText = extractAnthropicText(message?.content);
  if (answerText === null) {
    // Same rule as the OpenRouter site above, and for the same reason:
    // `stop_reason` is provider-supplied text off the wire. Anthropic's enum is
    // tighter than an aggregator's `finish_reason`, so this is the less likely
    // of the two to ever carry classifier vocabulary — but "no evidence a
    // provider does this today" is the argument that lets a latent defect ship,
    // and guarding one of two identical shapes is this repo's guard-applied-to-
    // an-instance-not-a-class pattern (v3.6.0 found four in one release). The
    // cost of closing it is one call to the shared helper.
    const shown = String(message.stop_reason || 'unknown').replace(/[\r\n]+/g, ' ').slice(0, 40);
    const build = (reason) =>
      `⚠ Claude returned no text content (stop_reason: ${reason}). ` +
      `This is rare and usually transient — try again. If it persists, switch ` +
      `provider in Settings.`;
    throw new Error(firstInertMessage([
      build(shown),
      build('withheld — it reads as a provider fault'),
    ]));
  }
  return answerText;
}

/**
 * Call the active LLM with automatic fallback on model-not-found errors.
 *
 * Order of attempts:
 *   1. Primary model from DEFAULTS / LLM_MODEL env override
 *   2. Each entry in FALLBACK_CHAINS[provider]
 *
 * Only "model not found" errors trigger the next attempt. Any other error
 * (auth, rate-limit, network, 5xx) is re-thrown immediately so the outer
 * retry loop or caller can handle it appropriately.
 */
async function callLLM(systemPrompt, userPrompt, maxTokens, responseFormat, providerOverride = null, opts = {}) {
  // opts.model is the caller's per-call model choice, already narrowed to a
  // non-empty string by generateText and allow-listed inside getProviderInfo.
  // The fallback chain below is deliberately the PROVIDER's chain either way: if
  // a user-picked model is retired mid-session, the right recovery is still the
  // cheapest live model on that provider, not silence.
  const { provider, model } = getProviderInfo(providerOverride, opts.model || null);
  // Deduped: a user-picked model that is ALSO a fallback rung (e.g. a deliberate
  // claude-sonnet-5) would otherwise be retried against its own 404 before the
  // walk moved on. A no-op for the default path — no chain contains its own
  // provider's default (asserted in test-chat-model.js §9).
  const chain = [...new Set([model, ...(FALLBACK_CHAINS[provider] || [])])];
  let lastErr = null;

  for (let i = 0; i < chain.length; i++) {
    const candidate = chain[i];
    try {
      const result = await callProvider(provider, candidate, systemPrompt, userPrompt, maxTokens, responseFormat, opts);

      if (i === 0) {
        // Primary succeeded — clear any previous fallback state for this provider.
        // Diagnostics use console.error so this module is safe to import from
        // the MCP child process (stdout reserved for JSON-RPC) — v2.5.2.
        if (_activeFallback && _activeFallback.provider === provider) {
          console.error(`[llm] Primary model "${model}" is available again — clearing fallback state.`);
          _activeFallback = null;
        }
      } else {
        // A fallback succeeded — record for the UI to surface
        _activeFallback = {
          provider,
          requestedModel: chain[0],
          usingModel: candidate,
          at: new Date().toISOString(),
        };
        console.warn(
          `[llm] Primary model "${chain[0]}" is unavailable; using fallback "${candidate}". ` +
          `Please run "Check for Updates" in Settings to upgrade to a current model.`
        );
      }
      return result;
    } catch (err) {
      // Checked BEFORE isModelNotFound: walking the fallback chain on a cancel
      // would issue MORE provider calls (up to 5 more rungs) after the user
      // asked us to stop — the single worst thing this code could do here.
      if (isAbortError(err) || (opts.signal && opts.signal.aborted)) throw makeAbortError();
      // ── DETERMINISTIC BEATS NOT-FOUND, AND IT MUST BE CHECKED FIRST ────────
      // `generateText`'s retry ladder already gates on this tag — but the ladder
      // wraps THIS loop, so by the time it runs the chain has already been
      // walked and the money already spent. The gate has to be here too.
      //
      // The case that forced it (MEASURED live 2026-08-28, see
      // openrouter-adapter.js's ROUTING_CONSTRAINT_404_CLAUSES): OpenRouter
      // answers **404** when no upstream can satisfy the parameters we require,
      // and answers it for an account data-policy mismatch too. Both are our own
      // constraints, not a retired model, and `isModelNotFound` cannot tell the
      // difference — so a capability mismatch was being converted into a walk
      // onto a PAID fallback rung the user never asked for. That is not what
      // this chain is for: it exists for RETIREMENT, where the model the user
      // picked has genuinely ceased to exist.
      //
      // FAIL-SAFE DIRECTION: the tag is opt-in and set by exactly one adapter,
      // so every Gemini and Anthropic path is byte-unchanged, and an untagged
      // error classifies exactly as it did before. A wrongly-tagged error costs
      // one visible message; a wrongly-walked one costs money, silently.
      if (isDeterministicProviderError(err)) throw err;
      if (isModelNotFound(err) && i < chain.length - 1) {
        console.warn(`[llm] Model "${candidate}" returned "not found"; trying fallback "${chain[i + 1]}"...`);
        lastErr = err;
        continue;
      }
      // Non-deprecation error, or out of fallbacks — propagate
      throw err;
    }
  }
  // Should be unreachable — the loop either returns or throws — but be safe
  throw lastErr || new Error(`All ${provider} models failed`);
}

/**
 * Test-only surface. Lets an offline suite assert the standing invariants that
 * EVERY model id this app can run — default, fallback rung, or user-offerable —
 * is present in the price table and the output-cap map, so adding one without
 * its price fails the suite instead of silently downgrading the user's cost
 * warning to 'unknown', and adding one without its cap fails instead of
 * silently clamping to a conservative guess.
 */
export const __testing = {
  DEFAULTS, FALLBACK_CHAINS, MODEL_PRICES_USD_PER_MTOK, reportUsage,
  ANTHROPIC_MODEL_MAX_OUTPUT_TOKENS, GEMINI_MODEL_MAX_OUTPUT_TOKENS,
  OPENROUTER_MODEL_MAX_OUTPUT_TOKENS,
  PROMOTIONAL_PRICES, OFFERABLE_SUITABILITY,
  KNOWN_PROVIDERS, FREE_MODELS, TIERED_PRICE_MODELS,
  capsFor, hasKnownPricePosture, hasTieredPricing, providerDisplayName,
  // v3.15.0 guards. Exposed so a suite can drive the real predicates rather than
  // reach them through a provider call: `looksLikeMovingAlias` is the id-shaped
  // half of the alias refusal (the record-shaped half is the adapter's mapper),
  // and `isDeterministicProviderError` is what stops a 39-second retry of a
  // failure that cannot succeed.
  looksLikeMovingAlias, isDeterministicProviderError,
  // Transient-failure messaging. Exposed so a suite can EXECUTE the builders
  // for every provider — Gemini's SDK has no injectable client, so the
  // end-to-end path can only reach two of the three — and can drive
  // `providerRemedies` with prototype keys directly.
  PROVIDER_REMEDIES, providerRemedies,
  buildRateLimitMessage, buildServiceUnavailableMessage,
  is429, is503,
  // The private half of the model-resolution path, so a suite can assert the
  // build-lane refusal without having to reach it through a config write.
  applyModelOverride, defaultModelFor, storedSelection, resolveProviderDefault,
  callProvider,
  // Dynamic-price registry. Exposed so a suite can prove a free model registers
  // NO price (getModelPrice must stay null) and that a dynamic entry can never
  // shadow a hand-verified static one.
  registerDynamicPrice,
  // Exposed so the ordering suite can drive the REAL comparator with a free
  // (null-priced) entry directly — the coercion bug it exists to prevent is
  // invisible when only the sorted OUTPUT is inspected, because `null - n`
  // silently yields the right answer whenever free happens to be cheapest.
  compareOfferablePrice,
  dynamicPrices: _dynamicPrices,
  // Exposed so the suite can attempt to build a deliberately under-specified
  // entry and assert the factory REFUSES it — proving "a model may not be
  // offerable unless it is fully specified" is structural, not a convention.
  defineOfferableModel,
};
