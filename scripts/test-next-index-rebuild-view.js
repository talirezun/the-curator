#!/usr/bin/env node
/**
 * test-next-index-rebuild-view.js — OFFLINE suite, zero dependencies, DOM-free.
 *
 * v3.83.0 — the Health view's index rebuild (contract §3.5). The real
 * functions are LIFTED out of views/domains.js and EXECUTED against stubs:
 *
 *   §1 HEALTH_CATEGORIES carries `indexDrift` / "Index gaps"; AUTO_FIX_TYPES
 *      and countSafeFixable are untouched (a dumb cross-check against the
 *      pre-change formula); totalOpenIssues counts the row as 1.
 *   §2 Quick maintenance: "Rebuild index · 2,705 pages missing" only when the
 *      scan sent a row; free (no sparkles, no cost badge, not btn-ai).
 *   §3 The issue row: prose, the Preview action, no Dismiss.
 *   §4 The plan card: every number and the size change, the optional
 *      sentences only when > 0, NOTHING inside a <details>.
 *   §5 Apply: posts {basis} and nothing else to /index/apply; success banner;
 *      409 INDEX_PLAN_STALE → plan cleared + the server's sentence as an info
 *      banner; other errors; the write label rescans itself.
 *   §6 The plan runner: nothingToDo → info banner, no card.
 */

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { stripComments, functionSource } from './test-helpers/source-scan.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const raw = readFileSync(path.join(ROOT, 'src/public/next/views/domains.js'), 'utf8');
const js = stripComments(raw);

let passed = 0, failed = 0;
const ok = (cond, label) => { if (cond) { passed++; console.log(`  ✓ ${label}`); } else { failed++; console.log(`  ✗ ${label}`); } };
const eq = (a, b, label) => {
  const same = JSON.stringify(a) === JSON.stringify(b);
  ok(same, same ? label : `${label}\n      expected ${JSON.stringify(b)}\n      actual   ${JSON.stringify(a)}`);
};
const section = (t) => console.log(`\n${t}`);

// ── lift ───────────────────────────────────────────────────────────────────
function constLiteral(name) {
  const m = new RegExp(`const\\s+${name}\\s*=\\s*`).exec(js);
  if (!m) return null;
  const start = m.index + m[0].length;
  if (js[start] === "'") return js.slice(start, js.indexOf("';", start) + 1);
  if (js.startsWith('new Set(', start)) {
    const open = start + 'new Set'.length;
    let depth = 0;
    for (let i = open; i < js.length; i++) {
      if (js[i] === '(') depth++;
      else if (js[i] === ')') { depth--; if (depth === 0) return js.slice(start, i + 1); }
    }
    return null;
  }
  let depth = 0;
  for (let i = start; i < js.length; i++) {
    if (js[i] === '[') depth++;
    else if (js[i] === ']') { depth--; if (depth === 0) return js.slice(start, i + 1); }
  }
  return null;
}
const FUNCS = ['fetchJSON', 'pluralize', 'fmtInt', 'fmtKB', 'countOf', 'countSafeFixable', 'totalOpenIssues',
  'renderPendingPlan', 'renderQuickMaintenance', 'renderIssueRow', 'runIndexRebuildPlan',
  'applyIndexRebuildPlan', 'applyPendingPlan', 'onQuickAction'];
const sources = {};
for (const f of FUNCS) { sources[f] = functionSource(js, f); ok(sources[f] !== null, `${f} extracted from views/domains.js`); }
const HEALTH_CATEGORIES_SRC = constLiteral('HEALTH_CATEGORIES');
const AUTO_FIX_SRC = constLiteral('AUTO_FIX_TYPES');
const WRITES_SRC = constLiteral('WRITES_THAT_RESCAN_THEMSELVES');
const GIT_NOTE_SRC = constLiteral('GIT_UNDO_NOTE');
ok(HEALTH_CATEGORIES_SRC && AUTO_FIX_SRC && WRITES_SRC && GIT_NOTE_SRC, 'the four module constants located');

function build(fetchStub) {
  const calls = { fetch: [], renders: 0, loadHealth: 0, gates: [] };
  const state = { busyKey: null, banner: null, pendingPlan: null, estimates: {}, aiRunsOn: null, aiAvailable: true, aiSpent: null, health: null };
  const body = `
    const HEALTH_CATEGORIES = ${HEALTH_CATEGORIES_SRC};
    const AUTO_FIX_TYPES = ${AUTO_FIX_SRC};
    const WRITES_THAT_RESCAN_THEMSELVES = ${WRITES_SRC};
    const GIT_UNDO_NOTE = ${GIT_NOTE_SRC};
    ${FUNCS.map((f) => sources[f]).join('\n')}
    return { HEALTH_CATEGORIES, AUTO_FIX_TYPES, WRITES_THAT_RESCAN_THEMSELVES, GIT_UNDO_NOTE, ${FUNCS.join(', ')} };
  `;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const inFlight = new Set();
  const api = new Function(
    'state', 'escapeHtml', 'icon', 'buttonRingHtml', 'renderRunsOn', 'renderSpent', 'renderStatus', 'renderDescription',
    'quickAiButton', 'fetch', 'render', 'loadHealth', 'beginDomainWrite', 'inFlightWriteSlugs', 'isCurrentMount',
    'myMountToken', 'emptyPlanNotice', 'confirmFixSafe', 'confirmAiAction', 'GIT_UNDO_WARN',
    body
  )(
    state, esc, () => '<svg/>', () => '<i class="ring"></i>', () => '', () => '', (o) => '<div>' + o.title + '</div>', (t) => '<p>' + t + '</p>',
    (key, label) => `<button class="btn btn-ai btn-xs dm-quick-btn" data-action="${key}"><svg class="sparkles"></svg>${label}<span class="dm-quick-cost">$0.01</span></button>`,
    async (url, opts) => { calls.fetch.push({ url, opts }); return fetchStub(url, opts); },
    () => { calls.renders++; }, async () => { calls.loadHealth++; },
    (slug, label) => { calls.gates.push(label); return () => { calls.gates.push('release:' + label); }; },
    inFlight, () => true, 1, () => 'empty', () => {}, () => {}, 'WARN'
  );
  return { api, state, calls };
}
const okFetch = (status, bodyObj) => async () => ({ ok: status < 400, status, json: async () => bodyObj });

// ── fixtures ───────────────────────────────────────────────────────────────
const DRIFT = { missing: 2705, missingByFolder: { entities: 440, concepts: 2224, summaries: 41 }, stale: 39, duplicates: 0,
  repointable: 3, indexExists: true, indexBytes: 145844, sampleMissing: [], sampleStale: [] };
const SUMMARY = { indexExists: true, rowsBefore: 806, rowsAfter: 3472, bytesBefore: 145844, bytesAfter: 438120,
  add: 2705, addByFolder: { entities: 440, concepts: 2224, summaries: 41 }, removeStale: 39, mergeDuplicates: 0, repoint: 3,
  aliasesDropped: 0, typeCellsCorrected: 0, keepDescriptions: 764, deriveDescriptions: 2705, emptyDescriptions: 0,
  unlinkable: 0, unaddressable: 0, preservedProseLines: 4 };
const baseReport = (extra) => ({ brokenLinks: [], orphans: [], crossFolderDupes: [], hyphenVariants: [], folderPrefixLinks: [], missingBacklinks: [], ...extra });

/** Maximum <details> nesting depth in an HTML string. */
function detailsMax(html) {
  let depth = 0, max = 0;
  for (const m of html.matchAll(/<details\b|<\/details>/g)) { depth += m[0] === '</details>' ? -1 : 1; max = Math.max(max, depth); }
  return max;
}

// ── §1 ─────────────────────────────────────────────────────────────────────
section('§1 category, safe-fix totals, open-issue count');
{
  const { api } = build(okFetch(200, {}));
  const last = api.HEALTH_CATEGORIES[api.HEALTH_CATEGORIES.length - 1];
  eq(last, { key: 'indexDrift', label: 'Index gaps' }, 'HEALTH_CATEGORIES ends with indexDrift / "Index gaps"');
  ok(!api.AUTO_FIX_TYPES.has('indexDrift'), 'indexDrift is NOT auto-fixable');
  ok(api.WRITES_THAT_RESCAN_THEMSELVES.has('index-rebuild-apply'), "WRITES_THAT_RESCAN_THEMSELVES has 'index-rebuild-apply'");
  const rep = baseReport({
    brokenLinks: [{ suggestedTarget: 'a' }, {}], crossFolderDupes: [{}], hyphenVariants: [{}, {}], folderPrefixLinks: [{}], missingBacklinks: [{}],
    indexDrift: [DRIFT],
  });
  // dumb cross-check: the pre-change formula, written out by hand
  eq(api.countSafeFixable(rep), 1 + 1 + 2 + 1 + 1, 'countSafeFixable ignores indexDrift (equals the pre-change formula)');
  eq(api.totalOpenIssues(rep), 2 + 1 + 2 + 1 + 1 + 1, 'totalOpenIssues counts indexDrift as exactly 1');
  eq(api.totalOpenIssues({ ...rep, indexDrift: [] }), 2 + 1 + 2 + 1 + 1, 'and 0 when the scan sent []');
}

// ── §2 ─────────────────────────────────────────────────────────────────────
section('§2 Quick maintenance button');
{
  const { api, state } = build(okFetch(200, {}));
  const withRow = api.renderQuickMaintenance({ slug: 'x' }, baseReport({ indexDrift: [DRIFT] }), false);
  const m = /<button[^>]*data-action="indexPlan"[^>]*>[\s\S]*?<\/button>/.exec(withRow);
  ok(!!m, 'the button renders when the scan sent an indexDrift row');
  const btn = m ? m[0] : '';
  ok(/Rebuild index · 2,705 pages missing/.test(btn), 'label reads "Rebuild index · 2,705 pages missing"');
  ok(!/btn-ai/.test(btn) && !/sparkles/.test(btn) && !/dm-quick-cost/.test(btn), 'free: not btn-ai, no sparkles, no cost badge');
  ok(/btn btn-secondary btn-xs dm-quick-btn/.test(btn), 'the shared secondary quick-button chrome');
  const stale = api.renderQuickMaintenance({ slug: 'x' }, baseReport({ indexDrift: [{ ...DRIFT, missing: 0, stale: 1 }] }), false);
  ok(/Rebuild index · 1 stale row</.test(stale), 'stale-only: "Rebuild index · 1 stale row"');
  const none = api.renderQuickMaintenance({ slug: 'x' }, baseReport({ indexDrift: [] }), false);
  ok(!/indexPlan/.test(none), 'no button when indexDrift is [] (a read-only mirror sends [])');
  const noField = api.renderQuickMaintenance({ slug: 'x' }, baseReport({}), false);
  ok(!/indexPlan/.test(noField), 'no button when an older server sends no indexDrift field');
  state.busyKey = 'indexRebuildPlan';
  ok(/Planning…/.test(api.renderQuickMaintenance({ slug: 'x' }, baseReport({ indexDrift: [DRIFT] }), false)), 'busy: "Planning…"');
}

// ── §3 ─────────────────────────────────────────────────────────────────────
section('§3 issue row');
{
  const { api } = build(okFetch(200, {}));
  const row = api.renderIssueRow('indexDrift', DRIFT, false);
  ok(/<span class="mono dm-issue-main">index\.md<\/span>/.test(row), 'main cell is exactly the mono path index.md');
  ok(/<span class="dm-issue-meta">Missing 2,705 pages, and 39 rows point to pages that no longer exist\./.test(row), 'prose sits in the meta column (with stale)');
  const noStale = api.renderIssueRow('indexDrift', { ...DRIFT, stale: 0 }, false);
  ok(noStale.includes('Missing 2,705 pages. Rebuilt') && !/no longer/.test(noStale), 'row prose without stale');
  ok(row.includes('Rebuilt from the files on disk — free, previewed first.'), 'meta line');
  ok(/data-action="indexPlan"[^>]*>Preview rebuild</.test(row), '"Preview rebuild" action');
  ok(!/Dismiss|dm-dismiss-btn|data-dismiss/.test(row), 'no Dismiss control, even on a writable domain');
  ok(api.renderIssueRow('indexDrift', { ...DRIFT, missing: 1, stale: 1 }, false).includes('Missing 1 page, and 1 row points to a page that no longer exists.'), 'singular forms');
  const hostile = api.renderIssueRow('indexDrift', { missing: '<img onerror=x>', stale: 0 }, false);
  ok(!/<img/.test(hostile), 'a hostile field value never reaches the HTML');
}

// ── §4 ─────────────────────────────────────────────────────────────────────
section('§4 plan card');
{
  const { api, state } = build(okFetch(200, {}));
  state.pendingPlan = { kind: 'indexRebuild', basis: 'a'.repeat(64), summary: SUMMARY, samples: {} };
  const card = api.renderPendingPlan(false);
  ok(card.includes('Plan ready — nothing written yet'), 'title unchanged');
  ok(card.includes('2,705 pages will be added to the index, 39 rows that point to missing pages will be removed, and 764 existing descriptions are kept as written.'), 'summary sentence carries add / remove / keep');
  ok(card.includes('3 rows will be repointed to the page they name.'), 'repoint sentence when > 0');
  ok(!/duplicate row/.test(card), 'no merge sentence at 0');
  ok(card.includes('no AI, no cost') && card.includes('Summaries, Entities and Concepts'), 'detail: free, sorted');
  ok(card.includes('index.md grows from 146 KB to 438 KB.'), 'size change in KB');
  ok(card.includes(api.GIT_UNDO_NOTE), 'GIT_UNDO_NOTE is in the card');
  ok(!/cannot be linked/.test(card) && !/share a name/.test(card), 'unlinkable / unaddressable sentences absent at 0');
  ok(/Apply this plan/.test(card) && /Discard/.test(card), 'buttons unchanged');
  eq(detailsMax(card), 0, 'no <details> anywhere in the card');
  ok(!/<details/.test(sources.renderPendingPlan), "renderPendingPlan's source never opens a <details>");

  state.pendingPlan = { kind: 'indexRebuild', basis: 'b', samples: {}, summary: { ...SUMMARY, mergeDuplicates: 1, repoint: 0, unlinkable: 5, unaddressable: 2, bytesAfter: 100000 } };
  const warn = api.renderPendingPlan(false);
  ok(warn.includes('1 duplicate row will be merged.'), 'merge sentence (singular) when > 0');
  ok(warn.includes('5 pages have file names that cannot be linked (a leading or trailing space, or | [ ] #)'), 'unlinkable sentence when > 0');
  ok(warn.includes('2 concept pages share a name with an entity page') && warn.includes('fix Cross-folder duplicates first'), 'unaddressable sentence when > 0');
  ok(warn.includes('shrinks from 146 KB to 100 KB'), 'a smaller index says shrinks');
  eq(detailsMax(warn), 0, 'warnings are not inside a <details> either');
  state.pendingPlan = { kind: 'indexRebuild', basis: 'c', samples: {}, summary: { ...SUMMARY, indexExists: false, bytesBefore: 0 } };
  ok(api.renderPendingPlan(false).includes('index.md will be created at 438 KB.'), 'no index yet: "will be created"');
  state.pendingPlan = { kind: 'indexRebuild', basis: 'd', samples: {}, summary: { ...SUMMARY, add: 1, removeStale: 1, keepDescriptions: 1 } };
  ok(api.renderPendingPlan(false).includes('1 page will be added to the index, 1 row that points to a missing page will be removed, and 1 existing description is kept as written.'), 'singular summary');
}

// ── §4b ────────────────────────────────────────────────────────────────────
section('§4b plan card examples');
{
  const { api, state } = build(okFetch(200, {}));
  const add = Array.from({ length: 10 }, (_, i) => ({ path: `concepts/p${i}.md`, description: i === 0 ? '<b>x</b> & y' : `d${i}` }));
  const rm = Array.from({ length: 8 }, (_, i) => ({ target: i === 0 ? '[[gone0]]' : `gone${i}`, description: `r${i}` }));
  state.pendingPlan = { kind: 'indexRebuild', basis: 'a', summary: SUMMARY, samples: { add, removeStale: rm } };
  const card = api.renderPendingPlan(false);
  ok(card.includes('For example, added:') && card.includes('Removed (the page no longer exists):'), 'both group labels');
  ok(card.includes('<span class="mono">concepts/p0.md</span> — &lt;b&gt;x&lt;/b&gt; &amp; y'), 'an addition: mono path — escaped description');
  ok(card.includes('concepts/p4.md') && !card.includes('concepts/p5.md'), 'at most 5 additions');
  ok(card.includes('<span class="mono">[[gone0]]</span>') && card.includes('<span class="mono">[[gone4]]</span>') && !card.includes('gone5'), 'at most 5 removals, targets as [[wikilinks]]');
  // total = 2705 + 39; shown = 5 + 5
  ok(card.includes('…and 2,734 more'), '"…and N more" = (add - 5) + (remove - 5)');
  eq(detailsMax(card), 0, 'examples are not inside a <details>');
  state.pendingPlan = { kind: 'indexRebuild', basis: 'a', summary: SUMMARY, samples: { add: [], removeStale: [] } };
  const empty = api.renderPendingPlan(false);
  ok(!/For example|Removed \(|…and/.test(empty), 'empty samples: no groups, no "and N more"');
  state.pendingPlan = { kind: 'indexRebuild', basis: 'a', summary: { ...SUMMARY, add: 2, removeStale: 0 }, samples: { add: add.slice(0, 2), removeStale: [] } };
  const small = api.renderPendingPlan(false);
  ok(small.includes('For example, added:') && !small.includes('Removed (') && !small.includes('…and'), 'one group only; nothing hidden so no "and N more"');
}

// ── §5 ─────────────────────────────────────────────────────────────────────
section('§5 apply');
{
  const { api, state, calls } = build(okFetch(200, { ok: true, written: true, summary: SUMMARY }));
  state.pendingPlan = { kind: 'indexRebuild', basis: 'f'.repeat(64), summary: SUMMARY, samples: { add: [{ path: 'x' }] } };
  await api.applyPendingPlan('my domain');
  eq(calls.fetch.length, 1, 'exactly one request');
  eq(calls.fetch[0].url, '/api/health/my%20domain/index/apply', 'URL is /api/health/<slug>/index/apply');
  eq(calls.fetch[0].opts.method, 'POST', 'POST');
  eq(JSON.parse(calls.fetch[0].opts.body), { basis: 'f'.repeat(64) }, 'the body is {basis} and nothing else');
  eq(state.banner, { tone: 'success', text: 'Index rebuilt — added 2,705 pages and removed 39 stale rows. index.md is now 438 KB.' }, 'success banner');
  eq(state.pendingPlan, null, 'plan cleared');
  eq(calls.gates, ['index-rebuild-apply', 'release:index-rebuild-apply'], "write gate held under 'index-rebuild-apply' and released");
  eq(calls.loadHealth, 1, 'report reloaded');
  eq(state.busyKey, null, 'busy key reset');
}
{
  const stale = 'The wiki changed after this preview, so nothing was written. Preview the rebuild again.';
  const { api, state } = build(okFetch(409, { error: stale, code: 'INDEX_PLAN_STALE' }));
  state.pendingPlan = { kind: 'indexRebuild', basis: 'f', summary: SUMMARY, samples: {} };
  await api.applyPendingPlan('d');
  eq(state.pendingPlan, null, '409 INDEX_PLAN_STALE: plan discarded');
  eq(state.banner, { tone: 'info', text: stale }, '409 INDEX_PLAN_STALE: info banner carries the server sentence');
}
{
  const { api, state } = build(okFetch(500, { error: 'disk full' }));
  state.pendingPlan = { kind: 'indexRebuild', basis: 'f', summary: SUMMARY, samples: {} };
  await api.applyPendingPlan('d');
  eq(state.banner, { tone: 'error', text: 'Could not rebuild the index — disk full' }, 'other errors: error banner');
  eq(state.busyKey, null, 'busy key reset after an error');
}
{
  const { api, state } = build(okFetch(409, { error: 'locked', conflict: 'file_lock' }));
  state.pendingPlan = { kind: 'indexRebuild', basis: 'f', summary: SUMMARY, samples: {} };
  await api.applyPendingPlan('d');
  eq(state.banner.tone, 'error', 'a 409 that is not INDEX_PLAN_STALE is still an error');
}
{
  const src = sources.applyPendingPlan;
  const at = src.indexOf("p.kind === 'indexRebuild'");
  ok(at !== -1 && at < src.indexOf('pendingCount'), 'indexRebuild branch precedes the empty-plan guard (an index plan has no plan[])');
}

// ── §6 ─────────────────────────────────────────────────────────────────────
section('§6 plan runner');
{
  const { api, state, calls } = build(okFetch(200, { ok: true, nothingToDo: true, basis: 'z', summary: {}, samples: {} }));
  await api.onQuickAction('d', 'indexPlan');
  eq(calls.fetch[0].url, '/api/health/d/index/plan', 'POSTs /index/plan');
  eq(state.pendingPlan, null, 'nothingToDo: no card');
  eq(state.banner, { tone: 'info', text: 'index.md already lists every page.' }, 'nothingToDo: info banner');
}
{
  const { api, state } = build(okFetch(200, { ok: true, nothingToDo: false, basis: 'b'.repeat(64), summary: SUMMARY, samples: { add: [] } }));
  await api.onQuickAction('d', 'indexPlan');
  eq(state.pendingPlan && state.pendingPlan.kind, 'indexRebuild', 'a plan becomes a pendingPlan of kind indexRebuild');
  eq(state.pendingPlan && state.pendingPlan.basis, 'b'.repeat(64), 'with the server basis');
  eq(state.busyKey, null, 'busy key reset');
}
{
  const { api, state } = build(okFetch(409, { error: 'index.md is a symlink', code: 'INDEX_UNREADABLE' }));
  await api.onQuickAction('d', 'indexPlan');
  eq(state.banner, { tone: 'error', text: 'Could not preview the index rebuild — index.md is a symlink' }, 'INDEX_UNREADABLE surfaces as an error banner');
}

console.log(`\nPassed: ${passed}   Failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
