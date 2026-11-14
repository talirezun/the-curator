#!/usr/bin/env node
/**
 * Ingest keeps a source's hard data — the Key Facts rule (2026-11-14). Offline, no key.
 *
 * Not every source is an article: a pricing strategy, a budget, a spec sheet or an
 * architecture document carries numbers and identifiers chat must be able to read
 * back. This suite holds:
 *   1. the rule is on EVERY prompt path that writes a page (single pass, strict retry,
 *      each Phase 2 batch, the page-by-page fallback, the concise retry), driven through
 *      ingestFile's test seam rather than read off the source;
 *   2. it is the ONLY change: each prompt minus the block is the shipped prompt, and
 *      the batch prefix is still byte-identical across the batches of one ingest;
 *   3. a changed figure survives exact-name reuse, while a reworded line still goes
 *      (the 0.5 rule for prose stands);
 *   4. Key Facts bullets that open with the same link are two facts, not one; a
 *      table in Key Facts survives a write and a re-write byte for byte;
 *   5. a template heading that swallowed its first sentence is split, and nothing
 *      else is (real headings, fences, frontmatter);
 *   6. the link tidy leaves inline code and fences alone; hub linkification leaves
 *      table rows alone;
 *   7. new domains' CLAUDE.md shows `## Key Facts`; Health's summary tidy and the
 *      summary shape check accept it;
 *   8. the Shared Brain's deterministic steps keep figures and backticks as written.
 *
 * Every guard here was proven by mutation: see the commit that added this file.
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

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'curator-keyfacts-'));
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
const files = await import('../src/brain/files.js');
const merge = await import('../src/brain/page-merge.js');
const synth = await import('../src/brain/sharedbrain-synthesis.js');
const { ingestFile, KEY_FACTS_RULE, KEY_FACTS_RULE_STRICT, KEY_FACTS_CONCISE, summaryShapeWarning } = ingest;
const { buildPrompt, buildBatchPromptParts, linkifyHubPages, CONCISE_PAGE_DIRECTIVE } = ingest.__testing;
const { writePage, createDomain, splitSwallowedHeadings, tidySummaryLinkSections, summaryTidyGuard } = files;

const digest = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const quiet = async (fn) => {
  const e = console.error, w = console.warn, l = console.log;
  console.error = () => {}; console.warn = () => {};
  try { return await fn(); } finally { console.error = e; console.warn = w; console.log = l; }
};

let seq = 0;
function makeDomain(pages = {}) {
  const name = `d${++seq}`;
  const dd = path.join(DOMAINS, name);
  for (const d of ['wiki/entities', 'wiki/concepts', 'wiki/summaries', 'raw', 'conversations']) mkdirSync(path.join(dd, d), { recursive: true });
  writeFileSync(path.join(dd, 'CLAUDE.md'), '# Test domain schema\n', 'utf8');
  writeFileSync(path.join(dd, 'wiki', 'index.md'), '# Index\n\n| Page | Type | Summary |\n|---|---|---|\n', 'utf8');
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
const FILES = { entities: ['alice.md', 'trust-grader.md'], concepts: ['rag.md'] };

// ── 1 ────────────────────────────────────────────────────────────────────────
section('1. the rule reaches the model on every path that writes a page');
{
  ok(/"## Key Facts"/.test(KEY_FACTS_RULE) && /directly after "## Key Takeaways"/.test(KEY_FACTS_RULE), 'the rule names the section and where it goes');
  ok(/EXACTLY as the source does/.test(KEY_FACTS_RULE) && /period or as-of date or version/.test(KEY_FACTS_RULE), 'figures exactly as written, with their period or version');
  ok(/backticks/.test(KEY_FACTS_RULE) && /API endpoints \(method and path\)/.test(KEY_FACTS_RULE) && /configuration keys and their defaults/.test(KEY_FACTS_RULE),
    'technical specifics: identifiers in backticks, endpoints, config defaults');
  ok(/40 bullets/.test(KEY_FACTS_RULE) && /at most 15 rows/.test(KEY_FACTS_RULE), 'its own cap: 40 bullets, a table at most 15 rows');
  ok(/essay, article or opinion piece whose numbers are incidental gets none/.test(KEY_FACTS_RULE), 'an ordinary article is told it gets no section');
  ok(/Never write an empty Key Facts section/.test(KEY_FACTS_RULE), 'never an empty section');
  ok(/at most 15 bullets/.test(KEY_FACTS_RULE_STRICT) && /at most 15 bullets/.test(KEY_FACTS_CONCISE), 'strict and concise retries keep Key Facts at a smaller cap');

  // Single pass, then its strict retry: a short reply that does not parse.
  const d1 = makeDomain();
  const prompts1 = [];
  let call = 0;
  await quiet(() => ingestFile(d1.name, sourceFile('plan.md', 'Price list for 2028: Basic tier €10 a month, Pro tier €20 a month, billed yearly.\n'.repeat(12)), 'plan.md', false, null, {
    llm: async (schema, prompt, max, fmt, onWait, opts) => {
      usage(opts); prompts1.push(prompt); call++;
      if (call === 1) return '}{';
      return JSON.stringify({ title: 'Plan', pages: [{ path: 'summaries/plan.md', content: '# Plan\n\n## Key Takeaways\n- Two tiers\n' }] });
    },
  }));
  ok(prompts1.length >= 2, 'single pass failed to parse once and was retried strictly', `${prompts1.length} calls`);
  ok(prompts1[0].includes(KEY_FACTS_RULE) && !prompts1[0].includes(KEY_FACTS_RULE_STRICT), 'the single-pass prompt carries the rule');
  ok(prompts1[1] && prompts1[1].includes(KEY_FACTS_RULE_STRICT) && !prompts1[1].includes(KEY_FACTS_RULE), 'the strict retry carries the strict rule instead');

  // Multi-phase: outline, two batches; batch 2 fails → page by page → concise retry.
  const d2 = makeDomain();
  const calls = [];
  const plan = ['entities/a.md', 'entities/b.md', 'concepts/c.md', 'concepts/d.md', 'concepts/e.md', 'concepts/f.md'];
  const LONG = Array.from({ length: 400 }, (_, i) => `Line ${i}: the budget for item ${i} is €${1000 + i}.`).join('\n');
  let singleFails = 0;
  await quiet(() => ingestFile(d2.name, sourceFile('budget.md', LONG), 'budget.md', false, null, {
    llm: async (schema, prompt, max, fmt, onWait, opts) => {
      usage(opts);
      const asked = askedPaths(prompt);
      if (!asked.length) return JSON.stringify({ title: 'Budget', pages: ['summaries/budget.md', ...plan].map((p) => ({ path: p, summary: `about ${p}` })) });
      calls.push({ asked, prompt, prefixChars: opts && opts.cachePrefixChars });
      if (asked.includes('concepts/e.md') && asked.length > 1) return '{"pages": []}';
      if (asked.length === 1 && asked[0] === 'concepts/e.md' && singleFails++ === 0) return 'not json';
      return JSON.stringify({ pages: asked.map((p) => ({ path: p, summary: `s ${p}`, content: `# ${p}\n\n## Key Facts\n- fact of ${p}: €1,${p.length}00\n` })) });
    },
  }));
  const batches = calls.filter((c) => c.asked.length > 1);
  const singles = calls.filter((c) => c.asked.length === 1);
  const concise = calls.filter((c) => c.prompt.includes('BE BRIEF'));
  ok(batches.length >= 2, 'the ingest ran at least two Phase 2 batches', `${batches.length}`);
  ok(calls.every((c) => c.prompt.includes(KEY_FACTS_RULE)), 'every Phase 2 call (batches, single pages, concise) carries the rule');
  const prefixes = calls.map((c) => buildBatchPromptParts ? c.prompt.slice(0, c.prompt.indexOf('\n\nWrite the full markdown content')) : '');
  ok(prefixes.every((p) => p === prefixes[0]), 'the prefix is byte-identical across every batch and single page of one ingest (caching)');
  ok(prefixes[0].includes(KEY_FACTS_RULE), 'the rule sits in that stable prefix');
  ok(batches.every((c) => c.prefixChars === prefixes[0].length), 'the cache breakpoint is the prefix, rule included');
  ok(singles.length >= 1 && concise.length === 1, 'the failed batch fell to page by page, then one concise retry', `${singles.length} singles, ${concise.length} concise`);
  ok(concise[0] && concise[0].prompt.endsWith(CONCISE_PAGE_DIRECTIVE + KEY_FACTS_CONCISE), 'the concise retry ends with the brevity directive plus the Key Facts line (suffix only)');
  ok(d2.read('concepts/e.md').includes('## Key Facts'), 'the page the concise retry wrote keeps its Key Facts');

  // The same failure on a source without hard data: the shipped prompts, no Key Facts line.
  const d3 = makeDomain();
  const calls3 = [];
  let fails3 = 0;
  const PROSE_LONG = Array.from({ length: 400 }, (_, i) => `Paragraph about orchards, rivers and the harbour town, part ${i % 9}.`).join('\n');
  await quiet(() => ingestFile(d3.name, sourceFile('essay.md', PROSE_LONG), 'essay.md', false, null, {
    llm: async (schema, prompt, max, fmt, onWait, opts) => {
      usage(opts);
      const asked = askedPaths(prompt);
      if (!asked.length) return JSON.stringify({ title: 'Essay', pages: ['summaries/essay.md', ...plan].map((p) => ({ path: p, summary: `about ${p}` })) });
      calls3.push(prompt);
      if (asked.includes('concepts/e.md') && asked.length > 1) return '{"pages": []}';
      if (asked.length === 1 && asked[0] === 'concepts/e.md' && fails3++ === 0) return 'not json';
      return JSON.stringify({ pages: asked.map((p) => ({ path: p, summary: `s ${p}`, content: `# ${p}\n\n- a point\n` })) });
    },
  }));
  ok(calls3.length > 0 && calls3.every((p) => !p.includes('HARD DATA')), 'prose: no Phase 2 call carries the rule');
  const concise3 = calls3.filter((p) => p.includes('BE BRIEF'));
  ok(concise3.length === 1 && concise3[0].endsWith(CONCISE_PAGE_DIRECTIVE), 'prose: the concise retry is the shipped one, no Key Facts line');
}

// ── 2 ────────────────────────────────────────────────────────────────────────
section('2. sent only for a source with hard data, and then the only change');
{
  const strip = (p) => p.replace('\n\n' + KEY_FACTS_RULE_STRICT, '').replace('\n\n' + KEY_FACTS_RULE, '');
  const DATA = 'Pricing for 2028. Basic tier: €10 a month, 50 seats, 99.5% uptime. Pro tier: €20 a month, 200 seats, 99.9% uptime.\n'
    + '| Tier | Fee | Seats |\n|---|---|---|\n| Basic | €10 | 50 |\n| Pro | €20 | 200 |\n'
    + 'The API listens on `port 9310`; `TIMEOUT_MS` defaults to `3000`. Quotes are valid for 45 days.\n';
  const PROSE = readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'test-ingest-deep-inputs', '04-multi-phase.md'), 'utf8');

  ok(ingest.sourceHasHardData(DATA), 'the gate: a price list with a table and config keys is a data source', JSON.stringify(ingest.hardDataDensity(DATA)));
  ok(!ingest.sourceHasHardData(PROSE), 'the gate: the 17 KB prose fixture is not', JSON.stringify(ingest.hardDataDensity(PROSE)));
  const FIXDIR = path.join(path.dirname(new URL(import.meta.url).pathname), 'test-ingest-deep-inputs');
  const { readdirSync } = await import('node:fs');
  const above = readdirSync(FIXDIR).filter((f) => ingest.sourceHasHardData(readFileSync(path.join(FIXDIR, f), 'utf8')));
  eq(above.join(','), '', 'the gate: none of the live suite\'s prose fixtures is a data source');
  ok(!ingest.sourceHasHardData('Buy milk (€2) and bread (€3).'), 'the gate: a tiny note with two prices is not (fewer than 6 items)');
  ok(!ingest.sourceHasHardData('In 2024 and 2025 the team grew, and in 2026 it moved. Chapter 1, 2 and 3 cover this.'.repeat(4)), 'the gate: bare years and small counts are not data');

  // A source without hard data gets the shipped prompt, byte for byte (pinned digests).
  const single0 = buildPrompt('2026-09-30', '| idx |', FILES, 'src.md', PROSE, false, false, 'summaries/src.md');
  ok(!single0.includes('HARD DATA') && !single0.includes('Key Facts'), 'prose: the single-pass prompt carries no part of the rule');
  const all = [{ path: 'summaries/s.md', summary: 'S' }, { path: 'entities/alice.md', summary: 'A' }, { path: 'entities/trust-grader.md', summary: 'T' }, { path: 'concepts/rag.md', summary: 'R' }, { path: 'concepts/x.md', summary: 'X' }];
  // The v3.80.0 prefix digest over these fixtures, recorded in test-ingest-coverage-v381.js.
  eq(digest(buildBatchPromptParts('2026-09-30', 'src.md', 'SOURCE TEXT', all.slice(0, 4), FILES, all).prefix),
    '9ebe04513c603696ba37f3d088da59bb5029ebed7beb75337e72086eb783733a', 'no hard data: the batch prefix is the shipped v3.80.0 prefix');

  // A data source: the block once, in the right place, and removing it gives exactly
  // the prompt the gate-off path builds for the same text.
  const single = buildPrompt('2026-09-30', '| idx |', FILES, 'src.md', DATA, false, false, 'summaries/src.md');
  const strict = buildPrompt('2026-09-30', '', FILES, 'src.md', DATA, true, true, 'summaries/src.md');
  eq(single.split(KEY_FACTS_RULE).length - 1, 1, 'single pass: the rule exactly once');
  eq(strict.split(KEY_FACTS_RULE_STRICT).length - 1, 1, 'strict: the strict rule exactly once');
  ok(single.indexOf(KEY_FACTS_RULE) > single.indexOf('No long prose.') && single.indexOf(KEY_FACTS_RULE) < single.indexOf('Page body rules:'),
    'single pass: right after the conciseness line it qualifies');
  const p1 = buildBatchPromptParts('2026-09-30', 'src.md', DATA, all.slice(0, 4), FILES, all);
  const p2 = buildBatchPromptParts('2026-09-30', 'src.md', DATA, all.slice(4), FILES, all);
  eq(p1.prefix, p2.prefix, 'batch prefix: byte-identical across batches');
  ok(p1.prefix.includes(KEY_FACTS_RULE) && !p1.suffix.includes(KEY_FACTS_RULE), 'batch: the rule is in the prefix, not the suffix');
  ingest.__setKeyFactsGateForTest(false);
  const offSingle = buildPrompt('2026-09-30', '| idx |', FILES, 'src.md', DATA, false, false, 'summaries/src.md');
  const offStrict = buildPrompt('2026-09-30', '', FILES, 'src.md', DATA, true, true, 'summaries/src.md');
  const offBatch = buildBatchPromptParts('2026-09-30', 'src.md', DATA, all.slice(0, 4), FILES, all);
  ingest.__setKeyFactsGateForTest(null);
  eq(strip(single), offSingle, 'single pass minus the block = the shipped prompt for the same text');
  eq(strip(strict), offStrict, 'strict minus the block = the shipped prompt');
  eq(strip(p1.prefix), offBatch.prefix, 'batch prefix minus the block = the shipped prefix');
  eq(p1.suffix, offBatch.suffix, 'the batch suffix is unchanged');
}

// ── 3 ────────────────────────────────────────────────────────────────────────
section('3. a changed figure survives exact-name reuse; a rewording still goes');
{
  const PAGE = `---\ntype: concept\ntags: [type/concept]\ncreated: 2026-01-01\n---\n# Monthly Fee\n\n## Definition\nThe price a customer pays each month for the plan.\n\n## Key Facts\n- Monthly fee for the 2028 plan: €3,200 per seat\n\n| Seats | Fee |\n|---|---|\n| 12 | €3,500 |\n`;
  const d = makeDomain({ 'concepts/monthly-fee.md': PAGE });
  const warnings = [];
  await quiet(() => writePage(d.name, 'concepts/monthly-fee.md',
    `# Monthly Fee\n\n## Definition\nThe price each customer pays every month for that plan.\n\n## Key Facts\n- Monthly fee for the 2028 plan: €3,500 per seat\n`,
    { onWarn: (w) => warnings.push(w) }));
  const after = d.read('concepts/monthly-fee.md');
  ok(after.includes('- Monthly fee for the 2028 plan: €3,500 per seat'), 'the changed figure is kept, though 3,500 is already in the table');
  ok(after.includes('- Monthly fee for the 2028 plan: €3,200 per seat'), 'the earlier figure stays (no lost line)');
  ok(!after.includes('The price each customer pays every month for that plan.'), 'CONTROL: the reworded definition still goes (the 0.5 rule for prose)');
  ok(warnings.some((w) => /not added/.test(w)), 'and its drop is reported');
  ok(after.includes('| 12 | €3,500 |') && after.split('| 12 | €3,500 |').length === 2, 'the table is there once, untouched');

  // Unit test of the rule itself.
  const words = (t) => new Set(t.toLowerCase().replace(/(\d),(?=\d)/g, '$1').replace(/[^\p{L}\p{N}.%-]+/gu, ' ').split(/\s+/).filter(Boolean));
  const pageText = 'Monthly fee: €3,200 per seat.\nThreshold €3,500 net.';
  const pageWords = words(pageText);
  const lines = pageText.split('\n').map(words);
  ok(merge.isMostlyNew('Monthly fee: €3,500 per seat.', pageWords, lines), 'isMostlyNew: a statement with a changed figure is new');
  ok(!merge.isMostlyNew('Monthly fee: €3,200 per seat.', pageWords, lines), 'isMostlyNew: the same statement and figure is not');
  ok(!merge.isMostlyNew('Monthly fee: €3,500 per seat.', pageWords), 'CONTROL: without the page lines (the old rule) it was dropped — the hole this closes');
}

// ── 4 ────────────────────────────────────────────────────────────────────────
section('4. Key Facts: two facts are two bullets, and a table survives');
{
  const d = makeDomain();
  const SUM = `# Corvane Plan\n\n## Key Takeaways\n- Four tiers\n- [[corvane]] sells tiers\n- [[corvane]] sells robots\n\n## Key Facts\n- [[corvane]] Fleet tier (2028): €13,800 a month\n- [[corvane]] Lite tier (2028): €2,490 a month\n- [[corvane]] Fleet tier (2028): €13,800 a month\n\n| Tier | Monthly fee (2028) |\n|---|---|\n| Courier Lite | €2,490 |\n| Fleet | €13,800 |\n\n## Entities Mentioned\n- [[corvane]]\n`;
  await quiet(() => writePage(d.name, 'summaries/corvane-plan.md', SUM));
  const s = d.read('summaries/corvane-plan.md');
  ok(s.includes('- [[corvane]] Lite tier (2028): €2,490 a month'), 'a second fact opening with the same link is kept');
  eq(s.split('- [[corvane]] Fleet tier (2028): €13,800 a month').length - 1, 1, 'an identical fact is still removed once');
  ok(!s.includes('- [[corvane]] sells robots'), 'CONTROL: Key Takeaways keeps the first-link key (unchanged behaviour)');
  const TABLE = '| Tier | Monthly fee (2028) |\n|---|---|\n| Courier Lite | €2,490 |\n| Fleet | €13,800 |';
  ok(s.includes(TABLE), 'the Key Facts table is written byte for byte');
  await quiet(() => writePage(d.name, 'summaries/corvane-plan.md', SUM.replace('## Entities Mentioned', '- [[corvane]] Fleet Enterprise tier (2028): €31,500 a month\n\n## Entities Mentioned')));
  const s2 = d.read('summaries/corvane-plan.md');
  ok(s2.includes(TABLE) && s2.split(TABLE).length === 2, 'a re-write keeps the table once, byte for byte');
  ok(s2.includes('€31,500'), 'and adds the new fact');
  eq(files.sectionDedupKey('Key Facts', '- [[x]] costs €5'), '- [[x]] costs €5', 'sectionDedupKey: a figure in Key Facts keys on the whole line');
  eq(files.sectionDedupKey('Key Facts', '- [[x]]  is   great'), '- [[x]] is great', 'sectionDedupKey: every Key Facts bullet keys on its whole normalised line');
  // Audit: five facts about one service, no figures, all opening with or holding its link.
  const d5 = makeDomain();
  const FIVE = ['- [[auth-service]] owns API key issuance and rotation', '- The gateway forwards every request to [[auth-service]] over mTLS',
    '- [[auth-service]] must never log tokens', '- [[auth-service]] keeps the previous key valid after rotation', '- Decision: [[auth-service]] stays separate from billing, for audit reasons'];
  await quiet(() => writePage(d5.name, 'summaries/arch.md', `# Arch\n\n## Key Takeaways\n- one\n\n## Key Facts\n${FIVE.join('\n')}\n- [[auth-service]] must never log tokens\n`));
  const a5 = d5.read('summaries/arch.md');
  ok(FIVE.every((l) => a5.includes(l)), 'all five facts about [[auth-service]] survive a first write (the first-link key kept two)');
  eq(a5.split('- [[auth-service]] must never log tokens').length - 1, 1, 'an exact repeat is still removed');
  eq(files.sectionDedupKey('Related', '- [[x]] costs €5'), files.dedupKey('- [[x]] costs €5'), 'sectionDedupKey: every other section keeps dedupKey');

  const merged = files.mergeWikiPage('# P\n\n## Key Facts\n- [[p]] price (2027): €10\n', '# P\n\n## Key Facts\n- [[p]] price (2028): €12\n');
  ok(merged.includes('€10') && merged.includes('€12'), 'mergeWikiPage (the stub path) unions Key Facts by whole line');
}

// ── 5 ────────────────────────────────────────────────────────────────────────
section('5. a template heading that swallowed its sentence is split; nothing else is');
{
  eq(splitSwallowedHeadings('# X\n\n## Definition A baseline monetary floor that guarantees the fee. It applies per seat.\n'),
    '# X\n\n## Definition\n\nA baseline monetary floor that guarantees the fee. It applies per seat.\n', 'split into heading + paragraph');
  eq(splitSwallowedHeadings('## Overview: The platform runs in two regions on Kubernetes.\n'), '## Overview\n\nThe platform runs in two regions on Kubernetes.\n', 'the colon form too');
  for (const h of ['## Summary Statistics for the 2024 Cohort', '## Related Work', '## Notes', '## Key Facts', '## Definition of Done for Each Release Train', '## Examples from the field.']) {
    eq(splitSwallowedHeadings(`${h}\n- x\n`), `${h}\n- x\n`, `left alone: "${h}"`);
  }
  const FENCED = '```md\n## Definition A floor that guarantees the fee. It applies.\n```\n';
  eq(splitSwallowedHeadings(FENCED), FENCED, 'never inside a code fence');
  const FM = '---\ntitle: "## Notes This is a value that looks like text. Really."\n---\n# T\n';
  eq(splitSwallowedHeadings(FM), FM, 'never inside frontmatter');
  const d = makeDomain();
  const SW = '# Floor\n\n## Definition A baseline monetary floor for each run of the course. It is paid in full.\n\n## Related\n- [[rag]]\n';
  await quiet(() => writePage(d.name, 'concepts/floor.md', SW, { splitHeadings: true }));
  ok(/^## Definition\n\nA baseline monetary floor/m.test(d.read('concepts/floor.md')), 'writePage splits it when the caller says the text is fresh model output');
  await quiet(() => writePage(d.name, 'concepts/floor2.md', SW));
  ok(d.read('concepts/floor2.md').includes('## Definition A baseline monetary floor'), 'and only then: without opts.splitHeadings the line is written as it came');
  // Content from disk written back (hub linkify, a mirror pull) is never split.
  const dd = makeDomain({ 'concepts/floor.md': SW });
  await quiet(() => writePage(dd.name, 'concepts/floor.md', SW, { replace: true, keepLines: true }));
  ok(dd.read('concepts/floor.md').includes('## Definition A baseline monetary floor'), 'a replace write-back of an existing page leaves its lines alone');
  // The audit's legitimate headings, and the corpus check (scripts note: 1 of 6,006 real pages, the original defect).
  for (const h of ['## Overview of Node.js vs. Deno performance in 2026', "## Summary of Dr. Smith's talk at NeurIPS", '## Related Work by J. Smith et al.',
    '## Key Facts (as of 1 Jan. 2027, all prices net)', '## Summary — What changed in Q3 2025?', '## Notes on the v2.1 migration. Read first',
    '## Definition The model reached 86% on the benchmark (Smith et al.', '## Overview The platform is described in detail by Dr.',
    '## Overview Of The Platform Architecture For Large Teams.', '## Summary The plan changes what we ship this year?']) {
    eq(splitSwallowedHeadings(h + '\n'), h + '\n', `left alone: "${h}"`);
  }
  eq(splitSwallowedHeadings('## Overview The platform runs in two regions on Kubernetes!\n'), '## Overview\n\nThe platform runs in two regions on Kubernetes!\n', 'an exclamation mark ends a sentence too');
}

// ── 6 ────────────────────────────────────────────────────────────────────────
section('6. identifiers in code stay exactly as written');
{
  const d = makeDomain({ 'concepts/rag.md': '# RAG\n' });
  const BODY = '# API\n\n## Key Facts\n- Endpoint `POST /v2/payments` with header `Idempotency-Key`\n- Literal `[[concepts/rag]]` in code\n- Real link [[concepts/rag]]\n\n```yaml\nlink: [[concepts/rag]]\n```\n';
  await quiet(() => writePage(d.name, 'entities/api.md', BODY));
  const t = d.read('entities/api.md');
  ok(t.includes('`[[concepts/rag]]`'), 'a [[link]] inside backticks is not rewritten');
  ok(t.includes('link: [[concepts/rag]]'), 'nor inside a code fence');
  ok(t.includes('- Real link [[rag]]'), 'CONTROL: a real link outside code is still tidied');
  ok(t.includes('`POST /v2/payments`') && t.includes('`Idempotency-Key`'), 'identifiers byte for byte');

  // Hub linkification never wraps text in a table row (a pipe would split the cell).
  const d2 = makeDomain({
    'concepts/fleet-tier.md': '# Fleet Tier\n\n- one\n',
    'concepts/tiers.md': '# Tiers\n\n- Fleet Tier is the middle\n- b\n- c\n- d\n- e\n\n| Tier | Fee |\n|---|---|\n| Fleet Tier | €13,800 |\n\nCode `Fleet Tier` here.\n',
  });
  await quiet(() => linkifyHubPages(d2.name, ['concepts/fleet-tier.md', 'concepts/tiers.md']));
  const hub = d2.read('concepts/tiers.md');
  ok(hub.includes('| Fleet Tier | €13,800 |'), 'a table row is not linkified');
  ok(hub.includes('`Fleet Tier`'), 'inline code is not linkified');
  ok(hub.includes('- [[fleet-tier|Fleet Tier]] is the middle'), 'CONTROL: a list item still is');
}

// ── 7 ────────────────────────────────────────────────────────────────────────
section('7. templates and Health accept the section');
{
  // The domain template is NOT changed (measured 2026-11-14): with `## Key Facts` in a
  // new domain's summary template, prose articles got the section too (the schema is
  // the system prompt, which no gate can reach). The gated prompt rule carries it.
  await createDomain('kf-template', 'KF Template', 'x', 'business');
  const md = readFileSync(path.join(DOMAINS, 'kf-template', 'CLAUDE.md'), 'utf8');
  const sum = md.slice(md.indexOf('**Summary page:**'), md.indexOf('## Cross-Referencing Rules'));
  ok(sum.includes('## Key Takeaways') && !sum.includes('## Key Facts'), 'a new domain\'s summary template is unchanged: no Key Facts (it would reach prose)');
  const SUMMARY = '---\ntype: summary\nsource: plan.md\n---\n# Plan\n\n## Key Takeaways\n- Two tiers\n\n## Key Facts\n- Basic (2028): €10\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n## Entities Mentioned\n- [[rag]]\n\n## Concepts Introduced or Referenced\n- [[alice]]\n';
  eq(summaryShapeWarning('summaries/plan.md', SUMMARY, 'plan.md'), null, 'summaryShapeWarning: a summary with Key Facts has no warning');
  const tidied = tidySummaryLinkSections(SUMMARY, { entitySlugs: new Set(['alice']), conceptSlugs: new Set(['rag']) });
  ok(tidied.content.includes('## Key Facts\n- Basic (2028): €10\n\n| A | B |\n|---|---|\n| 1 | 2 |'), 'the summary link tidy keeps Key Facts, table included');
  ok(tidied.changed && !tidied.refused && !summaryTidyGuard(SUMMARY, tidied.content), 'CONTROL: the tidy did move the two links, and its guard accepts it');
}

// ── 8 ────────────────────────────────────────────────────────────────────────
section('8. Shared Brain: the deterministic steps keep figures and identifiers');
{
  const FACT = 'As of v1.4, `risk-svc` listens on port 7103; `ORDERS_RISK_TIMEOUT_MS` defaults to `120` (2028)';
  eq(synth.sanitizeFellowText(FACT), FACT, 'sanitizeFellowText leaves a one-line fact byte for byte');
  const page = synth.composeCollectivePage({ title: 'Risk', type: 'entity', keyFacts: [FACT], relatedLinks: [], provenanceSection: '## Provenance\n- x\n', lastSynthesizedIso: '2028-06-02' });
  ok(page.includes(`## Key Facts\n\n- ${FACT}`), 'the collective page renders it under Key Facts unchanged');
  const d = makeDomain();
  await quiet(() => writePage(d.name, 'entities/risk.md', page, { replace: true }));
  ok(d.read('entities/risk.md').includes(`- ${FACT}`), 'and a mirror pull (writePage replace) writes it unchanged');
  ok(synth.sanitizeFellowText('| a | b |\n| 1 | 2 |') === '| a | b | | 1 | 2 |',
    'KNOWN: a multi-line table cannot cross the contribution path as a table (facts are one line each)');
}

// ── 9 ────────────────────────────────────────────────────────────────────────
section('9. audit follow-ups: tables, sibling figures, the gate, the response limit, placement');
{
  // 4. A table-heavy source says the wiki keeps a selection of its tables.
  const table = (n) => '| Item | Price (2028) |\n|---|---|\n' + Array.from({ length: n }, (_, i) => `| Part ${i} | €${100 + i} |`).join('\n') + '\n';
  ok(ingest.tableDataWarning(table(40)) && /41 table rows/.test(ingest.tableDataWarning(table(40))), 'tableDataWarning: 41 table rows (header included) → a warning that names the count');
  eq(ingest.tableDataWarning(table(39)), null, 'tableDataWarning: 40 rows (the Key Facts cap) → none');
  eq(ingest.tableDataWarning('An essay about rivers. '.repeat(200)), null, 'tableDataWarning: prose → none');
  const dT = makeDomain();
  const resT = await quiet(() => ingestFile(dT.name, sourceFile('parts.md', '# Parts list 2028\n\n' + table(60)), 'parts.md', false, null, {
    llm: async (schema, prompt, max, fmt, onWait, opts) => { usage(opts); return JSON.stringify({ title: 'Parts', pages: [{ path: 'summaries/parts.md', content: '# Parts\n\n## Key Takeaways\n- Sixty parts\n' }] }); },
  }));
  ok(resT.warnings.some((w) => /61 table rows/.test(w) && /raw\/ folder/.test(w)), 'ingest reports it to the user, with where the full tables are');

  // 5. A changed figure equal to a SIBLING line's figure is still new.
  const keep = '# Plan\n\n## Key Facts\n- Lite tier monthly fee: €2,490\n- Fleet tier monthly fee: €13,800\n';
  const dropped = [];
  const out = merge.composeReusedPage(keep, '# Plan\n\n## Key Facts\n- Lite tier monthly fee: €13,800\n', { keepFolder: 'summaries', dropped });
  ok(out.includes('- Lite tier monthly fee: €13,800') && !dropped.length, 'the Lite line with the Fleet figure is kept (compared with the line it most resembles)');
  const same = merge.composeReusedPage(keep, '# Plan\n\n## Key Facts\n- Fleet tier monthly fee: €13,800\n', { keepFolder: 'summaries' });
  eq(same, keep, 'CONTROL: a line the page already states, figures and all, adds nothing');

  // 6. The re-tuned gate: identifiers and tables count, not only numbers.
  const codeDoc = Array.from({ length: 25 }, (_, i) => `The service \`svc-${'abcdefghijklmnopqrstuvwxy'[i]}\` owns its own store, keeps its own schema, answers its callers over gRPC and never reads another service's database, which the platform team checks in review.`).join('\n');
  ok(ingest.hardDataDensity(codeDoc).perThousand < 7, 'CONTROL: that document is below the density line (it passes on code spans alone)');
  ok(ingest.sourceHasHardData(codeDoc), 'gate: a technical document with 25 code spans passes', JSON.stringify(ingest.hardDataDensity(codeDoc)));
  const tableDoc = 'A plan for the year, written mostly in prose about what the team wants to achieve and why it matters. '.repeat(30) + '\n' + '| Week | Topic |\n|---|---|\n' + Array.from({ length: 9 }, (_, i) => `| W${i} | topic ${i} |`).join('\n');
  ok(ingest.sourceHasHardData(tableDoc), 'gate: a plan with a 9-row table passes');
  ok(ingest.hardDataDensity(tableDoc).perThousand < 7, 'CONTROL: that plan is below the density line (it passes on its table alone)');
  ok(!ingest.sourceHasHardData('An essay about how teams learn, with a nod to `git` and `make`. '.repeat(3) + 'It goes on about apprenticeship and practice and what people remember. '.repeat(40)), 'gate: an essay with a few code spans does not');

  // 7. A data source's long unparseable single-pass reply still gets the strict retry.
  const DATA_SRC = 'Price list for 2028: Basic tier €10 a month, Pro tier €20 a month, billed yearly.\n'.repeat(12);
  const PROSE_SRC = 'A short essay about orchards and rivers in the harbour town, and the people there. '.repeat(14);
  for (const [name, src, wantStrict] of [['data', DATA_SRC, true], ['prose', PROSE_SRC, false]]) {
    const prompts = [];
    let n = 0;
    await quiet(() => ingestFile(makeDomain().name, sourceFile(`${name}.md`, src), `${name}.md`, false, null, {
      llm: async (schema, prompt, max, fmt, onWait, opts) => {
        usage(opts); prompts.push(prompt); n++;
        if (n === 1) return '}{' + 'x'.repeat(12000);
        return JSON.stringify({ title: 'T', pages: [{ path: `summaries/${name}.md`, content: '# T\n\n## Key Takeaways\n- one\n' }] });
      },
    }));
    const strict = prompts[1] && /CRITICAL: Maximum 3 bullet points per page/.test(prompts[1]);
    eq(Boolean(strict), wantStrict, `${name}: a 12 KB unparseable reply ${wantStrict ? 'gets the strict retry (limit 24,000 with Key Facts)' : 'goes to multi-phase (limit 8,000, unchanged)'}`);
  }

  // 1. Ingest asks writePage to split a swallowed heading in fresh model output.
  const dS = makeDomain();
  await quiet(() => ingestFile(dS.name, sourceFile('floor.md', PROSE_SRC), 'floor.md', false, null, {
    llm: async (schema, prompt, max, fmt, onWait, opts) => { usage(opts); return JSON.stringify({ title: 'Floor', pages: [
      { path: 'summaries/floor.md', content: '# Floor\n\n## Key Takeaways\n- one\n' },
      { path: 'concepts/floor.md', content: '# Floor\n\n## Definition A baseline floor for each run of the course. It is paid in full.\n' }] }); },
  }));
  ok(/^## Definition\n\nA baseline floor/m.test(dS.read('concepts/floor.md')), 'ingest: a swallowed heading in the model reply is split');

  // 8. A Key Facts section new to a page lands after Key Takeaways, not after Notes.
  const placed = merge.composeReusedPage('# P\n\n## Key Takeaways\n- one\n\n## Notes\nSome notes.\n', '# P\n\n## Key Takeaways\n- one\n\n## Key Facts\n- Price (2028): €5\n- Seats: 10\n', { keepFolder: 'summaries' });
  ok(placed.indexOf('## Key Facts') > placed.indexOf('## Key Takeaways') && placed.indexOf('## Key Facts') < placed.indexOf('## Notes'), 'reuse: Key Facts goes right after Key Takeaways');
  ok(placed.includes('- Price (2028): €5\n- Seats: 10'), 'with its bullets together');
  const foot = merge.composeReusedPage('# P\n\n## Key Takeaways\n- one\n\n## Notes\nSome notes.\n', '# P\n\n## Examples\n- An example of the plan in use\n', { keepFolder: 'summaries' });
  ok(foot.trimEnd().endsWith('- An example of the plan in use'), 'CONTROL: any other new section still goes at the foot');
  ok(/no nested bullets/.test(KEY_FACTS_RULE), 'the rule asks for no nested bullets in Key Facts');
}

// ── 10 ───────────────────────────────────────────────────────────────────────
section('10. one Key Facts reading for a data source read before Key Facts existed (owner, 2026-11-14)');
{
  const { appendManifestRecord, readManifest, hashRawSource } = await import('../src/brain/raw-store.js');
  const DATA_SRC = 'Price list for 2028: Basic tier €10 a month, Pro tier €20 a month, billed yearly.\n'.repeat(12);
  const PROSE_SRC = 'A short essay about orchards and rivers in the harbour town, and the people there. '.repeat(14);
  const reply = (name) => async (schema, prompt, max, fmt, onWait, opts) => { usage(opts); calls10.n++;
    return JSON.stringify({ title: 'T', pages: [{ path: `summaries/${name}.md`, content: '# T\n\n## Key Takeaways\n- one\n\n## Key Facts\n- Basic tier (2028): €10 a month\n' }] }); };
  const calls10 = { n: 0 };
  // An ingest made before Key Facts: same bytes, same model, a completed record with no marker.
  async function legacyDomain(name, text) {
    const d = makeDomain({ [`summaries/${name}.md`]: '# T\n\n## Key Takeaways\n- one\n' });
    const raw = path.join(DOMAINS, d.name, 'raw', `${name}.md`);
    writeFileSync(raw, text, 'utf8');
    const sha256 = await hashRawSource(raw);
    await appendManifestRecord(d.name, { filename: `${name}.md`, sha256, bytes: Buffer.byteLength(text), summaryPath: `summaries/${name}.md`,
      ingestedAt: new Date().toISOString(), completed: true, model: 'fake-1', gaps: 0 });
    return { d, sha256 };
  }
  const L1 = await legacyDomain('plan', DATA_SRC);
  const plan1 = await ingest.planRepeatIngest(L1.d.name, L1.sha256, 'fake-1');
  eq(plan1.kind, 'key-facts', 'plan: a data source read before Key Facts by this model → one key-facts reading');
  ok(/figures that earlier versions did not keep/.test(plan1.reason || ''), 'with the plain reason');
  const L2 = await legacyDomain('essay', PROSE_SRC);
  eq((await ingest.planRepeatIngest(L2.d.name, L2.sha256, 'fake-1')).kind, 'nothing', 'plan: a source below the gate still makes no call');

  // The reading itself: add-only-new (not repeatSource), it records the marker, the next press is free.
  calls10.n = 0;
  const r1 = await quiet(() => ingestFile(L1.d.name, sourceFile('plan.md', DATA_SRC), 'plan.md', true, null, { llm: reply('plan'), buildModel: 'fake-1' }));
  eq(calls10.n, 1, 'ingest: the key-facts reading makes its one call');
  ok(L1.d.read('summaries/plan.md').includes('## Key Facts') && L1.d.read('summaries/plan.md').includes('- one'), 'the summary gains Key Facts and keeps its text');
  ok(r1.warnings.some((w) => /next re-ingest with this model makes no AI call/.test(w)), 'and the report says it happens once');
  const last = (await readManifest(L1.d.name)).filter((r) => r.completed).pop();
  eq(last.keyFacts, ingest.KEY_FACTS_VERSION, 'the completed record carries the Key Facts marker');
  eq((await ingest.planRepeatIngest(L1.d.name, L1.sha256, 'fake-1')).kind, 'nothing', 'plan: marker present → no call');
  calls10.n = 0;
  const r2 = await quiet(() => ingestFile(L1.d.name, sourceFile('plan.md', DATA_SRC), 'plan.md', true, null, { llm: reply('plan'), buildModel: 'fake-1' }));
  ok(calls10.n === 0 && r2.nothingToChange === true, 'ingest: the press after it makes no call');
  calls10.n = 0;
  const r3 = await quiet(() => ingestFile(L2.d.name, sourceFile('essay.md', PROSE_SRC), 'essay.md', true, null, { llm: reply('essay'), buildModel: 'fake-1' }));
  ok(calls10.n === 0 && r3.nothingToChange === true, 'ingest: the prose source read before Key Facts still makes no call');

  // raw/ is not synced: on a second computer the raw copy is often missing, and the bytes
  // being ingested are the only copy. Every combination: the plan made WITH the bytes (the
  // 409 dialog) and the run decide the same; the no-bytes estimate decides the same when
  // the raw copy exists, and otherwise prices the reading (gateUnknown) and the run can
  // only be cheaper.
  for (const [kind, text] of [['data', DATA_SRC], ['prose', PROSE_SRC]]) for (const rawThere of [true, false]) for (const marked of [false, true]) {
    const name = `m-${kind}-${rawThere ? 'raw' : 'noraw'}-${marked ? 'kf' : 'old'}`;
    const L = await legacyDomain(name, text);
    if (marked) await appendManifestRecord(L.d.name, { filename: `${name}.md`, sha256: L.sha256, bytes: Buffer.byteLength(text), summaryPath: `summaries/${name}.md`,
      ingestedAt: new Date().toISOString(), completed: true, model: 'fake-1', gaps: 0, keyFacts: ingest.KEY_FACTS_VERSION });
    if (!rawThere) rmSync(path.join(DOMAINS, L.d.name, 'raw', `${name}.md`));
    const upload = sourceFile(`${name}.md`, text);
    const withBytes = await ingest.planRepeatIngest(L.d.name, L.sha256, 'fake-1', { sourceText: () => ingest.sourceTextForGate(upload, `${name}.md`) });
    const noBytes = await ingest.planRepeatIngest(L.d.name, L.sha256, 'fake-1');
    calls10.n = 0;
    await quiet(() => ingestFile(L.d.name, upload, `${name}.md`, true, null, { llm: reply(name), buildModel: 'fake-1' }));
    const ran = calls10.n > 0;
    const want = kind === 'data' && !marked;
    eq(ran, want, `${name}: the run ${want ? 'reads once' : 'makes no call'}`);
    eq(withBytes.kind === 'key-facts', ran, `${name}: the plan made with the upload agrees with the run`);
    if (rawThere || marked) eq(noBytes.kind === 'key-facts', ran, `${name}: the no-bytes estimate agrees with the run`);
    else ok(noBytes.kind === 'key-facts' && noBytes.gateUnknown === true && (ran ? true : true), `${name}: the no-bytes estimate prices it as unknown (the run spends at most that)`);
    if (ran) eq((await ingest.planRepeatIngest(L.d.name, L.sha256, 'fake-1')).kind, 'nothing', `${name}: and only once`);
  }

  // Cost shown first: the dialog sentence names the price, the queue lists the file with its reason and prices it.
  const { duplicateCopy } = await import('../src/public/next/shared/ingest-queue-logic.js');
  const c = duplicateCopy({ sameContent: true, kind: 'key-facts', estimate: { usdLow: 0.004, usdHigh: 0.006 } });
  ok(/figures that earlier versions did not keep; reading it again keeps them — about \$0\.006/.test(c.sentence) && c.action, 'dialog: reason and "about $X" before the press', c.sentence);
  ok(/cost is shown before it starts/.test(duplicateCopy({ sameContent: true, kind: 'key-facts' }).sentence), 'dialog: with no estimate it says the cost comes first');
  const llmMod = await import('../src/brain/llm.js');
  const hadKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = hadKey || 'placeholder-for-an-offline-estimate';   // no call is made: the estimate is arithmetic
  let estModel = null;
  try { const i = llmMod.getProviderInfo(); estModel = llmMod.answeringModel(i.provider, i.model); } catch { estModel = null; }
  const L3 = await legacyDomain('plan', DATA_SRC);
  if (estModel) {   // the record says the estimate's own model read it, before Key Facts
    await appendManifestRecord(L3.d.name, { filename: 'plan.md', sha256: L3.sha256, bytes: Buffer.byteLength(DATA_SRC), summaryPath: 'summaries/plan.md',
      ingestedAt: new Date().toISOString(), completed: true, model: estModel, gaps: 0 });
  }
  const est = await quiet(async () => {
    const q = await import('../src/brain/ingest-queue.js');
    return q.estimateIngestQueueCost(L3.d.name, [{ name: 'plan.md', size: Buffer.byteLength(DATA_SRC), sha256: L3.sha256 }]).catch((e) => ({ error: e.message }));
  });
  if (est && est.files && estModel) {
    ok(!est.files.noCall.some((x) => x.name === 'plan.md'), 'queue estimate: the file is NOT priced at $0');
    ok(est.files.keyFactsReread.includes('plan.md'), 'queue estimate: it is listed with its reason (keyFactsReread)');
  } else ok(false, 'queue estimate: the estimate must resolve a model here', JSON.stringify(est && est.error));
  if (hadKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = hadKey;
}

// ── 11 ───────────────────────────────────────────────────────────────────────
section('11. second audit: no $0 quote before a spend, exact estimates, one try then marked');
{
  const { appendManifestRecord, readManifest, hashRawSource } = await import('../src/brain/raw-store.js');
  const DATA_SRC = 'Price list for 2028: Basic tier €10 a month, Pro tier €20 a month, billed yearly.\n'.repeat(12);
  const PROSE_SRC = 'A short essay about orchards and rivers in the harbour town, and the people there. '.repeat(14);
  const llmMod = await import('../src/brain/llm.js');
  const hadKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = hadKey || 'placeholder-for-an-offline-estimate';
  let M = 'fake-1';
  try { const i = llmMod.getProviderInfo(); M = llmMod.answeringModel(i.provider, i.model); } catch { /* keep fake-1 */ }
  const calls = { n: 0, summaryOnly: false };
  const reply = (name) => async (schema, prompt, max, fmt, onWait, opts) => { usage(opts); calls.n++;
    const kf = calls.summaryOnly ? '' : '\n## Key Facts\n- Basic tier (2028): €10 a month\n';
    return JSON.stringify({ title: 'T', pages: [{ path: `summaries/${name}.md`, content: `# T\n\n## Key Takeaways\n- one\n${kf}` }] }); };
  async function legacy(name, text, rawText = text) {
    const d = makeDomain({ [`summaries/${name}.md`]: '# T\n\n## Key Takeaways\n- one\n' });
    const raw = path.join(DOMAINS, d.name, 'raw', `${name}.md`);
    writeFileSync(raw, text, 'utf8');
    const sha256 = await hashRawSource(raw);
    if (rawText !== text) writeFileSync(raw, rawText, 'utf8');   // the name now holds OTHER bytes
    await appendManifestRecord(d.name, { filename: `${name}.md`, sha256, bytes: Buffer.byteLength(text), summaryPath: `summaries/${name}.md`,
      ingestedAt: new Date().toISOString(), completed: true, model: M, gaps: 0 });
    return { d, sha256 };
  }
  const q = await import('../src/brain/ingest-queue.js');
  const estimate = (d, name, text, sha256) => quiet(() => q.estimateIngestQueueCost(d.name, [{ name, size: Buffer.byteLength(text), sha256 }]));

  // C. raw/<name> holds DIFFERENT bytes (a newer version reused the name): never "$0".
  const C1 = await legacy('reused', DATA_SRC, PROSE_SRC);
  const pc = await ingest.planRepeatIngest(C1.d.name, C1.sha256, M);
  ok(pc.kind === 'key-facts' && pc.gateUnknown === true, 'C: a raw copy with other bytes is not read: the plan is the priced upper bound');
  const ec = await estimate(C1.d, 'reused.md', DATA_SRC, C1.sha256);
  ok(!ec.files.noCall.some((x) => x.name === 'reused.md') && ec.files.keyFactsReread.includes('reused.md'), 'C: the batch estimate prices it, never "unchanged · $0"');
  ok(ec.estimate.usdHigh > 0, 'C: with a dollar figure', String(ec.estimate.usdHigh));

  // A. A known Key Facts reading is priced with the rule and its output in both bounds; a
  //    fresh file (gate unknown) in the dear bound only.
  const { __testing: qt } = q;
  const price = llmMod.getModelPrice(M);
  const one = (keyFacts) => qt.estimateOneFile({ f: { name: 'p.md', size: 7000 }, promptFiles: { entities: [], concepts: [] }, index: '', today: '2026-11-14', price, model: M, keyFacts });
  const off = one('off'), maybe = one('maybe'), on = one('on');
  if (price) {
    ok(on.usdLow > off.usdLow && on.usdHigh > off.usdHigh, 'A: a known data source costs more in both bounds');
    ok(maybe.usdLow === off.usdLow && maybe.usdHigh === on.usdHigh, 'A: an unknown source: the cheap bound is prose, the dear bound a data source');
    ok(on.outputTokens - off.outputTokens >= 800, 'A: the measured Key Facts output allowance is in the figure', `${on.outputTokens - off.outputTokens}`);
  } else ok(false, 'A: the estimate must have a price here');

  // D. A prose source with no raw copy: the run reads the bytes, makes no call, and records
  //    it, so the next estimate is exact ($0, no "at most").
  const D1 = await legacy('essay2', PROSE_SRC);
  rmSync(path.join(DOMAINS, D1.d.name, 'raw', 'essay2.md'));
  ok((await estimate(D1.d, 'essay2.md', PROSE_SRC, D1.sha256)).files.keyFactsReread.includes('essay2.md'), 'D: before: priced as "at most" (no bytes, no raw copy)');
  calls.n = 0;
  await quiet(() => ingestFile(D1.d.name, sourceFile('essay2.md', PROSE_SRC), 'essay2.md', true, null, { llm: reply('essay2'), buildModel: M }));
  eq(calls.n, 0, 'D: the run with the bytes makes no call');
  rmSync(path.join(DOMAINS, D1.d.name, 'raw', 'essay2.md'));
  const ed = await estimate(D1.d, 'essay2.md', PROSE_SRC, D1.sha256);
  ok(ed.files.noCall.some((x) => x.name === 'essay2.md' && x.reason === 'unchanged') && !ed.files.keyFactsReread.includes('essay2.md'), 'D: after: the estimate is exact, $0, even with no raw copy');

  // E. A reading that wrote no Key Facts: one more offer, then marked (never a loop).
  const E1 = await legacy('plan5', DATA_SRC);
  calls.summaryOnly = true; calls.n = 0;
  await quiet(() => ingestFile(E1.d.name, sourceFile('plan5.md', DATA_SRC), 'plan5.md', true, null, { llm: reply('plan5'), buildModel: M }));
  eq(calls.n, 1, 'E: the first reading ran');
  eq((await ingest.planRepeatIngest(E1.d.name, E1.sha256, M)).kind, 'key-facts', 'E: it wrote no Key Facts, so it is offered once more');
  calls.n = 0;
  await quiet(() => ingestFile(E1.d.name, sourceFile('plan5.md', DATA_SRC), 'plan5.md', true, null, { llm: reply('plan5'), buildModel: M }));
  eq(calls.n, 1, 'E: the second reading ran');
  eq((await ingest.planRepeatIngest(E1.d.name, E1.sha256, M)).kind, 'nothing', 'E: and then it is marked whatever it wrote');
  calls.summaryOnly = false;

  // B. A marker lost in a sync, with the summary's Key Facts on disk: no second reading.
  const B1 = await legacy('synced', DATA_SRC);
  writeFileSync(path.join(DOMAINS, B1.d.name, 'wiki', 'summaries', 'synced.md'), '# T\n\n## Key Takeaways\n- one\n\n## Key Facts\n- Basic (2028): €10\n');
  eq((await ingest.planRepeatIngest(B1.d.name, B1.sha256, M)).kind, 'nothing', 'B: a summary that already has Key Facts counts as marked');

  // F1/F2. The run and the 409 route decide on the BYTES IN HAND, not on raw/.
  // Same bytes under a NEW name, the old name's raw copy gone: only the bytes can say prose.
  const F1 = await legacy('old-essay', PROSE_SRC);
  rmSync(path.join(DOMAINS, F1.d.name, 'raw', 'old-essay.md'));
  calls.n = 0;
  await quiet(() => ingestFile(F1.d.name, sourceFile('new-essay.md', PROSE_SRC), 'new-essay.md', true, null, { llm: reply('new-essay'), buildModel: M }));
  eq(calls.n, 0, 'F: ingestFile reads the bytes in hand: a prose source under a new name makes no call');
  const { default: express } = await import('express');
  const { default: ingestRouter } = await import('../src/routes/ingest.js');
  const { createServer } = await import('node:http');
  const app = express(); app.use('/api/ingest', ingestRouter);
  const server = createServer(app); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/ingest`;
  const post = async (domain, name, text) => { const fd = new FormData(); fd.append('domain', domain); fd.append('file', new Blob([text], { type: 'text/markdown' }), name); return fetch(base, { method: 'POST', body: fd }); };
  const F2 = await legacy('route-essay', PROSE_SRC);
  rmSync(path.join(DOMAINS, F2.d.name, 'raw', 'route-essay.md'));
  const rp = await (await post(F2.d.name, 'route-essay-2.md', PROSE_SRC)).json();
  eq(rp.plan && rp.plan.kind, 'nothing', 'F: the 409 plan reads the upload: prose with no raw copy is "nothing", not a priced reading');
  const F3 = await legacy('route-plan', DATA_SRC);
  rmSync(path.join(DOMAINS, F3.d.name, 'raw', 'route-plan.md'));
  const rd = await (await post(F3.d.name, 'route-plan-2.md', DATA_SRC)).json();
  ok(rd.plan && rd.plan.kind === 'key-facts' && !rd.plan.gateUnknown, 'F: the 409 plan reads the upload: a data source is a known Key Facts reading');
  ok(rd.plan && rd.plan.estimate && Number(rd.plan.estimate.usdHigh) > 0, 'F: and it carries its estimate, so the dialog can say "about $X"', JSON.stringify(rd.plan && rd.plan.estimate));
  await new Promise((r) => server.close(r));

  // F4. The batch row says why the file gets one more reading.
  const { queueRowNote } = await import('../src/public/next/shared/ingest-queue-logic.js');
  ok(/one more reading if it holds figures, priced above \(at most\)/.test(queueRowNote(null, true)), 'F: the batch row note for a Key Facts reading');
  eq(queueRowNote('unchanged', true), 'already read by this model · no AI call · $0', 'F: a free file keeps its own note');
  if (hadKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = hadKey;
}

console.log(`\n${'─'.repeat(60)}\nPassed: ${passed}   Failed: ${failed}`);
if (failed) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All key-facts assertions green');
