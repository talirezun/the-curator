#!/usr/bin/env node
/**
 * test-next-summary-link-view.js — OFFLINE suite, zero dependencies, DOM-free.
 *
 * v3.84.0 — the Health view's `summaryLinkSections` category, and the places
 * that must know the type. Real functions are LIFTED and EXECUTED:
 *   §1 HEALTH_CATEGORIES carries it and AUTO_FIX_TYPES includes it; countSafeFixable
 *      counts it (dumb cross-check by hand).
 *   §2 the issue row: path in the mono column, counts in prose, zero parts omitted,
 *      singular/plural, escaped, never a Dismiss button.
 *   §3 the group offers "Fix all N" (not read-only) and the confirm names the type.
 *   §4 the ingest "For review" classifier takes the summary-layout and collision warnings.
 *   §5 the queue's end-of-batch counts and label list carry the type; the MCP trim list too.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { stripComments, functionSource } from './test-helpers/source-scan.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rd = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const js = stripComments(rd('src/public/next/views/domains.js'));
const ingestJs = stripComments(rd('src/public/next/views/ingest.js'));

let passed = 0, failed = 0;
const ok = (c, l) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failed++; console.log(`  ✗ ${l}`); } };
const eq = (a, b, l) => { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, s ? l : `${l}\n   expected ${JSON.stringify(b)}\n   actual   ${JSON.stringify(a)}`); };
const section = (t) => console.log(`\n${t}`);

function constLiteral(src, name) {
  const m = new RegExp(`const\\s+${name}\\s*=\\s*`).exec(src);
  if (!m) return null;
  const start = m.index + m[0].length;
  if (src.startsWith('new Set(', start)) {
    const open = start + 'new Set'.length; let d = 0;
    for (let i = open; i < src.length; i++) { if (src[i] === '(') d++; else if (src[i] === ')') { d--; if (!d) return src.slice(start, i + 1); } }
  }
  let d = 0;
  for (let i = start; i < src.length; i++) { if (src[i] === '[') d++; else if (src[i] === ']') { d--; if (!d) return src.slice(start, i + 1); } }
  return null;
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const FUNCS = ['pluralize', 'countSafeFixable', 'renderIssueRow', 'confirmFixAllOfType', 'renderIssueGroup'];
const src = {};
for (const f of FUNCS) { src[f] = functionSource(js, f); ok(src[f] !== null, `${f} extracted`); }
const HC = constLiteral(js, 'HEALTH_CATEGORIES'), AF = constLiteral(js, 'AUTO_FIX_TYPES'), DT = constLiteral(js, 'DESTRUCTIVE_FIX_TYPES');
ok(HC && AF && DT, 'module constants located');

function build() {
  const state = { expandedGroups: new Set(), busyKey: null, confirm: null, health: null, dismissedRecords: null };
  const body = `const HEALTH_CATEGORIES=${HC};const AUTO_FIX_TYPES=${AF};const DESTRUCTIVE_FIX_TYPES=${DT};
    ${FUNCS.map((f) => src[f]).join('\n')}
    return { HEALTH_CATEGORIES, AUTO_FIX_TYPES, ${FUNCS.join(', ')} };`;
  const api = new Function('state', 'escapeHtml', 'icon', 'render', 'myMountToken', 'GIT_UNDO_NOTE', 'GIT_UNDO_WARN', 'deletedPageCount', 'isCurrentMount',
    body)(state, esc, () => '<svg/>', () => {}, 1, 'NOTE', 'WARN', () => 0, () => true);
  return { api, state };
}
const ROW = { summary: 'summaries/foo.md', duplicateLines: 12, conceptsToMove: 40, entitiesToMove: 3, sampleConcepts: ['rag'], sampleEntities: [] };

section('§1 category, safe-fix totals');
{
  const { api } = build();
  ok(api.HEALTH_CATEGORIES.some((c) => c.key === 'summaryLinkSections' && c.label === 'Summary link lists'), 'category "Summary link lists"');
  ok(api.AUTO_FIX_TYPES.has('summaryLinkSections'), 'auto-fixable');
  const rep = { brokenLinks: [{ suggestedTarget: 'a' }], crossFolderDupes: [{}], missingBacklinks: [{}, {}], summaryLinkSections: [ROW, ROW, ROW] };
  eq(api.countSafeFixable(rep), 1 + 1 + 2 + 3, 'countSafeFixable adds one per summary (hand formula)');
  eq(api.countSafeFixable({ ...rep, summaryLinkSections: undefined }), 4, 'absent field (older server) counts 0');
  eq(api.countSafeFixable({ ...rep, summaryLinkSections: 'x' }), 4, 'non-array counts 0');
}

section('§2 issue row');
{
  const { api } = build();
  const row = api.renderIssueRow('summaryLinkSections', ROW, false);
  ok(/<span class="mono dm-issue-main">summaries\/foo\.md<\/span>/.test(row), 'path alone in the mono column');
  ok(row.includes('12 repeated lines · 40 concepts filed under Entities · 3 entities filed under Concepts — tidied without removing any link.'), 'counts in prose in the meta column');
  ok(!/dm-dismiss-btn/.test(row) && !/dm-dismiss-btn/.test(api.renderIssueRow('summaryLinkSections', ROW, true)), 'never a Dismiss button');
  const one = api.renderIssueRow('summaryLinkSections', { summary: 'summaries/a.md', duplicateLines: 1, conceptsToMove: 0, entitiesToMove: 1 }, false);
  ok(one.includes('1 repeated line · 1 entity filed under Concepts —') && !one.includes('concept filed'), 'singular forms, zero parts omitted');
  const big = api.renderIssueRow('summaryLinkSections', { summary: 's', duplicateLines: 0, conceptsToMove: 1234, entitiesToMove: 0 }, false);
  ok(big.includes('1,234 concepts filed under Entities'), 'thousands separators');
  const hostile = api.renderIssueRow('summaryLinkSections', { summary: '<img onerror=x>', duplicateLines: '<b>', conceptsToMove: 2 }, false);
  ok(!/<img|<b>/.test(hostile), 'hostile fields are escaped / numeric-coerced');
}

section('§3 group + confirm');
{
  const { api, state } = build();
  state.health = { summaryLinkSections: [ROW, ROW] };
  const cat = api.HEALTH_CATEGORIES.find((c) => c.key === 'summaryLinkSections');
  const html = api.renderIssueGroup(cat, [ROW, ROW], false, false);
  ok(/data-fixall="summaryLinkSections"/.test(html) && html.includes('Fix all 2'), 'category "Fix all 2" present');
  ok(!/data-fixall/.test(api.renderIssueGroup(cat, [ROW, ROW], true, false)), 'no Fix all on a read-only mirror');
  api.confirmFixAllOfType('d', 'summaryLinkSections');
  ok(state.confirm && state.confirm.title === 'Fix all 2 summary link lists?' && state.confirm.confirmLabel === 'Fix now', 'confirm names the type, plain "Fix now"');
  ok(/No AI tokens/.test(state.confirm.body), 'confirm says no AI tokens');
}

section('§4 ingest "For review" classifier');
{
  const fn = functionSource(ingestJs, 'classifyIngestEntry');
  ok(!!fn, 'classifyIngestEntry extracted');
  const cls = new Function(`${fn}; return classifyIngestEntry;`)();
  const shape = 'The summary "summaries/x.md" is missing a source — the AI did not follow the summary layout. Open it in the Wiki tab; re-ingesting "x.pdf" usually fixes it.';
  eq(cls(shape).kind, 'review', 'summary-shape warning -> review');
  eq(cls('A page named "A" already exists for another source — keeping both: this source\'s summary was written').kind, 'review', 'slug-collision warning -> review');
  eq(cls('something unrelated').kind, 'info', 'control: unrelated stays info');
}

section('§5 queue counts, label list, MCP trim list');
{
  ok(/summaryLinkSections:\s*\(report\.summaryLinkSections \|\| \[\]\)\.length/.test(rd('src/brain/ingest-queue.js')), 'queue end-of-batch counts carry summaryLinkSections');
  const { formatHealthCounts } = await import(path.join(ROOT, 'src/public/next/shared/ingest-queue-logic.js'));
  eq(formatHealthCounts({ summaryLinkSections: 3, brokenLinks: 1 }), '1 broken links, 3 summary link lists', 'formatHealthCounts names it');
  ok(/'summaryLinkSections'/.test(rd('mcp/tools/index.js').split('trimmable')[1] || ''), 'MCP trimmable list carries summaryLinkSections');
}
console.log(`\nPassed: ${passed}   Failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
