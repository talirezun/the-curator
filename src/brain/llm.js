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
import { getEffectiveKey, getActiveProvider } from './config.js';

const DEFAULTS = {
  gemini:    'gemini-2.5-flash-lite',
  anthropic: 'claude-haiku-4-5',         // Haiku is the low-cost tier, matching the
                                         // cost profile of gemini-2.5-flash-lite.
                                         // See docs/model-lifecycle.md for rationale.
};

// Claude Haiku 4.5 caps output at 64,000 tokens; requesting more is rejected by
// the API with "max_tokens: N > 64000". Our ingest/compile call sites request
// 65536 (correct for Gemini 2.5 Flash, which allows it) — so the Anthropic
// branch clamps down to this ceiling. Anthropic is the ONLY provider clamped;
// Gemini keeps the full 65536. Haiku is the only Anthropic model the Curator
// enables (DEFAULTS.anthropic), so a single constant suffices.
export const ANTHROPIC_MAX_OUTPUT_TOKENS = 64000;

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
  gemini: [
    'gemini-3.1-flash-lite',        // closest live successor — verified drop-in, but 2.5x in / 3.75x out
    'gemini-3.5-flash-lite',        // next flash-lite generation — 3x in / 6.25x out
    'gemini-2.5-flash',             // higher (costlier) tier — last resort
  ],
  anthropic: [
    'claude-3-5-haiku-latest',      // previous Haiku gen — actually CHEAPER ($0.80/$4), SDK-typed
    'claude-3-5-haiku-20241022',    // explicit stable version (last-resort Haiku)
    'claude-sonnet-4-5',            // upgrade tier if Haiku family is entirely gone
    'claude-3-7-sonnet-latest',     // rolling alias recognised by SDK types
    'claude-3-5-sonnet-latest',     // deep fallback — broadly-available Sonnet
  ],
};

/**
 * Published API prices, USD per 1M tokens, keyed by EXACT model id.
 *
 * Scope is deliberately tiny: the ~10 ids this app can actually run — DEFAULTS
 * plus every rung of FALLBACK_CHAINS. Those are ids WE choose and change
 * deliberately, so staleness is bounded by our own release process (see the
 * release checklist in docs/model-lifecycle.md: adding a rung means adding its
 * price here).
 *
 * This replaced a family-name heuristic (flash-lite/flash, haiku/sonnet) that
 * looked reasonable and was structurally wrong: the family word is stable
 * ACROSS generations while the price is not. It scored
 * gemini-2.5-flash-lite → gemini-3.1-flash-lite as "same tier" when that
 * successor is 2.5x the input and 3.75x the output price — i.e. it stayed
 * silent on the exact rung the chain reaches FIRST. Only an exact-id table can
 * see a within-family price change.
 *
 * The numbers are used ONLY for ordering comparisons and are never displayed to
 * the user, so a stale absolute value is harmless as long as the ORDER is right.
 *
 * Verified 2026-08-22 against ai.google.dev/gemini-api/docs/pricing and
 * platform.claude.com/docs/en/about-claude/pricing (standard tier, text).
 */
const MODEL_PRICES_USD_PER_MTOK = {
  // ── Gemini ──
  'gemini-2.5-flash-lite':     { input: 0.10, output: 0.40 },   // current default
  'gemini-3.1-flash-lite':     { input: 0.25, output: 1.50 },   // 2.5x in / 3.75x out vs default
  'gemini-3.5-flash-lite':     { input: 0.30, output: 2.50 },   // 3x in / 6.25x out vs default
  'gemini-2.5-flash':          { input: 0.30, output: 2.50 },
  // ── Anthropic ──
  'claude-haiku-4-5':          { input: 1.00, output: 5.00 },   // current default
  // Haiku 3.5 is genuinely CHEAPER than Haiku 4.5 — a fallback onto it must not
  // warn about cost. Exactly the kind of case a family heuristic cannot see.
  'claude-3-5-haiku-latest':   { input: 0.80, output: 4.00 },
  'claude-3-5-haiku-20241022': { input: 0.80, output: 4.00 },
  'claude-sonnet-4-5':         { input: 3.00, output: 15.00 },
  // 3.7 / 3.5 Sonnet are retired from the published table; these are their last
  // published rates, kept for ORDERING only (Sonnet > Haiku is not in doubt).
  'claude-3-7-sonnet-latest':  { input: 3.00, output: 15.00 },
  'claude-3-5-sonnet-latest':  { input: 3.00, output: 15.00 },
};

// Frozen at definition: this table is exported through `__testing` for the
// offline price-coverage invariant, and a test that mutated it would corrupt
// every later cost comparison in the same process. Entries are frozen too, so
// `MODEL_PRICES_USD_PER_MTOK['x'].input = 0` is a no-op rather than a silent
// cross-test leak.
for (const price of Object.values(MODEL_PRICES_USD_PER_MTOK)) Object.freeze(price);
Object.freeze(MODEL_PRICES_USD_PER_MTOK);

/**
 * Published price for an exact model id, or null if we don't ship it.
 * @returns {null | {input: number, output: number}}
 */
export function getModelPrice(modelId) {
  if (typeof modelId !== 'string') return null;
  return Object.hasOwn(MODEL_PRICES_USD_PER_MTOK, modelId)
    ? MODEL_PRICES_USD_PER_MTOK[modelId]
    : null;
}

/**
 * Compare what the user CONFIGURED against what they are actually being billed
 * for right now. Three states, because two would force us to lie:
 *
 *   'costlier' — confirmed higher on input and/or output. Warn plainly.
 *   'similar'  — confirmed same-or-cheaper. Say nothing about cost.
 *   'unknown'  — at least one id is not in the price table. NEVER imply parity
 *                here: any fallback means the user is off the model they chose,
 *                so the honest line is "pricing may differ", not silence.
 *
 * @returns {'costlier'|'similar'|'unknown'}
 */
export function compareModelCost(requestedModel, usingModel) {
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
 * The default model id for a provider (respecting a global LLM_MODEL override
 * only for the currently-active provider). Exported so the UI can display the
 * CURRENT model per provider — when we bump DEFAULTS to a newer model, the
 * chat model selector's label updates automatically with no frontend change.
 */
export function getDefaultModel(provider) {
  if (provider !== 'gemini' && provider !== 'anthropic') return null;
  // LLM_MODEL is a single global dev override tied to the active provider; only
  // surface it for that provider so we never label Gemini with a Claude id.
  if (process.env.LLM_MODEL && getActiveProvider() === provider) return process.env.LLM_MODEL;
  return DEFAULTS[provider];
}

/**
 * @param {('gemini'|'anthropic'|null)} preferProvider - optional per-call
 *   provider override (e.g. the chat model selector). Used ONLY if that
 *   provider has a usable key; otherwise falls through to the global active
 *   provider. The override always resolves the provider's DEFAULT model.
 */
export function getProviderInfo(preferProvider = null) {
  // Per-call override (v3.0.11: chat model selector). Never honours a stale
  // override whose key is missing — falls through to the global logic below.
  if ((preferProvider === 'gemini' || preferProvider === 'anthropic') && getEffectiveKey(preferProvider)) {
    return { provider: preferProvider, model: getDefaultModel(preferProvider) };
  }
  // Honour the user's last-saved active provider (v2.4.2+). Falls back to
  // Gemini-first-if-both behaviour for legacy configs via getActiveProvider().
  const active = getActiveProvider();
  if (active === 'gemini' && getEffectiveKey('gemini')) {
    return { provider: 'gemini', model: process.env.LLM_MODEL || DEFAULTS.gemini };
  }
  if (active === 'anthropic' && getEffectiveKey('anthropic')) {
    return { provider: 'anthropic', model: process.env.LLM_MODEL || DEFAULTS.anthropic };
  }
  // Defensive fallback: active provider is stored but its key is missing.
  // Prefer whichever provider still has a usable key.
  if (getEffectiveKey('gemini')) {
    return { provider: 'gemini', model: process.env.LLM_MODEL || DEFAULTS.gemini };
  }
  if (getEffectiveKey('anthropic')) {
    return { provider: 'anthropic', model: process.env.LLM_MODEL || DEFAULTS.anthropic };
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
  const providerOverride = (opts && (opts.provider === 'gemini' || opts.provider === 'anthropic'))
    ? opts.provider : null;

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
  };

  // Resolve provider name once for consistent error messaging. If this fails
  // (e.g. no key configured), let the underlying call throw the original
  // "No LLM API key found" message — don't shadow it here.
  let providerName = 'AI provider';
  try {
    const info = getProviderInfo(providerOverride);
    providerName = info.provider === 'gemini' ? 'Gemini' : info.provider === 'anthropic' ? 'Claude' : 'AI provider';
  } catch { /* surface real error from callLLM below */ }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await callLLM(systemPrompt, userPrompt, maxTokens, responseFormat, providerOverride, callOpts);
    } catch (err) {
      const retryable = is429(err) || is503(err);
      if (!retryable || attempt === MAX_RETRIES) {
        // Out of retries or non-retryable error — surface a clean message that
        // makes clear whether the issue is in The Curator or upstream at the
        // AI provider, and what the user should do next (v3.0.1-beta.4).
        if (is429(err)) {
          const delaySec = Math.ceil(parseRetryDelay(err) / 1000);
          throw new Error(
            `⚠ Rate limit hit on ${providerName} (HTTP 429). This is an upstream limit on your API account, ` +
            `not an issue with The Curator. Free tiers cap at ~15 requests/min and ~20–50 requests/day; ` +
            `paid plans have much higher limits but can still be reached during bulk operations. ` +
            `Please wait ${delaySec} seconds and try again. If you are on the free tier, consider upgrading at https://ai.google.dev/pricing.`
          );
        }
        if (is503(err)) {
          throw new Error(
            `⚠ ${providerName} infrastructure is temporarily overloaded (HTTP 503). This is a transient backend ` +
            `issue on the provider's side — it affects ALL accounts equally (free and paid), and is NOT a ` +
            `problem with The Curator or your API key. The Curator already retried 4 times with backoff over ` +
            `~40 seconds. What to do: wait 2–3 minutes and try again; if the issue persists, check ` +
            `https://status.cloud.google.com or temporarily switch to a different provider in Settings.`
          );
        }
        throw err;
      }

      // Calculate delay: 429 respects API hint; 503 uses exponential backoff (3s, 9s, 27s)
      const delayMs = is429(err)
        ? parseRetryDelay(err)
        : Math.min(3000 * Math.pow(3, attempt - 1), 60_000);

      const delaySec = Math.ceil(delayMs / 1000);
      const reason = is429(err) ? 'Rate limit' : 'Service busy';
      console.warn(
        `[llm] ${reason} (attempt ${attempt}/${MAX_RETRIES}). Waiting ${delaySec}s...`
      );
      onWait?.(`${reason} — retrying in ${delaySec}s… (attempt ${attempt}/${MAX_RETRIES - 1})`);
      await sleep(delayMs);
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
 * Anthropic default — and 2048 on the claude-3-5-haiku fallback rungs. A prefix
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
    const result = await geminiModel.generateContent({
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig,
    });
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

  // ── Anthropic Claude ─────────────────────────────────────────────────────
  // Note: Anthropic's API has no native JSON mode equivalent. Prompts that ask
  // for JSON rely on the "Return ONLY valid JSON" directive in the system prompt
  // plus the jsonrepair fallback in parseJSON (see src/brain/ingest.js).
  const client = new Anthropic({ apiKey: getEffectiveKey('anthropic') });

  // Clamp to Haiku's hard output cap. Call sites pass 65536 (right for Gemini),
  // which the Anthropic API rejects outright as "max_tokens: 65536 > 64000".
  const effectiveMaxTokens = Math.min(maxTokens, ANTHROPIC_MAX_OUTPUT_TOKENS);

  // Use the streaming transport, NOT messages.create(). The SDK (>=0.39) throws
  // "Streaming is strongly recommended for operations that may take longer than
  // 10 minutes" for ANY non-streaming call whose max_tokens implies a computed
  // timeout over 10 min — which fires for any budget above ~21,333 tokens,
  // regardless of model or actual response time. messages.stream() uses a fixed
  // 600s timeout and skips that guard. .finalMessage() assembles and returns the
  // identical Message object, so the stop_reason / content checks below are
  // unchanged. (Compile + single-pass ingest both request 65536 → both hit this
  // on Anthropic before this fix.)
  const message = await client.messages.stream({
    model,
    max_tokens: effectiveMaxTokens,
    system: systemPrompt,
    // Either the plain prompt string (unchanged payload) or a two-block split
    // with a cache breakpoint on the stable prefix — see buildAnthropicUserContent.
    messages: [{ role: 'user', content: buildAnthropicUserContent(userPrompt, opts.cachePrefixChars) }],
  }).finalMessage();
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
    const firstBlock = message?.content?.[0];
    const partial = firstBlock && typeof firstBlock.text === 'string' ? firstBlock.text : '';
    return handleOutputTokenLimit('Claude', effectiveMaxTokens, responseFormat, partial);
  }
  // Defensive: text field can be missing if the assistant produced only
  // tool-use blocks (shouldn't happen for these prompts, but better to
  // surface a clear error than to throw an obscure "undefined.text").
  const firstBlock = message?.content?.[0];
  if (!firstBlock || typeof firstBlock.text !== 'string') {
    throw new Error(
      `⚠ Claude returned no text content (stop_reason: ${message.stop_reason || 'unknown'}). ` +
      `This is rare and usually transient — try again. If it persists, switch ` +
      `provider in Settings.`
    );
  }
  return firstBlock.text;
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
  const { provider, model } = getProviderInfo(providerOverride);
  const chain = [model, ...(FALLBACK_CHAINS[provider] || [])];
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
 * Test-only surface. Lets an offline suite assert the standing invariant that
 * EVERY model id this app can run is present in the price table — so adding a
 * fallback rung without its price fails the suite instead of silently
 * downgrading the user's cost warning to 'unknown'.
 */
export const __testing = { DEFAULTS, FALLBACK_CHAINS, MODEL_PRICES_USD_PER_MTOK, reportUsage };
