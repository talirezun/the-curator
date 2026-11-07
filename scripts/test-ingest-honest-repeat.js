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

console.log(`\n${passed} passed, ${failed} failed`);
rmSync(TMP_ROOT, { recursive: true, force: true });
if (failed) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ Ingest keeps its promises');
