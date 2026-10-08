// ═══════════════════════════════════════════════════════════════════════════
//  src/brain/ai-run.js — ONE ESTIMATE SHAPE AND ONE ACTUAL SHAPE (v3.67.0)
// ═══════════════════════════════════════════════════════════════════════════
//
// Every AI job runs on one model (see src/brain/ai-jobs.js). Before this file,
// each job described that model and its cost in its own words: five spellings
// of one model name, a range here, a point there, a hardcoded "$0.0001", and
// nothing at all after most runs. These two functions are the one shape every
// route hands to the one renderer (src/public/next/shared/ai-run.js):
//
//   describeRun()     BEFORE a run: which model, roughly how many tokens, what
//                     it should cost — or that no key is saved.
//   spentFromUsage()  AFTER a run: what actually ran and what it cost, from
//                     the `onUsage` payloads generateText already emits,
//                     accumulated by makeUsageAccumulator (src/brain/ingest.js).
//
// ── ABSENT MEANS OMITTED, NEVER ZERO ─────────────────────────────────────
// A figure we do not have is left OFF the object. `usdHigh: 0` on a model
// with no published price would render "$0.00" over a run that bills real
// money — the one lie a money surface must never tell. Only a FREE model
// carries a zero, because for a free model zero is the measurement.
//
// ── AN UNPRICED MODEL RUNS ───────────────────────────────────────────────
// Price is a displayed fact, never a quality gate. An unpriced model gets
// `priceKnown: false` and `costNote: 'price-not-published'` and the job
// proceeds, as Compile, Health and batch ingest already do. Only a SPENDING
// CAP is refused on an unpriced model (ingest-queue.js), because a cap nobody
// can price is a false promise — that rule is not this file's.
//
// Server-side only. Never writes stdout (it may be imported on the MCP graph
// one day; every diagnostic in src/brain goes to stderr).

import {
  getProviderInfo,
  getModelPrice,
  isFreeModel,
  isOfferableModel,
  listOfferableModels,
  getFallbackStatus,
  estimateRates,
  priceUsageUsd,
  cacheRatesFor,
} from './llm.js';
import { estimateInputTokens } from './compile-estimate.js';
import { aiJob } from './ai-jobs.js';

/** Provider names as the app shows them (the Settings sidebar's spelling). */
function providerLabelFor(provider) {
  switch (provider) {
    case 'gemini':     return 'Gemini';
    case 'anthropic':  return 'Anthropic';
    case 'openrouter': return 'OpenRouter';
    default:           return typeof provider === 'string' && provider ? provider : null;
  }
}

/** The offerable entry for an exact (provider, id), or null. Never throws. */
function offerableEntry(provider, modelId) {
  if (typeof modelId !== 'string' || !modelId) return null;
  try {
    const list = listOfferableModels(provider);
    for (const e of list) if (e && e.id === modelId) return e;
  } catch { /* degrades to "no entry" */ }
  return null;
}

/** The human label, or the id when the model is not in the catalogue. */
function modelLabelFor(provider, modelId) {
  const e = offerableEntry(provider, modelId);
  return (e && typeof e.label === 'string' && e.label) ? e.label : modelId;
}

const isCount = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const round6 = (n) => Math.round(n * 1e6) / 1e6;

/** A (low, high) pair from two optional counts; one given means a point. */
function pair(low, high) {
  const l = isCount(low) ? Math.round(low) : null;
  const h = isCount(high) ? Math.round(high) : null;
  if (l === null && h === null) return null;
  if (l === null) return { low: h, high: h };
  if (h === null) return { low: l, high: l };
  return l <= h ? { low: l, high: h } : { low: h, high: l };
}

/**
 * Describe a run BEFORE it happens.
 *
 * @param {object} a
 * @param {string} a.job               an AI_JOBS id ('compile', 'reading-plan', …)
 * @param {number} [a.inputChars]      prompt size in characters; converted with the
 *                                     app's one tokenizer model (estimateInputTokens,
 *                                     the ±15% band and the model's tokenizer factor)
 * @param {number} [a.inputTokensLow]  ADDITIVE: a caller that already counted its
 * @param {number} [a.inputTokensHigh]   input tokens passes them instead of chars,
 *                                     so an adopting route keeps its own figures
 * @param {number} [a.outputTokensLow]
 * @param {number} [a.outputTokensHigh]
 * @returns {object} see the file header; absent figures are omitted
 */
export function describeRun({
  job, inputChars, inputTokensLow, inputTokensHigh, outputTokensLow, outputTokensHigh,
} = {}) {
  const row = aiJob(job);
  const jobLabel = row ? row.label : null;

  // ── ONE RESOLUTION ─────────────────────────────────────────────────────
  // Any throw here is the no-key state. getProviderInfo has exactly two
  // throws: "No LLM API key found." (no provider has a usable key) and "No
  // model is configured for …" (a provider with no DEFAULTS entry — every
  // shipping provider carries one, so it is unreachable today). Both mean
  // "nothing can run until Providers & keys is visited", which is the door
  // the no-key line opens.
  let provider, model;
  try {
    const info = getProviderInfo();
    provider = info.provider;
    model = info.model;
  } catch {
    return { job, jobLabel, needsKey: true };
  }

  const entry = offerableEntry(provider, model);
  const free = isFreeModel(model);
  // Freeness is MEMBERSHIP, tested first: getModelPrice returns null for a
  // free model and an unpriced one alike.
  const price = free ? null : getModelPrice(model);
  const priceKnown = free || Boolean(price);

  const out = {
    job,
    jobLabel,
    needsKey: false,
    provider,
    providerLabel: providerLabelFor(provider),
    model,
    modelLabel: (entry && typeof entry.label === 'string' && entry.label) ? entry.label : model,
  };

  // ── TOKENS ─────────────────────────────────────────────────────────────
  let input = pair(inputTokensLow, inputTokensHigh);
  if (!input && isCount(inputChars)) {
    const est = estimateInputTokens(inputChars, provider, model);
    input = { low: est.low, high: est.high };
  }
  const output = pair(outputTokensLow, outputTokensHigh);
  if (input) {
    out.inputTokens = Math.round((input.low + input.high) / 2);
    out.inputTokensLow = input.low;
    out.inputTokensHigh = input.high;
  }
  if (output) {
    out.outputTokensLow = output.low;
    out.outputTokensHigh = output.high;
  }

  // ── MONEY ──────────────────────────────────────────────────────────────
  // Priced from BOTH halves or not at all: an input-only figure would quote
  // the cheap half of a bill and read as the whole of it.
  if (free) {
    out.usdLow = 0;
    out.usdHigh = 0;
  } else if (price && input && output) {
    // TIERED PRICE (2026-10-08): a describe call carries run TOTALS with no
    // per-call prompt sizes, so for a tiered model the low end is the lower
    // tier (every call under the threshold) and the HIGH end the upper tier
    // (any call could cross) — `estimateRates` with an unknown size. For a
    // flat model both are `price`, exactly as before.
    const hi = estimateRates(model, null) || price;
    out.usdLow = round6((input.low / 1e6) * price.input + (output.low / 1e6) * price.output);
    out.usdHigh = round6((input.high / 1e6) * hi.input + (output.high / 1e6) * hi.output);
  }
  out.priceKnown = priceKnown;
  out.free = free;
  out.costNote = free ? 'free' : (price ? 'priced' : 'price-not-published');

  const ms = entry ? entry.medianLatencyMs : null;
  if (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) out.medianLatencyMs = ms;
  return out;
}

// ── CACHE RATES: ONE RULE, IN llm.js ────────────────────────────────────────
// Until 2026-10-08 this was a restated copy of the batch queue's rule, pinned to
// it by scripts/test-ai-run.js. Both now call llm.js's `cacheRatesFor` (and the
// whole finished-call formula, `priceUsageUsd`), so there is no second copy to
// drift. Kept as a named export for the suites that drive it.
function cacheMultipliersFor(modelId) {
  return cacheRatesFor(modelId);
}

/**
 * What a finished run actually cost, from the accumulated `onUsage` totals.
 *
 * @param {object} totals  makeUsageAccumulator().totals —
 *   {calls, inputTokens, outputTokens, cachedReadTokens, cacheWriteTokens, provider, model}
 * @returns {{provider, providerLabel, model, modelLabel, inputTokens, outputTokens,
 *            cachedReadTokens, cacheWriteTokens, calls, usd:number|null,
 *            estimated:boolean, fallbackFrom:string|null}}
 *
 * `usd` is 0 for a free model (membership, checked first), the real figure
 * for a priced one, and null when the model is unpriced or no call reported
 * a model. `estimated` is false: every figure here comes from provider-
 * reported tokens, never inferred; the field exists so a renderer that is
 * handed an inferred figure prints "approx.".
 *
 * `model` is the model that ACTUALLY RAN (the last call's report), so a
 * fallback walk is priced at the rung that billed. `fallbackFrom` names the
 * model the user chose when the fallback chain answered instead: taken from
 * getFallbackStatus() when its `usingModel` is the model that ran AND that
 * model is not the one the settings resolve to today (a user who picked the
 * rung on purpose is not "falling back").
 */
export function spentFromUsage(totals) {
  const t = (totals && typeof totals === 'object') ? totals : {};
  const n = (v) => (isCount(v) ? v : 0);
  const model = (typeof t.model === 'string' && t.model) ? t.model : null;
  const provider = (typeof t.provider === 'string' && t.provider) ? t.provider : null;

  const out = {
    provider,
    providerLabel: providerLabelFor(provider),
    model,
    modelLabel: model ? modelLabelFor(provider, model) : null,
    inputTokens: n(t.inputTokens),
    outputTokens: n(t.outputTokens),
    cachedReadTokens: n(t.cachedReadTokens),
    cacheWriteTokens: n(t.cacheWriteTokens),
    calls: n(t.calls),
    usd: null,
    estimated: false,
    fallbackFrom: null,
  };

  if (model) {
    if (isFreeModel(model)) {
      out.usd = 0;
    } else {
      // The ONE tier-aware formula (llm.js `priceUsageUsd`): the cache rates of
      // the model that ran and, for a tiered model, the per-call tier split the
      // accumulator recorded (a total without one is priced at the upper tier).
      const usd = priceUsageUsd(model, t);
      if (typeof usd === 'number' && Number.isFinite(usd)) out.usd = usd;
    }

    let fb = null;
    try { fb = getFallbackStatus(); } catch { fb = null; }
    if (fb && fb.usingModel === model && typeof fb.requestedModel === 'string'
        && fb.requestedModel && fb.requestedModel !== model) {
      let resolved = null;
      try { resolved = getProviderInfo().model; } catch { resolved = null; }
      if (resolved !== model) out.fallbackFrom = fb.requestedModel;
    }
  }
  return out;
}

export const __testing = { cacheMultipliersFor, providerLabelFor, offerableEntry };
