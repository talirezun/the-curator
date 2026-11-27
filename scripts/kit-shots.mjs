#!/usr/bin/env node
/**
 * scripts/kit-shots.mjs — render the DEV-ONLY kit page (kit v1) to PNGs and
 * check its parts in a real browser.
 *
 *   node scripts/kit-shots.mjs --out <dir>
 *
 * Starts this checkout's server on a free port with an ISOLATED, empty user
 * data and domains folder (CURATOR_TEST_USER_DATA_DIR / _DOMAINS_DIR,
 * CURATOR_NO_OPEN, a throwaway HOME, no provider keys), opens /next/kit.html
 * in headless Chromium (scripts/visual's launcher and CDP client — no
 * dependency), and writes:
 *
 *   kit-both.png     the whole page, the dark and light columns side by side
 *   kit-dark.png     the dark column alone
 *   kit-light.png    the light column alone
 *   kit-narrow.png   the page at 820 px (one column; tables stacked)
 *
 * Then drives the parts with real input and prints a ✓/✗ line per check:
 * the tabs' arrow keys, a row press, a sort press, the notice's "Why?", a
 * table row press, and no console error. Exit 1 on any ✗.
 *
 * Not in `npm test` (it needs a browser); SKIPS with exit 0 when none exists.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { findBrowser, launchBrowser } from './visual/browser.js';
import { CdpConnection, CdpPage } from './visual/cdp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const outAt = argv.indexOf('--out');
const OUT = outAt >= 0 && argv[outAt + 1] ? path.resolve(argv[outAt + 1]) : path.join(os.tmpdir(), 'curator-kit-shots');

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('  ✓ ' + m); } else { failed++; console.log('  ✗ ' + m); } };

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function startServer() {
  const base = mkdtempSync(path.join(os.tmpdir(), 'curator-kit-'));
  const ws = { base, userData: path.join(base, 'userdata'), domains: path.join(base, 'domains'), home: path.join(base, 'home') };
  for (const d of [ws.userData, ws.domains, ws.home]) mkdirSync(d, { recursive: true });
  const port = await freePort();
  if (port === 3333) throw new Error('refusing port 3333 (the live app)');
  const env = { ...process.env };
  for (const k of ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'DOMAINS_PATH', 'LLM_MODEL']) delete env[k];
  Object.assign(env, {
    PORT: String(port), CURATOR_NO_OPEN: '1', HOME: ws.home,
    CURATOR_TEST_USER_DATA_DIR: ws.userData, CURATOR_TEST_DOMAINS_DIR: ws.domains,
    CURATOR_TEST_INSTALL_HOME: ws.home, CURATOR_KIT_PAGE: '1',
  });
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const close = async () => {
    if (child.exitCode === null && child.pid) {
      try { child.kill('SIGTERM'); } catch { /* gone */ }
      for (let i = 0; i < 30 && child.exitCode === null; i++) await delay(100);
      if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    }
    rmSync(ws.base, { recursive: true, force: true });
  };
  const origin = 'http://localhost:' + port;
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error('server exited ' + child.exitCode + '\n' + log.slice(-1500));
    try { if ((await fetch(origin + '/api/version')).ok) return { origin, close }; } catch { /* not yet */ }
    await delay(200);
  }
  await close();
  throw new Error('server never answered\n' + log.slice(-1500));
}

async function shoot(page, file, clip) {
  if (!clip) {
    const d = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
    clip = { x: 0, y: 0, width: d.width, height: d.height };
  }
  const { data } = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
  writeFileSync(path.join(OUT, file), Buffer.from(data, 'base64'));
  console.log('  → ' + path.join(OUT, file));
}

async function open(page, origin, width) {
  await page.setViewport(width, 900, 1);
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
  await page.navigate(origin + '/next/kit.html');
  for (let i = 0; i < 80 && !(await page.evaluate(() => document.documentElement.getAttribute('data-kit-ready') === '1')); i++) await delay(100);
  await page.evaluate(() => document.fonts && document.fonts.ready.then(() => true));
  const h = await page.evaluate(() => Math.ceil(document.documentElement.scrollHeight));
  await page.setViewport(width, h, 1);
  await page.send('Browser.setWindowBounds', { windowId: (await page.conn.send('Browser.getWindowForTarget', {}, page.sessionId)).windowId, bounds: { width, height: h } }).catch(() => {});
  await delay(300);
  if (process.env.KIT_DEBUG) console.log('    viewport', await page.evaluate(() => innerWidth + 'x' + innerHeight), 'page', h);
  return h;
}

async function main() {
  if (!findBrowser()) { console.log('⊘ SKIPPED — no Chromium-family browser found (set CURATOR_VISUAL_BROWSER).'); return; }
  mkdirSync(OUT, { recursive: true });
  const server = await startServer();
  let browser = null, conn = null;
  try {
    browser = await launchBrowser();
    conn = await CdpConnection.connect(browser.wsUrl);
    const page = await CdpPage.create(conn);
    const errors = [];
    conn.on('*', 'Runtime.exceptionThrown', (p) => errors.push(String(p && p.exceptionDetails && (p.exceptionDetails.exception && p.exceptionDetails.exception.description || p.exceptionDetails.text))));
    conn.on('*', 'Runtime.consoleAPICalled', (p) => { if (p && p.type === 'error') errors.push('console.error: ' + JSON.stringify((p.args || []).map((a) => a.value || a.description))); });

    console.log('\nShots');
    await open(page, server.origin, 1680);
    await shoot(page, 'kit-both.png');
    const cols = await page.evaluate(() => [...document.querySelectorAll('.kit-demo-col')].map((c) => { const r = c.getBoundingClientRect(); return { x: r.left, y: r.top + scrollY, width: r.width, height: r.height }; }));
    ok(cols.length === 2, 'two theme columns');
    if (cols[0]) await shoot(page, 'kit-dark.png', cols[0]);
    if (cols[1]) await shoot(page, 'kit-light.png', cols[1]);

    console.log('\nBehaviour, in the browser');
    ok(errors.length === 0, 'no error was thrown while the page rendered' + (errors.length ? ': ' + errors.join(' | ') : ''));
    // Tabs: focus the active Simple tab, ArrowRight → next tab selected and focused.
    const tabRes = await page.evaluate(async () => {
      const list = document.querySelector('[data-kit-tabs="kit-t-s-dark"]');
      const tabsEl = [...list.querySelectorAll('[role="tab"]')];
      tabsEl[0].focus();
      tabsEl[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      const a = document.activeElement === tabsEl[1] && tabsEl[1].getAttribute('aria-selected') === 'true' && tabsEl[0].getAttribute('tabindex') === '-1';
      tabsEl[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
      const b = document.activeElement === tabsEl[tabsEl.length - 1];
      return { a, b, n: tabsEl.length, pro: document.querySelectorAll('[data-kit-tabs="kit-t-p-dark"] [role="tab"]').length };
    });
    ok(tabRes.a, 'tabs: ArrowRight selects and focuses the next tab (roving tabindex)');
    ok(tabRes.b, 'tabs: End moves to the last tab');
    ok(tabRes.n === 3 && tabRes.pro === 6, 'tabs: Simple draws 3 tabs, Pro 6');
    // Row: a press in the row's empty middle opens it (the stretched target).
    // A normal-height viewport for the real input (the shots used the full
    // page height), with the row scrolled into view.
    await page.setViewport(1680, 900, 1);
    const center = (sel) => page.evaluate((q) => {
      const el = document.querySelector(q);
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width * 0.55, y: r.top + r.height / 2, cx: r.left + r.width / 2 };
    }, sel);
    const rowBox = await center('[data-kit-row="claude-dark"]');
    const hit = await page.evaluate((x, y) => { const e = document.elementFromPoint(x, y); return e ? e.tagName.toLowerCase() + '.' + e.className : 'none'; }, rowBox.x, rowBox.y);
    await page.click(rowBox.x, rowBox.y);
    const out = await page.evaluate(() => document.querySelector('[data-kit-demo-out]').textContent);
    ok(out === 'Opened claude-dark.', 'row: a press in the middle of the row (on ' + hit + ') opens it (' + out + ')');
    const cursor = await page.evaluate(() => getComputedStyle(document.querySelector('[data-kit-row="claude-dark"] .kit-row-open')).cursor);
    ok(cursor === 'pointer', 'row: the open target shows the pointer');
    // The action does not open the row.
    await page.evaluate(() => { document.querySelector('[data-kit-demo-out]').textContent = '-'; });
    const actBox = await center('[data-kit-row="anti-dark"] .kit-row-act');
    await page.click(actBox.cx, actBox.y);
    ok(await page.evaluate(() => document.querySelector('[data-kit-demo-out]').textContent) === '-', 'row: pressing its one action does not open the row');
    // Sort: press the Saved head → aria-sort flips to ascending.
    const sortRes = await page.evaluate(() => {
      const before = document.querySelector('[data-kit-table="kit-tb-p-dark"] [data-kit-sort="when"]').closest('th').getAttribute('aria-sort');
      document.querySelector('[data-kit-table="kit-tb-p-dark"] [data-kit-sort="when"]').click();
      const after = document.querySelector('[data-kit-table="kit-tb-p-dark"] [data-kit-sort="when"]').closest('th').getAttribute('aria-sort');
      const first = document.querySelector('[data-kit-table="kit-tb-p-dark"] tbody tr').getAttribute('data-kit-row');
      return { before, after, first };
    });
    ok(sortRes.before === 'descending' && sortRes.after === 'ascending' && sortRes.first === 's4', 'table: a head press re-sorts and flips aria-sort (' + JSON.stringify(sortRes) + ')');
    const align = await page.evaluate(() => { const td = document.querySelector('[data-kit-table="kit-tb-p-dark"] td.kit-num'); const s = getComputedStyle(td); return s.textAlign + ' ' + s.fontVariantNumeric; });
    ok(/right/.test(align) && /tabular-nums/.test(align), 'table: number cells are right-aligned in tabular figures (' + align + ')');
    // Why?: opens the explainer panel in place.
    const why = await page.evaluate(() => {
      const b = document.querySelector('#kit-why-setup-dark-btn');
      if (!b) return 'no button';
      b.click();
      const p = document.getElementById('kit-why-setup-dark');
      return b.textContent + '|' + b.getAttribute('aria-expanded') + '|' + (p && !p.hidden);
    });
    ok(why === 'Why?|true|true', 'notice: "Why?" opens its explainer (' + why + ')');
    await page.evaluate(() => document.querySelector('#kit-why-setup-dark-btn').click());

    console.log('\nNarrow');
    await page.evaluate(() => window.scrollTo(0, 0));
    await open(page, server.origin, 820);
    const stacked = await page.evaluate(() => getComputedStyle(document.querySelector('.kit-table tbody tr')).display);
    ok(stacked === 'block', 'table: below 900 px a row is a stacked card (display ' + stacked + ')');
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    ok(sideways, 'nothing scrolls sideways at 820 px');
    await shoot(page, 'kit-narrow.png');
    ok(errors.length === 0, 'no uncaught exception in the page' + (errors.length ? ': ' + errors.join(' | ') : ''));
    await page.close();
  } finally {
    try { conn && conn.close && await conn.close(); } catch { /* gone */ }
    if (browser) await browser.close();
    await server.close();
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
}

main().catch((err) => { console.error('✗ ' + (err && err.stack || err)); process.exit(1); });
