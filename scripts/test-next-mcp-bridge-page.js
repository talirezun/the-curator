#!/usr/bin/env node
/**
 * test-next-mcp-bridge-page.js — v3.88.0, re-cut v3.89.0. Settings › MCP
 * bridge as a WHOLE PAGE: the real renderMcp() (scripts/test-helpers/
 * mcp-page-sandbox.js) fed the payload shapes of GET /api/mcp/config
 * (`bridge_processes.bridges[]`), /install/status (`counts`, `verdict`,
 * `skill`, `connectedVia`, `usedWithoutEntry`, `bridges`), /setup/machine and
 * /usage. Exists to stop (each proved by mutation in v3.88.0, re-pinned here
 * on the section-kit page):
 *   §1 the OVERVIEW disagreeing with the rows, or colouring without a word:
 *      the backend's counts, success ink on CONNECTED, attention ink on TO FIX
 *      only above 0, every figure a door to its section;
 *   §2 a bridge serving the SAME tools raising a warning (the owner's
 *      decision 3): one quiet line in its row, nothing in the Next step card;
 *      a bridge whose tools CHANGED is a fix, unfolded, naming what is missing;
 *      one whose tools nobody recorded is a SOFT reading in the row's meta;
 *   §3 a fix behind a chevron: the outdated skill is said in the Next step
 *      card with Download (this app's own zip) and Reveal, for its app;
 *   §4 one app read two ways: Claude Code "through Claude Desktop", an old
 *      use with no entry explained;
 *   §5 the Windows reasons said for a person; no machine name anywhere;
 *   §6 the head readings: checked · self-test · last call · window.
 * OFFLINE.
 */
import { renderMcpPage, baseState } from './test-helpers/mcp-page-sandbox.js';

let passed = 0, failed = 0;
const ok = (c, l, d) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failed++; console.log(`  ✗ ${l}${d !== undefined ? `\n      ${String(d).slice(0, 500)}` : ''}`); } };
const section = (t) => console.log(`\n${t}`);
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const page = (over) => renderMcpPage(baseState(over)).html;
const ov = (html) => html.slice(0, html.indexOf('<div class="cur-section-head"'));
const next = (html) => (html.match(/<div class="cur-action"[^>]*>[\s\S]*?<div class="cur-action-footnote">[\s\S]*?<\/div><\/div>/) || [''])[0];
const row = (html, id) => (html.match(new RegExp('<details class="cur-fold" data-fold-key="app-' + id + '"[\\s\\S]*?</details>')) || [''])[0];
const withData = (fn) => { const s = baseState(); fn(s.mcpInstall.status.data, s); return s; };

section('§1 the overview');
{
  const h = page();
  const o = ov(h);
  ok(/<section class="cur-ov settings-ov-section"/.test(o) && /OVERVIEW/.test(o), 'ONE overview, first in the column (rule 1)');
  ok(/data-ov-jump="mcp-sec-apps"[^]*CONNECTED<\/div><div class="cur-ov-value settings-ov-ok">2</.test(o), 'CONNECTED is the backend’s count, in the success ink');
  ok(/data-ov-jump="mcpi-next-step"[^]*TO FIX<\/div><div class="cur-ov-value settings-ov-attn">1</.test(o), 'TO FIX in the attention ink, and its door is the Next step card');
  ok(/data-ov-jump="mcp-sec-bridge"[^]*TOOLS ANSWER<\/div><div class="cur-ov-value">24</.test(o), 'TOOLS ANSWER: the last self-test’s count (from the log after a reload)');
  ok(/SAVES · 7 DAYS<\/div><div class="cur-ov-value">177</.test(o), 'SAVES: the agents’ save_working_state calls in the window');
  ok(/LAST SAVE<\/div><div class="cur-ov-value"><span class="fresh-dot fresh-[a-z]+" aria-hidden="true"><\/span><span data-age-at=[^>]*>51 min ago</.test(o), 'LAST SAVE: the freshness dot, then a ticking age');
  const zero = ov(renderMcpPage(withData((d) => { d.counts = { connected: 0, toFix: 0, notConnected: 4 }; })).html);
  ok(!/settings-ov-ok|settings-ov-attn/.test(zero), 'no ink at all when nothing is connected and nothing is to fix — colour only ever beside a non-zero word');
  ok(/TOOLS ANSWER<\/div><div class="cur-ov-value">—<\/div><div class="cur-ov-sub">not tested yet</.test(ov(page({ mcpUsage: { ...baseState().mcpUsage, lastSelfTest: null } }))),
    'no self-test yet: a dash and "not tested yet", never a guessed 24');
}

section('§2 the stale-bridge rule');
{
  const withBridge = (b) => withData((d) => { d.tools[0] = { ...d.tools[0], bridges: { count: 1, oldestStartedAt: iso(4 * 3600e3), version: '3.88.0', toolCount: 24, ...b } }; });
  const same = renderMcpPage(withBridge({ tools: 'same', notice: 'quiet' }), {}).html;
  ok(!/data-mcpi-warn="bridge"/.test(next(same)) && /data-mcpi-quiet="bridge-same"[^]*the same 24 tools as 3\.89\.0/.test(row(same, 'claude-desktop')),
    'the SAME tools: no fix anywhere, one quiet line in its row');
  const changed = renderMcpPage(withBridge({ tools: 'changed', notice: 'warn', missing: ['save_foundation'], remedy: 'Quit Claude Desktop and reopen it.' })).html;
  ok(/data-mcpi-warn="bridge">Claude Desktop is still using My Curator 3\.88\.0[^<]*it lacks save_foundation\. Quit Claude Desktop and reopen it\./.test(next(changed)),
    'CHANGED tools: a fix in the Next step card, naming what is missing, with the route’s own remedy');
  const unknown = renderMcpPage(withBridge({ tools: 'unknown', notice: 'soft' })).html;
  ok(/<span class="cur-fold-meta">connected · running · open since before this version/.test(row(unknown, 'claude-desktop')) && !/data-mcpi-warn="bridge/.test(next(unknown)),
    'UNKNOWN tools: a soft reading in the row’s meta (visible closed), never a fix');
}

section('§3 the skill fix, unfolded, with Download and Reveal');
{
  const h = page();
  const n = next(h);
  ok(/NEXT STEP · 1 TO FIX/.test(n) && /data-mcpi-warn="skill">Antigravity’s my-curator skill is older than this app’s copy/.test(n), 'the sentence, in the Next step card, for its app');
  ok(/<a class="btn btn-secondary btn-xs cur-action-chip" href="\/api\/setup\/skills\/my-curator\.zip" download data-mcpi-download="my-curator"><span class="cur-action-label">Download my-curator\.zip<\/span><span class="cur-action-cost">for Antigravity<\/span><\/a>/.test(n),
    'Download is a chip: this app’s own zip, the app named in the cost slot');
  ok(/data-setup-act="reveal" data-path="\/Users\/ann\/\.gemini\/skills\/my-curator"><span class="cur-action-label">Reveal folder<\/span>/.test(n), '…and Reveal folder beside it (macOS)');
  const lin = renderMcpPage(withData((d) => { d.platform = 'linux'; })).html;
  ok(!/data-setup-act="reveal"/.test(next(lin)), 'Reveal is macOS-only — never a dead button');
  ok(/<span class="cur-fold-pill">1 to fix<\/span>/.test(row(h, 'antigravity')), 'the row carries the pill; the fix itself is in the card');
}

section('§4 one app, one reading');
{
  const via = withData((d) => { d.tools.push({ id: 'claude-code', label: 'Claude Code', status: 'manual', installer: 'cli', files: [],
    connectedVia: { id: 'claude-desktop', label: 'Claude Desktop' }, usedAt: iso(17 * 60e3), verdict: 'connected', toFix: 0 }); d.manualSnippets['claude-code'] = '{"mcpServers":{"my-curator":{}}}'; });
  const h = renderMcpPage(via).html;
  ok(/<span class="cur-fold-meta">through Claude Desktop · <span data-age-at=[^>]*>used 17 min ago/.test(row(h, 'claude-code')), 'Claude Code reads "through Claude Desktop · used …"');
  const uwe = withData((d) => { d.tools[3] = { ...d.tools[3], usedAt: iso(5 * 7 * 86400e3), usedWithoutEntry: { text: 'No entry in your user settings — that use came from a file this check does not read.' } }; });
  const u = renderMcpPage({ ...uwe, setupMachineFolds: { 'app-cline': true } }).html;
  ok(/not connected · <span data-age-at=[^>]*>last used 1 month ago|not connected · <span data-age-at=[^>]*>last used/.test(row(u, 'cline'))
    && /data-mcpi-quiet="used-elsewhere"[^]*that use came from a file this check does not read/.test(row(u, 'cline')),
  'an old use with no entry: "last used …" in the meta, and the explanation in its body');
}

section('§5 Windows words, and no machine name');
{
  const amb = withData((d) => { d.platform = 'win32'; d.tools[0] = { ...d.tools[0], status: 'manual', checkEntry: false,
    reason: { code: 'config_ambiguous', candidates: [{ display: '%APPDATA%\\Claude\\a.json' }, { display: '%LOCALAPPDATA%\\Packages\\b.json' }] } }; });
  const h = renderMcpPage({ ...amb, setupMachineFolds: { 'app-claude-desktop': true } }).html;
  ok(/Claude Desktop has more than one config file: %APPDATA%\\Claude\\a\.json · %LOCALAPPDATA%\\Packages\\b\.json — nothing was changed/.test(row(h, 'claude-desktop')),
    'config_ambiguous names the live candidates, in words, in the row');
  const nf = withData((d) => { d.platform = 'win32'; d.tools[0] = { ...d.tools[0], status: 'manual', reason: { code: 'config_not_found' } }; });
  ok(/Open Claude Desktop once, then press Check again/.test(renderMcpPage({ ...nf, setupMachineFolds: { 'app-claude-desktop': true } }).html), 'config_not_found: what to do');
  ok(/Agent apps|this PC/.test(renderMcpPage(amb).html) && !/annes-macbook|a1b2c3/.test(page()), 'no machine name on the page (the owner’s decision 4)');
}

section('§6 the section heads’ readings');
{
  const h = page();
  ok(/id="mcp-meta-apps">checked just now</.test(h), '① checked just now');
  ok(/id="mcp-meta-bridge">self-test 37 min ago</.test(h), '② self-test 37 min ago (from the log)');
  ok(/id="mcp-meta-use">last call 17 min ago</.test(h), '③ last call: the newest AGENT call');
  ok(/id="mcp-meta-projects">last 30 days</.test(h), '④ the window');
  ok(/id="mcp-meta-bridge">self-test failed/.test(page({ selfTest: { ok: false, error: 'x' }, selfTestAt: new Date().toISOString() })), 'a failed self-test is said in the head too');
  const titles = [...h.matchAll(/<div class="cur-group-title cur-section-title" id="mcp-sec-(\w+)" tabindex="-1">([^<]+)</g)].map((m) => m[2]);
  ok(titles.join(' · ') === 'Agent apps · Bridge · Agent use · Across projects', 'four sections, the owner’s words: ' + titles.join(' · '));
  ok(/<span class="cur-fold-label">Default domain for writes<\/span><span class="cur-fold-meta">projects<\/span>/.test(h), 'the default domain is a fold row inside ② Bridge, its slug the reading (the owner’s decision)');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
