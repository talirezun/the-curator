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
 *   §5  Exact-name reuse: title and opening stay, mostly new wording goes below
 *       the kept text, a rewording is left out and reported. A stub is replaced.
 *   §5b ACCEPTANCE: replay adds nothing; a fixed reworded corpus grows at most 10%.
 *   §6  Warnings: truthful wording, the view's buckets, the one aggregator.
 *   §7  The cached batch prefix is byte-identical across batches with a fold.
 *   §8  The run-time guard: a lossy or throwing composer writes nothing.
 *   §9  Idempotence: the same fold twice changes nothing.
 *   §10 Property: generated pairs through every route; the oracle walks raw lines
 *       and shares no code with the composer or findLostLines.
 *
 * NOT ENFORCED. Whether a real model's text reads well (the orchestrator measures
 * live). The threshold is measured on one domain's replies, labelled by one reader.
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
    ok(!res.warnings.some((w) => w.includes('more than once')), 'twin names: not reported as the AI repeating one path');
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
    const reversed = { pages: [
      { path: 'concepts/agents.md', summary: 'folds onto the same page' },
      { path: 'concepts/agent.md', summary: 'the model chose this' },
    ] };
    redirectSemanticDuplicates(reversed, { concepts: ['agent.md'], entities: [] });
    eq(reversed.pages.length, 1, 'the other order: one entry');
    eq(reversed.pages[0][__testing.FOLDED_FROM], undefined, 'the other order: still ordinary reuse');
  }
  {
    // The model cannot claim a fold: its JSON cannot set a Symbol.
    const dom = makeDomain({ 'concepts/rivers.md': KEPT });
    await quiet(() => ingestFile(dom.name, sourceFile('note-g.md', SHORT), 'note-g.md', false, null, {
      llm: singlePass('note-g.md', [{ path: 'concepts/rivers.md', content: PROPOSED, foldedFrom: 'injected\n## Heading' }]),
    }));
    ok(!/injected/.test(dom.read('concepts/rivers.md')), 'a page\'s own foldedFrom field is ignored');
    // The same claim on a multi-phase plan entry.
    const dom2 = makeDomain({ 'concepts/rivers.md': KEPT });
    const llm = async (schema, prompt, maxTokens, format, onWait, opts) => {
      usage(opts);
      const asked = askedPaths(prompt);
      if (!asked.length) return JSON.stringify({ title: 'n', pages: [
        { path: 'summaries/note-g2.md', summary: 's' },
        { path: 'concepts/rivers.md', summary: 's', foldedFrom: 'injected' },
        { path: 'entities/harbour.md', summary: 's' },
      ] });
      return JSON.stringify({ pages: asked.map((p) => ({ path: p, summary: 's', content: p === 'concepts/rivers.md' ? PROPOSED : p.startsWith('summaries/') ? summaryBody('note-g2.md') : `# ${p}\n\nBody.\n` })) });
    };
    await quiet(() => ingestFile(dom2.name, sourceFile('note-g2.md', LONG), 'note-g2.md', false, null, { llm }));
    ok(!/injected/.test(dom2.read('concepts/rivers.md')), 'a plan entry\'s own foldedFrom field is ignored');
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
  section('§5  Exact-name reuse keeps the page, and adds only what is mostly new');
  {
    const NEW = `# Agents

Autonomous helpers negotiate booking contracts overnight.

The kept opening sentence, reworded slightly.

## Definition
The definition kept, written by hand.

Software negotiating binding contracts independently across marketplaces.

## Key Facts
- Launched during winter trials across Norway
- [[alice]] left during 2005

## Why It Matters
Regulators increasingly demand audit trails.

Tags: extra-tag
`;
    const dom = makeDomain({ 'concepts/agent.md': KEPT });
    const warnings = [];
    const res = await writePage(dom.name, 'concepts/agent.md', NEW, { onWarn: (w) => warnings.push(w) });
    const body = dom.read('concepts/agent.md');
    for (const l of KEPT_LINES) ok(hasLine(body, l), `kept: "${l}"`);
    for (const l of ['Autonomous helpers negotiate booking contracts overnight.', 'Software negotiating binding contracts independently across marketplaces.', '- Launched during winter trials across Norway', 'Regulators increasingly demand audit trails.']) ok(hasLine(body, l), `mostly new, added: "${l}"`);
    for (const l of ['The kept opening sentence, reworded slightly.', 'The definition kept, written by hand.', '- [[alice]] left during 2005']) ok(!hasLine(body, l), `a rewording, left out: "${l}"`);
    ok(warnings.some((w) => /^Page "concepts\/agent.md": 3 passages not added/.test(w)), 'the report counts what was left out', JSON.stringify(warnings));
    ok(!hasLine(body, '# Agents'), 'the current title stays and the incoming title is not added');
    ok(!/Merged from/.test(body), 'no Merged from block: this is the model\'s own page');
    ok(/extra-tag/.test(body) && /kept-tag/.test(body), 'tags union');
    const order = (a, c) => body.indexOf(a) < body.indexOf(c);
    ok(order('# Agent\n', 'Kept opening sentence.') && order('Kept opening sentence.', 'Autonomous helpers') && order('Autonomous helpers', '## Definition'), 'title, kept opening, new opening, then the sections');
    const defn = body.slice(body.indexOf('## Definition'), body.indexOf('## Key Facts'));
    ok(defn.indexOf('The kept definition') >= 0 && defn.indexOf('The kept definition') < defn.indexOf('Software negotiating'), 'Definition: kept first, new wording directly below, in that section');
    eq((body.match(/^## Definition/gm) || []).length, 1, 'one Definition heading');
    const why = body.slice(body.indexOf('## Why It Matters'));
    ok(why.indexOf('Kept reason.') < why.indexOf('Regulators') && why.indexOf('Regulators') > 0, 'any other prose section: the same rule');
    ok(res.status === 'updated', 'reported as updated');
    const again = await writePage(dom.name, 'concepts/agent.md', NEW, { onWarn: () => {} });
    eq(again.status, 'unchanged', 'the same text again adds nothing');
  }
  {
    // The number rule: everything else matches, and it is a new fact.
    const dom = makeDomain({ 'concepts/n.md': '---\ntype: concept\ntags: [type/concept]\n---\n# N\n\n## Key Facts\n- Lumina has been running 25 years in Oslo\n' });
    await writePage(dom.name, 'concepts/n.md', '# N\n\n## Key Facts\n- Lumina has been running 30 years in Oslo\n- Lumina has been running for many years in Oslo\n');
    const body = dom.read('concepts/n.md');
    ok(hasLine(body, '- Lumina has been running 30 years in Oslo'), 'a new number is new');
    ok(!hasLine(body, '- Lumina has been running for many years in Oslo'), 'the same words without one are not');
    ok(hasLine(body, '- Lumina has been running 25 years in Oslo'), 'the old figure stays');
  }
  {
    // Sentence level: a paragraph with one new sentence adds that sentence.
    const dom = makeDomain({ 'concepts/s.md': '---\ntype: concept\ntags: [type/concept]\n---\n# S\n\n## Definition\nTide gauges measure sea level along the coast.\n' });
    await writePage(dom.name, 'concepts/s.md', '# S\n\n## Definition\nTide gauges measure the sea level on a coast. Satellites calibrate readings against orbital altimetry.\n');
    const body = dom.read('concepts/s.md');
    ok(hasLine(body, 'Satellites calibrate readings against orbital altimetry.'), 'the new sentence is added, on its own');
    ok(!/on a coast/.test(body), 'the reworded one in the same paragraph is not');
  }
  {
    // Sections outside the accumulating list: measured at 28% of all bullet lines.
    const dom = makeDomain({ 'concepts/p.md': '---\ntype: concept\ntags: [type/concept]\n---\n# P\n\n## How It Works\n- gather barley\n- malt grain\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n## Notes\n```js\n## not a heading\n```\n' });
    await writePage(dom.name, 'concepts/p.md', '# P\n\n## How It Works\n- ferment wort slowly\n- gather barley\n\n## Notes\nCopper kettles conduct heat evenly.\n\n### Deep\nYeast strains vary regionally.\n\n```js\nnewCode();\n```\n\n## Brand New\nFresh hops arrive seasonally.\n\n## Empty Words\nThe barley.\n');
    const body = dom.read('concepts/p.md');
    for (const l of ['- gather barley', '- malt grain', '- ferment wort slowly', '| 1 | 2 |', '## not a heading', 'Copper kettles conduct heat evenly.', '### Deep', 'Yeast strains vary regionally.', 'newCode();', '## Brand New', 'Fresh hops arrive seasonally.']) ok(hasLine(body, l), `other sections: "${l}"`);
    eq((body.match(/- gather barley/g) || []).length, 1, 'a bullet already held is not repeated');
    ok(!/## Empty Words/.test(body), 'a new section with nothing new in it is not added');
    ok(/## not a heading\n```/.test(body), 'a fence stays whole');
    const before = dom.read('concepts/p.md');
    await writePage(dom.name, 'concepts/p.md', '# P\n\n## Notes\n### Deep\nYeast strains vary regionally.\n');
    eq(dom.read('concepts/p.md'), before, 'a sub-heading with nothing new under it is not repeated');
  }
  {
    // Link sections go by target. What is on the page stays, and a new target is added.
    const dom = makeDomain({ 'concepts/l.md': '---\ntype: concept\ntags: [type/concept]\n---\n# L\n\n## Related\n- [[alpha]] old description\n- [[alpha]] another description, on disk already\n- [[beta]]\n' });
    await writePage(dom.name, 'concepts/l.md', '# L\n\n## Related\n- [[alpha]] new description\n- [[Alpha|The Alpha]]\n- [[concepts/beta]] now with words\n- [[gamma]] barely different words alpha\n');
    await writePage(dom.name, 'concepts/l.md', '# L\n\n## Key Facts\n- Later arrival mentioned once\n');
    const body = dom.read('concepts/l.md');
    for (const l of ['- [[alpha]] old description', '- [[alpha]] another description, on disk already', '- [[beta]]', '- [[gamma]] barely different words alpha']) ok(hasLine(body, l), `link section: "${l}"`);
    for (const l of ['- [[alpha]] new description', '- [[beta]] now with words']) ok(!hasLine(body, l), `a known target is not added: "${l}"`);
  }
  {
    // The AI's stub said "re-ingest to fix": that has to keep working.
    const stub = '---\ntype: concept\ntags: [type/concept]\n---\n# s\n\n> ⚠ **Stub page — AI failed to write this on ingest.**\n> Re-ingest "x.md" to fix this.\n\n## Related\n- [[summaries/x]]\n';
    const dom = makeDomain({ 'concepts/s.md': stub });
    await writePage(dom.name, 'concepts/s.md', '# Real Title\n\nReal opening.\n\n## Definition\nReal definition.\n');
    const body = dom.read('concepts/s.md');
    ok(!/Stub page/.test(body), 'a stub is replaced');
    ok(hasLine(body, 'Real opening.') && hasLine(body, '# Real Title'), '…by the real page');
    ok(hasLine(body, '- [[summaries/x]]'), '…its accumulated bullets stay');
  }
  {
    // Link tidy: the same line with a different link spelling is not new wording.
    const dom = makeDomain({ 'concepts/k.md': '---\ntype: concept\ntags: [type/concept]\n---\n# K\n\n## Definition\nUses [[rag]] here.\n', 'concepts/rag.md': '# rag\n' });
    const rec = await writePage(dom.name, 'concepts/k.md', '# K\n\n## Definition\nUses [[concepts/rag]] here.\n');
    eq(rec.status, 'unchanged', 'a link spelled with its folder adds nothing');
  }
  {
    // A page with no title takes the incoming one; a frontmatter claim stays visible.
    const dom = makeDomain({ 'concepts/n.md': '---\ntype: concept\ntags: [type/concept]\nauthor: kept\n---\nNo title yet.\n' });
    await writePage(dom.name, 'concepts/n.md', '---\ntags: [x]\nauthor: other\n---\n# Now Titled\n\nBarley malted slowly.\n');
    const body = dom.read('concepts/n.md');
    ok(hasLine(body, '# Now Titled') && hasLine(body, 'No title yet.') && hasLine(body, 'Barley malted slowly.'), 'no kept title: the incoming one is used');
    ok(hasLine(body, 'author: kept') && hasLine(body, 'author: other'), 'a differing frontmatter value is kept as text');
  }
  {
    // Bookkeeping of a write is not text, and a summary's sync keeps same-link lines.
    const dom = makeDomain({ 'summaries/d.md': '---\ntype: summary\nsource: d.md\ndate: 2024-01-01\ntags: [type/summary]\ncreated: 2024-01-01\n---\n# D\n\n## Entities Mentioned\n- [[alpha]] the founder\n- [[alpha]] another description\n\n## Key Takeaways\n- one\n' });
    const rec = await writePage(dom.name, 'summaries/d.md', '---\ntype: summary\nsource: d.md\ndate: 2026-11-06\ntags: [type/summary]\ncreated: 2026-11-06\n---\n# D\n\n## Key Takeaways\n- one\n');
    eq(rec.status, 'unchanged', 'a later date is not new text');
    ok(hasLine(dom.read('summaries/d.md'), 'date: 2024-01-01'), 'the first date stays');
    await writePage(dom.name, 'entities/beta.md', '# Beta\n\nBody.\n');
    await files.syncSummaryEntities(dom.name, 'summaries/d.md', ['summaries/d.md', 'entities/beta.md']);
    const body = dom.read('summaries/d.md');
    ok(hasLine(body, '- [[beta]]'), 'CONTROL: the sync really rewrote the summary');
    ok(hasLine(body, '- [[alpha]] the founder') && hasLine(body, '- [[alpha]] another description'), 'the post-write sync keeps both same-link lines');
  }
  {
    // Tidied paths are still reuse, not a fold.
    for (const [existing, asked] of [['entities/agent.md', 'people/agent.md'], ['entities/agent.md', 'entities/a/agent.md'], ['concepts/agent.md', 'concepts/agent']]) {
      const dom = makeDomain({ [existing]: existing.startsWith('entities') ? asEntity(KEPT) : KEPT });
      await quiet(() => writePage(dom.name, asked, PROPOSED));
      const body = dom.read(existing);
      ok(!/Merged from/.test(body) && hasLine(body, 'The kept definition, written by hand.'), `${asked} is reuse`);
    }
  }
  {
    // A summary keeps its text across a re-ingest with new words.
    const dom = makeDomain();
    const v = (o, t) => async (a, b, c, d, e, opts) => {
      usage(opts);
      return JSON.stringify({ title: 'Note', pages: [{ path: 'summaries/note-s.md', content: `# Note\n\nSource: note-s.md\nTags: t\n\n${o}\n\n## Key Takeaways\n- ${t}\n` }] });
    };
    await quiet(() => ingestFile(dom.name, sourceFile('note-s.md', SHORT), 'note-s.md', false, null, { llm: v('Barley harvests failed.', 'Yields dropped sharply') }));
    await quiet(() => ingestFile(dom.name, sourceFile('note-s.md', SHORT), 'note-s.md', true, null, { llm: v('Copper kettles arrived.', 'Exports expanded abroad') }));
    const body = dom.read('summaries/note-s.md');
    for (const l of ['Barley harvests failed.', 'Copper kettles arrived.', '- Yields dropped sharply', '- Exports expanded abroad']) ok(hasLine(body, l), `summary re-ingest: "${l}"`);
  }

  // ── §5b ───────────────────────────────────────────────────────────────────
  section('§5b ACCEPTANCE: replay adds nothing, and a reworded corpus stops growing');
  {
    // Invented, in the shape of captured re-ingest rounds: one source, reworded by a
    // model three times, with two genuinely new points along the way.
    const ROUNDS = [
      {
        'concepts/owner-sign-off.md': '# Owner Sign-Off\n\nOwner sign-off means an agent pauses before a binding action until a person confirms it.\n\n## Definition\nA rule requiring a person to confirm every binding action an agent proposes.\n\n## How It Works\n- The agent shows the full text of the action on screen\n- The person confirms with a fingerprint\n- Nothing binding happens before confirmation\n\n## Related\n- [[governed-agent]] — the framework that applies it\n- [[tide-agent]] — an example agent\n',
        'entities/tide-agent.md': '# Tide Agent\n\nThe Tide Agent connects an AI assistant to live tide data for coastal towns.\n\n## Key Facts\n- Built as the data side of the harbour demo\n- Publishes readings for twelve harbours\n\n## Related\n- [[owner-sign-off]] — source of its approval step\n',
        'concepts/governed-agent.md': '# Governed Agent\n\nA governed agent runs under written rules its owner can read and change.\n\n## Key Facts\n- The rules live in one plain text file\n- It never sends or pays without confirmation\n\n## Related\n- [[owner-sign-off]] — the approval rule\n',
      },
      {
        'concepts/owner-sign-off.md': '# Owner Sign-Off\n\nOwner sign-off is when an agent stops before any binding action until a person has confirmed it.\n\n## Definition\nThe rule that a person must confirm each binding action an agent proposes.\n\n## How It Works\n- The agent displays the full action text on screen\n- The person confirms using a fingerprint\n- No binding action happens before the confirmation\n- Refusals are logged with a timestamp for later audit\n\n## Related\n- [[governed-agent]] — framework applying this rule\n- [[tide-agent]] — example\n',
        'entities/tide-agent.md': '# Tide Agent\n\nThe Tide Agent is an AI assistant implementation connecting to live tide data for coastal towns.\n\n## Key Facts\n- Serves as the data side of the harbour demo\n- Publishes the readings of twelve harbours\n\n## Related\n- [[owner-sign-off]] — its approval step\n',
        'concepts/governed-agent.md': '# Governed Agent\n\nA governed agent operates under written rules that its owner can read and change.\n\n## Key Facts\n- Its rules live in a single plain text file\n- It never pays or sends without a confirmation\n\n## Related\n- [[owner-sign-off]] — approval\n',
      },
      {
        'concepts/owner-sign-off.md': '# Owner Sign-Off\n\nUnder owner sign-off an agent pauses ahead of a binding action until a person confirms.\n\n## Definition\nA rule by which a person confirms any binding action proposed by an agent.\n\n## How It Works\n- The full text of the action is displayed on screen by the agent\n- A person confirms by fingerprint\n- Confirmation comes before anything binding happens\n\n## Related\n- [[governed-agent]] — framework\n- [[tide-agent]] — sample agent\n',
        'entities/tide-agent.md': '# Tide Agent\n\nThe Tide Agent links an AI assistant with live tide data for coastal towns.\n\n## Key Facts\n- Forms the data side of the harbour demo\n- Readings are published for twelve harbours\n- Storm surge warnings reach 240 subscribers\n\n## Related\n- [[owner-sign-off]] — approval step\n',
        'concepts/governed-agent.md': '# Governed Agent\n\nA governed agent works under written rules its owner may read and change.\n\n## Key Facts\n- One plain text file holds its rules\n- Without confirmation it never sends or pays\n\n## Related\n- [[owner-sign-off]] — rule\n',
      },
    ];
    const paths = Object.keys(ROUNDS[0]);
    const dom = makeDomain();
    const size = () => paths.reduce((n, p) => n + dom.read(p).length, 0);
    const reply = (i) => singlePass('corpus.md', paths.map((p) => ({ path: p, content: ROUNDS[i][p] })));
    const reports = [];
    await quiet(() => ingestFile(dom.name, sourceFile('corpus.md', SHORT), 'corpus.md', false, null, { llm: reply(0) }));
    const after1 = size();
    reports.push(await quiet(() => ingestFile(dom.name, sourceFile('corpus.md', SHORT), 'corpus.md', true, null, { llm: reply(1) })));
    const after2 = size();
    reports.push(await quiet(() => ingestFile(dom.name, sourceFile('corpus.md', SHORT), 'corpus.md', true, null, { llm: reply(2) })));
    const after3 = size();
    const growth = (after3 - after1) / after1;
    console.log(`    corpus: round 1 ${after1} chars, round 2 +${after2 - after1}, round 3 +${after3 - after2} (${(growth * 100).toFixed(1)}% by round 3)`);
    ok(growth <= 0.1, 'BOUND: growth by round 3 is at most 10% of round 1', `${(growth * 100).toFixed(1)}%`);
    const sign = dom.read('concepts/owner-sign-off.md');
    ok(hasLine(sign, '- Refusals are logged with a timestamp for later audit'), 'a new point in round 2 accumulated');
    ok(hasLine(dom.read('entities/tide-agent.md'), '- Storm surge warnings reach 240 subscribers'), 'a new point in round 3 accumulated');
    eq(sign.split('\n').filter((l) => /confirm/i.test(l) && /binding/i.test(l) && !l.startsWith('- ')).length, 2, 'no pile of near-identical definitions: the first opening and definition only');
    eq(sign.match(/^- \[\[governed-agent\]\]/gm).length, 1, 'Related holds a target once, however it is described');
    ok(reports.every((r) => r.warnings.some((w) => w.includes('new wording was not added') && w.includes('On 3 pages'))), 'the report says so, aggregated across pages', JSON.stringify(reports[0].warnings).slice(0, 300));

    // Replay every reply already seen.
    const snapshot = paths.map((p) => dom.read(p));
    for (const i of [0, 1, 2]) await quiet(() => ingestFile(dom.name, sourceFile('corpus.md', SHORT), 'corpus.md', true, null, { llm: reply(i) }));
    paths.forEach((p, i) => eq(dom.read(p), snapshot[i], `replaying the same replies adds nothing: ${p}`));
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
    // The same guard on exact-name reuse.
    const dom = makeDomain({ 'concepts/agent.md': KEPT });
    const warnings = [];
    __setFoldComposeForTest((keep, incoming) => incoming);
    let rec;
    try { rec = await writePage(dom.name, 'concepts/agent.md', PROPOSED, { onWarn: (w) => warnings.push(w) }); }
    finally { __setFoldComposeForTest(null); }
    eq(rec, null, 'reuse, a lossy composer: nothing written');
    eq(dom.read('concepts/agent.md'), KEPT, 'reuse, a lossy composer: byte-identical');
    ok(warnings.some((w) => w.includes('without losing text')), 'reuse, a lossy composer: reported');
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
    await writePage(dom.name, 'summaries/foo_bar.md', '# New\n\nBarley harvests failed.\n\n## Key Takeaways\n- Exports expanded abroad\n');
    const body = dom.read('summaries/foo-bar.md');
    ok(!/Merged from/.test(body) && hasLine(body, 'Barley harvests failed.') && hasLine(body, '- old point'), 'a summary reuses, never folds');
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
      const lostNew = oracle(proposed, body, route, { demoted: true })
        .filter((l) => !l.startsWith('Tags:'))
        .filter((l) => !(route.startsWith('reuse') && l.startsWith('# Proposed')));
      if (lostKept.length || lostNew.length) allLost.push({ route, seed, lostKept: lostKept.slice(0, 3), lostNew: lostNew.slice(0, 3) });
    };

    const N = Number(process.env.CURATOR_TEST_FOLD_SEEDS) || 40;
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

      // Exact-name reuse, through each way a page is written.
      d = makeDomain({ 'concepts/thing.md': existing });
      await quiet(() => writePage(d.name, 'concepts/thing.md', proposed));
      const firstBody = d.read('concepts/thing.md');
      record('reuse writePage', seed, existing, proposed, firstBody);
      const twice = await quiet(() => writePage(d.name, 'concepts/thing.md', proposed));
      if (d.read('concepts/thing.md') !== firstBody || twice.status !== 'unchanged') allLost.push({ route: 'reuse idempotence', seed, status: twice.status });

      d = makeDomain({ 'concepts/thing.md': existing });
      await quiet(() => ingestFile(d.name, sourceFile(`u${seed}.md`, SHORT), `u${seed}.md`, false, null, {
        llm: singlePass(`u${seed}.md`, [{ path: 'concepts/thing.md', content: proposed }]),
      }));
      record('reuse single-pass', seed, existing, proposed, d.read('concepts/thing.md'));

      d = makeDomain({ 'concepts/thing.md': existing });
      await quiet(() => ingestFile(d.name, sourceFile(`v${seed}.md`, LONG), `v${seed}.md`, false, null, {
        llm: multiPhase(`v${seed}.md`, ['concepts/thing.md', 'entities/harbour.md', 'concepts/rivers.md'], { 'concepts/thing.md': proposed }),
      }));
      record('reuse multi-phase', seed, existing, proposed, d.read('concepts/thing.md'));

      d = makeDomain({ 'entities/some-thing.md': existing.replace('type: concept', 'type: entity') });
      const convR = `00000000-0000-4000-8000-${String(200000000000 + seed)}`;
      await files.writeConversation(d.name, { id: convR, title: 'T', createdAt: new Date().toISOString(), messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }] });
      const llmR = async (s0, p0, m0, f0, w0, opts) => {
        usage(opts);
        return JSON.stringify({ title: `R ${seed}`, pages: [{ path: 'summaries/c.md', content: '# C\n\n## Key Takeaways\n- k\n' }, { path: 'entities/some-thing.md', content: proposed }] });
      };
      await quiet(() => compileConversation(d.name, convR, () => {}, { generateText: llmR }));
      record('reuse compile', seed, existing, proposed, d.read('entities/some-thing.md'));

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
      for (const t of ['flow south', 'flood often']) eq(body.split(t).length - 1, 1, `hub: "${t}" is on the page once, not again unlinked`);
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
        const afterFold = d.read(`entities/mcp-page-${seed}.md`);
        const re = await rpc('tools/call', { name: 'compile_to_wiki', arguments: {
          domain: d.name,
          title: `Reuse ${seed}`,
          summary_content: `# Reuse ${seed}\n\n## Key Takeaways\n- r${seed}\n`,
          additional_pages: [{ path: `entities/mcp-page-${seed}.md`, content: `# Other\n\nZephyr${seed} barometers oscillate.\n\n## Definition\nQuartz${seed} lattices refract.\n` }],
          broken_link_policy: 'keep',
        } });
        ok(!re.error && !re.result.isError, `mcp seed ${seed}: reuse ran`);
        record('reuse mcp', seed, afterFold, `# Proposed\n\nZephyr${seed} barometers oscillate.\n\n## Definition\nQuartz${seed} lattices refract.\n`, d.read(`entities/mcp-page-${seed}.md`));
      }
      mcpChild.stdin.end();
      mcpChild.kill();
      mcpChild = null;
    }

    for (const [route, n] of Object.entries(stats)) console.log(`    ${route}: ${n} pairs`);
    eq(allLost.length, 0, `no line lost in ${Object.values(stats).reduce((a, b) => a + b, 0)} generated folds`);
    for (const l of allLost.slice(0, 6)) console.log('    ' + JSON.stringify(l));
    ok(Object.keys(stats).length === 13, 'CONTROL: all thirteen routes ran');

    // A dumb cross-check on the generator: the merge reuse used to go through DOES
    // lose lines on these pages, so the oracle can see a loss.
    let oldMergeLosses = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const existing = genExisting(seed);
      if (oracle(existing, mergeWikiPage(existing, genProposed(seed)), 'old merge').length) oldMergeLosses++;
    }
    ok(oldMergeLosses > 0, `CONTROL: the oracle sees the old merge lose lines (${oldMergeLosses}/10 pairs)`);
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
