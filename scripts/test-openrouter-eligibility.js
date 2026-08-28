#!/usr/bin/env node
/**
 * Offline unit test for src/brain/openrouter-eligibility.js — the pure decision
 * core that decides which OpenRouter catalogue models may be OFFERED, and why.
 *
 * Run:  node scripts/test-openrouter-eligibility.js
 * Exit: 0 if all green; non-zero on any failure. No network, no API key, no fs
 *       reads outside this file, no clock reads.
 *
 * ── HOW THE ASSERTIONS IN HERE WERE WRITTEN ─────────────────────────────────
 *
 * v3.15.0 found SIX guards that could not fail — a 126-case money mirror whose
 * fixture zeroed the very branch carrying the bug, an assertion of the form
 * `f(x) === f(x)`, a cheapest-first control that passed because `null <= 0.017`
 * is true, and a "credential never appears in the URL" check whose fetch spy
 * discarded the url argument.
 *
 * So every assertion below was written by asking: **what input would make this
 * fail, and is that input actually in the corpus?** Where the answer was "no
 * input could", the assertion was deleted or the fixture was extended until an
 * input existed. Sections marked ⟨POSITIVE CONTROL⟩ exist solely to prove the
 * corpus can produce the condition a later assertion denies — without them,
 * "no eligible model does X" is satisfied vacuously by a corpus where nothing
 * does X anywhere.
 *
 * ── THE FIXTURES ────────────────────────────────────────────────────────────
 *
 * REAL_MODELS is 26 records lifted VERBATIM from the live OpenRouter /models
 * catalogue (fetched 2026-08-28; 380 models at 05:09:39Z, 387 by 10:13Z — the
 * catalogue moves within a single day, which is why nothing here asserts an
 * absolute live count), reduced to the fields this module reads. Two
 * reductions, both deliberate:
 *   - `description`, `benchmarks`, `created`, `name`, `architecture.input_*`,
 *     `per_request_limits` and the non-prompt/completion pricing keys are
 *     dropped. The module never reads them; §0 asserts that.
 *   - `supported_parameters` is filtered to the three entries the module reads
 *     (`response_format`, `structured_outputs`, `max_tokens`). An EMPTY array
 *     in the fixture is a real empty array in the source, not a filtering
 *     artefact — `openrouter/fusion` genuinely publishes `[]`.
 *
 * SYNTHETIC_MODELS covers shapes the live catalogue does not contain at model
 * level but which the module must handle: a literal `max_completion_tokens: 0`,
 * a literal `context_length: 0`, an empty-string price, an `alias_target`
 * with neither marker, an inverted price tier, an override carrying BOTH a
 * token tier and a time window (zero live models do; the code path exists), a
 * NULL `top_provider.context_length` behind a passing headline value, and three
 * expiry shapes: a non-empty UNPARSEABLE date, an EMPTY-STRING date, and one
 * already in the past.
 *
 * REAL_ENDPOINTS is the per-endpoint payload for 6 models, verbatim, reduced to
 * the four fields the module reads. It contains the Amazon Bedrock endpoint that
 * publishes `max_completion_tokens: 0`, `context_length: 0` AND no
 * `response_format` — three traps in one real record.
 *
 * ── THE REAL-CATALOGUE FUNNEL (not asserted here; 638 KB will not be committed)
 *
 * Measured against all 387 live models of the 2026-08-28T10:13Z fetch, with a
 * clock injected at 2026-08-28T00:00:00Z:
 *
 *   387 → 329 (json_mode) → 327 (knowable_price) → 314 (not_moving_alias)
 *       → 253 (output_ceiling) → 194 (context_window) → 193 (not_expiring)
 *
 * Both defaults that changed are visible in that funnel, and each was measured
 * SEPARATELY against the same snapshot:
 *
 *   contextField 'context_length' → 'top_provider.context_length'   203 → 194
 *   expiry: risk-flag → reject at a 30-day horizon                   194 → 193
 *
 * The −9 is nine named models: z-ai/glm-5, five qwen3-vl / qwen3-next records,
 * qwen/qwen3-30b-a3b-instruct-2507, google/gemma-3-27b-it and
 * thedrummer/unslopnemo-12b. The −1 is moonshotai/kimi-k2.5.
 *
 * ⚠ WITHOUT a clock — which is the shipped default, since `opts.now` is null —
 * the last stage loses 0 and the answer is 194, not 193. That is asserted in §9
 * rather than left in this comment.
 *
 * NO absolute live count is asserted anywhere in this file. The catalogue grew
 * from 380 to 387 records inside five hours on the day these fixtures were cut;
 * an assertion on 387 would be a test of OpenRouter's roadmap. The 26-record
 * fixture funnel asserted in §9 is a scale model of the shape instead: every
 * stage loses at least one NAMED exemplar, so no stage can silently stop doing
 * anything, and the two changed defaults are each shown to move the fixture
 * funnel in the same direction they move the live one.
 */

import {
  evaluateModel,
  filterCatalogue,
  effectivePriceAt,
  classifyReasoning,
  checkJsonMode,
  checkKnowablePrice,
  checkNotMovingAlias,
  checkOutputCeiling,
  checkContextWindow,
  checkNotExpiring,
  checkTextOutput,
  extractEndpoints,
  parseNumericString,
  finiteNumberOrNull,
  resolveInstant,
  REASON_CODES,
  RISK_CODES,
  REASONING_STATES,
  EXPIRY_STATES,
  CONTEXT_FIELDS,
  RULE_ORDER,
  DEFAULT_ELIGIBILITY_OPTS,
  APP_OUTPUT_FLOOR_TOKENS,
  APP_CONTEXT_FLOOR_TOKENS,
  APP_INGEST_PROMPT_TOKENS_APPROX,
} from '../src/brain/openrouter-eligibility.js';

let passed = 0, failed = 0;
const failures = [];
function ok(cond, label) {
  cond ? (passed++, console.log(`  ✓ ${label}`)) : (failed++, failures.push(label), console.log(`  ✗ ${label}`));
}
function section(t) { console.log(`\n${t}`); }
/** Float-tolerant equality — price maths goes through `x * 1e6`. */
function near(a, b, label, tol = 1e-9) {
  ok(typeof a === 'number' && Math.abs(a - b) < tol, `${label} (got ${a}, expected ~${b})`);
}
const byId = (list, id) => list.find(m => m.id === id);
/**
 * Safe accessors. A mutation that DELETES a rejection leaves `reasons` empty;
 * a bare `reasons[0].code` then throws and aborts the file, so every later
 * assertion silently never runs — a red for the wrong reason, and the exact
 * shape this repo has been bitten by before. These return null instead.
 */
const firstCode = c => (c && c.reasons && c.reasons.length ? c.reasons[0].code : null);
const firstMsg = c => (c && c.reasons && c.reasons.length ? c.reasons[0].message : '');
const riskMsg = (ev, code) => {
  const f = ev.riskFlags.find(r => r.code === code);
  return f ? f.message : '';
};
const codesOf = ev => ev.reasons.map(r => r.code);
const riskCodesOf = ev => ev.riskFlags.map(r => r.code);

// ─────────────────────────────────────────────────────────────────────────────
// FIXTURES — verbatim from the live catalogue, reduced to the read fields.
// ─────────────────────────────────────────────────────────────────────────────

const REAL_MODELS = [
  {"id":"openrouter/fusion","context_length":1000000,"architecture":{"output_modalities":["text"]},"pricing":{"prompt":"-1","completion":"-1"},"top_provider":{"context_length":null,"max_completion_tokens":null},"supported_parameters":[],"expiration_date":null},
  {"id":"openrouter/auto","context_length":2000000,"architecture":{"output_modalities":["text","image"]},"pricing":{"prompt":"-1","completion":"-1"},"top_provider":{"context_length":null,"max_completion_tokens":null},"supported_parameters":["max_tokens","response_format","structured_outputs"],"expiration_date":null},
  {"id":"openrouter/free","context_length":200000,"architecture":{"output_modalities":["text"]},"pricing":{"prompt":"0","completion":"0"},"top_provider":{"context_length":null,"max_completion_tokens":null},"supported_parameters":["max_tokens","response_format","structured_outputs"],"expiration_date":null},
  {"id":"openai/gpt-chat-latest","context_length":400000,"architecture":{"output_modalities":["text"]},"pricing":{"prompt":"0.000005","completion":"0.00003"},"top_provider":{"context_length":400000,"max_completion_tokens":128000},"supported_parameters":["max_tokens","response_format","structured_outputs"],"expiration_date":null},
  {"id":"~anthropic/claude-haiku-latest","context_length":200000,"architecture":{"output_modalities":["text"]},"pricing":{"prompt":"0.000001","completion":"0.000005"},"top_provider":{"context_length":200000,"max_completion_tokens":64000},"supported_parameters":["max_tokens","response_format","structured_outputs"],"expiration_date":null,"reasoning":{"mandatory":false},"alias_target":{"name":"Anthropic: Claude Haiku 4.5","slug":"anthropic/claude-haiku-4.5"}},
  {"id":"anthropic/claude-haiku-4.5","context_length":200000,"architecture":{"output_modalities":["text"]},"pricing":{"prompt":"0.000001","completion":"0.000005"},"top_provider":{"context_length":200000,"max_completion_tokens":64000},"supported_parameters":["max_tokens","response_format","structured_outputs"],"expiration_date":null,"reasoning":{"mandatory":false}},
  {"id":"upstage/solar-pro4","context_length":524288,"architecture":{"output_modalities":["text"]},"pricing":{"prompt":"0.00000003","completion":"0.00000012"},"top_provider":{"context_length":524288,"max_completion_tokens":131072},"supported_parameters":["max_tokens","response_format","structured_outputs"],"expiration_date":null,"reasoning":{"mandatory":false}},
  {"id":"nex-agi/nex-n2-mini","context_length":262144,"architecture":{"output_modalities":["text"]},"pricing":{"prompt":"0.000000025","completion":"0.0000001"},"top_provider":{"context_length":262144,"max_completion_tokens":235929},"supported_parameters":["max_tokens","response_format","structured_outputs"],"expiration_date":null,"reasoning":{"mandatory":false}},
  {"id":"qwen/qwen3.7-flash","context_length":1000000,"architecture":{"output_modalities":["text"]},"pricing":{"prompt":"0.00000003","completion":"0.00000013","overrides":[{"min_prompt_tokens":32000,"prompt":"0.0000001","completion":"0.0000004"},{"min_prompt_tokens":256000,"prompt":"0.0000002","completion":"0.0000008"}]},"top_provider":{"context_length":1000000,"max_completion_tokens":65536},"supported_parameters":["max_tokens","response_format"],"expiration_date":null,"reasoning":{"mandatory":false,"default_enabled":true,"supports_max_tokens":true}},
  {"id":"minimax/minimax-m3:free","context_length":1048576,"architecture":{"output_modalities":["text"]},"pricing":{"prompt":"0","completion":"0"},"top_provider":{"context_length":1048576,"max_completion_tokens":943718},"supported_parameters":["max_tokens","response_format"],"expiration_date":null,"reasoning":{"mandatory":false}},
  {"id":"ibm-granite/granite-4.0-h-micro","context_length":131000,"architecture":{"output_modalities":["text"]},"pricing":{"prompt":"0.000000017","completion":"0.000000112"},"top_provider":{"context_length":131000,"max_completion_tokens":117900},"supported_parameters":["max_tokens","response_format"],"expiration_date":null},
  {"id":"moonshotai/kimi-k2.5","context_length":262144,"architecture":{"output_modalities":["text"]},"pricing":{"prompt":"0.0000006","completion":"0.000003"},"top_provider":{"context_length":262144,"max_completion_tokens":235929},"supported_parameters":["max_tokens","response_format","structured_outputs"],"expiration_date":"2026-08-31","reasoning":{"mandatory":false,"default_enabled":true}},
  {"id":"thedrummer/unslopnemo-12b","context_length":1024000,"architecture":{"output_modalities":["text"]},"pricing":{"prompt":"0.0000004","completion":"0.0000004"},"top_provider":{"context_length":32768,"max_completion_tokens":26214},"supported_parameters":["max_tokens","response_format","structured_outputs"],"expiration_date":null},
  {"id":"tencent/hy3","context_length":262144,"architecture":{"output_modalities":["text"]},"pricing":{"prompt":"0.000000132","completion":"0.000000528","overrides":[{"utc_start":0,"utc_end":1600,"prompt":"0.000000132","completion":"0.000000528"},{"utc_start":1600,"utc_end":0,"prompt":"0.0000000825","completion":"0.00000033"}]},"top_provider":{"context_length":262144,"max_completion_tokens":128000},"supported_parameters":["max_tokens","response_format","structured_outputs"],"expiration_date":null,"reasoning":{"mandatory":false,"default_enabled":true,"supported_efforts":["high","low","none"],"default_effort":"high"}},
  {"id":"deepseek/deepseek-v4-pro-0813","context_length":1048576,"architecture":{"output_modalities":["text"]},"pricing":{"prompt":"0.00000066","completion":"0.00000198","overrides":[{"utc_days":["saturday","sunday"],"prompt":"0.00000066","completion":"0.00000198"},{"utc_days":["monday","tuesday","wednesday","thursday","friday"],"utc_start":0,"utc_end":100,"prompt":"0.00000066","completion":"0.00000198"},{"utc_days":["monday","tuesday","wednesday","thursday","friday"],"utc_start":100,"utc_end":400,"prompt":"0.00000132","completion":"0.00000396"},{"utc_days":["monday","tuesday","wednesday","thursday","friday"],"utc_start":400,"utc_end":600,"prompt":"0.00000066","completion":"0.00000198"},{"utc_days":["monday","tuesday","wednesday","thursday","friday"],"utc_start":600,"utc_end":1000,"prompt":"0.00000132","completion":"0.00000396"},{"utc_days":["monday","tuesday","wednesday","thursday","friday"],"utc_start":1000,"utc_end":0,"prompt":"0.00000066","completion":"0.00000198"}]},"top_provider":{"context_length":1048576,"max_completion_tokens":384000},"supported_parameters":["max_tokens","response_format","structured_outputs"],"expiration_date":null,"reasoning":{"mandatory":false,"supported_efforts":["max","high","low"],"default_effort":"high"}},
  {"id":"openai/gpt-5.1-codex","context_length":400000,"architecture":{"output_modalities":["text"]},"pricing":{"prompt":"0.00000125","completion":"0.00001"},"top_provider":{"context_length":400000,"max_completion_tokens":128000},"supported_parameters":["response_format","structured_outputs"],"expiration_date":null,"reasoning":{"mandatory":true,"supported_efforts":["high","medium","low"],"default_effort":"medium"}},
  {"id":"nvidia/nemotron-3-ultra-550b-a55b","context_length":262144,"architecture":{"output_modalities":["text"]},"pricing":{"prompt":"0.0000005","completion":"0.0000022"},"top_provider":{"context_length":262144,"max_completion_tokens":16384},"supported_parameters":["max_tokens","response_format","structured_outputs"],"expiration_date":null,"reasoning":{"mandatory":false,"default_enabled":true,"supports_max_tokens":true,"supported_efforts":["high","medium"],"default_effort":"high"}},
  {"id":"inclusionai/ling-3.0-flash-fin:free","context_length":262144,"architecture":{"output_modalities":["text"]},"pricing":{"prompt":"0","completion":"0"},"top_provider":{"context_length":262144,"max_completion_tokens":32768},"supported_parameters":["max_tokens"],"expiration_date":null,"reasoning":{"mandatory":false,"default_enabled":true}},
  {"id":"meta-llama/llama-3.3-70b-instruct","context_length":131072,"architecture":{"output_modalities":["text"]},"pricing":{"prompt":"0.00000071","completion":"0.00000071"},"top_provider":{"context_length":128000,"max_completion_tokens":115200},"supported_parameters":["max_tokens","response_format","structured_outputs"],"expiration_date":null},
  {"id":"qwen/qwen3-coder-30b-a3b-instruct","context_length":262144,"architecture":{"output_modalities":["text"]},"pricing":{"prompt":"0.00000007","completion":"0.00000028"},"top_provider":{"context_length":262144,"max_completion_tokens":235929},"supported_parameters":["max_tokens","response_format","structured_outputs"],"expiration_date":null},
  {"id":"deepseek/deepseek-v4-flash-0731","context_length":1310720,"architecture":{"output_modalities":["text"]},"pricing":{"prompt":"0.00000006","completion":"0.00000012"},"top_provider":{"context_length":1048576,"max_completion_tokens":943718},"supported_parameters":["max_tokens","response_format","structured_outputs"],"expiration_date":null,"reasoning":{"mandatory":false,"default_enabled":true,"supported_efforts":["max","high","low"],"default_effort":"high"}},
  {"id":"qwen/qwen3-30b-a3b-instruct-2507","context_length":262144,"architecture":{"output_modalities":["text"]},"pricing":{"prompt":"0.00000004815","completion":"0.00000019305"},"top_provider":{"context_length":128000,"max_completion_tokens":32000},"supported_parameters":["max_tokens","response_format","structured_outputs"],"expiration_date":null},
  {"id":"bytedance-seed/seed-2.0-mini","context_length":262144,"architecture":{"output_modalities":["text"]},"pricing":{"prompt":"0.0000001","completion":"0.0000004","overrides":[{"min_prompt_tokens":128000,"prompt":"0.0000002","completion":"0.0000008"}]},"top_provider":{"context_length":262144,"max_completion_tokens":131072},"supported_parameters":["max_tokens","response_format","structured_outputs"],"expiration_date":null,"reasoning":{"mandatory":false,"supported_efforts":["high","medium","low","minimal"],"default_effort":"medium"}},
  // 2098-12-31 — five live z-ai models publish this. It is a SENTINEL meaning
  // "no planned retirement", not a retirement date. Without this record the
  // sentinel branch would be untestable and the 30-day horizon would look
  // safe purely because nothing in the corpus could reach the far-future path.
  {"id":"z-ai/glm-5.3-flash","context_length":1310720,"architecture":{"output_modalities":["text"]},"pricing":{"prompt":"0.000000075","completion":"0.00000025"},"top_provider":{"context_length":1048576,"max_completion_tokens":131072},"supported_parameters":["max_tokens","response_format","structured_outputs"],"expiration_date":"2098-12-31","reasoning":{"mandatory":true,"default_enabled":true,"supported_efforts":["max","high","low"],"default_effort":"max"}},
  // A REAL expiry 33 days after the snapshot: it clears the 30-day horizon by
  // three days. The knife edge, in the corpus, so "the horizon rejects" cannot
  // be satisfied by a corpus in which every dated model is imminent.
  {"id":"dots-studio/dots-3-note-preview:free","context_length":512000,"architecture":{"output_modalities":["text"]},"pricing":{"prompt":"0","completion":"0"},"top_provider":{"context_length":512000,"max_completion_tokens":460800},"supported_parameters":["max_tokens","response_format","structured_outputs"],"expiration_date":"2026-09-30","reasoning":{"mandatory":false}},
  {"id":"z-ai/glm-5.2:free","context_length":256000,"architecture":{"output_modalities":["text"]},"pricing":{"prompt":"0","completion":"0"},"top_provider":{"context_length":256000,"max_completion_tokens":230400},"supported_parameters":["max_tokens","response_format","structured_outputs"],"expiration_date":null,"reasoning":{"mandatory":false,"default_enabled":true,"supported_efforts":["xhigh","high"],"default_effort":"high"}},
];

const REAL_ENDPOINTS = {
  "meta-llama/llama-3.3-70b-instruct": [
    {"provider_name":"DeepInfra","max_completion_tokens":16384,"context_length":131072,"supported_parameters":["max_tokens","response_format"]},
    {"provider_name":"Nebius","max_completion_tokens":117964,"context_length":131072,"supported_parameters":["max_tokens","response_format"]},
    {"provider_name":"Novita","max_completion_tokens":11059,"context_length":12288,"supported_parameters":["max_tokens","response_format"]},
    {"provider_name":"AkashML","max_completion_tokens":128000,"context_length":131072,"supported_parameters":["max_tokens","response_format"]},
    {"provider_name":"Parasail","max_completion_tokens":16384,"context_length":131072,"supported_parameters":["max_tokens","response_format"]},
    {"provider_name":"Crusoe","max_completion_tokens":117964,"context_length":131072,"supported_parameters":["max_tokens","response_format"]},
    {"provider_name":"Cloudflare","max_completion_tokens":21600,"context_length":24000,"supported_parameters":["max_tokens","response_format"]},
    {"provider_name":"SambaNova","max_completion_tokens":3072,"context_length":131072,"supported_parameters":["max_tokens","response_format"]},
    {"provider_name":"Groq","max_completion_tokens":32768,"context_length":131072,"supported_parameters":["max_tokens","response_format"]},
    {"provider_name":"CoreWeave","max_completion_tokens":115200,"context_length":128000,"supported_parameters":["response_format","max_tokens"]},
    {"provider_name":"Google","max_completion_tokens":8192,"context_length":128000,"supported_parameters":["response_format","max_tokens"]},
    {"provider_name":"Google","max_completion_tokens":115200,"context_length":128000,"supported_parameters":["max_tokens","response_format"]},
    {"provider_name":"Together","max_completion_tokens":2048,"context_length":131072,"supported_parameters":["response_format","max_tokens"]},
  ],
  "qwen/qwen3-coder-30b-a3b-instruct": [
    {"provider_name":"Novita","max_completion_tokens":32768,"context_length":160000,"supported_parameters":["max_tokens","response_format"]},
    {"provider_name":"SiliconFlow","max_completion_tokens":235929,"context_length":262144,"supported_parameters":["response_format","max_tokens"]},
    {"provider_name":"Amazon Bedrock","max_completion_tokens":0,"context_length":0,"supported_parameters":["max_tokens"]},
    {"provider_name":"Alibaba","max_completion_tokens":65536,"context_length":262144,"supported_parameters":["max_tokens","response_format"]},
  ],
  "deepseek/deepseek-v4-flash-0731": [
    {"provider_name":"OpenInference","max_completion_tokens":131072,"context_length":1048576,"supported_parameters":["max_tokens","response_format"]},
    {"provider_name":"Relace","max_completion_tokens":943718,"context_length":1048576,"supported_parameters":["max_tokens"]},
    {"provider_name":"DeepInfra","max_completion_tokens":384000,"context_length":1048576,"supported_parameters":["max_tokens","response_format"]},
    {"provider_name":"Ambient","max_completion_tokens":943718,"context_length":1048576,"supported_parameters":["max_tokens","response_format"]},
    {"provider_name":"Makora","max_completion_tokens":384000,"context_length":1000000,"supported_parameters":["response_format","max_tokens"]},
    {"provider_name":"Morph","max_completion_tokens":943718,"context_length":1048576,"supported_parameters":["max_tokens","response_format"]},
    {"provider_name":"GMICloud","max_completion_tokens":943717,"context_length":1048575,"supported_parameters":["max_tokens","response_format"]},
    {"provider_name":"BaseTen","max_completion_tokens":384000,"context_length":1048576,"supported_parameters":["max_tokens"]},
    {"provider_name":"Inceptron","max_completion_tokens":943718,"context_length":1048576,"supported_parameters":["max_tokens","response_format"]},
    {"provider_name":"CoreWeave","max_completion_tokens":235929,"context_length":262144,"supported_parameters":["max_tokens"]},
    {"provider_name":"Baidu","max_completion_tokens":131072,"context_length":1048576,"supported_parameters":["max_tokens","response_format"]},
    {"provider_name":"AkashML","max_completion_tokens":943718,"context_length":1048576,"supported_parameters":["max_tokens","response_format"]},
    {"provider_name":"Parasail","max_completion_tokens":943718,"context_length":1048576,"supported_parameters":["max_tokens","response_format"]},
    {"provider_name":"Together","max_completion_tokens":943718,"context_length":1048576,"supported_parameters":["max_tokens","response_format"]},
    {"provider_name":"DigitalOcean","max_completion_tokens":943718,"context_length":1048576,"supported_parameters":["max_tokens","response_format"]},
    {"provider_name":"Mancer 2","max_completion_tokens":943718,"context_length":1048576,"supported_parameters":["max_tokens","response_format"]},
    {"provider_name":"Venice","max_completion_tokens":32768,"context_length":1000000,"supported_parameters":["max_tokens","response_format"]},
    {"provider_name":"DeepSeek","max_completion_tokens":384000,"context_length":1048576,"supported_parameters":["max_tokens","response_format"]},
    {"provider_name":"StreamLake","max_completion_tokens":384000,"context_length":1024000,"supported_parameters":["response_format","max_tokens"]},
    {"provider_name":"Fireworks","max_completion_tokens":943718,"context_length":1048576,"supported_parameters":["max_tokens","response_format"]},
    {"provider_name":"Reka","max_completion_tokens":131072,"context_length":262144,"supported_parameters":["max_tokens","response_format"]},
    {"provider_name":"Phala","max_completion_tokens":393216,"context_length":1048576,"supported_parameters":["max_tokens","response_format"]},
    {"provider_name":"SiliconFlow","max_completion_tokens":393216,"context_length":1048576,"supported_parameters":["max_tokens","response_format"]},
    {"provider_name":"Wafer","max_completion_tokens":943718,"context_length":1048576,"supported_parameters":["max_tokens","response_format"]},
    {"provider_name":"Alibaba","max_completion_tokens":393216,"context_length":1000000,"supported_parameters":["max_tokens","response_format"]},
    {"provider_name":"Novita","max_completion_tokens":393216,"context_length":1048576,"supported_parameters":["max_tokens","response_format"]},
    {"provider_name":"NextBit","max_completion_tokens":943718,"context_length":1048576,"supported_parameters":["max_tokens","response_format"]},
    {"provider_name":"AtlasCloud","max_completion_tokens":393216,"context_length":1048576,"supported_parameters":["max_tokens","response_format"]},
    {"provider_name":"Cloudflare","max_completion_tokens":1179648,"context_length":1310720,"supported_parameters":["max_tokens","response_format"]},
  ],
  "upstage/solar-pro4": [
    {"provider_name":"Upstage","max_completion_tokens":131072,"context_length":524288,"supported_parameters":["max_tokens","response_format"]},
    {"provider_name":"Upstage","max_completion_tokens":131072,"context_length":524288,"supported_parameters":["max_tokens","response_format"]},
  ],
  "qwen/qwen3-30b-a3b-instruct-2507": [
    {"provider_name":"StreamLake","max_completion_tokens":32000,"context_length":128000,"supported_parameters":["response_format","max_tokens"]},
    {"provider_name":"SiliconFlow","max_completion_tokens":235929,"context_length":262144,"supported_parameters":["response_format","max_tokens"]},
    {"provider_name":"CoreWeave","max_completion_tokens":235929,"context_length":262144,"supported_parameters":["max_tokens","response_format"]},
    {"provider_name":"Nebius","max_completion_tokens":235929,"context_length":262144,"supported_parameters":["max_tokens","response_format"]},
    {"provider_name":"Alibaba","max_completion_tokens":32768,"context_length":131072,"supported_parameters":["max_tokens","response_format"]},
  ],
  "bytedance-seed/seed-2.0-mini": [
    {"provider_name":"Seed","max_completion_tokens":131072,"context_length":262144,"supported_parameters":["max_tokens","response_format"]},
  ],
};

/** Shapes the live catalogue lacks at model level but the module must handle. */
const SYNTHETIC_MODELS = [
  // A literal zero output ceiling: key PRESENT, value 0. Real at endpoint level
  // (Amazon Bedrock); synthesised here at model level. Must NOT read as "unknown".
  { id: 'synthetic/zero-output-ceiling', context_length: 400000, architecture: { output_modalities: ['text'] },
    pricing: { prompt: '0.000001', completion: '0.000002' },
    top_provider: { context_length: 400000, max_completion_tokens: 0 },
    supported_parameters: ['max_tokens', 'response_format'], expiration_date: null },
  // A literal zero context window.
  { id: 'synthetic/zero-context', context_length: 0, architecture: { output_modalities: ['text'] },
    pricing: { prompt: '0.000001', completion: '0.000002' },
    top_provider: { context_length: 0, max_completion_tokens: 100000 },
    supported_parameters: ['max_tokens', 'response_format'], expiration_date: null },
  // An empty-string price. `Number('')` is 0; a free model publishes "0".
  // These two must NEVER produce the same result.
  { id: 'synthetic/empty-string-price', context_length: 400000, architecture: { output_modalities: ['text'] },
    pricing: { prompt: '', completion: '0.000002' },
    top_provider: { context_length: 400000, max_completion_tokens: 100000 },
    supported_parameters: ['max_tokens', 'response_format'], expiration_date: null },
  // alias_target declared with NEITHER a ~ prefix NOR a -latest suffix, so the
  // third alias signal is the only one that can fire. Without this record that
  // predicate would be untestable — every live alias_target model also has both
  // other markers, so an assertion on it would be decoration.
  { id: 'synthetic/quiet-alias', context_length: 400000, architecture: { output_modalities: ['text'] },
    pricing: { prompt: '0.000001', completion: '0.000002' },
    top_provider: { context_length: 400000, max_completion_tokens: 100000 },
    supported_parameters: ['max_tokens', 'response_format'], expiration_date: null,
    alias_target: { name: 'Something Else', slug: 'vendor/something-else' } },
  // An INVERTED tier: dearer below the threshold, cheaper above. Proves the MAX
  // rule under an unknown prompt size is a real max and not "pick the last tier".
  { id: 'synthetic/inverted-tier', context_length: 400000, architecture: { output_modalities: ['text'] },
    pricing: { prompt: '0.000002', completion: '0.000004',
      overrides: [{ min_prompt_tokens: 50000, prompt: '0.0000005', completion: '0.000001' }] },
    top_provider: { context_length: 400000, max_completion_tokens: 100000 },
    supported_parameters: ['max_tokens', 'response_format'], expiration_date: null },
  // An override carrying BOTH a token tier and a time window. Zero live models
  // do; the code path exists and must not silently mis-apply.
  { id: 'synthetic/tier-and-time', context_length: 400000, architecture: { output_modalities: ['text'] },
    pricing: { prompt: '0.000001', completion: '0.000002',
      overrides: [{ min_prompt_tokens: 50000, utc_days: ['monday'], utc_start: 0, utc_end: 1200,
        prompt: '0.000009', completion: '0.00001' }] },
    top_provider: { context_length: 400000, max_completion_tokens: 100000 },
    supported_parameters: ['max_tokens', 'response_format'], expiration_date: null },
  // An expiration_date that is a NON-EMPTY string but not a date. Before the
  // six-state rewrite this produced NO risk at all and was byte-indistinguishable
  // from a model that declared nothing — the fact-and-its-absence collapse,
  // inside the rule written to catch expiries. No live model publishes this.
  { id: 'synthetic/malformed-expiry', context_length: 400000, architecture: { output_modalities: ['text'] },
    pricing: { prompt: '0.000001', completion: '0.000002' },
    top_provider: { context_length: 400000, max_completion_tokens: 100000 },
    supported_parameters: ['max_tokens', 'response_format'], expiration_date: 'soon' },
  // An EMPTY-STRING expiration_date. `Date.parse('')` is NaN, same as 'soon' —
  // but an empty string is not a declaration, so it must read ABSENT, not
  // MALFORMED. Without this record the two would be one branch.
  { id: 'synthetic/empty-string-expiry', context_length: 400000, architecture: { output_modalities: ['text'] },
    pricing: { prompt: '0.000001', completion: '0.000002' },
    top_provider: { context_length: 400000, max_completion_tokens: 100000 },
    supported_parameters: ['max_tokens', 'response_format'], expiration_date: '' },
  // Already dead relative to the snapshot clock. "It will stop working" and
  // "it has stopped working" are different facts and get different codes.
  { id: 'synthetic/already-expired', context_length: 400000, architecture: { output_modalities: ['text'] },
    pricing: { prompt: '0.000001', completion: '0.000002' },
    top_provider: { context_length: 400000, max_completion_tokens: 100000 },
    supported_parameters: ['max_tokens', 'response_format'], expiration_date: '2026-01-01' },
  // A context window that clears the floor on the HEADLINE field and fails on
  // top_provider — the shape the default field change is about, synthesised
  // with a null top_provider value so the null-vs-below-floor distinction is
  // testable on the GOVERNING field rather than only on the headline one.
  { id: 'synthetic/null-top-provider-context', context_length: 400000, architecture: { output_modalities: ['text'] },
    pricing: { prompt: '0.000001', completion: '0.000002' },
    top_provider: { context_length: null, max_completion_tokens: 100000 },
    supported_parameters: ['max_tokens', 'response_format'], expiration_date: null },
  // Emits no text at all.
  { id: 'synthetic/image-only-output', context_length: 400000, architecture: { output_modalities: ['image'] },
    pricing: { prompt: '0.000001', completion: '0.000002' },
    top_provider: { context_length: 400000, max_completion_tokens: 100000 },
    supported_parameters: ['max_tokens', 'response_format'], expiration_date: null },
];

/** An instant with a known UTC weekday and hour, for time-window pricing. */
const MON_08_00 = '2026-08-31T08:00:00Z';   // Monday 08:00 UTC
const MON_18_00 = '2026-08-31T18:00:00Z';   // Monday 18:00 UTC
const TUE_02_00 = '2026-09-01T02:00:00Z';   // Tuesday 02:00 UTC
const SAT_02_00 = '2026-09-05T02:00:00Z';   // Saturday 02:00 UTC
const SNAPSHOT_DAY = '2026-08-28T00:00:00Z';

console.log('OpenRouter eligibility — offline decision-core suite');

// ─────────────────────────────────────────────────────────────────────────────
section('0. Fixture integrity — the corpus can actually exercise every rule');
// Without this section every "no eligible model does X" assertion below could be
// vacuously true. These are the positive controls for the whole file.
// ─────────────────────────────────────────────────────────────────────────────

ok(REAL_MODELS.length === 26, `REAL_MODELS carries 26 verbatim records (got ${REAL_MODELS.length})`);
// Positive controls for the three expiry states the rule now distinguishes.
// Without these, "the sentinel does not reject" and "a near date rejects" could
// both be satisfied by a corpus in which neither shape exists.
ok(REAL_MODELS.filter(m => m.expiration_date === null).length >= 15,
  '⟨POSITIVE CONTROL⟩ corpus is mostly models that declare NO expiry');
ok(REAL_MODELS.some(m => m.expiration_date === '2026-08-31'),
  '⟨POSITIVE CONTROL⟩ corpus contains a REAL near expiry (3 days out)');
ok(REAL_MODELS.some(m => m.expiration_date === '2026-09-30'),
  '⟨POSITIVE CONTROL⟩ corpus contains a REAL expiry just OUTSIDE the 30-day horizon (33 days)');
ok(REAL_MODELS.some(m => m.expiration_date === '2098-12-31'),
  '⟨POSITIVE CONTROL⟩ corpus contains the far-future 2098 SENTINEL');
ok(SYNTHETIC_MODELS.some(m => m.expiration_date === 'soon'),
  '⟨POSITIVE CONTROL⟩ corpus contains a non-empty UNPARSEABLE expiration_date');
ok(SYNTHETIC_MODELS.some(m => m.expiration_date === ''),
  '⟨POSITIVE CONTROL⟩ corpus contains an EMPTY-STRING expiration_date (distinct from unparseable)');
ok(SYNTHETIC_MODELS.some(m => m.expiration_date === '2026-01-01'),
  '⟨POSITIVE CONTROL⟩ corpus contains an ALREADY-PAST expiration_date');
// Positive control for the context-field change: the corpus must contain models
// that DISAGREE across the two fields in BOTH directions relative to the floor,
// or the field switch could not be shown to matter.
ok(REAL_MODELS.some(m => m.context_length >= APP_CONTEXT_FLOOR_TOKENS
    && m.top_provider.context_length !== null && m.top_provider.context_length < APP_CONTEXT_FLOOR_TOKENS),
  '⟨POSITIVE CONTROL⟩ corpus contains a model that STRADDLES the floor across the two context fields');
ok(REAL_MODELS.some(m => m.top_provider.context_length !== null
    && m.context_length !== m.top_provider.context_length
    && m.top_provider.context_length >= APP_CONTEXT_FLOOR_TOKENS),
  '⟨POSITIVE CONTROL⟩ …and one that disagrees while clearing the floor on BOTH');
ok(REAL_MODELS.some(m => Array.isArray(m.supported_parameters) && m.supported_parameters.length === 0),
  '⟨POSITIVE CONTROL⟩ corpus contains a model with supported_parameters === [] (empty array, not absent)');
ok(REAL_MODELS.some(m => m.pricing.prompt === '-1'),
  '⟨POSITIVE CONTROL⟩ corpus contains a model priced "-1"');
ok(REAL_MODELS.some(m => m.top_provider.max_completion_tokens === null),
  '⟨POSITIVE CONTROL⟩ corpus contains a model with max_completion_tokens === null');
ok(SYNTHETIC_MODELS.some(m => m.top_provider.max_completion_tokens === 0),
  '⟨POSITIVE CONTROL⟩ corpus contains a model with max_completion_tokens === 0 (literal zero)');
ok(REAL_MODELS.some(m => /-latest$/.test(m.id) && !m.id.startsWith('~')),
  '⟨POSITIVE CONTROL⟩ corpus contains a -latest id WITHOUT a ~ prefix');
ok(REAL_MODELS.some(m => m.id.startsWith('~')),
  '⟨POSITIVE CONTROL⟩ corpus contains a ~-prefixed id');
ok(SYNTHETIC_MODELS.some(m => m.alias_target && !m.id.startsWith('~') && !/-latest$/.test(m.id)),
  '⟨POSITIVE CONTROL⟩ corpus contains an alias_target with NEITHER other marker');
ok(REAL_MODELS.some(m => Array.isArray(m.pricing.overrides) && m.pricing.overrides.some(o => 'min_prompt_tokens' in o)),
  '⟨POSITIVE CONTROL⟩ corpus contains a token-tiered price');
ok(REAL_MODELS.some(m => Array.isArray(m.pricing.overrides) && m.pricing.overrides.some(o => 'utc_start' in o)),
  '⟨POSITIVE CONTROL⟩ corpus contains a UTC time-windowed price');
ok(REAL_MODELS.some(m => m.pricing.prompt === '0'),
  '⟨POSITIVE CONTROL⟩ corpus contains a genuinely FREE model (price "0")');
ok(REAL_MODELS.some(m => m.expiration_date !== null),
  '⟨POSITIVE CONTROL⟩ corpus contains a model declaring an expiration_date');
ok(REAL_MODELS.some(m => m.context_length !== m.top_provider.context_length),
  '⟨POSITIVE CONTROL⟩ corpus contains a model whose two context fields DISAGREE');
ok(Object.values(REAL_ENDPOINTS).some(eps => eps.some(e => e.max_completion_tokens === 0)),
  '⟨POSITIVE CONTROL⟩ endpoint corpus contains a real endpoint publishing max_completion_tokens === 0');
ok(Object.values(REAL_ENDPOINTS).some(eps => eps.some(e => !e.supported_parameters.includes('response_format'))),
  '⟨POSITIVE CONTROL⟩ endpoint corpus contains a real endpoint WITHOUT response_format');
ok(Object.values(REAL_ENDPOINTS).some(eps =>
    eps.some(e => e.max_completion_tokens < APP_OUTPUT_FLOOR_TOKENS)
    && eps.some(e => e.max_completion_tokens >= APP_OUTPUT_FLOOR_TOKENS)),
  '⟨POSITIVE CONTROL⟩ endpoint corpus contains a model straddling the output floor');

// The module must not read fields the fixture dropped, or the fixture would be
// silently testing a different object than production sees.
const evSolar = evaluateModel(byId(REAL_MODELS, 'upstage/solar-pro4'));
ok(evSolar.eligible === true, 'a reduced fixture record still evaluates (no dropped field is load-bearing)');

// ─────────────────────────────────────────────────────────────────────────────
section('1. Coercion helpers — a fact and its absence must never collapse');
// The eight-places defect: `Number('')` is 0, `Number(null)` is 0, and '' is a
// substring of everything. Each of these has a failing input in the corpus.
// ─────────────────────────────────────────────────────────────────────────────

ok(parseNumericString('') === null, "parseNumericString('') is null, NOT 0");
ok(parseNumericString('   ') === null, "parseNumericString('   ') is null, NOT 0");
ok(parseNumericString(null) === null, 'parseNumericString(null) is null, NOT 0');
ok(parseNumericString(undefined) === null, 'parseNumericString(undefined) is null, NOT 0');
ok(parseNumericString(false) === null, 'parseNumericString(false) is null, NOT 0');
ok(parseNumericString([]) === null, 'parseNumericString([]) is null, NOT 0 (Number([]) is 0)');
ok(parseNumericString('abc') === null, "parseNumericString('abc') is null");
ok(parseNumericString('0') === 0, "parseNumericString('0') is 0 — free IS a known price");
ok(parseNumericString('-1') === -1, "parseNumericString('-1') is -1 — the sentinel parses");
near(parseNumericString('0.00000003'), 3e-8, 'parseNumericString parses a real price string');

ok(finiteNumberOrNull(null) === null, 'finiteNumberOrNull(null) is null, NOT 0');
ok(finiteNumberOrNull(undefined) === null, 'finiteNumberOrNull(undefined) is null');
ok(finiteNumberOrNull('5') === null, "finiteNumberOrNull('5') is null — no string coercion");
ok(finiteNumberOrNull(NaN) === null, 'finiteNumberOrNull(NaN) is null');
ok(finiteNumberOrNull(Infinity) === null, 'finiteNumberOrNull(Infinity) is null');
ok(finiteNumberOrNull(0) === 0, 'finiteNumberOrNull(0) is 0 — a real zero survives');

ok(resolveInstant(null) === null, 'resolveInstant(null) is null — the clock is unknown');
ok(resolveInstant('not a date') === null, 'resolveInstant of garbage is null');
ok(resolveInstant(new Date('nope')) === null, 'resolveInstant of an Invalid Date is null');
ok(resolveInstant(MON_08_00) === Date.parse(MON_08_00), 'resolveInstant parses an ISO string');
ok(resolveInstant(1_700_000_000_000) === 1_700_000_000_000, 'resolveInstant accepts epoch ms');

// ─────────────────────────────────────────────────────────────────────────────
section('2. Rule 1 — JSON mode, with "unsupported" distinct from "unknown"');
// ─────────────────────────────────────────────────────────────────────────────

const fusion = byId(REAL_MODELS, 'openrouter/fusion');
const jFusion = checkJsonMode(fusion, {});
ok(jFusion.pass === false, 'openrouter/fusion (supported_parameters: []) fails JSON mode');
ok(firstCode(jFusion) === REASON_CODES.JSON_MODE_UNSUPPORTED,
  'an EMPTY array is JSON_MODE_UNSUPPORTED — a positive statement, not an absence');
ok(jFusion.facts.responseFormat === false, 'facts.responseFormat is false (we were told), not null');

const noParams = { id: 'x/no-params', context_length: 400000, pricing: { prompt: '1', completion: '1' },
  top_provider: { context_length: 400000, max_completion_tokens: 100000 } };
const jNone = checkJsonMode(noParams, {});
ok(jNone.pass === false, 'a record with NO supported_parameters key fails JSON mode');
ok(firstCode(jNone) === REASON_CODES.JSON_MODE_UNKNOWN,
  'an ABSENT key is JSON_MODE_UNKNOWN — a DIFFERENT code from an empty array');
ok(jNone.facts.responseFormat === null, 'facts.responseFormat is null (we were not told), not false');
ok(REASON_CODES.JSON_MODE_UNKNOWN !== REASON_CODES.JSON_MODE_UNSUPPORTED,
  'the two codes are genuinely distinct values');

const ling = byId(REAL_MODELS, 'inclusionai/ling-3.0-flash-fin:free');
ok(checkJsonMode(ling, {}).pass === false,
  'a real model lacking response_format fails (it passes every OTHER rule, so this is the sole cause)');
ok(evaluateModel(ling).reasons.every(r => r.rule === 'json_mode'),
  '…and json_mode is indeed its ONLY failing rule');

ok(checkJsonMode(byId(REAL_MODELS, 'upstage/solar-pro4'), {}).pass === true,
  'a model advertising response_format passes');
ok(checkJsonMode(byId(REAL_MODELS, 'upstage/solar-pro4'), {}).facts.isGuarantee === false,
  'without endpoint data JSON-mode support is NOT marked a guarantee');

// ─────────────────────────────────────────────────────────────────────────────
section('3. Rule 2 — knowable price (a KNOWABILITY test, never a cost test)');
// ─────────────────────────────────────────────────────────────────────────────

const auto = byId(REAL_MODELS, 'openrouter/auto');
const pAuto = checkKnowablePrice(auto);
ok(pAuto.pass === false, 'openrouter/auto (priced "-1") fails');
ok(firstCode(pAuto) === REASON_CODES.PRICE_UNKNOWABLE, '…with PRICE_UNKNOWABLE');
// Mutation M13 (deleting the "-1" sentinel branch) stayed GREEN on the code
// alone: -1 is also negative, so the negative-price branch caught it and
// emitted the SAME code. The code assertion could not distinguish the two
// paths, which made it decoration. The message can.
ok(/unknowable until after the call/.test(firstMsg(pAuto)),
  '…and specifically as the ROUTER sentinel, not merely as "a negative number"');
const negPrice = { id: 'synthetic/negative-price', context_length: 400000,
  architecture: { output_modalities: ['text'] },
  pricing: { prompt: '-0.5', completion: '1' },
  top_provider: { context_length: 400000, max_completion_tokens: 100000 },
  supported_parameters: ['max_tokens', 'response_format'], expiration_date: null };
ok(checkKnowablePrice(negPrice).pass === false, 'a non-sentinel NEGATIVE price also fails');
ok(/negative/.test(firstMsg(checkKnowablePrice(negPrice))),
  '…on the negative branch, whose message differs from the sentinel branch');
ok(firstMsg(checkKnowablePrice(negPrice)) !== firstMsg(pAuto),
  '…so the two rejection paths are genuinely distinguishable (M13 could not be caught without this)');

const emptyPrice = byId(SYNTHETIC_MODELS, 'synthetic/empty-string-price');
const pEmpty = checkKnowablePrice(emptyPrice);
ok(pEmpty.pass === false, 'an empty-string price fails');
ok(firstCode(pEmpty) === REASON_CODES.PRICE_UNPARSEABLE,
  '…with PRICE_UNPARSEABLE — a DIFFERENT code from "-1", and not silently 0');

const freeModel = byId(REAL_MODELS, 'minimax/minimax-m3:free');
ok(checkKnowablePrice(freeModel).pass === true, 'a genuinely FREE model passes the price rule');
const freePrice = effectivePriceAt(freeModel, APP_INGEST_PROMPT_TOKENS_APPROX);
ok(freePrice.known === true, 'a free model reports known: true');
ok(freePrice.promptUsdPerMTok === 0, '…and a price of exactly 0');
ok(effectivePriceAt(emptyPrice, 85000).known === false,
  'an unparseable price reports known: false');
ok(effectivePriceAt(emptyPrice, 85000).promptUsdPerMTok === null,
  '…and a price of null — free and unpriceable are NOT the same value');

// The load-bearing boundary: no price ceiling, no cheapness preference anywhere.
const dearest = { id: 'x/very-expensive', context_length: 400000, architecture: { output_modalities: ['text'] },
  pricing: { prompt: '0.001', completion: '0.005' },
  top_provider: { context_length: 400000, max_completion_tokens: 100000 },
  supported_parameters: ['max_tokens', 'response_format'], expiration_date: null };
ok(evaluateModel(dearest).eligible === true,
  'an extremely EXPENSIVE model is still eligible — price is information, never a gate');
const cheapFirst = filterCatalogue([dearest, freeModel]);
ok(cheapFirst.eligible[0].id === 'x/very-expensive',
  'filterCatalogue preserves input order and does NOT sort by cost');

// ─────────────────────────────────────────────────────────────────────────────
section('4. Rule 3 — moving aliases, on THREE independent signals');
// The tilde-only filter admits openai/gpt-chat-latest. That is the bug this
// rule was rewritten for, and this section is the only thing that catches it.
// ─────────────────────────────────────────────────────────────────────────────

const gptChat = byId(REAL_MODELS, 'openai/gpt-chat-latest');
ok(gptChat.id.startsWith('~') === false, '⟨PREMISE⟩ openai/gpt-chat-latest carries NO ~ prefix');
ok(Object.hasOwn(gptChat, 'alias_target') === false, '⟨PREMISE⟩ …and declares NO alias_target');
const aGpt = checkNotMovingAlias(gptChat);
ok(aGpt.pass === false, 'openai/gpt-chat-latest is REFUSED — a tilde-only filter would admit it');
ok(codesOf({ reasons: aGpt.reasons }).includes(REASON_CODES.ALIAS_LATEST_SUFFIX),
  '…caught by ALIAS_LATEST_SUFFIX, the signal that exists solely for this case');
ok(aGpt.reasons.length === 1, '…and by that signal ALONE, so it cannot be passing for another reason');

const tilde = byId(REAL_MODELS, '~anthropic/claude-haiku-latest');
const aTilde = checkNotMovingAlias(tilde);
ok(aTilde.pass === false, 'a ~-prefixed id is refused');
ok(codesOf({ reasons: aTilde.reasons }).includes(REASON_CODES.ALIAS_TILDE_PREFIX), '…on the tilde signal');
ok(codesOf({ reasons: aTilde.reasons }).includes(REASON_CODES.ALIAS_TARGET_DECLARED), '…and on alias_target');

const quiet = byId(SYNTHETIC_MODELS, 'synthetic/quiet-alias');
const aQuiet = checkNotMovingAlias(quiet);
ok(aQuiet.pass === false, 'alias_target alone refuses, with neither other marker present');
ok(aQuiet.reasons.length === 1 && firstCode(aQuiet) === REASON_CODES.ALIAS_TARGET_DECLARED,
  '…on ALIAS_TARGET_DECLARED alone — this predicate is independently load-bearing');

ok(checkNotMovingAlias(byId(REAL_MODELS, 'upstage/solar-pro4')).pass === true,
  'an ordinary pinned id passes');
ok(checkNotMovingAlias({ id: 'vendor/latest-thinking' }).pass === true,
  '"latest" NOT at the end of the id does not trip the suffix rule (anchored, not a substring)');
ok(checkNotMovingAlias({ id: 'vendor/model-latest-v2' }).pass === true,
  '…nor does "-latest-" in the middle');

// ─────────────────────────────────────────────────────────────────────────────
section('5. Rule 4 — output ceiling: zero, null and below-floor are three facts');
// ─────────────────────────────────────────────────────────────────────────────

const orFree = byId(REAL_MODELS, 'openrouter/free');
const cFree = checkOutputCeiling(orFree, {});
ok(cFree.pass === false, 'openrouter/free (max_completion_tokens: null) fails the ceiling rule');
ok(firstCode(cFree) === REASON_CODES.OUTPUT_CEILING_UNKNOWN,
  '…as UNKNOWN — null is not "large" and not "zero"');
// Mutation M4 (disabling the explicit null branch) stayed GREEN on the code
// alone, because the generic not-a-number branch below it also rejects. The
// two branches say DIFFERENT things, so the message is what makes the explicit
// branch independently load-bearing rather than defence in depth.
ok(/is null/.test(firstMsg(cFree)) && /not "large"/.test(firstMsg(cFree)),
  '…and names the null explicitly, not as a generic "not a number"');
ok(firstMsg(checkOutputCeiling({ id: 'x/no-ceiling-key', context_length: 400000,
  top_provider: { context_length: 400000 } }, {})) !== firstMsg(cFree),
  '…a MISSING key produces a different message from an explicit null (two facts, two messages)');
ok(cFree.facts.modelLevel === null, 'facts.modelLevel is null, not 0');

const zeroOut = byId(SYNTHETIC_MODELS, 'synthetic/zero-output-ceiling');
const cZero = checkOutputCeiling(zeroOut, {});
ok(cZero.pass === false, 'a literal max_completion_tokens: 0 fails');
ok(firstCode(cZero) === REASON_CODES.OUTPUT_CEILING_ZERO,
  '…as ZERO — a DIFFERENT code from UNKNOWN, because the API positively said zero');
ok(REASON_CODES.OUTPUT_CEILING_ZERO !== REASON_CODES.OUTPUT_CEILING_UNKNOWN,
  'the zero and unknown codes are genuinely distinct');

const nemotron = byId(REAL_MODELS, 'nvidia/nemotron-3-ultra-550b-a55b');
ok(nemotron.top_provider.max_completion_tokens === 16384, '⟨PREMISE⟩ nemotron-3-ultra publishes 16384');
const cNem = checkOutputCeiling(nemotron, {});
ok(cNem.pass === false, '…so it fails a 24576 floor');
ok(firstCode(cNem) === REASON_CODES.OUTPUT_CEILING_BELOW_FLOOR, '…as BELOW_FLOOR');

// The floor is INJECTED, not hardcoded in the logic.
ok(checkOutputCeiling(nemotron, { outputFloorTokens: 8192 }).pass === true,
  'the same model PASSES when a lower floor is injected — the threshold is a parameter');
ok(checkOutputCeiling(byId(REAL_MODELS, 'upstage/solar-pro4'), { outputFloorTokens: 999_999_999 }).pass === false,
  '…and a passing model FAILS under an absurd floor — the parameter is genuinely read');
ok(APP_OUTPUT_FLOOR_TOKENS === 24576,
  'the documented default floor equals ingest.js MULTI_PHASE_OUTLINE_TOKENS (24576)');

// context_length must never stand in for the output ceiling.
ok(checkOutputCeiling({ id: 'x/big-context-small-output', context_length: 1_000_000,
  top_provider: { context_length: 1_000_000, max_completion_tokens: 4096 } }, {}).pass === false,
  'a huge context_length does NOT rescue a small output ceiling');

// ─────────────────────────────────────────────────────────────────────────────
section('6. Rule 5 — context window, and the optimistic-field disagreement');
// ─────────────────────────────────────────────────────────────────────────────

const granite = byId(REAL_MODELS, 'ibm-granite/granite-4.0-h-micro');
ok(granite.context_length === 131000, '⟨PREMISE⟩ granite-4.0-h-micro publishes 131000');
const xGran = checkContextWindow(granite, {});
ok(xGran.pass === false, '…so it fails the 200000 floor');
ok(firstCode(xGran) === REASON_CODES.CONTEXT_BELOW_FLOOR, '…as CONTEXT_BELOW_FLOOR');

const zeroCtx = byId(SYNTHETIC_MODELS, 'synthetic/zero-context');
ok(checkContextWindow(zeroCtx, {}).reasons[0].code === REASON_CODES.CONTEXT_ZERO,
  'a literal context_length: 0 is CONTEXT_ZERO, distinct from CONTEXT_UNKNOWN');
ok(checkContextWindow({ id: 'x/null-ctx', context_length: null, top_provider: {} }, {}).reasons[0].code
  === REASON_CODES.CONTEXT_UNKNOWN, 'a null context_length is CONTEXT_UNKNOWN');

// The 200,000 default is a PARITY rule with the app's shipped Anthropic default.
const haiku = byId(REAL_MODELS, 'anthropic/claude-haiku-4.5');
ok(haiku.context_length === APP_CONTEXT_FLOOR_TOKENS,
  'the default context floor equals claude-haiku-4.5\'s published context (the parity derivation)');
ok(evaluateModel(haiku).eligible === true,
  '…and claude-haiku-4.5 itself is eligible, so the floor cannot exclude the model it is derived from');

// ── The two context fields disagree on real models, and the headline one is the
//    OPTIMISTIC max-across-providers value. The default now reads the other one.
const unslop = byId(REAL_MODELS, 'thedrummer/unslopnemo-12b');
ok(unslop.context_length === 1024000 && unslop.top_provider.context_length === 32768,
  '⟨PREMISE⟩ unslopnemo-12b: context_length 1024000 vs top_provider 32768 — a factor of 31');
ok(checkContextWindow(unslop, { contextField: CONTEXT_FIELDS.HEADLINE }).pass === true,
  'on the HEADLINE field unslopnemo-12b PASSES — that figure is the max across providers');
ok(checkContextWindow(unslop, {}).pass === false,
  '…and FAILS on the DEFAULT field, because the default is now top_provider.context_length');
ok(firstCode(checkContextWindow(unslop, {})) === REASON_CODES.CONTEXT_BELOW_FLOOR,
  '…as CONTEXT_BELOW_FLOOR, computed from 32768 rather than 1024000');
ok(checkContextWindow(unslop, {}).facts.modelLevel === 32768,
  '…and facts.modelLevel reports the value actually read, not the headline');
ok(DEFAULT_ELIGIBILITY_OPTS.contextField === CONTEXT_FIELDS.TOP_PROVIDER,
  'the DEFAULT context field is top_provider.context_length');
ok(CONTEXT_FIELDS.TOP_PROVIDER === 'top_provider.context_length'
  && CONTEXT_FIELDS.HEADLINE === 'context_length',
  'the two legal tokens are spelled as the field PATHS they name');

// The rule the OUTPUT ceiling has always followed — never read the optimistic
// field — now applied to context too. Asserted as a CROSS-RULE invariant so the
// two cannot drift apart again.
ok(checkOutputCeiling(unslop, {}).facts.modelLevel === unslop.top_provider.max_completion_tokens
  && checkContextWindow(unslop, {}).facts.modelLevel === unslop.top_provider.context_length,
  'BOTH ceiling rules read top_provider by default — the optimistic field is refused consistently');

// basis names the exact field read, so no consumer has to guess which summary.
ok(checkContextWindow(unslop, {}).facts.basis === 'model-level-representative:top_provider.context_length',
  'facts.basis names the exact field path that was read');
ok(checkContextWindow(unslop, { contextField: CONTEXT_FIELDS.HEADLINE }).facts.basis
   === 'model-level-representative:context_length', '…and changes when the field changes');
ok(checkContextWindow(unslop, {}).facts.field === CONTEXT_FIELDS.TOP_PROVIDER,
  'facts.field reports the governing field');

// NEITHER model-level field is a floor — only per-endpoint data is.
ok(checkContextWindow(unslop, {}).facts.isGuarantee === false,
  'a model-level read is NEVER marked a guarantee, whichever field it came from');
ok(checkContextWindow(unslop, { contextField: CONTEXT_FIELDS.HEADLINE }).facts.isGuarantee === false,
  '…including the headline field — switching field buys a less optimistic read, not a floor');
ok(checkContextWindow(byId(REAL_MODELS, 'upstage/solar-pro4'),
  { endpointsById: REAL_ENDPOINTS }).facts.isGuarantee === true,
  '…while per-endpoint data IS a guarantee (so the two flags above are not unconditionally false)');

// An UNRECOGNISED field token must not silently select the optimistic field.
for (const bad of ['top_provider', 'context-length', '', null, 42, {}]) {
  const label = JSON.stringify(bad);
  const c = checkContextWindow(unslop, { contextField: bad });
  ok(c.pass === false,
    'contextField ' + label + ' resolves CONSERVATIVELY — a typo never widens the eligible set');
  ok(c.risks.some(r => r.code === RISK_CODES.CONTEXT_FIELD_UNRECOGNISED),
    '…and raises CONTEXT_FIELD_UNRECOGNISED for ' + label);
  ok(c.facts.fieldRecognised === false && c.facts.field === CONTEXT_FIELDS.TOP_PROVIDER,
    '…recording BOTH that the token was unrecognised and which field was used instead, for ' + label);
}
// 'top_provider' was the OLD token. It is deliberately no longer accepted, and is
// caught by the unrecognised path rather than silently meaning what it used to.
ok(checkContextWindow(unslop, { contextField: 'top_provider' }).risks
  .some(r => r.code === RISK_CODES.CONTEXT_FIELD_UNRECOGNISED && r.severity === 'high'),
  'the superseded token "top_provider" is refused at HIGH severity, not silently honoured');
ok(!checkContextWindow(unslop, {}).risks.some(r => r.code === RISK_CODES.CONTEXT_FIELD_UNRECOGNISED)
  && !checkContextWindow(unslop, { contextField: CONTEXT_FIELDS.HEADLINE }).risks
       .some(r => r.code === RISK_CODES.CONTEXT_FIELD_UNRECOGNISED),
  '…and BOTH recognised tokens raise no such risk (the flag is conditional)');

// The disagreement risk fires whichever field governs, and is 'high' only when
// the two straddle the floor — i.e. when the field choice decides the verdict.
ok(riskCodesOf(evaluateModel(unslop)).includes(RISK_CODES.CONTEXT_FIELD_DISAGREEMENT),
  'the disagreement is ALWAYS surfaced as a risk, whichever field governs');
ok(riskCodesOf(evaluateModel(unslop, { contextField: CONTEXT_FIELDS.HEADLINE }))
  .includes(RISK_CODES.CONTEXT_FIELD_DISAGREEMENT), '…including under the headline field');
const unslopRisk = evaluateModel(unslop).riskFlags.find(r => r.code === RISK_CODES.CONTEXT_FIELD_DISAGREEMENT);
ok(unslopRisk.severity === 'high' && unslopRisk.detail.straddlesFloor === true,
  '…at HIGH severity when the two fields straddle the floor, because the field choice decides the verdict');
const flash = byId(REAL_MODELS, 'z-ai/glm-5.3-flash');
ok(flash.context_length === 1310720 && flash.top_provider.context_length === 1048576,
  '⟨PREMISE⟩ glm-5.3-flash also disagrees (1310720 vs 1048576) but clears the floor on BOTH');
const flashRisk = evaluateModel(flash, { now: SNAPSHOT_DAY }).riskFlags
  .find(r => r.code === RISK_CODES.CONTEXT_FIELD_DISAGREEMENT);
ok(flashRisk && flashRisk.severity === 'medium' && flashRisk.detail.straddlesFloor === false,
  '…so it is flagged at MEDIUM — the severity is DERIVED from the floor, not a constant');
ok(evaluateModel(flash, { now: SNAPSHOT_DAY }).eligible === true,
  '…while the model itself stays eligible: a disagreement is a fact, never a rejection');
ok(!riskCodesOf(evaluateModel(byId(REAL_MODELS, 'upstage/solar-pro4')))
  .includes(RISK_CODES.CONTEXT_FIELD_DISAGREEMENT),
  '…and a model whose fields AGREE raises no such risk (the flag is not unconditional)');

// null on the GOVERNING field is UNKNOWN, not "large". Only testable on
// top_provider now that top_provider is what governs.
const nullTop = byId(SYNTHETIC_MODELS, 'synthetic/null-top-provider-context');
ok(nullTop.context_length === 400000 && nullTop.top_provider.context_length === null,
  '⟨PREMISE⟩ a record clearing the floor on the headline field with a NULL top_provider value');
ok(checkContextWindow(nullTop, {}).pass === false,
  'a null on the governing field FAILS — null is not "large"');
ok(firstCode(checkContextWindow(nullTop, {})) === REASON_CODES.CONTEXT_UNKNOWN,
  '…as CONTEXT_UNKNOWN, distinct from CONTEXT_BELOW_FLOOR');
ok(checkContextWindow(nullTop, { contextField: CONTEXT_FIELDS.HEADLINE }).pass === true,
  '…while the SAME record passes on the headline field, so the two reads genuinely differ');

ok(checkContextWindow(granite, { contextFloorTokens: 100000 }).pass === true,
  'the context floor is injected — granite passes under a 100000 floor');

// ─────────────────────────────────────────────────────────────────────────────
section('7. Rule 6 — tiered and time-windowed pricing at the app\'s prompt size');
// ─────────────────────────────────────────────────────────────────────────────

const qwenFlash = byId(REAL_MODELS, 'qwen/qwen3.7-flash');
const qBase = effectivePriceAt(qwenFlash, 1000);
near(qBase.promptUsdPerMTok, 0.03, 'qwen3.7-flash at 1,000 tokens bills the base $0.03/Mtok');
ok(qBase.basis === 'base', '…on the base tier');

const qApp = effectivePriceAt(qwenFlash, APP_INGEST_PROMPT_TOKENS_APPROX);
near(qApp.promptUsdPerMTok, 0.10, 'qwen3.7-flash at 85,000 tokens bills $0.10/Mtok');
near(qApp.completionUsdPerMTok, 0.40, '…and $0.40/Mtok completion');
near(qApp.headlinePromptUsdPerMTok, 0.03, '…while the HEADLINE stays $0.03 — both facts are reported');
ok(qApp.promptUsdPerMTok / qApp.headlinePromptUsdPerMTok > 3.3,
  '…i.e. the real price for this workload is >3.3x the advertised one');
ok(qApp.basis === 'override-applied', '…on an applied override, with the base superseded');
ok(riskCodesOf(evaluateModel(qwenFlash)).includes(RISK_CODES.PRICE_TIERED_ABOVE_HEADLINE),
  '…and that gap is risk-flagged');

// Money safety: an unknown prompt size must resolve to the DEAREST tier.
const qUnknown = effectivePriceAt(qwenFlash, null);
near(qUnknown.promptUsdPerMTok, 0.20, 'an UNKNOWN prompt size quotes the dearest tier ($0.20), never the base');
ok(qUnknown.unresolvedConstraint === true, '…and reports the constraint as unresolved');
ok(qUnknown.promptUsdPerMTok > qApp.promptUsdPerMTok, '…which is strictly dearer than the resolved answer');

// The inverted tier proves MAX is a real maximum, not "the last tier wins".
const inv = byId(SYNTHETIC_MODELS, 'synthetic/inverted-tier');
near(effectivePriceAt(inv, 100000).promptUsdPerMTok, 0.5,
  'an inverted tier resolves to its (cheaper) tier price when the prompt size IS known');
near(effectivePriceAt(inv, null).promptUsdPerMTok, 2.0,
  '…and to the dearer BASE when the prompt size is unknown — MAX, not last-tier');

// Time windows.
const hy3 = byId(REAL_MODELS, 'tencent/hy3');
near(effectivePriceAt(hy3, 85000, { now: MON_18_00 }).promptUsdPerMTok, 0.0825,
  'tencent/hy3 at 18:00 UTC bills the cheap 16:00→00:00 window (base correctly superseded)');
near(effectivePriceAt(hy3, 85000, { now: MON_08_00 }).promptUsdPerMTok, 0.132,
  'tencent/hy3 at 08:00 UTC bills the dear 00:00→16:00 window');
near(effectivePriceAt(hy3, 85000, { now: null }).promptUsdPerMTok, 0.132,
  'an UNKNOWN clock quotes the dearest window — never the cheap one');
ok(effectivePriceAt(hy3, 85000, { now: MON_18_00 }).promptUsdPerMTok
   < effectivePriceAt(hy3, 85000, { now: null }).promptUsdPerMTok,
  '…so the unknown-clock answer is strictly dearer than the real one at 18:00');

const dsPro = byId(REAL_MODELS, 'deepseek/deepseek-v4-pro-0813');
near(effectivePriceAt(dsPro, 85000, { now: TUE_02_00 }).promptUsdPerMTok, 1.32,
  'deepseek-v4-pro on a WEEKDAY at 02:00 UTC bills the DOUBLED peak price');
near(effectivePriceAt(dsPro, 85000, { now: SAT_02_00 }).promptUsdPerMTok, 0.66,
  '…and at the same hour on a SATURDAY bills the base price (day matching works)');
near(effectivePriceAt(dsPro, 85000, { now: null }).promptUsdPerMTok, 1.32,
  '…and an unknown clock quotes the doubled price');
ok(riskCodesOf(evaluateModel(dsPro, { now: null })).includes(RISK_CODES.PRICE_CLOCK_UNKNOWN),
  '…flagging that the clock was not supplied');
ok(!riskCodesOf(evaluateModel(dsPro, { now: TUE_02_00 })).includes(RISK_CODES.PRICE_CLOCK_UNKNOWN),
  '…and NOT flagging it when a clock WAS supplied (the flag is conditional)');

// Midnight wraparound is real live data (`utc_start: 1000, utc_end: 0`).
near(effectivePriceAt(hy3, 85000, { now: '2026-08-31T23:59:00Z' }).promptUsdPerMTok, 0.0825,
  'a window that wraps to 00:00 still matches at 23:59');
near(effectivePriceAt(hy3, 85000, { now: '2026-08-31T00:00:00Z' }).promptUsdPerMTok, 0.132,
  '…and the other window matches at exactly 00:00 (boundaries are start-inclusive, end-exclusive)');
near(effectivePriceAt(hy3, 85000, { now: '2026-08-31T16:00:00Z' }).promptUsdPerMTok, 0.0825,
  '…and the 16:00 boundary belongs to the later window, not the earlier one');

// Both constraint kinds on one entry.
const tt = byId(SYNTHETIC_MODELS, 'synthetic/tier-and-time');
near(effectivePriceAt(tt, 100000, { now: MON_08_00 }).promptUsdPerMTok, 9.0,
  'an override with BOTH a tier and a window applies when both constraints match');
near(effectivePriceAt(tt, 1000, { now: MON_08_00 }).promptUsdPerMTok, 1.0,
  '…and does not apply when the TOKEN constraint fails');
near(effectivePriceAt(tt, 100000, { now: MON_18_00 }).promptUsdPerMTok, 1.0,
  '…nor when the TIME constraint fails');
near(effectivePriceAt(tt, 100000, { now: null }).promptUsdPerMTok, 9.0,
  '…and an unknown clock takes the dear branch');

ok(effectivePriceAt(byId(REAL_MODELS, 'upstage/solar-pro4'), 85000).tiered === false,
  'a model with no overrides reports tiered: false');

// ─────────────────────────────────────────────────────────────────────────────
section('8. Rule 7 — per-endpoint data, and the absence of it');
// ─────────────────────────────────────────────────────────────────────────────

const llamaId = 'meta-llama/llama-3.3-70b-instruct';
const llama = byId(REAL_MODELS, llamaId);
const llamaEps = REAL_ENDPOINTS[llamaId];
ok(llama.top_provider.max_completion_tokens === 115200,
  '⟨PREMISE⟩ llama-3.3-70b PUBLISHES a 115200 output ceiling');
ok(Math.min(...llamaEps.map(e => e.max_completion_tokens)) === 2048,
  '⟨PREMISE⟩ …while its worst endpoint publishes 2048');
ok(llamaEps.filter(e => e.max_completion_tokens < APP_OUTPUT_FLOOR_TOKENS).length === 7,
  '⟨PREMISE⟩ …and 7 of its 13 endpoints sit below the floor');

const llamaModelOnly = checkOutputCeiling(llama, {});
ok(llamaModelOnly.pass === true, 'on the representative value alone, llama-3.3-70b PASSES the ceiling rule');
ok(llamaModelOnly.facts.isGuarantee === false, '…and is explicitly NOT marked a guarantee');
ok(llamaModelOnly.facts.basis === 'model-level-representative', '…with basis naming the representative read');

const llamaWithEps = checkOutputCeiling(llama, { endpointsById: REAL_ENDPOINTS });
ok(llamaWithEps.pass === false, '…and FAILS once its endpoints are supplied');
ok(codesOf({ reasons: llamaWithEps.reasons }).includes(REASON_CODES.OUTPUT_CEILING_BELOW_FLOOR_AT_ENDPOINT),
  '…on OUTPUT_CEILING_BELOW_FLOOR_AT_ENDPOINT');
ok(llamaWithEps.facts.endpointMin === 2048, '…reporting the worst endpoint, not the representative one');
ok(llamaWithEps.facts.isGuarantee === true, '…and NOW marking the result a guarantee');

// The absence of endpoint data must never read as "no variance".
ok(riskCodesOf(evaluateModel(llama)).includes(RISK_CODES.ENDPOINT_DATA_ABSENT),
  'a model evaluated WITHOUT endpoint data carries ENDPOINT_DATA_ABSENT');
ok(!riskCodesOf(evaluateModel(llama, { endpointsById: REAL_ENDPOINTS })).includes(RISK_CODES.ENDPOINT_DATA_ABSENT),
  '…and does NOT carry it once endpoints are supplied (the flag is conditional, not unconditional)');
ok(evaluateModel(llama).facts.endpoints.supplied === false, 'facts record that endpoint data was absent');
ok(evaluateModel(llama, { endpointsById: REAL_ENDPOINTS }).facts.endpoints.count === 13,
  '…and record the endpoint count when it was present');

// JSON mode varies per endpoint on real models.
const coderId = 'qwen/qwen3-coder-30b-a3b-instruct';
const coder = byId(REAL_MODELS, coderId);
ok(REAL_ENDPOINTS[coderId].some(e => !e.supported_parameters.includes('response_format')),
  '⟨PREMISE⟩ qwen3-coder-30b has an endpoint WITHOUT response_format');
ok(checkJsonMode(coder, {}).pass === true, 'on model-level metadata it advertises JSON mode');
const coderEps = checkJsonMode(coder, { endpointsById: REAL_ENDPOINTS });
ok(coderEps.pass === false, '…and fails once endpoint variance is visible');
ok(codesOf({ reasons: coderEps.reasons }).includes(REASON_CODES.JSON_MODE_UNSUPPORTED_AT_ENDPOINT),
  '…on JSON_MODE_UNSUPPORTED_AT_ENDPOINT');
ok(riskCodesOf(evaluateModel(coder, { endpointsById: REAL_ENDPOINTS })).includes(RISK_CODES.ENDPOINT_JSON_MODE_SPREAD),
  '…and raises the JSON-spread risk');

// The Amazon Bedrock endpoint: 0 / 0 / no response_format, all three in one record.
const bedrock = REAL_ENDPOINTS[coderId].find(e => e.max_completion_tokens === 0);
ok(bedrock !== undefined, '⟨PREMISE⟩ a real endpoint publishes max_completion_tokens: 0');
ok(bedrock.context_length === 0, '⟨PREMISE⟩ …and context_length: 0');
ok(checkOutputCeiling(coder, { endpointsById: REAL_ENDPOINTS }).facts.endpointMin === 0,
  'a zero endpoint ceiling is carried through as 0, not dropped as falsy');

// A model whose endpoints ALL clear the bars must still pass — otherwise the
// endpoint path would be rejecting everything and these assertions would be
// satisfied for the wrong reason.
const solarWithEps = evaluateModel(byId(REAL_MODELS, 'upstage/solar-pro4'), { endpointsById: REAL_ENDPOINTS });
ok(solarWithEps.eligible === true, 'upstage/solar-pro4 stays eligible WITH its endpoints supplied');
ok(solarWithEps.facts.outputCeiling.isGuarantee === true, '…and its ceiling is now a guarantee');
const seedWithEps = evaluateModel(byId(REAL_MODELS, 'bytedance-seed/seed-2.0-mini'), { endpointsById: REAL_ENDPOINTS });
ok(seedWithEps.eligible === true, 'bytedance-seed/seed-2.0-mini also survives its endpoints');

ok(extractEndpoints(null) === null, 'extractEndpoints(null) is null — "no data", not "empty list"');
ok(Array.isArray(extractEndpoints({ data: { endpoints: [] } })), 'extractEndpoints unwraps the raw API shape');
ok(Array.isArray(extractEndpoints([{ a: 1 }])), 'extractEndpoints accepts a bare array');
ok(extractEndpoints({ nope: 1 }) === null, 'extractEndpoints of an unrecognised object is null');

// Endpoint data for OTHER models must not leak into this one.
ok(evaluateModel(byId(REAL_MODELS, 'qwen/qwen3.7-flash'), { endpointsById: REAL_ENDPOINTS })
  .facts.endpoints.supplied === false,
  'a model absent from the endpoint map is treated as having NO endpoint data (no cross-contamination)');
ok(evaluateModel(byId(REAL_MODELS, 'qwen/qwen3.7-flash'),
  { endpointsById: { __proto__: [{ max_completion_tokens: 1 }] } }).facts.endpoints.supplied === false,
  'a prototype key in the endpoint map is not treated as a lookup hit');

// ─────────────────────────────────────────────────────────────────────────────
section('9. filterCatalogue — the funnel composes and every stage is live');
// ─────────────────────────────────────────────────────────────────────────────

const run = filterCatalogue(REAL_MODELS);
ok(run.total === 26, 'the funnel reports the full input count');
ok(run.funnel.length === RULE_ORDER.length, 'one funnel stage per rule, in RULE_ORDER');
ok(run.funnel.every((f, i) => i === 0 || f.in === run.funnel[i - 1].out),
  'the stages COMPOSE — each stage\'s `in` is the previous stage\'s `out`');
ok(run.funnel.every(f => f.out === f.in - f.lost), 'each stage\'s arithmetic is internally consistent');
ok(run.funnel[run.funnel.length - 1].out === run.eligible.length,
  'the final stage\'s `out` equals the eligible count');
ok(run.eligible.length + run.rejected.length === run.total, 'eligible + rejected accounts for every record');

const stage = name => run.funnel.find(f => f.rule === name);
ok(stage('json_mode').lost === 2, 'json_mode loses exactly 2 (fusion, ling-3.0-flash-fin)');
ok(stage('knowable_price').lost === 1, 'knowable_price loses exactly 1 (openrouter/auto)');
ok(stage('not_moving_alias').lost === 2, 'not_moving_alias loses exactly 2 (gpt-chat-latest, ~claude-haiku-latest)');
ok(stage('output_ceiling').lost === 2, 'output_ceiling loses exactly 2 (openrouter/free, nemotron-3-ultra)');
ok(stage('context_window').lost === 4,
  'context_window loses exactly 4 (granite, llama-3.3-70b, and — new on the top_provider default — unslopnemo-12b and qwen3-30b-a3b-instruct-2507)');
ok(stage('context_window').lostIds.includes('thedrummer/unslopnemo-12b')
   && stage('context_window').lostIds.includes('qwen/qwen3-30b-a3b-instruct-2507'),
  '…naming the two models the context-field change is responsible for');
ok(filterCatalogue(REAL_MODELS, { contextField: CONTEXT_FIELDS.HEADLINE })
     .funnel.find(f => f.rule === 'context_window').lost === 2,
  '…and the SAME corpus loses only 2 there under the headline field, so the delta is the field, not the corpus');
ok(run.eligible.length === 15, 'the fixture catalogue yields 15 eligible models under the default (clock-free) options');

// ── The expiry stage is INERT without a clock, and that is the DEFAULT. ───────
// `opts.now` defaults to null and this module may not read a clock, so the
// stage cannot reject unless the caller injects one. Asserted rather than left
// as a comment, because a reader who sees `expiryHorizonDays: 30` in the
// defaults will otherwise assume the rule is running.
ok(stage('not_expiring').lost === 0,
  'with NO clock the expiry stage loses 0 — the default configuration cannot reject on expiry');
const runClocked = filterCatalogue(REAL_MODELS, { now: SNAPSHOT_DAY });
const stageC = name => runClocked.funnel.find(f => f.rule === name);
ok(stageC('not_expiring').lost === 1 && stageC('not_expiring').lostIds.includes('moonshotai/kimi-k2.5'),
  '…while injecting a clock makes it lose exactly 1 (kimi-k2.5), so the stage is live, not dead');
ok(runClocked.eligible.length === 14,
  '…and the clocked eligible set is one smaller (15 → 14)');
ok(runClocked.eligible.length < run.eligible.length,
  '…strictly smaller: supplying a clock can only ever remove models here, never add them');
// Every OTHER stage must be identical with and without a clock — the clock must
// not leak into a rule that has nothing to do with time.
for (const name of ['json_mode', 'knowable_price', 'not_moving_alias', 'output_ceiling', 'context_window']) {
  ok(stage(name).lost === stageC(name).lost,
    `⟨ISOLATION⟩ injecting a clock does not change the ${name} stage`);
}

// Every stage must lose SOMETHING, or a rule could stop working unnoticed.
for (const name of ['json_mode', 'knowable_price', 'not_moving_alias', 'output_ceiling', 'context_window']) {
  ok(stage(name).lost > 0, `⟨NON-VACUITY⟩ stage ${name} loses at least one model in this corpus`);
}
ok(stageC('not_expiring').lost > 0, '⟨NON-VACUITY⟩ the expiry stage loses at least one model once a clock is supplied');
ok(stage('not_moving_alias').lostIds.includes('openai/gpt-chat-latest'),
  'the funnel names gpt-chat-latest at the alias stage specifically');

// The cascade attributes each model to its FIRST failing rule only.
ok(stage('json_mode').lostIds.includes('openrouter/fusion')
   && !stage('knowable_price').lostIds.includes('openrouter/fusion'),
  'openrouter/fusion (which fails json AND price) is attributed to json_mode ONLY');
ok(evaluateModel(fusion).reasons.length >= 2,
  '…while its per-model reasons remain EXHAUSTIVE, listing every failure');

// Endpoint data changes the eligible set.
const runEps = filterCatalogue(REAL_MODELS, { endpointsById: REAL_ENDPOINTS });
ok(runEps.eligible.length < run.eligible.length,
  'supplying endpoint data STRICTLY shrinks the eligible set on this corpus');
ok(runEps.opts.endpointDataSupplied === true, 'the run records that endpoint data was supplied');
ok(run.opts.endpointDataSupplied === false, '…and records its absence otherwise');
ok(run.opts.contextFloorTokens === APP_CONTEXT_FLOOR_TOKENS, 'the run echoes the thresholds it used');

ok(filterCatalogue(null).total === 0, 'filterCatalogue(null) is empty, not a throw');
ok(filterCatalogue([null, 5, 'x']).eligible.length === 0, 'malformed entries are rejected, not thrown on');
ok(filterCatalogue([null]).rejected[0].reasons[0].code === REASON_CODES.RECORD_MALFORMED,
  '…with RECORD_MALFORMED');

// ─────────────────────────────────────────────────────────────────────────────
section('10. Reasoning — five states, and the pair that must NOT be separated');
// The whole point: solar-pro4 (measured 9/9 clean) and nex-n2-mini (0/3, burned
// its entire budget on hidden reasoning) are BYTE-IDENTICAL here.
// ─────────────────────────────────────────────────────────────────────────────

const solar = byId(REAL_MODELS, 'upstage/solar-pro4');
const nex = byId(REAL_MODELS, 'nex-agi/nex-n2-mini');
ok(JSON.stringify(solar.reasoning) === JSON.stringify(nex.reasoning),
  '⟨PREMISE⟩ solar-pro4 and nex-n2-mini have byte-identical `reasoning` metadata');
ok(JSON.stringify(solar.reasoning) === '{"mandatory":false}',
  '⟨PREMISE⟩ …and that metadata is exactly {"mandatory":false}, with default_enabled ABSENT');

ok(classifyReasoning(solar).state === REASONING_STATES.OPTIONAL_DEFAULT_UNSTATED,
  'solar-pro4 classifies as OPTIONAL_DEFAULT_UNSTATED');
ok(classifyReasoning(nex).state === REASONING_STATES.OPTIONAL_DEFAULT_UNSTATED,
  'nex-n2-mini classifies identically — metadata cannot tell them apart, and must not pretend to');
ok(classifyReasoning(solar).state !== REASONING_STATES.OPTIONAL_DEFAULT_OFF,
  'an ABSENT default_enabled is NOT read as "off" — that reading is the bug this module exists to prevent');
ok(classifyReasoning(solar).defaultEnabled === null,
  '…and defaultEnabled is reported as null (we were not told), never false');

ok(evaluateModel(solar).eligible === true, 'solar-pro4 is ELIGIBLE — the unstated shape never rejects');
ok(evaluateModel(nex).eligible === true, 'nex-n2-mini is ALSO eligible — 74 live models share this shape');
ok(evaluateModel(nex).reasons.length === 0, '…with no rejection reasons at all');
ok(riskCodesOf(evaluateModel(nex)).includes(RISK_CODES.REASONING_DEFAULT_UNSTATED),
  '…but carrying the REASONING_DEFAULT_UNSTATED risk flag');
ok(/UNMEASURED, not broken/.test(riskMsg(evaluateModel(nex), RISK_CODES.REASONING_DEFAULT_UNSTATED)),
  '…whose message says UNMEASURED rather than implying the model is broken');

// The other four states are reachable and distinct.
ok(classifyReasoning({}).state === REASONING_STATES.ABSENT,
  'a record with NO reasoning key is ABSENT — distinct from "optional, unstated"');
ok(REASONING_STATES.ABSENT !== REASONING_STATES.OPTIONAL_DEFAULT_UNSTATED,
  '…and those two states are genuinely different values');
ok(classifyReasoning({ reasoning: { mandatory: true } }).state === REASONING_STATES.MANDATORY,
  'mandatory: true is MANDATORY');
ok(classifyReasoning({ reasoning: { mandatory: true, default_enabled: false } }).state === REASONING_STATES.MANDATORY,
  '…and mandatory wins over a contradictory default_enabled');
ok(classifyReasoning({ reasoning: { mandatory: false, default_enabled: true } }).state
  === REASONING_STATES.OPTIONAL_DEFAULT_ON, 'default_enabled: true is OPTIONAL_DEFAULT_ON');
ok(classifyReasoning({ reasoning: { mandatory: false, default_enabled: false } }).state
  === REASONING_STATES.OPTIONAL_DEFAULT_OFF, 'default_enabled: false is OPTIONAL_DEFAULT_OFF');
ok(classifyReasoning({ reasoning: 'yes' }).state === REASONING_STATES.MALFORMED, 'a non-object reasoning is MALFORMED');

ok(evaluateModel({ id: 'x/mandatory-reasoner', context_length: 400000,
  architecture: { output_modalities: ['text'] }, pricing: { prompt: '1', completion: '1' },
  top_provider: { context_length: 400000, max_completion_tokens: 100000 },
  supported_parameters: ['max_tokens', 'response_format'], reasoning: { mandatory: true } }).eligible === true,
  'even MANDATORY reasoning does not reject — it is risk, not a verdict');

// ─────────────────────────────────────────────────────────────────────────────
section('11. Rule 6 — expiry: six states, three of which used to be one');
// The brief: a REAL near date must REJECT, an ABSENT field must PASS, and the
// far-future SENTINEL must read as NEITHER an expiry NOR an absent field.
// Each has its own fixture below, and each fixture is real where a real one
// exists.
// ─────────────────────────────────────────────────────────────────────────────

// ── STATE 1 of 3: a REAL near date. It REJECTS. ──────────────────────────────
const kimi = byId(REAL_MODELS, 'moonshotai/kimi-k2.5');
ok(kimi.expiration_date === '2026-08-31', '⟨PREMISE⟩ kimi-k2.5 expires 2026-08-31 (3 days after the snapshot)');
ok(evaluateModel(kimi, { contextField: CONTEXT_FIELDS.HEADLINE, expiryHorizonDays: null }).eligible === true,
  '⟨PREMISE⟩ kimi-k2.5 passes every OTHER rule, so the expiry rule is the only thing that can reject it');
const kimiEv = evaluateModel(kimi, { now: SNAPSHOT_DAY });
ok(kimiEv.eligible === false,
  'by DEFAULT (30-day horizon, clock supplied) an imminently-expiring model is REJECTED');
ok(codesOf(kimiEv).includes(REASON_CODES.EXPIRING_WITHIN_HORIZON), '…on EXPIRING_WITHIN_HORIZON');
ok(kimiEv.facts.expiry.state === EXPIRY_STATES.DECLARED, '…in state DECLARED');
ok(Math.round(kimiEv.facts.expiry.daysRemaining) === 3,
  '…with the remaining days computed from the INJECTED clock, not an ambient one');
ok(DEFAULT_ELIGIBILITY_OPTS.expiryHorizonDays === 30, 'the default horizon is 30 days');
const kimiRisk = kimiEv.riskFlags.find(r => r.code === RISK_CODES.EXPIRY_DECLARED) || {};
ok(kimiRisk.severity === 'high', '…and the fact is ALSO risk-flagged at high severity, not only rejected');
// The horizon is a real parameter, not a constant baked into the branch.
ok(evaluateModel(kimi, { now: SNAPSHOT_DAY, expiryHorizonDays: 2 }).eligible === true,
  'the horizon is INJECTED — a 2-day horizon lets a 3-day expiry through');
ok(evaluateModel(kimi, { now: SNAPSHOT_DAY, expiryHorizonDays: null }).eligible === true,
  '…and a null horizon disables the rejection entirely (risk-flag only)');
ok(riskCodesOf(evaluateModel(kimi, { now: SNAPSHOT_DAY, expiryHorizonDays: null }))
  .includes(RISK_CODES.EXPIRY_DECLARED), '…while still surfacing the declared date');

// The knife edge: 33 days clears a 30-day horizon by three days.
const dots = byId(REAL_MODELS, 'dots-studio/dots-3-note-preview:free');
ok(dots.expiration_date === '2026-09-30', '⟨PREMISE⟩ dots-3-note-preview expires 33 days after the snapshot');
const dotsEv = evaluateModel(dots, { now: SNAPSHOT_DAY });
ok(dotsEv.eligible === true, 'a 33-day expiry SURVIVES the 30-day horizon — the boundary is real, not "any date rejects"');
ok(dotsEv.facts.expiry.state === EXPIRY_STATES.DECLARED, '…still in state DECLARED, because it is a real retirement date');
ok(riskCodesOf(dotsEv).includes(RISK_CODES.EXPIRY_DECLARED), '…and still risk-flagged, so the knife edge is visible');
ok(evaluateModel(dots, { now: SNAPSHOT_DAY, expiryHorizonDays: 40 }).eligible === false,
  '…and a 40-day horizon DOES reject it, so the pass above is a boundary result and not a dead branch');
// Boundary arithmetic, both sides, on the same record.
ok(evaluateModel(dots, { now: SNAPSHOT_DAY, expiryHorizonDays: 33 }).eligible === false,
  'the horizon comparison is INCLUSIVE: exactly 33 days against a 33-day horizon rejects');
ok(evaluateModel(dots, { now: SNAPSHOT_DAY, expiryHorizonDays: 32 }).eligible === true,
  '…and 32 does not — so the boundary sits exactly where the docblock says');

// ── STATE 2 of 3: ABSENT. It PASSES, and raises NOTHING. ─────────────────────
const solarExp = checkNotExpiring(byId(REAL_MODELS, 'upstage/solar-pro4'), { now: SNAPSHOT_DAY });
ok(byId(REAL_MODELS, 'upstage/solar-pro4').expiration_date === null,
  '⟨PREMISE⟩ solar-pro4 declares expiration_date: null');
ok(solarExp.pass === true, 'an ABSENT expiry passes');
ok(solarExp.facts.state === EXPIRY_STATES.ABSENT, '…in state ABSENT');
ok(solarExp.facts.hasExpiry === false && solarExp.facts.daysRemaining === null,
  '…with no date and no remaining lifetime');
ok(solarExp.risks.length === 0,
  '…and raises NO risk at all — the flag is not unconditional, so silence here means something');
ok(evaluateModel(byId(REAL_MODELS, 'upstage/solar-pro4'),
  { now: SNAPSHOT_DAY, expiryHorizonDays: 3650 }).eligible === true,
  '…and no horizon, however wide, can reject a model that declares nothing');
// An EMPTY STRING is not a declaration. `Date.parse('')` is NaN exactly as for
// 'soon', so without this case the two would collapse into one branch.
const emptyExp = checkNotExpiring(byId(SYNTHETIC_MODELS, 'synthetic/empty-string-expiry'), { now: SNAPSHOT_DAY });
ok(emptyExp.facts.state === EXPIRY_STATES.ABSENT,
  'an EMPTY-STRING expiration_date reads as ABSENT — an empty string is not a declaration');
ok(emptyExp.risks.length === 0, '…and therefore raises nothing');

// ── STATE 3 of 3: the SENTINEL. Neither an expiry nor an absent field. ───────
const flashSent = byId(REAL_MODELS, 'z-ai/glm-5.3-flash');
ok(flashSent.expiration_date === '2098-12-31',
  '⟨PREMISE⟩ glm-5.3-flash publishes 2098-12-31 — the "no planned retirement" sentinel several z-ai models use');
const sentEv = evaluateModel(flashSent, { now: SNAPSHOT_DAY });
ok(sentEv.eligible === true, 'the SENTINEL does not reject');
ok(sentEv.facts.expiry.state === EXPIRY_STATES.SENTINEL, '…and is classified SENTINEL');
ok(DEFAULT_ELIGIBILITY_OPTS.expirySentinelDays === 3650, 'the default sentinel threshold is 10 years');
ok(Math.round(sentEv.facts.expiry.daysRemaining) === 26423,
  '…~26,400 days out, three orders of magnitude beyond any real expiry in the catalogue');

// It must read as NEITHER of the other two. Both halves asserted, both directions.
ok(sentEv.facts.expiry.state !== EXPIRY_STATES.DECLARED
  && !riskCodesOf(sentEv).includes(RISK_CODES.EXPIRY_DECLARED),
  'the sentinel does NOT read as an expiry: different state, and NOT EXPIRY_DECLARED');
ok(sentEv.facts.expiry.state !== EXPIRY_STATES.ABSENT
  && riskCodesOf(sentEv).includes(RISK_CODES.EXPIRY_SENTINEL)
  && sentEv.facts.expiry.hasExpiry === true,
  '…and does NOT read as an absent field either: it carries a date and its own EXPIRY_SENTINEL flag');
ok(sentEv.facts.expiry.isSentinel === true
  && evaluateModel(dots, { now: SNAPSHOT_DAY }).facts.expiry.isSentinel === false
  && solarExp.facts.isSentinel === false,
  '…and facts.isSentinel separates it from BOTH neighbours (true here, false for a real date and for absence)');
ok(RISK_CODES.EXPIRY_SENTINEL !== RISK_CODES.EXPIRY_DECLARED,
  'the sentinel and declared codes are genuinely distinct values');
// The three states produce three DIFFERENT messages, so a human reading the
// output is not left to infer the distinction from a code alone.
const sentMsg = riskMsg(sentEv, RISK_CODES.EXPIRY_SENTINEL);
ok(/no planned retirement/.test(sentMsg),
  '…and the sentinel message says what the date MEANS, not just what it is');
ok(sentMsg !== riskMsg(dotsEv, RISK_CODES.EXPIRY_DECLARED),
  '…and differs from the message a real date produces');
// The sentinel threshold is injected and genuinely read.
ok(evaluateModel(flashSent, { now: SNAPSHOT_DAY, expirySentinelDays: 99999999 })
   .facts.expiry.state === EXPIRY_STATES.DECLARED,
  'raising the sentinel threshold above the date reclassifies it as DECLARED — the threshold is a parameter');
ok(evaluateModel(dots, { now: SNAPSHOT_DAY, expirySentinelDays: 10 })
   .facts.expiry.state === EXPIRY_STATES.SENTINEL,
  '…and lowering it below a real date reclassifies THAT as a sentinel, so the comparison is live in both directions');
// An INCOHERENT config must not become a silent pass.
const incoherent = evaluateModel(kimi, { now: SNAPSHOT_DAY, expiryHorizonDays: 30, expirySentinelDays: 1 });
ok(incoherent.eligible === false && codesOf(incoherent).includes(REASON_CODES.EXPIRING_WITHIN_HORIZON),
  'with expirySentinelDays BELOW the horizon, REJECTION WINS — an incoherent config never turns into a pass');

// ── The fourth and fifth states: we could not evaluate. FLAG, never pass silently.
const kimiNoClock = evaluateModel(kimi, { now: null });
ok(kimiNoClock.eligible === true,
  'with the horizon set but NO clock, nothing is rejected — rejection is proof-based and we have no proof');
ok(kimiNoClock.facts.expiry.state === EXPIRY_STATES.CLOCK_UNKNOWN, '…in state CLOCK_UNKNOWN');
ok(!riskCodesOf(kimiNoClock).includes(RISK_CODES.EXPIRY_DECLARED),
  '…and it does NOT claim a declared-expiry verdict it could not compute');
const noClockRisk = kimiNoClock.riskFlags.find(r => r.code === RISK_CODES.EXPIRY_UNEVALUABLE);
ok(noClockRisk !== undefined, '…but it DOES raise EXPIRY_UNEVALUABLE — the inability to evaluate is never silent');
ok(noClockRisk.severity === 'high',
  '…at HIGH severity, because a horizon was active and the rule the caller asked for could not run');
ok(noClockRisk.detail.reason === 'clock-unknown', '…with the reason named machine-readably');
ok(evaluateModel(kimi, { now: null, expiryHorizonDays: null }).riskFlags
   .find(r => r.code === RISK_CODES.EXPIRY_UNEVALUABLE).severity === 'medium',
  '…and at MEDIUM when no horizon is active, so the severity tracks what was actually at stake');
// A MALFORMED date used to be byte-indistinguishable from an absent one.
const malformed = checkNotExpiring(byId(SYNTHETIC_MODELS, 'synthetic/malformed-expiry'), { now: SNAPSHOT_DAY });
ok(malformed.facts.state === EXPIRY_STATES.MALFORMED,
  'a non-empty unparseable expiration_date is MALFORMED');
ok(malformed.pass === true, '…and does not reject — we cannot prove an expiry we cannot read');
ok(malformed.risks.some(r => r.code === RISK_CODES.EXPIRY_UNEVALUABLE
  && r.severity === 'high' && r.detail.reason === 'unparseable-date'),
  '…but raises EXPIRY_UNEVALUABLE at high severity, naming the reason');
ok(malformed.facts.state !== emptyExp.facts.state && malformed.risks.length !== emptyExp.risks.length,
  '…and is DISTINGUISHABLE from an empty string, which is the collapse this branch exists to prevent');

// ── The sixth state: already dead. Its own code. ─────────────────────────────
const dead = evaluateModel(byId(SYNTHETIC_MODELS, 'synthetic/already-expired'), { now: SNAPSHOT_DAY });
ok(dead.eligible === false, 'a model whose expiry is already PAST is rejected');
ok(dead.facts.expiry.state === EXPIRY_STATES.EXPIRED, '…in state EXPIRED');
ok(codesOf(dead).includes(REASON_CODES.EXPIRED), '…on EXPIRED');
ok(!codesOf(dead).includes(REASON_CODES.EXPIRING_WITHIN_HORIZON),
  '…and NOT on EXPIRING_WITHIN_HORIZON — "has stopped working" is not "will stop working"');
ok(REASON_CODES.EXPIRED !== REASON_CODES.EXPIRING_WITHIN_HORIZON, '…and the two codes are distinct values');
ok(dead.facts.expiry.daysRemaining < 0, '…with a NEGATIVE remaining lifetime, carried through rather than clamped');
ok(/in the PAST/.test(riskMsg(dead, RISK_CODES.EXPIRY_DECLARED)),
  '…and a message that says so rather than reporting negative days as a countdown');

// ── Every state is reachable in this corpus. Without this the assertions above
//    could all be satisfied by a corpus in which most branches never fire.
const seenStates = new Set([...REAL_MODELS, ...SYNTHETIC_MODELS]
  .map(m => checkNotExpiring(m, { now: SNAPSHOT_DAY }).facts.state));
for (const st of [EXPIRY_STATES.ABSENT, EXPIRY_STATES.DECLARED, EXPIRY_STATES.EXPIRED, EXPIRY_STATES.SENTINEL]) {
  ok(seenStates.has(st), `⟨NON-VACUITY⟩ state ${st} is reachable with a clock in this corpus`);
}
const seenNoClock = new Set([...REAL_MODELS, ...SYNTHETIC_MODELS]
  .map(m => checkNotExpiring(m, {}).facts.state));
ok(seenNoClock.has(EXPIRY_STATES.CLOCK_UNKNOWN), '⟨NON-VACUITY⟩ state clock-unknown is reachable without a clock');
ok(seenStates.has(EXPIRY_STATES.MALFORMED), '⟨NON-VACUITY⟩ state malformed is reachable in this corpus');
ok(new Set(Object.values(EXPIRY_STATES)).size === 6, 'EXPIRY_STATES declares six distinct states');

// ── Text output stays opt-in. ────────────────────────────────────────────────

const imageOnly = byId(SYNTHETIC_MODELS, 'synthetic/image-only-output');
ok(evaluateModel(imageOnly).eligible === true, 'a text-less model is eligible by DEFAULT');
ok(riskCodesOf(evaluateModel(imageOnly)).includes(RISK_CODES.NO_TEXT_OUTPUT_DECLARED), '…but risk-flagged');
ok(evaluateModel(imageOnly, { requireTextOutput: true }).eligible === false,
  '…and rejected once requireTextOutput is set');
ok(checkTextOutput(byId(REAL_MODELS, 'upstage/solar-pro4'), { requireTextOutput: true }).pass === true,
  'a text-emitting model passes the opt-in rule');
ok(checkNotExpiring(byId(REAL_MODELS, 'upstage/solar-pro4'), {}).risks.length === 0,
  'a model with no expiry raises no expiry risk (the flag is not unconditional)');

// ─────────────────────────────────────────────────────────────────────────────
section('12. Fact-vs-verdict boundary, and purity');
// ─────────────────────────────────────────────────────────────────────────────

const ev = evaluateModel(solar);
ok(!('score' in ev) && !('rank' in ev) && !('recommended' in ev) && !('quality' in ev),
  'evaluateModel emits no score, rank, recommendation or quality field');
ok(ev.reasons.every(r => typeof r.code === 'string' && typeof r.message === 'string'),
  'every reason carries BOTH a machine-readable code and a human string');
ok(evaluateModel(fusion).reasons.every(r => RULE_ORDER.includes(r.rule)),
  'every reason names a rule from RULE_ORDER');
ok(evaluateModel(fusion).reasons.every(r => Object.values(REASON_CODES).includes(r.code)),
  'every reason code is a declared REASON_CODES member');
ok(evaluateModel(nex).riskFlags.every(r => Object.values(RISK_CODES).includes(r.code)),
  'every risk code is a declared RISK_CODES member');
ok(evaluateModel(nex).riskFlags.every(r => r.severity !== 'reject'),
  'no risk flag ever carries reject severity');

// Purity: identical inputs give identical outputs, and no ambient clock is read.
const a1 = JSON.stringify(evaluateModel(solar, { now: MON_08_00 }));
const a2 = JSON.stringify(evaluateModel(solar, { now: MON_08_00 }));
ok(a1 === a2, 'evaluateModel is deterministic for identical inputs');
const noClock = JSON.stringify(evaluateModel(dsPro, { now: null }));
ok(noClock === JSON.stringify(evaluateModel(dsPro, { now: null })),
  'a time-sensitive model with now: null is still deterministic (no ambient Date.now)');
ok(JSON.stringify(evaluateModel(dsPro, { now: TUE_02_00 })) !== noClock,
  '…and genuinely differs when a clock IS injected, so the null path is not ignoring it');

// Input records are never mutated.
const before = JSON.stringify(qwenFlash);
evaluateModel(qwenFlash, { endpointsById: REAL_ENDPOINTS });
filterCatalogue(REAL_MODELS, { now: MON_08_00 });
ok(JSON.stringify(qwenFlash) === before, 'evaluating a record does not mutate it');

// Defaults are frozen so a caller cannot poison every later evaluation.
ok(Object.isFrozen(DEFAULT_ELIGIBILITY_OPTS), 'DEFAULT_ELIGIBILITY_OPTS is frozen');
ok(Object.isFrozen(REASON_CODES) && Object.isFrozen(RISK_CODES) && Object.isFrozen(RULE_ORDER),
  'the exported code tables are frozen');
ok(DEFAULT_ELIGIBILITY_OPTS.outputFloorTokens === APP_OUTPUT_FLOOR_TOKENS
  && DEFAULT_ELIGIBILITY_OPTS.contextFloorTokens === APP_CONTEXT_FLOOR_TOKENS
  && DEFAULT_ELIGIBILITY_OPTS.promptTokens === APP_INGEST_PROMPT_TOKENS_APPROX,
  'the defaults object uses the documented named constants');
ok(DEFAULT_ELIGIBILITY_OPTS.requireTextOutput === false,
  'text_output is the one remaining opt-in rule and is OFF by default');
ok(DEFAULT_ELIGIBILITY_OPTS.expiryHorizonDays === 30
  && DEFAULT_ELIGIBILITY_OPTS.expirySentinelDays === 3650,
  'expiry rejects by default at a 30-day horizon, with a 10-year sentinel threshold');
ok(DEFAULT_ELIGIBILITY_OPTS.now === null,
  'the clock is NOT defaulted — this module never invents an instant');
ok(DEFAULT_ELIGIBILITY_OPTS.expirySentinelDays > DEFAULT_ELIGIBILITY_OPTS.expiryHorizonDays,
  '…and the sentinel threshold sits above the horizon, so the two cannot overlap in the shipped config');
// filterCatalogue must echo every threshold it used, or a funnel is unreadable.
for (const key of ['outputFloorTokens', 'contextFloorTokens', 'promptTokens', 'contextField',
                   'expiryHorizonDays', 'expirySentinelDays', 'requireTextOutput']) {
  ok(Object.hasOwn(filterCatalogue([], {}).opts, key),
    `the funnel echoes the ${key} it ran with`);
}
ok(filterCatalogue([], {}).opts.contextField === CONTEXT_FIELDS.TOP_PROVIDER
  && filterCatalogue([], { contextField: CONTEXT_FIELDS.HEADLINE }).opts.contextField === CONTEXT_FIELDS.HEADLINE,
  '…echoing the value actually in force, not a constant');

// Defensive inputs never throw.
for (const bad of [null, undefined, 5, 'x', [], { id: 42 }, { id: 'x/y', pricing: null }]) {
  let threw = false;
  try { evaluateModel(bad); } catch { threw = true; }
  ok(!threw, `evaluateModel does not throw on ${JSON.stringify(bad) ?? String(bad)}`);
}
let threwPrice = false;
try { effectivePriceAt(null, null, { now: 'garbage' }); } catch { threwPrice = true; }
ok(!threwPrice, 'effectivePriceAt does not throw on a null record and a garbage clock');
ok(effectivePriceAt(null, null).known === false, '…and reports known: false rather than a fabricated price');

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('All OpenRouter eligibility assertions green.');
