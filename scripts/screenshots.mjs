#!/usr/bin/env node
/**
 * Regenerate the README's Chat screenshots from the SYNTHETIC demo domain.
 *
 *   node scripts/screenshots.mjs                 write docs/images/curator-chat{,-dark}.png
 *   node scripts/screenshots.mjs --out <dir>     write them somewhere else (to review first)
 *
 * WHAT IT DOES
 *   1. writes the demo domains (scripts/demo-domain.mjs) into a fresh temp dir;
 *   2. starts src/server.js ISOLATED on an ephemeral port — both test seams
 *      (CURATOR_TEST_USER_DATA_DIR + CURATOR_TEST_DOMAINS_DIR), every provider
 *      and GitHub credential stripped from the child's env, a FAKE Gemini key
 *      so the first-run panel stays closed. No call leaves this machine;
 *   3. drives the Chromium-family browser already installed (the same launcher
 *      and CDP client the visual harness uses — no dependency is added), opens
 *      the demo's newest conversation, and captures it in light and dark.
 *
 * NOT IN `npm test`: it needs a browser and takes ~15 s. With no browser it
 * prints why and exits 0, like the visual harness.
 *
 * NOTHING PERSONAL can reach the image: the wiki is synthetic, the user-data
 * dir is empty apart from the fake key, and before each capture the page's
 * visible text is checked for this machine's host name, user name and home
 * path — a hit ABORTS rather than writing the file.
 *
 * PROCESS SAFETY: only the exact child processes this script spawned are ever
 * signalled. No pkill, no port sweep.
 */

import { spawn } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { setTimeout as delay } from 'timers/promises';

import { writeDemoDomains, HERO_CONVERSATION_ID } from './demo-domain.mjs';
import { findBrowser, launchBrowser } from './visual/browser.js';
import { CdpConnection, CdpPage } from './visual/cdp.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const OUT_DIR = path.resolve(outIdx >= 0 ? argv[outIdx + 1] : path.join(REPO_ROOT, 'docs', 'images'));

// 1280 CSS px wide is the app's own reference width (the visual harness uses
// it); x1.25 gives a 1600 px image, crisp at the README's width="800".
const VIEWPORT = { width: 1280, height: 1000, scale: 1.25 };
const SHOTS = [
  { theme: 'light', file: 'curator-chat.png' },
  { theme: 'dark', file: 'curator-chat-dark.png' },
];

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function startServer(domainsDir, userDataDir) {
  const port = await freePort();
  if (port === 3333) throw new Error('refusing port 3333 (the live app)');
  writeFileSync(path.join(userDataDir, '.curator-config.json'), JSON.stringify({
    geminiApiKey: 'AIza' + '-SCREENSHOT-FAKE-KEY-not-a-credential', // assembled, as in scripts/visual/server.js
    activeProvider: 'gemini',
    domainsPath: domainsDir,
  }, null, 2), { mode: 0o600 });

  const env = { ...process.env };
  for (const k of ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY',
                   'GITHUB_TEST_REPO', 'GITHUB_TEST_PAT', 'DOMAINS_PATH', 'LLM_MODEL']) delete env[k];
  env.PORT = String(port);
  env.CURATOR_NO_OPEN = '1';
  env.CURATOR_TEST_USER_DATA_DIR = userDataDir;
  env.CURATOR_TEST_DOMAINS_DIR = domainsDir;

  const child = spawn(process.execPath, [path.join(REPO_ROOT, 'src', 'server.js')],
    { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  const close = async () => {
    if (child.exitCode === null && child.pid) {
      try { child.kill('SIGTERM'); } catch { /* gone */ }
      for (let i = 0; i < 30 && child.exitCode === null; i++) await delay(100);
      if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    }
  };
  const origin = `http://localhost:${port}`;
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}\n${log.slice(-1500)}`);
    try { if ((await fetch(`${origin}/api/version`)).ok) return { port, origin, close }; } catch { /* not yet */ }
    await delay(200);
  }
  await close();
  throw new Error(`server never answered on ${origin}\n${log.slice(-1500)}`);
}

/** Strings that must never appear on a published screenshot. */
function forbiddenStrings() {
  const out = new Set();
  const add = (s) => { if (s && String(s).length >= 3) out.add(String(s)); };
  add(os.hostname()); add(os.hostname().split('.')[0]);
  try { add(os.userInfo().username); } catch { /* no passwd entry */ }
  add(os.homedir());
  add(REPO_ROOT);
  return [...out];
}

async function waitFor(page, fn, arg, { tries = 80, ms = 100 } = {}) {
  for (let i = 0; i < tries; i++) {
    if (await page.evaluate(fn, arg)) return true;
    await delay(ms);
  }
  return false;
}

async function main() {
  if (!findBrowser()) {
    console.log('⊘ SKIPPED — no Chromium-family browser found (set CURATOR_VISUAL_BROWSER). Nothing was written.');
    return;
  }
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'curator-shots-'));
  const domainsDir = path.join(tmp, 'domains');
  const userDataDir = path.join(tmp, 'userdata');
  mkdirSync(userDataDir);
  writeDemoDomains(domainsDir);

  let server = null, browser = null, conn = null;
  try {
    server = await startServer(domainsDir, userDataDir);
    browser = await launchBrowser();
    conn = await CdpConnection.connect(browser.wsUrl);
    mkdirSync(OUT_DIR, { recursive: true });
    const forbidden = forbiddenStrings();

    for (const shot of SHOTS) {
      const page = await CdpPage.create(conn);
      await page.setViewport(VIEWPORT.width, VIEWPORT.height, VIEWPORT.scale);
      await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: shot.theme }] });
      // Seed the per-browser choices BEFORE boot: the theme, the Chat view,
      // and the demo domain as the chat default.
      await page.navigate(`${server.origin}/api/version`);
      await page.evaluate((t) => {
        localStorage.setItem('curator-next-theme', t);
        localStorage.setItem('curator-next-view', 'chat');
        localStorage.setItem('curator-next-chat-domain', 'early-computing');
      }, shot.theme);
      await page.navigate(server.origin);
      if (!await waitFor(page, () => !!window.__curatorBooted)) throw new Error('the app did not boot');
      await page.evaluate((t) => { document.documentElement.setAttribute('data-theme', t); }, shot.theme);

      // Open the hero conversation with a REAL click on its list row.
      const title = 'What linked the Analytical Engine';
      if (!await waitFor(page, (t) => [...document.querySelectorAll('button, [role="button"], a, li, div')]
        .some(el => el.children.length < 6 && el.textContent.includes(t)), title)) {
        throw new Error('the demo conversation never appeared in the Chat list');
      }
      const pt = await page.evaluate((t) => {
        const cands = [...document.querySelectorAll('*')].filter(el => el.textContent.trim().startsWith(t) && el.children.length === 0);
        const el = cands[0];
        if (!el) return null;
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return { x: r.left + Math.min(20, r.width / 2), y: r.top + r.height / 2 };
      }, title);
      if (!pt) throw new Error('could not locate the conversation row');
      await page.click(pt.x, pt.y, { settleMs: 400 });
      if (!await waitFor(page, () => /Sources/i.test(document.body.innerText) && /Babbage's half/.test(document.body.innerText))) {
        throw new Error('the answer with its Sources list never rendered');
      }
      // The thread opens scrolled to its end; show it from the question down.
      await page.evaluate(() => {
        for (const el of document.querySelectorAll('*')) {
          const cs = getComputedStyle(el);
          if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 4 &&
              el.innerText.includes("Babbage's half")) el.scrollTop = 0;
        }
      });
      // Let fonts, the model catalogue and the age ticker settle, then park
      // the pointer off-canvas so no hover state is captured.
      await page.evaluate(() => document.fonts && document.fonts.ready.then(() => true));
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: VIEWPORT.height - 1 });
      await page.evaluate(() => { document.activeElement && document.activeElement.blur && document.activeElement.blur(); });
      await delay(900);

      const text = await page.evaluate(() => document.body.innerText);
      const leak = forbidden.find(s => text.includes(s));
      if (leak) throw new Error(`refusing to capture: the page shows a machine-specific string (${leak.length} chars)`);

      const { data } = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const file = path.join(OUT_DIR, shot.file);
      writeFileSync(file, Buffer.from(data, 'base64'));
      console.log(`  ✓ ${shot.theme.padEnd(5)} → ${path.relative(REPO_ROOT, file) || file}`);
      await page.close();
    }
  } finally {
    try { conn && conn.close && conn.close(); } catch { /* gone */ }
    if (browser) await browser.close();
    if (server) await server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => { console.error(`✗ ${err.message}`); process.exit(1); });
