#!/usr/bin/env node
/**
 * test-ingest-fold-keeps-text.js — Offline, isolated, stubbed LLM. Stage 1 of
 * "stop duplicates at ingest".
 *
 * THE LOSS. When ingest wrote a proposed page onto an existing page under a name
 * the model did not choose, `mergeWikiPage` used the INCOMING page as the base:
 * its `## Definition` replaced the kept one while the report said "merged". The
 * guard ignored one-character tokens, so `phase-2-build` folded onto
 * `phase-1-build` at score 1.00, and at Jaccard >= 0.85 it folded reorderings. A
 * single-pass reply holding two close names lost the second page's body under a
 * warning saying it "will merge".
 *
 * WHAT THIS PINS, executing the real code (ingestFile and compileConversation
 * through their LLM seams, the MCP over stdio, an isolated tmp domains dir):
 *   §1  Each fold route keeps the kept page's text.
 *   §2  Digits and single letters count in the guard.
 *   §3  A single-pass reply loses no page body.
 *   §4  Spelling variants fold; nothing else does.
 *   §5  ORDINARY REUSE IS UNCHANGED: the incoming Definition replaces. Owner's
 *       open decision; this section is the record of today's behaviour.
 *   §6  Warnings: truthful wording, the view's buckets, the one aggregator.
 *   §7  The cached batch prefix is byte-identical across batches with a fold.
 *   §8  The run-time guard: a lossy or throwing composer writes nothing.
 *   §9  Idempotence: the same fold twice changes nothing.
 *   §10 Property: generated pairs through every route; the oracle walks raw lines
 *       and shares no code with the composer or findLostLines.
 *
 * NOT ENFORCED. Whether a real model's text folds well (the orchestrator measures
 * live). Ordinary reuse can still replace a Definition, and a later ordinary
 * write can still replace text under a heading it repeats.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let passed = 0, failed = 0;
function ok(cond, label, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(a, b, label) { ok(a === b, label, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); }
const section = (t) => console.log(`\n${t}`);

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'curator-fold-'));
const USER_DATA = path.join(TMP_ROOT, 'userdata');
const DOMAINS = path.join(TMP_ROOT, 'domains');
mkdirSync(USER_DATA, { recursive: true });
mkdirSync(DOMAINS, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DATA;
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS;
process.env.CURATOR_TEST_INSTANCE_DIR = path.join(TMP_ROOT, 'instances');

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
    list: (folder) => readdirSync(path.join(dd, 'wiki', folder)).sort(),
  };
}
function sourceFile(name, text) {
  const dir = path.join(TMP_ROOT, 'src', String(++seq));
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  writeFileSync(p, text, 'utf8');
  return p;
}
const usage = (opts) => {
  if (opts && typeof opts.onUsage === 'function') opts.onUsage({ inputTokens: 100, outputTokens: 50, provider: 'fake', model: 'fake-1' });
};
const quiet = async (fn) => {
  const e = console.error, w = console.warn;
  console.error = () => {};
  console.warn = () => {};
  try { return await fn(); }
  finally { console.error = e; console.warn = w; }
};

const SHORT = 'A short note about orchards and rivers in the harbour town. '.repeat(10);
const LONG = Array.from({ length: 400 }, (_, i) => `Paragraph ${i} about orchards, rivers and the harbour town.`).join('\n');
const summaryBody = (name) => `# ${name}\n\nSource: ${name}\nTags: test\n\n## Key Takeaways\n- One point about ${name}\n`;

const ASK_RE = /Write the full markdown content for EXACTLY these wiki pages[\s\S]*?\n\]/;
const askedPaths = (prompt) => ((prompt.match(ASK_RE) || [''])[0].match(/"path": "([^"]+)"/g) || []).map((s) => s.slice(9, -1));

/** A single-pass model: returns these pages, plus the summary. */
const singlePass = (name, pages) => async (schema, prompt, maxTokens, format, onWait, opts) => {
  usage(opts);
  return JSON.stringify({ title: name, pages: [{ path: `summaries/${name.replace(/\.md$/, '')}.md`, content: summaryBody(name) }, ...pages] });
};
/** A multi-phase model: plans `plan`, and writes each asked path from `bodies`. */
const multiPhase = (name, plan, bodies, calls = []) => async (schema, prompt, maxTokens, format, onWait, opts) => {
  usage(opts);
  const asked = askedPaths(prompt);
  if (!asked.length) {
    return JSON.stringify({ title: name, pages: [`summaries/${name.replace(/\.md$/, '')}.md`, ...plan].map((p) => ({ path: p, summary: `about ${p}` })) });
  }
  calls.push({ asked, prompt, cachePrefixChars: opts && opts.cachePrefixChars });
  return JSON.stringify({ pages: asked.map((p) => ({ path: p, summary: `s ${p}`, content: bodies[p] || (p.startsWith('summaries/') ? summaryBody(name) : `# ${p}\n\n## Key Facts\n- fact of ${p}\n`) })) });
};

const KEPT = `---
type: concept
tags: [type/concept, kept-tag]
created: 2025-01-01
---
# Agent

Kept opening sentence.

## Definition
The kept definition, written by hand.

## Key Facts
- Founded by [[alice]]
- [[alice]] left in 2005

## Why It Matters
Kept reason.
`;
const PROPOSED = `# Agents

Proposed opening sentence.

## Definition
The proposed definition, from one source.

## Key Facts
- A new fact from the source

## Why It Matters
Proposed reason.

Tags: proposed-tag
`;
const KEPT_LINES = ['Kept opening sentence.', 'The kept definition, written by hand.', '- Founded by [[alice]]', '- [[alice]] left in 2005', 'Kept reason.', '# Agent', 'created: 2025-01-01'];
const PROPOSED_LINES = ['Proposed opening sentence.', 'The proposed definition, from one source.', '- A new fact from the source', 'Proposed reason.'];
const hasLine = (text, line) => text.split(/\r?\n/).some((l) => l.trim() === line);
const assertFold = (body, label) => {
  const lostKept = KEPT_LINES.filter((l) => !hasLine(body, l));
  ok(!lostKept.length, `${label}: every kept line survives`, `lost ${JSON.stringify(lostKept)}`);
  const lostNew = PROPOSED_LINES.filter((l) => !hasLine(body, l));
  ok(!lostNew.length, `${label}: every proposed line arrives`, `lost ${JSON.stringify(lostNew)}`);
};

let mcpChild = null;
try {
  const { ingestFile, redirectSemanticDuplicates, aggregateWarnings, __testing } = await import('../src/brain/ingest.js');
  const { writePage, mergeWikiPage, __setFoldComposeForTest } = await import('../src/brain/files.js');
  const { compileConversation } = await import('../src/brain/compile.js');
  const files = await import('../src/brain/files.js');
  const { __setDomainsDirOverride } = await import('../src/brain/config.js');
  __setDomainsDirOverride(DOMAINS);
  const asEntity = (t) => t.replace('type: concept', 'type: entity').replace('type/concept', 'type/entity');

  // ── §1 ────────────────────────────────────────────────────────────────────
  section('§1  Every route that lands a page on an existing one keeps the text');
  {
    const dom = makeDomain({ 'concepts/agent.md': KEPT });
    const res = await quiet(() => ingestFile(dom.name, sourceFile('note-a.md', SHORT), 'note-a.md', false, null, {
      llm: singlePass('note-a.md', [{ path: 'concepts/agents.md', content: PROPOSED }]),
    }));
    assertFold(dom.read('concepts/agent.md'), 'single-pass, spelling guard');
    ok(!dom.has('concepts/agents.md'), 'single-pass: no second page');
    ok(res.warnings.some((w) => w.includes('redirected to canonical "concepts/agent.md"')), 'single-pass: the redirect is reported');
  }
  {
    const dom = makeDomain({ 'concepts/agent.md': KEPT });
    await quiet(() => ingestFile(dom.name, sourceFile('note-b.md', LONG), 'note-b.md', false, null, {
      llm: multiPhase('note-b.md', ['concepts/agents.md', 'entities/harbour.md', 'concepts/rivers.md'], { 'concepts/agent.md': PROPOSED }),
    }));
    assertFold(dom.read('concepts/agent.md'), 'multi-phase, spelling guard');
    ok(!dom.has('concepts/agents.md'), 'multi-phase: no second page');
  }
  {
    const dom = makeDomain({ 'entities/tali-rezun.md': asEntity(KEPT) });
    await writePage(dom.name, 'entities/talirezun.md', PROPOSED);
    assertFold(dom.read('entities/tali-rezun.md'), 'writePage Pass B (hyphens)');
    ok(/^## Merged from talirezun$/m.test(dom.read('entities/tali-rezun.md')), 'Pass B: names where the moved text came from');
  }
  {
    const dom = makeDomain({ 'entities/jane-doe.md': asEntity(KEPT) });
    await writePage(dom.name, 'entities/dr-jane-doe.md', PROPOSED);
    assertFold(dom.read('entities/jane-doe.md'), 'writePage Pass A (honorific)');
  }
  {
    const dom = makeDomain({ 'entities/google.md': asEntity(KEPT) });
    await writePage(dom.name, 'concepts/google.md', PROPOSED);
    const body = dom.read('entities/google.md');
    assertFold(body, 'writePage 3b (other folder)');
    ok(/^## Merged from concepts\/google$/m.test(body), '3b: the label names the folder, since the slugs match');
    ok(/^type: entity$/m.test(body), '3b: the page stays what its folder says');
  }
  {
    const dom = makeDomain({ 'concepts/two-worlds.md': KEPT });
    const warnings = [];
    await writePage(dom.name, 'concepts/two_worlds.md', PROPOSED, { onWarn: (w) => warnings.push(w) });
    assertFold(dom.read('concepts/two-worlds.md'), 'writePage underscore name');
    ok(warnings.some((w) => w.includes('redirected to canonical')), 'underscore: said so (was silent)');
  }
  {
    const dom = makeDomain({ 'entities/tali-rezun.md': asEntity(KEPT) });
    const conv = '00000000-0000-4000-8000-000000000001';
    await files.writeConversation(dom.name, { id: conv, title: 'T', createdAt: new Date().toISOString(), messages: [{ role: 'user', content: 'tell me' }, { role: 'assistant', content: 'ok' }] });
    const llm = async (s, p, m, f, w, opts) => {
      usage(opts);
      return JSON.stringify({ title: 'Compile', pages: [{ path: 'summaries/x.md', content: '# Compile\n\n## Key Takeaways\n- p\n' }, { path: 'entities/talirezun.md', content: PROPOSED }] });
    };
    const res = await quiet(() => compileConversation(dom.name, conv, () => {}, { generateText: llm }));
    ok(res.ok !== false, 'compile: ran');
    assertFold(dom.read('entities/tali-rezun.md'), 'compile');
  }

  // ── §2 ────────────────────────────────────────────────────────────────────
  section('§2  A digit or a single letter is part of the name');
  for (const [from, to, want] of [
    ['phase-2-build', 'phase-1-build', '0.50'],
    ['plan-b', 'plan-a', '0.33'],
    ['vitamin-c-levels', 'vitamin-d-levels', '0.50'],
  ]) {
    const outline = { pages: [{ path: `concepts/${from}.md`, summary: 's' }] };
    const { warnings, redirects } = redirectSemanticDuplicates(outline, { concepts: [`${to}.md`], entities: [] });
    eq(redirects.length, 0, `${from} does not fold onto ${to}`);
    eq(outline.pages[0].path, `concepts/${from}.md`, `${from}: the path stands`);
    if (want === '0.33') ok(!warnings.length, `${from}: under the notice band, so no notice (scored 1.00 before)`);
    else ok(warnings.some((w) => w.includes(`Jaccard ${want}`) && w.includes('Keeping both')), `${from}: the notice states ${want} (scored 1.00 before)`);
  }
  {
    const { warnings } = redirectSemanticDuplicates({ pages: [{ path: 'concepts/ai-in-1990s.md', summary: 's' }] }, { concepts: ['ai-in-1990.md'], entities: [] });
    ok(warnings.some((w) => w.includes('Jaccard 0.50')), 'a token holding a digit is not stemmed: 1990s is not 1990');
  }

  // ── §3 ────────────────────────────────────────────────────────────────────
  section('§3  A single-pass reply loses no page body');
  {
    const dom = makeDomain();
    const res = await quiet(() => ingestFile(dom.name, sourceFile('note-c.md', SHORT), 'note-c.md', false, null, {
      llm: singlePass('note-c.md', [
        { path: 'concepts/neural-network.md', content: '# Neural network\n\nFirst body.\n\n## Key Facts\n- first fact\n' },
        { path: 'concepts/neural-networks.md', content: '# Neural networks\n\nSecond body.\n\n## Key Facts\n- second fact\n' },
      ]),
    }));
    const body = dom.read('concepts/neural-network.md');
    for (const l of ['First body.', '- first fact', 'Second body.', '- second fact']) ok(hasLine(body, l), `twin names: "${l}" is on the page`);
    ok(!dom.has('concepts/neural-networks.md'), 'twin names: one page');
    eq(res.changes.filter((c) => c.canonPath === 'concepts/neural-network.md').length, 1, 'twin names: one row in the change list');
  }
  {
    // Close but not a spelling variant: used to lose the second body at score 1.00.
    const dom = makeDomain();
    const res = await quiet(() => ingestFile(dom.name, sourceFile('note-d.md', SHORT), 'note-d.md', false, null, {
      llm: singlePass('note-d.md', [
        { path: 'concepts/knowledge-domains.md', content: '# Knowledge domains\n\nDomains body.\n' },
        { path: 'concepts/domain-knowledge.md', content: '# Domain knowledge\n\nKnowledge body.\n' },
      ]),
    }));
    ok(hasLine(dom.read('concepts/knowledge-domains.md'), 'Domains body.'), 'reordered names: the first page is written');
    ok(dom.has('concepts/domain-knowledge.md') && hasLine(dom.read('concepts/domain-knowledge.md'), 'Knowledge body.'), 'reordered names: the second body is NOT lost');
    ok(res.warnings.some((w) => w.includes('Keeping both')), 'reordered names: says it kept both');
    ok(!res.warnings.some((w) => /will merge/.test(w)), 'no warning promises a merge that does not happen');
  }
  {
    const dom = makeDomain();
    const res = await quiet(() => ingestFile(dom.name, sourceFile('note-e.md', SHORT), 'note-e.md', false, null, {
      llm: singlePass('note-e.md', [
        { path: 'concepts/rivers.md', content: '# Rivers\n\nEarlier copy.\n' },
        { path: 'concepts/rivers.md', content: '# Rivers\n\nLater copy.\n' },
      ]),
    }));
    const body = dom.read('concepts/rivers.md');
    ok(hasLine(body, 'Earlier copy.') && hasLine(body, 'Later copy.'), 'one path twice with different words: both reach the page');
    ok(res.warnings.some((w) => w.includes('more than once')), 'one path twice: the report says so');
  }
  {
    // v3.0.16's rule survives: the same file under two spellings is written once.
    const dom = makeDomain();
    const same = '# Deltas\n\nOne text.\n';
    const res = await quiet(() => ingestFile(dom.name, sourceFile('note-x.md', SHORT), 'note-x.md', false, null, {
      llm: singlePass('note-x.md', [{ path: 'concepts/deltas', content: same }, { path: 'concepts/deltas.md', content: same }]),
    }));
    eq(res.changes.filter((c) => c.canonPath === 'concepts/deltas.md').length, 1, 'x and x.md with the same text: one write');
    ok(!/Merged from/.test(dom.read('concepts/deltas.md')), '…and no Merged from block');
  }
  {
    // Multi-phase control: a plan entry holds no text, so it can simply go.
    const dom = makeDomain();
    const calls = [];
    const res = await quiet(() => ingestFile(dom.name, sourceFile('note-f.md', LONG), 'note-f.md', false, null, {
      llm: multiPhase('note-f.md', ['concepts/neural-network.md', 'concepts/neural-networks.md', 'entities/harbour.md'], {}, calls),
    }));
    ok(!calls.flatMap((c) => c.asked).includes('concepts/neural-networks.md'), 'multi-phase twins: the model is asked for one page');
    ok(dom.has('concepts/neural-network.md') && !dom.has('concepts/neural-networks.md'), 'multi-phase twins: one page on disk');
    ok(res.warnings.some((w) => w.includes('so it is written once')), 'multi-phase twins: the report says so');
  }

  // ── §4 ────────────────────────────────────────────────────────────────────
  section('§4  Spelling variants fold; nothing else does');
  for (const [from, to] of [['neural-networks', 'neural-network'], ['hand-off', 'handoff'], ['e-mail', 'email'], ['agents', 'agent'], ['Handoff', 'handoff'], ['classes', 'class']]) {
    const outline = { pages: [{ path: `concepts/${from}.md`, summary: 's' }] };
    const { redirects } = redirectSemanticDuplicates(outline, { concepts: [`${to}.md`], entities: [] });
    eq(outline.pages[0].path, `concepts/${to}.md`, `${from} folds onto ${to}`);
    eq(redirects[0] && redirects[0].to, to, `${from}: the redirect is recorded`);
    eq(outline.pages[0][__testing.FOLDED_FROM], from, `${from}: the fold travels on the entry`);
  }
  for (const [from, to] of [
    ['knowledge-domains', 'domain-knowledge'],
    ['security-in-ai', 'ai-in-security'],
    ['experts-roundup-format', 'expert-roundup-format'],
    ['gpt-41', 'gpt-4-1'],
    ['iphone-14s', 'iphone-14'],
    ['news', 'new'],
    ['tools-directory-format', 'tools-directory'],
    ['open-weight-models', 'open-source-models'],
    ['no-recency-bias', 'recency-bias'],
  ]) {
    const outline = { pages: [{ path: `concepts/${from}.md`, summary: 's' }] };
    const { redirects } = redirectSemanticDuplicates(outline, { concepts: [`${to}.md`], entities: [] });
    eq(redirects.length, 0, `${from} does not fold onto ${to}`);
    eq(outline.pages[0].path, `concepts/${from}.md`, `${from}: the path stands`);
  }
  {
    const outline = { pages: [{ path: 'concepts/agents.md', summary: 's' }] };
    const { redirects } = redirectSemanticDuplicates(outline, { concepts: ['agents.md', 'agent.md'], entities: [] });
    eq(redirects.length, 0, 'a page the model named that exists is that page, even with a variant beside it');
  }
  {
    const outline = { pages: [{ path: 'concepts/agents.md', summary: 's' }, { path: 'concepts/agent.md', summary: 's' }] };
    const { redirects } = redirectSemanticDuplicates(outline, { concepts: ['agents.md', 'agent.md'], entities: [] });
    eq(redirects.length, 0, 'two existing pages planned together are not folded onto each other');
    eq(outline.pages.length, 2, '…both stay in the plan');
  }
  {
    const outline = { pages: [{ path: 'concepts/two-worlds.md', summary: 's' }] };
    const { redirects } = redirectSemanticDuplicates(outline, { concepts: ['two_worlds.md'], entities: [] });
    eq(redirects.length, 0, 'a target writePage would rename is not a target: the write would create a new page');
  }
  {
    const outline = { pages: [{ path: 'entities/agents.md', summary: 's' }] };
    const { redirects } = redirectSemanticDuplicates(outline, { concepts: [], entities: ['agent.md'] });
    eq(redirects.length, 0, 'entities are out of the plural rule: names such as jones / jone');
  }
  {
    const outline = { pages: [
      { path: 'concepts/agent.md', summary: 'the model chose this' },
      { path: 'concepts/agents.md', summary: 'folds onto the same page' },
    ] };
    redirectSemanticDuplicates(outline, { concepts: ['agent.md'], entities: [] });
    eq(outline.pages.length, 1, 'a plan naming both the page and its variant has one entry');
    eq(outline.pages[0][__testing.FOLDED_FROM], undefined, '…and it is the page the model chose: ordinary reuse');
  }
  {
    // The model cannot claim a fold: its JSON cannot set a Symbol.
    const dom = makeDomain({ 'concepts/rivers.md': KEPT });
    await quiet(() => ingestFile(dom.name, sourceFile('note-g.md', SHORT), 'note-g.md', false, null, {
      llm: singlePass('note-g.md', [{ path: 'concepts/rivers.md', content: PROPOSED, foldedFrom: 'injected\n## Heading', [String(__testing.FOLDED_FROM)]: 'x' }]),
    }));
    ok(!/injected/.test(dom.read('concepts/rivers.md')), 'a page\'s own foldedFrom field is ignored');
  }
  {
    // End to end: a wrong fold the old guard made, now two pages.
    const dom = makeDomain({ 'concepts/phase-1-build.md': KEPT });
    await quiet(() => ingestFile(dom.name, sourceFile('note-h.md', SHORT), 'note-h.md', false, null, {
      llm: singlePass('note-h.md', [{ path: 'concepts/phase-2-build.md', content: PROPOSED }]),
    }));
    ok(dom.has('concepts/phase-2-build.md'), 'phase-2-build is its own page');
    eq(dom.read('concepts/phase-1-build.md'), KEPT, 'phase-1-build is byte-identical');
  }

  // ── §5 ────────────────────────────────────────────────────────────────────
  section('§5  Ordinary reuse is unchanged (the owner\'s open decision)');
  {
    const dom = makeDomain({ 'concepts/agent.md': KEPT });
    await writePage(dom.name, 'concepts/agent.md', PROPOSED);
    const body = dom.read('concepts/agent.md');
    ok(hasLine(body, 'The proposed definition, from one source.'), 'the incoming Definition is on the page');
    ok(!hasLine(body, 'The kept definition, written by hand.'), 'the kept Definition is gone: today\'s behaviour, not a fold');
    ok(!hasLine(body, 'Kept opening sentence.'), 'the kept opening is gone too');
    ok(hasLine(body, '- A new fact from the source'), 'Key Facts accumulate');
    ok(!/Merged from/.test(body), 'no Merged from block');
    // The same path through the tidying routes is still the model's own choice.
    const dom2 = makeDomain({ 'entities/agent.md': asEntity(KEPT) });
    await writePage(dom2.name, 'people/agent.md', PROPOSED);
    ok(!/Merged from/.test(dom2.read('entities/agent.md')), 'a wrong folder name with the right slug is still ordinary reuse');
    const dom3 = makeDomain({ 'entities/agent.md': asEntity(KEPT) });
    await writePage(dom3.name, 'entities/a/agent.md', PROPOSED);
    ok(!/Merged from/.test(dom3.read('entities/agent.md')), 'a nested path with the right slug is still ordinary reuse');
    const dom4 = makeDomain({ 'concepts/agent.md': KEPT });
    await writePage(dom4.name, 'concepts/agent', PROPOSED);
    ok(!/Merged from/.test(dom4.read('concepts/agent.md')), 'a missing .md is still ordinary reuse');
    // Exact byte control against the merge ordinary reuse has always used.
    const dom5 = makeDomain({ 'concepts/plain.md': '---\ntype: concept\ntags: [type/concept]\ncreated: 2025-01-01\n---\n# P\n\n## Key Facts\n- a\n' });
    await writePage(dom5.name, 'concepts/plain.md', '# P\n\nNew body.\n\n## Key Facts\n- b\n');
    const direct = mergeWikiPage('---\ntype: concept\ntags: [type/concept]\ncreated: 2025-01-01\n---\n# P\n\n## Key Facts\n- a\n', 'X');
    ok(direct.includes('- a'), 'CONTROL: mergeWikiPage still unions bullets');
    ok(hasLine(dom5.read('concepts/plain.md'), '- a') && hasLine(dom5.read('concepts/plain.md'), '- b') && hasLine(dom5.read('concepts/plain.md'), 'New body.'), 'ordinary reuse: new body, both bullets');
  }

  // ── §6 ────────────────────────────────────────────────────────────────────
  section('§6  The warnings');
  {
    const { warnings } = redirectSemanticDuplicates({ pages: [{ path: 'concepts/agents.md', summary: 's' }] }, { concepts: ['agent.md'], entities: [] });
    eq(warnings.length, 1, 'one warning for one redirect');
    ok(warnings[0].toLowerCase().includes('redirected to canonical'), 'the Auto-fixed bucket\'s trigger is in it');
    const near = redirectSemanticDuplicates({ pages: [{ path: 'concepts/knowledge-domains.md', summary: 's' }] }, { concepts: ['domain-knowledge.md'], entities: [] }).warnings;
    ok(near[0].toLowerCase().includes('keeping both'), 'a close name that stayed is For review');
    const many = ['a', 'b', 'c', 'd'].map((x) => `Page "concepts/${x}s.md" is a spelling variant of the existing "concepts/${x}.md" — redirected to canonical "concepts/${x}.md"; its content was merged into that page.`);
    const within = 'Page "concepts/es.md" is a spelling variant of "concepts/e.md", in the same AI reply — redirected to canonical "concepts/e.md"; its content was merged into that page.';
    const agg = aggregateWarnings([...many, within]);
    eq(agg.length, 1, 'redirects aggregate at the one chokepoint, both wordings');
    ok(agg[0].includes('5 pages') && agg[0].toLowerCase().includes('redirected to canonical'), 'the aggregate keeps count and bucket');
    const nearMany = aggregateWarnings(['x', 'y', 'z'].map((s) => `Outline proposed "concepts/${s}.md" — possible semantic near-duplicate (Jaccard 0.50) of existing "concepts/o.md". Keeping both; review via Wiki Health.`));
    eq(nearMany.length, 3, 'near-duplicate notices are not aggregated: each names a pair');
  }

  // ── §7 ────────────────────────────────────────────────────────────────────
  section('§7  The cached batch prefix, with a fold in the plan');
  {
    const dom = makeDomain({ 'concepts/agent.md': KEPT });
    const calls = [];
    const plan = ['concepts/agents.md', 'concepts/agent-tools.md', 'concepts/rivers.md', 'concepts/deltas.md', 'entities/harbour.md', 'entities/guild.md', 'concepts/floods.md', 'concepts/banks.md'];
    await quiet(() => ingestFile(dom.name, sourceFile('note-p.md', LONG), 'note-p.md', false, null, { llm: multiPhase('note-p.md', plan, {}, calls) }));
    ok(calls.length >= 2, `CONTROL: ${calls.length} batches ran`);
    ok(calls.every((c) => c.cachePrefixChars > 0), 'CONTROL: every batch declared a cache prefix');
    const prefixes = new Set(calls.map((c) => c.prompt.slice(0, c.cachePrefixChars)));
    eq(prefixes.size, 1, 'the prefix the ingest SENT is byte-identical across batches');
    const prefix = [...prefixes][0];
    ok(prefix.includes('concepts/agent.md') || prefix.includes('agent'), 'CONTROL: the prefix holds the plan');
    ok(!prefix.includes('agents') && !/foldedFrom|Symbol/.test(prefix), 'the proposed name and the fold marker are not in it');
    // The same plan with no fold marker renders the same bytes: the marker adds nothing.
    const { buildBatchPromptParts } = __testing;
    const a = [{ path: 'concepts/x.md', summary: 's' }, { path: 'concepts/y.md', summary: 't' }];
    const marked = a.map((p) => ({ ...p, [__testing.FOLDED_FROM]: 'z' }));
    const pa = buildBatchPromptParts('2026-11-06', 's.md', 'TEXT', a, { entities: [], concepts: [] }, a);
    const pb = buildBatchPromptParts('2026-11-06', 's.md', 'TEXT', marked, { entities: [], concepts: [] }, marked);
    eq(pa.prefix, pb.prefix, 'a marked plan and an unmarked plan: same prefix');
    eq(pa.suffix, pb.suffix, '…and same suffix');
  }

  // ── §8 ────────────────────────────────────────────────────────────────────
  section('§8  The run-time guard');
  {
    const dom = makeDomain({ 'entities/tali-rezun.md': asEntity(KEPT) });
    const before = dom.read('entities/tali-rezun.md');
    const warnings = [];
    __setFoldComposeForTest((keep, remove) => remove);  // loses the kept page
    let rec;
    try { rec = await writePage(dom.name, 'entities/talirezun.md', PROPOSED, { onWarn: (w) => warnings.push(w) }); }
    finally { __setFoldComposeForTest(null); }
    eq(rec, null, 'a lossy composer: nothing written, null returned');
    eq(dom.read('entities/tali-rezun.md'), before, 'a lossy composer: the page is byte-identical');
    ok(warnings.some((w) => w.includes('without losing text') && w.includes('not written')), 'a lossy composer: the report says what happened');

    __setFoldComposeForTest((keep, remove) => keep);    // loses the proposed page
    try { rec = await writePage(dom.name, 'entities/talirezun.md', PROPOSED, { onWarn: () => {} }); }
    finally { __setFoldComposeForTest(null); }
    eq(rec, null, 'a composer dropping the proposed text is refused too');
    eq(dom.read('entities/tali-rezun.md'), before, '…and the page is byte-identical');

    __setFoldComposeForTest(() => { throw new Error('boom'); });
    try { rec = await writePage(dom.name, 'entities/talirezun.md', PROPOSED, { onWarn: () => {} }); }
    finally { __setFoldComposeForTest(null); }
    eq(rec, null, 'a throwing composer: refused, not a fall-through overwrite');
    eq(dom.read('entities/tali-rezun.md'), before, '…and the page is byte-identical');

    const ok2 = await writePage(dom.name, 'entities/talirezun.md', PROPOSED);
    ok(ok2 && ok2.status === 'updated', 'CONTROL: the real composer writes');
  }
  {
    // The second dedup key: a different sentence opening with the same link.
    const dom = makeDomain({ 'concepts/agent.md': '---\ntype: concept\ntags: [type/concept]\n---\n# Agent\n\n## Key Facts\n- [[alice]] founded it\n- [[alice]] left in 2005\n- [[concepts/rag]] is related\n' });
    await writePage(dom.name, 'concepts/agent.md', '# Agents\n\nBody.\n', { foldedFrom: 'agents' });
    const body = dom.read('concepts/agent.md');
    ok(hasLine(body, '- [[alice]] founded it') && hasLine(body, '- [[alice]] left in 2005'), 'dedup does not drop a kept sentence that opens with the same link');
    ok(hasLine(body, '- [[rag]] is related'), 'link tidying still applies, and is not read as loss');
  }

  // ── §9 ────────────────────────────────────────────────────────────────────
  section('§9  Idempotence');
  {
    const dom = makeDomain({ 'entities/tali-rezun.md': asEntity(KEPT) });
    await writePage(dom.name, 'entities/talirezun.md', PROPOSED);
    const once = dom.read('entities/tali-rezun.md');
    const rec = await writePage(dom.name, 'entities/talirezun.md', PROPOSED);
    eq(rec.status, 'unchanged', 'the same fold again: unchanged');
    eq(dom.read('entities/tali-rezun.md'), once, '…byte-identical');
  }
  {
    // Blank existing page: nothing to protect, so no Merged-from wrapper.
    const dom = makeDomain({ 'concepts/agent.md': '' });
    await writePage(dom.name, 'concepts/agent.md', PROPOSED, { foldedFrom: 'agents' });
    ok(!/Merged from/.test(dom.read('concepts/agent.md')) && hasLine(dom.read('concepts/agent.md'), 'Proposed opening sentence.'), 'a 0-byte page takes the proposed page as it is');
  }
  {
    // Later ordinary write: the moved block stays (mergeWikiPage's prose rule).
    const dom = makeDomain({ 'entities/tali-rezun.md': asEntity(KEPT) });
    await writePage(dom.name, 'entities/talirezun.md', PROPOSED);
    await writePage(dom.name, 'entities/tali-rezun.md', '# Tali\n\nFresh.\n');
    ok(hasLine(dom.read('entities/tali-rezun.md'), 'Proposed opening sentence.'), 'a later ordinary write keeps the Merged from block');
  }
  {
    // A summary is never a fold: re-ingesting a source merges into its summary.
    const dom = makeDomain({ 'summaries/foo-bar.md': '---\ntype: summary\ntags: [type/summary]\n---\n# Old\n\nOld body.\n\n## Key Takeaways\n- old point\n' });
    await writePage(dom.name, 'summaries/foo_bar.md', '# New\n\nNew body.\n\n## Key Takeaways\n- new point\n');
    const body = dom.read('summaries/foo-bar.md');
    ok(!/Merged from/.test(body) && hasLine(body, 'New body.') && hasLine(body, '- old point'), 'a summary merges the ordinary way');
  }
  {
    // A mirror pull replaces; a fold must never reach it.
    const dom = makeDomain({ 'entities/tali-rezun.md': asEntity(KEPT) });
    await writePage(dom.name, 'entities/talirezun.md', PROPOSED, { replace: true });
    ok(!hasLine(dom.read('entities/tali-rezun.md'), 'Kept opening sentence.'), 'replace:true keeps replace semantics');
  }

  // ── §10 ───────────────────────────────────────────────────────────────────
  section('§10 Property: generated pages through every route, every line survives');
  {
    const rng = (seed) => { let s = seed >>> 0 || 1; return (n) => { s = (s * 1664525 + 1013904223) >>> 0; return s % n; }; };
    const pick = (r, a) => a[r(a.length)];
    const genExisting = (seed) => {
      const r = rng(seed);
      const out = [];
      const n = seed;
      if (r(4)) out.push('---', 'type: concept', `tags: [type/concept, t${n}]`, 'created: 2024-02-03', ...(r(2) ? [`author: person-${n}`] : []), '---');
      if (r(5)) out.push(`# Title ${n}`, '');
      if (r(3)) out.push(`Opening prose ${n} with a [[link-${n}]] inside.`, '');
      const sections = ['Definition', 'Key Facts', 'Related', 'Why It Matters', 'Examples', 'Notes', 'How It Works', 'Key Takeaways'];
      const count = 1 + r(5);
      for (let i = 0; i < count; i++) {
        const name = pick(r, sections);
        out.push(`## ${name}`);
        const shape = r(7);
        if (shape === 0) out.push(`Prose ${n}.${i} in a section.`, `Second line ${n}.${i} of the paragraph.`);
        else if (shape === 1) out.push(`- Bullet ${n}.${i}`, `- [[shared-${n}]] one sentence ${i}`, `- [[shared-${n}]] another sentence ${i}`);
        else if (shape === 2) out.push('```js', `// ## not a heading ${n}.${i}`, `# also not ${n}.${i}`, '```');
        else if (shape === 3) out.push(`| a${n} | b${i} |`, '|---|---|', `| 1${n} | 2${i} |`);
        else if (shape === 4) out.push(`- Parent ${n}.${i}`, `  - Child ${n}.${i}`, `    - Grandchild ${n}.${i}`);
        else if (shape === 5) out.push(`- [[bare-${n}-${i}]]`, `- [[concepts/prefixed-${n}-${i}]] with words`);
        else out.push(`### Sub ${n}.${i}`, `Deep prose ${n}.${i}.`);
        out.push('');
      }
      return out.join('\n') + '\n';
    };
    const genProposed = (seed) => {
      const r = rng(seed + 7777);
      const n = `p${seed}`;
      const out = [`# Proposed ${n}`, '', `Proposed opening ${n}.`, ''];
      const sections = ['Definition', 'Key Facts', 'Related', 'Why It Matters', 'Examples', 'Notes', 'Fresh Section'];
      const count = 1 + r(4);
      for (let i = 0; i < count; i++) {
        out.push(`## ${pick(r, sections)}`);
        if (r(2)) out.push(`Proposed prose ${n}.${i}.`);
        else out.push(`- Proposed bullet ${n}.${i}`);
        out.push('');
      }
      if (r(2)) out.push(`Tags: tag-${n}`);
      return out.join('\n') + '\n';
    };

    // The oracle: raw lines, no tokenizer, no findLostLines. Allowed: a heading's
    // level; link tidying; frontmatter bookkeeping that is not text.
    const tidy = (l) => l.trim().replace(/\[\[(entities|concepts)\//g, '[[').toLowerCase();
    const unhash = (l) => l.replace(/^#{1,6}\s+/, '');
    const fmEnd = (lines) => { if (lines[0] !== '---') return 0; const e = lines.indexOf('---', 1); return e < 0 ? 0 : e + 1; };
    const oracle = (original, onDisk, label, { demoted = false, skipFmKeys = ['type', 'tags'] } = {}) => {
      const have = new Set(onDisk.split(/\r?\n/).map(tidy));
      const haveHead = new Set(onDisk.split(/\r?\n/).filter((l) => /^#{1,6}\s/.test(l)).map((l) => unhash(tidy(l))));
      const lines = original.split(/\r?\n/);
      const end = fmEnd(lines);
      const lost = [];
      lines.forEach((l, i) => {
        if (!l.trim()) return;
        if (i < end) {
          if (l === '---' || skipFmKeys.some((k) => l.startsWith(`${k}:`))) return;
          if (demoted) return;
        }
        if (have.has(tidy(l))) return;
        if (demoted && /^#{1,6}\s/.test(l) && haveHead.has(unhash(tidy(l)))) return;
        lost.push(l);
      });
      return lost;
    };

    const stats = {};
    const allLost = [];
    const record = (route, seed, existing, proposed, body) => {
      stats[route] = (stats[route] || 0) + 1;
      const lostKept = oracle(existing, body, route);
      const lostNew = oracle(proposed, body, route, { demoted: true }).filter((l) => !l.startsWith('Tags:'));
      if (lostKept.length || lostNew.length) allLost.push({ route, seed, lostKept: lostKept.slice(0, 3), lostNew: lostNew.slice(0, 3) });
    };

    const N = 40;
    for (let seed = 1; seed <= N; seed++) {
      const existing = genExisting(seed);
      const proposed = genProposed(seed);

      let d = makeDomain({ 'concepts/thing.md': existing });
      await quiet(() => ingestFile(d.name, sourceFile(`s${seed}.md`, SHORT), `s${seed}.md`, false, null, {
        llm: singlePass(`s${seed}.md`, [{ path: 'concepts/things.md', content: proposed }]),
      }));
      record('single-pass guard', seed, existing, proposed, d.read('concepts/thing.md'));

      d = makeDomain({ 'concepts/thing.md': existing });
      await quiet(() => ingestFile(d.name, sourceFile(`m${seed}.md`, LONG), `m${seed}.md`, false, null, {
        llm: multiPhase(`m${seed}.md`, ['concepts/things.md', 'entities/harbour.md', 'concepts/rivers.md'], { 'concepts/thing.md': proposed }),
      }));
      record('multi-phase guard', seed, existing, proposed, d.read('concepts/thing.md'));

      d = makeDomain({ 'entities/some-thing.md': existing.replace('type: concept', 'type: entity') });
      await quiet(() => writePage(d.name, 'entities/something.md', proposed));
      record('pass B', seed, existing, proposed, d.read('entities/some-thing.md'));

      d = makeDomain({ 'entities/some-thing.md': existing.replace('type: concept', 'type: entity') });
      await quiet(() => writePage(d.name, 'entities/dr-some-thing.md', proposed));
      record('pass A', seed, existing, proposed, d.read('entities/some-thing.md'));

      d = makeDomain({ 'entities/thing.md': existing.replace('type: concept', 'type: entity') });
      await quiet(() => writePage(d.name, 'concepts/thing.md', proposed));
      record('3b', seed, existing, proposed, d.read('entities/thing.md'));

      d = makeDomain({ 'concepts/some-thing.md': existing });
      await quiet(() => writePage(d.name, 'concepts/some_thing.md', proposed));
      record('underscore', seed, existing, proposed, d.read('concepts/some-thing.md'));

      // Through a real compile, with the summary sync and index steps after it.
      d = makeDomain({ 'entities/some-thing.md': existing.replace('type: concept', 'type: entity') });
      const conv = `00000000-0000-4000-8000-${String(100000000000 + seed)}`;
      await files.writeConversation(d.name, { id: conv, title: 'T', createdAt: new Date().toISOString(), messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }] });
      const llm = async (s, p, m, f, w, opts) => {
        usage(opts);
        return JSON.stringify({ title: `C ${seed}`, pages: [{ path: 'summaries/c.md', content: '# C\n\n## Key Takeaways\n- k\n' }, { path: 'entities/something.md', content: proposed }] });
      };
      await quiet(() => compileConversation(d.name, conv, () => {}, { generateText: llm }));
      record('compile', seed, existing, proposed, d.read('entities/some-thing.md'));
    }

    // Hub linkification runs after the writes and rewrites the page it touches.
    {
      const hub = '---\ntype: concept\ntags: [type/concept]\n---\n# Formats\n\nKept hub opening.\n\n## Key Facts\n- Rivers flow south\n- Rivers flood often\n- Deltas\n- Floods\n- Banks\n';
      const prop = '# Format\n\nProposed hub opening.\n\n## Key Facts\n- Harbour\n';
      const d = makeDomain({ 'concepts/formats.md': hub });
      const res = await quiet(() => ingestFile(d.name, sourceFile('hub.md', SHORT), 'hub.md', false, null, {
        llm: singlePass('hub.md', [
          { path: 'concepts/format.md', content: prop },
          { path: 'concepts/rivers.md', content: '# Rivers\n\nBody.\n' },
          { path: 'concepts/deltas.md', content: '# Deltas\n\nBody.\n' },
        ]),
      }));
      ok(res.warnings.some((w) => w.includes('Hub linkification')), 'CONTROL: hub linkification ran on the fold target');
      const body = d.read('concepts/formats.md');
      for (const l of ['Kept hub opening.', 'Proposed hub opening.']) ok(hasLine(body, l), `hub: "${l}" survives`);
      for (const t of ['flow south', 'flood often']) ok(body.includes(t), `hub: "${t}" survives the linkify rewrite`);
    }

    // The MCP's compile_to_wiki, in a real spawned server.
    {
      const pairs = [];
      const fileset = {};
      for (let seed = 1; seed <= 12; seed++) {
        const existing = genExisting(seed + 500).replace('type: concept', 'type: entity');
        fileset[`entities/mcp-page-${seed}.md`] = existing;
        pairs.push({ seed, existing, proposed: genProposed(seed + 500) });
      }
      const d = makeDomain(fileset);
      mcpChild = spawn(process.execPath, [path.join(REPO, 'mcp/server.js'), '--domains-path', DOMAINS], {
        env: { ...process.env, CURATOR_TEST_DOMAINS_DIR: DOMAINS, CURATOR_TEST_USER_DATA_DIR: USER_DATA },
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      let buf = '', id = 0;
      const waiting = new Map();
      mcpChild.stdout.on('data', (chunk) => {
        buf += chunk.toString();
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
        }
      });
      const rpc = (method, params) => new Promise((resolve, reject) => {
        const myId = ++id;
        const timer = setTimeout(() => reject(new Error('MCP timeout on ' + method)), 30000);
        waiting.set(myId, (m) => { clearTimeout(timer); resolve(m); });
        mcpChild.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
      });
      await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fold-test', version: '1' } });
      mcpChild.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      for (const { seed, existing, proposed } of pairs) {
        const res = await rpc('tools/call', { name: 'compile_to_wiki', arguments: {
          domain: d.name,
          title: `Fold ${seed}`,
          summary_content: `# Fold ${seed}\n\n## Key Takeaways\n- k${seed}\n`,
          additional_pages: [{ path: `entities/mcppage-${seed}.md`, content: proposed }],
          broken_link_policy: 'keep',
        } });
        ok(!res.error && !res.result.isError, `mcp seed ${seed}: compile ran`, JSON.stringify(res).slice(0, 300));
        record('mcp compile_to_wiki', seed, existing, proposed, d.read(`entities/mcp-page-${seed}.md`));
      }
      mcpChild.stdin.end();
      mcpChild.kill();
      mcpChild = null;
    }

    for (const [route, n] of Object.entries(stats)) console.log(`    ${route}: ${n} pairs`);
    eq(allLost.length, 0, `no line lost in ${Object.values(stats).reduce((a, b) => a + b, 0)} generated folds`);
    for (const l of allLost.slice(0, 6)) console.log('    ' + JSON.stringify(l));
    ok(Object.keys(stats).length === 8, 'CONTROL: all eight routes ran');

    // A dumb cross-check on the generator: ordinary reuse DOES lose lines on these
    // pages, so the oracle can see a loss and the pages hold something to lose.
    let ordinaryLosses = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const existing = genExisting(seed);
      const d = makeDomain({ 'concepts/thing.md': existing });
      await quiet(() => writePage(d.name, 'concepts/thing.md', genProposed(seed)));
      if (oracle(existing, d.read('concepts/thing.md'), 'ordinary').length) ordinaryLosses++;
    }
    ok(ordinaryLosses > 0, `CONTROL: the oracle sees ordinary reuse lose lines (${ordinaryLosses}/10 pairs)`);
  }
} catch (err) {
  failed++;
  console.log(`  ✗ the suite threw: ${err && err.stack || err}`);
} finally {
  if (mcpChild) mcpChild.kill();
  rmSync(TMP_ROOT, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
