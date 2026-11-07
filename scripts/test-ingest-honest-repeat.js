#!/usr/bin/env node
/**
 * test-ingest-honest-repeat.js — OFFLINE. Four promises an ingest makes (2026-11-07).
 *
 *   §1 A real link to a real page resolves and is not reported broken, whatever order
 *      the pages were written in and however the model spelled the name.
 *   §2 A summary's title, source and Key Takeaways: re-ingesting really repairs them,
 *      and never changes a line the summary already had.
 *   §3 The identical source again: what a press can change is known BEFORE any call,
 *      nothing is spent when the answer is nothing, and old text is never overwritten.
 *   §4 Cost estimate against the measured bills in the production-test matrix.
 *
 * Every model is a fake (`opts.llm`); no key, no network.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

let passed = 0, failed = 0;
function ok(cond, label, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(a, b, label) { ok(a === b, label, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); }
const section = (t) => console.log(`\n${t}`);

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'curator-repeat-'));
const USER_DATA = path.join(TMP_ROOT, 'userdata');
const DOMAINS = path.join(TMP_ROOT, 'domains');
mkdirSync(USER_DATA, { recursive: true });
mkdirSync(DOMAINS, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DATA;
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS;
process.env.CURATOR_TEST_INSTANCE_DIR = path.join(TMP_ROOT, 'instances');
delete process.env.LLM_MODEL;
delete process.env.LLM_PROVIDER;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.OPENROUTER_API_KEY;

let seq = 0;
function makeDomain(files = {}) {
  const name = `d${++seq}`;
  const dd = path.join(DOMAINS, name);
  for (const d of ['wiki/entities', 'wiki/concepts', 'wiki/summaries', 'raw', 'conversations']) mkdirSync(path.join(dd, d), { recursive: true });
  writeFileSync(path.join(dd, 'CLAUDE.md'), '# Test domain schema\n', 'utf8');
  writeFileSync(path.join(dd, 'wiki', 'index.md'), '# Index\n\n| Page | Type | Summary |\n|---|---|---|\n', 'utf8');
  writeFileSync(path.join(dd, 'wiki', 'log.md'), '# Log\n\n', 'utf8');
  for (const [rel, body] of Object.entries(files)) writeFileSync(path.join(dd, 'wiki', rel), body, 'utf8');
  return {
    name,
    wiki: path.join(dd, 'wiki'),
    read: (rel) => readFileSync(path.join(dd, 'wiki', rel), 'utf8'),
    has: (rel) => existsSync(path.join(dd, 'wiki', rel)),
    write: (rel, body) => writeFileSync(path.join(dd, 'wiki', rel), body, 'utf8'),
  };
}
function sourceFile(name, text) {
  const dir = path.join(TMP_ROOT, 'src', String(++seq));
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  writeFileSync(p, text, 'utf8');
  return p;
}
const quiet = async (fn) => {
  const e = console.error, w = console.warn, l = console.log;
  console.error = () => {};
  console.warn = () => {};
  try { return await fn(); }
  finally { console.error = e; console.warn = w; console.log = l; }
};
const reply = (name, pages, model = 'fake-1') => {
  const fn = async (schema, prompt, maxTokens, format, onWait, opts) => {
    fn.calls++;
    if (opts && typeof opts.onUsage === 'function') opts.onUsage({ inputTokens: 100, outputTokens: 50, provider: 'fake', model });
    return JSON.stringify({ title: name, pages });
  };
  fn.calls = 0;
  return fn;
};

const { ingestFile, summaryShapeWarning, repeatIngestPlan, __testing } = await import('../src/brain/ingest.js');
const { __setDomainsDirOverride } = await import('../src/brain/config.js');
__setDomainsDirOverride(DOMAINS);

const SHORT = 'A short note about agents talking to each other through a protocol. '.repeat(10);
const SUMMARY_OK = (t) => `# ${t}\n\nSource: ${t}.md\n\n## Key Takeaways\n- One point about ${t}\n`;

// ── §1 ─────────────────────────────────────────────────────────────────────
section('§1 A real link to a real page resolves, whatever order the pages were written in');
{
  // The reply order the matrix recorded on Gemini 3.1: the summary first, so its links
  // point at pages not yet on disk when it is written.
  const dom = makeDomain();
  const res = await quiet(() => ingestFile(dom.name, sourceFile('short.md', SHORT), 'short.md', false, null, { llm: reply('short.md', [
    { path: 'summaries/short.md', content: `# Short\n\nSource: short.md\n\n## Key Takeaways\n- [[AgentLink]] connects harnesses over [[Model Context Protocol]].\n\n## Concepts Introduced or Referenced\n- [[Model Context Protocol]]\n- [[model-context-protocol]]\n\n## Entities Mentioned\n- [[AgentLink]]\n` },
    { path: 'entities/agentlink.md', content: '# AgentLink\n\nA protocol.\n\n## Related\n- [[Model_Context_Protocol]]\n' },
    { path: 'concepts/model-context-protocol.md', content: '# Model Context Protocol\n\nSee [[AgentLink]] and | [[Nowhere At All]].\n' },
  ]) }));
  const sum = dom.read('summaries/short.md');
  ok(!/don't resolve/.test(res.warnings.join('\n')) || /1 of /.test(res.warnings.join('\n')), 'only the truly missing page is reported broken', JSON.stringify(res.warnings));
  ok(res.warnings.some((w) => /1 of \d+ wikilinks/.test(w) && /Nowhere At All/.test(w)), 'a link to a page that does not exist is still reported');
  ok(!res.warnings.some((w) => /Examples:.*(AgentLink|Model Context Protocol)/.test(w)), 'AgentLink and Model Context Protocol are not in the examples');
  ok(sum.includes('[[agentlink|AgentLink]] connects'), 'in a sentence the link resolves and reads as the model wrote it', sum);
  ok(sum.includes('[[model-context-protocol|Model Context Protocol]].'), 'a name with spaces resolves too');
  ok(/^- \[\[agentlink\]\]$/m.test(sum), 'a link-only bullet takes the bare slug, like every other list row');
  eq((sum.match(/^- \[\[model-context-protocol\]\]$/gm) || []).length, 1, 'two spellings of one link in a list become one row');
  ok(dom.read('entities/agentlink.md').includes('- [[model-context-protocol]]'), 'an underscore form resolves');
  ok(!/\[\[([^\]|]+)\|\1\]\]/.test(sum + dom.read('entities/agentlink.md') + dom.read('concepts/model-context-protocol.md')), 'a link already spelled as the slug is left alone: no alias of itself');
}
{
  // A page written BEFORE the page it links to, on an existing wiki, in a table.
  const dom = makeDomain({ 'concepts/kept.md': '# Kept\n\nMentions [[AgentLink]] by hand.\n' });
  const before = dom.read('concepts/kept.md');
  await quiet(() => ingestFile(dom.name, sourceFile('t.md', SHORT), 't.md', false, null, { llm: reply('t.md', [
    { path: 'summaries/t.md', content: `# T\n\nSource: t.md\n\n## Key Takeaways\n- x\n\n| Who | What |\n|---|---|\n| [[AgentLink]] | y |\n` },
    { path: 'entities/agentlink.md', content: '# AgentLink\n\nA protocol.\n' },
  ]) }));
  ok(dom.read('summaries/t.md').includes('| [[agentlink]] | y |'), 'in a table no alias is added: a pipe would split the cell');
  eq(dom.read('concepts/kept.md'), before, 'a page this ingest did not write stays byte-identical');
}
{
  // A slug that only looks close is not a real link.
  const dom = makeDomain();
  const res = await quiet(() => ingestFile(dom.name, sourceFile('n.md', SHORT), 'n.md', false, null, { llm: reply('n.md', [
    { path: 'summaries/n.md', content: `# N\n\nSource: n.md\n\n## Key Takeaways\n- [[MCP]] is an acronym.\n` },
    { path: 'concepts/model-context-protocol.md', content: '# M\n\nBody.\n' },
  ]) }));
  ok(dom.read('summaries/n.md').includes('[[MCP]]'), 'an acronym is not guessed at');
  ok(res.warnings.some((w) => /1 of \d+ wikilinks/.test(w)), '…and stays reported', JSON.stringify(res.warnings));
}

// ── §4 ─────────────────────────────────────────────────────────────────────
section('§4 The estimate against what the run billed, on the same footing');
{
  const { __testing: q } = await import('../src/brain/ingest-queue.js');
  const llm = await import('../src/brain/llm.js');
  const est = (model, name, size) => q.estimateOneFile({ f: { name, size }, promptFiles: { entities: [], concepts: [] }, index: '', today: '2026-11-07', price: llm.getModelPrice(model), model });
  // The bills: production-test matrix, fresh domain, metered at the wire. Typed, not derived.
  const CELLS = [
    ['claude-haiku-5-5', 'short-agentlink.md', 9856, 0.0030, 6109, 4778],
    ['claude-sonnet-5-5', 'short-agentlink.md', 9856, 0.0613, 6109, 4911],
  ];
  for (const [model, name, size, usd, inTok, outTok] of CELLS) {
    const e = est(model, name, size);
    const r = usd / e.usdHigh;
    ok(r >= 0.6 && r <= 1.1, `${model} on ${name}: billed $${usd}, estimated $${e.usdHigh.toFixed(4)} (billed/estimate ${r.toFixed(2)}; it was above 2)`);
    ok(e.inputTokens >= inTok * 0.8 && e.inputTokens <= inTok * 1.2, `  input tokens ${e.inputTokens} against ${inTok} billed`);
    ok(e.outputTokens >= outTok * 0.8 && e.outputTokens <= outTok * 1.3, `  output tokens ${e.outputTokens} against ${outTok} billed`);
  }
  const multi = est('claude-haiku-5-5', 'text-energy-water.txt', 17346);
  ok(multi.mode === 'multi-phase' && multi.outputTokens === multi.totalCalls * 3300, 'multi-phase on Claude uses the measured 3,300 a call');
  const rm = 0.0139 / multi.usdHigh;
  ok(rm >= 0.6 && rm <= 1.3, `Haiku 5.5, multi-phase: billed $0.0139, estimated $${multi.usdHigh.toFixed(4)} (billed/estimate ${rm.toFixed(2)}; it was 2.17)`);
  ok(multi.totalCalls >= 5 && multi.totalCalls <= 8, `planned ${multi.totalCalls} calls; a 17,346-character source measured 5 on Gemini 3.1, 8 on Haiku 5.5`);
  const g = est('gemini-2.5-flash-lite', 'short-agentlink.md', 9856);
  eq(g.outputTokens, 1667, 'Gemini keeps its figure: it was not understated');

  const { renderSpent } = await import('../src/public/next/shared/ai-run.js');
  const spent = { model: 'claude-haiku-5-5', modelLabel: 'Haiku 5.5', inputTokens: 6109, outputTokens: 4778, usd: 0.003 };
  const estimate = { model: 'claude-haiku-5-5', usdLow: 0.0035, usdHigh: 0.0035, inputTokens: 5574, outputTokensHigh: 5900 };
  const line = renderSpent(spent, { estimate }).replace(/<[^>]+>/g, '');
  ok(/6,109 in \/ 4,778 out/.test(line) && /estimated before the run: 5,574 in \/ 5,900 out/.test(line), 'real and estimate print the same fields in the same format', line);
  ok(/\$0\.0030/.test(line) && /\$0\.0035/.test(line), '...with the same dollar format', line);
  ok(!/estimated/.test(renderSpent({ ...spent, fallbackFrom: 'claude-sonnet-5-5' }, { estimate })), 'another model answered: its estimate is not set against this bill');
  ok(!/estimated/.test(renderSpent(spent, { estimate: { ...estimate, model: 'claude-sonnet-5-5' } })), 'an estimate for another model is left out');
  ok(!/estimated/.test(renderSpent(spent)), 'no estimate, no clause');
}

console.log(`\n${passed} passed, ${failed} failed`);
rmSync(TMP_ROOT, { recursive: true, force: true });
if (failed) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ Ingest keeps its promises');
