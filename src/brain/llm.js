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
 * Order: most-similar model first, then broadly-available stable aliases.
 * Rate-limit (429) and service-unavailable (503) errors DO NOT trigger
 * fallback — those are handled by the existing retry loop.
 */
const FALLBACK_CHAINS = {
  gemini: [
    'gemini-2.5-flash',             // next tier up in the same family
    'gemini-1.5-flash',             // previous-gen stable
    'gemini-1.5-flash-latest',      // Google's rolling alias as last resort
  ],
  anthropic: [
    'claude-3-5-haiku-latest',      // previous Haiku gen — same cost tier, SDK-typed
    'claude-3-5-haiku-20241022',    // explicit stable version (last-resort Haiku)
    'claude-sonnet-4-5',            // upgrade tier if Haiku family is entirely gone
    'claude-3-7-sonnet-latest',     // rolling alias recognised by SDK types
    'claude-3-5-sonnet-latest',     // deep fallback — broadly-available Sonnet
  ],
};

/**
 * Module-level snapshot of the most recent fallback event.
 * null when the primary model is working; populated when a fallback is in use.
 * Cleared automatically when a subsequent primary call succeeds.
 */
let _activeFallback = null;

/**
 * @returns {null | {provider: string, requestedModel: string, usingModel: string, at: string}}
 */
export function getFallbackStatus() {
  return _activeFallback;
}

export function getProviderInfo() {
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
 * @returns {Promise<string>}
 */
export async function generateText(systemPrompt, userPrompt, maxTokens = 8192, responseFormat = 'text', onWait = null) {
  const MAX_RETRIES = 4; // up to 4 attempts (3 retries)

  // Resolve provider name once for consistent error messaging. If this fails
  // (e.g. no key configured), let the underlying call throw the original
  // "No LLM API key found" message — don't shadow it here.
  let providerName = 'AI provider';
  try {
    const info = getProviderInfo();
    providerName = info.provider === 'gemini' ? 'Gemini' : info.provider === 'anthropic' ? 'Claude' : 'AI provider';
  } catch { /* surface real error from callLLM below */ }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await callLLM(systemPrompt, userPrompt, maxTokens, responseFormat);
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
 */
async function callProvider(provider, model, systemPrompt, userPrompt, maxTokens, responseFormat) {
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
    messages: [{ role: 'user', content: userPrompt }],
  }).finalMessage();
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
async function callLLM(systemPrompt, userPrompt, maxTokens, responseFormat) {
  const { provider, model } = getProviderInfo();
  const chain = [model, ...(FALLBACK_CHAINS[provider] || [])];
  let lastErr = null;

  for (let i = 0; i < chain.length; i++) {
    const candidate = chain[i];
    try {
      const result = await callProvider(provider, candidate, systemPrompt, userPrompt, maxTokens, responseFormat);

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
