#!/usr/bin/env node
/**
 * e2e-projects.mjs — the Projects page (phase 2), DRIVEN IN A REAL BROWSER
 * (LIVE_LOCAL; replaces e2e-context-pro.mjs, whose five-step page is gone).
 *
 * Starts the app on a free port against an ISOLATED world (scripts/demo-domain.mjs
 * --workspace, its own user-data and domains dirs, a FAKE HOME, CURATOR_NO_OPEN)
 * and drives the page the way a person does:
 *
 *   · Simple: three tabs and the one quiet line; the note on the Now tab;
 *     the tab strip by keyboard (←/→ move AND select, focus stays on a tab);
 *     a harness row opens its steps in the reader and closing the reader puts
 *     focus back on the row (never body); Connect an agent opens ONE flow.
 *   · Pro: six tabs, the tile strip, the per-computer table; no "PRO" label
 *     on the page; turning Pro off from a Pro-only tab falls back to Now.
 *   · 375 px: no sideways scroll in either mode; the tables stack.
 *   · both themes.
 *
 *   node scripts/e2e-projects.mjs [--shots <dir>] [--keep]
 *
 * With --shots, saves the acceptance screenshots (Simple Now / Agents /
 * Starting kit, Pro Agents / History / Budget / Computers, dark and light, and
 * 375 px). The demo workspace is synthetic; nothing personal is on screen
 * except what the connect flow's MCP entry would show — that step is never
 * photographed.
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { launchBrowser, findBrowser } from './visual/browser.js';
import { CdpConnection, CdpPage } from './visual/cdp.js';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const SHOTS = args.includes('--shots') ? path.resolve(args[args.indexOf('--shots') + 1]) : null;
const KEEP = args.includes('--keep');
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

let passed = 0;
let failed = 0;
function step(name, ok, detail) {
  if (ok) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + name + (detail ? ' — ' + String(detail).slice(0, 220) : '')); }
  else { failed++; console.log('  \x1b[31m✗\x1b[0m ' + name + (detail ? ' — ' + String(detail).slice(0, 700) : '')); }
  return !!ok;
}
if (!findBrowser()) {
  console.log('⊘ e2e-projects: no Chrome / Chromium / Edge found — skipped (it needs a real browser).');
  process.exit(0);
}

// ── the isolated world ─────────────────────────────────────────────────────
const base = mkdtempSync(path.join(os.tmpdir(), 'curator-e2e-projects-'));
const ws = { domains: path.join(base, 'domains'), userData: path.join(base, 'userdata'), home: path.join(base, 'home') };
mkdirSync(ws.home, { recursive: true });
const NOW = new Date().toISOString();
execFileSync(process.execPath, [path.join(REPO, 'scripts', 'demo-domain.mjs'), ws.domains, '--now', NOW, '--workspace', ws.userData], {
  cwd: REPO, stdio: ['ignore', 'ignore', 'inherit'],
  env: { ...process.env, HOME: ws.home, CURATOR_TEST_DOMAINS_DIR: ws.domains, CURATOR_TEST_USER_DATA_DIR: ws.userData },
});
writeFileSync(path.join(ws.userData, '.curator-config.json'), JSON.stringify({ activeProvider: 'gemini', domainsPath: ws.domains,
  geminiApiKey: 'AIza-E2E-FAKE-KEY-not-a-credential' }, null, 2), { mode: 0o600 });
// An Antigravity config with our entry, so the list has a second harness.
mkdirSync(path.join(ws.home, '.gemini/config'), { recursive: true });
writeFileSync(path.join(ws.home, '.gemini/config/mcp_config.json'), JSON.stringify({ mcpServers: { 'my-curator': { command: '/usr/bin/true' } } }, null, 2) + '\n');

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
  const setTheme = async (theme) => {
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
    await page.evaluate((t) => { localStorage.setItem('curator-next-theme', t); document.documentElement.setAttribute('data-theme', t); }, theme);
  };
  await page.setViewport(1360, 1000, 1);
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await page.navigate(origin + '/api/version');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('curator-next-theme', 'dark');
    localStorage.setItem('curator-next-view', 'memory'); localStorage.setItem('curator-next-onboarding-dismissed-v1', '1');
    localStorage.setItem('curator-memory-last-project-v1', JSON.stringify({ 'early-computing': 'exhibit-site' }));
    sessionStorage.setItem('curator-next-instance-banner-dismissed-v1', '1'); });
  await page.navigate(origin);
  for (let i = 0; i < 100 && !(await page.evaluate(() => !!window.__curatorBooted)); i++) await delay(100);

  const until = async (label, fn, arg, ms = 20000) => {
    const t0 = Date.now();
    for (;;) {
      let v = null;
      try { v = await page.evaluate(fn, arg); } catch { v = null; }
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + label);
      await delay(120);
    }
  };
  const shot = async (name) => {
    if (!SHOTS) return;
    // Toasts are transient and can carry provider news; they are not the page.
    await page.evaluate(() => document.querySelectorAll('.cur-toast, [data-toast]').forEach((t) => { t.style.display = 'none'; }));
    await delay(150);
    const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(data, 'base64'));
  };
  const key = async (k, code, keyCode) => {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: keyCode });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: keyCode });
  };
  const click = (sel) => page.evaluate((s) => { const el = document.querySelector(s); if (!el) return false; el.click(); return true; }, sel);
  const active = () => page.evaluate(() => { const a = document.activeElement; return a ? { id: a.id || '', body: a === document.body, tab: a.getAttribute && a.getAttribute('data-kit-tab') } : null; });
  const setPro = async (on) => {
    await page.evaluate(async (v) => { await fetch('/api/config/ui-detail', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uiDetail: v ? 'pro' : 'simple' }) }); }, on);
    await page.evaluate(() => location.reload());
    await until('the page after a mode change', (want) => document.documentElement.getAttribute('data-pro') === want && !!document.querySelector('.prj-page [role="tablist"]'), on ? 'on' : 'off', 30000);
    await delay(500);
  };
  const tab = async (id) => {
    await click('#prj-tab-' + id);
    await until('tab ' + id, (t) => !!document.querySelector('[data-prj-panel="' + t + '"]'), id);
    await delay(400);
  };
  const noSideways = () => page.evaluate(() => {
    const m = document.querySelector('main.main') || document.scrollingElement;
    return m.scrollWidth <= m.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1;
  });

  await until('Projects › exhibit-site', () => !!document.querySelector('.prj-page [role="tablist"]') && !!document.querySelector('.kit-op-status'), null, 40000);
  await until('the setup check', () => /Agents/.test(document.querySelector('#prj-tab-agents') ? document.querySelector('#prj-tab-agents').textContent : '')
    && !!document.querySelector('#prj-tab-agents .kit-tab-count'), null, 30000);
  await delay(600);

  // ── 1. Simple ─────────────────────────────────────────────────────────────
  step('opens in Simple (Pro off) with the rail word "Projects"', await page.evaluate(() => document.documentElement.getAttribute('data-pro') === 'off'
    && /Projects/.test(document.querySelector('[data-view="memory"], .rail [aria-current="page"]') ? document.querySelector('[data-view="memory"], .rail [aria-current="page"]').textContent : document.body.textContent)));
  const simpleTabs = await page.evaluate(() => [...document.querySelectorAll('[data-kit-tab]')].map((b) => b.getAttribute('data-kit-tab')));
  step('Simple draws three tabs: Now · Agents · Starting kit', JSON.stringify(simpleTabs) === '["now","agents","kit"]', simpleTabs);
  step('the title is the project\'s name, the status sentence real', await page.evaluate(() => document.querySelector('.kit-op-title').textContent === 'exhibit-site'
    && /saved a note/.test(document.querySelector('.kit-op-status').textContent)), await page.evaluate(() => document.querySelector('.kit-op-status').textContent));
  await tab('now');
  step('Now shows the latest note as text on the page', await page.evaluate(() => (document.querySelector('.prj-handoff-body') || {}).textContent.length > 80));
  step('one quiet "More in Pro" line, and no PRO label anywhere', await page.evaluate(() => document.querySelectorAll('.prj-quiet').length === 1
    && !document.querySelector('.prj-page [data-pro-mark], .prj-page [data-pro-drawn], .prj-page [data-detail="pro"]')));
  await shot('simple-now-dark');

  // Tabs by keyboard: focus the selected tab, → moves AND selects.
  await page.evaluate(() => document.getElementById('prj-tab-now').focus());
  await key('ArrowRight', 'ArrowRight', 39);
  await until('Agents by keyboard', () => !!document.querySelector('[data-prj-panel="agents"]'));
  await delay(300);
  const a1 = await active();
  step('→ on the tab strip selects Agents and keeps focus on its tab (never body)', a1 && a1.tab === 'agents' && !a1.body, JSON.stringify(a1));
  step('Agents: one row per harness, each with one closed-vocabulary chip', await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-prj-panel="agents"] .kit-row')];
    return rows.length >= 2 && rows.every((r) => r.querySelectorAll('.kit-chip').length === 1);
  }));
  await shot('simple-agents-dark');

  // A row opens its steps in the reader; closing returns focus to the row.
  const opened = await click('[data-prj-panel="agents"] .kit-row-open');
  await until('the harness reader', () => !!document.querySelector('#reader-root .mem-setup-guide'));
  await delay(300);
  step('a harness row opens its setup steps in the reader', opened);
  await key('Escape', 'Escape', 27);
  await delay(500);
  const a2 = await active();
  step('closing the reader puts focus back on the row (never body)', a2 && /^mem-setup-tool-/.test(a2.id) && !a2.body, JSON.stringify(a2));

  // The one connect flow.
  await click('#prj-connect');
  await until('the connect flow', () => !!document.querySelector('#reader-root .prj-connect'));
  await delay(300);
  step('Connect an agent opens ONE flow in the reader: pick → this computer → this project', await page.evaluate(() =>
    document.querySelectorAll('#reader-root .prj-connect .prj-step').length === 3 && document.querySelectorAll('#reader-root .prj-connect .kit-row').length >= 2));
  step('the flow\'s heading has focus', (await active()).id === 'prj-connect-h', JSON.stringify(await active()));
  await shot('simple-connect-pick-dark');
  await key('Escape', 'Escape', 27);
  await delay(400);
  step('closing the flow returns focus to Connect an agent', (await active()).id === 'prj-connect', JSON.stringify(await active()));

  await tab('kit');
  step('Starting kit: Brief · Documents · Knowledge rows and the one bar', await page.evaluate(() =>
    document.querySelectorAll('[data-prj-panel="kit"] .kit-row').length === 3 && !!document.querySelector('[data-prj-panel="kit"] .prj-meter')));
  await shot('simple-kit-dark');
  await click('[data-prj-act="brief-edit"]');
  await until('the brief editor', () => !!document.getElementById('mem-brief-text'));
  step('Edit on the Brief row opens today\'s editor, focus in the text', (await active()).id === 'mem-brief-text', JSON.stringify(await active()));
  await click('#mem-brief-cancel');
  await delay(300);

  // ── 2. Pro ────────────────────────────────────────────────────────────────
  await setPro(true);
  const proTabs = await page.evaluate(() => [...document.querySelectorAll('[data-kit-tab]')].map((b) => b.getAttribute('data-kit-tab')));
  step('Pro draws six tabs', JSON.stringify(proTabs) === '["now","agents","kit","history","budget","computers"]', proTabs);
  step('Pro: the tile strip, and still no PRO label on the page', await page.evaluate(() => !!document.querySelector('.prj-page .cur-ov')
    && !document.querySelector('.prj-page [data-pro-mark], .prj-page [data-pro-drawn]')));
  for (const id of ['agents', 'history', 'budget', 'computers']) {
    await tab(id);
    step('Pro › ' + id + ': data is open — a table, no fold', await page.evaluate((t) => !!document.querySelector('[data-prj-panel="' + t + '"] .kit-table')
      && !document.querySelector('[data-prj-panel="' + t + '"] > .prj-stack > details'), id));
    await shot('pro-' + id + '-dark');
  }
  // Pro off while on a Pro-only tab → Now.
  await setPro(false);
  step('turning Pro off on a Pro-only tab falls back to Now', await page.evaluate(() => !!document.querySelector('[data-prj-panel="now"]')));

  // ── 3. light theme ──────────────────────────────────────────────────────
  await setTheme('light');
  await delay(300);
  await tab('now'); await shot('simple-now-light');
  await tab('agents'); await shot('simple-agents-light');
  await tab('kit'); await shot('simple-kit-light');
  await setPro(true);
  await setTheme('light');
  for (const id of ['agents', 'history', 'budget', 'computers']) { await tab(id); await shot('pro-' + id + '-light'); }

  // ── 4. 375 px ─────────────────────────────────────────────────────────────
  await setTheme('dark');
  await page.setViewport(375, 812, 1);
  await delay(500);
  for (const id of ['agents', 'history', 'computers']) {
    await tab(id);
    step('375 px, Pro › ' + id + ': no sideways scroll (tables stack)', await noSideways());
    await shot('pro-' + id + '-375');
  }
  await setPro(false);
  for (const id of ['now', 'agents', 'kit']) {
    await tab(id);
    step('375 px, Simple › ' + id + ': no sideways scroll', await noSideways());
    await shot('simple-' + id + '-375');
  }
} catch (err) {
  step('the run finished', false, err && err.stack ? err.stack : String(err));
  console.log(serverLog.slice(-2000));
} finally {
  try { if (conn) conn.close(); } catch { /* */ }
  try { if (browser) await browser.close(); } catch { /* */ }
  child.kill();
  if (!KEEP) rmSync(base, { recursive: true, force: true });
  else console.log('kept: ' + base);
}
console.log('\n' + (failed ? '✗' : '✓') + ' e2e-projects: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
