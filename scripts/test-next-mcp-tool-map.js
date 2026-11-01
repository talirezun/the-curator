#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  test-next-mcp-tool-map.js — Settings → MCP bridge → ④ "Tool activity" and
 *  the runner ("Test all N tools", in ③ Connection test's control row) —
 *  v3.89.0's section kit, v3.90.0's copy deck. EXECUTED: the real page through
 *  scripts/test-helpers/mcp-page-sandbox.js, and the real poll / clock
 *  functions lifted out of views/settings.js.
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS SUITE EXISTS TO STOP
 *   1. A TOOL DISAPPEARING: "All N tools" lists the WHOLE catalogue, used or
 *      not, N read from the payload (never a literal), and it is CLOSED by
 *      default (the owner's decision 6) — open only when the person opened it.
 *   2. THE WORD "NEVER": an unused tool says "not used this week" (v3.90.0).
 *   3. A TEST RUN COUNTED AS AGENT USE: the busiest list reads `count7dAgent`,
 *      never `count7d`.
 *   4. A TOOL WITHOUT A PLAIN LINE: each says what it does (`purpose`).
 *   5. THE RUNNER'S OUTCOME FOLDED OR UNNAMED: it is the result line in ③,
 *      unfolded, with the tools that did not answer BY NAME.
 *   6. THE POLL REPAINTING WHAT IT SHOULD NOT: an unchanged payload writes
 *      nothing; a moved one replaces ③'s CARD only (never the column); a dead
 *      mount paints nothing; a failed poll keeps the last reading.
 *   7. A LEAKING TIMER, and a clock that calls render() or writes a wrapper.
 *   8. The handoff section gone (v3.90.0, the owner's amendment).
 * OFFLINE. No network, no browser.
 */
import { formatAge } from '../src/public/next/shared/age.js';
import { renderMcpPage, baseState, SETTINGS_SRC, extractFunction, stripComments } from './test-helpers/mcp-page-sandbox.js';

let passed = 0;
let failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + msg); }
  else { failed++; console.log('  \x1b[31m✗\x1b[0m ' + msg + (detail === undefined ? '' : ' — ' + String(detail).slice(0, 500))); }
}
function section(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }
const SRC = stripComments(SETTINGS_SRC);
const card = (html, key) => {
  const at = html.indexOf('id="mcp-card-' + key + '"');
  if (at < 0) return '';
  const next = html.indexOf('<div class="cur-section-head"', at);
  return html.slice(at, next < 0 ? html.length : next);
};
const ago = (secs) => new Date(Date.now() - secs * 1000).toISOString();

// ═══════════════════════════════════════════════════════════════════════════
section('1. "All N tools": the whole catalogue, closed by default, N from the payload, one plain line each');
// ═══════════════════════════════════════════════════════════════════════════
{
  const st = baseState();
  st.mcpUsage = { ...st.mcpUsage, tools: st.mcpUsage.tools.map((t) => ({ ...t, purpose: 'What ' + t.name + ' does.' })) };
  const N = st.mcpUsage.tools.length;
  const use = card(renderMcpPage(st).html, 'use');
  const fold = (use.match(/<details class="cur-fold" data-fold-key="all-tools"[\s\S]*?<\/details>/) || [''])[0];
  ok(new RegExp('<span class="cur-fold-label">All ' + N + ' tools</span>').test(fold),
    'the fold row reads "All ' + N + ' tools" — N is the payload’s own length');
  ok(/data-fold-key="all-tools">/.test(fold), '…CLOSED by default (the owner’s decision 6)');
  const items = fold.match(/class="cur-fold-item cur-fold-item-wrap"/g) || [];
  ok(items.length === N, 'one fold item per tool, used or not (' + items.length + ' of ' + N + ')');
  const missing = st.mcpUsage.tools.filter((t) => !fold.includes('<span class="mono cur-fold-item-main">' + t.name + '</span>'));
  ok(missing.length === 0, 'every tool is listed by its own name, in mono', missing.map((t) => t.name).join(','));
  ok(st.mcpUsage.tools.every((t) => fold.includes('What ' + t.name + ' does. · ')),
    'every tool says what it does in one plain line — the catalogue’s `purpose` from GET /api/mcp/usage');
  const opened = card(renderMcpPage(baseState({ setupMachineFolds: { 'all-tools': true } })).html, 'use');
  ok(/data-fold-key="all-tools" open>/.test(opened), 'with the person’s own open recorded in state, the repaint keeps it open');
  ok(/save_working_state<\/span><span class="cur-fold-item-meta">What save_working_state does\. · 177 uses · last <span data-mcp-age-at=/.test(fold),
    'a used tool: its AGENT uses this week and its last agent use, ticking');
  ok(/get_tags<\/span><span class="cur-fold-item-meta">What get_tags does\. · not used this week<\/span>/.test(fold)
    && !/\bnever\b/i.test(fold.replace(/<[^>]+>/g, ' ')), 'an unused tool says "not used this week" — the word "never" appears nowhere');
}

// ═══════════════════════════════════════════════════════════════════════════
section('2. Tool activity counts AI apps, not test runs');
// ═══════════════════════════════════════════════════════════════════════════
{
  const st = baseState();
  st.mcpUsage = { ...st.mcpUsage, tools: st.mcpUsage.tools.map((t) => (t.name === 'get_node' ? { ...t, count7d: 500, count7dAgent: 2 } : t)) };
  const use = card(renderMcpPage(st).html, 'use');
  const mon = use.slice(use.indexOf('id="mcp-agent-use"'), use.indexOf('<div class="cur-folds"'));
  ok(/cur-mon-key">save_working_state<\/span><span class="cur-mon-value">[^]*177/.test(mon), 'the busiest tool is the AI apps’ busiest (177 saves)');
  ok(!/500/.test(mon), 'a test run’s 500 calls on get_node count for nothing (count7dAgent wins)');
  ok(/class="cur-depth/.test(mon) && !/cur-depth-over|budget/.test(mon), 'depth bars against the busiest — a max, never a budget (never red)');
  ok(/cur-mon-key">last time an AI app started My Curator<\/span><span class="cur-mon-value"><span class="fresh-dot fresh-[a-z]+"/.test(mon),
    'the deck’s first line: the last time an AI app started My Curator, with the app’s freshness dot');
  ok(!/last save|handoff saved/.test(mon), 'no handoff line (the owner, 2026-11-01: handoffs are the Context page’s)');
  ok(/<div class="cur-mon-note">16 tools not used this week\.<\/div>/.test(mon), 'its last line: how many tools went unused this week');
  ok(/class="cur-mon cur-mon-ident" id="mcp-agent-use"/.test(use), 'the keys are identifiers (`keys: \'identifier\'`): a tool name keeps its own case');
  ok(/id="mcp-meta-use">last use 17 min ago</.test(renderMcpPage(baseState()).html), 'the head reads "last use {age}"');
  const fresh = baseState({ mcpUsage: { present: false, tools: baseState().mcpUsage.tools.map((t) => ({ ...t, count7dAgent: 0, lastUsedAt: null, lastAgentAt: null })), sessions: {} },
    mcpInstall: { ...baseState().mcpInstall, status: { data: { ...baseState().mcpInstall.status.data, tools: [] } } } });
  const f = card(renderMcpPage(fresh).html, 'use');
  ok(/last time an AI app started My Curator<\/span><span class="cur-mon-value">—/.test(f) && /24 tools not used this week/.test(f),
    'a fresh install: a dash, and every tool not used this week — the deck’s own words, no invented empty state');
  const failedLog = card(renderMcpPage(baseState({ mcpUsage: null, mcpUsageError: 'disk' })).html, 'use');
  ok(/tx-status tx-status-danger[^]*Could not read which tools were used[^]*disk/.test(failedLog), 'an unreadable log is a danger status with the reason');
}

// ═══════════════════════════════════════════════════════════════════════════
section('3. The runner: in Connection test’s control row; its outcome is the result line');
// ═══════════════════════════════════════════════════════════════════════════
{
  const st = baseState();
  const bridge = card(renderMcpPage(st).html, 'bridge');
  const top = bridge.slice(bridge.indexOf('<div class="cur-card-top">'), bridge.indexOf('<div class="cur-folds"'));
  ok(/id="btn-mcp-self-test"[^>]*>[^]*Test connection/.test(top) && new RegExp('id="btn-mcp-exercise"[^>]*>[^]*Test all ' + st.mcpUsage.tools.length + ' tools').test(top),
    'Test connection and "Test all N tools" share the control row');
  const busy = card(renderMcpPage(baseState({ mcpExerciseBusy: true })).html, 'bridge');
  ok(/id="btn-mcp-exercise" disabled/.test(busy) && /Testing…/.test(busy), 'while it runs: disabled, and said on the button');
  const ran = baseState({ mcpExercise: { ranAt: new Date().toISOString(), durationMs: 1100, results: [
    { tool: 'get_node', ok: true }, { tool: 'search_wiki', ok: false }, { tool: 'save_foundation', refused: true, note: 'read-only mirror' }] } });
  const out = card(renderMcpPage(ran).html, 'bridge').replace(/<details[\s\S]*?<\/details>/g, '');
  ok(/cur-status-line[^]*<strong>Not working:<\/strong> no answer from search_wiki\./.test(out),
    'a run with a silent tool: "Not working: no answer from search_wiki." OUTSIDE every fold');
  const clean = card(renderMcpPage(baseState({ mcpExercise: { ranAt: new Date().toISOString(), durationMs: 500, results: [{ tool: 'a', ok: true }] } })).html, 'bridge');
  ok(/<strong>Works\.<\/strong> My Curator started and answered with all 1 tools \(\d\d:\d\d\)\./.test(clean), 'a clean run: "Works." with the time');
  const logged = card(renderMcpPage(baseState({ mcpUsage: { ...baseState().mcpUsage, lastExercise: { at: ago(9 * 60), total: 24, answered: 24, refused: 0, durationMs: 900 } } })).html, 'bridge');
  ok(/Works\.<\/strong> My Curator started and answered with all 24 tools/.test(logged), 'after a reload the last run is read back from the log');
  const err = card(renderMcpPage(baseState({ mcpExerciseError: 'It may not be reachable.' })).html, 'bridge');
  ok(/<strong>Not working:<\/strong> It may not be reachable\./.test(err), 'a run that did not finish: "Not working:" with the reason');
}

// ═══════════════════════════════════════════════════════════════════════════
section('4. The poll: nothing, or ONE card, never the column');
// ═══════════════════════════════════════════════════════════════════════════
{
  const FNS = ['refreshMcpUsage', 'paintMcpCard', 'paintMcpOverview', 'usageSignature', 'applyUsageVerdict'];
  function harness(stateOver, verdict, alive = true) {
    const writes = [];
    const node = (sel) => ({ set innerHTML(v) { writes.push({ sel, v }); }, querySelectorAll: () => [] });
    const doc = {
      querySelector: (s) => (s === '#mcp-card-use' ? node(s) : null),
      querySelectorAll: () => [], getElementById: () => null,
    };
    const state = Object.assign({ section: 'mcp', mcpUsage: null, mcpUsageSig: null, mcpUsageError: null, mcpProjects: null }, stateOver);
    const deps = { state, document: doc, fetchMcpUsage: async () => verdict, isCurrentMount: () => alive,
      loadAcrossProjects: async () => {}, renderToolMapBody: () => '<BODY/>', agentUseMetaWords: () => 'm',
      mcpOverviewHtml: () => '', wireMcpFolds: () => {}, wireMcpJumps: () => {},
      TOOL_MAP_BODY_SEL: '#mcp-card-use' };
    const names = Object.keys(deps);
    const api = new Function(...names, FNS.map((n) => extractFunction(SRC, n)).join('\n') + '\nreturn { refreshMcpUsage, usageSignature };')(...names.map((n) => deps[n]));
    return { writes, state, api };
  }
  const P = baseState().mcpUsage;
  const sig = harness({}, null).api.usageSignature(P);
  const same = harness({ mcpUsage: P, mcpUsageSig: sig }, { ok: true, data: { ...P } });
  await same.api.refreshMcpUsage(1);
  ok(same.writes.length === 0, 'an unchanged payload writes NOTHING');
  const bytes = harness({ mcpUsage: P, mcpUsageSig: sig }, { ok: true, data: { ...P, logBytes: 99999 } });
  await bytes.api.refreshMcpUsage(1);
  ok(bytes.writes.length === 0, 'a payload differing only in logBytes (nothing draws it) repaints nothing');
  const moved = harness({ mcpUsage: P, mcpUsageSig: sig }, { ok: true, data: { ...P, tools: P.tools.map((t, i) => (i === 0 ? { ...t, count7dAgent: 99 } : t)) } });
  await moved.api.refreshMcpUsage(1);
  ok(moved.writes.length === 1 && moved.writes[0].sel === '#mcp-card-use' && moved.writes[0].v === '<BODY/>',
    'a moved payload replaces ③’s CARD insides exactly once — never #view-root, never the column');
  const dead = harness({ mcpUsage: P, mcpUsageSig: 'stale' }, { ok: true, data: P }, false);
  await dead.api.refreshMcpUsage(1);
  ok(dead.writes.length === 0 && dead.state.mcpUsageSig === 'stale', 'a dead mount neither paints nor commits');
  const fail = harness({ mcpUsage: P, mcpUsageSig: sig }, { ok: false, error: 'nope' });
  await fail.api.refreshMcpUsage(1);
  ok(fail.state.mcpUsage === P && fail.state.mcpUsageError === 'nope', 'a failed poll keeps the last reading and records why');
  const other = harness({ section: 'general', mcpUsage: P, mcpUsageSig: 'stale' }, { ok: true, data: { ...P } });
  await other.api.refreshMcpUsage(1);
  ok(other.writes.length === 0 && other.state.mcpUsageSig !== 'stale', 'on another section: state moves, nothing paints');
}

// ═══════════════════════════════════════════════════════════════════════════
section('5. The poll is a chain, it arms once, and it stops on exit');
// ═══════════════════════════════════════════════════════════════════════════
{
  const make = (alive) => {
    const timers = []; const cleared = []; const poll = { timer: null }; let fetches = 0;
    const deps = { usagePoll: poll, USAGE_POLL_MS: 30000, setTimeout: (fn) => { timers.push(fn); return timers.length; },
      clearTimeout: (id) => cleared.push(id), isCurrentMount: () => alive(), refreshMcpUsage: async () => { fetches++; } };
    const names = Object.keys(deps);
    const api = new Function(...names, extractFunction(SRC, 'scheduleUsagePoll') + '\n' + extractFunction(SRC, 'stopUsagePoll')
      + '\nreturn { scheduleUsagePoll, stopUsagePoll };')(...names.map((n) => deps[n]));
    return { timers, cleared, poll, api, fetches: () => fetches };
  };
  const h = make(() => true);
  h.api.scheduleUsagePoll(1); h.api.scheduleUsagePoll(1);
  ok(h.timers.length === 2 && h.cleared.length === 1, 're-scheduling clears the old timer first — one armed timer');
  h.api.stopUsagePoll(); h.api.stopUsagePoll();
  ok(h.poll.timer === null && h.cleared.length === 2, 'stopping clears it once, and twice is a no-op');
  let alive = true;
  const d = make(() => alive);
  d.api.scheduleUsagePoll(1); alive = false; d.timers[0]();
  ok(d.fetches() === 0 && d.timers.length === 1, 'a tick after the mount moved on asks nothing and arms no successor');
  const l = make(() => true);
  l.api.scheduleUsagePoll(1); l.timers[0]();
  ok(l.fetches() === 1, 'CONTROL: on a live mount the same tick does ask');
}

// ═══════════════════════════════════════════════════════════════════════════
section('6. The age clock writes words into named nodes only, and never renders');
// ═══════════════════════════════════════════════════════════════════════════
{
  const body = extractFunction(SRC, 'tickMcpAges');
  ok(!/render\s*\(/.test(body), 'tickMcpAges never calls render() (v3.53.1)');
  const mk = (iso) => { const child = { textContent: 'stale' }; return { child, getAttribute: () => iso, querySelector: (s) => (s === '[data-mcp-age-words]' ? child : null) }; };
  const a = mk(ago(45 * 60)); const junk = mk('not-a-date');
  const meta = { textContent: 'old' };
  const doc = { querySelectorAll: () => [a, junk], getElementById: (id) => (id === 'mcp-meta-apps' ? meta : null) };
  const api = new Function('document', 'formatAge', 'mcpMetaAges', 'tickAges', body + '\nreturn tickMcpAges;')(
    doc, formatAge, { 'mcp-meta-apps': { iso: ago(120), prefix: 'checked' } }, () => 0);
  api();
  ok(a.child.textContent === '45 min ago', 'a hooked reading’s [data-mcp-age-words] child is recounted');
  ok(junk.child.textContent === 'stale', '…an unparseable stamp is left alone');
  ok(meta.textContent === 'checked 2 min ago', 'a section head’s reading ticks in place, by id');
  const html = renderMcpPage(baseState()).html;
  ok(!/mcp-age-words|mcp-session-reading/.test(html.replace(/data-mcp-age-words/g, '')), 'the hooks are data attributes — no class of this view’s own');
}

// ═══════════════════════════════════════════════════════════════════════════
section('7. The handoff section is gone (the owner, 2026-11-01)');
// ═══════════════════════════════════════════════════════════════════════════
{
  const html = renderMcpPage(baseState()).html;
  ok(!/mcp-card-projects|mcp-sec-projects|Across projects|Handoffs saved/.test(html), 'no ⑤ section, no per-project handoff reading on the page');
  ok((html.match(/class="cur-section-head"/g) || []).length === 4, 'four sections: Your AI apps · Skills · Connection test · Tool activity');
}

console.log('\n' + '─'.repeat(60));
console.log('Passed: ' + passed + '   Failed: ' + failed);
if (failed) { console.log('Tool map assertions FAILED'); process.exit(1); }
console.log('Tool map assertions green');
