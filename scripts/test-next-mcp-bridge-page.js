#!/usr/bin/env node
/**
 * test-next-mcp-bridge-page.js — v3.88.0, re-cut v3.89.0, re-worded v3.90.0
 * (the copy deck). Settings › MCP bridge as a WHOLE PAGE: the real renderMcp()
 * (scripts/test-helpers/mcp-page-sandbox.js) fed the payload shapes of GET
 * /api/mcp/config, /install/status (`counts`, `verdict`, `skill`,
 * `connectedVia`, `bridges`), /setup/machine (`skills`, v3.90.0) and /usage.
 * Exists to stop:
 *   §1 the OVERVIEW disagreeing with the rows, or colouring without a word:
 *      the deck's four figures (CONNECTED · NEEDS ATTENTION · TOOLS WORKING ·
 *      LAST USED), success ink on CONNECTED, attention ink only above 0, every
 *      figure a door to its section, a dash when never tested;
 *   §2 an older connection serving the SAME tools raising anything (the
 *      owner's decision 3); CHANGED tools are a bold line in the Next step
 *      card and the app's fold; UNKNOWN tools one plain sentence in the fold;
 *   §3 the out-of-date skill said in the Next step card with its Download,
 *      and in ② Skills with the folder and Show the folder (macOS only);
 *   §4 one app read two ways: Claude Code "through Claude Desktop's settings";
 *   §5 no machine name anywhere;
 *   §6 the section heads' readings and titles — the deck's words.
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
const row = (html, id) => {
  // One app's fold, from its summary to the next APP fold (its own nested Details stays inside).
  const at = html.indexOf('data-fold-key="app-' + id + '"');
  if (at < 0) return '';
  const re = /data-fold-key="(app-(?!details-)[\w-]+|mcpi-notfound)"/g;
  re.lastIndex = at + 5;
  const m = re.exec(html);
  const sk = html.indexOf('id="mcp-card-skills"', at);
  return html.slice(at, Math.min(m ? m.index : Infinity, sk > 0 ? sk : Infinity));
};
const withData = (fn) => { const s = baseState(); fn(s.mcpInstall.status.data, s); return s; };

section('§1 the overview — the deck’s four figures');
{
  const h = page();
  const o = ov(h);
  ok(/<section class="cur-ov settings-ov-section"/.test(o) && /OVERVIEW/.test(o), 'ONE overview, first in the column (rule 1)');
  ok(/data-ov-jump="mcp-sec-apps"[^]*CONNECTED<\/div><div class="cur-ov-value settings-ov-ok">2</.test(o), 'CONNECTED is the backend’s count, in the success ink');
  ok(/data-ov-jump="mcpi-next-step"[^]*NEEDS ATTENTION<\/div><div class="cur-ov-value settings-ov-attn">1</.test(o), 'NEEDS ATTENTION in the attention ink, its door the Next step card');
  ok(/data-ov-jump="mcp-sec-bridge"[^]*TOOLS WORKING<\/div><div class="cur-ov-value">24 of 24</.test(o), 'TOOLS WORKING: "24 of 24" from the last test (the log’s, after a reload)');
  ok(/data-ov-jump="mcp-sec-use"[^]*LAST USED<\/div><div class="cur-ov-value"><span class="fresh-dot fresh-[a-z]+" aria-hidden="true"><\/span><span data-age-at=[^>]*>17 min ago</.test(o),
    'LAST USED: when an AI app last called a tool (tests excluded), the freshness dot, then a ticking age');
  ok(!/SAVES|LAST SAVE|HANDOFF/.test(o), 'no handoff figure (the owner’s amendment, 2026-11-01)');
  const zero = ov(renderMcpPage(withData((d) => { d.counts = { connected: 0, toFix: 0, notConnected: 4 }; })).html);
  ok(!/settings-ov-ok|settings-ov-attn/.test(zero), 'no ink when nothing is connected and nothing needs attention');
  ok(/TOOLS WORKING<\/div><div class="cur-ov-value">—</.test(ov(page({ mcpUsage: { ...baseState().mcpUsage, lastSelfTest: null } }))),
    'never tested: a dash, never a guessed 24');
  ok(/TOOLS WORKING<\/div><div class="cur-ov-value settings-ov-attn">0 of 24</.test(ov(page({ selfTest: { ok: false, error: 'x' }, selfTestAt: iso(1000) }))),
    'a failed test: "0 of 24" in the attention ink');
}

section('§2 the stale-connection rule');
{
  const withBridge = (b) => withData((d) => { d.tools[0] = { ...d.tools[0], bridges: { count: 1, oldestStartedAt: iso(4 * 3600e3), version: '3.88.0', toolCount: 24, ...b } }; });
  const same = renderMcpPage(withBridge({ tools: 'same', notice: 'quiet' })).html;
  ok(!/data-mcpi-item="tools-changed"/.test(same) && !/data-mcpi-extra/.test(row(same, 'claude-desktop')),
    'the SAME tools: nothing in Next step, no extra line in its fold');
  const changed = renderMcpPage(withBridge({ tools: 'changed', notice: 'warn', missing: ['save_foundation'] })).html;
  ok(/data-mcpi-item="tools-changed"[^>]*><p class="cur-fold-line-text"><strong>Claude Desktop is still using the previous version of My Curator\. Quit Claude Desktop completely and open it again\.<\/strong>/.test(next(changed)),
    'CHANGED tools: the deck’s bold sentence in the Next step card');
  ok(/data-mcpi-extra[^>]*><p class="cur-fold-line-text"><strong>Claude Desktop is still using the previous version/.test(row(changed, 'claude-desktop')), '…and in its fold');
  const unknown = renderMcpPage(withBridge({ tools: 'unknown', notice: 'soft' })).html;
  ok(/Claude Desktop has been open since \d\d:\d\d, from before The Curator updated\. If My Curator seems to be missing something there, quit Claude Desktop completely and open it again\./.test(row(unknown, 'claude-desktop'))
    && !/data-mcpi-item="tools-changed"/.test(unknown), 'UNKNOWN tools: the deck’s plain sentence in its fold, never a Next step item');
}

section('§3 the out-of-date skill');
{
  const h = page();
  const n = next(h);
  ok(/Next step · 2 to do/.test(n) && /<strong>Antigravity’s my-curator skill is out of date\.<\/strong> Download the new version and replace the old one — see Skills below\./.test(n),
    'the deck’s sentence, in the Next step card, for its app');
  ok(/<a class="btn btn-secondary btn-xs" href="\/api\/setup\/skills\/my-curator\.zip" download data-mcpi-download="my-curator">Download my-curator<\/a>/.test(n),
    'Download my-curator: this app’s own zip, as the shared secondary button');
  ok(/Its my-curator skill is out of date — see Skills below\./.test(row(h, 'antigravity')), 'the app’s fold says it once, pointing at Skills');
  const skills = h.slice(h.indexOf('id="mcp-card-skills"'), h.indexOf('id="mcp-card-bridge"'));
  ok(/data-mcpi-skill-app="antigravity" data-mcpi-skill-state="outdated"><span class="cur-fold-item-meta">Antigravity — out of date<\/span><span class="mono cur-fold-item-main">~\/\.gemini\/config\/skills\/my-curator<\/span><button type="button" class="btn btn-secondary btn-xs" data-setup-act="reveal" data-path="\/Users\/ann\/\.gemini\/config\/skills\/my-curator">Show the folder<\/button>/.test(skills),
    '② Skills: "Antigravity — out of date" · its folder (mono) · Show the folder');
  ok(/Replace the folder with the downloaded one, then start a new Antigravity session\./.test(skills), '…and what to do');
  const lin = renderMcpPage(withData((d) => { d.platform = 'linux'; })).html;
  ok(!/data-setup-act="reveal"/.test(lin), 'Show the file / folder is macOS-only — never a dead button');
}

section('§4 one app, one reading');
{
  const via = withData((d) => { d.tools.push({ id: 'claude-code', label: 'Claude Code', status: 'manual', installer: 'cli', files: [],
    connectedVia: { id: 'claude-desktop', label: 'Claude Desktop' }, usedAt: iso(17 * 60e3), verdict: 'connected', toFix: 0 }); d.manualSnippets['claude-code'] = '{"mcpServers":{"my-curator":{}}}'; });
  const h = renderMcpPage(via).html;
  ok(/<span class="cur-fold-meta">connected<\/span>/.test(row(h, 'claude-code'))
    && /Connected through Claude Desktop’s settings\. Claude Code last used My Curator <span data-age-at=[^>]*>17 min ago<\/span>\./.test(row(h, 'claude-code')),
  'Claude Code: "connected", and "Connected through Claude Desktop’s settings. Claude Code last used My Curator 17 min ago."');
}

section('§5 no machine name');
{
  ok(!/annes-macbook|a1b2c3/.test(page()), 'no machine name on the page (the owner’s decision 4)');
  ok(/Not on this Mac \(1\)/.test(page()) && /Not on this PC \(1\)/.test(renderMcpPage(withData((d) => { d.platform = 'win32'; })).html),
    '"Not on this Mac / PC (n)" — the platform’s word, not the computer’s name');
}

section('§6 the section heads');
{
  const h = page();
  ok(/id="mcp-meta-apps">checked just now</.test(h), '① checked just now');
  ok(/id="mcp-meta-skills">carried by The Curator 3\.89\.0</.test(h), '② carried by The Curator {version}');
  ok(/id="mcp-meta-bridge">last test 37 min ago</.test(h), '③ last test {age} (from the log)');
  ok(/id="mcp-meta-use">last use 17 min ago</.test(h), '④ last use: the newest call by an AI app');
  const titles = [...h.matchAll(/<div class="cur-group-title cur-section-title" id="mcp-sec-(\w+)" tabindex="-1">([^<]+)</g)].map((m) => m[2]);
  ok(titles.join(' · ') === 'Your AI apps · Skills · Connection test · Tool activity', 'four sections, the deck’s words: ' + titles.join(' · '));
  ok(/<span class="cur-fold-label">Default project for writes<\/span><span class="cur-fold-meta">projects<\/span>/.test(h), 'the default project is a fold row in ③, its domain the reading');
  ok(/<span class="cur-fold-label">Default project for writes<\/span><span class="cur-fold-meta">Ask every time<\/span>/.test(
    page({ defaultDomainInfo: { domains: ['projects'], defaultDomain: null, identity: {} } })), '…"Ask every time" when none is set');
  ok(/^<p class="cur-section-intro">This page connects your AI apps — Claude, Cursor, Antigravity and others — to your knowledge, and shows whether the connection works\.<\/p>/.test(h),
    'the lede, the column’s first line under the title');
  ok(/<p class="cur-section-foot">The Curator only reads your AI apps’ settings files\. It changes one only when you press Install for me, Remove or Restore, and it always keeps a backup first\.<\/p>$/.test(h),
    'the footer, the page’s last line');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
