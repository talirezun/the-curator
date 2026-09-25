/**
 * test-ai-run.js — OFFLINE suite for the AI-jobs foundation (v3.67.0, package J).
 *
 *   §1  AI_JOBS: the binding copy, frozen, buildLaneJobs / aiJob, the brain
 *       re-export is the SAME object as the served module.
 *   §2  THE CENSUS: every module under src/, mcp/ and bin/ that imports
 *       `generateText` from llm.js maps to an AI_JOBS row or to AI_UNROUTED.
 *       Found by WALKING the tree and PARSING import statements (named,
 *       aliased, multi-line, namespace-plus-member, dynamic), never from a hand
 *       list — with a planted-violation control that must be caught in every
 *       shape, and a comment-only mention that must not.
 *   §3  describeRun: priced point and range, free, unpriced (runs, NO usd
 *       fields), latency present only when measured, no key, the real no-key
 *       sentence and its load-bearing prefix.
 *   §4  spentFromUsage === the batch queue's chargeForItem over the same totals,
 *       across a grid of models and cache shapes; unpriced → usd null.
 *   §5  A REAL generateText run (Anthropic client replaced through the llm.js
 *       seam) that walks the fallback chain: the accumulated totals price at
 *       the rung that billed, and fallbackFrom names the model the user chose.
 *   §6  Zero network: fetch and https.request are trapped for the whole run.
 *
 * Isolation: user data in a tempdir via __setUserDataDirOverride, every
 * provider key and LLM_MODEL removed from this process's env before the first
 * resolution. No LLM call leaves the process; no real config is read.
 */

import { readFileSync, readdirSync, statSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

// ── ZERO NETWORK, from the first line ───────────────────────────────────────
let networkAttempts = 0;
globalThis.fetch = async () => { networkAttempts++; throw new Error('network is forbidden in an offline suite'); };
for (const mod of [https, http]) {
  mod.request = () => { networkAttempts++; throw new Error('network is forbidden in an offline suite'); };
  mod.get = () => { networkAttempts++; throw new Error('network is forbidden in an offline suite'); };
}
for (const k of ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'LLM_MODEL']) delete process.env[k];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const { __setUserDataDirOverride } = await import('../src/brain/paths.js');
const llm = await import('../src/brain/llm.js');
const { getModelPrice, isFreeModel, generateText, __setAnthropicClientFactory, getProviderInfo } = llm;
const { estimateInputTokens } = await import('../src/brain/compile-estimate.js');
const { makeUsageAccumulator } = await import('../src/brain/ingest.js');
const { __testing: queueTesting } = await import('../src/brain/ingest-queue.js');
const brainJobs = await import('../src/brain/ai-jobs.js');
const servedJobs = await import('../src/public/next/shared/ai-jobs.js');
const { describeRun, spentFromUsage } = await import('../src/brain/ai-run.js');
// v3.72.1 — a synthetic free id, registered in §3f (see there for why).
const FREE_FIXTURE = 'zz-vendor/zz-free-fixture:free';
const { AI_JOBS, AI_UNROUTED, buildLaneJobs, aiJob } = brainJobs;
const { chargeForItem } = queueTesting;

let passed = 0, failed = 0;
function ok(cond, label, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}
function eq(a, b, label) { ok(a === b, `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function section(t) { console.log(`\n${t}`); }

const TMP = mkdtempSync(path.join(tmpdir(), 'curator-test-ai-run-'));
function useConfig(cfg) {
  writeFileSync(path.join(TMP, '.curator-config.json'), JSON.stringify(cfg));
}
__setUserDataDirOverride(TMP);

try {
// ═════════════════════════════════════════════════════════════════════════
section('1. AI_JOBS — the binding copy, frozen, one table behind two doors');
{
  const BINDING = [
    ['ingest', 'Ingest', 'Domains › ① Ingest', 'build', 'json', 'before (batch) · after', ['src/brain/ingest.js']],
    ['compile', 'Compile to wiki', 'Chat › Compile', 'build', 'json', 'before · after', ['src/brain/compile.js']],
    ['wiki-health', 'Wiki health', 'Domains › ⑤ Wiki health', 'build', 'json', 'before · after', ['src/brain/health-ai.js']],
    ['shared-brain', 'Shared Brain push & synthesis', 'Domains › ④ Shared Brain', 'build', 'json', 'after (v3.67.1)', ['src/brain/sharedbrain-delta.js', 'src/brain/sharedbrain-synthesis.js']],
    ['reading-plan', 'Suggest a reading plan', 'Context › ① Documents', 'build', 'json', 'before · after', ['src/brain/reading-plan.js']],
    ['system-check', 'System check', 'Settings › General', 'build', 'text', 'before', ['src/brain/diagnostics.js']],
    ['chat', 'Chat', 'Chat composer', 'chat', 'text', 'after', ['src/brain/chat.js']],
  ];
  eq(AI_JOBS.length, BINDING.length, 'seven jobs, in the contract\'s order');
  BINDING.forEach(([id, label, startedFrom, lane, mode, costShown, modules], i) => {
    const r = AI_JOBS[i] || {};
    ok(r.id === id && r.label === label && r.startedFrom === startedFrom && r.lane === lane
      && r.mode === mode && r.costShown === costShown
      && JSON.stringify(r.modules) === JSON.stringify(modules),
      `row ${i + 1} "${id}" carries the picture's copy verbatim`, JSON.stringify(r));
  });
  ok(Object.isFrozen(AI_JOBS) && AI_JOBS.every((r) => Object.isFrozen(r) && Object.isFrozen(r.modules)),
    'AI_JOBS, every row and every modules list is frozen');
  ok(Object.isFrozen(AI_UNROUTED) && AI_UNROUTED.every((r) => Object.isFrozen(r)), 'AI_UNROUTED is frozen');
  eq(AI_UNROUTED.map((r) => r.module).join(','), 'src/brain/query.js,src/brain/health-ai.js,mcp/tools/compile.js',
    'AI_UNROUTED names the three dead surfaces');
  const lane = buildLaneJobs();
  eq(lane.length, 6, 'buildLaneJobs() — "Used by · 6 jobs"');
  ok(lane.every((j) => j.lane === 'build') && !lane.some((j) => j.id === 'chat'), 'the build lane excludes Chat');
  eq(aiJob('compile'), AI_JOBS[1], 'aiJob finds a row by id');
  for (const bad of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', '', null, undefined, 42, 'nope']) {
    eq(aiJob(bad), null, `aiJob(${JSON.stringify(bad)}) is null`);
  }
  ok(brainJobs.AI_JOBS === servedJobs.AI_JOBS && brainJobs.aiJob === servedJobs.aiJob,
    'src/brain/ai-jobs.js re-exports the SERVED module (one table, not a copy)');
  const servedSrc = readFileSync(path.join(ROOT, 'src/public/next/shared/ai-jobs.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(!/\bimport\b/.test(servedSrc), 'the served module imports nothing (pure data, loadable by any view)');
}

// ═════════════════════════════════════════════════════════════════════════
section('2. THE CENSUS — every module importing generateText maps to a job or to AI_UNROUTED');
const SKIP_DIRS = new Set(['node_modules', '.git', 'public']);
function walk(dir, out = []) {
  let ents;
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p, out); }
    else if (/\.(m?js|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}
/** Strip comments so a docblock naming generateText is not an import. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'`\\])\/\/.*$/gm, '$1');
}
/**
 * True when the module can reach llm.js's generateText: a named import
 * (optionally aliased, any line breaks), a namespace import used as
 * `<ns>.generateText`, a default import used the same way, or a dynamic
 * import of llm.js whose file mentions generateText.
 */
function importsGenerateText(src) {
  const s = stripComments(src);
  const LLM = String.raw`["'][^"']*\bllm\.js["']`;
  for (const m of s.matchAll(new RegExp(String.raw`import\s*\{([^}]*)\}\s*from\s*` + LLM, 'g'))) {
    if (/\bgenerateText\b/.test(m[1])) return true;
  }
  for (const m of s.matchAll(new RegExp(String.raw`import\s+(?:\w+\s*,\s*)?\*\s*as\s+(\w+)\s+from\s*` + LLM, 'g'))) {
    if (new RegExp('\\b' + m[1] + String.raw`\s*\.\s*generateText\b`).test(s)) return true;
    if (new RegExp('\\b' + m[1] + String.raw`\s*\[\s*["']generateText["']\s*\]`).test(s)) return true;
  }
  for (const m of s.matchAll(new RegExp(String.raw`import\s+(\w+)\s+from\s*` + LLM, 'g'))) {
    if (new RegExp('\\b' + m[1] + String.raw`\s*\.\s*generateText\b`).test(s)) return true;
  }
  if (new RegExp(String.raw`import\s*\(\s*` + LLM + String.raw`\s*\)`).test(s) && /\bgenerateText\b/.test(s)) return true;
  if (new RegExp(String.raw`export\s*\{[^}]*\bgenerateText\b[^}]*\}\s*from\s*` + LLM).test(s)) return true;
  return false;
}
/** Map a census over a tree; returns {callers, unmapped}. */
function census(rootDir, jobs, unrouted) {
  const mapped = new Set([...jobs.flatMap((j) => j.modules), ...unrouted.map((u) => u.module)]);
  const callers = [];
  const unmapped = [];
  for (const dir of ['src', 'mcp', 'bin']) {
    for (const f of walk(path.join(rootDir, dir))) {
      const rel = path.relative(rootDir, f).split(path.sep).join('/');
      if (rel === 'src/brain/llm.js') continue;              // the definition, not a caller
      if (!importsGenerateText(readFileSync(f, 'utf8'))) continue;
      callers.push(rel);
      if (!mapped.has(rel)) unmapped.push(rel);
    }
  }
  return { callers: callers.sort(), unmapped };
}
{
  // ── The planted-violation control, FIRST: the detector must catch every
  // shape before its silence on the real tree means anything.
  const PLANT = mkdtempSync(path.join(tmpdir(), 'curator-ai-census-plant-'));
  try {
    mkdirSync(path.join(PLANT, 'src', 'brain'), { recursive: true });
    mkdirSync(path.join(PLANT, 'mcp', 'tools'), { recursive: true });
    mkdirSync(path.join(PLANT, 'bin'), { recursive: true });
    const shapes = {
      'src/brain/named.js': "import { generateText } from './llm.js';\n",
      'src/brain/aliased.js': "import { isFreeModel, generateText as gen } from './llm.js';\n",
      'src/brain/multiline.js': "import {\n  isAbortError,\n  generateText,\n} from './llm.js';\n",
      'src/brain/namespace.js': "import * as L from './llm.js';\nexport const f = () => L.generateText('a','b');\n",
      'src/brain/dynamic.js': "export async function f(){ const m = await import('./llm.js'); return m.generateText('a','b'); }\n",
      'src/brain/reexport.js': "export { generateText } from './llm.js';\n",
      'mcp/tools/deep.js': "import { generateText } from '../../src/brain/llm.js';\n",
      'bin/tool.js': "import { generateText } from '../src/brain/llm.js';\n",
    };
    const innocent = {
      'src/brain/comment-only.js': "// generateText is called by compile.js via opts.generateText\n/* import { generateText } from './llm.js' */\nexport const x = 1;\n",
      'src/brain/other-import.js': "import { getModelPrice } from './llm.js';\nexport const y = 'generateText';\n",
      'src/brain/namespace-unused.js': "import * as L from './llm.js';\nexport const z = L.getModelPrice;\n",
    };
    for (const [rel, body] of Object.entries({ ...shapes, ...innocent })) writeFileSync(path.join(PLANT, rel), body);
    const r = census(PLANT, [], []);
    for (const rel of Object.keys(shapes)) ok(r.unmapped.includes(rel), `CONTROL: a planted ${rel} is caught as unmapped`);
    for (const rel of Object.keys(innocent)) ok(!r.callers.includes(rel), `CONTROL: ${rel} is not an AI caller`);
    const mappedRun = census(PLANT, [{ modules: Object.keys(shapes) }], []);
    eq(mappedRun.unmapped.length, 0, 'CONTROL: the same plants, mapped to a job, pass');
  } finally { rmSync(PLANT, { recursive: true, force: true }); }

  // ── The real tree.
  const r = census(ROOT, AI_JOBS, AI_UNROUTED);
  console.log('    callers found by walking: ' + r.callers.join(', '));
  ok(r.callers.length >= 8, `the walk found the AI callers (${r.callers.length})`);
  ok(r.unmapped.length === 0, 'every module importing generateText maps to an AI_JOBS row or AI_UNROUTED',
    'unmapped: ' + r.unmapped.join(', '));
  // Every row's modules exist — except reading-plan.js, which package H adds
  // (and whose own suite asserts this row).
  for (const j of AI_JOBS) {
    for (const m of j.modules) {
      if (m === 'src/brain/reading-plan.js') continue;
      ok(existsSync(path.join(ROOT, m)), `${j.id}: ${m} exists`);
      ok(r.callers.includes(m), `${j.id}: ${m} really imports generateText (the row is not stale)`);
    }
  }
  for (const u of AI_UNROUTED) {
    ok(existsSync(path.join(ROOT, u.module)) && r.callers.includes(u.module),
      `AI_UNROUTED ${u.module} exists and still imports generateText (remove the row with the surface)`);
    for (const fn of u.functions || []) {
      ok(new RegExp('function\\s+' + fn + '\\b').test(readFileSync(path.join(ROOT, u.module), 'utf8')),
        `AI_UNROUTED ${u.module}: ${fn} still exists`);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('3. describeRun — one estimate shape, absent means omitted');
{
  // 3a. No key at all → the no-key shape, exactly.
  useConfig({});
  const nk = describeRun({ job: 'reading-plan', inputChars: 24000, outputTokensLow: 400, outputTokensHigh: 900 });
  eq(JSON.stringify(nk), JSON.stringify({ job: 'reading-plan', jobLabel: 'Suggest a reading plan', needsKey: true }),
    'no key: {job, jobLabel, needsKey:true} and nothing else');
  let msg = null;
  try { getProviderInfo(); } catch (e) { msg = e.message; }
  eq(msg, 'No LLM API key found. Add one in Settings › Providers & keys (Gemini, Anthropic or OpenRouter), '
    + 'or set GEMINI_API_KEY / ANTHROPIC_API_KEY in .env.', 'the REAL no-key throw names Providers & keys and all three providers');
  ok(typeof msg === 'string' && msg.startsWith('No LLM API key found.'),
    'the prefix three suites key on ("No LLM API key found.") is unchanged');

  // 3b. Priced, Gemini default.
  useConfig({ geminiApiKey: 'zz-test-dummy-key-not-real', activeProvider: 'gemini' });
  const info = getProviderInfo();
  const price = getModelPrice(info.model);
  const est = estimateInputTokens(24000, info.provider, info.model);
  const pr = describeRun({ job: 'reading-plan', inputChars: 24000, outputTokensLow: 400, outputTokensHigh: 900 });
  eq(pr.needsKey, false, 'priced: needsKey false');
  eq(pr.provider, 'gemini', 'priced: provider');
  eq(pr.providerLabel, 'Gemini', 'priced: providerLabel');
  eq(pr.model, info.model, 'priced: the model getProviderInfo resolves');
  const entry = llm.listOfferableModels('gemini').find((e) => e.id === info.model);
  eq(pr.modelLabel, entry.label, 'priced: modelLabel is the offerable entry\'s human label');
  eq(pr.inputTokensLow, est.low, 'priced: input low = estimateInputTokens (one tokenizer model)');
  eq(pr.inputTokensHigh, est.high, 'priced: input high = estimateInputTokens');
  eq(pr.inputTokens, Math.round((est.low + est.high) / 2), 'priced: inputTokens is the point');
  const wantLow = Math.round(((est.low / 1e6) * price.input + (400 / 1e6) * price.output) * 1e6) / 1e6;
  const wantHigh = Math.round(((est.high / 1e6) * price.input + (900 / 1e6) * price.output) * 1e6) / 1e6;
  eq(pr.usdLow, wantLow, 'priced: usdLow from the live price table');
  eq(pr.usdHigh, wantHigh, 'priced: usdHigh from the live price table');
  ok(pr.usdLow > 0 && pr.usdHigh >= pr.usdLow, 'priced: a real, ordered range');
  eq(pr.priceKnown, true, 'priced: priceKnown');
  eq(pr.free, false, 'priced: not free');
  eq(pr.costNote, 'priced', 'priced: costNote');
  ok(!('medianLatencyMs' in pr), 'latency ABSENT when the model has no measurement (omitted, never 0)');
  eq(pr.jobLabel, 'Suggest a reading plan', 'jobLabel from AI_JOBS');

  // 3c. A point: equal ends in, equal ends out.
  const pt = describeRun({ job: 'compile', inputTokensLow: 5000, inputTokensHigh: 5000, outputTokensLow: 800 });
  eq(pt.inputTokensLow, 5000, 'caller-supplied input tokens are used as given');
  eq(pt.outputTokensHigh, 800, 'one output figure given is a point');
  eq(pt.usdLow, pt.usdHigh, 'a point estimate has equal ends');

  // 3d. Input without output: no money (never quote the cheap half as the whole).
  const half = describeRun({ job: 'compile', inputChars: 10000 });
  ok('inputTokens' in half && !('usdLow' in half) && !('usdHigh' in half) && !('outputTokensLow' in half),
    'input known, output unknown → tokens shown, NO usd fields');
  const rest = describeRun({ job: 'wiki-health' });
  ok(!('inputTokens' in rest) && !('usdHigh' in rest) && rest.priceKnown === true && rest.costNote === 'priced',
    'no figures at all (a resting button) → model + price posture only');
  eq(describeRun({ job: 'nope' }).jobLabel, null, 'an unknown job id gets jobLabel null, not a throw');

  // 3e. UNPRICED: runs, says so, carries NO usd fields.
  process.env.LLM_MODEL = 'zz-genuinely-unpriced-model-id';
  const up = describeRun({ job: 'reading-plan', inputChars: 24000, outputTokensLow: 400, outputTokensHigh: 900 });
  eq(up.needsKey, false, 'unpriced: it RUNS (no refusal, no needsKey)');
  eq(up.model, 'zz-genuinely-unpriced-model-id', 'unpriced: the model is named');
  eq(up.modelLabel, 'zz-genuinely-unpriced-model-id', 'unpriced: an uncatalogued model is labelled by its id');
  ok(!('usdLow' in up) && !('usdHigh' in up), 'unpriced: no usd fields');
  eq(up.priceKnown, false, 'unpriced: priceKnown false');
  eq(up.free, false, 'unpriced: not free');
  eq(up.costNote, 'price-not-published', 'unpriced: costNote price-not-published');
  ok(typeof up.inputTokens === 'number' && up.outputTokensHigh === 900, 'unpriced: token figures are still shown');
  delete process.env.LLM_MODEL;

  // 3f. FREE: zero is the measurement.
  useConfig({ openrouterApiKey: 'zz-test-dummy-key-not-real', activeProvider: 'openrouter' });
  // v3.72.1: 'minimax/minimax-m3:free' was the one SHIPPED free id; OpenRouter
  // withdrew it and it left the table (2026-09-25). A synthetic `:free` id
  // registered through the real offer factory is the same membership.
  llm.__testing.defineOfferableModel('openrouter', {
    id: FREE_FIXTURE, label: 'Free Fixture', thinks: false, tokenizerFactor: 1.0,
    suitability: 'chat-only', maxOutput: 32768, free: true,
    note: 'Synthetic free id for the free-cost arm.',
  });
  process.env.LLM_MODEL = FREE_FIXTURE;
  ok(isFreeModel(FREE_FIXTURE), 'fixture: the synthetic :free id is free by membership');
  const fr = describeRun({ job: 'reading-plan', inputChars: 24000, outputTokensLow: 400, outputTokensHigh: 900 });
  eq(fr.free, true, 'free: free');
  eq(fr.usdLow, 0, 'free: usdLow 0');
  eq(fr.usdHigh, 0, 'free: usdHigh 0');
  eq(fr.priceKnown, true, 'free: the cost is known (it is nothing)');
  eq(fr.costNote, 'free', 'free: costNote');
  eq(fr.providerLabel, 'OpenRouter', 'free: providerLabel');
  delete process.env.LLM_MODEL;

  // 3g. LATENCY present only when measured — OpenRouter's default carries one.
  const lat = describeRun({ job: 'reading-plan', inputChars: 24000, outputTokensLow: 400, outputTokensHigh: 900 });
  const orEntry = llm.listOfferableModels('openrouter').find((e) => e.id === lat.model);
  ok(orEntry && Number.isFinite(orEntry.medianLatencyMs), `fixture: ${lat.model} has a measured latency`);
  eq(lat.medianLatencyMs, orEntry && orEntry.medianLatencyMs, 'latency: the offerable entry\'s measured figure');
  eq(lat.costNote, 'priced', 'latency case is a priced model');
}

// ═════════════════════════════════════════════════════════════════════════
section('4. spentFromUsage === the batch queue\'s chargeForItem, over the same totals');
{
  useConfig({ geminiApiKey: 'zz-test-dummy-key-not-real', activeProvider: 'gemini' });
  const MODELS = [
    ['gemini', 'gemini-2.5-flash-lite'], ['gemini', 'gemini-2.5-flash'],
    ['anthropic', 'claude-haiku-4-5'], ['anthropic', 'claude-sonnet-5'],
    ['openrouter', 'upstage/solar-pro4'], ['openrouter', FREE_FIXTURE],
  ];
  const SHAPES = [
    { inputTokens: 5812, outputTokens: 640 },
    { inputTokens: 1200, outputTokens: 300, cachedReadTokens: 41822 },
    { inputTokens: 900, outputTokens: 2100, cachedReadTokens: 250932, cacheWriteTokens: 41822 },
    { inputTokens: 0, outputTokens: 0 },
    { inputTokens: 7, outputTokens: 1, cacheWriteTokens: 16000 },
  ];
  let cases = 0, agree = 0;
  const bad = [];
  for (const [provider, model] of MODELS) {
    for (const shape of SHAPES) {
      const totals = { calls: 3, cachedReadTokens: 0, cacheWriteTokens: 0, ...shape, provider, model };
      const job = { items: [], estimate: null };
      const want = chargeForItem(job, { tokenUsage: totals });
      const got = spentFromUsage(totals);
      cases++;
      if (typeof got.usd === 'number' && Math.abs(got.usd - want) < 1e-12 && job.spendIsEstimated !== true) agree++;
      else bad.push(`${model} ${JSON.stringify(shape)} → ${got.usd} vs ${want}`);
    }
  }
  eq(agree, cases, `spentFromUsage agrees with chargeForItem on all ${cases} cases`);
  if (bad.length) console.log('    ' + bad.join('\n    '));
  // The cached-read term is really exercised (a vacuous grid would agree on zeros).
  const a = spentFromUsage({ calls: 1, inputTokens: 0, outputTokens: 0, cachedReadTokens: 1e6, cacheWriteTokens: 0, provider: 'anthropic', model: 'claude-haiku-4-5' });
  const g = spentFromUsage({ calls: 1, inputTokens: 0, outputTokens: 0, cachedReadTokens: 1e6, cacheWriteTokens: 0, provider: 'gemini', model: 'gemini-2.5-flash-lite' });
  eq(a.usd, getModelPrice('claude-haiku-4-5').input * 0.1, 'Anthropic cached reads bill at 0.1x input');
  eq(g.usd, getModelPrice('gemini-2.5-flash-lite').input * 1, 'every other provider\'s cached reads bill at full input');

  const free = spentFromUsage({ calls: 1, inputTokens: 999, outputTokens: 99, provider: 'openrouter', model: FREE_FIXTURE });
  eq(free.usd, 0, 'free model: usd 0 (membership, first)');
  const up = spentFromUsage({ calls: 2, inputTokens: 999, outputTokens: 99, provider: 'openrouter', model: 'zz-unpriced/model' });
  eq(up.usd, null, 'unpriced: usd null (never a number nobody published)');
  eq(up.estimated, false, 'unpriced: estimated false');
  eq(up.modelLabel, 'zz-unpriced/model', 'unpriced: labelled by its id');
  const none = spentFromUsage({ calls: 0, inputTokens: 0, outputTokens: 0, provider: null, model: null });
  eq(none.usd, null, 'nothing ran (no model reported): usd null');
  eq(none.modelLabel, null, 'nothing ran: no label');
  const shape = spentFromUsage({ calls: 1, inputTokens: 5812, outputTokens: 640, provider: 'gemini', model: 'gemini-2.5-flash-lite' });
  eq(Object.keys(shape).join(','),
    'provider,providerLabel,model,modelLabel,inputTokens,outputTokens,cachedReadTokens,cacheWriteTokens,calls,usd,estimated,fallbackFrom',
    'spent carries exactly the join fields');
  eq(shape.fallbackFrom, null, 'no fallback recorded → fallbackFrom null');
  eq(spentFromUsage(null).usd, null, 'a null totals object does not throw');
}

// ═════════════════════════════════════════════════════════════════════════
section('5. A real generateText run walks the fallback chain — priced at the rung that billed');
{
  useConfig({ anthropicApiKey: 'zz-test-dummy-key-not-real', activeProvider: 'anthropic' });
  const chosen = getProviderInfo().model;
  const calls = [];
  const client = () => ({
    messages: {
      stream(body) {
        calls.push(body.model);
        if (body.model === chosen) { const e = new Error(`404 model not found: ${body.model}`); e.status = 404; throw e; }
        return { finalMessage: async () => ({
          stop_reason: 'end_turn', model: body.model,
          usage: { input_tokens: 5812, output_tokens: 640, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 },
          content: [{ type: 'text', text: 'ok' }],
        }) };
      },
      create(body) { return this.stream(body).finalMessage(); },
    },
  });
  __setAnthropicClientFactory(client);
  try {
    const acc = makeUsageAccumulator();
    await generateText('sys', 'user', 64, 'text', null, { onUsage: acc.onUsage });
    const ran = acc.totals.model;
    ok(calls[0] === chosen && ran && ran !== chosen, `the chain walked: asked ${chosen}, billed ${ran}`);
    const s = spentFromUsage(acc.totals);
    eq(s.model, ran, 'spent names the model that ACTUALLY ran');
    eq(s.fallbackFrom, chosen, 'fallbackFrom names the model the user chose');
    const want = chargeForItem({ items: [], estimate: null }, { tokenUsage: acc.totals });
    ok(typeof s.usd === 'number' && Math.abs(s.usd - want) < 1e-12, `priced at the rung that billed (${s.usd} === ${want})`);
    eq(s.calls, 1, 'one reported call');

    // The primary answers again → no fallback is claimed for this run.
    const client2 = () => ({ messages: {
      stream(body) { return { finalMessage: async () => ({ stop_reason: 'end_turn', model: body.model,
        usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text: 'ok' }] }) }; },
      create(body) { return this.stream(body).finalMessage(); },
    } });
    __setAnthropicClientFactory(client2);
    const acc2 = makeUsageAccumulator();
    await generateText('sys', 'user', 64, 'text', null, { onUsage: acc2.onUsage });
    const s2 = spentFromUsage(acc2.totals);
    eq(s2.model, chosen, 'primary answered');
    eq(s2.fallbackFrom, null, 'no fallback claimed when the chosen model billed');
  } finally {
    __setAnthropicClientFactory(null);
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('6. Zero network');
eq(networkAttempts, 0, 'no fetch / http(s) request was attempted by anything in this suite');

} finally {
  __setUserDataDirOverride(null);
  rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
