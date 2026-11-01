#!/usr/bin/env node
/**
 * test-next-mcp-connect.js — v3.85.0, re-cut v3.88.0 and v3.89.0. Settings ›
 * MCP bridge: what the page may WRITE and START, and through what door.
 *
 *   §1 the MCP wizard stays gone; nothing in /next writes a foreign config
 *      except through the install routes
 *   §2 Check entry (v3.89.0): the request carries the app's id ONLY — never a
 *      path, a command or an entry — and the click handler sends the id the
 *      button names; the outcome lands in state and is rendered unfolded
 *   §3 ③ Connection test (v3.90.0): the result line, Details (version ·
 *      knowledge folder · open right now), the buttons in the control row
 *   §4 a connection The Curator cannot name: counted in Details, no sentence
 *   §5 the client list and the ChatGPT exclusion live in the ⓘ, and the docs
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

// ── §2 ─────────────────────────────────────────────────────────────────────
section('§2 Check entry sends an id and nothing else');
{
  const sent = [];
  globalThis.fetch = async (url, init) => { sent.push({ url, init }); return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({ ok: true, results: [] }) }; };
  const r = await MI.requestCheckEntry('claude-desktop');
  const body = sent[0] && JSON.parse(sent[0].init.body);
  ok(sent.length === 1 && sent[0].url === '/api/mcp/install/check-entry' && sent[0].init.method === 'POST', 'one POST to /api/mcp/install/check-entry');
  ok(body && Object.keys(body).join(',') === 'id' && body.id === 'claude-desktop', 'its body is exactly {id} — no path, no command, no entry');
  ok(r.ok === true, '…and the answer is read as a verdict');
  globalThis.fetch = async () => ({ ok: true, headers: { get: () => 'application/json' }, json: async () => ({ nope: 1 }) });
  ok((await MI.requestCheckEntry('cursor')).code === 'shape', 'a reply without `results` is a shape error, never "no entries"');
  // The click → checkEntry → state, executed.
  const st = { mcpChecks: {}, mcpCheckBusy: null };
  const renders = [];
  const checkEntry = new Function('state', 'render', 'requestCheckEntry', 'isCurrentMount', 'failureWords',
    extractFunction(settingsCode, 'checkEntry') + '\nreturn checkEntry;')(st, () => renders.push(JSON.stringify(st.mcpChecks)),
    async (id) => ({ ok: true, data: { id, results: [{ file: '~/a.json', ran: true, starts: true, toolCount: 24 }] } }), () => true, MI.failureWords);
  await checkEntry(1, 'claude-desktop');
  ok(/"busy":true/.test(renders[0]) && st.mcpChecks['claude-desktop'].result.results[0].starts === true && st.mcpCheckBusy === null,
    'a press shows "starting…", then the result, then frees the button');
  ok(/act === 'check-entry'\) \{ checkEntry\(token, el\.dataset\.tool\)/.test(extractFunction(settingsCode, 'wireInstallListeners')),
    'the button’s handler passes the id the button names (data-tool) — the only argument');
  const { renderMcpPage, baseState } = await import('./test-helpers/mcp-page-sandbox.js');
  const html = renderMcpPage(baseState({ mcpChecks: st.mcpChecks })).html;
  const apps = html.slice(html.indexOf('id="mcp-card-apps"'), html.indexOf('id="mcp-card-apps"') + 6000).replace(/<details[\s\S]*?<\/details>/g, '');
  const cd = html.slice(html.indexOf('data-fold-key="app-claude-desktop"'), html.indexOf('data-fold-key="app-antigravity"'));
  ok(/Connected\. Works — My Curator starts the way Claude Desktop starts it and answers with all 24 tools\./.test(cd),
    'the outcome replaces the second half of the app’s one sentence (v3.90.0, the copy deck)');
  ok(!/Works — /.test(apps), '…said once, in its own app’s fold, not as a separate status');
}

// ── §3 ─────────────────────────────────────────────────────────────────────
section('§3 ③ Connection test (v3.90.0, the copy deck)');
{
  const { renderMcpPage, baseState } = await import('./test-helpers/mcp-page-sandbox.js');
  const h = renderMcpPage(baseState({ setupMachineFolds: { 'bridge-answers': true } })).html;
  const b = h.slice(h.indexOf('id="mcp-card-bridge"'), h.indexOf('id="mcp-card-use"'));
  ok(!/cur-mon-head|cur-mon-state/.test(b), 'no monitor head word (no "NOT TESTED YET")');
  ok(/<span class="cur-fold-label">Details<\/span>/.test(b) && /Version 3\.89\.0 · knowledge folder ~\/second-brain\/domains/.test(b),
    'Details: "Version {v} · knowledge folder {path}"');
  ok(/<strong>Works\.<\/strong> My Curator started and answered with all 24 tools/.test(b), 'the result line: "Works. …"');
  ok(b.indexOf('id="btn-mcp-self-test"') < b.indexOf('<div class="cur-folds"') && b.indexOf('<div class="cur-card-top">') < b.indexOf('id="btn-mcp-self-test"'),
    'Test connection is in the card’s control row, above the folds');
  const s = baseState();
  s.mcp = { ...s.mcp, bridge_processes: { ...s.mcp.bridge_processes, running: 2, bridges: [
    { pid: 3, startedAt: new Date().toISOString(), app: { id: 'claude-desktop', label: 'Claude Desktop' }, version: '3.89.0', tools: 'same', notice: 'none' },
    { pid: 4, startedAt: new Date().toISOString(), app: { id: 'cursor', label: 'Cursor' }, version: '3.89.0', tools: 'same', notice: 'none' }] } };
  ok(/ · 2 open right now in Claude Desktop, Cursor/.test(renderMcpPage(s).html), '…and "{n} open right now in {apps}" when any are');
}

// ── §4 ─────────────────────────────────────────────────────────────────────
section('§4 a connection nobody can name says nothing on the page');
{
  const { renderMcpPage, baseState } = await import('./test-helpers/mcp-page-sandbox.js');
  const s = baseState();
  s.mcp = { ...s.mcp, bridge_processes: { ...s.mcp.bridge_processes, running: 1, bridges: [{ pid: 3, startedAt: new Date().toISOString(), app: null,
    version: '3.80.0', tools: 'unknown', notice: 'soft', remedy: 'Quit the app that opened it.' }] } };
  const h = renderMcpPage(s).html;
  ok(!/could not name|bridge/i.test(h.replace(/<[^>]+>/g, ' ').replace(/MCP bridge/g, '')), 'no mechanism sentence about an unnamed connection (the copy deck has none)');
  ok(/ · 1 open right now/.test(h), '…it is counted in Details only');
}

// ── §5 ─────────────────────────────────────────────────────────────────────
section('§5 the client list lives in the ⓘ, and the docs back it');
{
  const e = EXPLAINERS['settings.mcp-connect'];
  const all = JSON.stringify(e);
  const guide = readFileSync(path.join(ROOT, 'docs/mcp-user-guide.md'), 'utf8');
  for (const c of ['Claude Desktop', 'Claude Code', 'Cursor']) { ok(all.includes(c), `the ⓘ names ${c}`); ok(guide.includes(c), `CONTROL: docs/mcp-user-guide.md names ${c} too`); }
  ok(/ChatGPT[^.]*cannot run (?:a )?local server/.test(all), '…and the honest exclusion, as a MECHANISM');
  ok(e.title === 'Your AI apps', 'the ⓘ is titled like the section');
  const { renderMcpPage, baseState } = await import('./test-helpers/mcp-page-sandbox.js');
  ok(/class="tx-vh-panel" id="mcp-sec-apps-info"[^>]*hidden/.test(renderMcpPage(baseState()).html), 'the explanation is a closed panel in the shipped markup');
}

console.log(`\nPassed: ${passed}   Failed: ${failed}`);
process.exit(failed ? 1 : 0);
