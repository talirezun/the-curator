#!/usr/bin/env node
/**
 * test-ingest-batch-filter.js — v3.84.0. Offline, isolated, stubbed LLM.
 *
 * THE REPORT. A user's Flash-Lite 2.5 ingest produced a summary whose Key
 * Takeaways said the same six things five times. Reproduced live on a
 * 40,939-char source: 5 Phase 2 batches, 4 of them returned the summary (and
 * every other planned page) although each was asked for 4 pages only;
 * reconcileGeneratedPages folded the five summaries into one and mergeWikiPage
 * unioned their reworded bullets — 33 takeaways. On a real wiki: 935 from one
 * ingest. Every other page was paid for up to five times and keep-last wrote
 * the copy from the LAST batch, not the one that was asked.
 *
 * WHAT THIS PINS, by executing the real code (ingestFile through the
 * documented `opts.llm` seam, an isolated tmp domains dir — never domains/):
 *   §1  filterBatchReply — the per-page rule, as a pure function.
 *   §2  A misbehaving model (every batch returns EVERY planned page) → the
 *       summary's takeaways come from ONE batch, every other page holds the
 *       content of the batch that was asked for it, each page is written once,
 *       and no extra (fallback) call is spent. Plus a dumb cross-check: the
 *       fake really did return the summary from batches that never asked.
 *   §3  The batch prefix the ingest actually sent is byte-identical across
 *       batches, and equals buildBatchPromptParts' prefix (the cache invariant).
 *   §4  The reserve: a page its own batch omitted, or could only stub, is
 *       written from the copy another batch returned — never lost.
 *   §5  Trunk pages: no empty stub after a single-pass ingest, none when the
 *       parent exists on disk; multi-phase still injects (control). A
 *       plan-only page already on disk is left byte-identical.
 *   §6  Stub content: a summary stub is type/summary and carries a Source line.
 *   §7  Summary shape: one warning naming the summary when it lacks a title or
 *       Key Takeaways; a missing Source line is filled from the filename.
 *   §8  Summary slug collision vs same-source re-ingest.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(a, b, label) { ok(a === b, `${label} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`); }
const section = (t) => console.log(`\n${t}`);

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'curator-batch-filter-'));
const USER_DATA = path.join(TMP_ROOT, 'userdata');
const DOMAINS = path.join(TMP_ROOT, 'domains');
mkdirSync(USER_DATA, { recursive: true });
mkdirSync(DOMAINS, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DATA;
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS;
process.env.CURATOR_TEST_INSTANCE_DIR = path.join(TMP_ROOT, 'instances');

const ASK_RE = /Write the full markdown content for EXACTLY these wiki pages[\s\S]*?\n\]/;
const askedPaths = (prompt) => ((prompt.match(ASK_RE) || [''])[0].match(/"path": "([^"]+)"/g) || [])
  .map(s => s.slice(9, -1));

let domainSeq = 0;
function makeDomain(files = {}) {
  const name = `d${++domainSeq}`;
  const dd = path.join(DOMAINS, name);
  for (const d of ['wiki/entities', 'wiki/concepts', 'wiki/summaries', 'raw']) mkdirSync(path.join(dd, d), { recursive: true });
  writeFileSync(path.join(dd, 'CLAUDE.md'), '# Test domain schema\n', 'utf8');
  writeFileSync(path.join(dd, 'wiki', 'index.md'), '# Index\n\n| Page | Type | Summary |\n|---|---|---|\n', 'utf8');
  writeFileSync(path.join(dd, 'wiki', 'log.md'), '# Log\n\n', 'utf8');
  for (const [rel, body] of Object.entries(files)) writeFileSync(path.join(dd, 'wiki', rel), body, 'utf8');
  return { name, wiki: path.join(dd, 'wiki') };
}
function sourceFile(name, text) {
  const dir = path.join(TMP_ROOT, 'src', String(++domainSeq));
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  writeFileSync(p, text, 'utf8');
  return p;
}
const usage = (opts) => {
  if (opts && typeof opts.onUsage === 'function') opts.onUsage({ inputTokens: 100, outputTokens: 50, provider: 'fake', model: 'fake-1' });
};
const quiet = async (fn) => {
  const e = console.error, w = console.warn, l = console.log;
  const logged = [];
  console.error = (...a) => logged.push(a.join(' '));
  console.warn = (...a) => logged.push(a.join(' '));
  try { return { value: await fn(), logged }; }
  finally { console.error = e; console.warn = w; console.log = l; }
};
const takeaways = (md) => ((md.split(/^## Key Takeaways\s*$/m)[1] || '').split(/^## /m)[0])
  .split('\n').filter(l => l.startsWith('- '));

try {
  const ingest = await import('../src/brain/ingest.js');
  const { ingestFile, filterBatchReply, summaryShapeWarning, validateOutline, computeSummarySlugFromSource, __testing } = ingest;
  const { __setDomainsDirOverride } = await import('../src/brain/config.js');
  const { appendManifestRecord } = await import('../src/brain/raw-store.js');
  __setDomainsDirOverride(DOMAINS);

  // A long, neutral source (> 15,000 chars → multi-phase; no byline, so no
  // originator injection; slugs share no prefix, so no trunk injection).
  const LONG = Array.from({ length: 400 }, (_, i) => `Paragraph ${i} about orchards, rivers and the harbour town.`).join('\n');
  const SHORT = 'A short note about orchards and rivers in the harbour town. '.repeat(10);

  // ── §1 ─────────────────────────────────────────────────────────────────
  section('§1  filterBatchReply — keep only what this batch was asked for');
  {
    const planned = ['summaries/s.md', 'entities/a.md', 'entities/b.md', 'concepts/c.md', 'concepts/d.md'];
    const reply = [
      { path: 'summaries/s.md', content: 'S' },
      { path: 'entities/a.md', content: 'A' },
      { path: 'concepts/c', content: 'C (no .md)' },
      { path: 'concepts/x.md', content: 'unplanned' },
      { path: 'summaries/invented-name.md', content: 'stray summary' },
      null,
    ];
    const r1 = filterBatchReply(reply, { requestedPaths: ['concepts/c.md', 'concepts/d.md'], plannedPaths: planned, summaryPath: 'summaries/s.md' });
    const keptPaths = r1.kept.map(p => p && p.path);
    ok(keptPaths.includes('concepts/c'), 'a requested page is kept (compared .md-normalised)');
    ok(keptPaths.includes('concepts/x.md'), 'an UNPLANNED page is kept (reconcile warns about it, as before)');
    ok(keptPaths.includes(null), 'a malformed entry is kept for reconcile to report, as before');
    ok(!keptPaths.includes('entities/a.md'), 'a page planned for ANOTHER batch is not kept');
    ok(!keptPaths.includes('summaries/s.md') && !keptPaths.includes('summaries/invented-name.md'),
      'no summary is kept from a batch that was not asked for it (canonical or invented path)');
    eq(r1.deferred.length, 3, 'three copies deferred to the reserve');
    ok(r1.deferred.every(d => d.key !== 'summaries/invented-name.md'), 'a deferred stray summary is keyed to the canonical summary');

    const r2 = filterBatchReply(reply, { requestedPaths: ['summaries/s.md', 'entities/a.md'], plannedPaths: planned, summaryPath: 'summaries/s.md' });
    const k2 = r2.kept.map(p => p && p.path);
    ok(k2.includes('summaries/s.md') && k2.includes('entities/a.md'), 'the batch asked for the summary keeps it');
    ok(k2.includes('summaries/invented-name.md'), '…and a stray summary path from that batch is left for reconcile to pin to canonical');
    ok(!k2.includes('concepts/c'), '…but still not another batch\'s page');
  }

  // ── §2 + §3 ────────────────────────────────────────────────────────────
  section('§2  A model that answers every batch with EVERY planned page');
  {
    const dom = makeDomain();
    const plan = ['summaries/orchard-notes.md',
      'entities/harbour-town.md', 'entities/river-board.md', 'entities/orchard-guild.md',
      'concepts/crop-rotation.md', 'concepts/flood-plain.md', 'concepts/grafting.md',
      'concepts/irrigation.md', 'concepts/pollination.md'];
    const calls = [];
    const llm = async (schema, prompt, maxTokens, format, onWait, opts) => {
      usage(opts);
      const asked = askedPaths(prompt);
      if (!asked.length) {
        calls.push({ kind: 'outline' });
        return JSON.stringify({ title: 'Orchard Notes', pages: plan.map(p => ({ path: p, summary: `about ${p}` })) });
      }
      const n = calls.filter(c => c.kind === 'batch').length + 1;
      calls.push({ kind: 'batch', n, asked, prompt, cachePrefixChars: opts && opts.cachePrefixChars });
      // The misbehaviour: ALL planned pages, every time, each stamped with the batch.
      return JSON.stringify({ pages: plan.map(p => ({
        path: p,
        summary: `s ${p}`,
        content: p.startsWith('summaries/')
          ? `# Orchard Notes\n\nSource: orchard-notes.md\nTags: test\n\n## Key Takeaways\n- batch ${n} point one, worded its own way\n- batch ${n} point two, worded its own way\n\n## Notes\nbatch ${n} notes\n`
          : `# ${p}\n\nTags: test\n\n## Key Facts\n- written by batch ${n}\n`,
      })) });
    };
    const src = sourceFile('orchard-notes.md', LONG);
    const { value: res } = await quiet(() => ingestFile(dom.name, src, 'orchard-notes.md', false, null, { llm }));
    const batches = calls.filter(c => c.kind === 'batch');

    eq(batches.length, 3, 'CONTROL — 9 planned pages ran as 3 batches');
    const unaskedSummaryBatches = batches.filter(b => !b.asked.some(a => a.startsWith('summaries/')));
    eq(unaskedSummaryBatches.length, 2, 'CONTROL — 2 batches returned the summary without being asked (the misbehaviour happened)');
    eq(calls.length, 4, 'no extra call: 1 outline + 3 batches, no page-by-page fallback');
    eq(res.tokenUsage.calls, 4, '…and the billed call count agrees');

    const sum = readFileSync(path.join(dom.wiki, 'summaries/orchard-notes.md'), 'utf8');
    const tk = takeaways(sum);
    eq(tk.length, 2, 'the summary has the 2 takeaways ONE batch wrote (was 6: three batches unioned)');
    ok(tk.every(l => l.includes('batch 1 ')), 'every takeaway comes from batch 1, the batch asked for the summary');
    ok(!/batch [23] /.test(sum), 'no text from the unasked batches reached the summary');

    // Each other page holds the content of the batch that was ASKED for it.
    const owner = new Map();
    for (const b of batches) for (const a of b.asked) owner.set(a, b.n);
    let allOwned = true;
    for (const p of plan.slice(1)) {
      const body = readFileSync(path.join(dom.wiki, p), 'utf8');
      const m = body.match(/written by batch (\d)/g) || [];
      if (m.length !== 1 || m[0] !== `written by batch ${owner.get(p)}`) { allOwned = false; console.log(`    ${p}: ${m.join(',')} (owner ${owner.get(p)})`); }
    }
    ok(allOwned, 'every entity/concept page holds exactly its OWN batch\'s content (keep-last used to pick batch 3)');
    const perPath = new Map();
    for (const c of res.changes) perPath.set(c.canonPath, (perPath.get(c.canonPath) || 0) + 1);
    ok(plan.every(p => perPath.get(p) === 1), 'every planned page has exactly one change record (written once)');
    ok(!res.warnings.some(w => /invented|extra summary/i.test(w)), 'no "invented summary" warning — the unasked copies never reached reconcile');

    // ── §3 ──
    section('§3  The cached batch prefix the ingest SENT is byte-identical across batches');
    ok(batches.every(b => typeof b.cachePrefixChars === 'number' && b.cachePrefixChars > 0), 'every batch carried a cache breakpoint (>= 2 batches)');
    const prefixes = batches.map(b => b.prompt.slice(0, b.cachePrefixChars));
    ok(prefixes.every(p => p === prefixes[0]), 'batch 1, 2 and 3 sent the SAME prefix bytes');
    ok(batches.every(b => b.cachePrefixChars === batches[0].cachePrefixChars), '…of the same length');
    ok(!prefixes[0].includes('Write the full markdown content'), 'the per-batch ask is not inside the cached prefix');
    // Dumb cross-check against the builder itself.
    const parts = __testing.buildBatchPromptParts('2026-01-01', 'x.md', 'T', [{ path: 'concepts/a.md', summary: 's' }], { entities: [], concepts: [] }, []);
    const parts2 = __testing.buildBatchPromptParts('2026-01-01', 'x.md', 'T', [{ path: 'concepts/b.md', summary: 't' }], { entities: [], concepts: [] }, []);
    ok(parts.prefix === parts2.prefix && parts.suffix !== parts2.suffix, 'buildBatchPromptParts: a different page list changes only the suffix');
  }

  // ── §4 ─────────────────────────────────────────────────────────────────
  section('§4  The reserve — a deferred copy fills a hole, never a second write');
  {
    const dom = makeDomain();
    const plan = ['summaries/reserve-notes.md',
      'entities/harbour-town.md', 'entities/river-board.md', 'entities/orchard-guild.md',
      'concepts/crop-rotation.md', 'concepts/flood-plain.md'];
    // Batch 1 = summary + 3 entities; batch 2 = 2 concepts.
    // Batch 1 OMITS entities/orchard-guild.md but batch 2 returns it.
    // Batch 2's own concepts/flood-plain.md is unusable everywhere it is asked
    // (batch reply AND page-by-page fallback) but batch 1 returned a copy.
    // Batch 2's concepts/crop-rotation.md is returned only by batch 2.
    let batchNo = 0;
    const llm = async (schema, prompt, maxTokens, format, onWait, opts) => {
      usage(opts);
      const asked = askedPaths(prompt);
      if (!asked.length) return JSON.stringify({ title: 'Reserve', pages: plan.map(p => ({ path: p, summary: `about ${p}` })) });
      const page = (p, who) => ({ path: p, content: `# ${p}\n\nTags: t\n\n## Facts\n- from ${who}\n`, summary: 's' });
      if (asked.length > 1 && asked.includes('summaries/reserve-notes.md')) {
        batchNo = 1;
        return JSON.stringify({ pages: [
          { path: 'summaries/reserve-notes.md', content: '# Reserve\n\nSource: reserve-notes.md\n\n## Key Takeaways\n- one\n', summary: 's' },
          page('entities/harbour-town.md', 'batch 1'), page('entities/river-board.md', 'batch 1'),
          page('concepts/flood-plain.md', 'batch 1 (unasked)'),
        ] });
      }
      if (asked.length > 1) {
        batchNo = 2;
        // Unusable for flood-plain: a reply that fails the batch gate → fallback.
        return 'not json at all';
      }
      // Page-by-page fallback for batch 2.
      if (asked[0] === 'concepts/crop-rotation.md') {
        return JSON.stringify({ pages: [page('concepts/crop-rotation.md', 'batch 2 fallback'), page('entities/orchard-guild.md', 'batch 2 (unasked)')] });
      }
      return 'still not json';   // flood-plain: unusable, concise retry unusable → stub
    };
    const src = sourceFile('reserve-notes.md', LONG);
    const { value: res } = await quiet(() => ingestFile(dom.name, src, 'reserve-notes.md', false, null, { llm }));
    ok(existsSync(path.join(dom.wiki, 'entities/orchard-guild.md')), 'a page its own batch OMITTED is still written');
    const og = path.join(dom.wiki, 'entities/orchard-guild.md');
    ok(existsSync(og) && /from batch 2 \(unasked\)/.test(readFileSync(og, 'utf8')), '…from the copy another batch returned');
    const fp = readFileSync(path.join(dom.wiki, 'concepts/flood-plain.md'), 'utf8');
    ok(/from batch 1 \(unasked\)/.test(fp) && !/Stub page/.test(fp), 'a page its own batch could only STUB is written from the sibling copy, not as a stub');
    ok(!res.warnings.some(w => /Stub page created for "concepts\/flood-plain\.md"/.test(w)), '…and no stub warning is shown for it');
    ok(/from batch 2 fallback/.test(readFileSync(path.join(dom.wiki, 'concepts/crop-rotation.md'), 'utf8')), 'a page written by its own (fallback) call keeps that content');

    // A stub with NO sibling copy is still a stub, with its warning (control).
    const dom2 = makeDomain();
    const plan2 = ['summaries/stub-notes.md', 'entities/harbour-town.md', 'concepts/grafting.md'];
    const llm2 = async (schema, prompt, maxTokens, format, onWait, opts) => {
      usage(opts);
      const asked = askedPaths(prompt);
      if (!asked.length) return JSON.stringify({ title: 'Stub', pages: plan2.map(p => ({ path: p, summary: `about ${p}` })) });
      if (asked.length > 1) return 'nope';
      if (asked[0] === 'concepts/grafting.md') return 'nope';
      return JSON.stringify({ pages: [{ path: asked[0], content: `# ${asked[0]}\n\nSource: stub-notes.md\n\n## Key Takeaways\n- k\n`, summary: 's' }] });
    };
    const { value: res2 } = await quiet(() => ingestFile(dom2.name, sourceFile('stub-notes.md', LONG), 'stub-notes.md', false, null, { llm: llm2 }));
    ok(/Stub page/.test(readFileSync(path.join(dom2.wiki, 'concepts/grafting.md'), 'utf8')), 'CONTROL — with no sibling copy the page is a visible stub');
    ok(res2.warnings.some(w => w.includes('Stub page created for "concepts/grafting.md"')), 'CONTROL — …and the stub warning is shown');
  }

  // ── §5 ─────────────────────────────────────────────────────────────────
  section('§5  Trunk pages and plan-only pages');
  {
    const cluster = (summaryContent) => ({
      title: 'Taste',
      pages: [
        { path: 'summaries/taste-notes.md', content: summaryContent || '# Taste Notes\n\nSource: taste-notes.md\n\n## Key Takeaways\n- taste matters\n' },
        { path: 'entities/harbour-town.md', content: '# Harbour Town\n\nType: place\nTags: t\n\n- a town\n' },
        { path: 'concepts/taste-as-moat.md', content: '# Taste as moat\n\nTags: t\n\n- moat\n' },
        { path: 'concepts/taste-as-judgment.md', content: '# Taste as judgment\n\nTags: t\n\n- judgment\n' },
        { path: 'concepts/taste-formula.md', content: '# Taste formula\n\nTags: t\n\n- formula\n' },
      ],
    });
    const single = (reply) => async (schema, prompt, maxTokens, format, onWait, opts) => { usage(opts); return JSON.stringify(reply); };

    const dom = makeDomain();
    const { value: res } = await quiet(() => ingestFile(dom.name, sourceFile('taste-notes.md', SHORT), 'taste-notes.md', false, null, { llm: single(cluster()) }));
    ok(!existsSync(path.join(dom.wiki, 'concepts/taste.md')), 'single-pass: NO empty trunk stub is written');
    ok(res.warnings.some(w => w.includes('"taste-*"') && w.includes('was not created')), 'single-pass: the missing parent is reported as not created');
    ok(!res.warnings.some(w => /originator-hint validator/.test(w)), 'the misleading "originator-hint validator" wording is gone');
    ok(!res.warnings.some(w => /injected the trunk page/.test(w)), 'single-pass does not claim it injected the trunk page (that wording buckets as Auto-fixed)');

    const TRUNK = '---\ntype: concept\ntags: [type/concept]\n---\n# Taste\n\n## Definition\n- the real trunk page\n';
    const dom2 = makeDomain({ 'concepts/taste.md': TRUNK });
    const { value: res2 } = await quiet(() => ingestFile(dom2.name, sourceFile('taste-notes.md', SHORT), 'taste-notes.md', false, null, { llm: single(cluster()) }));
    eq(readFileSync(path.join(dom2.wiki, 'concepts/taste.md'), 'utf8'), TRUNK, 'a trunk page that exists on disk is left byte-identical');
    ok(!res2.warnings.some(w => w.includes('without a parent')), '…and no "without a parent" warning is raised for it');

    // Multi-phase still injects a trunk that is absent (control), and skips one on disk.
    const outline = { pages: [{ path: 'summaries/s.md' }, { path: 'concepts/taste-a.md' }, { path: 'concepts/taste-b.md' }, { path: 'concepts/taste-c.md' }] };
    const v1 = validateOutline(JSON.parse(JSON.stringify(outline)), 'summaries/s.md', 's.md', [], { existingFiles: { entities: [], concepts: [] } });
    ok(v1.outline.pages.some(p => p.path === 'concepts/taste.md'), 'CONTROL — multi-phase: an absent trunk is still injected for Phase 2 to write');
    const v2 = validateOutline(JSON.parse(JSON.stringify(outline)), 'summaries/s.md', 's.md', [], { existingFiles: { entities: [], concepts: ['taste.md'] } });
    ok(!v2.outline.pages.some(p => p.path === 'concepts/taste.md'), 'multi-phase: a trunk already on disk is not injected');
    const v3 = validateOutline(JSON.parse(JSON.stringify(outline)), 'summaries/s.md', 's.md', []);
    ok(v3.outline.pages.some(p => p.path === 'concepts/taste.md'), 'no options → the pre-v3.84.0 behaviour (inject)');

    // Originator injected in single-pass: stub when absent, untouched when on disk.
    const BYLINE = 'Author: Jane Doe\n\n' + SHORT;
    const plain = { title: 'Jane', pages: [
      { path: 'summaries/jane-notes.md', content: '# Jane Notes\n\nSource: jane-notes.md\n\n## Key Takeaways\n- one\n' },
      { path: 'concepts/orchards.md', content: '# Orchards\n\nTags: t\n\n- trees\n' },
    ] };
    const dom3 = makeDomain();
    const { value: res3 } = await quiet(() => ingestFile(dom3.name, sourceFile('jane-notes.md', BYLINE), 'jane-notes.md', false, null, { llm: single(plain) }));
    const jane = path.join(dom3.wiki, 'entities/jane-doe.md');
    ok(existsSync(jane) && /Stub page/.test(readFileSync(jane, 'utf8')), 'CONTROL — an absent originator still gets a visible stub page');
    ok(res3.warnings.some(w => w.includes('entities/jane-doe.md') && /originator check/.test(w) && /stub page/i.test(w)),
      'its warning names the originator check and says "stub page" (the For review trigger)');
    const JANE = '---\ntype: entity\ntags: [type/entity]\n---\n# Jane Doe\n\n## Key Facts\n- a real page\n';
    const dom4 = makeDomain({ 'entities/jane-doe.md': JANE });
    await quiet(() => ingestFile(dom4.name, sourceFile('jane-notes.md', BYLINE), 'jane-notes.md', false, null, { llm: single(plain) }));
    eq(readFileSync(path.join(dom4.wiki, 'entities/jane-doe.md'), 'utf8'), JANE, 'a plan-only page that exists on disk is NOT merged with a stub');
  }

  // ── §6 ─────────────────────────────────────────────────────────────────
  section('§6  Stub content');
  {
    const s = __testing.stubPageContent('summaries/foo.md', 'planned', 'foo.pdf');
    ok(/type\/summary/.test(s) && !/type\/concept/.test(s), 'a summary stub is tagged type/summary (was type/concept)');
    ok(/^Source: foo\.pdf$/m.test(s), 'a summary stub carries a Source line');
    ok(/type\/concept/.test(__testing.stubPageContent('concepts/x.md', '', 'f')), 'a concept stub is still type/concept');
    ok(/type\/entity/.test(__testing.stubPageContent('entities/x.md', '', 'f')), 'an entity stub is still type/entity');
    ok(!/^Source:/m.test(__testing.stubPageContent('concepts/x.md', '', 'f')), 'non-summary stubs get no Source line');
  }

  // ── §7 ─────────────────────────────────────────────────────────────────
  section('§7  Summary shape check, and the Source fill');
  {
    const single = (reply) => async (schema, prompt, maxTokens, format, onWait, opts) => { usage(opts); return JSON.stringify(reply); };
    const page2 = { path: 'concepts/orchards.md', content: '# Orchards\n\nTags: t\n\n- trees\n' };

    const dom = makeDomain();
    const bad = { title: 'Bad', pages: [{ path: 'summaries/bad-shape.md', content: 'Key Takeaways:\n- a label, not a heading\n\nTags: t\n' }, page2] };
    const { value: r } = await quiet(() => ingestFile(dom.name, sourceFile('bad-shape.md', SHORT), 'bad-shape.md', false, null, { llm: single(bad) }));
    const shape = r.warnings.filter(w => /did not follow the summary layout/.test(w));
    eq(shape.length, 1, 'ONE shape warning for a summary with no title and a label instead of a heading');
    ok(shape[0] && shape[0].includes('summaries/bad-shape.md'), '…naming the summary');
    ok(shape[0] && /title/.test(shape[0]) && /Key Takeaways/.test(shape[0]), '…and what is missing');
    const saved = readFileSync(path.join(dom.wiki, 'summaries/bad-shape.md'), 'utf8');
    ok(/^source: bad-shape\.md$/m.test(saved), 'a summary with no Source line gets source: <filename> in its frontmatter');
    ok(shape[0] && !/a source/.test(shape[0]), '…so "a source" is not among the missing parts');

    const dom2 = makeDomain();
    const good = { title: 'Good', pages: [{ path: 'summaries/good-shape.md', content: '# Good Shape\n\nSource: good-shape.md\nTags: t\n\n## Key Takeaways\n- a real point\n' }, page2] };
    const { value: r2 } = await quiet(() => ingestFile(dom2.name, sourceFile('good-shape.md', SHORT), 'good-shape.md', false, null, { llm: single(good) }));
    ok(!r2.warnings.some(w => /did not follow the summary layout/.test(w)), 'a well-shaped summary raises no shape warning');
    ok(/^source: good-shape\.md$/m.test(readFileSync(path.join(dom2.wiki, 'summaries/good-shape.md'), 'utf8')), 'the model\'s own Source line is used');

    // Pure checks.
    eq(summaryShapeWarning('summaries/x.md', '---\nsource: x.md\n---\n# X\n\n## Key Takeaways\n- p\n', 'x.md'), null, 'complete summary → null');
    ok(/a source/.test(summaryShapeWarning('summaries/x.md', '# X\n\n## Key Takeaways\n- p\n', 'x.md') || ''), 'no frontmatter source → reported');
    ok(/Key Takeaways/.test(summaryShapeWarning('summaries/x.md', '---\nsource: x.md\n---\n# X\n\n## Key Takeaways\n\n## Notes\n- p\n', 'x.md') || ''), 'an EMPTY Key Takeaways section → reported');
    eq(summaryShapeWarning('summaries/x.md', '# x\n\n> ⚠ **Stub summary — AI did not produce content for this page.**\n', 'x.md'), null, 'a stub is not double-warned');
  }

  // ── §8 ─────────────────────────────────────────────────────────────────
  section('§8  Summary slug collision vs same-source re-ingest');
  {
    const single = (name) => async (schema, prompt, maxTokens, format, onWait, opts) => {
      usage(opts);
      const m = prompt.match(/"(summaries\/[^"]+\.md)"/);
      return JSON.stringify({ title: name, pages: [
        { path: m ? m[1] : 'summaries/unknown.md', content: `# ${name}\n\nSource: ${name}\n\n## Key Takeaways\n- point from ${name}\n` },
        { path: 'concepts/orchards.md', content: '# Orchards\n\nTags: t\n\n- trees\n' },
      ] });
    };
    const stem = 'a'.repeat(85);
    const A = `${stem}-part-one.md`, B = `${stem}-part-two.md`;
    const base = computeSummarySlugFromSource(A);
    eq(base, computeSummarySlugFromSource(B), 'CONTROL — the two filenames really share one slug');
    const hashB = createHash('sha256').update(B, 'utf8').digest('hex').slice(0, 6);

    const dom = makeDomain();
    await quiet(() => ingestFile(dom.name, sourceFile(A, SHORT), A, false, null, { llm: single(A) }));
    const aFile = path.join(dom.wiki, `summaries/${base}.md`);
    const aBytes = readFileSync(aFile, 'utf8');
    const { value: rB } = await quiet(() => ingestFile(dom.name, sourceFile(B, SHORT), B, false, null, { llm: single(B) }));
    const bFile = path.join(dom.wiki, `summaries/${base}-${hashB}.md`);
    ok(existsSync(bFile), 'a DIFFERENT source with the same slug gets its own summary (<slug>-<hash6>)');
    eq(readFileSync(aFile, 'utf8'), aBytes, 'the first source\'s summary is untouched');
    ok(rB.warnings.some(w => w.includes('keeping both') && w.includes(`summaries/${base}-${hashB}.md`)), 'a warning names both and says "keeping both" (the For review trigger)');

    const { value: rA2 } = await quiet(() => ingestFile(dom.name, sourceFile(A, SHORT), A, true, null, { llm: single(A) }));
    eq(readdirSync(path.join(dom.wiki, 'summaries')).length, 2, 'SAME-source re-ingest of A merges into its summary — no third file');
    ok(!rA2.warnings.some(w => w.includes('keeping both')), '…with no collision warning');
    await quiet(() => ingestFile(dom.name, sourceFile(B, SHORT), B, true, null, { llm: single(B) }));
    eq(readdirSync(path.join(dom.wiki, 'summaries')).length, 2, 're-ingest of B finds its OWN hashed summary again (stable suffix)');

    // A title in source: is not evidence of a different source.
    const dom2 = makeDomain({ 'summaries/report.md': '---\ntype: summary\nsource: Annual Report — Final Draft\n---\n# Report\n\n## Key Takeaways\n- old\n' });
    const { value: rT } = await quiet(() => ingestFile(dom2.name, sourceFile('report.md', SHORT), 'report.md', false, null, { llm: single('report.md') }));
    eq(readdirSync(path.join(dom2.wiki, 'summaries')).join(','), 'report.md', 'a summary whose source: is a TITLE still merges (no split on a false collision)');
    ok(!rT.warnings.some(w => w.includes('keeping both')), '…and no collision warning');

    // Extension-only difference: report.txt vs report.md recorded.
    const dom3 = makeDomain({ 'summaries/report.md': '---\ntype: summary\nsource: report.txt\n---\n# Report\n\n## Key Takeaways\n- old\n' });
    await quiet(() => ingestFile(dom3.name, sourceFile('report.md', SHORT), 'report.md', false, null, { llm: single('report.md') }));
    eq(readdirSync(path.join(dom3.wiki, 'summaries')).length, 2, 'report.md does not merge into report.txt\'s summary');

    // Manifest evidence beats frontmatter: a record for THIS file → merge.
    const dom4 = makeDomain({ 'summaries/report.md': '---\ntype: summary\nsource: report.txt\n---\n# Report\n\n## Key Takeaways\n- old\n' });
    await appendManifestRecord(dom4.name, { filename: 'report.md', summaryPath: 'summaries/report.md', ingestedAt: '2026-01-01T00:00:00Z' });
    await quiet(() => ingestFile(dom4.name, sourceFile('report.md', SHORT), 'report.md', true, null, { llm: single('report.md') }));
    eq(readdirSync(path.join(dom4.wiki, 'summaries')).length, 1, 'a manifest record of THIS file at that summary → same source, merges');
    // …and a record for ANOTHER file with no source: in frontmatter → split.
    const dom5 = makeDomain({ 'summaries/report.md': '# Report\n\n## Key Takeaways\n- old\n' });
    await appendManifestRecord(dom5.name, { filename: 'report.docx', summaryPath: 'summaries/report.md', ingestedAt: '2026-01-01T00:00:00Z' });
    await quiet(() => ingestFile(dom5.name, sourceFile('report.md', SHORT), 'report.md', false, null, { llm: single('report.md') }));
    eq(readdirSync(path.join(dom5.wiki, 'summaries')).length, 2, 'a manifest record of ANOTHER file → kept apart');

    // All-non-Latin names both slug to "untitled".
    const dom6 = makeDomain();
    await quiet(() => ingestFile(dom6.name, sourceFile('日本語.md', SHORT), '日本語.md', false, null, { llm: single('日本語.md') }));
    await quiet(() => ingestFile(dom6.name, sourceFile('中文.md', SHORT), '中文.md', false, null, { llm: single('中文.md') }));
    const names6 = readdirSync(path.join(dom6.wiki, 'summaries')).sort();
    eq(names6.length, 2, 'two all-non-Latin sources keep two summaries');
    ok(names6.includes('untitled.md') && names6.some(n => /^untitled-[0-9a-f]{6}\.md$/.test(n)), '…untitled.md and untitled-<hash6>.md');
  }
} catch (err) {
  failed++;
  console.log(`  ✗ suite crashed: ${err && err.stack || err}`);
} finally {
  rmSync(TMP_ROOT, { recursive: true, force: true });
}

console.log(`\nPassed: ${passed}   Failed: ${failed}`);
if (failed) process.exit(1);
console.log('✅ All v3.84.0 batch-filter / summary-shape / slug-collision assertions green');
