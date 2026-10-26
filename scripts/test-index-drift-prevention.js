#!/usr/bin/env node
/**
 * test-index-drift-prevention.js — v3.83.0 (CONTRACT §4.3–4.4, §7 P1).
 *
 * THE DEFECT. Every write path added index rows only for pages it CREATED
 * (`status === 'created'`), matched the existing index by BASENAME, and merged
 * into a copy of index.md read at the START of the run. So a page whose index
 * write was ever lost — or one a redirect merged into an existing file, or one
 * appended locally then lost to Personal Sync's `-X theirs` — never got its row
 * back, and on a 3,500-page domain 2,705 pages had none.
 *
 * WHAT IS PINNED, through the REAL write paths, offline and free:
 *   §1 ingestFile (the documented `opts.llm` seam): a CREATED, an UPDATED and an
 *      UNCHANGED page missing from index.md all gain rows; an identical second
 *      run writes no index change; a row another writer appends to index.md
 *      WHILE the ingest runs survives (index.md is re-read at merge time).
 *   §2 compileConversation (`opts.generateText`): an updated page missing from
 *      the index gains its row.
 *   §3 the MCP's compile_to_wiki (real handler, local storage): an updated page
 *      missing from the index gains a row; descriptions skip `## ` headings
 *      (the "Overview ARIA is…" rows); the private duplicate merge is gone.
 *   §4 a read-only mirror: refused upstream, its index.md byte-identical.
 *   §5 no LLM is called for index work: the fake provider sees exactly one call
 *      per ingest/compile (the content call), never an index call.
 *
 * Isolation: CURATOR_TEST_USER_DATA_DIR / CURATOR_TEST_DOMAINS_DIR in a tmp
 * dir set BEFORE any src/brain import, plus __setDomainsDirOverride. Never
 * touches the real domains/. Fixtures are synthetic.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let passed = 0, failed = 0;
const failures = [];
function ok(cond, label, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; failures.push(label); console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`); }
}
const sha = (s) => createHash('sha256').update(s).digest('hex');
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'curator-index-drift-'));
const USER_DATA = path.join(TMP_ROOT, 'userdata');
const DOMAINS = path.join(TMP_ROOT, 'domains');
mkdirSync(USER_DATA, { recursive: true });
mkdirSync(DOMAINS, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DATA;
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS;
process.env.CURATOR_TEST_INSTANCE_DIR = path.join(TMP_ROOT, 'instances');

const realWarn = console.warn, realErr = console.error, realLog = console.log;
const quiet = () => { console.warn = () => {}; console.error = () => {}; };
const loud = () => { console.warn = realWarn; console.error = realErr; };

function mkDomain(name, files, schema = '# Domain: Drift Test\n') {
  const dd = path.join(DOMAINS, name);
  for (const d of ['wiki/entities', 'wiki/concepts', 'wiki/summaries', 'raw']) mkdirSync(path.join(dd, d), { recursive: true });
  writeFileSync(path.join(dd, 'CLAUDE.md'), schema, 'utf8');
  writeFileSync(path.join(dd, 'wiki', 'log.md'), '# Log\n\n', 'utf8');
  for (const [rel, body] of Object.entries(files)) writeFileSync(path.join(dd, 'wiki', rel), body, 'utf8');
  return {
    dir: dd,
    wiki: path.join(dd, 'wiki'),
    read: (rel) => readFileSync(path.join(dd, 'wiki', rel), 'utf8'),
    write: (rel, body) => writeFileSync(path.join(dd, 'wiki', rel), body, 'utf8'),
  };
}
/** Page rows by link target — a plain regex, independent of the parser. */
function rowTargets(indexText) {
  const out = [];
  for (const m of indexText.matchAll(/^\|\s*\[\[([^\]|#]+)[^\]]*\]\]\s*\|/gm)) out.push(m[1].trim());
  return out;
}

try {
  const { ingestFile } = await import('../src/brain/ingest.js');
  const { compileConversation } = await import('../src/brain/compile.js');
  const { __setDomainsDirOverride } = await import('../src/brain/config.js');
  const files = await import('../src/brain/files.js');
  __setDomainsDirOverride(DOMAINS);

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n§1  ingestFile — every touched page missing from index.md gains a row');
  {
    const D = 'drift-ingest';
    const d = mkDomain(D, {
      'entities/known.md': '---\ntype: entity\ntags: [type/entity]\n---\n# Known\n\n## Key Facts\n- already indexed\n',
      'entities/lost-row.md': '---\ntype: entity\ntags: [type/entity]\n---\n# Lost Row\n\n## Key Facts\n- an old fact\n',
      'index.md': '# Wiki Index — Drift Test\nLast updated: 2025-01-01\n\n| Page | Type | Summary |\n|---|---|---|\n| [[known]] | entity | Already here, kept as written |\n',
    });
    const src = path.join(TMP_ROOT, 'note.md');
    writeFileSync(src, 'A short note about the Lost Row and the Fresh Page and Known. '.repeat(20), 'utf8');

    let calls = 0;
    let appendForeign = true;
    const llm = async (schema, prompt, maxTokens, format, onWait, opts) => {
      calls++;
      if (opts && typeof opts.onUsage === 'function') opts.onUsage({ inputTokens: 10, outputTokens: 5, provider: 'fake', model: 'fake-1' });
      // ANOTHER WRITER appends a row to index.md while this ingest runs —
      // after ingestFile read index.md for its prompt, before it merges.
      if (appendForeign) appendFileSync(path.join(d.wiki, 'index.md'), '| [[foreign-row]] | concept | written by another tool mid-ingest |\n');
      return JSON.stringify({
        title: 'Drift Note',
        pages: [
          { path: 'summaries/note.md', content: '# Drift Note\n\nTags: test\n\n## Summary\nA note.\n', summary: 'The drift note' },
          { path: 'entities/lost-row.md', content: '# Lost Row\n\nTags: test\n\n## Key Facts\n- a NEW fact\n', summary: 'Lost Row, updated' },
          { path: 'entities/fresh-page.md', content: '# Fresh Page\n\nTags: test\n\n## Key Facts\n- brand new\n', summary: 'A fresh page' },
          { path: 'entities/known.md', content: '# Known\n\nTags: test\n\n## Key Facts\n- already indexed\n', summary: 'Should NOT replace the kept description' },
        ],
      });
    };

    quiet();
    let r1 = null, thrown = null;
    try { r1 = await ingestFile(D, src, 'note.md', false, null, { llm }); } catch (e) { thrown = e; } finally { loud(); }
    ok(!thrown && r1, 'the first ingest completed under the fake provider', thrown && thrown.message);
    const statusOf = (res, p) => (res && res.changes || []).find((c) => c.canonPath === p)?.status;
    ok(statusOf(r1, 'entities/lost-row.md') === 'updated' && statusOf(r1, 'entities/fresh-page.md') === 'created',
      'PRECONDITION — lost-row.md was UPDATED and fresh-page.md CREATED by this ingest',
      JSON.stringify((r1 && r1.changes || []).map((c) => [c.canonPath, c.status])));
    const idx1 = d.read('index.md');
    const t1 = rowTargets(idx1);
    ok(t1.includes('lost-row'), '★ an UPDATED page missing from index.md gains a row (was: only created pages)', idx1);
    ok(t1.includes('fresh-page'), 'a CREATED page gains a row');
    ok(t1.includes('summaries/note'), 'the summary gains a [[summaries/…]] row');
    ok(t1.includes('foreign-row'), '★ FRESH RE-READ — a row another writer appended DURING the ingest survives the merge', idx1);
    ok(idx1.includes('| [[known]] | entity | Already here, kept as written |'),
      'an existing row is never edited (its description is kept as written)');
    ok(t1.filter((t) => t === 'known').length === 1, '…and never duplicated');
    ok(idx1.includes('| [[lost-row]] | entity | Lost Row, updated |'), 'the new row carries the model\'s one-line summary');
    ok(calls === 1, 'no LLM call for index work — the provider saw exactly the one content call', `calls=${calls}`);
    const indexChange1 = (r1.changes || []).find((c) => c.canonPath === 'index.md');
    ok(indexChange1 && indexChange1.status === 'updated', 'the index write is reported as a change record');

    // An identical second run: nothing missing → no index write at all.
    appendForeign = false;
    const before2 = d.read('index.md');
    quiet();
    let r2 = null;
    try { r2 = await ingestFile(D, src, 'note.md', true, null, { llm }); } finally { loud(); }
    const idxChange2 = (r2 && r2.changes || []).find((c) => c.canonPath === 'index.md');
    ok(r2 && (!idxChange2 || idxChange2.status === 'unchanged'),
      'IDEMPOTENT — an identical second ingest reports no index change', JSON.stringify(idxChange2));
    ok(d.read('index.md') === before2, '…and index.md is byte-identical');

    // UNCHANGED + missing: the row is lost after the fact (a lost write, a
    // `-X theirs` pull); an identical re-ingest — every page `unchanged` — heals it.
    d.write('index.md', before2.split('\n').filter((l) => !l.startsWith('| [[fresh-page]]')).join('\n'));
    ok(!rowTargets(d.read('index.md')).includes('fresh-page'), 'PRECONDITION — fresh-page\'s row is gone from index.md');
    quiet();
    let r3 = null;
    try { r3 = await ingestFile(D, src, 'note.md', true, null, { llm }); } finally { loud(); }
    ok(statusOf(r3, 'entities/fresh-page.md') === 'unchanged',
      'PRECONDITION — this re-ingest left fresh-page.md UNCHANGED', JSON.stringify((r3 && r3.changes || []).map((c) => [c.canonPath, c.status])));
    ok(rowTargets(d.read('index.md')).includes('fresh-page'), '★ an UNCHANGED page missing from index.md gains its row back');
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n§2  compileConversation — an updated page missing from index.md gains a row');
  {
    const D = 'drift-compile';
    const d = mkDomain(D, {
      'concepts/old-idea.md': '---\ntype: concept\ntags: [type/concept]\n---\n# Old Idea\n\n## Key Ideas\n- first\n',
      'index.md': '# Wiki Index — Drift Test\nLast updated: 2025-01-01\n\n| Page | Type | Summary |\n|---|---|---|\n',
    });
    const convId = '00000000-0000-4000-8000-000000383001';
    await files.writeConversation(D, {
      id: convId, title: 'Drift compile', createdAt: '2026-09-01T00:00:00.000Z', domain: D,
      messages: [
        { role: 'user', content: 'Tell me about the old idea.' },
        { role: 'assistant', content: 'The old idea has a second key idea.' },
      ],
    });
    let calls = 0;
    const generateText = async () => {
      calls++;
      return JSON.stringify({
        title: 'Drift compile',
        pages: [
          { path: 'summaries/placeholder.md', content: '# Drift compile\n\nTags: test\n\n## Summary\n- one bullet\n', summary: 'Compiled drift chat' },
          { path: 'concepts/old-idea.md', content: '# Old Idea\n\nTags: test\n\n## Key Ideas\n- second\n', summary: 'The old idea, extended' },
        ],
      });
    };
    quiet();
    let res = null;
    try { res = await compileConversation(D, convId, () => {}, { generateText }); } finally { loud(); }
    ok(res && res.ok, 'the compile completed under the fake provider', res && (res.error || res.reason));
    const st = (res && res.changes || []).find((c) => c.canonPath === 'concepts/old-idea.md')?.status;
    ok(st === 'updated', 'PRECONDITION — old-idea.md was UPDATED, not created', st);
    const t = rowTargets(d.read('index.md'));
    ok(t.includes('old-idea'), '★ the UPDATED page gains a row (was: only created pages)', d.read('index.md'));
    ok(t.some((x) => x.startsWith('summaries/drift-compile-')), 'the compile summary gains a row');
    ok(calls === 1, 'no LLM call for index work in compile', `calls=${calls}`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n§3  MCP compile_to_wiki — the shared helper, real handler, local storage');
  {
    const { createStorageAdapter } = await import('../mcp/storage/local.js');
    const { compileToWikiHandler } = await import('../mcp/tools/compile.js');
    const storage = createStorageAdapter({ domainsPath: DOMAINS });
    const D = 'drift-mcp';
    const d = mkDomain(D, {
      'entities/aria.md': '---\ntype: entity\ntags: [type/entity]\n---\n# ARIA\n\n## Key Facts\n- an old fact\n',
      'index.md': '# Wiki Index — Drift Test\nLast updated: 2025-01-01\n\n| Page | Type | Summary |\n|---|---|---|\n',
    });
    quiet();
    let res = null;
    try {
      res = await compileToWikiHandler({
        domain: D,
        title: 'ARIA findings',
        summary_content: '# ARIA findings\n\n## Summary\nNotes on [[aria]] and [[world-model]].\n',
        additional_pages: [
          { path: 'entities/aria.md', content: '# ARIA\n\n## Overview\nARIA is a research agency.\n\n## Key Facts\n- a NEW fact\n' },
          { path: 'concepts/world-model.md', content: '# World Model\n\n## Definition\nA world model predicts what happens next.\n' },
        ],
      }, storage);
    } finally { loud(); }
    ok(res && res.ok, 'compile_to_wiki reported ok', res && res.error);
    const st = (res && res.changes || []).find((c) => c.canonPath === 'entities/aria.md')?.status;
    ok(st === 'updated', 'PRECONDITION — aria.md was UPDATED by the call', st);
    const idx = d.read('index.md');
    ok(rowTargets(idx).includes('aria'), '★ the UPDATED page gains a row (the private created-only duplicate is gone)', idx);
    const ariaRow = idx.split('\n').find((l) => l.startsWith('| [[aria]]')) || '';
    ok(ariaRow.includes('ARIA is a research agency.') && !/Overview/.test(ariaRow),
      '★ the description is the first BODY sentence — never a `## ` heading ("Overview ARIA is…")', ariaRow);
    const wmRow = idx.split('\n').find((l) => l.startsWith('| [[world-model]]')) || '';
    ok(wmRow.includes('A world model predicts what happens next.') && !/Definition/.test(wmRow), 'the same for a created concept', wmRow);
    ok(rowTargets(idx).some((x) => x.startsWith('summaries/aria-findings-')), 'the summary gains a row');
    ok(res && Array.isArray(res.changes) && res.changes.some((c) => c.canonPath === 'index.md'), 'the index write appears in the reply\'s changes');
    // Dumb cross-check the contract asks for: no second implementation.
    const mcpSrc = readFileSync(path.join(REPO, 'mcp/tools/compile.js'), 'utf8');
    ok(!/function\s+mergeIntoIndex\b/.test(mcpSrc), 'mcp/tools/compile.js no longer carries its own mergeIntoIndex');

    // §4 — a read-only mirror is refused upstream; its index is untouched.
    console.log('\n§4  a read-only mirror — refused before any write, index.md byte-identical');
    const M = 'shared-drift';
    const m = mkDomain(M, {
      'entities/x.md': '# X\n\n- a fact\n',
      'index.md': '# Wiki Index — Mirror\n',
    }, '---\nreadonly: true\n---\n# Domain: Mirror\n');
    const beforeSha = sha(m.read('index.md'));
    quiet();
    let mres = null;
    try {
      mres = await compileToWikiHandler({
        domain: M, title: 'Should not land', summary_content: '# Should not land\n\nNothing.\n',
      }, storage);
    } finally { loud(); }
    ok(mres && mres.ok === false, 'compile_to_wiki refuses the mirror', JSON.stringify(mres).slice(0, 200));
    ok(sha(m.read('index.md')) === beforeSha, 'the mirror\'s index.md is byte-identical (no row added)');
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n§5  ensurePagesInIndex directly — idempotent, never removes, unlinkable names skipped');
  {
    const { ensurePagesInIndex } = await import('../src/brain/wiki-index.js');
    const D = 'drift-direct';
    const d = mkDomain(D, {
      'entities/a-page.md': '# A Page\n\nA page about a.\n',
      'entities/ leading-space.md': '# Leading\n\nUnlinkable.\n',
      'index.md': '# Wiki Index — Drift Test\nLast updated: 2025-01-01\n\n| Page | Type | Summary |\n|---|---|---|\n| [[gone]] | entity | stale row stays (only Health rebuilds) |\n',
    });
    const entries = [{ canonPath: 'entities/a-page.md', description: null }, { canonPath: 'entities/ leading-space.md', description: null }];
    const rec1 = await ensurePagesInIndex(D, entries, { today: '2026-03-03' });
    const after1 = d.read('index.md');
    ok(rec1 && rowTargets(after1).includes('a-page'), 'a missing page gets a row, its description derived from the page', after1);
    ok(after1.includes('| [[a-page]] | entity | A page about a. |'), '…the description is the first body sentence');
    ok(after1.includes('[[gone]]'), 'a stale row is never removed by drift prevention (only the Health rebuild removes)');
    ok(!after1.includes('leading-space'), 'an unlinkable file name (leading space) is never written as a row');
    ok(/^Last updated: 2026-03-03$/m.test(after1), 'Last updated moves only because a row was added');
    const rec2 = await ensurePagesInIndex(D, entries, { today: '2026-04-04' });
    ok(rec2 === null && d.read('index.md') === after1, 'IDEMPOTENT — a second call returns null and writes nothing (date untouched)');
  }
} finally {
  loud();
  try {
    const { __setDomainsDirOverride } = await import('../src/brain/config.js');
    __setDomainsDirOverride(null);
  } catch { /* best-effort */ }
  rmSync(TMP_ROOT, { recursive: true, force: true });
}

console.log(`\nPassed: ${passed}   Failed: ${failed}`);
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
