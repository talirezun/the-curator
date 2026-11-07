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

// ── §2 ─────────────────────────────────────────────────────────────────────
section('§2 A summary\'s title, source and Key Takeaways');
{
  // The reply shape Gemini 3.1 returned on 22 of 24 summaries: frontmatter, no title.
  const NO_TITLE = `---\ntype: summary\nsource: a.md\ntags: [type/summary]\n---\n## Key Takeaways\n- A point.\n`;
  const dom = makeDomain();
  const res = await quiet(() => ingestFile(dom.name, sourceFile('a.md', SHORT), 'a.md', false, null, { llm: reply('A Readable Title', [{ path: 'summaries/a.md', content: NO_TITLE }]) }));
  const body = dom.read('summaries/a.md');
  ok(/^# A Readable Title$/m.test(body), 'the model\'s own title goes on the page, at no cost', body);
  ok(!res.warnings.some((w) => /missing a title/.test(w)), 'so the warning does not fire', JSON.stringify(res.warnings));
  ok(body.startsWith('---\n') && body.indexOf('# A Readable Title') > body.indexOf('\n---\n'), 'below the frontmatter');
  ok(/^- A point\.$/m.test(body), 'every line the model wrote stays');
}
{
  // A summary an older version wrote, the identical source, the same model: free, no call.
  const SHA = (t) => createHash('sha256').update(t).digest('hex');
  const dom = makeDomain({ 'summaries/old.md': `---\ntype: summary\nsource: old.md\ntags: [type/summary]\n---\n## Key Takeaways\n- Kept point.\n` });
  writeFileSync(path.join(dom.wiki, '.raw-manifest.jsonl'), JSON.stringify({ filename: 'old.md', sha256: SHA(SHORT), bytes: SHORT.length, summaryPath: 'summaries/old.md', completed: true, model: 'fake-1' }) + '\n');
  const llm = reply('old.md', []);
  const r = await quiet(() => ingestFile(dom.name, sourceFile('old.md', SHORT), 'old.md', true, null, { llm, buildModel: 'fake-1' }));
  eq(llm.calls, 0, 're-ingesting a summary with no title makes no call');
  ok(/^# old$/m.test(dom.read('summaries/old.md')), '...and the warning\'s promise comes true: it has a title');
  ok(/^- Kept point\.$/m.test(dom.read('summaries/old.md')), '...with every old line in place');
  ok(r.warnings.some((w) => /gained its missing title/.test(w) && /no AI call/i.test(w)), '...and it says so');
}
{
  // Key Takeaways needs the model. The reply has them this time; nothing else may move.
  const dom = makeDomain();
  const NONE = `---\ntype: summary\nsource: k.md\ntags: [type/summary]\n---\n# K\n\nOnly a sentence the first reading wrote.\n`;
  const first = await quiet(() => ingestFile(dom.name, sourceFile('k.md', SHORT), 'k.md', false, null, { llm: reply('K', [{ path: 'summaries/k.md', content: NONE }]) }));
  ok(first.warnings.some((w) => /missing a Key Takeaways section/.test(w) && /adds what is missing if the model writes it/.test(w)), 'first reading: the warning says what a re-ingest can do', JSON.stringify(first.warnings));
  ok(!first.warnings.some((w) => /usually fixes/.test(w)), '...not "usually fixes it"');
  const before = dom.read('summaries/k.md');
  const llm = reply('K', [{ path: 'summaries/k.md', content: `# K\n\nA reworded sentence nobody asked for.\n\n## Key Takeaways\n- A real takeaway.\n` }]);
  const r2 = await quiet(() => ingestFile(dom.name, sourceFile('k.md', SHORT), 'k.md', true, null, { llm, buildModel: 'fake-1' }));
  const after = dom.read('summaries/k.md');
  eq(llm.calls, 1, 'a gap is the one thing the same model may spend on');
  ok(/^## Key Takeaways$/m.test(after) && /^- A real takeaway\.$/m.test(after), 're-ingesting really brought in the section');
  ok(!/reworded sentence/.test(after), '...and no new wording came with it');
  ok(before.split('\n').filter((l) => l.trim()).every((l) => after.includes(l)), '...and no old line went');
  ok(!r2.warnings.some((w) => /missing a Key Takeaways/.test(w)), '...and the warning is gone');
}

// ── §3 ─────────────────────────────────────────────────────────────────────
section('§3 The identical source again: known before any call, never spent for nothing');
const OLD_PAGE = '# Orchards\n\nOrchards shelter apples.\n\n## Definition\nPlanted fruit trees.\n';
const firstPages = [{ path: 'summaries/same.md', content: SUMMARY_OK('same') }, { path: 'concepts/orchards.md', content: OLD_PAGE }];
const secondPages = [{ path: 'summaries/same.md', content: SUMMARY_OK('same') }, { path: 'concepts/orchards.md', content: '# Orchards Again\n\nZygotes germinate beneath volcanic loam in quiet terraces.\n\n## Definition\nCompletely different wording about planted fruit trees.\n' }];
const seed = async (model = 'model-a') => {
  const dom = makeDomain();
  await quiet(() => ingestFile(dom.name, sourceFile('same.md', SHORT), 'same.md', false, null, { llm: reply('same', firstPages, model), buildModel: model }));
  return dom;
};
{
  const dom = await seed('model-a');
  const manifest = dom.read('.raw-manifest.jsonl').trim().split('\n').map((l) => JSON.parse(l));
  eq(manifest.filter((r) => r.completed).length, 1, 'the manifest records one finished reading');
  eq(manifest.find((r) => r.completed).model, 'model-a', '...naming the model that ran');

  const before = dom.read('concepts/orchards.md');
  const beforeSummary = dom.read('summaries/same.md');
  const same = reply('same', secondPages, 'model-a');
  const r = await quiet(() => ingestFile(dom.name, sourceFile('same.md', SHORT), 'same.md', true, null, { llm: same, buildModel: 'model-a' }));
  eq(same.calls, 0, 'SAME BYTES, SAME MODEL: no call');
  eq(r.tokenUsage.calls, 0, '...the result reports none');
  eq(dom.read('concepts/orchards.md'), before, '...the page is byte-identical');
  eq(dom.read('summaries/same.md'), beforeSummary, '...the summary too');
  ok(r.warnings.some((w) => /no AI call was made and nothing was charged/.test(w)), '...and it says so', JSON.stringify(r.warnings));
  const renamed = reply('same', secondPages, 'model-a');
  await quiet(() => ingestFile(dom.name, sourceFile('renamed.md', SHORT), 'renamed.md', false, null, { llm: renamed, buildModel: 'model-a' }));
  eq(renamed.calls, 0, 'the same bytes under another name: no call either');

  // Another model: a real reading, under add-only-new.
  const other = reply('same', secondPages, 'model-b');
  const r2 = await quiet(() => ingestFile(dom.name, sourceFile('same.md', SHORT), 'same.md', true, null, { llm: other, buildModel: 'model-b' }));
  eq(other.calls, 1, 'ANOTHER MODEL: it reads');
  const page = dom.read('concepts/orchards.md');
  ok(/Zygotes germinate beneath volcanic loam/.test(page), '...and what is mostly new joins the page');
  for (const l of before.split('\n').filter((x) => x.trim())) ok(page.split('\n').includes(l), `...and old text stands: "${l}"`);
  ok(r2.warnings.some((w) => /model-a read it before/.test(w)), '...and the report names the earlier model', JSON.stringify(r2.warnings));
  const m = dom.read('.raw-manifest.jsonl').trim().split('\n').map((l) => JSON.parse(l));
  eq(m.filter((x) => x.completed).at(-1).model, 'model-b', '...and that reading is recorded');

  // Bounded: each model reads these bytes once.
  const sizeBefore = dom.read('concepts/orchards.md');
  for (const mdl of ['model-a', 'model-b']) {
    const again = reply('same', secondPages, mdl);
    await quiet(() => ingestFile(dom.name, sourceFile('same.md', SHORT), 'same.md', true, null, { llm: again, buildModel: mdl }));
    eq(again.calls, 0, `a second press on ${mdl} spends nothing`);
  }
  eq(dom.read('concepts/orchards.md'), sizeBefore, 'so a wiki cannot grow by pressing again');
}
{
  // A changed source is still an ordinary reading on the same model.
  const dom = await seed('model-a');
  const llm = reply('same', secondPages, 'model-a');
  await quiet(() => ingestFile(dom.name, sourceFile('same.md', `${SHORT} A new edition.`), 'same.md', true, null, { llm, buildModel: 'model-a' }));
  eq(llm.calls, 1, 'CHANGED BYTES: it reads');
  ok(/Zygotes germinate/.test(dom.read('concepts/orchards.md')), '...and what is mostly new joins');
}
{
  // A gap: the same model may fill it, and may do nothing else.
  const dom = await seed('model-a');
  dom.write('concepts/stubbed.md', '---\ntype: concept\ntags: [type/concept]\n---\n# s\n\n> ⚠ **Stub page — AI failed to write this on ingest.**\n> Re-ingest "same.md" to fix this.\n');
  dom.write('summaries/same.md', `${dom.read('summaries/same.md').trimEnd()}\n\n## Concepts Introduced or Referenced\n- [[stubbed]]\n`);
  const before = dom.read('concepts/orchards.md');
  const llm = reply('same', [...secondPages, { path: 'concepts/stubbed.md', content: '# Real\n\nReal words at last.\n' }], 'model-a');
  const r = await quiet(() => ingestFile(dom.name, sourceFile('same.md', SHORT), 'same.md', true, null, { llm, buildModel: 'model-a' }));
  eq(llm.calls, 1, 'A STUB: the same model reads');
  ok(/Real words at last/.test(dom.read('concepts/stubbed.md')), '...the stub is filled, as its own text promised');
  eq(dom.read('concepts/orchards.md'), before, '...and a page with real text takes no new wording');
  ok(!r.warnings.some((w) => /no AI call/.test(w)), '...and it does not claim no call was made');
}
{
  // Older records name no model: one real reading, then bounded.
  const dom = makeDomain({ 'concepts/orchards.md': OLD_PAGE, 'summaries/old2.md': SUMMARY_OK('old2') });
  writeFileSync(path.join(dom.wiki, '.raw-manifest.jsonl'), JSON.stringify({ filename: 'old2.md', sha256: createHash('sha256').update(SHORT).digest('hex'), bytes: SHORT.length, summaryPath: 'summaries/old2.md' }) + '\n');
  const llm = reply('old2', [{ path: 'summaries/old2.md', content: SUMMARY_OK('old2') }], 'model-a');
  const r = await quiet(() => ingestFile(dom.name, sourceFile('old2.md', SHORT), 'old2.md', true, null, { llm, buildModel: 'model-a' }));
  eq(llm.calls, 1, 'A RECORD WITH NO MODEL: it reads once');
  ok(r.warnings.some((w) => /an earlier model read it before/.test(w)), '...and does not name a model it does not know', JSON.stringify(r.warnings));
  const again = reply('old2', [], 'model-a');
  await quiet(() => ingestFile(dom.name, sourceFile('old2.md', SHORT), 'old2.md', true, null, { llm: again, buildModel: 'model-a' }));
  eq(again.calls, 0, '...then is known');
}
{
  // The model cannot be told: exactly the previous behaviour, never a free pass or a new wording.
  const dom = await seed('model-a');
  const before = dom.read('concepts/orchards.md');
  const llm = reply('same', secondPages);
  await quiet(() => ingestFile(dom.name, sourceFile('same.md', SHORT), 'same.md', true, null, { llm }));
  eq(llm.calls, 1, 'NO MODEL KNOWN: it reads, as before');
  eq(dom.read('concepts/orchards.md'), before, '...and takes no new wording');
}
{
  // What the panel says, before anything is spent.
  const { duplicateCopy } = await import('../src/public/next/shared/ingest-queue-logic.js');
  const previous = { filename: 'x.md', ingestedAt: '2026-11-07T10:00:00Z', model: 'gemini-3.1-flash-lite' };
  const nothing = duplicateCopy({ sameContent: true, kind: 'nothing', previous, previousModelLabel: 'Flash Lite 3.1', modelLabel: 'Flash Lite 3.1', gaps: [] });
  eq(nothing.action, null, 'NOTHING CAN CHANGE: there is no button to spend with');
  ok(/change nothing/.test(nothing.sentence) && /stronger model/.test(nothing.sentence), '...and it says why, and what would help');
  const other = duplicateCopy({ sameContent: true, kind: 'other-model', previous, previousModelLabel: 'Flash Lite 3.1', modelLabel: 'Sonnet 5.5', gaps: [] });
  eq(other.action, 'Read it with Sonnet 5.5', 'ANOTHER MODEL: the button names it');
  ok(/Flash Lite 3\.1 read it/.test(other.sentence) && /Nothing already written changes/.test(other.sentence), '...and the sentence says what will and will not happen');
  const gaps = duplicateCopy({ sameContent: true, kind: 'gaps', previous, gaps: ['2 stub pages'] });
  ok(/only fill gaps \(2 stub pages\)/.test(gaps.sentence) && /stay exactly/.test(gaps.sentence), 'A GAP: named');
  const changed = duplicateCopy({ sameContent: false, kind: null, gaps: [] });
  eq(changed.action, 'Re-ingest & update wiki', 'CHANGED: the old button is now true');
  eq(duplicateCopy(null).action, 'Re-ingest & update wiki', 'an older server without a plan keeps working');
}
{
  // The route answers before any spend: over real HTTP, on a real upload.
  const { default: express } = await import('express');
  const { default: ingestRouter } = await import('../src/routes/ingest.js');
  const { createServer } = await import('node:http');
  const app = express();
  app.use('/api/ingest', ingestRouter);
  const server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/ingest`;
  const post = async (domain, name, text, overwrite) => {
    const fd = new FormData();
    fd.append('domain', domain);
    if (overwrite) fd.append('overwrite', 'true');
    fd.append('file', new Blob([text], { type: 'text/markdown' }), name);
    return fetch(base, { method: 'POST', body: fd });
  };
  const dom = await seed('model-a');
  const r1 = await post(dom.name, 'different-name.md', SHORT);
  eq(r1.status, 409, 'the same bytes under a NEW name no longer go straight to a paid run');
  const b1 = await r1.json();
  ok(b1.plan && b1.plan.sameContent === true && b1.plan.previous.filename === 'same.md', '...the answer carries the plan', JSON.stringify(b1).slice(0, 200));
  const r2 = await post(dom.name, 'same.md', `${SHORT} changed`);
  eq(r2.status, 409, 'a changed file under the old name still asks first');
  eq((await r2.json()).plan.sameContent, false, '...and is told apart');
  const dom2 = makeDomain();
  const r3 = await post(dom2.name, 'brand-new.md', 'x');
  ok(r3.status !== 409, 'a new file is not held up');
  await r3.text().catch(() => {});
  await new Promise((r) => server.close(r));
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

  const job = { items: [{ status: 'done' }], estimate: { usdHigh: 1 } };
  eq(q.chargeForItem(job, { tokenUsage: { calls: 0, inputTokens: 0, outputTokens: 0, model: null } }), 0, 'a batch item that made no call is charged nothing, not a share of the estimate');
  ok(!job.spendIsEstimated, '...and the batch total stays exact');

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
