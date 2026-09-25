/**
 * test-harness-names.js — OFFLINE suite for `src/brain/harness-names.js`
 * (v3.74.0, design item D1) and the two readers that now compare by tool:
 * `journalFacts` (harnessShared / previousHarness / harnessSwitches) and the
 * tray's `computePulse` (harnessCount, handover marks, per-tool lanes).
 *
 * ── WHAT IT PROTECTS ──────────────────────────────────────────────────────
 *
 * The `harness` on a save is free text the agent typed. The maintainer's real
 * store holds `Claude Code`, `Claude Code (desktop)`, `Claude Code (desktop
 * app)`, `Claude Code (worker agent)`, `claude-code`, … — one tool. Compared
 * raw, that made the pulse say "2 tools" and could raise a FALSE "Two agent
 * tools are writing …" collision. Two properties pull in opposite directions
 * and BOTH are asserted:
 *
 *   1. spelling drift of ONE tool never counts as two tools;
 *   2. two DIFFERENT tools are never merged — `claude-desktop` is not
 *      `claude-code` (the mcp-clients.js rule), an unknown name is never
 *      matched to a known one, and a real A-B-A alternation still raises
 *      `harnessShared`.
 *
 * Every assertion drives real functions. Isolated: both path seams are set to
 * a tempdir before the store is imported, although nothing here writes.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'curator-harness-names-')));
fs.mkdirSync(path.join(TMP, 'domains'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'userdata'), { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = path.join(TMP, 'userdata');
process.env.CURATOR_TEST_DOMAINS_DIR = path.join(TMP, 'domains');
delete process.env.DOMAINS_PATH;
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

let passed = 0, failed = 0;
function ok(cond, label, extra) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${extra !== undefined ? `\n        ${extra}` : ''}`); }
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  ok(a === e, label, a === e ? undefined : `expected: ${e}\n        actual:   ${a}`);
}
function section(t) { console.log(`\n${t}`); }

const { __setDomainsDirOverride } = await import('../src/brain/config.js');
__setDomainsDirOverride(path.join(TMP, 'domains'));
const HN = await import('../src/brain/harness-names.js');
const HA = await import('../src/brain/harness-adapters.js');
const WS = await import('../src/brain/working-state.js');
const TS = await import('../src/brain/tray-summary.js');
const { normaliseHarness, harnessId, KNOWN_HARNESS_IDS } = HN;

// ═══════════════════════════════════════════════════════════════════════════
section('§1  normaliseHarness — the spellings on the maintainer\'s real store');
// ═══════════════════════════════════════════════════════════════════════════
{
  const real = ['Claude Code', 'Claude Code (desktop)', 'Claude Code (desktop app)',
    'Claude Code (worker agent)', 'claude-code', 'Claude Code (desktop app, worker agent)',
    'Claude Code (worker agent, review)', '  Claude Code  '];
  for (const r of real) {
    const n = normaliseHarness(r);
    ok(n && n.id === 'claude-code' && n.label === 'Claude Code', `"${r}" → claude-code / "Claude Code"`, JSON.stringify(n));
  }
  eq(normaliseHarness('Claude Code (desktop app, worker agent)').variant, 'desktop app, worker agent',
    'the parenthetical becomes the VARIANT, whole');
  eq(normaliseHarness('Claude Code').variant, null, 'no parenthetical → variant null');
  eq(normaliseHarness('Claude Code (desktop)').raw, 'Claude Code (desktop)', 'the raw spelling is kept for a tooltip');
  eq(normaliseHarness('Antigravity'), { id: 'antigravity', label: 'Antigravity', variant: null, raw: 'Antigravity' },
    'Antigravity (no adapter row yet) is a KNOWN tool');
  eq(harnessId('antigravity'), 'antigravity', '…lower-case spelling too');
  eq(harnessId('OpenCode'), 'opencode', 'OpenCode → opencode');
  eq(harnessId('opencode'), 'opencode', 'opencode → opencode');
  eq(harnessId('codex'), 'codex', 'codex → codex');
  eq(harnessId('OpenAI Codex CLI'), 'codex', 'the adapter\'s own label for Codex → codex');
  eq(harnessId('cursor'), 'cursor', 'cursor → cursor');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2  Distinct products stay distinct; unknown names pass through');
// ═══════════════════════════════════════════════════════════════════════════
{
  eq(harnessId('claude-desktop'), 'claude-desktop', 'claude-desktop → claude-desktop');
  eq(harnessId('Claude Desktop'), 'claude-desktop', 'Claude Desktop → claude-desktop');
  eq(harnessId('claude-ai'), 'claude-desktop', 'the desktop app\'s own MCP client name → claude-desktop (mcp-clients.js)');
  ok(harnessId('claude-desktop') !== harnessId('claude-code'),
    'claude-desktop is NOT claude-code — a different surface, lifecycle and hook set');
  ok(harnessId('Claude Desktop') !== harnessId('Claude Code (desktop)'),
    '…and "Claude Code (desktop)" (the Code tab of the desktop app) is still Claude Code, not Claude Desktop');
  // Unknown names: never matched by prefix / substring to a known tool.
  eq(normaliseHarness('Claude'), { id: 'claude', label: 'Claude', variant: null, raw: 'Claude' },
    '"Claude" is NOT merged into Claude Code — passed through');
  eq(harnessId('Antigravity IDE'), 'antigravity ide', '"Antigravity IDE" is NOT merged into Antigravity');
  eq(normaliseHarness('  My   Harness  '), { id: 'my harness', label: 'My Harness', variant: null, raw: 'My   Harness' },
    'an unknown name: trimmed, whitespace collapsed, the agent\'s own case kept for the label');
  ok(harnessId('Foo Bar') === harnessId('foo  bar'), 'an unknown name folds case and whitespace…');
  ok(harnessId('foo-bar') !== harnessId('foo bar'), '…and NOTHING else: a hyphen stays distinct from a space');
  eq(normaliseHarness('Foo (x)'), { id: 'foo', label: 'Foo', variant: 'x', raw: 'Foo (x)' }, 'an unknown name\'s parenthetical is a variant too');
  eq(normaliseHarness('(only parens)').id, '(only parens)', 'a label that is ONLY a parenthetical is kept whole, not emptied');
  for (const bad of [null, undefined, '', '   ', 7, {}, []]) {
    eq(normaliseHarness(bad), null, `unusable input ${JSON.stringify(bad)} → null (never throws)`);
  }
  eq(normaliseHarness('x'.repeat(500)).raw.length, 80, 'a huge label is bounded (MAX_META_CHARS)');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3  The seed IS harness-adapters.js — every adapter normalises to itself');
// ═══════════════════════════════════════════════════════════════════════════
{
  // copilot-cli: the adapter id; mcp-clients.js calls it `copilot`. Both map
  // to the adapter's id here, so this table follows the adapter table.
  const ids = HA.listHarnesses();
  ok(ids.length >= 10, `non-vacuous: ${ids.length} adapter rows read from the real module`);
  for (const id of ids) {
    const a = HA.ADAPTERS[id];
    eq(harnessId(a.id), a.id, `adapter id "${a.id}" → itself`);
    eq(harnessId(a.label), a.id, `adapter label "${a.label}" → "${a.id}"`);
    eq(normaliseHarness(a.id).label, a.label, `…and shows the adapter's own label "${a.label}"`);
    ok(KNOWN_HARNESS_IDS.includes(a.id), `"${a.id}" is in KNOWN_HARNESS_IDS`);
  }
  eq(HN.HARNESS_ALIAS_COLLISIONS, [], 'no alias is listed under two products (which would merge them by table order)');
  const distinct = new Set(ids.map((id) => harnessId(HA.ADAPTERS[id].label)));
  eq(distinct.size, ids.length, 'no two adapters collapse onto one id (the table merges no products)');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4  journalFacts — spelling drift is one tool; A-B-A is still a collision');
// ═══════════════════════════════════════════════════════════════════════════
const NOW = Date.parse('2026-09-25T12:00:00.000Z');
const line = (h, minsAgo) => ({ at: new Date(NOW - minsAgo * 60000).toISOString(), headline: `h${minsAgo}`, harness: h });
{
  // One tool, spelled three ways, alternating: 4 switches by raw string.
  const drift = [line('Claude Code', 50), line('Claude Code (desktop)', 40), line('claude-code', 30),
    line('Claude Code (desktop)', 20), line('Claude Code', 10)];
  const f = WS.journalFacts(drift, NOW, { withSaveTimes: true });
  eq(f.harnessShared, false, 'SPELLING DRIFT does not raise harnessShared (no false "two tools are writing")');
  eq(f.harnessSwitches, 0, '…and counts no switches');
  eq(f.harnesses, ['Claude Code'], '…and lists ONE tool, by the spelling of its newest save');
  eq(f.previousHarness, null, '…and draws no handover arrow between two spellings of one tool');
  eq(f.saveHarnesses, ['Claude Code', 'Claude Code (desktop)', 'claude-code', 'Claude Code (desktop)', 'Claude Code'],
    '…while every raw spelling is still carried, index-aligned, for a tooltip');

  // A REAL alternation of two tools — the case the rule exists for.
  const aba = [line('claude-code', 30), line('Antigravity', 20), line('Claude Code', 10)];
  const g = WS.journalFacts(aba, NOW, { withSaveTimes: true });
  eq(g.harnessShared, true, 'a REAL A-B-A (Claude Code, Antigravity, Claude Code) STILL raises harnessShared');
  eq(g.harnessSwitches, 2, '…with two switches');
  eq(g.harnesses, ['Claude Code', 'Antigravity'], '…naming both tools, newest spelling first');
  eq(g.previousHarness, 'Antigravity', '…and the baton arrow names the previous tool');

  // claude-desktop vs claude-code alternating: two products, a real collision.
  const dd = [line('claude-code', 30), line('claude-desktop', 20), line('Claude Code (desktop)', 10)];
  const d = WS.journalFacts(dd, NOW, { withSaveTimes: true });
  eq(d.harnessShared, true, 'claude-code / claude-desktop / Claude Code (desktop) IS a collision — two products');
  eq(d.previousHarness, 'claude-desktop', '…and the handover from claude-desktop is drawn');

  // One handover (A A B) is not a collision, but it is an arrow.
  const aab = [line('Claude Code', 30), line('claude-code', 20), line('Antigravity', 10)];
  const h = WS.journalFacts(aab, NOW, { withSaveTimes: true });
  eq([h.harnessShared, h.harnessSwitches, h.previousHarness], [false, 1, 'claude-code'],
    'A A B (with drift inside A): one switch, no collision, the arrow names the raw previous spelling');

  // The DEFAULT (MCP index) shape is unchanged: no new keys.
  const plain = WS.journalFacts(drift, NOW);
  ok(!('saveHarnesses' in plain) && !('previousHarness' in plain) && !('harnessIds' in plain),
    'the default journalFacts object grows no key (the MCP index budget pin)');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5  computePulse — tools counted by id; one lane per tool (D4)');
// ═══════════════════════════════════════════════════════════════════════════
{
  const H = 3600000;
  const pairs = [
    { saveTimes: [NOW - 50 * H, NOW - 40 * H, NOW - 2 * H],
      saveHarnesses: ['Claude Code', 'Claude Code (desktop)', 'claude-code'] },
    { saveTimes: [NOW - 24 * 24 * H, NOW - 3 * H],               // Antigravity: once 24 d ago, once 3 h ago
      saveHarnesses: ['Antigravity', null] },
    { saveTimes: [NOW - 5 * H], saveHarnesses: ['claude-desktop'] },
  ];
  const p = TS.computePulse(pairs, NOW);
  eq(p.harnessCount, 2, 'harnessCount over normalised ids: Claude Code ×3 spellings + claude-desktop = 2 (Antigravity is outside the window)');
  eq(p.harnessChanges.filter(Boolean).length, 0, 'spelling drift inside one work-stream draws NO handover mark');
  eq(p.harnesses, ['claude-code', 'claude-desktop', 'antigravity'], 'lanes, newest-seen first');
  eq(p.byHarness['claude-code'].events, 3, 'the Claude Code lane holds all three spellings\' saves');
  eq(p.byHarness['claude-code'].label, 'Claude Code', '…under the canonical label');
  eq(p.byHarness['claude-desktop'].events, 1, 'claude-desktop has its OWN lane');
  eq(p.byHarness.antigravity.events, 0, 'a tool seen only before the window keeps a lane with 0 events…');
  eq(p.byHarness.antigravity.lastSeenAt, new Date(NOW - 24 * 24 * H).toISOString(), '…and its last-seen date');
  eq(p.byHarness.antigravity.buckets.length, p.buckets.length, 'lane buckets align with the strip');
  eq(p.eventsWithoutHarness, 1, 'a save naming no tool is counted apart, in no lane');
  const laneSum = Object.values(p.byHarness).reduce((s, l) => s + l.events, 0);
  eq(laneSum + p.eventsWithoutHarness, p.events, 'lanes + unnamed = every event (nothing double-counted, nothing lost)');
  for (let i = 0; i < p.buckets.length; i++) {
    const sum = Object.values(p.byHarness).reduce((s, l) => s + l.buckets[i], 0);
    if (sum > p.buckets[i]) { ok(false, `cell ${i}: lanes exceed the strip`); break; }
  }
  eq([p.byHarnessFloor, p.byHarnessNote], [false, null], 'no truncated tail → no floor note');
  const t = TS.computePulse([{ ...pairs[0], journalTailTruncated: true }], NOW);
  ok(t.byHarnessFloor === true && /At least/.test(t.byHarnessNote) && /last seen/.test(t.byHarnessNote),
    'a truncated tail → the lanes are a floor, worded "at least" / "last seen"', t.byHarnessNote);

  // A real handover still marks its cell.
  const ho = TS.computePulse([{ saveTimes: [NOW - 4 * H, NOW - 1 * H], saveHarnesses: ['claude-code', 'Antigravity'] }], NOW);
  eq(ho.harnessChanges.filter(Boolean).length, 1, 'a REAL handover (Claude Code → Antigravity) still marks its cell');
  eq(ho.harnessCount, 2, '…and counts two tools');
}

console.log(`\n${'─'.repeat(60)}`);
if (failed === 0) console.log(`✓ test-harness-names: ${passed} passed, 0 failed`);
else console.log(`✗ test-harness-names: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
