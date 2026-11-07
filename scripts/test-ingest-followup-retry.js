#!/usr/bin/env node
/**
 * test-ingest-followup-retry.js — OFFLINE. A follow-up source that came back as the
 * summary only (owner decision 2026-11-07; see FOLLOWUP_* in src/brain/ingest.js).
 *
 *   §1 Follow-up, summary-only reply → the same model once more; its pages are written,
 *      and one plain line names the model and the extra cost.
 *   §2 Still summary-only → the step on gemini-3.1-flash-lite (asserted by the opts the
 *      call received), the notice names both models, the cost readout prices each
 *      model at its own rates.
 *   §3 Never a loop: three summary-only replies → exactly three calls, summary only.
 *   §4 No paid retry where it is not earned: a source that does not cover an existing
 *      page, a first ingest, a short source, a reply that already has a topic page.
 *   §5 A retry that errors keeps the first reply; a non-Gemini provider gets no
 *      3.1 rung.
 *   §6 The pricing helper against hand arithmetic.
 *
 * Every model is a fake (`opts.llm`); no network. A placeholder Gemini key is set so
 * provider resolution says Gemini; no call ever leaves the process.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let passed = 0, failed = 0;
function ok(cond, label, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(a, b, label) { ok(a === b, label, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); }
const section = (t) => console.log(`\n${t}`);

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'curator-followup-'));
const USER_DATA = path.join(TMP_ROOT, 'userdata');
const DOMAINS = path.join(TMP_ROOT, 'domains');
mkdirSync(USER_DATA, { recursive: true });
mkdirSync(DOMAINS, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DATA;
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS;
process.env.CURATOR_TEST_INSTANCE_DIR = path.join(TMP_ROOT, 'instances');
process.env.CURATOR_NO_OPEN = '1';
for (const k of ['LLM_MODEL', 'LLM_PROVIDER', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY']) delete process.env[k];
process.env.GEMINI_API_KEY = 'placeholder-not-a-real-key';

let seq = 0;
function makeDomain(files = {}) {
  const name = `d${++seq}`;
  const dd = path.join(DOMAINS, name);
  for (const d of ['wiki/entities', 'wiki/concepts', 'wiki/summaries', 'raw', 'conversations']) mkdirSync(path.join(dd, d), { recursive: true });
  writeFileSync(path.join(dd, 'CLAUDE.md'), '# Test domain schema\n', 'utf8');
  writeFileSync(path.join(dd, 'wiki', 'index.md'), '# Index\n\n| Page | Type | Summary |\n|---|---|---|\n', 'utf8');
  writeFileSync(path.join(dd, 'wiki', 'log.md'), '# Log\n\n', 'utf8');
  for (const [rel, body] of Object.entries(files)) writeFileSync(path.join(dd, 'wiki', rel), body, 'utf8');
  return { name, has: (rel) => existsSync(path.join(dd, 'wiki', rel)), read: (rel) => readFileSync(path.join(dd, 'wiki', rel), 'utf8') };
}
function sourceFile(name, text) {
  const dir = path.join(TMP_ROOT, 'src', String(++seq));
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  writeFileSync(p, text, 'utf8');
  return p;
}
const quiet = async (fn) => {
  const e = console.error, w = console.warn;
  console.error = () => {}; console.warn = () => {};
  try { return await fn(); } finally { console.error = e; console.warn = w; }
};

const DEFAULT = 'gemini-3.5-flash-lite';
const RUNG = 'gemini-3.1-flash-lite';
const SUMMARY = (n) => ({ path: `summaries/${n}.md`, content: `# ${n}\n\nSource: ${n}.md\n\n## Key Takeaways\n- A point.\n\n## Concepts Introduced or Referenced\n- [[expert-roundup]]\n` });
const CONCEPT = { path: 'concepts/expert-roundup.md', content: '# Expert Roundup\n\nThe economics: a publisher produces a piece in hours.\n' };
const NEWC = { path: 'concepts/publisher-economics.md', content: '# Publisher Economics\n\nWhy roundups are cheap.\n' };

/** A scripted fake: replies[i] is the page list for call i (or an Error to throw). */
function script(n, replies) {
  const fn = async (schema, prompt, maxTokens, format, onWait, opts) => {
    const i = fn.calls.length;
    fn.calls.push({ prompt, model: opts && opts.model ? opts.model : null });
    const model = (opts && opts.model) || DEFAULT;
    if (opts && typeof opts.onUsage === 'function') opts.onUsage({ inputTokens: 2000, outputTokens: 400, provider: 'gemini', model });
    const r = replies[Math.min(i, replies.length - 1)];
    if (r instanceof Error) throw r;
    return JSON.stringify({ title: n, pages: r });
  };
  fn.calls = [];
  return fn;
}

const EXISTING = { 'concepts/expert-roundup.md': '---\ntags: [type/concept]\n---\n# Expert Roundup\n\nA format.\n' };
// A follow-up source: ~1,100 characters, "Experts Roundups" several times (the 09b shape).
const FOLLOWUP = ('Why Experts Roundups are trending again. Experts Roundups are economically attractive ' +
  'because they front-load value capture. What makes a good Experts Roundup: a sharp question, ' +
  'diverse contributors and firm editing. ').repeat(4);
const UNRELATED = ('A field guide to sourdough baking: hydration, levain timing, folding and the oven spring ' +
  'that a hot Dutch oven gives a loaf. ').repeat(8);

const { ingestFile, coveredExistingTopics, FOLLOWUP_MIN_CHARS } = await import('../src/brain/ingest.js');
const { __setDomainsDirOverride } = await import('../src/brain/config.js');
const { priceUsageUsd, priceUsageTotalsUsd, getModelPrice } = await import('../src/brain/llm.js');
const { spentFromUsage } = await import('../src/brain/ai-run.js');
__setDomainsDirOverride(DOMAINS);

const run = (dom, name, text, llm) => quiet(() => ingestFile(dom.name, sourceFile(`${name}.md`, text), `${name}.md`, false, null, { llm }));
const notices = (res) => (res.warnings || []).filter((w) => /entity or concept pages/.test(w));

section('§1 Follow-up, summary-only reply: the same model once more');
{
  const dom = makeDomain(EXISTING);
  const llm = script('f1', [[SUMMARY('f1')], [SUMMARY('f1'), CONCEPT, NEWC]]);
  const res = await run(dom, 'f1', FOLLOWUP, llm);
  eq(llm.calls.length, 2, 'exactly two calls');
  eq(llm.calls[1].model, null, 'the retry is on the same model (no override)');
  ok(/concepts\/expert-roundup\.md/.test(llm.calls[1].prompt) && /returned only the summary/.test(llm.calls[1].prompt), 'the retry names the existing page the source covers');
  ok(res.pagesWritten.includes('concepts/expert-roundup.md') && res.pagesWritten.includes('concepts/publisher-economics.md'), 'the retry\'s topic pages are written', JSON.stringify(res.pagesWritten));
  ok(dom.read('concepts/expert-roundup.md').includes('publisher produces a piece in hours'), 'the existing page took what the source adds');
  const n = notices(res);
  eq(n.length, 1, 'one notice');
  ok(/^Flash Lite 3\.5 planned no entity or concept pages/.test(n[0] || '') && /asked once more and wrote 2/.test(n[0] || ''), 'it names the model and what the retry wrote', n[0]);
  const perCall = priceUsageUsd(DEFAULT, { inputTokens: 2000, outputTokens: 400, calls: 1 });
  ok((n[0] || '').includes(`Extra cost: $${perCall.toFixed(4)}.`), 'it states the extra cost of the one retry', n[0]);
  eq(res.tokenUsage.calls, 2, 'the cost readout counts the retry');
  eq(res.replyNodePages, 2, 'replyNodePages reports the reply that was used');
  eq(res.followupRetry && res.followupRetry.accepted, DEFAULT, 'the record names the model whose reply was used');
}

section('§2 Still summary-only: the step on Flash Lite 3.1, priced per model');
{
  const dom = makeDomain(EXISTING);
  const llm = script('f2', [[SUMMARY('f2')], [SUMMARY('f2')], [SUMMARY('f2'), CONCEPT]]);
  const res = await run(dom, 'f2', FOLLOWUP, llm);
  eq(llm.calls.length, 3, 'exactly three calls');
  eq(llm.calls[2].model, RUNG, 'the third call asked for gemini-3.1-flash-lite by id');
  ok(res.pagesWritten.includes('concepts/expert-roundup.md'), 'its page is written');
  const n = notices(res)[0] || '';
  ok(/Flash Lite 3\.5 twice planned no entity or concept pages/.test(n) && /ran on Flash Lite 3\.1, which wrote 1/.test(n), 'the notice names both models', n);
  const p35 = getModelPrice(DEFAULT), p31 = getModelPrice(RUNG);
  // Hand arithmetic: two calls at 3.5's rates, one at 3.1's, 2,000 in and 400 out each.
  const hand = 2 * (2000 * p35.input + 400 * p35.output) / 1e6 + (2000 * p31.input + 400 * p31.output) / 1e6;
  const extraHand = (2000 * p35.input + 400 * p35.output) / 1e6 + (2000 * p31.input + 400 * p31.output) / 1e6;
  ok(n.includes(`Extra cost: $${extraHand.toFixed(4)}.`), 'the extra cost covers both retries at their own rates', n);
  const spent = spentFromUsage(res.tokenUsage);
  ok(Math.abs(spent.usd - hand) < 1e-9, 'the cost readout prices each model at its own rates', `${spent.usd} vs ${hand}`);
  ok(Math.abs(spent.usd - priceUsageUsd(RUNG, res.tokenUsage)) > 1e-9, '…not all three calls at the last model\'s rates');
}

section('§3 Never a loop');
{
  const dom = makeDomain(EXISTING);
  const llm = script('f3', [[SUMMARY('f3')]]);
  const res = await run(dom, 'f3', FOLLOWUP, llm);
  eq(llm.calls.length, 3, 'three summary-only replies → exactly three calls');
  eq(res.pagesWritten.filter((p) => /^(entities|concepts)\//.test(p)).length, 0, 'only the summary is written');
  const n = notices(res)[0] || '';
  ok(/Flash Lite 3\.5 twice and Flash Lite 3\.1 once planned no entity or concept pages, so only the summary was written/.test(n), 'the notice says so', n);
  eq(res.followupRetry && res.followupRetry.attempts.length, 2, 'the record holds both retries');
  eq(res.followupRetry && res.followupRetry.accepted, null, '…and that none was used');
}

section('§4 No paid retry where it is not earned');
{
  const dom = makeDomain(EXISTING);
  const llm = script('u', [[SUMMARY('u')]]);
  const res = await run(dom, 'u', UNRELATED, llm);
  eq(llm.calls.length, 1, 'a source that covers no existing page: one call');
  eq(notices(res).length, 0, '…and no notice');
  eq(res.followupRetry, null, '…and no record');
}
{
  const dom = makeDomain();
  const llm = script('first', [[SUMMARY('first')]]);
  await run(dom, 'first', FOLLOWUP, llm);
  eq(llm.calls.length, 1, 'a first ingest into an empty domain: one call');
}
{
  const dom = makeDomain(EXISTING);
  const llm = script('s', [[SUMMARY('s')]]);
  const short = 'Experts Roundups, Experts Roundups and an Experts Roundup. '.repeat(6);
  ok(short.length < FOLLOWUP_MIN_CHARS, 'the short source is under the minimum');
  await run(dom, 's', short, llm);
  eq(llm.calls.length, 1, 'a short source: one call');
}
{
  const dom = makeDomain(EXISTING);
  const llm = script('h', [[SUMMARY('h'), NEWC]]);
  await run(dom, 'h', FOLLOWUP, llm);
  eq(llm.calls.length, 1, 'a reply that already has a topic page: one call');
}
{
  // The detector itself: one mention is not coverage, plural and case are.
  const files = { entities: [], concepts: ['expert-roundup.md', 'ai.md'] };
  eq(coveredExistingTopics(FOLLOWUP, files).map((c) => c.path).join(','), 'concepts/expert-roundup.md', 'plural and case match; a two-letter name is never matched');
  eq(coveredExistingTopics(UNRELATED + ' an expert roundup once.', files).length, 0, 'a single mention is not coverage');
}

section('§5 Errors and providers');
{
  const dom = makeDomain(EXISTING);
  const llm = script('e', [[SUMMARY('e')], new Error('HTTP 500 upstream'), [SUMMARY('e'), CONCEPT]]);
  const res = await run(dom, 'e', FOLLOWUP, llm);
  eq(llm.calls.length, 3, 'a retry that errors does not end the ingest; the next rung still runs');
  ok(res.pagesWritten.includes('concepts/expert-roundup.md'), '…and its reply is used');
  ok((res.followupRetry.attempts[0].error || '').includes('HTTP 500'), 'the record keeps the error');
}
{
  delete process.env.GEMINI_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'placeholder-not-a-real-key';
  const dom = makeDomain(EXISTING);
  const llm = script('a', [[SUMMARY('a')]]);
  await run(dom, 'a', FOLLOWUP, llm);
  eq(llm.calls.length, 2, 'not on Gemini: the same-model retry only, no 3.1 rung');
  ok(llm.calls.every((c) => c.model === null), '…and no model override is sent');
  delete process.env.ANTHROPIC_API_KEY;
  process.env.GEMINI_API_KEY = 'placeholder-not-a-real-key';
}

section('§6 The pricing helper');
{
  const p35 = getModelPrice(DEFAULT), p31 = getModelPrice(RUNG);
  const t = { calls: 2, inputTokens: 3000, outputTokens: 600, cachedReadTokens: 0, cacheWriteTokens: 0, model: RUNG,
    byModel: { [DEFAULT]: { calls: 1, inputTokens: 1000, outputTokens: 200 }, [RUNG]: { calls: 1, inputTokens: 2000, outputTokens: 400 } } };
  const hand = (1000 * p35.input + 200 * p35.output + 2000 * p31.input + 400 * p31.output) / 1e6;
  ok(Math.abs(priceUsageTotalsUsd(t) - hand) < 1e-12, 'two models: each at its own rates');
  const partial = { ...t, calls: 3 };
  ok(Math.abs(priceUsageTotalsUsd(partial) - priceUsageUsd(RUNG, partial)) < 1e-12, 'subtotals that miss a call: the old single-model rule');
  eq(priceUsageTotalsUsd({ ...t, byModel: { ...t.byModel, 'no-such-model': { calls: 0 } } }), null, 'an unpriced model makes the figure unknown, never a partial sum');
  // The batch queue charges an item the same way (its budget cap reads this).
  const { __testing: q } = await import('../src/brain/ingest-queue.js');
  const job = { items: [], estimate: null };
  ok(Math.abs(q.chargeForItem(job, { tokenUsage: t, status: 'done' }) - hand) < 1e-12, 'a batch item is charged each model at its own rates');
}

try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* temp */ }
console.log(`\nPassed: ${passed}   Failed: ${failed}`);
process.exit(failed ? 1 : 0);
