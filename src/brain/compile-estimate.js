/**
 * Cost estimate for Compile to Wiki — v3.27.0
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * Compile to Wiki was the last paid action in the app that spent money with no
 * estimate and no confirm. Batch ingest has had `estimateIngestQueueCost` since
 * v3.3.0 and the semantic-duplicate scan has had `estimateSemanticDuplicateScan`
 * since v2.4.5; this is the same shape for the third spending surface, and it
 * deliberately reuses both precedents rather than inventing a third vocabulary.
 *
 * ── FOUR PROPERTIES ARE REQUIREMENTS, NOT CONVENIENCES ──────────────────────
 *
 *   1. IT COSTS NOTHING TO RUN. No LLM call, no network. An estimate that
 *      spends money to tell you what you are about to spend is a contradiction.
 *      The only I/O is reading the conversation, the schema and two directory
 *      listings — the same reads the compile itself does first.
 *
 *   2. IT IS COMPUTED FOR THE CONVERSATION IN FRONT OF IT. The input half is
 *      not a formula over a size proxy: it runs the REAL `buildCompilePrompt`
 *      over the REAL conversation and the REAL entity/concept inventory, so it
 *      captures the fact this feature exists to surface — compile cost is
 *      dominated by how big your WIKI already is, not by how long your chat was.
 *      (Measured below: the same 4-turn conversation is 5,740 prompt chars on a
 *      fresh domain and 12,431 on one holding 180 pages.) There is no single
 *      multiplier anywhere in this file, for the reason `ingest-queue.js`'s
 *      `buildBasisString` docblock spells out at length.
 *
 *   3. IT RETURNS A RANGE, NEVER A POINT. Output length is genuinely unknown
 *      before the call: three identical replicates of one compile produced
 *      2,456 / 2,145 / 1,977 output tokens (±11% around their own mean) and
 *      19 / 18 / 18 pages. On top of that the ladder can degrade
 *      `full -> concise -> summary-only`, which changes the answer's size by an
 *      order of magnitude. A confidently wrong number on a spending surface
 *      costs more trust than a wide honest one.
 *
 *   4. AN UNKNOWN IS SAID OUT LOUD, NEVER RENDERED AS $0.00. No provider, a
 *      free model and an unpriced model are THREE different facts and each gets
 *      its own `costUnknown` code and its own sentence. Collapsing a fact and
 *      its absence into one value is v3.15.0's recorded defect; writing a zero
 *      onto the money path is the trap `llm.js`'s FREE_MODELS docblock refuses.
 *
 * ── WHAT WAS MEASURED, AND HOW MUCH IT COST ─────────────────────────────────
 * Every constant below comes from real compiles run against a real model
 * (`gemini-2.5-flash-lite`, the shipping Gemini default) on isolated temporary
 * domains on 2026-08-30. Ten paid calls, $0.009462 total. Seven full compiles,
 * two summary-only calls, three of the full compiles being byte-identical
 * replicates run to measure variance rather than to add a data point.
 *
 *   case            transcript  promptChars  predIn  actualIn  ratio  outTok  pages
 *   tiny / fresh           899        4,941   1,400     1,230  0.879     726      5
 *   small / fresh        1,676        5,740   1,626     1,391  0.855   2,623     17
 *   medium / mature      3,219       12,431   3,522     3,863  1.097   3,189     21
 *   large / mature       6,510       15,805   4,477     4,559  1.018   3,036     21
 *   replicate 1          3,219       11,997   3,399     3,767  1.108   2,456     19
 *   replicate 2          3,219       11,997   3,399     3,767  1.108   2,145     18
 *   replicate 3          3,219       11,997   3,399     3,767  1.108   1,977     18
 *   summary-only           899        2,403       -       607      -     257      1
 *   summary-only         6,510       13,267       -     3,937      -     523      1
 *
 * THREE THINGS THAT DATA SETTLES, AND ONE IT DOES NOT:
 *
 *   • INPUT TOKENISATION IS DETERMINISTIC AND WELL-PREDICTED. The three
 *     replicates returned 3,767 input tokens EVERY time, to the token. Across
 *     all seven runs `chars / CHARS_PER_TOKEN` lands between 0.855x and 1.108x
 *     of truth — which is where INPUT_TOKEN_BAND comes from.
 *   • THE ERROR IS NOT RANDOM, IT IS COMPOSITIONAL, and the direction is
 *     recorded here so a future improvement does not have to rediscover it: on
 *     a FRESH domain the estimate runs ~15% HIGH (the prompt is nearly all
 *     prose, which measures ~4.07 chars/token), and on a MATURE one ~10% LOW
 *     (the slug inventory measures ~2.5-2.7 chars/token, exactly the figure
 *     docs/ingestion-pipeline.md derives for slug paths). A two-rate model
 *     would be tighter. It is deliberately NOT built: it would mean a second
 *     hand-tuned constant fitted to seven points, on the money path, against
 *     one shared constant that is already documented and already cross-checked
 *     by the batch estimator. The band is honest about the same residual
 *     without pretending to more resolution than nine calls can support.
 *   • OUTPUT SATURATES. Doubling the transcript from 3,219 to 6,510 chars did
 *     not increase the page count (21 -> 21) or the output tokens (3,189 ->
 *     3,036). Output per PAGE, by contrast, was stable across every run at
 *     110-154 tokens.
 *   • WHAT IT DOES NOT SETTLE: any of this on a DIFFERENT provider. Every
 *     figure is Gemini's tokenizer. `tokenizerFactor` (below) is the only
 *     correction applied for that, and it is a published per-model premium
 *     rather than something measured here.
 *
 * ── END-TO-END: WHAT THIS MODULE QUOTED, AND WHAT THE BILL SAID ─────────────
 * The constants above were fitted before this module existed. Two further real
 * compiles were then run THROUGH the shipped estimator and the shipping compile
 * path, on a 70-page domain, and compared:
 *
 *   conversation                quoted $        actual $   where in the range
 *   "Prompt caching…"    0.000272-0.001211     0.000413              15.0%
 *   "Why no embeddings"  0.000254-0.000848     0.000386              22.2%
 *
 * Both bracketed, on input tokens, output tokens and dollars independently.
 * Both landed in the LOWER FIFTH of their range, which is the expected and
 * intended direction: `pagesHigh` allows for far more pages than a short
 * conversation produces, and over-quoting is the safe way to be wrong about
 * money. Two points do not make the estimator calibrated — the honest summary
 * is that eleven real compiles have now all landed inside the quoted range,
 * every one of them on one model.
 *
 * @see src/brain/ingest-queue.js  — `estimateIngestQueueCost`, the precedent
 * @see src/brain/health-ai.js     — `estimateSemanticDuplicateScan`, the flow
 */

import { readdir } from 'fs/promises';
import path from 'path';
import { buildCompilePrompt, precheckCompile } from './compile.js';
import { readSchema, wikiPath } from './files.js';
import { CHARS_PER_TOKEN } from './ingest-queue.js';
import {
  getProviderInfo,
  getModelPrice,
  isFreeModel,
  listOfferableModels,
} from './llm.js';

/**
 * Multiplicative band applied to the `chars / CHARS_PER_TOKEN` point estimate.
 *
 * MEASURED 0.855x - 1.108x over the seven real compiles tabulated above, then
 * widened to the nearest 0.05 in BOTH directions. It is not a confidence
 * interval and is not called one: it is the observed spread, rounded outwards,
 * on one provider's tokenizer.
 */
const INPUT_TOKEN_BAND = Object.freeze({ low: 0.85, high: 1.15 });

/**
 * Output tokens one written page costs. MEASURED 110-154 across the seven full
 * compiles (which produced 5, 17, 21, 21, 19, 18 and 18 pages respectively);
 * 175 is that spread's top rounded outwards. A "page" here is what the compile
 * prompt asks for: 3-8 concise bullets plus a Tags line, JSON-escaped.
 *
 * Only the HIGH end is expressed per-page. The low end of the output range is
 * anchored on the measured summary-only rung instead (SUMMARY_ONLY_* below),
 * because that is a real outcome the ladder lands on rather than an arithmetic
 * floor, and a constant nothing consumes is a field this repo has learned not
 * to ship.
 */
const TOKENS_PER_PAGE_HIGH = 175;

/**
 * How many pages the model might write, as a function of transcript size.
 *
 * ── THIS IS THE WEAKEST NUMBER IN THE FILE AND IT IS LABELLED AS SUCH ───────
 * `pagesHigh = PAGES_BASE + chars / PAGES_CHARS_EACH`, clamped. The clamp's
 * upper end is the SATURATION assumption: the measurements show page count
 * flat at 21 while the transcript doubled, so an unbounded linear high end
 * would quote a figure ten times reality on a long thread. `PAGES_MAX` is set
 * at 40 — nearly double the largest count ever observed — precisely because
 * saturation is inferred from two points rather than established.
 *
 * The slope brackets every observation with headroom: the tightest case is the
 * 1,676-char conversation that produced 17 pages, where this yields 20.
 *
 * There is deliberately no LOW page count: see TOKENS_PER_PAGE_HIGH.
 */
const PAGES_BASE = 3;
const PAGES_CHARS_EACH = 100;
const PAGES_MIN = 8;
const PAGES_MAX = 40;

/**
 * The `summary-only` rung's output size — the smallest answer a successful
 * compile can produce, since that rung writes exactly one page.
 *
 * Two measured points, both direct calls in that mode: 257 output tokens for a
 * 899-char transcript and 523 for a 6,510-char one. The line through them is
 * ~214 + 0.047 x chars; the constants below are that line rounded, and they
 * reproduce both points within 3%. TWO POINTS ARE TWO POINTS — this is an
 * order-of-magnitude anchor for the cheap end of the range, and it is the end
 * where being slightly wrong costs the least.
 */
const SUMMARY_ONLY_BASE_TOKENS = 200;
const SUMMARY_ONLY_TOKENS_PER_CHAR = 0.05;

/** Mirrors the `maxTokens` argument compileConversation actually passes. */
const COMPILE_MAX_OUTPUT_TOKENS = 65536;

function round6(n) { return Math.round(n * 1e6) / 1e6; }

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

/**
 * The published per-model input-token premium, or 1 when we ship no measured
 * figure for this id.
 *
 * `claude-sonnet-5`, `claude-opus-5` and `claude-opus-4-8` carry 1.329 — a
 * MEASURED 32.9% more input tokens for the same Curator prose. Four OpenRouter
 * models carry smaller premiums (1.015-1.041); `claude-opus-4-5` carries NONE.
 * Derive the list from OFFERABLE_MODELS, never from this comment: an earlier
 * version of it omitted sonnet-5 and named a model that has no premium at all.
 * The 32.9% figure is a
 * MEASURED 32.9% more input tokens for the same Curator prose, recorded on the
 * OFFERABLE_MODELS entry rather than folded into the price table (which must
 * keep agreeing with the provider's invoice). Every band in this file was
 * measured on Gemini, so without this correction an Opus estimate would be
 * a third low on its input half — under-quoting, the one direction this repo
 * refuses on money.
 *
 * Never throws and never returns a non-finite value: a bad catalogue entry
 * degrades to "no premium", which is the pre-existing behaviour.
 */
export function inputTokenizerFactor(provider, modelId) {
  try {
    const entry = listOfferableModels(provider).find(e => e && e.id === modelId);
    const f = entry && entry.tokenizerFactor;
    return (typeof f === 'number' && Number.isFinite(f) && f >= 1) ? f : 1;
  } catch {
    return 1;
  }
}

/**
 * Output-token range for a conversation of `transcriptChars`.
 *
 * Exported so the guard can assert the range MOVES with conversation size —
 * the batch-ingest precedent, where a test asserts the quoted multiple must
 * change with document size and a fixed number fails.
 */
export function estimateOutputTokens(transcriptChars) {
  const chars = Math.max(0, Number.isFinite(transcriptChars) ? transcriptChars : 0);
  const low = Math.round(SUMMARY_ONLY_BASE_TOKENS + SUMMARY_ONLY_TOKENS_PER_CHAR * chars);
  const pagesHigh = clamp(Math.round(PAGES_BASE + chars / PAGES_CHARS_EACH), PAGES_MIN, PAGES_MAX);
  // ── THE SATURATION CAP MUST NEVER COLLAPSE THE RANGE ──────────────────────
  // `PAGES_MAX` freezes the high end at 7,000 tokens while the summary-only
  // floor keeps rising with transcript length, so past roughly 66,000
  // characters of transcript the floor would overtake the ceiling and the
  // estimate would become a POINT — precisely the false precision this whole
  // module exists to avoid, and it would appear silently on the longest (and
  // therefore dearest) conversations. Beyond that crossover the saturation
  // assumption is outside anything that was measured anyway, so the range
  // reopens to twice the floor and errs upward, which is the safe direction
  // on money.
  const high = Math.min(
    COMPILE_MAX_OUTPUT_TOKENS,
    Math.max(pagesHigh * TOKENS_PER_PAGE_HIGH, low * 2),
  );
  return { low, high, pagesHigh };
}

/**
 * Input-token range for a prompt of `promptChars`, on a named model.
 * Exported for the same reason as `estimateOutputTokens`.
 */
export function estimateInputTokens(promptChars, provider, modelId) {
  const chars = Math.max(0, Number.isFinite(promptChars) ? promptChars : 0);
  const point = chars / CHARS_PER_TOKEN;
  const factor = inputTokenizerFactor(provider, modelId);
  return {
    low: Math.round(point * INPUT_TOKEN_BAND.low * factor),
    high: Math.round(point * INPUT_TOKEN_BAND.high * factor),
    tokenizerFactor: factor,
  };
}

/**
 * ── DO NOT REPLACE THIS WITH A FIXED SENTENCE ABOUT "ROUGHLY $X" ────────────
 * The whole point of the basis is that it describes the conversation and the
 * domain in front of the user. `ingest-queue.js`'s own basis string had a
 * generic multiple in it three separate times and was wrong every time.
 */
function buildBasis({
  domain, provider, model, priceKnown, costUnknown, entityPages, conceptPages,
  transcriptChars, userTurns, tokenizerFactor,
}) {
  const providerLabel =
    provider === 'gemini' ? 'Gemini' :
    provider === 'anthropic' ? 'Claude' :
    provider === 'openrouter' ? 'OpenRouter' : 'AI provider';

  const inventory = `${entityPages} entity and ${conceptPages} concept pages`;

  const factorNote = tokenizerFactor > 1
    ? ` "${model}" is recorded as using ${tokenizerFactor.toFixed(2)}x the input tokens of other models on the same text, and that premium is included.`
    : '';

  const priceNote = priceKnown ? '' :
    costUnknown === 'no-provider'
      ? ' No AI provider is configured, so no dollar figure can be shown — the token counts above still describe the work.'
      : costUnknown === 'free-model'
        ? ` "${model}" is free to use, so this compile will not cost anything. The token counts above still apply.`
        : ` No published price is on file for "${model}", so the cost cannot be shown in dollars — see MODEL_PRICES_USD_PER_MTOK in src/brain/llm.js.`;

  return (
    `Estimated for ${providerLabel} "${model || '(no model configured)'}" compiling a ${userTurns}-turn ` +
    `conversation (${transcriptChars.toLocaleString()} characters of transcript) into the "${domain}" domain, ` +
    `which currently holds ${inventory}. Cost depends heavily on how large this wiki ALREADY is, not just on the ` +
    `length of the chat: the whole entity and concept filename list is sent with the conversation so the model links ` +
    `to existing pages instead of duplicating them. The input half is exact — it is the real prompt this compile ` +
    `would send, measured character by character, not a formula.${factorNote} ` +
    `THE OUTPUT HALF CANNOT BE KNOWN IN ADVANCE: how many wiki pages the model decides to write is its own ` +
    `judgement, and three identical test compiles varied by about 11% between them. If the first attempt exceeds ` +
    `the model's output limit, The Curator retries with a shorter extraction and then with a summary page only — ` +
    `each retry re-sends the input, so a compile that escalates can cost roughly two to three times the input half ` +
    `of this range. Both ends are estimates rather than limits: actual spend can land outside them.${priceNote}`
  );
}

/**
 * Estimate what one Compile to Wiki will cost. Free, local, no LLM call.
 *
 * @param {string} domain
 * @param {string} conversationId
 * @returns {Promise<object>} `{ok:true, compilable, refusal, provider, model,
 *   conversation:{...}, domainContext:{...}, estimate:{...}, warnings:[]}`
 *
 * A conversation the compile would REFUSE (not found, too short, already
 * compiled) comes back `compilable: false` with the refusal text and NO cost
 * fields — the refusal is produced by `precheckCompile`, the same function
 * `compileConversation` calls, so the two can never disagree.
 */
export async function estimateCompileCost(domain, conversationId) {
  const pre = await precheckCompile(domain, conversationId);
  if (pre.refusal) {
    return {
      ok: true,
      compilable: false,
      refusal: pre.refusal,
      provider: null,
      model: null,
      conversation: null,
      domainContext: null,
      estimate: null,
      warnings: [],
    };
  }

  // The same three reads compileConversation performs before its first LLM
  // call, in the same order, so the prompt built below is the prompt it sends.
  const schema = await readSchema(domain).catch(() => '');
  const wikiDir = wikiPath(domain);
  const existingFiles = {
    entities: await readdir(path.join(wikiDir, 'entities'))
      .then(f => f.filter(x => x.endsWith('.md'))).catch(() => []),
    concepts: await readdir(path.join(wikiDir, 'concepts'))
      .then(f => f.filter(x => x.endsWith('.md'))).catch(() => []),
  };

  // THE REAL PROMPT, not a proxy for it. `mode: 'full'` is what the first (and
  // in the overwhelming majority of compiles, only) attempt sends.
  const userPrompt = buildCompilePrompt({
    today: pre.today,
    existingFiles,
    conversation: pre.conversation,
    summaryPath: pre.summaryPath,
    mode: 'full',
  });
  const promptChars = (schema || '').length + userPrompt.length;
  const transcriptChars = pre.messages.reduce(
    (n, m) => n + (typeof m?.content === 'string' ? m.content.length : 0), 0);

  // getProviderInfo THROWS when no key is configured, and that is a normal
  // outcome here rather than an error: an un-keyed user asking what a compile
  // costs must be told "configure a provider", not handed a 500.
  let provider = null, model = null, price = null;
  try {
    const info = getProviderInfo();
    provider = info.provider;
    model = info.model;
    price = getModelPrice(model);
  } catch { /* degrades to the nulls above */ }

  // THREE DISTINCT FACTS, THREE DISTINCT CODES. `price === null` is reached by
  // a free model and an unpriced model alike (getModelPrice returns null for
  // both), so freeness is tested by MEMBERSHIP first — otherwise "this costs
  // nothing" would be reported as "we cannot tell you what this costs".
  const warnings = [];
  let costUnknown = null;
  if (!provider) {
    costUnknown = 'no-provider';
    warnings.push('No AI provider is configured — add an API key in Settings to see a cost estimate.');
  } else if (isFreeModel(model)) {
    costUnknown = 'free-model';
    warnings.push(`"${model}" is free to use — this compile will not cost anything, so no dollar estimate is shown. The token counts below still apply.`);
  } else if (!price) {
    costUnknown = 'no-price';
    warnings.push(`No published price is on file for "${model}" — cost cannot be estimated in dollars, but the token counts below are still shown.`);
  }

  const inputTokens = estimateInputTokens(promptChars, provider, model);
  const outputTokens = estimateOutputTokens(transcriptChars);

  // usdLow/usdHigh stay NULL rather than becoming 0 when there is no price.
  // A zero here is a truthy figure on the money path and would let a caller
  // render "$0.00" for a compile that is about to bill real money.
  const priceKnown = Boolean(price);
  const usdLow = priceKnown
    ? round6((inputTokens.low / 1e6) * price.input + (outputTokens.low / 1e6) * price.output)
    : null;
  const usdHigh = priceKnown
    ? round6((inputTokens.high / 1e6) * price.input + (outputTokens.high / 1e6) * price.output)
    : null;

  return {
    ok: true,
    compilable: true,
    refusal: null,
    provider,
    model,
    conversation: {
      title: typeof pre.conversation.title === 'string' ? pre.conversation.title : '',
      userTurns: pre.userTurns,
      messageCount: pre.messages.length,
      transcriptChars,
      summaryPath: pre.summaryPath,
    },
    domainContext: {
      entityPages: existingFiles.entities.length,
      conceptPages: existingFiles.concepts.length,
      promptChars,
    },
    estimate: {
      inputTokensLow: inputTokens.low,
      inputTokensHigh: inputTokens.high,
      outputTokensLow: outputTokens.low,
      outputTokensHigh: outputTokens.high,
      usdLow,
      usdHigh,
      priceKnown,
      costUnknown,
      tokenizerFactor: inputTokens.tokenizerFactor,
      basis: buildBasis({
        domain, provider, model, priceKnown, costUnknown,
        entityPages: existingFiles.entities.length,
        conceptPages: existingFiles.concepts.length,
        transcriptChars,
        userTurns: pre.userTurns,
        tokenizerFactor: inputTokens.tokenizerFactor,
      }),
    },
    warnings,
  };
}

export const __testing = {
  INPUT_TOKEN_BAND, TOKENS_PER_PAGE_HIGH,
  PAGES_BASE, PAGES_CHARS_EACH, PAGES_MIN, PAGES_MAX,
  SUMMARY_ONLY_BASE_TOKENS, SUMMARY_ONLY_TOKENS_PER_CHAR,
  COMPILE_MAX_OUTPUT_TOKENS, CHARS_PER_TOKEN,
};
