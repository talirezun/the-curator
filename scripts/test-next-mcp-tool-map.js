#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  test-next-mcp-tool-map.js — Settings → MCP bridge → ③ "Agent use" and the
 *  runner ("Test all N tools", in ② Bridge's control row), rebuilt on the
 *  section kit in v3.89.0. EXECUTED: the real page through
 *  scripts/test-helpers/mcp-page-sandbox.js, and the real poll / clock
 *  functions lifted out of views/settings.js.
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS SUITE EXISTS TO STOP
 *   1. A TOOL DISAPPEARING: "All N tools" lists the WHOLE catalogue, used or
 *      not, N read from the payload (never a literal), and it is CLOSED by
 *      default (the owner's decision 6) — open only when the person opened it.
 *   2. THE WORD "NEVER": a tool with no line says "none since <log begins>".
 *   3. A TEST RUN COUNTED AS AGENT USE: the busiest list reads `count7dAgent`,
 *      never `count7d`.
 *   4. A WINDOW THE LOG DOES NOT COVER: "Last 5 days (log begins …)", once,
 *      in the monitor's own note.
 *   5. THE RUNNER'S OUTCOME FOLDED OR UNNAMED: it is a status in ② Bridge's
 *      card, unfolded, with the tools that did not answer BY NAME.
 *   6. THE POLL REPAINTING WHAT IT SHOULD NOT: an unchanged payload writes
 *      nothing; a moved one replaces ③'s CARD only (never the column); a dead
 *      mount paints nothing; a failed poll keeps the last reading.
 *   7. A LEAKING TIMER, and a clock that calls render() or writes a wrapper.
 *   8. ④ Across projects: identity dots before the key, depth bars with a
 *      `max`, "+" explained in the monitor's own note, idle projects in ONE
 *      fold with a count.
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
section('1. "All N tools": the whole catalogue, closed by default, N from the payload');
// ═══════════════════════════════════════════════════════════════════════════
{
  const st = baseState();
  const N = st.mcpUsage.tools.length;
  const use = card(renderMcpPage(st).html, 'use');
  const fold = (use.match(/<details class="cur-fold" data-fold-key="all-tools"[\s\S]*?<\/details>/) || [''])[0];
  ok(new RegExp('<span class="cur-fold-label">All ' + N + ' tools</span><span class="cur-fold-pill">' + N + '</span>').test(fold),
    'the fold row reads "All ' + N + ' tools" with its count pill — N is the payload’s own length');
  ok(/data-fold-key="all-tools">/.test(fold), '…CLOSED by default (the owner’s decision 6)');
  const items = fold.match(/class="cur-fold-item"/g) || [];
  ok(items.length === N, 'one fold item per tool, used or not (' + items.length + ' of ' + N + ')');
  const missing = st.mcpUsage.tools.filter((t) => !fold.includes('<span class="mono cur-fold-item-main">' + t.name + '</span>'));
  ok(missing.length === 0, 'every tool is listed by its own name', missing.map((t) => t.name).join(','));
  const opened = card(renderMcpPage(baseState({ setupMachineFolds: { 'all-tools': true } })).html, 'use');
  ok(/data-fold-key="all-tools" open>/.test(opened), 'with the person’s own open recorded in state, the repaint keeps it open');
  const begins = new Date(Date.parse(st.mcpUsage.logStartedAt));
  const day = begins.getDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][begins.getMonth()];
  ok(fold.includes('none since ' + day) && !/\bnever\b/i.test(fold.replace(/<[^>]+>/g, ' ')),
    'an unused tool says "none since ' + day + '" — the word "never" appears nowhere');
  ok(/<span class="mono cur-fold-item-main">save_working_state<\/span><span class="cur-fold-item-meta">write · 177 calls · last <span data-mcp-age-at=/.test(fold),
    'a used tool: its group, its AGENT calls in the window and its last agent use, ticking');
}

// ═══════════════════════════════════════════════════════════════════════════
section('2. Agent use counts agents, not test runs, and states its true window once');
// ═══════════════════════════════════════════════════════════════════════════
{
  const st = baseState();
  st.mcpUsage = { ...st.mcpUsage, tools: st.mcpUsage.tools.map((t) => (t.name === 'get_node' ? { ...t, count7d: 500, count7dAgent: 2 } : t)) };
  const use = card(renderMcpPage(st).html, 'use');
  const mon = use.slice(use.indexOf('id="mcp-agent-use"'), use.indexOf('<div class="cur-folds"'));
  ok(/cur-mon-key">save_working_state<\/span><span class="cur-mon-value">[^]*177/.test(mon), 'the busiest tool is the agents’ busiest (177 saves)');
  ok(!/500/.test(mon), 'a test run’s 500 calls on get_node count for nothing (count7dAgent wins)');
  ok(/class="cur-depth/.test(mon) && !/cur-depth-over|budget/.test(mon), 'depth bars against the busiest — a max, never a budget (never red)');
  ok(/cur-mon-key">last session start<\/span><span class="cur-mon-value"><span class="fresh-dot fresh-[a-z]+"/.test(mon),
    'the session readings carry the app’s freshness dot before the age');
  ok(/class="cur-mon cur-mon-ident" id="mcp-agent-use"/.test(use), 'the keys are identifiers (`keys: \'identifier\'`): a tool name keeps its own case');
  const young = baseState();
  young.mcpUsage = { ...young.mcpUsage, logStartedAt: ago(5 * 86400) };
  const ym = card(renderMcpPage(young).html, 'use');
  ok(/<div class="cur-mon-note">Last 5 days \(from \d+ \w{3}\) · [^<]*tests excluded<\/div>/.test(ym) && !/this week|7 days/i.test(ym),
    'a 5-day log says "Last 5 days (from …)" in the monitor’s own note, and nothing about a week');
  const fresh = baseState({ mcpUsage: { present: false, tools: baseState().mcpUsage.tools.map((t) => ({ ...t, lastUsedAt: null, lastAgentAt: null })), sessions: {} } });
  ok(/cur-status-line[^]*No calls recorded yet/.test(card(renderMcpPage(fresh).html, 'use')), 'a fresh install says so on the one-line status card — no empty monitor');
  const failedLog = card(renderMcpPage(baseState({ mcpUsage: null, mcpUsageError: 'disk' })).html, 'use');
  ok(/tx-status tx-status-danger[^]*The call log could not be read[^]*disk/.test(failedLog), 'an unreadable log is a danger status with the reason');
}

// ═══════════════════════════════════════════════════════════════════════════
section('3. The runner: in Bridge’s control row; its outcome unfolded, failures by name');
// ═══════════════════════════════════════════════════════════════════════════
{
  const st = baseState();
  const bridge = card(renderMcpPage(st).html, 'bridge');
  const top = bridge.slice(bridge.indexOf('<div class="cur-card-top">'), bridge.indexOf('<div class="cur-folds"'));
  ok(/id="btn-mcp-self-test"/.test(top) && new RegExp('id="btn-mcp-exercise"[^>]*>[^]*Test all ' + st.mcpUsage.tools.length + ' tools').test(top),
    'Run self-test and "Test all N tools" share Bridge’s control row (the owner’s decision 2: the self-test keeps its own button)');
  const busy = card(renderMcpPage(baseState({ mcpExerciseBusy: true })).html, 'bridge');
  ok(/id="btn-mcp-exercise" disabled/.test(busy) && /Testing every tool against a throwaway copy/.test(busy), 'while it runs: disabled, and said');
  const ran = baseState({ mcpExercise: { ranAt: new Date().toISOString(), durationMs: 1100, results: [
    { tool: 'get_node', ok: true }, { tool: 'search_wiki', ok: false }, { tool: 'save_foundation', refused: true, note: 'read-only mirror' }] } });
  const out = card(renderMcpPage(ran).html, 'bridge').replace(/<details[\s\S]*?<\/details>/g, '');
  ok(/tx-status tx-status-danger[^]*Last full test just now: 2 of 3 answered · 1 refused · 1\.1 s/.test(out),
    'the outcome is a status OUTSIDE every fold: answered, refused, seconds');
  ok(/No answer from: search_wiki\./.test(out) && /save_foundation refused — read-only mirror\./.test(out), '…naming the tool that did not answer and the refusal’s reason');
  const clean = card(renderMcpPage(baseState({ mcpExercise: { ranAt: new Date().toISOString(), durationMs: 500, results: [{ tool: 'a', ok: true }] } })).html, 'bridge');
  ok(/tx-status tx-status-success[^]*1 of 1 answered/.test(clean), 'a clean run is a success status');
  const logged = card(renderMcpPage(baseState({ mcpUsage: { ...baseState().mcpUsage, lastExercise: { at: ago(9 * 60), total: 24, answered: 24, refused: 0, durationMs: 900 } } })).html, 'bridge');
  ok(/Last full test 9 min ago: 24 of 24 answered/.test(logged), 'after a reload the last run is read back from the log, and says when');
  const err = card(renderMcpPage(baseState({ mcpExerciseError: 'The bridge may not be reachable.' })).html, 'bridge');
  ok(/tx-status tx-status-danger[^]*Test all tools did not finish[^]*not be reachable/.test(err), 'a run that did not finish says so, with the reason');
}

// ═══════════════════════════════════════════════════════════════════════════
section('4. The poll: nothing, or ONE card, never the column');
// ═══════════════════════════════════════════════════════════════════════════
{
  const FNS = ['refreshMcpUsage', 'paintMcpCard', 'paintMcpOverview', 'usageSignature', 'acrossProjectsStamp', 'applyUsageVerdict'];
  function harness(stateOver, verdict, alive = true) {
    const writes = [];
    const node = (sel) => ({ set innerHTML(v) { writes.push({ sel, v }); }, querySelectorAll: () => [] });
    const doc = {
      querySelector: (s) => (s === '#mcp-card-use' || s === '#mcp-card-projects' ? node(s) : null),
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
section('7. ④ Across projects');
// ═══════════════════════════════════════════════════════════════════════════
{
  const html = renderMcpPage(baseState()).html;
  const p = card(html, 'projects');
  ok(/id="mcp-meta-projects">last 30 days</.test(html), 'the ONE window is the section head’s reading');
  ok(/<span class="cur-mon-key"><span class="cur-mon-lead"><span class="cur-sb-dot cur-sb-dot-5" aria-hidden="true"><\/span><\/span>projects \/ agentlink<\/span>/.test(p),
    'the domain’s RECORDED identity slot (projects = 5) dots the line, before the key (rule 5)', p.slice(0, 600));
  ok(/projects \/ curator[^]*12\+/.test(p) && /<div class="cur-mon-note">[^<]*“\+” means at least/.test(p), 'a floor reads "12+", and the monitor’s own note says what "+" means');
  ok(/cur-depth/.test(p) && !/budget|cur-depth-over/.test(p), 'depth bars with a max (rule 6, never red)');
  ok(/<span class="cur-fold-label">No save in the last 30 days<\/span><span class="cur-fold-pill">1<\/span>/.test(p)
    && /cur-sb-dot-2[^]*articles \/ field-notes/.test(p), 'projects with no save: ONE fold row with a count, each with its dot');
  ok(/<span class="cur-fold-label">Saves per agent app<\/span><span class="cur-fold-meta">Claude Code 53 · Antigravity none since 25 Oct<\/span>/.test(p),
    'saves per agent app: its reading is the fold row’s meta, visible closed');
  const none = card(renderMcpPage(baseState({ mcpProjects: null, mcpProjectsError: 'This server does not report connections per project.' })).html, 'projects');
  ok(/tx-status tx-status-attention[^]*does not report/.test(none), 'an older server is said, not shown as zero');
}

console.log('\n' + '─'.repeat(60));
console.log('Passed: ' + passed + '   Failed: ' + failed);
if (failed) { console.log('Tool map assertions FAILED'); process.exit(1); }
console.log('Tool map assertions green');
