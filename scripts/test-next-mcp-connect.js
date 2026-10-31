#!/usr/bin/env node
/**
 * test-next-mcp-connect.js — v3.85.0. Settings › MCP bridge › block 1
 * "Connect a client" after the MCP wizard was RETIRED, and the one door it
 * (and nothing else) now has: block 5's "My Curator in your tools" panel.
 * Replaces scripts/test-next-mcp-wizard.js, whose subject (the wizard's
 * decision functions, its overlay and its CSS) no longer exists; what that
 * suite said about block 1 itself (§11, the vendor-neutrality sentence, the
 * default-domain footnote) is carried over here and still EXECUTES the real
 * renderMcp().
 *
 *   §1 the wizard is gone — files, imports, link, selectors, class names
 *   §2 block 1 writes nothing: the buttons are Install in your tools and Run
 *      self-test, no UI anywhere calls /write-config or the claude-config routes
 *   §3 the scroll target exists, and the door goes to it without a request
 *   §4 "Works with any MCP client" (carried over from the wizard suite §11)
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { docsUrl, docsLinkHtml } from '../src/public/next/shared/docs-links.js';
import { explainerMark } from '../src/public/next/shared/explainer.js';
import { formatAge, freshnessTier } from '../src/public/next/shared/age.js';
import { renderMonitor } from '../src/public/next/shared/monitor.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const NEXT = path.join(ROOT, 'src/public/next');
let passed = 0, failed = 0;
const ok = (c, l, d) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failed++; console.log(`  ✗ ${l}${d !== undefined ? `\n      ${String(d).slice(0, 400)}` : ''}`); } };
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
section('§1 the wizard is gone');
ok(!existsSync(path.join(NEXT, 'views/mcp-wizard.js')) && !existsSync(path.join(NEXT, 'views/mcp-wizard.css')), 'views/mcp-wizard.js and .css are deleted');
ok(!existsSync(path.join(ROOT, 'scripts/test-next-mcp-wizard.js')), 'and so is its suite');
const offenders = jsCode.filter(([, c]) => /openMcpWizard|closeMcpWizardIfOpen|mcp-wizard\.js|btn-mcp-wizard|btn-mcp-copy-steps|btn-mcp-view-config|btn-mcp-copy-snippet|onMcpViewConfig|onMcpCopySnippet|MCP_GUIDE_URL/.test(c)).map(([f]) => f);
ok(offenders.length === 0, 'no /next script opens, imports or addresses the wizard or the retired block-1 buttons', offenders.join(', '));
ok(!/mcp-wizard/.test(readFileSync(path.join(NEXT, 'index.html'), 'utf8')), 'index.html no longer links its stylesheet');
const cssUse = files.filter((f) => f.endsWith('.css')).filter((f) => /\.mcpw-/.test(stripComments(readFileSync(f, 'utf8')))).map((f) => path.relative(ROOT, f));
ok(cssUse.length === 0, 'no stylesheet still defines an mcpw-* selector', cssUse.join(', '));
ok(!jsCode.some(([, c]) => /mcpw-/.test(c)), 'and no script emits an mcpw- class');

// ── §2 ─────────────────────────────────────────────────────────────────────
section('§2 block 1 writes nothing');
const callers = jsCode.filter(([, c]) => /\/api\/mcp\/(write-config|claude-config|claude-full-config)/.test(c)).map(([f]) => f);
ok(callers.length === 0, 'no UI code calls /api/mcp/write-config, /claude-config or /claude-full-config', callers.join(', '));
const wire = settingsCode.slice(settingsCode.indexOf("getElementById('btn-mcp-install-tools')"), settingsCode.indexOf("getElementById('btn-mcp-self-test')"));
ok(wire.length > 40 && /focusInstallPanel\(/.test(wire) && !/fetch\(|requestApply|requestPlan|copyToClipboard/.test(wire), 'the Install in your tools click only moves focus — no request, no write, no clipboard', wire);
ok(/cd\.status !== 'connected' \? 'claude-desktop' : ''/.test(wire), 'it marks the Claude Desktop row only when Claude Desktop is not connected');

// ── §4 first (renders block 1), then §3 ───────────────────────────────────
const blockSrc = extractFunction(settingsCode, 'settingsBlock');
const infoSrc = (settingsCode.match(/const MCP_DOMAIN_CONSEQUENCE =[\s\S]*?;\n/) || [''])[0];
const mapSrc = ['ageSecondsOf', 'ageMarkHtml', 'usageWindowWords', 'renderToolTile', 'renderToolGroup', 'renderSessionStrip', 'renderToolMapBody', 'renderToolMap']
  .map((n) => extractFunction(settingsCode, n)).join('\n');
const deps = {
  state: { mcpError: null, mcp: { mcp_server_name: 'my-curator', domains_dir: '/tmp/d' }, selfTest: null,
    defaultDomainInfo: { domains: ['alpha'], defaultDomain: 'alpha' }, defaultDomainSaving: false, selfTestLoading: false },
  deriveMcpStatus: () => ({ pillTone: 'ok', pillLabel: 'Configured' }),
  renderSelfTestResult: () => '', shouldShowMcpStaleNote: () => false, deriveStaleBridgeNote: () => null,
  escapeHtml: (x) => String(x), icon: () => '', explainerMark, docsLinkHtml,
  renderListboxHtml: () => '<LISTBOX/>', pendingListboxes: [], myMountToken: 1, onSaveDefaultDomain: () => {},
  formatAge, freshnessTier, renderMonitor, gatedLoader: () => '<LOADER/>', loadGate: null,
};
const names = Object.keys(deps);
const html = new Function(...names, [blockSrc, infoSrc, mapSrc, extractFunction(settingsCode, 'renderMcp'), 'return renderMcp;'].join('\n'))(...names.map((n) => deps[n]))();
section('§2 (rendered) block 1 is a compact card');
ok(html.includes('cur-mon'), 'CONTROL: block 1 rendered its status monitor');
ok(/id="btn-mcp-install-tools"[^>]*>Install in your tools</.test(html) && /id="btn-mcp-self-test"/.test(html), 'two buttons: Install in your tools and Run self-test');
const at0 = html.indexOf('settings-btn-row');
const row = html.slice(at0, html.indexOf('</div>', at0));
ok((row.match(/<button/g) || []).length === 2, 'exactly two buttons in the row', (row.match(/<button/g) || []).length);
ok(!/Re-connect|Re-run setup|Set up Claude Desktop|View config|Copy snippet|Hide config/.test(html), 'Re-connect, View config and Copy snippet are gone');
ok(/btn btn-primary" id="btn-mcp-install-tools"/.test(html), 'Install in your tools is the one primary');

// ── §3 ─────────────────────────────────────────────────────────────────────
section('§3 the scroll target exists');
const M = await import('../src/public/next/views/mcp-install.js');
const t = (o) => ({ installer: 'file', running: { checked: true, running: false }, files: [], ...o });
const panel = M.renderInstallPanel({ status: { data: { platform: 'darwin', writable: true, notFound: [], manualSnippets: {}, tools: [t({ id: 'claude-desktop', label: 'Claude Desktop', status: 'not-installed', files: [{ display: '~/c.json' }] })] } } });
ok(/id="mcpi-panel"/.test(panel) && /id="mcpi-rows"/.test(panel) && /data-mcpi-tool="claude-desktop"/.test(panel), 'the panel, its rows and the Claude Desktop row all carry the ids the door scrolls to');
ok(/settings-block-mcp-tools/.test(settingsCode) && /'mcp-tools'/.test(settingsCode), 'block 5 itself is the fallback target');
let net = 0; globalThis.fetch = () => { net++; return Promise.reject(new Error('no')); };
const el = (name) => { const cls = new Set(); return { name, scrolled: null, focused: false, classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), has: (c) => cls.has(c) }, scrollIntoView(o) { this.scrolled = o; }, querySelector: () => ({ focus() { el.f = true; } }) }; };
const row2 = el('row'), pan = el('panel'), blk = el('block');
const doc = (m) => ({ querySelector: (s) => (s === '[data-mcpi-tool="claude-desktop"]' ? m.row : s === '.settings-block-mcp-tools' ? m.block : null), getElementById: (i) => (i === 'mcpi-panel' ? m.panel : null) });
ok(M.focusInstallPanel('claude-desktop', doc({ row: row2, panel: pan, block: blk })) === row2 && row2.scrolled && row2.classList.has('mcpi-flash') && !pan.scrolled, 'the Claude Desktop row is scrolled to and marked');
ok(M.focusInstallPanel('', doc({ row: null, panel: pan, block: blk })) === pan && pan.scrolled, 'with no tool named it goes to the panel');
ok(M.focusInstallPanel('claude-desktop', doc({ row: null, panel: null, block: blk })) === blk, 'while the status loads it falls back to block 5');
ok(M.focusInstallPanel('x', doc({ row: null, panel: null, block: null })) === null, 'and returns null when nothing is mounted');
ok(M.focusInstallPanel('a"]b', doc({ row: null, panel: pan, block: blk })) === pan, 'a hostile tool id never reaches a selector');
ok(net === 0, 'the door makes no request', net);

// ── §4 ─────────────────────────────────────────────────────────────────────
section('§4 "Works with any MCP client" (carried over)');
const guide = readFileSync(path.join(ROOT, 'docs/mcp-user-guide.md'), 'utf8');
const CLIENTS = ['Claude Desktop', 'Claude Code', 'Cursor'];
ok(/Works with any MCP client/.test(html), 'block 1 carries the claim');
for (const c of CLIENTS) { ok(html.includes(c), `…names ${c}`); ok(guide.includes(c), `CONTROL: docs/mcp-user-guide.md names ${c} too`); }
ok(/ChatGPT[^.]*cannot run (?:a )?local server/.test(html), '…and the honest exclusion, as a MECHANISM');
ok(html.includes('href="' + docsUrl('settings.mcp-connect') + '"'), '…linking through the docs-links table to the connect-a-client section');
ok(/class="settings-job-lede settings-block-lede"/.test(html.slice(Math.max(0, html.indexOf('Works with any MCP client') - 200))), 'as the block’s lede');
ok(/class="tx-vh-panel"[^>]*hidden/.test(html), 'the long version is a closed fold in the shipped markup');
{
  const cons = new Function(infoSrc + 'return MCP_DOMAIN_CONSEQUENCE;')();
  ok(cons.length > 40 && /wrong domain/.test(cons), 'CONTROL: MCP_DOMAIN_CONSEQUENCE lifted from settings.js');
  ok(html.includes('<LISTBOX/><p class="settings-block-footnote">' + cons + '</p>'), 'the default-domain consequence renders VISIBLY under the listbox');
}
ok(/stdio/i.test(guide) && /ChatGPT/.test(guide), 'the docs carry the same paragraph, including the reason');
ok(!/\bGemini app\b|\bCopilot\b/.test(html), 'CONTROL: no client is named that the docs do not name');


// ── §5 the self-test is the only reader of domains_status now ──────────────
section('§5 self-test: a missing knowledge folder is not an empty one');
{
  const rst = new Function('state', 'deriveStaleBridgeNote', 'renderMonitor', extractFunction(settingsCode, 'renderSelfTestResult') + '\nreturn renderSelfTestResult;');
  const run = (r) => rst({ selfTest: r, mcp: null }, () => null, renderMonitor)();
  const base = { ok: true, tool_count: 24, tool_names: ['a'] };
  const missing = run({ ...base, domains_status: 'missing_folder', domains_dir: '/nope' });
  const empty = run({ ...base, domains_status: 'empty', domains: [] });
  const fine = run({ ...base, domains_status: 'ok', domains: ['a', 'b'] });
  ok(/knowledge folder is missing/.test(missing) && /\/nope does not exist/.test(missing) && /not a mistake in a tool/.test(missing), 'missing folder: said, with its path, and not blamed on a tool config');
  ok(/folder is empty/.test(empty) && !/is missing/.test(empty), 'empty folder: its own sentence');
  ok(/2 domain\(s\) visible/.test(fine) && !/is missing|is empty/.test(fine), 'a healthy folder: the count');
  ok(new Set([missing, empty, fine]).size === 3, 'the three outcomes render pairwise distinct');
  ok(/cur-mon-loud|loud/.test(missing) && !/<details/.test(missing), 'the missing-folder warning is a loud entry, never inside a fold');
}

console.log(`\nPassed: ${passed}   Failed: ${failed}`);
process.exit(failed ? 1 : 0);
