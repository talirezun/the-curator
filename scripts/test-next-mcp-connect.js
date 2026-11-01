#!/usr/bin/env node
/**
 * test-next-mcp-connect.js — v3.85.0, re-cut v3.88.0. Settings › MCP bridge ›
 * block 1 "Connect your agent apps" (v3.85.0's blocks 1 and 5 merged), the
 * REAL renderConnectApps() and renderSelfTestResult() lifted out of
 * views/settings.js and EXECUTED with the real DOM-free builders.
 *
 *   §1 the MCP wizard stays gone; nothing in /next writes a foreign config
 *      except through the install routes
 *   §2 one block: the agent-app rows, then "Bridge answers"; no "Install in
 *      your tools" scroll button, no machine name, no hard-coded client
 *   §3 THE STALE-BRIDGE RULE ON THE PAGE (the owner's decision 3): a bridge
 *      serving the same tools warns NOWHERE; a bridge whose tools changed
 *      warns ONCE, on its own app's row, never in "Bridge answers"; one the
 *      app cannot name gets one soft line in "Bridge answers"
 *   §4 "Bridge answers": version, knowledge folder, open now, self-test, and
 *      its own Run self-test button (the owner's decision 2)
 *   §5 a missing knowledge folder is not an empty one (carried over)
 *   §6 the client list and the ChatGPT exclusion live in the ⓘ, and the docs
 *      name the same clients
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { explainerMark } from '../src/public/next/shared/explainer.js';
import { EXPLAINERS } from '../src/public/next/shared/explainers.js';
import { formatAge } from '../src/public/next/shared/age.js';
import { renderMonitor } from '../src/public/next/shared/monitor.js';
import * as MI from '../src/public/next/views/mcp-install.js';
import { checkHead } from '../src/public/next/views/setup-machine.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const NEXT = path.join(ROOT, 'src/public/next');
let passed = 0, failed = 0;
const ok = (c, l, d) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failed++; console.log(`  ✗ ${l}${d !== undefined ? `\n      ${String(d).slice(0, 500)}` : ''}`); } };
const section = (t) => console.log(`\n${t}`);

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
}
function extractFunction(src, name) {
  const m = new RegExp(`(?:^|\\n)(?:async\\s+)?function ${name}\\s*\\(`).exec(src);
  if (!m) throw new Error(`extractFunction: "${name}" not found`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  let p = src.indexOf('(', start); let d = 0;
  for (; p < src.length; p++) { if (src[p] === '(') d++; else if (src[p] === ')') { d--; if (d === 0) { p++; break; } } }
  let i = src.indexOf('{', p); d = 0;
  for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}') { d--; if (d === 0) { i++; break; } } }
  const out = src.slice(start, i);
  if (!/\n\}$/.test(out)) throw new Error(`extractFunction: "${name}" desynced`);
  return out;
}
function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const f = path.join(dir, n);
    if (statSync(f).isDirectory()) walk(f, out); else out.push(f);
  }
  return out;
}

const settings = readFileSync(path.join(NEXT, 'views/settings.js'), 'utf8');
const settingsCode = stripComments(settings);
const files = walk(NEXT);
const jsCode = files.filter((f) => f.endsWith('.js')).map((f) => [path.relative(ROOT, f), stripComments(readFileSync(f, 'utf8'))]);

// ── §1 ─────────────────────────────────────────────────────────────────────
section('§1 the wizard is gone, and block 1 writes only through the install routes');
ok(!existsSync(path.join(NEXT, 'views/mcp-wizard.js')) && !existsSync(path.join(NEXT, 'views/mcp-wizard.css')), 'views/mcp-wizard.js and .css are deleted');
const offenders = jsCode.filter(([, c]) => /openMcpWizard|closeMcpWizardIfOpen|mcp-wizard\.js|btn-mcp-wizard|btn-mcp-view-config|btn-mcp-copy-snippet|MCP_GUIDE_URL/.test(c)).map(([f]) => f);
ok(offenders.length === 0, 'no /next script opens or addresses the wizard or its retired buttons', offenders.join(', '));
ok(!/mcp-wizard/.test(readFileSync(path.join(NEXT, 'index.html'), 'utf8')), 'index.html links no wizard stylesheet');
const callers = jsCode.filter(([, c]) => /\/api\/mcp\/(write-config|claude-config|claude-full-config)/.test(c)).map(([f]) => f);
ok(callers.length === 0, 'no UI code calls /api/mcp/write-config, /claude-config or /claude-full-config', callers.join(', '));
const retired = jsCode.filter(([, c]) => /btn-mcp-install-tools|focusInstallPanel|Install in your tools|renderToolsOnThisMac/.test(c)).map(([f]) => f);
ok(retired.length === 0, 'the "Install in your tools" scroll button, its door and the block-5 renderer are gone from every script', retired.join(', '));

// ── the harness: the real block 1, executed ────────────────────────────────
const fnNames = ['settingsBlock', 'installPlatform', 'installRevealPaths', 'installMachineFiles', 'currentBridgeFacts',
  'installWords', 'ageSecondsOf', 'lastSelfTest', 'renderSelfTestResult', 'renderConnectApps'];
const src = fnNames.map((n) => extractFunction(settingsCode, n)).join('\n');
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const factory = new Function('state', 'escapeHtml', 'explainerMark', 'checkHead', 'renderInstallPanel', 'adaptMachine', 'adaptBridges',
  'tildePath', 'machineWord', 'renderMonitor', 'formatAge',
  src + '\nreturn { renderConnectApps, renderSelfTestResult };');
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const ENTRY = '{"mcpServers":{"my-curator":{"command":"/x/launcher","args":[]}}}';
function baseState(over = {}) {
  return {
    mcp: { domains_dir: '/Users/ann/second-brain/domains', domains_dir_exists: true, mcp_server_exists: true,
      bridge_processes: { checked: true, running: 0, stale: [], bridges: [], current: { version: '3.88.0', toolsHash: 'aaaa', toolCount: 24 } } },
    selfTest: null, selfTestAt: null, selfTestLoading: false, setupMachineCopied: null, setupMachineFolds: {},
    mcpUsage: { tools: new Array(24).fill(0).map((_, i) => ({ name: 't' + i })) },
    setupMachine: { data: { ok: true, checkedAt: iso(2000), version: '3.88.0', install: 'Packaged app', skillsShipped: true,
      machine: { ids: ['annes-macbook-a1b2c3'] },
      harnesses: [{ id: 'claude-desktop', label: 'Claude Desktop', bridge: { state: 'ok', word: 'configured' },
        skills: { state: 'cant-check', word: 'can’t check here', note: 'held by your Claude account', installed: [] },
        hooks: { state: 'none', format: 'none', files: [] },
        files: [{ file: '/Users/ann/Library/Application Support/Claude/claude_desktop_config.json', display: '~/Library/Application Support/Claude/claude_desktop_config.json', via: 'own', present: true, named: true, status: 'ok' }] }] } },
    mcpInstall: { status: { data: { platform: 'darwin', writable: true, notFound: [{ id: 'cursor', label: 'Cursor' }], manualSnippets: { cursor: ENTRY },
      tools: [{ id: 'claude-desktop', label: 'Claude Desktop', status: 'connected', installer: 'file', running: { checked: true, running: true },
        files: [{ display: '~/Library/Application Support/Claude/claude_desktop_config.json', state: 'connected' }], bridges: null }] } },
      ticks: {}, plan: null, results: null, busy: null, error: null, copied: null },
    ...over,
  };
}
function render(state) {
  const f = factory(state, esc, explainerMark, checkHead, MI.renderInstallPanel, MI.adaptMachine, MI.adaptBridges,
    MI.tildePath, MI.machineWord, renderMonitor, formatAge);
  return f.renderConnectApps();
}
const bridgeAnswers = (html) => (html.match(/<div class="mcp-bridge-panel">[\s\S]*?id="btn-mcp-self-test"[^>]*>[^<]*<\/button><\/div><\/div>/) || [''])[0];
const rowOf = (html, id) => (html.match(new RegExp('<div class="mcpi-row[^"]*" data-mcpi-tool="' + id + '">[\\s\\S]*?(?=<div class="mcpi-row|</div><details class="settings-setup-fold mcpi-notfound|<div class="mcp-bridge-panel">)')) || [''])[0];

// ── §2 ─────────────────────────────────────────────────────────────────────
section('§2 one block: the agent apps, then the bridge');
{
  const html = render(baseState());
  ok(/<h2 class="settings-job-title">Connect your agent apps<\/h2>/.test(html) && /settings-block-mcp-connect/.test(html), 'titled "Connect your agent apps", block id mcp-connect');
  ok(/Which agent apps on this Mac reach My Curator, and what each needs\./.test(html), 'the lede names agent apps and this Mac');
  ok(html.indexOf('MY CURATOR IN YOUR AGENT APPS') < html.indexOf('data-mcpi-tool="claude-desktop"')
    && html.indexOf('data-mcpi-tool="claude-desktop"') < html.indexOf('Not on this Mac (1)')
    && html.indexOf('Not on this Mac (1)') < html.indexOf('mcp-bridge-panel'), 'order: overview, rows, "Not on this Mac", then Bridge answers');
  ok(/data-setup-act="machine-check"/.test(html) && /checked/.test(html), 'the head: checked · Check again');
  ok(!/annes-macbook|a1b2c3/.test(html), 'no machine name on this page (the owner’s decision 4)');
  ok(!/cur-mon-key">client</.test(html) && /cur-mon-key">version</.test(html), 'no hard-coded "client: Claude Desktop" monitor line (truth audit T1); CONTROL: the monitor keys are there');
  ok(!/Install in your tools|Tools on this Mac|EACH TOOL IN DETAIL/i.test(html), 'no scroll button, no block-5 title, no second list of the same apps');
  ok(/The check only reads whether each file names my-curator\. Install for me writes only that entry/.test(html), 'the footnote, shortened, still says what is read and what is written');
  const win = render(baseState({ mcpInstall: { ...baseState().mcpInstall, status: { data: { ...baseState().mcpInstall.status.data, platform: 'win32' } } } }));
  ok(/on this PC reach My Curator/.test(win) && !/on this Mac/.test(win), 'win32: "this PC" — shared/platform.js’s word');
}

// ── §3 ─────────────────────────────────────────────────────────────────────
section('§3 the stale-bridge rule, on the page');
const bridge = (o) => ({ pid: 7, startedAt: iso(4 * 3600e3), ageMs: 4 * 3600e3, app: { id: 'claude-desktop', label: 'Claude Desktop', checked: true },
  version: '3.87.1', toolsHash: 'aaaa', tools: 'same', olderThanCode: true, notice: 'quiet', remedy: null, ...o });
const withBridges = (list, extra = {}) => {
  const s = baseState();
  s.mcp.bridge_processes = { ...s.mcp.bridge_processes, running: list.length, bridges: list,
    stale: list.filter((b) => b.tools === 'different').map((b) => ({ pid: b.pid, startedAt: b.startedAt })), ...extra };
  return s;
};
const REMEDY = 'Quit Claude Desktop (⌘Q — closing the window is not enough) and reopen it. This also ends Claude Code sessions in its Code tab.';
{
  const same = render(withBridges([bridge(), bridge({ pid: 8 })]));
  ok(!/cur-mon-loud/.test(same), 'SAME TOOLS: no warning anywhere in the block', (same.match(/cur-mon-loud[^<]*<[^<]*/) || [''])[0]);
  ok(/Running My Curator 3\.87\.1 since \d\d:\d\d — the same 24 tools as 3\.88\.0\. It moves to 3\.88\.0 the next time you quit Claude Desktop\./.test(rowOf(same, 'claude-desktop')),
    '…one quiet line on the app’s row instead', rowOf(same, 'claude-desktop'));
  ok((same.match(/the same 24 tools as/g) || []).length === 1, '…said once, not once per bridge');
  ok(/2 bridges · Claude Desktop/.test(bridgeAnswers(same)) && /same tools as this version/.test(bridgeAnswers(same)), '"open now": 2 bridges · Claude Desktop, same tools as this version');
  const current = render(withBridges([bridge({ version: '3.88.0', notice: 'none' })]));
  ok(!/cur-mon-loud/.test(current) && !/the same 24 tools as/.test(current), 'same tools AND the same version: nothing to say');

  const diff = render(withBridges([bridge({ tools: 'different', notice: 'warn', toolsHash: 'bbbb', remedy: REMEDY })]));
  const row = rowOf(diff, 'claude-desktop');
  ok(/cur-mon-loud cur-mon-warn mcpi-warn[^>]*data-mcpi-warn="bridge"/.test(row) && /Claude Desktop is still using My Curator 3\.87\.1, opened at \d\d:\d\d/.test(row),
    'TOOLS CHANGED: a warning on THAT app’s row, naming the version and when it opened', row);
  ok(row.includes('<strong>' + esc(REMEDY) + '</strong>'), '…with the payload’s quit step verbatim (⌘Q, and the Code-tab consequence)');
  ok(/data-mcpi-restart-needed>restart needed</.test(row), '…and a "restart needed" mark beside the status');
  ok(!/cur-mon-loud/.test(bridgeAnswers(diff)) && /serves older tools — see its app above/.test(bridgeAnswers(diff)), '"Bridge answers" counts it in words and repeats no warning');
  ok((diff.match(/data-mcpi-warn="bridge"/g) || []).length === 1, 'the fact is told exactly once on the page');
  ok(!/<details[^>]*>(?:(?!<\/details>)[\s\S])*data-mcpi-warn="bridge"/.test(diff), 'the warning is never inside a <details>');
  ok(/>TO FIX<\/div><div class="cur-ov-value">1</.test(diff) || /TO FIX[\s\S]{0,80}>1</.test(diff), 'the overview counts the app as to fix');

  const soft = render(withBridges([bridge({ tools: 'unknown', notice: 'soft', version: null, toolsHash: null, remedy: REMEDY })]));
  ok(/data-mcpi-warn="bridge-unknown"/.test(rowOf(soft, 'claude-desktop')) && /cur-mon-quiet/.test(rowOf(soft, 'claude-desktop'))
    && /can’t tell whether its tools changed/.test(rowOf(soft, 'claude-desktop')), 'UNKNOWN: one SOFT line on the row ("can’t tell")');
  ok(!/<strong>/.test(rowOf(soft, 'claude-desktop').match(/data-mcpi-warn="bridge-unknown"[\s\S]*?<\/div>/)[0]), '…softly: the quit step is not set in bold');

  const orphan = render(withBridges([bridge({ app: { id: null, label: 'another app', checked: true }, tools: 'unknown', notice: 'soft', remedy: 'Quit the app and reopen it.' })]));
  ok(/could not name/.test(bridgeAnswers(orphan)) && /cur-mon-loud cur-mon-quiet/.test(bridgeAnswers(orphan)) && !/data-mcpi-warn="bridge/.test(orphan),
    'a bridge no app can be named for: one soft line in "Bridge answers", none on a row');
  const notLooked = render(withBridges([], { checked: false, reason: 'ps is not available' }));
  ok(/not checked/.test(bridgeAnswers(notLooked)) && /ps is not available/.test(bridgeAnswers(notLooked)) && !/>none</.test(bridgeAnswers(notLooked)),
    '`checked: false` reads "not checked", never "none"');
  const old = render(withBridges([], {}));
  ok(/>none</.test(bridgeAnswers(old)), 'nothing open: "none"');
}

// ── §4 ─────────────────────────────────────────────────────────────────────
section('§4 "Bridge answers"');
{
  const none = bridgeAnswers(render(baseState()));
  ok(/Not tested yet/.test(none) && /not run yet/.test(none), 'before any self-test: "Not tested yet", never a claim that it answers');
  ok(/3\.88\.0 · Mac app/.test(none), 'version · install kind ("Mac app")');
  ok(/~\/second-brain\/domains/.test(none) && !/\/Users\/ann/.test(none), 'the knowledge folder, shortened by the home the machine reading shows');
  ok(/id="btn-mcp-self-test"[^>]*>Run self-test</.test(none), 'its own Run self-test button (the owner’s decision 2)');
  const s = baseState({ selfTest: { ok: true, tool_count: 24, domains_status: 'ok', domains: ['a'] }, selfTestAt: iso(9 * 60e3) });
  const okHtml = bridgeAnswers(render(s));
  ok(/Bridge answers/.test(okHtml) && /24 tools · <span data-mcp-age-at="[^"]+"><span class="mcp-age-words">9 min ago</.test(okHtml), 'after a pass: "Bridge answers" · self-test "24 tools · 9 min ago", on the ticking hook', okHtml);
  ok(!/older tool list|not the one already open/.test(okHtml), 'the self-test never claims anything about an OPEN bridge');
  const logged = bridgeAnswers(render(baseState({ mcpUsage: { tools: [], lastSelfTest: { at: iso(3600e3), ok: true, toolCount: 24 } } })));
  ok(/Bridge answers/.test(logged) && /1 hr ago/.test(logged), 'after a reload, the usage log’s last self-test keeps the reading (when the server sends it)');
  const fail = bridgeAnswers(render(baseState({ selfTest: { ok: false, error: 'spawn ENOENT' }, selfTestAt: iso(1000) })));
  ok(/Self-test failed/.test(fail) && /cur-mon-loud cur-mon-danger[^>]*>spawn ENOENT/.test(fail), 'a failed self-test: its message, loud');
  ok(/Testing…/.test(bridgeAnswers(render(baseState({ selfTestLoading: true })))), 'while it runs, the button says Testing… and is disabled');
}

// ── §5 ─────────────────────────────────────────────────────────────────────
section('§5 a missing knowledge folder is not an empty one');
{
  const run = (r) => bridgeAnswers(render(baseState({ selfTest: { ok: true, tool_count: 24, ...r }, selfTestAt: iso(1000) })));
  const missing = run({ domains_status: 'missing_folder', domains_dir: '/Users/ann/nope' });
  const empty = run({ domains_status: 'empty', domains: [] });
  const fine = run({ domains_status: 'ok', domains: ['a', 'b'] });
  ok(/knowledge folder is missing/.test(missing) && /~\/nope does not exist/.test(missing) && /not a mistake in an agent app’s config file/.test(missing), 'missing folder: said, with its path, and not blamed on an agent app’s config');
  ok(/folder is empty/.test(empty) && !/is missing/.test(empty), 'empty folder: its own sentence');
  ok(!/is missing|is empty/.test(fine), 'a healthy folder: neither');
  ok(/cur-mon-loud/.test(missing) && !/<details/.test(missing), 'the missing-folder warning is a loud entry, never inside a fold');
  const pre = bridgeAnswers(render(baseState({ mcp: { ...baseState().mcp, domains_dir_exists: false } })));
  ok(/knowledge folder is missing/.test(pre), 'the config payload says so before any self-test');
}

// ── §6 ─────────────────────────────────────────────────────────────────────
section('§6 the client list lives in the ⓘ, and the docs back it');
{
  const e = EXPLAINERS['settings.mcp-connect'];
  const all = JSON.stringify(e);
  const guide = readFileSync(path.join(ROOT, 'docs/mcp-user-guide.md'), 'utf8');
  for (const c of ['Claude Desktop', 'Claude Code', 'Cursor']) { ok(all.includes(c), `the ⓘ names ${c}`); ok(guide.includes(c), `CONTROL: docs/mcp-user-guide.md names ${c} too`); }
  ok(/ChatGPT[^.]*cannot run (?:a )?local server/.test(all), '…and the honest exclusion, as a MECHANISM');
  ok(e.title === 'Connect your agent apps', 'the ⓘ is titled like the block');
  ok(/class="tx-vh-panel"[^>]*hidden/.test(render(baseState())), 'the explanation is a closed fold in the shipped markup');
}

console.log(`\nPassed: ${passed}   Failed: ${failed}`);
process.exit(failed ? 1 : 0);
