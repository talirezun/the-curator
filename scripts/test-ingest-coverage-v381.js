#!/usr/bin/env node
/**
 * v3.81.0 — an announced product gets its own entity page; what chat cannot
 * see; and writePage's redirects become user-visible.
 *
 * The report: a Haiku 4.5 ingest of an article announcing the user's own tool
 * ("Trust Grader") wrote concept pages about its features but no
 * entities/trust-grader.md, and Chat, asked why, blamed "an oversight in the
 * instruction execution" — a cause it could not see.
 *
 * OFFLINE, deterministic, no network. Sections:
 *   1. The announced-product rule is in BOTH prompts that decide which pages
 *      exist (outline + single-pass), in item 2 right after the originator
 *      rule — and it is the ONLY change: minus that line, each prompt is
 *      byte-identical to v3.80.0's (recorded digests).
 *   2. The Phase 2 batch prompt is UNCHANGED (recorded v3.80.0 digest of the
 *      prefix and of the whole prompt) and its prefix is byte-identical across
 *      two batches of one ingest — the caching invariant.
 *   3. New-domain templates name tools/products in the entity wording the
 *      system prompt carries (generic, personal, business; tech already did).
 *   4. Chat's three intent blocks each carry the "what chat cannot see"
 *      clause, with and without a pinned project.
 *   5. writePage's Pass A / Pass B / 3b redirects each produce a user-visible
 *      warning in the wording the result panel files under Auto-fixed; an
 *      unredirected write produces none; three of a kind aggregate.
 *   6. Compile surfaces the same redirect warning (it now passes onWarn).
 *
 * Run:  node scripts/test-ingest-coverage-v381.js
 */

import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { createHash } from 'crypto';
import path from 'path';
import os from 'os';

const DOMAINS_TMP = mkdtempSync(path.join(os.tmpdir(), 'curator-v381-domains-'));
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS_TMP;
process.on('exit', () => { try { rmSync(DOMAINS_TMP, { recursive: true, force: true }); } catch {} });

const ingest = await import('../src/brain/ingest.js');
const files = await import('../src/brain/files.js');
const chat = await import('../src/brain/chat.js');
const compileMod = await import('../src/brain/compile.js');

const { buildOutlinePrompt, buildPrompt, buildBatchPromptParts, buildBatchPrompt, ANNOUNCED_PRODUCT_RULE } = ingest.__testing;
const { aggregateWarnings } = ingest;
const { WIKI_ONLY_CLAUSE, PROJECT_CONFLICT_CLAUSE } = chat.__testing;
const chatBuildPrompt = chat.__testing.buildPrompt;

let passed = 0, failed = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; failures.push(label); console.log(`  ✗ ${label}`); }
}
function eq(a, b, label) { ok(a === b, a === b ? label : `${label} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`); }
function section(t) { console.log(`\n${t}`); }
const digest = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

const FILES = { entities: ['alice.md', 'trust-grader.md'], concepts: ['rag.md'] };

// ── 1 ────────────────────────────────────────────────────────────────────────
section('1. the announced-product rule — outline and single-pass prompts');
{
  ok(typeof ANNOUNCED_PRODUCT_RULE === 'string' && ANNOUNCED_PRODUCT_RULE.length > 0, 'the rule is exported for tests');
  // What the rule must SAY — each phrase is a part of the measured fix.
  ok(/introduces, announces, launches or reviews/.test(ANNOUNCED_PRODUCT_RULE), 'it names the four ways a source can be about a product');
  ok(/product,\s+tool, app, service or project/.test(ANNOUNCED_PRODUCT_RULE), 'it names product, tool, app, service and project');
  ok(/ALSO a primary subject/.test(ANNOUNCED_PRODUCT_RULE), 'it makes the product a PRIMARY subject, like the originator');
  ok(/its own entities\/ page/.test(ANNOUNCED_PRODUCT_RULE), 'it requires an entities/ page (Gemini filed the tool as a CONCEPT 7 in 8)');
  ok(/\(e\.g\. entities\/<product-name>\.md — never concepts\/\)/.test(ANNOUNCED_PRODUCT_RULE),
    'it shows the entities/ path and forbids concepts/ (measured load-bearing for Gemini: 3/6 without, 6/6 with)');
  ok(/even when concept pages cover its features/.test(ANNOUNCED_PRODUCT_RULE), 'it says concept pages about its features do not replace it');
  ok(/NEVER omit it\.$/.test(ANNOUNCED_PRODUCT_RULE), 'it ends "NEVER omit it."');

  const outline = buildOutlinePrompt('2026-09-30', '| idx |', FILES, 'src.md', 'SOURCE TEXT', false, 'summaries/src.md');
  const single = buildPrompt('2026-09-30', '| idx |', FILES, 'src.md', 'SOURCE TEXT', false, false, 'summaries/src.md');
  const strict = buildPrompt('2026-09-30', '', FILES, 'src.md', 'SOURCE TEXT', true, true, 'summaries/src.md');

  for (const [name, p] of [['outline', outline], ['single-pass', single], ['single-pass strict/overwrite', strict]]) {
    const at = p.indexOf(ANNOUNCED_PRODUCT_RULE);
    ok(at >= 0, `${name}: carries the rule`);
    eq(p.split(ANNOUNCED_PRODUCT_RULE).length - 1, 1, `${name}: exactly once`);
    ok(at > p.indexOf('NEVER omit the originator.') && at < p.indexOf('3. SUBSTANTIVE entities'),
      `${name}: inside REQUIRED COVERAGE item 2, after the originator rule and before item 3`);
  }

  // The rule is the ONLY change. Digests recorded by executing buildOutlinePrompt
  // and buildPrompt out of `git show v3.80.0-era main:src/brain/ingest.js`
  // (ccdc68e) over these exact fixtures. Re-record against the PREVIOUS
  // release's ingest.js, never by pasting the new value.
  const V380 = {
    outline: '5ae7d4f91e095b627cfa80dc240ee502a97b0710bb069558b59665330917b394',
    single: 'f6f3fcacc81849c4436e0749907f6c55af97977c165a7698d66d628de88af7c1',
    strict: '9fbe638de477518c2a49c0cbf0e585ca95cbeec017e6b6af8cd6a057fcb508bc',
  };
  const minus = (p) => p.replace('\n' + ANNOUNCED_PRODUCT_RULE, '');
  eq(digest(minus(outline)), V380.outline, 'outline minus the rule is byte-identical to v3.80.0');
  eq(digest(minus(single)), V380.single, 'single-pass minus the rule is byte-identical to v3.80.0');
  eq(digest(minus(strict)), V380.strict, 'strict single-pass minus the rule is byte-identical to v3.80.0');
  ok(digest(outline) !== V380.outline, 'CONTROL: with the rule the digest differs — the recorded values discriminate');
}

// ── 2 ────────────────────────────────────────────────────────────────────────
section('2. the Phase 2 batch prompt — unchanged, and its prefix stable across batches');
{
  const all = [
    { path: 'summaries/s.md', summary: 'S' }, { path: 'entities/alice.md', summary: 'A' },
    { path: 'entities/trust-grader.md', summary: 'T' }, { path: 'concepts/rag.md', summary: 'R' },
    { path: 'concepts/x.md', summary: 'X' },
  ];
  const p1 = buildBatchPromptParts('2026-09-30', 'src.md', 'SOURCE TEXT', all.slice(0, 4), FILES, all);
  const p2 = buildBatchPromptParts('2026-09-30', 'src.md', 'SOURCE TEXT', all.slice(4), FILES, all);
  eq(p1.prefix, p2.prefix, 'batch 1 and batch 2 share a byte-identical prefix (the cache invariant)');
  ok(p1.suffix !== p2.suffix, 'CONTROL: the two batches really are different batches');
  // Recorded from v3.80.0 (ccdc68e) over these fixtures.
  eq(digest(p1.prefix), '9ebe04513c603696ba37f3d088da59bb5029ebed7beb75337e72086eb783733a',
    'the batch prefix is byte-identical to v3.80.0 (the rule did not leak into it)');
  eq(digest(buildBatchPrompt('2026-09-30', 'src.md', 'SOURCE TEXT', all.slice(0, 4), FILES, all)),
    '0e48553c9341c27be4b827826050baa9059e2e5354c58c7150ff6c74f1faf5d0',
    'the whole batch prompt is byte-identical to v3.80.0');
  ok(!p1.prefix.includes(ANNOUNCED_PRODUCT_RULE) && !p1.suffix.includes(ANNOUNCED_PRODUCT_RULE),
    'the batch prompt does not carry the coverage rule — coverage is decided once, by the outline');
}

// ── 3 ────────────────────────────────────────────────────────────────────────
section('3. new-domain templates name tools and products');
{
  const instr = (md) => {
    const m = md.match(/## Instructions for the AI[\s\S]*?\n2\. ([^\n]+)/);
    return m ? m[1] : '';
  };
  const entitiesLine = (md) => (md.match(/- \*\*entities\/\*\* — ([^\n]+)/) || [])[1] || '';
  const cases = [
    ['generic', /\btool\b/, /\bproduct\b/],
    ['personal', /\btool\b/, null],
    ['business', /\btool\b/, /\bproduct\b/],
    ['tech', /\btool\b/, null],
  ];
  for (const [template, mustTool, mustProduct] of cases) {
    const slug = `zz-v381-${template}`;
    await files.createDomain(slug, `ZZ ${template}`, '', template);
    const md = readFileSync(path.join(files.domainPath(slug), 'CLAUDE.md'), 'utf8');
    const step2 = instr(md);
    ok(step2.startsWith('Create or update entity pages'), `${template}: found the ingest instruction for entities`);
    ok(mustTool.test(step2), `${template}: the ingest instruction names tools ("${step2}")`);
    ok(mustTool.test(entitiesLine(md)), `${template}: the entities/ page-type line names tools`);
    if (mustProduct) ok(mustProduct.test(step2), `${template}: the ingest instruction names products`);
  }
}

// ── 4 ────────────────────────────────────────────────────────────────────────
section('4. chat — every intent block says what chat cannot see');
{
  ok(/not how any ingest ran/.test(WIKI_ONLY_CLAUSE), 'the clause says chat cannot see how an ingest ran');
  ok(/app's own ingest instructions/.test(WIKI_ONLY_CLAUSE), '…nor the app\'s own ingest instructions');
  ok(/why a page was or wasn't created/.test(WIKI_ONLY_CLAUSE), 'it covers "why was / wasn\'t a page created"');
  ok(/can't tell from here/.test(WIKI_ONLY_CLAUSE) && /do not guess a cause/.test(WIKI_ONLY_CLAUSE),
    'it says to say so plainly and not guess');
  ok(/log\.md/.test(WIKI_ONLY_CLAUSE) && /Wiki health/.test(WIKI_ONLY_CLAUSE), 'it points to log.md and to Wiki health');

  const PAGES = [
    { path: 'summaries/a.md', content: '# A\n\n- about retrieval' },
    { path: 'concepts/rag.md', content: '# RAG\n\n- retrieval' },
  ];
  const asks = {
    enumerate: 'list all articles',
    decision: 'which of these should I write next?',
    synthesis: 'how does retrieval work?',
  };
  for (const [intent, q] of Object.entries(asks)) {
    const header = intent === 'enumerate' ? 'ENUMERATION query' : intent === 'decision' ? 'DECISION / RECOMMENDATION' : 'Instructions:';
    for (const project of [null, '[Project context]\nX']) {
      const p = chatBuildPrompt('articles', PAGES, [], q, 'balanced', project);
      ok(p.includes(header), `${intent}${project ? ' + project' : ''}: routed to its own block (control)`);
      eq(p.split(WIKI_ONLY_CLAUSE).length - 1, 1, `${intent}${project ? ' + project' : ''}: carries the clause exactly once`);
      ok(p.indexOf(WIKI_ONLY_CLAUSE) > p.indexOf('[New message from user]'),
        `${intent}${project ? ' + project' : ''}: the clause sits in the instructions, after the user's message`);
      if (project) ok(p.indexOf(WIKI_ONLY_CLAUSE) < p.indexOf(PROJECT_CONFLICT_CLAUSE),
        `${intent} + project: the clause precedes the project-conflict clause`);
    }
  }
}

// ── 5 ────────────────────────────────────────────────────────────────────────
section('5. writePage — redirects are user-visible warnings');
{
  const domain = 'zz-v381-write';
  await files.createDomain(domain, 'ZZ write', '', 'generic');
  const wiki = path.join(files.domainPath(domain), 'wiki');
  await mkdir(path.join(wiki, 'entities'), { recursive: true });
  await mkdir(path.join(wiki, 'concepts'), { recursive: true });
  await writeFile(path.join(wiki, 'entities', 'tali-rezun.md'), '# Tali Rezun\n\n## Key Points\n- Author.\n');
  await writeFile(path.join(wiki, 'concepts', 'trust-grader.md'), '# Trust Grader\n\n## Definition\n- A tool.\n');

  const real = [];   // every warning writePage really emitted, for the aggregation cross-check
  const write = async (p) => {
    const warns = [];
    const rec = await files.writePage(domain, p, `# X\n\nType: tool\nTags: t\n\n## Key Points\n- From ${p}.\n`, { onWarn: (w) => warns.push(w) });
    real.push(...warns);
    return { rec, warns };
  };

  // Pass B — hyphen variant.
  {
    const { rec, warns } = await write('entities/talirezun.md');
    eq(rec && rec.canonPath, 'entities/tali-rezun.md', 'Pass B: talirezun.md is redirected to tali-rezun.md');
    eq(warns.length, 1, 'Pass B: exactly one warning');
    ok(/^Page "entities\/talirezun\.md" is a spelling variant of the existing "entities\/tali-rezun\.md"/.test(warns[0] || ''),
      'Pass B: the warning names both paths');
    ok(/redirected to canonical/i.test(warns[0] || ''), 'Pass B: carries "redirected to canonical" (result panel: Auto-fixed)');
    ok(!existsSync(path.join(wiki, 'entities', 'talirezun.md')), 'Pass B: no variant file was created');
  }
  // Pass A — title prefix.
  {
    const { rec, warns } = await write('entities/dr-tali-rezun.md');
    eq(rec && rec.canonPath, 'entities/tali-rezun.md', 'Pass A: dr-tali-rezun.md is redirected to tali-rezun.md');
    eq(warns.length, 1, 'Pass A: exactly one warning');
    ok(/is a spelling variant/.test(warns[0] || ''), 'Pass A: the same variant wording');
  }
  // 3b — cross-folder. THE Trust Grader case: the model now asks for an entity,
  // but a concept of the same name already exists.
  {
    const { rec, warns } = await write('entities/trust-grader.md');
    eq(rec && rec.canonPath, 'concepts/trust-grader.md', '3b: entities/trust-grader.md lands on the existing concepts/trust-grader.md');
    eq(warns.length, 1, '3b: exactly one warning');
    ok(/^Page "entities\/trust-grader\.md" already exists in the other folder as "concepts\/trust-grader\.md"/.test(warns[0] || ''),
      '3b: the warning names both paths');
    ok(/redirected to canonical/i.test(warns[0] || ''), '3b: carries "redirected to canonical" (Auto-fixed)');
    ok(!existsSync(path.join(wiki, 'entities', 'trust-grader.md')), '3b: no second file was created');
  }
  // Controls — no redirect, no warning.
  {
    const a = await write('entities/brand-new.md');
    eq(a.warns.length, 0, 'CONTROL: a brand-new page produces no warning');
    const b = await write('entities/tali-rezun.md');
    eq(b.warns.length, 0, 'CONTROL: writing the canonical path itself produces no warning');
    eq(b.rec && b.rec.canonPath, 'entities/tali-rezun.md', 'CONTROL: …and lands where it was asked to');
  }
  // Aggregation — per-page classes collapse at 3, keep specifics at 2.
  {
    const v = (i) => `Page "entities/v${i}.md" is a spelling variant of the existing "entities/c${i}.md" — redirected to canonical "entities/c${i}.md"; its content was merged into that page.`;
    const x = (i) => `Page "entities/x${i}.md" already exists in the other folder as "concepts/x${i}.md" — redirected to canonical "concepts/x${i}.md" (the page that existed first keeps its folder); its content was merged into that page.`;
    const three = aggregateWarnings([v(1), v(2), v(3), 'other']);
    eq(three.length, 2, 'three variant redirects aggregate into one line (plus the unrelated one)');
    ok(/^3 pages came back under a spelling variant/.test(three[0]) && /redirected to canonical/.test(three[0]),
      'the variant aggregate counts them and stays in the Auto-fixed bucket');
    ok(three[0].includes('entities/v1.md'), 'the variant aggregate names examples');
    const threeX = aggregateWarnings([x(1), x(2), x(3)]);
    eq(threeX.length, 1, 'three cross-folder redirects aggregate into one line');
    ok(/^3 pages were written to entities\/ or concepts\//.test(threeX[0]) && /redirected to canonical/.test(threeX[0]),
      'the cross-folder aggregate counts them and stays in the Auto-fixed bucket');
    const two = aggregateWarnings([v(1), v(2)]);
    eq(two.length, 2, 'two of a kind keep their specific paths (below the threshold)');
    // Dumb cross-check: the strings above are hand-written. The REAL warnings
    // writePage emitted in this section must hit the same classes, or a
    // wording drift in files.js would silently stop aggregating.
    eq(real.length, 3, 'writePage really emitted three redirect warnings above (Pass B, Pass A, 3b)');
    for (const w of real) {
      eq(aggregateWarnings([w, w, w]).length, 1, `a real writePage warning aggregates: "${w.slice(0, 60)}…"`);
    }
  }
}

// ── 6 ────────────────────────────────────────────────────────────────────────
section('6. compile — the same redirect warning reaches its result');
{
  const domain = 'zz-v381-compile';
  await files.createDomain(domain, 'ZZ compile', '', 'generic');
  const wiki = path.join(files.domainPath(domain), 'wiki');
  await mkdir(path.join(wiki, 'concepts'), { recursive: true });
  await writeFile(path.join(wiki, 'concepts', 'openai.md'), '# OpenAI\n\n## Definition\n- Filed as a concept earlier.\n');
  const convId = '00000000-0000-4000-8000-000000038101';
  await files.writeConversation(domain, {
    id: convId, title: 'v381', createdAt: '2026-09-30T00:00:00.000Z', domain,
    messages: [
      { role: 'user', content: 'Tell me about OpenAI.' },
      { role: 'assistant', content: 'OpenAI builds models.' },
    ],
  });
  const JSONOUT = JSON.stringify({
    title: 'v381 compile',
    pages: [
      { path: 'summaries/placeholder.md', content: '# T\n\nTags: t\n\n- Discussed [[openai]].', summary: 's' },
      { path: 'entities/openai.md', content: '# OpenAI\n\nType: company\nTags: ai\n\n- Builds models.', summary: 'o' },
    ],
  });
  const res = await compileMod.compileConversation(domain, convId, () => {}, { generateText: async () => JSONOUT });
  ok(res.ok === true, `compile ok (${res.error || ''})`);
  ok(Array.isArray(res.warnings) && res.warnings.some((w) => /already exists in the other folder as "concepts\/openai\.md"/.test(w)),
    'the compile result carries the cross-folder redirect warning');
  ok(res.pagesWritten.includes('concepts/openai.md') && !res.pagesWritten.includes('entities/openai.md'),
    'CONTROL: the redirect really happened');
}

console.log(`\n${'─'.repeat(60)}\nPassed: ${passed}   Failed: ${failed}`);
if (failed) {
  console.log('❌ FAILURES:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('✅ All v3.81.0 ingest-coverage assertions green');
