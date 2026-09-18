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

const RENDER_CHAIN = ['ageSecondsOf', 'ageMarkHtml', 'renderToolTile', 'renderToolGroup',
  'renderSessionStrip', 'renderToolMapBody', 'renderToolMap', 'usageSignature',
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
    TX_INFO_GLYPH: '<svg/>',
    docsLinkHtml,
    formatAge,
    freshnessTier,
    renderReadout,
    gatedLoader: () => '<LOADER/>',
    loadGate: null,
    document: undefined,
    Date,
    settingsBlock: null,
    infoMark: null,
  };
  Object.assign(deps, over || {});
  const bodies = [extractFunction(src, 'settingsBlock'), extractFunction(src, 'infoMark')]
    .concat(RENDER_CHAIN.map((n) => extractFunction(src, n)))
    .concat(extra || []);
  // The two lifted-real helpers must not ALSO arrive as parameters: a `const`
  // and a parameter of one name is a SyntaxError, which is the loud failure we
  // want rather than a shadow.
  delete deps.settingsBlock; delete deps.infoMark;
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
section('1. Every tool in the payload gets a tile, in the group it belongs to');
// ═══════════════════════════════════════════════════════════════════════════
//
// THE COUNT COMES FROM THE FIXTURE, not from a literal: "24" written here
// would be a second catalogue, and the thing under test is that the view drops
// nothing. The 17/7 split IS asserted as a literal, because that split is the
// fixture's own shape and a renderer that put a write tool in the read group
// would otherwise pass on the total alone.
{
  const tiles = HTML.match(/class="mcp-tool-tile/g) || [];
  ok(tiles.length === FIXTURE.tools.length,
    `${tiles.length} tiles for ${FIXTURE.tools.length} tools — the map shows the WHOLE catalogue`);
  const groups = HTML.match(/class="mcp-group-eyebrow">([^<]*)</g) || [];
  ok(groups.length === 2, `two groups rendered (${groups.length})`);
  ok(/READ · 17 tools/.test(HTML), 'the READ group names itself and counts 17');
  ok(/WRITE · 7 tools/.test(HTML), 'the WRITE group names itself and counts 7');
  // …and the split is REAL, not just a caption: the write tools' tiles must
  // all sit after the WRITE caption.
  const writeAt = HTML.indexOf('WRITE · 7 tools');
  const readPart = HTML.slice(0, writeAt);
  const writePart = HTML.slice(writeAt);
  ok(!/save_working_state/.test(readPart) && /save_working_state/.test(writePart),
    'a write tool’s tile is under the WRITE caption, not merely counted by it');
  ok(/search_wiki/.test(readPart), '…and a read tool’s tile is under the READ caption');
  // CONTROL: a payload one tool short renders one tile fewer. Without this a
  // renderer that hard-coded 24 tiles would pass everything above.
  const short = build(null, { state: { mcpUsage: payload({ tools: FIXTURE.tools.slice(0, 23) }) } });
  const shortTiles = (short.renderToolMapBody(NOW).match(/class="mcp-tool-tile/g) || []).length;
  ok(shortTiles === 23, `CONTROL: 23 tools in → ${shortTiles} tiles out — the count is read, not assumed`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('2. The freshness WORD and the DOT are the same band of one ladder');
// ═══════════════════════════════════════════════════════════════════════════
//
// Both are recomputed here from `shared/age.js` directly — the module the view
// imports — so this is a claim about the view USING that ladder rather than a
// restatement of a table typed twice. A view that grew its own thresholds
// fails here on the first tool whose age crosses a band.
{
  for (const t of USED) {
    const secs = Math.round((NOW - Date.parse(t.lastUsedAt)) / 1000);
    const words = formatAge(secs);
    const tier = freshnessTier(secs);
    // The tile, isolated, so one tool's reading cannot be satisfied by another's.
    const tile = MAP.renderToolTile(t, LOG_STARTED, NOW);
    ok(tile.includes('>' + words + '<'),
      `${t.name}: the words are formatAge's own — "${words}"`);
    ok(tile.includes('fresh-dot fresh-' + tier),
      `${t.name}: …and the dot wears the SAME band — fresh-${tier}`);
    ok(tile.includes('data-mcp-age-at="' + t.lastUsedAt + '"'),
      `${t.name}: …on a tick hook carrying the stamp, so the clock can recount it`);
  }
  // The four ages really do land on four different rungs — otherwise the loop
  // above would be four copies of one assertion.
  const tiers = new Set(USED.map((t) =>
    freshnessTier(Math.round((NOW - Date.parse(t.lastUsedAt)) / 1000))));
  ok(tiers.size === 4, `CONTROL: the fixture's four ages land on ${tiers.size} distinct bands`);
  // …and the uses line states its own window rather than a bare number.
  ok(MAP.renderToolTile(USED[1], LOG_STARTED, NOW).includes('88 uses · 7 days'),
    'the count names the window it counts over — "88 uses · 7 days"');
  ok(MAP.renderToolTile({ ...USED[1], count7d: 1 }, LOG_STARTED, NOW).includes('1 use · 7 days'),
    '…and it is singular at one');
}

// ═══════════════════════════════════════════════════════════════════════════
section('3. A tool with no line is "not used since this log began" — never "never"');
// ═══════════════════════════════════════════════════════════════════════════
{
  const tile = MAP.renderToolTile(UNUSED_READ[0], LOG_STARTED, NOW);
  ok(/mcp-tool-tile mcp-tool-unused/.test(tile), 'an unused tile is marked as one');
  ok(tile.includes('fresh-dot fresh-unknown'),
    'its mark is the DASHED unknown ring — a state that differs in kind, not in degree');
  ok(/not used since this log began/.test(tile), 'and it says exactly that');
  ok(tile.includes('>' + formatAge(9 * 86400) + '<'),
    `…with the LOG's own age beside it ("${formatAge(9 * 86400)}") — the phrase means nothing without it`);
  ok(tile.includes('data-mcp-age-at="' + LOG_STARTED + '"'),
    '…on a tick hook, so that age keeps moving too');
  ok(!/\bnever\b/i.test(HTML), 'the word "never" appears NOWHERE in the rendered map');
  // CONTROL: the used tile does NOT carry the unused treatment, so the two
  // arms are really distinguished.
  ok(!/mcp-tool-unused/.test(MAP.renderToolTile(USED[0], LOG_STARTED, NOW)),
    'CONTROL: a used tile carries neither the dashed ring nor the phrase');
}

// ═══════════════════════════════════════════════════════════════════════════
section('4. The `writes` chip is on the mutators, and only on them');
// ═══════════════════════════════════════════════════════════════════════════
//
// v3.16.1: a flag carried by 100% of a list carries nothing. The chip is the
// one fact a reader deciding what to let an agent do needs, so it must mark
// exactly the minority that can change files.
{
  const chips = (HTML.match(/class="mcp-writes-chip"/g) || []).length;
  const mutators = FIXTURE.tools.filter((t) => t.mutates).length;
  ok(chips === mutators, `${chips} chips for ${mutators} mutators`);
  ok(mutators < FIXTURE.tools.length / 2,
    `CONTROL: the mutators are a MINORITY (${mutators} of ${FIXTURE.tools.length}) — a chip on every tile would carry nothing`);
  ok(MAP.renderToolTile(USED[2], LOG_STARTED, NOW).includes('>writes<'),
    'a mutator’s own tile carries it');
  ok(!MAP.renderToolTile(USED[1], LOG_STARTED, NOW).includes('mcp-writes-chip'),
    '…and a read tool’s does not');
  // A tool that merely SITS in the write block without mutating takes no chip:
  // `scan_wiki_health` is read-only and is in the read group by capability.
  ok(!MAP.renderToolTile({ ...USED[2], mutates: false }, LOG_STARTED, NOW).includes('mcp-writes-chip'),
    'the chip keys on `mutates`, not on the group — a read-only tool in the write block takes none');
}

// ═══════════════════════════════════════════════════════════════════════════
section('5. The two session readings, and the empty state');
// ═══════════════════════════════════════════════════════════════════════════
{
  ok(/Last session start/.test(HTML), 'the strip reads "Last session start"');
  ok(/Last save/.test(HTML), '…and "Last save"');
  const strip = MAP.renderSessionStrip(FIXTURE.sessions, NOW);
  ok(strip.includes('data-mcp-age-at="' + FIXTURE.sessions.lastBootstrapAt + '"'),
    'each reading carries the tick hook');
  ok(strip.includes('tx-readout-value'),
    '…and paints through the shared readout, whose value element the clock writes into');
  const none = MAP.renderSessionStrip({ lastBootstrapAt: null, lastSaveAt: null }, NOW);
  ok(/none since this log began/.test(none) && !/\bnever\b/i.test(none),
    'an absent reading says "none since this log began", never "never"');
  ok(!/data-mcp-age-at/.test(none), '…and carries no tick hook, because there is no stamp to recount');

  // THE EMPTY STATE — the log absent entirely.
  const empty = build(null, { state: { mcpUsage: { present: false, tools: [], sessions: {} } } });
  const emptyHtml = empty.renderToolMapBody(NOW);
  ok(/No calls recorded yet/.test(emptyHtml), 'log absent → "No calls recorded yet"');
  ok(/The map fills as your agents use the bridge/.test(emptyHtml), '…and says what would fill it');
  ok(!/mcp-tool-tile/.test(emptyHtml), '…and draws no tiles');
  // A payload that is PRESENT but has no used tool is the same screen: a map of
  // 24 dashed rings is not a reading, it is a wall.
  const nothingUsed = build(null, {
    state: { mcpUsage: payload({ tools: UNUSED_READ.concat(UNUSED_WRITE) }) } });
  ok(/No calls recorded yet/.test(nothingUsed.renderToolMapBody(NOW)),
    'a present log with nothing used yet shows the same empty state, not 20 dashed rings');
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
  for (const claim of ['Never an argument', 'never a file path', 'rotates at 1 MB',
    '.mcp-usage.jsonl', 'never inside your knowledge folder']) {
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
  const readout = el(ago(30), 'tx-readout-value', 'stale words');
  const nodes = [tile, readout];
  const api = build(null, { document: { querySelectorAll: () => nodes } });
  api.tickMcpAges();
  ok(tile.child.textContent !== 'stale words', 'a tile’s `.mcp-age-words` is recounted');
  ok(readout.child.textContent !== 'stale words', 'a readout’s `.tx-readout-value` is recounted');
  ok(tile.textContent === 'WRAPPER TEXT' && readout.textContent === 'WRAPPER TEXT',
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
  for (const cls of ['.mcp-tool-tile', '.mcp-tool-grid', '.mcp-writes-chip', '.mcp-group-eyebrow',
    '.mcp-age', '.mcp-map-empty']) {
    ok(css.includes(cls + ' ') || css.includes(cls + ','), `${cls} has a rule`);
  }
  ok(/grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(220px,\s*1fr\)\)/.test(css),
    'the grid is auto-fill/minmax(220px) — the COLUMN decides the column count, not a breakpoint');
  // THE UNUSED READING'S OWN GEOMETRY, and both halves of it. Found by
  // rendering the grid: as an inline-flex row the sentence wrapped after the
  // separator, so a tile ended in a dangling "·".
  const unusedRule = (css.replace(/\/\*[\s\S]*?\*\//g, '').match(/\.mcp-age-unused\s*\{[^}]*\}/) || [''])[0];
  ok(/display:\s*grid/.test(unusedRule) && /grid-template-columns:\s*auto/.test(unusedRule),
    'the unused reading is a two-column grid, so a wrapped line cannot carry the mark with it');
  ok(/white-space:\s*normal/.test(unusedRule),
    '…and it is allowed to wrap at all (the used reading’s nowrap is overridden)');
  const tailRule = (css.replace(/\/\*[\s\S]*?\*\//g, '').match(/\.mcp-age-tail\s*\{[^}]*\}/) || [''])[0];
  ok(/white-space:\s*nowrap/.test(tailRule),
    '…and "· <age>" is one unbreakable clause: "began ·" ending a line is a sentence that lost its ending');
  // No px literal on a font-size in the new rules: the text-size setting has to
  // reach them (v3.56.0 moved two frozen literals out for exactly this).
  const block = css.slice(css.indexOf('BLOCK ③'));
  const pxSizes = block.match(/font-size:\s*\d+px/g) || [];
  ok(pxSizes.length === 0, `no frozen px font-size in the tool-map rules (${pxSizes.length})`);
  ok(block.length > 800, 'CONTROL: the slice really covers the tool-map rules');
}

console.log('\n────────────────────────────────────────────────────────────');
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed) { console.log('❌ tool-map assertions failed'); process.exit(1); }
console.log('✅ All MCP tool-map assertions green');
