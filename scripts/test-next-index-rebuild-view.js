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
// v3.89.0: the fold items and action chips are the section kit's (real functions).
import { SECTION_KIT_NAMES, SECTION_KIT_VALUES } from './test-helpers/section-kit.js';

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
  'renderPendingPlan', 'renderFreeLane', 'renderPlainRow', 'renderIssueFold', 'renderLaneHead', 'renderLaneTrace', 'renderAnchorHere', 'renderShowMore', 'repairButton', 'freeRepairCount', 'n0', 'renderIssueRow', 'runIndexRebuildPlan',
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
  const state = { expandedGroups: new Set(), busyKey: null, banner: null, pendingPlan: null, estimates: {}, aiRunsOn: null, aiAvailable: true, aiSpent: null, health: null };
  const body = `
    const HEALTH_CATEGORIES = ${HEALTH_CATEGORIES_SRC};
    const AUTO_FIX_TYPES = ${AUTO_FIX_SRC};
    const WRITES_THAT_RESCAN_THEMSELVES = ${WRITES_SRC};
    const GIT_UNDO_NOTE = ${GIT_NOTE_SRC};
    const ISSUE_PAGE = 20;
    const renderAnchorStack = () => '';
    const FREE_ROWS = [];
    ${FUNCS.map((f) => sources[f]).join('\n')}
    return { HEALTH_CATEGORIES, AUTO_FIX_TYPES, WRITES_THAT_RESCAN_THEMSELVES, GIT_UNDO_NOTE, ${FUNCS.join(', ')} };
  `;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const inFlight = new Set();
  const api = new Function(
    'state', 'escapeHtml', 'icon', 'buttonRingHtml', 'renderRunsOn', 'renderSpent', 'renderStatus', 'renderDescription',
    'quickAiButton', 'fetch', 'render', 'loadHealth', 'beginDomainWrite', 'inFlightWriteSlugs', 'isCurrentMount',
    'myMountToken', 'emptyPlanNotice', 'confirmFixSafe', 'confirmAiAction', 'GIT_UNDO_WARN',
    ...SECTION_KIT_NAMES,
    body
  )(
    state, esc, () => '<svg/>', () => '<i class="ring"></i>', () => '', () => '', (o) => '<div>' + o.title + '</div>', (t) => '<p>' + t + '</p>',
    (key, label) => `<button class="btn btn-ai btn-xs dm-quick-btn" data-action="${key}"><svg class="sparkles"></svg>${label}<span class="dm-quick-cost">$0.01</span></button>`,
    async (url, opts) => { calls.fetch.push({ url, opts }); return fetchStub(url, opts); },
    () => { calls.renders++; }, async () => { calls.loadHealth++; },
    (slug, label) => { calls.gates.push(label); return () => { calls.gates.push('release:' + label); }; },
    inFlight, () => true, 1, () => 'empty', () => {}, () => {}, 'WARN', ...SECTION_KIT_VALUES
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
section('§2 The Free repairs row');
{
  const { api, state } = build(okFetch(200, {}));
  const free = (r) => api.renderFreeLane(r, false, false);
  const withRow = free(baseReport({ indexDrift: [DRIFT] }));
  const m = /<button[^>]*data-action="indexPlan"[^>]*>[\s\S]*?<\/button>/.exec(withRow);
  ok(!!m, 'the button renders when the scan sent an indexDrift row');
  const btn = m ? m[0] : '';
  ok(/Preview the rebuild/.test(btn), 'its label is the deck\'s');
  ok(/Pages missing from the page list/.test(withRow) && /2,705/.test(withRow), 'the row says what and how many');
  ok(!/btn-ai/.test(btn) && !/sparkles/.test(btn) && !/dm-quick-cost/.test(btn), 'free: not btn-ai, no sparkles, no cost badge');
  ok(/btn btn-secondary btn-xs cur-action-chip dm-quick-btn/.test(btn), 'the shared secondary chrome');
  const stale = free(baseReport({ indexDrift: [{ ...DRIFT, missing: 0, stale: 1 }] }));
  ok(/Rows in the page list with no page/.test(stale) && !/Pages missing/.test(stale) && />1</.test(stale), 'stale-only: the row says what it counts, and never "missing"');
  const none = free(baseReport({ indexDrift: [] }));
  ok(!/indexPlan/.test(none), 'no button when indexDrift is [] (a read-only mirror sends [])');
  const noField = free(baseReport({}));
  ok(!/indexPlan/.test(noField), 'no button when an older server sends no indexDrift field');
  ok(!/dm-dismiss-btn|data-dismiss/.test(withRow), 'no Leave as is on it, even on a writable domain: it is not dismissible');
  ok(!/indexPlan/.test(api.renderFreeLane(baseReport({ indexDrift: [DRIFT] }), true, false)), 'no action on a read-only mirror');
  state.busyKey = 'indexRebuildPlan';
  ok(/Working it out…/.test(free(baseReport({ indexDrift: [DRIFT] }))), 'busy: "Working it out…"');
}

// ── §4 ─────────────────────────────────────────────────────────────────────
section('§4 plan card');
{
  const { api, state } = build(okFetch(200, {}));
  state.pendingPlan = { kind: 'indexRebuild', basis: 'a'.repeat(64), summary: SUMMARY, samples: {} };
  const card = api.renderPendingPlan(false);
  ok(card.includes('Nothing is written yet.'), 'the title');
  ok(card.includes('2,705 pages join the page list and 39 rows that point to missing pages are removed. 764 descriptions stay as written.'), 'summary sentence');
  ok(card.includes('3 rows now point to the page they name.'), 'repoint sentence when > 0');
  ok(!/repeated row/.test(card), 'no merge sentence at 0');
  ok(card.includes('No AI, no cost') && card.includes('Summaries, Entities and Concepts'), 'detail: free, sorted');
  ok(card.includes('It grows from 146 KB to 438 KB.'), 'size change in KB');
  ok(card.includes(api.GIT_UNDO_NOTE), 'GIT_UNDO_NOTE is in the card');
  ok(!/cannot be linked/.test(card) && !/share a name/.test(card), 'unlinkable / unaddressable sentences absent at 0');
  ok(/Rebuild the list/.test(card) && /Cancel/.test(card), 'the buttons say what they do');
  eq(detailsMax(card), 0, 'no <details> anywhere in the card');
  ok(!/<details/.test(sources.renderPendingPlan), "renderPendingPlan's source never opens a <details>");

  state.pendingPlan = { kind: 'indexRebuild', basis: 'b', samples: {}, summary: { ...SUMMARY, mergeDuplicates: 1, repoint: 0, unlinkable: 5, unaddressable: 2, bytesAfter: 100000 } };
  const warn = api.renderPendingPlan(false);
  ok(warn.includes('1 repeated row becomes one.'), 'merge sentence (singular) when > 0');
  ok(warn.includes('5 pages have file names that cannot be linked (a leading or trailing space, or | [ ] #)'), 'unlinkable sentence when > 0');
  ok(warn.includes('2 concept pages share a name with an entity page') && warn.includes('Merge those first.'), 'unaddressable sentence when > 0');
  ok(warn.includes('It shrinks from 146 KB to 100 KB'), 'a smaller index says shrinks');
  eq(detailsMax(warn), 0, 'warnings are not inside a <details> either');
  state.pendingPlan = { kind: 'indexRebuild', basis: 'c', samples: {}, summary: { ...SUMMARY, indexExists: false, bytesBefore: 0 } };
  ok(api.renderPendingPlan(false).includes('It grows from 0 KB to 438 KB.'), 'no index yet: it grows from nothing');
  state.pendingPlan = { kind: 'indexRebuild', basis: 'd', samples: {}, summary: { ...SUMMARY, add: 1, removeStale: 1, keepDescriptions: 1 } };
  ok(api.renderPendingPlan(false).includes('1 page joins the page list and 1 row that points to a missing page is removed. 1 description stays as written.'), 'singular summary');
}

// ── §4b ────────────────────────────────────────────────────────────────────
section('§4b plan card examples');
{
  const { api, state } = build(okFetch(200, {}));
  const add = Array.from({ length: 10 }, (_, i) => ({ path: `concepts/p${i}.md`, description: i === 0 ? '<b>x</b> & y' : `d${i}` }));
  const rm = Array.from({ length: 8 }, (_, i) => ({ target: i === 0 ? '[[gone0]]' : `gone${i}`, description: `r${i}` }));
  state.pendingPlan = { kind: 'indexRebuild', basis: 'a', summary: SUMMARY, samples: { add, removeStale: rm } };
  const card = api.renderPendingPlan(false);
  ok(card.includes('For example, added:') && card.includes('Removed, because the page no longer exists:'), 'both group labels');
  ok(card.includes('<span class="mono">concepts/p0.md</span> <span class="dm-plan-data">&lt;b&gt;x&lt;/b&gt; &amp; y</span>'), 'an addition: mono path — escaped description');
  ok(card.includes('concepts/p4.md') && !card.includes('concepts/p5.md'), 'at most 5 additions');
  ok(card.includes('<span class="mono">[[gone0]]</span>') && card.includes('<span class="mono">[[gone4]]</span>') && !card.includes('gone5'), 'at most 5 removals, targets as [[wikilinks]]');
  // total = 2705 + 39; shown = 5 + 5
  ok(card.includes('And 2,734 more.'), '"And N more." = (add - 5) + (remove - 5)');
  eq(detailsMax(card), 0, 'examples are not inside a <details>');
  state.pendingPlan = { kind: 'indexRebuild', basis: 'a', summary: SUMMARY, samples: { add: [], removeStale: [] } };
  const empty = api.renderPendingPlan(false);
  ok(!/For example|Removed,|And \d/.test(empty), 'empty samples: no groups, no "And N more"');
  state.pendingPlan = { kind: 'indexRebuild', basis: 'a', summary: { ...SUMMARY, add: 2, removeStale: 0 }, samples: { add: add.slice(0, 2), removeStale: [] } };
  const small = api.renderPendingPlan(false);
  ok(small.includes('For example, added:') && !small.includes('Removed,') && !/And \d/.test(small), 'one group only; nothing hidden so no "and N more"');
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
  eq(state.rowNote, { tone: 'success', text: 'The page list was rebuilt. 2,705 pages added, 39 rows removed.' }, 'the outcome, in plain words');
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
  eq(state.rowNote, { tone: 'info', text: 'The wiki changed since this was worked out. Press Preview the rebuild again.' }, '409 INDEX_PLAN_STALE: says so, and what to press');
}
{
  const { api, state } = build(okFetch(500, { error: 'disk full' }));
  state.pendingPlan = { kind: 'indexRebuild', basis: 'f', summary: SUMMARY, samples: {} };
  await api.applyPendingPlan('d');
  eq(state.rowNote, { tone: 'error', text: 'Could not rebuild the list: disk full' }, 'other errors: a failure on the row');
  eq(state.busyKey, null, 'busy key reset after an error');
}
{
  const { api, state } = build(okFetch(409, { error: 'locked', conflict: 'file_lock' }));
  state.pendingPlan = { kind: 'indexRebuild', basis: 'f', summary: SUMMARY, samples: {} };
  await api.applyPendingPlan('d');
  eq(state.rowNote.tone, 'error', 'a 409 that is not INDEX_PLAN_STALE is still an error');
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
  eq(state.rowNote, { tone: 'info', text: 'The page list already has every page.' }, 'nothingToDo: says so');
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
  eq(state.rowNote, { tone: 'error', text: 'Could not rebuild the list: index.md is a symlink' }, 'INDEX_UNREADABLE surfaces as a failure on the row');
}

console.log(`\nPassed: ${passed}   Failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
