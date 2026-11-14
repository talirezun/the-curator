#!/usr/bin/env node
/**
 * Knowledge compounds across sources: a data source that updates pages the wiki already
 * has is shown what those pages say now (existing-facts.js), so the new or changed facts
 * land on them with their version or period, beside the old ones. Offline, no key.
 *
 *   1. the selection: a page the source names, or that shares a distinctive identifier
 *      with it, is picked; a page sharing only numbers or words is not; link sections,
 *      frontmatter and fences are never excerpted; every budget holds;
 *   2. the prompts: the block is sent on single pass, the strict retry, the follow-up
 *      retry, the outline (names only) and every Phase 2 call, ONLY for a hard-data
 *      source naming existing pages; each prompt minus the block is the prompt built
 *      without it; the batch prefix stays byte-identical across batches; prose, an
 *      empty domain, unrelated pages and a re-reading of the same bytes get none;
 *   3. multi-phase plans an updated page the outline left out; the write keeps every
 *      old line and adds the changed one;
 *   4. a summary-only reply to such a source triggers the follow-up retry, which names
 *      the pages;
 *   5. the estimate carries the block and its output allowance on a domain with pages
 *      only.
 *
 * Every guard here was proven by mutation: see the commit that added this file.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let passed = 0, failed = 0;
function ok(cond, label, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(a, b, label) { ok(a === b, label, `got ${JSON.stringify(a)?.slice(0, 300)}, expected ${JSON.stringify(b)?.slice(0, 300)}`); }
const section = (t) => console.log(`\n${t}`);

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'curator-existing-facts-'));
const USER_DATA = path.join(TMP_ROOT, 'userdata');
const DOMAINS = path.join(TMP_ROOT, 'domains');
mkdirSync(USER_DATA, { recursive: true });
mkdirSync(DOMAINS, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DATA;
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS;
process.env.CURATOR_TEST_INSTANCE_DIR = path.join(TMP_ROOT, 'instances');
process.env.CURATOR_NO_OPEN = '1';
process.on('exit', () => { try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {} });

const ingest = await import('../src/brain/ingest.js');
const ef = await import('../src/brain/existing-facts.js');
const queue = await import('../src/brain/ingest-queue.js');
const qt = queue.__testing;
const llmMod = await import('../src/brain/llm.js');
const { ingestFile, KEY_FACTS_RULE } = ingest;
const { buildPrompt, buildOutlinePrompt, buildBatchPromptParts } = ingest.__testing;
const { selectExistingFacts, renderExistingFactsBlock, renderExistingFactsOutlineNote, nameMentions, figureLines,
  EXISTING_FACTS_MAX_CHARS, EXISTING_FACTS_EXCERPT_CHARS, EXISTING_FACTS_MAX_PAGES, EXISTING_FACTS_MAX_LINES_PER_PAGE, EXISTING_FACTS_MAX_LINE_CHARS } = ef;

const quiet = async (fn) => {
  const e = console.error, w = console.warn;
  console.error = () => {}; console.warn = () => {};
  try { return await fn(); } finally { console.error = e; console.warn = w; }
};
let seq = 0;
function makeDomain(pages = {}) {
  const name = `d${++seq}`;
  const dd = path.join(DOMAINS, name);
  for (const d of ['wiki/entities', 'wiki/concepts', 'wiki/summaries', 'raw', 'conversations']) mkdirSync(path.join(dd, d), { recursive: true });
  writeFileSync(path.join(dd, 'CLAUDE.md'), '# Test domain schema\n', 'utf8');
  writeFileSync(path.join(dd, 'wiki', 'index.md'), '# Index\n\n| Page | Type | Summary |\n|---|---|---|\n| [[tidewater-ledger]] | entity | The payments platform |\n', 'utf8');
  writeFileSync(path.join(dd, 'wiki', 'log.md'), '# Log\n\n', 'utf8');
  for (const [rel, body] of Object.entries(pages)) writeFileSync(path.join(dd, 'wiki', rel), body, 'utf8');
  return { name, read: (rel) => readFileSync(path.join(dd, 'wiki', rel), 'utf8'), has: (rel) => existsSync(path.join(dd, 'wiki', rel)) };
}
function sourceFile(name, text) {
  const dir = path.join(TMP_ROOT, 'src', String(++seq));
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  writeFileSync(p, text, 'utf8');
  return p;
}
const usage = (opts) => { if (opts && typeof opts.onUsage === 'function') opts.onUsage({ inputTokens: 10, outputTokens: 5, provider: 'fake', model: 'fake-1' }); };
const ASK_RE = /Write the full markdown content for EXACTLY these wiki pages[\s\S]*?\n\]/;
const askedPaths = (prompt) => ((prompt.match(ASK_RE) || [''])[0].match(/"path": "([^"]+)"/g) || []).map((s) => s.slice(9, -1));
const HEADER = 'EXISTING PAGES THIS SOURCE UPDATES';

const PRODUCT = `---\ntype: entity\ntags: [type/entity]\ncreated: 2026-01-01\n---\n# Tidewater Ledger\n\nType: product\n\n## Key Facts\n- \`risk-svc\` listens on port 7103 (v1.4)\n- \`ORDERS_RISK_TIMEOUT_MS\` defaults to 120 ms\n- Serves 4,800 merchants\n\n\`\`\`\nrisk-svc 7103 inside a fence\n\`\`\`\n\n## Related\n- [[risk-scoring]] — 7103 in a link section\n`;
const RISK = `---\ntype: concept\ntags: [type/concept]\n---\n# Risk Scoring\n\n## Definition\nScoring payments for fraud.\n\n- \`orders-svc\` calls \`risk-svc\` with a 120 ms timeout\n- A score above 910 is declined\n`;
const UNRELATED = `---\ntype: concept\n---\n# Orchard Yields\n\n## Key Facts\n- Yield rose 250 tonnes in 10 minutes of reporting, 30 minutes per payment review\n- Real-time harvest dashboards since v1.4\n`;
const FOLLOW = `# Tidewater Ledger — changes in v1.5\n\nReleased 2 June 2028. Supersedes v1.4 for the items below.\n\n`
  + '`risk-svc` now listens on port 7113 (was 7103) and exposes metrics on port 8113. '
  + '`ORDERS_RISK_TIMEOUT_MS` now defaults to `180` (was `120`) because model `rm-2028.06` has a p99 of 151 ms. '
  + 'The €250 fallback stays; real-time dashboards are unchanged. `disputes-svc` (port 7109) owns chargebacks; evidence: at most 20 files of 5 MB. '
  + '`DELETE /v2/api-keys/{id}` is removed; use `POST /v2/api-keys/{id}/revoke`, 410 from 1 July 2028. Payments took 250 ms, 10 minutes, 30 minutes.\n';
const PROSE = readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'test-ingest-deep-inputs', '02-trunk-cluster.md'), 'utf8');

// ── 1 ────────────────────────────────────────────────────────────────────────
section('1. which pages and lines are shown');
{
  ok(ingest.sourceHasHardData(FOLLOW), 'the follow-up fixture is a hard-data source', JSON.stringify(ingest.hardDataDensity(FOLLOW)));
  const files = { entities: ['tidewater-ledger.md'], concepts: ['risk-scoring.md', 'orchard-yields.md'] };
  const m = nameMentions(FOLLOW, files);
  eq(m.get('entities/tidewater-ledger.md'), 1, 'nameMentions: the product is named once (the title)');
  eq(m.get('concepts/risk-scoring.md'), 0, 'nameMentions: the concept is not named');
  const pages = [
    { path: 'entities/tidewater-ledger.md', content: PRODUCT },
    { path: 'concepts/risk-scoring.md', content: RISK },
    { path: 'concepts/orchard-yields.md', content: UNRELATED },
  ];
  const sel = selectExistingFacts(FOLLOW, pages, m);
  const paths = sel.map((s) => s.path);
  eq(paths[0], 'entities/tidewater-ledger.md', 'the page the source names comes first');
  ok(paths.includes('concepts/risk-scoring.md'), 'an unnamed page sharing an identifier (`risk-svc`) is shown');
  ok(!paths.includes('concepts/orchard-yields.md'), 'a page sharing only numbers (250, 10, 30) and a plain compound ("real-time") is not');
  const prodLines = sel.find((s) => s.path === 'entities/tidewater-ledger.md').lines;
  ok(prodLines.some((l) => l.includes('port 7103')), 'the changed fact\'s current line is in the excerpt');
  ok(!prodLines.some((l) => /inside a fence|link section/.test(l)), 'fences and link sections are never excerpted');
  ok(!sel.some((s) => s.lines.some((l) => /^(type|tags|created):/i.test(l))), 'frontmatter is never excerpted');
  ok(figureLines('---\na: 1\n---\n# T\n\nPlain words only.\n- 12 units\n').map((l) => l.line).join('|') === '- 12 units', 'figureLines: only lines with a figure or identifier, outside frontmatter');
  eq(selectExistingFacts(FOLLOW, [{ path: 'concepts/orchard-yields.md', content: UNRELATED }], new Map()).length, 0, 'nothing relates: an empty selection');
  eq(renderExistingFactsBlock([], 'x.md'), '', 'an empty selection renders nothing');
  eq(renderExistingFactsOutlineNote([]), '', 'and no outline note');

  // Budgets.
  const big = [];
  const bigText = Array.from({ length: 30 }, (_, i) => `\`svc-${i}\` port ${7000 + i}`).join('. ');
  for (let i = 0; i < 20; i++) {
    big.push({ path: `concepts/topic-${i}.md`, content: `# T${i}\n\n## Key Facts\n${Array.from({ length: 20 }, (_, j) => `- \`svc-${j}\` port ${7000 + j} ${'long words '.repeat(40)}`).join('\n')}\n` });
  }
  const bsel = selectExistingFacts(bigText, big, new Map());
  ok(bsel.length <= EXISTING_FACTS_MAX_PAGES, `at most ${EXISTING_FACTS_MAX_PAGES} pages`, `${bsel.length}`);
  ok(bsel.every((s) => s.lines.length <= EXISTING_FACTS_MAX_LINES_PER_PAGE), `at most ${EXISTING_FACTS_MAX_LINES_PER_PAGE} lines a page`);
  ok(bsel.every((s) => s.lines.every((l) => l.length <= EXISTING_FACTS_MAX_LINE_CHARS)), `each line at most ${EXISTING_FACTS_MAX_LINE_CHARS} characters`);
  const excerpt = bsel.reduce((n, s) => n + s.path.length + 2 + s.lines.reduce((a, l) => a + l.length + 1, 0), 0);
  ok(excerpt <= EXISTING_FACTS_EXCERPT_CHARS, `the excerpt is at most ${EXISTING_FACTS_EXCERPT_CHARS} characters`, `${excerpt}`);
  const many = Array.from({ length: 20 }, (_, i) => ({ path: `concepts/t-${i}.md`, content: `# T\n\n- \`svc-${i}\` port ${7000 + i}\n` }));
  eq(selectExistingFacts(bigText, many, new Map()).length, EXISTING_FACTS_MAX_PAGES, `twenty related short pages: still ${EXISTING_FACTS_MAX_PAGES}`);
  const strong = { path: 'concepts/strong.md', content: `# S\n\n${Array.from({ length: 8 }, (_, j) => `- \`svc-${j}\` port ${7000 + j} and \`svc-${j + 1}\``).join('\n')}\n` };
  const weak = { path: 'entities/named-product.md', content: '# N\n\n## Key Facts\n- Founded with 12 staff\n' };
  const order = selectExistingFacts(`Named Product notes. ${bigText}`, [strong, weak], nameMentions(`Named Product notes. ${bigText}`, { entities: ['named-product.md'], concepts: ['strong.md'] }));
  eq(order.map((s) => s.path).join(','), 'entities/named-product.md,concepts/strong.md', 'a page the source names comes before a higher-scoring unnamed one');
  const block = renderExistingFactsBlock(bsel, 'changes.md');
  ok(block.length <= EXISTING_FACTS_MAX_CHARS && block.length > 2000, `the whole block is at most ${EXISTING_FACTS_MAX_CHARS} characters`, `${block.length}`);
  const b1 = renderExistingFactsBlock(sel, 'tidewater-v1.5.md');
  ok(b1.startsWith(HEADER) && /write ONLY what is new or changed/.test(b1) && /do not remove or rewrite an old one/.test(b1)
    && /Return that page, at the same path/.test(b1) && /\(tidewater-v1\.5\)/.test(b1), 'the instruction: return the page, only new or changed facts, with version and source, never remove the old');
}

// ── 2 ────────────────────────────────────────────────────────────────────────
section('2. the block reaches the model only for a data source that updates existing pages');
{
  const FILES = { entities: ['tidewater-ledger.md'], concepts: ['risk-scoring.md'] };
  const sel = selectExistingFacts(FOLLOW, [{ path: 'entities/tidewater-ledger.md', content: PRODUCT }, { path: 'concepts/risk-scoring.md', content: RISK }], nameMentions(FOLLOW, FILES));
  const block = renderExistingFactsBlock(sel, 'v15.md');
  const note = renderExistingFactsOutlineNote(sel);
  const strip = (p) => p.replace(`\n${block}\n`, '').replace(`\n${note}\n`, '');
  for (const strict of [false, true]) {
    const withB = buildPrompt('2026-11-14', '| idx |', FILES, 'v15.md', FOLLOW, strict, false, 'summaries/v15.md', block);
    const without = buildPrompt('2026-11-14', '| idx |', FILES, 'v15.md', FOLLOW, strict, false, 'summaries/v15.md');
    eq(withB.split(block).length - 1, 1, `${strict ? 'strict' : 'single pass'}: the block exactly once`);
    eq(strip(withB), without, `${strict ? 'strict' : 'single pass'}: minus the block = the prompt built without it`);
    ok(withB.indexOf(block) > withB.indexOf(strict ? 'HARD DATA' : KEY_FACTS_RULE) && withB.indexOf(block) < withB.indexOf('Page body rules:'), `${strict ? 'strict' : 'single pass'}: after the Key Facts rule`);
  }
  const o1 = buildOutlinePrompt('2026-11-14', '| idx |', FILES, 'v15.md', FOLLOW, false, 'summaries/v15.md', note);
  const o0 = buildOutlinePrompt('2026-11-14', '| idx |', FILES, 'v15.md', FOLLOW, false, 'summaries/v15.md');
  ok(o1.includes(note) && !o1.includes(block), 'outline: the page names, not the excerpt');
  eq(strip(o1), o0, 'outline minus the note = the outline built without it');
  const all = [{ path: 'summaries/v15.md', summary: 'S' }, { path: 'entities/tidewater-ledger.md', summary: 'T' }, { path: 'concepts/risk-scoring.md', summary: 'R' }, { path: 'concepts/x.md', summary: 'X' }, { path: 'concepts/y.md', summary: 'Y' }];
  const p1 = buildBatchPromptParts('2026-11-14', 'v15.md', FOLLOW, all.slice(0, 4), FILES, all, block);
  const p2 = buildBatchPromptParts('2026-11-14', 'v15.md', FOLLOW, all.slice(4), FILES, all, block);
  const p0 = buildBatchPromptParts('2026-11-14', 'v15.md', FOLLOW, all.slice(0, 4), FILES, all);
  eq(p1.prefix, p2.prefix, 'batch: the prefix is byte-identical across batches, block included');
  ok(p1.prefix.includes(block) && !p1.suffix.includes(block), 'batch: the block is in the prefix');
  eq(strip(p1.prefix), p0.prefix, 'batch prefix minus the block = the prefix built without it');
  eq(p1.suffix, p0.suffix, 'batch: the suffix is unchanged');

  // Through ingestFile's seam: single pass and the strict retry.
  const run = async (domain, name, text, reply) => {
    const prompts = [];
    let call = 0;
    const res = await quiet(() => ingestFile(domain.name, sourceFile(name, text), name, false, null, {
      llm: async (schema, prompt, max, fmt, onWait, opts) => {
        usage(opts); prompts.push(prompt); call++;
        return typeof reply === 'function' ? reply(prompt, call) : reply;
      },
    }));
    return { prompts, res };
  };
  const pagesOf = () => ({ 'entities/tidewater-ledger.md': PRODUCT, 'concepts/risk-scoring.md': RISK, 'concepts/orchard-yields.md': UNRELATED });
  const NEW_LINE = '- As of v1.5 (v15): `risk-svc` listens on port 7113 (was 7103)';
  const d1 = makeDomain(pagesOf());
  const r1 = await run(d1, 'v15.md', FOLLOW, (prompt, n) => (n === 1 ? '}{' : JSON.stringify({ title: 'v1.5', pages: [
    { path: 'summaries/v15.md', content: '# v1.5\n\n## Key Takeaways\n- risk moved\n' },
    { path: 'entities/tidewater-ledger.md', content: `# Tidewater Ledger\n\nType: product\n\n## Key Facts\n${NEW_LINE}\n` },
  ] })));
  ok(r1.prompts.length >= 2, 'the first reply did not parse, so the strict retry ran', `${r1.prompts.length}`);
  ok(r1.prompts.every((p) => p.includes(HEADER) && p.includes('port 7103 (v1.4)')), 'single pass and the strict retry both carry the excerpt');
  ok(!r1.prompts[0].includes('Orchard'), 'the unrelated page is not in the prompt');
  eq(JSON.stringify(r1.res && r1.res.existingFactsShown && r1.res.existingFactsShown.pages), JSON.stringify(['entities/tidewater-ledger.md', 'concepts/risk-scoring.md']), 'the result names the pages shown');
  const after = d1.read('entities/tidewater-ledger.md');
  ok(after.includes(NEW_LINE), 'the changed fact landed on the existing page');
  ok(PRODUCT.split('\n').filter((l) => l.trim() && !/^created:/.test(l)).every((l) => after.includes(l)), 'every old line of the page is still there (knowledge accumulates)');

  const none = async (label, domain, name, text) => {
    const r = await run(domain, name, text, JSON.stringify({ title: 'x', pages: [
      { path: `summaries/${name.replace(/\.md$/, '')}.md`, content: '# x\n\n## Key Takeaways\n- y\n' }, { path: 'entities/zz-new.md', content: '# Z\n\nType: tool\n- z\n' }] }));
    ok(r.prompts.length > 0 && r.prompts.every((p) => !p.includes(HEADER)), label);
    return r;
  };
  await none('prose into the same domain: no block', makeDomain(pagesOf()), 'essay.md', PROSE);
  const PROSE_NAMING = Array.from({ length: 6 }, () => 'Tidewater Ledger began as a small team that cared about merchants, and the people who built Tidewater Ledger wrote about trust, patience and craft.').join('\n\n');
  ok(!ingest.sourceHasHardData(PROSE_NAMING) && selectExistingFacts(PROSE_NAMING, [{ path: 'entities/tidewater-ledger.md', content: PRODUCT }], nameMentions(PROSE_NAMING, { entities: ['tidewater-ledger.md'], concepts: [] })).length === 1,
    'CONTROL: a prose essay that names the product would select its page, were it a data source');
  await none('prose that names an existing page: still no block (the gate decides)', makeDomain(pagesOf()), 'story.md', PROSE_NAMING);
  await none('a data source into an empty domain: no block', makeDomain(), 'v15.md', FOLLOW);
  await none('a data source into a domain of unrelated pages: no block', makeDomain({ 'concepts/orchard-yields.md': UNRELATED }), 'v15.md', FOLLOW);
  // The prose prompt is byte-identical to the one the builder makes without a block.
  const dp = makeDomain(pagesOf());
  const rp = await none('prose (again)', dp, 'essay2.md', PROSE);
  ok(rp.res && rp.res.existingFactsShown === null, 'prose: nothing shown');

  // A re-reading of the same bytes by another model: no block (planRepeatIngest owns that case).
  const dr = makeDomain(pagesOf());
  const reply = JSON.stringify({ title: 'v1.5', pages: [{ path: 'summaries/v15.md', content: '# v1.5\n\n## Key Takeaways\n- a\n' }, { path: 'entities/zz-new.md', content: '# Z\n\nType: tool\n- z\n' }] });
  const src = sourceFile('v15.md', FOLLOW);
  await quiet(() => ingestFile(dr.name, src, 'v15.md', false, null, { buildModel: 'model-a', llm: async (s, p, m, f, w, o) => { usage(o); return reply; } }));
  const again = [];
  await quiet(() => ingestFile(dr.name, src, 'v15.md', true, null, { buildModel: 'model-b', llm: async (s, p, m, f, w, o) => { usage(o); again.push(p); return reply; } }));
  ok(again.length > 0 && again.every((p) => !p.includes(HEADER)), 'the same bytes read again by another model: no block', `${again.length} calls`);
}

// ── 3 ────────────────────────────────────────────────────────────────────────
section('3. multi-phase: an updated page the outline left out is planned, and its old lines stay');
{
  const d = makeDomain({ 'entities/tidewater-ledger.md': PRODUCT, 'concepts/risk-scoring.md': RISK });
  const LONG = FOLLOW + Array.from({ length: 420 }, (_, i) => `- \`svc-${i}\` change ${i}: limit ${1000 + i} requests.`).join('\n');
  const calls = [];
  const plan = ['entities/a.md', 'concepts/b.md', 'concepts/c.md', 'concepts/d.md', 'concepts/e.md'];
  await quiet(() => ingestFile(d.name, sourceFile('big.md', LONG), 'big.md', false, null, {
    llm: async (schema, prompt, max, fmt, onWait, opts) => {
      usage(opts);
      const asked = askedPaths(prompt);
      if (!asked.length) { calls.push({ outline: true, prompt }); return JSON.stringify({ title: 'Big', pages: ['summaries/big.md', ...plan].map((p) => ({ path: p, summary: `about ${p}` })) }); }
      calls.push({ asked, prompt, prefixChars: opts && opts.cachePrefixChars });
      return JSON.stringify({ pages: asked.map((p) => ({ path: p, summary: `s ${p}`, content: p === 'entities/tidewater-ledger.md'
        ? '# Tidewater Ledger\n\n## Key Facts\n- As of v1.5 (big): `risk-svc` listens on port 7113 (was 7103)\n'
        : `# ${p}\n\n- point about ${p}\n` })) });
    },
  }));
  const outline = calls.find((c) => c.outline);
  const batches = calls.filter((c) => c.asked);
  ok(outline && outline.prompt.includes(HEADER) && outline.prompt.includes('entities/tidewater-ledger.md') && !outline.prompt.includes('port 7103 (v1.4)'), 'the outline gets the page names, not the excerpt');
  ok(batches.length >= 2, 'two or more batches ran', `${batches.length}`);
  const prefixes = batches.map((c) => c.prompt.slice(0, c.prompt.indexOf('\n\nWrite the full markdown content')));
  ok(prefixes.every((p) => p === prefixes[0]) && prefixes[0].includes('port 7103 (v1.4)'), 'every batch prefix is byte-identical and carries the excerpt');
  ok(batches.every((c) => c.prefixChars === prefixes[0].length), 'the cache breakpoint is still the whole prefix');
  const askedAll = batches.flatMap((c) => c.asked);
  ok(askedAll.includes('entities/tidewater-ledger.md') && askedAll.includes('concepts/risk-scoring.md'), 'the updated pages the outline left out were planned and asked for');
  const after = d.read('entities/tidewater-ledger.md');
  ok(after.includes('- As of v1.5 (big): `risk-svc` listens on port 7113 (was 7103)'), 'the changed fact is on the page');
  ok(after.includes('- `risk-svc` listens on port 7103 (v1.4)') && after.includes('- Serves 4,800 merchants'), 'and the old facts stay');
  eq(d.read('concepts/risk-scoring.md').includes('- A score above 910 is declined'), true, 'a page written with nothing new keeps its text');
}

// ── 4 ────────────────────────────────────────────────────────────────────────
section('4. a summary-only reply to an update triggers the follow-up retry, naming the pages');
{
  const d = makeDomain({ 'entities/tidewater-ledger.md': PRODUCT, 'concepts/risk-scoring.md': RISK });
  const prompts = [];
  const res = await quiet(() => ingestFile(d.name, sourceFile('v15.md', FOLLOW), 'v15.md', false, null, {
    llm: async (schema, prompt, max, fmt, onWait, opts) => {
      usage(opts); prompts.push(prompt);
      const pages = [{ path: 'summaries/v15.md', content: '# v1.5\n\n## Key Takeaways\n- a\n' }];
      if (prompts.length > 1) pages.push({ path: 'entities/tidewater-ledger.md', content: '# Tidewater Ledger\n\n## Key Facts\n- As of v1.5 (v15): port 7113 (was 7103)\n' });
      return JSON.stringify({ title: 'v1.5', pages });
    },
  }));
  ok(ingest.coveredExistingTopics(FOLLOW, { entities: ['tidewater-ledger.md'], concepts: ['risk-scoring.md'] }).length === 0, 'CONTROL: by name mentions alone the source covers no page (the old trigger)');
  eq(prompts.length, 2, 'the summary-only reply was retried once');
  ok(prompts[1] && /already have pages in this wiki: entities\/tidewater-ledger\.md/.test(prompts[1]), 'the retry names the page the source updates');
  ok(res && res.followupRetry && res.followupRetry.accepted !== undefined, 'the retry is recorded');
  ok(d.read('entities/tidewater-ledger.md').includes('port 7113 (was 7103)'), 'and its page was written');
}

// ── 5 ────────────────────────────────────────────────────────────────────────
section('5. the estimate prices the block on a domain with pages, and only there');
{
  for (const M of ['gemini-3.5-flash-lite', 'claude-haiku-5-5']) {
    const price = llmMod.getModelPrice(M);
    const est = (promptFiles, keyFacts, size = 3000) => qt.estimateOneFile({ f: { name: 'v15.md', size }, promptFiles, index: '', today: '2026-11-14', price, model: M, keyFacts });
    const empty = { entities: [], concepts: [] };
    const full = { entities: ['tidewater-ledger.md'], concepts: [] };
    const onFull = est(full, 'on'), onEmpty = est(empty, 'on'), offFull = est(full, 'off');
    const offFullBase = est(full, 'off');
    const listing = est(full, 'on').inputTokens - est(empty, 'on').inputTokens;
    ok(listing * 4 >= EXISTING_FACTS_MAX_CHARS * 0.9, `${M}: a data source on a domain with pages carries the block's full size in input`, `${listing} tokens`);
    ok(onFull.outputTokens - onEmpty.outputTokens === queue.EXISTING_FACTS_EXTRA_OUTPUT_TOKENS[/^gemini/.test(M) ? 'gemini' : 'anthropic'], `${M}: and the measured output allowance`);
    ok(onFull.usdHigh > onEmpty.usdHigh, `${M}: so the dear bound is higher`);
    eq(offFull.inputTokens, offFullBase.inputTokens, `${M}: prose: unchanged`);
    const big = est(full, 'on', 40000), bigEmpty = est(empty, 'on', 40000);
    ok(big.mode === 'multi-phase' && big.inputTokens - bigEmpty.inputTokens >= big.totalCalls * EXISTING_FACTS_MAX_CHARS / 4 * 0.9, `${M}: multi-phase: the block on every call`);
  }
}

console.log(`\n${'─'.repeat(60)}\nPassed: ${passed}   Failed: ${failed}`);
if (failed) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All existing-facts assertions green');
