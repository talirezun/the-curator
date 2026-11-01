#!/usr/bin/env node
/**
 * ════════════════════════════════════════════════════════════════════════════
 *  test-next-mcp-tool-map.js — Settings → MCP bridge → block ③, the tool map.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ── WHAT THIS SUITE EXISTS TO STOP ─────────────────────────────────────────
 *
 * Four regressions, each of which would ship silently:
 *
 *   1. A TOOL DISAPPEARING FROM THE MAP. The map's whole claim is that it
 *      shows the WHOLE catalogue, used or not — "which of these has my agent
 *      never touched" is unanswerable if a group quietly drops rows.
 *   2. THE MARK AND THE WORD DISAGREEING. The dot's tier and the age phrase
 *      beside it are cut on `shared/age.js`'s single ladder precisely so a
 *      reading cannot say "today" in colour and "1 week ago" in words
 *      (v3.34.0's named class). A second threshold table anywhere reopens it.
 *   3. THE WORD "NEVER". A tool with no line in a ROTATED log has not never
 *      been used; the only true statement is "not used since this log began",
 *      with the log's own age beside it.
 *   4. A TIMER THAT RE-RENDERS. settings.js shipped a 1 s `render()` tick once
 *      and v3.53.1 records the cost: every ⓘ and every `<details>` on the page
 *      shut itself while the user was reading. The revalidate here may repaint
 *      ONE block body, only when the payload it paints has actually moved.
 *
 * ── EXECUTED, NOT SCANNED ──────────────────────────────────────────────────
 * Every assertion below runs the REAL functions lifted out of views/settings.js
 * (the `extractFunction` + `new Function` technique test-next-settings-
 * sections.js uses) against fixtures and a minimal fake DOM that RECORDS every
 * write. A source regex proving a line exists proves nothing about what it
 * does — CLAUDE.md records that as worse than no test.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────
 * The CATALOGUE itself (`mcp/tools/catalogue.js`) and the `GET /api/mcp/usage`
 * route are the server side's, and their own suite asserts that the names and
 * the `mutates` flags equal the real `tools` array and the real
 * `refuseIfReadonly` census. This file asserts what the VIEW does with the
 * envelope it is handed: 24 tools in, 24 tiles out, split 17/7.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { formatAge, freshnessTier } from '../src/public/next/shared/age.js';
import { renderReadout } from '../src/public/next/shared/text.js';
import { docsLinkHtml } from '../src/public/next/shared/docs-links.js';
import { explainerMark } from '../src/public/next/shared/explainer.js';
import { renderMonitor } from '../src/public/next/shared/monitor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SETTINGS_JS = path.join(ROOT, 'src/public/next/views/settings.js');
const SETTINGS_CSS = path.join(ROOT, 'src/public/next/views/settings.css');
const src = readFileSync(SETTINGS_JS, 'utf8');
const css = readFileSync(SETTINGS_CSS, 'utf8');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + msg); }
  else { failed++; console.log('  \x1b[31m✗\x1b[0m ' + msg); }
}
function section(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }

/** Brace-matched extraction — the same helper the sibling settings suites use.
 *  A lazy regex stops at the first `\n}` at column 0, which silently truncates
 *  any function containing one and turns every assertion below into a syntax
 *  error that names nothing. */
function extractFunction(source, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(', 'g');
  const m = re.exec(source);
  if (!m) throw new Error(`extractFunction: ${name} not found in views/settings.js`);
  const start = m.index;
  let i = source.indexOf('{', re.lastIndex);
  let depth = 0;
  for (; i < source.length; i++) {
    const c = source[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error(`extractFunction: unbalanced braces in ${name}`);
}

const RENDER_CHAIN = ['ageSecondsOf', 'usageWindowWords', 'footWindowWords', 'agentReading', 'tickedAgeHtml', 'sessionLine', 'lastExerciseRun',
  'renderExerciseOutcome', 'renderExerciseRunner',
  'renderToolMapBody', 'renderToolMap', 'usageSignature',
  // v3.72.1 (truth audit F9): the poll compares the save/session stamp to
  // decide whether block ④ is re-read on the same tick.
  'acrossProjectsStamp',
  'applyUsageVerdict', 'tickMcpAges'];

/**
 * Lift the real functions into one scope with the named collaborators injected.
 *
 * `over` replaces a collaborator BY NAME, so a typo is a silent no-op rather
 * than a new free identifier — the rule test-next-settings-sections.js §6
 * records.
 */
function build(extra, over, alsoReturn) {
  const deps = {
    state: over && over.state ? over.state : {},
    escapeHtml: (x) => String(x)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    icon: () => '<svg/>',
    // v3.71.1: the local infoMark/TX_INFO_GLYPH are gone; every ⓘ is the
    // REAL shared explainer kit (import-free, runs headless).
    explainerMark,
    docsLinkHtml,
    formatAge,
    freshnessTier,
    renderMonitor,
    gatedLoader: () => '<LOADER/>',
    loadGate: null,
    AGENT_USE_TOP: 5,
    document: undefined,
    Date,
    settingsBlock: null,
    // v3.61.0 — block ③'s run control. `refreshMcpUsage` RE-BINDS it after it
    // repaints the body (the repaint destroyed the button), so the harness
    // records the call rather than stubbing it away: §11 asserts the re-bind
    // happened, which is the one thing standing between the poll and a dead
    // button thirty seconds after a run.
    wireExerciseControl: () => {},
    TOOL_MAP_BODY_SEL: '.settings-block-mcp-tool-map .settings-block-body',
    // v3.72.1 — block ④'s re-read on a moved save stamp. Recorded, never
    // performed here: test-next-settings-truth.js §5 asserts when it fires.
    loadAcrossProjects: async () => {},
  };
  Object.assign(deps, over || {});
  const bodies = [extractFunction(src, 'settingsBlock')]
    .concat(RENDER_CHAIN.map((n) => extractFunction(src, n)))
    .concat(extra || []);
  // The two lifted-real helpers must not ALSO arrive as parameters: a `const`
  // and a parameter of one name is a SyntaxError, which is the loud failure we
  // want rather than a shadow.
  delete deps.settingsBlock;
  const names = Object.keys(deps);
  const fn = new Function(...names, bodies.join('\n') +
    '\nreturn {' + RENDER_CHAIN.concat(alsoReturn || []).join(', ') + '};');
  return fn(...names.map((n) => deps[n]));
}

// ── THE FIXTURE ────────────────────────────────────────────────────────────
//
// 24 tools, 17 read and 7 write — the shipped catalogue's shape as of v3.59.0
// (14 read + 10 in the write block by SOURCE grouping; 17 read + 7 write by
// CAPABILITY, which is what a user deciding what to let an agent do needs, and
// what the map groups on). Four used at DIFFERENT ages so the freshness ladder
// is exercised across bands, twenty never used, one with a refusal on it.
const NOW = Date.parse('2026-09-18T12:00:00.000Z');
const ago = (secs) => new Date(NOW - secs * 1000).toISOString();
const LOG_STARTED = ago(9 * 86400);          // "1 week ago"

const USED = [
  { name: 'get_project_context', group: 'read', mutates: false, purpose: 'Everything a new session must read first',
    lastUsedAt: ago(30), lastOk: true, count7d: 12, countTotal: 40, refusedTotal: 0 },
  { name: 'search_wiki', group: 'read', mutates: false, purpose: 'Full-text search across one domain',
    lastUsedAt: ago(45 * 60), lastOk: true, count7d: 88, countTotal: 310, refusedTotal: 0 },
  { name: 'save_working_state', group: 'write', mutates: true, purpose: 'Save this session’s handoff',
    lastUsedAt: ago(5 * 3600), lastOk: true, count7d: 9, countTotal: 22, refusedTotal: 0 },
  { name: 'compile_to_wiki', group: 'write', mutates: true, purpose: 'Turn findings into wiki pages',
    lastUsedAt: ago(3 * 86400), lastOk: false, count7d: 1, countTotal: 3, refusedTotal: 2 },
];
const UNUSED_READ = ['list_domains', 'get_index', 'get_graph_overview', 'get_tags',
  'search_cross_domain', 'get_node', 'get_connected_nodes', 'get_backlinks', 'get_summary',
  'get_raw_source', 'get_working_state', 'list_projects', 'scan_wiki_health',
  'scan_semantic_duplicates', 'get_health_dismissed']
  .map((name) => ({ name, group: 'read', mutates: false, purpose: 'A read tool',
    lastUsedAt: null, lastOk: null, count7d: 0, countTotal: 0, refusedTotal: 0 }));
const UNUSED_WRITE = ['fix_wiki_issue', 'dismiss_wiki_issue', 'undismiss_wiki_issue',
  'save_project_brief', 'save_foundation']
  .map((name) => ({ name, group: 'write', mutates: true, purpose: 'A write tool',
    lastUsedAt: null, lastOk: null, count7d: 0, countTotal: 0, refusedTotal: 0 }));

function payload(over) {
  return Object.assign({
    present: true,
    logStartedAt: LOG_STARTED,
    logBytes: 40960,
    tools: USED.concat(UNUSED_READ, UNUSED_WRITE),
    sessions: { lastBootstrapAt: ago(30), lastSaveAt: ago(5 * 3600) },
  }, over || {});
}

const FIXTURE = payload();
const MAP = build(null, { state: { mcpUsage: FIXTURE, mcpUsageError: null } });
const HTML = MAP.renderToolMapBody(NOW);

// ═══════════════════════════════════════════════════════════════════════════
section('1. Every tool in the payload gets a line in "All N tools", in its group (v3.88.0)');
// ═══════════════════════════════════════════════════════════════════════════
//
// The 24 tiles became ONE fold of two monitors, READ and WRITE, one line per
// tool. The count comes from the fixture, never a literal; the 17/7 split is
// the fixture's own shape.
{
  const fold = (HTML.match(/<details class="settings-setup-fold mcp-all-tools"[\s\S]*?<\/details>/) || [''])[0];
  const lines = fold.match(/class="cur-mon-line[" ]/g) || [];
  ok(lines.length === FIXTURE.tools.length,
    `${lines.length} lines for ${FIXTURE.tools.length} tools — the fold shows the WHOLE catalogue`);
  ok(new RegExp('All ' + FIXTURE.tools.length + ' tools<').test(fold), 'the fold is titled "All 24 tools" — the count read from the payload');
  ok(/mcp-group-eyebrow">READ · 17</.test(fold), 'the READ group names itself and counts 17');
  ok(/mcp-group-eyebrow">WRITE · 7</.test(fold), 'the WRITE group names itself and counts 7');
  const writeAt = fold.indexOf('WRITE · 7');
  ok(!/save_working_state/.test(fold.slice(0, writeAt)) && /save_working_state/.test(fold.slice(writeAt)),
    'a write tool’s line is under the WRITE caption, not merely counted by it');
  ok(/search_wiki/.test(fold.slice(0, writeAt)), '…and a read tool’s line is under the READ caption');
  const short = build(null, { state: { mcpUsage: payload({ tools: FIXTURE.tools.slice(0, 23) }) } });
  const shortFold = (short.renderToolMapBody(NOW).match(/<details class="settings-setup-fold mcp-all-tools"[\s\S]*?<\/details>/) || [''])[0];
  ok((shortFold.match(/class="cur-mon-line[" ]/g) || []).length === 23 && /All 23 tools</.test(shortFold),
    'CONTROL: 23 tools in → 23 lines and "All 23 tools" out — the count is read, not assumed');
}

// ═══════════════════════════════════════════════════════════════════════════
section('2. "All N tools" is CLOSED by default, and an opened fold survives the repaint');
// ═══════════════════════════════════════════════════════════════════════════
{
  ok(/<details class="settings-setup-fold mcp-all-tools" data-mcp-fold="all-tools">/.test(HTML),
    'the fold renders without `open` (the owner’s decision 6)');
  const opened = build(null, { state: { mcpUsage: FIXTURE, mcpAllToolsOpen: true } }).renderToolMapBody(NOW);
  ok(/data-mcp-fold="all-tools" open>/.test(opened), 'with the person’s own open recorded in state, the repaint keeps it open');
  ok(!/<details[^>]*>[\s\S]*?mcp-runner-outcome[\s\S]*?<\/details>/.test(HTML) && !/<details[^>]*>(?:(?!<\/details>)[\s\S])*mcp-agent-use/.test(HTML),
    'neither the outcome nor the Agent use monitor sits inside the fold');
}

// ═══════════════════════════════════════════════════════════════════════════
section('3. Each line is AGENT use: calls in the window · last agent use; "—" for none (truth audit T4)');
// ═══════════════════════════════════════════════════════════════════════════
{
  const agent = payload({ tools: FIXTURE.tools.map((t, i) => ({ ...t, count7dAgent: t.name === 'search_wiki' ? 11 : 0,
    lastAgentAt: t.name === 'search_wiki' ? ago(2 * 86400) : null,
    // the test run lit every tool a minute ago — that must NOT read as agent use
    lastUsedAt: ago(60), lastVia: 'self-test' })) });
  const h = build(null, { state: { mcpUsage: agent } }).renderToolMapBody(NOW);
  const line = (name) => (h.slice(h.indexOf('mcp-all-tools')).match(new RegExp('cur-mon-key">' + name + '</span>[\\s\\S]*?(?=<div class="cur-mon-line|</div></div>)')) || [''])[0];
  ok(/11 · <span data-mcp-age-at="[^"]+"><span class="mcp-age-words">2 days ago</.test(line('search_wiki')),
    'search_wiki: "11 · 2 days ago" — agent calls and the last AGENT use, on the tick hook', line('search_wiki'));
  ok(/cur-mon-value">—</.test(line('get_tags')), 'a tool no agent called: "—", with no age');
  ok(!/1 min ago/.test(h.slice(h.indexOf('mcp-all-tools'))), 'the test run’s "1 min ago" appears on NO line');
  ok(/<p class="tx-note mcp-foot mcp-all-tools-legend">Each line: agent calls · last agent use · — none since \d+ \w{3}<\/p>/.test(h),
    'the column legend sits INSIDE the fold, one short line: what each line is, what "—" means and since when');
  ok(/<summary class="settings-setup-summary"><span class="settings-setup-name">All 24 tools<\/span><\/summary>/.test(h),
    'the fold’s summary is its name only — no cryptic legend on it (v3.88.0 polish)');
  // An older server (no lastAgentAt field) may stand its lastUsedAt in ONLY when that use was not a test run.
  const older = build(null, { state: { mcpUsage: payload() } }).agentReading;
  ok(older({ name: 'a', lastUsedAt: ago(30), lastVia: 'self-test' }).lastAgentAt === null, 'older server: a test run’s use is never passed off as an agent’s');
  ok(older({ name: 'a', lastUsedAt: ago(30) }).lastAgentAt === ago(30), '…an agent’s use is');
  ok(older({ name: 'a', lastUsedAt: ago(30), lastAgentAt: null }).lastAgentAt === null, 'a server that sends lastAgentAt: null is believed');
  ok(!/\bnever\b/i.test(HTML), 'the word "never" appears NOWHERE in the rendered map');
}

// ═══════════════════════════════════════════════════════════════════════════
section('4. The Agent use monitor: two session readings, then the busiest five');
// ═══════════════════════════════════════════════════════════════════════════
{
  const use = (HTML.match(/<div class="cur-mon" id="mcp-agent-use"[\s\S]*?(?=<details)/) || [''])[0];
  ok(/cur-mon-key">last session start</.test(use) && /cur-mon-key">last save</.test(use), 'the monitor opens on last session start and last save');
  ok(use.includes('data-mcp-age-at="' + FIXTURE.sessions.lastBootstrapAt + '"') && /mcp-age-words/.test(use),
    'each reading carries the tick hook and the element the clock writes into');
  const none = build(null, { state: { mcpUsage: payload({ sessions: { lastBootstrapAt: null, lastSaveAt: null } }) } }).renderToolMapBody(NOW);
  ok(/none since this log began/.test(none) && !/\bnever\b/i.test(none), 'an absent reading says "none since this log began"');
  const many = payload({ tools: FIXTURE.tools.map((t, i) => ({ ...t, count7dAgent: i < 8 ? 20 - i : 0 })) });
  const h = build(null, { state: { mcpUsage: many } }).renderToolMapBody(NOW);
  const mon = (h.match(/<div class="cur-mon" id="mcp-agent-use"[\s\S]*?(?=<details)/) || [''])[0];
  ok((mon.match(/cur-depth/g) || []).length >= 5 && (mon.match(/class="cur-mon-line[" ]/g) || []).length === 7, 'two readings + FIVE tools with depth bars, never more');
  ok(/3 more called less/.test(mon) && /16 tools unused/.test(mon) && /test runs not counted/.test(mon),
    'the footnote counts the rest in words and says test runs are not counted');
  // THE EMPTY STATE — the log absent entirely.
  const emptyHtml = build(null, { state: { mcpUsage: { present: false, tools: [], sessions: {} } } }).renderToolMapBody(NOW);
  ok(/No calls recorded yet/.test(emptyHtml) && /The map fills as your agents use the bridge/.test(emptyHtml) && !/mcp-all-tools/.test(emptyHtml),
    'log absent → "No calls recorded yet", and no fold');
  const nothingUsed = build(null, { state: { mcpUsage: payload({ tools: UNUSED_READ.concat(UNUSED_WRITE) }) } });
  ok(/No calls recorded yet/.test(nothingUsed.renderToolMapBody(NOW)), 'a present log with nothing used yet shows the same empty state');
}

// ═══════════════════════════════════════════════════════════════════════════
section('5. The tiles, the busiest eyebrow and the self-test marker are gone');
// ═══════════════════════════════════════════════════════════════════════════
{
  ok(!/mcp-tool-tile|mcp-writes-chip|mcp-via-mark|BUSIEST ·/.test(HTML), 'no tile, no writes chip, no "self-test ·" marker, no BUSIEST eyebrow');
  ok(!/\.mcp-tool-tile|\.mcp-writes-chip|\.mcp-via-mark/.test(css.replace(/\/\*[\s\S]*?\*\//g, '')), 'and their rules are gone from the stylesheet');
}

// ═══════════════════════════════════════════════════════════════════════════
section('6. The block: numbered ③, one lede, the privacy ⓘ, no title=');
// ═══════════════════════════════════════════════════════════════════════════
{
  const block = MAP.renderToolMap();
  ok(/class="settings-job-block settings-block settings-block-mcp-tool-map/.test(block),
    'it is a settingsBlock, with the id the revalidate targets');
  ok(/settings-block-num" aria-hidden="true">3</.test(block), '…numbered 3');
  ok(/kept on this machine only/.test(block), 'the lede states the privacy fact in the open');
  const info = block.slice(block.indexOf('settings-block-info'));
  // v3.71.1: the ⓘ is the `settings.mcp-tool-map` explainer, byte for byte,
  // under the unchanged panel id. The file-level detail the old prose carried
  // (.mcp-usage.jsonl, the 1 MB rotation, the per-line byte bound) moved to
  // the user guide's "The tool map — what your agents used".
  ok(info.includes(explainerMark('settings-block-info-mcp-tool-map', 'settings.mcp-tool-map').panel),
    'the ⓘ panel IS the settings.mcp-tool-map explainer (byte-equal, id unchanged)');
  for (const claim of ['never what agents read or wrote', 'never synced', 'never counts as a connection']) {
    ok(info.includes(claim), `the ⓘ states: "${claim}"`);
  }
  ok(/href="[^"]*user-guide\.md#the-tool-map/.test(block),
    '…and links the guide through the checkable docs-links table');
  // NO `title=` FROM THIS BLOCK'S OWN MARKUP. The rendered block DOES contain
  // one, on the shared ⓘ button `infoMark` emits — every block in this view
  // has carried it since v3.44.0 and it is counted by the source ratchet in
  // scripts/test-next-header-adoption.js, which this work does not move. What
  // must stay at zero is a hover-only fact of the map's own: a tooltip is not
  // a reading, and everything here has to be legible without a pointer.
  ok(!/title="/.test(HTML),
    'the map’s own markup carries no title= — no fact of it is hover-only');
  ok(/title="/.test(block),
    'CONTROL: the assertion above is about the BODY — the shared ⓘ button’s title= is still there and still counted by the source ratchet');
}

// ═══════════════════════════════════════════════════════════════════════════
section('7. The 30 s revalidate repaints ONE block body, and only on a change');
// ═══════════════════════════════════════════════════════════════════════════
//
// THE DEFECT THIS STOPS is v3.53.1's with a slower clock: a poll that calls
// `render()` replaces the whole column, closing every ⓘ and every `<details>`
// the user has open. The fake document below RECORDS every write with the
// selector it was reached by, so "nothing else was touched" is measured rather
// than asserted.
{
  function fakeDoc() {
    const writes = [];
    const node = { get innerHTML() { return ''; }, set innerHTML(v) { writes.push({ sel, len: v.length }); } };
    let sel = null;
    return {
      writes,
      querySelector(s) { sel = s; return s.includes('mcp-tool-map') ? node : null; },
      querySelectorAll() { return []; },
    };
  }
  function harness(stateOver, verdict) {
    const doc = fakeDoc();
    const state = Object.assign({ section: 'mcp', mcpUsage: null, mcpUsageSig: null, mcpUsageError: null }, stateOver);
    const api = build([extractFunction(src, 'refreshMcpUsage')], {
      state,
      document: doc,
      fetchMcpUsage: async () => verdict,
      isCurrentMount: () => true,
    }, ['refreshMcpUsage']);
    return { doc, state, api };
  }
  // A signature-identical answer must repaint NOTHING.
  {
    const first = build(null, {});
    const sig = first.usageSignature(FIXTURE);
    const h = harness({ mcpUsage: FIXTURE, mcpUsageSig: sig }, { ok: true, data: payload() });
    await h.api.refreshMcpUsage(1);
    ok(h.doc.writes.length === 0,
      `an unchanged payload writes NOTHING (${h.doc.writes.length} DOM writes)`);
  }
  // A moved signature repaints exactly one block body, and nothing else.
  {
    const first = build(null, {});
    const sig = first.usageSignature(FIXTURE);
    const moved = payload({ tools: FIXTURE.tools.map((t, i) => (i === 0 ? { ...t, count7d: 13 } : t)) });
    const h = harness({ mcpUsage: FIXTURE, mcpUsageSig: sig }, { ok: true, data: moved });
    await h.api.refreshMcpUsage(1);
    ok(h.doc.writes.length === 1, `a moved payload writes exactly once (${h.doc.writes.length})`);
    ok(h.doc.writes[0].sel === '.settings-block-mcp-tool-map .settings-block-body',
      'and the one write is block ③’s BODY — never #view-root, never the column');
    ok(h.state.mcpUsageSig !== sig, 'the recorded signature moved with it');
  }
  // `logBytes` moves on every single call and NOTHING draws it: it must not be
  // able to cost a repaint. This is the assertion that makes `usageSignature`
  // a named projection rather than a JSON.stringify.
  {
    const first = build(null, {});
    const sig = first.usageSignature(FIXTURE);
    const h = harness({ mcpUsage: FIXTURE, mcpUsageSig: sig },
      { ok: true, data: payload({ logBytes: 999999 }) });
    await h.api.refreshMcpUsage(1);
    ok(h.doc.writes.length === 0, 'a payload differing only in logBytes repaints nothing');
  }
  // A DEAD MOUNT paints nothing at all, even on a changed payload.
  {
    const doc = fakeDoc();
    const state = { section: 'mcp', mcpUsage: FIXTURE, mcpUsageSig: 'stale', mcpUsageError: null };
    const api = build([extractFunction(src, 'refreshMcpUsage')], {
      state, document: doc,
      fetchMcpUsage: async () => ({ ok: true, data: payload() }),
      isCurrentMount: () => false,
    }, ['refreshMcpUsage']);
    await api.refreshMcpUsage(1);
    ok(doc.writes.length === 0 && state.mcpUsageSig === 'stale',
      'a mount that has moved on neither paints nor commits');
  }
  // A FAILED refresh KEEPS the last good payload — a map that empties itself
  // because one poll missed is worse than a map one poll stale.
  {
    const h = harness({ mcpUsage: FIXTURE, mcpUsageSig: 'sig' }, { ok: false, error: 'nope' });
    await h.api.refreshMcpUsage(1);
    ok(h.state.mcpUsage === FIXTURE, 'a failed refresh keeps the payload it had');
    ok(h.state.mcpUsageError === 'nope', '…and records the reason');
  }
  // ON ANOTHER SECTION the state still moves and nothing is painted.
  {
    const h = harness({ section: 'general', mcpUsage: FIXTURE, mcpUsageSig: 'stale' },
      { ok: true, data: payload() });
    await h.api.refreshMcpUsage(1);
    ok(h.doc.writes.length === 0, 'on another section, nothing is painted…');
    ok(h.state.mcpUsageSig !== 'stale', '…and the fresh payload is still committed for the next render');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('8. The poll is a chain, it arms once, and it stops on exit');
// ═══════════════════════════════════════════════════════════════════════════
{
  // THE TWO POLL FUNCTIONS ARE LIFTED ON THEIR OWN, not through `build`: they
  // touch neither `state` nor the render chain, and the thing under test is
  // the TIMER HANDLE — a module-level `let` cannot be extracted, which is why
  // settings.js keeps it in a one-field object the harness can inject.
  const h = (() => {
    const timers = []; const cleared = []; const poll = { timer: null };
    const bodies = [extractFunction(src, 'scheduleUsagePoll'), extractFunction(src, 'stopUsagePoll')];
    const deps = {
      usagePoll: poll, USAGE_POLL_MS: 30000,
      setTimeout: (fn) => { timers.push(fn); return timers.length; },
      clearTimeout: (id) => cleared.push(id),
      isCurrentMount: () => true,
      refreshMcpUsage: async () => {},
    };
    const names = Object.keys(deps);
    const api = new Function(...names,
      bodies.join('\n') + '\nreturn { scheduleUsagePoll, stopUsagePoll };')(...names.map((n) => deps[n]));
    return { timers, cleared, poll, api };
  })();
  h.api.scheduleUsagePoll(1);
  ok(h.timers.length === 1 && h.poll.timer === 1, 'scheduling arms exactly one timer');
  h.api.scheduleUsagePoll(1);
  ok(h.timers.length === 2 && h.cleared.length === 1,
    're-scheduling clears the old one first — one armed timer however often it is called');
  h.api.stopUsagePoll();
  ok(h.poll.timer === null && h.cleared.length === 2, 'stopping clears it and forgets the handle');
  h.api.stopUsagePoll();
  ok(h.cleared.length === 2, '…and stopping twice is a no-op, so a teardown can be defensive');
  // THE CHAIN ENDS ON A DEAD MOUNT. Drive the armed callback with
  // isCurrentMount false and require that no new timer is armed.
  //
  // TWO THINGS ARE MEASURED HERE, and the first is the expensive one: a tick
  // that fires after the view has gone must not FETCH. Asserting only that it
  // arms no successor is not enough — the successor is also guarded, so the
  // request would go out on every abandoned chain and nothing would notice.
  const dead = (() => {
    const timers = []; const poll = { timer: null }; let fetches = 0;
    const bodies = [extractFunction(src, 'scheduleUsagePoll'), extractFunction(src, 'stopUsagePoll')];
    let alive = true;
    const deps = {
      usagePoll: poll, USAGE_POLL_MS: 30000,
      setTimeout: (fn) => { timers.push(fn); return timers.length; },
      clearTimeout: () => {},
      isCurrentMount: () => alive,
      refreshMcpUsage: async () => { fetches++; },
    };
    const names = Object.keys(deps);
    const api = new Function(...names,
      bodies.join('\n') + '\nreturn { scheduleUsagePoll, stopUsagePoll };')(...names.map((n) => deps[n]));
    api.scheduleUsagePoll(1);
    alive = false;
    timers[0]();                       // the 30s tick fires after the view has gone
    return { timers, fetches };
  })();
  ok(dead.fetches === 0,
    `a tick that fires after the mount has moved on asks the server NOTHING (${dead.fetches} requests)`);
  ok(dead.timers.length === 1, '…and arms no successor — the chain ends itself');
  // CONTROL: the same tick on a LIVE mount does both.
  const live = (() => {
    const timers = []; const poll = { timer: null }; let fetches = 0;
    const bodies = [extractFunction(src, 'scheduleUsagePoll'), extractFunction(src, 'stopUsagePoll')];
    const deps = {
      usagePoll: poll, USAGE_POLL_MS: 30000,
      setTimeout: (fn) => { timers.push(fn); return timers.length; },
      clearTimeout: () => {},
      isCurrentMount: () => true,
      refreshMcpUsage: async () => { fetches++; },
    };
    const names = Object.keys(deps);
    const api = new Function(...names,
      bodies.join('\n') + '\nreturn { scheduleUsagePoll, stopUsagePoll };')(...names.map((n) => deps[n]));
    api.scheduleUsagePoll(1);
    timers[0]();
    return { fetches };
  })();
  ok(live.fetches === 1, `CONTROL: on a live mount the same tick DOES ask (${live.fetches})`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('9. The age clock writes text into named nodes, and only those');
// ═══════════════════════════════════════════════════════════════════════════
//
// It must never call `render()` (v3.53.1) and it must never write a wrapper's
// own `textContent` — a wrapper can hold a label or a visually-hidden stamp
// beside the words, and an unnamed fallback is how a future edit starts
// silently deleting a sibling.
{
  function el(stamp, childClass, initial) {
    const child = { textContent: initial, _cls: childClass };
    return {
      getAttribute: () => stamp,
      querySelector: (s) => (s === '.' + childClass ? child : null),
      child,
      textContent: 'WRAPPER TEXT',
    };
  }
  const tile = el(ago(45 * 60), 'mcp-age-words', 'stale words');
  // ONE NAMED TARGET SINCE v3.65.0. `.tx-readout-value` was the second, back
  // when the session strip painted through shared/text.js's readout; the strip
  // is a monitor now (M10) and its two lines compose their own
  // `.mcp-age-words` inside the `markHtml` they hand the kit — so both hooked
  // shapes on this block name the SAME child, and the branch that named the
  // other one went with the strip rather than being left matching nothing.
  const session = el(ago(30), 'mcp-age-words', 'stale words');
  const nodes = [tile, session];
  const api = build(null, { document: { querySelectorAll: () => nodes } });
  api.tickMcpAges();
  ok(tile.child.textContent !== 'stale words', 'a tile’s `.mcp-age-words` is recounted');
  ok(session.child.textContent !== 'stale words',
    'a session line’s `.mcp-age-words`, composed inside the monitor’s markHtml, is recounted too');
  ok(tile.textContent === 'WRAPPER TEXT' && session.textContent === 'WRAPPER TEXT',
    '…and neither wrapper’s own text is touched');
  // NO UNNAMED FALLBACK. A hook on a wrapper that holds neither named element
  // must be SKIPPED, not written: the tile's meta line also carries the "not
  // used since this log began" phrase, and a `|| el` fallback would replace
  // the whole sentence with an age.
  const orphan = {
    getAttribute: () => ago(45 * 60),
    querySelector: () => null,
    textContent: 'PHRASE AND STAMP',
  };
  build(null, { document: { querySelectorAll: () => [orphan] } }).tickMcpAges();
  ok(orphan.textContent === 'PHRASE AND STAMP',
    'a hook with neither named child is skipped — the clock has no unnamed fallback');
  // A node whose stamp is not a date is SKIPPED rather than written with a
  // guess.
  const junk = el('not-a-date', 'mcp-age-words', 'left alone');
  const api2 = build(null, { document: { querySelectorAll: () => [junk] } });
  api2.tickMcpAges();
  ok(junk.child.textContent === 'left alone', 'an unparseable stamp is skipped, never guessed at');
  // NO-OP ASSIGNMENTS ARE NOT MADE. A write dirties the node for the browser
  // and re-reads on a live region; most of the 60 ticks a minute have nothing
  // to say.
  // RELATIVE TO THE REAL CLOCK, not to the fixture's `NOW`: `tickMcpAges` reads
  // `Date.now()` itself — that is the point of it — so a fixture stamp would
  // make this assertion about a several-month age and pass for the wrong
  // reason.
  let writes = 0;
  const realAgo = new Date(Date.now() - 45 * 60 * 1000).toISOString();
  const same = {
    getAttribute: () => realAgo,
    querySelector: () => ({ get textContent() { return formatAge(45 * 60); }, set textContent(v) { writes++; } }),
  };
  build(null, { document: { querySelectorAll: () => [same] } }).tickMcpAges();
  ok(writes === 0, 'an unchanged reading is not re-assigned');
  // AND THE CLOCK IS NOT A RENDER. Proven structurally: its body names no
  // render function at all.
  ok(!/render\s*\(/.test(extractFunction(src, 'tickMcpAges')),
    'tickMcpAges’s body calls no render() — the v3.53.1 defect cannot come back through it');
}

// ═══════════════════════════════════════════════════════════════════════════
section('10. The stylesheet: the shared scale, and no `.fresh-` rule of its own');
// ═══════════════════════════════════════════════════════════════════════════
{
  // shared/freshness.css owns the `fresh-` prefix outright — the discipline
  // shared/text.css holds over `tx-`, asserted app-wide by
  // scripts/test-freshness-scale.js. Re-asserted here because this block is the
  // newest consumer and the temptation (a gap on `.fresh-dot`) is local.
  const ownFresh = (css.replace(/\/\*[\s\S]*?\*\//g, '').match(/^\s*\.fresh-[^{]*\{/gm) || []);
  ok(ownFresh.length === 0,
    `views/settings.css declares no .fresh- rule (${ownFresh.length}) — the scale stays in one file`);
  for (const cls of ['.mcp-tool-cols', '.mcp-tool-col', '.mcp-all-tools', '.mcp-group-eyebrow', '.mcp-map-empty']) {
    ok(css.includes(cls + ' ') || css.includes(cls + ','), `${cls} has a rule`);
  }
  // v3.88.0 — the fold's two monitors sit side by side, and stack on a narrow column.
  const nc = css.replace(/\/\*[\s\S]*?\*\//g, '');
  ok(/\.mcp-tool-cols\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(0,\s*1fr\)/.test(nc), 'READ and WRITE side by side, each able to shrink');
  ok(/@media \(max-width: 900px\)\s*\{\s*\.mcp-tool-cols\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/.test(nc), '…one column below 900px');
  ok(/\.mcp-tool-cols \.cur-mon-key/.test(nc), 'a tool NAME keeps its own case in the fold (the identifier-key rule the busiest list already has)');
  // No px literal on a font-size in the new rules: the text-size setting has to
  // reach them (v3.56.0 moved two frozen literals out for exactly this).
  const block = css.slice(css.indexOf('BLOCK ③'));
  const pxSizes = block.match(/font-size:\s*\d+px/g) || [];
  ok(pxSizes.length === 0, `no frozen px font-size in the tool-map rules (${pxSizes.length})`);
  ok(block.length > 800, 'CONTROL: the slice really covers the tool-map rules');
}


// ═══════════════════════════════════════════════════════════════════════════
section('11. "Test all N tools": the marker, the control, and the outcome (v3.61.0)');
// ═══════════════════════════════════════════════════════════════════════════
//
// THE DEFECT THIS STOPS is a reading the user CAUSED being read as evidence
// about their agents. The app's own run lights every tile; if the tile looks
// identical to one an agent lit, the map has stopped being an observation and
// become a mirror of the last button press.
{
  // ── 11a  THE OUTCOME OUTLIVES THE PAGE (v3.88.0) ───────────────────────
  // The tile marker is gone with the tiles; what a person needs from a run is
  // its outcome, and it now stays on screen after a reload — read back from
  // the usage log's last run when the server sends it, with WHEN it ran.
  {
    const logged = build(null, { state: { mcpUsage: payload({
      lastExercise: { at: ago(9 * 60), total: 24, answered: 24, refused: 0, durationMs: 1100 } }) } });
    const h = logged.renderToolMapBody(NOW);
    ok(/Last run <span data-mcp-age-at="[^"]+"><span class="mcp-age-words">[^<]+<\/span><\/span>: <\/span>24 of 24 answered · 0 refused · 1\.1 s/.test(h),
      'after a reload: "Last run <age>: 24 of 24 answered · 0 refused · 1.1 s", the age on the tick hook');
    ok(!/Last run/.test(build(null, { state: { mcpUsage: payload() } }).renderToolMapBody(NOW)),
      'CONTROL: with no run recorded (an older server) there is no outcome line — nothing is invented');
    const mine = build(null, { state: { mcpUsage: payload({ lastExercise: { at: ago(86400), total: 24, answered: 1, refused: 0 } }),
      mcpExercise: { ranAt: ago(5), durationMs: 300, results: FIXTURE.tools.map((t) => ({ tool: t.name, ok: true })) } } });
    ok(/24 of 24 answered/.test(mine.renderToolMapBody(NOW)) && !/1 of 24/.test(mine.renderToolMapBody(NOW)), 'this page’s own run wins over the log’s older one');
    const markedMap = build(null, { state: { mcpUsage: payload({
      tools: [{ ...USED[1], lastVia: 'self-test' }].concat(FIXTURE.tools.slice(1)) }) } }).renderToolMapBody(NOW);
    ok(!/\bnever\b/i.test(markedMap) && !/self-test ·/.test(markedMap), 'the word "never" appears nowhere, and no line is marked "self-test ·"');
  }

  // ── 11b  THE CLOCK LEAVES THE MARKER ALONE ─────────────────────────────
  {
    const child = { textContent: 'stale words' };
    const el = {
      getAttribute: () => new Date(Date.now() - 45 * 60 * 1000).toISOString(),
      querySelector: (sel) => (sel === '.mcp-age-words' ? child : null),
      textContent: 'self-test · stale words',
    };
    build(null, { document: { querySelectorAll: () => [el] } }).tickMcpAges();
    ok(child.textContent === formatAge(45 * 60),
      'the tick recounts the age words inside a marked reading');
    ok(el.textContent === 'self-test · stale words',
      '…and never writes the wrapper, so the marker survives every tick');
  }

  // ── 11c  THE SIGNATURE MOVES ON `lastVia`, AND NOT ON `selfTestTotal` ──
  {
    const api = build(null, {});
    const base = api.usageSignature(FIXTURE);
    const viaMoved = api.usageSignature(payload({
      tools: [{ ...FIXTURE.tools[0], lastVia: 'self-test' }].concat(FIXTURE.tools.slice(1)) }));
    ok(base !== viaMoved,
      'a tool whose marker changed moves the signature — otherwise a run would not repaint');
    const totalMoved = api.usageSignature(payload({
      tools: [{ ...FIXTURE.tools[0], selfTestTotal: 99 }].concat(FIXTURE.tools.slice(1)) }));
    ok(base === totalMoved,
      '`selfTestTotal` does NOT move it — the envelope carries it and nothing draws it, and an undrawn field may not cost a repaint');
  }

  // ── 11d  THE CONTROL: N IS READ, THE BUSY STATE IS REAL, NO title= ─────
  {
    const idle = build(null, { state: { mcpUsage: FIXTURE, mcpExerciseBusy: false } });
    const html = idle.renderToolMapBody(NOW);
    ok(/id="btn-mcp-exercise"/.test(html), 'the run control is on the block');
    ok(/class="btn btn-secondary"[^>]*id="btn-mcp-exercise"/.test(html),
      '…as a btn-secondary — it inspects rather than completes');
    ok(html.includes('Test all ' + FIXTURE.tools.length + ' tools'),
      `its label counts the catalogue it was handed ("Test all ${FIXTURE.tools.length} tools")`);
    // CONTROL: the count is READ. A literal 24 would pass the line above.
    const short = build(null, { state: { mcpUsage: payload({ tools: FIXTURE.tools.slice(0, 19) }) } });
    ok(short.renderToolMapBody(NOW).includes('Test all 19 tools'),
      'CONTROL: 19 tools in the payload → "Test all 19 tools" — the number is never typed');
    // BUSY.
    const busy = build(null, { state: { mcpUsage: FIXTURE, mcpExerciseBusy: true } });
    const busyHtml = busy.renderToolMapBody(NOW);
    ok(/id="btn-mcp-exercise" disabled/.test(busyHtml) || /disabled[^>]*id="btn-mcp-exercise"/.test(busyHtml),
      'while a run is in flight the control is disabled');
    ok(/Testing…/.test(busyHtml), '…and says so');
    ok(!/Test all/.test(busyHtml), '…and does not also offer to start another');
    ok(!/title="/.test(html), 'nothing the control adds is hover-only (no title=)');
    // THE NOTE — one line, ≤ 13 visible words, and it is a `.tx-note` rather
    // than a second lede (§3 of the design-system source allows one lede).
    const note = /class="tx-note mcp-runner-note">([^<]*)</.exec(html);
    ok(!!note, 'the control carries a one-line .tx-note');
    const words = note ? note[1].replace(/\s+/g, ' ').trim().split(' ').filter(Boolean) : [];
    ok(words.length > 0 && words.length <= 13,
      `the note is ${words.length} visible words (≤ 13, the lede ceiling)`);
    ok(/throwaway/.test(note ? note[1] : ''), '…and it says the copy is a throwaway');
    // ONE lede on the block, still.
    const block = idle.renderToolMap();
    ok((block.match(/class="settings-block-lede"/g) || []).length <= 1,
      'the block still carries at most ONE lede');
    // THE EMPTY STATE OFFERS IT TOO — that is the case it exists for.
    const nothingUsed = build(null, { state: {
      mcpUsage: payload({ tools: UNUSED_READ.concat(UNUSED_WRITE) }) } });
    const emptyHtml = nothingUsed.renderToolMapBody(NOW);
    ok(/No calls recorded yet/.test(emptyHtml) && /id="btn-mcp-exercise"/.test(emptyHtml),
      'a map with nothing used yet STILL offers the run — twenty dashed rings is the case the button exists for');
    // …and a payload with no tools at all offers nothing, because there is no
    // honest number to put in the label.
    const noTools = build(null, { state: { mcpUsage: { present: false, tools: [], sessions: {} } } });
    ok(!/btn-mcp-exercise/.test(noTools.renderToolMapBody(NOW)),
      'a payload with zero tools offers no control — "Test all 0 tools" is not a thing to offer');
  }

  // ── 11e  THE OUTCOME IS A READING ON THE PAGE, NEVER A FOLD ────────────
  {
    const rows = (n, over) => Array.from({ length: n }, (_, i) =>
      Object.assign({ tool: 't' + i, ok: true, refused: false, ms: 2, note: null }, (over && over(i)) || {}));
    // Nothing before a run.
    ok(!/mcp-runner-outcome/.test(build(null, { state: { mcpUsage: FIXTURE } }).renderToolMapBody(NOW)),
      'before any run there is no outcome on the page');
    // The clean run.
    const clean = build(null, { state: { mcpUsage: FIXTURE, mcpExercise: {
      ok: true, durationMs: 344, results: rows(24), covered: [], missing: [] } } });
    const cleanHtml = clean.renderToolMapBody(NOW);
    ok(/24 of 24 answered · 0 refused · 0\.3 s/.test(cleanHtml),
      'a clean run reads "24 of 24 answered · 0 refused · 0.3 s"');
    // THE OUTCOME ELEMENT ITSELF, not a slice of the page: the tiles below it
    // carry `aria-hidden="true"` on every freshness dot, so a substring search
    // over the remainder of the body reports "hidden" for a reason that has
    // nothing to do with this element.
    const outcomeOnly = clean.renderExerciseOutcome();
    ok(outcomeOnly.length > 0 && !/<details/.test(outcomeOnly)
       && !/\shidden(?=[\s=>])/.test(outcomeOnly) && !/aria-expanded/.test(outcomeOnly),
      'the outcome is NOT folded and not hidden — v3.16.1 puts the outcome of a press on the never-fold list');
    ok(/role="status"/.test(cleanHtml), '…and it is announced, so it is not a visual-only reading');
    ok(!/mcp-runner-outcome-bad/.test(cleanHtml), '…and a clean run takes no failure treatment');
    // A REFUSAL is an answer, and it is named with its reason.
    const withRefusal = build(null, { state: { mcpUsage: FIXTURE, mcpExercise: {
      ok: true, durationMs: 400, results: rows(24, (i) => (i === 14
        ? { tool: 'scan_semantic_duplicates', ok: false, refused: true, note: 'Estimate failed: No LLM API key found.' }
        : null)) } } });
    const refHtml = withRefusal.renderToolMapBody(NOW);
    ok(/24 of 24 answered · 1 refused/.test(refHtml),
      'a refusal still counts as answered, and is counted separately');
    ok(/scan_semantic_duplicates<\/code> refused — Estimate failed: No LLM API key found\./.test(refHtml),
      '…and the tool is named with its reason, which is the useful half');
    // A TOOL THAT DID NOT ANSWER is named. "23 of 24" alone is unactionable.
    const withFailure = build(null, { state: { mcpUsage: FIXTURE, mcpExercise: {
      ok: false, durationMs: 12000, results: rows(24, (i) => (i === 7
        ? { tool: 'get_connected_nodes', ok: false, refused: false, note: 'no answer within the call budget' }
        : null)) } } });
    const failHtml = withFailure.renderToolMapBody(NOW);
    ok(/23 of 24 answered/.test(failHtml), 'a tool that did not answer drops the count');
    ok(/No answer from: get_connected_nodes/.test(failHtml),
      '…and it is named — "23 of 24" with no name is a reading nobody can act on');
    ok(/mcp-runner-outcome-bad/.test(failHtml), '…and the whole outcome reads as a failure');
    // A TRANSPORT ERROR replaces the reading rather than sitting beside it.
    const errored = build(null, { state: { mcpUsage: FIXTURE,
      mcpExerciseError: 'The bridge could not be started: spawn ENOENT' } });
    const errHtml = errored.renderToolMapBody(NOW);
    ok(/settings-inline-error mcp-runner-outcome/.test(errHtml),
      'a failed run shows the error in the inline-error chrome');
    ok(/spawn ENOENT/.test(errHtml), '…with the reason the server gave, verbatim');
    ok(!/answered ·/.test(errHtml), '…and no invented count beside it');
    // A MALFORMED payload is not rendered as a reading.
    const junk = build(null, { state: { mcpUsage: FIXTURE, mcpExercise: { ok: true, results: 'nope' } } });
    ok(!/mcp-runner-outcome/.test(junk.renderToolMapBody(NOW)),
      'a payload whose `results` is not an array draws no outcome at all');
  }

  // ── 11f  THE 30s REPAINT RE-BINDS THE CONTROL IT JUST DESTROYED ────────
  // Without this the button is dead thirty seconds after the page loads, and
  // nothing anywhere would say so.
  {
    const writes = [];
    let sel = null;
    const node = { get innerHTML() { return ''; }, set innerHTML(v) { writes.push({ sel, len: v.length }); } };
    const doc = {
      querySelector(s) { sel = s; return s.includes('mcp-tool-map') ? node : null; },
      querySelectorAll() { return []; },
    };
    let rebinds = 0;
    const state = { section: 'mcp', mcpUsage: FIXTURE, mcpUsageSig: 'stale', mcpUsageError: null };
    const api = build([extractFunction(src, 'refreshMcpUsage')], {
      state, document: doc,
      fetchMcpUsage: async () => ({ ok: true, data: payload() }),
      isCurrentMount: () => true,
      wireExerciseControl: () => { rebinds++; },
    }, ['refreshMcpUsage']);
    await api.refreshMcpUsage(1);
    ok(writes.length === 1, `the repaint still writes exactly one body (${writes.length})`);
    ok(rebinds === 1,
      `…and re-binds the run control it destroyed (${rebinds} re-binds) — the button lives inside the body it replaced`);
  }

  // ── 11g  THE PRIVACY ⓘ NAMES THE NEW FIELD ─────────────────────────────
  {
    const block = build(null, { state: { mcpUsage: FIXTURE } }).renderToolMap();
    const info = block.slice(block.indexOf('settings-block-info'));
    // v3.71.1: the ⓘ is the `settings.mcp-tool-map` explainer, which no
    // longer names the `via: self-test` field itself (a log-format detail);
    // what it must still say outright is the consequence — a run from this
    // page is never a session. The self-test marker on a tile is asserted on
    // the rendered body in 11a–11f.
    const panel = explainerMark('settings-block-info-mcp-tool-map', 'settings.mcp-tool-map').panel;
    ok(info.includes(panel), 'the ⓘ panel is the settings.mcp-tool-map explainer');
    ok(/A test run from this page never counts as a connection/.test(panel),
      '…and says outright that a run is not a session — the one reading a false mark would corrupt');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('12. The runner’s stylesheet: no new colour, no frozen px size');
// ═══════════════════════════════════════════════════════════════════════════
{
  const clean2 = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const cls of ['.mcp-runner-row', '.mcp-runner-note', '.mcp-runner-outcome',
    '.mcp-runner-outcome-bad', '.mcp-runner-line']) {
    ok(clean2.includes(cls + ' ') || clean2.includes(cls + ','),
      `${cls} has a rule`);
  }
  // EVERY COLOUR IN THE NEW RULES IS AN EXISTING TOKEN — the claim "no new
  // colour, so nothing new to measure" is asserted rather than left in prose.
  const newRules = ['\\.mcp-runner-row', '\\.mcp-runner-note', '\\.mcp-runner-outcome',
    '\\.mcp-runner-outcome-bad', '\\.mcp-runner-line', '\\.mcp-runner-bad']
    .map((c) => (clean2.match(new RegExp(c + '[^{]*\\{[^}]*\\}', 'g')) || []).join('\n'))
    .join('\n');
  ok(newRules.length > 200, 'CONTROL: the new rules were really located in the stylesheet');
  // THE VALUE IS CAPTURED AND THEN TESTED, never matched with a lookahead
  // after `\s*`: `\s*` backtracks to zero width, so `(?!var\()` passes on
  // " var(--x)" and the guard reports every token as a literal. That first
  // version DID fire — on thirteen perfectly good `var()` values — which is
  // the kind of green-looking red that would have been silenced rather than
  // fixed if it had gone the other way.
  const literals = [...newRules.matchAll(/(?:color|background|border-color)\s*:([^;}]+)/g)]
    .map((m) => m[1].trim())
    .filter((v) => !v.startsWith('var('));
  ok(literals.length === 0,
    `no literal colour in the new rules (${literals.length}${literals.length ? ': ' + literals.join(' | ') : ''}) — every one is a token whose contrast is already measured`);
  // CONTROL: the filter can tell a literal apart from a token.
  ok([...'color: #fff;'.matchAll(/(?:color|background|border-color)\s*:([^;}]+)/g)]
      .map((m) => m[1].trim()).filter((v) => !v.startsWith('var(')).length === 1,
    'CONTROL: the same filter DOES flag a hex literal — the zero above is a measurement, not a dead regex');
  const px = newRules.match(/font-size:\s*\d+px/g) || [];
  ok(px.length === 0, `no frozen px font-size in the new rules (${px.length})`);
  // The tokens NAMED, so a future edit that swaps one for an unmeasured
  // colour has to move this line too.
  ok(/var\(--danger-text\)/.test(newRules) && /var\(--danger-tint\)/.test(newRules),
    'the failure arm uses the danger pair `.settings-inline-error` already uses on this surface');
}

// ═══════════════════════════════════════════════════════════════════════════
section('13. Agent use: agents only, the busiest five, bars against the busiest');
// ═══════════════════════════════════════════════════════════════════════════
{
  const withAgent = (over) => payload({ tools: USED.map((t) => ({ ...t,
    count7dAgent: ({ get_project_context: 41, save_working_state: 37, search_wiki: 12, compile_to_wiki: 0 })[t.name],
    count7d: 50 })).concat(UNUSED_READ, UNUSED_WRITE).map((t) => ('count7dAgent' in t) ? t : { ...t, count7dAgent: 0, count7d: 1 }), ...(over || {}) });
  const P = withAgent();
  const html = build(null, { state: { mcpUsage: P, mcpUsageError: null } }).renderToolMapBody(NOW);
  const mon = html.slice(html.indexOf('class="mcp-busiest"'), html.indexOf('mcp-all-tools'));
  ok(html.indexOf('class="mcp-busiest"') > html.indexOf('mcp-runner-note') && html.indexOf('class="mcp-busiest"') < html.indexOf('mcp-all-tools'),
    'the monitor sits after the runner and before the "All N tools" fold');
  const lines = [...mon.matchAll(/<span class="cur-mon-key">([^<]+)<\/span><span class="cur-mon-value">([^]*?)<\/span><\/div>/g)]
    .map((m) => ({ key: m[1], val: m[2] }));
  ok(lines.map((l) => l.key).join(',') === 'last session start,last save,get_project_context,save_working_state,search_wiki',
    'two session readings, then one line per tool AGENTS called, busiest first; a tool at 0 agent calls is omitted (got ' + lines.map((l) => l.key).join(',') + ')');
  const w = (v) => { const m = /cur-depth-bar[^"]*" style="width:([\d.]+)%"/.exec(v || ''); return m ? Number(m[1]) : null; };
  ok(w(lines[2] && lines[2].val) === 100 && w(lines[4] && lines[4].val) === 29.3,
    'the busiest fills its cell, 12 of 41 draws 29.3% — the denominator is the busiest tool');
  ok(/>41<\/span>/.test(lines[2] ? lines[2].val : ''), 'the figure printed is count7dAgent (41), NOT count7d (50) — a test call is never an agent’s');
  ok(!/cur-depth-danger/.test(mon), 'NEVER red: the busiest tool is not a fault');
  ok(/visually-hidden"> 12 calls · bar scaled to get_project_context’s 41</.test(mon), '★ every bar names its scale as the BUSIEST TOOL, by name (v3.76.0 F8a)');
  // ONE SHORT LINE (v3.88.0 polish, the owner's complaint): the footnote is a
  // muted .tx-note under the panel — never the monitor's mono note — one
  // clause list, no second sentence, short enough for one line at 1280 px.
  const foot = (x) => [...x.matchAll(/<p class="tx-note mcp-foot">([^<]*)<\/p>/g)].map((m) => m[1]);
  const isOneLine = (t) => t.length <= 90 && !/[.!?]\s+\S/.test(t) && !/\n/.test(t);
  ok(JSON.stringify(foot(mon)) === JSON.stringify(['Last 7 days · 21 tools unused · test runs not counted']),
    'the footnote is ONE short line: window · unused · test runs (got ' + JSON.stringify(foot(mon)) + ')');
  ok(foot(mon).every(isOneLine) && !/cur-mon-note/.test(mon), '★ one-line footnote: no second sentence, no mono note inside the monitor');

  // A LOG YOUNGER THAN THE WINDOW STATES ITS TRUE SPAN (v3.76.0 F8b).
  const young = withAgent({ logStartedAt: ago(5.4 * 86400), countWindowDays: 7 });
  const yh = build(null, { state: { mcpUsage: young, mcpUsageError: null } }).renderToolMapBody(NOW);
  const ym = yh.slice(yh.indexOf('class="mcp-busiest"'), yh.indexOf('mcp-all-tools'));
  ok(/<p class="tx-note mcp-foot">Last 5 days \(log begins \d+ \w{3}\) · 21 tools unused · test runs not counted<\/p>/.test(ym) && !/this week|7 days/i.test(ym),
    '★ a 5-day log says "Last 5 days (log begins …)", once, on one line; no "this week" or "7 days" [F8b]', ym);
  ok(foot(ym).every(isOneLine), '…and that footnote is still one line');
  ok(/aria-label="Agent use, last 5 days"/.test(yh), '…and the monitor’s name carries the same window');
  ok(!/in the last 5 days/.test(yh.slice(yh.indexOf('mcp-all-tools'))), 'the window is stated once — the fold’s legend does not repeat it');

  // Five at most, and the rest are said.
  const many = payload({ tools: Array.from({ length: 11 }, (_, i) => ({ name: 't' + String(i).padStart(2, '0'),
    group: 'read', mutates: false, purpose: 'x', lastUsedAt: ago(60), lastOk: true,
    count7d: 20 - i, count7dAgent: 20 - i, countTotal: 1, refusedTotal: 0 })) });
  const mh = build(null, { state: { mcpUsage: many, mcpUsageError: null } }).renderToolMapBody(NOW);
  const mm = mh.slice(mh.indexOf('class="mcp-busiest"'), mh.indexOf('mcp-all-tools'));
  ok((mm.match(/cur-depth-bar/g) || []).length === 5, 'at most five bars');
  ok(/6 more called less/.test(mm), '...and the six past the cap are said in words');

  // A test-run-only week: no bar, one sentence.
  const selfOnly = payload({ tools: USED.concat(UNUSED_READ, UNUSED_WRITE).map((t) => ({ ...t, count7d: 1, count7dAgent: 0 })) });
  const sh = build(null, { state: { mcpUsage: selfOnly, mcpUsageError: null } }).renderToolMapBody(NOW);
  const sm = sh.slice(sh.indexOf('class="mcp-busiest"'), sh.indexOf('mcp-all-tools'));
  ok(/Last 7 days · no agent called a tool · test runs not counted/.test(sm) && !/cur-depth-bar/.test(sm), 'a week with only test runs draws NO bar and says why, on one line');

  // ABSENT IS NOT ZERO: an older server sends no count7dAgent → no busiest list.
  const old = build(null, { state: { mcpUsage: FIXTURE, mcpUsageError: null } }).renderToolMapBody(NOW);
  const om = old.slice(old.indexOf('class="mcp-busiest"'), old.indexOf('mcp-all-tools'));
  ok(!/cur-depth-bar/.test(om) && /last session start/.test(om), 'a payload WITHOUT count7dAgent gets the session readings and no busiest list — never a column of zeros');

  const api = build(null, {});
  ok(api.usageSignature(P) !== api.usageSignature(withAgent({ tools: P.tools.map((t) => t.name === 'search_wiki' ? { ...t, count7dAgent: 13 } : t) })),
    'usageSignature moves when only count7dAgent moved — a painted field must be able to repaint');
  ok(api.usageSignature(P) !== api.usageSignature({ ...P, tools: P.tools.map((t, i) => i ? t : { ...t, lastAgentAt: ago(9) }) }), '…and when only lastAgentAt moved');
  ok(api.usageSignature(P) !== api.usageSignature({ ...P, lastExercise: { at: ago(1), total: 24 } }), '…and when only the last run moved');
  ok(/\.mcp-busiest \.cur-mon-key[^{]*\{[^}]*text-transform:\s*none/.test(css.replace(/\/\*[^]*?\*\//g, '')),
    'a tool NAME keeps its own case in the monitor key');
}

// ═══════════════════════════════════════════════════════════════════════════
section('14. ④ Across projects: handoff saves per project, the last save, idle projects on one line');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { domainIdentityClass } = await import('../src/public/next/shared/sidebar.js');
  const across = (projects) => build([extractFunction(src, 'renderAcrossProjects'),
    extractFunction(src, 'renderAcrossProjectsBody'), extractFunction(src, 'windowDaysWords'),
    extractFunction(src, 'logWindowWords'), extractFunction(src, 'adaptProjects'), extractFunction(src, 'acrossProjectsLede'), extractFunction(src, 'acrossWindowWords')], {
    state: { mcpProjects: projects, mcpProjectsError: null,
      defaultDomainInfo: { domains: ['business', 'posts', 'research'], identity: { business: 4, posts: 12, research: 7 } } },
    domainIdentityClass, ACROSS_PROJECTS_MAX_ROWS: 12,
  }, ['renderAcrossProjects']).renderAcrossProjects();
  const row = (domain, project, saves, extra) => ({ domain, project, projectLabel: project, inStore: true,
    sessions: 3, sessionsRead: 3, sessionsSaved: 3, lastSessionAt: ago(60),
    saves, lastSaveAt: saves ? ago(2 * 86400) : null, savesCapped: false, domainMismatch: false, sharedName: false, ...(extra || {}) });
  const P = { byProject: [row('business', 'alpha', 12, { savesCapped: true }), row('posts', 'curator', 5), row('research', 'quiet', 0), row('posts', 'ott', 0)],
    window: { logPresent: true, busiestSaved: 9, windowDays: 30, windowCovered: true, savesWindowDays: 7 },
    savePulse: { events: 113, lowerBound: true, capped: true, byToolFloor: true, windowSeconds: 604800, coversWholeWindow: true,
      byTool: [{ id: 'claude-code', label: 'Claude Code', events: 113, lastSeenAt: ago(60) }, { id: 'antigravity', label: 'Antigravity', events: 0, lastSeenAt: '2026-09-12T08:00:00Z' }] } };
  const html = across(P);
  ok(/settings-block-num" aria-hidden="true">4</.test(html) && /<h2 class="settings-job-title">Across projects<\/h2>/.test(html), 'block ④ "Across projects"');
  ok(/Last 7 days: which projects’ agents saved a handoff, and when\./.test(html), 'the window is in the lede, from the payload (`savesWindowDays`)');
  // ONE WINDOW FOR THE WHOLE BLOCK (v3.88.0 polish): saves per project and
  // per app are both counted over `savesWindowDays`, so it is said once.
  // Counted over what the block SHOWS (lede and body), not its ⓘ panel.
  const shown = (x) => ((x.match(/<p class="settings-job-lede[^]*?<\/p>/) || [''])[0] + x.slice(x.indexOf('<div class="mcp-across">')));
  const windows = (x) => (shown(x).replace(/<[^>]+>/g, ' ').match(/\b(?:last|under) (?:a |\d+ )?days?\b|\bLast \d+ days\b/gi) || []);
  ok(windows(html).length === 1 && !/30 days/.test(html), '★ ONE window in block ④, stated once (got ' + JSON.stringify(windows(html)) + ')');
  const lines = [...html.matchAll(/<div class="cur-mon-line[^"]*"><span class="cur-mon-key">([^<]+)<\/span><span class="cur-mon-value">([^]*?)<\/span>(?:<span class="cur-mon-sub">([^<]*)<\/span>)?<\/div>/g)]
    .map((m) => ({ key: m[1], val: m[2], sub: m[3] || '' }));
  const txt = (v) => v.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  ok(lines.map((l) => l.key).join('|') === 'business / alpha|posts / curator|Claude Code|Antigravity',
    'projects that saved, busiest first; the idle ones on ONE line; then one line per agent app (got ' + lines.map((l) => l.key).join('|') + ')');
  const w = (v) => { const m = /cur-depth-bar[^"]*" style="width:([\d.]+)%"/.exec(v || ''); return m ? Number(m[1]) : null; };
  ok(w(lines[0].val) === 100 && w(lines[1].val) === 41.7, 'the bar is SAVES against the busiest project (12 → 100%, 5 → 41.7%) — the owner’s decision 5');
  ok(/12\+/.test(txt(lines[0].val)) && !/5\+/.test(txt(lines[1].val)), '"12+" when a journal was read only in part (`savesCapped`), plain otherwise');
  ok(lines[0].sub === 'last save ' + formatAge(Math.round((Date.now() - Date.parse(P.byProject[0].lastSaveAt)) / 1000)), 'each row says its last save, in the shared age words', lines[0].sub);
  const idle = [...html.matchAll(/<p class="tx-note mcp-foot mcp-idle">([^<]*)<\/p>/g)].map((m) => m[1]);
  ok(JSON.stringify(idle) === JSON.stringify(['No save: research / quiet, posts / ott']),
    '★ the projects with no save: ONE left-aligned muted line, "No save: a / b, c / d" (got ' + JSON.stringify(idle) + ')');
  ok(html.indexOf('mcp-idle') > html.indexOf('id="mcp-across-projects"') && html.indexOf('mcp-idle') < html.indexOf('id="mcp-across-apps"'),
    '…directly under the projects panel, never a monitor line with the names right-aligned');
  ok(/cur-sb-dot cur-sb-dot-4"/.test(lines[0].val) && /cur-sb-dot cur-sb-dot-12"/.test(lines[1].val), '★ each project carries its DOMAIN’s RECORDED identity dot');
  ok(/113\+/.test(txt(lines[2].val)) && txt(lines[3].val) === 'none' && lines[3].sub === 'last save 12 Sep', 'per app: "113+", and "none · last save 12 Sep"');
  // A store younger than the window: the ONE window says where its records begin.
  const young = across({ ...P, savePulse: { ...P.savePulse, coversWholeWindow: false, oldestEventAt: new Date(Date.now() - 5 * 86400000).toISOString() } });
  ok(/Last 5 days \(records begin \d+ \w{3}\): which projects’ agents saved a handoff, and when\./.test(young)
    && windows(young).length === 1 && !/records begin[^]*records begin/.test(shown(young).replace(/<[^>]+>/g, " ")),
    '★ a store younger than the window: "Last 5 days (records begin …)" once, in the lede — the per-app panel does not repeat it', shown(young).replace(/<[^>]+>/g, ' ').slice(0, 600));
  ok(!/all agent apps/.test(html), 'no total line while only one app saved — it would repeat that app');
  ok(/“\+” means at least: long journals are read from their newest part only\./.test(html) && !/16 KB/.test(html), 'the "+" note is one plain sentence (the precision caveat is in the ⓘ)');
  ok(!/cur-depth-danger/.test(html), 'NEVER red');
  ok(!/connections saved|N of N/.test(txt(html)), 'no "N of N connections saved" (truth audit T5)');
  // An older server: no `saves` → the connections that saved, and the row says "last connection".
  const oldP = { ...P, byProject: P.byProject.map((r) => { const { saves, lastSaveAt, savesCapped, ...rest } = r; return rest; }) };
  const oh = across(oldP);
  ok(/last connection/.test(oh) && !/last save \d/.test(oh.replace(/last save 12 Sep/, '')), 'an older server: the fallback says "last connection", never "last save"');
  // ABSENT IS NOT ZERO.
  const none = across({ byProject: [{ domain: 'business', project: 'alpha', sessions: null, sessionsSaved: null }], window: { logPresent: false }, savePulse: null });
  ok(/No usage log on this computer yet/.test(none), 'with nothing measured the block says so, never a column of zeros');
  ok(/Reading the usage logs…/.test(across(null)), 'before the reading lands the block says so');
}

console.log('\n────────────────────────────────────────────────────────────');
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed) { console.log('❌ tool-map assertions failed'); process.exit(1); }
console.log('✅ All MCP tool-map assertions green');
