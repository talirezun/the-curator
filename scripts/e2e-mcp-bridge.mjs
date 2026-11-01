#!/usr/bin/env node
/**
 * e2e-mcp-bridge.mjs — Settings › MCP bridge, DRIVEN IN A REAL BROWSER (v3.89.0).
 *
 * LIVE_LOCAL (scripts/run-tests.js): it starts this checkout's server on a
 * spare port and drives the page with headless Chrome over CDP
 * (scripts/visual/), against an ISOLATED world:
 *
 *   · a synthetic workspace (scripts/demo-domain.mjs --workspace — two
 *     domains, a project with handoffs, a week of usage log);
 *   · a FAKE HOME (CURATOR_TEST_INSTALL_HOME and HOME) holding a Claude
 *     Desktop config WITHOUT our entry (another server and a preference in
 *     it), an Antigravity config with another server, and a Cursor app with
 *     no MCP file yet.
 *
 * It clicks what a person clicks and reads back what lands ON DISK:
 *
 *   Install for me → the preview (the exact entry, the other servers kept)
 *   → Apply → the fake config holds the entry, the other server and the
 *   preference, and a backup exists → Check again shows connected → Check
 *   entry on Claude Desktop reports it starts with the bridge's tools →
 *   Remove → the entry is gone (file byte-identical to the original) →
 *   Install again → Restore original → the file is byte-identical to the
 *   original; Copy entry (the copy payload and its "Paste into … inside
 *   "mcpServers"" line); Run self-test; Test all N tools; and the LIVE page
 *   against the page contract (scripts/test-helpers/page-contract.js).
 *
 * SAFETY. It fingerprints the REAL Claude Desktop, Cursor and Antigravity
 * configs and the real .curator-config.json files (sha256 + size) before and
 * after, and fails if any moved. Nothing outside the temp folder is written.
 *
 *   node scripts/e2e-mcp-bridge.mjs [--shots <dir>] [--keep]
 *
 * `--shots <dir>` also writes the dark screenshots at 1280 / 1100 / 375 px
 * and a 1280 Domain page beside the MCP page (`compare-1280.png`).
 */
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { launchBrowser, findBrowser } from './visual/browser.js';
import { CdpConnection, CdpPage } from './visual/cdp.js';
import { checkPageContract, MCP_PAGE_CONTRACT } from './test-helpers/page-contract.js';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const SHOTS = args.includes('--shots') ? path.resolve(args[args.indexOf('--shots') + 1]) : null;
const KEEP = args.includes('--keep');

let passed = 0;
let failed = 0;
const steps = [];
function step(name, ok, detail) {
  steps.push({ name, ok: !!ok, detail });
  if (ok) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + name + (detail ? ' — ' + String(detail).slice(0, 200) : '')); }
  else { failed++; console.log('  \x1b[31m✗\x1b[0m ' + name + (detail ? ' — ' + String(detail).slice(0, 600) : '')); }
  return !!ok;
}

// ── the real files, fingerprinted ──────────────────────────────────────────
const REAL_HOME = os.homedir();
const REAL_FILES = [
  path.join(REAL_HOME, 'Library/Application Support/Claude/claude_desktop_config.json'),
  path.join(REAL_HOME, '.cursor/mcp.json'),
  path.join(REAL_HOME, '.gemini/config/mcp_config.json'),
  path.join(REAL_HOME, '.gemini/antigravity/mcp_config.json'),
  path.join(REAL_HOME, 'Library/Application Support/The Curator/.curator-config.json'),
  path.join(REPO, '.curator-config.json'),
];
function fingerprint() {
  const out = {};
  for (const f of REAL_FILES) {
    try { const b = readFileSync(f); out[f] = createHash('sha256').update(b).digest('hex') + ' ' + b.length; } catch { out[f] = 'absent'; }
  }
  return out;
}
if (!findBrowser()) {
  console.log('⊘ e2e-mcp-bridge: no Chrome / Chromium / Edge found — skipped (it needs a real browser).');
  process.exit(0);
}
const before = fingerprint();

// ── the isolated world ─────────────────────────────────────────────────────
const base = mkdtempSync(path.join(os.tmpdir(), 'curator-e2e-mcp-'));
const ws = { domains: path.join(base, 'domains'), userData: path.join(base, 'userdata'), home: path.join(base, 'home') };
const NOW = new Date().toISOString();
execFileSync(process.execPath, [path.join(REPO, 'scripts', 'demo-domain.mjs'), ws.domains, '--now', NOW, '--workspace', ws.userData], {
  cwd: REPO, stdio: ['ignore', 'ignore', 'inherit'],
  env: { ...process.env, HOME: ws.home, CURATOR_TEST_DOMAINS_DIR: ws.domains, CURATOR_TEST_USER_DATA_DIR: ws.userData },
});
writeFileSync(path.join(ws.userData, '.curator-config.json'), JSON.stringify({ activeProvider: 'gemini', domainsPath: ws.domains,
  geminiApiKey: 'AIza-E2E-FAKE-KEY-not-a-credential' }, null, 2), { mode: 0o600 });
const CLAUDE = path.join(ws.home, 'Library/Application Support/Claude/claude_desktop_config.json');
const AG = path.join(ws.home, '.gemini/config/mcp_config.json');
const CURSOR = path.join(ws.home, '.cursor/mcp.json');
mkdirSync(path.dirname(CLAUDE), { recursive: true });
mkdirSync(path.dirname(AG), { recursive: true });
mkdirSync(path.join(ws.home, '.cursor'), { recursive: true });
mkdirSync(path.join(ws.home, 'Applications/Cursor.app/Contents/MacOS'), { recursive: true });
// In the layout the installer writes (2-space JSON, trailing newline), so a
// Remove that takes our entry out again leaves the file byte-identical.
const ORIGINAL = JSON.stringify({ mcpServers: { 'other-server': { command: '/usr/bin/true', args: ['--flag'] } }, preferences: { menuBarEnabled: true } }, null, 2) + '\n';
writeFileSync(CLAUDE, ORIGINAL);
writeFileSync(AG, JSON.stringify({ mcpServers: { firebase: { command: '/usr/bin/true' } } }, null, 2) + '\n');
const sha = (s) => createHash('sha256').update(s).digest('hex');

const port = await new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const env = { ...process.env };
for (const k of ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'GITHUB_TEST_REPO', 'GITHUB_TEST_PAT', 'DOMAINS_PATH', 'LLM_MODEL']) delete env[k];
Object.assign(env, { PORT: String(port), CURATOR_NO_OPEN: '1', HOME: ws.home, CURATOR_TEST_USER_DATA_DIR: ws.userData,
  CURATOR_TEST_DOMAINS_DIR: ws.domains, CURATOR_TEST_INSTALL_HOME: ws.home });
const child = spawn(process.execPath, [path.join(REPO, 'src', 'server.js')], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
child.stdout.on('data', (d) => { serverLog += d; });
child.stderr.on('data', (d) => { serverLog += d; });
const origin = `http://localhost:${port}`;
for (let i = 0; i < 150; i++) { try { if ((await fetch(origin + '/api/version')).ok) break; } catch { /* not yet */ } await delay(200); }

let browser = null;
let conn = null;
try {
  browser = await launchBrowser();
  conn = await CdpConnection.connect(browser.wsUrl);
  const page = await CdpPage.create(conn);
  await page.setViewport(1280, 1000, 1);
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await page.navigate(origin + '/api/version');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('curator-next-theme', 'dark');
    localStorage.setItem('curator-next-view', 'settings'); localStorage.setItem('curator-next-onboarding-dismissed-v1', '1');
    sessionStorage.setItem('curator-next-instance-banner-dismissed-v1', '1'); });
  await page.navigate(origin);
  for (let i = 0; i < 100 && !(await page.evaluate(() => !!window.__curatorBooted)); i++) await delay(100);

  const until = async (label, fn, arg, ms = 15000) => {
    const t0 = Date.now();
    for (;;) {
      let v = null;
      try { v = await page.evaluate(fn, arg); } catch { v = null; }
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + label);
      await delay(120);
    }
  };
  const click = (sel) => page.evaluate((s) => { const el = document.querySelector(s); if (!el) return false; el.click(); return true; }, sel);
  const text = (sel) => page.evaluate((s) => { const el = document.querySelector(s); return el ? el.textContent : null; }, sel);
  const rowStatus = (id) => page.evaluate((i) => { const el = document.querySelector('#mcpi-rows [data-mcpi-tool="' + i + '"]'); return el ? el.dataset.mcpiStatus : null; }, id);
  const openRow = (id) => page.evaluate((i) => { const el = document.querySelector('#mcpi-rows details[data-mcpi-tool="' + i + '"]'); if (el) el.open = true; return !!el; }, id);
  // The copy payload: what Copy entry hands the clipboard (headless Chrome
  // has no focused clipboard to read back).
  await page.evaluate(() => {
    window.__copied = [];
    try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (t) => { window.__copied.push(t); return Promise.resolve(); } } }); } catch { /* keep */ }
  });

  // Open Settings › MCP bridge.
  await until('settings sidebar', () => [...document.querySelectorAll('#sidebar *')].some((e) => /MCP bridge/.test(e.textContent || '')));
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('#sidebar button, #sidebar [role="button"], #sidebar a')].find((e) => /^\s*MCP bridge/.test(e.textContent || ''));
    if (el) el.click();
  });
  await until('the agent app rows', () => !!document.querySelector('#mcpi-rows [data-mcpi-tool="claude-desktop"]') && !!document.querySelector('#mcp-card-use .cur-mon'), null, 30000);
  await delay(800);

  // ── 0. the page itself ──────────────────────────────────────────────────
  const liveHtml = () => page.evaluate(() => {
    const vh = document.querySelector('.main-inner .tx-vh');
    const body = document.getElementById('settings-view-body');
    return (vh ? vh.outerHTML : '') + (body ? body.innerHTML : '');
  });
  {
    const v = checkPageContract(await liveHtml(), MCP_PAGE_CONTRACT);
    step('the live page passes the page contract (overview, four sections, one card each)', v.length === 0, v.join(' | '));
    step('Claude Desktop starts as "can be added"', (await rowStatus('claude-desktop')) === 'not-installed', await rowStatus('claude-desktop'));
  }
  if (SHOTS) await shots(page, 'mcp');

  // ── 1. Install for me → preview → Apply ───────────────────────────────────
  // Only Claude Desktop is ticked, so the file under test is the only one written.
  await page.evaluate(() => {
    for (const cb of document.querySelectorAll('[data-mcpi-tick]')) {
      const want = cb.dataset.mcpiTick === 'claude-desktop';
      if (cb.checked !== want) { cb.checked = want; cb.dispatchEvent(new Event('change')); }
    }
  });
  await click('#mcpi-install-btn');
  await until('the preview', () => !!document.querySelector('[data-mcpi-plan]'));
  {
    const entry = await text('[data-mcpi-plan] [data-mcpi-entry]');
    const kept = await text('[data-mcpi-plan] [data-mcpi-preserved]');
    let parsed = null;
    try { parsed = JSON.parse(entry); } catch { /* not JSON */ }
    step('Install for me shows a preview: the exact entry', !!parsed && typeof parsed.command === 'string', entry && entry.slice(0, 160));
    step('…and the other servers kept, by name', /other-server/.test(kept || ''), kept);
    step('…and nothing was written yet', readFileSync(CLAUDE, 'utf8') === ORIGINAL);
    const v = checkPageContract(await liveHtml(), MCP_PAGE_CONTRACT);
    step('the page with the preview open passes the page contract', v.length === 0, v.join(' | '));
  }
  await click('[data-mcpi-act="apply"]');
  await until('the results', () => !!document.querySelector('[data-mcpi-results]'));
  {
    const doc = JSON.parse(readFileSync(CLAUDE, 'utf8'));
    const ours = doc.mcpServers && doc.mcpServers['my-curator'];
    step('Apply writes the my-curator entry into the fake Claude Desktop config', !!ours && typeof ours.command === 'string', JSON.stringify(ours));
    step('…keeping the other server and the preference', !!doc.mcpServers['other-server'] && doc.preferences && doc.preferences.menuBarEnabled === true);
    const backups = readdirSync(path.dirname(CLAUDE)).filter((f) => f.startsWith('claude_desktop_config.json.curator-backup-'));
    step('…with a backup of the original beside it', backups.length === 1 && readFileSync(path.join(path.dirname(CLAUDE), backups[0]), 'utf8') === ORIGINAL, backups.join(', '));
    const line = await text('[data-mcpi-results] [data-mcpi-result]');
    step('a per-file result line with restart guidance', /Claude Desktop — added/.test(line || '') && /quit/i.test(line || ''), line);
    step('the other apps were not written', !existsSync(CURSOR) && !/my-curator/.test(readFileSync(AG, 'utf8')));
  }
  await click('[data-mcpi-act="check-again"]');
  await until('Claude Desktop connected', () => {
    const el = document.querySelector('#mcpi-rows [data-mcpi-tool="claude-desktop"]');
    return el && el.dataset.mcpiStatus === 'connected';
  });
  step('Check again shows Claude Desktop connected', (await rowStatus('claude-desktop')) === 'connected');
  {
    await openRow('claude-desktop');
    const health = await text('#mcpi-rows [data-mcpi-tool="claude-desktop"] [data-mcpi-health]');
    step('its health line says Claude Desktop has not started it since the entry was written', /hasn’t started My Curator since the entry was written/.test(health || ''), health);
  }

  // ── 2. Check entry ─────────────────────────────────────────────────────
  await click('#mcpi-rows [data-mcpi-tool="claude-desktop"] [data-mcpi-act="check-entry"]');
  await until('the check outcome', () => !!document.querySelector('[data-mcpi-check="starts"], [data-mcpi-check="fails"], [data-mcpi-check="refused"], [data-mcpi-check="error"]'), null, 20000);
  {
    const t = await text('[data-mcpi-check]');
    step('Check entry on Claude Desktop reports that it starts, with its tools', /entry starts · \d+ tools/.test(t || ''), t);
  }

  // ── 3. Remove ─────────────────────────────────────────────────────────
  await openRow('claude-desktop');
  await click('#mcpi-rows [data-mcpi-tool="claude-desktop"] [data-mcpi-act="remove"]');
  await until('the remove preview', () => !!document.querySelector('[data-mcpi-plan]'));
  await click('[data-mcpi-act="apply"]');
  await until('the remove results', () => !!document.querySelector('[data-mcpi-results]'));
  {
    const now = readFileSync(CLAUDE, 'utf8');
    const doc = JSON.parse(now);
    step('Remove takes the entry out of the fake config', !(doc.mcpServers && doc.mcpServers['my-curator']), Object.keys(doc.mcpServers || {}).join(','));
    step('…leaving it byte-identical to the original', now === ORIGINAL, sha(now).slice(0, 12) + ' vs ' + sha(ORIGINAL).slice(0, 12));
  }

  // ── 4. Install again → Restore original ─────────────────────────────────
  await click('[data-mcpi-act="check-again"]');
  await until('can be added again', () => {
    const el = document.querySelector('#mcpi-rows [data-mcpi-tool="claude-desktop"]');
    return el && el.dataset.mcpiStatus === 'not-installed' && document.getElementById('mcpi-install-btn');
  });
  await page.evaluate(() => {
    for (const cb of document.querySelectorAll('[data-mcpi-tick]')) {
      const want = cb.dataset.mcpiTick === 'claude-desktop';
      if (cb.checked !== want) { cb.checked = want; cb.dispatchEvent(new Event('change')); }
    }
  });
  await click('#mcpi-install-btn');
  await until('the second preview', () => !!document.querySelector('[data-mcpi-plan]'));
  await click('[data-mcpi-act="apply"]');
  await until('the second results', () => !!document.querySelector('[data-mcpi-results]'));
  step('Install again writes the entry', /my-curator/.test(readFileSync(CLAUDE, 'utf8')));
  await click('[data-mcpi-act="check-again"]');
  await until('Restore offered', () => !!document.querySelector('#mcpi-rows [data-mcpi-tool="claude-desktop"] [data-mcpi-act="restore"]'));
  await openRow('claude-desktop');
  await click('#mcpi-rows [data-mcpi-tool="claude-desktop"] [data-mcpi-act="restore"]');
  await until('the restore preview', () => !!document.querySelector('[data-mcpi-plan]'));
  {
    const from = await text('[data-mcpi-plan] [data-mcpi-restore-from]');
    step('Restore original previews which copy goes back', /Puts back the copy kept on/.test(from || ''), from);
  }
  await click('[data-mcpi-act="apply"]');
  await until('the restore results', () => !!document.querySelector('[data-mcpi-results]'));
  {
    const now = readFileSync(CLAUDE, 'utf8');
    step('Restore original leaves the file byte-identical to the original', now === ORIGINAL, sha(now).slice(0, 12) + ' vs ' + sha(ORIGINAL).slice(0, 12));
  }
  // Restore is refused once the file has changed since our write: write the
  // entry, edit the file by hand, and ask for the plan.
  {
    await click('[data-mcpi-act="check-again"]');
    await until('can be added (3)', () => document.querySelector('#mcpi-rows [data-mcpi-tool="claude-desktop"]')?.dataset.mcpiStatus === 'not-installed' && document.getElementById('mcpi-install-btn'));
    await page.evaluate(() => { for (const cb of document.querySelectorAll('[data-mcpi-tick]')) { const w = cb.dataset.mcpiTick === 'claude-desktop'; if (cb.checked !== w) { cb.checked = w; cb.dispatchEvent(new Event('change')); } } });
    await click('#mcpi-install-btn');
    await until('preview (3)', () => !!document.querySelector('[data-mcpi-plan]'));
    await click('[data-mcpi-act="apply"]');
    await until('results (3)', () => !!document.querySelector('[data-mcpi-results]'));
    const edited = JSON.parse(readFileSync(CLAUDE, 'utf8'));
    edited.preferences.menuBarEnabled = false;
    writeFileSync(CLAUDE, JSON.stringify(edited, null, 2) + '\n');
    await click('[data-mcpi-act="check-again"]');
    await until('connected (3)', () => document.querySelector('#mcpi-rows [data-mcpi-tool="claude-desktop"]')?.dataset.mcpiStatus === 'connected');
    await delay(400);
    const offered = await page.evaluate(() => !!document.querySelector('#mcpi-rows [data-mcpi-tool="claude-desktop"] [data-mcpi-act="restore"]'));
    const r = await fetch(origin + '/api/mcp/install/plan', { method: 'POST', headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ action: 'restore', ids: ['claude-desktop'] }) }).then((x) => x.json());
    const refused = Array.isArray(r.items) && r.items.length && r.items.every((i) => i.refused);
    step('Restore original is refused once the file changed since our write', !offered && refused, JSON.stringify(r.items && r.items.map((i) => i.refused && i.refused.reason)));
  }

  // ── 5. Copy entry ───────────────────────────────────────────────────────
  {
    // Cursor has no entry: its row carries the copy line and Copy entry.
    await openRow('cursor');
    const line = await text('#mcpi-rows [data-mcpi-tool="cursor"] [data-mcpi-copyline]');
    await click('#mcpi-rows [data-mcpi-tool="cursor"] [data-mcpi-act="copy"]');
    await until('the copy status', () => !!document.querySelector('[data-mcpi-copied]'));
    const copied = await page.evaluate(() => window.__copied[window.__copied.length - 1] || '');
    const said = await text('[data-mcpi-copied]');
    let doc = null;
    try { doc = JSON.parse(copied); } catch { /* */ }
    step('Copy entry hands over a whole small file for an app with no file yet', !!doc && !!doc.mcpServers && !!doc.mcpServers['my-curator'], copied.slice(0, 120));
    step('…and says where it goes', /Save as ~\/\.cursor\/mcp\.json/.test(said || '') && /save the copied text as this new file/.test(line || ''), said + ' | ' + line);
    await openRow('antigravity');
    await click('#mcpi-rows [data-mcpi-tool="antigravity"] [data-mcpi-act="copy"]');
    await until('the second copy status', () => /inside "mcpServers"/.test(document.querySelector('[data-mcpi-copied]')?.textContent || ''));
    const c2 = await page.evaluate(() => window.__copied[window.__copied.length - 1] || '');
    step('for an existing file, only the entry, with "Paste into <file> inside "mcpServers""', /^"my-curator": \{/.test(c2) && /Paste into ~\/\.gemini\/config\/mcp_config\.json inside "mcpServers"/.test(await text('[data-mcpi-copied]') || ''), c2.slice(0, 80));
  }

  // ── 6. Run self-test, Test all N tools ─────────────────────────────────
  await click('#btn-mcp-self-test');
  await until('the self-test outcome', () => /The bridge answers · \d+ tools|Self-test failed/.test(document.getElementById('mcp-card-bridge')?.textContent || ''), null, 20000);
  {
    const t = await text('#mcp-card-bridge');
    step('Run self-test reports the bridge answers with its tools', /The bridge answers · 24 tools/.test(t || ''), (t || '').match(/The bridge answers[^.]*|Self-test failed[^.]*/)?.[0]);
    step('…and the overview\'s TOOLS ANSWER reads it', /TOOLS ANSWER\s*24/.test(await text('#settings-view-body > .cur-ov') || ''));
  }
  await click('#btn-mcp-exercise');
  await until('the full-test outcome', () => /Last full test[^:]*: \d+ of \d+ answered|Test all tools did not finish/.test(document.getElementById('mcp-card-bridge')?.textContent || ''), null, 90000);
  {
    const t = (await text('#mcp-card-bridge')) || '';
    const m = t.match(/Last full test[^:]*: (\d+) of (\d+) answered · (\d+) refused/);
    step('Test all 24 tools reports every tool answered', !!m && m[1] === m[2] && m[2] === '24', m ? m[0] : t.slice(0, 200));
  }
  {
    const v = checkPageContract(await liveHtml(), MCP_PAGE_CONTRACT);
    step('the page after every action still passes the page contract', v.length === 0, v.join(' | '));
  }
  if (SHOTS) await shots(page, 'mcp-after', [1280]);
  if (SHOTS) await compareShot(page);
} catch (err) {
  step('the run completed', false, err && err.stack);
  if (process.env.E2E_DEBUG) console.log(serverLog.slice(-4000));
} finally {
  try { if (conn) await conn.close(); } catch { /* */ }
  try { if (browser) await browser.close(); } catch { /* */ }
  child.kill('SIGTERM');
  await delay(400);
  if (!KEEP) rmSync(base, { recursive: true, force: true });
  else console.log('kept', base);
}

const after = fingerprint();
const moved = REAL_FILES.filter((f) => before[f] !== after[f]);
step('the REAL agent-app configs and .curator-config.json files are byte-identical before and after', moved.length === 0,
  REAL_FILES.map((f) => path.basename(path.dirname(f)) + '/' + path.basename(f) + ' ' + before[f]).join(' · '));

console.log('\n' + '─'.repeat(60));
console.log('Passed: ' + passed + '   Failed: ' + failed);
if (failed) { console.log('MCP bridge e2e FAILED'); process.exit(1); }
console.log('MCP bridge e2e passed');

// ── screenshots ────────────────────────────────────────────────────────────
async function fullHeight(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.main-inner');
    let p = el; while (p && !(p.scrollHeight > p.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(p).overflowY))) p = p.parentElement;
    return Math.max(document.documentElement.scrollHeight, p ? p.scrollHeight + 200 : 0);
  });
}
async function freeze(page) {
  await page.evaluate(() => { const s = document.createElement('style'); s.id = 'e2e-freeze';
    s.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}';
    if (!document.getElementById('e2e-freeze')) document.head.appendChild(s); });
}
async function shots(page, label, widths = [1280, 1100, 375]) {
  mkdirSync(SHOTS, { recursive: true });
  for (const w of widths) {
    await page.setViewport(w, 1000, 1);
    await delay(600);
    const h = await fullHeight(page);
    await page.setViewport(w, Math.min(h, 12000), 1);
    await freeze(page);
    await delay(700);
    const over = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    step(label + ' at ' + w + ' px has no horizontal overflow', !over);
    const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(SHOTS, label + '-' + w + '-dark.png'), Buffer.from(data, 'base64'));
  }
  await page.setViewport(1280, 1000, 1);
  await delay(400);
}
async function compareShot(page) {
  // The MCP page and the Domain page at the same 1280 px viewport and 1:1
  // scale, each grown to its whole column (the column scrolls inside .main).
  const grab = async (file) => {
    await page.setViewport(1280, 1000, 1);
    await delay(500);
    await page.setViewport(1280, Math.min(await fullHeight(page), 12000), 1);
    await freeze(page);
    await delay(800);
    const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(SHOTS, file), Buffer.from(data, 'base64'));
  };
  await grab('mcp-full-1280-dark.png');
  await page.evaluate(() => { const b = document.querySelector('#rail .rail-btn[data-view="domains"]'); b && b.click(); });
  for (let i = 0; i < 100 && !(await page.evaluate(() => /Wiki health/.test(document.querySelector('.main-inner')?.textContent || ''))); i++) await delay(150);
  await delay(1500);
  await grab('domain-1280-dark.png');
}
